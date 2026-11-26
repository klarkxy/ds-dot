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
  readonly supplementWorkRun: (runId: string, text: string, senderId: string, expected: { readonly inputRef: string; readonly inputRevision: number }) => Promise<{ readonly ok: boolean }>
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
  readonly directRunIds: readonly string[]
  readonly skippedStoppedRunIds: readonly string[]
  readonly closureNotifiedChanges: readonly string[]
}

const PR_CLOSURE_RE = /^pull_request\.(merged|closed)$/
const PR_SUBJECT_RE = /^([^#\s]+)#(\d+)$/

/**
 * Bridges polled GitHub events into ds-dot's Fast-Path admission matrix,
 * many-to-many active-run `supplementWorkRun` delivery, stopped/finished guards,
 * `submitInbox` audit/intake, Webhook<->Poll handoff dedupe, and PR closure.
 */
export class GithubPollSourceAdapter {
  constructor(private readonly deps: SourceAdapterDeps) {}

  private alreadyDeliveredDuringHandoff(repo: string, event: InboxEventInput): boolean {
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
      return { action: 'ignore', directRunIds: [], skippedStoppedRunIds: [], closureNotifiedChanges: [] }
    }

    if (this.alreadyDeliveredDuringHandoff(repo, event)) {
      return { action: 'deduped-handoff', directRunIds: [], skippedStoppedRunIds: [], closureNotifiedChanges: [] }
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
      return { action: 'ignore', directRunIds: [], skippedStoppedRunIds: [], closureNotifiedChanges: [] }
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

    // Bots and CI never wake finished runs; user-stopped runs receive ZERO subsequent messages.
    const isBotOrCi = senderClass !== 'human' || eventType === 'ci'
    const allowDirectToActive = (eventType === 'comment' || eventType === 'review') && (senderClass === 'human' || admission === 'context-only')
    const directTargets = allowDirectToActive ? activeTargets : []

    const inlineSpill = formatInlineAndSpill({
      event,
      ...(ctx.rawBody !== undefined ? { rawBody: ctx.rawBody } : {}),
      ...(ctx.directContext !== undefined ? { directContext: ctx.directContext } : {}),
      linkedChangeIds,
      linkedRunIds: directTargets.map(item => item.run.id),
      homeDir: this.deps.homeDir,
    })

    const directRunIds: string[] = []
    const senderId = this.deps.dotSessionId() ?? 'github-poll'
    for (const { run } of directTargets) {
      if (runStoppedByUser(run)) continue
      const res = await this.deps.supplementWorkRun(run.id, inlineSpill.supplementText, senderId, {
        inputRef: run.inputRef,
        inputRevision: run.inputRevision,
      }).catch(() => ({ ok: false }))
      if (res.ok) {
        directRunIds.push(run.id)
      }
    }
    if (directRunIds.length > 0) {
      this.deps.trace?.('github-poll.direct-delivered', `Supplemented ${directRunIds.length} active run(s).`, {
        repo,
        subject: event.subject,
        count: directRunIds.length,
      })
    }

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
    const shouldSubmitInbox = admission === 'inbox' && (!threadOnlyHasUserStoppedRuns || Boolean(closureMatch))

    if (shouldSubmitInbox) {
      const auditTag = directRunIds.length > 0 ? ` [direct-delivered to ${directRunIds.join(', ')}]` : ''
      const readTag = inlineSpill.spillRelPath ? ` [read: ${inlineSpill.spillRelPath}]` : ''
      const summary = clipText(`${inlineSpill.inboxSummary}${auditTag}${readTag}`, GITHUB_SUMMARY_MAX)
      inboxResult = await this.deps.submitInbox({
        ...event,
        summary,
        originSource: 'github-poll',
      })
      await this.deps.cursorStore.recordDelivery(repo, 'poll', event.receivedAt || now)
    } else if (directRunIds.length > 0) {
      await this.deps.cursorStore.recordDelivery(repo, 'poll', event.receivedAt || now)
    } else if (isBotOrCi && !hasNonStoppedFinishedRun && linkedChangeIds.length > 0 && admission === 'context-only') {
      // Context-only bot/CI event on finished runs has no active run to receive it -> dropped quietly.
    }

    return {
      action: admission,
      ...(inboxResult ? { inboxResult } : {}),
      directRunIds,
      skippedStoppedRunIds,
      closureNotifiedChanges,
    }
  }
}
