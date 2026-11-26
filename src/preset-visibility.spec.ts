import { describe, expect, it } from 'vitest'
import { Context, symbols } from '@deepseek-ai/cordis'
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { installInternalPresetCreateGuard, installPresetVisibility, isInternalPreset, publicCreatePreset, publicDefaultId, publicTaskPreset, visiblePresets, type ListedPreset } from './preset-visibility.ts'

const ROWS: ListedPreset[] = [
  { id: 'standard', name: 'Standard' },
  { id: 'ptc', name: 'PTC' },
  { id: 'dot', name: 'Dorothy' },
  { id: 'dot-reflection', name: 'Dot reflection' },
  { id: 'mine', name: 'Mine', broken: 'a row does not load' },
]

function registry(defaultId: string) {
  const state = { defaultId, rows: ROWS.map(row => ({ ...row })) }
  const api = {
    defaultId,
    async list() { return state.rows.map(row => ({ ...row })) },
    async remoteExportList(this: { list: () => Promise<ListedPreset[]> }) {
      const presets = await this.list()
      return { presets: presets.map(row => ({ ...row, isDefault: row.id === state.defaultId })) }
    },
    async resolve(id?: string) {
      const wanted = id ?? state.defaultId
      const found = state.rows.find(row => row.id === wanted)
      if (!found) throw new Error(`missing ${wanted}`)
      return { ...found }
    },
  }
  return { api, state }
}

describe('preset visibility', () => {
  it('drops only the internal preset ids and keeps dot-worker public', () => {
    expect(isInternalPreset('dot')).toBe(true)
    expect(isInternalPreset('dot-reflection')).toBe(true)
    expect(isInternalPreset('dot-worker')).toBe(false)
    const rowsWithWorker: ListedPreset[] = [...ROWS, { id: 'dot-worker', name: 'Dot worker' }]
    expect(visiblePresets(ROWS).map(row => row.id)).toEqual(['standard', 'ptc', 'mine'])
    expect(visiblePresets(rowsWithWorker).map(row => row.id)).toEqual(['standard', 'ptc', 'mine', 'dot-worker'])
    expect(publicDefaultId(rowsWithWorker, 'standard')).toBe('standard')
    expect(publicDefaultId(ROWS.map(row => ({ ...row, isDefault: row.id === 'standard' })))).toBe('standard')
    expect(publicDefaultId(ROWS.map(row => ({ ...row, isDefault: row.id === 'dot' })))).toBe('standard')
    expect(publicDefaultId([{ id: 'dot', isDefault: true }, { id: 'mine', broken: 'no' }])).toBe('mine')
    expect(publicDefaultId(ROWS, 'ptc')).toBe('ptc')
    expect(publicDefaultId(ROWS, 'dot')).toBe('standard')
    expect(publicDefaultId(ROWS)).toBe('standard')
    expect(publicDefaultId(ROWS.map(row => ({ ...row, isDefault: row.id === 'ptc' })), 'standard')).toBe('ptc')
    // Broken defaults fall back to healthy standard / first healthy public preset.
    expect(publicDefaultId(ROWS.map(row => ({ ...row, isDefault: row.id === 'mine' })), 'mine')).toBe('standard')
    expect(publicDefaultId([{ id: 'ptc' }, { id: 'mine', broken: 'no', isDefault: true }], 'mine')).toBe('ptc')
    expect(publicDefaultId([{ id: 'ptc' }, { id: 'standard' }, { id: 'mine', broken: 'no' }], 'mine')).toBe('standard')
    // Uninstalled default stays absent from rows and falls back to healthy standard / first healthy preset.
    expect(publicDefaultId([{ id: 'ptc' }, { id: 'standard' }], 'uninstalled')).toBe('standard')
    expect(publicDefaultId([{ id: 'ptc' }, { id: 'cordis' }], 'uninstalled')).toBe('ptc')
    // healthyOnly refuses to pick a broken preset when no healthy public preset exists.
    expect(publicDefaultId([{ id: 'dot', isDefault: true }, { id: 'mine', broken: 'no' }], 'mine', { healthyOnly: true })).toBeUndefined()
  })

  it('hides the internal presets from the roster and keeps an explicit resolve', async () => {
    const { api, state } = registry('dot')
    const release = installPresetVisibility(api)
    expect((await api.list()).map(row => row.id)).toEqual(['standard', 'ptc', 'mine'])
    const roster = await api.remoteExportList()
    expect(roster.presets.map(row => row.id)).toEqual(['standard', 'ptc', 'mine'])
    expect(roster.presets.find(row => row.isDefault)?.id).toBe('standard')
    await expect(api.resolve(undefined)).resolves.toMatchObject({ id: 'standard' })
    await expect(api.resolve('dot')).resolves.toMatchObject({ id: 'dot', name: 'Dorothy' })
    await expect(api.resolve('dot-reflection')).resolves.toMatchObject({ id: 'dot-reflection' })
    expect(state.defaultId).toBe('dot')
    release()
    expect((await api.list()).map(row => row.id)).toEqual(['standard', 'ptc', 'dot', 'dot-reflection', 'mine'])
    await expect(api.resolve(undefined)).resolves.toMatchObject({ id: 'dot' })
  })

  it('leaves a public default and the other presets alone', async () => {
    const { api } = registry('ptc')
    const release = installPresetVisibility(api)
    try {
      const roster = await api.remoteExportList()
      expect(roster.presets.map(row => row.id)).toEqual(['standard', 'ptc', 'mine'])
      expect(roster.presets.find(row => row.isDefault)?.id).toBe('ptc')
      await expect(api.resolve(undefined)).resolves.toMatchObject({ id: 'ptc' })
      expect((await api.list()).find(row => row.id === 'mine')?.broken).toBe('a row does not load')
    } finally {
      release()
    }
  })

  it('says so when the only registered presets are internal', async () => {
    const { api, state } = registry('dot')
    state.rows = [{ id: 'dot', name: 'Dorothy' }]
    const release = installPresetVisibility(api)
    try {
      expect(await api.list()).toEqual([])
      await expect(api.resolve(undefined)).rejects.toThrow(/internal to Dorothy/)
      await expect(api.resolve('dot')).resolves.toMatchObject({ id: 'dot' })
    } finally {
      release()
    }
  })
})

describe('preset visibility on a Cordis registry', () => {
  it('restores list, remoteExportList, and resolve on the real service proxy', async () => {
    const ctx = new Context()
    const raw = new AgentPresetRegistry(ctx, {
      default: 'dot',
      selectedDefault: { get: () => undefined },
    } as never)
    const api = ctx.agentPresets
    expect(api.list === api.list).toBe(false)
    expect(api[symbols.original]).toBe(raw)
    const releasePresets = await Promise.all([
      api.register({ id: 'dot', name: 'Dorothy', plugins: [] }),
      api.register({ id: 'dot-reflection', name: 'Dot reflection', plugins: [] }),
      api.register({ id: 'standard', name: 'Standard', plugins: [] }),
    ])
    const release = installPresetVisibility(api)
    try {
      expect((await api.list()).map(row => row.id)).toEqual(['standard'])
      const hidden = await api.remoteExportList()
      expect(hidden.presets.map(row => row.id)).toEqual(['standard'])
      expect(hidden.presets.find(row => row.isDefault)?.id).toBe('standard')
      await expect(api.resolve()).resolves.toMatchObject({ id: 'standard' })
      await expect(api.resolve('dot')).resolves.toMatchObject({ id: 'dot' })
      await expect(api.resolve('dot-reflection')).resolves.toMatchObject({ id: 'dot-reflection' })
    } finally {
      release()
    }
    expect((await api.list()).map(row => row.id).sort()).toEqual(['dot', 'dot-reflection', 'standard'])
    const restored = await api.remoteExportList()
    expect(restored.presets.map(row => row.id).sort()).toEqual(['dot', 'dot-reflection', 'standard'])
    expect(restored.presets.find(row => row.isDefault)?.id).toBe('dot')
    await expect(api.resolve()).resolves.toMatchObject({ id: 'dot' })
    await Promise.all(releasePresets.map(dispose => dispose()))
  })

  it('does not remove a method someone else replaced after the filter', async () => {
    const ctx = new Context()
    new AgentPresetRegistry(ctx, {
      default: 'standard',
      selectedDefault: { get: () => undefined },
    } as never)
    const api = ctx.agentPresets
    const raw = api[symbols.original] as AgentPresetRegistry
    await api.register({ id: 'standard', name: 'Standard', plugins: [] })
    const release = installPresetVisibility(api)
    const replacement = async () => [{ id: 'replaced' }]
    raw.list = replacement as typeof raw.list
    release()
    expect(raw.list).toBe(replacement)
    expect(Object.prototype.hasOwnProperty.call(raw, 'remoteExportList')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(raw, 'resolve')).toBe(false)
    await expect(api.list()).resolves.toEqual([{ id: 'replaced' }])
    await expect(api.resolve()).resolves.toMatchObject({ id: 'standard' })
    const roster = await api.remoteExportList()
    expect(roster.presets.map(row => row.id)).toEqual(['replaced'])
    expect(roster.presets[0]?.isDefault).toBe(false)
  })

  it('keeps a host-selected public default that is not the first roster row', async () => {
    const ctx = new Context()
    const raw = new AgentPresetRegistry(ctx, {
      default: 'standard',
      selectedDefault: { get: () => 'ptc' },
    } as never)
    const api = ctx.agentPresets
    const releasePresets = await Promise.all([
      api.register({ id: 'standard', name: 'Standard', order: 1, plugins: [] }),
      api.register({ id: 'ptc', name: 'PTC', order: 10, plugins: [] }),
      api.register({ id: 'dot', name: 'Dorothy', order: 90, plugins: [] }),
    ])
    const hostList = await api.list()
    expect(hostList.map(row => row.id)).toEqual(['standard', 'ptc', 'dot'])
    expect(hostList.every(row => !('isDefault' in row))).toBe(true)
    expect(api.defaultId).toBe('ptc')
    raw.composedPreset = (() => 'dot') as typeof raw.composedPreset
    const release = installPresetVisibility(api, ctx)
    try {
      // Root composedPreset stays untouched for dot / dot-reflection.
      expect(api.composedPreset(ctx)).toBe('dot')
      const listed = await api.list()
      expect(listed.map(row => row.id)).toEqual(['standard', 'ptc'])
      expect(listed[0]?.id).toBe('standard')
      expect(listed.every(row => row.isDefault !== true)).toBe(true)
      expect(api.composedPreset(ctx)).toBe('dot')
      const roster = await api.remoteExportList()
      expect(roster.presets.find(row => row.isDefault)?.id).toBe('ptc')
      await expect(api.resolve()).resolves.toMatchObject({ id: 'ptc' })
      expect(await publicTaskPreset(api)).toBe('ptc')
    } finally {
      release()
      await Promise.all(releasePresets.map(dispose => dispose()))
    }
  })
})

describe('public create preset', () => {
  it('rewrites Dorothy internals to the public default and leaves ordinary ids', () => {
    expect(publicCreatePreset('dot', 'standard')).toBe('standard')
    expect(publicCreatePreset('dot-reflection', 'standard')).toBe('standard')
    expect(publicCreatePreset('ptc', 'standard')).toBe('ptc')
    expect(publicCreatePreset(undefined, 'standard')).toBeUndefined()
    expect(publicCreatePreset('dot', undefined)).toBeUndefined()
  })
})

async function setupScheduleHarness(options: { defaultPreset?: string; selectedDefault?: string; presets: Array<{ id: string; order?: number; broken?: boolean }> }) {
  const ctx = new Context()
  // Minimal stubs needed by AgentPresetRegistry & ToolsService.
  ctx.provide('loader', { await: async () => {} } as never)
  ctx.provide('sessionProjections', { register: async () => ({ stateOf: () => null }) } as never)
  ctx.provide('agents', { turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: 0 }) } as never)
  new SystemPrompt(ctx, {})
  new ToolsService(ctx)
  const raw = new AgentPresetRegistry(ctx, {
    default: options.defaultPreset ?? 'standard',
    selectedDefault: { get: () => options.selectedDefault },
  } as never)
  const releases: Array<() => Promise<void>> = []
  for (const row of options.presets) {
    releases.push(await raw.register({
      id: row.id,
      name: row.id,
      ...(row.order !== undefined ? { order: row.order } : {}),
      plugins: row.broken ? [{ id: 'broken-row', name: '' }] as never : [],
    }))
  }

  const releaseVis = installPresetVisibility(ctx.agentPresets, ctx)
  await (ctx.agentPresets.remoteExportList?.() ?? ctx.agentPresets.list())

  const mountSession = async (id: string, preset?: string) => {
    const agent: { id: string; ctx?: Context } = { id }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    const mounted = await ctx.agentPresets.mount(scope.ctx, preset)
    return { scope, agent: agent as { id: string; ctx: Context }, mounted }
  }

  // Executor using real ToolExecutionPipeline (`executeToolBatch`) so `tools/execute` fires identically to DSH.
  const pipeline = new ToolExecutionPipeline(ctx)
  ctx.tools.setExecutor({
    describe: tools => ({ schemas: tools.map(t => ({ name: t.name, description: t.description, parameters: { type: 'object', properties: {} } })) }),
    execute: input => executeToolBatch(input, pipeline, () => 4),
  })

  return {
    ctx,
    raw,
    mountSession,
    async dispose() {
      releaseVis()
      await Promise.all(releases.map(d => d()))
    },
  }
}

describe('scoped preset visibility for dsh-tool-schedule and HOST_SCHEDULE_MUTATORS', () => {
  it('does not pollute root composedPreset for dot or dot-reflection across other plugins', async () => {
    const h = await setupScheduleHarness({
      selectedDefault: 'unrestricted',
      presets: [
        { id: 'standard', order: 1 },
        { id: 'unrestricted', order: 2 },
        { id: 'cordis', order: 3 },
        { id: 'dot', order: 90 },
        { id: 'dot-reflection', order: 91 },
      ],
    })
    const dot = await h.mountSession('dot-1', 'dot')
    const refl = await h.mountSession('refl-1', 'dot-reflection')
    const ordinary = await h.mountSession('user-1', 'unrestricted')
    try {
      // Simulate sibling plugins like @klarkxy/dsh-unrestricted, dsh-dev-index, dsh-prompt-override.
      let seenByUnrestricted: string | undefined
      let seenByDevIndex: string | undefined
      let seenByPromptOverride: string | undefined
      h.ctx.plugin({
        name: '@klarkxy/dsh-unrestricted',
        inject: ['agentPresets'],
        apply(pCtx) { seenByUnrestricted = pCtx.agentPresets.composedPreset(dot.agent.ctx) },
      })
      h.ctx.plugin({
        name: '@klarkxy/dsh-dev-index',
        inject: ['agentPresets'],
        apply(pCtx) { seenByDevIndex = pCtx.agentPresets.composedPreset(refl.agent.ctx) },
      })
      h.ctx.plugin({
        name: '@klarkxy/dsh-prompt-override',
        inject: ['agentPresets'],
        apply(pCtx) { seenByPromptOverride = pCtx.agentPresets.composedPreset(dot.agent.ctx) },
      })
      await Promise.resolve()

      expect(h.ctx.agentPresets.composedPreset(dot.agent.ctx)).toBe('dot')
      expect(h.ctx.agentPresets.composedPreset(refl.agent.ctx)).toBe('dot-reflection')
      expect(h.ctx.agentPresets.composedPreset(ordinary.agent.ctx)).toBe('unrestricted')
      expect(seenByUnrestricted).toBe('dot')
      expect(seenByDevIndex).toBe('dot-reflection')
      expect(seenByPromptOverride).toBe('dot')

      // Even concurrently while schedule_create executes for dot, dot-reflection and root reads stay unpolluted.
      let concurrentReflection: string | undefined
      h.ctx.tools.register({
        name: 'schedule_create',
        description: 'create schedule',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        async execute(_args, exec) {
          await Promise.resolve()
          concurrentReflection = h.ctx.agentPresets.composedPreset(refl.agent.ctx)
          return exec.agent?.ctx.get('agentPresets')?.composedPreset(exec.agent.ctx) ?? 'none'
        },
      } as never)
      const res = await h.ctx.tools.execute({
        agent: dot.agent as never,
        signal: new AbortController().signal,
        calls: [{ id: 'c1', name: 'schedule_create', arguments: '{}' }] as never,
      })
      expect(res.results[0]?.result).toMatchObject({ isError: false, value: 'unrestricted' })
      expect(concurrentReflection).toBe('dot-reflection')
    } finally {
      await dot.scope.dispose()
      await refl.scope.dispose()
      await ordinary.scope.dispose()
      await h.dispose()
    }
  })

  it('scopes composedPreset rewrite to @deepseek-ai/dsh-tool-schedule via internal/get', async () => {
    const h = await setupScheduleHarness({
      selectedDefault: 'ptc',
      presets: [
        { id: 'standard', order: 1 },
        { id: 'ptc', order: 2 },
        { id: 'dot', order: 90 },
        { id: 'dot-reflection', order: 91 },
      ],
    })
    const dot = await h.mountSession('dot-1', 'dot')
    const refl = await h.mountSession('refl-1', 'dot-reflection')
    const ptc = await h.mountSession('ptc-1', 'ptc')
    try {
      let schedulePresets: { composedPreset(c: unknown): string | undefined } | undefined
      h.ctx.plugin({
        name: '@deepseek-ai/dsh-tool-schedule',
        inject: ['agentPresets'],
        apply(pCtx) { schedulePresets = pCtx.agentPresets },
      })
      await Promise.resolve()
      expect(schedulePresets?.composedPreset(dot.agent.ctx)).toBe('ptc')
      expect(schedulePresets?.composedPreset(refl.agent.ctx)).toBe('ptc')
      expect(schedulePresets?.composedPreset(ptc.agent.ctx)).toBe('ptc')
      // Root remains exact.
      expect(h.ctx.agentPresets.composedPreset(dot.agent.ctx)).toBe('dot')
      expect(h.ctx.agentPresets.composedPreset(refl.agent.ctx)).toBe('dot-reflection')
    } finally {
      await dot.scope.dispose()
      await refl.scope.dispose()
      await ptc.scope.dispose()
      await h.dispose()
    }
  })

  it('falls back to healthy standard or first healthy preset when default is uninstalled or broken', async () => {
    // Case 1: selectedDefault is uninstalled (absent from registry / lastRows)
    const uninstalled = await setupScheduleHarness({
      defaultPreset: 'standard',
      selectedDefault: 'removed-plugin-preset',
      presets: [
        { id: 'ptc', order: 1 },
        { id: 'standard', order: 2 },
        { id: 'dot', order: 90 },
      ],
    })
    const dot1 = await uninstalled.mountSession('dot-1', 'dot')
    try {
      expect(uninstalled.raw.defaultId).toBe('removed-plugin-preset')
      expect(await publicTaskPreset(uninstalled.ctx.agentPresets)).toBe('standard')
      uninstalled.ctx.tools.register({
        name: 'schedule_create',
        description: 'create',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        execute: (_a, exec) => uninstalled.ctx.agentPresets.composedPreset((exec.agent as { ctx: never }).ctx) ?? 'none',
      } as never)
      const res = await uninstalled.ctx.tools.execute({
        agent: dot1.agent as never,
        signal: new AbortController().signal,
        calls: [{ id: 'c1', name: 'schedule_create', arguments: '{}' }] as never,
      })
      expect(res.results[0]?.result).toMatchObject({ isError: false, value: 'standard' })
    } finally {
      await dot1.scope.dispose()
      await uninstalled.dispose()
    }

    // Case 2: selectedDefault is broken (broken field present in list/lastRows)
    const broken = await setupScheduleHarness({
      defaultPreset: 'standard',
      selectedDefault: 'broken-default',
      presets: [
        { id: 'ptc', order: 1 },
        { id: 'broken-default', order: 5, broken: true },
        { id: 'dot', order: 90 },
      ],
    })
    const dot2 = await broken.mountSession('dot-2', 'dot')
    try {
      expect(broken.raw.defaultId).toBe('broken-default')
      const rawRows = await broken.raw.list()
      expect(rawRows.find(p => p.id === 'broken-default')?.broken).toBeTruthy()
      expect(await publicTaskPreset(broken.ctx.agentPresets)).toBe('ptc')
      const roster = await broken.ctx.agentPresets.remoteExportList()
      expect(roster.presets.find(p => p.isDefault)?.id).toBe('ptc')
      await expect(broken.ctx.agentPresets.resolve()).resolves.toMatchObject({ id: 'ptc' })
      broken.ctx.tools.register({
        name: 'schedule_edit',
        description: 'edit',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        execute: (_a, exec) => broken.ctx.agentPresets.composedPreset((exec.agent as { ctx: never }).ctx) ?? 'none',
      } as never)
      const res = await broken.ctx.tools.execute({
        agent: dot2.agent as never,
        signal: new AbortController().signal,
        calls: [{ id: 'c2', name: 'schedule_edit', arguments: '{}' }] as never,
      })
      expect(res.results[0]?.result).toMatchObject({ isError: false, value: 'ptc' })
    } finally {
      await dot2.scope.dispose()
      await broken.dispose()
    }

    // Case 3: broken default with healthy standard present prefers standard over an earlier-ordered preset
    const brokenPreferStandard = await setupScheduleHarness({
      defaultPreset: 'standard',
      selectedDefault: 'broken-default',
      presets: [
        { id: 'ptc', order: 1 },
        { id: 'standard', order: 2 },
        { id: 'broken-default', order: 5, broken: true },
        { id: 'dot', order: 90 },
      ],
    })
    const dot3 = await brokenPreferStandard.mountSession('dot-3', 'dot')
    try {
      expect(await publicTaskPreset(brokenPreferStandard.ctx.agentPresets)).toBe('standard')
      const createdFromGuard: Record<string, unknown>[] = []
      const guardController = { async create(req: Record<string, unknown>) { createdFromGuard.push(req); return { sessionId: 's-g' } } }
      const unguard = installInternalPresetCreateGuard(guardController, () => publicTaskPreset(brokenPreferStandard.ctx.agentPresets))
      try {
        brokenPreferStandard.ctx.tools.register({
          name: 'schedule_create',
          description: 'create',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
          execute: (_a, exec) => brokenPreferStandard.ctx.agentPresets.composedPreset((exec.agent as { ctx: never }).ctx) ?? 'none',
        } as never)
        const res = await brokenPreferStandard.ctx.tools.execute({
          agent: dot3.agent as never,
          signal: new AbortController().signal,
          calls: [{ id: 'c3', name: 'schedule_create', arguments: '{}' }] as never,
        })
        expect(res.results[0]?.result).toMatchObject({ isError: false, value: 'standard' })
        await guardController.create({ cwd: '/w', agentPreset: 'dot' })
        expect(createdFromGuard).toEqual([{ cwd: '/w', agentPreset: 'standard' }])
      } finally { unguard() }
    } finally {
      await dot3.scope.dispose()
      await brokenPreferStandard.dispose()
    }
  })

  it('covers host schedule save, first delivery, and session creation including legacy internal schedules', async () => {
    const h = await setupScheduleHarness({
      selectedDefault: 'ptc',
      presets: [
        { id: 'standard', order: 1 },
        { id: 'ptc', order: 2 },
        { id: 'dot', order: 90 },
        { id: 'dot-reflection', order: 91 },
      ],
    })
    const dot = await h.mountSession('dot-main', 'dot')
    const savedSchedules: Array<{ id: string; target: 'new' | 'new_once'; cwd: string; agentPreset?: string }> = []
    const createdSessions: Array<{ sessionId: string; cwd: string; agentPreset?: string; mountedId: string }> = []
    let nextSession = 0
    const controller = {
      async create(request: Record<string, unknown>) {
        const sessionId = `sched-sess-${++nextSession}`
        const scope = createScope(h.ctx, { id: sessionId })
        const mounted = await h.ctx.agentPresets.mount(scope.ctx, typeof request.agentPreset === 'string' ? request.agentPreset : undefined)
        createdSessions.push({ sessionId, cwd: String(request.cwd ?? ''), ...(typeof request.agentPreset === 'string' ? { agentPreset: request.agentPreset } : {}), mountedId: mounted.id })
        await scope.dispose()
        return { sessionId }
      },
    }
    const unguard = installInternalPresetCreateGuard(controller, () => publicTaskPreset(h.ctx.agentPresets))
    try {
      h.ctx.plugin({
        name: '@deepseek-ai/dsh-tool-schedule',
        inject: ['tools', 'agentPresets'],
        apply(sCtx) {
          sCtx.tools.register({
            name: 'schedule_create',
            description: 'save host schedule',
            parameters: { type: 'object', properties: { target: { type: 'string' }, cwd: { type: 'string' } } },
            output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
            execute(args, exec) {
              const input = args as { target: 'new' | 'new_once'; cwd: string }
              const preset = sCtx.agentPresets.composedPreset((exec.agent as { ctx: never }).ctx)
              const id = `sch-${savedSchedules.length + 1}`
              savedSchedules.push({ id, target: input.target, cwd: input.cwd, ...(preset !== undefined ? { agentPreset: preset } : {}) })
              return id
            },
          } as never)
        },
      })
      await Promise.resolve()

      // 1. Dorothy creates new & new_once host schedules via ToolsService.
      const batch = await h.ctx.tools.execute({
        agent: dot.agent as never,
        signal: new AbortController().signal,
        calls: [
          { id: 'c1', name: 'schedule_create', arguments: JSON.stringify({ target: 'new', cwd: '/repo' }) },
          { id: 'c2', name: 'schedule_create', arguments: JSON.stringify({ target: 'new_once', cwd: '/repo' }) },
        ] as never,
      })
      expect(batch.results.every(r => !r.result.isError)).toBe(true)
      expect(savedSchedules).toEqual([
        { id: 'sch-1', target: 'new', cwd: '/repo', agentPreset: 'ptc' },
        { id: 'sch-2', target: 'new_once', cwd: '/repo', agentPreset: 'ptc' },
      ])

      // 2. Host scheduler delivers saved schedules and creates ordinary sessions.
      const deliverSchedule = async (row: { cwd: string; agentPreset?: string }) =>
        controller.create({ cwd: row.cwd, ...(row.agentPreset !== undefined ? { agentPreset: row.agentPreset } : {}) })
      await deliverSchedule(savedSchedules[0]!)
      await deliverSchedule(savedSchedules[1]!)

      // 3. Legacy schedules that already persisted internal presets also deliver onto healthy public presets.
      await deliverSchedule({ cwd: '/legacy-1', agentPreset: 'dot' })
      await deliverSchedule({ cwd: '/legacy-2', agentPreset: 'dot-reflection' })

      expect(createdSessions).toEqual([
        { sessionId: 'sched-sess-1', cwd: '/repo', agentPreset: 'ptc', mountedId: 'ptc' },
        { sessionId: 'sched-sess-2', cwd: '/repo', agentPreset: 'ptc', mountedId: 'ptc' },
        { sessionId: 'sched-sess-3', cwd: '/legacy-1', agentPreset: 'ptc', mountedId: 'ptc' },
        { sessionId: 'sched-sess-4', cwd: '/legacy-2', agentPreset: 'ptc', mountedId: 'ptc' },
      ])
    } finally {
      unguard()
      await dot.scope.dispose()
      await h.dispose()
    }
  })
})

describe('session create guard', () => {
  it('rewrites new-session creates that would inherit the coordinator preset', async () => {
    const created: Record<string, unknown>[] = []
    const controller = {
      async create(request: Record<string, unknown>) {
        created.push(request)
        return { sessionId: 's1' }
      },
    }
    const release = installInternalPresetCreateGuard(controller, async () => 'standard')
    try {
      await expect(controller.create({ cwd: '/w', agentPreset: 'dot' })).resolves.toEqual({ sessionId: 's1' })
      await expect(controller.create({ cwd: '/w', agentPreset: 'dot-reflection' })).resolves.toEqual({ sessionId: 's1' })
      await expect(controller.create({ cwd: '/w', agentPreset: 'ptc' })).resolves.toEqual({ sessionId: 's1' })
      await expect(controller.create({ cwd: '/w' })).resolves.toEqual({ sessionId: 's1' })
    } finally {
      release()
    }
    expect(created).toEqual([
      { cwd: '/w', agentPreset: 'standard' },
      { cwd: '/w', agentPreset: 'standard' },
      { cwd: '/w', agentPreset: 'ptc' },
      { cwd: '/w' },
    ])
  })

  it('refuses an internal create when no public task preset exists', async () => {
    const controller = { async create() { return { sessionId: 's1' } } }
    const release = installInternalPresetCreateGuard(controller, async () => undefined)
    try {
      await expect(controller.create({ agentPreset: 'dot' })).rejects.toThrow(/no public task preset/)
    } finally {
      release()
    }
  })
})
