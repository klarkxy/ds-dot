// Adapted from deepseek-ai/dsh-superagent-prototype@8c32a9d (MIT).
import { z } from 'zod'
import type { Timer } from '../batcher.ts'
import type { GithubPollHealthState, GithubPollRepoStatus, GithubPollSettings, GithubPollStatusView, GithubPollTestResult, TaskLink } from '../contracts.ts'
import { polledTargets } from '../links.ts'
import { normalizeGithubRepo } from '../settings.ts'
import type { ChangeRecord, RunRecord } from '../work.ts'
import type { GithubPollCursorStore, StreamName } from './cursor-store.ts'
import { RETRY_WINDOW_MS } from './cursor-store.ts'
import { CliError, GhCli, redactGithubTokens, testGhAvailability, type ExecFileRunner } from './gh-cli.ts'
import { ciCounts, ciFailures, ciSummary, pullChecks, reviewThread } from './github-read.ts'
import { PullSchema, autoLinkBranchPull, buildPullInboxInput, type GhPull } from './pull-lifecycle.ts'
import type { GithubPollSourceAdapter } from './source-adapter.ts'
import {
  CommentSchema,
  IssueSchema,
  branchCiTriggerId,
  buildCommentInboxInput,
  buildIssueInboxInput,
  clipText,
  githubAddress,
  prCiTriggerId,
  timestampMs,
  type GhComment,
  type GhIssue,
} from './triggers.ts'

export const POLL_HORIZON_MS = 14 * 24 * 3600_000
export const DEFAULT_FAILURES_BEFORE_ALERT = 3
const CURSOR_OVERLAP_MS = 5000

const RepoInfoSchema = z.object({
  default_branch: z.string().min(1),
  html_url: z.string().optional(),
}).loose()

const CommitInfoSchema = z.object({
  sha: z.string().min(1),
}).loose()

const IssueProbeSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().optional(),
  pull_request: z.unknown().nullable().optional(),
}).loose()

export function cursorAt(startedIso: string): string {
  const ms = Date.parse(startedIso)
  return new Date((Number.isFinite(ms) ? ms : Date.now()) - CURSOR_OVERLAP_MS).toISOString()
}

function floorSecondMs(ms: number): number {
  return Math.floor(ms / 1000) * 1000
}

function floorSecondIso(ms: number): string {
  return new Date(floorSecondMs(ms)).toISOString()
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError') return true
  if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ABORT_ERR') return true
  return false
}

export function clampHorizonSince(rawIso: string, nowMs: number): string {
  const horizonHour = Math.floor((nowMs - POLL_HORIZON_MS) / 3600_000) * 3600_000
  const parsed = Date.parse(rawIso)
  const clamped = Number.isFinite(parsed) ? Math.max(parsed, horizonHour) : horizonHour
  return new Date(clamped).toISOString()
}

export function countEnabledStreams(streams: GithubPollSettings['streams']): number {
  return [streams.issues, streams.pulls, streams.comments, streams.ci].filter(Boolean).length
}

export function computeRateBudget(params: {
  readonly repoCount: number
  readonly enabledStreams: number
  readonly userIntervalSec: number
  readonly xPollIntervalSec?: number
  readonly rateLimitRemaining?: number
}): {
  readonly effectiveIntervalSec: number
  readonly hourlyRequests: number
  readonly budgetLimitPerHour?: number
  readonly budgetAdjusted: boolean
  readonly budgetWarning?: string
} {
  const baseInterval = Math.max(60, params.userIntervalSec, params.xPollIntervalSec ?? 0)
  const streams = Math.max(0, params.enabledStreams)
  if (params.repoCount <= 0 || streams <= 0) {
    return { effectiveIntervalSec: baseInterval, hourlyRequests: 0, budgetAdjusted: false }
  }
  const hourly = Math.round(params.repoCount * streams * (3600 / baseInterval))
  if (params.rateLimitRemaining === undefined) {
    return { effectiveIntervalSec: baseInterval, hourlyRequests: hourly, budgetAdjusted: false }
  }
  const budgetLimit = Math.floor(params.rateLimitRemaining * 0.5)
  if (hourly < params.rateLimitRemaining * 0.5 && params.rateLimitRemaining > 0) {
    return {
      effectiveIntervalSec: baseInterval,
      hourlyRequests: hourly,
      budgetLimitPerHour: budgetLimit,
      budgetAdjusted: false,
    }
  }
  const strictTarget = Math.max(0.5, params.rateLimitRemaining * 0.5 - 0.5)
  let minInterval = params.rateLimitRemaining <= 2
    ? 3600
    : Math.max(baseInterval, Math.floor((params.repoCount * streams * 3600) / strictTarget) + 1)
  while (params.rateLimitRemaining > 2 && Math.round(params.repoCount * streams * (3600 / minInterval)) >= budgetLimit) {
    minInterval += 1
  }
  const adjustedHourly = Math.round(params.repoCount * streams * (3600 / minInterval))
  return {
    effectiveIntervalSec: minInterval,
    hourlyRequests: adjustedHourly,
    budgetLimitPerHour: budgetLimit,
    budgetAdjusted: minInterval > baseInterval,
    budgetWarning: `Rate-limit budget guard raised poll interval from ${baseInterval}s to ${minInterval}s (${params.rateLimitRemaining} remaining, budget < ${budgetLimit}/hr).`,
  }
}

export interface GithubPollerDeps {
  readonly settings: () => GithubPollSettings
  readonly cursorStore: GithubPollCursorStore
  readonly adapter: GithubPollSourceAdapter
  readonly links: () => readonly TaskLink[]
  readonly putLink: (link: TaskLink) => Promise<void>
  readonly changes: () => ReadonlyMap<string, ChangeRecord>
  readonly runs: () => readonly RunRecord[]
  readonly onCycleEvents?: () => void
  readonly trace?: (event: string, message: string, data?: Record<string, string | number | boolean>) => void
  readonly log?: (message: string) => void
  readonly timer?: Timer
  readonly now?: () => number
  readonly exec?: ExecFileRunner
  readonly cliFactory?: (settings: GithubPollSettings) => GhCli
}

export class GithubPoller {
  private timerHandle: unknown
  private running = false
  private disposed = false
  private abortController?: AbortController
  private lastPollAt?: number
  private lastError?: string
  private consecutiveFailures = 0
  private readonly transientRepoStatus = new Map<string, { lastPollAt?: number }>()

  constructor(private readonly deps: GithubPollerDeps) {}

  private get now(): number { return (this.deps.now ?? Date.now)() }

  private setTimeoutFn(fn: () => void, ms: number): unknown {
    if (this.deps.timer) return this.deps.timer.set(fn, ms)
    return setTimeout(fn, ms)
  }

  private clearTimeoutFn(handle: unknown): void {
    if (handle === undefined) return
    if (this.deps.timer) this.deps.timer.clear(handle)
    else clearTimeout(handle as ReturnType<typeof setTimeout>)
  }

  private createCli(settings: GithubPollSettings): GhCli {
    if (this.deps.cliFactory) return this.deps.cliFactory(settings)
    return new GhCli({
      ghPath: settings.ghPath,
      ...(settings.hostname ? { hostname: settings.hostname } : {}),
      ...(this.deps.exec ? { exec: this.deps.exec } : {}),
    })
  }

  start(): void {
    if (this.disposed) return
    this.scheduleNext(0)
  }

  stop(): void {
    this.clearTimeoutFn(this.timerHandle)
    this.timerHandle = undefined
    this.abortController?.abort()
    this.abortController = undefined
  }

  settingsChanged(): void {
    if (this.disposed) return
    this.clearTimeoutFn(this.timerHandle)
    this.timerHandle = undefined
    const settings = this.deps.settings()
    if (!settings.enabled || settings.repos.length === 0) {
      this.abortController?.abort()
      return
    }
    this.scheduleNext(0)
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }

  private scheduleNext(delayMs?: number): void {
    if (this.disposed) return
    const settings = this.deps.settings()
    if (!settings.enabled || settings.repos.length === 0) return
    const delay = delayMs ?? this.status().effectiveIntervalSec * 1000
    this.clearTimeoutFn(this.timerHandle)
    this.timerHandle = this.setTimeoutFn(() => {
      this.timerHandle = undefined
      void this.pollNow().finally(() => {
        if (!this.disposed) this.scheduleNext()
      })
    }, Math.max(0, delay))
  }

  async testConnection(override?: { readonly ghPath?: string; readonly hostname?: string; readonly repos?: readonly string[] }): Promise<GithubPollTestResult> {
    const settings = this.deps.settings()
    return testGhAvailability({
      ghPath: override?.ghPath?.trim() || settings.ghPath,
      hostname: override?.hostname ?? settings.hostname,
      repos: override?.repos ?? settings.repos,
      ...(this.deps.exec ? { exec: this.deps.exec } : {}),
    })
  }

  status(): GithubPollStatusView {
    const settings = this.deps.settings()
    const pollRepos = settings.repos.filter(r => !settings.webhookRepos.includes(r))
    const repoStates = pollRepos.map(repo => ({ repo, state: this.deps.cursorStore.getRepoState(repo) }))
    let xPollMax: number | undefined
    let remainingMin: number | undefined
    let limitVal: number | undefined
    let resetAt: number | undefined
    for (const { state } of repoStates) {
      if (state?.xPollIntervalSec !== undefined) xPollMax = Math.max(xPollMax ?? 0, state.xPollIntervalSec)
      if (state?.rateLimitRemaining !== undefined) {
        remainingMin = remainingMin === undefined ? state.rateLimitRemaining : Math.min(remainingMin, state.rateLimitRemaining)
      }
      if (state?.rateLimitLimit !== undefined) limitVal = state.rateLimitLimit
      if (state?.rateLimitResetAt !== undefined) resetAt = state.rateLimitResetAt
    }
    const budget = computeRateBudget({
      repoCount: pollRepos.length,
      enabledStreams: countEnabledStreams(settings.streams),
      userIntervalSec: settings.intervalSec,
      ...(xPollMax !== undefined ? { xPollIntervalSec: xPollMax } : {}),
      ...(remainingMin !== undefined ? { rateLimitRemaining: remainingMin } : {}),
    })
    const maxRepoFailures = repoStates.reduce((max, item) => Math.max(max, item.state?.consecutiveFailures ?? 0), 0)
    const effectiveFailures = Math.max(this.consecutiveFailures, maxRepoFailures)
    const alert = effectiveFailures >= DEFAULT_FAILURES_BEFORE_ALERT
    let health: GithubPollHealthState = 'idle'
    if (settings.enabled && pollRepos.length > 0) {
      health = alert ? 'error' : effectiveFailures > 0 ? 'degraded' : 'ok'
    }
    const repos: GithubPollRepoStatus[] = [
      ...pollRepos.map(repo => {
        const st = this.deps.cursorStore.getRepoState(repo)
        const tr = this.transientRepoStatus.get(repo)
        const pollAt = tr?.lastPollAt ?? st?.lastPollAt
        return {
          repo,
          mode: 'poll' as const,
          consecutiveFailures: st?.consecutiveFailures ?? 0,
          ...(pollAt !== undefined ? { lastPollAt: pollAt } : {}),
          ...(st?.lastSuccessAt !== undefined ? { lastSuccessAt: st.lastSuccessAt } : {}),
          ...(st?.lastDeliveredAt !== undefined ? { lastDeliveredAt: st.lastDeliveredAt } : {}),
          ...(st?.lastError ? { lastError: st.lastError } : {}),
          ...(st?.deleted410Subjects?.length ? { degraded410Count: st.deleted410Subjects.length } : {}),
        }
      }),
      ...settings.webhookRepos.map(repo => {
        const st = this.deps.cursorStore.getRepoState(repo)
        return {
          repo,
          mode: 'webhook' as const,
          consecutiveFailures: 0,
          ...(st?.lastDeliveredAt !== undefined ? { lastDeliveredAt: st.lastDeliveredAt } : {}),
        }
      }),
    ]
    return {
      enabled: settings.enabled,
      polling: this.running,
      ghPath: settings.ghPath,
      ...(settings.hostname ? { hostname: settings.hostname } : {}),
      userIntervalSec: settings.intervalSec,
      effectiveIntervalSec: budget.effectiveIntervalSec,
      ...(xPollMax !== undefined ? { xPollIntervalSec: xPollMax } : {}),
      ...(remainingMin !== undefined ? { rateLimitRemaining: remainingMin } : {}),
      ...(limitVal !== undefined ? { rateLimitLimit: limitVal } : {}),
      ...(resetAt !== undefined ? { rateLimitResetAt: resetAt } : {}),
      hourlyRequests: budget.hourlyRequests,
      ...(budget.budgetLimitPerHour !== undefined ? { budgetLimitPerHour: budget.budgetLimitPerHour } : {}),
      budgetAdjusted: budget.budgetAdjusted,
      ...(budget.budgetWarning ? { budgetWarning: budget.budgetWarning } : {}),
      health,
      alert,
      consecutiveFailures: effectiveFailures,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastPollAt !== undefined ? { lastPollAt: this.lastPollAt } : {}),
      repos,
    }
  }

  async pollNow(): Promise<{ readonly ok: boolean; readonly events: number }> {
    if (this.disposed || this.running) return { ok: true, events: 0 }
    const settings = this.deps.settings()
    if (!settings.enabled || settings.repos.length === 0) return { ok: true, events: 0 }

    const pollRepos = [...new Set(settings.repos.map(normalizeGithubRepo))].filter(r => !settings.webhookRepos.includes(r))
    if (pollRepos.length === 0) return { ok: true, events: 0 }

    this.running = true
    const ac = new AbortController()
    this.abortController = ac
    const roundStartMs = this.now
    this.lastPollAt = roundStartMs
    let totalEvents = 0
    let hadFailure = false

    try {
      const cli = this.createCli(settings)
      let avail: GithubPollTestResult
      try {
        avail = await testGhAvailability({
          ghPath: settings.ghPath,
          ...(settings.hostname ? { hostname: settings.hostname } : {}),
          ...(this.deps.exec ? { exec: this.deps.exec } : {}),
          signal: ac.signal,
        })
      } catch (error) {
        if (this.disposed || ac.signal.aborted || isAbortError(error, ac.signal)) {
          return { ok: true, events: 0 }
        }
        throw error
      }
      if (this.disposed || ac.signal.aborted) return { ok: true, events: 0 }
      if (!avail.ghFound || !avail.authenticated) {
        hadFailure = true
        const msg = avail.error ?? (avail.ghFound ? 'GitHub CLI not authenticated' : 'GitHub CLI (gh) not found')
        this.consecutiveFailures += 1
        this.lastError = redactGithubTokens(msg)
        for (const repo of pollRepos) {
          const prev = this.deps.cursorStore.getRepoState(repo)
          await this.deps.cursorStore.updateRepoState(repo, {
            consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
            lastError: this.lastError,
          })
        }
        this.deps.trace?.('github-poll.failed', this.lastError, { consecutiveFailures: this.consecutiveFailures })
        return { ok: false, events: 0 }
      }

      for (const repo of pollRepos) {
        if (this.disposed || ac.signal.aborted) break
        try {
          const repoRes = await this.pollRepo(cli, settings, repo, roundStartMs, ac.signal)
          totalEvents += repoRes.events
          if (repoRes.error !== undefined) {
            hadFailure = true
            const msg = redactGithubTokens(repoRes.error instanceof Error ? repoRes.error.message : String(repoRes.error))
            const prev = this.deps.cursorStore.getRepoState(repo)
            const nextFailures = (prev?.consecutiveFailures ?? 0) + 1
            await this.deps.cursorStore.updateRepoState(repo, {
              consecutiveFailures: nextFailures,
              lastError: msg,
            })
            this.lastError = msg
            this.deps.trace?.('github-poll.failed', msg, { repo, consecutiveFailures: nextFailures })
          } else {
            const prev = this.deps.cursorStore.getRepoState(repo)
            this.transientRepoStatus.set(repo, { lastPollAt: roundStartMs })
            // Zero-write invariant: only write repo state when clearing a previous failure/error.
            if ((prev?.consecutiveFailures ?? 0) > 0 || prev?.lastError !== undefined) {
              await this.deps.cursorStore.updateRepoState(repo, {
                consecutiveFailures: 0,
                lastError: undefined,
                lastSuccessAt: roundStartMs,
              })
            }
          }
        } catch (error) {
          if (isAbortError(error, ac.signal)) break
          hadFailure = true
          const msg = redactGithubTokens(error instanceof Error ? error.message : String(error))
          const prev = this.deps.cursorStore.getRepoState(repo)
          const nextFailures = (prev?.consecutiveFailures ?? 0) + 1
          await this.deps.cursorStore.updateRepoState(repo, {
            consecutiveFailures: nextFailures,
            lastError: msg,
          })
          this.lastError = msg
          this.deps.trace?.('github-poll.failed', msg, { repo, consecutiveFailures: nextFailures })
        }
      }

      if (totalEvents > 0) {
        this.deps.onCycleEvents?.()
      }
      if (!hadFailure) {
        this.consecutiveFailures = 0
        this.lastError = undefined
      } else {
        this.consecutiveFailures += 1
      }
      return { ok: !hadFailure, events: totalEvents }
    } finally {
      this.running = false
      if (this.abortController === ac) this.abortController = undefined
    }
  }

  private async recordHeaders(repo: string, headers: { pollIntervalSec?: number; rateLimitRemaining?: number; rateLimitLimit?: number; rateLimitResetAt?: number }): Promise<void> {
    const prev = this.deps.cursorStore.getRepoState(repo)
    const patch: Record<string, unknown> = {}
    if (headers.pollIntervalSec !== undefined && headers.pollIntervalSec !== prev?.xPollIntervalSec) {
      patch.xPollIntervalSec = headers.pollIntervalSec
    }
    if (headers.rateLimitRemaining !== undefined && headers.rateLimitRemaining !== prev?.rateLimitRemaining) {
      patch.rateLimitRemaining = headers.rateLimitRemaining
    }
    if (headers.rateLimitLimit !== undefined && headers.rateLimitLimit !== prev?.rateLimitLimit) {
      patch.rateLimitLimit = headers.rateLimitLimit
    }
    if (headers.rateLimitResetAt !== undefined && headers.rateLimitResetAt !== prev?.rateLimitResetAt) {
      patch.rateLimitResetAt = headers.rateLimitResetAt
    }
    if (Object.keys(patch).length > 0) {
      await this.deps.cursorStore.updateRepoState(repo, patch)
    }
  }

  private is410(error: unknown): boolean {
    return error instanceof CliError && error.code === 410
  }

  private async handleTargetError(repo: string, subject: string, error: unknown, nowMs: number): Promise<'skip' | 'throw'> {
    if (this.is410(error)) {
      await this.deps.cursorStore.mark410Gone(repo, subject)
      return 'skip'
    }
    if (error instanceof CliError && error.code === 404) {
      const prev = this.deps.cursorStore.getRepoState(repo)
      const deadlines = { ...(prev?.retryDeadlines ?? {}) }
      const deadline = deadlines[subject] ?? (nowMs + RETRY_WINDOW_MS)
      deadlines[subject] = deadline
      await this.deps.cursorStore.updateRepoState(repo, { retryDeadlines: deadlines })
      if (nowMs >= deadline) {
        return 'skip'
      }
      return 'throw'
    }
    return 'throw'
  }

  private async markTargetAsIssue(repo: string, number: number, htmlUrl?: string): Promise<void> {
    await this.deps.cursorStore.markKnownIssue(repo, number)
    for (const link of this.deps.links()) {
      if (link.repo !== repo || link.number !== number || link.targetKind === 'issue') continue
      await this.deps.putLink({
        ...link,
        targetKind: 'issue',
        ...(!link.url && htmlUrl ? { url: htmlUrl } : {}),
      })
    }
  }

  private async handlePullTargetError(
    cli: GhCli,
    repo: string,
    target: { readonly number: number; readonly targetKind?: 'pr' | 'issue' },
    error: unknown,
    nowMs: number,
    signal: AbortSignal,
  ): Promise<{ readonly action: 'skip' | 'throw'; readonly error: unknown }> {
    if (isAbortError(error, signal)) throw error
    const subject = `${repo}#${target.number}`
    if (target.targetKind !== 'pr' && error instanceof CliError && error.code === 404) {
      try {
        const issue = await cli.repoApi(IssueProbeSchema, repo, `issues/${target.number}`, [], signal)
        if (!issue.pull_request) {
          await this.markTargetAsIssue(repo, target.number, issue.html_url)
          return { action: 'skip', error: undefined }
        }
      } catch (probeError) {
        if (isAbortError(probeError, signal)) throw probeError
        if (this.is410(probeError)) {
          await this.deps.cursorStore.mark410Gone(repo, subject)
          return { action: 'skip', error: undefined }
        }
      }
    }
    const action = await this.handleTargetError(repo, subject, error, nowMs)
    return { action, error }
  }

  private async pollRepo(cli: GhCli, settings: GithubPollSettings, repo: string, nowMs: number, signal: AbortSignal): Promise<{ readonly events: number; readonly error?: unknown }> {
    const sourceId = settings.sourceId || 'primary-github'
    const nowIso = new Date(nowMs).toISOString()
    const repoState = this.deps.cursorStore.getRepoState(repo)
    let events = 0
    const streamErrors: unknown[] = []

    // 1. issues & pulls stream
    if (settings.streams.issues || settings.streams.pulls) {
      try {
        const res = await this.pollIssuesAndPullsStream(cli, settings, repo, sourceId, nowMs, nowIso, repoState?.lastDeliveredAt, signal)
        events += res.events
        if (res.error !== undefined) streamErrors.push(res.error)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        streamErrors.push(error)
      }
    } else {
      await this.deps.cursorStore.clearStreamCursor(repo, 'issues')
    }

    // 2. comments stream (issue comments + PR review comments + linked PR reviews)
    if (settings.streams.comments) {
      try {
        events += await this.pollCommentsStream(cli, settings, repo, sourceId, 'comments', 'issues/comments', nowMs, nowIso, repoState?.lastDeliveredAt, signal)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        streamErrors.push(error)
      }
      try {
        events += await this.pollCommentsStream(cli, settings, repo, sourceId, 'review-comments', 'pulls/comments', nowMs, nowIso, repoState?.lastDeliveredAt, signal)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        streamErrors.push(error)
      }
      try {
        const revRes = await this.pollLinkedPrReviews(cli, settings, repo, sourceId, nowMs, signal)
        events += revRes.events
        if (revRes.error !== undefined) streamErrors.push(revRes.error)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        streamErrors.push(error)
      }
    } else {
      await this.deps.cursorStore.clearStreamCursor(repo, 'comments')
      await this.deps.cursorStore.clearStreamCursor(repo, 'review-comments')
      await this.deps.cursorStore.clearPrReviewCursors(repo)
    }

    // 3. CI stream (default branch + polled PRs)
    if (settings.streams.ci) {
      try {
        events += await this.pollBranchCi(cli, repo, sourceId, nowMs, signal)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        streamErrors.push(error)
      }
      try {
        const ciRes = await this.pollLinkedPrCi(cli, repo, sourceId, nowMs, signal)
        events += ciRes.events
        if (ciRes.error !== undefined) streamErrors.push(ciRes.error)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        streamErrors.push(error)
      }
    } else {
      await this.deps.cursorStore.clearCiBaseline(repo)
    }

    return streamErrors.length > 0 ? { events, error: streamErrors[0] } : { events }
  }

  private initialSinceForStream(nowMs: number, handoffAt?: number): { readonly since: string; readonly coldStart: boolean } {
    if (handoffAt !== undefined && Number.isFinite(handoffAt)) {
      return { since: clampHorizonSince(floorSecondIso(handoffAt), nowMs), coldStart: false }
    }
    return { since: clampHorizonSince(floorSecondIso(nowMs), nowMs), coldStart: true }
  }

  private async pollIssuesAndPullsStream(
    cli: GhCli,
    settings: GithubPollSettings,
    repo: string,
    sourceId: string,
    nowMs: number,
    _nowIso: string,
    handoffAt: number | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly events: number; readonly error?: unknown }> {
    const floorIso = floorSecondIso(nowMs)
    const stored = this.deps.cursorStore.getStreamCursor(repo, 'issues')
    const init = stored ? { since: clampHorizonSince(stored.since, nowMs), coldStart: false } : this.initialSinceForStream(nowMs, handoffAt)
    const since = init.since
    let startedIssues = stored ? stored.startedIssues : (settings.streams.issues ? (handoffAt !== undefined ? init.since : floorIso) : undefined)
    let startedPulls = stored ? stored.startedPulls : (settings.streams.pulls ? (handoffAt !== undefined ? init.since : floorIso) : undefined)

    // Cold-start when there is no cursor and no handoff: fetch baseline snapshot in the starting UTC second without historical flood.
    if (!stored && init.coldStart) {
      const coldRes = await cli.repoPagesWithHeaders(
        IssueSchema,
        repo,
        `issues?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`,
        [],
        undefined,
        signal,
      )
      await this.recordHeaders(repo, coldRes.headers)
      const coldFloorMs = floorSecondMs(nowMs)
      const seenKeys = coldRes.notModified
        ? []
        : coldRes.items
            .filter(item => Date.parse(item.updated_at ?? item.created_at) >= coldFloorMs)
            .map(item => `${item.number}:${item.state}:${item.updated_at ?? item.created_at}`)
            .slice(-200)
      await this.deps.cursorStore.setStreamCursor(repo, 'issues', {
        since,
        ...(coldRes.headers.etag ? { etag: coldRes.headers.etag } : {}),
        ...(coldRes.headers.lastModified ? { lastModified: coldRes.headers.lastModified } : {}),
        ...(startedIssues ? { startedIssues } : {}),
        ...(startedPulls ? { startedPulls } : {}),
        ...(seenKeys.length > 0 ? { seenKeys } : {}),
        updatedAt: nowMs,
      })
      return { events: 0 }
    }

    // If a kind was just enabled after the other, initialize its started timestamp at floorIso so it cold-starts cleanly.
    const newlyEnabledIssues = settings.streams.issues && !startedIssues
    const newlyEnabledPulls = settings.streams.pulls && !startedPulls
    if (newlyEnabledIssues) startedIssues = floorIso
    if (newlyEnabledPulls) startedPulls = floorIso

    const extraArgs = stored?.etag && stored.since === since ? ['-H', `If-None-Match: ${stored.etag}`] : []
    const res = await cli.repoPagesWithHeaders(
      IssueSchema,
      repo,
      `issues?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`,
      extraArgs,
      undefined,
      signal,
    )
    await this.recordHeaders(repo, res.headers)
    if (res.notModified) {
      if (newlyEnabledIssues || newlyEnabledPulls) {
        await this.deps.cursorStore.setStreamCursor(repo, 'issues', {
          since: stored?.since ?? since,
          ...(stored?.etag ? { etag: stored.etag } : {}),
          ...(stored?.lastModified ? { lastModified: stored.lastModified } : {}),
          ...(startedIssues ? { startedIssues } : {}),
          ...(startedPulls ? { startedPulls } : {}),
          ...(stored?.seenKeys?.length ? { seenKeys: stored.seenKeys } : {}),
          updatedAt: nowMs,
        })
      }
      return { events: 0 }
    }

    let newestUpdated = since
    let emitted = 0
    const targetErrors: unknown[] = []
    const horizonMs = nowMs - POLL_HORIZON_MS
    const seenSet = new Set(stored?.seenKeys ?? [])
    const coldSeededSet = new Set(stored?.seenKeys ?? [])

    for (const item of res.items) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const isPr = Boolean(item.pull_request)
      const updatedIso = item.updated_at ?? item.created_at
      if (Date.parse(updatedIso) > Date.parse(newestUpdated)) newestUpdated = updatedIso
      const itemSeenKey = `${item.number}:${item.state}:${updatedIso}`

      if (isPr) {
        if (!settings.streams.pulls || newlyEnabledPulls || !startedPulls) {
          if (newlyEnabledPulls && Date.parse(updatedIso) >= floorSecondMs(nowMs)) seenSet.add(itemSeenKey)
          continue
        }
        if (coldSeededSet.has(itemSeenKey)) continue
        const floorMs = Math.max(Date.parse(startedPulls), horizonMs)
        const prCreatedMs = Date.parse(item.created_at)
        const prUpdatedMs = Date.parse(updatedIso)
        if (prUpdatedMs < floorMs) continue
        if (item.state === 'closed' && item.closed_at && timestampMs(item.closed_at, prUpdatedMs) < floorMs) continue
        const subject = `${repo}#${item.number}`
        if (this.deps.cursorStore.is410Gone(repo, subject)) continue
        let pr: GhPull
        try {
          pr = await cli.repoApi(PullSchema, repo, `pulls/${item.number}`, [], signal)
        } catch (error) {
          if (isAbortError(error, signal)) throw error
          const action = await this.handleTargetError(repo, subject, error, nowMs)
          if (action === 'skip') continue
          targetErrors.push(error)
          continue
        }
        const closedAtMs = timestampMs(pr.closed_at ?? pr.merged_at ?? item.closed_at ?? updatedIso, prUpdatedMs)
        const action: 'opened' | 'reopened' | 'closed' | undefined = pr.state === 'closed'
          ? (closedAtMs >= floorMs ? 'closed' : undefined)
          : prCreatedMs >= floorMs ? 'opened' : 'reopened'
        if (!action) continue
        // Only emit 'reopened' if a link already exists and was closed/merged; otherwise emit 'opened' or 'closed'.
        if (action === 'reopened') {
          const existingLink = this.deps.links().find(l => l.repo === repo && l.number === pr.number)
          if (!existingLink || existingLink.state === 'open') continue
        }
        const event = buildPullInboxInput({ repo, sourceId, pr, action, now: nowMs })
        await autoLinkBranchPull({
          repo,
          pr,
          changes: [...this.deps.changes().values()],
          existingLinks: this.deps.links(),
          putLink: this.deps.putLink,
          at: nowMs,
        })
        const outcome = await this.deps.adapter.receive(event, {
          repo,
          rawBody: pr.body ?? '',
          senderType: pr.user.type,
        })
        if (outcome.inboxResult === 'stored' || outcome.inboxResult === 'merged' || outcome.closureNotifiedChanges.length > 0) {
          emitted += 1
        }
      } else {
        if (!settings.streams.issues || newlyEnabledIssues || !startedIssues) {
          if (newlyEnabledIssues && Date.parse(updatedIso) >= floorSecondMs(nowMs)) seenSet.add(itemSeenKey)
          continue
        }
        if (coldSeededSet.has(itemSeenKey)) continue
        const floorMs = Math.max(Date.parse(startedIssues), horizonMs)
        const createdMs = Date.parse(item.created_at)
        // Check created_at for new issue openings so editing an old issue does not re-ingest its body.
        const action: 'opened' | 'closed' | undefined = item.state === 'closed'
          ? (Date.parse(item.closed_at ?? updatedIso) >= floorMs ? 'closed' : undefined)
          : (createdMs >= floorMs ? 'opened' : undefined)
        if (!action) continue
        const event = buildIssueInboxInput({ repo, sourceId, issue: item, action, now: nowMs })
        const outcome = await this.deps.adapter.receive(event, {
          repo,
          rawBody: item.body ?? '',
          senderType: item.user.type,
        })
        if (outcome.inboxResult === 'stored' || outcome.inboxResult === 'merged') {
          emitted += 1
        }
      }
    }

    const advanced = res.items.length > 0 ? clampHorizonSince(cursorAt(newestUpdated), nowMs) : since
    const nextSince = targetErrors.length === 0 && Date.parse(advanced) > Date.parse(since) ? advanced : since
    const nextEtag = res.headers.etag && nextSince === since ? res.headers.etag : undefined
    const nextSeen = [...seenSet].slice(-200)
    const changed = !stored
      || nextSince !== stored.since
      || nextEtag !== stored.etag
      || (res.headers.lastModified ?? stored.lastModified) !== stored.lastModified
      || startedIssues !== stored.startedIssues
      || startedPulls !== stored.startedPulls
      || JSON.stringify(nextSeen) !== JSON.stringify(stored.seenKeys ?? [])
    await this.deps.cursorStore.setStreamCursor(repo, 'issues', {
      since: nextSince,
      ...(nextEtag ? { etag: nextEtag } : {}),
      ...(res.headers.lastModified ? { lastModified: res.headers.lastModified } : {}),
      ...(startedIssues ? { startedIssues } : {}),
      ...(startedPulls ? { startedPulls } : {}),
      ...(nextSeen.length > 0 ? { seenKeys: nextSeen } : {}),
      updatedAt: changed ? nowMs : (stored?.updatedAt ?? nowMs),
    })
    return targetErrors.length > 0 ? { events: emitted, error: targetErrors[0] } : { events: emitted }
  }

  private async pollCommentsStream(
    cli: GhCli,
    settings: GithubPollSettings,
    repo: string,
    sourceId: string,
    stream: Extract<StreamName, 'comments' | 'review-comments'>,
    endpoint: 'issues/comments' | 'pulls/comments',
    nowMs: number,
    nowIso: string,
    handoffAt: number | undefined,
    signal: AbortSignal,
  ): Promise<number> {
    const floorIso = floorSecondIso(nowMs)
    const stored = this.deps.cursorStore.getStreamCursor(repo, stream)
    const init = stored ? { since: clampHorizonSince(stored.since, nowMs), coldStart: false } : this.initialSinceForStream(nowMs, handoffAt)
    const since = init.since
    const startedComments = stored?.startedComments ?? (handoffAt !== undefined ? init.since : floorIso)

    if (!stored && init.coldStart) {
      const coldRes = await cli.repoPagesWithHeaders(
        CommentSchema,
        repo,
        `${endpoint}?sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`,
        [],
        undefined,
        signal,
      )
      await this.recordHeaders(repo, coldRes.headers)
      const coldFloorMs = floorSecondMs(nowMs)
      const seenKeys = coldRes.notModified
        ? []
        : coldRes.items
            .filter(c => Date.parse(c.updated_at ?? c.created_at ?? nowIso) >= coldFloorMs)
            .map(c => `${c.id}:${c.updated_at ?? c.created_at ?? ''}`)
            .slice(-200)
      await this.deps.cursorStore.setStreamCursor(repo, stream, {
        since,
        ...(coldRes.headers.etag ? { etag: coldRes.headers.etag } : {}),
        ...(coldRes.headers.lastModified ? { lastModified: coldRes.headers.lastModified } : {}),
        startedComments,
        ...(seenKeys.length > 0 ? { seenKeys } : {}),
        updatedAt: nowMs,
      })
      return 0
    }

    const extraArgs = stored?.etag && stored.since === since ? ['-H', `If-None-Match: ${stored.etag}`] : []
    const res = await cli.repoPagesWithHeaders(
      CommentSchema,
      repo,
      `${endpoint}?sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`,
      extraArgs,
      undefined,
      signal,
    )
    await this.recordHeaders(repo, res.headers)
    if (res.notModified) return 0

    let newestUpdated = since
    let emitted = 0
    const floorMs = Math.max(Date.parse(startedComments), nowMs - POLL_HORIZON_MS)
    const coldSeededSet = new Set(stored?.seenKeys ?? [])

    for (const comment of res.items) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const updatedIso = comment.updated_at ?? comment.created_at ?? nowIso
      if (Date.parse(updatedIso) > Date.parse(newestUpdated)) newestUpdated = updatedIso
      const commentSeenKey = `${comment.id}:${comment.updated_at ?? comment.created_at ?? ''}`
      if (coldSeededSet.has(commentSeenKey)) continue
      if (Date.parse(updatedIso) < floorMs) continue
      if (this.deps.cursorStore.hasEcho(repo, String(comment.id), nowMs)) continue

      const addr = githubAddress(comment.html_url, repo, settings.hostname) ?? githubAddress(comment.issue_url ?? comment.pull_request_url, repo, settings.hostname)
      if (!addr) continue
      const subject = `${repo}#${addr.number}`
      if (this.deps.cursorStore.is410Gone(repo, subject)) continue

      let directContext: string | undefined
      if (stream === 'review-comments') {
        const line = comment.line ?? comment.original_line
        const fileLoc = comment.path ? `${comment.path}${line != null ? `:${line}` : ''}` : undefined
        let replyExcerpt: string | undefined
        if (comment.in_reply_to_id) {
          try {
            const thread = await reviewThread(cli, repo, addr.number, comment.id, undefined, signal)
            const parent = thread.find(c => c.id === comment.in_reply_to_id) ?? thread.find(c => c.id !== comment.id)
            if (parent?.body) replyExcerpt = `reply to @${parent.user.login}: ${clipText(parent.body, 140)}`
          } catch { /* best-effort context */ }
        }
        directContext = [fileLoc, replyExcerpt].filter(Boolean).join(' · ') || undefined
      }

      const event = buildCommentInboxInput({
        repo,
        sourceId,
        number: addr.number,
        comment,
        kind: stream === 'review-comments' ? 'inline' : 'conversation',
        now: nowMs,
      })
      if (!event) continue
      const outcome = await this.deps.adapter.receive(event, {
        repo,
        rawBody: comment.body ?? '',
        ...(directContext ? { directContext } : {}),
        senderType: comment.user.type,
      })
      if (outcome.inboxResult === 'stored' || outcome.inboxResult === 'merged') {
        emitted += 1
      }
    }

    const advanced = res.items.length > 0 ? clampHorizonSince(cursorAt(newestUpdated), nowMs) : since
    const nextSince = Date.parse(advanced) > Date.parse(since) ? advanced : since
    const nextEtag = res.headers.etag && nextSince === since ? res.headers.etag : undefined
    const nextSeen = stored?.seenKeys ?? []
    const changed = !stored
      || nextSince !== stored.since
      || nextEtag !== stored.etag
      || (res.headers.lastModified ?? stored.lastModified) !== stored.lastModified
      || startedComments !== stored.startedComments
    await this.deps.cursorStore.setStreamCursor(repo, stream, {
      since: nextSince,
      ...(nextEtag ? { etag: nextEtag } : {}),
      ...(res.headers.lastModified ? { lastModified: res.headers.lastModified } : {}),
      startedComments,
      ...(nextSeen.length > 0 ? { seenKeys: nextSeen } : {}),
      updatedAt: changed ? nowMs : (stored?.updatedAt ?? nowMs),
    })
    return emitted
  }

  private async pollLinkedPrReviews(
    cli: GhCli,
    _settings: GithubPollSettings,
    repo: string,
    sourceId: string,
    nowMs: number,
    signal: AbortSignal,
  ): Promise<{ readonly events: number; readonly error?: unknown }> {
    const targets = polledTargets(this.deps.links(), this.deps.changes(), this.deps.runs(), nowMs, repo)
    const commentsCursor = this.deps.cursorStore.getStreamCursor(repo, 'comments')
    const repoState = this.deps.cursorStore.getRepoState(repo)
    const handoffAt = repoState?.lastDeliveredAt
    const floorIso = floorSecondIso(nowMs)
    let emitted = 0
    const targetErrors: unknown[] = []
    for (const target of targets) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (target.targetKind === 'issue' || this.deps.cursorStore.isKnownIssue(repo, target.number)) continue
      const subject = `${repo}#${target.number}`
      if (this.deps.cursorStore.is410Gone(repo, subject)) continue
      const stored = this.deps.cursorStore.getPrReviewCursor(repo, target.number)
      const extraArgs = stored?.etag ? ['-H', `If-None-Match: ${stored.etag}`] : []
      let res: Awaited<ReturnType<GhCli['repoPagesWithHeaders']>>
      try {
        res = await cli.repoPagesWithHeaders(CommentSchema, repo, `pulls/${target.number}/reviews?per_page=100`, extraArgs, undefined, signal)
      } catch (error) {
        const handled = await this.handlePullTargetError(cli, repo, target, error, nowMs, signal)
        if (handled.action === 'skip') continue
        targetErrors.push(handled.error)
        continue
      }
      await this.recordHeaders(repo, res.headers)
      if (res.notModified) continue

      const reviews = res.items as GhComment[]
      let isColdStart = false
      let startedComments: string
      if (stored) {
        startedComments = stored.startedComments
      } else if (handoffAt !== undefined && Number.isFinite(handoffAt)) {
        startedComments = clampHorizonSince(floorSecondIso(handoffAt), nowMs)
      } else if (commentsCursor?.startedComments && commentsCursor.updatedAt < nowMs) {
        startedComments = commentsCursor.startedComments
      } else {
        isColdStart = true
        startedComments = floorIso
      }

      const seenSet = new Set(stored?.seenIds ?? [])
      if (isColdStart) {
        for (const review of reviews) {
          seenSet.add(`${review.id}:${review.submitted_at ?? review.updated_at ?? review.created_at ?? ''}`)
        }
        const nextSeen = [...seenSet].slice(-200)
        await this.deps.cursorStore.setPrReviewCursor(repo, target.number, {
          ...(res.headers.etag ? { etag: res.headers.etag } : {}),
          ...(res.headers.lastModified ? { lastModified: res.headers.lastModified } : {}),
          startedComments,
          ...(nextSeen.length > 0 ? { seenIds: nextSeen } : {}),
          updatedAt: nowMs,
        })
        continue
      }

      const floorMs = Math.max(Date.parse(startedComments), nowMs - POLL_HORIZON_MS)
      for (const review of reviews) {
        const reviewKey = `${review.id}:${review.submitted_at ?? review.updated_at ?? review.created_at ?? ''}`
        if (seenSet.has(reviewKey)) continue
        if (this.deps.cursorStore.hasEcho(repo, String(review.id), nowMs)) {
          seenSet.add(reviewKey)
          continue
        }
        const submittedMs = timestampMs(review.submitted_at ?? review.updated_at ?? review.created_at, 0)
        if (submittedMs > 0 && submittedMs < floorMs) continue
        const event = buildCommentInboxInput({
          repo,
          sourceId,
          number: target.number,
          comment: review,
          kind: 'review',
          ...(target.branch ? { headRef: target.branch } : {}),
          ...(target.headRepo ? { headRepo: target.headRepo } : {}),
          now: nowMs,
        })
        if (!event) continue
        seenSet.add(reviewKey)
        const outcome = await this.deps.adapter.receive(event, {
          repo,
          rawBody: review.body ?? '',
          senderType: review.user.type,
        })
        if (outcome.inboxResult === 'stored' || outcome.inboxResult === 'merged') {
          emitted += 1
        }
      }

      const nextSeen = [...seenSet].slice(-200)
      const changed = !stored
        || (res.headers.etag ?? stored.etag) !== stored.etag
        || (res.headers.lastModified ?? stored.lastModified) !== stored.lastModified
        || startedComments !== stored.startedComments
        || JSON.stringify(nextSeen) !== JSON.stringify(stored.seenIds ?? [])
      await this.deps.cursorStore.setPrReviewCursor(repo, target.number, {
        ...(res.headers.etag ? { etag: res.headers.etag } : {}),
        ...(res.headers.lastModified ? { lastModified: res.headers.lastModified } : {}),
        startedComments,
        ...(nextSeen.length > 0 ? { seenIds: nextSeen } : {}),
        updatedAt: changed ? nowMs : (stored?.updatedAt ?? nowMs),
      })
    }
    return targetErrors.length > 0 ? { events: emitted, error: targetErrors[0] } : { events: emitted }
  }

  private async pollBranchCi(cli: GhCli, repo: string, sourceId: string, nowMs: number, signal: AbortSignal): Promise<number> {
    const info = await cli.repoApi(RepoInfoSchema, repo, '', [], signal)
    const branch = info.default_branch
    const commit = await cli.repoApi(CommitInfoSchema, repo, `commits/${encodeURIComponent(branch)}`, [], signal)
    const snapshot = await pullChecks(cli, repo, commit.sha, undefined, signal)
    const counts = ciCounts(snapshot)
    const nowFailures = ciFailures(snapshot)
    const previous = this.deps.cursorStore.getCiBaseline(repo)

    // Cold-start or default-branch rename: record baseline without flooding historical failures.
    if (!previous || previous.branch !== branch) {
      await this.deps.cursorStore.setCiBaseline(repo, {
        branch,
        failures: nowFailures,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: nowMs,
      })
      return 0
    }

    // Transient rerun guard: retain previous failures while checks are still running and none failed yet.
    if (counts.running > 0 && nowFailures.length === 0 && previous.failures.length > 0) {
      return 0
    }

    if (JSON.stringify(nowFailures) === JSON.stringify(previous.failures)) {
      return 0
    }

    const nextRevision = previous.revision + 1
    await this.deps.cursorStore.setCiBaseline(repo, {
      branch,
      failures: nowFailures,
      revision: nextRevision,
      updatedAt: nowMs,
    })

    if (nowFailures.length === 0) return 0

    const summary = ciSummary(snapshot, `${repo}@${branch}`, `gh api repos/${repo}/commits/${commit.sha}/check-runs`)
    const outcome = await this.deps.adapter.receive({
      source: 'github',
      sourceId,
      deliveryId: branchCiTriggerId(repo, branch, nextRevision),
      type: 'check_suite.completed',
      subject: `${repo}:checks:ci@${branch}`,
      title: clipText(`CI failure on ${branch}: ${nowFailures.slice(0, 3).join(', ')}`, 200),
      actor: 'github-actions[bot]',
      ...(info.html_url ? { url: `${info.html_url}/commit/${commit.sha}/checks` } : {}),
      summary: clipText(summary, 500),
      receivedAt: nowMs,
      headRepo: repo,
      originSource: 'github-poll',
    }, {
      repo,
      rawBody: summary,
      senderType: 'Bot',
      ciRelevant: true,
    })
    return outcome.inboxResult === 'stored' || outcome.inboxResult === 'merged' ? 1 : 0
  }

  private async pollLinkedPrCi(cli: GhCli, repo: string, sourceId: string, nowMs: number, signal: AbortSignal): Promise<{ readonly events: number; readonly error?: unknown }> {
    const targets = polledTargets(this.deps.links(), this.deps.changes(), this.deps.runs(), nowMs, repo)
    let emitted = 0
    const targetErrors: unknown[] = []
    for (const target of targets) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (target.targetKind === 'issue' || this.deps.cursorStore.isKnownIssue(repo, target.number)) continue
      const subject = `${repo}#${target.number}`
      if (this.deps.cursorStore.is410Gone(repo, subject)) continue
      let pr: GhPull
      try {
        pr = await cli.repoApi(PullSchema, repo, `pulls/${target.number}`, [], signal)
      } catch (error) {
        const handled = await this.handlePullTargetError(cli, repo, target, error, nowMs, signal)
        if (handled.action === 'skip') continue
        targetErrors.push(handled.error)
        continue
      }
      let snapshot: Awaited<ReturnType<typeof pullChecks>>
      try {
        snapshot = await pullChecks(cli, repo, pr.head.sha, undefined, signal)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        const action = await this.handleTargetError(repo, subject, error, nowMs)
        if (action === 'skip') continue
        targetErrors.push(error)
        continue
      }
      const counts = ciCounts(snapshot)
      const nowFailures = ciFailures(snapshot)
      const previous = this.deps.cursorStore.getPrCiBaseline(repo, target.number)

      if (!previous) {
        await this.deps.cursorStore.setPrCiBaseline(repo, target.number, {
          headSha: pr.head.sha,
          failures: nowFailures,
          revision: 1,
          updatedAt: nowMs,
        })
        continue
      }

      if (counts.running > 0 && nowFailures.length === 0 && previous.failures.length > 0 && previous.headSha === pr.head.sha) {
        continue
      }

      if (previous.headSha === pr.head.sha && JSON.stringify(nowFailures) === JSON.stringify(previous.failures)) {
        continue
      }

      const nextRevision = previous.revision + 1
      await this.deps.cursorStore.setPrCiBaseline(repo, target.number, {
        headSha: pr.head.sha,
        failures: nowFailures,
        revision: nextRevision,
        updatedAt: nowMs,
      })

      if (nowFailures.length === 0) continue

      const headRef = pr.head.ref
      const headRepo = pr.head.repo?.full_name?.toLowerCase() ?? repo
      const summary = ciSummary(snapshot, `${repo}#${target.number} (${headRef})`, pr.html_url)
      const outcome = await this.deps.adapter.receive({
        source: 'github',
        sourceId,
        deliveryId: prCiTriggerId(repo, target.number, nextRevision),
        type: 'check_suite.completed',
        subject: `${repo}:checks:ci@${headRef}`,
        title: clipText(`PR #${target.number} CI failure: ${nowFailures.slice(0, 3).join(', ')}`, 200),
        actor: 'github-actions[bot]',
        url: `${pr.html_url}/checks`,
        summary: clipText(summary, 500),
        receivedAt: nowMs,
        headRef,
        headRepo,
        originSource: 'github-poll',
      }, {
        repo,
        rawBody: summary,
        senderType: 'Bot',
        ciRelevant: true,
      })
      if (outcome.inboxResult === 'stored' || outcome.inboxResult === 'merged') {
        emitted += 1
      }
    }
    return targetErrors.length > 0 ? { events: emitted, error: targetErrors[0] } : { events: emitted }
  }
}
