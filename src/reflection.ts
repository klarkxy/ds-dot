/**
 * The background reflection pass ("dream"): a silent, private subagent session
 * that reviews the recent collaboration between the human and dot, then
 * rewrites dot's own cognition. It is intentionally narrow:
 *
 * - it never does work and never talks to the human;
 * - its preset mounts only the two read-only history tools and one submission
 *   tool, never `dot_agreement` (the agreements are the human's words and must
 *   not be edited by reflection);
 * - it runs under a hidden `origin: 'subagent'` session, so the sidebar leaves
 *   it out, the ledger never counts it, and its log is a normal trajectory that
 *   is archived when it ends.
 *
 * This module also holds the pure trigger gate and the runner that drives one
 * pass. The root service owns a single {@link ReflectionRunner}; the reminder
 * clock calls {@link ReflectionRunner.tick} on its periodic check. The child
 * plugin at the bottom is the reflection preset's tool row (`reflect` entry).
 *
 * All tool parameter schemas are flat (plain object + scalar / enum fields), for
 * the same bridge-compatibility reason as tools.ts.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SERVICE_NAME, TOOL, type ReflectionRun } from './contracts.ts'
import type { DotHost } from './host.ts'
import type { DotStore } from './store.ts'
import { gateToolExecution } from './tool-scope.ts'

/** The internal preset the reflection session runs on. Kept out of the task preset roster. */
export const REFLECTION_PRESET_ID = 'dot-reflection'
/** The reflection-only submission tool. Not part of dot's public tools. */
export const REFLECTION_SUBMIT_TOOL = 'dot_reflection_submit'
/** Names the reflection agent scope may see: its own three tools only. */
export const REFLECTION_ALLOW = [TOOL.searchHistory, TOOL.readHistory, REFLECTION_SUBMIT_TOOL] as const

/** One reflection pass runs at most this long before it is treated as failed. */
export const REFLECTION_TIMEOUT_MS = 10 * 60_000
/** At most one successful reflection pass per day. */
export const REFLECTION_INTERVAL_MS = 86_400_000
/** After a failed attempt, wait this long before trying again. */
export const REFLECTION_FAILURE_COOLDOWN_MS = 7_200_000

/**
 * dot's standing instructions for the reflection session. Model-facing English,
 * like the dot persona; the human never sees this.
 */
export const REFLECTION_INSTRUCTIONS = [
  "You are dot's private background reflection pass: a silent job that reviews recent collaboration between the human and dot, then updates dot's [cognition] so she understands both the human and herself better.",
  'You are not addressing the human. Emit no chat reply — inspect the record quietly, submit once, and end the turn.',
  `Inspect actual messages via ${TOOL.searchHistory} and ${TOOL.readHistory} before changing anything; trust the recorded transcript over assumptions.`,
  `You may rewrite only [cognition] by calling ${REFLECTION_SUBMIT_TOOL} once with the full replacement text. Never add, remove, or reword [agreements]: agreements are the human's exact standing rules and only the human edits them.`,
  'When any [agreements] entries appear outdated or mutually contradictory, summarize the issue briefly in agreementNotes so dot can raise it with the human next time. Never ask the human directly.',
  'Keep [cognition] concise, durable, and split into two parts: (1) what she understands about the human and how best to collaborate with them, and (2) what she understands about herself — preferences formed here, shared jokes, and what they have accomplished together. Preserve useful entries about herself alongside insights about the human. Exclude transient task details, one-off status notes, or facts easily retrieved from history.',
].join('\n')

/** The gate inputs, all read live from the store and the host at check time. */
export interface ReflectionGate {
  readonly now: number
  readonly enabled: boolean
  readonly lastReflectedAt?: number
  readonly lastReflectionAttemptAt?: number
  /** Whether the latest attempt failed; set when an attempt starts, cleared by a submission. */
  readonly reflectionAttemptFailed?: boolean
  readonly lastConversationAt?: number
  /** dot has no turn running right now. */
  readonly dotIdle: boolean
}

/**
 * Whether a reflection pass should start now. Every condition is a hard gate:
 * enabled, a full day since the last success, new conversation since then, no
 * failure cooldown, and an idle dot. Concurrency is enforced by the runner.
 */
export function reflectionDue(input: ReflectionGate): boolean {
  if (!input.enabled || !input.dotIdle) return false
  const lastSuccess = input.lastReflectedAt ?? 0
  if (input.now - lastSuccess < REFLECTION_INTERVAL_MS) return false
  // The attempt flag, not a timestamp comparison, decides "last attempt failed":
  // a new attempt can share its millisecond with the previous success.
  if (input.reflectionAttemptFailed === true
    && input.lastReflectionAttemptAt !== undefined
    && input.now - input.lastReflectionAttemptAt < REFLECTION_FAILURE_COOLDOWN_MS) return false
  const conversation = input.lastConversationAt ?? 0
  if (!(conversation > lastSuccess)) return false
  return true
}

/** The private instruction the runner hands the reflection session. */
export function buildReflectionInstruction(input: { readonly agreements: string; readonly cognition: string; readonly lastReflectedAt?: number; readonly now: number }): string {
  const since = input.lastReflectedAt !== undefined ? new Date(input.lastReflectedAt).toISOString() : 'the beginning'
  const agreements = input.agreements.trim() || '(none yet)'
  const cognition = input.cognition.trim() || '(none yet)'
  return [
    "Run dot's private background reflection pass now. The human is not present; do not write a chat reply.",
    `Review collaboration between the human and dot since ${since} using ${TOOL.searchHistory} and ${TOOL.readHistory} (including dot's own conversation segments), then bring [cognition] up to date.`,
    '',
    "[agreements] (the human's standing rules — strictly read-only; never change these):",
    agreements,
    '',
    "[cognition] (dot's evolving understanding — rewrite as a complete block):",
    cognition,
    '',
    `Call ${REFLECTION_SUBMIT_TOOL} exactly once with the complete updated cognition. Keep it concise and retain what still holds across both parts: what she understands about the human and their working style, and what she understands about herself — preferences formed here, shared jokes, and what they have accomplished together. Omit transient task details and facts that can be looked up on demand.`,
    'Check [agreements] for stale or conflicting entries; if you find any, pass a brief note in agreementNotes on the same call so dot can surface it to the human next turn. Never edit [agreements] yourself.',
    'If no updates are needed, submit the existing cognition text unchanged and omit agreementNotes.',
  ].join('\n')
}

export interface ReflectionRunnerOptions {
  readonly host: DotHost
  readonly store: DotStore
  /** Working directory of dot's own workspace; the reflection session lives there too. */
  readonly homeDir: string
  readonly now: () => number
  /** Write dot's cognition through the same validated path a human edit uses. */
  readonly applyCognition: (text: string, baseVersion: number) => Promise<unknown>
  /** dot must not be mid-turn when a pass starts. */
  readonly isDotIdle: () => boolean
  readonly timeoutMs?: number
  readonly log?: (message: string) => void
}

interface ActiveRun { readonly sessionId: string; readonly baseVersion: number; submitted: boolean }

/**
 * Drives one background reflection pass at a time. `tick` decides whether a
 * pass is due and starts it without blocking the clock; the pass itself waits
 * for its session to go idle, then archives it. The submission tool calls
 * {@link submit} from inside the pass.
 */
export class ReflectionRunner {
  private busy = false
  private disposed = false
  private active: ActiveRun | undefined
  private activeRun: Promise<void> | undefined

  constructor(private readonly options: ReflectionRunnerOptions) {}

  /** Whether a pass is running (the concurrency ceiling). */
  get running(): boolean { return this.busy }

  /** Check the gate and start a pass. @returns whether one was started. */
  async tick(): Promise<boolean> {
    if (this.busy || this.disposed) return false
    const store = this.options.store
    const due = reflectionDue({
      now: this.options.now(),
      enabled: store.settings.reflection,
      lastReflectedAt: store.lastReflectedAt,
      lastReflectionAttemptAt: store.lastReflectionAttemptAt,
      reflectionAttemptFailed: store.reflectionAttemptFailed,
      lastConversationAt: store.lastConversationAt,
      dotIdle: this.options.isDotIdle(),
    })
    if (!due) return false
    this.busy = true
    // Deliberately fire-and-forget: the clock must not wait on a model turn.
    this.activeRun = this.run().catch(() => undefined).finally(() => { this.busy = false })
    return true
  }

  /**
   * Save the pass's result. Called by the submission tool, which passes the id
   * of the session that issued the call: a stale pass, or another session that
   * happens to run the same preset, must not write into the current run.
   */
  async submit(cognition: string, agreementNotes: string | undefined, sessionId: string): Promise<string> {
    if (this.disposed) throw new Error('the reflection runner was disposed')
    const active = this.active
    if (!active) throw new Error('no reflection pass is running')
    if (!sessionId || active.sessionId !== sessionId) throw new Error('this call did not come from the running reflection pass')
    if (active.submitted) return 'This reflection was already saved.'
    const store = this.options.store
    const now = this.options.now()
    // Keep the original attempt start so a failed write still cools down for 2h.
    const attemptAt = store.lastReflectionAttemptAt ?? now
    const priorReflectedAt = store.lastReflectedAt
    try {
      if (store.cognitionVersion !== active.baseVersion) throw new Error('cognition changed since this reflection started; discard the stale result')
      await this.options.applyCognition(cognition, active.baseVersion)
      if (agreementNotes?.trim()) await store.setAgreementNotes(agreementNotes)
      // Trajectory bookkeeping first; the 24h success gate (lastReflectedAt) is
      // written last, so a failure after it cannot count as a successful pass.
      await store.finishReflectionRun(active.sessionId, now, true)
      await store.markReflected(now)
      active.submitted = true
      return 'Reflection saved. End your turn now.'
    } catch (error) {
      // Any failed write keeps the attempt failed and undoes a success time it
      // may have left behind, so the next try waits the 2h cooldown instead of
      // being mistaken for a day-fresh success.
      await store.failReflectionSubmission(attemptAt, priorReflectedAt).catch(() => undefined)
      await store.finishReflectionRun(active.sessionId, now, false).catch(() => undefined)
      throw error
    }
  }

  /** The stored log of one reflection run, for the trajectory view. */
  async trajectory(sessionId: string): Promise<import('./contracts.ts').TrajectoryView> {
    const events = await this.options.host.readEvents(sessionId)
    // Imported lazily to keep this module free of the trajectory fold at load time.
    const { foldTrajectory } = await import('./trajectory.ts')
    return { sessionId, ...foldTrajectory(events) }
  }

  /**
   * Stop on plugin unload: cancel the pass in flight, then await it so its
   * `finally` really finishes (releasing the session and completing any store
   * write) before the caller closes the storage domain. The host's `waitIdle`
   * cooperates with the cancel, so this settles instead of waiting out the full
   * model timeout.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.active) {
      try { await this.options.host.stop(this.active.sessionId) } catch { /* best effort */ }
    }
    await this.activeRun?.catch(() => undefined)
    this.activeRun = undefined
  }

  private async run(): Promise<void> {
    const now = this.options.now()
    const store = this.options.store
    // Record the attempt (and mark it failed) before anything can throw, so a crash
    // still leaves the failure cooldown in place instead of retrying every clock tick.
    await store.beginReflectionAttempt(now)
    let sessionId: string | undefined
    try {
      if (this.disposed) return
      const baseVersion = store.cognitionVersion
      const instruction = buildReflectionInstruction({
        agreements: store.agreements,
        cognition: store.cognition,
        ...store.lastReflectedAt !== undefined ? { lastReflectedAt: store.lastReflectedAt } : {},
        now,
      })
      sessionId = await this.options.host.createInternal(this.options.homeDir, REFLECTION_PRESET_ID)
      const run: ReflectionRun = { sessionId, startedAt: now, ok: false }
      await store.addReflectionRun(run)
      this.active = { sessionId, baseVersion, submitted: false }
      if (this.disposed) throw new Error('the reflection runner was disposed')
      await this.options.host.promptInternal(sessionId, instruction)
      await this.options.host.waitIdle(sessionId, this.options.timeoutMs ?? REFLECTION_TIMEOUT_MS)
      if (this.active?.submitted !== true) {
        this.options.log?.(`dsh-dot: reflection ${sessionId} ended without saving a cognition`)
        await store.finishReflectionRun(sessionId, this.options.now(), false)
      }
    } catch (error) {
      this.options.log?.(`dsh-dot: reflection failed: ${messageOf(error)}`)
      if (sessionId) await store.finishReflectionRun(sessionId, this.options.now(), false).catch(() => undefined)
    } finally {
      this.active = undefined
      if (sessionId) await this.options.host.releaseInternal(sessionId).catch(error => {
        this.options.log?.(`dsh-dot: reflection session ${sessionId} was not released: ${messageOf(error)}`)
      })
    }
  }
}

// ---- the reflection preset's tool row ----------------------------------

/** The parts of the root dot service the reflection tools use. */
interface ReflectionDotService {
  searchHistory(input: { query: string; sessionId?: string; scope?: string; tools?: boolean; limit?: number }): Promise<string>
  readHistory(input: { sessionId: string; seq?: number; before?: number; after?: number; tools?: boolean }): Promise<string>
  reflectionSubmit(cognition: string, agreementNotes: string | undefined, sessionId: string): Promise<string>
}

type ToolInput = Record<string, unknown>
type ToolHost = Context
  & { tools: { register(definition: unknown): () => void } }
  & Record<typeof SERVICE_NAME, ReflectionDotService>

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const SUBMIT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      status: { type: 'string' as const },
      message: { type: 'string' as const },
    },
    additionalProperties: true,
  },
  render: (_args: unknown, value: unknown) => {
    const row = value !== null && typeof value === 'object' ? value as { status?: unknown; message?: unknown } : {}
    return [{ type: 'text' as const, text: typeof row.message === 'string' ? row.message : String(row.status ?? 'saved') }]
  },
}

const str = (args: unknown, key: string): string | undefined => {
  const value = (args as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : undefined
}
const num = (args: unknown, key: string): number | undefined => {
  const value = (args as Record<string, unknown> | null)?.[key]
  return typeof value === 'number' ? value : undefined
}
const bool = (args: unknown, key: string): boolean => (args as Record<string, unknown> | null)?.[key] === true

async function run(work: () => Promise<string> | string): Promise<string> {
  try {
    return await work()
  } catch (error) {
    return `Error [dot/failed]: ${messageOf(error)}`
  }
}

export const name = 'dsh-dot-reflection'
export const inject = ['tools', SERVICE_NAME] as const

/**
 * The reflection preset's child plugin. It registers only read-only history
 * access and the one submission tool; there is deliberately no agreement tool
 * and no file or shell tool here.
 */
export function apply(ctx: Context): void {
  const host = ctx as ToolHost
  const dot = () => host[SERVICE_NAME]
  // Execution gate only; visibility is restricted on the agent scope in
  // setupFor, so only the three tools registered below may run here.
  gateToolExecution(ctx, [TOOL.searchHistory, TOOL.readHistory, REFLECTION_SUBMIT_TOOL])
  const tool = (definition: ToolInput, readOnly = false) => {
    const made = (defineTool as unknown as (input: ToolInput) => Record<string, unknown>)(definition)
    ctx.effect(() => host.tools.register(readOnly ? { ...made, hostEffect: 'read-only' as const } : made))
  }

  // ── dot_search_history (read-only) ─────────────────────────────────────
  tool({
    name: TOOL.searchHistory,
    description: "Search earlier messages across dot's conversation segments and tracked task sessions. Every query word must appear in the same message (case-insensitive, any order). Returns session_id and seq for dot_read_history.",
    parameters: {
      query: { type: 'string', required: true, description: 'Literal keywords to match; fewer words broaden recall.' },
      scope: { type: 'string', enum: ['all', 'own', 'tasks'], description: "own: dot's conversation; tasks: tracked task sessions; all (default): both." },
      session_id: { type: 'string', description: 'Restrict search to one session id.' },
      tools: { type: 'boolean', description: 'Include tool calls and results; default false.' },
      limit: { type: 'integer', description: 'Maximum hits to return (default 12, max 40).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    execute: (args: unknown) => run(() => {
      const limit = num(args, 'limit')
      return dot().searchHistory({
        query: str(args, 'query') ?? '',
        ...str(args, 'scope') ? { scope: str(args, 'scope')! } : {},
        ...str(args, 'session_id') ? { sessionId: str(args, 'session_id')! } : {},
        tools: bool(args, 'tools'),
        ...limit === undefined ? {} : { limit },
      })
    }),
    presentCall: () => ({ card: 'generic', title: 'Search history', kind: 'other' }),
  }, true)

  // ── dot_read_history (read-only) ───────────────────────────────────────
  tool({
    name: TOOL.readHistory,
    description: 'Read verbatim messages from one session: centered around seq (from dot_search_history), or the latest messages when seq is omitted.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Session id to read.' },
      seq: { type: 'integer', description: 'Anchor sequence number from a search hit.' },
      before: { type: 'integer', description: 'Messages before seq (default 4, max 30).' },
      after: { type: 'integer', description: 'Messages after seq (default 4, max 30).' },
      tools: { type: 'boolean', description: 'Include tool calls and results; default false.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    execute: (args: unknown) => run(() => {
      const seq = num(args, 'seq')
      const before = num(args, 'before')
      const after = num(args, 'after')
      return dot().readHistory({
        sessionId: str(args, 'session_id') ?? '',
        ...seq === undefined ? {} : { seq },
        ...before === undefined ? {} : { before },
        ...after === undefined ? {} : { after },
        tools: bool(args, 'tools'),
      })
    }),
    presentCall: () => ({ card: 'generic', title: 'Read history', kind: 'other' }),
  }, true)

  // ── dot_reflection_submit (the only write, cognition only) ─────────────
  tool({
    name: REFLECTION_SUBMIT_TOOL,
    description: 'Persist the reflection result and conclude this pass. cognition replaces the entire [cognition] block (empty string clears it). agreementNotes optionally flags stale or conflicting [agreements] for dot to mention to the human next turn; this tool never edits [agreements].',
    parameters: {
      cognition: { type: 'string', required: true, description: 'Complete replacement [cognition] text (max 4000 characters; empty clears it).' },
      agreementNotes: { type: 'string', description: 'Optional brief note on stale or conflicting agreements for dot to raise with the human.' },
    },
    output: SUBMIT_OUTPUT,
    isConcurrencySafe: () => false,
    execute: async (args: unknown, exec: { concludeTurn(): void; agent?: { session?: { id?: string } } }) => {
      try {
        // The session that made the call must be the one this runner started;
        // otherwise a stale pass or a sibling preset session could write here.
        const sessionId = exec.agent?.session?.id ?? ''
        const message = await dot().reflectionSubmit(str(args, 'cognition') ?? '', str(args, 'agreementNotes'), sessionId)
        exec.concludeTurn()
        return { status: 'saved', message }
      } catch (error) {
        return { status: 'error', message: `Error [dot/failed]: ${messageOf(error)}` }
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Save reflection', kind: 'other' }),
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
}
