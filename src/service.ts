/**
 * dot's orchestration core: owns the ledger, the pending requests, the
 * wake-up batches and the chain of session segments dot's conversation runs
 * in, and implements every tool and RPC on top of {@link DotHost}. The plugin
 * entry wires host events into it; the preset child plugin exposes its
 * operations as model tools.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { APPROVAL_DETAIL_LIMIT, approvalNotice } from './approval-risk.ts'
import type { IntendedRunPermission } from './approval-safe-auto.ts'
import { createTwoFilesPatch } from 'diff'
import { writerPrior, parseEvidenceRef, reportBullet, deliveryScope, scopeContainsPath, type DeliverySubject, type SubjectLook } from './acceptance.ts'
import { captureScopeAsync, defaultIgnoreCover, foldRel, ignoreCovered, isLinkReason, pruneSnapshots, readManifest, readSnapshotEntry, relativePath, saveSnapshot, scanScope, scanScopeAsync, baselineCaptures, wipeArtifacts, type SnapshotExclusion, type SnapshotSource } from './artifacts.ts'
import { attentionItems } from './board-groups.ts'
import { renderBrief, renderSupplement, runTitle } from './brief.ts'
import { bindRunSession, cancelWork, countRelayInserts, finishWork, launchReservedRun, observeRun, reconcileRun, supplementRun } from './execution.ts'
import { detectWorkspaceRoot } from './git-root.ts'
import { commitDelivery, createTaskWorktree, listTaskWorktrees, mergeInto, removeTaskWorktree, runGit, sanitizeRemoteDisplay, taskWorktreeRoot, type GitRunner, type TaskWorktree } from './git-worktree.ts'
import { defaultSelfBuild, insideOrEqual, libHashOf, realpathOrResolve, type SelfBackup, type SelfInstall, type SelfUpgradeMarker } from './self-root.ts'
import {
  WRITE_PATHS_EXAMPLE, artifactName, constraintList, jsonArray,
  occupantOf, pathScope, plannedOccupant, plannedScope, requirementList, samePathList,
  stepList, verifyRefusal,
} from './work-actions.ts'
import { absoluteScopePath, canonicalPath, onDiskPath, changeIsTerminal, DEFAULT_RUN_ORIGIN, MAX_COMPLETED_CHANGES, InputShapeError, inputContractError, isSameOrChildPath, occupantsConflict, runCostTotals, runIsTerminal, scopeWithinRoot, scopeWrites, type ChangeRecord, type Constraint, type Occupant, type Requirement, type RootHint, type RunOrigin, type RunRecord, type TaskIsolation, type WorkRefusal, type WriteScope } from './work.ts'
import type { ShownView, ViewAnswer } from '@klarkxy/dsh-deep-view/contracts'
import { DotCards, cardAnswerText, type DotCardRecord } from './card-state.ts'
import { checkChatImages, type ChatImage } from './chat-images.ts'
import { approvalDisplay, parseNotice } from './chat-format.ts'
import { cardText } from './cards.ts'
import { NoticeBatcher, formatNotices, formatNoticeDisplay, realTimer, type Notice, type Timer } from './batcher.ts'
import { ZERO_USAGE, addUsage, combineUsage, netSegmentUsage, totalUsage, usageFromEvents } from './context.ts'
import { PRESET_ID, TOOL, type AttentionView, type BoardView, type DotContextSections, type DotContextUsage, type DotContextView, type FactoryResetPreview, type FactoryResetResult, type InboxEventInput, type InboxRecord, type InboxSubmitResult, type KeepaliveInfo, type KnowledgeView, type ModelChoice, type PendingKind, type PendingQuestionItem, type RecipeBody, type RecipeProposal, type RecipeProposalView, type RecipeRecord, type ReflectionRun, type RolloverReason, type RuleConfig, type TaskPermission, type TrajectoryView } from './contracts.ts'
import { SUMMARY_INSTRUCTION, SUMMARY_MAX_TOKENS, buildHandoff, type Handoff } from './handoff.ts'
import { READ_ROWS_DEFAULT, READ_ROWS_MAX, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_SESSIONS_MAX, formatRead, formatSearch, historyRows, queryTerms, searchRows, windowRows, type SessionHits } from './history.ts'
import { InboxLedger, fenceUntrusted, inboxNotice, memoryInboxTable } from './inbox.ts'
import { type DotHost, type WorkspaceRow } from './host.ts'
import { clip, ledgerSummary } from './ledger.ts'
import { applyLinkEvent, linkMatchesSubject, makeTaskLink, parseLinkRef, scanReportLinks, taskLinkId } from './links.ts'
import { directoriesConflict } from './lock.ts'
import { IdleChecker, idleCandidates } from './idle-check.ts'
import { ACCEPTED_DELIVERY_HINT, IDLE_SILENCE_HINT } from './task-hints.ts'
import { AutoUpdater, type PluginManagerLike, type UpdateStatus } from './auto-update.ts'
import { DOT_TRACE, emitDotTrace, type DotTraceInput } from './trace.ts'
import type { RunAccess, RunKind, ChangePriority, TaskLink } from './contracts.ts'
import { KnowledgeError, agreementEntriesFromText, agreementNotesBlock, agreementsSection, applyAgreementEdit, applyCognitionEdit, applyCognitionOps, cognitionSection, cognitionWithActive, filterCognitionEntries, matchEntry, normalizeEntry, parseCognitionOps, parseKnowledgeEdit, sameEntries } from './memory.ts'
import { COGNITION_PROMPT_ENTRIES_DEFAULT, type AgreementEntry, type CognitionEntry, type KnowledgeEdit } from './contracts.ts'
import { deliverPeer, guardRunWriteTool, PeerLedger, refreshChildSeals, sealChildSession, type PeerSendInput } from './peer.ts'
import { PendingHub, type PendingAnswer } from './pending.ts'
import { personaSection } from './persona.ts'
import { goalRequirements, mergedRecipeBody, mergeRecipeOutcomes, recipeBody, recipeBodyAt, recipeRegression, recipeRequirements, recipeRevisionStats, recipeStatsLine, recipeVersionAt, requirementsFollowGoal, reviseRecipe as reviseRecipeRecord, sameRecipeBody, upsertRecipeOutcome, type LiveRecipeChange, type RecipeRegression } from './recipes.ts'
import { ReflectionRunner } from './reflection.ts'
import { ReminderClock } from './reminders.ts'
import { routeRequest } from './rules.ts'
import { ScheduleInputError, describeTiming, onceDelivered, scheduleLines, type ScheduleInput } from './schedule.ts'
import { KEEPALIVE_MAX_PINGS, cacheTtlMinutes, defaultCacheTtl, keepaliveIntervalMs } from './keepalive.ts'
import { EMPTY_CAPABILITIES_SIGNATURE, IDLE_MIN_TOKENS, openingText, reasonAfterTurn, reasonBeforeDelivery, type Segment } from './segments.ts'
import { parseInboxRecord } from './storage.ts'
import type { DotStore } from './store.ts'
import { factoryResetArchiveIds, factoryResetCounts, factoryResetStopGap, factoryResetTokenError, issueFactoryResetToken, type FactoryResetStopEvidence } from './factory-reset.ts'
import { formatWorkspaceFiles, listWorkspaceFiles as listWorkspaceTree, readWorkspaceText, WORKSPACE_LIST_MAX } from './workspace-inspect.ts'
import { eventTier } from './tiers.ts'
import { ArenaQueryError } from './arena-models.ts'
import { TaskModelError, formatTaskModels, pickTaskModel, type TaskModelCatalog, type TaskModelQuery } from './task-models.ts'
import { TaskPresetError, pickTaskPreset, type TaskPresetCatalog, type TaskPresetChoice } from './task-presets.ts'
import { stamp, transcriptRows, type TranscriptRow } from './transcript.ts'
import { formatDuration, formatTokens } from './ui-copy.ts'
import type { RawEvent } from './chat.ts'
import { SelfSettings } from './self-settings.ts'
import { approvalCardCopy, copyLocale, t, type CopyLocale } from './i18n/index.ts'
import { HOST_SCHEDULE_MUTATORS, hostScheduleTargetsDot, isTaskOnlySelector, TASK_ONLY_TOOLS, type DotCapabilities } from './capabilities.ts'
import type { CapabilityCatalogView, CapabilityGrant, CapabilityGroupView, DotMcpListView, DotMcpServerView } from './contracts.ts'
import { dotOwnedCredentialRefs, mcpCredentialRefs } from './contracts.ts'
import { MCP_CATALOG } from './mcp-catalog.ts'
import { sharedDotMcp } from './mcp-shared.ts'
import type { GateVerdict } from './tool-scope.ts'
import { RetryHealth } from './retry-health.ts'
import type { WorkRunRetryStatus } from './contracts.ts'
import type { WorkBoardItem } from './work-board.ts'
import {
  BACKGROUND_LIMIT_MS,
  getAgentsService,
  hasJobsService,
  killJobs,
  QuietWaitTracker,
  runningJobs,
  subscribeJobsEvents,
  untilQuiet,
  type BackgroundAgentLike,
  type KilledJobSummary,
  type ServiceGetter,
} from './background.ts'
import {
  GithubPollCursorStore,
  GithubPollSourceAdapter,
  GithubPoller,
  observePullClosure,
  redactGithubTokens,
  type ExecFileRunner,
} from './github-poll/index.ts'
import { effectiveGithubPollSettings, normalizeGithubRepo } from './settings.ts'
import type { GithubPollStatusView, GithubPollTestResult } from './contracts.ts'

export interface DotServiceOptions {
  readonly host: DotHost
  /** Optional host service getter for duck-typed access to optional `jobs`, `subagents`, `agents`. */
  readonly get?: ServiceGetter
  /** Optional override for the 30-minute background quiet-wait cap (defaults to BACKGROUND_LIMIT_MS). */
  readonly backgroundLimitMs?: number
  /** Ledger and the human's settings: rules are read live from it. */
  readonly store: DotStore
  /** Working directory of dot's own session. */
  readonly homeDir: string
  /** Preferred UI locale when known at construction time. */
  readonly locale?: CopyLocale
  /** Let original-session answerers settle approvals before waking dot. */
  readonly approvalGraceMs?: number
  /** How many cognition entries reach dot's prompt; pinned entries always do on top. */
  readonly cognitionPromptEntries?: number
  readonly timer?: Timer
  readonly now?: () => number
  readonly log?: (message: string) => void
  /** Existing plugin logger. Absent in tests; a write failure never changes the decision. */
  readonly trace?: Parameters<typeof emitDotTrace>[0]
  /** Durable peer-delivery rows. Absent only in tests that never send one. */
  readonly peers?: PeerLedger
  /** Optional extra-capability layer; absent in tests that never grant one. */
  readonly capabilities?: DotCapabilities
  /** Durable inbox rows. Absent only in tests that never submit one. */
  readonly inbox?: InboxLedger
  /** The host's plugin-manager service, looked up lazily; absent in tests and hosts without it. */
  readonly pluginManager?: () => unknown
  /** Host credential store: describes and releases dot-local MCP tokens by ref name; never returns values. */
  readonly credentials?: {
    describe?(ref: string): Promise<{ readonly configured: boolean; readonly masked?: string } | undefined>
    unset?(ref: string): Promise<unknown>
  }
  /** Global MCP server names on the host (manager rows + root tool names); the MCP page marks clashes. */
  readonly globalMcpNames?: () => Iterable<string>
  /** Git runner for task-worktree isolation; tests inject a fake. */
  readonly git?: GitRunner
  /** dot's own install, detected from the running module; write work inside it is guarded. */
  readonly selfInstall?: SelfInstall
  /** Rebuild run after a merged self-upgrade lands in the linked checkout; tests inject a fake. */
  readonly selfBuild?: (root: string, signal?: AbortSignal) => Promise<{ readonly ok: boolean; readonly output: string }>
  /** Optional `gh` CLI exec runner override (used in mock-gh tests). */
  readonly ghExec?: ExecFileRunner
  /** Optional timer override for GitHub polling scheduler. */
  readonly githubPollTimer?: Timer
}

/** The history tools themselves: their calls and results are not part of the record they read. */
const LOOKUP_TOOLS: ReadonlySet<string> = new Set([TOOL.searchHistory, TOOL.readHistory])

/** Writer/rework dispatches on one input revision stop after this many failed rounds. */
const FAILED_ROUND_LIMIT = 3

/** Sidebar title of dot's own workspace; the host keeps one title per workspace, so it is not translated. */
export const HOME_TITLE = 'Dorothy'
/** The middle of the recommended 8–12 second window; profile config may override it. */
export const APPROVAL_GRACE_MS = 10_000
/** At most this many distinct inbox records ride one delivered batch; the rest stay pending for the next flush. */
const INBOX_NOTICES_PER_DELIVERY = 20

/** npm package name (scope optional); install proposals accept no paths, urls, or git specs. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/i
/** Install proposals pin an exact published version, never a range or tag. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

export class DotError extends HarnessError {
  constructor(code: string, message: string) { super(message, code) }
}

export type RelayOutcome =
  | { readonly decided: 'pending'; readonly id: string; readonly settled: Promise<PendingAnswer | undefined>; readonly withdraw: () => void }
  | { readonly decided: 'deny' }
  | { readonly decided: 'skip' }

export class DotService {
  readonly pending: PendingHub
  readonly selfSettings: SelfSettings
  private readonly batcher: NoticeBatcher
  private readonly idleChecker: IdleChecker
  private readonly reminders: ReminderClock
  private readonly inbox: InboxLedger
  private ensuring: Promise<string> | undefined
  private homeRegistered = false
  private lane: Promise<unknown> = Promise.resolve()
  private closing = false
  private disposal?: Promise<void>
  private readonly inFlight = new Set<Promise<unknown>>()
  /** One host-list reconciliation at a time; overlapping board polls share it. */
  private watchedSync?: Promise<void>
  private readonly now: () => number
  private idleSince?: number
  /** Changes to the agreements and cognition run one at a time, so two never start from the same text. */
  private knowledgeLane: Promise<unknown> = Promise.resolve()
  private requestedSegment?: { focus?: string }
  private readonly retryingCardNotifications = new Set<string>()
  /** Install proposals waiting on the human; in-memory only — a restart never resumes one. */
  private readonly pendingInstalls = new Map<string, { name: string; version: string; spec: string; reason: string; cardId?: string }>()
  /** Open capability asks, so a settings change that revokes the grant settles them before the human answers. */
  private readonly openCapabilityAsks = new Map<string, { readonly chain: readonly string[]; readonly withdraw: () => void }>()
  /** Decision wakes already queued in this process. The durable mark is notifiedAt. */
  private readonly decisionWakes = new Set<string>()
  /** Truncated approvals dot read in full; allowing one without a read is refused. */
  private readonly readApprovals = new Set<string>()
  private readonly childRefreshers = new Set<() => void>()
  private readonly childReleases = new Map<string, () => void>()
  private resetArmed?: { readonly token: string; readonly expiresAt: number }
  /** Bumped by every factory reset so a report captured across it skips link writes. */
  private resetGeneration = 0
  private currentLocale: CopyLocale | undefined
  private readonly updates: AutoUpdater
  private readonly timer: Timer
  /** The armed cache-keepalive of the current idle stretch; lastAt is the last turn end or ping. */
  private keepalive?: { readonly sessionId: string; pings: number; lastAt: number; handle?: unknown }
  /** The last successful cache ping, scoped to the dot session it warmed. */
  private lastKeepaliveAt?: { readonly sessionId: string; readonly at: number }
  readonly cards: DotCards
  /** The single background reflection pass; the reminder clock ticks its gate. */
  readonly reflection: ReflectionRunner
  /**
   * The upgrade marker that was already on disk when this process started.
   * Only that marker may be hashed, announced, and cleared; a marker this
   * instance writes in deploySelfBuild stays until a new process starts.
   */
  private readonly startupSelfUpgrade: SelfUpgradeMarker | undefined
  readonly retryHealth = new RetryHealth()
  private readonly sessionEventListeners = new Set<(sessionId: string, event: RawEvent) => void>()
  private readonly quietWaits = new QuietWaitTracker()
  private readonly backgroundJobsListeners = new Set<() => void>()
  private backgroundJobsUnsub?: () => void
  private backgroundJobsSubscribedTo?: unknown
  private activeTurnOrigin: RunOrigin | undefined
  private readonly emittedClosures = new Set<string>()
  readonly githubPollCursorStore: GithubPollCursorStore
  private readonly githubPollAdapter: GithubPollSourceAdapter
  private readonly githubPoller: GithubPoller

  private get getService(): ServiceGetter | undefined { return this.options.get }

  constructor(private readonly options: DotServiceOptions) {
    this.currentLocale = options.locale ?? options.store.uiLocale
    this.inbox = options.inbox ?? new InboxLedger(memoryInboxTable(), parseInboxRecord)
    this.cards = new DotCards(options.store, options.log, () => this.now())
    this.now = options.now ?? Date.now
    this.timer = options.timer ?? realTimer
    this.pending = new PendingHub(this.now)
    this.pending.onChange(() => { void this.pruneApprovalDetails() })
    this.selfSettings = new SelfSettings(this)
    this.reflection = new ReflectionRunner({
      host: options.host,
      store: options.store,
      homeDir: options.homeDir,
      now: this.now,
      applyCognition: (ops, baseVersion) => this.applyCognitionOps(ops, baseVersion),
      cognitionPromptEntries: () => this.cognitionPromptEntries,
      isDotIdle: () => {
        const dot = this.store.dotSessionId
        return dot !== undefined && !this.options.host.isRunning(dot)
      },
      recipeHints: () => this.reflectionRecipeHints(),
      ...options.log ? { log: options.log } : {},
    })
    this.pending.onChange(() => {
      this.batcher.dropWhere(item => item.requestId !== undefined && this.pending.get(item.requestId) === undefined)
      this.armIdleCheck()
      void this.store.syncPending(this.pending.list())
    })
    this.retryHealth.onChange(() => { this.armIdleCheck() })
    this.ensureBackgroundJobsSubscription()
    this.idleChecker = new IdleChecker(
      () => this.canIdleCheck()
        ? idleCandidates(this.store.list(), this.pending.list(), this.store.workIdle(), this.retryingSessionIds(), this.backgroundBusySessionIds())
        : [],
      candidates => {
        this.emit({ event: DOT_TRACE.idleFired, message: 'Routine check fired.', data: { candidates: candidates.map(row => `${row.id}:${row.reason}`).join('; ') } })
        this.notify({ sessionId: this.store.dotSessionId!, kind: 'idle-check', text: `Routine check: ${candidates.map(row => `${row.id} "${row.title}": ${row.reason}`).join('; ')}\n  ${IDLE_SILENCE_HINT}`, at: this.now() })
      },
      options.timer,
      () => this.emit({ event: DOT_TRACE.idleSuppressed, message: 'Routine check did not fire.', data: { reason: 'unchanged' } }),
    )
    this.batcher = new NoticeBatcher(items => this.deliver(items), {
      isIdle: () => !!this.store.dotSessionId && !this.host.isRunning(this.store.dotSessionId),
      onEnqueue: () => this.idleChecker.cancel(),
      onEmpty: () => this.armIdleCheck(),
      ...options.timer ? { timer: options.timer } : {},
    })
    this.reminders = new ReminderClock({
      store: options.store,
      now: this.now,
      deliver: text => this.remind(text),
      runRecipe: record => this.recipeReminderRun(record),
      // The reflection check and a usage pass ride the reminder clock's
      // periodic wake-up; usage goes straight in (not revision-gated) so a
      // drained backlog still resumes on the next tick.
      onPeriodic: () => { void this.captureRunUsage(); void this.checkRecipeRegressions().catch(() => undefined); void this.reflection.tick().catch(() => undefined) },
      ...options.timer ? { timer: options.timer } : {},
      ...options.log ? { log: options.log } : {},
    })
    this.updates = new AutoUpdater({
      manager: () => options.pluginManager?.() as PluginManagerLike | undefined,
      store: options.store,
      settings: () => options.store.settings,
      isQuiet: () => {
        const dot = this.store.dotSessionId
        return !this.closing && (dot === undefined || !this.host.isRunning(dot)) && this.batcher.size === 0 && this.pending.list().length === 0
      },
      now: this.now,
      timer: options.timer ?? realTimer,
      ...options.log ? { log: options.log } : {},
      emit: input => this.emit(input),
    })
    this.startupSelfUpgrade = options.store.selfUpgrade
    this.githubPollCursorStore = new GithubPollCursorStore(options.store.githubPollTable())
    this.githubPollAdapter = new GithubPollSourceAdapter({
      settings: () => effectiveGithubPollSettings(this.store.settings),
      cursorStore: this.githubPollCursorStore,
      homeDir: options.homeDir,
      links: () => this.store.links,
      putLink: link => this.store.putLink(link),
      change: id => this.store.work.change(id),
      runsForChange: changeId => this.store.work.listRuns().filter(run => run.changeId === changeId),
      markClosureReady: (changeId, detail) => this.store.work.markClosureReady(changeId, detail),
      emitResultNotice: (change, detail) => this.emitClosureResultNotice(change, detail),
      inboxList: () => this.inbox.list(),
      submitInbox: event => this.submitInbox(event),
      supplementWorkRun: (runId, text, senderId, expected) => this.supplementWorkRun(runId, text, senderId, expected),
      dotSessionId: () => this.store.dotSessionId,
      trace: (event, message, data) => this.emit({ event, message, ...(data ? { data } : {}) }),
      now: this.now,
    })
    this.githubPoller = new GithubPoller({
      settings: () => effectiveGithubPollSettings(this.store.settings),
      cursorStore: this.githubPollCursorStore,
      adapter: this.githubPollAdapter,
      links: () => this.store.links,
      putLink: link => this.store.putLink(link),
      changes: () => new Map(this.store.work.listChanges().map(c => [c.id, c])),
      runs: () => this.store.work.listRuns(),
      onCycleEvents: () => { this.batcher.wake() },
      trace: (event, message, data) => this.emit({ event, message, ...(data ? { data } : {}) }),
      log: options.log,
      timer: options.githubPollTimer ?? options.timer,
      now: this.now,
      ...(options.ghExec ? { exec: options.ghExec } : {}),
    })
  }

  get store(): DotStore { return this.options.store }
  get host(): DotHost { return this.options.host }
  get rules(): RuleConfig { return this.store.settings }
  get dotSessionId(): string | undefined { return this.store.dotSessionId }
  get locale(): CopyLocale { return this.currentLocale ?? this.store.uiLocale ?? 'zh' }

  async syncLocale(raw: string | undefined): Promise<CopyLocale> {
    if (!raw?.trim()) return this.locale
    const next = copyLocale(raw, 'en')
    const before = this.locale
    this.currentLocale = next
    await this.store.setUiLocale(next)
    if (before !== next && !this.closing) {
      const dot = this.store.dotSessionId
      const segment = this.store.segment
      if (dot && segment && segment.sessionId === dot && !this.host.isRunning(dot)) {
        await this.serial(() => this.refreezeIfUnreplied(dot)).catch(() => undefined)
      }
    }
    return next
  }

  isDot(sessionId: string | undefined): boolean {
    return sessionId !== undefined && sessionId === this.store.dotSessionId
  }

  /** Whether a session belongs to Dorothy's live segment or a dot-dispatched run. */
  isManagedSession(sessionId: string | undefined): boolean {
    if (!sessionId) return false
    return this.isDot(sessionId) || this.store.ownsSession(sessionId) || this.store.work.sessionRun(sessionId) !== undefined
  }

  onRetryChange(listener: () => void): () => void {
    return this.retryHealth.onChange(listener)
  }

  hasActiveQuietWait(sessionId: string): boolean {
    return this.quietWaits.has(sessionId)
  }

  quietWaitMs(sessionId: string, now = this.now()): number {
    return this.quietWaits.quietWaitMs(sessionId, now)
  }

  onBackgroundJobsChange(listener: () => void): () => void {
    this.backgroundJobsListeners.add(listener)
    this.ensureBackgroundJobsSubscription()
    return () => { this.backgroundJobsListeners.delete(listener) }
  }

  private ensureBackgroundJobsSubscription(): void {
    if (this.closing) return
    let jobsObj: unknown
    try { jobsObj = this.getService?.('jobs') } catch { jobsObj = undefined }
    if (jobsObj === this.backgroundJobsSubscribedTo && this.backgroundJobsUnsub !== undefined) return
    if (jobsObj === undefined && this.backgroundJobsSubscribedTo === undefined) return
    try { this.backgroundJobsUnsub?.() } catch { /* best effort */ }
    this.backgroundJobsUnsub = undefined
    this.backgroundJobsSubscribedTo = jobsObj
    if (!jobsObj || typeof jobsObj !== 'object') return
    this.backgroundJobsUnsub = subscribeJobsEvents(this.getService, { owners: 'all' }, event => {
      if (this.closing) return
      if (!event || (event.type !== 'registered' && event.type !== 'settled' && event.type !== 'removed')) return
      const owner = event.job?.owner
      const run = typeof owner === 'string' ? this.store.work.sessionRun(owner) : undefined
      if (!run || runIsTerminal(run)) return
      this.armIdleCheck()
      for (const listener of [...this.backgroundJobsListeners]) {
        try { listener() } catch { /* observer only */ }
      }
    })
  }

  private abortQuietWait(sessionId: string | undefined, reason: string, clearAbandoned = true): void {
    if (!sessionId) return
    const aborted = this.quietWaits.abort(sessionId, this.now(), reason)
    if (clearAbandoned) this.quietWaits.clearAbandoned(sessionId)
    if (aborted) this.armIdleCheck()
  }

  private backgroundBusySessionIds(): ReadonlySet<string> {
    const busy = new Set<string>(this.quietWaits.activeSessionIds())
    for (const item of this.store.workIdle()) {
      for (const sessionId of item.sessionIds) {
        if (!busy.has(sessionId) && runningJobs(this.getService, sessionId).length > 0) busy.add(sessionId)
      }
    }
    for (const run of this.store.work.occupying()) {
      const sessionId = run.sessionId ?? run.requestedSessionId
      if (sessionId && !busy.has(sessionId) && runningJobs(this.getService, sessionId).length > 0) busy.add(sessionId)
    }
    return busy
  }

  /** Shared active managed session event stream subscriber (used by PR-2, PR-3, PR-6). */
  subscribeManagedSessionEvents(listener: (sessionId: string, event: RawEvent) => void): () => void {
    this.sessionEventListeners.add(listener)
    return () => { this.sessionEventListeners.delete(listener) }
  }

  onSessionEvent(sessionId: string, event: RawEvent): void {
    if (this.closing || !sessionId || !this.isManagedSession(sessionId)) return
    if (event.type === 'user/message') {
      const sourceKind = (event.data as { source?: { kind?: unknown } } | undefined)?.source?.kind
      if (sourceKind !== 'tool-jobs') this.quietWaits.clearAbandoned(sessionId)
    }
    this.retryHealth.observe(sessionId, event)
    for (const listener of [...this.sessionEventListeners]) {
      try { listener(sessionId, event) } catch { /* observer only */ }
    }
  }

  onAgentCreated(sessionId: string, status: 'idle' | 'running', events: readonly RawEvent[]): void {
    if (this.closing || !sessionId || !this.isManagedSession(sessionId)) return
    this.retryHealth.restore(sessionId, events)
    if (status === 'idle') this.retryHealth.clear(sessionId)
  }

  backfillManagedRetryHealth(): void {
    if (this.closing) return
    let live: ReturnType<NonNullable<DotHost['listLiveAgents']>>
    try {
      live = this.host.listLiveAgents?.() ?? []
    } catch {
      return
    }
    for (const agent of live) {
      if (!agent?.sessionId || !this.isManagedSession(agent.sessionId)) continue
      this.retryHealth.restore(agent.sessionId, agent.events)
      if (agent.status === 'idle') this.retryHealth.clear(agent.sessionId)
    }
  }

  noteAgentDisposed(sessionId: string): void {
    this.retryHealth.remove(sessionId)
    this.quietWaits.remove(sessionId, this.now())
    this.armIdleCheck()
  }

  private retryingSessionIds(): ReadonlySet<string> {
    return new Set(this.retryHealth.list().map(row => row.sessionId))
  }

  private withRetryStatus(item: WorkBoardItem): WorkBoardItem {
    this.ensureBackgroundJobsSubscription()
    const jobsAvailable = hasJobsService(this.getService)
    let changed = false
    const runs = item.runs.map(run => {
      const status = run.sessionId ? this.retryHealth.get(run.sessionId) : undefined
      const liveRun = run.phase !== 'completed' && run.phase !== 'failed' && run.phase !== 'stopped'
      const backgroundJobCount = jobsAvailable && liveRun && run.sessionId
        ? runningJobs(this.getService, run.sessionId).length
        : 0
      if (!status && backgroundJobCount === 0) return run
      changed = true
      const retryStatus: WorkRunRetryStatus | undefined = status
        ? {
            kind: status.kind,
            attempts: status.attempts,
            since: status.since,
            accumulatedMs: status.accumulatedMs,
          }
        : undefined
      return {
        ...run,
        ...(retryStatus !== undefined ? { retryStatus } : {}),
        ...(backgroundJobCount > 0 ? { backgroundJobCount } : {}),
      }
    })
    return changed ? { ...item, runs } : item
  }

  /** Deny child-session tools on one agent, enforce run write-scopes, and register dot_peer. A repeat is a no-op. */
  sealAgent(agent: unknown): void {
    const id = (agent as { session?: { id?: unknown } } | null)?.session?.id
    const guard = typeof id === 'string'
      ? (exec: Parameters<typeof guardRunWriteTool>[1]) => {
          const run = this.store.work.sessionRun(id)
          return run ? guardRunWriteTool(run, exec) : { allow: true as const }
        }
      : undefined
    const sealed = sealChildSession(agent, input => this.peerSend(input), this.childRefreshers, guard)
    if (sealed.applied && typeof id === 'string') {
      this.childReleases.set(id, sealed.release)
      this.emit({ event: DOT_TRACE.childSealed, message: `Sealed child-session tools on ${id}.`, sessionId: id })
    }
  }

  refreshChildSeals(): void { refreshChildSeals(this.childRefreshers) }

  /** Drop one sealed agent so a closed session does not keep its context alive. */
  releaseChildSeal(sessionId: string): void {
    const release = this.childReleases.get(sessionId)
    if (!release) return
    this.childReleases.delete(sessionId)
    release()
  }

  releaseChildSeals(): void {
    const releases = [...this.childReleases.values()]
    this.childReleases.clear()
    this.childRefreshers.clear()
    for (const release of releases) release()
  }

  /** Seal only a session this ledger already records as one dot opened. */
  sealIfOwned(agent: unknown): void {
    const id = (agent as { session?: { id?: unknown } } | null)?.session?.id
    if (typeof id !== 'string' || this.isDot(id) || !this.store.ownsSession(id)) return
    this.sealAgent(agent)
  }

  /** Best-effort seal for sessions that were already open when the plugin started. */
  async sealExisting(): Promise<void> {
    // Approval requests live only in memory; a restart leaves their cards
    // unanswerable, so unanswered approval-bound cards expire now.
    for (const card of this.store.cards) {
      if (card.approvalId !== undefined && !card.answer && !card.expired) {
        await this.store.expireCard(card.id).catch(error => this.options.log?.(`dsh-dot: stale card expiry was not saved: ${messageOf(error)}`))
      }
    }
    const prepare = this.host.prepareOwnedSession
    if (!prepare) return
    for (const sessionId of this.store.ownedSessionIds()) {
      try { await prepare.call(this.host, sessionId) } catch { /* the next status event seals a live agent */ }
    }
  }

  peerSend(input: PeerSendInput): Promise<string> {
    const ledger = this.options.peers
    if (!ledger) return Promise.resolve('Error [dot/peer-unavailable]: peer delivery is not available; nothing was sent.')
    return ledger.run(() => deliverPeer(input, {
      now: () => this.now(),
      owns: id => this.store.ownsSession(id),
      isDorothy: id => this.store.dotSessionId === id,
      bounce: async ({ senderSessionId, deliveryId, text }) => {
        const run = this.store.work.sessionRun(senderSessionId)
        const subject = run ? `task:${run.changeId}` : `session:${senderSessionId}`
        const title = run ? `Worker ${run.id} bounced out-of-scope follow-up` : 'Worker bounced out-of-scope follow-up'
        const result = await this.submitInbox({
          source: 'dot-peer',
          sourceId: senderSessionId,
          deliveryId,
          type: 'peer.bounce',
          subject,
          title,
          actor: senderSessionId,
          summary: redactGithubTokens(text).replace(/\s+/g, ' ').trim().slice(0, 500),
          receivedAt: this.now(),
        })
        this.emit({
          event: DOT_TRACE.githubPollBounced,
          message: `Worker ${senderSessionId} bounced follow-up ${deliveryId} to inbox.`,
          sessionId: senderSessionId,
          ...(run ? { changeId: run.changeId } : {}),
          data: { deliveryId, result },
        })
        return result
      },
      get: id => ledger.read(id),
      put: row => ledger.write(row),
      prove: async (target, sender, deliveryId, text) => {
        try { return countRelayInserts(await this.host.readEvents(target), deliveryId, sender, text) } catch { return undefined }
      },
      relay: async (target, sender, text, deliveryId) => {
        this.abortQuietWait(target, 'peer', true)
        this.store.work.claimLiveRelay(deliveryId)
        try {
          await this.host.relay(target, sender, text, deliveryId, () => this.peerTarget(target).ok)
        } finally {
          this.store.work.releaseLiveRelay(deliveryId)
        }
      },
      hold: (target, sender, deliveryId, text) => this.store.work.holdPeer(target, sender, deliveryId, text, this.now()),
      release: (target, deliveryId, status) => this.store.work.settlePeer(target, deliveryId, status, this.now()),
      admit: target => this.peerTarget(target),
      trace: (event, message, data) => this.emit({
        event,
        message,
        ...(typeof data.senderSessionId === 'string' ? { sessionId: data.senderSessionId } : {}),
        data,
      }),
    }))
  }

  /** Same delivery gate as a supplement: the target run is active and still holds its current input. */
  private peerTarget(sessionId: string): { readonly ok: true } | { readonly ok: false; readonly message: string } {
    const run = this.store.work.sessionRun(sessionId)
    if (!run) return { ok: false, message: `${sessionId} has no run; nothing was sent. Read the board instead of messaging a finished session.` }
    if (run.phase !== 'active') return { ok: false, message: `${run.id} is ${run.phase}; nothing was sent. Read the board instead of messaging a finished session.` }
    const allowed = this.store.work.dispatchAllowed(run.id)
    if (!allowed.ok) return { ok: false, message: `${allowed.message}; nothing was sent.` }
    return { ok: true }
  }

  /**
   * Return dot's live session, resuming it after a restart and creating it on
   * first use. A stored session that cannot be reopened is followed by a new
   * segment that carries over what its log still gives. dot's sessions carry
   * the subagent origin, so the sidebar never lists them; the plugin's own
   * panel is their only chat.
   */
  ensureDot(): Promise<string> {
    if (this.closing) return Promise.reject(new DotError('dot/disposed', 'dot is shutting down'))
    this.ensuring ??= (async () => {
      try {
        // Registered once per run, so the workspace is in the sidebar from dot's first use on.
        if (!this.homeRegistered) {
          await this.homeWorkspace().then(() => { this.homeRegistered = true }, error => { this.options.log?.(`dsh-dot: dot's own workspace was not registered: ${messageOf(error)}`) })
        }
        const existing = this.store.dotSessionId
        if (existing === undefined) {
          await mkdir(this.options.homeDir, { recursive: true })
          const sessionId = await this.host.createDot(this.options.homeDir, PRESET_ID)
          await this.store.beginSegment({ sessionId, startedAt: this.now(), ...await this.frozen(sessionId) })
          return this.openedDot(sessionId)
        }
        if (await this.host.resumeDot(existing, PRESET_ID)) {
          // A session from before segments existed gets its record on first use.
          if (!this.store.segment) await this.store.beginSegment({ sessionId: existing, startedAt: this.now(), ...await this.frozen(existing) })
          return this.openedDot(existing)
        }
        await mkdir(this.options.homeDir, { recursive: true })
        return this.openedDot(await this.rollover(existing, 'lost'))
      } finally {
        this.ensuring = undefined
      }
    })()
    return this.ensuring
  }

  /** The human's message from dot's chat panel. Images are admitted with the text. */
  async say(text: string, cardReply?: { card: DotCardRecord; answer: ViewAnswer }, images?: readonly ChatImage[]): Promise<void> {
    const body = text.trim()
    const pictures = checkChatImages(images)
    if (!body && pictures.length === 0) throw new DotError('dot/invalid', 'message must be non-empty')
    await this.serial(async () => {
      this.activeTurnOrigin = undefined
      const dot = await this.ready()
      // The human already wakes dot, so carried updates join the same message
      // instead of becoming a separate model turn of their own.
      const notices = this.liveNotices(this.batcher.take())
      const card = cardReply && this.store.cards.find(row => row.id === cardReply.card.id)
      const message = cardReply ? cardAnswerText(card ?? cardReply.card, cardReply.answer, this.locale) : body
      // A pending agreement note from the reflection pass rides the same carried
      // prefix as batched updates; it reaches dot once and is cleared after delivery.
      const agreementNotes = this.store.agreementNotes.trim()
      const carried = [
        agreementNotes ? agreementNotesBlock(agreementNotes) : '',
        notices.length > 0 ? this.formatQueuedNotices(notices) : '',
      ].filter(Boolean).join('\n\n')
      try {
        await this.host.say(dot, message, carried || undefined, cardReply?.answer, pictures.length > 0 ? pictures : undefined, notices.length ? formatNoticeDisplay(notices) : undefined)
      } catch (error) {
        this.batcher.restore(this.liveNotices(notices))
        throw error
      }
      await this.ackInboxWakes(notices).catch(error => this.options.log?.(`dsh-dot: inbox event was not marked delivered: ${messageOf(error)}`))
      this.recoverInbox()
      // Delivery already succeeded: a bookkeeping failure must never requeue
      // carried notices or invite the human to send the same answer twice.
      if (agreementNotes) await this.store.clearAgreementNotes().catch(error => this.options.log?.(`dsh-dot: agreement note was not cleared: ${messageOf(error)}`))
      await this.store.expireCards(cardReply?.card.id).catch(error => this.options.log?.(`dsh-dot: card expiry was not saved: ${messageOf(error)}`))
      await this.store.noteConversation(this.now()).catch(error => this.options.log?.(`dsh-dot: conversation time was not saved: ${messageOf(error)}`))
    })
  }

  private openApprovalIds(): Set<string> {
    return new Set(this.pending.list().filter(row => row.kind === 'approval').map(row => row.id))
  }

  saveApprovalDetail(detail: import('./contracts.ts').ApprovalDetail): Promise<void> {
    if (this.closing) return Promise.reject(new DotError('dot/disposed', 'dot is shutting down'))
    // Update store.approvalDetails synchronously before async persistence so
    // dot_answer action=read never races with a newly arrived request.
    const run = this.store.saveApprovalDetail(detail, this.openApprovalIds())
    this.inFlight.add(run)
    void run.then(() => this.inFlight.delete(run), () => this.inFlight.delete(run))
    return run
  }

  readApprovalDetail(id: string): string {
    const detail = this.store.approvalDetails.find(row => row.requestId === id)
    if (detail) {
      this.readApprovals.add(id)
      return JSON.stringify(detail)
    }
    if (this.pending.get(id)?.kind === 'approval') {
      throw new DotError('dot/human-required', `full arguments for approval ${id} are unavailable; relay it to the human for a direct decision`)
    }
    throw new DotError('dot/unknown-request', `no recorded approval ${id}`)
  }

  /**
   * The pre-execute verdict for a tool outside dot's locked set. A granted
   * extra runs only while it is still granted and was applied when the current
   * segment started: the human's mid-segment change never edits a live
   * request's tool list, but revocation denies at once.
   */
  async capabilityGate(exec: { readonly name: string; readonly callId?: string; readonly arguments?: unknown; readonly signal?: AbortSignal }): Promise<GateVerdict> {
    const caps = this.options.capabilities
    const dot = this.store.dotSessionId
    if (!caps || !dot || this.closing) return { kind: 'deny', reason: 'This preset cannot run that tool.' }
    // Task-run tools never reach dot's own session; if one was somehow applied
    // anyway the gate still refuses it here.
    if (TASK_ONLY_TOOLS.has(exec.name)) return { kind: 'deny', reason: `${exec.name} belongs to task runs; dispatch a dot_task instead.` }
    const entry = caps.appliedFor(dot)?.get(exec.name)
    if (!entry) return { kind: 'deny', reason: `The extra capability ${exec.name} was not applied to this segment.` }
    const live = caps.liveGrant(entry.chain)
    if (live !== 'ask' && live !== 'auto') return { kind: 'deny', reason: `The extra capability ${exec.name} is off.` }
    const scheduled = this.hostScheduleGate(exec)
    if (scheduled !== 'next') return scheduled
    if (live === 'auto') return 'next'
    const allowed = await this.askCapabilityApproval(exec, entry.chain)
    if (!allowed) return { kind: 'deny', reason: `The human declined ${exec.name}.` }
    // The human approved, but the grant may have been revoked while the card
    // was open — or in the instant after they answered. Re-resolve the live
    // state; an approval only counts while the grant still exists.
    const reapplied = caps.appliedFor(dot)?.get(exec.name)
    if (!reapplied) return { kind: 'deny', reason: `The extra capability ${exec.name} was not applied to this segment.` }
    const still = caps.liveGrant(reapplied.chain)
    if (still !== 'ask' && still !== 'auto') return { kind: 'deny', reason: `The extra capability ${exec.name} is off.` }
    return this.hostScheduleGate(exec)
  }

  /**
   * Host schedule_create/edit with target this_session (or a Dorothy segment
   * id) cannot be delivered: the controller refuses subagent-origin sessions,
   * and a later segment no longer uses that id. Reminders for Dorothy herself
   * go through `dot_schedule`.
   */
  private hostScheduleGate(exec: { readonly name: string; readonly arguments?: unknown }): GateVerdict {
    if (!HOST_SCHEDULE_MUTATORS.has(exec.name)) return 'next'
    const ids = new Set<string>()
    if (this.store.dotSessionId) ids.add(this.store.dotSessionId)
    if (this.store.segment?.sessionId) ids.add(this.store.segment.sessionId)
    for (const past of this.store.pastSegments) ids.add(past.sessionId)
    if (!hostScheduleTargetsDot(exec.arguments, ids)) return 'next'
    return { kind: 'deny', reason: `Host schedule tools cannot deliver to Dorothy's hidden session (this_session or a Dorothy segment id). Use ${TOOL.schedule} so the reminder follows the current conversation segment.` }
  }

  /**
   * A human-only approval card in dot's own panel for one `ask`-granted call.
   * It bypasses the relay path, which skips dot's own session; the abort
   * signal of the waiting call withdraws the request, and the card is expired
   * when it ends unanswered.
   */
  private async askCapabilityApproval(exec: { readonly name: string; readonly callId?: string; readonly arguments?: unknown; readonly signal?: AbortSignal }, chain: readonly string[]): Promise<boolean> {
    const sessionId = this.store.dotSessionId
    if (!sessionId || this.closing) return false
    const args = exec.arguments === undefined ? undefined : typeof exec.arguments === 'string' ? exec.arguments : JSON.stringify(exec.arguments)
    const opened = this.pending.open({
      kind: 'approval',
      sessionId,
      subject: exec.name,
      ...(args !== undefined ? { detail: args } : {}),
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      humanRequired: true,
    })
    if (!this.pending.get(opened.id)) return false
    this.openCapabilityAsks.set(opened.id, { chain, withdraw: opened.withdraw })
    let cardId: string | undefined
    try {
      await this.saveApprovalDetail({ requestId: opened.id, sessionId, ...(exec.callId !== undefined ? { callId: exec.callId } : {}), toolName: exec.name, ...(args !== undefined ? { arguments: args } : {}) })
      const copy = approvalCardCopy(this.locale)
      const presentation = await this.cards.present({ title: copy.title, interactive: true, view: { type: 'stack', children: [
        { type: 'text', text: `${copy.title} ${opened.id}\n${copy.request}: ${exec.name}${args ? `\n${clip(args, 1200)}` : ''}` },
        { type: 'confirm', id: 'approval', confirmLabel: copy.approve, cancelLabel: copy.deny },
      ] } }, `capability:${opened.id}`, opened.id)
      cardId = presentation.viewId
    } catch (error) {
      this.options.log?.(`dsh-dot: capability approval card failed: ${messageOf(error)}`)
      this.openCapabilityAsks.delete(opened.id)
      opened.withdraw()
      return false
    }
    const answer = await opened.settled
    this.openCapabilityAsks.delete(opened.id)
    if (cardId !== undefined && answer === undefined) await this.store.expireCard(cardId).catch(error => this.options.log?.(`dsh-dot: capability card expiry was not saved: ${messageOf(error)}`))
    return answer?.kind === 'approval' && answer.allow === true
  }

  /** The dot-local MCP servers plus the recommended catalog the MCP page draws. */
  async mcpServersView(): Promise<DotMcpListView> {
    const servers = this.store.settings.mcpServers ?? {}
    const statuses = sharedDotMcp().servers
    const views: DotMcpServerView[] = []
    for (const [name, row] of Object.entries(servers)) {
      const refs = mcpCredentialRefs(row)
      let credential: DotMcpServerView['credential']
      if (refs.length > 0) {
        const info = await this.options.credentials?.describe?.(refs[0]!).catch(() => undefined)
        credential = { ref: refs[0]!, configured: info?.configured === true, ...(info?.masked !== undefined ? { masked: info.masked } : {}) }
      }
      const status = statuses.get(name) ?? (row.enabled ? undefined : { state: 'off' })
      const catalogEntry = row.catalog === undefined ? undefined : MCP_CATALOG.find(entry => entry.id === row.catalog)
      views.push({
        name, url: row.url, enabled: row.enabled,
        auth: refs.length > 0 ? 'token' : 'none',
        ...(row.catalog !== undefined ? { catalog: row.catalog } : {}),
        ...(catalogEntry?.tokenUrl !== undefined ? { tokenUrl: catalogEntry.tokenUrl } : {}),
        ...(credential !== undefined ? { credential } : {}),
        ...(status !== undefined ? { status } : {}),
      })
    }
    const catalog = MCP_CATALOG.filter(entry => !(entry.id in servers)).map(entry => ({
      id: entry.id, name: entry.name, about: entry.about, url: entry.url, auth: entry.auth,
      ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
      ...(entry.tokenUrl !== undefined ? { tokenUrl: entry.tokenUrl } : {}),
      ...(entry.tokenHelp !== undefined ? { tokenHelp: entry.tokenHelp } : {}),
    }))
    const globals = [...(this.options.globalMcpNames?.() ?? [])].sort((a, b) => a.localeCompare(b))
    return { servers: views, catalog, globals }
  }

  /** The catalog, grants, and applied state the settings view draws. */
  async capabilitiesView(): Promise<CapabilityCatalogView> {
    const caps = this.options.capabilities
    const grants = this.store.settings.capabilities?.grants ?? {}
    const base = caps ? await caps.catalog() : { locked: [], groups: [] }
    const applied = caps?.appliedFor(this.store.dotSessionId)
    return { ...base, grants, applied: Object.fromEntries([...applied ?? []].map(([name, resolved]) => [name, resolved.grant])) }
  }

  /** Compact text tree of the catalog for dot_capabilities list. */
  async listCapabilities(): Promise<string> {
    const caps = this.options.capabilities
    if (!caps) return 'No capability catalog exists on this host.'
    const { locked, groups } = await caps.catalog()
    const grants = this.store.settings.capabilities?.grants ?? {}
    const applied = caps.appliedFor(this.store.dotSessionId)
    const lines = [`Locked dot tools (always on; cannot be granted or revoked): ${locked.length} inherited tools.`]
    if (groups.length === 0) lines.push('No extra capabilities are currently installed.')
    const row = (group: CapabilityGroupView, parents: readonly string[], indent: string) => {
      const grant = grants[group.id]
      // Only the host and builtin parent rows are display-only: their tools answer to child/per-tool grants.
      const displayOnly = group.kind === 'host' || group.id === 'builtin'
      const selector = displayOnly
        ? '(per-tool grants only)'
        : isTaskOnlySelector(group.id, groups)
          ? '(task-only: runs use it; never applied to dot)'
          : `[${group.id}] grant=${grant ?? 'inherited'}`
      lines.push(`${indent}${group.label} ${selector}${group.missing === true ? ' UNAVAILABLE' : ''}`)
      const chain = displayOnly ? parents : [group.id, ...parents]
      for (const tool of group.tools) {
        if (tool.missing === true) { lines.push(`${indent}  ${tool.name} — UNAVAILABLE (grant kept)`); continue }
        if (tool.taskOnly === true) {
          lines.push(`${indent}  ${tool.name} — grant=off (task-only: runs use it; never applied to dot)`)
          continue
        }
        let effective: string | undefined
        for (const selector of [`tool:${tool.name}`, ...chain]) { if (grants[selector] !== undefined) { effective = grants[selector]; break } }
        const flags = [tool.conditional ? 'conditional (when-gate bypassed while granted)' : '', applied?.has(tool.name) ? `applied=${applied.get(tool.name)?.grant}` : 'not applied this segment'].filter(Boolean).join(', ')
        lines.push(`${indent}  ${tool.name} — grant=${effective ?? 'off'}${flags ? ` (${flags})` : ''}`)
      }
      for (const child of group.children ?? []) row(child, chain, `${indent}  `)
    }
    for (const group of groups) row(group, [], '- ')
    lines.push(`Propose a change with action=propose; grants apply from the next segment and need human approval.`)
    return lines.join('\n')
  }

  /**
   * Queue a grant change for human approval. A well-shaped selector for a
   * tool that is not installed yet is still accepted; a selector naming a
   * locked dot tool is not.
   */
  async proposeCapability(input: { readonly selector: string; readonly grant: CapabilityGrant; readonly reason: string }): Promise<string> {
    const caps = this.options.capabilities
    if (!caps) throw new DotError('dot/invalid', 'no capability catalog exists on this host')
    const selector = input.selector.trim()
    if (selector === 'host' || selector === 'builtin') throw new DotError('dot/invalid', 'unattributed tools are granted one by one with tool:<name> or prefix:<segment>; there is no host-wide grant')
    if (!/^(tool|mcp|plugin|prefix|builtin):/.test(selector)) throw new DotError('dot/invalid', 'selector must be tool:<name>, mcp:<server>, plugin:<bundle>[#<entry>], builtin:<id>, or prefix:<segment>')
    if (selector.startsWith('tool:') && caps.locked.includes(selector.slice(5))) throw new DotError('dot/invalid', `${selector.slice(5)} is a locked dot tool; it is always on and cannot be granted`)
    let groups: readonly CapabilityGroupView[] | undefined
    try { groups = (await caps.catalog()).groups } catch { groups = undefined }
    if (isTaskOnlySelector(selector, groups)) {
      const name = selector.startsWith('tool:') ? selector.slice(5) : selector
      throw new DotError('dot/invalid', `${name} belongs to task runs; dispatch a dot_task instead.`)
    }
    if (!['off', 'ask', 'auto'].includes(input.grant)) throw new DotError('dot/invalid', 'grant must be off, ask, or auto')
    const grants = { ...this.store.settings.capabilities?.grants, [selector]: input.grant }
    return this.selfSettings.propose({ field: 'capabilities', value: { grants }, reason: input.reason })
  }

  /**
   * Queue a plugin installation for human approval. The call returns at once;
   * the human-only card's answer settles the pending request and settleInstall
   * runs the install (or reports the decline) through the notice channel.
   */
  async proposeInstall(input: { readonly spec: string; readonly version?: string; readonly reason: string }): Promise<string> {
    const pm = this.options.capabilities?.pluginManager()
    if (typeof pm?.inspect !== 'function' || typeof pm.installBundle !== 'function') throw new DotError('dot/invalid', 'this host cannot install plugins')
    const name = input.spec.trim()
    const given = input.version?.trim() ?? ''
    if (!NPM_NAME.test(name)) throw new DotError('dot/invalid', `${name || 'spec'} is not an npm package name`)
    const sessionId = this.store.dotSessionId
    if (!sessionId) throw new DotError('dot/invalid', 'dot has no session yet')
    let bundles
    try { bundles = await pm.listBundles() } catch (error) { throw new DotError('dot/unavailable', `cannot check installed bundles: ${messageOf(error)}`) }
    const existing = bundles.find(bundle => bundle.name === name)
    if (existing?.installed === true) throw new DotError('dot/invalid', `${name} is already installed`)
    if (existing?.readOnlyReason !== undefined) throw new DotError('dot/invalid', `${name} is a protected bundle managed by the host`)
    // An official on-demand row already pins the exact spec and version the
    // host offers; anything else official stays off-limits to dot.
    const official = existing?.official === true ? existing.installTarget : undefined
    if (existing !== undefined && existing.official === true && official === undefined) throw new DotError('dot/invalid', `${name} is a protected bundle managed by the host`)
    let spec: string
    let version: string
    let description: string | undefined
    if (official !== undefined) {
      if (given !== '' && given !== official.version) throw new DotError('dot/invalid', `the official ${name} build is ${official.version}; got "${given}"`)
      spec = official.spec
      version = official.version
      description = existing?.description
    } else {
      if (!EXACT_VERSION.test(given)) throw new DotError('dot/invalid', `version must be exact, e.g. 1.2.3; got "${given || 'none'}"`)
      version = given
      spec = `${name}@${version}`
      let inspection
      try { inspection = await pm.inspect(spec) } catch (error) { throw new DotError('dot/unavailable', `inspection failed: ${messageOf(error)}`) }
      if (inspection.status === 'refused') throw new DotError('dot/invalid', `${spec} refused (${inspection.problem}): ${inspection.reason}`)
      if (inspection.bundle === false) throw new DotError('dot/invalid', `${spec} declares no dsh bundle`)
      description = inspection.status === 'accepted' ? inspection.description : undefined
    }
    const opened = this.pending.open({ kind: 'approval', sessionId, subject: `${name}@${version}`, detail: input.reason, humanRequired: true })
    const meta: { name: string; version: string; spec: string; reason: string; cardId?: string } = { name, version, spec, reason: input.reason }
    this.pendingInstalls.set(opened.id, meta)
    try {
      await this.saveApprovalDetail({ requestId: opened.id, sessionId, toolName: `${TOOL.capabilities}:propose_install`, reason: input.reason, arguments: `${name}@${version}` })
      const copy = approvalCardCopy(this.locale)
      const presentation = await this.cards.present({ title: t(this.locale, 'sCapInstallTitle'), interactive: true, view: { type: 'stack', children: [
        { type: 'text', text: `${t(this.locale, 'sCapInstallTitle')} ${opened.id}\n${copy.request}: ${name}@${version}${description ? `\n${clip(description, 600)}` : ''}\n${input.reason}` },
        { type: 'confirm', id: 'approval', confirmLabel: copy.approve, cancelLabel: copy.deny },
      ] } }, `install:${opened.id}`, opened.id)
      meta.cardId = presentation.viewId
    } catch (error) {
      this.pendingInstalls.delete(opened.id)
      opened.withdraw()
      throw error
    }
    void opened.settled.then(answer => this.settleInstall(opened.id, answer))
    return `Install proposal ${opened.id} for ${name}@${version} is waiting for the human in dot's panel. Nothing installs until they approve; you will be told the outcome.`
  }

  /** Runs only on a live pending request's settlement — never after a restart. */
  private async settleInstall(requestId: string, answer: PendingAnswer | undefined): Promise<void> {
    const meta = this.pendingInstalls.get(requestId)
    if (!meta) return
    this.pendingInstalls.delete(requestId)
    const { name, version, spec } = meta
    if (answer === undefined) {
      if (meta.cardId !== undefined) await this.store.expireCard(meta.cardId).catch(error => this.options.log?.(`dsh-dot: install card expiry was not saved: ${messageOf(error)}`))
      return
    }
    const sessionId = this.store.dotSessionId
    if (!sessionId) return
    // The proposal id rides in the text: a notice keyed by requestId would be
    // dropped with the just-settled pending request instead of reaching dot.
    if (!(answer.kind === 'approval' && answer.allow === true)) {
      this.notify({ sessionId, kind: 'turn-end', text: `Install proposal ${requestId}: the human declined installing ${name}@${version}.`, at: this.now() }, true)
      return
    }
    const pm = this.options.capabilities?.pluginManager()
    if (typeof pm?.installBundle !== 'function') {
      this.notify({ sessionId, kind: 'turn-end', text: `Install proposal ${requestId}: approved install of ${name}@${version} cannot run: this host cannot install plugins.`, at: this.now() }, true)
      return
    }
    let text: string
    try {
      const result = await pm.installBundle(spec, { enabled: true, expected: { name, version }, requestId })
      if (result.error !== undefined || result.application === 'failed' || result.application === 'cancelled' || result.changed !== true) {
        text = `Install proposal ${requestId}: the human approved installing ${name}@${version}, but the install failed: ${result.error?.code ?? result.application}${result.error?.diagnostic ? ` — ${clip(result.error.diagnostic, 400)}` : ''}`
      } else {
        text = `Install proposal ${requestId}: Installed ${result.bundle ?? name}@${result.version ?? version} — the human approved the install. Its tools now appear in dot_capabilities (action=list) and stay off until granted; grants apply from the next segment.`
      }
    } catch (error) {
      text = `Install proposal ${requestId}: the human approved installing ${name}@${version}, but the install failed: ${messageOf(error)}`
    }
    this.notify({ sessionId, kind: 'turn-end', text, at: this.now() }, true)
  }

  presentCard(shown: ShownView, callId: string, approvalId?: string) {
    return this.serial(async () => {
      if (approvalId) {
        const request = this.pending.get(approvalId)
        if (!request || request.kind !== 'approval') throw new DotError('dot/unknown-request', 'approval is no longer pending')
        const copy = approvalCardCopy(this.locale)
        shown = { title: copy.title, interactive: true, view: { type: 'stack', children: [
          { type: 'text', text: `${copy.title} ${request.id}\n${copy.session}: ${request.sessionId}\n${copy.request}: ${request.subject}${request.detail ? `\n${clip(request.detail, 1200)}` : ''}` },
          { type: 'confirm', id: 'approval', confirmLabel: copy.approve, cancelLabel: copy.deny },
        ] } }
      }
      const presentation = await this.cards.present(shown, callId, approvalId)
      await this.store.noteConversation(this.now(), true)
      return presentation
    })
  }

  answerCard(id: string, action: string, values: unknown): Promise<{ notificationPending: boolean }> {
    return this.track(() => this.cards.answer(id, action, values, async (card, answer) => {
      if (card.approvalId) {
        if (answer.action !== 'approval' || typeof answer.values.confirmed !== 'boolean') throw new DotError('dot/invalid-answer', 'invalid approval decision')
        // A capability approval belongs to dot's own session; its answer resolves the waiting call, nothing is spoken into the chat.
        const own = this.pending.get(card.approvalId)?.sessionId === this.store.dotSessionId
        this.answerHumanApproval(card.approvalId, answer.values.confirmed)
        if (own) return false
        try { await this.say('card reply', { card, answer }); return false }
        catch (error) {
          this.options.log?.(`dsh-dot: approval committed, notification failed: ${messageOf(error)}`)
          this.emit({ event: DOT_TRACE.approvalNotifyFailed, level: 'warn', message: 'Approval notification failed.', ...(card.approvalId ? { data: { requestId: card.approvalId } } : {}) })
          return true
        }
      }
      await this.say('card reply', { card, answer })
      return false
    }))
  }

  retryCardNotification(id: string): Promise<void> { return this.track(() => this.retryCardNotificationNow(id)) }

  private async retryCardNotificationNow(id: string): Promise<void> {
    const card = this.store.cards.find(row => row.id === id)
    if (!card?.approvalId || !card.answer || !card.notificationPending) throw new DotError('dot/invalid', 'no pending approval notification')
    if (this.retryingCardNotifications.has(id)) throw new DotError('dot/invalid', 'notification retry already in progress')
    this.retryingCardNotifications.add(id)
    try {
      await this.say('card reply', { card, answer: card.answer })
      await this.store.setCardNotificationPending(id, false)
    } finally { this.retryingCardNotifications.delete(id) }
  }

  /**
   * The settings changed. A segment dot has not answered in takes the new
   * persona and model at once; any other keeps what it started with and is
   * left before the next delivery.
   */
  settingsChanged(): Promise<void> {
    this.armIdleCheck()
    this.updates.settingsChanged()
    this.githubPoller.settingsChanged()
    // The ds-dot/mcp preset row reconciles its mounts against the new settings.
    sharedDotMcp().onSettingsChanged?.()
    // A grant revoked while its approval card waits settles the ask at once:
    // the call denies and the card expires through the unanswered path. This
    // runs outside the serial lane so a queued settings write cannot stall
    // withdrawal behind itself.
    const caps = this.options.capabilities
    if (caps) {
      for (const [id, ask] of [...this.openCapabilityAsks]) {
        const grant = caps.liveGrant(ask.chain)
        if (grant !== 'ask' && grant !== 'auto') {
          this.openCapabilityAsks.delete(id)
          ask.withdraw()
        }
      }
    }
    return this.serial(async () => {
      const dot = this.store.dotSessionId
      if (!dot) return
      await this.dueBeforeDelivery(dot)
      this.applyModel(dot)
      // A new TTL moves the armed ping without resetting the stretch's count.
      if (this.keepalive) this.scheduleKeepalive(this.keepalive)
    }).catch(error => { this.options.log?.(`dsh-dot: settings not applied to dot's session: ${messageOf(error)}`) })
  }

  /**
   * The model Settings edits for cache TTL. While a ping is armed this is the
   * live session's model, so 0 pauses the stretch that is actually paying.
   * Otherwise it is the next-request model.
   */
  keepaliveInfo(): KeepaliveInfo | undefined {
    const armed = this.keepalive
    const model = (armed && this.host.sessionModel?.(armed.sessionId)) || this.host.dotModel()
    if (!model) return undefined
    return {
      provider: model.provider,
      model: model.model,
      minutes: cacheTtlMinutes(this.store.settings, model.provider, model.model),
      defaultMinutes: defaultCacheTtl(model.provider, model.model),
    }
  }

  /**
   * dot went idle. A segment past the rollover line is left right away, while
   * its prompt is still cached and before the next message has to wait for it.
   */
  onDotIdle(sessionId: string): Promise<void> {
    if (this.closing || !this.isDot(sessionId)) return Promise.resolve()
    this.activeTurnOrigin = undefined
    this.idleSince ??= this.now()
    this.batcher.wake()
    this.armIdleCheck()
    return this.serial(async () => {
      if (!this.isDot(sessionId) || !this.store.segment || this.host.isRunning(sessionId)) return
      const events = await this.host.readEvents(sessionId)
      const latest = transcriptRows(events).filter(row => row.role === 'dot').at(-1)
      if (latest) await this.store.noteConversation(latest.at, true)
      const requested = this.requestedSegment
      const reason: RolloverReason | undefined = requested ? 'dot-requested' : reasonAfterTurn(await this.host.dotContext(sessionId))
      if (!reason) {
        this.armKeepalive(sessionId, this.repliedInEvents(events).replied)
        return
      }
      this.cancelKeepalive()
      await this.rollover(sessionId, reason)
      this.requestedSegment = undefined
    }).catch(error => { this.options.log?.(`dsh-dot: segment check failed: ${messageOf(error)}`) })
  }

  async stop(): Promise<void> {
    const dot = this.store.dotSessionId
    if (dot) await this.host.stop(dot)
  }

  /** Context view of dot's live segment, with cumulative token totals across segments. */
  async contextView(): Promise<DotContextView> {
    const id = await this.ensureDot()
    const segment = this.store.segment
    if (segment && segment.sessionId === id && segment.persona !== personaSection(this.store.settings, this.locale) && !this.host.isRunning(id)) {
      await this.refreezeIfUnreplied(id).catch(() => undefined)
    }
    const raw = await this.host.dotContext(id)
    const sections = this.contextSections()
    if (!raw.live) return { ...raw, sections }
    const segmentRaw = raw.usage ?? usageFromEvents(await this.host.readEvents(id).catch(() => []))
    return {
      ...raw,
      sections,
      usage: combineUsage(segmentRaw, id, this.store.usageCarry, this.store.usageOffset),
    }
  }

  /** The frozen prompt blocks of the current segment, or the live text before a segment exists. */
  private contextSections(): DotContextSections {
    const segment = this.store.segment
    if (segment) return { persona: segment.persona, agreements: segment.agreements ?? '', cognition: segment.cognition ?? '', handoff: segment.opening ?? '' }
    return { persona: personaSection(this.store.settings, this.locale), agreements: this.currentAgreementsBlock(), cognition: this.currentCognitionBlock(), handoff: '' }
  }

  /** Zero cumulative token usage while keeping the current segment intact. */
  clearUsage(): Promise<DotContextView> {
    return this.serial(async () => {
      const id = await this.ensureDot()
      const raw = await this.host.dotContext(id)
      const segmentRaw = raw.usage ?? usageFromEvents(await this.host.readEvents(id).catch(() => []))
      await this.store.clearUsage(id, segmentRaw)
      return raw.live ? { ...raw, usage: ZERO_USAGE } : raw
    })
  }

  /** A model tool cannot release its own live session; move after the turn commits. */
  requestSegment(focus?: string): string {
    if (!this.store.dotSessionId) throw new DotError('dot/not-ready', 'your conversation is not ready yet')
    this.requestedSegment = { ...focus?.trim() ? { focus: focus.trim().slice(0, 1000) } : {} }
    return 'A fresh segment will start when this turn ends. Finish your reply normally; it will be carried into the handoff.'
  }

  previewFactoryReset(): FactoryResetPreview {
    this.assertOpen()
    const issued = issueFactoryResetToken(this.now())
    this.resetArmed = issued
    // Only worktrees a change's isolation record points at are reset candidates;
    // unknown dirs under <homeDir>/worktrees never count and are never touched.
    const worktrees = this.store.work.listChanges()
      .filter(change => change.isolation?.kind === 'worktree' && existsSync(change.isolation.worktree))
      .length
    return {
      ...factoryResetCounts(this.store, this.inbox.list().length, worktrees),
      token: issued.token,
      expiresAt: issued.expiresAt,
      archiveSessionIds: factoryResetArchiveIds(this.store),
    }
  }

  /**
   * Restore factory settings. Archives sessions Dorothy opened (not the
   * human's own), wipes her ledger, and starts a clean session.
   */
  confirmFactoryReset(token: string): Promise<FactoryResetResult> {
    return this.serial(async () => {
      this.assertOpen()
      const error = factoryResetTokenError(this.resetArmed, token, this.now())
      this.resetArmed = undefined
      if (error) throw new DotError('dot/invalid', error)
      // Cancel before sessions stop or the store is wiped: those both make
      // isQuiet true and would otherwise let a waiting check install.
      this.updates.interrupt()
      try {
        return await this.runFactoryReset()
      } catch (failure) {
        this.updates.settingsChanged()
        throw failure
      }
    })
  }

  private async runFactoryReset(): Promise<FactoryResetResult> {
    // No usage pass may start or commit while the book is being wiped; the flag
    // is cleared on the way out whether the reset completes or throws.
    this.usageStopped = true
    this.resetGeneration += 1
    try {
      const archiveIds = factoryResetArchiveIds(this.store)
      // The ownership list includes confirmed and uncertain host calls, but not
      // placeholder ids belonging to reservations that never reached the host.
      const stopIds = new Set(archiveIds)
      const unsettled: string[] = []
      for (const sessionId of stopIds) {
        const gap = factoryResetStopGap(sessionId, await this.proveFactoryResetStopped(sessionId))
        if (gap) unsettled.push(gap)
      }
      if (unsettled.length > 0) {
        throw new DotError(
          'dot/reset-busy',
          `factory reset aborted: ${unsettled.length} session(s) not settled (${unsettled.join('; ')}). Stop them first, then retry.`,
        )
      }
      this.idleChecker.cancel()
      this.cancelKeepalive()
      this.lastKeepaliveAt = undefined
      const archived: string[] = []
      const archiveFailed: { sessionId: string; message: string }[] = []
      for (const sessionId of archiveIds) {
        try {
          await this.host.archive(sessionId)
          archived.push(sessionId)
        } catch (failure) {
          archiveFailed.push({ sessionId, message: messageOf(failure) })
          this.options.log?.(`dsh-dot: factory reset did not archive ${sessionId}: ${messageOf(failure)}`)
        }
      }
      if (archiveFailed.length > 0) {
        throw new DotError('dot/reset-incomplete', `Factory reset is incomplete: sessions were stopped, but ${archiveFailed.length} could not be archived (${archiveFailed.map(row => `${row.sessionId}: ${row.message}`).join('; ')}). Dorothy's records and settings are retained. Request a new preview to retry.`)
      }
      // Keep the ledger until external cleanup succeeds, so a failed reset can be
      // retried with its original session ownership and cleanup scope still known.
      try {
        await this.options.peers?.clear()
        await this.inbox.clear()
        wipeArtifacts(this.options.homeDir)
        // Reset removes only the worktrees change records point at, with the
        // recorded repo and branch — never unknown dirs under home/worktrees.
        for (const change of this.store.work.listChanges()) {
          const isolation = change.isolation
          if (isolation?.kind !== 'worktree') continue
          // A failure here must propagate into dot/reset-incomplete so the
          // retained records let the human retry; do not swallow it.
          await removeTaskWorktree({ repoRoot: isolation.repoRoot, worktree: isolation.worktree, branch: isolation.branch, baseSha: isolation.baseSha }, this.git())
        }
        for (const leftover of listTaskWorktrees(this.options.homeDir)) {
          this.options.log?.(`dsh-dot: factory reset left unmanaged dir ${leftover} under worktrees`)
        }
      } catch (failure) {
        throw new DotError('dot/reset-incomplete', `Factory reset is incomplete: sessions were stopped and archived, but cleanup failed (${messageOf(failure)}). Some files may already have been removed; Dorothy's records and settings are retained. Request a new preview to retry.`)
      }
      const activeLocale = this.currentLocale ?? this.store.uiLocale
      if (this.usageHandle !== undefined) { this.timer.clear(this.usageHandle); this.usageHandle = undefined }
      await this.usagePass
      // Dot-owned MCP tokens leave the host credential store with the servers.
      const mcpRefs = dotOwnedCredentialRefs(Object.values(this.store.settings.mcpServers ?? {}))
      try {
        await this.store.factoryReset(this.now())
        sharedDotMcp().onSettingsChanged?.()
        for (const ref of mcpRefs) {
          try { await this.options.credentials?.unset?.(ref) } catch { /* best effort */ }
        }
      } catch (failure) {
        throw new DotError('dot/reset-incomplete', `Factory reset is incomplete: sessions were archived and artifact files were removed, but clearing Dorothy's records failed (${messageOf(failure)}). Request a new preview to retry the remaining cleanup.`)
      }
      this.pending.reset()
      this.diffPriors.clear()
      this.retryHealth.clearAll()
      this.quietWaits.clearAll(this.now())
      this.batcher.take()
      this.emittedClosures.clear()
      this.activeTurnOrigin = undefined
      await this.githubPollCursorStore.clear()
      this.releaseChildSeals()
      this.reminders.refresh()
      this.updates.settingsChanged()
      this.githubPoller.settingsChanged()
      this.homeRegistered = false
      this.ensuring = undefined
      this.requestedSegment = undefined
      if (activeLocale) await this.store.setUiLocale(activeLocale)
      let sessionId: string
      try {
        sessionId = await this.ensureDot()
      } catch (failure) {
        throw new DotError('dot/reset-incomplete', `Dorothy's data and settings were reset, but starting the new conversation failed (${messageOf(failure)}). Request a new preview to retry.`)
      }
      this.applyModel(sessionId)
      this.armIdleCheck()
      this.emit({
        event: DOT_TRACE.factoryReset,
        message: 'Restored Dorothy to factory settings.',
        sessionId,
        data: { archived: archived.length, archiveFailed: archiveFailed.length },
      })
      return { archived, archiveFailed, sessionId, at: this.now() }
    } finally {
      this.usageStopped = false
    }
  }

  /** Queue, agent idle, and owned jobs — the same facts finishSettled needs. Missing proof is UNKNOWN. */
  private async proveFactoryResetStopped(sessionId: string): Promise<FactoryResetStopEvidence> {
    if (typeof this.host.stopActivity === 'function') {
      try {
        const report = await this.host.stopActivity(sessionId)
        return { queueCleared: report.queueCleared, idle: report.idle, jobsSettled: report.jobsSettled }
      } catch (failure) {
        this.options.log?.(`dsh-dot: factory reset could not stop ${sessionId}: ${messageOf(failure)}`)
        return { queueCleared: false, idle: false, jobsSettled: 'unknown' }
      }
    }
    try { await this.host.stop(sessionId) } catch (failure) {
      this.options.log?.(`dsh-dot: factory reset could not stop ${sessionId}: ${messageOf(failure)}`)
    }
    return { queueCleared: false, idle: !this.host.isRunning(sessionId), jobsSettled: 'unknown' }
  }

  async inspectWorkspace(id?: string): Promise<string> {
    const home = await this.homeWorkspace().catch(error => { this.options.log?.(`dsh-dot: dot's own workspace is unavailable: ${messageOf(error)}`); return undefined })
    const rows = this.host.listWorkspaces()
    const key = id?.trim()
    const row = key ? rows.find(item => item.id === key) : home
    if (!row) throw new DotError('dot/unknown-workspace', key ? `no workspace ${key}` : 'no workspaces yet')
    const own = row.id === home?.id ? ' · your own workspace' : ''
    return [`Workspace ${row.id} "${row.title}"${own}`, `path: ${row.path}`, `sessions: ${row.sessionCount}`].join('\n')
  }

  async listWorkspaceFiles(id?: string, relPath?: string): Promise<string> {
    const home = await this.homeWorkspace().catch(error => { this.options.log?.(`dsh-dot: dot's own workspace is unavailable: ${messageOf(error)}`); return undefined })
    const rows = this.host.listWorkspaces()
    const key = id?.trim()
    const row = key ? rows.find(item => item.id === key) : home
    if (!row) throw new DotError('dot/unknown-workspace', key ? `no workspace ${key}` : 'no workspaces yet')
    try {
      const listed = await listWorkspaceTree(row.path, relPath?.trim() || '.')
      const truncated = listed.length >= WORKSPACE_LIST_MAX
      return [`Workspace ${row.id} "${row.title}" ${row.path}`, formatWorkspaceFiles(listed, truncated)].join('\n')
    } catch (error) {
      throw new DotError('dot/invalid', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Read-only file access for dot: relative paths stay inside the named (or her
   * own) workspace; absolute paths must land inside a registered workspace or a
   * change root. Refusals cover symlink escapes, directories, binaries, files
   * over 2 MiB, and credential-like paths.
   */
  async readWorkspaceFile(id: string | undefined, target: string | undefined, startLine?: number, maxLines?: number): Promise<string> {
    const home = await this.homeWorkspace().catch(error => { this.options.log?.(`dsh-dot: dot's own workspace is unavailable: ${messageOf(error)}`); return undefined })
    const rows = this.host.listWorkspaces()
    const trimmed = target?.trim() ?? ''
    if (!trimmed) throw new DotError('dot/invalid', 'read requires path')
    let baseDir: string | undefined
    if (!isAbsolute(trimmed)) {
      const key = id?.trim()
      const row = key ? rows.find(item => item.id === key) : home
      if (!row) throw new DotError('dot/unknown-workspace', key ? `no workspace ${key}` : 'no workspaces yet')
      baseDir = row.path
    }
    const roots = [
      ...rows.map(row => row.path),
      ...this.store.work.listChanges().map(change => change.cwd),
      ...this.store.work.listRuns().map(run => run.workspaceRoot),
    ].filter((root): root is string => typeof root === 'string' && root.length > 0)
    try {
      const read = await readWorkspaceText(roots, baseDir, trimmed, { startLine, maxLines })
      const width = String(read.totalLines).length
      const numbered = read.lines.map((line, index) => `${String(read.start + index).padStart(width)}│${line}`)
      const header = `${read.path} — ${read.totalLines} line${read.totalLines === 1 ? '' : 's'} total, showing ${read.lines.length === 0 ? 'none' : `${read.start}–${read.end}`}`
      const note = read.truncated ? [`… truncated: ${read.totalLines - read.end} more line${read.totalLines - read.end === 1 ? '' : 's'}; call again with start_line=${read.end + 1}`] : []
      return [header, ...numbered, ...note].join('\n')
    } catch (error) {
      throw new DotError('dot/invalid', error instanceof Error ? error.message : String(error))
    }
  }

  /** Mechanical panel action: no model message, approval, or queued switch. */
  newSegment(): Promise<string> {
    return this.serial(async () => {
      const from = await this.ensureDot()
      if (this.host.isRunning(from)) throw new DotError('dot/running', 'stop the current turn before starting a new segment')
      const next = await this.rollover(from, 'manual')
      if (next === from) throw new DotError('dot/rollover-failed', 'a fresh session could not be started; the current segment is still active')
      return next
    })
  }

  /** Tool proposals and human decisions share the delivery/rollover lane. */
  serialSettings<T>(work: () => Promise<T>): Promise<T> { return this.serial(work) }

  board(): BoardView {
    this.scheduleRunUsage()
    const view = this.store.board(this.pending.list())
    return view.work ? { ...view, work: view.work.map(item => this.withRetryStatus(item)) } : view
  }

  /** The background "needs you" projection the panel-less watcher polls. */
  attention(): AttentionView { return { items: attentionItems(this.store.cards, this.board()) } }

  /** Self-update bookkeeping for the settings panel. */
  updateStatus(): UpdateStatus | undefined { return this.store.updateStatus }
  checkUpdates(): Promise<UpdateStatus> { return this.updates.checkNow() }

  /** What the panel shows about this install: where dot runs from and the newest kept pre-upgrade backup. */
  selfStatus(): { readonly mode: 'linked' | 'installed' | 'unknown'; readonly root: string | null; readonly lastBackup?: SelfBackup } {
    const self = this.options.selfInstall
    return {
      mode: self?.mode ?? 'unknown',
      root: self?.root ?? null,
      ...(this.store.selfBackup !== undefined ? { lastBackup: this.store.selfBackup } : {}),
    }
  }

  /**
   * Let reminders come due. Called once dot's preset is registered: a reminder
   * that fires earlier could not reopen dot's session and would take it for lost.
   */
  startReminders(): void {
    if (this.closing) return
    this.reminders.start()
    this.updates.start()
    void this.resolveSelfUpgrade().catch(error => this.options.log?.(`dsh-dot: self-upgrade marker check failed: ${messageOf(error)}`))
    void this.reconcile().catch(error => this.options.log?.(`dsh-dot: reconciliation failed: ${messageOf(error)}`))
  }

  /**
   * A self-upgrade that built under the previous process left a marker; hashing
   * the bundle running now says whether the restart actually picked it up. The
   * marker clears either way — the backup row stays for the restore hint.
   * Only the marker captured at construction may be consumed: a later
   * deploySelfBuild on this still-running process must not look like a restart.
   */
  private async resolveSelfUpgrade(): Promise<void> {
    const marker = this.startupSelfUpgrade
    if (!marker || this.closing) return
    // A marker this instance just wrote is a different object; leave it for the next process.
    if (this.store.selfUpgrade !== marker) return
    const dot = this.store.dotSessionId
    // Clearing before the session exists would drop the only notice of this upgrade.
    if (!dot) return
    try {
      const hash = this.options.selfInstall ? libHashOf(this.options.selfInstall.root) : undefined
      const text = hash !== undefined && hash === marker.libHash
        ? `Self-upgrade to ${marker.commitSha} is running; the previous lib is kept at ${join(marker.backupDir, 'lib')}.`
        : `Self-upgrade to ${marker.commitSha} was deployed, but the running build does not match it${hash === undefined ? ' (the bundle could not be read)' : ''}; the previous lib is kept at ${join(marker.backupDir, 'lib')}.`
      this.notify({ sessionId: dot, kind: 'turn-end', text, at: this.now() })
    } finally {
      if (this.store.selfUpgrade === marker) {
        await this.store.setSelfUpgrade(undefined).catch(error => this.options.log?.(`dsh-dot: self-upgrade marker was not cleared: ${messageOf(error)}`))
      }
    }
  }

  private canIdleCheck(): boolean {
    const dot = this.store.dotSessionId
    // Only waking notices gate the patrol; held items ride its delivery.
    return !this.closing && this.store.settings.idleCheckMinutes > 0 && !!dot && !this.host.isRunning(dot) && !this.retryHealth.get(dot) && this.batcher.waking === 0
  }
  private armIdleCheck(): void {
    if (this.canIdleCheck()) {
      this.idleSince ??= this.now()
      this.idleChecker.arm(this.store.settings.idleCheckMinutes, Math.max(0, this.now() - this.idleSince))
    } else this.idleChecker.cancel()
  }

  /**
   * Provider caches die long before the 2h idle rollover, so a dot waiting on
   * running tasks pings its own session prefix to keep the cache warm. Every
   * finished turn re-arms from scratch; each tick re-checks the conditions.
   */
  private armKeepalive(dot: string, replied: boolean): void {
    this.cancelKeepalive()
    if (this.closing || !replied || this.host.isRunning(dot)) return
    if (!this.store.list().some(task => task.status === 'running')) return
    if (!this.host.sessionModel?.(dot)) return
    const armed: NonNullable<DotService['keepalive']> = { sessionId: dot, pings: 0, lastAt: this.now() }
    this.keepalive = armed
    this.scheduleKeepalive(armed)
  }

  private cancelKeepalive(): void {
    if (this.keepalive?.handle !== undefined) this.timer.clear(this.keepalive.handle)
    this.keepalive = undefined
  }

  /**
   * Arm the next ping from the TTL in force right now — a settings change can
   * move it without touching the stretch's ping count. A 0 TTL leaves the
   * record standing so turning it back on resumes the stretch.
   */
  private scheduleKeepalive(armed: NonNullable<DotService['keepalive']>): void {
    if (armed.handle !== undefined) this.timer.clear(armed.handle)
    armed.handle = undefined
    if (this.keepalive !== armed) return
    const model = this.host.sessionModel?.(armed.sessionId)
    const intervalMs = model ? keepaliveIntervalMs(cacheTtlMinutes(this.store.settings, model.provider, model.model)) : undefined
    if (intervalMs === undefined) return
    armed.handle = this.timer.set(() => { armed.handle = undefined; this.keepaliveTick(armed) }, Math.max(0, armed.lastAt + intervalMs - this.now()))
  }

  private keepaliveTick(armed: NonNullable<DotService['keepalive']>): void {
    if (this.keepalive !== armed) return
    void this.serial(async () => {
      if (this.keepalive !== armed) return
      const holds = this.store.dotSessionId === armed.sessionId && this.store.segment?.sessionId === armed.sessionId
        && !this.host.isRunning(armed.sessionId) && this.store.list().some(task => task.status === 'running')
      if (!holds) { this.cancelKeepalive(); return }
      const model = this.host.sessionModel?.(armed.sessionId)
      const intervalMs = model ? keepaliveIntervalMs(cacheTtlMinutes(this.store.settings, model.provider, model.model)) : undefined
      // A TTL turned off mid-stretch pauses the pings; the record survives.
      if (intervalMs === undefined) return
      if (armed.pings >= KEEPALIVE_MAX_PINGS) {
        this.cancelKeepalive()
        const view = await this.host.dotContext(armed.sessionId)
        // The cache is still warm: the handoff note rides it into the new segment.
        if (this.store.segment?.sessionId === armed.sessionId && !this.host.isRunning(armed.sessionId) && (view.usedTokens ?? 0) >= IDLE_MIN_TOKENS) {
          const next = await this.rollover(armed.sessionId, 'idle-expired')
          if (next !== armed.sessionId) {
            this.emit({ event: DOT_TRACE.keepaliveRollover, message: 'The warm idle segment was left for a fresh one.', sessionId: armed.sessionId })
          }
        }
        return
      }
      let usage: DotContextUsage | undefined
      await this.host.ping(armed.sessionId, seen => { usage = addUsage(usage, seen) })
      if (usage) await this.store.addUsageCarry(usage)
      armed.lastAt = this.now()
      this.lastKeepaliveAt = { sessionId: armed.sessionId, at: armed.lastAt }
      armed.pings += 1
      this.emit({ event: DOT_TRACE.keepalivePing, message: 'Kept the prompt cache warm.', sessionId: armed.sessionId, data: { pings: armed.pings } })
      this.scheduleKeepalive(armed)
    }).catch(error => {
      this.options.log?.(`dsh-dot: cache keepalive failed: ${messageOf(error)}`)
      this.emit({ event: DOT_TRACE.keepaliveFailed, level: 'warn', message: 'A cache keepalive ping failed.', sessionId: armed.sessionId })
      if (this.keepalive === armed) this.cancelKeepalive()
    })
  }
  reconcile(): Promise<void> { return this.track(() => this.reconcileNow()) }

  private async reconcileNow(): Promise<void> {
    // A restart otherwise keeps showing watches the human already archived.
    await this.syncWatched().catch(error => this.options.log?.(`dsh-dot: watched sessions were not reconciled: ${messageOf(error)}`))
    // Pending requests do not survive a restart, so a keep-alive approval card
    // left behind by one can never be answered again; expire it up front.
    const live = new Set(this.pending.list().map(row => row.id))
    for (const card of this.store.cards) {
      if (card.keepAlive !== true || card.answer || card.expired) continue
      if (card.approvalId !== undefined && live.has(card.approvalId)) continue
      await this.store.expireCard(card.id).catch(error => this.options.log?.(`dsh-dot: stale approval card expiry was not saved: ${messageOf(error)}`))
    }
    for (const run of this.store.work.occupying()) {
      if (this.closing) return
      await reconcileRun(this.store.work, this.runHost(), run.id, this.now()).catch(error => {
        this.options.log?.(`dsh-dot: run ${run.id} was not reconciled: ${messageOf(error)}`)
      })
      const current = this.store.work.run(run.id)
      if (current?.creation === 'confirmed' && current.sessionId && current.sessionId === current.requestedSessionId && !this.store.tracks(current.sessionId)) {
        await this.rememberRun(current.id)
      }
    }
    this.backfillManagedRetryHealth()
    if (this.canIdleCheck()) this.idleChecker.run()
    this.recoverDecisionWakes()
    this.recoverInbox()
    this.armIdleCheck()
    // Runs that terminalized before this start still have their sessions'
    // events around, so one capture pass backfills their cost up front.
    await this.captureRunUsage()
  }
  /** The human removed a reminder in the board. */
  removeSchedule(id: string): Promise<boolean> { return this.track(() => this.reminders.remove(id)) }

  // ---- run usage: cost recorded after a run settles ---------------------

  private usageHandle: unknown
  private usagePass: Promise<void> | undefined
  private usageWanted = false
  private usageSeenRevision = -1
  /** Runs that failed to read during the current drain; cleared when it ends. */
  private readonly usageFailed = new Set<string>()
  /** Set while a factory reset wipes the book: no pass may start or commit. */
  private usageStopped = false

  /**
   * Debounced capture re-armed whenever the work revision moved since the last
   * board read. Usage is metadata and does not move the revision, so no extra
   * pass is scheduled by a capture itself.
   */
  private scheduleRunUsage(): void {
    if (this.closing || this.usageStopped || this.usageSeenRevision === this.store.work.revision) return
    this.usageSeenRevision = this.store.work.revision
    if (this.usageHandle !== undefined) this.timer.clear(this.usageHandle)
    this.usageHandle = this.timer.set(() => {
      this.usageHandle = undefined
      void this.captureRunUsage()
    }, 2000)
  }

  /** At most one pass at a time; another request during it queues one follow-up. */
  private captureRunUsage(): Promise<void> {
    if (this.usageStopped || this.closing) return Promise.resolve()
    if (this.usagePass) {
      this.usageWanted = true
      return this.usagePass
    }
    this.usageWanted = false
    const pass = this.captureRunUsageNow()
      .catch(error => this.options.log?.(`dsh-dot: run usage capture failed: ${messageOf(error)}`))
      .finally(() => {
        this.usagePass = undefined
        if (this.usageWanted && !this.closing) void this.captureRunUsage()
      })
    this.usagePass = pass
    return pass
  }

  /**
   * Backfill bounded per pass: terminal runs whose session still exists and
   * whose usage was never committed. A read or write failure skips the run so
   * the next pass retries it.
   */
  private async captureRunUsageNow(): Promise<void> {
    const candidates = this.store.work.listRuns()
      .filter(run => runIsTerminal(run) && run.sessionId !== undefined && run.usage === undefined && !this.usageFailed.has(run.id))
      .slice(0, 20)
    let recorded = 0
    for (const run of candidates) {
      if (this.closing || this.usageStopped) return
      if (await this.captureRunUsageFor(run.id)) recorded += 1
      else this.usageFailed.add(run.id)
    }
    // Usage does not move the work revision, so the panel needs the store's
    // change signal (the same one other writes use) to fetch the new numbers.
    if (recorded > 0) this.store.workChanged()
    // A full batch means the backlog continues: chain a follow-up pass through
    // the shared usageWanted slot. Runs that already failed in this drain are
    // skipped so one unreadable session cannot loop the chain; a non-full
    // pass ends the drain and they become eligible again on the next trigger.
    if (candidates.length === 20) this.usageWanted = true
    else this.usageFailed.clear()
  }

  /** Read one terminal run's session events and persist its cost. Returns true when usage is now recorded. */
  private async captureRunUsageFor(runId: string): Promise<boolean> {
    const run = this.store.work.run(runId)
    const sessionId = run?.sessionId
    if (!run || !runIsTerminal(run) || run.usage !== undefined || sessionId === undefined) return run?.usage !== undefined
    try {
      const events = await this.host.readEvents(sessionId)
      let firstAt: number | undefined
      let lastAt: number | undefined
      for (const event of events) {
        if (typeof event.time !== 'number') continue
        firstAt ??= event.time
        lastAt = event.time
      }
      const wallMs = Math.max(0, firstAt !== undefined && lastAt !== undefined ? lastAt - firstAt : run.updatedAt - run.createdAt)
      const recorded = await this.store.work.recordRunUsage(run.id, usageFromEvents(events) ?? ZERO_USAGE, wallMs)
      return !('code' in recorded)
    } catch (error) {
      this.options.log?.(`dsh-dot: usage for run ${run.id} was not captured: ${messageOf(error)}`)
      return false
    }
  }

  // ---- tool operations -------------------------------------------------

  overview(signal: AbortSignal, limit = 30): Promise<string> { return this.track(() => this.overviewNow(signal, limit)) }

  private async overviewNow(signal: AbortSignal, limit: number): Promise<string> {
    const watchedAt = this.watchCandidates()
    const listed = await this.host.listSessions(signal)
    await this.retireWatched(listed, watchedAt)
    const rows = listed
      .filter(row => !row.subagent && !row.blank && !this.isDot(row.sessionId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const shown = rows.filter(row => !row.archived).slice(0, limit)
    const titles = await this.host.titles(shown.map(row => row.sessionId), signal).catch(() => new Map<string, string>())
    const lines = [ledgerSummary(this.store.list(), this.pending.list(), this.now(), this.store.workLedger()), '', '[all sessions, newest first]']
    for (const row of shown) {
      const tracked = this.store.tracks(row.sessionId) ? ' · tracked' : ''
      lines.push(`- ${row.sessionId} ${row.running ? 'RUNNING' : 'idle'} "${titles.get(row.sessionId) ?? '(untitled)'}" cwd=${row.cwd ?? '?'}${tracked}`)
    }
    const hidden = rows.length - shown.length
    if (hidden > 0) lines.push(`(${hidden} more archived or older session(s) not shown)`)
    this.assertOpen()
    await this.store.markAllSeen()
    return lines.join('\n')
  }

  /**
   * dot's own workspace: the directory its sessions live in, registered with
   * the host so the human sees it in the sidebar and work that belongs to no
   * project has a place. The host reuses the record of a directory it already
   * knows, so this is asked again on every use and survives a removed record.
   */
  async homeWorkspace(): Promise<WorkspaceRow> {
    await mkdir(this.options.homeDir, { recursive: true })
    return this.host.createWorkspace(this.options.homeDir, HOME_TITLE)
  }

  async listWorkspaces(): Promise<string> {
    const home = await this.homeWorkspace().catch(error => { this.options.log?.(`dsh-dot: dot's own workspace is unavailable: ${messageOf(error)}`); return undefined })
    const rows = this.host.listWorkspaces()
    if (rows.length === 0) return 'No workspaces yet. Create one with dot_workspace (action=create).'
    return rows.map(row => `- ${row.id} "${row.title}" ${row.path} (${row.sessionCount} session(s))${row.id === home?.id ? ' · your own workspace' : ''}`).join('\n')
  }

  /** The models a task may run on, for dot to choose from. */
  async listModels(query: TaskModelQuery = {}): Promise<string> {
    try {
      return formatTaskModels(this.store.settings.taskModels, await this.catalog(), query)
    } catch (error) {
      if (error instanceof ArenaQueryError) throw new DotError('dot/invalid-model-query', error.message)
      throw error
    }
  }

  private async catalog(): Promise<TaskModelCatalog> {
    try { return await this.host.listModels() } catch (error) {
      throw new DotError('dot/models-unavailable', `the host's model list could not be read: ${messageOf(error)}`)
    }
  }

  /** The model to select for a new task; undefined keeps the host default. The human's list is checked in code, not left to dot. */
  private async taskModel(requested?: string): Promise<ModelChoice | undefined> {
    const rule = this.store.settings.taskModels
    if (!requested?.trim() && rule.mode === 'all') return undefined
    try { return pickTaskModel(rule, await this.catalog(), requested) } catch (error) {
      if (error instanceof TaskModelError) throw new DotError(error.code, error.message)
      throw error
    }
  }

  /**
   * The preset a new task runs on. Leaving it out keeps the host default even
   * when the roster cannot be read; a named preset has to be on the roster.
   */
  private async taskPreset(requested?: string): Promise<TaskPresetChoice> {
    let catalog: TaskPresetCatalog
    try { catalog = await this.host.listPresets() } catch (error) {
      throw new DotError('dot/presets-unavailable', `the host's preset list could not be read: ${messageOf(error)}. Cannot safely select a task preset.`)
    }
    try { return pickTaskPreset(catalog, requested, this.store.settings.defaultTaskPreset) } catch (error) {
      if (error instanceof TaskPresetError) throw new DotError(error.code, error.message)
      throw error
    }
  }

  createWorkspace(path: string, title?: string): Promise<string> { return this.track(() => this.createWorkspaceNow(path, title)) }

  private async createWorkspaceNow(path: string, title?: string): Promise<string> {
    if (!path.trim()) throw new DotError('dot/invalid', 'path must be a non-empty absolute directory')
    await mkdir(path, { recursive: true })
    const row = await this.host.createWorkspace(path, title?.trim() || undefined)
    return `Workspace ${row.id} "${row.title}" at ${row.path}`
  }

  manageTask(args: Record<string, unknown>): Promise<string> {
    const action = typeof args.action === 'string' ? args.action : ''
    const awaitsHost = ['create', 'finish', 'cancel', 'supplement', 'dispatch', 'check', 'closeout', 'reject'].includes(action)
    const origin = this.activeTurnOrigin ?? DEFAULT_RUN_ORIGIN
    const work = awaitsHost
      ? this.manageWorkAction(args, { origin })
      : this.serial(() => this.manageWorkAction(args, { origin }))
    // Settling runs earn their token/wall cost whether or not the panel is open.
    return work.finally(() => this.scheduleRunUsage())
  }

  private async manageWorkAction(args: Record<string, unknown>, internal?: { readonly origin?: RunOrigin }): Promise<string> {
    const action = typeof args.action === 'string' ? args.action : ''
    const changeId = typeof args.task_id === 'string' ? args.task_id : ''
    if (action === 'list') {
      const rows = this.store.work.listChanges()
      return rows.length ? rows.map(change => {
        const view = this.store.work.workView(change.id)
        return `${change.id} ${(view?.status ?? 'waiting').toUpperCase()} P${change.priority} ${change.cwd} "${change.title}"`
      }).join('\n') : 'No tasks.'
    }
    if (action === 'dispatch' || action === 'check') {
      // Resolve task_id or run_id before applying pinned defaults so a continued
      // reservation and a preflight see the same recipe access, preset and model.
      const role = typeof args.role === 'string' ? args.role as RunKind : undefined
      const requestedRunId = typeof args.run_id === 'string' ? args.run_id : ''
      const namedRun = requestedRunId ? this.store.work.run(requestedRunId) : undefined
      const dispatchChange = changeId
        ? this.store.work.change(changeId)
        : namedRun ? this.store.work.change(namedRun.changeId) : undefined
      const pinnedRecipe = dispatchChange ? this.taggedRecipe(dispatchChange) : undefined
      const pinnedBody = pinnedRecipe && dispatchChange?.recipe ? recipeBodyAt(pinnedRecipe, dispatchChange.recipe.revision) : undefined
      const message = typeof args.instruction === 'string' ? args.instruction : typeof args.message === 'string' ? args.message : ''
      const instruction = pinnedBody?.notes ? `Recipe notes:\n${pinnedBody.notes}${message ? `\n\n${message}` : ''}` : message
      return this.startWorkSession({
        title: typeof args.title === 'string' ? args.title : 'task',
        instruction,
        startFromWorkOrder: pinnedBody !== undefined,
        ...(changeId ? { taskId: changeId } : {}),
        ...(typeof args.dir === 'string' ? { cwd: args.dir } : {}),
        ...(typeof args.workspace_id === 'string' ? { workspaceId: args.workspace_id } : {}),
        ...(typeof args.goal === 'string' ? { goal: args.goal } : {}),
        ...(typeof args.priority === 'number' && (args.priority === 1 || args.priority === 2 || args.priority === 3) ? { priority: args.priority } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(typeof args.access === 'string' ? { access: args.access as RunAccess } : role !== 'review' && pinnedBody?.access !== undefined ? { access: pinnedBody.access } : {}),
        ...(typeof args.paths === 'string' ? { paths: args.paths } : Array.isArray(args.paths) ? { paths: JSON.stringify(args.paths) } : {}),
        ...(requestedRunId ? { runId: requestedRunId } : {}),
        ...(typeof args.model === 'string' ? { model: args.model } : pinnedBody?.model !== undefined ? { model: pinnedBody.model } : {}),
        ...(typeof args.preset === 'string' ? { preset: args.preset } : pinnedBody?.preset !== undefined ? { preset: pinnedBody.preset } : {}),
        ...(jsonArray(args.step_refs) ? { stepRefs: jsonArray(args.step_refs)!.map(String) } : {}),
        ...(internal?.origin ? { origin: internal.origin } : {}),
        checkOnly: action === 'check',
      })
    }
    if (action === 'create' || action === 'revise') return this.reviseOrCreate(args)
    if (action === 'supplement') return this.supplementFromTool(args)
    if (action === 'pause' || action === 'resume' || action === 'cancel') return this.controlFromTool(args)
    if (!changeId && action !== 'step') throw new DotError('dot/invalid', 'task_id is required')
    if (action === 'step') return this.stepFromTool(args)
    if (!changeId) throw new DotError('dot/invalid', 'task_id is required')
    if (action === 'closeout') return this.closeoutFromTool(args)
    if (action === 'read') return this.readWork(changeId, typeof args.input_ref === 'string' ? args.input_ref : undefined)
    if (action === 'link' || action === 'unlink') return this.linkFromTool(args, action === 'unlink')
    if (action === 'reject') {
      const reviewRunId = typeof args.review_run_id === 'string' ? args.review_run_id : ''
      const expectedInputRevision = typeof args.expected_input_revision === 'number' ? args.expected_input_revision : this.soleInputRevision(changeId)
      if (expectedInputRevision === undefined) throw new DotError('dot/invalid', 'reject requires expected_input_revision')
      const released = await this.rejectWork(changeId, reviewRunId, expectedInputRevision)
      if (!released.ok) throw new DotError('dot/invalid', released.message)
      return `rejected ${changeId}; review ${released.run.id} released`
    }
    if (action === 'finish') return this.finishFromTool(args)
    if (action === 'decide') return this.decideFromTool(args)
    throw new DotError('dot/invalid', `unknown task action ${action}`)
  }


  /** Agent-attributed delivery: the target sees dot as the sender, not the human. */
  send(sessionId: string, text: string): Promise<string> {
    return this.serial(() => {
      const recovery = this.store.work.recoveryError
      const task = this.store.task(sessionId)
      const run = this.store.work.sessionRun(sessionId)
      if (recovery || task?.origin === 'started' || run) {
        throw new DotError('dot/send-closed', recovery
          ? `dot_send is closed until work records recover: ${recovery}`
          : 'dot_send cannot continue a run session. Record a delivery on the run; nothing was relayed.')
      }
      return this.sendNow(sessionId, text)
    })
  }

  private async sendNow(sessionId: string, text: string): Promise<string> {
    this.assertTarget(sessionId)
    if (!text.trim()) throw new DotError('dot/invalid', 'message must be non-empty')
    this.abortQuietWait(sessionId, 'send', true)
    const delivered = text.trim()
    try {
      await this.host.relay(sessionId, this.store.dotSessionId ?? sessionId, delivered)
    } catch (error) {
      const code = error instanceof DotError ? error.code : 'dot/send-failed'
      this.emit({ event: DOT_TRACE.sessionSendRefused, level: 'warn', message: `Follow-up to ${sessionId} was not delivered.`, sessionId, data: { code } })
      throw error
    }
    this.emit({ event: DOT_TRACE.sessionSent, message: `Delivered a follow-up to ${sessionId}.`, sessionId })
    const lead = `Delivered to ${sessionId}.`
    return `${lead} ${ACCEPTED_DELIVERY_HINT}`
  }

  interrupt(sessionId: string): Promise<string> { return this.serial(() => this.interruptNow(sessionId)) }

  private async interruptNow(sessionId: string): Promise<string> {
    this.assertTarget(sessionId)
    this.abortQuietWait(sessionId, 'interrupt', true)
    await this.host.cancel(sessionId)
    return `Stopped the current turn of ${sessionId}; queued messages stay.`
  }

  /**
   * dot archives only the sessions it started itself. A session the human
   * opened stays the human's to archive, also when dot watches it.
   */
  archive(sessionId: string): Promise<string> { return this.serial(() => this.archiveNow(sessionId)) }

  private async archiveNow(sessionId: string): Promise<string> {
    this.assertTarget(sessionId)
    if (this.store.task(sessionId)?.origin !== 'started') {
      throw new DotError('dot/not-yours', `you did not start ${sessionId}, so you cannot archive it. Only the human archives sessions they opened; tell them so when they asked for it`)
    }
    const run = this.store.work.sessionRun(sessionId)
    if (run && run.phase !== 'completed' && run.phase !== 'failed' && run.phase !== 'stopped') {
      throw new DotError('dot/invalid', `${run.id} is ${run.phase}; archive it after it stops`)
    }
    await this.host.archive(sessionId)
    for (const view of this.pending.forSession(sessionId)) this.pending.answer(view.id, view.kind === 'approval' ? { kind: 'approval', allow: false } : { kind: 'question', answers: (view.questions ?? []).map(q => ({ id: q.id, selected: [] })) })
    await this.store.apply({ type: 'archived', sessionId, at: this.now() }, this.pending.list())
    return `Archived ${sessionId}.`
  }

  watch(sessionId: string, goal: string, title?: string): Promise<string> { return this.serial(() => this.watchNow(sessionId, goal, title)) }

  private async watchNow(sessionId: string, goal: string, title?: string): Promise<string> {
    this.assertTarget(sessionId)
    const cwd = (await this.host.cwdOf(sessionId)) ?? ''
    const task = await this.store.track({ sessionId, origin: 'watched', title: title ?? sessionId, goal, cwd, at: this.now() })
    return `Watching ${task.sessionId}.`
  }

  /**
   * The human dismissed a watch from the board. The host session stays as it is:
   * this does not archive it, and a session dot started is not a watch.
   */
  unwatch(sessionId: string): Promise<boolean> { return this.serial(() => this.unwatchNow(sessionId)) }

  private async unwatchNow(sessionId: string): Promise<boolean> {
    if (this.closing) return false
    const removed = await this.store.untrack(sessionId)
    if (removed) this.dropWatchNotices(sessionId)
    return removed
  }

  /** The host archived this session. A watched row stops looking idle; the host session is not archived again. */
  noteSessionArchived(sessionId: string): Promise<void> {
    this.retryHealth.remove(sessionId)
    this.quietWaits.remove(sessionId, this.now())
    this.armIdleCheck()
    return this.retireWatch(sessionId)
  }

  /**
   * The host dropped a session from its live registry. Confirm against the
   * current list so an unload that leaves the session visible does not retire it.
   */
  noteSessionRemoved(sessionId: string): Promise<void> {
    this.retryHealth.remove(sessionId)
    this.quietWaits.remove(sessionId, this.now())
    this.armIdleCheck()
    const task = this.store.task(sessionId)
    if (!task || task.origin !== 'watched' || task.status === 'archived') return Promise.resolve()
    return this.syncWatched()
  }

  /**
   * Mark watched sessions the host has archived or no longer lists. A failed
   * list leaves every watch as it was. Sessions dot started are not touched.
   */
  async syncWatched(signal?: AbortSignal): Promise<void> {
    if (!this.watchedSync) {
      const run = this.syncWatchedNow().finally(() => {
        if (this.watchedSync === run) this.watchedSync = undefined
      })
      this.watchedSync = run
    }
    const shared = this.watchedSync
    if (!signal) return shared
    if (signal.aborted) return
    return new Promise((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', finish); resolve() }
      signal.addEventListener('abort', finish)
      shared.then(finish, error => { signal.removeEventListener('abort', finish); reject(error) })
    })
  }

  private async syncWatchedNow(): Promise<void> {
    if (this.closing) return
    const watchedAt = this.watchCandidates()
    if (watchedAt.size === 0) return
    let rows: Awaited<ReturnType<DotHost['listSessions']>>
    try {
      rows = await this.host.listSessions(AbortSignal.timeout(15_000))
    } catch {
      return
    }
    await this.retireWatched(rows, watchedAt)
  }

  /** Watched rows still idle when a host list starts, keyed by updatedAt. */
  private watchCandidates(): Map<string, number> {
    return new Map(
      this.store.list()
        .filter(task => task.origin === 'watched' && task.status !== 'archived')
        .map(task => [task.sessionId, task.updatedAt]),
    )
  }

  private async retireWatched(rows: readonly { readonly sessionId: string; readonly archived: boolean }[], watchedAt: ReadonlyMap<string, number>): Promise<void> {
    if (this.closing) return
    const byId = new Map(rows.map(row => [row.sessionId, row]))
    for (const task of this.store.list()) {
      if (task.origin !== 'watched' || task.status === 'archived') continue
      // A watch created or rewritten while the list was in flight keeps its new state.
      if (watchedAt.get(task.sessionId) !== task.updatedAt) continue
      const row = byId.get(task.sessionId)
      if (row && !row.archived) continue
      await this.retireWatch(task.sessionId)
    }
  }

  private retireWatch(sessionId: string): Promise<void> {
    if (this.closing) return Promise.resolve()
    const task = this.store.task(sessionId)
    if (!task || task.origin !== 'watched' || task.status === 'archived') return Promise.resolve()
    this.dropWatchNotices(sessionId)
    return this.store.apply({ type: 'archived', sessionId, at: this.now() }, this.pending.list()).then(() => undefined)
  }

  /** Queued turn-end and error notes for a watch that is no longer active. Approvals stay until they settle. */
  private dropWatchNotices(sessionId: string): void {
    this.batcher.dropWhere(item => item.sessionId === sessionId && item.requestId === undefined)
  }

  /** A ledger row that still receives turn, error, and tracked-scope relay events. */
  private liveTask(sessionId: string) {
    const task = this.store.task(sessionId)
    return task && task.status !== 'archived' ? task : undefined
  }

  read(sessionId: string, maxChars = 4000): Promise<string> { return this.track(() => this.readNow(sessionId, maxChars)) }

  private async readNow(sessionId: string, maxChars: number): Promise<string> {
    const reply = await this.host.latestReply(sessionId, Math.max(200, Math.min(maxChars, 20_000)))
    this.assertOpen()
    const watched = this.store.task(sessionId)
    if (watched?.origin === 'watched' && watched.status !== 'archived') {
      await this.syncWatched()
      this.assertOpen()
    }
    const task = this.store.task(sessionId)
    if (task) await this.store.markSeen(sessionId)
    const head = task ? `${task.status.toUpperCase()} "${task.title}" goal: ${task.goal}` : 'untracked session'
    // A run that settled earns its cost on its own line; capture it first when
    // no pass has reached it yet.
    let run = this.store.work.sessionRun(sessionId)
    if (run && runIsTerminal(run) && run.usage === undefined) {
      await this.captureRunUsageFor(run.id)
      run = this.store.work.run(run.id)
    }
    const cost = run?.usage
      ? `\nrun ${run.id} cost: ${formatTokens(totalUsage(run.usage))} tok${run.wallMs !== undefined ? ` · ${formatDuration(run.wallMs)}` : ''}`
      : ''
    return `${head}${cost}\n--- latest reply ---\n${reply ?? '(no reply yet)'}`
  }

  answer(id: string, answer: PendingAnswer): string {
    const view = this.pending.get(id)
    if (!view) {
      const settled = this.pending.settlement(id)
      if (settled) return `Already settled: ${id} for ${settled.sessionId} (${settled.reason}); no answer was applied. Stay silent unless another update needs the human.`
      throw new DotError('dot/unknown-request', `no known request ${id}; check the request id`)
    }
    // A model-generated tool call is not evidence of a human decision.
    if (view.kind === 'approval' && answer.kind === 'approval' && (view.humanRequired === true || this.rules.approvals === 'human')) throw new DotError('dot/human-required', `approval ${id} requires a direct human decision`)
    if (view.kind === 'approval' && answer.kind === 'approval' && answer.allow === true && view.truncated === true && !this.readApprovals.has(id)) {
      if (!this.store.approvalDetails.some(row => row.requestId === id)) {
        throw new DotError('dot/human-required', `approval ${id} was truncated and its full arguments are unavailable; relay it to the human for a direct decision`)
      }
      throw new DotError('dot/read-required', `approval ${id} was truncated; read it with ${TOOL.answerPending} action=read before allowing`)
    }
    if (view.kind === 'question' && this.rules.questions === 'human') throw new DotError('dot/human-required', `question ${id} requires a direct human answer in the original session`)
    // The human may switch to deny while dot is still judging a delivered request.
    const denied = view.kind === 'approval' && answer.kind === 'approval' && this.rules.approvals === 'deny'
    if (!this.pending.answer(id, denied ? { kind: 'approval', allow: false } : answer)) throw new DotError('dot/invalid-answer', answer.kind === 'question' ? 'answer every question id exactly once' : `request ${id} is a ${view.kind}`)
    this.emit({ event: DOT_TRACE.approvalSettled, message: `Settled ${view.kind} ${id}.`, sessionId: view.sessionId, data: { requestId: id, kind: view.kind } })
    return denied ? `Rejected ${id} for ${view.sessionId}: approvals=deny; no grant was applied.` : `Answered ${id} for ${view.sessionId}.`
  }

  /** A validated card answer settles only its bound, still-open approval. */
  private answerHumanApproval(id: string, allow: boolean): string {
    const view = this.pending.get(id)
    if (!view || view.kind !== 'approval') throw new DotError('dot/unknown-request', `approval ${id} is no longer pending`)
    if (allow && this.rules.approvals === 'deny') throw new DotError('dot/invalid', 'approvals=deny; no grant was applied')
    if (!this.pending.answer(id, { kind: 'approval', allow })) throw new DotError('dot/unknown-request', `approval ${id} is no longer pending`)
    return `Answered ${id} for ${view.sessionId}.`
  }

  private pruneApprovalDetails(): Promise<void> {
    const open = this.openApprovalIds()
    for (const id of [...this.readApprovals]) if (!open.has(id)) this.readApprovals.delete(id)
    const kept = this.store.approvalDetails.filter(row => open.has(row.requestId))
    return this.store.replaceApprovalDetails(kept)
  }

  scheduleAdd(input: ScheduleInput): Promise<string> { return this.track(() => this.scheduleAddNow(input)) }

  private async scheduleAddNow(input: ScheduleInput): Promise<string> {
    try {
      let recipeId: string | undefined
      if (input.recipe?.trim()) {
        const recipe = this.store.recipe(input.recipe.trim())
        if (!recipe) throw new ScheduleInputError(`unknown recipe ${input.recipe}; saved recipes: ${this.store.recipes.map(row => `${row.id} "${row.name}"`).join(', ') || 'none'}`)
        recipeId = recipe.id
      }
      const record = await this.reminders.add({ ...input, ...(recipeId ? { recipe: recipeId } : {}) })
      return `Reminder ${record.id} "${record.title}" set (${describeTiming(record.timing)}); it first comes due ${stamp(record.nextAt)}.`
    } catch (error) {
      if (error instanceof ScheduleInputError) throw new DotError('dot/invalid', error.message)
      throw error
    }
  }

  scheduleList(): string { return scheduleLines(this.store.schedules, id => this.store.recipe(id)?.name) }

  scheduleRemove(id: string): Promise<string> { return this.track(() => this.scheduleRemoveNow(id)) }

  private async scheduleRemoveNow(id: string): Promise<string> {
    const key = id.trim()
    if (!(await this.reminders.remove(key))) throw new DotError('dot/unknown-reminder', `no reminder ${key || '(empty id)'}; ${TOOL.schedule} (action=list) shows the ones that are set`)
    return `Removed reminder ${key}.`
  }

  /** Recipe ids whose change was created but whose dispatch has not finished; a second call refuses instead of stacking. */
  private readonly recipeStarting = new Set<string>()

  /**
   * Create + dispatch a recipe-tagged change through the same paths as
   * `dot_task action=create recipe=` followed by `action=dispatch`: identical
   * validation, scope reservation, baseline capture and outcome tagging.
   * Never stacks runs of one recipe: a non-terminal change refuses the call.
   * Only the in-flight check and the create hold the serial lane; dispatch
   * awaits the host outside it, exactly like manageTask's dispatch branch.
   */
  async runRecipe(ref: string, opts: { readonly origin: 'reminder' | 'human'; readonly note?: string; readonly reminderTitle?: string }): Promise<{ readonly ok: true; readonly changeId: string; readonly runId?: string } | { readonly ok: false; readonly reason: string }> {
    const recipe = this.store.recipe(ref)
    if (!recipe) return { ok: false as const, reason: `unknown recipe ${ref}` }
    const userRequest = opts.origin === 'reminder'
      ? `[reminder "${opts.reminderTitle ?? ''}"]${opts.note?.trim() ? ` ${opts.note.trim()}` : ''}`
      : `Run recipe "${recipe.name}" (started from the Tasks panel)`
    const started = await this.serial(async (): Promise<{ readonly ok: true; readonly change: ChangeRecord } | { readonly ok: false; readonly reason: string }> => {
      if (this.recipeStarting.has(recipe.id)) return { ok: false as const, reason: `a run of ${recipe.id} "${recipe.name}" is already starting` }
      const allRuns = this.store.work.listRuns()
      const inFlight = this.store.work.listChanges().find(change =>
        change.recipe?.id === recipe.id && !changeIsTerminal(change, allRuns.filter(run => run.changeId === change.id)))
      if (inFlight) return { ok: false as const, reason: `previous run of ${recipe.id} "${recipe.name}" still in flight: ${inFlight.id}` }
      this.recipeStarting.add(recipe.id)
      try {
        return { ok: true as const, change: (await this.createChangeFromTool({ action: 'create', recipe: recipe.id, user_request: userRequest })).change }
      } catch (error) {
        this.recipeStarting.delete(recipe.id)
        return { ok: false as const, reason: messageOf(error) }
      }
    })
    if (!started.ok) return started
    const change = started.change
    const cancelFresh = async (reason: string): Promise<{ readonly ok: false; readonly reason: string }> => {
      const cancelled = await this.cancelWorkChange(change.id).catch(() => undefined)
      const cancelledNote = cancelled && 'ok' in cancelled && cancelled.ok
        ? `fresh change ${change.id} was cancelled`
        : `fresh change ${change.id} could not be cancelled`
      return { ok: false as const, reason: `${cancelledNote} — ${reason}` }
    }
    const runOrigin: RunOrigin = opts.origin === 'reminder'
      ? { strength: 'explicit', source: 'schedule' }
      : DEFAULT_RUN_ORIGIN
    let dispatchText = ''
    try {
      dispatchText = await this.manageWorkAction(
        { action: 'dispatch', task_id: change.id, ...(opts.note?.trim() ? { message: opts.note.trim() } : {}) },
        { origin: runOrigin },
      )
    } catch (error) {
      return cancelFresh(messageOf(error))
    } finally {
      this.recipeStarting.delete(recipe.id)
    }
    // The dispatch branch reports a refused launch (e.g. the host denied the
    // run's permission) as a "reserved …; not started: …" text, not a throw:
    // no run past `reserved` means the dispatch is a refusal, not a success.
    const run = this.store.work.listRuns().filter(row => row.changeId === change.id).at(-1)
    if (!run || run.phase === 'reserved') {
      return cancelFresh(dispatchText || `no run of ${change.id} was launched`)
    }
    return { ok: true as const, changeId: change.id, runId: run.id }
  }

  /** A recipe-bound reminder fires here: direct dispatch plus a non-waking notice. */
  private async recipeReminderRun(record: import('./contracts.ts').ScheduleRecord): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }> {
    if (!record.recipe) return { ok: false as const, reason: 'no recipe bound' }
    const result = await this.runRecipe(record.recipe, { origin: 'reminder', note: record.prompt, reminderTitle: record.title })
    if (!result.ok) return { ok: false as const, reason: result.reason }
    const run = result.runId ? this.store.work.run(result.runId) : undefined
    const sessionId = run?.sessionId ?? run?.requestedSessionId ?? ''
    const text = `Reminder "${record.title}" started recipe task ${result.changeId}${result.runId ? ` (run ${result.runId})` : ''}`
    this.batcher.hold({
      sessionId, kind: 'recipe-run', text, at: this.now(), changeId: result.changeId,
      display: { kind: 'recipe-run', sessionId, summary: text },
    })
    return { ok: true as const, text }
  }

  /** Recipes as the Tasks panel's Recipes filter renders them. */
  recipeBoard(): readonly import('./contracts.ts').RecipeBoardRow[] {
    return this.store.recipes.map(recipe => {
      const live = this.liveRecipeChanges(recipe.id)
      return {
        id: recipe.id, name: recipe.name, revision: recipe.revision, updatedAt: recipe.updatedAt,
        stats: recipeRevisionStats(recipe, live),
        inFlight: live.filter(row => !row.terminal).map(row => ({
          changeId: row.changeId, title: row.title,
          status: this.store.work.workView(row.changeId)?.status ?? 'waiting',
        })),
        reminders: this.store.schedules
          .filter(row => row.recipe === recipe.id && !onceDelivered(row))
          .map(row => ({ id: row.id, title: row.title, nextAt: row.nextAt })),
        ...(this.recipeProposalView(recipe) ? { proposal: this.recipeProposalView(recipe) } : {}),
      }
    })
  }

  /** The pending proposal as the Recipes view renders it, with the base body for the revise diff. */
  private recipeProposalView(recipe: RecipeRecord): RecipeProposalView | undefined {
    const proposal = this.store.pendingRecipeProposal(recipe.id)
    if (!proposal) return undefined
    const version = recipeVersionAt(recipe, proposal.baseRevision) ?? recipe
    return {
      id: proposal.id, kind: proposal.kind, origin: proposal.origin,
      baseRevision: proposal.baseRevision,
      ...(proposal.targetRevision !== undefined ? { targetRevision: proposal.targetRevision } : {}),
      ...(proposal.patch ? { patch: proposal.patch } : {}),
      base: {
        goal: version.goal,
        ...(version.notes !== undefined ? { notes: version.notes } : {}),
        requirementsFromGoal: requirementsFollowGoal(version),
        requirements: version.requirements ?? [],
        constraints: version.constraints ?? [],
      },
      reason: proposal.reason, createdAt: proposal.createdAt,
    }
  }

  // ---- task recipes: saved, versioned work orders -----------------------

  async manageRecipe(args: Record<string, unknown>): Promise<string> {
    const action = typeof args.action === 'string' ? args.action : ''
    if (action === 'read' || action === 'list') await this.captureRunUsage()
    return this.serial(() => this.manageRecipeAction(args))
  }

  private async manageRecipeAction(args: Record<string, unknown>): Promise<string> {
    const action = typeof args.action === 'string' ? args.action : ''
    if (action === 'list') return this.recipeListText()
    if (action === 'save') return this.recipeSave(args)
    if (action === 'read' || action === 'revise' || action === 'restore' || action === 'remove') {
      const recipe = this.requireRecipe(typeof args.recipe === 'string' ? args.recipe : '')
      if (action === 'read') return this.recipeReadText(recipe)
      if (action === 'remove') {
        await this.store.deleteRecipe(recipe.id)
        return `Removed recipe ${recipe.id} "${recipe.name}".`
      }
      if (action === 'revise') return this.recipeRevise(recipe, args)
      return this.recipeRestore(recipe, args)
    }
    throw new DotError('dot/invalid', `unknown recipe action ${action}`)
  }

  private requireRecipe(ref: string): RecipeRecord {
    const recipe = ref ? this.store.recipe(ref) : undefined
    if (!recipe) {
      const known = this.store.recipes.map(row => `${row.id} "${row.name}"`).join(', ')
      throw new DotError('dot/invalid', `unknown recipe ${ref || '(missing recipe)'}; saved recipes: ${known || 'none'}`)
    }
    return recipe
  }

  /**
   * Body fields from tool args over a base body: an absent argument keeps the
   * base field, an explicitly empty string clears it. The result is validated
   * with the same contract a change input must pass, so a stored recipe can
   * never fail a create for shape reasons.
   */
  private recipeArgsBody(base: Partial<RecipeBody> | undefined, args: Record<string, unknown>): Omit<RecipeBody, 'requirements'> & { readonly requirements?: readonly Requirement[] } {
    const raw = (key: string): string | undefined => typeof args[key] === 'string' ? args[key] : undefined
    const text = (key: string, fallback?: string): string | undefined => {
      const given = raw(key)
      return given === undefined ? fallback : given.trim() || undefined
    }
    const goal = text('goal', base?.goal)
    if (!goal?.trim()) throw new DotError('dot/invalid', 'goal must be a non-empty English sentence')
    const requirements = args.requirements === undefined ? base?.requirements : requirementList(args.requirements)
    const constraints = args.constraints === undefined ? base?.constraints : constraintList(args.constraints)
    const dir = text('dir', base?.dir)
    if (dir !== undefined && !isAbsolute(dir)) throw new DotError('dot/invalid', 'dir must be an absolute directory')
    let access = base?.access
    const accessRaw = raw('access')
    if (accessRaw !== undefined) {
      if (accessRaw === 'read' || accessRaw === 'write') access = accessRaw
      else if (!accessRaw.trim()) access = undefined
      else throw new DotError('dot/invalid', 'access must be "read" or "write"')
    }
    let humanReview = base?.humanReview
    if (args.human_review !== undefined) humanReview = args.human_review === true ? true : undefined
    let isolation = base?.isolation
    const isolationRaw = raw('isolation')
    if (isolationRaw !== undefined) {
      if (isolationRaw === 'worktree') isolation = 'worktree'
      else if (isolationRaw === 'none' || !isolationRaw.trim()) isolation = undefined
      else throw new DotError('dot/invalid', 'isolation must be "none" or "worktree"')
    }
    const problem = inputContractError(requirements ?? [], [], constraints)
    if (problem) throw new DotError('dot/invalid', problem)
    const notes = text('notes', base?.notes)
    const deliverableLanguage = text('deliverable_language', base?.deliverableLanguage)
    const preset = text('preset', base?.preset)
    const model = text('model', base?.model)
    return {
      goal,
      ...(requirements !== undefined ? { requirements } : {}),
      ...(constraints && constraints.length > 0 ? { constraints } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(deliverableLanguage !== undefined ? { deliverableLanguage } : {}),
      ...(dir !== undefined ? { dir } : {}),
      ...(preset !== undefined ? { preset } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(access !== undefined ? { access } : {}),
      ...(humanReview !== undefined ? { humanReview } : {}),
      ...(isolation !== undefined ? { isolation } : {}),
    }
  }

  private async recipeSave(args: Record<string, unknown>): Promise<string> {
    const name = (typeof args.name === 'string' ? args.name : '').trim()
    if (!name) throw new DotError('dot/invalid', 'save requires name')
    if (this.store.recipe(name)) throw new DotError('dot/invalid', `a recipe named "${name}" exists already; revise it instead`)
    const fromTask = typeof args.from_task === 'string' ? args.from_task : ''
    let base: RecipeBody | undefined
    if (fromTask) {
      const change = this.store.work.change(fromTask)
      if (!change) throw new DotError('dot/invalid', `unknown change ${fromTask}`)
      const material = this.store.work.input(change.currentInputRef)
      const lastWork = this.store.work.listRuns()
        .filter(run => run.changeId === change.id && run.kind === 'work')
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0]
      const fromChange = this.recipeDirFromChange(change)
      base = {
        goal: material?.goal ?? '',
        requirements: material?.requirements ?? [],
        ...(material?.requirementsFromGoal !== undefined ? { requirementsFromGoal: material.requirementsFromGoal } : {}),
        ...(material?.constraints ? { constraints: material.constraints } : {}),
        ...(material?.deliverableLanguage ? { deliverableLanguage: material.deliverableLanguage } : {}),
        dir: fromChange.dir,
        ...(fromChange.isolation !== undefined ? { isolation: fromChange.isolation } : {}),
        ...(lastWork?.expectedPreset ? { preset: lastWork.expectedPreset } : {}),
        ...(lastWork?.access ? { access: lastWork.access } : {}),
      }
    }
    const body = this.recipeArgsBody(base, args)
    if (args.requirements !== undefined && body.requirements === undefined) {
      throw new DotError('dot/invalid', 'requirements must be a JSON array')
    }
    const requirementsFromGoal = args.requirements === undefined && (base === undefined || requirementsFollowGoal(base))
    const requirements = requirementsFromGoal ? goalRequirements(body.goal) : body.requirements ?? goalRequirements(body.goal)
    if (!body.dir) throw new DotError('dot/invalid', 'save requires an absolute dir (or from_task)')
    const now = this.now()
    let id = ''
    do { id = `rcp-${randomUUID().slice(0, 6)}` } while (this.store.recipe(id))
    const record: RecipeRecord = { ...body, requirements, requirementsFromGoal, dir: body.dir, id, name, revision: 1, history: [], outcomes: [], createdAt: now, updatedAt: now }
    await this.store.putRecipe(record)
    return `Saved recipe ${record.id} "${record.name}" rev 1.`
  }

  private async recipeRevise(recipe: RecipeRecord, args: Record<string, unknown>): Promise<string> {
    const reason = (typeof args.reason === 'string' ? args.reason : '').trim()
    if (!reason) throw new DotError('dot/invalid', 'revise requires reason naming what changed')
    const body = this.recipeArgsBody(recipe, args)
    const explicitRequirements = args.requirements !== undefined
    if (explicitRequirements && body.requirements === undefined) {
      throw new DotError('dot/invalid', 'requirements must be a JSON array')
    }
    const requirementsFromGoal = !explicitRequirements && requirementsFollowGoal(recipe)
    const requirements = explicitRequirements
      ? body.requirements!
      : requirementsFromGoal ? goalRequirements(body.goal) : recipe.requirements
    const name = (typeof args.name === 'string' && args.name.trim() ? args.name.trim() : recipe.name)
    const clash = this.store.recipe(name)
    if (clash && clash.id !== recipe.id) throw new DotError('dot/invalid', `a recipe named "${name}" exists already`)
    if (sameRecipeBody({ ...body, requirements, requirementsFromGoal, name }, recipe)) {
      throw new DotError('dot/invalid', 'revise changes nothing')
    }
    const next = reviseRecipeRecord(recipe, { ...body, requirements, requirementsFromGoal, name, reason }, this.now())
    await this.store.putRecipe(next)
    return `Revised recipe ${recipe.id} "${name}" → rev ${next.revision}.`
  }

  private async recipeRestore(recipe: RecipeRecord, args: Record<string, unknown>): Promise<string> {
    const reason = (typeof args.reason === 'string' ? args.reason : '').trim()
    if (!reason) throw new DotError('dot/invalid', 'restore requires reason')
    const revision = typeof args.revision === 'number' && Number.isInteger(args.revision) ? args.revision : undefined
    const version = revision === undefined ? undefined : recipeVersionAt(recipe, revision)
    if (revision === undefined || !version) {
      const known = recipe.history.map(row => row.revision).join(', ')
      throw new DotError('dot/invalid', `no revision ${revision ?? '?'} in ${recipe.id} history${known ? ` (recorded: ${known})` : ''}`)
    }
    const clash = this.store.recipe(version.name)
    if (clash && clash.id !== recipe.id) throw new DotError('dot/invalid', `a recipe named "${version.name}" exists already`)
    const next = reviseRecipeRecord(recipe, { ...recipeBody(version), name: version.name, reason }, this.now())
    await this.store.putRecipe(next)
    return `Restored recipe ${recipe.id} "${version.name}" to rev ${revision} content as rev ${next.revision}.`
  }

  // ---- recipe proposals: detector + reflection suggest, the human decides --

  /**
   * The key a dismissed detector proposal leaves behind: while the recipe sits
   * on the same revision an identical proposal is not re-raised. A revision
   * change or a different reason re-arms it.
   */
  private detectorProposalDismissed(input: { recipeId: string; baseRevision: number; targetRevision: number; regression: 'acceptance' | 'rework' | 'cost' }): boolean {
    return this.store.recipeProposals.some(row =>
      row.recipeId === input.recipeId && row.origin === 'detector' && row.status === 'dismissed' && row.kind === 'restore'
      && row.baseRevision === input.baseRevision && row.targetRevision === input.targetRevision && row.regression === input.regression)
  }

  /** Persist a pending proposal; at most one pending per recipe. */
  private async newRecipeProposal(input: {
    recipe: RecipeRecord
    kind: 'restore' | 'revise'
    targetRevision?: number
    patch?: RecipeProposal['patch']
    reason: string
    origin: 'detector' | 'reflection'
    regression?: 'acceptance' | 'rework' | 'cost'
  }): Promise<RecipeProposal | undefined> {
    if (this.store.pendingRecipeProposal(input.recipe.id)) return undefined
    let id = ''
    do { id = `rpp-${randomUUID().slice(0, 6)}` } while (this.store.recipeProposal(id))
    const proposal: RecipeProposal = {
      id, recipeId: input.recipe.id, baseRevision: input.recipe.revision,
      kind: input.kind,
      ...(input.targetRevision !== undefined ? { targetRevision: input.targetRevision } : {}),
      ...(input.patch ? { patch: input.patch } : {}),
      reason: input.reason, origin: input.origin,
      ...(input.regression !== undefined ? { regression: input.regression } : {}),
      status: 'pending', createdAt: this.now(),
    }
    // The recipe may be gone by the write (a reset or a delete raced the sweep);
    // a proposal without its recipe is an orphan that survives restart.
    if (!this.store.recipes.some(row => row.id === input.recipe.id)) return undefined
    await this.store.putRecipeProposal(proposal)
    this.holdRecipeNotice(`Recipe proposal ${proposal.id} for ${input.recipe.id} "${input.recipe.name}" (${input.kind}, ${input.origin}): ${input.reason} The human decides in the Recipes panel.`)
    return proposal
  }

  /** A non-waking notice for dot, like the recipe-run reminder hold. */
  private holdRecipeNotice(text: string): void {
    const sessionId = this.store.dotSessionId ?? ''
    this.batcher.hold({
      sessionId, kind: 'recipe-proposal', text, at: this.now(),
      display: { kind: 'recipe-proposal', sessionId, summary: text },
    })
  }

  /**
   * The regression detector sweeps every recipe's live stats — the same rows
   * the Recipes panel shows — and files one restore proposal per regressed
   * recipe. Called after an outcome lands and on the reminder clock's tick;
   * pending-proposal and dismissed-key dedupe keep repeats cheap.
   */
  async checkRecipeRegressions(): Promise<void> {
    // A factory reset bumps the generation before wiping; a sweep that started
    // earlier stops instead of writing proposals for recipes that no longer exist.
    const generation = this.resetGeneration
    for (const recipe of this.store.recipes) {
      if (this.closing || this.resetGeneration !== generation) return
      const regression = recipeRegression(recipe, recipeRevisionStats(recipe, this.liveRecipeChanges(recipe.id)))
      if (!regression) continue
      if (this.detectorProposalDismissed({ recipeId: recipe.id, baseRevision: recipe.revision, targetRevision: regression.betterRevision, regression: regression.reason })) continue
      await this.newRecipeProposal({ recipe, kind: 'restore', targetRevision: regression.betterRevision, reason: regression.summary, origin: 'detector', regression: regression.reason })
    }
  }

  /**
   * The reflection pass files one recipe proposal. `restore` names an earlier
   * revision; `revise` carries the same fields dot_recipe revise accepts, with
   * requirements/constraints as JSON strings like the tool schema declares.
   */
  async reflectionRecipePropose(args: Record<string, unknown>): Promise<string> {
    return this.serial(async () => {
      const recipe = this.requireRecipe(typeof args.recipe === 'string' ? args.recipe : '')
      const reason = (typeof args.reason === 'string' ? args.reason : '').trim()
      if (!reason) throw new DotError('dot/invalid', 'propose requires reason')
      const action = args.action
      if (action !== 'restore' && action !== 'revise') throw new DotError('dot/invalid', 'action must be "restore" or "revise"')
      if (this.store.pendingRecipeProposal(recipe.id)) throw new DotError('dot/invalid', `a proposal is already pending for recipe ${recipe.id}; the human decides it first`)
      if (action === 'restore') {
        const revision = typeof args.revision === 'number' && Number.isInteger(args.revision) ? args.revision : undefined
        if (revision === undefined || !recipeVersionAt(recipe, revision)) {
          throw new DotError('dot/invalid', `no revision ${revision ?? '?'} in ${recipe.id} history (recorded: ${recipe.history.map(row => row.revision).join(', ') || 'none'})`)
        }
        const proposal = await this.newRecipeProposal({ recipe, kind: 'restore', targetRevision: revision, reason, origin: 'reflection' })
        return `Proposed restoring recipe ${recipe.id} "${recipe.name}" to rev ${revision} content (proposal ${proposal!.id}); the human decides in the Recipes panel.`
      }
      const body = this.recipeArgsBody(recipe, args)
      // Parse the JSON-string fields through the same validators a revise
      // uses; requirementList tolerates unparsable strings, so an explicit
      // value that parsed to nothing is rejected like recipeRevise does.
      const patchRequirements = args.requirements !== undefined ? requirementList(args.requirements) : undefined
      if (args.requirements !== undefined && patchRequirements === undefined) {
        throw new DotError('dot/invalid', 'requirements must be a JSON array')
      }
      const patch: NonNullable<RecipeProposal['patch']> = {
        ...(args.goal !== undefined ? { goal: body.goal } : {}),
        ...(patchRequirements !== undefined ? { requirements: patchRequirements } : {}),
        ...(args.constraints !== undefined ? { constraints: constraintList(args.constraints) ?? [] } : {}),
        ...(args.notes !== undefined ? { notes: body.notes ?? '' } : {}),
      }
      if (Object.keys(patch).length === 0) throw new DotError('dot/invalid', 'revise proposal needs at least one of goal, requirements, constraints, notes')
      // A patch that merges into the current body unchanged is refused at
      // submit, like recipeRevise's 'revise changes nothing'.
      if (sameRecipeBody({ ...mergedRecipeBody(recipe, patch), name: recipe.name }, recipe)) {
        throw new DotError('dot/invalid', 'revise proposal changes nothing')
      }
      const proposal = await this.newRecipeProposal({ recipe, kind: 'revise', patch, reason, origin: 'reflection' })
      return `Proposed revising recipe ${recipe.id} "${recipe.name}" (proposal ${proposal!.id}); the human decides in the Recipes panel.`
    })
  }

  /**
   * The human approves or dismisses a proposal from the Recipes panel.
   * Approval applies through the same revise/restore paths dot uses; a recipe
   * that moved past baseRevision marks the proposal stale instead of applying.
   */
  async decideRecipeProposal(args: Record<string, unknown>): Promise<string> {
    return this.serial(async () => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const proposal = this.store.recipeProposal(id)
      if (!proposal) throw new DotError('dot/invalid', `unknown recipe proposal ${id || '(missing id)'}`)
      if (proposal.status !== 'pending') throw new DotError('dot/invalid', `proposal ${id} is already ${proposal.status}`)
      if (args.allow !== true) {
        await this.store.putRecipeProposal({ ...proposal, status: 'dismissed', decidedAt: this.now() })
        this.holdRecipeNotice(`Recipe proposal ${id} for ${proposal.recipeId} was dismissed by the human.`)
        return `Dismissed recipe proposal ${id}.`
      }
      const recipe = this.store.recipes.find(row => row.id === proposal.recipeId)
      if (!recipe) throw new DotError('dot/invalid', `recipe ${proposal.recipeId} no longer exists`)
      if (recipe.revision !== proposal.baseRevision) {
        await this.store.putRecipeProposal({ ...proposal, status: 'stale', decidedAt: this.now() })
        throw new DotError('dot/invalid', `recipe ${recipe.id} is now rev ${recipe.revision}; proposal ${id} was made against rev ${proposal.baseRevision} and is stale`)
      }
      const reason = `Approved proposal ${id}: ${proposal.reason}`
      let text: string
      if (proposal.kind === 'restore') {
        text = await this.recipeRestore(recipe, { revision: proposal.targetRevision, reason })
      } else {
        const patchArgs: Record<string, unknown> = { reason }
        if (proposal.patch?.goal !== undefined) patchArgs.goal = proposal.patch.goal
        if (proposal.patch?.requirements !== undefined) patchArgs.requirements = proposal.patch.requirements
        if (proposal.patch?.constraints !== undefined) patchArgs.constraints = proposal.patch.constraints
        if (proposal.patch?.notes !== undefined) patchArgs.notes = proposal.patch.notes
        text = await this.recipeRevise(recipe, patchArgs)
      }
      await this.store.putRecipeProposal({ ...proposal, status: 'approved', decidedAt: this.now() })
      this.holdRecipeNotice(`Recipe proposal ${id} for ${recipe.id} "${recipe.name}" was approved by the human. ${text}`)
      return `${text} Proposal ${id} approved.`
    })
  }

  /**
   * The [recipes] section of the reflection instruction: up to three recipes
   * that regressed or have at least three finished outcomes on the current
   * revision. Regressed rows add the current and better revision's goal and
   * requirement texts, clipped, so the pass can judge without a second read.
   */
  private reflectionRecipeHints(): string {
    const clip = (text: string, max = 160) => text.length > max ? `${text.slice(0, max - 1)}…` : text
    const requirementTexts = (body: { readonly requirements?: readonly { readonly text: string }[] }) =>
      (body.requirements ?? []).map(row => `"${clip(row.text, 80)}"`).join(', ') || '(none)'
    const rows: string[] = []
    for (const recipe of this.store.recipes) {
      if (rows.length >= 3) break
      const live = this.liveRecipeChanges(recipe.id)
      const stats = recipeRevisionStats(recipe, live)
      const regression = recipeRegression(recipe, stats)
      const current = stats.find(row => row.revision === recipe.revision)
      const finished = current ? current.accepted + current.cancelled : 0
      if (!regression && finished < 3) continue
      const lines = [`- ${recipe.id} "${recipe.name}" rev ${recipe.revision} — ${recipeStatsLine(recipe, live)}`]
      if (regression) {
        const better = recipeVersionAt(recipe, regression.betterRevision)
        lines.push(`  regression (${regression.reason}): ${regression.summary}`)
        if (better) {
          lines.push(`  goal now: ${clip(recipe.goal)}`)
          lines.push(`  goal rev ${regression.betterRevision}: ${clip(better.goal)}`)
          lines.push(`  requirements now: ${requirementTexts(recipe)}`)
          lines.push(`  requirements rev ${regression.betterRevision}: ${requirementTexts(better)}`)
        }
      }
      rows.push(lines.join('\n'))
    }
    return rows.join('\n')
  }

  /** Live changes tagged with a recipe, reduced to what its stats need. */
  private liveRecipeChanges(recipeId: string): LiveRecipeChange[] {
    const runs = this.store.work.listRuns()
    return this.store.work.listChanges().flatMap(change => {
      if (change.recipe?.id !== recipeId) return []
      const own = runs.filter(run => run.changeId === change.id)
      const terminal = changeIsTerminal(change, own)
      return [{
        changeId: change.id,
        title: change.title,
        revision: change.recipe.revision,
        terminal,
        accepted: change.closeout !== undefined,
        failedRounds: terminal ? this.store.work.failedRoundsAcrossInputs(change.id) : 0,
        ...runCostTotals(own),
        at: change.updatedAt,
      }]
    })
  }

  private recipeListText(): string {
    const rows = this.store.recipes
    if (rows.length === 0) return 'No recipes.'
    return rows.map(recipe => `${recipe.id} "${recipe.name}" rev ${recipe.revision} — ${recipeStatsLine(recipe, this.liveRecipeChanges(recipe.id))}`).join('\n')
  }

  private recipeReadText(recipe: RecipeRecord): string {
    const live = this.liveRecipeChanges(recipe.id)
    return JSON.stringify({
      id: recipe.id,
      name: recipe.name,
      revision: recipe.revision,
      ...(recipe.reason !== undefined ? { reason: recipe.reason } : {}),
      goal: recipe.goal,
      requirements: recipe.requirements,
      requirementsFromGoal: requirementsFollowGoal(recipe),
      constraints: recipe.constraints ?? [],
      ...(recipe.notes !== undefined ? { notes: recipe.notes } : {}),
      ...(recipe.deliverableLanguage !== undefined ? { deliverableLanguage: recipe.deliverableLanguage } : {}),
      ...(recipe.dir !== undefined ? { dir: recipe.dir } : {}),
      ...(recipe.preset !== undefined ? { preset: recipe.preset } : {}),
      ...(recipe.model !== undefined ? { model: recipe.model } : {}),
      ...(recipe.access !== undefined ? { access: recipe.access } : {}),
      ...(recipe.humanReview !== undefined ? { humanReview: recipe.humanReview } : {}),
      ...(recipe.isolation !== undefined ? { isolation: recipe.isolation } : {}),
      history: recipe.history.map(row => ({
        ...recipeBody(row), requirementsFromGoal: requirementsFollowGoal(row),
        revision: row.revision, name: row.name, ...(row.reason !== undefined ? { reason: row.reason } : {}), at: row.at,
      })),
      stats: recipeRevisionStats(recipe, live),
      outcomes: mergeRecipeOutcomes(recipe.outcomes, live).slice(0, 10),
      ...(this.store.pendingRecipeProposal(recipe.id) ? { pendingProposal: this.store.pendingRecipeProposal(recipe.id) } : {}),
    })
  }

  /** The recipe a change tag names, when that exact recipe still exists. */
  private taggedRecipe(change: ChangeRecord | undefined): RecipeRecord | undefined {
    const tag = change?.recipe
    if (!tag) return undefined
    const recipe = this.store.recipe(tag.id)
    return recipe && recipe.id === tag.id ? recipe : undefined
  }

  // ---- history: the record dot looks things up in ----------------------

  /** The sessions a search covers, newest first: dot's own segments, then the sessions on its ledger. */
  private historySessions(scope: 'all' | 'own' | 'tasks'): { sessionId: string; what: string; own: boolean }[] {
    const out: { sessionId: string; what: string; own: boolean }[] = []
    if (scope !== 'tasks') {
      const current = this.store.dotSessionId
      if (current) out.push({ sessionId: current, what: 'Your conversation, current session', own: true })
      for (const past of [...this.store.pastSegments].reverse()) {
        const span = past.startedAt > 0 ? ` (${stamp(past.startedAt)} to ${stamp(past.endedAt)})` : ` (until ${stamp(past.endedAt)})`
        out.push({ sessionId: past.sessionId, what: `Your conversation, earlier session${span}`, own: true })
      }
    }
    if (scope !== 'own') {
      for (const task of [...this.store.list()].sort((a, b) => b.updatedAt - a.updatedAt)) {
        out.push({ sessionId: task.sessionId, what: `Task "${task.title}"${task.status === 'archived' ? ' (archived)' : ''}`, own: false })
      }
    }
    return out
  }

  private describeSession(sessionId: string): { sessionId: string; what: string; own: boolean } {
    return this.historySessions('all').find(row => row.sessionId === sessionId) ?? { sessionId, what: 'Session not on your ledger', own: false }
  }

  /**
   * Find earlier messages. Every word of the query has to occur in one message;
   * the search reads the session logs themselves, so nothing has to be kept in step.
   */
  async searchHistory(input: { query: string; sessionId?: string; scope?: string; tools?: boolean; limit?: number }): Promise<string> {
    const terms = queryTerms(input.query)
    if (terms.length === 0) throw new DotError('dot/invalid', 'query must hold at least one word')
    const scope = input.scope === 'own' || input.scope === 'tasks' ? input.scope : 'all'
    const only = input.sessionId?.trim()
    const candidates = only ? [this.describeSession(only)] : this.historySessions(scope)
    const targets = candidates.slice(0, SEARCH_SESSIONS_MAX)
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? SEARCH_LIMIT_DEFAULT), SEARCH_LIMIT_MAX))
    const groups: SessionHits[] = []
    let failed = 0
    const batchSize = 8
    for (let start = 0; start < targets.length; start += batchSize) {
      const batch = targets.slice(start, start + batchSize)
      const results = await Promise.all(batch.map(async target => {
        try {
          const events = await this.host.readEvents(target.sessionId)
          return { ok: true as const, target, events }
        } catch (error) {
          return { ok: false as const, target, error }
        }
      }))
      for (const item of results) {
        if (!item.ok) {
          if (only) throw new DotError('dot/unknown-session', `session ${only} could not be read: ${messageOf(item.error)}`)
          failed++
          continue
        }
        const hits = searchRows(historyRows(item.events, input.tools === true, LOOKUP_TOOLS), terms).reverse()
        if (hits.length > 0) groups.push({ ...item.target, hits })
      }
    }
    groups.sort((a, b) => b.hits[0]!.at - a.hits[0]!.at)
    return formatSearch({ query: input.query.trim(), groups, limit, searched: targets.length - failed, skipped: candidates.length - targets.length, failed, readTool: TOOL.readHistory })
  }

  /** Read a stretch of one session word for word: around a position, or its last messages. */
  async readHistory(input: { sessionId: string; seq?: number; before?: number; after?: number; tools?: boolean }): Promise<string> {
    const sessionId = input.sessionId.trim()
    if (!sessionId) throw new DotError('dot/invalid', 'session_id must be non-empty')
    let events
    try { events = await this.host.readEvents(sessionId) } catch (error) {
      throw new DotError('dot/unknown-session', `session ${sessionId} could not be read: ${messageOf(error)}`)
    }
    const bound = (value: number | undefined) => Math.max(0, Math.min(Math.trunc(value ?? READ_ROWS_DEFAULT), READ_ROWS_MAX))
    const window = windowRows(historyRows(events, input.tools === true, LOOKUP_TOOLS), { ...input.seq === undefined ? {} : { seq: Math.trunc(input.seq) }, before: bound(input.before), after: bound(input.after) })
    return formatRead({ ...this.describeSession(sessionId), ...window })
  }

  // ---- agreements and cognition: what dot knows in every conversation ----

  /** Run queued agreements/cognition changes one at a time, so none is lost. */
  private withKnowledge<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new DotError('dot/disposed', 'dot is shutting down'))
    const run = this.knowledgeLane.then(() => { this.assertOpen(); return work() })
    this.knowledgeLane = run.catch(() => undefined)
    return run
  }

  /** How many cognition entries reach the prompt this service renders; pinned entries always do on top. */
  private get cognitionPromptEntries(): number { return this.options.cognitionPromptEntries ?? COGNITION_PROMPT_ENTRIES_DEFAULT }

  async knowledgeView(): Promise<KnowledgeView> {
    const undo = this.store.agreementEntriesUndo
    return {
      agreements: { entries: this.store.agreementEntries, canUndo: undo !== undefined && !sameEntries(undo, this.store.agreementEntries) },
      cognition: { entries: cognitionWithActive(this.store.cognitionEntries, this.cognitionPromptEntries), history: this.store.cognitionEntryHistory },
    }
  }

  /** Map a memory-layer refusal to the service error shape the tools report. */
  private knowledgeError(error: unknown): DotError {
    return error instanceof KnowledgeError ? new DotError(error.code, error.message) : error instanceof DotError ? error : new DotError('dot/invalid', messageOf(error))
  }

  /** dot adds one of the human's own requirements, in their words. */
  async agreementAdd(text: string): Promise<string> {
    return this.withKnowledge(async () => {
      if (this.store.settings.locks?.agreements) throw new DotError('dot/setting-locked', 'agreements are locked by the human; use dot_settings (action=propose) for the change you want')
      const before = this.store.agreementEntries
      let after: readonly AgreementEntry[]
      try { after = applyAgreementEdit(before, { op: 'add', text }, this.now(), () => this.store.nextKnowledgeId('a')) } catch (error) {
        throw this.knowledgeError(error)
      }
      if (sameEntries(after, before)) return 'That is already one of your agreements.'
      await this.store.setAgreementEntries(after)
      await this.afterAgreementsChange(before, after, 'dot')
      return 'Recorded as an agreement. The [agreements] block of this session still shows them as they were when it started; your next session shows the new one.'
    })
  }

  /** dot drops one agreement the human asked it to drop. */
  async agreementRemove(text: string): Promise<string> {
    return this.withKnowledge(async () => {
      if (this.store.settings.locks?.agreements) throw new DotError('dot/setting-locked', 'agreements are locked by the human; use dot_settings (action=propose) for the change you want')
      const before = this.store.agreementEntries
      let target: AgreementEntry
      try { target = matchEntry(before, text, 'agreement') } catch (error) {
        throw this.knowledgeError(error)
      }
      const after = before.filter(entry => entry.id !== target.id)
      await this.store.setAgreementEntries(after)
      await this.afterAgreementsChange(before, after, 'dot')
      return `Removed this agreement: "${target.text}".`
    })
  }

  /** dot records one new cognition entry. */
  async cognitionAdd(text: string): Promise<string> {
    return this.withKnowledge(async () => {
      const before = this.store.cognitionEntries
      let after: readonly CognitionEntry[]
      try { after = applyCognitionEdit(before, { op: 'add', text }, this.now(), () => this.store.nextKnowledgeId('c')) } catch (error) {
        throw this.knowledgeError(error)
      }
      if (sameEntries(after, before)) return 'That is already in your cognition.'
      const added = after.find(entry => !before.some(earlier => earlier.id === entry.id))
      const woken = added ? undefined : after.find(entry => before.some(earlier => earlier.id === entry.id && earlier.seenAt !== entry.seenAt))
      await this.store.setCognitionEntries(after, this.now())
      await this.afterCognitionChange(before, after, 'dot', added?.id ?? woken?.id)
      if (!added) return 'That is already in your cognition.'
      return 'Recorded in your cognition. The [cognition] block of this session still shows what it showed when it started; your next session shows the new one.'
    })
  }

  /** dot replaces the text of the cognition entry `match` names — pinned entries belong to the human. */
  async cognitionUpdate(match: string, text: string): Promise<string> {
    return this.withKnowledge(async () => {
      const before = this.store.cognitionEntries
      let target: CognitionEntry
      try { target = matchEntry(before, match, 'cognition', 'match') } catch (error) {
        throw this.knowledgeError(error)
      }
      if (target.pinned === true) throw new DotError('dot/pinned', `"${target.text}" is pinned by the human; only the human can change it`)
      let after: readonly CognitionEntry[]
      try { after = applyCognitionEdit(before, { op: 'edit', id: target.id, text }, this.now(), () => this.store.nextKnowledgeId('c')) } catch (error) {
        throw this.knowledgeError(error)
      }
      await this.store.setCognitionEntries(after, this.now())
      await this.afterCognitionChange(before, after, 'dot', target.id)
      return 'Updated that cognition entry. The [cognition] block of this session still shows what it showed when it started; your next session shows the new one.'
    })
  }

  /** dot deletes the cognition entry `match` names — pinned entries belong to the human. */
  async cognitionRemove(match: string): Promise<string> {
    return this.withKnowledge(async () => {
      const before = this.store.cognitionEntries
      let target: CognitionEntry
      try { target = matchEntry(before, match, 'cognition', 'match') } catch (error) {
        throw this.knowledgeError(error)
      }
      if (target.pinned === true) throw new DotError('dot/pinned', `"${target.text}" is pinned by the human; only the human can remove it`)
      const after = before.filter(entry => entry.id !== target.id)
      await this.store.setCognitionEntries(after, this.now())
      await this.afterCognitionChange(before, after, 'dot')
      return `Removed this cognition entry: "${target.text}".`
    })
  }

  /** List or search all stored cognition entries (pinned, active, and dormant) with offset/limit paging. */
  async cognitionList(input?: { readonly query?: string; readonly offset?: number; readonly limit?: number }): Promise<string> {
    const ranked = cognitionWithActive(this.store.cognitionEntries, this.cognitionPromptEntries)
    if (ranked.length === 0) return 'No cognition entries yet.'
    const query = input?.query === undefined ? undefined : normalizeEntry(input.query)
    const matched = filterCognitionEntries(ranked, query)
    if (matched.length === 0) return `No cognition entries match "${query}" (${ranked.length} stored).`
    const rawOffset = input?.offset ?? 0
    if (!Number.isFinite(rawOffset) || rawOffset < 0) throw new DotError('dot/invalid', 'offset must be a non-negative integer')
    const offset = Math.trunc(rawOffset)
    const rawLimit = input?.limit ?? 40
    if (!Number.isFinite(rawLimit) || rawLimit < 1) throw new DotError('dot/invalid', 'limit must be a positive integer')
    const limit = Math.min(100, Math.trunc(rawLimit))
    const page = matched.slice(offset, offset + limit)
    if (page.length === 0) return `No cognition entries at offset ${offset} (${matched.length} matched).`
    const start = offset + 1
    const end = offset + page.length
    const scope = query
      ? `Matching cognition entries for "${query}" (${start}–${end} of ${matched.length}; ${ranked.length} total)`
      : `Cognition entries (${start}–${end} of ${matched.length}; prompt limit ${this.cognitionPromptEntries})`
    const lines = page.map(entry => `- [${entry.pinned === true ? 'pinned' : entry.active ? 'active' : 'dormant'}] ${entry.text}`)
    const next = offset + page.length < matched.length ? `\nMore entries remain; pass offset=${offset + page.length} to continue.` : ''
    return `${scope}:\n${lines.join('\n')}${next}`
  }

  /** dot_settings proposal approval carries bulk text: identical lines reuse their stored entry. */
  async setAgreements(text: string, by: 'human' | 'dot' = 'human'): Promise<KnowledgeView> {
    return this.withKnowledge(async () => {
      const before = this.store.agreementEntries
      const after = agreementEntriesFromText(text, before, this.now(), () => this.store.nextKnowledgeId('a'), true)
      if (!sameEntries(after, before)) {
        await this.store.setAgreementEntries(after)
        await this.afterAgreementsChange(before, after, by)
      }
      return this.knowledgeView()
    })
  }

  /** One panel edit on the agreements: add, edit or remove a single entry. */
  async editAgreements(edit: KnowledgeEdit): Promise<KnowledgeView> {
    return this.withKnowledge(async () => {
      const before = this.store.agreementEntries
      let after: readonly AgreementEntry[]
      try { after = applyAgreementEdit(before, parseKnowledgeEdit(edit, 'agreements'), this.now(), () => this.store.nextKnowledgeId('a')) } catch (error) {
        throw this.knowledgeError(error)
      }
      if (!sameEntries(after, before)) {
        await this.store.setAgreementEntries(after)
        await this.afterAgreementsChange(before, after, 'human')
      }
      return this.knowledgeView()
    })
  }

  /** Put the agreements back to what they were before their latest change, whoever made it. */
  async undoAgreements(): Promise<KnowledgeView> {
    return this.withKnowledge(async () => {
      const before = this.store.agreementEntries
      if (!(await this.store.undoAgreements())) throw new DotError('dot/nothing-to-undo', 'there is no earlier version of the agreements')
      await this.afterAgreementsChange(before, this.store.agreementEntries, 'human')
      return this.knowledgeView()
    })
  }

  /** One panel edit on cognition: add, edit, remove or pin a single entry. */
  async editCognition(edit: KnowledgeEdit): Promise<KnowledgeView> {
    return this.withKnowledge(async () => {
      const before = this.store.cognitionEntries
      let after: readonly CognitionEntry[]
      try { after = applyCognitionEdit(before, parseKnowledgeEdit(edit, 'cognition'), this.now(), () => this.store.nextKnowledgeId('c')) } catch (error) {
        throw this.knowledgeError(error)
      }
      if (!sameEntries(after, before)) {
        await this.store.setCognitionEntries(after, this.now())
        await this.afterCognitionChange(before, after, 'human')
      }
      return this.knowledgeView()
    })
  }

  /** The reflection pass's ops, applied together or not at all; [] saves nothing. */
  private async applyCognitionOps(raw: string, baseVersion: number): Promise<void> {
    return this.withKnowledge(async () => {
      if (this.store.cognitionVersion !== baseVersion) throw new DotError('dot/stale-reflection', 'cognition changed since this reflection started')
      const before = this.store.cognitionEntries
      let ops: ReturnType<typeof parseCognitionOps>
      let after: readonly CognitionEntry[]
      try {
        ops = parseCognitionOps(raw)
        after = applyCognitionOps(before, ops, this.now(), () => this.store.nextKnowledgeId('c'))
      } catch (error) {
        throw this.knowledgeError(error)
      }
      if (ops.length === 0 || sameEntries(after, before)) return
      await this.store.setCognitionEntries(after, this.now())
      await this.afterCognitionChange(before, after, 'reflection')
    })
  }

  /** Put an earlier cognition entry list back; the list it replaces joins the history too. */
  async restoreCognition(at: number): Promise<KnowledgeView> {
    return this.withKnowledge(async () => {
      const before = this.store.cognitionEntries
      if (!(await this.store.restoreCognition(at, this.now()))) throw new DotError('dot/unknown-version', 'no earlier cognition version has that timestamp')
      if (!sameEntries(this.store.cognitionEntries, before)) await this.afterCognitionChange(before, this.store.cognitionEntries, 'human')
      return this.knowledgeView()
    })
  }

  // ---- background reflection -------------------------------------------

  /** The submission tool calls this; the pass must be the one currently running. */
  reflectionSubmit(ops: string, agreementNotes: string | undefined, sessionId: string): Promise<string> {
    // Same lane as `say`: a submission can never interleave with a human message
    // between reading agreementNotes and clearing them, so a fresh note is not
    // wiped by a message that carried the previous one.
    return this.serial(() => this.reflection.submit(ops, agreementNotes, sessionId))
  }

  /** Reflection passes remembered for the trajectory view, oldest first. */
  reflectionRuns(): readonly ReflectionRun[] { return this.store.reflections }

  /** The stored trajectory of one reflection pass; only ids the store remembers are readable. */
  async reflectionTrajectory(sessionId: string): Promise<TrajectoryView> {
    const id = sessionId.trim()
    if (!id || !this.store.reflections.some(run => run.sessionId === id)) throw new DotError('dot/unknown-reflection', `no reflection pass ${id}`)
    return this.reflection.trajectory(id)
  }

  /** dot's own change only updates the segment's seen snapshot when it was in step; a panel edit never does. */
  private async afterAgreementsChange(before: readonly AgreementEntry[], after: readonly AgreementEntry[], by: 'human' | 'dot'): Promise<void> {
    if (by !== 'dot') return
    const segment = this.store.segment
    if (!segment) return
    if ((segment.agreementsSeen ?? segment.agreements ?? '') === agreementsSection(before)) await this.store.noteAgreementsSeen(agreementsSection(after))
  }

  private async afterCognitionChange(before: readonly CognitionEntry[], after: readonly CognitionEntry[], by: 'human' | 'dot' | 'reflection', touchedId?: string): Promise<void> {
    if (by !== 'dot') return
    const segment = this.store.segment
    if (!segment) return
    if ((segment.cognitionSeen ?? segment.cognition ?? '') !== cognitionSection(before, this.cognitionPromptEntries)) return
    // A change dot made in step is invisible to the prompt… unless it promoted
    // a dormant entry dot did not touch. That promotion lands at the next
    // message through the normal prompt-changed rollover instead.
    const wasActive = new Set(cognitionWithActive(before, this.cognitionPromptEntries).filter(entry => entry.active).map(entry => entry.id))
    if (cognitionWithActive(after, this.cognitionPromptEntries).some(entry => entry.active && !wasActive.has(entry.id) && entry.id !== touchedId)) return
    await this.store.noteCognitionSeen(cognitionSection(after, this.cognitionPromptEntries))
  }

  // ---- host events -----------------------------------------------------

  onStatus(sessionId: string, status: 'running' | 'idle'): void {
    if (this.closing) return
    if (status === 'idle') this.retryHealth.clear(sessionId)
    if (this.isDot(sessionId)) {
      if (status === 'running') { this.idleSince = undefined; this.idleChecker.cancel() }
      else { this.idleSince ??= this.now(); this.batcher.wake(); this.armIdleCheck() }
      return
    }
    if (status === 'running') this.abortQuietWait(sessionId, 'running', false)
    void this.store.apply({ type: 'status', sessionId, status, at: this.now() }, this.pending.list())
  }

  onTurnEnd(sessionId: string): Promise<void> {
    if (this.closing) return Promise.resolve()
    return this.track(() => this.onTurnEndNow(sessionId))
  }

  private lookupBackgroundAgent(sessionId: string): BackgroundAgentLike | undefined {
    try {
      const agent = getAgentsService(this.getService)?.get?.(sessionId)
      if (agent && typeof agent.id === 'string' && typeof agent.status === 'string') return agent
    } catch { /* optional host agents registry */ }
    return undefined
  }

  private formatKilledJobsSummary(killed: readonly KilledJobSummary[]): string {
    if (killed.length === 0) return ''
    const lines = killed.map(job => job.outputTail ? `- ${job.name}: ${clip(job.outputTail, 160)}` : `- ${job.name}`)
    return `\n[background timeout: stopped ${killed.length} job(s) after 30m limit]\n${lines.join('\n')}`
  }

  private async onTurnEndNow(sessionId: string): Promise<void> {
    if (this.closing) return
    this.ensureBackgroundJobsSubscription()
    const owned = this.store.work.sessionRun(sessionId)
    if (owned && this.quietWaits.isAbandoned(sessionId)) return

    const isOpenOwned = owned !== undefined && owned.phase !== 'completed' && owned.phase !== 'failed' && owned.phase !== 'stopped'
    if (isOpenOwned) {
      await observeRun(this.store.work, this.runHost(), owned.id, this.now()).catch(error => {
        this.options.log?.(`dsh-dot: run ${owned.id} was not observed: ${messageOf(error)}`)
      })
    }
    if (this.closing || this.isDot(sessionId) || !this.liveTask(sessionId)) return

    let timeoutSummary = ''
    if (isOpenOwned) {
      const liveJobs = runningJobs(this.getService, sessionId)
      const hasSubagents = (() => {
        try {
          const sub = this.getService?.('subagents') as { waitForTreeWork?: unknown } | undefined
          return typeof sub?.waitForTreeWork === 'function'
        } catch {
          return false
        }
      })()
      const agent = this.lookupBackgroundAgent(sessionId)
      const agentStatus = agent?.status ?? (this.host.isRunning(sessionId) ? 'running' : 'idle')
      if (agentStatus !== 'idle') return
      if (liveJobs.length > 0 || hasSubagents) {
        const waitController = this.quietWaits.begin(sessionId, this.now())
        const limitController = new AbortController()
        const limitMs = this.options.backgroundLimitMs ?? BACKGROUND_LIMIT_MS
        const limitHandle = this.timer.set(() => {
          if (!limitController.signal.aborted) limitController.abort('background-timeout')
        }, limitMs)
        ;(limitHandle as { unref?: () => void } | undefined)?.unref?.()
        this.armIdleCheck()
        const waitAgent: BackgroundAgentLike = agent ?? { id: sessionId, status: 'idle' }
        let quiet = false
        try {
          quiet = await untilQuiet(
            this.getService,
            waitAgent,
            AbortSignal.any([waitController.signal, limitController.signal]),
          )
        } finally {
          this.timer.clear(limitHandle)
          this.quietWaits.end(sessionId, waitController, this.now())
          this.armIdleCheck()
        }
        if (this.closing || waitController.signal.aborted) return
        if (limitController.signal.aborted) {
          this.quietWaits.markAbandoned(sessionId)
          const preKill = runningJobs(this.getService, sessionId)
          let killed: KilledJobSummary[] = []
          try {
            killed = await killJobs(this.getService, sessionId, 'background-timeout')
          } catch {
            killed = preKill
          }
          if (this.closing || waitController.signal.aborted) return
          timeoutSummary = this.formatKilledJobsSummary(killed.length > 0 ? killed : preKill)
        } else if (!quiet) {
          return
        }
        const currentRun = this.store.work.sessionRun(sessionId)
        if (currentRun && currentRun.phase !== 'completed' && currentRun.phase !== 'failed' && currentRun.phase !== 'stopped') {
          await observeRun(this.store.work, this.runHost(), currentRun.id, this.now()).catch(error => {
            this.options.log?.(`dsh-dot: run ${currentRun.id} was not observed: ${messageOf(error)}`)
          })
        }
        if (this.closing || waitController.signal.aborted || this.isDot(sessionId) || !this.liveTask(sessionId)) return
      }
    }

    const reply = await this.host.latestReply(sessionId, 600).catch(() => undefined)
    if (this.closing) return
    const task = await this.store.apply({ type: 'turn-end', sessionId, at: this.now(), ...reply ? { note: reply } : {} }, this.pending.list())
    if (!task || task.status === 'archived') return
    const ownedNow = this.store.work.sessionRun(sessionId)
    const change = ownedNow ? this.store.work.change(ownedNow.changeId) : undefined
    const older = ownedNow && change && (ownedNow.inputRef !== change.currentInputRef || ownedNow.inputRevision !== change.currentRevision)
    const text = ownedNow
      ? `${ownedNow.changeId} ${ownedNow.id} input ${ownedNow.inputRef}@${ownedNow.inputRevision}${older ? ' (older input; it does not advance the current one)' : ''}: ${clip(reply ?? '(no text)', 400)}${timeoutSummary}`
      : `"${task.title}" finished a turn: ${clip(reply ?? '(no text)', 400)}`
    this.notify({ sessionId, kind: 'turn-end', text, at: this.now() })
  }

  onError(sessionId: string, error: unknown): void {
    if (this.closing || this.isDot(sessionId) || !this.liveTask(sessionId)) return
    const message = messageOf(error)
    void this.store.apply({ type: 'error', sessionId, at: this.now(), message }, this.pending.list())
    const owned = this.store.work.sessionRun(sessionId)
    const text = owned ? `${owned.changeId} ${owned.id} input ${owned.inputRef}@${owned.inputRevision}: ${clip(message, 400)}` : clip(message, 400)
    this.notify({ sessionId, kind: 'error', text, at: this.now() })
  }

  /**
   * Route one approval or question from another top-level session. dot itself
   * is skipped, and so are untracked sessions when the scope is `tracked` and
   * every request whose kind the settings leave to the host (`off`);
   * skipped requests reach their own answerer unchanged.
   */
  relayRequest(input: { kind: PendingKind; sessionId: string; subject: string; detail?: string; cwd?: string; questions?: readonly PendingQuestionItem[]; signal?: AbortSignal; toolName?: string; reason?: string; arguments?: string; viaSubagent?: boolean }): RelayOutcome {
    if (this.closing || this.isDot(input.sessionId) || !this.store.dotSessionId) return { decided: 'skip' }
    const tracked = this.liveTask(input.sessionId) !== undefined
    if (!tracked && this.rules.scope === 'tracked') return { decided: 'skip' }
    const task = this.store.task(input.sessionId)
    const route = routeRequest(this.rules, input.kind)
    if (route.action === 'skip' || route.action === 'deny') return { decided: route.action }
    const run = this.store.work.sessionRun(input.sessionId)
    const runChange = run ? this.store.work.change(run.changeId) : undefined
    // A git reset/clean is dot's call only when the requester's write run lives
    // inside its own active task worktree and the command points nowhere else.
    const isolation = runChange?.isolation
    const argCwds = approvalArgCwds(input.arguments, input.cwd ?? run?.cwd)
    const ownWorktree = input.viaSubagent !== true
      && run?.access === 'write'
      && isolation?.kind === 'worktree'
      && isolation.state === 'active'
      && isSameOrChildPath(isolation.worktree, run.cwd)
      && (input.cwd === undefined || isSameOrChildPath(isolation.worktree, input.cwd))
      && argCwds !== null
      && argCwds.every(dir => isSameOrChildPath(isolation.worktree, dir))
    const notice = input.kind === 'approval'
      ? approvalNotice({
          toolName: input.toolName ?? input.subject,
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.arguments !== undefined ? { arguments: input.arguments } : {}),
          ...(input.viaSubagent ? { viaSubagent: true } : {}),
          ...(run?.access === 'read' ? { readOnly: true } : {}),
          ...(ownWorktree ? { ownWorktree: true } : {}),
        })
      : undefined
    const detail = notice?.text ?? input.detail
    const humanRequired = notice?.forced === true
    const opened = this.pending.open({
      kind: input.kind,
      sessionId: input.sessionId,
      subject: input.subject,
      ...(detail !== undefined ? { detail } : {}),
      ...(input.questions !== undefined ? { questions: input.questions } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(humanRequired ? { humanRequired: true } : {}),
      ...(notice?.truncated === true ? { truncated: true } : {}),
    })
    const where = task ? `task "${task.title}"` : `untracked session${input.cwd ? ` in ${input.cwd}` : ''}`
    const lines = [runChange ? `${opened.id} for task ${runChange.id} "${runChange.title}": ${input.kind} · "${input.subject}"` : `${opened.id} · ${input.kind} from ${where} · "${input.subject}"`]
    if (detail) lines.push(`  detail: ${notice ? detail : clip(detail, 600)}`)
    if (humanRequired && notice) lines.push(`  human-required: ${notice.reasons.join(', ')}; do not use dot_answer.`)
    if (notice && notice.cautions.length > 0) lines.push(`  caution: ${notice.cautions.join(', ')}; judge by authority and impact.`)
    if (notice?.truncated === true) lines.push(`  truncated: read the full arguments with ${TOOL.answerPending} action=read before allowing.`)
    if (input.kind === 'question' && route.action === 'human') lines.push('  The human must answer the original question in its session; do not use dot_answer.')
    for (const q of input.questions ?? []) {
      lines.push(`  [${q.id}] ${q.question}${q.options?.length ? ' options: ' + q.options.map(o => o.label).join(' | ') : ''}${q.multiSelect ? ' (multi)' : ''}`)
    }
    // Decisions live in the system prompt and agreements, never repeated in each notice.
    // An already-aborted request is not queued at all.
    if (this.pending.get(opened.id)) {
      if (input.kind === 'approval' && (input.arguments !== undefined || input.reason !== undefined || input.detail !== undefined)) {
        void this.saveApprovalDetail({
          requestId: opened.id,
          sessionId: input.sessionId,
          toolName: input.toolName ?? input.subject,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.arguments !== undefined ? { arguments: input.arguments } : input.detail !== undefined ? { arguments: input.detail } : {}),
        }).catch(() => undefined)
      }
      this.emit({ event: DOT_TRACE.approvalOpened, message: `Opened ${input.kind} ${opened.id}.`, sessionId: input.sessionId, ...(run ? { changeId: run.changeId } : {}), data: { requestId: opened.id, kind: input.kind } })
      this.notify({ sessionId: input.sessionId, kind: input.kind, requestId: opened.id, text: lines.join('\n'), at: this.now(), display: {
        ...approvalDisplay(input.arguments),
        kind: input.kind, sessionId: input.sessionId, requestId: opened.id, subject: input.subject,
        ...(task?.title ? { taskTitle: task.title } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.viaSubagent ? { viaSubagent: true } : {}),
        ...(input.questions ? { questions: input.questions.map(question => ({ id: question.id, question: question.question, ...(question.options ? { options: question.options.map(option => option.label) } : {}), ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}) })) } : {}),
      } }, true)
    }
    return { decided: 'pending', ...opened }
  }

  notify(notice: Notice, urgent = false): void {
    notice = { ...notice, display: notice.display ?? {
      kind: notice.kind, sessionId: notice.sessionId, summary: notice.text,
      ...(notice.requestId ? { requestId: notice.requestId } : {}),
    } }
    const ownedRun = this.store.work.sessionRun(notice.sessionId)
    const ownedChange = ownedRun ? this.store.work.change(ownedRun.changeId) : undefined
    const prefixed = ownedChange && notice.kind !== 'approval' && notice.kind !== 'question'
      ? `task ${ownedChange.id} "${ownedChange.title}" (${ownedChange.control.toUpperCase()}): ${notice.text}`
      : notice.text
    const enriched = ownedChange ? { ...notice, changeId: ownedChange.id, text: prefixed } : notice
    const tier = eventTier(enriched.kind, this.store.task(enriched.sessionId)?.origin)
    if (tier === 'hold') {
      this.emit({ event: DOT_TRACE.noticeHeld, message: `Held a ${enriched.kind} notice.`, ...(enriched.changeId ? { changeId: enriched.changeId } : {}), sessionId: enriched.sessionId, data: { kind: enriched.kind } })
      this.batcher.hold(enriched)
    } else if (tier === 'wake') this.batcher.push(enriched, urgent, enriched.kind === 'approval' ? this.options.approvalGraceMs ?? APPROVAL_GRACE_MS : 0)
  }

  private emit(input: DotTraceInput): void {
    if (!this.options.trace) return
    emitDotTrace(this.options.trace, input)
  }

  /** Start background GitHub CLI polling when enabled; silently degrades if `gh` is unavailable. */
  startGithubPoll(): void {
    this.githubPoller.start()
  }

  pollGithubNow(): Promise<{ readonly ok: boolean; readonly events: number }> {
    return this.githubPoller.pollNow()
  }

  githubPollStatus(): GithubPollStatusView {
    return this.githubPoller.status()
  }

  testGithubPollConnection(override?: { readonly ghPath?: string; readonly hostname?: string; readonly repos?: readonly string[] }): Promise<GithubPollTestResult> {
    return this.githubPoller.testConnection(override)
  }

  recordGithubEcho(repo: string, id: string, kind: 'issue_comment' | 'review_comment' | 'review'): Promise<void> {
    return this.githubPollCursorStore.recordEcho(repo, { id, kind, sentAt: this.now() }, this.now())
  }

  shouldAcceptWebhookDelivery(repo: string, receivedAt: number): boolean {
    const norm = normalizeGithubRepo(repo)
    if (!norm) return true
    const settings = effectiveGithubPollSettings(this.store.settings)
    if (settings.repos.includes(norm)) return false
    const state = this.githubPollCursorStore.getRepoState(norm)
    if (state?.lastMode === 'poll' && state.lastDeliveredAt !== undefined && receivedAt < state.lastDeliveredAt) {
      return false
    }
    return true
  }

  private emitClosureResultNotice(
    change: ChangeRecord,
    detail: { readonly ref: string; readonly outcome: 'merged' | 'closed'; readonly title?: string; readonly url?: string; readonly at: number },
  ): void {
    const closureKey = `${change.id}:${detail.ref}:${detail.outcome}`
    if (this.emittedClosures.has(closureKey)) return
    this.emittedClosures.add(closureKey)
    const sessionId = this.store.dotSessionId ?? ''
    const urlPart = detail.url ? ` (${detail.url})` : ''
    const text = `PR ${detail.ref} was ${detail.outcome}${urlPart}; ready for closure acceptance check — inspect checks/evidence and close out with dot_task action=closeout.`
    this.notify({
      sessionId,
      kind: 'result',
      changeId: change.id,
      wakeKey: closureKey,
      at: detail.at,
      text,
      display: { kind: 'result', sessionId, taskTitle: change.title, subject: detail.ref, summary: text },
    })
    this.emit({
      event: DOT_TRACE.githubPollClosure,
      message: `PR ${detail.ref} ${detail.outcome} flagged ${change.id} for closure check.`,
      changeId: change.id,
      data: { ref: detail.ref, outcome: detail.outcome },
    })
  }

  /**
   * One external event for dot's inbox. Dedupe, subject coalescing and the
   * durable row all live in the ledger; this only queues the notice the
   * batcher will deliver. It never opens or resumes a session.
   */
  async submitInbox(input: InboxEventInput): Promise<InboxSubmitResult> {
    const isWebhookGithub = input.source === 'github' && input.originSource !== 'github-poll'
    const repo = input.source === 'github' ? (input.subject.split(/[#@:]/)[0] ?? '').trim().toLowerCase() : ''
    if (isWebhookGithub && repo && !this.shouldAcceptWebhookDelivery(repo, input.receivedAt || 0)) {
      return 'duplicate'
    }
    const done = await this.serial(async () => {
      const preview = this.inbox.peek(input, this.now())
      if (!preview.record) return preview
      // Link updates land BEFORE the inbox record: a failing links table throws
      // here, so a webhook retry finds no stored record and redoes both steps.
      await this.applyInboxLinks(preview.record)
      return this.inbox.submit(input, this.now())
    })
    // queueInboxNotice itself skips a record that already has a queued notice.
    if (done.record) this.queueInboxNotice(done.record)
    if (done.record && isWebhookGithub && repo) {
      await this.githubPollCursorStore.recordDelivery(repo, 'webhook', input.receivedAt || this.now(), input.deliveryId, this.now())
      const closureMatch = /^pull_request\.(merged|closed)$/.exec(input.type)
      const numMatch = /^([^#\s]+)#(\d+)$/.exec(input.subject)
      if (closureMatch && numMatch) {
        await observePullClosure({
          links: this.store.links,
          putLink: link => this.store.putLink(link),
          change: id => this.store.work.change(id),
          runsForChange: changeId => this.store.work.listRuns().filter(run => run.changeId === changeId),
          markClosureReady: (changeId, detail) => this.store.work.markClosureReady(changeId, detail),
          emitResultNotice: (change, detail) => this.emitClosureResultNotice(change, detail),
        }, {
          repo,
          number: Number(numMatch[2]),
          outcome: closureMatch[1] as 'merged' | 'closed',
          title: input.title,
          ...(input.url ? { url: input.url } : {}),
          at: input.receivedAt || this.now(),
          event: done.record,
        })
      }
    }
    return done.result
  }

  /** Fold one stored inbox record into every link its subject binds to. */
  private async applyInboxLinks(record: InboxRecord): Promise<void> {
    for (const link of this.store.links) {
      if (!linkMatchesSubject(link, record)) continue
      const next = applyLinkEvent(link, record, this.now())
      if (next) await this.store.putLink(next)
    }
  }

  /** A fresh link still learns from inbox rows stored before it existed (a pull_request event may predate the run report). */
  private learnFromStoredInbox(link: TaskLink): TaskLink {
    let next = link
    for (const record of this.inbox.list()) {
      if (!linkMatchesSubject(next, record)) continue
      next = applyLinkEvent(next, record, this.now()) ?? next
    }
    return next
  }

  /**
   * The one trusted line an inbox notice earns per linked, still-open change.
   * It sits outside the untrusted fence so payload text cannot forge it, and
   * it is rebuilt at delivery so the shown task state is current.
   */
  private linkedTaskLines(record: InboxRecord): string[] {
    const seen = new Set<string>()
    const lines: string[] = []
    for (const link of this.store.links) {
      if (seen.has(link.changeId) || !linkMatchesSubject(link, record)) continue
      const change = this.store.work.change(link.changeId)
      if (!change) continue
      if (changeIsTerminal(change, this.store.work.listRuns().filter(run => run.changeId === change.id))) continue
      seen.add(change.id)
      const status = this.store.work.workView(change.id)?.status ?? 'waiting'
      const title = change.title.replace(/\s+/g, ' ').replace(/"/g, "'").trim()
      lines.push(`Linked task: ${change.id} "${title}" (${status})`)
    }
    return lines
  }

  private inboxNoticeFor(record: InboxRecord): { readonly text: string; readonly display: string } {
    const notice = inboxNotice(record)
    const linked = this.linkedTaskLines(record)
    if (linked.length === 0) return notice
    const extra = linked.join('\n')
    return { text: `${notice.text}\n${extra}`, display: `${notice.display}\n${extra}` }
  }

  /** PR/issue URLs quoted in a finished report become auto links on its change. */
  private autoLinkReport(changeId: string, report: string): void {
    for (const target of scanReportLinks(report)) {
      const link = this.learnFromStoredInbox(makeTaskLink(changeId, target, 'auto', this.now()))
      if (this.store.link(link.id)) continue
      void this.store.putLink(link).catch(() => undefined)
    }
  }

  flushNotices(): Promise<void> { return this.batcher.drain() }

  dispose(): Promise<void> {
    this.releaseChildSeals()
    if (this.disposal) return this.disposal
    this.closing = true
    this.githubPoller.dispose()
    this.quietWaits.abortAll(this.now(), 'dispose')
    try { this.backgroundJobsUnsub?.() } catch { /* best effort */ }
    this.backgroundJobsUnsub = undefined
    this.backgroundJobsSubscribedTo = undefined
    this.backgroundJobsListeners.clear()
    this.retryHealth.clearAll()
    this.sessionEventListeners.clear()
    this.selfDeployAbort.abort()
    this.batcher.dispose()
    this.idleChecker.cancel()
    this.cancelKeepalive()
    if (this.usageHandle !== undefined) this.timer.clear(this.usageHandle)
    this.reminders.dispose()
    this.updates.dispose()
    this.pending.dispose()
    this.disposal = (async () => {
      await this.selfDeployChain
      await this.reflection.dispose()
      await this.lane
      await Promise.allSettled([...this.inFlight])
      await this.ensuring?.catch(() => undefined)
      await this.usagePass
      await this.knowledgeLane
      await this.store.flush()
    })()
    return this.disposal
  }

  /** Due reminders reach the segment dot is in now, whichever one they were set in. */
  private async remind(text: string): Promise<void> {
    return this.serial(async () => {
      const dot = await this.ready()
      const notices = this.liveNotices(this.batcher.take())
      // Keep the reminder head first so the panel still draws a reminder.
      const message = notices.length > 0 ? `${text}\n\n${this.formatQueuedNotices(notices)}` : text
      const reminder = parseNotice(text)
      const display = formatNoticeDisplay(notices)
      try { await this.host.relay(dot, dot, message, undefined, undefined, { ...reminder, entries: [...reminder.entries, ...display.entries] }) } catch (error) {
        this.batcher.restore(this.liveNotices(notices))
        throw error
      }
      await this.ackInboxWakes(notices).catch(error => this.options.log?.(`dsh-dot: inbox event was not marked delivered: ${messageOf(error)}`))
      this.recoverInbox()
    })
  }

  private async deliver(items: readonly Notice[]): Promise<void> {
    if (!this.store.dotSessionId) return
    const initial = this.liveNotices(items)
    if (initial.length < items.length) this.emit({ event: DOT_TRACE.noticeSuppressed, message: 'A notice was not delivered.', data: { reason: 'grace', dropped: items.length - initial.length } })
    if (initial.length === 0) return
    await this.serial(async () => {
      if (this.liveNotices(initial).length === 0) return
      const dot = await this.ready()
      const live = this.liveNotices(initial)
      if (live.length === 0) return
      if (this.host.isRunning(dot)) throw new Error('dot is running')
      const turnOrigin = this.inboxTurnOrigin(live)
      this.activeTurnOrigin = turnOrigin
      try {
        await this.host.relay(dot, live[0]!.sessionId, this.formatQueuedNotices(live), undefined, undefined, formatNoticeDisplay(live))
      } catch (error) {
        this.activeTurnOrigin = undefined
        throw error
      }
      await this.ackDecisionWakes(live).catch(error => this.options.log?.(`dsh-dot: decision wake was not marked: ${messageOf(error)}`))
      await this.ackInboxWakes(live).catch(error => this.options.log?.(`dsh-dot: inbox event was not marked delivered: ${messageOf(error)}`))
      // Inbox records skipped by the per-batch cap get queued for the next flush.
      this.recoverInbox()
      this.emit({ event: DOT_TRACE.noticeDelivered, message: `Delivered ${live.length} notice(s).`, sessionId: dot, data: { count: live.length, kinds: live.map(item => item.kind).join(',') } })
    })
  }

  private inboxTurnOrigin(items: readonly Notice[]): RunOrigin | undefined {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!
      if (item.kind !== 'inbox' || !item.wakeKey) continue
      const record = this.inbox.get(item.wakeKey)
      if (!record) continue
      if (record.originSource === 'github-poll' || record.originSource === 'inbox-github') {
        return {
          strength: 'explicit',
          source: record.originSource,
          ...(record.actor ? { sender: record.actor } : {}),
        }
      }
      if (record.source === 'github') {
        const isPoll = record.deliveryIds.some(id => id.startsWith('gh-poll:'))
        return {
          strength: 'explicit',
          source: isPoll ? 'github-poll' : 'inbox-github',
          ...(record.actor ? { sender: record.actor } : {}),
        }
      }
    }
    return undefined
  }

  private formatQueuedNotices(items: readonly Notice[]): string {
    return formatNotices(items)
  }

  private liveNotices(items: readonly Notice[]): Notice[] {
    const live: Notice[] = []
    const inboxSeen = new Set<string>()
    let inboxKept = 0
    for (const item of items) {
      if (item.requestId !== undefined && this.pending.get(item.requestId) === undefined) continue
      if (item.kind === 'inbox') {
        // Recovery can queue a second notice for one pending record; first copy wins.
        if (item.wakeKey !== undefined) {
          if (inboxSeen.has(item.wakeKey)) continue
          inboxSeen.add(item.wakeKey)
        }
        // The notice text is rebuilt here so a merged record shows its latest event.
        const record = item.wakeKey === undefined ? undefined : this.inbox.get(item.wakeKey)
        // Skipped records stay pending and are re-queued after this batch lands.
        if (record === undefined || record.status !== 'pending' || inboxKept >= INBOX_NOTICES_PER_DELIVERY) continue
        inboxKept += 1
        const sessionId = this.store.dotSessionId ?? item.sessionId
        const notice = this.inboxNoticeFor(record)
        live.push({ ...item, sessionId, text: notice.text, display: { kind: 'inbox', sessionId, summary: notice.display } })
        continue
      }
      live.push(item)
    }
    return live
  }

  /** Deliveries and segment changes run one at a time, so a message never lands in a segment that is being left. */
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new DotError('dot/disposed', 'dot is shutting down'))
    const run = Promise.resolve().then(() => { this.assertOpen(); return work() })
    this.inFlight.add(run)
    void run.then(() => this.inFlight.delete(run), () => this.inFlight.delete(run))
    return run
  }

  private assertOpen(): void {
    if (this.closing) throw new DotError('dot/disposed', 'dot is shutting down')
  }

  createWorkChange(input: Parameters<DotStore['work']['createChange']>[0]) { return this.store.work.createChange(input) }
  reviseWorkChange(changeId: string, patch: Parameters<DotStore['work']['reviseChange']>[1]) { return this.store.work.reviseChange(changeId, patch) }
  reserveWorkRun(input: Parameters<DotStore['work']['reserveRun']>[0]) { return this.store.work.reserveRun(input) }
  publishWorkBaseline(runId: string, expectedRevision: number, artifactRef: string, at?: number) {
    return this.store.work.publishBaseline(runId, expectedRevision, artifactRef, at ?? this.now(), run => this.confirmBaseline(run, artifactRef))
  }

  /**
   * Host calls stay off the service lane. The work book locks only the record
   * commit; a lost receipt or a stop that is still settling does not block
   * unrelated changes.
   */
  private runHost(runId?: string, mode: 'mutate' | 'verify' = 'mutate', overridePermission?: TaskPermission) {
    const run = runId ? this.store.work.run(runId) : undefined
    const pinned = overridePermission ?? run?.taskPermission
    if (mode === 'verify') {
      if (pinned) return bindRunSession(this.host, pinned, { verifyOnly: true, pinned: true })
      return bindRunSession(this.host, this.store.settings.taskPermission, { verifyOnly: true })
    }
    return bindRunSession(this.host, pinned ?? this.store.settings.taskPermission)
  }

  /** Permission Dorothy intends on this session's run (`'read-only'` for read-only runs), if any. */
  runTaskPermission(sessionId: string): IntendedRunPermission | undefined {
    const run = this.store.work.sessionRun(sessionId)
    if (!run) return undefined
    if (run.access === 'read' || run.kind === 'review' || !scopeWrites(run.writeScope)) return 'read-only'
    return run.taskPermission
  }

  launchWorkRun(runId: string, text: string, preset?: string, model?: { readonly provider: string; readonly model: string }) {
    return this.launchAndRemember(runId, text, preset, model)
  }

  private effectiveWritePermission(requested: TaskPermission = this.store.settings.taskPermission): TaskPermission {
    const resolved = this.host.effectiveTaskPermission?.(requested)
    return resolved === 'workspace-write' || resolved === 'danger-full-access' || resolved === 'safe-auto' || resolved === 'auto'
      ? resolved
      : requested
  }

  private async launchAndRemember(runId: string, text: string, preset?: string, model?: { readonly provider: string; readonly model: string }) {
    const existing = this.store.work.run(runId)
    const isWrite = existing !== undefined && (existing.access === 'write' || (existing.access === undefined && existing.kind !== 'review' && scopeWrites(existing.writeScope)))
    const targetPermission = isWrite
      ? existing.taskPermission ?? this.effectiveWritePermission(this.store.settings.taskPermission)
      : undefined
    const launched = await launchReservedRun(
      this.store.work,
      this.runHost(runId, 'mutate', targetPermission),
      runId,
      text,
      preset,
      model,
      async () => {
        if (targetPermission) await this.store.work.pinTaskPermission(runId, targetPermission)
        await this.rememberRun(runId)
      },
    )
    if (launched.ok) {
      if (targetPermission) await this.store.work.pinTaskPermission(runId, targetPermission)
      await this.rememberRun(runId)
    }
    return launched
  }

  /** The existing ledger is how a run session is owned, notified and approved. It does not create a board row of its own. */
  private async rememberRun(runId: string): Promise<void> {
    const run = this.store.work.run(runId)
    const sessionId = run?.sessionId
    if (!run || !sessionId || run.creation !== 'confirmed' || sessionId !== run.requestedSessionId) return
    const change = this.store.work.change(run.changeId)
    await this.store.track({
      sessionId, origin: 'started',
      title: change ? runTitle(change.title, `${run.changeId}/${run.id}`) : run.id,
      goal: `${run.changeId} ${run.id} input ${run.inputRef}@${run.inputRevision}`,
      cwd: onDiskPath(run.cwd), at: this.now(),
    })
  }
  supplementWorkRun(runId: string, text: string, senderId: string, expected: { readonly inputRef: string; readonly inputRevision: number }) {
    const run = this.store.work.run(runId)
    this.abortQuietWait(run?.sessionId ?? run?.requestedSessionId, 'supplement', true)
    return supplementRun(this.store.work, this.runHost(runId, 'verify'), runId, text, senderId, this.now(), expected)
  }

  /** One context delivery on the named run. The work book keeps the input, the sender and any unconfirmed delivery. */
  private async supplementFromTool(args: Record<string, unknown>): Promise<string> {
    const text = typeof args.message === 'string' ? args.message : ''
    const runId = typeof args.run_id === 'string' ? args.run_id : ''
    const sole = this.soleInput(this.store.work.run(runId)?.changeId)
    const inputRef = typeof args.expected_input_ref === 'string' && args.expected_input_ref ? args.expected_input_ref : sole?.inputRef ?? ''
    const inputRevision = typeof args.expected_input_revision === 'number' ? args.expected_input_revision : sole?.inputRevision
    if (!runId || !text.trim() || !inputRef || inputRevision === undefined || !Number.isInteger(inputRevision)) {
      throw new DotError('dot/invalid', 'supplement requires run_id, message, expected_input_ref and expected_input_revision')
    }
    const namedChange = typeof args.task_id === 'string' ? args.task_id : ''
    const current = this.store.work.run(runId)
    if (namedChange && current && namedChange !== current.changeId) throw new DotError('dot/invalid', `${runId} is not a run of ${namedChange}`)
    const senderId = this.store.dotSessionId
    if (!senderId) throw new DotError('dot/not-ready', 'your conversation is not ready yet')
    const rendered = renderSupplement({
      changeId: current?.changeId ?? namedChange,
      inputRef, inputRevision, runId, message: text,
    })
    const sent = await this.supplementWorkRun(runId, rendered, senderId, { inputRef, inputRevision })
    if (!sent.ok) throw new DotError(sent.code === 'unknown' ? 'dot/unknown' : sent.code === 'stale' ? 'dot/stale' : 'dot/invalid', sent.message)
    const delivery = [...(this.store.work.run(runId)?.deliveries ?? [])].reverse().find(item => item.kind !== 'initial' && item.contentRef === rendered && item.source === senderId)
    return `supplemented ${runId} delivery ${delivery?.id ?? 'recorded'} ${delivery?.status ?? sent.phase} for ${inputRef}@${inputRevision}`
  }
  async cancelWorkChange(changeId: string) {
    for (const run of this.store.work.listRuns()) {
      if (run.changeId === changeId && !['completed', 'failed', 'stopped'].includes(run.phase)) {
        this.abortQuietWait(run.sessionId ?? run.requestedSessionId, 'cancel', true)
      }
    }
    const result = await cancelWork(this.store.work, this.runHost(), changeId, this.now())
    if (result.ok) {
      const isolation = this.store.work.change(changeId)?.isolation
      if (isolation?.kind === 'worktree') {
        await removeTaskWorktree({ repoRoot: isolation.repoRoot, worktree: isolation.worktree, branch: isolation.branch, baseSha: isolation.baseSha }, this.git()).catch(() => undefined)
      }
    }
    return result
  }
  async finishWorkRun(runId: string, phase: 'completed' | 'failed') {
    const run = this.store.work.run(runId)
    this.abortQuietWait(run?.sessionId ?? run?.requestedSessionId, 'finish', true)
    const finished = await finishWork(this.store.work, this.runHost(), runId, phase, this.now())
    if (finished.ok) await this.captureRunReport(runId)
    return finished
  }
  observeWorkRun(runId: string) {
    return observeRun(this.store.work, this.runHost(), runId, this.now())
  }
  reconcileWorkRun(runId: string) {
    return reconcileRun(this.store.work, this.runHost(), runId, this.now())
  }
  workBoard(changeId: string) {
    const item = this.store.work.workView(changeId)
    return item ? this.withRetryStatus(item) : undefined
  }
  /** Board-projection rows for work.list: the same view plus link chips the board shows. */
  workList() {
    return this.store.work.listChanges()
      .map(change => this.store.workViewWithLinks(change.id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map(item => this.withRetryStatus(item))
  }
  recordWorkVerification(changeId: string, checks: Parameters<DotStore['work']['recordVerification']>[1], runIds: readonly string[], detail?: Parameters<DotStore['work']['recordVerification']>[4]) {
    return this.store.work.recordVerification(changeId, checks, runIds, this.now(), detail)
  }
  acceptWork(changeId: string, verificationId: string, expectedInputRef: string, expectedSubjectKey: string, source = 'user', human?: { readonly expectedInputRevision: number; readonly expectedVerificationId: string }) {
    return this.store.work.accept(changeId, verificationId, expectedInputRef, expectedSubjectKey, source, this.now(), human, this.subjectLook())
  }
  async rejectWork(changeId: string, reviewRunId: string, expectedInputRevision: number) {
    const change = this.store.work.change(changeId)
    if (!change) return { ok: false as const, code: 'missing' as const, message: `unknown change ${changeId}` }
    if (change.closeout) return { ok: false as const, code: 'closed' as const, message: `${changeId} is already closed out` }
    if (expectedInputRevision !== change.currentRevision) return { ok: false as const, code: 'stale' as const, message: 'the rejection is for an older version' }
    const review = this.store.work.run(reviewRunId)
    if (!review || review.changeId !== changeId || review.kind !== 'review') return { ok: false as const, code: 'missing' as const, message: `unknown review ${reviewRunId}` }
    const held = await this.holdWorkReview(reviewRunId)
    if (!('id' in held)) return held
    return this.store.work.reopenAfterReview(changeId, reviewRunId, this.now(), expectedInputRevision)
  }
  resumeWorkCloseout(changeId: string) { return this.store.work.resumeCloseout(changeId, this.now()) }

  /** Human-initiated escape hatch for a cancelled Change whose runs are wedged in settling/unknown/rejected. */
  async forceReleaseWork(changeId: string) {
    // Refuse before touching the host: a release that is going to be rejected must
    // not stop the sessions an open change is still working in.
    const change = this.store.work.change(changeId)
    if (!change) return { ok: false as const, code: 'missing' as const, message: `unknown change ${changeId}` }
    if (change.control !== 'cancelled') {
      return { ok: false as const, code: 'invalid' as const, message: `cancel ${changeId} before force-releasing its runs` }
    }
    const runs = this.store.work.listRuns().filter(run => run.changeId === changeId && !['completed', 'failed', 'stopped'].includes(run.phase))
    for (const run of runs) {
      this.abortQuietWait(run.sessionId ?? run.requestedSessionId, 'force-release', true)
      if (run.creation === 'confirmed' && run.sessionId) {
        try { await this.runHost().stop(run.sessionId) } catch { /* best-effort before local lock release */ }
      }
    }
    return this.store.work.forceReleaseChange(changeId, this.now())
  }

  /**
   * Human-only integration of an accepted isolated change. Merging writes to
   * the human's checkout, so this is reachable only from the panel RPC — never
   * through a dot tool action, and accepting a delivery does not imply it.
   */
  async integrateWork(changeId: string, mode: 'merge' | 'keep' | 'discard'): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly code: 'missing' | 'invalid' | 'conflict' | 'failed'; readonly message: string; readonly conflicts?: readonly string[] }> {
    const change = this.store.work.change(changeId)
    if (!change) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
    const isolation = change.isolation
    if (isolation?.kind !== 'worktree') return { ok: false, code: 'invalid', message: `${changeId} is not an isolated change` }
    if (isolation.state !== 'active') return { ok: false, code: 'invalid', message: `${changeId} was already ${isolation.state}` }
    if (mode === 'merge' && isolation.base !== undefined) return { ok: false, code: 'invalid', message: `${changeId} was cut from ${isolation.base.ref}, not your checkout; keep the branch and integrate it yourself` }
    const view = this.store.work.workView(changeId)
    if (!change.closeout || view?.status !== 'done') return { ok: false, code: 'invalid', message: `${changeId} is not accepted yet` }
    const git = this.git()
    const mark = (patch: Partial<Omit<TaskIsolation, 'kind' | 'repoRoot' | 'worktree' | 'branch' | 'baseSha'>> & { commitSha?: string }) =>
      this.store.work.updateIsolation(changeId, patch, this.now())
    if (mode === 'discard') {
      await removeTaskWorktree({ repoRoot: isolation.repoRoot, worktree: isolation.worktree, branch: isolation.branch, force: true }, git)
      await mark({ state: 'discarded' })
      return this.integrated(change, `discarded ${isolation.branch}`)
    }
    // keep/merge commit exactly the accepted delivery: each delivered path is
    // re-verified against its snapshot hash, and nothing extra may be dirty.
    const subject = this.store.work.verification(change.closeout.verificationId)?.subject
    if (!subject) return { ok: false, code: 'invalid', message: `${changeId} has no delivery subject to integrate` }
    // Subject paths are relative to the change cwd; a task created in a repo
    // subdir maps to <worktree>/<sub>, so prefix them for git pathspecs.
    // The stored cwd is case-folded on win32, so take the on-disk spelling
    // from realpath; git pathspecs are case-sensitive.
    if (!existsSync(change.cwd)) return { ok: false, code: 'failed', message: `the task worktree ${isolation.worktree} is missing` }
    const inside = relative(realpathSync.native(isolation.worktree), realpathSync.native(change.cwd))
    const subdir = inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? `${inside.split(sep).join('/')}/` : ''
    const delivered = subject.changes.map(row => ({ ...row, path: `${subdir}${row.path}` }))
    let commitSha: string | undefined
    try {
      const committed = await commitDelivery({
        worktree: isolation.worktree,
        files: delivered,
        baseSha: isolation.baseSha,
        branch: isolation.branch,
        message: `${change.title}\n\nDorothy task ${changeId}`,
      }, git)
      if (!committed.ok) return { ok: false, code: 'failed', message: committed.message }
      commitSha = committed.commitSha
    } catch (error) {
      return { ok: false, code: 'failed', message: `commit in the task worktree failed: ${messageOf(error)}` }
    }
    const withSha = (patch: Parameters<typeof mark>[0]) => mark({ ...(commitSha !== undefined ? { commitSha } : {}), ...patch })
    if (mode === 'keep') {
      await removeTaskWorktree({ repoRoot: isolation.repoRoot, worktree: isolation.worktree }, git)
      await withSha({ state: 'committed' })
      return this.integrated(change, `kept branch ${isolation.branch}; the worktree directory was removed`)
    }
    const merged = await mergeInto({
      repoRoot: isolation.repoRoot, branch: isolation.branch,
      deliveredPaths: delivered.map(row => row.path),
      addedPaths: delivered.filter(row => row.kind === 'added').map(row => row.path),
    }, git)
    if (!merged.ok) {
      return { ok: false, code: merged.conflicts ? 'conflict' : 'invalid', message: merged.message ?? 'merge failed', ...(merged.conflicts ? { conflicts: merged.conflicts } : {}) }
    }
    await withSha({ state: 'merged', ...(merged.mergedInto ? { mergedInto: merged.mergedInto } : {}) })
    // The branch is merged now, so -d succeeds and the worktree goes with it.
    await removeTaskWorktree({ repoRoot: isolation.repoRoot, worktree: isolation.worktree, branch: isolation.branch }, git)
    let deploySha = commitSha
    try {
      const head = await git(['rev-parse', 'HEAD'], isolation.repoRoot)
      if (head) deploySha = head
    } catch { /* keep the worktree commit when HEAD cannot be read */ }
    const deploying = this.queueSelfDeploy(isolation, deploySha, change)
    return this.integrated(change, `merged ${isolation.branch} into ${merged.mergedInto}${deploying ? '; dot is rebuilding in the background, a notice follows when it finishes' : ''}`)
  }

  /**
   * A merge landing in dot's own linked checkout is a self-upgrade. The build
   * can take minutes, so it must not hold the panel's work.integrate RPC: the
   * merge answers at once and the deploy runs behind selfDeployChain — one at
   * a time, so two merges never build concurrently — reporting its outcome to
   * dot's session through the same held-notice path integrated() uses.
   */
  private selfDeployChain: Promise<void> = Promise.resolve()
  private selfDeployAbort = new AbortController()

  /** Specs await queued self-upgrade deploys here; production never waits on them. */
  selfDeploysSettled(): Promise<void> { return this.selfDeployChain }

  private queueSelfDeploy(isolation: TaskIsolation, commitSha: string | undefined, change: ChangeRecord): boolean {
    const self = this.options.selfInstall
    if (self?.mode !== 'linked' || !this.sameRealPath(isolation.repoRoot, self.root)) return false
    if (this.closing || this.selfDeployAbort.signal.aborted) return false
    const root = self.root
    const sha = commitSha ?? isolation.baseSha
    const signal = this.selfDeployAbort.signal
    this.selfDeployChain = this.selfDeployChain.then(async () => {
      if (this.closing || signal.aborted) return
      const text = await this.deploySelfBuild(root, sha, signal)
      if (text === undefined) return
      const dot = this.store.dotSessionId
      if (dot) this.notify({ sessionId: dot, kind: 'turn-end', text: `Isolated task ${change.id} "${change.title}": ${text}.`, at: this.now() })
    }).catch(error => this.options.log?.(`dsh-dot: self-upgrade deploy failed: ${messageOf(error)}`))
    return true
  }

  /**
   * Back the deployed lib up, rebuild it in place and roll the backup back on
   * a failed build. A dirty live checkout ships whatever is uncommitted, so it
   * is never built — the human commits or stashes first. The persisted marker
   * lets the next start report whether the running bundle is the deployed one;
   * lastBackup (the lib copy itself) stays for the panel's restore hint.
   */
  private async deploySelfBuild(root: string, sha: string, signal?: AbortSignal): Promise<string | undefined> {
    // `git diff --quiet HEAD` semantics: staged or unstaged tracked changes
    // count as dirty; untracked files and the gitignored lib/ do not.
    if (signal?.aborted) return undefined
    const dirty = await this.git()(['diff', '--quiet', 'HEAD'], root).then(() => false, () => true)
    if (dirty) {
      return `merged, but dot was not rebuilt because ${root} has uncommitted tracked changes that would ship in the build. Commit or stash them, run pnpm build there, then restart DeepSeek Harness.`
    }
    const backupDir = join(this.options.homeDir, 'self-upgrade', `${Math.floor(this.now())}-${sha.slice(0, 8)}`)
    try {
      cpSync(join(root, 'lib'), join(backupDir, 'lib'), { recursive: true })
    } catch (error) {
      return `merged, but the previous lib could not be backed up so dot was not rebuilt: ${messageOf(error)}`
    }
    const build = await (this.options.selfBuild ?? defaultSelfBuild)(root, signal).catch(error => ({ ok: false as const, output: messageOf(error) }))
    if (!build.ok) {
      try {
        rmSync(join(root, 'lib'), { recursive: true, force: true })
        cpSync(join(backupDir, 'lib'), join(root, 'lib'), { recursive: true })
        try { rmSync(backupDir, { recursive: true, force: true }) } catch { /* best-effort drop of the failed attempt */ }
        return `merged, but the rebuild failed and the previous lib was restored from ${join(backupDir, 'lib')}. Build output: ${build.output}`
      } catch (error) {
        return `merged, but the rebuild failed and the previous lib could not be restored from ${join(backupDir, 'lib')}: ${messageOf(error)}. Build output: ${build.output}`
      }
    }
    await this.store.setSelfUpgrade({ at: this.now(), commitSha: sha, backupDir, libHash: libHashOf(root) ?? '' })
    await this.store.setSelfBackup({ dir: join(backupDir, 'lib'), lib: join(root, 'lib') })
    this.pruneSelfUpgradeBackups()
    return `merged and dot was rebuilt; the previous lib is kept at ${join(backupDir, 'lib')}. Restart DeepSeek Harness to load it.`
  }

  private sameRealPath(left: string, right: string): boolean {
    try {
      return canonicalPath(realpathSync.native(left)) === canonicalPath(realpathSync.native(right))
    } catch {
      return false
    }
  }

  /** Keep only the newest backup directories under `<homeDir>/self-upgrade`. */
  private pruneSelfUpgradeBackups(keep = 3): void {
    const root = join(this.options.homeDir, 'self-upgrade')
    const protectedDir = this.store.selfBackup?.dir ? dirname(this.store.selfBackup.dir) : undefined
    try {
      const rows = readdirSync(root, { withFileTypes: true })
        .filter(row => row.isDirectory())
        .map(row => ({ path: join(root, row.name), at: statSync(join(root, row.name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
      for (const row of rows.slice(keep)) {
        if (protectedDir && canonicalPath(row.path) === canonicalPath(protectedDir)) continue
        rmSync(row.path, { recursive: true, force: true })
      }
    } catch { /* pruning is best effort */ }
  }

  /** The integration result reaches dot as a held notice; the board row shows the same state. */
  private integrated(change: ChangeRecord, text: string): { readonly ok: true; readonly text: string } {
    if (this.store.dotSessionId) {
      this.notify({ sessionId: this.store.dotSessionId, kind: 'turn-end', text: `Isolated task ${change.id} "${change.title}": ${text}.`, at: this.now() })
    }
    return { ok: true, text }
  }

  private async pruneWorkArtifactsIfNeeded(maxKeep?: number): Promise<void> {
    try {
      // The runs of a pruned change are deleted and their sessions' events are
      // lost; capture their cost first. This cannot happen inside the prune
      // callback: it holds the book's exclusive lane, which recordRunUsage
      // also needs.
      const runs = this.store.work.listRuns()
      const terminal = this.store.work.listChanges()
        .filter(change => changeIsTerminal(change, runs.filter(run => run.changeId === change.id)))
        .sort((a, b) => a.updatedAt - b.updatedAt || Number(a.id.slice(2)) - Number(b.id.slice(2)))
      const excess = Math.max(0, terminal.length - Math.max(1, maxKeep ?? MAX_COMPLETED_CHANGES))
      for (const change of terminal.slice(0, excess)) {
        for (const run of runs.filter(row => row.changeId === change.id)) await this.captureRunUsageFor(run.id)
      }
      const { prunedChanges, keptArtifacts } = await this.store.pruneWorkHistory(maxKeep, async change => {
        // A leftover isolated worktree goes with its change; a branch carrying
        // commits stays (removeTaskWorktree only -d deletes, which git refuses
        // for unmerged work). A pruned change takes its links with it.
        const isolation = change.isolation
        if (isolation?.kind === 'worktree') {
          await removeTaskWorktree({ repoRoot: isolation.repoRoot, worktree: isolation.worktree, branch: isolation.branch, baseSha: isolation.baseSha }, this.git()).catch(() => undefined)
        }
        await this.store.deleteLinksFor(change.id)
        // A tagged change records its terminal outcome on the recipe before its
        // rows are deleted; a removed recipe or an untagged change records none.
        const tag = change.recipe
        const recipe = tag ? this.taggedRecipe(change) : undefined
        if (!tag || !recipe) return
        await this.store.putRecipe(upsertRecipeOutcome(recipe, {
          changeId: change.id, title: change.title, revision: tag.revision,
          result: change.closeout ? 'accepted' : 'cancelled',
          failedRounds: this.store.work.failedRoundsAcrossInputs(change.id),
          ...runCostTotals(this.store.work.listRuns().filter(run => run.changeId === change.id)),
          at: change.updatedAt,
        }))
      }, this.now())
      if (prunedChanges.length > 0) {
        pruneSnapshots(this.options.homeDir, keptArtifacts)
        await this.checkRecipeRegressions()
      }
    } catch { /* best-effort background retention cleanup */ }
  }

  /**
   * Capture the run's live scope and publish it as the baseline.
   * Relative paths resolve against the run's workspace root, not the process
   * working directory. A snapshot whose manifest already exists is left in place;
   * the next attempt uses a new id. A save that stopped before the manifest is
   * completed in that same directory.
   * `failOn` is the snapshot body's failure injection. Production callers omit it.
   */
  async captureWorkBaseline(runId: string, attempt?: { readonly failOn?: string }) {
    const run = this.store.work.run(runId)
    if (!run) throw new DotError('dot/invalid', `unknown run ${runId}`)
    if (!scopeWrites(run.writeScope)) throw new DotError('dot/invalid', `${runId} does not write, so it has no baseline`)
    const root = run.workspaceRoot
    const scopes = run.writeScope.kind === 'workspace-exclusive'
      ? [{ path: root, type: 'directory' as const }]
      : run.writeScope.paths
    if (scopes.length === 0) throw new DotError('dot/invalid', `${runId} has no path to capture`)
    if (run.writeScope.kind !== 'workspace-exclusive') {
      for (const scope of scopes) {
        const rel = relativePath(root, this.scopeTarget(root, scope.path))
        const cover = defaultIgnoreCover(rel, process.platform, scope.type)
        if (cover) throw new DotError('dot/invalid', `explicit ${scope.type} target ${rel} is a default-ignored path/file (${cover}) and is not supported by delivery capture`)
      }
    }
    const files: SnapshotSource[] = []
    const exclusions: SnapshotExclusion[] = []
    const seen = new Set<string>()
    const seenExclusion = new Set<string>()
    for (const scope of scopes) {
      const absolute = this.scopeTarget(root, scope.path)
      let captured: Awaited<ReturnType<typeof captureScopeAsync>>
      try { captured = await captureScopeAsync(root, absolute, scope.type) } catch (error) {
        throw new DotError('dot/invalid', error instanceof Error ? error.message : 'scope could not be read')
      }
      for (const file of captured.files) {
        const key = foldRel(file.path)
        if (seen.has(key)) continue
        seen.add(key)
        files.push(file)
      }
      for (const item of captured.exclusions) {
        const key = `${foldRel(item.path)}|${item.reason}`
        if (seenExclusion.has(key)) continue
        seenExclusion.add(key)
        exclusions.push(item)
      }
    }
    const id = this.nextBaselineArtifact(run.id, this.store.work.revision)
    saveSnapshot(join(this.options.homeDir, 'artifacts', id), files, attempt?.failOn, { root, empty: files.length === 0, exclusions })
    return this.publishWorkBaseline(runId, this.store.work.revision, id)
  }

  /** Save the current workspace as the delivery subject and name what changed against the published baselines. */
  async captureWorkSubject(changeId: string): Promise<DeliverySubject> {
    const change = this.store.work.change(changeId)
    if (!change) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    const root = change.cwd
    const runs = this.store.work.listRuns().filter(run => run.changeId === change.id)
    const writeScope = deliveryScope(runs)
    const scopes = writeScope.kind === 'workspace-exclusive' ? [{ path: root, type: 'directory' as const }] : writeScope.paths
    const files = new Map<string, SnapshotSource>()
    const exclusions = new Map<string, SnapshotExclusion>()
    try {
      for (const scope of scopes) {
        const target = this.scopeTarget(root, scope.path)
        const rel = relativePath(root, target)
        const cover = defaultIgnoreCover(rel, process.platform, scope.type)
        if (cover) throw new Error(`explicit ${scope.type} target ${rel} is a default-ignored path/file (${cover}) and is not supported by delivery capture`)
        const collected = await captureScopeAsync(root, target, scope.type)
        for (const file of collected.files) files.set(foldRel(file.path), file)
        for (const item of collected.exclusions) exclusions.set(`${foldRel(item.path)}|${item.reason}`, item)
      }
    } catch (error) {
      throw new DotError('dot/invalid', error instanceof Error ? error.message : 'delivery scope could not be read')
    }
    const captured = { files: [...files.values()], exclusions: [...exclusions.values()], empty: files.size === 0 }
    let outOfScopePaths: string[] = []
    try {
      const outside = await scanScopeAsync(root, root, 'directory')
      outOfScopePaths = [...outside.files, ...outside.exclusions.map(item => item.path)].filter(rel => !scopeContainsPath(writeScope, root, rel))
    } catch { /* outside observations do not decide closeout */ }
    const stem = artifactName(`sub-${change.id}-${change.currentRevision}-${this.store.work.revision}`)
    if (!stem) throw new DotError('dot/invalid', `${change.id} has no subject id`)
    // A completed manifest is immutable, so a refused closeout's leftover snapshot
    // stays in place and the retry gets a fresh id.
    let id = stem
    let attempt = 2
    while (existsSync(join(this.options.homeDir, 'artifacts', id, 'manifest.json'))) {
      const next = artifactName(`${stem}-a${attempt}`)
      if (!next || next === id || attempt > 40) throw new DotError('dot/invalid', `${change.id} has too many failed subject attempts`)
      id = next
      attempt += 1
    }
    const prior = writerPrior(change.baselineRefs, runs, ref => this.subjectLook().read(ref))
    if (prior.missing) throw new DotError('dot/invalid', `baseline ${prior.missing} is missing or incomplete`)
    const before = new Map(prior.files.filter(file => scopeContainsPath(writeScope, root, file.path)).map(file => [foldRel(file.path), file]))
    const deleted = [...before.values()]
      .filter(entry => !captured.files.some(file => foldRel(file.path) === foldRel(entry.path)))
      .filter(entry => !ignoreCovered(captured.exclusions, entry.path) && !captured.exclusions.some(item => isLinkReason(item.reason) && foldRel(item.path) === foldRel(entry.path)))
      .map(entry => ({ path: entry.path, deleted: true as const }))
    const manifest = saveSnapshot(join(this.options.homeDir, 'artifacts', id), [...captured.files, ...deleted], undefined, {
      root, empty: captured.empty && deleted.length === 0, exclusions: captured.exclusions,
    })
    const changes: DeliverySubject['changes'][number][] = []
    const protectedDirty: string[] = []
    for (const entry of manifest.saved) {
      const prior = before.get(foldRel(entry.path))
      if (!prior) changes.push({ path: entry.path, kind: 'added', sha256: entry.sha256 })
      else if (prior.sha256 !== entry.sha256) changes.push({ path: entry.path, kind: 'modified', sha256: entry.sha256 })
      else protectedDirty.push(entry.path)
    }
    for (const entry of before.values()) {
      const still = manifest.saved.some(item => foldRel(item.path) === foldRel(entry.path))
      const noted = manifest.deleted.some(item => foldRel(item) === foldRel(entry.path))
      if (!still && !noted) {
        if (ignoreCovered(captured.exclusions, entry.path)) continue
        changes.push({ path: entry.path, kind: 'deleted' })
      }
    }
    for (const name of manifest.deleted) {
      if (!changes.some(item => item.kind === 'deleted' && foldRel(item.path) === foldRel(name))) changes.push({ path: name, kind: 'deleted' })
    }
    const subject: DeliverySubject = {
      workspaceRoot: root, cwd: root, baselineRefs: change.baselineRefs, artifactRef: id,
      changes, protectedDirty, exclusions: [...captured.exclusions], writeScope, outOfScopePaths,
    }
    return subject
  }

  /**
   * Read one source named by this verification.
   * The verification has to be the one requested and it has to match the current input.
   * An older input, an unbound id, or a path outside that delivery is refused before any file is opened.
   */
  readWorkSource(changeId: string, kind: 'evidence' | 'change', ref: string, bound: { readonly verificationId: string; readonly inputRef: string; readonly inputRevision: number }, options?: { readonly forceFull?: boolean; readonly view?: 'diff' }): { readonly ok: true; readonly source: string; readonly body: string; readonly truncated?: boolean; readonly totalBytes?: number } | { readonly ok: false; readonly code: 'missing' | 'stale' | 'invalid'; readonly message: string } {
    if (options?.view === 'diff' && kind !== 'change') return { ok: false, code: 'invalid', message: 'diff view applies to delivered files only' }
    const change = this.store.work.change(changeId)
    if (!change) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
    if (!bound.verificationId || !bound.inputRef || !Number.isInteger(bound.inputRevision) || bound.inputRevision < 1) {
      return { ok: false, code: 'stale', message: `${changeId} has no current verification` }
    }
    const verification = this.store.work.verification(bound.verificationId)
    if (!verification || verification.changeId !== changeId) return { ok: false, code: 'stale', message: `${bound.verificationId} is not bound to the current verification` }
    if (bound.inputRef !== verification.inputRef || bound.inputRevision !== verification.inputRevision || verification.inputRef !== change.currentInputRef || verification.inputRevision !== change.currentRevision) {
      return { ok: false, code: 'stale', message: `${bound.verificationId} is not bound to the current input` }
    }
    const asText = (source: string, bytes: Uint8Array) => {
      const maxBytes = options?.forceFull ? bytes.byteLength : 262_144
      const truncated = bytes.byteLength > maxBytes
      const slice = truncated ? bytes.subarray(0, maxBytes) : bytes
      const decoded = new TextDecoder('utf-8', { fatal: kind === 'change' && !truncated }).decode(slice)
      return {
        ok: true as const, source, totalBytes: bytes.byteLength, truncated,
        body: truncated ? `${decoded}\n… [truncated at 256 KiB; total ${bytes.byteLength} bytes]` : decoded,
      }
    }
    if (kind === 'evidence') {
      const parsed = parseEvidenceRef(ref)
      if (!parsed) return { ok: false, code: 'invalid', message: 'invalid evidence reference' }
      const checks = verification.checks.filter(check => check.evidenceRefs.includes(ref))
      if (!checks.length) return { ok: false, code: 'stale', message: `${ref} is not bound to ${verification.id}` }
      if (parsed.kind === 'run') {
        const report = this.readRunReport(parsed.runId)
        if (report === undefined) return { ok: false, code: 'missing', message: `run report ${parsed.runId} could not be read` }
        const bullet = parsed.scenario ? reportBullet(report, parsed.scenario) : undefined
        if (parsed.scenario && !bullet) return { ok: false, code: 'missing', message: `run report ${parsed.runId} has no Report bullet for ${parsed.scenario}` }
        return asText(`evidence:${ref}`, new TextEncoder().encode(bullet ? `${bullet}\n\n${report}` : report))
      }
      const subject = verification.subject
      const named = subject?.changes.find(item => foldRel(item.path) === foldRel(parsed.path))
      if (!subject || !named) return { ok: false, code: 'stale', message: `${ref} is not a delivered file of ${verification.id}` }
      if (named.kind === 'deleted' || !named.sha256) return { ok: false, code: 'missing', message: `${ref} was deleted in ${verification.id}` }
      if (!artifactName(subject.artifactRef) || artifactName(subject.artifactRef) !== subject.artifactRef) return { ok: false, code: 'invalid', message: 'delivery snapshot is not a single relative id' }
      try {
        const bodyBytes = readSnapshotEntry(join(this.options.homeDir, 'artifacts', subject.artifactRef), named.path)
        if (!bodyBytes || bodyBytes.byteLength === 0) return { ok: false, code: 'missing', message: `${ref} is missing from the delivery snapshot` }
        return asText(`change:${named.path}`, bodyBytes)
      } catch {
        return { ok: false, code: 'missing', message: `${ref} could not be read` }
      }
    }
    const subject = verification.subject
    const named = subject?.changes.find(item => item.path === ref)
    if (!subject || !named) return { ok: false, code: 'stale', message: `${ref} is not a delivered file of ${verification.id}` }
    if (options?.view === 'diff') return this.readWorkDiff(change, verification.id, subject, named)
    if (named.kind === 'deleted' || !named.sha256) return { ok: false, code: 'missing', message: `${ref} was deleted in ${verification.id}` }
    if (!artifactName(subject.artifactRef) || artifactName(subject.artifactRef) !== subject.artifactRef) return { ok: false, code: 'invalid', message: 'delivery snapshot is not a single relative id' }
    try {
      const bodyBytes = readSnapshotEntry(join(this.options.homeDir, 'artifacts', subject.artifactRef), named.path)
      if (!bodyBytes || bodyBytes.byteLength === 0) return { ok: false, code: 'missing', message: `${ref} is missing from the delivery snapshot` }
      return asText(`change:${named.path}`, bodyBytes)
    } catch {
      return { ok: false, code: 'missing', message: `${ref} could not be read` }
    }
  }

  /**
   * Unified diff of one delivered file against the same writer baseline the
   * added/modified/deleted classification compared against. `added` diffs
   * against empty, `deleted` against the baseline body, so deletions are
   * reviewable too. Binary or >256 KiB sides refuse with `invalid`; the
   * reader falls back to the full view.
   */
  private readWorkDiff(change: ChangeRecord, verificationId: string, subject: DeliverySubject, named: DeliverySubject['changes'][number]): { readonly ok: true; readonly source: string; readonly body: string } | { readonly ok: false; readonly code: 'missing' | 'invalid'; readonly message: string } {
    const artifacts = join(this.options.homeDir, 'artifacts')
    const invalid = { ok: false as const, code: 'invalid' as const, message: `${named.path} is binary or larger than 256 KiB; open the full file` }
    let right: Uint8Array = new Uint8Array()
    if (named.kind !== 'deleted') {
      if (!artifactName(subject.artifactRef) || artifactName(subject.artifactRef) !== subject.artifactRef) return { ok: false, code: 'invalid', message: 'delivery snapshot is not a single relative id' }
      let delivered: Uint8Array | undefined
      try { delivered = readSnapshotEntry(join(artifacts, subject.artifactRef), named.path) } catch { delivered = undefined }
      if (!delivered) return { ok: false, code: 'missing', message: `${named.path} is missing from the delivery snapshot` }
      right = delivered
    }
    let left: Uint8Array = new Uint8Array()
    if (named.kind !== 'added') {
      const prior = this.diffPrior(change, verificationId, subject)
      if (prior.missing) return { ok: false, code: 'missing', message: `baseline ${prior.missing} is missing or incomplete` }
      const entry = prior.files.find(file => foldRel(file.path) === foldRel(named.path))
      if (entry) {
        let before: Uint8Array | undefined
        try { before = readSnapshotEntry(join(artifacts, entry.artifactRef), entry.path) } catch { before = undefined }
        if (!before) return { ok: false, code: 'missing', message: `baseline ${entry.artifactRef} does not contain ${entry.path}` }
        left = before
      }
    }
    if (left.byteLength > 262_144 || right.byteLength > 262_144) return invalid
    let leftText: string, rightText: string
    const decoder = new TextDecoder('utf-8', { fatal: true })
    try {
      leftText = decoder.decode(left)
      rightText = decoder.decode(right)
    } catch { return invalid }
    // Heavy rewrites can take seconds of main-loop time even under the side cap;
    // jsdiff gives up past the timeout instead.
    const patch = createTwoFilesPatch(`a/${named.path}`, `b/${named.path}`, leftText, rightText, undefined, undefined, { context: 3, timeout: 1500 })
    if (patch === undefined) return { ok: false, code: 'invalid', message: `${named.path} has too many changes for a diff; open the full file` }
    return { ok: true, source: `diff:${named.path}`, body: patch }
  }

  /** writerPrior re-reads every baseline manifest per file; a subject's baseline set is immutable, so one lookup serves all its files. */
  private readonly diffPriors = new Map<string, ReturnType<typeof writerPrior>>()
  private diffPrior(change: ChangeRecord, verificationId: string, subject: DeliverySubject): ReturnType<typeof writerPrior> {
    // Change ids and artifact names restart after a factory reset; the key has
    // to tie the memo to this exact verification and baseline set as well.
    const key = `${verificationId}|${subject.artifactRef}|${subject.baselineRefs.map(ref => ref.artifactRef).join(',')}`
    const cached = this.diffPriors.get(key)
    if (cached) return cached
    const runs = this.store.work.listRuns().filter(run => run.changeId === change.id)
    const prior = writerPrior(subject.baselineRefs, runs, ref => this.subjectLook().read(ref))
    if (this.diffPriors.size >= 8) this.diffPriors.delete(this.diffPriors.keys().next().value!)
    this.diffPriors.set(key, prior)
    return prior
  }

  /** Check the review, close it to new deliveries, then stop. A late delivery cannot reuse this stop. */
  async holdWorkReview(runId: string) {
    const review = this.store.work.run(runId)
    this.abortQuietWait(review?.sessionId ?? review?.requestedSessionId, 'hold-review', true)
    const prepared = await this.store.work.prepareReviewHold(runId, this.now())
    if (!prepared.ok) return prepared
    this.abortQuietWait(prepared.sessionId, 'hold-review', true)
    const current = this.store.work.run(runId)
    if (current?.phase === 'settling' && current.closureEvidence?.jobsSettled) return current
    let report: { queueCleared: boolean; idle: boolean; jobsSettled: boolean | 'unknown' }
    try { report = await this.runHost().stop(prepared.sessionId) } catch {
      report = { queueCleared: false, idle: false, jobsSettled: 'unknown' }
    }
    if (!report.queueCleared || !report.idle || report.jobsSettled !== true) {
      return { ok: false as const, code: 'unknown' as const, message: `${runId} is not confirmed stopped` }
    }
    const held = await this.store.work.completeReviewHold(runId, prepared.updatedAt, { queueCleared: true, agentIdle: true, jobsSettled: true }, this.now())
    if ('id' in held) await this.captureRunReport(runId)
    return held
  }

  /**
   * The run's final assistant message is its report; closeout evidence refs
   * resolve against this captured copy, not the live session log.
   */
  private async captureRunReport(runId: string): Promise<boolean> {
    // A pre-reset run's report must not link a post-reset change reusing the id.
    const generation = this.resetGeneration
    const run = this.store.work.run(runId)
    if (!run?.sessionId || typeof this.host.latestReply !== 'function') return false
    const reply = await this.host.latestReply(run.sessionId, 20_000).catch(() => undefined)
    if (!reply?.trim()) return false
    try {
      const dir = join(this.options.homeDir, 'artifacts', 'evidence')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${artifactName(runId)}.md`), reply)
      if (this.resetGeneration === generation) this.autoLinkReport(run.changeId, reply)
      return true
    } catch { return false }
  }

  private readRunReport(runId: string): string | undefined {
    try {
      const body = readFileSync(join(this.options.homeDir, 'artifacts', 'evidence', `${artifactName(runId)}.md`))
      return body.byteLength ? new TextDecoder().decode(body) : undefined
    } catch { return undefined }
  }

  /** Refuse an evidence ref with the resolvable forms and the runs it may name. */
  private evidenceRefHint(changeId: string, ref: string, reason?: string): DotError {
    const runIds = this.store.work.listRuns().filter(run => run.changeId === changeId).map(run => run.id)
    const detail = reason ? `${reason} ` : ''
    return new DotError('dot/invalid', `${detail}evidence ${ref} must resolve: run:<runId> for a run's final report, run:<runId>#<scenarioRef> for a Report bullet, or file:<path> for a delivered file. Runs of ${changeId}: ${runIds.join(', ') || 'none'}`)
  }

  private subjectLook(): SubjectLook {
    const root = join(this.options.homeDir, 'artifacts')
    const scan = (workspaceRoot: string, scope?: import('./work.ts').WriteScope) => {
      if (!scope || scope.kind === 'workspace-exclusive') return scanScope(workspaceRoot, workspaceRoot, 'directory')
      const rows = scope.paths.map(item => scanScope(workspaceRoot, this.scopeTarget(workspaceRoot, item.path), item.type))
      return { files: [...new Set(rows.flatMap(row => row.files))], exclusions: [...new Map(rows.flatMap(row => row.exclusions).map(item => [`${foldRel(item.path)}|${item.reason}`, item])).values()] }
    }
    return {
      read: ref => {
        if (!artifactName(ref) || artifactName(ref) !== ref) return undefined
        try {
          const manifest = readManifest(join(root, ref))
          return { root: manifest.root, saved: manifest.saved, deleted: manifest.deleted, exclusions: manifest.exclusions }
        } catch { return undefined }
      },
      live: (workspaceRoot, scope) => {
        try { return [...scan(workspaceRoot, scope).files] } catch { return undefined }
      },
      boundaries: (workspaceRoot, scope) => {
        try { return [...scan(workspaceRoot, scope).exclusions] } catch { return undefined }
      },
      body: (workspaceRoot, path) => {
        try { return new Uint8Array(readFileSync(join(workspaceRoot, ...path.split('/')))) } catch { return undefined }
      },
    }
  }

  private async reviseOrCreate(args: Record<string, unknown>): Promise<string> {
    const text = (key: string) => typeof args[key] === 'string' ? args[key] as string : undefined
    const action = text('action')
    const title = text('title')
    const goal = text('goal')
    const dir = text('dir')
    const explicitRequirements = requirementList(args.requirements)
    if (args.requirements !== undefined && explicitRequirements === undefined) {
      throw new DotError('dot/invalid', 'requirements must be a JSON array')
    }
    const steps = args.steps === undefined ? undefined : stepList(args.steps)
    const constraints = constraintList(args.constraints)
    const userRequest = text('user_request')
    const deliverableLanguage = text('deliverable_language')
    const maxConcurrentRuns = typeof args.max_concurrent === 'number' ? args.max_concurrent : undefined
    const inputFields = {
      ...(constraints !== undefined ? { constraints } : {}),
      ...(userRequest !== undefined ? { userRequest } : {}),
      ...(deliverableLanguage !== undefined ? { deliverableLanguage } : {}),
    }
    if (action === 'create') {
      const created = await this.createChangeFromTool(args)
      const change = created.change
      const recipe = change.recipe ? this.store.recipe(change.recipe.id) : undefined
      const view = this.store.work.workView(change.id)
      return JSON.stringify({
        ...view,
        ...(created.forcedIsolation ? { isolationNote: "This directory is dot's own live checkout, so the task runs in a git worktree even though isolation was \"none\"." } : {}),
        ...(recipe ? { recipe: { id: recipe.id, name: recipe.name, revision: recipe.revision } } : {}),
      })
    }
    const changeId = text('task_id') ?? ''
    if (!changeId) throw new DotError('dot/invalid', 'task_id is required')
    const requirements = explicitRequirements
    const currentChange = this.store.work.change(changeId)
    const previousInput = currentChange ? this.store.work.input(currentChange.currentInputRef) : undefined
    const requirementsFromGoal = explicitRequirements !== undefined
      ? false
      : previousInput ? requirementsFollowGoal(previousInput) : undefined
    const changesInput = goal !== undefined || explicitRequirements !== undefined || steps !== undefined || dir !== undefined
      || constraints !== undefined || userRequest !== undefined || deliverableLanguage !== undefined
    const nextDir = dir !== undefined ? this.boundSelfDir(currentChange, dir) : undefined
    const revised = await this.store.work.reviseChange(changeId, {
      ...(title !== undefined ? { title } : {}),
      ...(goal !== undefined ? { goal } : {}),
      ...(nextDir !== undefined ? { cwd: nextDir } : {}),
      ...(requirements ? { requirements } : {}),
      ...(changesInput && requirementsFromGoal !== undefined ? { requirementsFromGoal } : {}),
      ...(steps ? { steps } : {}),
      ...inputFields,
      ...(maxConcurrentRuns !== undefined ? { maxConcurrentRuns } : {}),
      ...(typeof args.priority === 'number' ? { priority: args.priority as 1 | 2 | 3 } : {}),
      at: this.now(),
    })
    if (!('id' in revised)) throw new DotError('dot/invalid', revised.message)
    if (args.human_review === true) await this.store.work.requestOversight(revised.id, this.now())
    return JSON.stringify(this.store.work.workView(revised.id))
  }

  private git(): GitRunner { return this.options.git ?? runGit }

  /**
   * Mutual-exclusion identity for a run's cwd. A cwd inside
   * `<homeDir>/worktrees/` is a `dot/task-*` worktree only dot's own tasks
   * check out, so its worktree root is the exclusion root — not the repo's git
   * common dir, which would lock every linked worktree against the main
   * checkout and each other.
   */
  private rootHint(cwd: string): RootHint {
    const worktree = taskWorktreeRoot(cwd, this.options.homeDir)
    if (worktree !== undefined) return { workspaceRoot: worktree }
    return detectWorkspaceRoot(cwd)
  }

  /**
   * dot's own checkout is never a plain write target. A linked checkout gets
   * a git worktree whose merge rebuilds the bundle; the installed package is
   * the plugin manager's, so editing it is refused outright.
   */
  private selfIsolation(dir: string): 'worktree' | undefined {
    const self = this.options.selfInstall
    if (!self || !insideOrEqual(self.root, realpathOrResolve(dir))) return undefined
    if (self.mode === 'installed') {
      throw new DotError('dot/self', `${dir} is dot's own installed package, managed by the plugin manager; dot does not edit it. Changes to dot itself go to the maintainers as an issue or PR draft; settings, agreements, cognition and recipes change through their own tools.`)
    }
    return 'worktree'
  }

  /**
   * A change made before the self-checkout guard can still name dot's live
   * checkout. Its write runs stop at the one point every dispatch passes
   * between reservation and launch — a plain cwd has no merge step to rebuild
   * the bundle, and a failed build could leave dot unloadable. Isolated
   * changes merge through the worktree path and stay allowed, but only while
   * the actual cwd still lives in that worktree.
   */
  private selfRunBlocked(change: ChangeRecord, run: RunRecord | undefined, scope: WriteScope): boolean {
    const self = this.options.selfInstall
    if (!self || !scopeWrites(scope)) return false
    const root = self.root
    const isolation = change.isolation
    // Only a linked self-maintenance worktree gets cwd / workspace-exclusive
    // exemption; explicit scope.paths are always checked against live self.root.
    const selfWorktree = (() => {
      if (isolation?.kind !== 'worktree' || !this.sameRealPath(isolation.repoRoot, root)) return false
      try {
        return insideOrEqual(realpathOrResolve(isolation.worktree), realpathOrResolve(change.cwd))
      } catch {
        // A missing worktree still must not authorize a live-checkout cwd.
        return false
      }
    })()
    if (!selfWorktree && insideOrEqual(root, realpathOrResolve(change.cwd))) return true
    const scopeRoot = run?.workspaceRoot || change.cwd
    const scopeRootReal = realpathOrResolve(scopeRoot)
    if (self.mode === 'installed') {
      // Only the package itself is off-limits. A host project that merely
      // contains node_modules/ds-dot is a normal write target.
      if (scope.kind === 'workspace-exclusive') return !selfWorktree && insideOrEqual(root, scopeRootReal)
      return scope.paths.some(entry => {
        try {
          return insideOrEqual(root, realpathOrResolve(absoluteScopePath(scopeRoot, entry.path)))
        } catch {
          return false
        }
      })
    }
    if (scope.kind === 'workspace-exclusive') {
      if (selfWorktree) return false
      return insideOrEqual(scopeRootReal, root) || insideOrEqual(root, scopeRootReal)
    }
    return scope.paths.some(entry => {
      try {
        const absolute = realpathOrResolve(absoluteScopePath(scopeRoot, entry.path))
        return insideOrEqual(root, absolute) || (entry.type === 'directory' && insideOrEqual(absolute, root))
      } catch {
        return false
      }
    })
  }

  /**
   * Revise must not walk an isolated self task back onto the live checkout,
   * and must not aim a normal task at an installed package. Linked live
   * checkout paths remap into the existing worktree.
   */
  private boundSelfDir(change: ChangeRecord | undefined, dir: string): string {
    if (!change) {
      this.selfIsolation(dir)
      return dir
    }
    const isolation = change.isolation
    if (isolation?.kind === 'worktree') {
      const requested = realpathOrResolve(dir)
      const worktree = realpathOrResolve(isolation.worktree)
      if (insideOrEqual(worktree, requested)) return dir
      const repoRoot = realpathOrResolve(isolation.repoRoot)
      if (insideOrEqual(repoRoot, requested)) {
        const rel = relative(repoRoot, requested)
        return rel && rel !== '.' ? join(isolation.worktree, rel) : isolation.worktree
      }
      throw new DotError('dot/self', `${dir} leaves the isolated worktree for this task; stay inside ${isolation.worktree} or the original checkout at ${isolation.repoRoot}.`)
    }
    this.selfIsolation(dir)
    return dir
  }

  /** Persist the original checkout, not the ephemeral worktree path, when saving a recipe from an isolated task. */
  private recipeDirFromChange(change: ChangeRecord): { dir: string; isolation?: 'worktree' } {
    const isolation = change.isolation
    if (isolation?.kind !== 'worktree') return { dir: change.cwd }
    const rel = relative(isolation.worktree, change.cwd)
    const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    const dir = inside && rel && rel !== '.' ? join(isolation.repoRoot, rel) : isolation.repoRoot
    return { dir, isolation: 'worktree' }
  }

  /** Map in-checkout absolute write paths onto the worktree; keep paths already in the worktree and relative paths; reject anything outside both. */
  private remapSelfScopePaths(fromRoot: string, toRoot: string, paths: string): string {
    const listed = pathScope(paths)
    if (!listed) return paths
    const from = realpathOrResolve(fromRoot)
    const to = realpathOrResolve(toRoot)
    return JSON.stringify(listed.map(entry => {
      if (!isAbsolute(entry.path)) return entry
      const absolute = realpathOrResolve(entry.path)
      if (insideOrEqual(to, absolute)) return entry
      if (!insideOrEqual(from, absolute)) {
        throw new DotError('dot/invalid', `scope ${entry.path} is outside ${fromRoot}`)
      }
      const rel = relative(from, absolute)
      return { path: rel && rel !== '.' ? join(toRoot, rel) : toRoot, type: entry.type }
    }))
  }

  /** Open a dot/task-* worktree for `dir`; a git failure reads as dot/invalid like create reports it. */
  private async taskWorktreeFor(dir: string, base?: { readonly ref: string; readonly remote?: string }): Promise<TaskWorktree> {
    try {
      return await createTaskWorktree({ dir, homeDir: this.options.homeDir, ...(base !== undefined ? { base } : {}) }, this.git())
    } catch (error) {
      throw new DotError('dot/invalid', `isolation "worktree" could not be prepared: ${messageOf(error)}`)
    }
  }

  /** The create branch of dot_task: returns the created record so callers (recipe dispatch) need not parse the view JSON. */
  private async createChangeFromTool(args: Record<string, unknown>): Promise<{ readonly change: ChangeRecord; readonly forcedIsolation: boolean }> {
    this.assertOpen()
    const text = (key: string) => typeof args[key] === 'string' ? args[key] as string : undefined
    const title = text('title')
    const goal = text('goal')
    const dir = text('dir')
    const explicitRequirements = requirementList(args.requirements)
    if (args.requirements !== undefined && explicitRequirements === undefined) {
      throw new DotError('dot/invalid', 'requirements must be a JSON array')
    }
    const steps = args.steps === undefined ? undefined : stepList(args.steps)
    const constraints = constraintList(args.constraints)
    const userRequest = text('user_request')
    const deliverableLanguage = text('deliverable_language')
    const maxConcurrentRuns = typeof args.max_concurrent === 'number' ? args.max_concurrent : undefined
    const recipe = text('recipe') === undefined ? undefined : this.requireRecipe(text('recipe')!)
    const createTitle = title ?? recipe?.name
    const createGoal = goal ?? recipe?.goal
    const createDir = dir ?? recipe?.dir
    const createConstraints = constraints ?? recipe?.constraints
    const createLanguage = deliverableLanguage ?? recipe?.deliverableLanguage
    if (!createTitle?.trim() || !createGoal?.trim() || !createDir || !isAbsolute(createDir)) throw new DotError('dot/invalid', 'title, goal and an absolute dir are required')
    const requirements = explicitRequirements
      ?? (recipe ? recipeRequirements(recipe, createGoal) : undefined)
      ?? goalRequirements(createGoal)
    const isolationArg = args.isolation
    if (isolationArg !== undefined && isolationArg !== 'none' && isolationArg !== 'worktree') {
      throw new DotError('dot/invalid', 'isolation must be "none" or "worktree"')
    }
    const forcedIsolation = this.selfIsolation(createDir) === 'worktree'
    const wantsWorktree = forcedIsolation || isolationArg === 'worktree' || (isolationArg === undefined && recipe?.isolation === 'worktree')
    const baseRef = typeof args.base_ref === 'string' && args.base_ref.trim() !== '' ? args.base_ref.trim() : undefined
    const baseRemote = typeof args.base_remote === 'string' && args.base_remote.trim() !== '' ? args.base_remote.trim() : undefined
    if (baseRemote !== undefined && baseRef === undefined) throw new DotError('dot/invalid', 'base_remote needs base_ref')
    if ((baseRef !== undefined || baseRemote !== undefined) && !wantsWorktree) throw new DotError('dot/invalid', 'base_ref and base_remote need isolation "worktree"')
    const base = baseRef === undefined ? undefined : { ref: baseRef, ...(baseRemote !== undefined ? { remote: baseRemote } : {}) }
    const storedBase = base === undefined ? undefined : { ref: base.ref, ...(base.remote !== undefined ? { remote: sanitizeRemoteDisplay(base.remote) } : {}) }
    let worktree: TaskWorktree | undefined
    if (wantsWorktree) {
      worktree = await this.taskWorktreeFor(createDir, base)
      if (this.closing) {
        await removeTaskWorktree({ repoRoot: worktree.repoRoot, worktree: worktree.worktree, branch: worktree.branch, baseSha: worktree.baseSha }, this.git()).catch(() => undefined)
        throw new DotError('dot/disposed', 'dot is shutting down')
      }
    }
    let change: ChangeRecord
    try {
      change = await this.store.work.createChange({
        title: createTitle, cwd: worktree?.cwd ?? createDir, goal: createGoal,
        requirements,
        requirementsFromGoal: explicitRequirements === undefined && (recipe === undefined || requirementsFollowGoal(recipe)),
        ...(steps ? { steps } : {}),
        ...(createConstraints !== undefined ? { constraints: createConstraints } : {}),
        ...(userRequest !== undefined ? { userRequest } : {}),
        ...(createLanguage !== undefined ? { deliverableLanguage: createLanguage } : {}),
        ...(recipe ? { recipe: { id: recipe.id, revision: recipe.revision } } : {}),
        ...(worktree !== undefined ? {
          isolation: {
            kind: 'worktree' as const, repoRoot: worktree.repoRoot, worktree: worktree.worktree,
            branch: worktree.branch, baseSha: worktree.baseSha,
            ...(storedBase !== undefined ? { base: storedBase } : {}),
            state: 'active' as const, at: this.now(),
          },
        } : {}),
        ...(maxConcurrentRuns !== undefined ? { maxConcurrentRuns } : {}),
        ...(typeof args.priority === 'number' ? { priority: args.priority as 1 | 2 | 3 } : {}),
        at: this.now(),
      })
    } catch (error) {
      if (worktree !== undefined) {
        await removeTaskWorktree({ repoRoot: worktree.repoRoot, worktree: worktree.worktree, branch: worktree.branch, baseSha: worktree.baseSha }, this.git()).catch(() => undefined)
      }
      if (error instanceof InputShapeError) throw new DotError('dot/invalid', error.message)
      throw error
    }
    const humanReview = args.human_review !== undefined ? args.human_review === true : recipe?.humanReview === true
    if (humanReview) await this.store.work.requestOversight(change.id, this.now())
    void this.pruneWorkArtifactsIfNeeded()
    return { change, forcedIsolation }
  }

  private async reserveFromTool(args: Record<string, unknown>, origin?: RunOrigin): Promise<{ changeId: string; runId: string; phase: RunRecord['phase']; requestedSessionId: string }> {
    const changeId = typeof args.task_id === 'string' ? args.task_id : ''
    const role = typeof args.role === 'string' ? args.role : 'work'
    if (role !== 'work' && role !== 'rework' && role !== 'review') throw new DotError('dot/invalid', 'invalid role')
    const change = this.store.work.change(changeId)
    if (!change) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    const write = args.access === 'write'
    const paths = pathScope(args.paths)
    if (role !== 'review' && paths && paths.length > 0 && args.access !== 'write') {
      throw new DotError('dot/invalid', `these paths are a write scope, so access must be "write". Example: access "write", paths ${WRITE_PATHS_EXAMPLE}. access "read" cannot write them, and the run is not reserved.`)
    }
    const listed = jsonArray(args.step_refs)
    const stepRefs = listed?.map(item => String(item))
    const reserved = await this.store.work.reserveRun({
      changeId, kind: role, cwd: change.cwd, root: this.rootHint(change.cwd),
      ...(stepRefs ? { stepRefs } : {}),
      ...(origin ? { origin } : {}),
      writeScope: role === 'review'
        ? { kind: 'workspace-exclusive' }
        : { kind: 'paths', paths: paths ?? (write ? [{ path: change.cwd, type: 'directory' as const }] : []) },
      at: this.now(),
    })
    if (!reserved.ok) throw new DotError('dot/invalid', reserved.message)
    return { changeId, runId: reserved.run.id, phase: reserved.run.phase, requestedSessionId: reserved.run.requestedSessionId }
  }

  private readWork(changeId: string, inputRef?: string): string {
    const change = this.store.work.change(changeId)
    if (!change) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    if (inputRef) {
      const row = this.store.work.input(inputRef)
      if (!row || row.changeId !== changeId) throw new DotError('dot/invalid', `unknown input ${inputRef}`)
      return JSON.stringify({ ...row, constraints: row.constraints ?? [] })
    }
    const view = this.workBoard(changeId)
    const material = this.store.work.input(change.currentInputRef)
    return JSON.stringify({
      ...view,
      goal: material?.goal,
      requirements: material?.requirements ?? [],
      steps: change.steps.map(step => {
        const spec = material?.steps.find(item => item.stepRef === step.stepRef)
        return {
          stepRef: step.stepRef,
          text: spec?.text ?? '',
          done: step.done,
          inputRef: step.inputRef,
          ...(spec?.covers ? { covers: spec.covers } : {}),
          ...(spec?.after ? { after: spec.after } : {}),
          ...(step.runId ? { runId: step.runId } : {}),
        }
      }),
      constraints: material?.constraints ?? [],
      userRequest: material?.userRequest ?? null,
      deliverableLanguage: material?.deliverableLanguage ?? null,
      ...(change.recipe ? { recipe: { id: change.recipe.id, name: this.taggedRecipe(change)?.name ?? null, revision: change.recipe.revision } } : {}),
      // lastEvent carries GitHub-authored title/summary (comment bodies etc.):
      // fence them as untrusted in tool output; the board keeps plain text.
      links: this.store.linksFor(changeId).map(link => link.lastEvent === undefined ? link : {
        ...link,
        lastEvent: { ...link.lastEvent, title: fenceUntrusted(link.lastEvent.title), summary: fenceUntrusted(link.lastEvent.summary) },
      }),
      maxConcurrentRuns: change.maxConcurrentRuns,
      failedRounds: this.store.work.failedRounds(changeId),
      history: this.store.work.inputsFor(changeId).map(row => ({ id: row.id, revision: row.revision, goal: row.goal })),
    })
  }

  /** link/unlink attach or drop the GitHub target an inbox event can bind to. */
  private async linkFromTool(args: Record<string, unknown>, unlink: boolean): Promise<string> {
    const changeId = typeof args.task_id === 'string' ? args.task_id : ''
    const ref = typeof args.ref === 'string' ? args.ref : ''
    if (!changeId) throw new DotError('dot/invalid', 'task_id is required')
    if (!this.store.work.change(changeId)) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    const target = parseLinkRef(ref)
    if (!target) throw new DotError('dot/invalid', `ref ${ref} must be a GitHub pull/issue URL, owner/repo#N, or owner/repo@branch`)
    const label = `${target.repo}${target.number !== undefined ? `#${target.number}` : `@${target.branch}`}`
    const id = taskLinkId(changeId, target)
    if (unlink) {
      await this.store.deleteLink(id)
      return `unlinked ${label} from ${changeId}`
    }
    if (this.store.link(id)) return `already linked ${label} to ${changeId}`
    await this.store.putLink(this.learnFromStoredInbox(makeTaskLink(changeId, target, 'dot', this.now())))
    return `linked ${label} to ${changeId}`
  }

  private async controlFromTool(args: Record<string, unknown>): Promise<string> {
    const action = typeof args.action === 'string' ? args.action : ''
    const changeId = typeof args.task_id === 'string' ? args.task_id : ''
    if (!changeId) throw new DotError('dot/invalid', 'task_id is required')
    if (action === 'cancel') {
      const cancelled = await this.cancelWorkChange(changeId)
      if (!cancelled.ok) throw new DotError('dot/invalid', cancelled.message)
      return `cancelled ${changeId}`
    }
    const current = this.store.work.change(changeId)
    if (!current) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    if (current.control === 'cancelled') throw new DotError('dot/invalid', `${changeId} is cancelled`)
    const control = action === 'pause' ? 'paused' as const : 'open' as const
    const changed = await this.store.work.setControl(changeId, control, this.now())
    if (!('id' in changed)) throw new DotError('dot/invalid', changed.message)
    return `${control} ${changeId}`
  }

  private async stepFromTool(args: Record<string, unknown>): Promise<string> {
    const changeId = typeof args.task_id === 'string' ? args.task_id : ''
    const stepRef = typeof args.step_ref === 'string' ? args.step_ref : ''
    const runId = typeof args.run_id === 'string' ? args.run_id : ''
    const expectedInputRevision = typeof args.expected_input_revision === 'number' ? args.expected_input_revision : this.soleInputRevision(changeId)
    if (!changeId || !stepRef || expectedInputRevision === undefined) {
      throw new DotError('dot/invalid', 'step requires task_id, step_ref and expected_input_revision')
    }
    const noted = await this.store.work.noteStep(changeId, stepRef, runId || undefined, expectedInputRevision, this.now())
    if (!('id' in noted)) throw new DotError('dot/invalid', noted.message)
    return `step ${stepRef} done on ${changeId}${runId ? ` by ${runId}` : ''}`
  }

  private async finishFromTool(args: Record<string, unknown>): Promise<string> {
    const runId = typeof args.run_id === 'string' ? args.run_id : ''
    if (!runId) throw new DotError('dot/invalid', 'run_id is required')
    const phase = args.verdict === 'fail' ? 'failed' as const : 'completed' as const
    const finished = await this.finishWorkRun(runId, phase)
    if (!finished.ok) throw new DotError('dot/invalid', finished.message)
    return `${phase} ${runId}`
  }

  private async decideFromTool(args: Record<string, unknown>): Promise<string> {
    const changeId = typeof args.task_id === 'string' ? args.task_id : ''
    const change = this.store.work.change(changeId)
    if (!change) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    const expectedInputRevision = typeof args.expected_input_revision === 'number' ? args.expected_input_revision : change.currentRevision
    const verificationId = typeof args.verification_id === 'string' ? args.verification_id : ''
    const subjectKey = typeof args.expected_subject_key === 'string' ? args.expected_subject_key : ''
    if (!verificationId || !subjectKey) throw new DotError('dot/invalid', 'decide requires verification_id and expected_subject_key')
    if (!change.oversight?.requested || change.oversight.inputRef !== change.currentInputRef) {
      const asked = await this.store.work.requestOversight(changeId, this.now())
      if (!('id' in asked)) throw new DotError('dot/invalid', asked.message)
    }
    // Human-required: only the human entry point may record this decision, so dot cannot answer its own request.
    const opened = this.pending.open({
      kind: 'approval',
      humanRequired: true,
      sessionId: this.store.dotSessionId || changeId,
      subject: `Look at ${changeId}`,
      detail: JSON.stringify({ changeId, inputRevision: expectedInputRevision, verificationId, subjectKey }),
    })
    return `pending ${opened.id} for ${changeId}`
  }

  /**
   * One-call closeout. The caller must name the input it read and pass an explicit
   * check per required item. Evidence text does not invent those verdicts.
   * A review already released as rework still blocks this same input.
   */
  private async closeoutFromTool(args: Record<string, unknown>): Promise<string> {
    const changeId = typeof args.task_id === 'string' ? args.task_id : ''
    const change = this.store.work.change(changeId)
    if (!change) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    const soleInput = this.soleInput(changeId)
    const expectedRef = typeof args.expected_input_ref === 'string' && args.expected_input_ref ? args.expected_input_ref : soleInput?.inputRef ?? ''
    const expectedRevision = typeof args.expected_input_revision === 'number' && Number.isInteger(args.expected_input_revision)
      ? args.expected_input_revision
      : soleInput?.inputRevision
    if (!expectedRef || expectedRevision === undefined) {
      throw new DotError('dot/invalid', `closeout requires expected_input_ref and expected_input_revision for ${change.currentInputRef}@${change.currentRevision}. Copy inputRef and revision from action=read. Do not omit them.`)
    }
    if (expectedRef !== change.currentInputRef || expectedRevision !== change.currentRevision) {
      throw new DotError('dot/invalid', `expected input ${expectedRef}@${expectedRevision} is not current ${change.currentInputRef}@${change.currentRevision}`)
    }
    // The human's approval is for this same named input. Omitting the fields never selects current.
    // acceptWork still re-verifies live workspace SHA-256 bytes against its snapshot before closing out.
    const approvedDecision = change.oversight?.inputRef === expectedRef
      && change.oversight.inputRevision === expectedRevision
      && change.oversight.decision?.result === 'accept'
      && change.oversight.decision.source === 'user'
      ? change.oversight.decision
      : undefined
    if (approvedDecision) {
      const decidedVerificationId = approvedDecision.verificationId
      const decidedSubjectKey = approvedDecision.subjectKey
      if (!decidedVerificationId || !decidedSubjectKey) {
        throw new DotError('dot/invalid', `the human's approval of ${changeId} named no verification to close out`)
      }
      const accepted = await this.acceptWork(
        changeId,
        decidedVerificationId,
        expectedRef,
        decidedSubjectKey,
        'tool',
        { expectedInputRevision: expectedRevision, expectedVerificationId: decidedVerificationId },
      )
      if (!('id' in accepted)) throw new DotError('dot/invalid', accepted.message)
      return `accepted ${changeId} at ${accepted.closeout?.subjectKey ?? decidedSubjectKey}`
    }
    const rawChecks = jsonArray(args.checks)
    if (!rawChecks || rawChecks.length === 0) {
      throw new DotError('dot/invalid', 'closeout requires checks, a JSON array of {requirementRef, applicability, verdict, evidenceRefs}. Include every required item. When the input has no requirements, include an explicit goal check. Review notes belong on each check; a summary does not pass checks.')
    }
    const checks: { requirementRef: string; applicability: 'applicable' | 'not-applicable'; verdict: 'pass' | 'fail' | 'not-applicable'; evidenceRefs: string[]; note?: string }[] = []
    for (const item of rawChecks) {
      if (!item || typeof item !== 'object') throw new DotError('dot/invalid', 'each check must be an object')
      const row = item as { requirementRef?: unknown; applicability?: unknown; verdict?: unknown; evidenceRefs?: unknown; note?: unknown }
      if (typeof row.requirementRef !== 'string' || !row.requirementRef) throw new DotError('dot/invalid', 'each check needs requirementRef')
      if (row.applicability !== 'applicable' && row.applicability !== 'not-applicable') {
        throw new DotError('dot/invalid', `applicability must be applicable or not-applicable, not ${String(row.applicability)}`)
      }
      if (row.verdict !== 'pass' && row.verdict !== 'fail' && row.verdict !== 'not-applicable') {
        throw new DotError('dot/invalid', 'each check needs verdict pass, fail, or not-applicable')
      }
      if (!Array.isArray(row.evidenceRefs) || row.evidenceRefs.some(ref => typeof ref !== 'string')) {
        throw new DotError('dot/invalid', 'each check needs evidenceRefs')
      }
      if (row.verdict === 'pass' && row.evidenceRefs.length === 0) {
        throw new DotError('dot/invalid', `check ${row.requirementRef} passes with no evidence; cite run:<runId>, run:<runId>#<scenarioRef>, or file:<path>`)
      }
      checks.push({
        requirementRef: row.requirementRef,
        applicability: row.applicability,
        verdict: row.verdict,
        evidenceRefs: row.evidenceRefs,
        ...(typeof row.note === 'string' ? { note: row.note } : {}),
      })
    }
    const material = this.store.work.input(expectedRef)
    if (!material || material.changeId !== changeId) throw new DotError('dot/invalid', `unknown input ${expectedRef}`)
    const requiredReqs = material.requirements.filter(item => item.required)
    if (requiredReqs.length === 0) {
      const goal = checks.find(item => item.requirementRef === 'goal')
      if (!goal || goal.applicability !== 'applicable' || goal.verdict !== 'pass' || goal.evidenceRefs.length === 0) {
        throw new DotError('dot/invalid', 'closeout with no requirements needs an explicit goal check: applicable, verdict pass, and evidenceRefs. A summary does not pass it.')
      }
    } else {
      const covered = new Set(checks.map(item => item.requirementRef))
      const missing = requiredReqs.filter(item => !covered.has(item.requirementRef)).map(item => item.requirementRef)
      if (missing.length) throw new DotError('dot/invalid', `checks are incomplete: required ${missing.join(', ')} has no check. Add those checks. Do not remove requirements to make closeout pass.`)
    }
    const allRuns = this.store.work.listRuns().filter(run => run.changeId === changeId)
    // Same rule as accept: a rework rejection blocks only a delivery that has nothing newer.
    // A writer/rework that settled after it, a later review, or a verification already recorded after it may close out.
    // The checks on this call are not that later verification.
    const latestReject = allRuns.reduce<RunRecord | undefined>((latest, run) => {
      if (run.kind !== 'review' || run.phase !== 'stopped' || run.closeReason !== 'rework') return latest
      if (run.inputRef !== expectedRef || run.inputRevision !== expectedRevision) return latest
      if (!latest || run.updatedAt > latest.updatedAt || (run.updatedAt === latest.updatedAt && run.id > latest.id)) return run
      return latest
    }, undefined)
    if (latestReject) {
      const produced = allRuns.some(run => run.kind !== 'review' && run.createdAt > latestReject.updatedAt && (run.phase === 'completed' || run.phase === 'failed') && !!run.closureEvidence?.jobsSettled)
      const laterReview = allRuns.some(run => run.kind === 'review' && run.id !== latestReject.id && run.createdAt > latestReject.updatedAt)
      const recorded = this.store.work.latestVerification(changeId)
      const laterVerification = !!recorded && recorded.inputRef === expectedRef && recorded.inputRevision === expectedRevision && recorded.createdAt > latestReject.updatedAt
      if (!produced && !laterReview && !laterVerification) {
        throw new DotError('dot/invalid', `${latestReject.id} rejected this delivery; record a new verification after the rework`)
      }
    }
    const namedReviewId = typeof args.review_run_id === 'string' ? args.review_run_id.trim() : ''
    // Validate a named review before any host side effect: holding stops a session,
    // so a review run of another change must be refused here, not after it was held.
    const namedReview = namedReviewId ? this.store.work.run(namedReviewId) : undefined
    if (namedReviewId && (!namedReview || namedReview.changeId !== changeId || namedReview.kind !== 'review')) {
      throw new DotError('dot/invalid', `review run ${namedReviewId} is not a review of ${changeId}`)
    }
    if (namedReview && ['completed', 'failed', 'stopped'].includes(namedReview.phase)) {
      throw new DotError('dot/invalid', `review run ${namedReview.id} is already ${namedReview.phase}`)
    }
    const openReview = namedReview ?? allRuns.find(run => run.kind === 'review' && !['completed', 'failed', 'stopped'].includes(run.phase))
    // Grammar and ownership are checked before the hold stops a live session.
    for (const check of checks) for (const ref of check.evidenceRefs) {
      const parsed = parseEvidenceRef(ref)
      if (!parsed) throw this.evidenceRefHint(changeId, ref)
      if (parsed.kind === 'run') {
        const run = this.store.work.run(parsed.runId)
        if (!run || run.changeId !== changeId) throw this.evidenceRefHint(changeId, ref, `${parsed.runId} is not a run of ${changeId}.`)
      }
    }
    if (openReview) {
      const held = await this.holdWorkReview(openReview.id)
      if (!('id' in held)) throw new DotError('dot/invalid', held.message)
    }
    const subject = await this.captureWorkSubject(changeId)
    // Resolvability: the captured report must exist (one capture retry here if
    // finish missed it), the scenario must be a filled Report bullet, and the
    // file a change this delivery captured — deletions included.
    for (const check of checks) for (const ref of check.evidenceRefs) {
      const parsed = parseEvidenceRef(ref)!
      if (parsed.kind === 'run') {
        let report = this.readRunReport(parsed.runId)
        if (report === undefined && (await this.captureRunReport(parsed.runId))) report = this.readRunReport(parsed.runId)
        if (report === undefined) throw this.evidenceRefHint(changeId, ref, `no captured report for ${parsed.runId}.`)
        if (parsed.scenario && !reportBullet(report, parsed.scenario)) throw this.evidenceRefHint(changeId, ref, `run report ${parsed.runId} has no filled "### Report" bullet for ${parsed.scenario}.`)
      } else if (!subject.changes.some(item => foldRel(item.path) === foldRel(parsed.path))) {
        throw this.evidenceRefHint(changeId, ref, `file ${parsed.path} is not in this delivery.`)
      }
    }
    const writerIds = allRuns.filter(run => run.kind !== 'review' && scopeWrites(run.writeScope)).map(run => run.id)
    const listedRuns = jsonArray(args.run_ids)?.map(item => String(item))
    const runIds = listedRuns ?? writerIds
    const refreshedReview = openReview ? this.store.work.run(openReview.id) : undefined
    const recorded = await this.recordWorkVerification(
      changeId,
      checks,
      runIds,
      refreshedReview
        ? {
            inputRef: expectedRef,
            inputRevision: expectedRevision,
            reviewRunId: refreshedReview.id,
            reviewerSessionId: typeof args.session_id === 'string' ? args.session_id : refreshedReview.sessionId,
            subject,
          }
        : {
            inputRef: expectedRef,
            inputRevision: expectedRevision,
            subject,
          },
    )
    if (!('id' in recorded)) throw new DotError('dot/invalid', verifyRefusal(recorded.message))
    if (recorded.verdict !== 'accept' || !recorded.subjectKey) {
      return JSON.stringify({ id: recorded.id, verdict: recorded.verdict, inputRef: recorded.inputRef, subjectKey: recorded.subjectKey })
    }
    const latest = this.store.work.change(changeId)
    if (!latest || latest.currentInputRef !== expectedRef || latest.currentRevision !== expectedRevision) {
      throw new DotError('dot/invalid', `input moved during closeout of ${expectedRef}@${expectedRevision}. Read it again. Nothing was accepted.`)
    }
    const needsHumanDecision = latest.oversight?.requested
      && latest.oversight.inputRef === expectedRef
      && latest.oversight.inputRevision === expectedRevision
      && (latest.oversight.decision?.result !== 'accept'
        || latest.oversight.decision.verificationId !== recorded.id
        || latest.oversight.decision.subjectKey !== recorded.subjectKey)
    if (needsHumanDecision) {
      return this.decideFromTool({
        task_id: changeId,
        verification_id: recorded.id,
        expected_input_revision: expectedRevision,
        expected_subject_key: recorded.subjectKey,
      })
    }
    const accepted = await this.acceptWork(changeId, recorded.id, expectedRef, recorded.subjectKey, 'tool', {
      expectedInputRevision: expectedRevision,
      expectedVerificationId: recorded.id,
    })
    if (!('id' in accepted)) throw new DotError('dot/invalid', accepted.message)
    return `accepted ${changeId} at ${accepted.closeout?.subjectKey ?? recorded.subjectKey}`
  }

  /** The human card settles a work review. A model tool call cannot record this as the user. */
  async answerWorkReview(id: string, allow: boolean): Promise<string> {
    const view = this.pending.get(id)
    if (!view?.detail) throw new DotError('dot/unknown-request', `work review ${id} is no longer pending`)
    let binding: { changeId?: string; inputRevision?: number; verificationId?: string; subjectKey?: string }
    try { binding = JSON.parse(view.detail) as typeof binding } catch { throw new DotError('dot/invalid', `work review ${id} is not bound`) }
    if (!binding.changeId || binding.inputRevision === undefined || !binding.verificationId || !binding.subjectKey) {
      throw new DotError('dot/invalid', `work review ${id} is not bound`)
    }
    // Claim the pending answer before any write. A withdrawal or another answer that already won leaves no decision.
    if (!this.pending.answer(id, { kind: 'approval', allow })) throw new DotError('dot/unknown-request', `work review ${id} is no longer pending`)
    const noted = await this.store.work.noteOversight(binding.changeId, {
      result: allow ? 'accept' : 'reject',
      verificationId: binding.verificationId,
      subjectKey: binding.subjectKey,
      source: 'user',
      expectedInputRevision: binding.inputRevision,
    }, this.now())
    if (!('id' in noted)) throw new DotError('dot/invalid', noted.message)
    this.queueDecisionWake(noted)
    return `user ${allow ? 'accepted' : 'rejected'} ${binding.changeId}`
  }

  /** A version-matched user decision wakes dot once. It does not call decide, accept, or reject, and it does not open a session. */
  private openedDot(sessionId: string): string {
    this.backfillManagedRetryHealth()
    this.recoverDecisionWakes()
    if (this.store.selfUpgrade) {
      void this.resolveSelfUpgrade().catch(error => this.options.log?.(`dsh-dot: self-upgrade marker check failed: ${messageOf(error)}`))
    }
    return sessionId
  }

  private recoverDecisionWakes(): void {
    if (!this.store.dotSessionId) return
    for (const change of this.store.work.listChanges()) this.queueDecisionWake(change)
  }

  private queueDecisionWake(change: ChangeRecord): void {
    const decision = change.oversight?.decision
    const oversight = change.oversight
    if (!decision?.verificationId || !decision.subjectKey || !oversight) return
    if (decision.notifiedAt !== undefined || change.closeout) return
    if (oversight.inputRef !== change.currentInputRef || oversight.inputRevision !== change.currentRevision) return
    const dot = this.store.dotSessionId
    if (!dot) return
    const key = `${change.id}\0${decision.verificationId}\0${decision.subjectKey}\0${decision.at}`
    if (this.decisionWakes.has(key)) return
    this.decisionWakes.add(key)
    const reviewRunId = this.store.work.verification(decision.verificationId)?.reviewRunId
    const next = decision.result === 'accept'
      ? `call action=closeout with task_id=${change.id}, expected_input_ref=${oversight.inputRef} and expected_input_revision=${oversight.inputRevision}`
      : reviewRunId
        ? `call action=reject with task_id=${change.id}, review_run_id=${reviewRunId} and expected_input_revision=${oversight.inputRevision}, then dispatch rework`
        : 'revise the input with action=revise if the requirements changed, or dispatch a role=rework run, then closeout with fresh checks'
    this.notify({
      sessionId: dot,
      kind: 'task-human',
      wakeKey: key,
      at: this.now(),
      text: `${change.id} user ${decision.result} is already recorded for verification ${decision.verificationId}, subject ${decision.subjectKey}, input ${oversight.inputRef}@${oversight.inputRevision}. Do not call decide again and do not answer this pending request again. Next, ${next}. This wake does not accept, reject, or open a session.`,
    })
  }

  private async ackDecisionWakes(items: readonly Notice[]): Promise<void> {
    for (const item of items) {
      if (!item.wakeKey) continue
      const [changeId, verificationId, subjectKey, atText] = item.wakeKey.split('\0')
      const at = Number(atText)
      if (!changeId || !verificationId || !subjectKey || !Number.isFinite(at)) continue
      await this.store.work.markDecisionNotified(changeId, { verificationId, subjectKey, at }, this.now())
    }
  }

  /** Pending inbox rows re-queue one notice each after a restart, like undelivered wakes do. */
  private recoverInbox(): void {
    for (const record of this.inbox.list()) {
      if (record.status === 'pending') this.queueInboxNotice(record)
    }
  }

  private queueInboxNotice(record: InboxRecord): void {
    if (this.batcher.some(item => item.kind === 'inbox' && item.wakeKey === record.id)) return
    const sessionId = this.store.dotSessionId ?? ''
    const notice = this.inboxNoticeFor(record)
    this.notify({
      sessionId,
      kind: 'inbox',
      wakeKey: record.id,
      at: this.now(),
      text: notice.text,
      display: { kind: 'inbox', sessionId, summary: notice.display },
    })
  }

  /** Inbox rows the delivered batch carried become delivered; a failed relay leaves them pending. */
  private async ackInboxWakes(items: readonly Notice[]): Promise<void> {
    const ids = items.filter(item => item.kind === 'inbox' && item.wakeKey !== undefined).map(item => item.wakeKey!)
    if (ids.length > 0) await this.inbox.markDelivered(ids, this.now())
  }

  /** Continue one reserved run. Omitting access does not choose a different run, and it does not lower that run's scope. */
  private pickReserved(changeId: string, role: 'work' | 'rework' | 'review', input: { readonly runId?: string; readonly paths?: string }): RunRecord | undefined {
    const open = this.store.work.listRuns().filter(run => run.changeId === changeId && run.kind === role && !['completed', 'failed', 'stopped'].includes(run.phase))
    const reservedRuns = open.filter(run => run.phase === 'reserved')
    const wanted = input.paths ? pathScope(input.paths) : undefined
    if (input.runId) {
      const named = reservedRuns.find(run => run.id === input.runId)
      if (!named) throw new DotError('dot/invalid', `${input.runId} is not a reserved run on ${changeId}`)
      if (wanted && wanted.length > 0 && !samePathList(named, wanted)) {
        throw new DotError('dot/invalid', `${input.runId} was reserved with a different path list. Pass that run's full {path, type} list. A relative path is the same file as its absolute path under the change directory. Example: ${WRITE_PATHS_EXAMPLE}.`)
      }
      return named
    }
    if (wanted && wanted.length > 0) {
      const matches = reservedRuns.filter(run => samePathList(run, wanted))
      if (matches.length > 1) throw new DotError('dot/invalid', `${changeId} has ${matches.length} reserved runs for that scope`)
      if (matches.length === 1) return matches[0]
      const writers = open.filter(run => scopeWrites(run.writeScope))
      if (writers.length > 0) throw new DotError('dot/invalid', `${changeId} has no reserved run for that scope. Pass that run's full {path, type} list. Example: ${WRITE_PATHS_EXAMPLE}.`)
      return undefined
    }
    if (reservedRuns.length === 1) return reservedRuns[0]
    if (open.length > 0) {
      throw new DotError('dot/invalid', reservedRuns.length > 1
        ? `${changeId} has ${reservedRuns.length} reserved runs; name the run or its paths`
        : `${changeId} already has ${open.length} open runs`)
    }
    return undefined
  }

  /**
   * Release one reservation this start created, and only while the book still says it never reached the host.
   * claimSession marks creation inflight before any host find or create, and releaseUnsent repeats that check.
   * A host lookup is not required, and a failed lookup must not keep the scope.
   */
  private async releaseFreshReservation(runId: string): Promise<boolean> {
    const ready = (run: RunRecord | undefined): run is RunRecord => {
      if (!run || run.phase !== 'reserved' || run.creation !== 'intent' || run.actionClaim || run.sessionId) return false
      return !run.deliveries.some(item => item.status === 'accepted' || item.status === 'unknown' || item.hostRequestId !== undefined)
    }
    if (!ready(this.store.work.run(runId))) return false
    const prepared = await this.store.work.prepareFinish(runId, 'failed', this.now())
    if (!prepared.ok) return false
    const released = await this.store.work.releaseUnsent(runId, prepared.updatedAt, this.now())
    return released.ok === true
  }

  private async startWorkSession(input: { workspaceId?: string; cwd?: string; title: string; instruction: string; startFromWorkOrder?: boolean; goal?: string; model?: string; taskId?: string; role?: RunKind; access?: RunAccess; priority?: ChangePriority; preset?: string; checkOnly?: boolean; paths?: string; runId?: string; stepRefs?: readonly string[]; origin?: RunOrigin }): Promise<string> {
    const role = input.role ?? 'work'
    if (role !== 'work' && role !== 'rework' && role !== 'review') throw new DotError('dot/invalid', 'invalid role')
    let changeId = input.taskId
    if (!changeId && input.runId) {
      const named = this.store.work.run(input.runId)
      if (!named || named.phase !== 'reserved' || named.kind !== role) {
        throw new DotError('dot/invalid', named ? `${input.runId} is not a reserved ${role} run` : `unknown run ${input.runId}`)
      }
      changeId = named.changeId
    }
    let change = changeId ? this.store.work.change(changeId) : undefined
    if (changeId && !change) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    const workspace = input.workspaceId ? this.host.listWorkspaces().find(row => row.id === input.workspaceId) : undefined
    if (input.workspaceId && !workspace) throw new DotError('dot/unknown-workspace', `no workspace ${input.workspaceId}`)
    // action=check reports the planned scope's conflicts only; it creates nothing.
    if (input.checkOnly) {
      const cwd = change?.cwd ?? workspace?.path ?? input.cwd ?? (await this.homeWorkspace()).path
      if (!cwd || !isAbsolute(cwd)) throw new DotError('dot/invalid', 'directory must be absolute')
      const candidate = plannedOccupant(cwd, plannedScope(role, input.access, input.paths, cwd), this.rootHint(cwd))
      return (await this.scopeReport(cwd, change?.id ?? '', candidate)).text
    }
    let paths = input.paths
    if (!change) {
      const cwd = workspace?.path ?? input.cwd ?? (await this.homeWorkspace()).path
      if (!cwd || !isAbsolute(cwd)) throw new DotError('dot/invalid', 'directory must be absolute')
      const goal = input.goal?.trim() || input.instruction.trim()
      if (!goal) throw new DotError('dot/invalid', 'instruction must be non-empty')
      // A write dispatch gets the same forced isolation an explicit create does.
      const worktree = input.access === 'write' && this.selfIsolation(cwd) === 'worktree'
        ? await this.taskWorktreeFor(cwd)
        : undefined
      try {
        if (worktree !== undefined && paths) paths = this.remapSelfScopePaths(cwd, worktree.cwd, paths)
        change = await this.store.work.createChange({
          title: input.title,
          cwd: worktree?.cwd ?? cwd,
          goal,
          requirements: [{ requirementRef: 'goal', text: goal, required: true }],
          requirementsFromGoal: true,
          ...(worktree !== undefined ? {
            isolation: {
              kind: 'worktree' as const, repoRoot: worktree.repoRoot, worktree: worktree.worktree,
              branch: worktree.branch, baseSha: worktree.baseSha, state: 'active' as const, at: this.now(),
            },
          } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          at: this.now(),
        })
      } catch (error) {
        if (worktree !== undefined) {
          await removeTaskWorktree({ repoRoot: worktree.repoRoot, worktree: worktree.worktree, branch: worktree.branch, baseSha: worktree.baseSha }, this.git()).catch(() => undefined)
        }
        throw error
      }
      changeId = change.id
      void this.pruneWorkArtifactsIfNeeded()
    } else if (paths && role !== 'review' && input.access === 'write' && change.isolation?.kind === 'worktree') {
      const self = this.options.selfInstall
      if (self?.mode === 'linked' && this.sameRealPath(change.isolation.repoRoot, self.root)) {
        paths = this.remapSelfScopePaths(change.isolation.repoRoot, change.isolation.worktree, paths)
      }
    }
    // Three failed rounds on this input revision is a sign to stop, not retry.
    if (role !== 'review') {
      const failed = this.store.work.failedRounds(change.id)
      if (failed >= FAILED_ROUND_LIMIT) {
        throw new DotError('dot/invalid', `${change.id} has ${failed} failed rounds on ${change.currentInputRef}@${change.currentRevision}. Stop and ask the human before another dispatch on this input. Recommended next step: report what failed and what you recommend to the requester, then wait for their decision. action=revise after the human decides starts a fresh revision.`)
      }
    }
    const preset = await this.taskPreset(input.preset)
    const model = await this.taskModel(input.model)
    const selected = this.pickReserved(change.id, role, input)
    if (selected && input.access === 'write' && !scopeWrites(selected.writeScope)) {
      throw new DotError('dot/invalid', `${selected.id} is read-only, so access "write" does not start it. Reserve a write run with access "write" and paths covering the files. Example: paths ${WRITE_PATHS_EXAMPLE}. This run was not started.`)
    }
    if (!selected && role !== 'review' && input.access !== 'write' && paths && pathScope(paths)?.length) {
      throw new DotError('dot/invalid', `these paths are a write scope, so access must be "write", not "${input.access ?? 'read'}". Example: access "write", paths ${WRITE_PATHS_EXAMPLE}. The run was not started.`)
    }
    const scope = selected ? selected.writeScope : plannedScope(role, input.access, paths, change.cwd)
    // Changes older than the self-checkout guard can still name dot's live
    // checkout; their write runs stop here, before any reservation is taken.
    if (role !== 'review' && this.selfRunBlocked(change, selected, scope)) {
      throw new DotError('dot/self', change.isolation?.kind === 'worktree'
        ? `${change.id} targets dot's own live checkout in its write scope, so no write run starts on it.`
        : `${change.id} targets dot's own live checkout without isolation, so no write run starts on it. Create a new task for this work; it runs in a git worktree.`)
    }
    const report = await this.scopeReport(change.cwd, change.id, selected ? occupantOf(selected) : plannedOccupant(change.cwd, scope, this.rootHint(change.cwd)))
    if (scopeWrites(scope) && report.blocked) throw new DotError('dot/locked', report.text)
    const note = report.text === 'Directory lock is available.' ? '' : `\n${report.text}`
    let createdHere = false
    let runId = selected?.id
    if (!runId) {
      const reserved = await this.reserveFromTool(
        { task_id: changeId, role, access: input.access ?? 'read', ...(paths ? { paths } : {}), ...(input.stepRefs ? { step_refs: input.stepRefs } : {}) },
        input.origin,
      )
      runId = reserved.runId
      createdHere = true
    }
    // Every write run publishes its pre-write baseline before the first prompt.
    const currentRun = this.store.work.run(runId)
    if (currentRun && scopeWrites(currentRun.writeScope) && currentRun.baselineRefs.length === 0) {
      let failure: string | undefined
      try {
        const published = await this.captureWorkBaseline(runId)
        if (!('applied' in published) || !published.applied) {
          const msg = 'message' in published ? published.message : ''
          failure = msg || 'baseline was not published'
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : ''
        failure = msg || 'baseline capture failed'
      }
      if (failure !== undefined) {
        const released = createdHere ? await this.releaseFreshReservation(runId) : false
        const kept = !createdHere
          ? `${runId} was already reserved and still holds its scope so the baseline can be retried.`
          : released
            ? `${runId} was released because this start created it and it had not launched.`
            : `${runId} was not released because it is no longer an unsent reservation. It still holds its scope.`
        throw new DotError('dot/baseline', `baseline for ${runId} on ${changeId} was not published, so nothing was started: ${failure}. ${kept} ${changeId} was not cancelled.`)
      }
    }
    const instruction = input.instruction.trim()
    if (!instruction && !input.startFromWorkOrder) return `reserved ${runId} on ${changeId}${note}`
    const live = this.store.work.run(runId)
    const material = live ? this.store.work.input(live.inputRef) : undefined
    if (!live || !material) throw new DotError('dot/invalid', `unknown run ${runId}`)
    const brief = renderBrief({
      changeId: live.changeId,
      title: this.store.work.change(live.changeId)?.title ?? change.title,
      input: material,
      run: live,
      notes: instruction,
      ...(change.isolation?.kind === 'worktree' ? { isolation: change.isolation } : {}),
    })
    const launched = await this.launchWorkRun(runId, brief, preset.named ? preset.id : undefined, model)
    if (!launched.ok) return `reserved ${runId} on ${changeId}; not started: ${launched.message}${note}`
    return `started ${runId} on ${changeId}${note}`
  }

  /** The one input a never-revised change has; omitted expected-input fields mean it. */
  private soleInput(changeId: string | undefined): { readonly inputRef: string; readonly inputRevision: number } | undefined {
    if (!changeId) return undefined
    const inputs = this.store.work.inputsFor(changeId)
    const only = inputs.length === 1 ? inputs[0] : undefined
    return only && only.revision === 1 ? { inputRef: only.id, inputRevision: only.revision } : undefined
  }

  private soleInputRevision(changeId: string): number | undefined {
    return this.soleInput(changeId)?.inputRevision
  }

  /** Other changes block only where their write scope actually overlaps. This change's runs are not a lock on themselves. */
  private async scopeReport(cwd: string, exceptChangeId: string, candidate?: Occupant): Promise<{ readonly text: string; readonly blocked: boolean }> {
    let rows: Awaited<ReturnType<DotHost['listSessions']>> | undefined
    try { rows = await this.host.listSessions(new AbortController().signal) } catch { rows = undefined }
    const others = this.store.work.occupying().filter(run => run.changeId !== exceptChangeId)
    const conflicting = candidate
      ? others.filter(run => occupantsConflict(candidate, occupantOf(run)))
      : others.filter(run => run.writeScope.kind === 'workspace-exclusive' && (directoriesConflict(run.cwd, cwd) || (run.workspaceRoot !== '' && directoriesConflict(run.workspaceRoot, cwd))))
    const exclusive = conflicting.filter(run => run.writeScope.kind === 'workspace-exclusive')
    const paths = conflicting.filter(run => run.writeScope.kind === 'paths')
    const humans = (rows ?? []).filter(row => !row.archived && !row.subagent && !row.blank && !this.isDot(row.sessionId) && !this.store.work.sessionRun(row.sessionId) && !!row.cwd && directoriesConflict(row.cwd, cwd))
    const lines: string[] = []
    if (rows === undefined) lines.push('Host sessions could not be listed.')
    if (exclusive.length) lines.push(`Directory locked by ${exclusive.map(run => run.id).join(', ')}`)
    if (paths.length) lines.push(`Path reservations: ${paths.map(run => run.id).join(', ')}`)
    if (humans.length) lines.push(`Other sessions in this directory:\n${humans.map(row => `- ${row.sessionId} ${row.running ? 'RUNNING' : 'idle'}`).join('\n')}`)
    const blocked = rows === undefined || exclusive.length > 0 || paths.length > 0 || humans.some(row => row.running)
    return { text: lines.length ? lines.join('\n') : 'Directory lock is available.', blocked }
  }

  /** Resolve one scope against the workspace root, and refuse anything that leaves it. */
  private scopeTarget(root: string, scopePath: string): string {
    let absolute: string
    try { absolute = absoluteScopePath(root, scopePath) } catch (error) {
      throw new DotError('dot/invalid', error instanceof Error ? error.message : 'scope could not be resolved')
    }
    if (!scopeWithinRoot(root, scopePath)) throw new DotError('dot/invalid', `scope ${scopePath} is outside ${root}`)
    return absolute
  }

  /**
   * The id of this attempt. An existing manifest is a failed or finished snapshot
   * and stays where it is; the next attempt gets a new id. No manifest means the
   * previous save stopped early, so this attempt finishes that same directory.
   */
  private nextBaselineArtifact(runId: string, revision: number): string {
    const stem = artifactName(`base-${runId}-${revision}`)
    if (!stem) throw new DotError('dot/invalid', `${runId} has no baseline id`)
    let id = stem
    let attempt = 2
    while (existsSync(join(this.options.homeDir, 'artifacts', id, 'manifest.json'))) {
      const next = artifactName(`${stem}-a${attempt}`)
      if (!next || next === id) throw new DotError('dot/invalid', `${runId} has too many failed baseline attempts`)
      id = next
      attempt += 1
      if (attempt > 40) throw new DotError('dot/invalid', `${runId} has too many failed baseline attempts`)
    }
    return id
  }

  /** A baseline is valid only when the snapshot's captured files match the live scope. */
  private confirmBaseline(run: RunRecord, artifactRef: string): WorkRefusal | undefined {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(artifactRef) || artifactRef === '.' || artifactRef === '..') {
      return { ok: false, code: 'baseline', message: `artifact ${artifactRef} is not a single relative id` }
    }
    try {
      const manifest = readManifest(join(this.options.homeDir, 'artifacts', artifactRef))
      const captured = baselineCaptures(run, manifest)
      if (!captured.ok) return { ok: false, code: 'baseline', message: captured.reason }
      return undefined
    } catch {
      return { ok: false, code: 'baseline', message: `artifact ${artifactRef} is missing or incomplete` }
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new DotError('dot/disposed', 'dot is shutting down'))
    const run = this.lane.then(() => { this.assertOpen(); return work() })
    this.lane = run.catch(() => undefined)
    return run
  }

  /** dot's session for the next delivery: moved to a new segment first when one is due. */
  private async ready(): Promise<string> {
    const dot = await this.ensureDot()
    let reason: RolloverReason | undefined
    try { reason = await this.dueBeforeDelivery(dot) } catch (error) {
      this.options.log?.(`dsh-dot: segment check failed: ${messageOf(error)}`)
    }
    const current = reason ? await this.rollover(dot, reason) : dot
    this.applyModel(current)
    return current
  }

  /** A segment keeps the model it started with; one that still waits to be left is not switched under it. */
  private applyModel(dot: string): void {
    const frozen = this.store.segment?.model
    if (frozen === undefined || frozen === this.host.modelKey()) this.host.syncModel(dot)
  }

  /** Persona, model, agreements, cognition and capability grants as a segment starting now would freeze them. */
  private async frozen(sessionId?: string): Promise<Pick<Segment, 'persona' | 'model' | 'agreements' | 'cognition' | 'capabilities'>> {
    const model = this.host.modelKey()
    // The record freezes the grants the apply actually resolved: a grant saved
    // while the apply awaited the bundle scan must surface as a mismatch later.
    const capabilities = this.options.capabilities?.appliedSignature(sessionId)
      ?? this.options.capabilities?.signature()
    return {
      persona: personaSection(this.store.settings, this.locale),
      ...model ? { model } : {},
      agreements: agreementsSection(this.store.agreementEntries),
      cognition: cognitionSection(this.store.cognitionEntries, this.cognitionPromptEntries),
      ...capabilities !== undefined ? { capabilities } : {},
    }
  }

  /** Agreements block for a prompt that no segment record covers yet. */
  currentAgreementsBlock(): string { return agreementsSection(this.store.agreementEntries) }

  /** Cognition block for a prompt that no segment record covers yet. */
  currentCognitionBlock(): string { return cognitionSection(this.store.cognitionEntries, this.cognitionPromptEntries) }

  private repliedInEvents(events: readonly RawEvent[]): { readonly replied: boolean; readonly lastReplyAt?: number } {
    let replied = false
    let lastReplyAt: number | undefined
    for (const event of events) {
      const result = event.data as { meta?: unknown; message?: { isError?: boolean } } | undefined
      const validCard = event.type === 'tool/result' && result?.message?.isError !== true && cardText(result?.meta) !== undefined
      if (event.type !== 'assistant/message' && !validCard) continue
      replied = true
      if (typeof event.time === 'number') lastReplyAt = event.time
    }
    return { replied, ...(lastReplyAt === undefined ? {} : { lastReplyAt }) }
  }

  private async refreezeIfUnreplied(dot: string): Promise<void> {
    const segment = this.store.segment
    if (!segment || segment.sessionId !== dot || this.host.isRunning(dot)) return
    if (typeof this.host.readEvents !== 'function') return
    const events = await this.host.readEvents(dot)
    if (this.repliedInEvents(events).replied) return
    const wanted = await this.frozen()
    const capChanged = (segment.capabilities ?? EMPTY_CAPABILITIES_SIGNATURE) !== (wanted.capabilities ?? EMPTY_CAPABILITIES_SIGNATURE)
    if (capChanged) await this.host.reapplyCapabilities?.(dot)
    if (segment.persona !== wanted.persona || capChanged) await this.store.refreezeSegment(await this.frozen(dot))
  }

  /**
   * Whether dot's segment has to end before the next message reaches it.
   * Only a running turn keeps the segment; unanswered cards remain asynchronous.
   */
  private async dueBeforeDelivery(dot: string): Promise<RolloverReason | undefined> {
    const segment = this.store.segment
    if (!segment || segment.sessionId !== dot || this.host.isRunning(dot)) return undefined
    const { replied, lastReplyAt } = this.repliedInEvents(await this.host.readEvents(dot))
    // A recent cache ping also keeps the segment warm: the idle clock counts from it too.
    const lastActiveAt = Math.max(lastReplyAt ?? 0, this.lastKeepaliveAt?.sessionId === dot ? this.lastKeepaliveAt.at : 0)
    if (this.requestedSegment) return 'dot-requested'
    const wanted = await this.frozen()
    const seenAgreements = segment.agreementsSeen ?? segment.agreements ?? ''
    const seenCognition = segment.cognitionSeen ?? segment.cognition ?? ''
    const capChanged = (segment.capabilities ?? EMPTY_CAPABILITIES_SIGNATURE) !== (wanted.capabilities ?? EMPTY_CAPABILITIES_SIGNATURE)
    if (!replied) {
      // No request of this segment is cached yet, so it simply takes the current settings and blocks.
      if (capChanged) await this.host.reapplyCapabilities?.(dot)
      if (segment.persona !== wanted.persona || segment.model !== wanted.model
        || (wanted.agreements ?? '') !== (segment.agreements ?? '')
        || (wanted.cognition ?? '') !== (segment.cognition ?? '')
        || capChanged) await this.store.refreezeSegment(await this.frozen(dot))
      return undefined
    }
    const view = await this.host.dotContext(dot)
    return reasonBeforeDelivery({
      replied,
      now: this.now(),
      ...lastActiveAt > 0 ? { lastReplyAt: lastActiveAt } : {},
      ...view.usedTokens === undefined ? {} : { usedTokens: view.usedTokens },
      persona: wanted.persona,
      frozenPersona: segment.persona,
      ...wanted.model ? { model: wanted.model } : {},
      ...segment.model ? { frozenModel: segment.model } : {},
      agreements: wanted.agreements ?? '',
      seenAgreements,
      cognition: wanted.cognition ?? '',
      seenCognition,
      capabilities: wanted.capabilities,
      frozenCapabilities: segment.capabilities,
    }) ?? reasonAfterTurn(view)
  }

  /**
   * Move dot's conversation into a fresh session that opens with a handoff.
   * @returns the session dot is in afterwards: the old one when the move could not be made.
   */
  private async rollover(from: string, reason: RolloverReason): Promise<string> {
    const requestedFocus = reason === 'dot-requested' ? this.requestedSegment?.focus : undefined
    const live = reason !== 'lost'
    let events: Awaited<ReturnType<DotHost['readEvents']>> = []
    try { events = await this.host.readEvents(from) } catch (error) {
      this.options.log?.(`dsh-dot: reading the log of ${from} failed: ${messageOf(error)}`)
    }
    const fromContext = live ? await this.host.dotContext(from).catch(() => undefined) : undefined
    let summaryUsage: DotContextUsage | undefined
    const handoff = await this.handoffFrom(from, live, events, fromContext?.contextWindow, usage => {
      summaryUsage = addUsage(summaryUsage, usage)
    })
    // A turn that started while the note was being written keeps the segment; the next check moves it.
    if (live && this.host.isRunning(from)) return from
    let sessionId: string
    try {
      sessionId = await this.host.createDot(this.options.homeDir, PRESET_ID)
    } catch (error) {
      if (!live) throw error
      this.options.log?.(`dsh-dot: dot stays in ${from}; a new session could not be started: ${messageOf(error)}`)
      return from
    }
    const at = this.now()
    const reminders = this.store.schedules
    const handoffOpening = openingText({
      ...handoff ? { handoff } : {},
      reason,
      ledger: ledgerSummary(this.store.list(), this.pending.list(), at, this.store.workLedger()),
      ...reminders.length > 0 ? { reminders: scheduleLines(reminders) } : {},
      previous: from,
      at,
    })
    const opening = requestedFocus ? `${handoffOpening}\n\nWhat you chose to focus on next: ${requestedFocus}` : handoffOpening
    const endedSegmentRaw = fromContext?.usage ?? usageFromEvents(events)
    const endedUsage = addUsage(netSegmentUsage(endedSegmentRaw, from, this.store.usageOffset), summaryUsage)
    this.host.handoffView?.(from, sessionId)
    await this.store.beginSegment({
      sessionId,
      startedAt: at,
      ...await this.frozen(sessionId),
      opening,
      ...handoff ? { handoff } : {},
      reason,
    }, { reason }, endedUsage)
    this.applyModel(sessionId)
    await this.host.releaseDot(from).catch(error => { this.options.log?.(`dsh-dot: could not release ${from}: ${messageOf(error)}`) })
    this.options.log?.(`dsh-dot: dot continues in ${sessionId} (${reason}${handoff ? `, ${handoff.tier} handoff` : ''}); before it was ${from}`)
    return sessionId
  }

  /** What the ended segment hands on: its own conversation joined with what it had been handed itself. */
  private async handoffFrom(
    sessionId: string,
    live: boolean,
    events: readonly Awaited<ReturnType<DotHost['readEvents']>>[number][],
    contextWindow?: number,
    onUsage?: (usage: DotContextUsage) => void,
  ): Promise<Handoff | undefined> {
    const carried = this.store.segment?.handoff
    const failed = (what: string) => (error: unknown) => { this.options.log?.(`dsh-dot: ${what} of ${sessionId} failed: ${messageOf(error)}`) }
    const rows: TranscriptRow[] = transcriptRows(events)
    return buildHandoff({
      rows,
      ...carried ? { carried } : {},
      ...contextWindow === undefined ? {} : { contextWindow },
      ...live ? { summarize: () => this.host.summarize(sessionId, SUMMARY_INSTRUCTION, SUMMARY_MAX_TOKENS, onUsage) } : {},
      onError: failed('the handoff note'),
    })
  }

  private assertTarget(sessionId: string): void {
    if (!sessionId.trim()) throw new DotError('dot/invalid', 'session_id must be non-empty')
    if (this.isDot(sessionId)) throw new DotError('dot/invalid', 'that is dot itself')
  }
}

/** Extract explicit working-directory overrides from JSON tool arguments so retargeted shell calls cannot masquerade as in-worktree commands. */
function approvalArgCwds(rawArgs: string | undefined, baseCwd: string | undefined): readonly string[] | null {
  if (!rawArgs) return []
  let parsed: unknown
  try { parsed = JSON.parse(rawArgs) } catch { return [] }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const row = parsed as Record<string, unknown>
  const dirs: string[] = []
  for (const key of ['workdir', 'cwd', 'workingDirectory', 'working_directory']) {
    if (!Object.hasOwn(row, key) || row[key] === undefined || row[key] === null) continue
    const value = row[key]
    if (typeof value !== 'string' || !value.trim()) return null
    if (baseCwd) { dirs.push(resolve(baseCwd, value)); continue }
    if (!isAbsolute(value)) return null
    dirs.push(value)
  }
  return dirs
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
}
