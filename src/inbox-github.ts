/**
 * GitHub webhook ingress. The upstream @deepseek-ai/dsh-webhook runtime is an
 * optional host service, so its few shapes are declared here structurally
 * instead of importing the package. The one rule never opens a session:
 * every accepted delivery is normalized into dot's inbox and `run` returns
 * null. Normalization is defensive — a malformed payload is dropped, never
 * thrown back into the runtime.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { InboxEventInput } from './contracts.ts'

export interface VerifiedWebhookDelivery {
  readonly kind: string
  readonly source: string
  readonly deliveryId: string
  readonly event: unknown
  readonly receivedAt: number
}

/** Upstream brand; any string is a valid rule id. */
export type WebhookRuleId = string & { readonly __webhookRuleId: unique symbol }

export interface WebhookRule {
  readonly id: WebhookRuleId
  readonly kind: string
  run(delivery: VerifiedWebhookDelivery, signal: AbortSignal): unknown
}

export interface WebhookRuntimeLike {
  register(rule: WebhookRule): () => Promise<void>
}

export const INBOX_RULE_ID = 'ds-dot/inbox' as WebhookRuleId

type InboxHost = Context & { webhookRuntime?: WebhookRuntimeLike }

interface InboxSubmitter {
  submitInbox(event: InboxEventInput): Promise<unknown>
}

/**
 * Register the single github rule once the host provides the webhook runtime.
 * `ctx.inject` runs the callback only when the service exists and replays it
 * when the service is replaced; the inner effect's disposer unregisters on
 * unload. No runtime — nothing happens.
 */
export function installInboxIngress(ctx: Context, service: InboxSubmitter, log?: (message: string) => void): void {
  if (typeof ctx.inject !== 'function') return
  void ctx.inject(['webhookRuntime'], inboxCtx => {
    inboxCtx.effect(() => {
      const runtime = (inboxCtx as InboxHost).webhookRuntime
      if (typeof runtime?.register !== 'function') return () => {}
      return runtime.register({
        id: INBOX_RULE_ID,
        kind: 'github',
        async run(delivery) {
          try {
            const event = normalizeGithub(delivery)
            if (event !== undefined) {
              await service.submitInbox(event).catch(error => {
                log?.(`dsh-dot: inbox event ${delivery?.deliveryId} was not stored: ${error instanceof Error ? error.message : String(error)}`)
              })
            }
          } catch (error) {
            log?.(`dsh-dot: inbox delivery ${delivery?.deliveryId} could not be handled: ${error instanceof Error ? error.message : String(error)}`)
          }
          return null
        },
      })
    }, 'dot.inbox')
  })
}

// ---- normalization ---------------------------------------------------------

const TITLE_MAX = 200
const SUMMARY_MAX = 500

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const str = (value: unknown): string => typeof value === 'string' ? value : ''
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
const shortSha = (value: unknown): string | undefined => {
  const sha = str(value)
  return sha ? sha.slice(0, 10) : undefined
}

type Base = Pick<InboxEventInput, 'source' | 'sourceId' | 'deliveryId' | 'receivedAt'>
type EventView = Omit<InboxEventInput, keyof Base>
interface EventCtx { readonly repo: string; readonly sender?: string }

const actor = (primary: string | undefined, fallback?: string) => (primary || fallback) ? { actor: primary || fallback } : {}
const link = (value: unknown) => str(value) ? { url: str(value) } : {}

const NOISY_CONCLUSIONS = ['success', 'skipped', 'neutral']

export function normalizeGithub(delivery: VerifiedWebhookDelivery): InboxEventInput | undefined {
  const event = rec(delivery?.event)
  const name = str(event?.name)
  if (!name) return undefined
  const payload = rec(event?.payload)
  const repository = rec(payload?.repository)
  const repo = str(repository?.full_name)
  if (!payload || !repository || !repo) return undefined
  const ctx: EventCtx = { repo, sender: str(rec(payload.sender)?.login) || undefined }
  let view: EventView | undefined
  switch (name) {
    case 'ping':
    case 'check_run':
    case 'star':
    case 'watch':
    case 'fork':
      return undefined
    case 'pull_request': view = pullRequest(payload, ctx); break
    case 'issues': view = issue(payload, ctx); break
    case 'issue_comment': view = issueComment(payload, ctx); break
    case 'pull_request_review_comment': view = reviewComment(payload, ctx); break
    case 'pull_request_review': view = pullRequestReview(payload, ctx); break
    case 'discussion_comment': view = discussionComment(payload, ctx); break
    case 'push': view = push(payload, ctx, repository); break
    case 'workflow_run': view = workflowRun(payload, ctx); break
    case 'check_suite': view = checkSuite(payload, ctx); break
    case 'release': view = release(payload, ctx); break
    default: view = {
      type: str(payload.action) ? `${name}.${str(payload.action)}` : name,
      subject: repo,
      title: repo,
      ...actor(undefined, ctx.sender),
      ...link(repository.html_url),
      summary: '',
    }
  }
  if (!view) return undefined
  const sourceId = str(delivery.source)
  const deliveryId = str(delivery.deliveryId)
  if (!sourceId || !deliveryId) return undefined
  return {
    ...view,
    source: str(delivery.kind) || 'github',
    sourceId,
    deliveryId,
    receivedAt: num(delivery.receivedAt) ?? 0,
  }
}

function pullRequest(p: Record<string, unknown>, ctx: EventCtx): EventView | undefined {
  const action = str(p.action)
  if (!['opened', 'reopened', 'ready_for_review', 'closed', 'review_requested'].includes(action)) return undefined
  const pr = rec(p.pull_request)
  if (!pr) return undefined
  const number = num(pr.number) ?? num(p.number)
  const merged = action === 'closed' && pr.merged === true
  const parts: string[] = []
  const head = shortSha(rec(pr.head)?.sha)
  if (head) parts.push(`head ${head}`)
  const baseRef = str(rec(pr.base)?.ref)
  if (baseRef) parts.push(`→ ${baseRef}`)
  if (merged) parts.push('merged')
  if (action === 'review_requested') {
    const reviewers = [p.requested_reviewer, ...Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers : []]
      .map(row => str(rec(row)?.login)).filter(Boolean)
    if (reviewers.length) parts.push(`review requested from ${[...new Set(reviewers)].join(', ')}`)
  }
  if (action === 'opened') parts.push(str(pr.body))
  return {
    type: `pull_request.${merged ? 'merged' : action}`,
    subject: number !== undefined ? `${ctx.repo}#${number}` : ctx.repo,
    title: clip(str(pr.title) || `pull request ${merged ? 'merged' : action}`, TITLE_MAX),
    ...actor(undefined, ctx.sender),
    ...link(pr.html_url),
    summary: clip(parts.join(' · '), SUMMARY_MAX),
  }
}

function issue(p: Record<string, unknown>, ctx: EventCtx): EventView | undefined {
  const action = str(p.action)
  if (!['opened', 'reopened', 'closed', 'assigned'].includes(action)) return undefined
  const row = rec(p.issue)
  if (!row) return undefined
  const number = num(row.number) ?? num(p.number)
  const parts: string[] = []
  if (action === 'assigned') {
    const assignee = str(rec(p.assignee)?.login) || str(rec(row.assignee)?.login)
    if (assignee) parts.push(`assigned to ${assignee}`)
  }
  if (action === 'opened') parts.push(str(row.body))
  return {
    type: `issues.${action}`,
    subject: number !== undefined ? `${ctx.repo}#${number}` : ctx.repo,
    title: clip(str(row.title) || `issue ${action}`, TITLE_MAX),
    ...actor(undefined, ctx.sender),
    ...link(row.html_url),
    summary: clip(parts.join(' · '), SUMMARY_MAX),
  }
}

function issueComment(p: Record<string, unknown>, ctx: EventCtx): EventView | undefined {
  if (str(p.action) !== 'created') return undefined
  const row = rec(p.issue)
  const comment = rec(p.comment)
  if (!row || !comment) return undefined
  const number = num(row.number) ?? num(p.number)
  const onPr = rec(row.pull_request) !== undefined
  return {
    type: 'issue_comment.created',
    subject: number !== undefined ? `${ctx.repo}#${number}` : ctx.repo,
    title: clip(str(row.title) || `${onPr ? 'pull request' : 'issue'} comment`, TITLE_MAX),
    ...actor(str(rec(comment.user)?.login), ctx.sender),
    ...link(comment.html_url),
    summary: clip(str(comment.body), SUMMARY_MAX),
  }
}

function reviewComment(p: Record<string, unknown>, ctx: EventCtx): EventView | undefined {
  if (str(p.action) !== 'created') return undefined
  const pr = rec(p.pull_request)
  const comment = rec(p.comment)
  if (!pr || !comment) return undefined
  const number = num(pr.number) ?? num(p.number)
  const path = str(comment.path)
  const line = num(comment.line) ?? num(comment.original_line)
  const where = path ? `${path}${line !== undefined ? `:${line}` : ''} — ` : ''
  return {
    type: 'pull_request_review_comment.created',
    subject: number !== undefined ? `${ctx.repo}#${number}` : ctx.repo,
    title: clip(str(pr.title) || 'review comment', TITLE_MAX),
    ...actor(str(rec(comment.user)?.login), ctx.sender),
    ...link(comment.html_url),
    summary: clip(`${where}${str(comment.body)}`, SUMMARY_MAX),
  }
}

function pullRequestReview(p: Record<string, unknown>, ctx: EventCtx): EventView | undefined {
  if (str(p.action) !== 'submitted') return undefined
  const review = rec(p.review)
  const pr = rec(p.pull_request)
  if (!review || !pr) return undefined
  const number = num(pr.number) ?? num(p.number)
  const state = str(review.state) || 'submitted'
  return {
    type: `pull_request_review.${state}`,
    subject: number !== undefined ? `${ctx.repo}#${number}` : ctx.repo,
    title: clip(str(pr.title) || `review ${state}`, TITLE_MAX),
    ...actor(str(rec(review.user)?.login), ctx.sender),
    ...link(review.html_url),
    summary: clip(`state ${state}${str(review.body) ? ` — ${str(review.body)}` : ''}`, SUMMARY_MAX),
  }
}

function discussionComment(p: Record<string, unknown>, ctx: EventCtx): EventView | undefined {
  if (str(p.action) !== 'created') return undefined
  const discussion = rec(p.discussion)
  const comment = rec(p.comment)
  if (!discussion || !comment) return undefined
  const number = num(discussion.number)
  return {
    type: 'discussion_comment.created',
    subject: `${ctx.repo}:discussion#${number ?? ''}`,
    title: clip(str(discussion.title) || 'discussion comment', TITLE_MAX),
    ...actor(str(rec(comment.user)?.login), ctx.sender),
    ...link(comment.html_url),
    summary: clip(str(comment.body), SUMMARY_MAX),
  }
}

function push(p: Record<string, unknown>, ctx: EventCtx, repository: Record<string, unknown>): EventView | undefined {
  const ref = str(p.ref)
  const defaultBranch = str(repository.default_branch)
  if (!defaultBranch || ref !== `refs/heads/${defaultBranch}`) return undefined
  const commits = Array.isArray(p.commits) ? p.commits : []
  if (commits.length === 0) return undefined
  const head = rec(p.head_commit)
  const firstLine = (value: unknown) => str(value).split(/\r?\n/)[0] ?? ''
  const messages = commits.map(row => clip(firstLine(rec(row)?.message), 80)).filter(Boolean)
  const n = commits.length
  const headTitle = head ? firstLine(head.message) : ''
  return {
    type: 'push',
    subject: `${ctx.repo}@${ref}`,
    title: clip(headTitle || `${n} commit${n === 1 ? '' : 's'} to ${defaultBranch}`, TITLE_MAX),
    ...actor(str(rec(p.pusher)?.name), ctx.sender),
    ...link(str(p.compare) || str(head?.url)),
    summary: clip(`${n} commit${n === 1 ? '' : 's'}${messages.length ? `: ${messages.slice(0, 5).join(' · ')}` : ''}`, SUMMARY_MAX),
  }
}

function workflowRun(p: Record<string, unknown>, ctx: EventCtx): EventView | undefined {
  if (str(p.action) !== 'completed') return undefined
  const run = rec(p.workflow_run)
  if (!run) return undefined
  const conclusion = str(run.conclusion)
  if (!conclusion || NOISY_CONCLUSIONS.includes(conclusion)) return undefined
  const name = str(run.name) || 'workflow'
  const branch = str(run.head_branch)
  const parts = [`conclusion ${conclusion}`]
  const head = shortSha(run.head_sha)
  if (head) parts.push(`head ${head}`)
  const number = num(run.run_number)
  if (number !== undefined) parts.push(`run #${number}`)
  return {
    type: 'workflow_run.completed',
    subject: `${ctx.repo}:workflow:${name}${branch ? `@${branch}` : ''}`,
    title: clip(`${name} ${conclusion}`, TITLE_MAX),
    ...actor(str(rec(run.actor)?.login), ctx.sender),
    ...link(run.html_url),
    summary: clip(parts.join(' · '), SUMMARY_MAX),
  }
}

function checkSuite(p: Record<string, unknown>, ctx: EventCtx): EventView | undefined {
  if (str(p.action) !== 'completed') return undefined
  const suite = rec(p.check_suite)
  if (!suite) return undefined
  const conclusion = str(suite.conclusion)
  if (!conclusion || NOISY_CONCLUSIONS.includes(conclusion)) return undefined
  const app = str(rec(suite.app)?.name) || 'checks'
  const branch = str(suite.head_branch)
  const parts = [`conclusion ${conclusion}`]
  const head = shortSha(suite.head_sha)
  if (head) parts.push(`head ${head}`)
  return {
    type: 'check_suite.completed',
    subject: `${ctx.repo}:checks:${app}${branch ? `@${branch}` : ''}`,
    title: clip(`${app} ${conclusion}`, TITLE_MAX),
    ...actor(undefined, ctx.sender),
    ...link(suite.html_url ?? suite.url),
    summary: clip(parts.join(' · '), SUMMARY_MAX),
  }
}

function release(p: Record<string, unknown>, ctx: EventCtx): EventView | undefined {
  if (str(p.action) !== 'published') return undefined
  const row = rec(p.release)
  if (!row) return undefined
  const tag = str(row.tag_name)
  return {
    type: 'release.published',
    subject: `${ctx.repo}:release:${tag || str(row.name) || 'release'}`,
    title: clip(str(row.name) || tag || 'release', TITLE_MAX),
    ...actor(undefined, ctx.sender),
    ...link(row.html_url),
    summary: clip(str(row.body), SUMMARY_MAX),
  }
}
