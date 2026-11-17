import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { TOOL } from './contracts.ts'
import { restrictInheritedTools } from './tool-scope.ts'
import { DOT_INHERITED_ALLOW } from './tools.ts'

function fixture() {
  const ctx = new Context()
  new SystemPrompt(ctx, {} as never)
  new ToolsService(ctx)
  const key = {}
  const scope = createScope(ctx, key)
  const register = (host: Context, name: string) => host.tools.register(defineTool({
    name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'ok',
  }))
  return { ctx, key, scope, register, names: () => ctx.tools.schemas(key).map(tool => tool.name).sort() }
}

describe('dot preset tool restrictions on the rc.3 registry', () => {
  it('hides inherited tools, keeps own tools, and leaves other scopes alone', async () => {
    const f = fixture()
    f.register(f.ctx, 'pwsh')
    f.register(f.ctx, 'show_view')
    f.register(f.scope.ctx, 'show_view')
    f.register(f.scope.ctx, TOOL.task)
    restrictInheritedTools(f.scope.ctx, DOT_INHERITED_ALLOW)
    expect(f.names()).toEqual([TOOL.task, 'show_view'].sort())
    expect(f.ctx.tools.get('pwsh', f.key)).toBeUndefined()
    expect(f.ctx.tools.get('pwsh')).toBeDefined()
    expect(f.ctx.tools.get('show_view', f.key)).not.toBe(f.ctx.tools.get('show_view'))
    await f.scope.dispose()
    expect(f.names()).toEqual(['pwsh', 'show_view'])
  })
  it('hides late inherited tools and keeps late local web/index tools', async () => {
    const f = fixture()
    restrictInheritedTools(f.scope.ctx, DOT_INHERITED_ALLOW)
    f.register(f.ctx, 'mcp_late')
    f.register(f.ctx, 'web_search')
    expect(f.names()).toEqual([])
    for (const name of ['web_search', 'web_fetch', 'dsh_docs', 'dsh_plugins']) f.register(f.scope.ctx, name)
    expect(f.names()).toEqual(['dsh_docs', 'dsh_plugins', 'web_fetch', 'web_search'])
    await f.scope.dispose()
  })
  it('keeps a local execution guard for unexpected scoped capabilities', async () => {
    const f = fixture()
    restrictInheritedTools(f.scope.ctx, ['show_view'])
    const gate = (name: string) => f.ctx.waterfall(scopeTarget(f.ctx.tools, f.key), 'tools/pre-execute', { name } as never, async () => ({ kind: 'allow' as const }))
    await expect(gate('scoped_secret')).resolves.toMatchObject({ kind: 'deny' })
    await expect(gate('show_view')).resolves.toEqual({ kind: 'allow' })
    await f.scope.dispose()
    await expect(gate('scoped_secret')).resolves.toEqual({ kind: 'allow' })
  })
})
