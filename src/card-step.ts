/**
 * Whether this show_view is the only tool call of the current step.
 *
 * The loop appends that step's assistant message before the batch.
 * deriveMessages() is the supported read; only its last assistant message
 * is this step. An older message is not the batch, and a repeated call id
 * is not a single card.
 */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

export type StepTranscript = Pick<Session, 'deriveMessages'>

/** Model-facing refusal. The view may be valid; it is just not the only call. */
export const SHOW_VIEW_MIXED_SUMMARY = 'show_view shared this step with another tool call, so the card was deferred and the turn remains open. Wait for the other tool results, then call show_view alone in its own step.'

/**
 * Durable tool/result meta. The canonical status is not stored on the event.
 * No deep-view owner, so cardText stays empty. An invalid view has no meta.
 */
export const SHOW_VIEW_DEFERRED_META = { dshDot: { showView: 'deferred' } } as const

/** True when the current step is not exactly one tool call with this id. No history is not a mix. */
export function showViewSharesStep(messages: readonly Message[] | undefined, callId: string | undefined): boolean {
  if (!callId || messages === undefined) return false
  let message: Message | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      message = messages[index]
      break
    }
  }
  if (message === undefined) return false
  const calls = message.content.filter(block => block.type === 'tool-call')
  return !(calls.length === 1 && calls[0]?.id === callId)
}
