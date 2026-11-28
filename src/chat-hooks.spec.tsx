import { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatFeed } from './chat-hooks.ts'
import type { ChatApi } from './chat-panel.tsx'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => { createRoot = (await import('react-dom/client')).createRoot })

describe('useChatFeed retry backoff', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '<div id="root"></div>' })

  it('backs retries off exponentially and restarts immediately on manual retry', async () => {
    const chat = vi.fn(async () => { throw new Error('backend down') })
    const api = { chat, wait: chat } as unknown as ChatApi
    let retry: () => void = () => {}
    function Probe() {
      const feed = useChatFeed(api)
      retry = feed.retry
      return null
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<Probe />) })
    expect(chat).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(1_999) })
    expect(chat).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(chat).toHaveBeenCalledTimes(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(3_999) })
    expect(chat).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(chat).toHaveBeenCalledTimes(3)

    const before = chat.mock.calls.length
    await act(async () => { retry() })
    expect(chat).toHaveBeenCalledTimes(before + 1)
    await act(async () => { root.unmount() })
  })

  it('clears the backoff timer when the feed unmounts', async () => {
    const chat = vi.fn(async () => { throw new Error('backend down') })
    const api = { chat, wait: chat } as unknown as ChatApi
    function Probe() {
      useChatFeed(api)
      return null
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<Probe />) })
    expect(chat).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => { root.unmount() })
    expect(vi.getTimerCount()).toBe(0)
  })
})
