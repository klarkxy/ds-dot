// Adapted from deepseek-ai/dsh-superagent-prototype@8c32a9d (MIT).
/**
 * Background work quiet-wait engine: waits for a worker session's owned
 * background jobs and active subagent trees to settle without waking Dorothy
 * prematurely, enforcing a 30-minute timeout cap and non-consuming tail reads.
 *
 * Host `jobs` and `subagents` services are resolved dynamically via a duck-typed
 * getter (`get('jobs')` / `get('subagents')`) so missing or throwing services
 * degrade silently without blocking or adding hard package dependencies.
 */

export const BACKGROUND_LIMIT_MS = 30 * 60_000
export const KILL_WAIT_MS = 10_000
export const DRAIN_LIMIT_MS = 10_000
const TAIL_SUMMARY_CHARS = 300

export type ServiceGetter = (name: string) => unknown

export interface BackgroundJobView {
  readonly id: string
  readonly kind?: string
  readonly label?: string
  readonly owner?: string
  readonly status: string
  readonly startedAt?: number
  readonly finishedAt?: number
}

export interface BackgroundJobEvent {
  readonly type: string
  readonly job?: BackgroundJobView
  readonly id?: string
  readonly owner?: string
  readonly cause?: string
  readonly awaited?: boolean
}

export interface BackgroundJobChunk {
  readonly at?: number
  readonly text?: string
  readonly channel?: string
}

export interface BackgroundJobsApi {
  list?(caller?: string): readonly BackgroundJobView[]
  kill?(id: string, caller?: string, reason?: string): 'requested' | 'already-finished' | string
  wait?(id: string, timeoutMs: number, caller?: string, signal?: AbortSignal): Promise<BackgroundJobView | undefined>
  readAt?(id: string, from: number, caller?: string): { readonly chunks?: readonly BackgroundJobChunk[]; readonly next?: number; readonly lossy?: boolean }
  events?: {
    subscribe?(
      filter: { readonly owner: string } | { readonly owners: 'all' | 'scope' },
      listener: (event: BackgroundJobEvent) => void,
    ): () => void
  }
}

export interface BackgroundAgentLike {
  readonly id: string
  readonly status: string
  readonly session?: { readonly id?: string; readonly seq?: number }
  cancel?(cause?: unknown, options?: { readonly keepInbox?: boolean }): void
  whenIdle?(): Promise<void>
}

export interface BackgroundSubagentsApi {
  waitForTreeWork?(root: BackgroundAgentLike): Promise<boolean>
  drainDescendants?(parents: readonly BackgroundAgentLike[]): Promise<void>
  listDescendants?(rootSessionId: string, signal?: AbortSignal): Promise<readonly unknown[]>
}

export interface BackgroundAgentsApi {
  get?(id: string): BackgroundAgentLike | undefined
}

export interface RunningJobInfo {
  readonly id: string
  readonly name: string
}

export interface KilledJobSummary {
  readonly id: string
  readonly name: string
  readonly outputTail?: string
}

function safeGet<T extends object>(get: ServiceGetter | undefined, name: string): T | undefined {
  if (typeof get !== 'function') return undefined
  try {
    const value = get(name)
    return value && typeof value === 'object' ? (value as T) : undefined
  } catch {
    return undefined
  }
}

export function hasJobsService(get: ServiceGetter | undefined): boolean {
  const jobs = safeGet<BackgroundJobsApi>(get, 'jobs')
  return jobs !== undefined && typeof jobs.list === 'function'
}

export function getAgentsService(get: ServiceGetter | undefined): BackgroundAgentsApi | undefined {
  return safeGet<BackgroundAgentsApi>(get, 'agents')
}

function named(job: Pick<BackgroundJobView, 'id' | 'label'>): string {
  const line = typeof job.label === 'string'
    ? job.label.split(/\r?\n/).map(item => item.trim()).find(Boolean)
    : undefined
  return line ? `${job.id} (${line})` : job.id
}

function isLiveStatus(status: unknown): boolean {
  return status === 'running' || status === 'stopping'
}

function ownedLiveJobs(
  jobs: BackgroundJobsApi | undefined,
  sessionId: string,
  except?: ReadonlySet<string>,
): BackgroundJobView[] {
  if (!jobs || typeof jobs.list !== 'function') return []
  let rows: readonly BackgroundJobView[]
  try {
    rows = jobs.list(sessionId)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  return rows.filter(job =>
    job
    && typeof job.id === 'string'
    && job.owner === sessionId
    && isLiveStatus(job.status)
    && !except?.has(job.id),
  )
}

export function runningJobs(
  get: ServiceGetter | undefined,
  sessionId: string,
  except?: ReadonlySet<string>,
): RunningJobInfo[] {
  const jobs = safeGet<BackgroundJobsApi>(get, 'jobs')
  return ownedLiveJobs(jobs, sessionId, except).map(job => ({ id: job.id, name: named(job) }))
}

/** Race `work` against an optional `AbortSignal` and millisecond timeout. */
export function until<T>(work: Promise<T>, signal?: AbortSignal, ms?: number): Promise<T | false> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise<T | false>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => finish(() => resolve(false))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (ms !== undefined) {
      timer = setTimeout(() => finish(() => resolve(false)), ms)
      ;(timer as { unref?: () => void }).unref?.()
    }
    Promise.resolve(work).then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

const joins = new WeakMap<object, Promise<boolean>>()

function childrenEnd(subagents: BackgroundSubagentsApi, agent: BackgroundAgentLike): Promise<boolean> {
  if (typeof subagents.waitForTreeWork !== 'function') return Promise.resolve(false)
  const existing = joins.get(agent)
  if (existing) return existing
  let pending: Promise<boolean>
  try {
    pending = Promise.resolve(subagents.waitForTreeWork(agent))
      .then(result => result === true)
      .catch(() => false)
  } catch {
    return Promise.resolve(false)
  }
  const tracked = pending.finally(() => {
    if (joins.get(agent) === tracked) joins.delete(agent)
  })
  joins.set(agent, tracked)
  return tracked
}

type JobsEndOutcome = 'waited' | 'empty' | 'aborted' | 'degraded'

function jobsEnd(
  get: ServiceGetter | undefined,
  sessionId: string,
  signal: AbortSignal,
  except?: ReadonlySet<string>,
): Promise<JobsEndOutcome> {
  if (signal.aborted) return Promise.resolve('aborted')
  const jobs = safeGet<BackgroundJobsApi>(get, 'jobs')
  if (!jobs || ownedLiveJobs(jobs, sessionId, except).length === 0) return Promise.resolve('empty')
  const subscribe = jobs.events?.subscribe
  if (typeof subscribe !== 'function') return Promise.resolve('degraded')

  return new Promise<JobsEndOutcome>(resolve => {
    let settled = false
    let unsubscribe: (() => void) | undefined
    const done = (result: JobsEndOutcome) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      try { unsubscribe?.() } catch { /* best-effort cleanup */ }
      resolve(result)
    }
    const onAbort = () => done('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      unsubscribe = jobs.events!.subscribe!({ owner: sessionId }, event => {
        if (!event || (event.type !== 'settled' && event.type !== 'removed')) return
        // rc.5 JobEventHub passes owner === undefined to { owner } filters: double-filter!
        if (event.job?.owner !== sessionId) return
        if (ownedLiveJobs(jobs, sessionId, except).length === 0) done('waited')
      })
    } catch {
      done('degraded')
      return
    }
    if (settled) {
      try { unsubscribe?.() } catch { /* already finished during subscribe */ }
      return
    }
    if (ownedLiveJobs(jobs, sessionId, except).length === 0) done('waited')
  })
}

/**
 * Wait until all subagent tree work and owned background jobs for `agent` become
 * quiet while `agent` remains `idle` and its `session.seq` does not advance.
 * Returns `true` when genuinely quiet, `false` if aborted or woken up.
 */
export async function untilQuiet(
  get: ServiceGetter | undefined,
  agent: BackgroundAgentLike,
  signal: AbortSignal,
  except?: ReadonlySet<string>,
): Promise<boolean> {
  for (;;) {
    if (signal.aborted) return false
    const idleSeq = agent.session?.seq
    const subagents = safeGet<BackgroundSubagentsApi>(get, 'subagents')
    const children = subagents && typeof subagents.waitForTreeWork === 'function'
      ? await until(childrenEnd(subagents, agent), signal).catch(() => false as const)
      : false
    if (signal.aborted) return false
    const jobsOutcome = await jobsEnd(get, agent.id, signal, except)
    if (signal.aborted || jobsOutcome === 'aborted' || agent.status !== 'idle') return false
    const jobsWaited = jobsOutcome === 'waited'
    if (!children && !jobsWaited) {
      if (agent.session?.seq !== idleSeq) return false
      if (jobsOutcome === 'empty' && runningJobs(get, agent.id, except).length > 0) continue
      if (signal.aborted || agent.status !== 'idle' || agent.session?.seq !== idleSeq) return false
      return true
    }
  }
}

function readSafeTail(jobs: BackgroundJobsApi, jobId: string, sessionId: string): string | undefined {
  if (typeof jobs.readAt !== 'function') return undefined
  try {
    const read = jobs.readAt(jobId, 0, sessionId)
    const chunks = Array.isArray(read?.chunks) ? read.chunks : []
    const text = chunks.map(chunk => (typeof chunk?.text === 'string' ? chunk.text : '')).join('').trim()
    if (!text) return undefined
    return text.length > TAIL_SUMMARY_CHARS ? `…${text.slice(-TAIL_SUMMARY_CHARS)}` : text
  } catch {
    return undefined
  }
}

/**
 * Pre-register `jobs.wait(id, KILL_WAIT_MS, sessionId)` before calling
 * `jobs.kill(id, sessionId, reason)` so `dsh-tool-jobs` sees `awaited: true`
 * and suppresses duplicate settlement wakeups. Reads optional output tails
 * non-consumingly via `jobs.readAt(id, 0, sessionId)` (never `jobs.read()`).
 */
export async function killJobs(
  get: ServiceGetter | undefined,
  sessionId: string,
  reason = 'background-timeout',
  except?: ReadonlySet<string>,
): Promise<KilledJobSummary[]> {
  const jobs = safeGet<BackgroundJobsApi>(get, 'jobs')
  if (!jobs) return []
  const live = runningJobs(get, sessionId, except)
  if (live.length === 0) return []

  const failures: unknown[] = []
  const waits = live.map(job => {
    if (typeof jobs.wait !== 'function') return Promise.resolve(undefined)
    try {
      return Promise.resolve(jobs.wait(job.id, KILL_WAIT_MS, sessionId)).catch(() => undefined)
    } catch {
      return Promise.resolve(undefined)
    }
  })
  for (const job of live) {
    try {
      jobs.kill?.(job.id, sessionId, reason)
    } catch (error) {
      failures.push(error)
    }
  }
  await Promise.all(waits)

  const summaries: KilledJobSummary[] = live.map(job => {
    const outputTail = readSafeTail(jobs, job.id, sessionId)
    return outputTail ? { id: job.id, name: job.name, outputTail } : { id: job.id, name: job.name }
  })
  if (failures.length > 0) {
    throw new AggregateError(failures, `failed to kill ${failures.length} background job(s) for ${sessionId}`)
  }
  return summaries
}

async function stopSubagents(
  get: ServiceGetter | undefined,
  agent: BackgroundAgentLike,
  keepInbox = false,
): Promise<void> {
  const subagents = safeGet<BackgroundSubagentsApi>(get, 'subagents')
  try {
    if (subagents && typeof subagents.drainDescendants === 'function') {
      await until(Promise.resolve(subagents.drainDescendants([agent])).catch(() => undefined), undefined, DRAIN_LIMIT_MS)
    }
  } catch {
    // Missing or throwing subagents service degrades silently.
  } finally {
    try { agent.cancel?.({ kind: 'user' }, { keepInbox }) } catch { /* best effort */ }
    if (typeof agent.whenIdle === 'function') {
      try {
        await until(Promise.resolve(agent.whenIdle()).catch(() => undefined), undefined, DRAIN_LIMIT_MS)
      } catch { /* best effort */ }
    }
  }
}

/**
 * Stop owned background jobs and drain descendant subagent trees cleanly,
 * silently degrading when `jobs` or `subagents` is missing or throws.
 */
export async function stopBackground(
  get: ServiceGetter | undefined,
  agentsOrSession: string | BackgroundAgentLike | readonly BackgroundAgentLike[],
  reason = 'stopped',
  keepInbox = false,
): Promise<void> {
  const agents: BackgroundAgentLike[] = typeof agentsOrSession === 'string'
    ? (() => {
        try {
          const found = getAgentsService(get)?.get?.(agentsOrSession)
          return found ? [found] : []
        } catch {
          return []
        }
      })()
    : Array.isArray(agentsOrSession)
      ? [...agentsOrSession]
      : [agentsOrSession as BackgroundAgentLike]

  const sessionIds = new Set<string>()
  if (typeof agentsOrSession === 'string') sessionIds.add(agentsOrSession)
  for (const agent of agents) {
    if (agent?.id) sessionIds.add(agent.id)
  }

  await Promise.all([
    ...[...sessionIds].map(sessionId => killJobs(get, sessionId, reason).catch(() => [])),
    ...agents.map(agent => stopSubagents(get, agent, keepInbox).catch(() => undefined)),
  ])
}

export function subscribeJobsEvents(
  get: ServiceGetter | undefined,
  filter: { readonly owner: string } | { readonly owners: 'all' | 'scope' },
  listener: (event: BackgroundJobEvent) => void,
): (() => void) | undefined {
  const jobs = safeGet<BackgroundJobsApi>(get, 'jobs')
  const subscribe = jobs?.events?.subscribe
  if (typeof subscribe !== 'function') return undefined
  try {
    return jobs!.events!.subscribe!(filter, listener)
  } catch {
    return undefined
  }
}

/**
 * In-memory per-session quiet-wait state for `DotService`, tracking active
 * `AbortController`s, abandoned 30-min timeouts, and accumulated wait duration
 * (`quietWaitMs` for Watchdog netActiveMs).
 */
export class QuietWaitTracker {
  private readonly active = new Map<string, { readonly controller: AbortController; readonly startedAt: number }>()
  private readonly accumulated = new Map<string, number>()
  private readonly abandoned = new Set<string>()

  has(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  activeSessionIds(): string[] {
    return [...this.active.keys()]
  }

  quietWaitMs(sessionId: string, now = Date.now()): number {
    const past = this.accumulated.get(sessionId) ?? 0
    const current = this.active.get(sessionId)
    return past + (current ? Math.max(0, now - current.startedAt) : 0)
  }

  begin(sessionId: string, now: number): AbortController {
    this.abort(sessionId, now, 'superseded')
    this.abandoned.delete(sessionId)
    const controller = new AbortController()
    this.active.set(sessionId, { controller, startedAt: now })
    return controller
  }

  end(sessionId: string, controller: AbortController, now: number): void {
    const entry = this.active.get(sessionId)
    if (!entry || entry.controller !== controller) return
    this.active.delete(sessionId)
    this.accumulated.set(sessionId, (this.accumulated.get(sessionId) ?? 0) + Math.max(0, now - entry.startedAt))
  }

  abort(sessionId: string, now: number, reason?: string): boolean {
    const entry = this.active.get(sessionId)
    if (!entry) return false
    this.active.delete(sessionId)
    this.accumulated.set(sessionId, (this.accumulated.get(sessionId) ?? 0) + Math.max(0, now - entry.startedAt))
    if (!entry.controller.signal.aborted) entry.controller.abort(reason)
    return true
  }

  abortAll(now: number, reason?: string): void {
    for (const sessionId of [...this.active.keys()]) {
      this.abort(sessionId, now, reason)
    }
  }

  markAbandoned(sessionId: string): void {
    this.abandoned.add(sessionId)
  }

  isAbandoned(sessionId: string): boolean {
    return this.abandoned.has(sessionId)
  }

  clearAbandoned(sessionId: string): void {
    this.abandoned.delete(sessionId)
  }

  remove(sessionId: string, now = Date.now()): void {
    this.abort(sessionId, now, 'removed')
    this.abandoned.delete(sessionId)
    this.accumulated.delete(sessionId)
  }

  clearAll(now = Date.now()): void {
    this.abortAll(now, 'reset')
    this.abandoned.clear()
    this.accumulated.clear()
  }
}
