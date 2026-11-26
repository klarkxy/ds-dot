// Adapted from deepseek-ai/dsh-superagent-prototype@8c32a9d (MIT).
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { InboxEventInput } from '../contracts.ts'
import { normalizeGithubRepo } from '../settings.ts'

export const GITHUB_TITLE_MAX = 200
export const GITHUB_SUMMARY_MAX = 500

export const UserSchema = z.object({
  login: z.string().min(1),
  type: z.string().optional(),
}).loose().nullable().optional().transform(user => user ?? { login: 'ghost', type: 'User' })

export const CommentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string().nullable().optional(),
  user: UserSchema,
  html_url: z.string().nullable().optional(),
  issue_url: z.string().nullable().optional(),
  pull_request_url: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  commit_id: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  line: z.number().int().nullable().optional(),
  original_line: z.number().int().nullable().optional(),
  diff_hunk: z.string().nullable().optional(),
  in_reply_to_id: z.number().int().nullable().optional(),
}).loose()

export const IssueSchema = CommentSchema.extend({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  created_at: z.string(),
  html_url: z.string(),
  pull_request: z.object({ url: z.string().optional() }).loose().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  assignee: UserSchema.optional(),
}).loose()

export type GhUser = z.infer<typeof UserSchema>
export type GhComment = z.infer<typeof CommentSchema>
export type GhIssue = z.infer<typeof IssueSchema>

export function sameName(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

export function flattenText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function clipText(text: string, max: number): string {
  const flat = flattenText(text)
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

export function isHumanLogin(user: Pick<GhUser, 'login' | 'type'> | undefined): boolean {
  if (!user?.login) return false
  return !/\[bot\]$/i.test(user.login) && (!user.type || user.type === 'User')
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function mentions(text: string, login: string): boolean {
  const clean = login.trim()
  if (!clean) return false
  return new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(clean)}(?![a-zA-Z0-9_-])`, 'i').test(text)
}

export interface GithubAddressRef {
  readonly number: number
  readonly pr: boolean
  readonly discussion?: number
}

const GITHUB_ADDRESS_RE = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i

export function githubAddress(url: string | null | undefined, repository: string): GithubAddressRef | undefined {
  if (!url) return undefined
  const match = GITHUB_ADDRESS_RE.exec(url.trim())
  if (!match || !sameName(match[1], repository)) return undefined
  const kind = match[2]!.toLowerCase()
  const number = Number(match[3])
  const discussion = match[4] ? Number(match[4]) : undefined
  return {
    number,
    pr: kind === 'pull' || kind === 'pulls',
    ...(discussion !== undefined ? { discussion } : {}),
  }
}

export function reviewPlace(comment: Pick<GhComment, 'path' | 'line' | 'original_line' | 'diff_hunk'>): string {
  const line = comment.line ?? comment.original_line ?? undefined
  const loc = comment.path ? `${comment.path}${line != null ? `:${line}` : ''}` : ''
  const hunkLines = comment.diff_hunk
    ? comment.diff_hunk.split(/\r?\n/).filter(l => l.length > 0).slice(-3).join('\n')
    : ''
  return [loc, hunkLines].filter(Boolean).join('\n')
}

export function commentText(comment: GhComment, kind: 'conversation' | 'inline' | 'review'): string {
  const body = (comment.body ?? '').trim()
  if (kind === 'review') {
    const state = (comment.state ?? '').trim().toUpperCase()
    if (state && state !== 'COMMENTED') {
      const head = `${state} review of commit ${comment.commit_id?.slice(0, 10) ?? 'unknown'}`
      return body ? `${head}\n\n${body}` : head
    }
    return body
  }
  if (kind === 'inline' && comment.path) {
    const place = reviewPlace(comment)
    return [place, body].filter(Boolean).join('\n\n')
  }
  return body
}

/** Deterministic SHA-256 hex slice 32 key matching prototype trigger IDs. */
export function deterministicKey(...parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
}

export function commentTriggerId(comment: Pick<GhComment, 'id' | 'html_url' | 'updated_at' | 'submitted_at'>, number: number): string {
  return `gh-poll:${deterministicKey('github-comment', comment.html_url ?? `github:${number}`, String(comment.id), comment.updated_at ?? comment.submitted_at ?? '')}`
}

export function issueTriggerId(repo: string, number: number, action: string): string {
  return `gh-poll:${deterministicKey('github-issue', normalizeGithubRepo(repo), String(number), action)}`
}

export function branchCiTriggerId(repo: string, branch: string, revision: number): string {
  return `gh-poll:${deterministicKey('github-ci', normalizeGithubRepo(repo), `branch:${branch}`, String(revision))}`
}

export function prCiTriggerId(repo: string, number: number, revision: number): string {
  return `gh-poll:${deterministicKey('github-ci', normalizeGithubRepo(repo), String(number), String(revision))}`
}

export function timestampMs(iso: string | null | undefined, fallback: number): number {
  if (!iso) return fallback
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : fallback
}

export function buildIssueInboxInput(params: {
  readonly repo: string
  readonly sourceId: string
  readonly issue: GhIssue
  readonly action: 'opened' | 'reopened' | 'closed'
  readonly now: number
}): InboxEventInput {
  const repo = normalizeGithubRepo(params.repo)
  const at = timestampMs(params.issue.updated_at ?? params.issue.created_at, params.now)
  const body = params.action === 'opened' ? (params.issue.body ?? '') : ''
  return {
    source: 'github',
    sourceId: params.sourceId,
    deliveryId: issueTriggerId(repo, params.issue.number, params.action),
    type: `issues.${params.action}`,
    subject: `${repo}#${params.issue.number}`,
    title: clipText(params.issue.title || `issue ${params.action}`, GITHUB_TITLE_MAX),
    actor: params.issue.user.login,
    ...(params.issue.html_url ? { url: params.issue.html_url } : {}),
    summary: clipText(body, GITHUB_SUMMARY_MAX),
    receivedAt: at,
    originSource: 'github-poll',
  }
}

export function buildCommentInboxInput(params: {
  readonly repo: string
  readonly sourceId: string
  readonly number: number
  readonly title?: string
  readonly comment: GhComment
  readonly kind: 'conversation' | 'inline' | 'review'
  readonly headRef?: string
  readonly headRepo?: string
  readonly now: number
}): InboxEventInput | undefined {
  const repo = normalizeGithubRepo(params.repo)
  const text = commentText(params.comment, params.kind)
  if (!text) return undefined
  const at = timestampMs(params.comment.submitted_at ?? params.comment.updated_at ?? params.comment.created_at, params.now)
  const state = (params.comment.state ?? 'commented').trim().toLowerCase()
  const type = params.kind === 'review'
    ? `pull_request_review.${state}`
    : params.kind === 'inline'
      ? 'pull_request_review_comment.created'
      : 'issue_comment.created'
  const line = params.comment.line ?? params.comment.original_line ?? undefined
  const summaryRaw = params.kind === 'inline' && params.comment.path
    ? `${params.comment.path}${line != null ? `:${line}` : ''} — ${params.comment.body ?? ''}`
    : params.kind === 'review'
      ? `state ${state}${params.comment.body ? ` — ${params.comment.body}` : ''}`
      : params.comment.body ?? text
  return {
    source: 'github',
    sourceId: params.sourceId,
    deliveryId: commentTriggerId(params.comment, params.number),
    type,
    subject: `${repo}#${params.number}`,
    title: clipText(
      params.title || (params.kind === 'review' ? `review ${state}` : params.kind === 'inline' ? 'review comment' : 'comment'),
      GITHUB_TITLE_MAX,
    ),
    actor: params.comment.user.login,
    ...(params.comment.html_url ? { url: params.comment.html_url } : {}),
    summary: clipText(summaryRaw, GITHUB_SUMMARY_MAX),
    receivedAt: at,
    ...(params.headRef ? { headRef: params.headRef } : {}),
    ...(params.headRepo ? { headRepo: params.headRepo.toLowerCase() } : {}),
    originSource: 'github-poll',
  }
}
