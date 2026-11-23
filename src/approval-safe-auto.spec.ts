import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { shouldDeferApprovalToSafeAuto } from './approval-safe-auto.ts'
import { bindHost } from './host.ts'
import { bindRunSession, launchReservedRun, supplementRun } from './execution.ts'
import { WorkBook, type WorkPersist } from './work.ts'
import type { TaskPermission } from './contracts.ts'
import { routeRequest } from './rules.ts'
import { DEFAULT_SETTINGS } from './contracts.ts'

describe('Safe Auto deny-all priority', () => {
  it('does not skip Dorothy deny-all for a task pinned away from safe-auto', () => {
    expect(shouldDeferApprovalToSafeAuto({ overlayActive: true, intendedPermission: 'workspace-write' })).toBe(false)
    expect(shouldDeferApprovalToSafeAuto({ overlayActive: true, intendedPermission: 'danger-full-access' })).toBe(false)
    expect(shouldDeferApprovalToSafeAuto({ overlayActive: true, intendedPermission: 'auto' })).toBe(false)
    expect(shouldDeferApprovalToSafeAuto({ overlayActive: true, intendedPermission: 'safe-auto' })).toBe(true)
    expect(shouldDeferApprovalToSafeAuto({ overlayActive: true, intendedPermission: undefined })).toBe(true)
    expect(shouldDeferApprovalToSafeAuto({ overlayActive: false, intendedPermission: 'safe-auto' })).toBe(false)
  })

  it('approvals=deny is rejected, not next(), when overlay is residual on a workspace-write task', () => {
    const overlay = true
    const skip = shouldDeferApprovalToSafeAuto({ overlayActive: overlay, intendedPermission: 'workspace-write' })
    const routed = skip ? { action: 'next' as const } : routeRequest({ ...DEFAULT_SETTINGS, approvals: 'deny' }, 'approval')
    expect(routed).toEqual({ action: 'deny' })
  })
})

function safeAutoPluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '../node_modules/@klarkxy/dsh-safe-auto'),
    join(here, '../../dsh-plugins/plugins/dsh-safe-auto'),
    join(here, '../../../dsh-plugins/plugins/dsh-safe-auto'),
  ]
  const found = candidates.find(dir => existsSync(join(dir, 'src/control.js')))
  if (!found) throw new Error('real @klarkxy/dsh-safe-auto src/control.js is required')
  return found
}

type ControlModule = {
  createControl: (base: unknown, options: Record<string, unknown>) => {
    select: (sessionId: string, signal?: AbortSignal) => Promise<boolean>
    sessionActive: (sessionId: string) => boolean
    available: () => boolean
    call: (endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
    dispose: () => Promise<void>
  }
}

type ConfigModule = { parseConfig: (raw?: Record<string, unknown>) => unknown }

async function loadRealControl(): Promise<{ createControl: ControlModule['createControl']; parseConfig: ConfigModule['parseConfig']; root: string }> {
  const root = safeAutoPluginRoot()
  const control = await import(pathToFileURL(join(root, 'src/control.js')).href) as ControlModule
  const config = await import(pathToFileURL(join(root, 'src/config.js')).href) as ConfigModule
  return { createControl: control.createControl, parseConfig: config.parseConfig, root }
}

describe('real @klarkxy/dsh-safe-auto overlay contract', () => {
  it('selects, stays active, and deselects when Dorothy re-pins away from safe-auto', async () => {
    const { createControl, parseConfig, root } = await loadRealControl()
    const events: { type?: string; data?: unknown }[] = []
    const session = {
      id: 's',
      header: { id: 's', cwd: root, createdAt: 1, isSeeded: false },
      get seq() { return events.length },
      snapshotEvents: () => events,
      append(type: string, data?: unknown) { events.push({ type, data }) },
    }
    let current = 'workspace-write'
    const specs: Record<string, { sandbox: string; approval: string }> = {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    }
    const live = new Map([['s', session]])
    const control = createControl(parseConfig({ provider: 'p', model: 'm' }), {
      table: { get: () => undefined, put: async () => {} },
      recentTable: { get: () => undefined, put: async () => {} },
      presets: {
        catalog: () => ({ options: Object.keys(specs).map(value => ({ value, name: value })) }),
        resolve: (value: string) => specs[value],
        current: () => current,
        set(_session: unknown, value: string) {
          if (current === value) return
          current = value
          events.push({ type: 'permission/preset', data: { preset: value } })
        },
      },
      sandboxPolicy: { resolve: () => ({ mode: specs[current]!.sandbox, workspaceRoot: root }) },
      sessions: { get: (id: string) => live.get(id), list: () => [...live.values()] },
    })
    const runtime = {
      selectSession: (id: string) => control.select(id),
      sessionActive: (id: string) => control.sessionActive(id),
      available: () => control.available(),
    }
    const host = bindHost(name => name === 'agents' ? { get: () => ({ session }) }
      : name === 'permissionPresets' ? {
        resolve: (preset: string) => specs[preset] ?? { sandbox: preset },
        current: () => current,
        set: (_s: unknown, value: string) => {
          if (current === value) return
          current = value
          events.push({ type: 'permission/preset', data: { preset: value } })
        },
        catalog: () => ({ options: Object.keys(specs).map(value => ({ value })) }),
      }
      : name === 'safeAutoRuntime' ? runtime
      : name === 'sandboxPolicy' ? { resolve: () => ({ mode: specs[current]!.sandbox }) }
      : undefined)

    expect(host.safeAutoActive!('s')).toBe(false)
    expect(await host.setWritable!('s', 'safe-auto')).toBe(true)
    expect(control.sessionActive('s')).toBe(true)
    expect(host.safeAutoActive!('s')).toBe(true)
    expect(await host.verifyTaskPermission!('s', 'write', 'safe-auto')).toBe(true)

    expect(await host.setWritable!('s', 'workspace-write')).toBe(true)
    expect(control.sessionActive('s')).toBe(false)
    expect(host.safeAutoActive!('s')).toBe(false)
    expect(await host.verifyTaskPermission!('s', 'write', 'workspace-write')).toBe(true)
    expect(await host.verifyTaskPermission!('s', 'write', 'safe-auto')).toBe(false)

    expect(await host.setWritable!('s', 'safe-auto')).toBe(true)
    expect(control.sessionActive('s')).toBe(true)
    expect(await host.setWritable!('s', 'danger-full-access')).toBe(true)
    expect(control.sessionActive('s')).toBe(false)
    expect(current).toBe('danger-full-access')
    await control.dispose()
  })
})

describe('pinned task permission vs live default', () => {
  const writeScope = { kind: 'paths' as const, paths: [{ path: '/repo/a.ts', type: 'file' as const }] }

  function openBook(): WorkBook {
    const persist: WorkPersist = async () => undefined
    return new WorkBook(persist, 'posix')
  }

  it('supplement of a pinned run does not re-pin the live global default', async () => {
    const book = openBook()
    const change = await book.createChange({ title: 'Ship', cwd: '/repo', goal: 'land it', at: 1 })
    const held = await book.reserveRun({
      changeId: change.id, cwd: '/repo', root: { workspaceRoot: '/repo' }, writeScope, taskPermission: 'safe-auto', at: 2,
    })
    if (!held.ok) throw new Error(held.message)
    expect(held.run.taskPermission).toBe('safe-auto')
    expect((await book.publishBaseline(held.run.id, book.revision, 'base-1', 3)).applied).toBe(true)

    const permits: string[] = []
    const events: unknown[] = []
    const fake = {
      async findSession() { return { cwd: '/repo' } },
      async createSession() { throw new Error('exists') },
      async setWritable(_id: string, permission: string) { permits.push(permission); return true },
      async verifyTaskPermission(_id: string, _access: string, permission: string) { return permission === permits[permits.length - 1] },
      async prompt() {},
      async readEvents() { return events },
      async relay(_session: string, sender: string, text: string, deliveryId?: string) {
        events.push({
          type: 'agent/inbox/spliced',
          data: { inserted: [{ id: 'm', source: { kind: 'agent-message', form: 'relay', senderSessionId: sender, deliveryId }, content: [{ type: 'text', text }] }] },
        })
      },
    }
    const pinned = book.run(held.run.id)!.taskPermission!
    const host = bindRunSession(fake, pinned)
    expect((await launchReservedRun(book, host, held.run.id, 'start')).ok).toBe(true)
    expect(permits).toEqual(['safe-auto'])
    expect((await supplementRun(book, host, held.run.id, 'more', 'dot', 6)).ok).toBe(true)
    expect(permits).toEqual(['safe-auto', 'safe-auto'])
    expect(book.run(held.run.id)?.taskPermission).toBe('safe-auto')

    const again = await book.pinTaskPermission(held.run.id, 'danger-full-access', 7)
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.run.taskPermission).toBe('safe-auto')
  })

  it('legacy read|write records do not widen to a later global default on supplement', async () => {
    const book = openBook()
    const change = await book.createChange({ title: 'Ship', cwd: '/repo', goal: 'land it', at: 1 })
    const held = await book.reserveRun({
      changeId: change.id, cwd: '/repo', root: { workspaceRoot: '/repo' }, writeScope, at: 2,
    })
    if (!held.ok) throw new Error(held.message)
    expect(held.run.taskPermission).toBeUndefined()
    expect((await book.publishBaseline(held.run.id, book.revision, 'base-1', 3)).applied).toBe(true)

    const permits: string[] = []
    let current: string | undefined = 'workspace-write'
    const events: unknown[] = []
    const fake = {
      async findSession() { return { cwd: '/repo' } },
      async createSession() { throw new Error('exists') },
      async setWritable(_id: string, permission: string) { permits.push(permission); current = permission; return true },
      async verifyTaskPermission(_id: string, _access: string, permission: string) { return current === permission },
      async prompt() {},
      async readEvents() { return events },
      async relay(_session: string, sender: string, text: string, deliveryId?: string) {
        events.push({
          type: 'agent/inbox/spliced',
          data: { inserted: [{ id: 'm', source: { kind: 'agent-message', form: 'relay', senderSessionId: sender, deliveryId }, content: [{ type: 'text', text }] }] },
        })
      },
    }
    expect((await launchReservedRun(book, bindRunSession(fake, 'workspace-write'), held.run.id, 'start')).ok).toBe(true)
    expect(permits).toEqual(['workspace-write'])

    const live = bindRunSession(fake, 'danger-full-access', { verifyOnly: true })
    expect((await supplementRun(book, live, held.run.id, 'more', 'dot', 6)).ok).toBe(true)
    expect(permits).toEqual(['workspace-write'])
    expect(current).toBe('workspace-write')
  })
})
