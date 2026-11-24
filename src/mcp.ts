/**
 * Preset-scope row `ds-dot/mcp`: mounts one `@deepseek-ai/dsh-mcp-client`
 * child per enabled dot-local MCP server inside dot's preset scope, so the
 * `mcp__<server>__*` tools land on the preset layer — visible to dot's agent
 * (masked until granted) and to no other session. Reads dot's settings and
 * publishes per-server status through the globalThis channel in
 * mcp-shared.ts, since this entry is a separate bundle module.
 */
import type { DotMcpServer } from './contracts.ts'
import { hostImport } from './host-import.ts'
import { sharedDotMcp } from './mcp-shared.ts'

export const name = 'ds-dot/mcp'

interface McpClientModule {
  connectionStatusOf(fiber: unknown): {
    current(): { state: string }
    onChange(callback: (status: unknown) => void): () => void
  } | undefined
}

interface FiberLike {
  dispose(): Promise<void> | void
}

interface RowCtx {
  loader?: { internal?: { import(name: string, baseUrl: string, options?: object): Promise<unknown> } }
  baseUrl?: string
  plugin(plugin: unknown, config?: unknown): FiberLike
  on(event: string, listener: (...args: never[]) => void): unknown
  logger?: { debug?(...args: unknown[]): void; info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** What decides whether an enabled server's mount is still current. */
const signatureOf = (server: DotMcpServer) => JSON.stringify([server.url, server.headers ?? {}])

export async function apply(ctx: RowCtx) {
  const shared = sharedDotMcp()
  const mounted = new Map<string, { fiber: FiberLike; signature: string; unwatch?: () => void }>()
  let client: McpClientModule | undefined
  let lastStatusSignature = ''

  const log = (message: string) => ctx.logger?.info?.(`dsh-dot/mcp: ${message}`)

  // The preset layer's tool additions are what a granted-but-restricted dot
  // agent picks up, and they are exactly what the published per-server status
  // reports (connected + toolCount). An unscoped definitions() view would be
  // the global layer, which never changes here.
  const statusSignature = async () => {
    const states = [...shared.servers.entries()]
      .map(([server, status]) => `${server}:${status.state}:${status.toolCount ?? ''}`)
      .sort()
      .join('\n')
    // Tool names, not just counts: a same-count tool replacement on a
    // mounted server must still re-apply the live agent's restrict.
    let names: readonly string[] = []
    try { names = (await shared.presetToolNames?.()) ?? [] } catch { names = [] }
    return `${states}\n${[...names].sort().join('\n')}`
  }

  let toolsTimer: ReturnType<typeof setTimeout> | undefined
  const noteToolsChanged = () => {
    if (toolsTimer !== undefined) clearTimeout(toolsTimer)
    toolsTimer = setTimeout(() => {
      toolsTimer = undefined
      void (async () => {
        const next = await statusSignature()
        if (next === lastStatusSignature) return
        lastStatusSignature = next
        shared.onToolsChanged?.()
      })()
    }, 500)
  }

  const publish = (server: string, status: { state: string } & Record<string, unknown>) => {
    const row: { state: string; toolCount?: number; diagnostic?: string } = { state: status.state }
    if (typeof status.toolCount === 'number') row.toolCount = status.toolCount
    const diagnostic = typeof status.lastError === 'string' ? status.lastError : undefined
    if (diagnostic !== undefined) row.diagnostic = diagnostic
    shared.servers.set(server, row)
    noteToolsChanged()
  }

  const mount = async (server: string, config: DotMcpServer) => {
    if (client === undefined) {
      try { client = await hostImport(ctx, '@deepseek-ai/dsh-mcp-client') } catch (error) {
        shared.servers.set(server, { state: 'failed', diagnostic: `host mcp-client unavailable: ${String(error)}` })
        return
      }
    }
    const signature = signatureOf(config)
    try {
      const fiber = ctx.plugin(client, {
        serverName: server,
        transport: 'streamable-http',
        url: config.url,
        headers: { ...config.headers },
        expandTemplates: true,
        startupTimeoutMs: 20_000,
        reconnect: { enabled: true },
        failOnStartupError: false,
      })
      const entry: { fiber: FiberLike; signature: string; unwatch?: () => void } = { fiber, signature }
      mounted.set(server, entry)
      const attachStatus = () => {
        const status = client!.connectionStatusOf(fiber)
        if (status === undefined) return false
        entry.unwatch = status.onChange(next => publish(server, next as { state: string }))
        publish(server, status.current())
        return true
      }
      // The instance registers its status handle inside its own apply, so it
      // can still be absent here; keep polling until it shows up.
      if (!attachStatus()) {
        publish(server, { state: 'connecting' })
        void (async () => {
          for (let i = 0; i < 120 && mounted.get(server) === entry; i++) {
            await sleep(500)
            if (attachStatus()) return
          }
        })()
      }
    } catch (error) {
      // One bad server must not take the row (and its other servers) down.
      shared.servers.set(server, { state: 'failed', diagnostic: `mount failed: ${error instanceof Error ? error.message : String(error)}` })
      log(`mount of ${server} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const unmount = async (server: string) => {
    const entry = mounted.get(server)
    if (entry === undefined) return
    mounted.delete(server)
    entry.unwatch?.()
    try { await entry.fiber.dispose() } catch { /* scope disposal may have run already */ }
    shared.servers.delete(server)
    noteToolsChanged()
  }

  // Serialize reconciles: a second settings change (or the first mount's
  // awaited host import) must not race a running pass — two concurrent passes
  // would mount the same server twice and the duplicate serverName apply would
  // throw. Settings are re-read inside each pass so a queued rerun sees the
  // latest snapshot.
  let reconciling = false
  let reconcileAgain = false
  // Callers that arrive mid-pass wait for the queue to drain, so an awaited
  // reconcile() really means "every queued pass finished".
  const reconcileWaiters: Array<() => void> = []
  const reconcile = async () => {
    if (reconciling) {
      reconcileAgain = true
      return new Promise<void>(resolve => reconcileWaiters.push(resolve))
    }
    reconciling = true
    try {
      do {
        reconcileAgain = false
        const servers = shared.settings?.().mcpServers ?? {}
        for (const name of [...mounted.keys()]) {
          const next = servers[name]
          if (next === undefined || !next.enabled || signatureOf(next) !== mounted.get(name)?.signature) await unmount(name)
        }
        for (const [name, config] of Object.entries(servers)) {
          if (config.enabled && !mounted.has(name)) await mount(name, config)
        }
      } while (reconcileAgain)
    } catch (error) {
      log(`reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      reconciling = false
      for (const resolve of reconcileWaiters.splice(0)) resolve()
    }
  }

  const onSettingsChanged = () => { void reconcile() }
  shared.onSettingsChanged = onSettingsChanged
  try { ctx.on('tools/change' as never, (() => noteToolsChanged()) as never) } catch { /* event may not reach this scope */ }
  ctx.on('dispose' as never, (() => {
    if (toolsTimer !== undefined) clearTimeout(toolsTimer)
    // A newer preset generation's row may already have installed its handler.
    if (shared.onSettingsChanged === onSettingsChanged) shared.onSettingsChanged = undefined
    for (const name of [...mounted.keys()]) void unmount(name)
  }) as never)

  lastStatusSignature = await statusSignature()
  await reconcile()
}
