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
    restrictInheritedTools(f.agent.ctx, DOT_INHERITED_ALLOW)
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
    expect(() => restrictInheritedTools(f.agent.ctx, DOT_INHERITED_ALLOW)).not.toThrow()
    expect(f.agentNames()).toEqual([TOOL.task])
    await f.agent.dispose()
    await f.preset.dispose()
  })
  it('hides every inherited tool when nothing on the allow list is visible', async () => {
    const f = fixture()
    bindScopeParent(f.agentKey, f.presetKey)
    f.register(f.ctx, 'pwsh')
    restrictInheritedTools(f.agent.ctx, ['show_view'])
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
    expect(() => restrictInheritedTools(ctx, ['show_view'])).not.toThrow()
    expect(applied).toEqual([{ allow: [] }])
  })
})
