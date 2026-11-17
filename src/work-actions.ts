/**
 * Pure argument parsers, workspace occupant helpers, and projection adapters
 * for WorkBook (`Change` / `Run` / `Verification`), extracted from `service.ts`.
 */
import type { DeliverySubject } from './acceptance.ts'
import { detectWorkspaceRoot } from './git-root.ts'
import type { WorkIdleItem } from './idle-check.ts'
import type { WorkLedgerItem } from './ledger.ts'
import { DotError } from './service.ts'
import {
  absoluteScopePath,
  canonicalPath,
  workspaceIdentity,
  type Occupant,
  type Requirement,
  type RunRecord,
  type StepSpec,
  type WorkBook,
  type WriteScope,
} from './work.ts'

export const WRITE_PATHS_EXAMPLE = '[{"path":"site/note.txt","type":"file"}]'

export function artifactName(ref: string): string {
  const cleaned = ref.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80)
  return cleaned === '.' || cleaned === '..' ? '' : cleaned
}

export function stepList(value: unknown): StepSpec[] {
  const rows = jsonArray(value)
  if (!rows) throw new DotError('dot/invalid', 'steps must be a JSON array of {stepRef, text}')
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new DotError('dot/invalid', 'steps must be objects')
    const item = row as { stepRef?: unknown; text?: unknown }
    if (typeof item.stepRef !== 'string' || !item.stepRef || typeof item.text !== 'string' || !item.text) {
      throw new DotError('dot/invalid', 'steps must include stepRef and text')
    }
    return { stepRef: item.stepRef, text: item.text }
  })
}

export function requirementList(value: unknown): Requirement[] | undefined {
  const rows = jsonArray(value)
  if (!rows) return undefined
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new DotError('dot/invalid', 'requirements must be objects')
    const item = row as { requirementRef?: unknown; text?: unknown; required?: unknown }
    if (typeof item.requirementRef !== 'string' || !item.requirementRef || typeof item.text !== 'string' || typeof item.required !== 'boolean') {
      throw new DotError('dot/invalid', 'requirements must include requirementRef, text, and required')
    }
    return { requirementRef: item.requirementRef, text: item.text, required: item.required }
  })
}

export function jsonArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export function foldPath(value: string): string {
  return value.replaceAll('\\', '/').toLowerCase()
}

export function assistantText(event: { data?: unknown }): string {
  const data = event.data
  if (!data || typeof data !== 'object') return ''
  const content = (data as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (!block || typeof block !== 'object') return ''
    const row = block as { type?: string; text?: unknown }
    return row.type === 'text' && typeof row.text === 'string' ? row.text : ''
  }).join('')
}

export function occupantOf(run: RunRecord): Occupant {
  return {
    id: run.id,
    cwd: run.cwd,
    workspaceRoot: run.workspaceRoot,
    exclusiveRoot: run.exclusiveRoot,
    uncertainBoundary: run.uncertainBoundary || (run.writeScope.kind === 'workspace-exclusive' && !run.workspaceRoot),
    writeScope: run.writeScope,
  }
}

export function plannedScope(role: 'work' | 'rework' | 'review', access: string | undefined, paths: string | undefined, cwd: string): WriteScope {
  if (role === 'review') return { kind: 'workspace-exclusive' }
  const listed = paths ? pathScope(paths) : undefined
  return { kind: 'paths', paths: listed ?? (access === 'write' ? [{ path: cwd, type: 'directory' as const }] : []) }
}

export function plannedOccupant(cwd: string, scope: WriteScope): Occupant {
  const canonical = canonicalPath(cwd)
  const hint = detectWorkspaceRoot(cwd)
  const identity = workspaceIdentity(canonical, hint)
  return {
    id: 'next',
    cwd: canonical,
    workspaceRoot: identity.workspaceRoot,
    exclusiveRoot: identity.exclusiveRoot,
    uncertainBoundary: identity.uncertainBoundary,
    writeScope: scope,
  }
}

export function samePathList(run: RunRecord, paths: readonly { path: string; type: 'file' | 'directory' }[]): boolean {
  if (run.writeScope.kind !== 'paths') return false
  const root = run.workspaceRoot || run.cwd
  const fold = (item: { path: string; type: string }) => {
    try { return `${item.type}:${canonicalPath(absoluteScopePath(root, item.path))}` } catch { return `${item.type}:${item.path}` }
  }
  const left = run.writeScope.paths.map(fold).sort()
  const right = paths.map(fold).sort()
  return left.length === right.length && left.every((item, index) => item === right[index])
}

export function pathScope(value: unknown): { path: string; type: 'file' | 'directory' }[] | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && !value.trim()) return undefined
  const rows = jsonArray(value)
  if (!rows) throw new DotError('dot/invalid', `paths must be a JSON array of {path, type}. Example: ${WRITE_PATHS_EXAMPLE}. type is "file" or "directory".`)
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new DotError('dot/invalid', `paths must include path and type on every entry. A bare path string is not an entry. Example: ${WRITE_PATHS_EXAMPLE}.`)
    }
    const item = row as { path?: unknown; type?: unknown }
    if (typeof item.path !== 'string' || !item.path || (item.type !== 'file' && item.type !== 'directory')) {
      throw new DotError('dot/invalid', `paths must include path and type on every entry. type is "file" or "directory", not ${JSON.stringify(item.type)}. Example: ${WRITE_PATHS_EXAMPLE}.`)
    }
    return { path: item.path, type: item.type }
  })
}

/** A bare snapshot id, including one wrapped as a JSON string. An object is not an id. */
export function snapshotId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.startsWith('{') || text.startsWith('[')) return undefined
  if (text.startsWith('"')) {
    try {
      const parsed = JSON.parse(text) as unknown
      return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : undefined
    } catch {
      return undefined
    }
  }
  return text
}

export function stringField(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return ''
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : ''
}

export function sameSubject(stored: DeliverySubject, passed: Record<string, unknown>): boolean {
  const rest = { ...passed }
  delete rest.subjectRef
  return stable(stored) === stable(rest)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function verifyRefusal(message: string): string {
  if (message.includes('scopeKey') || message.includes('delivery schema')) return `${message} Pass subject_ref from action=subject. Do not trim the subject or edit checks.`
  if (message.includes('no review run') || message.includes('is not a run of') || message.includes('reviewer session') || message.includes('review workspace') || message.includes('review cwd')) {
    return `${message} Use the review run and session for this change. Do not edit checks.`
  }
  if (message.includes('older input') || message.includes('current input') || message.includes('different input')) {
    return `${message} Call action=subject again for the current input. Do not edit checks.`
  }
  return `${message} Do not edit checks to get past this.`
}

/** Project WorkBook changes for `ledgerSummary` (overview + segment handoffs). */
export function projectWorkLedger(book: WorkBook): WorkLedgerItem[] {
  const allRuns = book.listRuns()
  return book.listChanges().flatMap(change => {
    const view = book.workView(change.id)
    if (!view) return []
    const runs = allRuns.filter(run => run.changeId === change.id)
    const sessionIds = [...new Set(runs.flatMap(run => [run.sessionId, run.requestedSessionId]).filter((id): id is string => typeof id === 'string' && id.length > 0))]
    const oversightPending = Boolean(change.oversight?.requested && change.oversight.inputRef === change.currentInputRef && change.oversight.decision?.result !== 'accept')
    return [{
      id: change.id,
      title: change.title,
      cwd: change.cwd,
      priority: change.priority,
      revision: change.currentRevision,
      control: change.control,
      status: view.status,
      activeRuns: view.blockers.length,
      sessionIds,
      blockers: view.blockers,
      ...(oversightPending ? { needsHumanLook: true } : {}),
      ...(!oversightPending && view.humanAction?.action === 'accept' ? { readyToAccept: true } : {}),
    }]
  })
}

/** Project WorkBook changes for `IdleChecker` routine wake-ups. */
export function projectWorkIdle(book: WorkBook): WorkIdleItem[] {
  const allRuns = book.listRuns()
  return book.listChanges().flatMap(change => {
    const view = book.workView(change.id)
    if (!view) return []
    const runs = allRuns.filter(run => run.changeId === change.id)
    const sessionIds = [...new Set(runs.flatMap(run => [run.sessionId, run.requestedSessionId]).filter((id): id is string => typeof id === 'string' && id.length > 0))]
    const awaitingHumanOversight = Boolean(
      change.oversight?.requested
      && change.oversight.inputRef === change.currentInputRef
      && !change.oversight.decision,
    )
    const readyToAccept = Boolean(
      view.humanAction?.action === 'accept'
      && (!change.oversight?.requested || change.oversight.decision?.result === 'accept'),
    )
    return [{
      id: change.id,
      title: change.title,
      cwd: change.cwd,
      priority: change.priority,
      control: change.control,
      status: view.status,
      sessionIds,
      ...(awaitingHumanOversight ? { awaitingHumanOversight: true } : {}),
      ...(readyToAccept ? { readyToAccept: true } : {}),
    }]
  })
}
