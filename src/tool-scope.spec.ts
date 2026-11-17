import { describe, expect, it } from 'vitest'
import { TOOL } from './contracts.ts'
import { restrictInheritedTools } from './tool-scope.ts'
import { DOT_INHERITED_ALLOW, HOST_WEB_TOOLS } from './tools.ts'

/** Model the public registry contract, including synchronous change notifications. */
function scope(initial: string[]) {
  const global = new Set(initial)
  const filters = new Set<{ deny: readonly string[] }>()
  const calls: Array<{ deny: readonly string[] }> = []
  const listeners = new Map<string, Set<(...args: never[]) => unknown>>()
  const cleanups: Array<() => void> = []
  let depth = 0
  const notify = () => {
    if (++depth > 5) throw new Error('recursive restriction update')
    try { for (const listener of listeners.get('tools/change') ?? []) listener() } finally { depth-- }
  }
  const ctx = {
    tools: {
      schemas: () => [...global].map(name => ({ name })),
      restrict(filter: { deny: readonly string[] }) {
        expect(Object.keys(filter)).toEqual(['deny'])
        expect(filter.deny.length).toBeGreaterThan(0)
        expect(filter.deny.every(name => global.has(name))).toBe(true)
        calls.push(filter)
        filters.add(filter)
        notify()
        return () => { filters.delete(filter); notify() }
      },
    },
    on(event: string, listener: (...args: never[]) => unknown) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => { set.delete(listener) }
    },
    effect(start: () => (() => void)) { cleanups.push(start()) },
  }
  return {
    ctx, calls, global,
    add(name: string) { global.add(name); notify() },
    remove(name: string) { global.delete(name); notify() },
    visible: () => [...global].filter(name => ![...filters].some(filter => filter.deny.includes(name))),
    dispose: () => cleanups.forEach(cleanup => cleanup()),
    listenerCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
    gate: () => [...(listeners.get('tools/pre-execute') ?? [])][0] as ((exec: { name: string }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>) | undefined,
  }
}

describe('dot preset tool restrictions', () => {
  it('denies existing host and external tools, preserving only the exact public names', () => {
    const allowed = [...Object.values(TOOL), 'show_view']
    const s = scope([...allowed, 'read', 'pwsh', 'working_directory', 'mcp_external', 'dot_not_a_real_tool'])
    restrictInheritedTools(s.ctx as never, allowed)
    expect(s.visible().sort()).toEqual([...allowed].sort())
    expect(s.global.has('pwsh')).toBe(true) // unrelated scopes still inherit it
    expect(s.calls).toHaveLength(1)
  })

  it('blocks late MCP and plugin tools without recursion or replacing earlier filters', () => {
    const s = scope(['pwsh', 'show_view'])
    restrictInheritedTools(s.ctx as never, ['show_view'])
    s.add('mcp_late')
    s.add('plugin_late')
    s.add('plugin_late')
    expect(s.calls.map(filter => filter.deny)).toEqual([['pwsh'], ['mcp_late'], ['plugin_late']])
    expect(s.visible()).toEqual(['show_view'])
    s.remove('mcp_late')
    s.add('mcp_late')
    expect(s.visible()).toEqual(['show_view'])
    expect(s.calls).toHaveLength(3)
  })

  it('handles an initially empty registry and restores filters on scoped disposal', () => {
    const s = scope([])
    restrictInheritedTools(s.ctx as never, ['show_view'])
    expect(s.calls).toHaveLength(0)
    s.add('read')
    expect(s.visible()).toEqual([])
    s.dispose()
    expect(s.listenerCount()).toBe(0)
    expect(s.visible()).toEqual(['read'])
    s.add('later')
    expect(s.calls).toHaveLength(1)
  })

  it('gives reflection no inherited public mutation tools', () => {
    const s = scope([...Object.values(TOOL), 'show_view', 'web_search', 'web_fetch', 'dot_reflection_submit'])
    restrictInheritedTools(s.ctx as never, [TOOL.searchHistory, TOOL.readHistory, 'dot_reflection_submit'])
    expect(s.visible().sort()).toEqual([TOOL.searchHistory, TOOL.readHistory, 'dot_reflection_submit'].sort())
    expect(s.visible()).not.toContain(TOOL.agreement)
    expect(s.visible()).not.toContain('web_search')
  })

  it('keeps installed web_search and web_fetch, and still denies every other inherited tool', () => {
    const allowed = [...DOT_INHERITED_ALLOW]
    const s = scope([...allowed, 'read', 'pwsh', 'working_directory'])
    restrictInheritedTools(s.ctx as never, allowed)
    expect(s.visible().sort()).toEqual([...allowed].sort())
    expect(s.visible()).not.toContain('pwsh')
    expect(s.visible()).not.toContain('read')
    expect(HOST_WEB_TOOLS).toEqual(['web_search', 'web_fetch'])
  })

  it('keeps dsh_docs and dsh_plugins when they exist, and does not require them', () => {
    const allowed = [...DOT_INHERITED_ALLOW]
    const s = scope([...Object.values(TOOL), 'show_view', 'pwsh'])
    restrictInheritedTools(s.ctx as never, allowed)
    expect(s.visible()).not.toContain('dsh_docs')
    s.add('dsh_docs')
    s.add('dsh_plugins')
    expect(s.visible()).toContain('dsh_docs')
    expect(s.visible()).toContain('dsh_plugins')
    expect(s.visible()).not.toContain('pwsh')
  })

  it('does not require web tools and denies a renamed global tool without dropping dot tools', () => {
    const allowed = [...DOT_INHERITED_ALLOW]
    const s = scope([...Object.values(TOOL), 'show_view', 'pwsh'])
    expect(() => restrictInheritedTools(s.ctx as never, allowed)).not.toThrow()
    expect(s.visible().sort()).toEqual([...Object.values(TOOL), 'show_view'].sort())
    s.add('web_lookup')
    expect(s.visible()).not.toContain('web_lookup')
    expect(s.visible()).toContain(TOOL.overview)
    s.add('web_search')
    s.add('web_fetch')
    expect(s.visible()).toContain('web_search')
    expect(s.visible()).toContain('web_fetch')
    expect(s.visible()).not.toContain('pwsh')
  })

  it('denies a scoped tool the restrict list never sees', async () => {
    const s = scope(['show_view'])
    restrictInheritedTools(s.ctx as never, ['show_view'])
    const gate = s.gate()
    expect(gate).toBeTypeOf('function')
    await expect(gate!({ name: 'scoped_secret' }, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
    await expect(gate!({ name: 'show_view' }, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })
    s.dispose()
    expect(s.listenerCount()).toBe(0)
  })
})
