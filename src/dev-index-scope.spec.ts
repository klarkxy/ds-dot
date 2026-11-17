import { describe, expect, it } from 'vitest'
import { DEV_INDEX_TOOLS, installDotDevIndex, loadDevIndexTools } from './dev-index-scope.ts'

function host() {
  const registered: Array<Record<string, unknown>> = []
  const ctx = {
    tools: {
      register(definition: Record<string, unknown>) {
        registered.push(definition)
        return () => {}
      },
    },
    effect(start: () => () => void) { start(); return () => {} },
  }
  return { ctx, registered }
}

describe('dot-scoped dsh-dev-index tools', () => {
  it('loads dsh_docs and dsh_plugins from the installed package', async () => {
    const bundle = await loadDevIndexTools()
    expect(bundle, 'optional peer @klarkxy/dsh-dev-index should be resolvable in this checkout').toBeDefined()
    expect(bundle!.tools.map(tool => tool.name)).toEqual([...DEV_INDEX_TOOLS])
    expect(typeof bundle!.tools[0]?.execute).toBe('function')
    expect(typeof bundle!.tools[1]?.execute).toBe('function')
    bundle!.dispose()
  })

  it('registers both tools as read-only on the preset, and stays quiet when the package is missing', async () => {
    const present = host()
    await installDotDevIndex(present.ctx as never)
    expect(present.registered.map(row => row.name)).toEqual([...DEV_INDEX_TOOLS])
    expect(present.registered.every(row => row.hostEffect === 'read-only')).toBe(true)

    const missing = host()
    await installDotDevIndex(missing.ctx as never, async () => undefined)
    expect(missing.registered).toEqual([])
  })
})
