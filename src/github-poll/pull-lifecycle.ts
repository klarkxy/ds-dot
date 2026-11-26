// Adapted from deepseek-ai/dsh-superagent-prototype@8c32a9d (MIT).
import { z } from 'zod'
import type { InboxEventInput, InboxRecord, TaskLink } from '../contracts.ts'
import { applyLinkEvent, linkMatchesSubject, makeTaskLink, threadClosed as updateClosedLinks } from '../links.ts'
import { normalizeGithubRepo } from '../settings.ts'
import { changeIsTerminal, type ChangeRecord, type RunRecord } from '../work.ts'
import { GITHUB_SUMMARY_MAX, GITHUB_TITLE_MAX, UserSchema, clipText, deterministicKey, sameName, timestampMs } from './triggers.ts'

export const PullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().optional(),
  state: z.string(),
  html_url: z.string(),
  user: UserSchema,
  body: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  merged: z.boolean().nullable().optional(),
  merged_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  auto_merge: z.unknown().nullable().optional(),
  head: z.object({
    sha: z.string(),
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).loose().nullable().optional(),
  }).loose(),
  base: z.object({
    ref: z.string(),
  }).loose().optional(),
}).loose()

export type GhPull = z.infer<typeof PullSchema>

export function buildPullInboxInput(params: {
  readonly repo: string
  readonly sourceId: string
  readonly pr: GhPull
  readonly action: 'opened' | 'reopened' | 'closed'
  readonly now: number
}): InboxEventInput {
  const repo = normalizeGithubRepo(params.repo)
  const merged = params.action === 'closed' && (params.pr.merged === true || Boolean(params.pr.merged_at))
  const eventAction = merged ? 'merged' : params.action
  const at = timestampMs(params.pr.merged_at ?? params.pr.closed_at ?? params.pr.updated_at ?? params.pr.created_at, params.now)
  const parts: string[] = []
  if (params.pr.head.sha) parts.push(`head ${params.pr.head.sha.slice(0, 10)}`)
  if (params.pr.base?.ref) parts.push(`→ ${params.pr.base.ref}`)
  if (merged) parts.push('merged')
  if (params.action === 'opened' && params.pr.body) parts.push(params.pr.body)
  const headRepo = params.pr.head.repo?.full_name ? params.pr.head.repo.full_name.toLowerCase() : undefined
  return {
    source: 'github',
    sourceId: params.sourceId,
    deliveryId: `gh-poll:${deterministicKey('github-pr', repo, String(params.pr.number), eventAction, params.pr.merged_at ?? params.pr.closed_at ?? params.pr.created_at ?? '')}`,
    type: `pull_request.${eventAction}`,
    subject: `${repo}#${params.pr.number}`,
    title: clipText(params.pr.title || `pull request ${eventAction}`, GITHUB_TITLE_MAX),
    actor: params.pr.user.login,
    url: params.pr.html_url,
    summary: clipText(parts.join(' · '), GITHUB_SUMMARY_MAX),
    receivedAt: at,
    headRef: params.pr.head.ref,
    ...(headRepo ? { headRepo } : {}),
    originSource: 'github-poll',
  }
}

export function agentPull(pr: GhPull, githubLogin: string | undefined, repo: string): boolean {
  if (!githubLogin) return false
  return sameName(pr.user.login, githubLogin) && sameName(pr.head.repo?.full_name, repo)
}

export interface PullClosureDeps {
  readonly links: readonly TaskLink[]
  readonly putLink: (link: TaskLink) => Promise<void>
  readonly change: (id: string) => ChangeRecord | undefined
  readonly runsForChange: (changeId: string) => readonly RunRecord[]
  readonly markClosureReady: (changeId: string, detail: { readonly ref: string; readonly outcome: 'merged' | 'closed'; readonly at: number }) => Promise<{ readonly ok: boolean; readonly updated?: boolean }>
  readonly emitResultNotice: (change: ChangeRecord, detail: { readonly ref: string; readonly outcome: 'merged' | 'closed'; readonly title?: string; readonly url?: string; readonly at: number }) => void
}

/**
 * Reconcile PR closure/merge (`pull_request.merged` or `pull_request.closed`) across
 * `links.ts` and linked non-terminal WorkBook Changes. Never triggers on `opened`,
 * never bypasses verification (`accept()`), and emits at most one `result` notice per Change.
 */
export async function observePullClosure(
  deps: PullClosureDeps,
  input: {
    readonly repo: string
    readonly number: number
    readonly outcome: 'merged' | 'closed'
    readonly title?: string
    readonly url?: string
    readonly at: number
    readonly event?: InboxRecord
  },
): Promise<{ readonly updatedLinks: number; readonly notifiedChanges: readonly string[] }> {
  const repo = normalizeGithubRepo(input.repo)
  const subject = `${repo}#${input.number}`
  const changedLinks = updateClosedLinks(deps.links, repo, input.number, input.outcome, input.at, input.event)
  for (const next of changedLinks) {
    await deps.putLink(next)
  }

  // Collect all unique changes linked to this PR (whether link already updated or just matched).
  const candidateChangeIds = new Set<string>()
  const probeRecord: Pick<InboxRecord, 'subject' | 'headRepo'> = { subject }
  for (const link of deps.links) {
    if (linkMatchesSubject(link, probeRecord)) candidateChangeIds.add(link.changeId)
  }
  for (const link of changedLinks) {
    candidateChangeIds.add(link.changeId)
  }

  const notifiedChanges: string[] = []
  for (const changeId of candidateChangeIds) {
    const change = deps.change(changeId)
    if (!change) continue
    const runs = deps.runsForChange(changeId)
    if (changeIsTerminal(change, runs)) continue
    const marked = await deps.markClosureReady(changeId, { ref: subject, outcome: input.outcome, at: input.at })
    if (marked.ok && marked.updated !== false) {
      deps.emitResultNotice(change, {
        ref: subject,
        outcome: input.outcome,
        ...(input.title ? { title: input.title } : {}),
        ...(input.url ? { url: input.url } : {}),
        at: input.at,
      })
      notifiedChanges.push(changeId)
    }
  }
  return { updatedLinks: changedLinks.length, notifiedChanges }
}

/** Auto-link an open PR to a Change when its branch matches the Change's isolated worktree branch. */
export async function autoLinkBranchPull(params: {
  readonly repo: string
  readonly pr: GhPull
  readonly changes: readonly ChangeRecord[]
  readonly existingLinks: readonly TaskLink[]
  readonly putLink: (link: TaskLink) => Promise<void>
  readonly at: number
  readonly event?: InboxRecord
}): Promise<number> {
  const repo = normalizeGithubRepo(params.repo)
  const headBranch = params.pr.head.ref
  const headRepo = params.pr.head.repo?.full_name?.toLowerCase()
  let linked = 0
  for (const change of params.changes) {
    const branch = change.isolation?.kind === 'worktree' ? change.isolation.branch : undefined
    if (!branch || branch !== headBranch) continue
    const base = makeTaskLink(change.id, { repo, number: params.pr.number, url: params.pr.html_url }, 'auto', params.at)
    if (params.existingLinks.some(row => row.id === base.id)) continue
    const enriched = params.event ? (applyLinkEvent(base, params.event, params.at) ?? base) : base
    const withBranch: TaskLink = {
      ...enriched,
      branch: headBranch,
      ...(headRepo ? { headRepo } : {}),
    }
    await params.putLink(withBranch)
    linked += 1
  }
  return linked
}
