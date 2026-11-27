// Adapted from deepseek-ai/dsh-superagent-prototype@8c32a9d (MIT).
import { z } from 'zod'
import type { GhCli } from './gh-cli.ts'
import { CommentSchema, type GhComment } from './triggers.ts'

export const FAILING_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'error',
])

export const CheckRunSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().min(1),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  details_url: z.string().nullable().optional(),
}).loose()

export const CommitStatusSchema = z.object({
  context: z.string().min(1),
  state: z.string(),
  target_url: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
}).loose()

export type GhCheckRun = z.infer<typeof CheckRunSchema>
export type GhCommitStatus = z.infer<typeof CommitStatusSchema>

export interface CheckSnapshot {
  readonly sha: string
  readonly checkRuns: readonly GhCheckRun[]
  readonly statuses: readonly GhCommitStatus[]
}

const CheckRunsResponseSchema = z.object({
  check_runs: z.array(CheckRunSchema),
}).loose()

/**
 * Fetch check runs and commit statuses for a commit SHA, deduplicating commit
 * statuses to the first (latest) status per `context` and sorting deterministically.
 */
export async function pullChecks(
  cli: GhCli,
  repo: string,
  headSha: string,
  tally?: { skipped: number },
  signal?: AbortSignal,
): Promise<CheckSnapshot> {
  const checkRunsPayload = await cli.repoApi(CheckRunsResponseSchema, repo, `commits/${headSha}/check-runs?per_page=100`, [], signal)
  let statusesRaw: readonly GhCommitStatus[] = []
  try {
    statusesRaw = await cli.repoPages(CommitStatusSchema, repo, `commits/${headSha}/statuses?per_page=100`, tally, signal)
  } catch {
    statusesRaw = []
  }
  const latestStatuses = new Map<string, GhCommitStatus>()
  for (const status of statusesRaw) {
    if (!latestStatuses.has(status.context)) latestStatuses.set(status.context, status)
  }
  const checkRuns = [...checkRunsPayload.check_runs].sort((a, b) => a.name.localeCompare(b.name))
  const statuses = [...latestStatuses.values()].sort((a, b) => a.context.localeCompare(b.context))
  return { sha: headSha, checkRuns, statuses }
}

export function ciCounts(snapshot: CheckSnapshot): { readonly total: number; readonly failed: number; readonly running: number } {
  let failed = 0
  let running = 0
  for (const run of snapshot.checkRuns) {
    if (run.status && run.status !== 'completed') running += 1
    else if (run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion.toLowerCase())) failed += 1
  }
  for (const status of snapshot.statuses) {
    const state = status.state.toLowerCase()
    if (state === 'pending') running += 1
    else if (FAILING_CONCLUSIONS.has(state)) failed += 1
  }
  return { total: snapshot.checkRuns.length + snapshot.statuses.length, failed, running }
}

export function ciFailures(snapshot: CheckSnapshot): string[] {
  const names = new Set<string>()
  for (const run of snapshot.checkRuns) {
    if ((!run.status || run.status === 'completed') && run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion.toLowerCase())) {
      names.add(run.name)
    }
  }
  for (const status of snapshot.statuses) {
    if (FAILING_CONCLUSIONS.has(status.state.toLowerCase())) {
      names.add(status.context)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

export function ciSummary(snapshot: CheckSnapshot, where: string, readPointer?: string): string {
  const counts = ciCounts(snapshot)
  const failed = ciFailures(snapshot)
  const sha7 = snapshot.sha.slice(0, 7)
  if (failed.length > 0) {
    const shown = failed.slice(0, 5).join(', ')
    const extra = failed.length > 5 ? `, and ${failed.length - 5} more` : ''
    const runningSuffix = counts.running > 0 ? `; ${counts.running} still running` : ''
    const line1 = `CI failed ${counts.failed}/${counts.total} on ${where} at ${sha7}: ${shown}${extra}${runningSuffix}`
    return readPointer ? `${line1}\nRead ${readPointer} for every check.` : line1
  }
  if (counts.running > 0) return `CI running (${counts.running}/${counts.total}) on ${where} at ${sha7}`
  return `CI passed (${counts.total}/${counts.total}) on ${where} at ${sha7}`
}

/**
 * Read a PR review comment thread in chronological order so direct context can
 * include the replied-to root / adjacent comment.
 */
export async function reviewThread(
  cli: GhCli,
  repo: string,
  prNumber: number,
  commentId: number,
  tally?: { skipped: number },
  signal?: AbortSignal,
): Promise<GhComment[]> {
  const comments = await cli.repoPages(CommentSchema, repo, `pulls/${prNumber}/comments?per_page=100`, tally, signal)
  const target = comments.find(c => c.id === commentId)
  const rootId = target?.in_reply_to_id ?? commentId
  return comments
    .filter(c => c.id === rootId || c.in_reply_to_id === rootId)
    .sort((a, b) => Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? '') || a.id - b.id)
}
