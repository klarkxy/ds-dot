/** Execution and visibility gating for a preset's agent scope.
 *
 * Visibility restrictions must be applied to the agent scope after the preset
 * mounts — never to the preset's own registration scope: ToolsService.view
 * treats every ancestor layer as inherited, so an `allow: []` registered on
 * the preset scope would also hide the preset's own tools from the agent
 * child scope that assembles the request, leaving the model with no tool
 * list at all (and falling back to raw text-call syntax).
 */
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Context } from '@deepseek-ai/cordis'

interface ToolScope {
  tools: {
    restrict(filter: { allow: readonly string[] }): () => void
    schemas(scope: unknown): { readonly name: string }[]
  }
  on(event: 'tools/pre-execute', listener: (exec: { readonly name: string }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>): () => void
}

/**
 * Keep the pre-execute execution gate on the preset scope: ancestor-layer
 * listeners still observe the agent's executions, so a tool outside the allow
 * list that somehow reaches the model is denied at run time.
 */
export function gateToolExecution(ctx: Context, allowedNames: readonly string[]): void {
  const host = ctx as unknown as ToolScope
  const allowed = new Set(allowedNames)
  ctx.effect(() => host.on('tools/pre-execute', (exec, next) => allowed.has(exec.name)
    ? next()
    : Promise.resolve({ kind: 'deny', reason: 'This preset cannot run that tool.' })))
}

/**
 * Restrict the agent scope to the allow list, keeping only names actually
 * visible there. Names the host never registered (an absent dsh-tool-web, a
 * missing dsh-dev-index) are omitted instead of throwing: `tools.restrict`
 * refuses unknown global names. An empty intersection, or a snapshot that
 * throws, still applies `allow: []`, which admits no inherited tool. Returning
 * without a restriction would leave every global tool visible.
 */
export function restrictInheritedTools(agentCtx: unknown, allowedNames: readonly string[]): void {
  const host = agentCtx as Context & ToolScope
  const tools = host.tools
  if (!tools || typeof tools.restrict !== 'function') return
  let visible: ReadonlySet<string> | undefined
  try {
    visible = new Set(tools.schemas(scopeOf(host)).map(tool => tool.name))
  } catch { /* the empty allow below hides inherited tools */ }
  const allow = visible === undefined ? [] : allowedNames.filter(name => visible.has(name))
  tools.restrict({ allow })
}
