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

  it('applies 3-tier priority: explicit requested > defaultPreset > standard/fallback', () => {
    const withWorker: TaskPresetCatalog = {
      fallback: 'standard',
      presets: [{ id: 'standard', name: 'Standard' }, { id: 'dot-worker', name: 'Dot worker' }, { id: 'ptc' }, { id: 'dot' }],
    }
    // Configured defaultTaskPreset = 'dot-worker' selects dot-worker when preset is omitted or 'default'.
    expect(pickTaskPreset(withWorker, undefined, 'dot-worker')).toEqual({ id: 'dot-worker', named: true })
    expect(pickTaskPreset(withWorker, '  ', 'dot-worker')).toEqual({ id: 'dot-worker', named: true })
    expect(pickTaskPreset(withWorker, 'default', 'dot-worker')).toEqual({ id: 'dot-worker', named: true })

    // Explicit requested preset overrides defaultTaskPreset.
    expect(pickTaskPreset(withWorker, 'standard', 'dot-worker')).toEqual({ id: 'standard', named: false })
    expect(pickTaskPreset(withWorker, 'ptc', 'dot-worker')).toEqual({ id: 'ptc', named: true })

    // When defaultPreset is 'standard' and catalog lacks 'standard' (e.g. only 'ptc'), falls back gracefully.
    expect(pickTaskPreset({ fallback: 'ptc', presets: [{ id: 'ptc' }] }, undefined, 'standard')).toEqual({ id: 'ptc', named: false })

    // When defaultPreset ('dot-worker') is missing, broken, or internal, falls back gracefully without throwing.
    expect(pickTaskPreset(CATALOG, undefined, 'dot-worker')).toEqual({ id: 'standard', named: false })
    expect(pickTaskPreset({
      fallback: 'standard',
      presets: [{ id: 'standard' }, { id: 'dot-worker', broken: 'failed to mount' }],
    }, undefined, 'dot-worker')).toEqual({ id: 'standard', named: false })
    expect(pickTaskPreset(withWorker, undefined, 'dot')).toEqual({ id: 'standard', named: false })

    // Explicit broken/unknown request still throws even if defaultPreset is valid.
    expect(() => pickTaskPreset({
      fallback: 'standard',
      presets: [{ id: 'standard' }, { id: 'dot-worker', broken: 'failed to mount' }],
    }, 'dot-worker', 'standard')).toThrowError(expect.objectContaining({ code: 'dot/preset-broken' }))
    expect(() => pickTaskPreset(CATALOG, 'dot-worker', 'standard')).toThrowError(expect.objectContaining({ code: 'dot/unknown-preset' }))
  })
})
