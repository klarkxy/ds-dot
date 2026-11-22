import { describe, expect, it } from 'vitest'
import { RECIPE_HISTORY_MAX, RECIPE_OUTCOMES_MAX, type RecipeRecord } from './contracts.ts'
import {
  mergeRecipeOutcomes,
  recipeBodyAt,
  recipeRegression,
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

  it('averages run cost over the accepted outcomes that recorded it', () => {
    const recipe = record({ revision: 2, outcomes: [
      { changeId: 'c-1', title: 'a', revision: 2, result: 'accepted', failedRounds: 0, tokens: 100, wallMs: 1000, at: 5 },
      { changeId: 'c-2', title: 'b', revision: 2, result: 'accepted', failedRounds: 0, at: 6 },
      { changeId: 'c-3', title: 'c', revision: 2, result: 'cancelled', failedRounds: 0, tokens: 900, wallMs: 9000, at: 7 },
    ] })
    const stats = recipeRevisionStats(recipe, [])
    // c-2 has no cost fields so only c-1 counts; cancelled rows never feed the averages.
    expect(stats[0]).toMatchObject({ revision: 2, accepted: 2, cancelled: 1, avgTokens: 100, avgWallMs: 1000 })
    expect(recipeStatsLine(recipe, [])).toBe('rev2: 2 accepted, 1 cancelled, avg 0.0 failed rounds, avg per accepted 100 tok, avg per accepted 1.0s')
    // A live terminal change feeds the same fields through the merge.
    const liveRow = live({ changeId: 'c-9', terminal: true, accepted: true, revision: 2, tokens: 50, wallMs: 500, at: 9 })
    expect(mergeRecipeOutcomes(recipe.outcomes, [liveRow])[0]).toMatchObject({ changeId: 'c-9', tokens: 50, wallMs: 500 })
    expect(recipeRevisionStats(recipe, [liveRow])[0]).toMatchObject({ accepted: 3, avgTokens: 75, avgWallMs: 750 })
    // No cost recorded anywhere — the averages stay off the line.
    const plain = record({ revision: 1, outcomes: [{ changeId: 'c-1', title: 'a', revision: 1, result: 'accepted', failedRounds: 0, at: 5 }] })
    expect(recipeRevisionStats(plain, [])[0]).not.toHaveProperty('avgTokens')
    expect(recipeStatsLine(plain, [])).toBe('rev1: 1 accepted, 0 cancelled, avg 0.0 failed rounds')
  })
})

describe('recipeRegression', () => {
  const stat = (revision: number, partial: Partial<import('./recipes.ts').RecipeRevisionStats> = {}) => ({
    revision, accepted: 0, cancelled: 0, failedRounds: 0, inFlight: 0, ...partial,
  })
  /** Recipe at rev 3 with revs 1 and 2 restorable in history. */
  const withHistory = () => {
    let recipe = record({ goal: 'v1' })
    recipe = reviseRecipe(recipe, { ...recipe, goal: 'v2', name: recipe.name, reason: 'r' }, 2)
    recipe = reviseRecipe(recipe, { ...recipe, goal: 'v3', name: recipe.name, reason: 'r' }, 3)
    return recipe
  }

  it('needs at least three finished outcomes on the current revision', () => {
    const recipe = withHistory()
    const early = stat(2, { accepted: 4, cancelled: 1 })
    expect(recipeRegression(recipe, [stat(3, { accepted: 0, cancelled: 2 }), early])).toBeUndefined()
  })

  it('needs a restorable earlier revision with three finished outcomes', () => {
    const recipe = withHistory()
    // rev 9 was never in history → not restorable even though its rate is great.
    const stats = [stat(3, { accepted: 0, cancelled: 3 }), stat(9, { accepted: 5 })]
    expect(recipeRegression(recipe, stats)).toBeUndefined()
    // rev 1 only has two finished → not a candidate either.
    expect(recipeRegression(recipe, [stat(3, { accepted: 0, cancelled: 3 }), stat(1, { accepted: 2 })])).toBeUndefined()
  })

  it('flags an acceptance drop at the 0.34 boundary, not below it', () => {
    const recipe = withHistory()
    const early = stat(1, { accepted: 4, cancelled: 1 }) // rate 0.8
    const onEdge = stat(3, { accepted: 2, cancelled: 3 })  // rate 0.4 → diff 0.4
    expect(recipeRegression(recipe, [onEdge, early])).toMatchObject({ betterRevision: 1, reason: 'acceptance' })
    // diff 0.3 → no acceptance flag; rates differ >0.1 so rework/cost stay off.
    const close = stat(3, { accepted: 5, cancelled: 5 }) // rate 0.5 → diff 0.3
    expect(recipeRegression(recipe, [close, early])).toBeUndefined()
  })

  it('flags rework at +1 failed round per finished outcome when rates match', () => {
    const recipe = withHistory()
    const early = stat(1, { accepted: 4, cancelled: 1, failedRounds: 1 })  // rate 0.8, rework 0.2
    const current = stat(3, { accepted: 4, cancelled: 1, failedRounds: 6 }) // rate 0.8, rework 1.2 → +1.0
    expect(recipeRegression(recipe, [current, early])).toMatchObject({ betterRevision: 1, reason: 'rework' })
    const notEnough = stat(3, { accepted: 4, cancelled: 1, failedRounds: 5 }) // rework 1.0 → +0.8
    expect(recipeRegression(recipe, [notEnough, early])).toBeUndefined()
    // rates differ by more than 0.1 but less than the acceptance bar → no flag
    const earlyMid = stat(1, { accepted: 2, cancelled: 3, failedRounds: 0 }) // rate 0.4
    const farRate = stat(3, { accepted: 1, cancelled: 4, failedRounds: 6 })  // rate 0.2 → diff 0.2
    expect(recipeRegression(recipe, [farRate, earlyMid])).toBeUndefined()
  })

  it('flags cost at 1.5× average tokens when rates match', () => {
    const recipe = withHistory()
    const early = stat(1, { accepted: 4, cancelled: 1, avgTokens: 100 })
    const onEdge = stat(3, { accepted: 4, cancelled: 1, avgTokens: 150 })
    expect(recipeRegression(recipe, [onEdge, early])).toMatchObject({ betterRevision: 1, reason: 'cost' })
    const below = stat(3, { accepted: 4, cancelled: 1, avgTokens: 149 })
    expect(recipeRegression(recipe, [below, early])).toBeUndefined()
    // missing averages → no cost flag
    const noAvg = stat(3, { accepted: 4, cancelled: 1 })
    expect(recipeRegression(recipe, [noAvg, early])).toBeUndefined()
    expect(recipeRegression(recipe, [onEdge, stat(1, { accepted: 4, cancelled: 1 })])).toBeUndefined()
    // a zero earlier average would flag any nonzero spend → not a regression
    expect(recipeRegression(recipe, [onEdge, stat(1, { accepted: 4, cancelled: 1, avgTokens: 0 })])).toBeUndefined()
  })

  it('picks the best earlier revision by rate, then lower rework, then lower tokens', () => {
    const recipe = withHistory()
    const current = stat(3, { accepted: 0, cancelled: 4 }) // rate 0
    const stats = [
      current,
      stat(1, { accepted: 4, cancelled: 1, failedRounds: 4 }), // rate 0.8, rework 0.8
      stat(2, { accepted: 4, cancelled: 1, failedRounds: 1 }), // rate 0.8, rework 0.2 → wins
    ]
    expect(recipeRegression(recipe, stats)).toMatchObject({ betterRevision: 2 })
    // equal rate and rework → lower tokens wins
    const withTokens = [
      current,
      stat(1, { accepted: 4, cancelled: 1, failedRounds: 2, avgTokens: 300 }),
      stat(2, { accepted: 4, cancelled: 1, failedRounds: 2, avgTokens: 100 }),
    ]
    expect(recipeRegression(recipe, withTokens)).toMatchObject({ betterRevision: 2 })
    // higher rate beats lower rework
    const higherRate = [
      current,
      stat(1, { accepted: 4, cancelled: 1, failedRounds: 10 }), // rate 0.8, rework 2.0
      stat(2, { accepted: 5, cancelled: 0, failedRounds: 5 }),  // rate 1.0 → wins
    ]
    expect(recipeRegression(recipe, higherRate)).toMatchObject({ betterRevision: 2 })
  })

  it('acceptance outranks rework and cost for the same candidate', () => {
    const recipe = withHistory()
    const early = stat(1, { accepted: 4, cancelled: 1, failedRounds: 0, avgTokens: 100 })
    // rate diff 0.8 (acceptance), rework diff +1.4, tokens 1.5× — reason is acceptance.
    const current = stat(3, { accepted: 0, cancelled: 4, failedRounds: 6, avgTokens: 150 })
    expect(recipeRegression(recipe, [current, early])?.reason).toBe('acceptance')
  })

  it('writes one summary line with both revisions\u2019 numbers', () => {
    const recipe = withHistory()
    const regression = recipeRegression(recipe, [
      stat(3, { accepted: 1, cancelled: 3, failedRounds: 10 }),
      stat(2, { accepted: 4, cancelled: 1, failedRounds: 2 }),
    ])
    expect(regression?.summary).toBe('rev 3: 1/4 accepted, 2.5 failed rounds avg; rev 2: 4/5 accepted, 0.4 failed rounds avg')
  })
})
