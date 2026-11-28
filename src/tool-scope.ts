/** Execution and visibility gating for a preset's agent scope.
 *
 * Visibility restrictions must be applied to the agent scope after the preset
 * mounts — never to the preset's own registration scope: ToolsService.view
 * treats every ancestor layer as inherited, so an `allow: []` registered on
 * the preset scope would also hide the preset's own tools from the agent
 * child scope that assembles the request, leaving the model with no tool
 * list at all (and falling back to raw text-call syntax).
 */
import type { Context } from '@deepseek-ai/cordis'

interface ToolScope {
  tools: {
    restrict(filter: { allow: readonly string[] }): () => void
    schemas(scope: unknown): { readonly name: string }[]
  }
  on(event: 'tools/pre-execute', listener: (exec: GateExec, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>): () => void
}

/** What a `tools/pre-execute` gate observes of the pending call. */
export interface GateExec {
  readonly name: string
  readonly callId?: string
  readonly arguments?: unknown
  readonly signal?: AbortSignal
}

/** `next` lets the call run; anything else replaces the decision. */
export type GateVerdict = 'next' | { readonly kind: string; readonly reason?: string }

/**
 * Keep the pre-execute execution gate on the preset scope: ancestor-layer
 * listeners still observe the agent's executions, so a tool outside the allow
 * list that somehow reaches the model is denied at run time. Names outside the
 * locked set go to `decideExtra` when present — the dynamic verdict for the
 * extra-capability layer — and deny when it returns undefined or throws.
 */
export function gateToolExecution(ctx: Context, allowedNames: readonly string[], decideExtra?: (exec: GateExec) => Promise<GateVerdict>, guard?: (exec: GateExec) => string | undefined | Promise<string | undefined>): void {
  const host = ctx as unknown as ToolScope
  const allowed = new Set(allowedNames)
  ctx.effect(() => host.on('tools/pre-execute', async (exec, next) => {
    if (allowed.has(exec.name)) {
      const denied = await guard?.(exec)
      if (denied !== undefined) return { kind: 'deny', reason: denied }
      return next()
    }
    if (decideExtra !== undefined) {
      try {
        const verdict = await decideExtra({ name: exec.name, callId: exec.callId, arguments: exec.arguments, signal: exec.signal })
        if (verdict === 'next') {
          const denied = await guard?.(exec)
          if (denied !== undefined) return { kind: 'deny', reason: denied }
          return next()
        }
        if (verdict !== undefined) return verdict
      } catch { /* a failed check denies rather than leaks a call */ }
    }
    return { kind: 'deny', reason: 'This preset cannot run that tool.' }
  }))
}

/**
 * Restrict the agent scope to the allow list, keeping only names actually
 * visible there. Names the host never registered (an absent dsh-tool-web, a
 * missing dsh-dev-index) are omitted instead of throwing: `tools.restrict`
 * refuses unknown global names. An empty intersection, or a snapshot that
 * throws, still applies `allow: []`, which admits no inherited tool. Returning
 * without a restriction would leave every global tool visible.
 *
 * Use the Agent passed by the host to setup as the scope key. A linked plugin
 * can load a second copy of dsh-scope with a different private Symbol;
 * scopeOf(ctx) would then select the global view and omit the preset tools.
 */
export function restrictInheritedTools(agentCtx: unknown, allowedNames: readonly string[], scopeKey: object): () => void {
  const host = agentCtx as Context & ToolScope
  const tools = host.tools
  if (!tools || typeof tools.restrict !== 'function') return () => {}
  if (!scopeKey) {
    throw new TypeError('restrictInheritedTools needs the agent scope key: pass the Agent handed to the setup callback')
  }
  let visible: ReadonlySet<string> | undefined
  try {
    visible = new Set(tools.schemas(scopeKey).map(tool => tool.name))
  } catch { /* the empty allow below hides inherited tools */ }
  const allow = visible === undefined ? [] : allowedNames.filter(name => visible.has(name))
  return tools.restrict({ allow })
}
