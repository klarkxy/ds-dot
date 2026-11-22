/**
 * dot's orchestration core: owns the ledger, the pending requests, the
 * wake-up batches and the chain of session segments dot's conversation runs
 * in, and implements every tool and RPC on top of {@link DotHost}. The plugin
 * entry wires host events into it; the preset child plugin exposes its
 * operations as model tools.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { APPROVAL_DETAIL_LIMIT, approvalNotice } from './approval-risk.ts'
import { createTwoFilesPatch } from 'diff'
import { writerPrior, parseEvidenceRef, reportBullet, deliveryScope, scopeContainsPath, type DeliverySubject, type SubjectLook } from './acceptance.ts'
import { captureScopeAsync, defaultIgnoreCover, foldRel, ignoreCovered, isLinkReason, pruneSnapshots, readManifest, readSnapshotEntry, relativePath, saveSnapshot, scanScope, scanScopeAsync, baselineCaptures, wipeArtifacts, type SnapshotExclusion, type SnapshotSource } from './artifacts.ts'
import { attentionItems } from './board-groups.ts'
import { renderBrief, renderSupplement, runTitle } from './brief.ts'
import { bindRunSession, cancelWork, countRelayInserts, finishWork, launchReservedRun, observeRun, reconcileRun, supplementRun } from './execution.ts'
import { detectWorkspaceRoot } from './git-root.ts'
import {
  WRITE_PATHS_EXAMPLE, artifactName, constraintList, jsonArray,
  occupantOf, pathScope, plannedOccupant, plannedScope, requirementList, samePathList,
  stepList, verifyRefusal,
} from './work-actions.ts'
import { absoluteScopePath, changeIsTerminal, InputShapeError, inputContractError, occupantsConflict, scopeWithinRoot, scopeWrites, type ChangeRecord, type Constraint, type Occupant, type Requirement, type RunRecord, type WorkRefusal } from './work.ts'
import type { ShownView, ViewAnswer } from '@klarkxy/dsh-deep-view/contracts'
import { DotCards, cardAnswerText, type DotCardRecord } from './card-state.ts'
import { checkChatImages, type ChatImage } from './chat-images.ts'
import { approvalDisplay, parseNotice } from './chat-format.ts'
import { cardText } from './cards.ts'
import { NoticeBatcher, formatNotices, formatNoticeDisplay, realTimer, type Notice, type Timer } from './batcher.ts'
import { ZERO_USAGE, addUsage, combineUsage, netSegmentUsage, usageFromEvents } from './context.ts'
import { PRESET_ID, TOOL, type AttentionView, type BoardView, type DotContextSections, type DotContextUsage, type DotContextView, type FactoryResetPreview, type FactoryResetResult, type InboxEventInput, type InboxRecord, type InboxSubmitResult, type KeepaliveInfo, type KnowledgeView, type ModelChoice, type PendingKind, type PendingQuestionItem, type RecipeBody, type RecipeRecord, type ReflectionRun, type RolloverReason, type RuleConfig, type TrajectoryView } from './contracts.ts'
import { SUMMARY_INSTRUCTION, SUMMARY_MAX_TOKENS, buildHandoff, type Handoff } from './handoff.ts'
import { READ_ROWS_DEFAULT, READ_ROWS_MAX, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_SESSIONS_MAX, formatRead, formatSearch, historyRows, queryTerms, searchRows, windowRows, type SessionHits } from './history.ts'
import { InboxLedger, inboxNotice, memoryInboxTable } from './inbox.ts'
import { type DotHost, type WorkspaceRow } from './host.ts'
import { clip, ledgerSummary } from './ledger.ts'
import { directoriesConflict } from './lock.ts'
import { IdleChecker, idleCandidates } from './idle-check.ts'
import { ACCEPTED_DELIVERY_HINT, IDLE_SILENCE_HINT } from './task-hints.ts'
import { AutoUpdater, type PluginManagerLike, type UpdateStatus } from './auto-update.ts'
import { DOT_TRACE, emitDotTrace, type DotTraceInput } from './trace.ts'
import type { RunAccess, RunKind, ChangePriority } from './contracts.ts'
import { AGREEMENTS_MAX_CHARS, COGNITION_MAX_CHARS, KnowledgeError, addEntry, agreementNotesBlock, agreementsSection, cognitionSection, normalizeAgreements, normalizeCognition, removeEntry } from './memory.ts'
import { deliverPeer, guardRunWriteTool, PeerLedger, refreshChildSeals, sealChildSession, type PeerSendInput } from './peer.ts'
import { PendingHub, type PendingAnswer } from './pending.ts'
import { personaSection } from './persona.ts'
import { goalRequirements, mergeRecipeOutcomes, recipeBody, recipeBodyAt, recipeRequirements, recipeRevisionStats, recipeStatsLine, recipeVersionAt, requirementsFollowGoal, reviseRecipe as reviseRecipeRecord, sameRecipeBody, upsertRecipeOutcome, type LiveRecipeChange } from './recipes.ts'
import { ReflectionRunner } from './reflection.ts'
import { ReminderClock } from './reminders.ts'
import { routeRequest } from './rules.ts'
import { ScheduleInputError, describeTiming, scheduleLines, type ScheduleInput } from './schedule.ts'
import { KEEPALIVE_MAX_PINGS, cacheTtlMinutes, defaultCacheTtl, keepaliveIntervalMs } from './keepalive.ts'
import { EMPTY_CAPABILITIES_SIGNATURE, IDLE_MIN_TOKENS, openingText, reasonAfterTurn, reasonBeforeDelivery, type Segment } from './segments.ts'
import { parseInboxRecord } from './storage.ts'
import type { DotStore } from './store.ts'
import { factoryResetArchiveIds, factoryResetCounts, factoryResetStopGap, factoryResetTokenError, issueFactoryResetToken, type FactoryResetStopEvidence } from './factory-reset.ts'
import { formatWorkspaceFiles, listWorkspaceFiles as listWorkspaceTree, readWorkspaceText, WORKSPACE_LIST_MAX } from './workspace-inspect.ts'
import { eventTier } from './tiers.ts'
import { TaskModelError, formatTaskModels, pickTaskModel, type TaskModelCatalog } from './task-models.ts'
import { TaskPresetError, pickTaskPreset, type TaskPresetCatalog, type TaskPresetChoice } from './task-presets.ts'
import { stamp, transcriptRows, type TranscriptRow } from './transcript.ts'
import type { RawEvent } from './chat.ts'
import { SelfSettings } from './self-settings.ts'
import { approvalCardCopy, copyLocale, t, type CopyLocale } from './i18n/index.ts'
import { HIGH_RISK_TOOLS, resolveGrants, type DotCapabilities } from './capabilities.ts'
import type { CapabilityCatalogView, CapabilityGrant, CapabilityGroupView } from './contracts.ts'
import type { GateVerdict } from './tool-scope.ts'

export interface DotServiceOptions {
  readonly host: DotHost
  /** Ledger and the human's settings: rules are read live from it. */
  readonly store: DotStore
  /** Working directory of dot's own session. */
  readonly homeDir: string
  /** Preferred UI locale when known at construction time. */
  readonly locale?: CopyLocale
  /** Let original-session answerers settle approvals before waking dot. */
  readonly approvalGraceMs?: number
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
  private readonly childRefreshers = new Set<() => void>()
  private readonly childReleases = new Map<string, () => void>()
  private resetArmed?: { readonly token: string; readonly expiresAt: number }
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
      applyCognition: (text, baseVersion) => this.setCognition(text, 'reflection', baseVersion),
      isDotIdle: () => {
        const dot = this.store.dotSessionId
        return dot !== undefined && !this.options.host.isRunning(dot)
      },
      ...options.log ? { log: options.log } : {},
    })
    this.pending.onChange(() => {
      this.batcher.dropWhere(item => item.requestId !== undefined && this.pending.get(item.requestId) === undefined)
      this.armIdleCheck()
      void this.store.syncPending(this.pending.list())
    })
    this.idleChecker = new IdleChecker(
      () => this.canIdleCheck() ? idleCandidates(this.store.list(), this.pending.list(), this.store.workIdle()) : [],
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
      // The reflection check rides the reminder clock's periodic wake-up.
      onPeriodic: () => { void this.reflection.tick().catch(() => undefined) },
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
      get: id => ledger.read(id),
      put: row => ledger.write(row),
      prove: async (target, sender, deliveryId, text) => {
        try { return countRelayInserts(await this.host.readEvents(target), deliveryId, sender, text) } catch { return undefined }
      },
      relay: async (target, sender, text, deliveryId) => {
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
          await this.store.beginSegment({ sessionId, startedAt: this.now(), ...await this.frozen() })
          return this.openedDot(sessionId)
        }
        if (await this.host.resumeDot(existing, PRESET_ID)) {
          // A session from before segments existed gets its record on first use.
          if (!this.store.segment) await this.store.beginSegment({ sessionId: existing, startedAt: this.now(), ...await this.frozen() })
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

  saveApprovalDetail(detail: import('./contracts.ts').ApprovalDetail): Promise<void> {
    return this.track(() => this.store.saveApprovalDetail(detail))
  }

  readApprovalDetail(id: string): string {
    const detail = this.store.approvalDetails.find(row => row.requestId === id)
    if (!detail) throw new DotError('dot/unknown-request', `no recorded approval ${id}`)
    return JSON.stringify(detail)
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
    const entry = caps.appliedFor(dot)?.get(exec.name)
    if (!entry) return { kind: 'deny', reason: `The extra capability ${exec.name} was not applied to this segment.` }
    const live = caps.liveGrant(entry.chain)
    if (live !== 'ask' && live !== 'auto') return { kind: 'deny', reason: `The extra capability ${exec.name} is off.` }
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
    return 'next'
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
      // The host group is display-only: unattributed tools answer to per-tool grants.
      const selector = group.kind === 'host' ? '(per-tool grants only)' : `[${group.id}] grant=${grant ?? 'inherited'}`
      lines.push(`${indent}${group.label} ${selector}${group.missing === true ? ' UNAVAILABLE' : ''}`)
      const chain = group.kind === 'host' ? parents : [group.id, ...parents]
      for (const tool of group.tools) {
        if (tool.missing === true) { lines.push(`${indent}  ${tool.name} — UNAVAILABLE (grant kept)`); continue }
        let effective: string | undefined
        for (const selector of [`tool:${tool.name}`, ...chain]) { if (grants[selector] !== undefined) { effective = grants[selector]; break } }
        const flags = [tool.conditional ? 'conditional (when-gate bypassed while granted)' : '', tool.highRisk === true ? 'HIGH RISK (runs unapproved and unsandboxed)' : '', applied?.has(tool.name) ? `applied=${applied.get(tool.name)?.grant}` : 'not applied this segment'].filter(Boolean).join(', ')
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
    if (selector === 'host') throw new DotError('dot/invalid', 'unattributed tools are granted one by one with tool:<name> or prefix:<segment>; there is no host-wide grant')
    if (!/^(tool|mcp|plugin|prefix):/.test(selector)) throw new DotError('dot/invalid', 'selector must be tool:<name>, mcp:<server>, plugin:<bundle>[#<entry>], or prefix:<segment>')
    if (selector.startsWith('tool:') && caps.locked.includes(selector.slice(5))) throw new DotError('dot/invalid', `${selector.slice(5)} is a locked dot tool; it is always on and cannot be granted`)
    if (!['off', 'ask', 'auto'].includes(input.grant)) throw new DotError('dot/invalid', 'grant must be off, ask, or auto')
    const grants = { ...this.store.settings.capabilities?.grants, [selector]: input.grant }
    let reason = input.reason
    if (input.grant === 'auto') {
      // Warn the human when the merged grants would let a self-escalating tool
      // run unapproved and unsandboxed; the proposal still stands.
      const { groups } = await caps.catalog()
      const risky = [...resolveGrants(grants, groups)].filter(([name, resolved]) => resolved.grant === 'auto' && HIGH_RISK_TOOLS.has(name)).map(([name]) => name).sort()
      if (risky.length > 0) reason = `${reason}\nWarning: this makes ${risky.join(', ')} run automatically — no approval and no sandbox.`
    }
    return this.selfSettings.propose({ field: 'capabilities', value: { grants }, reason })
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
    return {
      ...factoryResetCounts(this.store, this.inbox.list().length),
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
      } catch (failure) {
        throw new DotError('dot/reset-incomplete', `Factory reset is incomplete: sessions were stopped and archived, but cleanup failed (${messageOf(failure)}). Some files may already have been removed; Dorothy's records and settings are retained. Request a new preview to retry.`)
      }
      const activeLocale = this.currentLocale ?? this.store.uiLocale
      try {
        await this.store.factoryReset(this.now())
      } catch (failure) {
        throw new DotError('dot/reset-incomplete', `Factory reset is incomplete: sessions were archived and artifact files were removed, but clearing Dorothy's records failed (${messageOf(failure)}). Request a new preview to retry the remaining cleanup.`)
      }
      this.pending.reset()
      this.diffPriors.clear()
      this.batcher.take()
      this.releaseChildSeals()
      this.reminders.refresh()
      this.updates.settingsChanged()
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

  board(): BoardView { return this.store.board(this.pending.list()) }

  /** The background "needs you" projection the panel-less watcher polls. */
  attention(): AttentionView { return { items: attentionItems(this.store.cards, this.board()) } }

  /** Self-update bookkeeping for the settings panel. */
  updateStatus(): UpdateStatus | undefined { return this.store.updateStatus }
  checkUpdates(): Promise<UpdateStatus> { return this.updates.checkNow() }

  /**
   * Let reminders come due. Called once dot's preset is registered: a reminder
   * that fires earlier could not reopen dot's session and would take it for lost.
   */
  startReminders(): void {
    if (this.closing) return
    this.reminders.start()
    this.updates.start()
    void this.reconcile().catch(error => this.options.log?.(`dsh-dot: reconciliation failed: ${messageOf(error)}`))
  }

  private canIdleCheck(): boolean {
    const dot = this.store.dotSessionId
    return !this.closing && this.store.settings.idleCheckMinutes > 0 && !!dot && !this.host.isRunning(dot) && this.batcher.size === 0
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
    if (this.canIdleCheck()) this.idleChecker.run()
    this.recoverDecisionWakes()
    this.recoverInbox()
    this.armIdleCheck()
  }
  /** The human removed a reminder in the board. */
  removeSchedule(id: string): Promise<boolean> { return this.track(() => this.reminders.remove(id)) }

  // ---- tool operations -------------------------------------------------

  overview(signal: AbortSignal, limit = 30): Promise<string> { return this.track(() => this.overviewNow(signal, limit)) }

  private async overviewNow(signal: AbortSignal, limit: number): Promise<string> {
    const rows = (await this.host.listSessions(signal))
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
  async listModels(): Promise<string> {
    return formatTaskModels(this.store.settings.taskModels, await this.catalog())
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
    try { return pickTaskPreset(catalog, requested) } catch (error) {
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
    const awaitsHost = ['finish', 'cancel', 'supplement', 'dispatch', 'check', 'closeout', 'reject'].includes(action)
    return awaitsHost ? this.manageWorkAction(args) : this.serial(() => this.manageWorkAction(args))
  }

  private async manageWorkAction(args: Record<string, unknown>): Promise<string> {
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

  read(sessionId: string, maxChars = 4000): Promise<string> { return this.track(() => this.readNow(sessionId, maxChars)) }

  private async readNow(sessionId: string, maxChars: number): Promise<string> {
    const reply = await this.host.latestReply(sessionId, Math.max(200, Math.min(maxChars, 20_000)))
    const task = this.store.task(sessionId)
    this.assertOpen()
    if (task) await this.store.markSeen(sessionId)
    const head = task ? `${task.status.toUpperCase()} "${task.title}" goal: ${task.goal}` : 'untracked session'
    return `${head}\n--- latest reply ---\n${reply ?? '(no reply yet)'}`
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
    const open = new Set(this.pending.list().filter(row => row.kind === 'approval').map(row => row.id))
    const kept = this.store.approvalDetails.filter(row => open.has(row.requestId)).slice(-APPROVAL_DETAIL_LIMIT)
    return this.store.replaceApprovalDetails(kept)
  }

  scheduleAdd(input: ScheduleInput): Promise<string> { return this.track(() => this.scheduleAddNow(input)) }

  private async scheduleAddNow(input: ScheduleInput): Promise<string> {
    try {
      const record = await this.reminders.add(input)
      return `Reminder ${record.id} "${record.title}" set (${describeTiming(record.timing)}); it first comes due ${stamp(record.nextAt)}.`
    } catch (error) {
      if (error instanceof ScheduleInputError) throw new DotError('dot/invalid', error.message)
      throw error
    }
  }

  scheduleList(): string { return scheduleLines(this.store.schedules) }

  scheduleRemove(id: string): Promise<string> { return this.track(() => this.scheduleRemoveNow(id)) }

  private async scheduleRemoveNow(id: string): Promise<string> {
    const key = id.trim()
    if (!(await this.reminders.remove(key))) throw new DotError('dot/unknown-reminder', `no reminder ${key || '(empty id)'}; ${TOOL.schedule} (action=list) shows the ones that are set`)
    return `Removed reminder ${key}.`
  }

  // ---- task recipes: saved, versioned work orders -----------------------

  manageRecipe(args: Record<string, unknown>): Promise<string> {
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
      base = {
        goal: material?.goal ?? '',
        requirements: material?.requirements ?? [],
        ...(material?.requirementsFromGoal !== undefined ? { requirementsFromGoal: material.requirementsFromGoal } : {}),
        ...(material?.constraints ? { constraints: material.constraints } : {}),
        ...(material?.deliverableLanguage ? { deliverableLanguage: material.deliverableLanguage } : {}),
        dir: change.cwd,
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

  /** Live changes tagged with a recipe, reduced to what its stats need. */
  private liveRecipeChanges(recipeId: string): LiveRecipeChange[] {
    const runs = this.store.work.listRuns()
    return this.store.work.listChanges().flatMap(change => {
      if (change.recipe?.id !== recipeId) return []
      const terminal = changeIsTerminal(change, runs.filter(run => run.changeId === change.id))
      return [{
        changeId: change.id,
        title: change.title,
        revision: change.recipe.revision,
        terminal,
        accepted: change.closeout !== undefined,
        failedRounds: terminal ? this.store.work.failedRoundsAcrossInputs(change.id) : 0,
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
      history: recipe.history.map(row => ({
        ...recipeBody(row), requirementsFromGoal: requirementsFollowGoal(row),
        revision: row.revision, name: row.name, ...(row.reason !== undefined ? { reason: row.reason } : {}), at: row.at,
      })),
      stats: recipeRevisionStats(recipe, live),
      outcomes: mergeRecipeOutcomes(recipe.outcomes, live).slice(0, 10),
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

  async knowledgeView(): Promise<KnowledgeView> {
    const undo = this.store.agreementsUndo
    return {
      agreements: { text: this.store.agreements, maxChars: AGREEMENTS_MAX_CHARS, canUndo: undo !== undefined && undo !== this.store.agreements },
      cognition: { text: this.store.cognition, maxChars: COGNITION_MAX_CHARS, history: this.store.cognitionHistory },
    }
  }

  /** dot adds one of the human's own requirements, in their words. */
  async agreementAdd(text: string): Promise<string> {
    return this.withKnowledge(async () => {
      if (this.store.settings.locks?.agreements) throw new DotError('dot/setting-locked', 'agreements are locked by the human; use dot_settings (action=propose) for the change you want')
      const before = this.store.agreements
      let after: string
      try { after = addEntry(before, text) } catch (error) {
        if (error instanceof KnowledgeError) throw new DotError(error.code, error.message)
        throw error
      }
      if (after === before) return 'That is already one of your agreements.'
      await this.store.setAgreements(after)
      await this.afterAgreementsChange(before, after, 'dot')
      return 'Recorded as an agreement. The [agreements] block of this session still shows them as they were when it started; your next session shows the new one.'
    })
  }

  /** dot drops one agreement the human asked it to drop. */
  async agreementRemove(text: string): Promise<string> {
    return this.withKnowledge(async () => {
      if (this.store.settings.locks?.agreements) throw new DotError('dot/setting-locked', 'agreements are locked by the human; use dot_settings (action=propose) for the change you want')
      const before = this.store.agreements
      let removed = ''
      let after = before
      try { const result = removeEntry(before, text); removed = result.removed; after = normalizeAgreements(result.text) } catch (error) {
        if (error instanceof KnowledgeError) throw new DotError(error.code, error.message)
        throw error
      }
      await this.store.setAgreements(after)
      await this.afterAgreementsChange(before, after, 'dot')
      return `Removed this agreement: "${removed}".`
    })
  }

  /** dot rewrites its whole cognition. */
  async cognitionRewrite(text: string): Promise<string> {
    return this.withKnowledge(async () => {
      const next = normalizeCognition(text)
      if (next.trim().length > COGNITION_MAX_CHARS) throw new DotError('dot/invalid', `cognition is at most ${COGNITION_MAX_CHARS} characters; these have ${next.trim().length}`)
      const before = this.store.cognition
      await this.store.setCognition(next, this.now())
      if (next !== before) await this.afterCognitionChange(before, next, 'dot')
      return 'Your cognition is updated. The [cognition] block of this session still shows the old text; your next session shows the new one.'
    })
  }

  /** The human rewrote the agreements in the settings view (or approved a proposal). */
  async setAgreements(text: string, by: 'human' | 'dot' = 'human'): Promise<KnowledgeView> {
    return this.withKnowledge(async () => {
      const next = normalizeAgreements(text)
      if (next.trim().length > AGREEMENTS_MAX_CHARS) throw new DotError('dot/invalid', `the agreements are at most ${AGREEMENTS_MAX_CHARS} characters; these have ${next.trim().length}`)
      const before = this.store.agreements
      if (next !== before) {
        await this.store.setAgreements(next)
        await this.afterAgreementsChange(before, next, by)
      }
      return this.knowledgeView()
    })
  }

  /** Put the agreements back to what they were before their latest change, whoever made it. */
  async undoAgreements(): Promise<KnowledgeView> {
    return this.withKnowledge(async () => {
      const before = this.store.agreements
      if (!(await this.store.undoAgreements())) throw new DotError('dot/nothing-to-undo', 'there is no earlier version of the agreements')
      await this.afterAgreementsChange(before, this.store.agreements, 'human')
      return this.knowledgeView()
    })
  }

  /** The human rewrote cognition, or the reflection pass did; neither is dot's own in-session change. */
  async setCognition(text: string, by: 'human' | 'dot' | 'reflection' = 'human', baseVersion?: number): Promise<KnowledgeView> {
    return this.withKnowledge(async () => {
      if (baseVersion !== undefined && this.store.cognitionVersion !== baseVersion) throw new DotError('dot/stale-reflection', 'cognition changed since this reflection started')
      const next = normalizeCognition(text)
      if (next.trim().length > COGNITION_MAX_CHARS) throw new DotError('dot/invalid', `cognition is at most ${COGNITION_MAX_CHARS} characters; these have ${next.trim().length}`)
      const before = this.store.cognition
      if (next !== before) {
        await this.store.setCognition(next, this.now())
        await this.afterCognitionChange(before, next, by)
      }
      return this.knowledgeView()
    })
  }

  /** Put an earlier cognition text back; the replaced text joins the history too. */
  async restoreCognition(at: number): Promise<KnowledgeView> {
    return this.withKnowledge(async () => {
      const before = this.store.cognition
      if (!(await this.store.restoreCognition(at, this.now()))) throw new DotError('dot/unknown-version', 'no earlier cognition version has that timestamp')
      if (this.store.cognition !== before) await this.afterCognitionChange(before, this.store.cognition, 'human')
      return this.knowledgeView()
    })
  }

  // ---- background reflection -------------------------------------------

  /** The submission tool calls this; the pass must be the one currently running. */
  reflectionSubmit(cognition: string, agreementNotes: string | undefined, sessionId: string): Promise<string> {
    // Same lane as `say`: a submission can never interleave with a human message
    // between reading agreementNotes and clearing them, so a fresh note is not
    // wiped by a message that carried the previous one.
    return this.serial(() => this.reflection.submit(cognition, agreementNotes, sessionId))
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
  private async afterAgreementsChange(before: string, after: string, by: 'human' | 'dot'): Promise<void> {
    if (by !== 'dot') return
    const segment = this.store.segment
    if (!segment) return
    if ((segment.agreementsSeen ?? segment.agreements ?? '') === agreementsSection(before)) await this.store.noteAgreementsSeen(agreementsSection(after))
  }

  private async afterCognitionChange(before: string, after: string, by: 'human' | 'dot' | 'reflection'): Promise<void> {
    if (by !== 'dot') return
    const segment = this.store.segment
    if (!segment) return
    if ((segment.cognitionSeen ?? segment.cognition ?? '') === cognitionSection(before)) await this.store.noteCognitionSeen(cognitionSection(after))
  }

  // ---- host events -----------------------------------------------------

  onStatus(sessionId: string, status: 'running' | 'idle'): void {
    if (this.closing) return
    if (this.isDot(sessionId)) {
      if (status === 'running') { this.idleSince = undefined; this.idleChecker.cancel() }
      else { this.idleSince ??= this.now(); this.batcher.wake(); this.armIdleCheck() }
      return
    }
    void this.store.apply({ type: 'status', sessionId, status, at: this.now() }, this.pending.list())
  }

  onTurnEnd(sessionId: string): Promise<void> {
    if (this.closing) return Promise.resolve()
    return this.track(() => this.onTurnEndNow(sessionId))
  }

  private async onTurnEndNow(sessionId: string): Promise<void> {
    const owned = this.store.work.sessionRun(sessionId)
    if (owned && owned.phase !== 'completed' && owned.phase !== 'failed' && owned.phase !== 'stopped') {
      await observeRun(this.store.work, this.runHost(), owned.id, this.now()).catch(error => {
        this.options.log?.(`dsh-dot: run ${owned.id} was not observed: ${messageOf(error)}`)
      })
    }
    if (this.isDot(sessionId) || !this.store.tracks(sessionId)) return
    const reply = await this.host.latestReply(sessionId, 600).catch(() => undefined)
    if (this.closing) return
    const task = await this.store.apply({ type: 'turn-end', sessionId, at: this.now(), ...reply ? { note: reply } : {} }, this.pending.list())
    if (!task) return
    const ownedNow = this.store.work.sessionRun(sessionId)
    const change = ownedNow ? this.store.work.change(ownedNow.changeId) : undefined
    const older = ownedNow && change && (ownedNow.inputRef !== change.currentInputRef || ownedNow.inputRevision !== change.currentRevision)
    const text = ownedNow
      ? `${ownedNow.changeId} ${ownedNow.id} input ${ownedNow.inputRef}@${ownedNow.inputRevision}${older ? ' (older input; it does not advance the current one)' : ''}: ${clip(reply ?? '(no text)', 400)}`
      : `"${task.title}" finished a turn: ${clip(reply ?? '(no text)', 400)}`
    this.notify({ sessionId, kind: 'turn-end', text, at: this.now() })
  }

  onError(sessionId: string, error: unknown): void {
    if (this.closing || this.isDot(sessionId) || !this.store.tracks(sessionId)) return
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
    const tracked = this.store.tracks(input.sessionId)
    if (!tracked && this.rules.scope === 'tracked') return { decided: 'skip' }
    const task = this.store.task(input.sessionId)
    const route = routeRequest(this.rules, input.kind)
    if (route.action === 'skip' || route.action === 'deny') return { decided: route.action }
    const run = this.store.work.sessionRun(input.sessionId)
    const notice = input.kind === 'approval'
      ? approvalNotice({
          toolName: input.toolName ?? input.subject,
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.arguments !== undefined ? { arguments: input.arguments } : {}),
          ...(input.viaSubagent ? { viaSubagent: true } : {}),
          ...(run?.access === 'read' ? { readOnly: true } : {}),
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
    })
    const runChange = run ? this.store.work.change(run.changeId) : undefined
    const where = task ? `task "${task.title}"` : `untracked session${input.cwd ? ` in ${input.cwd}` : ''}`
    const lines = [runChange ? `${opened.id} for task ${runChange.id} "${runChange.title}": ${input.kind} · "${input.subject}"` : `${opened.id} · ${input.kind} from ${where} · "${input.subject}"`]
    if (detail) lines.push(`  detail: ${notice ? detail : clip(detail, 600)}`)
    if (humanRequired && notice) lines.push(`  human-required: ${notice.reasons.join(', ')}; do not use dot_answer.`)
    if (input.kind === 'question' && route.action === 'human') lines.push('  The human must answer the original question in its session; do not use dot_answer.')
    for (const q of input.questions ?? []) {
      lines.push(`  [${q.id}] ${q.question}${q.options?.length ? ' options: ' + q.options.map(o => o.label).join(' | ') : ''}${q.multiSelect ? ' (multi)' : ''}`)
    }
    // Decisions live in the system prompt and agreements, never repeated in each notice.
    // An already-aborted request is not queued at all.
    if (this.pending.get(opened.id)) {
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

  /**
   * One external event for dot's inbox. Dedupe, subject coalescing and the
   * durable row all live in the ledger; this only queues the notice the
   * batcher will deliver. It never opens or resumes a session.
   */
  async submitInbox(input: InboxEventInput): Promise<InboxSubmitResult> {
    const done = await this.serial(() => this.inbox.submit(input, this.now()))
    // queueInboxNotice itself skips a record that already has a queued notice.
    if (done.record) this.queueInboxNotice(done.record)
    return done.result
  }

  flushNotices(): Promise<void> { return this.batcher.drain() }

  dispose(): Promise<void> {
    this.releaseChildSeals()
    if (this.disposal) return this.disposal
    this.closing = true
    this.batcher.dispose()
    this.idleChecker.cancel()
    this.cancelKeepalive()
    this.reminders.dispose()
    this.updates.dispose()
    this.pending.dispose()
    this.disposal = (async () => {
      await this.reflection.dispose()
      await this.lane
      await Promise.allSettled([...this.inFlight])
      await this.ensuring?.catch(() => undefined)
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
      await this.host.relay(dot, live[0]!.sessionId, this.formatQueuedNotices(live), undefined, undefined, formatNoticeDisplay(live))
      await this.ackDecisionWakes(live).catch(error => this.options.log?.(`dsh-dot: decision wake was not marked: ${messageOf(error)}`))
      await this.ackInboxWakes(live).catch(error => this.options.log?.(`dsh-dot: inbox event was not marked delivered: ${messageOf(error)}`))
      // Inbox records skipped by the per-batch cap get queued for the next flush.
      this.recoverInbox()
      this.emit({ event: DOT_TRACE.noticeDelivered, message: `Delivered ${live.length} notice(s).`, sessionId: dot, data: { count: live.length, kinds: live.map(item => item.kind).join(',') } })
    })
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
        const notice = inboxNotice(record)
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
  private runHost() { return bindRunSession(this.host, this.store.settings.taskPermission) }

  launchWorkRun(runId: string, text: string, preset?: string, model?: { readonly provider: string; readonly model: string }) {
    return this.launchAndRemember(runId, text, preset, model)
  }

  private async launchAndRemember(runId: string, text: string, preset?: string, model?: { readonly provider: string; readonly model: string }) {
    const launched = await launchReservedRun(this.store.work, this.runHost(), runId, text, preset, model, async () => { await this.rememberRun(runId) })
    if (launched.ok) await this.rememberRun(runId)
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
      cwd: run.cwd, at: this.now(),
    })
  }
  supplementWorkRun(runId: string, text: string, senderId: string, expected: { readonly inputRef: string; readonly inputRevision: number }) {
    return supplementRun(this.store.work, this.runHost(), runId, text, senderId, this.now(), expected)
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
  cancelWorkChange(changeId: string) {
    return cancelWork(this.store.work, this.runHost(), changeId, this.now())
  }
  async finishWorkRun(runId: string, phase: 'completed' | 'failed') {
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
  workBoard(changeId: string) { return this.store.work.workView(changeId) }
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
      if (run.creation === 'confirmed' && run.sessionId) {
        try { await this.runHost().stop(run.sessionId) } catch { /* best-effort before local lock release */ }
      }
    }
    return this.store.work.forceReleaseChange(changeId, this.now())
  }

  private async pruneWorkArtifactsIfNeeded(maxKeep?: number): Promise<void> {
    try {
      const { prunedChanges, keptArtifacts } = await this.store.pruneWorkHistory(maxKeep, async change => {
        // A tagged change records its terminal outcome on the recipe before its
        // rows are deleted; a removed recipe or an untagged change records none.
        const tag = change.recipe
        const recipe = tag ? this.taggedRecipe(change) : undefined
        if (!tag || !recipe) return
        await this.store.putRecipe(upsertRecipeOutcome(recipe, {
          changeId: change.id, title: change.title, revision: tag.revision,
          result: change.closeout ? 'accepted' : 'cancelled',
          failedRounds: this.store.work.failedRoundsAcrossInputs(change.id), at: change.updatedAt,
        }))
      })
      if (prunedChanges.length > 0) pruneSnapshots(this.options.homeDir, keptArtifacts)
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
    const prepared = await this.store.work.prepareReviewHold(runId, this.now())
    if (!prepared.ok) return prepared
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
    const run = this.store.work.run(runId)
    if (!run?.sessionId || typeof this.host.latestReply !== 'function') return false
    const reply = await this.host.latestReply(run.sessionId, 20_000).catch(() => undefined)
    if (!reply?.trim()) return false
    try {
      const dir = join(this.options.homeDir, 'artifacts', 'evidence')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${artifactName(runId)}.md`), reply)
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
      let change: ChangeRecord
      try {
        change = await this.store.work.createChange({
          title: createTitle, cwd: createDir, goal: createGoal,
          requirements,
          requirementsFromGoal: explicitRequirements === undefined && (recipe === undefined || requirementsFollowGoal(recipe)),
          ...(steps ? { steps } : {}),
          ...(createConstraints !== undefined ? { constraints: createConstraints } : {}),
          ...(userRequest !== undefined ? { userRequest } : {}),
          ...(createLanguage !== undefined ? { deliverableLanguage: createLanguage } : {}),
          ...(recipe ? { recipe: { id: recipe.id, revision: recipe.revision } } : {}),
          ...(maxConcurrentRuns !== undefined ? { maxConcurrentRuns } : {}),
          ...(typeof args.priority === 'number' ? { priority: args.priority as 1 | 2 | 3 } : {}),
          at: this.now(),
        })
      } catch (error) {
        if (error instanceof InputShapeError) throw new DotError('dot/invalid', error.message)
        throw error
      }
      const humanReview = args.human_review !== undefined ? args.human_review === true : recipe?.humanReview === true
      if (humanReview) await this.store.work.requestOversight(change.id, this.now())
      void this.pruneWorkArtifactsIfNeeded()
      const view = this.store.work.workView(change.id)
      return JSON.stringify(recipe ? { ...view, recipe: { id: recipe.id, name: recipe.name, revision: recipe.revision } } : view)
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
    const revised = await this.store.work.reviseChange(changeId, {
      ...(title !== undefined ? { title } : {}),
      ...(goal !== undefined ? { goal } : {}),
      ...(dir !== undefined ? { cwd: dir } : {}),
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

  private async reserveFromTool(args: Record<string, unknown>): Promise<{ changeId: string; runId: string; phase: RunRecord['phase']; requestedSessionId: string }> {
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
      changeId, kind: role, cwd: change.cwd, root: detectWorkspaceRoot(change.cwd),
      ...(stepRefs ? { stepRefs } : {}),
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
      maxConcurrentRuns: change.maxConcurrentRuns,
      failedRounds: this.store.work.failedRounds(changeId),
      history: this.store.work.inputsFor(changeId).map(row => ({ id: row.id, revision: row.revision, goal: row.goal })),
    })
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
    this.recoverDecisionWakes()
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
    const notice = inboxNotice(record)
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

  private async startWorkSession(input: { workspaceId?: string; cwd?: string; title: string; instruction: string; startFromWorkOrder?: boolean; goal?: string; model?: string; taskId?: string; role?: RunKind; access?: RunAccess; priority?: ChangePriority; preset?: string; checkOnly?: boolean; paths?: string; runId?: string; stepRefs?: readonly string[] }): Promise<string> {
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
      const candidate = plannedOccupant(cwd, plannedScope(role, input.access, input.paths, cwd))
      return (await this.scopeReport(cwd, change?.id ?? '', candidate)).text
    }
    if (!change) {
      const cwd = workspace?.path ?? input.cwd ?? (await this.homeWorkspace()).path
      if (!cwd || !isAbsolute(cwd)) throw new DotError('dot/invalid', 'directory must be absolute')
      const goal = input.goal?.trim() || input.instruction.trim()
      if (!goal) throw new DotError('dot/invalid', 'instruction must be non-empty')
      change = await this.store.work.createChange({
        title: input.title,
        cwd,
        goal,
        requirements: [{ requirementRef: 'goal', text: goal, required: true }],
        requirementsFromGoal: true,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        at: this.now(),
      })
      changeId = change.id
      void this.pruneWorkArtifactsIfNeeded()
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
    if (!selected && role !== 'review' && input.access !== 'write' && input.paths && pathScope(input.paths)?.length) {
      throw new DotError('dot/invalid', `these paths are a write scope, so access must be "write", not "${input.access ?? 'read'}". Example: access "write", paths ${WRITE_PATHS_EXAMPLE}. The run was not started.`)
    }
    const scope = selected ? selected.writeScope : plannedScope(role, input.access, input.paths, change.cwd)
    const report = await this.scopeReport(change.cwd, change.id, selected ? occupantOf(selected) : plannedOccupant(change.cwd, scope))
    if (scopeWrites(scope) && report.blocked) throw new DotError('dot/locked', report.text)
    const note = report.text === 'Directory lock is available.' ? '' : `\n${report.text}`
    let createdHere = false
    let runId = selected?.id
    if (!runId) {
      const reserved = await this.reserveFromTool({ task_id: changeId, role, access: input.access ?? 'read', ...(input.paths ? { paths: input.paths } : {}), ...(input.stepRefs ? { step_refs: input.stepRefs } : {}) })
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
  private async frozen(): Promise<Pick<Segment, 'persona' | 'model' | 'agreements' | 'cognition' | 'capabilities'>> {
    const model = this.host.modelKey()
    const capabilities = this.options.capabilities?.signature()
    return {
      persona: personaSection(this.store.settings, this.locale),
      ...model ? { model } : {},
      agreements: agreementsSection(this.store.agreements),
      cognition: cognitionSection(this.store.cognition),
      ...capabilities !== undefined ? { capabilities } : {},
    }
  }

  /** Agreements block for a prompt that no segment record covers yet. */
  currentAgreementsBlock(): string { return agreementsSection(this.store.agreements) }

  /** Cognition block for a prompt that no segment record covers yet. */
  currentCognitionBlock(): string { return cognitionSection(this.store.cognition) }

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
    if (segment.persona !== wanted.persona || capChanged) await this.store.refreezeSegment(wanted)
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
        || capChanged) await this.store.refreezeSegment(wanted)
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
      ...await this.frozen(),
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

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
}
