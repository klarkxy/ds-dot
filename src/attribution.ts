/**
 * Early loader row that attributes tool registrations to the loader entry
 * that made them. It ships as its own small module (`ds-dot/attribution`,
 * injected with only `tools`) so it tends to wrap `register` before the big
 * plugin modules finish importing — best-effort, not a guarantee.
 *
 * Cordis service methods run with the caller's context as `this.ctx`, so a
 * `ctx.tools.register` call names the plugin's fiber; the loader links fibers
 * to entries (`fiber.entry`), and `pluginManager.listBundles()` row entryIds
 * map entries to bundles. Tools registered before the wrapper, or through
 * contexts that reach no entry, stay unattributed.
 *
 * The owners map lives on globalThis: this entry and the main ds-dot module
 * are bundled separately but must share one map. It deliberately survives
 * this row's disposal so a late reload never blanks recorded owners.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Loader entry attribution of one registered tool, or undefined for an unattributed registration. */
export interface ToolOwner { readonly entryId?: string }

/** Cordis `symbols.original`. A service proxy mints a new function on every read. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
/** `Entry.key` from the vendored loader: the entry a context runs under. */
const ENTRY_KEY = Symbol.for('cordis.entry')
/**
 * Marks a scoped copy registered by the capability layer, so the wrapper
 * leaves the source registration's owner alone instead of crediting dot.
 * `Symbol.for` keeps the marker identical across this entry and the main bundle.
 */
export const SCOPED_COPY = Symbol.for('dsh-dot.scoped-copy')

const SHARED_KEY = Symbol.for('ds-dot/tool-owners')

/** The owners map both ds-dot entries share, plus the flag that keeps the wrapper single. */
export interface SharedAttribution {
  readonly owners: Map<string, ToolOwner>
  /** True while a row's register wrapper is installed; a second installer backs off. */
  wrapped: boolean
}

/** The process-wide attribution record, created on first read. */
export function sharedAttribution(): SharedAttribution {
  const world = globalThis as Record<symbol, SharedAttribution | undefined>
  const existing = world[SHARED_KEY]
  if (existing !== undefined) return existing
  const created: SharedAttribution = { owners: new Map(), wrapped: false }
  world[SHARED_KEY] = created
  return created
}

interface FiberLike { readonly entry?: { readonly id?: string }; readonly parent?: { readonly fiber?: FiberLike } }
interface RegisterHost {
  register(definition: { name?: unknown } & Record<string, unknown>, options?: unknown): () => void
  [key: symbol]: unknown
}
interface CallerThis { readonly ctx?: { readonly fiber?: FiberLike } & Record<symbol, unknown> }

/** Entry id of the entry the calling context runs under; walks parent fibers for nested plugin children. */
function ownerOf(self: unknown): ToolOwner {
  const ctx = (self as CallerThis | undefined)?.ctx
  const direct = ctx?.[ENTRY_KEY] as { readonly id?: string } | undefined
  if (typeof direct?.id === 'string' && direct.id) return { entryId: direct.id }
  let fiber = ctx?.fiber
  for (let hop = 0; hop < 16 && fiber; hop++) {
    const entry = fiber.entry
    if (typeof entry?.id === 'string' && entry.id) return { entryId: entry.id }
    fiber = fiber.parent?.fiber
  }
  return {}
}

/**
 * Wrap `tools.register` on the raw service so every registration records the
 * loader entry of the calling context. Restores the previous method on
 * dispose, only while the wrapper is still installed.
 */
export function installToolAttribution(tools: object | undefined, owners: Map<string, ToolOwner>): () => void {
  if (!tools || typeof (tools as { register?: unknown }).register !== 'function') return () => {}
  const raw = ((tools as Record<symbol, unknown>)[CORDIS_ORIGINAL] ?? tools) as RegisterHost
  const previous = raw.register
  if (typeof previous !== 'function') return () => {}
  const wasOwn = Object.prototype.hasOwnProperty.call(raw, 'register')
  const wrapped = function (this: unknown, definition: { name?: unknown } & Record<string, unknown>, options?: unknown): () => void {
    const owner = ownerOf(this)
    const dispose = previous.call(this, definition, options)
    const name = typeof definition?.name === 'string' ? definition.name : undefined
    // A scoped copy keeps the source registration's owner.
    if (name === undefined || (definition as Record<symbol, unknown>)[SCOPED_COPY] === true) return dispose
    owners.set(name, owner)
    let released = false
    return () => {
      if (!released) { released = true; if (owners.get(name) === owner) owners.delete(name) }
      return dispose()
    }
  }
  raw.register = wrapped
  return () => {
    const record = raw as unknown as Record<string, unknown>
    if (record.register !== wrapped) return
    if (wasOwn) record.register = previous
    else delete record.register
  }
}

export const name = 'ds-dot-attribution'
export const inject = ['tools'] as const

/**
 * Install the register wrapper as early as this row activates. When the flag
 * says another row already wrapped register — e.g. the main module fell back
 * because this row was absent — this row does nothing; the shared map still
 * feeds either reader.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const shared = sharedAttribution()
    if (shared.wrapped) return () => {}
    shared.wrapped = true
    const undo = installToolAttribution(ctx.tools as unknown as object | undefined, shared.owners)
    return () => { shared.wrapped = false; undo() }
  }, 'dot.attribution')
}
