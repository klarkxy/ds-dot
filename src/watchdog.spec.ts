import { describe, expect, it, vi } from 'vitest'
import type { Timer } from './batcher.ts'
import type { DotSettings, WatchdogMode } from './contracts.ts'
import type { DotTable } from './store.ts'
import {
  WATCHDOG_COOLDOWN_MS,
  WATCHDOG_PATROL_MS,
  WatchdogRunner,
  computeCalibrationStats,
  parseWatchdogVerdict,
  type WatchdogNoticeInput,
} from './watchdog.ts'
import { NO_PROGRESS_MS, SILENT_STALL_MS } from './watchdog-signals.ts'
import type { RunRecord } from './work.ts'

function memoryTable(): DotTable {
  const map = new Map<string, unknown>()
  return {
    entries: () => map.entries(),
    get: key => map.get(key),
    put: async (key, value) => { map.set(key, value) },
    delete: async key => map.delete(key),
  }
}

function fakeTimer(nowRef: { value: number }) {
  let nextId = 1
  const tasks = new Map<number, { fn: () => void; at: number }>()
  const timer: Timer = {
    set: (fn, ms) => {
      const id = nextId++
      tasks.set(id, { fn, at: nowRef.value + ms })
      return id
    },
    clear: handle => { tasks.delete(handle as number) },
    now: () => nowRef.value,
  }
  const advanceBy = async (ms: number) => {
    nowRef.value += ms
    for (const [id, task] of [...tasks.entries()]) {
      if (task.at <= nowRef.value) {
        tasks.delete(id)
        task.fn()
        await Promise.resolve()
      }
    }
  }
  return { timer, tasks, advanceBy }
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    changeId: 'chg-1',
    kind: 'work',
    inputRevision: 1,
    inputRef: 'in-1',
    stepRefs: [],
    cwd: '/w',
    workspaceRoot: '/w',
    exclusiveRoot: '/w',
    uncertainBoundary: false,
    writeScope: { kind: 'workspace-exclusive' },
    baselineRefs: [],
    requestedSessionId: 'sess-1',
    sessionId: 'sess-1',
    creation: 'confirmed',
    deliveries: [],
    phase: 'active',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function setup(opts: {
  mode?: WatchdogMode
  watchdogModel?: string
  catalogModels?: Array<{ provider: string; model: string; name: string }>
  reply?: string | (() => string | undefined)
  createThrows?: Error
  running?: boolean
} = {}) {
  const clock = { value: 0 }
  const ft = fakeTimer(clock)
  const table = memoryTable()
  const settings: Pick<DotSettings, 'watchdogMode' | 'watchdogModel'> = {
    watchdogMode: opts.mode ?? 'observe',
    ...(opts.watchdogModel !== undefined ? { watchdogModel: opts.watchdogModel } : {}),
  }
  const runs: RunRecord[] = [makeRun()]
  const notices: WatchdogNoticeInput[] = []
  const stoppedRuns: string[] = []
  const traces: Array<{ event: string; data?: unknown }> = []
  const createInternal = vi.fn(async () => {
    if (opts.createThrows) throw opts.createThrows
    return 'wd-sess-1'
  })
  const promptInternal = vi.fn(async () => {})
  const waitIdle = vi.fn(async () => {})
  const releaseInternal = vi.fn(async () => {})
  const latestReply = vi.fn(async () => typeof opts.reply === 'function' ? opts.reply() : opts.reply)
  const stop = vi.fn(async () => {})
  const runner = new WatchdogRunner({
    host: {
      createInternal,
      promptInternal,
      waitIdle,
      releaseInternal,
      latestReply,
      stop,
      isRunning: () => opts.running ?? true,
      listModels: async () => ({
        models: opts.catalogModels ?? [{ provider: 'openai', model: 'gpt-4o', name: 'GPT-4o' }],
      }),
    },
    table,
    homeDir: '/home',
    now: () => clock.value,
    timer: ft.timer,
    settings: () => settings,
    runs: () => runs,
    sessionRun: id => runs.find(r => (r.sessionId ?? r.requestedSessionId) === id),
    change: id => ({ id, title: 'Test Change', cwd: '/w', baselineRefs: [], currentRevision: 1, currentInputRef: 'in-1', control: 'open', steps: [], maxConcurrentRuns: 1, priority: 2, createdAt: 0, updatedAt: 0 }),
    input: id => ({ id, changeId: 'chg-1', revision: 1, goal: 'Implement feature', requirements: [], steps: [], source: 'user', createdAt: 0 }),
    isQuietWaitActive: () => false,
    pendingWaitIntervals: () => [],
    hasOpenPending: () => false,
    retryStatus: () => undefined,
    stopRun: async run => {
      stoppedRuns.push(run.id)
      return true
    },
    notifyDorothy: n => { notices.push(n) },
    trace: t => { traces.push({ event: t.event, data: t.data }) },
  })
  return {
    clock,
    ft,
    table,
    settings,
    runs,
    notices,
    stoppedRuns,
    traces,
    createInternal,
    promptInternal,
    releaseInternal,
    runner,
  }
}

describe('WatchdogRunner', () => {
  it('validates judge JSON with strict zod schema', () => {
    expect(parseWatchdogVerdict('{"verdict":"spinning","confidence":"high","summary":"stuck","evidence":["4 calls"]}')).toEqual({
      verdict: 'spinning', confidence: 'high', summary: 'stuck', evidence: ['4 calls'],
    })
    expect(parseWatchdogVerdict('```json\n{"verdict":"progressing","confidence":"medium","summary":"ok","evidence":[]}\n```')).toEqual({
      verdict: 'progressing', confidence: 'medium', summary: 'ok', evidence: [],
    })
    expect(parseWatchdogVerdict('{"verdict":"unknown","confidence":"high","summary":"x","evidence":[]}')).toBeUndefined()
    expect(parseWatchdogVerdict('{"verdict":"spinning","confidence":"high","summary":"x","evidence":[],"extra":1}')).toBeUndefined()
  })

  it('in observe mode (default) records deterministic hits and trace with ZERO judge model calls', async () => {
    const h = setup({ mode: 'observe' })
    for (let i = 1; i <= 4; i++) {
      h.clock.value = i * 1000
      h.runner.onSessionEvent('sess-1', {
        type: 'tool/call',
        time: h.clock.value,
        data: { callId: `c-${i}`, name: 'read_file', arguments: '{"path":"a.ts"}' },
      })
    }
    await h.runner.flushJudge()
    expect(h.createInternal).not.toHaveBeenCalled()
    expect(h.promptInternal).not.toHaveBeenCalled()
    expect(h.runner.diagnosticsView().hits).toHaveLength(1)
    expect(h.runner.diagnosticsView().hits[0]).toMatchObject({ signal: 'repeat-tool-call', mode: 'observe' })
    expect(h.traces.some(t => t.event === 'watchdog.hit')).toBe(true)
    expect(h.stoppedRuns).toEqual([])
  })

  it('in off mode stays completely inactive', async () => {
    const h = setup({ mode: 'off' })
    h.runner.start()
    expect(h.ft.tasks.size).toBe(0)
    for (let i = 1; i <= 4; i++) {
      h.runner.onSessionEvent('sess-1', {
        type: 'tool/call',
        time: i * 1000,
        data: { callId: `c-${i}`, name: 'read_file', arguments: '{"path":"a.ts"}' },
      })
    }
    expect(await h.runner.patrolNow()).toEqual([])
    expect(h.runner.diagnosticsView().hits).toEqual([])
  })

  it('enforces 10-min cooldown, resets consecutive spinning on progressing, stops on 2nd high-confidence spinning, and triggers human circuit-breaker on 2nd auto-stop', async () => {
    let verdictReply = JSON.stringify({ verdict: 'spinning', confidence: 'high', summary: 'stuck in loop', evidence: ['same call x4'] })
    const h = setup({ mode: 'auto', reply: () => verdictReply })

    // 1st hit at t=10s -> judge runs -> 1st high spinning alerts Dorothy, does NOT stop
    h.clock.value = 10_000
    for (let i = 1; i <= 4; i++) {
      h.runner.onSessionEvent('sess-1', { type: 'tool/call', time: 10_000, data: { callId: `a-${i}`, name: 'grep', arguments: '{"q":"x"}' } })
    }
    await h.runner.flushJudge()
    expect(h.createInternal).toHaveBeenCalledTimes(1)
    expect(h.createInternal).toHaveBeenCalledWith('/home', 'dot-watchdog', { allow: [], model: null })
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]!.humanRequired).toBeUndefined()
    expect(h.stoppedRuns).toEqual([])

    // Within 10-min cooldown -> judge NOT called again
    h.clock.value = 60_000
    for (let i = 1; i <= 3; i++) {
      h.runner.onSessionEvent('sess-1', { type: 'tool/result', time: 60_000, data: { turn: 1, message: { toolCallId: `e-${i}`, isError: true, content: 'boom' } } })
    }
    await h.runner.flushJudge()
    expect(h.createInternal).toHaveBeenCalledTimes(1)

    // After cooldown -> progressing resets consecutive count
    h.clock.value = 10_000 + WATCHDOG_COOLDOWN_MS + 1000
    verdictReply = JSON.stringify({ verdict: 'progressing', confidence: 'high', summary: 'actually making progress', evidence: ['new files'] })
    await h.runner.patrolNow()
    // Advance past NO_PROGRESS_MS so patrol fires no-progress
    h.clock.value = NO_PROGRESS_MS + WATCHDOG_COOLDOWN_MS + 2000
    await h.runner.patrolNow()
    expect(h.createInternal).toHaveBeenCalledTimes(2)
    expect(h.stoppedRuns).toEqual([])

    // Now two consecutive high-confidence spinning verdicts across cooldowns -> auto-stop #1
    verdictReply = JSON.stringify({ verdict: 'spinning', confidence: 'high', summary: 'still spinning', evidence: ['no writes'] })
    h.clock.value += WATCHDOG_COOLDOWN_MS + 1000
    await h.runner.patrolNow()
    expect(h.createInternal).toHaveBeenCalledTimes(3)
    expect(h.stoppedRuns).toEqual([])

    h.clock.value += WATCHDOG_COOLDOWN_MS + 1000
    await h.runner.patrolNow()
    expect(h.createInternal).toHaveBeenCalledTimes(4)
    expect(h.stoppedRuns).toEqual(['run-1'])
    expect(h.runner.diagnosticsView().watchdogStops).toBe(1)

    // 2nd auto-stop on the same run (via single-turn >=8 error hard cap) -> human circuit-breaker card!
    h.runner.onSessionEvent('sess-1', { type: 'turn/start', time: h.clock.value + 100, data: { turn: 5 } })
    for (let i = 1; i <= 8; i++) {
      h.runner.onSessionEvent('sess-1', { type: 'tool/result', time: h.clock.value + 100 + i, data: { turn: 5, message: { toolCallId: `h-${i}`, isError: true, content: 'fatal' } } })
    }
    await h.runner.flushJudge()
    expect(h.stoppedRuns).toEqual(['run-1', 'run-1'])
    expect(h.runner.diagnosticsView().watchdogStops).toBe(2)
    expect(h.notices.at(-1)?.humanRequired).toBe(true)
  })

  it('silently falls back to deterministic-only and records fallback notice when watchdogModel is unavailable', async () => {
    const h = setup({ mode: 'auto', watchdogModel: 'missing/model', catalogModels: [{ provider: 'openai', model: 'gpt-4o', name: 'GPT-4o' }] })
    h.clock.value = SILENT_STALL_MS + 1000
    await h.runner.patrolNow()
    expect(h.createInternal).not.toHaveBeenCalled()
    expect(h.runner.diagnosticsView().modelFallbackNotice).toMatchObject({
      configuredModel: 'missing/model',
      reason: 'not-in-catalog',
    })
    expect(h.traces.some(t => t.event === 'watchdog.fallback')).toBe(true)
  })

  it('never stops run on intermittent infra-failure and cleans 5-min patrol timer on dispose', async () => {
    const h = setup({ mode: 'auto' })
    h.runner.start()
    expect(h.ft.tasks.size).toBe(1)

    h.clock.value = 1000
    h.runner.onSessionEvent('sess-1', { type: 'turn/end', time: 1000, data: { turn: 1, reason: { kind: 'error', error: { message: '503' } } } })
    h.runner.onSessionEvent('sess-1', { type: 'turn/end', time: 2000, data: { turn: 2, reason: { kind: 'error', error: { message: '503' } } } })
    await h.runner.flushJudge()
    expect(h.stoppedRuns).toEqual([])
    expect(h.createInternal).not.toHaveBeenCalled()

    await h.ft.advanceBy(WATCHDOG_PATROL_MS)
    expect(h.stoppedRuns).toEqual([])

    // Recovery clears infra failure
    h.runner.onSessionEvent('sess-1', { type: 'assistant/message', time: WATCHDOG_PATROL_MS + 1000, data: {} })
    await h.runner.dispose()
    expect(h.ft.tasks.size).toBe(0)
  })

  it('computes 14-day calibration metrics and annotations accurately (null FP rate when 0 reviewed)', async () => {
    const h = setup({ mode: 'observe' })
    h.clock.value = 20 * 86_400_000
    for (let i = 1; i <= 4; i++) {
      h.runner.onSessionEvent('sess-1', { type: 'tool/call', time: h.clock.value, data: { callId: `c-${i}`, name: 'read_file', arguments: '{}' } })
    }
    await h.runner.flushJudge()
    const hitId = h.runner.diagnosticsView().hits[0]!.id
    expect(h.runner.diagnosticsView().calibration).toEqual({
      windowDays: 14,
      total14d: 1,
      reviewed14d: 0,
      accurate14d: 0,
      falsePositive14d: 0,
      falsePositiveRate: null,
    })

    await h.runner.annotateHit(hitId, 'false-positive')
    expect(h.runner.diagnosticsView().calibration).toEqual({
      windowDays: 14,
      total14d: 1,
      reviewed14d: 1,
      accurate14d: 0,
      falsePositive14d: 1,
      falsePositiveRate: 1,
    })

    const stats = computeCalibrationStats([
      { id: 'old', at: 1000, runId: 'r', changeId: 'c', inputRef: 'i', inputRevision: 1, sessionId: 's', signal: 'no-progress', runPhase: 'active', mode: 'observe', evidence: [], annotation: 'false-positive' },
    ], 20 * 86_400_000)
    expect(stats.total14d).toBe(0)
    expect(stats.falsePositiveRate).toBeNull()
  })
})
