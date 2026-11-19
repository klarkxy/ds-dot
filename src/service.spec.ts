import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Timer } from './batcher.ts'
import type { RawEvent } from './chat.ts'
import { DEFAULT_SETTINGS, PRESET_ID, REMINDER_HEAD, type DotContextView, type DotSettings } from './contracts.ts'
import { bindHost, FULL_ACCESS, type DotHost, type SessionRow, type WorkspaceRow } from './host.ts'
import { DotService, HOME_TITLE } from './service.ts'
import { readSnapshot, saveSnapshot } from './artifacts.ts'
import * as artifacts from './artifacts.ts'
import { launchReservedRun } from './execution.ts'
import { agreementsSection } from './memory.ts'
import { DotStore, type DotDomainHandle } from './store.ts'

/** Manual timer: tests fire scheduled callbacks explicitly. */
function manualTimer() {
  const pending = new Map<number, { run: () => void; ms: number }>()
  let next = 0
  const timer: Timer = {
    set: (callback, ms) => { const id = ++next; pending.set(id, { run: callback, ms }); return id },
    clear: handle => { pending.delete(handle as number) },
    now: () => 1000,
  }
  return {
    timer,
    delays: () => [...pending.values()].map(entry => entry.ms),
    fire: () => { const due = [...pending.values()]; pending.clear(); for (const entry of due) entry.run() },
  }
}

function fakeHost() {
  const workspaces: WorkspaceRow[] = []
  const calls: string[] = []
  const timeline: string[] = []
  const said: Array<{ text: string; carriedNotices?: string; images?: readonly { mediaType: string }[]; notice?: import('./chat-format.ts').ParsedNotice }> = []
  const relayed: Array<{ target: string; text: string; notice?: import('./chat-format.ts').ParsedNotice }> = []
  const dots = new Set<string>()
  const lost = new Set<string>()
  const events = new Map<string, RawEvent[]>()
  const running = new Set<string>()
  const unreadable = new Set<string>()
  const runSessions = new Map<string, { cwd?: string; preset?: string }>()
  let sessions = 0
  let permissionWorks = true
  let context: DotContextView = { live: false, compactions: 0 }
  let model: string | undefined
  let createFails = false
  let summaryFails = false
  let catalogFails = false
  let presetsFail = false
  const reflectionHooks: { promptHook?: (sessionId: string, text: string) => void | Promise<void> } = {}
  const host: DotHost = {
    listWorkspaces: () => [...workspaces],
    async createWorkspace(path, title) {
      const found = workspaces.find(row => row.path === path)
      if (found) return found
      const row = { id: `w${workspaces.length + 1}`, path, title: title ?? path, sessionCount: 0 }
      workspaces.push(row)
      return row
    },
    async listSessions(): Promise<SessionRow[]> { return [] },
    async titles() { return new Map() },
    async createSession(place) {
      const id = place.sessionId ?? `s${++sessions}`
      runSessions.set(id, { cwd: place.cwd, preset: place.preset })
      calls.push(`create ${id} ${place.workspaceId ?? place.cwd}${place.preset ? ` preset=${place.preset}` : ''}`)
      return id
    },
    async findSession(id) { return runSessions.get(id) },
    async setReadOnly(id) { calls.push(`readonly ${id}`); return permissionWorks },
    async setWritable(id, permission) { calls.push(`permit ${id} ${permission}`); return permissionWorks },
    async verifyTaskPermission() { return permissionWorks },
    async listPresets() {
      if (presetsFail) throw new Error('roster offline')
      return {
        fallback: 'standard',
        presets: [{ id: 'standard' }, { id: 'ptc' }, { id: 'cordis' }, { id: 'minimal' }, { id: 'dot' }, { id: 'mine', broken: 'a row does not load' }],
      }
    },
    async listModels() {
      if (catalogFails) throw new Error('catalog offline')
      return {
        fallback: { provider: 'p', model: 'base' },
        models: [{ provider: 'p', model: 'base', name: 'Base' }, { provider: 'p', model: 'big', name: 'Big' }, { provider: 'q', model: 'small', name: 'small' }],
      }
    },
    async selectModel(sessionId, choice) { calls.push(`model ${sessionId} ${choice.provider}/${choice.model}`) },
    async setPermission(sessionId, preset) { calls.push(`permit ${sessionId} ${preset}`); return permissionWorks },
    async prompt(sessionId, text) { calls.push(`prompt ${sessionId} ${text}`) },
    async relay(target, _sender, text, _deliveryId, _confirm, notice) { relayed.push({ target, text, ...(notice ? { notice } : {}) }); timeline.push(`relay ${text}`) },
    async cancel(sessionId) { calls.push(`cancel ${sessionId}`) },
    async cancelAndWait(sessionId) { calls.push(`cancel-wait ${sessionId}`); return true },
    async archive(sessionId) { calls.push(`archive ${sessionId}`) },
    async latestReply() { return 'done: wrote hello.txt' },
    async cwdOf() { return '/watched' },
    async createDot(cwd, preset) {
      if (createFails) throw new Error('no session for you')
      const id = `dot${++sessions}`
      dots.add(id)
      calls.push(`create-dot ${id} ${preset}`)
      return id
    },
    async resumeDot(sessionId) { calls.push(`resume-dot ${sessionId}`); return dots.has(sessionId) && !lost.has(sessionId) },
    async releaseDot(sessionId) { calls.push(`release-dot ${sessionId}`) },
    async createInternal(_cwd, preset) {
      const id = `ref${++sessions}`
      calls.push(`create-internal ${id} ${preset}`)
      return id
    },
    async promptInternal(sessionId, text) {
      calls.push(`prompt-internal ${sessionId} ${text}`)
      await reflectionHooks.promptHook?.(sessionId, text)
    },
    async waitIdle() {},
    async releaseInternal(sessionId) { calls.push(`release-internal ${sessionId}`) },
    async readEvents(sessionId) {
      if (unreadable.has(sessionId)) throw new Error('no such session')
      return events.get(sessionId) ?? []
    },
    async summarize(sessionId, _instruction, _maxTokens, onUsage) {
      calls.push(`summarize ${sessionId}`)
      if (summaryFails) throw new Error('model unavailable')
      onUsage?.({ input: 15, cacheRead: 25, cacheWrite: 0, output: 10 })
      return 'NOTE FROM DOT'
    },
    handoffView(fromSessionId, toSessionId) {
      calls.push(`handoff-view ${fromSessionId} ${toSessionId}`)
    },
    modelKey: () => model,
    async say(sessionId, text, carriedNotices, _answer, images, notice) { said.push({ text, ...carriedNotices ? { carriedNotices } : {}, ...images?.length ? { images } : {}, ...(notice ? { notice } : {}) }); calls.push(`say ${sessionId} ${text}`); timeline.push(`say ${text}`) },
    async stop(sessionId) { calls.push(`stop ${sessionId}`) },
    async stopActivity(sessionId) {
      calls.push(`stop-activity ${sessionId}`)
      return { cancelAccepted: true, queueCleared: true, idle: !running.has(sessionId), jobsSettled: true as const }
    },
    syncModel(sessionId) { calls.push(`sync-model ${sessionId}`) },
    dotEvents: () => [],
    dotContext: async () => context,
    dotTrajectory: () => ({ turns: [], earlier: 0 }),
    isRunning: sessionId => running.has(sessionId),
    async dispose() {},
  }
  return {
    host, calls, timeline, said, relayed, workspaces, lost, events, running, unreadable, reflectionHooks,
    failPermission: () => { permissionWorks = false },
    setContext: (next: DotContextView) => { context = next },
    setModel: (next: string | undefined) => { model = next },
    failCreate: (fails: boolean) => { createFails = fails },
    failSummary: () => { summaryFails = true },
    failCatalog: () => { catalogFails = true },
    failPresets: () => { presetsFail = true },
  }
}

function setup(settings?: Partial<DotSettings>, trace?: { info: (event: string, message: string, context?: Record<string, unknown>) => boolean; debug: (event: string, message: string, context?: Record<string, unknown>) => boolean; warn: (event: string, message: string, error?: unknown, context?: Record<string, unknown>) => boolean }, homeDir = join(tmpdir(), 'dsh-dot-spec')) {
  const fake = fakeHost()
  const clock = manualTimer()
  const store = new DotStore(undefined)
  // Reflection is off unless a test asks for it, so the reminder clock's periodic
  // check does not start background passes in unrelated tests.
  // Relay tests cover untracked sessions, so they opt into scope=all.
  // A fresh install defaults to tracked; see DEFAULT_SETTINGS.
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0, scope: 'all', ...settings })
  let at = 1000
  // The legacy note files live in memory here; only the one-time migration reads them.
  const notes = { path: '/dot/memory.md', text: '', cognition: '', read: async () => notes.text, readCognition: async () => notes.cognition }
  const service = new DotService({ host: fake.host, store, homeDir, notes, approvalGraceMs: 0, timer: clock.timer, now: () => at, ...(trace ? { trace } : {}) })
  return { ...fake, ...clock, store, service, notes, advance: (ms: number) => { at += ms } }
}

describe('DotService asynchronous card replies', () => {
  const shown = { title: 'Choose target', interactive: true, view: { type: 'options' as const, id: 'target', options: [{ label: 'staging' }] } }
  it('rejects a late card answer after the active segment changes', async () => {
    const h = setup()
    const first = await h.service.ensureDot()
    const card = await h.service.presentCard(shown, 'card1')
    await h.service.newSegment()
    const active = h.store.dotSessionId!
    expect(active).not.toBe(first)
    await h.service.watch('watched', 'keep an eye')
    await h.service.onTurnEnd('watched')
    await expect(h.service.answerCard(card.viewId!, 'target', { selected: ['staging'] })).rejects.toThrow('expired')
    expect(h.said).toHaveLength(0)
    expect(h.store.cards[0]?.answer).toBeUndefined()
  })
  it('never requeues delivered notices when later bookkeeping fails', async () => {
    const h = setup()
    await h.service.ensureDot()
    await h.service.watch('watched', 'keep an eye')
    await h.service.onTurnEnd('watched')
    h.store.noteConversation = async () => { throw new Error('disk offline') }
    await expect(h.service.say('first')).resolves.toBeUndefined()
    expect(h.said[0]?.carriedNotices).toContain('[dot notice]')
    await expect(h.service.say('second')).resolves.toBeUndefined()
    expect(h.said[1]?.carriedNotices).toBeUndefined()
  })
  it('counts a card-only reply when deciding whether persona changes need a segment', async () => {
    const h = setup()
    const first = await h.service.ensureDot()
    const card = await h.service.presentCard(shown, 'card1')
    h.events.set(first, [{ type: 'tool/result', time: 1100, data: { message: { toolCallId: 'card1' }, meta: card } }])
    await h.store.setSettings({ ...h.store.settings, persona: 'Changed persona' })
    await h.service.say('next')
    expect(h.store.dotSessionId).not.toBe(first)
    expect(h.store.cards[0]?.expired).toBe(true)
    expect(h.store.segment?.handoff?.rows.some(row => row.role === 'dot' && row.text.includes('Choose target'))).toBe(true)
  })
})

describe('DotService.ensureDot', () => {
  it('creates dot once under its own preset and resumes it afterwards', async () => {
    const h = setup()
    const first = await h.service.ensureDot()
    expect(await h.service.ensureDot()).toBe(first)
    expect(h.calls.filter(call => call.startsWith('create-dot'))).toEqual([`create-dot ${first} ${PRESET_ID}`])
    expect(h.calls).toContain(`resume-dot ${first}`)
  })

  it('starts a fresh session when the stored one cannot be resumed', async () => {
    const h = setup()
    const first = await h.service.ensureDot()
    h.lost.add(first)
    const second = await h.service.ensureDot()
    expect(second).not.toBe(first)
    expect(h.store.dotSessionId).toBe(second)
  })

  it("delivers the human's chat message to dot", async () => {
    const h = setup()
    await h.service.say('  plan the release  ')
    const dot = h.store.dotSessionId!
    expect(h.calls).toContain(`say ${dot} plan the release`)
    // The model setting is applied before the message reaches dot.
    expect(h.calls.indexOf(`sync-model ${dot}`)).toBeLessThan(h.calls.indexOf(`say ${dot} plan the release`))
    await expect(h.service.say('   ')).rejects.toThrow(/non-empty/)
  })
})

const human = (text: string, time: number): RawEvent => ({ type: 'user/message', time, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
const reply = (text: string, time: number): RawEvent => ({ type: 'assistant/message', time, data: { message: { content: [{ type: 'text', text }] } } })
const OVER_THE_LINE: DotContextView = { live: true, compactions: 0, contextWindow: 128_000, usedTokens: 80_000, rolloverAt: 70_000 }

describe('DotService segments', () => {
  it('lets dot request a segment for the next turn boundary without releasing its running session', async () => {
    const h = setup()
    const first = await h.service.ensureDot()
    h.events.set(first, [human('a', 10), reply('b', 20)])
    expect(h.service.requestSegment('work on the UI')).toContain('when this turn ends')
    expect(h.store.dotSessionId).toBe(first)
    await h.service.onDotIdle(first)
    expect(h.store.segment).toMatchObject({ reason: 'dot-requested' })
    expect(h.store.segment!.opening).toContain('work on the UI')
  })

  it('switches mechanically from the panel and reports failure without moving', async () => {
    const h = setup()
    const first = await h.service.ensureDot()
    h.events.set(first, [human('a', 10), reply('b', 20)])
    const next = await h.service.newSegment()
    expect(next).not.toBe(first)
    expect(h.store.segment!.reason).toBe('manual')
    expect(h.said).toEqual([])
    h.failCreate(true)
    await expect(h.service.newSegment()).rejects.toMatchObject({ code: 'dot/rollover-failed' })
    expect(h.store.dotSessionId).toBe(next)
  })

  it('records the first segment with the persona and model it starts with', async () => {
    const h = setup()
    h.setModel('p/m@high')
    const dot = await h.service.ensureDot()
    expect(h.store.segment).toMatchObject({ sessionId: dot, model: 'p/m@high' })
    expect(h.store.segment!.persona).toContain('桃乐丝')
    expect(h.store.segment!.opening).toBeUndefined()
    expect(h.store.pastSegments).toEqual([])
  })

  it('carries the stored conversation into a new segment when the session is lost', async () => {
    const h = setup()
    const first = await h.service.ensureDot()
    h.events.set(first, [human('ship v2 on friday', 10), reply('on it', 20)])
    h.lost.add(first)
    const second = await h.service.ensureDot()
    expect(second).not.toBe(first)
    expect(h.store.segment).toMatchObject({ sessionId: second, reason: 'lost' })
    expect(h.store.segment!.opening).toContain('ship v2 on friday')
    expect(h.store.segment!.opening).toContain('could not be reopened')
    expect(h.store.pastSegments).toEqual([{ sessionId: first, startedAt: 1000, endedAt: 1000, reason: 'lost' }])
    // A session that is gone cannot be asked for a note.
    expect(h.calls).not.toContain(`summarize ${first}`)
  })

  it('moves to a new segment once a finished turn is past the rollover line', async () => {
    const h = setup()
    const dot = await h.service.ensureDot()
    h.events.set(dot, [human('ship v2 on friday', 10), reply('on it', 20)])
    h.setContext(OVER_THE_LINE)
    await h.service.onDotIdle(dot)
    const next = h.store.dotSessionId!
    expect(next).not.toBe(dot)
    expect(h.calls).toContain(`release-dot ${dot}`)
    expect(h.store.segment).toMatchObject({ sessionId: next, reason: 'context-full', handoff: { tier: 'verbatim' } })
    expect(h.store.segment!.opening).toContain('Human: ship v2 on friday')
    expect(h.store.segment!.opening).toContain('[dot ledger]')
    await h.service.say('and the changelog')
    expect(h.calls).toContain(`say ${next} and the changelog`)
  })

  it('checks the line again before a delivery when the turn-end check could not move', async () => {
    const h = setup()
    const dot = await h.service.ensureDot()
    h.events.set(dot, [human('a', 10), reply('b', 20)])
    h.setContext(OVER_THE_LINE)
    h.failCreate(true)
    await h.service.onDotIdle(dot)
    expect(h.store.dotSessionId).toBe(dot)
    expect(h.calls).not.toContain(`release-dot ${dot}`)
    h.failCreate(false)
    await h.service.say('go on')
    expect(h.store.dotSessionId).not.toBe(dot)
    expect(h.calls).toContain(`say ${h.store.dotSessionId} go on`)
  })

  it('keeps the segment while dot runs, and seamlessly hands off open cards on rollover', async () => {
    const h = setup()
    const dot = await h.service.ensureDot()
    h.setContext(OVER_THE_LINE)
    h.events.set(dot, [human('a', 10), reply('b', 20)])
    h.running.add(dot)
    await h.service.onDotIdle(dot)
    expect(h.store.dotSessionId).toBe(dot)
    h.running.delete(dot)
    h.events.set(dot, [
      human('deploy it', 10),
      { type: 'tool/call', time: 19, data: { callId: 'c1', name: 'show_view', arguments: '{"title":"Choose target"}' } },
      reply('pick one', 20),
      { type: 'tool/result', time: 21, data: { message: { toolCallId: 'c1' }, meta: { viewId: 'v1', awaitReply: true } } },
    ])
    await h.service.onDotIdle(dot)
    const second = h.store.dotSessionId!
    expect(second).not.toBe(dot)
    expect(h.calls).toContain(`handoff-view ${dot} ${second}`)
    expect(h.store.segment?.openCard).toBeUndefined()
    expect(h.store.segment?.opening).not.toContain('is still open')

    // A manual rollover before the user replies keeps forwarding the same open card.
    h.setContext({ live: true, compactions: 0 })
    const third = await h.service.newSegment()
    expect(third).not.toBe(second)
    expect(h.calls).toContain(`handoff-view ${second} ${third}`)
    expect(h.store.segment?.openCard).toBeUndefined()
  })

  it('accumulates token usage across segment rollovers and supports clearing mid-segment', async () => {
    const h = setup()
    const first = await h.service.ensureDot()
    h.events.set(first, [human('hello', 10), reply('hi', 20)])
    h.setContext({
      live: true,
      compactions: 0,
      usage: { input: 120, cacheRead: 300, cacheWrite: 40, output: 60 },
    })
    expect((await h.service.contextView()).usage).toEqual({ input: 120, cacheRead: 300, cacheWrite: 40, output: 60 })

    const second = await h.service.newSegment()
    expect(second).not.toBe(first)
    // Fresh segment has no local usage yet, so cumulative usage stays intact.
    h.setContext({ live: true, compactions: 0 })
    expect((await h.service.contextView()).usage).toEqual({ input: 120, cacheRead: 300, cacheWrite: 40, output: 60 })

    // Second segment adds new usage on top of the carried total.
    h.setContext({
      live: true,
      compactions: 0,
      usage: { input: 30, cacheRead: 100, cacheWrite: 10, output: 20 },
    })
    expect((await h.service.contextView()).usage).toEqual({ input: 150, cacheRead: 400, cacheWrite: 50, output: 80 })

    // Clearing mid-segment zeroes cumulative usage immediately and offsets the active segment.
    const cleared = await h.service.clearUsage()
    expect(cleared.usage).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

    // Subsequent turns in the same segment count only the delta after clear, and carry only that delta forward.
    h.setContext({
      live: true,
      compactions: 0,
      usage: { input: 55, cacheRead: 160, cacheWrite: 15, output: 35 },
    })
    expect((await h.service.contextView()).usage).toEqual({ input: 25, cacheRead: 60, cacheWrite: 5, output: 15 })

    await h.service.newSegment()
    h.setContext({ live: true, compactions: 0 })
    expect((await h.service.contextView()).usage).toEqual({ input: 25, cacheRead: 60, cacheWrite: 5, output: 15 })
  })

  it('asks dot for a note when the conversation is too long to carry word for word', async () => {
    const h = setup()
    const dot = await h.service.ensureDot()
    const long = 'x'.repeat(40_000)
    h.events.set(dot, [human(long, 10), reply(long, 20), human('latest ask', 30), reply('latest answer', 40)])
    h.setContext(OVER_THE_LINE)
    await h.service.onDotIdle(dot)
    expect(h.calls).toContain(`summarize ${dot}`)
    expect(h.store.segment!.handoff).toMatchObject({ tier: 'summary', summary: 'NOTE FROM DOT' })
    expect(h.store.segment!.opening).toContain('NOTE FROM DOT')
    expect(h.store.segment!.opening).toContain('latest answer')
  })

  it('falls back to the latest messages when the note cannot be written', async () => {
    const h = setup()
    const dot = await h.service.ensureDot()
    const long = 'x'.repeat(40_000)
    h.events.set(dot, [human(long, 10), reply(long, 20), human('latest ask', 30), reply('latest answer', 40)])
    h.setContext(OVER_THE_LINE)
    h.failSummary()
    await h.service.onDotIdle(dot)
    expect(h.store.dotSessionId).not.toBe(dot)
    expect(h.store.segment!.handoff!.tier).toBe('tail')
    expect(h.store.segment!.opening).toContain('latest answer')
  })

  it('takes a persona edit in place before dot has replied and in a new segment after', async () => {
    const h = setup()
    const dot = await h.service.ensureDot()
    await h.store.setSettings({ ...DEFAULT_SETTINGS, persona: 'A calm librarian.' })
    await h.service.settingsChanged()
    expect(h.store.dotSessionId).toBe(dot)
    expect(h.store.segment!.persona).toContain('A calm librarian.')

    h.events.set(dot, [human('hi', 10), reply('hello', 20)])
    await h.store.setSettings({ ...DEFAULT_SETTINGS, persona: 'A cheerful pirate.' })
    await h.service.settingsChanged()
    // The segment dot already answered in keeps the persona its requests were built with.
    expect(h.store.dotSessionId).toBe(dot)
    expect(h.store.segment!.persona).toContain('A calm librarian.')
    await h.service.say('ahoy')
    const next = h.store.dotSessionId!
    expect(next).not.toBe(dot)
    expect(h.store.segment).toMatchObject({ reason: 'prompt-changed' })
    expect(h.store.segment!.persona).toContain('A cheerful pirate.')
    expect(h.calls).toContain(`say ${next} ahoy`)
  })

  it('applies a model change in a new segment and leaves the old one on its model', async () => {
    const h = setup()
    h.setModel('p/a@')
    const dot = await h.service.ensureDot()
    h.events.set(dot, [human('hi', 10), reply('hello', 20)])
    h.setModel('p/b@')
    await h.service.settingsChanged()
    expect(h.calls).not.toContain(`sync-model ${dot}`)
    await h.service.say('continue')
    const next = h.store.dotSessionId!
    expect(next).not.toBe(dot)
    expect(h.store.segment).toMatchObject({ reason: 'model-switch', model: 'p/b@' })
    expect(h.calls).toContain(`sync-model ${next}`)
  })

  it('delivers messages one at a time, each after the segment check before it', async () => {
    const h = setup()
    const dot = await h.service.ensureDot()
    h.events.set(dot, [human('a', 10), reply('b', 20)])
    h.setContext(OVER_THE_LINE)
    await Promise.all([h.service.say('one'), h.service.say('two')])
    const next = h.store.dotSessionId!
    expect(h.calls.filter(call => call.startsWith('say '))).toEqual([`say ${next} one`, `say ${next} two`])
    expect(h.store.pastSegments).toHaveLength(1)
  })
})

describe('DotService history', () => {
  /** One earlier segment, the current one, and a task session, each with something said in it. */
  async function threeSessions() {
    const h = setup()
    const first = await h.service.ensureDot()
    h.events.set(first, [human('ship v2 on friday', 10), reply('on it', 20)])
    h.setContext(OVER_THE_LINE)
    await h.service.onDotIdle(first)
    h.setContext({ live: false, compactions: 0 })
    const second = h.store.dotSessionId!
    await h.service.startTask({ cwd: '/proj', title: 'release', instruction: 'go' }, new AbortController().signal)
    const task = h.store.list()[0]!.sessionId
    h.events.set(task, [human('go', 30), reply('the friday build is green', 40), { type: 'tool/result', time: 41, data: { message: { content: [{ type: 'text', text: 'wrote friday.log' }] } } }])
    h.events.set(second, [human('how is it going', 50), reply('fine', 60)])
    return { h, first, second, task }
  }

  it('tells a new segment where the conversation before it can be read', async () => {
    const { h, first } = await threeSessions()
    expect(h.store.segment!.opening).toContain(`the immediately preceding session is ${first}`)
    expect(h.store.segment!.opening).toContain('dot_search_history')
  })

  it('finds a word in its earlier segments and in the task sessions, newest first', async () => {
    const { h, first, second, task } = await threeSessions()
    const all = await h.service.searchHistory({ query: 'FRIDAY' })
    expect(all).toContain('2 match(es) for "FRIDAY" (3 session(s) searched)')
    expect(all).toContain('Task "release · ')
    expect(all).toContain(`· ${task}`)
    expect(all).toContain('Assistant: the friday build is green')
    expect(all).toContain(`· ${first}`)
    expect(all).toContain('Human: ship v2 on friday')
    expect(all.indexOf(task)).toBeLessThan(all.indexOf(first))
    expect(all).not.toContain(`· ${second}`)
    // Tool results are searched only on request.
    expect(all).not.toContain('friday.log')
    expect(await h.service.searchHistory({ query: 'friday', tools: true })).toContain('Tool result: wrote friday.log')
  })

  it('narrows a search to its own conversation, to the tasks, or to one session', async () => {
    const { h, first, task } = await threeSessions()
    const own = await h.service.searchHistory({ query: 'friday', scope: 'own' })
    expect(own).toContain(first)
    expect(own).not.toContain(task)
    const tasks = await h.service.searchHistory({ query: 'friday', scope: 'tasks' })
    expect(tasks).toContain(task)
    expect(tasks).not.toContain(first)
    expect(await h.service.searchHistory({ query: 'friday', sessionId: first })).toContain('(1 session(s) searched)')
    expect(await h.service.searchHistory({ query: 'saturday' })).toContain('Nothing found for "saturday"')
    await expect(h.service.searchHistory({ query: '   ' })).rejects.toMatchObject({ code: 'dot/invalid' })
  })

  it('goes on past a session it cannot read, and says so when that session was the one asked for', async () => {
    const { h, first, task } = await threeSessions()
    h.unreadable.add(task)
    const all = await h.service.searchHistory({ query: 'friday' })
    expect(all).toContain('2 session(s) searched, 1 could not be read')
    expect(all).toContain(first)
    await expect(h.service.searchHistory({ query: 'friday', sessionId: task })).rejects.toMatchObject({ code: 'dot/unknown-session' })
    await expect(h.service.readHistory({ sessionId: task })).rejects.toMatchObject({ code: 'dot/unknown-session' })
  })

  it('reads an earlier segment back word for word', async () => {
    const { h, first, task } = await threeSessions()
    const around = await h.service.readHistory({ sessionId: first, seq: 0, before: 0, after: 1 })
    expect(around).toContain(`Your conversation, earlier session`)
    expect(around).toContain('seq 0 [')
    expect(around).toContain('Human: ship v2 on friday')
    expect(around).toContain('You: on it')
    // Without a position: the end of the session; a task's replies are not dot's own.
    const tail = await h.service.readHistory({ sessionId: task, tools: true })
    expect(tail).toContain('Assistant: the friday build is green')
    expect(tail).toContain('Tool result: wrote friday.log')
    await expect(h.service.readHistory({ sessionId: '  ' })).rejects.toMatchObject({ code: 'dot/invalid' })
  })
})

describe('DotService knowledge', () => {
  it('drains the active knowledge write, rejects queued work and closes the admission gate', async () => {
    const h = setup()
    await h.service.knowledgeView()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const write = h.store.setCognition.bind(h.store)
    h.store.setCognition = async (...args: Parameters<typeof write>) => { entered(); await gate; return write(...args) }
    const active = h.service.setCognition('accepted before shutdown')
    await started
    const queued = h.service.agreementAdd('queued before shutdown')
    const queuedResult = expect(queued).rejects.toMatchObject({ code: 'dot/disposed' })
    let finished = false
    const disposing = h.service.dispose().then(() => { finished = true })
    await expect(h.service.agreementAdd('submitted during shutdown')).rejects.toMatchObject({ code: 'dot/disposed' })
    await Promise.resolve()
    expect(finished).toBe(false)
    release()
    await active
    await queuedResult
    await disposing
    expect(h.store.cognition).toContain('accepted before shutdown')
    expect(h.store.agreements).not.toContain('queued before shutdown')
    const cognition = h.store.cognition
    const agreements = h.store.agreements
    await expect(h.service.setCognition('written after disposal')).rejects.toMatchObject({ code: 'dot/disposed' })
    await expect(h.service.agreementAdd('after disposal')).rejects.toMatchObject({ code: 'dot/disposed' })
    expect(h.store.cognition).toBe(cognition)
    expect(h.store.agreements).toBe(agreements)
  })
  it('freezes agreements and cognition into the segment and keeps it when dot changes them itself', async () => {
    const h = setup()
    await h.service.setAgreements('- use the standard preset\n')
    await h.service.setCognition('I notice you prefer short answers.')
    const dot = await h.service.ensureDot()
    expect(h.store.segment!.agreements).toContain('[agreements]')
    expect(h.store.segment!.agreements).toContain('standard preset')
    expect(h.store.segment!.cognition).toContain('[cognition]')
    expect(h.store.segment!.cognition).toContain('short answers')
    h.events.set(dot, [human('hi', 10), reply('hello', 20)])

    expect(await h.service.agreementAdd('never push to main')).toContain('Recorded as an agreement')
    expect(h.store.agreements).toContain('never push to main')
    expect(await h.service.cognitionRewrite('I notice you like detail.')).toContain('updated')
    expect(h.store.cognition).toBe('I notice you like detail.')
    // The frozen prompt of the running segment stays as it was built; dot's own change only moves the seen snapshot.
    expect(h.store.segment!.agreements).not.toContain('never push to main')
    expect(h.store.segment!.agreementsSeen).toContain('never push to main')
    expect(h.store.segment!.cognition).toContain('short answers')
    expect(h.store.segment!.cognitionSeen).toContain('like detail')
    await h.service.say('go on')
    expect(h.store.dotSessionId).toBe(dot)

    // The next segment starts with the blocks as they are by then.
    h.setContext(OVER_THE_LINE)
    await h.service.onDotIdle(dot)
    expect(h.store.dotSessionId).not.toBe(dot)
    expect(h.store.segment!.agreements).toContain('never push to main')
    expect(h.store.segment!.agreementsSeen).toBeUndefined()
    expect(h.store.segment!.cognition).toContain('like detail')
    expect(h.store.segment!.cognitionSeen).toBeUndefined()
  })

  it("takes the human's edit in place before dot has replied and in a new segment after", async () => {
    const h = setup()
    const dot = await h.service.ensureDot()
    expect(h.store.segment!.agreements).toBe('')
    expect((await h.service.setAgreements('- call me Captain\r\n\r\n')).agreements.text).toBe('- call me Captain\n')
    // A panel edit does not switch right away.
    expect(h.store.dotSessionId).toBe(dot)
    expect(h.store.segment!.agreements).toBe('')
    await h.service.say('hi')
    // Not replied yet: the untouched segment takes the current text in place.
    expect(h.store.dotSessionId).toBe(dot)
    expect(h.store.segment!.agreements).toContain('- call me Captain')

    h.events.set(dot, [human('hi', 10), reply('hello', 20)])
    await h.service.setAgreements('- call me Admiral')
    await h.service.say('ahoy')
    const next = h.store.dotSessionId!
    expect(next).not.toBe(dot)
    expect(h.store.segment).toMatchObject({ reason: 'prompt-changed' })
    expect(h.store.segment!.agreements).toContain('- call me Admiral')
    expect(h.calls).toContain(`say ${next} ahoy`)
  })

  it('does not swallow a human edit to one layer when dot changes the other in-session', async () => {
    const h = setup()
    const dot = await h.service.ensureDot()
    h.events.set(dot, [human('hi', 10), reply('hello', 20)])
    // The human edits the agreements in the panel; dot rewrites its cognition in the same segment.
    await h.service.setAgreements('- be terse')
    await h.service.cognitionRewrite('I feel you like detail.')
    // The agreements seen snapshot is still the pre-edit block, so the next message still moves.
    await h.service.say('continue')
    expect(h.store.dotSessionId).not.toBe(dot)
    expect(h.store.segment).toMatchObject({ reason: 'prompt-changed' })
    expect(h.store.segment!.agreements).toContain('be terse')
    expect(h.store.segment!.cognition).toContain('like detail')
  })

  it('takes the latest agreements change back once, whoever made it', async () => {
    const h = setup()
    await h.service.ensureDot()
    expect((await h.service.knowledgeView()).agreements).toEqual({ text: '', maxChars: 4000, canUndo: false })
    await expect(h.service.undoAgreements()).rejects.toMatchObject({ code: 'dot/nothing-to-undo' })
    await h.service.setAgreements('- call me Captain')
    await h.service.agreementAdd('likes tea')
    expect((await h.service.knowledgeView()).agreements).toMatchObject({ text: '- call me Captain\n- likes tea\n', canUndo: true })
    expect((await h.service.undoAgreements()).agreements).toMatchObject({ text: '- call me Captain\n', canUndo: true })
    // One step is kept: taking back again restores what was just taken back.
    expect((await h.service.undoAgreements()).agreements.text).toBe('- call me Captain\n- likes tea\n')
    await expect(h.service.setAgreements('x'.repeat(4001))).rejects.toMatchObject({ code: 'dot/invalid' })
  })

  it('rewrites cognition whole, keeps versions, rolls back, and lets the empty version return', async () => {
    const h = setup()
    await h.service.ensureDot()
    await h.service.cognitionRewrite('first')
    await h.service.cognitionRewrite('second')
    let view = await h.service.knowledgeView()
    expect(view.cognition.text).toBe('second')
    expect(view.cognition.history.map(version => version.text)).toEqual(['first', ''])
    const empty = view.cognition.history.find(version => version.text === '')!
    view = await h.service.restoreCognition(empty.at)
    expect(view.cognition.text).toBe('')
    // Restoring pushes the replaced text back onto the history too.
    expect(view.cognition.history[0]!.text).toBe('second')
    await expect(h.service.restoreCognition(-1)).rejects.toMatchObject({ code: 'dot/unknown-version' })
  })

  it('runs agreements changes one after another, so none is lost', async () => {
    const h = setup()
    await h.service.ensureDot()
    await Promise.all([h.service.agreementAdd('one'), h.service.agreementAdd('two'), h.service.agreementAdd('three')])
    expect(h.store.agreements).toBe('- one\n- two\n- three\n')
  })
})

describe('DotService knowledge migration', () => {
  it('waits for a delayed first-read migration before disposal returns', async () => {
    const h = setup()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    h.notes.readCognition = async () => { entered(); await gate; return 'legacy cognition' }
    const read = h.service.knowledgeView()
    await started
    let disposed = false
    const stopping = h.service.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(h.store.knowledgeMigrated).toBe(false)
    release()
    expect((await read).cognition.text).toContain('legacy cognition')
    await stopping
    expect(disposed).toBe(true)
    expect(h.store.knowledgeMigrated).toBe(true)
    expect(h.store.cognition).toContain('legacy cognition')
  })

  it('does not start a first-read migration after disposal', async () => {
    const h = setup()
    const read = vi.fn(async () => 'legacy cognition')
    h.notes.readCognition = read
    await h.service.dispose()
    await expect(h.service.knowledgeView()).rejects.toMatchObject({ code: 'dot/disposed' })
    expect(read).not.toHaveBeenCalled()
    expect(h.store.knowledgeMigrated).toBe(false)
    expect(h.store.cognition).toBe('')
  })
  it('imports the old policy into agreements, and the old state memory, notes file and cognition file into cognition', async () => {
    const h = setup({ policy: 'pushing to my own repos is fine' })
    h.notes.text = '- 普通开发任务用标准预设，不用破限\n- call me Captain\n'
    h.notes.cognition = 'I have learned that you like short answers.'
    await h.service.ensureDot()
    const view = await h.service.knowledgeView()
    expect(view.agreements.text).toContain('pushing to my own repos is fine')
    expect(view.agreements.text).not.toContain('普通开发任务用标准预设')
    expect(view.agreements.text).not.toContain('call me Captain')
    expect(agreementsSection(view.agreements.text)).toContain('pushing to my own repos is fine')
    expect(view.cognition.text).toContain('call me Captain')
    expect(view.cognition.text).toContain('I have learned that you like short answers.')
    // The import runs once: clearing it afterwards never pulls the old sources back in.
    await h.service.setAgreements('')
    await h.service.setCognition('')
    h.notes.text = '- a later edit of the file\n'
    const after = await h.service.knowledgeView()
    expect(after.agreements.text).toBe('')
    expect(after.cognition.text).toBe('')
  })

  it('turns the old policy into removable agreement items', async () => {
    const h = setup({ policy: '推送前问我' })
    await h.service.ensureDot()
    expect((await h.service.knowledgeView()).agreements.text).toContain('- 推送前问我')
    expect(await h.service.agreementRemove('推送前问我')).toContain('Removed this agreement')
    expect((await h.service.knowledgeView()).agreements.text).not.toContain('推送前问我')
  })

  it('imports the legacy state memory and notes file into cognition, keeping the old undo as a cognition history version', async () => {
    const h = setup({ policy: '推送前问我' })
    await h.store.setDot({ memory: 'state-held understanding', memoryUndo: '- an older rule\n' })
    h.notes.text = '- a rule from the notes file\n'
    await h.service.ensureDot()
    const view = await h.service.knowledgeView()
    expect(view.cognition.text).toContain('state-held understanding')
    expect(view.cognition.text).toContain('a rule from the notes file')
    expect(view.agreements.text).toContain('推送前问我')
    expect(view.agreements.text).not.toContain('a rule from the notes file')
    // The old single-step note undo becomes the previous cognition version, not an agreement undo.
    expect(view.cognition.history).toHaveLength(1)
    expect(view.cognition.history[0]!.text).toContain('an older rule')
    expect(typeof view.cognition.history[0]!.at).toBe('number')
  })

  it('preserves an empty legacy notes undo as an empty cognition history version', async () => {
    const h = setup({ policy: '推送前问我' })
    await h.store.setDot({ memoryUndo: '' })
    h.notes.text = '- 普通开发任务用标准预设，不用破限\n'
    await h.service.ensureDot()
    const view = await h.service.knowledgeView()
    expect(view.agreements.text).toBe('- 推送前问我\n')
    expect(view.cognition.text).toContain('普通开发任务用标准预设')
    expect(view.cognition.history).toHaveLength(1)
    expect(view.cognition.history[0]!.text).toBe('')
  })

  it('does not treat a failed import as done, and retries it next time', async () => {
    const h = setup()
    h.notes.text = '- important rule\n'
    const realCommit = h.store.commitKnowledgeMigration.bind(h.store)
    let failing = true
    h.store.commitKnowledgeMigration = async patch => {
      if (failing) throw new Error('disk writes are down')
      return realCommit(patch)
    }
    // The failure surfaces to the caller instead of being swallowed.
    await expect(h.service.ensureDot()).rejects.toThrow(/disk writes are down/)
    expect(h.store.knowledgeMigrated).toBe(false)
    failing = false
    const view = await h.service.knowledgeView()
    expect(h.store.knowledgeMigrated).toBe(true)
    expect(view.cognition.text).toContain('important rule')
  })

  it('does not mark the import done when a legacy read fails, and retries without losing the note', async () => {
    const h = setup()
    h.notes.text = '- must not be lost\n'
    const realRead = h.notes.read
    let failRead = true
    h.notes.read = async () => {
      if (failRead) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return realRead()
    }
    await expect(h.service.ensureDot()).rejects.toThrow(/permission denied/)
    expect(h.store.knowledgeMigrated).toBe(false)
    // While the import keeps failing, a write is refused too, so it can never hide the old note.
    await expect(h.service.agreementAdd('added while the import is broken')).rejects.toThrow(/permission denied/)
    expect(h.store.agreements).toBe('')
    failRead = false
    const view = await h.service.knowledgeView()
    expect(h.store.knowledgeMigrated).toBe(true)
    expect(view.cognition.text).toContain('must not be lost')
  })

  it('carries an imported cognition set whole past the write limit, keeping the tail note', async () => {
    const h = setup()
    h.notes.text = `- ${'x'.repeat(3000)}\n- the last note that must stay in force\n`
    h.notes.cognition = 'y'.repeat(1500)
    await h.service.ensureDot()
    const view = await h.service.knowledgeView()
    // The stored cognition exceeds the 4000-char new-write limit; the import is not clipped.
    expect(view.cognition.text.length).toBeGreaterThan(4000)
    expect(view.cognition.text).toContain('the last note that must stay in force')
  })

  it('does not read a legacy file whose target layer already has content', async () => {
    const h = setup()
    await h.store.setAgreements('- keep me\n')
    await h.store.setCognition('my own understanding')
    // Both target layers are already filled, so neither legacy file should be consulted.
    let noteReads = 0
    let cognitionReads = 0
    const realRead = h.notes.read
    const realCognition = h.notes.readCognition!
    h.notes.read = async () => { noteReads += 1; return realRead() }
    h.notes.readCognition = async () => { cognitionReads += 1; return realCognition() }
    await h.service.ensureDot()
    expect(h.store.knowledgeMigrated).toBe(true)
    expect(noteReads).toBe(0)
    expect(cognitionReads).toBe(0)
    const view = await h.service.knowledgeView()
    expect(view.agreements.text).toBe('- keep me\n')
    expect(view.cognition.text).toBe('my own understanding')
  })
})

describe('DotService background reflection delivery', () => {
  it('carries a pending agreement note once with the next human message and clears it', async () => {
    const h = setup()
    await h.service.ensureDot()
    await h.store.setAgreementNotes('agreement A conflicts with B')
    await h.service.say('hello')
    expect(h.said[0]!.carriedNotices).toContain('[dot agreement notes]')
    expect(h.said[0]!.carriedNotices).toContain('agreement A conflicts with B')
    expect(h.store.agreementNotes).toBe('')
    await h.service.say('again')
    expect(h.said[1]!.carriedNotices).toBeUndefined()
  })

  it('moves to a new segment before the next message when reflection changed cognition', async () => {
    const h = setup()
    const first = await h.service.ensureDot()
    h.events.set(first, [human('hi', 10), reply('hello', 20)])
    await h.service.setCognition('a fresh understanding', 'reflection')
    await h.service.say('next')
    expect(h.store.dotSessionId).not.toBe(first)
    expect(h.store.segment!.cognition).toContain('a fresh understanding')
  })

  it('never clears an agreement note a concurrent reflection submission wrote', async () => {
    const h = setup()
    await h.service.ensureDot()
    await h.store.setAgreementNotes('old note')
    // Hold host.say the way a slow delivery would, so a reflection submission
    // arrives while the human message is still in flight.
    let releaseSay!: () => void
    let enteredSay!: () => void
    const gate = new Promise<void>(resolve => { releaseSay = resolve })
    const entered = new Promise<void>(resolve => { enteredSay = resolve })
    const realSay = h.host.say.bind(h.host)
    h.host.say = async (...args: Parameters<typeof realSay>) => { enteredSay(); await gate; return realSay(...args) }
    // The runner itself is exercised in reflection.spec; here we only need its
    // write to observe the message lane, so stub the submission write.
    h.service.reflection.submit = async (_cognition: string, notes: string | undefined) => {
      await h.store.setAgreementNotes(notes ?? '')
      return 'saved'
    }
    const saying = h.service.say('hello')
    await entered
    const submitting = h.service.reflectionSubmit('new cognition', 'new note', 'ref-1')
    // The submission waits behind the in-flight message; nothing is written yet.
    expect(h.store.agreementNotes).toBe('old note')
    releaseSay()
    await saying
    await submitting
    // The message carried the old note and cleared it; the new note survives.
    expect(h.said[0]!.carriedNotices).toContain('old note')
    expect(h.store.agreementNotes).toBe('new note')
  })
})

describe('DotService reminders', () => {
  it('sets, lists and removes reminders and explains a request it cannot take', async () => {
    const h = setup()
    await h.service.ensureDot()
    const reply = await h.service.scheduleAdd({ title: 'Morning summary', prompt: 'Sum up the board.', dailyTime: '09:00' })
    const id = h.store.schedules[0]!.id
    expect(reply).toContain(id)
    expect(reply).toContain('daily at 09:00')
    expect(h.service.scheduleList()).toContain(`- ${id} "Morning summary" (daily at 09:00;`)
    expect(h.service.board().schedules.map(record => record.id)).toEqual([id])
    await expect(h.service.scheduleAdd({ title: 't', prompt: 'p' })).rejects.toMatchObject({ code: 'dot/invalid', message: expect.stringContaining('exactly one') })
    expect(await h.service.scheduleRemove(` ${id} `)).toBe(`Removed reminder ${id}.`)
    await expect(h.service.scheduleRemove(id)).rejects.toMatchObject({ code: 'dot/unknown-reminder' })
    expect(h.service.scheduleList()).toContain('No reminders set')
  })

  it('wakes the segment dot is in when a reminder set in an earlier one comes due', async () => {
    const h = setup()
    const first = await h.service.ensureDot()
    await h.service.scheduleAdd({ title: 'Check the release', prompt: 'Read the release task and report.', afterMinutes: 10 })
    h.events.set(first, [human('ship v2 on friday', 10), reply('on it', 20)])
    h.setContext(OVER_THE_LINE)
    await h.service.onDotIdle(first)
    const next = h.store.dotSessionId!
    expect(next).not.toBe(first)
    // The new segment is told which reminders it still owns.
    expect(h.store.segment!.opening).toContain('"Check the release"')
    h.setContext({ live: true, compactions: 0 })

    // Nothing fires before the plugin says dot's session can be opened.
    h.advance(10 * 60_000)
    expect(h.delays()).toEqual([])
    h.service.startReminders()
    expect(h.delays()).toEqual([0])
    h.fire()
    await vi.waitFor(() => expect(h.relayed).toHaveLength(1))
    expect(h.relayed[0]!.target).toBe(next)
    expect(h.relayed[0]!.text.startsWith(REMINDER_HEAD)).toBe(true)
    expect(h.relayed[0]!.text).toContain('Read the release task and report.')
    await vi.waitFor(() => expect(h.store.schedules.map(record => record.deliveredAt)).toEqual([1000 + 10 * 60_000]))
    // The periodic reflection check keeps the clock armed even with no reminders.
    expect(h.delays()).toEqual([30 * 60_000])
  })

  it('moves to a new segment first when one is due as the reminder fires', async () => {
    const h = setup()
    const first = await h.service.ensureDot()
    await h.service.scheduleAdd({ title: 'Pulse', prompt: 'Look at the board.', everyMinutes: 30 })
    h.service.startReminders()
    h.events.set(first, [human('hi', 10), reply('hello', 20)])
    await h.store.setSettings({ ...DEFAULT_SETTINGS, persona: 'A calm librarian.' })
    h.advance(30 * 60_000)
    h.fire()
    await vi.waitFor(() => expect(h.relayed).toHaveLength(1))
    const next = h.store.dotSessionId!
    expect(next).not.toBe(first)
    expect(h.relayed[0]!.target).toBe(next)
    await vi.waitFor(() => expect(h.store.schedules[0]).toMatchObject({ nextAt: 1000 + 60 * 60_000 }))
  })

  it('carries held updates when a reminder wakes dot', async () => {
    const h = setup()
    const dot = await h.service.ensureDot()
    await h.service.watch('watched-task', 'keep an eye on it')
    await h.service.onTurnEnd('watched-task')
    await h.service.scheduleAdd({ title: 'Pulse', prompt: 'Look at the board.', afterMinutes: 10 })
    h.service.startReminders()
    h.advance(10 * 60_000)
    h.fire()
    await vi.waitFor(() => expect(h.relayed).toHaveLength(1))
    expect(h.relayed[0]).toMatchObject({ target: dot })
    expect(h.relayed[0]!.text.startsWith(REMINDER_HEAD)).toBe(true)
    expect(h.relayed[0]!.text).toContain('watched-task')
  })

  it('stops the clock when the service is disposed', async () => {
    const h = setup()
    await h.service.ensureDot()
    h.service.startReminders()
    await h.service.scheduleAdd({ title: 'Pulse', prompt: 'p', everyMinutes: 30 })
    expect(h.delays()).toEqual([30 * 60_000])
    h.service.dispose()
    expect(h.delays()).toEqual([])
  })
})

describe('idle delivery and reconciliation', () => {
  it('cancels startup reconciliation after shutdown while draining the delayed session query', async () => {
    const h = setup({ idleCheckMinutes: 10 })
    const dot = await h.service.ensureDot()
    await h.service.startTask({ cwd: '/proj', title: 'work', instruction: 'go' }, new AbortController().signal)
    const task = h.store.list()[0]!
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    h.host.listSessions = async () => { entered(); await gate; return [{ sessionId: task.sessionId, cwd: task.cwd, running: true, updatedAt: 1, blank: false, subagent: false, archived: false }] }
    const changes = vi.fn()
    h.store.onChange(changes)
    h.service.startReminders()
    await started
    const before = h.store.task(task.sessionId)
    let disposed = false
    const stopping = h.service.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    changes.mockClear()
    release()
    await stopping
    expect(h.store.task(task.sessionId)).toEqual(before)
    expect(changes).not.toHaveBeenCalled()
    expect(h.relayed).toEqual([])
    expect(h.delays()).toEqual([])
    h.service.startReminders()
    h.service.onStatus(dot, 'idle')
    await h.service.onDotIdle(dot)
    expect(h.delays()).toEqual([])
    await expect(h.service.reconcile()).rejects.toMatchObject({ code: 'dot/disposed' })
  })

  it('does not begin startup reconciliation when immediately disposed', async () => {
    const h = setup({ idleCheckMinutes: 10 })
    const list = vi.fn(async () => [])
    h.host.listSessions = list
    h.service.startReminders()
    await h.service.dispose()
    expect(list).not.toHaveBeenCalled()
    expect(h.delays()).toEqual([])
  })

  it('drains delayed overview and session reads without marking data seen during shutdown', async () => {
    const h = setup()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    h.host.listSessions = async () => { entered(); await gate; return [] }
    const mark = vi.spyOn(h.store, 'markAllSeen')
    const overview = h.service.overview(new AbortController().signal)
    const rejected = expect(overview).rejects.toMatchObject({ code: 'dot/disposed' })
    await started
    let disposed = false
    const stopping = h.service.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await rejected
    await stopping
    expect(mark).not.toHaveBeenCalled()
    await expect(h.service.read('old')).rejects.toMatchObject({ code: 'dot/disposed' })
  })
  it('drains a delayed latest-reply read without marking the session seen', async () => {
    const h = setup()
    await h.service.watch('watched', 'goal')
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    h.host.latestReply = async () => { entered(); await gate; return 'reply' }
    const mark = vi.spyOn(h.store, 'markSeen')
    const read = h.service.read('watched')
    const rejected = expect(read).rejects.toMatchObject({ code: 'dot/disposed' })
    await started
    let disposed = false
    const stopping = h.service.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await rejected
    await stopping
    expect(mark).not.toHaveBeenCalled()
  })

  it('rearms the idle check for the remaining time after an approval is withdrawn', async () => {
    const h = setup({ idleCheckMinutes: 10 })
    const dot = await h.service.ensureDot()
    h.service.onStatus(dot, 'idle')
    expect(h.delays()).toContain(600_000)
    h.advance(120_000)
    const request = h.service.relayRequest({ kind: 'approval', sessionId: 'other', subject: 'pwsh' })
    if (request.decided !== 'pending') throw new Error('expected pending')
    request.withdraw()
    expect(h.delays()).toContain(480_000)
    await h.service.dispose()
  })
  it('tells a routine check to stay silent when the human has nothing to see', async () => {
    const h = setup({ idleCheckMinutes: 10 })
    const dot = await h.service.ensureDot()
    await h.service.createWorkChange({ title: 'Ready', goal: 'g', cwd: '/ready', at: 1 })
    h.service.onStatus(dot, 'idle')
    h.fire()
    await h.service.flushNotices()
    const text = h.relayed.map(row => row.text).join('\n')
    expect(text).toContain('Routine check:')
    expect(text).toContain('Do not announce that you are waiting')
    expect(text).toContain('not even a note declaring that you are silent')
    expect(text).not.toContain('consecutive unsuccessful')
  })
  it('holds updates while dot is running and delivers once idle', async () => {
    const h = setup()
    const dot = await h.service.ensureDot()
    h.running.add(dot)
    h.service.notify({ sessionId: 'task', kind: 'error', text: 'failed', at: 1 })
    await h.service.flushNotices()
    expect(h.relayed).toEqual([])
    h.running.delete(dot)
    await h.service.flushNotices()
    expect(h.relayed).toHaveLength(1)
    expect(h.relayed[0]!.text).toContain('failed')
  })
  it('reconciles existing and missing task sessions without moving tickets', async () => {
    const h = setup()
    await h.store.track({ sessionId: 'legacy-a', origin: 'started', title: 'a', goal: 'go', cwd: '/proj', at: 1 })
    await h.store.track({ sessionId: 'legacy-b', origin: 'started', title: 'b', goal: 'go', cwd: '/elsewhere', at: 1 })
    await h.store.migrateTickets()
    const rows = h.store.list()
    const existing = rows.find(row => row.title === 'a')!
    const missing = rows.find(row => row.title === 'b')!
    h.host.listSessions = async () => [{ sessionId: existing.sessionId, cwd: existing.cwd, running: true, updatedAt: 1, blank: false, subagent: false, archived: false }]
    await h.service.reconcile()
    expect(h.store.task(existing.sessionId)?.status).toBe('running')
    expect(h.store.task(missing.sessionId)?.status).toBe('archived')
    expect(h.store.listTickets()).toHaveLength(2)
    expect(h.store.listTickets().every(row => row.status === 'active')).toBe(true)
  })
})

describe('DotService WorkBook sessions', () => {
  it('launches a read run under the selected model and preset, records ownership, and refuses unrecorded followups', async () => {
    const h = setup()
    await h.service.ensureDot()
    const reply = await h.service.startTask({ cwd: '/proj', title: 'Inspect', instruction: 'report', preset: 'cordis', model: 'p/big', access: 'read' }, new AbortController().signal)
    const run = h.store.work.listRuns()[0]!
    expect(reply).toContain(`started ${run.id}`)
    expect(run).toMatchObject({ phase: 'active', access: 'read', expectedPreset: 'cordis' })
    expect(h.store.tracks(run.sessionId!)).toBe(true)
    // The prompt is the rendered work order, not dot's raw instruction.
    expect(h.calls.indexOf(`model ${run.sessionId} p/big`)).toBeLessThan(h.calls.findIndex(call => call.startsWith(`prompt ${run.sessionId} `)))
    expect(h.calls).toContain(`readonly ${run.sessionId}`)
    expect(h.store.listTickets()).toEqual([])
    await expect(h.service.send(run.sessionId!, 'more')).rejects.toMatchObject({ code: 'dot/legacy-closed' })
    expect(h.relayed).toEqual([])
    await h.service.dispose()
  })

  it('refuses unavailable models and presets before creating a session', async () => {
    const h = setup({ taskModels: { mode: 'deny', list: ['p/big'] } })
    const signal = new AbortController().signal
    await expect(h.service.startTask({ cwd: '/proj', title: 't', instruction: 'go', model: 'p/big' }, signal)).rejects.toMatchObject({ code: 'dot/model-not-allowed' })
    await expect(h.service.startTask({ cwd: '/proj', title: 't', instruction: 'go', preset: 'dot' }, signal)).rejects.toMatchObject({ code: 'dot/unknown-preset' })
    expect(h.calls.some(call => call.startsWith('create '))).toBe(false)
    expect(h.store.list()).toEqual([])
    await h.service.dispose()
  })

  it('refuses read-only dispatch when the host cannot enforce its access', async () => {
    const h = setup()
    h.failPermission()
    const result = await h.service.startTask({ cwd: '/proj', title: 't', instruction: 'go', access: 'read' }, new AbortController().signal)
    expect(result).toContain('not started')
    expect(h.calls.some(call => call.startsWith('prompt '))).toBe(false)
    expect(h.store.work.occupying()).toHaveLength(1)
    await h.service.dispose()
  })
})

describe('DotService approval grace', () => {
  async function withGrace(run: (h: ReturnType<typeof setup>, service: DotService) => Promise<void>) {
    vi.useFakeTimers()
    const h = setup()
    const service = new DotService({ host: h.host, store: h.store, homeDir: join(tmpdir(), 'dsh-dot-spec'), notes: h.notes })
    try {
      await service.ensureDot()
      await run(h, service)
    } finally {
      service.dispose()
      h.service.dispose()
      vi.useRealTimers()
    }
  }

  it('drops approvals settled within the default ten seconds without a wake', async () => {
    await withGrace(async (h, service) => {
      const routed = service.relayRequest({ kind: 'approval', sessionId: 'task', subject: 'pwsh' })
      if (routed.decided !== 'pending') throw new Error('expected pending')
      await vi.advanceTimersByTimeAsync(2000)
      routed.withdraw()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(h.relayed).toEqual([])
      expect(service.board().pending).toEqual([])
    })
  })

  it('reports already settled after a request was delivered, without applying a late answer', async () => {
    await withGrace(async (h, service) => {
      const routed = service.relayRequest({ kind: 'approval', sessionId: 'task', subject: 'pwsh' })
      if (routed.decided !== 'pending') throw new Error('expected pending')
      await vi.advanceTimersByTimeAsync(9999)
      expect(h.relayed).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(h.relayed).toHaveLength(1)
      routed.withdraw()
      expect(service.answer(routed.id, { kind: 'approval', allow: true })).toContain('Already settled:')
      await expect(routed.settled).resolves.toBeUndefined()
      expect(() => service.answer('ap-missing', { kind: 'approval', allow: true })).toThrow(/no known request/)
    })
  })

  it('carries an approval with a human message, even within its grace period', async () => {
    await withGrace(async (h, service) => {
      const routed = service.relayRequest({ kind: 'approval', sessionId: 'task', subject: 'pwsh' })
      if (routed.decided !== 'pending') throw new Error('expected pending')
      await service.say('hello')
      expect(h.said[0]?.carriedNotices).toContain(routed.id)
      service.relayRequest({ kind: 'question', sessionId: 'other', subject: 'which?' })
      await vi.advanceTimersByTimeAsync(1500)
      expect(h.relayed).toHaveLength(1)
      expect(h.relayed[0]?.text).not.toContain(routed.id)
      routed.withdraw()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(h.relayed).toHaveLength(1)
    })
  })
})

describe('DotService.relayRequest', () => {
  it('forwards structured notice facts without parsing user text or storing undefined members', async () => {
    const h = setup()
    await h.service.ensureDot()
    h.service.relayRequest({ kind: 'question', sessionId: 'other', subject: 'A | B {literal}', questions: [{ id: 'pick', question: 'Which | one?' }] })
    await h.service.flushNotices()
    const notice = h.relayed.at(-1)?.notice
    expect(notice?.entries[0]).toMatchObject({ kind: 'question', subject: 'A | B {literal}', questions: [{ id: 'pick', question: 'Which | one?' }] })
    const question = (notice?.entries[0] as { questions: readonly object[] }).questions[0]!
    expect(Object.hasOwn(question, 'options')).toBe(false)
    expect(Object.hasOwn(question, 'multiSelect')).toBe(false)
    h.service.notify({ kind: 'error', sessionId: 'other', text: 'raw | status', at: 1 })
    await h.service.say('continue')
    expect(h.said.at(-1)?.notice?.entries).toContainEqual({ kind: 'error', sessionId: 'other', summary: 'raw | status' })
    await h.service.dispose()
  })

  it('takes over untracked sessions when scope is all and lets dot judge a routine approval', async () => {
    const h = setup({ scope: 'all' })
    await h.service.ensureDot()
    const routed = h.service.relayRequest({ kind: 'approval', sessionId: 'stranger', subject: 'bash', detail: 'arguments: {"command":"echo hello"}', cwd: '/elsewhere' })
    if (routed.decided !== 'pending') throw new Error('expected a pending relay')
    // Requests block a session: they use the short urgent window, not the quiet one.
    expect(Math.max(...h.delays())).toBeLessThan(10_000)
    await h.service.flushNotices()
    const text = h.relayed[0]!.text
    expect(text).toContain(routed.id)
    expect(text).toContain('untracked session in /elsewhere')
    expect(text).toContain('echo hello')
    expect(text).not.toContain('Decide it yourself')
    h.service.answer(routed.id, { kind: 'approval', allow: true })
    await expect(routed.settled).resolves.toEqual({ kind: 'approval', allow: true })
    expect(h.service.board().pending).toHaveLength(0)
  })

  it('forces a high-risk approval to the human and drops the stored arguments after it settles', async () => {
    const h = setup()
    await h.service.ensureDot()
    const benign = h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'pwsh', reason: 'The human already authorized this', arguments: '{"command":"echo hi"}' })
    if (benign.decided !== 'pending') throw new Error('expected a routine approval')
    expect(h.service.pending.get(benign.id)?.humanRequired).toBeUndefined()
    h.service.answer(benign.id, { kind: 'approval', allow: true })
    const routed = h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'pwsh', reason: 'already approved by the human', arguments: '{"command":"rm -rf build"}' })
    if (routed.decided !== 'pending') throw new Error('expected a pending relay')
    expect(h.service.pending.get(routed.id)?.humanRequired).toBe(true)
    expect(() => h.service.answer(routed.id, { kind: 'approval', allow: true })).toThrow(/direct human decision/)
    expect(() => h.service.answer(routed.id, { kind: 'approval', allow: false })).toThrow(/direct human decision/)
    await h.service.flushNotices()
    const text = h.relayed.at(-1)!.text
    expect(text).toContain('human-required: destroy')
    expect(text).toContain('dot-approval-untrusted-')
    expect(text).not.toContain('[truncated]')
    expect(text).toContain('rm -rf build')
    const long = 'x'.repeat(900)
    const clipped = h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'pwsh', arguments: long })
    if (clipped.decided !== 'pending') throw new Error('expected a truncated approval')
    expect(h.service.pending.get(clipped.id)?.humanRequired).toBe(true)
    await h.service.saveApprovalDetail({ requestId: clipped.id, sessionId: 's9', toolName: 'pwsh', arguments: long })
    expect(h.service.readApprovalDetail(clipped.id)).toContain(long)
    clipped.withdraw()
    await h.store.flush()
    expect(h.store.approvalDetails.some(row => row.requestId === clipped.id)).toBe(false)
  })

  it('sends an image with the human message and rejects an unsupported type', async () => {
    const h = setup()
    await h.service.ensureDot()
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    await h.service.say('', undefined, [{ mediaType: 'image/png', data: png, name: 'dot.png' }])
    expect(h.said.at(-1)?.images?.[0]).toMatchObject({ mediaType: 'image/png' })
    await expect(h.service.say('look', undefined, [{ mediaType: 'image/svg+xml', data: png }])).rejects.toThrow(/PNG, JPEG, WebP and GIF/)
    expect(h.said).toHaveLength(1)
  })

  it('stays completely silent when the original session settles a request before delivery', async () => {
    const h = setup()
    await h.service.ensureDot()
    const routed = h.service.relayRequest({ kind: 'approval', sessionId: 'stranger', subject: 'pwsh', cwd: '/proj' })
    if (routed.decided !== 'pending') throw new Error('expected a pending relay')
    routed.withdraw()
    await expect(routed.settled).resolves.toBeUndefined()
    await h.service.flushNotices()
    expect(h.relayed).toHaveLength(0)
    expect(h.service.board().pending).toHaveLength(0)
  })

  it('also removes questions settled in the original session and explains late answers', async () => {
    const h = setup()
    await h.service.ensureDot()
    const routed = h.service.relayRequest({ kind: 'question', sessionId: 'task', subject: 'which?', questions: [{ id: 'choice', question: 'which?' }] })
    if (routed.decided !== 'pending') throw new Error('expected pending')
    routed.withdraw()
    await h.service.flushNotices()
    expect(h.relayed).toEqual([])
    expect(h.service.answer(routed.id, { kind: 'question', answers: [{ id: 'choice', selected: [] }] })).toContain('Already settled:')
  })

  it('skips untracked sessions when the scope is tracked, and dot itself always', async () => {
    const h = setup({ scope: 'tracked' })
    const dot = await h.service.ensureDot()
    expect(h.service.relayRequest({ kind: 'approval', sessionId: 'stranger', subject: 'bash' })).toEqual({ decided: 'skip' })
    expect(h.service.relayRequest({ kind: 'approval', sessionId: dot, subject: 'bash' })).toEqual({ decided: 'skip' })
  })

  it('requires the original human question channel and rejects a model-supplied production answer', async () => {
    const h = setup({ questions: 'human' })
    await h.service.ensureDot()
    const questions = [{ id: 'environment', question: 'Target environment?', detail: 'Select the target', options: [{ label: 'staging', description: 'Test' }, { label: 'production', description: 'Live' }], multiSelect: false }]
    const routed = h.service.relayRequest({ kind: 'question', sessionId: 's9', subject: questions[0]!.question, questions })
    if (routed.decided !== 'pending') throw new Error('expected pending')
    expect(h.service.pending.get(routed.id)?.questions).toEqual(questions)
    expect(() => h.service.answer(routed.id, { kind: 'question', answers: [{ id: 'environment', selected: [], custom: 'production' }] })).toThrow(/direct human answer/)
    expect(h.service.pending.get(routed.id)).toBeDefined()
    await h.service.flushNotices()
    expect(h.relayed[0]?.text).toContain('answer the original question in its session')
    // The original native question answerer wins the existing race and withdraws this relay.
    routed.withdraw()
    await expect(routed.settled).resolves.toBeUndefined()
  })

  it('applies the human question rule to already pending requests', async () => {
    const h = setup({ questions: 'dot' })
    await h.service.ensureDot()
    const routed = h.service.relayRequest({ kind: 'question', sessionId: 's9', subject: 'Target?', questions: [{ id: 'env', question: 'Target?' }] })
    if (routed.decided !== 'pending') throw new Error('expected pending')
    await h.store.setSettings({ ...h.store.settings, questions: 'human' })
    expect(() => h.service.answer(routed.id, { kind: 'question', answers: [{ id: 'env', selected: [], custom: 'production' }] })).toThrow(/direct human answer/)
    expect(h.service.pending.get(routed.id)).toBeDefined()
    routed.withdraw()
  })

  it('requires a bound human decision when approvals are human-controlled', async () => {
    const h = setup({ approvals: 'human' })
    await h.service.ensureDot()
    const request = h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'pwsh' })
    if (request.decided !== 'pending') throw new Error('expected pending')
    expect(() => h.service.answer(request.id, { kind: 'approval', allow: true })).toThrow(/direct human decision/)
    expect(h.service.pending.get(request.id)).toBeDefined()
    request.withdraw()
    await expect(request.settled).resolves.toBeUndefined()
  })
  it('retains full approval arguments and identity for cards and model reads', async () => {
    const h = setup({ approvals: 'human' })
    await h.service.ensureDot()
    const args = JSON.stringify({ command: `${'x'.repeat(2500)}; npm publish` })
    const request = h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'pwsh', detail: `arguments: ${args}` })
    if (request.decided !== 'pending') throw new Error('expected pending')
    const detail = { requestId: request.id, sessionId: 's9', callerSessionId: 'sub1', callId: 'call-1', toolName: 'pwsh', reason: 'run', arguments: args }
    await h.service.saveApprovalDetail(detail)
    const card = await h.service.presentCard({ title: '', interactive: true, view: { type: 'confirm', id: 'x' } }, 'call', request.id)
    expect(h.service.cards.pending('call')?.approvalDetail).toEqual(detail)
    expect(JSON.parse(h.service.readApprovalDetail(request.id))).toEqual(detail)
    expect(h.service.cards.pending('call')?.approvalDetail?.arguments).toContain('npm publish')
    expect(card.viewId).toBeTruthy()
    request.withdraw()
  })

  it('commits approval despite notification failure and retries only notification', async () => {
    const h = setup({ approvals: 'human' })
    await h.service.ensureDot()
    const request = h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'pwsh' })
    if (request.decided !== 'pending') throw new Error('expected pending')
    const card = await h.service.presentCard({ title: '', interactive: true, view: { type: 'confirm', id: 'x' } }, 'call', request.id)
    const originalSay = h.host.say.bind(h.host)
    h.host.say = async () => { throw new Error('session unavailable') }
    await expect(h.service.answerCard(card.viewId!, 'approval', { confirmed: true })).resolves.toEqual({ notificationPending: true })
    await expect(request.settled).resolves.toEqual({ kind: 'approval', allow: true })
    expect(h.store.cards.find(row => row.id === card.viewId)).toMatchObject({ notificationPending: true, answer: { values: { confirmed: true } } })
    await expect(h.service.answerCard(card.viewId!, 'approval', { confirmed: true })).rejects.toThrow(/already answered/)
    h.host.say = originalSay
    await h.service.retryCardNotification(card.viewId!)
    expect(h.store.cards.find(row => row.id === card.viewId)?.notificationPending).toBe(false)
    expect(h.said).toHaveLength(1)
    await expect(h.service.retryCardNotification(card.viewId!)).rejects.toThrow(/no pending/)
  })

  it('binds approval cards to the request rather than the model reply', async () => {
    const h = setup({ approvals: 'human' })
    await h.service.ensureDot()
    const request = h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'pwsh' })
    if (request.decided !== 'pending') throw new Error('expected pending')
    const card = await h.service.presentCard({ title: 'ignored', interactive: true, view: { type: 'confirm', id: 'ignored' } }, 'call', request.id)
    await h.service.answerCard(card.viewId!, 'approval', { confirmed: true })
    await expect(request.settled).resolves.toEqual({ kind: 'approval', allow: true })
  })
  it('rejects an old approval card after the pending hub is recreated', async () => {
    const h = setup({ approvals: 'human' })
    await h.service.ensureDot()
    const old = h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'old request' })
    if (old.decided !== 'pending') throw new Error('expected pending')
    const card = await h.service.presentCard({ title: '', interactive: true, view: { type: 'confirm', id: 'x' } }, 'old-call', old.id)
    await h.service.dispose()
    const restarted = new DotService({ host: h.host, store: h.store, homeDir: join(tmpdir(), 'dsh-dot-spec'), notes: h.notes })
    const fresh = restarted.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'new request' })
    if (fresh.decided !== 'pending') throw new Error('expected pending')
    expect(fresh.id).not.toBe(old.id)
    await expect(restarted.answerCard(card.viewId!, 'approval', { confirmed: true })).rejects.toThrow(/no longer pending/)
    expect(restarted.pending.get(fresh.id)).toBeDefined()
    await restarted.dispose()
  })
  it('relays every approval to the human under the human rule', async () => {
    const h = setup({ questions: 'human', approvals: 'human' })
    await h.service.ensureDot()
    await h.service.watch('s9', 'keep it green')
    const routed = h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'bash' })
    if (routed.decided !== 'pending') throw new Error('expected a pending relay')
    await h.service.flushNotices()
    expect(h.relayed[0]!.text).not.toContain('Never decide it yourself')
    expect(h.relayed[0]!.text).toContain('task "s9"')
  })

  it('does not grant an in-flight approval after the human switches to deny', async () => {
    const h = setup()
    await h.service.ensureDot()
    const routed = h.service.relayRequest({ kind: 'approval', sessionId: 'task', subject: 'pwsh' })
    if (routed.decided !== 'pending') throw new Error('expected pending')
    await h.store.setSettings({ ...h.store.settings, approvals: 'deny' })
    expect(h.service.answer(routed.id, { kind: 'approval', allow: true })).toContain('approvals=deny; no grant')
    await expect(routed.settled).resolves.toEqual({ kind: 'approval', allow: false })
  })

  it('enforces deny approvals and off questions immediately, reading settings live', async () => {
    const h = setup()
    await h.service.ensureDot()
    await h.store.setSettings({ ...h.store.settings, approvals: 'dot' })
    expect(h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'bash' }).decided).toBe('pending')
    expect(h.service.relayRequest({ kind: 'question', sessionId: 's9', subject: 'Which?', questions: [{ id: 'q', question: 'Which?' }] }).decided).toBe('pending')

    await h.store.setSettings({ ...h.store.settings, approvals: 'deny', questions: 'off' })
    expect(h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'bash' })).toEqual({ decided: 'deny' })
    expect(h.service.relayRequest({ kind: 'question', sessionId: 's9', subject: 'Which?', questions: [{ id: 'q', question: 'Which?' }] })).toEqual({ decided: 'skip' })
  })

  it("keeps the human's rules in the agreements rather than repeating them in notices", async () => {
    const h = setup({ policy: 'pushing to my own repos is fine' })
    await h.service.ensureDot()
    h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'bash' })
    await h.service.flushNotices()
    expect(h.relayed[0]!.text).not.toContain('pushing to my own repos is fine')
    expect(h.store.agreements).toContain('pushing to my own repos is fine')
  })

  it('archiving a task dot started declines its waiting requests', async () => {
    const h = setup()
    await h.service.ensureDot()
    await h.service.startTask({ cwd: '/proj', title: 't', instruction: 'go' }, new AbortController().signal)
    const id = h.store.list()[0]!.sessionId
    const routed = h.service.relayRequest({ kind: 'approval', sessionId: id, subject: 'bash' })
    if (routed.decided !== 'pending') throw new Error('expected a pending relay')
    const run = h.store.work.sessionRun(id)!
    expect((await h.service.finishWorkRun(run.id, 'completed')).ok).toBe(true)
    expect(await h.service.archive(id)).toBe(`Archived ${id}.`)
    await expect(routed.settled).resolves.toEqual({ kind: 'approval', allow: false })
    expect(h.calls).toContain(`archive ${id}`)
    expect(h.store.task(id)!.status).toBe('archived')
  })

  it('refuses to archive a session dot did not start, watched or not', async () => {
    const h = setup()
    await h.service.ensureDot()
    await h.service.watch('s9', 'g')
    const routed = h.service.relayRequest({ kind: 'approval', sessionId: 's9', subject: 'bash' })
    if (routed.decided !== 'pending') throw new Error('expected a pending relay')
    await expect(h.service.archive('s9')).rejects.toMatchObject({ code: 'dot/not-yours' })
    await expect(h.service.archive('s-unknown')).rejects.toMatchObject({ code: 'dot/not-yours' })
    expect(h.calls.some(call => call.startsWith('archive '))).toBe(false)
    expect(h.store.task('s9')!.status).not.toBe('archived')
    // The request of the session that stays is still waiting for an answer.
    expect(h.service.board().pending).toHaveLength(1)
  })

  it('a session dot started stays its own after it is watched again', async () => {
    const h = setup()
    await h.service.ensureDot()
    await h.service.startTask({ cwd: '/proj', title: 't', instruction: 'go' }, new AbortController().signal)
    const id = h.store.list()[0]!.sessionId
    await h.service.watch(id, 'new goal')
    expect(h.store.task(id)!.origin).toBe('started')
    const run = h.store.work.sessionRun(id)!
    expect((await h.service.finishWorkRun(run.id, 'completed')).ok).toBe(true)
    await expect(h.service.archive(id)).resolves.toBe(`Archived ${id}.`)
  })
})

describe('closed legacy work entries', () => {
  it('refuses ticket dispatch, mutation and review without creating a ticket or a run', async () => {
    const h = setup()
    await expect(h.service.manageTask({ action: 'move', task_id: 't-1', to: 'active', reason: 'go' })).rejects.toMatchObject({ code: 'dot/legacy-closed' })
    await expect(h.service.cancelTask('t-1')).rejects.toMatchObject({ code: 'dot/legacy-closed' })
    await expect(h.service.reviewTask('t-1', true)).rejects.toMatchObject({ code: 'dot/legacy-closed' })
    expect(h.store.listTickets()).toEqual([])
    expect(h.store.work.occupying()).toEqual([])
    const change = await h.service.createWorkChange({ title: 'Ship', cwd: 'H:\\proj', goal: 'land it', at: 1 })
    const reserved = await h.service.reserveWorkRun({ changeId: change.id, cwd: 'H:\\proj\\docs', writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\docs\\a.md', type: 'file' }] }, at: 2 })
    if (!reserved.ok) throw new Error(reserved.message)
    expect(h.service.store.work.dispatchAllowed(reserved.run.id).ok).toBe(false)
    expect(h.store.task('watched')).toBeUndefined()
    await h.store.track({ sessionId: 'watched', origin: 'watched', title: 'Watch', goal: '', cwd: '/w', at: 3 })
    expect(h.store.task('watched')?.origin).toBe('watched')
    await h.store.track({ sessionId: 'old-started', origin: 'started', title: 'Old', goal: 'g', cwd: '/proj', at: 4 })
    await expect(h.service.send('old-started', 'continue the old task')).rejects.toMatchObject({ code: 'dot/legacy-closed' })
    await expect(h.service.send(reserved.run.requestedSessionId, 'start writing')).rejects.toMatchObject({ code: 'dot/legacy-closed' })
    expect(h.relayed).toEqual([])
    const home = join(tmpdir(), 'dsh-dot-spec')
    rmSync(join(home, 'artifacts'), { recursive: true, force: true })
    const project = mkdtempSync(join(tmpdir(), 'dot-baseline-'))
    const docs = join(project, 'docs')
    mkdirSync(docs)
    writeFileSync(join(docs, 'a.md'), 'whole')
    writeFileSync(join(docs, 'b.md'), 'other')
    const rooted = await h.service.createWorkChange({ title: 'Rooted', cwd: project, goal: 'capture', maxConcurrentRuns: 4, at: 5 })
    const fileRun = await h.service.reserveWorkRun({
      changeId: rooted.id, cwd: project, root: { workspaceRoot: project },
      writeScope: { kind: 'paths', paths: [{ path: join(docs, 'a.md'), type: 'file' }] }, at: 6,
    })
    if (!fileRun.ok) throw new Error(fileRun.message)
    expect(await h.service.publishWorkBaseline(fileRun.run.id, h.store.work.revision, 'not-there')).toMatchObject({ code: 'baseline' })
    const missed = join(home, 'artifacts', 'missed')
    saveSnapshot(missed, [], undefined, { root: project, empty: true })
    expect(await h.service.publishWorkBaseline(fileRun.run.id, h.store.work.revision, 'missed')).toMatchObject({ code: 'baseline' })
    const wrong = join(home, 'artifacts', 'wrong-root')
    saveSnapshot(wrong, [{ path: 'docs/a.md', body: new TextEncoder().encode('whole') }], undefined, { root: join(project, 'elsewhere') })
    expect(await h.service.publishWorkBaseline(fileRun.run.id, h.store.work.revision, 'wrong-root')).toMatchObject({ code: 'baseline' })
    const broken = join(home, 'artifacts', 'broken')
    const saved = saveSnapshot(broken, [{ path: 'docs/a.md', body: new TextEncoder().encode('whole') }], undefined, { root: project })
    writeFileSync(join(broken, 'blobs', saved.saved[0]!.sha256), new Uint8Array([1]))
    expect(await h.service.publishWorkBaseline(fileRun.run.id, h.store.work.revision, 'broken')).toMatchObject({ code: 'baseline' })
    const covered = join(home, 'artifacts', 'covered')
    saveSnapshot(covered, [{ path: 'docs/a.md', body: new TextEncoder().encode('whole') }], undefined, { root: project })
    const published = await h.service.publishWorkBaseline(fileRun.run.id, h.store.work.revision, 'covered')
    expect(published).toMatchObject({ applied: true })
    expect(h.service.store.work.dispatchAllowed(fileRun.run.id)).toEqual({ ok: true })
    expect(readFileSync(join(covered, 'manifest.json'), 'utf8')).toContain('docs/a.md')
    const emptyDir = mkdtempSync(join(tmpdir(), 'dot-empty-'))
    const emptyChange = await h.service.createWorkChange({ title: 'Empty', cwd: emptyDir, goal: 'none', at: 8 })
    const emptyRun = await h.service.reserveWorkRun({
      changeId: emptyChange.id, cwd: emptyDir, root: { workspaceRoot: emptyDir },
      writeScope: { kind: 'paths', paths: [{ path: emptyDir, type: 'directory' }] }, at: 9,
    })
    if (!emptyRun.ok) throw new Error(emptyRun.message)
    saveSnapshot(join(home, 'artifacts', 'empty-ok'), [], undefined, { root: emptyDir, empty: true })
    expect(await h.service.publishWorkBaseline(emptyRun.run.id, h.store.work.revision, 'empty-ok')).toMatchObject({ applied: true })
    rmSync(project, { recursive: true, force: true })
    rmSync(emptyDir, { recursive: true, force: true })
  })

  it('does not create a session when the reserved id cannot be read back', async () => {
    const h = setup()
    h.host.findSession = async () => { throw new Error('lookup unavailable') }
    const change = await h.service.createWorkChange({ title: 'Read', cwd: 'H:\\repo', goal: 'look', at: 1 })
    const reserved = await h.service.reserveWorkRun({ changeId: change.id, cwd: 'H:\\repo', writeScope: { kind: 'paths', paths: [] }, at: 2 })
    if (!reserved.ok) throw new Error(reserved.message)
    const launched = await h.service.launchWorkRun(reserved.run.id, 'read only')
    expect(launched).toMatchObject({ ok: false, code: 'unknown' })
    expect(h.calls.filter(call => call.startsWith('create '))).toEqual([])
    expect(h.store.work.run(reserved.run.id)?.creation).toBe('unknown')
    expect(h.store.work.run(reserved.run.id)?.phase).toBe('reserved')
  })

  it('startup recovery reads the persisted preset and does not stop an unverified session', async () => {
    const other = await startupPreset('other')
    expect(other.stops).toBe(0)
    expect(other.run).toMatchObject({ phase: 'settling', creation: 'rejected', expectedPreset: 'standard' })
    expect(other.occupied).toBe(1)
    const missing = await startupPreset(undefined)
    expect(missing.stops).toBe(0)
    expect(missing.run).toMatchObject({ phase: 'settling', creation: 'unknown', expectedPreset: 'standard' })
    expect(missing.occupied).toBe(1)
    const matched = await startupPreset('standard')
    expect(matched.stops).toBe(1)
    expect(matched.run).toMatchObject({ phase: 'stopped', creation: 'confirmed', expectedPreset: 'standard' })
    expect(matched.occupied).toBe(0)
  })

  it('dispatches, verifies explicit checks, and closes only the user-approved delivery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dot-loop-'))
    const home = mkdtempSync(join(tmpdir(), 'dot-loop-home-'))
    const h = setup(undefined, undefined, home)
    try {
      writeFileSync(join(dir, 'a.ts'), 'before')
      const created = JSON.parse(await h.service.manageTask({ action: 'create', title: 'Ship', goal: 'land', dir, human_review: true })) as { id: string }
      const first = await h.service.manageTask({ action: 'dispatch', task_id: created.id, instruction: 'edit', access: 'write' })
      const runId = /started (run-\d+)/.exec(first)![1]!
      writeFileSync(join(dir, 'a.ts'), 'after')
      await h.service.manageTask({ action: 'finish', task_id: created.id, run_id: runId })
      const current = h.store.work.change(created.id)!
      const args = { action: 'closeout', task_id: created.id, expected_input_ref: current.currentInputRef, expected_input_revision: current.currentRevision, checks: [{ requirementRef: 'goal', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['event:session-run-1:1'], note: 'the edit is present' }] }
      const asked = await h.service.manageTask(args)
      expect(asked).toContain('pending')
      expect(h.store.work.change(created.id)?.closeout).toBeUndefined()
      const pendingId = /pending (\S+)/.exec(asked)![1]!
      // Under the default approvals=dot, only the human entry point records this decision.
      expect(h.store.settings.approvals).toBe('dot')
      expect(h.service.pending.get(pendingId)?.humanRequired).toBe(true)
      expect(() => h.service.answer(pendingId, { kind: 'approval', allow: true })).toThrow(/direct human decision/)
      expect(h.service.pending.get(pendingId)).toBeDefined()
      await h.service.answerWorkReview(pendingId, true)
      expect(h.store.work.change(created.id)?.oversight?.decision).toMatchObject({ result: 'accept', source: 'user' })
      writeFileSync(join(dir, 'late.ts'), 'later')
      await expect(h.service.manageTask(args)).rejects.toThrow(/live file|not in the delivery/)
      rmSync(join(dir, 'late.ts'))
      expect(await h.service.manageTask(args)).toContain('accepted')
      expect(h.store.work.workView(created.id)?.status).toBe('done')
      expect(h.store.listTickets()).toEqual([])
    } finally { await h.service.dispose(); rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  })

  it('continues a reserved run by run_id and rejects an unknown or mismatched one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dot-run-id-home-'))
    const loop = setup(undefined, undefined, home)
    const dir = mkdtempSync(join(tmpdir(), 'dot-run-id-'))
    writeFileSync(join(dir, 'a.ts'), 'before')
    const sessions = new Map<string, { cwd?: string }>()
    const host = loop.host as DotHost
    host.findSession = async id => sessions.get(id)
    host.createSession = async input => {
      const id = input.sessionId ?? `s${sessions.size}`
      sessions.set(id, { cwd: input.cwd })
      return id
    }
    host.setWritable = async () => true
    host.verifyTaskPermission = async () => true
    const signal = new AbortController().signal
    const first = await loop.service.startTask({ cwd: dir, title: 'Ship', instruction: 'land', goal: 'land', access: 'write' }, signal)
    const runId = /reserved (run-\d+)/.exec(first)![1]!
    const changeId = /on (c-\d+)/.exec(first)![1]!
    expect(loop.store.work.listChanges()).toHaveLength(1)
    await expect(loop.service.startTask({ cwd: dir, title: 'Ghost', instruction: 'again', goal: 'other', runId: 'run-missing' }, signal)).rejects.toThrow(/unknown run run-missing/)
    await expect(loop.service.startTask({ cwd: dir, title: 'Ghost', instruction: 'again', runId, role: 'review' }, signal)).rejects.toThrow(new RegExp(`${runId} is not a reserved review run`))
    expect(loop.store.work.listChanges()).toHaveLength(1)
    expect(await loop.service.captureWorkBaseline(runId)).toMatchObject({ applied: true })
    const started = await loop.service.startTask({ cwd: dir, title: 'Ignored', instruction: 'land', runId }, signal)
    expect(started).toContain(`started ${runId}`)
    expect(started).toContain(changeId)
    expect(loop.store.work.listChanges().map(change => change.id)).toEqual([changeId])
    expect(loop.store.work.listRuns()).toHaveLength(1)
    const current = loop.store.work.change(changeId)!
    expect(await loop.service.recordWorkVerification(changeId, [{ requirementRef: 'goal', applicability: 'required' as 'applicable', verdict: 'pass', evidenceRefs: [] }], [], { inputRef: current.currentInputRef, inputRevision: current.currentRevision })).toMatchObject({ code: 'stale' })
    expect(loop.store.work.latestVerification(changeId)).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('keeps a later review baseline from hiding the pre-work change', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dot-attr-home-'))
    const h = setup(undefined, undefined, home)
    const dir = mkdtempSync(join(tmpdir(), 'dot-attr-'))
    writeFileSync(join(dir, 'a.ts'), 'before')
    const change = await h.service.createWorkChange({ title: 'Attr', cwd: dir, goal: 'edit', at: 1 })
    const work = await h.service.reserveWorkRun({
      changeId: change.id, cwd: dir, root: { workspaceRoot: dir },
      writeScope: { kind: 'paths', paths: [{ path: join(dir, 'a.ts'), type: 'file' }] }, at: 2,
    })
    if (!work.ok) throw new Error(work.message)
    expect(await h.service.captureWorkBaseline(work.run.id)).toMatchObject({ applied: true })
    const prepared = await h.store.work.prepareFinish(work.run.id, 'completed', 3)
    if (!prepared.ok) throw new Error(prepared.message)
    expect((await h.store.work.finishSettled(work.run.id, prepared.updatedAt, 'completed', { queueCleared: true, agentIdle: true, jobsSettled: true }, 4)).ok).toBe(true)
    writeFileSync(join(dir, 'a.ts'), 'after')
    const review = await h.service.reserveWorkRun({
      changeId: change.id, kind: 'review', cwd: dir, root: { workspaceRoot: dir },
      writeScope: { kind: 'workspace-exclusive' }, at: 5,
    })
    if (!review.ok) throw new Error(review.message)
    expect(await h.service.captureWorkBaseline(review.run.id)).toMatchObject({ applied: true })
    const subject = await h.service.captureWorkSubject(change.id)
    expect(subject.changes).toEqual([expect.objectContaining({ path: 'a.ts', kind: 'modified' })])
    expect(subject.protectedDirty).not.toContain('a.ts')
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('keeps a shared writer baseline when review reuses it, so an unchanged file is not added', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dot-share-home-'))
    const h = setup(undefined, undefined, home)
    const dir = mkdtempSync(join(tmpdir(), 'dot-share-'))
    writeFileSync(join(dir, 'a.ts'), 'keep')
    const change = await h.service.createWorkChange({ title: 'Share', cwd: dir, goal: 'keep', at: 1 })
    const work = await h.service.reserveWorkRun({
      changeId: change.id, cwd: dir, root: { workspaceRoot: dir },
      writeScope: { kind: 'paths', paths: [{ path: join(dir, 'a.ts'), type: 'file' }] }, at: 2,
    })
    if (!work.ok) throw new Error(work.message)
    const published = await h.service.captureWorkBaseline(work.run.id)
    if (!('applied' in published) || !published.applied) throw new Error('baseline was not published')
    const artifact = published.run.baselineRefs.at(-1)!.artifactRef
    const prepared = await h.store.work.prepareFinish(work.run.id, 'completed', 3)
    if (!prepared.ok) throw new Error(prepared.message)
    expect((await h.store.work.finishSettled(work.run.id, prepared.updatedAt, 'completed', { queueCleared: true, agentIdle: true, jobsSettled: true }, 4)).ok).toBe(true)
    const review = await h.service.reserveWorkRun({
      changeId: change.id, kind: 'review', cwd: dir, root: { workspaceRoot: dir },
      writeScope: { kind: 'workspace-exclusive' }, at: 5,
    })
    if (!review.ok) throw new Error(review.message)
    expect(await h.service.publishWorkBaseline(review.run.id, h.store.work.revision, artifact)).toMatchObject({ applied: true })
    const subject = await h.service.captureWorkSubject(change.id)
    expect(subject.changes.some(item => item.path === 'a.ts' && item.kind === 'added')).toBe(false)
    expect(subject.protectedDirty).toContain('a.ts')
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('accepts a same-scope review without dropping the writer baseline', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dot-exclusive-home-'))
    const h = setup(undefined, undefined, home)
    const dir = mkdtempSync(join(tmpdir(), 'dot-exclusive-'))
    writeFileSync(join(dir, 'a.ts'), 'before')
    writeFileSync(join(dir, 'gone.ts'), 'gone')
    writeFileSync(join(dir, 'keep.ts'), 'keep')
    const sessions = new Map<string, { cwd?: string }>()
    const host = h.host
    host.findSession = async id => sessions.get(id)
    host.createSession = async input => {
      const id = input.sessionId ?? `s${sessions.size}`
      sessions.set(id, { cwd: input.cwd })
      return id
    }
    host.setWritable = async () => true
    host.setReadOnly = async () => true
    host.verifyTaskPermission = async () => true
    host.stopActivity = async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true })
    const change = await h.service.createWorkChange({
      title: 'Exclusive', cwd: dir, goal: 'land', requirements: [{ requirementRef: 'r1', text: 'edits', required: true }], at: 1,
    })
    const writer = await h.service.reserveWorkRun({
      changeId: change.id, kind: 'work', cwd: dir, root: { workspaceRoot: dir },
      writeScope: { kind: 'workspace-exclusive' }, at: 2,
    })
    if (!writer.ok) throw new Error(writer.message)
    const published = await h.service.captureWorkBaseline(writer.run.id)
    if (!('applied' in published) || !published.applied) throw new Error('writer baseline was not published')
    const writerBase = published.run.baselineRefs.at(-1)!.artifactRef
    const launched = await h.service.launchWorkRun(writer.run.id, 'edit')
    if (!launched.ok) throw new Error(launched.message)
    writeFileSync(join(dir, 'a.ts'), 'after')
    writeFileSync(join(dir, 'new.ts'), 'new')
    rmSync(join(dir, 'gone.ts'))
    const prepared = await h.store.work.prepareFinish(writer.run.id, 'completed', 3)
    if (!prepared.ok) throw new Error(prepared.message)
    const finished = await h.store.work.finishSettled(writer.run.id, prepared.updatedAt, 'completed', { queueCleared: true, agentIdle: true, jobsSettled: true }, 4)
    if (!finished.ok) throw new Error(finished.message)
    const review = await h.service.reserveWorkRun({
      changeId: change.id, kind: 'review', cwd: dir, root: { workspaceRoot: dir },
      writeScope: { kind: 'workspace-exclusive' }, at: 5,
    })
    if (!review.ok) throw new Error(review.message)
    const reviewBasePublished = await h.service.captureWorkBaseline(review.run.id)
    if (!('applied' in reviewBasePublished) || !reviewBasePublished.applied) throw new Error('review baseline was not published')
    const reviewBase = reviewBasePublished.run.baselineRefs.at(-1)!.artifactRef
    expect(h.store.work.change(change.id)?.baselineRefs.map(item => item.artifactRef)).toEqual([writerBase, reviewBase])
    expect(h.store.work.run(writer.run.id)?.baselineRefs.map(item => item.artifactRef)).toEqual([writerBase])
    const launchedReview = await h.service.launchWorkRun(review.run.id, 'check')
    if (!launchedReview.ok) throw new Error(launchedReview.message)
    const held = await h.service.holdWorkReview(review.run.id)
    if (!('id' in held)) throw new Error(held.message)
    const subject = await h.service.captureWorkSubject(change.id)
    expect(subject.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'a.ts', kind: 'modified' }),
      expect.objectContaining({ path: 'new.ts', kind: 'added' }),
      expect.objectContaining({ path: 'gone.ts', kind: 'deleted' }),
    ]))
    expect(subject.protectedDirty).toContain('keep.ts')
    expect(subject.protectedDirty).not.toContain('a.ts')
    expect(subject.baselineRefs.map(item => item.artifactRef)).toEqual([writerBase, reviewBase])

    const current = h.store.work.change(change.id)!
    const verified = await h.service.recordWorkVerification(change.id, [
      { requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log-1'] },
    ], [writer.run.id], {
      inputRef: current.currentInputRef, inputRevision: current.currentRevision,
      reviewRunId: review.run.id, reviewerSessionId: h.store.work.run(review.run.id)!.sessionId, subject,
    })
    if (!('id' in verified) || !verified.subjectKey) throw new Error('message' in verified ? verified.message : 'missing subject')
    const accepted = await h.service.acceptWork(change.id, verified.id, current.currentInputRef, verified.subjectKey, 'user', {
      expectedInputRevision: current.currentRevision, expectedVerificationId: verified.id,
    })
    expect(accepted).toHaveProperty('closeout')
    expect(h.store.work.workView(change.id)?.status).toBe('done')
    expect(h.store.work.run(review.run.id)?.phase).toBe('stopped')
    expect(h.store.work.occupying()).toEqual([])
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('claims the pending answer before writing a user decision', async () => {
    const h = setup()
    const change = await h.service.createWorkChange({ title: 'Look', cwd: 'H:\\repo', goal: 'see', at: 1 })
    let withdraw = (): void => {}
    const open = h.service.pending.open.bind(h.service.pending)
    h.service.pending.open = input => {
      const opened = open(input)
      withdraw = opened.withdraw
      return opened
    }
    const asked = await h.service.manageTask({
      action: 'decide', task_id: change.id, verification_id: 'v-1',
      expected_input_revision: change.currentRevision, expected_subject_key: 'subject-1',
    })
    const id = /pending (\S+)/.exec(asked)![1]!
    withdraw()
    await expect(h.service.answerWorkReview(id, true)).rejects.toThrow(/no longer pending/)
    expect(h.service.pending.settlement(id)?.reason).toBe('withdrawn')
    expect(h.store.work.change(change.id)?.oversight?.decision).toBeUndefined()

    const raced = await h.service.createWorkChange({ title: 'Race', cwd: 'H:\\repo', goal: 'see', at: 2 })
    const second = await h.service.manageTask({
      action: 'decide', task_id: raced.id, verification_id: 'v-2',
      expected_input_revision: raced.currentRevision, expected_subject_key: 'subject-2',
    })
    const raceId = /pending (\S+)/.exec(second)![1]!
    const book = h.store.work
    const note = book.noteOversight.bind(book)
    book.noteOversight = async (changeId, decision, at) => {
      withdraw()
      return note(changeId, decision, at)
    }
    await expect(h.service.answerWorkReview(raceId, true)).resolves.toContain('accepted')
    expect(h.service.pending.settlement(raceId)?.reason).toBe('answered')
    expect(h.store.work.change(raced.id)?.oversight?.decision?.result).toBe('accept')
    book.noteOversight = note

    const opposed = await h.service.createWorkChange({ title: 'Split', cwd: 'H:\\repo', goal: 'see', at: 3 })
    const third = await h.service.manageTask({
      action: 'decide', task_id: opposed.id, verification_id: 'v-3',
      expected_input_revision: opposed.currentRevision, expected_subject_key: 'subject-3',
    })
    const opposeId = /pending (\S+)/.exec(third)![1]!
    const rejectFirst = h.service.answerWorkReview(opposeId, false)
    const acceptSecond = h.service.answerWorkReview(opposeId, true)
    const settled = await Promise.allSettled([rejectFirst, acceptSecond])
    expect(settled.map(item => item.status)).toEqual(['fulfilled', 'rejected'])
    expect(h.store.work.change(opposed.id)?.oversight?.decision?.result).toBe('reject')
    expect(h.service.pending.settlement(opposeId)?.reason).toBe('answered')
  })

  it('captures every reserved path and continues the reserved run that matches them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dot-paths-home-'))
    const h = setup(undefined, undefined, home)
    const dir = mkdtempSync(join(tmpdir(), 'dot-paths-'))
    const fileA = join(dir, 'a.ts')
    const fileB = join(dir, 'b.ts')
    writeFileSync(fileA, 'a')
    writeFileSync(fileB, 'b')
    const change = await h.service.createWorkChange({ title: 'Paths', cwd: dir, goal: 'both', maxConcurrentRuns: 2, at: 1 })
    const reserve = async (paths: readonly { path: string; type: 'file' }[]) => {
      const result = await h.service.reserveWorkRun({ changeId: change.id, root: { workspaceRoot: dir }, writeScope: { kind: 'paths', paths } })
      if (!result.ok) throw new Error(result.message)
      return { runId: result.run.id }
    }
    const reserved = await reserve([{ path: fileA, type: 'file' }, { path: fileB, type: 'file' }])
    expect(await h.service.captureWorkBaseline(reserved.runId)).toMatchObject({ applied: true })
    const ref = h.store.work.run(reserved.runId)!.baselineRefs.at(-1)!.artifactRef
    expect(readSnapshot(join(home, 'artifacts', ref)).manifest.saved.map(item => item.path).sort()).toEqual(['a.ts', 'b.ts'])
    const prepared = await h.store.work.prepareFinish(reserved.runId, 'completed', 2)
    if (!prepared.ok) throw new Error(prepared.message)
    expect((await h.store.work.finishSettled(reserved.runId, prepared.updatedAt, 'completed', { queueCleared: true, agentIdle: true, jobsSettled: true }, 3)).ok).toBe(true)
    const runA = await reserve([{ path: fileA, type: 'file' }])
    const runB = await reserve([{ path: fileB, type: 'file' }])
    await expect(h.service.startTask({ taskId: change.id, title: 'Paths', instruction: '', access: 'write' }, new AbortController().signal)).rejects.toThrow(/name the run or its paths/)
    const chosen = await h.service.startTask({
      taskId: change.id, title: 'Paths', instruction: '', access: 'write',
      paths: JSON.stringify([{ path: fileB, type: 'file' }]),
    }, new AbortController().signal)
    expect(chosen).toContain(runB.runId)
    expect(chosen).not.toContain(runA.runId)
    expect(h.store.work.run(runA.runId)?.phase).toBe('reserved')
    expect(h.store.work.run(runB.runId)?.phase).toBe('reserved')
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
})

function memoryDomain(seed: Record<string, Record<string, unknown>> = {}) {
  const names = ['state', 'tasks', 'tickets', 'schedules', 'proposals', 'changes', 'inputs', 'runs', 'verifications']
  const tables: Record<string, Map<string, unknown>> = {}
  for (const name of names) tables[name] = new Map(Object.entries(seed[name] ?? {}))
  const domain: DotDomainHandle = {
    table: name => ({
      entries: () => tables[name]!.entries(),
      get: key => tables[name]!.get(key),
      put: async (key, value) => { tables[name]!.set(key, value) },
      delete: async key => tables[name]!.delete(key),
      update: async (key, recipe) => {
        const rows = tables[name]!
        if (!rows.has(key)) {
          const error = new Error(`domain 'klarkxy_dsh_dot' table '${name}' has no record '${key}' to update`)
          ;(error as { code?: string }).code = 'missing-key'
          throw error
        }
        const next = recipe(rows.get(key))
        rows.set(key, next)
        return next
      },
    }),
    close: async () => {},
  }
  return { domain, tables }
}

/** Launch with preset standard, cancel during lookup, then reconcile through the service with no preset argument. */
async function startupPreset(actual: string | undefined) {
  const { domain, tables } = memoryDomain()
  const opened = setup()
  const host = opened.host as DotHost
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered = false
  host.findSession = async () => {
    entered = true
    await gate
    return undefined
  }
  const store = new DotStore(domain)
  await store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const service = new DotService({
    host, store, homeDir: join(tmpdir(), 'dsh-dot-spec'), notes: opened.notes,
    approvalGraceMs: 0, timer: opened.timer, now: () => 1000,
  })
  const change = await service.createWorkChange({ title: 'Ship', cwd: 'H:\\repo', goal: 'land it', at: 1 })
  const reserved = await service.reserveWorkRun({ changeId: change.id, cwd: 'H:\\repo', root: { workspaceRoot: 'H:\\repo' }, writeScope: { kind: 'paths', paths: [] }, at: 2 })
  if (!reserved.ok) throw new Error(reserved.message)
  const launching = service.launchWorkRun(reserved.run.id, 'go', 'standard')
  while (!entered) await Promise.resolve()
  await store.work.prepareCancel(change.id, 4)
  const seed: Record<string, Record<string, unknown>> = {}
  for (const [name, table] of Object.entries(tables)) {
    seed[name] = {}
    for (const [key, value] of table) seed[name]![key] = structuredClone(value)
  }
  release()
  await launching
  const restarted = memoryDomain(seed)
  const next = setup()
  const recovered = next.host as DotHost
  let stops = 0
  recovered.findSession = async () => ({ cwd: reserved.run.cwd, ...(actual !== undefined ? { preset: actual } : {}) })
  recovered.stopActivity = async () => {
    stops += 1
    return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true }
  }
  const book = new DotStore(restarted.domain)
  await book.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const again = new DotService({
    host: recovered, store: book, homeDir: join(tmpdir(), 'dsh-dot-spec'), notes: next.notes,
    approvalGraceMs: 0, timer: next.timer, now: () => 2000,
  })
  await again.reconcile()
  return { stops, run: book.work.run(reserved.run.id), occupied: book.work.occupying().length }
}

describe('factory reset', () => {
  it('resets released Dorothy segments and reflections without resuming their agents', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-dot-reset-cold-'))
    const h = setup(undefined, undefined, home)
    const current = await h.service.ensureDot()
    await h.store.beginSegment({ sessionId: 'dot-released', startedAt: 2, persona: '' })
    await h.store.beginSegment({ sessionId: current, startedAt: 3, persona: '' })
    await h.store.addReflectionRun({ sessionId: 'reflection-released', startedAt: 1, endedAt: 2, ok: true })
    await h.store.track({ sessionId: 'human-watched', origin: 'watched', title: 'human', goal: 'work', cwd: home, at: 1 })
    await h.store.setAgreements('old agreement')
    const resolveAgent = vi.fn(async () => ({ error: { message: 'session is owned by subagent routing' } }))
    const adapter = bindHost(name => {
      if (name === 'agents') return { get: () => undefined }
      if (name === 'jobs') return { list: () => [] }
      if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (name === 'sessionQuery') return { readSession: async () => ({ events: [] }) }
      if (name === 'sessionController') return {
        cancel: async () => ({ accepted: true }),
        state: async () => ({ active: false, running: false, queue: null, cursor: 1, pendingInput: [] }),
        resolveAgent,
      }
      return undefined
    })
    h.host.stopActivity = adapter.stopActivity
    try {
      const result = await h.service.confirmFactoryReset(h.service.previewFactoryReset().token)
      expect(result.archiveFailed).toEqual([])
      expect(result.archived).toEqual(expect.arrayContaining([current, 'dot-released', 'reflection-released']))
      expect(result.archived).not.toContain('human-watched')
      expect(resolveAgent).not.toHaveBeenCalled()
      expect(h.store.agreements).toBe('')
      expect(h.store.dotSessionId).not.toBe(current)
    } finally {
      await h.service.dispose()
      await adapter.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('archives owned and Dorothy sessions, not a watched human session, then starts clean', async () => {
    const h = setup()
    const dot = await h.service.ensureDot()
    await h.store.track({ sessionId: 'user-1', origin: 'watched', title: 'mine', goal: 'g', cwd: '/u', at: 1 })
    await h.store.track({ sessionId: 'owned-1', origin: 'started', title: 'job', goal: 'g', cwd: '/p', at: 1 })
    await h.store.setAgreements('keep secrets')
    await h.store.setCognition('old habits')
    await h.store.setSettings({ ...DEFAULT_SETTINGS, scope: 'all', reflection: false, idleCheckMinutes: 0 })
    const preview = h.service.previewFactoryReset()
    expect(preview.hasAgreements).toBe(true)
    expect(preview.hasCognition).toBe(true)
    expect(preview.archiveSessionIds).toEqual(expect.arrayContaining([dot, 'owned-1']))
    expect(preview.archiveSessionIds).not.toContain('user-1')
    await expect(h.service.confirmFactoryReset('nope')).rejects.toThrow(/invalid/)
    const armed = h.service.previewFactoryReset()
    const result = await h.service.confirmFactoryReset(armed.token)
    expect(result.archived).toEqual(expect.arrayContaining([dot, 'owned-1']))
    expect(h.calls.filter(call => call.startsWith('archive ')).sort()).toEqual(expect.arrayContaining([`archive ${dot}`, 'archive owned-1']))
    expect(h.calls).not.toContain('archive user-1')
    expect(h.store.agreements).toBe('')
    expect(h.store.cognition).toBe('')
    expect(h.store.list()).toEqual([])
    expect(h.store.settings.scope).toBe(DEFAULT_SETTINGS.scope)
    expect(h.store.settings.approvals).toBe(DEFAULT_SETTINGS.approvals)
    expect(h.store.knowledgeMigrated).toBe(true)
    expect(h.store.dotSessionId).toBeTruthy()
    expect(h.store.dotSessionId).not.toBe(dot)
  })

  it('resets an unsent reservation without trying to stop its placeholder session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-dot-reset-unsent-'))
    const h = setup(undefined, undefined, home)
    await h.service.ensureDot()
    const change = await h.store.work.createChange({ title: 'Reserved', cwd: home, goal: 'edit later', at: 1 })
    const reserved = await h.store.work.reserveRun({ changeId: change.id, cwd: home, root: { workspaceRoot: home }, writeScope: { kind: 'workspace-exclusive' }, at: 2 })
    if (!reserved.ok) throw new Error(reserved.message)
    const placeholder = reserved.run.requestedSessionId
    const stop = vi.spyOn(h.host, 'stopActivity').mockImplementation(async id => {
      if (id === placeholder) throw new Error('this placeholder has no host session')
      return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true }
    })
    try {
      await expect(h.service.confirmFactoryReset(h.service.previewFactoryReset().token)).resolves.toMatchObject({ archiveFailed: [] })
      expect(stop).not.toHaveBeenCalledWith(placeholder)
      expect(h.calls).not.toContain(`archive ${placeholder}`)
      expect(h.store.work.listRuns()).toEqual([])
    } finally {
      stop.mockRestore()
      await h.service.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('retains ownership and settings when archive fails, then retries the reset', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-dot-reset-retry-'))
    const h = setup(undefined, undefined, home)
    await h.service.ensureDot()
    await h.store.track({ sessionId: 'owned-retry', origin: 'started', title: 'job', goal: 'g', cwd: home, at: 1 })
    await h.store.setAgreements('retained until cleanup succeeds')
    const archive = vi.spyOn(h.host, 'archive').mockRejectedValueOnce(new Error('archive offline'))
    try {
      await expect(h.service.confirmFactoryReset(h.service.previewFactoryReset().token)).rejects.toMatchObject({ code: 'dot/reset-incomplete', message: expect.stringContaining('records and settings are retained') })
      expect(h.store.ownsSession('owned-retry')).toBe(true)
      expect(h.store.agreements).toBe('retained until cleanup succeeds')
      archive.mockRestore()
      await expect(h.service.confirmFactoryReset(h.service.previewFactoryReset().token)).resolves.toMatchObject({ archiveFailed: [] })
      expect(h.store.agreements).toBe('')
      expect(h.store.list()).toEqual([])
    } finally {
      archive.mockRestore()
      await h.service.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reports partial artifact cleanup and retains records so the remaining cleanup can be retried', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-dot-reset-artifact-retry-'))
    const h = setup(undefined, undefined, home)
    await h.service.ensureDot()
    await h.store.setAgreements('still recorded')
    const wipe = vi.spyOn(artifacts, 'wipeArtifacts').mockImplementationOnce(() => { throw new Error('artifact folder is busy') })
    try {
      await expect(h.service.confirmFactoryReset(h.service.previewFactoryReset().token)).rejects.toMatchObject({ code: 'dot/reset-incomplete', message: expect.stringContaining('Some files may already have been removed') })
      expect(h.store.agreements).toBe('still recorded')
      expect(h.store.lastFactoryResetAt).toBeUndefined()
      wipe.mockRestore()
      await expect(h.service.confirmFactoryReset(h.service.previewFactoryReset().token)).resolves.toMatchObject({ archiveFailed: [] })
      expect(h.store.agreements).toBe('')
      expect(h.store.lastFactoryResetAt).toBeDefined()
    } finally {
      wipe.mockRestore()
      await h.service.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reports that data was cleared if restarting Dorothy fails, and allows a fresh retry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-dot-reset-start-retry-'))
    const h = setup(undefined, undefined, home)
    await h.service.ensureDot()
    await h.store.setAgreements('clear me')
    h.failCreate(true)
    try {
      await expect(h.service.confirmFactoryReset(h.service.previewFactoryReset().token)).rejects.toMatchObject({ code: 'dot/reset-incomplete', message: expect.stringContaining('data and settings were reset') })
      expect(h.store.agreements).toBe('')
      expect(h.store.lastFactoryResetAt).toBeDefined()
      h.failCreate(false)
      await expect(h.service.confirmFactoryReset(h.service.previewFactoryReset().token)).resolves.toMatchObject({ sessionId: expect.any(String) })
    } finally {
      await h.service.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not forget a still-running writer when factory reset cannot archive it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-dot-reset-busy-'))
    const store = new DotStore(undefined)
    await store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
    await store.setDot({ knowledgeMigrated: '1' })
    await store.beginSegment({ sessionId: 'dot-old', startedAt: 1, persona: '' })
    const book = store.work
    const change = await book.createChange({ title: 'writer', cwd: home, goal: 'edit a.txt', at: 1 })
    const reserved = await book.reserveRun({ changeId: change.id, cwd: home, root: { workspaceRoot: home }, writeScope: { kind: 'paths', paths: [{ path: 'a.txt', type: 'file' }] }, at: 2 })
    if (!reserved.ok) throw new Error(reserved.message)
    await book.publishBaseline(reserved.run.id, reserved.revision, 'baseline-fixture', 3)
    const runHost = {
      async findSession() { return { cwd: home, preset: 'standard' } },
      async createSession(input: { sessionId: string; cwd: string }) { return input },
      async prepareAccess() { return 'ok' as const },
      async prompt() { return 'accepted' as const },
      async promptReceipts() { return 0 },
      async relay() { return 'accepted' as const },
      async relayInserts() { return 0 },
      async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }
    expect((await launchReservedRun(book, runHost, reserved.run.id, 'edit a.txt')).ok).toBe(true)
    const writer = reserved.run.requestedSessionId
    const live = new Set([writer])
    const host = {
      isRunning: (id: string) => live.has(id),
      async stop() { throw new Error('stop unavailable') },
      async archive(id: string) { if (id === writer) throw new Error('archive storage unavailable') },
      async createWorkspace(path: string, title: string) { return { id: 'w', path, title, sessionCount: 0 } },
      async createDot() { return 'dot-new' },
      modelKey: () => undefined,
      syncModel() {},
      dotEvents: () => [],
    }
    const service = new DotService({ host: host as never, store, homeDir: home, notes: { path: 'memory.md', read: async () => '', readCognition: async () => '' } as never, now: () => 10, timer: { set: () => 0, clear() {}, now: () => 10 } })
    try {
      const token = service.previewFactoryReset().token
      await expect(service.confirmFactoryReset(token)).rejects.toThrow(/not settled|still running/)
      expect(live.has(writer)).toBe(true)
      expect(store.ownsSession(writer)).toBe(true)
      expect(book.occupying().map(row => row.id)).toContain(reserved.run.id)
      expect(store.dotSessionId).toBe('dot-old')
    } finally { await service.dispose() }
  })

  it('does not forget a writer whose agent is idle while an owned job is still running', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-dot-reset-job-'))
    const store = new DotStore(undefined)
    await store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
    await store.setDot({ knowledgeMigrated: '1' })
    await store.beginSegment({ sessionId: 'dot-old', startedAt: 1, persona: '' })
    const change = await store.work.createChange({ title: 'writer', cwd: home, goal: 'edit a.txt', at: 1 })
    const reserved = await store.work.reserveRun({ changeId: change.id, cwd: home, root: { workspaceRoot: home }, writeScope: { kind: 'paths', paths: [{ path: 'a.txt', type: 'file' }] }, at: 2 })
    if (!reserved.ok) throw new Error(reserved.message)
    await store.work.publishBaseline(reserved.run.id, reserved.revision, 'baseline-fixture', 3)
    expect((await launchReservedRun(store.work, {
      async findSession() { return { cwd: home, preset: 'standard' } },
      async createSession(input) { return input },
      async prepareAccess() { return 'ok' },
      async prompt() { return 'accepted' },
      async promptReceipts() { return 0 },
      async relay() { return 'accepted' },
      async relayInserts() { return 0 },
      async stop() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
    }, reserved.run.id, 'edit a.txt')).ok).toBe(true)
    const writer = reserved.run.requestedSessionId
    const job = { id: 'job-owned-still-running', owner: writer, status: 'running' }
    const agent = { status: 'idle', session: { id: writer }, cancel() {}, async whenIdle() {} }
    const host = bindHost(name => {
      if (name === 'agents') return { get: () => agent }
      if (name === 'jobs') return { list: () => [job], kill() { throw new Error('job cancellation not confirmed') } }
      if (name === 'sessionController') return { async cancel() {}, async state() { return { running: false, queue: [] } } }
      if (name === 'sessionQuery') return { async readSession() { return { events: [] } } }
      if (name === 'workspaceRegistry') return { async archiveSession(id: string) { if (id === writer) throw new Error('archive storage unavailable') } }
      return undefined
    })
    host.createWorkspace = async (path, title) => ({ id: 'w', path, title: title ?? 'Dorothy', sessionCount: 0 })
    host.createDot = async () => 'dot-new'
    host.dotEvents = () => []
    const stopReport = await host.stopActivity!(writer)
    expect(host.isRunning(writer)).toBe(false)
    expect(stopReport).toMatchObject({ idle: true, queueCleared: true, jobsSettled: 'unknown' })
    const service = new DotService({ host, store, homeDir: home, notes: { path: 'memory.md', read: async () => '', readCognition: async () => '' } as never, now: () => 10, timer: { set: () => 0, clear() {}, now: () => 10 } })
    try {
      await expect(service.confirmFactoryReset(service.previewFactoryReset().token)).rejects.toThrow(/owned jobs UNKNOWN/)
      expect(store.ownsSession(writer)).toBe(true)
      expect(store.work.occupying().map(row => row.id)).toContain(reserved.run.id)
      expect(store.dotSessionId).toBe('dot-old')
    } finally { await service.dispose(); await host.dispose() }
  })
})

describe('workspace inspect and files', () => {
  it('inspects a workspace and lists files inside it, refusing a path that escapes', async () => {
    const h = setup()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dot-ws-svc-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'a')
    writeFileSync(join(dir, 'README.md'), 'hi')
    const created = await h.service.createWorkspace(dir, 'proj')
    const id = /^Workspace (\S+)/.exec(created)?.[1]
    expect(id).toBeTruthy()
    const inspect = await h.service.inspectWorkspace(id)
    expect(inspect).toContain(`"${'proj'}"`)
    expect(inspect).toContain(dir)
    const files = await h.service.listWorkspaceFiles(id)
    expect(files).toContain('README.md')
    expect(files).toContain('src/a.ts')
    await expect(h.service.listWorkspaceFiles(id, '..')).rejects.toThrow(/outside/)
    await expect(h.service.inspectWorkspace('missing')).rejects.toThrow(/no workspace/)
  })
})
