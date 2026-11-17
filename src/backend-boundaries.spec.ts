/**
 * The four boundaries left by the second C review. Calls go through the
 * registered tools, the service, and the host events those paths already use.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, TOOL, type DotSettings } from './contracts.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { apply } from './tools.ts'

interface RelayCall { sessionId: string; senderId: string; text: string; deliveryId?: string }
interface HostHooks {
  sessions?: Array<{ sessionId: string; cwd?: string; running: boolean }>
  prompt?: (sessionId: string) => Promise<void>
  relay?: (sessionId: string, senderId: string, text: string, deliveryId?: string) => Promise<void>
}

function harness(settings: Partial<DotSettings> = {}, hooks: HostHooks = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dot-boundary-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-boundary-proj-'))
  writeFileSync(join(project, 'a.ts'), 'before')
  writeFileSync(join(project, 'b.ts'), 'before')
  const store = new DotStore(undefined)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0, ...settings })
  const calls: string[] = []
  const relays: RelayCall[] = []
  const events = new Map<string, unknown[]>()
  const sessions = new Map<string, { cwd?: string; preset?: string }>()
  const host = {
    isRunning: () => false,
    listSessions: async () => {
      calls.push('listSessions')
      return (hooks.sessions ?? []).map(row => ({ ...row, updatedAt: 1, blank: false, subagent: false, archived: false }))
    },
    latestReply: async () => 'wrote the file',
    readEvents: async (sessionId: string) => events.get(sessionId) ?? [],
    cancel: async () => {},
    archive: async () => {},
    modelKey: () => 'p/ok',
    syncModel: () => {},
    createWorkspace: async () => ({ id: 'ws', title: 'p', path: project }),
    listWorkspaces: () => [{ id: 'ws', title: 'p', path: project }],
    cwdOf: async () => project,
    listModels: async () => ({ fallback: { provider: 'p', model: 'ok' }, models: [{ provider: 'p', model: 'ok', name: 'Ok' }] }),
    listPresets: async () => ({ fallback: 'standard', presets: [{ id: 'standard' }] }),
    selectModel: async () => {},
    setReadOnly: async () => true,
    setWritable: async () => true,
    verifyTaskPermission: async () => true,
    createDot: async () => 'dot-session',
    resumeDot: async (id: string) => id === 'dot-session',
    findSession: async (id: string) => sessions.get(id),
    createSession: async (input: { sessionId?: string; cwd?: string; preset?: string }) => {
      const id = input.sessionId ?? `session-${sessions.size}`
      sessions.set(id, { cwd: input.cwd, ...(input.preset ? { preset: input.preset } : {}) })
      calls.push(`create ${id}`)
      return id
    },
    prompt: async (sessionId: string) => {
      calls.push('prompt')
      await hooks.prompt?.(sessionId)
    },
    relay: async (sessionId: string, senderId: string, text: string, deliveryId?: string) => {
      relays.push({ sessionId, senderId, text, deliveryId })
      if (hooks.relay) await hooks.relay(sessionId, senderId, text, deliveryId)
      const prior = events.get(sessionId) ?? []
      prior.push({
        type: 'agent/inbox/spliced',
        data: { inserted: [{ id: `msg-${prior.length}`, source: { kind: 'agent-message', form: 'relay', senderSessionId: senderId, deliveryId }, content: [{ type: 'text', text }] }] },
      })
      events.set(sessionId, prior)
    },
    stopActivity: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }),
  }
  const notes = { path: '/dot/memory.md', text: '', cognition: '', read: async () => '', readCognition: async () => '' }
  const service = new DotService({
    host: host as never, store, homeDir: home, notes, approvalGraceMs: 0,
    timer: { set: (cb, ms) => setTimeout(cb, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now() },
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
  const task = registered.find(row => row.name === TOOL.task) as { execute(args: Record<string, unknown>): Promise<string> }
  const start = { ...task, execute: (args: Record<string, unknown>, _exec?: unknown) => task.execute({ ...args, action: 'dispatch', ...((args.cwd ?? args.dir) ? { dir: args.cwd ?? args.dir } : {}) }) }
  const exec = { signal: new AbortController().signal }
  return {
    home, project, store, service, calls, relays, task, start, exec,
    cleanup: () => { rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) },
  }
}

describe('backend boundaries', () => {
  it('keeps a write run behind the user-session gate when access is omitted or lowered', async () => {
    const sessions = [{ sessionId: 'human-running', cwd: '', running: true }]
    const h = harness({}, { sessions })
    sessions[0]!.cwd = h.project
    try {
      const change = await h.service.createWorkChange({ title: 'Ship', cwd: h.project, goal: 'land', at: 1 })
      const reserved = await h.service.reserveWorkRun({
        changeId: change.id, cwd: h.project, root: { workspaceRoot: h.project },
        writeScope: { kind: 'paths', paths: [{ path: join(h.project, 'a.ts'), type: 'file' }] }, at: 2,
      })
      if (!reserved.ok) throw new Error(reserved.message)
      await h.service.captureWorkBaseline(reserved.run.id)
      for (const access of ['write', undefined, 'read']) {
        await expect(h.start.execute({ task_id: change.id, instruction: 'edit', ...(access ? { access } : {}) }, h.exec)).rejects.toMatchObject({ code: 'dot/locked', message: expect.stringContaining('human-running RUNNING') })
      }
      expect(h.calls.some(call => call.startsWith('create '))).toBe(false)
      expect(h.calls).not.toContain('prompt')
      expect(h.store.work.run(reserved.run.id)?.phase).toBe('reserved')
    } finally { h.cleanup() }
  })

  it('starts a non-overlapping path and locks only a real overlap', async () => {
    const h = harness()
    try {
      const first = await h.service.createWorkChange({ title: 'One', cwd: h.project, goal: 'a', at: 1 })
      const second = await h.service.createWorkChange({ title: 'Two', cwd: h.project, goal: 'b', at: 2 })
      const left = await h.service.reserveWorkRun({
        changeId: first.id, cwd: h.project, root: { workspaceRoot: h.project },
        writeScope: { kind: 'paths', paths: [{ path: join(h.project, 'a.ts'), type: 'file' }] }, at: 3,
      })
      const right = await h.service.reserveWorkRun({
        changeId: second.id, cwd: h.project, root: { workspaceRoot: h.project },
        writeScope: { kind: 'paths', paths: [{ path: join(h.project, 'b.ts'), type: 'file' }] }, at: 4,
      })
      if (!left.ok || !right.ok) throw new Error('reserve failed')
      await h.service.captureWorkBaseline(right.run.id)
      const started = await h.start.execute({ task_id: second.id, instruction: 'edit b', access: 'write' }, h.exec)
      expect(started).toContain(`started ${right.run.id}`)
      expect(started).not.toContain('dot/locked')
      const prompts = h.calls.filter(call => call === 'prompt').length
      const third = await h.service.createWorkChange({ title: 'Three', cwd: h.project, goal: 'overlap', at: 5 })
      await expect(h.start.execute({
        task_id: third.id, instruction: 'edit a', access: 'write',
        paths: JSON.stringify([{ path: join(h.project, 'a.ts'), type: 'file' }]),
      }, h.exec)).rejects.toMatchObject({ code: 'dot/locked', message: expect.stringContaining(left.run.id) })
      expect(h.calls.filter(call => call === 'prompt').length).toBe(prompts)
    } finally { h.cleanup() }
  })

  it('records progress without probing results and still refuses a stale input', async () => {
    const h = harness()
    try {
      const change = await h.service.createWorkChange({ title: 'Ship', goal: 'land', cwd: h.project, steps: [{ stepRef: 's1', text: 'edit' }] })
      const note = await h.task.execute({ action: 'step', task_id: change.id, step_ref: 's1', expected_input_revision: change.currentRevision })
      expect(note).toContain('step s1 done')
      expect(h.calls).not.toContain('prompt')
      expect(h.store.work.change(change.id)?.closeout).toBeUndefined()
      await h.service.reviseWorkChange(change.id, { goal: 'later' })
      await expect(h.task.execute({ action: 'step', task_id: change.id, step_ref: 's1', expected_input_revision: change.currentRevision })).rejects.toThrow(/not on revision/)
      expect(h.store.work.change(change.id)?.steps[0]?.done).toBe(false)
    } finally { h.cleanup() }
  })

  it('notifies a completion that happens before the first prompt returns', async () => {
    let seen = ''
    const h = harness({}, {
      prompt: async sessionId => {
        seen = sessionId
        expect(h.store.tracks(sessionId)).toBe(true)
        await h.service.onTurnEnd(sessionId)
      },
    })
    try {
      await h.store.setDot({ dotSessionId: 'dot-session' })
      const change = await h.service.createWorkChange({ title: 'Ship', cwd: h.project, goal: 'land', at: 1 })
      const reserved = await h.service.reserveWorkRun({
        changeId: change.id, cwd: h.project, root: { workspaceRoot: h.project },
        writeScope: { kind: 'paths', paths: [] }, at: 2,
      })
      if (!reserved.ok) throw new Error(reserved.message)
      const launched = await h.service.launchWorkRun(reserved.run.id, 'look')
      if (!launched.ok) throw new Error(launched.message)
      const sessionId = h.store.work.run(reserved.run.id)?.sessionId
      await h.service.flushNotices()
      expect(seen).toBe(sessionId)
      expect(h.store.tracks(seen)).toBe(true)
      expect(h.relays.map(row => row.text).join('\n')).toContain(`${change.id} ${reserved.run.id} input`)
    } finally { h.cleanup() }
  })

  it('notifies an error that happens before the first prompt returns', async () => {
    const h = harness({}, {
      prompt: async sessionId => { h.service.onError(sessionId, new Error('disk failed')) },
    })
    try {
      await h.store.setDot({ dotSessionId: 'dot-session' })
      const change = await h.service.createWorkChange({ title: 'Ship', cwd: h.project, goal: 'land', at: 1 })
      const reserved = await h.service.reserveWorkRun({
        changeId: change.id, cwd: h.project, root: { workspaceRoot: h.project },
        writeScope: { kind: 'paths', paths: [] }, at: 2,
      })
      if (!reserved.ok) throw new Error(reserved.message)
      const launched = await h.service.launchWorkRun(reserved.run.id, 'look')
      if (!launched.ok) throw new Error(launched.message)
      const sessionId = h.store.work.run(reserved.run.id)?.sessionId
      await h.service.flushNotices()
      const text = h.relays.map(row => row.text).join('\n')
      expect(h.store.tracks(sessionId ?? '')).toBe(true)
      expect(text).toContain('disk failed')
      expect(text).toContain(`${change.id} ${reserved.run.id} input`)
    } finally { h.cleanup() }
  })

  it('lets an unrelated list finish while supplement is waiting on relay', async () => {
    let releaseRelay: (() => void) | undefined
    let relayStarted = false
    const h = harness({}, {
      relay: async () => {
        relayStarted = true
        await new Promise<void>(resolve => { releaseRelay = resolve })
      },
    })
    try {
      const change = await h.service.createWorkChange({ title: 'Ship', cwd: h.project, goal: 'land', at: 1 })
      const reserved = await h.service.reserveWorkRun({
        changeId: change.id, cwd: h.project, root: { workspaceRoot: h.project },
        writeScope: { kind: 'paths', paths: [] }, at: 2,
      })
      if (!reserved.ok) throw new Error(reserved.message)
      const launched = await h.service.launchWorkRun(reserved.run.id, 'look')
      if (!launched.ok) throw new Error(launched.message)
      await h.store.setDot({ dotSessionId: 'dot-session' })
      const current = h.store.work.change(change.id)!
      const pending = h.task.execute({
        action: 'supplement', run_id: reserved.run.id, message: 'one more detail',
        expected_input_ref: current.currentInputRef, expected_input_revision: current.currentRevision,
      })
      for (let n = 0; n < 20 && !relayStarted; n += 1) await new Promise(resolve => setTimeout(resolve, 10))
      expect(relayStarted).toBe(true)
      let listed = false
      const listing = h.task.execute({ action: 'list' }).then(text => { listed = true; return text })
      const winner = await Promise.race([listing.then(() => 'listed'), new Promise(resolve => setTimeout(() => resolve('blocked'), 300))])
      expect(winner).toBe('listed')
      expect(listed).toBe(true)
      releaseRelay?.()
      expect(await pending).toContain(`supplemented ${reserved.run.id}`)
    } finally { h.cleanup() }
  })
})
