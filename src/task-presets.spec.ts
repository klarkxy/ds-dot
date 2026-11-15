import { describe, expect, it } from 'vitest'
import { pickTaskPreset, usablePresets, type TaskPresetCatalog } from './task-presets.ts'

const CATALOG: TaskPresetCatalog = {
  fallback: 'standard',
  presets: [{ id: 'standard', name: 'Standard' }, { id: 'ptc' }, { id: 'cordis' }, { id: 'dot' }, { id: 'dot-reflection' }, { id: 'mine', broken: 'a row does not load' }],
}

describe('task presets', () => {
  it("leaves out dot's own preset, the reflection pass, and the broken ones", () => {
    expect(usablePresets(CATALOG).map(preset => preset.id)).toEqual(['standard', 'ptc', 'cordis'])
  })

  it('takes the host default when none is asked for, by word or by name', () => {
    expect(pickTaskPreset(CATALOG)).toEqual({ id: 'standard', named: false })
    expect(pickTaskPreset(CATALOG, '  ')).toEqual({ id: 'standard', named: false })
    expect(pickTaskPreset(CATALOG, 'default')).toEqual({ id: 'standard', named: false })
    expect(pickTaskPreset(CATALOG, 'standard')).toEqual({ id: 'standard', named: false })
    // An unnamed or unsafe default must not leak dot's private preset.
    expect(pickTaskPreset({ presets: CATALOG.presets })).toEqual({ id: 'standard', named: true })
    expect(pickTaskPreset({ ...CATALOG, fallback: 'dot' })).toEqual({ id: 'standard', named: true })
    expect(pickTaskPreset({ ...CATALOG, fallback: 'dot-reflection' })).toEqual({ id: 'standard', named: true })
    expect(pickTaskPreset({ ...CATALOG, fallback: 'mine' })).toEqual({ id: 'standard', named: true })
    expect(() => pickTaskPreset({ fallback: 'dot', presets: [{ id: 'dot' }, { id: 'dot-reflection' }] })).toThrow(/No usable preset/)
  })

  it('names another preset, whatever the letter case', () => {
    expect(pickTaskPreset(CATALOG, 'ptc')).toEqual({ id: 'ptc', named: true })
    expect(pickTaskPreset(CATALOG, ' Cordis ')).toEqual({ id: 'cordis', named: true })
  })

  it('refuses what a task cannot run on and says what it can', () => {
    expect(() => pickTaskPreset(CATALOG, 'turbo')).toThrowError(expect.objectContaining({ code: 'dot/unknown-preset', message: expect.stringContaining('standard (the default), ptc, cordis') }))
    expect(() => pickTaskPreset(CATALOG, 'dot')).toThrowError(expect.objectContaining({ code: 'dot/unknown-preset' }))
    expect(() => pickTaskPreset(CATALOG, 'dot-reflection')).toThrowError(expect.objectContaining({ code: 'dot/unknown-preset' }))
    expect(() => pickTaskPreset(CATALOG, 'mine')).toThrowError(expect.objectContaining({ code: 'dot/preset-broken', message: expect.stringContaining('a row does not load') }))
    expect(() => pickTaskPreset({ presets: [{ id: 'dot' }] }, 'ptc')).toThrow(/lists no preset a task can run on/)
  })
})
