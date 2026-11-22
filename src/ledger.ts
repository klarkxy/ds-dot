/**
 * Pure task ledger. Host listeners feed events in; the board, the injected
 * summary and the wake-up batches read the result. Nothing here touches the
 * host, so every transition is unit-tested.
 */
import type { PendingView, TaskOrigin, TaskRecord, TaskStatus } from './contracts.ts'

export type LedgerEvent =
  | { readonly type: 'status'; readonly sessionId: string; readonly status: 'running' | 'idle'; readonly at: number }
  | { readonly type: 'turn-end'; readonly sessionId: string; readonly at: number; readonly note?: string }
  | { readonly type: 'error'; readonly sessionId: string; readonly at: number; readonly message: string }
  | { readonly type: 'archived'; readonly sessionId: string; readonly at: number }
  | { readonly type: 'title'; readonly sessionId: string; readonly at: number; readonly title: string }

export interface NewTask {
  readonly sessionId: string
  readonly origin: TaskOrigin
  readonly title: string
  readonly goal: string
  readonly cwd: string
  readonly workspaceId?: string
  readonly preset?: string
  readonly at: number
}

export interface WorkLedgerItem {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly priority: 1 | 2 | 3
  readonly revision: number
  readonly control: string
  readonly status: string
  readonly activeRuns: number
  readonly sessionIds: readonly string[]
  readonly blockers: readonly string[]
  readonly needsHumanLook?: boolean
  readonly readyToAccept?: boolean
}

const NOTE_LIMIT = 240

export function clip(text: string, limit = NOTE_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + '…'
}

export function createTask(input: NewTask): TaskRecord {
  return {
    sessionId: input.sessionId,
    origin: input.origin,
    title: clip(input.title, 80) || input.sessionId,
    goal: clip(input.goal, 600),
    cwd: input.cwd,
    ...input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId },
    ...input.preset === undefined ? {} : { preset: input.preset },
    status: 'idle',
    createdAt: input.at,
    updatedAt: input.at,
    unseenTurns: 0,
  }
}

/**
 * Apply one host event. Unknown sessions return undefined: the ledger only
 * tracks what dot started or was asked to watch. A blocked task keeps its
 * blocked status through running/idle flips until the pending set clears it.
 */
export function applyEvent(task: TaskRecord | undefined, event: LedgerEvent, blocked: boolean): TaskRecord | undefined {
  if (task === undefined || task.sessionId !== event.sessionId) return undefined
  if (task.status === 'archived' && event.type !== 'title') return task
  const base = { ...task, updatedAt: Math.max(task.updatedAt, event.at) }
  switch (event.type) {
    case 'status':
      return { ...base, status: settle(event.status, blocked, task.status) }
    case 'turn-end':
      return {
        ...base,
        status: blocked ? 'blocked' : 'idle',
        unseenTurns: task.unseenTurns + 1,
        ...event.note === undefined ? {} : { lastNote: clip(event.note) },
      }
    case 'error':
      return { ...base, status: 'error', lastNote: clip(event.message) }
    case 'archived':
      return { ...base, status: 'archived' }
    case 'title':
      return { ...base, title: clip(event.title, 80) || task.title }
  }
}

function settle(next: 'running' | 'idle', blocked: boolean, previous: TaskStatus): TaskStatus {
  if (blocked) return 'blocked'
  // An error stays visible until the task runs again.
  if (next === 'idle' && previous === 'error') return 'error'
  return next
}

/** Recompute blocked state after a pending request was added or resolved. */
export function withPending(task: TaskRecord, pending: readonly PendingView[]): TaskRecord {
  const blocked = pending.some(item => item.sessionId === task.sessionId)
  if (blocked && task.status !== 'archived') return { ...task, status: 'blocked' }
  if (!blocked && task.status === 'blocked') return { ...task, status: 'running' }
  return task
}

export function markSeen(task: TaskRecord): TaskRecord {
  return task.unseenTurns === 0 ? task : { ...task, unseenTurns: 0 }
}

const STATUS_ORDER: Record<TaskStatus, number> = { blocked: 0, error: 1, running: 2, idle: 3, archived: 4 }

export function sortTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt - a.updatedAt)
}

/**
 * Compact ledger block for dot's context: one line per live Change plus
 * watched sessions and waiting requests. Archived or finished entries are counted.
 */
export function ledgerSummary(
  tasks: readonly TaskRecord[],
  pending: readonly PendingView[],
  now: number,
  changes?: readonly WorkLedgerItem[],
): string {
  if (changes && changes.length > 0) {
    const lines = ['[dot ledger]']
    lines.push('Changes:')
    const activeChanges = changes.filter(item => item.status !== 'done' && item.status !== 'cancelled')
    const changeRequests = (item: WorkLedgerItem) => pending.filter(req => item.sessionIds.includes(req.sessionId))
    const changeUrgent = (item: WorkLedgerItem) => changeRequests(item).length > 0 || item.status === 'rework' || item.status === 'unverified' || item.readyToAccept === true
    activeChanges.sort((a, b) => Number(changeUrgent(b)) - Number(changeUrgent(a)) || b.priority - a.priority || a.id.localeCompare(b.id))
    for (const item of activeChanges) {
      const paused = item.control === 'paused' ? ' [PAUSED]' : ''
      const blockers = item.blockers.length > 0 ? ` · open runs: ${item.blockers.join(', ')}` : ''
      const reqMark = changeRequests(item).map(req => ` · WAITING ${req.id}`).join('')
      const human = item.needsHumanLook ? ' · needs the human\'s look' : item.readyToAccept ? ' · ready to close out' : ''
      lines.push(`- ${item.id} ${item.status.toUpperCase()}${paused} P${item.priority} rev=${item.revision} ${item.cwd} "${item.title}" · ${item.activeRuns} active run(s)${blockers}${reqMark}${human}`)
    }
    const hiddenChanges = changes.length - activeChanges.length
    if (hiddenChanges > 0) lines.push(`(${hiddenChanges} done or cancelled change(s) hidden)`)
    lines.push('Watched sessions:')
    for (const task of sortTasks(tasks).filter(row => row.origin === 'watched' && row.status !== 'archived')) lines.push(`- ${task.status.toUpperCase()} ${task.sessionId} "${task.title}" (${formatAge(now - task.updatedAt)} ago)${task.unseenTurns ? ` · ${task.unseenTurns} unread turn(s)` : ''}`)
    if (pending.length) { lines.push('Waiting requests:'); for (const item of pending) lines.push(`- ${item.id} ${item.kind} from ${item.sessionId}: ${clip(item.subject, 160)}`) }
    return lines.join('\n')
  }
  const live = sortTasks(tasks).filter(task => task.status !== 'archived')
  const archived = tasks.length - live.length
  const lines = ['[dot ledger]']
  if (live.length === 0) lines.push('No tracked tasks.')
  for (const task of live) {
    const age = formatAge(now - task.updatedAt)
    const unseen = task.unseenTurns > 0 ? ` · ${task.unseenTurns} unread turn(s)` : ''
    const note = task.lastNote ? ` · ${task.lastNote}` : ''
    lines.push(`- ${task.status.toUpperCase()} ${task.sessionId} "${task.title}" (${task.origin}, ${age} ago)${unseen}${note}`)
  }
  if (archived > 0) lines.push(`(${archived} archived task(s) hidden)`)
  if (pending.length > 0) {
    lines.push('Waiting requests:')
    for (const item of pending) lines.push(`- ${item.id} ${item.kind} from ${item.sessionId}: ${clip(item.subject, 160)}`)
  }
  return lines.join('\n')
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h`
  return `${Math.round(h / 24)}d`
}
