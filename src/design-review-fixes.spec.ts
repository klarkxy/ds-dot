/**
 * Regression suite covering all 8 design-review fixes:
 * 1. Async non-blocking snapshot capture, manifest-only verification, single-entry reads,
 *    oversized file guard, extended cache-dir exclusions, and snapshot GC.
 * 2. Unknown-creation & dead-relay recovery on absent/stopped sessions + human forceReleaseChange.
 * 3. Hardened approval-risk gate (reordered rm flags, git -C push, credentials, read-only tool writes).
 * 4. Runtime tools/pre-execute WriteScope enforcement on sealed child sessions.
 * 5. Synthesis of legacy acceptance/deliverable/priority parameters in dot_task.
 * 6. Bounded state.cards cap, durable task-table deletion on prune, and WorkBook history pruning.
 * 7. CJK-aware queryTerms segmentation & concurrent multi-session searchHistory.
 * 8. Locale-aware cardAnswerText, boardRev watermark on ChatFeed, and forceReleasePayload on WorkBoard.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assessApprovalRisk } from './approval-risk.ts'
import {
  captureScope, captureScopeAsync, ignoredDirName, pruneSnapshots,
  readManifest, readSnapshotEntry, saveSnapshot, scanScope, scanScopeAsync,
} from './artifacts.ts'
import { DotCards, cardAnswerText } from './card-state.ts'
import { DEFAULT_SETTINGS, TOOL } from './contracts.ts'
import { cancelWork, launchReservedRun, reconcileReserved, reconcileRun, supplementRun, type RunSessionHost } from './execution.ts'
import { ChatFeed } from './feed.ts'
import { queryTerms, searchRows } from './history.ts'
import { SUPPORTED_LOCALES, localePack } from './i18n/index.ts'
import { guardRunWriteTool, sealChildSession } from './peer.ts'
import { DotService } from './service.ts'
import { DotStore, MAX_STORED_CARDS, MAX_TASKS, type DotDomainHandle } from './store.ts'
import { apply } from './tools.ts'
import { forceReleasePayload } from './work-board.ts'
import { WorkBook } from './work.ts'

function makeFakeDomain() {
  const tables: Record<string, Map<string, unknown>> = {
    state: new Map(), tasks: new Map(), tickets: new Map(), schedules: new Map(), proposals: new Map(),
    recipes: new Map(), changes: new Map(), inputs: new Map(), runs: new Map(), verifications: new Map(), peers: new Map(),
  }
  const deletes: string[] = []
  const domain: DotDomainHandle = {
    table: name => ({
      entries: () => tables[name]!.entries(),
      get: key => tables[name]!.get(key),
      put: async (key, value) => { tables[name]!.set(key, structuredClone(value)) },
      delete: async key => { deletes.push(`${name}:${key}`); return tables[name]!.delete(key) },
      update: async (key, recipe) => {
        const next = recipe(tables[name]!.get(key))
        tables[name]!.set(key, structuredClone(next))
        return next
      },
    }),
    close: async () => {},
  }
  return { domain, tables, deletes }
}

function makeServiceHarness() {
  const home = mkdtempSync(join(tmpdir(), 'dot-fixes-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-fixes-proj-'))
  writeFileSync(join(project, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(project, 'b.ts'), 'export const b = 2\n')
  const { domain, tables, deletes } = makeFakeDomain()
  const store = new DotStore(domain)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const sessions = new Map<string, { cwd?: string; preset?: string }>()
  const events = new Map<string, Array<{ type: string; seq?: number; time?: number; data?: unknown }>>()
  const host = {
    isRunning: () => false,
    listSessions: async () => [],
    titles: async () => new Map<string, string>(),
    latestReply: async () => 'done',
    readEvents: async (id: string) => events.get(id) ?? [],
    cancel: async () => {},
    archive: async () => {},
    modelKey: () => 'p/ok',
    syncModel: () => {},
    createWorkspace: async (path: string, title?: string) => ({ id: 'ws-1', title: title ?? 'proj', path, sessionCount: 0 }),
    listWorkspaces: () => [{ id: 'ws-1', title: 'proj', path: project, sessionCount: 0 }],
    cwdOf: async () => project,
    listModels: async () => ({ fallback: { provider: 'p', model: 'ok' }, models: [{ provider: 'p', model: 'ok', name: 'Ok' }] }),
    listPresets: async () => ({ fallback: 'standard', presets: [{ id: 'standard' }] }),
    selectModel: async () => {},
    setReadOnly: async () => true,
    setWritable: async () => true,
    verifyTaskPermission: async () => true,
    createDot: async () => 'dot-session',
    resumeDot: async () => true,
    releaseDot: async () => {},
    dotEvents: () => [],
    dotContext: async () => ({ live: true, compactions: 0 }),
    summarize: async () => '',
    findSession: async (id: string) => sessions.get(id),
    createSession: async (input: { sessionId?: string; cwd?: string; preset?: string }) => {
      const id = input.sessionId ?? `session-${sessions.size}`
      sessions.set(id, { cwd: input.cwd, ...(input.preset ? { preset: input.preset } : {}) })
      return id
    },
    prompt: async () => {},
    relay: async () => {},
    stopActivity: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }),
  }
  const service = new DotService({
    host: host as never,
    store,
    homeDir: home,
    notes: { path: join(home, 'memory.md'), read: async () => '', readCognition: async () => '' },
    approvalGraceMs: 0,
    timer: { set: () => 1, clear: () => {}, now: () => 1000 },
    now: () => 1000,
  })
  const registered: Array<Record<string, unknown>> = []
  apply({
    tools: { schemas: () => [], restrict: () => () => {}, register(def: Record<string, unknown>) { registered.push(def); return () => {} } },
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    dot: service,
    effect(fn: () => unknown) { fn() },
  } as never)
  const taskTool = registered.find(row => row.name === TOOL.task) as { execute(args: Record<string, unknown>): Promise<string> }
  return {
    home, project, store, service, host, events, tables, deletes, taskTool,
    cleanup: () => {
      rmSync(project, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

describe('1. Hardened approval-risk static gate', () => {
  it('catches reordered rm flags, git global flags before push, script deletes, credentials, and structured read-only writes', () => {
    expect(assessApprovalRisk({ toolName: 'bash', arguments: 'rm -f -r build' }).reasons).toContain('destroy')
    expect(assessApprovalRisk({ toolName: 'bash', arguments: 'rm build -rf' }).reasons).toContain('destroy')
    expect(assessApprovalRisk({ toolName: 'bash', arguments: 'git reset --hard HEAD~1' }).reasons).toContain('destroy')
    expect(assessApprovalRisk({ toolName: 'bash', arguments: 'python3 -c "import shutil; shutil.rmtree(\'out\')"' }).reasons).toContain('destroy')
    expect(assessApprovalRisk({ toolName: 'bash', arguments: 'rm temp.txt' }).reasons).not.toContain('destroy')

    expect(assessApprovalRisk({ toolName: 'bash', arguments: 'git -C /repo push origin main' }).reasons).toContain('publish')
    expect(assessApprovalRisk({ toolName: 'bash', arguments: 'git --no-pager push' }).reasons).toContain('publish')
    expect(assessApprovalRisk({ toolName: 'bash', arguments: 'pnpm --filter pkg publish' }).reasons).toContain('publish')
    expect(assessApprovalRisk({ toolName: 'bash', arguments: 'gh pr merge 42 --squash' }).reasons).toContain('publish')

    expect(assessApprovalRisk({ toolName: 'read_file', arguments: '{"path":"~/.ssh/id_ed25519"}' }).reasons).toContain('credential')
    expect(assessApprovalRisk({ toolName: 'bash', arguments: 'cat ~/.aws/credentials' }).reasons).toContain('credential')
    expect(assessApprovalRisk({ toolName: 'bash', arguments: 'export TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD' }).reasons).toContain('credential')

    expect(assessApprovalRisk({ toolName: 'write_file', arguments: '{"path":"a.ts","content":"x"}', readOnly: true }).reasons).toContain('read-only-write')
    expect(assessApprovalRisk({ toolName: 'apply_patch', arguments: '*** Update File: a.ts', readOnly: true }).reasons).toContain('read-only-write')
    expect(assessApprovalRisk({ toolName: 'bash', arguments: 'sed -i "s/a/b/" a.ts', readOnly: true }).reasons).toContain('read-only-write')
  })
})

describe('2. Runtime tools/pre-execute WriteScope enforcement on child sessions', () => {
  it('blocks file writes on read-only runs and out-of-scope paths while permitting declared paths', async () => {
    const baseRun = {
      id: 'run-1',
      cwd: '/repo',
      workspaceRoot: '/repo',
      writeScope: { kind: 'paths' as const, paths: [{ path: 'src/allowed.ts', type: 'file' as const }] },
      access: 'write' as const,
    }
    expect(guardRunWriteTool(baseRun, { name: 'write_file', input: { file_path: 'src/allowed.ts' } }, 'linux')).toEqual({ allow: true })
    expect(guardRunWriteTool(baseRun, { name: 'write_file', input: { file_path: 'src/other.ts' } }, 'linux')).toMatchObject({ allow: false })
    expect(guardRunWriteTool(baseRun, { name: 'apply_patch', arguments: '*** Begin Patch\n*** Update File: src/other.ts\n*** End Patch' }, 'linux')).toMatchObject({ allow: false })
    expect(guardRunWriteTool({ ...baseRun, access: 'read', writeScope: { kind: 'paths', paths: [] } }, { name: 'edit_file', input: { path: 'src/allowed.ts' } }, 'linux')).toMatchObject({ allow: false })

    // Verify integration through sealChildSession's single pre-execute hook
    const gates: Array<(exec: { name: string; input?: unknown }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string; reason?: string }>> = []
    const fakeAgent = {
      session: { id: 'session-a' },
      ctx: {
        tools: { schemas: () => [], restrict: () => () => {}, register: () => () => {} },
        systemPrompt: { section: () => () => {} },
        on: (_ev: string, fn: typeof gates[number]) => { gates.push(fn); return () => {} },
      },
    }
    sealChildSession(fakeAgent, async () => 'ok', new Set(), exec => guardRunWriteTool(baseRun, exec, 'linux'))
    expect(gates).toHaveLength(1)
    expect(await gates[0]!({ name: 'write_file', input: { path: 'src/allowed.ts' } }, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
    expect((await gates[0]!({ name: 'write_file', input: { path: 'src/forbidden.ts' } }, async () => ({ kind: 'allow' }))).kind).toBe('deny')
  })

  it('blocks write-shaped MCP tools on read-only runs while writer runs keep them', () => {
    const baseRun = {
      id: 'run-1',
      cwd: '/repo',
      workspaceRoot: '/repo',
      writeScope: { kind: 'paths' as const, paths: [{ path: 'src/allowed.ts', type: 'file' as const }] },
      access: 'write' as const,
    }
    const readRun = { ...baseRun, access: 'read' as const, writeScope: { kind: 'paths' as const, paths: [] } }
    // MCP servers run outside the sandbox: read-only refuses write-shaped names.
    const denied = guardRunWriteTool(readRun, { name: 'mcp__agent_bridge__dispatch_task', input: { task: 'x' } }, 'linux')
    expect(denied).toMatchObject({ allow: false })
    expect((denied as { reason?: string }).reason).toContain('may write outside the sandbox')
    expect(guardRunWriteTool(readRun, { name: 'mcp__fs__write_file', input: { path: 'a.txt' } }, 'linux')).toMatchObject({ allow: false })
    expect(guardRunWriteTool(readRun, { name: 'mcp__github__get_issue', input: {} }, 'linux')).toEqual({ allow: true })
    expect(guardRunWriteTool(readRun, { name: 'mcp__fs__listDirectory', input: {} }, 'linux')).toEqual({ allow: true })
    // Writer runs are unaffected either way.
    expect(guardRunWriteTool(baseRun, { name: 'mcp__agent_bridge__dispatch_task', input: { task: 'x' } }, 'linux')).toEqual({ allow: true })
    expect(guardRunWriteTool(baseRun, { name: 'mcp__github__get_issue', input: {} }, 'linux')).toEqual({ allow: true })
    // A non-MCP unknown tool still passes the read-only guard.
    expect(guardRunWriteTool(readRun, { name: 'read_file', input: { path: 'a.txt' } }, 'linux')).toEqual({ allow: true })
  })
})

describe('3. Async snapshot capture, manifest-only reads, size guard, and orphan snapshot GC', () => {
  it('captures asynchronously, validates manifests without reading all blobs, reads single entries, enforces size limits, and prunes unreferenced snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dot-art-async-'))
    const home = mkdtempSync(join(tmpdir(), 'dot-art-home-'))
    try {
      mkdirSync(join(root, '.vite'), { recursive: true })
      writeFileSync(join(root, '.vite', 'cache.js'), 'skip')
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'one.ts'), 'one')
      writeFileSync(join(root, 'src', 'two.ts'), 'two')

      expect(ignoredDirName('.vite', 'linux')).toBe(true)
      // A parent junction or a Windows 8.3 short name is not a link at this directory.
      expect(await scanScopeAsync(root, root, 'directory')).toEqual(scanScope(root, root, 'directory'))
      const captured = await captureScopeAsync(root, root, 'directory')
      expect(captured.files.map(f => f.path).sort()).toEqual(['src/one.ts', 'src/two.ts'])

      expect(() => captureScope(root, root, 'directory', process.platform, 2)).toThrow(/exceeds snapshot size limit/)
      await expect(captureScopeAsync(root, root, 'directory', process.platform, 2)).rejects.toThrow(/exceeds snapshot size limit/)

      const snapKeep = join(home, 'artifacts', 'base-keep-1')
      const snapDrop = join(home, 'artifacts', 'base-drop-1')
      saveSnapshot(snapKeep, captured.files, undefined, { root, exclusions: captured.exclusions })
      saveSnapshot(snapDrop, captured.files, undefined, { root, exclusions: captured.exclusions })

      const manifest = readManifest(snapKeep)
      expect(manifest.saved).toHaveLength(2)
      const oneBytes = readSnapshotEntry(snapKeep, 'src/one.ts')
      expect(new TextDecoder().decode(oneBytes)).toBe('one')
      expect(readSnapshotEntry(snapKeep, 'src/missing.ts')).toBeUndefined()

      expect(pruneSnapshots(home, new Set(['base-keep-1']))).toBe(1)
      expect(existsSync(snapKeep)).toBe(true)
      expect(existsSync(snapDrop)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('walks a scope reached through a linked parent, and still refuses a link at the scope itself', async () => {
    const real = mkdtempSync(join(tmpdir(), 'dot-art-real-'))
    const aliasRoot = mkdtempSync(join(tmpdir(), 'dot-art-alias-'))
    const alias = join(aliasRoot, 'alias')
    try {
      mkdirSync(join(real, 'src'), { recursive: true })
      writeFileSync(join(real, 'src', 'one.ts'), 'one')
      symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')

      // A path that only passes through a link (or a Windows 8.3 short name such as
      // RUNNER~1) is not a link at the scope, so both walks must read it.
      const scope = join(alias, 'src')
      expect(scanScope(scope, scope, 'directory').files).toEqual(['one.ts'])
      const captured = await captureScopeAsync(scope, scope, 'directory')
      expect(captured.files.map(file => file.path)).toEqual(['one.ts'])

      // A link at the scope itself is still refused.
      expect(() => scanScope(alias, alias, 'directory')).toThrow(/refusing to follow a link/)
      await expect(captureScopeAsync(alias, alias, 'directory')).rejects.toThrow(/refusing to follow a link/)
    } finally {
      rmSync(alias, { force: true })
      rmSync(real, { recursive: true, force: true })
      rmSync(aliasRoot, { recursive: true, force: true })
    }
  })
})

describe('4. Unknown creation/delivery recovery and human forceReleaseChange', () => {
  function minimalHost(overrides: Partial<RunSessionHost> = {}): RunSessionHost {
    return {
      findSession: async () => undefined,
      createSession: async input => ({ sessionId: input.sessionId, cwd: input.cwd }),
      prepareAccess: async () => 'ok',
      prompt: async () => 'accepted',
      promptReceipts: async () => 0,
      relay: async () => 'accepted',
      relayInserts: async () => 0,
      stop: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true }),
      ...overrides,
    }
  }

  it('recovers an absent unknown creation on reconcile and releases it cleanly on cancel', async () => {
    const book = new WorkBook(async () => undefined, 'linux')
    const change = await book.createChange({ title: 'T', cwd: '/repo', goal: 'g', at: 1 })
    const res = await book.reserveRun({ changeId: change.id, cwd: '/repo', root: { workspaceRoot: '/repo' }, writeScope: { kind: 'paths', paths: [] }, at: 2 })
    if (!res.ok) throw new Error(res.message)

    // Simulate failed createSession leaving creation='unknown' with no sessionId
    await launchReservedRun(book, minimalHost({ createSession: async () => { throw new Error('timeout') } }), res.run.id, 'go')
    expect(book.run(res.run.id)?.creation).toBe('unknown')

    // Reconcile observes session is absent on host -> resets creation back to 'intent'
    await reconcileReserved(book, minimalHost({ findSession: async () => undefined }), res.run.id)
    expect(book.run(res.run.id)?.creation).toBe('intent')

    // Even if cancelled while creation='unknown' and absent on host, cancelWork releases it!
    await book.markCreation(res.run.id, 'unknown', 3)
    const cancelled = await cancelWork(book, minimalHost({ findSession: async () => undefined }), change.id, 4)
    expect(cancelled).toMatchObject({ ok: true, runs: [{ id: res.run.id, released: true }] })
    expect(book.occupying()).toEqual([])
  })

  it('retires quiescent unknown supplement deliveries when a cancelled run is verified stopped, and supports forceReleaseChange', async () => {
    const book = new WorkBook(async () => undefined, 'linux')
    const change = await book.createChange({ title: 'T', cwd: '/repo', goal: 'g', at: 1 })
    const res = await book.reserveRun({ changeId: change.id, cwd: '/repo', root: { workspaceRoot: '/repo' }, writeScope: { kind: 'paths', paths: [{ path: '/repo/a.ts', type: 'file' }] }, at: 2 })
    if (!res.ok) throw new Error(res.message)
    await book.publishBaseline(res.run.id, book.revision, 'base-1', 3)
    const host = minimalHost({ findSession: async () => ({ cwd: '/repo' }) })
    expect((await launchReservedRun(book, host, res.run.id, 'start')).ok).toBe(true)

    // Leave a finished-attempt unknown supplement delivery
    await supplementRun(book, minimalHost({ findSession: async () => ({ cwd: '/repo' }), relayInserts: async () => undefined }), res.run.id, 'extra', 'dot', 4)
    expect(book.run(res.run.id)?.deliveries.some(d => d.status === 'unknown')).toBe(true)

    // Cancelling with verified stop retires the quiescent unknown supplement and releases the write lock
    const cancelled = await cancelWork(book, host, change.id, 5)
    expect(cancelled).toMatchObject({ ok: true, runs: [{ id: res.run.id, released: true }] })
    expect(book.occupying()).toEqual([])

    // Wedged run (e.g. jobsSettled: 'unknown') can be force-released by the human after cancel
    const c2 = await book.createChange({ title: 'Wedged', cwd: '/repo', goal: 'g2', at: 6 })
    const r2 = await book.reserveRun({ changeId: c2.id, cwd: '/repo', root: { workspaceRoot: '/repo' }, writeScope: { kind: 'workspace-exclusive' }, at: 7 })
    if (!r2.ok) throw new Error(r2.message)
    await book.publishBaseline(r2.run.id, book.revision, 'base-2', 8)
    await launchReservedRun(book, host, r2.run.id, 'start')
    await cancelWork(book, minimalHost({ findSession: async () => ({ cwd: '/repo' }), stop: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: 'unknown' }) }), c2.id, 9)
    expect(book.occupying().map(r => r.id)).toEqual([r2.run.id])
    expect(forceReleasePayload(book.workView(c2.id)!)).toEqual({ id: c2.id })

    const forced = await book.forceReleaseChange(c2.id, 10)
    expect(forced).toEqual({ ok: true, released: [r2.run.id] })
    expect(book.occupying()).toEqual([])
    expect(reconcileRun).toBeTypeOf('function')
  })

  it('refuses a force release on a change that is not cancelled before it stops any session', async () => {
    const h = makeServiceHarness()
    try {
      const stopped: string[] = []
      const stopActivity = h.host.stopActivity.bind(h.host)
      Object.assign(h.host, {
        stopActivity: async (sessionId: string) => {
          stopped.push(sessionId)
          return stopActivity(sessionId)
        },
      })
      const change = await h.store.work.createChange({ title: 'Live', cwd: h.project, goal: 'g', at: 1 })
      const reserved = await h.store.work.reserveRun({
        changeId: change.id, cwd: h.project, root: { workspaceRoot: h.project }, writeScope: { kind: 'workspace-exclusive' }, at: 2,
      })
      if (!reserved.ok) throw new Error(reserved.message)
      const confirmed = await h.store.work.confirmSession(reserved.run.id, { sessionId: reserved.run.requestedSessionId, cwd: h.project }, 3)
      if (!confirmed.ok) throw new Error(confirmed.message)

      const refused = await h.service.forceReleaseWork(change.id)
      expect(refused).toMatchObject({ ok: false, code: 'invalid' })
      expect(stopped).toEqual([])
      expect(h.store.work.run(reserved.run.id)?.phase).toBe('reserved')

      expect(await h.service.forceReleaseWork('c-unknown')).toMatchObject({ ok: false, code: 'missing' })
      expect(stopped).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  it('keeps a proved supplement when a verified stop runs during the receipt check', async () => {
    const book = new WorkBook(async () => undefined, 'linux')
    const change = await book.createChange({ title: 'Relay', cwd: '/repo', goal: 'g', at: 1 })
    const res = await book.reserveRun({
      changeId: change.id, cwd: '/repo', root: { workspaceRoot: '/repo' },
      writeScope: { kind: 'paths', paths: [{ path: '/repo/a.ts', type: 'file' }] }, at: 2,
    })
    if (!res.ok) throw new Error(res.message)
    await book.publishBaseline(res.run.id, book.revision, 'base-relay', 3)
    const launched = await launchReservedRun(book, minimalHost({ findSession: async () => ({ cwd: '/repo' }) }), res.run.id, 'start')
    expect(launched.ok).toBe(true)

    let relayReturned = false
    let claimHeld = false
    let stopDuringProof: { ok: boolean } | undefined
    const host = minimalHost({
      findSession: async () => ({ cwd: '/repo' }),
      relay: async () => {
        await book.prepareCancel(change.id, 9)
        relayReturned = true
        return 'accepted'
      },
      relayInserts: async () => {
        if (!relayReturned) return 0
        const delivery = book.run(res.run.id)?.deliveries.find(item => item.kind === 'context')
        claimHeld = delivery !== undefined && book.hasLiveRelay(delivery.id)
        const current = book.run(res.run.id)
        stopDuringProof = current
          ? await book.finishSettled(res.run.id, current.updatedAt, 'stopped', { queueCleared: true, agentIdle: true, jobsSettled: true }, 10)
          : undefined
        return 1
      },
    })

    const sent = await supplementRun(book, host, res.run.id, 'landed', 'dot', 8)
    expect(claimHeld).toBe(true)
    expect(stopDuringProof).toMatchObject({ ok: false })
    expect(sent).toMatchObject({ ok: false, code: 'closed-run' })
    const delivery = book.run(res.run.id)?.deliveries.find(item => item.kind === 'context')
    expect(delivery).toMatchObject({ status: 'accepted', contentRef: 'landed' })
    expect(delivery?.evidence).not.toBe('superseded-by-verified-stop')
    expect(book.run(res.run.id)?.phase).toBe('settling')

    const current = book.run(res.run.id)
    const stopped = await book.finishSettled(res.run.id, current!.updatedAt, 'stopped', { queueCleared: true, agentIdle: true, jobsSettled: true }, 11)
    expect(stopped).toMatchObject({ ok: true, phase: 'stopped' })
    expect(book.run(res.run.id)?.deliveries.find(item => item.id === delivery?.id)).toMatchObject({ status: 'accepted' })
  })
})


describe('6. Bounded state.cards, durable task-table deletes, and WorkBook history pruning', () => {
  it('caps stored cards while preserving monotonic cardSequence, and deletes pruned tasks and old changes from durable tables', async () => {
    const { domain, tables, deletes } = makeFakeDomain()
    const store = new DotStore(domain)
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    const cards = new DotCards(store)
    const view = { title: 'Pick', interactive: true, view: { type: 'options' as const, id: 'o', options: [{ label: 'A' }] } }
    for (let i = 1; i <= MAX_STORED_CARDS + 15; i++) {
      await cards.present(view, `call-${i}`)
    }
    expect(store.cards.length).toBeLessThanOrEqual(MAX_STORED_CARDS)
    expect(store.cardSequence).toBe(MAX_STORED_CARDS + 15)

    for (let i = 1; i <= MAX_TASKS + 5; i++) {
      await store.track({ sessionId: `s-${i}`, origin: 'started', title: `T${i}`, goal: 'g', cwd: '/w', at: i })
      await store.apply({ type: 'archived', sessionId: `s-${i}`, at: i + 1 }, [])
    }
    await store.flush()
    expect(store.list()).toHaveLength(MAX_TASKS)
    expect(tables.tasks!.size).toBe(MAX_TASKS)
    expect(deletes.some(d => d.startsWith('tasks:s-'))).toBe(true)

    for (let i = 1; i <= 5; i++) {
      const c = await store.work.createChange({ title: `C${i}`, cwd: '/w', goal: 'g', at: i })
      await store.work.setControl(c.id, 'cancelled', i + 10)
    }
    const pruned = await store.pruneWorkHistory(2)
    await store.flush()
    expect(pruned.prunedChanges).toHaveLength(3)
    expect(store.work.listChanges()).toHaveLength(2)
    expect(tables.changes!.size).toBe(2)
  })
})

describe('7. CJK-aware history tokenization and parallel session search', () => {
  it('segments unspaced Chinese phrases while keeping English whitespace terms intact', async () => {
    expect(queryTerms('  Friday  SHIP friday ')).toEqual(['friday', 'ship'])
    const cjkTerms = queryTerms('修复失效链接')
    expect(cjkTerms.length).toBeGreaterThanOrEqual(2)
    const rows = [{ seq: 1, at: 1000, role: 'human' as const, text: '我已经把文档页里失效的链接全部修复好了' }]
    expect(searchRows(rows, cjkTerms).map(h => h.seq)).toEqual([1])

    const h = makeServiceHarness()
    try {
      for (let i = 1; i <= 20; i++) {
        await h.store.track({ sessionId: `s-${i}`, origin: 'watched', title: `Task ${i}`, goal: 'g', cwd: h.project, at: i })
        h.events.set(`s-${i}`, [{ type: 'user/message', seq: 1, time: i * 100, data: { content: [{ type: 'text', text: i === 17 ? '文档页里失效的链接已经修复' : 'ordinary message' }], source: { kind: 'user' } } }])
      }
      const res = await h.service.searchHistory({ query: '修复失效链接', scope: 'tasks' })
      expect(res).toContain('s-17')
    } finally {
      h.cleanup()
    }
  })
})

describe('8. Localized cardAnswerText, 8-locale parity, and ChatFeed boardRev watermark', () => {
  it('formats card reply headers per locale, keeps all 8 locale packs key-identical, and bumps boardRev on ChatFeed', () => {
    const card = {
      id: 'dot-card-3',
      number: 3,
      sessionId: 'dot-1',
      callId: 'c3',
      title: 'Deploy',
      view: { type: 'confirm' as const, id: 'ok', confirmLabel: 'Yes', cancelLabel: 'No' },
      expired: false,
    }
    const ans = { id: 'dot-card-3', action: 'ok', values: { confirmed: true } }
    expect(cardAnswerText(card, ans)).toMatch(/^\[答复卡片 #3「Deploy」\]/)
    expect(cardAnswerText(card, ans, 'en')).toMatch(/^\[Card reply #3 "Deploy"\]/)
    expect(cardAnswerText(card, ans, 'ja')).toMatch(/^\[カード返信 #3「Deploy」\]/)

    const baseKeys = Object.keys(localePack('zh').ui).sort()
    for (const loc of SUPPORTED_LOCALES) {
      expect(Object.keys(localePack(loc).ui).sort()).toEqual(baseKeys)
      expect(localePack(loc).ui.workForceRelease.length).toBeGreaterThan(0)
    }

    const h = makeServiceHarness()
    try {
      const feed = new ChatFeed(h.host as never, h.store)
      feed.attach('dot-session', [])
      const initialRev = feed.snapshot(0)?.boardRev ?? 0
      feed.boardChanged()
      expect(feed.snapshot(0)?.boardRev).toBe(initialRev + 1)
    } finally {
      h.cleanup()
    }
  })
})

describe('9. Board RPC names reach the host transport', () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
  const clientEndpoints = [...source('./client.tsx').matchAll(/\bcall(?:<[^>]*>)?\('([A-Za-z][\w.]*)'/g)].map(match => match[1])
  const serverEndpoints = [...source('./index.ts').matchAll(/case '([A-Za-z][\w.]*)':/g)].map(match => match[1])

  it('sends every client call under a name the host RPC transport routes', () => {
    expect(clientEndpoints.length).toBeGreaterThan(10)
    // registerHostRpcTransport routes only /^[a-z.]+$/ and answers 404 for the rest,
    // so a camelCase endpoint reaches the client but never the service.
    expect(clientEndpoints.filter(name => !/^[a-z.]+$/.test(name))).toEqual([])
    expect([...new Set(clientEndpoints)].filter(name => !serverEndpoints.includes(name))).toEqual([])
  })
})
