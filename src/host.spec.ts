import { describe, expect, it, vi } from 'vitest'
import { bindRunSession, finishWork, launchReservedRun } from './execution.ts'
import { bindHost } from './host.ts'
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
    expect(await host.verifyTaskPermission!('s', 'read', 'default')).toBe(true)
    policy = 'ask'
    expect(await host.verifyTaskPermission!('s', 'read', 'default')).toBe(false)
    mode = 'workspace-write'
    expect(await host.verifyTaskPermission!('s', 'write', 'default')).toBe(true)
    current = 'custom'
    expect(await host.verifyTaskPermission!('s', 'write', 'default')).toBe(false)
    expect(calls).toEqual([])
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
  it('checks the caller gate after resolving and before followup', async () => {
    let follows = 0
    const host = bindHost(name => name === 'agents' ? { get: () => undefined }
      : name === 'sessionController' ? { resolveAgent: async () => ({ agent: { followup: () => { follows += 1 } } }) } : undefined)
    await expect(host.relay('target', 'sender', 'late', 'd1', () => false)).rejects.toThrow('closed before followup')
    expect(follows).toBe(0)
  })
})

describe('writable task policy', () => {
  it('resolves the host default and reapplies its writable preset', async () => {
    const calls: string[] = []
    const session = {}
    const permissions = { defaultPreset: 'workspace-write', resolve: (name: string) => ({ sandbox: name }), set: (_session: unknown, name: string) => { calls.push(name) } }
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : name === 'permissionPresets' ? permissions : undefined)
    expect(await host.setWritable!('s', 'default')).toBe(true)
    expect(calls).toEqual(['workspace-write'])
  })
  it('rejects missing, read-only and failed presets', async () => {
    const session = {}
    const permissions = { defaultPreset: 'read-only', resolve: (name: string) => ({ sandbox: name }), set: () => { throw new Error('failed') } }
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : name === 'permissionPresets' ? permissions : undefined)
    expect(await host.setWritable!('s', 'default')).toBe(false)
    expect(await host.setWritable!('s', 'workspace-write')).toBe(false)
    const absent = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : undefined)
    expect(await absent.setWritable!('s', 'default')).toBe(false)
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
