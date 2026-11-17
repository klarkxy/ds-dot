import { Button, Input, SegmentedTabs, StateDot, Tag, type SegmentedTab, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId, useMemo, useState } from 'react'
import { FINISHED_SHOWN, groupBoard } from './board-groups.ts'
import type { BoardView, SessionRole, TaskStatus, TicketAccess, TicketPriority, TicketStatus, TicketView } from './contracts.ts'
import { formatWhen, t, timingLabel, type CopyLocale, type TextKey } from './ui-copy.ts'

export const BOARD_ROOT = 'dsh-dot-board'

const DOT: Record<TaskStatus, StateDotState> = {
  running: 'ongoing', idle: 'done', blocked: 'warning', error: 'error', archived: 'idle',
}

const STATUS_KEY: Record<TicketStatus, TextKey> = {
  draft: 'ticketDraft', todo: 'ticketTodo', active: 'ticketActive', review: 'ticketReview', done: 'ticketDone', cancelled: 'ticketCancelled',
}
const STATUS_TONE: Record<TicketStatus, TagTone> = {
  draft: 'quiet', todo: 'neutral', active: 'info', review: 'warning', done: 'success', cancelled: 'quiet',
}
const PRIORITY_KEY: Record<TicketPriority, TextKey> = { 3: 'priorityHigh', 2: 'priorityNormal', 1: 'priorityLow' }
const ACCESS_KEY: Record<TicketAccess, TextKey> = { read: 'accessRead', write: 'accessWrite' }
const ROLE_KEY: Record<SessionRole, TextKey> = { work: 'roleWork', rework: 'roleRework', review: 'roleReview' }

export interface BoardActions {
  /** Draft to todo. */
  readonly onConfirm: (id: string) => void
  /** Delete a draft. */
  readonly onDelete: (id: string) => void
  readonly onCancel: (id: string) => void
  /** Accept (done) or send back (active again, with an optional note). */
  readonly onReview: (id: string, pass: boolean, note?: string) => void
  readonly onPriority: (id: string, priority: TicketPriority) => void
}

/** Which part of the board the drawer shows: everything, or one of its three tabs. */
export type BoardFilter = 'all' | 'waiting' | 'active' | 'watch'

/** Items under each filter tab, from the same grouping the board draws. */
export function boardCounts(view: BoardView | undefined): Record<Exclude<BoardFilter, 'all'>, number> {
  if (!view) return { waiting: 0, active: 0, watch: 0 }
  const groups = groupBoard(view)
  return { waiting: groups.waitingCount, active: groups.active.length + groups.todo.length, watch: groups.watched.length + view.schedules.length }
}

export interface BoardProps extends BoardActions {
  readonly locale: CopyLocale
  readonly view: BoardView | undefined
  readonly error?: string
  /** The last board action that failed, shown above the groups. */
  readonly notice?: string
  /** Defaults to 'all'; finished tasks only show there. */
  readonly filter?: BoardFilter
  readonly onOpen: (sessionId: string) => void
  readonly onRetry: () => void
  readonly onRemoveSchedule: (id: string) => void
}

function dotOf(ticket: TicketView): StateDotState {
  if (ticket.error) return 'error'
  if (ticket.waiting || ticket.orphaned || (ticket.status === 'review' && ticket.humanReview === true)) return 'warning'
  if (ticket.status === 'done') return 'done'
  if (ticket.status === 'active' || ticket.status === 'review') return ticket.running ? 'ongoing' : 'idle'
  return 'idle'
}

function PriorityChoice({ locale, value, onChange }: { locale: CopyLocale; value: TicketPriority; onChange: (next: TicketPriority) => void }) {
  const baseId = useId()
  const items = useMemo(() => ([3, 2, 1] as const).map(priority => ({
    id: `${baseId}-${priority}`,
    panelId: `${baseId}-${priority}-panel`,
    value: String(priority),
    label: t(locale, PRIORITY_KEY[priority]),
  })) as unknown as readonly [SegmentedTab<string>, ...SegmentedTab<string>[]], [baseId, locale])
  return (
    <SegmentedTabs<string>
      size="sm"
      label={t(locale, 'priorityLabel')}
      items={items}
      value={String(value)}
      onChange={next => { const priority = Number(next) as TicketPriority; if (priority !== value) onChange(priority) }}
    />
  )
}

function TextBlock({ label, text }: { label: string; text: string | undefined }) {
  if (!text) return null
  return (
    <div className="dsh-dot-block">
      <span className="dsh-ui-meta">{label}</span>
      <p className="dsh-dot-text">{text}</p>
    </div>
  )
}

function TicketDetail({ locale, ticket, actions, onOpen }: { locale: CopyLocale; ticket: TicketView; actions: BoardActions; onOpen: (sessionId: string) => void }) {
  const finished = ticket.status === 'done' || ticket.status === 'cancelled'
  return (
    <div className="dsh-dot-detail">
      <TextBlock label={t(locale, 'taskGoal')} text={ticket.goal} />
      <TextBlock label={t(locale, 'taskDeliverable')} text={ticket.deliverable} />
      <TextBlock label={t(locale, 'taskAcceptance')} text={ticket.acceptance} />
      {finished ? null : (
        <div className="dsh-dot-block">
          <span className="dsh-ui-meta">{t(locale, 'priorityLabel')}</span>
          <PriorityChoice locale={locale} value={ticket.priority} onChange={priority => actions.onPriority(ticket.id, priority)} />
        </div>
      )}
      <div className="dsh-dot-block">
        <span className="dsh-ui-meta">{t(locale, 'taskSessions')}</span>
        {ticket.sessions.length === 0 ? <span className="dsh-ui-hint">{t(locale, 'taskNoSessions')}</span> : null}
        {[...ticket.sessions].reverse().map(session => (
          <button key={session.sessionId} type="button" className="dsh-dot-row dsh-dot-line" title={session.sessionId} onClick={() => onOpen(session.sessionId)}>
            <span className="dsh-ui-compact dsh-ui-truncate">{t(locale, ROLE_KEY[session.role])}</span>
            <span className="dsh-ui-spacer" />
            <span className="dsh-ui-meta">{formatWhen(session.at)}</span>
          </button>
        ))}
      </div>
      {ticket.rounds.length > 0 ? (
        <div className="dsh-dot-block">
          <span className="dsh-ui-meta">{t(locale, 'taskRounds')}</span>
          {[...ticket.rounds].reverse().map(round => (
            <div key={round.n} className="dsh-dot-entry">
              <span className="dsh-ui-hint">
                #{round.n} · {t(locale, ROLE_KEY[round.role])}
                {round.verdict ? ` · ${t(locale, round.verdict === 'pass' ? 'verdictPass' : 'verdictFail')}` : ''} · {formatWhen(round.at)}
              </span>
              <p className="dsh-dot-text">{round.summary}</p>
            </div>
          ))}
        </div>
      ) : null}
      {ticket.history.length > 0 ? (
        <div className="dsh-dot-block">
          <span className="dsh-ui-meta">{t(locale, 'taskHistory')}</span>
          {[...ticket.history].reverse().map((move, index) => (
            <div key={`${move.at}-${index}`} className="dsh-dot-entry">
              <span className="dsh-ui-hint">
                {formatWhen(move.at)} · {move.from ? `${t(locale, STATUS_KEY[move.from])} → ` : ''}{t(locale, STATUS_KEY[move.to])} · {t(locale, move.by === 'human' ? 'byHuman' : 'byDot')}
              </span>
              <p className="dsh-dot-text">{move.reason}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TicketRow({ locale, ticket, expanded, actions, onToggle, onOpen }: {
  locale: CopyLocale
  ticket: TicketView
  expanded: boolean
  actions: BoardActions
  onToggle: () => void
  onOpen: (sessionId: string) => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const finished = ticket.status === 'done' || ticket.status === 'cancelled'
  const asksHuman = ticket.status === 'review' && ticket.humanReview === true
  const place = `${t(locale, ACCESS_KEY[ticket.access])} · ${ticket.dir}${ticket.roundCount > 0 ? ` · ${t(locale, 'roundsCount').replace('{n}', String(ticket.roundCount))}` : ''}`
  return (
    <div className="dsh-dot-ticket" data-status={ticket.status}>
      <div className="dsh-dot-ticket-head">
        <button type="button" className="dsh-dot-row" aria-expanded={expanded} title={t(locale, expanded ? 'closeTask' : 'openTask')} onClick={onToggle}>
          <StateDot state={dotOf(ticket)} />
          <span className="dsh-dot-main">
            <span className="dsh-dot-titleline">
              <span className="dsh-ui-compact dsh-ui-truncate">{ticket.title}</span>
              <Tag tone={STATUS_TONE[ticket.status]}>{t(locale, STATUS_KEY[ticket.status])}</Tag>
              {ticket.priority === 2 ? null : <Tag tone={ticket.priority === 3 ? 'warning' : 'quiet'}>{t(locale, PRIORITY_KEY[ticket.priority])}</Tag>}
              {ticket.waiting ? <Tag tone="warning">{t(locale, 'flagWaiting')}</Tag> : null}
              {ticket.error ? <Tag tone="danger">{t(locale, 'error')}</Tag> : null}
              {ticket.orphaned ? <Tag tone="warning">{t(locale, 'flagOrphaned')}</Tag> : null}
            </span>
            <span className="dsh-ui-hint dsh-ui-truncate" title={ticket.dir}>{place}</span>
            {ticket.lockedBy ? <span className="dsh-ui-hint dsh-ui-truncate">{t(locale, 'lockedBy').replace('{id}', ticket.lockedBy.id)}</span> : null}
            {ticket.latestNote ? <span className="dsh-ui-hint dsh-ui-truncate">{ticket.latestNote}</span> : null}
          </span>
        </button>
        {rejecting ? null : (
          <div className="dsh-dot-ticket-actions">
            {ticket.status === 'draft' ? <Button variant="primary" size="sm" onClick={() => actions.onConfirm(ticket.id)}>{t(locale, 'taskConfirm')}</Button> : null}
            {ticket.status === 'draft' ? <Button variant="ghost" size="sm" onClick={() => actions.onDelete(ticket.id)}>{t(locale, 'taskDelete')}</Button> : null}
            {asksHuman ? <Button variant="primary" size="sm" onClick={() => actions.onReview(ticket.id, true)}>{t(locale, 'taskPass')}</Button> : null}
            {asksHuman ? <Button variant="ghost" size="sm" onClick={() => setRejecting(true)}>{t(locale, 'taskReject')}</Button> : null}
            {finished ? null : <Button variant="ghost" size="sm" onClick={() => actions.onCancel(ticket.id)}>{t(locale, 'taskCancel')}</Button>}
          </div>
        )}
      </div>
      {rejecting ? (
        <div className="dsh-dot-reject">
          <Input
            className="dsh-dot-reject-note"
            aria-label={t(locale, 'taskRejectNote')}
            placeholder={t(locale, 'taskRejectNote')}
            value={note}
            maxLength={600}
            onChange={event => setNote(event.target.value)}
          />
          <Button variant="primary" size="sm" onClick={() => { actions.onReview(ticket.id, false, note.trim() || undefined); setRejecting(false); setNote('') }}>{t(locale, 'taskRejectSend')}</Button>
          <Button variant="ghost" size="sm" onClick={() => { setRejecting(false); setNote('') }}>{t(locale, 'taskBack')}</Button>
        </div>
      ) : null}
      {expanded ? <TicketDetail locale={locale} ticket={ticket} actions={actions} onOpen={onOpen} /> : null}
    </div>
  )
}

function GroupTitle({ title, count }: { title: string; count?: number }) {
  return <span className="dsh-ui-meta">{count === undefined ? title : `${title} · ${count}`}</span>
}

/**
 * Task board: what needs the human first, then tasks in progress, the queue,
 * recently finished tasks, watched sessions and Dorothy's reminders. Pure
 * render over a board snapshot; every action goes out through a callback.
 */
export function Board({ locale, view, error, notice, filter = 'all', onOpen, onRetry, onRemoveSchedule, ...actions }: BoardProps) {
  const [expanded, setExpanded] = useState<string>()
  const [showFinished, setShowFinished] = useState(false)
  if (view === undefined) {
    return (
      <div className={BOARD_ROOT}>
        {error === undefined ? null : (
          <div className="dsh-ui-row">
            <span className="dsh-ui-error">{t(locale, 'loadFailed')}: {error}</span>
            <Button variant="ghost" onClick={onRetry}>{t(locale, 'retry')}</Button>
          </div>
        )}
      </div>
    )
  }
  const groups = groupBoard(view)
  const row = (ticket: TicketView) => (
    <TicketRow
      key={ticket.id}
      locale={locale}
      ticket={ticket}
      expanded={expanded === ticket.id}
      actions={actions}
      onToggle={() => setExpanded(current => current === ticket.id ? undefined : ticket.id)}
      onOpen={onOpen}
    />
  )
  const shows = (section: BoardFilter) => filter === 'all' || filter === section
  const counts = boardCounts(view)
  const empty = filter === 'all'
    ? groups.liveCount === 0 && groups.finished.length === 0 && view.pending.length === 0 && view.schedules.length === 0
    : counts[filter] === 0 && !(filter === 'watch' && groups.watchedArchived > 0)
  return (
    <div className={BOARD_ROOT}>
      <div className="dsh-ui-stack">
        {error !== undefined ? <div className="dsh-ui-row" role="alert"><span className="dsh-ui-error">{t(locale, 'loadFailed')}: {error}</span><Button variant="ghost" onClick={onRetry}>{t(locale, 'retry')}</Button></div> : null}
        {notice ? <div className="dsh-ui-error" role="alert">{t(locale, 'taskActionFailed')}{notice}</div> : null}
        {empty ? <p className="dsh-ui-hint">{t(locale, 'empty')}</p> : null}
        {shows('waiting') && groups.waitingCount > 0 ? (
          <section className="dsh-ui-stack" aria-label={t(locale, 'boardWaiting')}>
            <GroupTitle title={t(locale, 'boardWaiting')} count={groups.waitingCount} />
            {groups.requests.map(item => (
              <button key={item.id} type="button" className="dsh-dot-row" onClick={() => onOpen(item.sessionId)}>
                <StateDot state="warning" />
                <span className="dsh-ui-compact dsh-ui-truncate">{item.subject}</span>
                <span className="dsh-ui-spacer" />
                <Tag tone="outline">{t(locale, item.kind)}</Tag>
              </button>
            ))}
            {groups.review.map(row)}
            {groups.drafts.map(row)}
          </section>
        ) : null}
        {shows('active') && groups.active.length > 0 ? (
          <section className="dsh-ui-stack" aria-label={t(locale, 'boardActive')}>
            <GroupTitle title={t(locale, 'boardActive')} count={groups.active.length} />
            {groups.active.map(row)}
          </section>
        ) : null}
        {shows('active') && groups.todo.length > 0 ? (
          <section className="dsh-ui-stack" aria-label={t(locale, 'boardTodo')}>
            <GroupTitle title={t(locale, 'boardTodo')} count={groups.todo.length} />
            {groups.todo.map(row)}
          </section>
        ) : null}
        {filter === 'all' && groups.finished.length > 0 ? (
          <section className="dsh-ui-stack" aria-label={t(locale, 'boardDone')}>
            <Button
              variant="ghost"
              size="sm"
              className="dsh-dot-fold"
              aria-expanded={showFinished}
              title={t(locale, showFinished ? 'hideFinished' : 'showFinished')}
              onClick={() => setShowFinished(open => !open)}
            >
              {t(locale, 'boardDone')} · {groups.finished.length}
            </Button>
            {showFinished ? groups.finished.slice(0, FINISHED_SHOWN).map(row) : null}
          </section>
        ) : null}
        {shows('watch') && (groups.watched.length > 0 || groups.watchedArchived > 0) ? (
          <section className="dsh-ui-stack" aria-label={t(locale, 'boardWatched')}>
            <GroupTitle title={t(locale, 'boardWatched')} count={groups.watched.length} />
            {groups.watched.map(task => (
              <button key={task.sessionId} type="button" className="dsh-dot-row" onClick={() => onOpen(task.sessionId)}>
                <StateDot state={DOT[task.status]} />
                <span className="dsh-dot-main">
                  <span className="dsh-ui-compact dsh-ui-truncate">{task.title}</span>
                  {task.lastNote ? <span className="dsh-ui-hint dsh-ui-truncate">{task.lastNote}</span> : null}
                </span>
                <span className="dsh-ui-spacer" />
                {task.unseenTurns > 0 ? <span className="dsh-ui-meta">{task.unseenTurns} {t(locale, 'unread')}</span> : null}
                <Tag tone="outline">{t(locale, task.status)}</Tag>
              </button>
            ))}
            {groups.watchedArchived > 0 ? <span className="dsh-ui-hint">{t(locale, 'archived')} · {groups.watchedArchived}</span> : null}
          </section>
        ) : null}
        {shows('watch') && view.schedules.length > 0 ? (
          <section className="dsh-ui-stack" aria-label={t(locale, 'reminders')}>
            <span className="dsh-ui-meta">{t(locale, 'reminders')}</span>
            {view.schedules.map(item => (
              <div key={item.id} className="dsh-dot-reminder">
                <span className="dsh-dot-main">
                  <span className="dsh-ui-compact dsh-ui-truncate" title={item.prompt}>{item.title}</span>
                  <span className="dsh-ui-hint dsh-ui-truncate">{timingLabel(locale, item.timing)} · {t(locale, 'reminderNext').replace('{when}', formatWhen(item.nextAt))}</span>
                </span>
                <span className="dsh-ui-spacer" />
                <Button variant="ghost" size="sm" title={t(locale, 'reminderRemoveTip')} onClick={() => onRemoveSchedule(item.id)}>{t(locale, 'reminderRemove')}</Button>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  )
}

// Selectors spell the root out (.dsh-dot-board = BOARD_ROOT) so the repository scope check can read them.
export const boardCss = `
.dsh-dot-board { padding: 12px; overflow-y: auto; height: 100%; }
.dsh-dot-board .dsh-dot-row {
  display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0;
  padding: 8px 10px; border: 0; border-radius: var(--dsw-radius-sm);
  background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.dsh-dot-board .dsh-dot-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-board .dsh-dot-main { display: flex; flex-direction: column; min-width: 0; }
.dsh-dot-board .dsh-dot-reminder { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 4px 4px 10px; }
.dsh-dot-board .dsh-dot-reminder > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-board .dsh-dot-row > .dsh-ui-meta { white-space: nowrap; flex-shrink: 0; }
.dsh-dot-board .dsh-dot-ticket { display: flex; flex-direction: column; min-width: 0; }
.dsh-dot-board .dsh-dot-ticket-head { display: flex; align-items: center; gap: 4px; min-width: 0; }
.dsh-dot-board .dsh-dot-ticket-head > .dsh-dot-row { flex: 1 1 auto; width: auto; min-width: 0; }
.dsh-dot-board .dsh-dot-ticket-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.dsh-dot-board .dsh-dot-ticket-actions > button { white-space: nowrap; }
.dsh-dot-board .dsh-dot-titleline { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.dsh-dot-board .dsh-dot-reject { display: flex; align-items: center; gap: 6px; padding: 0 10px 6px 28px; }
.dsh-dot-board .dsh-dot-reject-note { flex: 1 1 140px; min-width: 0; }
.dsh-dot-board .dsh-dot-reject > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-board .dsh-dot-detail {
  display: flex; flex-direction: column; gap: 10px; margin: 2px 10px 6px 28px; padding: 10px 12px;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke);
}
.dsh-dot-board .dsh-dot-block { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsh-dot-board .dsh-dot-entry { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-dot-board .dsh-dot-text { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-dot-board .dsh-dot-line { padding: 4px 6px; }
.dsh-dot-board .dsh-dot-fold { align-self: flex-start; }
`
