/**
 * dot's optional extra tools: registration attribution, the grant catalog the
 * settings view draws, grant resolution, and the per-agent application of
 * granted tools.
 *
 * Attribution: ToolsService records a tool's registering scope but never
 * exposes it, so `register` is wrapped on the raw service. Cordis service
 * methods run with the caller's context as `this.ctx`, so a call made through
 * a plugin's `ctx.tools` tells us the plugin's fiber; the loader links fibers
 * to entries (`fiber.parent[Entry.key]`), and entry ids match
 * `pluginManager.listBundles()` row `entryId`s. Tools registered before the
 * wrapper, or through contexts that reach no entry, stay unattributed.
 */
import type { CapabilityGrant, CapabilityGroupView, CapabilityToolView, DotSettings } from './contracts.ts'
import { restrictInheritedTools } from './tool-scope.ts'

/** Selector prefixes a grant row may use. */
export const SELECTOR = {
  tool: 'tool:',
  mcp: 'mcp:',
  plugin: 'plugin:',
  host: 'host',
} as const

export const toolSelector = (name: string): string => `${SELECTOR.tool}${name}`
export const mcpSelector = (server: string): string => `${SELECTOR.mcp}${server}`
export const pluginSelector = (bundle: string): string => `${SELECTOR.plugin}${bundle}`
export const entrySelector = (bundle: string, entryId: string): string => `${SELECTOR.plugin}${bundle}#${entryId}`

/** DeepSeek function-name contract shared with the MCP public-name derivation. */
const MCP_INVALID_CHARS = /[^A-Za-z0-9_-]/g
/** Hashed MCP names keep the normalized prefix only up to this many characters. */
const MCP_PREFIX_MAX = 64 - 12 - 1

/** Cordis `symbols.original`. A service proxy mints a new function on every read. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
/** `Entry.key` from the vendored loader: the entry a context runs under. */
const ENTRY_KEY = Symbol.for('cordis.entry')
/**
 * Marks a scoped copy registered by applyToAgent, so the attribution wrapper
 * leaves the source registration's owner alone instead of crediting dot.
 */
export const SCOPED_COPY = Symbol('dsh-dot.scoped-copy')

export interface CapabilityToolDef {
  readonly name: string
  readonly description?: string
}

export interface CapabilityTools {
  definitions(): readonly CapabilityToolDef[]
  get(name: string): CapabilityToolDef | undefined
  executable(name: string): CapabilityToolDef | undefined
}

/** The part of BundleInfo the catalog and install checks read. */
export interface CapabilityBundle {
  readonly name: string
  readonly official?: boolean
  readonly installed?: boolean
  readonly enabled?: boolean
  readonly readOnlyReason?: string
  readonly rows: readonly { readonly entryId?: string }[]
}

/** `PluginSpecInspection`, narrowed to what a propose_install check needs. */
export type CapabilityInspection =
  | { readonly status: 'accepted'; readonly name?: string; readonly version?: string; readonly description?: string; readonly bundle?: boolean | null }
  | { readonly status: 'refused'; readonly problem: string; readonly reason: string }

/** `ChangeResult`, narrowed to the outcome fields dot reports. */
export interface CapabilityInstallResult {
  readonly changed: boolean
  readonly application: string
  readonly bundle?: string
  readonly version?: string
  readonly error?: { readonly code: string; readonly diagnostic?: string }
}

export interface CapabilityPluginManager {
  listBundles(): Promise<readonly CapabilityBundle[]>
  inspect?(spec: string): Promise<CapabilityInspection>
  installBundle?(spec: string, options?: { readonly enabled?: boolean; readonly expected?: { readonly name: string; readonly version: string }; readonly requestId?: string }): Promise<CapabilityInstallResult>
}

export interface CapabilityDeps {
  tools(): CapabilityTools | undefined
  mcpManager(): { list(): readonly { readonly name: string }[] } | undefined
  pluginManager(): CapabilityPluginManager | undefined
  settings(): DotSettings
  readonly locked: readonly string[]
}

/** Loader entry attribution of one registered tool, or undefined for an unattributed registration. */
export interface ToolOwner { readonly entryId?: string }

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
      if (!released) { released = true; owners.delete(name) }
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

/** Normalize an MCP server name the way the harness does when it builds public tool names. */
export function mcpPrefix(server: string): string {
  return `mcp__${server.replace(MCP_INVALID_CHARS, '_')}__`
}

/**
 * The server a public MCP tool name belongs to. Clean names start with the
 * full `mcp__<server>__` prefix; hashed names are clipped to 51 chars plus a
 * hash, so the match accepts the prefix clipped to that length.
 */
export function mcpServerOf(name: string, servers: readonly string[]): string | undefined {
  const candidates = servers.map(server => ({ server, prefix: mcpPrefix(server) })).sort((left, right) => right.prefix.length - left.prefix.length)
  for (const { server, prefix } of candidates) {
    const clip = Math.min(prefix.length, MCP_PREFIX_MAX)
    if (name.length >= clip && name.slice(0, clip) === prefix.slice(0, clip)) return server
  }
  return undefined
}

/** Best-effort server part of an `mcp__x__y` name when no configured server matches. */
function mcpGuess(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const rest = name.slice(5)
  const split = rest.indexOf('__')
  return split > 0 ? rest.slice(0, split) : undefined
}

const firstLine = (text: string | undefined): string | undefined => {
  const line = text?.split('\n').find(row => row.trim())?.trim()
  if (!line) return undefined
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

/**
 * A resolved grant with the selector chain the tool answered to, most
 * specific first. The chain is stored per applied tool so the execution gate
 * can re-resolve the live grant without rebuilding the catalog.
 */
export interface ResolvedGrant {
  readonly grant: 'ask' | 'auto'
  readonly chain: readonly string[]
}

/** The grant a stored chain resolves to under current settings; first defined wins. */
export function grantOnChain(grants: Readonly<Record<string, CapabilityGrant>>, chain: readonly string[]): CapabilityGrant | undefined {
  for (const selector of chain) {
    const grant = grants[selector]
    if (grant !== undefined) return grant
  }
  return undefined
}

/**
 * Walk group tools and resolve each one's effective grant. Returns only
 * enabled (`ask`/`auto`) grants. The `host` group is display-only: it never
 * contributes a selector, so unattributed tools answer to per-tool grants.
 */
export function resolveGrants(grants: Readonly<Record<string, CapabilityGrant>>, groups: readonly CapabilityGroupView[]): Map<string, ResolvedGrant> {
  const out = new Map<string, ResolvedGrant>()
  const walk = (group: CapabilityGroupView, parents: readonly string[]) => {
    const chain = group.kind === 'host' ? parents : [group.id, ...parents]
    for (const tool of group.tools) {
      if (tool.missing === true) continue
      const toolChain = [toolSelector(tool.name), ...chain]
      const grant = grantOnChain(grants, toolChain)
      if (grant === 'ask' || grant === 'auto') out.set(tool.name, { grant, chain: toolChain })
    }
    for (const child of group.children ?? []) walk(child, chain)
  }
  for (const group of groups) walk(group, [])
  return out
}

/** Stable signature of the grant state a segment freezes; availability changes never move it. */
export function capabilitiesSignature(settings: Pick<DotSettings, 'capabilities'>): string {
  const grants = settings.capabilities?.grants ?? {}
  return JSON.stringify(Object.fromEntries(Object.keys(grants).sort().map(key => [key, grants[key]])))
}

interface CatalogInput {
  readonly defs: readonly CapabilityToolDef[]
  readonly owners: ReadonlyMap<string, ToolOwner>
  readonly servers: readonly string[]
  readonly bundles: readonly { readonly name: string; readonly rows: readonly { readonly entryId?: string }[] }[]
  readonly grants: Readonly<Record<string, CapabilityGrant>>
  readonly locked: ReadonlySet<string>
  readonly conditional: (name: string) => boolean
}

interface MutableTool extends CapabilityToolView { description?: string; missing?: boolean; conditional: boolean }
/** The catalog as buildCatalog assembles it; arrays freeze into the readonly view contract on return. */
interface MutableGroup {
  id: string
  kind: 'mcp' | 'plugin' | 'entry' | 'host'
  label: string
  missing?: boolean
  tools: CapabilityToolView[]
  children?: MutableGroup[]
}

/**
 * Group the registered extra tools under their MCP server or plugin bundle,
 * keeping granted-but-absent selectors as `missing` rows so a grant survives
 * the tool going away.
 */
export function buildCatalog(input: CatalogInput): { readonly locked: readonly string[]; readonly groups: readonly CapabilityGroupView[] } {
  type G = MutableGroup
  const row = (def: CapabilityToolDef): MutableTool => {
    const tool: MutableTool = { name: def.name, conditional: input.conditional(def.name) }
    const description = firstLine(def.description)
    if (description !== undefined) tool.description = description
    return tool
  }

  // MCP first: attribution is purely by name.
  const mcpTools = new Map<string, MutableTool[]>()
  const nonMcp: CapabilityToolDef[] = []
  for (const def of input.defs) {
    if (input.locked.has(def.name)) continue
    const server = mcpServerOf(def.name, input.servers) ?? mcpGuess(def.name)
    if (server === undefined) { nonMcp.push(def); continue }
    const list = mcpTools.get(server) ?? []
    list.push(row(def))
    mcpTools.set(server, list)
  }
  const groups: MutableGroup[] = [...mcpTools.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([server, tools]) => ({
    id: mcpSelector(server), kind: 'mcp', label: server, tools,
  }))

  // Entry id → bundle name, from the manager's live row mapping. An entry with
  // no bundle row is its own group keyed `plugin:<entryId>`.
  const bundleOf = new Map<string, string>()
  for (const bundle of input.bundles) {
    for (const bundleRow of bundle.rows) {
      if (typeof bundleRow.entryId === 'string' && bundleRow.entryId) bundleOf.set(bundleRow.entryId, bundle.name)
    }
  }
  // Bundle → entries that own tools, so a single-entry bundle stays flat.
  const ownedEntries = new Map<string, Set<string>>()
  for (const def of nonMcp) {
    const entryId = input.owners.get(def.name)?.entryId
    if (entryId === undefined) continue
    const bundle = bundleOf.get(entryId) ?? entryId
    const entries = ownedEntries.get(bundle) ?? new Set<string>()
    entries.add(entryId)
    ownedEntries.set(bundle, entries)
  }
  const unattributed: MutableTool[] = []
  const byBundle = new Map<string, MutableGroup>()
  const childGroups = new Map<string, MutableGroup>()
  for (const def of nonMcp) {
    const entryId = input.owners.get(def.name)?.entryId
    if (entryId === undefined) { unattributed.push(row(def)); continue }
    const bundle = bundleOf.get(entryId) ?? entryId
    const pluginId = pluginSelector(bundle)
    if ((ownedEntries.get(bundle)?.size ?? 0) > 1) {
      // bundle → entry → tool nesting when more than one entry owns tools.
      let parent = byBundle.get(bundle)
      if (parent === undefined) {
        parent = { id: pluginId, kind: 'plugin', label: bundle, tools: [], children: [] }
        byBundle.set(bundle, parent)
        groups.push(parent)
      }
      const childId = entrySelector(bundle, entryId)
      let child = childGroups.get(childId)
      if (child === undefined) {
        child = { id: childId, kind: 'entry', label: entryId, tools: [] }
        childGroups.set(childId, child)
        ;(parent.children as MutableGroup[]).push(child)
      }
      child.tools.push(row(def))
    } else {
      let parent = byBundle.get(bundle)
      if (parent === undefined) {
        parent = { id: pluginId, kind: 'plugin', label: bundle, tools: [] }
        byBundle.set(bundle, parent)
        groups.push(parent)
      }
      parent.tools.push(row(def))
    }
  }
  if (unattributed.length > 0) groups.push({ id: SELECTOR.host, kind: 'host', label: 'Unattributed', tools: unattributed })

  // Granted selectors that own nothing right now stay visible as missing rows.
  const allGroups = (list: readonly MutableGroup[]): MutableGroup[] => list.flatMap(group => [group, ...allGroups(group.children ?? [])])
  for (const selector of Object.keys(input.grants).sort()) {
    if (selector.startsWith(SELECTOR.mcp)) {
      if (allGroups(groups).some(group => group.id === selector)) continue
      groups.push({ id: selector, kind: 'mcp', label: selector.slice(SELECTOR.mcp.length), missing: true, tools: [] })
    } else if (selector.startsWith(SELECTOR.plugin)) {
      if (allGroups(groups).some(group => group.id === selector)) continue
      if (selector.includes('#')) {
        const hash = selector.indexOf('#')
        const bundle = selector.slice(SELECTOR.plugin.length, hash)
        const parent = allGroups(groups).find(group => group.id === pluginSelector(bundle))
        const child: MutableGroup = { id: selector, kind: 'entry', label: selector.slice(hash + 1), missing: true, tools: [] }
        if (parent !== undefined) parent.children = [...(parent.children ?? []), child]
        else groups.push({ id: selector, kind: 'entry', label: `${bundle} / ${selector.slice(hash + 1)}`, missing: true, tools: [] })
      } else {
        groups.push({ id: selector, kind: 'plugin', label: selector.slice(SELECTOR.plugin.length), missing: true, tools: [] })
      }
    } else if (selector === SELECTOR.host) {
      if (!allGroups(groups).some(group => group.id === SELECTOR.host)) groups.push({ id: SELECTOR.host, kind: 'host', label: 'Unattributed', missing: true, tools: [] })
    } else if (selector.startsWith(SELECTOR.tool)) {
      const name = selector.slice(SELECTOR.tool.length)
      if (!name || input.locked.has(name)) continue
      const present = allGroups(groups).some(group => group.tools.some(tool => tool.name === name))
      if (present) continue
      const missing: MutableTool = { name, conditional: false, missing: true }
      const server = mcpGuess(name)
      const owner = server !== undefined ? groups.find(group => group.id === mcpSelector(server)) : undefined
      if (owner !== undefined) owner.tools.push(missing)
      else {
        let host = groups.find(group => group.id === SELECTOR.host)
        if (host === undefined) { host = { id: SELECTOR.host, kind: 'host', label: 'Unattributed', tools: [] }; groups.push(host) }
        host.tools.push(missing)
      }
    }
  }

  return { locked: [...input.locked].sort(), groups }
}

interface AppliedState {
  readonly applied: ReadonlyMap<string, ResolvedGrant>
  readonly release: () => void
}

/** How long the bundle row mapping is reused before listBundles is asked again. */
const BUNDLE_CACHE_MS = 30_000

interface ScopedTools extends CapabilityTools {
  register(definition: CapabilityToolDef & Record<string, unknown>): () => void
  restrict(filter: { allow: readonly string[] }): () => void
  schemas(scope: unknown): readonly { readonly name: string }[]
}

interface AgentCtxLike {
  readonly tools: ScopedTools
  on(event: 'tools/change', listener: () => void): () => void
}

interface AgentLike {
  readonly session?: { readonly id?: string }
}

export class DotCapabilities {
  /** Tool name → loader entry attribution, kept by the register wrapper. */
  readonly owners = new Map<string, ToolOwner>()
  private readonly agents = new Map<string, AppliedState>()

  constructor(private readonly deps: CapabilityDeps) {}

  /** The locked inherited tool names; never grantable. */
  get locked(): readonly string[] { return this.deps.locked }

  /** The plugin manager on this host, when it exists. */
  pluginManager(): CapabilityPluginManager | undefined { return this.deps.pluginManager() }

  private bundlesCache?: { readonly at: number; readonly rows: readonly CapabilityBundle[] }

  /** Drop the cached bundle rows; called on tools/change so a new plugin groups right away. */
  invalidateBundles(): void { this.bundlesCache = undefined }

  /** Bundle rows for attribution, cached briefly; a failed read reuses the last good answer. */
  private async bundleRows(): Promise<readonly CapabilityBundle[]> {
    const now = Date.now()
    if (this.bundlesCache !== undefined && now - this.bundlesCache.at < BUNDLE_CACHE_MS) return this.bundlesCache.rows
    let rows: readonly CapabilityBundle[]
    try { rows = await this.deps.pluginManager()?.listBundles() ?? [] }
    catch { return this.bundlesCache?.rows ?? [] }
    this.bundlesCache = { at: now, rows }
    return rows
  }

  /** Reach the raw ToolsService through the proxy and wrap `register`. */
  installAttribution(): () => void {
    return installToolAttribution(this.deps.tools() as unknown as object | undefined, this.owners)
  }

  /** The grants a segment starting now would freeze. */
  signature(): string { return capabilitiesSignature(this.deps.settings()) }

  /** The catalog the settings view and the dot_capabilities tool draw. */
  async catalog(): Promise<{ readonly locked: readonly string[]; readonly groups: readonly CapabilityGroupView[] }> {
    const tools = this.deps.tools()
    const defs = tools?.definitions() ?? []
    let servers: string[] = []
    try { servers = (this.deps.mcpManager()?.list() ?? []).map(server => server.name) } catch { servers = [] }
    return buildCatalog({
      defs,
      owners: this.owners,
      servers,
      bundles: [...await this.bundleRows()],
      grants: this.deps.settings().capabilities?.grants ?? {},
      locked: new Set(this.deps.locked),
      conditional: name => tools !== undefined && tools.get(name) !== undefined && tools.executable(name) === undefined,
    })
  }

  /** Live grant resolution over the present catalog; only enabled tools are returned. */
  async resolve(): Promise<Map<string, ResolvedGrant>> {
    const { groups } = await this.catalog()
    return resolveGrants(this.deps.settings().capabilities?.grants ?? {}, groups)
  }

  /** The live grant over one applied tool's stored selector chain; 'off' and absent both mean denied. */
  liveGrant(chain: readonly string[]): CapabilityGrant | undefined {
    return grantOnChain(this.deps.settings().capabilities?.grants ?? {}, chain)
  }

  /** Grants applied for one dot segment session at its start. */
  appliedFor(sessionId: string | undefined): ReadonlyMap<string, ResolvedGrant> | undefined {
    return sessionId === undefined ? undefined : this.agents.get(sessionId)?.applied
  }

  /** Forget the applied state of a released agent; ctx disposal already lifted its restrict and copies. */
  releaseAgent(sessionId: string): void {
    const state = this.agents.get(sessionId)
    if (!state) return
    this.agents.delete(sessionId)
    try { state.release() } catch { /* copies may already be gone with the agent scope */ }
  }

  releaseAll(): void {
    for (const id of [...this.agents.keys()]) this.releaseAgent(id)
  }

  /**
   * Apply the live grants to one dot agent: unconditional granted names join
   * the restrict allow list; `when`-gated ones are re-registered as scoped
   * copies so they bypass their original condition. A re-application disposes
   * the previous restrict and copies of the same session first, so an
   * untouched segment can take a grant change in place.
   */
  async applyToAgent(agentCtx: unknown, agent: AgentLike & object): Promise<ReadonlyMap<string, ResolvedGrant>> {
    const ctx = agentCtx as AgentCtxLike
    const sessionId = agent.session?.id
    const applied = new Map<string, ResolvedGrant>()
    const tools = this.deps.tools()
    const releases: Array<() => void> = []
    const finish = () => {
      for (const release of releases.splice(0).reverse()) {
        try { release() } catch { /* scope disposal may have run already */ }
      }
    }
    if (sessionId === undefined || tools === undefined || typeof ctx?.tools?.register !== 'function' || typeof ctx?.on !== 'function') {
      if (sessionId !== undefined) this.releaseAgent(sessionId)
      return applied
    }
    const grants = await this.resolve()
    // Names the agent scope cannot show stay unapplied even when granted:
    // restrict filters them out, and the gate must not report them applied.
    let visible: ReadonlySet<string> | undefined
    try { visible = new Set(ctx.tools.schemas(agent).map(row => row.name)) } catch { visible = new Set() }
    const copies: Array<{ name: string; def: CapabilityToolDef; dispose: () => void }> = []
    const allow = [...this.deps.locked]
    for (const [name, resolved] of grants) {
      const def = tools.get(name)
      if (def === undefined) continue
      if (tools.executable(name) !== undefined) {
        allow.push(name)
        if (visible.has(name)) applied.set(name, resolved)
      } else {
        try {
          const dispose = ctx.tools.register({ ...(def as CapabilityToolDef & Record<string, unknown>), [SCOPED_COPY]: true })
          copies.push({ name, def, dispose })
          applied.set(name, resolved)
        } catch { /* a name the scope cannot take stays off */ continue }
      }
    }
    releases.push(restrictInheritedTools(agentCtx, allow, agent))
    // Drop a copy once the global definition it shadows is gone or replaced.
    if (copies.length > 0) {
      releases.push(ctx.on('tools/change', () => {
        for (let index = copies.length - 1; index >= 0; index--) {
          const copy = copies[index]!
          if (tools.get(copy.name) === copy.def) continue
          copies.splice(index, 1)
          try { copy.dispose() } catch { /* gone with its scope */ }
        }
      }))
    }
    const state: AppliedState = { applied, release: finish }
    if (this.agents.has(sessionId)) this.releaseAgent(sessionId)
    this.agents.set(sessionId, state)
    return applied
  }
}
