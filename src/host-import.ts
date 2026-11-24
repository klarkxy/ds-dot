/**
 * Resolve a host package (e.g. `@deepseek-ai/dsh-mcp-client`) so the instance
 * shares the host's module identity — `dsh-scope`'s `kScope` symbol in
 * particular, without which scope-keyed lookups silently miss. Falls back to
 * a plugin-local copy when the host loader cannot reach it.
 */
import { createRequire } from 'node:module'

interface HostLoader {
  loader?: { internal?: { import(name: string, baseUrl: string, options?: object): Promise<unknown> } }
  baseUrl?: string
}

export async function hostImport(ctx: HostLoader, name: string): Promise<never> {
  const internal = ctx.loader?.internal
  if (internal !== undefined && ctx.baseUrl !== undefined) {
    try { return await internal.import(name, ctx.baseUrl, {}) as never } catch { /* fall through */ }
  }
  if (ctx.baseUrl !== undefined) {
    try {
      const require = createRequire(new URL(ctx.baseUrl))
      return await import(require.resolve(name)) as never
    } catch { /* fall through */ }
  }
  return await import(name) as never
}
