/**
 * A live agent that is still running must stay occupied when the last state
 * read fails. That failure is not the same as never finding the agent.
 */
import { describe, expect, it } from 'vitest'
import { bindRunSession, finishWork, launchReservedRun } from './execution.ts'
import { bindHost } from './host.ts'
import { WorkBook } from './work.ts'

async function active() {
  const book = new WorkBook(async () => undefined, 'win32')
  const change = await book.createChange({ title: 'audit', cwd: 'H:\\audit-project', goal: 'check stop', at: 1 })
  const reserved = await book.reserveRun({ changeId: change.id, cwd: change.cwd, root: { workspaceRoot: change.cwd }, writeScope: { kind: 'paths', paths: [] }, at: 2 })
  if (!reserved.ok) throw new Error(reserved.message)
  const started = await launchReservedRun(book, {
    async findSession() { return { cwd: change.cwd, preset: 'standard' } },
    async createSession(input) { return { sessionId: input.sessionId, cwd: input.cwd } },
    async prepareAccess() { return 'ok' },
    async prompt() { return 'accepted' },
    async promptReceipts() { return 0 },
    async relay() { return 'accepted' },
    async relayInserts() { return 0 },
    async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
  }, reserved.run.id, 'go')
  if (!started.ok) throw new Error(started.message)
  return { book, run: reserved.run }
}

describe('an archive label does not prove a live agent stopped', () => {
  it('keeps the known live busy agent occupied if the last state read fails', async () => {
    const { book, run } = await active()
    const agent = { status: 'idle' as 'idle' | 'running', session: { id: run.requestedSessionId }, cancel() {}, whenIdle: () => new Promise<void>(() => undefined) }
    const host = bindHost(name => {
      if (name === 'agents') return { get: () => agent }
      if (name === 'workspaceRegistry') return { archivedSessionIds: [run.requestedSessionId] }
      if (name === 'jobs') return { list: () => [] }
      if (name === 'sessionQuery') return { readSession: async () => ({ events: [] }) }
      if (name === 'sessionController') return {
        cancel: async () => ({ accepted: true }),
        state: async () => { agent.status = 'running'; throw new Error('latest state unavailable') },
      }
      return undefined
    })
    const report = await host.stopActivity!(run.requestedSessionId)
    expect(agent.status).toBe('running')
    expect(report.idle).toBe(false)
    agent.status = 'idle'
    const result = await finishWork(book, bindRunSession({
      ...host,
      async findSession() { return { cwd: 'H:\\audit-project', preset: 'standard' } },
    }), run.id, 'completed', 3)
    expect(result.ok).toBe(false)
    expect(book.run(run.id)?.phase).toBe('settling')
    expect(book.occupying().map(item => item.id)).toEqual([run.id])
  }, 10_000)

  it('does not equate a synchronous whenIdle error with an absent agent', async () => {
    const id = 'session-running'
    const agent = {
      status: 'running' as const,
      session: { id },
      cancel() {},
      whenIdle() { throw new Error('idle accessor failed') },
    }
    const host = bindHost(name => {
      if (name === 'agents') return { get: () => agent }
      if (name === 'workspaceRegistry') return { archivedSessionIds: [id] }
      if (name === 'jobs') return { list: () => [] }
      if (name === 'sessionQuery') return { readSession: async () => ({ events: [] }) }
      if (name === 'sessionController') return {
        cancel: async () => ({ accepted: true }),
        state: async () => ({ queue: [], running: false }),
      }
      return undefined
    })
    const report = await host.stopActivity!(id)
    expect(agent.status).toBe('running')
    expect(report).toMatchObject({ idle: false, queueCleared: true, jobsSettled: true })
  })
})
