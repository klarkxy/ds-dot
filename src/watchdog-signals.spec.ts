import { describe, expect, it } from 'vitest'
import {
  BUDGET_STALL_MS,
  NO_PROGRESS_MS,
  SILENT_STALL_MS,
  WatchdogSignalDetector,
  canonicalJsonString,
  errorFingerprint,
  toolCallArgsHash,
  unionWaitMs,
  type RunSignalContext,
} from './watchdog-signals.ts'

function runCtx(overrides: Partial<RunSignalContext> = {}): RunSignalContext {
  return {
    runId: 'run-1',
    changeId: 'chg-1',
    inputRef: 'in-1',
    inputRevision: 1,
    sessionId: 'sess-1',
    phase: 'active',
    startedAt: 0,
    ...overrides,
  }
}

describe('WatchdogSignalDetector', () => {
  it('detects Signal 1 (repeat-tool-call) using canonical JSON SHA-256 and resets on different tool or args', () => {
    const detector = new WatchdogSignalDetector()
    const run = runCtx()

    // Key order differs, array order preserved -> identical canonical hash
    expect(canonicalJsonString({ b: 1, a: { d: 2, c: [3, 4] } })).toBe('{"a":{"c":[3,4],"d":2},"b":1}')
    expect(toolCallArgsHash('{"b":1,"a":{"d":2,"c":3}}')).toBe(toolCallArgsHash('{"a":{"c":3,"d":2},"b":1}'))
    expect(toolCallArgsHash('{"arr":[1,2]}')).not.toBe(toolCallArgsHash('{"arr":[2,1]}'))

    for (let i = 1; i <= 3; i++) {
      const res = detector.observeEvent(run, {
        type: 'tool/call',
        time: i * 1000,
        data: { callId: `c-${i}`, name: 'read_file', arguments: i % 2 === 0 ? '{"a":1,"b":2}' : '{"b":2,"a":1}' },
      })
      expect(res.hits).toEqual([])
    }
    const fourth = detector.observeEvent(run, {
      type: 'tool/call',
      time: 4000,
      data: { callId: 'c-4', name: 'read_file', arguments: '{"a":1,"b":2}' },
    })
    expect(fourth.hits).toHaveLength(1)
    expect(fourth.hits[0]).toMatchObject({ signal: 'repeat-tool-call', runKey: 'run-1@1' })

    // Different tool resets streak; malformed JSON falls back to trimmed raw string
    detector.observeEvent(run, { type: 'tool/call', time: 5000, data: { callId: 'c-5', name: 'grep', arguments: '{bad' } })
    detector.observeEvent(run, { type: 'tool/call', time: 6000, data: { callId: 'c-6', name: 'grep', arguments: ' {bad ' } })
    detector.observeEvent(run, { type: 'tool/call', time: 7000, data: { callId: 'c-7', name: 'grep', arguments: '{bad' } })
    const malformed4 = detector.observeEvent(run, { type: 'tool/call', time: 8000, data: { callId: 'c-8', name: 'grep', arguments: '{bad' } })
    expect(malformed4.hits[0]).toMatchObject({ signal: 'repeat-tool-call' })
  })

  it('detects Signal 2 (repeat-tool-error) at >=3 consecutive and hardLimitReached at >=8 in a single turn', () => {
    const detector = new WatchdogSignalDetector()
    const run = runCtx()

    expect(errorFingerprint({ error: { reason: "\n  ENOENT: Missing /a.ts\n  at line 9  " } })).toBe('enoent: missing /a.ts')

    detector.observeEvent(run, { type: 'turn/start', time: 100, data: { turn: 1 } })
    for (let i = 1; i <= 2; i++) {
      const res = detector.observeEvent(run, {
        type: 'tool/result',
        time: 100 + i * 10,
        data: { turn: 1, message: { toolCallId: `c-${i}`, isError: true, content: 'Error: Permission denied\nstack' } },
      })
      expect(res.hits).toEqual([])
    }
    const third = detector.observeEvent(run, {
      type: 'tool/result',
      time: 130,
      data: { turn: 1, message: { toolCallId: 'c-3', isError: true, content: '  Error: Permission denied  \nother' } },
    })
    expect(third.hits[0]).toMatchObject({ signal: 'repeat-tool-error' })
    expect(third.hits[0]?.hardLimitReached).toBeUndefined()

    // Success resets consecutive streak
    detector.observeEvent(run, {
      type: 'tool/result',
      time: 140,
      data: { turn: 1, message: { toolCallId: 'c-ok', isError: false, content: 'ok' } },
    })

    // 8 consecutive same errors within turn 2 triggers hardLimitReached
    detector.observeEvent(run, { type: 'turn/start', time: 200, data: { turn: 2 } })
    for (let i = 1; i <= 7; i++) {
      const r = detector.observeEvent(run, {
        type: 'tool/result',
        time: 200 + i,
        data: { turn: 2, message: { toolCallId: `t2-${i}`, isError: true, content: 'SyntaxError: bad token' } },
      })
      if (i >= 3) expect(r.hits[0]?.hardLimitReached).toBeUndefined()
    }
    const eighth = detector.observeEvent(run, {
      type: 'tool/result',
      time: 210,
      data: { turn: 2, message: { toolCallId: 't2-8', isError: true, content: 'SyntaxError: bad token' } },
    })
    expect(eighth.hits[0]).toMatchObject({ signal: 'repeat-tool-error', hardLimitReached: true })
  })

  it('detects Signal 3 (no-progress) using interval union to avoid double-subtracting overlapping waits', () => {
    const detector = new WatchdogSignalDetector()
    const run = runCtx({ startedAt: 0 })

    // Overlapping intervals: quiet [100s, 400s], retry [300s, 500s], pending [350s, 450s] -> union = [100s, 500s] = 400s
    const union = unionWaitMs(
      [{ start: 100_000, end: 400_000 }, { start: 300_000, end: 500_000 }, { start: 350_000, end: 450_000 }],
      0,
      1_000_000,
    )
    expect(union).toBe(400_000)

    detector.noteQuietWait(run, true, 100_000)
    detector.noteRetryState(run, { kind: 'transient', since: new Date(300_000).toISOString() }, 300_000)
    detector.noteQuietWait(run, false, 400_000)
    detector.noteRetryState(run, undefined, 500_000)

    // At t = 18m (1,080,000ms), total elapsed = 18m, union wait = 400s (~6.67m), net active = 11.33m < 15m -> NO hit
    // (Whereas naive sum 300+200+100 = 600s would be even smaller; at t = 21m, naive sum would undercount netActive!)
    const before = detector.evaluatePatrol({
      run,
      agentStatus: 'running',
      now: 18 * 60_000,
      pendingWaitIntervals: [{ start: 350_000, end: 450_000 }],
    })
    expect(before.some(h => h.signal === 'no-progress')).toBe(false)

    // At t = 21m40s (1,300,000ms): 1,300,000 - 400,000 = 900,000ms = 15m -> fires!
    const at15Net = detector.evaluatePatrol({
      run,
      agentStatus: 'running',
      now: NO_PROGRESS_MS + 400_000,
      pendingWaitIntervals: [{ start: 350_000, end: 450_000 }],
    })
    expect(at15Net.some(h => h.signal === 'no-progress')).toBe(true)

    // Successful test command resets progress timer
    detector.observeEvent(run, {
      type: 'tool/call',
      time: NO_PROGRESS_MS + 401_000,
      data: { callId: 't-1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) },
    })
    const testDone = detector.observeEvent(run, {
      type: 'tool/result',
      time: NO_PROGRESS_MS + 405_000,
      data: { message: { toolCallId: 't-1', isError: false, content: 'all passed' } },
    })
    expect(testDone.substantiveProgress).toBe(true)
    const afterTest = detector.evaluatePatrol({
      run,
      agentStatus: 'running',
      now: NO_PROGRESS_MS + 500_000,
      pendingWaitIntervals: [{ start: 350_000, end: 450_000 }],
    })
    expect(afterTest.some(h => h.signal === 'no-progress')).toBe(false)
  })

  it('detects Signal 4 (compaction-loop), deduplicating by compactionId and ignoring failed compactions', () => {
    const detector = new WatchdogSignalDetector()
    const run = runCtx()

    // Failed compaction does not increment
    expect(detector.observeEvent(run, { type: 'compaction/end', time: 100, data: { compactionId: 'cmp-0', error: 'timeout' } }).hits).toEqual([])
    // Summary + end with same compactionId counts once
    expect(detector.observeEvent(run, { type: 'compaction/summary', time: 200, data: { compactionId: 'cmp-1' } }).hits).toEqual([])
    expect(detector.observeEvent(run, { type: 'compaction/end', time: 210, data: { compactionId: 'cmp-1' } }).hits).toEqual([])
    // 2nd distinct completed compaction fires
    const second = detector.observeEvent(run, { type: 'compaction/summary', time: 300, data: { compactionId: 'cmp-2' } })
    expect(second.hits[0]).toMatchObject({ signal: 'compaction-loop' })

    // Successful write resets compaction counter
    detector.observeEvent(run, { type: 'tool/call', time: 400, data: { callId: 'w-1', name: 'edit', arguments: '{}' } })
    detector.observeEvent(run, { type: 'tool/result', time: 410, data: { message: { toolCallId: 'w-1', isError: false, content: 'ok' } } })
    expect(detector.observeEvent(run, { type: 'compaction/summary', time: 500, data: { compactionId: 'cmp-3' } }).hits).toEqual([])
  })

  it('detects Signal 5 (budget-retry-stall) only for budget >= 15m and not transient', () => {
    const detector = new WatchdogSignalDetector()
    const run = runCtx()
    const since = new Date(1000).toISOString()

    expect(detector.evaluatePatrol({
      run,
      agentStatus: 'running',
      now: 1000 + BUDGET_STALL_MS,
      retryStatus: { kind: 'transient', since },
    }).some(h => h.signal === 'budget-retry-stall')).toBe(false)

    expect(detector.evaluatePatrol({
      run,
      agentStatus: 'running',
      now: 1000 + BUDGET_STALL_MS - 1,
      retryStatus: { kind: 'budget', since },
    }).some(h => h.signal === 'budget-retry-stall')).toBe(false)

    const hit = detector.evaluatePatrol({
      run,
      agentStatus: 'running',
      now: 1000 + BUDGET_STALL_MS,
      retryStatus: { kind: 'budget', since },
    }).find(h => h.signal === 'budget-retry-stall')
    expect(hit).toBeDefined()
  })

  it('detects Signal 6 (silent-stall) only when active+running+not waiting for >= 10m', () => {
    const detector = new WatchdogSignalDetector()
    const run = runCtx({ startedAt: 0 })

    // Idle agent -> never silent-stall
    expect(detector.evaluatePatrol({ run, agentStatus: 'idle', now: SILENT_STALL_MS + 1000 }).some(h => h.signal === 'silent-stall')).toBe(false)

    // Active quiet wait / open pending / active retry -> suppressed
    expect(detector.evaluatePatrol({ run, agentStatus: 'running', now: SILENT_STALL_MS + 1000, quietWaitActive: true }).some(h => h.signal === 'silent-stall')).toBe(false)
    expect(detector.evaluatePatrol({ run, agentStatus: 'running', now: SILENT_STALL_MS + 1000, hasOpenPending: true }).some(h => h.signal === 'silent-stall')).toBe(false)
    expect(detector.evaluatePatrol({
      run,
      agentStatus: 'running',
      now: SILENT_STALL_MS + 1000,
      retryStatus: { kind: 'transient', since: new Date(0).toISOString() },
    }).some(h => h.signal === 'silent-stall')).toBe(false)

    // Running, no waits, >= 10m without events -> fires
    const stall = detector.evaluatePatrol({ run, agentStatus: 'running', now: SILENT_STALL_MS })
    expect(stall.some(h => h.signal === 'silent-stall')).toBe(true)
  })

  it('detects Signal 7 (infra-failure) and clears cleanly on recovery, isolating per inputRevision', () => {
    const detector = new WatchdogSignalDetector()
    const rev1 = runCtx({ inputRevision: 1 })
    const rev2 = runCtx({ inputRevision: 2 })

    // Single turn/end error does not fire; 2nd consecutive fires
    expect(detector.observeEvent(rev1, { type: 'turn/end', time: 100, data: { turn: 1, reason: { kind: 'error', error: { message: '502' } } } }).hits).toEqual([])
    const second = detector.observeEvent(rev1, { type: 'turn/end', time: 200, data: { turn: 2, reason: { kind: 'error', error: { message: '502' } } } })
    expect(second.hits[0]).toMatchObject({ signal: 'infra-failure' })

    // inputRevision=2 is tracked independently
    expect(detector.getState('run-1', 2)).toBeUndefined()
    expect(detector.observeEvent(rev2, { type: 'turn/end', time: 300, data: { turn: 1, reason: { kind: 'error', error: { message: '502' } } } }).hits).toEqual([])

    // Recovery via assistant/message clears rev1 infra failure
    const recovered = detector.observeEvent(rev1, { type: 'assistant/message', time: 400, data: {} })
    expect(recovered.recovered).toBe(true)
    expect(detector.evaluatePatrol({ run: rev1, agentStatus: 'idle', now: 500 }).some(h => h.signal === 'infra-failure')).toBe(false)
  })

  it('falls back to lastShellCommand for isTestRunnerCommand when synthetic shell tool/result omits callId', () => {
    const detector = new WatchdogSignalDetector()
    const run = runCtx({ startedAt: 0 })

    // Primary callId path still wins when callId is present
    detector.observeEvent(run, {
      type: 'tool/call',
      time: 1000,
      data: { callId: 'c-echo', name: 'bash', arguments: JSON.stringify({ command: 'echo hello' }) },
    })
    const nonTest = detector.observeEvent(run, {
      type: 'tool/result',
      time: 1100,
      data: { name: 'bash', message: { toolCallId: 'c-echo', isError: false, content: 'hello' } },
    })
    expect(nonTest.substantiveProgress).toBe(false)

    // Synthetic shell tool/result without callId consumes lastShellCommand
    detector.observeEvent(run, {
      type: 'tool/call',
      time: 2000,
      data: { callId: 'c-test', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) },
    })
    const syntheticTest = detector.observeEvent(run, {
      type: 'tool/result',
      time: 2500,
      data: { name: 'bash', message: { isError: false, content: 'all passed' } },
    })
    expect(syntheticTest.substantiveProgress).toBe(true)

    // Consumed lastShellCommand does not leak into a subsequent non-test shell result without callId
    detector.observeEvent(run, {
      type: 'tool/call',
      time: 3000,
      data: { name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) },
    })
    const nextNonTest = detector.observeEvent(run, {
      type: 'tool/result',
      time: 3100,
      data: { name: 'bash', message: { isError: false, content: 'files' } },
    })
    expect(nextNonTest.substantiveProgress).toBe(false)
  })
})
