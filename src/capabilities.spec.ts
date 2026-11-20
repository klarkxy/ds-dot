import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type CapabilityGroupView, type DotSettings } from './contracts.ts'
import { parseSettings, patchSettings, CAPABILITY_GRANTS_MAX } from './settings.ts'
import { buildCatalog, capabilitiesSignature, DotCapabilities, installToolAttribution, mcpServerOf, resolveGrants, SCOPED_COPY, type CapabilityPluginManager, type CapabilityTools, type CapabilityToolDef } from './capabilities.ts'
import { reasonBeforeDelivery } from './segments.ts'
import { gateToolExecution } from './tool-scope.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { ChatFeed } from './feed.ts'

const LOCKED = ['dot_read', 'web_search', 'show_view']

const settingsWith = (grants: Record<string, 'off' | 'ask' | 'auto'>, locks?: DotSettings['locks']): DotSettings =>
  ({ ...DEFAULT_SETTINGS, capabilities: { grants }, ...(locks ? { locks } : {}) })

describe('capabilities setting', () => {
  it('parses and patches the grants record; bad rows fall back to the default', () => {
    const parsed = parseSettings({ capabilities: { grants: { 'mcp:srv': 'auto', 'tool:x': 'ask' } } })
    expect(parsed.capabilities.grants).toEqual({ 'mcp:srv': 'auto', 'tool:x': 'ask' })
    expect(parseSettings({ capabilities: { grants: { 'mcp:srv': 'bogus' } } }).capabilities.grants).toEqual({})
    expect(parseSettings({ capabilities: 'nope' }).capabilities.grants).toEqual({})
    expect(parseSettings({}).capabilities.grants).toEqual({})
    const patched = patchSettings(settingsWith({}), { capabilities: { grants: { 'plugin:a': 'auto' } } })
    expect(patched.capabilities.grants).toEqual({ 'plugin:a': 'auto' })
    expect(() => patchSettings(settingsWith({}), { capabilities: { grants: { 'tool:x': 'later' } } })).toThrow(/invalid value/)
    const oversized = Object.fromEntries(Array.from({ length: CAPABILITY_GRANTS_MAX + 1 }, (_, i) => [`tool:t${i}`, 'auto']))
    expect(() => patchSettings(settingsWith({}), { capabilities: { grants: oversized } })).toThrow(/invalid value/)
  })
})

interface FakeTools extends CapabilityTools {
  defs: CapabilityToolDef[]
  conditional: Set<string>
}

function fakeTools(defs: readonly string[], conditional: readonly string[] = []): FakeTools {
  const rows = defs.map(name => ({ name, description: `${name} does things` }))
  const gated = new Set(conditional)
  return {
    defs: rows,
    conditional: gated,
    definitions() { return rows },
    get(name) { return rows.find(row => row.name === name) },
    executable(name) { return gated.has(name) ? undefined : rows.find(row => row.name === name) },
  }
}

function catalogInput(partial: Partial<Parameters<typeof buildCatalog>[0]> = {}) {
  return {
    defs: fakeTools(partial.defs?.map(def => def.name) ?? []).defs,
    owners: new Map<string, { entryId?: string }>(),
    servers: [] as string[],
    bundles: [] as { name: string; rows: { entryId?: string }[] }[],
    grants: {},
    locked: new Set(LOCKED),
    conditional: () => false,
    ...partial,
  }
}

describe('capability catalog', () => {
  it('matches MCP names including hashed, truncated ones', () => {
    const server = 'magpie-image'
    expect(mcpServerOf('mcp__magpie-image__generate_image', [server])).toBe(server)
    const long = 'a-very-long-server-name-that-keeps-going-and-going-yes'
    const full = `mcp__${long}__`
    const hashed = `${full.slice(0, 51)}__abcd1234`
    expect(mcpServerOf(hashed, [long])).toBe(long)
    expect(mcpServerOf('mcp__other__tool', [server])).toBeUndefined()
  })

  it('groups one bundle flat or nested by how many entries own tools', () => {
    const defs = fakeTools(['pt_a', 'pt_b', 'pt_c']).defs
    const single = buildCatalog(catalogInput({
      defs,
      owners: new Map([['pt_a', { entryId: 'e1' }]]),
      bundles: [{ name: 'plug', rows: [{ entryId: 'e1' }] }],
    }))
    const plug = single.groups.find(group => group.id === 'plugin:plug')
    expect(plug?.tools.map(tool => tool.name)).toEqual(['pt_a'])
    expect(plug?.children ?? []).toEqual([])

    const multi = buildCatalog(catalogInput({
      defs,
      owners: new Map([['pt_a', { entryId: 'e1' }], ['pt_b', { entryId: 'e2' }], ['pt_c', { entryId: 'e2' }]]),
      bundles: [{ name: 'plug', rows: [{ entryId: 'e1' }, { entryId: 'e2' }] }],
    }))
    const parent = multi.groups.find(group => group.id === 'plugin:plug')
    expect(parent?.tools).toEqual([])
    expect(parent?.children?.map(child => [child.id, child.tools.length])).toEqual([['plugin:plug#e1', 1], ['plugin:plug#e2', 2]])
  })

  it('keeps unattributed tools under host and entries without a bundle as their own plugin group', () => {
    const defs = fakeTools(['loose', 'extra_tool']).defs
    const view = buildCatalog(catalogInput({
      defs,
      owners: new Map([['extra_tool', { entryId: 'include:extra' }]]),
    }))
    expect(view.groups.find(group => group.id === 'plugin:include:extra')?.tools.map(tool => tool.name)).toEqual(['extra_tool'])
    const host = view.groups.find(group => group.id === 'host')
    expect(host?.kind).toBe('host')
    expect(host?.tools.map(tool => tool.name)).toEqual(['loose'])
  })

  it('keeps granted-but-absent selectors as missing rows', () => {
    const view = buildCatalog(catalogInput({
      grants: { 'mcp:gone': 'auto', 'plugin:gone#e9': 'ask', 'plugin:gone2': 'auto', 'tool:vanished': 'auto' },
    }))
    expect(view.groups.find(group => group.id === 'mcp:gone')?.missing).toBe(true)
    expect(view.groups.find(group => group.id === 'plugin:gone#e9')?.missing).toBe(true)
    expect(view.groups.find(group => group.id === 'plugin:gone2')?.missing).toBe(true)
    const host = view.groups.find(group => group.id === 'host')
    expect(host?.tools.some(tool => tool.name === 'vanished' && tool.missing === true)).toBe(true)
  })

  it('excludes locked names from the catalog and keeps them in the locked list', () => {
    const view = buildCatalog(catalogInput({ defs: fakeTools(['web_search', 'extra']).defs }))
    expect(view.groups.every(group => group.tools.every(tool => tool.name !== 'web_search'))).toBe(true)
    expect(view.locked).toContain('web_search')
  })
})

const groups = (list: readonly { id: string; tools: readonly string[]; children?: readonly { id: string; tools: readonly string[] }[] }): CapabilityGroupView[] =>
  list.map(group => {
    const out: CapabilityGroupView = { id: group.id, kind: 'plugin', label: group.id, tools: group.tools.map(name => ({ name, conditional: false })) }
    if (group.children) {
      return { ...out, children: group.children.map(child => ({ id: child.id, kind: 'entry' as const, label: child.id, tools: child.tools.map(name => ({ name, conditional: false })) })) }
    }
    return out
  })

describe('grant resolution', () => {
  const catalog = groups([{ id: 'plugin:p', tools: ['a'], children: [{ id: 'plugin:p#e2', tools: ['b', 'c'] }] }])
  const resolved = (grants: Record<string, 'off' | 'ask' | 'auto'>, list: CapabilityGroupView[]) =>
    [...resolveGrants(grants, list)].map(([name, row]) => [name, row.grant])

  it('lets the most specific selector win, including a child off inside an enabled group', () => {
    expect(resolved({ 'plugin:p': 'auto' }, catalog)).toEqual([['a', 'auto'], ['b', 'auto'], ['c', 'auto']])
    expect(resolved({ 'plugin:p': 'auto', 'plugin:p#e2': 'off' }, catalog)).toEqual([['a', 'auto']])
    expect(resolved({ 'plugin:p': 'auto', 'tool:b': 'ask' }, catalog)).toEqual([['a', 'auto'], ['b', 'ask'], ['c', 'auto']])
    expect(resolved({ 'plugin:p': 'auto', 'plugin:p#e2': 'ask', 'tool:c': 'off' }, catalog)).toEqual([['a', 'auto'], ['b', 'ask']])
    expect(resolved({}, catalog)).toEqual([])
  })

  it('keeps the selector chain on each resolved grant', () => {
    const [b] = [...resolveGrants({ 'plugin:p': 'auto' }, catalog)].filter(([name]) => name === 'b')
    expect(b?.[1].chain).toEqual(['tool:b', 'plugin:p#e2', 'plugin:p'])
  })

  it('ignores the host group as a grant target; its tools answer to tool: selectors only', () => {
    const loose: CapabilityGroupView = { id: 'host', kind: 'host', label: 'Unattributed', tools: [{ name: 'loose', conditional: false }] }
    expect(resolved({ host: 'auto' }, [loose])).toEqual([])
    expect(resolved({ 'tool:loose': 'ask' }, [loose])).toEqual([['loose', 'ask']])
  })

  it('changes the signature only when grants change', () => {
    expect(capabilitiesSignature(settingsWith({ 'plugin:p': 'auto' }))).not.toBe(capabilitiesSignature(settingsWith({})))
    expect(capabilitiesSignature(settingsWith({ 'plugin:p': 'auto' }))).toBe(capabilitiesSignature(settingsWith({ 'plugin:p': 'auto' })))
  })
})

describe('segment rollover', () => {
  it('asks for a new segment only after a reply once the signature moved', () => {
    const base = { replied: true, now: 0, persona: '', frozenPersona: '' }
    expect(reasonBeforeDelivery({ ...base, capabilities: '{"a":1}', frozenCapabilities: '{"a":2}' })).toBe('capabilities-changed')
    expect(reasonBeforeDelivery({ ...base, capabilities: '{"a":1}', frozenCapabilities: '{"a":1}' })).toBeUndefined()
    expect(reasonBeforeDelivery({ ...base, replied: false, capabilities: '{"a":1}', frozenCapabilities: '{"a":2}' })).toBeUndefined()
  })

  it('treats a pre-upgrade segment with no frozen signature as the empty grant map', () => {
    const base = { replied: true, now: 0, persona: '', frozenPersona: '' }
    const empty = capabilitiesSignature(settingsWith({}))
    expect(reasonBeforeDelivery({ ...base, capabilities: empty })).toBeUndefined()
    expect(reasonBeforeDelivery({ ...base, capabilities: capabilitiesSignature(settingsWith({ 'tool:x': 'auto' })) })).toBe('capabilities-changed')
  })
})

describe('tool attribution wrapper', () => {
  it('records the calling context entry and restores the method on dispose', () => {
    const calls: string[] = []
    const service = {
      register(this: unknown, def: { name: string }) { calls.push(def.name); return () => { calls.push(`drop:${def.name}`) } },
    }
    const owners = new Map<string, { entryId?: string }>()
    const undo = installToolAttribution(service, owners)
    const caller = { ctx: { fiber: { entry: { id: 'include:x' } } } }
    const dispose = service.register.call(caller as never, { name: 'tool_x' })
    expect(owners.get('tool_x')).toEqual({ entryId: 'include:x' })
    dispose()
    expect(owners.has('tool_x')).toBe(false)
    expect(calls).toEqual(['tool_x', 'drop:tool_x'])
    undo()
    service.register({ name: 'tool_y' })
    expect(owners.has('tool_y')).toBe(false)
  })

  it('does not overwrite the source owner when a marked scoped copy registers', () => {
    const service = { register(this: unknown, _def: { name: string }) { return () => {} } }
    const owners = new Map<string, { entryId?: string }>()
    const undo = installToolAttribution(service, owners)
    const pluginCaller = { ctx: { fiber: { entry: { id: 'include:x' } } } }
    const dotCaller = { ctx: { fiber: { entry: { id: 'include:ds-dot' } } } }
    service.register.call(pluginCaller as never, { name: 'tool_x' })
    const copyDispose = service.register.call(dotCaller as never, { name: 'tool_x', [SCOPED_COPY]: true })
    expect(owners.get('tool_x')).toEqual({ entryId: 'include:x' })
    copyDispose()
    expect(owners.get('tool_x')).toEqual({ entryId: 'include:x' })
    undo()
  })
})

describe('capability application', () => {
  function agentCtx(defs: CapabilityTools) {
    const listeners = new Set<() => void>()
    const registered: CapabilityToolDef[] = []
    const released: string[] = []
    const restricted: string[][] = []
    const ctx = {
      tools: {
        register(def: CapabilityToolDef) { registered.push(def); return () => released.push(def.name) },
        restrict(filter: { allow: readonly string[] }) { restricted.push([...filter.allow]); return () => restricted.push(['<released>']) },
        schemas() { return [...defs.definitions(), ...registered] },
      },
      on(_event: string, listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    }
    return { ctx, listeners, registered, released, restricted, fire: () => { for (const listener of [...listeners]) listener() } }
  }

  it('adds unconditional grants to the allow list and skips absent names', async () => {
    const tools = fakeTools(['mcp__s__a', 'cond_tool'], ['cond_tool'])
    const settings = { current: settingsWith({ 'mcp:s': 'auto', 'plugin:p': 'ask', 'tool:absent': 'auto' }) }
    const caps = new DotCapabilities({
      tools: () => tools,
      mcpManager: () => ({ list: () => [{ name: 's' }] }),
      pluginManager: () => ({ listBundles: async () => [{ name: 'p', rows: [{ entryId: 'e1' }] }] }),
      settings: () => settings.current,
      locked: LOCKED,
    })
    caps.owners.set('cond_tool', { entryId: 'e1' })
    const agent = { session: { id: 'dot-1' } }
    const env = agentCtx(tools)
    const applied = await caps.applyToAgent(env.ctx as never, agent as never)
    expect([...applied.entries()].map(([name, row]) => [name, row.grant]).sort()).toEqual([['cond_tool', 'ask'], ['mcp__s__a', 'auto']])
    // The fake scope only shows registered defs, so the locked names filter out.
    expect(env.restricted[0]).toEqual(['mcp__s__a'])
    expect(env.registered.map(row => row.name)).toEqual(['cond_tool'])
    expect((env.registered[0] as Record<symbol, unknown> | undefined)?.[SCOPED_COPY]).toBe(true)
    expect(caps.appliedFor('dot-1')?.get('cond_tool')?.grant).toBe('ask')
    expect(caps.appliedFor('dot-1')?.get('cond_tool')?.chain).toEqual(['tool:cond_tool', 'plugin:p'])

    // The copy goes away when its source definition disappears.
    tools.defs.length = 0
    env.fire()
    expect(env.released).toEqual(['cond_tool'])

    // Re-applying releases the previous restrict and copies.
    await caps.applyToAgent(env.ctx as never, agent as never)
    expect(env.restricted.at(-1)).toEqual(['<released>'])
    caps.releaseAgent('dot-1')
    expect(caps.appliedFor('dot-1')).toBeUndefined()
  })

  it('does not mark granted names the agent scope cannot show as applied', async () => {
    const tools = fakeTools(['mcp__s__a', 'hidden_tool'])
    const caps = new DotCapabilities({
      tools: () => tools,
      mcpManager: () => ({ list: () => [{ name: 's' }] }),
      pluginManager: () => ({ listBundles: async () => [] }),
      settings: () => settingsWith({ 'mcp:s': 'auto', 'tool:hidden_tool': 'auto' }),
      locked: LOCKED,
    })
    caps.owners.set('hidden_tool', {})
    // The scope's view hides the granted tool, so restrict drops it too.
    const env = agentCtx(tools)
    env.ctx.tools.schemas = () => [{ name: 'mcp__s__a' }]
    const applied = await caps.applyToAgent(env.ctx as never, { session: { id: 'dot-1' } } as never)
    expect(applied.has('mcp__s__a')).toBe(true)
    expect(applied.has('hidden_tool')).toBe(false)
    expect(caps.appliedFor('dot-1')?.has('hidden_tool')).toBe(false)
    caps.releaseAgent('dot-1')
  })

  it('reuses the bundle row mapping for 30s and refetches after tools/change invalidation', async () => {
    let calls = 0
    const caps = new DotCapabilities({
      tools: () => fakeTools(['x']),
      mcpManager: () => undefined,
      pluginManager: () => ({ listBundles: async () => { calls += 1; return [] } }),
      settings: () => settingsWith({}),
      locked: LOCKED,
    })
    await caps.catalog()
    await caps.catalog()
    expect(calls).toBe(1)
    caps.invalidateBundles()
    await caps.catalog()
    expect(calls).toBe(2)
  })

  it('reaches the raw register through the cordis.original symbol', async () => {
    const raw = { register(this: unknown, def: { name: string }) { return () => {} } }
    const proxy = { [Symbol.for('cordis.original')]: raw, register: raw.register }
    const owners = new Map<string, { entryId?: string }>()
    const undo = installToolAttribution(proxy as never, owners)
    raw.register.call({ ctx: { fiber: { entry: { id: 'e9' } } } } as never, { name: 'z' })
    expect(owners.get('z')).toEqual({ entryId: 'e9' })
    undo()
  })
})

describe('execution gate', () => {
  function gated(decideExtra?: (exec: { name: string }) => Promise<'next' | { kind: string }>) {
    let listener!: (exec: { name: string }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>
    const ctx = {
      effect(start: () => () => void) { start(); return () => {} },
      on(_event: string, fn: typeof listener) { listener = fn; return () => {} },
    }
    gateToolExecution(ctx as never, LOCKED, decideExtra as never)
    const next = () => Promise.resolve({ kind: 'allow' })
    return { run: (name: string) => listener({ name }, next) }
  }

  it('passes locked names, denies the rest, and delegates extras', async () => {
    const gate = gated()
    expect(await gate.run('dot_read')).toEqual({ kind: 'allow' })
    expect(await gate.run('mcp__s__a')).toEqual({ kind: 'deny', reason: 'This preset cannot run that tool.' })
    const extra = gated(async exec => exec.name === 'ok_tool' ? 'next' : { kind: 'deny', reason: 'no' })
    expect(await extra.run('ok_tool')).toEqual({ kind: 'allow' })
    expect(await extra.run('bad_tool')).toEqual({ kind: 'deny', reason: 'no' })
    const failing = gated(async () => { throw new Error('boom') })
    expect(await failing.run('x')).toEqual({ kind: 'deny', reason: 'This preset cannot run that tool.' })
  })
})

describe('service-level capability gate', () => {
  function serviceHarness(grants: Record<string, 'off' | 'ask' | 'auto'>, pm?: () => CapabilityPluginManager | undefined) {
    const tools = fakeTools(['extra_tool'])
    const store = new DotStore(undefined)
    void store.setSettings(settingsWith(grants))
    const caps = new DotCapabilities({
      tools: () => tools,
      mcpManager: () => undefined,
      pluginManager: pm ?? (() => ({ listBundles: async () => [] })),
      settings: () => store.settings,
      locked: LOCKED,
    })
    caps.owners.set('extra_tool', {})
    const host = {
      isRunning: () => false,
      modelKey: () => undefined,
      readEvents: async () => [],
      dotContext: async () => ({ live: true, compactions: 0 }),
      say: async () => {},
    }
    const service = new DotService({ host: host as never, store, homeDir: '/tmp/dot-cap-test', capabilities: caps })
    const apply = async () => caps.applyToAgent({
      tools: { register: () => () => {}, restrict: () => () => {}, schemas: () => [{ name: 'extra_tool' }] },
      on: () => () => {},
    } as never, { session: { id: 'dot-1' } } as never)
    return { tools, store, caps, service, apply }
  }

  it('re-resolves the live grant over the stored selector chain without touching the catalog', async () => {
    let bundleCalls = 0
    const { store, caps, service, apply } = serviceHarness({ 'plugin:p': 'auto' }, () => ({
      listBundles: async () => { bundleCalls += 1; return [{ name: 'p', rows: [{ entryId: 'e1' }] }] },
    }))
    caps.owners.set('extra_tool', { entryId: 'e1' })
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await apply()
    const before = bundleCalls
    await store.setSettings(settingsWith({ 'plugin:p': 'off', 'tool:extra_tool': 'auto' }))
    expect(await service.capabilityGate({ name: 'extra_tool' })).toBe('next')
    await store.setSettings(settingsWith({ 'plugin:p': 'auto', 'tool:extra_tool': 'off' }))
    expect(await service.capabilityGate({ name: 'extra_tool' })).toMatchObject({ kind: 'deny' })
    expect(bundleCalls).toBe(before)
  })

  it('denies ungranted and unapplied extras, passes auto, and denies after a live revoke', async () => {
    const { store, service, apply } = serviceHarness({ 'tool:extra_tool': 'auto' })
    expect(await service.capabilityGate({ name: 'extra_tool' })).toMatchObject({ kind: 'deny' })
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await apply()
    expect(await service.capabilityGate({ name: 'extra_tool' })).toBe('next')
    // Mid-segment revocation denies at once even though the applied set is frozen.
    await store.setSettings(settingsWith({ 'tool:extra_tool': 'off' }))
    expect(await service.capabilityGate({ name: 'extra_tool' })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('off') })
    expect(await service.capabilityGate({ name: 'other_tool' })).toMatchObject({ kind: 'deny' })
  })

  it('holds an ask call for a human card, passes on approve, denies on reject and abort, and dot cannot settle it', async () => {
    const { store, service, apply } = serviceHarness({ 'tool:extra_tool': 'ask' })
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await apply()

    const controller = new AbortController()
    const pending = service.capabilityGate({ name: 'extra_tool', arguments: { a: 1 }, signal: controller.signal })
    await new Promise(resolve => setImmediate(resolve))
    const request = service.pending.list().find(row => row.kind === 'approval')
    expect(request?.sessionId).toBe('dot-1')
    expect(request?.humanRequired).toBe(true)
    // dot herself cannot settle a human-required approval.
    expect(() => service.answer(request!.id, { kind: 'approval', allow: true })).toThrow(/human/)
    const card = store.cards.find(row => row.approvalId === request!.id)
    expect(card?.callId).toBe(`capability:${request!.id}`)
    await service.answerCard(card!.id, 'approval', { confirmed: true })
    await expect(pending).resolves.toBe('next')

    const rejected = service.capabilityGate({ name: 'extra_tool' })
    await new Promise(resolve => setImmediate(resolve))
    const next = service.pending.list().find(row => row.kind === 'approval')
    const rejectedCard = store.cards.find(row => row.approvalId === next!.id)
    await service.answerCard(rejectedCard!.id, 'approval', { confirmed: false })
    await expect(rejected).resolves.toMatchObject({ kind: 'deny' })

    const aborted = service.capabilityGate({ name: 'extra_tool', signal: controller.signal })
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    await expect(aborted).resolves.toMatchObject({ kind: 'deny' })
    const deadCard = store.cards.find(row => row.callId.startsWith('capability:') && !row.answer && row.expired)
    expect(deadCard).toBeDefined()
  })

  it('proposes grant changes through the settings flow and refuses locked shapes', async () => {
    const { store, service, apply } = serviceHarness({})
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await apply()
    await expect(service.proposeCapability({ selector: 'junk', grant: 'auto', reason: 'why' })).rejects.toThrow(/selector/)
    await expect(service.proposeCapability({ selector: 'host', grant: 'auto', reason: 'why' })).rejects.toThrow(/host-wide|per-tool/)
    await expect(service.proposeCapability({ selector: 'tool:web_search', grant: 'auto', reason: 'why' })).rejects.toThrow(/locked/)
    const message = await service.proposeCapability({ selector: 'tool:future_tool', grant: 'ask', reason: 'I need it' })
    expect(message).toContain('Proposal')
    const proposal = store.settingProposals[0]
    expect(proposal?.field).toBe('capabilities')
    // decideNow awaits settingsChanged(), which re-enters the serial lane a
    // decide call already holds; the live-apply hook is stubbed here so the
    // test stays on the grant write (pre-existing lane re-entry, not the
    // capability path).
    service.settingsChanged = async () => {}
    const decided = await service.selfSettings.decide(proposal!.id, true)
    expect(decided).toContain('Approved')
    expect(store.settings.capabilities.grants).toEqual({ 'tool:future_tool': 'ask' })
    // A locked capabilities field refuses proposals.
    await store.setSettings({ ...store.settings, locks: { capabilities: true } })
    await expect(service.proposeCapability({ selector: 'tool:x', grant: 'auto', reason: 'why' })).rejects.toThrow(/locked/)
  })

  it('lists the catalog as a compact tree', async () => {
    const { service, apply } = serviceHarness({ 'tool:extra_tool': 'auto' })
    await store0(service)
    await apply()
    const text = await service.listCapabilities()
    expect(text).toContain('extra_tool')
    expect(text).toContain('per-tool grants only')
    expect(text).toContain('applied=auto')
  })
})

async function store0(service: DotService): Promise<void> {
  const store = (service as unknown as { store: DotStore }).store
  await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
}

describe('propose_install', () => {
  const pm = (over: Partial<CapabilityPluginManager> = {}): CapabilityPluginManager => ({
    listBundles: async () => [],
    inspect: async () => ({ status: 'accepted', name: 'dsh-x', version: '1.2.3', description: 'X plugin', bundle: true }),
    installBundle: async () => ({ changed: true, application: 'applied', bundle: 'dsh-x', version: '1.2.3' }),
    ...over,
  })
  const harness = (manager?: CapabilityPluginManager) => {
    const tools = fakeTools(['extra_tool'])
    const store = new DotStore(undefined)
    void store.setSettings(settingsWith({}))
    const caps = new DotCapabilities({
      tools: () => tools,
      mcpManager: () => undefined,
      pluginManager: () => manager,
      settings: () => store.settings,
      locked: LOCKED,
    })
    const service = new DotService({
      host: { isRunning: () => false, modelKey: () => undefined, readEvents: async () => [], dotContext: async () => ({ live: true, compactions: 0 }), say: async () => {} } as never,
      store, homeDir: '/tmp/dot-cap-test', capabilities: caps,
    })
    const notes: string[] = []
    const original = service.notify.bind(service)
    service.notify = (notice, urgent) => { notes.push(notice.text); original(notice, urgent) }
    return { store, service, notes }
  }
  const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)) }

  it('refuses when the manager is missing, inspection refuses, the bundle is installed, or the row is protected', async () => {
    const none = harness()
    await store0(none.service)
    await expect(none.service.proposeInstall({ spec: 'dsh-x', version: '1.2.3', reason: 'r' })).rejects.toThrow(/cannot install plugins/)

    const refused = harness(pm({ inspect: async () => ({ status: 'refused', problem: 'not-found', reason: 'no such package' }) }))
    await store0(refused.service)
    await expect(refused.service.proposeInstall({ spec: 'dsh-x', version: '1.2.3', reason: 'r' })).rejects.toThrow(/not-found/)

    const installed = harness(pm({ listBundles: async () => [{ name: 'dsh-x', installed: true, rows: [] }] }))
    await store0(installed.service)
    await expect(installed.service.proposeInstall({ spec: 'dsh-x', version: '1.2.3', reason: 'r' })).rejects.toThrow(/already installed/)

    const official = harness(pm({ listBundles: async () => [{ name: 'dsh-x', official: true, rows: [] }] }))
    await store0(official.service)
    await expect(official.service.proposeInstall({ spec: 'dsh-x', version: '1.2.3', reason: 'r' })).rejects.toThrow(/protected/)

    const bad = harness(pm())
    await store0(bad.service)
    await expect(bad.service.proposeInstall({ spec: 'https://x', version: '1.2.3', reason: 'r' })).rejects.toThrow(/npm package name/)
    await expect(bad.service.proposeInstall({ spec: 'dsh-x', version: 'latest', reason: 'r' })).rejects.toThrow(/exact/)
  })

  it('installs on a human approve with the pinned spec, notifies dot, and refuses dot answering', async () => {
    const installs: { spec: string; options?: { expected?: unknown; requestId?: string; enabled?: boolean } }[] = []
    const { store, service, notes } = harness(pm({ installBundle: async (spec, options) => { installs.push({ spec, options }); return { changed: true, application: 'applied', bundle: 'dsh-x', version: '1.2.3' } } }))
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    const message = await service.proposeInstall({ spec: 'dsh-x', version: '1.2.3', reason: 'I need x' })
    expect(message).toContain('waiting')
    const request = service.pending.list().find(row => row.kind === 'approval')
    expect(request?.humanRequired).toBe(true)
    expect(request?.subject).toBe('dsh-x@1.2.3')
    const card = store.cards.find(row => row.approvalId === request!.id)
    expect(card?.callId).toBe(`install:${request!.id}`)
    expect(() => service.answer(request!.id, { kind: 'approval', allow: true })).toThrow(/human/)
    await service.answerCard(card!.id, 'approval', { confirmed: true })
    await tick()
    expect(installs).toHaveLength(1)
    expect(installs[0]!.spec).toBe('dsh-x@1.2.3')
    expect(installs[0]!.options?.expected).toEqual({ name: 'dsh-x', version: '1.2.3' })
    expect(installs[0]!.options?.requestId).toBe(request!.id)
    expect(installs[0]!.options?.enabled).toBe(true)
    expect(notes.some(text => text.includes('Installed dsh-x@1.2.3'))).toBe(true)
  })

  it('notifies a decline and reports install failures without installing on reject', async () => {
    const installs: string[] = []
    const { store, service, notes } = harness(pm({ installBundle: async (spec) => { installs.push(spec); return { changed: true, application: 'applied' } } }))
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await service.proposeInstall({ spec: 'dsh-x', version: '1.2.3', reason: 'r' })
    const card = store.cards.find(row => row.callId.startsWith('install:'))
    await service.answerCard(card!.id, 'approval', { confirmed: false })
    await tick()
    expect(installs).toHaveLength(0)
    expect(notes.some(text => text.includes('declined installing dsh-x@1.2.3'))).toBe(true)
  })

  it('reports a failed install and never installs after a restart', async () => {
    const installs: string[] = []
    const { store, service, notes } = harness(pm({ installBundle: async (spec) => { installs.push(spec); return { changed: false, application: 'failed', error: { code: 'incompatible-version', diagnostic: 'needs newer dsh' } } } }))
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await service.proposeInstall({ spec: 'dsh-x', version: '1.2.3', reason: 'r' })
    const card = store.cards.find(row => row.callId.startsWith('install:'))
    await service.answerCard(card!.id, 'approval', { confirmed: true })
    await tick()
    expect(installs).toHaveLength(1)
    expect(notes.some(text => text.includes('incompatible-version'))).toBe(true)

    // A fresh service over the same store has no pending request: the card cannot install anything.
    const { service: restarted } = harness(pm({ installBundle: async (spec) => { installs.push(spec); return { changed: true, application: 'applied' } } }))
    await expect(restarted.answerCard(card!.id, 'approval', { confirmed: true })).rejects.toThrow()
    await tick()
    expect(installs).toHaveLength(1)
  })
})

describe('capability card ordering', () => {
  it('places card rows where they were shown in the segment', async () => {
    const store = new DotStore(undefined)
    await store.addCard({ id: 'c1', number: 1, sessionId: 's1', callId: 'capability:a', title: 't', view: { type: 'stack', children: [] }, expired: false, shownAt: 200 })
    await store.addCard({ id: 'c2', number: 2, sessionId: 's1', callId: 'capability:b', title: 't', view: { type: 'stack', children: [] }, expired: false, shownAt: 100 })
    await store.addCard({ id: 'c3', number: 3, sessionId: 's1', callId: 'capability:c', title: 't', view: { type: 'stack', children: [] }, expired: false })
    const host = { isRunning: () => false, dotEvents: () => [], readEvents: async () => [] }
    const feed = new ChatFeed(host as never, store)
    feed.attach('s1')
    const rows = feed.snapshot()!.items.filter(item => item.kind === 'view')
    expect(rows.map(row => row.key)).toEqual(['capability:b', 'capability:a', 'capability:c'])
    expect(rows.map(row => row.at)).toEqual([100, 200, Number.MAX_SAFE_INTEGER])
  })
})
