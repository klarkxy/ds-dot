import { describe, expect, it } from 'vitest'
import type { TaskRecord, PendingView } from './contracts.ts'
import { idleCandidates, IdleChecker, type WorkIdleItem } from './idle-check.ts'
import type { Timer } from './batcher.ts'

const change = (id: string, patch: Partial<WorkIdleItem> = {}): WorkIdleItem => ({
  id, title: id, cwd: `/work/${id}`, priority: 2, control: 'open', status: 'waiting', sessionIds: [], ...patch,
})
const task = (id: string, status: TaskRecord['status']): TaskRecord => ({ sessionId: id, origin: 'started', title: id, goal: 'g', cwd: '/', status, createdAt: 1, updatedAt: 1, unseenTurns: 0 })

describe('idle checks', () => {
  it('selects waiting, rework and verified changes but excludes running, waiting-human, oversight and closed', () => {
    const changes = [
      change('todo'),
      change('active', { status: 'rework' }),
      change('review', { readyToAccept: true }),
      change('run', { sessionIds: ['run'] }),
      change('wait', { sessionIds: ['wait'] }),
      change('human', { awaitingHumanOversight: true }),
      change('done', { status: 'done' }),
      change('closed', { control: 'cancelled' }),
    ]
    const tasks = [task('run', 'running'), task('wait', 'idle')]
    const pending: PendingView[] = [{ id: 'ap-1', kind: 'approval', sessionId: 'wait', createdAt: 1, subject: 's' }]
    expect(idleCandidates(tasks, pending, changes).map(row => row.id)).toEqual(['todo', 'active', 'review'])
  })
  it('excludes a change whose session has a pending request or a running session', () => {
    const changes = [change('busy', { sessionIds: ['busy'] }), change('held', { sessionIds: ['held'] }), change('free')]
    const tasks = [task('busy', 'running'), task('held', 'idle')]
    const pending: PendingView[] = [{ id: 'ap-1', kind: 'approval', sessionId: 'held', createdAt: 1, subject: 's' }]
    expect(idleCandidates(tasks, pending, changes).map(row => row.id)).toEqual(['free'])
  })
  it('deduplicates unchanged fingerprints and disables timer at zero', () => {
    let callback: (() => void) | undefined
    const timer: Timer = { now: () => 0, set: fn => { callback = fn; return 1 }, clear: () => { callback = undefined } }
    let calls = 0
    const c = new IdleChecker(() => idleCandidates([], [], [change('a')]), () => { calls++ }, timer)
    c.arm(0); expect(callback).toBeUndefined()
    c.arm(1); callback!(); c.run(); expect(calls).toBe(1)
  })
})
