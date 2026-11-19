import { describe, expect, it } from 'vitest'
import { groupBoard, headerBoardCounts, sessionLookup } from './board-groups.ts'
import type { BoardView, TaskRecord } from './contracts.ts'
import type { WorkBoardItem } from './work-board.ts'

const watched = (sessionId: string, status: TaskRecord['status'] = 'idle'): TaskRecord => ({
  sessionId, origin: 'watched', title: sessionId, goal: '', cwd: '/w', status, createdAt: 1, updatedAt: 1, unseenTurns: 0,
})
const started = (sessionId: string): TaskRecord => ({
  sessionId, origin: 'started', title: `task of ${sessionId}`, goal: '', cwd: '/p', status: 'idle', createdAt: 1, updatedAt: 1, unseenTurns: 0,
})
const board = (patch: Partial<BoardView>): BoardView => ({ tasks: [], pending: [], schedules: [], ...patch })

describe('groupBoard', () => {
  it('keeps watched sessions live, counts the archived ones separately, and lists requests', () => {
    const groups = groupBoard(board({
      pending: [{ id: 'ap-1', kind: 'approval', sessionId: 's', createdAt: 1, subject: 'pwsh' }],
      tasks: [watched('w-1'), watched('w-2', 'archived')],
    }))
    expect(groups.requests).toHaveLength(1)
    expect(groups.watched.map(row => row.sessionId)).toEqual(['w-1'])
    expect(groups.watchedArchived).toBe(1)
    expect(groups.liveCount).toBe(1)
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
  it('names watched and started sessions by their task and keeps them all', () => {
    const lookup = sessionLookup(board({
      startedTasks: [started('a'), started('b')],
      tasks: [watched('w')],
    }))
    expect(lookup.get('a')).toEqual({ title: 'task of a', cwd: '/p' })
    expect(lookup.get('b')).toEqual({ title: 'task of b', cwd: '/p' })
    expect(lookup.get('w')).toEqual({ title: 'w', cwd: '/w' })
    expect(sessionLookup(undefined).size).toBe(0)
  })
})
