import { describe, expect, it } from 'vitest'
import type { Ticket } from './contracts.ts'
import { appendTicketRound, moveTicket } from './ticket.ts'

const ticket: Ticket = { id: 't-1', title: 'one', goal: 'g', dir: '/work', access: 'write', status: 'todo', priority: 2, sessions: [], rounds: [], history: [], createdAt: 1, updatedAt: 1 }

describe('ticket transitions', () => {
  it('requires a reason, validates statuses and disallows returning to draft', () => {
    expect(() => moveTicket(ticket, 'active', 'dot', ' ', 2)).toThrow()
    expect(() => moveTicket(ticket, 'bad' as never, 'dot', 'reason', 2)).toThrow()
    expect(() => moveTicket(ticket, 'draft', 'human', 'reason', 2)).toThrow()
    expect(moveTicket(ticket, 'done', 'human', 'accepted', 2).history[0]).toMatchObject({ from: 'todo', to: 'done', by: 'human' })
  })
  it('checks write locks and permits read tasks', () => {
    const holder = { ...ticket, id: 't-2', status: 'active' as const, dir: '/work/child' }
    expect(() => moveTicket(ticket, 'review', 'dot', 'review', 2, [holder])).toThrow('t-2')
    expect(moveTicket({ ...ticket, access: 'read' }, 'active', 'dot', 'read', 2, [holder]).status).toBe('active')
  })
  it('caps reason, history, rounds and summaries', () => {
    let next = ticket
    for (let i = 0; i < 55; i++) next = moveTicket(next, 'done', 'dot', 'x'.repeat(700), i)
    for (let i = 0; i < 25; i++) next = appendTicketRound(next, { n: i, at: i, role: 'work', summary: 'y'.repeat(700) })
    expect(next.history).toHaveLength(50)
    expect(next.history[0]!.reason).toHaveLength(600)
    expect(next.rounds).toHaveLength(20)
    expect(next.rounds[0]!.summary).toHaveLength(600)
  })
})
