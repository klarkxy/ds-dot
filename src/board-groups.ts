import type { BoardView, PendingView, TaskRecord, TicketView } from './contracts.ts'
import { lookRequest } from './work-board.ts'

/** How many finished tasks the collapsed group lists once opened. */
export const FINISHED_SHOWN = 50

export interface BoardGroups {
  /** Group 1: waiting requests, then tasks the human must look at, then drafts. */
  readonly requests: readonly PendingView[]
  readonly review: readonly TicketView[]
  readonly drafts: readonly TicketView[]
  /** Group 2: active tasks and tasks in review that dot has not handed to the human. */
  readonly active: readonly TicketView[]
  /** Group 3. */
  readonly todo: readonly TicketView[]
  /** Group 4: done and cancelled, newest first. */
  readonly finished: readonly TicketView[]
  /** Group 5: sessions the human asked dot to watch. */
  readonly watched: readonly TaskRecord[]
  readonly watchedArchived: number
  /** Size of group 1: what the legacy board group counts. */
  readonly waitingCount: number
  /** Tasks and watched sessions that are not finished. */
  readonly liveCount: number
}

const byPriority = (a: TicketView, b: TicketView) => b.priority - a.priority || b.updatedAt - a.updatedAt

/** Split a board snapshot into the groups the board draws, in display order. */
export function groupBoard(view: BoardView): BoardGroups {
  const tickets = view.tickets
  const review = tickets.filter(ticket => ticket.status === 'review' && ticket.humanReview === true).sort(byPriority)
  const drafts = tickets.filter(ticket => ticket.status === 'draft').sort((a, b) => b.updatedAt - a.updatedAt)
  const active = tickets.filter(ticket => ticket.status === 'active' || (ticket.status === 'review' && ticket.humanReview !== true)).sort(byPriority)
  const todo = tickets.filter(ticket => ticket.status === 'todo').sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
  const finished = tickets.filter(ticket => ticket.status === 'done' || ticket.status === 'cancelled').sort((a, b) => b.updatedAt - a.updatedAt)
  const watched = view.tasks.filter(task => task.status !== 'archived')
  return {
    requests: view.pending,
    review,
    drafts,
    active,
    todo,
    finished,
    watched,
    watchedArchived: view.tasks.length - watched.length,
    waitingCount: view.pending.length + review.length + drafts.length,
    liveCount: review.length + drafts.length + active.length + todo.length + watched.length,
  }
}

/**
 * Header badge totals combining `BoardGroups` with `WorkBook` Changes (`view.work`).
 * Avoids double-counting a pending look request that is already in `view.pending`.
 */
export function headerBoardCounts(view: BoardView | undefined): { readonly liveCount: number; readonly waitingCount: number } {
  if (!view) return { liveCount: 0, waitingCount: 0 }
  const base = groupBoard(view)
  const work = view.work ?? []
  if (work.length === 0) return { liveCount: base.liveCount, waitingCount: base.waitingCount }
  let workLive = 0
  let workExtraWaiting = 0
  for (const item of work) {
    if (item.status === 'done' || item.status === 'cancelled') continue
    workLive += 1
    const look = lookRequest(item, view.pending)
    // If `look` is a bound PendingGlance object, `base.waitingCount` already counted it via `view.pending`.
    const coveredByPending = typeof look === 'object' && look !== null
    if (!coveredByPending && item.humanAction && !item.oversight?.requested) workExtraWaiting += 1
  }
  return {
    liveCount: base.liveCount + workLive,
    waitingCount: base.waitingCount + workExtraWaiting,
  }
}

/** Title and directory of every session the board knows, for the notices and tool rows in the chat. */
export function sessionLookup(view: BoardView | undefined): Map<string, { title: string; cwd?: string }> {
  const map = new Map<string, { title: string; cwd?: string }>()
  for (const ticket of view?.tickets ?? []) for (const session of ticket.sessions) map.set(session.sessionId, { title: ticket.title, ...ticket.dir ? { cwd: ticket.dir } : {} })
  for (const task of view?.startedTasks ?? []) map.set(task.sessionId, { title: task.title, ...task.cwd ? { cwd: task.cwd } : {} })
  for (const task of view?.tasks ?? []) map.set(task.sessionId, { title: task.title, ...task.cwd ? { cwd: task.cwd } : {} })
  return map
}
