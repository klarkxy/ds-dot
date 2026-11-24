import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type DotMcpServer, type DotSettings } from './contracts.ts'
import { apply } from './mcp.ts'
import { sharedDotMcp } from './mcp-shared.ts'

const deepwiki: DotMcpServer = { url: 'https://mcp.deepwiki.com/mcp', enabled: true }
const exa: DotMcpServer = { url: 'https://mcp.exa.ai/mcp', enabled: true }

interface FakeFiber {
  _status: { state: string; toolCount?: number }
  _watchers: Array<(status: unknown) => void>
  dispose: ReturnType<typeof vi.fn>
}

function harness(initial: Readonly<Record<string, DotMcpServer>>, options: { statusDelayCalls?: number } = {}) {
  const shared = sharedDotMcp()
  const settings: DotSettings = { ...DEFAULT_SETTINGS, mcpServers: { ...initial } }
  shared.settings = () => settings
  const mounts: Array<Record<string, unknown>> = []
  const fibers: FakeFiber[] = []
  const defs = { list: [] as { name: string }[] }
  let statusCalls = 0
  const clientModule = {
    connectionStatusOf(fiber: FakeFiber) {
      statusCalls += 1
      if (statusCalls <= (options.statusDelayCalls ?? 0)) return undefined
      return {
        current: () => fiber._status,
        onChange: (callback: (status: unknown) => void) => {
          fiber._watchers.push(callback)
          return () => {}
        },
      }
    },
  }
  const ctx = {
    baseUrl: 'file:///plugin/lib/',
    loader: { internal: { import: async (name: string) => name === '@deepseek-ai/dsh-mcp-client' ? clientModule : {} } },
    plugin(_plugin: unknown, config: Record<string, unknown>) {
      if (config.url === 'https://fail.example/mcp') throw new Error('mount boom')
      mounts.push(config)
      const fiber: FakeFiber = { _status: { state: 'connecting', attempt: 0 }, _watchers: [], dispose: vi.fn(async () => {}) }
      fibers.push(fiber)
      return fiber
    },
    on() { return () => {} },
    get(name: string) { return name === 'tools' ? { definitions: () => defs.list } : undefined },
  }
  const done = apply(ctx as never)
  const push = (name: string, status: { state: string; toolCount?: number }) => {
    const fiber = fibers[mounts.findIndex(config => config.serverName === name)]
    fiber._status = status
    for (const watcher of fiber._watchers) watcher(status)
  }
  return { shared, settings, mounts, fibers, defs, push, done }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const settleDebounce = () => new Promise(resolve => setTimeout(resolve, 700))

afterEach(() => {
  const shared = sharedDotMcp()
  shared.settings = undefined
  shared.onSettingsChanged = undefined
  shared.onToolsChanged = undefined
  shared.servers.clear()
})

describe('ds-dot/mcp preset row', () => {
  it('mounts enabled servers as streamable-http mcp-clients in its own scope', async () => {
    const run = harness({ deepwiki, exa })
    await run.done
    expect(run.mounts).toHaveLength(2)
    expect(run.mounts[0]).toMatchObject({ serverName: 'deepwiki', transport: 'streamable-http', url: deepwiki.url, expandTemplates: true, failOnStartupError: false })
    expect(run.mounts[1]).toMatchObject({ serverName: 'exa' })
  })

  it('disposes removed and disabled servers without touching the rest', async () => {
    const run = harness({ deepwiki, exa })
    await run.done
    Object.assign(run.settings, { mcpServers: { deepwiki, exa: { ...exa, enabled: false } }
 });
    run.shared.onSettingsChanged?.()
    await settle()
    expect(run.fibers[1]!.dispose).toHaveBeenCalled()
    expect(run.fibers[0]!.dispose).not.toHaveBeenCalled()
    expect(run.mounts).toHaveLength(2)
    Object.assign(run.settings, { mcpServers: {}
 });
    run.shared.onSettingsChanged?.()
    await settle()
    expect(run.fibers[0]!.dispose).toHaveBeenCalled()
    expect(run.shared.servers.size).toBe(0)
  })

  it('remounts on url change but not on unrelated settings edits', async () => {
    const run = harness({ deepwiki })
    await run.done
    Object.assign(run.settings, { mcpServers: { deepwiki: { ...deepwiki, headers: { 'X-A': '1' } } }
 });
    run.shared.onSettingsChanged?.()
    await settle()
    expect(run.mounts).toHaveLength(2)
    expect(run.fibers[0]!.dispose).toHaveBeenCalled()
    Object.assign(run.settings, { mcpServers: { deepwiki: { ...deepwiki, headers: { 'X-A': '1' } } }
 });
    run.shared.onSettingsChanged?.()
    await settle()
    expect(run.mounts).toHaveLength(2)
  })

  it('keeps mounting other servers when one mount throws', async () => {
    const run = harness({ bad: { url: 'https://fail.example/mcp', enabled: true }, exa })
    await run.done
    expect(run.mounts).toEqual([expect.objectContaining({ serverName: 'exa' })])
    expect(run.shared.servers.get('bad')?.state).toBe('failed')
  })

  it('attaches the status handle when it registers after ctx.plugin returns', async () => {
    const run = harness({ deepwiki }, { statusDelayCalls: 2 })
    await run.done
    expect(run.shared.servers.get('deepwiki')?.state).toBe('connecting')
    await new Promise(resolve => setTimeout(resolve, 1300))
    run.defs.list = [{ name: 'mcp__deepwiki__ask' }]
    run.push('deepwiki', { state: 'connected', toolCount: 1 })
    await settleDebounce()
    expect(run.shared.servers.get('deepwiki')).toEqual({ state: 'connected', toolCount: 1 })
  })

  it('publishes status and notifies once the dot-local tool set changes', async () => {
    const run = harness({ deepwiki })
    const toolsChanged = vi.fn()
    run.shared.onToolsChanged = toolsChanged
    await run.done
    run.defs.list = [{ name: 'mcp__deepwiki__ask' }, { name: 'web_search' }]
    run.push('deepwiki', { state: 'connected', toolCount: 1 })
    await settleDebounce()
    expect(run.shared.servers.get('deepwiki')).toEqual({ state: 'connected', toolCount: 1 })
    expect(toolsChanged).toHaveBeenCalledTimes(1)
    // Same names again: no second notification.
    run.push('deepwiki', { state: 'connected', toolCount: 1 })
    await settleDebounce()
    expect(toolsChanged).toHaveBeenCalledTimes(1)
  })
})
