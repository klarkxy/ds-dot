import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { uiEn, uiZh } from '@klarkxy/dsh-deep-view/copy'
import type { HostRpcContext } from '@klarkxy/dsh-plugin-kit/host-rpc'
import { DEFAULT_SETTINGS, RPC_CHANNEL, SERVICE_NAME } from './contracts.ts'
import {
  SUPPORTED_LOCALES,
  approvalCardCopy,
  cardCopy,
  configI18n,
  copyLocale,
  intlLocale,
  isCopyLocale,
  personaPack,
  t,
} from './i18n/index.ts'
import { Config, apply as applyPlugin, inject as pluginInject } from './index.ts'
import { DEFAULT_ADDRESS, DEFAULT_PERSONA, defaultAddress, defaultPersona, personaSection } from './persona.ts'
import { PersonaPanel } from './persona-panel.tsx'
import { DOT_INSTRUCTIONS } from './prompt.ts'
import { DotService } from './service.ts'
import { patchSettings } from './settings.ts'
import { SettingsPanel } from './settings-panel.tsx'
import { DotStore, type DotDomainHandle } from './store.ts'
import { apply as applyClient, createDotCards } from './client.tsx'

function fakeDomain(seed: Record<string, Record<string, unknown>> = {}) {
  const tables: Record<string, Map<string, unknown>> = {
    state: new Map(Object.entries(seed.state ?? {})),
    tasks: new Map(Object.entries(seed.tasks ?? {})),
    tickets: new Map(Object.entries(seed.tickets ?? {})),
    schedules: new Map(Object.entries(seed.schedules ?? {})),
    recipes: new Map(Object.entries(seed.recipes ?? {})),
    recipe_proposals: new Map(Object.entries(seed.recipe_proposals ?? {})),
    proposals: new Map(Object.entries(seed.proposals ?? {})),
    changes: new Map(Object.entries(seed.changes ?? {})),
    inputs: new Map(Object.entries(seed.inputs ?? {})),
    runs: new Map(Object.entries(seed.runs ?? {})),
    verifications: new Map(Object.entries(seed.verifications ?? {})),
    peers: new Map(Object.entries(seed.peers ?? {})),
    inbox: new Map(Object.entries(seed.inbox ?? {})),
    links: new Map(Object.entries(seed.links ?? {})),
  }
  const domain: DotDomainHandle = {
    table: name => ({
      entries: () => tables[name]!.entries(),
      get: key => tables[name]!.get(key),
      put: async (key, value) => { tables[name]!.set(key, value) },
      delete: async key => tables[name]!.delete(key),
    }),
    close: async () => {},
  }
  return { domain, tables }
}

function makeFakeHost() {
  let sessions = 0
  const events = new Map<string, Array<{ type: string; time?: number; data?: unknown }>>()
  const host = {
    listWorkspaces: () => [],
    async createWorkspace(path: string, title?: string) { return { id: 'w1', path, title: title ?? path, sessionCount: 0 } },
    async listSessions() { return [] },
    async titles() { return new Map() },
    async createSession() { return `s${++sessions}` },
    async findSession() { return undefined },
    async setReadOnly() { return true },
    async setWritable() { return true },
    async verifyTaskPermission() { return true },
    async listPresets() { return { fallback: 'standard', presets: [{ id: 'standard' }] } },
    async listModels() { return { fallback: { provider: 'p', model: 'm' }, models: [] } },
    async selectModel() {},
    async setPermission() { return true },
    async prompt() {},
    async relay() {},
    async cancel() {},
    async cancelAndWait() { return true },
    async archive() {},
    async latestReply() { return undefined },
    async cwdOf() { return undefined },
    async createDot() { return `dot-${++sessions}` },
    async resumeDot() { return true },
    async releaseDot() {},
    async createInternal() { return `ref-${++sessions}` },
    async promptInternal() {},
    async waitIdle() {},
    async releaseInternal() {},
    async readEvents(id: string) { return events.get(id) ?? [] },
    async summarize() { return '' },
    modelKey: () => undefined,
    async say() {},
    async stop() {},
    async stopActivity() { return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const } },
    syncModel() {},
    dotEvents: () => [],
    dotContext: async () => ({ live: true, compactions: 0 }),
    dotTrajectory: () => ({ turns: [], earlier: 0 }),
    isRunning: () => false,
    dispose: async () => {},
  }
  return { host, events }
}

describe('i18n core & zh/en packs', () => {
  it('resolves supported locales, subtags, fallbacks, and metadata', () => {
    expect(SUPPORTED_LOCALES).toEqual(['zh', 'en', 'ja', 'de', 'es', 'fr', 'pt', 'ru'])
    expect(isCopyLocale('zh')).toBe(true)
    expect(isCopyLocale('ja')).toBe(true)
    expect(isCopyLocale('ko')).toBe(false)
    expect(copyLocale(undefined)).toBe('en')
    expect(copyLocale('   ', 'zh')).toBe('zh')
    expect(copyLocale('zh-CN')).toBe('zh')
    expect(copyLocale('zh_Hans_CN')).toBe('zh')
    expect(copyLocale('JA-jp')).toBe('ja')
    expect(copyLocale('pt_BR')).toBe('pt')
    expect(copyLocale('ko-KR')).toBe('en')
    expect(intlLocale('zh')).toBe('zh-CN')
    expect(intlLocale('en')).toBe('en-US')
    expect(t('zh', 'sTaskModelsList')).toBe('{mode}：{models}')
    expect(t('en', 'sTaskModelsList')).toBe('{mode}: {models}')
    expect(t('zh', 'sTaskModelsNone')).toBe('{mode}（{empty}）')
    expect(t('en', 'sTaskModelsNone')).toBe('{mode} ({empty})')
    expect(cardCopy('en')).toEqual(uiEn)
    expect(Object.keys(configI18n())).toEqual([...SUPPORTED_LOCALES])
    expect(approvalCardCopy('zh').title).toBe('审批')
    expect(approvalCardCopy('en').title).toBe('Approval')
    const zhMeta = JSON.parse(readFileSync(join(process.cwd(), 'locale/zh.json'), 'utf8')) as { meta: { detail?: string } }
    expect(zhMeta.meta.detail).toBe('docs/README.zh-CN.md')
    expect(DOT_INSTRUCTIONS).toContain('when the human has not written in this exchange (a reminder or a routine check), use the language of your persona section')
    expect(Config).toBeDefined()
    expect(pluginInject).not.toContain('settings')
  })

  it('keeps zh persona defaults verbatim and enforces en persona constraints', () => {
    expect(defaultAddress('zh')).toBe(DEFAULT_ADDRESS)
    expect(defaultPersona('zh')).toBe(DEFAULT_PERSONA)
    const enPersona = defaultPersona('en')
    expect(defaultAddress('en')).toBe('you')
    expect(enPersona.length).toBeLessThanOrEqual(1200)
    for (const heading of [
      '[Personality and what matters to you]',
      '[How you speak]',
      '[Your relationship with the user]',
    ]) expect(enPersona).toContain(heading)
    // sectionLead already introduces the persona, so the body opens without a heading.
    expect(enPersona.startsWith('[')).toBe(false)
    expect(enPersona).toContain('lead with the outcome.')
    expect(enPersona).not.toMatch(/姐姐|妹妹|鲸鱼娘|大肥鱼|粉色虎鲸|粉毛小狗|大小姐|sister|At work|Off duty|the human/i)
    expect(personaPack('en').sectionLead).toBe('Who you are:')
    expect(personaSection({}, 'en')).toContain('Who you are:')
    expect(personaSection({}, 'en')).toContain('"you"')
    expect(personaSection({ address: 'Boss' }, 'en')).toContain('"Boss"')

    const custom = patchSettings(DEFAULT_SETTINGS, { persona: 'Custom', address: 'Boss' }, 'en')
    const reset = patchSettings(custom, { persona: enPersona, address: 'you' }, 'en')
    expect(reset.persona).toBeUndefined()
    expect(reset.address).toBeUndefined()
  })
})

describe('DotStore & DotService locale persistence and sync', () => {
  it('stores uiLocale durably without polluting DotSettings and clears on factoryReset', async () => {
    const { domain, tables } = fakeDomain()
    const store = new DotStore(domain)
    expect(store.uiLocale).toBeUndefined()
    await store.setUiLocale('en')
    expect(store.uiLocale).toBe('en')
    expect(store.settings).toEqual(DEFAULT_SETTINGS)
    await store.setSettings({ ...DEFAULT_SETTINGS, scope: 'all' })
    expect((tables.state!.get('current') as { settings: Record<string, unknown> }).settings.uiLocale).toBe('en')
    const reloaded = new DotStore(domain)
    expect(reloaded.uiLocale).toBe('en')
    expect(reloaded.settings.scope).toBe('all')
    await reloaded.factoryReset(123)
    expect(reloaded.uiLocale).toBeUndefined()
  })

  it('syncs locale, refreezes only unreplied segments, localizes approval cards, and preserves locale across factory reset', async () => {
    const { domain } = fakeDomain()
    const store = new DotStore(domain)
    const { host, events } = makeFakeHost()
    const service = new DotService({
      host: host as never,
      store,
      homeDir: join(tmpdir(), `dot-locale-sync-${Date.now()}`),
      notes: { path: 'memory.md', read: async () => '', readCognition: async () => '' },
    })
    try {
      expect(service.locale).toBe('zh')
      const dotId = await service.ensureDot()
      expect(store.segment?.persona).toContain('你是谁：')

      // Unreplied segment refreezes on syncLocale.
      expect(await service.syncLocale('en-US')).toBe('en')
      expect(service.locale).toBe('en')
      expect(store.uiLocale).toBe('en')
      expect(store.segment?.persona).toContain('Who you are:')

      // Empty sync is a no-op.
      expect(await service.syncLocale('   ')).toBe('en')

      // Approval card uses active locale.
      await store.setSettings({ ...store.settings, scope: 'all' })
      const routed = service.relayRequest({ kind: 'approval', sessionId: 'task-1', subject: 'bash' })
      if (routed.decided !== 'pending') throw new Error('expected pending')
      const card = await service.presentCard({ title: '', interactive: true, view: { type: 'confirm', id: 'x' } }, 'call-1', routed.id)
      expect(card.title).toBe('Approval')
      routed.withdraw()

      // Replied segment does NOT refreeze on locale change.
      events.set(dotId, [{ type: 'assistant/message', time: 100 }])
      expect(await service.syncLocale('zh-CN')).toBe('zh')
      expect(store.segment?.persona).toContain('Who you are:')

      // ContextView refreezes unreplied segments when persona disagrees.
      const { domain: d2 } = fakeDomain()
      const s2 = new DotStore(d2)
      const h2 = makeFakeHost()
      const svc2 = new DotService({
        host: h2.host as never,
        store: s2,
        homeDir: join(tmpdir(), `dot-ctx-refreeze-${Date.now()}`),
        notes: { path: 'memory.md', read: async () => '', readCognition: async () => '' },
        locale: 'zh',
      })
      await svc2.ensureDot()
      expect(s2.segment?.persona).toContain('你是谁：')
      await svc2.syncLocale('en')
      const ctxView = await svc2.contextView()
      expect(ctxView.sections?.persona).toContain('Who you are:')

      // Factory reset preserves active locale across wipe and new segment creation.
      const token = svc2.previewFactoryReset().token
      await svc2.confirmFactoryReset(token)
      expect(svc2.locale).toBe('en')
      expect(s2.uiLocale).toBe('en')
      expect(s2.segment?.persona).toContain('Who you are:')
      await svc2.dispose()
    } finally {
      await service.dispose()
    }
  })
})

describe('Host plugin locale wiring & RPC', () => {
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
  })

  function postRpc(url: string, method: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const body = JSON.stringify({ type: 'client-request', rpcId: '00000000-0000-4000-8000-000000000000', method, payload })
    return new Promise((resolve, reject) => {
      const req = httpRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> })
        })
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  it('reads optional host settings locale, responds to settings/document-updated, and handles locale.sync + uiLocale RPC', async () => {
    const { domain } = fakeDomain()
    let preference = 'en-US'
    const eventListeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const disposers: Array<() => void | Promise<void>> = []
    let rpcHandler: Parameters<HostRpcContext['webServer']['register']>[0]['handler'] | undefined
    let providedService: DotService | undefined

    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      storageDomain: { open: async () => domain },
      sessionQuery: { readSession: async () => ({ events: [] }) },
      sessions: { list: async () => [] },
      sessionController: {},
      workspaceRegistry: { list: () => [] },
      agentPresets: { register: async () => async () => {}, list: () => [] },
      agents: { get: () => undefined },
      agentDefaultModel: { get: () => undefined },
      connection: { requestRejection: () => undefined },
      webServer: { register: (route: { handler: typeof rpcHandler }) => { rpcHandler = route.handler; return () => {} } },
      settings: {
        describe: () => [{ ns: 'locale', value: { preference } }],
      },
      get: (name: string) => name === 'settings' ? ctx.settings : (ctx as Record<string, unknown>)[name],
      provide: (key: string, value: unknown) => { if (key === SERVICE_NAME) providedService = value as DotService },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        const list = eventListeners.get(event) ?? []
        list.push(listener)
        eventListeners.set(event, list)
        return () => {}
      },
      effect: (fn: () => (() => void | Promise<void>) | void) => {
        const stop = fn()
        if (typeof stop === 'function') disposers.push(stop)
      },
    }

    await applyPlugin(ctx as never, { homeDir: join(tmpdir(), `dot-idx-${Date.now()}`) })
    expect(providedService?.locale).toBe('en')
    expect(rpcHandler).toBeDefined()

    // Host settings/document-updated for ns === 'locale' syncs the updated preference.
    preference = 'zh-CN'
    for (const listener of eventListeners.get('settings/document-updated') ?? []) listener('locale', 2)
    await Promise.resolve()
    expect(providedService?.locale).toBe('zh')

    const server = createServer((req, res) => { void rpcHandler!(req, res) })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('No address')
    const base = `http://127.0.0.1:${addr.port}${RPC_CHANNEL}`

    // locale.sync RPC updates service locale.
    const syncReply = await postRpc(`${base}/locale.sync`, 'locale.sync', { locale: 'en-US' })
    expect(syncReply.status).toBe(200)
    expect((syncReply.body.result as { ok: boolean; value: unknown })).toEqual({ ok: true, value: 'en' })
    expect(providedService?.locale).toBe('en')

    // settings.set honors service.locale when stripping default persona/address; uiLocale on payload pre-syncs before handler.
    const setCustom = await postRpc(`${base}/settings.set`, 'settings.set', {
      uiLocale: 'en-US',
      patch: { persona: defaultPersona('en'), address: 'you' },
    })
    expect((setCustom.body.result as { ok: boolean; value: Record<string, unknown> }).value.persona).toBeUndefined()
    expect((setCustom.body.result as { ok: boolean; value: Record<string, unknown> }).value.address).toBeUndefined()

    for (const stop of disposers.reverse()) await stop()
  })

  it('refuses dot-local names that clash with global servers and keeps credential.set stored-only', async () => {
    const { domain } = fakeDomain()
    const disposers: Array<() => void | Promise<void>> = []
    let rpcHandler: Parameters<HostRpcContext['webServer']['register']>[0]['handler'] | undefined

    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      storageDomain: { open: async () => domain },
      sessionQuery: { readSession: async () => ({ events: [] }) },
      sessions: { list: async () => [] },
      sessionController: {},
      workspaceRegistry: { list: () => [] },
      agentPresets: { register: async () => async () => {}, list: () => [] },
      agents: { get: () => undefined },
      agentDefaultModel: { get: () => undefined },
      connection: { requestRejection: () => undefined },
      webServer: { register: (route: { handler: typeof rpcHandler }) => { rpcHandler = route.handler; return () => {} } },
      settings: { describe: () => [] },
      mcpManager: { list: () => [{ name: 'github' }] },
      tools: { definitions: () => [{ name: 'mcp__exa__search' }], get: () => undefined, executable: () => undefined },
      get: (name: string) => (ctx as Record<string, unknown>)[name],
      provide: () => {},
      on: () => () => {},
      effect: (fn: () => (() => void | Promise<void>) | void) => {
        const stop = fn()
        if (typeof stop === 'function') disposers.push(stop)
      },
    }

    await applyPlugin(ctx as never, { homeDir: join(tmpdir(), `dot-idx-${Date.now()}-mcpguard`) })
    const server = createServer((req, res) => { void rpcHandler!(req, res) })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('No address')
    const base = `http://127.0.0.1:${addr.port}${RPC_CHANNEL}`
    const result = (reply: { body: Record<string, unknown> }) => reply.body.result as { ok: boolean; error?: { code: string } }

    // A manager-listed global name is refused.
    const clash = await postRpc(`${base}/settings.set`, 'settings.set', {
      patch: { mcpServers: { github: { url: 'https://api.githubcopilot.com/mcp/readonly', enabled: true } } },
    })
    expect(result(clash)).toMatchObject({ ok: false, error: { code: 'dot/mcp-global-conflict' } })
    // So is a name guessed from a root mcp__x__ tool.
    const guessed = await postRpc(`${base}/settings.set`, 'settings.set', {
      patch: { mcpServers: { exa: { url: 'https://mcp.exa.ai/mcp', enabled: true } } },
    })
    expect(result(guessed)).toMatchObject({ ok: false, error: { code: 'dot/mcp-global-conflict' } })
    // A free name saves fine.
    const okSet = await postRpc(`${base}/settings.set`, 'settings.set', {
      patch: { mcpServers: { deepwiki: { url: 'https://mcp.deepwiki.com/mcp', enabled: true } } },
    })
    expect(result(okSet).ok).toBe(true)
    // credential.set takes stored names only: a catalog id with no row fails.
    const catalogOnly = await postRpc(`${base}/mcp.credential.set`, 'mcp.credential.set', { server: 'context7', value: 'x' })
    expect(result(catalogOnly)).toMatchObject({ ok: false, error: { code: 'dot/mcp-bad-server' } })
    // The stored name passes validation; without a credentials service the
    // host reports the service as unavailable, not a bad argument.
    const stored = await postRpc(`${base}/mcp.credential.set`, 'mcp.credential.set', { server: 'deepwiki', value: 'x' })
    expect(result(stored)).toMatchObject({ ok: false, error: { code: 'dot/mcp-unavailable' } })

    for (const stop of disposers.reverse()) await stop()
  })
})

describe('UI locale wiring & client RPC sync', () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
  let createRoot: typeof import('react-dom/client').createRoot

  beforeAll(async () => {
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('navigator', dom.window.navigator)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    createRoot = (await import('react-dom/client')).createRoot
  })

  afterEach(() => { document.body.innerHTML = '<div id="root"></div>' })

  it('renders English default persona/address in PersonaPanel, English taskModels proposal in SettingsPanel, and card copy in card-client', async () => {
    const api = {
      models: async () => ({ groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }] }),
      settings: async () => DEFAULT_SETTINGS,
      setSettings: async () => DEFAULT_SETTINGS,
      settingProposals: async () => [{
        id: 'p-1',
        field: 'taskModels' as const,
        before: { mode: 'all', list: [] },
        after: { mode: 'allow', list: ['deepseek/deepseek-chat'] },
        reason: 'limit models',
        createdAt: 1,
      }],
      decideSetting: async () => 'ok',
      knowledge: async () => ({
        agreements: { text: '', maxChars: 4000, canUndo: false },
        cognition: { text: '', maxChars: 4000, history: [] },
      }),
      setAgreements: async () => ({ agreements: { text: '', maxChars: 4000, canUndo: false }, cognition: { text: '', maxChars: 4000, history: [] } }),
      undoAgreements: async () => ({ agreements: { text: '', maxChars: 4000, canUndo: false }, cognition: { text: '', maxChars: 4000, history: [] } }),
      setCognition: async () => ({ agreements: { text: '', maxChars: 4000, canUndo: false }, cognition: { text: '', maxChars: 4000, history: [] } }),
      restoreCognition: async () => ({ agreements: { text: '', maxChars: 4000, canUndo: false }, cognition: { text: '', maxChars: 4000, history: [] } }),
    }
    const { Card } = createDotCards(async () => null, {
      getSnapshot: () => ({ active: 'zh-CN' }),
      subscribe: () => () => {},
    })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(
      <>
        <PersonaPanel locale="en" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />
        <SettingsPanel locale="en" api={api as never} settings={DEFAULT_SETTINGS} onSaved={() => {}} />
        <Card sessionId="s" callId="c" failed title="bad" view={{ type: 'text', text: 'x' }} />
      </>,
    ))
    await act(async () => { await Promise.resolve() })
    const addrInput = document.querySelector<HTMLInputElement>('input[aria-label="How she addresses you"]')!
    expect(addrInput.value).toBe('you')
    expect(addrInput.placeholder).toBe('you')
    const personaBox = [...document.querySelectorAll('textarea')].find(el => el.getAttribute('aria-label') === 'Voice & personality')!
    expect(personaBox).toBeDefined()
    expect(personaBox.value).toBe(defaultPersona('en'))
    expect(document.body.textContent).toContain('Allow selected: DeepSeek / DeepSeek Chat')
    expect(document.body.textContent).toContain(uiZh.invalid)
    await act(async () => root.unmount())
  })

  it('attaches uiLocale on client RPC calls and syncs on locale store updates', async () => {
    let active = 'en-US'
    const listeners = new Set<() => void>()
    const rpcCalls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
    let registeredMain: ((props: Record<string, unknown>) => unknown) | undefined
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
      effect: (fn: () => (() => void) | void) => { fn() },
      locale: {
        getSnapshot: () => ({ active }),
        subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
      },
      slots: {
        inject: (_key: string, cb: () => (() => void) | void) => { cb(); return () => {} },
        register: (spec: { name?: string }, render: (props: Record<string, unknown>) => unknown) => {
          if (spec.name === 'main') registeredMain = render
          return () => {}
        },
      },
      connection: {
        rpc: {
          call: async (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
            rpcCalls.push({ channel, endpoint, payload })
            if (endpoint === 'chat') return { ok: true, value: { sessionId: 'dot-1', running: false, streaming: '', rev: 1, itemsRev: 1, items: [] } }
            if (endpoint === 'wait') return new Promise(resolve => { signal?.addEventListener('abort', () => resolve({ ok: true, value: undefined }), { once: true }) })
            if (endpoint === 'board') return { ok: true, value: { tasks: [], tickets: [], pending: [], schedules: [] } }
            if (endpoint === 'settings') return { ok: true, value: DEFAULT_SETTINGS }
            if (endpoint === 'settings.proposals') return { ok: true, value: [] }
            return { ok: true, value: 'ok' }
          },
        },
      },
    }
    applyClient(ctx as never)
    expect(registeredMain).toBeDefined()

    // Mount DotPage briefly so initial RPC calls fire with uiLocale attached.
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(registeredMain!({}) as never))
    await act(async () => { await Promise.resolve() })
    expect(rpcCalls.some(c => c.endpoint === 'chat' && (c.payload as Record<string, unknown>).uiLocale === 'en-US')).toBe(true)
    await act(async () => root.unmount())

    // Trigger locale subscription change.
    active = 'zh-CN'
    for (const listener of listeners) listener()
    await Promise.resolve()
    expect(rpcCalls).toContainEqual({
      channel: RPC_CHANNEL,
      endpoint: 'locale.sync',
      payload: { locale: 'zh-CN', uiLocale: 'zh-CN' },
    })
  })
})
