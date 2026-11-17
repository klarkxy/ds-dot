/**
 * Real bindHost, with one test adapter in front.
 * Relay: the real followup lands, the caller sees one unknown ack, the retry does not send.
 * Stop: jobs.wait is held past the 1500ms window, then the same owned job confirms.
 */
import { describe, expect, it } from 'vitest'
import { bindRunSession, finishWork, launchReservedRun, supplementRun } from './execution.ts'
import { bindHost } from './host.ts'
import { createHostFault, hostFaultFromEnv } from './host-fault-harness.ts'
import { WorkBook, type WorkPersist } from './work.ts'

const readScope = { kind: 'paths' as const, paths: [] }
const writeScope = { kind: 'paths' as const, paths: [{ path: 'H:\\repo\\a.ts', type: 'file' as const }] }

function book() {
  const persist: WorkPersist = async () => undefined
  return new WorkBook(persist, 'win32')
}

interface JobRow { id: string; status: string; owner?: string }
interface JournalEvent { type?: string; data?: { inserted?: unknown[]; jobId?: string; owner?: string; producerReported?: boolean } }

function stage(sessionId: string) {
  const events: JournalEvent[] = []
  const jobs: JobRow[] = [
    { id: 'job-owned', status: 'running', owner: sessionId },
    { id: 'job-other', status: 'running', owner: 'session-unrelated' },
  ]
  const killed: string[] = []
  let follows = 0
  const agent = {
    session: { id: sessionId, get seq() { return events.length }, eventAt: (seq: number) => events[seq] },
    status: 'idle' as const,
    cancel() {},
    whenIdle: () => Promise.resolve(),
    followup(message: { content?: unknown; source?: Record<string, unknown> }) {
      follows += 1
      events.push({
        type: 'agent/inbox/spliced',
        data: { inserted: [{ id: `msg-${follows}`, content: message.content, source: message.source }] },
      })
    },
  }
  const jobsApi = {
    list: () => jobs.map(row => ({ ...row })),
    kill(id: string, caller?: string) {
      const row = jobs.find(item => item.id === id)
      if (!row || row.owner !== caller) return 'already-finished' as const
      killed.push(id)
      row.status = 'killed'
      events.push({ type: 'job/settled', data: { jobId: id, owner: caller, producerReported: true } })
      return 'requested' as const
    },
    async wait(id: string) {
      const row = jobs.find(item => item.id === id)
      if (!row || row.status === 'running') throw new Error('job still running')
      return { ...row }
    },
  }
  const get = (name: string) => {
    if (name === 'agents') return { get: () => agent }
    if (name === 'jobs') return jobsApi
    if (name === 'sessionQuery') return { async readSession() { return { events } } }
    if (name === 'sessionController') return {
      async cancel() { return { accepted: true } },
      async list() { return { items: [{ sessionId, cwd: 'H:\\repo', agentPreset: 'standard' }] } },
      async state() { return { queue: [], running: false, cursor: 1 } },
      async prompt() { return { accepted: true } },
    }
    if (name === 'permissionPresets') return {
      defaultPreset: 'workspace-write',
      resolve: (id: string) => ({ sandbox: id === 'read-only' ? 'read-only' : 'workspace-write' }),
      set: () => {},
      current: () => 'workspace-write',
    }
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'read-only' }) }
    if (name === 'approval') return { overrideOf: () => 'never' }
    return undefined
  }
  return { events, jobs, killed, get, follows: () => follows }
}

async function activeRun(scope: typeof readScope | typeof writeScope = readScope) {
  const work = book()
  const change = await work.createChange({ title: 'Ship', cwd: 'H:\\repo', goal: 'land it', at: 1 })
  const reserved = await work.reserveRun({ changeId: change.id, cwd: 'H:\\repo', root: { workspaceRoot: 'H:\\repo' }, writeScope: scope, at: 2 })
  if (!reserved.ok) throw new Error(reserved.message)
  if (scope.paths.length > 0) {
    const published = await work.publishBaseline(reserved.run.id, work.revision, 'base-1', 3)
    if (!('applied' in published)) throw new Error(published.message)
  }
  const live = stage(reserved.run.requestedSessionId)
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
  return { work, run: reserved.run, live }
}

describe('real host fault harness', () => {
  it('does nothing unless the fault env is set', () => {
    const idle = hostFaultFromEnv({})
    const jobs = { wait: () => Promise.resolve({ id: 'a' }) }
    expect(idle.wrapService('jobs', jobs)).toBe(jobs)
    expect(idle.relayCalls).toBe(0)
  })

  it('records one real relay, returns unknown once, and accepts the same delivery without a second send', async () => {
    const { work, run, live } = await activeRun(writeScope)
    const fault = createHostFault({ relayAckUnknown: true })
    const host = bindRunSession(fault.wrapHost(bindHost(name => fault.wrapService(name, live.get(name)))))
    const first = await supplementRun(work, host, run.id, 'more', 'session-dot', 5)
    expect(first).toMatchObject({ code: 'unknown' })
    expect(live.follows()).toBe(1)
    expect(fault.relayCalls).toBe(1)
    const delivery = work.run(run.id)?.deliveries.find(item => item.kind === 'context')
    expect(delivery).toMatchObject({ status: 'unknown', contentRef: 'more' })
    expect(live.events.filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(1)

    const second = await supplementRun(work, host, run.id, 'more', 'session-dot', 6)
    expect(second).toMatchObject({ ok: true, phase: 'active' })
    expect(live.follows()).toBe(1)
    expect(fault.relayCalls).toBe(1)
    expect(work.run(run.id)?.deliveries.find(item => item.id === delivery?.id)).toMatchObject({ status: 'accepted' })
    expect(work.occupying().map(item => item.id)).toEqual([run.id])
  })

  it('forwards the final relay gate before injecting a lost acknowledgement', async () => {
    const { live } = await activeRun()
    const fault = createHostFault({ relayAckUnknown: true })
    const host = fault.wrapHost(bindHost(live.get))
    await expect(host.relay('target', 'sender', 'late', 'd1', () => false)).rejects.toThrow('closed before followup')
    expect(live.follows()).toBe(0)
    expect(fault.relayCalls).toBe(0)
  })

  it('holds owned-job confirmation past jobs.wait(1500), then releases only that job', async () => {
    const { work, run, live } = await activeRun(writeScope)
    const fault = createHostFault({ holdJobConfirm: true })
    const reports: { jobsSettled: boolean | 'unknown' }[] = []
    const bound = bindHost(name => fault.wrapService(name, live.get(name)))
    const host = bindRunSession({
      ...bound,
      async stopActivity(sessionId) {
        const report = await bound.stopActivity!(sessionId)
        reports.push(report)
        return report
      },
    })
    const started = Date.now()
    const finishing = finishWork(work, host, run.id, 'completed', 7)
    const sawSettling = await waitFor(() => work.run(run.id)?.phase === 'settling' && work.occupying().some(item => item.id === run.id), 400)
    expect(sawSettling).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_500)
    const refused = await finishing
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500)
    expect(refused).toMatchObject({ code: 'unknown' })
    expect(reports[0]).toMatchObject({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: 'unknown' })
    expect(work.run(run.id)?.phase).toBe('settling')
    expect(work.run(run.id)?.closureEvidence).toBeUndefined()
    expect(work.occupying().map(item => item.id)).toEqual([run.id])
    expect(live.killed).toEqual(['job-owned'])
    expect(live.jobs.find(item => item.id === 'job-other')).toMatchObject({ status: 'running', owner: 'session-unrelated' })

    fault.releaseJobHold()
    const released = await finishWork(work, host, run.id, 'completed', 8)
    expect(released).toMatchObject({ ok: true, phase: 'completed' })
    expect(reports[1]).toMatchObject({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true })
    expect(work.run(run.id)?.closureEvidence).toEqual({ queueCleared: true, agentIdle: true, jobsSettled: true })
    expect(work.occupying()).toEqual([])
    expect(live.killed).toEqual(['job-owned'])
    expect(live.jobs.find(item => item.id === 'job-other')?.status).toBe('running')
  }, 10_000)

  it('finishes after the owned job settles with a bare registered Agent', async () => {
    const { work, run, live } = await activeRun()
    const inner = (live.get('agents') as { get: () => unknown }).get()
    const host = bindRunSession(bindHost(name => {
      if (name === 'agents') return { get: () => inner }
      return live.get(name)
    }))
    const finished = await finishWork(work, host, run.id, 'completed', 9)
    expect(finished).toMatchObject({ ok: true, phase: 'completed' })
    expect(work.run(run.id)?.closureEvidence).toEqual({ queueCleared: true, agentIdle: true, jobsSettled: true })
    expect(work.occupying()).toEqual([])
    expect(live.killed).toEqual(['job-owned'])
    expect(live.jobs.find(item => item.id === 'job-other')?.status).toBe('running')
  })

  it('does not invent idle when the live agent is actually gone', async () => {
    const { work, run, live } = await activeRun()
    const host = bindRunSession(bindHost(name => {
      if (name === 'agents') return { get: () => undefined }
      if (name === 'sessionController') {
        const controller = live.get('sessionController') as { cancel: () => Promise<unknown>; state: () => Promise<unknown> }
        return { ...controller, async resolveAgent() { return { error: { message: 'session has no live agent' } } } }
      }
      return live.get(name)
    }))
    const refused = await finishWork(work, host, run.id, 'completed', 9)
    expect(refused).toMatchObject({ ok: false, code: 'unknown' })
    expect(work.run(run.id)?.phase).toBe('settling')
    expect(work.run(run.id)?.closureEvidence).toBeUndefined()
    expect(work.occupying().map(item => item.id)).toEqual([run.id])
  })

  it('keeps list and kill when the rc.3 registry puts them on the prototype', async () => {
    const { work, run, live } = await activeRun()
    const sessionId = run.requestedSessionId
    const events = live.events
    class Registry {
      readonly rows = [
        { id: 'job-owned', status: 'running', owner: sessionId },
        { id: 'job-other', status: 'running', owner: 'session-unrelated' },
      ]
      readonly killed: string[] = []
      list(caller?: string) {
        return this.rows.filter(row => row.owner === undefined || row.owner === caller).map(row => ({ ...row }))
      }
      kill(id: string, caller?: string) {
        const row = this.rows.find(item => item.id === id)
        if (!row || row.owner !== caller) return 'already-finished' as const
        this.killed.push(id)
        row.status = 'killed'
        events.push({ type: 'job/settled', data: { jobId: id, owner: caller, producerReported: true } })
        return 'requested' as const
      }
      async wait(id: string) {
        const row = this.rows.find(item => item.id === id)
        if (!row || row.status === 'running') throw new Error('job still running')
        return { ...row }
      }
    }
    const registry = new Registry()
    expect(Object.hasOwn(registry, 'list')).toBe(false)
    expect(Object.hasOwn(registry, 'kill')).toBe(false)
    expect(typeof registry.list).toBe('function')
    const fault = createHostFault({ holdJobConfirm: true })
    const wrapped = fault.wrapService('jobs', registry)
    expect(typeof wrapped.list).toBe('function')
    expect(typeof wrapped.kill).toBe('function')
    const reports: { cancelAccepted: boolean; queueCleared: boolean; idle: boolean; jobsSettled: boolean | 'unknown' }[] = []
    const bound = bindHost(name => {
      if (name === 'jobs') return wrapped
      return live.get(name)
    })
    const host = bindRunSession({
      ...bound,
      async stopActivity(id) {
        const report = await bound.stopActivity!(id)
        reports.push(report)
        return report
      },
    })
    const started = Date.now()
    const refused = await finishWork(work, host, run.id, 'completed', 10)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500)
    expect(refused).toMatchObject({ code: 'unknown' })
    expect(reports[0]).toMatchObject({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: 'unknown' })
    expect(work.run(run.id)?.phase).toBe('settling')
    expect(work.occupying().map(item => item.id)).toEqual([run.id])
    expect(registry.killed).toEqual(['job-owned'])
    expect(registry.rows.find(item => item.id === 'job-other')?.status).toBe('running')

    fault.releaseJobHold()
    const released = await finishWork(work, host, run.id, 'completed', 11)
    expect(released).toMatchObject({ ok: true, phase: 'completed' })
    expect(reports[1]).toMatchObject({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true })
    expect(work.run(run.id)?.closureEvidence).toEqual({ queueCleared: true, agentIdle: true, jobsSettled: true })
    expect(work.occupying()).toEqual([])
    expect(registry.rows.find(item => item.id === 'job-other')?.status).toBe('running')
  }, 10_000)
})

async function waitFor(ready: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (ready()) return true
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  return ready()
}
