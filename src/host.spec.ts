import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { SERVICE_NAME } from './contracts.ts'
import { bindRunSession, finishWork, launchReservedRun } from './execution.ts'
import { bindHost } from './host.ts'
import { apply as applyPlugin } from './index.ts'
import type { DotService } from './service.ts'
import type { DotDomainHandle } from './store.ts'
import { WorkBook, type WorkPersist } from './work.ts'

describe('running task permissions and relay', () => {
  it('verifies effective writable and read-only permissions without mutation', async () => {
    const session = {}
    let mode = 'read-only'
    let policy = 'never'
    let current = 'workspace-write'
    const calls: string[] = []
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) }
      : name === 'sandboxPolicy' ? { resolve: () => ({ mode }) }
      : name === 'approval' ? { overrideOf: () => policy }
      : name === 'permissionPresets' ? { defaultPreset: 'workspace-write', resolve: (preset: string) => ({ sandbox: preset }), current: () => current, set: () => calls.push('set') }
      : undefined)
    expect(await host.verifyTaskPermission!('s', 'read', 'workspace-write')).toBe(true)
    policy = 'ask'
    expect(await host.verifyTaskPermission!('s', 'read', 'workspace-write')).toBe(false)
    mode = 'workspace-write'
    expect(await host.verifyTaskPermission!('s', 'write', 'workspace-write')).toBe(true)
    current = 'custom'
    expect(await host.verifyTaskPermission!('s', 'write', 'workspace-write')).toBe(false)
    expect(await host.verifyCurrentWriteAccess!('s')).toBe(false)
    expect(calls).toEqual([])
  })
  it('treats a custom writable native preset as already writable', async () => {
    const session = {}
    let current = 'project-write'
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) }
      : name === 'permissionPresets' ? {
        resolve: (preset: string) => ({ sandbox: preset === 'project-write' ? 'workspace-write' : preset }),
        current: () => current,
        set: () => {},
      }
      : undefined)
    expect(await host.verifyTaskPermission!('s', 'write', 'workspace-write')).toBe(false)
    expect(await host.verifyCurrentWriteAccess!('s')).toBe(true)
    current = 'read-only'
    expect(await host.verifyCurrentWriteAccess!('s')).toBe(false)
  })
  it('relays through followup without steering or cancelling', async () => {
    const calls: string[] = []
    const agent = { followup: () => calls.push('followup'), steer: () => calls.push('steer'), cancel: () => calls.push('cancel') }
    const host = bindHost(name => name === 'agents' ? { get: () => agent } : undefined)
    await host.relay('target', 'sender', 'follow-up')
    expect(calls).toEqual(['followup'])
  })
  it('stores notice facts alongside relayed and carried user messages', async () => {
    const messages: unknown[] = []
    const agent = { status: 'idle', followup: (message: unknown) => messages.push(message) }
    const host = bindHost(name => name === 'agents' ? { get: () => agent } : undefined)
    const notice = { isReminder: false, entries: [{ kind: 'turn-end' as const, sessionId: 's', summary: 'done' }] }
    await host.relay('target', 'sender', 'notice copy', undefined, undefined, notice)
    await host.say('target', 'hello', '[dot notice] carried', undefined, undefined, notice)
    expect(messages[0]).toMatchObject({ source: { kind: 'agent-message', dshDot: { notices: notice } } })
    expect(messages[1]).toMatchObject({ source: { kind: 'user', dshDot: { carriedChars: 20, notices: notice } } })
  })
  it('saves uploaded files and carries file blocks through prompt admission', async () => {
    const messages: Array<{ content?: unknown }> = []
    const agent = { status: 'idle', followup: (message: unknown) => messages.push(message as { content?: unknown }) }
    const saved: Array<{ bytes: number; name?: string }> = []
    const admitted: unknown[] = []
    const ref = { attachmentId: 'att-1', name: 'notes.md', bytes: 5 }
    const host = bindHost(name => {
      if (name === 'agents') return { get: () => agent }
      if (name === 'attachments') return {
        async saveFile(input: { data: Uint8Array; name?: string }) {
          saved.push({ bytes: input.data.length, ...(input.name ? { name: input.name } : {}) })
          return ref
        },
        async admitPromptContent(parts: readonly unknown[]) {
          admitted.push(parts)
          return parts
        },
      }
      return undefined
    })
    await expect(host.attachFile('notes.md', Buffer.from('hello').toString('base64'))).resolves.toEqual(ref)
    expect(saved).toEqual([{ bytes: 5, name: 'notes.md' }])
    await host.say('target', '', undefined, undefined, undefined, undefined, [ref])
    expect(admitted).toEqual([[{ type: 'file', attachment: ref }]])
    expect(messages[0]?.content).toEqual([{ type: 'file', attachment: ref }])
    await expect(host.attachFile('bad.md', 'not canonical!')).rejects.toThrow()
  })

  it('checks the caller gate after resolving and before followup', async () => {
    let follows = 0
    const host = bindHost(name => name === 'agents' ? { get: () => undefined }
      : name === 'sessionController' ? { resolveAgent: async () => ({ agent: { followup: () => { follows += 1 } } }) } : undefined)
    await expect(host.relay('target', 'sender', 'late', 'd1', () => false)).rejects.toThrow('closed before followup')
    expect(follows).toBe(0)
  })
})

describe('writable task policy', () => {
  it('reapplies the configured writable preset', async () => {
    const calls: string[] = []
    const session = {}
    const permissions = { defaultPreset: 'workspace-write', resolve: (name: string) => ({ sandbox: name }), set: (_session: unknown, name: string) => { calls.push(name) } }
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : name === 'permissionPresets' ? permissions : undefined)
    expect(await host.setWritable!('s', 'workspace-write')).toBe(true)
    expect(calls).toEqual(['workspace-write'])
  })
  it('does not verify a native writable preset while Safe Auto overlay is still active', async () => {
    const session = { append() {} }
    let overlay = true
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) }
      : name === 'permissionPresets' ? { resolve: () => ({ sandbox: 'workspace-write' }), current: () => 'workspace-write', set: () => {} }
      : name === 'safeAutoRuntime' ? { sessionActive: () => overlay, selectSession: async () => true }
      : undefined)
    expect(await host.verifyTaskPermission!('s', 'write', 'workspace-write')).toBe(false)
    overlay = false
    expect(await host.verifyTaskPermission!('s', 'write', 'workspace-write')).toBe(true)
  })
  it('treats a live Safe Auto overlay as current write access', async () => {
    const session = { append() {} }
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) }
      : name === 'permissionPresets' ? { resolve: () => ({ sandbox: 'workspace-write' }), current: () => 'workspace-write', set: () => {} }
      : name === 'safeAutoRuntime' ? { sessionActive: () => true, selectSession: async () => true }
      : undefined)
    expect(await host.verifyTaskPermission!('s', 'write', 'workspace-write')).toBe(false)
    expect(await host.verifyCurrentWriteAccess!('s')).toBe(true)
  })
  it('rejects missing, read-only and failed presets', async () => {
    const session = {}
    const permissions = { defaultPreset: 'read-only', resolve: (name: string) => ({ sandbox: name }), set: () => { throw new Error('failed') } }
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : name === 'permissionPresets' ? permissions : undefined)
    expect(await host.setWritable!('s', 'workspace-write')).toBe(false)
    expect(await host.setWritable!('s', 'workspace-write')).toBe(false)
    const absent = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : undefined)
    expect(await absent.setWritable!('s', 'workspace-write')).toBe(false)
  })
})

describe('read-only task policy', () => {
  it('falls back to sandbox mode and disables approvals', async () => {
    const events: Array<{ type: string; data: unknown }> = []
    const session = { append: (type: string, data: unknown) => events.push({ type, data }) }
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : undefined)
    expect(await host.setReadOnly!('s')).toBe(true)
    expect(events).toEqual([{ type: 'sandbox/mode', data: { mode: 'read-only' } }, { type: 'approval/policy', data: { policy: 'never' } }])
  })
  it('uses the named preset when it actually selects read-only', async () => {
    const events: string[] = []
    const session = { append: (type: string) => events.push(type) }
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : name === 'permissionPresets' ? { resolve: () => ({ sandbox: 'read-only' }), set: () => events.push('preset') } : undefined)
    expect(await host.setReadOnly!('s')).toBe(true)
    expect(events).toEqual(['preset', 'approval/policy'])
  })
})

describe('rc.3 owned jobs', () => {
  function stopHost(jobs: { list: (caller?: string) => readonly { id: string; status: string; owner?: string }[]; kill?: (id: string, caller?: string) => void; wait?: (id: string, caller?: string) => Promise<unknown> }, events: { type: string; data?: { jobId?: string; owner?: string; producerReported?: boolean } }[] = [], state?: (request: { sessionId: string }, signal: AbortSignal) => Promise<{ queue?: unknown; running?: unknown; cursor?: unknown }>) {
    const calls: unknown[] = []
    const wrapped = {
      list(caller?: string) { calls.push(caller); return jobs.list(caller) },
      kill: jobs.kill,
      wait: jobs.wait,
    }
    const agent = { status: 'idle', cancel() {}, whenIdle: async () => {} }
    const host = bindHost(name => {
      if (name === 'jobs') return wrapped
      if (name === 'agents') return { get: () => agent }
      if (name === 'sessionController') return {
        async cancel() { return { accepted: true } },
        state: state ?? (async () => ({ queue: [], running: false, cursor: 1 })),
        async resolveAgent() { return { agent: { status: 'idle' } } },
      }
      if (name === 'sessionQuery') return { async readSession() { return { events } } }
      return undefined
    })
    return { host, calls }
  }

  it('reads ctx.jobs by session id and does not treat a bare completed status as settled', async () => {
    const listed = stopHost({ list: () => [{ id: 'bash-1', status: 'completed', owner: 'session-1' }] })
    const open = await listed.host.stopActivity!('session-1')
    expect(listed.calls).toEqual(['session-1', 'session-1'])
    expect(open.jobsSettled).toBe(false)
    const proved = stopHost(
      { list: () => [{ id: 'bash-1', status: 'completed', owner: 'session-1' }] },
      [{ type: 'job/settled', data: { jobId: 'bash-1', owner: 'session-1', producerReported: true } }],
    )
    expect((await proved.host.stopActivity!('session-1')).jobsSettled).toBe(true)
  })

  it('keeps a forced failure and a kill that throws', async () => {
    const forced = stopHost(
      { list: () => [{ id: 'bash-1', status: 'failed', owner: 'session-1' }] },
      [{ type: 'job/settled', data: { jobId: 'bash-1', owner: 'session-1', producerReported: false } }],
    )
    expect((await forced.host.stopActivity!('session-1')).jobsSettled).toBe(false)
    const thrown = stopHost({
      list: () => [{ id: 'bash-1', status: 'running', owner: 'session-1' }],
      kill() { throw new Error('producer still owns it') },
    })
    expect((await thrown.host.stopActivity!('session-1')).jobsSettled).toBe('unknown')
  })

  it('does not kill an unowned job, and a removed unsettled record still blocks', async () => {
    const killed: string[] = []
    const mixed = stopHost({
      list: () => [
        { id: 'unowned-job', status: 'running' },
        { id: 'bash-1', status: 'completed', owner: 'session-1' },
      ],
      kill(id) { killed.push(id) },
    }, [{ type: 'job/settled', data: { jobId: 'bash-1', owner: 'session-1', producerReported: true } }])
    expect((await mixed.host.stopActivity!('session-1')).jobsSettled).toBe(true)
    expect(killed).toEqual([])
    const removed = stopHost({ list: () => [] }, [
      { type: 'job/registered', data: { jobId: 'bash-1', owner: 'session-1' } },
      { type: 'job/settled', data: { jobId: 'bash-1', owner: 'session-1', producerReported: false } },
    ])
    expect((await removed.host.stopActivity!('session-1')).jobsSettled).toBe(false)
    const leftover = stopHost({ list: () => [] }, [
      { type: 'job/registered', data: { jobId: 'bash-2', owner: 'session-1' } },
    ])
    expect((await leftover.host.stopActivity!('session-1')).jobsSettled).toBe(false)
  })

  it('kills a live owned job and waits for the persisted settlement', async () => {
    let status = 'running'
    const events: { type: string; data?: { jobId?: string; owner?: string; producerReported?: boolean } }[] = []
    const waited = stopHost({
      list: () => [{ id: 'bash-1', status, owner: 'session-1' }],
      kill() { status = 'stopping' },
      async wait() {
        status = 'killed'
        events.push({ type: 'job/settled', data: { jobId: 'bash-1', owner: 'session-1', producerReported: true } })
        return { id: 'bash-1', status, owner: 'session-1' }
      },
    }, events)
    expect((await waited.host.stopActivity!('session-1')).jobsSettled).toBe(true)
    expect(waited.calls[0]).toBe('session-1')
  })

  it('passes an AbortSignal into the real state read', async () => {
    const seen: AbortSignal[] = []
    const host = stopHost({ list: () => [] }, [], (_request, signal) => {
      seen.push(signal)
      signal.throwIfAborted()
      return Promise.resolve({ queue: [], running: false, cursor: 1 })
    })
    expect((await host.host.stopActivity!('session-1')).queueCleared).toBe(true)
    expect((await host.host.watchSession!('session-1')).queue).toBe('empty')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(signal => signal instanceof AbortSignal)).toBe(true)
  })

  it('stays unknown when ctx.jobs is absent', async () => {
    const host = bindHost(name => {
      if (name === 'agents') return { get: () => ({ status: 'idle' }) }
      if (name === 'sessionController') return {
        async cancel() { return { accepted: true } },
        async state(_request: { sessionId: string }, signal: AbortSignal) {
          signal.throwIfAborted()
          return { queue: [], running: false }
        },
        async resolveAgent() { return { agent: { status: 'idle' } } },
      }
      return undefined
    })
    expect((await host.stopActivity!('session-1')).jobsSettled).toBe('unknown')
  })
})

describe('cold inactive session', () => {
  const inactive = { active: false, running: false, queue: null, cursor: 1 }
  const settled = { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }

  function coldHost(options: {
    state?: (read: number) => unknown
    agent?: unknown
    registry?: 'throw'
    beforeJobFacts?: () => void
    jobs?: 'absent' | { list: (caller?: string) => readonly { id?: string; status?: string; owner?: string }[] }
    events?: { type: string; data?: { jobId?: string; owner?: string; producerReported?: boolean } }[]
  } = {}) {
    let stateReads = 0
    const agent = options.agent
    if (agent) Object.assign(agent, { cancel() {} })
    const resolves: string[] = []
    const host = bindHost(name => {
      if (name === 'jobs') return options.jobs === 'absent' ? undefined : (options.jobs ?? { list: () => [] })
      if (name === 'agents') return {
        get() {
          if (options.registry === 'throw') throw new Error('registry down')
          return agent
        },
      }
      if (name === 'sessionController') return {
        async cancel() { return { accepted: true } },
        async state(_request: { sessionId: string }, signal: AbortSignal) {
          signal.throwIfAborted()
          stateReads += 1
          if (!options.state) return inactive
          return options.state(stateReads)
        },
        async resolveAgent() {
          resolves.push('resolve')
          return { error: { message: 'cold subagent cannot be resolved' } }
        },
      }
      if (name === 'sessionQuery') return { async readSession() { options.beforeJobFacts?.(); return { events: options.events ?? [] } } }
      return undefined
    })
    return { host, resolves, reads: () => stateReads }
  }

  it('accepts a registry-absent session only when active is strictly false', async () => {
    const released = coldHost()
    expect(await released.host.stopActivity!('session-1')).toMatchObject(settled)
    expect(released.resolves).toEqual([])

    expect(released.reads()).toBe(1)
  })

  it('does not accept a missing or true active flag', async () => {
    const missing = coldHost({ state: () => ({ running: false, queue: null }) })
    expect(await missing.host.stopActivity!('session-1')).toMatchObject({ queueCleared: false, idle: false, jobsSettled: true })
    const attached = coldHost({ state: () => ({ active: true, running: false, queue: null }) })
    expect(await attached.host.stopActivity!('session-1')).toMatchObject({ queueCleared: false, idle: false, jobsSettled: true })
    expect(missing.resolves).toEqual([])
    expect(attached.resolves).toEqual([])
  })

  it('does not accept a registry or state failure', async () => {
    const registry = coldHost({ registry: 'throw' })
    expect(await registry.host.stopActivity!('session-1')).toMatchObject({ queueCleared: false, idle: false })
    expect(registry.resolves).toEqual([])
    const unreadable = coldHost({ state: () => { throw new Error('state unreadable') } })
    expect(await unreadable.host.stopActivity!('session-1')).toMatchObject({ queueCleared: false, idle: false, jobsSettled: true })
    expect(unreadable.resolves).toEqual([])
  })

  it('does not accept running or a non-empty queue', async () => {
    const running = coldHost({ state: () => ({ active: false, running: true, queue: null }) })
    expect(await running.host.stopActivity!('session-1')).toMatchObject({ queueCleared: false, idle: false, jobsSettled: true })
    const queued = coldHost({ state: () => ({ active: false, running: false, queue: [{ id: 'still' }] }) })
    expect(await queued.host.stopActivity!('session-1')).toMatchObject({ queueCleared: false, idle: false, jobsSettled: true })
    expect(running.resolves).toEqual([])
    expect(queued.resolves).toEqual([])
  })

  it('keeps an unsettled or unknown owned job blocking', async () => {
    const busy = coldHost({ jobs: { list: () => [{ id: 'bash-1', status: 'running', owner: 'session-1' }] } })
    expect(await busy.host.stopActivity!('session-1')).toMatchObject({ idle: true, queueCleared: true, jobsSettled: false })
    const unknown = coldHost({ jobs: 'absent' })
    expect(await unknown.host.stopActivity!('session-1')).toMatchObject({ idle: true, queueCleared: true, jobsSettled: 'unknown' })
  })

  it('retains a writer scope until idle-status maintenance actually settles', async () => {
    const { work, run } = await activeRun(true)
    let finishMaintenance!: () => void
    const maintenance = new Promise<void>(resolve => { finishMaintenance = resolve })
    const agent = { status: 'idle', whenIdle: vi.fn(() => maintenance) }
    const h = coldHost({ agent, state: () => ({ active: true, running: false, queue: [] }) })
    const finishing = finishWork(work, bindRunSession(h.host), run.id, 'completed', 9)
    await vi.waitFor(() => expect(agent.whenIdle).toHaveBeenCalledOnce())
    expect(work.run(run.id)?.phase).toBe('settling')
    expect(work.occupying().map(row => row.id)).toContain(run.id)
    finishMaintenance()
    expect(await finishing).toMatchObject({ ok: true, phase: 'completed' })
    expect(work.occupying()).toEqual([])
  })

  it('finishes a cold session without resuming it and releases its scope', async () => {
    const { work, run } = await activeRun()
    const h = coldHost()
    expect(await finishWork(work, bindRunSession(h.host), run.id, 'completed', 9)).toMatchObject({ ok: true, phase: 'completed' })
    expect(work.occupying()).toEqual([])
    expect(h.resolves).toEqual([])
  })

  it.each(['running', 'queued', 'unreadable'] as const)('rechecks %s state after reading job settlement', async change => {
    let settled = false
    const agent = { status: 'idle' as 'idle' | 'running', whenIdle: () => Promise.resolve() }
    const h = coldHost({
      agent,
      beforeJobFacts() {
        settled = true
        if (change === 'running') agent.status = 'running'
      },
      state() {
        if (settled && change === 'unreadable') throw new Error('state lost during job settlement')
        return { active: true, running: agent.status === 'running', queue: settled && change === 'queued' ? [{ id: 'new-input' }] : [] }
      },
    })
    const report = await h.host.stopActivity!('session-1')
    expect(report.jobsSettled).toBe(true)
    if (change === 'queued') expect(report.queueCleared).toBe(false)
    else expect(report.idle).toBe(false)
    expect(h.resolves).toEqual([])
  })

  it('sees an owned job that appears while waiting for idle', async () => {
    const owned: { id: string; status: string; owner: string }[] = []
    const agent = {
      status: 'running' as 'running' | 'idle',
      whenIdle() {
        owned.push({ id: 'bash-late', status: 'running', owner: 'session-1' })
        agent.status = 'idle'
        return Promise.resolve()
      },
    }
    const host = coldHost({
      agent,
      jobs: { list: () => owned },
      state: () => ({ active: true, running: false, queue: [] }),
    })
    expect(await host.host.stopActivity!('session-1')).toMatchObject({ idle: true, queueCleared: true, jobsSettled: false })
  })
})

async function activeRun(write = false) {
  const persist: WorkPersist = async () => undefined
  const work = new WorkBook(persist, 'win32')
  const change = await work.createChange({ title: 'Ship', cwd: 'H:\\repo', goal: 'land it', at: 1 })
  const reserved = await work.reserveRun({ changeId: change.id, cwd: 'H:\\repo', root: { workspaceRoot: 'H:\\repo' }, writeScope: { kind: 'paths', paths: write ? [{ path: 'a.ts', type: 'file' }] : [] }, at: 2 })
  if (!reserved.ok) throw new Error(reserved.message)
  if (write) await work.publishBaseline(reserved.run.id, work.revision, 'base-1', 3)
  const started = await launchReservedRun(work, {
    async findSession() { return { cwd: 'H:\\repo', preset: 'standard' } },
    async createSession(input) { return { sessionId: input.sessionId, cwd: input.cwd } },
    async prepareAccess() { return 'ok' },
    async prompt() { return 'accepted' },
    async promptReceipts() { return 0 },
    async relay() { return 'accepted' },
    async relayInserts() { return 0 },
    async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
  }, reserved.run.id, 'start')
  if (!started.ok) throw new Error(started.message)
  const run = work.run(reserved.run.id)
  if (!run) throw new Error('run missing')
  return { work, run }
}

describe('live agent backfill and unified managed session event stream', () => {
  it('reads listLiveAgents via snapshotEvents or eventAt fallback and degrades silently on missing/throwing APIs', () => {
    const ev1 = { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } }
    const ev2 = { type: 'llm/retry', seq: 2, time: 2000, data: { retryId: 'r1', turn: 1, step: 1, provider: 'p', retry: 1, failure: { status: 429 } } }
    const host = bindHost(name => name === 'agents' ? {
      list: () => [
        { id: 's-snap', status: 'running', session: { id: 's-snap', snapshotEvents: () => [ev1, ev2] } },
        { id: 's-seq', status: 'idle', session: { id: 's-seq', seq: 2, eventAt: (seq: number) => [ev1, ev2][seq] } },
        { id: 's-throw', status: 'running', session: { id: 's-throw', snapshotEvents: () => { throw new Error('boom') } } },
      ],
    } : undefined)
    expect(host.listLiveAgents?.()).toEqual([
      { sessionId: 's-snap', status: 'running', events: [ev1, ev2] },
      { sessionId: 's-seq', status: 'idle', events: [ev1, ev2] },
      { sessionId: 's-throw', status: 'running', events: [] },
    ])

    expect(bindHost(() => undefined).listLiveAgents?.()).toEqual([])
    expect(bindHost(name => name === 'agents' ? {} : undefined).listLiveAgents?.()).toEqual([])
    expect(bindHost(name => name === 'agents' ? { list: () => { throw new Error('offline') } } : undefined).listLiveAgents?.()).toEqual([])
  })

  it('wires Cordis session/event, agent/created, backfill, managed scoping, and lifecycle clears through apply()', async () => {
    const tables: Record<string, Map<string, unknown>> = {
      state: new Map(), tasks: new Map(), tickets: new Map(), schedules: new Map(),
      recipes: new Map(), recipe_proposals: new Map(), proposals: new Map(),
      changes: new Map(), inputs: new Map(), runs: new Map(), verifications: new Map(),
      peers: new Map(), inbox: new Map(), links: new Map(),
    }
    const domain: DotDomainHandle = {
      table: name => ({
        entries: () => tables[name]!.entries(),
        get: key => tables[name]!.get(key),
        put: async (key, value) => { tables[name]!.set(key, value) },
        delete: async key => tables[name]!.delete(key),
      }),
      close: async () => {},
    }

    const ctx = new Context()
    new SessionStore(ctx)

    // Pre-existing managed session (seed backfill) and pre-existing unmanaged session
    const preRunSession = ctx.sessions.create(SessionId('run-pre'))
    preRunSession.append('turn/start', { turn: 1 })
    preRunSession.append('step/start', { turn: 1, step: 1 })
    preRunSession.append('llm/retry' as never, {
      retryId: 'r-pre', turn: 1, step: 1, provider: 'p', retry: 1, failure: { status: 429 },
    } as never)
    const preUnmanaged = ctx.sessions.create(SessionId('unmanaged-pre'))
    preUnmanaged.append('llm/retry' as never, {
      retryId: 'r-un', turn: 1, step: 1, provider: 'p', retry: 1, failure: { status: 429 },
    } as never)
    // Seed a started task in tables so run-pre is recognized as owned on startup
    tables.tasks!.set('run-pre', {
      sessionId: 'run-pre', origin: 'started', title: 'Pre Run', goal: 'g', cwd: '/', status: 'running', createdAt: 1, updatedAt: 1, unseenTurns: 0,
    })

    const liveAgents = new Map<string, { id: string; status: 'idle' | 'running'; session: unknown }>([
      ['run-pre', { id: 'run-pre', status: 'running', session: preRunSession }],
      ['unmanaged-pre', { id: 'unmanaged-pre', status: 'running', session: preUnmanaged }],
    ])

    let provided: DotService | undefined
    ctx.provide('storageDomain' as never, { open: async () => domain } as never)
    ctx.provide('sessionQuery' as never, { readSession: async () => ({ events: [] }) } as never)
    ctx.provide('sessionController' as never, { list: async () => ({ items: [] }) } as never)
    ctx.provide('workspaceRegistry' as never, { list: () => [] } as never)
    ctx.provide('agentPresets' as never, { register: async () => async () => {}, list: async () => [] } as never)
    ctx.provide('agents' as never, {
      get: (id: string) => liveAgents.get(id),
      list: () => [...liveAgents.values()],
    } as never)
    ctx.provide('agentDefaultModel' as never, { currentSelection: () => ({}) } as never)
    ctx.provide('connection' as never, { requestRejection: () => undefined } as never)
    ctx.provide('webServer' as never, { register: () => () => {} } as never)
    const origProvide = ctx.provide.bind(ctx)
    ctx.provide = ((key: string, value: unknown) => {
      if (key === SERVICE_NAME) provided = value as DotService
      return origProvide(key as never, value as never)
    }) as typeof ctx.provide

    await applyPlugin(ctx, { homeDir: join(tmpdir(), `dot-host-stream-${Date.now()}`) })
    expect(provided).toBeDefined()
    const service = provided!

    // Startup backfill restored managed run-pre and ignored unmanaged-pre
    expect(service.retryHealth.get('run-pre')?.kind).toBe('transient')
    expect(service.retryHealth.get('unmanaged-pre')).toBeUndefined()

    // Subscribe to unified managed session stream
    const received: string[] = []
    const unsub = service.subscribeManagedSessionEvents((sid, ev) => {
      received.push(`${sid}:${ev.type}`)
    })

    // Dynamic attachment via agent/created for a new started run
    const newRunSession = ctx.sessions.create(SessionId('run-dyn'))
    await service.store.track({
      sessionId: 'run-dyn', origin: 'started', title: 'Dyn', goal: 'g', cwd: '/', at: 10,
    })
    newRunSession.append('turn/start', { turn: 1 })
    newRunSession.append('step/start', { turn: 1, step: 1 })
    newRunSession.append('llm/retry' as never, {
      retryId: 'r-dyn', turn: 1, step: 1, provider: 'p', retry: 1, failure: { type: 'budget_exceeded' },
    } as never)
    liveAgents.set('run-dyn', { id: 'run-dyn', status: 'running', session: newRunSession })
    ;(ctx.emit as (name: string, ...args: unknown[]) => void)('agent/created', {
      agent: { id: 'run-dyn', status: 'running', session: newRunSession },
    })
    expect(service.retryHealth.get('run-dyn')?.kind).toBe('budget')

    // Live Cordis session/event updates managed session and skips unmanaged/watched sessions
    newRunSession.append('llm/retry-started' as never, { retryId: 'r-dyn', turn: 1, step: 1, retry: 1 } as never)
    preUnmanaged.append('llm/retry' as never, {
      retryId: 'r-un', turn: 1, step: 1, provider: 'p', retry: 2, failure: { status: 429 },
    } as never)
    expect(received).toContain('run-dyn:llm/retry-started')
    expect(received.some(item => item.startsWith('unmanaged-pre:'))).toBe(false)

    // agent/status -> idle clears run-pre
    ;(ctx.emit as (name: string, ...args: unknown[]) => void)('agent/status', {
      agent: { id: 'run-pre', status: 'idle', session: preRunSession },
      status: 'idle',
    })
    expect(service.retryHealth.get('run-pre')).toBeUndefined()

    // api-session/removed clears run-dyn even though origin is 'started' (not 'watched')
    ;(ctx.emit as (name: string, ...args: unknown[]) => void)('api-session/removed', 'run-dyn')
    expect(service.retryHealth.get('run-dyn')).toBeUndefined()

    // agent/disposed and workspace/session-archived clear retry health
    newRunSession.append('step/start', { turn: 1, step: 2 })
    newRunSession.append('llm/retry' as never, {
      retryId: 'r-dyn-2', turn: 1, step: 2, provider: 'p', retry: 1, failure: { status: 503 },
    } as never)
    expect(service.retryHealth.get('run-dyn')?.kind).toBe('transient')
    ;(ctx.emit as (name: string, ...args: unknown[]) => void)('agent/disposed', {
      agent: { id: 'run-dyn', session: newRunSession },
    })
    expect(service.retryHealth.get('run-dyn')).toBeUndefined()

    newRunSession.append('step/start', { turn: 1, step: 3 })
    newRunSession.append('llm/retry' as never, {
      retryId: 'r-dyn-3', turn: 1, step: 3, provider: 'p', retry: 1, failure: { status: 503 },
    } as never)
    expect(service.retryHealth.get('run-dyn')?.kind).toBe('transient')
    ;(ctx.emit as (name: string, ...args: unknown[]) => void)('workspace/session-archived', { sessionId: 'run-dyn' })
    expect(service.retryHealth.get('run-dyn')).toBeUndefined()

    unsub()
    await service.dispose()
    expect(service.retryHealth.list()).toEqual([])
  })

  it('skips dot-watchdog in listPresets and isolates createInternal model from Dorothy model', async () => {
    const createdArgs: Array<Record<string, unknown>> = []
    const host = bindHost(
      name => {
        if (name === 'agentPresets') {
          return {
            defaultId: 'standard',
            list: async () => [
              { id: 'standard', name: 'Standard' },
              { id: 'dot-reflection', name: 'Dot reflection' },
              { id: 'dot-watchdog', name: 'Dot watchdog' },
            ],
            resolve: async (id?: string) => ({ id: id ?? 'standard' }),
            mount: async () => {},
          }
        }
        if (name === 'agentDefaultModel') {
          return { currentSelection: () => ({ provider: 'host-prov', model: 'host-def' }) }
        }
        if (name === 'agents') {
          return {
            create: async (opts: Record<string, unknown>) => {
              createdArgs.push(opts)
              return { agent: { session: { id: opts.sessionId } }, dispose: async () => {} }
            },
          }
        }
        return undefined
      },
      undefined,
      () => ({ provider: 'dorothy-prov', model: 'dorothy-model' }),
    )

    const catalog = await host.listPresets()
    expect(catalog.presets.map(p => p.id)).toEqual(['standard'])

    const dir = join(tmpdir(), `dot-host-wd-${Date.now()}`)
    await host.createInternal(dir, 'dot-watchdog', { allow: [], model: null })
    const opts1 = createdArgs[0]!.agentOptions as { provider: string; model: string }
    expect(opts1.provider).toBe('host-prov')
    expect(opts1.model).toBe('host-def')

    await host.createInternal(dir, 'dot-watchdog', { allow: [], model: { provider: 'wd-prov', model: 'wd-model' } })
    const opts2 = createdArgs[1]!.agentOptions as { provider: string; model: string }
    expect(opts2.provider).toBe('wd-prov')
    expect(opts2.model).toBe('wd-model')
  })
})

describe('single-session lookup and session list caching', () => {
  it('uses a live session header before persistence or the corpus list', async () => {
    const host = bindHost(name => name === 'sessions'
      ? { get: (id: string) => id === 's-live' ? { header: { cwd: 'H:\\repo', agentPreset: 'standard' } } : undefined }
      : undefined)
    await expect(host.findSession('s-live')).resolves.toEqual({ cwd: 'H:\\repo', preset: 'standard' })
  })

  it('uses persistence stat for one stored session and treats undefined as absent', async () => {
    const stats: string[] = []
    const persistence = {
      stat: async (id: string, options?: { signal?: AbortSignal }) => {
        stats.push(`${id}:${options?.signal instanceof AbortSignal}`)
        return id === 's-old' ? { header: { cwd: 'H:\\old', agentPreset: 'standard' } } : undefined
      },
    }
    const host = bindHost(name => name === 'sessionPersistence' ? persistence : undefined)
    await expect(host.findSession('s-old')).resolves.toEqual({ cwd: 'H:\\old', preset: 'standard' })
    await expect(host.findSession('s-missing')).resolves.toBeUndefined()
    expect(stats).toEqual(['s-old:true', 's-missing:true'])
  })

  it('uses the corpus list fallback when the live registry misses and persistence is unavailable', async () => {
    let lists = 0
    const host = bindHost(name => {
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'sessionController') return { list: async () => { lists++; return { items: [{ sessionId: 's-list', cwd: 'H:\\list', agentPreset: 'standard' }] } } }
      return undefined
    })
    await expect(host.findSession('s-list')).resolves.toEqual({ cwd: 'H:\\list', preset: 'standard' })
    await expect(host.findSession('s-absent')).resolves.toBeUndefined()
    expect(lists).toBe(2)
  })

  it('shares an in-flight corpus list and caches mapped rows briefly', async () => {
    let lists = 0
    const host = bindHost(name => {
      if (name === 'sessionController') return {
        list: async () => {
          lists++
          await new Promise(resolve => setTimeout(resolve, 5))
          return { items: [{ sessionId: 's', cwd: 'H:\\repo', running: false, updatedAt: 1 }] }
        },
      }
      if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
      return undefined
    })
    const [a, b] = await Promise.all([
      host.listSessions(AbortSignal.timeout(1_000)),
      host.listSessions(AbortSignal.timeout(1_000)),
    ])
    expect(a).toHaveLength(1)
    expect(b).toBe(a)
    await host.listSessions(AbortSignal.timeout(1_000))
    expect(lists).toBe(1)
    await expect(host.listSessions(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reads archived ids after the corpus list and refreshes the cache after createSession', async () => {
    const events: string[] = []
    let lists = 0
    const host = bindHost(name => {
      if (name === 'sessionController') return {
        list: async () => { events.push('list'); lists++; return { items: [{ sessionId: 's', cwd: 'H:\\repo', running: false, updatedAt: 1 }] } },
        create: async () => ({ sessionId: 'created' }),
      }
      if (name === 'workspaceRegistry') return {
        get archivedSessionIds() { events.push('archived'); return [] },
      }
      return undefined
    })
    await host.listSessions(AbortSignal.timeout(1_000))
    await host.listSessions(AbortSignal.timeout(1_000))
    expect(lists).toBe(1)
    expect(events.slice(0, 2)).toEqual(['list', 'archived'])
    await host.createSession({ cwd: 'H:\\repo' })
    await host.listSessions(AbortSignal.timeout(1_000))
    expect(lists).toBe(2)
  })


  it('fresh listings bypass the cache and an invalidated flight cannot rewrite it', async () => {
    let lists = 0
    let running = false
    const host = bindHost(name => {
      if (name === 'sessionController') return {
        list: async () => { lists++; return { items: [{ sessionId: 's', cwd: 'H:\repo', running, updatedAt: 1 }] } },
        create: async () => ({ sessionId: 'created' }),
      }
      if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
      return undefined
    })
    expect((await host.listSessions(AbortSignal.timeout(1_000)))[0]?.running).toBe(false)
    running = true
    expect((await host.listSessions(AbortSignal.timeout(1_000)))[0]?.running).toBe(false)
    expect((await host.listSessions(AbortSignal.timeout(1_000), { fresh: true }))[0]?.running).toBe(true)
    expect(lists).toBe(2)

    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    let slowLists = 0
    const slow = bindHost(name => {
      if (name === 'sessionController') return {
        list: async () => { slowLists++; if (slowLists === 1) await gate; return { items: [] } },
        create: async () => ({ sessionId: 'created' }),
      }
      if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
      return undefined
    })
    const first = slow.listSessions(AbortSignal.timeout(1_000))
    await new Promise(done => setTimeout(done, 0))
    await slow.createSession({ cwd: 'H:\repo' })
    release()
    await first
    await slow.listSessions(AbortSignal.timeout(1_000))
    expect(slowLists).toBe(2)
  })

  it('archives a half-created dot session when agent creation fails', async () => {
    const archived: string[] = []
    const host = bindHost(name => {
      if (name === 'agents') return { create: async () => { throw new Error('mcp failed') } }
      if (name === 'workspaceRegistry') return { archiveSession: async (id: string, options: { stopActivity?: boolean }) => { archived.push(`${id}:${options.stopActivity}`) } }
      if (name === 'agentPresets') return { resolve: async (id: string) => ({ id }), mount: async () => {} }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    })
    await expect(host.createDot(join(tmpdir(), `dot-create-fail-${Date.now()}`), 'standard')).rejects.toThrow('mcp failed')
    expect(archived).toHaveLength(1)
    expect(archived[0]).toMatch(/^session-.*:true$/)
  })
})
