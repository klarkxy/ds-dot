/**
 * Factory reset of Dorothy's own data. Preview, a one-time token, and the
 * session ids that may be archived. User sessions, project files and the
 * host persona are never in this set.
 */
import { randomBytes } from 'node:crypto'
import type { FactoryResetPreview } from './contracts.ts'

export const FACTORY_RESET_TOKEN_TTL_MS = 5 * 60_000

export type FactoryResetCounts = Omit<FactoryResetPreview, 'token' | 'expiresAt' | 'archiveSessionIds'>

export interface FactoryResetSource {
  list(): readonly { readonly origin: string }[]
  listTickets(): readonly unknown[]
  work: { listChanges(): readonly unknown[]; listRuns(): readonly unknown[] }
  schedules: readonly unknown[]
  settingProposals: readonly unknown[]
  cards: readonly unknown[]
  pastSegments: readonly { readonly sessionId: string }[]
  reflections: readonly { readonly sessionId: string }[]
  agreements: string
  cognition: string
  ownedSessionIds(): readonly string[]
  dotSessionId?: string
}

export function factoryResetCounts(source: FactoryResetSource): FactoryResetCounts {
  return {
    tasks: source.list().length,
    tickets: source.listTickets().length,
    changes: source.work.listChanges().length,
    runs: source.work.listRuns().length,
    schedules: source.schedules.length,
    proposals: source.settingProposals.length,
    cards: source.cards.length,
    ownedSessions: source.ownedSessionIds().length,
    pastSegments: source.pastSegments.length,
    reflections: source.reflections.length,
    hasAgreements: source.agreements.trim().length > 0,
    hasCognition: source.cognition.trim().length > 0,
  }
}

/**
 * Sessions Dorothy herself opened, plus her own current and past segments
 * and reflection runs. A watched human session is not included.
 */
export function factoryResetArchiveIds(source: FactoryResetSource): string[] {
  const ids = new Set<string>()
  if (source.dotSessionId) ids.add(source.dotSessionId)
  for (const row of source.pastSegments) ids.add(row.sessionId)
  for (const row of source.reflections) ids.add(row.sessionId)
  for (const id of source.ownedSessionIds()) ids.add(id)
  return [...ids]
}

export function issueFactoryResetToken(now = Date.now()): { readonly token: string; readonly expiresAt: number } {
  return { token: randomBytes(18).toString('base64url'), expiresAt: now + FACTORY_RESET_TOKEN_TTL_MS }
}

export function factoryResetTokenError(issued: { readonly token: string; readonly expiresAt: number } | undefined, token: string, now = Date.now()): string | undefined {
  if (!issued) return 'reset is not armed; request a preview first'
  if (now > issued.expiresAt) return 'reset token expired; request a new preview'
  if (token !== issued.token) return 'reset token is invalid'
  return undefined
}

/** The same three facts `finishSettled` requires. UNKNOWN is not settled. */
export type FactoryResetStopEvidence = {
  readonly queueCleared: boolean
  readonly idle: boolean
  readonly jobsSettled: boolean | 'unknown'
}

export function factoryResetStopGap(sessionId: string, report: FactoryResetStopEvidence): string | undefined {
  const parts: string[] = []
  if (!report.idle) parts.push('agent not idle')
  if (!report.queueCleared) parts.push('queue not cleared')
  if (report.jobsSettled !== true) parts.push(report.jobsSettled === 'unknown' ? 'owned jobs UNKNOWN' : 'owned jobs not settled')
  return parts.length === 0 ? undefined : `${sessionId}: ${parts.join('; ')}`
}

export function formatFactoryResetPreview(preview: FactoryResetPreview): string {
  const rows = [
    `${preview.tasks} task(s)`,
    `${preview.tickets} ticket(s)`,
    `${preview.changes} change(s)`,
    `${preview.runs} run(s)`,
    `${preview.schedules} reminder(s)`,
    `${preview.proposals} setting proposal(s)`,
    `${preview.cards} card(s)`,
    `${preview.ownedSessions} owned session(s)`,
    `${preview.pastSegments} past segment(s)`,
    `${preview.reflections} reflection run(s)`,
    preview.hasAgreements ? 'agreements will be cleared' : 'no agreements',
    preview.hasCognition ? 'cognition will be cleared' : 'no cognition',
    `${preview.archiveSessionIds.length} session(s) will be archived`,
  ]
  return rows.join('\n')
}
