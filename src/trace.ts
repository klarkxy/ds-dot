import type { PluginLogContext, PluginLogger } from '@klarkxy/dsh-plugin-kit/log-shared'

/** The decisions worth grepping. Names match the kit's event pattern. */
export const DOT_TRACE = {
  ticketCreated: 'ticket.created',
  ticketMoved: 'ticket.moved',
  ticketNoted: 'ticket.noted',
  ticketUpdateRejected: 'ticket.update-rejected',
  sessionDispatched: 'session.dispatched',
  sessionSent: 'session.sent',
  sessionSendRefused: 'session.send-refused',
  idleFired: 'idle.fired',
  idleSuppressed: 'idle.suppressed',
  lockHeld: 'lock.held',
  lockReleased: 'lock.released',
  lockConflict: 'lock.conflict',
  approvalOpened: 'approval.opened',
  approvalSettled: 'approval.settled',
  approvalNotifyFailed: 'approval.notify-failed',
  noticeDelivered: 'notice.delivered',
  noticeHeld: 'notice.held',
  noticeSuppressed: 'notice.suppressed',
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
  readonly ticketId?: string
  readonly sessionId?: string
  readonly data?: PluginLogContext
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > TEXT_MAX ? trimmed.slice(0, TEXT_MAX) : trimmed
}

function contextOf(input: DotTraceInput): PluginLogContext {
  const context: PluginLogContext = {}
  if (input.ticketId?.trim()) context.ticketId = clip(input.ticketId)
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

export function traceTicketMoved(logger: Sink, input: { ticketId: string; from: string; to: string; by: string }): boolean {
  return emitDotTrace(logger, {
    event: DOT_TRACE.ticketMoved,
    message: `Task ${input.ticketId} moved from ${input.from} to ${input.to}.`,
    ticketId: input.ticketId,
    data: { from: input.from, to: input.to, by: input.by },
  })
}

export function traceTicketUpdateRejected(logger: Sink, input: { ticketId: string; status: string; to: string }): boolean {
  return emitDotTrace(logger, {
    event: DOT_TRACE.ticketUpdateRejected,
    message: `Update refused; ${input.ticketId} is still ${input.status}.`,
    ticketId: input.ticketId,
    data: { status: input.status, to: input.to },
  })
}

export function traceSessionSent(logger: Sink, input: { sessionId: string; ticketId?: string; queued: boolean }): boolean {
  return emitDotTrace(logger, {
    event: DOT_TRACE.sessionSent,
    message: input.queued ? `Queued a follow-up for ${input.sessionId}.` : `Delivered a follow-up to ${input.sessionId}.`,
    sessionId: input.sessionId,
    ...(input.ticketId ? { ticketId: input.ticketId } : {}),
    data: { queued: input.queued },
  })
}

export function traceSessionSendRefused(logger: Sink, input: { sessionId: string; ticketId?: string; code: string }): boolean {
  return emitDotTrace(logger, {
    event: DOT_TRACE.sessionSendRefused,
    level: 'warn',
    message: `Follow-up to ${input.sessionId} was not delivered.`,
    sessionId: input.sessionId,
    ...(input.ticketId ? { ticketId: input.ticketId } : {}),
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
