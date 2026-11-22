/**
 * Pure record logic of task recipes: the body a pinned revision resolves to,
 * the revision history a revise or restore pushes, the outcome ledger that
 * survives pruning, and the per-revision stats list/read report.
 */
import { RECIPE_HISTORY_MAX, RECIPE_OUTCOMES_MAX, type RecipeBody, type RecipeOutcome, type RecipeRecord, type RecipeVersion } from './contracts.ts'
import { formatDuration, formatTokens } from './ui-copy.ts'

/** Just the versioned content of a stored recipe or one of its earlier versions. */
export function recipeBody(row: RecipeBody): RecipeBody {
  return {
    goal: row.goal,
    requirements: row.requirements,
    ...(row.requirementsFromGoal !== undefined ? { requirementsFromGoal: row.requirementsFromGoal } : {}),
    ...(row.constraints !== undefined ? { constraints: row.constraints } : {}),
    ...(row.notes !== undefined ? { notes: row.notes } : {}),
    ...(row.deliverableLanguage !== undefined ? { deliverableLanguage: row.deliverableLanguage } : {}),
    ...(row.dir !== undefined ? { dir: row.dir } : {}),
    ...(row.preset !== undefined ? { preset: row.preset } : {}),
    ...(row.model !== undefined ? { model: row.model } : {}),
    ...(row.access !== undefined ? { access: row.access } : {}),
    ...(row.humanReview !== undefined ? { humanReview: row.humanReview } : {}),
    ...(row.isolation !== undefined ? { isolation: row.isolation } : {}),
  }
}

/** The implicit acceptance requirement used when no explicit list was supplied. */
export function goalRequirements(goal: string): RecipeBody['requirements'] {
  return [{ requirementRef: 'goal', text: goal, required: true }]
}

/** New rows record provenance; legacy rows retain it through their exact shape. */
export function requirementsFollowGoal(row: Pick<RecipeBody, 'goal' | 'requirements' | 'requirementsFromGoal'>): boolean {
  if (row.requirementsFromGoal !== undefined) return row.requirementsFromGoal
  return row.requirements.length === 1
    && row.requirements[0]!.requirementRef === 'goal'
    && row.requirements[0]!.text === row.goal
    && row.requirements[0]!.required === true
    && row.requirements[0]!.scenarios === undefined
}

/** Requirements for a goal, regenerating only the implicit goal-derived list. */
export function recipeRequirements(row: RecipeBody, goal = row.goal): RecipeBody['requirements'] {
  return requirementsFollowGoal(row) ? goalRequirements(goal) : row.requirements
}

/**
 * The body a tag pinned to `revision` dispatches on: that revision when it is
 * still recorded, the current one once it fell out of the capped history.
 */
export function recipeBodyAt(recipe: RecipeRecord, revision: number): RecipeBody {
  if (revision === recipe.revision) return recipeBody(recipe)
  const version = recipe.history.find(row => row.revision === revision)
  return version ? recipeBody(version) : recipeBody(recipe)
}

/** The version row an older revision left behind, for action=restore. */
export function recipeVersionAt(recipe: RecipeRecord, revision: number): RecipeVersion | undefined {
  return recipe.history.find(row => row.revision === revision)
}

/** A stable key two bodies share only when every field matches, lists included. */
function bodyKey(row: RecipeBody & { readonly name?: string }): string {
  return JSON.stringify({
    name: row.name ?? null,
    goal: row.goal,
    requirements: row.requirements,
    requirementsFromGoal: requirementsFollowGoal(row),
    constraints: row.constraints ?? null,
    notes: row.notes ?? null,
    deliverableLanguage: row.deliverableLanguage ?? null,
    dir: row.dir ?? null,
    preset: row.preset ?? null,
    model: row.model ?? null,
    access: row.access ?? null,
    humanReview: row.humanReview ?? null,
    isolation: row.isolation ?? null,
  })
}

/** Whether a revise would record exactly the same revision again. */
export function sameRecipeBody(left: RecipeBody & { readonly name?: string }, right: RecipeBody & { readonly name?: string }): boolean {
  return bodyKey(left) === bodyKey(right)
}

/** Push the current revision into history (newest first, capped) and stamp the next one. */
export function reviseRecipe(recipe: RecipeRecord, next: RecipeBody & { readonly name: string; readonly reason: string }, at: number): RecipeRecord {
  const version: RecipeVersion = { ...recipeBody(recipe), revision: recipe.revision, name: recipe.name, ...(recipe.reason !== undefined ? { reason: recipe.reason } : {}), at }
  return {
    ...recipeBody(next),
    id: recipe.id,
    name: next.name,
    revision: recipe.revision + 1,
    reason: next.reason,
    history: [version, ...recipe.history].slice(0, RECIPE_HISTORY_MAX),
    outcomes: recipe.outcomes,
    createdAt: recipe.createdAt,
    updatedAt: at,
  }
}

/** Upsert one outcome by changeId, newest first, capped. */
export function upsertRecipeOutcome(recipe: RecipeRecord, outcome: RecipeOutcome): RecipeRecord {
  const outcomes = [outcome, ...recipe.outcomes.filter(row => row.changeId !== outcome.changeId)].slice(0, RECIPE_OUTCOMES_MAX)
  return { ...recipe, outcomes, updatedAt: Math.max(recipe.updatedAt, outcome.at) }
}

/** A live change tagged with a recipe, reduced to what stats need. */
export interface LiveRecipeChange {
  readonly changeId: string
  readonly title: string
  /** The recipe revision the change is pinned to. */
  readonly revision: number
  readonly terminal: boolean
  /** Meaningful only when terminal: closeout set. */
  readonly accepted: boolean
  readonly failedRounds: number
  /** Cost summed over the change's runs so far, when any run recorded it. */
  readonly tokens?: number
  readonly wallMs?: number
  readonly at: number
}

/**
 * The outcome rows a live change already implies. Stored rows lose to the live
 * derivation for the same changeId, so a change counted here is never double-counted.
 */
export function mergeRecipeOutcomes(stored: readonly RecipeOutcome[], live: readonly LiveRecipeChange[]): RecipeOutcome[] {
  const liveIds = new Set(live.filter(row => row.terminal).map(row => row.changeId))
  const merged: RecipeOutcome[] = [
    ...live.filter(row => row.terminal).map(row => ({
      changeId: row.changeId, title: row.title, revision: row.revision,
      result: row.accepted ? 'accepted' as const : 'cancelled' as const, failedRounds: row.failedRounds,
      ...(row.tokens !== undefined ? { tokens: row.tokens } : {}),
      ...(row.wallMs !== undefined ? { wallMs: row.wallMs } : {}),
      at: row.at,
    })),
    ...stored.filter(row => !liveIds.has(row.changeId)),
  ]
  return merged.sort((a, b) => b.at - a.at || a.changeId.localeCompare(b.changeId))
}

/** Accepted/cancelled counts and total failed rounds of one revision, plus its live in-flight count. */
export interface RecipeRevisionStats {
  readonly revision: number
  readonly accepted: number
  readonly cancelled: number
  readonly failedRounds: number
  readonly inFlight: number
  /** Mean cost over the accepted outcomes that recorded it; omitted when none did. */
  readonly avgTokens?: number
  readonly avgWallMs?: number
}

/** Stats per revision, newest revision first; revisions with nothing recorded are omitted. */
export function recipeRevisionStats(recipe: RecipeRecord, live: readonly LiveRecipeChange[]): RecipeRevisionStats[] {
  const byRevision = new Map<number, { accepted: number; cancelled: number; failedRounds: number; inFlight: number; tokens: number; tokenCount: number; wallMs: number; wallCount: number }>()
  const cell = (revision: number) => {
    let row = byRevision.get(revision)
    if (!row) { row = { accepted: 0, cancelled: 0, failedRounds: 0, inFlight: 0, tokens: 0, tokenCount: 0, wallMs: 0, wallCount: 0 }; byRevision.set(revision, row) }
    return row
  }
  for (const outcome of mergeRecipeOutcomes(recipe.outcomes, live)) {
    const row = cell(outcome.revision)
    if (outcome.result === 'accepted') {
      row.accepted += 1
      if (outcome.tokens !== undefined) { row.tokens += outcome.tokens; row.tokenCount += 1 }
      if (outcome.wallMs !== undefined) { row.wallMs += outcome.wallMs; row.wallCount += 1 }
    } else {
      row.cancelled += 1
    }
    row.failedRounds += outcome.failedRounds
  }
  for (const row of live) {
    if (!row.terminal) cell(row.revision).inFlight += 1
  }
  return [...byRevision.entries()]
    .map(([revision, row]) => ({
      revision,
      accepted: row.accepted, cancelled: row.cancelled, failedRounds: row.failedRounds, inFlight: row.inFlight,
      ...(row.tokenCount > 0 ? { avgTokens: Math.round(row.tokens / row.tokenCount) } : {}),
      ...(row.wallCount > 0 ? { avgWallMs: Math.round(row.wallMs / row.wallCount) } : {}),
    }))
    .sort((a, b) => b.revision - a.revision)
}

/** The one-line stats summary list shows for the current revision. */
export function recipeStatsLine(recipe: RecipeRecord, live: readonly LiveRecipeChange[]): string {
  const stats = recipeRevisionStats(recipe, live)
  const current = stats.find(row => row.revision === recipe.revision)
  if (!current) return `rev${recipe.revision}: no runs yet`
  const done = current.accepted + current.cancelled
  const parts = [
    `rev${recipe.revision}: ${current.accepted} accepted, ${current.cancelled} cancelled`,
    ...(done > 0 ? [`avg ${(current.failedRounds / done).toFixed(1)} failed rounds`] : []),
    ...(current.avgTokens !== undefined ? [`avg ${formatTokens(current.avgTokens)} tok`] : []),
    ...(current.avgWallMs !== undefined ? [`avg ${formatDuration(current.avgWallMs)}`] : []),
    ...(current.inFlight > 0 ? [`${current.inFlight} in flight`] : []),
  ]
  return parts.join(', ')
}
