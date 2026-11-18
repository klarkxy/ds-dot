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

  it('settles and rolls back a partial registration when register throws', async () => {
    const released: string[] = []
    let disposed = false
    const ctx = {
      tools: {
        register(definition: { name?: string }) {
          if (definition.name === 'dsh_plugins') throw new Error('duplicate')
          return () => { released.push(definition.name ?? '') }
        },
      },
      effect(start: () => () => void) { start(); return () => {} },
    }
    await expect(installDotDevIndex(ctx as never, async () => ({
      tools: [{ name: 'dsh_docs' }, { name: 'dsh_plugins' }],
      dispose() { disposed = true },
    }))).resolves.toBeUndefined()
    expect(released).toEqual(['dsh_docs'])
    expect(disposed).toBe(true)
  })

  it('settles when loading throws synchronously and does not reject', async () => {
    const present = host()
    await expect(installDotDevIndex(present.ctx as never, () => { throw new Error('sync') })).resolves.toBeUndefined()
    expect(present.registered).toEqual([])
  })

  it('settles a pending load when the effect is disposed and does not register afterwards', async () => {
    let releaseLoad!: (value: { tools: Array<{ name: string }>; dispose(): void } | undefined) => void
    const loaded = new Promise<{ tools: Array<{ name: string }>; dispose(): void } | undefined>(resolve => { releaseLoad = resolve })
    let disposeEffect = () => {}
    let registered = 0
    let disposed = false
    const ctx = {
      tools: {
        register() { registered += 1; return () => {} },
      },
      effect(start: () => () => void) {
        disposeEffect = start()
        return () => {}
      },
    }
    const ready = installDotDevIndex(ctx as never, () => loaded)
    disposeEffect()
    await expect(ready).resolves.toBeUndefined()
    releaseLoad({ tools: [{ name: 'dsh_docs' }], dispose() { disposed = true } })
    await new Promise(resolve => setImmediate(resolve))
    expect(registered).toBe(0)
    expect(disposed).toBe(true)
  })
})
