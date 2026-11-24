/**
 * Shared identifiers and record shapes of dsh-dot.
 *
 * dot is one long-lived orchestration session: it talks to the human and
 * opens, steers and checks other sessions, but its own preset carries no
 * file or shell tools. Everything else in the package reads these types.
 */
export const PLUGIN_NAME = 'dsh-dot'
export const SERVICE_NAME = 'dot'
export const PRESET_ID = 'dot'
export const RPC_CHANNEL = '/dsh-dot'

export const TOOL = {
  overview: 'dot_overview',
  read: 'dot_read',
  workspace: 'dot_workspace',
  task: 'dot_task',
  listModels: 'dot_list_models',
  sendToSession: 'dot_send',
  interruptSession: 'dot_interrupt',
  archiveSession: 'dot_archive',
  watchSession: 'dot_watch',
  answerPending: 'dot_answer',
  schedule: 'dot_schedule',
  searchHistory: 'dot_search_history',
  readHistory: 'dot_read_history',
  agreement: 'dot_agreement',
  cognition: 'dot_cognition',
  newSegment: 'dot_new_segment',
  settings: 'dot_settings',
  capabilities: 'dot_capabilities',
  recipe: 'dot_recipe',
} as const

/**
 * Settings Dorothy may propose changing; locks themselves are human-only.
 * `agreements` is the human's rules text, edited as one bulk value.
 */
export const SETTING_FIELDS = ['model', 'approvals', 'questions', 'scope', 'taskModels', 'taskPermission', 'reflection', 'idleCheckMinutes', 'persona', 'address', 'agreements', 'capabilities'] as const
export type SettingField = typeof SETTING_FIELDS[number]
export type SettingLocks = Readonly<Partial<Record<SettingField, boolean>>>

/** A durable human decision; approving writes the value captured in the proposal only if it is still current. */
export interface SettingProposal {
  readonly id: string
  /** The setting the proposal names; rows naming anything else are dropped on load. */
  readonly field: SettingField
  readonly before: unknown
  readonly after: unknown
  readonly reason: string
  readonly createdAt: number
}

// ---- dot's knowledge: agreements and cognition -------------------------

/** One earlier full text of dot's cognition, with the moment it was replaced. */
export interface CognitionVersion {
  readonly text: string
  /** Unique, monotonically increasing; used to ask for that version back. */
  readonly at: number
}

/**
 * One background reflection pass that was actually run as a session, kept so
 * the trajectory page can show it after the session has been archived.
 */
export interface ReflectionRun {
  readonly sessionId: string
  readonly startedAt: number
  /** When the pass finished; absent while it is still running. */
  readonly endedAt?: number
  /** Whether it actually wrote a new cognition (a pass that never submits is a failure). */
  readonly ok: boolean
}

/** dot's agreements as the settings view shows them: the human's own standing requirements. */
export interface AgreementView {
  readonly text: string
  readonly maxChars: number
  /** Whether the change before the current text can be taken back. */
  readonly canUndo: boolean
}

/** dot's cognition as the settings view shows it: its own understanding, with the versions it can return to. */
export interface CognitionView {
  readonly text: string
  readonly maxChars: number
  /** Newest first; at most COGNITION_HISTORY_MAX. The empty text is a version too. */
  readonly history: readonly CognitionVersion[]
}

/** Both prompt blocks that are not the fixed persona or the handoff. */
export interface KnowledgeView {
  readonly agreements: AgreementView
  readonly cognition: CognitionView
}

/** Sizes of the two prompt blocks; the tools and the panel refuse to grow them past this. */
export const AGREEMENTS_MAX_CHARS = 4000
export const AGREEMENT_ENTRY_MAX_CHARS = 400
export const COGNITION_MAX_CHARS = 4000
/** How many earlier cognition texts are kept for rollback. */
export const COGNITION_HISTORY_MAX = 10

/**
 * First words of the one-time note the reflection pass leaves for dot's next
 * human message. The note rides the same carried prefix as batched notices, so
 * the chat and the transcript split it out of the human's words the same way.
 */
export const AGREEMENT_NOTES_HEAD = '[dot agreement notes]'

// ---- dot's reminders ---------------------------------------------------

/** First words of the message that delivers due reminders to dot; the chat draws those messages as reminders. */
export const REMINDER_HEAD = '[dot reminder]'

/** When a reminder is due. Wall-clock times are in the host's local zone. */
export type ScheduleTiming =
  | { readonly kind: 'once'; readonly at: number }
  /** Every `minutes`, counted from `anchor`. */
  | { readonly kind: 'every'; readonly minutes: number; readonly anchor: number }
  /** At `time` (HH:mm) every day, or only on the given weekdays: Monday 1 to Sunday 7. */
  | { readonly kind: 'daily'; readonly time: string; readonly weekdays?: readonly number[] }

/** A reminder dot set for itself. It belongs to dot, not to one of its session segments. */
export interface ScheduleRecord {
  readonly id: string
  readonly title: string
  /** What dot reads when the reminder is due. */
  readonly prompt: string
  readonly timing: ScheduleTiming
  readonly createdAt: number
  /** When it is due next. A delivered once reminder keeps this and does not become due again. */
  readonly nextAt: number
  readonly lastFiredAt?: number
  /** Set when a once reminder was handed off. Later ticks, late catch-up and restarts must not wake again. */
  readonly deliveredAt?: number
  /** Bound task recipe id: firing dispatches the recipe directly instead of a model turn. */
  readonly recipe?: string
}

/** Where a tracked session came from: dot started it, or the human asked dot to watch it. */
export type TaskOrigin = 'started' | 'watched'

/** Coarse lifecycle the board and the ledger summary show. */
export type TaskStatus = 'running' | 'idle' | 'blocked' | 'error' | 'archived'

/** The kind of work a run does on its change. */
export type RunKind = 'work' | 'rework' | 'review'
export type RunAccess = 'read' | 'write'
export type ChangePriority = 1 | 2 | 3

export interface TaskRecord {
  readonly sessionId: string
  readonly origin: TaskOrigin
  readonly title: string
  readonly goal: string
  readonly cwd: string
  readonly workspaceId?: string
  /** Agent preset the session was started on, when dot started it and the host named one. */
  readonly preset?: string
  readonly status: TaskStatus
  readonly createdAt: number
  readonly updatedAt: number
  /** Last noteworthy line shown on the board: a finished turn, an error, a waiting request. */
  readonly lastNote?: string
  /** Turns that ended since dot last looked at this task. */
  readonly unseenTurns: number
}

export type PendingKind = 'approval' | 'question'

/** Prefix of the token fencing requester-supplied approval text; a random suffix closes the pair. */
export const APPROVAL_FENCE_PREFIX = 'dot-approval-untrusted-'

/** Prefix of the token fencing external event text in inbox notices; a random suffix closes the pair. */
export const INBOX_FENCE_PREFIX = 'dot-inbox-untrusted-'

export interface ApprovalDetail {
  readonly requestId: string
  readonly sessionId: string
  readonly callerSessionId?: string
  readonly callId?: string
  readonly toolName: string
  readonly reason?: string
  readonly arguments?: string
}

/** One request from another session that waits for dot or the human. */
export interface PendingView {
  readonly id: string
  readonly kind: PendingKind
  readonly sessionId: string
  readonly createdAt: number
  /** approval: tool name; question: the first question text. */
  readonly subject: string
  readonly detail?: string
  readonly questions?: readonly PendingQuestionItem[]
  /** Set when this approval is high-risk or truncated. The model cannot settle it. */
  readonly humanRequired?: boolean
}

export interface PendingQuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
}

/** Board snapshot the client renders. */
/** A reminder row as the board projects it: the bound recipe's current name resolved at read time. */
export interface ScheduleView extends ScheduleRecord {
  readonly recipeName?: string
}

/**
 * A human-gated proposal to restore or revise a recipe. `baseRevision` is the
 * recipe revision the proposal was made against; once the recipe moves past
 * it, deciding marks the proposal stale instead of applying.
 */
export interface RecipeProposal {
  readonly id: string
  readonly recipeId: string
  readonly baseRevision: number
  readonly kind: 'restore' | 'revise'
  readonly targetRevision?: number
  readonly patch?: {
    readonly goal?: string
    readonly requirements?: readonly import('./work.ts').Requirement[]
    readonly constraints?: readonly import('./work.ts').Constraint[]
    readonly notes?: string
  }
  readonly reason: string
  readonly origin: 'detector' | 'reflection'
  /** The regression kind a detector proposal was raised under — the dismiss dedupe key. */
  readonly regression?: 'acceptance' | 'rework' | 'cost'
  readonly status: 'pending' | 'approved' | 'dismissed' | 'stale'
  readonly createdAt: number
  readonly decidedAt?: number
}

/** A pending proposal as the Recipes view renders it, with the base body for the revise diff. */
export interface RecipeProposalView {
  readonly id: string
  readonly kind: 'restore' | 'revise'
  readonly origin: 'detector' | 'reflection'
  readonly baseRevision: number
  readonly targetRevision?: number
  readonly patch?: RecipeProposal['patch']
  /** Snapshot of the revision the proposal was made against, for the merged diff. */
  readonly base?: {
    readonly goal: string
    readonly notes?: string
    readonly requirementsFromGoal: boolean
    readonly requirements: readonly import('./work.ts').Requirement[]
    readonly constraints: readonly import('./work.ts').Constraint[]
  }
  readonly reason: string
  readonly createdAt: number
}

/** One recipe as the Tasks panel's Recipes filter renders it. */
export interface RecipeBoardRow {
  readonly id: string
  readonly name: string
  readonly revision: number
  readonly updatedAt: number
  readonly stats: readonly import('./recipes.ts').RecipeRevisionStats[]
  readonly inFlight: readonly { readonly changeId: string; readonly title: string; readonly status: string }[]
  readonly reminders: readonly { readonly id: string; readonly title: string; readonly nextAt: number }[]
  readonly proposal?: RecipeProposalView
}

export interface BoardView {
  readonly dotSessionId?: string
  /** Sessions the human asked dot to watch; task sessions are shown through `work`. */
  readonly tasks: readonly TaskRecord[]
  /** Started task sessions so chat notices and activity badges resolve Change titles. */
  readonly startedTasks?: readonly TaskRecord[]
  /** Active and completed WorkBook Changes projected for the header counter and WorkBoard. */
  readonly work?: readonly import('./work-board.ts').WorkBoardItem[]
  readonly pending: readonly PendingView[]
  /** dot's reminders, the one due first on top. */
  readonly schedules: readonly ScheduleView[]
  /** Pending recipe proposals, for the "needs you" attention items. */
  readonly recipeProposals?: readonly { readonly id: string; readonly recipeId: string; readonly recipeName: string; readonly kind: 'restore' | 'revise'; readonly createdAt: number }[]
}

/**
 * One thing waiting on the human, projected for the background badge and
 * desktop notifications. `id` stays stable while the same unanswered card or
 * the same decision keeps waiting, and changes when a work item re-enters
 * needs-human for a new reason.
 */
export interface AttentionItem {
  readonly id: string
  readonly kind: 'card' | 'work' | 'recipe'
  readonly title: string
  readonly since?: number
}

/** The "needs you" view the browser-side watcher polls while the panel is closed. */
export interface AttentionView {
  readonly items: readonly AttentionItem[]
}

/**
 * Who answers the approval prompts of the sessions in scope.
 * dot: dot settles what it can and asks the human the rest; human: every
 * request goes to the human; deny: every request is rejected.
 */
export type ApprovalMode = 'dot' | 'human' | 'deny'

/** dot: dot settles what it can and asks the human the rest; human: dot relays every one; off: the host's own card handles it. */
export type TakeoverMode = 'dot' | 'human' | 'off'

export interface ModelChoice { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }

/**
 * Which models dot may put a task on. all: every model of the host catalog;
 * allow: only the listed ones; deny: every one except the listed ones.
 * Entries are `provider/model` keys. dot's own model is not affected.
 */
export interface TaskModelRule { readonly mode: 'all' | 'allow' | 'deny'; readonly list: readonly string[] }
export const TASK_MODEL_LIST_MAX = 500

/**
 * The permission preset a task session starts with. It is independent of the
 * approval mode: a sandbox limits what a task can touch, the approval mode
 * decides who answers the prompts that still appear.
 * - workspace-write: the task may write inside its workspace and ask for more.
 * - danger-full-access: the task may act anywhere; no sandbox prompt appears.
 * - safe-auto: workspace-write with the Safe Auto plugin's reviewer model
 *   answering prompts; only offered while that plugin's runtime is available.
 * - auto: DSH's experimental per-call model review on full access; only
 *   offered while the host exposes the `auto` permission preset.
 */
export type TaskPermission = 'workspace-write' | 'danger-full-access' | 'safe-auto' | 'auto'

/**
 * How dot may use one extra capability selector: off denies it, ask raises a
 * human-only approval card on each call, auto lets the call through.
 */
export type CapabilityGrant = 'off' | 'ask' | 'auto'

/**
 * Grants for dot's optional extra tools, keyed by selector: `tool:<name>`,
 * `mcp:<server>`, `plugin:<bundle>`, `plugin:<bundle>#<entryId>` or
 * `prefix:<segment>` for an unattributed name cluster. A name on the locked
 * inherited list is never grantable, whatever its row says.
 */
export interface DotCapabilities {
  readonly grants: Readonly<Record<string, CapabilityGrant>>
}

/** One tool row inside a capability group, as the settings view renders it. */
export interface CapabilityToolView {
  readonly name: string
  readonly description?: string
  /** Registered under a `when` gate (e.g. Creator-only): grantable, applied as a scoped copy. */
  readonly conditional: boolean
  /** Granted but not currently registered. */
  readonly missing?: boolean
  /** Self-escalating under dot's full-access session: runs unsandboxed with no host approval. */
  readonly highRisk?: boolean
}

/** A grantable group of extra tools: one MCP server, one bundle, one loader entry, one host built-in row, an unattributed name prefix, or the unattributed remainder. */
export interface CapabilityGroupView {
  /** Selector a grant row addresses: `mcp:<s>`, `plugin:<b>`, `plugin:<b>#<e>`, `builtin:<id>`, `prefix:<s>` or `host`. */
  readonly id: string
  readonly kind: 'mcp' | 'plugin' | 'entry' | 'builtin' | 'prefix' | 'host'
  readonly label: string
  /** Granted but nothing currently owns the selector. */
  readonly missing?: boolean
  /** At least one tool inside the group (at any depth) is high-risk. */
  readonly highRisk?: boolean
  readonly tools: readonly CapabilityToolView[]
  readonly children?: readonly CapabilityGroupView[]
  /** 'dot' marks a group mounted on dot's own preset scope, invisible to other sessions. */
  readonly scope?: 'dot'
  /** Live connection status for an MCP group, when the host reports one. */
  readonly status?: CapabilityMcpStatus
}

/** Connection status of one MCP server, as the settings view draws it. */
export interface CapabilityMcpStatus {
  readonly state: string
  readonly toolCount?: number
  readonly diagnostic?: string
}

/** The catalog the settings view draws: locked dot tools on top, grantable groups below. */
export interface CapabilityCatalogView {
  readonly locked: readonly string[]
  readonly groups: readonly CapabilityGroupView[]
  /** Grants of the current settings, keyed by selector. */
  readonly grants: Readonly<Record<string, CapabilityGrant>>
  /** Grant each tool got when the live segment started, before any later edits. */
  readonly applied: Readonly<Record<string, CapabilityGrant>>
}

/** One configured dot-local MCP server as the settings view draws it. */
export interface DotMcpServerView {
  readonly name: string
  readonly catalog?: string
  readonly url: string
  readonly enabled: boolean
  /** 'token' when any header carries a credential template. */
  readonly auth: 'none' | 'token'
  /** The credential this server's headers reference; never its value. */
  readonly credential?: { readonly ref: string; readonly configured: boolean; readonly masked?: string }
  /** Token-creation page carried over from the catalog entry, when there is one. */
  readonly tokenUrl?: string
  readonly status?: CapabilityMcpStatus
}

/** One recommended-catalog entry as the settings view draws it; about/tokenHelp are text keys. */
export interface DotMcpCatalogEntry {
  readonly id: string
  readonly name: string
  readonly about: string
  readonly url: string
  /** Header templates the settings row inherits; never resolved values. */
  readonly headers?: Readonly<Record<string, string>>
  readonly auth: 'none' | 'token'
  readonly tokenUrl?: string
  readonly tokenHelp?: string
}

/** The MCP settings page payload: configured servers plus the recommended catalog. */
export interface DotMcpListView {
  readonly servers: readonly DotMcpServerView[]
  readonly catalog: readonly DotMcpCatalogEntry[]
}

/** Everything the human tunes in dot's settings view; stored with dot's state. */
export interface DotSettings {
  /** dot's own model; absent follows the host default model. */
  readonly model?: ModelChoice
  readonly approvals: ApprovalMode
  readonly questions: TakeoverMode
  /** all: every top-level session; tracked: only sessions on dot's board. New installs start at tracked. */
  readonly scope: 'all' | 'tracked'
  /** Models dot may start tasks on. */
  readonly taskModels: TaskModelRule
  /** The permission preset a new task session starts with. */
  readonly taskPermission: TaskPermission
  /** Whether dot may run her own background reflection pass. */
  readonly reflection: boolean
  /** Whether dot checks daily for a newer published version of itself and hot-updates. */
  readonly autoUpdate: boolean
  readonly idleCheckMinutes: number
  /** Prompt-cache TTL overrides by `provider/model` key, in minutes; 0 turns keepalive off for that model. */
  readonly cacheTtl?: Readonly<Record<string, number>>
  /** The human's own persona text for dot; absent uses the default persona. */
  readonly persona?: string
  /** How dot addresses the human; absent uses the default. */
  readonly address?: string
  /** Grants for optional extra tools from other plugins and MCP servers; every extra defaults to off. */
  readonly capabilities: DotCapabilities
  /** MCP servers mounted for dot's own agent only, keyed by serverName. */
  readonly mcpServers?: Readonly<Record<string, DotMcpServer>>
  /** Missing and false both mean unlocked: existing installs opt in to self-management. */
  readonly locks?: SettingLocks
}

/** One dot-local MCP server row in settings. */
export interface DotMcpServer {
  /** Catalog entry id this row was added from; absent for a custom server. */
  readonly catalog?: string
  readonly url: string
  /** Extra request headers; values may carry `${credential:REF}` templates. */
  readonly headers?: Readonly<Record<string, string>>
  readonly enabled: boolean
}

/** serverName keys of `mcpServers`, matching the host's MCP client limit. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** MCP servers are remote-only: https anywhere, http only on loopback. */
export function isMcpServerUrl(url: string): boolean {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol === 'https:') return true
  if (parsed.protocol !== 'http:') return false
  const host = parsed.hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/** Valid RFC 9110 header field-name characters. */
const MCP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** One well-formed credential template. */
const MCP_CREDENTIAL_TEMPLATE = /\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Header values may embed `${credential:REF}` templates resolved from the
 * host's credential store; every `${…}` must be a well-formed template.
 */
export function isMcpServerHeaders(headers: unknown): headers is Readonly<Record<string, string>> {
  if (headers === undefined) return true
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return false
  for (const [name, value] of Object.entries(headers)) {
    if (!MCP_HEADER_NAME.test(name) || typeof value !== 'string') return false
    if (value.replace(MCP_CREDENTIAL_TEMPLATE, '').includes('${')) return false
  }
  return true
}

/** Credential refs a server's headers reference. */
export function mcpCredentialRefs(server: Pick<DotMcpServer, 'headers'>): string[] {
  const refs = new Set<string>()
  for (const value of Object.values(server.headers ?? {})) {
    for (const match of value.matchAll(MCP_CREDENTIAL_TEMPLATE)) refs.add(match[1]!)
  }
  return [...refs]
}

/** The credential name dot's panel allocates for one server: `DOT_MCP_<NAME>_TOKEN`. */
export function mcpCredentialName(server: string): string {
  return `DOT_MCP_${server.toUpperCase().replace(/-/g, '_')}_TOKEN`
}

/** Credential refs a set of removed servers releases: only dot-owned `DOT_MCP_*` refs. */
export function dotOwnedCredentialRefs(removed: readonly DotMcpServer[]): string[] {
  return [...new Set(removed.flatMap(server => mcpCredentialRefs(server)).filter(ref => ref.startsWith('DOT_MCP_')))]
}

/** Upper bound for one stored MCP credential value; empty means "use unset". */
export const MCP_CREDENTIAL_VALUE_MAX = 4096

export type McpCredentialSetError = 'bad-server' | 'unknown-server' | 'bad-credential'

/** Validate `mcp.credential.set` args: a known server name plus a non-empty, bounded value. */
export function validateMcpCredentialSet(
  server: unknown,
  value: unknown,
  knownServers: ReadonlySet<string>,
): McpCredentialSetError | undefined {
  if (typeof server !== 'string' || !MCP_SERVER_NAME_PATTERN.test(server)) return 'bad-server'
  if (!knownServers.has(server)) return 'unknown-server'
  if (typeof value !== 'string' || value.trim() === '' || value.length > MCP_CREDENTIAL_VALUE_MAX) return 'bad-credential'
  return undefined
}

export const DEFAULT_SETTINGS: DotSettings = {
  approvals: 'dot',
  questions: 'dot',
  scope: 'tracked',
  taskModels: { mode: 'all', list: [] },
  taskPermission: 'workspace-write',
  reflection: true,
  autoUpdate: true,
  idleCheckMinutes: 10,
  capabilities: { grants: {} },
}

/** What a factory-reset preview shows before the human confirms. */
export interface FactoryResetPreview {
  readonly token: string
  readonly expiresAt: number
  readonly tasks: number
  readonly changes: number
  readonly runs: number
  readonly schedules: number
  readonly recipes: number
  readonly recipeProposals: number
  readonly proposals: number
  readonly cards: number
  /** Pending and delivered external events in the inbox table. */
  readonly inbox: number
  /** Dot-managed task worktrees removed with the reset (dot/task-* branches keep their commits). */
  readonly worktrees: number
  /** Task-to-event links in the links table. */
  readonly links: number
  readonly ownedSessions: number
  readonly pastSegments: number
  readonly reflections: number
  readonly hasAgreements: boolean
  readonly hasCognition: boolean
  readonly archiveSessionIds: readonly string[]
}

export interface FactoryResetResult {
  readonly archived: readonly string[]
  readonly archiveFailed: readonly { readonly sessionId: string; readonly message: string }[]
  readonly sessionId: string
  readonly at: number
}

/** The part of the settings that routes an incoming request. */
export type RuleConfig = Pick<DotSettings, 'approvals' | 'questions' | 'scope'>

export const DEFAULT_RULES: RuleConfig = DEFAULT_SETTINGS

// ---- dot's own context, shown in the settings view ---------------------

/**
 * Why dot's conversation moved to a fresh session segment: the context grew
 * past the rollover line, the segment sat idle, the model or the persona
 * changed, or the previous session could not be reopened.
 */
export type RolloverReason = 'context-full' | 'idle-expired' | 'model-switch' | 'prompt-changed' | 'capabilities-changed' | 'lost' | 'manual' | 'dot-requested'

/** Once a finished turn leaves this share of the usable window occupied, the next message starts a new segment. */
export const ROLLOVER_POLICY = { ratio: 0.7 } as const

/**
 * Compaction policy of dot's preset; the context page draws its line from the
 * same numbers. Segments normally roll over first, so in-place compaction only
 * catches a single turn that outgrows the window.
 */
export const COMPACTION_POLICY = { thresholdRatio: 0.9, headroomTokens: 16_384 } as const

export type DotContextCategory = 'system' | 'tools' | 'user' | 'inject' | 'skill' | 'assistant' | 'tool'
export type DotContextParts = Record<DotContextCategory, number>

/** One actual item in the current prompt, expandable in the context browser. */
export interface DotContextNode {
  readonly id: string
  readonly seq: number
  readonly at: number
  readonly category: DotContextCategory
  readonly tokens: number
  readonly text: string
  readonly name?: string
  readonly status?: 'error'
  readonly clipped?: boolean
}

export interface DotContextSurface {
  readonly parts: DotContextParts
  readonly nodes: readonly DotContextNode[]
}

export interface DotContextUsage {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

/** Usage baseline recorded when the human clears cumulative totals mid-segment. */
export interface DotUsageOffset extends DotContextUsage {
  readonly sessionId: string
}

/**
 * The cache-keepalive setting Settings currently edits: the live session's
 * model while a ping is armed, otherwise the next-request model.
 */
export interface KeepaliveInfo {
  readonly provider: string
  readonly model: string
  /** Effective TTL in minutes: the human's override or the built-in default. 0 disables pings. */
  readonly minutes: number
  readonly defaultMinutes: number
}

/** The frozen prompt blocks of the current segment; live values before a segment exists. */
export interface DotContextSections {
  readonly persona: string
  readonly agreements: string
  readonly cognition: string
  readonly handoff: string
}

export interface DotContextView {
  /** Whether dot's session is live in this process. */
  readonly live: boolean
  readonly provider?: string
  readonly model?: string
  readonly contextWindow?: number
  /** Prompt size the next request is expected to carry. */
  readonly usedTokens?: number
  /** Prompt size at which dot's preset compacts before the next step. */
  readonly compactAt?: number
  /** Prompt size past which a finished turn moves the conversation to a new segment. */
  readonly rolloverAt?: number
  /** Output tokens reserved by the latest request, drawn by the upstream reserve masks. */
  readonly reservedOutput?: number
  /** Heuristic composition of the current context. */
  readonly breakdown?: { readonly system: number; readonly tools: number; readonly messages: number }
  /** Detailed live categories and their actual content, folded from dot's session log. */
  readonly surface?: DotContextSurface
  /** Actual frozen prompt blocks of the current segment (live text before one exists). */
  readonly sections?: DotContextSections
  /** Provider-reported cumulative totals across segments since the latest clear. */
  readonly usage?: DotContextUsage
  readonly compactions: number
  readonly lastCompactionAt?: number
}

// ---- dot's trajectory, drawn by the plugin -----------------------------

export interface TrajUsage { readonly input: number; readonly output: number; readonly cacheRead: number }

/** One row inside a step, in log order. */
export type TrajRecord =
  | { readonly kind: 'input'; readonly seq: number; readonly at: number; readonly source: 'user' | 'answer' | 'relay' | 'context' | 'notice'; readonly text: string; readonly clipped?: boolean }
  | { readonly kind: 'reasoning'; readonly seq: number; readonly at: number; readonly text: string; readonly clipped?: boolean }
  | { readonly kind: 'text'; readonly seq: number; readonly at: number; readonly text: string; readonly clipped?: boolean }
  | { readonly kind: 'call'; readonly seq: number; readonly at: number; readonly callId: string; readonly name: string; readonly args: string; readonly argsClipped?: boolean; readonly status: 'running' | 'done' | 'error'; readonly result?: string; readonly resultClipped?: boolean; readonly endedAt?: number }
  /** A compaction summary; shadowed is the estimated size of what it replaced. */
  | { readonly kind: 'compaction'; readonly seq: number; readonly at: number; readonly text: string; readonly clipped?: boolean; readonly shadowed?: number }

export interface TrajStep {
  readonly step: number
  readonly startedAt: number
  readonly endedAt?: number
  /** Time of the first streamed token, when the stream recorded one. */
  readonly firstTokenAt?: number
  readonly model?: string
  readonly usage?: TrajUsage
  readonly failed?: string
  readonly records: readonly TrajRecord[]
}

export interface TrajTurn {
  readonly turn: number
  readonly startedAt: number
  readonly endedAt?: number
  /** completed, error, cancelled… as the host logged it; absent while the turn runs. */
  readonly end?: string
  readonly error?: string
  /** Inputs that arrived before the turn's first step. */
  readonly records: readonly TrajRecord[]
  readonly steps: readonly TrajStep[]
}

export interface TrajectoryView {
  readonly sessionId?: string
  readonly turns: readonly TrajTurn[]
  /** Turns left out before the shown window. */
  readonly earlier: number
}

// ---- external events (inbox) ---------------------------------------------

/** One external event normalized for dot's inbox, independent of the ingress. */
export interface InboxEventInput {
  /** Provider kind, e.g. 'github'. */
  readonly source: string
  /** The configured source this delivery came through. */
  readonly sourceId: string
  readonly deliveryId: string
  /** e.g. 'pull_request.opened', 'workflow_run.completed', 'push'. */
  readonly type: string
  /** Coalescing key, e.g. 'owner/repo#123', 'owner/repo@refs/heads/main', 'owner/repo:workflow:<name>@<branch>'. */
  readonly subject: string
  /** One line, clipped. */
  readonly title: string
  readonly actor?: string
  readonly url?: string
  /** Short detail, whitespace collapsed. */
  readonly summary: string
  readonly receivedAt: number
  /** PR head branch carried for link matching; never shown to the model. */
  readonly headRef?: string
  /** PR/workflow head repository (owner/repo, lower-cased) for fork-aware link matching. */
  readonly headRepo?: string
}

/** A stored inbox row: one pending record per source+sourceId+subject, merged deliveries folded in. */
export interface InboxRecord extends InboxEventInput {
  /** Deterministic from source+sourceId+deliveryId of the first event for this pending subject. */
  readonly id: string
  /** Delivery ids folded into this record, newest last, capped so merged duplicates are still caught. */
  readonly deliveryIds: readonly string[]
  /** Events merged into this pending record. */
  readonly count: number
  readonly status: 'pending' | 'delivered'
  readonly updatedAt: number
  readonly deliveredAt?: number
}

export type InboxSubmitResult = 'stored' | 'merged' | 'duplicate'

// ---- task links: inbox events bound to the change that owns the PR/branch ----

/** The newest event that reached a link, kept so the board can show it. */
export interface LinkEvent {
  readonly type: string
  readonly title: string
  readonly summary: string
  readonly url?: string
  readonly at: number
  /** Events folded into the matched inbox record. */
  readonly count: number
}

/**
 * A durable binding between a change and a GitHub target. `number` names a
 * pull request or issue; `branch` a head branch learned from a PR event or
 * attached directly. At least one of the two is set.
 */
export interface TaskLink {
  readonly id: string
  readonly changeId: string
  /** owner/repo, lower-cased. */
  readonly repo: string
  readonly number?: number
  readonly branch?: string
  /** Head repository learned with the branch; distinguishes same-named fork branches. */
  readonly headRepo?: string
  readonly url?: string
  readonly origin: 'dot' | 'auto'
  readonly state: 'open' | 'closed' | 'merged'
  readonly addedAt: number
  readonly lastEvent?: LinkEvent
}

// ---- dot's task recipes --------------------------------------------------

/**
 * The versioned content of a task recipe: a saved work order dot fills a new
 * change from. Requirement and constraint rows share the change-input shape,
 * so a stored recipe always passes the same validation a create would.
 */
export interface RecipeBody {
  /** One English sentence stating what a delivery of this kind must achieve. */
  readonly goal: string
  readonly requirements: readonly import('./work.ts').Requirement[]
  /** True when requirements are the implicit goal check and follow goal edits. */
  readonly requirementsFromGoal?: boolean
  readonly constraints?: readonly import('./work.ts').Constraint[]
  /** English guidance added to every run brief dispatched from this recipe. */
  readonly notes?: string
  readonly deliverableLanguage?: string
  /** Absolute default project directory. */
  readonly dir?: string
  readonly preset?: string
  /** provider/model key. */
  readonly model?: string
  readonly access?: 'read' | 'write'
  readonly humanReview?: boolean
  /** 'worktree' runs created tasks in a dot-managed git worktree instead of the checkout. */
  readonly isolation?: 'worktree'
}

/** One earlier revision of a recipe, with the name and reason it carried. */
export interface RecipeVersion extends RecipeBody {
  readonly revision: number
  readonly name: string
  readonly reason?: string
  /** When this version was replaced. */
  readonly at: number
}

/** How one change tagged with a recipe ended: settled by closeout or cancelled. */
export interface RecipeOutcome {
  readonly changeId: string
  readonly title: string
  /** The recipe revision the change ran on. */
  readonly revision: number
  readonly result: 'accepted' | 'cancelled'
  readonly failedRounds: number
  /** Cost summed over the change's runs at the moment the outcome was written. */
  readonly tokens?: number
  readonly wallMs?: number
  readonly at: number
}

/** A saved, versioned work-order template. Changes it spawned keep their tag after removal. */
export interface RecipeRecord extends RecipeBody {
  readonly id: string
  /** Unique case-insensitively. */
  readonly name: string
  /** 1 on save, +1 on each revise or restore. */
  readonly revision: number
  /** The reason recorded for the current revision. */
  readonly reason?: string
  /** Earlier revisions, newest first, capped at RECIPE_HISTORY_MAX. */
  readonly history: readonly RecipeVersion[]
  /** Newest first, capped at RECIPE_OUTCOMES_MAX, upserted by changeId. */
  readonly outcomes: readonly RecipeOutcome[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** How many earlier recipe revisions are kept for restore. */
export const RECIPE_HISTORY_MAX = 10
/** How many recorded outcomes one recipe keeps. */
export const RECIPE_OUTCOMES_MAX = 50

// ---- dot's own chat, drawn by the plugin -------------------------------

export type ChatItem = ChatItemRow & { readonly turn?: number; readonly trigger?: 'human' | 'background' }

type ChatItemRow =
  | { readonly kind: 'user'; readonly key: string; readonly text: string; readonly at: number; readonly images?: readonly { readonly mediaType: string; readonly name?: string }[] }
  /** The human's answer to one of dot's cards. */
  | { readonly kind: 'answer'; readonly key: string; readonly text: string; readonly at: number }
  /** A batch of task updates the host delivered to dot. */
  | { readonly kind: 'notice'; readonly key: string; readonly text: string; readonly at: number; readonly notice?: import('./chat-format.ts').ParsedNotice }
  | { readonly kind: 'bot'; readonly key: string; readonly text: string; readonly at: number }
  | { readonly kind: 'tool'; readonly key: string; readonly name: string; readonly status: 'running' | 'done' | 'error'; readonly args?: Readonly<Record<string, unknown>>; readonly detail?: string; readonly at: number; readonly display?: import('./chat-format.ts').ToolDisplay }
  /** A show_view card; presentation is filled once its result commits. */
  | { readonly kind: 'view'; readonly key: string; readonly title?: unknown; readonly view?: unknown; readonly presentation?: Record<string, unknown>; readonly failed?: boolean; readonly at: number }
  | { readonly kind: 'error'; readonly key: string; readonly text: string; readonly at: number }
  /** The conversation continued in a new session segment here. */
  | { readonly kind: 'segment'; readonly key: string; readonly reason?: RolloverReason; readonly at: number }

export interface ChatSnapshot {
  readonly sessionId: string
  readonly running: boolean
  /** Reply text streaming right now, before its message commits. */
  readonly streaming: string
  /** A show_view call is streaming or awaiting its committed result. */
  readonly preparingCard?: boolean
  /** Changes on every update; the client long-polls with the last one it saw. */
  readonly rev: number
  /** Changes when the item list changes; items are sent only when it moved past the client's. */
  readonly itemsRev: number
  /** Monotonic watermark bumped whenever board/task/work/pending state changes. */
  readonly boardRev?: number
  readonly items?: readonly ChatItem[]
  /** Answers to dot's cards by view id, for cards already answered. */
  readonly answers?: Readonly<Record<string, { readonly action: string; readonly values: Record<string, unknown> }>>
}
