import { act, useState } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type DotSettings } from './contracts.ts'
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

    // Dispatch: task permissions, task models (with dynamic empty-allow-list warning inline), routine check.
    await act(async () => root.render(<Harness section="dispatch" />))
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[role="tablist"][aria-label="Task permissions"]')).not.toBeNull()
    expect(document.querySelector('[role="tablist"][aria-label="Allowed task models"]')).not.toBeNull()
    expect(document.querySelector('input[aria-label="Routine check"]')).not.toBeNull()
    const inlineHelps = [...document.querySelectorAll('.dsh-ui-help')].map(el => el.textContent)
    expect(inlineHelps).toEqual(['No models selected — cannot start new tasks.'])
    expect(document.querySelectorAll('.dsh-dot-help-tip')).toHaveLength(2)

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
