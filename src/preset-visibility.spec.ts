import { describe, expect, it } from 'vitest'
import { Context, symbols } from '@deepseek-ai/cordis'
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
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
  it('drops only the internal preset ids', () => {
    expect(isInternalPreset('dot')).toBe(true)
    expect(isInternalPreset('dot-reflection')).toBe(true)
    expect(visiblePresets(ROWS).map(row => row.id)).toEqual(['standard', 'ptc', 'mine'])
    expect(publicDefaultId(ROWS.map(row => ({ ...row, isDefault: row.id === 'standard' })))).toBe('standard')
    expect(publicDefaultId(ROWS.map(row => ({ ...row, isDefault: row.id === 'dot' })))).toBe('standard')
    expect(publicDefaultId([{ id: 'dot', isDefault: true }, { id: 'mine', broken: 'no' }])).toBe('mine')
    expect(publicDefaultId(ROWS, 'ptc')).toBe('ptc')
    expect(publicDefaultId(ROWS, 'dot')).toBe('standard')
    expect(publicDefaultId(ROWS)).toBe('standard')
    expect(publicDefaultId(ROWS.map(row => ({ ...row, isDefault: row.id === 'ptc' })), 'standard')).toBe('ptc')
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
    const release = installPresetVisibility(api)
    try {
      expect(api.composedPreset()).toBe('ptc')
      const listed = await api.list()
      expect(listed.map(row => row.id)).toEqual(['standard', 'ptc'])
      expect(listed[0]?.id).toBe('standard')
      expect(listed.every(row => row.isDefault !== true)).toBe(true)
      expect(api.composedPreset()).toBe('ptc')
      const roster = await api.remoteExportList()
      expect(roster.presets.find(row => row.isDefault)?.id).toBe('ptc')
      await expect(api.resolve()).resolves.toMatchObject({ id: 'ptc' })
      expect(await publicTaskPreset(api)).toBe('ptc')
      const created: Record<string, unknown>[] = []
      const controller = {
        async create(request: Record<string, unknown>) {
          created.push(request)
          return { sessionId: 's1' }
        },
      }
      const unguard = installInternalPresetCreateGuard(controller, () => publicTaskPreset(api))
      try {
        await controller.create({ cwd: '/w', agentPreset: 'dot' })
        await controller.create({ cwd: '/w', agentPreset: 'dot-reflection' })
        expect(targetFor(api.composedPreset(), 'new').create).toEqual({ agentPreset: 'ptc' })
        expect(targetFor(api.composedPreset(), 'new_once').create).toEqual({ agentPreset: 'ptc' })
      } finally {
        unguard()
      }
      expect(created).toEqual([
        { cwd: '/w', agentPreset: 'ptc' },
        { cwd: '/w', agentPreset: 'ptc' },
      ])
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

describe('composedPreset does not leak the coordinator id', () => {
  it('returns a public preset when the live mount is internal', async () => {
    const rows: ListedPreset[] = [
      { id: 'standard', name: 'Standard' },
      { id: 'dot', name: 'Dorothy' },
    ]
    const api = {
      defaultId: 'dot',
      composedPreset: () => 'dot',
      async list() { return rows },
      async resolve(id?: string) {
        const wanted = id ?? 'dot'
        const found = rows.find(row => row.id === wanted)
        if (!found) throw new Error(`missing ${wanted}`)
        return { ...found }
      },
    }
    const release = installPresetVisibility(api)
    try {
      expect((await api.list()).map(row => row.id)).toEqual(['standard'])
      expect(api.composedPreset()).toBe('standard')
      expect(targetFor(api.composedPreset(), 'new').create).toEqual({ agentPreset: 'standard' })
      expect(targetFor(api.composedPreset(), 'new_once').create).toEqual({ agentPreset: 'standard' })
    } finally {
      release()
    }
    expect(api.composedPreset()).toBe('dot')
  })

  it('uses a public defaultId before the first roster read', () => {
    const api = {
      defaultId: 'standard',
      composedPreset: () => 'dot',
      async list() { return [{ id: 'standard' }, { id: 'dot' }] },
    }
    const release = installPresetVisibility(api)
    try {
      expect(api.composedPreset()).toBe('standard')
    } finally {
      release()
    }
  })

  it('does not replace a public defaultId after an unmarked list()', async () => {
    const api = {
      defaultId: 'ptc',
      composedPreset: () => 'dot',
      async list() { return [{ id: 'standard' }, { id: 'ptc' }, { id: 'dot' }] },
      async remoteExportList() {
        return { presets: [{ id: 'standard' }, { id: 'ptc', isDefault: true }, { id: 'dot' }] }
      },
    }
    const release = installPresetVisibility(api)
    try {
      expect(api.composedPreset()).toBe('ptc')
      expect((await api.list()).map(row => row.id)).toEqual(['standard', 'ptc'])
      expect(api.composedPreset()).toBe('ptc')
      expect(await publicTaskPreset(api)).toBe('ptc')
      const created: Record<string, unknown>[] = []
      const controller = {
        async create(request: Record<string, unknown>) {
          created.push(request)
          return { sessionId: 's1' }
        },
      }
      const unguard = installInternalPresetCreateGuard(controller, () => publicTaskPreset(api))
      try {
        await controller.create({ cwd: '/w', agentPreset: 'dot' })
        expect(targetFor(api.composedPreset(), 'new').create).toEqual({ agentPreset: 'ptc' })
        expect(targetFor(api.composedPreset(), 'new_once').create).toEqual({ agentPreset: 'ptc' })
      } finally {
        unguard()
      }
      expect(created).toEqual([{ cwd: '/w', agentPreset: 'ptc' }])
    } finally {
      release()
    }
  })
})

function targetFor(composed: string | undefined, target: 'new' | 'new_once') {
  return {
    kind: target,
    create: { ...(composed === undefined ? {} : { agentPreset: composed }) },
  }
}

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
