import type { PluginLogContext, PluginLogger } from '@klarkxy/dsh-plugin-kit/log-shared'

/** The decisions worth grepping. Names match the kit's event pattern. */
export const DOT_TRACE = {
  sessionDispatched: 'session.dispatched',
  sessionSent: 'session.sent',
  sessionSendRefused: 'session.send-refused',
  idleFired: 'idle.fired',
  idleSuppressed: 'idle.suppressed',
  keepalivePing: 'keepalive.ping',
  keepaliveFailed: 'keepalive.failed',
  keepaliveRollover: 'keepalive.rollover',
  lockHeld: 'lock.held',
  lockReleased: 'lock.released',
  lockConflict: 'lock.conflict',
  approvalOpened: 'approval.opened',
  approvalSettled: 'approval.settled',
  approvalNotifyFailed: 'approval.notify-failed',
  noticeDelivered: 'notice.delivered',
  noticeHeld: 'notice.held',
  noticeSuppressed: 'notice.suppressed',
  childSealed: 'child-session.sealed',
  peerSent: 'peer.sent',
  peerDuplicate: 'peer.duplicate',
  peerUnknown: 'peer.unknown',
  peerRefused: 'peer.refused',
  factoryReset: 'factory.reset',
  updateChecked: 'update.checked',
  updateApplied: 'update.applied',
  updateFailed: 'update.failed',
  githubPollStarted: 'github-poll.started',
  githubPollCompleted: 'github-poll.completed',
  githubPollFailed: 'github-poll.failed',
  githubPollRateLimited: 'github-poll.rate-limited',
  githubPollAdmitted: 'github-poll.admitted',
  githubPollDirectDelivered: 'github-poll.direct-delivered',
  githubPollBounced: 'github-poll.bounced',
  githubPollClosure: 'github-poll.closure',
} as const

export type DotTraceEventName = (typeof DOT_TRACE)[keyof typeof DOT_TRACE]

type Sink = Pick<PluginLogger, 'info' | 'debug' | 'warn'>

const EVENT_RE = /^[a-z][a-z0-9._-]{0,127}$/
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/
const DROPPED_KEY = /instruction|prompt|reply|message|detail|secret|token|password|credential/i
const TEXT_MAX = 160

export interface DotTraceInput {
  readonly event: string
  readonly message: string
  readonly level?: 'info' | 'debug' | 'warn'
  readonly changeId?: string
  readonly sessionId?: string
  readonly data?: PluginLogContext
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > TEXT_MAX ? trimmed.slice(0, TEXT_MAX) : trimmed
}

function contextOf(input: DotTraceInput): PluginLogContext {
  const context: PluginLogContext = {}
  if (input.changeId?.trim()) context.changeId = clip(input.changeId)
  if (input.sessionId?.trim()) context.sessionId = clip(input.sessionId)
  for (const [key, value] of Object.entries(input.data ?? {}).slice(0, 12)) {
    if (!KEY_RE.test(key) || DROPPED_KEY.test(key) || value === undefined) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    context[key] = typeof value === 'string' ? clip(value) : value
  }
  return context
}

/** One decision line through the existing plugin logger. A sink failure is ignored. */
export function emitDotTrace(logger: Sink, input: DotTraceInput): boolean {
  const event = EVENT_RE.test(input.event) ? input.event : 'dot.trace'
  const message = clip(input.message)
  const context = contextOf(input)
  try {
    if (input.level === 'debug') return logger.debug(event, message, context)
    if (input.level === 'warn') return logger.warn(event, message, undefined, context)
    return logger.info(event, message, context)
  } catch {
    return false
  }
}

export function traceSessionSent(logger: Sink, input: { sessionId: string; changeId?: string; queued: boolean }): boolean {
  return emitDotTrace(logger, {
    event: DOT_TRACE.sessionSent,
    message: input.queued ? `Queued a follow-up for ${input.sessionId}.` : `Delivered a follow-up to ${input.sessionId}.`,
    sessionId: input.sessionId,
    ...(input.changeId ? { changeId: input.changeId } : {}),
    data: { queued: input.queued },
  })
}

export function traceSessionSendRefused(logger: Sink, input: { sessionId: string; changeId?: string; code: string }): boolean {
  return emitDotTrace(logger, {
    event: DOT_TRACE.sessionSendRefused,
    level: 'warn',
    message: `Follow-up to ${input.sessionId} was not delivered.`,
    sessionId: input.sessionId,
    ...(input.changeId ? { changeId: input.changeId } : {}),
    data: { code: input.code },
  })
}

export function traceIdleFired(logger: Sink, input: { candidates: string }): boolean {
  return emitDotTrace(logger, {
    event: DOT_TRACE.idleFired,
    message: 'Routine check fired.',
    data: { candidates: input.candidates },
  })
}

export function traceIdleSuppressed(logger: Sink, input: { reason: 'unchanged' | 'closing' | 'busy' }): boolean {
  return emitDotTrace(logger, {
    event: DOT_TRACE.idleSuppressed,
    message: 'Routine check did not fire.',
    data: { reason: input.reason },
  })
}
