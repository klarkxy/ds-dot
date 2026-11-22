import { act } from 'react'
import { Simulate } from 'react-dom/test-utils'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RecipesView, type ChatApi } from './chat-panel.tsx'
import type { RecipeBoardRow } from './contracts.ts'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('navigator', dom.window.navigator)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
dom.window.requestAnimationFrame = (callback: FrameRequestCallback) => { callback(0); return 0 }
vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame)
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => { createRoot = (await import('react-dom/client')).createRoot })
afterEach(() => { document.body.innerHTML = '<div id="root"></div>' })

function row(partial: Partial<RecipeBoardRow> = {}): RecipeBoardRow {
  return {
    id: 'rcp-1', name: 'Weekly report', revision: 2, updatedAt: 100,
    stats: [{ revision: 2, accepted: 3, cancelled: 1, failedRounds: 2, inFlight: 0 }],
    inFlight: [], reminders: [{ id: 'sch-1', title: 'run weekly', nextAt: Date.now() + 3600_000 }],
    ...partial,
  }
}

function api(run: ChatApi['recipeRun']): ChatApi {
  return { recipeRun: run } as unknown as ChatApi
}

async function mount(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  return { root, container }
}

describe('RecipesView', () => {
  it('renders stats, bound reminders and the empty state', async () => {
    const { container } = await mount(<RecipesView locale="en" api={api(async () => ({ ok: false, reason: 'x' }))} rows={[row()]} onChanged={() => {}} />)
    expect(container.textContent).toContain('Weekly report')
    expect(container.textContent).toContain('rev 2')
    expect(container.textContent).toContain('3 accepted')
    expect(container.textContent).toContain('run weekly')
    const empty = await mount(<RecipesView locale="en" api={api(async () => ({ ok: false, reason: 'x' }))} rows={[]} onChanged={() => {}} />)
    expect(empty.container.textContent).toContain('No recipes')
  })

  it('requires a second click to run and refreshes on success', async () => {
    const calls: string[] = []
    let changed = 0
    const a = api(async id => { calls.push(id); return { ok: true, changeId: 'chg-9', runId: 'run-9' } })
    const { container } = await mount(<RecipesView locale="en" api={a} rows={[row()]} onChanged={() => { changed += 1 }} />)
    const button = container.querySelector<HTMLButtonElement>('.dsh-dot-recipe-head button')!
    expect(button.textContent).toBe('Run now')
    await act(async () => { Simulate.click(button) })
    expect(calls).toHaveLength(0)
    expect(button.textContent).toBe('Confirm run')
    await act(async () => { Simulate.click(button) })
    expect(calls).toEqual(['rcp-1'])
    expect(changed).toBe(1)
    expect(container.textContent).toContain('Dispatched chg-9')
  })

  it('disables Run now while a run is in flight and shows refusals inline', async () => {
    const a = api(async () => ({ ok: false, reason: 'previous run still in flight' }))
    const { container } = await mount(<RecipesView locale="en" api={a} rows={[row({ inFlight: [{ changeId: 'chg-1', title: 'T', status: 'running' }] })]} onChanged={() => {}} />)
    const button = container.querySelector<HTMLButtonElement>('.dsh-dot-recipe-head button')!
    expect(button.disabled).toBe(true)
    expect(container.textContent).toContain('chg-1')
  })

  it('shows the refusal message inline on failure', async () => {
    const a = api(async () => ({ ok: false, reason: 'directory locked by run-3' }))
    const { container } = await mount(<RecipesView locale="en" api={a} rows={[row()]} onChanged={() => {}} />)
    const button = container.querySelector<HTMLButtonElement>('.dsh-dot-recipe-head button')!
    await act(async () => { Simulate.click(button) })
    await act(async () => { Simulate.click(button) })
    expect(container.textContent).toContain('directory locked by run-3')
  })
})
