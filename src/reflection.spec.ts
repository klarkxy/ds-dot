import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, TOOL, type CognitionEntry } from './contracts.ts'
import type { RawEvent } from './chat.ts'
import type { DotHost } from './host.ts'
import { applyCognitionOps, parseCognitionOps } from './memory.ts'
import { ReflectionRunner, REFLECTION_FAILURE_COOLDOWN_MS, REFLECTION_INSTRUCTIONS, REFLECTION_INTERVAL_MS, REFLECTION_PRESET_ID, REFLECTION_PROPOSE_TOOL, REFLECTION_SUBMIT_TOOL, apply as applyReflection, buildReflectionInstruction, reflectionDue } from './reflection.ts'
import { DotStore } from './store.ts'

const entry = (id: string, text: string, seenAt = 1, pinned?: true): CognitionEntry => ({ id, text, createdAt: seenAt, updatedAt: seenAt, seenAt, ...(pinned ? { pinned } : {}) })

describe('reflectionDue', () => {
  const base = {
    now: 100 * REFLECTION_INTERVAL_MS,
    enabled: true,
    lastReflectedAt: 0,
    lastConversationAt: 1,
    dotIdle: true,
  }

  it('requires the switch, an idle dot, a full day and new conversation', () => {
    expect(reflectionDue(base)).toBe(true)
    expect(reflectionDue({ ...base, enabled: false })).toBe(false)
    expect(reflectionDue({ ...base, dotIdle: false })).toBe(false)
    expect(reflectionDue({ ...base, lastReflectedAt: base.now - REFLECTION_INTERVAL_MS + 1 })).toBe(false)
    expect(reflectionDue({ ...base, lastConversationAt: 0 })).toBe(false)
    // Nothing has been said since the last successful pass: conversation time equals it.
    expect(reflectionDue({ ...base, lastReflectedAt: base.now - REFLECTION_INTERVAL_MS, lastConversationAt: base.now - REFLECTION_INTERVAL_MS })).toBe(false)
  })

  it('holds a failed attempt for the failure cooldown, then allows a retry', () => {
    const lastReflectedAt = base.now - 2 * REFLECTION_INTERVAL_MS
    const lastReflectionAttemptAt = base.now - REFLECTION_FAILURE_COOLDOWN_MS + 1
    const failed = { ...base, lastReflectedAt, lastReflectionAttemptAt, reflectionAttemptFailed: true, lastConversationAt: lastReflectedAt + 1 }
    expect(reflectionDue(failed)).toBe(false)
    expect(reflectionDue({ ...failed, now: lastReflectionAttemptAt + REFLECTION_FAILURE_COOLDOWN_MS })).toBe(true)
    // The flag is what matters: a stale attempt timestamp never blocks a run
    // whose last attempt actually succeeded.
    expect(reflectionDue({ ...failed, reflectionAttemptFailed: false })).toBe(true)
  })
})

describe('DotStore reflection bookkeeping', () => {
  it('marks an attempt failed even when it shares its millisecond with the last success', async () => {
    const store = new DotStore(undefined)
    await store.markReflected(1000)
    expect(store.reflectionAttemptFailed).toBe(false)
    await store.beginReflectionAttempt(1000)
    // Same millisecond, but the boolean still says the latest attempt failed.
    expect(store.lastReflectedAt).toBe(1000)
    expect(store.lastReflectionAttemptAt).toBe(1000)
    expect(store.reflectionAttemptFailed).toBe(true)
  })

  it('keeps the agreement note until it is cleared and remembers reflection runs', async () => {
    const store = new DotStore(undefined)
    await store.setAgreementNotes('these two agreements disagree')
    expect(store.agreementNotes).toBe('these two agreements disagree')
    // An empty note must not wipe a pending one.
    await store.setAgreementNotes('')
    expect(store.agreementNotes).toBe('these two agreements disagree')
    await store.clearAgreementNotes()
    expect(store.agreementNotes).toBe('')

    await store.addReflectionRun({ sessionId: 'ref-1', startedAt: 10, ok: false })
    await store.finishReflectionRun('ref-1', 20, true)
    expect(store.reflections).toEqual([{ sessionId: 'ref-1', startedAt: 10, endedAt: 20, ok: true }])
  })
})

/** Minimal host for the runner: lets a test control exactly when the pass goes idle. */
function reflectionHost() {
  let promptResolve!: (sessionId: string) => void
  let idleResolve!: () => void
  let releaseResolve!: () => void
  const prompted = new Promise<string>(resolve => { promptResolve = resolve })
  const idle = new Promise<void>(resolve => { idleResolve = resolve })
  const released = new Promise<void>(resolve => { releaseResolve = resolve })
  const calls: string[] = []
  let events: RawEvent[] = []
  const host = {
    async createInternal(_cwd: string, preset: string) { calls.push(`create ${preset}`); return 'ref-1' },
    async promptInternal(sessionId: string) { calls.push(`prompt ${sessionId}`); promptResolve(sessionId) },
    async waitIdle() { await idle },
    async releaseInternal(sessionId: string) { calls.push(`release ${sessionId}`); releaseResolve() },
    async stop(sessionId: string) { calls.push(`stop ${sessionId}`); idleResolve() },
    async readEvents() { return events },
    setEvents(next: RawEvent[]) { events = next },
  }
  return { host: host as unknown as DotHost, calls, prompted, released, finishIdle: () => idleResolve() }
}

function makeRunner(store: DotStore, host: DotHost, at: () => number) {
  return new ReflectionRunner({
    host,
    store,
    homeDir: '/dot',
    now: at,
    applyCognition: async (ops: string) => { await store.setCognitionEntries(applyCognitionOps(store.cognitionEntries, parseCognitionOps(ops), at(), () => store.nextKnowledgeId('c'))) },
    isDotIdle: () => true,
    timeoutMs: 60_000,
  })
}

describe('ReflectionRunner', () => {
  it('rejects a stale reflection after cognition changes, including change and restore', async () => {
    const store = new DotStore(undefined)
    await store.setSettings({ ...DEFAULT_SETTINGS, reflection: true })
    await store.setDot({ lastConversationAt: 5000 })
    await store.setCognitionEntries([entry('c1', 'original')])
    const fake = reflectionHost()
    const runner = makeRunner(store, fake.host, () => REFLECTION_INTERVAL_MS + 10_000)
    await runner.tick()
    const sessionId = await fake.prompted
    await store.setCognitionEntries([entry('c1', 'human update')])
    await store.setCognitionEntries([entry('c1', 'original')])
    await expect(runner.submit('[{"op":"add","text":"stale output"}]', undefined, sessionId)).rejects.toThrow(/cognition changed/)
    expect(store.cognitionEntries.map(item => item.text)).toEqual(['original'])
    fake.finishIdle()
    await fake.released
  })
  it('runs a pass, writes cognition and agreement notes, and archives the session', async () => {
    const store = new DotStore(undefined)
    await store.setSettings({ ...DEFAULT_SETTINGS, reflection: true })
    await store.setDot({ lastConversationAt: 5_000 })
    const fake = reflectionHost()
    let now = REFLECTION_INTERVAL_MS + 10_000
    const runner = makeRunner(store, fake.host, () => now)
    expect(await runner.tick()).toBe(true)
    const sessionId = await fake.prompted
    expect(sessionId).toBe('ref-1')
    expect(fake.calls).toContain(`create ${REFLECTION_PRESET_ID}`)
    expect(store.reflections[0]).toMatchObject({ sessionId: 'ref-1', ok: false })
    await runner.submit('[{"op":"add","text":"the human prefers terse answers"}]', 'two agreements conflict', sessionId)
    fake.finishIdle()
    await fake.released
    expect(store.cognitionEntries.map(item => item.text)).toEqual(['the human prefers terse answers'])
    expect(store.agreementNotes).toBe('two agreements conflict')
    expect(store.lastReflectedAt).toBe(now)
    expect(store.reflectionAttemptFailed).toBe(false)
    expect(store.reflections[0]).toMatchObject({ sessionId: 'ref-1', ok: true })
    expect(fake.calls).toContain('release ref-1')
  })

  it('rejects a submission that did not come from the running pass', async () => {
    const store = new DotStore(undefined)
    await store.setSettings({ ...DEFAULT_SETTINGS, reflection: true })
    await store.setDot({ lastConversationAt: 5_000 })
    const fake = reflectionHost()
    const runner = makeRunner(store, fake.host, () => REFLECTION_INTERVAL_MS + 10_000)
    await runner.tick()
    const sessionId = await fake.prompted
    await expect(runner.submit('[{"op":"add","text":"rogue write"}]', undefined, 'other-session')).rejects.toThrow(/did not come from the running reflection pass/)
    await expect(runner.submit('[{"op":"add","text":"rogue write"}]', undefined, '')).rejects.toThrow(/did not come/)
    expect(store.cognitionEntries).toEqual([])
    // The legitimate pass still works.
    await runner.submit('[{"op":"add","text":"real text"}]', undefined, sessionId)
    fake.finishIdle()
    await fake.released
    expect(store.cognitionEntries.map(item => item.text)).toEqual(['real text'])
  })

  it('records a failure when the pass ends without submitting', async () => {    const store = new DotStore(undefined)
    await store.setSettings({ ...DEFAULT_SETTINGS, reflection: true })
    await store.setDot({ lastConversationAt: 5_000 })
    const fake = reflectionHost()
    const runner = makeRunner(store, fake.host, () => REFLECTION_INTERVAL_MS + 10_000)
    await runner.tick()
    await fake.prompted
    fake.finishIdle()
    await fake.released
    expect(store.lastReflectedAt).toBeUndefined()
    expect(store.reflectionAttemptFailed).toBe(true)
    expect(store.reflections[0]).toMatchObject({ sessionId: 'ref-1', ok: false })
    expect(store.cognitionEntries).toEqual([])
  })

  it('does not count a submission as successful when a bookkeeping write fails', async () => {
    const store = new DotStore(undefined)
    await store.setSettings({ ...DEFAULT_SETTINGS, reflection: true })
    await store.setDot({ lastConversationAt: 5_000 })
    const fake = reflectionHost()
    const startedAt = REFLECTION_INTERVAL_MS + 10_000
    const runner = makeRunner(store, fake.host, () => startedAt)
    await runner.tick()
    const sessionId = await fake.prompted
    const realFinish = store.finishReflectionRun.bind(store)
    store.finishReflectionRun = async () => { throw new Error('disk full') }
    await expect(runner.submit('[{"op":"add","text":"new text"}]', undefined, sessionId)).rejects.toThrow('disk full')
    store.finishReflectionRun = realFinish
    fake.finishIdle()
    await fake.released
    // The failed pass must not satisfy the 24h success gate: no success time,
    // and the attempt stays failed so the next try waits the 2h cooldown.
    expect(store.lastReflectedAt).toBeUndefined()
    expect(store.reflectionAttemptFailed).toBe(true)
    expect(reflectionDue({
      now: startedAt + 3_600_000,
      enabled: true,
      dotIdle: true,
      lastReflectedAt: store.lastReflectedAt,
      lastReflectionAttemptAt: store.lastReflectionAttemptAt,
      reflectionAttemptFailed: store.reflectionAttemptFailed,
      lastConversationAt: 5_000,
    })).toBe(false)
  })

  it('undoes a success time when the final success write fails', async () => {
    const store = new DotStore(undefined)
    await store.setSettings({ ...DEFAULT_SETTINGS, reflection: true })
    await store.setDot({ lastConversationAt: 5_000 })
    const fake = reflectionHost()
    const startedAt = REFLECTION_INTERVAL_MS + 10_000
    const runner = makeRunner(store, fake.host, () => startedAt)
    await runner.tick()
    const sessionId = await fake.prompted
    const realMark = store.markReflected.bind(store)
    // Simulate a write that mutates memory and then fails: the runner must roll
    // the success time back so the failed pass is not mistaken for a success.
    store.markReflected = async (at: number) => { await realMark(at); throw new Error('disk full') }
    await expect(runner.submit('[]', undefined, sessionId)).rejects.toThrow('disk full')
    store.markReflected = realMark
    fake.finishIdle()
    await fake.released
    expect(store.lastReflectedAt).toBeUndefined()
    expect(store.reflectionAttemptFailed).toBe(true)
    expect(store.reflections[0]).toMatchObject({ sessionId, ok: false })
  })

  it('cancels a pass in flight on dispose and releases its session', async () => {
    const store = new DotStore(undefined)
    await store.setSettings({ ...DEFAULT_SETTINGS, reflection: true })
    await store.setDot({ lastConversationAt: 5_000 })
    const fake = reflectionHost()
    const runner = makeRunner(store, fake.host, () => REFLECTION_INTERVAL_MS + 10_000)
    await runner.tick()
    await fake.prompted
    expect(runner.running).toBe(true)
    await runner.dispose()
    expect(fake.calls).toContain('stop ref-1')
    expect(fake.calls).toContain('release ref-1')
    expect(runner.running).toBe(false)
    // A disposed runner never starts another pass.
    expect(await runner.tick()).toBe(false)
  })

  it('folds a stored reflection session into a trajectory', async () => {
    const store = new DotStore(undefined)
    const fake = reflectionHost()
    fake.host.readEvents = async () => [
      { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 11, data: { step: 1 } },
      { type: 'assistant/message', seq: 2, time: 12, data: { message: { content: [{ type: 'text', text: 'reviewed' }] } } },
      { type: 'turn/end', seq: 3, time: 13, data: { reason: { kind: 'completed' } } },
    ] as RawEvent[]
    const runner = makeRunner(store, fake.host, () => 0)
    const view = await runner.trajectory('ref-1')
    expect(view.sessionId).toBe('ref-1')
    expect(view.turns).toHaveLength(1)
    expect(view.turns[0]!.steps[0]!.records.some(record => record.kind === 'text' && record.text === 'reviewed')).toBe(true)
  })
})

describe('buildReflectionInstruction', () => {
  it('keeps both parts of cognition without recording task details', () => {
    expect(REFLECTION_INSTRUCTIONS).not.toMatch(/Dorothy|桃乐丝/)
    expect(REFLECTION_INSTRUCTIONS).toContain('about herself')
    expect(REFLECTION_INSTRUCTIONS).toContain('shared jokes')
    expect(REFLECTION_INSTRUCTIONS).toContain('accomplished together')
    expect(REFLECTION_INSTRUCTIONS).toContain('task details')
    expect(REFLECTION_INSTRUCTIONS).toContain('entry operations')
    expect(REFLECTION_INSTRUCTIONS).toContain('Never add, remove, or reword [agreements]')
    expect(buildReflectionInstruction({ agreements: [], cognition: [], limit: 30, now: 0 })).not.toMatch(/Dorothy|桃乐丝/)
  })

  it('lists entries with id, state and last-confirmed date, and names the submission tool', () => {
    const text = buildReflectionInstruction({
      agreements: [{ id: 'a1', text: 'be brief', createdAt: 1, updatedAt: 1 }],
      cognition: [
        entry('c1', 'a pinned fact', Date.UTC(2026, 10, 20), true),
        entry('c2', 'she likes terse answers', Date.UTC(2026, 10, 19)),
        entry('c3', 'a dormant note', Date.UTC(2026, 10, 18)),
      ],
      limit: 2,
      now: 0,
    })
    expect(text).toContain('- be brief')
    expect(text).toContain('dot_reflection_submit')
    expect(text).toContain('never change')
    expect(text).toContain('id · state · last confirmed · text')
    expect(text).toContain('- c1 · pinned · 2026-11-20 · a pinned fact')
    expect(text).toContain('- c2 · active · 2026-11-19 · she likes terse answers')
    expect(text).toContain('- c3 · dormant · 2026-11-18 · a dormant note')
    expect(text).toContain('submit ops=[]')
    expect(buildReflectionInstruction({ agreements: [], cognition: [], limit: 30, now: 0 })).toContain('(none yet)')
  })

  it('adds the recipes section only when hints exist', () => {
    const plain = buildReflectionInstruction({ agreements: [], cognition: [], limit: 30, now: 0 })
    expect(plain).not.toContain('[recipes]')
    const withRecipes = buildReflectionInstruction({ agreements: [], cognition: [], limit: 30, now: 0, recipes: '- rcp-1 "weekly" rev 2 — 1/4 accepted' })
    expect(withRecipes).toContain('[recipes]')
    expect(withRecipes).toContain('rcp-1 "weekly"')
    expect(withRecipes).toContain('dot_reflection_recipe_propose')
  })

  it('lists active sessions and points history searches at the since cutoff', () => {
    const at = Date.UTC(2026, 10, 28, 12)
    const text = buildReflectionInstruction({
      agreements: [], cognition: [], limit: 30, lastReflectedAt: at, now: at + 1,
      sessions: [{ sessionId: 'session-run-8', what: 'Task "release"' }, { sessionId: 'dot-old', what: 'Your conversation, earlier session' }],
    })
    const since = new Date(at).toISOString()
    expect(text).toContain(`Sessions with activity since ${since}`)
    expect(text).toContain('- session-run-8 · Task "release"')
    expect(text).toContain('Start with dot_read_history on these sessions.')
    expect(text).toContain(`pass since="${since}"`)
    expect(text).toContain('do not enumerate history with broad one-word searches')
  })
})

describe('reflection preset tool row', () => {
  it('registers only the three internal tools and hides inherited global tools', () => {
    const registered: Array<Record<string, unknown>> = []
    const filters: Array<{ allow?: readonly string[] }> = []
    const ctx = {
      tools: {
        restrict: (filter: { allow?: readonly string[] }) => { filters.push(filter); return () => {} },
        register: (definition: Record<string, unknown>) => { registered.push(definition); return () => {} },
      },
      dot: {},
      on: () => () => {},
      effect: (fn: () => unknown) => { fn(); return () => {} },
    }
    applyReflection(ctx as never)
    expect(registered.map(tool => tool.name).sort()).toEqual([TOOL.searchHistory, TOOL.readHistory, REFLECTION_SUBMIT_TOOL, REFLECTION_PROPOSE_TOOL].sort())
    // Model-facing reflection tools never bind cognition to a fixed character.
    expect(JSON.stringify(registered)).not.toMatch(/Dorothy|桃乐丝/)
    // Visibility is no longer restricted on the preset scope (that also hid the
    // preset's own tools from the agent child scope assembling the request);
    // it is applied to the agent scope in host.ts setupFor instead.
    expect(filters).toEqual([])
  })
})
