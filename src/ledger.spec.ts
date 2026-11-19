import { describe, expect, it } from 'vitest'
import { applyEvent, createTask, formatAge, ledgerSummary, sortTasks, withPending, type WorkLedgerItem } from './ledger.ts'
import type { PendingView } from './contracts.ts'

const task = (id = 's1', at = 0) => createTask({ sessionId: id, origin: 'started', title: 'Fix login', goal: 'make login work', cwd: '/w', at })

describe('ledger', () => {
  it('ignores events for other sessions', () => {
    expect(applyEvent(task(), { type: 'status', sessionId: 'other', status: 'running', at: 1 }, false)).toBeUndefined()
  })

  it('tracks running → turn end with an unread counter and note', () => {
    let t = applyEvent(task(), { type: 'status', sessionId: 's1', status: 'running', at: 1 }, false)!
    expect(t.status).toBe('running')
    t = applyEvent(t, { type: 'turn-end', sessionId: 's1', at: 2, note: 'done   with\nstep 1' }, false)!
    expect(t).toMatchObject({ status: 'idle', unseenTurns: 1, lastNote: 'done with step 1', updatedAt: 2 })
  })

  it('keeps an error visible across an idle flip, clears it on the next run', () => {
    let t = applyEvent(task(), { type: 'error', sessionId: 's1', at: 1, message: 'boom' }, false)!
    t = applyEvent(t, { type: 'status', sessionId: 's1', status: 'idle', at: 2 }, false)!
    expect(t.status).toBe('error')
    t = applyEvent(t, { type: 'status', sessionId: 's1', status: 'running', at: 3 }, false)!
    expect(t.status).toBe('running')
  })

  it('stays blocked while a request waits and releases when it clears', () => {
    const pending: PendingView[] = [{ id: 'ap-1', kind: 'approval', sessionId: 's1', createdAt: 0, subject: 'bash' }]
    let t = withPending(task(), pending)
    expect(t.status).toBe('blocked')
    t = applyEvent(t, { type: 'status', sessionId: 's1', status: 'running', at: 1 }, true)!
    expect(t.status).toBe('blocked')
    expect(withPending(t, []).status).toBe('running')
  })

  it('freezes archived tasks except for titles', () => {
    let t = applyEvent(task(), { type: 'archived', sessionId: 's1', at: 1 }, false)!
    expect(applyEvent(t, { type: 'status', sessionId: 's1', status: 'running', at: 2 }, false)!.status).toBe('archived')
    t = applyEvent(t, { type: 'title', sessionId: 's1', at: 3, title: 'Renamed' }, false)!
    expect(t.title).toBe('Renamed')
  })

  it('sorts blocked and errored tasks first, then by recency', () => {
    const a = { ...task('a', 1), status: 'idle' as const }
    const b = { ...task('b', 5), status: 'idle' as const, updatedAt: 5 }
    const c = { ...task('c', 0), status: 'blocked' as const }
    expect(sortTasks([a, b, c]).map(t => t.sessionId)).toEqual(['c', 'b', 'a'])
  })

  it('summarises live tasks and waiting requests', () => {
    const tasks = [{ ...task('a', 0), unseenTurns: 2, lastNote: 'tests pass' }, { ...task('z', 0), status: 'archived' as const }]
    const text = ledgerSummary(tasks, [{ id: 'q-1', kind: 'question', sessionId: 'a', createdAt: 0, subject: 'Which DB?' }], 120_000)
    expect(text).toContain('IDLE a "Fix login" (started, 2m ago) · 2 unread turn(s) · tests pass')
    expect(text).toContain('(1 archived task(s) hidden)')
    expect(text).toContain('q-1 question from a: Which DB?')
  })

  it('sorts urgent and higher-priority changes first and shows each waiting request on its change', () => {
    const base: WorkLedgerItem = { id: 'c-1', title: 'old error', cwd: '/a', status: 'active', control: 'open', priority: 1, revision: 1, sessionIds: ['old', 'new'], blockers: [], activeRuns: 0 }
    const high: WorkLedgerItem = { ...base, id: 'c-2', title: 'high', cwd: '/b', priority: 3, sessionIds: ['high'] }
    const plain = ledgerSummary([], [], 0, [base, high])
    expect(plain.indexOf('c-2 ACTIVE')).toBeLessThan(plain.indexOf('c-1 ACTIVE'))
    const withWaiting = ledgerSummary([], [{ id: 'ap-4', kind: 'approval', sessionId: 'old', subject: 'write', createdAt: 0 }], 0, [base, high])
    expect(withWaiting.indexOf('c-1 ACTIVE')).toBeLessThan(withWaiting.indexOf('c-2 ACTIVE'))
    expect(withWaiting.split('LINEJOIN').find(line => line.includes('c-1 ACTIVE'))).toContain('WAITING ap-4')
    const rework = ledgerSummary([], [], 0, [{ ...base, status: 'rework' }, high])
    expect(rework.indexOf('c-1 REWORK')).toBeLessThan(rework.indexOf('c-2 ACTIVE'))
  })

  it('formats ages', () => {
    expect([formatAge(5_000), formatAge(600_000), formatAge(7_200_000), formatAge(3 * 86_400_000)]).toEqual(['5s', '10m', '2h', '3d'])
  })
})
