/**
 * The `dot-worker` task preset: aligns with `rc.5` `standard.patch.yml` for
 * file R/W, search, skill, planning, compaction, ask-user, todo, web, present,
 * and office tools, while scoping an isolated cross-platform shell realm
 * (5s foreground auto-promotion to background, 600s max) and 5s default job
 * wait, and omitting delegation/subagent/workflow/schedule/goal plugins.
 */
import { WORKER_PRESET_ID } from './contracts.ts'

export { WORKER_PRESET_ID }

export const WORKER_SHELL_TIMEOUT_MS = 5_000
export const WORKER_SHELL_MAX_TIMEOUT_MS = 600_000
export const WORKER_JOB_WAIT_TIMEOUT_MS = 5_000
export const WORKER_PRESET_ORDER = 50

export const WORKER_PLAN_MODE_SECTION = [
  "You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.",
  'Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.',
  'The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.',
  'Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.',
  'Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.',
  'When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.',
].join('\n\n')

export interface WorkerPresetJsExpr {
  readonly __jsExpr: string
}

export interface WorkerPresetPluginEntry {
  readonly id: string
  readonly name: string
  readonly group?: boolean
  readonly isolate?: Readonly<Record<string, boolean>>
  readonly disabled?: boolean | WorkerPresetJsExpr
  readonly config?: Readonly<Record<string, unknown>> | readonly WorkerPresetPluginEntry[]
}

export interface WorkerPresetDefinition {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly order: number
  readonly plugins: readonly WorkerPresetPluginEntry[]
}

/**
 * Build the `dot-worker` preset definition aligned with `rc.5` `standard.patch.yml`.
 * Uses `isolate: { shell: true }` so the 5s shell executor never leaks to the root
 * context, omits `customSkillDirs` on `skill-filesystem` (which resolves an
 * external bundle package not in `ds-dot`'s dependencies), and omits delegation,
 * subagent, workflow, schedule, and goal tools.
 */
export function buildWorkerPresetDefinition(): WorkerPresetDefinition {
  return {
    id: WORKER_PRESET_ID,
    name: 'Dot worker',
    description: 'Dorothy task worker: cross-platform sandbox shell with 5s foreground-to-background auto-promotion (max 600s) and 5s default job wait, without nested subagent/workflow/schedule/goal tools.',
    order: WORKER_PRESET_ORDER,
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: 'You are a coding agent powered by the {{model}} model.' },
      },
      {
        id: 'agent-instructions',
        name: '@deepseek-ai/dsh-agent-instructions',
        config: { maxBytes: 65_536 },
      },
      {
        id: 'time-context',
        name: '@deepseek-ai/dsh-time-context',
      },
      {
        id: 'dot-worker-shell',
        name: 'cordis:group',
        group: true,
        isolate: { shell: true },
        config: [
          {
            id: 'bash-sandbox',
            name: '@deepseek-ai/dsh-bash-sandbox',
            disabled: { __jsExpr: "process.platform === 'win32'" },
            config: {
              timeoutMs: WORKER_SHELL_TIMEOUT_MS,
              maxTimeoutMs: WORKER_SHELL_MAX_TIMEOUT_MS,
            },
          },
          {
            id: 'tool-bash',
            name: '@deepseek-ai/dsh-tool-bash',
            disabled: { __jsExpr: "process.platform === 'win32'" },
            config: {
              enableRunInBackground: true,
              promoteOnTimeout: true,
            },
          },
          {
            id: 'pwsh-sandbox',
            name: '@deepseek-ai/dsh-pwsh-sandbox',
            disabled: { __jsExpr: "process.platform !== 'win32'" },
            config: {
              timeoutMs: WORKER_SHELL_TIMEOUT_MS,
              maxTimeoutMs: WORKER_SHELL_MAX_TIMEOUT_MS,
            },
          },
          {
            id: 'tool-pwsh',
            name: '@deepseek-ai/dsh-tool-pwsh',
            disabled: { __jsExpr: "process.platform !== 'win32'" },
            config: {
              enableRunInBackground: true,
              promoteOnTimeout: true,
            },
          },
        ],
      },
      {
        id: 'tool-fs',
        name: '@deepseek-ai/dsh-tool-fs',
        config: { applyPatch: false },
      },
      {
        id: 'tool-fs-search',
        name: '@deepseek-ai/dsh-tool-fs-search',
        config: { sampleOverCapGlobResults: false },
      },
      {
        id: 'tool-jobs',
        name: '@deepseek-ai/dsh-tool-jobs',
        config: { waitTimeoutMs: WORKER_JOB_WAIT_TIMEOUT_MS },
      },
      {
        id: 'skill-filesystem',
        name: '@deepseek-ai/dsh-skill-filesystem',
      },
      {
        id: 'tool-skill',
        name: '@deepseek-ai/dsh-tool-skill',
      },
      {
        id: 'planning',
        name: 'cordis:group',
        group: true,
        isolate: { planMode: true },
        config: [
          {
            id: 'plan-mode',
            name: '@deepseek-ai/dsh-plan-mode',
            config: { section: WORKER_PLAN_MODE_SECTION },
          },
        ],
      },
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true, toolResultPruner: true },
        config: [
          { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
          {
            id: 'tool-result-pruner',
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
            config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
          },
        ],
      },
      {
        id: 'tool-ask-user',
        name: '@deepseek-ai/dsh-tool-ask-user',
      },
      {
        id: 'tool-todo',
        name: '@deepseek-ai/dsh-tool-todo',
        config: { allowParallelInProgress: true },
      },
      {
        id: 'tool-web',
        name: '@deepseek-ai/dsh-tool-web',
        config: { fetch: true, searchTimeoutMs: 60_000 },
      },
      {
        id: 'present',
        name: '@deepseek-ai/dsh-tool-present',
      },
      {
        id: 'tool-office',
        name: '@deepseek-ai/dsh-tool-office',
      },
      {
        id: 'tool-plugin-manager',
        name: '@deepseek-ai/dsh-plugin-manager/tools',
        disabled: { __jsExpr: "!ctx.get('profileContext')" },
      },
      {
        id: 'tool-plugin-market',
        name: '@deepseek-ai/dsh-plugin-market/tools',
        disabled: true,
      },
    ],
  }
}

export const workerPresetDefinition = buildWorkerPresetDefinition

export interface WorkerPresetLogger {
  debug?(event: string, message: string, context?: Record<string, unknown>): void
  error?(event: string, message: string, error: unknown, context?: Record<string, unknown>): void
}

export interface WorkerPresetHostContext {
  readonly agentPresets?: {
    register?(definition: never): Promise<() => Promise<void>>
  }
  readonly logger?: { warn?(...args: unknown[]): void }
}

/**
 * Register the public `dot-worker` preset on `ctx.agentPresets`.
 * Silently degrades if `agentPresets` is absent or throws, and safely disposes
 * even when unloaded before `register()` resolves.
 */
export function registerWorkerPreset(
  ctx: WorkerPresetHostContext | undefined,
  logger?: WorkerPresetLogger,
): () => void {
  let release: (() => Promise<void>) | undefined
  let disposed = false
  const reportFailure = (error: unknown) => {
    logger?.error?.('preset.register-failed', 'Failed to register Dot worker preset.', error, { presetId: WORKER_PRESET_ID })
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
    try {
      ctx?.logger?.warn?.('dsh-dot: worker preset registration failed: %s', message)
    } catch { /* host logger is optional */ }
  }
  const invokeDispose = (fn: () => Promise<void>) => {
    try {
      void Promise.resolve(fn()).catch(() => {})
    } catch { /* dispose is best-effort */ }
  }
  try {
    const registry = ctx?.agentPresets
    const register = registry?.register
    if (typeof register !== 'function') return () => {}
    void Promise.resolve(register.call(registry, buildWorkerPresetDefinition() as never)).then(
      (dispose: (() => Promise<void>) | undefined) => {
        if (typeof dispose !== 'function') return
        if (disposed) {
          invokeDispose(dispose)
          return
        }
        release = dispose
        logger?.debug?.('preset.registered', 'Registered Dot worker preset.', { presetId: WORKER_PRESET_ID })
      },
      reportFailure,
    )
  } catch (error: unknown) {
    reportFailure(error)
    return () => {}
  }
  return () => {
    disposed = true
    const current = release
    release = undefined
    if (current) invokeDispose(current)
  }
}
