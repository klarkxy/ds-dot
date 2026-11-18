/**
 * Dorothy's own copy of dsh-dev-index's two read-only tools. The published
 * plugin registers them globally with a Creator-preset (`cordis`) `when`
 * gate, so the inherited list never shows them on the `dot` preset. Loading
 * the same factories into this preset row puts them on Dorothy's request
 * without copying their implementation. Absent package → no-op.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

const require = createRequire(import.meta.url)

export const DEV_INDEX_TOOLS = ['dsh_docs', 'dsh_plugins'] as const

interface Disposable {
  dispose?: () => void | Promise<void>
}

interface DevIndexBundle {
  readonly tools: readonly Record<string, unknown>[]
  dispose(): void
}

type ToolHost = Context & { tools: { register(definition: unknown): () => void } }

async function fileImport(root: string, name: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(join(root, 'lib', name)).href) as Promise<Record<string, unknown>>
}

export async function loadDevIndexTools(): Promise<DevIndexBundle | undefined> {
  let root: string
  try { root = dirname(require.resolve('@klarkxy/dsh-dev-index/package.json')) } catch { return undefined }
  try {
    const [docsMod, docsToolMod, registryMod, pluginsToolMod, githubMod] = await Promise.all([
      fileImport(root, 'docs.js'),
      fileImport(root, 'docs-tools.js'),
      fileImport(root, 'registry.js'),
      fileImport(root, 'registry-tools.js'),
      fileImport(root, 'github.js'),
    ])
    const DocsClient = docsMod.DocsClient as new () => Disposable
    const PluginRegistry = registryMod.PluginRegistry as new () => Disposable
    const GitHubClient = githubMod.GitHubClient as new () => Disposable
    const docsTool = docsToolMod.docsTool as (client: Disposable, logger?: unknown) => Record<string, unknown>
    const pluginsTool = pluginsToolMod.pluginsTool as (client: Disposable, github?: Disposable, logger?: unknown) => Record<string, unknown>
    if (typeof DocsClient !== 'function' || typeof PluginRegistry !== 'function' || typeof GitHubClient !== 'function') return undefined
    if (typeof docsTool !== 'function' || typeof pluginsTool !== 'function') return undefined
    const docs = new DocsClient()
    const registry = new PluginRegistry()
    const github = new GitHubClient()
    return {
      tools: [docsTool(docs), pluginsTool(registry, github)],
      dispose() {
        void docs.dispose?.()
        void registry.dispose?.()
        void github.dispose?.()
      },
    }
  } catch {
    return undefined
  }
}

/** Register the two tools into this preset. Resolves when the attempt finishes, fails, or the effect is disposed. */
export function installDotDevIndex(ctx: Context, load: () => Promise<DevIndexBundle | undefined> = loadDevIndexTools): Promise<void> {
  const host = ctx as ToolHost
  if (typeof ctx.effect !== 'function' || typeof host.tools?.register !== 'function') return Promise.resolve()
  let finished!: () => void
  const ready = new Promise<void>(resolve => { finished = resolve })
  ctx.effect(() => {
    let cancelled = false
    const releases: Array<() => void> = []
    let bundle: DevIndexBundle | undefined
    // Idempotent: splices whatever is registered and disposes the held bundle at most once.
    const drop = () => {
      cancelled = true
      for (const release of releases.splice(0).reverse()) {
        try { release() } catch { /* one failed undo cannot skip the rest */ }
      }
      const held = bundle
      bundle = undefined
      try { held?.dispose() } catch { /* optional client */ }
    }
    void (async () => {
      try {
        const loaded = await load()
        // Missing and late bundles take the same idempotent release as a failed register.
        if (cancelled || loaded === undefined) {
          bundle = loaded
          drop()
          return
        }
        bundle = loaded
        for (const tool of loaded.tools) {
          releases.push(host.tools.register({ ...tool, hostEffect: 'read-only' as const }))
        }
        if (cancelled) drop()
      } catch { drop() } finally { finished() }
    })()
    return () => { drop(); finished() }
  })
  return ready
}
