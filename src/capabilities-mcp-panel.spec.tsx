import { act, useState } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type CapabilityCatalogView, type CapabilityGroupView, type DotMcpListView, type DotSettings } from './contracts.ts'
import { SettingsPanel } from './settings-panel.tsx'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('navigator', dom.window.navigator)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => { createRoot = (await import('react-dom/client')).createRoot })
afterEach(() => { document.body.innerHTML = '<div id="root"></div>' })

function type(element: HTMLInputElement, value: string): void {
  element.value = value
  const propsKey = Object.keys(element).find(key => key.startsWith('__reactProps'))
  const props = propsKey ? (element as unknown as Record<string, { onChange?: (event: { target: HTMLElement }) => void }>)[propsKey] : undefined
  props?.onChange?.({ target: element })
}

const catalogGroups = [
  { id: 'mcp:deepwiki', kind: 'mcp' as const, label: 'deepwiki', tools: [{ name: 'mcp__deepwiki__read_wiki_structure', conditional: false }] },
  { id: 'mcp:exa', kind: 'mcp' as const, label: 'exa', tools: [{ name: 'mcp__exa__search', conditional: false }] },
  { id: 'plugin:p', kind: 'plugin' as const, label: 'p', tools: [{ name: 'pt_tool', conditional: false }] },
]
const capabilitiesView = (): CapabilityCatalogView => ({ locked: ['dot_overview'], groups: catalogGroups, grants: {}, applied: {} })
const mcpListView = (): DotMcpListView => ({
  servers: [{ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', enabled: true, auth: 'none', status: { state: 'connected', toolCount: 1 } }],
  catalog: [{ id: 'context7', name: 'Context7', about: 'sMcpAbout_context7', url: 'https://mcp.context7.com/mcp', auth: 'none' }],
})

function apiStub(over: Record<string, unknown> = {}) {
  return {
    models: async () => ({ groups: [] }),
    settings: async () => DEFAULT_SETTINGS,
    settingProposals: async () => [],
    decideSetting: async () => 'ok',
    setSettings: async () => DEFAULT_SETTINGS,
    ...over,
  }
}

async function renderPanel(root: ReturnType<typeof createRoot>, api: unknown, section: 'capabilities' | 'mcp', settings: DotSettings = DEFAULT_SETTINGS) {
  await act(async () => root.render(<SettingsPanel locale="en" section={section} api={api as never} settings={settings} onSaved={() => {}} />))
  await act(async () => { await Promise.resolve() })
}

describe('unified capabilities & MCP panel', () => {
  it('renders server management and capability grants in one view on either tab', async () => {
    const api = apiStub({
      capabilities: async () => capabilitiesView(),
      mcpList: async () => mcpListView(),
    })
    const root = createRoot(document.getElementById('root')!)

    // The capabilities tab also shows connected servers, the catalog and the custom form.
    await renderPanel(root, api, 'capabilities')
    const text = () => document.body.textContent ?? ''
    expect(text()).toContain('Connected')
    expect(text()).toContain('Recommended')
    expect(text()).toContain('Library documentation and code examples')
    expect(document.querySelector('.dsh-dot-mcp-custom-body input')).not.toBeNull()
    expect(document.querySelector('.dsh-dot-capmcp')?.getAttribute('data-zone')).toBe('capabilities')
    // The managed server renders as one card, not duplicated in the MCP capability section.
    const cards = [...document.querySelectorAll('.dsh-dot-mcp-row')].filter(row => row.querySelector('.dsh-dot-mcp-name')?.textContent === 'deepwiki')
    expect(cards).toHaveLength(1)

    // The MCP tab shows the same unified halves, led by server management.
    await renderPanel(root, api, 'mcp')
    expect(document.querySelector('.dsh-dot-capmcp')?.getAttribute('data-zone')).toBe('mcp')
    expect(text()).toContain('Plugins')
    expect(document.querySelector('.dsh-dot-caps')).not.toBeNull()
    const mcpFirst = document.querySelector('.dsh-dot-capmcp')?.firstElementChild
    expect(mcpFirst?.classList.contains('dsh-dot-mcp')).toBe(true)
    await act(async () => root.unmount())
  })

  it('keeps ungranted groups collapsed by default and granted ones open', async () => {
    const api = apiStub({
      capabilities: async () => capabilitiesView(),
      mcpList: async () => mcpListView(),
    })
    const settings: DotSettings = { ...DEFAULT_SETTINGS, capabilities: { grants: { 'plugin:p': 'auto' } } }
    const root = createRoot(document.getElementById('root')!)
    await renderPanel(root, api, 'capabilities', settings)

    const groups = [...document.querySelectorAll<HTMLDetailsElement>('.dsh-dot-cap-group')]
    // The locked always-on group is a plain details header; skip it by content.
    const plugin = groups.find(group => group.querySelector(':scope > summary')?.textContent?.includes('p'))!
    expect(plugin.open).toBe(true)
    const exa = groups.find(group => group.querySelector(':scope > summary')?.textContent?.includes('exa'))!
    expect(exa.open).toBe(false)
    // Collapsed rows still render compact tool rows inside (never truncated by CSS).
    expect(exa.querySelector('.dsh-dot-cap-row')).not.toBeNull()
    // A connected server card with tools stays collapsed without a grant.
    const server = [...document.querySelectorAll<HTMLDetailsElement>('.dsh-dot-mcp-server')]
      .find(row => row.querySelector('.dsh-dot-mcp-name')?.textContent === 'deepwiki')!
    expect(server.open).toBe(false)
    await act(async () => root.unmount())
  })

  it('expands a collapsed group on click and shows its compact tool rows', async () => {
    const api = apiStub({
      capabilities: async () => capabilitiesView(),
      mcpList: async () => mcpListView(),
    })
    const root = createRoot(document.getElementById('root')!)
    await renderPanel(root, api, 'capabilities')
    const server = [...document.querySelectorAll<HTMLDetailsElement>('.dsh-dot-mcp-server')]
      .find(row => row.querySelector('.dsh-dot-mcp-name')?.textContent === 'deepwiki')!
    expect(server.open).toBe(false)
    await act(async () => server.querySelector(':scope > summary')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    expect(server.open).toBe(true)
    const row = server.querySelector('.dsh-dot-cap-row')!
    expect(row.querySelector('code')?.textContent).toBe('read_wiki_structure')
    await act(async () => root.unmount())
  })

  it('reopens a manually collapsed group when the search matches it', async () => {
    const api = apiStub({
      capabilities: async () => capabilitiesView(),
      mcpList: async () => mcpListView(),
    })
    const settings: DotSettings = { ...DEFAULT_SETTINGS, capabilities: { grants: { 'plugin:p': 'auto' } } }
    const root = createRoot(document.getElementById('root')!)
    await renderPanel(root, api, 'capabilities', settings)
    const plugin = [...document.querySelectorAll<HTMLDetailsElement>('.dsh-dot-cap-group')]
      .find(group => group.querySelector(':scope > summary')?.textContent?.includes('p'))!
    expect(plugin.open).toBe(true)
    await act(async () => plugin.querySelector(':scope > summary')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    expect(plugin.open).toBe(false)
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => type(search, 'pt_tool'))
    const matched = [...document.querySelectorAll<HTMLDetailsElement>('.dsh-dot-cap-group')]
      .find(group => group.querySelector(':scope > summary')?.textContent?.includes('pt_tool') || group.querySelector(':scope > summary')?.textContent?.includes('p'))!
    expect(matched.open).toBe(true)
    await act(async () => root.unmount())
  })

  it('resets an override through a text button visually distinct from server removal', async () => {
    let current: DotSettings = {
      ...DEFAULT_SETTINGS,
      mcpServers: { deepwiki: { url: 'https://mcp.deepwiki.com/mcp', enabled: true } },
      capabilities: { grants: { 'mcp:deepwiki': 'auto' } },
    }
    const api = apiStub({
      capabilities: async () => capabilitiesView(),
      mcpList: async () => mcpListView(),
      setSettings: async (patch: Record<string, unknown>) => { current = { ...current, ...patch } as DotSettings; return current },
    })
    const Harness = () => {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" section="mcp" api={api as never} settings={settings} onSaved={next => { current = next; setSettings(next) }} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })

    const card = [...document.querySelectorAll('.dsh-dot-mcp-row')].find(row => row.querySelector('.dsh-dot-mcp-name')?.textContent === 'deepwiki')!
    // The override reset is an explicit text button; no bare × sits next to the segmented control.
    const reset = card.querySelector<HTMLButtonElement>('.dsh-dot-cap-clear')!
    expect(reset.textContent).toBe('Reset to inherited')
    const grantZone = card.querySelector('.dsh-dot-mcp-grant')!
    expect(grantZone.querySelector('svg')).toBeNull()
    // Removal is a separate, differently-labelled destructive action outside the grant row.
    const remove = [...card.querySelectorAll('button')].find(button => button.textContent === 'Remove')!
    expect(remove.classList.contains('dsh-dot-mcp-remove')).toBe(true)
    expect(grantZone.contains(remove)).toBe(false)

    await act(async () => reset.click())
    await act(async () => { await Promise.resolve() })
    expect(current.capabilities.grants['mcp:deepwiki']).toBeUndefined()
    // The server itself survives an override reset.
    expect(current.mcpServers?.deepwiki).toBeDefined()
    await act(async () => root.unmount())
  })

  it('grants a server tool from the unified server card and edits credentials there', async () => {
    let current: DotSettings = { ...DEFAULT_SETTINGS, mcpServers: { deepwiki: { url: 'https://mcp.deepwiki.com/mcp', enabled: true } } }
    const api = apiStub({
      capabilities: async () => capabilitiesView(),
      mcpList: async () => mcpListView(),
      setSettings: async (patch: Record<string, unknown>) => { current = { ...current, ...patch } as DotSettings; return current },
    })
    const Harness = () => {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" section="mcp" api={api as never} settings={settings} onSaved={next => { current = next; setSettings(next) }} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })

    const card = [...document.querySelectorAll('.dsh-dot-mcp-row')].find(row => row.querySelector('.dsh-dot-mcp-name')?.textContent === 'deepwiki')!
    const ask = [...card.querySelectorAll<HTMLElement>('.dsh-dot-mcp-grant [role="tab"]')].find(node => node.textContent === 'Ask')!
    await act(async () => ask.click())
    await act(async () => { await Promise.resolve() })
    expect(current.capabilities.grants['mcp:deepwiki']).toBe('ask')
    expect(card.querySelector('.dsh-dot-mcp-grant [aria-selected="true"]')?.textContent).toBe('Ask')
    await act(async () => root.unmount())
  })

  it('connects the recommended catalog entry without leaving the unified view', async () => {
    const saved: Array<Record<string, unknown>> = []
    const api = apiStub({
      capabilities: async () => capabilitiesView(),
      mcpList: async () => mcpListView(),
      setSettings: async (patch: Record<string, unknown>) => { saved.push(patch); return DEFAULT_SETTINGS },
    })
    const root = createRoot(document.getElementById('root')!)
    await renderPanel(root, api, 'capabilities')
    const connect = [...document.querySelectorAll('button')].find(button => button.textContent === 'Connect')!
    await act(async () => connect.click())
    await act(async () => { await Promise.resolve() })
    expect(saved).toEqual([{ mcpServers: { context7: { catalog: 'context7', url: 'https://mcp.context7.com/mcp', enabled: true } } }])
    await act(async () => root.unmount())
  })

  it('still works when the capabilities API is absent, mcp-only', async () => {
    const api = apiStub({ mcpList: async () => mcpListView() })
    const root = createRoot(document.getElementById('root')!)
    await renderPanel(root, api, 'mcp')
    expect(document.querySelector('.dsh-dot-mcp')).not.toBeNull()
    expect(document.querySelector('.dsh-dot-caps')).toBeNull()
    expect(document.body.textContent).toContain('Connected')
    await act(async () => root.unmount())
  })

  it('still works when the mcp API is absent, capabilities-only', async () => {
    const api = apiStub({ capabilities: async () => capabilitiesView() })
    const root = createRoot(document.getElementById('root')!)
    await renderPanel(root, api, 'capabilities')
    expect(document.querySelector('.dsh-dot-caps')).not.toBeNull()
    expect(document.querySelector('.dsh-dot-mcp')).toBeNull()
    // Dot-local servers cannot be managed here, so un-managed mcp groups list plainly.
    expect(document.body.textContent).toContain('MCP servers')
    await act(async () => root.unmount())
  })

  it('keeps custom-server validation inside the unified form', async () => {
    const saved: Array<Record<string, unknown>> = []
    const api = apiStub({
      capabilities: async () => capabilitiesView(),
      mcpList: async () => mcpListView(),
      setSettings: async (patch: Record<string, unknown>) => { saved.push(patch); return DEFAULT_SETTINGS },
    })
    const root = createRoot(document.getElementById('root')!)
    await renderPanel(root, api, 'mcp')
    const [nameIn, urlIn] = [...document.querySelectorAll<HTMLInputElement>('.dsh-dot-mcp-custom-body input')]
    await act(async () => { type(nameIn!, 'bad__name'); type(urlIn!, 'https://a.example/mcp') })
    const add = [...document.querySelectorAll('button')].find(button => button.textContent === 'Add')!
    await act(async () => add.click())
    await act(async () => { await Promise.resolve() })
    expect(saved).toEqual([])
    expect(document.querySelector('.dsh-dot-mcp-custom-body .dsh-ui-error')?.textContent).toContain('1–32')
    await act(async () => root.unmount())
  })
})
