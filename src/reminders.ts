/**
 * The clock behind dot's reminders: one timer set to the earliest due time.
 * When reminders come due they are handed to the service as one message for
 * dot's current segment. A reminder that came due while the host was not
 * running is delivered once at the next start.
 */
import { randomUUID } from 'node:crypto'
import { realTimer, type Timer } from './batcher.ts'
import type { ScheduleRecord } from './contracts.ts'
import { MAX_SCHEDULES, ScheduleInputError, describeTiming, formatReminders, nextOccurrence, onceDelivered, parseSchedule, type ScheduleInput } from './schedule.ts'
import type { ScheduleTiming } from './contracts.ts'
import type { DotStore } from './store.ts'

/** The timer never sleeps longer than this, so a suspended host or a changed clock is noticed. */
const MAX_SLEEP_MS = 30 * 60_000
/** A delivery that failed is tried again after this long. */
const RETRY_MS = 60_000

const fold = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** The same schedule rule: `anchor` is just when an every-reminder was added, so it does not count. */
function sameTiming(a: ScheduleTiming, b: ScheduleTiming): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'once' && b.kind === 'once') return a.at === b.at
  if (a.kind === 'every' && b.kind === 'every') return a.minutes === b.minutes
  if (a.kind === 'daily' && b.kind === 'daily') {
    const days = (row: readonly number[] | undefined) => [...(row ?? [])].sort((x, y) => x - y).join(',')
    return a.time === b.time && days(a.weekdays) === days(b.weekdays)
  }
  return false
}

export interface ReminderClockOptions {
  readonly store: DotStore
  /** Hand one message to dot; a rejection keeps the reminders due. */
  readonly deliver: (text: string) => Promise<void>
  /**
   * Dispatch a recipe-bound reminder directly (no model turn). On success the
   * service holds a non-waking notice; on refusal the record joins the plain
   * delivery list with the reason so dot can handle it.
   */
  readonly runRecipe?: (record: ScheduleRecord) => Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }>
  /**
   * Other periodic work mounted on the same clock (the background reflection
   * check). Called once per tick, and the clock keeps a wake-up even when no
   * reminder is set, so the check runs on an idle dot too.
   */
  readonly onPeriodic?: () => void
  readonly now: () => number
  readonly timer?: Timer
  readonly log?: (message: string) => void
}

export class ReminderClock {
  private handle: unknown
  private started = false
  private firing = false
  private disposed = false

  constructor(private readonly options: ReminderClockOptions) {}

  private get timer(): Timer { return this.options.timer ?? realTimer }

  /** Begin delivering; before this, reminders are stored but none fires. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.arm()
  }

  async add(input: ScheduleInput): Promise<ScheduleRecord> {
    const store = this.options.store
    const active = store.schedules.filter(record => !onceDelivered(record))
    if (active.length >= MAX_SCHEDULES) throw new ScheduleInputError(`${MAX_SCHEDULES} reminders are set already; remove one first`)
    const now = this.options.now()
    const parsed = parseSchedule(input, now)
    const duplicate = active.find(record => fold(record.title) === fold(parsed.title) || (sameTiming(record.timing, parsed.timing) && fold(record.prompt) === fold(parsed.prompt)) || (parsed.recipe !== undefined && record.recipe === parsed.recipe && sameTiming(record.timing, parsed.timing)))
    if (duplicate) throw new ScheduleInputError(`reminder ${duplicate.id} "${duplicate.title}" (${describeTiming(duplicate.timing)}) is set already; remove it first to change it`)
    let id = ''
    do { id = `sch-${randomUUID().slice(0, 6)}` } while (store.schedule(id))
    const record: ScheduleRecord = { id, ...parsed, createdAt: now }
    await store.putSchedule(record)
    this.arm()
    return record
  }

  /** @returns false when no reminder has that id. */
  async remove(id: string): Promise<boolean> {
    const removed = await this.options.store.deleteSchedule(id)
    this.arm()
    return removed
  }

  /** Deliver what is due now and set the timer for what comes next. */
  async tick(): Promise<void> {
    if (this.firing || this.disposed) return
    const store = this.options.store
    const now = this.options.now()
    // Other periodic work (the reflection check) rides this clock whether or not
    // a reminder is due; it must never throw back into the timer.
    try { this.options.onPeriodic?.() } catch (error) {
      this.options.log?.(`dsh-dot: periodic check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const due = store.schedules.filter(record => !onceDelivered(record) && record.nextAt <= now)
    if (due.length === 0) { this.arm(); return }
    this.firing = true
    let failed = false
    try {
      // A once reminder is claimed before the wake. An unknown ack, a crash, or a
      // restart must not deliver it again. Repeating reminders still move only
      // after a wake that did not throw, so a failed one stays due.
      for (const record of due) {
        if (record.timing.kind !== 'once' || onceDelivered(record)) continue
        await store.putSchedule({ ...record, deliveredAt: now, lastFiredAt: now })
      }
      // Recipe-bound reminders dispatch directly; a refusal still goes to dot.
      const recipeName = (id: string) => store.recipe(id)?.name
      const plain: ScheduleRecord[] = []
      const dispatched: ScheduleRecord[] = []
      const refusals = new Map<string, string>()
      for (const record of due) {
        if (!record.recipe || !this.options.runRecipe) { plain.push(record); continue }
        try {
          const result = await this.options.runRecipe(record)
          if (result.ok) { dispatched.push(record); continue }
          refusals.set(record.id, result.reason)
        } catch (error) {
          refusals.set(record.id, error instanceof Error ? error.message : String(error))
        }
        plain.push(record)
      }
      // A successful direct dispatch is never repeated: repeating records
      // advance now, independently of whether the plain delivery succeeds.
      for (const record of dispatched) {
        if (!store.schedule(record.id)) continue
        if (record.timing.kind === 'once') continue
        const next = nextOccurrence(record.timing, now)
        if (next === undefined) await store.deleteSchedule(record.id)
        else await store.putSchedule({ ...record, nextAt: next, lastFiredAt: now })
      }
      if (plain.length > 0) {
        await this.options.deliver(formatReminders(plain, now, { refusals, recipeName }))
        for (const record of plain) {
          // Removed while the delivery was underway: it stays removed.
          if (!store.schedule(record.id)) continue
          if (record.timing.kind === 'once') continue
          const next = nextOccurrence(record.timing, now)
          if (next === undefined) await store.deleteSchedule(record.id)
          else await store.putSchedule({ ...record, nextAt: next, lastFiredAt: now })
        }
      }
    } catch (error) {
      failed = true
      this.options.log?.(`dsh-dot: reminders not delivered, trying again shortly: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.firing = false
    }
    this.arm(failed ? RETRY_MS : undefined)
  }

  dispose(): void {
    this.disposed = true
    if (this.handle !== undefined) this.timer.clear(this.handle)
    this.handle = undefined
  }

  /** Re-arm after the store was wiped. */
  refresh(): void { this.arm() }

  private arm(wait?: number): void {
    if (!this.started || this.disposed) return
    if (this.handle !== undefined) { this.timer.clear(this.handle); this.handle = undefined }
    const next = this.options.store.schedules.find(record => !onceDelivered(record))?.nextAt
    // With periodic work attached the clock keeps a wake-up even when no
    // reminder exists, so the periodic check still runs on an otherwise idle dot.
    if (next === undefined && this.options.onPeriodic === undefined) return
    const ms = wait ?? (next === undefined ? MAX_SLEEP_MS : Math.min(MAX_SLEEP_MS, Math.max(0, next - this.options.now())))
    this.handle = this.timer.set(() => { this.handle = undefined; void this.tick() }, ms)
  }
}
