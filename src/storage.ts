/**
 * Durable state: the dot session identity with its current and past segments,
 * the human's settings, the task ledger and dot's reminders. Pending
 * requests stay in memory on purpose — the host keeps pending approvals
 * per process only, so a persisted one could never be answered.
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { ViewNode } from '@klarkxy/dsh-deep-view/contracts'
import { SETTING_FIELDS, type AgreementEntry, type CognitionEntry, type CognitionVersion, type DotContextUsage, type DotUsageOffset, type InboxRecord, type RecipeProposal, type RecipeRecord, type TaskLink, type ReflectionRun, type ScheduleRecord, type SettingProposal, type TaskRecord } from './contracts.ts'
import { maxEntrySuffix, migrateAgreementEntries, migrateCognitionEntries } from './memory.ts'
import { migrateTaskPermissionBaseline, TASK_PERMISSIONS } from './settings.ts'
import type { UpdateStatus } from './auto-update.ts'
import type { SelfBackup, SelfUpgradeMarker } from './self-root.ts'
import type { PastSegment, Segment } from './segments.ts'
import { changeSchema, constraintSchema, inputSchema, requirementSchema, runSchema, storedVerificationSchema } from './work.ts'

export const STATE_KEY = 'current'

type StoredTaskRecord = Omit<TaskRecord, 'createdAt' | 'updatedAt'> & {
  readonly createdAt?: number
  readonly updatedAt?: number
}

// The earliest task rows predate the ledger timestamps; unknown keys of older
// rows are stripped on read.
const storedTaskSchema = z.object({
  sessionId: z.string().min(1),
  origin: z.enum(['started', 'watched']),
  title: z.string(),
  goal: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  preset: z.string().optional(),
  status: z.enum(['running', 'idle', 'blocked', 'error', 'archived']),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  lastNote: z.string().optional(),
  unseenTurns: z.number().int().nonnegative(),
})

const reasonSchema = z.enum(['context-full', 'idle-expired', 'model-switch', 'prompt-changed', 'capabilities-changed', 'lost', 'manual', 'dot-requested'])

const handoffSchema = z.object({
  tier: z.enum(['verbatim', 'summary', 'tail']),
  summary: z.string().optional(),
  rows: z.array(z.object({ role: z.enum(['human', 'notice', 'dot']), text: z.string(), at: z.number() })),
})

const segmentSchema = z.object({
  sessionId: z.string().min(1),
  startedAt: z.number(),
  persona: z.string(),
  model: z.string().optional(),
  /** Agreements block of the system prompt as it read when the segment started; absent while there are none. */
  agreements: z.string().optional(),
  /** Agreements block as this segment's conversation last accounted for it (dot's own change). */
  agreementsSeen: z.string().optional(),
  /** Cognition block as it read when the segment started; absent while dot has written none. */
  cognition: z.string().optional(),
  /** Cognition block as this segment's conversation last accounted for it. */
  cognitionSeen: z.string().optional(),
  opening: z.string().optional(),
  handoff: handoffSchema.optional(),
  reason: reasonSchema.optional(),
  /** Extra-capability grant signature as it read when the segment started; old rows predating the field open without it. */
  capabilities: z.string().optional(),
})

const pastSegmentSchema = z.object({
  sessionId: z.string().min(1),
  startedAt: z.number(),
  endedAt: z.number(),
  reason: reasonSchema.optional(),
})

const timingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.number() }),
  z.object({ kind: z.literal('every'), minutes: z.number().int().positive(), anchor: z.number() }),
  z.object({ kind: z.literal('daily'), time: z.string().regex(/^\d{2}:\d{2}$/), weekdays: z.array(z.number().int().min(1).max(7)).optional() }),
])

const scheduleSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  prompt: z.string(),
  timing: timingSchema,
  createdAt: z.number(),
  nextAt: z.number(),
  lastFiredAt: z.number().optional(),
  deliveredAt: z.number().optional(),
  recipe: z.string().min(1).optional(),
})

const usageSchema = z.object({
  input: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  output: z.number().nonnegative(),
})

const usageOffsetSchema = usageSchema.extend({
  sessionId: z.string().min(1),
})

const agreementEntrySchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const cognitionEntrySchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  seenAt: z.number(),
  pinned: z.literal(true).optional(),
})

const cognitionVersionSchema = z.object({
  at: z.number(),
  entries: z.array(cognitionEntrySchema),
})

/** Pre-entry cognition history rows, still declared so old rows load and migrate. */
const legacyCognitionVersionSchema = z.object({
  text: z.string(),
  at: z.number(),
})

const reflectionRunSchema = z.object({
  sessionId: z.string().min(1),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  ok: z.boolean(),
})

const cardSchema = z.object({
  id: z.string(), number: z.number().int().positive(), sessionId: z.string(), callId: z.string(),
  title: z.string(), view: z.custom<ViewNode>(), expired: z.boolean(), approvalId: z.string().optional(),
  approvalDetail: z.object({ requestId: z.string(), sessionId: z.string(), callerSessionId: z.string().optional(), callId: z.string().optional(), toolName: z.string(), reason: z.string().optional(), arguments: z.string().optional() }).optional(),
  notificationPending: z.boolean().optional(),
  answer: z.object({ id: z.string(), action: z.string(), values: z.record(z.string(), z.unknown()) }).optional(),
  keepAlive: z.literal(true).optional(),
})

const updateStatusSchema = z.object({
  lastCheckAt: z.number().optional(),
  lastResult: z.object({
    kind: z.enum(['updated', 'up-to-date', 'not-updatable', 'unavailable', 'restart-required', 'failed']),
    at: z.number(),
    from: z.string().optional(),
    to: z.string().optional(),
    message: z.string().optional(),
  }).optional(),
  pending: z.object({ from: z.string().min(1), to: z.string().min(1), at: z.number() }).optional(),
})

const stateSchema = z.object({
  cardSequence: z.number().int().nonnegative().optional(),
  cards: z.array(cardSchema).optional(),
  approvalDetails: z.array(z.object({ requestId: z.string(), sessionId: z.string(), callerSessionId: z.string().optional(), callId: z.string().optional(), toolName: z.string(), reason: z.string().optional(), arguments: z.string().optional() })).optional(),
  lastReplyAt: z.number().optional(),
  lastConversationAt: z.number().optional(),
  dotSessionId: z.string().optional(),
  dotWorkspaceId: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  segment: segmentSchema.optional(),
  pastSegments: z.array(pastSegmentSchema).optional(),
  /** The human's own standing requirements, one entry per rule. */
  agreementEntries: z.array(agreementEntrySchema).optional(),
  /** What one undo of the agreements restores. */
  agreementEntriesUndo: z.array(agreementEntrySchema).optional(),
  /** dot's own understanding, one entry per point. */
  cognitionEntries: z.array(cognitionEntrySchema).optional(),
  /** Earlier cognition entry lists, newest first. */
  cognitionEntryHistory: z.array(cognitionVersionSchema).optional(),
  /** Monotonic id counters per prefix so a removed entry's id is never handed out again. */
  knowledgeIdSeq: z.object({ a: z.number().int().nonnegative(), c: z.number().int().nonnegative() }).optional(),
  /** Legacy pre-entry shapes, still declared so old rows load and migrate, then dropped. */
  agreements: z.string().optional(),
  agreementsUndo: z.string().optional(),
  cognition: z.string().optional(),
  cognitionHistory: z.array(legacyCognitionVersionSchema).optional(),
  /** When dot's last successful background reflection finished. */
  lastReflectedAt: z.number().optional(),
  /** When the last background reflection attempt started; drives the failure cooldown. */
  lastReflectionAttemptAt: z.number().optional(),
  /** Whether the last background reflection attempt failed or produced no result. */
  reflectionAttemptFailed: z.boolean().optional(),
  /** A one-time note the reflection pass left about the agreements, delivered with the next human message. */
  agreementNotes: z.string().optional(),
  /** Reflection passes that ran, oldest first; the trajectory page reads them by session id. */
  reflections: z.array(reflectionRunSchema).optional(),
  usageCarry: usageSchema.optional(),
  usageOffset: usageOffsetSchema.optional(),
  /** When the human last restored factory settings. Survives the wipe as the audit. */
  lastFactoryResetAt: z.number().optional(),
  update: updateStatusSchema.optional(),
  /** A linked-checkout self-upgrade that built successfully; resolved on the next start. */
  selfUpgrade: z.object({ at: z.number(), commitSha: z.string(), backupDir: z.string(), libHash: z.string() }).optional(),
  /** The newest kept pre-upgrade lib backup; shown by self.status until superseded. */
  selfBackup: z.object({ dir: z.string(), lib: z.string() }).optional(),
})

const proposalValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.record(z.string(), z.unknown()), z.array(z.unknown())])

/**
 * A stored proposal may name any field; rows naming a retired or unknown field
 * are dropped on load instead of reaching the human.
 */
const proposalSchema = z.object({
  id: z.string().min(1),
  field: z.string().min(1),
  before: proposalValueSchema,
  after: proposalValueSchema,
  reason: z.string().min(1).max(2000),
  createdAt: z.number(),
})

export interface DotState {
  readonly cardSequence?: number
  readonly cards?: readonly import('./card-state.ts').DotCardRecord[]
  readonly approvalDetails?: readonly import('./contracts.ts').ApprovalDetail[]
  readonly lastReplyAt?: number
  readonly lastConversationAt?: number
  readonly dotSessionId?: string
  readonly dotWorkspaceId?: string
  /** The human's settings; read through parseSettings. */
  readonly settings?: Readonly<Record<string, unknown>>
  /** The segment dotSessionId is running; absent for a session started before segments existed. */
  readonly segment?: Segment
  /** Ended segments, oldest first. */
  readonly pastSegments?: readonly PastSegment[]
  /** The human's own standing requirements, one entry per rule. */
  readonly agreementEntries?: readonly AgreementEntry[]
  /** What one undo of the agreements restores. */
  readonly agreementEntriesUndo?: readonly AgreementEntry[]
  /** dot's own understanding, one entry per point. */
  readonly cognitionEntries?: readonly CognitionEntry[]
  /** Earlier cognition entry lists, newest first. */
  readonly cognitionEntryHistory?: readonly CognitionVersion[]
  /** Monotonic id counters per prefix; a removed entry's id is never handed out again. */
  readonly knowledgeIdSeq?: { readonly a: number; readonly c: number }
  /** When dot's last successful background reflection finished. */
  readonly lastReflectedAt?: number
  /** When the last background reflection attempt started; drives the failure cooldown. */
  readonly lastReflectionAttemptAt?: number
  /** Whether the last background reflection attempt failed or produced no result. */
  readonly reflectionAttemptFailed?: boolean
  /** A one-time note the reflection pass left about the agreements, delivered with the next human message. */
  readonly agreementNotes?: string
  /** Reflection passes that ran, oldest first; the trajectory page reads them by session id. */
  readonly reflections?: readonly ReflectionRun[]
  /** Cumulative token totals carried from ended segments and handoff notes. */
  readonly usageCarry?: DotContextUsage
  /** Segment usage subtracted after the human clears cumulative totals mid-segment. */
  readonly usageOffset?: DotUsageOffset
  /** When the human last restored factory settings. */
  readonly lastFactoryResetAt?: number
  /** Self-update bookkeeping: last check, its outcome, an apply still in flight. */
  readonly update?: UpdateStatus
  /** A linked-checkout self-upgrade that built successfully; resolved on the next start. */
  readonly selfUpgrade?: SelfUpgradeMarker
  /** The newest kept pre-upgrade lib backup. */
  readonly selfBackup?: SelfBackup
}

export function parseSettingProposal(value: unknown): SettingProposal | undefined {
  const parsed = proposalSchema.safeParse(value)
  if (!parsed.success || !(SETTING_FIELDS as readonly string[]).includes(parsed.data.field)) return undefined
  const proposal = parsed.data as SettingProposal
  if (proposal.field !== 'taskPermission') return proposal
  // A proposal whose target is the retired "follow host" value is stale; do
  // not rewrite it into a different permission. A still-supported target keeps
  // its after and migrates only the comparison baseline.
  if (proposal.after === 'default') return undefined
  if (typeof proposal.after === 'string' && !TASK_PERMISSIONS.has(proposal.after)) return undefined
  const before = migrateTaskPermissionBaseline(proposal.before)
  return before === proposal.before ? proposal : { ...proposal, before }
}

export const peerDeliverySchema = z.object({
  id: z.string().min(1),
  senderSessionId: z.string().min(1),
  targetSessionId: z.string().min(1),
  text: z.string(),
  status: z.enum(['intent', 'accepted', 'unknown']),
  updatedAt: z.number(),
})

export type PeerDelivery = z.infer<typeof peerDeliverySchema>

export function parsePeerDelivery(value: unknown): PeerDelivery | undefined {
  const parsed = peerDeliverySchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

const inboxRecordSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceId: z.string().min(1),
  deliveryId: z.string().min(1),
  deliveryIds: z.array(z.string().min(1)),
  type: z.string().min(1),
  subject: z.string(),
  title: z.string(),
  actor: z.string().optional(),
  url: z.string().optional(),
  summary: z.string(),
  count: z.number().int().positive(),
  status: z.enum(['pending', 'delivered']),
  receivedAt: z.number(),
  headRef: z.string().optional(),
  headRepo: z.string().optional(),
  originSource: z.enum(['github-poll', 'inbox-github']).optional(),
  updatedAt: z.number(),
  deliveredAt: z.number().optional(),
})

export function parseInboxRecord(value: unknown): InboxRecord | undefined {
  const parsed = inboxRecordSchema.safeParse(value)
  return parsed.success ? parsed.data as InboxRecord : undefined
}

export const githubPollStreamCursorSchema = z.object({
  kind: z.literal('stream'),
  repo: z.string().min(1),
  stream: z.enum(['issues', 'comments', 'review-comments']),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  since: z.string().min(1),
  startedIssues: z.string().optional(),
  startedPulls: z.string().optional(),
  startedComments: z.string().optional(),
  seenKeys: z.array(z.string()).optional(),
  updatedAt: z.number(),
})

export const githubPollCiBaselineSchema = z.object({
  kind: z.literal('ci'),
  repo: z.string().min(1),
  branch: z.string().min(1),
  failures: z.array(z.string()),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number(),
})

export const githubPollPrCiBaselineSchema = z.object({
  kind: z.literal('pr-ci'),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  headSha: z.string().min(1),
  failures: z.array(z.string()),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number(),
})

export const githubPollEchoLedgerSchema = z.object({
  kind: z.literal('echo'),
  repo: z.string().min(1),
  entries: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(['issue_comment', 'review_comment', 'review']),
    sentAt: z.number(),
  })),
  updatedAt: z.number(),
})

export const githubPollRepoStateSchema = z.object({
  kind: z.literal('repo'),
  repo: z.string().min(1),
  consecutiveFailures: z.number().int().nonnegative(),
  lastPollAt: z.number().optional(),
  lastSuccessAt: z.number().optional(),
  lastDeliveredAt: z.number().optional(),
  lastMode: z.enum(['poll', 'webhook']).optional(),
  lastError: z.string().optional(),
  xPollIntervalSec: z.number().int().positive().optional(),
  rateLimitRemaining: z.number().int().nonnegative().optional(),
  rateLimitLimit: z.number().int().positive().optional(),
  rateLimitResetAt: z.number().optional(),
  deleted410Subjects: z.array(z.string()).optional(),
  retryDeadlines: z.record(z.string(), z.number()).optional(),
})

export const githubPollPrReviewCursorSchema = z.object({
  kind: z.literal('pr-review'),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  startedComments: z.string().min(1),
  seenIds: z.array(z.string()).optional(),
  updatedAt: z.number(),
})

export const githubPollDeliveredSchema = z.object({
  kind: z.literal('delivered'),
  repo: z.string().min(1),
  entries: z.array(z.object({
    id: z.string().min(1),
    deliveredAt: z.number(),
  })),
  updatedAt: z.number(),
})

export const githubPollEntrySchema = z.discriminatedUnion('kind', [
  githubPollStreamCursorSchema,
  githubPollCiBaselineSchema,
  githubPollPrCiBaselineSchema,
  githubPollPrReviewCursorSchema,
  githubPollEchoLedgerSchema,
  githubPollDeliveredSchema,
  githubPollRepoStateSchema,
])

export type GithubPollEntry = z.infer<typeof githubPollEntrySchema>

export function parseGithubPollEntry(value: unknown): GithubPollEntry | undefined {
  const parsed = githubPollEntrySchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

const recipeBodyFields = {
  goal: z.string(),
  requirements: z.array(requirementSchema),
  requirementsFromGoal: z.boolean().optional(),
  constraints: z.array(constraintSchema).optional(),
  notes: z.string().optional(),
  deliverableLanguage: z.string().optional(),
  dir: z.string().optional(),
  preset: z.string().optional(),
  model: z.string().optional(),
  access: z.enum(['read', 'write']).optional(),
  humanReview: z.boolean().optional(),
  isolation: z.literal('worktree').optional(),
}

const linkEventSchema = z.object({
  type: z.string(),
  title: z.string(),
  summary: z.string(),
  url: z.string().optional(),
  at: z.number(),
  count: z.number().int().positive(),
})

const taskLinkSchema = z.object({
  id: z.string().min(1),
  changeId: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive().optional(),
  branch: z.string().optional(),
  headRepo: z.string().optional(),
  url: z.string().optional(),
  origin: z.enum(['dot', 'auto']),
  state: z.enum(['open', 'closed', 'merged']),
  addedAt: z.number(),
  lastEvent: linkEventSchema.optional(),
})

/** A malformed link reads as absent. */
export function parseTaskLink(value: unknown): TaskLink | undefined {
  const parsed = taskLinkSchema.safeParse(value)
  return parsed.success ? parsed.data as TaskLink : undefined
}

const recipeSchema = z.object({
  ...recipeBodyFields,
  id: z.string().min(1),
  name: z.string().min(1),
  revision: z.number().int().positive(),
  reason: z.string().optional(),
  history: z.array(z.object({ ...recipeBodyFields, revision: z.number().int().positive(), name: z.string(), reason: z.string().optional(), at: z.number() })),
  outcomes: z.array(z.object({
    changeId: z.string().min(1), title: z.string(), revision: z.number().int(),
    result: z.enum(['accepted', 'cancelled']), failedRounds: z.number().int().nonnegative(),
    tokens: z.number().optional(), wallMs: z.number().optional(), at: z.number(),
  })),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** A malformed recipe reads as absent. */
export function parseRecipeRecord(value: unknown): RecipeRecord | undefined {
  const parsed = recipeSchema.safeParse(value)
  return parsed.success ? parsed.data as RecipeRecord : undefined
}

const recipeProposalSchema = z.object({
  id: z.string().min(1),
  recipeId: z.string().min(1),
  baseRevision: z.number().int().positive(),
  kind: z.enum(['restore', 'revise']),
  targetRevision: z.number().int().positive().optional(),
  patch: z.object({
    goal: z.string().optional(),
    requirements: z.array(requirementSchema).optional(),
    constraints: z.array(constraintSchema).optional(),
    notes: z.string().optional(),
  }).optional(),
  reason: z.string(),
  origin: z.enum(['detector', 'reflection']),
  regression: z.enum(['acceptance', 'rework', 'cost']).optional(),
  status: z.enum(['pending', 'approved', 'dismissed', 'stale']),
  createdAt: z.number(),
  decidedAt: z.number().optional(),
})

/** A malformed proposal reads as absent. */
export function parseRecipeProposal(value: unknown): RecipeProposal | undefined {
  const parsed = recipeProposalSchema.safeParse(value)
  return parsed.success ? parsed.data as RecipeProposal : undefined
}

export const dotDomain = defineDomain({
  name: 'klarkxy_dsh_dot',
  // v9 adds task links; v10 adds recipe proposals; v11 adds github_poll KV store.
  // Older rows still open: read schemas strip keys they no longer declare and dropped tables are never read.
  version: 11,
  compatibleVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  tables: {
    // Stored rows may still carry the pre-entry knowledge shape; parseState migrates them.
    state: domainTable<string, StoredState>(stateSchema as z.ZodType<StoredState>),
    tasks: domainTable<string, StoredTaskRecord>(storedTaskSchema),
    schedules: domainTable<string, ScheduleRecord>(scheduleSchema),
    proposals: domainTable<string, unknown>(proposalSchema),
    changes: domainTable(changeSchema),
    inputs: domainTable(inputSchema),
    runs: domainTable(runSchema),
    verifications: domainTable(storedVerificationSchema),
    peers: domainTable<string, PeerDelivery>(peerDeliverySchema),
    inbox: domainTable<string, InboxRecord>(inboxRecordSchema),
    recipes: domainTable<string, RecipeRecord>(recipeSchema),
    links: domainTable<string, TaskLink>(taskLinkSchema),
    recipe_proposals: domainTable<string, RecipeProposal>(recipeProposalSchema),
    github_poll: domainTable<string, GithubPollEntry>(githubPollEntrySchema),
  },
})

/** A malformed reminder reads as absent. */
export function parseScheduleRecord(value: unknown): ScheduleRecord | undefined {
  const parsed = scheduleSchema.safeParse(value)
  return parsed.success ? parsed.data as ScheduleRecord : undefined
}

/** A malformed row reads as absent instead of breaking the ledger; timestamps of the oldest rows default to 0. */
export function parseTask(value: unknown): TaskRecord | undefined {
  const parsed = storedTaskSchema.safeParse(value)
  if (!parsed.success) return undefined
  const task = parsed.data
  return {
    ...task,
    createdAt: task.createdAt ?? task.updatedAt ?? 0,
    updatedAt: task.updatedAt ?? task.createdAt ?? 0,
  } as TaskRecord
}

/** The state row as stored: legacy pre-entry knowledge shapes may still be present. */
interface StoredState extends DotState {
  readonly agreements?: string
  readonly agreementsUndo?: string
  readonly cognition?: string
  readonly cognitionHistory?: readonly { readonly text: string; readonly at: number }[]
}

/**
 * Convert the pre-entry knowledge fields into entry lists and make sure the
 * id counters exist. Entries get fresh ids in line order from the monotonic
 * per-prefix counter (seeded above every id the row already carries) and share
 * `now` as their timestamps; equal seenAt values fall back to stored order
 * when ranked. The legacy keys are dropped so the next write persists only
 * the new shape — older plugin versions keep their own keys untouched.
 */
export function migrateKnowledge(stored: StoredState, now: number): { readonly state: DotState; readonly migrated: boolean } {
  const hasLegacy = typeof stored.agreements === 'string' || typeof stored.agreementsUndo === 'string' || typeof stored.cognition === 'string' || (stored.cognitionHistory ?? []).length > 0
  if (!hasLegacy && stored.knowledgeIdSeq !== undefined) return { state: stored as DotState, migrated: false }
  let aSeq = stored.knowledgeIdSeq?.a ?? maxEntrySuffix('a', [stored.agreementEntries ?? [], stored.agreementEntriesUndo ?? []])
  let cSeq = stored.knowledgeIdSeq?.c ?? maxEntrySuffix('c', [stored.cognitionEntries ?? [], ...(stored.cognitionEntryHistory ?? []).map(version => version.entries)])
  const nextA = () => `a${++aSeq}`
  const nextC = () => `c${++cSeq}`
  const agreementEntries = stored.agreementEntries ?? migrateAgreementEntries(stored.agreements ?? '', now, nextA)
  const agreementEntriesUndo = typeof stored.agreementsUndo === 'string' ? migrateAgreementEntries(stored.agreementsUndo, now, nextA) : stored.agreementEntriesUndo
  const cognitionEntries = stored.cognitionEntries ?? migrateCognitionEntries(stored.cognition ?? '', now, nextC)
  const cognitionEntryHistory: CognitionVersion[] = [
    ...(stored.cognitionEntryHistory ?? []),
    ...(stored.cognitionHistory ?? []).map(version => ({ at: version.at, entries: migrateCognitionEntries(version.text, now, nextC) })),
  ].sort((a, b) => b.at - a.at)
  const { agreements: _agreements, agreementsUndo: _undo, cognition: _cognition, cognitionHistory: _history, ...rest } = stored
  return { state: { ...rest, agreementEntries, agreementEntriesUndo, cognitionEntries, cognitionEntryHistory, knowledgeIdSeq: { a: aSeq, c: cSeq } }, migrated: true }
}

/** The state row parsed and, when it still carried pre-entry knowledge, migrated to entries. */
export function parseState(value: unknown, now = Date.now()): { readonly state: DotState; readonly migrated: boolean } {
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success) return { state: {}, migrated: false }
  return migrateKnowledge(parsed.data as StoredState, now)
}
