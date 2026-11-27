import { act, useState } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GITHUB_POLL_SETTINGS, DEFAULT_SETTINGS, type DotSettings, type GithubPollStatusView, type GithubPollTestResult } from './contracts.ts'
import { SettingsPanel, settingsCss } from './settings-panel.tsx'

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
const blur = (element: HTMLElement) => element.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))

describe('routine check setting', () => {
  it('saves the interval when the field loses focus and takes back a value the host would refuse', async () => {
    const saved: Array<Partial<DotSettings>> = []
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => { saved.push(patch); current = { ...current, ...patch } as DotSettings; return current },
    }
    function Harness({ locale }: { locale: 'zh' | 'en' }) {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale={locale} api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness locale="en" />))
    await act(async () => { await Promise.resolve() })
    const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Routine check"]')!
    expect(input().value).toBe('10')
    expect(input().type).toBe('number')
    expect(document.body.textContent).toContain('0 turns it off')

    await act(async () => { type(input(), '30') })
    await act(async () => { blur(input()) })
    expect(saved).toEqual([{ idleCheckMinutes: 30 }])
    expect(input().value).toBe('30')

    // Not whole minutes, or outside 0–1440: nothing is sent and the saved value comes back.
    for (const bad of ['1.5', '1441', '-1', '']) {
      await act(async () => { type(input(), bad) })
      await act(async () => { blur(input()) })
      expect(input().value).toBe('30')
    }
    expect(saved).toHaveLength(1)

    await act(async () => { type(input(), '0') })
    await act(async () => { blur(input()) })
    expect(saved.at(-1)).toEqual({ idleCheckMinutes: 0 })

    // Unchanged value: no write.
    await act(async () => { blur(input()) })
    expect(saved).toHaveLength(2)

    await act(async () => root.render(<Harness locale="zh" />))
    expect(document.querySelector('input[aria-label="例行检查"]')).not.toBeNull()
    expect(document.body.textContent).toContain('分钟')
    await act(async () => root.unmount())
  })

  it('can be locked like the other settings', async () => {
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const api = {
      models: async () => ({ groups: [] }), settings: async () => current, settingProposals: async () => [], decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => { current = { ...current, ...patch } as DotSettings; return current },
    }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    const lock = [...document.querySelectorAll<HTMLButtonElement>('.dsh-dot-lock')].find(button => button.getAttribute('aria-label')?.includes('Routine check'))!
    expect(lock).toBeDefined()
    await act(async () => lock.click())
    expect(current.locks).toEqual({ idleCheckMinutes: true })
    await act(async () => root.unmount())
  })
})

describe('cache keepalive setting', () => {
  it('shows the resolved minutes and writes overrides per provider/model', async () => {
    const saved: Array<Partial<DotSettings>> = []
    let current: DotSettings = { ...DEFAULT_SETTINGS, cacheTtl: { 'p/base': 12 } }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      keepalive: async () => ({ provider: 'p', model: 'base', minutes: current.cacheTtl?.['p/base'] ?? 5, defaultMinutes: 5 }),
      setSettings: async (patch: Partial<DotSettings>) => { saved.push(patch); current = { ...current, ...patch } as DotSettings; return current },
    }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Cache lifetime"]')!
    expect(input().value).toBe('12')
    expect(document.body.textContent).toContain('p/base')

    // A different value is stored as an override for the current provider/model.
    await act(async () => { type(input(), '30') })
    await act(async () => { blur(input()) })
    expect(saved.at(-1)).toEqual({ cacheTtl: { 'p/base': 30 } })

    // Committing the built-in default removes the key instead of storing it.
    await act(async () => { type(input(), '5') })
    await act(async () => { blur(input()) })
    expect(saved.at(-1)).toEqual({ cacheTtl: {} })

    await act(async () => { await Promise.resolve() })
    expect(input().value).toBe('5')
    await act(async () => root.unmount())
  })

  it('hides the row when the host reports no model', async () => {
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      keepalive: async () => undefined,
      setSettings: async (patch: Partial<DotSettings>) => { current = { ...current, ...patch } as DotSettings; return current },
    }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('input[aria-label="Cache lifetime"]')).toBeNull()
    await act(async () => root.unmount())
  })
})

describe('factory reset', () => {
  it('previews the wipe then confirms with the issued token', async () => {
    const tokens: string[] = []
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => { current = { ...current, ...patch } as DotSettings; return current },
      previewFactoryReset: async () => ({
        token: 'tok-1', expiresAt: Date.now() + 60_000,
        tasks: 2, changes: 3, runs: 1, schedules: 0, recipes: 0, proposals: 0, cards: 0, inbox: 0,
        ownedSessions: 1, pastSegments: 0, reflections: 0, hasAgreements: true, hasCognition: false,
        archiveSessionIds: ['s-owned'],
      }),
      confirmFactoryReset: async (token: string) => { tokens.push(token); current = { ...DEFAULT_SETTINGS }; return { archived: ['s-owned'], archiveFailed: [], sessionId: 'dot-new', at: 1 } },
    }
    let current: DotSettings = { ...DEFAULT_SETTINGS, scope: 'all' }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('Factory reset')
    const previewBtn = [...document.querySelectorAll('button')].find(button => button.textContent === 'Preview what will be cleared')!
    await act(async () => previewBtn.click())
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('2 tracked session(s)')
    expect(document.body.textContent).toContain('Agreements will be cleared')
    expect(document.body.textContent).toContain('Your own sessions, project files and the host persona')
    const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === 'Restore factory settings')!
    await act(async () => confirm.click())
    await act(async () => { await Promise.resolve() })
    expect(tokens).toEqual(['tok-1'])
    expect(document.body.textContent).toContain('Factory settings restored.')
    await act(async () => root.unmount())
  })

  it('shows an aborted reset instead of pretending it succeeded', async () => {
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => { current = { ...current, ...patch } as DotSettings; return current },
      previewFactoryReset: async () => ({
        token: 'tok-2', expiresAt: Date.now() + 60_000,
        tasks: 1, changes: 1, runs: 1, schedules: 0, recipes: 0, proposals: 0, cards: 0, inbox: 0,
        ownedSessions: 1, pastSegments: 0, reflections: 0, hasAgreements: false, hasCognition: false,
        archiveSessionIds: ['writer-1'],
      }),
      confirmFactoryReset: async () => { throw new Error('factory reset aborted: 1 session(s) not settled (writer-1: owned jobs UNKNOWN). Stop them first, then retry.') },
    }
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    const previewBtn = [...document.querySelectorAll('button')].find(button => button.textContent === 'Preview what will be cleared')!
    await act(async () => previewBtn.click())
    await act(async () => { await Promise.resolve() })
    const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === 'Restore factory settings')!
    await act(async () => confirm.click())
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('owned jobs UNKNOWN')
    expect(document.body.textContent).not.toContain('Factory settings restored.')
    const retry = [...document.querySelectorAll('button')].find(button => button.textContent === 'Preview and retry')!
    expect(retry).toBeDefined()
    await act(async () => retry.click())
    expect(document.body.textContent).toContain('1 run(s)')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Restore factory settings')).toBe(true)
    await act(async () => root.unmount())
  })
})

describe('auto update setting', () => {
  it('saves the toggle, shows the last check result, and checks on demand', async () => {
    const saved: Array<Partial<DotSettings>> = []
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const checks: string[] = []
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => { saved.push(patch); current = { ...current, ...patch } as DotSettings; return current },
      updateStatus: async () => ({ lastCheckAt: Date.parse('2025-11-20T12:00:00'), lastResult: { kind: 'up-to-date', at: Date.parse('2025-11-20T12:00:00') } }),
      updateCheck: async () => { checks.push('x'); return { lastCheckAt: Date.parse('2025-11-20T15:00:00'), lastResult: { kind: 'updated', at: Date.parse('2025-11-20T15:00:00'), from: '0.3.0', to: '0.3.1' } } },
    }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('Last check:')
    expect(document.body.textContent).toContain('Up to date')

    const toggle = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Auto update"]')!
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await act(async () => toggle.click())
    expect(saved).toEqual([{ autoUpdate: false }])

    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(row => row.textContent === 'Check now')!
    await act(async () => button.click())
    await act(async () => { await Promise.resolve() })
    expect(checks).toHaveLength(1)
    expect(document.body.textContent).toContain('Updated from 0.3.0 to 0.3.1')
    await act(async () => root.unmount())
  })

  it('hides the status line and check button without the update API', async () => {
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => { current = { ...current, ...patch } as DotSettings; return current },
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" api={api as never} settings={current} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('button[role="switch"][aria-label="Auto update"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Last check:')
    expect([...document.querySelectorAll('button')].some(row => row.textContent === 'Check now')).toBe(false)
    await act(async () => root.unmount())
  })
})

describe('sectioned settings, switches, and help tips', () => {
  it('renders each settings section in isolation and toggles reflection via Switch', async () => {
    let current: DotSettings = { ...DEFAULT_SETTINGS, taskModels: { mode: 'allow', list: [] } }
    const decisions: Array<{ id: string; allow: boolean }> = []
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [{ id: 'p-1', field: 'reflection' as const, before: true, after: false, reason: 'save turns', createdAt: 1 }],
      decideSetting: async (id: string, allow: boolean) => { decisions.push({ id, allow }); return 'ok' },
      keepalive: async () => ({ provider: 'p', model: 'base', minutes: 60, defaultMinutes: 60 }),
      updateStatus: async () => null,
      updateCheck: async () => ({}),
      capabilities: async () => ({ locked: ['dot_overview'], groups: [] }),
      previewFactoryReset: async () => ({ token: 't', expiresAt: 1, tasks: 0, changes: 0, runs: 0, schedules: 0, proposals: 0, cards: 0, inbox: 0, ownedSessions: 0, pastSegments: 0, reflections: 0, hasAgreements: false, hasCognition: false, archiveSessionIds: [] }),
      confirmFactoryReset: async () => ({ archived: [], archiveFailed: [], sessionId: 's', at: 1 }),
      setSettings: async (patch: Partial<DotSettings>) => { current = { ...current, ...patch } as DotSettings; return current },
    }
    function Harness({ section }: { section: 'general' | 'takeover' | 'dispatch' | 'capabilities' | 'proposals' }) {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" api={api as never} section={section} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)

    // General: model, cache lifetime, reflection switch, auto update switch, factory reset — zero static .dsh-ui-help paragraphs.
    await act(async () => root.render(<Harness section="general" />))
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('select[aria-label="Dorothy\'s model"]')).not.toBeNull()
    expect(document.querySelector('input[aria-label="Cache lifetime"]')).not.toBeNull()
    const reflSwitch = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Background reflection"]')!
    expect(reflSwitch.getAttribute('aria-checked')).toBe('true')
    await act(async () => reflSwitch.click())
    expect(current.reflection).toBe(false)
    expect(document.querySelector('button[role="switch"][aria-label="Auto update"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Factory reset')
    expect(document.querySelectorAll('.dsh-ui-help')).toHaveLength(0)
    expect(document.querySelectorAll('.dsh-dot-help-tip').length).toBeGreaterThanOrEqual(4)
    expect(document.querySelector('[role="tablist"][aria-label="Scope"]')).toBeNull()
    expect(document.querySelector('[role="tablist"][aria-label="Task permissions"]')).toBeNull()

    // Takeover: scope, approvals, questions only (task permissions moved to dispatch).
    await act(async () => root.render(<Harness section="takeover" />))
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[role="tablist"][aria-label="Scope"]')).not.toBeNull()
    expect(document.querySelector('[role="tablist"][aria-label="Permission approvals"]')).not.toBeNull()
    expect(document.querySelector('[role="tablist"][aria-label="Model questions"]')).not.toBeNull()
    expect(document.querySelector('[role="tablist"][aria-label="Task permissions"]')).toBeNull()
    expect(document.querySelectorAll('.dsh-ui-help')).toHaveLength(0)
    expect(document.querySelectorAll('.dsh-dot-help-tip')).toHaveLength(3)

    // Dispatch: task permissions, default task preset, task models (with dynamic empty-allow-list warning inline), routine check.
    await act(async () => root.render(<Harness section="dispatch" />))
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[role="tablist"][aria-label="Task permissions"]')).not.toBeNull()
    expect(document.querySelector('select[aria-label="Default task preset"]')).not.toBeNull()
    expect(document.querySelector('[role="tablist"][aria-label="Allowed task models"]')).not.toBeNull()
    expect(document.querySelector('input[aria-label="Routine check"]')).not.toBeNull()
    const inlineHelps = [...document.querySelectorAll('.dsh-ui-help')].map(el => el.textContent)
    expect(inlineHelps).toEqual(['No models selected — cannot start new tasks.'])
    expect(document.querySelectorAll('.dsh-dot-help-tip')).toHaveLength(3)

    // Capabilities: single header without redundant outer section heading.
    await act(async () => root.render(<Harness section="capabilities" />))
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-pane-section-title')).toBeNull()
    expect(document.querySelector('.dsh-dot-caps')).not.toBeNull()
    expect(document.querySelectorAll('.dsh-dot-help-tip')).toHaveLength(1)

    // Proposals: renders pending boolean reflection proposal chips and applies decision.
    await act(async () => root.render(<Harness section="proposals" />))
    await act(async () => { await Promise.resolve() })
    const chips = [...document.querySelectorAll('.dsh-dot-proposal-chip')].map(node => node.textContent)
    expect(chips).toEqual(['On', 'Off'])
    await act(async () => document.querySelector<HTMLButtonElement>('.dsh-dot-proposal button')!.click())
    expect(decisions).toEqual([{ id: 'p-1', allow: true }])

    await act(async () => root.unmount())
  })

  it('marks a task-only tool with a badge and no picker, and no auto-confirm exists', async () => {
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      capabilities: async () => ({
        locked: [],
        groups: [{
          id: 'host', kind: 'host', label: 'Unattributed',
          tools: [
            { name: 'bash', conditional: false, taskOnly: true },
            { name: 'extra_tool', conditional: false },
          ],
        }],
        applied: {},
      }),
      setSettings: async (patch: Partial<DotSettings>) => { current = { ...current, ...patch } as DotSettings; return current },
    }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" api={api as never} section="capabilities" settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    const rows = [...document.querySelectorAll('.dsh-dot-cap-row')]
    const bash = rows.find(row => row.textContent?.includes('bash'))!
    const badge = bash.querySelector('.dsh-dot-cap-badge--warn')!
    expect(badge.textContent).toBe('Tasks only')
    expect(badge.getAttribute('title')).toContain('dispatches a task')
    expect(bash.querySelector('[role="tablist"]')).toBeNull()
    const extra = rows.find(row => row.textContent?.includes('extra_tool'))!
    expect(extra.querySelector('[role="tablist"]')).not.toBeNull()
    expect(document.querySelector('.dsh-dot-cap-confirm')).toBeNull()
    await act(async () => root.unmount())
  })

  it('hides the group picker when every tool in the group is task-only, but keeps it for mixed groups', async () => {
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      capabilities: async () => ({
        locked: [],
        groups: [
          {
            id: 'plugin:manage', kind: 'plugin', label: 'Manage',
            tools: [{ name: 'plugin_manager', conditional: false, taskOnly: true }],
          },
          {
            id: 'plugin:mixed', kind: 'plugin', label: 'Mixed',
            tools: [
              { name: 'bash', conditional: false, taskOnly: true },
              { name: 'extra_tool', conditional: false },
            ],
          },
        ],
        applied: {},
      }),
      setSettings: async (patch: Partial<DotSettings>) => { current = { ...current, ...patch } as DotSettings; return current },
    }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" api={api as never} section="capabilities" settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    const groups = [...document.querySelectorAll('.dsh-dot-cap-group')]
    const manage = groups.find(group => group.textContent?.includes('plugin_manager'))!
    expect(manage.querySelector(':scope > summary [role="tablist"]')).toBeNull()
    const mixed = groups.find(group => group.textContent?.includes('extra_tool'))!
    expect(mixed.querySelector(':scope > summary [role="tablist"]')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('resets a leftover task-only grant and keeps the other grants', async () => {
    let current: DotSettings = {
      ...DEFAULT_SETTINGS,
      capabilities: { grants: { 'tool:bash': 'ask', 'tool:extra_tool': 'auto', 'plugin:manage': 'ask' } },
    }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      capabilities: async () => ({
        locked: [],
        groups: [
          {
            id: 'host', kind: 'host', label: 'Unattributed',
            tools: [
              { name: 'bash', conditional: false, taskOnly: true },
              { name: 'extra_tool', conditional: false },
            ],
          },
          {
            id: 'plugin:manage', kind: 'plugin', label: 'Manage',
            tools: [{ name: 'plugin_manager', conditional: false, taskOnly: true }],
          },
        ],
        applied: { extra_tool: 'auto' as const },
      }),
      setSettings: async (patch: Partial<DotSettings>) => { current = { ...current, ...patch } as DotSettings; return current },
    }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" api={api as never} section="capabilities" settings={settings} onSaved={next => { current = next; setSettings(next) }} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    const rows = [...document.querySelectorAll('.dsh-dot-cap-row')]
    const bash = rows.find(row => row.textContent?.includes('bash'))!
    expect(bash.querySelector('[role="tablist"]')).toBeNull()
    const bashReset = bash.querySelector<HTMLButtonElement>('.dsh-dot-cap-clear')!
    expect(bashReset.textContent).toBe('Reset to inherited')
    await act(async () => bashReset.click())
    await act(async () => { await Promise.resolve() })
    expect(current.capabilities.grants['tool:bash']).toBeUndefined()
    expect(current.capabilities.grants['tool:extra_tool']).toBe('auto')
    expect(current.capabilities.grants['plugin:manage']).toBe('ask')

    const groups = [...document.querySelectorAll('.dsh-dot-cap-group')]
    const manage = groups.find(group => group.querySelector(':scope > summary')?.textContent?.includes('Manage'))!
    expect(manage.querySelector(':scope > summary [role="tablist"]')).toBeNull()
    const groupReset = manage.querySelector<HTMLButtonElement>(':scope > summary .dsh-dot-cap-clear')!
    expect(groupReset.textContent).toBe('Reset to inherited')
    await act(async () => groupReset.click())
    await act(async () => { await Promise.resolve() })
    expect(current.capabilities.grants['plugin:manage']).toBeUndefined()
    expect(current.capabilities.grants['tool:extra_tool']).toBe('auto')
    await act(async () => root.unmount())
  })

  it('skips task-only tools when computing group next-segment badges and expansion', async () => {
    let current: DotSettings = {
      ...DEFAULT_SETTINGS,
      capabilities: { grants: { 'plugin:mixed': 'auto', 'plugin:manage': 'ask' } },
    }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      capabilities: async () => ({
        locked: [],
        groups: [
          {
            id: 'plugin:mixed', kind: 'plugin', label: 'Mixed',
            tools: [
              { name: 'plugin_manager', conditional: false, taskOnly: true },
              { name: 'extra_tool', conditional: false },
            ],
          },
          {
            id: 'plugin:manage', kind: 'plugin', label: 'Manage',
            tools: [{ name: 'plugin_manager_only', conditional: false, taskOnly: true }],
          },
        ],
        applied: { extra_tool: 'auto' as const },
      }),
      setSettings: async (patch: Partial<DotSettings>) => { current = { ...current, ...patch } as DotSettings; return current },
    }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" api={api as never} section="capabilities" settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    const groups = [...document.querySelectorAll('.dsh-dot-cap-group')]
    const mixed = groups.find(group => group.querySelector(':scope > summary')?.textContent?.includes('Mixed'))!
    expect(mixed.querySelector(':scope > summary')!.textContent).not.toContain('Applies next segment')
    expect(mixed.querySelector(':scope > summary [role="tablist"]')).not.toBeNull()
    const manage = groups.find(group => group.querySelector(':scope > summary')?.textContent?.includes('Manage'))!
    expect(manage.querySelector(':scope > summary')!.textContent).not.toContain('Applies next segment')
    expect((manage as HTMLDetailsElement).open).toBe(false)
    expect(manage.querySelector(':scope > summary .dsh-dot-cap-clear')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('keeps model-load failure warnings inline instead of hiding them in tooltips', async () => {
    const api = {
      models: async () => { throw new Error('offline') },
      settings: async () => DEFAULT_SETTINGS,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async () => DEFAULT_SETTINGS,
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="general" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.dsh-ui-warn')?.textContent).toContain('Could not load the model list')
    await act(async () => root.unmount())
  })

  it('shows a Model questions help tip for every option', async () => {
    let current: DotSettings = { ...DEFAULT_SETTINGS, questions: 'dot' }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => { current = { ...current, ...patch } as DotSettings; return current },
    }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" section="takeover" api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })

    const tip = () => document.querySelector<HTMLButtonElement>('button.dsh-dot-help-tip[aria-label="About Model questions"]')
    const tabNamed = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Model questions"] [role="tab"]')].find(el => el.textContent === label)!
    expect(tip()).not.toBeNull()

    await act(async () => tabNamed('Me').click())
    await act(async () => { await Promise.resolve() })
    expect(current.questions).toBe('human')
    expect(tip()).not.toBeNull()

    await act(async () => tabNamed('Hands off').click())
    await act(async () => { await Promise.resolve() })
    expect(current.questions).toBe('off')
    expect(tip()).not.toBeNull()

    await act(async () => tabNamed('Dorothy').click())
    await act(async () => { await Promise.resolve() })
    expect(current.questions).toBe('dot')
    expect(tip()).not.toBeNull()

    await act(async () => root.unmount())
  })
})

describe('desktop notifications switch', () => {
  const apiStub = () => ({
    models: async () => ({ groups: [] }),
    settings: async () => DEFAULT_SETTINGS,
    settingProposals: async () => [],
    decideSetting: async () => 'ok',
    setSettings: async () => DEFAULT_SETTINGS,
  })
  const restoreBaseGlobals = () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('navigator', dom.window.navigator)
  }

  it('asks for permission inside the click and keeps the pref browser-local', async () => {
    vi.stubGlobal('localStorage', dom.window.localStorage)
    dom.window.localStorage.clear()
    const fakeNotification = {
      permission: 'default' as string,
      requestPermission: vi.fn(async () => { fakeNotification.permission = 'granted'; return 'granted' as const }),
    }
    vi.stubGlobal('Notification', fakeNotification)
    try {
      const api = apiStub()
      const root = createRoot(document.getElementById('root')!)
      await act(async () => root.render(<SettingsPanel locale="en" section="general" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
      await act(async () => { await Promise.resolve() })
      const toggle = () => document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Desktop notifications"]')!
      expect(toggle().getAttribute('aria-checked')).toBe('false')

      await act(async () => toggle().click())
      await act(async () => { await Promise.resolve() })
      expect(fakeNotification.requestPermission).toHaveBeenCalledTimes(1)
      expect(dom.window.localStorage.getItem('dsh-dot:desktop-notify')).toBe('1')
      expect(toggle().getAttribute('aria-checked')).toBe('true')

      await act(async () => toggle().click())
      expect(dom.window.localStorage.getItem('dsh-dot:desktop-notify')).toBeNull()
      expect(toggle().getAttribute('aria-checked')).toBe('false')
      await act(async () => root.unmount())
    } finally {
      restoreBaseGlobals()
    }
  })

  it('stays off with an inline note when the browser refuses or lacks support', async () => {
    vi.stubGlobal('localStorage', dom.window.localStorage)
    dom.window.localStorage.clear()
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'denied' as const })
    try {
      const api = apiStub()
      const root = createRoot(document.getElementById('root')!)
      await act(async () => root.render(<SettingsPanel locale="en" section="general" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
      await act(async () => { await Promise.resolve() })
      const toggle = () => document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Desktop notifications"]')!

      await act(async () => toggle().click())
      await act(async () => { await Promise.resolve() })
      expect(toggle().getAttribute('aria-checked')).toBe('false')
      expect(dom.window.localStorage.getItem('dsh-dot:desktop-notify')).toBeNull()
      expect(document.body.textContent).toContain('Blocked by the browser')

      vi.stubGlobal('Notification', undefined)
      await act(async () => toggle().click())
      await act(async () => { await Promise.resolve() })
      expect(toggle().getAttribute('aria-checked')).toBe('false')
      expect(document.body.textContent).toContain('Not supported by this browser')
      await act(async () => root.unmount())
    } finally {
      restoreBaseGlobals()
    }
  })
})

describe('MCP servers page', () => {
  const apiStub = (over: Record<string, unknown> = {}) => ({
    models: async () => ({ groups: [] }),
    settings: async () => DEFAULT_SETTINGS,
    settingProposals: async () => [],
    decideSetting: async () => 'ok',
    setSettings: async () => DEFAULT_SETTINGS,
    ...over,
  })

  it('shows token-less servers waiting and saves the credential through its own RPC', async () => {
    const setCalls: Array<{ server: string; value: string }> = []
    const api = apiStub({
      mcpList: async () => ({
        servers: [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/readonly', enabled: true, auth: 'token', credential: { ref: 'DOT_MCP_GITHUB_TOKEN', configured: false }, status: { state: 'waiting-credentials', diagnostic: 'missing token' }, tokenUrl: 'https://github.com/settings/personal-access-tokens/new' }],
        catalog: [{ id: 'deepwiki', name: 'DeepWiki', about: 'sMcpAbout_deepwiki', url: 'https://mcp.deepwiki.com/mcp', auth: 'none' }],
      }),
      mcpCredentialSet: async (server: string, value: string) => { setCalls.push({ server, value }); return { configured: true, masked: '•••1' } },
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="mcp" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('Connected')
    expect(document.body.textContent).toContain('Waiting for token')
    expect(document.body.textContent).toContain('Recommended')
    // A token-auth row without a configured credential keeps the inline field open.
    const input = document.querySelector<HTMLInputElement>('input[type="password"]')!
    expect(input).toBeTruthy()
    expect(document.body.textContent).toContain('Create a token')
    await act(async () => { type(input, 'tok-123') })
    const save = [...document.querySelectorAll('button')].find(button => button.textContent === 'Save')!
    await act(async () => save.click())
    await act(async () => { await Promise.resolve() })
    expect(setCalls).toEqual([{ server: 'github', value: 'tok-123' }])
    await act(async () => root.unmount())
  })

  it('connects a no-auth catalog entry with one settings patch', async () => {
    const saved: Array<Record<string, unknown>> = []
    const api = apiStub({
      setSettings: async (patch: Record<string, unknown>) => { saved.push(patch); return DEFAULT_SETTINGS },
      mcpList: async () => ({
        servers: [],
        catalog: [{ id: 'deepwiki', name: 'DeepWiki', about: 'sMcpAbout_deepwiki', url: 'https://mcp.deepwiki.com/mcp', auth: 'none' }],
      }),
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="mcp" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    const connect = [...document.querySelectorAll('button')].find(button => button.textContent === 'Connect')!
    await act(async () => connect.click())
    await act(async () => { await Promise.resolve() })
    expect(saved).toEqual([{ mcpServers: { deepwiki: { catalog: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', enabled: true } } }])
    await act(async () => root.unmount())
  })

  it('reflects a grant pick after the settings round-trip', async () => {
    // Mirrors chat-panel's wiring: the panel owns settings state and onSaved
    // replaces it, so the picker must show the new grant once the patch lands.
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const api = apiStub({
      setSettings: async (patch: Record<string, unknown>) => {
        current = { ...current, ...patch } as DotSettings
        return current
      },
      mcpList: async () => ({
        servers: [{ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', enabled: true, auth: 'none', status: { state: 'connected', toolCount: 3 } }],
        catalog: [],
      }),
    })
    const Harness = () => {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" section="mcp" api={api as never} settings={settings} onSaved={next => { current = next; setSettings(next) }} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })
    const row = document.querySelector('.dsh-dot-mcp-row')!
    const auto = [...row.querySelectorAll<HTMLElement>('[role="tab"]')].find(node => node.textContent === 'Auto')!
    await act(async () => auto.click())
    await act(async () => { await Promise.resolve() })
    expect(current.capabilities?.grants).toEqual({ 'mcp:deepwiki': 'auto' })
    expect(row.querySelector('[aria-selected="true"]')?.textContent).toBe('Auto')
    await act(async () => root.unmount())
  })

  it('keeps the custom form and shows the error when the settings save fails', async () => {
    const api = apiStub({
      setSettings: async () => { throw new Error('store exploded') },
      mcpList: async () => ({ servers: [], catalog: [] }),
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="mcp" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    const [nameIn, urlIn] = [...document.querySelectorAll<HTMLInputElement>('.dsh-dot-mcp-custom-body input')]
    await act(async () => { type(nameIn!, 'alpha'); type(urlIn!, 'https://a.example/mcp') })
    const add = [...document.querySelectorAll('button')].find(button => button.textContent === 'Add')!
    await act(async () => add.click())
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-mcp > .dsh-ui-error')?.textContent).toContain('store exploded')
    expect(nameIn!.value).toBe('alpha')
    expect(urlIn!.value).toBe('https://a.example/mcp')
    await act(async () => root.unmount())
  })

  it('shows the error and keeps the form when storing the token fails', async () => {
    const unset: string[] = []
    const api = apiStub({
      setSettings: async () => DEFAULT_SETTINGS,
      mcpList: async () => ({ servers: [], catalog: [] }),
      mcpCredentialSet: async () => { throw new Error('vault closed') },
      mcpCredentialUnset: async (server: string) => { unset.push(server); return { configured: false } },
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="mcp" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    const [nameIn, urlIn, tokenIn] = [...document.querySelectorAll<HTMLInputElement>('.dsh-dot-mcp-custom-body input')]
    await act(async () => { type(nameIn!, 'alpha'); type(urlIn!, 'https://a.example/mcp'); type(tokenIn!, 'tok-1') })
    const add = [...document.querySelectorAll('button')].find(button => button.textContent === 'Add')!
    await act(async () => add.click())
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-mcp > .dsh-ui-error')?.textContent).toContain('vault closed')
    expect(nameIn!.value).toBe('alpha')
    expect(tokenIn!.value).toBe('tok-1')
    expect(unset).toEqual([])
    await act(async () => root.unmount())
  })

  it('connects a token-auth catalog entry row-first, then stores the token', async () => {
    // mcp.credential.set only accepts a stored mcpServers name, so the row
    // must land before the token write.
    const order: string[] = []
    const saved: Array<Record<string, unknown>> = []
    const setCalls: Array<{ server: string; value: string }> = []
    const api = apiStub({
      setSettings: async (patch: Record<string, unknown>) => { order.push('settings'); saved.push(patch); return DEFAULT_SETTINGS },
      mcpList: async () => ({
        servers: [],
        catalog: [{ id: 'github', name: 'GitHub', about: 'sMcpAbout_github', url: 'https://api.githubcopilot.com/mcp/readonly', auth: 'token', headers: { Authorization: 'Bearer ${credential:DOT_MCP_GITHUB_TOKEN}' } }],
      }),
      mcpCredentialSet: async (server: string, value: string) => { order.push('credential'); setCalls.push({ server, value }); return { configured: true, masked: '•••1' } },
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="mcp" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    const open = [...document.querySelectorAll('button')].find(button => button.textContent === 'Connect')!
    await act(async () => open.click())
    await act(async () => { await Promise.resolve() })
    const input = document.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => { type(input, 'tok-9') })
    const connect = [...document.querySelectorAll('button')].filter(button => button.textContent === 'Connect').pop()!
    await act(async () => connect.click())
    await act(async () => { await Promise.resolve() })
    expect(order).toEqual(['settings', 'credential'])
    expect(saved).toEqual([{ mcpServers: { github: { catalog: 'github', url: 'https://api.githubcopilot.com/mcp/readonly', headers: { Authorization: 'Bearer ${credential:DOT_MCP_GITHUB_TOKEN}' }, enabled: true } } }])
    expect(setCalls).toEqual([{ server: 'github', value: 'tok-9' }])
    await act(async () => root.unmount())
  })

  it('keeps the saved row when the following token write fails', async () => {
    const order: string[] = []
    const api = apiStub({
      setSettings: async () => { order.push('settings'); return DEFAULT_SETTINGS },
      mcpList: async () => ({ servers: [], catalog: [] }),
      mcpCredentialSet: async () => { order.push('credential'); throw new Error('vault closed') },
      mcpCredentialUnset: async () => { order.push('unset'); return { configured: false } },
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="mcp" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    const [nameIn, urlIn, tokenIn] = [...document.querySelectorAll<HTMLInputElement>('.dsh-dot-mcp-custom-body input')]
    await act(async () => { type(nameIn!, 'alpha'); type(urlIn!, 'https://a.example/mcp'); type(tokenIn!, 'tok-1') })
    const add = [...document.querySelectorAll('button')].find(button => button.textContent === 'Add')!
    await act(async () => add.click())
    await act(async () => { await Promise.resolve() })
    // Row stays, no orphan-rollback fires, the failure surfaces.
    expect(order).toEqual(['settings', 'credential'])
    expect(document.querySelector('.dsh-dot-mcp > .dsh-ui-error')?.textContent).toContain('vault closed')
    expect(nameIn!.value).toBe('alpha')
    await act(async () => root.unmount())
  })

  it('never writes the token when the server row itself fails to save', async () => {
    const calls: string[] = []
    const api = apiStub({
      setSettings: async () => { throw new Error('store exploded') },
      mcpList: async () => ({ servers: [], catalog: [] }),
      mcpCredentialSet: async () => { calls.push('set'); return { configured: true } },
      mcpCredentialUnset: async () => { calls.push('unset'); return { configured: false } },
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="mcp" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    const [nameIn, urlIn, tokenIn] = [...document.querySelectorAll<HTMLInputElement>('.dsh-dot-mcp-custom-body input')]
    await act(async () => { type(nameIn!, 'alpha'); type(urlIn!, 'https://a.example/mcp'); type(tokenIn!, 'tok-1') })
    const add = [...document.querySelectorAll('button')].find(button => button.textContent === 'Add')!
    await act(async () => add.click())
    await act(async () => { await Promise.resolve() })
    expect(calls).toEqual([])
    expect(document.querySelector('.dsh-dot-mcp > .dsh-ui-error')?.textContent).toContain('store exploded')
    await act(async () => root.unmount())
  })

  it('keeps a save error across list polling and clears it on the next save', async () => {
    let failNext = true
    let lists = 0
    const api = apiStub({
      setSettings: async () => { if (failNext) throw new Error('store exploded'); return DEFAULT_SETTINGS },
      mcpList: async () => { lists += 1; return { servers: [], catalog: [{ id: 'deepwiki', name: 'DeepWiki', about: 'sMcpAbout_deepwiki', url: 'https://mcp.deepwiki.com/mcp', auth: 'none' }] } },
    })
    // The poll interval must register on the fake clock, so timers go fake
    // before render; promise-based saves still flush through microtasks.
    vi.useFakeTimers()
    const root = createRoot(document.getElementById('root')!)
    try {
      await act(async () => root.render(<SettingsPanel locale="en" section="mcp" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
      await act(async () => { await Promise.resolve() })
      const connect = () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Connect')!
      await act(async () => connect().click())
      await act(async () => { await Promise.resolve() })
      expect(document.querySelector('.dsh-dot-mcp > .dsh-ui-error')?.textContent).toContain('store exploded')
      // Polls keep running on the load path; the save error survives them.
      await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve() })
      expect(lists).toBeGreaterThanOrEqual(2)
      expect(document.querySelector('.dsh-dot-mcp > .dsh-ui-error')?.textContent).toContain('store exploded')
      // The next successful save clears it.
      failNext = false
      await act(async () => connect().click())
      await act(async () => { await Promise.resolve() })
      expect(document.querySelector('.dsh-dot-mcp > .dsh-ui-error')).toBeNull()
    } finally {
      vi.useRealTimers()
      await act(async () => root.unmount())
    }
  })

  it('marks catalog entries that already exist as global servers', async () => {
    const api = apiStub({
      mcpList: async () => ({
        servers: [],
        catalog: [{ id: 'github', name: 'GitHub', about: 'sMcpAbout_github', url: 'https://api.githubcopilot.com/mcp/readonly', auth: 'token' }],
        globals: ['github'],
      }),
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="mcp" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('Already connected globally')
    expect(document.body.textContent).toContain('Grant it under Extra capabilities instead')
    expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Connect')).toBe(false)
    await act(async () => root.unmount())
  })

  it('rejects custom names that could split a tool prefix across two servers', async () => {
    const saved: Array<Record<string, unknown>> = []
    const api = apiStub({
      setSettings: async (patch: Record<string, unknown>) => { saved.push(patch); return DEFAULT_SETTINGS },
      mcpList: async () => ({ servers: [], catalog: [] }),
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="mcp" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    const [nameIn, urlIn] = [...document.querySelectorAll<HTMLInputElement>('.dsh-dot-mcp-custom-body input')]
    await act(async () => { type(nameIn!, 'team__docs'); type(urlIn!, 'https://a.example/mcp') })
    const add = [...document.querySelectorAll('button')].find(button => button.textContent === 'Add')!
    await act(async () => add.click())
    await act(async () => { await Promise.resolve() })
    expect(saved).toEqual([])
    expect(document.querySelector('.dsh-ui-error')?.textContent).toContain('1–32')
    await act(async () => root.unmount())
  })

  it('removes a server together with its grants in one patch', async () => {
    const saved: Array<Record<string, unknown>> = []
    const settings: DotSettings = {
      ...DEFAULT_SETTINGS,
      mcpServers: {
        deepwiki: { url: 'https://mcp.deepwiki.com/mcp', enabled: true },
        github: { catalog: 'github', url: 'https://api.githubcopilot.com/mcp/readonly', enabled: true },
      },
      capabilities: { grants: { 'mcp:deepwiki': 'auto', 'tool:mcp__deepwiki__read_wiki_structure': 'auto', 'mcp:github': 'off', 'tool:mcp__github__repo': 'ask' } },
    }
    const api = apiStub({
      setSettings: async (patch: Record<string, unknown>) => { saved.push(patch); return settings },
      mcpList: async () => ({
        servers: [
          { name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', enabled: true, auth: 'none', status: { state: 'connected', toolCount: 3 } },
          { name: 'github', url: 'https://api.githubcopilot.com/mcp/readonly', enabled: true, auth: 'token', credential: { ref: 'DOT_MCP_GITHUB_TOKEN', configured: true }, status: { state: 'connected', toolCount: 1 } },
        ],
        catalog: [],
      }),
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="mcp" api={api as never} settings={settings} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    const dw = [...document.querySelectorAll('.dsh-dot-mcp-row')].find(row => row.textContent?.includes('deepwiki'))!
    const remove = [...dw.querySelectorAll('button')].find(button => button.textContent === 'Remove')!
    await act(async () => remove.click())
    await act(async () => { await Promise.resolve() })
    expect(saved).toEqual([{
      mcpServers: { github: settings.mcpServers!.github },
      capabilities: { grants: { 'mcp:github': 'off', 'tool:mcp__github__repo': 'ask' } },
    }])
    await act(async () => root.unmount())
  })

  it('removing `team` keeps the grants longest-prefix gives to `team__docs`', async () => {
    // team__docs is a stored legacy row; `mcp__team__docs__search` belongs to
    // it, not to `team`, so it survives the removal patch.
    const saved: Array<Record<string, unknown>> = []
    const settings: DotSettings = {
      ...DEFAULT_SETTINGS,
      mcpServers: {
        team: { url: 'https://team.example/mcp', enabled: true },
        'team__docs': { url: 'https://docs.example/mcp', enabled: true },
      },
      capabilities: { grants: { 'mcp:team': 'auto', 'tool:mcp__team__list': 'ask', 'tool:mcp__team__docs__search': 'auto' } },
    }
    const api = apiStub({
      setSettings: async (patch: Record<string, unknown>) => { saved.push(patch); return settings },
      mcpList: async () => ({
        servers: [
          { name: 'team', url: 'https://team.example/mcp', enabled: true, auth: 'none' },
          { name: 'team__docs', url: 'https://docs.example/mcp', enabled: true, auth: 'none' },
        ],
        catalog: [],
      }),
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="mcp" api={api as never} settings={settings} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    const row = [...document.querySelectorAll('.dsh-dot-mcp-row')].find(node => node.querySelector('.dsh-dot-mcp-name')?.textContent === 'team')!
    const remove = [...row.querySelectorAll('button')].find(button => button.textContent === 'Remove')!
    await act(async () => remove.click())
    await act(async () => { await Promise.resolve() })
    expect(saved).toEqual([{
      mcpServers: { 'team__docs': settings.mcpServers!['team__docs'] },
      capabilities: { grants: { 'tool:mcp__team__docs__search': 'auto' } },
    }])
    await act(async () => root.unmount())
  })
})

describe('capabilities sections', () => {
  const groups = [
    { id: 'mcp:exa', kind: 'mcp' as const, label: 'exa', tools: [{ name: 'mcp__exa__search', conditional: false }] },
    { id: 'mcp:github', kind: 'mcp' as const, label: 'github', scope: 'dot' as const, status: { state: 'connected', toolCount: 1 }, tools: [{ name: 'mcp__github__repo', conditional: false }] },
    { id: 'plugin:p', kind: 'plugin' as const, label: 'p', tools: [{ name: 'pt_tool', conditional: false }] },
    { id: 'builtin', kind: 'builtin' as const, label: 'builtin', tools: [], children: [{ id: 'builtin:skill', kind: 'builtin' as const, label: 'skill', tools: [{ name: 'skill', conditional: false }] }] },
  ]

  it('renders section headings, the dot-only tag, and the enabled-only filter', async () => {
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => DEFAULT_SETTINGS,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async () => DEFAULT_SETTINGS,
      capabilities: async () => ({ locked: [], groups, grants: {}, applied: {} }),
    }
    const settings: DotSettings = { ...DEFAULT_SETTINGS, capabilities: { grants: { 'mcp:github': 'auto' } } }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="capabilities" api={api as never} settings={settings} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    const text = () => document.body.textContent ?? ''
    for (const heading of ['MCP servers', 'Plugins', 'Host tools']) expect(text()).toContain(heading)
    expect(text()).toContain('Dorothy only')
    // 只看已开启 drops groups whose effective grant is off.
    const toggle = () => [...document.querySelectorAll('input[type="checkbox"]')].find(input => input.closest('label')?.textContent === 'Enabled only')!
    await act(async () => toggle().click())
    await act(async () => { await Promise.resolve() })
    expect(text()).not.toContain('exa')
    expect(text()).not.toContain('pt_tool')
    expect(text()).toContain('github')
    await act(async () => root.unmount())
  })

  it('applies the enabled-only filter together with the search', async () => {
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => DEFAULT_SETTINGS,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async () => DEFAULT_SETTINGS,
      capabilities: async () => ({ locked: [], groups, grants: {}, applied: {} }),
    }
    const settings: DotSettings = { ...DEFAULT_SETTINGS, capabilities: { grants: { 'mcp:github': 'auto' } } }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="capabilities" api={api as never} settings={settings} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    const text = () => document.body.textContent ?? ''
    // 'mcp' matches both groups' ids; enabled-only must still drop exa.
    const search = document.querySelector<HTMLInputElement>('.dsh-dot-cap-search')!
    await act(async () => { type(search, 'mcp') })
    const toggle = [...document.querySelectorAll('input[type="checkbox"]')].find(input => input.closest('label')?.textContent === 'Enabled only')!
    await act(async () => toggle.click())
    await act(async () => { await Promise.resolve() })
    expect(text()).toContain('github')
    expect(text()).not.toContain('exa')
    await act(async () => root.unmount())
  })

  it('strips the normalized mcp prefix from tool names', async () => {
    // 'srv.name' normalizes to mcp__srv_name__*, the same prefix the host
    // derives; a prefix built from the raw label would not strip at all.
    const hyphenGroups = [
      { id: 'mcp:srv.name', kind: 'mcp' as const, label: 'srv.name', tools: [{ name: 'mcp__srv_name__ping', conditional: false }] },
    ]
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => DEFAULT_SETTINGS,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async () => DEFAULT_SETTINGS,
      capabilities: async () => ({ locked: [], groups: hyphenGroups, grants: {}, applied: {} }),
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="capabilities" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })
    const code = document.querySelector('.dsh-dot-cap-tool code')
    expect(code?.textContent).toBe('ping')
    expect(code?.closest('.dsh-dot-cap-tool')?.getAttribute('title')).toBe('mcp__srv_name__ping')
    await act(async () => root.unmount())
  })
})

describe('dispatch settings layout', () => {
  const catalog = {
    groups: [
      { id: 'magpie', name: 'Magpie', models: [
        { id: 'agnes', name: 'Agnes 3.0 Flash · KLARKXY' },
        { id: 'ds-flash', name: 'DeepSeek V4.1 Flash · KLARKXY' },
        { id: 'glm', name: 'GLM-5.3 Flash · KLARKXY' },
        { id: 'grok', name: 'Grok 4.6 · routing group' },
      ] },
      { id: 'deepseek', name: 'DeepSeek', models: [
        { id: 'chat', name: 'DeepSeek Chat' },
        { id: 'reasoner', name: 'DeepSeek Reasoner' },
      ] },
      { id: 'account', name: 'DeepSeek Account', models: [
        { id: 'v4', name: 'deepseek-v4' },
        { id: 'flash', name: 'deepseek-flash' },
      ] },
    ],
  }
  const selected = ['magpie/agnes', 'magpie/ds-flash', 'magpie/glm', 'deepseek/chat', 'account/v4']

  function mount(settings: DotSettings, saves: Array<Partial<DotSettings>>) {
    let current = settings
    const api = {
      models: async () => catalog,
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => {
        saves.push(patch)
        current = { ...current, ...patch } as DotSettings
        return current
      },
    }
    function Harness() {
      const [value, setValue] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" section="dispatch" api={api as never} settings={value} onSaved={setValue} />
    }
    return Harness
  }

  it('groups dispatch settings and keeps model search, selection, and empty states', async () => {
    const saves: Array<Partial<DotSettings>> = []
    const Harness = mount({ ...DEFAULT_SETTINGS, taskPermission: 'workspace-write', taskModels: { mode: 'allow', list: selected }, idleCheckMinutes: 10 }, saves)
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })

    expect([...document.querySelectorAll('.dsh-dot-dispatch-group')].map(node => node.getAttribute('data-group'))).toEqual(['permission', 'preset', 'models', 'routine'])
    expect(document.querySelector('input[aria-label="Routine check"]')).not.toBeNull()
    expect(document.querySelector('[role="tablist"][aria-label="Task permissions"]')).not.toBeNull()
    const picker = document.querySelector('.dsh-dot-model-picker')!
    expect(picker.getAttribute('aria-label')).toBe('Allow selected')
    expect(document.querySelector('.dsh-dot-model-summary')?.textContent).toContain('5 selected')
    expect(document.querySelectorAll('.dsh-dot-model-chip')).toHaveLength(5)
    expect(document.querySelector('.dsh-dot-model-chip-provider')?.textContent).toBe('Magpie')
    expect(document.querySelector('.dsh-dot-model-chip')?.getAttribute('title')).toBe('Magpie / Agnes 3.0 Flash · KLARKXY')
    expect(document.querySelectorAll('.dsh-dot-model-group')).toHaveLength(3)
    expect(document.querySelector('.dsh-dot-model-group-count')?.textContent).toBe('3/4')
    expect(document.querySelectorAll('.dsh-dot-model-item--on').length).toBeGreaterThanOrEqual(5)

    const filter = document.querySelector<HTMLInputElement>('input[aria-label="Filter models…"]')!
    await act(async () => { type(filter, 'account') })
    const visible = [...document.querySelectorAll<HTMLInputElement>('.dsh-dot-model-list input[type="checkbox"]')]
    expect(visible).toHaveLength(2)
    expect(document.querySelector('.dsh-dot-model-group-name')?.textContent).toBe('DeepSeek Account')

    await act(async () => { type(filter, 'no-such-model') })
    expect(document.querySelector('.dsh-dot-model-empty')?.textContent).toBe('No matching models')
    expect(document.querySelector('.dsh-dot-model-group')).toBeNull()

    await act(async () => { type(filter, '') })
    const remove = document.querySelector<HTMLButtonElement>('.dsh-dot-model-chip-remove')!
    expect(remove.getAttribute('aria-label')).toBe('Remove Magpie / Agnes 3.0 Flash · KLARKXY')
    await act(async () => { remove.click() })
    expect(saves.at(-1)?.taskModels).toEqual({ mode: 'allow', list: selected.slice(1) })

    const toggle = [...document.querySelectorAll<HTMLElement>('.dsh-dot-model-group-toggle')].find(el => el.parentElement?.textContent?.includes('DeepSeek Account'))!
    await act(async () => { toggle.click() })
    expect(saves.at(-1)?.taskModels?.list).toEqual(expect.arrayContaining(['account/v4', 'account/flash']))

    // Toggling the same group again removes only that group's models, keeping the others.
    await act(async () => { toggle.click() })
    expect(saves.at(-1)?.taskModels?.list).toEqual(expect.not.arrayContaining(['account/v4', 'account/flash']))
    expect(saves.at(-1)?.taskModels?.list).toEqual(expect.arrayContaining(['magpie/ds-flash', 'magpie/glm', 'deepseek/chat']))

    await act(async () => { document.querySelector<HTMLButtonElement>('.dsh-dot-model-summary button')!.click() })
    expect(saves.at(-1)?.taskModels).toEqual({ mode: 'allow', list: [] })
    expect(document.querySelector('.dsh-dot-model-chip')).toBeNull()
    expect(document.querySelector('.dsh-ui-help')?.textContent).toContain('No models selected')

    const unrestricted = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent === 'Unrestricted')!
    await act(async () => { unrestricted.click() })
    expect(saves.at(-1)?.taskModels).toEqual({ mode: 'all', list: [] })
    expect(document.querySelector('.dsh-dot-model-picker')).toBeNull()

    const exclude = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent === 'Exclude selected')!
    await act(async () => { exclude.click() })
    expect(document.querySelector('.dsh-dot-model-picker')?.getAttribute('aria-label')).toBe('Exclude selected')
    expect(document.querySelector('.dsh-dot-model-empty')).toBeNull()

    await act(async () => root.unmount())
  })

  it('does not give the model list or selected tokens their own scrollbar', () => {
    const rule = (selector: string) => {
      const start = settingsCss.indexOf(selector)
      expect(start).toBeGreaterThan(-1)
      return settingsCss.slice(start, settingsCss.indexOf('}', start))
    }
    expect(rule('.dsh-dot-chat .dsh-dot-model-list {')).not.toMatch(/max-height|overflow/)
    expect(rule('.dsh-dot-chat .dsh-dot-model-chips {')).not.toMatch(/max-height|overflow/)
    expect(settingsCss).toContain(".dsh-dot-dispatch-group[data-group='models']")
    expect(settingsCss).toContain(".dsh-dot-chat .dsh-dot-dispatch-group[data-group='preset']")
    expect(settingsCss).toContain('.dsh-dot-chat .dsh-dot-model-search { display: flex; width: 100%;')
    expect(settingsCss).toContain('.dsh-dot-chat .dsh-dot-model-chip-provider {')

    const nonAtSelectors = settingsCss
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@(container|media)\s*\([^)]*\)\s*\{([\s\S]*?\})\s*\}/g, '$2')
      .split('}')
      .map(block => block.split('{')[0]?.trim() ?? '')
      .filter(Boolean)
    for (const selectorList of nonAtSelectors) {
      for (const selector of selectorList.split(',').map(part => part.trim()).filter(Boolean)) {
        expect(selector.startsWith('.dsh-dot-chat')).toBe(true)
      }
    }
  })

  it('renders default task preset select, saves changes, keeps select enabled when locked, and formats proposals', async () => {
    const saves: Array<Partial<DotSettings>> = []
    const proposals = [
      {
        id: 'p-preset',
        field: 'defaultTaskPreset' as const,
        before: 'standard',
        after: 'dot-worker',
        reason: 'promote long shell commands after 5s',
        createdAt: 1,
      },
      {
        id: 'p-preset-fallback',
        field: 'defaultTaskPreset' as const,
        before: 'custom-preset',
        after: 'standard',
        reason: 'restore host default',
        createdAt: 2,
      },
    ]
    const decisions: Array<{ id: string; allow: boolean }> = []
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const api = {
      models: async () => catalog,
      settings: async () => current,
      settingProposals: async () => proposals,
      decideSetting: async (id: string, allow: boolean) => { decisions.push({ id, allow }); return 'ok' },
      setSettings: async (patch: Partial<DotSettings>) => {
        saves.push(patch)
        current = { ...current, ...patch } as DotSettings
        return current
      },
    }
    function Harness({ locale, section }: { locale: 'en' | 'zh'; section: 'dispatch' | 'proposals' }) {
      const [value, setValue] = useState<DotSettings>(current)
      return <SettingsPanel locale={locale} section={section} api={api as never} settings={value} onSaved={setValue} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness locale="en" section="dispatch" />))
    await act(async () => { await Promise.resolve() })

    const select = () => document.querySelector<HTMLSelectElement>('select.dsh-ui-select[aria-label="Default task preset"]')!
    expect(select()).not.toBeNull()
    expect(select().value).toBe('standard')
    expect(select().disabled).toBe(false)
    expect([...select().options].map(opt => [opt.value, opt.textContent])).toEqual([
      ['standard', 'standard (Host default)'],
      ['dot-worker', 'dot-worker (5s background promotion)'],
    ])
    const helpBtn = document.querySelector('button.dsh-dot-help-tip[aria-label="About Default task preset"]')
    expect(helpBtn).not.toBeNull()

    await act(async () => {
      const el = select()
      el.value = 'dot-worker'
      const propsKey = Object.keys(el).find(key => key.startsWith('__reactProps'))
      const props = propsKey ? (el as unknown as Record<string, { onChange?: (event: { target: HTMLSelectElement }) => void }>)[propsKey] : undefined
      props?.onChange?.({ target: el })
    })
    expect(saves.at(-1)).toEqual({ defaultTaskPreset: 'dot-worker' })
    expect(select().value).toBe('dot-worker')

    const lockBtn = [...document.querySelectorAll<HTMLButtonElement>('.dsh-dot-lock')].find(btn => btn.getAttribute('aria-label')?.includes('Default task preset'))!
    expect(lockBtn).toBeDefined()
    expect(lockBtn.getAttribute('aria-pressed')).toBe('false')
    await act(async () => { lockBtn.click() })
    expect(saves.at(-1)).toEqual({ locks: { defaultTaskPreset: true } })
    expect(lockBtn.getAttribute('aria-pressed')).toBe('true')
    expect(lockBtn.hasAttribute('data-locked')).toBe(true)
    expect(select().disabled).toBe(false)

    await act(async () => { lockBtn.click() })
    expect(saves.at(-1)).toEqual({ locks: { defaultTaskPreset: false } })
    expect(lockBtn.getAttribute('aria-pressed')).toBe('false')

    await act(async () => root.render(<Harness locale="zh" section="dispatch" />))
    const zhSelect = document.querySelector<HTMLSelectElement>('select.dsh-ui-select[aria-label="默认任务 preset"]')!
    expect(zhSelect).not.toBeNull()
    expect([...zhSelect.options].map(opt => opt.textContent)).toEqual([
      'standard（宿主默认）',
      'dot-worker（5s 前转后）',
    ])

    await act(async () => root.render(<Harness locale="en" section="proposals" />))
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-proposal-head strong')?.textContent).toBe('Default task preset')
    expect([...document.querySelectorAll('.dsh-dot-proposal-chip')].map(node => node.textContent)).toEqual([
      'standard (Host default)',
      'dot-worker (5s background promotion)',
      'custom-preset',
      'standard (Host default)',
    ])

    await act(async () => root.render(<Harness locale="zh" section="proposals" />))
    expect(document.querySelector('.dsh-dot-proposal-head strong')?.textContent).toBe('默认任务 preset')
    expect([...document.querySelectorAll('.dsh-dot-proposal-chip')].map(node => node.textContent)).toEqual([
      'standard（宿主默认）',
      'dot-worker（5s 前转后）',
      'custom-preset',
      'standard（宿主默认）',
    ])
    await act(async () => document.querySelector<HTMLButtonElement>('.dsh-dot-proposal button')!.click())
    expect(decisions).toEqual([{ id: 'p-preset', allow: true }])

    await act(async () => root.unmount())
  })
})

describe('GitHub poll-primary settings', () => {
  const selectChange = (el: HTMLSelectElement, value: string) => {
    el.value = value
    const propsKey = Object.keys(el).find(key => key.startsWith('__reactProps'))
    const props = propsKey ? (el as unknown as Record<string, { onChange?: (event: { target: HTMLSelectElement }) => void }>)[propsKey] : undefined
    props?.onChange?.({ target: el })
  }

  it('renders Poll-primary defaults with no default repos enabled and collapsed advanced sections', async () => {
    const saves: Array<Partial<DotSettings>> = []
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => {
        saves.push(patch)
        current = { ...current, ...patch } as DotSettings
        return current
      },
    }
    function Harness({ locale = 'en' }: { locale?: 'en' | 'zh' }) {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale={locale} section="github" api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness locale="en" />))
    await act(async () => { await Promise.resolve() })

    expect(document.querySelector('[data-gh-card="poll"]')).not.toBeNull()
    expect(document.body.textContent).toContain('GitHub Polling (Local gh, No Public URL)')
    expect(document.querySelectorAll('[data-gh-list="poll"] .dsh-dot-gh-chip')).toHaveLength(0)
    expect(document.body.textContent).toContain('No repositories added yet')

    const enabledSwitch = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Enable polling"]')!
    expect(enabledSwitch.getAttribute('aria-checked')).toBe('false')
    expect(document.querySelector<HTMLInputElement>('input[aria-label="gh CLI path"]')?.value).toBe('gh')
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Poll interval"]')?.value).toBe('120')

    // All 4 stream checkboxes default to checked.
    const streamChecks = [...document.querySelectorAll<HTMLInputElement>('.dsh-dot-gh-streams input[type="checkbox"]')]
    expect(streamChecks).toHaveLength(4)
    expect(streamChecks.every(box => box.checked)).toBe(true)

    // Advanced Admission & Webhook sections start collapsed.
    const admissionDetails = document.querySelector<HTMLDetailsElement>('details[data-gh-section="admission"]')!
    const webhookDetails = document.querySelector<HTMLDetailsElement>('details[data-gh-section="webhook"]')!
    expect(admissionDetails.open).toBe(false)
    expect(webhookDetails.open).toBe(false)

    // Verify zh locale copy renders cleanly too.
    await act(async () => root.render(<Harness locale="zh" />))
    expect(document.body.textContent).toContain('GitHub 轮询（本机 gh 免公网配置）')
    expect(document.body.textContent).toContain('高级：Fast-Path 准入矩阵')
    expect(document.body.textContent).toContain('高级：Webhook 实时推送')

    expect(saves).toHaveLength(0)
    await act(async () => root.unmount())
  })

  it('edits poll toggle, normalized repos, streams, interval validation, ghPath, hostname, and ignoredActors', async () => {
    const saves: Array<Partial<DotSettings>> = []
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => {
        saves.push(patch)
        current = { ...current, ...patch } as DotSettings
        return current
      },
    }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" section="github" api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })

    // Enable polling.
    const enabledSwitch = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Enable polling"]')!
    await act(async () => enabledSwitch.click())
    expect(saves.at(-1)?.githubPoll?.enabled).toBe(true)

    // Add uppercase repo -> normalized lowercase.
    const repoInput = document.querySelector<HTMLInputElement>('input[aria-label="Polled repositories"]')!
    const addBtn = repoInput.closest('.dsh-dot-gh-add-row')!.querySelector<HTMLButtonElement>('button')!
    await act(async () => { type(repoInput, '  Acme/Widgets ') })
    await act(async () => addBtn.click())
    expect(saves.at(-1)?.githubPoll?.repos).toEqual(['acme/widgets'])

    // Toggle CI stream off.
    const ciCheckbox = [...document.querySelectorAll<HTMLLabelElement>('.dsh-dot-gh-streams label')]
      .find(label => label.textContent?.includes('CI checks'))!
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => ciCheckbox.click())
    expect(saves.at(-1)?.githubPoll?.streams.ci).toBe(false)

    // Invalid interval (below 60 or above 3600) reverts; valid 300 saves.
    const intervalInput = document.querySelector<HTMLInputElement>('input[aria-label="Poll interval"]')!
    await act(async () => { type(intervalInput, '30') })
    await act(async () => { blur(intervalInput) })
    expect(intervalInput.value).toBe('120')

    await act(async () => { type(intervalInput, '300') })
    await act(async () => { blur(intervalInput) })
    expect(saves.at(-1)?.githubPoll?.intervalSec).toBe(300)

    // Update ghPath, hostname, and ignoredActors.
    const ghPathInput = document.querySelector<HTMLInputElement>('input[aria-label="gh CLI path"]')!
    await act(async () => { type(ghPathInput, 'C:\\Program Files\\GitHub CLI\\gh.exe') })
    await act(async () => { blur(ghPathInput) })
    expect(saves.at(-1)?.githubPoll?.ghPath).toBe('C:\\Program Files\\GitHub CLI\\gh.exe')

    const hostInput = document.querySelector<HTMLInputElement>('input[aria-label="GHES hostname (optional)"]')!
    await act(async () => { type(hostInput, 'GHE.Internal.Corp') })
    await act(async () => { blur(hostInput) })
    expect(saves.at(-1)?.githubPoll?.hostname).toBe('ghe.internal.corp')

    const actorsInput = document.querySelector<HTMLInputElement>('input[aria-label="Ignored bot actors"]')!
    await act(async () => { type(actorsInput, 'My-Bot[bot], Second-Bot[bot], my-bot[bot]') })
    await act(async () => { blur(actorsInput) })
    expect(saves.at(-1)?.githubPoll?.ignoredActors).toEqual(['my-bot[bot]', 'second-bot[bot]'])

    // Remove the added repo chip.
    const removeBtn = document.querySelector<HTMLButtonElement>('button[aria-label="Remove acme/widgets"]')!
    await act(async () => removeBtn.click())
    expect(saves.at(-1)?.githubPoll?.repos).toEqual([])

    await act(async () => root.unmount())
  })

  it('enforces single-repo mutual exclusion between Polling and Webhook in UI without saving invalid state', async () => {
    const saves: Array<Partial<DotSettings>> = []
    let current: DotSettings = {
      ...DEFAULT_SETTINGS,
      githubPoll: {
        ...DEFAULT_GITHUB_POLL_SETTINGS,
        repos: ['klarkxy/dot-test'],
        webhookRepos: ['klarkxy/ds-dot'],
      },
    }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => {
        saves.push(patch)
        current = { ...current, ...patch } as DotSettings
        return current
      },
    }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" section="github" api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })

    // Try adding a webhookRepo ('KLARKXY/DS-DOT') into Poll repos -> blocked with warning.
    const pollInput = document.querySelector<HTMLInputElement>('input[aria-label="Polled repositories"]')!
    const pollAdd = pollInput.closest('.dsh-dot-gh-add-row')!.querySelector<HTMLButtonElement>('button')!
    await act(async () => { type(pollInput, 'KLARKXY/DS-DOT') })
    await act(async () => pollAdd.click())
    expect(saves).toHaveLength(0)
    expect(document.body.textContent).toContain('currently configured for Webhook')

    // Open Webhook section and try adding a polled repo ('klarkxy/dot-test') -> blocked with warning.
    const webhookDetails = document.querySelector<HTMLDetailsElement>('details[data-gh-section="webhook"]')!
    webhookDetails.open = true
    const webhookInput = document.querySelector<HTMLInputElement>('input[aria-label="Webhook repositories"]')!
    const webhookAdd = webhookInput.closest('.dsh-dot-gh-add-row')!.querySelector<HTMLButtonElement>('button')!
    await act(async () => { type(webhookInput, 'klarkxy/dot-test') })
    await act(async () => webhookAdd.click())
    expect(saves).toHaveLength(0)
    expect(document.body.textContent).toContain('currently configured for Polling')

    // Adding a non-conflicting webhook repo and editing sourceId succeeds.
    await act(async () => { type(webhookInput, 'org/new-hook') })
    await act(async () => webhookAdd.click())
    expect(saves.at(-1)?.githubPoll?.webhookRepos).toEqual(['klarkxy/ds-dot', 'org/new-hook'])

    const sourceIdInput = document.querySelector<HTMLInputElement>('input[aria-label="Webhook source ID"]')!
    await act(async () => { type(sourceIdInput, 'custom-gh-hook') })
    await act(async () => { blur(sourceIdInput) })
    expect(saves.at(-1)?.githubPoll?.sourceId).toBe('custom-gh-hook')

    await act(async () => root.unmount())
  })

  it('runs Test gh Connection for both success and failure outcomes, and renders health alert & budget warning banners', async () => {
    const testRequests: Array<{ ghPath?: string; hostname?: string; repos?: readonly string[] }> = []
    let testReply: GithubPollTestResult = {
      ok: true,
      ghFound: true,
      resolvedPath: '/usr/bin/gh',
      version: 'gh version 2.102.0',
      authenticated: true,
      login: 'klarkxy',
      host: 'github.com',
      rateLimitRemaining: 4900,
      rateLimitLimit: 5000,
      repoChecks: [{ repo: 'klarkxy/dot-test', ok: true }],
    }
    const statusView: GithubPollStatusView = {
      enabled: true,
      polling: false,
      ghPath: 'gh',
      userIntervalSec: 60,
      effectiveIntervalSec: 360,
      xPollIntervalSec: 120,
      rateLimitRemaining: 100,
      rateLimitLimit: 5000,
      hourlyRequests: 40,
      budgetLimitPerHour: 50,
      budgetAdjusted: true,
      budgetWarning: 'Rate-limit budget guard raised poll interval from 120s to 360s.',
      health: 'error',
      alert: true,
      consecutiveFailures: 3,
      lastError: 'HTTP 503 Service Unavailable',
      repos: [{ repo: 'klarkxy/dot-test', mode: 'poll', consecutiveFailures: 3, lastError: 'HTTP 503 Service Unavailable' }],
    }
    const current: DotSettings = {
      ...DEFAULT_SETTINGS,
      githubPoll: { ...DEFAULT_GITHUB_POLL_SETTINGS, enabled: true, repos: ['klarkxy/dot-test'], intervalSec: 60 },
    }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async () => current,
      githubPollStatus: async () => statusView,
      githubPollTest: async (req: { ghPath?: string; hostname?: string; repos?: readonly string[] }) => {
        testRequests.push(req)
        return testReply
      },
    }

    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<SettingsPanel locale="en" section="github" api={api as never} settings={current} onSaved={() => {}} />))
    await act(async () => { await Promise.resolve() })

    // Health alert (consecutiveFailures >= 3) & rate-limit budget warning banners render.
    const alertBanner = document.querySelector('.dsh-dot-gh-banner--error[role="alert"]')
    expect(alertBanner?.textContent).toContain('3 consecutive times')
    expect(alertBanner?.textContent).toContain('HTTP 503 Service Unavailable')

    const budgetBanner = document.querySelector('[data-gh-budget="warn"]')
    expect(budgetBanner?.textContent).toContain('40 req/hr')
    expect(budgetBanner?.textContent).toContain('50/hr')
    expect(budgetBanner?.textContent).toContain('360s')
    expect(document.body.textContent).toContain('X-Poll-Interval: 120s')

    // Click Test gh Connection -> success view.
    const testBtn = [...document.querySelectorAll('button')].find(btn => btn.textContent === 'Test gh Connection')!
    await act(async () => testBtn.click())
    await act(async () => { await Promise.resolve() })
    expect(testRequests).toEqual([{ ghPath: 'gh', repos: ['klarkxy/dot-test'] }])
    const resBox = document.querySelector('.dsh-dot-gh-test-result')!
    expect(resBox.hasAttribute('data-ok')).toBe(true)
    expect(resBox.textContent).toContain('/usr/bin/gh')
    expect(resBox.textContent).toContain('klarkxy')
    expect(resBox.textContent).toContain('4900/5000')
    expect(resBox.textContent).toContain('klarkxy/dot-test: Accessible')

    // Simulate failed gh probe (missing binary).
    testReply = {
      ok: false,
      ghFound: false,
      authenticated: false,
      host: 'github.com',
      error: 'gh binary not found on PATH',
    }
    await act(async () => testBtn.click())
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-gh-test-result')?.hasAttribute('data-ok')).toBe(false)
    expect(document.querySelector('.dsh-dot-gh-test-result')?.textContent).toContain('gh CLI binary not found')
    expect(document.querySelector('.dsh-dot-gh-test-result')?.textContent).toContain('gh binary not found on PATH')

    await act(async () => root.unmount())
  })

  it('edits Fast-Path Admission Matrix rules and preserves .dsh-dot-chat CSS scope', async () => {
    const saves: Array<Partial<DotSettings>> = []
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const api = {
      models: async () => ({ groups: [] }),
      settings: async () => current,
      settingProposals: async () => [],
      decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => {
        saves.push(patch)
        current = { ...current, ...patch } as DotSettings
        return current
      },
    }
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale="en" section="github" api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })

    const details = document.querySelector<HTMLDetailsElement>('details[data-gh-section="admission"]')!
    details.open = true
    expect(details.textContent).toContain('Defaults: human → inbox')

    // Invalid repo rejected without save.
    const repoInput = details.querySelector<HTMLInputElement>('input[aria-label="Repo (* or owner/repo)"]')!
    const addBtn = [...details.querySelectorAll('button')].find(btn => btn.textContent === 'Add rule')!
    await act(async () => { type(repoInput, 'not a repo') })
    await act(async () => addBtn.click())
    expect(saves).toHaveLength(0)
    expect(details.textContent).toContain('Rule repo must be * or a valid owner/repo')

    // Valid rule added.
    await act(async () => {
      type(repoInput, 'Klarkxy/Dot-Test')
      selectChange(details.querySelector<HTMLSelectElement>('select[aria-label="Event type"]')!, 'ci')
      selectChange(details.querySelector<HTMLSelectElement>('select[aria-label="Sender class"]')!, 'unlisted-bot')
      selectChange(details.querySelector<HTMLSelectElement>('select[aria-label="Action"]')!, 'context-only')
    })
    await act(async () => addBtn.click())
    expect(saves.at(-1)?.githubPoll?.admission).toEqual([
      { repo: 'klarkxy/dot-test', eventType: 'ci', senderClass: 'unlisted-bot', action: 'context-only' },
    ])

    // Inline action select updates existing rule.
    const inlineSelect = details.querySelector<HTMLSelectElement>('select[aria-label="klarkxy/dot-test ci unlisted-bot"]')!
    await act(async () => { selectChange(inlineSelect, 'inbox') })
    expect(saves.at(-1)?.githubPoll?.admission).toEqual([
      { repo: 'klarkxy/dot-test', eventType: 'ci', senderClass: 'unlisted-bot', action: 'inbox' },
    ])

    // Remove rule.
    const rmBtn = details.querySelector<HTMLButtonElement>('button[aria-label="Remove rule"]')!
    await act(async () => rmBtn.click())
    expect(saves.at(-1)?.githubPoll?.admission).toEqual([])
    expect(settingsCss).toContain('.dsh-dot-chat .dsh-dot-gh-card')

    await act(async () => root.unmount())
  })
})

describe('Run Watchdog settings', () => {
  const catalog = {
    groups: [
      { id: 'deepseek', name: 'DeepSeek', models: [
        { id: 'chat', name: 'DeepSeek Chat' },
        { id: 'reasoner', name: 'DeepSeek Reasoner' },
      ] },
    ],
  }
  const selectChange = (el: HTMLSelectElement, value: string) => {
    el.value = value
    const propsKey = Object.keys(el).find(key => key.startsWith('__reactProps'))
    const props = propsKey ? (el as unknown as Record<string, { onChange?: (event: { target: HTMLSelectElement }) => void }>)[propsKey] : undefined
    props?.onChange?.({ target: el })
  }

  it('switches watchdogMode (off|observe|auto), picks/clears watchdogModel, toggles locks, and formats proposals', async () => {
    const saves: Array<Partial<DotSettings>> = []
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const proposals = [
      {
        id: 'p-wd-mode',
        field: 'watchdogMode' as const,
        before: 'observe',
        after: 'auto',
        reason: 'enable read-only judge',
        createdAt: 1,
      },
      {
        id: 'p-wd-model',
        field: 'watchdogModel' as const,
        before: null,
        after: 'deepseek/reasoner',
        reason: 'use reasoner for judge',
        createdAt: 2,
      },
    ]
    const api = {
      models: async () => catalog,
      settings: async () => current,
      settingProposals: async () => proposals,
      decideSetting: async () => 'ok',
      setSettings: async (patch: Partial<DotSettings>) => {
        saves.push(patch)
        if ('watchdogModel' in patch) {
          if (patch.watchdogModel === null) {
            const { watchdogModel: _drop, ...rest } = current
            current = rest as DotSettings
          } else {
            current = { ...current, watchdogModel: patch.watchdogModel } as DotSettings
          }
        } else {
          current = { ...current, ...patch } as DotSettings
        }
        return current
      },
    }
    function Harness({ locale, section }: { locale: 'en' | 'zh'; section: 'general' | 'proposals' }) {
      const [settings, setSettings] = useState<DotSettings>(current)
      return <SettingsPanel locale={locale} section={section} api={api as never} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness locale="en" section="general" />))
    await act(async () => { await Promise.resolve() })

    const wdCard = document.querySelector('[data-section="watchdog"] .dsh-dot-watchdog-card')
    expect(wdCard).not.toBeNull()
    expect(wdCard?.textContent).toContain('Observe (default)')
    expect(wdCard?.textContent).toContain('zero LLM judge calls')

    // Default mode is observe.
    const modeTab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Watchdog mode"] [role="tab"]')].find(el => el.textContent === label)!
    expect(modeTab('Observe').getAttribute('aria-selected')).toBe('true')
    await act(async () => modeTab('Auto').click())
    expect(saves.at(-1)).toEqual({ watchdogMode: 'auto' })
    await act(async () => modeTab('Off').click())
    expect(saves.at(-1)).toEqual({ watchdogMode: 'off' })

    // Model dropdown populated from catalog, supports provider/model and clearing to host default.
    const modelSelect = () => document.querySelector<HTMLSelectElement>('select[aria-label="Watchdog judge model"]')!
    expect([...modelSelect().options].map(o => o.textContent)).toEqual([
      'Follow host default',
      'DeepSeek / DeepSeek Chat',
      'DeepSeek / DeepSeek Reasoner',
    ])
    await act(async () => selectChange(modelSelect(), JSON.stringify(['deepseek', 'reasoner'])))
    expect(saves.at(-1)).toEqual({ watchdogModel: 'deepseek/reasoner' })
    await act(async () => selectChange(modelSelect(), ''))
    expect(saves.at(-1)).toEqual({ watchdogModel: null })

    // Locks toggle for both watchdogMode and watchdogModel.
    const modeLock = document.querySelector<HTMLButtonElement>('button.dsh-dot-lock[aria-label*="Watchdog mode"]')!
    await act(async () => modeLock.click())
    expect(saves.at(-1)).toEqual({ locks: { watchdogMode: true } })
    const modelLock = document.querySelector<HTMLButtonElement>('button.dsh-dot-lock[aria-label*="Watchdog judge model"]')!
    await act(async () => modelLock.click())
    expect(saves.at(-1)).toEqual({ locks: { watchdogMode: true, watchdogModel: true } })

    // SettingProposal formatting in en and zh.
    await act(async () => root.render(<Harness locale="en" section="proposals" />))
    await act(async () => { await Promise.resolve() })
    expect([...document.querySelectorAll('.dsh-dot-proposal-head strong')].map(el => el.textContent)).toEqual([
      'Run Watchdog mode',
      'Watchdog judge model',
    ])
    expect([...document.querySelectorAll('.dsh-dot-proposal-chip')].map(el => el.textContent)).toEqual([
      'Observe',
      'Auto',
      'Follow host default',
      'DeepSeek / DeepSeek Reasoner',
    ])

    await act(async () => root.render(<Harness locale="zh" section="proposals" />))
    expect([...document.querySelectorAll('.dsh-dot-proposal-head strong')].map(el => el.textContent)).toEqual([
      '运行 Watchdog 模式',
      'Watchdog 判官模型',
    ])
    expect([...document.querySelectorAll('.dsh-dot-proposal-chip')].map(el => el.textContent)).toEqual([
      '仅观察',
      '自动干预',
      '跟随宿主默认模型',
      'DeepSeek / DeepSeek Reasoner',
    ])
    expect(settingsCss).toContain('.dsh-dot-chat .dsh-dot-watchdog-card')

    await act(async () => root.unmount())
  })
})
