/**
 * A watched session the human already archived in the host must leave the
 * active ledger. Archive is a host fact (archivedSessionIds / a missing row),
 * not a status Dorothy stores until something reads it.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DotHost, SessionRow } from './host.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'

function row(sessionId: string, archived: boolean): SessionRow {
  return { sessionId, running: false, updatedAt: 1, blank: false, subagent: false, archived }
}

function harness(sessions: SessionRow[] | (() => Promise<SessionRow[]>)) {
  const archived: string[] = []
  const host = {
    listWorkspaces: () => [],
    createWorkspace: async () => { throw new Error('unused') },
    listSessions: typeof sessions === 'function' ? sessions : async () => sessions,
    titles: async () => new Map<string, string>(),
    createSession: async () => { throw new Error('unused') },
    listPresets: async () => ({ presets: [] }),
    listModels: async () => ({ models: [] }),
    selectModel: async () => {},
    setPermission: async () => false,
    prompt: async () => {},
    relay: async () => {},
    cancel: async () => {},
    archive: async (sessionId: string) => { archived.push(sessionId) },
    latestReply: async () => 'still readable',
    cwdOf: async () => '/w',
    createDot: async () => 'dot',
    isRunning: () => false,
    readEvents: async () => [],
    dispose: async () => {},
  } as unknown as DotHost
  const replies = { n: 0 }
  const said: Array<string | undefined> = []
  ;(host as { latestReply: () => Promise<string> }).latestReply = async () => { replies.n += 1; return 'still readable' }
  ;(host as { modelKey: () => undefined; syncModel: () => void; say: (id: string, message: string, carried?: string) => Promise<void> }).modelKey = () => undefined
  ;(host as { syncModel: () => void }).syncModel = () => {}
  ;(host as { say: (id: string, message: string, carried?: string) => Promise<void> }).say = async (_id, _message, carried) => { said.push(carried) }
  const store = new DotStore(undefined)
  const service = new DotService({
    host,
    store,
    homeDir: join(tmpdir(), 'dsh-dot-watch-archive'),
    approvalGraceMs: 0,
    now: () => 1_000,
  })
  return { service, store, archived, replies, said }
}

describe('archived watched sessions leave the active ledger', () => {
  it('marks a watched session the host lists as archived, and leaves a live one idle', async () => {
    const { service, archived } = harness([row('session-a', true), row('session-live', false)])
    await service.watch('session-a', 'follow it')
    await service.watch('session-live', 'keep it')
    const text = await service.overview(new AbortController().signal)
    expect(text).not.toMatch(/IDLE session-a\b/)
    expect(text).toMatch(/IDLE session-live\b/)
    expect(service.board().tasks.find(task => task.sessionId === 'session-a')?.status).toBe('archived')
    expect(service.board().tasks.find(task => task.sessionId === 'session-live')?.status).toBe('idle')
    expect(archived).toEqual([])
  })

  it('marks a watched session the host list no longer contains, without touching a started task', async () => {
    const { service, store, archived } = harness([])
    await store.track({ sessionId: 'started-1', origin: 'started', title: 'job', goal: 'g', cwd: '/p', at: 1 })
    await service.watch('session-gone', 'follow it')
    const text = await service.overview(new AbortController().signal)
    expect(text).not.toMatch(/IDLE session-gone\b/)
    expect(store.task('session-gone')?.status).toBe('archived')
    expect(store.task('started-1')?.status).toBe('idle')
    expect(archived).toEqual([])
  })

  it('leaves the watch idle when the host list cannot be read', async () => {
    const { service, store } = harness(async () => { throw new Error('list down') })
    await service.watch('session-a', 'follow it')
    await service.syncWatched()
    expect(store.task('session-a')?.status).toBe('idle')
    await expect(service.overview(new AbortController().signal)).rejects.toThrow(/list down/)
    expect(store.task('session-a')?.status).toBe('idle')
  })

  it('marks the watch archived when the host reports the archive, without archiving again', async () => {
    const { service, store, archived } = harness([row('session-a', false)])
    await service.watch('session-a', 'follow it')
    await service.noteSessionArchived('session-a')
    expect(store.task('session-a')?.status).toBe('archived')
    await service.noteSessionArchived('session-a')
    await service.noteSessionArchived('unknown')
    expect(archived).toEqual([])
  })

  it('drops a watch when the host removes the session and the list no longer has it', async () => {
    let present = true
    const { service, store, archived } = harness(async () => present ? [row('session-a', false)] : [])
    await service.watch('session-a', 'follow it')
    await service.noteSessionRemoved('session-a')
    expect(store.task('session-a')?.status).toBe('idle')
    present = false
    await service.noteSessionRemoved('session-a')
    expect(store.task('session-a')?.status).toBe('archived')
    expect(archived).toEqual([])
  })

  it('dot_read reports ARCHIVED after the host archived the session and still does not archive it', async () => {
    const { service, archived } = harness([row('session-a', true)])
    await service.watch('session-a', 'follow it')
    const text = await service.read('session-a')
    expect(text.startsWith('ARCHIVED ')).toBe(true)
    expect(text).toContain('still readable')
    expect(archived).toEqual([])
  })

  it('unwatch removes only that watch and does not archive the host session', async () => {
    const { service, store, archived } = harness([row('session-a', false), row('session-b', false)])
    await service.watch('session-a', 'follow')
    await service.watch('session-b', 'keep')
    await store.track({ sessionId: 'started-1', origin: 'started', title: 'job', goal: 'g', cwd: '/p', at: 1 })
    expect(await service.unwatch('missing')).toBe(false)
    expect(await service.unwatch('started-1')).toBe(false)
    expect(await service.unwatch('session-a')).toBe(true)
    expect(store.task('session-a')).toBeUndefined()
    expect(store.task('started-1')?.status).toBe('idle')
    const text = await service.overview(new AbortController().signal)
    expect(text).not.toMatch(/IDLE session-a\b/)
    expect(text).toContain('- session-a idle')
    expect(text).toMatch(/IDLE session-b\b/)
    expect(service.board().tasks.map(task => task.sessionId)).toEqual(['session-b'])
    expect(archived).toEqual([])
  })

  it('does not notify or relay a watch after it is archived', async () => {
    const { service, store, archived, replies } = harness([row('session-a', false)])
    await service.watch('session-a', 'follow it')
    await service.noteSessionArchived('session-a')
    replies.n = 0
    await service.onTurnEnd('session-a')
    service.onError('session-a', new Error('boom'))
    expect(replies.n).toBe(0)
    expect(store.task('session-a')?.status).toBe('archived')
    await store.beginSegment({ sessionId: 'dot', startedAt: 1, persona: 'p' })
    expect(service.relayRequest({ kind: 'approval', sessionId: 'session-a', subject: 'bash' })).toEqual({ decided: 'skip' })
    expect(archived).toEqual([])
  })

  it('drops a held turn-end when the watch is removed', async () => {
    const { service, said } = harness([row('session-a', false)])
    await service.watch('session-a', 'follow it')
    await service.onTurnEnd('session-a')
    expect(await service.unwatch('session-a')).toBe(true)
    await service.say('hello')
    expect(said).toEqual([undefined])
  })

  it('does not archive a watch created while the host list is in flight, and shares that list', async () => {
    let release: (rows: SessionRow[]) => void = () => {}
    const pending = new Promise<SessionRow[]>(resolve => { release = resolve })
    let calls = 0
    const { service, store } = harness(async () => {
      calls += 1
      return calls === 1 ? pending : [row('session-old', false), row('session-new', false)]
    })
    await service.watch('session-old', 'old')
    const first = service.syncWatched()
    const second = service.syncWatched()
    await Promise.resolve()
    await service.watch('session-new', 'new')
    release([])
    await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(store.task('session-old')?.status).toBe('archived')
    expect(store.task('session-new')?.status).toBe('idle')
    expect(store.task('session-new')?.origin).toBe('watched')
  })
})
