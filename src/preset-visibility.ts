/**
 * Dorothy's presets stay registered, but they are not choices for an ordinary
 * session. 0.2.2-rc.1's `PresetDefinition` has no hidden flag, and the composer
 * reads `agentPresets.list` / `remoteExportList`. This wrapper filters those
 * two display methods by id. `resolve(id)` and `mount` keep the explicit id,
 * so dot and the reflection pass still start. An omitted id follows the host
 * default unless that default is one of these presets: a saved internal
 * default is not rewritten, and the next public preset is used instead.
 *
 * Host `schedule_create` / `schedule_edit` with target `new` / `new_once`
 * copy `composedPreset` into the child session. That would inherit `dot`
 * (no file or shell). `composedPreset` and `sessionController.create` both
 * rewrite an internal id to a public task preset so those jobs stay ordinary.
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
  readonly defaultId?: string
}

export interface SessionCreateController {
  create(request: Record<string, unknown>): Promise<{ sessionId: string }>
}

export function isInternalPreset(id: string): boolean {
  return id === PRESET_ID || id === REFLECTION_PRESET_ID
}

export function visiblePresets<T extends { readonly id: string }>(rows: readonly T[]): T[] {
  return rows.filter(row => !isInternalPreset(row.id))
}

function hostDefaultIdOf(registry: { readonly defaultId?: string } | undefined): string | undefined {
  const id = registry?.defaultId
  return typeof id === 'string' && id ? id : undefined
}

/**
 * The preset an ordinary new session should show and use when no id was requested.
 *
 * Host `list()` does not mark `isDefault`; `remoteExportList()` does, from
 * `defaultId`. An unmarked roster must not treat the first visible row as the
 * default when the host already selected a public one.
 */
export function publicDefaultId(rows: readonly ListedPreset[], hostDefaultId?: string): string | undefined {
  const visible = visiblePresets(rows)
  const marked = visible.find(row => row.isDefault === true && row.broken === undefined) ?? visible.find(row => row.isDefault === true)
  if (marked) return marked.id
  if (hostDefaultId && !isInternalPreset(hostDefaultId)) {
    const selected = visible.find(row => row.id === hostDefaultId)
    if (selected) return selected.id
  }
  return (visible.find(row => row.broken === undefined) ?? visible[0])?.id
}

/** Public default for a new ordinary session, from the live registry. */
export async function publicTaskPreset(registry: PresetVisibilityRegistry | undefined): Promise<string | undefined> {
  if (!registry || typeof registry.list !== 'function') return undefined
  const hostDefault = hostDefaultIdOf(registry)
  if (typeof registry.remoteExportList === 'function') {
    const roster = await registry.remoteExportList()
    return publicDefaultId(roster.presets, hostDefault)
  }
  return publicDefaultId(await registry.list(), hostDefault)
}

/**
 * Preset a host session create may use. Internal Dorothy ids become the public
 * default. `undefined` means "omit and follow the host default".
 */
export function publicCreatePreset(requested: unknown, publicDefault: string | undefined): string | undefined {
  if (typeof requested !== 'string') return typeof requested === 'undefined' ? undefined : publicDefault
  const id = requested.trim()
  if (!id) return publicDefault
  if (!isInternalPreset(id)) return id
  return publicDefault
}

/** Cordis `symbols.original`. A service proxy mints a new function on every read. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function serviceTarget<T extends object>(registry: T): T {
  const original = Reflect.get(registry, CORDIS_ORIGINAL)
  return original && typeof original === 'object' ? original as T : registry
}

function restoreMethod(raw: object, key: string, previous: unknown, installed: unknown, wasOwn: boolean): void {
  const record = raw as Record<string, unknown>
  // Compare on the raw service. The proxy's method reads are never ===.
  if (record[key] !== installed) return
  if (wasOwn) record[key] = previous
  else delete record[key]
}

function ownFlag(raw: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
}

/** Hide the internal presets from roster reads. Returns the disposer. */
export function installPresetVisibility(registry: PresetVisibilityRegistry | undefined): () => void {
  if (!registry || typeof registry.list !== 'function') return () => {}
  const raw = serviceTarget(registry)
  const previousList = raw.list
  const previousRemote = raw.remoteExportList
  const previousResolve = raw.resolve
  const previousComposed = Reflect.get(raw, 'composedPreset')
  const wasOwn = {
    list: ownFlag(raw, 'list'),
    remoteExportList: ownFlag(raw, 'remoteExportList'),
    resolve: ownFlag(raw, 'resolve'),
    composedPreset: ownFlag(raw, 'composedPreset'),
  }
  const list = previousList.bind(raw)
  const remoteExportList = typeof previousRemote === 'function' ? previousRemote.bind(raw) : undefined
  const resolve = typeof previousResolve === 'function' ? previousResolve.bind(raw) : undefined
  const composed = typeof previousComposed === 'function'
    ? (previousComposed as (...args: never[]) => unknown).bind(raw)
    : undefined
  const hostDefault = () => hostDefaultIdOf(raw)
  const choosePublic = (rows: readonly ListedPreset[]) => publicDefaultId(rows, hostDefault())
  let publicId = (() => {
    const live = hostDefault()
    return live && !isInternalPreset(live) ? live : undefined
  })()
  const remember = (rows: readonly ListedPreset[]): readonly ListedPreset[] => {
    publicId = choosePublic(rows) ?? publicId
    return rows
  }
  const wrappedList = async () => remember(visiblePresets(await list()))
  const readRoster = async (): Promise<readonly ListedPreset[]> => remoteExportList ? (await remoteExportList()).presets : await list()
  const wrappedRemote = remoteExportList
    ? async () => {
      const rows = remember(visiblePresets(await readRoster()))
      const chosen = choosePublic(rows)
      return { presets: rows.map(row => ({ ...row, isDefault: chosen !== undefined && row.id === chosen })) }
    }
    : undefined
  const wrappedResolve = resolve
    ? async (id?: string) => {
      if (id !== undefined) return resolve(id)
      const chosen = choosePublic(remember(visiblePresets(await readRoster())))
      const current = await resolve(undefined)
      if (chosen === undefined) {
        if (!isInternalPreset(current.id)) return current
        throw new Error('The default agent preset is internal to Dorothy, and no other preset is registered.')
      }
      return current.id === chosen ? current : resolve(chosen)
    }
    : undefined
  const wrappedComposed = composed
    ? (...args: never[]) => {
      const id = composed(...args)
      if (typeof id !== 'string' || !isInternalPreset(id)) return id
      const live = hostDefault()
      if (live && !isInternalPreset(live)) return live
      return publicId
    }
    : undefined
  raw.list = wrappedList
  if (wrappedRemote && remoteExportList) raw.remoteExportList = wrappedRemote
  if (wrappedResolve && resolve) raw.resolve = wrappedResolve
  if (wrappedComposed) Reflect.set(raw, 'composedPreset', wrappedComposed)
  return () => {
    restoreMethod(raw, 'list', previousList, wrappedList, wasOwn.list)
    if (wrappedRemote) restoreMethod(raw, 'remoteExportList', previousRemote, wrappedRemote, wasOwn.remoteExportList)
    if (wrappedResolve) restoreMethod(raw, 'resolve', previousResolve, wrappedResolve, wasOwn.resolve)
    if (wrappedComposed) restoreMethod(raw, 'composedPreset', previousComposed, wrappedComposed, wasOwn.composedPreset)
  }
}

/**
 * Host session creates that name Dorothy's internal preset (schedule `new` /
 * `new_once` inherit `composedPreset`) are rewritten to a public task preset.
 * `createDot` / `createInternal` go through `agents.create`, not this path.
 */
function isSessionCreateController(value: unknown): value is SessionCreateController {
  return !!value && typeof value === 'object' && typeof Reflect.get(value, 'create') === 'function'
}

export function installInternalPresetCreateGuard(
  controller: unknown,
  publicPreset: () => Promise<string | undefined>,
): () => void {
  if (!isSessionCreateController(controller)) return () => {}
  const raw = serviceTarget(controller)
  const previous = raw.create
  const wasOwn = ownFlag(raw, 'create')
  const create = previous.bind(raw)
  const wrapped = async (request: Record<string, unknown>) => {
    const body = request && typeof request === 'object' && !Array.isArray(request) ? request : {}
    const current = body.agentPreset
    if (typeof current !== 'string' || !isInternalPreset(current.trim())) return create(request)
    const next = publicCreatePreset(current, await publicPreset())
    if (next === undefined) {
      throw new Error('Host schedule cannot create a session with Dorothy\'s internal preset, and no public task preset is available.')
    }
    return create({ ...body, agentPreset: next })
  }
  raw.create = wrapped
  return () => restoreMethod(raw, 'create', previous, wrapped, wasOwn)
}
