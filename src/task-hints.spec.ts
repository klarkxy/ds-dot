import { describe, expect, it } from 'vitest'
import { IDLE_SILENCE_HINT, isSilenceReply } from './task-hints.ts'

describe('task hints', () => {
  it('treats only a short no-news acknowledgement as silence', () => {
    expect(isSilenceReply('暂无新结论，静默等待。')).toBe(true)
    expect(isSilenceReply('silently waiting')).toBe(true)
    expect(isSilenceReply('The operation failed. Please confirm how to proceed.')).toBe(false)
    expect(isSilenceReply('静默等待？')).toBe(false)
    expect(isSilenceReply(`静默等待 ${'x'.repeat(80)}`)).toBe(false)
  })

  it('forbids meta declarations of silence in the idle hint', () => {
    expect(IDLE_SILENCE_HINT).toContain('not even a note declaring that you are silent')
    expect(IDLE_SILENCE_HINT).toContain('no assistant text')
    // The observed failure mode: a parenthesized meta statement. It is not a
    // silence-acknowledgement pattern, so it stays visible — the hint must
    // prevent the model from producing it at all.
    expect(isSilenceReply('*(silent — no new information for the human; the pending question from the previous turn stands)*')).toBe(false)
  })
})
