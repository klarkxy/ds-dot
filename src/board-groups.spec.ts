import { describe, expect, it } from 'vitest'
import { groupBoard, headerBoardCounts, sessionLookup } from './board-groups.ts'
import type { BoardView, TaskRecord, TicketStatus, TicketView } from './contracts.ts'
import type { WorkBoardItem } from './work-board.ts'

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
  it('keeps legacy tickets as newest-first history and never counts them as waiting or live', () => {
    const groups = groupBoard(board({
      pending: [{ id: 'ap-1', kind: 'approval', sessionId: 's', createdAt: 1, subject: 'pwsh' }],
      tickets: [
        ticket('t-1', 'review', { humanReview: true, updatedAt: 3 }),
        ticket('t-2', 'draft', { updatedAt: 1 }),
        ticket('t-3', 'active', { updatedAt: 9 }),
        ticket('t-4', 'done', { updatedAt: 5 }),
      ],
      tasks: [watched('w-1'), watched('w-2', 'archived')],
    }))
    expect(groups.legacy.map(row => row.id)).toEqual(['t-3', 't-4', 't-1', 't-2'])
    expect(groups.requests).toHaveLength(1)
    expect(groups.watched.map(row => row.sessionId)).toEqual(['w-1'])
    expect(groups.watchedArchived).toBe(1)
    expect(groups.liveCount).toBe(1)
    expect(headerBoardCounts(board({ tickets: [ticket('t-1', 'review', { humanReview: true }), ticket('t-2', 'draft')] }))).toEqual({ liveCount: 0, waitingCount: 0 })
  })
})

const workItem = (patch: Partial<WorkBoardItem> = {}): WorkBoardItem => ({
  id: 'c-1', title: 'Ship', priority: 2, revision: 2, inputRef: 'in-2', control: 'open', status: 'waiting',
  runs: [], blockers: [],
  verification: { id: 'v-2', verdict: 'accept', subjectKey: 'key-2', inputRef: 'in-2', inputRevision: 2 },
  humanAction: { action: 'accept', expectedInputRef: 'in-2', expectedInputRevision: 2, expectedVerificationId: 'v-2', expectedSubjectKey: 'key-2' },
  ...patch,
})
const lookPending = (revision = 2) => ({
  id: `look-${revision}`, kind: 'approval' as const, sessionId: 'dot', createdAt: 1, subject: 'Look at c-1',
  detail: JSON.stringify({ changeId: 'c-1', inputRevision: revision, verificationId: `v-${revision}`, subjectKey: `key-${revision}` }),
})

describe('headerBoardCounts', () => {
  it('counts a current look once and ignores an older pending look without dropping ordinary approvals', () => {
    const item = workItem({ humanAction: undefined, oversight: { requested: true, inputRef: 'in-2', inputRevision: 2 } })
    const view = board({ work: [item], pending: [lookPending(1), lookPending(), { id: 'ordinary', kind: 'approval', sessionId: 's', createdAt: 1, subject: 'shell' }] })
    expect(headerBoardCounts(view)).toEqual({ liveCount: 1, waitingCount: 2 })
    expect(view.pending).toHaveLength(3)
  })

  it('does not count stale, withdrawn or orphaned look requests as work for the user', () => {
    const item = workItem({ humanAction: undefined, oversight: { requested: true, inputRef: 'in-2', inputRevision: 2 } })
    expect(headerBoardCounts(board({ work: [item], pending: [lookPending(1)] })).waitingCount).toBe(0)
    expect(headerBoardCounts(board({ work: [item], pending: [] })).waitingCount).toBe(0)
    expect(headerBoardCounts(board({ work: [], pending: [lookPending()] })).waitingCount).toBe(0)
    expect(headerBoardCounts(board({ work: [workItem({ status: 'done' })], pending: [lookPending()] })).waitingCount).toBe(0)
  })

  it('counts an independent current action even when an older oversight request remains', () => {
    const item = workItem({ oversight: { requested: true, inputRef: 'in-1', inputRevision: 1 } })
    expect(headerBoardCounts(board({ work: [item], pending: [lookPending(1)] })).waitingCount).toBe(1)
    expect(headerBoardCounts(board({ work: [item], pending: [] })).waitingCount).toBe(1)
  })

  it('does not count a stale accept action or a verification belonging to the previous input', () => {
    const current = workItem()
    const staleAction = workItem({ humanAction: { ...current.humanAction!, expectedInputRef: 'in-1', expectedInputRevision: 1 } })
    expect(headerBoardCounts(board({ work: [staleAction] })).waitingCount).toBe(0)
    const staleVerification = workItem({ verification: { ...current.verification!, inputRef: 'in-1', inputRevision: 1 } })
    expect(headerBoardCounts(board({ work: [staleVerification] })).waitingCount).toBe(0)
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
