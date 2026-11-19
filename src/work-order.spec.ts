/**
 * A work order carries scenarios, numbered constraints, step links, the human's
 * verbatim request and the deliverable language. The run's first prompt is
 * rendered from that input, not written by dot; dot's message is only notes.
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
  const home = mkdtempSync(join(tmpdir(), 'dot-order-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-order-proj-'))
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

describe('work order contract', () => {
  it('stores scenarios, constraints and step links, and refuses a broken contract', async () => {
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
      await expect(h.task.execute({
        action: 'create', title: 'Nope', goal: 'nope', dir: h.project,
        constraints: JSON.stringify([{ constraintRef: 'k1', text: 'x' }, { constraintRef: 'k1', text: 'y' }]),
      })).rejects.toThrow(/constraintRef/)
      const read = JSON.parse(await h.task.execute({ action: 'read', task_id: created.id }))
      expect(read.userRequest).toBe('write the note')
      expect(read.deliverableLanguage).toBe('zh-CN')
      expect(read.constraints).toEqual([{ constraintRef: 'k1', text: 'do not add files' }])
      expect(read.requirements[0].scenarios[0].scenarioRef).toBe('R1.a')
      expect(read.steps[0].covers).toEqual(['R1.a'])
      await expect(h.task.execute({
        action: 'revise', task_id: created.id,
        steps: JSON.stringify([
          { stepRef: 's1', text: 'a', after: ['s2'], covers: ['R1'] },
          { stepRef: 's2', text: 'b', after: ['s1'] },
        ]),
      })).rejects.toThrow(/step order cycles/)
      expect(h.store.work.change(created.id)?.currentRevision).toBe(1)
    } finally { h.cleanup() }
  })

  it('renders the run brief from the input and appends dot notes', async () => {
    const h = harness()
    try {
      const created = JSON.parse(await h.task.execute({
        action: 'create', title: 'Ship', goal: 'land it', dir: h.project,
        user_request: '  write the note\n\n```code```  ',
        constraints: JSON.stringify([{ constraintRef: 'k1', text: 'do not add files' }]),
        requirements: JSON.stringify([{
          requirementRef: 'R1', text: 'note exists', required: true,
          scenarios: [{ scenarioRef: 'R1.a', when: 'the file is read', then: 'it says hi' }],
        }]),
        steps: JSON.stringify([{ stepRef: 's1', text: 'write note', covers: ['R1.a'] }]),
      })) as { id: string }
      const dispatched = await h.task.execute({
        action: 'dispatch', task_id: created.id, instruction: 'start with the note', role: 'work', access: 'read',
      })
      const runId = /started (run-\d+)/.exec(dispatched)?.[1]
      expect(runId).toBeTruthy()
      const body = h.store.work.run(runId!)?.deliveries.find(item => item.kind === 'initial')?.contentRef ?? ''
      expect(body.startsWith('# Work order')).toBe(true)
      expect(body).toContain('## Notes from dot')
      expect(body).toContain('start with the note')
      expect(body).toContain('- R1: note exists')
      expect(body).toContain('  - R1.a: WHEN the file is read THEN it says hi')
      expect(body).toContain('- k1: do not add files')
      expect(body).toContain('- s1: write note → R1.a')
      expect(body).toContain('  write the note\n\n```code```  ')
      expect(body).toContain('- R1.a: <evidence')
      expect(body).not.toBe('start with the note')
      const run = h.store.work.run(runId!)!
      const sessionId = run.sessionId
      expect(h.store.task(sessionId!)?.title).toBe(`Ship · ${created.id}/${runId}`)
    } finally { h.cleanup() }
  })

  it('clears constraints with an explicit empty revision', async () => {
    const h = harness()
    try {
      const created = JSON.parse(await h.task.execute({
        action: 'create', title: 'Ship', goal: 'land', dir: h.project,
        constraints: JSON.stringify([{ constraintRef: 'k1', text: 'do not add files' }]),
      })) as { id: string }
      await expect(h.task.execute({ action: 'revise', task_id: created.id, constraints: '[bad' })).rejects.toThrow()
      expect(h.store.work.change(created.id)?.currentRevision).toBe(1)
      const cleared = JSON.parse(await h.task.execute({ action: 'revise', task_id: created.id, constraints: '[]' })) as { id: string }
      expect(cleared.id).toBe(created.id)
      expect(h.store.work.change(created.id)?.currentRevision).toBe(2)
      expect(h.store.work.input(h.store.work.change(created.id)!.currentInputRef)?.constraints).toEqual([])
    } finally { h.cleanup() }
  })
})
