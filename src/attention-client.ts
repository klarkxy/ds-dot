/**
 * Background "needs you" watcher for the browser half. It polls the attention
 * endpoint on a timer so the sidebar badge and desktop notifications work
 * while Dorothy's panel is closed. The first successful poll seeds the seen-id
 * set silently; every later item id is new, notifies while the window is
 * unattended, and is forgotten once it stops waiting so a re-asked decision
 * notifies again.
 */
import type { AttentionItem, AttentionView } from './contracts.ts'
import { noteBackendError } from './backend-state.ts'

/** localStorage switch for desktop notifications; '1' means on, anything else off. */
export const DESKTOP_NOTIFY_KEY = 'dsh-dot:desktop-notify'

/** Unwrap one attention RPC reply, recording backend version skew before throwing. */
export function attentionValue(reply: { readonly ok: true; readonly value: AttentionView } | { readonly ok: false; readonly error: { readonly message: string; readonly code?: string } } | undefined): AttentionView {
  if (reply?.ok === true) return reply.value
  const code = reply?.ok === false ? reply.error.code : undefined
  const message = reply?.ok === false ? reply.error.message : 'rpc failed'
  noteBackendError(code, message)
  const error = new Error(message) as Error & { code?: string }
  if (code !== undefined) error.code = code
  throw error
}

export interface AttentionSnapshot {
  readonly count: number
  readonly items: readonly AttentionItem[]
}

export interface AttentionWatcher {
  subscribe(listener: () => void): () => void
  getSnapshot(): AttentionSnapshot
  start(): void
  stop(): void
}

const EMPTY_SNAPSHOT: AttentionSnapshot = { count: 0, items: [] }

export function createAttentionWatcher({ fetch, intervalMs = 15_000, isAttended, notify, log, isFatal }: {
  fetch: (signal: AbortSignal) => Promise<AttentionView>
  intervalMs?: number
  isAttended: () => boolean
  notify: (item: AttentionItem) => void
  /** Called at most once per consecutive failure streak. */
  log?: (error: unknown) => void
  /** Version-skew shape: stop polling instead of retrying forever. */
  isFatal?: (error: unknown) => boolean
}): AttentionWatcher {
  const listeners = new Set<() => void>()
  const seen = new Set<string>()
  let snapshot: AttentionSnapshot = EMPTY_SNAPSHOT
  let seeded = false
  let running = false
  let streakLogged = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: AbortController | undefined

  const sameItems = (a: readonly AttentionItem[], b: readonly AttentionItem[]): boolean =>
    a.length === b.length && a.every((item, index) => {
      const other = b[index]
      return other !== undefined && item.id === other.id && item.title === other.title && item.since === other.since
    })

  const poll = async (): Promise<void> => {
    if (!running || flight) return
    const controller = new AbortController()
    flight = controller
    try {
      const view = await fetch(controller.signal)
      streakLogged = false
      failures = 0
      const items = view.items
      if (!seeded) {
        for (const item of items) seen.add(item.id)
        seeded = true
      } else {
        const live = new Set<string>()
        for (const item of items) {
          live.add(item.id)
          if (seen.has(item.id)) continue
          seen.add(item.id)
          if (!isAttended()) notify(item)
        }
        for (const id of seen) if (!live.has(id)) seen.delete(id)
      }
      if (!sameItems(snapshot.items, items)) {
        snapshot = { count: items.length, items }
        for (const listener of listeners) listener()
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        failures++
        if (!streakLogged) {
          streakLogged = true
          log?.(error)
        }
        if (isFatal?.(error)) {
          running = false
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }
    } finally {
      if (flight === controller) flight = undefined
      if (running) {
        if (timer !== undefined) clearTimeout(timer)
        const delay = failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** failures, 300_000)
        timer = setTimeout(() => { timer = undefined; void poll() }, delay)
      }
    }
  }

  const onVisibility = () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
    // Drop the armed timer so the immediate poll does not start a second loop;
    // a poll already in flight re-arms from its own finally.
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    void poll()
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot(): AttentionSnapshot { return snapshot },
    start(): void {
      if (running) return
      running = true
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
      void poll()
    },
    stop(): void {
      running = false
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      flight?.abort()
      flight = undefined
    },
  }
}
