import { describe, expect, it } from 'vitest'
import type { ChatItem } from './contracts.ts'
import { filterVisibleChat } from './chat-filter.ts'

const APPROVAL_NOTICE = (id: string, cmd = 'gh run view --log') => [
  '[dot notice] Updates from other sessions:',
  `- approval · session-f922364c-9f84-4ca4-af18-38f650070997: ${id} · approval from untracked session in H:\\Code\\dsh-plugins · "pwsh"`,
  `  detail: arguments: {"command":"${cmd}"}`,
  '  human-required: remote-exec; do not use dot_answer.',
].join('\n')

describe('filterVisibleChat', () => {
  it('keeps a failed card on an idle check and still drops one on a reminder', () => {
    const failed: ChatItem = { kind: 'view', key: 'bad', failed: true, at: 2, turn: 1, trigger: 'background' }
    const bot: ChatItem = { kind: 'bot', key: 'b', text: 'The operation failed. Please confirm how to proceed.', at: 3, turn: 1, trigger: 'background' }
    const reminder: ChatItem = { kind: 'notice', key: 'n', text: '[dot reminder] check', at: 1, turn: 1, trigger: 'background' }
    expect(filterVisibleChat([reminder, failed, bot]).items.map(item => item.key)).toEqual(['n', 'b'])
    const idle: ChatItem = { kind: 'notice', key: 'n', text: '[dot notice] Updates:\nTasks:\n- idle-check · dot: Routine check', at: 1, turn: 1, trigger: 'background' }
    expect(filterVisibleChat([idle, failed, bot]).items.map(item => item.key)).toEqual(['n', 'bad', 'b'])
  })
  it('hides an idle check with no action while preserving task changes', () => {
    const notice: ChatItem = { kind: 'notice', key: 'n', text: '[dot notice] Updates:\nTasks:\n- idle-check · dot: Routine check: t-1 ready', at: 1, turn: 1 }
    const read: ChatItem = { kind: 'tool', key: 'r', name: 'dot_task', args: { action: 'list' }, status: 'done', at: 2, turn: 1 }
    expect(filterVisibleChat([notice, read]).items).toEqual([])
    const move: ChatItem = { ...read, key: 'm', args: { action: 'move' } }
    expect(filterVisibleChat([notice, move]).items.map(row => row.key)).toEqual(['n', 'm'])
  })
  it('hides any ending text on a pure idle query, and keeps a question card', () => {
    const notice: ChatItem = { kind: 'notice', key: 'n', text: '[dot notice] Updates:\nTasks:\n- idle-check · dot: Routine check: t-1 ready', at: 1, turn: 1 }
    const note: ChatItem = { kind: 'bot', key: 'b', text: '本次为后台例行检查，无新情况，未打扰用户。', at: 2, turn: 1 }
    const read: ChatItem = { kind: 'tool', key: 'r', name: 'dot_task', args: { action: 'list' }, status: 'done', at: 3, turn: 1 }
    expect(filterVisibleChat([notice, read, note]).items).toEqual([])
    const card: ChatItem = { kind: 'view', key: 'v', presentation: { viewId: 'ask' }, at: 4, turn: 1 }
    // A card beside text no longer swallows the text; the whole block stays visible.
    expect(filterVisibleChat([notice, card, note]).items.map(item => item.key)).toEqual(['n', 'v', 'b'])
  })
  it('does not hide an idle check mixed with a person or another notice', () => {
    const idle: ChatItem = { kind: 'notice', key: 'n', text: '[dot notice] Updates:\nTasks:\n- idle-check · dot: Routine check: t-1 ready', at: 1, turn: 1 }
    const note: ChatItem = { kind: 'bot', key: 'b', text: '本次为后台例行检查，无新情况，未打扰用户。', at: 2, turn: 1 }
    const human: ChatItem = { kind: 'user', key: 'u', text: 'look again', at: 3, turn: 1, trigger: 'human' }
    expect(filterVisibleChat([idle, human, note]).items.map(item => item.key)).toEqual(['n', 'u', 'b'])
    const mixed: ChatItem = { kind: 'notice', key: 'm', text: '[dot notice] Updates:\nTasks:\n- idle-check · dot: Routine check\n- turn-end · s1: task t-1 finished', at: 1, turn: 2 }
    expect(filterVisibleChat([mixed, { ...note, turn: 2 }]).items.map(item => item.key)).toEqual(['m', 'b'])
  })
  it('keeps reminder changes and task writes on an idle check', () => {
    const notice: ChatItem = { kind: 'notice', key: 'n', text: '[dot notice] Updates:\nTasks:\n- idle-check · dot: Routine check: t-1 ready', at: 1, turn: 1 }
    const note: ChatItem = { kind: 'bot', key: 'b', text: '本次为后台例行检查，无新情况，未打扰用户。', at: 4, turn: 1 }
    const added: ChatItem = { kind: 'tool', key: 'a', name: 'dot_schedule', args: { action: 'add' }, status: 'done', at: 2, turn: 1 }
    const removed: ChatItem = { kind: 'tool', key: 'd', name: 'dot_schedule', args: { action: 'remove' }, status: 'done', at: 2, turn: 1 }
    const unknown: ChatItem = { kind: 'tool', key: 'u', name: 'dot_schedule', args: { action: 'rename' }, status: 'done', at: 2, turn: 1 }
    const listed: ChatItem = { kind: 'tool', key: 'l', name: 'dot_schedule', args: { action: 'list' }, status: 'done', at: 2, turn: 1 }
    const created: ChatItem = { kind: 'tool', key: 'c', name: 'dot_workspace', args: { action: 'create' }, status: 'done', at: 2, turn: 1 }
    const inspected: ChatItem = { kind: 'tool', key: 'i', name: 'dot_workspace', args: { action: 'inspect' }, status: 'done', at: 2, turn: 1 }
    const files: ChatItem = { kind: 'tool', key: 'f', name: 'dot_workspace', args: { action: 'files' }, status: 'done', at: 2, turn: 1 }
    const moved: ChatItem = { kind: 'tool', key: 'm', name: 'dot_task', args: { action: 'move' }, status: 'done', at: 2, turn: 1 }
    const noted: ChatItem = { kind: 'tool', key: 't', name: 'dot_task', args: { action: 'note' }, status: 'done', at: 2, turn: 1 }
    expect(filterVisibleChat([notice, added, note]).items.map(item => item.key)).toEqual(['n', 'a', 'b'])
    expect(filterVisibleChat([notice, removed, note]).items.map(item => item.key)).toEqual(['n', 'd', 'b'])
    expect(filterVisibleChat([notice, unknown, note]).items.map(item => item.key)).toEqual(['n', 'u', 'b'])
    expect(filterVisibleChat([notice, listed, note]).items).toEqual([])
    expect(filterVisibleChat([notice, created, note]).items.map(item => item.key)).toEqual(['n', 'c', 'b'])
    expect(filterVisibleChat([notice, inspected, note]).items).toEqual([])
    expect(filterVisibleChat([notice, files, note]).items).toEqual([])
    expect(filterVisibleChat([notice, moved, note]).items.map(item => item.key)).toEqual(['n', 'm', 'b'])
    expect(filterVisibleChat([notice, noted, note]).items.map(item => item.key)).toEqual(['n', 't', 'b'])
  })
  it('keeps a failed routine-check query with no reply and with only a waiting reply', () => {
    const notice: ChatItem = { kind: 'notice', key: 'n', text: '[dot notice] Updates:\nTasks:\n- idle-check · dot: Routine check: t-1 ready', at: 1, turn: 1 }
    const failed: ChatItem = { kind: 'tool', key: 'e', name: 'dot_overview', status: 'error', detail: 'listSessions failed', at: 2, turn: 1 }
    const quiet = filterVisibleChat([notice, failed])
    expect(quiet.items.map(item => item.key)).toEqual(['n', 'e'])
    expect(quiet.items[1]).toMatchObject({ status: 'error', detail: 'listSessions failed' })
    const waiting: ChatItem = { kind: 'bot', key: 'b', text: '暂无新结论，静默等待。', at: 3, turn: 1 }
    const noisy = filterVisibleChat([notice, failed, waiting])
    expect(noisy.items.map(item => item.key)).toEqual(['n', 'e', 'b'])
    expect(noisy.items.find(item => item.kind === 'tool')).toMatchObject({ status: 'error', detail: 'listSessions failed' })
  })
  it('keeps an idle-check refusal, grant and submitted answer visible', () => {
    const notice: ChatItem = { kind: 'notice', key: 'n', text: '[dot notice] Updates:\nTasks:\n- idle-check · dot: Routine check: t-1 ready', at: 1, turn: 1 }
    const note = (text: string): ChatItem => ({ kind: 'bot', key: 'b', text, at: 3, turn: 1 })
    const answer = (args: Record<string, unknown>): ChatItem => ({
      kind: 'tool', key: 'a', name: 'dot_answer', status: 'done', args, detail: 'Answered ap-1 for session-1.', at: 2, turn: 1,
    })
    expect(filterVisibleChat([notice, answer({ id: 'ap-1', allow: false }), note('已拒绝该操作。')]).items.map(item => item.key)).toEqual(['n', 'a', 'b'])
    expect(filterVisibleChat([notice, answer({ id: 'ap-1', allow: true }), note('已批准该操作。')]).items.map(item => item.key)).toEqual(['n', 'a', 'b'])
    expect(filterVisibleChat([notice, answer({ id: 'q-1', answers: [{ id: 'q', selected: ['a'] }] }), note('已提交答案。')]).items.map(item => item.key)).toEqual(['n', 'a', 'b'])
  })
  it('keeps text beside a card within the same turn and drops only failed cards', () => {
    const items: ChatItem[] = [
      { kind: 'user', key: 'u1', text: 'hello', at: 1, turn: 1, trigger: 'human' },
      { kind: 'bot', key: 'b1', text: 'preface', at: 2, turn: 1, trigger: 'human' },
      { kind: 'view', key: 'v1', presentation: { viewId: 'card' }, at: 3, turn: 1, trigger: 'human' },
      { kind: 'bot', key: 'b2', text: 'duplicate', at: 4, turn: 1, trigger: 'human' },
      { kind: 'notice', key: 'n2', text: '[dot reminder] check', at: 5, turn: 2, trigger: 'background' },
      { kind: 'bot', key: 'b3', text: 'background chatter', at: 6, turn: 2, trigger: 'background' },
      { kind: 'user', key: 'u3', text: 'again', at: 7, turn: 3, trigger: 'human' },
      { kind: 'view', key: 'bad', failed: true, at: 8, turn: 3, trigger: 'human' },
      { kind: 'bot', key: 'fallback', text: 'plain reply', at: 9, turn: 3, trigger: 'human' },
    ]
    expect(filterVisibleChat(items).items.map(item => item.key)).toEqual(['u1', 'b1', 'v1', 'b2', 'n2', 'b3', 'u3', 'fallback'])
  })
  it('hides requests already answered in their own session and routine silent settlements', () => {
    const items: ChatItem[] = [
      {
        kind: 'tool',
        key: 't1',
        name: 'dot_answer',
        status: 'done',
        args: { id: 'ap-22', allow: true },
        detail: 'Error [dot/unknown-request]: no waiting request ap-22; it may have been answered in its own session',
        at: 1,
      },
      { kind: 'bot', key: 'b1', text: '`ap-22` 已在原会话处理。', at: 2 },
      { kind: 'notice', key: 'n1', text: APPROVAL_NOTICE('ap-23'), at: 3 },
      {
        kind: 'tool',
        key: 't2',
        name: 'dot_answer',
        status: 'done',
        args: { id: 'ap-23', allow: true },
        detail: 'Error [dot/unknown-request]: no waiting request ap-23; it may have been answered in its own session',
        at: 4,
      },
      { kind: 'bot', key: 'b2', text: '`ap-23` 已在原会话处理。', at: 5 },
      { kind: 'notice', key: 'n2', text: APPROVAL_NOTICE('ap-24'), at: 6 },
      { kind: 'tool', key: 't3', name: 'dot_read', status: 'done', args: { session_id: 'session-f922364c-9f84-4ca4-af18-38f650070997' }, detail: 'untracked session\n--- latest reply ---\n(no reply yet)', at: 7 },
      { kind: 'tool', key: 't4', name: 'dot_answer', status: 'done', args: { id: 'ap-24', allow: true }, detail: 'Answered ap-24 for session-f922364c-9f84-4ca4-af18-38f650070997.', at: 8 },
    ]
    const res = filterVisibleChat(items)
    expect(res.items).toEqual([])
    expect(res.silentTail).toBe(true)
  })

  it('keeps silentTail while an active background request turn has not spoken, and reveals it once streaming or asking', () => {
    const inFlight: ChatItem[] = [
      { kind: 'notice', key: 'n1', text: APPROVAL_NOTICE('ap-25', 'git push origin main'), at: 1 },
      { kind: 'tool', key: 't1', name: 'dot_read', status: 'running', args: { session_id: 'session-f922364c-9f84-4ca4-af18-38f650070997' }, at: 2 },
    ]
    expect(filterVisibleChat(inFlight, { streaming: false })).toMatchObject({ items: [], silentTail: true })
    expect(filterVisibleChat(inFlight, { streaming: true }).items.map(item => item.key)).toEqual(['n1', 't1'])
    expect(filterVisibleChat(inFlight, { streaming: true }).silentTail).toBe(true)

    const withCard: ChatItem[] = [
      ...inFlight,
      { kind: 'bot', key: 'b1', text: '这条命令会推送代码到远端，请确认是否放行：', at: 3 },
      { kind: 'view', key: 'v1', title: '确认推送', view: { type: 'confirm', id: 'ok' }, presentation: { viewId: 'view-1' }, at: 4 },
    ]
    expect(filterVisibleChat(withCard).items.map(item => item.key)).toEqual(['n1', 't1', 'b1', 'v1'])
  })

  it('preserves rejections explained to the human and strips silent requests from mixed task-update notices', () => {
    const rejected: ChatItem[] = [
      { kind: 'notice', key: 'n1', text: APPROVAL_NOTICE('ap-26', 'rm -rf /tmp/shared'), at: 1 },
      { kind: 'tool', key: 't1', name: 'dot_answer', status: 'done', args: { id: 'ap-26', allow: false }, detail: 'Answered ap-26 for session-f922364c-9f84-4ca4-af18-38f650070997.', at: 2 },
      { kind: 'bot', key: 'b1', text: '已拦截该会话删除目录外的命令。', at: 3 },
    ]
    expect(filterVisibleChat(rejected).items.map(item => item.key)).toEqual(['n1', 't1', 'b1'])

    const mixedNotice = [
      '[dot notice] Updates from other sessions:',
      '- turn-end · session-task-1: "修复链接" finished a turn: 修好了 3 处失效链接',
      '- approval · session-f922364c-9f84-4ca4-af18-38f650070997: ap-27 · approval from untracked session in H:\\Code\\dsh-plugins · "pwsh"',
    ].join('\n')
    const mixed: ChatItem[] = [
      { kind: 'notice', key: 'nm', text: mixedNotice, at: 10 },
      { kind: 'tool', key: 'tm', name: 'dot_answer', status: 'done', args: { id: 'ap-27', allow: true }, detail: 'Answered ap-27 for session-f922364c-9f84-4ca4-af18-38f650070997.', at: 11 },
      { kind: 'bot', key: 'bm', text: '「修复链接」跑完了，共修好 3 处失效链接。', at: 12 },
    ]
    const res = filterVisibleChat(mixed)
    expect(res.items.map(item => item.key)).toEqual(['nm', 'bm'])
    expect(res.hiddenRequestIds.has('ap-27')).toBe(true)
  })

  it('keeps a turn that writes the agreements or the cognition visible', () => {
    // A background notice alone is routine and gets silenced; a turn that also
    // writes the agreements or the cognition is a side effect the human sees.
    const writeTurn = (name: string, args: Record<string, unknown>): ChatItem[] => [
      { kind: 'notice', key: 'n1', text: APPROVAL_NOTICE('ap-30'), at: 1 },
      { kind: 'tool', key: 'w1', name, status: 'done', args, detail: 'Recorded as an agreement.', at: 2 },
    ]
    for (const [name, args] of [
      ['dot_agreement', { action: 'add', text: '推送到个人仓库可直接放行' }],
      ['dot_cognition', { text: '他偏好先看结论。' }],
      // Conversations from before the split keep their old note calls.
      ['dot_remember', { text: '- 先给结论' }],
      ['dot_forget', { text: '- 先给结论' }],
    ] as const) {
      const res = filterVisibleChat(writeTurn(name, args))
      expect(res.items.map(item => item.key)).toEqual(['n1', 'w1'])
      expect(res.silentTail).toBe(true)
    }
  })

  it('keeps committed bot replies visible during running turns, also while a card is being prepared', () => {
    const stepItems: ChatItem[] = [
      { kind: 'user', key: 'u1', text: 'check status', at: 1, turn: 1, trigger: 'human' },
      { kind: 'bot', key: 'b1', text: '我先查一下当前会话状态。', at: 2, turn: 1, trigger: 'human' },
      { kind: 'tool', key: 't1', name: 'dot_overview', status: 'running', at: 3, turn: 1, trigger: 'human' },
    ]
    // A card beside text no longer swallows the text; preparingCard only steers
    // the live streaming overlay in the panel, not the committed item list.
    expect(filterVisibleChat(stepItems, { running: true, preparingCard: false }).items.map(i => i.key)).toEqual(['u1', 'b1', 't1'])
    expect(filterVisibleChat(stepItems, { running: true, preparingCard: true }).items.map(i => i.key)).toEqual(['u1', 'b1', 't1'])
  })

  it('shows bot text next to a card in the same reply', () => {
    const items: ChatItem[] = [
      { kind: 'user', key: 'u1', text: 'summary?', at: 1, turn: 1, trigger: 'human' },
      { kind: 'bot', key: 'b1', text: 'Here is the rundown.', at: 2, turn: 1, trigger: 'human' },
      { kind: 'view', key: 'v1', presentation: { viewId: 'view-1' }, at: 3, turn: 1 },
    ]
    expect(filterVisibleChat(items).items.map(i => i.key)).toEqual(['u1', 'b1', 'v1'])
  })
})
