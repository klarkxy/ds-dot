/**
 * Link ref parsing, report URL scanning, subject matching, and folding an
 * inbox record into a link's branch/state/lastEvent.
 */
import { describe, expect, it } from 'vitest'
import type { InboxRecord } from './contracts.ts'
import { applyLinkEvent, bindThread, inferLinkTargetKind, linkMatchesSubject, makeTaskLink, parseLinkRef, polledTargets, scanReportLinks, subjectTarget, taskLinkId, threadClosed } from './links.ts'
import { parseTaskLink } from './storage.ts'

describe('parseLinkRef', () => {
  it('accepts pull and issue URLs, owner/repo#N, and owner/repo@branch', () => {
    expect(parseLinkRef('https://github.com/Acme/Widgets/pull/12')).toMatchObject({ repo: 'acme/widgets', number: 12 })
    expect(parseLinkRef('https://github.com/acme/widgets/issues/34')).toMatchObject({ repo: 'acme/widgets', number: 34 })
    expect(parseLinkRef('https://github.com/acme/widgets/pull/12/files')).toMatchObject({ repo: 'acme/widgets', number: 12 })
    expect(parseLinkRef('acme/widgets#12')).toMatchObject({ repo: 'acme/widgets', number: 12 })
    expect(parseLinkRef('acme/widgets@feature/52-links')).toMatchObject({ repo: 'acme/widgets', branch: 'feature/52-links' })
  })

  it('refuses anything that is not a GitHub target', () => {
    expect(parseLinkRef('not a ref')).toBeUndefined()
    expect(parseLinkRef('acme')).toBeUndefined()
    expect(parseLinkRef('acme/widgets')).toBeUndefined()
    expect(parseLinkRef('https://gitlab.com/acme/widgets/pull/1')).toBeUndefined()
    expect(parseLinkRef('acme/widgets#abc')).toBeUndefined()
    expect(parseLinkRef('')).toBeUndefined()
  })
})

describe('scanReportLinks', () => {
  it('finds deduped pull/issue URLs and caps at five', () => {
    const report = 'opened https://github.com/acme/widgets/pull/12 and https://github.com/acme/widgets/pull/12 again; see https://github.com/acme/widgets/issues/7'
    expect(scanReportLinks(report)).toEqual([
      { repo: 'acme/widgets', number: 12, url: 'https://github.com/acme/widgets/pull/12' },
      { repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/issues/7' },
    ])
    const many = [1, 2, 3, 4, 5, 6, 7].map(n => `https://github.com/acme/widgets/pull/${n}`).join(' ')
    expect(scanReportLinks(many)).toHaveLength(5)
  })
})

describe('linkMatchesSubject', () => {
  const subject = (value: string, headRepo?: string) => ({ subject: value, ...(headRepo ? { headRepo } : {}) })

  it('matches repo#N subjects on the link number and workflow/checks subjects on the branch', () => {
    const pr = { repo: 'acme/widgets', number: 12 }
    expect(linkMatchesSubject(pr, subject('acme/widgets#12'))).toBe(true)
    expect(linkMatchesSubject(pr, subject('acme/widgets#13'))).toBe(false)
    expect(linkMatchesSubject(pr, subject('other/widgets#12'))).toBe(false)
    const branch = { repo: 'acme/widgets', branch: 'feature/x' }
    expect(linkMatchesSubject(branch, subject('acme/widgets:workflow:ci@feature/x'))).toBe(true)
    expect(linkMatchesSubject(branch, subject('acme/widgets:checks:app@feature/x'))).toBe(true)
    expect(linkMatchesSubject(branch, subject('acme/widgets:workflow:ci@main'))).toBe(false)
    // Push subjects are repo@refs/heads/... and never bind.
    expect(linkMatchesSubject(branch, subject('acme/widgets@refs/heads/feature/x'))).toBe(false)
    const both = { repo: 'acme/widgets', number: 12, branch: 'feature/x' }
    expect(linkMatchesSubject(both, subject('acme/widgets#12'))).toBe(true)
    expect(linkMatchesSubject(both, subject('acme/widgets:workflow:ci@feature/x'))).toBe(true)
  })

  it('splits the branch off at the last @ so workflow names keep spaces', () => {
    const branch = { repo: 'acme/widgets', branch: 'feature/x' }
    expect(linkMatchesSubject(branch, subject('acme/widgets:workflow:Build and test@feature/x'))).toBe(true)
    expect(linkMatchesSubject(branch, subject('acme/widgets:workflow:Build and test@main'))).toBe(false)
    expect(subjectTarget('acme/widgets:checks:lint@v2@feature/x')).toEqual({ repo: 'acme/widgets', branch: 'feature/x' })
  })

  it('tells same-named fork branches apart through headRepo when both sides know it', () => {
    const link = { repo: 'acme/widgets', branch: 'feature/x', headRepo: 'fork-one/widgets' }
    expect(linkMatchesSubject(link, subject('acme/widgets:workflow:ci@feature/x', 'fork-one/widgets'))).toBe(true)
    expect(linkMatchesSubject(link, subject('acme/widgets:workflow:ci@feature/x', 'fork-two/widgets'))).toBe(false)
    // Either side missing the head repo still matches — it cannot be told apart.
    expect(linkMatchesSubject(link, subject('acme/widgets:workflow:ci@feature/x'))).toBe(true)
    expect(linkMatchesSubject({ repo: 'acme/widgets', branch: 'feature/x' }, subject('acme/widgets:workflow:ci@feature/x', 'fork-two/widgets'))).toBe(true)
  })

  it('accepts repos whose name starts with a dot', () => {
    expect(parseLinkRef('org/.github#7')).toEqual({ repo: 'org/.github', number: 7 })
    expect(parseLinkRef('https://github.com/org/.github/pull/7')).toMatchObject({ repo: 'org/.github', number: 7 })
    expect(subjectTarget('org/.github#7')).toEqual({ repo: 'org/.github', number: 7 })
    expect(subjectTarget('org/.github:workflow:ci@main')).toEqual({ repo: 'org/.github', branch: 'main' })
    expect(scanReportLinks('see https://github.com/org/.github/pull/7')).toHaveLength(1)
  })
})

function record(over: Partial<InboxRecord> = {}): InboxRecord {
  return {
    id: 'inbox-1', source: 'github', sourceId: 's', deliveryId: 'd-1', deliveryIds: ['d-1'],
    type: 'pull_request_review.submitted', subject: 'acme/widgets#12', title: 'review submitted',
    summary: 'state approved', count: 1, status: 'pending', receivedAt: 900, updatedAt: 900, ...over,
  }
}

describe('applyLinkEvent', () => {
  const base = makeTaskLink('c-1', { repo: 'acme/widgets', number: 12 }, 'dot', 1)

  it('records the newest event with the merged count', () => {
    const next = applyLinkEvent(base, record({ count: 3, title: 'CI failure' }), 1000)!
    expect(next.lastEvent).toMatchObject({ type: 'pull_request_review.submitted', title: 'CI failure', count: 3, at: 900 })
  })

  it('learns the head branch on a numbered link but never overwrites one', () => {
    const learned = applyLinkEvent(base, record({ headRef: 'feature/x' }), 1000)!
    expect(learned.branch).toBe('feature/x')
    const kept = applyLinkEvent(learned, record({ headRef: 'other' }), 1000)!
    expect(kept.branch).toBe('feature/x')
  })

  it('learns headRepo together with the branch', () => {
    const learned = applyLinkEvent(base, record({ headRef: 'feature/x', headRepo: 'fork/widgets' }), 1000)!
    expect(learned).toMatchObject({ branch: 'feature/x', headRepo: 'fork/widgets' })
  })

  it('settles merged and closed state', () => {
    expect(applyLinkEvent(base, record({ type: 'pull_request.merged' }), 1000)!.state).toBe('merged')
    expect(applyLinkEvent(base, record({ type: 'pull_request.closed' }), 1000)!.state).toBe('closed')
    expect(applyLinkEvent(base, record({ type: 'issues.closed' }), 1000)!.state).toBe('open')
  })

  it('moves a closed link back to open on pull_request.reopened', () => {
    const closed = applyLinkEvent(base, record({ type: 'pull_request.closed' }), 1000)!
    const reopened = applyLinkEvent(closed, record({ type: 'pull_request.reopened' }), 1000)!
    expect(reopened.state).toBe('open')
  })

  it('produces a stable id per change, repo and target', () => {
    expect(taskLinkId('c-1', { repo: 'acme/widgets', number: 12 })).toBe(taskLinkId('c-1', { repo: 'acme/widgets', number: 12 }))
    expect(taskLinkId('c-1', { repo: 'acme/widgets', number: 12 })).not.toBe(taskLinkId('c-2', { repo: 'acme/widgets', number: 12 }))
    expect(taskLinkId('c-1', { repo: 'acme/widgets', number: 12 })).not.toBe(taskLinkId('c-1', { repo: 'acme/widgets', branch: 'x' }))
  })
})

describe('polledTargets, bindThread and threadClosed', () => {
  it('selects active changes and recently active open links, binds threads, and closes PR links', () => {
    const now = 10_000_000_000
    const activeLink = makeTaskLink('c-active', { repo: 'acme/widgets', number: 10 }, 'dot', now - 1000)
    const recentClosedChangeLink = makeTaskLink('c-recent', { repo: 'acme/widgets', number: 11 }, 'auto', now - 1000)
    const staleLink = makeTaskLink('c-old', { repo: 'acme/widgets', number: 12 }, 'auto', now - 10 * 24 * 3600_000)

    const changes = new Map([
      ['c-active', { id: 'c-active', control: 'open' as const, updatedAt: now - 1000 }],
      ['c-recent', { id: 'c-recent', control: 'open' as const, closeout: { verificationId: 'v-1', source: 'user' }, updatedAt: now - 1000 }],
      ['c-old', { id: 'c-old', control: 'cancelled' as const, updatedAt: now - 10 * 24 * 3600_000 }],
    ])
    const targets = polledTargets([activeLink, recentClosedChangeLink, staleLink], changes, [], now)
    expect(targets.map(t => t.number)).toEqual([10, 11])

    const bound = bindThread([activeLink], 'c-active', { repo: 'acme/widgets', number: 99 }, 'auto', now)!
    expect(bound.number).toBe(99)

    const closed = threadClosed([activeLink, staleLink], 'Acme/Widgets', 10, 'merged', now)
    expect(closed).toHaveLength(1)
    expect(closed[0]!.state).toBe('merged')
  })

  it('distinguishes PR vs issue targetKind via URL, events, branch metadata, and legacy fallback', () => {
    const now = 10_000_000_000
    const issueLink = makeTaskLink('c-issue', { repo: 'acme/widgets', number: 1, url: 'https://github.com/acme/widgets/issues/1' }, 'dot', now)
    const prLink = makeTaskLink('c-pr', { repo: 'acme/widgets', number: 5, url: 'https://github.com/acme/widgets/pull/5' }, 'dot', now)
    const shorthandLink = makeTaskLink('c-short', { repo: 'acme/widgets', number: 9 }, 'dot', now)
    const branchOnlyLink = makeTaskLink('c-branch', { repo: 'acme/widgets', branch: 'feat/ci' }, 'auto', now)

    expect(issueLink.targetKind).toBe('issue')
    expect(prLink.targetKind).toBe('pr')
    expect(shorthandLink.targetKind).toBeUndefined()
    expect(branchOnlyLink.targetKind).toBeUndefined()

    // applyLinkEvent infers issue vs pr from event types, URLs, and headRef
    const fromIssueComment = applyLinkEvent(shorthandLink, record({
      type: 'issue_comment.created',
      subject: 'acme/widgets#9',
      url: 'https://github.com/acme/widgets/issues/9#issuecomment-1',
    }), now)!
    expect(fromIssueComment.targetKind).toBe('issue')

    const fromPrHead = applyLinkEvent(shorthandLink, record({
      type: 'issue_comment.created',
      subject: 'acme/widgets#9',
      headRef: 'feat/9',
    }), now)!
    expect(fromPrHead.targetKind).toBe('pr')

    const branchEvent = applyLinkEvent(branchOnlyLink, record({
      type: 'check_suite.completed',
      subject: 'acme/widgets:checks:ci@feat/ci',
      headRepo: 'acme/widgets',
    }), now)!
    expect(branchEvent.targetKind).toBeUndefined()

    // Legacy stored link without targetKind still infers cleanly in polledTargets & parseTaskLink
    const legacyIssue = parseTaskLink({
      id: 'link-legacy-issue',
      changeId: 'c-legacy',
      repo: 'acme/widgets',
      number: 2,
      url: 'https://ghes.example.com/acme/widgets/issues/2',
      origin: 'dot',
      state: 'open',
      addedAt: now,
    })!
    expect(legacyIssue).toBeDefined()
    expect(inferLinkTargetKind(legacyIssue)).toBe('issue')

    const changes = new Map([
      ['c-issue', { id: 'c-issue', control: 'open' as const, updatedAt: now }],
      ['c-pr', { id: 'c-pr', control: 'open' as const, updatedAt: now }],
      ['c-short', { id: 'c-short', control: 'open' as const, updatedAt: now }],
      ['c-legacy', { id: 'c-legacy', control: 'open' as const, updatedAt: now }],
    ])
    const targets = polledTargets([issueLink, prLink, shorthandLink, legacyIssue], changes, [], now)
    expect(targets.find(t => t.number === 1)?.targetKind).toBe('issue')
    expect(targets.find(t => t.number === 2)?.targetKind).toBe('issue')
    expect(targets.find(t => t.number === 5)?.targetKind).toBe('pr')
    expect(targets.find(t => t.number === 9)?.targetKind).toBeUndefined()
  })
})
