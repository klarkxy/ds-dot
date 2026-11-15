/**
 * Dorothy's presets stay registered, but they are not choices for an ordinary
 * session. 0.2.2-rc.1's `PresetDefinition` has no hidden flag, and the composer
 * reads `agentPresets.list` / `remoteExportList`. This wrapper filters those
 * two display methods by id. `resolve(id)` and `mount` keep the explicit id,
 * so dot and the reflection pass still start. An omitted id follows the host
 * default unless that default is one of these presets: a saved internal
 * default is not rewritten, and the next public preset is used instead.
 */
import { PRESET_ID } from './contracts.ts'
import { REFLECTION_PRESET_ID } from './reflection.ts'

export interface ListedPreset {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly broken?: string
  readonly isDefault?: boolean
}

export interface PresetVisibilityRegistry {
  list: () => Promise<readonly ListedPreset[]>
  remoteExportList?: () => Promise<{ presets: readonly ListedPreset[] }>
  resolve?: (id?: string) => Promise<ListedPreset>
}

export function isInternalPreset(id: string): boolean {
  return id === PRESET_ID || id === REFLECTION_PRESET_ID
}

export function visiblePresets<T extends { readonly id: string }>(rows: readonly T[]): T[] {
  return rows.filter(row => !isInternalPreset(row.id))
}

/** The preset an ordinary new session should show and use when no id was requested. */
export function publicDefaultId(rows: readonly ListedPreset[]): string | undefined {
  const visible = visiblePresets(rows)
  const marked = visible.find(row => row.isDefault === true && row.broken === undefined) ?? visible.find(row => row.isDefault === true)
  if (marked) return marked.id
  return (visible.find(row => row.broken === undefined) ?? visible[0])?.id
}

/** Cordis `symbols.original`. A service proxy mints a new function on every read. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function serviceTarget<T extends object>(registry: T): T {
  const original = (registry as Record<symbol, unknown>)[CORDIS_ORIGINAL]
  return original && typeof original === 'object' ? original as T : registry
}

function restoreMethod(raw: object, key: 'list' | 'remoteExportList' | 'resolve', previous: unknown, installed: unknown, wasOwn: boolean): void {
  const record = raw as Record<string, unknown>
  // Compare on the raw service. The proxy's method reads are never ===.
  if (record[key] !== installed) return
  if (wasOwn) record[key] = previous
  else delete record[key]
}

/** Hide the internal presets from roster reads. Returns the disposer. */
export function installPresetVisibility(registry: PresetVisibilityRegistry | undefined): () => void {
  if (!registry || typeof registry.list !== 'function') return () => {}
  const raw = serviceTarget(registry)
  const previousList = raw.list
  const previousRemote = raw.remoteExportList
  const previousResolve = raw.resolve
  const wasOwn = {
    list: Object.prototype.hasOwnProperty.call(raw, 'list'),
    remoteExportList: Object.prototype.hasOwnProperty.call(raw, 'remoteExportList'),
    resolve: Object.prototype.hasOwnProperty.call(raw, 'resolve'),
  }
  const list = previousList.bind(raw)
  const remoteExportList = typeof previousRemote === 'function' ? previousRemote.bind(raw) : undefined
  const resolve = typeof previousResolve === 'function' ? previousResolve.bind(raw) : undefined
  const wrappedList = async () => visiblePresets(await list())
  const readRoster = async (): Promise<readonly ListedPreset[]> => remoteExportList ? (await remoteExportList()).presets : await list()
  const wrappedRemote = remoteExportList
    ? async () => {
      const rows = visiblePresets(await readRoster())
      const chosen = publicDefaultId(rows)
      return { presets: rows.map(row => ({ ...row, isDefault: chosen !== undefined && row.id === chosen })) }
    }
    : undefined
  const wrappedResolve = resolve
    ? async (id?: string) => {
      if (id !== undefined) return resolve(id)
      const chosen = publicDefaultId(await readRoster())
      const current = await resolve(undefined)
      if (chosen === undefined) {
        if (!isInternalPreset(current.id)) return current
        throw new Error('The default agent preset is internal to Dorothy, and no other preset is registered.')
      }
      return current.id === chosen ? current : resolve(chosen)
    }
    : undefined
  raw.list = wrappedList
  if (wrappedRemote && remoteExportList) raw.remoteExportList = wrappedRemote
  if (wrappedResolve && resolve) raw.resolve = wrappedResolve
  return () => {
    restoreMethod(raw, 'list', previousList, wrappedList, wasOwn.list)
    if (wrappedRemote) restoreMethod(raw, 'remoteExportList', previousRemote, wrappedRemote, wasOwn.remoteExportList)
    if (wrappedResolve) restoreMethod(raw, 'resolve', previousResolve, wrappedResolve, wasOwn.resolve)
  }
}
