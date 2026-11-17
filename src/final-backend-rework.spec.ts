/**
 * Backend rework for the five C review blockers. Calls go through the
 * registered model tools or the service methods those tools call.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, TOOL, type DotSettings } from './contracts.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { apply } from './tools.ts'

interface Relay { target: string; sender: string; text: string }
interface HostHooks {
  sessions?: Array<{ sessionId: string; cwd?: string; running: boolean }>
  prompt?: () => Promise<void>
  stop?: () => Promise<{ cancelAccepted: boolean; queueCleared: boolean; idle: boolean; jobsSettled: boolean | 'unknown' }>
}

function harness(settings: Partial<DotSettings> = {}, hooks: HostHooks = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dot-rework-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-rework-proj-'))
  writeFileSync(join(project, 'a.ts'), 'before')
  const store = new DotStore(undefined)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0, ...settings })
  const calls: string[] = []
  const relays: Relay[] = []
  const writable: string[] = []
  const selected: string[] = []
  const sessions = new Map<string, { cwd?: string; preset?: string }>()
  const host = {
    isRunning: () => false,
    listSessions: async () => {
      calls.push('listSessions')
      return (hooks.sessions ?? []).map(row => ({ ...row, updatedAt: 1, blank: false, subagent: false, archived: false }))
    },
    latestReply: async () => 'wrote a.ts',
    readEvents: async () => [],
    cancel: async () => {},
    archive: async (sessionId: string) => { calls.push(`archive ${sessionId}`) },
    modelKey: () => 'p/ok',
    syncModel: () => {},
    createWorkspace: async () => ({ id: 'ws', title: 'p', path: project }),
    listWorkspaces: () => [{ id: 'ws', title: 'p', path: project }],
    cwdOf: async () => project,
    listModels: async () => {
      calls.push('listModels')
      return {
        fallback: { provider: 'p', model: 'ok' },
        models: [{ provider: 'p', model: 'ok', name: 'Ok' }, { provider: 'forbidden', model: 'model', name: 'No' }],
      }
    },
    listPresets: async () => {
      calls.push('listPresets')
      return { fallback: 'standard', presets: [{ id: 'standard' }, { id: 'ptc' }] }
    },
    selectModel: async (sessionId: string, choice: { provider: string; model: string }) => { selected.push(`${sessionId} ${choice.provider}/${choice.model}`) },
    setReadOnly: async () => true,
    setWritable: async (_sessionId: string, preset: string) => { writable.push(preset); return true },
    verifyTaskPermission: async () => true,
    createDot: async () => 'dot-session',
    resumeDot: async (id: string) => id === 'dot-session',
    findSession: async (id: string) => sessions.get(id),
    createSession: async (input: { sessionId?: string; cwd?: string; preset?: string }) => {
      const id = input.sessionId ?? `session-${sessions.size}`
      sessions.set(id, { cwd: input.cwd, ...(input.preset ? { preset: input.preset } : {}) })
      calls.push(`create ${id} ${input.preset ?? 'default'}`)
      return id
    },
    prompt: async () => { calls.push('prompt'); await hooks.prompt?.() },
    relay: async (target: string, sender: string, text: string) => { relays.push({ target, sender, text }) },
    stopActivity: async () => {
      calls.push('stop')
      return hooks.stop ? hooks.stop() : { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }
    },
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
  const task = registered.find(row => row.name === TOOL.task) as { description: string; execute(args: Record<string, unknown>): Promise<string> }
  const start = registered.find(row => row.name === TOOL.startTask) as { execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<string> }
  const exec = { signal: new AbortController().signal }
  return { home, project, store, service, calls, relays, writable, selected, task, start, exec, cleanup: () => { rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) } }
}

async function heldReview(h: ReturnType<typeof harness>) {
  const change = await h.service.createWorkChange({ title: 'Ship', cwd: h.project, goal: 'land it', requirements: [{ requirementRef: 'r1', text: 'edits', required: true }], at: 1 })
  const reserved = await h.service.reserveWorkRun({
    changeId: change.id, kind: 'work', cwd: h.project, root: { workspaceRoot: h.project },
    writeScope: { kind: 'paths', paths: [{ path: join(h.project, 'a.ts'), type: 'file' }] }, at: 2,
  })
  if (!reserved.ok) throw new Error(reserved.message)
  await h.service.captureWorkBaseline(reserved.run.id)
  const launched = await h.service.launchWorkRun(reserved.run.id, 'edit it')
  if (!launched.ok) throw new Error(launched.message)
  writeFileSync(join(h.project, 'a.ts'), 'after')
  const finished = await h.service.finishWorkRun(reserved.run.id, 'completed')
  if (!finished.ok) throw new Error(finished.message)
  const review = await h.service.reserveWorkRun({ changeId: change.id, kind: 'review', cwd: h.project, root: { workspaceRoot: h.project }, writeScope: { kind: 'workspace-exclusive' }, at: 5 })
  if (!review.ok) throw new Error(review.message)
  await h.service.captureWorkBaseline(review.run.id)
  const launchedReview = await h.service.launchWorkRun(review.run.id, 'check it')
  if (!launchedReview.ok) throw new Error(launchedReview.message)
  const held = await h.service.holdWorkReview(review.run.id)
  if (!('id' in held)) throw new Error(held.message)
  const subject = await h.service.captureWorkSubject(change.id)
  await h.service.saveWorkEvidence('log-1', 'built')
  const current = h.store.work.change(change.id)!
  return { change, subject, current, review: h.store.work.run(review.run.id)! }
}

describe('C backend rework', () => {
  it('lets a same-timestamp v-10 rework or unverified result supersede v-9', async () => {
    const h = harness()
    try {
      const { change, subject, current, review } = await heldReview(h)
      for (let n = 0; n < 8; n += 1) {
        const filler = await h.service.recordWorkVerification(change.id, [], [], { inputRef: current.currentInputRef, inputRevision: current.currentRevision })
        if (!('id' in filler)) throw new Error(filler.message)
      }
      const accepted = await h.service.recordWorkVerification(change.id, [{ requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log-1'] }], [review.id], {
        inputRef: current.currentInputRef, inputRevision: current.currentRevision, reviewRunId: review.id, reviewerSessionId: review.sessionId, subject,
      })
      const blocked = await h.service.recordWorkVerification(change.id, [{ requirementRef: 'r1', applicability: 'applicable', verdict: 'fail', evidenceRefs: ['log-1'] }], [review.id], {
        inputRef: current.currentInputRef, inputRevision: current.currentRevision, reviewRunId: review.id, reviewerSessionId: review.sessionId, subject,
      })
      if (!('id' in accepted) || !('id' in blocked)) throw new Error('verification was not recorded')
      expect(accepted.id).toBe('v-9')
      expect(blocked.id).toBe('v-10')
      expect(blocked.verdict).toBe('rework')
      const result = await h.task.execute({
        action: 'accept', task_id: change.id, verification_id: accepted.id,
        expected_input_ref: current.currentInputRef, expected_input_revision: current.currentRevision, expected_subject_key: accepted.subjectKey,
      })
      expect(result).toContain('superseded')
      expect(h.store.work.change(change.id)?.closeout).toBeUndefined()
      expect(h.store.work.workView(change.id)?.status).toBe('rework')
      expect(h.store.work.workView(change.id)?.verification?.id).toBe('v-10')
    } finally { h.cleanup() }
  })

  it('lets a same-timestamp v-10 unverified result supersede v-9', async () => {
    const h = harness()
    try {
      const { change, subject, current, review } = await heldReview(h)
      for (let n = 0; n < 8; n += 1) {
        const filler = await h.service.recordWorkVerification(change.id, [], [], { inputRef: current.currentInputRef, inputRevision: current.currentRevision })
        if (!('id' in filler)) throw new Error(filler.message)
      }
      const older = await h.service.recordWorkVerification(change.id, [{ requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log-1'] }], [review.id], {
        inputRef: current.currentInputRef, inputRevision: current.currentRevision, reviewRunId: review.id, reviewerSessionId: review.sessionId, subject,
      })
      const unverified = await h.service.recordWorkVerification(change.id, [{ requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: [] }], [review.id], {
        inputRef: current.currentInputRef, inputRevision: current.currentRevision, reviewRunId: review.id, reviewerSessionId: review.sessionId, subject,
      })
      if (!('id' in older) || !('id' in unverified)) throw new Error('verification was not recorded')
      expect(unverified.id).toBe('v-10')
      expect(unverified.verdict).toBe('unverified')
      const again = await h.task.execute({
        action: 'accept', task_id: change.id, verification_id: older.id,
        expected_input_ref: current.currentInputRef, expected_input_revision: current.currentRevision, expected_subject_key: older.subjectKey,
      })
      expect(again).toContain('superseded')
      expect(h.store.work.workView(change.id)?.status).not.toBe('done')
    } finally { h.cleanup() }
  })

  it('tracks a launched run so completion, errors and tracked approvals reach dot', async () => {
    const h = harness({ scope: 'tracked' })
    try {
      await h.store.setDot({ dotSessionId: 'dot-session' })
      const reserved = await h.start.execute({ cwd: h.project, title: 'Ship', instruction: 'edit it', goal: 'land', access: 'write' }, h.exec)
      const runId = /reserved (run-\d+)/.exec(reserved)?.[1]
      const changeId = /on (c-\d+)/.exec(reserved)?.[1]
      expect(runId && changeId).toBeTruthy()
      expect(await h.task.execute({ action: 'baseline', task_id: changeId!, run_id: runId! })).toContain('baseline')
      const started = await h.start.execute({ task_id: changeId!, instruction: 'edit it', access: 'write' }, h.exec)
      expect(started).toContain(`started ${runId}`)
      const run = h.store.work.run(runId!)!
      expect(h.store.tracks(run.sessionId!)).toBe(true)
      await h.service.onTurnEnd(run.sessionId!)
      await h.service.onError(run.sessionId!, new Error('compiler failed'))
      await h.service.flushNotices()
      expect(h.relays.map(item => item.text).join('\n')).toContain(`${run.id} input ${run.inputRef}@${run.inputRevision}`)
      expect(h.relays.map(item => item.text).join('\n')).toContain('compiler failed')
      expect(h.service.relayRequest({ kind: 'approval', sessionId: run.sessionId!, subject: 'write' }).decided).toBe('pending')
      await expect(h.service.archive(run.sessionId!)).rejects.toThrow(/archive it after it stops/)
      const finished = await h.service.finishWorkRun(run.id, 'completed')
      if (!finished.ok) throw new Error(finished.message)
      expect(await h.service.archive(run.sessionId!)).toBe(`Archived ${run.sessionId}.`)
    } finally { h.cleanup() }
  })

  it('restores the model, preset, permission and user-session gates', async () => {
    const sessions = [{ sessionId: 'human-running', cwd: '', running: true }]
    const blocked = harness({ taskModels: { mode: 'allow', list: [] }, taskPermission: 'danger-full-access' }, { sessions })
    sessions[0]!.cwd = blocked.project
    try {
      const looked = await blocked.start.execute({ cwd: blocked.project, title: 'Ship', instruction: 'edit', check_only: true, access: 'write' }, blocked.exec)
      expect(blocked.calls.filter(call => call === 'listSessions').length).toBeGreaterThan(0)
      expect(looked).toContain('human-running')
      expect(looked).not.toBe('Directory lock is available.')
      const preset = await blocked.start.execute({ cwd: blocked.project, title: 'Ship', instruction: 'edit', preset: 'unlisted-preset', access: 'write' }, blocked.exec)
      expect(preset).toContain('Error [dot/unknown-preset]')
      const model = await blocked.start.execute({ cwd: blocked.project, title: 'Ship', instruction: 'edit', model: 'forbidden/model', preset: 'standard', access: 'write' }, blocked.exec)
      expect(model).toContain('Error [dot/model-not-allowed]')
      expect(blocked.calls.some(call => call.startsWith('create '))).toBe(false)
      expect(blocked.calls).not.toContain('prompt')
    } finally { blocked.cleanup() }

    const allowed = harness({ taskModels: { mode: 'allow', list: ['p/ok'] }, taskPermission: 'danger-full-access' })
    try {
      const reserved = await allowed.start.execute({ cwd: allowed.project, title: 'Ship', instruction: 'edit', goal: 'land', model: 'p/ok', preset: 'ptc', access: 'write' }, allowed.exec)
      const runId = /reserved (run-\d+)/.exec(reserved)?.[1]
      const changeId = /on (c-\d+)/.exec(reserved)?.[1]
      expect(await allowed.task.execute({ action: 'baseline', task_id: changeId!, run_id: runId! })).toContain('baseline')
      const started = await allowed.start.execute({ task_id: changeId!, instruction: 'edit', model: 'p/ok', preset: 'ptc', access: 'write' }, allowed.exec)
      expect(started).toContain(`started ${runId}`)
      expect(allowed.selected.some(call => call.endsWith('p/ok'))).toBe(true)
      expect(allowed.writable).toContain('danger-full-access')
      expect(allowed.calls.some(call => call.includes('preset=ptc') || call.endsWith(' ptc'))).toBe(true)
      expect(allowed.store.work.run(runId!)?.expectedPreset).toBe('ptc')
    } finally { allowed.cleanup() }
  })

  it('exposes steps, input history, behavior, concurrency and pause or cancel', async () => {
    const h = harness()
    try {
      const created = JSON.parse(await h.task.execute({
        action: 'create', title: 'Ship', goal: 'land it', dir: h.project,
        steps: JSON.stringify([{ stepRef: 's1', text: 'edit a.ts' }]),
        behavior_notes: 'keep the tests', max_concurrent: 3,
      })) as { id: string }
      const read = JSON.parse(await h.task.execute({ action: 'read', task_id: created.id })) as { steps: Array<{ stepRef: string; text: string; done: boolean }>; behaviorNotes: string; maxConcurrentRuns: number; history: Array<{ id: string; revision: number }> }
      expect(read.steps).toEqual([expect.objectContaining({ stepRef: 's1', text: 'edit a.ts', done: false })])
      expect(read.behaviorNotes).toBe('keep the tests')
      expect(read.maxConcurrentRuns).toBe(3)
      const revised = JSON.parse(await h.task.execute({ action: 'revise', task_id: created.id, goal: 'land it later' })) as { revision: number }
      expect(revised.revision).toBe(2)
      const history = JSON.parse(await h.task.execute({ action: 'read', task_id: created.id })) as { history: Array<{ id: string; goal: string }> }
      expect(history.history).toHaveLength(2)
      const older = JSON.parse(await h.task.execute({ action: 'read', task_id: created.id, input_ref: history.history[0]!.id })) as { goal: string; revision: number }
      expect(older.goal).toBe('land it')
      expect(older.revision).toBe(1)
      expect(await h.task.execute({ action: 'pause', task_id: created.id })).toContain(`paused ${created.id}`)
      expect(await h.task.execute({ action: 'reserve', task_id: created.id, role: 'work', access: 'write' })).toContain('Error')
      expect(await h.task.execute({ action: 'resume', task_id: created.id })).toContain(`open ${created.id}`)
      const reserved = JSON.parse(await h.task.execute({ action: 'reserve', task_id: created.id, role: 'work', access: 'read', step_refs: JSON.stringify(['s1']) })) as { runId: string }
      const current = h.store.work.change(created.id)!
      expect(await h.task.execute({ action: 'step', task_id: created.id, step_ref: 's1', run_id: reserved.runId, expected_input_revision: current.currentRevision })).toContain('Error')
      expect(JSON.parse(await h.task.execute({ action: 'read', task_id: created.id })).steps[0].done).toBe(false)
      expect(h.store.work.change(created.id)?.currentRevision).toBe(current.currentRevision)
      expect(await h.task.execute({ action: 'cancel', task_id: created.id })).toContain(`cancelled ${created.id}`)
      expect(h.store.work.change(created.id)?.control).toBe('cancelled')
      await expect(h.service.manageTask({ action: 'move', task_id: created.id, to: 'done', reason: 'no' })).rejects.toMatchObject({ code: 'dot/legacy-closed' })
      await expect(h.service.manageTask({ action: 'note', task_id: created.id, role: 'review', summary: 'no' })).rejects.toMatchObject({ code: 'dot/legacy-closed' })
      await expect(h.service.manageTask({ action: 'delete', task_id: created.id })).rejects.toMatchObject({ code: 'dot/legacy-closed' })
      expect(h.task.description).toContain('action=decide asks the user to look')
      expect(h.task.description).not.toContain('decide: pass accepts')
    } finally { h.cleanup() }
  })

  it('keeps an unrelated list moving while finish or the first prompt is waiting on the host', async () => {
    let releaseStop: (() => void) | undefined
    const stopping = harness({}, { stop: () => new Promise(resolve => { releaseStop = () => resolve({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true }) }) })
    try {
      const change = await stopping.service.createWorkChange({ title: 'Ship', cwd: stopping.project, goal: 'land', at: 1 })
      const reserved = await stopping.service.reserveWorkRun({
        changeId: change.id, kind: 'work', cwd: stopping.project, root: { workspaceRoot: stopping.project },
        writeScope: { kind: 'paths', paths: [{ path: join(stopping.project, 'a.ts'), type: 'file' }] }, at: 2,
      })
      if (!reserved.ok) throw new Error(reserved.message)
      await stopping.service.captureWorkBaseline(reserved.run.id)
      const launched = await stopping.service.launchWorkRun(reserved.run.id, 'edit')
      if (!launched.ok) throw new Error(launched.message)
      let listed = false
      const finishing = stopping.task.execute({ action: 'finish', task_id: change.id, run_id: reserved.run.id, verdict: 'pass' })
      for (let n = 0; n < 20 && !releaseStop; n += 1) await new Promise(resolve => setTimeout(resolve, 10))
      expect(releaseStop).toBeTypeOf('function')
      const listing = stopping.task.execute({ action: 'list' }).then(text => { listed = true; return text })
      const winner = await Promise.race([listing.then(() => 'listed'), new Promise(resolve => setTimeout(() => resolve('blocked'), 300))])
      expect(winner).toBe('listed')
      expect(listed).toBe(true)
      releaseStop?.()
      expect(await finishing).toContain(`completed ${reserved.run.id}`)
    } finally { stopping.cleanup() }

    let releasePrompt: (() => void) | undefined
    const starting = harness({}, { prompt: () => new Promise(resolve => { releasePrompt = resolve }) })
    try {
      const reserved = await starting.start.execute({ cwd: starting.project, title: 'Ship', instruction: 'edit', goal: 'land', access: 'write' }, starting.exec)
      const runId = /reserved (run-\d+)/.exec(reserved)?.[1]
      const changeId = /on (c-\d+)/.exec(reserved)?.[1]
      expect(await starting.task.execute({ action: 'baseline', task_id: changeId!, run_id: runId! })).toContain('baseline')
      const pending = starting.start.execute({ task_id: changeId!, instruction: 'edit', access: 'write' }, starting.exec)
      for (let n = 0; n < 20 && !releasePrompt; n += 1) await new Promise(resolve => setTimeout(resolve, 10))
      expect(releasePrompt).toBeTypeOf('function')
      const listed = await Promise.race([
        starting.task.execute({ action: 'list' }).then(() => 'listed'),
        new Promise(resolve => setTimeout(() => resolve('blocked'), 300)),
      ])
      expect(listed).toBe('listed')
      releasePrompt?.()
      expect(await pending).toContain(`started ${runId}`)
    } finally { starting.cleanup() }
  })
})
