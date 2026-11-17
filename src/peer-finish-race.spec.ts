import { expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './contracts.ts'
import { finishWork, launchReservedRun } from './execution.ts'
import { bindHost } from './host.ts'
import { PeerLedger } from './peer.ts'
import { DotService } from './service.ts'
import { parsePeerDelivery } from './storage.ts'
import { DotStore } from './store.ts'

it('does not follow up after finish hands off the scope during peer host lookup', async () => {
  const store = new DotStore(undefined)
  await store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const book = store.work
  const change = await book.createChange({ title: 'handoff', cwd: 'H:/audit-workspace', goal: 'write a.txt', maxConcurrentRuns: 2, at: 1 })
  const target = await book.reserveRun({ changeId: change.id, cwd: change.cwd, root: { workspaceRoot: change.cwd }, writeScope: { kind: 'paths', paths: [{ path: 'a.txt', type: 'file' }] }, at: 2 })
  if (!target.ok) throw new Error(target.message)
  const base = await book.publishBaseline(target.run.id, target.revision, 'fixture-base', 3)
  if (!('applied' in base)) throw new Error(base.message)
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
  expect((await launchReservedRun(book, runHost, target.run.id, 'write a.txt')).ok).toBe(true)
  const sender = await book.reserveRun({ changeId: change.id, cwd: change.cwd, root: { workspaceRoot: change.cwd }, writeScope: { kind: 'paths', paths: [] }, at: 4 })
  if (!sender.ok) throw new Error(sender.message)
  expect((await launchReservedRun(book, runHost, sender.run.id, 'coordinate')).ok).toBe(true)
  const entries = new Map<string, unknown>()
  let reached!: () => void
  let release!: () => void
  const atIntent = new Promise<void>(resolve => { reached = resolve })
  const writeMayComplete = new Promise<void>(resolve => { release = resolve })
  const peers = new PeerLedger({ get: key => entries.get(key), async put(key, value) { entries.set(key, value) }, entries: () => entries.entries() }, parsePeerDelivery)
  const events: unknown[] = []
  const relays: unknown[] = []
  const live = {
    status: 'idle', session: { id: target.run.requestedSessionId }, followup(message: unknown) {
      relays.push({ targetId: target.run.requestedSessionId, phaseAtRelay: book.run(target.run.id)?.phase, occupyingAtRelay: book.occupying().map(run => run.id) })
      events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
    },
  }
  const bound = bindHost(name => {
    if (name === 'agents') return { get: () => undefined }
    if (name === 'sessionController') return { async resolveAgent() { reached(); await writeMayComplete; return { agent: live } } }
    return undefined
  })
  const host = { ...bound, isRunning: () => false, async readEvents() { return events } }
  const service = new DotService({ host: host as never, store, peers, homeDir: 'H:/unused-audit-home', notes: { path: 'memory.md', read: async () => '', readCognition: async () => '' } as never, timer: { set: () => 0, clear: () => {}, now: () => 10 }, now: () => 10 })
  const sending = service.peerSend({ senderSessionId: sender.run.requestedSessionId, targetSessionId: target.run.requestedSessionId, deliveryId: 'peer-during-finish', text: 'write a.txt again' })
  await atIntent
  const phaseAtAdmission = book.run(target.run.id)?.phase
  const finished = await finishWork(book, runHost, target.run.id, 'completed', 11)
  const replacement = finished.ok ? await book.reserveRun({ changeId: change.id, cwd: change.cwd, root: { workspaceRoot: change.cwd }, writeScope: { kind: 'paths', paths: [{ path: 'a.txt', type: 'file' }] }, at: 12 }) : undefined
  release()
  try {
    const sent = await sending
    expect(phaseAtAdmission).toBe('active')
    if (finished.ok) expect(relays, 'A peer admitted before stop must not execute after a completed handoff').toHaveLength(0)
    else expect(book.occupying().some(run => run.id === target.run.id)).toBe(true)
    expect(relays).toHaveLength(0)
    expect(sent).toContain('unknown')
    expect(replacement === undefined || !('ok' in replacement) || replacement.ok === false || relays.length === 0).toBe(true)
  } finally { await service.dispose() }
})
