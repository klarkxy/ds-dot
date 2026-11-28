// Adapted from deepseek-ai/dsh-superagent-prototype@8c32a9d (MIT).
import type { GithubPollSettings, InboxEventInput, InboxRecord, InboxSubmitResult, TaskLink } from '../contracts.ts'
import { linkMatchesSubject } from '../links.ts'
import { normalizeGithubRepo } from '../settings.ts'
import { changeIsTerminal, runStoppedByUser, type ChangeRecord, type RunRecord } from '../work.ts'
import { classifyGithubSender, formatInlineAndSpill, resolveGithubAdmission, toGithubEventType } from './admission.ts'
import type { GithubPollCursorStore } from './cursor-store.ts'
import { observePullClosure } from './pull-lifecycle.ts'
import { GITHUB_SUMMARY_MAX, clipText, sameName } from './triggers.ts'

export interface SourceAdapterDeps {
  readonly settings: () => GithubPollSettings
  readonly cursorStore: GithubPollCursorStore
  readonly homeDir: string
  readonly links: () => readonly TaskLink[]
  readonly putLink: (link: TaskLink) => Promise<void>
  readonly change: (id: string) => ChangeRecord | undefined
  readonly runsForChange: (changeId: string) => readonly RunRecord[]
  readonly markClosureReady: (changeId: string, detail: { readonly ref: string; readonly outcome: 'merged' | 'closed'; readonly at: number }) => Promise<{ readonly ok: boolean; readonly updated?: boolean }>
  readonly emitResultNotice: (change: ChangeRecord, detail: { readonly ref: string; readonly outcome: 'merged' | 'closed'; readonly title?: string; readonly url?: string; readonly at: number }) => void
  readonly inboxList: () => readonly InboxRecord[]
  readonly submitInbox: (event: InboxEventInput) => Promise<InboxSubmitResult>
  readonly dotSessionId: () => string | undefined
  readonly trace?: (event: string, message: string, data?: Record<string, string | number | boolean>) => void
  readonly now: () => number
}

export interface AdmitEventContext {
  readonly repo: string
  readonly rawBody?: string
  readonly directContext?: string
  readonly senderType?: string
  readonly ciRelevant?: boolean
}

export interface AdmitEventOutcome {
  readonly action: 'inbox' | 'context-only' | 'ignore' | 'deduped-handoff'
  readonly inboxResult?: InboxSubmitResult
  readonly skippedStoppedRunIds: readonly string[]
  readonly closureNotifiedChanges: readonly string[]
}

const PR_CLOSURE_RE = /^pull_request\.(merged|closed)$/
const PR_SUBJECT_RE = /^([^#\s]+)#(\d+)$/

/**
 * Bridges polled GitHub events into ds-dot's Fast-Path admission matrix,
 * stopped/finished guards, quiet/inbox submission, Webhook<->Poll handoff
 * dedupe, and PR closure. External events never enter a running task directly.
 */
export class GithubPollSourceAdapter {
  constructor(private readonly deps: SourceAdapterDeps) {}

  private alreadyDeliveredDuringHandoff(repo: string, event: InboxEventInput): boolean {
    if (this.deps.cursorStore.hasDelivered(repo, event.deliveryId, this.deps.now())) {
      return true
    }
    const repoState = this.deps.cursorStore.getRepoState(repo)
    if (repoState?.lastDeliveredAt !== undefined && event.receivedAt > 0 && event.receivedAt < repoState.lastDeliveredAt) {
      return true
    }
    const existing = this.deps.inboxList()
    for (const row of existing) {
      if (row.source !== event.source || row.sourceId !== event.sourceId) continue
      if (row.deliveryIds.includes(event.deliveryId)) return true
      if (
        row.subject === event.subject
        && row.type === event.type
        && sameName(row.actor, event.actor)
        && ((event.url && row.url === event.url) || (row.receivedAt === event.receivedAt && row.title === event.title))
      ) {
        return true
      }
    }
    return false
  }

  async receive(event: InboxEventInput, ctx: AdmitEventContext): Promise<AdmitEventOutcome> {
    const settings = this.deps.settings()
    const repo = normalizeGithubRepo(ctx.repo)
    const now = this.deps.now()

    // Single-repo mutual exclusion runtime guard: webhook repos are never admitted via poll.
    if (settings.webhookRepos.includes(repo)) {
      return { action: 'ignore', skippedStoppedRunIds: [], closureNotifiedChanges: [] }
    }

    if (this.alreadyDeliveredDuringHandoff(repo, event)) {
      return { action: 'deduped-handoff', skippedStoppedRunIds: [], closureNotifiedChanges: [] }
    }

    const eventType = toGithubEventType(event.type) ?? 'issue'
    const senderClass = classifyGithubSender(event.actor, ctx.senderType, settings.ignoredActors)
    const admission = resolveGithubAdmission(settings, repo, eventType, senderClass, { ciRelevant: ctx.ciRelevant })
    this.deps.trace?.('github-poll.admitted', `Admission=${admission} for ${event.subject}`, {
      repo,
      type: event.type,
      senderClass,
      admission,
    })

    if (admission === 'ignore') {
      return { action: 'ignore', skippedStoppedRunIds: [], closureNotifiedChanges: [] }
    }

    const matchedLinks = this.deps.links().filter(link => linkMatchesSubject(link, event))
    const linkedChangeIds = [...new Set(matchedLinks.map(link => link.changeId))]

    const activeTargets: Array<{ change: ChangeRecord; run: RunRecord }> = []
    const skippedStoppedRunIds: string[] = []
    let hasNonStoppedFinishedRun = false
    let hasUserStoppedRun = false

    for (const changeId of linkedChangeIds) {
      const change = this.deps.change(changeId)
      if (!change) continue
      const runs = this.deps.runsForChange(changeId)
      const terminalChange = changeIsTerminal(change, runs)
      for (const run of runs) {
        if (runStoppedByUser(run, change)) {
          hasUserStoppedRun = true
          skippedStoppedRunIds.push(run.id)
          continue
        }
        if (run.phase === 'active' && !terminalChange) {
          activeTargets.push({ change, run })
        } else if (run.phase === 'completed' || run.phase === 'failed') {
          hasNonStoppedFinishedRun = true
        }
      }
    }

    // User-stopped runs receive ZERO subsequent messages; finished/active classification
    // still decides whether a thread follow-up is worth inboxing at all.
    const inlineSpill = formatInlineAndSpill({
      event,
      ...(ctx.rawBody !== undefined ? { rawBody: ctx.rawBody } : {}),
      ...(ctx.directContext !== undefined ? { directContext: ctx.directContext } : {}),
      homeDir: this.deps.homeDir,
    })

    // PR merged/closed settlement (from poll)
    let closureNotifiedChanges: readonly string[] = []
    const closureMatch = PR_CLOSURE_RE.exec(event.type)
    if (closureMatch) {
      const prMatch = PR_SUBJECT_RE.exec(event.subject)
      if (prMatch) {
        const outcome = closureMatch[1] as 'merged' | 'closed'
        const closure = await observePullClosure({
          links: this.deps.links(),
          putLink: this.deps.putLink,
          change: this.deps.change,
          runsForChange: this.deps.runsForChange,
          markClosureReady: this.deps.markClosureReady,
          emitResultNotice: this.deps.emitResultNotice,
        }, {
          repo,
          number: Number(prMatch[2]),
          outcome,
          title: event.title,
          ...(event.url ? { url: event.url } : {}),
          at: event.receivedAt || now,
        })
        closureNotifiedChanges = closure.notifiedChanges
      }
    }

    let inboxResult: InboxSubmitResult | undefined
    // If all linked runs on this thread were user-stopped and there are no active or finished-non-stopped runs,
    // do not wake or deliver follow-ups for the stopped runs.
    const threadOnlyHasUserStoppedRuns = linkedChangeIds.length > 0 && hasUserStoppedRun && activeTargets.length === 0 && !hasNonStoppedFinishedRun
    const contextOnlySubmits = admission === 'context-only' && (activeTargets.length > 0 || Boolean(closureMatch))
    const shouldSubmitInbox = (admission === 'inbox' || contextOnlySubmits) && (!threadOnlyHasUserStoppedRuns || Boolean(closureMatch))

    if (shouldSubmitInbox) {
      const readTag = inlineSpill.spillRelPath ? ` [read: ${inlineSpill.spillRelPath}]` : ''
      const tags = readTag
      let summary: string
      if (!tags) {
        summary = inlineSpill.inboxSummary
      } else if (tags.length >= GITHUB_SUMMARY_MAX) {
        summary = clipText(tags, GITHUB_SUMMARY_MAX)
      } else {
        const bodyBudget = GITHUB_SUMMARY_MAX - tags.length
        const bodyPart = bodyBudget >= 2 ? clipText(inlineSpill.inboxSummary, bodyBudget) : ''
        summary = bodyPart ? `${bodyPart}${tags}` : tags.trimStart()
      }
      inboxResult = await this.deps.submitInbox({
        ...event,
        summary,
        ...(admission === 'context-only' ? { quiet: true as const } : {}),
        originSource: 'github-poll',
      })
      await this.deps.cursorStore.recordDelivery(repo, 'poll', event.receivedAt || now, event.deliveryId, now)
    }

    return {
      action: admission,
      ...(inboxResult ? { inboxResult } : {}),
      skippedStoppedRunIds,
      closureNotifiedChanges,
    }
  }
}
