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
    expect(document.body.textContent).toContain('0 turns the check off')

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
