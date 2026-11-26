import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'
import { describe, expect, it, vi } from 'vitest'
import { TASK_ONLY_TOOLS } from './capabilities.ts'
import { apply as applyPlugin } from './index.ts'
import { installPresetVisibility } from './preset-visibility.ts'
import {
  WORKER_JOB_WAIT_TIMEOUT_MS,
  WORKER_PRESET_ID,
  WORKER_SHELL_MAX_TIMEOUT_MS,
  WORKER_SHELL_TIMEOUT_MS,
  buildWorkerPresetDefinition,
  registerWorkerPreset,
  type WorkerPresetPluginEntry,
} from './worker-preset.ts'

function flattenEntries(entries: readonly WorkerPresetPluginEntry[]): WorkerPresetPluginEntry[] {
  const out: WorkerPresetPluginEntry[] = []
  for (const entry of entries) {
    out.push(entry)
    if (entry.group && Array.isArray(entry.config)) {
      out.push(...flattenEntries(entry.config))
    }
  }
  return out
}

function findGlobalDshDir(): string | undefined {
  const candidates = [
    process.env.DSH_PACKAGE_DIR,
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  ].filter((value): value is string => Boolean(value))
  try {
    const npmRoot = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    }).trim()
    if (npmRoot) candidates.unshift(join(npmRoot, '@deepseek-ai', 'dsh'))
  } catch { /* npm not required when well-known locations exist */ }
  for (const dir of candidates) {
    if (
      existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tool-jobs', 'package.json'))
      && existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-pwsh-sandbox', 'package.json'))
      && existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-bash-sandbox', 'package.json'))
    ) {
      return dir
    }
  }
  return undefined
}

const globalDshDir = findGlobalDshDir()

describe('dot-worker preset definition', () => {
  it('matches rc.5 standard toolset while isolating 5s shell promotion and omitting delegation/schedule/goal', () => {
    const def = buildWorkerPresetDefinition()
    expect(def.id).toBe(WORKER_PRESET_ID)
    expect(def.name.trim().length).toBeGreaterThan(0)
    expect(def.description.trim().length).toBeGreaterThan(0)

    const shellGroup = def.plugins.find(entry => entry.id === 'dot-worker-shell')
    expect(shellGroup).toMatchObject({
      id: 'dot-worker-shell',
      name: 'cordis:group',
      group: true,
      isolate: { shell: true },
    })
    const shellChildren = shellGroup!.config as readonly WorkerPresetPluginEntry[]
    expect(shellChildren.find(entry => entry.id === 'bash-sandbox')).toEqual({
      id: 'bash-sandbox',
      name: '@deepseek-ai/dsh-bash-sandbox',
      disabled: { __jsExpr: "process.platform === 'win32'" },
      config: { timeoutMs: WORKER_SHELL_TIMEOUT_MS, maxTimeoutMs: WORKER_SHELL_MAX_TIMEOUT_MS },
    })
    expect(shellChildren.find(entry => entry.id === 'tool-bash')).toEqual({
      id: 'tool-bash',
      name: '@deepseek-ai/dsh-tool-bash',
      disabled: { __jsExpr: "process.platform === 'win32'" },
      config: { enableRunInBackground: true, promoteOnTimeout: true },
    })
    expect(shellChildren.find(entry => entry.id === 'pwsh-sandbox')).toEqual({
      id: 'pwsh-sandbox',
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { timeoutMs: WORKER_SHELL_TIMEOUT_MS, maxTimeoutMs: WORKER_SHELL_MAX_TIMEOUT_MS },
    })
    expect(shellChildren.find(entry => entry.id === 'tool-pwsh')).toEqual({
      id: 'tool-pwsh',
      name: '@deepseek-ai/dsh-tool-pwsh',
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { enableRunInBackground: true, promoteOnTimeout: true },
    })

    const flat = flattenEntries(def.plugins)
    const names = flat.map(entry => entry.name)
    const ids = flat.map(entry => entry.id)

    expect(flat.find(entry => entry.id === 'tool-jobs')).toEqual({
      id: 'tool-jobs',
      name: '@deepseek-ai/dsh-tool-jobs',
      config: { waitTimeoutMs: WORKER_JOB_WAIT_TIMEOUT_MS },
    })
    expect(flat.find(entry => entry.id === 'skill-filesystem')).toEqual({
      id: 'skill-filesystem',
      name: '@deepseek-ai/dsh-skill-filesystem',
    })
    expect((flat.find(entry => entry.id === 'skill-filesystem')!.config as Record<string, unknown> | undefined)?.customSkillDirs).toBeUndefined()

    // Base tools preserved from standard.patch.yml
    for (const expectedName of [
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-agent-instructions',
      '@deepseek-ai/dsh-time-context',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-fs-search',
      '@deepseek-ai/dsh-tool-skill',
      '@deepseek-ai/dsh-plan-mode',
      '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-command-compact',
      '@deepseek-ai/dsh-compaction-tool-result-pruner',
      '@deepseek-ai/dsh-tool-ask-user',
      '@deepseek-ai/dsh-tool-todo',
      '@deepseek-ai/dsh-tool-web',
      '@deepseek-ai/dsh-tool-present',
      '@deepseek-ai/dsh-tool-office',
    ]) {
      expect(names).toContain(expectedName)
    }

    // Delegation, schedule, and goal plugins omitted
    for (const forbidden of [
      '@deepseek-ai/dsh-tool-subagent',
      '@deepseek-ai/dsh-tool-subagent-control',
      '@deepseek-ai/dsh-workflow-ptc',
      '@deepseek-ai/dsh-tool-workflow',
      '@deepseek-ai/dsh-tool-schedule',
      '@deepseek-ai/dsh-command-goal',
      '@deepseek-ai/dsh-tool-goal',
    ]) {
      expect(names).not.toContain(forbidden)
    }
    expect(ids).not.toContain('delegation')

    // TASK_ONLY_TOOLS shell & file mutation families remain represented
    expect(TASK_ONLY_TOOLS.has('bash')).toBe(true)
    expect(TASK_ONLY_TOOLS.has('pwsh')).toBe(true)
    expect(TASK_ONLY_TOOLS.has('write')).toBe(true)
    expect(TASK_ONLY_TOOLS.has('edit')).toBe(true)
    expect(names).toContain('@deepseek-ai/dsh-tool-bash')
    expect(names).toContain('@deepseek-ai/dsh-tool-pwsh')
    expect(names).toContain('@deepseek-ai/dsh-tool-fs')
  })

  it('stays public in AgentPresetRegistry and supports scoped tool shadowing over root tools', async () => {
    const ctx = new Context()
    ctx.provide('loader', { await: async () => {} } as never)
    ctx.provide('sessionProjections', { register: async () => ({ stateOf: () => null }) } as never)
    ctx.provide('agents', { turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: 0 }) } as never)
    new SystemPrompt(ctx, {})
    new ToolsService(ctx)
    const raw = new AgentPresetRegistry(ctx, {
      default: 'standard',
      selectedDefault: { get: () => undefined },
    } as never)

    const releaseStd = await raw.register({ id: 'standard', name: 'Standard', order: 1, plugins: [] })
    const releaseDot = await raw.register({ id: 'dot', name: 'Dorothy', order: 90, plugins: [] })
    const releaseWorker = await raw.register({ id: WORKER_PRESET_ID, name: 'Dot worker', order: 50, plugins: [] })
    const releaseVis = installPresetVisibility(ctx.agentPresets, ctx)

    // Root registers global shell/job tool; child preset scope shadows it without mutating root.
    const rootDispose = ctx.tools.register({
      name: 'pwsh',
      description: 'root 120s pwsh',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      execute: () => 'root-120s',
    } as never)

    const workerKey = { id: 'worker-agent' }
    const workerScope = createScope(ctx, workerKey)
    const shadowDispose = workerScope.ctx.tools.register({
      name: 'pwsh',
      description: 'worker 5s pwsh',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      execute: () => 'worker-5s',
    } as never)

    try {
      const visibleIds = (await ctx.agentPresets.list()).map(row => row.id)
      expect(visibleIds).toContain('standard')
      expect(visibleIds).toContain(WORKER_PRESET_ID)
      expect(visibleIds).not.toContain('dot')

      const exported = await ctx.agentPresets.remoteExportList()
      expect(exported.presets.find(row => row.id === WORKER_PRESET_ID)?.isDefault).toBe(false)
      expect(exported.presets.find(row => row.id === 'standard')?.isDefault).toBe(true)
      await expect(ctx.agentPresets.resolve(WORKER_PRESET_ID)).resolves.toMatchObject({ id: WORKER_PRESET_ID })

      expect(ctx.tools.get('pwsh')?.description).toBe('root 120s pwsh')
      expect(ctx.tools.get('pwsh', workerKey)?.description).toBe('worker 5s pwsh')
    } finally {
      shadowDispose()
      await workerScope.dispose()
      rootDispose()
      releaseVis()
      await releaseWorker()
      await releaseDot()
      await releaseStd()
    }
  })

  it('disposes cleanly, handles async dispose race, and silently degrades when agentPresets is absent or throwing', async () => {
    // 1. Absent agentPresets
    expect(() => registerWorkerPreset(undefined)).not.toThrow()
    expect(() => registerWorkerPreset({})).not.toThrow()
    expect(() => registerWorkerPreset({ agentPresets: {} })).not.toThrow()

    // 2. Synchronous throw
    const syncWarn = vi.fn()
    const syncRelease = registerWorkerPreset({
      agentPresets: {
        register() { throw new Error('boom sync') },
      },
      logger: { warn: syncWarn },
    })
    expect(syncWarn).toHaveBeenCalledTimes(1)
    expect(() => syncRelease()).not.toThrow()

    // 3. Asynchronous rejection
    const asyncWarn = vi.fn()
    const asyncRelease = registerWorkerPreset({
      agentPresets: {
        register: async () => { throw new Error('boom async') },
      },
      logger: { warn: asyncWarn },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(asyncWarn).toHaveBeenCalledTimes(1)
    expect(() => asyncRelease()).not.toThrow()

    // 4. Async dispose race: dispose invoked before register() resolves
    const delayedDispose = vi.fn(async () => {})
    let resolveRegister!: (dispose: () => Promise<void>) => void
    const raceRelease = registerWorkerPreset({
      agentPresets: {
        register: () => new Promise<() => Promise<void>>(resolve => { resolveRegister = resolve }),
      },
    })
    raceRelease()
    expect(delayedDispose).not.toHaveBeenCalled()
    resolveRegister(delayedDispose)
    await Promise.resolve()
    await Promise.resolve()
    expect(delayedDispose).toHaveBeenCalledTimes(1)

    // 5. Normal dispose and failing dispose safety
    const normalDispose = vi.fn(async () => { throw new Error('dispose error ignored') })
    const normalRelease = registerWorkerPreset({
      agentPresets: { register: async () => normalDispose },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(() => normalRelease()).not.toThrow()
    expect(normalDispose).toHaveBeenCalledTimes(1)
  })

  it('degrades silently on throwing agentPresets/register getters and sync-throwing disposers without unhandled rejections', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      // 1. Throwing ctx.agentPresets getter
      const getterWarn = vi.fn()
      const getterErr = vi.fn()
      const getterCtx = { logger: { warn: getterWarn } }
      Object.defineProperty(getterCtx, 'agentPresets', {
        get() { throw new Error('agentPresets getter boom') },
      })
      let getterRelease!: () => void
      expect(() => {
        getterRelease = registerWorkerPreset(getterCtx as never, { error: getterErr })
      }).not.toThrow()
      expect(getterWarn).toHaveBeenCalledTimes(1)
      expect(getterErr).toHaveBeenCalledTimes(1)
      expect(() => getterRelease()).not.toThrow()

      // 2. Throwing agentPresets.register getter
      const regGetterWarn = vi.fn()
      const regGetterPresets = {}
      Object.defineProperty(regGetterPresets, 'register', {
        get() { throw new Error('register getter boom') },
      })
      let regGetterRelease!: () => void
      expect(() => {
        regGetterRelease = registerWorkerPreset({ agentPresets: regGetterPresets as never, logger: { warn: regGetterWarn } })
      }).not.toThrow()
      expect(regGetterWarn).toHaveBeenCalledTimes(1)
      expect(() => regGetterRelease()).not.toThrow()

      // 3. Sync-throwing disposer on normal release()
      const syncThrowDispose = vi.fn(() => { throw new Error('sync dispose boom') })
      const syncDisposeRelease = registerWorkerPreset({
        agentPresets: { register: async () => syncThrowDispose as never },
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(() => syncDisposeRelease()).not.toThrow()
      expect(syncThrowDispose).toHaveBeenCalledTimes(1)

      // 4. Sync-throwing disposer during async-dispose race (release() called before register() settles)
      const raceSyncThrowDispose = vi.fn(() => { throw new Error('sync race dispose boom') })
      let resolveRace!: (dispose: () => Promise<void>) => void
      const raceRelease = registerWorkerPreset({
        agentPresets: {
          register: () => new Promise<() => Promise<void>>(resolve => { resolveRace = resolve }),
        },
      })
      raceRelease()
      expect(raceSyncThrowDispose).not.toHaveBeenCalled()
      resolveRace(raceSyncThrowDispose as never)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(raceSyncThrowDispose).toHaveBeenCalledTimes(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  function createApplyTestContext() {
    const tables: Record<string, Map<string, unknown>> = {
      state: new Map(), tasks: new Map(), tickets: new Map(), schedules: new Map(),
      recipes: new Map(), recipe_proposals: new Map(), proposals: new Map(),
      changes: new Map(), inputs: new Map(), runs: new Map(), verifications: new Map(),
      peers: new Map(), inbox: new Map(), links: new Map(),
    }
    const domain = {
      table: (name: string) => ({
        entries: () => tables[name]!.entries(),
        get: (key: string) => tables[name]!.get(key),
        put: async (key: string, value: unknown) => { tables[name]!.set(key, value) },
        delete: async (key: string) => tables[name]!.delete(key),
      }),
      close: async () => {},
    }
    const ctx = new Context()
    ctx.provide('storageDomain' as never, { open: async () => domain } as never)
    ctx.provide('sessions' as never, {} as never)
    ctx.provide('sessionQuery' as never, { readSession: async () => ({ events: [] }) } as never)
    ctx.provide('sessionController' as never, { list: async () => ({ items: [] }) } as never)
    ctx.provide('workspaceRegistry' as never, { list: () => [] } as never)
    ctx.provide('agents' as never, { get: () => undefined, list: () => [] } as never)
    ctx.provide('agentDefaultModel' as never, { currentSelection: () => ({}) } as never)
    ctx.provide('connection' as never, { requestRejection: () => undefined } as never)
    ctx.provide('webServer' as never, { register: () => () => {} } as never)
    return ctx
  }

  it('registers and unregisters dot-worker through apply() without failing when optional services are missing', async () => {
    const registered: Array<{ id: string; disposed: boolean }> = []
    const ctx = createApplyTestContext()
    ctx.provide('agentPresets' as never, {
      list: async () => registered.filter(r => !r.disposed).map(r => ({ id: r.id })),
      register: async (def: { id: string }) => {
        const row = { id: def.id, disposed: false }
        registered.push(row)
        return async () => { row.disposed = true }
      },
    } as never)

    const homeDir = mkdtempSync(join(tmpdir(), 'dot-worker-apply-'))
    try {
      const fiber = ctx.plugin({ name: 'ds-dot-test', apply: (c: Context) => applyPlugin(c, { homeDir }) })
      await fiber.await()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(registered.map(r => r.id)).toContain(WORKER_PRESET_ID)
      expect(registered.find(r => r.id === WORKER_PRESET_ID)?.disposed).toBe(false)
      await fiber.dispose()
      expect(registered.find(r => r.id === WORKER_PRESET_ID)?.disposed).toBe(true)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('degrades cleanly in applyPlugin(ctx) when ctx.agentPresets getter throws', async () => {
    const ctx = createApplyTestContext()
    const homeDir = mkdtempSync(join(tmpdir(), 'dot-worker-apply-getter-'))
    try {
      const fiber = ctx.plugin({
        name: 'ds-dot-throwing-agent-presets',
        apply: (c: Context) => {
          Object.defineProperty(c, 'agentPresets', {
            configurable: true,
            get() { throw new Error('host agentPresets getter boom') },
          })
          return applyPlugin(c, { homeDir })
        },
      })
      await expect(fiber.await().then(() => 'ok')).resolves.toBe('ok')
      await expect(fiber.dispose().then(() => 'ok')).resolves.toBe('ok')
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})

describe.runIf(Boolean(globalDshDir))('Hour-1 rc.5 micro-verification: dot-worker against real DSH modules', () => {
  it('mounts dot-worker with isolate shell (5s/600s), tool-jobs (5s), shadows root tools, promotes sleep >5s, and cleans up on dispose', async () => {
    const dshModules = join(globalDshDir!, 'node_modules')
    const mod = async (pkg: string) => {
      const url = pathToFileURL(join(dshModules, ...pkg.split('/'), 'lib', 'index.js')).href
      return await import(/* @vite-ignore */ url)
    }

    const { default: Loader, Group } = await mod('@deepseek-ai/cordis-plugin-loader')
    const LocalJobsRegistry = (await mod('@deepseek-ai/dsh-jobs-local')).default
    const LocalSubprocess = (await mod('@deepseek-ai/dsh-subprocess-local')).default
    const LocalSandbox = (await mod('@deepseek-ai/dsh-sandbox-local')).default
    const SandboxPolicyService = (await mod('@deepseek-ai/dsh-sandbox-policy')).default
    const ShellEnvMod = await mod('@deepseek-ai/dsh-shell-env')
    const shellPkg = process.platform === 'win32' ? '@deepseek-ai/dsh-pwsh-sandbox' : '@deepseek-ai/dsh-bash-sandbox'
    const toolShellPkg = process.platform === 'win32' ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash'
    const ShellSandbox = (await mod(shellPkg)).default
    const ToolShellMod = await mod(toolShellPkg)

    const workDir = mkdtempSync(join(tmpdir(), 'dot-worker-rc5-'))
    const ctx = new Context()
    const loader = new Loader(ctx)
    ;(loader as unknown as { builtins: Record<string, unknown> }).builtins.group = Group
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(SessionProjectionRegistry).await()
    await ctx.plugin(SystemPrompt, {}).await()
    await ctx.plugin(ToolsService).await()
    await ctx.plugin(LocalJobsRegistry).await()
    await ctx.plugin(LocalSubprocess).await()
    await ctx.plugin(LocalSandbox, { probeTimeoutMs: 5_000 }).await()
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: workDir }).await()
    await ctx.plugin(ShellEnvMod).await()
    ctx.provide('workingDirectory' as never, {
      ensure: async () => workDir,
      get: () => workDir,
      resolve: () => workDir,
      assertWritable: () => workDir,
    } as never)
    ctx.provide('fs' as never, { read: async () => '', write: async () => {} } as never)
    ctx.provide('skills' as never, {
      register: () => () => {},
      registerProvider: () => () => {},
      registerSource: () => () => {},
      list: () => [],
      get: () => undefined,
      subscribe: () => () => {},
    } as never)
    ctx.provide('llm' as never, {} as never)
    ctx.provide('tokenMeter' as never, { countTokens: () => 0, measure: () => 0 } as never)
    ctx.provide('commands' as never, { register: () => () => {} } as never)
    ctx.provide('compaction' as never, { compact: async () => ({}) } as never)
    ctx.provide('userQuestions' as never, { ask: async () => ({ answers: {} }) } as never)
    ctx.provide('web' as never, { search: async () => [], fetch: async () => '' } as never)
    const liveAgents = new Map<string, { id: string; ctx?: Context; session: unknown }>()
    ctx.provide('agents' as never, {
      turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: 0 }),
      get: (id: string) => liveAgents.get(id),
      list: () => [...liveAgents.values()],
    } as never)
    await ctx.plugin(AgentPresetRegistry, {
      default: 'standard',
    } as never).await()
    // Mount root shell + root shell tool (simulating `base` root layer at default 120_000ms)
    await ctx.plugin(ShellSandbox).await()
    await ctx.plugin(ToolShellMod).await()

    const pipeline = new ToolExecutionPipeline(ctx)
    ctx.tools.setExecutor({
      describe: tools => ({
        schemas: tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: { type: 'object', properties: {} },
        })),
      }),
      execute: input => executeToolBatch(input, pipeline, () => 4),
    })

    await ctx.loader.await()

    const rootShellBefore = (ctx as unknown as { shell: { config: { timeoutMs: { get(): number } } } }).shell
    expect(rootShellBefore).toBeDefined()
    expect(rootShellBefore.config.timeoutMs.get()).toBe(120_000)

    const baseUrl = pathToFileURL(join(globalDshDir!, 'package.json')).href
    const registerCtx = ctx.extend({ baseUrl }) as unknown as Parameters<typeof registerWorkerPreset>[0]
    const unregister = registerWorkerPreset(registerCtx)

    // Wait for AgentPresetRegistry.register() activation to settle
    let workerRow: { id: string; broken?: string } | undefined
    for (let i = 0; i < 60; i++) {
      const list = await ctx.agentPresets.list()
      workerRow = list.find(row => row.id === WORKER_PRESET_ID)
      if (workerRow) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    const session = ctx.sessions.create(SessionId('rc5-worker-session'), { cwd: workDir })
    const workerAgent: {
      id: string
      ctx?: Context
      session: typeof session
      inbox: { nextStep: unknown[]; remove(): void }
      followup(): void
      inject(): void
    } = {
      id: 'rc5-worker-session',
      session,
      inbox: { nextStep: [], remove() {} },
      followup() {},
      inject() {},
    }
    const workerScope = createScope(ctx, workerAgent)
    workerAgent.ctx = workerScope.ctx
    liveAgents.set(workerAgent.id, workerAgent)

    try {
      expect(workerRow).toBeDefined()
      expect(workerRow?.broken).toBeUndefined()

      await ctx.agentPresets.mount(workerScope.ctx, WORKER_PRESET_ID)
      const inspections = ctx.agentPresets.inspectCompositions(workerScope.ctx)
      expect(inspections).toHaveLength(1)
      expect(inspections[0]?.leakedServices).toEqual([])

      // Root shell stays at 120_000ms while worker's isolated shell receives 5_000ms / 600_000ms
      expect(rootShellBefore.config.timeoutMs.get()).toBe(120_000)
      const workerShell = ctx.agentPresets.serviceFor(workerAgent as { ctx: Context }, 'shell' as never) as unknown as {
        config: { timeoutMs: { get(): number }; maxTimeoutMs: { get(): number } }
      } | undefined
      expect(workerShell).toBeDefined()
      expect(workerShell!.config.timeoutMs.get()).toBe(5_000)
      expect(workerShell!.config.maxTimeoutMs.get()).toBe(600_000)

      // Worker tools shadow root tools cleanly
      const shellToolName = process.platform === 'win32' ? 'pwsh' : 'bash'
      expect(ctx.tools.get(shellToolName, workerAgent as never)).toBeDefined()
      expect(ctx.tools.get(shellToolName, workerAgent as never)).not.toBe(ctx.tools.get(shellToolName))
      expect(ctx.tools.get('job_output', workerAgent as never)).toBeDefined()
      expect(ctx.tools.get('subagent', workerAgent as never)).toBeUndefined()
      expect(ctx.tools.get('workflow', workerAgent as never)).toBeUndefined()
      expect(ctx.tools.get('schedule_create', workerAgent as never)).toBeUndefined()
      expect(ctx.tools.get('goal_create', workerAgent as never)).toBeUndefined()

      // Verify tool-jobs received waitTimeoutMs: 5_000 on the mounted preset tree
      const workerJobConfig = (() => {
        const inspectTree = ctx.agentPresets.inspectCompositions(workerScope.ctx)[0]
        expect(inspectTree?.modules.some(m => m.moduleName === '@deepseek-ai/dsh-tool-jobs')).toBe(true)
        const jobsRegistry = (ctx as unknown as { jobs: { register: (...args: unknown[]) => unknown; wait: (id: string, ms: number, owner: string) => Promise<unknown>; kill: (id: string, owner: string, reason: string) => void } }).jobs
        expect(jobsRegistry).toBeDefined()
        return true
      })()
      expect(workerJobConfig).toBe(true)

      // Live foreground command >5s auto-promotes to background job at ~5s
      const command = process.platform === 'win32'
        ? 'Start-Sleep -Seconds 15; Write-Output done'
        : 'sleep 15; echo done'
      const startedAt = Date.now()
      const execResult = await ctx.tools.execute({
        agent: workerAgent as never,
        signal: new AbortController().signal,
        calls: [{
          id: 'rc5-sleep-call',
          name: shellToolName,
          arguments: JSON.stringify({ description: 'Sleep 15 seconds to test auto-promotion', command }),
        }] as never,
      })
      const elapsedMs = Date.now() - startedAt
      const callResult = execResult.results[0]?.result as { isError: boolean; value?: { kind?: string; timeoutMs?: number; jobId?: string } }
      expect(callResult).toMatchObject({
        isError: false,
        value: { kind: 'promoted', timeoutMs: 5_000 },
      })
      expect(typeof callResult.value?.jobId).toBe('string')
      expect(elapsedMs).toBeGreaterThanOrEqual(4_500)
      expect(elapsedMs).toBeLessThan(12_000)

      // Verify tool-jobs default waitTimeoutMs: 5_000 by calling job_output(wait: true) without explicit timeoutMs
      const waitStart = Date.now()
      const jobOutResult = await ctx.tools.execute({
        agent: workerAgent as never,
        signal: new AbortController().signal,
        calls: [{
          id: 'rc5-job-out',
          name: 'job_output',
          arguments: JSON.stringify({ job_id: callResult.value!.jobId, wait: true }),
        }] as never,
      })
      const waitElapsedMs = Date.now() - waitStart
      expect((jobOutResult.results[0]?.result as { isError: boolean }).isError).toBe(false)
      expect(waitElapsedMs).toBeGreaterThanOrEqual(4_500)
      expect(waitElapsedMs).toBeLessThan(9_000)

      // Kill if still running and clean up
      const jobsApi = (ctx as unknown as { jobs: { kill: (id: string, owner: string, reason: string) => void; list: (owner: string) => Array<{ id: string }> } }).jobs
      for (const job of jobsApi.list('rc5-worker-session')) {
        try { jobsApi.kill(job.id, 'rc5-worker-session', 'test-cleanup') } catch { /* already settled */ }
      }
    } finally {
      await workerScope.dispose()
      unregister()
      // Wait for unregister() to remove dot-worker cleanly
      for (let i = 0; i < 40; i++) {
        const list = await ctx.agentPresets.list()
        if (!list.some(row => row.id === WORKER_PRESET_ID)) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect((await ctx.agentPresets.list()).some(row => row.id === WORKER_PRESET_ID)).toBe(false)
      await expect(ctx.agentPresets.resolve(WORKER_PRESET_ID)).rejects.toThrow()
      await ctx.fiber.dispose()
      rmSync(workDir, { recursive: true, force: true })
    }
  }, 45_000)
})
