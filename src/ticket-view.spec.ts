import { describe, expect, it } from 'vitest'
import type { PendingView, TaskRecord, Ticket } from './contracts.ts'
import { deriveTicketViews } from './ticket-view.ts'

const ticket = (id: string, patch: Partial<Ticket> = {}): Ticket => ({
  id, title: `Task ${id}`, goal: 'goal', access: 'write', dir: '/work', status: 'active', priority: 2,
  sessions: [], rounds: [], history: [], createdAt: 1, updatedAt: 1, ...patch,
})
const row = (sessionId: string, ticketId: string | undefined, patch: Partial<TaskRecord> = {}): TaskRecord => ({
  sessionId, origin: 'started', title: sessionId, goal: 'goal', cwd: '/work', status: 'idle', createdAt: 1, updatedAt: 1, unseenTurns: 0,
  ...ticketId ? { ticketId } : {}, ...patch,
})
const request = (sessionId: string): PendingView => ({ id: 'ap-1', kind: 'approval', sessionId, createdAt: 1, subject: 'pwsh' })
const view = (rows: ReturnType<typeof deriveTicketViews>, id: string) => rows.find(item => item.id === id)!

describe('deriveTicketViews', () => {
  it('marks waiting, running and error from the sessions of a task', () => {
    const rows = deriveTicketViews(
      [ticket('t-1', { sessions: [{ sessionId: 'a', role: 'work', at: 1 }] }), ticket('t-2', { sessions: [{ sessionId: 'b', role: 'work', at: 1 }, { sessionId: 'c', role: 'rework', at: 2 }] })],
      [row('a', 't-1', { status: 'running', lastNote: 'building' }), row('b', 't-2', { status: 'idle' }), row('c', 't-2', { status: 'error', lastNote: 'crashed' })],
      [request('a')],
      'linux',
    )
    expect(view(rows, 't-1')).toMatchObject({ waiting: true, running: true, error: false, orphaned: false, latestNote: 'building' })
    expect(view(rows, 't-2')).toMatchObject({ waiting: false, running: false, error: true, latestNote: 'crashed' })
  })

  it('reports an active or review task without a live session as orphaned', () => {
    const rows = deriveTicketViews(
      [ticket('t-1'), ticket('t-2', { status: 'review', sessions: [{ sessionId: 'x', role: 'work', at: 1 }] }), ticket('t-3', { status: 'done' }), ticket('t-4', { sessions: [{ sessionId: 'y', role: 'work', at: 1 }] })],
      [row('x', 't-2', { status: 'archived' }), row('y', 't-4')],
      [],
      'linux',
    )
    expect(rows.filter(item => item.orphaned).map(item => item.id).sort()).toEqual(['t-1', 't-2'])
  })

  it('names the task that blocks a todo write task and ignores read tasks', () => {
    const rows = deriveTicketViews(
      [ticket('t-1', { title: 'Holder' }), ticket('t-2', { status: 'todo', dir: '/work/sub' }), ticket('t-3', { status: 'todo', access: 'read' })],
      [],
      [],
      'linux',
    )
    expect(view(rows, 't-2').lockedBy).toEqual({ id: 't-1', title: 'Holder' })
    expect(view(rows, 't-3').lockedBy).toBeUndefined()
    expect(view(rows, 't-1').lockedBy).toBeUndefined()
  })

  it('counts rounds, keeps rows without an attached session, and lists the freshest task first', () => {
    const rows = deriveTicketViews(
      [ticket('t-1', { updatedAt: 5, rounds: [{ n: 1, at: 1, role: 'work', summary: 's' }, { n: 2, at: 2, role: 'review', summary: 's', verdict: 'fail' }] }), ticket('t-2', { updatedAt: 9 })],
      [row('z', 't-1', { updatedAt: 3, lastNote: 'note' })],
      [],
      'linux',
    )
    expect(rows.map(item => item.id)).toEqual(['t-2', 't-1'])
    expect(view(rows, 't-1')).toMatchObject({ roundCount: 2, latestNote: 'note', orphaned: false })
  })

  it('with equal timestamps, the later-attached session wins over the earlier one', () => {
    // Hiro regression: old work session (error) and new rework session (idle) both at=10;
    // the rework was attached after (higher list index), so it must win.
    const rows = deriveTicketViews(
      [ticket('t-1', { sessions: [
        { sessionId: 'old', role: 'work', at: 10 },
        { sessionId: 'new', role: 'rework', at: 10 },
      ] })],
      [row('old', 't-1', { status: 'error', lastNote: 'old crash' }), row('new', 't-1', { status: 'idle', lastNote: 'reworking' })],
      [],
      'linux',
    )
    // 'new' is at index 1 (attached later) and must win over 'old' at index 0.
    expect(view(rows, 't-1')).toMatchObject({ error: false, latestNote: 'reworking' })
  })
})
