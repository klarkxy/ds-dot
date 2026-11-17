/**
 * The registered verify tool must not treat a snapshot id as the delivery.
 * subject_ref loads the capture for this change and input; a trimmed object,
 * an older input, another run, or a missing required check is refused.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  return { home, project, store, service, task, cleanup: () => { rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) } }
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
      await expect(h.task.execute({ ...base, checks: JSON.stringify([{ requirementRef: 'R1', applicability: 'required', verdict: 'pass', evidenceRefs: ['event:session-run-1:7'] }]) })).rejects.toThrow(/applicability must be/)
      const checks = [{ requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['event:session-run-1:7'], note: 'edit verified' }, { requirementRef: 'R2', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['test:vitest:run-1'], note: 'tests passed' }]
      await expect(h.task.execute({ ...base, checks: JSON.stringify(checks.slice(0, 1)) })).rejects.toThrow(/required R2 has no check/)
      await expect(h.task.execute({ ...base, checks: JSON.stringify(checks), expected_input_revision: current.currentRevision + 1 })).rejects.toThrow(/is not current/)
      expect(h.store.work.latestVerification(change.id)).toBeUndefined()
      expect(await h.task.execute({ ...base, checks: JSON.stringify(checks) })).toContain('accepted')
      expect(h.store.work.latestVerification(change.id)?.checks).toMatchObject(checks)
      expect(h.service.workBoard(change.id)?.status).toBe('done')
    } finally { h.cleanup() }
  })
})
