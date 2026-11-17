import { describe, expect, it } from 'vitest'
import { deliverPeer, PeerLedger, PEER_TOOL, refreshChildSeals, sealChildSession, sessionIsOwned, type PeerDeliveryDeps, type PeerTable } from './peer.ts'
import { parsePeerDelivery, type PeerDelivery } from './storage.ts'

function table(): PeerTable & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>()
  return {
    rows,
    get: key => rows.get(key),
    put: async (key, value) => { rows.set(key, value) },
    entries: () => rows.entries(),
  }
}

function harness(partial: {
  owns?: (id: string) => boolean
  prove?: PeerDeliveryDeps['prove']
  relay?: PeerDeliveryDeps['relay']
  admit?: PeerDeliveryDeps['admit']
  now?: number
} = {}) {
  const stored = table()
  const ledger = new PeerLedger(stored, parsePeerDelivery)
  const relays: string[] = []
  let now = partial.now ?? 10
  const deps: PeerDeliveryDeps = {
    now: () => now,
    owns: partial.owns ?? (id => id === 'session-a' || id === 'session-b'),
    get: id => ledger.read(id),
    put: row => ledger.write(row),
    prove: partial.prove ?? (async () => 0),
    relay: partial.relay ?? (async (target, sender, text, deliveryId) => { relays.push(`${sender}->${target}:${deliveryId}:${text}`) }),
    ...(partial.admit ? { admit: partial.admit } : {}),
  }
  return {
    relays,
    stored,
    setNow: (value: number) => { now = value },
    send: (input: { senderSessionId?: string; targetSessionId?: string; deliveryId?: string; text?: string }) => ledger.run(() => deliverPeer({
      senderSessionId: input.senderSessionId ?? 'session-a',
      targetSessionId: input.targetSessionId ?? 'session-b',
      deliveryId: input.deliveryId ?? 'peer-1',
      text: input.text ?? 'hello',
    }, deps)),
    row: (id = 'peer-1') => stored.rows.get(id) as PeerDelivery | undefined,
  }
}

describe('peer delivery', () => {
  it('does not follow up when the target run is closed, and still follows up when it is open', async () => {
    const closed = harness({ admit: () => ({ ok: false, message: 'run-1 is completed; nothing was sent.' }) })
    expect(await closed.send({})).toContain('completed')
    expect(closed.relays).toEqual([])
    expect(closed.row()).toBeUndefined()
    let inserts = 0
    const open = harness({
      admit: () => ({ ok: true }),
      prove: async () => inserts,
      relay: async () => { inserts = 1 },
    })
    expect(await open.send({})).toContain('accepted')
    expect(inserts).toBe(1)
  })

  it('refuses a session dot did not open and does not follow up', async () => {
    const seen = harness({ owns: id => id === 'session-a' })
    const result = await seen.send({ targetSessionId: 'human-session' })
    expect(result).toContain('nothing was sent')
    expect(seen.relays).toEqual([])
    expect(seen.row()).toBeUndefined()
  })

  it('follows up once, then a repeat does not follow up again', async () => {
    let inserts = 0
    const seen = harness({
      prove: async () => inserts,
      relay: async (target, sender, text, deliveryId) => { inserts = 1; seen.relays.push(`${deliveryId}`) },
    })
    expect(await seen.send({})).toContain('accepted')
    expect(await seen.send({})).toContain('already landed')
    expect(seen.relays).toEqual(['peer-1'])
    expect(seen.row()?.status).toBe('accepted')
  })

  it('does not resend an unknown delivery, including after the ledger is reopened', async () => {
    const seen = harness({ prove: async () => undefined, relay: async () => { throw new Error('socket dropped') } })
    expect(await seen.send({})).toContain('unknown')
    expect(seen.relays).toEqual([])
    expect(seen.row()?.status).toBe('unknown')
    const reopened = new PeerLedger(seen.stored, parsePeerDelivery)
    let relays = 0
    const again = await reopened.run(() => deliverPeer({
      senderSessionId: 'session-a', targetSessionId: 'session-b', deliveryId: 'peer-1', text: 'hello',
    }, {
      now: () => 20,
      owns: id => id === 'session-a' || id === 'session-b',
      get: id => reopened.read(id),
      put: row => reopened.write(row),
      prove: async () => 1,
      relay: async () => { relays += 1 },
    }))
    expect(again).toContain('already landed')
    expect(relays).toBe(0)
    expect(reopened.read('peer-1')?.status).toBe('accepted')
  })

  it('keeps an unproved attempt unknown across a restart and does not follow up', async () => {
    let proved = 0
    const seen = harness({
      prove: async () => proved,
      relay: async () => { throw new Error('socket dropped') },
    })
    expect(await seen.send({})).toContain('unknown')
    const reopened = new PeerLedger(seen.stored, parsePeerDelivery)
    let relays = 0
    const again = await reopened.run(() => deliverPeer({
      senderSessionId: 'session-a', targetSessionId: 'session-b', deliveryId: 'peer-1', text: 'hello',
    }, {
      now: () => 30,
      owns: () => true,
      get: id => reopened.read(id),
      put: row => reopened.write(row),
      prove: async () => 0,
      relay: async () => { relays += 1 },
    }))
    expect(again).toContain('not resent')
    expect(relays).toBe(0)
    expect(reopened.read('peer-1')?.status).toBe('unknown')
  })
})

describe('owned sessions', () => {
  const input = {
    dotSessionId: 'session-dot',
    runs: [
      { requestedSessionId: 'session-reserved', creation: 'intent' },
      { sessionId: 'session-a', requestedSessionId: 'session-a', creation: 'confirmed' },
    ],
    tasks: [{ sessionId: 'session-watched', origin: 'watched' }, { sessionId: 'session-started', origin: 'started' }, { sessionId: 'session-dot', origin: 'started' }],
    tickets: [{ sessions: [{ sessionId: 'session-ticket' }] }],
  }

  it('counts sessions dot opened and not a reserved id, a watched human, or dot itself', () => {
    expect(sessionIsOwned('session-a', input)).toBe(true)
    expect(sessionIsOwned('session-started', input)).toBe(true)
    expect(sessionIsOwned('session-ticket', input)).toBe(true)
    expect(sessionIsOwned('session-reserved', input)).toBe(false)
    expect(sessionIsOwned('session-watched', input)).toBe(false)
    expect(sessionIsOwned('session-dot', input)).toBe(false)
  })
})

describe('child-session seal', () => {
  function agent(initial: string[]) {
    const names = [...initial]
    const denied: string[][] = []
    const registered: { name?: string; execute?: (args: unknown) => Promise<string> }[] = []
    const gates: Array<(exec: { name: string }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>> = []
    let prompts = 0
    const ctx = {
      tools: {
        schemas: () => names.map(name => ({ name })),
        restrict(filter: { deny: readonly string[] }) {
          const unknown = filter.deny.filter(name => !names.includes(name))
          if (unknown.length > 0) throw new Error(`unknown ${unknown.join(',')}`)
          denied.push([...filter.deny])
          return () => {}
        },
        register(definition: { name?: string; execute?: (args: unknown) => Promise<string> }) {
          registered.push(definition)
          return () => {}
        },
      },
      systemPrompt: { section() { prompts += 1; return () => {} } },
      on(_event: string, listener: (exec: { name: string }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>) {
        gates.push(listener)
        return () => {}
      },
    }
    const live = { session: { id: 'session-a' }, ctx }
    return {
      live,
      denied,
      registered,
      gates,
      promptCount: () => prompts,
      add(name: string) { names.push(name) },
    }
  }

  it('denies only registered child-session tools, rejects a call, and registers dot_peer once', async () => {
    const host = agent(['bash', 'subagent', 'not-registered-here'])
    const refreshers = new Set<() => void>()
    const sealed = sealChildSession(host.live, async () => 'sent', refreshers)
    expect(host.denied).toEqual([['subagent']])
    expect(host.registered.map(tool => tool.name)).toEqual([PEER_TOOL])
    expect(host.promptCount()).toBe(1)
    const allowed = await host.gates[0]!({ name: 'bash' }, async () => ({ kind: 'allow' }))
    expect(allowed).toEqual({ kind: 'allow' })
    const denied = await host.gates[0]!({ name: 'subagent_fork' }, async () => { throw new Error('should not run') })
    expect(denied.kind).toBe('deny')
    host.add('team_task_create')
    refreshChildSeals(refreshers)
    expect(host.denied[1]).toEqual(['team_task_create'])
    expect(sealChildSession(host.live, async () => 'sent', refreshers).applied).toBe(false)
    expect(host.registered).toHaveLength(1)
    const sent = await host.registered[0]!.execute?.({ target_session_id: 'session-b', delivery_id: 'peer-1', text: 'hello' })
    expect(sent).toBe('sent')
    sealed.release()
    expect(refreshers.size).toBe(0)
  })

  it('does not pass an unknown child-session name to restrict', () => {
    const host = agent(['bash'])
    const refreshers = new Set<() => void>()
    const sealed = sealChildSession(host.live, async () => 'sent', refreshers)
    expect(host.denied).toEqual([])
    sealed.release()
    expect(refreshers.size).toBe(0)
  })
})
