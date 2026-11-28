import { describe, expect, it } from 'vitest'
import { chatItems, type RawEvent } from './chat.ts'
import { formatToolDetail, summarizeToolCall } from './chat-format.ts'

const ev = (seq: number, type: string, data: unknown): RawEvent => ({ seq, type, time: 1000 + seq, data })

describe('chatItems', () => {
  it('turns a session log into chat rows', () => {
    const items = chatItems([
      ev(0, 'system/message', {}),
      ev(1, 'turn/start', { turn: 1 }),
      ev(2, 'user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
      ev(3, 'assistant/message', { message: { content: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'On it.' }] } }),
      ev(4, 'tool/call', { callId: 'c1', name: 'dot_task', arguments: '{}' }),
      ev(5, 'tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'Started task s1' }] } }),
      ev(6, 'user/message', { content: [{ type: 'text', text: '[dot notice] Updates' }], source: { kind: 'agent-message', form: 'relay' } }),
      ev(7, 'turn/end', { reason: { kind: 'error', error: { message: 'rate limited' } } }),
    ])
    expect(items.map(item => item.kind)).toEqual(['user', 'bot', 'tool', 'notice', 'error'])
    expect(items[1]).toMatchObject({ text: 'On it.' })
    expect(items[2]).toMatchObject({ name: 'dot_task', status: 'done', detail: 'Started task s1' })
    expect(items[4]).toMatchObject({ text: 'rate limited' })
  })

  it('splits notices carried by a human message into separate chat rows', () => {
    const notice = '[dot notice] Updates from other sessions:\n- turn-end · watched: done'
    const items = chatItems([
      ev(1, 'user/message', {
        content: [{ type: 'text', text: `${notice}\n\nplease check it` }],
        source: { kind: 'user', dshDot: { carriedChars: notice.length } },
      }),
    ])
    expect(items.map(item => item.kind)).toEqual(['notice', 'user'])
    expect(items[0]).toMatchObject({ key: '1:notice', text: notice })
    expect(items[1]).toMatchObject({ key: '1', text: 'please check it' })
  })

  it('keeps an image-only human message and names the attachment', () => {
    const items = chatItems([
      ev(1, 'user/message', {
        content: [{ type: 'image', attachment: { mediaType: 'image/png', name: 'dot.png' } }],
        source: { kind: 'user' },
      }),
    ])
    expect(items).toMatchObject([{ kind: 'user', text: '', images: [{ mediaType: 'image/png', name: 'dot.png' }] }])
  })

  it('keeps a file-only human message and names the file attachment', () => {
    const items = chatItems([
      ev(1, 'user/message', {
        content: [{ type: 'file', attachment: { name: 'notes.md', bytes: 123 } }],
        source: { kind: 'user' },
      }),
    ])
    expect(items).toMatchObject([{ kind: 'user', text: '', files: [{ name: 'notes.md', bytes: 123 }] }])
  })

  it('splits an agreement note carried by a human message into a separate chat row', () => {
    const note = '[dot agreement notes]\nYour background reflection pass noticed something.'
    const items = chatItems([
      ev(1, 'user/message', {
        content: [{ type: 'text', text: `${note}\n\nhello there` }],
        source: { kind: 'user', dshDot: { carriedChars: note.length } },
      }),
    ])
    expect(items.map(item => item.kind)).toEqual(['notice', 'user'])
    expect(items[0]).toMatchObject({ text: note })
    expect(items[1]).toMatchObject({ text: 'hello there' })
  })

  it('keeps show_view cards with their presentation and the answers given to them', () => {
    const items = chatItems([
      ev(1, 'tool/call', { callId: 'v1', name: 'show_view', arguments: JSON.stringify({ title: 'Pick', view: { type: 'confirm', id: 'ok' } }) }),
      ev(2, 'tool/result', { message: { toolCallId: 'v1', content: [] }, meta: { owner: 'dsh-deep-view', viewId: 'view-1', title: 'Pick', view: { type: 'confirm', id: 'ok' }, interactive: true, awaitReply: true } }),
      ev(3, 'user/message', { content: [{ type: 'text', text: 'Confirmed' }], source: { kind: 'user', deepView: { owner: 'dsh-deep-view', version: 1, answer: { id: 'view-1', action: 'confirm', values: {} } } } }),
    ])
    expect(items[0]).toMatchObject({ kind: 'view', key: 'v1', title: 'Pick', presentation: { viewId: 'view-1' } })
    expect(items[1]).toMatchObject({ kind: 'answer', text: 'Confirmed' })
  })

  it('keeps deferred drafts out of chat while preserving the lookup and final card', () => {
    const draft = ev(1, 'tool/call', { callId: 'draft', name: 'show_view', arguments: '{"view":{"type":"text","text":"稍等"}}' })
    expect(chatItems([draft])).toEqual([])
    const items = chatItems([
      draft,
      ev(2, 'tool/result', { message: { toolCallId: 'draft', isError: false }, meta: { dshDot: { showView: 'deferred' } } }),
      ev(3, 'tool/call', { callId: 'search', name: 'web_search', arguments: '{}' }),
      ev(4, 'tool/result', { message: { toolCallId: 'search', content: 'rules' } }),
      ev(5, 'tool/call', { callId: 'final', name: 'show_view', arguments: '{}' }),
      ev(6, 'tool/result', { message: { toolCallId: 'final' }, meta: { owner: 'dsh-deep-view', view: { type: 'text', text: 'Rules summary' } } }),
    ])
    expect(items.map(item => item.key)).toEqual(['search', 'final'])
    expect(items[1]).toHaveProperty('presentation')
  })

  it('marks failed tools and a card whose result carried no presentation', () => {
    const items = chatItems([
      ev(1, 'tool/call', { callId: 'a', name: 'dot_read', arguments: JSON.stringify({ session_id: 's1' }) }),
      ev(2, 'tool/result', { message: { toolCallId: 'a', isError: true, content: 'boom' } }),
      ev(3, 'tool/call', { callId: 'b', name: 'show_view', arguments: 'not json' }),
      ev(4, 'tool/result', { message: { toolCallId: 'b', isError: true, content: [] } }),
      ev(5, 'tool/call', { callId: 'c', name: 'dot_answer', arguments: JSON.stringify({ id: 'ap-22', allow: true }) }),
      ev(6, 'tool/result', { message: { toolCallId: 'c', content: 'Error [dot/unknown-request]: no waiting request ap-22; it may have been answered in its own session' } }),
      ev(7, 'tool/call', { callId: 'd', name: 'dot_answer', arguments: JSON.stringify({ id: '' }) }),
      ev(8, 'tool/result', { message: { toolCallId: 'd', content: 'Error [dot/invalid]: give allow for an approval or answers for a question' } }),
      ev(9, 'tool/call', { callId: 'e', name: 'list_sessions', arguments: JSON.stringify({ limit: 50 }) }),
      ev(10, 'tool/result', { message: { toolCallId: 'e', content: '{"status":"failed","code":"SESSION_QUERY_INVALID_LIMIT","message":"limit must be an integer from 1 to 20; omit it or pass null for the default"}' } }),
      ev(11, 'tool/call', { callId: 'f', name: 'list_sessions', arguments: JSON.stringify({ limit: 5 }) }),
      ev(12, 'tool/result', { message: { toolCallId: 'f', content: '{"status":"ok","items":[]}' } }),
    ])
    expect(items[0]).toMatchObject({ status: 'error', args: { session_id: 's1' }, detail: 'boom' })
    expect(items[1]).toMatchObject({ kind: 'view', failed: true })
    expect(items[2]).toMatchObject({ status: 'done', args: { id: 'ap-22', allow: true } })
    expect(items[3]).toMatchObject({ status: 'error' })
    expect(items[4]).toMatchObject({ name: 'list_sessions', status: 'error' })
    expect(items[5]).toMatchObject({ name: 'list_sessions', status: 'done' })
  })
  it.each(['{"status":"failed"}', '{"status":"error"}', '{"ok":false}'])('keeps legacy failure interpretation for unmarked isError:false rows: %s', content => {
    const events = [
      ev(1, 'tool/call', { callId: 'legacy', name: 'dot_task', arguments: '{}' }),
      ev(2, 'tool/result', { message: { toolCallId: 'legacy', isError: false, content } }),
    ]
    expect(chatItems(events)[0]).toMatchObject({ status: 'error' })
    expect(chatItems([events[0]!, ev(2, 'tool/result', {
      message: { toolCallId: 'legacy', isError: false, content },
      meta: { dshDot: { display: { kind: 'task', summary: 'Recorded' } } },
    })])[0]).toMatchObject({ status: 'done' })
  })

  it('saves display fields before clipping long result text', () => {
    const title = 'Complete title beyond the detail window'
    const result = JSON.stringify({ status: 'ok', padding: 'x'.repeat(2000), items: [{ sessionId: 's1', title, cwd: '/work/project' }], nextCursor: 'more' })
    const items = chatItems([
      ev(1, 'tool/call', { callId: 'c', name: 'list_sessions', arguments: '{}' }),
      ev(2, 'tool/result', { message: { toolCallId: 'c', isError: false, content: result } }),
    ])
    const item = items[0]!
    expect(item.kind).toBe('tool')
    if (item.kind !== 'tool') return
    expect(item.detail).not.toContain(title)
    expect(item.display?.sessions).toMatchObject({ items: [{ title }], hasMore: true })
    expect(summarizeToolCall(item, 'en', new Map()).summary).toContain('1+')
    expect(formatToolDetail(item, 'en', new Map())?.text).toContain(title)
  })

  it('carries structured notices without parsing their human text', () => {
    const notice = { isReminder: false, entries: [{ kind: 'approval', sessionId: 's', requestId: 'ap-1', subject: 'pwsh', command: 'echo hi' }] }
    const items = chatItems([ev(1, 'user/message', { content: '任意通知文案', source: { kind: 'agent-message', dshDot: { notices: notice } } })])
    expect(items[0]).toMatchObject({ kind: 'notice', notice })
  })

})
