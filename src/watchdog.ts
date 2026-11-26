import { z } from 'zod'
import { realTimer, type Timer } from './batcher.ts'
import {
  WATCHDOG_PRESET_ID,
  type DotSettings,
  type ModelChoice,
  type WatchdogAnnotation,
  type WatchdogCalibrationStats,
  type WatchdogDiagnosticsView,
  type WatchdogHitRecord,
  type WatchdogMode,
  type WatchdogModelFallbackNotice,
  type WatchdogSignalType,
  type WatchdogVerdict,
} from './contracts.ts'
import type { DotHost } from './host.ts'
import type { WaitInterval } from './pending.ts'
import { parseWatchdogModelChoice } from './settings.ts'
import { parseWatchdogStoredEntry, type WatchdogStoredEntry } from './storage.ts'
import type { DotTable } from './store.ts'
import { DOT_TRACE, type DotTraceInput } from './trace.ts'
import {
  WatchdogSignalDetector,
  runRevisionKey,
  type PatrolCheckInput,
  type RunSignalContext,
  type WatchdogSessionEvent,
  type WatchdogSignalHit,
} from './watchdog-signals.ts'
import { runIsTerminal, type ChangeRecord, type InputRecord, type RunRecord } from './work.ts'

export { WATCHDOG_PRESET_ID }

/** Hidden read-only judge preset mounts zero tools (persona + time-context only). */
export const WATCHDOG_ALLOW = [] as const

export const WATCHDOG_TIMEOUT_MS = 30_000
export const WATCHDOG_PATROL_MS = 5 * 60_000
export const WATCHDOG_COOLDOWN_MS = 10 * 60_000
export const WATCHDOG_CALIBRATION_WINDOW_DAYS = 14
const DAY_MS = 86_400_000
const MAX_STORED_HITS = 500
const META_KEY = 'meta'

export const WATCHDOG_INSTRUCTIONS = [
  'You are dot-watchdog, a strictly read-only run-health judge.',
  'You have no file, shell, task, or settings tools. Do not attempt to edit files, modify prompts, change trigger rules, or adjust settings.',
  'Analyze the provided run goal, deterministic signal hit, and evidence, then respond ONLY with a single JSON object matching this exact schema:',
  '{"verdict":"progressing"|"spinning"|"off-scope","confidence":"low"|"medium"|"high","summary":"concise 1-2 sentence explanation","evidence":["short factual bullet",...]}',
].join('\n')

export const watchdogVerdictSchema = z.object({
  verdict: z.enum(['progressing', 'spinning', 'off-scope']),
  confidence: z.enum(['low', 'medium', 'high']),
  summary: z.string().trim().min(1).max(1000),
  evidence: z.array(z.string().trim().min(1).max(400)).max(20),
}).strict()

/** Parse and strictly validate the judge's JSON verdict reply (raw or ```json fenced). */
export function parseWatchdogVerdict(rawText: string | undefined): WatchdogVerdict | undefined {
  if (!rawText) return undefined
  const trimmed = rawText.trim()
  if (!trimmed) return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = fenced ? fenced[1]!.trim() : trimmed
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      parsedJson = JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
  const validated = watchdogVerdictSchema.safeParse(parsedJson)
  return validated.success ? validated.data : undefined
}

export function computeCalibrationStats(
  hits: readonly WatchdogHitRecord[],
  now: number,
): WatchdogCalibrationStats {
  const cutoff = now - WATCHDOG_CALIBRATION_WINDOW_DAYS * DAY_MS
  let total14d = 0
  let reviewed14d = 0
  let accurate14d = 0
  let falsePositive14d = 0
  for (const hit of hits) {
    if (hit.at < cutoff) continue
    total14d += 1
    if (hit.annotation === 'accurate') {
      reviewed14d += 1
      accurate14d += 1
    } else if (hit.annotation === 'false-positive') {
      reviewed14d += 1
      falsePositive14d += 1
    }
  }
  return {
    windowDays: WATCHDOG_CALIBRATION_WINDOW_DAYS,
    total14d,
    reviewed14d,
    accurate14d,
    falsePositive14d,
    falsePositiveRate: reviewed14d > 0 ? falsePositive14d / reviewed14d : null,
  }
}

interface WatchdogMetaState {
  watchdogStops: number
  stopsByRun: Record<string, number>
  stopsByInput: Record<string, number>
  modelFallbackNotice?: WatchdogModelFallbackNotice
}

function hitKey(id: string): string {
  return `hit-${id}`
}

function toStoredHit(hit: WatchdogHitRecord): WatchdogStoredEntry {
  const { evidence, judge, ...rest } = hit
  return {
    kind: 'hit',
    ...rest,
    evidence: [...evidence],
    ...(judge ? { judge: { ...judge, evidence: [...judge.evidence] } } : {}),
  }
}

export class WatchdogStore {
  private readonly hits = new Map<string, WatchdogHitRecord>()
  private meta: WatchdogMetaState = { watchdogStops: 0, stopsByRun: {}, stopsByInput: {} }
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly table: DotTable | undefined) {
    if (table) {
      for (const [, value] of table.entries()) {
        const parsed = parseWatchdogStoredEntry(value)
        if (!parsed) continue
        if (parsed.kind === 'meta') {
          this.meta = {
            watchdogStops: parsed.watchdogStops,
            stopsByRun: { ...(parsed.stopsByRun ?? {}) },
            stopsByInput: { ...(parsed.stopsByInput ?? {}) },
            ...(parsed.modelFallbackNotice ? { modelFallbackNotice: parsed.modelFallbackNotice } : {}),
          }
        } else {
          const { kind: _kind, ...hit } = parsed
          this.hits.set(hit.id, hit)
        }
      }
    }
  }

  get watchdogStops(): number { return this.meta.watchdogStops }
  get modelFallbackNotice(): WatchdogModelFallbackNotice | undefined { return this.meta.modelFallbackNotice }

  listHits(): WatchdogHitRecord[] {
    return [...this.hits.values()].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
  }

  getHit(id: string): WatchdogHitRecord | undefined {
    return this.hits.get(id)
  }

  runStopCount(runId: string): number {
    return this.meta.stopsByRun[runId] ?? 0
  }

  inputStopCount(changeId: string, inputRef: string, inputRevision: number): number {
    return this.meta.stopsByInput[`${changeId}\0${inputRef}\0${inputRevision}`] ?? 0
  }

  recordHit(hit: WatchdogHitRecord): Promise<void> {
    this.hits.set(hit.id, hit)
    const evicted: string[] = []
    if (this.hits.size > MAX_STORED_HITS) {
      const oldestFirst = [...this.hits.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
      const dropCount = this.hits.size - MAX_STORED_HITS
      for (let i = 0; i < dropCount; i++) {
        const dropId = oldestFirst[i]!.id
        this.hits.delete(dropId)
        evicted.push(dropId)
      }
    }
    const stored = toStoredHit(hit)
    return this.enqueue(async () => {
      if (!this.table) return
      await this.table.put(hitKey(hit.id), stored)
      for (const id of evicted) await this.table.delete(hitKey(id))
    })
  }

  annotateHit(id: string, annotation: WatchdogAnnotation, at: number): Promise<WatchdogHitRecord | undefined> {
    const existing = this.hits.get(id)
    if (!existing) return Promise.resolve(undefined)
    const next: WatchdogHitRecord = { ...existing, annotation, annotatedAt: at }
    this.hits.set(id, next)
    const stored = toStoredHit(next)
    return this.enqueue(async () => {
      if (this.table) await this.table.put(hitKey(id), stored)
      return next
    })
  }

  incrementStops(runId: string, changeId: string, inputRef: string, inputRevision: number): { readonly totalStops: number; readonly scopeStops: number; readonly persisted: Promise<void> } {
    const inputKey = `${changeId}\0${inputRef}\0${inputRevision}`
    const runStops = (this.meta.stopsByRun[runId] ?? 0) + 1
    const inputStops = (this.meta.stopsByInput[inputKey] ?? 0) + 1
    this.meta = {
      ...this.meta,
      watchdogStops: this.meta.watchdogStops + 1,
      stopsByRun: { ...this.meta.stopsByRun, [runId]: runStops },
      stopsByInput: { ...this.meta.stopsByInput, [inputKey]: inputStops },
    }
    return {
      totalStops: this.meta.watchdogStops,
      scopeStops: Math.max(runStops, inputStops),
      persisted: this.persistMeta(),
    }
  }

  setModelFallbackNotice(notice: WatchdogModelFallbackNotice | undefined): Promise<void> {
    const prev = this.meta.modelFallbackNotice
    if (!prev && !notice) return Promise.resolve()
    if (prev && notice && prev.configuredModel === notice.configuredModel && prev.reason === notice.reason && prev.detail === notice.detail) {
      return Promise.resolve()
    }
    this.meta = {
      watchdogStops: this.meta.watchdogStops,
      stopsByRun: this.meta.stopsByRun,
      stopsByInput: this.meta.stopsByInput,
      ...(notice ? { modelFallbackNotice: notice } : {}),
    }
    return this.persistMeta()
  }

  async clear(): Promise<void> {
    const ids = [...this.hits.keys()]
    this.hits.clear()
    this.meta = { watchdogStops: 0, stopsByRun: {}, stopsByInput: {} }
    await this.enqueue(async () => {
      if (!this.table) return
      await this.table.delete(META_KEY)
      for (const id of ids) await this.table.delete(hitKey(id))
    })
  }

  flush(): Promise<void> {
    return this.tail.then(() => undefined, () => undefined)
  }

  private persistMeta(): Promise<void> {
    const stored: WatchdogStoredEntry = {
      kind: 'meta',
      watchdogStops: this.meta.watchdogStops,
      stopsByRun: this.meta.stopsByRun,
      stopsByInput: this.meta.stopsByInput,
      ...(this.meta.modelFallbackNotice ? { modelFallbackNotice: this.meta.modelFallbackNotice } : {}),
    }
    return this.enqueue(async () => {
      if (this.table) await this.table.put(META_KEY, stored)
    })
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work)
    this.tail = next.catch(() => undefined)
    return next
  }
}

export interface WatchdogHostApi {
  createInternal: DotHost['createInternal']
  promptInternal: DotHost['promptInternal']
  waitIdle: DotHost['waitIdle']
  releaseInternal: DotHost['releaseInternal']
  latestReply: DotHost['latestReply']
  stop: DotHost['stop']
  readEvents?: DotHost['readEvents']
  isRunning: DotHost['isRunning']
  listModels?: DotHost['listModels']
}

export interface WatchdogNoticeInput {
  readonly changeId: string
  readonly runId: string
  readonly sessionId: string
  readonly subject: string
  readonly summary: string
  readonly text: string
  readonly humanRequired?: boolean
  readonly detail?: string
}

export interface WatchdogRunnerOptions {
  readonly host: WatchdogHostApi
  readonly table?: DotTable
  readonly homeDir: string
  readonly now: () => number
  readonly timer?: Timer
  readonly settings: () => Pick<DotSettings, 'watchdogMode' | 'watchdogModel'>
  readonly runs: () => readonly RunRecord[]
  readonly sessionRun: (sessionId: string) => RunRecord | undefined
  readonly change: (changeId: string) => ChangeRecord | undefined
  readonly input: (inputRef: string) => InputRecord | undefined
  readonly isQuietWaitActive: (sessionId: string) => boolean
  readonly pendingWaitIntervals: (sessionId: string, now: number) => readonly WaitInterval[]
  readonly hasOpenPending: (sessionId: string) => boolean
  readonly retryStatus: (sessionId: string) => { readonly kind: 'budget' | 'transient'; readonly since: string; readonly accumulatedMs?: number } | undefined
  readonly stopRun: (run: RunRecord, hit: WatchdogSignalHit, summary: string) => Promise<boolean>
  readonly notifyDorothy: (notice: WatchdogNoticeInput) => void
  readonly trace: (input: DotTraceInput) => void
  readonly log?: (message: string) => void
  readonly onChange?: () => void
  readonly patrolMs?: number
  readonly timeoutMs?: number
  readonly cooldownMs?: number
}

function runSignalContext(run: RunRecord): RunSignalContext | undefined {
  const sessionId = run.sessionId ?? run.requestedSessionId
  if (!sessionId) return undefined
  return {
    runId: run.id,
    changeId: run.changeId,
    inputRef: run.inputRef,
    inputRevision: run.inputRevision,
    sessionId,
    phase: run.phase,
    startedAt: run.createdAt,
  }
}

export class WatchdogRunner {
  readonly detector = new WatchdogSignalDetector()
  readonly store: WatchdogStore

  private patrolHandle: unknown
  private started = false
  private disposed = false
  private judgeBusy = false
  private activeJudgeSessionId: string | undefined
  private activeJudgeRun: Promise<void> | undefined
  private readonly activeStops = new Set<Promise<void>>()
  private readonly stoppingRunKeys = new Set<string>()
  private readonly stoppedRunKeys = new Set<string>()
  private hitSeq = 0
  private lastWatchedModel: string | undefined

  /** Cooldown timestamp of last judge invocation per `${runId}@${inputRevision}`. */
  private readonly lastJudgeAt = new Map<string, number>()
  /** Consecutive high-confidence `'spinning'` verdicts per `${runId}@${inputRevision}`. */
  private readonly consecutiveHighSpinning = new Map<string, number>()
  /** Last persisted hit time per `${runId}@${inputRevision}:${signal}` to deduplicate repeated fires within cooldown. */
  private readonly lastHitRecordedAt = new Map<string, number>()
  /** Live agent status observed via Cordis events / backfill. */
  private readonly agentStatuses = new Map<string, 'running' | 'idle'>()

  constructor(private readonly options: WatchdogRunnerOptions) {
    this.store = new WatchdogStore(options.table)
    this.lastWatchedModel = options.settings().watchdogModel
  }

  private get timer(): Timer { return this.options.timer ?? realTimer }
  private get patrolMs(): number { return this.options.patrolMs ?? WATCHDOG_PATROL_MS }
  private get timeoutMs(): number { return this.options.timeoutMs ?? WATCHDOG_TIMEOUT_MS }
  private get cooldownMs(): number { return this.options.cooldownMs ?? WATCHDOG_COOLDOWN_MS }
  private get mode(): WatchdogMode { return this.options.settings().watchdogMode }

  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    if (this.mode !== 'off') this.armPatrol()
  }

  onSettingsChanged(): void {
    if (this.disposed) return
    const { watchdogMode, watchdogModel } = this.options.settings()
    if (watchdogModel !== this.lastWatchedModel) {
      this.lastWatchedModel = watchdogModel
      void this.store.setModelFallbackNotice(undefined).then(() => this.options.onChange?.())
    }
    if (watchdogMode === 'off') {
      this.clearPatrol()
      if (this.activeJudgeSessionId) {
        void this.options.host.stop(this.activeJudgeSessionId).catch(() => undefined)
      }
    } else if (this.started && this.patrolHandle === undefined) {
      this.armPatrol()
    }
  }

  private armPatrol(): void {
    this.clearPatrol()
    if (this.disposed || this.mode === 'off') return
    const handle = this.timer.set(() => {
      this.patrolHandle = undefined
      void this.patrolNow().finally(() => {
        if (!this.disposed && this.started && this.mode !== 'off') this.armPatrol()
      })
    }, this.patrolMs)
    ;(handle as { unref?: () => void } | undefined)?.unref?.()
    this.patrolHandle = handle
  }

  private clearPatrol(): void {
    if (this.patrolHandle !== undefined) {
      this.timer.clear(this.patrolHandle)
      this.patrolHandle = undefined
    }
  }

  onAgentStatus(sessionId: string, status: 'running' | 'idle'): void {
    this.agentStatuses.set(sessionId, status)
  }

  onAgentCreated(sessionId: string, status: 'idle' | 'running', events: readonly WatchdogSessionEvent[]): void {
    this.agentStatuses.set(sessionId, status)
    if (this.disposed || this.mode === 'off') return
    const run = this.options.sessionRun(sessionId)
    if (!run || runIsTerminal(run)) return
    const ctx = runSignalContext(run)
    if (!ctx) return
    for (const event of events) {
      this.detector.observeEvent(ctx, event, event.time ?? this.options.now())
    }
  }

  onSessionEvent(sessionId: string, event: WatchdogSessionEvent): void {
    if (this.disposed || this.mode === 'off') return
    const run = this.options.sessionRun(sessionId)
    if (!run || runIsTerminal(run)) return
    const ctx = runSignalContext(run)
    if (!ctx) return
    const now = this.options.now()
    const result = this.detector.observeEvent(ctx, event, event.time ?? now)
    if (result.substantiveProgress) {
      this.consecutiveHighSpinning.set(runRevisionKey(run.id, run.inputRevision), 0)
      this.clearHitDedup(runRevisionKey(run.id, run.inputRevision), ['no-progress', 'compaction-loop'])
    }
    if (result.recovered) {
      this.clearHitDedup(runRevisionKey(run.id, run.inputRevision), ['infra-failure'])
    }
    for (const hit of result.hits) {
      this.handleHit(run, hit)
    }
  }

  onAgentError(sessionId: string, error: unknown): void {
    if (this.disposed || this.mode === 'off') return
    const run = this.options.sessionRun(sessionId)
    if (!run || runIsTerminal(run)) return
    const ctx = runSignalContext(run)
    if (!ctx) return
    const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : 'agent/error'
    const hit = this.detector.noteAgentError(ctx, detail, this.options.now())
    if (hit) this.handleHit(run, hit)
  }

  noteQuietWait(sessionId: string, active: boolean, at = this.options.now()): void {
    const run = this.options.sessionRun(sessionId)
    if (!run || runIsTerminal(run)) return
    const ctx = runSignalContext(run)
    if (ctx) this.detector.noteQuietWait(ctx, active, at)
  }

  noteRetryState(
    sessionId: string,
    status: { readonly kind: 'budget' | 'transient'; readonly since: string } | undefined,
    at = this.options.now(),
  ): void {
    const run = this.options.sessionRun(sessionId)
    if (!run || runIsTerminal(run)) return
    const ctx = runSignalContext(run)
    if (ctx) this.detector.noteRetryState(ctx, status, at)
  }

  noteReconcileFailure(run: RunRecord, detail: string, at = this.options.now()): void {
    if (this.disposed || this.mode === 'off' || runIsTerminal(run)) return
    const ctx = runSignalContext(run)
    if (!ctx) return
    const hit = this.detector.noteInfraFailure(ctx, 'reconcile-failed', detail, at)
    this.handleHit(run, hit)
  }

  noteReconcileSuccess(run: RunRecord): void {
    const ctx = runSignalContext(run)
    if (!ctx) return
    if (this.detector.noteInfraRecovered(ctx)) {
      this.clearHitDedup(runRevisionKey(run.id, run.inputRevision), ['infra-failure'])
    }
  }

  noteStreamBackfillFailure(run: RunRecord, detail: string, at = this.options.now()): void {
    if (this.disposed || this.mode === 'off' || runIsTerminal(run)) return
    const ctx = runSignalContext(run)
    if (!ctx) return
    const hit = this.detector.noteInfraFailure(ctx, 'stream-disconnect', detail, at)
    this.handleHit(run, hit)
  }

  noteSessionDisposed(sessionId: string): void {
    this.agentStatuses.delete(sessionId)
  }

  async patrolNow(): Promise<WatchdogSignalHit[]> {
    if (this.disposed || this.mode === 'off') return []
    const now = this.options.now()
    const allHits: WatchdogSignalHit[] = []
    for (const run of this.options.runs()) {
      if (this.disposed) break
      if (runIsTerminal(run)) continue
      const ctx = runSignalContext(run)
      if (!ctx) continue
      const sessionId = ctx.sessionId
      let agentStatus: PatrolCheckInput['agentStatus']
      if (typeof this.options.host.isRunning === 'function') {
        const liveRunning = this.options.host.isRunning(sessionId)
        if (liveRunning) {
          agentStatus = 'running'
        } else {
          agentStatus = 'idle'
          if (this.agentStatuses.get(sessionId) === 'running') {
            this.agentStatuses.set(sessionId, 'idle')
          }
        }
      } else {
        const recordedStatus = this.agentStatuses.get(sessionId)
        agentStatus = recordedStatus === 'running'
          ? 'running'
          : recordedStatus === 'idle'
            ? 'idle'
            : 'unknown'
      }
      const hits = this.detector.evaluatePatrol({
        run: ctx,
        agentStatus,
        now,
        quietWaitActive: this.options.isQuietWaitActive(sessionId),
        pendingWaitIntervals: this.options.pendingWaitIntervals(sessionId, now),
        hasOpenPending: this.options.hasOpenPending(sessionId),
        retryStatus: this.options.retryStatus(sessionId),
      })
      for (const hit of hits) {
        allHits.push(hit)
        this.handleHit(run, hit)
      }
    }
    await this.activeJudgeRun?.catch(() => undefined)
    await this.store.flush()
    return allHits
  }

  async flushJudge(): Promise<void> {
    await this.activeJudgeRun?.catch(() => undefined)
    await Promise.allSettled([...this.activeStops])
    await this.store.flush()
  }

  async annotateHit(id: string, annotation: WatchdogAnnotation): Promise<WatchdogHitRecord | undefined> {
    const at = this.options.now()
    const updated = await this.store.annotateHit(id, annotation, at)
    if (!updated) return undefined
    this.options.trace({
      event: DOT_TRACE.watchdogAnnotate,
      message: `Annotated watchdog hit ${id} as ${annotation}.`,
      changeId: updated.changeId,
      sessionId: updated.sessionId,
      data: { hitId: id, runId: updated.runId, signal: updated.signal, annotation },
    })
    this.options.onChange?.()
    return updated
  }

  diagnosticsView(): WatchdogDiagnosticsView {
    const now = this.options.now()
    const { watchdogMode, watchdogModel } = this.options.settings()
    const hits = this.store.listHits()
    const fallback = this.store.modelFallbackNotice
    return {
      mode: watchdogMode,
      ...(watchdogModel ? { configuredModel: watchdogModel } : {}),
      watchdogStops: this.store.watchdogStops,
      ...(fallback ? { modelFallbackNotice: fallback } : {}),
      calibration: computeCalibrationStats(hits, now),
      hits,
    }
  }

  formatDiagnosticsReport(query: { readonly runId?: string; readonly changeId?: string; readonly signal?: string; readonly limit?: number } = {}): string {
    const view = this.diagnosticsView()
    const limit = Math.max(1, Math.min(50, Math.trunc(query.limit ?? 15)))
    const filtered = view.hits.filter(hit => {
      if (query.runId && hit.runId !== query.runId) return false
      if (query.changeId && hit.changeId !== query.changeId) return false
      if (query.signal && hit.signal !== query.signal) return false
      return true
    }).slice(0, limit)
    const cal = view.calibration
    const fpText = cal.falsePositiveRate === null
      ? 'n/a (0 reviewed)'
      : `${(cal.falsePositiveRate * 100).toFixed(1)}% (${cal.falsePositive14d}/${cal.reviewed14d})`
    const lines = [
      `Watchdog status (read-only): mode=${view.mode}, model=${view.configuredModel ?? '(host default)'}, watchdogStops=${view.watchdogStops}`,
      `14d calibration: totalHits=${cal.total14d}, reviewed=${cal.reviewed14d}, accurate=${cal.accurate14d}, falsePositive=${cal.falsePositive14d}, falsePositiveRate=${fpText}`,
    ]
    if (view.modelFallbackNotice) {
      lines.push(`Model fallback active: configured "${view.modelFallbackNotice.configuredModel}" unavailable (${view.modelFallbackNotice.reason}${view.modelFallbackNotice.detail ? `: ${view.modelFallbackNotice.detail}` : ''}); running deterministic signals only.`)
    }
    if (filtered.length === 0) {
      lines.push('Matching hits: none.')
    } else {
      lines.push(`Recent hits (${filtered.length}):`)
      for (const hit of filtered) {
        const stamp = new Date(hit.at).toISOString()
        const judgePart = hit.judge ? ` | judge=${hit.judge.verdict}(${hit.judge.confidence}): ${hit.judge.summary}` : ''
        const stopPart = hit.stopped ? ' | AUTO-STOPPED' : ''
        const annPart = hit.annotation ? ` | review=${hit.annotation}` : ''
        lines.push(`- [${hit.id}] ${stamp} signal=${hit.signal} run=${hit.runId} change=${hit.changeId} phase=${hit.runPhase}${stopPart}${annPart}${judgePart} | evidence: ${hit.evidence.join(', ')}`)
      }
    }
    lines.push('Watchdog is strictly read-only; propose setting changes via dot_settings action=propose.')
    return lines.join('\n')
  }

  async reset(): Promise<void> {
    this.clearPatrol()
    if (this.activeJudgeSessionId) {
      try { await this.options.host.stop(this.activeJudgeSessionId) } catch { /* best effort */ }
    }
    await this.activeJudgeRun?.catch(() => undefined)
    this.detector.clear()
    this.lastJudgeAt.clear()
    this.consecutiveHighSpinning.clear()
    this.lastHitRecordedAt.clear()
    this.stoppingRunKeys.clear()
    this.stoppedRunKeys.clear()
    this.agentStatuses.clear()
    await this.store.clear()
    this.options.onChange?.()
    if (!this.disposed && this.started && this.mode !== 'off') this.armPatrol()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.clearPatrol()
    if (this.activeJudgeSessionId) {
      try { await this.options.host.stop(this.activeJudgeSessionId) } catch { /* best effort */ }
    }
    await this.activeJudgeRun?.catch(() => undefined)
    this.activeJudgeRun = undefined
    await Promise.allSettled([...this.activeStops])
    await this.store.flush()
  }

  private clearHitDedup(runKey: string, signals: readonly WatchdogSignalType[]): void {
    for (const signal of signals) {
      this.lastHitRecordedAt.delete(`${runKey}:${signal}`)
    }
  }

  private currentRun(run: RunRecord): RunRecord {
    return this.options.runs().find(r => r.id === run.id) ?? run
  }

  private handleHit(run: RunRecord, hit: WatchdogSignalHit): void {
    const mode = this.mode
    if (this.disposed || mode === 'off') return
    const liveRun = this.currentRun(run)
    if (liveRun.phase !== 'active') return
    if (this.stoppingRunKeys.has(hit.runKey) || this.stoppedRunKeys.has(hit.runKey)) return
    const dedupKey = `${hit.runKey}:${hit.signal}`
    const prevAt = this.lastHitRecordedAt.get(dedupKey)
    if (prevAt !== undefined && hit.at - prevAt < this.cooldownMs && hit.hardLimitReached !== true) {
      return
    }
    this.lastHitRecordedAt.set(dedupKey, hit.at)
    this.hitSeq += 1
    const record: WatchdogHitRecord = {
      id: `wd-${hit.at.toString(36)}-${this.hitSeq.toString(36)}`,
      at: hit.at,
      runId: hit.runId,
      changeId: hit.changeId,
      inputRef: hit.inputRef,
      inputRevision: hit.inputRevision,
      sessionId: hit.sessionId,
      signal: hit.signal,
      runPhase: liveRun.phase,
      mode,
      evidence: [...hit.evidence],
      ...(hit.hardLimitReached ? { hardLimitReached: true } : {}),
    }
    void this.store.recordHit(record).then(() => this.options.onChange?.())
    this.options.trace({
      event: DOT_TRACE.watchdogHit,
      level: 'warn',
      message: `Watchdog signal ${hit.signal} fired on ${hit.runId}.`,
      changeId: hit.changeId,
      sessionId: hit.sessionId,
      data: {
        hitId: record.id,
        runId: hit.runId,
        inputRevision: hit.inputRevision,
        signal: hit.signal,
        mode,
        ...(hit.hardLimitReached ? { hardLimitReached: true } : {}),
      },
    })

    // Observe mode: strictly deterministic signals + trace/Diagnostics ONLY — zero judge model calls.
    if (mode === 'observe') return

    // Auto mode: hard single-turn same-error limit (>= 8) bypasses cooldown & judge.
    if (hit.signal === 'repeat-tool-error' && hit.hardLimitReached === true) {
      if (this.stoppingRunKeys.has(hit.runKey) || this.stoppedRunKeys.has(hit.runKey) || this.currentRun(liveRun).phase !== 'active') {
        return
      }
      this.trackStop(this.autoStopRun(liveRun, record, hit, 'Single-turn consecutive same-error hard limit reached (>= 8).'))
      return
    }

    // Signal 7 (infra-failure): patrol rechecks until recovered; NEVER stops the run.
    if (hit.signal === 'infra-failure') return

    // Invoke dot-watchdog judge only outside 10-min cooldown and when global concurrency (1) is free.
    const lastJudge = this.lastJudgeAt.get(hit.runKey)
    if (lastJudge !== undefined && hit.at - lastJudge < this.cooldownMs) return
    if (this.judgeBusy) return

    this.judgeBusy = true
    this.lastJudgeAt.set(hit.runKey, hit.at)
    const work = this.invokeJudge(run, record, hit)
      .catch(error => {
        this.options.log?.(`dsh-dot: watchdog judge failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        this.judgeBusy = false
        if (this.activeJudgeRun === work) this.activeJudgeRun = undefined
      })
    this.activeJudgeRun = work
  }

  private async resolveJudgeModel(): Promise<{ readonly ok: true; readonly choice: ModelChoice | null; readonly configuredModel?: string } | { readonly ok: false }> {
    const configured = this.options.settings().watchdogModel?.trim()
    if (!configured) {
      return { ok: true, choice: null }
    }
    const parsed = parseWatchdogModelChoice(configured)
    if (!parsed) {
      await this.recordModelFallback(configured, 'invalid-format', 'expected provider/model format')
      return { ok: false }
    }
    if (typeof this.options.host.listModels === 'function') {
      try {
        const catalog = await this.options.host.listModels()
        if (catalog.models.length > 0 && !catalog.models.some(m => m.provider === parsed.provider && m.model === parsed.model)) {
          await this.recordModelFallback(configured, 'not-in-catalog', 'model not found in host catalog')
          return { ok: false }
        }
      } catch {
        // If catalog query itself fails, still attempt createInternal and fall back on runtime failure.
      }
    }
    return { ok: true, choice: parsed, configuredModel: configured }
  }

  private async recordModelFallback(
    configuredModel: string,
    reason: WatchdogModelFallbackNotice['reason'],
    detail?: string,
  ): Promise<void> {
    const notice: WatchdogModelFallbackNotice = {
      configuredModel,
      reason,
      ...(detail ? { detail: detail.slice(0, 200) } : {}),
      at: this.options.now(),
    }
    await this.store.setModelFallbackNotice(notice)
    this.options.trace({
      event: DOT_TRACE.watchdogFallback,
      level: 'warn',
      message: `Watchdog model ${configuredModel} unavailable; degraded to deterministic signals.`,
      data: { configuredModel, reason },
    })
    this.options.onChange?.()
  }

  private buildJudgePrompt(run: RunRecord, hit: WatchdogSignalHit): string {
    const change = this.options.change(run.changeId)
    const input = this.options.input(run.inputRef)
    return [
      `Evaluate run ${run.id} (change ${run.changeId}${change ? ` "${change.title}"` : ''}, input ${run.inputRef}@${run.inputRevision}, phase ${run.phase}).`,
      ...(input?.goal ? [`Goal: ${input.goal.slice(0, 400)}`] : []),
      `Signal fired: ${hit.signal}`,
      `Evidence: ${hit.evidence.join(' | ')}`,
      'Reply strictly with a single JSON object: {"verdict":"progressing"|"spinning"|"off-scope","confidence":"low"|"medium"|"high","summary":"...","evidence":["..."]}.',
    ].join('\n')
  }

  private async invokeJudge(run: RunRecord, record: WatchdogHitRecord, hit: WatchdogSignalHit): Promise<void> {
    if (this.disposed || this.mode !== 'auto') return
    const resolved = await this.resolveJudgeModel()
    if (!resolved.ok || this.disposed) return

    let sessionId: string | undefined
    try {
      sessionId = await this.options.host.createInternal(this.options.homeDir, WATCHDOG_PRESET_ID, {
        allow: WATCHDOG_ALLOW,
        model: resolved.choice,
      })
      this.activeJudgeSessionId = sessionId
      if (this.disposed) return
      await this.options.host.promptInternal(sessionId, this.buildJudgePrompt(run, hit))
      await this.options.host.waitIdle(sessionId, this.timeoutMs)
      if (this.disposed) return

      // Check for turn/end(error) in the internal judge session before reading latestReply.
      if (typeof this.options.host.readEvents === 'function') {
        const events = await this.options.host.readEvents(sessionId).catch(() => [])
        const failedTurn = [...events].reverse().find(ev => {
          if (ev.type !== 'turn/end') return false
          const reason = (ev.data as { reason?: { kind?: unknown; error?: { message?: unknown } } } | undefined)?.reason
          return reason?.kind === 'error'
        })
        if (failedTurn) {
          const errMsg = (failedTurn.data as { reason?: { error?: { message?: unknown } } } | undefined)?.reason?.error?.message
          await this.recordModelFallback(
            resolved.configuredModel ?? '(host default)',
            'runtime-error',
            typeof errMsg === 'string' ? errMsg : 'judge turn ended with error',
          )
          return
        }
      }

      const reply = await this.options.host.latestReply(sessionId, 4000)
      const verdict = parseWatchdogVerdict(reply)
      if (!verdict) {
        this.options.log?.(`dsh-dot: watchdog judge returned invalid verdict for ${run.id}`)
        return
      }
      const updatedRecord: WatchdogHitRecord = { ...record, judge: verdict }
      await this.store.recordHit(updatedRecord)
      this.options.onChange?.()
      this.options.trace({
        event: DOT_TRACE.watchdogJudge,
        message: `Watchdog judge verdict for ${run.id}: ${verdict.verdict} (${verdict.confidence}).`,
        changeId: run.changeId,
        sessionId: hit.sessionId,
        data: { hitId: record.id, runId: run.id, signal: hit.signal, verdict: verdict.verdict, confidence: verdict.confidence },
      })

      if (verdict.verdict === 'progressing') {
        this.consecutiveHighSpinning.set(hit.runKey, 0)
        return
      }

      if (verdict.verdict === 'spinning' && verdict.confidence === 'high') {
        const count = (this.consecutiveHighSpinning.get(hit.runKey) ?? 0) + 1
        this.consecutiveHighSpinning.set(hit.runKey, count)
        if (count === 1) {
          this.sendWatchdogAlert(run, hit, verdict)
          return
        }
        await this.autoStopRun(run, updatedRecord, hit, verdict.summary)
        return
      }

      this.consecutiveHighSpinning.set(hit.runKey, 0)
      if (verdict.confidence === 'medium' || verdict.confidence === 'high') {
        this.sendWatchdogAlert(run, hit, verdict)
      }
    } catch (error) {
      if (!this.disposed) {
        const msg = error instanceof Error ? error.message : String(error)
        await this.recordModelFallback(resolved.configuredModel ?? '(host default)', 'runtime-error', msg)
      }
    } finally {
      this.activeJudgeSessionId = undefined
      if (sessionId) {
        await this.options.host.releaseInternal(sessionId).catch(() => undefined)
      }
    }
  }

  private sendWatchdogAlert(run: RunRecord, hit: WatchdogSignalHit, verdict: WatchdogVerdict): void {
    const summary = `${verdict.verdict} (${verdict.confidence}): ${verdict.summary}`
    this.options.notifyDorothy({
      changeId: run.changeId,
      runId: run.id,
      sessionId: hit.sessionId,
      subject: `Watchdog ${verdict.verdict} on ${run.id}`,
      summary,
      text: `Watchdog detected ${verdict.verdict} (${verdict.confidence}) on ${run.id} [${hit.signal}]: ${verdict.summary}. Evidence: ${verdict.evidence.join('; ') || hit.evidence.join('; ')}. Decide whether to supplement guidance or stop the run.`,
    })
  }

  private trackStop(promise: Promise<void>): void {
    this.activeStops.add(promise)
    void promise.finally(() => { this.activeStops.delete(promise) })
  }

  private async autoStopRun(run: RunRecord, record: WatchdogHitRecord, hit: WatchdogSignalHit, summary: string): Promise<void> {
    if (this.disposed) return
    const liveRun = this.currentRun(run)
    if (liveRun.phase !== 'active') return
    if (this.stoppingRunKeys.has(hit.runKey) || this.stoppedRunKeys.has(hit.runKey)) return

    this.stoppingRunKeys.add(hit.runKey)
    try {
      const stopped = await this.options.stopRun(liveRun, hit, summary)
      if (!stopped) {
        this.options.log?.(`dsh-dot: watchdog stop refused or unconfirmed for ${liveRun.id} (${hit.signal})`)
        this.options.notifyDorothy({
          changeId: liveRun.changeId,
          runId: liveRun.id,
          sessionId: hit.sessionId,
          subject: `Watchdog alert on ${liveRun.id}`,
          summary: `Auto-stop not confirmed: ${summary}`,
          text: `Watchdog detected ${hit.signal} on ${liveRun.id}, but auto-stop was refused or unconfirmed (run was not stopped). Summary: ${summary}`,
        })
        return
      }
      this.stoppedRunKeys.add(hit.runKey)
      this.consecutiveHighSpinning.set(hit.runKey, 0)
      const { totalStops, scopeStops, persisted } = this.store.incrementStops(liveRun.id, liveRun.changeId, liveRun.inputRef, liveRun.inputRevision)
      await persisted
      await this.store.recordHit({ ...record, stopped: true })
      this.options.onChange?.()
      this.options.trace({
        event: DOT_TRACE.watchdogStop,
        level: 'warn',
        message: `Watchdog auto-stopped ${liveRun.id} (totalStops=${totalStops}, scopeStops=${scopeStops}).`,
        changeId: liveRun.changeId,
        sessionId: hit.sessionId,
        data: {
          hitId: record.id,
          runId: liveRun.id,
          signal: hit.signal,
          totalStops,
          scopeStops,
          stopped: true,
        },
      })
      const humanRequired = scopeStops >= 2
      this.options.notifyDorothy({
        changeId: liveRun.changeId,
        runId: liveRun.id,
        sessionId: hit.sessionId,
        subject: humanRequired ? `Watchdog circuit breaker: ${liveRun.id}` : `Watchdog stopped ${liveRun.id}`,
        summary,
        humanRequired,
        ...(humanRequired ? {
          detail: `Watchdog stopped ${liveRun.id} (${scopeStops}x on ${liveRun.inputRef}@${liveRun.inputRevision}) [${hit.signal}]: ${summary}`,
        } : {}),
        text: humanRequired
          ? `Watchdog circuit breaker: auto-stopped ${liveRun.id} (${scopeStops}x on ${liveRun.inputRef}@${liveRun.inputRevision}, signal=${hit.signal}). Human review is required before retrying. Summary: ${summary}`
          : `Watchdog auto-stopped ${liveRun.id} (signal=${hit.signal}, watchdogStops=${totalStops}). Summary: ${summary}`,
      })
    } finally {
      this.stoppingRunKeys.delete(hit.runKey)
    }
  }
}
