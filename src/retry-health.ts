// Adapted from deepseek-ai/dsh-superagent-prototype@8c32a9d (MIT).
import type { RetryKind, WorkRunRetryStatus } from './contracts.ts'

export type { RetryKind, WorkRunRetryStatus }

export interface RetryHealthEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
}

export interface RetryStatus {
  sessionId: string
  provider: string
  kind: RetryKind
  attempts: number
  since: string
  lastAt: string
  accumulatedMs: number
}

interface ActiveChain {
  readonly id: string
  readonly provider: string
  readonly kind: RetryKind
  waitStartedAt: number | undefined
  readonly status: RetryStatus
}

interface SessionState {
  seq: number
  turn: number
  step: number
  ended: boolean
  settled: boolean
  active?: ActiveChain
  sessionAccumulatedMs: number
}

const MAX_TIME = 8.64e15
const PROVIDER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/
const ACCEPTED_STEP_TYPES = new Set(['step/start', 'llm/retry', 'assistant/message'])
const EXCLUSION_CODE_RE = /AUTH|INVALID_CREDENTIAL|MISSING_CREDENTIAL|ACCOUNT_SIGN_IN|ACCOUNT_TOKEN|CONTEXT|TOKEN_LIMIT|CONTENT_REFUSED|UNSUPPORTED/i
const CONTEXT_OVERFLOW_MESSAGE_RE = /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b|\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i
const TRANSIENT_CODE_RE = /^(?:RATE_LIMIT|SERVER|TIMEOUT|TRANSPORT|STREAM_CLOSED|EMPTY_RESPONSE|MALFORMED_RESPONSE|HTTP_429|HTTP_408|HTTP_5\d\d)$/i
const TRANSIENT_MESSAGE_RE = /\b(?:rate[\s_-]*limit|too many requests|overloaded|service unavailable|bad gateway|gateway time[\s_-]*out|socket hang up|fetch failed|premature close|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i
const BUDGET_TEXT_RE = /\bBudget has been exceeded(?:!|[.:]|$)/i
const QUOTA_EXCEEDED_RE = /\binsufficient[\s_-]+(?:quota|balance|credits?)\b|\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b|\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b|\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b|\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function ordinal(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIME
}

export function classifyRetryFailure(value: unknown): RetryKind | undefined {
  const failure = record(value)
  if (!failure) return undefined
  const status = Number(failure.status)
  const code = typeof failure.code === 'string' ? failure.code : ''
  const message = typeof failure.message === 'string' ? failure.message.slice(0, 8192) : ''

  // 1. Auth / context / invalid credential / unsupported exclusions first.
  if (status === 401 || status === 403 || EXCLUSION_CODE_RE.test(code)) return undefined
  if (message && CONTEXT_OVERFLOW_MESSAGE_RE.test(message)) return undefined

  // 2. Transient retries (429/408/5xx, transient codes & network messages) before budget text.
  if (status === 429 || status === 408 || (Number.isInteger(status) && status >= 500 && status <= 599)) {
    return 'transient'
  }
  if (TRANSIENT_CODE_RE.test(code)) return 'transient'
  if (message && TRANSIENT_MESSAGE_RE.test(message)) return 'transient'

  // 3. Budget / quota exhaustion.
  if (
    failure.type === 'budget_exceeded'
    || code === 'budget_exceeded'
    || code === 'QUOTA'
    || code === 'ACCOUNT_QUOTA'
    || status === 402
  ) {
    return 'budget'
  }
  if (!message) return undefined
  const brace = message.indexOf('{')
  if (brace >= 0) {
    try {
      const body = record(JSON.parse(message.slice(brace)))
      const error = record(body?.error) ?? body
      if (error && (error.type === 'budget_exceeded' || error.code === 'budget_exceeded')) {
        return 'budget'
      }
    } catch { /* fall back to text patterns */ }
  }
  if (BUDGET_TEXT_RE.test(message) || QUOTA_EXCEEDED_RE.test(message)) return 'budget'
  return undefined
}

export class RetryHealth {
  private readonly sessions = new Map<string, SessionState>()
  private readonly listeners = new Set<() => void>()

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emitChange(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* observer only */ }
    }
  }

  private settlePendingWait(state: SessionState, atTime: number): number {
    const active = state.active
    if (!active || active.waitStartedAt === undefined) return 0
    const delta = Math.max(0, atTime - active.waitStartedAt)
    active.status.accumulatedMs += delta
    state.sessionAccumulatedMs += delta
    active.waitStartedAt = undefined
    return delta
  }

  restore(sessionId: string, events: readonly RetryHealthEvent[]): void {
    const hadActive = this.sessions.get(sessionId)?.active !== undefined
    const prevKey = hadActive ? this.statusKey(this.sessions.get(sessionId)!.active!.status) : undefined
    this.sessions.delete(sessionId)
    for (const event of events) this.observeInternal(sessionId, event)
    const nextStatus = this.sessions.get(sessionId)?.active?.status
    const nextKey = nextStatus ? this.statusKey(nextStatus) : undefined
    if (prevKey !== nextKey) this.emitChange()
  }

  observe(sessionId: string, event: RetryHealthEvent): void {
    if (this.observeInternal(sessionId, event)) this.emitChange()
  }

  clear(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    const hadActive = state.active !== undefined
    state.active = undefined
    state.settled = true
    if (hadActive) this.emitChange()
  }

  remove(sessionId: string): void {
    const hadActive = this.sessions.get(sessionId)?.active !== undefined
    this.sessions.delete(sessionId)
    if (hadActive) this.emitChange()
  }

  clearAll(): void {
    let hadActive = false
    for (const state of this.sessions.values()) {
      if (state.active !== undefined) {
        hadActive = true
        break
      }
    }
    this.sessions.clear()
    if (hadActive) this.emitChange()
  }

  get(sessionId: string): RetryStatus | undefined {
    const status = this.sessions.get(sessionId)?.active?.status
    return status ? { ...status } : undefined
  }

  list(): RetryStatus[] {
    const out: RetryStatus[] = []
    for (const state of this.sessions.values()) {
      if (state.active) out.push({ ...state.active.status })
    }
    return out
  }

  accumulatedWaitMs(sessionId: string, now?: number): number {
    const state = this.sessions.get(sessionId)
    if (!state) return 0
    const open = state.active?.waitStartedAt !== undefined && now !== undefined && Number.isFinite(now)
      ? Math.max(0, now - state.active.waitStartedAt)
      : 0
    return state.sessionAccumulatedMs + open
  }

  private statusKey(status: RetryStatus): string {
    return `${status.kind}:${status.attempts}:${status.since}:${status.lastAt}:${status.accumulatedMs}:${status.provider}`
  }

  private observeInternal(sessionId: string, event: RetryHealthEvent): boolean {
    if (!ordinal(event.seq) || !validTime(event.time)) return false
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = { seq: -1, turn: -1, step: -1, ended: false, settled: false, sessionAccumulatedMs: 0 }
      this.sessions.set(sessionId, state)
    }
    if (event.seq <= state.seq) return false
    state.seq = event.seq

    const data = record(event.data)
    if (!data) return false

    const prevKey = state.active ? this.statusKey(state.active.status) : undefined

    if (event.type === 'turn/start' || event.type === 'turn/end') {
      if (!ordinal(data.turn) || data.turn < state.turn) return false
      if (data.turn > state.turn) {
        this.settlePendingWait(state, event.time)
        state.turn = data.turn
        state.step = -1
        state.ended = false
        state.settled = false
        state.active = undefined
      }
      if (event.type === 'turn/end') {
        this.settlePendingWait(state, event.time)
        state.active = undefined
        state.ended = true
      }
      return prevKey !== (state.active ? this.statusKey(state.active.status) : undefined)
    }

    if (event.type === 'llm/retry-started') {
      if (!ordinal(data.turn) || !ordinal(data.step)) return false
      if (data.turn !== state.turn || data.step !== state.step || state.ended) return false
      if (state.active && state.active.waitStartedAt !== undefined && (data.retryId === undefined || data.retryId === state.active.id)) {
        this.settlePendingWait(state, event.time)
      }
      return prevKey !== (state.active ? this.statusKey(state.active.status) : undefined)
    }

    if (!ACCEPTED_STEP_TYPES.has(event.type)) return false
    if (!ordinal(data.turn) || !ordinal(data.step)) return false
    if (data.turn < state.turn || (data.turn === state.turn && (state.ended || data.step < state.step))) {
      return false
    }

    if (event.type === 'assistant/message') {
      if (state.active && data.turn === state.turn && data.step === state.step && data.interrupted !== true) {
        const source = record(record(data.message)?.source)
        if (source?.kind === 'model' && source.provider === state.active.provider) {
          this.settlePendingWait(state, event.time)
          state.active = undefined
          state.settled = true
        }
      }
      return prevKey !== (state.active ? this.statusKey(state.active.status) : undefined)
    }

    if (data.turn > state.turn || data.step > state.step) {
      this.settlePendingWait(state, event.time)
      state.turn = data.turn
      state.step = data.step
      state.ended = false
      state.settled = false
      state.active = undefined
    }

    if (event.type === 'step/start' || state.settled) {
      return prevKey !== (state.active ? this.statusKey(state.active.status) : undefined)
    }

    if (typeof data.retryId !== 'string' || !data.retryId || typeof data.provider !== 'string') {
      return prevKey !== (state.active ? this.statusKey(state.active.status) : undefined)
    }
    if (typeof data.retry !== 'number' || !Number.isInteger(data.retry) || data.retry < 1) {
      return prevKey !== (state.active ? this.statusKey(state.active.status) : undefined)
    }

    const kind = classifyRetryFailure(data.failure)
    if (!kind) {
      this.settlePendingWait(state, event.time)
      state.active = undefined
      return prevKey !== undefined
    }

    const attempts = Math.min(data.retry, Number.MAX_SAFE_INTEGER)
    const sameChain = state.active?.id === data.retryId && state.active.provider === data.provider
    if (sameChain && attempts <= state.active!.status.attempts) return false

    if (state.active) {
      this.settlePendingWait(state, event.time)
    }

    const provider = PROVIDER_RE.test(data.provider) ? data.provider : 'unknown'
    const at = new Date(event.time).toISOString()
    const since = sameChain && state.active!.kind === kind ? state.active!.status.since : at
    const accumulatedMs = sameChain ? state.active!.status.accumulatedMs : 0

    state.active = {
      id: data.retryId,
      provider: data.provider,
      kind,
      waitStartedAt: event.time,
      status: {
        sessionId,
        provider,
        kind,
        attempts,
        since,
        lastAt: at,
        accumulatedMs,
      },
    }
    return prevKey !== this.statusKey(state.active.status)
  }
}
