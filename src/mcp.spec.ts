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

function harness(initial: Readonly<Record<string, DotMcpServer>>, options: { statusDelayCalls?: number; importDelayMs?: number } = {}) {
  const shared = sharedDotMcp()
  const settings: DotSettings = { ...DEFAULT_SETTINGS, mcpServers: { ...initial } }
  shared.settings = () => settings
  const mounts: Array<Record<string, unknown>> = []
  const fibers: FakeFiber[] = []
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
    loader: { internal: { import: async (name: string) => {
      if (options.importDelayMs) await new Promise(resolve => setTimeout(resolve, options.importDelayMs))
      return name === '@deepseek-ai/dsh-mcp-client' ? clientModule : {}
    } } },
    plugin(_plugin: unknown, config: Record<string, unknown>) {
      if (config.url === 'https://fail.example/mcp') throw new Error('mount boom')
      mounts.push(config)
      const fiber: FakeFiber = { _status: { state: 'connecting', attempt: 0 }, _watchers: [], dispose: vi.fn(async () => {}) }
      fibers.push(fiber)
      return fiber
    },
    on() { return () => {} },
  }
  const done = apply(ctx as never)
  const push = (name: string, status: { state: string; toolCount?: number }) => {
    const fiber = fibers[mounts.findIndex(config => config.serverName === name)]
    fiber._status = status
    for (const watcher of fiber._watchers) watcher(status)
  }
  return { shared, settings, mounts, fibers, push, done }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const settleDebounce = () => new Promise(resolve => setTimeout(resolve, 700))

afterEach(() => {
  const shared = sharedDotMcp()
  shared.settings = undefined
  shared.onSettingsChanged = undefined
  shared.onToolsChanged = undefined
  shared.presetToolNames = undefined
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

  it('serializes reconciles so overlapping settings changes cannot double-mount', async () => {
    // The first mount is stuck inside its host import while two quick
    // settings saves arrive; the queued rerun must read the latest snapshot.
    const run = harness({ deepwiki }, { importDelayMs: 60 })
    Object.assign(run.settings, { mcpServers: { deepwiki, exa } })
    run.shared.onSettingsChanged?.()
    run.shared.onSettingsChanged?.()
    await run.done
    const counts = new Map<string, number>()
    for (const config of run.mounts) counts.set(String(config.serverName), (counts.get(String(config.serverName)) ?? 0) + 1)
    expect(counts).toEqual(new Map([['deepwiki', 1], ['exa', 1]]))
  })

  it('attaches the status handle when it registers after ctx.plugin returns', async () => {
    const run = harness({ deepwiki }, { statusDelayCalls: 2 })
    await run.done
    expect(run.shared.servers.get('deepwiki')?.state).toBe('connecting')
    await new Promise(resolve => setTimeout(resolve, 1300))
    run.push('deepwiki', { state: 'connected', toolCount: 1 })
    await settleDebounce()
    expect(run.shared.servers.get('deepwiki')).toEqual({ state: 'connected', toolCount: 1 })
  })

  it('notifies on published-status signature changes, not on an unscoped tool view', async () => {
    const run = harness({ deepwiki })
    const toolsChanged = vi.fn()
    run.shared.onToolsChanged = toolsChanged
    await run.done
    // connecting (from mount) already counted in the baseline signature.
    run.push('deepwiki', { state: 'connected', toolCount: 1 })
    await settleDebounce()
    expect(run.shared.servers.get('deepwiki')).toEqual({ state: 'connected', toolCount: 1 })
    expect(toolsChanged).toHaveBeenCalledTimes(1)
    // Same signature again: no second notification.
    run.push('deepwiki', { state: 'connected', toolCount: 1 })
    await settleDebounce()
    expect(toolsChanged).toHaveBeenCalledTimes(1)
    // A tool-count bump is a real signature change.
    run.push('deepwiki', { state: 'connected', toolCount: 2 })
    await settleDebounce()
    expect(toolsChanged).toHaveBeenCalledTimes(2)
  })

  it('does not wait on the preset scope while applying', async () => {
    // presetToolNames goes through agentPresets.acquireScope, which waits on
    // this row's own activation; resolving it only after apply returns proves
    // apply never awaits the preset scope (otherwise this deadlocks).
    let releaseTools: (() => void) | undefined
    sharedDotMcp().presetToolNames = () =>
      new Promise(resolve => {
        releaseTools = () => resolve(['mcp__deepwiki__ask'])
      })
    const run = harness({ deepwiki })
    const outcome = await Promise.race([
      run.done.then(() => 'resolved'),
      new Promise(resolve => setTimeout(() => resolve('still-pending'), 5_000)),
    ])
    expect(outcome).toBe('resolved')
    run.push('deepwiki', { state: 'connected', toolCount: 1 })
    releaseTools?.()
    await settleDebounce()
  })

  it('fires when a same-count tool set trades one name for another', async () => {
    const run = harness({ deepwiki })
    const toolsChanged = vi.fn()
    run.shared.onToolsChanged = toolsChanged
    let toolNames: readonly string[] = ['mcp__deepwiki__ask']
    run.shared.presetToolNames = async () => toolNames
    await run.done
    run.push('deepwiki', { state: 'connected', toolCount: 1 })
    await settleDebounce()
    expect(toolsChanged).toHaveBeenCalledTimes(1)
    // Same state and count, different name: still a signature change.
    toolNames = ['mcp__deepwiki__read_wiki_structure']
    run.push('deepwiki', { state: 'connected', toolCount: 1 })
    await settleDebounce()
    expect(toolsChanged).toHaveBeenCalledTimes(2)
  })
})
