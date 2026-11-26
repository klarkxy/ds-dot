// Adapted from deepseek-ai/dsh-superagent-prototype@8c32a9d (MIT).
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_LIMIT_MS,
  DRAIN_LIMIT_MS,
  KILL_WAIT_MS,
  QuietWaitTracker,
  killJobs,
  runningJobs,
  stopBackground,
  untilQuiet,
  type BackgroundAgentLike,
  type BackgroundJobEvent,
  type ServiceGetter,
} from './background.ts'

interface HarnessJob {
  id: string
  kind: string
  label: string
  owner?: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  outputText: string
  modelCursor: number
  waitResolvers: Set<() => void>
  cancel?: (reason?: string) => void
}

interface HarnessSubagentChild {
  agent: BackgroundAgentLike & { inbox: { nextTurn: unknown[]; nextStep: unknown[] } }
  done: Promise<void>
  resolve: () => void
  continuable?: boolean
}

function createRc5BackgroundHarness() {
  const jobsMap = new Map<string, HarnessJob>()
  const subscribers = new Set<{ filter: { owner?: string; owners?: string }; listener: (ev: BackgroundJobEvent) => void }>()
  const agents = new Map<string, BackgroundAgentLike>()
  const followups: Array<{ sessionId: string; message: string }> = []
  const injects: Array<{ sessionId: string; message: string }> = []
  const readCalls: string[] = []
  const readAtCalls: string[] = []
  const listCalls: Array<string | undefined> = []
  const killCalls: Array<{ id: string; caller?: string; reason?: string }> = []
  const waitCalls: Array<{ id: string; timeoutMs: number; caller?: string }> = []
  const callOrder: string[] = []
  const subagentChildren = new Map<string, HarnessSubagentChild[]>()
  const drainCalls: BackgroundAgentLike[][] = []
  let seqCounter = 0

  function emit(event: BackgroundJobEvent) {
    for (const sub of [...subscribers]) {
      if (sub.filter.owner !== undefined) {
        // Replicate rc.5 JobEventHub quirk: owner === undefined passes through { owner } filter!
        const ownerId = event.job?.owner
        if (ownerId !== undefined && ownerId !== sub.filter.owner) continue
      }
      sub.listener(event)
    }
  }

  // dsh-tool-jobs settlement listener: fires wakeup unless event.awaited === true
  subscribers.add({
    filter: { owners: 'scope' },
    listener: event => {
      if (event.type !== 'settled' || event.awaited || !event.job?.owner) return
      const owner = agents.get(event.job.owner)
      if (!owner) return
      const msg = `background job ${event.job.id} finished [status: ${event.job.status}]`
      if (owner.status === 'idle') followups.push({ sessionId: owner.id, message: msg })
      else injects.push({ sessionId: owner.id, message: msg })
    },
  })

  // Prototype-only class matching rc.5 LocalJobRegistry & host-fault-harness
  class Registry {
    readonly events = {
      subscribe(filter: { owner?: string; owners?: string }, listener: (ev: BackgroundJobEvent) => void) {
        const entry = { filter, listener }
        subscribers.add(entry)
        return () => { subscribers.delete(entry) }
      },
    }
    list(caller?: string) {
      listCalls.push(caller)
      return [...jobsMap.values()]
        .filter(job => job.owner === undefined || job.owner === caller)
        .map(job => ({ id: job.id, kind: job.kind, label: job.label, owner: job.owner, status: job.status }))
    }
    read(id: string, caller?: string) {
      readCalls.push(id)
      const job = jobsMap.get(id)
      if (!job || (job.owner !== undefined && job.owner !== caller)) throw new Error('forbidden')
      job.modelCursor = job.outputText.length
      return { chunks: job.outputText ? [{ text: job.outputText }] : [], job }
    }
    readAt(id: string, from: number, caller?: string) {
      readAtCalls.push(id)
      const job = jobsMap.get(id)
      if (!job || (job.owner !== undefined && job.owner !== caller)) throw new Error('forbidden')
      return { chunks: job.outputText ? [{ text: job.outputText.slice(from) }] : [], next: job.outputText.length, lossy: false }
    }
    wait(id: string, timeoutMs: number, caller?: string) {
      callOrder.push(`wait:${id}`)
      waitCalls.push({ id, timeoutMs, caller })
      const job = jobsMap.get(id)
      if (!job) return Promise.reject(new Error(`unknown ${id}`))
      if (job.status !== 'running' && job.status !== 'stopping') {
        return Promise.resolve({ id: job.id, status: job.status, owner: job.owner })
      }
      return new Promise<{ id: string; status: string; owner?: string }>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const onSettled = () => {
          if (timer !== undefined) clearTimeout(timer)
          job.waitResolvers.delete(onSettled)
          resolve({ id: job.id, status: job.status, owner: job.owner })
        }
        job.waitResolvers.add(onSettled)
        timer = setTimeout(() => {
          job.waitResolvers.delete(onSettled)
          resolve({ id: job.id, status: job.status, owner: job.owner })
        }, timeoutMs)
        ;(timer as { unref?: () => void }).unref?.()
      })
    }
    kill(id: string, caller?: string, reason?: string) {
      callOrder.push(`kill:${id}`)
      killCalls.push({ id, caller, reason })
      const job = jobsMap.get(id)
      if (!job || (job.owner !== undefined && job.owner !== caller)) throw new Error(`unknown ${id}`)
      if (job.status !== 'running' && job.status !== 'stopping') return 'already-finished'
      job.cancel?.(reason)
      job.status = 'stopping'
      emit({ type: 'stopping', job: { id: job.id, label: job.label, owner: job.owner, status: job.status } })
      return 'requested'
    }
  }

  const jobs = new Registry()

  const subagents = {
    async waitForTreeWork(root: BackgroundAgentLike): Promise<boolean> {
      const children = subagentChildren.get(root.id) ?? []
      let observed = false
      for (const child of children) {
        if (child.agent.status !== 'idle') {
          observed = true
          await child.done
          continue
        }
        // rc.5 waitForTreeWork skips idle continuable children with parked inbox
        if (child.continuable && (child.agent.inbox.nextTurn.length > 0 || child.agent.inbox.nextStep.length > 0)) {
          continue
        }
        observed = true
        await child.done
      }
      return observed
    },
    async drainDescendants(parents: readonly BackgroundAgentLike[]): Promise<void> {
      drainCalls.push([...parents])
      for (const p of parents) {
        const children = subagentChildren.get(p.id) ?? []
        await Promise.all(children.map(c => c.done))
      }
    },
  }

  function makeAgent(id: string, initialStatus: 'idle' | 'running' = 'idle') {
    let seq = 0
    const agent: BackgroundAgentLike & { status: 'idle' | 'running'; session: { id: string; seq: number }; cancelCalls: unknown[]; bumpSeq: () => void } = {
      id,
      status: initialStatus,
      session: { id, get seq() { return seq } },
      cancelCalls: [],
      cancel(cause, options) { agent.cancelCalls.push({ cause, options }) },
      whenIdle: async () => {},
      bumpSeq() { seq += 1; seqCounter += 1 },
    }
    agents.set(id, agent)
    return agent
  }

  function startJob(spec: { id: string; label?: string; owner?: string; outputText?: string; cancel?: (reason?: string) => void }) {
    const job: HarnessJob = {
      id: spec.id,
      kind: 'bash',
      label: spec.label ?? spec.id,
      owner: spec.owner,
      status: 'running',
      outputText: spec.outputText ?? '',
      modelCursor: 0,
      waitResolvers: new Set(),
      cancel: spec.cancel,
    }
    jobsMap.set(job.id, job)
    emit({ type: 'registered', job: { id: job.id, label: job.label, owner: job.owner, status: job.status } })
    return job
  }

  function settleJob(id: string, status: 'completed' | 'killed' | 'failed' = 'completed') {
    const job = jobsMap.get(id)
    if (!job) return
    job.status = status
    const waiters = [...job.waitResolvers]
    job.waitResolvers.clear()
    for (const w of waiters) w()
    emit({
      type: 'settled',
      job: { id: job.id, label: job.label, owner: job.owner, status: job.status },
      cause: status === 'killed' ? 'kill' : 'producer',
      awaited: waiters.length > 0,
    })
  }

  function emitOutput(id: string, chunk: string) {
    const job = jobsMap.get(id)
    if (!job) return
    job.outputText += chunk
    emit({ type: 'output', id: job.id, owner: job.owner, total: job.outputText.length })
  }

  function addChild(rootId: string, childId: string, opts: { continuable?: boolean; parkedNextTurn?: boolean; parkedNextStep?: boolean; status?: 'idle' | 'running' } = {}) {
    let resolveInner!: () => void
    const done = new Promise<void>(r => { resolveInner = r })
    const entry: HarnessSubagentChild = {
      agent: {
        id: childId,
        status: opts.status ?? 'idle',
        inbox: {
          nextTurn: opts.parkedNextTurn ? [{ id: `m-${++seqCounter}` }] : [],
          nextStep: opts.parkedNextStep ? [{ id: `s-${++seqCounter}` }] : [],
        },
      },
      done,
      resolve: () => {
        ;(entry.agent as { status: 'idle' | 'running' }).status = 'idle'
        const list = subagentChildren.get(rootId)
        if (list) {
          const idx = list.indexOf(entry)
          if (idx >= 0) list.splice(idx, 1)
        }
        resolveInner()
      },
      continuable: opts.continuable,
    }
    const list = subagentChildren.get(rootId) ?? []
    list.push(entry)
    subagentChildren.set(rootId, list)
    return entry
  }

  const get: ServiceGetter = name => {
    if (name === 'jobs') return jobs
    if (name === 'subagents') return subagents
    if (name === 'agents') return { get: (id: string) => agents.get(id) }
    return undefined
  }

  return {
    get,
    jobs,
    subagents,
    makeAgent,
    startJob,
    settleJob,
    emitOutput,
    addChild,
    followups,
    injects,
    readCalls,
    readAtCalls,
    listCalls,
    killCalls,
    waitCalls,
    callOrder,
    drainCalls,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('background quiet-wait engine', () => {
  it('exposes expected timeout constants', () => {
    expect(BACKGROUND_LIMIT_MS).toBe(30 * 60_000)
    expect(KILL_WAIT_MS).toBe(10_000)
    expect(DRAIN_LIMIT_MS).toBe(10_000)
  })

  it('returns false when a job settles during waitForTreeWork and wakes the worker', async () => {
    const h = createRc5BackgroundHarness()
    const agent = h.makeAgent('w1', 'idle')
    const child = h.addChild('w1', 'c1', { status: 'running' })
    h.startJob({ id: 'j1', owner: 'w1' })

    const ac = new AbortController()
    const promise = untilQuiet(h.get, agent, ac.signal)
    // Simulate job settling while subagent is still finishing, waking worker
    h.settleJob('j1', 'completed')
    agent.status = 'running'
    child.resolve()
    expect(await promise).toBe(false)
  })

  it('returns false when AbortSignal aborts while waitForTreeWork is pending', async () => {
    const h = createRc5BackgroundHarness()
    const agent = h.makeAgent('w1', 'idle')
    const child = h.addChild('w1', 'c1', { status: 'running' })

    const ac = new AbortController()
    const promise = untilQuiet(h.get, agent, ac.signal)
    ac.abort('stopped')
    expect(await promise).toBe(false)
    child.resolve()
  })

  it('ignores 100 output events and resolves true once jobs settle while agent stays idle', async () => {
    const h = createRc5BackgroundHarness()
    const agent = h.makeAgent('w1', 'idle')
    h.startJob({ id: 'j1', label: 'build\nsecond line', owner: 'w1' })
    expect(runningJobs(h.get, 'w1')).toEqual([{ id: 'j1', name: 'j1 (build)' }])

    const ac = new AbortController()
    const promise = untilQuiet(h.get, agent, ac.signal)
    const listsBefore = h.listCalls.length
    for (let i = 0; i < 100; i++) h.emitOutput('j1', `line ${i}\n`)
    // High-throughput output events must not poll jobs.list()
    expect(h.listCalls.length).toBe(listsBefore)

    h.settleJob('j1', 'completed')
    expect(await promise).toBe(true)
    expect(runningJobs(h.get, 'w1')).toEqual([])
  })

  it('reuses a single waitForTreeWork promise via WeakMap across aborted restarts', async () => {
    const h = createRc5BackgroundHarness()
    const agent = h.makeAgent('w1', 'idle')
    const child = h.addChild('w1', 'c1', { status: 'running' })
    const spy = vi.spyOn(h.subagents, 'waitForTreeWork')

    const ac1 = new AbortController()
    const p1 = untilQuiet(h.get, agent, ac1.signal)
    ac1.abort()
    expect(await p1).toBe(false)

    const ac2 = new AbortController()
    const p2 = untilQuiet(h.get, agent, ac2.signal)
    ac2.abort()
    expect(await p2).toBe(false)

    const ac3 = new AbortController()
    const p3 = untilQuiet(h.get, agent, ac3.signal)
    expect(spy).toHaveBeenCalledTimes(1)
    child.resolve()
    expect(await p3).toBe(true)
  })

  it('times out hanging drainDescendants at 10_000ms and cancels the agent', async () => {
    vi.useFakeTimers()
    const h = createRc5BackgroundHarness()
    const agent = h.makeAgent('w1', 'running')
    h.addChild('w1', 'c1', { status: 'running' }) // never resolves

    let finished = false
    const stopping = stopBackground(h.get, agent, 'cancelled').then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(DRAIN_LIMIT_MS - 1)
    expect(finished).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(finished).toBe(true)
    expect(h.drainCalls).toHaveLength(1)
    expect(agent.cancelCalls).toEqual([{ cause: { kind: 'user' }, options: { keepInbox: false } }])
  })

  it('double-filters unowned (owner === undefined) jobs passed through rc.5 { owner } subscribe and list', async () => {
    const h = createRc5BackgroundHarness()
    const agent = h.makeAgent('w1', 'idle')
    h.startJob({ id: 'unowned-1', label: 'global daemon' }) // owner === undefined

    // Unowned job must not appear in runningJobs or block untilQuiet
    expect(runningJobs(h.get, 'w1')).toEqual([])
    expect(await untilQuiet(h.get, agent, new AbortController().signal)).toBe(true)

    // When w1 DOES have an owned job, settling the unowned job must not settle w1 prematurely
    h.startJob({ id: 'owned-1', owner: 'w1' })
    const p = untilQuiet(h.get, agent, new AbortController().signal)
    h.settleJob('unowned-1', 'completed')
    await Promise.resolve()
    expect(runningJobs(h.get, 'w1')).toHaveLength(1)
    h.settleJob('owned-1', 'completed')
    expect(await p).toBe(true)
  })

  it('pre-registers jobs.wait before jobs.kill so awaited=true suppresses dsh-tool-jobs wakeup, and reads tail via readAt', async () => {
    const h = createRc5BackgroundHarness()
    h.makeAgent('w1', 'idle')
    h.startJob({
      id: 'j-timeout',
      label: 'sleep 9999',
      owner: 'w1',
      outputText: 'partial stdout line',
      cancel: () => {
        setTimeout(() => h.settleJob('j-timeout', 'killed'), 10)
      },
    })

    const killed = await killJobs(h.get, 'w1', 'background-timeout')
    expect(h.callOrder).toEqual(['wait:j-timeout', 'kill:j-timeout'])
    expect(h.waitCalls[0]).toEqual({ id: 'j-timeout', timeoutMs: KILL_WAIT_MS, caller: 'w1' })
    expect(h.killCalls[0]).toEqual({ id: 'j-timeout', caller: 'w1', reason: 'background-timeout' })
    expect(h.followups).toEqual([])
    expect(h.injects).toEqual([])
    expect(h.readCalls).toEqual([])
    expect(h.readAtCalls).toEqual(['j-timeout'])
    expect(killed).toEqual([{ id: 'j-timeout', name: 'j-timeout (sleep 9999)', outputTail: 'partial stdout line' }])
  })

  it('shows why abandoned-wait fallback is needed when wait expires before slow job settlement', async () => {
    const h = createRc5BackgroundHarness()
    h.makeAgent('w1', 'idle')
    h.startJob({
      id: 'j-slow',
      owner: 'w1',
      cancel: () => {
        setTimeout(() => h.settleJob('j-slow', 'killed'), 60)
      },
    })
    // Wait expires at 15ms while job settles at 60ms -> awaited: false -> dsh-tool-jobs sends wakeup
    await h.jobs.wait('j-slow', 15, 'w1')
    h.jobs.kill('j-slow', 'w1', 'background-timeout')
    await new Promise(r => setTimeout(r, 80))
    expect(h.followups).toHaveLength(1)
  })

  it('collects AggregateError when jobs.kill throws while still awaiting pre-registered waits', async () => {
    const h = createRc5BackgroundHarness()
    h.makeAgent('w1', 'idle')
    h.startJob({ id: 'j-err', owner: 'w1', cancel: () => { throw new Error('cancel boom') } })
    // Settle shortly so wait doesn't wait full 10s
    setTimeout(() => h.settleJob('j-err', 'failed'), 15)
    await expect(killJobs(h.get, 'w1', 'background-timeout')).rejects.toBeInstanceOf(AggregateError)
    expect(h.waitCalls).toHaveLength(1)
  })

  it('returns false when agent.session.seq advances during microtask settle check', async () => {
    const h = createRc5BackgroundHarness()
    const agent = h.makeAgent('w1', 'idle')
    // Inject a subagent lookup that advances session.seq while resolving false
    const raceGet: ServiceGetter = name => {
      if (name === 'subagents') {
        return {
          async waitForTreeWork() {
            agent.bumpSeq()
            return false
          },
        }
      }
      return h.get(name)
    }
    expect(await untilQuiet(raceGet, agent, new AbortController().signal)).toBe(false)
  })

  it('does not block untilQuiet on idle continuable subagent with parked inbox.nextTurn or inbox.nextStep', async () => {
    const h = createRc5BackgroundHarness()
    const agent = h.makeAgent('w1', 'idle')
    h.addChild('w1', 'child-turn', { continuable: true, parkedNextTurn: true, status: 'idle' })
    h.addChild('w1', 'child-step', { continuable: true, parkedNextStep: true, status: 'idle' })
    expect(await untilQuiet(h.get, agent, new AbortController().signal)).toBe(true)
  })

  it('silently degrades when jobs or subagents are missing or throw', async () => {
    const h = createRc5BackgroundHarness()
    const agent = h.makeAgent('w1', 'idle')

    const missingGet: ServiceGetter = () => undefined
    expect(runningJobs(missingGet, 'w1')).toEqual([])
    expect(await untilQuiet(missingGet, agent, new AbortController().signal)).toBe(true)
    expect(await killJobs(missingGet, 'w1')).toEqual([])
    await expect(stopBackground(missingGet, agent)).resolves.toBeUndefined()

    const throwingGet: ServiceGetter = name => {
      if (name === 'jobs') {
        return {
          list: () => { throw new Error('jobs.list down') },
          events: { subscribe: () => { throw new Error('subscribe down') } },
        }
      }
      if (name === 'subagents') {
        return {
          waitForTreeWork: () => Promise.reject(new Error('subagents down')),
          drainDescendants: () => { throw new Error('drain down') },
        }
      }
      throw new Error('getter boom')
    }
    expect(runningJobs(throwingGet, 'w1')).toEqual([])
    expect(await untilQuiet(throwingGet, agent, new AbortController().signal)).toBe(true)
    await expect(stopBackground(throwingGet, agent)).resolves.toBeUndefined()
  })

  it('works with Proxy-wrapped prototype-method jobs registry without spreading', async () => {
    const h = createRc5BackgroundHarness()
    const agent = h.makeAgent('w1', 'idle')
    expect(Object.hasOwn(h.jobs, 'list')).toBe(false)
    const proxied = new Proxy(h.jobs, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? (...args: unknown[]) => value.apply(target, args) : value
      },
    })
    const proxyGet: ServiceGetter = name => (name === 'jobs' ? proxied : h.get(name))
    h.startJob({ id: 'j-proxy', owner: 'w1' })
    expect(runningJobs(proxyGet, 'w1')).toHaveLength(1)
    const p = untilQuiet(proxyGet, agent, new AbortController().signal)
    h.settleJob('j-proxy', 'completed')
    expect(await p).toBe(true)
  })

  it('tracks active, accumulated, and abandoned quiet-wait state in QuietWaitTracker', () => {
    const tracker = new QuietWaitTracker()
    const c1 = tracker.begin('s1', 1000)
    expect(tracker.has('s1')).toBe(true)
    expect(tracker.quietWaitMs('s1', 1500)).toBe(500)
    tracker.end('s1', c1, 2000)
    expect(tracker.has('s1')).toBe(false)
    expect(tracker.quietWaitMs('s1', 3000)).toBe(1000)

    const c2 = tracker.begin('s1', 4000)
    expect(tracker.abort('s1', 4500, 'supplement')).toBe(true)
    expect(c2.signal.aborted).toBe(true)
    expect(tracker.quietWaitMs('s1', 5000)).toBe(1500)

    tracker.markAbandoned('s1')
    expect(tracker.isAbandoned('s1')).toBe(true)
    tracker.clearAbandoned('s1')
    expect(tracker.isAbandoned('s1')).toBe(false)
  })
})
