import { describe, expect, it } from 'vitest'
import { bindHost } from './host.ts'

describe('running task permissions and relay', () => {
  it('verifies effective writable and read-only permissions without mutation', async () => {
    const session = {}
    let mode = 'read-only'
    let policy = 'never'
    let current = 'workspace-write'
    const calls: string[] = []
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) }
      : name === 'sandboxPolicy' ? { resolve: () => ({ mode }) }
      : name === 'approval' ? { overrideOf: () => policy }
      : name === 'permissionPresets' ? { defaultPreset: 'workspace-write', resolve: (preset: string) => ({ sandbox: preset }), current: () => current, set: () => calls.push('set') }
      : undefined)
    expect(await host.verifyTaskPermission!('s', 'read', 'default')).toBe(true)
    policy = 'ask'
    expect(await host.verifyTaskPermission!('s', 'read', 'default')).toBe(false)
    mode = 'workspace-write'
    expect(await host.verifyTaskPermission!('s', 'write', 'default')).toBe(true)
    current = 'custom'
    expect(await host.verifyTaskPermission!('s', 'write', 'default')).toBe(false)
    expect(calls).toEqual([])
  })
  it('relays through followup without steering or cancelling', async () => {
    const calls: string[] = []
    const agent = { followup: () => calls.push('followup'), steer: () => calls.push('steer'), cancel: () => calls.push('cancel') }
    const host = bindHost(name => name === 'agents' ? { get: () => agent } : undefined)
    await host.relay('target', 'sender', 'follow-up')
    expect(calls).toEqual(['followup'])
  })
})

describe('writable task policy', () => {
  it('resolves the host default and reapplies its writable preset', async () => {
    const calls: string[] = []
    const session = {}
    const permissions = { defaultPreset: 'workspace-write', resolve: (name: string) => ({ sandbox: name }), set: (_session: unknown, name: string) => { calls.push(name) } }
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : name === 'permissionPresets' ? permissions : undefined)
    expect(await host.setWritable!('s', 'default')).toBe(true)
    expect(calls).toEqual(['workspace-write'])
  })
  it('rejects missing, read-only and failed presets', async () => {
    const session = {}
    const permissions = { defaultPreset: 'read-only', resolve: (name: string) => ({ sandbox: name }), set: () => { throw new Error('failed') } }
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : name === 'permissionPresets' ? permissions : undefined)
    expect(await host.setWritable!('s', 'default')).toBe(false)
    expect(await host.setWritable!('s', 'workspace-write')).toBe(false)
    const absent = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : undefined)
    expect(await absent.setWritable!('s', 'default')).toBe(false)
  })
})

describe('read-only task policy', () => {
  it('falls back to sandbox mode and disables approvals', async () => {
    const events: Array<{ type: string; data: unknown }> = []
    const session = { append: (type: string, data: unknown) => events.push({ type, data }) }
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : undefined)
    expect(await host.setReadOnly!('s')).toBe(true)
    expect(events).toEqual([{ type: 'sandbox/mode', data: { mode: 'read-only' } }, { type: 'approval/policy', data: { policy: 'never' } }])
  })
  it('uses the named preset when it actually selects read-only', async () => {
    const events: string[] = []
    const session = { append: (type: string) => events.push(type) }
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) } : name === 'permissionPresets' ? { resolve: () => ({ sandbox: 'read-only' }), set: () => events.push('preset') } : undefined)
    expect(await host.setReadOnly!('s')).toBe(true)
    expect(events).toEqual(['preset', 'approval/policy'])
  })
})
