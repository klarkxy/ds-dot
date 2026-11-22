/**
 * The model tool is the only new supplement entrance. These calls go through
 * the registered `dot_task` execute, then the existing supplement delivery.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderSupplement } from './brief.ts'
import { DEFAULT_SETTINGS, TOOL } from './contracts.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { apply } from './tools.ts'

interface RelayCall { sessionId: string; senderId: string; text: string; deliveryId?: string }

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'dot-supplement-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-supplement-proj-'))
  writeFileSync(join(project, 'a.ts'), 'before')
  const store = new DotStore(undefined)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const sessions = new Map<string, { cwd?: string }>()
  const events = new Map<string, unknown[]>()
  const relays: RelayCall[] = []
  const host = {
    isRunning: () => false,
    listSessions: async () => [],
    latestReply: async () => 'ok',
    readEvents: async (sessionId: string) => events.get(sessionId) ?? [],
    cancel: async () => {},
    archive: async () => {},
    modelKey: () => 'fake/model',
    syncModel: () => {},
    createWorkspace: async () => ({ id: 'ws-1', title: 'p', path: project }),
    listWorkspaces: () => [{ id: 'ws-1', title: 'p', path: project }],
    cwdOf: async () => project,
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
    relay: async (sessionId: string, senderId: string, text: string, deliveryId?: string) => {
      relays.push({ sessionId, senderId, text, deliveryId })
      const prior = events.get(sessionId) ?? []
      prior.push({
        type: 'agent/inbox/spliced',
        data: {
          inserted: [{
            id: `msg-${prior.length}`,
            source: { kind: 'agent-message', form: 'relay', senderSessionId: senderId, deliveryId },
            content: [{ type: 'text', text }],
          }],
        },
      })
      events.set(sessionId, prior)
    },
    stopActivity: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true }),
  }
  const notes = { path: '/dot/memory.md', text: '', cognition: '', read: async () => notes.text, readCognition: async () => notes.cognition }
  const service = new DotService({
    host: host as never, store, homeDir: home, notes, approvalGraceMs: 0,
    timer: { set: (cb, ms) => setTimeout(cb, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now() },
    now: () => 1000,
  })
  const registered: Array<Record<string, unknown>> = []
  apply({
    tools: {
      schemas: () => [],
      restrict: () => () => {},
      register(definition: Record<string, unknown>) { registered.push(definition); return () => {} },
    },
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    dot: service,
    effect(fn: () => unknown) { fn() },
  } as never)
  const task = registered.find(tool => tool.name === TOOL.task) as { description: string; parameters: { properties: Record<string, { enum?: string[] }> }; execute(args: Record<string, unknown>): Promise<string> }
  const send = registered.find(tool => tool.name === TOOL.sendToSession) as { description: string; execute(args: Record<string, unknown>): Promise<string> }
  return { home, project, store, service, relays, task, send }
}

async function activeRun(h: Awaited<ReturnType<typeof setup>>) {
  const change = await h.service.createWorkChange({ title: 'Ship', cwd: h.project, goal: 'land it', requirements: [{ requirementRef: 'r1', text: 'edits', required: true }], at: 1 })
  const reserved = await h.service.reserveWorkRun({
    changeId: change.id, kind: 'work', cwd: h.project, root: { workspaceRoot: h.project },
    writeScope: { kind: 'paths', paths: [{ path: join(h.project, 'a.ts'), type: 'file' }] }, at: 2,
  })
  if (!reserved.ok) throw new Error(reserved.message)
  await h.service.captureWorkBaseline(reserved.run.id)
  const launched = await h.service.launchWorkRun(reserved.run.id, 'edit it')
  if (!launched.ok) throw new Error(launched.message)
  await h.store.setDot({ dotSessionId: 'dot-session' })
  const current = h.store.work.change(change.id)!
  return { change, runId: reserved.run.id, current }
}

function contextDeliveries(h: Awaited<ReturnType<typeof setup>>, runId: string) {
  return (h.store.work.run(runId)?.deliveries ?? []).filter(item => item.kind !== 'initial')
}

describe('dot_task supplement', () => {
  it('describes supplement as a recorded delivery, not a revise or a dot_send', () => {
    const registered: Array<Record<string, unknown>> = []
    apply({
      tools: { schemas: () => [], restrict: () => () => {}, register(definition: Record<string, unknown>) { registered.push(definition); return () => {} } },
      on: () => () => {},
      systemPrompt: { section: () => () => {} },
      dot: {},
      effect(fn: () => unknown) { fn() },
    } as never)
    const task = registered.find(tool => tool.name === TOOL.task) as { description: string; parameters: { properties: { action: { enum: string[] } } } }
    const send = registered.find(tool => tool.name === TOOL.sendToSession) as { description: string }
    expect(task.parameters.properties.action.enum).toContain('supplement')
    expect(task.description).toContain('supplement delivers context once')
    expect(send.description).toContain('action=supplement')
    expect(send.description).toContain('refuses')
  })

  it('records pure context through the tool as one supplement delivery and does not revise', async () => {
    const h = await setup()
    try {
      const { change, runId, current } = await activeRun(h)
      const result = await h.task.execute({
        action: 'supplement', run_id: runId, message: 'the file is named a.ts',
        expected_input_ref: current.currentInputRef, expected_input_revision: current.currentRevision,
        goal: 'hijack the input', sender: 'forged',
      })
      const extra = contextDeliveries(h, runId)
      const rendered = renderSupplement({
        changeId: change.id, inputRef: current.currentInputRef, inputRevision: current.currentRevision, runId, message: 'the file is named a.ts',
      })
      expect(result).toContain(`supplemented ${runId}`)
      expect(result).not.toContain('Error')
      expect(extra).toHaveLength(1)
      expect(extra[0]).toMatchObject({
        kind: 'context', status: 'accepted', contentRef: rendered,
        source: 'dot-session', inputRevision: current.currentRevision,
      })
      expect(rendered.startsWith(`# Supplement · ${change.id} · ${current.currentInputRef} (rev ${current.currentRevision}) · ${runId}`)).toBe(true)
      expect(rendered).toContain('the file is named a.ts')
      expect(h.relays).toEqual([{ sessionId: h.store.work.run(runId)?.sessionId, senderId: 'dot-session', text: rendered, deliveryId: extra[0]!.id }])
      const after = h.store.work.change(change.id)!
      expect(after.currentRevision).toBe(current.currentRevision)
      expect(after.currentInputRef).toBe(current.currentInputRef)
      expect(h.store.work.input(after.currentInputRef)?.goal).toBe('land it')
    } finally {
      rmSync(h.project, { recursive: true, force: true })
      rmSync(h.home, { recursive: true, force: true })
    }
  })

  it('refuses an older named input and does not relay or revise', async () => {
    const h = await setup()
    try {
      const { change, runId, current } = await activeRun(h)
      await expect(h.task.execute({ action: 'supplement', run_id: runId, message: 'late note', expected_input_ref: current.currentInputRef, expected_input_revision: current.currentRevision - 1 })).rejects.toMatchObject({ code: 'dot/stale' })
      await expect(h.task.execute({ action: 'supplement', run_id: runId, message: 'other input', expected_input_ref: 'input-other', expected_input_revision: current.currentRevision })).rejects.toMatchObject({ code: 'dot/stale' })
      expect(h.relays).toEqual([])
      expect(contextDeliveries(h, runId)).toEqual([])
      expect(h.store.work.change(change.id)?.currentRevision).toBe(current.currentRevision)
    } finally {
      rmSync(h.project, { recursive: true, force: true })
      rmSync(h.home, { recursive: true, force: true })
    }
  })

  it('refuses the same run after the input is revised, and dot_send still does not deliver', async () => {
    const h = await setup()
    try {
      const { change, runId, current } = await activeRun(h)
      const revised = await h.task.execute({ action: 'revise', task_id: change.id, goal: 'a different outcome' })
      expect(revised).not.toContain('Error')
      const next = h.store.work.change(change.id)!
      expect(next.currentRevision).toBe(current.currentRevision + 1)
      await expect(h.task.execute({ action: 'supplement', run_id: runId, message: 'still the old run', expected_input_ref: current.currentInputRef, expected_input_revision: current.currentRevision })).rejects.toMatchObject({ code: 'dot/stale' })
      await expect(h.task.execute({ action: 'supplement', run_id: runId, message: 'new input on the old run', expected_input_ref: next.currentInputRef, expected_input_revision: next.currentRevision })).rejects.toMatchObject({ code: 'dot/stale' })
      expect(h.relays).toEqual([])
      expect(contextDeliveries(h, runId)).toEqual([])
      const sessionId = h.store.work.run(runId)?.sessionId ?? h.store.work.run(runId)?.requestedSessionId
      await expect(h.send.execute({ session_id: sessionId, message: 'bypass' })).rejects.toMatchObject({ code: 'dot/send-closed' })
      expect(h.relays).toEqual([])
      expect(contextDeliveries(h, runId)).toEqual([])
    } finally {
      rmSync(h.project, { recursive: true, force: true })
      rmSync(h.home, { recursive: true, force: true })
    }
  })
})
