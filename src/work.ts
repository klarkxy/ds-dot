/**
 * Change, input, run and verification records. Occupancy is the non-terminal
 * runs themselves. There is no lock table. The short lane only commits; a
 * caller reads the workspace outside it and must pass the revision it saw.
 */
import { lstatSync, readdirSync, realpathSync, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { subjectKey, subjectMaterial, type DeliverySubject, type SubjectLook } from './acceptance.ts'
import { totalUsage } from './context.ts'
import type { DotContextUsage } from './contracts.ts'
import { z } from 'zod'

export type ChangeControl = 'open' | 'paused' | 'cancelled'
export type RunPhase = 'reserved' | 'active' | 'settling' | 'completed' | 'failed' | 'stopped'
export type RunKind = 'work' | 'rework' | 'review'
export type DeliveryKind = 'initial' | 'context' | 'coordination'
export type DeliveryStatus = 'intent' | 'accepted' | 'rejected' | 'unknown'
export type CreationStatus = 'intent' | 'inflight' | 'confirmed' | 'rejected' | 'unknown'
export type CheckVerdict = 'pass' | 'fail' | 'unverified' | 'not-applicable'
export type VerificationVerdict = 'accept' | 'rework' | 'unverified'

const TERMINAL: ReadonlySet<RunPhase> = new Set(['completed', 'failed', 'stopped'])
export const MAX_COMPLETED_CHANGES = 200
/** How long a terminal run that still owes usage can defer its change's prune. */
export const USAGE_PRUNE_GRACE_MS = 24 * 60 * 60_000

/** Terminal run — usage and wall time can be recorded against it. */
export function runIsTerminal(run: Pick<RunRecord, 'phase'>): boolean { return TERMINAL.has(run.phase) }

/**
 * Tokens and wall time summed over a change's finished runs. Only runs that
 * recorded the fields contribute, so the totals track the terminal set and a
 * run that never reported usage simply does not count.
 */
export function runCostTotals(runs: readonly RunRecord[]): { readonly tokens?: number; readonly wallMs?: number } {
  let tokens = 0
  let counted = false
  let wallMs = 0
  let timed = false
  for (const run of runs) {
    if (!TERMINAL.has(run.phase)) continue
    if (run.usage) { tokens += totalUsage(run.usage); counted = true }
    if (run.wallMs !== undefined) { wallMs += run.wallMs; timed = true }
  }
  return { ...(counted ? { tokens } : {}), ...(timed ? { wallMs } : {}) }
}

export interface WritePath { readonly path: string; readonly type: 'file' | 'directory' }
export type WriteScope = { readonly kind: 'paths'; readonly paths: readonly WritePath[] } | { readonly kind: 'workspace-exclusive' }

export interface Scenario {
  readonly scenarioRef: string
  readonly given?: string
  readonly when: string
  readonly then: string
}
export interface Requirement {
  readonly requirementRef: string
  readonly text: string
  readonly required: boolean
  readonly scenarios?: readonly Scenario[]
}
export interface StepSpec {
  readonly stepRef: string
  readonly text: string
  readonly covers?: readonly string[]
  readonly after?: readonly string[]
}
export interface Constraint { readonly constraintRef: string; readonly text: string }
export interface StepView { readonly stepRef: string; readonly done: boolean; readonly runId?: string; readonly inputRef: string }
export interface BaselineRef { readonly workspaceRoot: string; readonly scopeKey: string; readonly artifactRef: string }
export interface DeliveryRecord {
  readonly id: string
  readonly kind: DeliveryKind
  readonly targetSessionId: string
  readonly inputRevision: number
  readonly contentRef: string
  readonly hostRequestId?: string
  readonly source: string
  readonly status: DeliveryStatus
  readonly evidence?: string
  readonly createdAt: number
  readonly updatedAt: number
}
export interface ChangeRecord {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly baselineRefs: readonly BaselineRef[]
  readonly currentRevision: number
  readonly currentInputRef: string
  readonly control: ChangeControl
  readonly steps: readonly StepView[]
  readonly maxConcurrentRuns: number
  readonly priority: 1 | 2 | 3
  readonly closeout?: { readonly verificationId: string; readonly source: string; readonly inputRef?: string; readonly subjectKey?: string; readonly at?: number }
  /** The user asked to see this input. A version field on accept does not replace the recorded decision. */
  readonly oversight?: OversightRecord
  /** The recipe and revision this change was created from; kept after the recipe is removed or revised. */
  readonly recipe?: { readonly id: string; readonly revision: number }
  /** A change whose runs wrote into a dot-managed git worktree instead of the checkout. */
  readonly isolation?: TaskIsolation
  readonly createdAt: number
  readonly updatedAt: number
}
/** Where an isolated change's worktree lives and how the human chose to integrate it. */
export interface TaskIsolation {
  readonly kind: 'worktree'
  readonly repoRoot: string
  readonly worktree: string
  readonly branch: string
  readonly baseSha: string
  readonly state: 'active' | 'committed' | 'merged' | 'discarded'
  readonly commitSha?: string
  readonly mergedInto?: string
  readonly at: number
}
export interface InputRecord {
  readonly id: string
  readonly changeId: string
  readonly revision: number
  readonly goal: string
  readonly requirements: readonly Requirement[]
  /** Whether the implicit goal requirement follows later goal edits. */
  readonly requirementsFromGoal?: boolean
  readonly steps: readonly StepSpec[]
  readonly constraints?: readonly Constraint[]
  readonly userRequest?: string
  readonly deliverableLanguage?: string
  readonly designNotes?: string
  readonly supersedes?: string
  readonly source: string
  readonly createdAt: number
}
/** Host state watermark. It never advances a phase or an input revision. */
export interface RunCursor {
  readonly seq?: number
  readonly running?: boolean
  readonly queue?: 'empty' | 'pending' | 'unknown'
  readonly idle?: boolean
}
export interface RunRecord {
  readonly id: string
  readonly changeId: string
  readonly kind: RunKind
  readonly inputRevision: number
  readonly inputRef: string
  readonly stepRefs: readonly string[]
  readonly cwd: string
  readonly workspaceRoot: string
  readonly exclusiveRoot: string
  readonly uncertainBoundary: boolean
  readonly writeScope: WriteScope
  readonly baselineRefs: readonly BaselineRef[]
  readonly requestedSessionId: string
  readonly sessionId?: string
  readonly creation: CreationStatus
  /** Preset requested before any host call. Recovery reads this, not a later argument. */
  readonly expectedPreset?: string
  /** Permission the host must be set to before any delivery. Empty scope is still `read`, not "unset". */
  readonly access?: 'read' | 'write'
  readonly deliveries: readonly DeliveryRecord[]
  readonly phase: RunPhase
  readonly closeReason?: string
  /** Persisted before the stop wait, so a restart continues the same close. */
  readonly closeIntent?: 'completed' | 'failed' | 'stopped'
  /** One in-flight session lookup. The prompt claim is the initial delivery status, not a second flag. */
  readonly actionClaim?: 'session' | 'prompt'
  readonly closureEvidence?: { readonly queueCleared: boolean; readonly agentIdle: boolean; readonly jobsSettled: boolean }
  readonly observation?: string
  readonly cursor?: RunCursor
  readonly reworkOf?: string
  readonly createdAt: number
  readonly updatedAt: number
  /** Folded provider usage from the run's session events, captured once the run is terminal. */
  readonly usage?: DotContextUsage
  /** Wall time of the run's session — first to last event, else updatedAt − createdAt. */
  readonly wallMs?: number
}
export interface CheckRecord {
  readonly requirementRef: string
  readonly applicability: 'applicable' | 'not-applicable'
  readonly verdict: CheckVerdict
  readonly evidenceRefs: readonly string[]
  readonly note?: string
}
export interface VerificationRecord {
  readonly id: string
  readonly changeId: string
  readonly inputRevision: number
  readonly inputRef: string
  readonly runIds: readonly string[]
  readonly reviewRunId?: string
  readonly reviewerSessionId?: string
  readonly subject?: DeliverySubject
  readonly subjectKey?: string
  readonly checks: readonly CheckRecord[]
  readonly verdict: VerificationVerdict
  readonly createdAt: number
}
export interface OversightDecision {
  readonly result: 'accept' | 'reject'
  readonly verificationId?: string
  readonly subjectKey?: string
  readonly source: string
  readonly at: number
  /** Set after the decision wake was delivered. Absent means a restart must wake once. */
  readonly notifiedAt?: number
}
export interface OversightRecord {
  readonly requested: boolean
  readonly inputRef: string
  readonly inputRevision: number
  readonly decision?: OversightDecision
}
export interface ExternalOccupant {
  readonly id: string
  readonly cwd: string
  readonly workspaceRoot: string
  readonly exclusiveRoot: string
  readonly uncertainBoundary?: boolean
  readonly writeScope: WriteScope
}

const scenarioSchema = z.object({
  scenarioRef: z.string().min(1),
  given: z.string().optional(),
  when: z.string(),
  then: z.string(),
})
export const requirementSchema = z.object({
  requirementRef: z.string().min(1),
  text: z.string(),
  required: z.boolean(),
  scenarios: z.array(scenarioSchema).optional(),
})
const stepSpecSchema = z.object({
  stepRef: z.string().min(1),
  text: z.string(),
  covers: z.array(z.string().min(1)).optional(),
  after: z.array(z.string().min(1)).optional(),
})
export const constraintSchema = z.object({ constraintRef: z.string().min(1), text: z.string() })
const stepViewSchema = z.object({ stepRef: z.string().min(1), done: z.boolean(), runId: z.string().optional(), inputRef: z.string().min(1) })
const baselineSchema = z.object({ workspaceRoot: z.string().min(1), scopeKey: z.string().min(1), artifactRef: z.string().min(1) })
const writePathSchema = z.object({ path: z.string().min(1), type: z.enum(['file', 'directory']) })
const writeScopeSchema = z.union([
  z.object({ kind: z.literal('paths'), paths: z.array(writePathSchema) }),
  z.object({ kind: z.literal('workspace-exclusive') }),
])
const deliverySchema = z.object({
  id: z.string().min(1), kind: z.enum(['initial', 'context', 'coordination']), targetSessionId: z.string(),
  inputRevision: z.number().int(), contentRef: z.string(), hostRequestId: z.string().optional(), source: z.string(),
  status: z.enum(['intent', 'accepted', 'rejected', 'unknown']), evidence: z.string().optional(),
  createdAt: z.number(), updatedAt: z.number(),
})

export const changeSchema = z.object({
  id: z.string().min(1), title: z.string(), cwd: z.string().min(1), baselineRefs: z.unknown().optional().transform(() => [] as BaselineRef[]),
  currentRevision: z.number().int().positive(), currentInputRef: z.string().min(1),
  control: z.enum(['open', 'paused', 'cancelled']), steps: z.array(stepViewSchema),
  maxConcurrentRuns: z.number().int().min(1).max(8), priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  closeout: z.object({
    verificationId: z.string().min(1), source: z.string(),
    inputRef: z.string().min(1).optional(), subjectKey: z.string().min(1).optional(), at: z.number().optional(),
  }).optional(),
  oversight: z.object({
    requested: z.boolean(), inputRef: z.string().min(1), inputRevision: z.number().int(),
    decision: z.object({
      result: z.enum(['accept', 'reject']), verificationId: z.string().min(1).optional(),
      subjectKey: z.string().min(1).optional(), source: z.string(), at: z.number(),
      notifiedAt: z.number().optional(),
    }).optional(),
  }).optional(),
  recipe: z.object({ id: z.string().min(1), revision: z.number().int().positive() }).optional(),
  isolation: z.object({
    kind: z.literal('worktree'), repoRoot: z.string().min(1), worktree: z.string().min(1),
    branch: z.string().min(1), baseSha: z.string().min(1),
    state: z.enum(['active', 'committed', 'merged', 'discarded']),
    commitSha: z.string().min(1).optional(), mergedInto: z.string().min(1).optional(), at: z.number(),
  }).optional(),
  createdAt: z.number(), updatedAt: z.number(),
})
export const inputSchema = z.object({
  id: z.string().min(1), changeId: z.string().min(1), revision: z.number().int().positive(), goal: z.string(),
  requirements: z.array(requirementSchema), requirementsFromGoal: z.boolean().optional(), steps: z.array(stepSpecSchema),
  constraints: z.array(constraintSchema).optional(),
  userRequest: z.string().optional(), deliverableLanguage: z.string().optional(),
  designNotes: z.string().optional(), supersedes: z.string().optional(),
  source: z.string(), createdAt: z.number(),
})
export const runSchema = z.object({
  id: z.string().min(1), changeId: z.string().min(1), kind: z.enum(['work', 'rework', 'review']),
  inputRevision: z.number().int(), inputRef: z.string().min(1), stepRefs: z.array(z.string()),
  cwd: z.string().min(1), workspaceRoot: z.string().min(1), exclusiveRoot: z.string().min(1),
  uncertainBoundary: z.boolean(), writeScope: writeScopeSchema, baselineRefs: z.array(baselineSchema),
  requestedSessionId: z.string().min(1), sessionId: z.string().optional(),
  creation: z.enum(['intent', 'inflight', 'confirmed', 'rejected', 'unknown']),
  expectedPreset: z.string().min(1).optional(),
  access: z.enum(['read', 'write']).optional(),
  deliveries: z.array(deliverySchema),
  phase: z.enum(['reserved', 'active', 'settling', 'completed', 'failed', 'stopped']),
  closeReason: z.string().optional(),
  closeIntent: z.enum(['completed', 'failed', 'stopped']).optional(),
  actionClaim: z.enum(['session', 'prompt']).optional(),
  closureEvidence: z.object({ queueCleared: z.boolean(), agentIdle: z.boolean(), jobsSettled: z.boolean() }).optional(),
  observation: z.string().optional(),
  cursor: z.object({
    seq: z.number().int().nonnegative().optional(),
    running: z.boolean().optional(),
    queue: z.enum(['empty', 'pending', 'unknown']).optional(),
    idle: z.boolean().optional(),
  }).optional(),
  reworkOf: z.string().optional(),
  createdAt: z.number(), updatedAt: z.number(),
  usage: z.object({ input: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number() }).optional(),
  wallMs: z.number().optional(),
})
const subjectSchema = z.object({
  workspaceRoot: z.string().min(1), cwd: z.string().min(1),
  baselineRefs: z.array(baselineSchema), artifactRef: z.string().min(1),
  changes: z.array(z.object({ path: z.string().min(1), kind: z.enum(['added', 'modified', 'deleted']), sha256: z.string().optional() })),
  protectedDirty: z.array(z.string()),
  exclusions: z.array(z.object({ path: z.string().min(1), reason: z.string().min(1) })),
  writeScope: writeScopeSchema.optional(), outOfScopePaths: z.array(z.string()).optional(),
})
export const verificationSchema = z.object({
  id: z.string().min(1), changeId: z.string().min(1), inputRevision: z.number().int(), inputRef: z.string().min(1),
  runIds: z.array(z.string()),
  reviewRunId: z.string().min(1).optional(), reviewerSessionId: z.string().optional(),
  subject: subjectSchema.optional(), subjectKey: z.string().min(1).optional(),
  checks: z.array(z.object({
    requirementRef: z.string(), applicability: z.enum(['applicable', 'not-applicable']),
    verdict: z.enum(['pass', 'fail', 'unverified', 'not-applicable']), evidenceRefs: z.array(z.string()), note: z.string().optional(),
  })),
  verdict: z.enum(['accept', 'rework', 'unverified']), createdAt: z.number(),
})

export function parseChange(value: unknown): ChangeRecord | undefined {
  const parsed = changeSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
export function parseInput(value: unknown): InputRecord | undefined {
  const parsed = inputSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
export function parseRun(value: unknown): RunRecord | undefined {
  const parsed = runSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
export function parseVerification(value: unknown): VerificationRecord | undefined {
  const parsed = verificationSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** A stored verification the current record schema cannot use. The bytes stay; the reasons do not fill in missing evidence. */
const preservedVerificationSchema = z.object({
  id: z.string().min(1),
  changeId: z.string().min(1),
  inputRevision: z.number(),
  inputRef: z.string().min(1),
  runIds: z.array(z.string()),
  checks: z.array(z.object({
    requirementRef: z.string(),
    applicability: z.string(),
    verdict: z.string(),
    evidenceRefs: z.array(z.string()),
    note: z.string().optional(),
  }).passthrough()),
  verdict: z.string(),
  createdAt: z.number(),
  reviewRunId: z.string().optional(),
  reviewerSessionId: z.string().optional(),
  subjectKey: z.string().optional(),
  subject: z.object({
    workspaceRoot: z.string(),
    cwd: z.string(),
    artifactRef: z.string(),
    baselineRefs: z.array(z.object({
      workspaceRoot: z.string(),
      artifactRef: z.string(),
      scopeKey: z.string().optional(),
    }).passthrough()).optional(),
    changes: z.array(z.record(z.string(), z.unknown())).optional(),
    protectedDirty: z.array(z.unknown()).optional(),
    exclusions: z.array(z.unknown()).optional(),
  }).passthrough().optional(),
}).passthrough()

/**
 * Domain open accepts a preserved illegal verification so one bad row does not
 * reject the home. Logical reads still use {@link verificationSchema}.
 */
export const storedVerificationSchema = z.union([verificationSchema, preservedVerificationSchema])

export interface IllegalVerification {
  readonly id: string
  readonly changeId?: string
  readonly runIds: readonly string[]
  readonly reasons: readonly string[]
}

/** Why a stored verification cannot be used. Undefined means the strict schema accepts it. */
export function explainVerification(value: unknown): IllegalVerification | undefined {
  if (verificationSchema.safeParse(value).success) return undefined
  const row = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const id = typeof row.id === 'string' && row.id ? row.id : 'unknown'
  const reasons: string[] = []
  const checks = Array.isArray(row.checks) ? row.checks : []
  if (checks.some(check => {
    const applicability = check !== null && typeof check === 'object' ? (check as { applicability?: unknown }).applicability : undefined
    return applicability !== 'applicable' && applicability !== 'not-applicable'
  })) reasons.push('applicability')
  const subject = row.subject !== null && typeof row.subject === 'object' ? row.subject as { baselineRefs?: unknown } : undefined
  if (subject) {
    const baselines = Array.isArray(subject.baselineRefs) ? subject.baselineRefs : []
    const missingScope = !Array.isArray(subject.baselineRefs) || baselines.some(ref => {
      const scopeKey = ref !== null && typeof ref === 'object' ? (ref as { scopeKey?: unknown }).scopeKey : undefined
      return typeof scopeKey !== 'string' || scopeKey.length === 0
    })
    if (missingScope) reasons.push('baseline scopeKey')
  }
  if (reasons.length === 0) reasons.push('schema')
  const runIds = Array.isArray(row.runIds) ? row.runIds.filter((item): item is string => typeof item === 'string') : []
  return { id, ...(typeof row.changeId === 'string' ? { changeId: row.changeId } : {}), runIds, reasons }
}

export function canonicalPath(value: string, platform: NodeJS.Platform = process.platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix
  const resolved = api.isAbsolute(value) ? api.normalize(value) : api.resolve(value)
  const root = api.parse(resolved).root
  const trimmed = resolved === root ? root : resolved.replace(/[\\/]+$/, '')
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

function resolveSegmentOnDisk(dir: string, segment: string, api: typeof path.win32): string | undefined {
  let entries: string[] | undefined
  try {
    entries = readdirSync(dir)
  } catch {
    entries = undefined
  }
  if (entries) {
    const exact = entries.find(entry => entry === segment)
    if (exact) return api.join(dir, exact)
    const folded = segment.toLowerCase()
    const matched = entries.find(entry => entry.toLowerCase() === folded)
    if (matched) return api.join(dir, matched)
  }
  const candidate = api.join(dir, segment)
  let stat: BigIntStats | undefined
  try {
    stat = lstatSync(candidate, { bigint: true })
  } catch {
    return undefined
  }
  if (!stat.isSymbolicLink()) {
    try {
      const realName = api.basename(realpathSync.native(candidate))
      if (realName) {
        const listed = entries?.find(entry => entry === realName)
          ?? entries?.find(entry => entry.toLowerCase() === realName.toLowerCase())
        const resolved = api.join(dir, listed ?? realName)
        const check = lstatSync(resolved, { bigint: true })
        if (check.ino === stat.ino && check.dev === stat.dev) return resolved
      }
    } catch {
      // Fall back to parent entry matching below.
    }
  }
  if (entries && stat.ino !== 0n) {
    for (const entry of entries) {
      const target = api.join(dir, entry)
      try {
        const entryStat = lstatSync(target, { bigint: true })
        if (entryStat.ino === stat.ino && entryStat.dev === stat.dev) return target
      } catch {
        // Ignore entries removed concurrently during lookup.
      }
    }
  }
  return candidate
}

/**
 * The cwd a session should be created in: stored values are canonicalized
 * (case-folded on win32), so restore the on-disk spelling segment by segment
 * without crossing symlinks or Windows directory junctions while still
 * expanding 8.3 short-name segments. Falls back when unresolved; identity elsewhere.
 */
export function onDiskPath(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || !value) return value
  const api = path.win32
  const resolved = api.isAbsolute(value) ? api.normalize(value) : api.resolve(value)
  const root = api.parse(resolved).root
  if (!root) return value
  const trimmed = resolved === root ? root : resolved.replace(/[\\/]+$/, '')
  const diskRoot = root
    .replace(/^([a-z]):/i, (_, drive: string) => `${drive.toUpperCase()}:`)
    .replace(/^(\\\\\?\\)([a-z]):/i, (_, prefix: string, drive: string) => `${prefix}${drive.toUpperCase()}:`)
  const rest = trimmed.slice(root.length)
  if (!rest) {
    try {
      lstatSync(diskRoot)
      return diskRoot
    } catch {
      return value
    }
  }
  const segments = rest.split(/[\\/]+/).filter(Boolean)
  let current = diskRoot
  for (let index = 0; index < segments.length; index += 1) {
    const next = resolveSegmentOnDisk(current, segments[index]!, api)
    if (next === undefined) {
      return index === 0 ? value : api.join(current, ...segments.slice(index))
    }
    current = next
  }
  return current
}

function sameSessionCwd(actual: string, expectedCanonical: string, platform: NodeJS.Platform): boolean {
  if (canonicalPath(actual, platform) === expectedCanonical) return true
  if (platform !== 'win32' || process.platform !== 'win32') return false
  return canonicalPath(onDiskPath(actual, platform), platform) === canonicalPath(onDiskPath(expectedCanonical, platform), platform)
}

export function pathsOverlap(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix
  const contains = (parent: string, child: string) => {
    const relative = api.relative(parent, child)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
  }
  return contains(left, right) || contains(right, left)
}

export interface RootHint { readonly workspaceRoot?: string; readonly gitCommonDir?: string; readonly uncertain?: boolean }

/** The mutual-exclusion root is the Git common dir when known, otherwise the checkout root. */
export function workspaceIdentity(cwd: string, hint: RootHint = {}, platform: NodeJS.Platform = process.platform): { workspaceRoot: string; exclusiveRoot: string; uncertainBoundary: boolean } {
  const root = canonicalPath(hint.workspaceRoot ?? cwd, platform)
  const common = hint.gitCommonDir ? canonicalPath(hint.gitCommonDir, platform) : undefined
  return { workspaceRoot: root, exclusiveRoot: common ?? root, uncertainBoundary: hint.uncertain === true }
}

/**
 * Resolve `scopePath` against a persistent workspace root.
 * A relative path never falls through to `process.cwd()`: that directory is the
 * host runtime, not the shared workspace the Change was reserved in.
 */
export function absoluteScopePath(root: string, scopePath: string, platform: NodeJS.Platform = process.platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix
  if (api.isAbsolute(scopePath)) return scopePath
  if (!root || !api.isAbsolute(root)) throw new Error(`relative scope ${scopePath} needs an absolute workspace root`)
  return api.resolve(root, scopePath)
}

/** True when `scopePath` stays inside `root` after relative resolution. */
export function scopeWithinRoot(root: string, scopePath: string, platform: NodeJS.Platform = process.platform): boolean {
  const absolute = absoluteScopePath(root, scopePath, platform)
  const api = platform === 'win32' ? path.win32 : path.posix
  const relative = api.relative(canonicalPath(root, platform), canonicalPath(absolute, platform))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
}

/**
 * Identity of a write scope inside one persistent workspace.
 * Relative paths resolve against `root` (the run's workspaceRoot). The same
 * file named relatively or absolutely shares one key, so a later baseline of
 * that scope replaces only itself.
 */
export function scopeKey(scope: WriteScope, root: string, platform: NodeJS.Platform = process.platform): string {
  if (scope.kind === 'workspace-exclusive') return 'workspace-exclusive'
  const names = scope.paths.map(item => `${item.type}:${canonicalPath(absoluteScopePath(root, item.path, platform), platform)}`).sort()
  return `${canonicalPath(root, platform)}|${names.join('|')}`
}

function scopePaths(scope: WriteScope, cwd: string, platform: NodeJS.Platform): readonly string[] {
  if (scope.kind === 'workspace-exclusive') return []
  return scope.paths.map(item => canonicalPath(absoluteScopePath(cwd, item.path, platform), platform))
}

export function scopeWrites(scope: WriteScope): boolean {
  return scope.kind === 'workspace-exclusive' || scope.paths.length > 0
}

export interface Occupant {
  readonly id: string
  readonly cwd: string
  readonly workspaceRoot: string
  readonly exclusiveRoot: string
  readonly uncertainBoundary: boolean
  readonly writeScope: WriteScope
}

/**
 * A workspace-exclusive occupant covers its normalized workspace root, not its
 * cwd. Equal exclusive roots share one checkout. Missing root identity or an
 * uncertain boundary blocks rather than guessing.
 */
export function occupantsConflict(left: Occupant, right: Occupant, platform: NodeJS.Platform = process.platform): boolean {
  if (!scopeWrites(left.writeScope) || !scopeWrites(right.writeScope)) return false
  if (left.uncertainBoundary || right.uncertainBoundary) return true
  const leftExclusive = left.writeScope.kind === 'workspace-exclusive'
  const rightExclusive = right.writeScope.kind === 'workspace-exclusive'
  if (leftExclusive || rightExclusive) {
    if (left.exclusiveRoot.length > 0 && left.exclusiveRoot === right.exclusiveRoot) return true
    if (leftExclusive && rightExclusive) return rootsOverlap(left.workspaceRoot, right.workspaceRoot, platform)
    const holder = leftExclusive ? left : right
    const other = leftExclusive ? right : left
    if (!holder.workspaceRoot) return true
    const covered = canonicalPath(holder.workspaceRoot, platform)
    return scopePaths(other.writeScope, other.cwd, platform).some(item => pathsOverlap(covered, item, platform))
  }
  const leftPaths = scopePaths(left.writeScope, left.cwd, platform)
  const rightPaths = scopePaths(right.writeScope, right.cwd, platform)
  return leftPaths.some(item => rightPaths.some(other => pathsOverlap(item, other, platform)))
}

function rootsOverlap(left: string, right: string, platform: NodeJS.Platform): boolean {
  if (!left || !right) return true
  return pathsOverlap(canonicalPath(left, platform), canonicalPath(right, platform), platform)
}

/** Persistent verification order is the numeric id, not the string. `v-10` is newer than `v-9`. */
function verificationOrder(id: string): number {
  const match = /^v-(\d+)$/.exec(id)
  return match ? Number(match[1]) : -1
}

function newerVerification(row: { readonly id: string; readonly createdAt: number }, than: { readonly id: string; readonly createdAt: number }): boolean {
  return row.createdAt > than.createdAt || (row.createdAt === than.createdAt && verificationOrder(row.id) > verificationOrder(than.id))
}

export function judgeVerification(requirements: readonly Requirement[], checks: readonly CheckRecord[]): VerificationVerdict {
  const required = requirements.filter(item => item.required)
  const byRef = new Map(checks.map(item => [item.requirementRef, item]))
  let failed = false
  let incomplete = false
  for (const item of required) {
    const check = byRef.get(item.requirementRef)
    if (!check) { incomplete = true; continue }
    if (check.applicability === 'not-applicable') {
      // A waiver is only the not-applicable verdict plus a reason. `pass` cannot sneak through.
      if (check.verdict !== 'not-applicable' || !check.note) incomplete = true
      continue
    }
    if (check.applicability !== 'applicable' || check.verdict === 'not-applicable') { incomplete = true; continue }
    if (check.verdict === 'fail') {
      if (check.evidenceRefs.length === 0) incomplete = true
      else failed = true
      continue
    }
    if (check.verdict !== 'pass' || check.evidenceRefs.length === 0) incomplete = true
  }
  // An explicit failure is rework even when another required item has no evidence yet.
  if (failed) return 'rework'
  if (incomplete) return 'unverified'
  if (required.length > 0 && required.every(item => byRef.get(item.requirementRef)?.applicability === 'not-applicable')) return 'unverified'
  return 'accept'
}

export type WorkRefusal =
  | { readonly ok: false; readonly code: 'paused' | 'cancelled' | 'closed' | 'quota' | 'conflict' | 'baseline' | 'closed-run' | 'stale' | 'ownership' | 'missing' | 'recovery' | 'unknown' | 'invalid'; readonly message: string; readonly blockers?: readonly string[] }

/** A create or revise that would store an input the schema cannot read back. */
export class InputShapeError extends Error {
  readonly code = 'invalid' as const
  constructor(message: string) {
    super(message)
    this.name = 'InputShapeError'
  }
}

export interface ReserveInput {
  readonly changeId: string
  readonly kind?: RunKind
  readonly stepRefs?: readonly string[]
  readonly cwd?: string
  readonly root?: RootHint
  readonly writeScope: WriteScope
  readonly external?: readonly ExternalOccupant[]
  readonly at?: number
  readonly reworkOf?: string
}

export interface WorkPersist {
  (table: 'changes' | 'inputs' | 'runs' | 'verifications', key: string, value: unknown): Promise<void>
}

export interface WorkRows {
  /** `null` means the table could not be read. `undefined` means there is nothing to load. */
  readonly changes?: Iterable<unknown> | null
  readonly inputs?: Iterable<unknown> | null
  readonly runs?: Iterable<unknown> | null
  readonly verifications?: Iterable<unknown> | null
}

export class WorkBook {
  private readonly changes = new Map<string, ChangeRecord>()
  private readonly inputs = new Map<string, InputRecord>()
  private readonly runs = new Map<string, RunRecord>()
  private readonly verifications = new Map<string, VerificationRecord>()
  private chain: Promise<void> = Promise.resolve()
  private currentRevision = 0
  private changeSeq = 0
  private inputSeq = 0
  private runSeq = 0
  private deliverySeq = 0
  private verificationSeq = 0
  private recovery?: string
  /** Illegal verifications kept out of the usable map. They do not seal unknown-state and they are not deleted. */
  private verificationProblems?: string
  private readonly quarantined = new Map<string, IllegalVerification & { readonly record: unknown }>()
  /** In-process session lookups. A restarted book does not have these, so a persisted claim is leftover. */
  private readonly liveSessionClaims = new Set<string>()
  /** In-process relay/peer followups currently awaiting host completion. */
  private readonly liveRelayClaims = new Set<string>()

  constructor(private readonly persist: WorkPersist, private readonly platform: NodeJS.Platform = process.platform) {}

  get revision(): number { return this.currentRevision }
  get recoveryError(): string | undefined { return [this.recovery, this.verificationProblems].filter(Boolean).join('; ') || undefined }
  /** Stored verifications that failed the strict schema. The original record is still on the medium. */
  illegalVerifications(): readonly IllegalVerification[] {
    return [...this.quarantined.values()].map(({ record: _record, ...row }) => row)
  }
  /** The untouched illegal verification, when this book was given the raw row. */
  preservedVerification(id: string): unknown {
    return this.quarantined.get(id)?.record
  }

  static restore(rows: WorkRows, persist: WorkPersist, platform?: NodeJS.Platform): WorkBook {
    const book = new WorkBook(persist, platform)
    const problems: string[] = []
    book.loadRows(rows.changes, parseChange, book.changes, 'changes', problems)
    book.loadRows(rows.inputs, parseInput, book.inputs, 'inputs', problems)
    book.loadRows(rows.runs, parseRun, book.runs, 'runs', problems)
    const quarantined: string[] = []
    book.loadVerifications(rows.verifications, problems, quarantined)
    if (problems.length > 0) book.recovery = problems.join('; ')
    if (quarantined.length > 0) book.verificationProblems = quarantined.join('; ')
    book.changeSeq = maxSeq([...book.changes.keys()], 'c-')
    book.inputSeq = maxSeq([...book.inputs.keys()], 'input-')
    book.runSeq = maxSeq([...book.runs.keys()], 'run-')
    book.verificationSeq = maxSeq([...book.verifications.keys(), ...book.quarantined.keys()], 'v-')
    book.deliverySeq = maxDelivery(book.runs.values())
    return book
  }

  /** Empty the in-memory book. The caller deletes the durable rows. */
  clear(): void {
    this.changes.clear()
    this.inputs.clear()
    this.runs.clear()
    this.verifications.clear()
    this.quarantined.clear()
    this.liveSessionClaims.clear()
    this.liveRelayClaims.clear()
    this.chain = Promise.resolve()
    this.currentRevision = 0
    this.changeSeq = 0
    this.inputSeq = 0
    this.runSeq = 0
    this.deliverySeq = 0
    this.verificationSeq = 0
    this.recovery = undefined
    this.verificationProblems = undefined
  }

  listChanges(): readonly ChangeRecord[] { return [...this.changes.keys()].map(id => this.change(id)!) }
  change(id: string): ChangeRecord | undefined {
    const row = this.changes.get(id)
    return row ? { ...row, baselineRefs: this.baselinesFor(id) } : undefined
  }
  /** Runs own baseline publication; this list is only a read projection. */
  baselinesFor(changeId: string): readonly BaselineRef[] {
    const refs: BaselineRef[] = []
    for (const run of [...this.runs.values()].filter(run => run.changeId === changeId).sort((a, b) => a.createdAt - b.createdAt || Number(a.id.slice(4)) - Number(b.id.slice(4)))) {
      for (const ref of run.baselineRefs) if (!refs.some(item => sameBaseline(item, ref))) refs.push(ref)
    }
    return refs
  }
  input(id: string): InputRecord | undefined { return this.inputs.get(id) }
  inputsFor(changeId: string): readonly InputRecord[] {
    return [...this.inputs.values()].filter(row => row.changeId === changeId).sort((left, right) => left.revision - right.revision)
  }
  run(id: string): RunRecord | undefined { return this.runs.get(id) }
  listRuns(): readonly RunRecord[] { return [...this.runs.values()] }
  occupying(): readonly RunRecord[] { return [...this.runs.values()].filter(row => !TERMINAL.has(row.phase)) }

  /** The verification the board shows. Older rows stay stored but are not a current source. */
  latestVerification(changeId: string): VerificationRecord | undefined {
    return [...this.verifications.values()]
      .filter(row => row.changeId === changeId)
      .sort((left, right) => left.createdAt - right.createdAt || verificationOrder(left.id) - verificationOrder(right.id))
      .at(-1)
  }

  /** One stored verification. Reading evidence uses this id; it does not fall through to a newer row. */
  verification(id: string): VerificationRecord | undefined { return this.verifications.get(id) }

  /**
   * Failed rounds against the change's current input: writer/rework runs settled
   * with verdict fail plus verifications recorded as rework or unverified.
   */
  failedRounds(changeId: string): number {
    const change = this.changes.get(changeId)
    if (!change) return 0
    const failedRuns = [...this.runs.values()].filter(run =>
      run.changeId === changeId && run.kind !== 'review' && run.phase === 'failed'
      && run.inputRef === change.currentInputRef && run.inputRevision === change.currentRevision).length
    const failedVerifications = [...this.verifications.values()].filter(row =>
      row.changeId === changeId && row.inputRef === change.currentInputRef && row.inputRevision === change.currentRevision
      && (row.verdict === 'rework' || row.verdict === 'unverified')).length
    return failedRuns + failedVerifications
  }

  /** Failed rounds across every input revision, for whole-change outcome stats. */
  failedRoundsAcrossInputs(changeId: string): number {
    if (!this.changes.has(changeId)) return 0
    const failedRuns = [...this.runs.values()].filter(run =>
      run.changeId === changeId && run.kind !== 'review' && run.phase === 'failed').length
    const failedVerifications = [...this.verifications.values()].filter(row =>
      row.changeId === changeId && (row.verdict === 'rework' || row.verdict === 'unverified')).length
    return failedRuns + failedVerifications
  }

  /** Read-only board projection. Done is derived from closeout plus released runs. */
  workView(changeId: string) {
    const change = this.changes.get(changeId)
    if (!change) return undefined
    const runs = [...this.runs.values()].filter(run => run.changeId === changeId)
    const history = [...this.verifications.values()].filter(row => row.changeId === changeId).sort((left, right) => left.createdAt - right.createdAt || verificationOrder(left.id) - verificationOrder(right.id))
    const verification = history.at(-1)
    const review = runs.find(run => run.kind === 'review' && !TERMINAL.has(run.phase))
    const open = runs.filter(run => !TERMINAL.has(run.phase))
    const verdictBlocks = verification?.inputRef === change.currentInputRef && (verification.verdict === 'rework' || verification.verdict === 'unverified')
    const closeoutCurrent = !!change.closeout && verification?.id === change.closeout.verificationId && !verdictBlocks
    const done = closeoutCurrent && open.length === 0
    const status = change.control === 'cancelled' ? 'cancelled' as const
      : verdictBlocks ? verification!.verdict === 'unverified' ? 'unverified' as const : 'rework' as const
      : done ? 'done' as const
      : review ? 'review' as const
      : runs.some(run => run.phase === 'settling') ? 'settling' as const
      : open.length ? 'running' as const
      : 'waiting' as const
    const material = this.inputs.get(change.currentInputRef)
    const oversight = change.oversight
    const awaitsHumanDecision = oversight?.requested && oversight.inputRef === change.currentInputRef
      && !(oversight.inputRevision === change.currentRevision && oversight.decision?.result === 'accept'
        && oversight.decision.source === 'user' && oversight.decision.verificationId === verification?.id
        && oversight.decision.subjectKey === verification?.subjectKey)
    return {
      id: change.id, title: change.title, priority: change.priority, revision: change.currentRevision,
      inputRef: change.currentInputRef, control: change.control, status,
      ...(material?.goal ? { summary: material.goal } : {}),
      ...runCostTotals(runs),
      runs: runs.map(run => ({
        id: run.id, kind: run.kind, phase: run.phase, cwd: run.cwd,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        writeScope: run.writeScope,
        ...(run.usage ? { usage: run.usage } : {}),
        ...(run.wallMs !== undefined ? { wallMs: run.wallMs } : {}),
        ...(!TERMINAL.has(run.phase) ? { startedAt: run.createdAt } : {}),
        deliveries: run.deliveries.map(item => ({
          id: item.id, kind: item.kind, status: item.status, contentRef: item.contentRef,
          ...(item.evidence ? { evidence: item.evidence } : {}),
        })),
      })),
      blockers: open.map(run => run.id),
      verification: verification ? {
        id: verification.id, verdict: verification.verdict, subjectKey: verification.subjectKey,
        inputRef: verification.inputRef, inputRevision: verification.inputRevision,
        ...(verification.subject?.outOfScopePaths?.length ? { outOfScopePaths: verification.subject.outOfScopePaths } : {}),
        checks: verification.checks.map(check => ({
          requirementRef: check.requirementRef, verdict: check.verdict, evidenceRefs: check.evidenceRefs,
          ...(check.note ? { note: check.note } : {}),
        })),
        ...(verification.subject && verification.subject.changes.length > 0 ? {
          changes: verification.subject.changes.map(change => ({ path: change.path, kind: change.kind })),
        } : {}),
        ...(verification.subject && verification.subject.exclusions.length > 0 ? {
          exclusions: verification.subject.exclusions.map(item => ({ path: item.path, reason: item.reason })),
        } : {}),
      } : undefined,
      closeout: closeoutCurrent ? change.closeout : undefined,
      ...(change.isolation ? { isolation: change.isolation } : {}),
      oversight: change.oversight,
      humanAction: !change.closeout && !verdictBlocks && !awaitsHumanDecision && verification?.verdict === 'accept' && verification.subjectKey
        && verification.inputRef === change.currentInputRef && verification.inputRevision === change.currentRevision ? {
        action: 'accept' as const,
        expectedInputRef: change.currentInputRef,
        expectedInputRevision: change.currentRevision,
        expectedVerificationId: verification.id,
        expectedSubjectKey: verification.subjectKey,
      } : undefined,
    }
  }
  sessionRun(sessionId: string): RunRecord | undefined {
    return [...this.runs.values()].find(row => row.sessionId === sessionId || row.requestedSessionId === sessionId)
  }

  /**
   * One peer followup is in flight on this run. Finish cannot release the scope
   * while the mark is unknown. The check and the mark share the record lock.
   */
  holdPeer(sessionId: string, senderId: string, deliveryId: string, text: string, at = Date.now()): Promise<{ readonly ok: true } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.sessionRun(sessionId)
      if (!run) return { ok: false, code: 'missing', message: `${sessionId} has no run` }
      if (run.phase !== 'active') return { ok: false, code: 'closed-run', message: `${run.id} is ${run.phase}` }
      const allowed = this.dispatchAllowed(run.id)
      if (!allowed.ok) return allowed
      if (run.deliveries.some(item => item.kind === 'coordination' && item.hostRequestId === deliveryId)) return { ok: true }
      const row: DeliveryRecord = {
        id: `del-${++this.deliverySeq}`, kind: 'coordination', targetSessionId: sessionId,
        inputRevision: run.inputRevision, contentRef: text, source: senderId, hostRequestId: deliveryId,
        status: 'unknown', createdAt: at, updatedAt: at,
      }
      const next: RunRecord = { ...run, deliveries: [...run.deliveries, row], updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true }
    })
  }

  /** Close the in-flight peer mark. Rejected means followup did not happen. */
  settlePeer(sessionId: string, deliveryId: string, status: 'accepted' | 'rejected', at = Date.now()): Promise<void> {
    return this.exclusive(async () => {
      const run = this.sessionRun(sessionId)
      if (!run) return
      const deliveries = run.deliveries.map(item => item.kind === 'coordination' && item.hostRequestId === deliveryId && item.status === 'unknown'
        ? { ...item, status, updatedAt: at }
        : item)
      if (deliveries.every((item, index) => item === run.deliveries[index])) return
      const next: RunRecord = { ...run, deliveries, updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
    })
  }

  createChange(input: { title: string; cwd: string; goal: string; requirements?: readonly Requirement[]; requirementsFromGoal?: boolean; steps?: readonly StepSpec[]; source?: string; priority?: 1 | 2 | 3; maxConcurrentRuns?: number; constraints?: readonly Constraint[]; userRequest?: string; deliverableLanguage?: string; recipe?: { readonly id: string; readonly revision: number }; isolation?: TaskIsolation; at?: number }): Promise<ChangeRecord> {
    return this.exclusive(async () => {
      this.assertRecovered()
      const requirements = input.requirements ?? []
      const steps = input.steps ?? []
      const problem = inputContractError(requirements, steps, input.constraints)
      if (problem) throw new InputShapeError(problem)
      const at = input.at ?? Date.now()
      const changeId = `c-${++this.changeSeq}`
      const inputRow = this.inputRow(changeId, 1, input.goal, requirements, steps, input.source ?? 'user', at, {
        requirementsFromGoal: input.requirementsFromGoal,
        constraints: input.constraints,
        userRequest: input.userRequest,
        deliverableLanguage: input.deliverableLanguage,
      })
      await this.commit('inputs', inputRow.id, inputRow)
      this.inputs.set(inputRow.id, inputRow)
      const change: ChangeRecord = {
        id: changeId, title: input.title, cwd: canonicalPath(input.cwd, this.platform), baselineRefs: [],
        currentRevision: 1, currentInputRef: inputRow.id, control: 'open',
        steps: inputRow.steps.map(step => ({ stepRef: step.stepRef, done: false, inputRef: inputRow.id })),
        maxConcurrentRuns: clampConcurrency(input.maxConcurrentRuns), priority: input.priority ?? 2,
        ...(input.recipe ? { recipe: input.recipe } : {}),
        ...(input.isolation ? { isolation: input.isolation } : {}),
        createdAt: at, updatedAt: at,
      }
      await this.commit('changes', change.id, change)
      this.changes.set(change.id, change)
      this.currentRevision += 1
      return change
    })
  }

  reviseChange(changeId: string, patch: { goal?: string; requirements?: readonly Requirement[]; requirementsFromGoal?: boolean; steps?: readonly StepSpec[]; cwd?: string; constraints?: readonly Constraint[]; userRequest?: string; deliverableLanguage?: string; title?: string; priority?: 1 | 2 | 3; maxConcurrentRuns?: number; source?: string; at?: number }): Promise<ChangeRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const current = this.changes.get(changeId)
      if (!current) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
      const at = patch.at ?? Date.now()
      const semantic = patch.goal !== undefined || patch.requirements !== undefined || patch.requirementsFromGoal !== undefined || patch.steps !== undefined || patch.cwd !== undefined || patch.constraints !== undefined || patch.userRequest !== undefined || patch.deliverableLanguage !== undefined
      if (!semantic) {
        const next: ChangeRecord = {
          ...current,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
          ...(patch.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: clampConcurrency(patch.maxConcurrentRuns) } : {}),
          updatedAt: at,
        }
        await this.commit('changes', next.id, next)
        this.changes.set(next.id, next)
        this.currentRevision += 1
        return next
      }
      const previous = this.inputs.get(current.currentInputRef)
      if (!previous) return { ok: false, code: 'missing', message: `missing input ${current.currentInputRef}` }
      const requirementsFromGoal = patch.requirementsFromGoal ?? (patch.requirements !== undefined ? false : previous.requirementsFromGoal)
      const nextGoal = patch.goal ?? previous.goal
      const requirements = patch.requirements ?? (requirementsFromGoal && patch.goal !== undefined
        ? [{ requirementRef: 'goal', text: nextGoal, required: true }]
        : previous.requirements)
      const steps = patch.steps ?? previous.steps
      const constraints = patch.constraints !== undefined ? patch.constraints : previous.constraints
      const problem = inputContractError(requirements, steps, constraints)
      if (problem) return { ok: false, code: 'invalid', message: problem }
      const inputRow = this.inputRow(changeId, current.currentRevision + 1, nextGoal, requirements, steps, patch.source ?? 'revision', at, {
        requirementsFromGoal,
        constraints,
        userRequest: patch.userRequest !== undefined ? patch.userRequest : previous.userRequest,
        deliverableLanguage: patch.deliverableLanguage !== undefined ? patch.deliverableLanguage : previous.deliverableLanguage,
        supersedes: previous.id,
      })
      await this.commit('inputs', inputRow.id, inputRow)
      this.inputs.set(inputRow.id, inputRow)
      const { closeout: _closed, ...kept } = current
      const oversight = current.oversight?.requested
        ? { requested: true, inputRef: inputRow.id, inputRevision: inputRow.revision }
        : current.oversight
      const next: ChangeRecord = {
        ...kept,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.cwd !== undefined ? { cwd: canonicalPath(patch.cwd, this.platform) } : {}),
        ...(oversight ? { oversight } : {}),
        currentRevision: inputRow.revision,
        currentInputRef: inputRow.id,
        steps: inputRow.steps.map(step => {
          const prior = current.steps.find(item => item.stepRef === step.stepRef && item.inputRef === previous.id)
          return { stepRef: step.stepRef, done: false, inputRef: inputRow.id, ...(prior?.runId ? { runId: prior.runId } : {}) }
        }),
        updatedAt: at,
      }
      await this.commit('changes', next.id, next)
      this.changes.set(next.id, next)
      this.currentRevision += 1
      return this.change(next.id)!
    })
  }

  /** Remember that the user asked to see the current input. This is not itself a decision. */
  requestOversight(changeId: string, at = Date.now()): Promise<ChangeRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const current = this.changes.get(changeId)
      if (!current) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
      const next: ChangeRecord = {
        ...current,
        oversight: { requested: true, inputRef: current.currentInputRef, inputRevision: current.currentRevision },
        updatedAt: at,
      }
      await this.commit('changes', next.id, next)
      this.changes.set(next.id, next)
      this.currentRevision += 1
      return this.change(next.id)!
    })
  }

  /** Record the user's decision for the input they were shown. A mismatched revision is kept out. */
  noteOversight(changeId: string, decision: { readonly result: 'accept' | 'reject'; readonly verificationId?: string; readonly subjectKey?: string; readonly source: string; readonly expectedInputRevision: number }, at = Date.now()): Promise<ChangeRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const current = this.changes.get(changeId)
      if (!current) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
      if (!current.oversight?.requested || current.oversight.inputRef !== current.currentInputRef) {
        return { ok: false, code: 'stale', message: `${changeId} is not waiting for the user` }
      }
      if (decision.expectedInputRevision !== current.currentRevision || current.oversight.inputRevision !== current.currentRevision) {
        return { ok: false, code: 'stale', message: 'the human decision is for an older version' }
      }
      const next: ChangeRecord = {
        ...current,
        oversight: {
          ...current.oversight,
          decision: {
            result: decision.result,
            source: decision.source,
            at,
            ...(decision.verificationId ? { verificationId: decision.verificationId } : {}),
            ...(decision.subjectKey ? { subjectKey: decision.subjectKey } : {}),
          },
        },
        updatedAt: at,
      }
      await this.commit('changes', next.id, next)
      this.changes.set(next.id, next)
      this.currentRevision += 1
      return this.change(next.id)!
    })
  }

  /** Remember that this exact user decision was delivered to dot. A newer decision is left alone. */
  markDecisionNotified(changeId: string, match: { readonly verificationId: string; readonly subjectKey: string; readonly at: number }, notifiedAt: number): Promise<ChangeRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const current = this.changes.get(changeId)
      const decision = current?.oversight?.decision
      if (!current || !decision) return { ok: false, code: 'missing', message: `${changeId} has no decision` }
      if (decision.verificationId !== match.verificationId || decision.subjectKey !== match.subjectKey || decision.at !== match.at) {
        return { ok: false, code: 'stale', message: `${changeId} decision changed before the wake was marked` }
      }
      if (decision.notifiedAt !== undefined) return current
      const next: ChangeRecord = {
        ...current,
        oversight: { ...current.oversight!, decision: { ...decision, notifiedAt } },
        updatedAt: notifiedAt,
      }
      await this.commit('changes', next.id, next)
      this.changes.set(next.id, next)
      this.currentRevision += 1
      return this.change(next.id)!
    })
  }

  setControl(changeId: string, control: ChangeControl, at = Date.now()): Promise<ChangeRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const current = this.changes.get(changeId)
      if (!current) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
      const next = { ...current, control, updatedAt: at }
      await this.commit('changes', next.id, next)
      this.changes.set(next.id, next)
      this.currentRevision += 1
      return this.change(next.id)!
    })
  }

  /** Steps are current-input progress notes; requirement checks decide completion. */
  noteStep(changeId: string, stepRef: string, runId: string | undefined, expectedInputRevision: number, at = Date.now()): Promise<ChangeRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const current = this.changes.get(changeId)
      if (!current) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
      if (expectedInputRevision !== current.currentRevision) return { ok: false, code: 'stale', message: `${stepRef} is not on revision ${current.currentRevision}` }
      if (!this.inputs.get(current.currentInputRef)?.steps.some(step => step.stepRef === stepRef)) return { ok: false, code: 'stale', message: `${changeId} has no step ${stepRef}` }
      const run = runId ? this.runs.get(runId) : undefined
      if (runId && (!run || run.changeId !== changeId || run.inputRef !== current.currentInputRef)) return { ok: false, code: 'stale', message: `${runId} is not on this input` }
      const next: ChangeRecord = {
        ...current,
        steps: current.steps.map(step => step.stepRef === stepRef ? { stepRef, done: true, inputRef: current.currentInputRef, ...(runId ? { runId } : {}) } : step),
        updatedAt: at,
      }
      await this.commit('changes', next.id, next)
      this.changes.set(next.id, next)
      this.currentRevision += 1
      return this.change(next.id)!
    })
  }

  reserveRun(input: ReserveInput): Promise<{ readonly ok: true; readonly run: RunRecord; readonly revision: number } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const change = this.changes.get(input.changeId)
      if (!change) return { ok: false, code: 'missing', message: `unknown change ${input.changeId}` }
      if (change.control === 'paused') return { ok: false, code: 'paused', message: `${change.id} is paused` }
      if (change.control === 'cancelled') return { ok: false, code: 'cancelled', message: `${change.id} is cancelled` }
      if (change.closeout) return { ok: false, code: 'closed', message: `${change.id} is closed out; revise it with a new goal before reserving another run` }
      const material = this.inputs.get(change.currentInputRef)
      if (!material) return { ok: false, code: 'missing', message: `unpublished input ${change.currentInputRef}` }
      if (input.stepRefs?.some(ref => !material.steps.some(step => step.stepRef === ref))) {
        return { ok: false, code: 'stale', message: `${change.id} has no step ${input.stepRefs.find(ref => !material.steps.some(step => step.stepRef === ref))}` }
      }
      const active = [...this.runs.values()].filter(row => row.changeId === change.id && !TERMINAL.has(row.phase))
      if (active.length >= change.maxConcurrentRuns) return { ok: false, code: 'quota', message: `${change.id} already has ${active.length} open runs` }
      const cwd = canonicalPath(input.cwd ?? change.cwd, this.platform)
      const hint = input.root ?? {}
      const identity = workspaceIdentity(cwd, hint, this.platform)
      const uncertainBoundary = identity.uncertainBoundary || (input.writeScope.kind === 'workspace-exclusive' && hint.workspaceRoot === undefined && hint.gitCommonDir === undefined)
      const candidate: Occupant = { id: 'next', cwd, workspaceRoot: identity.workspaceRoot, exclusiveRoot: identity.exclusiveRoot, uncertainBoundary, writeScope: input.writeScope }
      const blockers = this.blockerIds(candidate, input.external ?? [])
      if (blockers.length > 0) return { ok: false, code: 'conflict', message: `blocked by ${blockers.join(', ')}`, blockers }
      const at = input.at ?? Date.now()
      const id = `run-${++this.runSeq}`
      const delivery: DeliveryRecord = {
        id: `del-${++this.deliverySeq}`, kind: 'initial', targetSessionId: `session-${id}`,
        inputRevision: material.revision, contentRef: `content-${id}-initial`, source: 'reserve', status: 'intent',
        createdAt: at, updatedAt: at,
      }
      const run: RunRecord = {
        id, changeId: change.id, kind: input.kind ?? 'work', inputRevision: material.revision, inputRef: material.id,
        stepRefs: [...(input.stepRefs ?? material.steps.map(step => step.stepRef))], cwd,
        workspaceRoot: identity.workspaceRoot, exclusiveRoot: identity.exclusiveRoot, uncertainBoundary,
        writeScope: input.writeScope, baselineRefs: [], requestedSessionId: `session-${id}`, creation: 'intent',
        access: input.kind === 'review' ? 'read' : scopeWrites(input.writeScope) ? 'write' : 'read',
        deliveries: [delivery], phase: 'reserved', ...(input.reworkOf ? { reworkOf: input.reworkOf } : {}),
        createdAt: at, updatedAt: at,
      }
      await this.commit('runs', run.id, run)
      this.runs.set(run.id, run)
      this.currentRevision += 1
      return { ok: true, run, revision: this.currentRevision }
    })
  }

  /** Publish the pre-write baseline on its run after the caller verifies the snapshot. */
  publishBaseline(runId: string, expectedRevision: number, artifactRef: string, at = Date.now(), confirm?: (run: RunRecord) => WorkRefusal | undefined): Promise<{ readonly applied: true; readonly run: RunRecord } | WorkRefusal & { readonly revision: number }> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return { ...refused, revision: this.currentRevision }
      if (this.currentRevision !== expectedRevision) return { ok: false, code: 'stale', message: `revision ${expectedRevision} is no longer current`, revision: this.currentRevision }
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}`, revision: this.currentRevision }
      if (run.phase !== 'reserved') return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}`, revision: this.currentRevision }
      const gate = this.assignmentGate(run)
      if (gate) return { ...gate, revision: this.currentRevision }
      const confirmed = confirm?.(run)
      if (confirmed) return { ...confirmed, revision: this.currentRevision }
      const ref: BaselineRef = { workspaceRoot: run.workspaceRoot, scopeKey: scopeKey(run.writeScope, run.workspaceRoot, this.platform), artifactRef }
      const next: RunRecord = { ...run, baselineRefs: [...run.baselineRefs.filter(item => item.scopeKey !== ref.scopeKey), ref], updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { applied: true, run: next }
    })
  }

  /** A write run may be dispatched only when its change, input and published baseline still agree. */
  dispatchAllowed(runId: string): { readonly ok: true } | WorkRefusal {
    const refused = this.recoveryRefusal()
    if (refused) return refused
    const run = this.runs.get(runId)
    if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
    if (TERMINAL.has(run.phase) || run.phase === 'settling') return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
    const gate = this.assignmentGate(run)
    if (gate) return gate
    if (!scopeWrites(run.writeScope)) return { ok: true }
    const key = scopeKey(run.writeScope, run.workspaceRoot, this.platform)
    const ref = run.baselineRefs.find(item => item.scopeKey === key && item.workspaceRoot === run.workspaceRoot)
    if (!ref) return { ok: false, code: 'baseline', message: `${runId} has no published baseline for ${key}` }
    return { ok: true }
  }

  addDelivery(runId: string, delivery: Omit<DeliveryRecord, 'id' | 'createdAt' | 'updatedAt'> & { readonly at?: number }): Promise<RunRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (run.phase === 'settling' || TERMINAL.has(run.phase)) return { ok: false, code: 'closed-run', message: `${runId} rejects new deliveries` }
      const gate = this.assignmentGate(run, { targetSessionId: delivery.targetSessionId, inputRevision: delivery.inputRevision })
      if (gate) return gate
      const at = delivery.at ?? Date.now()
      const { at: _at, ...fields } = delivery
      const row: DeliveryRecord = { ...fields, id: `del-${++this.deliverySeq}`, createdAt: at, updatedAt: at }
      const next = { ...run, deliveries: [...run.deliveries, row], updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return next
    })
  }

  recordVerification(changeId: string, checks: readonly CheckRecord[], runIds: readonly string[], at = Date.now(), detail?: {
    readonly inputRef?: string
    readonly inputRevision?: number
    readonly reviewRunId?: string
    readonly reviewerSessionId?: string
    readonly subject?: DeliverySubject
  }): Promise<VerificationRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const change = this.changes.get(changeId)
      if (!change) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
      for (const check of checks) {
        if (check?.applicability !== 'applicable' && check?.applicability !== 'not-applicable') {
          return { ok: false, code: 'stale', message: `applicability must be applicable or not-applicable, not ${String(check?.applicability)}` }
        }
      }
      if (detail?.subject && !subjectSchema.safeParse(detail.subject).success) {
        const missingScope = subjectSchema.safeParse(detail.subject).error?.issues.some(issue => issue.path.includes('scopeKey'))
        return {
          ok: false,
          code: 'baseline',
          message: missingScope ? 'subject baselineRefs require workspaceRoot, scopeKey, and artifactRef' : 'subject does not match the delivery schema',
        }
      }
      for (const runId of runIds) {
        const named = this.runs.get(runId)
        if (!named || named.changeId !== changeId) return { ok: false, code: 'ownership', message: `${runId} is not a run of ${changeId}` }
      }
      if (!detail?.inputRef || detail.inputRevision === undefined) return { ok: false, code: 'stale', message: 'verification must name the tested input' }
      const material = this.inputs.get(detail.inputRef)
      if (!material || material.changeId !== changeId || material.revision !== detail.inputRevision) {
        return { ok: false, code: 'stale', message: 'verification names an input this change does not have' }
      }
      const subject = detail.subject
      if (!detail.reviewRunId && !detail.reviewerSessionId) {
        if (subject && canonicalPath(change.cwd, this.platform) !== canonicalPath(subject.workspaceRoot, this.platform)) {
          return { ok: false, code: 'ownership', message: 'delivery workspace does not match the change' }
        }
      } else if (detail.reviewRunId || detail.reviewerSessionId || subject) {
        const writers = [...this.runs.values()].filter(run => run.changeId === changeId && run.kind !== 'review')
        const review = detail.reviewRunId ? this.runs.get(detail.reviewRunId) : undefined
        const bound = this.reviewGap(review, changeId, subject, detail.reviewerSessionId, detail.inputRef, detail.inputRevision, writers)
        if (bound) return { ok: false, code: bound.code, message: bound.message }
      }
      const verdict = judgeVerification(material.requirements, checks)
      const row: VerificationRecord = freezeRecord(structuredClone({
        id: `v-${++this.verificationSeq}`, changeId, inputRevision: material.revision, inputRef: material.id,
        runIds: [...runIds], checks: [...checks], verdict, createdAt: at,
        ...(detail.reviewRunId ? { reviewRunId: detail.reviewRunId } : {}),
        ...(detail.reviewerSessionId ? { reviewerSessionId: detail.reviewerSessionId } : {}),
        ...(subject ? { subject, subjectKey: subjectKey(subject, {
          inputRef: material.id, inputRevision: material.revision, runIds, checks,
          reviewRunId: detail.reviewRunId, reviewerSessionId: detail.reviewerSessionId,
        }) } : {}),
      }))
      await this.commit('verifications', row.id, row)
      this.verifications.set(row.id, row)
      this.currentRevision += 1
      return row
    })
  }

  /** Closed. Closeout goes through accept, which checks the delivery and the review. */
  closeOut(_changeId: string, _verificationId: string, _source: string, _at = Date.now()): Promise<WorkRefusal> {
    return Promise.resolve({ ok: false, code: 'closed', message: 'closeOut is closed; use dot_task action=closeout' })
  }

  /** Remember that a settling review has stopped. This does not release it. */
  noteClosure(runId: string, evidence: { readonly queueCleared: boolean; readonly agentIdle: boolean; readonly jobsSettled: boolean }, at = Date.now()): Promise<RunRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (run.phase !== 'settling') return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      const next: RunRecord = { ...run, closureEvidence: evidence, updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return next
    })
  }

  /** Closeout validates one input, delivery and set of checks; an independent review is optional. */
  accept(changeId: string, verificationId: string, expectedInputRef: string, expectedSubjectKey: string, source: string, at = Date.now(), human?: { readonly expectedInputRevision: number; readonly expectedVerificationId: string }, look?: SubjectLook): Promise<ChangeRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const current = this.changes.get(changeId)
      if (!current) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
      if (current.control !== 'open') return { ok: false, code: current.control, message: `${changeId} is ${current.control}` }
      if (current.closeout) return { ok: false, code: 'closed', message: `${changeId} is already closed out` }
      const verification = this.verifications.get(verificationId)
      if (!verification || verification.changeId !== changeId) return { ok: false, code: 'missing', message: `unknown verification ${verificationId}` }
      if (verification.verdict !== 'accept') return { ok: false, code: 'stale', message: `${verificationId} is ${verification.verdict}` }
      if (verification.inputRef !== current.currentInputRef || expectedInputRef !== current.currentInputRef || verification.inputRevision !== current.currentRevision) {
        return { ok: false, code: 'stale', message: `${verificationId} does not match the current input` }
      }
      if (!verification.subject || !verification.subjectKey || verification.subjectKey !== expectedSubjectKey) {
        return { ok: false, code: 'stale', message: `${verificationId} does not match the current delivery` }
      }
      const later = [...this.verifications.values()].some(row => row.changeId === changeId && row.id !== verification.id && row.inputRef === verification.inputRef && (row.verdict === 'rework' || row.verdict === 'unverified') && newerVerification(row, verification))
      if (later) return { ok: false, code: 'stale', message: `${verificationId} was superseded` }
      const changeRuns = [...this.runs.values()].filter(run => run.changeId === changeId)
      const review = verification.reviewRunId ? this.runs.get(verification.reviewRunId) : undefined
      const writers = changeRuns.filter(run => run.kind !== 'review')
      if (verification.reviewRunId || verification.reviewerSessionId) {
        const bound = this.reviewGap(review, changeId, verification.subject, verification.reviewerSessionId, verification.inputRef, verification.inputRevision, writers)
        if (bound) return { ok: false, code: bound.code, message: bound.message }
        if (!review || review.phase !== 'settling') return { ok: false, code: 'unknown', message: `${review?.id ?? verificationId} is not held for closeout` }
        const evidence = review.closureEvidence
        if (!evidence?.queueCleared || !evidence.agentIdle || !evidence.jobsSettled) return { ok: false, code: 'unknown', message: `${review.id} is not confirmed stopped` }
      }
      const openReviews = changeRuns.filter(run => run.kind === 'review' && run.id !== review?.id && !TERMINAL.has(run.phase))
      if (openReviews.length > 0) {
        return { ok: false, code: 'conflict', message: `${openReviews[0]!.id} is an open review; use action=closeout through it or action=reject first`, blockers: openReviews.map(run => run.id) }
      }
      const openWriters = writers.filter(run => !TERMINAL.has(run.phase))
      if (openWriters.length > 0) {
        return { ok: false, code: 'conflict', message: `${openWriters[0]!.id} is still open`, blockers: openWriters.map(run => run.id) }
      }
      for (const writer of writers) {
        const sent = writer.creation === 'confirmed' || writer.deliveries.some(item => item.status === 'accepted' || item.status === 'unknown')
        if (!sent) continue
        const ev = writer.closureEvidence
        if (!ev?.queueCleared || !ev.agentIdle || !ev.jobsSettled) {
          return { ok: false, code: 'unknown', message: `${writer.id} is not confirmed stopped` }
        }
      }
      const omitted = writers.filter(run => scopeWrites(run.writeScope) && !verification.runIds.includes(run.id))
      if (omitted.length > 0) return { ok: false, code: 'stale', message: `${omitted[0]!.id} is missing from the delivery` }
      if (this.inFlight(changeRuns)) return { ok: false, code: 'unknown', message: `${changeId} still has an in-flight delivery` }
      const gap = subjectMaterial(verification.subject, this.baselinesFor(changeId), changeRuns, verification.checks.flatMap(check => check.evidenceRefs), look)
      if (gap) return { ok: false, code: 'baseline', message: gap }
      const material = this.inputs.get(current.currentInputRef)
      if (!material) return { ok: false, code: 'missing', message: 'missing input' }
      if (judgeVerification(material.requirements, verification.checks) !== 'accept') {
        return { ok: false, code: 'stale', message: `${verificationId} does not cover the current requirements` }
      }
      if (!human || human.expectedInputRevision !== current.currentRevision || human.expectedVerificationId !== verificationId) {
        return { ok: false, code: 'stale', message: 'the decision is for an older version' }
      }
      if (current.oversight?.requested && current.oversight.inputRef === current.currentInputRef) {
        const decision = current.oversight.decision
        if (!decision || decision.result !== 'accept' || decision.source !== 'user' || decision.verificationId !== verificationId || decision.subjectKey !== verification.subjectKey || current.oversight.inputRevision !== current.currentRevision) {
          return { ok: false, code: 'stale', message: 'the user asked to see this version' }
        }
      }
      // A review released as rework is an explicit rejection of this delivery. Direct
      // closeout must not overrule it: only a verification recorded after that rework
      // (that is, work done in answer to it) may close the change.
      const rejectedAfter = changeRuns.filter(run => run.kind === 'review' && run.phase === 'stopped' && run.closeReason === 'rework' && run.updatedAt > verification.createdAt)
      if (rejectedAfter.length > 0) {
        return { ok: false, code: 'conflict', message: `${rejectedAfter[0]!.id} rejected this delivery; record a new verification after the rework`, blockers: rejectedAfter.map(run => run.id) }
      }
      const next: ChangeRecord = {
        ...current,
        closeout: { verificationId, source, inputRef: current.currentInputRef, subjectKey: verification.subjectKey, at },
        updatedAt: at,
      }
      await this.commit('changes', next.id, next)
      this.changes.set(next.id, next)
      if (review) {
        const released: RunRecord = { ...review, phase: 'stopped', closeReason: 'closeout', updatedAt: at }
        await this.commit('runs', released.id, released)
        this.runs.set(released.id, released)
      }
      this.currentRevision += 1
      return next
    })
  }

  acceptDirect(...args: Parameters<WorkBook['accept']>): ReturnType<WorkBook['accept']> {
    return this.accept(...args)
  }

  /**
   * Close the review to new deliveries before any host stop.
   * Identity and the first prompt are checked here, so a rejected session is never stopped.
   */
  prepareReviewHold(runId: string, at = Date.now()): Promise<{ readonly ok: true; readonly updatedAt: number; readonly sessionId: string } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      const gate = this.reviewHoldGate(run)
      if (gate) return gate
      if (run.phase === 'settling' && run.closureEvidence?.queueCleared && run.closureEvidence.agentIdle && run.closureEvidence.jobsSettled) {
        return { ok: true, updatedAt: run.updatedAt, sessionId: run.sessionId! }
      }
      const { closeIntent: _dropped, closureEvidence: _old, ...rest } = run
      const next: RunRecord = { ...rest, phase: 'settling', updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, updatedAt: next.updatedAt, sessionId: next.sessionId! }
    })
  }

  /** The stop receipt counts only when nothing was added while the host was stopping. */
  completeReviewHold(runId: string, seenUpdatedAt: number, evidence: { readonly queueCleared: boolean; readonly agentIdle: boolean; readonly jobsSettled: boolean }, at = Date.now()): Promise<RunRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      const gate = this.reviewHoldGate(run)
      if (gate) return gate
      if (run.phase !== 'settling') return { ok: false, code: 'unknown', message: `${runId} is not held for closeout` }
      if (run.updatedAt !== seenUpdatedAt) return { ok: false, code: 'stale', message: `${runId} changed while it was stopping` }
      if (!evidence.queueCleared || !evidence.agentIdle || !evidence.jobsSettled) return { ok: false, code: 'unknown', message: `${runId} is not confirmed stopped` }
      const next: RunRecord = { ...run, closureEvidence: evidence, updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return next
    })
  }

  /**
   * Stop is proved and the review stays in `settling` with the workspace held.
   * A close intent left by the generic finish path is dropped so recovery cannot release it.
   */
  holdReview(runId: string, evidence: { readonly queueCleared: boolean; readonly agentIdle: boolean; readonly jobsSettled: boolean }, at = Date.now()): Promise<RunRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (run.kind !== 'review') return { ok: false, code: 'ownership', message: `${runId} is not a review` }
      const gate = this.reviewHoldGate(run)
      if (gate) return gate
      if (TERMINAL.has(run.phase)) return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      const change = this.changes.get(run.changeId)
      if (!change) return { ok: false, code: 'missing', message: `unknown change ${run.changeId}` }
      if (change.control === 'cancelled') return { ok: false, code: 'cancelled', message: `${change.id} is cancelled` }
      if (change.closeout) return { ok: false, code: 'closed', message: `${change.id} is already closed out` }
      if (this.inFlight([run])) return { ok: false, code: 'unknown', message: `${runId} still has an in-flight delivery` }
      if (!evidence.queueCleared || !evidence.agentIdle || !evidence.jobsSettled) return { ok: false, code: 'unknown', message: `${runId} is not confirmed stopped` }
      const { closeIntent: _dropped, ...rest } = run
      const next: RunRecord = { ...rest, phase: 'settling', closureEvidence: evidence, updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return next
    })
  }

  /** A closeout that landed without releasing the review is finished. It is not accepted again. */
  resumeCloseout(changeId: string, at = Date.now()): Promise<{ readonly ok: true; readonly released: boolean } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const current = this.changes.get(changeId)
      if (!current) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
      if (!current.closeout) return { ok: true, released: false }
      const verification = this.verifications.get(current.closeout.verificationId)
      const review = verification?.reviewRunId ? this.runs.get(verification.reviewRunId) : undefined
      if (!review || TERMINAL.has(review.phase)) return { ok: true, released: false }
      if (review.phase !== 'settling') return { ok: false, code: 'unknown', message: `${review.id} is ${review.phase}` }
      const evidence = review.closureEvidence
      if (!evidence?.queueCleared || !evidence.agentIdle || !evidence.jobsSettled) return { ok: false, code: 'unknown', message: `${review.id} is not confirmed stopped` }
      const released: RunRecord = { ...review, phase: 'stopped', closeReason: 'closeout', updatedAt: at }
      await this.commit('runs', released.id, released)
      this.runs.set(released.id, released)
      this.currentRevision += 1
      return { ok: true, released: true }
    })
  }

  /**
   * A rejected or stale review releases only after its stop is proved.
   * No successful closeout is written. The follow-up run is a new reservation.
   */
  reopenAfterReview(changeId: string, reviewRunId: string, at = Date.now(), expectedInputRevision?: number): Promise<{ readonly ok: true; readonly run: RunRecord } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const current = this.changes.get(changeId)
      if (!current) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
      if (current.closeout) return { ok: false, code: 'closed', message: `${changeId} is already closed out` }
      if (expectedInputRevision === undefined || expectedInputRevision !== current.currentRevision) {
        return { ok: false, code: 'stale', message: 'the rejection is for an older version' }
      }
      const review = this.runs.get(reviewRunId)
      if (!review || review.changeId !== changeId || review.kind !== 'review') return { ok: false, code: 'missing', message: `unknown review ${reviewRunId}` }
      if (review.phase !== 'settling') return { ok: false, code: 'unknown', message: `${review.id} is not held for closeout` }
      if (review.creation === 'unknown' || review.creation === 'rejected' || review.creation === 'inflight') {
        return { ok: false, code: 'unknown', message: `${review.id} still has an unconfirmed host call` }
      }
      if (this.inFlight([review])) return { ok: false, code: 'unknown', message: `${review.id} still has an in-flight delivery` }
      const evidence = review.closureEvidence
      if (!evidence?.queueCleared || !evidence.agentIdle || !evidence.jobsSettled) return { ok: false, code: 'unknown', message: `${review.id} is not confirmed stopped` }
      const released: RunRecord = { ...review, phase: 'stopped', closeReason: 'rework', updatedAt: at }
      await this.commit('runs', released.id, released)
      this.runs.set(released.id, released)
      this.currentRevision += 1
      return { ok: true, run: released }
    })
  }

  /** Record the host session. A different id, cwd, or persisted preset never becomes a confirmed prompt target. */
  confirmSession(runId: string, actual: { readonly sessionId: string; readonly cwd?: string; readonly preset?: string }, at = Date.now()): Promise<{ readonly ok: true; readonly prompt: boolean; readonly run: RunRecord } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (run.phase !== 'reserved') return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      const gate = this.assignmentGate(run)
      if (gate) return gate
      const sameId = actual.sessionId === run.requestedSessionId
      const cwdKnown = actual.cwd !== undefined
      const cwdMatches = cwdKnown && sameSessionCwd(actual.cwd!, run.cwd, this.platform)
      const expectedPreset = run.expectedPreset
      const presetRequired = expectedPreset !== undefined
      const presetKnown = actual.preset !== undefined
      const presetMatches = !presetRequired || (presetKnown && actual.preset === expectedPreset)
      const mismatched = !sameId || (cwdKnown && !cwdMatches) || (presetRequired && presetKnown && actual.preset !== expectedPreset)
      const prompt = sameId && cwdMatches && presetMatches
      const next: RunRecord = dropClaim({
        ...run,
        sessionId: actual.sessionId,
        creation: prompt ? 'confirmed' : mismatched ? 'rejected' : 'unknown',
        updatedAt: at,
      })
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, prompt, run: next }
    })
  }

  markCreation(runId: string, creation: 'inflight' | 'intent' | 'unknown' | 'rejected', at = Date.now()): Promise<RunRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (TERMINAL.has(run.phase)) return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      const base = creation === 'intent' ? dropClaim(run) : run
      const next: RunRecord = { ...base, creation, updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return next
    })
  }

  /**
   * One caller owns the session lookup. A second caller gets `owned: false`
   * and must not create or prompt. `unknown` stays `unknown`.
   */
  claimSession(runId: string, preset?: string, at = Date.now()): Promise<{ readonly ok: true; readonly owned: boolean } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (run.phase !== 'reserved') return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      if (run.creation === 'rejected') return { ok: false, code: 'closed-run', message: `${runId} session identity was rejected` }
      if (run.actionClaim || run.creation === 'inflight') return { ok: true, owned: false }
      const allowed = this.dispatchAllowed(runId)
      if (!allowed.ok) return allowed
      const next: RunRecord = {
        ...run,
        actionClaim: 'session',
        creation: run.creation === 'unknown' ? 'unknown' : 'inflight',
        ...(preset ? { expectedPreset: preset } : {}),
        updatedAt: at,
      }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      this.liveSessionClaims.add(runId)
      return { ok: true, owned: true }
    })
  }

  liveSessionClaim(runId: string): boolean { return this.liveSessionClaims.has(runId) }

  releaseLiveSessionClaim(runId: string): void { this.liveSessionClaims.delete(runId) }

  claimLiveRelay(deliveryId: string): void { this.liveRelayClaims.add(deliveryId) }

  releaseLiveRelay(deliveryId: string): void { this.liveRelayClaims.delete(deliveryId) }

  hasLiveRelay(deliveryId: string): boolean { return this.liveRelayClaims.has(deliveryId) }

  /** A persisted cancel covers every run that never reached settling. */
  adoptCancel(runId: string, at = Date.now()): Promise<{ readonly ok: true; readonly adopted: boolean } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (TERMINAL.has(run.phase)) return { ok: true, adopted: false }
      const change = this.changes.get(run.changeId)
      if (change?.control !== 'cancelled') return { ok: true, adopted: false }
      if (run.phase === 'settling' && run.closeIntent) return { ok: true, adopted: false }
      const next: RunRecord = { ...run, phase: 'settling', closeIntent: run.closeIntent ?? 'stopped', updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, adopted: true }
    })
  }

  /**
   * Close a leftover session claim without the new-delivery gate.
   * A claim this process still holds is left untouched.
   */
  settleSessionClaim(runId: string, actual: { readonly sessionId: string; readonly cwd?: string; readonly preset?: string }, at = Date.now()): Promise<{ readonly ok: true; readonly creation: CreationStatus; readonly held: boolean } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (TERMINAL.has(run.phase)) return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      if (this.liveSessionClaims.has(runId)) return { ok: true, creation: run.creation, held: true }
      if (run.actionClaim !== 'session' && run.creation !== 'inflight') return { ok: true, creation: run.creation, held: false }
      const sameId = actual.sessionId === run.requestedSessionId
      const cwdKnown = actual.cwd !== undefined
      const cwdMatches = cwdKnown && sameSessionCwd(actual.cwd!, run.cwd, this.platform)
      const expectedPreset = run.expectedPreset
      const presetRequired = expectedPreset !== undefined
      const presetKnown = actual.preset !== undefined
      const presetMatches = !presetRequired || (presetKnown && actual.preset === expectedPreset)
      const mismatched = !sameId || (cwdKnown && !cwdMatches) || (presetRequired && presetKnown && actual.preset !== expectedPreset)
      const confirmed = sameId && cwdMatches && presetMatches
      const next: RunRecord = dropClaim({
        ...run,
        sessionId: actual.sessionId,
        creation: confirmed ? 'confirmed' : mismatched ? 'rejected' : 'unknown',
        updatedAt: at,
      })
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, creation: next.creation, held: false }
    })
  }

  /** The requested session is absent, so a leftover create claim did not land. */
  abandonSessionClaim(runId: string, at = Date.now()): Promise<{ readonly ok: true; readonly abandoned: boolean } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (TERMINAL.has(run.phase)) return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      if (this.liveSessionClaims.has(runId)) return { ok: true, abandoned: false }
      if (run.actionClaim !== 'session' && run.creation !== 'inflight') return { ok: true, abandoned: false }
      const next: RunRecord = dropClaim({ ...run, creation: run.sessionId ? 'unknown' : 'intent', updatedAt: at })
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, abandoned: true }
    })
  }

  /** Reset a reserved run whose earlier lookup/create failed once the host confirms no session exists. */
  abandonUnknownCreation(runId: string, at = Date.now()): Promise<{ readonly ok: true; readonly reset: boolean } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (run.phase !== 'reserved' || run.creation !== 'unknown' || run.sessionId !== undefined) return { ok: true, reset: false }
      if (this.liveSessionClaims.has(runId)) return { ok: true, reset: false }
      if (run.deliveries.some(item => item.status === 'accepted' || item.status === 'unknown' || item.hostRequestId !== undefined)) {
        return { ok: true, reset: false }
      }
      const next: RunRecord = dropClaim({ ...run, creation: 'intent', updatedAt: at })
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, reset: true }
    })
  }

  /** Release a cancelled/settling run whose creation was unknown once the host confirms the session is absent. */
  releaseAbsentUnknown(runId: string, seenUpdatedAt: number, at = Date.now()): Promise<{ readonly ok: true; readonly phase: RunPhase } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (run.updatedAt !== seenUpdatedAt) return { ok: false, code: 'stale', message: `${runId} changed while it was stopping` }
      if (run.phase !== 'settling' || run.closeIntent !== 'stopped') return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      if (this.liveSessionClaims.has(runId) || run.creation !== 'unknown' || run.sessionId !== undefined) {
        return { ok: false, code: 'unknown', message: `${runId} creation is still bound` }
      }
      if (run.deliveries.some(item => item.status === 'accepted' || item.status === 'unknown' || item.hostRequestId !== undefined)) {
        return { ok: false, code: 'unknown', message: `${runId} already attempted delivery` }
      }
      const next: RunRecord = dropClaim({ ...run, phase: 'stopped', closeReason: 'unsent', updatedAt: at })
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, phase: next.phase }
    })
  }

  /**
   * The intent → unknown transition is the only send right for the first prompt.
   * A delivery that is already unknown or accepted does not grant another send.
   */
  claimPrompt(runId: string, text: string, at = Date.now()): Promise<{ readonly ok: true; readonly send: boolean; readonly deliveryId: string; readonly requestId: string; readonly text: string } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (run.phase !== 'reserved' || run.creation !== 'confirmed') return { ok: false, code: 'closed-run', message: `${runId} is not confirmed for its first prompt` }
      const allowed = this.dispatchAllowed(runId)
      if (!allowed.ok) return allowed
      const initial = run.deliveries.find(item => item.kind === 'initial')
      if (!initial) return { ok: false, code: 'missing', message: `${runId} has no initial delivery` }
      const requestId = initial.hostRequestId ?? `req-${runId}-initial`
      if (initial.status === 'accepted') return { ok: false, code: 'closed-run', message: `${runId} was already accepted` }
      if (run.actionClaim === 'prompt') return { ok: true, send: false, deliveryId: initial.id, requestId, text: initial.contentRef }
      const retry = initial.status === 'unknown' || initial.hostRequestId !== undefined
      const next: RunRecord = {
        ...run,
        actionClaim: 'prompt',
        deliveries: run.deliveries.map(item => item.id === initial.id ? {
          ...item,
          status: 'unknown' as const,
          hostRequestId: requestId,
          contentRef: retry ? item.contentRef : text,
          updatedAt: at,
        } : item),
        updatedAt: at,
      }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, send: true, deliveryId: initial.id, requestId, text: retry ? initial.contentRef : text }
    })
  }

  /**
   * One supplement delivery, one send. Creating and claiming happen in this
   * commit, so two callers cannot each insert a new id.
   */
  claimRelay(runId: string, text: string, senderId: string, at = Date.now(), expected?: { readonly inputRef: string; readonly inputRevision: number }): Promise<{ readonly ok: true; readonly send: boolean; readonly delivery: DeliveryRecord } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (run.phase !== 'active') return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      const allowed = this.dispatchAllowed(runId)
      if (!allowed.ok) return allowed
      if (expected && (expected.inputRef !== run.inputRef || expected.inputRevision !== run.inputRevision)) {
        return { ok: false, code: 'stale', message: `${runId} follows ${run.inputRef} revision ${run.inputRevision}; the supplement named ${expected.inputRef} revision ${expected.inputRevision}` }
      }
      const open = [...run.deliveries].reverse().find(item => item.kind !== 'initial' && (item.status === 'intent' || item.status === 'unknown'))
      if (open && (open.contentRef !== text || open.source !== senderId)) {
        return { ok: false, code: 'unknown', message: `${runId} has an unconfirmed delivery; it was not sent again` }
      }
      if (open && open.status !== 'intent') return { ok: true, send: false, delivery: open }
      const gate = this.assignmentGate(run, { targetSessionId: run.sessionId ?? run.requestedSessionId, inputRevision: run.inputRevision })
      if (gate) return gate
      const claimed: DeliveryRecord = open
        ? { ...open, status: 'unknown', updatedAt: at }
        : {
          id: `del-${++this.deliverySeq}`, kind: 'context', targetSessionId: run.sessionId ?? run.requestedSessionId,
          inputRevision: run.inputRevision, contentRef: text, source: senderId, status: 'unknown', createdAt: at, updatedAt: at,
        }
      const next: RunRecord = {
        ...run,
        deliveries: open
          ? run.deliveries.map(item => item.id === open.id ? claimed : item)
          : [...run.deliveries, claimed],
        updatedAt: at,
      }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, send: true, delivery: claimed }
    })
  }

  /** Pin the first prompt to one request id. A later call reuses it and does not open a second delivery. */
  armInitial(runId: string, text: string, at = Date.now()): Promise<{ readonly ok: true; readonly deliveryId: string; readonly requestId: string; readonly text: string } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (run.phase !== 'reserved' || run.creation !== 'confirmed') return { ok: false, code: 'closed-run', message: `${runId} is not confirmed for its first prompt` }
      const gate = this.assignmentGate(run)
      if (gate) return gate
      const initial = run.deliveries.find(item => item.kind === 'initial')
      if (!initial) return { ok: false, code: 'missing', message: `${runId} has no initial delivery` }
      if (initial.status === 'accepted') return { ok: false, code: 'closed-run', message: `${runId} was already accepted` }
      const requestId = initial.hostRequestId ?? `req-${runId}-initial`
      if (initial.hostRequestId === requestId) return { ok: true, deliveryId: initial.id, requestId, text: initial.contentRef }
      const next: RunRecord = {
        ...run,
        deliveries: run.deliveries.map(item => item.id === initial.id ? { ...item, hostRequestId: requestId, contentRef: text, updatedAt: at } : item),
        updatedAt: at,
      }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, deliveryId: initial.id, requestId, text }
    })
  }

  /**
   * Record a host receipt. `accepted` only means the host took the message.
   * The first accepted prompt may enter `active`; it never completes the run.
   */
  settleDelivery(runId: string, deliveryId: string, status: 'accepted' | 'rejected' | 'unknown', evidence?: string, at = Date.now()): Promise<{ readonly ok: true; readonly phase: RunPhase; readonly run: RunRecord } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (TERMINAL.has(run.phase)) return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      const delivery = run.deliveries.find(item => item.id === deliveryId)
      if (!delivery) return { ok: false, code: 'missing', message: `unknown delivery ${deliveryId}` }
      const activate = status === 'accepted' && delivery.kind === 'initial' && run.phase === 'reserved' && run.creation === 'confirmed' && this.dispatchAllowed(runId).ok
      const next: RunRecord = dropClaim({
        ...run,
        ...(activate ? { phase: 'active' as const } : {}),
        deliveries: run.deliveries.map(item => item.id === deliveryId ? { ...item, status, ...(evidence !== undefined ? { evidence } : {}), updatedAt: at } : item),
        updatedAt: at,
      })
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, phase: next.phase, run: next }
    })
  }

  /** Late facts may be noted. They do not change phase, input revision, or a terminal run's occupancy. */
  noteObservation(runId: string, observation: string, at = Date.now()): Promise<{ readonly ok: true; readonly phase: RunPhase } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (TERMINAL.has(run.phase)) return { ok: true, phase: run.phase }
      const next: RunRecord = { ...run, observation, updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, phase: next.phase }
    })
  }

  /**
   * Store a host watermark. A terminal run is left unchanged: a late event may
   * not revive it or move its input.
   */
  noteCursor(runId: string, cursor: RunCursor, at = Date.now()): Promise<{ readonly ok: true; readonly phase: RunPhase } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (TERMINAL.has(run.phase)) return { ok: true, phase: run.phase }
      const next: RunRecord = { ...run, cursor, updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, phase: next.phase }
    })
  }

  /** Persist the cancel gate and move every open run to settling before any host stop. */
  prepareCancel(changeId: string, at = Date.now()): Promise<{ readonly ok: true; readonly revision: number; readonly runs: readonly { readonly id: string; readonly updatedAt: number; readonly sessionId?: string; readonly requestedSessionId: string }[] } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const current = this.changes.get(changeId)
      if (!current) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
      if (current.control !== 'cancelled') {
        const next = { ...current, control: 'cancelled' as const, updatedAt: at }
        await this.commit('changes', next.id, next)
        this.changes.set(next.id, next)
      }
      const open = [...this.runs.values()].filter(run => run.changeId === changeId && !TERMINAL.has(run.phase))
      const saved: { id: string; updatedAt: number; sessionId?: string; requestedSessionId: string }[] = []
      for (const run of open) {
        const next: RunRecord = { ...run, phase: 'settling', ...(run.closeIntent ? {} : { closeIntent: 'stopped' as const }), updatedAt: at }
        await this.commit('runs', next.id, next)
        this.runs.set(next.id, next)
        saved.push({ id: next.id, updatedAt: next.updatedAt, ...(next.sessionId ? { sessionId: next.sessionId } : {}), requestedSessionId: next.requestedSessionId })
      }
      this.currentRevision += 1
      return { ok: true, revision: this.currentRevision, runs: saved }
    })
  }

  /**
   * Release a settling run only when the stop evidence is complete and the run
   * was not updated while the wait happened. Missing evidence stays settling.
   */
  finishSettled(runId: string, seenUpdatedAt: number, phase: 'completed' | 'failed' | 'stopped', evidence: { readonly queueCleared: boolean; readonly agentIdle: boolean; readonly jobsSettled: boolean } | undefined, at = Date.now()): Promise<{ readonly ok: true; readonly phase: RunPhase } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (run.updatedAt !== seenUpdatedAt) return { ok: false, code: 'stale', message: `${runId} changed while it was stopping` }
      if (run.phase !== 'settling') return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      const owner = this.changes.get(run.changeId)
      if (run.kind === 'review' && owner && owner.control !== 'cancelled' && !owner.closeout) {
        return { ok: false, code: 'unknown', message: `${runId} stays reserved until closeout` }
      }
      if (run.closeIntent !== phase) return { ok: false, code: 'unknown', message: `${runId} has no persisted ${phase} close` }
      if (run.creation === 'inflight' || run.creation === 'unknown' || run.creation === 'rejected') return { ok: false, code: 'unknown', message: `${runId} still has an unconfirmed host call` }
      if (!evidence?.queueCleared || !evidence.agentIdle || !evidence.jobsSettled) return { ok: false, code: 'unknown', message: `${runId} is not confirmed stopped` }
      const hasBlockingDelivery = run.deliveries.some(item => {
        if (item.status === 'intent' && item.hostRequestId !== undefined) return true
        if (item.status !== 'unknown') return false
        if (phase !== 'stopped' || item.kind === 'initial' || this.liveRelayClaims.has(item.id)) return true
        return false
      })
      if (hasBlockingDelivery) {
        return { ok: false, code: 'unknown', message: `${runId} still has an in-flight delivery` }
      }
      const deliveries = phase === 'stopped'
        ? run.deliveries.map(item => item.status === 'unknown' && item.kind !== 'initial' && !this.liveRelayClaims.has(item.id)
          ? { ...item, status: 'rejected' as const, evidence: 'superseded-by-verified-stop', updatedAt: at }
          : item)
        : run.deliveries
      const next: RunRecord = { ...run, deliveries, phase, closureEvidence: evidence, closeReason: phase, updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, phase: next.phase }
    })
  }

  /**
   * Release a settling run that never reached the host. A confirmed identity,
   * an unknown create, or any accepted/unknown delivery stays occupied.
   */
  releaseUnsent(runId: string, seenUpdatedAt: number, at = Date.now()): Promise<{ readonly ok: true; readonly phase: RunPhase } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (run.updatedAt !== seenUpdatedAt) return { ok: false, code: 'stale', message: `${runId} changed while it was stopping` }
      if (run.phase !== 'settling') return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      const sent = run.actionClaim !== undefined || run.creation === 'confirmed' || run.creation === 'unknown' || run.creation === 'rejected' || run.creation === 'inflight' || run.deliveries.some(item => item.status === 'accepted' || item.status === 'unknown' || item.hostRequestId !== undefined)
      if (sent) return { ok: false, code: 'unknown', message: `${runId} may already have reached the host` }
      const next: RunRecord = { ...run, phase: 'stopped', closeReason: 'unsent', updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, phase: next.phase }
    })
  }

  /**
   * Recorded once, after the run is terminal: folded session usage and wall
   * time. A no-op on a live run and on a run that already carries usage, so
   * later capture passes never rewrite a committed number. Usage is metadata,
   * not a state transition, so the revision does not move — a baseline
   * published against the revision read before this write still applies.
   */
  recordRunUsage(runId: string, usage: DotContextUsage, wallMs: number): Promise<RunRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (!TERMINAL.has(run.phase)) return { ok: false, code: 'invalid', message: `run ${runId} is still ${run.phase}; usage is recorded once it settles` }
      if (run.usage) return run
      const next: RunRecord = { ...run, usage, wallMs }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      return next
    })
  }

  /** Remember a session the host created after the run was no longer dispatchable. Does not prompt or reopen it. */
  noteHostSession(runId: string, sessionId: string, at = Date.now()): Promise<RunRecord | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      const next: RunRecord = dropClaim({
        ...run,
        sessionId,
        creation: 'rejected',
        updatedAt: at,
      })
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return next
    })
  }

  /**
   * Human-only escape hatch: release wedged runs on an already-cancelled change
   * so a permanently unreachable session or missing host job registry cannot
   * brick the workspace forever. Never called automatically by model tools.
   */
  /** Patch an isolated change's integration state (merge/keep/discard outcomes). */
  updateIsolation(changeId: string, patch: Partial<Omit<TaskIsolation, 'kind' | 'repoRoot' | 'worktree' | 'branch' | 'baseSha'>>, at = Date.now()): Promise<{ readonly ok: true } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const current = this.changes.get(changeId)
      if (!current) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
      if (!current.isolation) return { ok: false, code: 'invalid', message: `${changeId} is not an isolated change` }
      const next: ChangeRecord = { ...current, isolation: { ...current.isolation, ...patch, at }, updatedAt: at }
      await this.commit('changes', next.id, next)
      this.changes.set(next.id, next)
      this.currentRevision += 1
      return { ok: true }
    })
  }

  forceReleaseChange(changeId: string, at = Date.now()): Promise<{ readonly ok: true; readonly released: readonly string[] } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const change = this.changes.get(changeId)
      if (!change) return { ok: false, code: 'missing', message: `unknown change ${changeId}` }
      if (change.control !== 'cancelled') {
        return { ok: false, code: 'invalid', message: `cancel ${changeId} before force-releasing its runs` }
      }
      const open = [...this.runs.values()].filter(run => run.changeId === changeId && !TERMINAL.has(run.phase))
      const released: string[] = []
      for (const run of open) {
        const deliveries = run.deliveries.map(item => item.status === 'unknown' || item.status === 'intent'
          ? { ...item, status: 'rejected' as const, evidence: 'force-released-by-human', updatedAt: at }
          : item)
        const next: RunRecord = dropClaim({
          ...run,
          deliveries,
          phase: 'stopped',
          closeReason: 'force-released',
          updatedAt: at,
        })
        await this.commit('runs', next.id, next)
        this.runs.set(next.id, next)
        this.liveSessionClaims.delete(next.id)
        for (const item of run.deliveries) this.liveRelayClaims.delete(item.id)
        released.push(next.id)
      }
      if (released.length > 0) this.currentRevision += 1
      return { ok: true, released }
    })
  }

  /** All artifact snapshot ids referenced by remaining changes, runs, and verifications. */
  referencedArtifacts(): Set<string> {
    const refs = new Set<string>()
    for (const run of this.runs.values()) {
      for (const base of run.baselineRefs) refs.add(base.artifactRef)
    }
    for (const verification of this.verifications.values()) {
      if (verification.subject?.artifactRef) refs.add(verification.subject.artifactRef)
      for (const base of verification.subject?.baselineRefs ?? []) refs.add(base.artifactRef)
    }
    return refs
  }

  /**
   * Evict oldest terminal (done or cancelled, with zero non-terminal runs) changes
   * past `maxKeep` so durable work tables and snapshots stay bounded over time.
   */
  pruneCompletedChanges(
    maxKeep = MAX_COMPLETED_CHANGES,
    removeDurable?: (table: 'changes' | 'inputs' | 'runs' | 'verifications', key: string) => Promise<void>,
    beforeRemove?: (change: ChangeRecord, failedRounds: number) => Promise<void>,
    at = Date.now(),
  ): Promise<{ readonly prunedChanges: readonly string[]; readonly keptArtifacts: ReadonlySet<string> }> {
    return this.exclusive(async () => {
      if (this.recovery) return { prunedChanges: [], keptArtifacts: this.referencedArtifacts() }
      const terminalChanges = [...this.changes.values()]
        .filter(change => changeIsTerminal(change, [...this.runs.values()].filter(run => run.changeId === change.id)))
        .sort((a, b) => a.updatedAt - b.updatedAt || Number(a.id.slice(2)) - Number(b.id.slice(2)))
      const excess = Math.max(0, terminalChanges.length - Math.max(1, maxKeep))
      if (excess === 0) return { prunedChanges: [], keptArtifacts: this.referencedArtifacts() }
      const victims = terminalChanges.slice(0, excess)
      const prunedChanges: string[] = []
      for (const change of victims) {
        const changeRuns = [...this.runs.values()].filter(run => run.changeId === change.id)
        // A run that still owes usage keeps its change for a later prune: usage
        // capture runs outside this exclusive lane and must commit first, or a
        // change that closed between capture and selection loses its cost. The
        // deferral is bounded — a run whose session can never be read again
        // must not pin its change in history forever.
        if (changeRuns.some(run => runIsTerminal(run) && run.sessionId !== undefined && run.usage === undefined && at - run.updatedAt < USAGE_PRUNE_GRACE_MS)) continue
        if (beforeRemove) {
          try { await beforeRemove(change, this.failedRounds(change.id)) } catch { /* outcome recording is best-effort */ }
        }
        const changeInputs = [...this.inputs.values()].filter(inp => inp.changeId === change.id)
        const changeVers = [...this.verifications.values()].filter(ver => ver.changeId === change.id)
        for (const ver of changeVers) {
          if (removeDurable) await removeDurable('verifications', ver.id)
          this.verifications.delete(ver.id)
        }
        for (const run of changeRuns) {
          if (removeDurable) await removeDurable('runs', run.id)
          this.runs.delete(run.id)
        }
        for (const inp of changeInputs) {
          if (removeDurable) await removeDurable('inputs', inp.id)
          this.inputs.delete(inp.id)
        }
        if (removeDurable) await removeDurable('changes', change.id)
        this.changes.delete(change.id)
        prunedChanges.push(change.id)
      }
      if (prunedChanges.length > 0) this.currentRevision += 1
      return { prunedChanges, keptArtifacts: this.referencedArtifacts() }
    })
  }

  /**
   * Close one run without cancelling its change. The stop itself happens outside
   * the lock; this only persists the settling gate.
   */
  prepareFinish(runId: string, phase: 'completed' | 'failed', at = Date.now()): Promise<{ readonly ok: true; readonly updatedAt: number; readonly sessionId?: string; readonly requestedSessionId: string } | WorkRefusal> {
    return this.exclusive(async () => {
      const refused = this.recoveryRefusal()
      if (refused) return refused
      const run = this.runs.get(runId)
      if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
      if (TERMINAL.has(run.phase)) return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
      if (run.phase === 'settling') {
        if (run.closeIntent) return { ok: true, updatedAt: run.updatedAt, ...(run.sessionId ? { sessionId: run.sessionId } : {}), requestedSessionId: run.requestedSessionId }
        const next: RunRecord = { ...run, closeIntent: phase, updatedAt: at }
        await this.commit('runs', next.id, next)
        this.runs.set(next.id, next)
        this.currentRevision += 1
        return { ok: true, updatedAt: next.updatedAt, ...(next.sessionId ? { sessionId: next.sessionId } : {}), requestedSessionId: next.requestedSessionId }
      }
      const next: RunRecord = { ...run, phase: 'settling', closeIntent: phase, updatedAt: at }
      await this.commit('runs', next.id, next)
      this.runs.set(next.id, next)
      this.currentRevision += 1
      return { ok: true, updatedAt: next.updatedAt, ...(next.sessionId ? { sessionId: next.sessionId } : {}), requestedSessionId: next.requestedSessionId }
    })
  }

  private loadVerifications(values: Iterable<unknown> | null | undefined, problems: string[], quarantined: string[]): void {
    if (values === null) {
      problems.push('unreadable verifications')
      return
    }
    for (const value of values ?? []) {
      const row = parseVerification(value)
      if (row) {
        this.verifications.set(row.id, freezeRecord(row))
        continue
      }
      const explained = explainVerification(value)
      const id = explained?.id ?? 'unknown'
      const reasons = explained?.reasons ?? ['schema']
      this.quarantined.set(id, {
        id,
        ...(explained?.changeId ? { changeId: explained.changeId } : {}),
        runIds: explained?.runIds ?? [],
        reasons,
        record: value,
      })
      const where = [explained?.changeId ? `change ${explained.changeId}` : '', explained?.runIds.length ? `runs ${explained.runIds.join(' ')}` : ''].filter(Boolean).join(', ')
      quarantined.push(`illegal verifications ${id}${where ? ` (${where})` : ''}: ${reasons.join(', ')}`)
    }
  }

  private loadRows<T extends { id: string }>(values: Iterable<unknown> | null | undefined, parse: (value: unknown) => T | undefined, sink: Map<string, T>, label: string, problems: string[]): void {
    if (values === null) {
      problems.push(`unreadable ${label}`)
      return
    }
    for (const value of values ?? []) {
      const row = parse(value)
      if (!row) problems.push(`illegal ${label}`)
      else sink.set(row.id, row)
    }
  }

  private reviewHoldGate(run: RunRecord): WorkRefusal | undefined {
    if (run.kind !== 'review') return { ok: false, code: 'ownership', message: `${run.id} is not a review` }
    if (TERMINAL.has(run.phase)) return { ok: false, code: 'closed-run', message: `${run.id} is ${run.phase}` }
    if (run.creation !== 'confirmed' || !run.sessionId) return { ok: false, code: 'unknown', message: `${run.id} was not confirmed on its own session` }
    const initial = run.deliveries.find(item => item.kind === 'initial')
    if (!initial || initial.status !== 'accepted') return { ok: false, code: 'unknown', message: `${run.id} was not sent` }
    const change = this.changes.get(run.changeId)
    if (!change) return { ok: false, code: 'missing', message: `unknown change ${run.changeId}` }
    if (change.control === 'cancelled') return { ok: false, code: 'cancelled', message: `${change.id} is cancelled` }
    if (change.closeout) return { ok: false, code: 'closed', message: `${change.id} is already closed out` }
    if (run.inputRef !== change.currentInputRef || run.inputRevision !== change.currentRevision) return { ok: false, code: 'stale', message: `${run.id} follows an older input` }
    if (this.inFlight([run])) return { ok: false, code: 'unknown', message: `${run.id} still has an in-flight delivery` }
    return undefined
  }

  private reviewGap(review: RunRecord | undefined, changeId: string, subject: DeliverySubject | undefined, reviewerSessionId: string | undefined, inputRef: string, inputRevision: number, writers: readonly RunRecord[]): { readonly code: 'missing' | 'ownership' | 'stale' | 'unknown'; readonly message: string } | undefined {
    if (!review || review.kind !== 'review' || review.changeId !== changeId) return { code: 'missing', message: 'verification has no review run' }
    if (review.creation !== 'confirmed' || !review.sessionId) return { code: 'unknown', message: `${review.id} was not confirmed on its own session` }
    const initial = review.deliveries.find(item => item.kind === 'initial')
    if (!initial || initial.status !== 'accepted') return { code: 'unknown', message: `${review.id} was not sent` }
    if (!reviewerSessionId || reviewerSessionId !== review.sessionId) return { code: 'ownership', message: 'reviewer session does not match the review run' }
    if (writers.some(run => run.sessionId === reviewerSessionId || run.requestedSessionId === reviewerSessionId)) return { code: 'ownership', message: 'reviewer session is a writer' }
    if (!subject) return { code: 'stale', message: 'verification has no delivery subject' }
    if (canonicalPath(review.workspaceRoot, this.platform) !== canonicalPath(subject.workspaceRoot, this.platform)) return { code: 'ownership', message: 'review workspace does not match the delivery' }
    if (canonicalPath(review.cwd, this.platform) !== canonicalPath(subject.cwd, this.platform)) return { code: 'ownership', message: 'review cwd does not match the delivery' }
    if (review.writeScope.kind !== 'workspace-exclusive') return { code: 'ownership', message: `${review.id} does not hold the workspace` }
    if (review.inputRef !== inputRef || review.inputRevision !== inputRevision) return { code: 'stale', message: 'review is bound to a different input' }
    return undefined
  }

  private inFlight(runs: readonly RunRecord[]): boolean {
    return runs.some(run => run.deliveries.some(item => item.status === 'unknown' || (item.status === 'intent' && item.hostRequestId !== undefined)))
  }

  private assignmentGate(run: RunRecord, delivery?: { readonly targetSessionId: string; readonly inputRevision: number }): WorkRefusal | undefined {
    const change = this.changes.get(run.changeId)
    if (!change) return { ok: false, code: 'missing', message: `unknown change ${run.changeId}` }
    if (change.control === 'paused') return { ok: false, code: 'paused', message: `${change.id} is paused` }
    if (change.control === 'cancelled') return { ok: false, code: 'cancelled', message: `${change.id} is cancelled` }
    if (change.closeout) return { ok: false, code: 'closed', message: `${change.id} is closed out` }
    if (run.inputRef !== change.currentInputRef || run.inputRevision !== change.currentRevision) {
      return { ok: false, code: 'stale', message: `${run.id} follows revision ${run.inputRevision}; current is ${change.currentRevision}` }
    }
    if (!delivery) return undefined
    if (delivery.inputRevision !== change.currentRevision) return { ok: false, code: 'stale', message: `${run.id} rejects a delivery for revision ${delivery.inputRevision}` }
    const owned = delivery.targetSessionId === run.requestedSessionId || run.sessionId !== undefined && delivery.targetSessionId === run.sessionId
    if (!owned) return { ok: false, code: 'ownership', message: `${delivery.targetSessionId} is not a session of ${run.id}` }
    return undefined
  }

  /** A durable outcome we cannot see. Scheduling stays closed until a new book is restored. */
  sealUnknown(error: unknown): void {
    if (this.recovery || !isUnknownState(error)) return
    this.recovery = 'unknown-state; close and reopen before scheduling'
  }

  private async commit(table: Parameters<WorkPersist>[0], key: string, value: unknown): Promise<void> {
    try {
      if (table === 'changes') {
        const { baselineRefs: _projection, ...stored } = value as ChangeRecord
        await this.persist(table, key, stored)
      } else await this.persist(table, key, value)
    } catch (error) {
      this.sealUnknown(error)
      throw error
    }
  }

  private recoveryRefusal(): WorkRefusal | undefined {
    if (!this.recovery) return undefined
    return { ok: false, code: 'recovery', message: `work recovery failed: ${this.recovery}` }
  }

  private assertRecovered(): void {
    if (this.recovery) throw new Error(`work recovery failed: ${this.recovery}`)
  }

  private blockerIds(candidate: Occupant, external: readonly ExternalOccupant[]): string[] {
    const found: string[] = []
    for (const run of this.runs.values()) {
      if (TERMINAL.has(run.phase)) continue
      const occupant: Occupant = {
        id: run.id, cwd: run.cwd, workspaceRoot: run.workspaceRoot, exclusiveRoot: run.exclusiveRoot,
        uncertainBoundary: run.uncertainBoundary || run.writeScope.kind === 'workspace-exclusive' && !run.workspaceRoot,
        writeScope: run.writeScope,
      }
      if (occupantsConflict(candidate, occupant, this.platform)) found.push(run.id)
    }
    for (const row of external) {
      const exclusive = row.writeScope.kind === 'workspace-exclusive'
      const occupant: Occupant = {
        id: row.id,
        cwd: canonicalPath(row.cwd, this.platform),
        workspaceRoot: row.workspaceRoot ? canonicalPath(row.workspaceRoot, this.platform) : '',
        exclusiveRoot: row.exclusiveRoot ? canonicalPath(row.exclusiveRoot, this.platform) : '',
        uncertainBoundary: row.uncertainBoundary === true || exclusive && !row.workspaceRoot,
        writeScope: row.writeScope,
      }
      if (occupantsConflict(candidate, occupant, this.platform)) found.push(row.id)
    }
    return found
  }

  private inputRow(changeId: string, revision: number, goal: string, requirements: readonly Requirement[], steps: readonly StepSpec[], source: string, at: number, fields: { readonly requirementsFromGoal?: boolean; readonly constraints?: readonly Constraint[]; readonly userRequest?: string; readonly deliverableLanguage?: string; readonly supersedes?: string } = {}): InputRecord {
    const id = `input-${++this.inputSeq}`
    return {
      id, changeId, revision, goal,
      requirements: requirements.map(copyRequirement),
      ...(fields.requirementsFromGoal !== undefined ? { requirementsFromGoal: fields.requirementsFromGoal } : {}),
      steps: steps.map(copyStep),
      source, createdAt: at,
      ...(fields.constraints !== undefined ? { constraints: fields.constraints.map(item => ({ constraintRef: item.constraintRef, text: item.text })) } : {}),
      ...(fields.userRequest !== undefined ? { userRequest: fields.userRequest } : {}),
      ...(fields.deliverableLanguage !== undefined ? { deliverableLanguage: fields.deliverableLanguage } : {}),
      ...(fields.supersedes !== undefined ? { supersedes: fields.supersedes } : {}),
    }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

function sameBaseline(left: BaselineRef, right: BaselineRef): boolean {
  return left.workspaceRoot === right.workspaceRoot && left.scopeKey === right.scopeKey && left.artifactRef === right.artifactRef
}

/** Settled for good: every run is terminal and the change was closed out or cancelled. */
export function changeIsTerminal(change: ChangeRecord, runs: readonly RunRecord[]): boolean {
  if (runs.some(run => !TERMINAL.has(run.phase))) return false
  return change.control === 'cancelled' || change.closeout !== undefined
}

/** Why this input must not be stored. Undefined means the refs and the step order are usable. */
export function inputContractError(requirements: readonly Requirement[], steps: readonly StepSpec[], constraints?: readonly Constraint[]): string | undefined {
  const requirementRefs = new Set<string>()
  const scenarioRefs = new Set<string>()
  for (const item of requirements) {
    if (typeof item?.requirementRef !== 'string' || item.requirementRef.length === 0) return 'requirementRef must be a non-empty string'
    if (requirementRefs.has(item.requirementRef)) return `duplicate requirementRef ${item.requirementRef}`
    requirementRefs.add(item.requirementRef)
    for (const scenario of item.scenarios ?? []) {
      if (typeof scenario?.scenarioRef !== 'string' || scenario.scenarioRef.length === 0) return 'scenarioRef must be a non-empty string'
      if (typeof scenario.when !== 'string' || typeof scenario.then !== 'string') return `scenario ${scenario.scenarioRef} must include when and then`
      if (scenario.given !== undefined && typeof scenario.given !== 'string') return `scenario ${scenario.scenarioRef} given must be a string`
      if (scenarioRefs.has(scenario.scenarioRef)) return `duplicate scenarioRef ${scenario.scenarioRef}`
      scenarioRefs.add(scenario.scenarioRef)
    }
  }
  const constraintRefs = new Set<string>()
  for (const item of constraints ?? []) {
    if (typeof item?.constraintRef !== 'string' || item.constraintRef.length === 0) return 'constraintRef must be a non-empty string'
    if (typeof item.text !== 'string') return `constraint ${item.constraintRef} text must be a string`
    if (constraintRefs.has(item.constraintRef)) return `duplicate constraintRef ${item.constraintRef}`
    constraintRefs.add(item.constraintRef)
  }
  const stepRefs = new Set<string>()
  for (const step of steps) {
    if (typeof step?.stepRef !== 'string' || step.stepRef.length === 0) return 'stepRef must be a non-empty string'
    if (typeof step.text !== 'string') return `step ${step.stepRef} text must be a string`
    if (stepRefs.has(step.stepRef)) return `duplicate stepRef ${step.stepRef}`
    stepRefs.add(step.stepRef)
  }
  const covered = new Set([...requirementRefs, ...scenarioRefs])
  for (const step of steps) {
    for (const ref of step.covers ?? []) {
      if (typeof ref !== 'string' || ref.length === 0) return `step ${step.stepRef} covers an empty ref`
      if (!covered.has(ref)) return `step ${step.stepRef} covers ${ref}, which is not a requirement or scenario`
    }
    for (const ref of step.after ?? []) {
      if (typeof ref !== 'string' || ref.length === 0) return `step ${step.stepRef} is after an empty ref`
      if (!stepRefs.has(ref)) return `step ${step.stepRef} is after ${ref}, which is not a step`
    }
  }
  return stepOrderCycle(steps)
}

function stepOrderCycle(steps: readonly StepSpec[]): string | undefined {
  const after = new Map(steps.map(step => [step.stepRef, [...(step.after ?? [])]]))
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (ref: string): string | undefined => {
    const mark = state.get(ref) ?? 0
    if (mark === 1) {
      const start = stack.indexOf(ref)
      return `step order cycles: ${[...stack.slice(start), ref].join(' → ')}`
    }
    if (mark === 2) return undefined
    state.set(ref, 1)
    stack.push(ref)
    for (const next of after.get(ref) ?? []) {
      const found = visit(next)
      if (found) return found
    }
    stack.pop()
    state.set(ref, 2)
    return undefined
  }
  for (const step of steps) {
    const found = visit(step.stepRef)
    if (found) return found
  }
  return undefined
}

function copyRequirement(item: Requirement): Requirement {
  return {
    requirementRef: item.requirementRef,
    text: item.text,
    required: item.required,
    ...(item.scenarios ? { scenarios: item.scenarios.map(copyScenario) } : {}),
  }
}

function copyScenario(item: Scenario): Scenario {
  return {
    scenarioRef: item.scenarioRef,
    when: item.when,
    then: item.then,
    ...(item.given !== undefined ? { given: item.given } : {}),
  }
}

function copyStep(item: StepSpec): StepSpec {
  return {
    stepRef: item.stepRef,
    text: item.text,
    ...(item.covers ? { covers: [...item.covers] } : {}),
    ...(item.after ? { after: [...item.after] } : {}),
  }
}

function clampConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value)) return 1
  return Math.min(8, Math.max(1, value))
}

function dropClaim(run: RunRecord): RunRecord {
  if (run.actionClaim === undefined) return run
  const { actionClaim: _claim, ...rest } = run
  return rest
}

function maxSeq(ids: readonly string[], prefix: string): number {
  return ids.reduce((max, id) => {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(id)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
}

function maxDelivery(runs: Iterable<RunRecord>): number {
  let max = 0
  for (const run of runs) {
    for (const delivery of run.deliveries) {
      const match = /^del-(\d+)$/.exec(delivery.id)
      if (match) max = Math.max(max, Number(match[1]))
    }
  }
  return max
}

/** Domain `unknown-state`: the write may have landed, so the caller must stop guessing. */
export function isUnknownState(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'unknown-state'
}

/** Verification records own their review notes and subject rather than borrowing mutable tool arguments. */
function freezeRecord<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeRecord(child)
    Object.freeze(value)
  }
  return value
}
