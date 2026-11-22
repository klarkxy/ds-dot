/**
 * Preset child plugin: dot's model tools. It loads as one row of the dot
 * preset, so only dot's agent sees these tools; ordinary sessions never get
 * them. The orchestration lives in the root `dot` service.
 *
 * All tool parameter schemas are intentionally flat (plain object + scalar /
 * enum fields only). No oneOf / anyOf / allOf / const / union types are used
 * because bridge channels (e.g. Gemini function calling) silently drop tools
 * that contain non-compliant schemas.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkShownView } from '@klarkxy/dsh-deep-view/core'
import type { ShownView } from '@klarkxy/dsh-deep-view/contracts'
import { SHOW_VIEW_DEFERRED_META, SHOW_VIEW_MIXED_SUMMARY, showViewSharesStep, type StepTranscript } from './card-step.ts'
import { cardPresentation, type DotCardMeta } from './cards.ts'
import { SERVICE_NAME, TOOL } from './contracts.ts'
import { personaSection } from './persona.ts'
import { settingsSnapshotBlock, type SelfSettings } from './self-settings.ts'
import { DotError, messageOf, type DotService } from './service.ts'
import { DEV_INDEX_TOOLS, installDotDevIndex } from './dev-index-scope.ts'
import { gateToolExecution } from './tool-scope.ts'
import { installDotWeb } from './web-scope.ts'
import { toolDisplay } from './chat-format.ts'

/** Host tool names from `@deepseek-ai/dsh-tool-web` (0.2.2-rc.1). Absent names are not an error. */
export const HOST_WEB_TOOLS = ['web_search', 'web_fetch'] as const
export { DEV_INDEX_TOOLS }
export const DOT_INHERITED_ALLOW = [...Object.values(TOOL), 'show_view', ...HOST_WEB_TOOLS, ...DEV_INDEX_TOOLS]

export const name = 'dsh-dot-tools'
export const inject = ['tools', 'systemPrompt', SERVICE_NAME] as const

/** Resolves once the optional dsh-dev-index row has loaded, failed, or been disposed.
 * The agent-scope restriction in host.ts awaits this, because `tools.restrict`
 * keeps a snapshot of the allow list: names registered after the call would
 * stay hidden even though they are on DOT_INHERITED_ALLOW. */
let devIndexLoad: Promise<void> = Promise.resolve()
export const dotDevIndexReady = (): Promise<void> => devIndexLoad

/** Right after the fixed instructions in the persona prefix (order 0). */
const PERSONA_ORDER = 1
/** The human's own standing requirements, between who dot is and what it has come to understand. */
const AGREEMENTS_ORDER = 2
/** dot's own understanding of the human and of working with them. */
const COGNITION_ORDER = 3
/** What the segment was handed from the conversation before it. */
const HANDOFF_ORDER = 4
/** Last of the frozen blocks: the settings snapshot reads live so a change takes effect at once. */
const SETTINGS_SNAPSHOT_ORDER = 5

/** The part of an assembly context these sections read: the agent the prompt is built for. */
interface AssemblyContext { readonly agent?: { readonly session?: { readonly id?: string } } }

/** defineTool's input, kept opaque: its generic inference is too deep for these JSON schemas. */
type ToolInput = Record<string, unknown>

/**
 * The card-writing part of the root dot service (implemented in service.ts).
 * It registers a valid card and returns the presentation meta to persist.
 */
interface CardService {
  presentCard(shown: ShownView, callId: string, approvalId?: string): Promise<DotCardMeta>
}

type ToolHost = Context
  & { tools: { register(definition: unknown): () => void } }
  & { systemPrompt: { section(section: { name: string; order: number; text: (context?: AssemblyContext) => string; interpolate?: boolean }): () => void } }
  & Record<typeof SERVICE_NAME, DotService>
  & { _selfSettings?: SelfSettings }

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const str = (args: unknown, key: string): string | undefined => {
  const value = (args as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : undefined
}

const num = (args: unknown, key: string): number | undefined => {
  const value = (args as Record<string, unknown> | null)?.[key]
  return typeof value === 'number' ? value : undefined
}

const bool = (args: unknown, key: string): boolean =>
  (args as Record<string, unknown> | null)?.[key] === true

export const TASK_ACTIONS = ['create', 'revise', 'dispatch', 'check', 'read', 'list', 'supplement', 'finish', 'step', 'closeout', 'pause', 'resume', 'cancel', 'decide', 'reject'] as const

export function apply(ctx: Context): void {
  installDotWeb(ctx)
  const host = ctx as ToolHost
  const dot = () => host[SERVICE_NAME]
  // Names outside the locked set go to the capability layer: granted extras pass
  // while still granted and applied to the live segment; everything else denies.
  gateToolExecution(ctx, DOT_INHERITED_ALLOW, exec => dot().capabilityGate(exec))
  devIndexLoad = installDotDevIndex(ctx)
  // Both sections read what the segment froze when it started, so every request of a segment
  // shares one prompt prefix; a settings edit reaches dot with her next segment. A session
  // that is not the recorded segment (one being set up) reads the live settings.
  const segmentOf = (context?: AssemblyContext) => {
    const segment = dot().store.segment
    const id = context?.agent?.session?.id
    return segment && (id === undefined || id === segment.sessionId) ? segment : undefined
  }
  ctx.effect(() => host.systemPrompt.section({ name: 'dsh-dot:persona', order: PERSONA_ORDER, interpolate: false, text: context => segmentOf(context)?.persona ?? personaSection(dot().store.settings, dot().locale ?? 'zh') }))
  // The human's own requirements, as they read when the segment started; empty while there are none.
  ctx.effect(() => host.systemPrompt.section({ name: 'dsh-dot:agreements', order: AGREEMENTS_ORDER, interpolate: false, text: context => { const segment = segmentOf(context); return segment ? segment.agreements ?? '' : dot().currentAgreementsBlock() } }))
  // dot's own understanding, as it read when the segment started; empty while dot has written none.
  ctx.effect(() => host.systemPrompt.section({ name: 'dsh-dot:cognition', order: COGNITION_ORDER, interpolate: false, text: context => { const segment = segmentOf(context); return segment ? segment.cognition ?? '' : dot().currentCognitionBlock() } }))
  // Empty in dot's very first segment; the host drops empty sections.
  ctx.effect(() => host.systemPrompt.section({ name: 'dsh-dot:handoff', order: HANDOFF_ORDER, interpolate: false, text: context => segmentOf(context)?.opening ?? '' }))
  // Core hard-switch state: always reads live settings so a change takes effect immediately.
  ctx.effect(() => host.systemPrompt.section({ name: 'dsh-dot:settings-snapshot', order: SETTINGS_SNAPSHOT_ORDER, interpolate: false, text: () => settingsSnapshotBlock(dot().store.settings) }))

  // Attach hostEffect after defineTool: the standard host drops unknown options.
  const tool = (definition: ToolInput, readOnly = false) => {
    const made = (defineTool as unknown as (input: ToolInput) => Record<string, unknown>)(definition)
    ctx.effect(() => host.tools.register(readOnly ? { ...made, hostEffect: 'read-only' as const } : made))
  }

  // ── show_view (dot scope, single-step) ────────────────────────────────────
  // Same name as dsh-deep-view's global tool. A preset row registers into the
  // agent scope, and a scoped registration shadows the global one, so only dot
  // gets this variant: a valid card that is the step's only call concludes
  // the turn. A card sent beside another tool is refused before it is shown,
  // and the turn stays open so those calls can finish. Ordinary sessions keep
  // deep-view's two-step show_view untouched.
  tool({
    name: 'show_view',
    description: [
      'Show the human a card. Use it only when structure or interaction helps: a table, metrics, a chart, progress, steps, or sources; a choice, confirmation, or form you need answered (set await_reply=true); or relaying a pending approval (pass its request id as approval_id so the host renders bound controls). Ordinary replies are plain text, not cards.',
      'Call show_view alone in its own step after all other tool results are in; a valid card ends the turn. If it shares a step with another tool call, the card is deferred and the turn stays open: wait for those results, then call show_view by itself. If validation fails, fix the JSON and call show_view again.',
      'view is JSON text for one root ViewNode, and every node needs a "type" field. Layout: stack, row (children, optional let). Display: text, metric{label,value}, table{columns,rows}, chart{kind,categories,series}, progress{percent|value+max}, callout{text}, sources{items}, steps{items}; rich: math, flow, explore, map. Reactive inputs: slider, number, choice, toggle. Answer controls: options, confirm, form.',
    ].join(' '),
    parameters: {
      title: { type: 'string', description: 'Concise heading shown above the card.' },
      view: { type: 'string', required: true, description: 'JSON string of one root ViewNode. Every node requires a "type" field; nest multiple nodes under stack or row children.' },
      await_reply: { type: 'boolean', description: 'Set true only when the card contains interactive answer controls (options/confirm/form); omit or set false for display cards.' },
      approval_id: { type: 'string', description: 'Exact pending approval id when relaying an approval to the human; the host binds and renders the confirmation controls.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          summary: { type: 'string' },
          presentation: { type: 'object', additionalProperties: true },
        },
        additionalProperties: true,
      },
      // The model sees only "shown" for a card; an invalid view returns its error
      // so the model can correct it in the same turn (the turn is not concluded).
      render: (_args: unknown, value: unknown) => {
        const status = (value as { status?: unknown } | null)?.status
        return [{ type: 'text' as const, text: status === 'shown' || status === 'pending' ? 'shown' : String((value as { summary?: unknown } | null)?.summary ?? 'invalid view') }]
      },
      // A deferred mix is a successful result with no card. Its meta is the only
      // durable marker; an invalid view still contributes none.
      presentationMeta: (_args: unknown, value: unknown) =>
        (value as { status?: unknown } | null)?.status === 'deferred' ? SHOW_VIEW_DEFERRED_META : cardPresentation(value) ?? null,
    },
    isConcurrencySafe: () => false,
    execute: async (args: unknown, exec: { callId?: string; concludeTurn(): void; agent?: { session?: StepTranscript } }) => {
      const input = (args !== null && typeof args === 'object' ? args : {}) as Record<string, unknown>
      const invalid = (summary: string) => ({ status: 'invalid' as const, summary })
      // Refuse before presentCard. Later exclusive calls are not logged yet,
      // so the assistant message committed for this step is the whole batch.
      const session = exec.agent?.session
      if (session !== undefined && typeof session.deriveMessages === 'function' && showViewSharesStep(session.deriveMessages(), exec.callId)) {
        return { status: 'deferred' as const, summary: SHOW_VIEW_MIXED_SUMMARY }
      }
      let view = input.view
      if (typeof view === 'string') {
        try { view = JSON.parse(view) } catch { return invalid('view: expected JSON text describing one ViewNode') }
      }
      if (view === undefined || view === null) return invalid('view: expected one ViewNode')
      const checked = checkShownView(input.title, view)
      if ('error' in checked) return invalid(checked.error)
      if (input.await_reply !== undefined && typeof input.await_reply !== 'boolean') return invalid('await_reply: expected true or false')
      const awaitReply = input.await_reply ?? checked.interactive
      if (awaitReply !== checked.interactive) {
        return invalid(checked.interactive
          ? 'This card has answer controls; set await_reply true or omit it.'
          : 'A display-only card cannot wait for an answer; omit await_reply or set it false.')
      }
      try {
        const presentation = await (dot() as unknown as CardService).presentCard(checked, exec.callId ?? '', typeof input.approval_id === 'string' ? input.approval_id : undefined)
        exec.concludeTurn()
        return { status: 'shown' as const, summary: 'shown', presentation }
      } catch (error) {
        return invalid(`the card could not be shown: ${messageOf(error)}`)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Show view', kind: 'other' }),
  }, true)

  // ── dot_overview ──────────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.overview,
    description: 'Inspect the live ledger of tracked changes, tasks, watched sessions, and waiting requests alongside top-level host sessions (newest first). Clears unread turn counters.',
    parameters: {
      limit: { type: 'integer', description: 'Maximum top-level host sessions to list (default 30).' },
    },
    execute: async (args, exec) => dot().overview(exec.signal ?? new AbortController().signal, typeof (args as { limit?: unknown }).limit === 'number' ? (args as { limit: number }).limit : 30),
    title: 'Overview',
  }), true)

  // ── dot_read ──────────────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.read,
    description: "Read one session's tracked status, goal, and latest assistant reply so you can verify its report against the work order.",
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target session id.' },
      max_chars: { type: 'integer', description: 'Maximum trailing characters of the latest reply to return (default 4000).' },
    },
    execute: async (args) => dot().read(str(args, 'session_id') ?? '', typeof (args as { max_chars?: unknown }).max_chars === 'number' ? (args as { max_chars: number }).max_chars : 4000),
    title: 'Read session',
  }), true)

  // ── dot_workspace (merged from dot_list_workspaces + dot_create_workspace) ─
  tool(defineToolInput({
    name: TOOL.workspace,
    description: 'Inspect or create DSH workspaces (file edits always run on task sessions, never here). action=list: list all workspaces (id, title, directory, session count), marking your own workspace. action=inspect: read metadata of one workspace (defaults to your own). action=files: list files and folders inside a workspace (read-only; optional relative path). action=read: read a text file inside the workspace (relative path under the workspace, or an absolute path inside a registered workspace/change directory; optional start_line and max_lines, default 400, max 2000). action=create: register or reuse a workspace at an absolute directory, creating the directory if absent.',
    parameters: {
      action: { type: 'string', enum: ['list', 'inspect', 'files', 'create', 'read'], required: true, description: 'Operation: list, inspect, files, read, or create.' },
      path: { type: 'string', description: 'create: absolute directory path. files: optional relative subpath inside the workspace. read: file path, relative inside the workspace or absolute inside an allowed root.' },
      title: { type: 'string', description: 'create: optional display title for a newly registered workspace.' },
      workspace_id: { type: 'string', description: 'inspect/files/read: workspace id from action=list; omit to target your own workspace.' },
      start_line: { type: 'integer', description: 'read: first line to show, 1-based (default 1).' },
      max_lines: { type: 'integer', description: 'read: maximum lines to show (default 400, max 2000).' },
    },
    execute: async (args) => {
      const action = str(args, 'action')
      if (action === 'create') return dot().createWorkspace(str(args, 'path') ?? '', str(args, 'title'))
      if (action === 'inspect') return dot().inspectWorkspace(str(args, 'workspace_id'))
      if (action === 'files') return dot().listWorkspaceFiles(str(args, 'workspace_id'), str(args, 'path'))
      if (action === 'read') {
        const numeric = args as { start_line?: unknown; max_lines?: unknown }
        return dot().readWorkspaceFile(str(args, 'workspace_id'), str(args, 'path'), typeof numeric.start_line === 'number' ? numeric.start_line : undefined, typeof numeric.max_lines === 'number' ? numeric.max_lines : undefined)
      }
      return dot().listWorkspaces()
    },
    title: 'Workspace',
  }))

  // ── dot_task ──────────────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.task,
    description: `Drive a contract-backed change from goal definition to verified closeout. create/revise define or update the input contract; dispatch reserves scope, captures the baseline, and launches a run (omit task_id to open a quick run on a new change in dir/workspace_id, or pass run_id to launch a saved reservation); finish settles a writer run once its report arrives; closeout snapshots the delivery, evaluates checks, and accepts it (or opens human oversight when human_review is set). check reports conflicting run reservations and active user sessions for dir/workspace_id (+ optional paths) without starting anything; with task_id it inherits the same pinned recipe access as dispatch. When overriding access or paths, pass the same values to check that you will pass to dispatch so the preflight evaluates the planned write scope rather than the recipe/default scope. Optional independent review: dispatch with role=review, then closeout or reject. read/list inspect state; supplement delivers context once to an active run without changing requirements; step records progress notes; pause/resume/cancel control execution; decide requests a human decision on a recorded verification. create accepts recipe=<id or name> to fill the order from a saved recipe (see ${TOOL.recipe}). Recipe-created dispatches start from the saved work order even without message; other dispatches without message still only reserve. Service refusals preserve scope and version invariants.`,
    parameters: {
      action: { type: 'string', enum: [...TASK_ACTIONS], required: true, description: 'Lifecycle action to perform.' },
      task_id: { type: 'string', description: 'Change id (required except on create, list, or initial dispatch of a new change).' },
      title: { type: 'string', description: 'create/revise/dispatch: concise human-facing change title.' },
      goal: { type: 'string', description: 'create/revise/dispatch: one English sentence stating what the finished delivery must achieve.' },
      dir: { type: 'string', description: 'create/dispatch/check: absolute project directory.' },
      workspace_id: { type: 'string', description: 'create/dispatch/check: target project workspace id.' },
      requirements: { type: 'string', description: 'create/revise: JSON array of {requirementRef,text,required,scenarios?}. Write text in English stating what SHALL hold (quote exact strings verbatim). Each required item needs at least one scenario {scenarioRef,given?,when,then} with a globally unique scenarioRef (e.g. R1.a).' },
      steps: { type: 'string', description: 'create/revise: JSON array of {stepRef,text,covers?,after?} for planning notes (never treated as delivery proof). covers lists requirement/scenario ids served; after lists prerequisite step ids (acyclic).' },
      constraints: { type: 'string', description: 'create/revise: JSON array of {constraintRef,text} in English specifying execution boundaries (order, untouched paths, forbidden tools). Modifying constraints creates a new input revision.' },
      user_request: { type: 'string', description: "create/revise: the human's exact unedited, untranslated request text, passed verbatim to runs as the source of truth." },
      recipe: { type: 'string', description: "create: recipe id or name; fills title, goal, requirements, constraints, dir, deliverable_language and human_review from the recipe — pass a field only to override it for this task." },
      deliverable_language: { type: 'string', description: 'create/revise: target language for deliverable files/copy/commits (e.g. "Simplified Chinese"); omit to follow user_request and existing project files. Run reports stay in English.' },
      priority: { type: 'integer', description: 'create/revise: priority from 1 (normal) to 3 (urgent).' },
      human_review: { type: 'boolean', description: 'create/revise: set true when the human asked to decide before acceptance. The first closeout records the verification and opens that decision; a later closeout accepts it.' },
      max_concurrent: { type: 'integer', description: 'create/revise: maximum concurrent open runs (1 to 8).' },
      role: { type: 'string', enum: ['work', 'rework', 'review'], description: 'dispatch/check: run role. review is optional and reserves the whole workspace exclusively but launches read-only; verification needing writes (e.g. builds) belongs in a writer run.' },
      access: { type: 'string', enum: ['read', 'write'], description: 'dispatch/check: set "write" when the run will create, edit, or delete files; "read" is strictly read-only.' },
      paths: { type: 'string', description: 'dispatch/check: JSON array of {path,type} ("file" or "directory") bounding write access, e.g. [{"path":"src/app.ts","type":"file"}]. Omit with access="write" only to reserve the entire change directory.' },
      message: { type: 'string', description: 'dispatch: English supplementary notes appended after the rendered work-order brief (include only context not already in the input; never restate requirements or scope). supplement: English context delivered once to an active run without altering requirements.' },
      model: { type: 'string', description: 'dispatch: allowed provider/model key from dot_list_models; omit for default.' },
      preset: { type: 'string', description: 'dispatch: task preset id ("ptc" for scripted batch work, "cordis" for DSH plugin work); omit for default.' },
      run_id: { type: 'string', description: 'finish/step/supplement: target run id. dispatch: continue a previously reserved run.' },
      verdict: { type: 'string', enum: ['pass', 'fail'], description: 'finish: writer outcome after checking its Report (review runs close via closeout or reject).' },
      step_refs: { type: 'string', description: 'dispatch: JSON array of stepRef ids assigned to this run; omit to include all current steps.' },
      step_ref: { type: 'string', description: 'step: stepRef whose progress is being marked.' },
      input_ref: { type: 'string', description: 'read: specific historical inputRef to inspect; omit for current input and full history.' },
      checks: { type: 'string', description: 'closeout: JSON array of {requirementRef,applicability,verdict,note,evidenceRefs}. Every pass needs resolvable evidence: run:<runId> for a run\'s captured Report, run:<runId>#<scenarioRef> for one of its Report bullets, or file:<path> for a delivered file.' },
      expected_input_ref: { type: 'string', description: 'closeout/supplement: exact inputRef copied from action=read.' },
      expected_input_revision: { type: 'integer', description: 'closeout/supplement/step/decide/reject: exact revision number copied from action=read.' },
      review_run_id: { type: 'string', description: 'closeout: optional open review run of this change; closeout holds it and refuses one that is already completed, failed, or stopped. reject: required open review run id to release for rework.' },
      expected_subject_key: { type: 'string', description: 'decide: subjectKey of the recorded verification.' },
      verification_id: { type: 'string', description: 'decide: verification id to submit for human review.' },
      reason: { type: 'string', description: 'pause/resume/cancel: brief reason for the lifecycle action.' },
    },
    execute: async (args) => dot().manageTask(args as Record<string, unknown>),
    title: 'Manage task',
  }))

  // ── dot_list_models ───────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.listModels,
    description: `List the provider/model keys permitted for dispatched tasks under the human's current settings, plus the default model used when none is specified.`,
    parameters: {},
    execute: async () => dot().listModels(),
    title: 'List models',
  }), true)

  // ── dot_send ──────────────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.sendToSession,
    description: 'Deliver an agent-attributed message to a watched or ordinary user session (wakes an idle session, or queues for the next turn of a running one). A managed run session refuses this tool — to send pure context to an active run, use dot_task action=supplement so the delivery is version-checked and recorded.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target watched or ordinary session id.' },
      message: { type: 'string', required: true, description: 'Message text to deliver.' },
    },
    execute: async (args) => dot().send(str(args, 'session_id') ?? '', str(args, 'message') ?? ''),
    title: 'Message session',
  }))

  // ── dot_interrupt ─────────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.interruptSession,
    description: 'Interrupt the active turn of a session while leaving its queued messages intact.',
    parameters: { session_id: { type: 'string', required: true, description: 'Session id to interrupt.' } },
    execute: async (args) => dot().interrupt(str(args, 'session_id') ?? ''),
    title: 'Stop session',
  }))

  // ── dot_archive ───────────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.archiveSession,
    description: 'Archive a session that you opened (marked "started" in the ledger) once its runs are terminal, declining any pending requests on it. Sessions opened by the human are refused.',
    parameters: { session_id: { type: 'string', required: true, description: 'Session id started by you.' } },
    execute: async (args) => dot().archive(str(args, 'session_id') ?? ''),
    title: 'Archive session',
  }))

  // ── dot_watch ─────────────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.watchSession,
    description: 'Subscribe to an existing session you did not start so it appears on the board and its completed turns, errors, approvals, and questions route to you.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Session id to watch.' },
      goal: { type: 'string', required: true, description: 'What the human expects from this session.' },
      title: { type: 'string', description: 'Optional display title on the board.' },
    },
    execute: async (args) => dot().watch(str(args, 'session_id') ?? '', str(args, 'goal') ?? '', str(args, 'title')),
    title: 'Watch session',
  }))

  // ── dot_answer ────────────────────────────────────────────────────────────
  // Structured question answers are JSON text, keeping the model-facing schema scalar.
  // Callers pass either allow or answers, never both.
  tool(defineToolInput({
    name: TOOL.answerPending,
    description: 'Inspect untruncated approval parameters with action=read, or settle a pending approval or question from another session by request id. For an approval, pass allow=true or false; for a question, pass answers as a JSON array string covering every question id exactly once. Honor [settings snapshot], [agreements], and the approval principles in your system prompt (requests marked human-required cannot be answered here). If a request is already settled elsewhere, do not retry it and stay silent unless another update requires the human.',
    parameters: {
      id: { type: 'string', required: true, description: 'Pending request id from the notice.' },
      action: { type: 'string', enum: ['read'], description: 'Pass "read" to inspect full recorded approval arguments without settling the request.' },
      allow: { type: 'boolean', description: 'Approval verdict: true to allow once, false to deny (omit when answering a question).' },
      answers: { type: 'string', description: 'JSON array string for a question request (omit for approvals), e.g. [{"id":"q1","selected":["Option"],"custom":"details"}]. Every question id must appear once; selected may be [].' },
    },
    execute: async (args) => {
      const id = str(args, 'id') ?? ''
      if (str(args, 'action') === 'read') return dot().readApprovalDetail(id)
      const allow = (args as { allow?: unknown }).allow
      let answers = (args as { answers?: unknown }).answers
      if (typeof allow === 'boolean' && answers !== undefined) throw new DotError('dot/invalid', 'give allow or answers, not both')
      if (typeof allow === 'boolean') return dot().answer(id, { kind: 'approval', allow })
      if (typeof answers === 'string') {
        try { answers = JSON.parse(answers) } catch { throw new DotError('dot/invalid', 'answers must contain a JSON array') }
      }
      if (Array.isArray(answers)) {
        return dot().answer(id, { kind: 'question', answers: answers.map(item => {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new DotError('dot/invalid', 'each answer must be an object with a question id')
          const row = item as { id?: unknown; selected?: unknown; custom?: unknown }
          return {
            id: String(row.id ?? ''),
            selected: Array.isArray(row.selected) ? row.selected.map(String) : [],
            ...typeof row.custom === 'string' && row.custom ? { custom: row.custom } : {},
          }
        }) })
      }
      throw new DotError('dot/invalid', 'give allow for an approval or answers for a question')
    },
    title: 'Answer request',
  }))

  // ── dot_schedule (merged from dot_schedule_add + dot_schedule_list + dot_schedule_remove) ──
  tool(defineToolInput({
    name: TOOL.schedule,
    description: 'Manage persistent reminders that wake your active conversation segment with a [dot reminder] message when due. action=add refuses a duplicate of a still-set reminder (same title, or same timing and prompt); remove the existing one first to change it. action=add requires exactly one timing field: after_minutes, at, every_minutes, or daily_time (optionally paired with weekdays). One-off reminders (after_minutes, at) fire at most once even across late wakes or restarts. All timestamps use host local time; each firing consumes a model turn, so choose sensible intervals and action=remove recurring reminders once their goal is done.',
    parameters: {
      action: { type: 'string', enum: ['add', 'list', 'remove'], required: true, description: 'Operation: add, list, or remove.' },
      title: { type: 'string', description: 'add: concise reminder label shown on the board.' },
      prompt: { type: 'string', description: 'add: self-contained instructions for your future self (which may be in a new segment) — what to inspect, where, and when to notify the human.' },
      after_minutes: { type: 'integer', description: 'add: fire once after N minutes from now.' },
      at: { type: 'string', description: 'add: fire once at host local time YYYY-MM-DD HH:mm (or ISO timestamp with offset).' },
      every_minutes: { type: 'integer', description: 'add: repeat every N minutes, starting one interval from now.' },
      daily_time: { type: 'string', description: 'add: repeat at host local time HH:mm.' },
      weekdays: { type: 'string', description: 'add (with daily_time only): comma-separated ISO weekdays 1 (Mon) through 7 (Sun), e.g. "1,2,3,4,5".' },
      id: { type: 'string', description: 'remove: reminder id (sch-...).' },
    },
    execute: async (args) => {
      const action = str(args, 'action')
      if (action === 'list') return dot().scheduleList()
      if (action === 'remove') return dot().scheduleRemove(str(args, 'id') ?? '')
      // add
      const afterMinutes = num(args, 'after_minutes')
      const everyMinutes = num(args, 'every_minutes')
      const weekdaysRaw = str(args, 'weekdays')
      const weekdays = weekdaysRaw
        ? weekdaysRaw.split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n))
        : undefined
      return dot().scheduleAdd({
        title: str(args, 'title') ?? '',
        prompt: str(args, 'prompt') ?? '',
        ...afterMinutes === undefined ? {} : { afterMinutes },
        ...str(args, 'at') ? { at: str(args, 'at')! } : {},
        ...everyMinutes === undefined ? {} : { everyMinutes },
        ...str(args, 'daily_time') ? { dailyTime: str(args, 'daily_time')! } : {},
        ...weekdays ? { weekdays } : {},
      })
    },
    title: 'Manage reminders',
  }))

  // ── dot_search_history ────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.searchHistory,
    description: `Search literal terms across your conversation with the human (including earlier segments before rollovers) and tracked task sessions. Every word in query must appear within the same message (case-insensitive, any order). Returns session_id and seq anchors for ${TOOL.readHistory}.`,
    parameters: {
      query: { type: 'string', required: true, description: 'Exact words to match; fewer words broaden recall.' },
      scope: { type: 'string', enum: ['all', 'own', 'tasks'], description: 'own: your conversation segments; tasks: tracked task sessions; all (default): both.' },
      session_id: { type: 'string', description: 'Restrict search to one specific session id.' },
      tools: { type: 'boolean', description: 'Also search tool call arguments and results; default false (messages only).' },
      limit: { type: 'integer', description: 'Maximum matches to return (default 12, max 40).' },
    },
    execute: async (args) => {
      const limit = num(args, 'limit')
      return dot().searchHistory({
        query: str(args, 'query') ?? '',
        ...str(args, 'scope') ? { scope: str(args, 'scope')! } : {},
        ...str(args, 'session_id') ? { sessionId: str(args, 'session_id')! } : {},
        tools: bool(args, 'tools'),
        ...limit === undefined ? {} : { limit },
      })
    },
    title: 'Search history',
  }), true)

  // ── dot_read_history ──────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.readHistory,
    description: `Read verbatim messages from one session: centered around seq (from ${TOOL.searchHistory}), or the trailing messages when seq is omitted.`,
    parameters: {
      session_id: { type: 'string', required: true, description: 'Session id to read.' },
      seq: { type: 'integer', description: 'Anchor sequence number from a search hit or prior read.' },
      before: { type: 'integer', description: 'Messages before seq (default 4, max 30).' },
      after: { type: 'integer', description: 'Messages after seq (default 4, max 30).' },
      tools: { type: 'boolean', description: 'Include tool calls and results; default false.' },
    },
    execute: async (args) => {
      const seq = num(args, 'seq')
      const before = num(args, 'before')
      const after = num(args, 'after')
      return dot().readHistory({
        sessionId: str(args, 'session_id') ?? '',
        ...seq === undefined ? {} : { seq },
        ...before === undefined ? {} : { before },
        ...after === undefined ? {} : { after },
        tools: bool(args, 'tools'),
      })
    },
    title: 'Read history',
  }), true)

  // ── dot_agreement ─────────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.agreement,
    description: "Manage the human's standing rules in [agreements], preserved in their own words. action=add: call only when the human explicitly states a standing rule or asks you to remember one; record a single concise line verbatim without paraphrasing. action=remove: remove an entry the human asked to drop by quoting enough of it to match uniquely. Updates take effect in the prompt prefix on the next segment.",
    parameters: {
      action: { type: 'string', enum: ['add', 'remove'], required: true, description: 'Operation: add or remove.' },
      text: { type: 'string', required: true, description: "add: single-line rule in the human's exact words (max 400 characters). remove: exact rule text or a unique substring." },
    },
    execute: async (args) => str(args, 'action') === 'remove' ? dot().agreementRemove(str(args, 'text') ?? '') : dot().agreementAdd(str(args, 'text') ?? ''),
    title: 'Agreement',
  }))

  // ── dot_cognition ─────────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.cognition,
    description: 'Rewrite your [cognition] block: your concise, durable understanding of the human (workflow preferences, habits) and of yourself (formed preferences, shared jokes, accomplishments together). Always pass the complete replacement text (empty string clears it); never include transient task status, and remember [agreements] always take precedence. Updates take effect in the prompt prefix on the next segment.',
    parameters: {
      text: { type: 'string', required: true, description: 'Complete replacement [cognition] text (max 4000 characters; empty clears it).' },
    },
    execute: async (args) => dot().cognitionRewrite(str(args, 'text') ?? ''),
    title: 'Cognition',
  }))

  // ── dot_new_segment ───────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.newSegment,
    description: 'Schedule a clean segment rollover at the end of this turn while preserving handoff context, task ledger, reminders, and searchable history. Use on genuine topic shifts or heavy context accumulation — never to dodge unfinished work.',
    parameters: {
      focus: { type: 'string', description: 'Optional note telling your next segment what to focus on first.' },
    },
    execute: async (args) => dot().requestSegment(str(args, 'focus')),
    title: 'New segment',
  }))

  // ── dot_settings (merged from dot_read_settings + dot_propose_settings) ──
  // Core hard-switch state is always visible in the [settings snapshot] system-prompt
  // block; call dot_settings only to read full detail or propose a change.
  const self = () => dot().selfSettings
  tool(defineToolInput({
    name: TOOL.settings,
    description: `Read full settings or submit a setting-change proposal for human approval. Live core switches (scope, approvals, questions, taskPermission, reflection, idleCheckMinutes) are already shown in [settings snapshot]; call action=read only when you need full values, lock states, or pending proposals. action=propose queues one unlocked setting change for approval in Settings (nothing changes until approved). Supported fields: model, approvals, questions, scope, taskModels, taskPermission, reflection, idleCheckMinutes (0–1440; 0 disables), persona, address, agreements (agreements bulk text). Pass value as a JSON-encoded string matching action=read (e.g. "\\"human\\"", "true", "{\\"provider\\":\\"p\\",\\"model\\":\\"m\\"}", or "null" to reset a clearable default). Locks and homeDir are human-only; use ${TOOL.agreement} and ${TOOL.cognition} for normal knowledge updates.`,
    parameters: {
      action: { type: 'string', enum: ['read', 'propose'], required: true, description: 'Operation: read or propose.' },
      field: { type: 'string', description: 'propose: target setting field name.' },
      value: { type: 'string', description: 'propose: JSON-encoded target value wrapped as a string, e.g. "\\"human\\"", "true", "{\\"provider\\":\\"p\\",\\"model\\":\\"m\\"}", or "null".' },
      reason: { type: 'string', description: 'propose: concise human-facing explanation of why this change helps.' },
    },
    execute: async (args) => {
      const action = str(args, 'action')
      if (action === 'propose') {
        let value = (args as Record<string, unknown> | null)?.value
        if (typeof value === 'string') {
          try { value = JSON.parse(value) } catch { throw new DotError('dot/invalid', 'value must be a string containing valid JSON; encode text as a JSON string') }
        }
        return self().propose({ field: str(args, 'field') ?? '', value, reason: str(args, 'reason') ?? '' })
      }
      return self().read()
    },
    title: 'Settings',
  }), /* read is not exclusively read-only since propose mutates */ false)

  // ── dot_recipe ────────────────────────────────────────────────────────────
  tool(defineToolInput({
    name: TOOL.recipe,
    description: `Manage saved, versioned work-order recipes you reuse through ${TOOL.task} action=create recipe=<id or name>. action=save records a new recipe under a unique name — pass from_task to copy goal, requirements, constraints, deliverable language, dir, preset and access from a change you were happy with, or pass the fields directly. action=revise replaces any subset of fields (or renames) and always requires a reason naming what changed; it refuses a no-op. action=restore brings an earlier revision back as a new revision (reason required). action=list shows every recipe with its current-revision outcome stats; action=read shows the full body, revision history, per-revision accepted/cancelled stats and recent outcomes; action=remove deletes the recipe while tagged changes keep their tag but no longer inherit its dispatch defaults; finish or cancel those tasks first if their remaining runs still need those defaults.`,
    parameters: {
      action: { type: 'string', enum: ['list', 'read', 'save', 'revise', 'restore', 'remove'], required: true, description: 'Operation: list, read, save, revise, restore, or remove.' },
      recipe: { type: 'string', description: 'read/revise/restore/remove: recipe id or exact name (case-insensitive).' },
      name: { type: 'string', description: 'save: unique recipe name. revise: new name (rename).' },
      from_task: { type: 'string', description: 'save: change id to copy goal, requirements, constraints, deliverable_language, dir, preset and access from; explicit fields override the copied ones.' },
      goal: { type: 'string', description: 'save/revise: one English sentence stating what a delivery must achieve. Required on save without from_task.' },
      requirements: { type: 'string', description: 'save/revise: JSON array of {requirementRef,text,required,scenarios?}, same contract as dot_task. Omit to copy or default to the goal.' },
      constraints: { type: 'string', description: 'save/revise: JSON array of {constraintRef,text}; empty array clears.' },
      notes: { type: 'string', description: 'save/revise: English guidance added to every run brief; empty string clears.' },
      deliverable_language: { type: 'string', description: 'save/revise: target language for deliverables; empty string clears.' },
      dir: { type: 'string', description: 'save/revise: absolute default project directory; empty string clears. Required on save without from_task.' },
      preset: { type: 'string', description: 'save/revise: default task preset id for dispatches; empty string clears.' },
      model: { type: 'string', description: 'save/revise: default provider/model key for dispatches; empty string clears.' },
      access: { type: 'string', enum: ['read', 'write'], description: 'save/revise: default run access for work and rework dispatches (review stays read-only).' },
      human_review: { type: 'boolean', description: 'save/revise: created tasks open human oversight before acceptance.' },
      revision: { type: 'integer', description: 'restore: earlier revision number from action=read history.' },
      reason: { type: 'string', description: 'revise/restore: required — why this revision exists (name the failure it fixes).' },
    },
    execute: async (args) => dot().manageRecipe(args as Record<string, unknown>),
    title: 'Task recipes',
  }))

  // ── dot_capabilities ────────────────────────────────────────────────────
  // Extra tools from other plugins and MCP servers are off by default; the
  // human grants them in Settings > Capabilities, or approves a proposal here.
  tool(defineToolInput({
    name: TOOL.capabilities,
    description: 'List optional extra capabilities (tools from other plugins and MCP servers) or propose changes. Extras are off by default. action=list shows a tree of selectors (tool:<name>, mcp:<server>, plugin:<bundle>[#<entry>], builtin:<id>, prefix:<segment>) with each tool\'s grant, whether it is applied to this segment, conditional, high-risk, and unavailable state. action=propose queues {selector, grant, reason} for human approval in Settings; grant is off | ask (each call pauses for human approval) | auto (calls run freely). Nothing changes until the human approves, and grants apply only from the next segment. action=propose_install {spec, version, reason} asks the human to install a plugin package; to find one use the official plugin_market/plugin_manager tools if the human granted them, else dsh_plugins (version is optional for official catalog bundles, exact otherwise). To build a new plugin or wire up an MCP server, dispatch a dot_task with preset "cordis" — a wrapper plugin can register an MCP server through mcpManager.',
    parameters: {
      action: { type: 'string', enum: ['list', 'propose', 'propose_install'], required: true, description: 'Operation: list the catalog, propose a grant change, or propose installing a plugin.' },
      selector: { type: 'string', description: 'propose: selector id from list output, e.g. tool:<name>, mcp:<server>, plugin:<bundle>, plugin:<bundle>#<entry>, builtin:<id>.' },
      grant: { type: 'string', enum: ['off', 'ask', 'auto'], description: 'propose: the grant the selector should get.' },
      spec: { type: 'string', description: 'propose_install: npm package name of the plugin to install, e.g. dsh-something or @scope/pkg.' },
      version: { type: 'string', description: 'propose_install: exact published version, e.g. 1.2.3. Optional only when the bundle is an official on-demand catalog row — its version is already pinned.' },
      reason: { type: 'string', description: 'propose/propose_install: concise human-facing explanation of why this helps.' },
    },
    execute: async (args) => {
      const action = str(args, 'action')
      if (action === 'propose') {
        return dot().proposeCapability({ selector: str(args, 'selector') ?? '', grant: (str(args, 'grant') ?? 'off') as 'off' | 'ask' | 'auto', reason: str(args, 'reason') ?? '' })
      }
      if (action === 'propose_install') {
        const version = str(args, 'version')
        return dot().proposeInstall({ spec: str(args, 'spec') ?? '', ...(version !== undefined ? { version } : {}), reason: str(args, 'reason') ?? '' })
      }
      return dot().listCapabilities()
    },
    title: 'Capabilities',
  }), false)
}

/** Shared defaults: text output, serial execution, a generic call card. */
function defineToolInput(input: {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<string>
  title: string
}): ToolInput {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    output: { ...TEXT_OUTPUT, presentationMeta: (_args: unknown, value: string) => ({ dshDot: { display: toolDisplay(input.name, value) } }) },
    isConcurrencySafe: () => false,
    execute: input.execute,
    presentCall: () => ({ card: 'generic', title: input.title, kind: 'other' }),
  }
}
