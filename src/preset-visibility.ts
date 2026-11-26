/**
 * Dorothy's presets stay registered, but they are not choices for an ordinary
 * session. 0.2.2-rc.1's `PresetDefinition` has no hidden flag, and the composer
 * reads `agentPresets.list` / `remoteExportList`. This wrapper filters those
 * two display methods by id. `resolve(id)` and `mount` keep the explicit id,
 * so dot and the reflection pass still start. An omitted id follows the host
 * default unless that default is internal, uninstalled, or broken: a saved
 * internal default is not rewritten, and the next healthy public preset is
 * used instead.
 *
 * Host `schedule_create` / `schedule_edit` with target `new` / `new_once`
 * copy `composedPreset` into the child session. That would inherit `dot`
 * (no file or shell). Never rewrite `composedPreset` globally on root
 * `agentPresets` — plugins like `@klarkxy/dsh-unrestricted`, `dsh-dev-index`,
 * and `dsh-prompt-override` rely on it to identify `dot` / `dot-reflection`.
 * Instead, scope the substitution to `@deepseek-ai/dsh-tool-schedule` and
 * `HOST_SCHEDULE_MUTATORS`, keeping `sessionController.create` as a guard.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { symbols } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { HOST_SCHEDULE_MUTATORS } from './capabilities.ts'
import { PRESET_ID, WATCHDOG_PRESET_ID } from './contracts.ts'
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

export interface PresetVisibilityContext {
  readonly on?: unknown
}

export interface PublicDefaultOptions {
  readonly healthyOnly?: boolean
}

export interface SessionCreateController {
  create(request: Record<string, unknown>): Promise<{ sessionId: string }>
}

const SCHEDULE_PLUGIN_NAME = '@deepseek-ai/dsh-tool-schedule'

function isSchedulePluginName(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false
  return value === SCHEDULE_PLUGIN_NAME
    || value === 'dsh-tool-schedule'
    || value.startsWith(`${SCHEDULE_PLUGIN_NAME}/`)
}

function isSchedulePluginContext(accessCtx: unknown): boolean {
  if (!accessCtx || typeof accessCtx !== 'object') return false
  const shadow = Reflect.get(accessCtx, symbols.shadow)
  const defSite = shadow && typeof shadow === 'object' ? shadow : accessCtx
  let fiber = Reflect.get(defSite, 'fiber') as {
    entry?: { options?: { name?: unknown } }
    runtime?: { name?: unknown }
    parent?: { fiber?: unknown }
  } | undefined
  while (fiber && typeof fiber === 'object') {
    if (isSchedulePluginName(fiber.entry?.options?.name)) return true
    if (isSchedulePluginName(fiber.runtime?.name)) return true
    const next = fiber.parent?.fiber as typeof fiber | undefined
    if (!next || next === fiber) break
    fiber = next
  }
  return false
}

function scopeOfValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined
  return scopeOf(value as never)
}

function nonRootFiberOf(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined
  const fiber = Reflect.get(value, 'fiber') as { uid?: unknown } | undefined
  if (!fiber || typeof fiber !== 'object') return undefined
  return fiber.uid !== 0 && fiber.uid !== null ? fiber : undefined
}

function sameAgentContext(candidate: unknown, target: unknown, targetScope: unknown): boolean {
  if (candidate === target) return true
  if (targetScope !== undefined && scopeOfValue(candidate) === targetScope) return true
  const candidateFiber = nonRootFiberOf(candidate)
  const targetFiber = nonRootFiberOf(target)
  return candidateFiber !== undefined && candidateFiber === targetFiber
}

export function isInternalPreset(id: string): boolean {
  return id === PRESET_ID || id === REFLECTION_PRESET_ID || id === WATCHDOG_PRESET_ID
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
 * `defaultId`. Healthy presets strictly take precedence over broken ones,
 * falling back to healthy `standard` or the first healthy public preset.
 */
export function publicDefaultId(
  rows: readonly ListedPreset[],
  hostDefaultId?: string,
  options?: PublicDefaultOptions,
): string | undefined {
  const visible = visiblePresets(rows)
  const healthy = visible.filter(row => row.broken === undefined)
  const marked = healthy.find(row => row.isDefault === true)
  if (marked) return marked.id
  if (hostDefaultId && !isInternalPreset(hostDefaultId)) {
    const selected = healthy.find(row => row.id === hostDefaultId)
    if (selected) return selected.id
  }
  const standard = healthy.find(row => row.id === 'standard')
  if (standard) return standard.id
  if (healthy[0]) return healthy[0].id
  if (options?.healthyOnly) return undefined
  const brokenMarked = visible.find(row => row.isDefault === true)
  if (brokenMarked) return brokenMarked.id
  if (hostDefaultId && !isInternalPreset(hostDefaultId)) {
    const brokenSelected = visible.find(row => row.id === hostDefaultId)
    if (brokenSelected) return brokenSelected.id
  }
  return visible[0]?.id
}

/** Public default for a new ordinary session, from the live registry. */
export async function publicTaskPreset(registry: PresetVisibilityRegistry | undefined): Promise<string | undefined> {
  if (!registry || typeof registry.list !== 'function') return undefined
  const hostDefault = hostDefaultIdOf(registry)
  if (typeof registry.remoteExportList === 'function') {
    const roster = await registry.remoteExportList()
    return publicDefaultId(roster.presets, hostDefault, { healthyOnly: true })
  }
  return publicDefaultId(await registry.list(), hostDefault, { healthyOnly: true })
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

/** Hide the internal presets from roster reads and scope schedule preset rewriting. Returns the disposer. */
export function installPresetVisibility(
  registry: PresetVisibilityRegistry | undefined,
  ctx?: PresetVisibilityContext,
): () => void {
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
  let lastRows: readonly ListedPreset[] | undefined
  const remember = (rows: readonly ListedPreset[]): readonly ListedPreset[] => {
    lastRows = [...rows]
    return rows
  }
  const selectHealthyPublic = (): string | undefined => {
    const live = hostDefault()
    if (lastRows !== undefined) return publicDefaultId(lastRows, live, { healthyOnly: true })
    return live && !isInternalPreset(live) ? live : undefined
  }
  const wrappedList = async () => remember(visiblePresets(await list()))
  const readRoster = async (): Promise<readonly ListedPreset[]> => remoteExportList ? (await remoteExportList()).presets : await list()
  const refreshRoster = async (): Promise<void> => {
    try { remember(visiblePresets(await readRoster())) } catch { /* keep the latest cached snapshot */ }
  }
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
  interface ScheduleScope {
    readonly agentCtx: unknown
    readonly agentScope: unknown
    readonly hasAgent: boolean
  }
  const scheduleScope = new AsyncLocalStorage<ScheduleScope>()
  const rewriteIfInternal = (id: unknown): unknown =>
    typeof id === 'string' && isInternalPreset(id) ? selectHealthyPublic() : id
  const wrappedComposed = composed
    ? (...args: never[]) => {
      const id = composed(...args)
      const active = scheduleScope.getStore()
      if (!active) return id
      if (active.hasAgent && args.length > 0 && !sameAgentContext(args[0], active.agentCtx, active.agentScope)) {
        return id
      }
      return rewriteIfInternal(id)
    }
    : undefined
  const scheduleWrappers = new WeakMap<object, object>()
  const wrapScheduleAgentPresets = (service: object): object => new Proxy(service, {
    get(target, prop) {
      if (prop === 'composedPreset') {
        const fn = Reflect.get(target, prop, target)
        if (typeof fn !== 'function') return fn
        return (...args: unknown[]) => rewriteIfInternal((fn as (...inner: unknown[]) => unknown).apply(target, args))
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const listen = ctx && typeof ctx.on === 'function'
    ? (ctx.on as (event: string, listener: (...args: never[]) => unknown, options?: boolean | { prepend?: boolean }) => () => void).bind(ctx)
    : undefined
  const unhookExecute = listen?.('tools/execute', (async (exec: unknown, next: () => unknown) => {
    const item = exec && typeof exec === 'object' ? exec as { name?: unknown; agent?: { ctx?: unknown } } : undefined
    if (typeof item?.name !== 'string' || !HOST_SCHEDULE_MUTATORS.has(item.name)) return next()
    const agentCtx = item.agent?.ctx
    const hasAgent = agentCtx !== undefined
    if (hasAgent && composed) {
      const current = composed(agentCtx as never)
      if (typeof current === 'string' && !isInternalPreset(current)) return next()
    }
    await refreshRoster()
    return scheduleScope.run({ agentCtx, agentScope: scopeOfValue(agentCtx), hasAgent }, next)
  }) as (...args: never[]) => unknown, { prepend: true })
  const unhookGet = listen?.('internal/get', ((accessCtx: unknown, prop: unknown, _error: unknown, next: () => unknown) => {
    if (prop !== 'agentPresets' || !isSchedulePluginContext(accessCtx)) return next()
    const service = next()
    if (!service || typeof service !== 'object' || typeof Reflect.get(service, 'composedPreset') !== 'function') return service
    let wrapped = scheduleWrappers.get(service)
    if (!wrapped) {
      wrapped = wrapScheduleAgentPresets(service)
      scheduleWrappers.set(service, wrapped)
    }
    return wrapped
  }) as (...args: never[]) => unknown)
  raw.list = wrappedList
  if (wrappedRemote && remoteExportList) raw.remoteExportList = wrappedRemote
  if (wrappedResolve && resolve) raw.resolve = wrappedResolve
  if (wrappedComposed && listen) Reflect.set(raw, 'composedPreset', wrappedComposed)
  return () => {
    unhookExecute?.()
    unhookGet?.()
    restoreMethod(raw, 'list', previousList, wrappedList, wasOwn.list)
    if (wrappedRemote) restoreMethod(raw, 'remoteExportList', previousRemote, wrappedRemote, wasOwn.remoteExportList)
    if (wrappedResolve) restoreMethod(raw, 'resolve', previousResolve, wrappedResolve, wasOwn.resolve)
    if (wrappedComposed && listen) restoreMethod(raw, 'composedPreset', previousComposed, wrappedComposed, wasOwn.composedPreset)
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
