import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { deliverPeer, guardRunWriteTool, PeerLedger, PEER_TOOL, refreshChildSeals, sealChildSession, sessionIsOwned, type PeerDeliveryDeps, type PeerTable } from './peer.ts'
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
    admit: partial.admit ?? (() => ({ ok: true })),
    hold: async () => ({ ok: true }),
    release: async () => {},
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
      admit: () => ({ ok: true }),
      hold: async () => ({ ok: true }),
      release: async () => {},
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
      admit: () => ({ ok: true }),
      hold: async () => ({ ok: true }),
      release: async () => {},
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

  it('bounces out-of-scope follow-ups idempotently to Dorothy and refuses unowned senders', async () => {
    const bounced: string[] = []
    const stored = table()
    const ledger = new PeerLedger(stored, parsePeerDelivery)
    const deps: PeerDeliveryDeps = {
      now: () => 50,
      owns: id => id === 'session-worker',
      isDorothy: id => id === 'dot-1',
      bounce: async ({ senderSessionId, deliveryId, text }) => {
        bounced.push(`${senderSessionId}:${deliveryId}:${text}`)
        return 'stored'
      },
      get: id => ledger.read(id),
      put: row => ledger.write(row),
      prove: async () => 0,
      relay: async () => {},
      admit: () => ({ ok: true }),
      hold: async () => ({ ok: true }),
      release: async () => {},
    }
    const ok1 = await ledger.run(() => deliverPeer({ action: 'bounce', senderSessionId: 'session-worker', targetSessionId: 'dorothy', deliveryId: 'b-1', text: 'out of scope' }, deps))
    expect(ok1).toContain('bounced to Dorothy')
    const ok2 = await ledger.run(() => deliverPeer({ action: 'bounce', senderSessionId: 'session-worker', targetSessionId: 'dorothy', deliveryId: 'b-1', text: 'out of scope' }, deps))
    expect(ok2).toContain('already bounced')
    expect(bounced).toEqual(['session-worker:b-1:out of scope'])

    const badSender = await ledger.run(() => deliverPeer({ action: 'bounce', senderSessionId: 'stranger', targetSessionId: 'dorothy', deliveryId: 'b-2', text: 'nope' }, deps))
    expect(badSender).toContain('nothing was sent')
    expect(bounced).toHaveLength(1)
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
  }

  it('counts sessions dot opened and not a reserved id, a watched human, or dot itself', () => {
    expect(sessionIsOwned('session-a', input)).toBe(true)
    expect(sessionIsOwned('session-started', input)).toBe(true)
    expect(sessionIsOwned('session-reserved', input)).toBe(false)
    expect(sessionIsOwned('session-watched', input)).toBe(false)
    expect(sessionIsOwned('session-dot', input)).toBe(false)
  })
})

describe('child-session seal', () => {
  it('seals late global tools under synchronous rc.3 tools/change notifications', async () => {
    const ctx = new Context()
    new SystemPrompt(ctx, {} as never)
    new ToolsService(ctx)
    const key = {}
    const scope = createScope(ctx, key)
    const refreshers = new Set<() => void>()
    const release = ctx.on('tools/change', () => refreshChildSeals(refreshers))
    const sealed = sealChildSession({ ctx: scope.ctx, session: { id: 'session-a' } }, async () => 'sent', refreshers)
    try {
      const restrict = vi.spyOn(scope.ctx.tools, 'restrict')
      ctx.tools.register(defineTool({
        name: 'subagent', description: 'late child tool', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'ok',
      }))
      expect(restrict).toHaveBeenCalledTimes(1)
      expect(ctx.tools.get('subagent', key)).toBeUndefined()
      expect(ctx.tools.get('subagent')).toBeDefined()
      expect(ctx.tools.get(PEER_TOOL, key)).toBeDefined()
    } finally { sealed.release(); release(); await scope.dispose() }
  })

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
          const row = [...filter.deny]
          denied.push(row)
          return () => { denied.splice(denied.indexOf(row), 1) }
        },
        register(definition: { name?: string; execute?: (args: unknown) => Promise<string> }) {
          registered.push(definition)
          return () => { registered.splice(registered.indexOf(definition), 1) }
        },
      },
      systemPrompt: { section() { prompts += 1; return () => { prompts -= 1 } } },
      on(_event: string, listener: (exec: { name: string }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>) {
        gates.push(listener)
        return () => { gates.splice(gates.indexOf(listener), 1) }
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
  it.each(['schemas', 'restrict', 'on', 'section', 'register'] as const)('propagates %s failure, rolls back, and permits a successful retry', method => {
    const host = agent(['subagent'])
    const refreshers = new Set<() => void>()
    const target = method === 'on' ? host.live.ctx : method === 'section' ? host.live.ctx.systemPrompt : host.live.ctx.tools
    vi.spyOn(target as never, method as never).mockImplementationOnce(() => { throw new Error('install failed') })
    expect(() => sealChildSession(host.live, async () => 'sent', refreshers)).toThrow('install failed')
    expect(refreshers.size).toBe(0)
    expect(host.registered).toHaveLength(0)
    expect(host.gates).toHaveLength(0)
    expect(host.promptCount()).toBe(0)
    expect(sealChildSession(host.live, async () => 'sent', refreshers).applied).toBe(true)
    expect(host.registered).toHaveLength(1)
    expect(host.gates).toHaveLength(1)
  })

  it('propagates a refresh failure instead of claiming the new global tool is hidden', () => {
    const host = agent(['bash'])
    const refreshers = new Set<() => void>()
    sealChildSession(host.live, async () => 'sent', refreshers)
    host.add('subagent')
    vi.spyOn(host.live.ctx.tools, 'restrict').mockImplementationOnce(() => { throw new Error('restriction failed') })
    expect(() => refreshChildSeals(refreshers)).toThrow('restriction failed')
    refreshChildSeals(refreshers)
    expect(host.denied).toEqual([['subagent']])
  })

  it.skipIf(process.platform !== 'win32' || !existsSync('C:\\PROGRA~1'))('allows writes under expanded long paths when Windows 8.3 short paths are in workspaceRoot or writeScope', () => {
    const longBase = realpathSync.native('C:\\PROGRA~1')
    const shortRoot = 'c:\\progra~1\\dot-8dot3-proj'
    const longTarget = join(longBase, 'dot-8dot3-proj', 'src', 'a.ts')
    const longOther = join(longBase, 'dot-8dot3-proj', 'src', 'other.ts')
    const longOutside = join(longBase, 'elsewhere', 'src', 'a.ts')

    const exclusiveRun = {
      id: 'run-ws',
      cwd: shortRoot,
      workspaceRoot: shortRoot,
      writeScope: { kind: 'workspace-exclusive' as const },
      access: 'write' as const,
    }
    expect(guardRunWriteTool(exclusiveRun, { name: 'write_file', input: { path: longTarget } }, 'win32')).toEqual({ allow: true })
    expect(guardRunWriteTool(exclusiveRun, { name: 'write_file', input: { path: longOutside } }, 'win32')).toMatchObject({ allow: false })

    const relPathRun = {
      id: 'run-rel',
      cwd: shortRoot,
      workspaceRoot: shortRoot,
      writeScope: { kind: 'paths' as const, paths: [{ path: 'src/a.ts', type: 'file' as const }] },
      access: 'write' as const,
    }
    expect(guardRunWriteTool(relPathRun, { name: 'edit_file', input: { file_path: longTarget } }, 'win32')).toEqual({ allow: true })
    expect(guardRunWriteTool(relPathRun, { name: 'edit_file', input: { file_path: longOther } }, 'win32')).toMatchObject({ allow: false })

    const absPathRun = {
      id: 'run-abs',
      cwd: shortRoot,
      workspaceRoot: shortRoot,
      writeScope: { kind: 'paths' as const, paths: [{ path: join(shortRoot, 'src', 'a.ts'), type: 'file' as const }] },
      access: 'write' as const,
    }
    expect(guardRunWriteTool(absPathRun, { name: 'write_file', input: { path: longTarget } }, 'win32')).toEqual({ allow: true })
    expect(guardRunWriteTool(absPathRun, { name: 'write_file', input: { path: longOther } }, 'win32')).toMatchObject({ allow: false })
  })
})
