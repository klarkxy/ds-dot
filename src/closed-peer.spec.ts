import { expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './contracts.ts'
import { finishWork, launchReservedRun, supplementRun } from './execution.ts'
import { PeerLedger } from './peer.ts'
import { DotService } from './service.ts'
import { parsePeerDelivery } from './storage.ts'
import { DotStore } from './store.ts'

it('does not wake a completed writer after its scope was handed to a new run', async () => {
  const store = new DotStore(undefined)
  await store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const book = store.work
  const change = await book.createChange({ title: 'closed writer', cwd: 'H:/audit-workspace', goal: 'write a.txt', maxConcurrentRuns: 2, at: 1 })
  const reservation = await book.reserveRun({ changeId: change.id, cwd: change.cwd, root: { workspaceRoot: change.cwd }, writeScope: { kind: 'paths', paths: [{ path: 'a.txt', type: 'file' }] }, at: 2 })
  if (!reservation.ok) throw new Error(reservation.message)
  const published = await book.publishBaseline(reservation.run.id, reservation.revision, 'fixture-baseline', 3)
  if (!('applied' in published)) throw new Error(published.message)
  const runHost = {
    async findSession() { return { cwd: change.cwd, preset: 'standard' } },
    async createSession(input: { sessionId: string; cwd: string }) { return input },
    async prepareAccess() { return 'ok' as const },
    async prompt() { return 'accepted' as const },
    async promptReceipts() { return 0 },
    async relay() { return 'accepted' as const },
    async relayInserts() { return 0 },
    async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
  }
  expect((await launchReservedRun(book, runHost, reservation.run.id, 'write a.txt')).ok).toBe(true)
  expect((await finishWork(book, runHost, reservation.run.id, 'completed', 5)).ok).toBe(true)
  const next = await book.reserveRun({ changeId: change.id, cwd: change.cwd, root: { workspaceRoot: change.cwd }, writeScope: { kind: 'paths', paths: [{ path: 'a.txt', type: 'file' }] }, at: 6 })
  expect(next.ok).toBe(true)
  const oldId = reservation.run.requestedSessionId
  const senderRun = await book.reserveRun({ changeId: change.id, cwd: change.cwd, root: { workspaceRoot: change.cwd }, writeScope: { kind: 'paths', paths: [] }, at: 7 })
  if (!senderRun.ok) throw new Error(senderRun.message)
  expect((await launchReservedRun(book, runHost, senderRun.run.id, 'coordinate with peers')).ok).toBe(true)
  const senderId = senderRun.run.requestedSessionId
  const regular = await supplementRun(book, runHost, reservation.run.id, 'write a.txt again', senderId, 8)
  expect(regular).toMatchObject({ ok: false, code: 'closed-run' })
  const entries = new Map<string, unknown>()
  const peers = new PeerLedger({ get: key => entries.get(key), put: async (key, value) => { entries.set(key, value) }, entries: () => entries.entries() }, parsePeerDelivery)
  const events: unknown[] = []
  const relays: unknown[] = []
  const host = {
    isRunning: () => false,
    async readEvents() { return events },
    async relay(target: string, sender: string, text: string, deliveryId: string) {
      relays.push({ target, sender, text, deliveryId })
      events.push({ type: 'agent/inbox/spliced', data: { inserted: [{ id: 'msg-peer', content: [{ type: 'text', text }], source: { kind: 'agent-message', form: 'relay', senderSessionId: sender, deliveryId } }] } })
    },
  }
  const service = new DotService({ host: host as never, store, peers, homeDir: 'H:/unused-audit-home', notes: { path: 'memory.md', read: async () => '', readCognition: async () => '' } as never, timer: { set: () => 0, clear: () => {}, now: () => 10 }, now: () => 10 })
  try {
    const result = await service.peerSend({ senderSessionId: senderId, targetSessionId: oldId, deliveryId: 'late-to-completed', text: 'write a.txt again' })
    expect(result).toContain('nothing was sent')
    expect(relays, 'A completed writer must not receive executable input after handing off its scope').toHaveLength(0)
    expect(entries.has('late-to-completed')).toBe(false)
    expect(book.run(reservation.run.id)?.phase).toBe('completed')
    expect(book.occupying().some(run => run.id === reservation.run.id)).toBe(false)
  } finally { await service.dispose() }
})
