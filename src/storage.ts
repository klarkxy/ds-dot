/**
 * Durable state: the dot session identity with its current and past segments,
 * the human's settings, the task ledger and dot's reminders. Pending
 * requests stay in memory on purpose — the host keeps pending approvals
 * per process only, so a persisted one could never be answered.
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { ViewNode } from '@klarkxy/dsh-deep-view/contracts'
import { SETTING_FIELDS, type CognitionVersion, type DotContextUsage, type DotUsageOffset, type InboxRecord, type RecipeRecord, type ReflectionRun, type ScheduleRecord, type SettingProposal, type TaskRecord } from './contracts.ts'
import type { UpdateStatus } from './auto-update.ts'
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

const cognitionVersionSchema = z.object({
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
  /** The human's own standing requirements, verbatim. */
  agreements: z.string().optional(),
  /** What one undo of the agreements restores. */
  agreementsUndo: z.string().optional(),
  /** dot's own understanding, rewritten whole. */
  cognition: z.string().optional(),
  /** Earlier cognition texts, newest first; used for rollback. */
  cognitionHistory: z.array(cognitionVersionSchema).optional(),
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
  /** The human's own standing requirements, verbatim. */
  readonly agreements?: string
  /** What one undo of the agreements restores. */
  readonly agreementsUndo?: string
  /** dot's own understanding, rewritten whole. */
  readonly cognition?: string
  /** Earlier cognition texts, newest first. */
  readonly cognitionHistory?: readonly CognitionVersion[]
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
}

export function parseSettingProposal(value: unknown): SettingProposal | undefined {
  const parsed = proposalSchema.safeParse(value)
  if (!parsed.success || !(SETTING_FIELDS as readonly string[]).includes(parsed.data.field)) return undefined
  return parsed.data as SettingProposal
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
  updatedAt: z.number(),
  deliveredAt: z.number().optional(),
})

export function parseInboxRecord(value: unknown): InboxRecord | undefined {
  const parsed = inboxRecordSchema.safeParse(value)
  return parsed.success ? parsed.data as InboxRecord : undefined
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

export const dotDomain = defineDomain({
  name: 'klarkxy_dsh_dot',
  // v8 adds recipe rows; v1–v7 rows still open: read schemas strip keys they no
  // longer declare and the removed `tickets` table is simply never read.
  version: 8,
  compatibleVersions: [1, 2, 3, 4, 5, 6, 7],
  tables: {
    state: domainTable<string, DotState>(stateSchema),
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

export function parseState(value: unknown): DotState {
  const parsed = stateSchema.safeParse(value)
  return parsed.success ? parsed.data as DotState : {}
}
