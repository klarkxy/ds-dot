/** Restrict inherited capabilities while keeping this preset's own tools. */
import type { Context } from '@deepseek-ai/cordis'

interface ToolScope {
  tools: { restrict(filter: { allow: readonly string[] }): () => void }
  on(event: 'tools/pre-execute', listener: (exec: { readonly name: string }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>): () => void
}

export function restrictInheritedTools(ctx: Context, allowedNames: readonly string[]): void {
  const host = ctx as unknown as ToolScope
  const allowed = new Set(allowedNames)
  ctx.effect(() => host.tools.restrict({ allow: [] }))
  // Scope-local registrations bypass inherited restrictions. Keep their local gate.
  ctx.effect(() => host.on('tools/pre-execute', (exec, next) => allowed.has(exec.name)
    ? next()
    : Promise.resolve({ kind: 'deny', reason: 'This preset cannot run that tool.' })))
}
