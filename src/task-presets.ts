/**
 * Which agent preset a task dot starts runs on. A preset is the set of tools
 * and instructions a session works with; the host keeps the roster, and this
 * file holds the pure decisions about dot's request.
 */
import { isInternalPreset } from './preset-visibility.ts'

export interface CatalogPreset {
  readonly id: string
  readonly name?: string
  readonly description?: string
  /** Why the preset cannot be used; absent when it can. */
  readonly broken?: string
}

/** The host's preset roster as dot needs it. */
export interface TaskPresetCatalog {
  /** Preset of a new session that nobody picked one for. */
  readonly fallback?: string
  readonly presets: readonly CatalogPreset[]
}

export class TaskPresetError extends Error {
  constructor(readonly code: 'dot/unknown-preset' | 'dot/preset-broken', message: string) { super(message); this.name = 'TaskPresetError' }
}

/** Presets a task can run on. Dot's own preset and the reflection pass are internal. */
export function usablePresets(catalog: TaskPresetCatalog): CatalogPreset[] {
  return catalog.presets.filter(preset => !isInternalPreset(preset.id) && !preset.broken)
}

const describe = (catalog: TaskPresetCatalog): string => {
  const rows = usablePresets(catalog).map(preset => `${preset.id}${preset.id === catalog.fallback ? ' (the default)' : ''}`)
  return rows.length > 0 ? `Presets on this host: ${rows.join(', ')}.` : 'This host lists no preset a task can run on.'
}

export interface TaskPresetChoice {
  /** Preset the session runs on; undefined when the host names no default. */
  readonly id?: string
  /** Whether the session has to be created with this preset named; false lets it take the host default. */
  readonly named: boolean
}

const findPreset = (presets: readonly CatalogPreset[], id: string): CatalogPreset | undefined =>
  presets.find(preset => preset.id === id) ?? presets.find(preset => preset.id.toLowerCase() === id.toLowerCase())

/**
 * The preset a new task session runs on.
 * Priority: explicit `requested` (non-empty and !== `'default'`) > `defaultPreset`
 * (when present in catalog, non-internal, non-broken) > `catalog.fallback` > `'standard'` > first usable preset.
 * @param requested - what dot asked for: a preset id, or nothing / "default" for the configured default.
 * @param defaultPreset - configured default task preset (e.g. `settings.defaultTaskPreset`).
 * @throws TaskPresetError when an explicit request names no usable preset or no usable preset exists.
 */
export function pickTaskPreset(catalog: TaskPresetCatalog, requested?: string, defaultPreset?: string): TaskPresetChoice {
  const wanted = requested?.trim()
  if (wanted && wanted.toLowerCase() !== 'default') {
    const found = findPreset(catalog.presets, wanted)
    if (!found || isInternalPreset(found.id)) throw new TaskPresetError('dot/unknown-preset', `no preset "${wanted}" for tasks. ${describe(catalog)} Leave preset out for the default.`)
    if (found.broken) throw new TaskPresetError('dot/preset-broken', `preset ${found.id} cannot be used on this host: ${found.broken}. ${describe(catalog)}`)
    // Naming the default is the same as leaving it out.
    return { id: found.id, named: found.id !== catalog.fallback }
  }
  const preferred = defaultPreset?.trim()
  if (preferred && preferred.toLowerCase() !== 'default') {
    const chosen = findPreset(catalog.presets, preferred)
    if (chosen && !isInternalPreset(chosen.id) && !chosen.broken) {
      return { id: chosen.id, named: chosen.id !== catalog.fallback }
    }
  }
  const fallback = catalog.fallback ? catalog.presets.find(preset => preset.id === catalog.fallback) : undefined
  if (fallback && !isInternalPreset(fallback.id) && !fallback.broken) return { id: fallback.id, named: false }
  const standard = catalog.presets.find(preset => preset.id === 'standard')
  if (standard && !isInternalPreset(standard.id) && !standard.broken) return { id: standard.id, named: true }
  const safe = usablePresets(catalog)[0]
  if (!safe) throw new TaskPresetError('dot/unknown-preset', 'No usable preset is available for a task session.')
  return { id: safe.id, named: true }
}
