/**
 * dot's conversation runs as a chain of session segments instead of one
 * session that compacts in place. This file holds the records and the pure
 * decisions: when a segment ends and what the next one opens with.
 */
import { TOOL, type RolloverReason } from './contracts.ts'
import { handoffText, type Handoff } from './handoff.ts'
import { stamp } from './transcript.ts'

/** A segment left idle this long ends before the next delivery, when it is large enough to be worth it. */
export const IDLE_ROLLOVER_MS = 2 * 60 * 60_000
export const IDLE_MIN_TOKENS = 32_768
/** Ended segments remembered for the chat history. */
export const MAX_PAST_SEGMENTS = 200

/** The segment dot is talking in. Its prompt inputs are frozen so every request shares one cacheable prefix. */
export interface Segment {
  readonly sessionId: string
  readonly startedAt: number
  /** Persona section as it read when the segment started. */
  readonly persona: string
  /** Model the segment runs on, as `provider/model@effort`. */
  readonly model?: string

  /** Agreements block of the system prompt as it read when the segment started; absent while there are none. */
  readonly agreements?: string
  /**
   * Agreements block as this segment's conversation last accounted for it: set when dot itself changes
   * the agreements here, since it then knows the change. A block that differs from this was edited
   * by the human (or the reflection pass), which starts a new segment before the next message.
   */
  readonly agreementsSeen?: string
  /** Cognition block of the system prompt as it read when the segment started; absent while dot has written none. */
  readonly cognition?: string
  /** Cognition block as this segment's conversation last accounted for it (dot's own rewrite). */
  readonly cognitionSeen?: string
  /** Handoff block of the system prompt; absent in the very first segment. */
  readonly opening?: string
  readonly handoff?: Handoff
  /** Extra-capability grants as they read when the segment started, serialized. */
  readonly capabilities?: string
  /** Why the previous segment ended. */
  readonly reason?: RolloverReason
}

export interface PastSegment {
  readonly sessionId: string
  readonly startedAt: number
  readonly endedAt: number
  readonly reason?: RolloverReason
}

export interface DeliveryCheck {
  /** Whether dot has replied in this segment; an untouched segment is updated in place instead. */
  readonly replied: boolean
  readonly now: number
  readonly lastReplyAt?: number
  readonly usedTokens?: number
  readonly persona: string
  readonly frozenPersona: string
  readonly model?: string
  readonly frozenModel?: string
  /** Agreements block as it reads now, and as the segment last accounted for it. */
  readonly agreements?: string
  readonly seenAgreements?: string
  /** Cognition block as it reads now, and as the segment last accounted for it. */
  readonly cognition?: string
  readonly seenCognition?: string
  /** Extra-capability grants as they read now, and as the segment froze them. */
  readonly capabilities?: string
  readonly frozenCapabilities?: string
}

/** Segments stored before the capability field existed freeze the same as an empty grant map. */
export const EMPTY_CAPABILITIES_SIGNATURE = '{}'

/** Checked before every message that reaches dot. */
export function reasonBeforeDelivery(check: DeliveryCheck): RolloverReason | undefined {
  if (!check.replied) return undefined
  if (check.model !== undefined && check.frozenModel !== undefined && check.model !== check.frozenModel) return 'model-switch'
  if (check.persona !== check.frozenPersona) return 'prompt-changed'
  // The human (or a reflection pass) changed a block; dot's own changes are already part of the conversation.
  if ((check.agreements ?? '') !== (check.seenAgreements ?? '')) return 'prompt-changed'
  if ((check.cognition ?? '') !== (check.seenCognition ?? '')) return 'prompt-changed'
  if ((check.capabilities ?? EMPTY_CAPABILITIES_SIGNATURE) !== (check.frozenCapabilities ?? EMPTY_CAPABILITIES_SIGNATURE)) return 'capabilities-changed'
  if (check.lastReplyAt !== undefined && check.now - check.lastReplyAt >= IDLE_ROLLOVER_MS && (check.usedTokens ?? 0) >= IDLE_MIN_TOKENS) return 'idle-expired'
  return undefined
}

/** Checked when dot's turn has ended. */
export function reasonAfterTurn(check: { readonly usedTokens?: number; readonly rolloverAt?: number }): RolloverReason | undefined {
  return check.usedTokens !== undefined && check.rolloverAt !== undefined && check.usedTokens >= check.rolloverAt ? 'context-full' : undefined
}

const WHY: Record<RolloverReason, string> = {
  'context-full': 'the previous session had grown long',
  'idle-expired': 'the previous session had been idle for a long time',
  'model-switch': 'your model was changed',
  'prompt-changed': 'your persona, agreements, or cognition updated, and the sections above now reflect the current text',
  'capabilities-changed': 'the human changed which extra capabilities you can use, and your tool list now reflects that',
  'lost': 'the previous session could not be reopened',
  'manual': 'the human started a new segment from the context page',
  'dot-requested': 'you chose to start a new segment',
}

/** The handoff block a new segment keeps in its system prompt for its whole life. */
export function openingText(input: { readonly handoff?: Handoff; readonly reason: RolloverReason; readonly ledger?: string; readonly reminders?: string; /** Session the conversation ran in until now. */ readonly previous?: string; readonly at: number }): string {
  const body = input.handoff ? handoffText(input.handoff) : ''
  const parts = [
    '[conversation handoff]',
    `You are continuing an ongoing conversation with the same human in a fresh session, because ${WHY[input.reason]}. The human sees one seamless chat: continue naturally and do not mention the handoff unless asked. What follows is the context carried into this segment; earlier messages are no longer inline.`,
  ]
  parts.push(body || 'Nothing was carried over from the earlier conversation.')
  parts.push('Earlier unanswered cards may be answered late. Their numbered reply arrives in the active segment with an expired-card prefix; use the history tools if you need the original card or its context.')
  // The log of every earlier segment stays readable, so what a note left out is not lost.
  parts.push(`Full transcripts of earlier segments remain searchable. Whenever you need exact wording or a detail omitted above, look it up with ${TOOL.searchHistory} and read surrounding context with ${TOOL.readHistory}${input.previous ? ` (the immediately preceding session is ${input.previous})` : ''} before asking the human to repeat themselves.`)
  if (input.ledger?.trim()) parts.push(`Task ledger at handoff (${stamp(input.at)}); state may have advanced since, and ${TOOL.overview} shows the current state:\n${input.ledger.trim()}`)
  if (input.reminders?.trim()) parts.push(`Reminders set at handoff; they remain active, and ${TOOL.schedule} (action=list) shows the current list:\n${input.reminders.trim()}`)
  return parts.join('\n\n')
}
