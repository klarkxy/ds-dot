/**
 * In-memory ledger mirrored to the storage domain. Writes are serialized so
 * the durable copy follows the in-memory order; reads never wait on disk.
 */
import { APPROVAL_DETAIL_LIMIT } from './approval-risk.ts'
import { COGNITION_HISTORY_MAX, type BoardView, type CognitionVersion, type DotContextUsage, type DotSettings, type DotUsageOffset, type PendingView, type ReflectionRun, type ScheduleRecord, type SettingProposal, type TaskRecord, type Ticket, type TicketAccess, type TicketPriority, type TicketRound, type TicketStatus } from './contracts.ts'
import { ZERO_USAGE, addUsage } from './context.ts'
import { applyEvent, createTask, ledgerSummary, markSeen, sortTasks, withPending, type LedgerEvent, type NewTask } from './ledger.ts'
import { MAX_PAST_SEGMENTS, type PastSegment, type Segment } from './segments.ts'
import { parseSettings } from './settings.ts'
import { STATE_KEY, parseScheduleRecord, parseSettingProposal, parseState, parseTask, parseTicket, type DotState } from './storage.ts'
import { clip } from './ledger.ts'
import { appendTicketRound, moveTicket } from './ticket.ts'
import { deriveTicketViews } from './ticket-view.ts'
import { lockHolders } from './lock.ts'
import { ownedSessionIds, sessionIsOwned } from './peer.ts'
import { WorkBook, isUnknownState, type WorkPersist } from './work.ts'

type TableName = 'state' | 'tasks' | 'tickets' | 'schedules' | 'proposals' | 'changes' | 'inputs' | 'runs' | 'verifications' | 'peers'

export interface DotTable {
  entries(): IterableIterator<[unknown, unknown]>
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<unknown>
  update?(key: string, recipe: (current: unknown) => unknown): Promise<unknown>
}

export interface DotDomainHandle {
  table(name: TableName): DotTable
  close(): Promise<void>
}

/** Ledger cap: the oldest archived tasks are forgotten past this size. */
export const MAX_TASKS = 300

/** Reflection runs remembered for the trajectory list. */
export const MAX_REFLECTION_RUNS = 30

export class DotStore {
  private state: DotState
  private current: DotSettings
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly tickets = new Map<string, Ticket>()
  private readonly reminders = new Map<string, ScheduleRecord>()
  private readonly proposals = new Map<string, SettingProposal>()
  private tail: Promise<unknown> = Promise.resolve()
  private ticketTail: Promise<unknown> = Promise.resolve()
  private cognitionRevision = 0
  get cognitionVersion(): number { return this.cognitionRevision }
  private readonly listeners = new Set<() => void>()
  readonly work: WorkBook

  constructor(private readonly domain: DotDomainHandle | undefined, initialTasks?: readonly TaskRecord[]) {
    this.state = domain ? parseState(domain.table('state').get(STATE_KEY)) : {}
    this.current = parseSettings(this.state.settings)
    for (const task of initialTasks ?? []) this.tasks.set(task.sessionId, task)
    if (domain) {
      for (const [key, value] of domain.table('tasks').entries()) {
        const task = parseTask(value)
        if (task && task.sessionId === key) this.tasks.set(task.sessionId, task)
      }
      for (const [key, value] of domain.table('tickets').entries()) {
        const ticket = parseTicket(value)
        if (ticket && ticket.id === key) this.tickets.set(ticket.id, ticket)
      }
      this.pruneTickets()
      for (const [key, value] of domain.table('schedules').entries()) {
        const record = parseScheduleRecord(value)
        if (record && record.id === key) this.reminders.set(record.id, record)
      }
      for (const [key, value] of domain.table('proposals').entries()) {
        const proposal = parseSettingProposal(value)
        if (proposal && proposal.id === key) this.proposals.set(proposal.id, proposal)
      }
    }
    this.work = WorkBook.restore({
      changes: this.loadWork('changes'),
      inputs: this.loadWork('inputs'),
      runs: this.loadWork('runs'),
      verifications: this.loadWork('verifications'),
    }, (table, key, value) => this.persistWork(table, key, value))
    for (const repair of this.work.takeRepairs()) {
      const op = this.tail.then(() => this.persistWork('runs', repair.id, repair))
      this.tail = op.catch(() => undefined)
    }
  }

  /** `null` is an unreadable table. An empty array is a table that really has no rows. */
  private loadWork(name: TableName): unknown[] | null {
    if (!this.domain) return []
    try {
      const table = this.domain.table(name)
      if (!table || typeof table.entries !== 'function') return null
      return [...table.entries()].map(([, value]) => value)
    } catch {
      return null
    }
  }

  /**
   * A new key is a put. update is only for a key the table already has,
   * because the real domain rejects a missing key instead of inserting it.
   */
  private async persistWork(table: Parameters<WorkPersist>[0], key: string, value: unknown): Promise<void> {
    if (!this.domain) return
    const handle = this.domain.table(table)
    await this.durable(async () => {
      if (typeof handle.update === 'function' && handle.get(key) !== undefined) {
        await handle.update(key, () => value)
        return
      }
      await handle.put(key, value)
    })
  }

  /** Any shared-domain mutation. An unknown outcome seals scheduling; a definite failure does not. */
  private async durable(work: () => Promise<unknown>): Promise<void> {
    try {
      await work()
    } catch (error) {
      if (isUnknownState(error)) this.work.sealUnknown(error)
      throw error
    }
  }

  /** Import v3 started sessions. Retry is safe after any individual write fails. */
  async migrateTickets(): Promise<void> {
    if (this.state.ticketsMigrated !== undefined) return
    for (const task of this.tasks.values()) {
      if (task.origin !== 'started' || task.ticketId) continue
      // A previous attempt may have persisted the ticket but not the session row.
      let ticket = [...this.tickets.values()].find(row => row.sessions.some(session => session.sessionId === task.sessionId))
      if (!ticket) {
        const sequence = Math.max(this.state.ticketSequence ?? 0, ...[...this.tickets.keys()].map(id => Number(/^t-(\d+)$/.exec(id)?.[1] ?? 0))) + 1
        const status = task.status === 'archived' ? 'done' as const : 'active' as const
        ticket = { id: `t-${sequence}`, title: clip(task.title, 80), goal: clip(task.goal, 600), dir: task.cwd, ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}), access: 'write', priority: 2, status, sessions: [{ sessionId: task.sessionId, role: 'work', at: task.createdAt }], rounds: [], history: [{ at: task.createdAt, to: status, by: 'dot', reason: 'migrated from the session ledger' }], createdAt: task.createdAt, updatedAt: task.updatedAt }
        // Publish only after the durable ticket exists; retry finds it by session.
        await this.write('tickets', ticket.id, ticket)
        this.tickets.set(ticket.id, ticket)
        this.state = { ...this.state, ticketSequence: sequence }
      }
      const updated = { ...task, ticketId: ticket.id, role: 'work' as const }
      await this.write('tasks', task.sessionId, updated)
      this.tasks.set(task.sessionId, updated)
    }
    const domain = this.domain
    const op = this.tail.then(async () => {
      const next = { ...this.state, ticketsMigrated: '1' }
      if (domain) await this.durable(() => domain.table('state').put(STATE_KEY, next))
      this.state = { ...this.state, ticketsMigrated: '1' }
      this.pruneTickets()
      this.changed()
    })
    this.tail = op.catch(() => undefined)
    await op
  }

  get cards(): readonly import('./card-state.ts').DotCardRecord[] { return this.state.cards ?? [] }
  get approvalDetails(): readonly import('./contracts.ts').ApprovalDetail[] { return this.state.approvalDetails ?? [] }
  saveApprovalDetail(detail: import('./contracts.ts').ApprovalDetail): Promise<void> {
    const next = [...this.approvalDetails.filter(row => row.requestId !== detail.requestId), detail].slice(-APPROVAL_DETAIL_LIMIT)
    return this.setDot({ approvalDetails: next })
  }
  replaceApprovalDetails(details: readonly import('./contracts.ts').ApprovalDetail[]): Promise<void> {
    const current = this.approvalDetails
    if (details.length === current.length && details.every((row, index) => row === current[index])) return Promise.resolve()
    return this.setDot({ approvalDetails: [...details] })
  }
  get cardSequence(): number { return this.cards.reduce((max, card) => Math.max(max, card.number), this.state.cardSequence ?? 0) }
  get lastReplyAt(): number | undefined { return this.state.lastReplyAt }
  get lastConversationAt(): number | undefined { return this.state.lastConversationAt }
  get lastFactoryResetAt(): number | undefined { return this.state.lastFactoryResetAt }

  addCard(card: import('./card-state.ts').DotCardRecord): Promise<void> {
    return this.setDot({ cardSequence: card.number, cards: [...this.cards.map(row => row.answer ? row : { ...row, expired: true }), card] })
  }

  expireCards(keepId?: string): Promise<void> {
    if (!this.cards.some(card => !card.expired && !card.answer && card.id !== keepId)) return Promise.resolve()
    return this.setDot({ cards: this.cards.map(card => card.answer || card.id === keepId ? card : { ...card, expired: true }) })
  }

  setCardAnswer(id: string, answer: NonNullable<import('./card-state.ts').DotCardRecord['answer']>, notificationPending = false): Promise<void> {
    return this.setDot({ cards: this.cards.map(card => card.id === id ? { ...card, answer, notificationPending } : card) })
  }

  setCardNotificationPending(id: string, notificationPending: boolean): Promise<void> {
    return this.setDot({ cards: this.cards.map(card => card.id === id ? { ...card, notificationPending } : card) })
  }

  noteConversation(at: number, replied = false): Promise<void> {
    return this.setDot({ lastConversationAt: Math.max(this.lastConversationAt ?? 0, at), ...replied ? { lastReplyAt: Math.max(this.lastReplyAt ?? 0, at) } : {} })
  }

  get dotSessionId(): string | undefined { return this.state.dotSessionId }
  get dotWorkspaceId(): string | undefined { return this.state.dotWorkspaceId }

  /** The record of the segment dot is in; undefined until one is written for the current session. */
  get segment(): Segment | undefined {
    const segment = this.state.segment
    return segment && segment.sessionId === this.state.dotSessionId ? segment : undefined
  }

  get pastSegments(): readonly PastSegment[] { return this.state.pastSegments ?? [] }
  get usageCarry(): DotContextUsage | undefined { return this.state.usageCarry }
  get usageOffset(): DotUsageOffset | undefined { return this.state.usageOffset }

  /** Make `next` dot's session; a different previous session joins the past segments. */
  beginSegment(next: Segment, ended?: Pick<PastSegment, 'reason'>, endedUsage?: DotContextUsage): Promise<void> {
    const previous = this.state.dotSessionId
    const moved = previous !== undefined && previous !== next.sessionId
    const past = !moved
      ? this.pastSegments
      : [...this.pastSegments, {
          sessionId: previous,
          startedAt: this.segment?.startedAt ?? 0,
          endedAt: next.startedAt,
          ...ended?.reason ? { reason: ended.reason } : {},
        }].slice(-MAX_PAST_SEGMENTS)
    const { usageOffset: _offset, ...rest } = this.state
    const carry = moved && endedUsage ? addUsage(this.state.usageCarry, endedUsage) : this.state.usageCarry
    this.state = {
      ...rest,
      ...(!moved && this.state.usageOffset ? { usageOffset: this.state.usageOffset } : {}),
      ...(carry ? { usageCarry: carry } : {}),
      dotSessionId: next.sessionId,
      segment: next,
      pastSegments: past,
      ...(moved ? { cards: this.cards.map(card => card.answer ? card : { ...card, expired: true }) } : {}),
    }
    this.changed()
    return this.write('state', STATE_KEY, this.state)
  }

  /** Zero cumulative usage now; any usage already accrued in the active segment is subtracted via usageOffset. */
  clearUsage(sessionId: string | undefined, currentRaw: DotContextUsage | undefined): Promise<void> {
    const { usageOffset: _old, ...rest } = this.state
    const hasRaw = Boolean(sessionId && currentRaw && (currentRaw.input > 0 || currentRaw.cacheRead > 0 || currentRaw.cacheWrite > 0 || currentRaw.output > 0))
    this.state = {
      ...rest,
      usageCarry: ZERO_USAGE,
      ...(hasRaw && sessionId && currentRaw ? { usageOffset: { sessionId, ...currentRaw } } : {}),
    }
    this.changed()
    return this.write('state', STATE_KEY, this.state)
  }

  /** Refresh the frozen inputs of a segment dot has not replied in yet. */
  refreezeSegment(patch: Pick<Segment, 'persona' | 'model' | 'agreements' | 'cognition'>): Promise<void> {
    const segment = this.segment
    if (!segment) return Promise.resolve()
    const { model: _model, agreements: _agreements, agreementsSeen: _aseen, cognition: _cognition, cognitionSeen: _cseen, ...rest } = segment
    return this.setDot({ segment: {
      ...rest,
      persona: patch.persona,
      ...patch.model !== undefined ? { model: patch.model } : {},
      ...patch.agreements !== undefined ? { agreements: patch.agreements } : {},
      ...patch.cognition !== undefined ? { cognition: patch.cognition } : {},
    } })
  }

  /** dot changed its own agreements in the current segment: the conversation accounts for them as they read now. */
  noteAgreementsSeen(section: string): Promise<void> {
    const segment = this.segment
    if (!segment) return Promise.resolve()
    return this.setDot({ segment: { ...segment, agreementsSeen: section } })
  }

  /** dot rewrote its own cognition in the current segment: the conversation accounts for it as it reads now. */
  noteCognitionSeen(section: string): Promise<void> {
    const segment = this.segment
    if (!segment) return Promise.resolve()
    return this.setDot({ segment: { ...segment, cognitionSeen: section } })
  }

  // ---- agreements and cognition (DotStore is the authority) --------------

  get agreements(): string { return this.state.agreements ?? '' }
  get agreementsUndo(): string | undefined { return this.state.agreementsUndo }
  get cognition(): string { return this.state.cognition ?? '' }
  get cognitionHistory(): readonly CognitionVersion[] { return this.state.cognitionHistory ?? [] }
  /** Whether the one-time legacy import already ran; cleared content is never re-imported after it. */
  get knowledgeMigrated(): boolean { return this.state.knowledgeMigrated !== undefined }
  /** Legacy note text from old state rows; only migration reads it. */
  get legacyMemory(): string | undefined { return this.state.memory }
  get legacyMemoryUndo(): string | undefined { return this.state.memoryUndo }

  /** Replace the agreements; the text before them is what one undo restores. */
  setAgreements(text: string): Promise<void> {
    const before = this.agreements
    if (text === before) return Promise.resolve()
    return this.setDot({ agreements: text, agreementsUndo: before })
  }

  /** Swap the agreements with the text the latest change replaced. @returns false when there is nothing to take back. */
  undoAgreements(): Promise<boolean> {
    const undo = this.state.agreementsUndo
    if (undo === undefined) return Promise.resolve(false)
    const current = this.agreements
    return this.setDot({ agreements: undo, agreementsUndo: current }).then(() => true)
  }

  /** Replace cognition, pushing the text it replaces onto the rollback history (newest first, capped). */
  setCognition(text: string, now = Date.now()): Promise<void> {
    const before = this.cognition
    if (text === before) return Promise.resolve()
    this.cognitionRevision++
    const history = this.cognitionHistory
    const latest = history[0]?.at ?? 0
    // Strictly increasing timestamps keep every version addressable for restore.
    const at = Math.max(Math.trunc(now), latest + 1)
    const next = [{ text: before, at }, ...history].slice(0, COGNITION_HISTORY_MAX)
    return this.setDot({ cognition: text, cognitionHistory: next })
  }

  /** Put an earlier cognition text back; the text it replaces joins the history too. @returns false for an unknown version. */
  restoreCognition(at: number, now = Date.now()): Promise<boolean> {
    const version = this.cognitionHistory.find(entry => entry.at === at)
    if (!version) return Promise.resolve(false)
    return this.setCognition(version.text, now).then(() => true)
  }

  // ---- background reflection -------------------------------------------

  /** When the last successful reflection finished; undefined until the first one. */
  get lastReflectedAt(): number | undefined { return this.state.lastReflectedAt }
  /** When the last reflection attempt started; drives the failure cooldown. */
  get lastReflectionAttemptAt(): number | undefined { return this.state.lastReflectionAttemptAt }
  /** Whether the last reflection attempt failed (stays true until a submission succeeds). */
  get reflectionAttemptFailed(): boolean { return this.state.reflectionAttemptFailed === true }
  /** A one-time agreement note from the reflection pass, until the next human message carries it. */
  get agreementNotes(): string { return this.state.agreementNotes ?? '' }

  /**
   * Record the start of a reflection attempt. Marked failed up front: if the run
   * crashes or never submits, the failure cooldown holds even when the start
   * shares its millisecond with the previous success (a timestamp comparison
   * could not tell them apart).
   */
  beginReflectionAttempt(at: number): Promise<void> {
    return this.setDot({ lastReflectionAttemptAt: at, reflectionAttemptFailed: true })
  }

  /** Mark a reflection pass done: the cognition it wrote is live and the cooldown resets. */
  markReflected(at: number): Promise<void> {
    return this.setDot({ lastReflectedAt: at, reflectionAttemptFailed: false })
  }

  /**
   * Undo any success bookkeeping a failed submission write may have left and
   * keep the attempt marked failed, so the 24h success gate cannot be satisfied
   * by a pass that reported an error to its model. The original attempt start is
   * preserved so the 2h retry cooldown is counted from the real start.
   */
  failReflectionSubmission(attemptAt: number, priorReflectedAt: number | undefined): Promise<void> {
    const { lastReflectedAt: _current, ...rest } = this.state
    this.state = {
      ...rest,
      lastReflectionAttemptAt: attemptAt,
      reflectionAttemptFailed: true,
      ...priorReflectedAt !== undefined ? { lastReflectedAt: priorReflectedAt } : {},
    }
    this.changed()
    return this.write('state', STATE_KEY, this.state)
  }

  /** Replace the pending agreement note; empty text leaves any existing note untouched. */
  setAgreementNotes(text: string): Promise<void> {
    const next = text.trim()
    if (!next) return Promise.resolve()
    return this.setDot({ agreementNotes: next })
  }

  /** Drop the pending agreement note once a human message carried it. */
  clearAgreementNotes(): Promise<void> {
    if (this.state.agreementNotes === undefined) return Promise.resolve()
    const { agreementNotes: _notes, ...rest } = this.state
    this.state = rest
    this.changed()
    return this.write('state', STATE_KEY, this.state)
  }

  /** Reflection passes that ran, oldest first; capped so the trajectory list cannot grow forever. */
  get reflections(): readonly ReflectionRun[] { return this.state.reflections ?? [] }

  /** Remember a reflection session as soon as it exists, so its trajectory survives the archive. */
  addReflectionRun(run: ReflectionRun): Promise<void> {
    const next = [...this.reflections, run].slice(-MAX_REFLECTION_RUNS)
    return this.setDot({ reflections: next })
  }

  /** Record a reflection run's end and whether it produced a result. */
  finishReflectionRun(sessionId: string, endedAt: number, ok: boolean): Promise<void> {
    const runs = this.reflections
    if (!runs.some(run => run.sessionId === sessionId)) return Promise.resolve()
    const next = runs.map(run => run.sessionId === sessionId ? { ...run, endedAt, ok } : run)
    return this.setDot({ reflections: next })
  }

  /**
   * Commit the one-time legacy import. Unlike {@link setDot}, the in-memory state
   * (including the migration marker) is updated only after the write is durable,
   * so a failed import is retried instead of being silently marked done.
   */
  commitKnowledgeMigration(patch: Partial<Pick<DotState, 'agreements' | 'agreementsUndo' | 'cognition' | 'cognitionHistory' | 'knowledgeMigrated'>>): Promise<void> {
    // The one-time import may seed an initial cognition rollback version, but it must
    // never replace history the store already holds; drop the key so the state spread
    // keeps the existing history instead of overwriting it.
    const effective = { ...patch }
    if (effective.cognitionHistory !== undefined && (this.state.cognitionHistory?.length ?? 0) > 0) delete effective.cognitionHistory
    const domain = this.domain
    if (domain === undefined) {
      this.state = { ...this.state, ...effective }
      this.changed()
      return Promise.resolve()
    }
    const op = this.tail.then(async () => {
      const next = { ...this.state, ...effective }
      await this.durable(() => domain.table('state').put(STATE_KEY, next))
      // Merge onto the latest memory state so concurrent settings/segment fields survive;
      // the state write that landed meanwhile is re-issued with the latest snapshot below.
      this.state = { ...this.state, ...effective }
      this.changed()
    })
    this.tail = op.catch(() => undefined)
    return op
  }

  get settings(): DotSettings { return this.current }

  setSettings(next: DotSettings): Promise<void> {
    this.current = next
    return this.setDot({ settings: { ...next } as Record<string, unknown> })
  }

  /**
   * Wipe Dorothy's durable tables and in-memory ledger. Settings return to
   * defaults. The migration marker stays so legacy note files are not
   * re-imported. `lastFactoryResetAt` is the surviving audit.
   */
  async factoryReset(now = Date.now()): Promise<void> {
    await this.flush()
    const names: TableName[] = ['tasks', 'tickets', 'schedules', 'proposals', 'changes', 'inputs', 'runs', 'verifications', 'peers']
    const domain = this.domain
    const op = this.tail.then(async () => {
      if (domain) {
        for (const name of names) {
          const table = domain.table(name)
          const keys = [...table.entries()].map(([key]) => String(key))
          for (const key of keys) await this.durable(() => table.delete(key))
        }
      }
      this.tasks.clear()
      this.tickets.clear()
      this.reminders.clear()
      this.proposals.clear()
      this.work.clear()
      this.current = parseSettings(undefined)
      this.cognitionRevision++
      this.state = { lastFactoryResetAt: now, knowledgeMigrated: '1' }
      if (domain) await this.durable(() => domain.table('state').put(STATE_KEY, this.state))
      this.changed()
    })
    this.tail = op.catch(() => undefined)
    await op
  }

  setDot(next: DotState): Promise<void> {
    this.state = { ...this.state, ...next }
    this.changed()
    return this.write('state', STATE_KEY, this.state)
  }

  ticket(id: string): Ticket | undefined { return this.tickets.get(id) }
  listTickets(): Ticket[] { return [...this.tickets.values()] }
  ticketForSession(sessionId: string): Ticket | undefined {
    const id = this.tasks.get(sessionId)?.ticketId
    return id ? this.tickets.get(id) : [...this.tickets.values()].find(ticket => ticket.sessions.some(row => row.sessionId === sessionId))
  }

  createTicket(input: { title: string; goal: string; dir: string; access: TicketAccess; priority?: TicketPriority; deliverable?: string; acceptance?: string; workspaceId?: string; draft?: boolean; humanReview?: boolean; at?: number }): Promise<Ticket> {
    const op = this.ticketTail.then(async () => {
    const at = input.at ?? Date.now()
    const sequence = Math.max(this.state.ticketSequence ?? 0, ...[...this.tickets.keys()].map(id => Number(/^t-(\d+)$/.exec(id)?.[1] ?? 0))) + 1
    const ticket: Ticket = {
      id: `t-${sequence}`, title: clip(input.title, 80), goal: clip(input.goal, 600), dir: input.dir, access: input.access,
      priority: input.priority ?? 2, status: input.draft ? 'draft' : 'todo', sessions: [], rounds: [], history: [], createdAt: at, updatedAt: at,
      ...(input.deliverable !== undefined ? { deliverable: clip(input.deliverable, 400) } : {}),
      ...(input.acceptance !== undefined ? { acceptance: clip(input.acceptance, 1200) } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      ...(input.humanReview !== undefined ? { humanReview: input.humanReview } : {}),
    }
    this.state = { ...this.state, ticketSequence: sequence }
    await this.putTicket(ticket)
    await this.write('state', STATE_KEY, this.state)
    return ticket
    })
    this.ticketTail = op.catch(() => undefined)
    return op
  }

  updateTicket(id: string, patch: Partial<Pick<Ticket, 'title' | 'goal' | 'deliverable' | 'acceptance' | 'dir' | 'workspaceId' | 'access' | 'priority' | 'humanReview'>>, at = Date.now()): Promise<Ticket> {
    const op = this.ticketTail.then(async () => {
    const current = this.requireTicket(id)
    if ((current.status === 'active' || current.status === 'review') && ((patch.dir !== undefined && patch.dir !== current.dir) || (patch.access !== undefined && patch.access !== current.access))) throw new Error('Cannot change directory or access while active or in review')
    const clearWorkspace = patch.dir !== undefined && patch.dir !== current.dir && patch.workspaceId === undefined
    const { workspaceId: _oldWorkspace, ...withoutWorkspace } = current
    const next = { ...(clearWorkspace ? withoutWorkspace : current), ...patch, ...(patch.title !== undefined ? { title: clip(patch.title, 80) } : {}), ...(patch.goal !== undefined ? { goal: clip(patch.goal, 600) } : {}), ...(patch.deliverable !== undefined ? { deliverable: clip(patch.deliverable, 400) } : {}), ...(patch.acceptance !== undefined ? { acceptance: clip(patch.acceptance, 1200) } : {}), updatedAt: at }
    await this.putTicket(next)
    return next
    })
    this.ticketTail = op.catch(() => undefined)
    return op
  }

  moveTicket(id: string, to: TicketStatus, by: 'dot' | 'human', reason: string, at = Date.now()): Promise<Ticket> {
    const op = this.ticketTail.then(async () => {
      const next = moveTicket(this.requireTicket(id), to, by, reason, at, this.tickets.values())
      await this.putTicket(next)
      return next
    })
    this.ticketTail = op.catch(() => undefined)
    return op
  }

  noteTicket(id: string, round: TicketRound): Promise<Ticket> {
    const op = this.ticketTail.then(async () => {
      const next = appendTicketRound(this.requireTicket(id), round)
      await this.putTicket(next)
      return next
    })
    this.ticketTail = op.catch(() => undefined)
    return op
  }

  attachTicketSession(id: string, sessionId: string, role: 'work' | 'rework' | 'review', at = Date.now()): Promise<void> {
    const op = this.ticketTail.then(async () => {
      const ticket = this.requireTicket(id)
      const task = this.tasks.get(sessionId)
      if (!task || task.origin !== 'started') throw new Error('A started session is required')
      await this.putTicket({ ...ticket, sessions: [...ticket.sessions.filter(row => row.sessionId !== sessionId), { sessionId, role, at }].slice(-20), updatedAt: at })
      await this.put({ ...task, ticketId: id, role })
    })
    this.ticketTail = op.catch(() => undefined)
    return op
  }

  deleteTicket(id: string): Promise<boolean> {
    const op = this.ticketTail.then(async () => {
    const ticket = this.tickets.get(id)
    if (!ticket) return false
    if (ticket.status !== 'draft') throw new Error('Only draft tickets can be deleted')
    const domain = this.domain
    if (domain) {
      const op = this.tail.then(() => this.durable(() => domain.table('tickets').delete(id)))
      this.tail = op.catch(() => undefined)
      await op
    }
    this.tickets.delete(id)
    this.changed()
    return true
    })
    this.ticketTail = op.catch(() => undefined)
    return op
  }

  ticketLockHolders(dir: string, exceptId?: string): Ticket[] { return lockHolders(this.tickets.values(), dir, exceptId) }

  private requireTicket(id: string): Ticket {
    const ticket = this.tickets.get(id)
    if (!ticket) throw new Error(`Unknown ticket: ${id}`)
    return ticket
  }

  private async putTicket(ticket: Ticket): Promise<void> {
    await this.write('tickets', ticket.id, ticket)
    this.tickets.set(ticket.id, ticket)
    this.pruneTickets()
    this.changed()
  }

  private pruneTickets(): void {
    const finished = [...this.tickets.values()].filter(ticket => ticket.status === 'done' || ticket.status === 'cancelled').sort((a, b) => a.updatedAt - b.updatedAt)
    for (const ticket of finished.slice(0, Math.max(0, this.tickets.size - MAX_TASKS))) this.tickets.delete(ticket.id)
  }

  /** Sessions dot opened. Dot's own session and a merely watched human session are not included. */
  ownsSession(sessionId: string): boolean {
    return sessionIsOwned(sessionId, this.ownedInput())
  }

  ownedSessionIds(): string[] {
    return ownedSessionIds(this.ownedInput())
  }

  private ownedInput() {
    return {
      ...(this.dotSessionId ? { dotSessionId: this.dotSessionId } : {}),
      runs: this.work.listRuns(),
      tasks: this.list(),
      tickets: this.listTickets(),
    }
  }

  task(sessionId: string): TaskRecord | undefined { return this.tasks.get(sessionId) }
  list(): TaskRecord[] { return sortTasks([...this.tasks.values()]) }
  tracks(sessionId: string): boolean { return this.tasks.has(sessionId) }

  /** Track a session; tracking an existing one keeps its history and refreshes the goal. */
  track(input: NewTask): Promise<TaskRecord> {
    const existing = this.tasks.get(input.sessionId)
    const task = existing
      ? { ...existing, goal: input.goal || existing.goal, status: existing.status === 'archived' ? 'idle' as const : existing.status, updatedAt: input.at }
      : createTask(input)
    return this.put(task).then(() => task)
  }

  apply(event: LedgerEvent, pending: readonly PendingView[]): Promise<TaskRecord | undefined> {
    const current = this.tasks.get(event.sessionId)
    const blocked = pending.some(item => item.sessionId === event.sessionId)
    const next = applyEvent(current, event, blocked)
    if (next === undefined || next === current) return Promise.resolve(next)
    return this.put(next).then(() => next)
  }

  /** Re-derive blocked flags after the pending set changed. */
  syncPending(pending: readonly PendingView[]): Promise<void> {
    const writes: Promise<void>[] = []
    for (const task of this.tasks.values()) {
      const next = withPending(task, pending)
      if (next !== task) writes.push(this.put(next))
    }
    return Promise.all(writes).then(() => undefined)
  }

  /** dot looked at the ledger: clear unread counters. */
  markAllSeen(): Promise<void> {
    const writes: Promise<void>[] = []
    for (const task of this.tasks.values()) {
      const next = markSeen(task)
      if (next !== task) writes.push(this.put(next))
    }
    return Promise.all(writes).then(() => undefined)
  }

  /** dot read one task: clear its unread counter. */
  markSeen(sessionId: string): Promise<void> {
    const task = this.tasks.get(sessionId)
    if (!task) return Promise.resolve()
    const next = markSeen(task)
    return next === task ? Promise.resolve() : this.put(next)
  }

  /** dot's reminders, the one due first on top. */
  get schedules(): readonly ScheduleRecord[] {
    return [...this.reminders.values()].sort((a, b) => a.nextAt - b.nextAt || a.createdAt - b.createdAt)
  }

  get settingProposals(): readonly SettingProposal[] {
    return [...this.proposals.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  }

  settingProposal(id: string): SettingProposal | undefined { return this.proposals.get(id) }

  putSettingProposal(record: SettingProposal): Promise<void> {
    this.proposals.set(record.id, record)
    this.changed()
    return this.write('proposals', record.id, record)
  }

  deleteSettingProposal(id: string): Promise<boolean> {
    if (!this.proposals.delete(id)) return Promise.resolve(false)
    this.changed()
    const domain = this.domain
    if (!domain) return Promise.resolve(true)
    const op = this.tail.then(() => this.durable(() => domain.table('proposals').delete(id)))
    this.tail = op.catch(() => undefined)
    return op.then(() => true)
  }

  schedule(id: string): ScheduleRecord | undefined { return this.reminders.get(id) }

  putSchedule(record: ScheduleRecord): Promise<void> {
    this.reminders.set(record.id, record)
    this.changed()
    return this.write('schedules', record.id, record)
  }

  /** @returns false when no reminder has that id. */
  deleteSchedule(id: string): Promise<boolean> {
    if (!this.reminders.delete(id)) return Promise.resolve(false)
    this.changed()
    const domain = this.domain
    if (domain === undefined) return Promise.resolve(true)
    const op = this.tail.then(() => this.durable(() => domain.table('schedules').delete(id)))
    this.tail = op.catch(() => undefined)
    return op.then(() => true)
  }

  summary(pending: readonly PendingView[], now = Date.now()): string {
    return ledgerSummary([...this.tasks.values()], pending, now)
  }

  board(pending: readonly PendingView[]): BoardView {
    return {
      ...this.state.dotSessionId === undefined ? {} : { dotSessionId: this.state.dotSessionId },
      tasks: this.list().filter(task => task.origin === 'watched'),
      tickets: deriveTicketViews(this.tickets.values(), this.tasks.values(), pending),
      pending,
      schedules: this.schedules,
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Wait for queued writes; used on shutdown and in tests. */
  async flush(): Promise<void> { await this.ticketTail.catch(() => undefined); await this.tail.catch(() => undefined) }

  private put(task: TaskRecord): Promise<void> {
    this.tasks.set(task.sessionId, task)
    this.prune()
    this.changed()
    return this.write('tasks', task.sessionId, task)
  }

  private prune(): void {
    if (this.tasks.size <= MAX_TASKS) return
    const archived = [...this.tasks.values()].filter(task => task.status === 'archived').sort((a, b) => a.updatedAt - b.updatedAt)
    // Pruned rows leave the memory view only; the domain has no delete and the
    // stale row is skipped again on the next load by the same cap.
    for (const task of archived.slice(0, this.tasks.size - MAX_TASKS)) this.tasks.delete(task.sessionId)
  }

  private write(table: TableName, key: string, value: unknown): Promise<void> {
    const domain = this.domain
    if (domain === undefined) return Promise.resolve()
    // State is a single document: read the latest in-memory state when the queued
    // slot actually runs, so an older queued snapshot cannot overwrite a change that
    // landed in the meantime (e.g. the migration marker merged into it).
    const op = this.tail.then(() => this.durable(() => domain.table(table).put(key, table === 'state' ? this.state : value)))
    this.tail = op.catch(() => undefined)
    return op
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* listeners are observers */ }
    }
  }
}
