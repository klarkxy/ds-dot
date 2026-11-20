/**
 * Daily self-update around local noon through the host's plugin-manager
 * service. Development installs (link:), git installs and hosts without the
 * service stay untouched: only a registry-installed ds-dot is a candidate.
 */
import type { Timer } from './batcher.ts'
import type { DotSettings } from './contracts.ts'
import { DOT_TRACE, type DotTraceInput } from './trace.ts'

export const PACKAGE_NAME = 'ds-dot'

/** Local hour the routine check aims at. */
const CHECK_HOUR = 12
/** A missed noon is made up this long after startup, so boot work settles first. */
const MISSED_DELAY_MS = 3 * 60_000
/** A found update waits for a quiet gap, re-polled this often. */
const QUIET_POLL_MS = 60_000

/** The sliver of the manager's BundleInfo this updater reads. */
export interface UpdateBundleInfo {
  readonly name: string
  readonly version?: string
  readonly update?: 'registry' | 'git'
}

/** One published version, narrowed to what the picker filters on. */
export interface UpdatePluginVersion {
  readonly version: string
  readonly prerelease: boolean
  readonly deprecated?: string
  readonly bundle: boolean
  readonly incompatible?: unknown
}

export type UpdateVersionList =
  | { readonly status: 'listed'; readonly installed: string; readonly registry: string | null; readonly versions: readonly UpdatePluginVersion[] }
  | { readonly status: 'refused'; readonly problem: string; readonly reason: string }

/** The sliver of the manager's PluginUpdateResult this updater maps to a kind. */
export interface UpdateOutcome {
  readonly from: string
  readonly to: string
  readonly result: {
    readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
    readonly error?: { readonly code?: string; readonly diagnostic?: string }
  }
}

/** The plugin-manager service, narrowed to the calls this updater makes. */
export interface PluginManagerLike {
  listBundles(): Promise<readonly UpdateBundleInfo[]>
  listVersions(name: string, options?: { readonly registry?: string | null }, signal?: AbortSignal): Promise<UpdateVersionList>
  updateBundle(name: string, version: string, options?: { readonly registry?: string | null }): Promise<UpdateOutcome>
}

export type UpdateResultKind = 'updated' | 'up-to-date' | 'not-updatable' | 'unavailable' | 'restart-required' | 'failed'

export interface UpdateResult {
  readonly kind: UpdateResultKind
  readonly at: number
  readonly from?: string
  readonly to?: string
  readonly message?: string
}

/** An apply the process never saw settle; the next start resolves it. */
export interface PendingUpdate {
  readonly from: string
  readonly to: string
  readonly at: number
}

/** Self-update bookkeeping persisted with dot's state. */
export interface UpdateStatus {
  readonly lastCheckAt?: number
  readonly lastResult?: UpdateResult
  readonly pending?: PendingUpdate
}

/** Store access the updater needs; DotStore satisfies it. */
export interface UpdateStore {
  readonly updateStatus?: UpdateStatus
  setUpdateStatus(next: UpdateStatus | undefined): Promise<void>
}

export interface AutoUpdateDeps {
  readonly manager: () => PluginManagerLike | undefined
  readonly store: UpdateStore
  readonly settings: () => DotSettings
  /** The swap unloads this plugin, so it runs only when nothing can interrupt it. */
  readonly isQuiet: () => boolean
  readonly now: () => number
  readonly timer: Timer
  readonly log?: (message: string) => void
  readonly emit?: (input: DotTraceInput) => void
}

/** The next local noon strictly after `now`. */
export function nextCheckAt(now: number): number {
  const next = new Date(now)
  next.setHours(CHECK_HOUR, 0, 0, 0)
  if (next.getTime() <= now) next.setDate(next.getDate() + 1)
  return next.getTime()
}

/** The most recent local noon at or before `now`. */
export function lastBoundary(now: number): number {
  const last = new Date(now)
  last.setHours(CHECK_HOUR, 0, 0, 0)
  if (last.getTime() > now) last.setDate(last.getDate() - 1)
  return last.getTime()
}

/** A semver prerelease carries a '-' on the numeric part; build metadata does not count. */
const isPrerelease = (version: string): boolean => version.split('+', 1)[0]!.includes('-')

/** First installable row of a newest-first list already newer than the installed version. */
export function pickUpdate(installed: string, versions: readonly UpdatePluginVersion[]): UpdatePluginVersion | undefined {
  const allowPrerelease = isPrerelease(installed)
  return versions.find(version => version.bundle && !version.deprecated && !version.incompatible && (allowPrerelease || !version.prerelease))
}

const textOf = (error: unknown): string => error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'

/** The manager's ManagementError, or any thrown value, as one line. */
const errorText = (error: unknown): string | undefined => {
  if (typeof error === 'string') return error || undefined
  if (!error || typeof error !== 'object') return undefined
  const row = error as { diagnostic?: unknown; message?: unknown; code?: unknown }
  if (typeof row.diagnostic === 'string' && row.diagnostic) return row.diagnostic
  if (typeof row.message === 'string' && row.message) return row.message
  return typeof row.code === 'string' ? row.code : undefined
}

export class AutoUpdater {
  private checkTimer?: unknown
  private quietCancel?: () => void
  private active?: { readonly gen: number; readonly promise: Promise<UpdateStatus> }
  /** Bumped to supersede a check still waiting for its quiet gap. */
  private generation = 0
  private disposed = false

  constructor(private readonly deps: AutoUpdateDeps) {}

  /** Resolve an apply the last process never saw settle, then arm the daily schedule. */
  start(): void {
    if (this.disposed || this.deps.settings().autoUpdate === false) return
    void this.resolvePending().then(() => this.scheduleNext(), () => this.scheduleNext())
  }

  /** An immediate check; one already running is shared. The daily schedule re-arms afterwards. */
  checkNow(): Promise<UpdateStatus> {
    if (this.disposed) return Promise.resolve(this.deps.store.updateStatus ?? {})
    const gen = this.generation
    if (this.active?.gen === gen) return this.active.promise
    this.clearCheckTimer()
    const promise = this.runCheck(gen)
      .catch(error => this.record(gen, { kind: 'failed', at: this.deps.now(), message: textOf(error) }))
      .finally(() => {
        if (this.active?.promise === promise) this.active = undefined
        this.scheduleNext()
      })
    this.active = { gen, promise }
    return promise
  }

  /** Off drops timers and any quiet wait; on (re)starts the schedule. */
  settingsChanged(): void {
    if (this.deps.settings().autoUpdate === false) {
      this.supersede()
      this.clearCheckTimer()
      return
    }
    this.start()
  }

  dispose(): void {
    this.disposed = true
    this.supersede()
    this.clearCheckTimer()
  }

  private supersede(): void {
    this.generation += 1
    this.quietCancel?.()
  }

  private clearCheckTimer(): void {
    if (this.checkTimer !== undefined) this.deps.timer.clear(this.checkTimer)
    this.checkTimer = undefined
  }

  /** A missed noon is made up quickly; an unmissed one lands on the next. */
  private scheduleNext(): void {
    this.clearCheckTimer()
    if (this.disposed || this.deps.settings().autoUpdate === false) return
    const now = this.deps.now()
    const lastCheckAt = this.deps.store.updateStatus?.lastCheckAt
    const missed = lastCheckAt === undefined || lastCheckAt < lastBoundary(now)
    this.checkTimer = this.deps.timer.set(() => {
      this.checkTimer = undefined
      this.supersede()
      void this.checkNow()
    }, missed ? MISSED_DELAY_MS : Math.max(0, nextCheckAt(now) - now))
  }

  private async runCheck(gen: number): Promise<UpdateStatus> {
    const result = await this.evaluate(gen)
    // A check superseded while it waited for quiet leaves the status to the newer check.
    if (result === undefined) return this.deps.store.updateStatus ?? {}
    return this.record(gen, result)
  }

  /** Persist one check outcome and trace it. A stale check never writes. */
  private async record(gen: number, result: UpdateResult): Promise<UpdateStatus> {
    if (gen !== this.generation) return this.deps.store.updateStatus ?? {}
    const status: UpdateStatus = { lastCheckAt: result.at, lastResult: result }
    await this.save(status)
    this.traceResult(result)
    return status
  }

  /** One check: find a newer registry version of this bundle and apply it once quiet. */
  private async evaluate(gen: number): Promise<UpdateResult | undefined> {
    const at = this.deps.now()
    const manager = this.deps.manager()
    if (!manager) return { kind: 'unavailable', at }
    const own = (await manager.listBundles()).find(row => row.name === PACKAGE_NAME)
    if (!own || own.update !== 'registry') return { kind: 'not-updatable', at }
    const list = await manager.listVersions(PACKAGE_NAME)
    if (list.status !== 'listed') return { kind: 'failed', at, message: `${list.problem}: ${list.reason}` }
    const installed = own.version ?? list.installed
    const target = pickUpdate(installed, list.versions)
    if (!target) return { kind: 'up-to-date', at }
    if (!await this.waitQuiet(gen)) return undefined
    const from = installed
    const to = target.version
    // Before the call the manager may not let settle: on restart, own version
    // decides whether the swap took effect.
    await this.save({ ...this.deps.store.updateStatus, pending: { from, to, at: this.deps.now() } })
    let outcome: UpdateOutcome
    try {
      outcome = await manager.updateBundle(PACKAGE_NAME, to, { registry: list.registry })
    } catch (error) {
      return { kind: 'failed', at: this.deps.now(), from, to, message: textOf(error) }
    }
    const application = outcome.result.application
    if (application === 'applied') return { kind: 'updated', at: this.deps.now(), from: outcome.from, to: outcome.to }
    if (application === 'restart-required') return { kind: 'restart-required', at: this.deps.now(), from: outcome.from, to: outcome.to }
    return { kind: 'failed', at: this.deps.now(), from: outcome.from, to: outcome.to, message: errorText(outcome.result.error) ?? `update ${application}` }
  }

  /** True once dot is quiet; false when superseded, disposed or turned off. */
  private waitQuiet(gen: number): Promise<boolean> {
    if (this.deps.isQuiet()) return Promise.resolve(true)
    return new Promise(resolve => {
      const arm = () => {
        const handle = this.deps.timer.set(poll, QUIET_POLL_MS)
        this.quietCancel = () => { this.deps.timer.clear(handle); resolve(false) }
      }
      const poll = () => {
        this.quietCancel = undefined
        if (this.disposed || gen !== this.generation || this.deps.settings().autoUpdate === false) { resolve(false); return }
        if (this.deps.isQuiet()) { resolve(true); return }
        arm()
      }
      arm()
    })
  }

  /** An apply interrupted mid-swap is judged by which version came up. */
  private async resolvePending(): Promise<void> {
    const status = this.deps.store.updateStatus
    const pending = status?.pending
    if (!pending) return
    try {
      const manager = this.deps.manager()
      if (!manager) throw new Error('plugin manager unavailable')
      const own = (await manager.listBundles()).find(row => row.name === PACKAGE_NAME)
      const at = this.deps.now()
      const result: UpdateResult = own?.version === pending.to
        ? { kind: 'updated', at, from: pending.from, to: pending.to }
        : { kind: 'failed', at, from: pending.from, to: pending.to, message: `update to ${pending.to} did not take effect` }
      await this.save({ ...status?.lastCheckAt !== undefined ? { lastCheckAt: status.lastCheckAt } : {}, lastResult: result })
      this.traceResult(result)
    } catch (error) {
      this.deps.log?.(`dsh-dot: pending update resolution failed: ${textOf(error)}`)
      const kept: UpdateStatus = {
        ...status?.lastCheckAt !== undefined ? { lastCheckAt: status.lastCheckAt } : {},
        ...status?.lastResult ? { lastResult: status.lastResult } : {},
      }
      await this.save(Object.keys(kept).length > 0 ? kept : undefined)
    }
  }

  private async save(status: UpdateStatus | undefined): Promise<void> {
    try {
      await this.deps.store.setUpdateStatus(status)
    } catch (error) {
      this.deps.log?.(`dsh-dot: update status could not be persisted: ${textOf(error)}`)
    }
  }

  private traceResult(result: UpdateResult): void {
    const emit = this.deps.emit
    if (!emit) return
    emit({ event: DOT_TRACE.updateChecked, message: 'Self-update check finished.', data: { kind: result.kind } })
    if (result.kind === 'updated' || result.kind === 'restart-required') {
      emit({ event: DOT_TRACE.updateApplied, message: `Dot ${result.kind === 'updated' ? 'updated' : 'update applied, restart pending'}${result.to ? ` to ${result.to}` : ''}.`, data: { ...(result.from ? { from: result.from } : {}), ...(result.to ? { to: result.to } : {}) } })
    } else if (result.kind === 'failed') {
      emit({ event: DOT_TRACE.updateFailed, level: 'warn', message: `Self-update failed${result.message ? `: ${result.message}` : ''}.` })
    }
  }
}
