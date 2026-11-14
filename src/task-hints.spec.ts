import { describe, expect, it } from 'vitest'
import { IDLE_SILENCE_HINT, isSilenceReply, recordedReviewFailStreak, reviewWaitHint, updateStatusRefusal } from './task-hints.ts'

const review = (verdict?: 'pass' | 'fail') => ({ role: 'review' as const, ...(verdict ? { verdict } : {}) })

describe('task hints', () => {
  it('refuses a status change on update and names the stored status', () => {
    const text = updateStatusRefusal('t-16', 'active', 'done')
    expect(text).toContain('t-16 is still active')
    expect(text).toContain('nothing was changed')
    expect(text).toContain('action=move')
    expect(text).toContain('action=note')
    expect(text).not.toContain('is now done')
  })

  it('counts the review sequence, so rework between fails does not reset it', () => {
    const rework = { role: 'rework' as const }
    expect(recordedReviewFailStreak([])).toBeUndefined()
    expect(recordedReviewFailStreak([review(), review('fail')])).toBe(1)
    expect(recordedReviewFailStreak([review('fail'), rework, review('fail'), rework, review('fail')])).toBe(3)
    expect(recordedReviewFailStreak([review('fail'), rework, review(), rework, review('fail'), rework, review('fail')])).toBe(2)
    expect(recordedReviewFailStreak([review('fail'), review('pass'), rework, review('fail')])).toBe(1)
    expect(recordedReviewFailStreak([review('fail'), review()])).toBeUndefined()
  })

  it('states the three-round rule without a count until this task has three recorded fails', () => {
    const open = reviewWaitHint([review('fail'), review('fail')])
    expect(open).toContain('ask the human and wait')
    expect(open).toContain('Do not count other tasks')
    expect(open).not.toContain('end with')
    const closed = reviewWaitHint([review('fail'), { role: 'rework' }, review('fail'), { role: 'rework' }, review('fail')])
    expect(closed).toContain('end with 3 consecutive unsuccessful verdicts')
    expect(closed).not.toContain('end with 6')
  })

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
