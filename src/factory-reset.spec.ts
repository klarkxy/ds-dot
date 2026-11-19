import { describe, expect, it } from 'vitest'
import {
  FACTORY_RESET_TOKEN_TTL_MS,
  factoryResetArchiveIds,
  factoryResetCounts,
  factoryResetStopGap,
  factoryResetTokenError,
  formatFactoryResetPreview,
  issueFactoryResetToken,
  type FactoryResetSource,
} from './factory-reset.ts'
import type { FactoryResetPreview } from './contracts.ts'

function source(partial: Partial<FactoryResetSource> = {}): FactoryResetSource {
  return {
    list: () => [{ origin: 'started' }, { origin: 'watched' }],
    work: { listChanges: () => [{}, {}], listRuns: () => [{}] },
    schedules: [{}],
    settingProposals: [],
    cards: [{}, {}],
    pastSegments: [{ sessionId: 'past-1' }],
    reflections: [{ sessionId: 'ref-1' }],
    agreements: 'do not push',
    cognition: ' prefers short answers ',
    ownedSessionIds: () => ['owned-1', 'owned-2'],
    dotSessionId: 'dot-now',
    ...partial,
  }
}

describe('factory reset preview', () => {
  it('counts Dorothy\'s own records and never treats a watched session as owned', () => {
    const counts = factoryResetCounts(source())
    expect(counts).toEqual({
      tasks: 2, changes: 2, runs: 1, schedules: 1, proposals: 0, cards: 2,
      ownedSessions: 2, pastSegments: 1, reflections: 1, hasAgreements: true, hasCognition: true,
    })
    expect(factoryResetArchiveIds(source()).sort()).toEqual(['dot-now', 'owned-1', 'owned-2', 'past-1', 'ref-1'])
    expect(factoryResetArchiveIds(source())).not.toContain('watched-user')
  })

  it('issues a one-time token and refuses a missing, wrong, or expired one', () => {
    const issued = issueFactoryResetToken(1000)
    expect(issued.token.length).toBeGreaterThan(16)
    expect(issued.expiresAt).toBe(1000 + FACTORY_RESET_TOKEN_TTL_MS)
    expect(factoryResetTokenError(undefined, issued.token, 1000)).toMatch(/preview first/)
    expect(factoryResetTokenError(issued, 'nope', 1000)).toMatch(/invalid/)
    expect(factoryResetTokenError(issued, issued.token, issued.expiresAt + 1)).toMatch(/expired/)
    expect(factoryResetTokenError(issued, issued.token, 1000)).toBeUndefined()
  })

  it('formats a preview the panel can show', () => {
    const preview: FactoryResetPreview = {
      ...factoryResetCounts(source()),
      token: 't',
      expiresAt: 1,
      archiveSessionIds: factoryResetArchiveIds(source()),
    }
    const text = formatFactoryResetPreview(preview)
    expect(text).toContain('2 tracked session(s)')
    expect(text).toContain('agreements will be cleared')
    expect(text).toContain('5 session(s) will be archived')
  })

  it('treats an idle agent with unsettled or UNKNOWN jobs as not stopped', () => {
    expect(factoryResetStopGap('run-1', { queueCleared: true, idle: true, jobsSettled: true })).toBeUndefined()
    expect(factoryResetStopGap('run-1', { queueCleared: true, idle: true, jobsSettled: 'unknown' })).toBe('run-1: owned jobs UNKNOWN')
    expect(factoryResetStopGap('run-1', { queueCleared: true, idle: true, jobsSettled: false })).toBe('run-1: owned jobs not settled')
    expect(factoryResetStopGap('run-1', { queueCleared: false, idle: true, jobsSettled: true })).toBe('run-1: queue not cleared')
    expect(factoryResetStopGap('run-1', { queueCleared: true, idle: false, jobsSettled: true })).toBe('run-1: agent not idle')
  })
})
