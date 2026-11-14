import type { PendingView, TaskRecord, Ticket, TicketView } from './contracts.ts'
import { lockHolders } from './lock.ts'

/**
 * Work out what the board shows for each task from its stored record, its
 * session rows and the waiting requests. Nothing here is persisted.
 * Newest-updated first; the client orders the groups.
 */
export function deriveTicketViews(
  tickets: Iterable<Ticket>,
  tasks: Iterable<TaskRecord>,
  pending: readonly PendingView[],
  platform: NodeJS.Platform = process.platform,
): TicketView[] {
  const all = [...tickets]
  const rowsBySession = new Map<string, TaskRecord>()
  const rowsByTicket = new Map<string, TaskRecord[]>()
  for (const row of tasks) {
    rowsBySession.set(row.sessionId, row)
    if (row.ticketId) rowsByTicket.set(row.ticketId, [...rowsByTicket.get(row.ticketId) ?? [], row])
  }
  const waitingSessions = new Set(pending.map(item => item.sessionId))
  return all.map(ticket => {
    const rows = new Map<string, TaskRecord>()
    for (const row of rowsByTicket.get(ticket.id) ?? []) rows.set(row.sessionId, row)
    for (const session of ticket.sessions) {
      const row = rowsBySession.get(session.sessionId)
      if (row) rows.set(row.sessionId, row)
    }
    const sessionIds = new Set([...ticket.sessions.map(session => session.sessionId), ...rows.keys()])
    // The newest session is the one attached last; on equal timestamps the later-attached wins.
    const attached = [...ticket.sessions].map((session, index) => ({ session, index }))
      .sort((a, b) => b.session.at - a.session.at || b.index - a.index)
      .map(entry => rows.get(entry.session.sessionId))
      .find(row => row !== undefined)
    const latest = attached ?? [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const live = [...rows.values()].filter(row => row.status !== 'archived')
    const open = ticket.status === 'active' || ticket.status === 'review'
    const holder = ticket.status === 'todo' && ticket.access === 'write' ? lockHolders(all, ticket.dir, ticket.id, platform)[0] : undefined
    return {
      ...ticket,
      waiting: [...sessionIds].some(id => waitingSessions.has(id)),
      error: latest?.status === 'error',
      orphaned: open && live.length === 0,
      running: live.some(row => row.status === 'running'),
      ...holder ? { lockedBy: { id: holder.id, title: holder.title } } : {},
      ...latest?.lastNote ? { latestNote: latest.lastNote } : {},
      roundCount: ticket.rounds.length,
    }
  }).sort((a, b) => b.updatedAt - a.updatedAt)
}
