/**
 * Task links bind a change to a GitHub target — a pull request, an issue, or
 * a head branch — so inbox events that pass the noise filter arrive with the
 * task's context. All parsing and matching lives here; the service only holds
 * the durable rows.
 */
import { createHash } from 'node:crypto'
import type { InboxRecord, TaskLink } from './contracts.ts'

/** Auto-links one run report may add; a report quoting many PRs stays bounded. */
export const REPORT_LINKS_MAX = 5

const OWNER = '[A-Za-z0-9][A-Za-z0-9_.-]*'
/** Repo names may start with a dot or underscore (`org/.github`). */
const NAME = '[A-Za-z0-9_.][A-Za-z0-9_.-]*'
const REPO_RE = new RegExp(`^(${OWNER}/${NAME})$`)

/** A GitHub target parsed from a `ref` argument or a report URL. */
export interface LinkTarget {
  /** owner/repo, lower-cased. */
  readonly repo: string
  readonly number?: number
  readonly branch?: string
  readonly url?: string
}

/**
 * Accepted forms: `https://github.com/<owner>/<repo>/pull|issues/<n>`,
 * `owner/repo#<n>`, `owner/repo@<branch>`. Everything else is not a link ref.
 */
export function parseLinkRef(ref: string): LinkTarget | undefined {
  const text = ref.trim()
  const url = /^https?:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.][A-Za-z0-9_.-]*)\/(pull|issues)\/(\d+)(?:[/?#]|$)/i.exec(text)
  if (url) {
    return { repo: `${url[1]}/${url[2]}`.toLowerCase(), number: Number(url[4]), url: text.split(/[?#]/)[0] }
  }
  const numbered = new RegExp(`^(${OWNER}/${NAME})#(\\d+)$`).exec(text)
  if (numbered) return { repo: numbered[1].toLowerCase(), number: Number(numbered[2]) }
  const branched = new RegExp(`^(${OWNER}/${NAME})@([^\\s@#]+)$`).exec(text)
  if (branched && REPO_RE.test(branched[1])) return { repo: branched[1].toLowerCase(), branch: branched[2] }
  return undefined
}

/** Deterministic id: one row per (changeId, repo, number|branch). */
export function taskLinkId(changeId: string, target: Pick<LinkTarget, 'repo' | 'number' | 'branch'>): string {
  const key = `${changeId}\0${target.repo}\0${target.number ?? ''}\0${target.branch ?? ''}`
  return `link-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`
}

export function makeTaskLink(changeId: string, target: LinkTarget, origin: 'dot' | 'auto', at: number): TaskLink {
  return {
    id: taskLinkId(changeId, target),
    changeId,
    repo: target.repo,
    ...(target.number !== undefined ? { number: target.number } : {}),
    ...(target.branch !== undefined ? { branch: target.branch } : {}),
    ...(target.url ? { url: target.url } : {}),
    origin,
    state: 'open',
    addedAt: at,
  }
}

const REPORT_URL_RE = /https?:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.][A-Za-z0-9_.-]*)\/(?:pull|issues)\/(\d+)/gi

/** PR/issue URLs quoted in a run report, deduped and capped. */
export function scanReportLinks(text: string): LinkTarget[] {
  const found = new Map<string, LinkTarget>()
  for (const match of text.matchAll(REPORT_URL_RE)) {
    const repo = `${match[1]}/${match[2]}`.toLowerCase()
    const key = `${repo}#${match[3]}`
    if (!found.has(key)) found.set(key, { repo, number: Number(match[3]), url: match[0] })
    if (found.size >= REPORT_LINKS_MAX) break
  }
  return [...found.values()]
}

/** What one inbox subject binds to: a repo plus a number or a branch. */
export interface SubjectTarget {
  readonly repo: string
  readonly number?: number
  readonly branch?: string
}

const SUBJECT_NUMBER_RE = new RegExp(`^(${OWNER}/${NAME})#(\\d+)$`)
// Workflow/check names may contain spaces or '@' ('Build and test'), so the
// name matches greedily and the branch is everything after the LAST '@'.
const SUBJECT_BRANCH_RE = new RegExp(`^(${OWNER}/${NAME}):(?:workflow|checks):(.+)@([^\\s@]+)$`)

/** Subjects an event may carry that can bind to a link; anything else cannot. */
export function subjectTarget(subject: string): SubjectTarget | undefined {
  const numbered = SUBJECT_NUMBER_RE.exec(subject)
  if (numbered) return { repo: numbered[1].toLowerCase(), number: Number(numbered[2]) }
  const branched = SUBJECT_BRANCH_RE.exec(subject)
  if (branched) return { repo: branched[1].toLowerCase(), branch: branched[3] }
  return undefined
}

export function linkMatchesSubject(link: Pick<TaskLink, 'repo' | 'number' | 'branch' | 'headRepo'>, record: Pick<InboxRecord, 'subject' | 'headRepo'>): boolean {
  const target = subjectTarget(record.subject)
  if (!target || target.repo !== link.repo) return false
  if (target.number !== undefined) return link.number === target.number
  if (target.branch === undefined || link.branch !== target.branch) return false
  // Forks reuse branch names: when both sides know the head repo it must agree.
  return link.headRepo === undefined || record.headRepo === undefined || link.headRepo === record.headRepo
}

/** The link state an event type settles, when it settles one. */
export function linkEventState(type: string): 'open' | 'closed' | 'merged' | undefined {
  if (type === 'pull_request.merged') return 'merged'
  if (type === 'pull_request.closed') return 'closed'
  if (type === 'pull_request.reopened') return 'open'
  return undefined
}

/**
 * Fold one stored inbox record into a matched link: remember the newest event,
 * settle state on close/merge, and learn the head branch a numbered link did
 * not carry yet. Returns undefined when nothing changed.
 */
export function applyLinkEvent(link: TaskLink, record: InboxRecord, at: number): TaskLink | undefined {
  const state = linkEventState(record.type)
  const learnBranch = record.headRef !== undefined && link.branch === undefined && link.number !== undefined
  const next: TaskLink = {
    ...link,
    ...(learnBranch ? { branch: record.headRef } : {}),
    // The head ref alone does not say which fork pushed it; keep the repo too
    // so branch matching can tell same-named branches apart.
    ...(learnBranch && record.headRepo !== undefined ? { headRepo: record.headRepo } : {}),
    ...(state !== undefined && state !== link.state ? { state } : {}),
    lastEvent: {
      type: record.type,
      title: record.title,
      summary: record.summary,
      ...(record.url ? { url: record.url } : {}),
      at: record.receivedAt || at,
      count: record.count,
    },
  }
  return next
}
