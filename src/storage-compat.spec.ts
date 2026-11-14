import { describe, expect, it } from 'vitest'
import { dotDomain, parseState, restoreTaskTimestamps } from './storage.ts'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { openCompatibleDomain } from '@klarkxy/dsh-plugin-kit/domain'
import { DotStore } from './store.ts'

// DotStore doubles do not validate records on open; exercise the real domain
// boundary too, since rejecting a v1 state here would prevent migration entirely.
describe('knowledge storage compatibility', () => {
  const legacy = {
    dotSessionId: 'dot-v1',
    dotWorkspaceId: 'workspace-v1',
    settings: {
      policy: '推送前问我',
      taskPermission: 'default',
      locks: { memory: true },
    },
    segment: {
      sessionId: 'dot-v1',
      startedAt: 100,
      persona: 'persona-v1',
      memory: '[your notes]\n- 普通开发任务用标准预设，不用破限',
      memorySeen: '[your notes]\n- updated',
    },
    memoryUndo: '- previous note\n',
    usageCarry: { input: 10, cacheRead: 20, cacheWrite: 0, output: 5 },
  }

  it('declares the previous domain version as readable', () => {
    expect(dotDomain.version).toBe(4)
    expect(dotDomain.compatibleVersions).toEqual([1, 2, 3])
  })

  it('admits untouched v1 records at the real domain validation boundary', () => {
    const decoded = dotDomain.tables.state.valueSchema.parse(legacy)
    expect(decoded).toMatchObject(legacy)
    expect(parseState(decoded)).toMatchObject(legacy)
  })

  it('round trips card state without overwriting existing settings or knowledge', () => {
    const value = { ...legacy, agreements: '- ask me', cognition: 'keep answers brief', cardSequence: 8, cards: [{
      id: 'dot-card-8', number: 8, sessionId: 'dot-v1', callId: 'c8', title: 'Choice',
      view: { type: 'confirm', id: 'confirm' }, expired: true,
    }], lastReplyAt: 250, lastConversationAt: 300 }
    const decoded = dotDomain.tables.state.valueSchema.parse(value)
    expect(parseState(decoded)).toMatchObject(value)
    expect(parseState(decoded).settings?.taskPermission).toBe('default')
  })

  it('round trips full approval details and pending notification status', () => {
    const detail = { requestId: 'ap-1', sessionId: 's1', callerSessionId: 'sub1', callId: 'call', toolName: 'pwsh', arguments: `${'x'.repeat(3000)} npm publish` }
    const value = { approvalDetails: [detail], cards: [{ id: 'card', number: 1, sessionId: 'dot', callId: 'c', title: 'Approval', view: { type: 'confirm', id: 'approval' }, expired: false, approvalId: 'ap-1', approvalDetail: detail, notificationPending: true }] }
    expect(parseState(dotDomain.tables.state.valueSchema.parse(value))).toMatchObject(value)
  })

  it('does not reject the settings row when a historical view is no longer supported', () => {
    const value = { ...legacy, cards: [{ id: 'old', number: 1, sessionId: 'dot-v1', callId: 'c', title: 'Old card', view: { type: 'retired-component' }, expired: true }] }
    const decoded = dotDomain.tables.state.valueSchema.parse(value)
    expect(parseState(decoded).settings?.taskPermission).toBe('default')
    expect(parseState(decoded).cards).toHaveLength(1)
  })

  it('keeps old rows readable under the new unit version without knowledge fields', () => {
    const decoded = dotDomain.tables.state.valueSchema.parse({
      ...legacy,
      pastSegments: [{ sessionId: 'older', startedAt: 0, endedAt: 100, reason: 'manual' }],
    })
    expect(decoded.settings).toMatchObject({ taskPermission: 'default' })
    expect(decoded.dotSessionId).toBe('dot-v1')
    expect(decoded.segment?.memory).toContain('普通开发任务用标准预设，不用破限')
    expect(parseState(decoded).pastSegments).toHaveLength(1)
  })

  it('restores the first ledger timestamps from its session without touching other rows', async () => {
    const legacyTask = {
      sessionId: 'old-task', origin: 'started', title: '旧任务', goal: '保留任务', cwd: '/work', status: 'idle', unseenTurns: 0,
    }
    const currentTask = { ...legacyTask, sessionId: 'current-task', createdAt: 10, updatedAt: 20 }
    const rows = new Map<string, unknown>([['old-task', legacyTask], ['current-task', currentTask]])
    const writes: string[] = []
    const domain = { table: () => ({ entries: () => rows.entries(), put: async (key: string, value: unknown) => { writes.push(key); rows.set(key, value) } }) }
    expect(() => dotDomain.tables.tasks.valueSchema.parse(legacyTask)).not.toThrow()
    await restoreTaskTimestamps(domain, async () => [100, 200])
    expect(rows.get('old-task')).toMatchObject({ ...legacyTask, createdAt: 100, updatedAt: 200 })
    expect(rows.get('current-task')).toEqual(currentTask)
    expect(writes).toEqual(['old-task'])
  })

  it('keeps an unrestored legacy row for a later retry without replacing it', async () => {
    const task = { sessionId: 'lost', origin: 'watched', title: '', goal: '', cwd: '/', status: 'idle', unseenTurns: 0 }
    const errors: string[] = []
    await restoreTaskTimestamps({ table: () => ({ entries: () => [['lost', task]][Symbol.iterator](), put: async () => { throw new Error('must not write') } }) }, async () => { throw new Error('session missing') }, message => errors.push(message))
    expect(errors).toHaveLength(1)
  })

  it('migrates real v3 started rows once while preserving watched rows across reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dot-v3-ticket-migration-'))
    const backend = new JsonStorageBackend(root)
    const facility = new DomainFacility({
      storage: { backend: { get: (name: string) => {
        if (name !== 'json') throw new Error('unexpected backend')
        return backend
      } } }, logger: { error() {}, warn() {} }, emit() {},
    } as never, { backend: 'json' })
    const started = { sessionId: 'started', origin: 'started', title: 'Build', goal: 'Deliver', cwd: '/work', workspaceId: 'workspace', status: 'idle', createdAt: 10, updatedAt: 20, unseenTurns: 1 }
    const watched = { sessionId: 'watched', origin: 'watched', title: 'Watch', goal: '', cwd: '/other', status: 'idle', createdAt: 11, updatedAt: 21, unseenTurns: 2 }
    const dir = join(root, dotDomain.name, 'tasks')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'started.json'), JSON.stringify({ version: 3, record: started }))
    await writeFile(join(dir, 'watched.json'), JSON.stringify({ version: 3, record: watched }))
    try {
      const domain = await openCompatibleDomain(spec => facility.open(spec), dotDomain)
      const store = new DotStore(domain)
      await store.migrateTickets()
      expect(store.listTickets()).toHaveLength(1)
      expect(store.listTickets()[0]).toMatchObject({ title: 'Build', goal: 'Deliver', dir: '/work', workspaceId: 'workspace', access: 'write', status: 'active', sessions: [{ sessionId: 'started', role: 'work', at: 10 }] })
      expect(store.task('started')).toMatchObject({ ticketId: store.listTickets()[0]!.id, role: 'work' })
      expect(store.task('watched')).toEqual(watched)
      const ticketId = store.listTickets()[0]!.id
      await domain.close()
      const reopened = await openCompatibleDomain(spec => facility.open(spec), dotDomain)
      const again = new DotStore(reopened)
      await again.migrateTickets()
      expect(again.listTickets()).toHaveLength(1)
      expect(again.listTickets()[0]!.id).toBe(ticketId)
      expect(again.task('watched')).toEqual(watched)
      expect(again.task('started')).toMatchObject({ ticketId, role: 'work' })
      await reopened.close()
      expect(JSON.parse(await readFile(join(dir, 'watched.json'), 'utf8'))).toEqual({ version: 3, record: watched })
    } finally {
      await facility.closeAll()
      await backend.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('opens a real stored ledger, repairs its legacy task, and reloads it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dot-legacy-ledger-'))
    const backend = new JsonStorageBackend(root)
    const facility = new DomainFacility({
      storage: { backend: { get: (name: string) => {
        if (name !== 'json') throw new Error('unexpected backend')
        return backend
      } } }, logger: { error() {}, warn() {} }, emit() {},
    } as never, { backend: 'json' })
    const task = {
      sessionId: 'old-task', origin: 'started', title: '旧任务', goal: '保留任务', cwd: '/work', status: 'idle', unseenTurns: 0,
    }
    const dir = join(root, dotDomain.name, 'tasks')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'old-task.json')
    await writeFile(file, JSON.stringify({ version: 3, record: task }))
    try {
      const domain = await openCompatibleDomain(spec => facility.open(spec), dotDomain)
      await restoreTaskTimestamps(domain, async () => [100, 200])
      new DotStore(domain)
      await domain.close()
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ record: { ...task, createdAt: 100, updatedAt: 200 } })
      const reopened = await openCompatibleDomain(spec => facility.open(spec), dotDomain)
      expect(new DotStore(reopened).task('old-task')).toMatchObject({ createdAt: 100, updatedAt: 200 })
      await reopened.close()
    } finally {
      await facility.closeAll()
      await backend.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
