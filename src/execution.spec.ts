import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bindRunSession, cancelWork, countPromptReceipts, countRelayInserts, finishWork, launchReservedRun, observeRun, reconcileReserved, reconcileRun, supplementRun, type RunSessionHost } from './execution.ts'
import { WorkBook, onDiskPath, type WorkPersist } from './work.ts'

function openBook(): WorkBook {
  const persist: WorkPersist = async () => undefined
  return new WorkBook(persist, 'win32')
}

const readScope = { kind: 'paths' as const, paths: [] }
const writeScope = { kind: 'paths' as const, paths: [{ path: 'H:\\repo\\a.ts', type: 'file' as const }] }

async function reserved(book: WorkBook, scope: typeof readScope | typeof writeScope = readScope) {
  const change = await book.createChange({ title: 'Ship', cwd: 'H:\\repo', goal: 'land it', at: 1 })
  const held = await book.reserveRun({ changeId: change.id, cwd: 'H:\\repo', root: { workspaceRoot: 'H:\\repo' }, writeScope: scope, at: 2 })
  if (!held.ok) throw new Error(held.message)
  return held
}

function hostOf(partial: Partial<RunSessionHost> & Pick<RunSessionHost, 'findSession'>): { host: RunSessionHost; calls: string[] } {
  const calls: string[] = []
  const host: RunSessionHost = {
    findSession: partial.findSession,
    async createSession(input) {
      calls.push(`create ${input.sessionId}`)
      if (partial.createSession) return partial.createSession(input)
      return { sessionId: input.sessionId, cwd: input.cwd, ...(input.preset ? { preset: input.preset } : {}) }
    },
    async prepareAccess(sessionId, access) {
      calls.push(`access ${sessionId} ${access}`)
      if (partial.prepareAccess) return partial.prepareAccess(sessionId, access)
      return 'ok'
    },
    async prompt(sessionId, text, requestId) {
      calls.push(`prompt ${sessionId} ${requestId} ${text}`)
      if (partial.prompt) return partial.prompt(sessionId, text, requestId)
      return 'accepted'
    },
    async promptReceipts(sessionId, requestId, text) {
      if (partial.promptReceipts) return partial.promptReceipts(sessionId, requestId, text)
      return 0
    },
    async relay(sessionId, senderId, text, deliveryId) {
      calls.push(`relay ${sessionId} ${senderId} ${deliveryId} ${text}`)
      if (partial.relay) return partial.relay(sessionId, senderId, text, deliveryId)
      return 'accepted'
    },
    async relayInserts(sessionId, deliveryId, senderId, text) {
      if (partial.relayInserts) return partial.relayInserts(sessionId, deliveryId, senderId, text)
      return 0
    },
    async stop(sessionId) {
      calls.push(`stop ${sessionId}`)
      if (partial.stop) return partial.stop(sessionId)
      return { cancelAccepted: true, queueCleared: false, idle: false, jobsSettled: 'unknown' as const }
    },
    ...partial.watch ? { watch: partial.watch } : {},
    ...partial.jobsSettled ? { jobsSettled: partial.jobsSettled } : {},
  }
  return { host, calls }
}

describe('ordinary session execution', () => {
  it('does not create a session when a write run has no baseline', async () => {
    const book = openBook()
    const held = await reserved(book, writeScope)
    const { host, calls } = hostOf({ async findSession() { return undefined } })
    const launched = await launchReservedRun(book, host, held.run.id, 'write it')
    expect(launched).toMatchObject({ code: 'baseline' })
    expect(calls).toEqual([])
    expect(book.run(held.run.id)?.phase).toBe('reserved')
  })

  it('reads an existing session and does not create a second one', async () => {
    const book = openBook()
    const held = await reserved(book)
    let finds = 0
    const { host, calls } = hostOf({
      async findSession(sessionId) {
        finds += 1
        return { cwd: 'H:\\repo', preset: 'standard' }
      },
    })
    const launched = await launchReservedRun(book, host, held.run.id, 'read it', 'standard')
    expect(launched).toMatchObject({ ok: true, phase: 'active', requestId: `req-${held.run.id}-initial` })
    expect(finds).toBe(1)
    expect(calls.some(call => call.startsWith('create '))).toBe(false)
    expect(calls).toContain(`prompt ${held.run.requestedSessionId} req-${held.run.id}-initial read it`)
    expect(book.run(held.run.id)?.phase).toBe('active')
    expect(book.occupying().map(run => run.id)).toEqual([held.run.id])
  })

  it('saves an unexpected session id and does not send the first prompt', async () => {
    const book = openBook()
    const held = await reserved(book)
    const { host, calls } = hostOf({
      async findSession() { return undefined },
      async createSession(input) { return { sessionId: 'session-other', cwd: input.cwd } },
    })
    const launched = await launchReservedRun(book, host, held.run.id, 'go')
    expect(launched).toMatchObject({ code: 'closed-run' })
    expect(calls.some(call => call.startsWith('prompt '))).toBe(false)
    expect(book.run(held.run.id)).toMatchObject({ sessionId: 'session-other', creation: 'rejected', phase: 'reserved' })
  })

  it('does not treat a missing cwd as a match', async () => {
    const book = openBook()
    const held = await reserved(book)
    const { host, calls } = hostOf({
      async findSession() { return {} },
    })
    const launched = await launchReservedRun(book, host, held.run.id, 'go')
    expect(launched).toMatchObject({ code: 'unknown' })
    expect(calls.some(call => call.startsWith('prompt '))).toBe(false)
    expect(book.run(held.run.id)?.creation).toBe('unknown')
  })

  it('keeps a failed create unknown and does not mint another id', async () => {
    const book = openBook()
    const held = await reserved(book)
    let creates = 0
    const { host } = hostOf({
      async findSession() { return undefined },
      async createSession() { creates += 1; throw new Error('socket dropped') },
    })
    expect(await launchReservedRun(book, host, held.run.id, 'go')).toMatchObject({ code: 'unknown' })
    expect(await launchReservedRun(book, host, held.run.id, 'go again')).toMatchObject({ code: 'unknown' })
    expect(creates).toBe(1)
    expect(book.run(held.run.id)?.creation).toBe('unknown')
    expect(book.run(held.run.id)?.phase).toBe('reserved')
  })

  it('reuses the same request id when the first receipt is lost', async () => {
    const book = openBook()
    const held = await reserved(book)
    let prompts = 0
    const seen: string[] = []
    const { host } = hostOf({
      async findSession(sessionId) { return prompts === 0 ? undefined : { cwd: 'H:\\repo' } },
      async prompt(_sessionId, text, requestId) {
        prompts += 1
        seen.push(`${requestId}:${text}`)
        if (prompts === 1) throw new Error('receipt lost')
        return 'accepted'
      },
    })
    expect(await launchReservedRun(book, host, held.run.id, 'first body')).toMatchObject({ ok: true, phase: 'reserved' })
    expect(book.run(held.run.id)?.deliveries[0]).toMatchObject({ status: 'unknown', hostRequestId: `req-${held.run.id}-initial`, contentRef: 'first body' })
    expect(await launchReservedRun(book, host, held.run.id, 'replacement body')).toMatchObject({ ok: true, phase: 'active' })
    expect(seen).toEqual([
      `req-${held.run.id}-initial:first body`,
      `req-${held.run.id}-initial:first body`,
    ])
    expect(book.run(held.run.id)?.deliveries.filter(item => item.kind === 'initial')).toHaveLength(1)
    expect(book.run(held.run.id)?.phase).toBe('active')
  })

  it('accepts a supplement only from one authoritative insert, and does not resend an unknown one', async () => {
    const book = openBook()
    const held = await reserved(book)
    const { host } = hostOf({ async findSession() { return { cwd: 'H:\\repo' } } })
    expect((await launchReservedRun(book, host, held.run.id, 'start')).ok).toBe(true)
    const inserts = new Map<string, number>()
    let relays = 0
    const relayHost = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async relay(_sessionId, _sender, _text, deliveryId) {
        relays += 1
        inserts.set(deliveryId, 1)
        return 'accepted'
      },
      async relayInserts(_sessionId, deliveryId) { return inserts.get(deliveryId) ?? 0 },
    }).host
    const sent = await supplementRun(book, relayHost, held.run.id, 'more context', 'session-dot', 5)
    expect(sent).toMatchObject({ ok: true, phase: 'active' })
    expect(relays).toBe(1)
    const delivery = book.run(held.run.id)?.deliveries.find(item => item.kind === 'context')
    expect(delivery).toMatchObject({ status: 'accepted', source: 'session-dot', contentRef: 'more context' })
    inserts.set(delivery!.id, 0)
    await book.settleDelivery(held.run.id, delivery!.id, 'unknown', undefined, 6)
    let second = 0
    const blocked = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async relay() { second += 1; return 'accepted' },
      async relayInserts() { return 0 },
    }).host
    expect(await supplementRun(book, blocked, held.run.id, 'more context', 'session-dot', 7)).toMatchObject({ code: 'unknown' })
    expect(second).toBe(0)
    expect(book.run(held.run.id)?.phase).toBe('active')
  })

  it('does not call a relay that is already in the log, and leaves an unproved send unknown', async () => {
    const book = openBook()
    const held = await reserved(book)
    const started = hostOf({ async findSession() { return { cwd: 'H:\\repo' } } })
    expect((await launchReservedRun(book, started.host, held.run.id, 'start')).ok).toBe(true)
    let relays = 0
    const already = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async relay() { relays += 1; return 'accepted' },
      async relayInserts() { return 1 },
    }).host
    expect(await supplementRun(book, already, held.run.id, 'same', 'session-dot', 5)).toMatchObject({ phase: 'active' })
    expect(relays).toBe(0)
    const ambiguous = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async relay() { return 'accepted' },
      async relayInserts() { return undefined },
    }).host
    const runId = held.run.id
    const second = await book.createChange({ title: 'Other', cwd: 'H:\\else', goal: 'g', at: 1 })
    const other = await book.reserveRun({ changeId: second.id, cwd: 'H:\\else', root: { workspaceRoot: 'H:\\else' }, writeScope: readScope, at: 2 })
    if (!other.ok) throw new Error(other.message)
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\else' } } }).host, other.run.id, 'start')).ok).toBe(true)
    expect(await supplementRun(book, ambiguous, other.run.id, 'blur', 'session-dot', 6)).toMatchObject({ code: 'unknown' })
    expect(book.run(other.run.id)?.deliveries.find(item => item.kind === 'context')?.status).toBe('unknown')
    expect(book.run(runId)?.phase).toBe('active')
  })

  it('releases a cancel only when the queue, the agent and owned jobs all settled', async () => {
    const book = openBook()
    const held = await reserved(book)
    const { host } = hostOf({ async findSession() { return { cwd: 'H:\\repo' } } })
    expect((await launchReservedRun(book, host, held.run.id, 'start')).ok).toBe(true)
    const partial = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: 'unknown' as const } },
    })
    const stopped = await cancelWork(book, partial.host, held.run.changeId, 8)
    expect(stopped).toMatchObject({ ok: true, runs: [{ id: held.run.id, released: false }] })
    expect(book.run(held.run.id)?.phase).toBe('settling')
    expect(book.occupying().map(run => run.id)).toEqual([held.run.id])
    const full = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    })
    expect(await cancelWork(book, full.host, held.run.changeId, 9)).toMatchObject({ runs: [{ released: true }] })
    expect(book.run(held.run.id)?.phase).toBe('stopped')
    expect(book.occupying()).toEqual([])
  })

  it('does not release a stop whose record changed while the host was waited on', async () => {
    const book = openBook()
    const held = await reserved(book)
    const { host } = hostOf({ async findSession() { return { cwd: 'H:\\repo' } } })
    expect((await launchReservedRun(book, host, held.run.id, 'start')).ok).toBe(true)
    const racing = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() {
        await book.noteObservation(held.run.id, 'late', 10)
        return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true }
      },
    })
    expect(await cancelWork(book, racing.host, held.run.changeId, 9)).toMatchObject({ runs: [{ released: false }] })
    expect(book.run(held.run.id)?.phase).toBe('settling')
  })

  it('stops an unsent reservation without a host stop once the session is absent', async () => {
    const book = openBook()
    const held = await reserved(book)
    let stops = 0
    const { host } = hostOf({
      async findSession() { return undefined },
      async stop() { stops += 1; return { cancelAccepted: false, queueCleared: false, idle: false, jobsSettled: 'unknown' as const } },
    })
    expect(await cancelWork(book, host, held.run.changeId, 4)).toMatchObject({ runs: [{ released: true }] })
    expect(stops).toBe(0)
    expect(book.run(held.run.id)).toMatchObject({ phase: 'stopped', closeReason: 'unsent' })
    expect(book.occupying()).toEqual([])
  })

  it('keeps a terminal run where a late cursor finds it', async () => {
    const book = openBook()
    const held = await reserved(book)
    const { host } = hostOf({ async findSession() { return undefined } })
    expect((await cancelWork(book, host, held.run.changeId, 4) as { ok: true }).ok).toBe(true)
    const before = book.run(held.run.id)?.updatedAt
    const noted = await observeRun(book, hostOf({
      async findSession() { return undefined },
      async watch() { return { seq: 9, idle: true, queue: 'empty' } },
    }).host, held.run.id, 20)
    expect(noted).toEqual({ ok: true, phase: 'stopped' })
    expect(book.run(held.run.id)?.updatedAt).toBe(before)
    expect(book.run(held.run.id)?.cursor).toBeUndefined()
    expect(book.run(held.run.id)?.inputRevision).toBe(1)
  })

  it('records a live cursor without completing the run', async () => {
    const book = openBook()
    const held = await reserved(book)
    const { host } = hostOf({ async findSession() { return { cwd: 'H:\\repo' } } })
    expect((await launchReservedRun(book, host, held.run.id, 'start')).ok).toBe(true)
    const noted = await observeRun(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async watch() { return { seq: 4, running: false, idle: true, queue: 'empty' } },
    }).host, held.run.id, 6)
    expect(noted).toEqual({ ok: true, phase: 'active' })
    expect(book.run(held.run.id)?.cursor).toEqual({ seq: 4, running: false, idle: true, queue: 'empty' })
    expect(book.run(held.run.id)?.phase).toBe('active')
  })

  it('reconciles a reserved id by reading it, never by creating or prompting', async () => {
    const book = openBook()
    const held = await reserved(book)
    await book.markCreation(held.run.id, 'unknown', 3)
    const { host, calls } = hostOf({ async findSession() { return { cwd: 'H:\\repo', preset: 'standard' } } })
    const reconciled = await reconcileReserved(book, host, held.run.id)
    expect(reconciled).toEqual({ ok: true, action: 'confirmed', created: false, prompted: false })
    expect(calls).toEqual([])
    expect(book.run(held.run.id)?.creation).toBe('confirmed')
    expect(book.run(held.run.id)?.phase).toBe('reserved')
  })

  it('counts only the matching relay insert', () => {
    const body = 'more context'
    const deliveryId = 'del-9'
    const events = [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: body }] } },
      { type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-dot', deliveryId }, content: [{ type: 'text', text: body }] }] } },
      { type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-dot', deliveryId: 'other' }, content: [{ type: 'text', text: body }] }] } },
    ]
    expect(countRelayInserts(events, deliveryId, 'session-dot', body)).toBe(1)
    expect(countRelayInserts(events, deliveryId, 'session-dot', 'other body')).toBe(0)
    const message = { id: 'message-1', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-dot', deliveryId }, content: [{ type: 'text', text: body }] }
    const lifecycle = [
      { type: 'agent/inbox/spliced', data: { inserted: [message] } },
      { type: 'user/message', data: message },
    ]
    expect(countRelayInserts(lifecycle, deliveryId, 'session-dot', body)).toBe(1)
    const duplicated = [
      { type: 'agent/inbox/spliced', data: { inserted: [message, { ...message, id: 'message-2' }] } },
    ]
    expect(countRelayInserts(duplicated, deliveryId, 'session-dot', body)).toBe(2)
    const prompt = { id: 'message-1', source: { kind: 'user', rpcId: 'req-1' }, content: [{ type: 'text', text: body }] }
    expect(countPromptReceipts([
      { type: 'agent/inbox/spliced', data: { inserted: [prompt] } },
      { type: 'user/message', data: prompt },
    ], 'req-1', body)).toBe(1)
    expect(countPromptReceipts([
      { type: 'user/message', data: prompt },
      { type: 'user/message', data: { ...prompt, id: 'message-2' } },
    ], 'req-1', body)).toBe(2)
  })

  it('adapts the public host without treating a resolved prompt as completion', async () => {
    const book = openBook()
    const held = await reserved(book)
    const prompted: string[] = []
    const host = bindRunSession({
      async findSession() { return { cwd: 'H:\\repo' } },
      async createSession() { throw new Error('should read, not create') },
      async prompt(_sessionId, text, _mode, _signal, requestId) { prompted.push(`${requestId}:${text}`) },
      async setReadOnly() { return true },
      async verifyTaskPermission() { return true },
      async relay() { throw new Error('unused') },
      async readEvents() { return [] },
    } as unknown as Parameters<typeof bindRunSession>[0])
    expect(await launchReservedRun(book, host, held.run.id, 'start')).toMatchObject({ phase: 'active' })
    expect(prompted).toEqual([`req-${held.run.id}-initial:start`])
    expect(book.run(held.run.id)?.phase).toBe('active')
  })

  it('does not prompt when the reserved id is cancelled during lookup', async () => {
    const book = openBook()
    const held = await reserved(book)
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered = false
    const { host, calls } = hostOf({
      async findSession() {
        entered = true
        await gate
        return undefined
      },
    })
    const launching = launchReservedRun(book, host, held.run.id, 'go')
    while (!entered) await Promise.resolve()
    await cancelWork(book, hostOf({ async findSession() { return undefined } }).host, held.run.changeId, 4)
    release()
    const launched = await launching
    expect(launched.ok).toBe(false)
    expect(calls.filter(call => call.startsWith('prompt ') || call.startsWith('create '))).toEqual([])
    expect(book.run(held.run.id)?.phase).toBe('stopped')
  })

  it('does not release a reservation while its first prompt is still in flight', async () => {
    const book = openBook()
    const held = await reserved(book)
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered = false
    let lateWrites = 0
    const { host } = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async prompt() {
        entered = true
        await gate
        lateWrites += 1
        return 'accepted'
      },
    })
    const launching = launchReservedRun(book, host, held.run.id, 'go')
    while (!entered) await Promise.resolve()
    const stopped = await cancelWork(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host, held.run.changeId, 9)
    expect(stopped).toMatchObject({ runs: [{ released: false }] })
    expect(book.occupying().map(run => run.id)).toEqual([held.run.id])
    release()
    await launching
    expect(lateWrites).toBe(1)
    expect(book.run(held.run.id)?.phase).not.toBe('active')
    expect(book.occupying().map(run => run.id)).toEqual([held.run.id])
  })

  it('does not send a restarted supplement intent again when the log already has it', async () => {
    const book = openBook()
    const held = await reserved(book)
    const started = hostOf({ async findSession() { return { cwd: 'H:\\repo' } } })
    expect((await launchReservedRun(book, started.host, held.run.id, 'start')).ok).toBe(true)
    const run = book.run(held.run.id)!
    await book.addDelivery(held.run.id, {
      kind: 'context', targetSessionId: run.sessionId ?? run.requestedSessionId, inputRevision: run.inputRevision,
      contentRef: 'more', source: 'session-dot', status: 'intent', at: 5,
    })
    const delivery = book.run(held.run.id)!.deliveries.find(item => item.kind === 'context')!
    let relays = 0
    const restored = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async relay() { relays += 1; return 'accepted' },
      async relayInserts(_session, deliveryId) { return deliveryId === delivery.id ? 1 : 0 },
    })
    const sent = await supplementRun(book, restored.host, held.run.id, 'more', 'session-dot', 6)
    expect(sent).toMatchObject({ ok: true, phase: 'active' })
    expect(relays).toBe(0)
    expect(book.run(held.run.id)?.deliveries.filter(item => item.kind === 'context')).toEqual([
      expect.objectContaining({ id: delivery.id, status: 'accepted' }),
    ])
  })

  it('keeps an unproved or duplicated supplement blocked', async () => {
    const book = openBook()
    const held = await reserved(book)
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\repo' } } }).host, held.run.id, 'start')).ok).toBe(true)
    const run = book.run(held.run.id)!
    await book.addDelivery(held.run.id, {
      kind: 'context', targetSessionId: run.requestedSessionId, inputRevision: run.inputRevision,
      contentRef: 'more', source: 'session-dot', status: 'unknown', at: 5,
    })
    let relays = 0
    const blocked = await supplementRun(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async relay() { relays += 1; return 'accepted' },
      async relayInserts() { return undefined },
    }).host, held.run.id, 'more', 'session-dot', 6)
    expect(blocked).toMatchObject({ code: 'unknown' })
    expect(relays).toBe(0)
    const duplicated = await reconcileRun(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async relayInserts() { return 2 },
    }).host, held.run.id)
    expect(duplicated).toMatchObject({ ok: true, prompted: false, created: false })
    expect(book.run(held.run.id)?.deliveries.find(item => item.kind === 'context')?.status).toBe('unknown')
  })

  it('closes one proved supplement after the accepted write failed', async () => {
    const rows = new Map<string, unknown>()
    let failAccepted = false
    const book = new WorkBook(async (table, key, value) => {
      const row = value as { deliveries?: { kind?: string; status?: string }[] }
      if (failAccepted && table === 'runs' && row.deliveries?.some(item => item.kind === 'context' && item.status === 'accepted')) throw new Error('accept disk')
      rows.set(`${table}:${key}`, structuredClone(value))
    }, 'win32')
    const held = await reserved(book)
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\repo' } } }).host, held.run.id, 'start')).ok).toBe(true)
    failAccepted = true
    let sentInsert = false
    await expect(supplementRun(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async relay() { sentInsert = true; return 'accepted' },
      async relayInserts() { return sentInsert ? 1 : 0 },
    }).host, held.run.id, 'more', 'session-dot', 6)).rejects.toThrow('accept disk')
    const reopened = WorkBook.restore({
      changes: [...rows.values()].filter(row => (row as { goal?: string }).goal === undefined && (row as { title?: string }).title),
      inputs: [...rows.values()].filter(row => (row as { goal?: string }).goal !== undefined),
      runs: [...rows.values()].filter(row => (row as { phase?: string }).phase !== undefined),
      verifications: [],
    }, async (table, key, value) => { rows.set(`${table}:${key}`, structuredClone(value)) }, 'win32')
    const delivery = reopened.run(held.run.id)?.deliveries.find(item => item.kind === 'context')
    expect(delivery?.status).toBe('unknown')
    const closed = await reconcileRun(reopened, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async relayInserts(_session, deliveryId) { return deliveryId === delivery?.id ? 1 : 0 },
    }).host, held.run.id, 8)
    expect(closed).toMatchObject({ prompted: false, created: false })
    expect(reopened.run(held.run.id)?.deliveries.find(item => item.id === delivery?.id)?.status).toBe('accepted')
    expect(reopened.run(held.run.id)?.phase).toBe('active')
  })

  it('does not deliver when the required permission is not verified', async () => {
    const book = openBook()
    const held = await reserved(book)
    const read = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async prepareAccess() { return 'rejected' },
    })
    expect(await launchReservedRun(book, read.host, held.run.id, 'look')).toMatchObject({ code: 'closed-run' })
    expect(read.calls.some(call => call.startsWith('prompt '))).toBe(false)
    expect(read.calls.some(call => call.startsWith('access '))).toBe(true)
    expect(book.run(held.run.id)?.access).toBe('read')
  })

  it('finishes an active run only after stop evidence, and idle does not complete it', async () => {
    const book = openBook()
    const held = await reserved(book)
    const changeId = held.run.changeId
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\repo' } } }).host, held.run.id, 'start')).ok).toBe(true)
    const idle = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async watch() { return { idle: true, queue: 'empty', running: false } },
    })
    expect(await observeRun(book, idle.host, held.run.id, 6)).toEqual({ ok: true, phase: 'active' })
    expect(book.change(changeId)?.control).toBe('open')
    const unfinished = await finishWork(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: 'unknown' } },
    }).host, held.run.id, 'completed', 7)
    expect(unfinished).toMatchObject({ code: 'unknown' })
    expect(book.run(held.run.id)?.phase).toBe('settling')
    expect(book.change(changeId)?.control).toBe('open')
    const done = await finishWork(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host, held.run.id, 'completed', 8)
    expect(done).toEqual({ ok: true, phase: 'completed' })
    expect(book.change(changeId)?.control).toBe('open')
    expect(book.occupying()).toEqual([])
  })

  it('refuses to finish a review and points at closeout or reject without releasing it', async () => {
    const book = openBook()
    const change = await book.createChange({ title: 'Ship', cwd: 'H:\\repo', goal: 'land it', at: 1 })
    const held = await book.reserveRun({
      changeId: change.id, kind: 'review', cwd: 'H:\\repo', root: { workspaceRoot: 'H:\\repo' }, writeScope: readScope, at: 2,
    })
    if (!held.ok) throw new Error(held.message)
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\repo' } } }).host, held.run.id, 'check')).ok).toBe(true)
    let stops = 0
    const refused = await finishWork(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host, held.run.id, 'completed', 8)
    expect(refused).toMatchObject({ code: 'unknown' })
    expect('message' in refused && refused.message).toContain('use action=closeout or action=reject')
    expect(stops).toBe(0)
    expect(book.run(held.run.id)?.phase).toBe('active')
    expect(book.run(held.run.id)?.closeIntent).toBeUndefined()
    expect(book.occupying().map(run => run.id)).toEqual([held.run.id])
    expect(book.change(change.id)?.closeout).toBeUndefined()
  })

  it('lets only one concurrent supplement send one delivery', async () => {
    const book = openBook()
    const held = await reserved(book)
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\repo' } } }).host, held.run.id, 'start')).ok).toBe(true)
    const ids: string[] = []
    let entered = 0
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const host = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async relay(_session, _sender, _text, deliveryId) {
        ids.push(deliveryId)
        entered += 1
        if (entered === 1) await gate
        return 'accepted'
      },
      async relayInserts() { return ids.length > 0 ? 1 : 0 },
    }).host
    const first = supplementRun(book, host, held.run.id, 'more', 'session-dot', 5)
    while (entered === 0) await Promise.resolve()
    const second = supplementRun(book, host, held.run.id, 'more', 'session-dot', 6)
    release()
    await Promise.all([first, second])
    expect(ids).toEqual([ids[0]])
    expect(book.run(held.run.id)?.deliveries.filter(item => item.kind === 'context')).toHaveLength(1)
  })

  it('lets only one of two new supplements create and send', async () => {
    const book = openBook()
    const held = await reserved(book)
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\repo' } } }).host, held.run.id, 'start')).ok).toBe(true)
    const ids: string[] = []
    const host = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async relay(_session, _sender, _text, deliveryId) { ids.push(deliveryId); return 'accepted' },
      async relayInserts(_session, deliveryId) { return ids.includes(deliveryId) ? 1 : 0 },
    }).host
    await Promise.all([
      supplementRun(book, host, held.run.id, 'more', 'session-dot', 5),
      supplementRun(book, host, held.run.id, 'more', 'session-dot', 6),
    ])
    expect(new Set(ids).size).toBe(1)
    expect(book.run(held.run.id)?.deliveries.filter(item => item.kind === 'context')).toHaveLength(1)
  })

  it('lets only one concurrent launch prompt', async () => {
    const book = openBook()
    const held = await reserved(book)
    let prompts = 0
    const host = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async prompt() { prompts += 1; return 'accepted' },
    }).host
    await Promise.all([
      launchReservedRun(book, host, held.run.id, 'go'),
      launchReservedRun(book, host, held.run.id, 'go'),
    ])
    expect(prompts).toBe(1)
    expect(book.run(held.run.id)?.phase).toBe('active')
  })

  it('keeps an accepted in-flight prompt settling, then reconcile finishes the persisted stop', async () => {
    const book = openBook()
    const held = await reserved(book)
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered = false
    const launching = launchReservedRun(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async prompt() {
        entered = true
        await gate
        return 'accepted'
      },
    }).host, held.run.id, 'go')
    while (!entered) await Promise.resolve()
    const stopped = await cancelWork(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host, held.run.changeId, 9)
    expect(stopped).toMatchObject({ runs: [{ released: false }] })
    release()
    await launching
    expect(book.run(held.run.id)?.phase).toBe('settling')
    expect(book.run(held.run.id)?.deliveries.find(item => item.kind === 'initial')?.status).toBe('accepted')
    expect(book.run(held.run.id)?.closeIntent).toBe('stopped')
    const closed = await reconcileRun(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host, held.run.id, 10)
    expect(closed).toMatchObject({ action: 'closed', prompted: false })
    expect(book.run(held.run.id)?.phase).toBe('stopped')
  })

  it('resumes a persisted failed close instead of only noting a cursor', async () => {
    const book = openBook()
    const held = await reserved(book)
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\repo' } } }).host, held.run.id, 'start')).ok).toBe(true)
    let stops = 0
    expect(await finishWork(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: 'unknown' } },
    }).host, held.run.id, 'failed', 7)).toMatchObject({ code: 'unknown' })
    expect(book.run(held.run.id)).toMatchObject({ phase: 'settling', closeIntent: 'failed' })
    expect(book.change(held.run.changeId)?.control).toBe('open')
    const resumed = await reconcileRun(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async watch() { return { idle: true, queue: 'empty' } },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host, held.run.id, 8)
    expect(stops).toBe(2)
    expect(resumed).toMatchObject({ action: 'closed' })
    expect(book.run(held.run.id)?.phase).toBe('failed')
    expect(book.change(held.run.changeId)?.control).toBe('open')
  })

  it('finishes a paused or revised run without cancelling the change', async () => {
    const book = openBook()
    const held = await reserved(book)
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\repo' } } }).host, held.run.id, 'start')).ok).toBe(true)
    await book.setControl(held.run.changeId, 'paused', 6)
    let stops = 0
    const paused = await finishWork(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host, held.run.id, 'completed', 7)
    expect(paused).toEqual({ ok: true, phase: 'completed' })
    expect(stops).toBe(1)
    expect(book.change(held.run.changeId)?.control).toBe('paused')

    const other = await reserved(book)
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\repo' } } }).host, other.run.id, 'start')).ok).toBe(true)
    await book.reviseChange(other.run.changeId, { goal: 'changed', at: 8 })
    const handed = await finishWork(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host, other.run.id, 'completed', 9)
    expect(handed).toEqual({ ok: true, phase: 'completed' })
    expect(book.change(other.run.changeId)?.control).toBe('open')
    expect(book.change(other.run.changeId)?.currentRevision).toBe(2)
  })

  it('continues a cancel whose run write never landed', async () => {
    const rows = new Map<string, unknown>()
    let failRun = false
    const book = new WorkBook(async (table, key, value) => {
      const row = value as { phase?: string }
      if (failRun && table === 'runs' && row.phase === 'settling') throw new Error('run disk')
      rows.set(`${table}:${key}`, structuredClone(value))
    }, 'win32')
    const held = await reserved(book)
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\repo' } } }).host, held.run.id, 'start')).ok).toBe(true)
    failRun = true
    await expect(book.prepareCancel(held.run.changeId, 6)).rejects.toThrow('run disk')
    const reopened = restoreRows(rows)
    expect(reopened.change(held.run.changeId)?.control).toBe('cancelled')
    expect(reopened.run(held.run.id)?.phase).toBe('active')
    let stops = 0
    const host = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host
    expect(await reconcileRun(reopened, host, held.run.id, 7)).toMatchObject({ action: 'closed' })
    expect(stops).toBe(1)
    expect(reopened.run(held.run.id)).toMatchObject({ phase: 'stopped', closeIntent: 'stopped' })
    expect(await reconcileRun(reopened, host, held.run.id, 8)).toMatchObject({ action: 'left' })
    expect(stops).toBe(1)
  })

  it('adopts the runs a partial cancel left behind', async () => {
    const rows = new Map<string, unknown>()
    let secondId = ''
    let failSecond = false
    const book = new WorkBook(async (table, key, value) => {
      const row = value as { id?: string; phase?: string }
      if (failSecond && table === 'runs' && row.id === secondId && row.phase === 'settling') throw new Error('second disk')
      rows.set(`${table}:${key}`, structuredClone(value))
    }, 'win32')
    const first = await reserved(book)
    await book.reviseChange(first.run.changeId, { maxConcurrentRuns: 2, at: 3 })
    const second = await book.reserveRun({ changeId: first.run.changeId, cwd: 'H:\\else', root: { workspaceRoot: 'H:\\else' }, writeScope: readScope, at: 4 })
    if (!second.ok) throw new Error(second.message)
    secondId = second.run.id
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\repo' } } }).host, first.run.id, 'start')).ok).toBe(true)
    expect((await launchReservedRun(book, hostOf({ async findSession() { return { cwd: 'H:\\else' } } }).host, second.run.id, 'start')).ok).toBe(true)
    failSecond = true
    await expect(book.prepareCancel(first.run.changeId, 6)).rejects.toThrow('second disk')
    const reopened = restoreRows(rows)
    expect(reopened.change(first.run.changeId)?.control).toBe('cancelled')
    expect(reopened.run(first.run.id)?.phase).toBe('settling')
    expect(reopened.run(second.run.id)?.phase).toBe('active')
    let stops = 0
    const host = hostOf({
      async findSession(id) { return { cwd: id === second.run.requestedSessionId ? 'H:\\else' : 'H:\\repo' } },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host
    await reconcileRun(reopened, host, first.run.id, 7)
    await reconcileRun(reopened, host, second.run.id, 8)
    expect(reopened.run(first.run.id)?.phase).toBe('stopped')
    expect(reopened.run(second.run.id)?.phase).toBe('stopped')
    expect(stops).toBe(2)
    await reconcileRun(reopened, host, second.run.id, 9)
    expect(stops).toBe(2)
  })

  it('closes a restarted session claim and then the stop', async () => {
    const rows = new Map<string, unknown>()
    const book = new WorkBook(async (table, key, value) => { rows.set(`${table}:${key}`, structuredClone(value)) }, 'win32')
    const held = await reserved(book)
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered = false
    const launching = launchReservedRun(book, hostOf({
      async findSession() {
        entered = true
        await gate
        return undefined
      },
    }).host, held.run.id, 'go')
    while (!entered) await Promise.resolve()
    await book.prepareCancel(held.run.changeId, 4)
    expect(book.liveSessionClaim(held.run.id)).toBe(true)
    const during = await reconcileRun(book, hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host, held.run.id, 5)
    expect(during).toMatchObject({ action: 'held' })
    expect(book.run(held.run.id)?.creation).toBe('inflight')
    const snapshot = new Map<string, unknown>()
    for (const [key, value] of rows) snapshot.set(key, structuredClone(value))
    release()
    await launching
    const reopened = restoreRows(snapshot)
    expect(reopened.liveSessionClaim(held.run.id)).toBe(false)
    expect(reopened.run(held.run.id)).toMatchObject({ phase: 'settling', creation: 'inflight', actionClaim: 'session' })
    let stops = 0
    const host = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host
    expect(await reconcileRun(reopened, host, held.run.id, 6)).toMatchObject({ action: 'closed' })
    expect(reopened.run(held.run.id)).toMatchObject({ phase: 'stopped', creation: 'confirmed' })
    expect(reopened.run(held.run.id)?.actionClaim).toBeUndefined()
    expect(await reconcileRun(reopened, host, held.run.id, 7)).toMatchObject({ action: 'left' })
    expect(stops).toBe(1)
  })

  it('does not stop or release a restarted claim whose cwd does not match', async () => {
    const { held, reopened } = await restartedClaim()
    let stops = 0
    const host = hostOf({
      async findSession() { return { cwd: 'H:\\wrong' } },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host
    expect(await reconcileRun(reopened, host, held.run.id, 6)).toMatchObject({ action: 'held' })
    expect(reopened.run(held.run.id)).toMatchObject({ phase: 'settling', creation: 'rejected' })
    expect(reopened.occupying().map(run => run.id)).toEqual([held.run.id])
    expect(await reconcileRun(reopened, host, held.run.id, 7)).toMatchObject({ action: 'held' })
    expect(stops).toBe(0)
  })

  it('does not stop or release a restarted claim whose preset does not match', async () => {
    const { held, reopened } = await restartedClaim('standard')
    let stops = 0
    const host = hostOf({
      async findSession() { return { cwd: 'H:\\repo', preset: 'other' } },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host
    expect(await reconcileRun(reopened, host, held.run.id, 6)).toMatchObject({ action: 'held' })
    expect(reopened.run(held.run.id)).toMatchObject({ phase: 'settling', creation: 'rejected' })
    expect(reopened.occupying().map(run => run.id)).toEqual([held.run.id])
    expect(stops).toBe(0)
  })

  it('does not stop or release a restarted claim whose identity is missing', async () => {
    const { held, reopened } = await restartedClaim('standard')
    let stops = 0
    const host = hostOf({
      async findSession() { return { cwd: 'H:\\repo' } },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host
    expect(await reconcileRun(reopened, host, held.run.id, 6)).toMatchObject({ action: 'held' })
    expect(reopened.run(held.run.id)).toMatchObject({ phase: 'settling', creation: 'unknown' })
    expect(reopened.occupying().map(run => run.id)).toEqual([held.run.id])
    expect(await reconcileRun(reopened, host, held.run.id, 7)).toMatchObject({ action: 'held' })
    expect(stops).toBe(0)
  })
})

function restoreRows(rows: Map<string, unknown>, persist?: WorkPersist) {
  return WorkBook.restore({
    changes: [...rows.values()].filter(row => (row as { goal?: string }).goal === undefined && (row as { title?: string }).title),
    inputs: [...rows.values()].filter(row => (row as { goal?: string }).goal !== undefined),
    runs: [...rows.values()].filter(row => (row as { phase?: string }).phase !== undefined),
    verifications: [],
  }, persist ?? (async () => undefined), 'win32')
}

/** Cancel while the session lookup is still in flight, then reopen that persisted claim. */
async function restartedClaim(preset?: string) {
  const rows = new Map<string, unknown>()
  const book = new WorkBook(async (table, key, value) => { rows.set(`${table}:${key}`, structuredClone(value)) }, 'win32')
  const held = await reserved(book)
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered = false
  const launching = launchReservedRun(book, hostOf({
    async findSession() {
      entered = true
      await gate
      return undefined
    },
  }).host, held.run.id, 'go', preset)
  while (!entered) await Promise.resolve()
  await book.prepareCancel(held.run.changeId, 4)
  const snapshot = new Map<string, unknown>()
  for (const [key, value] of rows) snapshot.set(key, structuredClone(value))
  release()
  await launching
  return { held, reopened: restoreRows(snapshot) }
}

describe('session cwd junction and short-path launch', () => {
  it('passes the on-disk junction path to createSession and rejects a host that returns the target', async () => {
    const rawBase = mkdtempSync(join(tmpdir(), 'dot-exec-junc-'))
    const base = onDiskPath(rawBase)
    const real = join(base, 'RealTarget')
    const junction = join(base, 'JunctionDir')
    try {
      mkdirSync(real, { recursive: true })
      symlinkSync(real, junction, process.platform === 'win32' ? 'junction' : 'dir')

      const book = new WorkBook(async () => undefined, process.platform)
      const c1 = await book.createChange({ title: 'J1', cwd: process.platform === 'win32' ? junction.toLowerCase() : junction, goal: 'g', at: 1 })
      const r1 = await book.reserveRun({ changeId: c1.id, cwd: c1.cwd, root: { workspaceRoot: c1.cwd }, writeScope: readScope, at: 2 })
      if (!r1.ok) throw new Error(r1.message)

      const seenCwds: string[] = []
      const { host: goodHost, calls: goodCalls } = hostOf({
        async findSession() { return undefined },
        async createSession(input) {
          seenCwds.push(input.cwd)
          return { sessionId: input.sessionId, cwd: input.cwd }
        },
      })
      const launched = await launchReservedRun(book, goodHost, r1.run.id, 'go')
      expect(launched).toMatchObject({ ok: true, phase: 'active' })
      expect(seenCwds).toEqual([junction])
      expect(goodCalls.some(call => call.startsWith(`prompt ${r1.run.requestedSessionId} `))).toBe(true)

      const c2 = await book.createChange({ title: 'J2', cwd: junction, goal: 'g', at: 3 })
      const r2 = await book.reserveRun({ changeId: c2.id, cwd: c2.cwd, root: { workspaceRoot: c2.cwd }, writeScope: readScope, at: 4 })
      if (!r2.ok) throw new Error(r2.message)
      const { host: badHost, calls: badCalls } = hostOf({
        async findSession() { return undefined },
        async createSession(input) { return { sessionId: input.sessionId, cwd: real } },
      })
      const rejected = await launchReservedRun(book, badHost, r2.run.id, 'go')
      expect(rejected).toMatchObject({ ok: false, code: 'closed-run' })
      expect(badCalls.some(call => call.startsWith('prompt '))).toBe(false)
      expect(book.run(r2.run.id)?.creation).toBe('rejected')
    } finally {
      rmSync(junction, { force: true })
      rmSync(rawBase, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32' || !existsSync('C:\\PROGRA~1'))('confirms and prompts a run reserved with an 8.3 short path when the host reports the expanded path', async () => {
    const shortPath = 'C:\\PROGRA~1'
    const longPath = realpathSync.native(shortPath)
    const book = openBook()
    const change = await book.createChange({ title: 'Short', cwd: shortPath, goal: 'g', at: 1 })
    const held = await book.reserveRun({ changeId: change.id, cwd: shortPath, root: { workspaceRoot: shortPath }, writeScope: readScope, at: 2 })
    if (!held.ok) throw new Error(held.message)
    const seenCwds: string[] = []
    const { host, calls } = hostOf({
      async findSession() { return undefined },
      async createSession(input) {
        seenCwds.push(input.cwd)
        return { sessionId: input.sessionId, cwd: input.cwd }
      },
    })
    const launched = await launchReservedRun(book, host, held.run.id, 'inspect')
    expect(launched).toMatchObject({ ok: true, phase: 'active' })
    expect(seenCwds).toEqual([longPath])
    expect(calls.some(call => call.startsWith(`prompt ${held.run.requestedSessionId} `))).toBe(true)
    expect(book.run(held.run.id)?.creation).toBe('confirmed')
  })
})

describe('zombie run recovery', () => {
  it('keeps a deliberately reserved intent run reserved even when it is old', async () => {
    const book = openBook()
    const held = await reserved(book)
    const { host, calls } = hostOf({ async findSession() { return undefined } })
    const result = await reconcileReserved(book, host, held.run.id, 2 + 10 * 60_000 + 1)
    expect(result).toMatchObject({ ok: true, action: 'absent', created: false, prompted: false })
    expect(book.run(held.run.id)).toMatchObject({ phase: 'reserved' })
    expect(calls).toEqual([])
  })

  it('closes a rejected settling run once the absent identity is confirmed, without stopping the session', async () => {
    const book = openBook()
    const held = await reserved(book)
    const { host: launchHost } = hostOf({
      async findSession() { return undefined },
      async createSession(input) { return { sessionId: 'session-other', cwd: input.cwd } },
    })
    await launchReservedRun(book, launchHost, held.run.id, 'go')
    expect(book.run(held.run.id)?.creation).toBe('rejected')
    const prepared = await book.prepareFinish(held.run.id, 'stopped', 3)
    expect(prepared.ok).toBe(true)

    let stops = 0
    const sessions = new Map<string, { cwd: string }>()
    const { host } = hostOf({
      async findSession(id) { return sessions.get(id) },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    })
    const result = await reconcileRun(book, host, held.run.id, 4)
    expect(result).toMatchObject({ ok: true, action: 'closed', created: false, prompted: false })
    expect(book.run(held.run.id)).toMatchObject({ phase: 'stopped', closeReason: 'identity-rejected' })
    expect(stops).toBe(0)
  })

  it('releases a rejected settling run only when the present identity is read-only idle', async () => {
    const book = openBook()
    const held = await reserved(book)
    const { host: launchHost } = hostOf({
      async findSession() { return undefined },
      async createSession(input) { return { sessionId: 'session-other', cwd: input.cwd } },
    })
    await launchReservedRun(book, launchHost, held.run.id, 'go')
    await book.prepareFinish(held.run.id, 'stopped', 3)

    let stops = 0
    const present = new Map([
      [held.run.requestedSessionId, { cwd: 'H:\\repo' }],
      ['session-other', { cwd: 'H:\\repo' }],
    ])
    const states = new Map([
      [held.run.requestedSessionId, { running: true, queue: 'empty' as const }],
      ['session-other', { running: true, queue: 'empty' as const }],
    ])
    const busy = hostOf({
      async findSession(id) { return present.get(id) },
      async watch(id) { return states.get(id) ?? { running: true, queue: 'unknown' as const } },
      async jobsSettled() { return true as const },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host
    expect(await reconcileRun(book, busy, held.run.id, 4)).toMatchObject({ action: 'held' })
    expect(book.run(held.run.id)?.phase).toBe('settling')

    states.set(held.run.requestedSessionId, { running: false, queue: 'empty' })
    states.set('session-other', { running: false, queue: 'empty' })
    const idle = hostOf({
      async findSession(id) { return present.get(id) },
      async watch(id) { return states.get(id) ?? { running: true, queue: 'unknown' as const } },
      async jobsSettled() { return true as const },
      async stop() { stops += 1; return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }).host
    expect(await reconcileRun(book, idle, held.run.id, 5)).toMatchObject({ action: 'closed' })
    expect(book.run(held.run.id)).toMatchObject({ phase: 'stopped', closeReason: 'identity-rejected' })
    expect(stops).toBe(0)
  })

  it('checks both the requested id and the host session id before releasing a rejected run', async () => {
    const book = openBook()
    const held = await reserved(book)
    const { host: launchHost } = hostOf({
      async findSession() { return undefined },
      async createSession(input) { return { sessionId: 'session-other', cwd: input.cwd } },
    })
    await launchReservedRun(book, launchHost, held.run.id, 'go')
    await book.prepareFinish(held.run.id, 'stopped', 3)

    const sessions = new Map([['session-other', { cwd: 'H:\\repo' }]])
    const states = new Map([['session-other', { running: true, queue: 'empty' as const }]])
    let jobs: boolean | 'unknown' = false
    const makeHost = () => hostOf({
      async findSession(id) { return sessions.get(id) },
      async watch(id) { return states.get(id) ?? { running: true, queue: 'unknown' as const } },
      async jobsSettled() { return jobs },
    }).host
    expect(await reconcileRun(book, makeHost(), held.run.id, 4)).toMatchObject({ action: 'held' })
    expect(book.run(held.run.id)?.phase).toBe('settling')

    states.set('session-other', { running: false, queue: 'empty' })
    expect(await reconcileRun(book, makeHost(), held.run.id, 5)).toMatchObject({ action: 'held' })
    jobs = true
    expect(await reconcileRun(book, makeHost(), held.run.id, 6)).toMatchObject({ action: 'closed' })
    expect(book.run(held.run.id)).toMatchObject({ phase: 'stopped', closeReason: 'identity-rejected' })
  })

  it('closes an unknown settling run whose close intent is stopped when the requested session is absent', async () => {
    const book = openBook()
    const held = await reserved(book)
    const marked = await book.markCreation(held.run.id, 'unknown')
    expect('id' in marked).toBe(true)
    const prepared = await book.prepareFinish(held.run.id, 'stopped', 3)
    expect(prepared.ok).toBe(true)
    const { host } = hostOf({ async findSession() { return undefined } })
    expect(await reconcileRun(book, host, held.run.id, 4)).toMatchObject({ ok: true, action: 'closed', created: false, prompted: false })
    expect(book.run(held.run.id)).toMatchObject({ phase: 'stopped', closeReason: 'unsent' })
  })
})

describe('session failure causes', () => {
  it('includes the real lookup and create causes in refusal messages', async () => {
    const lookupBook = openBook()
    const lookupHeld = await reserved(lookupBook)
    const lookup = hostOf({ async findSession() { throw new Error('persistence timeout') } }).host
    await expect(launchReservedRun(lookupBook, lookup, lookupHeld.run.id, 'go')).resolves.toMatchObject({
      ok: false,
      message: `${lookupHeld.run.id} session lookup failed (persistence timeout); no second session was created`,
    })

    const createBook = openBook()
    const createHeld = await reserved(createBook)
    const create = hostOf({
      async findSession() { return undefined },
      async createSession() { throw new Error('agent service offline') },
    }).host
    await expect(launchReservedRun(createBook, create, createHeld.run.id, 'go')).resolves.toMatchObject({
      ok: false,
      message: `${createHeld.run.id} session create failed (agent service offline); it was not retried with a new id`,
    })
  })
})

describe('reserved zombie compatibility', () => {
  it('closes the real reserved unknown zombie shape after the absent id is confirmed and the run is old', async () => {
    const book = openBook()
    const held = await reserved(book)
    expect('id' in await book.markCreation(held.run.id, 'unknown')).toBe(true)
    const { host, calls } = hostOf({ async findSession() { return undefined } })
    const result = await reconcileReserved(book, host, held.run.id, 2 + 10 * 60_000 + 1)
    expect(result).toMatchObject({ ok: true, action: 'closed', created: false, prompted: false })
    expect(book.run(held.run.id)).toMatchObject({ phase: 'stopped', closeReason: 'unsent' })
    expect(calls).toEqual([])
  })
})
