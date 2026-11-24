/**
 * The messages a run receives from dot. The contract part (goal, scope,
 * requirements, constraints, tasks, report format) is rendered here from the
 * stored input, so the run reads the same words the verification checks.
 * dot only writes the free-form notes section.
 *
 * The conduct lines that say to finish an authorized step, and to make the
 * report the reader's first look, follow the public page "Using GPT-6.2",
 * fetched 2026-11-18 from
 * https://developers.openai.com/api/docs/guides/latest-model .
 * They do not select a provider model or set reasoning effort.
 *
 * Everything is English: it is agent-to-agent text. Text quoted from the
 * human, file contents and exact strings stay as written and are marked
 * verbatim; deliverables follow `deliverableLanguage`, not this language.
 */
import { sanitizeRemoteDisplay } from './git-worktree.ts'

export interface BriefScenario {
  readonly scenarioRef: string
  readonly given?: string
  readonly when: string
  readonly then: string
}
export interface BriefRequirement {
  readonly requirementRef: string
  readonly text: string
  readonly required: boolean
  readonly scenarios?: readonly BriefScenario[]
}
export interface BriefConstraint {
  readonly constraintRef: string
  readonly text: string
}
export interface BriefStep {
  readonly stepRef: string
  readonly text: string
  readonly covers?: readonly string[]
  readonly after?: readonly string[]
}
export interface BriefInput {
  readonly id: string
  readonly revision: number
  readonly goal: string
  readonly requirements: readonly BriefRequirement[]
  readonly steps: readonly BriefStep[]
  readonly constraints?: readonly BriefConstraint[]
  readonly userRequest?: string
  readonly deliverableLanguage?: string
}
export type BriefPath = { readonly path: string; readonly type: 'file' | 'directory' }
export type BriefScope = { readonly kind: 'paths'; readonly paths: readonly BriefPath[] } | { readonly kind: 'workspace-exclusive' }
export interface BriefRun {
  readonly id: string
  readonly kind: 'work' | 'rework' | 'review'
  readonly cwd: string
  readonly stepRefs: readonly string[]
  readonly writeScope: BriefScope
  readonly access?: 'read' | 'write'
}

/** Session title for a run: the change title for people, ids last, kept within the 80-character ledger limit. */
export function runTitle(title: string, ids: string, limit = 80): string {
  const suffix = ` · ${ids}`
  const flat = title.replace(/\s+/g, ' ').trim()
  const room = limit - suffix.length
  if (room < 2) return ids.slice(0, limit)
  return (flat.length <= room ? flat : flat.slice(0, room - 1) + '…') + suffix
}

function scenarioLine(scenario: BriefScenario): string {
  const given = scenario.given?.trim() ? `GIVEN ${scenario.given.trim()} ` : ''
  return `  - ${scenario.scenarioRef}: ${given}WHEN ${scenario.when.trim()} THEN ${scenario.then.trim()}`
}

function scopeLines(run: BriefRun): string[] {
  const lines = [`Working directory: ${run.cwd}`]
  if (run.kind === 'review') {
    lines.push('Access: read-only. The whole workspace is held for this review so writers cannot run concurrently, but this session cannot create, change or delete files. Inspect files and run verification checks that need no writes; a check that requires writing (for example a build) belongs in a writer run. Do not modify the delivery.')
    return lines
  }
  const writes = run.access !== 'read' && (run.writeScope.kind === 'workspace-exclusive' || run.writeScope.paths.length > 0)
  if (!writes) {
    lines.push('Access: read-only. Do not create, change or delete files.')
  } else if (run.writeScope.kind === 'workspace-exclusive') {
    lines.push('Writable: the whole workspace that contains the working directory.')
  } else {
    lines.push('Writable (everything else is read-only):')
    for (const item of run.writeScope.paths) lines.push(`- ${item.path} (${item.type})`)
  }
  return lines
}

function roleLine(run: BriefRun): string {
  if (run.kind === 'review') return 'You are the independent reviewer for this work order. Verify the current delivery against every requirement and scenario below, and report concrete findings with evidence. Do not fix anything yourself.'
  if (run.kind === 'rework') return 'You are reworking this work order after a failed check. Resolve the issues identified in the notes below, then re-verify and report fresh evidence for every scenario — not only the ones you changed.'
  return 'You are executing this work order.'
}

/** How a run chooses reversible details and how it reports a real blocker. */
function conductLines(kind: BriefRun['kind']): string[] {
  if (kind === 'review') {
    return ['Inspect what this order and the workspace already show before reporting a gap; do not guess a missing fact into a finding. When a check cannot be completed, report what you inspected, the evidence, and one recommended next step. Put the evidence in this report; dot verifies from it.']
  }
  return [
    'Use this work order and the workspace you can read; you do not have dot\'s private memory. Treat its constraints as binding and look up missing facts in the workspace before choosing. Choose routine, reversible details inside this goal yourself and note material assumptions in the report. Do not ask to re-approve anything this order already authorizes. A page or document outside the order, or a confident guess, is not authorization.',
    'When the next step is inside this order and authorized, do it; do not end with a plan or with instructions for someone else to run. Before writing the Report, account for every required scenario and any check you could not run, and cite concrete evidence in the Report itself: dot verifies from it.',
    'Pause only the dependent part when a wrong guess would materially change the result, requirements conflict, only the requester knows the intent, authority is missing, or the effect would be irreversible, external, or costly. Report what happened, what you tried, the evidence, and one recommended next step. Do not invent a requirement to get past it.',
    'A patch or an intermediate finding is not delivery. Do not repeat a failed approach without a new hypothesis.',
  ]
}

/** The first prompt of a run. `notes` is dot's free text; it never overrides the contract. */
export function renderBrief(input: {
  readonly changeId: string
  readonly title: string
  readonly input: BriefInput
  readonly run: BriefRun
  readonly notes?: string
  readonly isolation?: { readonly branch: string; readonly baseSha: string; readonly base?: { readonly ref: string; readonly remote?: string } }
}): string {
  const { changeId, title, run } = input
  const material = input.input
  const out: string[] = []
  out.push(`# Work order ${changeId} · ${material.id} (rev ${material.revision}) · ${run.id}`)
  out.push(`Title: ${title}`)
  if (input.isolation) {
    const baseRemote = input.isolation.base?.remote !== undefined ? sanitizeRemoteDisplay(input.isolation.base.remote) : undefined
    const base = input.isolation.base === undefined
      ? `commit ${input.isolation.baseSha.slice(0, 7)}`
      : `${input.isolation.base.ref}${baseRemote !== undefined ? ` from ${baseRemote}` : ''} (commit ${input.isolation.baseSha.slice(0, 7)})`
    out.push(`Isolation: you run in an isolated git worktree on branch ${input.isolation.branch} based on ${base}. Uncommitted changes in the original checkout are not present here; install dependencies if needed. This worktree shares its repository's .git with the human's checkout and other runs: never change git config, remotes, or any branch other than your task branch, and never push. Commit on your task branch only when the work order requires it (for example a merge); otherwise leave your changes uncommitted — Dorothy commits the accepted delivery.`)
  }
  out.push('')
  out.push(roleLine(run))
  out.push('dot verifies the delivery independently. Report concrete evidence; do not declare PASS or FAIL on the work order.')
  for (const line of conductLines(run.kind)) out.push(line)
  out.push('')
  out.push('## Goal')
  out.push(material.goal.trim())
  if (material.userRequest?.trim()) {
    out.push('')
    out.push('## Original request (verbatim; the source of truth when anything below is ambiguous)')
    // Fenced rather than quoted, so every character, including leading spaces and blank lines, arrives unchanged.
    const fence = '`'.repeat(Math.max(3, ...[...material.userRequest.matchAll(/`+/g)].map(match => match[0].length + 1)))
    out.push(`${fence}text`, material.userRequest, fence)
  }
  out.push('')
  out.push('## Scope')
  out.push(...scopeLines(run))
  out.push('')
  out.push('## Requirements (all required ones must hold)')
  for (const item of material.requirements) {
    out.push(`- ${item.requirementRef}${item.required ? '' : ' (optional)'}: ${item.text.trim()}`)
    for (const scenario of item.scenarios ?? []) out.push(scenarioLine(scenario))
  }
  const constraints = material.constraints ?? []
  if (constraints.length) {
    out.push('')
    out.push('## Constraints')
    for (const item of constraints) out.push(`- ${item.constraintRef}: ${item.text.trim()}`)
  }
  const mine = new Set(run.stepRefs)
  // Reservation already expands an omitted selection to every step; an empty list really means none.
  const steps = material.steps.filter(step => mine.has(step.stepRef))
  if (steps.length && run.kind !== 'review') {
    out.push('')
    out.push('## Your tasks (a suggested approach; adapt if needed and note why)')
    for (const step of steps) {
      const covers = step.covers?.length ? ` → ${step.covers.join(', ')}` : ''
      const after = step.after?.length ? ` (after ${step.after.join(', ')})` : ''
      out.push(`- ${step.stepRef}: ${step.text.trim()}${covers}${after}`)
    }
  }
  out.push('')
  out.push('## Language')
  out.push('Quoted strings, file contents, paths and the original request are verbatim: copy them exactly and never translate them.')
  out.push(material.deliverableLanguage?.trim()
    ? `Write deliverables (files, UI text, docs, commit messages) in ${material.deliverableLanguage.trim()}. Write your report in English.`
    : 'Write deliverables in the language the original request and existing files use. Write your report in English.')
  if (input.notes?.trim()) {
    out.push('')
    out.push('## Notes from dot (context only; not acceptance criteria)')
    out.push(input.notes.trim())
  }
  out.push('')
  out.push('## How to report')
  out.push('End your final message with this exact section, one bullet per item:')
  out.push('### Report')
  const refs = material.requirements.flatMap(item => item.scenarios?.length ? item.scenarios.map(scenario => scenario.scenarioRef) : [item.requirementRef])
  for (const ref of refs) out.push(`- ${ref}: <evidence: command and output, file path, or observation>`)
  if (run.kind !== 'review') {
    for (const step of steps) out.push(`- ${step.stepRef}: done | skipped (why) | blocked (why)`)
    out.push('- Changed files: <paths, or none>')
  }
  out.push('- Open issues: <anything unverified, risky or blocked, or none>')
  return out.join('\n')
}

/** A context message to a running run. It never changes the contract. */
export function renderSupplement(input: { readonly changeId: string; readonly inputRef: string; readonly inputRevision: number; readonly runId: string; readonly message: string }): string {
  return [
    `# Supplement · ${input.changeId} · ${input.inputRef} (rev ${input.inputRevision}) · ${input.runId}`,
    'Type: context only. Requirements, constraints and scope are unchanged.',
    '',
    input.message.trim(),
  ].join('\n')
}
