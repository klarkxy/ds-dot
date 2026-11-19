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
import { COMPACTION_POLICY, PLUGIN_NAME, PRESET_ID, RPC_CHANNEL, SERVICE_NAME, type PendingQuestionItem, type TaskRecord } from './contracts.ts'
import { CHAT_SAY_BODY_BYTES, checkChatImages } from './chat-images.ts'
import { ChatFeed } from './feed.ts'
import { bindHost } from './host.ts'
import { clip } from './ledger.ts'
import { detachNative } from './native.ts'
import { PeerLedger } from './peer.ts'
import { DOT_INSTRUCTIONS } from './prompt.ts'
import { installPresetVisibility } from './preset-visibility.ts'
import { REFLECTION_INSTRUCTIONS, REFLECTION_PRESET_ID } from './reflection.ts'
import { APPROVAL_GRACE_MS, DotError, DotService, messageOf } from './service.ts'
import { configI18n } from './i18n/index.ts'
import { patchSettings } from './settings.ts'
import { dotDomain, parsePeerDelivery, parseTask } from './storage.ts'
import { DotStore, type DotDomainHandle } from './store.ts'
import { copyLocale, fillText, t } from './ui-copy.ts'

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
}

export const Config: Schema<Config> = Schema.object({
  homeDir: Schema.string().default(''),
  approvalGraceMs: Schema.number().min(0).max(60_000).default(APPROVAL_GRACE_MS),
}).i18n(configI18n())

interface SessionLike {
  readonly id?: string
  readonly header?: { readonly parentSession?: string; readonly cwd?: string; readonly origin?: string }
  readonly seq?: number
  eventAt?(seq: number): RawEvent | undefined
}
interface AgentLike { readonly id?: string; readonly session?: SessionLike }

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
    ctx.logger?.info?.(message)
    logger.info('dot.runtime', message)
  }
  const domain = await openCompatibleDomain(
    spec => (ctx.storageDomain as unknown as { open(s: typeof spec): Promise<DotDomainHandle> }).open(spec),
    dotDomain,
    { logger, domainName: 'dsh_dot' },
  )
  const store = new DotStore(domain, [...domain.table('tasks').entries()].map(([, value]) => parseTask(value)).filter((task): task is TaskRecord => task !== undefined))
  let sealOwned: ((agent: unknown) => void) | undefined
  const host = bindHost(name => ctx.get(name as never), log, () => store.settings.model, agent => { sealOwned?.(agent) })
  const service = new DotService({
    host,
    store,
    peers: new PeerLedger(domain.table('peers'), parsePeerDelivery),
    homeDir: config.homeDir?.trim() || join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'dot'),
    log,
    trace: logger,
    approvalGraceMs: Number.isFinite(config.approvalGraceMs) ? Math.max(0, Math.min(60_000, config.approvalGraceMs!)) : APPROVAL_GRACE_MS,
  })
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
  const ensureDot = async () => {
    const sessionId = await service.ensureDot()
    follow()
    return sessionId
  }
  ctx.provide(SERVICE_NAME, service)
  ctx.effect(() => () => {
    unfollow()
    unpending()
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

  ctx.effect(() => installPresetVisibility(ctx.agentPresets), 'dot.preset-visibility')

  // The dot preset: conversation, dot's tools, and in-place compaction for the
  // one turn that outgrows the window before a segment change. Choices go through
  // deep-view's show_view cards, which every session gets when it is installed.
  ctx.effect(() => {
    let release: (() => Promise<void>) | undefined
    let disposed = false
    void ctx.agentPresets.register({
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
      ] as never,
    }).then((dispose: () => Promise<void>) => {
      if (disposed) { void dispose(); return }
      release = dispose
      logger.debug('preset.registered', 'Registered Dorothy preset.', { presetId: PRESET_ID })
      // Reminders wake dot's session, which only opens once its preset exists.
      service.startReminders()
    }, (error: unknown) => {
      logger.error('preset.register-failed', 'Failed to register Dorothy preset.', error, { presetId: PRESET_ID })
      ctx.logger?.warn?.('dsh-dot: preset registration failed: %s', messageOf(error))
    })
    return () => { disposed = true; void release?.() }
  }, 'dot.preset')

  // The internal reflection preset: a hidden subagent session mounts only the
  // read-only history tools and the cognition submission tool (never the
  // agreements tool). It is filtered out of the task preset roster in host.ts.
  ctx.effect(() => {
    let release: (() => Promise<void>) | undefined
    let disposed = false
    void ctx.agentPresets.register({
      id: REFLECTION_PRESET_ID,
      name: 'Dot reflection',
      description: 'Internal background reflection pass that updates Dorothy’s cognition; never used for tasks.',
      order: 91,
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: REFLECTION_INSTRUCTIONS } },
        { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
        { id: 'dot-reflection-tools', name: 'ds-dot/reflection' },
      ] as never,
    }).then((dispose: () => Promise<void>) => {
      if (disposed) { void dispose(); return }
      release = dispose
      logger.debug('preset.registered', 'Registered Dot reflection preset.', { presetId: REFLECTION_PRESET_ID })
    }, (error: unknown) => {
      logger.error('preset.register-failed', 'Failed to register Dot reflection preset.', error, { presetId: REFLECTION_PRESET_ID })
      ctx.logger?.warn?.('dsh-dot: reflection preset registration failed: %s', messageOf(error))
    })
    return () => { disposed = true; void release?.() }
  }, 'dot.reflection-preset')

  // Correlate the host audit id (not callId) with its in-memory dot request.
  const approvalWithdrawals = new Map<string, { sessionId: string; withdraw: () => void }>()
  ctx.effect(() => () => approvalWithdrawals.clear(), 'dot.approval-links')

  // Ledger and chat feed. Handlers never throw back into the agent loop.
  const guard = (work: () => unknown) => { try { void Promise.resolve(work()).catch(() => {}) } catch { /* observer only */ } }
  ctx.effect(() => ctx.on('tools/change', () => service.refreshChildSeals()), 'dot.child-tools')
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }: { agent: AgentLike }) => {
    const id = agent.session?.id
    if (id) service.releaseChildSeal(id)
  }), 'dot.seal-release')
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }: { agent: AgentLike; status: string }) => guard(() => {
    const own = agent.session?.id
    if (own) feed.onStatus(own)
    if (own) service.sealIfOwned(agent)
    if (own && service.isDot(own) && (status === 'running' || status === 'idle')) service.onStatus(own, status)
    // dot's own session is left out of the ledger; its finished turn is where a segment change is checked.
    // The check waits for the turn boundary to commit, like the reply read below.
    if (own && status === 'idle' && service.isDot(own)) setTimeout(() => guard(() => service.onDotIdle(own)), TURN_SETTLE_MS)
    const id = sessionIdOf(agent)
    if (id && (status === 'running' || status === 'idle')) service.onStatus(id, status)
  })), 'dot.status')
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
  // The kit's 64 KiB default answers 413 before `say` runs. A PNG of about
  // 51 KB does not fit after base64; the cap below fits the advertised images.
  const PASSIVE_ENDPOINTS = new Set(['wait', 'board', 'work.list', 'work.read', 'card.pending', 'card.detail'])
  ctx.effect(() => registerHostRpc(ctx as unknown as HostRpcContext, RPC_CHANNEL, async (endpoint, payload, signal) => {
    try {
      const reqLocale = field(payload, 'uiLocale')
      if (typeof reqLocale === 'string' && reqLocale.trim() && (!PASSIVE_ENDPOINTS.has(endpoint) || store.uiLocale === undefined)) {
        await service.syncLocale(reqLocale)
      }
      switch (endpoint) {
        case 'locale.sync': return { ok: true, value: await service.syncLocale(str(payload, 'locale') || str(payload, 'uiLocale')) }
        case 'board': return { ok: true, value: service.board() }
        case 'ensure': return { ok: true, value: { sessionId: await ensureDot() } }
        case 'chat': {
          await ensureDot()
          return { ok: true, value: feed.snapshot(num(payload, 'itemsRev')) }
        }
        case 'wait': {
          await ensureDot()
          await feed.wait(num(payload, 'rev'), signal, WAIT_MS)
          return { ok: true, value: feed.snapshot(num(payload, 'itemsRev')) }
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
        case 'settings.proposals': return { ok: true, value: store.settingProposals }
        case 'settings.decide': {
          const id = field(payload, 'id')
          return { ok: true, value: await service.selfSettings.decide(typeof id === 'string' ? id : '', field(payload, 'allow') === true) }
        }
        case 'segment.new': return { ok: true, value: await service.newSegment() }
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
        case 'schedule.remove': {
          const id = field(payload, 'id')
          return { ok: true, value: typeof id === 'string' ? await service.removeSchedule(id) : false }
        }
        case 'work.list': {
          const rows = service.store.work.listChanges().map(change => service.workBoard(change.id)).filter(row => row !== undefined)
          return { ok: true, value: rows }
        }
        case 'work.read': {
          const kind = field(payload, 'kind')
          if (kind !== 'evidence' && kind !== 'change') return { ok: false, error: { code: 'dot/invalid', message: 'kind must be evidence or change' } }
          const read = service.readWorkSource(str(payload, 'id'), kind, str(payload, 'ref'), {
            verificationId: str(payload, 'verificationId'), inputRef: str(payload, 'inputRef'), inputRevision: num(payload, 'inputRevision'),
          }, { forceFull: field(payload, 'forceFull') === true })
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
        case 'knowledge': return { ok: true, value: await service.knowledgeView() }
        // Panel edits of the agreements/cognition do not switch segments at once: the change is
        // picked up before the next message (prompt-changed), or folded in while the segment is untouched.
        case 'agreements.set': {
          const text = field(payload, 'text')
          return { ok: true, value: await service.setAgreements(typeof text === 'string' ? text : '') }
        }
        case 'agreements.undo': return { ok: true, value: await service.undoAgreements() }
        case 'cognition.set': {
          const text = field(payload, 'text')
          return { ok: true, value: await service.setCognition(typeof text === 'string' ? text : '') }
        }
        case 'cognition.restore': {
          const at = field(payload, 'at')
          return { ok: true, value: await service.restoreCognition(typeof at === 'number' ? at : Number.NaN) }
        }
        case 'settings.set': {
          const next = patchSettings(store.settings, field(payload, 'patch'), service.locale)
          await store.setSettings(next)
          await service.settingsChanged()
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
