import { describe, expect, it, vi } from 'vitest'
import { bindHost } from './host.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function stage(options: { status?: 'idle' | 'running'; wait?: () => Promise<void>; onJobs?: () => void } = {}) {
  const queue = [{ id: 'queued' }]
  let reads = 0
  const agent = {
    status: options.status ?? 'idle',
    cancel: vi.fn((_cause, opts) => { if (!opts.keepInbox) queue.length = 0 }),
    whenIdle: vi.fn(options.wait ?? (async () => {})),
  }
  let current: typeof agent | undefined = agent
  const resolveAgent = vi.fn(() => { throw new Error('must not resume') })
  const host = bindHost(name => {
    if (name === 'agents') return { get: () => current }
    if (name === 'jobs') return { list: () => [] }
    if (name === 'sessionQuery') return { async readSession() { options.onJobs?.(); return { events: [] } } }
    if (name === 'sessionController') return {
      resolveAgent,
      async state() { reads += 1; return { active: true, running: current?.status === 'running', queue, cursor: 1 } },
    }
    return undefined
  })
  return { host, agent, queue, resolveAgent, reads: () => reads, replace: () => { current = { ...agent } } }
}

describe('live agent stop', () => {
  it('waits through maintenance whose public status is idle, then samples once', async () => {
    const maintenance = deferred()
    const h = stage({ wait: () => maintenance.promise })
    let done = false
    const stopping = h.host.stopActivity!('s').then(report => { done = true; return report })
    await Promise.resolve()
    expect(h.agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(h.agent.whenIdle).toHaveBeenCalledOnce()
    expect(h.queue).toEqual([])
    expect(done).toBe(false)
    expect(h.reads()).toBe(0)
    maintenance.resolve()
    expect(await stopping).toEqual({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true })
    expect(h.reads()).toBe(1)
    expect(h.resolveAgent).not.toHaveBeenCalled()
  })

  it('does not certify idle after whenIdle rejects', async () => {
    const h = stage({ wait: async () => { throw new Error('cannot observe idle') } })
    expect(await h.host.stopActivity!('s')).toMatchObject({ idle: false, queueCleared: true })
  })

  it('bounds an idle-status maintenance wait and leaves stop unproved', async () => {
    vi.useFakeTimers()
    try {
      const h = stage({ wait: () => new Promise<void>(() => {}) })
      const stopping = h.host.stopActivity!('s')
      await vi.advanceTimersByTimeAsync(1_500)
      expect(await stopping).toMatchObject({ idle: false })
    } finally { vi.useRealTimers() }
  })

  it('does not certify a replacement agent after settling jobs', async () => {
    const h = stage({ onJobs: () => h.replace() })
    expect(await h.host.stopActivity!('s')).toMatchObject({ idle: false, queueCleared: false })
  })

  it('sees new queued work admitted while jobs settle', async () => {
    const h = stage({ onJobs: () => h.queue.push({ id: 'late' }) })
    expect(await h.host.stopActivity!('s')).toMatchObject({ queueCleared: false })
  })
})

it('does not resume a cold agent just to cancel and wait', async () => {
  const resolveAgent = vi.fn(() => { throw new Error('must not resume') })
  const host = bindHost(name => name === 'agents' ? { get: () => undefined } : name === 'sessionController' ? { resolveAgent } : undefined)
  expect(await host.cancelAndWait!('cold', 100)).toBe(false)
  expect(resolveAgent).not.toHaveBeenCalled()
})

describe('internal session wait', () => {
  it('returns directly after quiescence without polling for running', async () => {
    const h = stage()
    await expect(h.host.waitIdle('s', 100)).resolves.toBeUndefined()
    expect(h.agent.whenIdle).toHaveBeenCalledOnce()
    expect(h.agent.cancel).not.toHaveBeenCalled()
  })

  it('propagates a failed idle observation', async () => {
    const h = stage({ wait: async () => { throw new Error('wait failed') } })
    await expect(h.host.waitIdle('s', 100)).rejects.toThrow('wait failed')
  })

  it('cancels and rejects on the requested timeout', async () => {
    vi.useFakeTimers()
    try {
      const h = stage({ status: 'running', wait: () => new Promise<void>(() => {}) })
      const waited = expect(h.host.waitIdle('s', 100)).rejects.toThrow('did not become idle')
      await vi.advanceTimersByTimeAsync(100)
      await waited
      expect(h.agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    } finally { vi.useRealTimers() }
  })
})
