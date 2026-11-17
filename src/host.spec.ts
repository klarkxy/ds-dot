import { describe, expect, it } from 'vitest'
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
  it('unwraps an AgentHandle and does not treat a methodless registry object as absence', async () => {
    const calls: string[] = []
    const handled = bindHost(name => name === 'agents' ? {
      get: () => ({ agent: { followup: () => calls.push('followup'), status: 'idle' }, async dispose() {} }),
    } : undefined)
    await handled.relay('target', 'sender', 'follow-up')
    expect(calls).toEqual(['followup'])

    const host = bindHost(name => {
      if (name === 'jobs') return { list: () => [] }
      if (name === 'agents') return { get: () => ({ id: 'session-1' }) }
      if (name === 'sessionController') return {
        async cancel() { return { accepted: true } },
        async state() { return { queue: [], running: false, cursor: 1 } },
        async resolveAgent() { return { agent: { status: 'idle', whenIdle: () => Promise.resolve() } } },
      }
      if (name === 'sessionQuery') return { async readSession() { return { events: [] } } }
      return undefined
    })
    expect(await host.stopActivity!('session-1')).toMatchObject({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true })

    const gone = bindHost(name => {
      if (name === 'jobs') return { list: () => [] }
      if (name === 'agents') return { get: () => undefined }
      if (name === 'sessionController') return {
        async cancel() { return { accepted: true } },
        async state() { return { queue: [], running: false, cursor: 1 } },
        async resolveAgent() { return { error: { message: 'session-1 has no live agent' } } },
      }
      if (name === 'sessionQuery') return { async readSession() { return { events: [] } } }
      return undefined
    })
    expect(await gone.stopActivity!('session-1')).toMatchObject({ cancelAccepted: true, queueCleared: true, idle: false, jobsSettled: true })
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
    const host = bindHost(name => {
      if (name === 'jobs') return wrapped
      if (name === 'agents') return { get: () => ({ status: 'idle' }) }
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

  it('treats a turn as idle only after whenIdle, not from the queue snapshot', async () => {
    let reads = 0
    let status: 'running' | 'idle' = 'running'
    const host = bindHost(name => {
      if (name === 'jobs') return { list: () => [] }
      if (name === 'agents') return {
        get: () => ({
          get status() { return status },
          whenIdle: () => { status = 'idle'; return Promise.resolve() },
        }),
      }
      if (name === 'sessionController') return {
        async cancel() { return { accepted: true } },
        async state(_request: { sessionId: string }, signal: AbortSignal) {
          signal.throwIfAborted()
          reads += 1
          return { queue: [], running: reads < 3, cursor: 1 }
        },
      }
      if (name === 'sessionQuery') return { async readSession() { return { events: [] } } }
      return undefined
    })
    expect((await host.stopActivity!('session-1')).idle).toBe(true)

    let still = 0
    const busy = bindHost(name => {
      if (name === 'jobs') return { list: () => [] }
      if (name === 'agents') return {
        get: () => ({
          status: 'idle' as const,
          whenIdle: () => Promise.resolve(),
        }),
      }
      if (name === 'sessionController') return {
        async cancel() { return { accepted: true } },
        async state(_request: { sessionId: string }, signal: AbortSignal) {
          signal.throwIfAborted()
          still += 1
          return { queue: [], running: true, cursor: 1 }
        },
      }
      if (name === 'sessionQuery') return { async readSession() { return { events: [] } } }
      return undefined
    })
    expect((await busy.stopActivity!('session-1')).idle).toBe(false)
    expect(still).toBeGreaterThan(2)
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

describe('archived session with no live agent', () => {
  const settled = (sessionId: string) => [{ type: 'job/settled', data: { jobId: 'bash-1', owner: sessionId, producerReported: true } }]

  function hostFor(sessionId: string, options: {
    archived?: boolean
    queue: unknown
    running: boolean
    jobs?: 'settled' | 'throw'
    live?: boolean
  }) {
    return bindHost(name => {
      if (name === 'workspaceRegistry') return { archivedSessionIds: options.archived ? [sessionId] : [] }
      if (name === 'jobs') {
        return {
          list() {
            if (options.jobs === 'throw') throw new Error('jobs unreadable')
            return [{ id: 'bash-1', status: 'completed', owner: sessionId }]
          },
        }
      }
      if (name === 'agents') return { get: () => options.live ? { status: 'running' as const, whenIdle: () => Promise.resolve() } : undefined }
      if (name === 'sessionController') return {
        async cancel() { throw new Error('not attached') },
        async list() { return { items: [{ sessionId, cwd: 'H:\\repo', agentPreset: 'standard' }] } },
        async state(_request: { sessionId: string }, signal: AbortSignal) {
          signal.throwIfAborted()
          return { queue: options.queue, running: options.running }
        },
        async resolveAgent() {
          return options.live
            ? { agent: { status: 'running' as const, whenIdle: () => Promise.resolve() } }
            : { error: { message: `${sessionId} has no live agent` } }
        },
      }
      if (name === 'sessionQuery') return { async readSession() { return { events: options.jobs === 'throw' ? [] : settled(sessionId) } } }
      return undefined
    })
  }

  it('finishes an archived stopped session and releases it', async () => {
    const { work, run } = await activeRun()
    const sessionId = run.sessionId ?? run.requestedSessionId
    const dot = bindRunSession(hostFor(sessionId, { archived: true, queue: null, running: false, jobs: 'settled' }))
    const finished = await finishWork(work, dot, run.id, 'completed', 9)
    expect(finished).toMatchObject({ ok: true, phase: 'completed' })
    expect(work.run(run.id)?.closureEvidence).toEqual({ queueCleared: true, agentIdle: true, jobsSettled: true })
    expect(work.occupying()).toEqual([])
  })

  it('keeps a live running session busy', async () => {
    const report = await hostFor('session-1', { archived: true, queue: [], running: true, jobs: 'settled', live: true }).stopActivity!('session-1')
    expect(report).toMatchObject({ idle: false, jobsSettled: true })
  })

  it('does not release a dead session that is still running or still queued', async () => {
    const { work, run } = await activeRun()
    const sessionId = run.sessionId ?? run.requestedSessionId
    const running = bindRunSession(hostFor(sessionId, { archived: true, queue: null, running: true, jobs: 'settled' }))
    expect(await finishWork(work, running, run.id, 'completed', 9)).toMatchObject({ ok: false, code: 'unknown' })
    expect(work.occupying().map(item => item.id)).toEqual([run.id])

    const queued = bindRunSession(hostFor(sessionId, { archived: true, queue: [{ id: 'still-queued' }], running: false, jobs: 'settled' }))
    expect(await finishWork(work, queued, run.id, 'completed', 10)).toMatchObject({ ok: false, code: 'unknown' })
    expect(work.run(run.id)?.phase).toBe('settling')
    expect(work.occupying().map(item => item.id)).toEqual([run.id])
  })

  it('keeps occupancy when a missing agent has no persisted stop', async () => {
    const { work, run } = await activeRun()
    const sessionId = run.sessionId ?? run.requestedSessionId
    const dot = bindRunSession(hostFor(sessionId, { archived: false, queue: null, running: false, jobs: 'throw' }))
    const refused = await finishWork(work, dot, run.id, 'completed', 9)
    expect(refused).toMatchObject({ ok: false, code: 'unknown' })
    expect(work.run(run.id)?.closureEvidence).toBeUndefined()
    expect(work.run(run.id)?.phase).toBe('settling')
    expect(work.occupying().map(item => item.id)).toEqual([run.id])
    expect(await hostFor(sessionId, { archived: false, queue: null, running: false, jobs: 'settled' }).stopActivity!(sessionId)).toMatchObject({
      queueCleared: false, idle: false, jobsSettled: true,
    })
  })
})

async function activeRun() {
  const persist: WorkPersist = async () => undefined
  const work = new WorkBook(persist, 'win32')
  const change = await work.createChange({ title: 'Ship', cwd: 'H:\\repo', goal: 'land it', at: 1 })
  const reserved = await work.reserveRun({ changeId: change.id, cwd: 'H:\\repo', root: { workspaceRoot: 'H:\\repo' }, writeScope: { kind: 'paths', paths: [] }, at: 2 })
  if (!reserved.ok) throw new Error(reserved.message)
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
