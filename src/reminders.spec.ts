import { describe, expect, it } from 'vitest'
import type { Timer } from './batcher.ts'
import { REMINDER_HEAD } from './contracts.ts'
import { ReminderClock } from './reminders.ts'
import { MAX_SCHEDULES, ScheduleInputError } from './schedule.ts'
import { DotStore } from './store.ts'

const MINUTE = 60_000
const START = new Date(2031, 2, 5, 10, 0).getTime()

function setup() {
  let at = START
  let handle = 0
  const armed = new Map<number, number>()
  const timer: Timer = {
    set: (_callback, ms) => { armed.set(++handle, ms); return handle },
    clear: id => { armed.delete(id as number) },
    now: () => at,
  }
  const store = new DotStore(undefined)
  const delivered: string[] = []
  const logs: string[] = []
  let failing = false
  let during: (() => Promise<unknown>) | undefined
  const clock = new ReminderClock({
    store,
    timer,
    now: () => at,
    log: message => logs.push(message),
    deliver: async text => {
      if (failing) throw new Error('dot is unreachable')
      await during?.()
      delivered.push(text)
    },
  })
  return {
    clock, store, delivered, logs,
    /** The one wait the timer is set to, if any. */
    wait: () => { expect(armed.size).toBeLessThanOrEqual(1); return [...armed.values()][0] },
    advance: (ms: number) => { at += ms },
    fail: (value: boolean) => { failing = value },
    whileDelivering: (work: () => Promise<unknown>) => { during = work },
  }
}

describe('ReminderClock', () => {
  it('stores reminders before it starts and sets one timer to the earliest once it runs', async () => {
    const h = setup()
    const later = await h.clock.add({ title: 'later', prompt: 'p', afterMinutes: 20 })
    expect(later.id).toMatch(/^sch-[0-9a-f]{6}$/)
    expect(h.wait()).toBeUndefined()
    h.clock.start()
    expect(h.wait()).toBe(20 * MINUTE)
    await h.clock.add({ title: 'sooner', prompt: 'p', afterMinutes: 5 })
    expect(h.wait()).toBe(5 * MINUTE)
    // A far reminder is still checked every half hour, so a slept host is noticed.
    expect(await h.clock.remove(later.id)).toBe(true)
    await h.clock.add({ title: 'far', prompt: 'p', dailyTime: '09:00' })
    expect(await h.clock.remove(h.store.schedules[0]!.id)).toBe(true)
    expect(h.wait()).toBe(30 * MINUTE)
    expect(await h.clock.remove('sch-nope')).toBe(false)
  })

  it('delivers what is due in one message, drops single firings and moves repeats on', async () => {
    const h = setup()
    h.clock.start()
    const once = await h.clock.add({ title: 'once', prompt: 'check the build', afterMinutes: 10 })
    const every = await h.clock.add({ title: 'pulse', prompt: 'look at the board', everyMinutes: 10 })
    await h.clock.add({ title: 'not yet', prompt: 'p', afterMinutes: 60 })
    h.advance(10 * MINUTE)
    await h.clock.tick()
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]!.startsWith(REMINDER_HEAD)).toBe(true)
    expect(h.delivered[0]).toContain('check the build')
    expect(h.delivered[0]).toContain('look at the board')
    expect(h.delivered[0]).not.toContain('not yet')
    expect(h.store.schedule(once.id)).toMatchObject({ deliveredAt: START + 10 * MINUTE, lastFiredAt: START + 10 * MINUTE })
    expect(h.store.schedule(every.id)).toMatchObject({ nextAt: START + 20 * MINUTE, lastFiredAt: START + 10 * MINUTE })
    expect(h.wait()).toBe(10 * MINUTE)
    // Nothing is due: a tick only sets the timer again.
    await h.clock.tick()
    expect(h.delivered).toHaveLength(1)
  })

  it('delivers a reminder missed during downtime once and continues from now', async () => {
    const h = setup()
    const every = await h.clock.add({ title: 'pulse', prompt: 'look at the board', everyMinutes: 30 })
    const once = await h.clock.add({ title: 'once', prompt: 'call back', afterMinutes: 45 })
    // The host was off for five hours and comes back.
    h.advance(5 * 60 * MINUTE)
    h.clock.start()
    expect(h.wait()).toBe(0)
    await h.clock.tick()
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toContain('delivered late')
    expect(h.store.schedule(once.id)).toMatchObject({ deliveredAt: START + 5 * 60 * MINUTE })
    expect(h.store.schedule(every.id)!.nextAt).toBe(START + 330 * MINUTE)
    await h.clock.tick()
    expect(h.delivered).toHaveLength(1)
  })

  it('does not wake the same once reminder again after a failed ack or a restart', async () => {
    const h = setup()
    h.clock.start()
    const once = await h.clock.add({ title: 'once', prompt: 'call back', afterMinutes: 1 })
    const every = await h.clock.add({ title: 'pulse', prompt: 'look again', everyMinutes: 1 })
    h.advance(MINUTE)
    h.fail(true)
    await h.clock.tick()
    expect(h.delivered).toEqual([])
    expect(h.store.schedule(once.id)).toMatchObject({ deliveredAt: START + MINUTE })
    expect(h.store.schedule(every.id)?.lastFiredAt).toBeUndefined()
    expect(h.logs.join('\n')).toContain('dot is unreachable')
    h.fail(false)
    h.advance(MINUTE)
    await h.clock.tick()
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toContain('look again')
    expect(h.delivered[0]).not.toContain('call back')
    const again = new ReminderClock({
      store: h.store,
      now: () => START + 2 * MINUTE + 1_000,
      deliver: async text => { h.delivered.push(text) },
    })
    again.start()
    await again.tick()
    expect(h.delivered).toHaveLength(1)
    expect(h.store.schedule(once.id)?.deliveredAt).toBe(START + MINUTE)
  })

  it('leaves a reminder removed while it was being delivered', async () => {
    const h = setup()
    h.clock.start()
    const every = await h.clock.add({ title: 'pulse', prompt: 'p', everyMinutes: 5 })
    h.advance(5 * MINUTE)
    h.whileDelivering(() => h.clock.remove(every.id))
    await h.clock.tick()
    expect(h.delivered).toHaveLength(1)
    expect(h.store.schedules).toEqual([])
  })

  it('refuses a reminder past the cap and stops for good when disposed', async () => {
    const h = setup()
    h.clock.start()
    for (let index = 0; index < MAX_SCHEDULES; index++) await h.clock.add({ title: `r${index}`, prompt: 'p', afterMinutes: 10 + index })
    await expect(h.clock.add({ title: 'one more', prompt: 'p', afterMinutes: 5 })).rejects.toThrow(ScheduleInputError)
    h.clock.dispose()
    expect(h.wait()).toBeUndefined()
    h.advance(60 * MINUTE)
    await h.clock.tick()
    expect(h.delivered).toEqual([])
  })
})

describe('recipe-bound reminders', () => {
  function setupRecipe(result: { ok: boolean; reason?: string }) {
    const h = setup()
    const calls: string[] = []
    const clock = new ReminderClock({
      store: h.store,
      now: () => h.store.schedules.length ? h.store.schedules[0]!.nextAt : 0,
      deliver: async text => { h.delivered.push(text) },
      runRecipe: async record => {
        calls.push(record.id)
        return result.ok ? { ok: true as const, text: `started ${record.id}` } : { ok: false as const, reason: result.reason ?? 'refused' }
      },
    })
    return { ...h, clock, calls }
  }

  it('dispatches a recipe reminder directly, holds no model turn', async () => {
    const h = setupRecipe({ ok: true })
    const store = h.store
    let now = START
    const clock = new ReminderClock({
      store, now: () => now,
      deliver: async text => { h.delivered.push(text) },
      runRecipe: async record => { h.calls.push(record.id); return { ok: true as const, text: 'started' } },
    })
    const record = { id: 'sch-r1', title: 'weekly', prompt: 'note', timing: { kind: 'once' as const, at: now - 1 }, createdAt: now - 1000, nextAt: now - 1, recipe: 'rcp-1' }
    await store.putSchedule(record)
    await clock.tick()
    expect(h.calls).toEqual(['sch-r1'])
    expect(h.delivered).toHaveLength(0)
    expect(store.schedule('sch-r1')?.deliveredAt).toBe(now)
  })

  it('delivers the refusal to dot with the reason line', async () => {
    const store = new DotStore(undefined)
    const delivered: string[] = []
    let now = START
    const clock = new ReminderClock({
      store, now: () => now,
      deliver: async text => { delivered.push(text) },
      runRecipe: async () => ({ ok: false as const, reason: 'previous run still in flight' }),
    })
    await store.putSchedule({ id: 'sch-r2', title: 'weekly', prompt: '', timing: { kind: 'once' as const, at: now - 1 }, createdAt: now - 1000, nextAt: now - 1, recipe: 'rcp-1' })
    await store.putSchedule({ id: 'sch-p1', title: 'plain', prompt: 'do it', timing: { kind: 'once' as const, at: now - 1 }, createdAt: now - 1000, nextAt: now - 1 })
    await clock.tick()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('sch-p1')
    expect(delivered[0]).toContain('recipe dispatch refused: previous run still in flight')
    expect(delivered[0]).toContain('rcp-1')
  })

  it('advances a repeating recipe reminder only after a successful dispatch, and never re-dispatches on deliver retry', async () => {
    const store = new DotStore(undefined)
    const delivered: string[] = []
    const calls: string[] = []
    let now = START
    let failing = false
    const clock = new ReminderClock({
      store, now: () => now,
      deliver: async text => { if (failing) throw new Error('down'); delivered.push(text) },
      runRecipe: async record => { calls.push(record.id); return { ok: true as const, text: 'ok' } },
    })
    await store.putSchedule({ id: 'sch-rep', title: 'weekly', prompt: '', timing: { kind: 'every' as const, minutes: 60, anchor: now - 60 * MINUTE }, createdAt: now - 1000, nextAt: now - 1, recipe: 'rcp-1' })
    await store.putSchedule({ id: 'sch-plain', title: 'plain', prompt: 'p', timing: { kind: 'every' as const, minutes: 60, anchor: now - 60 * MINUTE }, createdAt: now - 1000, nextAt: now - 1 })
    failing = true
    await clock.tick()
    // Dispatch ran once; the recipe record already advanced even though deliver threw.
    expect(calls).toEqual(['sch-rep'])
    expect(store.schedule('sch-rep')!.nextAt).toBeGreaterThan(now)
    expect(delivered).toHaveLength(0)
    failing = false
    now += 10_000
    await clock.tick()
    // Retry delivers the plain list only; no second dispatch.
    expect(calls).toEqual(['sch-rep'])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('sch-plain')
  })
})
