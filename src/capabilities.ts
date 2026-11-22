/**
 * dot's optional extra tools: the grant catalog the settings view draws,
 * grant resolution, and the per-agent application of granted tools. Tool
 * registration attribution lives in ./attribution.ts, which also ships as an
 * early loader row; this module only reads its shared owners map.
 */
import type { CapabilityGrant, CapabilityGroupView, CapabilityToolView, DotSettings } from './contracts.ts'
import { installToolAttribution, SCOPED_COPY, sharedAttribution, type ToolOwner } from './attribution.ts'
import { restrictInheritedTools } from './tool-scope.ts'

export { installToolAttribution, SCOPED_COPY } from './attribution.ts'
export type { ToolOwner } from './attribution.ts'

/** Selector prefixes a grant row may use. */
export const SELECTOR = {
  tool: 'tool:',
  mcp: 'mcp:',
  plugin: 'plugin:',
  prefix: 'prefix:',
  builtin: 'builtin:',
  host: 'host',
} as const

export const toolSelector = (name: string): string => `${SELECTOR.tool}${name}`
export const mcpSelector = (server: string): string => `${SELECTOR.mcp}${server}`
export const pluginSelector = (bundle: string): string => `${SELECTOR.plugin}${bundle}`
export const entrySelector = (bundle: string, entryId: string): string => `${SELECTOR.plugin}${bundle}#${entryId}`
export const prefixSelector = (segment: string): string => `${SELECTOR.prefix}${segment}`
export const builtinSelector = (id: string): string => `${SELECTOR.builtin}${id}`

/** The display-only parent id of the host built-in groups. */
export const BUILTIN_PARENT = 'builtin'

/**
 * Host built-in tools mounted on the dot preset (index.ts): global-nature
 * rows only — skill, schedule, and the plugin manager tools row. Names mirror
 * the mounted packages; they are preset-scope registrations, so root
 * `tools.get` never sees them and the catalog lists them statically.
 */
export const BUILTIN_GROUPS: readonly { readonly id: string; readonly label: string; readonly tools: readonly string[] }[] = [
  { id: 'skill', label: 'skill', tools: ['skill'] },
  { id: 'schedule', label: 'schedule', tools: ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'] },
  { id: 'plugin-manager', label: 'plugin-manager', tools: ['plugin_manager'] },
]

/**
 * Host tools whose rc5 self-escalation short-circuits under dot's
 * danger-full-access session: they run unsandboxed with no host approval, so
 * dot's own grant is the only control. Catalog rows and the grant UI flag
 * them, and `auto` asks the human to confirm once more.
 */
export const HIGH_RISK_TOOLS: ReadonlySet<string> = new Set(['plugin_manager', 'bash', 'pwsh', 'write', 'edit', 'apply_patch'])

/** DeepSeek function-name contract shared with the MCP public-name derivation. */
const MCP_INVALID_CHARS = /[^A-Za-z0-9_-]/g
/** Hashed MCP names keep the normalized prefix only up to this many characters. */
const MCP_PREFIX_MAX = 64 - 12 - 1

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
  readonly description?: string
  /** Official on-demand rows carry the exact spec and version the host offers. */
  readonly installTarget?: { readonly spec: string; readonly version: string }
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
    const chain = group.kind === 'host' || group.id === BUILTIN_PARENT ? parents : [group.id, ...parents]
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
  /** Last schema descriptions recorded on a dot agent, keyed by tool name. */
  readonly builtinDescriptions?: ReadonlyMap<string, string>
  /** Names the last dot agent schema snapshot exposed; once known, builtin names outside it are missing. */
  readonly builtinVisible?: ReadonlySet<string>
}

interface MutableTool extends CapabilityToolView { description?: string; missing?: boolean; conditional: boolean; highRisk?: boolean }
/** The catalog as buildCatalog assembles it; arrays freeze into the readonly view contract on return. */
interface MutableGroup {
  id: string
  kind: 'mcp' | 'plugin' | 'entry' | 'builtin' | 'prefix' | 'host'
  label: string
  missing?: boolean
  highRisk?: boolean
  tools: CapabilityToolView[]
  children?: MutableGroup[]
}

/** The first name segment a `prefix:` group shares, split at the first `_`, `-` or `.`. */
function nameSegment(name: string): string | undefined {
  const match = /[_\-.]/.exec(name)
  const segment = match === null ? name : name.slice(0, match.index)
  return segment === '' ? undefined : segment
}

const riskRow = (tool: MutableTool): MutableTool => {
  if (HIGH_RISK_TOOLS.has(tool.name)) tool.highRisk = true
  return tool
}

/**
 * Group the registered extra tools under their MCP server or plugin bundle,
 * keeping granted-but-absent selectors as `missing` rows so a grant survives
 * the tool going away.
 */
export function buildCatalog(input: CatalogInput): { readonly locked: readonly string[]; readonly groups: readonly CapabilityGroupView[] } {
  type G = MutableGroup
  const row = (def: CapabilityToolDef): MutableTool => {
    const tool = riskRow({ name: def.name, conditional: input.conditional(def.name) })
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
  // A bundle with an explicit `plugin:<bundle>#<entry>` grant keeps the entry
  // level even when it is the only tool-owning entry, so the granted selector
  // stays a live chain node instead of collapsing into the bundle row.
  const grantedEntryBundles = new Set<string>()
  for (const selector of Object.keys(input.grants)) {
    if (!selector.startsWith(SELECTOR.plugin)) continue
    const hash = selector.indexOf('#')
    if (hash < 0) continue
    const bundle = selector.slice(SELECTOR.plugin.length, hash)
    const entryId = selector.slice(hash + 1)
    if (ownedEntries.get(bundle)?.has(entryId)) grantedEntryBundles.add(bundle)
  }
  const unattributed: MutableTool[] = []
  const byBundle = new Map<string, MutableGroup>()
  const childGroups = new Map<string, MutableGroup>()
  for (const def of nonMcp) {
    const entryId = input.owners.get(def.name)?.entryId
    if (entryId === undefined) { unattributed.push(row(def)); continue }
    const bundle = bundleOf.get(entryId) ?? entryId
    const pluginId = pluginSelector(bundle)
    if ((ownedEntries.get(bundle)?.size ?? 0) > 1 || grantedEntryBundles.has(bundle)) {
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
  // Unattributed tools that share a first name segment nest under a grantable
  // `prefix:<segment>` child; singletons stay flat in the display-only host group.
  if (unattributed.length > 0) {
    const buckets = new Map<string, MutableTool[]>()
    const flat: MutableTool[] = []
    for (const tool of unattributed) {
      const segment = nameSegment(tool.name)
      if (segment === undefined) { flat.push(tool); continue }
      const list = buckets.get(segment) ?? []
      list.push(tool)
      buckets.set(segment, list)
    }
    const children: MutableGroup[] = []
    for (const [segment, tools] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (tools.length < 2) { flat.push(...tools); continue }
      children.push({ id: prefixSelector(segment), kind: 'prefix', label: `${segment}_*`, tools })
    }
    groups.push({ id: SELECTOR.host, kind: 'host', label: 'Unattributed', tools: flat, ...(children.length > 0 ? { children } : {}) })
  }

  // Host built-in rows mounted on the dot preset: display-only parent like
  // `host`, grantable `builtin:<id>` children whose names are static.
  groups.push({
    id: BUILTIN_PARENT, kind: 'builtin', label: 'builtin', tools: [],
    children: BUILTIN_GROUPS.map(entry => {
      const tools = entry.tools.map(name => {
        const tool = riskRow({ name, conditional: false })
        const description = input.builtinDescriptions?.get(name)
        if (description !== undefined) tool.description = description
        if (input.builtinVisible !== undefined && !input.builtinVisible.has(name)) tool.missing = true
        return tool
      })
      const child: MutableGroup = { id: builtinSelector(entry.id), kind: 'builtin', label: entry.label, tools }
      if (tools.length > 0 && tools.every(tool => tool.missing === true)) child.missing = true
      return child
    }),
  })

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
    } else if (selector.startsWith(SELECTOR.prefix)) {
      if (allGroups(groups).some(group => group.id === selector)) continue
      groups.push({ id: selector, kind: 'prefix', label: `${selector.slice(SELECTOR.prefix.length)}_*`, missing: true, tools: [] })
    } else if (selector.startsWith(SELECTOR.builtin)) {
      if (allGroups(groups).some(group => group.id === selector)) continue
      groups.push({ id: selector, kind: 'builtin', label: selector.slice(SELECTOR.builtin.length), missing: true, tools: [] })
    } else if (selector === SELECTOR.host) {
      if (!allGroups(groups).some(group => group.id === SELECTOR.host)) groups.push({ id: SELECTOR.host, kind: 'host', label: 'Unattributed', missing: true, tools: [] })
    } else if (selector.startsWith(SELECTOR.tool)) {
      const name = selector.slice(SELECTOR.tool.length)
      if (!name || input.locked.has(name)) continue
      const present = allGroups(groups).some(group => group.tools.some(tool => tool.name === name))
      if (present) continue
      const missing = riskRow({ name, conditional: false, missing: true })
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

  // A group is high-risk when any tool inside it (however nested) is.
  const markRisk = (group: MutableGroup): boolean => {
    const risky = group.tools.some(tool => tool.highRisk === true) || (group.children ?? []).map(markRisk).some(Boolean)
    if (risky) group.highRisk = true
    return risky
  }
  for (const group of groups) markRisk(group)

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
  schemas(scope: unknown): readonly { readonly name: string; readonly description?: string }[]
}

interface AgentCtxLike {
  readonly tools: ScopedTools
  on(event: 'tools/change', listener: () => void): () => void
}

interface AgentLike {
  readonly session?: { readonly id?: string }
}

export class DotCapabilities {
  /** Tool name → loader entry attribution, shared with the early attribution row. */
  readonly owners: Map<string, ToolOwner> = sharedAttribution().owners
  private readonly agents = new Map<string, AppliedState>()

  /** Tool name → first schema description line seen on a dot agent; feeds builtin catalog rows. */
  private readonly schemaDescriptions = new Map<string, string>()

  /** Names the last dot agent schema snapshot exposed, if one was ever taken. */
  private lastSchemaNames?: ReadonlySet<string>

  constructor(private readonly deps: CapabilityDeps) {}

  /** The locked inherited tool names; never grantable. */
  get locked(): readonly string[] { return this.deps.locked }

  /** The plugin manager on this host, when it exists. */
  pluginManager(): CapabilityPluginManager | undefined { return this.deps.pluginManager() }

  private bundlesCache?: { readonly at: number; readonly rows: readonly CapabilityBundle[] }

  /** Mark the bundle rows stale and start a coalesced background refresh; cached rows keep serving meanwhile. */
  invalidateBundles(): void {
    if (this.bundlesCache !== undefined) this.bundlesCache = { ...this.bundlesCache, at: 0 }
    this.deferBundlesRefresh()
  }

  /** Kick the first bundle read early so the first catalog rarely awaits it. */
  prewarm(): void { void this.refreshBundles() }

  private bundlesRefresh?: Promise<void>
  private refreshBundles(): Promise<void> {
    if (this.bundlesRefresh !== undefined) return this.bundlesRefresh
    const work = (async () => {
      try {
        const rows = await this.deps.pluginManager()?.listBundles() ?? []
        this.bundlesCache = { at: Date.now(), rows }
      } finally { this.bundlesRefresh = undefined }
    })()
    // A failed read reuses the last good answer; keep the stale stamp.
    this.bundlesRefresh = work.catch(() => {})
    return this.bundlesRefresh
  }

  /**
   * Bundle rows for attribution, stale-while-revalidate: a cached answer is
   * returned whatever its age while a coalesced refresh runs behind it; only
   * the very first load has nothing to show and awaits.
   */
  private async bundleRows(): Promise<readonly CapabilityBundle[]> {
    const cache = this.bundlesCache
    if (cache === undefined) { await this.refreshBundles(); return this.bundlesCache?.rows ?? [] }
    if (Date.now() - cache.at >= BUNDLE_CACHE_MS) this.deferBundlesRefresh()
    return cache.rows
  }

  private bundlesDeferQueued = false

  /** listBundles blocks the event loop on manifest reads; defer the kick so a serving response can flush first. */
  private deferBundlesRefresh(): void {
    if (this.bundlesDeferQueued || this.bundlesRefresh !== undefined) return
    this.bundlesDeferQueued = true
    setTimeout(() => { this.bundlesDeferQueued = false; void this.refreshBundles() }, 0)
  }

  /**
   * Fallback wrapper for hosts where the `ds-dot/attribution` row did not run;
   * the shared flag keeps either path from wrapping `register` twice.
   */
  installAttribution(): () => void {
    const shared = sharedAttribution()
    if (shared.wrapped) return () => {}
    shared.wrapped = true
    const undo = installToolAttribution(this.deps.tools() as unknown as object | undefined, this.owners)
    return () => { shared.wrapped = false; undo() }
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
      builtinDescriptions: this.schemaDescriptions,
      builtinVisible: this.lastSchemaNames,
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
    try {
      // The previous apply of this session releases first, synchronously:
      // its restrict masks the new allow list while it lives, and its scoped
      // copies collide with re-registrations under the same names.
      this.releaseAgent(sessionId)
      // Names the agent scope cannot show stay unapplied even when granted:
      // restrict filters them out, and the gate must not report them applied.
      let visible: ReadonlySet<string> | undefined
      try {
        const schemas = ctx.tools.schemas(agent)
        visible = new Set(schemas.map(row => row.name))
        this.lastSchemaNames = visible
        for (const row of schemas) {
          const description = typeof row.description === 'string' ? firstLine(row.description) : undefined
          if (description !== undefined && !this.schemaDescriptions.has(row.name)) this.schemaDescriptions.set(row.name, description)
        }
      } catch { visible = new Set() }
      const copies: Array<{ name: string; def: CapabilityToolDef; dispose: () => void }> = []
      const allow = [...this.deps.locked]
      for (const [name, resolved] of grants) {
        const def = tools.get(name)
        if (def === undefined) {
          // Preset-scope tools (host built-ins) are not in the root registry;
          // a granted name the agent scope can show joins the allow list.
          if (visible.has(name)) { allow.push(name); applied.set(name, resolved) }
          continue
        }
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
      // Releasing this apply also drops every scoped copy it registered;
      // leftover copies would collide with the next application under the
      // same names even though their grant no longer resolves.
      releases.push(() => {
        for (const copy of copies.splice(0)) {
          try { copy.dispose() } catch { /* gone with its scope */ }
        }
      })
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
    } catch {
      // A half-applied change must not leak its copies or widen the scope:
      // drop whatever was acquired and fall back to the locked-only mask.
      finish()
      try { releases.push(restrictInheritedTools(agentCtx, [...this.deps.locked], agent)) } catch { /* the scope is gone entirely */ }
      const failed: AppliedState = { applied: new Map(), release: finish }
      this.agents.set(sessionId, failed)
      return failed.applied
    }
    const state: AppliedState = { applied, release: finish }
    this.agents.set(sessionId, state)
    return applied
  }
}
