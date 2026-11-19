/**
 * The registered verify tool must not treat a snapshot id as the delivery.
 * subject_ref loads the capture for this change and input; a trimmed object,
 * an older input, another run, or a missing required check is refused.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, TOOL } from './contracts.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { apply } from './tools.ts'

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dot-verify-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-verify-proj-'))
  writeFileSync(join(project, 'a.ts'), 'before')
  const store = new DotStore(undefined)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const sessions = new Map<string, { cwd?: string }>()
  const host = {
    isRunning: () => false,
    listModels: async () => ({ fallback: { provider: 'p', model: 'ok' }, models: [{ provider: 'p', model: 'ok', name: 'Ok' }] }),
    listPresets: async () => ({ fallback: 'standard', presets: [{ id: 'standard' }] }),
    listSessions: async () => [],
    readEvents: async () => [],
    latestReply: async () => '### Report\n- r1: a.ts now contains the edit\n- r2: pnpm test passed',
    findSession: async (id: string) => sessions.get(id),
    createSession: async (input: { sessionId?: string; cwd?: string }) => {
      const id = input.sessionId ?? `session-${sessions.size}`
      sessions.set(id, { cwd: input.cwd })
      return id
    },
    setWritable: async () => true,
    setReadOnly: async () => true,
    verifyTaskPermission: async () => true,
    prompt: async () => {},
    stopActivity: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }),
  }
  const notes = { path: join(home, 'memory.md'), read: async () => '', readCognition: async () => '' }
  const service = new DotService({
    host: host as never, store, homeDir: home, notes, approvalGraceMs: 0,
    timer: { set: () => 1, clear() {}, now: () => 1000 },
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
  const task = registered.find(row => row.name === TOOL.task) as {
    description: string
    parameters: { properties: Record<string, { description?: string }> }
    execute(args: Record<string, unknown>): Promise<string>
  }
  return { home, project, store, service, host, task, cleanup: () => { rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) } }
}

describe('closeout tool contract', () => {
  it('requires the current input and every requirement check, with notes recorded in the verification', async () => {
    const h = harness()
    try {
      const change = await h.service.createWorkChange({ title: 'Ship', cwd: h.project, goal: 'land', requirements: [{ requirementRef: 'R1', text: 'edit', required: true }, { requirementRef: 'R2', text: 'check', required: true }] })
      const started = await h.task.execute({ action: 'dispatch', task_id: change.id, instruction: 'edit', access: 'write', paths: JSON.stringify([{ path: 'a.ts', type: 'file' }]) })
      const runId = /started (run-\d+)/.exec(started)![1]!
      writeFileSync(join(h.project, 'a.ts'), 'after')
      await h.task.execute({ action: 'finish', task_id: change.id, run_id: runId })
      const current = h.store.work.change(change.id)!
      const base = { action: 'closeout', task_id: change.id, expected_input_ref: current.currentInputRef, expected_input_revision: current.currentRevision }
      await expect(h.task.execute(base)).rejects.toThrow(/requires checks/)
      await expect(h.task.execute({ ...base, checks: JSON.stringify([{ requirementRef: 'R1', applicability: 'required', verdict: 'pass', evidenceRefs: [`run:${runId}`] }]) })).rejects.toThrow(/applicability must be/)
      const checks = [{ requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: [`run:${runId}#r1`], note: 'edit verified' }, { requirementRef: 'R2', applicability: 'applicable', verdict: 'pass', evidenceRefs: [`run:${runId}#r2`, 'file:a.ts'], note: 'tests passed' }]
      await expect(h.task.execute({ ...base, checks: JSON.stringify(checks.slice(0, 1)) })).rejects.toThrow(/required R2 has no check/)
      await expect(h.task.execute({ ...base, checks: JSON.stringify(checks), expected_input_revision: current.currentRevision + 1 })).rejects.toThrow(/is not current/)
      await expect(h.task.execute({ ...base, checks: JSON.stringify([
        { requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: [`run:${runId}#r3`] },
        { requirementRef: 'R2', applicability: 'applicable', verdict: 'pass', evidenceRefs: [`run:${runId}`] },
      ]) })).rejects.toThrow(/no filled "### Report" bullet/)
      await expect(h.task.execute({ ...base, checks: JSON.stringify([
        { requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log-1'] },
        { requirementRef: 'R2', applicability: 'applicable', verdict: 'pass', evidenceRefs: [`run:${runId}`] },
      ]) })).rejects.toThrow(/must resolve/)
      await expect(h.task.execute({ ...base, checks: JSON.stringify([
        { requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['file:not-delivered.txt'] },
        { requirementRef: 'R2', applicability: 'applicable', verdict: 'pass', evidenceRefs: [`run:${runId}`] },
      ]) })).rejects.toThrow(/not in this delivery/)
      expect(h.store.work.latestVerification(change.id)).toBeUndefined()
      expect(await h.task.execute({ ...base, checks: JSON.stringify(checks) })).toContain('accepted')
      expect(h.store.work.latestVerification(change.id)?.checks).toMatchObject(checks)
      expect(h.service.workBoard(change.id)?.status).toBe('done')
      // finish captured the run's final report as the resolvable evidence body.
      expect(readFileSync(join(h.home, 'artifacts', 'evidence', `${runId}.md`), 'utf8')).toContain('- r1: a.ts now contains the edit')
    } finally { h.cleanup() }
  })

  it('refuses a run ref whose report could not be captured, after one closeout retry', async () => {
    const h = harness()
    try {
      let replies = 0
      h.host.latestReply = async () => { replies += 1; throw new Error('no reply') }
      const change = await h.service.createWorkChange({ title: 'Ship', cwd: h.project, goal: 'land', requirements: [{ requirementRef: 'R1', text: 'edit', required: true }] })
      const started = await h.task.execute({ action: 'dispatch', task_id: change.id, instruction: 'edit', access: 'write', paths: JSON.stringify([{ path: 'a.ts', type: 'file' }]) })
      const runId = /started (run-\d+)/.exec(started)![1]!
      writeFileSync(join(h.project, 'a.ts'), 'after')
      // finish still settles the run when the report cannot be captured.
      await h.task.execute({ action: 'finish', task_id: change.id, run_id: runId })
      const current = h.store.work.change(change.id)!
      const checks = [{ requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: [`run:${runId}`] }]
      await expect(h.task.execute({ action: 'closeout', task_id: change.id, expected_input_ref: current.currentInputRef, expected_input_revision: current.currentRevision, checks: JSON.stringify(checks) }))
        .rejects.toThrow(new RegExp(`no captured report for ${runId}`))
      // Once at finish, once on the closeout retry — never silently skipped.
      expect(replies).toBe(2)
      expect(h.store.work.latestVerification(change.id)).toBeUndefined()
    } finally { h.cleanup() }
  })
})
