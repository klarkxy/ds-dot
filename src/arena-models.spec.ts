import { describe, expect, it } from 'vitest'
import { arenaModelId, ArenaQueryError, formatArenaRecommendation, loadArenaDocument, rankArenaModels, type ArenaDocument, type ArenaEvidence } from './arena-models.ts'

const evidence = (arena: ArenaEvidence['arena'], category: string, rank: number, rankCount: number, votes: number): ArenaEvidence => ({
  arena, category, date: '2026-11-20', modelName: 'Fixture', rank, rankCount, votes,
  rating: 1500, ratingLower: 1490, ratingUpper: 1510,
})
const document: ArenaDocument = {
  schemaVersion: 1,
  source: { dataset: 'fixture/arena', revision: '1234567890abcdef', lastModified: '2026-11-20', license: 'CC BY 4.0', url: 'https://example.invalid' },
  boards: {},
  models: [
    { id: 'strongmodel', name: 'Strong', organization: 'fixture', license: 'Proprietary', evidence: [evidence('text', 'coding', 1, 101, 9000), evidence('agent', 'code', 2, 51, 4000)] },
    { id: 'fastmodel', name: 'Fast', organization: 'fixture', license: 'Proprietary', evidence: [evidence('text', 'coding', 51, 101, 1000)] },
    { id: 'specialmodel', name: 'Special', organization: 'fixture', license: 'Proprietary', evidence: [evidence('vision', 'overall', 1, 21, 3000)] },
  ],
}
const models = [
  { provider: 'p', model: 'strong-model', name: 'Strong' },
  { provider: 'p', model: 'fast-model', name: 'Fast' },
  { provider: 'q', model: 'unknown-model', name: 'Unknown' },
]

describe('Arena model identity', () => {
  it('normalizes provider model ids and effort variants without inventing revision matches', () => {
    expect(arenaModelId('claude-fable-5-2')).toBe('claudefable52')
    expect(arenaModelId('Claude Fable 5.2 (xHigh)')).toBe('claudefable52')
    expect(arenaModelId('gpt-4o-2024-08-06')).toBe('gpt4o')
    expect(arenaModelId('k3.1-pro')).toBe('kimik31pro')
    expect(arenaModelId('deepseek-flash')).not.toBe('deepseekv41flash')
    expect(arenaModelId('deepseek-v4.1-flash-1017')).not.toBe('deepseekv41flash')
  })
})

describe('aggregate Arena ranking', () => {
  it('ranks by within-board percentiles and is deterministic across calls', () => {
    const first = rankArenaModels(models, { tags: 'coding' }, document)
    const second = rankArenaModels(models, { tags: 'coding' }, document)
    expect(first.map(row => row.model.model)).toEqual(['strong-model', 'fast-model'])
    expect(first).toEqual(second)
    expect(first[0]!.score).toBeGreaterThan(first[1]!.score)
    expect(first[0]!.coverage).toBeGreaterThan(first[1]!.coverage)
    expect(first[0]!.evidence[0]!.evidence.rank).toBe(1)
  })

  it('combines tags, treats missing boards as neutral, and leaves unknown routes unranked', () => {
    const ranked = rankArenaModels(models, { tags: 'coding,vision' }, document)
    expect(ranked.map(row => row.model.model)).toEqual(['strong-model', 'fast-model'])
    expect(ranked[0]!.coverage).toBeLessThan(1)
    expect(ranked.some(row => row.model.model === 'unknown-model')).toBe(false)
  })

  it('shrinks low-vote evidence toward neutral', () => {
    const lowVotes = rankArenaModels(models, { tags: 'coding' }, document)
    const highVotesDocument = structuredClone(document)
    highVotesDocument.models[0]!.evidence[0]!.votes = 0
    const zeroVotes = rankArenaModels(models, { tags: 'coding' }, highVotesDocument)
    expect(zeroVotes[0]!.evidence.find(row => row.source.category === 'coding')!.adjusted).toBe(50)
    expect(lowVotes[0]!.evidence.find(row => row.source.category === 'coding')!.adjusted).toBeGreaterThan(90)
  })

  it('rejects unknown tags with the supported vocabulary', () => {
    expect(() => rankArenaModels(models, { tags: 'coding,telepathy' }, document)).toThrow(ArenaQueryError)
    expect(() => rankArenaModels(models, { tags: 'telepathy' }, document)).toThrow(/Supported tags: .*coding/)
  })
})

describe('Arena recommendation output', () => {
  it('is a bounded read-only recommendation, not a dispatch', () => {
    const output = formatArenaRecommendation(models, { tags: 'coding', limit: 1 }, document)
    expect(output).toContain('1. p/strong-model')
    expect(output).not.toContain('2. p/fast-model')
    expect(output).toContain('Recommendation only: no model was selected or dispatched')
    expect(output).toContain('a human-named model is a pin')
    expect(output).toContain('fixture/arena@12345678')
    expect(output).toContain('(1 more ranked model(s) not shown')
  })

  it('keeps unmatched routes eligible without fabricating a score', () => {
    const output = formatArenaRecommendation([models[2]!], { tags: 'general' }, document)
    expect(output).toContain('q/unknown-model — no matching Arena evidence; still eligible, no score inferred')
    expect(output).toContain('0 of 1 eligible model(s) have matching evidence')
  })

  it('loads the pinned local document with real provenance', () => {
    const bundled = loadArenaDocument()
    expect(bundled.source.dataset).toBe('lmarena-ai/leaderboard-dataset')
    expect(bundled.source.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(bundled.models.length).toBeGreaterThan(50)
  })
})
