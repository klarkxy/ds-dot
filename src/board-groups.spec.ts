import { describe, expect, it } from 'vitest'
import { groupBoard, sessionLookup } from './board-groups.ts'
import type { BoardView, TaskRecord, TicketStatus, TicketView } from './contracts.ts'

const ticket = (id: string, status: TicketStatus, patch: Partial<TicketView> = {}): TicketView => ({
  id, title: `Task ${id}`, goal: 'goal', access: 'write', dir: `/work/${id}`, status, priority: 2,
  sessions: [], rounds: [], history: [], createdAt: 1, updatedAt: 1,
  waiting: false, error: false, orphaned: false, running: false, roundCount: 0, ...patch,
})
const watched = (sessionId: string, status: TaskRecord['status'] = 'idle'): TaskRecord => ({
  sessionId, origin: 'watched', title: sessionId, goal: '', cwd: '/w', status, createdAt: 1, updatedAt: 1, unseenTurns: 0,
})
const board = (patch: Partial<BoardView>): BoardView => ({ tasks: [], tickets: [], pending: [], schedules: [], ...patch })

describe('groupBoard', () => {
  it('splits tasks into the groups of the board and counts the first one for the badge', () => {
    const groups = groupBoard(board({
      pending: [{ id: 'ap-1', kind: 'approval', sessionId: 's', createdAt: 1, subject: 'pwsh' }],
      tickets: [
        ticket('t-1', 'review', { humanReview: true }),
        ticket('t-2', 'review'),
        ticket('t-3', 'draft'),
        ticket('t-4', 'active'),
        ticket('t-5', 'todo'),
        ticket('t-6', 'done'),
        ticket('t-7', 'cancelled'),
      ],
      tasks: [watched('w-1'), watched('w-2', 'archived')],
    }))
    expect(groups.review.map(row => row.id)).toEqual(['t-1'])
    expect(groups.drafts.map(row => row.id)).toEqual(['t-3'])
    expect(groups.active.map(row => row.id).sort()).toEqual(['t-2', 't-4'])
    expect(groups.todo.map(row => row.id)).toEqual(['t-5'])
    expect(groups.finished.map(row => row.id).sort()).toEqual(['t-6', 't-7'])
    expect(groups.watched.map(row => row.sessionId)).toEqual(['w-1'])
    expect(groups.watchedArchived).toBe(1)
    expect(groups.waitingCount).toBe(3)
    expect(groups.liveCount).toBe(6)
  })

  it('puts higher priority first, then the freshest; the queue keeps its creation order within a priority', () => {
    const groups = groupBoard(board({ tickets: [
      ticket('t-1', 'active', { priority: 2, updatedAt: 9 }),
      ticket('t-2', 'active', { priority: 3, updatedAt: 1 }),
      ticket('t-3', 'active', { priority: 2, updatedAt: 5 }),
      ticket('t-4', 'todo', { priority: 2, createdAt: 8 }),
      ticket('t-5', 'todo', { priority: 2, createdAt: 3 }),
      ticket('t-6', 'todo', { priority: 3, createdAt: 9 }),
    ] }))
    expect(groups.active.map(row => row.id)).toEqual(['t-2', 't-1', 't-3'])
    expect(groups.todo.map(row => row.id)).toEqual(['t-6', 't-5', 't-4'])
  })
})

describe('sessionLookup', () => {
  it('names the sessions of tasks by their task and keeps watched sessions', () => {
    const lookup = sessionLookup(board({
      tickets: [ticket('t-1', 'active', { title: 'Ship', dir: '/proj', sessions: [{ sessionId: 'a', role: 'work', at: 1 }, { sessionId: 'b', role: 'rework', at: 2 }] })],
      tasks: [watched('w')],
    }))
    expect(lookup.get('a')).toEqual({ title: 'Ship', cwd: '/proj' })
    expect(lookup.get('b')).toEqual({ title: 'Ship', cwd: '/proj' })
    expect(lookup.get('w')).toEqual({ title: 'w', cwd: '/w' })
    expect(sessionLookup(undefined).size).toBe(0)
  })
})
