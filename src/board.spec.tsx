import { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Board, type BoardProps } from './board.tsx'
import type { BoardView, TicketStatus, TicketView } from './contracts.ts'
import { t } from './ui-copy.ts'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('navigator', dom.window.navigator)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => { createRoot = (await import('react-dom/client')).createRoot })
afterEach(() => { document.body.innerHTML = '<div id="root"></div>' })

const ticket = (id: string, status: TicketStatus, patch: Partial<TicketView> = {}): TicketView => ({
  id, title: `Task ${id}`, goal: `goal of ${id}`, access: 'write', dir: `/work/${id}`, status, priority: 2,
  sessions: [], rounds: [], history: [], createdAt: 1, updatedAt: 1,
  waiting: false, error: false, orphaned: false, running: false, roundCount: 0, ...patch,
})

function handlers() {
  return {
    onOpen: vi.fn(), onRetry: vi.fn(), onRemoveSchedule: vi.fn(),
    onConfirm: vi.fn(), onDelete: vi.fn(), onCancel: vi.fn(), onReview: vi.fn(), onPriority: vi.fn(),
  }
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
  tickets: [
    ticket('t-1', 'review', { humanReview: true, title: 'Needs acceptance' }),
    ticket('t-2', 'draft', { title: 'A draft' }),
    ticket('t-3', 'active', { title: 'Busy', priority: 3, running: true, roundCount: 2, latestNote: 'compiling', access: 'read' }),
    ticket('t-4', 'todo', { title: 'Queued', lockedBy: { id: 't-3', title: 'Busy' } }),
    ticket('t-5', 'done', { title: 'Shipped' }),
    ticket('t-6', 'cancelled', { title: 'Dropped' }),
  ],
}

const labels = () => [...document.querySelectorAll('section[aria-label]')].map(node => node.getAttribute('aria-label'))
const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>('button')]
const rowOf = (title: string) => [...document.querySelectorAll<HTMLElement>('.dsh-dot-ticket')].find(node => node.textContent?.includes(title))!
const click = (element: Element) => act(async () => { (element as HTMLElement).click() })
const named = (scope: ParentNode, text: string) => buttons(scope).find(button => button.textContent === text)!

describe('Board', () => {
  it('draws the groups in order: needs you, in progress, to do, recently finished, watched sessions, reminders', async () => {
    const { root } = await render(full)
    expect(labels()).toEqual(['Needs you', 'In progress', 'To do', 'Recently finished', 'Watched sessions', 'Reminders'])
    const waiting = document.querySelector('section[aria-label="Needs you"]')!
    expect(waiting.textContent).toContain('Needs you · 3')
    // Requests first, then the task awaiting the human, then drafts.
    const titles = [...waiting.querySelectorAll('.dsh-ui-compact')].map(node => node.textContent)
    expect(titles).toEqual(['pwsh', 'Needs acceptance', 'A draft'])
    await act(async () => root.unmount())
  })

  it('keeps finished tasks folded to a count until opened', async () => {
    const { root } = await render(full)
    expect(document.body.textContent).toContain('Recently finished · 2')
    expect(document.body.textContent).not.toContain('Shipped')
    expect(document.body.textContent).not.toContain('Dropped')
    await click(named(document, 'Recently finished · 2'))
    expect(document.body.textContent).toContain('Shipped')
    expect(document.body.textContent).toContain('Dropped')
    expect(rowOf('Shipped').textContent).toContain('Done')
    expect(rowOf('Dropped').textContent).toContain('Cancelled')
    await act(async () => root.unmount())
  })

  it('shows state, title, priority, access, directory, latest note, rounds and the blocker on a row', async () => {
    const { root } = await render(full)
    const busy = rowOf('Busy')
    expect(busy.textContent).toContain('In progress')
    expect(busy.textContent).toContain('High priority')
    expect(busy.textContent).toContain('Read-only · /work/t-3 · 2 rounds')
    expect(busy.textContent).toContain('compiling')
    expect(rowOf('Queued').textContent).toContain('Waiting for t-3 to release the directory')
    // Normal priority is not shown.
    expect(rowOf('Queued').textContent).not.toContain('Normal priority')
    expect(rowOf('A draft').textContent).toContain('Draft')
    await act(async () => root.unmount())
  })

  it('flags waiting, error and orphaned tasks', async () => {
    const view: BoardView = { ...full, pending: [], tasks: [], schedules: [], tickets: [
      ticket('t-1', 'active', { title: 'Asking', waiting: true }),
      ticket('t-2', 'active', { title: 'Broken', error: true }),
      ticket('t-3', 'review', { title: 'Lost', orphaned: true }),
    ] }
    const { root } = await render(view)
    expect(rowOf('Asking').textContent).toContain('Request waiting')
    expect(rowOf('Broken').textContent).toContain('Error')
    expect(rowOf('Lost').textContent).toContain('No session')
    await act(async () => root.unmount())
  })

  it('offers the row buttons the design gives each state', async () => {
    const { root } = await render(full)
    await click(named(document, 'Recently finished · 2'))
    const names = (title: string) => buttons(rowOf(title)).map(button => button.textContent).filter(text => text && !text.startsWith('Task'))
    expect(names('A draft').filter(text => ['Confirm', 'Delete', 'Cancel', 'Pass', 'Send back'].includes(text!))).toEqual(['Confirm', 'Delete', 'Cancel'])
    expect(names('Needs acceptance').filter(text => ['Confirm', 'Delete', 'Cancel', 'Pass', 'Send back'].includes(text!))).toEqual(['Pass', 'Send back', 'Cancel'])
    expect(names('Busy').filter(text => ['Confirm', 'Delete', 'Cancel', 'Pass', 'Send back'].includes(text!))).toEqual(['Cancel'])
    expect(names('Queued').filter(text => ['Confirm', 'Delete', 'Cancel', 'Pass', 'Send back'].includes(text!))).toEqual(['Cancel'])
    expect(names('Shipped').filter(text => ['Confirm', 'Delete', 'Cancel', 'Pass', 'Send back'].includes(text!))).toEqual([])
    await act(async () => root.unmount())
  })

  it('sends the confirm, delete, cancel and pass actions', async () => {
    const { props, root } = await render(full)
    await click(named(rowOf('A draft'), 'Confirm'))
    await click(named(rowOf('A draft'), 'Delete'))
    await click(named(rowOf('A draft'), 'Cancel'))
    await click(named(rowOf('Needs acceptance'), 'Pass'))
    await click(named(rowOf('Busy'), 'Cancel'))
    expect(props.onConfirm).toHaveBeenCalledWith('t-2')
    expect(props.onDelete).toHaveBeenCalledWith('t-2')
    expect(props.onCancel.mock.calls).toEqual([['t-2'], ['t-3']])
    expect(props.onReview).toHaveBeenCalledWith('t-1', true)
    await act(async () => root.unmount())
  })

  it('sends a task back with the typed note, or without one, and lets the human back out', async () => {
    const { props, root } = await render(full)
    await click(named(rowOf('Needs acceptance'), 'Send back'))
    const input = rowOf('Needs acceptance').querySelector<HTMLInputElement>('input')!
    expect(input.getAttribute('aria-label')).toBe('Why it goes back (optional)')
    const propsKey = Object.keys(input).find(key => key.startsWith('__reactProps'))!
    await act(async () => {
      input.value = '  tests missing  '
      ;(input as unknown as Record<string, { onChange: (event: { target: HTMLElement }) => void }>)[propsKey]!.onChange({ target: input })
    })
    await click(named(rowOf('Needs acceptance'), 'Send back now'))
    expect(props.onReview).toHaveBeenCalledWith('t-1', false, 'tests missing')
    // Back to the plain row, and a second send-back without a note.
    expect(rowOf('Needs acceptance').querySelector('input')).toBeNull()
    await click(named(rowOf('Needs acceptance'), 'Send back'))
    await click(named(rowOf('Needs acceptance'), 'Back'))
    expect(rowOf('Needs acceptance').querySelector('input')).toBeNull()
    await click(named(rowOf('Needs acceptance'), 'Send back'))
    await click(named(rowOf('Needs acceptance'), 'Send back now'))
    expect(props.onReview).toHaveBeenLastCalledWith('t-1', false, undefined)
    await act(async () => root.unmount())
  })

  it('opens a row to show goal, deliverable, acceptance, sessions, rounds and history, and changes the priority there', async () => {
    const detailed: BoardView = { ...full, pending: [], tasks: [], schedules: [], tickets: [ticket('t-9', 'active', {
      title: 'Detailed', goal: 'ship the thing', deliverable: 'a patch', acceptance: 'tests pass',
      sessions: [{ sessionId: 'sess-old', role: 'work', at: 1_700_000_000_000 }, { sessionId: 'sess-new', role: 'rework', at: 1_700_000_100_000 }],
      rounds: [{ n: 1, at: 1_700_000_050_000, role: 'review', summary: 'missing tests', verdict: 'fail' }],
      history: [
        { at: 1_700_000_000_000, to: 'active', by: 'dot', reason: 'starting' },
        { at: 1_700_000_060_000, from: 'review', to: 'active', by: 'human', reason: 'sent back on the board' },
      ],
      roundCount: 1,
    })] }
    const { props, root } = await render(detailed)
    expect(document.body.textContent).not.toContain('ship the thing')
    await click(document.querySelector('.dsh-dot-ticket-head > button.dsh-dot-row')!)
    const text = document.body.textContent!
    for (const part of ['Goal', 'ship the thing', 'Deliverable', 'a patch', 'Acceptance criteria', 'tests pass', 'Sessions', 'Rounds', 'missing tests', 'Failed', 'History', 'sent back on the board', 'You', 'Dorothy']) expect(text).toContain(part)
    expect(text).toContain('In review → In progress')

    // Sessions open the session; the newest comes first.
    const sessions = [...document.querySelectorAll<HTMLButtonElement>('.dsh-dot-line')]
    expect(sessions.map(button => button.title)).toEqual(['sess-new', 'sess-old'])
    await click(sessions[0]!)
    expect(props.onOpen).toHaveBeenCalledWith('sess-new')

    // Three priority choices; picking another one reports it.
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map(tab => tab.textContent)).toEqual(['High priority', 'Normal priority', 'Low priority'])
    await click(tabs[0]!)
    expect(props.onPriority).toHaveBeenCalledWith('t-9', 3)
    await click(tabs[1]!)
    expect(props.onPriority).toHaveBeenCalledTimes(1)

    // Closing the detail again.
    await click(document.querySelector('.dsh-dot-ticket-head > button.dsh-dot-row')!)
    expect(document.body.textContent).not.toContain('ship the thing')
    await act(async () => root.unmount())
  })

  it('has no priority choice on a finished task', async () => {
    const { root } = await render({ ...full, pending: [], tasks: [], schedules: [], tickets: [ticket('t-5', 'done', { title: 'Shipped' })] })
    await click(named(document, 'Recently finished · 1'))
    await click(document.querySelector('.dsh-dot-ticket-head > button.dsh-dot-row')!)
    expect(document.body.textContent).toContain('goal of t-5')
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0)
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
    // The request row opens its session too.
    await click(document.querySelector('section[aria-label="Needs you"] > button')!)
    expect(props.onOpen).toHaveBeenCalledWith('s-req')
    await act(async () => root.unmount())
  })

  it('shows an empty note, a failed action and a load failure', async () => {
    const empty = await render({ tasks: [], tickets: [], pending: [], schedules: [] })
    expect(document.body.textContent).toContain('No tasks yet.')
    expect(labels()).toEqual([])
    await act(async () => empty.root.unmount())

    const failed = await render({ tasks: [], tickets: [ticket('t-1', 'draft')], pending: [], schedules: [] }, { notice: 'Only draft tickets can be deleted' })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('That did not go through: Only draft tickets can be deleted')
    await act(async () => failed.root.unmount())

    const broken = await render(undefined, { error: 'offline' })
    expect(document.body.textContent).toContain('Could not reach Dorothy')
    await click(named(document, t('en', 'retry')))
    expect(broken.props.onRetry).toHaveBeenCalled()
    await act(async () => broken.root.unmount())
  })

  it('draws the Chinese copy for the groups, states and buttons', async () => {
    const { root } = await render(full, {}, 'zh')
    expect(labels()).toEqual(['待处理', '进行中', '待办', '最近完成', '关注会话', '提醒'])
    expect(rowOf('A draft').textContent).toContain('草稿')
    expect(rowOf('Busy').textContent).toContain('高优先级')
    expect(rowOf('Busy').textContent).toContain('只读')
    expect(rowOf('Queued').textContent).toContain('等待 t-3 释放资源')
    expect(buttons(rowOf('A draft')).map(button => button.textContent)).toEqual(expect.arrayContaining(['确认', '删除', '取消']))
    expect(buttons(rowOf('Needs acceptance')).map(button => button.textContent)).toEqual(expect.arrayContaining(['通过', '驳回', '取消']))
    await act(async () => root.unmount())
  })
})
