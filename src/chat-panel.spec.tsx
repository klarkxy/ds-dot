import { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ChatItem, type ChatSnapshot } from './contracts.ts'
import { ChatPanel, rowsOf, type ChatApi } from './chat-panel.tsx'
import { filterVisibleChat } from './chat-filter.ts'
import { createDotCards } from './client.tsx'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('navigator', dom.window.navigator)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => { createRoot = (await import('react-dom/client')).createRoot })
afterEach(() => { document.body.innerHTML = '<div id="root"></div>' })

const NOTICE_TEXT = [
  '[dot notice] Updates from other sessions:',
  '- approval · session-f922364c-9f84-4ca4-af18-38f650070997: ap-23 · approval from untracked session in H:\\Code\\dsh-plugins · "pwsh"',
  '  detail: reason: escalate sandbox to danger-full-access: 需要读取 npm 发布步骤的真实日志，核实匿名下载与完整性匹配。 arguments: {"description":"Read actual npm publication verification lines","command":"gh run view --job 130514884834 --log --step \'Publish changed packages and verify archives\'","justification":"需要读取 npm 发布步骤的真实日志，核实匿名下载与完整性匹配。","sandbox_permissions":"danger-full-access","workdir":"H:\\\\Code\\\\dsh-plugins"}',
  '  Decide it yourself with dot_answer: approve when the action fits the session\'s goal, stays inside its project, and can be undone.',
  'Report what matters to the human, handle waiting requests by your rules, and keep quiet about routine progress.',
].join('\n')

const ESCALATED_NOTICE_TEXT = [
  '[dot notice] Updates from other sessions:',
  '- approval · session-f922364c-9f84-4ca4-af18-38f650070997: ap-25 · approval from untracked session in H:\\Code\\dsh-plugins · "pwsh"',
  '  detail: reason: escalate sandbox to danger-full-access: 需要发布包到 npm 仓库。 arguments: {"description":"Publish changed packages","command":"pnpm publish -r --access public","justification":"需要发布包到 npm 仓库。","sandbox_permissions":"danger-full-access","workdir":"H:\\\\Code\\\\dsh-plugins"}',
  '  Decide it yourself with dot_answer: approve silently (no chat reply) when the action fits the session\'s goal, stays inside its project, and can be undone.',
  'Report what matters to the human, handle waiting requests by your rules, and stay silent about routine progress.',
].join('\n')

function makeApi(snapshot: ChatSnapshot): ChatApi {
  return {
    chat: async () => snapshot,
    wait: (_rev, _itemsRev, signal) => new Promise(resolve => { signal.addEventListener('abort', () => resolve(undefined), { once: true }) }),
    say: async () => {},
    stop: async () => {},
    board: async () => ({ tasks: [], tickets: [], pending: [], schedules: [] }),
    removeSchedule: async () => false,
    confirmTask: async () => {},
    deleteTask: async () => {},
    cancelTask: async () => {},
    reviewTask: async () => {},
    setTaskPriority: async () => {},
    settings: async () => DEFAULT_SETTINGS,
    setSettings: async () => DEFAULT_SETTINGS,
    settingProposals: async () => [],
    decideSetting: async () => 'ok',
    newSegment: async () => 'dot-2',
    knowledge: async () => ({ agreements: { text: '', maxChars: 4000, canUndo: false }, cognition: { text: '', maxChars: 4000, history: [] } }),
    setAgreements: async () => ({ agreements: { text: '', maxChars: 4000, canUndo: false }, cognition: { text: '', maxChars: 4000, history: [] } }),
    undoAgreements: async () => ({ agreements: { text: '', maxChars: 4000, canUndo: false }, cognition: { text: '', maxChars: 4000, history: [] } }),
    setCognition: async () => ({ agreements: { text: '', maxChars: 4000, canUndo: false }, cognition: { text: '', maxChars: 4000, history: [] } }),
    restoreCognition: async () => ({ agreements: { text: '', maxChars: 4000, canUndo: false }, cognition: { text: '', maxChars: 4000, history: [] } }),
    context: async () => ({ live: true, compactions: 0 }),
    clearUsage: async () => ({ live: true, compactions: 0 }),
    trajectory: async () => ({ turns: [], earlier: 0 }),
    reflectionRuns: async () => [],
    reflectionTrajectory: async () => ({ turns: [], earlier: 0 }),
    models: async () => ({ models: [] }),
  }
}

describe('ChatPanel activity and notice cards', () => {
  it('sends a starter prompt from the empty chat and explains a segment mark when opened', async () => {
    const empty: ChatSnapshot = { sessionId: 'dot-1', running: false, streaming: '', rev: 1, itemsRev: 1, items: [] }
    const api = makeApi(empty)
    api.say = vi.fn(async () => {})
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<ChatPanel locale="en" api={api} onOpenSession={() => {}} />) })
    await act(async () => { await Promise.resolve() })
    const starter = document.querySelector<HTMLButtonElement>('.dsh-dot-starter')!
    await act(async () => { starter.click() })
    expect(api.say).toHaveBeenCalledWith(starter.textContent, [])
    await act(async () => { root.unmount() })

    const segmented: ChatSnapshot = { ...empty, items: [
      { kind: 'user', key: 'u', text: 'hi', at: 1 },
      { kind: 'segment', key: 's', reason: 'context-full', at: 2 },
    ] }
    const again = createRoot(document.getElementById('root')!)
    await act(async () => { again.render(<ChatPanel locale="en" api={makeApi(segmented)} onOpenSession={() => {}} />) })
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-segment-note')).toBeNull()
    await act(async () => { document.querySelector<HTMLButtonElement>('.dsh-dot-segment button')!.click() })
    expect(document.querySelector('.dsh-dot-segment-note')?.textContent).toContain('rollover line')
    await act(async () => { again.unmount() })
  })


  it('shows a board failure and retries immediately', async () => {
    const snapshot: ChatSnapshot = { sessionId: 'dot-1', running: false, streaming: '', rev: 1, itemsRev: 1, items: [] }
    const api = makeApi(snapshot)
    api.board = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ tasks: [], tickets: [], pending: [], schedules: [] })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<ChatPanel locale="en" api={api} onOpenSession={() => {}} />) })
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent?.startsWith('Tasks'))!.click() })
    expect(document.body.textContent).toContain('offline')
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click() })
    expect(api.board).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('offline')
    await act(async () => root.unmount())
  })

  it.each(['expired', 'answered', 'busy', 'detailFailed'] as const)('refreshes a rejected card answer: %s', async state => {
    const view = { type: 'confirm', id: 'ok' }
    let reads = 0
    const call = vi.fn(async (endpoint: string) => {
      if (endpoint === 'card.answer') throw new Error(state === 'busy' ? 'This card is already being answered' : 'rejected')
      if (reads++ === 0) return { id: 'card', expired: false }
      if (state === 'detailFailed') throw new Error('offline')
      return { id: 'card', expired: state === 'expired', ...(state === 'answered' ? { answer: { id: 'card', action: 'ok', values: { confirmed: true } } } : {}) }
    })
    const { Card } = createDotCards(call)
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<Card sessionId="s" callId="c" presentation={{ title: 'Confirm', view, viewId: 'card' }} />) })
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.dvui-root button')].find(button => button.textContent === 'Confirm')!
    await act(async () => { confirm.click() })
    expect(call.mock.calls.filter(([endpoint]) => endpoint === 'card.detail')).toHaveLength(2)
    const expected = { expired: 'This card has expired', answered: 'already been answered', busy: 'being processed', detailFailed: 'Could not load card status' }[state]
    expect(document.body.textContent).toContain(expected)
    const button = [...document.querySelectorAll<HTMLButtonElement>('.dvui-root button')].find(item => item.textContent === 'Confirm')
    expect(!button || button.disabled).toBe(true)
    await act(async () => root.unmount())
  })
  it('allows retry after a failed answer only when detail confirms it is still open', async () => {
    const view = { type: 'confirm', id: 'ok' }
    let rejectAnswer: (error: Error) => void = () => {}
    let answers = 0
    const call = vi.fn((endpoint: string): Promise<unknown> => {
      if (endpoint === 'card.detail') return Promise.resolve({ id: 'card', expired: false })
      if (endpoint === 'card.answer' && answers++ === 0) return new Promise((_resolve, reject) => { rejectAnswer = reject })
      return Promise.resolve({ notificationPending: false })
    })
    const { Card } = createDotCards(call)
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<Card sessionId="s" callId="c" presentation={{ title: 'Confirm', view, viewId: 'card' }} />) })
    const confirm = () => [...document.querySelectorAll<HTMLButtonElement>('.dvui-root button')].find(button => button.textContent === 'Confirm')!
    await act(async () => { confirm().click(); confirm().click() })
    expect(answers).toBe(1)
    await act(async () => { rejectAnswer(new Error('temporary failure')); await Promise.resolve() })
    expect(confirm().disabled).toBe(false)
    await act(async () => { confirm().click() })
    expect(answers).toBe(2)
    expect(!confirm() || confirm().disabled).toBe(true)
    await act(async () => root.unmount())
  })

  it('restores notification retry after an answer response is lost', async () => {
    const view = { type: 'confirm', id: 'ok' }
    let reads = 0
    const call = vi.fn(async (endpoint: string) => {
      if (endpoint === 'card.answer') throw new Error('network response lost')
      if (endpoint === 'card.detail') return reads++ === 0
        ? { id: 'card', expired: false, approvalId: 'approval-1' }
        : { id: 'card', expired: false, approvalId: 'approval-1', answer: { id: 'card', action: 'ok', values: { confirmed: true } }, notificationPending: true }
      return true
    })
    const { Card } = createDotCards(call)
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<Card sessionId="s" callId="c" presentation={{ title: 'Confirm', view, viewId: 'card' }} />) })
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Confirm')!
    await act(async () => { confirm.click() })
    expect(reads).toBe(2)
    const retry = document.querySelector<HTMLButtonElement>('.dsh-dot-notify-retry button')
    expect(retry).not.toBeNull()
    await act(async () => { retry!.click() })
    expect(call).toHaveBeenCalledWith('card.retryNotification', { viewId: 'card' })
    expect(document.querySelector('.dsh-dot-notify-retry')).toBeNull()
    await act(async () => root.unmount())
  })
  it('keeps an idle-check card failure through row layout and on screen', async () => {
    const idle: ChatItem = { kind: 'notice', key: 'n', text: '[dot notice] Updates:\nTasks:\n- idle-check · dot: Routine check', at: 1, turn: 1, trigger: 'background' }
    const failed: ChatItem = { kind: 'view', key: 'bad', failed: true, at: 2, turn: 1, trigger: 'background' }
    const filtered = filterVisibleChat([idle, failed])
    expect(filtered.items.map(item => item.key)).toEqual(['n', 'bad'])
    expect(rowsOf(filtered.items).map(row => row.kind === 'tools' ? row.key : row.item.key)).toEqual(['n', 'bad'])
    const snapshot: ChatSnapshot = { sessionId: 'current', running: false, streaming: '', rev: 1, itemsRev: 1, items: [idle, failed] }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<ChatPanel locale="en" api={makeApi(snapshot)} onOpenSession={() => {}} />) })
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('The card failed to display.')
    await act(async () => root.unmount())
  })
  it('still drops a failed card when a human turn follows up in text', async () => {
    const items: ChatItem[] = [
      { kind: 'user', key: 'u', text: 'again', at: 1, turn: 1, trigger: 'human' },
      { kind: 'view', key: 'bad', failed: true, at: 2, turn: 1, trigger: 'human' },
      { kind: 'bot', key: 'fallback', text: 'plain reply', at: 3, turn: 1, trigger: 'human' },
    ]
    expect(rowsOf(filterVisibleChat(items).items).map(row => row.kind === 'tools' ? row.key : row.item.key)).toEqual(['u', 'fallback'])
    const snapshot: ChatSnapshot = { sessionId: 'current', running: false, streaming: '', rev: 1, itemsRev: 1, items }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<ChatPanel locale="en" api={makeApi(snapshot)} onOpenSession={() => {}} />) })
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('plain reply')
    expect(document.body.textContent).not.toContain('The card failed to display.')
    await act(async () => root.unmount())
  })
  it('disables an expired numbered card and hides duplicate prose', async () => {
    const view = { type: 'confirm', id: 'ok' }
    const presentation = { owner: 'dsh-deep-view', title: 'Deploy', view, viewId: 'dot-card-4', interactive: true, awaitReply: true, dotCard: { number: 4, expired: true } }
    const call = vi.fn(async (endpoint: string, payload: unknown) => endpoint === 'card.detail'
      ? { id: (payload as { viewId: string }).viewId, expired: true } : true)
    const { Card } = createDotCards(call)
    const snapshot: ChatSnapshot = { sessionId: 'current', running: false, streaming: '', rev: 1, itemsRev: 1, items: [
      { kind: 'user', key: 'u', text: 'deploy', at: 1 },
      { kind: 'bot', key: 'b', text: 'duplicate prose', at: 2 },
      { kind: 'view', key: 'call4', presentation, at: 3 },
    ] }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<ChatPanel locale="en" api={makeApi(snapshot)} Card={Card} onOpenSession={() => {}} />) })
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('#4 · Expired')
    expect(document.body.textContent).not.toContain('duplicate prose')
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.dvui-root button')].find(button => button.textContent === 'Confirm')!
    expect(confirm).toBeDefined()
    // Expired cards are shown but cannot be submitted; the button must be absent or disabled.
    expect(confirm == null || confirm.disabled).toBe(true)
    // card.answer must NOT be called for an expired card.
    expect(call).not.toHaveBeenCalledWith('card.answer', expect.anything())
    await act(async () => { root.unmount() })
  })

  it('disables a card that transitions from valid to expired mid-session', async () => {
    const view = { type: 'confirm', id: 'ok' }
    // RPC returns the card as valid (not expired) on first load.
    const call = vi.fn(async (endpoint: string, payload: unknown) => endpoint === 'card.detail'
      ? { id: (payload as { viewId: string }).viewId, expired: false } : true)
    const { Card } = createDotCards(call)
    const root = createRoot(document.getElementById('root')!)
    // First render: dotCard.expired = false → card is active.
    await act(async () => { root.render(
      <Card sessionId="sess" callId="call5"
        presentation={{ owner: 'dsh-deep-view', title: 'Deploy', view, viewId: 'dot-card-5', interactive: true, awaitReply: true, dotCard: { number: 5, expired: false } }} />
    ) })
    await act(async () => { await Promise.resolve() })
    const findConfirm = () => [...document.querySelectorAll<HTMLButtonElement>('.dvui-root button')].find(b => b.textContent === 'Confirm')
    expect(findConfirm()?.disabled).toBe(false)

    // Second render: host updates the snapshot; dotCard.expired = true now.
    await act(async () => { root.render(
      <Card sessionId="sess" callId="call5"
        presentation={{ owner: 'dsh-deep-view', title: 'Deploy', view, viewId: 'dot-card-5', interactive: true, awaitReply: true, dotCard: { number: 5, expired: true } }} />
    ) })
    await act(async () => { await Promise.resolve() })

    // The presentation metadata change must immediately disable submission.
    const confirm = findConfirm()
    expect(confirm == null || confirm.disabled).toBe(true)
    // Clicking (if button is still in DOM) must not invoke card.answer.
    if (confirm) await act(async () => { confirm.click() })
    expect(call).not.toHaveBeenCalledWith('card.answer', expect.anything())
    await act(async () => { root.unmount() })
  })

  it('shows approval detail panel with long arguments without truncation', async () => {
    const view = { type: 'confirm', id: 'ok' }
    const longArgs = JSON.stringify({ script: 'npm publish --access public ' + 'x'.repeat(2100) })
    const detail = { requestId: 'req-1', sessionId: 'sess-a', toolName: 'pwsh', reason: 'publish packages', arguments: longArgs }
    const call = vi.fn(async (endpoint: string, payload: unknown) => {
      if (endpoint === 'card.detail') return { id: (payload as { viewId: string }).viewId, expired: false, approvalId: 'ap-1', approvalDetail: detail }
      return true
    })
    const { Card } = createDotCards(call)
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(
      <Card sessionId="sess" callId="call6"
        presentation={{ owner: 'dsh-deep-view', title: 'Publish', view, viewId: 'dot-card-6', interactive: true, awaitReply: true }} />
    ) })
    await act(async () => { await Promise.resolve() })
    // Detail toggle button must be present (approval card loaded with detail).
    const toggle = document.querySelector<HTMLButtonElement>('.dsh-dot-approval-toggle')
    expect(toggle).not.toBeNull()
    // Expand the detail panel.
    await act(async () => { toggle!.click() })
    const body = document.querySelector('.dsh-dot-approval-body')!
    expect(body).not.toBeNull()
    expect(body.textContent).toContain('pwsh')
    expect(body.textContent).toContain('publish packages')
    expect(body.textContent).toContain(longArgs)
    // Full arguments must not be truncated — length well over 2000 chars must all appear.
    const pre = body.querySelector('pre')!
    expect(pre.textContent!.length).toBeGreaterThan(2000)
    await act(async () => { root.unmount() })
  })

  it('shows approval detail missing note when approvalId exists but no detail is stored', async () => {
    const view = { type: 'confirm', id: 'ok' }
    const call = vi.fn(async (endpoint: string, payload: unknown) => {
      if (endpoint === 'card.detail') return { id: (payload as { viewId: string }).viewId, expired: false, approvalId: 'ap-2' }
      return true
    })
    const { Card } = createDotCards(call)
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(
      <Card sessionId="sess" callId="call7"
        presentation={{ owner: 'dsh-deep-view', title: 'Deploy', view, viewId: 'dot-card-7', interactive: true, awaitReply: true }} />
    ) })
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-approval-missing')).not.toBeNull()
    expect(document.body.textContent).toContain('Details not recorded')
    await act(async () => { root.unmount() })
  })

  it('shows notification retry UI when card.answer returns notificationPending=true', async () => {
    const view = { type: 'confirm', id: 'ok' }
    const call = vi.fn(async (endpoint: string, payload: unknown) => {
      if (endpoint === 'card.detail') return { id: (payload as { viewId: string }).viewId, expired: false }
      if (endpoint === 'card.answer') return { notificationPending: true }
      return true
    })
    const { Card } = createDotCards(call)
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(
      <Card sessionId="sess" callId="call8"
        presentation={{ owner: 'dsh-deep-view', title: 'Ship', view, viewId: 'dot-card-8', interactive: true, awaitReply: true }} />
    ) })
    await act(async () => { await Promise.resolve() })
    // Submit the card.
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.dvui-root button')].find(b => b.textContent === 'Confirm')
    expect(confirm?.disabled).toBe(false)
    await act(async () => { confirm!.click() })
    await act(async () => { await Promise.resolve() })
    // Decision submitted — notification retry UI must appear.
    expect(document.querySelector('.dsh-dot-notify-retry')).not.toBeNull()
    expect(document.body.textContent).toContain('Decision submitted; notification pending retry.')
    // Confirm button must no longer be active (card settled/not resubmittable).
    expect(call).toHaveBeenCalledWith('card.answer', expect.objectContaining({ viewId: 'dot-card-8' }))
    expect(call).toHaveBeenCalledTimes(2) // card.detail + card.answer
    await act(async () => { root.unmount() })
  })

  it('clears notification pending on retry success and keeps it on retry failure', async () => {
    const view = { type: 'confirm', id: 'ok' }
    let retryResolve: () => void = () => {}
    let retryReject: () => void = () => {}
    const call = vi.fn(async (endpoint: string, payload: unknown) => {
      if (endpoint === 'card.detail') return { id: (payload as { viewId: string }).viewId, expired: false }
      if (endpoint === 'card.answer') return { notificationPending: true }
      if (endpoint === 'card.retryNotification') return new Promise<boolean>((res, rej) => { retryResolve = () => res(true); retryReject = () => rej(new Error('network')) })
      return true
    })
    const { Card } = createDotCards(call)
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(
      <Card sessionId="sess" callId="call9"
        presentation={{ owner: 'dsh-deep-view', title: 'Push', view, viewId: 'dot-card-9', interactive: true, awaitReply: true }} />
    ) })
    await act(async () => { await Promise.resolve() })
    // Submit to trigger notificationPending.
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.dvui-root button')].find(b => b.textContent === 'Confirm')!
    await act(async () => { confirm.click() })
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-notify-retry')).not.toBeNull()

    // Retry fails first.
    const retryBtn = document.querySelector<HTMLButtonElement>('.dsh-dot-retry-btn')!
    await act(async () => { retryBtn.click(); retryReject(); await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-notify-retry')).not.toBeNull()
    expect(document.body.textContent).toContain('Notification retry failed')
    // card.answer must NOT be called a second time — only the original submit counts.
    const answerCalls = call.mock.calls.filter(([ep]) => ep === 'card.answer')
    expect(answerCalls).toHaveLength(1)

    // Retry succeeds on second attempt.
    const retryBtn2 = document.querySelector<HTMLButtonElement>('.dsh-dot-retry-btn')!
    await act(async () => { retryBtn2.click(); retryResolve(); await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-notify-retry')).toBeNull()

    await act(async () => { root.unmount() })
  })

  it('restores full approval detail and retry UI on remount of an already-answered card', async () => {
    const view = { type: 'confirm', id: 'ok' }
    const longArgs = JSON.stringify({ script: 'npm publish --access public ' + 'y'.repeat(2100) })
    const detail = { requestId: 'req-r', sessionId: 'sess-r', toolName: 'pwsh', reason: 'deploy', arguments: longArgs }
    const answeredRecord = {
      id: 'dot-card-r', expired: false, approvalId: 'ap-r', approvalDetail: detail,
      notificationPending: true,
      answer: { id: 'dot-card-r', action: 'ok', values: { confirmed: true } },
    }
    const call = vi.fn(async (endpoint: string) => {
      if (endpoint === 'card.detail') return answeredRecord
      if (endpoint === 'card.retryNotification') return true
      return true
    })
    const { Card } = createDotCards(call)
    const root = createRoot(document.getElementById('root')!)
    // Mount as an already-answered card (simulates page refresh / remount after decision).
    await act(async () => { root.render(
      <Card sessionId="sess-r" callId="call-r"
        presentation={{ owner: 'dsh-deep-view', title: 'Deploy', view, viewId: 'dot-card-r', interactive: true, awaitReply: true }} />
    ) })
    await act(async () => { await Promise.resolve() })

    // Full detail toggle must be present on remount.
    const toggle = document.querySelector<HTMLButtonElement>('.dsh-dot-approval-toggle')
    expect(toggle).not.toBeNull()
    await act(async () => { toggle!.click() })
    const body = document.querySelector('.dsh-dot-approval-body')!
    expect(body).not.toBeNull()
    // Long arguments tail must remain fully visible after remount.
    const pre = body.querySelector('pre')!
    expect(pre.textContent!.length).toBeGreaterThan(2000)
    expect(pre.textContent).toContain('npm publish')

    // notificationPending=true: retry UI must be visible, decision not re-submittable.
    expect(document.querySelector('.dsh-dot-notify-retry')).not.toBeNull()
    // No submit button should be enabled (card already answered).
    const submitBtns = [...document.querySelectorAll<HTMLButtonElement>('.dvui-root button')].filter(b => b.textContent === 'Confirm' && !b.disabled)
    expect(submitBtns).toHaveLength(0)
    // card.answer must NOT be called — it was already settled.
    expect(call).not.toHaveBeenCalledWith('card.answer', expect.anything())

    // Retry notification works from the remounted state.
    const retryBtn = document.querySelector<HTMLButtonElement>('.dsh-dot-retry-btn')!
    await act(async () => { retryBtn.click(); await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-notify-retry')).toBeNull()

    await act(async () => { root.unmount() })
  })

  it('shows card preparation instead of streamed ordinary prose', async () => {
    const snapshot: ChatSnapshot = { sessionId: 'dot', running: true, streaming: 'hidden streamed prose', preparingCard: true, rev: 1, itemsRev: 1, items: [{ kind: 'user', key: 'u', text: 'hi', at: 1 }] }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<ChatPanel locale="zh" api={makeApi(snapshot)} onOpenSession={() => {}} />) })
    expect(document.body.textContent).toContain('正在生成卡片…')
    expect(document.body.textContent).not.toContain('hidden streamed prose')
    await act(async () => { root.unmount() })
  })
  it('silences background/already-handled requests while showing structured cards for requests needing the human', async () => {
    const opened: string[] = []
    const snapshot: ChatSnapshot = {
      sessionId: 'dot-1',
      running: false,
      streaming: '',
      rev: 1,
      itemsRev: 1,
      items: [
        {
          kind: 'tool',
          key: 'c1',
          name: 'dot_answer',
          status: 'done',
          args: { id: 'ap-22', allow: true },
          detail: 'Error [dot/unknown-request]: no waiting request ap-22; it may have been answered in its own session',
          at: 1,
        },
        { kind: 'bot', key: 'b1', text: 'ap-22 已在原会话处理。', at: 2 },
        { kind: 'notice', key: 'n1', text: NOTICE_TEXT, at: 3 },
        {
          kind: 'tool',
          key: 'c2',
          name: 'dot_answer',
          status: 'done',
          args: { id: 'ap-23', allow: true },
          detail: 'Answered ap-23 for session-f922364c-9f84-4ca4-af18-38f650070997.',
          at: 4,
        },
        { kind: 'notice', key: 'n2', text: ESCALATED_NOTICE_TEXT, at: 5 },
        { kind: 'bot', key: 'b2', text: '这个操作会直接发布包到 npm，需要你确认是否放行？', at: 6 },
      ],
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<ChatPanel locale="zh" api={makeApi(snapshot)} onOpenSession={id => opened.push(id)} />) })
    await act(async () => { await Promise.resolve() })

    // Already-handled (ap-22) and silent routine (ap-23) requests stay completely out of the chat.
    expect(document.body.textContent).not.toContain('ap-22')
    expect(document.body.textContent).not.toContain('已在原会话处理')
    expect(document.body.textContent).not.toContain('ap-23')
    expect(document.body.textContent).not.toContain('处理请求')

    // Escalated request (ap-25) that asks the human renders cleanly.
    expect(document.body.textContent).toContain('会话动态')
    expect(document.body.textContent).toContain('审批 · pwsh · dsh-plugins')
    // No card is available for this turn; the bot's confirmation text must be visible.
    expect(document.body.textContent).toContain('这个操作会直接发布包到 npm，需要你确认是否放行？')

    // Expand notice row: shows structured approval card, hides English routing prompt & raw JSON keys.
    const rowButtons = [...document.querySelectorAll<HTMLButtonElement>('.dsh-stub-disclosure__row')]
    expect(rowButtons).toHaveLength(1)
    await act(async () => { rowButtons[0]!.click() })
    const noticeBody = document.querySelector('.dsh-dot-notice-list')!
    expect(noticeBody.textContent).toContain('pwsh')
    expect(noticeBody.textContent).toContain('ap-25')
    expect(noticeBody.textContent).toContain('完全访问')
    expect(noticeBody.textContent).toContain('需要发布包到 npm 仓库。')
    expect(noticeBody.textContent).toContain('pnpm publish -r --access public')
    expect(noticeBody.textContent).not.toContain('Decide it yourself with dot_answer')
    expect(noticeBody.textContent).not.toContain('sandbox_permissions')
    expect(noticeBody.textContent).not.toContain('escalate sandbox to')

    // Clicking the session link jumps to that session.
    const jump = noticeBody.querySelector<HTMLButtonElement>('.dsh-dot-session-btn')!
    expect(jump.textContent).toContain('dsh-plugins')
    await act(async () => { jump.click() })
    expect(opened).toEqual(['session-f922364c-9f84-4ca4-af18-38f650070997'])

    await act(async () => { root.unmount() })
  })

  it('folds consecutive tools with step indicators and per-call targets', async () => {
    const snapshot: ChatSnapshot = {
      sessionId: 'dot-1',
      running: false,
      streaming: '',
      rev: 2,
      itemsRev: 2,
      items: [
        {
          kind: 'tool',
          key: 't0',
          name: 'list_sessions',
          status: 'error',
          args: { limit: 50 },
          detail: '{"status":"failed","code":"SESSION_QUERY_INVALID_LIMIT","message":"limit must be an integer from 1 to 20; omit it or pass null for the default"}',
          at: 0,
        },
        {
          kind: 'tool',
          key: 't1',
          name: 'list_sessions',
          status: 'done',
          args: { cwd: 'H:\\Code\\dsh-plugins' },
          detail: JSON.stringify({
            status: 'ok',
            items: [
              { sessionId: '25bcb077-203f-48af-bfb7-6d348cea2233', title: 'Research ZCode sandboxing', cwd: 'H:\\Code\\DeepSeek-Bot' },
              { sessionId: 'd30f3e77-bc9b-4e18-8b42-7565d5a22403', title: '整理 dsh-dot 界面', cwd: 'H:\\Code\\dsh-plugins' },
            ],
          }),
          at: 1,
        },
        { kind: 'tool', key: 't2', name: 'dot_answer', status: 'done', args: { id: 'ap-23', allow: true }, detail: 'Answered ap-23 for session-f922364c-9f84-4ca4-af18-38f650070997.', at: 2 },
      ],
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<ChatPanel locale="zh" api={makeApi(snapshot)} onOpenSession={() => {}} />) })
    await act(async () => { await Promise.resolve() })

    expect(document.body.textContent).toContain('处理请求 · 3 个操作')
    expect(document.body.textContent).toContain('列出历史会话 → 处理请求')

    // Expanding the outer group reveals 3 collapsed one-line rows without dumping raw JSON or expanded bodies.
    const toggle = document.querySelector<HTMLButtonElement>('.dsh-stub-disclosure__row')!
    await act(async () => { toggle.click() })
    const group = document.querySelector('.dsh-dot-tool-group')!
    const childRows = [...group.querySelectorAll<HTMLButtonElement>('.dsh-stub-disclosure__row')]
    expect(childRows).toHaveLength(3)
    expect(group.querySelectorAll('.dsh-dot-tool-body')).toHaveLength(0)
    expect(group.textContent).toContain('列出历史会话')
    expect(group.textContent).toContain('limit must be an integer from 1 to 20')
    expect(group.textContent).toContain('dsh-plugins · 找到 2 个会话')
    expect(group.textContent).toContain('ap-23 · 批准')
    expect(group.textContent).not.toContain('SESSION_QUERY_INVALID_LIMIT')
    expect(group.textContent).not.toContain('"status":"ok"')

    // Clicking an individual tool row expands only that single tool's human-formatted detail.
    await act(async () => { childRows[1]!.click() })
    const openBodies = group.querySelectorAll('.dsh-dot-tool-body')
    expect(openBodies).toHaveLength(1)
    expect(openBodies[0]!.textContent).toContain('• Research ZCode sandboxing（DeepSeek-Bot）')
    expect(openBodies[0]!.textContent).toContain('• 整理 dsh-dot 界面（dsh-plugins）')
    expect(openBodies[0]!.textContent).not.toContain('25bcb077')

    await act(async () => { childRows[2]!.click() })
    expect(group.querySelectorAll('.dsh-dot-tool-body')).toHaveLength(2)
    expect(group.textContent).toContain('已处理 ap-23（#f92236）')

    await act(async () => { root.unmount() })
  })

  it('keeps the panel mounted when one tool call becomes two', async function () {
    const tool = function (key, at, status) {
      return { kind: 'tool', key: key, name: 'list_sessions', status: status, args: {}, at: at } as ChatItem
    }
    const first: ChatSnapshot = {
      sessionId: 'dot-1', running: true, streaming: '', rev: 1, itemsRev: 1,
      items: [tool('t1', 1, 'running')],
    }
    const second: ChatSnapshot = {
      sessionId: 'dot-1', running: true, streaming: '', rev: 2, itemsRev: 2,
      items: [tool('t1', 1, 'done'), tool('t2', 2, 'running')],
    }
    let pending = function (_value) {}
    let armed = false
    const api = makeApi(first)
    api.wait = function (_rev, _itemsRev, signal) {
      return new Promise(function (resolve) {
        signal.addEventListener('abort', function () { resolve(undefined) }, { once: true })
        if (armed === false) { armed = true; pending = resolve }
      })
    }
    const root = createRoot(document.getElementById('root') as HTMLElement)
    await act(async function () { root.render(<ChatPanel locale='en' api={api} onOpenSession={function () {}} />) })
    await act(async function () { await Promise.resolve(); await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-chat')).not.toBeNull()
    expect(document.body.textContent).toContain('List sessions')
    expect(document.body.textContent).not.toContain('2 actions')
    await act(async function () { pending(second); await Promise.resolve(); await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-chat')).not.toBeNull()
    expect(document.body.textContent).toContain('List sessions ' + String.fromCharCode(183) + ' 2 actions')
    await act(async function () { root.unmount() })
  })

  it('opens the settings drawer with proposal count badge, header status, tab switching, and close button', async () => {
    const snapshot: ChatSnapshot = { sessionId: 'dot-1', running: false, streaming: '', rev: 1, itemsRev: 1, items: [] }
    const base = makeApi(snapshot)
    const api: ChatApi = {
      ...base,
      settingProposals: async () => [{ id: 'p-1', field: 'scope', before: 'all', after: 'tracked', reason: 'test', createdAt: 1 }],
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<ChatPanel locale="zh" api={api} onOpenSession={() => {}} />) })
    await act(async () => { await Promise.resolve() })

    const gear = document.querySelector<HTMLButtonElement>('button[aria-label="设置"]')!
    await act(async () => { gear.click() })
    await act(async () => { await Promise.resolve() })

    // The gear opens the settings drawer over a mask; tasks live in their own drawer.
    const drawer = document.querySelector('aside.dsh-dot-drawer')!
    expect(drawer.getAttribute('data-kind')).toBe('settings')
    expect(document.querySelector('.dsh-dot-drawer-backdrop')).not.toBeNull()
    expect(gear.querySelector('.dsh-dot-gear-dot')).not.toBeNull()
    const region = () => document.querySelector('aside.dsh-dot-drawer [role="region"]')!.getAttribute('aria-label')
    const navButtons = [...drawer.querySelectorAll<HTMLButtonElement>('.dsh-dot-drawer-tabs button')]
    expect(navButtons.map(node => node.querySelector('.dsh-dot-nav-label')?.textContent)).toEqual(['设置', '人设', '上下文', '轨迹'])
    expect(navButtons[0]!.querySelector('.dsh-dot-nav-badge')?.textContent).toBe('1')
    expect(region()).toBe('设置')

    // Trigger a save and confirm the non-jumping header status appears.
    const trackedTab = [...drawer.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent === '所有会话')!
    await act(async () => { trackedTab.click() })
    await act(async () => { await Promise.resolve() })
    expect(drawer.querySelector('.dsh-dot-settings-status')?.textContent).toContain('已保存')

    await act(async () => { navButtons[1]!.click() })
    expect(region()).toBe('人设与约定')
    expect(drawer.querySelector('.dsh-dot-settings-status')).toBeNull()
    await act(async () => { navButtons[2]!.click() })
    expect(region()).toBe('上下文用量')
    await act(async () => { navButtons[3]!.click() })
    expect(region()).toBe('运行轨迹')

    const widen = drawer.querySelector<HTMLButtonElement>('button[aria-label="加宽抽屉"]')!
    await act(async () => { widen.click() })
    expect(drawer.hasAttribute('data-wide')).toBe(true)

    // The gear closes its own drawer; the tasks button opens the other one, with no settings tabs.
    await act(async () => { gear.click() })
    expect(document.querySelector('aside.dsh-dot-drawer')).toBeNull()
    const tasks = [...document.querySelectorAll<HTMLButtonElement>('.dsh-dot-head button')].find(node => node.textContent?.startsWith('任务'))!
    await act(async () => { tasks.click() })
    const tasksDrawer = document.querySelector('aside.dsh-dot-drawer')!
    expect(tasksDrawer.getAttribute('data-kind')).toBe('tasks')
    expect(tasksDrawer.querySelector('.dsh-dot-drawer-tabs')).toBeNull()
    expect(tasksDrawer.querySelector('.dsh-dot-drawer-title')?.textContent).toContain('任务')
    expect(tasksDrawer.querySelector('.dsh-dot-filters')).not.toBeNull()

    // The mask closes it, and so does Escape.
    await act(async () => { document.querySelector<HTMLButtonElement>('.dsh-dot-drawer-backdrop')!.click() })
    expect(document.querySelector('aside.dsh-dot-drawer')).toBeNull()
    await act(async () => { gear.click() })
    await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('aside.dsh-dot-drawer')).toBeNull()
    await act(async () => { root.unmount() })
  })
})

describe('ChatPanel bottom pin', () => {
  it('follows the bottom, lets a slight upward scroll go, and re-pins at the bottom', async () => {
    const snap = (rev: number, streaming: string): ChatSnapshot => ({
      sessionId: 'dot-1', running: true, streaming, rev, itemsRev: rev, items: [{ kind: 'user', key: 'u', text: 'hi', at: 1 }],
    })
    let push: (snapshot: ChatSnapshot) => void = () => {}
    const api = makeApi(snap(1, ''))
    api.wait = (_rev, _itemsRev, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(undefined), { once: true })
      push = resolve
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<ChatPanel locale="en" api={api} onOpenSession={() => {}} />) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const el = document.querySelector<HTMLElement>('.dsh-dot-scroll')!
    let top = 0
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 })
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: value => { top = value } })
    const scrollTo = async (value: number) => {
      top = value
      await act(async () => { el.dispatchEvent(new dom.window.Event('scroll')) })
    }
    const stream = async (rev: number) => {
      await act(async () => { push(snap(rev, 'streamed '.repeat(rev))); await Promise.resolve(); await Promise.resolve() })
    }

    // At the bottom: a streaming update keeps following.
    await scrollTo(600)
    await stream(2)
    expect(top).toBe(1000)

    // Slight upward scroll (30px, inside STICK_PX): the update must not pull it back.
    await scrollTo(570)
    await stream(3)
    expect(top).toBe(570)

    // Back at the bottom: following resumes.
    await scrollTo(600)
    await stream(4)
    expect(top).toBe(1000)
    await act(async () => { root.unmount() })
  })
})

describe('Composer images', () => {
  const proto = dom.window.HTMLElement.prototype as HTMLElement & { attachEvent?: () => void; detachEvent?: () => void }
  proto.attachEvent = () => {}
  proto.detachEvent = () => {}
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  async function pick(file: File) {
    const input = document.querySelector<HTMLInputElement>('input.dsh-dot-file')!
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }

  it('keeps a picture and says the message is too large when the host answers 413', async () => {
    const snapshot: ChatSnapshot = { sessionId: 'dot-1', running: false, streaming: '', rev: 1, itemsRev: 1, items: [] }
    const api = makeApi(snapshot)
    api.say = async () => { throw new Error('transport failure for /dsh-dot/say: HTTP 413') }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<ChatPanel locale="en" api={api} onOpenSession={() => {}} />) })
    await pick(new File([Uint8Array.from(Buffer.from(PNG_B64, 'base64'))], 'dot.png', { type: 'image/png' }))
    expect(document.body.textContent).toContain('dot.png')
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Send')!.click() })
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('Not sent: That message is too large')
    expect(document.body.textContent).toContain('8 MB')
    expect(document.body.textContent).not.toContain('HTTP 413')
    expect(document.body.textContent).toContain('dot.png')
    await act(async () => root.unmount())
  })

  it('says what is wrong with a file that is not an image', async () => {
    const snapshot: ChatSnapshot = { sessionId: 'dot-1', running: false, streaming: '', rev: 1, itemsRev: 1, items: [] }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<ChatPanel locale="en" api={makeApi(snapshot)} onOpenSession={() => {}} />) })
    await pick(new File([Uint8Array.from([1, 2, 3, 4])], 'note.txt', { type: 'text/plain' }))
    expect(document.body.textContent).toContain('Only PNG, JPEG, WebP and GIF')
    expect(document.body.textContent).not.toContain('note.txt')
    await act(async () => root.unmount())
  })
})
