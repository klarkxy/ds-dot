// Adapted from deepseek-ai/dsh-superagent-prototype@8c32a9d (MIT).
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { classifyRetryFailure, RetryHealth, type RetryHealthEvent } from './retry-health.ts'

const epoch = Date.parse('2026-09-21T08:00:00Z')

function event(type: string, seq: number, data: unknown): RetryHealthEvent {
  return { type, seq, time: epoch + seq * 1000, data }
}

function retry(seq: number, data: Record<string, unknown> = {}): RetryHealthEvent {
  return event('llm/retry', seq, {
    retryId: 'chain-a',
    turn: 1,
    step: 2,
    provider: 'provider-a',
    mode: 'always',
    retry: 1,
    policyKey: 'opaque',
    delayMs: 10_000,
    failure: { type: 'budget_exceeded', message: 'Budget has been exceeded!' },
    ...data,
  })
}

function retryStarted(seq: number, data: Record<string, unknown> = {}): RetryHealthEvent {
  return event('llm/retry-started', seq, {
    retryId: 'chain-a',
    turn: 1,
    step: 2,
    retry: 1,
    ...data,
  })
}

function success(seq: number, turn = 1, step = 2, provider = 'provider-a'): RetryHealthEvent {
  return event('assistant/message', seq, {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'ok' }],
      source: { provider, model: 'model-a' },
    }),
  })
}

describe('RetryHealth', () => {
  it('tracks retry attempts, keeps lastAt on llm/retry, accumulates wait ms, and redacts raw failure/policy/chain', () => {
    const health = new RetryHealth()
    health.observe('s1', event('turn/start', 1, { turn: 1 }))
    health.observe('s1', event('step/start', 2, { turn: 1, step: 2 }))
    health.observe('s1', retry(3, { failure: { type: 'budget_exceeded', message: 'secret raw text' }, policyKey: 'secret-key' }))

    expect(health.get('s1')).toEqual({
      sessionId: 's1',
      provider: 'provider-a',
      kind: 'budget',
      attempts: 1,
      since: new Date(epoch + 3000).toISOString(),
      lastAt: new Date(epoch + 3000).toISOString(),
      accumulatedMs: 0,
    })

    // llm/retry-started settles elapsed wait from event.time delta but must NOT overwrite lastAt or attempts.
    health.observe('s1', retryStarted(4))
    expect(health.get('s1')).toEqual({
      sessionId: 's1',
      provider: 'provider-a',
      kind: 'budget',
      attempts: 1,
      since: new Date(epoch + 3000).toISOString(),
      lastAt: new Date(epoch + 3000).toISOString(),
      accumulatedMs: 1000,
    })

    health.observe('s1', retry(5, { retry: 345 }))
    const status = health.get('s1')
    expect(status).toEqual({
      sessionId: 's1',
      provider: 'provider-a',
      kind: 'budget',
      attempts: 345,
      since: new Date(epoch + 3000).toISOString(),
      lastAt: new Date(epoch + 5000).toISOString(),
      accumulatedMs: 1000,
    })
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('policyKey')
    expect(serialized).not.toContain('chain-a')
  })

  it('classifies positive budget patterns (structured, JSON message, plain text, quota/402)', () => {
    expect(classifyRetryFailure({ type: 'budget_exceeded' })).toBe('budget')
    expect(classifyRetryFailure({ code: 'budget_exceeded' })).toBe('budget')
    expect(classifyRetryFailure({ message: 'upstream error: {"error":{"type":"budget_exceeded"}}' })).toBe('budget')
    expect(classifyRetryFailure({ message: 'Budget has been exceeded! Please top up.' })).toBe('budget')
    expect(classifyRetryFailure({ code: 'QUOTA', message: 'Quota reached' })).toBe('budget')
    expect(classifyRetryFailure({ code: 'ACCOUNT_QUOTA', message: 'Account quota exhausted' })).toBe('budget')
    expect(classifyRetryFailure({ status: 402, message: 'Payment required' })).toBe('budget')
    expect(classifyRetryFailure({ message: 'Insufficient credits remaining' })).toBe('budget')
  })

  it('excludes auth/context/unsupported errors and classifies 429+budget text as transient', () => {
    // 429 + budget text must classify as transient (NOT budget).
    expect(classifyRetryFailure({ code: 'RATE_LIMIT', status: 429, message: 'Budget has been exceeded!' })).toBe('transient')
    expect(classifyRetryFailure({ code: 'INVALID_REQUEST', status: 429, message: 'Budget has been exceeded!' })).toBe('transient')
    // Auth, context, and unrelated text must return undefined.
    expect(classifyRetryFailure({ code: 'AUTHENTICATION_ERROR', message: 'Budget has been exceeded!' })).toBeUndefined()
    expect(classifyRetryFailure({ status: 401, message: 'Budget has been exceeded!' })).toBeUndefined()
    expect(classifyRetryFailure({ status: 403, message: 'Budget has been exceeded!' })).toBeUndefined()
    expect(classifyRetryFailure({ code: 'CONTEXT_LENGTH_EXCEEDED', message: 'too long' })).toBeUndefined()
    expect(classifyRetryFailure({ message: 'maximum context length exceeded' })).toBeUndefined()
    expect(classifyRetryFailure({ message: 'a budget was mentioned in the prompt' })).toBeUndefined()
    expect(classifyRetryFailure(null)).toBeUndefined()
    expect(classifyRetryFailure({ code: 'UNSUPPORTED', message: 'rate limit' })).toBeUndefined()
  })

  it('ignores user/message, assistant/message text, and assistant/attempt without llm/retry', () => {
    const health = new RetryHealth()
    health.observe('s1', event('turn/start', 1, { turn: 1 }))
    health.observe('s1', event('step/start', 2, { turn: 1, step: 1 }))
    health.observe('s1', event('user/message', 3, { content: [{ type: 'text', text: 'Budget has been exceeded!' }] }))
    health.observe('s1', event('assistant/attempt', 4, { turn: 1, step: 1, stream: [] }))
    health.observe('s1', event('assistant/message', 5, {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Budget has been exceeded!' }],
        source: { provider: 'provider-a', model: 'm' },
      }),
    }))
    expect(health.get('s1')).toBeUndefined()
    expect(health.list()).toEqual([])
  })

  it('isolates sessions and providers; new retryId or provider resets since and ignores stale provider settlement', () => {
    const health = new RetryHealth()
    health.observe('s1', retry(1, { retryId: 'c1', provider: 'provider-a', retry: 2 }))
    health.observe('s2', retry(1, { retryId: 'c2', provider: 'provider-b', retry: 1 }))
    expect(health.get('s1')?.attempts).toBe(2)
    expect(health.get('s2')?.attempts).toBe(1)

    // New provider on s1 resets since and accumulatedMs; old provider assistant/message does not clear fallback.
    health.observe('s1', retry(2, { retryId: 'c1', provider: 'provider-fallback', retry: 1 }))
    expect(health.get('s1')).toMatchObject({
      provider: 'provider-fallback',
      attempts: 1,
      since: new Date(epoch + 2000).toISOString(),
      accumulatedMs: 0,
    })
    health.observe('s1', success(3, 1, 2, 'provider-a'))
    expect(health.get('s1')?.provider).toBe('provider-fallback')

    // New retryId resets since as well.
    health.observe('s1', retry(4, { retryId: 'c3', provider: 'provider-fallback', retry: 1 }))
    expect(health.get('s1')?.since).toBe(new Date(epoch + 4000).toISOString())
    expect(health.get('s2')?.provider).toBe('provider-b')
  })

  it('enforces monotonic seq, turn, step, and settled guards', () => {
    const health = new RetryHealth()
    health.observe('s1', event('turn/start', 1, { turn: 2 }))
    health.observe('s1', event('step/start', 2, { turn: 2, step: 3 }))
    health.observe('s1', retry(5, { turn: 2, step: 3, retry: 2 }))

    // Duplicate seq, lower seq, lower attempt on same chain, earlier step, earlier turn.
    health.observe('s1', retry(5, { turn: 2, step: 3, retry: 3 }))
    health.observe('s1', retry(4, { turn: 2, step: 3, retry: 3 }))
    health.observe('s1', retry(6, { turn: 2, step: 3, retry: 1 }))
    health.observe('s1', retry(7, { turn: 2, step: 2, retry: 3 }))
    health.observe('s1', retry(8, { turn: 1, step: 9, retry: 3 }))
    expect(health.get('s1')?.attempts).toBe(2)

    // Settle on assistant/message -> late llm/retry in same (turn, step) cannot revive.
    health.observe('s1', success(9, 2, 3, 'provider-a'))
    expect(health.get('s1')).toBeUndefined()
    health.observe('s1', retry(10, { turn: 2, step: 3, retry: 4 }))
    expect(health.get('s1')).toBeUndefined()
  })

  it('keeps active wait on interrupted assistant/message and clears on non-interrupted one', () => {
    const health = new RetryHealth()
    health.observe('s1', retry(1))
    health.observe('s1', event('assistant/message', 2, {
      turn: 1,
      step: 2,
      interrupted: true,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'partial' }],
        source: { provider: 'provider-a', model: 'm' },
      }),
    }))
    expect(health.get('s1')?.attempts).toBe(1)

    health.observe('s1', success(3, 1, 2, 'provider-a'))
    expect(health.get('s1')).toBeUndefined()
  })

  it('clears active wait when unclassified failure occurs on same request, but keeps it on llm/retry-started', () => {
    const health = new RetryHealth()
    health.observe('s1', retry(1))
    health.observe('s1', retryStarted(2))
    expect(health.get('s1')?.attempts).toBe(1)

    health.observe('s1', retry(3, { retry: 2, failure: { code: 'AUTHENTICATION_ERROR', message: 'bad token' } }))
    expect(health.get('s1')).toBeUndefined()
  })

  it('clears on turn/end, turn/start, step/start, and clear(), and revives cleanly on new turn', () => {
    const health = new RetryHealth()
    health.observe('s1', retry(1, { turn: 1, step: 1 }))
    health.observe('s1', event('turn/end', 2, { turn: 1, reason: 'completed' }))
    expect(health.get('s1')).toBeUndefined()
    // Late retry on ended turn is ignored.
    health.observe('s1', retry(3, { turn: 1, step: 1, retry: 2 }))
    expect(health.get('s1')).toBeUndefined()

    // New turn revives cleanly.
    health.observe('s1', event('turn/start', 4, { turn: 2 }))
    health.observe('s1', event('step/start', 5, { turn: 2, step: 1 }))
    health.observe('s1', retry(6, { turn: 2, step: 1, retry: 1 }))
    expect(health.get('s1')?.attempts).toBe(1)

    // step/start advance clears.
    health.observe('s1', event('step/start', 7, { turn: 2, step: 2 }))
    expect(health.get('s1')).toBeUndefined()

    // New retry on step 2 then turn/start (turn 3) clears.
    health.observe('s1', retry(8, { turn: 2, step: 2, retry: 1 }))
    expect(health.get('s1')?.attempts).toBe(1)
    health.observe('s1', event('turn/start', 9, { turn: 3 }))
    expect(health.get('s1')).toBeUndefined()

    // clear() clears active without reviving on same step, but new turn revives.
    health.observe('s1', retry(10, { turn: 3, step: 1, retry: 1 }))
    expect(health.get('s1')?.attempts).toBe(1)
    health.clear('s1')
    expect(health.get('s1')).toBeUndefined()
    health.observe('s1', retry(11, { turn: 3, step: 1, retry: 2 }))
    expect(health.get('s1')).toBeUndefined()
    health.observe('s1', retry(12, { turn: 4, step: 1, retry: 1 }))
    expect(health.get('s1')?.attempts).toBe(1)
  })

  it('restores last active wait idempotently and clears on turn/end or clear', () => {
    const health = new RetryHealth()
    const log = [
      event('turn/start', 1, { turn: 1 }),
      event('step/start', 2, { turn: 1, step: 1 }),
      retry(3, { turn: 1, step: 1, retryId: 'old', retry: 1 }),
      retryStarted(4, { turn: 1, step: 1, retryId: 'old', retry: 1 }),
      success(5, 1, 1, 'provider-a'),
      event('step/start', 6, { turn: 1, step: 2 }),
      retry(7, { turn: 1, step: 2, retryId: 'live', retry: 1 }),
      retryStarted(8, { turn: 1, step: 2, retryId: 'live', retry: 1 }),
      retry(9, { turn: 1, step: 2, retryId: 'live', retry: 2 }),
    ]
    health.restore('s1', log)
    const first = health.get('s1')
    expect(first).toEqual({
      sessionId: 's1',
      provider: 'provider-a',
      kind: 'budget',
      attempts: 2,
      since: new Date(epoch + 7000).toISOString(),
      lastAt: new Date(epoch + 9000).toISOString(),
      accumulatedMs: 1000,
    })

    health.restore('s1', log)
    expect(health.get('s1')).toEqual(first)

    health.restore('s1', [...log, event('turn/end', 10, { turn: 1, reason: 'completed' })])
    expect(health.get('s1')).toBeUndefined()
    expect(health.accumulatedWaitMs('s1')).toBe(3000)
  })

  it('caps attempts, sanitizes invalid providers, and returns detached shallow copies', () => {
    const health = new RetryHealth()
    health.observe('s1', retry(1, {
      provider: 'bad provider / with spaces!',
      retry: Number.MAX_SAFE_INTEGER + 1000,
    }))
    const copy = health.get('s1')!
    expect(copy.provider).toBe('unknown')
    expect(copy.attempts).toBe(Number.MAX_SAFE_INTEGER)
    copy.attempts = 1
    copy.provider = 'mutated'
    expect(health.get('s1')?.attempts).toBe(Number.MAX_SAFE_INTEGER)
    expect(health.get('s1')?.provider).toBe('unknown')

    const listed = health.list()
    expect(listed).toHaveLength(1)
    listed[0]!.attempts = 9
    expect(health.get('s1')?.attempts).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('ignores malformed retry counts, invalid seq, and invalid event.time', () => {
    const health = new RetryHealth()
    health.observe('s1', retry(1, { retry: Number.NaN }))
    health.observe('s1', retry(2, { retry: Number.POSITIVE_INFINITY }))
    health.observe('s1', retry(3, { retry: -1 }))
    health.observe('s1', retry(4, { retry: 1.5 }))
    health.observe('s1', retry(-1, { retry: 1 }))
    health.observe('s1', { type: 'llm/retry', seq: 5, time: Number.NaN, data: { retryId: 'c', turn: 1, step: 1, provider: 'p', retry: 1, failure: { type: 'budget_exceeded' } } })
    expect(health.get('s1')).toBeUndefined()
  })

  it('classifies transient failures (429, 408, 5xx, codes, messages) and tracks multi-retry accumulatedMs', () => {
    for (const failure of [
      { status: 429, message: 'Too many requests' },
      { status: 408, message: 'Request timeout' },
      { status: 502, message: 'Bad gateway' },
      { status: 503, message: 'Service unavailable' },
      { status: 529, message: 'Overloaded' },
      { code: 'RATE_LIMIT', message: 'slow down' },
      { code: 'SERVER', message: 'internal' },
      { code: 'TIMEOUT', message: 'timed out' },
      { code: 'TRANSPORT', message: 'socket closed' },
      { code: 'STREAM_CLOSED', message: 'stream truncated' },
      { code: 'EMPTY_RESPONSE', message: 'empty' },
      { code: 'MALFORMED_RESPONSE', message: 'bad json' },
      { message: 'TypeError: fetch failed' },
      { message: 'read ECONNRESET' },
    ]) {
      expect(classifyRetryFailure(failure)).toBe('transient')
    }

    const health = new RetryHealth()
    health.observe('s1', event('turn/start', 1, { turn: 1 }))
    health.observe('s1', event('step/start', 2, { turn: 1, step: 1 }))
    // Retry 1 at t=+3000ms, started at t=+5500ms (+2500ms)
    health.observe('s1', { type: 'llm/retry', seq: 3, time: epoch + 3000, data: { retryId: 'c', turn: 1, step: 1, provider: 'p', retry: 1, delayMs: 2500, failure: { status: 429, code: 'RATE_LIMIT', message: '429' } } })
    health.observe('s1', { type: 'llm/retry-started', seq: 4, time: epoch + 5500, data: { retryId: 'c', turn: 1, step: 1, retry: 1 } })
    // Retry 2 at t=+6000ms, started at t=+11000ms (+5000ms -> total 7500ms)
    health.observe('s1', { type: 'llm/retry', seq: 5, time: epoch + 6000, data: { retryId: 'c', turn: 1, step: 1, provider: 'p', retry: 2, delayMs: 5000, failure: { status: 503, code: 'SERVER', message: '503' } } })
    health.observe('s1', { type: 'llm/retry-started', seq: 6, time: epoch + 11_000, data: { retryId: 'c', turn: 1, step: 1, retry: 2 } })

    expect(health.get('s1')).toEqual({
      sessionId: 's1',
      provider: 'p',
      kind: 'transient',
      attempts: 2,
      since: new Date(epoch + 3000).toISOString(),
      lastAt: new Date(epoch + 6000).toISOString(),
      accumulatedMs: 7500,
    })
  })

  it('resets since when retry kind transitions from transient to budget on same chain', () => {
    const health = new RetryHealth()
    health.observe('s1', retry(1, { retry: 1, failure: { status: 429, code: 'RATE_LIMIT', message: '429' } }))
    expect(health.get('s1')?.kind).toBe('transient')
    expect(health.get('s1')?.since).toBe(new Date(epoch + 1000).toISOString())

    health.observe('s1', retryStarted(2, { retry: 1 }))
    health.observe('s1', retry(3, { retry: 2, failure: { type: 'budget_exceeded', message: 'Budget has been exceeded!' } }))
    expect(health.get('s1')).toMatchObject({
      kind: 'budget',
      attempts: 2,
      since: new Date(epoch + 3000).toISOString(),
      accumulatedMs: 1000,
    })
  })

  it('settles aborted retry at turn/end using event.time delta rather than speculative delayMs', () => {
    const health = new RetryHealth()
    health.observe('s1', { type: 'turn/start', seq: 1, time: epoch + 1000, data: { turn: 1 } })
    health.observe('s1', { type: 'step/start', seq: 2, time: epoch + 1000, data: { turn: 1, step: 1 } })
    health.observe('s1', {
      type: 'llm/retry',
      seq: 3,
      time: epoch + 2000,
      data: { retryId: 'c', turn: 1, step: 1, provider: 'p', retry: 1, delayMs: 30_000, failure: { status: 503, code: 'SERVER', message: '503' } },
    })
    // Open wait at epoch + 2500
    expect(health.accumulatedWaitMs('s1', epoch + 2500)).toBe(500)
    // Aborted 100ms later without llm/retry-started
    health.observe('s1', { type: 'turn/end', seq: 4, time: epoch + 2100, data: { turn: 1, reason: 'aborted' } })
    expect(health.get('s1')).toBeUndefined()
    expect(health.accumulatedWaitMs('s1')).toBe(100)
  })

  it('preserves sessionAccumulatedMs across recovery and clear(), and deletes on remove()/clearAll()', () => {
    const health = new RetryHealth()
    health.observe('s1', retry(1, { retry: 1 }))
    health.observe('s1', retryStarted(2, { retry: 1 }))
    health.observe('s1', success(3, 1, 2, 'provider-a'))
    expect(health.get('s1')).toBeUndefined()
    expect(health.accumulatedWaitMs('s1')).toBe(1000)

    // clear() preserves sessionAccumulatedMs
    health.observe('s1', event('step/start', 4, { turn: 1, step: 3 }))
    health.observe('s1', retry(5, { turn: 1, step: 3, retry: 1 }))
    health.observe('s1', retryStarted(6, { turn: 1, step: 3, retry: 1 }))
    health.clear('s1')
    expect(health.get('s1')).toBeUndefined()
    expect(health.accumulatedWaitMs('s1')).toBe(2000)

    // remove() deletes entry completely
    health.remove('s1')
    expect(health.accumulatedWaitMs('s1')).toBe(0)

    // clearAll() clears all sessions
    health.observe('s2', retry(1))
    health.observe('s2', retryStarted(2))
    expect(health.accumulatedWaitMs('s2')).toBe(1000)
    health.clearAll()
    expect(health.list()).toEqual([])
    expect(health.accumulatedWaitMs('s2')).toBe(0)
  })

  it('rc.5 micro-verification: real SessionStore + Cordis session/event + snapshotEvents() backfill', async () => {
    const ctx = new Context()
    new SessionStore(ctx)
    const health = new RetryHealth()
    ctx.on('session/event', (session, ev) => {
      health.observe(session.id, ev)
    })

    const session = ctx.sessions.create(SessionId('rc5-retry-1'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('llm/retry' as never, {
      retryId: 'r-normal',
      turn: 1,
      step: 1,
      provider: 'deepseek',
      mode: 'normal',
      policyKey: 'default',
      retry: 1,
      maxRetries: 3,
      delayMs: 250,
      failure: { status: 429, code: 'RATE_LIMIT', message: 'rate limit' },
    } as never)

    const live1 = health.get(session.id)
    expect(live1).toBeDefined()
    expect(live1?.kind).toBe('transient')
    expect(live1?.attempts).toBe(1)
    expect(Number.isFinite(Date.parse(live1!.since))).toBe(true)

    session.append('llm/retry-started' as never, {
      retryId: 'r-normal',
      turn: 1,
      step: 1,
      retry: 1,
    } as never)
    expect(health.get(session.id)?.attempts).toBe(1)
    expect(health.get(session.id)?.accumulatedMs).toBeGreaterThanOrEqual(0)

    // Restore into a fresh RetryHealth instance from real session.snapshotEvents()
    const restored = new RetryHealth()
    restored.restore(session.id, session.snapshotEvents())
    expect(restored.get(session.id)).toEqual(health.get(session.id))

    // Successful assistant/message from @deepseek-ai/dsh-llm clears active retry
    const msg = createAssistantMessage({
      content: [{ type: 'text', text: 'recovered' }],
      source: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    session.append('assistant/message', { turn: 1, step: 1, message: msg, stream: [] }, { surfaceOp: 'append' })
    expect(health.get(session.id)).toBeUndefined()

    // mode: 'always' budget_exceeded on step 2
    session.append('step/start', { turn: 1, step: 2 })
    session.append('llm/retry' as never, {
      retryId: 'r-budget',
      turn: 1,
      step: 2,
      provider: 'deepseek',
      mode: 'always',
      policyKey: 'always',
      retry: 1,
      delayMs: 5000,
      failure: { type: 'budget_exceeded', message: 'Budget has been exceeded!' },
    } as never)
    expect(health.get(session.id)?.kind).toBe('budget')

    // 401 AUTH under mode: 'always' does not track retry health
    session.append('step/start', { turn: 1, step: 3 })
    session.append('llm/retry' as never, {
      retryId: 'r-auth',
      turn: 1,
      step: 3,
      provider: 'deepseek',
      mode: 'always',
      policyKey: 'always',
      retry: 1,
      delayMs: 5000,
      failure: { status: 401, code: 'AUTH', message: 'Unauthorized' },
    } as never)
    expect(health.get(session.id)).toBeUndefined()
  })
})
