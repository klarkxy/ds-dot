/**
 * Task links bind a change to a GitHub target — a pull request, an issue, or
 * a head branch — so inbox events that pass the noise filter arrive with the
 * task's context. All parsing and matching lives here; the service only holds
 * the durable rows.
 */
import { createHash } from 'node:crypto'
import type { InboxRecord, TaskLink } from './contracts.ts'
import { changeIsTerminal, type ChangeRecord, type RunRecord } from './work.ts'

/** Active-PR polling window for recently touched links (7 days). */
export const POLL_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60_000

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
  readonly targetKind?: 'pr' | 'issue'
}

const URL_TARGET_KIND_RE = /^https?:\/\/[^/]+(?:\/(?:api\/v3\/repos|repos))?\/[^/]+\/[^/]+\/(pull|pulls|issues)\/\d+(?:[/?#]|$)/i

/** Infer `'pr' | 'issue'` from a GitHub pull/issue URL when unambiguous. */
export function urlTargetKind(url: string | undefined): 'pr' | 'issue' | undefined {
  if (!url) return undefined
  const match = URL_TARGET_KIND_RE.exec(url.trim())
  if (!match) return undefined
  return match[1]!.toLowerCase() === 'issues' ? 'issue' : 'pr'
}

/** Infer `'pr' | 'issue'` from an inbox event's type, branch metadata, or URL. */
export function inferEventTargetKind(
  record: Pick<InboxRecord, 'type' | 'url' | 'headRef' | 'headRepo'>,
): 'pr' | 'issue' | undefined {
  if (record.type.startsWith('pull_request')) return 'pr'
  if (record.type.startsWith('issues.')) return 'issue'
  if (record.headRef !== undefined || record.headRepo !== undefined) return 'pr'
  return urlTargetKind(record.url)
}

/** Infer `'pr' | 'issue'` from a stored `TaskLink`'s metadata. */
export function inferLinkTargetKind(
  link: Pick<TaskLink, 'number' | 'branch' | 'headRepo' | 'url' | 'targetKind' | 'lastEvent'>,
): 'pr' | 'issue' | undefined {
  if (link.targetKind) return link.targetKind
  const fromUrl = urlTargetKind(link.url)
  if (fromUrl) return fromUrl
  if (link.lastEvent) {
    if (link.lastEvent.type.startsWith('pull_request')) return 'pr'
    if (link.lastEvent.type.startsWith('issues.')) return 'issue'
    const fromEventUrl = urlTargetKind(link.lastEvent.url)
    if (fromEventUrl) return fromEventUrl
  }
  if (link.number !== undefined && (link.branch !== undefined || link.headRepo !== undefined)) return 'pr'
  return undefined
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
  const targetKind = target.targetKind ?? urlTargetKind(target.url)
  return {
    id: taskLinkId(changeId, target),
    changeId,
    repo: target.repo,
    ...(target.number !== undefined ? { number: target.number } : {}),
    ...(target.branch !== undefined ? { branch: target.branch } : {}),
    ...(target.url ? { url: target.url } : {}),
    ...(targetKind ? { targetKind } : {}),
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
  const nextTargetKind = link.number !== undefined
    ? (link.targetKind ?? inferEventTargetKind(record) ?? inferLinkTargetKind(link))
    : link.targetKind
  const next: TaskLink = {
    ...link,
    ...(learnBranch ? { branch: record.headRef } : {}),
    // The head ref alone does not say which fork pushed it; keep the repo too
    // so branch matching can tell same-named branches apart.
    ...(learnBranch && record.headRepo !== undefined ? { headRepo: record.headRepo } : {}),
    ...(nextTargetKind ? { targetKind: nextTargetKind } : {}),
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

export interface PolledTarget {
  readonly repo: string
  readonly number: number
  readonly targetKind?: 'pr' | 'issue'
  readonly branch?: string
  readonly headRepo?: string
  readonly changeIds: readonly string[]
}

/**
 * PRs/Issues in `links` that belong to an active (non-terminal) Change or had
 * activity within the last 7 days while still open.
 */
export function polledTargets(
  links: readonly TaskLink[],
  changes: ReadonlyMap<string, Pick<ChangeRecord, 'id' | 'control' | 'closeout' | 'updatedAt'>>,
  runs: readonly Pick<RunRecord, 'changeId' | 'phase'>[],
  now = Date.now(),
  repoFilter?: string,
): PolledTarget[] {
  const normalizedFilter = repoFilter?.trim().toLowerCase()
  const runsByChange = new Map<string, Pick<RunRecord, 'changeId' | 'phase'>[]>()
  for (const run of runs) {
    const list = runsByChange.get(run.changeId)
    if (list) list.push(run)
    else runsByChange.set(run.changeId, [run])
  }
  const byTarget = new Map<string, { repo: string; number: number; targetKind?: 'pr' | 'issue'; branch?: string; headRepo?: string; changeIds: Set<string> }>()
  for (const link of links) {
    if (link.number === undefined) continue
    if (normalizedFilter && link.repo !== normalizedFilter) continue
    const change = changes.get(link.changeId)
    const changeRuns = runsByChange.get(link.changeId) ?? []
    const activeChange = change !== undefined && !changeIsTerminal(change as ChangeRecord, changeRuns as RunRecord[])
    const lastAt = Math.max(change?.updatedAt ?? 0, link.lastEvent?.at ?? 0, link.addedAt)
    const recentlyActive = link.state === 'open' && now - lastAt <= POLL_ACTIVE_WINDOW_MS
    if (!activeChange && !recentlyActive) continue
    const key = `${link.repo}#${link.number}`
    const kind = inferLinkTargetKind(link)
    let entry = byTarget.get(key)
    if (!entry) {
      entry = {
        repo: link.repo,
        number: link.number,
        ...(kind ? { targetKind: kind } : {}),
        ...(link.branch ? { branch: link.branch } : {}),
        ...(link.headRepo ? { headRepo: link.headRepo } : {}),
        changeIds: new Set(),
      }
      byTarget.set(key, entry)
    } else {
      if (!entry.targetKind && kind) entry.targetKind = kind
      if (!entry.branch && link.branch) entry.branch = link.branch
      if (!entry.headRepo && link.headRepo) entry.headRepo = link.headRepo
    }
    entry.changeIds.add(link.changeId)
  }
  return [...byTarget.values()].map(item => ({
    repo: item.repo,
    number: item.number,
    ...(item.targetKind ? { targetKind: item.targetKind } : {}),
    ...(item.branch ? { branch: item.branch } : {}),
    ...(item.headRepo ? { headRepo: item.headRepo } : {}),
    changeIds: [...item.changeIds],
  }))
}

/** Ensure a thread target is bound to a change and optionally fold an event into it. */
export function bindThread(
  existing: readonly TaskLink[],
  changeId: string,
  target: LinkTarget,
  origin: 'dot' | 'auto',
  at: number,
  event?: InboxRecord,
): TaskLink | undefined {
  const id = taskLinkId(changeId, target)
  const found = existing.find(row => row.id === id)
  if (!found) {
    const created = makeTaskLink(changeId, target, origin, at)
    return event ? (applyLinkEvent(created, event, at) ?? created) : created
  }
  return event ? applyLinkEvent(found, event, at) : undefined
}

/** Transition matching PR links to `merged` or `closed`, returning only changed link records. */
export function threadClosed(
  links: readonly TaskLink[],
  repo: string,
  number: number,
  outcome: 'closed' | 'merged',
  at: number,
  event?: InboxRecord,
): TaskLink[] {
  const normalizedRepo = repo.trim().toLowerCase()
  const updated: TaskLink[] = []
  for (const link of links) {
    if (link.repo !== normalizedRepo || link.number !== number) continue
    const base = event ? (applyLinkEvent(link, event, at) ?? link) : link
    if (base.state === outcome && base === link) continue
    updated.push(base.state === outcome ? base : { ...base, state: outcome })
  }
  return updated
}
