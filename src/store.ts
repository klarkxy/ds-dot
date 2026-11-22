/**
 * In-memory ledger mirrored to the storage domain. Writes are serialized so
 * the durable copy follows the in-memory order; reads never wait on disk.
 */
import { APPROVAL_DETAIL_LIMIT } from './approval-risk.ts'
import { COGNITION_HISTORY_MAX, type BoardView, type CognitionVersion, type DotContextUsage, type DotSettings, type DotUsageOffset, type PendingView, type RecipeRecord, type ReflectionRun, type ScheduleRecord, type SettingProposal, type TaskLink, type TaskRecord } from './contracts.ts'
import { ZERO_USAGE, addUsage } from './context.ts'
import { applyEvent, createTask, ledgerSummary, markSeen, sortTasks, withPending, type LedgerEvent, type NewTask } from './ledger.ts'
import { MAX_PAST_SEGMENTS, type PastSegment, type Segment } from './segments.ts'
import { parseSettings } from './settings.ts'
import { isCopyLocale, type CopyLocale } from './i18n/index.ts'
import { STATE_KEY, parseRecipeRecord, parseScheduleRecord, parseSettingProposal, parseState, parseTask, parseTaskLink, type DotState } from './storage.ts'
import { ownedSessionIds, sessionIsOwned } from './peer.ts'
import { WorkBook, isUnknownState, type ChangeRecord, type WorkPersist } from './work.ts'
import { projectWorkIdle, projectWorkLedger } from './work-actions.ts'

type TableName = 'state' | 'tasks' | 'schedules' | 'proposals' | 'changes' | 'inputs' | 'runs' | 'verifications' | 'peers' | 'inbox' | 'recipes' | 'links'

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

/** Interactive cards retained in the state row; older settled/expired cards are evicted. */
export const MAX_STORED_CARDS = 100

export class DotStore {
  private state: DotState
  private current: DotSettings
  private localePref: CopyLocale | undefined
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly reminders = new Map<string, ScheduleRecord>()
  private readonly recipeRows = new Map<string, RecipeRecord>()
  private readonly linkRows = new Map<string, TaskLink>()
  private readonly proposals = new Map<string, SettingProposal>()
  private tail: Promise<unknown> = Promise.resolve()
  private cognitionRevision = 0
  get cognitionVersion(): number { return this.cognitionRevision }
  private readonly listeners = new Set<() => void>()
  readonly work: WorkBook

  constructor(private readonly domain: DotDomainHandle | undefined, initialTasks?: readonly TaskRecord[]) {
    this.state = domain ? parseState(domain.table('state').get(STATE_KEY)) : {}
    this.current = parseSettings(this.state.settings)
    const savedLocale = this.state.settings?.uiLocale
    this.localePref = isCopyLocale(savedLocale) ? savedLocale : undefined
    for (const task of initialTasks ?? []) this.tasks.set(task.sessionId, task)
    if (domain) {
      for (const [key, value] of domain.table('tasks').entries()) {
        const task = parseTask(value)
        if (task && task.sessionId === key) this.tasks.set(task.sessionId, task)
      }
      for (const [key, value] of domain.table('schedules').entries()) {
        const record = parseScheduleRecord(value)
        if (record && record.id === key) this.reminders.set(record.id, record)
      }
      for (const [key, value] of domain.table('proposals').entries()) {
        const proposal = parseSettingProposal(value)
        if (proposal && proposal.id === key) this.proposals.set(proposal.id, proposal)
      }
      for (const [key, value] of domain.table('recipes').entries()) {
        const recipe = parseRecipeRecord(value)
        if (recipe && recipe.id === key) this.recipeRows.set(recipe.id, recipe)
      }
      for (const [key, value] of domain.table('links').entries()) {
        const link = parseTaskLink(value)
        if (link && link.id === key) this.linkRows.set(link.id, link)
      }
    }
    this.work = WorkBook.restore({
      changes: this.loadWork('changes'),
      inputs: this.loadWork('inputs'),
      runs: this.loadWork('runs'),
      verifications: this.loadWork('verifications'),
    }, (table, key, value) => this.persistWork(table, key, value))

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

  get updateStatus(): import('./auto-update.ts').UpdateStatus | undefined { return this.state.update }
  setUpdateStatus(next: import('./auto-update.ts').UpdateStatus | undefined): Promise<void> {
    return this.setDot({ update: next })
  }

  addCard(card: import('./card-state.ts').DotCardRecord): Promise<void> {
    const updated = [...this.cards.map(row => row.answer || row.keepAlive ? row : { ...row, expired: true }), card]
    if (updated.length <= MAX_STORED_CARDS) {
      return this.setDot({ cardSequence: card.number, cards: updated })
    }
    let toDrop = updated.length - MAX_STORED_CARDS
    const pruned = updated.filter(row => {
      if (toDrop <= 0 || row.id === card.id || row.notificationPending || (!row.expired && !row.answer)) return true
      toDrop -= 1
      return false
    })
    return this.setDot({ cardSequence: card.number, cards: pruned })
  }

  expireCards(keepId?: string): Promise<void> {
    if (!this.cards.some(card => !card.expired && !card.answer && !card.keepAlive && card.id !== keepId)) return Promise.resolve()
    return this.setDot({ cards: this.cards.map(card => card.answer || card.keepAlive || card.id === keepId ? card : { ...card, expired: true }) })
  }

  /** Mark one unanswered card expired — a human request that ended without an answer. */
  expireCard(id: string): Promise<void> {
    if (!this.cards.some(card => card.id === id && !card.expired && !card.answer)) return Promise.resolve()
    return this.setDot({ cards: this.cards.map(card => card.id === id && !card.answer ? { ...card, expired: true } : card) })
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
      ...(moved ? { cards: this.cards.map(card => card.answer || card.keepAlive ? card : { ...card, expired: true }) } : {}),
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

  /** Usage of a keepalive ping joins the carried totals: it never appears in any segment's log. */
  addUsageCarry(usage: DotContextUsage): Promise<void> {
    return this.setDot({ usageCarry: addUsage(this.state.usageCarry, usage) })
  }

  /** Refresh the frozen inputs of a segment dot has not replied in yet. */
  refreezeSegment(patch: Pick<Segment, 'persona' | 'model' | 'agreements' | 'cognition' | 'capabilities'>): Promise<void> {
    const segment = this.segment
    if (!segment) return Promise.resolve()
    const { model: _model, agreements: _agreements, agreementsSeen: _aseen, cognition: _cognition, cognitionSeen: _cseen, capabilities: _caps, ...rest } = segment
    return this.setDot({ segment: {
      ...rest,
      persona: patch.persona,
      ...patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {},
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

  get settings(): DotSettings { return this.current }
  get uiLocale(): CopyLocale | undefined { return this.localePref }

  setSettings(next: DotSettings): Promise<void> {
    this.current = next
    const settings: Record<string, unknown> = { ...next }
    if (this.localePref !== undefined) settings.uiLocale = this.localePref
    return this.setDot({ settings })
  }

  setUiLocale(locale: CopyLocale): Promise<void> {
    if (this.localePref === locale) return Promise.resolve()
    this.localePref = locale
    return this.setDot({ settings: { ...(this.state.settings ?? this.current), uiLocale: locale } })
  }

  /**
   * Wipe Dorothy's durable tables and in-memory ledger. Settings return to
   * defaults. `lastFactoryResetAt` is the surviving audit.
   */
  async factoryReset(now = Date.now()): Promise<void> {
    await this.flush()
    const names: TableName[] = ['tasks', 'schedules', 'recipes', 'links', 'proposals', 'changes', 'inputs', 'runs', 'verifications', 'peers']
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
      this.reminders.clear()
      this.recipeRows.clear()
      this.linkRows.clear()
      this.proposals.clear()
      this.work.clear()
      this.localePref = undefined
      this.current = parseSettings(undefined)
      this.cognitionRevision++
      this.state = { lastFactoryResetAt: now }
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

  /** dot's task recipes, ordered by name. */
  get recipes(): readonly RecipeRecord[] {
    return [...this.recipeRows.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
  }

  /** Links between a change and a GitHub target, oldest first. */
  get links(): readonly TaskLink[] {
    return [...this.linkRows.values()].sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id))
  }

  /** The board's work row for one change: workView plus its link chips. */
  workViewWithLinks(changeId: string) {
    const row = this.work.workView(changeId)
    if (!row) return undefined
    const links = this.linksFor(changeId)
    return links.length > 0 ? { ...row, links } : row
  }

  linksFor(changeId: string): readonly TaskLink[] {
    return this.links.filter(link => link.changeId === changeId)
  }

  link(id: string): TaskLink | undefined { return this.linkRows.get(id) }

  putLink(record: TaskLink): Promise<void> {
    this.linkRows.set(record.id, record)
    this.changed()
    return this.write('links', record.id, record)
  }

  deleteLink(id: string): Promise<void> {
    if (!this.linkRows.delete(id)) return Promise.resolve()
    this.changed()
    const domain = this.domain
    if (!domain) return Promise.resolve()
    const op = this.tail.then(() => this.durable(() => domain.table('links').delete(id)))
    this.tail = op.catch(() => undefined)
    return op
  }

  /** Drop every link a pruned change owned. */
  async deleteLinksFor(changeId: string): Promise<void> {
    for (const link of this.linksFor(changeId)) await this.deleteLink(link.id)
  }

  /** Look a recipe up by id, or by exact name case-insensitively. */
  recipe(idOrName: string): RecipeRecord | undefined {
    const direct = this.recipeRows.get(idOrName)
    if (direct) return direct
    const folded = idOrName.trim().toLowerCase()
    return [...this.recipeRows.values()].find(row => row.name.toLowerCase() === folded)
  }

  putRecipe(record: RecipeRecord): Promise<void> {
    this.recipeRows.set(record.id, record)
    this.changed()
    return this.write('recipes', record.id, record)
  }

  /** @returns false when no recipe has that id. */
  deleteRecipe(id: string): Promise<boolean> {
    if (!this.recipeRows.delete(id)) return Promise.resolve(false)
    this.changed()
    const domain = this.domain
    if (domain === undefined) return Promise.resolve(true)
    const op = this.tail.then(() => this.durable(() => domain.table('recipes').delete(id)))
    this.tail = op.catch(() => undefined)
    return op.then(() => true)
  }

  workLedger() { return projectWorkLedger(this.work) }
  workIdle() { return projectWorkIdle(this.work) }

  summary(pending: readonly PendingView[], now = Date.now()): string {
    return ledgerSummary([...this.tasks.values()], pending, now, this.workLedger())
  }

  board(pending: readonly PendingView[]): BoardView {
    const all = this.list()
    const watched = all.filter(task => task.origin === 'watched')
    const started = all.filter(task => task.origin === 'started')
    const work = this.work.listChanges()
      .map(change => this.workViewWithLinks(change.id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
    return {
      ...this.state.dotSessionId === undefined ? {} : { dotSessionId: this.state.dotSessionId },
      tasks: watched,
      ...(started.length > 0 ? { startedTasks: started } : {}),
      ...(work.length > 0 ? { work } : {}),
      pending,
      schedules: this.schedules.map(row => {
        const recipe = row.recipe ? this.recipe(row.recipe) : undefined
        return recipe ? { ...row, recipeName: recipe.name } : row
      }),
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** A work-row mutation that bypassed a DotStore write still needs the board signal. */
  workChanged(): void { this.changed() }

  /** Wait for queued writes; used on shutdown and in tests. */
  async flush(): Promise<void> { await this.tail.catch(() => undefined) }

  private put(task: TaskRecord): Promise<void> {
    this.tasks.set(task.sessionId, task)
    this.prune()
    this.changed()
    return this.write('tasks', task.sessionId, task)
  }

  /** Evict oldest terminal WorkBook changes from both memory and durable storage. */
  pruneWorkHistory(maxKeep?: number, beforeRemove?: (change: ChangeRecord, failedRounds: number) => Promise<void>, at = Date.now()): Promise<{ readonly prunedChanges: readonly string[]; readonly keptArtifacts: ReadonlySet<string> }> {
    return this.work.pruneCompletedChanges(maxKeep, async (table, key) => {
      const domain = this.domain
      if (!domain) return
      const op = this.tail.then(() => this.durable(() => domain.table(table).delete(key)))
      this.tail = op.catch(() => undefined)
      await op
    }, beforeRemove, at)
  }

  private prune(): void {
    if (this.tasks.size <= MAX_TASKS) return
    const archived = [...this.tasks.values()].filter(task => task.status === 'archived').sort((a, b) => a.updatedAt - b.updatedAt)
    const evicted = archived.slice(0, this.tasks.size - MAX_TASKS)
    for (const task of evicted) this.tasks.delete(task.sessionId)
    const domain = this.domain
    if (domain && evicted.length > 0) {
      const op = this.tail.then(async () => {
        for (const task of evicted) await this.durable(() => domain.table('tasks').delete(task.sessionId))
      })
      this.tail = op.catch(() => undefined)
    }
  }

  private write(table: TableName, key: string, value: unknown): Promise<void> {
    const domain = this.domain
    if (domain === undefined) return Promise.resolve()
    // State is a single document: read the latest in-memory state when the queued
    // slot actually runs, so an older queued snapshot cannot overwrite a change that
    // landed in the meantime.
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
