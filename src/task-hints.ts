/** Appended only after a start or send call has already been accepted by the host. */
export const ACCEPTED_DELIVERY_HINT = 'Do not resend it. If no independent work can advance right now, end this turn and wait for a completion or error notice.'

/** First instruction accepted by host prompt mode `queue`. */
export const QUEUED_INSTRUCTION_HINT = `The instruction is queued. ${ACCEPTED_DELIVERY_HINT}`

/**
 * Routine checks are for dot, not the human. This stays on the notice so a
 * no-news check does not become a visible "silently waiting" reply.
 */
export const IDLE_SILENCE_HINT = 'If nothing here requires the human, end the turn with no assistant text and no card. Do not announce that you are waiting — silence means emitting no message at all, not even a note declaring that you are silent.'

const SILENCE_REPLY = /^(?:[\s`'“”"「」]*)(?:(?:暂无|没有)(?:新的?)?(?:结论|进展|事项|动态|需要处理的内容)?[，,、\s]*)?(?:静默等待|继续等待|保持沉默|无需(?:汇报|回复|打扰)|暂不打扰|silently waiting|waiting silently|nothing new to report|no new (?:conclusion|update|progress)|no update needed)[。.!！\s]*$/i

/** A routine-check reply that only announces silence. Questions and other text stay visible. */
export function isSilenceReply(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 80 || /[?？]/.test(trimmed)) return false
  return SILENCE_REPLY.test(trimmed)
}
