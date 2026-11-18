/**
 * Thin adapters over the host services dot drives. Everything the service
 * needs from DSH goes through {@link DotHost}, so the orchestration logic is
 * tested against a fake and the host surface stays in one file.
 *
 * Host contracts (DSH 0.2.2-rc.3 public session controller):
 * - sessionController: create / prompt / cancel / list / resolveAgent for task
 *   sessions, modelCatalog / selectModel for the model a task runs on
 *   (@deepseek-ai/dsh-api-session-controller)
 * - agents: create / resume / get for dot's own session, which carries the
 *   subagent origin so the sidebar leaves it out (@deepseek-ai/dsh-agent)
 * - workspaceRegistry: create / list / archiveSession (@deepseek-ai/dsh-workspace)
 * - sessionQuery: readSession + extractSessionEventText for the latest reply,
 *   and the stored log of dot's earlier segments
 * - permissionPresets: set (@deepseek-ai/dsh-permission-presets)
 * - llm: stream, for the note dot writes when its conversation moves to a new
 *   segment; the request replays the segment's own prefix the way
 *   dsh-compaction-basic's summarizer does, so the provider cache is reused
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { assembleContextFor, installModelSelection, type Agent, type AgentHandle, type AgentRegistry, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import { checkChatImages, type ChatImage } from './chat-images.ts'
import type { RawEvent } from './chat.ts'
import type { ParsedNotice } from './chat-format.ts'
import { contextView, EMPTY_SCAN, foldScan, type ContextScan, type PreTurnContext, type ProjectionValues } from './context.ts'
import { assembledSurface, type AssembledPromptInput } from './context-surface.ts'
import type { DotContextUsage, DotContextView, ModelChoice, TrajectoryView } from './contracts.ts'
import type { CatalogModel, TaskModelCatalog } from './task-models.ts'
import type { CatalogPreset, TaskPresetCatalog } from './task-presets.ts'
import { REFLECTION_PRESET_ID, REFLECTION_ALLOW } from './reflection.ts'
import { foldTrajectory } from './trajectory.ts'
import { restrictInheritedTools } from './tool-scope.ts'
import { DOT_INHERITED_ALLOW, dotDevIndexReady } from './tools.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-message': { kind: 'agent-message'; form: 'relay'; senderSessionId: SessionId; deliveryId?: string }
  }
}

export const FULL_ACCESS = 'danger-full-access'

export interface WorkspaceRow { readonly id: string; readonly path: string; readonly title: string; readonly sessionCount: number }
export interface SessionRow {
  readonly sessionId: string
  readonly cwd?: string
  readonly running: boolean
  readonly updatedAt: number
  readonly blank: boolean
  readonly subagent: boolean
  readonly archived: boolean
}

export interface DotHost {
  listWorkspaces(): WorkspaceRow[]
  createWorkspace(path: string, title?: string): Promise<WorkspaceRow>
  listSessions(signal: AbortSignal): Promise<SessionRow[]>
  titles(sessionIds: readonly string[], signal: AbortSignal): Promise<Map<string, string>>
  /** Open a top-level session. `sessionId` is the id reserved before the call. */
  createSession(place: { workspaceId?: string; cwd?: string; preset?: string; sessionId?: string }): Promise<string>
  /** Seal one already-open session dot owns, once its agent is live. */
  prepareOwnedSession?(sessionId: string): Promise<void>
  /** Read one ordinary session back. Undefined means it is not there. */
  findSession?(sessionId: string): Promise<{ cwd?: string; preset?: string } | undefined>
  /** Agent presets a session can run on, with the one a new session gets by default. */
  listPresets(): Promise<TaskPresetCatalog>
  /** Models a session can run on, with the one a new session gets by default. */
  listModels(): Promise<TaskModelCatalog>
  /** Put a task session on a model; called before its first prompt. */
  selectModel(sessionId: string, choice: ModelChoice): Promise<void>
  /** Switch a live task session to a permission preset; failures are reported, never thrown. */
  setPermission(sessionId: string, preset: string): Promise<boolean>
  /** Reapply the configured or host-default writable preset to an existing session. */
  setWritable?(sessionId: string, preset: string): Promise<boolean>
  /** Verify effective permissions without changing a running session. */
  verifyTaskPermission?(sessionId: string, access: 'read' | 'write', preset: string): Promise<boolean>
  /** Set a read-only sandbox with deterministic rejection of escalation requests. */
  setReadOnly?(sessionId: string): Promise<boolean>
  /** Deliver as the human's own prompt. `requestId` is reused when a receipt was lost. */
  prompt(sessionId: string, text: string, mode: 'queue' | 'steer', signal: AbortSignal, requestId?: string): Promise<void>
  /** Deliver as an agent-attributed message and wake the target. `deliveryId` is the business record, not a host request id. `confirm` runs after the agent is resolved and before followup. */
  relay(targetId: string, senderId: string, text: string, deliveryId?: string, confirm?: () => boolean, notice?: ParsedNotice): Promise<void>
  cancel(sessionId: string): Promise<void>
  /** Stop and wait for the live agent, clearing queued work; false is fail-closed. */
  cancelAndWait?(sessionId: string, timeoutMs: number): Promise<boolean>
  archive(sessionId: string): Promise<void>
  /**
   * Ask the host to stop, then report the separate facts that release a run.
   * A missing job registry stays `unknown` and must not be treated as settled.
   */
  stopActivity?(sessionId: string): Promise<{ cancelAccepted: boolean; queueCleared: boolean; idle: boolean; jobsSettled: boolean | 'unknown' }>
  /** One passive state read. A null queue stays `unknown`; it is not an empty queue. */
  watchSession?(sessionId: string): Promise<{ seq?: number; running?: boolean; queue?: 'empty' | 'pending' | 'unknown'; idle?: boolean }>
  /** Text of the latest assistant output, or undefined when none is readable. */
  latestReply(sessionId: string, maxChars: number): Promise<string | undefined>
  cwdOf(sessionId: string): Promise<string | undefined>

  // ---- dot's own session --------------------------------------------------
  /** Create dot's session under the subagent origin, running the given preset. */
  createDot(cwd: string, preset: string): Promise<string>
  /**
   * Create an internal, sidebar-hidden subagent session for a single background
   * pass (the reflection run). It keeps the host's default permissions: such a
   * pass needs no file system access at all.
   */
  createInternal(cwd: string, preset: string): Promise<string>
  /** Deliver one prompt to an internal session and wake it. */
  promptInternal(sessionId: string, text: string): Promise<void>
  /** Wait for the internal turn, cancelling and rejecting on timeout or failure. */
  waitIdle(sessionId: string, timeoutMs: number): Promise<void>
  /** Archive and let go of an internal session; its log stays readable. */
  releaseInternal(sessionId: string): Promise<void>
  /** Make dot's session live again. @returns false when it cannot serve as dot any more. */
  resumeDot(sessionId: string, preset: string): Promise<boolean>
  /** Transfer any open interactive `show_view` card from an ending segment to the new segment. */
  handoffView?(fromSessionId: string, toSessionId: string): boolean
  /** Let go of a segment dot has left; its log stays readable. */
  releaseDot(sessionId: string): Promise<void>
  /** The whole log of one of dot's segments, live or stored, oldest first. */
  readEvents(sessionId: string): Promise<RawEvent[]>
  /**
   * Ask dot's live session for a text answer to one instruction, outside its
   * log: the request is the session's own prompt and history plus the
   * instruction. Rejects when no answer came back.
   */
  summarize(sessionId: string, instruction: string, maxTokens: number, onUsage?: (usage: DotContextUsage) => void): Promise<string>
  /** The model dot's next segment would run on, as `provider/model@effort`; undefined when none is known. */
  modelKey(): string | undefined
  /** The human's message to dot, optionally carrying notices into the same turn; steers a running turn, starts one when idle. */
  say(sessionId: string, text: string, carriedNotices?: string, answer?: import('@klarkxy/dsh-deep-view/contracts').ViewAnswer, images?: readonly ChatImage[], notice?: ParsedNotice): Promise<void>
  /** Stop dot's current turn; queued messages stay. */
  stop(sessionId: string): Promise<void>
  /**
   * Point dot's next step at the chosen model, or at the current default when
   * none is chosen. A session remembers the last model it used, so this runs
   * before a delivery to a segment that keeps its model.
   */
  syncModel(sessionId: string): void
  /** Latest events of dot's live session, oldest first. */
  dotEvents(sessionId: string, limit: number): RawEvent[]
  /** Occupancy, composition, usage and compactions of dot's live session. */
  dotContext(sessionId: string): Promise<DotContextView>
  /** dot's session log grouped into turns and steps. */
  dotTrajectory(sessionId: string): TrajectoryView
  isRunning(sessionId: string): boolean
  /** Stop the agents this host created or resumed for dot. */
  dispose(): Promise<void>
}

type Get = (name: string) => unknown

interface Controller {
  create(request: Record<string, unknown>): Promise<{ sessionId: string }>
  prompt(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  cancel(request: { sessionId: string }): unknown
  list(request: Record<string, never>, signal: AbortSignal): Promise<{ items: readonly Record<string, unknown>[] }>
  resolveAgent(sessionId: string): Promise<{ agent: Agent } | { error: { message: string } }>
  state(request: { sessionId: string }, signal: AbortSignal): Promise<{ active: boolean; running: boolean; queue: readonly unknown[] | null; cursor: number }>
  selectModel(request: { sessionId: string; provider: string; model: string }): Promise<unknown>
  modelCatalog(): Promise<{
    readonly default?: { readonly provider?: unknown; readonly model?: unknown }
    readonly groups?: readonly { readonly id?: unknown; readonly models?: readonly { readonly id?: unknown; readonly name?: unknown }[] }[]
  }>
}

interface PresetRegistry {
  resolve(id?: string): Promise<{ id: string }>
  mount(ctx: unknown, id?: string): Promise<unknown>
  /** Default preset of a session created without one. */
  readonly defaultId?: string
  list?(): Promise<readonly { readonly id?: unknown; readonly name?: unknown; readonly description?: unknown; readonly broken?: unknown }[]>
}

interface DefaultModel { currentSelection(): { provider?: unknown; model?: unknown; reasoningEffort?: unknown } }

interface Registry {
  create(path: string, title?: string): Promise<{ id: string; path: string; title: string; sessionIds: readonly string[] }>
  list(): { id: string; path: string; title: string; sessionIds: readonly string[] }[]
  archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
  readonly archivedSessionIds?: readonly string[]
}

interface Query {
  readSession(sessionId: string): Promise<{ session: { cwd?: string }; events: readonly { type?: string; seq?: number; time?: number; data?: unknown }[] }>
  readTitleSnapshots?(ids: readonly string[], signal?: AbortSignal): Promise<readonly ({ status: 'fulfilled'; value: { title?: { title?: string } } } | { status: 'rejected' })[]>
}

interface Permissions { set(session: unknown, name: string): void; resolve?(name: string): { sandbox?: string }; current?(session: unknown): string; readonly defaultPreset?: string }

interface Projections { snapshot(session: unknown, keys?: readonly string[]): { values: ProjectionValues } }
interface Llm {
  resolveModelInfo(provider: string, model: string): Promise<{ context?: { contextWindow?: number } }>
  stream?(options: Record<string, unknown>): AsyncIterable<unknown>
}
interface ToolSetLike { dispose(): void }
interface ToolsService {
  resolve?(context: Record<string, unknown>): Promise<ToolSetLike>
  schemas?(scope?: unknown, toolSet?: unknown): unknown[]
}
interface SystemPromptService {
  assemble?(context?: Record<string, unknown>): Promise<AssembledPromptInput>
}
interface DeepViewService {
  handoffSession?(fromSessionId: string, toSessionId: string): boolean
}

const CONTEXT_KEYS = ['contextPressure', 'contextBreakdown', 'tokenUsage'] as const
/** A handoff note that takes longer than this is given up. */
const SUMMARY_TIMEOUT_MS = 120_000

export class HostUnavailable extends Error {
  constructor(what: string) { super(`${what} is unavailable on this host`); this.name = 'HostUnavailable' }
}

interface OwnedJob { id?: string; status?: string; owner?: string }
interface JobsApi {
  list?: (caller?: string) => readonly OwnedJob[]
  kill?: (id: string, caller?: string, reason?: string) => 'requested' | 'already-finished'
  wait?: (id: string, timeoutMs: number, caller?: string) => Promise<OwnedJob>
}
interface JobFact { owner?: string; settled: boolean; producerReported?: boolean }

/** rc.3 jobs live on `ctx.jobs`. Unowned jobs are public. A removed record still counts when its log says it did not settle. */
async function settleOwnedJobs(get: Get, sessionId: string, factsOf: () => Promise<ReadonlyMap<string, JobFact> | undefined>): Promise<boolean | 'unknown'> {
  const jobs = get('jobs') as JobsApi | undefined
  if (typeof jobs?.list !== 'function') return 'unknown'
  const terminal = (status?: string) => status === 'completed' || status === 'killed' || status === 'failed'
  const owned = (row: OwnedJob) => row.owner === sessionId
  try {
    let rows = jobs.list(sessionId).filter(owned)
    for (const row of rows) {
      if (!row.id || terminal(row.status)) continue
      try { jobs.kill?.(row.id, sessionId, 'run-stop') } catch { return 'unknown' }
      if (typeof jobs.wait === 'function') {
        try { await jobs.wait(row.id, 1_500, sessionId) } catch { return 'unknown' }
      }
    }
    rows = jobs.list(sessionId).filter(owned)
    if (rows.some(row => !row.id || !terminal(row.status))) return false
    const facts = await factsOf()
    if (!facts) return 'unknown'
    const ids = new Set<string>([...rows.map(row => row.id ?? ''), ...facts.keys()].filter(id => id.length > 0))
    for (const id of ids) {
      const fact = facts.get(id)
      if (!fact?.settled || fact.producerReported !== true) return false
    }
    return true
  } catch { return 'unknown' }
}

/** @param modelOf - dot's chosen model, read on every model call; undefined follows the host default. */
export function bindHost(get: Get, log?: (message: string) => void, modelOf?: () => ModelChoice | undefined, seal?: (agent: Agent) => void): DotHost {
  const need = <T,>(name: string): T => {
    const value = get(name) as T | undefined
    if (!value) throw new HostUnavailable(name)
    return value
  }
  const controller = () => need<Controller>('sessionController')
  const registry = () => need<Registry>('workspaceRegistry')
  const query = () => need<Query>('sessionQuery')
  const agents = () => need<AgentRegistry>('agents')
  const handles = new Map<string, AgentHandle>()
  /** Incremental log scans of dot's sessions, so the context page reads only new events. */
  const scans = new Map<string, ContextScan>()
  const windows = new Map<string, number>()

  const registryAgent = (sessionId: string): Agent | undefined => agents().get(sessionId as SessionId)
  /** Live agent of any session: dot's is read straight from the registry, since the controller refuses subagent-origin sessions. */
  const liveAgent = async (sessionId: string): Promise<Agent> => {
    const listed = registryAgent(sessionId)
    if (listed) return listed
    const resolved = await controller().resolveAgent(sessionId)
    if ('error' in resolved) throw new Error(resolved.error.message)
    return resolved.agent
  }
  const agentOptions = (): AgentOptions => {
    const defaults = need<DefaultModel>('agentDefaultModel')
    return {
      get provider() { return modelOf?.()?.provider ?? defaults.currentSelection().provider },
      get model() { return modelOf?.()?.model ?? defaults.currentSelection().model },
      get reasoningEffort() {
        const chosen = modelOf?.()
        return chosen ? chosen.reasoningEffort : defaults.currentSelection().reasoningEffort
      },
    } as AgentOptions
  }
  // Same composition the controller uses for its own sessions: model selection, then the preset.
  const setupFor = async (preset: string, allow: readonly string[]) => {
    const presets = need<PresetRegistry>('agentPresets')
    const id = (await presets.resolve(preset)).id
    return {
      id,
      setup: async (agentCtx: unknown, agent: Agent) => {
        installModelSelection(agentCtx as never)
        await presets.mount(agentCtx, id)
        if (allow === DOT_INHERITED_ALLOW) await dotDevIndexReady()
        // Visibility gate on the agent scope, after the preset mounted its
        // tools: restricting the preset scope instead would also hide the
        // preset's own tools from this agent child scope (the one assembling
        // the request), leaving the model with no tool list at all. The allow
        // list must wait for the late dev-index row: restrict keeps a
        // snapshot, so a name registered after the call would stay hidden.
        // The agent scope's key is the Agent itself — the host builds the
        // scope as `createScope(loopCtx, agent)` — so the supported setup
        // parameter names it, and nothing here has to read a scope tag through
        // a possibly duplicated dsh-scope copy.
        restrictInheritedTools(agentCtx, allow, agent)
      },
    }
  }
  const permit = (session: unknown, preset: string): boolean => {
    const permissions = get('permissionPresets') as Permissions | undefined
    if (!permissions || session === undefined) return false
    try { permissions.set(session, preset); return true } catch (error) {
      log?.(`dsh-dot: permission preset ${preset} not applied: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  const toRow = (w: { id: string; path: string; title: string; sessionIds: readonly string[] }): WorkspaceRow =>
    ({ id: w.id, path: w.path, title: w.title, sessionCount: w.sessionIds.length })
  /** dot's chosen model, or the host default it follows. */
  const wantedModel = (): { provider: string; model: string; reasoningEffort?: string } | undefined => {
    const chosen = modelOf?.()
    const fallback = (get('agentDefaultModel') as DefaultModel | undefined)?.currentSelection()
    const provider = chosen?.provider ?? (typeof fallback?.provider === 'string' ? fallback.provider : undefined)
    const model = chosen?.model ?? (typeof fallback?.model === 'string' ? fallback.model : undefined)
    if (!provider || !model) return undefined
    const effort = chosen ? chosen.reasoningEffort : typeof fallback?.reasoningEffort === 'string' ? fallback.reasoningEffort : undefined
    return { provider, model, ...effort ? { reasoningEffort: effort } : {} }
  }

  return {
    listWorkspaces: () => registry().list().map(toRow),
    createWorkspace: async (path, title) => toRow(await registry().create(path, title)),
    async listSessions(signal) {
      const archived = new Set(registry().archivedSessionIds ?? [])
      const { items } = await controller().list({}, signal)
      return items.map(item => ({
        sessionId: String(item.sessionId),
        ...typeof item.cwd === 'string' ? { cwd: item.cwd } : {},
        running: item.running === true,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
        blank: item.blank === true,
        subagent: item.origin === 'subagent' || typeof item.parentSessionId === 'string',
        archived: archived.has(String(item.sessionId)),
      }))
    },
    async titles(sessionIds, signal) {
      const out = new Map<string, string>()
      const read = query().readTitleSnapshots
      if (typeof read !== 'function' || sessionIds.length === 0) return out
      const results = await read.call(query(), sessionIds, signal)
      results.forEach((result, index) => {
        const title = result.status === 'fulfilled' ? result.value.title?.title : undefined
        if (title) out.set(sessionIds[index]!, title)
      })
      return out
    },
    async createSession(place) {
      const created = await controller().create({
        ...(place.sessionId ? { sessionId: place.sessionId } : {}),
        ...(place.workspaceId ? { workspaceId: place.workspaceId } : { cwd: place.cwd }),
        ...(place.preset ? { agentPreset: place.preset } : {}),
      })
      // Seal before the caller prompts. A session with no live agent is not returned as ready.
      if (seal) seal(await liveAgent(created.sessionId))
      return created.sessionId
    },
    async prepareOwnedSession(sessionId) {
      if (!seal) return
      seal(await liveAgent(sessionId))
    },
    async listPresets() {
      const registry = need<PresetRegistry>('agentPresets')
      if (typeof registry.list !== 'function') throw new HostUnavailable('agentPresets.list')
      const presets: CatalogPreset[] = []
      for (const entry of await registry.list()) {
        if (typeof entry.id !== 'string' || !entry.id) continue
        // The reflection preset is internal; dot must not pick it as a task preset.
        if (entry.id === REFLECTION_PRESET_ID) continue
        presets.push({
          id: entry.id,
          ...typeof entry.name === 'string' && entry.name ? { name: entry.name } : {},
          ...typeof entry.description === 'string' && entry.description ? { description: entry.description } : {},
          ...typeof entry.broken === 'string' && entry.broken ? { broken: entry.broken } : {},
        })
      }
      const fallback = registry.defaultId
      return { presets, ...typeof fallback === 'string' && fallback ? { fallback } : {} }
    },
    async listModels() {
      const catalog = await controller().modelCatalog()
      const models: CatalogModel[] = []
      for (const group of catalog.groups ?? []) {
        if (typeof group.id !== 'string' || !group.id) continue
        for (const entry of group.models ?? []) {
          if (typeof entry.id !== 'string' || !entry.id) continue
          models.push({ provider: group.id, model: entry.id, name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id })
        }
      }
      const fallback = catalog.default
      return {
        models,
        ...typeof fallback?.provider === 'string' && fallback.provider && typeof fallback.model === 'string' && fallback.model ? { fallback: { provider: fallback.provider, model: fallback.model } } : {},
      }
    },
    async selectModel(sessionId, choice) {
      await controller().selectModel({ sessionId, provider: choice.provider, model: choice.model })
    },
    async setPermission(sessionId, preset) {
      try { return permit((await liveAgent(sessionId)).session, preset) } catch { return false }
    },
    async verifyTaskPermission(sessionId, access, preset) {
      try {
        const session = (await liveAgent(sessionId)).session
        if (access === 'read') {
          const sandbox = get('sandboxPolicy') as { resolve(request: { session: unknown }): { mode?: string } } | undefined
          const approval = get('approval') as { overrideOf(session: unknown): string | undefined } | undefined
          return sandbox?.resolve({ session }).mode === 'read-only' && approval?.overrideOf(session) === 'never'
        }
        const permissions = get('permissionPresets') as Permissions | undefined
        const selected = preset === 'default' ? permissions?.defaultPreset : preset
        if (!selected || !permissions?.resolve || !permissions.current) return false
        const sandbox = permissions.resolve(selected).sandbox
        return (sandbox === 'workspace-write' || sandbox === 'danger-full-access') && permissions.current(session) === selected
      } catch { return false }
    },
    async setWritable(sessionId, preset) {
      try {
        const permissions = get('permissionPresets') as Permissions | undefined
        const selected = preset === 'default' ? permissions?.defaultPreset : preset
        if (!selected || !permissions?.resolve) return false
        const sandbox = permissions.resolve(selected).sandbox
        if (sandbox !== 'workspace-write' && sandbox !== 'danger-full-access') return false
        return permit((await liveAgent(sessionId)).session, selected)
      } catch (error) {
        log?.(`dsh-dot: writable permission not applied: ${String(error)}`)
        return false
      }
    },
    async setReadOnly(sessionId) {
      try {
        const session = (await liveAgent(sessionId)).session
        const approval = await import('@deepseek-ai/dsh-user-approval')
        const presets = get('permissionPresets') as Permissions | undefined
        let hasReadOnlyPreset = false
        try { hasReadOnlyPreset = presets?.resolve?.('read-only').sandbox === 'read-only' } catch { /* use the sandbox setter */ }
        if (!(hasReadOnlyPreset && permit(session, 'read-only'))) {
          const sandbox = await import('@deepseek-ai/dsh-sandbox-policy')
          sandbox.setSandboxMode(session as Parameters<typeof sandbox.setSandboxMode>[0], 'read-only')
        }
        approval.setApprovalPolicy(session as Parameters<typeof approval.setApprovalPolicy>[0], 'never')
        return true
      } catch (error) {
        log?.(`dsh-dot: read-only policy not applied: ${String(error)}`)
        return false
      }
    },
    async findSession(sessionId) {
      const { items } = await controller().list({}, AbortSignal.timeout(10_000))
      const found = items.find(item => String(item.sessionId) === sessionId)
      if (!found) return undefined
      let cwd = typeof found.cwd === 'string' ? found.cwd : undefined
      let preset = typeof found.agentPreset === 'string' ? found.agentPreset : undefined
      if (cwd === undefined || preset === undefined) {
        try {
          const stored = await query().readSession(sessionId) as { session?: { cwd?: string; agentPreset?: string }; header?: { agentPreset?: string } }
          if (cwd === undefined && typeof stored.session?.cwd === 'string') cwd = stored.session.cwd
          const storedPreset = stored.session?.agentPreset ?? stored.header?.agentPreset
          if (preset === undefined && typeof storedPreset === 'string') preset = storedPreset
        } catch { /* the list row is still enough to know the session exists */ }
      }
      return {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(preset !== undefined ? { preset } : {}),
      }
    },
    async prompt(sessionId, text, mode, signal, requestId) {
      await controller().prompt({ requestId: requestId ?? randomUUID(), sessionId, mode, content: [{ type: 'text', text }] }, signal)
    },
    async relay(targetId, senderId, text, deliveryId, confirm, notice) {
      const agent = await liveAgent(targetId)
      if (confirm && !confirm()) throw new Error(`session ${targetId} closed before followup`)
      const source = { kind: 'agent-message', form: 'relay', senderSessionId: senderId as SessionId, ...(deliveryId ? { deliveryId } : {}), ...notice ? { dshDot: { notices: notice } } : {} } as MessageSource
      agent.followup(createUserMessage({ content: [{ type: 'text' as const, text }], source }))
    },
    async cancel(sessionId) { await controller().cancel({ sessionId }) },
    async cancelAndWait(sessionId, timeoutMs) {
      try {
        const agent = registryAgent(sessionId)
        if (!agent) return false
        agent.cancel({ kind: 'user' }, { keepInbox: false })
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const settled = await Promise.race([agent.whenIdle().then(() => true, () => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })])
          return settled && agent.status === 'idle'
        } finally { if (timer !== undefined) clearTimeout(timer) }
      } catch { return false }
    },
    async archive(sessionId) { await registry().archiveSession(sessionId, { stopActivity: true }) },
    async stopActivity(sessionId) {
      // Read only the live registry: resolving a cold session would resume it.
      let agent: Agent | undefined
      let observed = false
      let cancelAccepted = false
      let waited = false
      try {
        agent = registryAgent(sessionId)
        observed = true
        if (agent) {
          agent.cancel({ kind: 'user' }, { keepInbox: false })
          cancelAccepted = true
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            // Maintenance keeps status idle, so always wait for quiescence.
            waited = await Promise.race([
              agent.whenIdle().then(() => true, () => false),
              new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1_500) }),
            ])
          } finally { if (timer !== undefined) clearTimeout(timer) }
        }
      } catch { /* failed lookup, cancellation, or wait cannot prove idle */ }
      const jobsSettled = await settleOwnedJobs(get, sessionId, async () => {
        const facts = new Map<string, JobFact>()
        try {
          const stored = await query().readSession(sessionId) as { events?: readonly { type?: string; data?: { jobId?: string; owner?: string; producerReported?: boolean } }[] }
          for (const event of stored.events ?? []) {
            const jobId = event.data?.jobId
            const owner = event.data?.owner
            if (typeof jobId !== 'string' || owner !== sessionId) continue
            if (event.type === 'job/registered') {
              const previous = facts.get(jobId)
              facts.set(jobId, { owner, settled: previous?.settled ?? false, ...(previous?.producerReported !== undefined ? { producerReported: previous.producerReported } : {}) })
            } else if (event.type === 'job/settled' && typeof event.data?.producerReported === 'boolean') {
              facts.set(jobId, { owner, settled: true, producerReported: event.data.producerReported })
            }
          }
        } catch { return undefined }
        return facts
      })
      // Only a post-settlement sample and the same registry entry prove this stop.
      let queueCleared = false
      let idle = false
      try {
        const state = await controller().state({ sessionId }, AbortSignal.timeout(10_000))
        const current = registryAgent(sessionId)
        if (observed && current === agent) {
          if (agent) {
            queueCleared = state.queue !== null && state.queue.length === 0
            idle = waited && agent.status === 'idle' && state.running === false
          } else if (state.active === false && state.running === false && state.queue === null) {
            cancelAccepted = true
            queueCleared = true
            idle = true
          }
        }
      } catch { /* an unread final state cannot release a writer */ }
      return { cancelAccepted, queueCleared, idle, jobsSettled }
    },
    async watchSession(sessionId) {
      try {
        const state = await controller().state({ sessionId }, AbortSignal.timeout(10_000))
        const queue = state.queue === null ? 'unknown' as const : state.queue.length === 0 ? 'empty' as const : 'pending' as const
        return { queue, seq: state.cursor, running: state.running, idle: !state.running }
      } catch { return { queue: 'unknown' as const } }
    },
    async latestReply(sessionId, maxChars) {
      const log = await query().readSession(sessionId)
      for (let index = log.events.length - 1; index >= 0; index--) {
        const event = log.events[index]!
        if (event.type !== 'assistant/message') continue
        const text = extractSessionEventText(event as Parameters<typeof extractSessionEventText>[0]).trim()
        if (text) return text.length > maxChars ? text.slice(-maxChars) : text
      }
      return undefined
    },
    async cwdOf(sessionId) {
      try { return (await query().readSession(sessionId)).session.cwd } catch { return undefined }
    },

    async createDot(cwd, preset) {
      await mkdir(cwd, { recursive: true })
      const { id, setup } = await setupFor(preset, preset === REFLECTION_PRESET_ID ? REFLECTION_ALLOW : DOT_INHERITED_ALLOW)
      const sessionId = `session-${randomUUID()}` as SessionId
      const handle = await agents().create({ sessionId, agentOptions: agentOptions(), meta: { cwd, origin: 'subagent', agentPreset: id }, setup })
      handles.set(sessionId, handle)
      // dot has no file or shell tools; its own calls never need a human approval.
      permit(handle.agent.session, FULL_ACCESS)
      return sessionId
    },
    async createInternal(cwd, preset) {
      await mkdir(cwd, { recursive: true })
      const { id, setup } = await setupFor(preset, REFLECTION_ALLOW)
      const sessionId = `session-${randomUUID()}` as SessionId
      // A reflection pass needs no file system or shell access, so it keeps the
      // host's default permissions instead of dot's full access.
      const handle = await agents().create({ sessionId, agentOptions: agentOptions(), meta: { cwd, origin: 'subagent', agentPreset: id }, setup })
      handles.set(sessionId, handle)
      return sessionId
    },
    async promptInternal(sessionId, text) {
      const agent = await liveAgent(sessionId)
      const message = createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' } as MessageSource })
      if (agent.status === 'idle') agent.followup(message)
      else agent.steer(message)
    },
    async waitIdle(sessionId, timeoutMs) {
      const agent = await liveAgent(sessionId)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          agent.whenIdle(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              try { agent.cancel({ kind: 'user' }, { keepInbox: false }) }
              catch (error) { reject(error); return }
              reject(new Error(`session ${sessionId} did not become idle within ${timeoutMs}ms`))
            }, timeoutMs)
          }),
        ])
      } finally { if (timer !== undefined) clearTimeout(timer) }
    },
    async releaseInternal(sessionId) {
      scans.delete(sessionId)
      try {
        await registry().archiveSession(sessionId, { stopActivity: true })
      } catch (error) {
        log?.(`dsh-dot: internal session ${sessionId} was not archived: ${error instanceof Error ? error.message : String(error)}`)
      }
      const handle = handles.get(sessionId)
      if (!handle) return
      handles.delete(sessionId)
      await handle.dispose()
    },
    async resumeDot(sessionId, preset) {
      const live = registryAgent(sessionId)
      if (live) return live.session.header.origin === 'subagent'
      try {
        const { setup } = await setupFor(preset, preset === REFLECTION_PRESET_ID ? REFLECTION_ALLOW : DOT_INHERITED_ALLOW)
        const handle = await agents().resume({ resumeSessionId: sessionId as SessionId, agentOptions: agentOptions(), setup })
        handles.set(sessionId, handle)
        if (handle.agent.session.header.origin === 'subagent') return true
        // An earlier build kept dot in an ordinary session; hand that one back to the host.
        handles.delete(sessionId)
        await handle.dispose().catch(() => {})
        return false
      } catch (error) {
        log?.(`dsh-dot: could not resume dot's session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
    async say(sessionId, text, carriedNotices, answer, images, notice) {
      const agent = await liveAgent(sessionId)
      const content = carriedNotices ? `${carriedNotices}\n\n${text}` : text
      // The character count lets the panel and history split the carried notices
      // back out without storing a second copy of their text in the source.
      const source = { kind: 'user', ...answer ? { deepView: { owner: 'dsh-deep-view', version: 1, answer } } : {}, ...carriedNotices || notice ? { dshDot: { ...carriedNotices ? { carriedChars: carriedNotices.length } : {}, ...notice ? { notices: notice } : {} } } : {} } as MessageSource
      const pictures = checkChatImages(images)
      let blocks: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: unknown }> = []
      if (content.length > 0 || pictures.length === 0) blocks.push({ type: 'text', text: content })
      if (pictures.length > 0) {
        const attachments = get('attachments') as { admitPromptContent?(content: readonly unknown[]): Promise<Array<{ type: string; text?: string; attachment?: unknown }>> } | undefined
        if (typeof attachments?.admitPromptContent !== 'function') throw new Error('image input is unavailable on this host')
        const admitted = await attachments.admitPromptContent([
          ...blocks,
          ...pictures.map(image => ({ type: 'image' as const, mediaType: image.mediaType, data: image.data, ...(image.name ? { name: image.name } : {}) })),
        ])
        blocks = admitted.filter(part => part.type === 'text' || part.type === 'image').map(part => part.type === 'text'
          ? { type: 'text' as const, text: part.text ?? '' }
          : { type: 'image' as const, attachment: part.attachment })
      }
      const message = createUserMessage({ content: blocks as [{ type: 'text'; text: string }], source })
      if (agent.status === 'idle') agent.followup(message)
      else agent.steer(message)
      if (answer) {
        // The answer facts and readable reply share one session message. Once
        // appended it must not be sent twice, even if its checkpoint fails.
        const sessions = get('sessions') as { flush(session: Session): Promise<boolean> } | undefined
        try { await sessions?.flush(agent.session) } catch (error) { log?.(`dsh-dot: answer message checkpoint failed: ${String(error)}`) }
      }
    },
    async stop(sessionId) {
      (await liveAgent(sessionId)).cancel({ kind: 'user' }, { keepInbox: true })
    },
    handoffView(fromSessionId, toSessionId) {
      try {
        return (get('dshDeepView') as DeepViewService | undefined)?.handoffSession?.(fromSessionId, toSessionId) ?? false
      } catch {
        return false
      }
    },
    async releaseDot(sessionId) {
      scans.delete(sessionId)
      const handle = handles.get(sessionId)
      if (!handle) return
      handles.delete(sessionId)
      await handle.dispose()
    },
    async readEvents(sessionId) {
      const session = registryAgent(sessionId)?.session
      if (session) {
        const out: RawEvent[] = []
        for (let seq = 0; seq < session.seq; seq++) {
          const event = session.eventAt(seq as SessionSeq)
          if (event) out.push(event)
        }
        return out
      }
      const stored = await query().readSession(sessionId)
      return stored.events.filter((event): event is RawEvent => typeof event.type === 'string')
    },
    async summarize(sessionId, instruction, maxTokens, onUsage) {
      const session = registryAgent(sessionId)?.session
      const llm = get('llm') as Llm | undefined
      if (!session) throw new Error('the session is not live')
      if (typeof llm?.stream !== 'function') throw new HostUnavailable('llm')
      const header = session.requestHeader()
      const config = header?.config
      if (!config?.provider || !config.model) throw new Error('the session has not made a model request yet')
      const assembler = new BlockAssembler()
      const stream = llm.stream({
        provider: config.provider,
        model: config.model,
        messages: [...session.deriveMessages(), { role: 'user', content: [{ type: 'text', text: instruction }] }],
        toolHistory: session.toolHistory(),
        ...header?.tools ? { tools: [...header.tools] } : {},
        maxTokens,
        sessionId: session.id,
        purpose: 'compaction',
        signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      })
      for await (const chunk of stream) assembler.push(chunk as Parameters<BlockAssembler['push']>[0])
      const finish = assembler.finish as { kind: string; failure?: { message?: string } }
      if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure?.message ?? `the request ended with ${finish.kind}`)
      const usage = assembler.usage as { inputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown; outputTokens?: unknown } | undefined
      const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
      if (usage && (typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number')) {
        onUsage?.({
          input: num(usage.inputTokens),
          cacheRead: num(usage.cacheReadTokens),
          cacheWrite: num(usage.cacheWriteTokens),
          output: num(usage.outputTokens),
        })
      }
      const text = assembler.blocks().map(block => { const row = block as { type?: string; text?: unknown }; return row.type === 'text' && typeof row.text === 'string' ? row.text : '' }).join('').trim()
      if (!text) throw new Error('the model returned no text')
      return text
    },
    modelKey() {
      const wanted = wantedModel()
      return wanted ? `${wanted.provider}/${wanted.model}@${wanted.reasoningEffort ?? ''}` : undefined
    },
    syncModel(sessionId) {
      const model = registryAgent(sessionId)?.model
      const wanted = wantedModel()
      if (!model || !wanted) return
      const current = model.current()
      if (current?.provider === wanted.provider && current.model === wanted.model && current.reasoningEffort === wanted.reasoningEffort) return
      try { model.select(wanted as Parameters<typeof model.select>[0]) } catch (error) {
        log?.(`dsh-dot: could not switch dot's model: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    dotEvents(sessionId, limit) {
      const session = registryAgent(sessionId)?.session
      if (!session) return []
      const out: RawEvent[] = []
      for (let seq = Math.max(0, session.seq - limit); seq < session.seq; seq++) {
        const event = session.eventAt(seq as SessionSeq)
        if (event) out.push(event)
      }
      return out
    },
    async dotContext(sessionId) {
      const agent = registryAgent(sessionId)
      const session = agent?.session
      if (!session) return { live: false, compactions: 0 }
      let scan = scans.get(sessionId) ?? EMPTY_SCAN
      if (scan.seq > session.seq) scan = EMPTY_SCAN
      if (scan.seq < session.seq) {
        const from = scan.seq
        const events = function* () { for (let seq = from; seq < session.seq; seq++) { const event = session.eventAt(seq as SessionSeq); if (event) yield event } }
        scan = foldScan(scan, events(), session.seq)
        scans.set(sessionId, scan)
      }
      // Before dot's first request the log names no model yet; the selected one stands in.
      const selected = agent?.model?.current() ?? wantedModel()
      if ((!scan.provider || !scan.model) && selected?.provider && selected.model) {
        scan = { ...scan, provider: selected.provider, model: selected.model }
      }
      let values: ProjectionValues = {}
      try { values = (get('sessionProjections') as Projections | undefined)?.snapshot(session, CONTEXT_KEYS).values ?? {} } catch (error) {
        log?.(`dsh-dot: context projections unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
      // Before step 1 writes `system/message` and `request/header`, assemble the live prompt and tools so a fresh segment never appears empty.
      let preTurn: PreTurnContext | undefined
      if (!scan.surface?.nodes.some(node => node.category === 'system' || node.category === 'tools')) {
        const systemPrompt = get('systemPrompt') as SystemPromptService | undefined
        const toolsService = get('tools') as ToolsService | undefined
        if (systemPrompt?.assemble || toolsService?.schemas) {
          const signal = AbortSignal.timeout(5_000)
          const modelSelection = selected?.provider && selected.model
            ? { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) }
            : undefined
          let toolSet: ToolSetLike | undefined
          try {
            if (typeof toolsService?.resolve === 'function') {
              toolSet = await toolsService.resolve({ agent, ...(modelSelection ? { modelSelection } : {}), signal })
            }
            const assembled = typeof systemPrompt?.assemble === 'function'
              ? await systemPrompt.assemble({
                  ...assembleContextFor(agent as never, signal),
                  ...(modelSelection ? { modelSelection } : {}),
                  ...(toolSet ? { toolSet } : {}),
                })
              : undefined
            const tools = assembled?.tools && assembled.tools.length > 0
              ? assembled.tools
              : typeof toolsService?.schemas === 'function' ? toolsService.schemas(agent, toolSet) : []
            preTurn = assembledSurface({ ...assembled, tools })
          } catch (error) {
            log?.(`dsh-dot: pre-turn context assembly unavailable: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            try { toolSet?.dispose() } catch { /* best-effort cleanup */ }
          }
        }
      }
      // Before the first request records its window, ask the model adapter.
      let fallback: number | undefined
      const pressure = values.contextPressure as { contextWindow?: unknown } | undefined
      if (typeof pressure?.contextWindow !== 'number' && scan.provider && scan.model) {
        const key = `${scan.provider}/${scan.model}`
        fallback = windows.get(key)
        const llm = get('llm') as Llm | undefined
        if (fallback === undefined && llm) {
          try {
            const window = (await llm.resolveModelInfo(scan.provider, scan.model)).context?.contextWindow
            if (typeof window === 'number') { fallback = window; windows.set(key, window) }
          } catch { /* the page shows occupancy without a window */ }
        }
      }
      return contextView(scan, values, fallback, preTurn)
    },
    dotTrajectory(sessionId) {
      const session = registryAgent(sessionId)?.session
      if (!session) return { sessionId, turns: [], earlier: 0 }
      const events = function* () { for (let seq = 0; seq < session.seq; seq++) { const event = session.eventAt(seq as SessionSeq); if (event) yield event } }
      return { sessionId, ...foldTrajectory(events()) }
    },
    isRunning(sessionId) {
      const status = registryAgent(sessionId)?.status
      return status !== undefined && status !== 'idle'
    },
    async dispose() {
      const owned = [...handles.values()]
      handles.clear()
      await Promise.allSettled(owned.map(handle => handle.dispose()))
    },
  }
}
