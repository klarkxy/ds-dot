import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type CapabilityGroupView, type DotSettings } from './contracts.ts'
import { parseSettings, patchSettings, CAPABILITY_GRANTS_MAX } from './settings.ts'
import { buildCatalog, capabilitiesSignature, DotCapabilities, HIGH_RISK_TOOLS, hostScheduleTargetsDot, installToolAttribution, mcpServerOf, resolveGrants, SCOPED_COPY, type CapabilityPluginManager, type CapabilityTools, type CapabilityToolDef } from './capabilities.ts'
import { sharedAttribution } from './attribution.ts'
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

  it('keeps the entry selector for a single tool-owning entry that carries an explicit grant', () => {
    const defs = fakeTools(['pt_a']).defs
    const input = {
      defs,
      owners: new Map([['pt_a', { entryId: 'e1' }]]),
      bundles: [{ name: 'plug', rows: [{ entryId: 'e1' }] }],
    }
    const view = buildCatalog(catalogInput({ ...input, grants: { 'plugin:plug': 'auto', 'plugin:plug#e1': 'off' } }))
    const plug = view.groups.find(group => group.id === 'plugin:plug')
    expect(plug?.tools).toEqual([])
    const entry = plug?.children?.find(child => child.id === 'plugin:plug#e1')
    expect(entry?.tools.map(tool => tool.name)).toEqual(['pt_a'])

    // The entry selector sits between the tool and bundle in the chain, so an
    // explicit entry grant overrides the bundle grant instead of being lost.
    expect([...resolveGrants({ 'plugin:plug': 'auto', 'plugin:plug#e1': 'off' }, view.groups)]).toEqual([])
    const asked = [...resolveGrants({ 'plugin:plug': 'auto', 'plugin:plug#e1': 'ask' }, view.groups)]
    expect(asked.map(([name, row]) => [name, row.grant])).toEqual([['pt_a', 'ask']])
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

  it('nests unattributed tools sharing a name segment under a grantable prefix group', () => {
    const defs = fakeTools(['team_task_create', 'team_task_list', 'dot-x', 'dot.y', 'apply_patch', 'solo', 'mcp__s__tool', 'owned_tool']).defs
    const view = buildCatalog(catalogInput({
      defs,
      servers: ['s'],
      owners: new Map([['owned_tool', { entryId: 'e1' }]]),
      bundles: [{ name: 'p', rows: [{ entryId: 'e1' }] }],
    }))
    const host = view.groups.find(group => group.id === 'host')
    const team = host?.children?.find(child => child.id === 'prefix:team')
    expect(team?.kind).toBe('prefix')
    expect(team?.label).toBe('team_*')
    expect(team?.tools.map(tool => tool.name)).toEqual(['team_task_create', 'team_task_list'])
    const dot = host?.children?.find(child => child.id === 'prefix:dot')
    expect(dot?.tools.map(tool => tool.name)).toEqual(['dot-x', 'dot.y'])
    // Singletons stay flat; MCP and attributed tools never enter host or its prefix groups.
    expect(host?.tools.map(tool => tool.name).sort()).toEqual(['apply_patch', 'solo'])
    expect(view.groups.find(group => group.id === 'mcp:s')?.tools.map(tool => tool.name)).toEqual(['mcp__s__tool'])
    expect(view.groups.find(group => group.id === 'plugin:p')?.tools.map(tool => tool.name)).toEqual(['owned_tool'])
  })

  it('marks high-risk tools and bubbles the flag onto their groups', () => {
    const defs = fakeTools(['bash', 'plugin_manager', 'plugin_market', 'plain_tool']).defs
    const view = buildCatalog(catalogInput({
      defs,
      owners: new Map([['bash', { entryId: 'e1' }]]),
      bundles: [{ name: 'p', rows: [{ entryId: 'e1' }] }],
    }))
    const plug = view.groups.find(group => group.id === 'plugin:p')
    expect(plug?.tools[0]?.highRisk).toBe(true)
    expect(plug?.highRisk).toBe(true)
    const host = view.groups.find(group => group.id === 'host')
    const prefix = host?.children?.find(child => child.id === 'prefix:plugin')
    expect(prefix?.highRisk).toBe(true)
    expect(prefix?.tools.find(tool => tool.name === 'plugin_manager')?.highRisk).toBe(true)
    expect(prefix?.tools.find(tool => tool.name === 'plugin_market')?.highRisk).toBeUndefined()
    expect(host?.tools.find(tool => tool.name === 'plain_tool')?.highRisk).toBeUndefined()
    expect(HIGH_RISK_TOOLS.has('apply_patch')).toBe(true)
  })

  it('keeps granted-but-absent selectors as missing rows', () => {
    const view = buildCatalog(catalogInput({
      grants: { 'mcp:gone': 'auto', 'plugin:gone#e9': 'ask', 'plugin:gone2': 'auto', 'prefix:gone': 'auto', 'tool:vanished': 'auto' },
    }))
    expect(view.groups.find(group => group.id === 'mcp:gone')?.missing).toBe(true)
    expect(view.groups.find(group => group.id === 'plugin:gone#e9')?.missing).toBe(true)
    expect(view.groups.find(group => group.id === 'plugin:gone2')?.missing).toBe(true)
    expect(view.groups.find(group => group.id === 'prefix:gone')?.missing).toBe(true)
    const host = view.groups.find(group => group.id === 'host')
    expect(host?.tools.some(tool => tool.name === 'vanished' && tool.missing === true)).toBe(true)
  })

  it('excludes locked names from the catalog and keeps them in the locked list', () => {
    const view = buildCatalog(catalogInput({ defs: fakeTools(['web_search', 'extra']).defs }))
    expect(view.groups.every(group => group.tools.every(tool => tool.name !== 'web_search'))).toBe(true)
    expect(view.locked).toContain('web_search')
  })
})

describe('host schedule delivery target', () => {
  it('treats this_session and Dorothy session ids as self-delivery', () => {
    const ids = new Set(['dot-1', 'dot-old'])
    expect(hostScheduleTargetsDot({ target: 'this_session' }, ids)).toBe(true)
    expect(hostScheduleTargetsDot({ target: '  this_session  ' }, ids)).toBe(true)
    expect(hostScheduleTargetsDot({ target: 'dot-1' }, ids)).toBe(true)
    expect(hostScheduleTargetsDot({ target: 'dot-old' }, ids)).toBe(true)
    expect(hostScheduleTargetsDot(JSON.stringify({ target: 'this_session' }), ids)).toBe(true)
    expect(hostScheduleTargetsDot({ target: 'new_once' }, ids)).toBe(false)
    expect(hostScheduleTargetsDot({ target: 'new' }, ids)).toBe(false)
    expect(hostScheduleTargetsDot({ target: 'session-other' }, ids)).toBe(false)
    expect(hostScheduleTargetsDot({ title: 't' }, ids)).toBe(false)
    expect(hostScheduleTargetsDot(undefined, ids)).toBe(false)
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

  it('resolves prefix grants only for unattributed tools in that prefix group', () => {
    const host: CapabilityGroupView = {
      id: 'host', kind: 'host', label: 'Unattributed',
      tools: [{ name: 'solo', conditional: false }],
      children: [{ id: 'prefix:team', kind: 'prefix', label: 'team_*', tools: [{ name: 'team_a', conditional: false }, { name: 'team_b', conditional: false }] }],
    }
    expect(resolved({ 'prefix:team': 'auto' }, [host])).toEqual([['team_a', 'auto'], ['team_b', 'auto']])
    expect(resolved({ 'prefix:team': 'auto', 'tool:team_b': 'ask' }, [host])).toEqual([['team_a', 'auto'], ['team_b', 'ask']])
    const chain = [...resolveGrants({ 'prefix:team': 'auto' }, [host])].find(([name]) => name === 'team_a')?.[1].chain
    expect(chain).toEqual(['tool:team_a', 'prefix:team'])
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

  it('keeps one wrapper through the shared flag whichever row installs it', () => {
    const calls: string[] = []
    const service = { register(this: unknown, def: { name: string }) { calls.push(def.name); return () => {} } }
    const shared = sharedAttribution()
    const caps = new DotCapabilities({
      tools: () => service as never,
      mcpManager: () => undefined,
      pluginManager: () => undefined,
      settings: () => settingsWith({}),
      locked: LOCKED,
    })
    try {
      // An early attribution row already wrapped register: the fallback backs off.
      shared.wrapped = true
      const noop = caps.installAttribution()
      service.register({ name: 'skipped' })
      expect(shared.owners.has('skipped')).toBe(false)
      noop()
      expect(shared.wrapped).toBe(true)
      // No row active: the fallback wraps and releases the flag on dispose.
      shared.wrapped = false
      const undo = caps.installAttribution()
      service.register.call({ ctx: { fiber: { entry: { id: 'e1' } } } } as never, { name: 'seen' })
      expect(shared.owners.get('seen')).toEqual({ entryId: 'e1' })
      undo()
      expect(shared.wrapped).toBe(false)
      expect(service.register({ name: 'late' })).toBeDefined()
      expect(shared.owners.has('late')).toBe(false)
    } finally {
      shared.wrapped = false
      shared.owners.clear()
    }
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
    // Live restrict layers intersect: a global name is visible only while
    // every live restrict's allow list contains it. Scoped registrations stay.
    const restricts: ReadonlySet<string>[] = []
    const ctx = {
      tools: {
        register(def: CapabilityToolDef) {
          if (registered.some(row => row.name === def.name)) throw new Error(`duplicate tool "${def.name}" in scope`)
          registered.push(def)
          return () => {
            const index = registered.indexOf(def)
            if (index >= 0) registered.splice(index, 1)
            released.push(def.name)
          }
        },
        restrict(filter: { allow: readonly string[] }) {
          restricted.push([...filter.allow])
          const live = new Set(filter.allow)
          restricts.push(live)
          return () => {
            const index = restricts.indexOf(live)
            if (index >= 0) restricts.splice(index, 1)
            restricted.push(['<released>'])
          }
        },
        schemas() {
          const globals = defs.definitions().filter(row => restricts.every(allow => allow.has(row.name)))
          return [...globals, ...registered]
        },
      },
      on(_event: string, listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    }
    return { ctx, listeners, registered, released, restricted, restricts, fire: () => { for (const listener of [...listeners]) listener() } }
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

    // Re-applying releases the previous restrict and copies first, then
    // installs the fresh mask (defs are empty here, so the allow list is too).
    await caps.applyToAgent(env.ctx as never, agent as never)
    expect(env.restricted.at(-2)).toEqual(['<released>'])
    expect(env.restricted.at(-1)).toEqual([])
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

  it('re-applies a grant change in place: an off→auto plain tool becomes visible and applied', async () => {
    const tools = fakeTools(['mcp__s__a'])
    const settings = { current: settingsWith({}) }
    const caps = new DotCapabilities({
      tools: () => tools,
      mcpManager: () => ({ list: () => [{ name: 's' }] }),
      pluginManager: () => ({ listBundles: async () => [] }),
      settings: () => settings.current,
      locked: LOCKED,
    })
    const agent = { session: { id: 'dot-1' } }
    const env = agentCtx(tools)
    const first = await caps.applyToAgent(env.ctx as never, agent as never)
    expect(first.size).toBe(0)
    expect(env.ctx.tools.schemas().map(row => row.name)).toEqual([])

    // An untouched segment takes the grant change in place: the previous
    // restrict must lift before the new mask reads the scope.
    settings.current = settingsWith({ 'mcp:s': 'auto' })
    const second = await caps.applyToAgent(env.ctx as never, agent as never)
    expect(second.get('mcp__s__a')?.grant).toBe('auto')
    expect(env.ctx.tools.schemas().map(row => row.name)).toEqual(['mcp__s__a'])
    expect(caps.appliedFor('dot-1')?.get('mcp__s__a')?.grant).toBe('auto')
  })

  it('re-applies a conditional grant in place: the scoped copy re-registers and stays applied', async () => {
    const tools = fakeTools(['cond_tool'], ['cond_tool'])
    const caps = new DotCapabilities({
      tools: () => tools,
      mcpManager: () => undefined,
      pluginManager: () => ({ listBundles: async () => [] }),
      settings: () => settingsWith({ 'tool:cond_tool': 'auto' }),
      locked: LOCKED,
    })
    caps.owners.set('cond_tool', {})
    const agent = { session: { id: 'dot-1' } }
    const env = agentCtx(tools)
    await caps.applyToAgent(env.ctx as never, agent as never)
    expect(env.registered.map(row => row.name)).toEqual(['cond_tool'])

    const second = await caps.applyToAgent(env.ctx as never, agent as never)
    expect(second.get('cond_tool')?.grant).toBe('auto')
    // The first copy was released and exactly one copy lives now.
    expect(env.released).toEqual(['cond_tool'])
    expect(env.registered.map(row => row.name)).toEqual(['cond_tool'])
    expect(env.ctx.tools.schemas().map(row => row.name)).toEqual(['cond_tool'])
    expect(caps.appliedFor('dot-1')?.get('cond_tool')?.grant).toBe('auto')
  })

  it('falls back to the locked allow list when an apply throws partway', async () => {
    const tools = fakeTools(['dot_read', 'cond_tool'], ['cond_tool'])
    const caps = new DotCapabilities({
      tools: () => tools,
      mcpManager: () => undefined,
      pluginManager: () => ({ listBundles: async () => [] }),
      settings: () => settingsWith({ 'tool:cond_tool': 'auto' }),
      locked: LOCKED,
    })
    caps.owners.set('cond_tool', {})
    const agent = { session: { id: 'dot-1' } }
    const env = agentCtx(tools)
    // The copy registers fine; installing the mask then throws.
    let failRestrict = true
    const baseRestrict = env.ctx.tools.restrict.bind(env.ctx.tools)
    env.ctx.tools.restrict = (filter: { allow: readonly string[] }) => {
      if (failRestrict) { failRestrict = false; throw new Error('scope rejected the mask') }
      return baseRestrict(filter)
    }
    const applied = await caps.applyToAgent(env.ctx as never, agent as never)
    expect(applied.size).toBe(0)
    expect(caps.appliedFor('dot-1')?.size).toBe(0)
    // Nothing acquired leaks: the copy is disposed and only the locked mask lives.
    expect(env.released).toEqual(['cond_tool'])
    expect(env.restricted.at(-1)).toEqual(['dot_read'])
    expect(env.ctx.tools.schemas().map(row => row.name)).toEqual(['dot_read'])
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
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(2)
  })

  it('applies a plugin:<bundle> grant after invalidate before the background tick when entryId differs', async () => {
    const tools = fakeTools(['report_tool'])
    let rows: { name: string; rows: { entryId?: string }[] }[] = [{ name: 'dsh-reports', rows: [{ entryId: 'include:reports' }] }]
    const make = () => new DotCapabilities({
      tools: () => tools,
      mcpManager: () => undefined,
      pluginManager: () => ({ listBundles: async () => rows }),
      settings: () => settingsWith({ 'plugin:dsh-reports': 'auto' }),
      locked: LOCKED,
    })
    const apply = async (caps: DotCapabilities) => {
      const env = agentCtx(tools)
      const applied = await caps.applyToAgent(env.ctx as never, { session: { id: 'dot' } } as never)
      caps.releaseAll()
      return applied
    }

    // Empty cache: apply awaits the first scan even when owners use a different entryId.
    const empty = make()
    empty.owners.set('report_tool', { entryId: 'include:reports' })
    const fromEmpty = await apply(empty)
    expect(fromEmpty.get('report_tool')?.grant).toBe('auto')
    expect(fromEmpty.get('report_tool')?.chain).toEqual(['tool:report_tool', 'plugin:dsh-reports'])

    // Stale cache after invalidate: catalog would SWR the empty mapping and miss
    // plugin:dsh-reports; applyToAgent must await the refresh instead of the tick.
    rows = []
    const stale = make()
    stale.owners.set('report_tool', { entryId: 'include:reports' })
    await stale.catalog()
    rows = [{ name: 'dsh-reports', rows: [{ entryId: 'include:reports' }] }]
    stale.invalidateBundles()
    const fromStale = await apply(stale)
    expect(fromStale.get('report_tool')?.grant).toBe('auto')
    expect(fromStale.get('report_tool')?.chain).toEqual(['tool:report_tool', 'plugin:dsh-reports'])
  })

  it('applies tool/mcp/builtin grants without awaiting a never-loaded bundle scan', async () => {
    const tools = fakeTools(['mcp__s__a', 'extra_tool'])
    let calls = 0
    const caps = new DotCapabilities({
      tools: () => tools,
      mcpManager: () => ({ list: () => [{ name: 's' }] }),
      // A scan that never finishes: awaiting it would hang the segment start.
      pluginManager: () => ({ listBundles: () => { calls += 1; return new Promise<never>(() => {}) } }),
      settings: () => settingsWith({ 'mcp:s': 'auto', 'tool:extra_tool': 'auto', 'builtin:skill': 'auto' }),
      locked: LOCKED,
    })
    const env = agentCtx(tools)
    const applied = await caps.applyToAgent(env.ctx as never, { session: { id: 'dot-1' } } as never)
    // 'skill' is preset-scope and invisible to this scope, so it stays unapplied.
    expect([...applied.entries()].map(([name, row]) => [name, row.grant]).sort())
      .toEqual([['extra_tool', 'auto'], ['mcp__s__a', 'auto']])
    expect(calls).toBe(0)
    // The deferred scan still kicks for the next catalog read.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(1)
    caps.releaseAll()
  })

  it('resolves without awaiting a pending or invalidated bundle scan when no plugin grant exists', async () => {
    const tools = fakeTools(['mcp__s__a', 'extra_tool'])
    let calls = 0
    const caps = new DotCapabilities({
      tools: () => tools,
      mcpManager: () => ({ list: () => [{ name: 's' }] }),
      pluginManager: () => ({ listBundles: () => { calls += 1; return new Promise<never>(() => {}) } }),
      settings: () => settingsWith({ 'mcp:s': 'auto', 'tool:extra_tool': 'auto', 'builtin:skill': 'auto' }),
      locked: LOCKED,
    })
    // A scan already in flight must not block resolution either.
    caps.prewarm()
    expect(calls).toBe(1)
    const fromPending = await caps.resolve()
    expect([...fromPending.keys()].sort()).toEqual(['extra_tool', 'mcp__s__a', 'skill'])
    expect(calls).toBe(1)

    // An invalidated (at === 0) cache answers stale and leaves the scan deferred.
    const quick = new DotCapabilities({
      tools: () => tools,
      mcpManager: () => ({ list: () => [{ name: 's' }] }),
      pluginManager: () => ({ listBundles: async () => { calls += 1; return [] } }),
      settings: () => settingsWith({ 'mcp:s': 'auto', 'tool:extra_tool': 'auto' }),
      locked: LOCKED,
    })
    await quick.catalog()
    expect(calls).toBe(2)
    quick.invalidateBundles()
    const fromStale = await quick.resolve()
    expect([...fromStale.keys()].sort()).toEqual(['extra_tool', 'mcp__s__a'])
    expect(calls).toBe(2)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(3)
  })

  it('still awaits the bundle scan during resolve when a plugin grant is enabled', async () => {
    const tools = fakeTools(['report_tool'])
    let rows: { name: string; rows: { entryId?: string }[] }[] = []
    let calls = 0
    let release: () => void = () => {}
    let gate: Promise<void> = Promise.resolve()
    const caps = new DotCapabilities({
      tools: () => tools,
      mcpManager: () => undefined,
      pluginManager: () => ({ listBundles: async () => { calls += 1; await gate; return rows } }),
      settings: () => settingsWith({ 'plugin:dsh-reports': 'auto' }),
      locked: LOCKED,
    })
    caps.owners.set('report_tool', { entryId: 'include:reports' })
    await caps.catalog()
    expect(calls).toBe(1)
    rows = [{ name: 'dsh-reports', rows: [{ entryId: 'include:reports' }] }]
    gate = new Promise<void>(resolve => { release = resolve })
    caps.invalidateBundles()
    let settled = false
    const pending = caps.resolve().then(result => { settled = true; return result })
    await Promise.resolve()
    // The scan was invoked synchronously and resolve waits for it.
    expect(calls).toBe(2)
    expect(settled).toBe(false)
    release()
    const resolved = await pending
    expect(resolved.get('report_tool')?.chain).toEqual(['tool:report_tool', 'plugin:dsh-reports'])
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
  function serviceHarness(grants: Record<string, 'off' | 'ask' | 'auto'>, pm?: () => CapabilityPluginManager | undefined, defs: readonly string[] = ['extra_tool']) {
    const tools = fakeTools(defs)
    const store = new DotStore(undefined)
    void store.setSettings(settingsWith(grants))
    const caps = new DotCapabilities({
      tools: () => tools,
      mcpManager: () => undefined,
      pluginManager: pm ?? (() => ({ listBundles: async () => [] })),
      settings: () => store.settings,
      locked: LOCKED,
    })
    for (const name of defs) caps.owners.set(name, {})
    const host = {
      isRunning: () => false,
      modelKey: () => undefined,
      syncModel: () => {},
      readEvents: async () => [],
      dotContext: async () => ({ live: true, compactions: 0 }),
      say: async () => {},
      resumeDot: async () => true,
      createWorkspace: async () => ({ id: 'w1', title: 'home', path: '/tmp/dot-cap-test' }),
      reapplyCapabilities: () => apply(),
    }
    const service = new DotService({ host: host as never, store, homeDir: '/tmp/dot-cap-test', capabilities: caps })
    const apply = async () => caps.applyToAgent({
      tools: { register: () => () => {}, restrict: () => () => {}, schemas: () => defs.map(name => ({ name })) },
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

  it('denies host schedule delivery to Dorothy herself and passes other targets', async () => {
    const { store, service, apply } = serviceHarness({ 'tool:schedule_create': 'auto', 'tool:schedule_edit': 'auto' }, undefined, ['schedule_create', 'schedule_edit'])
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await apply()
    await expect(service.capabilityGate({ name: 'schedule_create', arguments: { target: 'this_session', title: 't', prompt: 'p' } }))
      .resolves.toMatchObject({ kind: 'deny', reason: expect.stringContaining('dot_schedule') })
    await expect(service.capabilityGate({ name: 'schedule_create', arguments: { target: 'dot-1', title: 't', prompt: 'p' } }))
      .resolves.toMatchObject({ kind: 'deny' })
    await expect(service.capabilityGate({ name: 'schedule_create', arguments: JSON.stringify({ target: 'this_session' }) }))
      .resolves.toMatchObject({ kind: 'deny' })
    await expect(service.capabilityGate({ name: 'schedule_edit', arguments: { target: 'this_session' } }))
      .resolves.toMatchObject({ kind: 'deny' })
    await expect(service.capabilityGate({ name: 'schedule_create', arguments: { target: 'new_once', title: 't', prompt: 'p' } })).resolves.toBe('next')
    await expect(service.capabilityGate({ name: 'schedule_create', arguments: { target: 'new', title: 't', prompt: 'p' } })).resolves.toBe('next')
    await expect(service.capabilityGate({ name: 'schedule_create', arguments: { target: 'session-other' } })).resolves.toBe('next')
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

  it('settles an open capability ask to deny when the grant is revoked while the card waits', async () => {
    const { store, service, apply } = serviceHarness({ 'tool:extra_tool': 'ask' })
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await apply()

    const pending = service.capabilityGate({ name: 'extra_tool' })
    await new Promise(resolve => setImmediate(resolve))
    const request = service.pending.list().find(row => row.kind === 'approval')
    const card = store.cards.find(row => row.approvalId === request!.id)
    expect(card?.expired).toBe(false)

    // Revoke, then let the settings change withdraw the open ask.
    await store.setSettings(settingsWith({ 'tool:extra_tool': 'off' }))
    await service.settingsChanged()
    await expect(pending).resolves.toMatchObject({ kind: 'deny' })
    expect(service.pending.list().find(row => row.kind === 'approval')).toBeUndefined()
    expect(store.cards.find(row => row.id === card!.id)?.expired).toBe(true)
  })

  it('denies an approved ask when the grant is revoked between the answer and the recheck', async () => {
    const { store, service, apply } = serviceHarness({ 'tool:extra_tool': 'ask' })
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await apply()

    const pending = service.capabilityGate({ name: 'extra_tool' })
    await new Promise(resolve => setImmediate(resolve))
    const request = service.pending.list().find(row => row.kind === 'approval')
    const card = store.cards.find(row => row.approvalId === request!.id)
    // Revoke after the human answered but before the gate re-reads the grant.
    const answer = service.answerCard(card!.id, 'approval', { confirmed: true })
    await store.setSettings(settingsWith({ 'tool:extra_tool': 'off' }))
    await answer
    await expect(pending).resolves.toMatchObject({ kind: 'deny' })
  })

  it('keeps parallel capability asks live until each settles', async () => {
    const { store, service, apply } = serviceHarness({ 'tool:extra_tool': 'ask', 'tool:other_tool': 'ask' }, undefined, ['extra_tool', 'other_tool'])
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await apply()

    const first = service.capabilityGate({ name: 'extra_tool' })
    const second = service.capabilityGate({ name: 'other_tool' })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const asks = service.pending.list().filter(row => row.kind === 'approval')
    expect(asks).toHaveLength(2)
    const cardOf = (requestId: string) => store.cards.find(row => row.approvalId === requestId)!
    // Presenting the second card must not expire the first.
    expect(store.cards.filter(row => row.keepAlive === true && !row.expired)).toHaveLength(2)

    await service.answerCard(cardOf(asks[1]!.id).id, 'approval', { confirmed: true })
    await expect(second).resolves.toBe('next')
    expect(cardOf(asks[0]!.id).expired).toBe(false)
    await service.answerCard(cardOf(asks[0]!.id).id, 'approval', { confirmed: false })
    await expect(first).resolves.toMatchObject({ kind: 'deny' })
  })

  it('keeps a waiting ask live while a normal human message lands', async () => {
    const { store, service, apply } = serviceHarness({ 'tool:extra_tool': 'ask' })
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await apply()

    const pending = service.capabilityGate({ name: 'extra_tool' })
    await new Promise(resolve => setImmediate(resolve))
    const request = service.pending.list().find(row => row.kind === 'approval')
    const card = store.cards.find(row => row.approvalId === request!.id)!
    // The post-delivery bulk expiry used to take the waiting card with it.
    await service.say('an unrelated message')
    expect(store.cards.find(row => row.id === card.id)?.expired).toBe(false)
    await service.answerCard(card.id, 'approval', { confirmed: true })
    await expect(pending).resolves.toBe('next')
  })

  it('expires a leftover keep-alive card whose request did not survive a restart', async () => {
    const { store, service, apply } = serviceHarness({ 'tool:extra_tool': 'ask' })
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await apply()
    void service.capabilityGate({ name: 'extra_tool' })
    await new Promise(resolve => setImmediate(resolve))
    const card = store.cards.find(row => row.keepAlive === true)!
    expect(card.expired).toBe(false)

    // A fresh service over the same store has no live pending requests, so
    // reconciliation expires the card the dead request left behind.
    const restarted = new DotService({
      host: { isRunning: () => false, modelKey: () => undefined, readEvents: async () => [], dotContext: async () => ({ live: true, compactions: 0 }), say: async () => {} } as never,
      store, homeDir: '/tmp/dot-cap-test', capabilities: (service as unknown as { options: { capabilities: unknown } }).options.capabilities as never,
    })
    await restarted.reconcile()
    expect(store.cards.find(row => row.id === card.id)?.expired).toBe(true)
  })

  it('proposes grant changes through the settings flow and refuses locked shapes', async () => {
    const { store, caps, service, apply } = serviceHarness({})
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await apply()
    await expect(service.proposeCapability({ selector: 'junk', grant: 'auto', reason: 'why' })).rejects.toThrow(/selector/)
    await expect(service.proposeCapability({ selector: 'host', grant: 'auto', reason: 'why' })).rejects.toThrow(/host-wide|per-tool/)
    await expect(service.proposeCapability({ selector: 'tool:web_search', grant: 'auto', reason: 'why' })).rejects.toThrow(/locked/)
    const prefixMessage = await service.proposeCapability({ selector: 'prefix:team', grant: 'ask', reason: 'cluster' })
    expect(prefixMessage).toContain('Proposal')
    await service.selfSettings.decide(store.settingProposals.at(-1)!.id, true)
    const message = await service.proposeCapability({ selector: 'tool:extra_tool', grant: 'ask', reason: 'I need it' })
    expect(message).toContain('Proposal')
    const proposal = store.settingProposals.at(-1)
    expect(proposal?.field).toBe('capabilities')
    const decided = await service.selfSettings.decide(proposal!.id, true)
    expect(decided).toContain('Approved')
    expect(store.settings.capabilities.grants).toEqual({ 'prefix:team': 'ask', 'tool:extra_tool': 'ask' })
    // Approving runs the real settingsChanged(): an untouched segment re-applies
    // grants in place, so the tool lands in the applied set without a rollover.
    expect(caps.appliedFor('dot-1')?.get('extra_tool')?.grant).toBe('ask')
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

  it('marks high-risk tools in the list and warns on the proposal card for auto grants', async () => {
    const { store, service, apply } = serviceHarness({}, undefined, ['bash', 'team_a', 'team_b'])
    await store0(service)
    await apply()
    const text = await service.listCapabilities()
    expect(text).toContain('HIGH RISK')
    // A tool: auto grant that would self-escalate carries the warning into the proposal card.
    await service.proposeCapability({ selector: 'tool:bash', grant: 'auto', reason: 'run shell' })
    expect(store.settingProposals.at(-1)?.reason).toMatch(/Warning:.*bash/)
    await service.selfSettings.decide(store.settingProposals.at(-1)!.id, false)
    // An ask grant, or an auto grant touching no high-risk tool, warns on nothing.
    await service.proposeCapability({ selector: 'prefix:team', grant: 'auto', reason: 'cluster' })
    expect(store.settingProposals.at(-1)?.reason).not.toContain('Warning')
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
    const relayed: string[] = []
    const service = new DotService({
      host: {
        isRunning: () => false,
        modelKey: () => undefined,
        syncModel: () => {},
        readEvents: async () => [],
        dotContext: async () => ({ live: true, compactions: 0 }),
        say: async () => {},
        resumeDot: async () => true,
        createWorkspace: async () => ({ id: 'w1', title: 'home', path: '/tmp/dot-cap-test' }),
        relay: async (_dot: string, _from: string, text: string) => { relayed.push(text) },
      } as never,
      store, homeDir: '/tmp/dot-cap-test', capabilities: caps,
    })
    const notes: string[] = []
    const original = service.notify.bind(service)
    service.notify = (notice, urgent) => { notes.push(notice.text); original(notice, urgent) }
    return { store, service, notes, relayed }
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

    const readOnly = harness(pm({ listBundles: async () => [{ name: 'dsh-x', readOnlyReason: 'management-required', rows: [] }] }))
    await store0(readOnly.service)
    await expect(readOnly.service.proposeInstall({ spec: 'dsh-x', version: '1.2.3', reason: 'r' })).rejects.toThrow(/protected/)

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

  it('keeps two parallel install proposals answerable until each settles', async () => {
    const { store, service, notes } = harness(pm())
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    await service.proposeInstall({ spec: 'dsh-x', version: '1.2.3', reason: 'need x' })
    await service.proposeInstall({ spec: 'dsh-y', version: '2.0.0', reason: 'need y' })
    const cards = store.cards.filter(row => row.callId.startsWith('install:'))
    expect(cards).toHaveLength(2)
    // The second proposal's card must not expire the first one.
    expect(cards.every(card => card.keepAlive === true && !card.expired)).toBe(true)

    await service.answerCard(cards[1]!.id, 'approval', { confirmed: false })
    await tick()
    expect(notes.some(text => text.includes('declined'))).toBe(true)
    expect(store.cards.find(row => row.id === cards[0]!.id)?.expired).toBe(false)
    await service.answerCard(cards[0]!.id, 'approval', { confirmed: true })
    await tick()
    expect(notes.some(text => text.includes('Installed dsh-x@1.2.3'))).toBe(true)
  })

  it('delivers the install outcome to the host with the proposal id in the text', async () => {
    const settle = async (h: ReturnType<typeof harness>, approve: boolean) => {
      await h.service.proposeInstall({ spec: 'dsh-x', version: '1.2.3', reason: 'need x' })
      const request = h.service.pending.list().find(row => row.kind === 'approval')!
      const card = h.store.cards.find(row => row.approvalId === request.id)!
      await h.service.answerCard(card.id, 'approval', { confirmed: approve })
      await tick()
      await h.service.flushNotices()
      return request.id
    }

    const ok = harness(pm())
    await store0(ok.service)
    const okId = await settle(ok, true)
    expect(ok.relayed.at(-1)).toContain(`Install proposal ${okId}`)
    expect(ok.relayed.at(-1)).toContain('Installed dsh-x@1.2.3')

    const failed = harness(pm({ installBundle: async () => { throw new Error('registry down') } }))
    await store0(failed.service)
    const failedId = await settle(failed, true)
    expect(failed.relayed.at(-1)).toContain(`Install proposal ${failedId}`)
    expect(failed.relayed.at(-1)).toContain('registry down')

    const declined = harness(pm())
    await store0(declined.service)
    const declinedId = await settle(declined, false)
    expect(declined.relayed.at(-1)).toContain(`Install proposal ${declinedId}`)
    expect(declined.relayed.at(-1)).toContain('declined')
  })

  it('installs an official on-demand row through its pinned installTarget and skips inspection', async () => {
    const installs: { spec: string; options?: { expected?: unknown } }[] = []
    const inspected: string[] = []
    const row = { name: '@deepseek-ai/dsh-x', official: true, installed: false, enabled: false, description: 'Official X', installTarget: { spec: '@deepseek-ai/dsh-x@0.2.2-rc.5', version: '0.2.2-rc.5' }, rows: [] }
    const { store, service, notes } = harness(pm({
      listBundles: async () => [row],
      inspect: async (spec) => { inspected.push(spec); return { status: 'accepted', bundle: true } },
      installBundle: async (spec, options) => { installs.push({ spec, options }); return { changed: true, application: 'applied', bundle: '@deepseek-ai/dsh-x', version: '0.2.2-rc.5' } },
    }))
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: '' })
    const message = await service.proposeInstall({ spec: '@deepseek-ai/dsh-x', reason: 'need official x' })
    expect(message).toContain('@deepseek-ai/dsh-x@0.2.2-rc.5')
    expect(inspected).toHaveLength(0)
    const card = store.cards.find(row => row.callId.startsWith('install:'))
    await service.answerCard(card!.id, 'approval', { confirmed: true })
    await tick()
    expect(installs).toHaveLength(1)
    expect(installs[0]!.spec).toBe('@deepseek-ai/dsh-x@0.2.2-rc.5')
    expect(installs[0]!.options?.expected).toEqual({ name: '@deepseek-ai/dsh-x', version: '0.2.2-rc.5' })
    expect(notes.some(text => text.includes('Installed @deepseek-ai/dsh-x@0.2.2-rc.5'))).toBe(true)
  })

  it('refuses a version that disagrees with the official installTarget', async () => {
    const row = { name: 'dsh-x', official: true, installed: false, installTarget: { spec: 'dsh-x@2.0.0', version: '2.0.0' }, rows: [] }
    const { service } = harness(pm({ listBundles: async () => [row] }))
    await store0(service)
    await expect(service.proposeInstall({ spec: 'dsh-x', version: '1.0.0', reason: 'r' })).rejects.toThrow(/2\.0\.0/)
    const message = await service.proposeInstall({ spec: 'dsh-x', version: '2.0.0', reason: 'r' })
    expect(message).toContain('waiting')
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

  it('keeps an answered segment-1 card row, with its answer, after the feed moves to segment 2', async () => {
    const store = new DotStore(undefined)
    await store.addCard({ id: 'c1', number: 1, sessionId: 's1', callId: 'capability:a', title: 't', view: { type: 'stack', children: [] }, expired: false, shownAt: 200 })
    await store.setCardAnswer('c1', { id: 'c1', action: 'approval', values: { confirmed: true } })
    const host = { isRunning: () => false, dotEvents: () => [], readEvents: async () => [] }
    const feed = new ChatFeed(host as never, store)
    feed.attach('s1')
    feed.attach('s2', [{ sessionId: 's1', startedAt: 100, endedAt: 300, reason: 'manual' }])
    await new Promise(resolve => setImmediate(resolve))

    const snapshot = feed.snapshot()!
    const items = snapshot.items
    const cardRow = items.find(item => item.key === 'capability:a')
    const marker = items.findIndex(item => item.kind === 'segment' && item.key === 'segment:s1')
    expect(cardRow).toBeDefined()
    expect(marker).toBeGreaterThan(-1)
    expect(items.indexOf(cardRow!)).toBeLessThan(marker)
    expect(snapshot.answers?.['c1']).toMatchObject({ action: 'approval' })

    // A card whose record predates shownAt lands just before the segment marker.
    await store.addCard({ id: 'c2', number: 2, sessionId: 's1', callId: 'capability:old', title: 't', view: { type: 'stack', children: [] }, expired: true })
    const placed = feed.snapshot()!.items.find(item => item.key === 'capability:old')
    expect(placed?.at).toBe(299)
  })
})
