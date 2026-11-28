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
  it('excludes changes whose session is retrying and re-includes once retry clears', () => {
    const changes = [
      change('retrying', { status: 'rework', sessionIds: ['s-retry'] }),
      change('idle-ready', { status: 'waiting', sessionIds: ['s-idle'] }),
    ]
    const tasks = [task('s-retry', 'idle'), task('s-idle', 'idle')]
    const retrying = new Set(['s-retry'])
    expect(idleCandidates(tasks, [], changes, retrying).map(row => row.id)).toEqual(['idle-ready'])
    expect(idleCandidates(tasks, [], changes, new Set()).map(row => row.id)).toEqual(['retrying', 'idle-ready'])
  })
  it('excludes changes whose session has an active quiet wait or running background job and re-includes once settled', () => {
    const changes = [
      change('quiet-wait', { status: 'rework', sessionIds: ['s-quiet'] }),
      change('idle-ready', { status: 'waiting', sessionIds: ['s-free'] }),
    ]
    const tasks = [task('s-quiet', 'idle'), task('s-free', 'idle')]
    const backgroundBusy = new Set(['s-quiet'])
    expect(idleCandidates(tasks, [], changes, undefined, backgroundBusy).map(row => row.id)).toEqual(['idle-ready'])
    expect(idleCandidates(tasks, [], changes, undefined, new Set()).map(row => row.id)).toEqual(['quiet-wait', 'idle-ready'])
  })
})
