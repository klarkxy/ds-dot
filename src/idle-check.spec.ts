import { describe, expect, it } from 'vitest'
import type { Ticket, TaskRecord, PendingView } from './contracts.ts'
import { idleCandidates, IdleChecker } from './idle-check.ts'
import type { Timer } from './batcher.ts'

const ticket = (id: string, status: Ticket['status'], access: Ticket['access'] = 'read'): Ticket => ({ id, title: id, goal: 'g', dir: `/work/${id}`, access, status, priority: 2, sessions: [{ sessionId: id, role: 'work', at: 1 }], rounds: [], history: [], createdAt: 1, updatedAt: 1 })
const task = (id: string, status: TaskRecord['status']): TaskRecord => ({ sessionId: id, origin: 'started', title: id, goal: 'g', cwd: '/', status, createdAt: 1, updatedAt: 1, unseenTurns: 0 })

describe('idle checks', () => {
  it('selects todo, idle active and idle review but excludes running, waiting and human review', () => {
    const tickets = [ticket('todo', 'todo'), ticket('active', 'active'), ticket('review', 'review'), ticket('run', 'active'), ticket('wait', 'review'), { ...ticket('human', 'review'), humanReview: true }]
    const tasks = tickets.map(row => task(row.id, row.id === 'run' ? 'running' : 'idle'))
    const pending: PendingView[] = [{ id: 'ap-1', kind: 'approval', sessionId: 'wait', createdAt: 1, subject: 's' }]
    expect(idleCandidates(tickets, tasks, pending).map(row => row.ticket.id)).toEqual(['todo', 'active', 'review'])
  })
  it('excludes locked todo write tasks and allows read tasks', () => {
    const holder = { ...ticket('holder', 'active', 'write'), dir: '/work' }
    const write = { ...ticket('write', 'todo', 'write'), dir: '/work/sub' }
    const read = { ...ticket('read', 'todo', 'read'), dir: '/work/sub' }
    expect(idleCandidates([holder, write, read], [task('holder', 'running')], []).map(row => row.ticket.id)).toEqual(['read'])
  })
  it('deduplicates unchanged fingerprints and disables timer at zero', () => {
    let callback: (() => void) | undefined
    const timer: Timer = { now: () => 0, set: fn => { callback = fn; return 1 }, clear: () => { callback = undefined } }
    let calls = 0
    const c = new IdleChecker(() => idleCandidates([ticket('a', 'todo')], [], []), () => { calls++ }, timer)
    c.arm(0); expect(callback).toBeUndefined()
    c.arm(1); callback!(); c.run(); expect(calls).toBe(1)
  })
})
