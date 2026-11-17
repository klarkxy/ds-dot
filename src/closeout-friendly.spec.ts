/**
 * Closeout must name the input it read and pass explicit checks.
 * A summary does not pass items, and a rejected review of this input stays rejected.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, TOOL } from './contracts.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { apply } from './tools.ts'

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dot-closeout-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-closeout-proj-'))
  writeFileSync(join(project, 'doc.md'), 'old')
  const store = new DotStore(undefined)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const sessions = new Map<string, { cwd?: string }>()
  const host = {
    isRunning: () => false,
    listSessions: async () => [],
    titles: async () => new Map<string, string>(),
    latestReply: async () => 'done',
    readEvents: async () => [{ type: 'assistant/message', seq: 1, time: 1, data: { message: { content: 'done' } } }],
    modelKey: () => 'p/ok',
    syncModel: () => {},
    listWorkspaces: () => [],
    listModels: async () => ({ fallback: { provider: 'p', model: 'ok' }, models: [{ provider: 'p', model: 'ok', name: 'Ok' }] }),
    listPresets: async () => ({ fallback: 'standard', presets: [{ id: 'standard' }] }),
    selectModel: async () => {},
    setReadOnly: async () => true,
    setWritable: async () => true,
    verifyTaskPermission: async () => true,
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
  let clock = 1000
  const service = new DotService({
    host: host as never, store, homeDir: home,
    notes: { path: join(home, 'memory.md'), read: async () => '', readCognition: async () => '' },
    approvalGraceMs: 0,
    timer: { set: () => 1, clear: () => {}, now: () => clock },
    now: () => ++clock,
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
    home, project, store, service, task, start, exec,
    cleanup: () => { rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) },
  }
}

async function readInput(task: { execute(args: Record<string, unknown>): Promise<string> }, taskId: string) {
  const body = JSON.parse(await task.execute({ action: 'read', task_id: taskId })) as { inputRef: string; revision: number }
  return { expected_input_ref: body.inputRef, expected_input_revision: body.revision }
}

async function settleWriter(h: ReturnType<typeof harness>, taskId: string) {
  const started = await h.start.execute({
    task_id: taskId, instruction: 'edit doc.md', access: 'write', capture_baseline: true,
    paths: JSON.stringify([{ path: 'doc.md', type: 'file' }]),
  }, h.exec)
  const runId = /started (run-\d+)/.exec(started)?.[1]
  expect(runId, started).toBeTruthy()
  writeFileSync(join(h.project, 'doc.md'), 'new')
  expect(await h.task.execute({ action: 'finish', task_id: taskId, run_id: runId })).toContain(`completed ${runId}`)
  return runId!
}

describe('closeout binds the read version and explicit checks', () => {
  it('refuses a missing or stale input before writing evidence or stopping a review', async () => {
    const h = harness()
    try {
      const created = JSON.parse(await h.task.execute({
        action: 'create', title: 'Ship', goal: 'edit', dir: h.project,
        requirements: JSON.stringify([{ requirementRef: 'R1', text: 'edited', required: true }]),
      })) as { id: string }
      await settleWriter(h, created.id)
      const review = await h.start.execute({ task_id: created.id, role: 'review', instruction: 'look', capture_baseline: true }, h.exec)
      const reviewId = /started (run-\d+)/.exec(review)?.[1]
      expect(reviewId, review).toBeTruthy()
      const bare = await h.task.execute({
        action: 'closeout', task_id: created.id, evidence_ref: 'log', summary: 'looks done',
        checks: JSON.stringify([{ requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log'] }]),
      }).catch(error => { expect(error.code).toBe('dot/invalid'); return error.message as string })
      expect(bare).toContain('expected_input_ref')
      expect(existsSync(join(h.home, 'artifacts', 'evidence', 'log'))).toBe(false)
      expect(h.store.work.run(reviewId!)?.phase).not.toBe('settling')
      expect(h.store.work.change(created.id)?.closeout).toBeUndefined()
      const version = await readInput(h.task, created.id)
      const stale = await h.task.execute({
        action: 'closeout', task_id: created.id, ...version, expected_input_revision: version.expected_input_revision + 1,
        checks: JSON.stringify([{ requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log'] }]),
      }).catch(error => { expect(error.code).toBe('dot/invalid'); return error.message as string })
      expect(stale).toContain('is not current')
      expect(h.store.work.run(reviewId!)?.phase).not.toBe('settling')
    } finally { h.cleanup() }
  })

  it('does not turn a summary into passes, and still accepts an explicit goal check when there are no requirements', async () => {
    const h = harness()
    try {
      const started = await h.start.execute({
        cwd: h.project, title: 'Fix', goal: 'update doc', instruction: 'edit doc.md', access: 'write', capture_baseline: true,
        paths: JSON.stringify([{ path: 'doc.md', type: 'file' }]),
      }, h.exec)
      const changeId = /on (c-\d+)/.exec(started)?.[1]
      const runId = /started (run-\d+)/.exec(started)?.[1]
      expect(changeId && runId, started).toBeTruthy()
      writeFileSync(join(h.project, 'doc.md'), 'new')
      expect(await h.task.execute({ action: 'finish', task_id: changeId!, run_id: runId })).toContain(`completed ${runId}`)
      const version = await readInput(h.task, changeId!)
      const summarized = await h.task.execute({ action: 'closeout', task_id: changeId!, ...version, evidence_ref: 'doc-check', summary: 'updated' }).catch(error => { expect(error.code).toBe('dot/invalid'); return error.message as string })
      expect(summarized).toContain('requires checks')
      expect(h.store.work.change(changeId!)?.closeout).toBeUndefined()
      const failedGoal = await h.task.execute({
        action: 'closeout', task_id: changeId!, ...version, evidence_ref: 'doc-check', summary: 'updated',
        checks: JSON.stringify([{ requirementRef: 'goal', applicability: 'applicable', verdict: 'fail', evidenceRefs: ['doc-check'] }]),
      }).catch(error => { expect(error.code).toBe('dot/invalid'); return error.message as string })
      expect(failedGoal).toContain('explicit goal check')
      expect(h.store.work.latestVerification(changeId!)).toBeUndefined()
      const accepted = await h.task.execute({
        action: 'closeout', task_id: changeId!, ...version, evidence_ref: 'doc-check', summary: 'updated',
        checks: JSON.stringify([{ requirementRef: 'goal', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['doc-check'] }]),
      })
      expect(accepted).toContain(`accepted ${changeId}`)
      expect(h.store.work.workView(changeId!)?.status).toBe('done')
    } finally { h.cleanup() }
  })

  it('captures only the union of write scopes and permits unrelated files to change after verification', async () => {
    const h = harness()
    try {
      writeFileSync(join(h.project, 'other.txt'), 'unrelated original')
      const created = await h.service.createWorkChange({ title: 'Scoped', cwd: h.project, goal: 'edit doc', requirements: [{ requirementRef: 'R1', text: 'edited', required: true }] })
      const runId = await settleWriter(h, created.id)
      const subject = await h.service.captureWorkSubject(created.id)
      expect(subject.changes.map(item => item.path)).toEqual(['doc.md'])
      expect(subject.protectedDirty).not.toContain('other.txt')
      expect(subject.outOfScopePaths).toContain('other.txt')
      const current = h.store.work.change(created.id)!
      const verification = await h.service.recordWorkVerification(created.id, [{ requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['event:session-run-1:1'], note: 'doc.md contains the required edit' }], [runId], { inputRef: current.currentInputRef, inputRevision: current.currentRevision, subject })
      if (!('id' in verification)) throw new Error(verification.message)
      const human = { expectedInputRevision: current.currentRevision, expectedVerificationId: verification.id }
      writeFileSync(join(h.project, 'doc.md'), 'drifted')
      expect(await h.service.acceptWork(created.id, verification.id, current.currentInputRef, verification.subjectKey!, 'tool', human)).toMatchObject({ code: 'baseline' })
      writeFileSync(join(h.project, 'doc.md'), 'new')
      writeFileSync(join(h.project, 'other.txt'), 'changed by another writer')
      writeFileSync(join(h.project, 'later.txt'), 'another unrelated file')
      const accepted = await h.service.acceptWork(created.id, verification.id, current.currentInputRef, verification.subjectKey!, 'tool', human)
      expect(accepted).toHaveProperty('closeout')
      expect(h.service.workBoard(created.id)?.verification?.outOfScopePaths).toContain('other.txt')
      expect(h.store.work.workView(created.id)?.status).toBe('done')
    } finally { h.cleanup() }
  })

  it('keeps a user approval bound to the read version', async () => {
    const h = harness()
    try {
      const created = JSON.parse(await h.task.execute({
        action: 'create', title: 'Guarded', goal: 'edit', dir: h.project, human_review: true,
        requirements: JSON.stringify([{ requirementRef: 'R1', text: 'edited', required: true }]),
      })) as { id: string }
      await settleWriter(h, created.id)
      const version = await readInput(h.task, created.id)
      const checks = JSON.stringify([{ requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['r1-log'] }])
      const gate = await h.task.execute({ action: 'closeout', task_id: created.id, ...version, checks, evidence_ref: 'r1-log', summary: 'seen' })
      const pendingId = /pending (\S+)/.exec(gate)?.[1]
      expect(pendingId, gate).toBeTruthy()
      await h.service.answerWorkReview(pendingId!, true)
      const skipped = await h.task.execute({ action: 'closeout', task_id: created.id, checks, evidence_ref: 'r1-log', summary: 'seen' }).catch(error => { expect(error.code).toBe('dot/invalid'); return error.message as string })
      expect(skipped).toContain('expected_input_ref')
      expect(h.store.work.change(created.id)?.closeout).toBeUndefined()
      const again = await readInput(h.task, created.id)
      const accepted = await h.task.execute({ action: 'closeout', task_id: created.id, ...again })
      expect(accepted).toContain(`accepted ${created.id}`)
    } finally { h.cleanup() }
  })

  it('does not accept the same input again after the review was rejected, even with passing checks', async () => {
    const h = harness()
    try {
      const created = JSON.parse(await h.task.execute({
        action: 'create', title: 'Reviewed', goal: 'edit', dir: h.project,
        requirements: JSON.stringify([{ requirementRef: 'R1', text: 'edited', required: true }]),
      })) as { id: string }
      await settleWriter(h, created.id)
      const review = await h.start.execute({ task_id: created.id, role: 'review', instruction: 'look', capture_baseline: true }, h.exec)
      const reviewId = /started (run-\d+)/.exec(review)?.[1]
      expect(reviewId, review).toBeTruthy()
      expect(h.store.work.run(reviewId!)?.phase).toBe('active')
      const version = await readInput(h.task, created.id)
      expect(await h.task.execute({ action: 'reject', task_id: created.id, review_run_id: reviewId, expected_input_revision: version.expected_input_revision })).toContain('rejected')
      const checks = JSON.stringify([{ requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['r1-log'] }])
      const again = await h.task.execute({
        action: 'closeout', task_id: created.id, ...version, checks, evidence_ref: 'r1-log', summary: 'same delivery',
      }).catch(error => { expect(error.code).toBe('dot/invalid'); return error.message as string })
      expect(again).toContain(`${reviewId} rejected this delivery`)
      expect(h.store.work.change(created.id)?.closeout).toBeUndefined()
      expect(h.store.work.change(created.id)?.control).toBe('open')
      expect(h.store.work.latestVerification(created.id)).toBeUndefined()
    } finally { h.cleanup() }
  })

  it('accepts the same input after a rework run settles following the rejection', async () => {
    const h = harness()
    try {
      const created = JSON.parse(await h.task.execute({
        action: 'create', title: 'Reworked', goal: 'edit', dir: h.project,
        requirements: JSON.stringify([{ requirementRef: 'R1', text: 'edited', required: true }]),
      })) as { id: string }
      await settleWriter(h, created.id)
      const review = await h.start.execute({ task_id: created.id, role: 'review', instruction: 'look', capture_baseline: true }, h.exec)
      const reviewId = /started (run-\d+)/.exec(review)?.[1]
      expect(reviewId, review).toBeTruthy()
      expect(h.store.work.run(reviewId!)?.phase).toBe('active')
      const version = await readInput(h.task, created.id)
      expect(await h.task.execute({ action: 'reject', task_id: created.id, review_run_id: reviewId, expected_input_revision: version.expected_input_revision })).toContain('rejected')
      const rework = await h.start.execute({
        task_id: created.id, role: 'rework', instruction: 'fix doc.md', access: 'write', capture_baseline: true,
        paths: JSON.stringify([{ path: 'doc.md', type: 'file' }]),
      }, h.exec)
      const reworkId = /started (run-\d+)/.exec(rework)?.[1]
      expect(reworkId, rework).toBeTruthy()
      writeFileSync(join(h.project, 'doc.md'), 'reworked')
      expect(await h.task.execute({ action: 'finish', task_id: created.id, run_id: reworkId })).toContain(`completed ${reworkId}`)
      const again = await readInput(h.task, created.id)
      expect(again).toEqual(version)
      const checks = JSON.stringify([{ requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['r1-log'] }])
      const accepted = await h.task.execute({
        action: 'closeout', task_id: created.id, ...again, checks, evidence_ref: 'r1-log', summary: 'reworked',
      })
      expect(accepted).toContain(`accepted ${created.id}`)
      expect(h.store.work.workView(created.id)?.status).toBe('done')
    } finally { h.cleanup() }
  })
})
