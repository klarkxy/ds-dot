import type { TicketRound, TicketStatus } from './contracts.ts'

/** Appended only after a start or send call has already been accepted by the host. */
export const ACCEPTED_DELIVERY_HINT = 'Do not send it again. If nothing else can advance, end this turn and wait for a completion or error notice.'

/** First instruction accepted by host prompt mode `queue`. */
export const QUEUED_INSTRUCTION_HINT = `The instruction is queued. ${ACCEPTED_DELIVERY_HINT}`

/**
 * Routine checks are for dot, not the human. This stays on the notice so a
 * no-news check does not become a visible "silently waiting" reply.
 */
export const IDLE_SILENCE_HINT = 'If nothing here needs the human, end the turn with no assistant text. Do not write that you are waiting — silence means no message at all, not even a note declaring that you are silent.'

const SILENCE_REPLY = /^(?:[\s`'“”"「」]*)(?:(?:暂无|没有)(?:新的?)?(?:结论|进展|事项|需要处理的内容)?[，,、\s]*)?(?:静默等待|继续等待|保持沉默|无需(?:汇报|回复)|silently waiting|waiting silently|nothing new to report|no new (?:conclusion|update|progress))[。.!！\s]*$/i

/** A routine-check reply that only announces silence. Questions and other text stay visible. */
export function isSilenceReply(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 80 || /[?？]/.test(trimmed)) return false
  return SILENCE_REPLY.test(trimmed)
}

/** `update` never migrates status. The refusal names the status that is still stored. */
export function updateStatusRefusal(id: string, status: TicketStatus, to: string): string {
  return `update only changes fields and does not move status. ${id} is still ${status}; nothing was changed. Use action=move with to="${to}" and a reason to migrate it. Use action=note to record a round.`
}

/**
 * Consecutive unsuccessful review rounds on this one task.
 * Work and rework notes sit between reviews in the normal loop, so they are
 * skipped. A review note without a fail verdict ends the sequence: a missing
 * verdict is not counted as a fail, and a pass starts a new sequence.
 */
export function recordedReviewFailStreak(rounds: readonly Pick<TicketRound, 'role' | 'verdict'>[]): number | undefined {
  let streak = 0
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index]!
    if (round.role !== 'review') continue
    if (round.verdict !== 'fail') break
    streak += 1
  }
  return streak > 0 ? streak : undefined
}

export function reviewHintApplies(input: { status: TicketStatus; role?: string; rounds: readonly Pick<TicketRound, 'role' | 'verdict'>[] }): boolean {
  return input.status === 'review' || input.role === 'review' || (recordedReviewFailStreak(input.rounds) ?? 0) > 0
}

/**
 * The rule is always stated. A number is included only for a trailing streak of
 * three or more fail verdicts on this task's own notes.
 */
export function reviewWaitHint(rounds: readonly Pick<TicketRound, 'role' | 'verdict'>[]): string {
  const rule = 'After three consecutive unsuccessful review rounds recorded on this same task, ask the human and wait. Count only this task\'s own review notes with verdict=fail. Work and rework notes do not break that sequence. A review note without a verdict ends it. Do not count other tasks or notes that were not recorded.'
  const streak = recordedReviewFailStreak(rounds)
  if (streak !== undefined && streak >= 3) return `This task's own recorded review notes end with ${streak} consecutive unsuccessful verdicts. ${rule}`
  return rule
}
