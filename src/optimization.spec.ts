/**
 * Regression and integration suite for the architecture optimization patch:
 * 1. Snapshot directory filtering (.git / node_modules), in-tree symlink tolerance,
 *    shared CAS hardlink deduplication, and factory-reset artifact cleanup.
 * 2. Git repository & worktree `commondir` mutual-exclusion root detection.
 * 3. Unified WorkBook observability across `ledgerSummary`, `IdleChecker`,
 *    `headerBoardCounts`, `sessionLookup`, and read-only `Run` approval escalation.
 * 4. Atomic `capture_baseline` / `dispatch` and deterministic `closeout` (`acceptDirect`),
 *    including human-oversight (`human_review`) gating without double-counting badges.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureScope, restoreSnapshot, saveSnapshot, wipeArtifacts } from './artifacts.ts'
import { headerBoardCounts, sessionLookup } from './board-groups.ts'
import { DEFAULT_SETTINGS, TOOL, type DotSettings } from './contracts.ts'
import { detectWorkspaceRoot } from './git-root.ts'
import { idleCandidates } from './idle-check.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { apply } from './tools.ts'
import { occupantsConflict, workspaceIdentity } from './work.ts'

function createHarness(settings: Partial<DotSettings> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dot-opt-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-opt-proj-'))
  writeFileSync(join(project, 'doc.md'), 'old-link')
  const store = new DotStore(undefined)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 10, ...settings })
  const sessions = new Map<string, { cwd?: string; preset?: string }>()
  const relays: Array<{ target: string; text: string }> = []
  const host = {
    isRunning: () => false,
    listSessions: async () => [],
    titles: async () => new Map<string, string>(),
    latestReply: async () => 'fixed broken link in doc.md',
    readEvents: async () => [
      { type: 'assistant/message', seq: 1, time: 1000, data: { message: { content: 'fixed broken link in doc.md' } } },
    ],
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
    resumeDot: async (id: string) => id === 'dot-session',
    releaseDot: async () => {},
    dotContext: async () => ({ live: true, compactions: 0 }),
    summarize: async () => 'handoff summary',
    findSession: async (id: string) => sessions.get(id),
    createSession: async (input: { sessionId?: string; cwd?: string; preset?: string }) => {
      const id = input.sessionId ?? `session-${sessions.size}`
      sessions.set(id, { cwd: input.cwd, ...(input.preset ? { preset: input.preset } : {}) })
      return id
    },
    prompt: async () => {},
    relay: async (target: string, _sender: string, text: string) => { relays.push({ target, text }) },
    stopActivity: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }),
  }
  const notes = { path: join(home, 'memory.md'), read: async () => '', readCognition: async () => '' }
  const service = new DotService({
    host: host as never,
    store,
    homeDir: home,
    notes,
    approvalGraceMs: 0,
    timer: { set: () => 1, clear: () => {}, now: () => 1000 },
    now: () => 1000,
  })
  const registered: Array<Record<string, unknown>> = []
  apply({
    tools: { schemas: () => [], restrict: () => () => {}, register(definition: Record<string, unknown>) { registered.push(definition); return () => {} } },
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    dot: service,
    effect(fn: () => unknown) { fn() },
  } as never)
  const taskTool = registered.find(row => row.name === TOOL.task) as { execute(args: Record<string, unknown>): Promise<string> }
  const startTool = registered.find(row => row.name === TOOL.startTask) as { execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<string> }
  return {
    home,
    project,
    store,
    service,
    relays,
    taskTool,
    startTool,
    exec: { signal: new AbortController().signal },
    cleanup: () => {
      rmSync(project, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

describe('snapshot filtering, symlink safety, and shared CAS deduplication', () => {
  it('ignores .git and node_modules, skips symlinks during scans, deduplicates through the CAS without sharing inodes, and wipes on reset', () => {
    const root = mkdtempSync(join(tmpdir(), 'dot-cas-proj-'))
    const home = mkdtempSync(join(tmpdir(), 'dot-cas-home-'))
    const outside = mkdtempSync(join(tmpdir(), 'dot-cas-ext-'))
    try {
      mkdirSync(join(root, '.git', 'objects'), { recursive: true })
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      mkdirSync(join(root, 'node_modules', '.pnpm', 'pkg'), { recursive: true })
      writeFileSync(join(root, 'node_modules', '.pnpm', 'pkg', 'index.js'), 'module.exports = 1')
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 42\n')
      writeFileSync(join(outside, 'secret.txt'), 'secret')
      symlinkSync(outside, join(root, 'src', 'linked-dir'), 'junction')

      const captured = captureScope(root, root, 'directory')
      expect(captured.files.map(file => file.path)).toEqual(['src/app.ts'])

      const snapA = join(home, 'artifacts', 'snap-a')
      const snapB = join(home, 'artifacts', 'snap-b')
      const savedA = saveSnapshot(snapA, captured.files, undefined, { root })
      const savedB = saveSnapshot(snapB, captured.files, undefined, { root })
      expect(readdirSync(join(home, 'artifacts')).sort()).toEqual(['snap-a', 'snap-b'])
      expect(existsSync(join(home, 'cas-blobs', savedA.saved[0]!.sha256))).toBe(true)

      const blobA = join(snapA, 'blobs', savedA.saved[0]!.sha256)
      const blobB = join(snapB, 'blobs', savedB.saved[0]!.sha256)
      // Deduplication must not share an inode: a snapshot's blobs stay independent
      // files, so one in-place write cannot corrupt another snapshot that is immutable.
      expect(statSync(blobA, { bigint: true }).ino).not.toBe(statSync(blobB, { bigint: true }).ino)
      expect(readFileSync(blobA)).toEqual(readFileSync(blobB))
      writeFileSync(blobA, new Uint8Array([0]))
      expect(readFileSync(blobB, 'utf8')).toBe('export const x = 42\n')
      expect(readFileSync(join(home, 'cas-blobs', savedA.saved[0]!.sha256), 'utf8')).toBe('export const x = 42\n')

      // Restore still refuses writing through a symlink/junction inside target root
      const badSnap = join(home, 'artifacts', 'snap-escape')
      saveSnapshot(badSnap, [{ path: 'src/linked-dir/pwn.txt', body: new TextEncoder().encode('no') }], undefined, { root })
      expect(() => restoreSnapshot(badSnap, root)).toThrow(/link/)

      wipeArtifacts(home)
      expect(existsSync(join(home, 'artifacts'))).toBe(false)
      expect(existsSync(join(home, 'cas-blobs'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('git worktree common-dir discovery', () => {
  it('resolves shared gitCommonDir across linked worktrees for workspace-exclusive conflict checks', () => {
    const base = mkdtempSync(join(tmpdir(), 'dot-wt-'))
    try {
      const mainRepo = join(base, 'main')
      const commonGit = join(mainRepo, '.git')
      const wtGit = join(commonGit, 'worktrees', 'feat-a')
      const worktreeA = join(base, 'wt-feat-a')
      mkdirSync(join(wtGit), { recursive: true })
      mkdirSync(join(worktreeA, 'packages', 'ui'), { recursive: true })
      writeFileSync(join(wtGit, 'commondir'), '../..\n')
      writeFileSync(join(worktreeA, '.git'), `gitdir: ${wtGit}\n`)

      const mainHint = detectWorkspaceRoot(mainRepo)
      const wtHint = detectWorkspaceRoot(join(worktreeA, 'packages', 'ui'))
      const idMain = workspaceIdentity(mainRepo, mainHint)
      const idWt = workspaceIdentity(worktreeA, wtHint)
      expect(idMain.exclusiveRoot).toBe(idWt.exclusiveRoot)
      expect(occupantsConflict(
        { id: 'r1', cwd: mainRepo, ...idMain, writeScope: { kind: 'workspace-exclusive' } },
        { id: 'r2', cwd: worktreeA, ...idWt, writeScope: { kind: 'workspace-exclusive' } },
      )).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('WorkBook observability seams & atomic closeout pipeline', () => {
  it('completes a single-file Change via capture_baseline + closeout and surfaces Changes in overview, idle-check, board counts, and read-only approval risk', async () => {
    const h = createHarness({ scope: 'tracked' })
    try {
      await h.store.setDot({ dotSessionId: 'dot-session' })
      const paths = JSON.stringify([{ path: 'doc.md', type: 'file' }])

      const started = await h.startTool.execute({
        cwd: h.project,
        title: 'Fix broken link',
        goal: 'Update broken link in doc.md',
        instruction: 'Replace old-link with new-link in doc.md',
        access: 'write',
        paths,
        capture_baseline: true,
      }, h.exec)
      const runId = /started (run-\d+)/.exec(started)?.[1]
      const changeId = /on (c-\d+)/.exec(started)?.[1]
      expect(runId && changeId).toBeTruthy()

      const overviewText = await h.service.overview(h.exec.signal)
      expect(overviewText).toContain('Changes:')
      expect(overviewText).toContain(`${changeId} RUNNING`)
      const boardSnap = h.service.board()
      expect(headerBoardCounts(boardSnap)).toEqual({ liveCount: 1, waitingCount: 0 })
      const run = h.store.work.run(runId!)!
      expect(sessionLookup(boardSnap).get(run.sessionId!)?.title).toBe('Fix broken link')

      // Read-only Run triggers forced human escalation on write-like shell command
      const roRun = await h.service.reserveWorkRun({
        changeId: changeId!,
        kind: 'work',
        cwd: h.project,
        writeScope: { kind: 'paths', paths: [] },
      })
      if (roRun.ok) {
        const roLaunched = await h.service.launchWorkRun(roRun.run.id, 'inspect')
        if (roLaunched.ok) {
          const roSession = h.store.work.run(roRun.run.id)!.sessionId!
          const relayed = h.service.relayRequest({
            kind: 'approval',
            sessionId: roSession,
            subject: 'bash',
            toolName: 'bash',
            arguments: 'echo hi > out.txt',
          })
          expect(relayed.decided).toBe('pending')
          expect(h.service.pending.list().find(p => p.sessionId === roSession)?.humanRequired).toBe(true)
          await h.service.finishWorkRun(roRun.run.id, 'completed')
        }
      }

      writeFileSync(join(h.project, 'doc.md'), 'new-link')
      expect(await h.taskTool.execute({ action: 'finish', task_id: changeId!, run_id: runId!, verdict: 'pass' })).toContain(`completed ${runId}`)

      const idle = idleCandidates(h.store.listTickets(), h.store.list(), [], h.store.workIdle())
      expect(idle.map(item => item.changeId)).toContain(changeId)

      const closed = await h.taskTool.execute({
        action: 'closeout',
        task_id: changeId!,
        expected_input_ref: h.store.work.change(changeId!)!.currentInputRef,
        expected_input_revision: h.store.work.change(changeId!)!.currentRevision,
        checks: JSON.stringify([{ requirementRef: 'goal', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['doc-check'] }]),
        evidence_ref: 'doc-check',
        summary: 'Verified doc.md updated to new-link',
      })
      expect(closed).toContain(`accepted ${changeId}`)
      expect(h.store.work.workView(changeId!)?.status).toBe('done')
      expect(headerBoardCounts(h.service.board())).toEqual({ liveCount: 0, waitingCount: 0 })

      const preview = h.service.previewFactoryReset()
      await h.service.confirmFactoryReset(preview.token)
      expect(existsSync(join(h.home, 'artifacts'))).toBe(false)
      expect(existsSync(join(h.home, 'cas-blobs'))).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  it('supports action=dispatch and gates action=closeout on human_review without double-counting waiting badges', async () => {
    const h = createHarness({ scope: 'tracked' })
    try {
      await h.store.setDot({ dotSessionId: 'dot-session' })
      const created = JSON.parse(await h.taskTool.execute({
        action: 'create',
        title: 'Guarded edit',
        goal: 'Update doc.md with human sign-off',
        dir: h.project,
        human_review: true,
        requirements: JSON.stringify([{ requirementRef: 'R1', text: 'doc updated', required: true }]),
      })) as { id: string }

      const dispatched = await h.taskTool.execute({
        action: 'dispatch',
        task_id: created.id,
        access: 'write',
        paths: JSON.stringify([{ path: 'doc.md', type: 'file' }]),
        message: 'Edit doc.md',
      })
      const dispatchedRunId = /started (run-\d+)/.exec(dispatched)?.[1]
      expect(dispatchedRunId).toBeTruthy()

      writeFileSync(join(h.project, 'doc.md'), 'approved-link')
      await h.taskTool.execute({ action: 'finish', task_id: created.id, run_id: dispatchedRunId! })

      const gate = await h.taskTool.execute({
        action: 'closeout',
        task_id: created.id,
        expected_input_ref: h.store.work.change(created.id)!.currentInputRef,
        expected_input_revision: h.store.work.change(created.id)!.currentRevision,
        checks: JSON.stringify([{ requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['r1-log'] }]),
        evidence_ref: 'r1-log',
        summary: 'doc.md now contains approved-link',
      })
      const pendingId = /pending (req-\d+|[A-Za-z0-9_-]+)/.exec(gate)?.[1] ?? h.service.pending.list()[0]?.id
      expect(pendingId).toBeTruthy()
      expect(h.store.work.workView(created.id)?.status).toBe('waiting')
      // Only 1 waiting count even though both pending request and WorkBoard lookRequest exist
      expect(headerBoardCounts(h.service.board())).toEqual({ liveCount: 1, waitingCount: 1 })

      await h.service.answerWorkReview(pendingId!, true)
      const accepted = await h.taskTool.execute({
        action: 'closeout',
        task_id: created.id,
        expected_input_ref: h.store.work.change(created.id)!.currentInputRef,
        expected_input_revision: h.store.work.change(created.id)!.currentRevision,
        checks: JSON.stringify([{ requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['r1-log'] }]),
        evidence_ref: 'r1-log',
        summary: 'doc.md now contains approved-link',
      })
      expect(accepted).toContain(`accepted ${created.id}`)
      expect(h.store.work.workView(created.id)?.status).toBe('done')
    } finally {
      h.cleanup()
    }
  })
})
