import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAttentionWatcher } from './attention-client.ts'
import type { AttentionItem, AttentionView } from './contracts.ts'

const dom = new JSDOM('', { url: 'https://local.test' })
vi.stubGlobal('document', dom.window.document)

const item = (id: string, since?: number): AttentionItem => ({ id, kind: 'card', title: `Title ${id}`, ...(since !== undefined ? { since } : {}) })
const view = (...items: AttentionItem[]): AttentionView => ({ items })
const flush = () => vi.advanceTimersByTimeAsync(0)
const visible = (state: string) => Object.defineProperty(dom.window.document, 'visibilityState', { value: state, configurable: true })

describe('createAttentionWatcher', () => {
  beforeEach(() => { vi.useFakeTimers(); visible('visible') })
  afterEach(() => { vi.useRealTimers() })

  it('seeds the seen set silently and exposes the count', async () => {
    const fetch = vi.fn(async () => view(item('a'), item('b')))
    const notify = vi.fn()
    const watcher = createAttentionWatcher({ fetch, intervalMs: 1000, isAttended: () => false, notify })
    watcher.start()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()
    expect(watcher.getSnapshot()).toEqual({ count: 2, items: [item('a'), item('b')] })
    watcher.stop()
  })

  it('notifies once per new id while unattended, not while attended', async () => {
    let items = view(item('a'))
    const fetch = vi.fn(async () => items)
    const notify = vi.fn()
    let attended = false
    const watcher = createAttentionWatcher({ fetch, intervalMs: 1000, isAttended: () => attended, notify })
    watcher.start()
    await flush()

    items = view(item('a'), item('b'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(item('b'))

    // The same id polled again does not repeat.
    await vi.advanceTimersByTimeAsync(1000)
    expect(notify).toHaveBeenCalledTimes(1)

    // A new arrival while the window is attended stays silent and stays seen.
    attended = true
    items = view(item('a'), item('b'), item('c'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(notify).toHaveBeenCalledTimes(1)
    attended = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(notify).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it('re-notifies an id that left and came back', async () => {
    let items = view(item('a'))
    const fetch = vi.fn(async () => items)
    const notify = vi.fn()
    const watcher = createAttentionWatcher({ fetch, intervalMs: 1000, isAttended: () => false, notify })
    watcher.start()
    await flush()

    items = view(item('a'), item('b'))
    await vi.advanceTimersByTimeAsync(1000)
    items = view(item('a'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(watcher.getSnapshot().count).toBe(1)

    items = view(item('a'), item('b'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(notify).toHaveBeenCalledTimes(2)
    watcher.stop()
  })

  it('keeps the last snapshot through failures and logs once per streak', async () => {
    let fail = false
    const fetch = vi.fn(async () => { if (fail) throw new Error('down'); return view(item('a')) })
    const notify = vi.fn()
    const log = vi.fn()
    const watcher = createAttentionWatcher({ fetch, intervalMs: 1000, isAttended: () => false, notify, log })
    watcher.start()
    await flush()
    const seeded = watcher.getSnapshot()

    fail = true
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(log).toHaveBeenCalledTimes(1)
    expect(watcher.getSnapshot()).toBe(seeded)

    // The second consecutive failure backs the next poll off to two intervals.
    fail = false
    await vi.advanceTimersByTimeAsync(2000)
    expect(log).toHaveBeenCalledTimes(1)
    fail = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(log).toHaveBeenCalledTimes(2)
    watcher.stop()
  })

  it('re-polls immediately when the tab becomes visible', async () => {
    const fetch = vi.fn(async () => view(item('a')))
    const watcher = createAttentionWatcher({ fetch, intervalMs: 60_000, isAttended: () => true, notify: vi.fn() })
    watcher.start()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)

    visible('hidden')
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)

    visible('visible')
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    watcher.stop()
  })

  it('keeps a single poll loop when the tab becomes visible mid-interval', async () => {
    const fetch = vi.fn(async () => view(item('a')))
    const watcher = createAttentionWatcher({ fetch, intervalMs: 1000, isAttended: () => true, notify: vi.fn() })
    watcher.start()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)

    // Mid-interval the tab hides then returns: the armed timer is dropped and
    // the immediate poll re-arms a single one.
    await vi.advanceTimersByTimeAsync(400)
    visible('hidden')
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
    await flush()
    visible('visible')
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)

    // Several intervals later there is still exactly one fetch per interval.
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetch).toHaveBeenCalledTimes(5)
    watcher.stop()
  })

  it('keeps a stable snapshot identity and tells subscribers only on change', async () => {
    let items = view(item('a'))
    const fetch = vi.fn(async () => items)
    const watcher = createAttentionWatcher({ fetch, intervalMs: 1000, isAttended: () => true, notify: vi.fn() })
    const heard = vi.fn()
    watcher.start()
    await flush()
    watcher.subscribe(heard)
    const first = watcher.getSnapshot()

    await vi.advanceTimersByTimeAsync(1000)
    expect(watcher.getSnapshot()).toBe(first)
    expect(heard).not.toHaveBeenCalled()

    items = view(item('a'), item('c', 3))
    await vi.advanceTimersByTimeAsync(1000)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(watcher.getSnapshot()).not.toBe(first)
    expect(watcher.getSnapshot().count).toBe(2)
    watcher.stop()
  })

  it('stop() aborts the in-flight poll and halts the loop', async () => {
    let resolveFetch: (value: AttentionView) => void = () => {}
    const fetch = vi.fn((signal: AbortSignal) => new Promise<AttentionView>(resolve => {
      resolveFetch = resolve
      signal.addEventListener('abort', () => resolve({ items: [] }), { once: true })
    }))
    const watcher = createAttentionWatcher({ fetch, intervalMs: 1000, isAttended: () => false, notify: vi.fn() })
    watcher.start()
    expect(fetch).toHaveBeenCalledTimes(1)
    watcher.stop()
    resolveFetch(view(item('a')))
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('backs off consecutive failures exponentially and resets after a success', async () => {
    let fail = true
    const fetch = vi.fn(async () => { if (fail) throw new Error('down'); return view(item('a')) })
    const watcher = createAttentionWatcher({ fetch, intervalMs: 1000, isAttended: () => false, notify: vi.fn() })
    watcher.start()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(3)

    fail = false
    await vi.advanceTimersByTimeAsync(8000)
    expect(fetch).toHaveBeenCalledTimes(4)
    fail = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(5)
    watcher.stop()
  })

  it('stops polling on a fatal version-skew error', async () => {
    const error = Object.assign(new Error('unknown endpoint: attention'), { code: 'not-found' })
    const fetch = vi.fn(async () => { throw error })
    const watcher = createAttentionWatcher({
      fetch,
      intervalMs: 1000,
      isAttended: () => false,
      notify: vi.fn(),
      isFatal: value => value === error,
    })
    watcher.start()
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
