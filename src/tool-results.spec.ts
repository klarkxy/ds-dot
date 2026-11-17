import { describe, expect, it } from 'vitest'
import { chatItems, type RawEvent } from './chat.ts'
import { foldTrajectory } from './trajectory.ts'
import { foldScan, EMPTY_SCAN } from './context.ts'
import { unknownRequestIdOf } from './chat-filter.ts'
import { summarizeToolCall } from './chat-format.ts'

function results(message: Record<string, unknown>, error?: Record<string, unknown>, meta?: Record<string, unknown>) {
  const events: RawEvent[] = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'step/start', data: { step: 1 } },
    { seq: 3, type: 'tool/call', data: { callId: 'c', name: 'dot_answer', arguments: '{"id":"ap-1"}' } },
    { seq: 4, type: 'tool/result', data: { message: { toolCallId: 'c', ...message }, ...error ? { error } : {}, ...meta ? { meta } : {} } },
  ]
  const chat = chatItems(events)[0]!
  const trajectory = foldTrajectory(events).turns[0]!.steps[0]!.records[0]!
  const context = foldScan(EMPTY_SCAN, events, 4).surface?.nodes.find(node => node.category === 'tool')
  return { chat, trajectory, context }
}

describe('native tool result contract', () => {
  it('shows native failures consistently in chat, trajectory and context', () => {
    const { chat, trajectory, context } = results({ isError: true, content: 'Error: invalid input' }, { name: 'DotError', code: 'dot/invalid' })
    expect(chat).toMatchObject({ status: 'error', display: { error: { code: 'dot/invalid', message: 'invalid input' } } })
    expect(trajectory).toMatchObject({ status: 'error' })
    expect(context).toMatchObject({ status: 'error' })
  })

  it.each(['Error [dot/invalid]: quoted example', '{"status":"failed","message":"a value, not an exception"}'])(
    'honors native success without reinterpreting its text: %s', content => {
      const { chat, trajectory, context } = results({ isError: false, content }, undefined, { dshDot: { display: { version: 1 } } })
      expect(chat).toMatchObject({ status: 'done' })
      expect(trajectory).toMatchObject({ status: 'done' })
      expect(context?.status).toBeUndefined()
      if (chat.kind === 'tool') expect(summarizeToolCall(chat, 'en', new Map()).tone).not.toBe('error')
    },
  )

  it('uses native error identity to recognize requests settled elsewhere', () => {
    const { chat } = results({ isError: true, content: 'Error: request settled' }, { name: 'DotError', code: 'dot/unknown-request' })
    if (chat.kind !== 'tool') throw new Error('missing tool row')
    expect(unknownRequestIdOf(chat)).toBe('ap-1')
    expect(summarizeToolCall(chat, 'en', new Map()).tone).toBe('muted')
  })

  it('keeps reading old Dorothy failure strings recorded with isError=false', () => {
    const { chat, trajectory, context } = results({ isError: false, content: 'Error [dot/invalid]: invalid input' })
    expect(chat).toMatchObject({ status: 'error' })
    expect(trajectory).toMatchObject({ status: 'error' })
    expect(context).toMatchObject({ status: 'error' })
  })

  it('keeps reading pre-native error strings in old logs', () => {
    const { chat, trajectory, context } = results({ content: 'Error [dot/invalid]: invalid input' })
    expect(chat).toMatchObject({ status: 'error' })
    expect(trajectory).toMatchObject({ status: 'error' })
    expect(context).toMatchObject({ status: 'error' })
  })
})
