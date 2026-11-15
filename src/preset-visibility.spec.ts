import { describe, expect, it } from 'vitest'
import { Context, symbols } from '@deepseek-ai/cordis'
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { installPresetVisibility, isInternalPreset, publicDefaultId, visiblePresets, type ListedPreset } from './preset-visibility.ts'

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
})
