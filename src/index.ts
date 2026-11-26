/**
 * dsh-dot: an always-on coordinator. The entry provides the `dot` service,
 * registers the dot preset (persona + dot's own tools, no file or shell tools,
 * compaction as a fallback), keeps dot's own sessions out of the sidebar and
 * serves their chat to the plugin's panel, feeds host events into the ledger,
 * moves dot's conversation to a new session segment when one is due, starts
 * the clock of dot's own reminders, and routes the approvals and questions of
 * other top-level sessions to dot first.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import Schema from '@deepseek-ai/schemastery'
import { isSubagentSession } from '@klarkxy/dsh-plugin-kit/contracts'
import { openCompatibleDomain } from '@klarkxy/dsh-plugin-kit/domain'
import { registerHostRpc, type HostRpcContext } from '@klarkxy/dsh-plugin-kit/host-rpc'
import { installPluginLogger } from '@klarkxy/dsh-plugin-kit/logger'
import { approvalAuditId, raceApproval } from './approval-relay.ts'
import type { RawEvent } from './chat.ts'
import { COGNITION_PROMPT_ENTRIES_DEFAULT, COMPACTION_POLICY, dotOwnedCredentialRefs, mcpCredentialName, mcpGuess, mcpServerOf, MCP_CREDENTIAL_VALUE_MAX, MCP_SERVER_NAME_PATTERN, PLUGIN_NAME, PRESET_ID, RPC_CHANNEL, SERVICE_NAME, validateMcpCredentialSet, type ChatSnapshot, type PendingQuestionItem, type TaskPermission, type TaskRecord } from './contracts.ts'
import { CHAT_SAY_BODY_BYTES, checkChatImages } from './chat-images.ts'
import { ChatFeed } from './feed.ts'
import { hostImport } from './host-import.ts'
import { DotCapabilities, type CapabilityPluginManager, type CapabilityTools } from './capabilities.ts'
import { bindHost } from './host.ts'
import { InboxLedger } from './inbox.ts'
import { installInboxIngress } from './inbox-github.ts'
import { clip } from './ledger.ts'
import { sharedDotMcp } from './mcp-shared.ts'
import { detachNative } from './native.ts'
import { PeerLedger } from './peer.ts'
import { DOT_INSTRUCTIONS } from './prompt.ts'
import { installInternalPresetCreateGuard, installPresetVisibility, publicTaskPreset } from './preset-visibility.ts'
import { shouldDeferApprovalToSafeAuto } from './approval-safe-auto.ts'
import { REFLECTION_INSTRUCTIONS, REFLECTION_PRESET_ID } from './reflection.ts'
import { KnowledgeError, parseKnowledgeEdit } from './memory.ts'
import { APPROVAL_GRACE_MS, DotError, DotService, messageOf } from './service.ts'
import { detectSelfInstall } from './self-root.ts'
import { configI18n } from './i18n/index.ts'
import { patchSettings } from './settings.ts'
import { dotDomain, parseInboxRecord, parsePeerDelivery, parseTask } from './storage.ts'
import { DotStore, type DotDomainHandle } from './store.ts'
import { DOT_INHERITED_ALLOW } from './tools.ts'
import { copyLocale, fillText, t } from './ui-copy.ts'
import { WATCHDOG_INSTRUCTIONS, WATCHDOG_PRESET_ID } from './watchdog.ts'
import { registerWorkerPreset } from './worker-preset.ts'

export const name = PLUGIN_NAME
export const inject = ['storageDomain', 'sessions', 'sessionController', 'workspaceRegistry', 'sessionQuery', 'agentPresets', 'agents', 'agentDefaultModel', 'webServer', 'connection'] as const
export { DotService } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { [SERVICE_NAME]: DotService }
}

/** A long-poll answers after this long without changes; the client asks again. */
const WAIT_MS = 15_000
/** A finished turn is read this long after it stops, once its boundary has committed. */
const TURN_SETTLE_MS = 300
/** The previous plugin instance's disposal, so a reload cannot open the domain twice. */
let retiring: Promise<void> | undefined
/** Events scanned back for the tool call an approval is about. */
const CALL_SCAN = 400

/** Conversation settings stay in Dorothy's panel; delivery timing is profile configuration. */
export interface Config {
  homeDir?: string
  approvalGraceMs?: number
  cognitionPromptEntries?: number
}

export const Config: Schema<Config> = Schema.object({
  homeDir: Schema.string().default(''),
  approvalGraceMs: Schema.number().min(0).max(60_000).default(APPROVAL_GRACE_MS),
  cognitionPromptEntries: Schema.natural().default(COGNITION_PROMPT_ENTRIES_DEFAULT),
}).i18n(configI18n())

interface SessionLike {
  readonly id?: string
  readonly header?: { readonly parentSession?: string; readonly cwd?: string; readonly origin?: string }
  readonly seq?: number
  eventAt?(seq: number): RawEvent | undefined
  snapshotEvents?(): readonly RawEvent[]
}
interface AgentLike { readonly id?: string; readonly status?: string; readonly session?: SessionLike }

/** Tell Dorothy, in the chat, why a review was rejected. The decision is already committed, so the
 *  note is best effort: it must never fail the RPC or hold its acknowledgment while the chat queues. */
function notifyRejected(service: DotService, title: string, note: string): void {
  try {
    const msg = fillText(t(copyLocale(service.locale), 'workRejectPrefix'), { title, note })
    void service.say(msg.slice(0, 4_000)).catch(() => undefined)
  } catch { /* a missing note is not a failed decision */ }
}

/** Ledger events come from top-level sessions only; subagents report to their parent session. */
function sessionIdOf(agent: AgentLike | undefined): string | undefined {
  const session = agent?.session
  if (!session?.id || isSubagentSession(session)) return undefined
  return session.id
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (retiring) await retiring.catch(() => undefined)
  const logger = installPluginLogger(ctx, PLUGIN_NAME, { forwardHostWarnError: false })
  const log = (message: string) => {
    try { ctx.logger?.info?.(message) } catch { /* host logger is optional */ }
    logger.info('dot.runtime', message)
  }
  const domain = await openCompatibleDomain(
    spec => (ctx.storageDomain as unknown as { open(s: typeof spec): Promise<DotDomainHandle> }).open(spec),
    dotDomain,
    { logger, domainName: 'dsh_dot' },
  )
  const store = new DotStore(domain, [...domain.table('tasks').entries()].map(([, value]) => parseTask(value)).filter((task): task is TaskRecord => task !== undefined))
  let sealOwned: ((agent: unknown) => void) | undefined
  const safeAgentPresets = (): Context['agentPresets'] | undefined => {
    try { return ctx.agentPresets }
    catch { return undefined }
  }
  const invokePresetDispose = (dispose: (() => Promise<void>) | undefined) => {
    if (typeof dispose !== 'function') return
    try {
      void Promise.resolve(dispose()).catch(() => {})
    } catch { /* preset disposal is best-effort */ }
  }
  const safeWarn = (template: string, error: unknown) => {
    try { ctx.logger?.warn?.(template, messageOf(error)) } catch { /* host logger is optional */ }
  }
  /** Tool definitions published on dot's preset scope (the ds-dot/mcp mounts). */
  const presetScopeDefs = async (): Promise<readonly { readonly name: string; readonly description?: string }[]> => {
    try {
      const presets = safeAgentPresets() as {
        acquireScope?(id: string): Promise<{ key: unknown } & { [Symbol.asyncDispose](): Promise<void> }>
      } | undefined
      const toolsService = ctx.get('tools' as never) as
        | (CapabilityTools & { definitions?(key?: unknown): readonly { readonly name: string; readonly description?: string }[] })
        | undefined
      const acquireScope = presets?.acquireScope
      if (typeof acquireScope !== 'function') return []
      const handle = await acquireScope.call(presets, PRESET_ID)
      if (handle === undefined) return []
      try {
        const definitions = toolsService?.definitions
        return typeof definitions === 'function' ? definitions.call(toolsService, handle.key) : []
      } finally {
        await handle[Symbol.asyncDispose]?.()
      }
    } catch {
      return []
    }
  }
  /** Global MCP server names: manager rows plus names guessed from root `mcp__x__y` tools. */
  const globalMcpNames = (): ReadonlySet<string> => {
    const names = new Set<string>()
    try {
      const manager = ctx.get('mcpManager' as never) as { list(): readonly { readonly name: string }[] } | undefined
      for (const row of manager?.list() ?? []) names.add(row.name)
    } catch { /* optional host service */ }
    try {
      const tools = ctx.get('tools' as never) as { definitions?(): readonly { readonly name: string }[] } | undefined
      for (const def of tools?.definitions?.() ?? []) {
        const guess = mcpGuess(def.name)
        if (guess !== undefined) names.add(guess)
      }
    } catch { /* optional host service */ }
    return names
  }
  const capabilities = new DotCapabilities({
    tools: () => ctx.get('tools' as never) as CapabilityTools | undefined,
    mcpManager: () => ctx.get('mcpManager' as never) as { list(): readonly { readonly name: string }[] } | undefined,
    pluginManager: () => ctx.get('pluginManager' as never) as CapabilityPluginManager | undefined,
    settings: () => store.settings,
    locked: DOT_INHERITED_ALLOW,
    presetDefs: presetScopeDefs,
  })
  capabilities.prewarm()
  // Host credentials service: dot-local MCP tokens are stored and read here;
  // `ctx.credentials` is inject-gated, so go through ctx.get like mcp-client.
  interface CredentialsService {
    describe?(ref: unknown): Promise<{ readonly configured: boolean; readonly masked?: string } | undefined>
    set?(ref: unknown, value: string): Promise<unknown>
    unset?(ref: unknown): Promise<unknown>
  }
  const credentialsService = () => ctx.get('credentials' as never) as CredentialsService | undefined
  let credentialsModule: Promise<{ credentialRef(name: string): unknown }> | undefined
  const credentialRefFor = async (name: string) => {
    credentialsModule ??= hostImport(ctx, '@deepseek-ai/dsh-credentials') as Promise<{ credentialRef(name: string): unknown }>
    return (await credentialsModule).credentialRef(name)
  }
  const host = bindHost(name => ctx.get(name as never), log, () => store.settings.model, agent => { sealOwned?.(agent) }, capabilities)
  const service = new DotService({
    host,
    get: name => ctx.get(name as never),
    store,
    capabilities,
    peers: new PeerLedger(domain.table('peers'), parsePeerDelivery),
    inbox: new InboxLedger(domain.table('inbox'), parseInboxRecord),
    homeDir: config.homeDir?.trim() || join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'dot'),
    log,
    trace: logger,
    approvalGraceMs: Number.isFinite(config.approvalGraceMs) ? Math.max(0, Math.min(60_000, config.approvalGraceMs!)) : APPROVAL_GRACE_MS,
    cognitionPromptEntries: Number.isFinite(config.cognitionPromptEntries) ? Math.max(0, Math.trunc(config.cognitionPromptEntries!)) : COGNITION_PROMPT_ENTRIES_DEFAULT,
    pluginManager: () => ctx.get('pluginManager' as never),
    selfInstall: detectSelfInstall(),
    globalMcpNames,
    credentials: {
      describe: async (ref: string) => credentialsService()?.describe?.(await credentialRefFor(ref)),
      unset: async (ref: string) => credentialsService()?.unset?.(await credentialRefFor(ref)),
    },
  })
  // The ds-dot/mcp preset row reads settings and reports tool-set changes
  // through the globalThis channel; a changed set re-applies the live agent's
  // restrict so a granted server's late tools become visible at once.
  const mcpShared = sharedDotMcp()
  mcpShared.settings = () => store.settings
  // The preset layer's dot-local tool names, longest-prefix attributed: a
  // same-count tool swap still changes the row's change signature.
  mcpShared.presetToolNames = async () => {
    const dotServers = store.settings.mcpServers ?? {}
    const enabled = Object.keys(dotServers).filter(name => dotServers[name]?.enabled !== false)
    if (enabled.length === 0) return []
    const all = [...globalMcpNames(), ...enabled]
    return (await presetScopeDefs())
      .map(def => def.name)
      .filter(name => { const owner = mcpServerOf(name, all); return owner !== undefined && enabled.includes(owner) })
  }
  mcpShared.onToolsChanged = () => {
    const dot = store.dotSessionId
    if (dot !== undefined) void host.reapplyCapabilities?.(dot)
  }
  sealOwned = agent => service.sealAgent(agent)
  void service.sealExisting()
  const syncHostLocale = () => {
    try {
      const forms = ctx.get('settings' as never) as { describe?(): readonly { readonly ns?: unknown; readonly value?: unknown }[] } | undefined
      const entry = forms?.describe?.()?.find(row => String(row?.ns) === 'locale')
      const pref = entry?.value && typeof entry.value === 'object' ? (entry.value as { preference?: unknown }).preference : undefined
      if (typeof pref === 'string' && pref.trim()) void service.syncLocale(pref).catch(() => {})
    } catch { /* optional host settings reader */ }
  }
  syncHostLocale()
  ctx.effect(() => (ctx as unknown as { on(name: string, listener: (ns: unknown) => void): () => void }).on('settings/document-updated', ns => {
    if (String(ns) === 'locale') syncHostLocale()
  }), 'dot.locale-settings')
  const feed = new ChatFeed(host, store)
  // The chat follows dot into every new segment and keeps the earlier ones above it.
  const follow = () => {
    if (store.dotSessionId) feed.attach(store.dotSessionId, store.pastSegments)
    feed.boardChanged()
    feed.cardsChanged()
  }
  follow()
  const unfollow = store.onChange(follow)
  const unpending = service.pending.onChange(() => feed.boardChanged())
  const unretry = service.onRetryChange(() => feed.boardChanged())
  const unjobs = service.onBackgroundJobsChange(() => feed.boardChanged())
  const ensureDot = async () => {
    const sessionId = await service.ensureDot()
    follow()
    return sessionId
  }
  ctx.provide(SERVICE_NAME, service)
  // Wrap tools.register so every extra tool records the loader entry that
  // registered it; the catalog uses that for plugin attribution.
  ctx.effect(() => capabilities.installAttribution(), 'dot.capabilities-attribution')
  // A tool set change can mean a bundle came or went; refetch row mapping on the next catalog read.
  ctx.effect(() => (ctx as unknown as { on(name: string, listener: () => void): () => void }).on('tools/change', () => capabilities.invalidateBundles()), 'dot.capabilities-bundles')
  // Optional webhook ingress: only while the host provides webhookRuntime.
  installInboxIngress(ctx, service, log, {
    shouldAccept: (repo, receivedAt) => service.shouldAcceptWebhookDelivery(repo, receivedAt),
  })
  service.startGithubPoll()
  service.startWatchdog()
  ctx.effect(() => () => {
    unfollow()
    unpending()
    unretry()
    unjobs()
    const done = (async () => {
      service.releaseChildSeals()
      await service.dispose().catch(err => { logger.fault('service.dispose-failed', 'DotService disposal failed.', err) })
      feed.dispose()
      await host.dispose().catch(err => { logger.fault('host.dispose-failed', 'DotHost disposal failed.', err) })
      await store.flush()
      await domain.close()
    })()
    retiring = done
    return done.finally(() => { if (retiring === done) retiring = undefined })
  }, 'dot.lifecycle')

  ctx.effect(() => {
    const presets = safeAgentPresets()
    let release: (() => void) = () => {}
    try {
      release = installPresetVisibility(presets, ctx)
    } catch {
      return () => {}
    }
    // Warm the public-default cache so `@deepseek-ai/dsh-tool-schedule` can
    // rewrite `composedPreset` before the first roster read.
    if (presets) {
      try {
        const remoteExportList = (presets as { remoteExportList?: () => Promise<unknown> }).remoteExportList
        const list = presets.list
        const warm = typeof remoteExportList === 'function'
          ? remoteExportList.call(presets)
          : typeof list === 'function'
            ? list.call(presets)
            : undefined
        void Promise.resolve(warm).catch(() => {})
      } catch { /* cache warmup is best-effort */ }
    }
    return () => {
      try { release() } catch { /* visibility disposal is best-effort */ }
    }
  }, 'dot.preset-visibility')
  ctx.effect(() => {
    let release: (() => void) = () => {}
    try {
      release = installInternalPresetCreateGuard(ctx.get('sessionController' as never), () => publicTaskPreset(safeAgentPresets()))
    } catch {
      return () => {}
    }
    return () => {
      try { release() } catch { /* create-guard disposal is best-effort */ }
    }
  }, 'dot.public-session-create')

  // The dot preset: conversation, dot's tools, and in-place compaction for the
  // one turn that outgrows the window before a segment change. Choices go through
  // deep-view's show_view cards, which every session gets when it is installed.
  ctx.effect(() => {
    const presets = safeAgentPresets()
    let release: (() => Promise<void>) | undefined
    let disposed = false
    const onFailed = (error: unknown) => {
      logger.error('preset.register-failed', 'Failed to register Dorothy preset.', error, { presetId: PRESET_ID })
      safeWarn('dsh-dot: preset registration failed: %s', error)
    }
    try {
      const register = presets?.register
      if (typeof register !== 'function') return () => {}
      void Promise.resolve(register.call(presets, {
        id: PRESET_ID,
        name: 'Dorothy',
        description: 'Dorothy (dot): coordinates workspaces and task sessions, settles routine requests, and reports back; carries no file or shell tools.',
        order: 90,
        plugins: [
          { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: DOT_INSTRUCTIONS } },
          { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
          {
            id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true },
            config: [
              // Spelled out so the context page draws the compaction line from the same numbers.
              { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { ...COMPACTION_POLICY } },
              { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
            ],
          },
          { id: 'dot-tools', name: 'ds-dot/tools' },
          // Dot-local MCP servers, mounted on the preset scope from settings.
          { id: 'dot-mcp', name: 'ds-dot/mcp' },
          // Global-nature host built-ins, grantable through Extra capabilities;
          // the agent-scope restrict masks them until granted.
          { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
          { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
          { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: { __jsExpr: "!ctx.get('profileContext')" } },
        ] as never,
      })).then((dispose: () => Promise<void>) => {
        if (disposed) { invokePresetDispose(dispose); return }
        release = dispose
        logger.debug('preset.registered', 'Registered Dorothy preset.', { presetId: PRESET_ID })
        // Reminders wake dot's session, which only opens once its preset exists.
        service.startReminders()
      }, onFailed)
    } catch (error: unknown) {
      onFailed(error)
    }
    return () => {
      disposed = true
      const current = release
      release = undefined
      invokePresetDispose(current)
    }
  }, 'dot.preset')

  // The internal reflection preset: a hidden subagent session mounts only the
  // read-only history tools and the cognition submission tool (never the
  // agreements tool). It is filtered out of the task preset roster in host.ts.
  ctx.effect(() => {
    const presets = safeAgentPresets()
    let release: (() => Promise<void>) | undefined
    let disposed = false
    const onFailed = (error: unknown) => {
      logger.error('preset.register-failed', 'Failed to register Dot reflection preset.', error, { presetId: REFLECTION_PRESET_ID })
      safeWarn('dsh-dot: reflection preset registration failed: %s', error)
    }
    try {
      const register = presets?.register
      if (typeof register !== 'function') return () => {}
      void Promise.resolve(register.call(presets, {
        id: REFLECTION_PRESET_ID,
        name: 'Dot reflection',
        description: 'Internal background reflection pass that updates Dorothy’s cognition; never used for tasks.',
        order: 91,
        plugins: [
          { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: REFLECTION_INSTRUCTIONS } },
          { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
          { id: 'dot-reflection-tools', name: 'ds-dot/reflection' },
        ] as never,
      })).then((dispose: () => Promise<void>) => {
        if (disposed) { invokePresetDispose(dispose); return }
        release = dispose
        logger.debug('preset.registered', 'Registered Dot reflection preset.', { presetId: REFLECTION_PRESET_ID })
      }, onFailed)
    } catch (error: unknown) {
      onFailed(error)
    }
    return () => {
      disposed = true
      const current = release
      release = undefined
      invokePresetDispose(current)
    }
  }, 'dot.reflection-preset')

  ctx.effect(() => registerWorkerPreset(ctx, logger), 'dot.worker-preset')

  // The internal read-only watchdog judge preset: zero file/shell/task tools.
  ctx.effect(() => {
    const presets = safeAgentPresets()
    let release: (() => Promise<void>) | undefined
    let disposed = false
    const onFailed = (error: unknown) => {
      logger.error('preset.register-failed', 'Failed to register Dot watchdog preset.', error, { presetId: WATCHDOG_PRESET_ID })
      safeWarn('dsh-dot: watchdog preset registration failed: %s', error)
    }
    try {
      const register = presets?.register
      if (typeof register !== 'function') return () => {}
      void Promise.resolve(register.call(presets, {
        id: WATCHDOG_PRESET_ID,
        name: 'Dot watchdog',
        description: 'Internal strictly read-only run-health judge used when watchdogMode is auto; never used for tasks.',
        order: 92,
        plugins: [
          { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: WATCHDOG_INSTRUCTIONS } },
          { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
        ] as never,
      })).then((dispose: () => Promise<void>) => {
        if (disposed) { invokePresetDispose(dispose); return }
        release = dispose
        logger.debug('preset.registered', 'Registered Dot watchdog preset.', { presetId: WATCHDOG_PRESET_ID })
      }, onFailed)
    } catch (error: unknown) {
      onFailed(error)
    }
    return () => {
      disposed = true
      const current = release
      release = undefined
      invokePresetDispose(current)
    }
  }, 'dot.watchdog-preset')

  // Correlate the host audit id (not callId) with its in-memory dot request.
  const approvalWithdrawals = new Map<string, { sessionId: string; withdraw: () => void }>()
  ctx.effect(() => () => approvalWithdrawals.clear(), 'dot.approval-links')

  // Ledger and chat feed. Handlers never throw back into the agent loop.
  const guard = (work: () => unknown) => { try { void Promise.resolve(work()).catch(() => {}) } catch { /* observer only */ } }
  const agentsSafe = (): { get?(id: string): AgentLike | undefined; list?(): readonly AgentLike[] } | undefined => {
    try { return ctx.get('agents' as never) as { get?(id: string): AgentLike | undefined; list?(): readonly AgentLike[] } | undefined }
    catch { return undefined }
  }
  const readSessionSnapshot = (session: SessionLike | undefined): readonly RawEvent[] => {
    if (!session) return []
    try {
      if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
      if (typeof session.seq === 'number' && typeof session.eventAt === 'function') {
        const events: RawEvent[] = []
        for (let seq = 0; seq < session.seq; seq++) {
          const event = session.eventAt(seq)
          if (event) events.push(event)
        }
        return events
      }
    } catch { /* best-effort snapshot */ }
    return []
  }
  ctx.effect(() => ctx.on('tools/change', () => service.refreshChildSeals()), 'dot.child-tools')
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }: { agent: AgentLike }) => {
    const id = agent?.session?.id ?? agent?.id
    if (id) {
      service.releaseChildSeal(id)
      service.noteAgentDisposed(id)
    }
  }), 'dot.seal-release')
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }: { agent: AgentLike; status: string }) => guard(() => {
    const own = agent.session?.id
    if (own) feed.onStatus(own)
    if (own) {
      try { service.sealIfOwned(agent) } catch { /* best-effort seal; must not block status transitions */ }
    }
    if (own && service.isDot(own) && (status === 'running' || status === 'idle')) service.onStatus(own, status)
    // dot's own session is left out of the ledger; its finished turn is where a segment change is checked.
    // The check waits for the turn boundary to commit, like the reply read below.
    if (own && status === 'idle' && service.isDot(own)) setTimeout(() => guard(() => service.onDotIdle(own)), TURN_SETTLE_MS)
    const id = sessionIdOf(agent)
    if (id && (status === 'running' || status === 'idle')) service.onStatus(id, status)
  })), 'dot.status')
  // Archive is not an agent status. The host keeps the session readable and
  // Dorothy's last idle status would otherwise stay on the board forever.
  const onHost = (name: string, listener: (...args: never[]) => void) => (ctx as unknown as { on(event: string, fn: (...args: never[]) => void): () => void }).on(name, listener)
  ctx.effect(() => onHost('agent/created', (({ agent }: { agent?: AgentLike }) => guard(() => {
    const session = agent?.session
    const id = typeof session?.id === 'string' ? session.id : typeof agent?.id === 'string' ? agent.id : undefined
    if (!id) return
    const status = agent?.status === 'idle' ? 'idle' : 'running'
    service.onAgentCreated(id, status, readSessionSnapshot(session))
  })) as never), 'dot.agent-created')
  ctx.effect(() => onHost('workspace/session-archived', ((request: { sessionId?: string }) => {
    const id = request?.sessionId
    if (typeof id === 'string' && id) guard(() => service.noteSessionArchived(id))
  }) as never), 'dot.watch-archive')
  ctx.effect(() => onHost('api-session/removed', ((sessionId: string) => {
    if (typeof sessionId === 'string' && sessionId) guard(() => service.noteSessionRemoved(sessionId))
  }) as never), 'dot.watch-removed')
  ctx.effect(() => ctx.on('agent/turn-stopping', ({ agent }: { agent: AgentLike }) => {
    const id = sessionIdOf(agent)
    // Read the reply after the boundary commits; the stopping hook must not wait on it.
    if (id) setTimeout(() => guard(() => service.onTurnEnd(id)), TURN_SETTLE_MS)
  }), 'dot.turn')
  ctx.effect(() => ctx.on('agent/error', ({ agent, error }: { agent: AgentLike; error: unknown }) => guard(() => {
    const id = sessionIdOf(agent)
    if (id) {
      logger.warn('ledger.agent-error', 'Observed error on tracked top-level session.', error, { sessionId: id })
      service.onError(id, error)
    }
  })), 'dot.error')
  ctx.effect(() => (ctx as unknown as { on(name: string, listener: (...args: never[]) => void): () => void }).on('session/event', ((session: { id?: string }, event: RawEvent) => {
    if (session?.id && feed.isDot(session.id)) guard(() => feed.onEvent(session.id!, event))
    if (session?.id) {
      const liveSession = agentsSafe()?.get?.(session.id)?.session
      if (!liveSession || liveSession === session) {
        guard(() => service.onSessionEvent(session.id!, event))
      }
    }
    if (event.type === 'approval/decided') {
      const id = (event.data as { id?: unknown } | undefined)?.id
      const linked = typeof id === 'string' ? approvalWithdrawals.get(id) : undefined
      if (linked && linked.sessionId === session?.id) {
        approvalWithdrawals.delete(id as string)
        linked.withdraw()
      }
    }
  }) as never), 'dot.chat-events')
  ctx.effect(() => (ctx as unknown as { on(name: string, listener: (...args: never[]) => void): () => void }).on('agent/assistant-stream', ((payload: { agent?: AgentLike; frame?: { type?: string; chunk?: { type?: string; text?: string } } }) => {
    const id = payload?.agent?.session?.id
    if (id && payload.frame && feed.isDot(id)) guard(() => feed.onStream(id, payload.frame!))
  }) as never), 'dot.chat-stream')
  service.backfillManagedRetryHealth()

  /** Top-level session a request belongs to: a subagent's popups show in its root session. */
  const agents = () => ctx.get('agents' as never) as unknown as { get(id: string): AgentLike | undefined } | undefined
  const topLevelOf = (agent: AgentLike | undefined): { id: string; via?: string; cwd?: string } | undefined => {
    let session = agent?.session
    const own = session?.id
    if (!own) return undefined
    for (let hop = 0; hop < 8 && session?.header?.parentSession; hop++) {
      const parentId: string = session.header.parentSession
      const parent = agents()?.get(parentId)?.session
      if (!parent) return { id: parentId, via: own, ...session.header.cwd ? { cwd: session.header.cwd } : {} }
      session = parent
    }
    const id = session?.id ?? own
    return { id, ...id === own ? {} : { via: own }, ...session?.header?.cwd ? { cwd: session.header.cwd } : {} }
  }
  /** Raw arguments of the call an approval is about, so dot can judge what would run. */
  const callArguments = (agent: AgentLike | undefined, callId: string | undefined): string | undefined => {
    const session = agent?.session
    if (!callId || !session || typeof session.seq !== 'number' || typeof session.eventAt !== 'function') return undefined
    for (let seq = session.seq - 1; seq >= Math.max(0, session.seq - CALL_SCAN); seq--) {
      const event = session.eventAt(seq)
      const data = event?.type === 'tool/call' ? event.data as { callId?: unknown; arguments?: unknown } | undefined : undefined
      if (data?.callId === callId) return typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments)
    }
    return undefined
  }

  // Approvals: dot's chat and the original session's own card race; the first
  // answer wins.
  ctx.effect(() => ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
    const origin = topLevelOf(req.agent as AgentLike)
    if (!origin) return next()
    // Safe Auto reviews sessions that are intended to run under it. Residual
    // overlay after Dorothy re-pins a task away from `safe-auto` must not skip
    // `approvals=deny`.
    const requesting = (req.agent as AgentLike).session
    if (requesting?.id && shouldDeferApprovalToSafeAuto({
      overlayActive: host.safeAutoActive?.(requesting.id) === true,
      intendedPermission: service.runTaskPermission(origin.id),
    })) return next()
    const args = callArguments(req.agent as AgentLike, req.callId)
    const routed = service.relayRequest({
      kind: 'approval',
      sessionId: origin.id,
      subject: req.toolName,
      toolName: req.toolName,
      ...(req.reason ? { reason: req.reason } : {}),
      ...(args !== undefined ? { arguments: args } : {}),
      ...(origin.via ? { viaSubagent: true } : {}),
      ...(origin.cwd ? { cwd: origin.cwd } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    })
    if (routed.decided === 'skip') return next()
    if (routed.decided === 'deny') {
      logger.info('approval.rule-denied', 'Approval denied automatically by Dot rule.', { sessionId: origin.id, tool: req.toolName })
      return 'rejected'
    }
    try {
      await service.saveApprovalDetail({ requestId: routed.id, sessionId: origin.id, ...origin.via ? { callerSessionId: origin.via } : { callerSessionId: origin.id }, ...req.callId ? { callId: req.callId } : {}, toolName: req.toolName, ...req.reason ? { reason: req.reason } : {}, ...args !== undefined ? { arguments: args } : {} })
    } catch (error) {
      routed.withdraw()
      logger.info('approval.detail-save-failed', 'Approval details could not be saved; leaving the request to its native handler.', { sessionId: origin.id })
      return next()
    }
    logger.info('approval.relayed', 'Relayed approval request to Dot.', { sessionId: origin.id, tool: req.toolName, requestId: routed.id })
    const callerSignal = req.signal
    const lease = detachNative(req as { signal?: AbortSignal })
    // The host appends approval/asked before dispatch and does not expose its id on req.
    // Only link an unambiguous, still-open audit pair. Calls without unique ids
    // still withdraw through their own native-result promise, never another request's event.
    const session = (req.agent as AgentLike).session
    const found = approvalAuditId(session, req.toolName, req.callId)
    const auditId = found && !approvalWithdrawals.has(found) ? found : undefined
    if (auditId && session?.id) approvalWithdrawals.set(auditId, { sessionId: session.id, withdraw: routed.withdraw })
    try {
      const outcome = await raceApproval(routed, next, lease, callerSignal)
      logger.info('approval.decided', 'Relayed approval request settled.', { sessionId: origin.id, tool: req.toolName, outcome })
      return outcome
    } finally {
      if (auditId) approvalWithdrawals.delete(auditId)
    }
  }, { prepend: true }), 'dot.approval')

  ctx.effect(() => ctx.on('user-questions/request', async (req, next): Promise<AskUserQuestionAnswer> => {
    const origin = topLevelOf(req.agent as AgentLike)
    if (!origin || req.questions.length === 0) return next()
    const questions: PendingQuestionItem[] = req.questions.map(item => ({
      id: item.id,
      question: item.question,
      ...item.detail ? { detail: item.detail } : {},
      ...item.options ? { options: item.options.map(option => ({ label: option.label, ...option.description ? { description: option.description } : {} })) } : {},
      ...item.multiSelect ? { multiSelect: true } : {},
    }))
    const routed = service.relayRequest({ kind: 'question', sessionId: origin.id, subject: questions[0]!.question, questions, ...origin.via ? { detail: `asked by subagent ${origin.via}` } : {}, ...origin.cwd ? { cwd: origin.cwd } : {}, ...req.signal ? { signal: req.signal } : {} })
    if (routed.decided !== 'pending') return next()
    logger.info('question.relayed', 'Relayed user question to Dot.', { sessionId: origin.id, questionCount: questions.length, requestId: routed.id })
    const lease = detachNative(req)
    const native = next()
    const winner = await Promise.race([
      native.then(answer => ({ from: 'native' as const, ok: true as const, answer }), () => ({ from: 'native' as const, ok: false as const })),
      routed.settled.then(answer => ({ from: 'dot' as const, answer })),
    ])
    logger.debug('question.settled', 'Relayed user question answered.', { sessionId: origin.id, source: winner.from })
    if (winner.from === 'native' && winner.ok) { lease?.release(); routed.withdraw(); return winner.answer }
    if (winner.from === 'dot') lease?.close()
    // A timed card that ran out rejects on purpose: the host turns it into a
    // continued question, so keep its semantics instead of holding the call.
    if (winner.from === 'native' && req.wait?.timed) { routed.withdraw(); return native }
    const answer = winner.from === 'dot' ? winner.answer : await routed.settled
    if (answer?.kind === 'question') return { answers: answer.answers.map(item => ({ id: item.id, selected: [...item.selected], ...item.custom ? { custom: item.custom } : {} })) }
    return native
  }, { prepend: true }), 'dot.question')

  const field = (payload: unknown, key: string): unknown => payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined
  const num = (payload: unknown, key: string): number => { const value = field(payload, key); return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
  const str = (payload: unknown, key: string): string => { const value = field(payload, key); return typeof value === 'string' ? value : '' }
  const withSelfBackup = (snapshot: ChatSnapshot | undefined): ChatSnapshot | undefined => {
    if (!snapshot) return snapshot
    const lastBackup = service.selfStatus().lastBackup
    return lastBackup ? { ...snapshot, lastBackup } : snapshot
  }
  // The kit's 64 KiB default answers 413 before `say` runs. A PNG of about
  // 51 KB does not fit after base64; the cap below fits the advertised images.
  const PASSIVE_ENDPOINTS = new Set(['wait', 'board', 'attention', 'work.list', 'work.read', 'card.pending', 'card.detail', 'recipes', 'self.status', 'github.poll.status', 'watchdog.diagnostics'])
  ctx.effect(() => registerHostRpc(ctx as unknown as HostRpcContext, RPC_CHANNEL, async (endpoint, payload, signal) => {
    try {
      const reqLocale = field(payload, 'uiLocale')
      if (typeof reqLocale === 'string' && reqLocale.trim() && (!PASSIVE_ENDPOINTS.has(endpoint) || store.uiLocale === undefined)) {
        await service.syncLocale(reqLocale)
      }
      switch (endpoint) {
        case 'locale.sync': return { ok: true, value: await service.syncLocale(str(payload, 'locale') || str(payload, 'uiLocale')) }
        case 'board': {
          await service.syncWatched(signal)
          return { ok: true, value: service.board() }
        }
        case 'attention': return { ok: true, value: service.attention() }
        case 'ensure': return { ok: true, value: { sessionId: await ensureDot() } }
        case 'chat': {
          await ensureDot()
          return { ok: true, value: withSelfBackup(feed.snapshot(num(payload, 'itemsRev'))) }
        }
        case 'wait': {
          await ensureDot()
          await feed.wait(num(payload, 'rev'), signal, WAIT_MS)
          return { ok: true, value: withSelfBackup(feed.snapshot(num(payload, 'itemsRev'))) }
        }
        case 'say': {
          const text = field(payload, 'text')
          const images = checkChatImages(field(payload, 'images'))
          await service.say(typeof text === 'string' ? text.slice(0, 20_000) : '', undefined, images)
          return { ok: true, value: true }
        }
        case 'card.pending': {
          const callId = field(payload, 'callId')
          return { ok: true, value: typeof callId === 'string' ? service.cards.pending(callId) : null }
        }
        case 'card.detail': {
          const id = field(payload, 'viewId')
          return { ok: true, value: typeof id === 'string' ? store.cards.find(card => card.id === id) ?? null : null }
        }
        case 'card.answer': {
          const id = field(payload, 'viewId')
          const action = field(payload, 'action')
          const result = await service.answerCard(typeof id === 'string' ? id : '', typeof action === 'string' ? action : '', field(payload, 'values'))
          return { ok: true, value: result }
        }
        case 'card.retryNotification': {
          const id = field(payload, 'viewId')
          await service.retryCardNotification(typeof id === 'string' ? id : '')
          return { ok: true, value: true }
        }
        case 'stop': { await service.stop(); return { ok: true, value: true } }
        case 'settings': return { ok: true, value: store.settings }
        case 'github.poll.status': return { ok: true, value: service.githubPollStatus() }
        case 'github.poll.test': {
          const ghPath = typeof field(payload, 'ghPath') === 'string' ? str(payload, 'ghPath') : undefined
          const hostname = typeof field(payload, 'hostname') === 'string' ? str(payload, 'hostname') : undefined
          const rawRepos = field(payload, 'repos')
          const repos = Array.isArray(rawRepos) ? rawRepos.filter((r): r is string => typeof r === 'string') : undefined
          try {
            return {
              ok: true,
              value: await service.testGithubPollConnection({
                ...(ghPath !== undefined ? { ghPath } : {}),
                ...(hostname !== undefined ? { hostname } : {}),
                ...(repos !== undefined ? { repos } : {}),
              }),
            }
          } catch (error) {
            return { ok: false, error: { code: error instanceof DotError ? error.code : 'dot/failed', message: messageOf(error) } }
          }
        }
        case 'settings.proposals': return { ok: true, value: store.settingProposals }
        case 'settings.taskpermissions': {
          const live = host.taskPermissionOptions?.() ?? { safeAuto: false, auto: false }
          const options: TaskPermission[] = ['workspace-write', 'danger-full-access']
          if (live.safeAuto) options.push('safe-auto')
          if (live.auto) options.push('auto')
          return { ok: true, value: { options } }
        }
        case 'capabilities.catalog': return { ok: true, value: await service.capabilitiesView() }
        case 'mcp.list': return { ok: true, value: await service.mcpServersView() }
        case 'mcp.credential.set': {
          const server = field(payload, 'server')
          const value = field(payload, 'value')
          // The panel saves the server row before writing its token, so only
          // a stored `mcpServers` name is valid here.
          const known = new Set(Object.keys(store.settings.mcpServers ?? {}))
          const problem = validateMcpCredentialSet(server, value, known)
          if (problem === 'bad-server') return { ok: false, error: { code: 'dot/mcp-bad-server', message: `invalid server name: ${String(server)}` } }
          if (problem === 'unknown-server') return { ok: false, error: { code: 'dot/mcp-bad-server', message: `unknown MCP server: ${String(server)}` } }
          if (problem === 'bad-credential') return { ok: false, error: { code: 'dot/mcp-bad-credential', message: `credential value must be a non-empty string of at most ${MCP_CREDENTIAL_VALUE_MAX} characters` } }
          const credentials = credentialsService()
          if (credentials?.set === undefined || credentials.describe === undefined) return { ok: false, error: { code: 'dot/mcp-unavailable', message: 'the host credentials service is unavailable' } }
          const ref = await credentialRefFor(mcpCredentialName(server as string))
          await credentials.set(ref, value as string)
          const info = await credentials.describe(ref)
          return { ok: true, value: { configured: info?.configured === true, masked: info?.masked } }
        }
        case 'mcp.credential.unset': {
          const server = field(payload, 'server')
          if (typeof server !== 'string' || !MCP_SERVER_NAME_PATTERN.test(server)) return { ok: false, error: { code: 'dot/mcp-bad-server', message: `invalid server name: ${String(server)}` } }
          const credentials = credentialsService()
          if (credentials?.unset === undefined) return { ok: false, error: { code: 'dot/mcp-unavailable', message: 'the host credentials service is unavailable' } }
          await credentials.unset(await credentialRefFor(mcpCredentialName(server)))
          return { ok: true, value: { configured: false } }
        }
        case 'settings.decide': {
          const id = field(payload, 'id')
          return { ok: true, value: await service.selfSettings.decide(typeof id === 'string' ? id : '', field(payload, 'allow') === true) }
        }
        case 'segment.new': return { ok: true, value: await service.newSegment() }
        case 'update.status': return { ok: true, value: service.updateStatus() ?? null }
        case 'update.check': return { ok: true, value: await service.checkUpdates() }
        case 'self.status': return { ok: true, value: service.selfStatus() }
        case 'keepalive': {
          return { ok: true, value: service.keepaliveInfo() }
        }
        case 'trajectory': {
          const id = await ensureDot()
          return { ok: true, value: host.dotTrajectory(id) }
        }
        case 'reflection.runs': return { ok: true, value: service.reflectionRuns() }
        case 'reflection.trajectory': {
          const id = field(payload, 'sessionId')
          try {
            return { ok: true, value: await service.reflectionTrajectory(typeof id === 'string' ? id : '') }
          } catch (error) {
            return { ok: false, error: { code: error instanceof DotError ? error.code : 'dot/failed', message: messageOf(error) } }
          }
        }
        case 'context': {
          await ensureDot()
          return { ok: true, value: await service.contextView() }
        }
        case 'context.clear': {
          await ensureDot()
          return { ok: true, value: await service.clearUsage() }
        }
        case 'watchdog.diagnostics': {
          return { ok: true, value: service.watchdogDiagnostics() }
        }
        case 'watchdog.annotate': {
          const id = str(payload, 'id').trim()
          const annotation = field(payload, 'annotation')
          if (!id || (annotation !== 'accurate' && annotation !== 'false-positive')) {
            return { ok: false, error: { code: 'dot/invalid', message: 'watchdog.annotate requires id and annotation (accurate | false-positive)' } }
          }
          const updated = await service.annotateWatchdogHit(id, annotation)
          if (!updated) return { ok: false, error: { code: 'dot/not-found', message: `unknown watchdog hit ${id}` } }
          return { ok: true, value: service.watchdogDiagnostics() }
        }
        case 'recipes': return { ok: true, value: service.recipeBoard() }
        case 'recipe.run': {
          const id = str(payload, 'id')
          const result = await service.runRecipe(id ?? '', { origin: 'human' })
          return { ok: true, value: result }
        }
        case 'recipe.proposal.decide': return { ok: true, value: await service.decideRecipeProposal(payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}) }
        case 'schedule.remove': {
          const id = field(payload, 'id')
          return { ok: true, value: typeof id === 'string' ? await service.removeSchedule(id) : false }
        }
        case 'watch.remove': {
          const id = field(payload, 'id')
          return { ok: true, value: typeof id === 'string' ? await service.unwatch(id) : false }
        }
        case 'work.list': {
          return { ok: true, value: service.workList() }
        }
        case 'work.read': {
          const kind = field(payload, 'kind')
          if (kind !== 'evidence' && kind !== 'change') return { ok: false, error: { code: 'dot/invalid', message: 'kind must be evidence or change' } }
          const view = field(payload, 'view')
          if (view !== undefined && view !== 'diff') return { ok: false, error: { code: 'dot/invalid', message: 'view must be diff' } }
          const read = service.readWorkSource(str(payload, 'id'), kind, str(payload, 'ref'), {
            verificationId: str(payload, 'verificationId'), inputRef: str(payload, 'inputRef'), inputRevision: num(payload, 'inputRevision'),
          }, { forceFull: field(payload, 'forceFull') === true, ...(view === 'diff' ? { view: 'diff' as const } : {}) })
          if (!read.ok) return { ok: false, error: { code: `dot/${read.code}`, message: read.message } }
          return { ok: true, value: { source: read.source, body: read.body, truncated: read.truncated, totalBytes: read.totalBytes } }
        }
        case 'work.accept': {
          const result = await service.acceptWork(str(payload, 'id'), str(payload, 'verificationId'), str(payload, 'expectedInputRef'), str(payload, 'expectedSubjectKey'), 'user', {
            expectedInputRevision: num(payload, 'expectedInputRevision'), expectedVerificationId: str(payload, 'verificationId'),
          })
          if (result && 'ok' in result && result.ok === false) return { ok: false, error: { code: result.code, message: result.message } }
          return { ok: true, value: true }
        }
        case 'work.reject': {
          const id = str(payload, 'id')
          const result = await service.rejectWork(id, str(payload, 'reviewRunId'), num(payload, 'expectedInputRevision'))
          if (result && 'ok' in result && result.ok === false) return { ok: false, error: { code: result.code, message: result.message } }
          const note = str(payload, 'note').trim()
          if (note) {
            const title = service.workBoard(id)?.title ?? id
            notifyRejected(service, title, note)
          }
          return { ok: true, value: true }
        }
        case 'work.answer': {
          try {
            const reqId = str(payload, 'id')
            const allow = field(payload, 'allow') === true
            const pendingRow = !allow ? service.pending.list().find(row => row.id === reqId) : undefined
            await service.answerWorkReview(reqId, allow)
            const note = !allow ? str(payload, 'note').trim() : ''
            if (note) {
              let title = reqId
              try {
                const parsed = pendingRow?.detail ? JSON.parse(pendingRow.detail) as { changeId?: unknown } : undefined
                if (typeof parsed?.changeId === 'string') title = service.workBoard(parsed.changeId)?.title ?? parsed.changeId
              } catch { /* fallback to request id */ }
              notifyRejected(service, title, note)
            }
            return { ok: true, value: true }
          } catch (error) {
            return { ok: false, error: { code: error instanceof DotError ? error.code : 'dot/failed', message: messageOf(error) } }
          }
        }
        case 'work.resume': {
          const result = await service.resumeWorkCloseout(str(payload, 'id'))
          if (result && 'ok' in result && result.ok === false) return { ok: false, error: { code: result.code, message: result.message } }
          return { ok: true, value: true }
        }
        case 'work.release': {
          const result = await service.forceReleaseWork(str(payload, 'id'))
          if (result && 'ok' in result && result.ok === false) return { ok: false, error: { code: result.code, message: result.message } }
          return { ok: true, value: true }
        }
        case 'work.integrate': {
          const mode = field(payload, 'mode')
          if (mode !== 'merge' && mode !== 'keep' && mode !== 'discard') return { ok: false, error: { code: 'dot/invalid', message: 'mode must be merge, keep or discard' } }
          const result = await service.integrateWork(str(payload, 'id'), mode)
          if (!result.ok) return { ok: false, error: { code: `dot/${result.code}`, message: result.message } }
          return { ok: true, value: result.text }
        }
        case 'knowledge': return { ok: true, value: await service.knowledgeView() }
        // Panel edits of the agreements/cognition do not switch segments at once: the change is
        // picked up before the next message (prompt-changed), or folded in while the segment is untouched.
        case 'agreements.edit': {
          try {
            return { ok: true, value: await service.editAgreements(parseKnowledgeEdit(field(payload, 'edit'), 'agreements')) }
          } catch (error) {
            if (error instanceof KnowledgeError || error instanceof DotError) return { ok: false, error: { code: error.code, message: error.message } }
            throw error
          }
        }
        case 'agreements.undo': return { ok: true, value: await service.undoAgreements() }
        case 'cognition.edit': {
          try {
            return { ok: true, value: await service.editCognition(parseKnowledgeEdit(field(payload, 'edit'), 'cognition')) }
          } catch (error) {
            if (error instanceof KnowledgeError || error instanceof DotError) return { ok: false, error: { code: error.code, message: error.message } }
            throw error
          }
        }
        case 'cognition.restore': {
          const at = field(payload, 'at')
          return { ok: true, value: await service.restoreCognition(typeof at === 'number' ? at : Number.NaN) }
        }
        case 'settings.set': {
          const previous = store.settings
          let groups
          try { groups = (await service.capabilitiesView()).groups } catch { groups = undefined }
          const next = patchSettings(previous, field(payload, 'patch'), service.locale, groups)
          // A new dot-local server may not reuse a global server's name: its
          // mount would shadow the global group for dot and inherit grants
          // the human gave to the global row.
          const added = Object.keys(next.mcpServers ?? {}).filter(name => !(previous.mcpServers !== undefined && name in previous.mcpServers))
          const clash = added.find(name => globalMcpNames().has(name))
          if (clash !== undefined) return { ok: false, error: { code: 'dot/mcp-global-conflict', message: `an MCP server named ${clash} is already connected globally; grant it under extra capabilities instead` } }
          await store.setSettings(next)
          await service.settingsChanged()
          // Removed dot-local servers release the dot-owned credentials their
          // headers referenced; other refs (hand-entered names) are left alone.
          const removed = Object.entries(previous.mcpServers ?? {}).filter(([name]) => !(next.mcpServers !== undefined && name in next.mcpServers))
          for (const ref of dotOwnedCredentialRefs(removed.map(([, row]) => row))) {
            try { await credentialsService()?.unset?.(await credentialRefFor(ref)) } catch { /* best effort */ }
          }
          logger.info('settings.updated', 'Updated Dot settings via RPC.')
          return { ok: true, value: next }
        }
        case 'factory.preview': return { ok: true, value: service.previewFactoryReset() }
        case 'factory.reset': {
          const token = field(payload, 'token')
          return { ok: true, value: await service.confirmFactoryReset(typeof token === 'string' ? token : '') }
        }
        default: return { ok: false, error: { code: 'not-found', message: `unknown endpoint: ${endpoint}` } }
      }
    } catch (error) {
      logger.error('rpc.handler-failed', 'Dot RPC request failed.', error, { endpoint })
      return { ok: false, error: { code: 'dot/failed', message: messageOf(error) } }
    }
  }, { logger, maxBodyBytes: CHAT_SAY_BODY_BYTES }), 'dot.rpc')
}
