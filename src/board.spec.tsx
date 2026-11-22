import { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Board, boardCounts, type BoardProps } from './board.tsx'
import type { BoardView } from './contracts.ts'
import { t } from './ui-copy.ts'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('navigator', dom.window.navigator)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => { createRoot = (await import('react-dom/client')).createRoot })
afterEach(() => { document.body.innerHTML = '<div id="root"></div>' })

function handlers() {
  return { onOpen: vi.fn(), onRetry: vi.fn(), onRemoveSchedule: vi.fn() }
}

async function render(view: BoardView | undefined, patch: Partial<BoardProps> = {}, locale: 'en' | 'zh' = 'en') {
  const props = handlers()
  const root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(<Board locale={locale} view={view} {...props} {...patch} />))
  return { props, root }
}

const full: BoardView = {
  pending: [{ id: 'ap-1', kind: 'approval', sessionId: 's-req', createdAt: 1, subject: 'pwsh' }],
  tasks: [{ sessionId: 'w-1', origin: 'watched', title: 'Watched one', goal: '', cwd: '/w', status: 'idle', createdAt: 1, updatedAt: 1, unseenTurns: 2 }],
  schedules: [{ id: 'sch-1', title: 'Nightly', prompt: 'p', timing: { kind: 'daily', time: '09:00' }, createdAt: 1, nextAt: 5_000_000_000_000 }],
}

const labels = () => [...document.querySelectorAll('section[aria-label]')].map(node => node.getAttribute('aria-label'))
const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>('button')]
const click = (element: Element) => act(async () => { (element as HTMLElement).click() })
const named = (scope: ParentNode, text: string) => buttons(scope).find(button => button.textContent === text)!

describe('Board', () => {
  it('counts only requests, work and watched sessions', async () => {
    expect(boardCounts(full)).toEqual({ waiting: 1, active: 0, watch: 2 })
    expect(boardCounts({ ...full, tasks: [{ ...full.tasks[0]!, status: 'running' }] })).toEqual({ waiting: 1, active: 1, watch: 2 })
    const waiting = await render(full, { filter: 'waiting' })
    expect(labels()).toEqual(['Needs you'])
    await act(async () => waiting.root.unmount())
    const watch = await render(full, { filter: 'watch' })
    expect(labels()).toEqual(['Watched sessions', 'Reminders'])
    await act(async () => watch.root.unmount())
    const empty = await render({ ...full, tasks: [], schedules: [] }, { filter: 'watch' })
    expect(document.body.textContent).toContain('No tasks yet.')
    await act(async () => empty.root.unmount())
  })

  it('keeps the last snapshot visible and offers retry after a later read fails', async () => {
    const { root, props } = await render(full, { error: 'offline' })
    expect(document.body.textContent).toContain('offline')
    expect(document.body.textContent).toContain('Watched one')
    await click(named(document, 'Retry'))
    expect(props.onRetry).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
  })

  it('draws requests, watched sessions and reminders in order', async () => {
    const { root } = await render(full)
    expect(labels()).toEqual(['Needs you', 'Watched sessions', 'Reminders'])
    const waiting = document.querySelector('section[aria-label="Needs you"]')!
    expect(waiting.textContent).toContain('Needs you · 1')
    await act(async () => root.unmount())
  })

  it('keeps watched sessions as they were and removes a reminder', async () => {
    const { props, root } = await render(full)
    const watched = document.querySelector('section[aria-label="Watched sessions"]')!
    expect(watched.textContent).toContain('Watched one')
    expect(watched.textContent).toContain('2 unread')
    await click(watched.querySelector('button')!)
    expect(props.onOpen).toHaveBeenCalledWith('w-1')
    const reminders = document.querySelector('section[aria-label="Reminders"]')!
    expect(reminders.textContent).toContain('Nightly')
    await click(named(reminders, 'Remove'))
    expect(props.onRemoveSchedule).toHaveBeenCalledWith('sch-1')
    await click(document.querySelector('section[aria-label="Needs you"] > button')!)
    expect(props.onOpen).toHaveBeenCalledWith('s-req')
    await act(async () => root.unmount())
  })

  it('shows an empty note and a load failure', async () => {
    const empty = await render({ tasks: [], pending: [], schedules: [] })
    expect(document.body.textContent).toContain('No tasks yet.')
    expect(labels()).toEqual([])
    await act(async () => empty.root.unmount())
    const broken = await render(undefined, { error: 'offline' })
    expect(document.body.textContent).toContain('Could not reach Dorothy')
    await click(named(document, t('en', 'retry')))
    expect(broken.props.onRetry).toHaveBeenCalled()
    await act(async () => broken.root.unmount())
  })

  it('draws the Chinese copy for the groups and states', async () => {
    const { root } = await render(full, {}, 'zh')
    expect(labels()).toEqual(['待处理', '关注会话', '提醒'])
    await act(async () => root.unmount())
  })
})
