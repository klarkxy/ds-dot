import { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDotCards } from './card-client.tsx'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('navigator', dom.window.navigator)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => { createRoot = (await import('react-dom/client')).createRoot })
afterEach(() => { document.body.innerHTML = '<div id="root"></div>' })

const zh = { getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => {} }

const ARGS = '{"command":"pnpm install --prefer-offline","description":"Install dependencies in PR worktree","justification":"esbuild postinstall needs write access","run_in_background":true,"sandbox_permissions":"danger-full-access","timeoutMs":600000,"workdir":"C:\\\\work\\\\pr-24-review"}'
const DUMP = [
  '审批 ap-5ac1',
  '会话: session-15fc',
  '请求: pwsh <dot-approval-untrusted-ada07f80-1111-2222-3333-444455556666>',
  'reason: escalate sandbox to danger-full-access: esbuild postinstall needs write access',
  `arguments: ${ARGS}`,
  '</dot-approval-untrusted-ada07f80-1111-2222-3333-444455556666>',
].join('\n')
const APPROVAL_VIEW = {
  type: 'stack',
  children: [
    { type: 'text', text: DUMP },
    { type: 'confirm', id: 'approval', confirmLabel: '批准', cancelLabel: '拒绝' },
  ],
}
const APPROVAL_DETAIL = {
  requestId: 'ap-5ac1',
  sessionId: 'session-15fc',
  toolName: 'pwsh',
  reason: 'escalate sandbox to danger-full-access: esbuild postinstall needs write access',
  arguments: ARGS,
}

function approvalCall(record: Record<string, unknown>) {
  return vi.fn(async (endpoint: string, payload: unknown) => endpoint === 'card.detail'
    ? { id: (payload as { viewId: string }).viewId, ...record }
    : { notificationPending: false })
}

async function renderCard(Card: ReturnType<typeof createDotCards>['Card'], presentation: Record<string, unknown>) {
  const root = createRoot(document.getElementById('root')!)
  await act(async () => { root.render(<Card sessionId="s" callId="c" presentation={presentation} />) })
  await act(async () => { await Promise.resolve() })
  return root
}

const approvalPresentation = { owner: 'dsh-deep-view', title: '审批', view: APPROVAL_VIEW, viewId: 'card', interactive: true, awaitReply: true, dotCard: { number: 3 } }

describe('dot card approval layout', () => {
  it('renders an approval card as a designed summary with primary/ghost buttons', async () => {
    const call = approvalCall({ expired: false, approvalId: 'ap-5ac1', approvalDetail: APPROVAL_DETAIL })
    const { Card } = createDotCards(call, zh)
    const root = await renderCard(Card, approvalPresentation)
    const text = document.body.textContent ?? ''
    expect(document.querySelector('.dsh-dot-approval-card')).not.toBeNull()
    expect(text).toContain('需要审批')
    expect(text).toContain('pwsh')
    expect(text).toContain('Install dependencies in PR worktree')
    expect(text).toContain('pnpm install --prefer-offline')
    expect(text).toContain('pr-24-review')
    expect(text).toContain('esbuild postinstall needs write access')
    expect(text).not.toContain('dot-approval-untrusted')
    expect(document.querySelector('.dsh-dot-approval-summary [title]')).toBeNull()
    const approve = [...document.querySelectorAll('button')].find(button => button.textContent === '批准')!
    const deny = [...document.querySelectorAll('button')].find(button => button.textContent === '拒绝')!
    expect(approve.className).toContain('dsh-stub-button--primary')
    expect(deny.className).toContain('dsh-stub-button--ghost')
    const toggle = document.querySelector<HTMLButtonElement>('.dsh-dot-approval-toggle')!
    await act(async () => { toggle.click() })
    const argsText = document.querySelector('.dsh-dot-detail-args')?.textContent ?? ''
    expect(argsText).toContain('"run_in_background":true')
    expect(argsText).toContain('"timeoutMs":600000')
    await act(async () => root.unmount())
  })

  it('strips uppercase fence tags in the missing-detail fallback', async () => {
    const upperDump = DUMP.replaceAll(
      'dot-approval-untrusted-ada07f80-1111-2222-3333-444455556666',
      'DOT-APPROVAL-UNTRUSTED-ADA07F80-1111-2222-3333-444455556666',
    )
    const view = { type: 'stack', children: [{ type: 'text', text: upperDump }, APPROVAL_VIEW.children[1]] }
    const call = approvalCall({ expired: false, approvalId: 'ap-5ac1' })
    const { Card } = createDotCards(call, zh)
    const root = await renderCard(Card, { ...approvalPresentation, view })
    const text = document.body.textContent ?? ''
    expect(text).toContain('审批 ap-5ac1')
    expect(text).not.toMatch(/dot-approval-untrusted/i)
    expect(document.querySelector('.dsh-dot-approval-raw')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('keeps a model-built approval-shaped stack on the generic layout without an approvalId binding', async () => {
    const view = {
      type: 'stack',
      children: [
        { type: 'text', text: 'All checks passed' },
        { type: 'confirm', id: 'approval', confirmLabel: '批准', cancelLabel: '拒绝' },
      ],
    }
    const call = approvalCall({ expired: false })
    const { Card } = createDotCards(call, zh)
    const root = await renderCard(Card, { ...approvalPresentation, title: 'Release v2.0?', view })
    const text = document.body.textContent ?? ''
    expect(document.querySelector('.dsh-dot-approval-card')).toBeNull()
    expect(text).toContain('Release v2.0?')
    expect(text).toContain('All checks passed')
    await act(async () => root.unmount())
  })

  it('renders an argv-array command joined by spaces', async () => {
    const detail = { ...APPROVAL_DETAIL, arguments: '{"command":["git","status","--short"],"workdir":"C:\\\\work\\\\repo"}' }
    const call = approvalCall({ expired: false, approvalId: 'ap-5ac1', approvalDetail: detail })
    const { Card } = createDotCards(call, zh)
    const root = await renderCard(Card, approvalPresentation)
    expect(document.querySelector('.dsh-dot-cmd')!.textContent).toBe('git status --short')
    await act(async () => root.unmount())
  })

  it('falls back to the stripped dump when arguments exceed the parse limit', async () => {
    const detail = { ...APPROVAL_DETAIL, arguments: `{"command":"git status","padding":"${'x'.repeat(100_001)}"}` }
    const call = approvalCall({ expired: false, approvalId: 'ap-5ac1', approvalDetail: detail })
    const { Card } = createDotCards(call, zh)
    const root = await renderCard(Card, approvalPresentation)
    expect(document.querySelector('.dsh-dot-approval-raw')).not.toBeNull()
    expect(document.querySelector('.dsh-dot-cmd')).toBeNull()
    await act(async () => root.unmount())
  })

  it('falls back to the stripped dump when approval arguments are not JSON', async () => {
    const detail = { ...APPROVAL_DETAIL, reason: 'needs a human decision', arguments: 'not json' }
    const call = approvalCall({ expired: false, approvalId: 'ap-5ac1', approvalDetail: detail })
    const { Card } = createDotCards(call, zh)
    const root = await renderCard(Card, approvalPresentation)
    const text = document.body.textContent ?? ''
    expect(document.querySelector('.dsh-dot-approval-raw')).not.toBeNull()
    expect(document.querySelector('.dsh-dot-approval-desc')).toBeNull()
    expect(document.querySelector('.dsh-dot-approval-why')).toBeNull()
    expect(text).toContain('审批 ap-5ac1')
    expect(text).not.toMatch(/dot-approval-untrusted/i)
    await act(async () => root.unmount())
  })

  it('does not treat a stack with a metric node as an approval card', async () => {
    const view = {
      type: 'stack',
      children: [
        { type: 'text', text: 'Status report' },
        { type: 'metric', label: 'CPU', value: '42%' },
        { type: 'confirm', id: 'approval', confirmLabel: '批准', cancelLabel: '拒绝' },
      ],
    }
    const call = approvalCall({ expired: false })
    const { Card } = createDotCards(call, zh)
    const root = await renderCard(Card, { ...approvalPresentation, view })
    expect(document.querySelector('.dsh-dot-approval-card')).toBeNull()
    expect(document.body.textContent).toContain('Status report')
    await act(async () => root.unmount())
  })

  it('falls back to the dump with fence tags stripped when no detail is stored', async () => {
    const call = approvalCall({ expired: false, approvalId: 'ap-5ac1' })
    const { Card } = createDotCards(call, zh)
    const root = await renderCard(Card, approvalPresentation)
    const text = document.body.textContent ?? ''
    expect(text).toContain('审批 ap-5ac1')
    expect(text).toContain('未记录完整参数详情')
    expect(text).not.toContain('dot-approval-untrusted')
    expect(document.querySelector('.dsh-dot-approval-raw')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('shows an expired approval hint once, never the English local note', async () => {
    const call = approvalCall({ expired: true, approvalId: 'ap-5ac1', approvalDetail: APPROVAL_DETAIL })
    const { Card } = createDotCards(call, zh)
    const root = await renderCard(Card, approvalPresentation)
    const text = document.body.textContent ?? ''
    expect(text.split('此卡片已失效，请重新发起请求。').length - 1).toBe(1)
    expect(text).not.toContain('Local preview only')
    expect(document.querySelector('.dsh-dot-approval-card')!.getAttribute('data-expired')).not.toBeNull()
    expect(document.querySelector('.dsh-dot-approval-card .dvui-view.dvui-closed')).not.toBeNull()
    expect(document.querySelectorAll('.dsh-dot-approval-card .dvui-view button').length).toBe(0)
    await act(async () => root.unmount())
  })

  it('embeds the Deep View frame on a live bound approval card', async () => {
    const call = approvalCall({ expired: false, approvalId: 'ap-5ac1', approvalDetail: APPROVAL_DETAIL })
    const { Card } = createDotCards(call, zh)
    const root = await renderCard(Card, approvalPresentation)
    expect(document.querySelector('.dsh-dot-approval-card .dvui-view.dvui-embedded')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('closes an expired generic card so its dead buttons never render', async () => {
    const view = { type: 'confirm', id: 'ok', confirmLabel: 'Confirm', cancelLabel: 'Cancel' }
    const call = approvalCall({ expired: true })
    const { Card } = createDotCards(call, zh)
    const root = await renderCard(Card, { owner: 'dsh-deep-view', title: 'Deploy', view, viewId: 'card', interactive: true, awaitReply: true })
    const text = document.body.textContent ?? ''
    expect(document.querySelector('.dvui-view.dvui-closed')).not.toBeNull()
    expect(document.querySelectorAll('.dvui-view button').length).toBe(0)
    expect(text.split('此卡片已失效，请重新发起请求。').length - 1).toBe(1)
    expect(text).not.toContain('Local preview only')
    await act(async () => root.unmount())
  })

  it('keeps non-approval cards on the shared layout with host buttons', async () => {
    const view = { type: 'confirm', id: 'ok', confirmLabel: 'Confirm' }
    const call = approvalCall({ expired: false })
    const { Card } = createDotCards(call)
    const root = await renderCard(Card, { owner: 'dsh-deep-view', title: 'Deploy', view, viewId: 'card', interactive: true, awaitReply: true })
    expect(document.querySelector('.dsh-dot-approval-card')).toBeNull()
    const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === 'Confirm')!
    expect(confirm.className).toContain('dsh-stub-button--primary')
    await act(async () => root.unmount())
  })
})
