/**
 * A step is done only when this run has a readable result for its own input.
 * The accepted first prompt is the instruction, not that result.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256 } from './artifacts.ts'
import { DEFAULT_SETTINGS, TOOL } from './contracts.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { apply } from './tools.ts'

function harness(running = false) {
  const home = mkdtempSync(join(tmpdir(), 'dot-step-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-step-proj-'))
  writeFileSync(join(project, 'a.ts'), 'before')
  const store = new DotStore(undefined)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const events = new Map<string, unknown[]>()
  const sessions = new Map<string, { cwd?: string }>()
  const host = {
    isRunning: () => running,
    listSessions: async () => [],
    latestReply: async () => undefined,
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
    createSession: async (input: { sessionId?: string; cwd?: string }) => {
      const id = input.sessionId ?? `session-${sessions.size}`
      sessions.set(id, { cwd: input.cwd })
      return id
    },
    prompt: async () => {},
    relay: async () => {},
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
  const start = registered.find(row => row.name === TOOL.startTask) as { execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<string> }
  return {
    home, project, store, service, events, task, start, exec: { signal: new AbortController().signal },
    cleanup: () => { rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) },
  }
}

async function startedWrite(h: ReturnType<typeof harness>, scope: string) {
  const created = JSON.parse(await h.task.execute({
    action: 'create', title: 'Ship', goal: 'write result.txt', dir: h.project,
    steps: JSON.stringify([{ stepRef: 's1', text: 'write result.txt' }]),
  })) as { id: string }
  const reserved = JSON.parse(await h.task.execute({
    action: 'reserve', task_id: created.id, role: 'work', access: 'write', step_refs: JSON.stringify(['s1']),
    paths: JSON.stringify([{ path: scope, type: scope.endsWith('.ts') || scope.endsWith('.txt') ? 'file' : 'directory' }]),
  })) as { runId: string }
  expect(await h.task.execute({ action: 'baseline', task_id: created.id, run_id: reserved.runId })).toContain('baseline')
  const started = await h.start.execute({ task_id: created.id, run_id: reserved.runId, instruction: 'write result.txt', access: 'write' }, h.exec)
  expect(started).toContain(`started ${reserved.runId}`)
  return { changeId: created.id, runId: reserved.runId }
}

describe('step result ownership', () => {
  it('refuses a step while the run is active or failed and no result exists', async () => {
    const h = harness(true)
    try {
      const { changeId, runId } = await startedWrite(h, h.project)
      const current = h.store.work.change(changeId)!
      const sessionId = h.store.work.run(runId)?.sessionId
      expect(h.store.work.run(runId)?.phase).toBe('active')
      expect(h.service.host.isRunning(sessionId!)).toBe(true)
      expect(existsSync(join(h.project, 'result.txt'))).toBe(false)
      expect(await h.service.host.readEvents(sessionId!)).toEqual([])
      const missing = await h.task.execute({
        action: 'step', task_id: changeId, step_ref: 's1', run_id: runId, expected_input_revision: current.currentRevision,
      })
      expect(missing).toContain('Error')
      expect(JSON.parse(await h.task.execute({ action: 'read', task_id: changeId })).steps[0].done).toBe(false)
      const failed = await h.service.finishWorkRun(runId, 'failed')
      if (!failed.ok) throw new Error(failed.message)
      const again = await h.task.execute({
        action: 'step', task_id: changeId, step_ref: 's1', run_id: runId, expected_input_revision: current.currentRevision,
      })
      expect(again).toContain('Error')
      const step = JSON.parse(await h.task.execute({ action: 'read', task_id: changeId })).steps[0]
      expect(step.done).toBe(false)
      expect(step.subjectRef).toBeUndefined()
      const initial = h.store.work.run(runId)?.deliveries.find(item => item.kind === 'initial')?.contentRef ?? ''
      expect(initial.startsWith(`# Work order ${changeId}`)).toBe(true)
      expect(initial).toContain('## Notes from dot')
      expect(initial).toContain('write result.txt')
      expect(initial).not.toBe('write result.txt')
      const tracked = h.store.task(sessionId!)
      const bound = h.store.work.run(runId)!
      expect(tracked?.title).toBe(`Ship · ${changeId}/${runId}`)
      expect(tracked?.goal).toBe(`${bound.changeId} ${bound.id} input ${bound.inputRef}@${bound.inputRevision}`)
    } finally { h.cleanup() }
  })

  it('records a step only when the readable result belongs to that run and input', async () => {
    const h = harness()
    try {
      const owner = await startedWrite(h, join(h.project, 'result.txt'))
      const other = await startedWrite(h, join(h.project, 'a.ts'))
      writeFileSync(join(h.project, 'result.txt'), 'landed')
      const ownerRev = h.store.work.change(owner.changeId)!
      const otherRev = h.store.work.change(other.changeId)!
      const stolen = await h.task.execute({
        action: 'step', task_id: other.changeId, step_ref: 's1', run_id: other.runId, expected_input_revision: otherRev.currentRevision,
      })
      expect(stolen).toContain('Error')
      const done = await h.task.execute({
        action: 'step', task_id: owner.changeId, step_ref: 's1', run_id: owner.runId, expected_input_revision: ownerRev.currentRevision,
      })
      expect(done).toContain('step s1 done')
      const step = JSON.parse(await h.task.execute({ action: 'read', task_id: owner.changeId })).steps[0]
      expect(step).toMatchObject({ done: true, runId: owner.runId })
      expect(step.subjectRef).toContain('file:result.txt:')
      expect(step.subjectRef).not.toBe(h.store.work.run(owner.runId)?.deliveries[0]?.id)
      await h.task.execute({ action: 'revise', task_id: owner.changeId, goal: 'write result.txt later' })
      const revised = h.store.work.change(owner.changeId)!
      const stale = await h.task.execute({
        action: 'step', task_id: owner.changeId, step_ref: 's1', run_id: owner.runId, expected_input_revision: revised.currentRevision,
      })
      expect(stale).toContain('Error')
      expect(JSON.parse(await h.task.execute({ action: 'read', task_id: owner.changeId })).steps[0].done).toBe(false)
    } finally { h.cleanup() }
  })

  it('accepts a result event from this run and ignores another run\'s event', async () => {
    const h = harness()
    try {
      const created = JSON.parse(await h.task.execute({
        action: 'create', title: 'Read', goal: 'report', dir: h.project,
        steps: JSON.stringify([{ stepRef: 's1', text: 'report' }]), max_concurrent: 2,
      })) as { id: string }
      const first = JSON.parse(await h.task.execute({
        action: 'reserve', task_id: created.id, role: 'work', access: 'read', step_refs: JSON.stringify(['s1']),
      })) as { runId: string }
      const second = JSON.parse(await h.task.execute({
        action: 'reserve', task_id: created.id, role: 'work', access: 'read', step_refs: JSON.stringify(['s1']),
      })) as { runId: string }
      expect(await h.start.execute({ task_id: created.id, run_id: first.runId, instruction: 'report' }, h.exec)).toContain(`started ${first.runId}`)
      expect(await h.start.execute({ task_id: created.id, run_id: second.runId, instruction: 'report' }, h.exec)).toContain(`started ${second.runId}`)
      const current = h.store.work.change(created.id)!
      const quiet = await h.task.execute({
        action: 'step', task_id: created.id, step_ref: 's1', run_id: first.runId, expected_input_revision: current.currentRevision,
      })
      expect(quiet).toContain('Error')
      const firstSession = h.store.work.run(first.runId)?.sessionId
      const brief = h.store.work.run(first.runId)?.deliveries.find(item => item.kind === 'initial')?.contentRef
      h.events.set(firstSession!, [{ type: 'assistant/message', seq: 2, data: { message: { content: brief } } }])
      const echo = await h.task.execute({
        action: 'step', task_id: created.id, step_ref: 's1', run_id: first.runId, expected_input_revision: current.currentRevision,
      })
      expect(echo).toContain('Error')
      const sessionId = h.store.work.run(second.runId)?.sessionId
      h.events.set(sessionId!, [{ type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: 'reported the tree' }] } } }])
      const borrowed = await h.task.execute({
        action: 'step', task_id: created.id, step_ref: 's1', run_id: first.runId, expected_input_revision: current.currentRevision,
      })
      expect(borrowed).toContain('Error')
      const done = await h.task.execute({
        action: 'step', task_id: created.id, step_ref: 's1', run_id: second.runId, expected_input_revision: current.currentRevision,
      })
      expect(done).toContain('step s1 done')
      const step = JSON.parse(await h.task.execute({ action: 'read', task_id: created.id })).steps[0]
      expect(step.subjectRef).toContain(`event:${sessionId}:4:`)
      expect(step.runId).toBe(second.runId)
    } finally { h.cleanup() }
  })

  it('does not let a released run claim a file a later run wrote on the same path', async () => {
    const h = harness()
    try {
      const scope = join(h.project, 'result.txt')
      const first = await startedWrite(h, scope)
      const firstRev = h.store.work.change(first.changeId)!.currentRevision
      const stopped = await h.service.finishWorkRun(first.runId, 'completed')
      if (!stopped.ok) throw new Error(stopped.message)
      expect(h.store.work.run(first.runId)?.phase).toBe('completed')
      const absent = await h.task.execute({
        action: 'step', task_id: first.changeId, step_ref: 's1', run_id: first.runId, expected_input_revision: firstRev,
      })
      expect(absent).toContain('no result')

      const second = await startedWrite(h, scope)
      const body = 'produced only by B after A stopped'
      writeFileSync(scope, body)
      const borrowedHash = sha256(new TextEncoder().encode(body))
      const borrowed = await h.task.execute({
        action: 'step', task_id: first.changeId, step_ref: 's1', run_id: first.runId, expected_input_revision: firstRev,
      })
      expect(borrowed).toContain('no result')
      const firstStep = JSON.parse(await h.task.execute({ action: 'read', task_id: first.changeId })).steps[0]
      expect(firstStep.done).toBe(false)
      expect(firstStep.subjectRef).toBeUndefined()
      expect(JSON.stringify(firstStep)).not.toContain(borrowedHash)

      const secondRev = h.store.work.change(second.changeId)!.currentRevision
      const own = await h.task.execute({
        action: 'step', task_id: second.changeId, step_ref: 's1', run_id: second.runId, expected_input_revision: secondRev,
      })
      expect(own).toContain('step s1 done')
      const secondStep = JSON.parse(await h.task.execute({ action: 'read', task_id: second.changeId })).steps[0]
      expect(secondStep).toMatchObject({ done: true, runId: second.runId, subjectRef: `file:result.txt:${borrowedHash}` })
    } finally { h.cleanup() }
  })

  it('records a file result while that run still holds the path, and does not retarget it later', async () => {
    const h = harness()
    try {
      const scope = join(h.project, 'result.txt')
      const owner = await startedWrite(h, scope)
      const body = 'produced by the owner'
      writeFileSync(scope, body)
      const rev = h.store.work.change(owner.changeId)!.currentRevision
      expect(h.store.work.occupying().some(run => run.id === owner.runId)).toBe(true)
      const done = await h.task.execute({
        action: 'step', task_id: owner.changeId, step_ref: 's1', run_id: owner.runId, expected_input_revision: rev,
      })
      expect(done).toContain('step s1 done')
      const hash = sha256(new TextEncoder().encode(body))
      const step = JSON.parse(await h.task.execute({ action: 'read', task_id: owner.changeId })).steps[0]
      expect(step).toMatchObject({ done: true, runId: owner.runId, subjectRef: `file:result.txt:${hash}` })

      const finished = await h.service.finishWorkRun(owner.runId, 'completed')
      if (!finished.ok) throw new Error(finished.message)
      const later = 'produced only by the next run'
      const next = await startedWrite(h, scope)
      writeFileSync(scope, later)
      const current = h.store.work.change(owner.changeId)!.currentRevision
      const again = await h.task.execute({
        action: 'step', task_id: owner.changeId, step_ref: 's1', run_id: owner.runId, expected_input_revision: current,
      })
      expect(again).toContain('no result')
      const kept = JSON.parse(await h.task.execute({ action: 'read', task_id: owner.changeId })).steps[0]
      expect(kept.subjectRef).toBe(`file:result.txt:${hash}`)
      expect(kept.subjectRef).not.toContain(sha256(new TextEncoder().encode(later)))

      const nextRev = h.store.work.change(next.changeId)!.currentRevision
      const nextDone = await h.task.execute({
        action: 'step', task_id: next.changeId, step_ref: 's1', run_id: next.runId, expected_input_revision: nextRev,
      })
      expect(nextDone).toContain('step s1 done')
      const nextStep = JSON.parse(await h.task.execute({ action: 'read', task_id: next.changeId })).steps[0]
      expect(nextStep).toMatchObject({ done: true, runId: next.runId, subjectRef: `file:result.txt:${sha256(new TextEncoder().encode(later))}` })
    } finally { h.cleanup() }
  })

  it('stores the new input fields, refuses a bad contract, and dispatches the rendered brief', async () => {
    const h = harness()
    try {
      const created = JSON.parse(await h.task.execute({
        action: 'create', title: 'Ship', goal: 'land it', dir: h.project,
        user_request: 'write the note',
        deliverable_language: 'zh-CN',
        constraints: JSON.stringify([{ constraintRef: 'k1', text: 'do not add files' }]),
        requirements: JSON.stringify([{
          requirementRef: 'R1', text: 'note exists', required: true,
          scenarios: [{ scenarioRef: 'R1.a', when: 'the file is read', then: 'it says hi' }],
        }]),
        steps: JSON.stringify([{ stepRef: 's1', text: 'write note', covers: ['R1.a'] }]),
      })) as { id: string }
      expect(await h.task.execute({
        action: 'create', title: 'Nope', goal: 'nope', dir: h.project, constraints: '[]', behavior_notes: 'also',
      })).toContain('not both')
      const read = JSON.parse(await h.task.execute({ action: 'read', task_id: created.id }))
      expect(read.userRequest).toBe('write the note')
      expect(read.deliverableLanguage).toBe('zh-CN')
      expect(read.constraints).toEqual([{ constraintRef: 'k1', text: 'do not add files' }])
      expect(read.requirements[0].scenarios[0].scenarioRef).toBe('R1.a')
      expect(read.steps[0].covers).toEqual(['R1.a'])
      const revised = JSON.parse(await h.task.execute({ action: 'revise', task_id: created.id, goal: 'land it later' })) as { revision: number }
      expect(revised.revision).toBe(2)
      const carried = JSON.parse(await h.task.execute({ action: 'read', task_id: created.id }))
      expect(carried.goal).toBe('land it later')
      expect(carried.userRequest).toBe('write the note')
      expect(carried.constraints).toEqual([{ constraintRef: 'k1', text: 'do not add files' }])
      const cycle = await h.task.execute({
        action: 'revise', task_id: created.id,
        steps: JSON.stringify([
          { stepRef: 's1', text: 'a', after: ['s2'], covers: ['R1'] },
          { stepRef: 's2', text: 'b', after: ['s1'] },
        ]),
      })
      expect(cycle).toContain('step order cycles')
      expect(h.store.work.change(created.id)?.currentRevision).toBe(2)
      const dispatched = await h.task.execute({
        action: 'dispatch', task_id: created.id, instruction: 'start with the note', role: 'work', access: 'read',
      })
      const runId = /started (run-\d+)/.exec(dispatched)?.[1]
      expect(runId).toBeTruthy()
      const body = h.store.work.run(runId!)?.deliveries.find(item => item.kind === 'initial')?.contentRef ?? ''
      expect(body.startsWith('# Work order')).toBe(true)
      expect(body).toContain('## Notes from dot')
      expect(body).toContain('start with the note')
      expect(body).toContain('R1.a')
      expect(body).toContain('- k1: do not add files')
      expect(body).not.toBe('start with the note')
      const sessionId = h.store.work.run(runId!)?.sessionId
      const run = h.store.work.run(runId!)!
      expect(h.store.task(sessionId!)?.title).toBe(`Ship · ${created.id}/${runId}`)
      expect(h.store.task(sessionId!)?.goal).toBe(`${run.changeId} ${run.id} input ${run.inputRef}@${run.inputRevision}`)
    } finally { h.cleanup() }
  })
})
