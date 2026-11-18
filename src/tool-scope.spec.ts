import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { TOOL } from './contracts.ts'
import { gateToolExecution, restrictInheritedTools } from './tool-scope.ts'
import { DOT_INHERITED_ALLOW } from './tools.ts'

function fixture() {
  const ctx = new Context()
  new SystemPrompt(ctx, {} as never)
  new ToolsService(ctx)
  const presetKey = {}
  const preset = createScope(ctx, presetKey)
  // The host builds an agent scope as `createScope(loopCtx, agent)`, so the
  // Agent handed to setup is the key. The key object stands in for it here.
  const agentKey = {}
  const agent = createScope(ctx, agentKey)
  const register = (host: Context, name: string) => host.tools.register(defineTool({
    name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'ok',
  }))
  return {
    ctx, preset, presetKey, agent, agentKey, register,
    presetNames: () => ctx.tools.schemas(presetKey).map(tool => tool.name).sort(),
    agentNames: () => ctx.tools.schemas(agentKey).map(tool => tool.name).sort(),
  }
}

describe('dot preset tool restrictions on the rc.3 registry', () => {
  it('the agent child scope keeps the preset tools it is allowed to see', async () => {
    const f = fixture()
    bindScopeParent(f.agentKey, f.presetKey)
    f.register(f.ctx, 'pwsh')
    f.register(f.ctx, 'show_view')
    f.register(f.preset.ctx, TOOL.task)
    // The request assembles from the agent scope; the preset layer mounted its
    // tools already, and the restriction is applied there — never earlier.
    restrictInheritedTools(f.agent.ctx, DOT_INHERITED_ALLOW, f.agentKey)
    expect(f.agentNames()).toEqual([TOOL.task, 'show_view'].sort())
    // The preset's own view is untouched by the agent-scope restriction.
    expect(f.presetNames()).toEqual([TOOL.task, 'pwsh', 'show_view'].sort())
    await f.agent.dispose()
    await f.preset.dispose()
    expect(f.ctx.tools.get('pwsh')).toBeDefined()
  })
  it('the execution gate on the preset scope denies tools outside the allow list', async () => {
    const f = fixture()
    gateToolExecution(f.preset.ctx, ['show_view'])
    f.register(f.preset.ctx, 'scoped_secret')
    const agentKey = scopeOf(f.agent.ctx)
    const gate = (name: string) => f.ctx.waterfall(scopeTarget(f.ctx.tools, agentKey), 'tools/pre-execute', { name } as never, async () => ({ kind: 'allow' as const }))
    bindScopeParent(f.agentKey, f.presetKey)
    await expect(gate('scoped_secret')).resolves.toMatchObject({ kind: 'deny' })
    await expect(gate('show_view')).resolves.toEqual({ kind: 'allow' })
    await f.agent.dispose()
    await f.preset.dispose()
    await expect(gate('scoped_secret')).resolves.toEqual({ kind: 'allow' })
  })
  it('names the host never registered are skipped, not fatal', async () => {
    const f = fixture()
    bindScopeParent(f.agentKey, f.presetKey)
    f.register(f.preset.ctx, TOOL.task)
    // dsh_docs/dsh_plugins/web_search may be absent; restrict must not throw.
    expect(() => restrictInheritedTools(f.agent.ctx, DOT_INHERITED_ALLOW, f.agentKey)).not.toThrow()
    expect(f.agentNames()).toEqual([TOOL.task])
    await f.agent.dispose()
    await f.preset.dispose()
  })
  it('hides every inherited tool when nothing on the allow list is visible', async () => {
    const f = fixture()
    bindScopeParent(f.agentKey, f.presetKey)
    f.register(f.ctx, 'pwsh')
    restrictInheritedTools(f.agent.ctx, ['show_view'], f.agentKey)
    expect(f.agentNames()).toEqual([])
    await f.agent.dispose()
    await f.preset.dispose()
    expect(f.ctx.tools.get('pwsh')).toBeDefined()
  })
  it('hides inherited tools when the visibility snapshot throws', () => {
    const applied: Array<{ allow?: readonly string[] }> = []
    const ctx = {
      tools: {
        schemas() { throw new Error('snapshot failed') },
        restrict(filter: { allow?: readonly string[] }) {
          applied.push(filter)
          return () => {}
        },
      },
    }
    expect(() => restrictInheritedTools(ctx, ['show_view'], {})).not.toThrow()
    expect(applied).toEqual([{ allow: [] }])
  })
})

describe('dot preset tool restrictions read the agent scope key the host chose', () => {
  it('reads the agent view through the key the setup callback passes', async () => {
    const f = fixture()
    bindScopeParent(f.agentKey, f.presetKey)
    f.register(f.ctx, 'show_view')
    f.register(f.ctx, 'web_search')
    f.register(f.ctx, 'pwsh')
    f.register(f.preset.ctx, TOOL.task)
    // The key the host created the scope with is the Agent; passing it in is
    // what keeps the preset's own tool on the allow list, because the view is
    // then read through the agent scope rather than the global one.
    expect(scopeOf(f.agent.ctx)).toBe(f.agentKey)
    restrictInheritedTools(f.agent.ctx, DOT_INHERITED_ALLOW, f.agentKey)
    expect(f.agentNames()).toEqual([TOOL.task, 'show_view', 'web_search'].sort())
    await f.agent.dispose()
    await f.preset.dispose()
  })
  it('never reads the global view when the context scope is not resolvable', () => {
    // A plugin installed with its own copy of @deepseek-ai/dsh-scope compares a
    // different module-local scope Symbol, so the context cannot answer for
    // itself; the explicit key is then the only way to the agent view.
    const foreignTag = Symbol('dsh.scope')
    const agent = {}
    const agentView = [TOOL.task, 'show_view', 'web_search', 'pwsh']
    const asked: unknown[] = []
    const applied: Array<{ allow?: readonly string[] }> = []
    const host = {
      [foreignTag]: {},
      tools: {
        schemas(scope: unknown) {
          asked.push(scope)
          // The global view lacks every name the preset itself registered.
          if (scope === undefined) return ['show_view', 'pwsh'].map(name => ({ name }))
          return agentView.map(name => ({ name }))
        },
        restrict(filter: { allow?: readonly string[] }) {
          applied.push(filter)
          return () => {}
        },
      },
    }
    restrictInheritedTools(host, DOT_INHERITED_ALLOW, agent)
    expect(asked).toEqual([agent])
    expect(applied).toEqual([{ allow: [TOOL.task, 'show_view', 'web_search'] }])
  })
  it('refuses to restrict without the agent scope key', () => {
    // The production path always holds the Agent; falling back to the global
    // view instead would hide every tool the preset registered.
    expect(() => restrictInheritedTools({ tools: { schemas: () => [], restrict: () => () => {} } }, ['show_view'], undefined as never))
      .toThrow(TypeError)
  })
  it('never admits a shell or MCP tool, even when the host registered one', async () => {
    const f = fixture()
    bindScopeParent(f.agentKey, f.presetKey)
    f.register(f.ctx, 'show_view')
    f.register(f.ctx, 'web_search')
    f.register(f.ctx, 'pwsh')
    f.register(f.ctx, 'shell')
    f.register(f.ctx, 'mcp__magpie__magpie-image__generate_image')
    f.register(f.preset.ctx, TOOL.task)
    restrictInheritedTools(f.agent.ctx, DOT_INHERITED_ALLOW, f.agentKey)
    expect(f.agentNames()).toEqual([TOOL.task, 'show_view', 'web_search'].sort())
    // The allow list names no shell or MCP tool at all.
    for (const name of DOT_INHERITED_ALLOW) expect(name).not.toMatch(/^(shell|bash|pwsh|run_code|mcp__)/)
    // The host still holds what the agent cannot see.
    expect(f.ctx.tools.get('pwsh')).toBeDefined()
    expect(f.ctx.tools.get('mcp__magpie__magpie-image__generate_image')).toBeDefined()
    await f.agent.dispose()
    await f.preset.dispose()
  })
})
