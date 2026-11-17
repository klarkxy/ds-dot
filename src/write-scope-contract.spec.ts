/**
 * A writing run is refused at the tool call, with a copyable {path, type} example.
 * Relative and absolute paths of the same file are one scope. A read reservation is not started as write.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, TOOL } from './contracts.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { apply } from './tools.ts'

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dot-scope-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-scope-proj-'))
  const store = new DotStore(undefined)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const host = {
    isRunning: () => false,
    listSessions: async () => [],
    latestReply: async () => undefined,
    readEvents: async () => [],
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
    resumeDot: async () => true,
    findSession: async () => undefined,
    createSession: async (input: { sessionId?: string }) => input.sessionId ?? 'session-made',
    prompt: async () => {},
    relay: async () => {},
    stopActivity: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }),
  }
  const service = new DotService({
    host: host as never, store, homeDir: home,
    notes: { path: '/dot/memory.md', text: '', cognition: '', read: async () => '', readCognition: async () => '' },
    approvalGraceMs: 0,
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
  const task = registered.find(row => row.name === TOOL.task) as { description: string; parameters: { properties: Record<string, { description?: string }> }; execute(args: Record<string, unknown>): Promise<string> }
  const start = registered.find(row => row.name === TOOL.startTask) as { description: string; parameters: { properties: Record<string, { description?: string }> }; execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<string> }
  return {
    project, store, task, start, exec: { signal: new AbortController().signal },
    cleanup: () => { rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) },
  }
}

describe('write scope contract', () => {
  it('shows a copyable write example and refuses a read run that names paths', async () => {
    const h = harness()
    expect(h.start.description).toContain('[{"path":"site/note.txt","type":"file"}]')
    expect(h.start.parameters.properties.paths?.description).toContain('site/note.txt')
    expect(h.task.parameters.properties.access?.description).toContain('write')
    const created = JSON.parse(await h.task.execute({ action: 'create', title: 'Ship', goal: 'write note', dir: h.project })) as { id: string }
    const paths = JSON.stringify([{ path: 'site/note.txt', type: 'file' }])
    const refused = await h.start.execute({ task_id: created.id, instruction: 'write it', access: 'read', paths }, h.exec)
    expect(refused).toMatch(/Error \[dot\/invalid\]:[\s\S]*access must be "write"[\s\S]*site\/note\.txt/)
    const reserved = await h.task.execute({ action: 'reserve', task_id: created.id, role: 'work', access: 'read', paths })
    expect(reserved).toMatch(/access must be "write"/)
    expect(h.store.work.listRuns()).toEqual([])
    h.cleanup()
  })

  it('accepts an array of {path, type} and the same file written as a relative path', async () => {
    const h = harness()
    const file = join(h.project, 'site', 'note.txt')
    const created = JSON.parse(await h.task.execute({
      action: 'create', title: 'Ship', goal: 'write note', dir: h.project, max_concurrent: 2,
    })) as { id: string }
    const reserved = JSON.parse(await h.task.execute({
      action: 'reserve', task_id: created.id, role: 'work', access: 'write',
      paths: JSON.stringify([{ path: file, type: 'file' }]),
    })) as { runId: string }
    expect(h.store.work.run(reserved.runId)).toMatchObject({ access: 'write', writeScope: { kind: 'paths', paths: [{ path: file, type: 'file' }] } })
    const continued = await h.start.execute({
      task_id: created.id, run_id: reserved.runId, instruction: '', access: 'write',
      paths: JSON.stringify([{ path: 'site/note.txt', type: 'file' }]),
    }, h.exec)
    expect(continued).toContain(reserved.runId)
    expect(h.store.work.run(reserved.runId)?.phase).toBe('reserved')
    const bare = await h.start.execute({
      task_id: created.id, instruction: '', access: 'write',
      paths: JSON.stringify(['site/note.txt']),
    }, h.exec)
    expect(bare).toMatch(/site\/note\.txt/)
    expect(h.store.work.listRuns()).toHaveLength(1)
    h.cleanup()
  })

  it('does not start a read-only reservation as write, and does not let that reservation block another write scope', async () => {
    const h = harness()
    const created = JSON.parse(await h.task.execute({
      action: 'create', title: 'Ship', goal: 'write note', dir: h.project, max_concurrent: 2,
    })) as { id: string }
    const reading = JSON.parse(await h.task.execute({ action: 'reserve', task_id: created.id, role: 'work', access: 'read' })) as { runId: string }
    const blocked = await h.start.execute({ task_id: created.id, run_id: reading.runId, instruction: 'write it', access: 'write' }, h.exec)
    expect(blocked).toMatch(/read-only[\s\S]*site\/note\.txt/)
    expect(h.store.work.run(reading.runId)?.phase).toBe('reserved')
    const writing = await h.start.execute({
      task_id: created.id, instruction: '', access: 'write',
      paths: JSON.stringify([{ path: 'site/note.txt', type: 'file' }]),
    }, h.exec)
    const writer = h.store.work.listRuns().find(run => run.id !== reading.runId)
    expect(writing).toContain(writer?.id)
    expect(writer).toMatchObject({ access: 'write', writeScope: { paths: [{ path: 'site/note.txt', type: 'file' }] } })
    expect(h.store.work.run(reading.runId)?.access).toBe('read')
    h.cleanup()
  })
})
