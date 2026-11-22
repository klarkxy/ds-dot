import { act, useState } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type DotSettings, type TaskPermission } from './contracts.ts'
import { parseSettings, patchSettings } from './settings.ts'
import { bindRunSession } from './execution.ts'
import { bindHost, type DotHost } from './host.ts'
import { buildCatalog, DotCapabilities, resolveGrants } from './capabilities.ts'
import { SettingsPanel } from './settings-panel.tsx'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('navigator', dom.window.navigator)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => { createRoot = (await import('react-dom/client')).createRoot })
afterEach(() => { document.body.innerHTML = '<div id="root"></div>' })

describe('task permission settings', () => {
  it('migrates a stored default to workspace-write and accepts the new values', () => {
    expect(parseSettings({ taskPermission: 'default' }).taskPermission).toBe('workspace-write')
    expect(parseSettings({ taskPermission: 'safe-auto' }).taskPermission).toBe('safe-auto')
    expect(parseSettings({ taskPermission: 'auto' }).taskPermission).toBe('auto')
    expect(parseSettings({ taskPermission: 'bogus' }).taskPermission).toBe('workspace-write')
    const saved = { ...DEFAULT_SETTINGS, taskPermission: 'safe-auto' as TaskPermission }
    expect(patchSettings(DEFAULT_SETTINGS, { taskPermission: 'auto' }).taskPermission).toBe('auto')
    expect(patchSettings(saved, { taskPermission: 'workspace-write' }).taskPermission).toBe('workspace-write')
    expect(() => patchSettings(DEFAULT_SETTINGS, { taskPermission: 'default' })).toThrow()
  })
})

describe('run-session permission resolution', () => {
  const runHost = (effective: string, verify = true): DotHost => ({
    setWritable: async () => true,
    verifyTaskPermission: async (_id, _access, preset) => preset === effective && verify,
    effectiveTaskPermission: () => effective,
  } as unknown as DotHost)

  it('uses the effective permission for both set and verify', async () => {
    for (const preset of ['safe-auto', 'auto']) {
      const host = runHost(preset)
      expect(await bindRunSession(host, preset as TaskPermission).prepareAccess('s', 'write')).toBe('ok')
    }
  })
  it('falls back to workspace-write when the optional preset is unavailable', async () => {
    const host = runHost('workspace-write')
    expect(await bindRunSession(host, 'safe-auto').prepareAccess('s', 'write')).toBe('ok')
  })
})

describe('host task-permission surface', () => {
  const session = {}
  const fakeGet = (runtime: unknown, options: { value: string }[] = []) => (name: string) =>
    name === 'agents' ? { get: () => ({ session }) }
    : name === 'permissionPresets' ? { resolve: (p: string) => ({ sandbox: p }), current: () => 'x', set: () => {}, catalog: () => ({ options }) }
    : name === 'safeAutoRuntime' ? runtime
    : undefined

  it('reports which optional permissions are live', () => {
    const rt = { selectSession: async () => true, sessionActive: () => true, available: () => true }
    const host = bindHost(fakeGet(rt, [{ value: 'auto' }]))
    expect(host.taskPermissionOptions!()).toEqual({ safeAuto: true, auto: true })
    const none = bindHost(fakeGet(undefined))
    expect(none.taskPermissionOptions!()).toEqual({ safeAuto: false, auto: false })
    expect(none.effectiveTaskPermission!('safe-auto')).toBe('workspace-write')
    expect(none.effectiveTaskPermission!('auto')).toBe('workspace-write')
    expect(none.effectiveTaskPermission!('workspace-write')).toBe('workspace-write')
    expect(bindHost(fakeGet(rt)).effectiveTaskPermission!('safe-auto')).toBe('safe-auto')
  })
  it('safeAutoActive reads the runtime and survives its absence', async () => {
    const rt = { selectSession: async (id: string) => { selected = id; return true }, sessionActive: (id: string) => id === 's', available: () => true }
    let selected = ''
    const host = bindHost(fakeGet(rt))
    expect(host.safeAutoActive!('s')).toBe(true)
    expect(host.safeAutoActive!('other')).toBe(false)
    expect(bindHost(fakeGet(undefined)).safeAutoActive!('s')).toBe(false)
    expect(await host.setWritable!('s', 'safe-auto')).toBe(true)
    expect(selected).toBe('s')
    expect(await bindHost(fakeGet(undefined)).setWritable!('s', 'safe-auto')).toBe(false)
    expect(await host.verifyTaskPermission!('s', 'write', 'safe-auto')).toBe(true)
  })
})

describe('capability bundle rows', () => {
  const deps = (listBundles: () => Promise<readonly never[]>) => ({
    tools: () => undefined,
    mcpManager: () => undefined,
    pluginManager: () => ({ listBundles }),
    settings: () => ({ capabilities: { grants: {} } }),
    locked: [] as readonly string[],
  })

  it('awaits only the first load; staleness triggers a coalesced background refresh', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const caps = new DotCapabilities(deps(() => { calls += 1; return new Promise<never[]>(resolve => { release = () => resolve([]) }) }) as never)
    const first = caps.catalog()
    expect(calls).toBe(1)
    release!()
    await first
    release = undefined
    caps.invalidateBundles()
    // Stale cache answers immediately even while the refresh is still pending.
    const second = await caps.catalog()
    expect(second.groups.some(group => group.id === 'builtin')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(2)
    release!()
  })

  it('does not scan plugin bundles on invalidateBundles itself', async () => {
    let calls = 0
    const caps = new DotCapabilities(deps(async () => { calls += 1; return [] }) as never)
    await caps.catalog()
    expect(calls).toBe(1)
    caps.invalidateBundles()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(1)
    await caps.catalog()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(2)
  })

  it('retries bundle refresh after a synchronous listBundles throw', async () => {
    let calls = 0
    const caps = new DotCapabilities(deps(() => {
      calls += 1
      if (calls === 1) throw new Error('sync fail')
      return Promise.resolve([])
    }) as never)
    await caps.catalog()
    expect(calls).toBe(1)
    await caps.catalog()
    expect(calls).toBe(2)
  })

  it('exposes builtin groups and resolves builtin: grants to preset-scope tools', async () => {
    const view = buildCatalog({ defs: [], owners: new Map(), servers: [], bundles: [], grants: {}, locked: new Set(), conditional: () => false, builtinDescriptions: new Map([['skill', 'Run a skill']]) })
    const parent = view.groups.find(group => group.id === 'builtin')
    expect(parent?.kind).toBe('builtin')
    const ids = (parent?.children ?? []).map(child => child.id)
    expect(ids).toEqual(['builtin:skill', 'builtin:schedule', 'builtin:plugin-manager'])
    expect((parent?.children ?? []).flatMap(child => child.tools).map(tool => tool.name)).toContain('plugin_manager')
    const resolved = resolveGrants({ 'builtin:skill': 'auto' }, view.groups)
    expect(resolved.get('skill')?.grant).toBe('auto')
    expect(resolved.has('schedule_create')).toBe(false)
    // A preset-scope tool absent from the root registry is allowed only when visible.
    const visible = new Set(['skill'])
    const registered: string[] = []
    const allow: string[][] = []
    const agentCtx = {
      tools: {
        schemas: () => [...visible].map(name => ({ name, description: 'd' })),
        register: (def: { name: string }) => { registered.push(def.name); return () => {} },
        restrict: (filter: { allow: string[] }) => { allow.push(filter.allow); return () => {} },
      },
      on: () => () => {},
    }
    const caps = new DotCapabilities({
      tools: () => ({ definitions: () => [], get: () => undefined, executable: () => undefined }),
      mcpManager: () => undefined,
      pluginManager: () => undefined,
      settings: () => ({ capabilities: { grants: { 'builtin:skill': 'auto', 'builtin:plugin-manager': 'auto' } } }),
      locked: ['dot_task'],
    })
    const applied = await caps.applyToAgent(agentCtx as never, { session: { id: 'dot' } } as never)
    expect(applied.has('skill')).toBe(true)
    expect(applied.has('plugin_manager')).toBe(false)
    expect(allow[0]).toContain('skill')
    expect(allow[0]).not.toContain('plugin_manager')
    expect(registered).toEqual([])
    caps.releaseAll()
  })

  it('marks builtin tools missing only after a schema snapshot that lacks them', async () => {
    const caps = new DotCapabilities({
      tools: () => ({ definitions: () => [], get: () => undefined, executable: () => undefined }),
      mcpManager: () => undefined,
      pluginManager: () => undefined,
      settings: () => ({ capabilities: { grants: {} } }),
      locked: ['dot_task'],
    })
    const childOf = async (id: string) => (await caps.catalog()).groups.find(group => group.id === 'builtin')?.children?.find(child => child.id === id)
    // Before any snapshot nothing is flagged.
    expect((await childOf('builtin:plugin-manager'))?.tools[0]?.missing).toBeUndefined()
    const agentCtx = {
      tools: {
        schemas: () => [{ name: 'dot_task' }, { name: 'skill', description: 'Run a skill' }],
        register: () => () => {},
        restrict: () => () => {},
      },
      on: () => () => {},
    }
    await caps.applyToAgent(agentCtx as never, { session: { id: 'dot' } } as never)
    caps.releaseAll()
    expect((await childOf('builtin:skill'))?.tools[0]?.missing).toBeUndefined()
    expect((await childOf('builtin:skill'))?.missing).toBeUndefined()
    expect((await childOf('builtin:plugin-manager'))?.tools[0]?.missing).toBe(true)
    expect((await childOf('builtin:plugin-manager'))?.missing).toBe(true)
    expect((await childOf('builtin:schedule'))?.missing).toBe(true)
  })
})

function panelHarness(apiOverrides: Record<string, unknown>, settings: DotSettings, saves: unknown[]) {
  const api = {
    models: async () => ({ groups: [] }),
    settings: async () => settings,
    settingProposals: async () => [],
    decideSetting: async () => 'ok',
    setSettings: async (patch: Partial<DotSettings>) => { saves.push(patch); return { ...settings, ...patch } as DotSettings },
    ...apiOverrides,
  }
  function Harness() {
    const [current, setCurrent] = useState<DotSettings>(settings)
    return <SettingsPanel locale="zh" section="dispatch" api={api as never} settings={current} onSaved={setCurrent} />
  }
  return Harness
}

describe('task permission options in the settings view', () => {
  const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="任务权限"] [role="tab"]')].map(el => el.textContent)

  it('renders only the live options and warns about an unavailable saved value', async () => {
    for (const [options, count] of [
      [['workspace-write', 'danger-full-access'], 2],
      [['workspace-write', 'danger-full-access', 'safe-auto'], 3],
      [['workspace-write', 'danger-full-access', 'safe-auto', 'auto'], 4],
    ] as const) {
      const saves: unknown[] = []
      const Harness = panelHarness({ taskPermissionOptions: async () => ({ options: [...options] }) }, DEFAULT_SETTINGS, saves)
      const root = createRoot(document.getElementById('root')!)
      await act(async () => root.render(<Harness />))
      await act(async () => { await Promise.resolve() })
      expect(tabs()).toHaveLength(count)
      await act(async () => root.unmount())
    }
    // A saved safe-auto without the runtime stays selected and warns.
    const Harness = panelHarness(
      { taskPermissionOptions: async () => ({ options: ['workspace-write', 'danger-full-access'] }) },
      { ...DEFAULT_SETTINGS, taskPermission: 'safe-auto' }, [])
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    expect(tabs()).toHaveLength(3)
    expect(document.body.textContent).toContain('当前不可用')
    await act(async () => root.unmount())
  })

  it('re-reads live options when switching to the dispatch page', async () => {
    let options: TaskPermission[] = ['workspace-write', 'danger-full-access']
    let reads = 0
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => DEFAULT_SETTINGS,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async () => DEFAULT_SETTINGS,
      taskPermissionOptions: async () => { reads += 1; return { options: [...options] } },
    }
    function Page({ section }: { section: 'general' | 'dispatch' }) {
      return <SettingsPanel locale="zh" section={section} api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Page section="general" />))
    await act(async () => { await Promise.resolve() })
    expect(reads).toBe(0)
    options = ['workspace-write', 'danger-full-access', 'safe-auto', 'auto']
    await act(async () => root.render(<Page section="dispatch" />))
    await act(async () => { await Promise.resolve() })
    expect(reads).toBe(1)
    expect(tabs()).toHaveLength(4)
    await act(async () => root.unmount())
  })
})

describe('task model picker', () => {
  const choices = [
    { provider: 'p1', model: 'm1', label: 'P1 / m1' },
    { provider: 'p1', model: 'm2', label: 'P1 / m2' },
    { provider: 'p2', model: 'n1', label: 'P2 / n1' },
  ]
  const api = (saves: unknown[], settings: DotSettings) => ({
    models: async () => ({ groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'm1' }, { id: 'm2', name: 'm2' }] }, { id: 'p2', name: 'P2', models: [{ id: 'n1', name: 'n1' }] }] }),
    settings: async () => settings,
    settingProposals: async () => [],
    decideSetting: async () => 'ok',
    setSettings: async (patch: Partial<DotSettings>) => { saves.push(patch); return { ...settings, ...patch } as DotSettings },
  })

  it('removes a chip and toggles a whole group in one save each', async () => {
    const saves: Array<Record<string, { list?: string[] }>> = []
    const settings: DotSettings = { ...DEFAULT_SETTINGS, taskModels: { mode: 'allow', list: ['p1/m1', 'p2/n1'] } }
    const Harness = panelHarness({ models: api(saves, settings).models }, settings, saves)
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    expect(document.querySelectorAll('.dsh-dot-model-chip')).toHaveLength(2)
    // Chip remove: one save dropping p2/n1.
    await act(async () => { document.querySelectorAll<HTMLButtonElement>('.dsh-dot-model-chip-remove')[1]!.click() })
    expect(saves.at(-1)?.taskModels?.list).toEqual(['p1/m1'])
    // Group toggle: one save adding all of p1 (m1 still selected → adds m2).
    const list = saves.length
    const toggle = [...document.querySelectorAll<HTMLElement>('.dsh-dot-model-group-toggle')].find(el => el.parentElement?.textContent?.includes('P1'))!
    await act(async () => toggle.click())
    expect(saves.length).toBe(list + 1)
    expect(saves.at(-1)?.taskModels?.list).toEqual(['p1/m1', 'p1/m2'])
    await act(async () => root.unmount())
  })
})

describe('capabilities page', () => {
  const catalog = {
    locked: ['dot_task'],
    groups: [
      { id: 'mcp:wiki', kind: 'mcp', label: 'wiki', tools: [{ name: 'mcp__wiki__find', description: 'find docs', conditional: false }] },
      { id: 'plugin:p', kind: 'plugin', label: 'p', tools: [{ name: 'other_tool', conditional: false }, { name: 'other_list', conditional: false }] },
      {
        id: 'builtin', kind: 'builtin', label: 'builtin', tools: [],
        children: [{
          id: 'builtin:schedule', kind: 'builtin', label: 'schedule',
          tools: [{ name: 'schedule_create', conditional: false }, { name: 'schedule_list', conditional: false }],
        }],
      },
      { id: 'host', kind: 'host', label: 'Unattributed', tools: [{ name: 'loose_tool', conditional: false }] },
      { id: 'plugin:solo', kind: 'plugin', label: 'solo', tools: [{ name: 'solo_tool', conditional: false }] },
    ],
    grants: {}, applied: {},
  }

  const groupIds = () => [...document.querySelectorAll('.dsh-dot-cap-head .dsh-dot-cap-name')].map(el => el.getAttribute('title'))
  const toolRow = (name: string) => [...document.querySelectorAll('.dsh-dot-cap-row')].find(row => row.textContent?.includes(name))

  async function mountCatalog() {
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => DEFAULT_SETTINGS,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async () => DEFAULT_SETTINGS,
      capabilities: async () => catalog,
    }
    const Harness = () => <SettingsPanel locale="zh" section="capabilities" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    return root
  }

  async function search(text: string) {
    const input = document.querySelector<HTMLInputElement>('.dsh-dot-cap-search input')!
    await act(async () => {
      input.value = text
      const propsKey = Object.keys(input).find(key => key.startsWith('__reactProps'))
      const props = propsKey ? (input as unknown as Record<string, { onChange?: (event: { target: HTMLElement }) => void }>)[propsKey] : undefined
      props?.onChange?.({ target: input })
    })
  }

  it('shows a skeleton while loading and filters groups by search text', async () => {
    let resolveView: ((v: typeof catalog) => void) | undefined
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => DEFAULT_SETTINGS,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async () => DEFAULT_SETTINGS,
      capabilities: () => new Promise<typeof catalog>(resolve => { resolveView = resolve }),
    }
    const Harness = () => <SettingsPanel locale="zh" section="capabilities" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-skeleton')).not.toBeNull()
    await act(async () => { resolveView!(catalog); await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-cap-intro')?.textContent).toContain('宿主提供的工具')
    expect(document.querySelectorAll('.dsh-dot-cap-group').length).toBeGreaterThanOrEqual(3)
    await search('wiki')
    expect(groupIds()).toContain('mcp:wiki')
    expect(groupIds()).not.toContain('plugin:p')
    await act(async () => root.unmount())
  })

  it('keeps a tool-level grant on a host singleton and on a search-narrowed plugin tool', async () => {
    const root = await mountCatalog()
    expect(toolRow('loose_tool')?.querySelector('.dsh-dot-cap-grant')).not.toBeNull()
    expect(toolRow('solo_tool')?.querySelector('.dsh-dot-cap-grant')).toBeNull()
    await search('other_list')
    expect(toolRow('other_list')?.querySelector('.dsh-dot-cap-grant')).not.toBeNull()
    expect(toolRow('other_tool')).toBeUndefined()
    await act(async () => root.unmount())
  })

  it('shows the full subtree when the search hits a group id or localized name', async () => {
    const root = await mountCatalog()
    await search('builtin:schedule')
    expect(groupIds()).toContain('builtin:schedule')
    expect(toolRow('schedule_create')).not.toBeUndefined()
    expect(toolRow('schedule_list')).not.toBeUndefined()
    expect(groupIds()).not.toContain('plugin:p')
    await search('定时任务')
    expect(groupIds()).toContain('builtin:schedule')
    expect(toolRow('schedule_create')).not.toBeUndefined()
    expect(toolRow('schedule_list')).not.toBeUndefined()
    await act(async () => root.unmount())
  })
})
