/**
 * A failed baseline capture releases only the reservation this start just created
 * and never launched. An already selected reservation stays. The change is not cancelled.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const mutate = vi.hoisted(() => ({ project: '' }))
vi.mock('./artifacts.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./artifacts.ts')>()
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  return {
    ...actual,
    saveSnapshot(...args: Parameters<typeof actual.saveSnapshot>) {
      const manifest = actual.saveSnapshot(...args)
      if (mutate.project) writeFileSync(join(mutate.project, 'doc.md'), 'mutated-after-snapshot')
      return manifest
    },
  }
})
import { DEFAULT_SETTINGS, TOOL } from './contracts.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { apply } from './tools.ts'

function harness(lookup: 'absent' | 'present' | 'throws' = 'absent') {
  const home = mkdtempSync(join(tmpdir(), 'dot-baseline-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-baseline-proj-'))
  writeFileSync(join(project, 'doc.md'), 'old')
  const store = new DotStore(undefined)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const sessions = new Map<string, { cwd?: string }>()
  const host = {
    isRunning: () => false,
    listSessions: async () => [],
    modelKey: () => 'p/ok',
    syncModel: () => {},
    listWorkspaces: () => [],
    listModels: async () => ({ fallback: { provider: 'p', model: 'ok' }, models: [{ provider: 'p', model: 'ok', name: 'Ok' }] }),
    listPresets: async () => ({ fallback: 'standard', presets: [{ id: 'standard' }] }),
    selectModel: async () => {},
    setReadOnly: async () => true,
    setWritable: async () => true,
    verifyTaskPermission: async () => true,
    findSession: async (id: string) => {
      if (lookup === 'throws') throw new Error('lookup down')
      if (lookup === 'present') return { cwd: project }
      return sessions.get(id)
    },
    createSession: async (input: { sessionId?: string; cwd?: string }) => {
      const id = input.sessionId ?? `session-${sessions.size}`
      sessions.set(id, { cwd: input.cwd })
      return id
    },
    prompt: async () => {},
    stopActivity: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }),
  }
  const service = new DotService({
    host: host as never, store, homeDir: home,
    notes: { path: join(home, 'memory.md'), read: async () => '', readCognition: async () => '' },
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
  const task = registered.find(row => row.name === TOOL.task) as { execute(args: Record<string, unknown>): Promise<string> }
  const start = registered.find(row => row.name === TOOL.startTask) as { execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<string> }
  return {
    home, project, store, task, start, exec: { signal: new AbortController().signal },
    cleanup: () => { rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) },
  }
}

const paths = JSON.stringify([{ path: 'doc.md', type: 'file' }])

describe('baseline capture failure cleans only a fresh unsent reservation', () => {

  it('releases a reservation this start created when capture throws, and leaves another change alone', async () => {
    const h = harness()
    try {
      mkdirSync(join(h.project, 'not-a-file'))
      const other = JSON.parse(await h.task.execute({ action: 'create', title: 'Other', goal: 'keep', dir: h.project })) as { id: string }
      const reserved = JSON.parse(await h.task.execute({
        action: 'reserve', task_id: other.id, role: 'work', access: 'write',
        paths: JSON.stringify([{ path: 'other.md', type: 'file' }]),
      })) as { runId: string }
      const failed = await h.start.execute({
        cwd: h.project, title: 'Bad scope', instruction: 'write', access: 'write', capture_baseline: true,
        paths: JSON.stringify([{ path: 'not-a-file', type: 'file' }]),
      }, h.exec)
      const runId = /baseline for (run-\d+)/.exec(failed)?.[1]
      const changeId = /on (c-\d+)/.exec(failed)?.[1]
      expect(failed).toContain('Error [dot/baseline]')
      expect(failed).toContain('was released')
      expect(failed).toContain('was not cancelled')
      expect(runId && changeId).toBeTruthy()
      expect(h.store.work.run(runId!)).toMatchObject({ phase: 'stopped', closeReason: 'unsent' })
      expect(h.store.work.occupying().some(run => run.id === runId)).toBe(false)
      expect(h.store.work.change(changeId!)?.control).toBe('open')
      expect(h.store.work.change(changeId!)?.closeout).toBeUndefined()
      expect(h.store.work.run(reserved.runId)?.phase).toBe('reserved')
      expect(h.store.work.change(other.id)?.control).toBe('open')
    } finally { h.cleanup() }
  })

  it('keeps an already selected reservation when publish refuses the baseline', async () => {
    const h = harness()
    try {
      const created = JSON.parse(await h.task.execute({ action: 'create', title: 'Retry', goal: 'edit', dir: h.project })) as { id: string }
      const reserved = JSON.parse(await h.task.execute({
        action: 'reserve', task_id: created.id, role: 'work', access: 'write', paths,
      })) as { runId: string }
      mutate.project = h.project
      const failed = await h.start.execute({
        task_id: created.id, run_id: reserved.runId, instruction: 'edit', access: 'write', capture_baseline: true, paths,
      }, h.exec)
      expect(failed).toContain('Error [dot/baseline]')
      expect(failed).toContain('already reserved')
      expect(failed).toContain('was not cancelled')
      expect(h.store.work.run(reserved.runId)?.phase).toBe('reserved')
      expect(h.store.work.run(reserved.runId)?.baselineRefs).toEqual([])
      expect(h.store.work.change(created.id)?.control).toBe('open')
      expect(h.store.work.occupying().map(run => run.id)).toEqual([reserved.runId])
    } finally { mutate.project = ''; h.cleanup() }
  })

  it('releases a new reservation when publish refuses, even if session lookup throws or a session id is already visible', async () => {
    const published = harness()
    try {
      mutate.project = published.project
      const failed = await published.start.execute({
        cwd: published.project, title: 'Publish refused', instruction: 'edit', access: 'write', capture_baseline: true, paths,
      }, published.exec)
      const runId = /baseline for (run-\d+)/.exec(failed)?.[1]
      const changeId = /on (c-\d+)/.exec(failed)?.[1]
      expect(failed).toContain('Error [dot/baseline]')
      expect(failed).toContain('was released')
      expect(failed).not.toContain('cancel it before reserving')
      expect(published.store.work.run(runId!)).toMatchObject({ phase: 'stopped', closeReason: 'unsent' })
      expect(published.store.work.change(changeId!)?.control).toBe('open')
    } finally { mutate.project = ''; published.cleanup() }

    for (const lookup of ['throws', 'present'] as const) {
      const h = harness(lookup)
      try {
        mkdirSync(join(h.project, 'not-a-file'))
        const failed = await h.start.execute({
          cwd: h.project, title: 'Lookup ignored', instruction: 'write', access: 'write', capture_baseline: true,
          paths: JSON.stringify([{ path: 'not-a-file', type: 'file' }]),
        }, h.exec)
        const runId = /baseline for (run-\d+)/.exec(failed)?.[1]
        const changeId = /on (c-\d+)/.exec(failed)?.[1]
        expect(failed).toContain('was released')
        expect(failed).toContain('was not cancelled')
        expect(h.store.work.run(runId!)).toMatchObject({ phase: 'stopped', closeReason: 'unsent' })
        expect(h.store.work.change(changeId!)?.control).toBe('open')
      } finally { h.cleanup() }
    }
  })
})
