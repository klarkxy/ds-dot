import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutoUpdater, PACKAGE_NAME, lastBoundary, nextCheckAt, pickUpdate, type AutoUpdateDeps, type PluginManagerLike, type UpdateBundleInfo, type UpdateOutcome, type UpdatePluginVersion, type UpdateStatus, type UpdateVersionList } from './auto-update.ts'
import type { Timer } from './batcher.ts'
import { DEFAULT_SETTINGS, type DotSettings } from './contracts.ts'
import { DotStore } from './store.ts'
import type { DotTraceInput } from './trace.ts'

/** Manual timer: tests fire scheduled callbacks explicitly. */
function manualTimer() {
  const pending = new Map<number, { run: () => void; ms: number }>()
  let next = 0
  const timer: Timer = {
    set: (callback, ms) => { const id = ++next; pending.set(id, { run: callback, ms }); return id },
    clear: handle => { pending.delete(handle as number) },
    now: () => 0,
  }
  return {
    timer,
    delays: () => [...pending.values()].map(entry => entry.ms),
    fire: () => { const due = [...pending.values()]; pending.clear(); for (const entry of due) entry.run() },
  }
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

const version = (id: string, extra: Partial<UpdatePluginVersion> = {}): UpdatePluginVersion => ({ version: id, prerelease: id.includes('-'), bundle: true, ...extra })

const NOON = new Date(2025, 10, 20, 12, 0).getTime()
const AFTER_NOON = new Date(2025, 10, 20, 15, 0).getTime()

function fakeManager(input: {
  bundles?: readonly UpdateBundleInfo[]
  list?: UpdateVersionList
  outcome?: UpdateOutcome
  updateError?: unknown
} = {}) {
  const calls: { versions?: number; updatedTo?: string; registry?: string | null } = {}
  const manager: PluginManagerLike = {
    listBundles: async () => input.bundles ?? [{ name: PACKAGE_NAME, version: '0.3.0', update: 'registry' }],
    listVersions: async () => { calls.versions = (calls.versions ?? 0) + 1; return input.list ?? { status: 'listed', installed: '0.3.0', registry: 'https://registry.test', versions: [version('0.3.1')] } },
    updateBundle: async (_name, to, options) => {
      calls.updatedTo = to
      calls.registry = options?.registry
      if (input.updateError) throw input.updateError
      return input.outcome ?? { from: '0.3.0', to, result: { application: 'applied' } }
    },
  }
  return { manager, calls }
}

function harness(options: {
  settings?: Partial<DotSettings>
  manager?: PluginManagerLike
  quiet?: boolean
  now?: number
} = {}) {
  const clock = manualTimer()
  const store = new DotStore(undefined)
  const settings = { ...DEFAULT_SETTINGS, ...options.settings }
  const quiet = { value: options.quiet ?? true }
  const now = { value: options.now ?? AFTER_NOON }
  const mgr = { current: options.manager as PluginManagerLike | undefined }
  const logs: string[] = []
  const events: DotTraceInput[] = []
  const deps: AutoUpdateDeps = {
    manager: () => mgr.current,
    store,
    settings: () => settings,
    isQuiet: () => quiet.value,
    now: () => now.value,
    timer: clock.timer,
    log: message => logs.push(message),
    emit: input => events.push(input),
  }
  return { clock, store, settings, quiet, now, mgr, logs, events, updater: new AutoUpdater(deps) }
}

describe('schedule math', () => {
  it('names the published package', () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as { name: string }
    expect(manifest.name).toBe(PACKAGE_NAME)
  })

  it('aims the check at the next local noon strictly after now', () => {
    expect(nextCheckAt(new Date(2025, 10, 20, 9, 30).getTime())).toBe(NOON)
    expect(nextCheckAt(NOON)).toBe(new Date(2025, 10, 21, 12, 0).getTime())
    expect(nextCheckAt(AFTER_NOON)).toBe(new Date(2025, 10, 21, 12, 0).getTime())
  })

  it('finds the most recent local noon at or before now', () => {
    expect(lastBoundary(new Date(2025, 10, 20, 9, 30).getTime())).toBe(new Date(2025, 10, 19, 12, 0).getTime())
    expect(lastBoundary(NOON)).toBe(NOON)
    expect(lastBoundary(AFTER_NOON)).toBe(NOON)
  })
})

describe('pickUpdate', () => {
  it('takes the first installable row, stable versions for stable installs', () => {
    expect(pickUpdate('0.3.0', [version('0.3.1')])?.version).toBe('0.3.1')
    expect(pickUpdate('0.3.0', [version('0.4.0-rc.1'), version('0.3.1')])?.version).toBe('0.3.1')
    expect(pickUpdate('0.3.0', [version('0.4.0-rc.1')])).toBeUndefined()
  })

  it('allows prereleases for prerelease installs', () => {
    expect(pickUpdate('0.3.0-rc.1', [version('0.4.0-rc.1')])?.version).toBe('0.4.0-rc.1')
    expect(pickUpdate('0.3.0-rc.1', [version('0.3.1')])?.version).toBe('0.3.1')
  })

  it('skips deprecated, incompatible and non-bundle rows', () => {
    expect(pickUpdate('0.3.0', [
      version('0.4.0', { deprecated: 'bad release' }),
      version('0.3.9', { incompatible: { dsh: '9.x' } }),
      version('0.3.8', { bundle: false }),
      version('0.3.1'),
    ])?.version).toBe('0.3.1')
  })
})

describe('AutoUpdater scheduling', () => {
  it('makes up a missed noon three minutes after start', async () => {
    const h = harness()
    h.updater.start()
    await flush()
    expect(h.clock.delays()).toEqual([180_000])
  })

  it('schedules the next noon when today already checked', async () => {
    const h = harness()
    await h.store.setUpdateStatus({ lastCheckAt: new Date(2025, 10, 20, 12, 30).getTime() })
    h.updater.start()
    await flush()
    expect(h.clock.delays()).toEqual([new Date(2025, 10, 21, 12, 0).getTime() - AFTER_NOON])
  })

  it('arms nothing when auto update is off', async () => {
    const h = harness({ settings: { autoUpdate: false } })
    h.updater.start()
    await flush()
    expect(h.clock.delays()).toEqual([])
  })

  it('dispose cancels armed timers', async () => {
    const h = harness()
    h.updater.start()
    await flush()
    expect(h.clock.delays()).not.toEqual([])
    h.updater.dispose()
    expect(h.clock.delays()).toEqual([])
  })
})

describe('AutoUpdater checks', () => {
  it('reports unavailable when the host has no plugin manager', async () => {
    const h = harness()
    const status = await h.updater.checkNow()
    expect(status.lastResult?.kind).toBe('unavailable')
    expect(status.lastCheckAt).toBe(AFTER_NOON)
  })

  it('stays silent on installs the manager cannot update', async () => {
    for (const bundles of [[], [{ name: PACKAGE_NAME, version: '0.3.0' }], [{ name: PACKAGE_NAME, version: '0.3.0', update: 'git' as const }]]) {
      const { manager } = fakeManager({ bundles })
      const h = harness({ manager })
      expect((await h.updater.checkNow()).lastResult?.kind).toBe('not-updatable')
    }
  })

  it('fails with the registry refusal reason', async () => {
    const { manager } = fakeManager({ list: { status: 'refused', problem: 'network', reason: 'registry unreachable' } })
    const h = harness({ manager })
    expect((await h.updater.checkNow()).lastResult).toMatchObject({ kind: 'failed', message: 'network: registry unreachable' })
  })

  it('reports up-to-date when no installable version exists', async () => {
    const { manager } = fakeManager({ list: { status: 'listed', installed: '0.3.0', registry: null, versions: [] } })
    const h = harness({ manager })
    expect((await h.updater.checkNow()).lastResult?.kind).toBe('up-to-date')
  })

  it('waits for quiet, then applies through the answering registry', async () => {
    const { manager, calls } = fakeManager()
    const h = harness({ manager, quiet: false })
    const checking = h.updater.checkNow()
    await flush()
    expect(calls.updatedTo).toBeUndefined()
    expect(h.clock.delays()).toEqual([60_000])
    h.quiet.value = true
    h.clock.fire()
    const status = await checking
    expect(calls.updatedTo).toBe('0.3.1')
    expect(calls.registry).toBe('https://registry.test')
    expect(status.lastResult).toMatchObject({ kind: 'updated', from: '0.3.0', to: '0.3.1' })
    expect(status.pending).toBeUndefined()
    expect(h.events.map(row => row.event)).toContain('update.applied')
  })

  it('persists pending before calling updateBundle', async () => {
    const h = harness()
    const { manager } = fakeManager()
    let seen: UpdateStatus['pending']
    manager.updateBundle = async (_name, to, _options) => {
      seen = h.store.updateStatus?.pending
      return { from: '0.3.0', to, result: { application: 'applied' } }
    }
    h.mgr.current = manager
    await h.updater.checkNow()
    expect(seen!).toEqual({ from: '0.3.0', to: '0.3.1', at: AFTER_NOON })
    expect(h.store.updateStatus?.pending).toBeUndefined()
  })

  it('maps restart-required and failed applications', async () => {
    const { manager: restart } = fakeManager({ outcome: { from: '0.3.0', to: '0.3.1', result: { application: 'restart-required' } } })
    const h1 = harness({ manager: restart })
    expect((await h1.updater.checkNow()).lastResult).toMatchObject({ kind: 'restart-required', from: '0.3.0', to: '0.3.1' })
    const { manager: failed } = fakeManager({ outcome: { from: '0.3.0', to: '0.3.1', result: { application: 'failed', error: { code: 'operation-error', diagnostic: 'pnpm died' } } } })
    const h2 = harness({ manager: failed })
    expect((await h2.updater.checkNow()).lastResult).toMatchObject({ kind: 'failed', message: 'pnpm died' })
  })

  it('reports a throwing updateBundle as failed', async () => {
    const { manager } = fakeManager({ updateError: new Error('kaboom') })
    const h = harness({ manager })
    const status = await h.updater.checkNow()
    expect(status.lastResult).toMatchObject({ kind: 'failed', message: 'kaboom' })
    expect(status.pending).toBeUndefined()
  })

  it('resolves an interrupted apply against the installed version', async () => {
    const { manager: moved } = fakeManager({ bundles: [{ name: PACKAGE_NAME, version: '0.3.1', update: 'registry' }] })
    const h1 = harness({ manager: moved })
    await h1.store.setUpdateStatus({ lastCheckAt: AFTER_NOON, pending: { from: '0.3.0', to: '0.3.1', at: AFTER_NOON } })
    h1.updater.start()
    await flush()
    expect(h1.store.updateStatus?.lastResult).toMatchObject({ kind: 'updated', from: '0.3.0', to: '0.3.1' })
    expect(h1.store.updateStatus?.pending).toBeUndefined()

    const { manager: same } = fakeManager()
    const h2 = harness({ manager: same })
    await h2.store.setUpdateStatus({ pending: { from: '0.3.0', to: '0.3.1', at: AFTER_NOON } })
    h2.updater.start()
    await flush()
    expect(h2.store.updateStatus?.lastResult).toMatchObject({ kind: 'failed', message: 'update to 0.3.1 did not take effect' })
    expect(h2.store.updateStatus?.pending).toBeUndefined()
  })

  it('turning the setting off cancels timers and a quiet wait; on re-arms', async () => {
    const { manager, calls } = fakeManager()
    const h = harness({ manager, quiet: false })
    const checking = h.updater.checkNow()
    await flush()
    expect(h.clock.delays()).toEqual([60_000])
    h.settings.autoUpdate = false
    h.updater.settingsChanged()
    await checking
    expect(calls.updatedTo).toBeUndefined()
    expect(h.clock.delays()).toEqual([])
    h.settings.autoUpdate = true
    h.updater.settingsChanged()
    await flush()
    expect(h.clock.delays()).toEqual([180_000])
  })

  it('never installs when the switch turns off while the version list is in flight', async () => {
    const { manager, calls } = fakeManager()
    let resolveList: ((list: UpdateVersionList) => void) | undefined
    manager.listVersions = () => new Promise(resolve => { resolveList = resolve })
    const h = harness({ manager })
    const checking = h.updater.checkNow()
    await flush()
    h.settings.autoUpdate = false
    h.updater.settingsChanged()
    resolveList!({ status: 'listed', installed: '0.3.0', registry: null, versions: [version('0.3.1')] })
    await checking
    expect(calls.updatedTo).toBeUndefined()
    expect(h.store.updateStatus?.pending).toBeUndefined()
  })

  it('never installs when a supersede lands inside the pending write', async () => {
    const { manager, calls } = fakeManager()
    const h = harness({ manager })
    const original = h.store.setUpdateStatus.bind(h.store)
    let resolveWrite: (() => void) | undefined
    let intercepted = false
    h.store.setUpdateStatus = next => {
      if (!intercepted && next?.pending) {
        intercepted = true
        return new Promise<void>(resolve => { resolveWrite = () => { void original(next).then(resolve) } })
      }
      return original(next)
    }
    const checking = h.updater.checkNow()
    await flush()
    expect(resolveWrite).toBeDefined()
    h.updater.dispose()
    resolveWrite!()
    await checking
    expect(calls.updatedTo).toBeUndefined()
    expect(h.store.updateStatus?.pending).toBeUndefined()
  })

  it('leaves the pending marker of a newer check alone when a superseded check backs out', async () => {
    const { manager } = fakeManager()
    let resolveUpdate: ((outcome: Awaited<ReturnType<PluginManagerLike['updateBundle']>>) => void) | undefined
    manager.updateBundle = () => new Promise(resolve => { resolveUpdate = resolve })
    const h = harness({ manager })
    const original = h.store.setUpdateStatus.bind(h.store)
    let resolveWrite: (() => void) | undefined
    let intercepted = false
    h.store.setUpdateStatus = next => {
      if (!intercepted && next?.pending) {
        intercepted = true
        const write = original(next)
        return new Promise<void>(resolve => { resolveWrite = () => { void write.then(resolve) } })
      }
      return original(next)
    }
    const first = h.updater.checkNow()
    await flush()
    expect(resolveWrite).toBeDefined()
    h.settings.autoUpdate = false
    h.updater.settingsChanged()
    h.now.value += 1
    const second = h.updater.checkNow()
    await flush()
    const newer = h.store.updateStatus?.pending
    expect(newer).toMatchObject({ to: '0.3.1' })
    resolveWrite!()
    await first
    expect(h.store.updateStatus?.pending).toBe(newer)
    resolveUpdate!({ from: '0.3.0', to: '0.3.1', step: 'install', result: { application: 'applied' } } as never)
    await second
  })

  it('finishes a manual check started while auto update is off', async () => {
    const { manager, calls } = fakeManager()
    const h = harness({ manager, quiet: false, settings: { autoUpdate: false } })
    const checking = h.updater.checkNow()
    await flush()
    expect(h.clock.delays()).toEqual([60_000])
    h.quiet.value = true
    h.clock.fire()
    const status = await checking
    expect(calls.updatedTo).toBe('0.3.1')
    expect(status.lastResult).toMatchObject({ kind: 'updated', from: '0.3.0', to: '0.3.1' })
    expect(h.clock.delays()).toEqual([])
  })
})
