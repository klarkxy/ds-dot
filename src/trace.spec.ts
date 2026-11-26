import { describe, expect, it, vi } from 'vitest'
import { emitDotTrace, traceIdleFired, traceSessionSendRefused, traceSessionSent } from './trace.ts'

function sink() {
  return {
    info: vi.fn(() => true),
    debug: vi.fn(() => true),
    warn: vi.fn(() => true),
  }
}

describe('dot trace', () => {
  it('distinguishes a queued follow-up from a refused one', () => {
    const logger = sink()
    traceSessionSent(logger, { sessionId: 's1', changeId: 'c-1', queued: true })
    expect(logger.info).toHaveBeenCalledWith('session.sent', 'Queued a follow-up for s1.', {
      changeId: 'c-1', sessionId: 's1', queued: true,
    })
    traceSessionSendRefused(logger, { sessionId: 's1', changeId: 'c-1', code: 'dot/permission-failed' })
    expect(logger.warn).toHaveBeenCalledWith('session.send-refused', 'Follow-up to s1 was not delivered.', undefined, {
      changeId: 'c-1', sessionId: 's1', code: 'dot/permission-failed',
    })
    expect(logger.info).toHaveBeenCalledTimes(1)
  })

  it('records an idle check without hiding a skipped one', () => {
    const logger = sink()
    traceIdleFired(logger, { candidates: 'c-1:ready' })
    expect(logger.info).toHaveBeenCalledWith('idle.fired', 'Routine check fired.', { candidates: 'c-1:ready' })
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
    expect(traceSessionSent(logger, { sessionId: 's1', queued: false })).toBe(false)
  })

  it('emits watchdog trace events with DROPPED_KEY and TEXT_MAX hygiene', () => {
    const logger = sink()
    emitDotTrace(logger, {
      event: 'watchdog.hit',
      level: 'warn',
      message: 'Watchdog signal repeat-tool-call fired.',
      changeId: 'chg-1',
      sessionId: 'sess-1',
      data: { signal: 'repeat-tool-call', detail: 'dropped', token: 'secret', count: 4 },
    })
    expect(logger.warn).toHaveBeenCalledWith('watchdog.hit', 'Watchdog signal repeat-tool-call fired.', undefined, {
      changeId: 'chg-1',
      sessionId: 'sess-1',
      signal: 'repeat-tool-call',
      count: 4,
    })
  })
})
