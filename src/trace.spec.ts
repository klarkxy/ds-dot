import { describe, expect, it, vi } from 'vitest'
import { emitDotTrace, traceIdleFired, traceSessionSendRefused, traceSessionSent, traceTicketMoved, traceTicketUpdateRejected } from './trace.ts'

function sink() {
  return {
    info: vi.fn(() => true),
    debug: vi.fn(() => true),
    warn: vi.fn(() => true),
  }
}

describe('dot trace', () => {
  it('records a real status move with the stored endpoints', () => {
    const logger = sink()
    expect(traceTicketMoved(logger, { ticketId: 't-16', from: 'active', to: 'review', by: 'dot' })).toBe(true)
    expect(logger.info).toHaveBeenCalledWith('ticket.moved', 'Task t-16 moved from active to review.', {
      ticketId: 't-16', from: 'active', to: 'review', by: 'dot',
    })
  })

  it('records a refused status update without claiming the move', () => {
    const logger = sink()
    traceTicketUpdateRejected(logger, { ticketId: 't-16', status: 'active', to: 'done' })
    expect(logger.info).toHaveBeenCalledWith('ticket.update-rejected', 'Update refused; t-16 is still active.', {
      ticketId: 't-16', status: 'active', to: 'done',
    })
  })

  it('distinguishes a queued follow-up from a refused one', () => {
    const logger = sink()
    traceSessionSent(logger, { sessionId: 's1', ticketId: 't-1', queued: true })
    expect(logger.info).toHaveBeenCalledWith('session.sent', 'Queued a follow-up for s1.', {
      ticketId: 't-1', sessionId: 's1', queued: true,
    })
    traceSessionSendRefused(logger, { sessionId: 's1', ticketId: 't-1', code: 'dot/permission-failed' })
    expect(logger.warn).toHaveBeenCalledWith('session.send-refused', 'Follow-up to s1 was not delivered.', undefined, {
      ticketId: 't-1', sessionId: 's1', code: 'dot/permission-failed',
    })
    expect(logger.info).toHaveBeenCalledTimes(1)
  })

  it('records an idle check without hiding a skipped one', () => {
    const logger = sink()
    traceIdleFired(logger, { candidates: 't-1:ready' })
    expect(logger.info).toHaveBeenCalledWith('idle.fired', 'Routine check fired.', { candidates: 't-1:ready' })
  })

  it('drops instruction text and survives a broken sink', () => {
    const logger = sink()
    emitDotTrace(logger, {
      event: 'Not An Event',
      message: 'kept',
      data: { instruction: 'do the work', from: 'active' },
    })
    expect(logger.info).toHaveBeenCalledWith('dot.trace', 'kept', { from: 'active' })
    logger.info.mockImplementation(() => { throw new Error('disk full') })
    expect(traceTicketMoved(logger, { ticketId: 't-1', from: 'todo', to: 'active', by: 'dot' })).toBe(false)
  })
})
