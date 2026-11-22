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
    expect(arenaModelId('gpt-4o-2024-08-06')).toBe('gpt4o20240806')
    expect(arenaModelId('k3.1-pro')).toBe('kimik31pro')
    expect(arenaModelId('deepseek-flash')).not.toBe('deepseekv41flash')
    expect(arenaModelId('deepseek-v4.1-flash-1017')).not.toBe('deepseekv41flash')
    expect(arenaModelId('DeepSeek-V4.1-Flash-20261017')).toBe('deepseekv41flash20261017')
    expect(arenaModelId('DeepSeek-V4.1-Flash-20260910')).toBe('deepseekv41flash20260910')
    expect(arenaModelId('DeepSeek-V4.1-Flash-20261017')).not.toBe(arenaModelId('DeepSeek-V4.1-Flash-20260910'))
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

  it('does not credit a newer dated route with an older revision\'s board score', () => {
    const dated: ArenaDocument = {
      schemaVersion: 1,
      source: document.source,
      boards: {},
      models: [
        {
          id: 'deepseekv41flash20260910',
          name: 'DeepSeek-V4.1-Flash-20260910',
          organization: 'DeepSeek',
          license: 'Proprietary',
          evidence: [{ arena: 'webdev', category: 'image_to_webdev', date: '2026-11-19', modelName: 'DeepSeek-V4.1-Flash-20260910 (Max)', rank: 15, rankCount: 69, votes: 4000 }],
        },
        {
          id: 'deepseekv41flash20261017',
          name: 'DeepSeek-V4.1-Flash-20261017',
          organization: 'DeepSeek',
          license: 'Proprietary',
          evidence: [{ arena: 'webdev', category: 'webdev-html', date: '2026-11-20', modelName: 'DeepSeek-V4.1-Flash-20261017 (Max)', rank: 17, rankCount: 160, votes: 4000 }],
        },
      ],
    }
    const newer = rankArenaModels([{ provider: 'p', model: 'deepseek-v4.1-flash-20261017', name: 'Flash 1017' }], { tags: 'vision' }, dated)
    expect(newer).toHaveLength(0)
    const older = rankArenaModels([{ provider: 'p', model: 'deepseek-v4.1-flash-20260910', name: 'Flash 0910' }], { tags: 'vision' }, dated)
    expect(older).toHaveLength(1)
    expect(older[0]!.evidence[0]!.evidence.modelName).toContain('20260910')
    const both = rankArenaModels(
      [
        { provider: 'p', model: 'deepseek-v4.1-flash-20261017', name: 'Flash 1017' },
        { provider: 'p', model: 'deepseek-v4.1-flash-20260910', name: 'Flash 0910' },
      ],
      { tags: 'frontend' },
      dated,
    )
    const html = both.find(row => row.model.model.endsWith('20261017'))
    const image = both.find(row => row.model.model.endsWith('20260910'))
    expect(html?.evidence.some(row => row.source.category === 'image_to_webdev')).toBeFalsy()
    expect(image?.evidence.some(row => row.source.category === 'webdev-html')).toBeFalsy()
  })

  it('lets an undated alias follow a unique dated board row and stays unranked when two revisions exist', () => {
    const host = [{ provider: 'openai', model: 'gpt-4.1', name: 'GPT-4.1' }]
    const unique: ArenaDocument = {
      schemaVersion: 1,
      source: document.source,
      boards: {},
      models: [{
        id: 'gpt4120250414',
        name: 'GPT-4.1',
        organization: 'OpenAI',
        license: 'Proprietary',
        evidence: [evidence('text', 'coding', 4, 101, 9000)],
      }],
    }
    expect(rankArenaModels(host, { tags: 'coding' }, unique)).toHaveLength(1)
    const split: ArenaDocument = {
      ...unique,
      models: [
        unique.models[0]!,
        { id: 'gpt4120240806', name: 'GPT-4.1', organization: 'OpenAI', license: 'Proprietary', evidence: [evidence('text', 'coding', 8, 101, 9000)] },
      ],
    }
    expect(rankArenaModels(host, { tags: 'coding' }, split)).toHaveLength(0)
  })

  it('breaks score ties by host catalog order rather than coverage', () => {
    const zero = (arena: ArenaEvidence['arena'], category: string, modelName: string): ArenaEvidence => ({
      arena, category, date: '2026-11-19', modelName, rank: 1, rankCount: 11, votes: 0,
    })
    const tied: ArenaDocument = {
      schemaVersion: 1,
      source: document.source,
      boards: {},
      models: [
        { id: 'lowcoverage', name: 'Low', organization: 'fixture', license: 'Proprietary', evidence: [zero('vision', 'overall', 'Low')] },
        {
          id: 'highcoverage',
          name: 'High',
          organization: 'fixture',
          license: 'Proprietary',
          evidence: [zero('vision', 'overall', 'High'), zero('webdev', 'image_to_webdev', 'High')],
        },
      ],
    }
    const ranked = rankArenaModels(
      [{ provider: 'p', model: 'low-coverage', name: 'Low' }, { provider: 'p', model: 'high-coverage', name: 'High' }],
      { tags: 'vision' },
      tied,
    )
    expect(ranked[0]!.score).toBe(ranked[1]!.score)
    expect(ranked[0]!.coverage).toBeLessThan(ranked[1]!.coverage)
    expect(ranked.map(row => row.model.model)).toEqual(['low-coverage', 'high-coverage'])
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

  it('keeps dated DeepSeek Flash revisions as separate snapshot rows', () => {
    const bundled = loadArenaDocument()
    const older = bundled.models.find(model => model.id === 'deepseekv41flash20260910')
    const newer = bundled.models.find(model => model.id === 'deepseekv41flash20261017')
    expect(older).toBeDefined()
    expect(newer).toBeDefined()
    expect(older!.evidence.some(row => row.modelName.includes('20261017'))).toBe(false)
    expect(newer!.evidence.some(row => row.modelName.includes('20260910'))).toBe(false)
    expect(newer!.evidence.some(row => row.arena === 'webdev' && row.category === 'image_to_webdev')).toBe(false)
  })
})
