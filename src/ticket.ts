import type { Ticket, TicketRound, TicketStatus } from './contracts.ts'
import { clip } from './ledger.ts'
import { lockHolders } from './lock.ts'

export const TICKET_STATUSES: readonly TicketStatus[] = ['draft', 'todo', 'active', 'review', 'done', 'cancelled']

export function moveTicket(ticket: Ticket, to: TicketStatus, by: 'dot' | 'human', reason: string, at: number, tickets: Iterable<Ticket> = []): Ticket {
  if (!TICKET_STATUSES.includes(to)) throw new Error(`Invalid ticket status: ${to}`)
  if (to === 'draft' && ticket.status !== 'draft') throw new Error('Cannot move a ticket back to draft')
  const text = clip(reason, 600)
  if (!text) throw new Error('A reason is required')
  if (ticket.access === 'write' && (to === 'active' || to === 'review')) {
    const holders = lockHolders(tickets, ticket.dir, ticket.id)
    if (holders.length) throw new Error(`Directory is held by ${holders.map(row => `${row.id} "${row.title}" (${row.status})`).join(', ')}`)
  }
  return { ...ticket, status: to, updatedAt: at, history: [...ticket.history, { at, from: ticket.status, to, by, reason: text }].slice(-50) }
}

export function appendTicketRound(ticket: Ticket, round: TicketRound): Ticket {
  return { ...ticket, updatedAt: round.at, rounds: [...ticket.rounds, { ...round, summary: clip(round.summary, 600) }].slice(-20) }
}
