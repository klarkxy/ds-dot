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
        tasks: 2, changes: 3, runs: 1, schedules: 0, proposals: 0, cards: 0, inbox: 0,
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
        tasks: 1, changes: 1, runs: 1, schedules: 0, proposals: 0, cards: 0, inbox: 0,
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
    expect(document.querySelectorAll('.dsh-dot-help-tip')).toHaveLength(2)

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

  it('shows the Model questions help tip only when questions is set to dot', async () => {
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
    const tabNamed = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(el => el.textContent === label)!
    expect(tip()).not.toBeNull()

    await act(async () => tabNamed('Ask me').click())
    await act(async () => { await Promise.resolve() })
    expect(current.questions).toBe('human')
    expect(tip()).toBeNull()

    await act(async () => tabNamed('Hands off').click())
    await act(async () => { await Promise.resolve() })
    expect(current.questions).toBe('off')
    expect(tip()).toBeNull()

    await act(async () => tabNamed('She decides').click())
    await act(async () => { await Promise.resolve() })
    expect(current.questions).toBe('dot')
    expect(tip()).not.toBeNull()

    await act(async () => root.unmount())
  })
})
