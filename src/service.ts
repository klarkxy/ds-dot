/**
 * dot's orchestration core: owns the ledger, the pending requests, the
 * wake-up batches and the chain of session segments dot's conversation runs
 * in, and implements every tool and RPC on top of {@link DotHost}. The plugin
 * entry wires host events into it; the preset child plugin exposes its
 * operations as model tools.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { APPROVAL_DETAIL_LIMIT, approvalNotice } from './approval-risk.ts'
import { writerPrior, evidenceRefGap, isForeignEvidenceId, type DeliverySubject, type SubjectLook } from './acceptance.ts'
import { captureScope, readSnapshot, saveSnapshot, baselineCaptures, sha256, wipeArtifacts, type SnapshotSource } from './artifacts.ts'
import { bindRunSession, cancelWork, countRelayInserts, finishWork, launchReservedRun, observeRun, reconcileRun, supplementRun } from './execution.ts'
import { detectWorkspaceRoot } from './git-root.ts'
import {
  assertLegacyExecutable, cancelLegacyTask, confirmLegacyTask, deleteLegacyDraft, manageLegacyTicket,
  reviewLegacyTask, setLegacyTaskPriority, startLegacyTicketSession, type LegacyTicketDeps,
} from './legacy-tickets.ts'
import {
  WRITE_PATHS_EXAMPLE, artifactName, assistantText, foldPath, jsonArray, jsonObject,
  occupantOf, pathScope, plannedOccupant, plannedScope, requirementList, samePathList,
  sameSubject, snapshotId, stepList, stringField, verifyRefusal,
} from './work-actions.ts'
import { absoluteScopePath, occupantsConflict, scopeWithinRoot, scopeWrites, type ChangeRecord, type Occupant, type RunRecord, type WorkRefusal } from './work.ts'
import type { ShownView, ViewAnswer } from '@klarkxy/dsh-deep-view/contracts'
import { DotCards, cardAnswerText, type DotCardRecord } from './card-state.ts'
import { checkChatImages, type ChatImage } from './chat-images.ts'
import { cardText } from './cards.ts'
import { NoticeBatcher, formatNotices, type Notice, type Timer } from './batcher.ts'
import { ZERO_USAGE, addUsage, combineUsage, netSegmentUsage, usageFromEvents } from './context.ts'
import { PRESET_ID, TOOL, type BoardView, type DotContextSections, type DotContextUsage, type DotContextView, type FactoryResetPreview, type FactoryResetResult, type KnowledgeView, type ModelChoice, type PendingKind, type PendingQuestionItem, type ReflectionRun, type RolloverReason, type RuleConfig, type TrajectoryView } from './contracts.ts'
import { SUMMARY_INSTRUCTION, SUMMARY_MAX_TOKENS, buildHandoff, type Handoff } from './handoff.ts'
import { READ_ROWS_DEFAULT, READ_ROWS_MAX, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_SESSIONS_MAX, formatRead, formatSearch, historyRows, queryTerms, searchRows, windowRows, type SessionHits } from './history.ts'
import { type DotHost, type WorkspaceRow } from './host.ts'
import { clip, ledgerSummary } from './ledger.ts'
import { directoriesConflict } from './lock.ts'
import { IdleChecker, idleCandidates } from './idle-check.ts'
import { ACCEPTED_DELIVERY_HINT, IDLE_SILENCE_HINT, reviewHintApplies, reviewWaitHint } from './task-hints.ts'
import { DOT_TRACE, emitDotTrace, type DotTraceInput } from './trace.ts'
import type { Ticket, TicketAccess, TicketPriority, SessionRole } from './contracts.ts'
import { AGREEMENTS_MAX_CHARS, COGNITION_MAX_CHARS, KnowledgeError, MemoryNotes, addEntry, agreementNotesBlock, agreementsSection, cognitionSection, normalizeAgreements, normalizeCognition, policyAsAgreements, removeEntry } from './memory.ts'
import { deliverPeer, PeerLedger, refreshChildSeals, sealChildSession, type PeerSendInput } from './peer.ts'
import { PendingHub, type PendingAnswer } from './pending.ts'
import { personaSection } from './persona.ts'
import { ReflectionRunner } from './reflection.ts'
import { ReminderClock } from './reminders.ts'
import { routeRequest } from './rules.ts'
import { ScheduleInputError, describeTiming, scheduleLines, type ScheduleInput } from './schedule.ts'
import { openingText, reasonAfterTurn, reasonBeforeDelivery, type Segment } from './segments.ts'
import type { DotStore } from './store.ts'
import { factoryResetArchiveIds, factoryResetCounts, factoryResetStopGap, factoryResetTokenError, issueFactoryResetToken, type FactoryResetStopEvidence } from './factory-reset.ts'
import { formatWorkspaceFiles, listWorkspaceFiles as listWorkspaceTree, WORKSPACE_LIST_MAX } from './workspace-inspect.ts'
import { eventTier } from './tiers.ts'
import { TaskModelError, formatTaskModels, pickTaskModel, type TaskModelCatalog } from './task-models.ts'
import { TaskPresetError, pickTaskPreset, type TaskPresetCatalog, type TaskPresetChoice } from './task-presets.ts'
import { stamp, transcriptRows, type TranscriptRow } from './transcript.ts'
import { SelfSettings } from './self-settings.ts'
import { APPROVAL_CARD_COPY } from './ui-copy.ts'

export interface DotServiceOptions {
  readonly host: DotHost
  /** Ledger and the human's settings: rules are read live from it. */
  readonly store: DotStore
  /** Working directory of dot's own session. */
  readonly homeDir: string
  /** The legacy note file; only the one-time migration reads it. Defaults to memory.md in homeDir. */
  readonly notes?: NoteFile
  /** Let original-session answerers settle approvals before waking dot. */
  readonly approvalGraceMs?: number
  readonly timer?: Timer
  readonly now?: () => number
  readonly log?: (message: string) => void
  /** Existing plugin logger. Absent in tests; a write failure never changes the decision. */
  readonly trace?: Parameters<typeof emitDotTrace>[0]
  /** Durable peer-delivery rows. Absent only in tests that never send one. */
  readonly peers?: PeerLedger
  /**
   * Tests of the old ticket lifecycle opt in. Production leaves this unset, so
   * ticket create/update/move, dispatch, supplement, cancel and review refuse
   * before they take a lock or start a session.
   */
  readonly legacyWorkEntries?: boolean
}

/** The legacy note files; only migration reads them, and a missing file reads as empty. */
export interface NoteFile {
  readonly path: string
  read(): Promise<string>
  /** The old cognition.md file, when the file reader also knows it. */
  readCognition?(): Promise<string>
}

/** The history tools themselves: their calls and results are not part of the record they read. */
const LOOKUP_TOOLS: ReadonlySet<string> = new Set([TOOL.searchHistory, TOOL.readHistory])

/** Sidebar title of dot's own workspace; the host keeps one title per workspace, so it is not translated. */
export const HOME_TITLE = 'Dorothy'
/** The middle of the recommended 8–12 second window; profile config may override it. */
export const APPROVAL_GRACE_MS = 10_000

export class DotError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DotError' }
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
  private ensuring: Promise<string> | undefined
  private homeRegistered = false
  private lane: Promise<unknown> = Promise.resolve()
  private closing = false
  private disposal?: Promise<void>
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly now: () => number
  private idleSince?: number
  private readonly notes: NoteFile
  /** Changes to the agreements and cognition run one at a time, so two never start from the same text. */
  private knowledgeLane: Promise<unknown> = Promise.resolve()
  /** The one-time legacy import; kept only while it runs so a failure is retried next time. */
  private migration?: Promise<void>
  private requestedSegment?: { focus?: string }
  private readonly retryingCardNotifications = new Set<string>()
  /** Decision wakes already queued in this process. The durable mark is notifiedAt. */
  private readonly decisionWakes = new Set<string>()
  private readonly childRefreshers = new Set<() => void>()
  private readonly childReleases = new Map<string, () => void>()
  private resetArmed?: { readonly token: string; readonly expiresAt: number }
  readonly cards: DotCards
  /** The single background reflection pass; the reminder clock ticks its gate. */
  readonly reflection: ReflectionRunner

  constructor(private readonly options: DotServiceOptions) {
    this.cards = new DotCards(options.store, options.log)
    this.now = options.now ?? Date.now
    this.notes = options.notes ?? new MemoryNotes(options.homeDir)
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
      () => this.canIdleCheck() ? idleCandidates(this.store.listTickets(), this.store.list(), this.pending.list(), this.store.workIdle()) : [],
      candidates => {
        this.emit({ event: DOT_TRACE.idleFired, message: 'Routine check fired.', data: { candidates: candidates.map(row => `${row.ticket.id}:${row.reason}`).join('; ') } })
        this.notify({ sessionId: this.store.dotSessionId!, kind: 'idle-check', text: `Routine check: ${candidates.map(row => `${row.ticket.id} "${row.ticket.title}": ${row.reason}`).join('; ')}\n  ${IDLE_SILENCE_HINT}`, at: this.now() })
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
  }

  get store(): DotStore { return this.options.store }
  get host(): DotHost { return this.options.host }
  get rules(): RuleConfig { return this.store.settings }
  get dotSessionId(): string | undefined { return this.store.dotSessionId }

  isDot(sessionId: string | undefined): boolean {
    return sessionId !== undefined && sessionId === this.store.dotSessionId
  }

  /** Deny child-session tools on one agent and register dot_peer. A repeat is a no-op. */
  sealAgent(agent: unknown): void {
    const sealed = sealChildSession(agent, input => this.peerSend(input), this.childRefreshers)
    const id = (agent as { session?: { id?: unknown } } | null)?.session?.id
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
        await this.host.relay(target, sender, text, deliveryId, () => this.peerTarget(target).ok)
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
        // A first run on an old install imports the legacy notes before any prompt is frozen.
        await this.ensureMigration()
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
      const message = cardReply ? cardAnswerText(card ?? cardReply.card, cardReply.answer) : body
      // A pending agreement note from the reflection pass rides the same carried
      // prefix as batched updates; it reaches dot once and is cleared after delivery.
      const agreementNotes = this.store.agreementNotes.trim()
      const carried = [
        agreementNotes ? agreementNotesBlock(agreementNotes) : '',
        notices.length > 0 ? this.formatQueuedNotices(notices) : '',
      ].filter(Boolean).join('\n\n')
      try {
        await this.host.say(dot, message, carried || undefined, cardReply?.answer, pictures.length > 0 ? pictures : undefined)
      } catch (error) {
        this.batcher.restore(this.liveNotices(notices))
        throw error
      }
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

  presentCard(shown: ShownView, callId: string, approvalId?: string) {
    return this.serial(async () => {
      if (approvalId) {
        const request = this.pending.get(approvalId)
        if (!request || request.kind !== 'approval') throw new DotError('dot/unknown-request', 'approval is no longer pending')
        shown = { title: APPROVAL_CARD_COPY.title, interactive: true, view: { type: 'stack', children: [
          { type: 'text', text: `${APPROVAL_CARD_COPY.title} ${request.id}\n${APPROVAL_CARD_COPY.session}: ${request.sessionId}\n${APPROVAL_CARD_COPY.request}: ${request.subject}${request.detail ? `\n${clip(request.detail, 1200)}` : ''}` },
          { type: 'confirm', id: 'approval', confirmLabel: APPROVAL_CARD_COPY.approve, cancelLabel: APPROVAL_CARD_COPY.deny },
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
        this.answerHumanApproval(card.approvalId, answer.values.confirmed)
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
    return this.serial(async () => {
      const dot = this.store.dotSessionId
      if (!dot) return
      await this.dueBeforeDelivery(dot)
      this.applyModel(dot)
    }).catch(error => { this.options.log?.(`dsh-dot: settings not applied to dot's session: ${messageOf(error)}`) })
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
      const replies = transcriptRows(await this.host.readEvents(sessionId)).filter(row => row.role === 'dot')
      const latest = replies.at(-1)
      if (latest) await this.store.noteConversation(latest.at, true)
      const requested = this.requestedSegment
      const reason: RolloverReason | undefined = requested ? 'dot-requested' : reasonAfterTurn(await this.host.dotContext(sessionId))
      if (!reason) return
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
    return { persona: personaSection(this.store.settings), agreements: this.currentAgreementsBlock(), cognition: this.currentCognitionBlock(), handoff: '' }
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
      ...factoryResetCounts(this.store),
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
      const archiveIds = factoryResetArchiveIds(this.store)
      const stopIds = new Set(archiveIds)
      for (const run of this.store.work.occupying()) {
        if (run.sessionId) stopIds.add(run.sessionId)
        if (run.requestedSessionId) stopIds.add(run.requestedSessionId)
      }
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
      this.pending.reset()
      this.batcher.take()
      this.idleChecker.cancel()
      this.releaseChildSeals()
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
      await this.store.factoryReset(this.now())
      await this.options.peers?.clear()
      try { wipeArtifacts(this.options.homeDir) } catch (failure) {
        this.options.log?.(`dsh-dot: factory reset did not wipe artifacts: ${messageOf(failure)}`)
      }
      this.reminders.refresh()
      this.homeRegistered = false
      this.ensuring = undefined
      this.migration = undefined
      this.requestedSegment = undefined
      const sessionId = await this.ensureDot()
      this.applyModel(sessionId)
      this.armIdleCheck()
      this.emit({
        event: DOT_TRACE.factoryReset,
        message: 'Restored Dorothy to factory settings.',
        sessionId,
        data: { archived: archived.length, archiveFailed: archiveFailed.length },
      })
      return { archived, archiveFailed, sessionId, at: this.now() }
    })
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

  /**
   * Let reminders come due. Called once dot's preset is registered: a reminder
   * that fires earlier could not reopen dot's session and would take it for lost.
   */
  startReminders(): void {
    if (this.closing) return
    this.reminders.start()
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
  reconcile(): Promise<void> { return this.track(() => this.reconcileNow()) }

  private async reconcileNow(): Promise<void> {
    const rows = await this.host.listSessions(new AbortController().signal)
    if (this.closing) return
    const byId = new Map(rows.map(row => [row.sessionId, row]))
    for (const task of this.store.list().filter(row => row.ticketId)) {
      if (this.closing) return
      const row = byId.get(task.sessionId)
      if (row && !row.archived && task.status === 'archived') await this.store.track({ sessionId: task.sessionId, origin: task.origin, title: task.title, goal: task.goal, cwd: task.cwd, at: this.now() })
      if (this.closing) return
      if (row && !row.archived && !row.running && task.status === 'error') await this.store.apply({ type: 'status', sessionId: task.sessionId, status: 'running', at: this.now() }, [])
      if (this.closing) return
      await this.store.apply(!row || row.archived ? { type: 'archived', sessionId: task.sessionId, at: this.now() } : { type: 'status', sessionId: task.sessionId, status: row.running ? 'running' : 'idle', at: this.now() }, this.pending.list())
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
    this.armIdleCheck()
  }
  /** P4 human actions call this after their durable task change. */
  notifyTaskHuman(ticketId: string, text: string): void {
    const ticket = this.store.ticket(ticketId)
    this.notify({ kind: 'task-human', ticketId, sessionId: ticket?.sessions.at(-1)?.sessionId ?? this.store.dotSessionId ?? '', text, at: this.now() })
  }

  /** A write task left active/review: tell dot which waiting todo tasks can start in that directory. */
  private announceLockFree(before: Ticket | undefined, after: Ticket): void {
    if (!before || before.access !== 'write' || (before.status !== 'active' && before.status !== 'review') || after.status === 'active' || after.status === 'review') return
    const waiting = this.store.listTickets().filter(row => row.status === 'todo' && row.access === 'write' && directoriesConflict(row.dir, before.dir))
    if (waiting.length) {
      this.emit({ event: DOT_TRACE.lockReleased, message: `Directory ${before.dir} is free.`, ticketId: before.id, data: { waiting: waiting.map(row => row.id).join(',') } })
      this.notify({ kind: 'lock-free', ticketId: before.id, sessionId: before.sessions.at(-1)?.sessionId ?? this.store.dotSessionId ?? '', text: `${before.dir} is free; ${waiting.map(row => `${row.id} "${row.title}"`).join(', ')} can start`, at: this.now() })
    }
  }

  /**
   * The human's board actions. Each one moves the task as `human` and queues a
   * task-human notice for dot; changing the priority is silent.
   */
  private legacyDeps(): LegacyTicketDeps {
    return {
      store: this.store,
      host: this.host,
      pending: this.pending,
      now: () => this.now(),
      assertOpen: () => this.assertOpen(),
      isDot: id => this.isDot(id),
      homeWorkspace: () => this.homeWorkspace(),
      taskPreset: req => this.taskPreset(req),
      taskModel: req => this.taskModel(req),
      notify: (notice, urgent) => this.notify(notice, urgent),
      notifyTaskHuman: (ticketId, text) => this.notifyTaskHuman(ticketId, text),
      announceLockFree: (before, after) => this.announceLockFree(before, after),
      emit: input => this.emit(input),
    }
  }

  confirmTask(id: string): Promise<Ticket> { return this.legacyClosed('task.confirm') ?? this.serial(() => confirmLegacyTask(this.legacyDeps(), id)) }
  deleteDraft(id: string): Promise<boolean> { return this.legacyClosed('task.delete') ?? this.serial(() => deleteLegacyDraft(this.legacyDeps(), id)) }
  cancelTask(id: string): Promise<Ticket> { return this.legacyClosed('task.cancel') ?? this.serial(() => cancelLegacyTask(this.legacyDeps(), id)) }
  reviewTask(id: string, pass: boolean, note?: string): Promise<Ticket> { return this.legacyClosed('task.review') ?? this.serial(() => reviewLegacyTask(this.legacyDeps(), id, pass, note)) }
  setTaskPriority(id: string, priority: TicketPriority): Promise<Ticket> { return this.legacyClosed('task.priority') ?? this.serial(() => setLegacyTaskPriority(this.legacyDeps(), id, priority)) }

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
    const lines = [ledgerSummary(this.store.list(), this.pending.list(), this.now(), this.store.listTickets(), this.store.workLedger()), '', '[all sessions, newest first]']
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
    const workAction = action === 'board' || action === 'accept' || action === 'reject' || action === 'revise' || action === 'reserve' || action === 'baseline' || action === 'subject' || action === 'verify' || action === 'hold' || action === 'decide' || action === 'finish' || action === 'evidence' || action === 'supplement' || action === 'pause' || action === 'resume' || action === 'cancel' || action === 'step' || action === 'dispatch' || action === 'closeout'
    const awaitsHost = action === 'finish' || action === 'hold' || action === 'cancel' || action === 'supplement' || action === 'dispatch' || action === 'closeout'
    const newRecord = this.options.legacyWorkEntries !== true && (action === 'create' || action === 'list' || action === 'read' || action === 'update')
    if (awaitsHost) return this.manageWorkAction(args)
    if (workAction || newRecord) return this.serial(() => this.manageWorkAction(args))
    if (action !== 'list' && action !== 'read') {
      const closed = this.legacyClosed(`dot_task ${action || 'update'}`)
      if (closed) return closed
    }
    return this.serial(() => manageLegacyTicket(this.legacyDeps(), args))
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
    if (action === 'dispatch') {
      return this.startWorkSession({
        title: typeof args.title === 'string' ? args.title : 'task',
        instruction: typeof args.instruction === 'string' ? args.instruction : typeof args.message === 'string' ? args.message : '',
        ...(changeId ? { taskId: changeId } : {}),
        ...(typeof args.dir === 'string' ? { cwd: args.dir } : {}),
        ...(typeof args.workspace_id === 'string' ? { workspaceId: args.workspace_id } : {}),
        ...(typeof args.goal === 'string' ? { goal: args.goal } : {}),
        ...(typeof args.role === 'string' ? { role: args.role as SessionRole } : {}),
        ...(typeof args.access === 'string' ? { access: args.access as TicketAccess } : {}),
        ...(typeof args.paths === 'string' ? { paths: args.paths } : Array.isArray(args.paths) ? { paths: JSON.stringify(args.paths) } : {}),
        ...(typeof args.run_id === 'string' ? { runId: args.run_id } : {}),
        captureBaseline: true,
      })
    }
    if (action === 'create' || action === 'revise' || action === 'update') return this.reviseOrCreate(args)
    if (action === 'supplement') return this.supplementFromTool(args)
    if (action === 'pause' || action === 'resume' || action === 'cancel') return this.controlFromTool(args)
    if (!changeId && action !== 'step') throw new DotError('dot/invalid', 'task_id is required')
    if (action === 'step') return this.stepFromTool(args)
    if (!changeId) throw new DotError('dot/invalid', 'task_id is required')
    if (action === 'closeout') return this.closeoutFromTool(args)
    if (action === 'read') return this.readWork(changeId, typeof args.input_ref === 'string' ? args.input_ref : undefined)
    if (action === 'board') {
      const view = this.workBoard(changeId)
      if (!view) throw new DotError('dot/invalid', `unknown change ${changeId}`)
      return JSON.stringify(view)
    }
    const verificationId = typeof args.verification_id === 'string' ? args.verification_id : ''
    const expectedInputRef = typeof args.expected_input_ref === 'string' ? args.expected_input_ref : ''
    const expectedSubjectKey = typeof args.expected_subject_key === 'string' ? args.expected_subject_key : ''
    const expectedInputRevision = typeof args.expected_input_revision === 'number' ? args.expected_input_revision : undefined
    if (action === 'reject') {
      const reviewRunId = typeof args.review_run_id === 'string' ? args.review_run_id : ''
      if (expectedInputRevision === undefined) throw new DotError('dot/invalid', 'reject requires expected_input_revision')
      const released = await this.rejectWork(changeId, reviewRunId, expectedInputRevision)
      if (!released.ok) throw new DotError('dot/invalid', released.message)
      return `rejected ${changeId}; review ${released.run.id} released`
    }
    if (action === 'reserve') return this.reserveFromTool(args)
    if (action === 'baseline') return this.baselineFromTool(args)
    if (action === 'subject') {
      const subject = await this.captureWorkSubject(changeId)
      return JSON.stringify({ ...subject, subjectRef: subject.artifactRef })
    }
    if (action === 'verify') return this.verifyFromTool(args)
    if (action === 'hold') return this.holdFromTool(args)
    if (action === 'finish') return this.finishFromTool(args)
    if (action === 'evidence') return this.evidenceFromTool(args)
    if (action === 'decide') return this.decideFromTool(args)
    if (expectedInputRevision === undefined || !verificationId || !expectedInputRef || !expectedSubjectKey) {
      throw new DotError('dot/invalid', 'accept requires verification_id, expected_input_ref, expected_input_revision and expected_subject_key')
    }
    const accepted = await this.acceptWork(changeId, verificationId, expectedInputRef, expectedSubjectKey, 'tool', {
      expectedInputRevision, expectedVerificationId: verificationId,
    })
    if (!('id' in accepted)) throw new DotError('dot/invalid', accepted.message)
    return `accepted ${changeId} at ${accepted.closeout?.subjectKey ?? expectedSubjectKey}`
  }

  startTask(input: { workspaceId?: string; cwd?: string; title: string; instruction: string; goal?: string; model?: string; preset?: string; taskId?: string; role?: SessionRole; access?: TicketAccess; acceptance?: string; deliverable?: string; priority?: TicketPriority; checkOnly?: boolean; paths?: string; runId?: string; captureBaseline?: boolean }, signal: AbortSignal): Promise<string> {
    if (this.options.legacyWorkEntries === true) return this.serial(() => startLegacyTicketSession(this.legacyDeps(), input, signal))
    return this.startWorkSession(input)
  }

  /** Agent-attributed delivery: the target sees dot as the sender, not the human. */
  send(sessionId: string, text: string): Promise<string> {
    return this.serial(() => {
      if (this.options.legacyWorkEntries !== true) {
        const recovery = this.store.work.recoveryError
        const task = this.store.task(sessionId)
        const run = this.store.work.sessionRun(sessionId)
        if (recovery || task?.origin === 'started' || run) {
          throw new DotError('dot/legacy-closed', recovery
            ? `dot_send is closed until work records recover: ${recovery}`
            : 'dot_send cannot continue a legacy started session or a run. Record a delivery on the run; nothing was relayed.')
        }
      }
      return this.sendNow(sessionId, text)
    })
  }

  private async sendNow(sessionId: string, text: string): Promise<string> {
    this.assertTarget(sessionId)
    const ticket = this.store.ticketForSession(sessionId)
    let queued = false
    if (!text.trim()) throw new DotError('dot/invalid', 'message must be non-empty')
    if (ticket) {
      const running = await assertLegacyExecutable(this.legacyDeps(), ticket, 'send', new AbortController().signal, sessionId)
      if (running || this.host.isRunning(sessionId)) {
        queued = true
        let verified = false
        try { verified = await this.host.verifyTaskPermission?.(sessionId, ticket.access, this.store.settings.taskPermission) === true } catch { /* fail closed */ }
        if (!verified) {
          const code = ticket.access === 'read' ? 'dot/read-only-unavailable' : 'dot/permission-failed'
          this.emit({ event: DOT_TRACE.sessionSendRefused, level: 'warn', message: `Follow-up to ${sessionId} was not delivered.`, sessionId, ticketId: ticket.id, data: { code } })
          throw new DotError(code, `cannot verify current permissions for running session ${sessionId}; no message was queued`)
        }
      } else if (ticket.access === 'read') {
        // Older sessions may have been started while the task was writable.
        // Do not change a running session's sandbox underneath an active turn.
        if (this.host.isRunning(sessionId)) throw new DotError('dot/read-only-unavailable', `session ${sessionId} is running; stop it before enforcing read-only`)
        let enforced = false
        try { enforced = await this.host.setReadOnly?.(sessionId) === true } catch { /* fail closed */ }
        if (!enforced) throw new DotError('dot/read-only-unavailable', `read-only could not be enforced for session ${sessionId}; no message was sent`)
      } else {
        if (this.host.isRunning(sessionId)) throw new DotError('dot/permission-failed', `session ${sessionId} is running; stop it before changing permissions`)
        let enforced = false
        try { enforced = await this.host.setWritable?.(sessionId, this.store.settings.taskPermission) === true } catch { /* fail closed */ }
        if (!enforced) {
          this.emit({ event: DOT_TRACE.sessionSendRefused, level: 'warn', message: `Follow-up to ${sessionId} was not delivered.`, sessionId, ticketId: ticket.id, data: { code: 'dot/permission-failed' } })
          throw new DotError('dot/permission-failed', `writable permissions could not be applied to session ${sessionId}; no message was sent; start a new work session instead`)
        }
      }
      this.assertOpen()
    }
    const delivered = text.trim()
    try {
      await this.host.relay(sessionId, this.store.dotSessionId ?? sessionId, delivered)
    } catch (error) {
      const code = error instanceof DotError ? error.code : 'dot/send-failed'
      this.emit({ event: DOT_TRACE.sessionSendRefused, level: 'warn', message: `Follow-up to ${sessionId} was not delivered.`, sessionId, ...(ticket ? { ticketId: ticket.id } : {}), data: { code } })
      throw error
    }
    this.emit({ event: DOT_TRACE.sessionSent, message: queued ? `Queued a follow-up for ${sessionId}.` : `Delivered a follow-up to ${sessionId}.`, sessionId, ...(ticket ? { ticketId: ticket.id } : {}), data: { queued } })
    const lead = queued ? `Queued for the next turn of ${sessionId}.` : `Delivered to ${sessionId}.`
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
    for (const target of targets) {
      let events
      try { events = await this.host.readEvents(target.sessionId) } catch (error) {
        if (only) throw new DotError('dot/unknown-session', `session ${only} could not be read: ${messageOf(error)}`)
        failed++
        continue
      }
      const hits = searchRows(historyRows(events, input.tools === true, LOOKUP_TOOLS), terms).reverse()
      if (hits.length > 0) groups.push({ ...target, hits })
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

  /**
   * Import the old note sources once. A persistent marker makes the import
   * idempotent: content cleared later is never pulled back in. The old files
   * and state fields are read here once only; they are never live afterwards.
   */
  private ensureMigration(): Promise<void> {
    if (this.store.knowledgeMigrated) return Promise.resolve()
    if (!this.migration && this.closing) return Promise.reject(new DotError('dot/disposed', 'dot is shutting down'))
    this.migration ??= this.runMigration().catch(error => {
      // A failed import must not look done: clear it so the next call retries, and
      // let the caller see the failure instead of silently continuing without the notes.
      this.migration = undefined
      throw error
    })
    return this.migration
  }

  private async runMigration(): Promise<void> {
    const agreementsEmpty = !this.store.agreements.trim()
    const cognitionEmpty = !this.store.cognition.trim()
    // Only read a legacy source while its target layer is still empty, as the
    // requirement says; a layer that already has content must not be blocked by
    // an unrelated old file failing to read.
    const legacyAgreements: string[] = []
    if (agreementsEmpty) {
      // The human's explicit requirements: only the old custom rules. The old notes
      // file is dot's own understanding, so it migrates into cognition below.
      // A read error is propagated so the import is not marked done and is retried.
      const policy = this.store.settings.policy ?? ''
      if (policy.trim()) legacyAgreements.push(policyAsAgreements(policy))
    }

    // dot's own understanding: the old state memory field, old cognition file and whole notes file.
    const legacyCognition: string[] = []
    let legacyUndo: string | undefined
    if (cognitionEmpty) {
      const stateMemory = this.store.legacyMemory?.trim()
      if (stateMemory) legacyCognition.push(stateMemory)
      const cognitionFile = ((await this.notes.readCognition?.()) ?? '').trim()
      if (cognitionFile) legacyCognition.push(cognitionFile)
      // The old notes file used to be the only note store; it belongs to cognition now.
      const memoryFile = (await this.notes.read()).trim()
      if (memoryFile) legacyCognition.push(memoryFile)
      // The old single-step note undo was the note text before the last change; keep it
      // as the previous cognition version (an empty undo is a real version too).
      legacyUndo = this.store.legacyMemoryUndo
    }

    // Fill a layer only while it is still empty, then mark done even when there was nothing to import.
    const patch: { agreements?: string; cognition?: string; cognitionHistory?: readonly { readonly text: string; readonly at: number }[]; knowledgeMigrated: string } = { knowledgeMigrated: '1' }
    if (agreementsEmpty && legacyAgreements.length > 0) patch.agreements = normalizeAgreements(legacyAgreements.join('\n\n'))
    if (cognitionEmpty && legacyCognition.length > 0) patch.cognition = normalizeCognition(legacyCognition.join('\n\n'))
    if (cognitionEmpty && legacyUndo !== undefined) patch.cognitionHistory = [{ text: normalizeCognition(legacyUndo), at: this.now() }]
    // Persist before flipping the marker in memory; a failed write leaves the import retryable.
    await this.store.commitKnowledgeMigration(patch)
  }

  async knowledgeView(): Promise<KnowledgeView> {
    await this.ensureMigration()
    const undo = this.store.agreementsUndo
    return {
      agreements: { text: this.store.agreements, maxChars: AGREEMENTS_MAX_CHARS, canUndo: undo !== undefined && undo !== this.store.agreements },
      cognition: { text: this.store.cognition, maxChars: COGNITION_MAX_CHARS, history: this.store.cognitionHistory },
    }
  }

  /** dot adds one of the human's own requirements, in their words. */
  async agreementAdd(text: string): Promise<string> {
    return this.withKnowledge(async () => {
      await this.ensureMigration()
      if (this.store.settings.locks?.memory) throw new DotError('dot/setting-locked', 'agreements are locked by the human; use dot_settings (action=propose) for the change you want')
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
      await this.ensureMigration()
      if (this.store.settings.locks?.memory) throw new DotError('dot/setting-locked', 'agreements are locked by the human; use dot_settings (action=propose) for the change you want')
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
      await this.ensureMigration()
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
      await this.ensureMigration()
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
      await this.ensureMigration()
      const before = this.store.agreements
      if (!(await this.store.undoAgreements())) throw new DotError('dot/nothing-to-undo', 'there is no earlier version of the agreements')
      await this.afterAgreementsChange(before, this.store.agreements, 'human')
      return this.knowledgeView()
    })
  }

  /** The human rewrote cognition, or the reflection pass did; neither is dot's own in-session change. */
  async setCognition(text: string, by: 'human' | 'dot' | 'reflection' = 'human', baseVersion?: number): Promise<KnowledgeView> {
    return this.withKnowledge(async () => {
      await this.ensureMigration()
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
      await this.ensureMigration()
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
    const ticket = this.store.ticketForSession(input.sessionId)
    const run = this.store.work.sessionRun(input.sessionId)
    const notice = input.kind === 'approval'
      ? approvalNotice({
          toolName: input.toolName ?? input.subject,
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.arguments !== undefined ? { arguments: input.arguments } : {}),
          ...(input.viaSubagent ? { viaSubagent: true } : {}),
          ...(ticket?.access === 'read' || run?.access === 'read' ? { readOnly: true } : {}),
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
    const where = task ? `task "${task.title}"` : `untracked session${input.cwd ? ` in ${input.cwd}` : ''}`
    const lines = [ticket ? `${opened.id} for task ${ticket.id} "${ticket.title}": ${input.kind} · "${input.subject}"` : `${opened.id} · ${input.kind} from ${where} · "${input.subject}"`]
    if (detail) lines.push(`  detail: ${notice ? detail : clip(detail, 600)}`)
    if (humanRequired && notice) lines.push(`  human-required: ${notice.reasons.join(', ')}; do not use dot_answer.`)
    if (input.kind === 'question' && route.action === 'human') lines.push('  The human must answer the original question in its session; do not use dot_answer.')
    for (const q of input.questions ?? []) {
      lines.push(`  [${q.id}] ${q.question}${q.options?.length ? ' options: ' + q.options.map(o => o.label).join(' | ') : ''}${q.multiSelect ? ' (multi)' : ''}`)
    }
    // Decisions live in the system prompt and agreements, never repeated in each notice.
    // An already-aborted request is not queued at all.
    if (this.pending.get(opened.id)) {
      this.emit({ event: DOT_TRACE.approvalOpened, message: `Opened ${input.kind} ${opened.id}.`, sessionId: input.sessionId, ...(ticket ? { ticketId: ticket.id } : {}), data: { requestId: opened.id, kind: input.kind } })
      this.notify({ sessionId: input.sessionId, kind: input.kind, requestId: opened.id, text: lines.join('\n'), at: this.now() }, true)
    }
    return { decided: 'pending', ...opened }
  }

  notify(notice: Notice, urgent = false): void {
    const ticket = notice.ticketId ? this.store.ticket(notice.ticketId) : this.store.ticketForSession(notice.sessionId)
    const role = ticket?.sessions.find(row => row.sessionId === notice.sessionId)?.role
    const context = role ? `${ticket!.status.toUpperCase()}, ${role}, round ${ticket!.rounds.length}` : ticket?.status.toUpperCase()
    const prefixed = ticket && notice.kind !== 'approval' && notice.kind !== 'question'
      ? `task ${ticket.id} "${ticket.title}" (${context}): ${notice.text}`
      : notice.text
    const hinted = ticket && notice.kind === 'turn-end' && reviewHintApplies({ status: ticket.status, ...(role ? { role } : {}), rounds: ticket.rounds })
      ? `${prefixed}\n  ${reviewWaitHint(ticket.rounds)}`
      : prefixed
    const enriched = ticket ? { ...notice, ticketId: ticket.id, text: hinted } : notice
    const tier = eventTier(enriched.kind, this.store.task(enriched.sessionId)?.origin)
    if (tier === 'hold') {
      this.emit({ event: DOT_TRACE.noticeHeld, message: `Held a ${enriched.kind} notice.`, ...(enriched.ticketId ? { ticketId: enriched.ticketId } : {}), sessionId: enriched.sessionId, data: { kind: enriched.kind } })
      this.batcher.hold(enriched)
    } else if (tier === 'wake') this.batcher.push(enriched, urgent, enriched.kind === 'approval' ? this.options.approvalGraceMs ?? APPROVAL_GRACE_MS : 0)
  }

  private emit(input: DotTraceInput): void {
    if (!this.options.trace) return
    emitDotTrace(this.options.trace, input)
  }

  flushNotices(): Promise<void> { return this.batcher.drain() }

  dispose(): Promise<void> {
    this.releaseChildSeals()
    if (this.disposal) return this.disposal
    this.closing = true
    this.batcher.dispose()
    this.idleChecker.cancel()
    this.reminders.dispose()
    this.pending.dispose()
    this.disposal = (async () => {
      await this.reflection.dispose()
      await this.lane
      await Promise.allSettled([...this.inFlight])
      await this.ensuring?.catch(() => undefined)
      await this.knowledgeLane
      await this.migration?.catch(() => undefined)
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
      try { await this.host.relay(dot, dot, message) } catch (error) {
        this.batcher.restore(this.liveNotices(notices))
        throw error
      }
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
      await this.host.relay(dot, live[0]!.sessionId, this.formatQueuedNotices(live))
      await this.ackDecisionWakes(live).catch(error => this.options.log?.(`dsh-dot: decision wake was not marked: ${messageOf(error)}`))
      this.emit({ event: DOT_TRACE.noticeDelivered, message: `Delivered ${live.length} notice(s).`, sessionId: dot, data: { count: live.length, kinds: live.map(item => item.kind).join(',') } })
    })
  }

  private formatQueuedNotices(items: readonly Notice[]): string {
    const tickets = this.store.listTickets()
    const ready = tickets.filter(ticket => ticket.status === 'todo' && (ticket.access === 'read' || this.store.ticketLockHolders(ticket.dir, ticket.id).length === 0)).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt).map(ticket => `${ticket.id} P${ticket.priority} ${ticket.access} ${ticket.dir} "${ticket.title}"`)
    return formatNotices(items, ready)
  }

  private liveNotices(items: readonly Notice[]): Notice[] {
    return items.filter(item => item.requestId === undefined || this.pending.get(item.requestId) !== undefined)
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

  /** The existing ledger is how a run session is owned, notified and approved. It does not create a ticket. */
  private async rememberRun(runId: string): Promise<void> {
    const run = this.store.work.run(runId)
    const sessionId = run?.sessionId
    if (!run || !sessionId || run.creation !== 'confirmed' || sessionId !== run.requestedSessionId) return
    const change = this.store.work.change(run.changeId)
    await this.store.track({
      sessionId, origin: 'started', title: change?.title ?? run.id,
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
    const inputRef = typeof args.expected_input_ref === 'string' ? args.expected_input_ref : ''
    const inputRevision = typeof args.expected_input_revision === 'number' ? args.expected_input_revision : undefined
    if (!runId || !text.trim() || !inputRef || inputRevision === undefined || !Number.isInteger(inputRevision)) {
      throw new DotError('dot/invalid', 'supplement requires run_id, message, expected_input_ref and expected_input_revision')
    }
    const namedChange = typeof args.task_id === 'string' ? args.task_id : ''
    const current = this.store.work.run(runId)
    if (namedChange && current && namedChange !== current.changeId) throw new DotError('dot/invalid', `${runId} is not a run of ${namedChange}`)
    const senderId = this.store.dotSessionId
    if (!senderId) throw new DotError('dot/not-ready', 'your conversation is not ready yet')
    const sent = await this.supplementWorkRun(runId, text, senderId, { inputRef, inputRevision })
    if (!sent.ok) throw new DotError(sent.code === 'unknown' ? 'dot/unknown' : sent.code === 'stale' ? 'dot/stale' : 'dot/invalid', sent.message)
    const delivery = [...(this.store.work.run(runId)?.deliveries ?? [])].reverse().find(item => item.kind !== 'initial' && item.contentRef === text && item.source === senderId)
    return `supplemented ${runId} delivery ${delivery?.id ?? 'recorded'} ${delivery?.status ?? sent.phase} for ${inputRef}@${inputRevision}`
  }
  cancelWorkChange(changeId: string) {
    return cancelWork(this.store.work, this.runHost(), changeId, this.now())
  }
  finishWorkRun(runId: string, phase: 'completed' | 'failed') {
    return finishWork(this.store.work, this.runHost(), runId, phase, this.now())
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
    const verification = this.store.work.verification(verificationId)
    if (verification && !verification.reviewRunId) {
      return this.store.work.acceptDirect(changeId, verificationId, expectedInputRef, expectedSubjectKey, source, this.now(), human, this.subjectLook())
    }
    return this.store.work.accept(changeId, verificationId, expectedInputRef, expectedSubjectKey, source, this.now(), human, this.subjectLook())
  }
  rejectWork(changeId: string, reviewRunId: string, expectedInputRevision: number) {
    return this.store.work.reopenAfterReview(changeId, reviewRunId, this.now(), expectedInputRevision)
  }
  resumeWorkCloseout(changeId: string) { return this.store.work.resumeCloseout(changeId, this.now()) }

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
    const files: SnapshotSource[] = []
    const seen = new Set<string>()
    for (const scope of scopes) {
      const absolute = this.scopeTarget(root, scope.path)
      let captured: { files: Parameters<typeof saveSnapshot>[1]; empty: boolean }
      try { captured = captureScope(root, absolute, scope.type) } catch (error) {
        throw new DotError('dot/invalid', error instanceof Error ? error.message : 'scope could not be read')
      }
      for (const file of captured.files) {
        const key = file.path.replaceAll('\\', '/').toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        files.push(file)
      }
    }
    const id = this.nextBaselineArtifact(run.id, this.store.work.revision)
    saveSnapshot(join(this.options.homeDir, 'artifacts', id), files, attempt?.failOn, { root, empty: files.length === 0 })
    return this.publishWorkBaseline(runId, this.store.work.revision, id)
  }

  /** Save the current workspace as the delivery subject and name what changed against the published baselines. */
  async captureWorkSubject(changeId: string): Promise<DeliverySubject> {
    const change = this.store.work.change(changeId)
    if (!change) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    const root = change.cwd
    let captured: { files: Parameters<typeof saveSnapshot>[1]; empty: boolean }
    try { captured = captureScope(root, root, 'directory') } catch (error) {
      throw new DotError('dot/invalid', error instanceof Error ? error.message : 'workspace could not be read')
    }
    const id = artifactName(`sub-${change.id}-${change.currentRevision}-${this.store.work.revision}`)
    const runs = this.store.work.listRuns().filter(run => run.changeId === change.id)
    const prior = writerPrior(change.baselineRefs, runs, ref => this.subjectLook().read(ref))
    if (prior.missing) throw new DotError('dot/invalid', `baseline ${prior.missing} is missing or incomplete`)
    const before = new Map(prior.files.map(file => [file.path.toLowerCase(), file]))
    const deleted = [...before.values()]
      .filter(entry => !captured.files.some(file => file.path.toLowerCase() === entry.path.toLowerCase()))
      .map(entry => ({ path: entry.path, deleted: true as const }))
    const manifest = saveSnapshot(join(this.options.homeDir, 'artifacts', id), [...captured.files, ...deleted], undefined, { root, empty: captured.empty && deleted.length === 0 })
    const changes: DeliverySubject['changes'][number][] = []
    const protectedDirty: string[] = []
    for (const entry of manifest.saved) {
      const prior = before.get(entry.path.toLowerCase())
      if (!prior) changes.push({ path: entry.path, kind: 'added', sha256: entry.sha256 })
      else if (prior.sha256 !== entry.sha256) changes.push({ path: entry.path, kind: 'modified', sha256: entry.sha256 })
      else protectedDirty.push(entry.path)
    }
    for (const entry of before.values()) {
      const still = manifest.saved.some(item => item.path.toLowerCase() === entry.path.toLowerCase())
      const noted = manifest.deleted.some(item => item.toLowerCase() === entry.path.toLowerCase())
      if (!still && !noted) changes.push({ path: entry.path, kind: 'deleted' })
    }
    for (const name of manifest.deleted) {
      if (!changes.some(item => item.kind === 'deleted' && item.path.toLowerCase() === name.toLowerCase())) changes.push({ path: name, kind: 'deleted' })
    }
    const subject: DeliverySubject = {
      workspaceRoot: root, cwd: root, baselineRefs: change.baselineRefs, artifactRef: id,
      changes, protectedDirty, exclusions: [],
    }
    this.rememberSubject(change.id, change.currentInputRef, change.currentRevision, subject)
    return subject
  }

  saveWorkEvidence(ref: string, body: string): void {
    if (!artifactName(ref) || artifactName(ref) !== ref) throw new DotError('dot/invalid', `evidence ${ref} is not a single relative id`)
    const dir = join(this.options.homeDir, 'artifacts', 'evidence')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ref), body)
  }

  /**
   * Read one source named by this verification.
   * The verification has to be the one requested and it has to match the current input.
   * An older input, an unbound id, or a path outside that delivery is refused before any file is opened.
   */
  readWorkSource(changeId: string, kind: 'evidence' | 'change', ref: string, bound: { readonly verificationId: string; readonly inputRef: string; readonly inputRevision: number }): { readonly ok: true; readonly source: string; readonly body: string } | { readonly ok: false; readonly code: 'missing' | 'stale' | 'invalid'; readonly message: string } {
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
    if (kind === 'evidence') {
      if (!artifactName(ref) || artifactName(ref) !== ref) return { ok: false, code: 'invalid', message: `evidence ${ref} is not a single relative id` }
      if (!verification.checks.some(check => check.evidenceRefs.includes(ref))) return { ok: false, code: 'stale', message: `${ref} is not bound to ${verification.id}` }
      try {
        const body = readFileSync(join(this.options.homeDir, 'artifacts', 'evidence', ref), 'utf8')
        if (!body) return { ok: false, code: 'missing', message: `evidence ${ref} is empty` }
        return { ok: true, source: `evidence:${ref}`, body }
      } catch {
        return { ok: false, code: 'missing', message: `evidence ${ref} is missing` }
      }
    }
    const subject = verification.subject
    const named = subject?.changes.find(item => item.path === ref)
    if (!subject || !named) return { ok: false, code: 'stale', message: `${ref} is not a delivered file of ${verification.id}` }
    if (named.kind === 'deleted' || !named.sha256) return { ok: false, code: 'missing', message: `${ref} was deleted in ${verification.id}` }
    if (!artifactName(subject.artifactRef) || artifactName(subject.artifactRef) !== subject.artifactRef) return { ok: false, code: 'invalid', message: 'delivery snapshot is not a single relative id' }
    try {
      const bodyBytes = readSnapshot(join(this.options.homeDir, 'artifacts', subject.artifactRef)).bodies.get(named.path)
      if (!bodyBytes || bodyBytes.byteLength === 0) return { ok: false, code: 'missing', message: `${ref} is missing from the delivery snapshot` }
      const maxBytes = 262_144
      const slice = bodyBytes.byteLength > maxBytes ? bodyBytes.subarray(0, maxBytes) : bodyBytes
      const decoded = new TextDecoder('utf-8', { fatal: bodyBytes.byteLength <= maxBytes }).decode(slice)
      const body = bodyBytes.byteLength > maxBytes ? `${decoded}\n… [truncated at 256 KiB; total ${bodyBytes.byteLength} bytes]` : decoded
      return { ok: true, source: `change:${named.path}`, body }
    } catch {
      return { ok: false, code: 'missing', message: `${ref} could not be read` }
    }
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
    return this.store.work.completeReviewHold(runId, prepared.updatedAt, { queueCleared: true, agentIdle: true, jobsSettled: true }, this.now())
  }

  private subjectLook(): SubjectLook {
    const root = join(this.options.homeDir, 'artifacts')
    return {
      read: ref => {
        if (!artifactName(ref) || artifactName(ref) !== ref) return undefined
        try {
          const manifest = readSnapshot(join(root, ref)).manifest
          return { root: manifest.root, saved: manifest.saved, deleted: manifest.deleted }
        } catch { return undefined }
      },
      evidence: ref => {
        if (!artifactName(ref) || artifactName(ref) !== ref) return false
        try { return readFileSync(join(root, 'evidence', ref)).byteLength > 0 } catch { return false }
      },
      live: workspaceRoot => {
        try { return captureScope(workspaceRoot, workspaceRoot, 'directory').files.map(file => file.path) } catch { return undefined }
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
    const requirements = requirementList(args.requirements)
    const steps = args.steps === undefined ? undefined : stepList(args.steps)
    const behaviorNotes = text('behavior_notes')
    const maxConcurrentRuns = typeof args.max_concurrent === 'number' ? args.max_concurrent : undefined
    if (action === 'create') {
      if (!title?.trim() || !goal?.trim() || !dir || !isAbsolute(dir)) throw new DotError('dot/invalid', 'title, goal and an absolute dir are required')
      const change = await this.store.work.createChange({
        title, cwd: dir, goal,
        requirements: requirements ?? [{ requirementRef: 'goal', text: goal, required: true }],
        ...(steps ? { steps } : {}),
        ...(behaviorNotes !== undefined ? { behaviorNotes } : {}),
        ...(maxConcurrentRuns !== undefined ? { maxConcurrentRuns } : {}),
        ...(typeof args.priority === 'number' ? { priority: args.priority as 1 | 2 | 3 } : {}),
        at: this.now(),
      })
      if (args.human_review === true) await this.store.work.requestOversight(change.id, this.now())
      return JSON.stringify(this.store.work.workView(change.id))
    }
    const changeId = text('task_id') ?? ''
    if (!changeId) throw new DotError('dot/invalid', 'task_id is required')
    const revised = await this.store.work.reviseChange(changeId, {
      ...(title !== undefined ? { title } : {}),
      ...(goal !== undefined ? { goal } : {}),
      ...(dir !== undefined ? { cwd: dir } : {}),
      ...(requirements ? { requirements } : {}),
      ...(steps ? { steps } : {}),
      ...(behaviorNotes !== undefined ? { behaviorNotes } : {}),
      ...(maxConcurrentRuns !== undefined ? { maxConcurrentRuns } : {}),
      ...(typeof args.priority === 'number' ? { priority: args.priority as 1 | 2 | 3 } : {}),
      at: this.now(),
    })
    if (!('id' in revised)) throw new DotError('dot/invalid', revised.message)
    if (args.human_review === true) await this.store.work.requestOversight(revised.id, this.now())
    return JSON.stringify(this.store.work.workView(revised.id))
  }

  private async reserveFromTool(args: Record<string, unknown>): Promise<string> {
    const changeId = typeof args.task_id === 'string' ? args.task_id : ''
    const role = typeof args.role === 'string' ? args.role : 'work'
    if (role !== 'work' && role !== 'rework' && role !== 'review') throw new DotError('dot/invalid', 'invalid role')
    const change = this.store.work.change(changeId)
    if (!change) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    const write = role === 'review' || args.access === 'write'
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
    return JSON.stringify({ changeId, runId: reserved.run.id, phase: reserved.run.phase, requestedSessionId: reserved.run.requestedSessionId })
  }

  private readWork(changeId: string, inputRef?: string): string {
    const change = this.store.work.change(changeId)
    if (!change) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    if (inputRef) {
      const row = this.store.work.input(inputRef)
      if (!row || row.changeId !== changeId) throw new DotError('dot/invalid', `unknown input ${inputRef}`)
      return JSON.stringify(row)
    }
    const view = this.workBoard(changeId)
    const material = this.store.work.input(change.currentInputRef)
    return JSON.stringify({
      ...view,
      goal: material?.goal,
      requirements: material?.requirements ?? [],
      steps: change.steps.map(step => ({
        stepRef: step.stepRef,
        text: material?.steps.find(item => item.stepRef === step.stepRef)?.text ?? '',
        done: step.done,
        inputRef: step.inputRef,
        ...(step.runId ? { runId: step.runId } : {}),
        ...(step.subjectRef ? { subjectRef: step.subjectRef } : {}),
      })),
      behaviorNotes: material?.behaviorNotes ?? null,
      maxConcurrentRuns: change.maxConcurrentRuns,
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
    const expectedInputRevision = typeof args.expected_input_revision === 'number' ? args.expected_input_revision : undefined
    if (!changeId || !stepRef || !runId || expectedInputRevision === undefined) {
      throw new DotError('dot/invalid', 'step requires task_id, step_ref, run_id and expected_input_revision')
    }
    const run = this.store.work.run(runId)
    const subject = run ? (this.scopeResult(run) ?? await this.eventResult(run) ?? '') : ''
    const noted = await this.store.work.noteStep(changeId, stepRef, runId, expectedInputRevision, subject, this.now())
    if (!('id' in noted)) throw new DotError('dot/invalid', noted.message)
    return `step ${stepRef} done on ${changeId} by ${runId}`
  }

  /**
   * A file this run changed after its baseline, while it still holds that scope.
   * After release, the live tree may belong to the next writer. Do not read it back as this run's result.
   */
  private scopeResult(run: RunRecord): string | undefined {
    if (!scopeWrites(run.writeScope) || run.phase === 'reserved') return undefined
    if (!this.store.work.occupying().some(row => row.id === run.id)) return undefined
    const ref = run.baselineRefs.at(-1)
    if (!ref) return undefined
    let prior = new Map<string, string>()
    try {
      const manifest = readSnapshot(join(this.options.homeDir, 'artifacts', ref.artifactRef)).manifest
      prior = new Map(manifest.saved.map(item => [foldPath(item.path), item.sha256]))
    } catch { return undefined }
    const root = run.workspaceRoot
    const scopes = run.writeScope.kind === 'workspace-exclusive'
      ? [{ path: root, type: 'directory' as const }]
      : run.writeScope.paths
    const found: string[] = []
    for (const scope of scopes) {
      let target: string
      try { target = this.scopeTarget(root, scope.path) } catch { continue }
      let captured: { files: SnapshotSource[] }
      try { captured = captureScope(root, target, scope.type) } catch { continue }
      for (const file of captured.files) {
        if (!file.body) continue
        const hash = sha256(file.body)
        if (prior.get(foldPath(file.path)) === hash) continue
        found.push(`file:${file.path}:${hash}`)
      }
    }
    found.sort()
    return found[0]
  }

  /** An assistant result on this run's own session. Another run's events do not count. */
  private async eventResult(run: RunRecord): Promise<string | undefined> {
    const sessionId = run.sessionId
    if (run.phase === 'reserved' || run.creation !== 'confirmed' || !sessionId || sessionId !== run.requestedSessionId) return undefined
    let events: readonly { type?: string; seq?: number; data?: unknown }[] = []
    try { events = await this.host.readEvents(sessionId) } catch { return undefined }
    const instruction = run.deliveries.find(item => item.kind === 'initial')?.contentRef.trim()
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]
      if (!event || event.type !== 'assistant/message') continue
      const text = assistantText(event).trim()
      if (!text || text === instruction) continue
      const seq = typeof event.seq === 'number' ? event.seq : index
      return `event:${sessionId}:${seq}:${sha256(new TextEncoder().encode(text)).slice(0, 16)}`
    }
    return undefined
  }

  private async baselineFromTool(args: Record<string, unknown>): Promise<string> {
    const runId = typeof args.run_id === 'string' ? args.run_id : ''
    if (!runId) throw new DotError('dot/invalid', 'run_id is required')
    const published = await this.captureWorkBaseline(runId)
    if (!('applied' in published) || !published.applied) throw new DotError('dot/invalid', 'message' in published ? published.message : 'baseline was not published')
    return `baseline ${published.run.baselineRefs.at(-1)?.artifactRef ?? ''} on ${runId}`
  }

  private async verifyFromTool(args: Record<string, unknown>): Promise<string> {
    const changeId = typeof args.task_id === 'string' ? args.task_id : ''
    if (!changeId) throw new DotError('dot/invalid', 'verify requires task_id. Read the current change, then call action=subject.')
    const change = this.store.work.change(changeId)
    if (!change) throw new DotError('dot/invalid', `unknown change ${changeId}. Read the task list. Do not edit checks.`)
    const checks = jsonArray(args.checks)
    if (!checks) {
      throw new DotError('dot/invalid', 'verify checks must be a JSON array of {requirementRef, applicability, verdict, evidenceRefs}. evidenceRefs must be evidence_ref values returned by action=evidence. Include every required requirement. Do not shrink the list.')
    }
    for (const check of checks) {
      const applicability = check && typeof check === 'object' ? (check as { applicability?: unknown }).applicability : undefined
      if (applicability !== 'applicable' && applicability !== 'not-applicable') {
        throw new DotError('dot/invalid', `applicability must be applicable or not-applicable, not ${String(applicability)}. Fix this check. Do not drop it or shrink the requirement list.`)
      }
      const refs = check && typeof check === 'object' ? (check as { evidenceRefs?: unknown }).evidenceRefs : undefined
      if (!Array.isArray(refs)) {
        throw new DotError('dot/invalid', 'each check needs evidenceRefs, an array of evidence_ref values from action=evidence. Do not put a snapshot, baseline, or session id there, and do not shrink the list.')
      }
      for (const ref of refs) {
        const gap = typeof ref === 'string' ? evidenceRefGap(ref, this.registeredEvidence(ref)) : evidenceRefGap('missing', false)
        if (gap) throw new DotError('dot/invalid', `${gap} Do not edit checks to drop this item.`)
      }
    }
    const subject = this.subjectForVerify(change, args)
    const expectedRef = typeof args.expected_input_ref === 'string' ? args.expected_input_ref : ''
    const expectedRevision = typeof args.expected_input_revision === 'number' ? args.expected_input_revision : undefined
    if (!expectedRef || expectedRevision === undefined) {
      throw new DotError('dot/invalid', `verify requires expected_input_ref and expected_input_revision for ${change.currentInputRef}@${change.currentRevision}. Read the current input. Do not edit checks.`)
    }
    if (expectedRef !== change.currentInputRef || expectedRevision !== change.currentRevision) {
      throw new DotError('dot/invalid', `expected input ${expectedRef}@${expectedRevision} is not current ${change.currentInputRef}@${change.currentRevision}. Call action=subject again. Do not edit checks.`)
    }
    const material = this.store.work.input(change.currentInputRef)
    const covered = new Set(checks.map(check => check && typeof check === 'object' ? (check as { requirementRef?: unknown }).requirementRef : undefined))
    const missing = (material?.requirements ?? []).filter(item => item.required && !covered.has(item.requirementRef)).map(item => item.requirementRef)
    if (missing.length) {
      throw new DotError('dot/invalid', `checks are incomplete: required ${missing.join(', ')} has no check. Add those checks. Do not remove requirements to make verify pass.`)
    }
    const listed = jsonArray(args.run_ids)
    const runIds = listed ? listed.map(item => String(item)) : typeof args.run_id === 'string' && args.run_id ? [args.run_id] : []
    const recorded = await this.recordWorkVerification(changeId, checks as Parameters<DotStore['work']['recordVerification']>[1], runIds, {
      inputRef: expectedRef,
      inputRevision: expectedRevision,
      reviewRunId: typeof args.review_run_id === 'string' ? args.review_run_id : undefined,
      reviewerSessionId: typeof args.session_id === 'string' ? args.session_id : undefined,
      subject,
    })
    if (!('id' in recorded)) throw new DotError('dot/invalid', verifyRefusal(recorded.message))
    return JSON.stringify({ id: recorded.id, verdict: recorded.verdict, inputRef: recorded.inputRef, subjectKey: recorded.subjectKey })
  }

  /** The delivery captured for this change and input. A snapshot id or a trimmed object is not accepted. */
  private subjectForVerify(change: { readonly id: string; readonly currentInputRef: string; readonly currentRevision: number }, args: Record<string, unknown>): DeliverySubject {
    const requested = typeof args.subject_ref === 'string' ? args.subject_ref.trim() : ''
    const raw = args.subject
    const id = snapshotId(raw)
    if (!requested && id) {
      throw new DotError('dot/invalid', `subject ${id} is a snapshot id, not the delivery. Call action=subject and pass its subjectRef as subject_ref. Do not put the id in subject, and do not edit checks.`)
    }
    const ref = requested || (raw && typeof raw === 'object' && !Array.isArray(raw) ? stringField(raw, 'artifactRef') : '') || (jsonObject(raw) ? stringField(jsonObject(raw), 'artifactRef') : '')
    if (!ref) {
      throw new DotError('dot/invalid', 'verify needs subject_ref from action=subject, or the full JSON object that call returned. A snapshot id is not the subject. Do not edit checks.')
    }
    const stored = this.readStoredSubject(ref)
    if (!stored) {
      throw new DotError('dot/invalid', `subject_ref ${ref} is not a captured delivery. Call action=subject and pass the subjectRef it returns. Do not invent the object, and do not edit checks.`)
    }
    if (stored.changeId !== change.id) {
      throw new DotError('dot/invalid', `subject_ref ${ref} belongs to ${stored.changeId}, not ${change.id}. Call action=subject on ${change.id}. Do not edit checks.`)
    }
    if (stored.inputRef !== change.currentInputRef || stored.inputRevision !== change.currentRevision) {
      throw new DotError('dot/invalid', `subject_ref ${ref} is for ${stored.inputRef}@${stored.inputRevision}, current is ${change.currentInputRef}@${change.currentRevision}. Call action=subject again. Do not edit checks.`)
    }
    const parsed = jsonObject(raw)
    if (parsed && !sameSubject(stored.subject, parsed)) {
      throw new DotError('dot/invalid', `subject does not match captured delivery ${ref}. Pass subject_ref, or the unchanged object from action=subject. Do not drop scopeKey, changes, or baselines, and do not edit checks.`)
    }
    return stored.subject
  }

  private rememberSubject(changeId: string, inputRef: string, inputRevision: number, subject: DeliverySubject): void {
    if (!artifactName(subject.artifactRef) || artifactName(subject.artifactRef) !== subject.artifactRef) {
      throw new DotError('dot/invalid', `subject ${subject.artifactRef} is not a single relative id`)
    }
    const dir = join(this.options.homeDir, 'artifacts', 'subjects')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${subject.artifactRef}.json`)
    if (existsSync(path)) return
    writeFileSync(path, JSON.stringify({ changeId, inputRef, inputRevision, subject }))
  }

  private readStoredSubject(ref: string): { readonly changeId: string; readonly inputRef: string; readonly inputRevision: number; readonly subject: DeliverySubject } | undefined {
    if (!artifactName(ref) || artifactName(ref) !== ref) return undefined
    try {
      const parsed = JSON.parse(readFileSync(join(this.options.homeDir, 'artifacts', 'subjects', `${ref}.json`), 'utf8')) as { changeId?: unknown; inputRef?: unknown; inputRevision?: unknown; subject?: unknown }
      if (typeof parsed.changeId !== 'string' || typeof parsed.inputRef !== 'string' || typeof parsed.inputRevision !== 'number' || !parsed.subject || typeof parsed.subject !== 'object') return undefined
      return { changeId: parsed.changeId, inputRef: parsed.inputRef, inputRevision: parsed.inputRevision, subject: parsed.subject as DeliverySubject }
    } catch { return undefined }
  }

  private async evidenceFromTool(args: Record<string, unknown>): Promise<string> {
    const ref = typeof args.evidence_ref === 'string' ? args.evidence_ref : ''
    const body = typeof args.summary === 'string' ? args.summary : ''
    if (!ref || !body) throw new DotError('dot/invalid', 'evidence requires evidence_ref and summary. evidence_ref is the id you will put in evidenceRefs. It is not a snapshot id, baseline id, or session id.')
    if (isForeignEvidenceId(ref)) throw new DotError('dot/invalid', `evidence_ref ${ref} is a snapshot, baseline, or session id. Choose a relative evidence id, call action=evidence again, and put that evidence_ref in evidenceRefs.`)
    this.saveWorkEvidence(ref, body)
    return `evidence_ref ${ref}. Put this id in evidenceRefs. Do not substitute a snapshot id, baseline id, or session id.`
  }

  private async finishFromTool(args: Record<string, unknown>): Promise<string> {
    const runId = typeof args.run_id === 'string' ? args.run_id : ''
    if (!runId) throw new DotError('dot/invalid', 'run_id is required')
    const phase = args.verdict === 'fail' ? 'failed' as const : 'completed' as const
    const finished = await this.finishWorkRun(runId, phase)
    if (!finished.ok) throw new DotError('dot/invalid', finished.message)
    return `${phase} ${runId}`
  }

  private async holdFromTool(args: Record<string, unknown>): Promise<string> {
    const runId = typeof args.review_run_id === 'string' ? args.review_run_id : typeof args.run_id === 'string' ? args.run_id : ''
    if (!runId) throw new DotError('dot/invalid', 'review_run_id is required')
    const held = await this.holdWorkReview(runId)
    if (!('id' in held)) throw new DotError('dot/invalid', held.message)
    return `holding ${held.id} at ${held.phase}`
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
    const opened = this.pending.open({
      kind: 'approval',
      sessionId: this.store.dotSessionId || changeId,
      subject: `Look at ${changeId}`,
      detail: JSON.stringify({ changeId, inputRevision: expectedInputRevision, verificationId, subjectKey }),
    })
    return `pending ${opened.id} for ${changeId}`
  }

  /**
   * Atomic closeout pipeline: optionally registers inline evidence, holds an open
   * review run (if present), captures the fresh delivery subject, records checks
   * against all required items, and either closes out immediately (via review or
   * deterministic `acceptDirect`) or opens the human oversight `decide` request.
   */
  private async closeoutFromTool(args: Record<string, unknown>): Promise<string> {
    const changeId = typeof args.task_id === 'string' ? args.task_id : ''
    const change = this.store.work.change(changeId)
    if (!change) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    const expectedRef = typeof args.expected_input_ref === 'string' ? args.expected_input_ref : change.currentInputRef
    const expectedRevision = typeof args.expected_input_revision === 'number' ? args.expected_input_revision : change.currentRevision
    if (expectedRef !== change.currentInputRef || expectedRevision !== change.currentRevision) {
      throw new DotError('dot/invalid', `expected input ${expectedRef}@${expectedRevision} is not current ${change.currentInputRef}@${change.currentRevision}`)
    }
    // If the human already approved a verification for the current input revision, finalize that exact verification
    // (acceptWork still re-verifies live workspace SHA-256 bytes against its snapshot before closing out).
    const approvedDecision = change.oversight?.inputRef === change.currentInputRef
      && change.oversight.inputRevision === change.currentRevision
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
        change.currentInputRef,
        decidedSubjectKey,
        'tool',
        { expectedInputRevision: change.currentRevision, expectedVerificationId: decidedVerificationId },
      )
      if (!('id' in accepted)) throw new DotError('dot/invalid', accepted.message)
      return `accepted ${changeId} at ${accepted.closeout?.subjectKey ?? decidedSubjectKey}`
    }
    const evidenceRef = typeof args.evidence_ref === 'string' ? args.evidence_ref.trim() : ''
    const summary = typeof args.summary === 'string' ? args.summary : ''
    if (evidenceRef && summary) {
      if (isForeignEvidenceId(evidenceRef)) throw new DotError('dot/invalid', `evidence_ref ${evidenceRef} is a snapshot, baseline, or session id`)
      this.saveWorkEvidence(evidenceRef, summary)
    }
    const allRuns = this.store.work.listRuns().filter(run => run.changeId === changeId)
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
    if (openReview) {
      const held = await this.holdWorkReview(openReview.id)
      if (!('id' in held)) throw new DotError('dot/invalid', held.message)
    }
    const subject = await this.captureWorkSubject(changeId)
    const material = this.store.work.input(change.currentInputRef)
    const rawChecks = jsonArray(args.checks)
    const requiredReqs = (material?.requirements ?? []).filter(item => item.required)
    const checks = rawChecks
      ? rawChecks
      : evidenceRef && this.registeredEvidence(evidenceRef)
        ? (requiredReqs.length > 0 ? requiredReqs.map(item => item.requirementRef) : ['goal']).map(requirementRef => ({
            requirementRef,
            applicability: 'applicable' as const,
            verdict: 'pass' as const,
            evidenceRefs: [evidenceRef],
          }))
        : undefined
    if (!checks || checks.length === 0) {
      throw new DotError('dot/invalid', 'closeout requires checks (JSON array) or both evidence_ref and summary covering required items')
    }
    for (const check of checks) {
      const refs = check && typeof check === 'object' ? (check as { evidenceRefs?: unknown }).evidenceRefs : undefined
      if (!Array.isArray(refs)) throw new DotError('dot/invalid', 'each check needs evidenceRefs')
      for (const ref of refs) {
        const gap = typeof ref === 'string' ? evidenceRefGap(ref, this.registeredEvidence(ref)) : evidenceRefGap('missing', false)
        if (gap) throw new DotError('dot/invalid', gap)
      }
    }
    const writerIds = allRuns.filter(run => run.kind !== 'review' && scopeWrites(run.writeScope)).map(run => run.id)
    const listedRuns = jsonArray(args.run_ids)?.map(item => String(item))
    const runIds = listedRuns ?? writerIds
    const refreshedReview = openReview ? this.store.work.run(openReview.id) : undefined
    const recorded = await this.recordWorkVerification(
      changeId,
      checks as Parameters<DotStore['work']['recordVerification']>[1],
      runIds,
      refreshedReview
        ? {
            inputRef: change.currentInputRef,
            inputRevision: change.currentRevision,
            reviewRunId: refreshedReview.id,
            reviewerSessionId: typeof args.session_id === 'string' ? args.session_id : refreshedReview.sessionId,
            subject,
          }
        : {
            inputRef: change.currentInputRef,
            inputRevision: change.currentRevision,
            subject,
            direct: true,
          },
    )
    if (!('id' in recorded)) throw new DotError('dot/invalid', verifyRefusal(recorded.message))
    if (recorded.verdict !== 'accept' || !recorded.subjectKey) {
      return JSON.stringify({ id: recorded.id, verdict: recorded.verdict, inputRef: recorded.inputRef, subjectKey: recorded.subjectKey })
    }
    const latest = this.store.work.change(changeId)!
    const needsHumanDecision = latest.oversight?.requested
      && latest.oversight.inputRef === latest.currentInputRef
      && (latest.oversight.decision?.result !== 'accept'
        || latest.oversight.decision.verificationId !== recorded.id
        || latest.oversight.decision.subjectKey !== recorded.subjectKey)
    if (needsHumanDecision) {
      return this.decideFromTool({
        task_id: changeId,
        verification_id: recorded.id,
        expected_input_revision: latest.currentRevision,
        expected_subject_key: recorded.subjectKey,
      })
    }
    const accepted = await this.acceptWork(changeId, recorded.id, latest.currentInputRef, recorded.subjectKey, 'tool', {
      expectedInputRevision: latest.currentRevision,
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
    const next = decision.result === 'accept' ? 'accept' : 'reject'
    this.notify({
      sessionId: dot,
      kind: 'task-human',
      wakeKey: key,
      at: this.now(),
      text: `${change.id} user ${decision.result} is already recorded for verification ${decision.verificationId}, subject ${decision.subjectKey}, input ${oversight.inputRef}@${oversight.inputRevision}. Do not call decide again and do not answer this pending request again. Next, call action=${next} for this verification, subject, and input. This wake does not accept, reject, or open a session.`,
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

  private registeredEvidence(ref: string): boolean {
    if (isForeignEvidenceId(ref) || !artifactName(ref) || artifactName(ref) !== ref) return false
    try { return readFileSync(join(this.options.homeDir, 'artifacts', 'evidence', ref)).byteLength > 0 } catch { return false }
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

  private async startWorkSession(input: { workspaceId?: string; cwd?: string; title: string; instruction: string; goal?: string; model?: string; taskId?: string; role?: SessionRole; access?: TicketAccess; preset?: string; checkOnly?: boolean; paths?: string; runId?: string; captureBaseline?: boolean }): Promise<string> {
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
    if (!changeId) {
      const workspace = input.workspaceId ? this.host.listWorkspaces().find(row => row.id === input.workspaceId) : undefined
      if (input.workspaceId && !workspace) throw new DotError('dot/unknown-workspace', `no workspace ${input.workspaceId}`)
      const cwd = workspace?.path ?? input.cwd
      if (!cwd || !isAbsolute(cwd)) throw new DotError('dot/invalid', 'directory must be absolute')
      const goal = input.goal?.trim() || input.instruction.trim()
      if (!goal && !input.checkOnly) throw new DotError('dot/invalid', 'instruction must be non-empty')
      const change = await this.store.work.createChange({ title: input.title, cwd, goal: goal || input.title, at: this.now() })
      changeId = change.id
    }
    const change = this.store.work.change(changeId)
    if (!change) throw new DotError('dot/invalid', `unknown change ${changeId}`)
    if (input.checkOnly) {
      const candidate = plannedOccupant(change.cwd, plannedScope(role, input.access, input.paths, change.cwd))
      return (await this.scopeReport(change.cwd, change.id, candidate)).text
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
    let runId = selected?.id
    if (!runId) {
      const reserved = await this.reserveFromTool({ task_id: changeId, role, access: input.access ?? (role === 'review' ? 'write' : 'read'), ...(input.paths ? { paths: input.paths } : {}) })
      runId = JSON.parse(reserved).runId as string
    }
    const currentRun = this.store.work.run(runId)
    if (input.captureBaseline === true && currentRun && scopeWrites(currentRun.writeScope) && currentRun.baselineRefs.length === 0) {
      const published = await this.captureWorkBaseline(runId)
      if (!('applied' in published) || !published.applied) {
        const msg = 'message' in published ? published.message : 'baseline was not published'
        return `reserved ${runId} on ${changeId}; not started: ${msg}${note}`
      }
    }
    const instruction = input.instruction.trim()
    if (!instruction) return `reserved ${runId} on ${changeId}${note}`
    const launched = await this.launchWorkRun(runId, instruction, preset.named ? preset.id : undefined, model)
    if (!launched.ok) return `reserved ${runId} on ${changeId}; not started: ${launched.message}${note}`
    return `started ${runId} on ${changeId}${note}`
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
      const manifest = readSnapshot(join(this.options.homeDir, 'artifacts', artifactRef)).manifest
      const captured = baselineCaptures(run, manifest)
      if (!captured.ok) return { ok: false, code: 'baseline', message: captured.reason }
      return undefined
    } catch {
      return { ok: false, code: 'baseline', message: `artifact ${artifactRef} is missing or incomplete` }
    }
  }

  private legacyClosed(entry: string): Promise<never> | undefined {
    if (this.options.legacyWorkEntries === true) return undefined
    return Promise.reject(new DotError('dot/legacy-closed', `${entry} is closed. Use a Change and reserveRun; this entry does not start a session, take a directory lock, or change a ticket.`))
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

  /** Persona, model, agreements and cognition as a segment starting now would freeze them. */
  private async frozen(): Promise<Pick<Segment, 'persona' | 'model' | 'agreements' | 'cognition'>> {
    const model = this.host.modelKey()
    await this.ensureMigration()
    return {
      persona: personaSection(this.store.settings),
      ...model ? { model } : {},
      agreements: agreementsSection(this.store.agreements),
      cognition: cognitionSection(this.store.cognition),
    }
  }

  /** Agreements block for a prompt that no segment record covers yet. */
  currentAgreementsBlock(): string { return agreementsSection(this.store.agreements) }

  /** Cognition block for a prompt that no segment record covers yet. */
  currentCognitionBlock(): string { return cognitionSection(this.store.cognition) }

  /**
   * Whether dot's segment has to end before the next message reaches it.
   * Only a running turn keeps the segment; unanswered cards remain asynchronous.
   */
  private async dueBeforeDelivery(dot: string): Promise<RolloverReason | undefined> {
    const segment = this.store.segment
    if (!segment || segment.sessionId !== dot || this.host.isRunning(dot)) return undefined
    const events = await this.host.readEvents(dot)
    let replied = false
    let lastReplyAt: number | undefined
    for (const event of events) {
      const result = event.data as { meta?: unknown; message?: { isError?: boolean } } | undefined
      const validCard = event.type === 'tool/result' && result?.message?.isError !== true && cardText(result?.meta) !== undefined
      if (event.type !== 'assistant/message' && !validCard) continue
      replied = true
      if (typeof event.time === 'number') lastReplyAt = event.time
    }
    if (this.requestedSegment) return 'dot-requested'
    const wanted = await this.frozen()
    const seenAgreements = segment.agreementsSeen ?? segment.agreements ?? ''
    const seenCognition = segment.cognitionSeen ?? segment.cognition ?? ''
    if (!replied) {
      // No request of this segment is cached yet, so it simply takes the current settings and blocks.
      if (segment.persona !== wanted.persona || segment.model !== wanted.model
        || (wanted.agreements ?? '') !== (segment.agreements ?? '')
        || (wanted.cognition ?? '') !== (segment.cognition ?? '')) await this.store.refreezeSegment(wanted)
      return undefined
    }
    const view = await this.host.dotContext(dot)
    return reasonBeforeDelivery({
      replied,
      now: this.now(),
      ...lastReplyAt === undefined ? {} : { lastReplyAt },
      ...view.usedTokens === undefined ? {} : { usedTokens: view.usedTokens },
      persona: wanted.persona,
      frozenPersona: segment.persona,
      ...wanted.model ? { model: wanted.model } : {},
      ...segment.model ? { frozenModel: segment.model } : {},
      agreements: wanted.agreements ?? '',
      seenAgreements,
      cognition: wanted.cognition ?? '',
      seenCognition,
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
      ledger: ledgerSummary(this.store.list(), this.pending.list(), at, this.store.listTickets(), this.store.workLedger()),
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

