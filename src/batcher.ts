/** Idle-only wake-up queue. Approval grace is evaluated per item. */
import type { NoticeEntry, ParsedNotice } from './chat-format.ts'
export interface Notice {
  readonly sessionId: string
  readonly kind: 'turn-end' | 'error' | 'approval' | 'question' | 'task-human' | 'idle-check'
  readonly text: string
  readonly display?: NoticeEntry
  readonly at: number
  readonly requestId?: string
  readonly changeId?: string
  /** Set on a persisted work-decision wake so delivery can be marked once. */
  readonly wakeKey?: string
}

export interface Timer { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void; now(): number }
export const realTimer: Timer = { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now() }
export const HOLD_LIMIT = 20
interface Entry { notice: Notice; wake: boolean; dueAt: number }

export class NoticeBatcher {
  private items: Entry[] = []
  private handle: unknown
  private handleAt = 0
  private graceHandle: unknown
  private disposed = false
  private flushing = false
  private retryAt = 0
  constructor(private readonly flush: (items: readonly Notice[]) => Promise<void>, private readonly options: { isIdle: () => boolean; timer?: Timer; holdLimit?: number; onEnqueue?: () => void; onEmpty?: () => void }) {}
  private get timer(): Timer { return this.options.timer ?? realTimer }
  get size(): number { return this.items.length }
  push(notice: Notice, _urgent = false, delayMs = 0): void {
    if (this.disposed) return
    this.options.onEnqueue?.()
    this.items.push({ notice, wake: true, dueAt: this.timer.now() + Math.max(0, delayMs) })
    this.armGrace()
    this.schedule(1500)
  }
  hold(notice: Notice): void {
    if (this.disposed) return
    this.options.onEnqueue?.()
    this.items.push({ notice, wake: false, dueAt: 0 })
    if (this.items.filter(entry => !entry.wake).length >= (this.options.holdLimit ?? HOLD_LIMIT)) {
      for (const entry of this.items) entry.wake = true
      this.schedule(1500)
    }
  }
  dropWhere(predicate: (notice: Notice) => boolean): void {
    this.items = this.items.filter(entry => !predicate(entry.notice))
    if (!this.items.length) { this.retryAt = 0; this.options.onEmpty?.() }
    this.armGrace()
  }
  /** Called on idle; the entry timer also batches arrivals for 1.5 seconds. */
  wake(): void { if (this.items.length) this.schedule(0) }
  private schedule(delay: number): void {
    if (this.disposed) return
    const due = Math.max(this.timer.now() + delay, this.retryAt)
    delay = Math.max(0, due - this.timer.now())
    if (this.handle !== undefined) {
      if (this.handleAt <= due) return
      this.timer.clear(this.handle)
    }
    this.handleAt = due
    this.handle = this.timer.set(() => { this.handle = undefined; void this.drain() }, delay)
  }
  private armGrace(): void {
    if (this.graceHandle !== undefined) this.timer.clear(this.graceHandle)
    this.graceHandle = undefined
    const future = this.items.filter(entry => entry.wake && entry.dueAt > this.timer.now()).map(entry => entry.dueAt)
    if (future.length) this.graceHandle = this.timer.set(() => { this.graceHandle = undefined; this.armGrace(); void this.drain() }, Math.max(0, Math.min(...future) - this.timer.now()))
  }
  /** Human messages and reminders carry everything, including grace-period items. */
  take(): Notice[] {
    if (this.handle !== undefined) this.timer.clear(this.handle)
    if (this.graceHandle !== undefined) this.timer.clear(this.graceHandle)
    this.handle = this.graceHandle = undefined
    const items = this.items.splice(0).map(entry => entry.notice)
    this.retryAt = 0
    if (items.length && !this.disposed) this.options.onEmpty?.()
    return items
  }
  restore(batch: readonly Notice[]): void {
    if (this.disposed || !batch.length) return
    this.options.onEnqueue?.()
    this.items.unshift(...batch.map(notice => ({ notice, wake: true, dueAt: 0 })))
    this.retryAt = this.timer.now() + 60_000
    if (this.handle !== undefined) { this.timer.clear(this.handle); this.handle = undefined }
    this.schedule(60_000)
  }
  async drain(): Promise<void> {
    if (this.handle !== undefined) { this.timer.clear(this.handle); this.handle = undefined }
    if (this.disposed || this.flushing || !this.options.isIdle() || !this.items.some(entry => entry.wake && entry.dueAt <= this.timer.now())) return
    if (this.timer.now() < this.retryAt) { this.schedule(this.retryAt - this.timer.now()); return }
    this.retryAt = 0
    const now = this.timer.now()
    const ready = this.items.filter(entry => entry.dueAt <= now)
    this.items = this.items.filter(entry => entry.dueAt > now)
    this.armGrace()
    this.flushing = true
    let failed = false
    try { await this.flush(ready.map(entry => entry.notice)) }
    catch { failed = true; this.restore(ready.map(entry => entry.notice)) }
    finally {
      this.flushing = false
      if (!failed && !this.items.length) this.options.onEmpty?.()
      if (!failed && this.items.some(entry => entry.wake && entry.dueAt <= this.timer.now())) this.schedule(1500)
    }
  }
  dispose(): void { this.disposed = true; this.take() }
}

/** The text prompt and structured display share the same folded set. */
function foldedNotices(items: readonly Notice[]): readonly Notice[] {
  const latest = new Map<string, Notice>()
  for (const item of items) if (item.kind === 'turn-end' && item.changeId) {
    const key = `${item.changeId}\0${item.sessionId}`
    if ((latest.get(key)?.at ?? Number.NEGATIVE_INFINITY) <= item.at) latest.set(key, item)
  }
  return items.filter(item => item.kind !== 'turn-end' || !item.changeId || latest.get(`${item.changeId}\0${item.sessionId}`) === item)
}

export function formatNoticeDisplay(items: readonly Notice[]): ParsedNotice {
  return { isReminder: false, entries: foldedNotices(items).map(item => item.display ?? {
    kind: item.kind, sessionId: item.sessionId, ...item.requestId ? { requestId: item.requestId } : {}, summary: item.text,
  }) }
}

/** Model-facing context; browser display reads formatNoticeDisplay instead. */
export function formatNotices(items: readonly Notice[], ready: readonly string[] = []): string {
  const filtered = foldedNotices(items)
  const groups: Array<[string, (notice: Notice) => boolean]> = [
    ['Requests waiting for you:', item => item.kind === 'approval' || item.kind === 'question'],
    ['Errors:', item => item.kind === 'error'],
    ['Tasks:', item => !['approval', 'question', 'error'].includes(item.kind) && (!!item.changeId || item.kind === 'task-human' || item.kind === 'idle-check')],
    ['Watched sessions:', item => !item.changeId && item.kind === 'turn-end'],
  ]
  const lines = ['[dot notice] Updates:']
  for (const [heading, matches] of groups) {
    const rows = filtered.filter(matches)
    if (!rows.length) continue
    lines.push(heading)
    for (const row of rows) lines.push(`- ${row.kind} · ${row.sessionId}: ${row.text}`)
  }
  if (ready.length) lines.push('Ready to start (highest priority first):', ...ready.map(row => `- ${row}`))
  return lines.join('\n')
}
