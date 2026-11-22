/**
 * Read-only projection and versioned button payloads for one Change.
 * The buttons carry the versions the backend already requires. They do not
 * decide acceptance, release a review, or invent a user answer.
 */
import type { TextKey } from './ui-copy.ts'
export type WorkStatus = 'cancelled' | 'rework' | 'unverified' | 'done' | 'review' | 'settling' | 'running' | 'waiting'

export interface WorkScopeView {
  readonly kind: 'paths' | 'workspace-exclusive'
  readonly paths?: readonly { readonly path: string; readonly type: 'file' | 'directory' }[]
}

export interface WorkDeliveryView {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly contentRef: string
  readonly evidence?: string
}

export interface WorkCheckView {
  readonly requirementRef: string
  readonly verdict: string
  readonly evidenceRefs: readonly string[]
  readonly note?: string
}

export interface WorkChangeView {
  readonly path: string
  readonly kind: string
}

export interface WorkRunView {
  readonly id: string
  readonly kind: string
  readonly phase: string
  readonly cwd: string
  readonly sessionId?: string
  readonly writeScope?: WorkScopeView
  readonly deliveries?: readonly WorkDeliveryView[]
}

export interface WorkVerificationView {
  readonly id: string
  readonly verdict: string
  readonly subjectKey?: string
  readonly inputRef: string
  readonly inputRevision: number
  readonly checks?: readonly WorkCheckView[]
  readonly changes?: readonly WorkChangeView[]
  readonly outOfScopePaths?: readonly string[]
  readonly exclusions?: readonly { readonly path: string; readonly reason: string }[]
}

export interface WorkCloseoutView {
  readonly verificationId: string
  readonly source: string
  readonly inputRef?: string
  readonly subjectKey?: string
  readonly at?: number
}

export interface WorkOversightView {
  readonly requested: boolean
  readonly inputRef: string
  readonly inputRevision: number
  readonly decision?: {
    readonly result: 'accept' | 'reject'
    readonly verificationId?: string
    readonly subjectKey?: string
    readonly source: string
    readonly at: number
  }
}

/** Versions copied from the backend projection. The panel does not fill these in. */
export interface WorkHumanAction {
  readonly action: 'accept'
  readonly expectedInputRef: string
  readonly expectedInputRevision: number
  readonly expectedVerificationId: string
  readonly expectedSubjectKey: string
}

export interface WorkBoardItem {
  readonly id: string
  readonly title: string
  readonly priority: 1 | 2 | 3
  readonly revision: number
  readonly inputRef: string
  readonly control: string
  readonly status: WorkStatus
  readonly summary?: string
  readonly runs: readonly WorkRunView[]
  readonly blockers: readonly string[]
  readonly verification?: WorkVerificationView
  readonly closeout?: WorkCloseoutView
  readonly oversight?: WorkOversightView
  readonly humanAction?: WorkHumanAction
}

export interface WorkReadRequest {
  readonly id: string
  readonly kind: 'evidence' | 'change'
  readonly ref: string
  readonly verificationId: string
  readonly inputRef: string
  readonly inputRevision: number
  readonly forceFull?: boolean
  /** 'diff' asks for a unified diff against the writer baseline (change kind only). */
  readonly view?: 'diff'
}

export interface PendingGlance {
  readonly id: string
  readonly kind: string
  readonly detail?: string
}

export interface WorkAcceptPayload {
  readonly id: string
  readonly verificationId: string
  readonly expectedInputRef: string
  readonly expectedInputRevision: number
  readonly expectedSubjectKey: string
}

export interface WorkRejectPayload {
  readonly id: string
  readonly reviewRunId: string
  readonly expectedInputRevision: number
  readonly note?: string
}

export interface WorkLookRequest {
  readonly id: string
  readonly changeId: string
  readonly inputRevision: number
  readonly verificationId: string
  readonly subjectKey: string
}

const TERMINAL = new Set(['completed', 'failed', 'stopped'])

/** Accept only when the projection already named the versions. */
export function acceptPayload(item: WorkBoardItem): WorkAcceptPayload | undefined {
  const action = item.humanAction
  if (!action || action.action !== 'accept') return undefined
  if (!action.expectedInputRef || !action.expectedVerificationId || !action.expectedSubjectKey) return undefined
  if (!Number.isInteger(action.expectedInputRevision)) return undefined
  if (action.expectedInputRef !== item.inputRef || action.expectedInputRevision !== item.revision) return undefined
  if (action.expectedVerificationId !== item.verification?.id || action.expectedSubjectKey !== item.verification?.subjectKey
    || item.verification?.inputRef !== item.inputRef || item.verification.inputRevision !== item.revision) return undefined
  return {
    id: item.id,
    verificationId: action.expectedVerificationId,
    expectedInputRef: action.expectedInputRef,
    expectedInputRevision: action.expectedInputRevision,
    expectedSubjectKey: action.expectedSubjectKey,
  }
}

/** Reject names the open review and the revision on screen. A finished review is not a target. */
export function rejectPayload(item: WorkBoardItem): WorkRejectPayload | undefined {
  if (item.closeout || item.status === 'done' || item.status === 'cancelled') return undefined
  const review = item.runs.find(run => run.kind === 'review' && !TERMINAL.has(run.phase))
  if (!review || !Number.isInteger(item.revision)) return undefined
  return { id: item.id, reviewRunId: review.id, expectedInputRevision: item.revision }
}

/** Resume only a closeout that is stored while a run is still held. */
export function resumePayload(item: WorkBoardItem): { readonly id: string } | undefined {
  if (!item.closeout || item.blockers.length === 0) return undefined
  return { id: item.id }
}

/** Force-release wedged runs on an already-cancelled change that still holds blockers. */
export function forceReleasePayload(item: WorkBoardItem): { readonly id: string } | undefined {
  if (item.status !== 'cancelled' || item.blockers.length === 0) return undefined
  return { id: item.id }
}

/**
 * The pending card is the only answer path. A card for another version is stale.
 * No card means there is nothing to answer; the panel does not record a decision.
 */
export function lookRequest(item: WorkBoardItem, pending: readonly PendingGlance[]): WorkLookRequest | 'stale' | 'withdrawn' | undefined {
  const asked = item.oversight
  if (!asked?.requested) return undefined
  if (item.verification && (item.verification.inputRef !== item.inputRef || item.verification.inputRevision !== item.revision)) return 'stale'
  const decision = asked.decision
  if (decision && decision.verificationId === item.verification?.id && decision.subjectKey === item.verification?.subjectKey && asked.inputRevision === item.revision) return undefined
  if (asked.inputRef !== item.inputRef || asked.inputRevision !== item.revision) return 'stale'
  const bound = pending.flatMap(row => {
    const look = parseWorkLook(row)
    return look ? [look] : []
  })
  const current = bound.find(row => row.changeId === item.id && row.inputRevision === item.revision && row.verificationId === item.verification?.id && row.subjectKey === item.verification?.subjectKey)
  if (current) return current
  if (bound.some(row => row.changeId === item.id)) return 'stale'
  return 'withdrawn'
}

export type WorkFailureKind = 'stale' | 'withdrawn' | 'conflict' | 'unknown'

/** Classify a refusal. None of these are a successful accept or a recorded user decision. */
export function workFailure(error: { readonly code?: string; readonly message?: string } | string): WorkFailureKind {
  const text = typeof error === 'string' ? error : `${error.code ?? ''} ${error.message ?? ''}`
  if (/unknown-request|no longer pending|withdrawn/i.test(text)) return 'withdrawn'
  if (/stale|older version|does not match|not waiting/i.test(text)) return 'stale'
  if (/conflict|still open|in-flight|not confirmed stopped/i.test(text)) return 'conflict'
  return 'unknown'
}

export function groupWork(items: readonly WorkBoardItem[], pending: readonly PendingGlance[] = []): { readonly needsHuman: readonly WorkBoardItem[]; readonly active: readonly WorkBoardItem[]; readonly done: readonly WorkBoardItem[] } {
  const needsHuman: WorkBoardItem[] = []
  const active: WorkBoardItem[] = []
  const done: WorkBoardItem[] = []
  for (const item of items) {
    const look = lookRequest(item, pending)
    if (item.status === 'done' || item.status === 'cancelled') done.push(item)
    else if (acceptPayload(item) || (typeof look === 'object' && look !== null)) needsHuman.push(item)
    else active.push(item)
  }
  return { needsHuman, active, done }
}

/** A fact tone. Refusal, unknown and unverified are never success. */
export type WorkFactTone = 'quiet' | 'danger' | 'warning' | 'info' | 'neutral'

const RUN_KIND = { work: 'workKindWork', rework: 'workKindRework', review: 'workKindReview' } as const
const RUN_PHASE = { reserved: 'workPhaseReserved', active: 'workPhaseActive', settling: 'workPhaseSettling', completed: 'workPhaseCompleted', failed: 'workPhaseFailed', stopped: 'workPhaseStopped' } as const
const VERDICT = { accept: 'workVerdictAccept', rework: 'workVerdictRework', unverified: 'workVerdictUnverified' } as const
const CHECK = { pass: 'workCheckPass', fail: 'workCheckFail', unverified: 'workCheckUnverified', 'not-applicable': 'workCheckNa' } as const
const DELIVERY = { intent: 'workDeliveryIntent', accepted: 'workDeliveryAccepted', rejected: 'workDeliveryRejected', unknown: 'workDeliveryUnknown' } as const
const DISPATCH = { intent: 'workDispatchPending', rejected: 'workDispatchRejected', unknown: 'workDispatchUnknown' } as const
const CHANGE = { added: 'workChangeAdded', modified: 'workChangeModified', deleted: 'workChangeDeleted' } as const

export function workFactKey(group: 'kind' | 'phase' | 'verdict' | 'check' | 'delivery' | 'dispatch' | 'change', value: string): TextKey | undefined {
  const tables = { kind: RUN_KIND, phase: RUN_PHASE, verdict: VERDICT, check: CHECK, delivery: DELIVERY, dispatch: DISPATCH, change: CHANGE } as const
  const table: Record<string, TextKey> = tables[group]
  return table[value]
}

export function workFactTone(value: string): WorkFactTone {
  if (value === 'unknown' || value === 'unverified' || value === 'intent' || value === 'stale' || value === 'not-applicable') return 'warning'
  if (value === 'rejected' || value === 'fail' || value === 'failed' || value === 'rework') return 'danger'
  if (value === 'accepted' || value === 'pass' || value === 'accept' || value === 'completed' || value === 'active') return 'info'
  return 'neutral'
}

export function scopeText(scope: WorkScopeView | undefined): string | undefined {
  if (!scope) return undefined
  if (scope.kind === 'workspace-exclusive') return undefined
  const paths = scope.paths?.map(item => item.path).filter(Boolean) ?? []
  return paths.length > 0 ? paths.join(', ') : ''
}

export function shortId(value: string | undefined): string {
  if (!value) return ''
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`
}

export function parseWorkLook(row: PendingGlance): WorkLookRequest | undefined {
  if (row.kind !== 'approval' || !row.detail) return undefined
  try {
    const body = JSON.parse(row.detail) as { changeId?: unknown; inputRevision?: unknown; verificationId?: unknown; subjectKey?: unknown }
    if (typeof body.changeId !== 'string' || typeof body.inputRevision !== 'number' || typeof body.verificationId !== 'string' || typeof body.subjectKey !== 'string') return undefined
    return { id: row.id, changeId: body.changeId, inputRevision: body.inputRevision, verificationId: body.verificationId, subjectKey: body.subjectKey }
  } catch {
    return undefined
  }
}
