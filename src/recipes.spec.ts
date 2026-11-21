import { describe, expect, it } from 'vitest'
import { RECIPE_HISTORY_MAX, RECIPE_OUTCOMES_MAX, type RecipeRecord } from './contracts.ts'
import {
  mergeRecipeOutcomes,
  recipeBodyAt,
  recipeRevisionStats,
  recipeStatsLine,
  recipeVersionAt,
  reviseRecipe,
  sameRecipeBody,
  upsertRecipeOutcome,
  type LiveRecipeChange,
} from './recipes.ts'

function record(partial: Partial<RecipeRecord> = {}): RecipeRecord {
  return {
    id: 'rcp-1', name: 'Weekly', revision: 1, history: [], outcomes: [], createdAt: 1, updatedAt: 1,
    goal: 'ship the weekly report',
    requirements: [{ requirementRef: 'goal', text: 'ship the weekly report', required: true }],
    ...partial,
  }
}

function live(partial: Partial<LiveRecipeChange>): LiveRecipeChange {
  return { changeId: 'c-1', title: 'Run', revision: 1, terminal: false, accepted: false, failedRounds: 0, at: 10, ...partial }
}

describe('task recipes', () => {
  it('caps revision history at 10, newest first', () => {
    let recipe = record()
    for (let round = 1; round <= 12; round++) {
      recipe = reviseRecipe(recipe, { ...recipe, goal: `goal ${round + 1}`, name: recipe.name, reason: `r${round}` }, round + 1)
    }
    expect(recipe.revision).toBe(13)
    expect(recipe.history).toHaveLength(RECIPE_HISTORY_MAX)
    expect(recipe.history.map(row => row.revision)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
    expect(recipe.history[0]!.reason).toBe('r11')
    expect(recipe.reason).toBe('r12')
  })

  it('restores an earlier revision as a new revision', () => {
    let recipe = record({ goal: 'v1 goal' })
    recipe = reviseRecipe(recipe, { ...recipe, goal: 'v2 goal', name: recipe.name, reason: 'try v2' }, 2)
    const restored = reviseRecipe(recipe, { ...recipeBodyAt(recipe, 1), name: recipeVersionAt(recipe, 1)!.name, reason: 'v2 failed' }, 3)
    expect(restored.revision).toBe(3)
    expect(restored.goal).toBe('v1 goal')
    expect(restored.history[0]!.revision).toBe(2)
    expect(restored.history[0]!.goal).toBe('v2 goal')
    expect(recipeVersionAt(restored, 1)!.goal).toBe('v1 goal')
  })

  it('detects a revise that changes nothing', () => {
    const recipe = record({ name: 'Weekly', dir: '/proj' })
    expect(sameRecipeBody({ ...recipe, name: recipe.name }, recipe)).toBe(true)
    expect(sameRecipeBody({ ...recipe, goal: 'other' }, recipe)).toBe(false)
    expect(sameRecipeBody({ ...recipe, name: 'renamed' }, recipe)).toBe(false)
    expect(sameRecipeBody({ ...recipe, constraints: undefined }, { ...recipe, constraints: [] })).toBe(false)
  })

  it('pins a change to its revision body and falls back when history capped out', () => {
    let recipe = record({ goal: 'first' })
    for (let round = 1; round <= 12; round++) {
      recipe = reviseRecipe(recipe, { ...recipe, goal: `goal ${round + 1}`, name: recipe.name, reason: `r${round}` }, round + 1)
    }
    expect(recipeBodyAt(recipe, 13).goal).toBe('goal 13')
    expect(recipeBodyAt(recipe, 12).goal).toBe('goal 12')
    // revision 1 and 2 fell out of the capped history: fall back to current
    expect(recipeBodyAt(recipe, 1).goal).toBe('goal 13')
    expect(recipeBodyAt(recipe, 2).goal).toBe('goal 13')
  })

  it('upserts outcomes by changeId and caps at 50, newest first', () => {
    let recipe = record()
    recipe = upsertRecipeOutcome(recipe, { changeId: 'c-1', title: 'T', revision: 1, result: 'cancelled', failedRounds: 2, at: 5 })
    recipe = upsertRecipeOutcome(recipe, { changeId: 'c-1', title: 'T', revision: 1, result: 'accepted', failedRounds: 3, at: 7 })
    expect(recipe.outcomes).toHaveLength(1)
    expect(recipe.outcomes[0]).toMatchObject({ result: 'accepted', failedRounds: 3 })
    for (let index = 0; index < 60; index++) {
      recipe = upsertRecipeOutcome(recipe, { changeId: `c-${index + 2}`, title: 'T', revision: 1, result: 'accepted', failedRounds: 0, at: 100 + index })
    }
    expect(recipe.outcomes).toHaveLength(RECIPE_OUTCOMES_MAX)
    expect(recipe.outcomes[0]!.changeId).toBe('c-61')
    expect(recipe.outcomes.some(row => row.changeId === 'c-1')).toBe(false)
  })

  it('merges stored outcomes with live changes; live wins and in-flight counts', () => {
    const recipe = record({
      outcomes: [
        { changeId: 'c-old', title: 'Old', revision: 1, result: 'accepted', failedRounds: 1, at: 3 },
        { changeId: 'c-live', title: 'Stale', revision: 1, result: 'cancelled', failedRounds: 0, at: 4 },
      ],
    })
    const changes = [
      live({ changeId: 'c-live', title: 'Live', terminal: true, accepted: true, failedRounds: 2, at: 9 }),
      live({ changeId: 'c-new', title: 'New', terminal: true, accepted: false, failedRounds: 1, at: 8 }),
      live({ changeId: 'c-open', title: 'Open' }),
    ]
    const merged = mergeRecipeOutcomes(recipe.outcomes, changes)
    expect(merged.map(row => row.changeId)).toEqual(['c-live', 'c-new', 'c-old'])
    expect(merged.find(row => row.changeId === 'c-live')).toMatchObject({ title: 'Live', result: 'accepted', failedRounds: 2 })
    const stats = recipeRevisionStats(recipe, changes)
    expect(stats).toEqual([{ revision: 1, accepted: 2, cancelled: 1, failedRounds: 4, inFlight: 1 }])
    expect(recipeStatsLine(recipe, changes)).toBe('rev1: 2 accepted, 1 cancelled, avg 1.3 failed rounds, 1 in flight')
  })

  it('reports stats per revision and no runs when empty', () => {
    const recipe = record({ revision: 3 })
    expect(recipeStatsLine(recipe, [])).toBe('rev3: no runs yet')
    const changes = [live({ revision: 2, terminal: true, accepted: true }), live({ revision: 3, terminal: true, accepted: false, failedRounds: 1, at: 11 })]
    const stats = recipeRevisionStats(recipe, changes)
    expect(stats.map(row => row.revision)).toEqual([3, 2])
    expect(stats[0]).toMatchObject({ accepted: 0, cancelled: 1 })
    expect(stats[1]).toMatchObject({ accepted: 1, cancelled: 0 })
  })
})
