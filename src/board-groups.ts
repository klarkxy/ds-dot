import type { BoardView, PendingView, TaskRecord } from './contracts.ts'
import { acceptPayload, lookRequest, parseWorkLook } from './work-board.ts'

/** How many finished tasks the collapsed group lists once opened. */
export const FINISHED_SHOWN = 50

export interface BoardGroups {
  /** Group 1: waiting requests. */
  readonly requests: readonly PendingView[]
  /** Sessions the human asked dot to watch. */
  readonly watched: readonly TaskRecord[]
  readonly watchedArchived: number
  /** Watched sessions that are not archived. */
  readonly liveCount: number
}

/** Split a board snapshot into the groups the board draws, in display order. */
export function groupBoard(view: BoardView): BoardGroups {
  const watched = view.tasks.filter(task => task.status !== 'archived')
  return {
    requests: view.pending,
    watched,
    watchedArchived: view.tasks.length - watched.length,
    liveCount: watched.length,
  }
}
/**
 * Header badge totals combining `BoardGroups` with `WorkBook` Changes (`view.work`).
 * Avoids double-counting a pending look request that is already in `view.pending`.
 */
export function headerBoardCounts(view: BoardView | undefined): { readonly liveCount: number; readonly waitingCount: number } {
  if (!view) return { liveCount: 0, waitingCount: 0 }
  const work = view.work ?? []
  const pending = view.pending.filter(row => {
    const request = parseWorkLook(row)
    if (!request) return true
    const item = work.find(item => item.id === request.changeId)
    if (!item || item.status === 'done' || item.status === 'cancelled') return false
    const current = lookRequest(item, [row])
    return typeof current === 'object' && current.id === row.id
  })
  const base = groupBoard({ ...view, pending })
  if (work.length === 0) return { liveCount: base.liveCount, waitingCount: base.requests.length }
  let workLive = 0
  let workExtraWaiting = 0
  for (const item of work) {
    if (item.status === 'done' || item.status === 'cancelled') continue
    workLive += 1
    const look = lookRequest(item, pending)
    // A current request is already counted in pending. An independent current
    // action still counts when an older oversight request is stale or withdrawn.
    const coveredByPending = typeof look === 'object' && look !== null
    if (!coveredByPending && acceptPayload(item)) workExtraWaiting += 1
  }
  return {
    liveCount: base.liveCount + workLive,
    waitingCount: base.requests.length + workExtraWaiting,
  }
}

/** Title and directory of every session the board knows, for the notices and tool rows in the chat. */
export function sessionLookup(view: BoardView | undefined): Map<string, { title: string; cwd?: string }> {
  const map = new Map<string, { title: string; cwd?: string }>()
  for (const task of view?.startedTasks ?? []) map.set(task.sessionId, { title: task.title, ...task.cwd ? { cwd: task.cwd } : {} })
  for (const task of view?.tasks ?? []) map.set(task.sessionId, { title: task.title, ...task.cwd ? { cwd: task.cwd } : {} })
  return map
}
