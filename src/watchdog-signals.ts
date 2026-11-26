import { createHash } from 'node:crypto'
import { mcpToolMayWrite } from './approval-risk.ts'
import { textOf, toolResultFailed } from './chat.ts'
import type { WatchdogSignalType } from './contracts.ts'
import type { WaitInterval } from './pending.ts'

export const NO_PROGRESS_MS = 15 * 60_000
export const BUDGET_STALL_MS = 15 * 60_000
export const SILENT_STALL_MS = 10 * 60_000
export const REPEAT_TOOL_CALL_THRESHOLD = 4
export const REPEAT_TOOL_ERROR_THRESHOLD = 3
export const SINGLE_TURN_ERROR_HARD_LIMIT = 8
export const COMPACTION_LOOP_THRESHOLD = 2
export const INFRA_API_ERROR_THRESHOLD = 2

const MAX_RECENT_CALLS = 200
const MAX_SEEN_COMPACTIONS = 100
const MAX_WAIT_INTERVALS = 300

const WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'patch',
  'create_file',
  'delete_file',
  'remove_file',
  'move_file',
  'rename_file',
  'notebook_edit',
])

const SHELL_TOOLS = new Set([
  'bash',
  'shell',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'cmd',
  'exec',
  'terminal',
  'run_command',
])

const TEST_COMMAND_RE = /(?:^|[;&|\n]\s*)(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|(?:npx|pnpm|pnpx|yarn|bunx)\s+(?:vitest|jest|mocha|ava|tap)\b|(?:vitest|pytest|py\.test|jest|mocha|ctest|ava|rspec|phpunit)\b|python(?:3)?\s+-m\s+(?:pytest|unittest)\b|(?:cargo|go|dotnet|mix|zig)\s+test\b|(?:mvn|gradle|\.\/gradlew)\s+test\b)/i

export interface WatchdogSessionEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
}

export interface RunSignalContext {
  readonly runId: string
  readonly changeId: string
  readonly inputRef: string
  readonly inputRevision: number
  readonly sessionId: string
  readonly phase: string
  readonly startedAt: number
}

export interface WatchdogSignalHit {
  readonly signal: WatchdogSignalType
  readonly runKey: string
  readonly runId: string
  readonly changeId: string
  readonly inputRef: string
  readonly inputRevision: number
  readonly sessionId: string
  readonly at: number
  readonly evidence: readonly string[]
  readonly hardLimitReached?: boolean
  readonly detail?: string
}

export interface ObserveEventResult {
  readonly hits: readonly WatchdogSignalHit[]
  readonly substantiveProgress: boolean
  readonly recovered: boolean
}

export interface PatrolCheckInput {
  readonly run: RunSignalContext
  readonly agentStatus: 'running' | 'idle' | 'unknown'
  readonly now: number
  readonly quietWaitActive?: boolean
  readonly pendingWaitIntervals?: readonly WaitInterval[]
  readonly hasOpenPending?: boolean
  readonly retryStatus?: { readonly kind: 'budget' | 'transient'; readonly since: string; readonly accumulatedMs?: number }
}

interface RecentCall {
  readonly name: string
  readonly command?: string
}

export interface RunSignalState {
  readonly runKey: string
  readonly run: RunSignalContext
  lastToolName?: string
  lastToolArgsHash?: string
  repeatToolCallCount: number
  lastErrorFingerprint?: string
  repeatErrorCount: number
  currentTurn: number
  currentErrorTurn: number
  turnErrorFingerprint?: string
  turnErrorCount: number
  lastProgressAt: number
  lastEventAt: number
  readonly seenCompactionIds: Set<string>
  compactionsSinceProgress: number
  readonly recentCalls: Map<string, RecentCall>
  lastShellCommand?: string
  quietWaitIntervals: WaitInterval[]
  quietWaitOpenAt?: number
  retryWaitIntervals: WaitInterval[]
  retryWaitOpenAt?: number
  retryStatus?: { readonly kind: 'budget' | 'transient'; readonly since: string }
  consecutiveApiErrors: number
  infraFailure?: { readonly subtype: 'host-api-error' | 'reconcile-failed' | 'stream-disconnect'; readonly detail: string; readonly at: number }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function runRevisionKey(runId: string, inputRevision: number): string {
  return `${runId}@${inputRevision}`
}

/** Recursively serialize JSON with sorted object keys while preserving array order. */
export function canonicalJsonString(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonicalJsonString(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonString(v)}`).join(',')}}`
}

/** Compute canonical normalized SHA-256 hex digest for tool call arguments. */
export function toolCallArgsHash(rawArgs: unknown): string {
  let normalized: string
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim()
    if (!trimmed) {
      normalized = ''
    } else {
      try {
        normalized = canonicalJsonString(JSON.parse(trimmed))
      } catch {
        normalized = trimmed
      }
    }
  } else if (rawArgs !== undefined) {
    normalized = canonicalJsonString(rawArgs)
  } else {
    normalized = ''
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/** Extract normalized first non-empty error line (trimmed, max 200 chars, lowercase). */
export function errorFingerprint(data: Record<string, unknown>): string {
  const errObj = asRecord(data.error)
  const msgObj = asRecord(data.message)
  const reason = typeof errObj?.reason === 'string' && errObj.reason.trim()
    ? errObj.reason
    : typeof errObj?.message === 'string' && errObj.message.trim()
      ? errObj.message
      : undefined
  const raw = reason ?? textOf(msgObj?.content)
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.slice(0, 200).toLowerCase()
  }
  const code = typeof errObj?.code === 'string' && errObj.code.trim() ? errObj.code.trim() : 'tool-error'
  return code.slice(0, 200).toLowerCase()
}

export function isWriteOrEditTool(name: string): boolean {
  const lower = name.trim().toLowerCase()
  if (!lower) return false
  return WRITE_TOOLS.has(lower) || mcpToolMayWrite(name)
}

export function extractShellCommand(rawArgs: unknown): string {
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim()
    try {
      const parsed = asRecord(JSON.parse(trimmed))
      if (parsed) {
        const cmd = parsed.command ?? parsed.cmd ?? parsed.script ?? parsed.CommandLine
        if (typeof cmd === 'string') return cmd
      }
    } catch {
      return trimmed
    }
    return trimmed
  }
  const obj = asRecord(rawArgs)
  if (!obj) return ''
  const cmd = obj.command ?? obj.cmd ?? obj.script ?? obj.CommandLine
  return typeof cmd === 'string' ? cmd : ''
}

export function isTestRunnerCommand(toolName: string, commandText: string): boolean {
  if (!SHELL_TOOLS.has(toolName.trim().toLowerCase())) return false
  return TEST_COMMAND_RE.test(commandText)
}

/** Merge overlapping `[start, end]` intervals clipped to `[since, now]` and return union duration in ms. */
export function unionWaitMs(intervals: readonly WaitInterval[], since: number, now: number): number {
  if (!Number.isFinite(since) || !Number.isFinite(now) || now <= since) return 0
  const clipped: Array<{ start: number; end: number }> = []
  for (const item of intervals) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end)) continue
    const start = Math.max(since, item.start)
    const end = Math.min(now, item.end)
    if (end > start) clipped.push({ start, end })
  }
  if (clipped.length === 0) return 0
  clipped.sort((a, b) => a.start - b.start || a.end - b.end)
  let total = 0
  let curStart = clipped[0]!.start
  let curEnd = clipped[0]!.end
  for (let i = 1; i < clipped.length; i++) {
    const next = clipped[i]!
    if (next.start <= curEnd) {
      if (next.end > curEnd) curEnd = next.end
    } else {
      total += curEnd - curStart
      curStart = next.start
      curEnd = next.end
    }
  }
  total += curEnd - curStart
  return total
}

function pushInterval(list: WaitInterval[], start: number, end: number): void {
  const safeEnd = Math.max(start, end)
  if (safeEnd <= start) return
  list.push({ start, end: safeEnd })
  if (list.length > MAX_WAIT_INTERVALS) {
    list.splice(0, list.length - MAX_WAIT_INTERVALS)
  }
}

function pruneIntervalsBefore(list: WaitInterval[], cutoff: number): WaitInterval[] {
  const kept: WaitInterval[] = []
  for (const item of list) {
    if (item.end <= cutoff) continue
    kept.push(item.start < cutoff ? { start: cutoff, end: item.end } : item)
  }
  return kept
}

export class WatchdogSignalDetector {
  private readonly states = new Map<string, RunSignalState>()

  ensureRun(run: RunSignalContext): RunSignalState {
    const key = runRevisionKey(run.runId, run.inputRevision)
    const existing = this.states.get(key)
    if (existing) {
      this.states.set(key, { ...existing, run })
      return this.states.get(key)!
    }
    const created: RunSignalState = {
      runKey: key,
      run,
      repeatToolCallCount: 0,
      repeatErrorCount: 0,
      currentTurn: 0,
      currentErrorTurn: -1,
      turnErrorCount: 0,
      lastProgressAt: run.startedAt,
      lastEventAt: run.startedAt,
      seenCompactionIds: new Set(),
      compactionsSinceProgress: 0,
      recentCalls: new Map(),
      quietWaitIntervals: [],
      retryWaitIntervals: [],
      consecutiveApiErrors: 0,
    }
    this.states.set(key, created)
    return created
  }

  getState(runId: string, inputRevision: number): RunSignalState | undefined {
    return this.states.get(runRevisionKey(runId, inputRevision))
  }

  deleteRun(runId: string, inputRevision?: number): void {
    if (inputRevision !== undefined) {
      this.states.delete(runRevisionKey(runId, inputRevision))
      return
    }
    const prefix = `${runId}@`
    for (const key of [...this.states.keys()]) {
      if (key.startsWith(prefix)) this.states.delete(key)
    }
  }

  clear(): void {
    this.states.clear()
  }

  noteQuietWait(run: RunSignalContext, active: boolean, at: number): void {
    const state = this.ensureRun(run)
    if (active) {
      if (state.quietWaitOpenAt === undefined) state.quietWaitOpenAt = at
    } else if (state.quietWaitOpenAt !== undefined) {
      pushInterval(state.quietWaitIntervals, state.quietWaitOpenAt, at)
      state.quietWaitOpenAt = undefined
    }
  }

  noteRetryState(
    run: RunSignalContext,
    status: { readonly kind: 'budget' | 'transient'; readonly since: string } | undefined,
    at: number,
  ): void {
    const state = this.ensureRun(run)
    if (status) {
      state.retryStatus = status
      if (state.retryWaitOpenAt === undefined) {
        const sinceMs = Date.parse(status.since)
        state.retryWaitOpenAt = Number.isFinite(sinceMs) ? Math.min(at, sinceMs) : at
      }
    } else {
      state.retryStatus = undefined
      if (state.retryWaitOpenAt !== undefined) {
        pushInterval(state.retryWaitIntervals, state.retryWaitOpenAt, at)
        state.retryWaitOpenAt = undefined
      }
    }
  }

  noteAgentError(run: RunSignalContext, detail: string, at: number): WatchdogSignalHit | undefined {
    const state = this.ensureRun(run)
    state.consecutiveApiErrors += 1
    if (state.consecutiveApiErrors >= INFRA_API_ERROR_THRESHOLD) {
      state.infraFailure = { subtype: 'host-api-error', detail: detail || 'host agent error', at }
      return this.makeHit(state, 'infra-failure', at, [
        `subtype=host-api-error`,
        `consecutiveApiErrors=${state.consecutiveApiErrors}`,
        `detail=${(detail || 'agent/error').slice(0, 200)}`,
      ], false, state.infraFailure.detail)
    }
    return undefined
  }

  noteInfraFailure(
    run: RunSignalContext,
    subtype: 'host-api-error' | 'reconcile-failed' | 'stream-disconnect',
    detail: string,
    at: number,
  ): WatchdogSignalHit {
    const state = this.ensureRun(run)
    state.infraFailure = { subtype, detail: detail || subtype, at }
    return this.makeHit(state, 'infra-failure', at, [
      `subtype=${subtype}`,
      `detail=${(detail || subtype).slice(0, 200)}`,
    ], false, state.infraFailure.detail)
  }

  noteInfraRecovered(run: RunSignalContext): boolean {
    const state = this.states.get(runRevisionKey(run.runId, run.inputRevision))
    if (!state) return false
    const had = state.infraFailure !== undefined || state.consecutiveApiErrors > 0
    state.infraFailure = undefined
    state.consecutiveApiErrors = 0
    return had
  }

  observeEvent(run: RunSignalContext, event: WatchdogSessionEvent, now = event.time ?? Date.now()): ObserveEventResult {
    const state = this.ensureRun(run)
    const eventTime = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : now
    if (eventTime > state.lastEventAt) state.lastEventAt = eventTime
    const data = asRecord(event.data) ?? {}
    const hits: WatchdogSignalHit[] = []
    let substantiveProgress = false
    let recovered = false

    if (event.type === 'turn/start') {
      const turn = typeof data.turn === 'number' ? data.turn : state.currentTurn + 1
      state.currentTurn = turn
      state.currentErrorTurn = turn
      state.turnErrorCount = 0
      state.turnErrorFingerprint = undefined
      return { hits, substantiveProgress, recovered }
    }

    if (event.type === 'turn/end') {
      if (state.retryWaitOpenAt !== undefined) {
        pushInterval(state.retryWaitIntervals, state.retryWaitOpenAt, eventTime)
        state.retryWaitOpenAt = undefined
      }
      const reason = asRecord(data.reason)
      if (reason?.kind === 'error') {
        const err = asRecord(reason.error)
        const msg = typeof err?.message === 'string' ? err.message : typeof err?.code === 'string' ? err.code : 'turn ended with error'
        const hit = this.noteAgentError(run, msg, eventTime)
        if (hit) hits.push(hit)
      } else {
        if (state.infraFailure || state.consecutiveApiErrors > 0) recovered = true
        state.consecutiveApiErrors = 0
        state.infraFailure = undefined
      }
      return { hits, substantiveProgress, recovered }
    }

    if (event.type === 'assistant/message') {
      if (state.retryWaitOpenAt !== undefined) {
        pushInterval(state.retryWaitIntervals, state.retryWaitOpenAt, eventTime)
        state.retryWaitOpenAt = undefined
      }
      if (state.infraFailure || state.consecutiveApiErrors > 0) recovered = true
      state.consecutiveApiErrors = 0
      state.infraFailure = undefined
      return { hits, substantiveProgress, recovered }
    }

    if (event.type === 'llm/retry') {
      if (state.retryWaitOpenAt === undefined) state.retryWaitOpenAt = eventTime
      return { hits, substantiveProgress, recovered }
    }

    if (event.type === 'llm/retry-started') {
      if (state.retryWaitOpenAt !== undefined) {
        pushInterval(state.retryWaitIntervals, state.retryWaitOpenAt, eventTime)
        state.retryWaitOpenAt = undefined
      }
      return { hits, substantiveProgress, recovered }
    }

    if (event.type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name.trim() : ''
      if (!name) return { hits, substantiveProgress, recovered }
      const callId = typeof data.callId === 'string' ? data.callId : ''
      const command = SHELL_TOOLS.has(name.toLowerCase()) ? extractShellCommand(data.arguments) : undefined
      if (command !== undefined) {
        state.lastShellCommand = command
      }
      if (callId) {
        state.recentCalls.set(callId, { name, ...(command !== undefined ? { command } : {}) })
        if (state.recentCalls.size > MAX_RECENT_CALLS) {
          const oldest = state.recentCalls.keys().next().value
          if (oldest !== undefined) state.recentCalls.delete(oldest)
        }
      }
      const argsHash = toolCallArgsHash(data.arguments)
      if (state.lastToolName === name && state.lastToolArgsHash === argsHash) {
        state.repeatToolCallCount += 1
      } else {
        state.lastToolName = name
        state.lastToolArgsHash = argsHash
        state.repeatToolCallCount = 1
      }
      if (state.repeatToolCallCount >= REPEAT_TOOL_CALL_THRESHOLD) {
        hits.push(this.makeHit(state, 'repeat-tool-call', eventTime, [
          `tool=${name}`,
          `consecutive=${state.repeatToolCallCount}`,
          `argsSha256=${argsHash.slice(0, 16)}`,
        ]))
      }
      return { hits, substantiveProgress, recovered }
    }

    if (event.type === 'tool/result') {
      const msgObj = asRecord(data.message)
      const callId = typeof msgObj?.toolCallId === 'string'
        ? msgObj.toolCallId
        : typeof data.callId === 'string'
          ? data.callId
          : ''
      const callInfo = callId ? state.recentCalls.get(callId) : undefined
      const toolName = callInfo?.name ?? (typeof data.name === 'string' ? data.name : typeof msgObj?.toolName === 'string' ? msgObj.toolName : '')
      const isShellTool = SHELL_TOOLS.has(toolName.trim().toLowerCase())
      const argCommand = extractShellCommand(data.arguments)
      const shellCommand = callInfo
        ? callInfo.command
        : !callId && isShellTool
          ? (argCommand || state.lastShellCommand)
          : undefined
      if (callInfo?.command !== undefined && state.lastShellCommand === callInfo.command) {
        state.lastShellCommand = undefined
      } else if (!callId && isShellTool) {
        state.lastShellCommand = undefined
      }

      const failed = toolResultFailed(data)
      if (failed) {
        const fp = errorFingerprint(data)
        if (state.lastErrorFingerprint === fp) state.repeatErrorCount += 1
        else {
          state.lastErrorFingerprint = fp
          state.repeatErrorCount = 1
        }
        const turn = typeof data.turn === 'number' ? data.turn : state.currentTurn
        if (turn !== state.currentErrorTurn) {
          state.currentErrorTurn = turn
          state.turnErrorFingerprint = fp
          state.turnErrorCount = 1
        } else if (state.turnErrorFingerprint === fp) {
          state.turnErrorCount += 1
        } else {
          state.turnErrorFingerprint = fp
          state.turnErrorCount = 1
        }
        const hardLimit = state.turnErrorCount >= SINGLE_TURN_ERROR_HARD_LIMIT
        if (state.repeatErrorCount >= REPEAT_TOOL_ERROR_THRESHOLD || hardLimit) {
          hits.push(this.makeHit(state, 'repeat-tool-error', eventTime, [
            `consecutive=${state.repeatErrorCount}`,
            `turnConsecutive=${state.turnErrorCount}`,
            `fingerprint=${fp}`,
          ], hardLimit))
        }
        return { hits, substantiveProgress, recovered }
      }

      // Successful tool/result resets consecutive error streaks.
      state.repeatErrorCount = 0
      state.lastErrorFingerprint = undefined
      state.turnErrorCount = 0
      state.turnErrorFingerprint = undefined

      const isWrite = toolName ? isWriteOrEditTool(toolName) : false
      const isTest = toolName && shellCommand !== undefined
        ? isTestRunnerCommand(toolName, shellCommand)
        : false
      const isPeer = toolName.trim().toLowerCase() === 'dot_peer'

      if (isWrite || isTest || isPeer) {
        substantiveProgress = true
        if (eventTime > state.lastProgressAt) {
          state.lastProgressAt = eventTime
          state.quietWaitIntervals = pruneIntervalsBefore(state.quietWaitIntervals, eventTime)
          if (state.quietWaitOpenAt !== undefined && state.quietWaitOpenAt < eventTime) state.quietWaitOpenAt = eventTime
          state.retryWaitIntervals = pruneIntervalsBefore(state.retryWaitIntervals, eventTime)
          if (state.retryWaitOpenAt !== undefined && state.retryWaitOpenAt < eventTime) state.retryWaitOpenAt = eventTime
        }
        if (isWrite || isTest) state.compactionsSinceProgress = 0
      }
      return { hits, substantiveProgress, recovered }
    }

    if (event.type === 'compaction/summary' || event.type === 'compaction/end') {
      if (event.type === 'compaction/end' && typeof data.error === 'string' && data.error.trim()) {
        return { hits, substantiveProgress, recovered }
      }
      if (event.type === 'compaction/end' && data.error !== undefined && data.error !== null && data.error !== '') {
        return { hits, substantiveProgress, recovered }
      }
      const compactionId = typeof data.compactionId === 'string' && data.compactionId.trim()
        ? data.compactionId.trim()
        : `${event.type}:${event.seq ?? eventTime}`
      if (!state.seenCompactionIds.has(compactionId)) {
        state.seenCompactionIds.add(compactionId)
        if (state.seenCompactionIds.size > MAX_SEEN_COMPACTIONS) {
          const oldest = state.seenCompactionIds.values().next().value
          if (oldest !== undefined) state.seenCompactionIds.delete(oldest)
        }
        state.compactionsSinceProgress += 1
        if (state.compactionsSinceProgress >= COMPACTION_LOOP_THRESHOLD) {
          hits.push(this.makeHit(state, 'compaction-loop', eventTime, [
            `compactions=${state.compactionsSinceProgress}`,
            `compactionId=${compactionId}`,
          ]))
        }
      }
      return { hits, substantiveProgress, recovered }
    }

    return { hits, substantiveProgress, recovered }
  }

  evaluatePatrol(input: PatrolCheckInput): WatchdogSignalHit[] {
    const state = this.ensureRun(input.run)
    const now = input.now
    const hits: WatchdogSignalHit[] = []

    const quietActive = input.quietWaitActive === true || state.quietWaitOpenAt !== undefined
    const retryStatus = input.retryStatus ?? state.retryStatus
    const retryActive = retryStatus !== undefined || state.retryWaitOpenAt !== undefined
    const pendingActive = input.hasOpenPending === true

    const allIntervals: WaitInterval[] = [
      ...state.quietWaitIntervals,
      ...(state.quietWaitOpenAt !== undefined
        ? [{ start: state.quietWaitOpenAt, end: Math.max(state.quietWaitOpenAt, now) }]
        : input.quietWaitActive
          ? [{ start: state.lastProgressAt, end: Math.max(state.lastProgressAt, now) }]
          : []),
      ...state.retryWaitIntervals,
      ...(state.retryWaitOpenAt !== undefined
        ? [{ start: state.retryWaitOpenAt, end: Math.max(state.retryWaitOpenAt, now) }]
        : retryStatus
          ? [{ start: Number.isFinite(Date.parse(retryStatus.since)) ? Date.parse(retryStatus.since) : state.lastProgressAt, end: now }]
          : []),
      ...(input.pendingWaitIntervals ?? []),
    ]

    // Signal 3: Net active time without progress (open active run)
    if (input.run.phase === 'active') {
      const totalElapsedMs = Math.max(0, now - state.lastProgressAt)
      const deductedMs = unionWaitMs(allIntervals, state.lastProgressAt, now)
      const netActiveMs = Math.max(0, totalElapsedMs - deductedMs)
      if (netActiveMs >= NO_PROGRESS_MS) {
        hits.push(this.makeHit(state, 'no-progress', now, [
          `netActiveMs=${Math.round(netActiveMs)}`,
          `totalElapsedMs=${Math.round(totalElapsedMs)}`,
          `deductedWaitMs=${Math.round(deductedMs)}`,
        ]))
      }
    }

    // Signal 5: Persistent budget retry >= 15 min
    if (retryStatus?.kind === 'budget') {
      const sinceMs = Date.parse(retryStatus.since)
      if (Number.isFinite(sinceMs) && now - sinceMs >= BUDGET_STALL_MS) {
        hits.push(this.makeHit(state, 'budget-retry-stall', now, [
          `since=${retryStatus.since}`,
          `elapsedMs=${Math.round(now - sinceMs)}`,
        ]))
      }
    }

    // Signal 6: Silent stall (open active run, live agent status running, not waiting, 0 events >= 10 min)
    if (input.run.phase === 'active' && input.agentStatus === 'running' && !quietActive && !pendingActive && !retryActive) {
      const silentElapsed = Math.max(0, now - state.lastEventAt)
      const waitSinceEvent = unionWaitMs(allIntervals, state.lastEventAt, now)
      const netSilentMs = Math.max(0, silentElapsed - waitSinceEvent)
      if (netSilentMs >= SILENT_STALL_MS) {
        hits.push(this.makeHit(state, 'silent-stall', now, [
          `silentMs=${Math.round(netSilentMs)}`,
          `lastEventAt=${state.lastEventAt}`,
        ]))
      }
    }

    // Signal 7: Sustained infra failure
    if (state.infraFailure) {
      hits.push(this.makeHit(state, 'infra-failure', now, [
        `subtype=${state.infraFailure.subtype}`,
        `detail=${state.infraFailure.detail.slice(0, 200)}`,
      ], false, state.infraFailure.detail))
    } else if (retryStatus?.kind === 'transient') {
      const sinceMs = Date.parse(retryStatus.since)
      if (Number.isFinite(sinceMs) && now - sinceMs >= NO_PROGRESS_MS) {
        hits.push(this.makeHit(state, 'infra-failure', now, [
          `subtype=host-api-error`,
          `transientRetryMs=${Math.round(now - sinceMs)}`,
        ], false, 'sustained transient retry'))
      }
    }

    return hits
  }

  private makeHit(
    state: RunSignalState,
    signal: WatchdogSignalType,
    at: number,
    evidence: readonly string[],
    hardLimitReached = false,
    detail?: string,
  ): WatchdogSignalHit {
    return {
      signal,
      runKey: state.runKey,
      runId: state.run.runId,
      changeId: state.run.changeId,
      inputRef: state.run.inputRef,
      inputRevision: state.run.inputRevision,
      sessionId: state.run.sessionId,
      at,
      evidence,
      ...(hardLimitReached ? { hardLimitReached: true } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
  }
}
