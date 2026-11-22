/** Read-only aggregate recommendations over the pinned LMArena document. */
import { readFileSync } from 'node:fs'

export interface ArenaCatalogModel { readonly provider: string; readonly model: string; readonly name: string }
export interface ArenaModelQuery { readonly tags?: string; readonly limit?: number }

export interface ArenaEvidence {
  readonly arena: 'text' | 'webdev' | 'vision' | 'document' | 'search' | 'agent'
  readonly category: string
  readonly date: string
  readonly modelName: string
  readonly rank: number
  readonly rankCount: number
  readonly votes: number
  readonly rating?: number | null
  readonly ratingLower?: number | null
  readonly ratingUpper?: number | null
}
export interface ArenaDocumentModel {
  readonly id: string
  readonly name: string
  readonly organization: string
  readonly license: string
  readonly evidence: readonly ArenaEvidence[]
}
export interface ArenaDocument {
  readonly schemaVersion: 1
  readonly source: {
    readonly dataset: string
    readonly revision: string
    readonly lastModified: string
    readonly license: string
    readonly url: string
  }
  readonly boards: Readonly<Record<string, string>>
  readonly models: readonly ArenaDocumentModel[]
}

interface Source { readonly key?: string; readonly arena: ArenaEvidence['arena']; readonly category: string; readonly weight: number }
const SOURCES = {
  general: [{ arena: 'text', category: 'overall', weight: 0.6 }, { arena: 'agent', category: 'overall', weight: 0.4 }],
  coding: [{ arena: 'text', category: 'coding', weight: 0.4 }, { arena: 'webdev', category: 'overall', weight: 0.3 }, { arena: 'agent', category: 'code', weight: 0.3 }],
  debugging: [{ arena: 'text', category: 'coding', weight: 0.5 }, { arena: 'agent', category: 'code', weight: 0.5 }],
  review: [{ arena: 'text', category: 'coding', weight: 0.3 }, { arena: 'agent', category: 'code', weight: 0.4 }, { arena: 'text', category: 'hard_prompts', weight: 0.3 }],
  frontend: [{ arena: 'webdev', category: 'overall', weight: 0.5 }, { arena: 'webdev', category: 'webdev-react', weight: 0.2 }, { arena: 'webdev', category: 'webdev-html', weight: 0.1 }, { arena: 'text', category: 'coding', weight: 0.2 }],
  writing: [{ arena: 'text', category: 'creative_writing', weight: 0.6 }, { arena: 'text', category: 'industry_writing_and_literature_and_language', weight: 0.2 }, { arena: 'text', category: 'overall', weight: 0.2 }],
  research: [{ arena: 'search', category: 'overall', weight: 0.5 }, { arena: 'document', category: 'overall', weight: 0.2 }, { arena: 'agent', category: 'work', weight: 0.3 }],
  analysis: [{ arena: 'text', category: 'hard_prompts', weight: 0.4 }, { arena: 'document', category: 'overall', weight: 0.2 }, { arena: 'agent', category: 'work', weight: 0.2 }, { arena: 'text', category: 'longer_query', weight: 0.2 }],
  planning: [{ arena: 'text', category: 'hard_prompts', weight: 0.3 }, { arena: 'agent', category: 'work', weight: 0.4 }, { arena: 'agent', category: 'overall', weight: 0.2 }, { arena: 'text', category: 'overall', weight: 0.1 }],
  vision: [{ arena: 'vision', category: 'overall', weight: 0.7 }, { arena: 'webdev', category: 'image_to_webdev', weight: 0.3 }],
  ocr: [{ arena: 'vision', category: 'ocr', weight: 0.7 }, { arena: 'document', category: 'overall', weight: 0.2 }, { arena: 'vision', category: 'overall', weight: 0.1 }],
  document: [{ arena: 'document', category: 'overall', weight: 0.6 }, { arena: 'text', category: 'longer_query', weight: 0.2 }, { arena: 'agent', category: 'work', weight: 0.2 }],
  chinese: [{ arena: 'text', category: 'chinese', weight: 0.8 }, { arena: 'text', category: 'overall', weight: 0.2 }],
  math: [{ arena: 'text', category: 'math', weight: 0.7 }, { arena: 'text', category: 'hard_prompts', weight: 0.3 }],
  instruction: [{ arena: 'text', category: 'instruction_following', weight: 0.7 }, { arena: 'agent', category: 'overall', weight: 0.3 }],
  'multi-turn': [{ arena: 'text', category: 'multi_turn', weight: 0.6 }, { arena: 'agent', category: 'chat', weight: 0.4 }],
} as const satisfies Readonly<Record<string, readonly Source[]>>

const TAG_ALIASES: Readonly<Record<string, keyof typeof SOURCES>> = {
  code: 'coding',
  webdev: 'frontend',
  'creative-writing': 'writing',
  doc: 'document',
  'long-document': 'document',
  agent: 'general',
  chat: 'general',
}
export const ARENA_TAGS = Object.keys(SOURCES).sort() as Array<keyof typeof SOURCES>

const EFFORT_LABELS = new Set(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'thinking', 'non-reasoning', 'non reasoning', 'reasoning', 'off'])
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  k31pro: 'kimik31pro',
  k31prohighspeed: 'kimik31pro',
  k3: 'kimik3',
  k3256k: 'kimik3',
}

const DATE_SUFFIX = /20\d{6}$/

/** Conservative identity normalization; unmatched routes stay explicitly unranked. Dated revisions stay distinct. */
export function arenaModelId(value: string): string {
  const withoutEffort = value.trim().toLowerCase().replace(/\(([^()]*)\)/g, (whole, label: string) => EFFORT_LABELS.has(label.trim()) ? '' : whole)
  const compact = withoutEffort.replace(/[^a-z0-9]+/g, '')
  return MODEL_ALIASES[compact] ?? compact
}

function baseArenaModelId(id: string): string {
  return id.replace(DATE_SUFFIX, '')
}

/** Dated host routes match only that revision; an undated alias may follow a unique dated board row. */
function documentModelFor(model: ArenaCatalogModel, document: ArenaDocument, byId: Map<string, ArenaDocumentModel>): ArenaDocumentModel | undefined {
  const id = arenaModelId(model.model)
  const exact = byId.get(id)
  if (exact) return exact
  if (DATE_SUFFIX.test(id)) return undefined
  const matches = document.models.filter(row => baseArenaModelId(row.id) === id)
  return matches.length === 1 ? matches[0] : undefined
}

export class ArenaQueryError extends Error {
  constructor(message: string) { super(message); this.name = 'ArenaQueryError' }
}

let cachedDocument: ArenaDocument | undefined

/** Load only from the package; recommendations never perform network I/O. */
export function loadArenaDocument(): ArenaDocument {
  if (cachedDocument) return cachedDocument
  const parsed = JSON.parse(readFileSync(new URL('../src/model-arena.json', import.meta.url), 'utf8')) as ArenaDocument
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.models) || typeof parsed.source?.revision !== 'string') {
    throw new ArenaQueryError('the bundled Arena document has an unsupported shape')
  }
  cachedDocument = parsed
  return cachedDocument
}

interface Ranked {
  readonly model: ArenaCatalogModel
  readonly score: number
  readonly coverage: number
  readonly evidence: readonly { readonly source: Source; readonly evidence: ArenaEvidence; readonly adjusted: number }[]
}

function percentile(evidence: ArenaEvidence): number {
  if (evidence.rankCount <= 1) return 100
  return 100 * (evidence.rankCount - evidence.rank) / (evidence.rankCount - 1)
}

/** Shrink low-vote rankings toward neutral instead of treating a new #1 as certain. */
function adjustedPercentile(evidence: ArenaEvidence): number {
  const reliability = evidence.votes / (evidence.votes + 1000)
  return 50 + (percentile(evidence) - 50) * reliability
}

function parseTags(raw: string | undefined): Array<keyof typeof SOURCES> {
  const parts = (raw?.trim() || 'general').split(/[\s,+/|]+/).map(part => part.trim().toLowerCase()).filter(Boolean)
  const tags: Array<keyof typeof SOURCES> = []
  const unknown: string[] = []
  for (const part of parts) {
    const tag = (part in SOURCES ? part : TAG_ALIASES[part]) as keyof typeof SOURCES | undefined
    if (!tag) unknown.push(part)
    else if (!tags.includes(tag)) tags.push(tag)
  }
  if (unknown.length > 0) throw new ArenaQueryError(`unknown model tag(s): ${unknown.join(', ')}. Supported tags: ${ARENA_TAGS.join(', ')}`)
  return tags
}

export function rankArenaModels(models: readonly ArenaCatalogModel[], query: ArenaModelQuery, document: ArenaDocument): Ranked[] {
  const tags = parseTags(query.tags)
  const weighted = new Map<string, number>()
  for (const tag of tags) for (const source of SOURCES[tag]) {
    const key = `${source.arena}/${source.category}`
    weighted.set(key, (weighted.get(key) ?? 0) + source.weight / tags.length)
  }
  const sources = [...weighted.entries()].map(([key, weight]): Source & { readonly key: string } => {
    const [arena, category] = key.split('/')
    return { key, arena: arena as ArenaEvidence['arena'], category: category!, weight }
  })
  const totalWeight = sources.reduce((sum, source) => sum + source.weight, 0)
  const byId = new Map(document.models.map(model => [model.id, model]))
  const ranked: Ranked[] = []
  for (const model of models) {
    const documentModel = documentModelFor(model, document, byId)
    if (!documentModel) continue
    const evidenceByBoard = new Map(documentModel.evidence.map(evidence => [`${evidence.arena}/${evidence.category}`, evidence]))
    const found: Ranked['evidence'][number][] = []
    let coveredWeight = 0
    let adjustedSum = 0
    for (const source of sources) {
      const evidence = evidenceByBoard.get(source.key)
      if (!evidence) continue
      const adjusted = adjustedPercentile(evidence)
      found.push({ source, evidence, adjusted })
      coveredWeight += source.weight
      adjustedSum += adjusted * source.weight
    }
    if (found.length === 0) continue
    const score = (adjustedSum + (totalWeight - coveredWeight) * 50) / totalWeight
    found.sort((a, b) => b.source.weight * b.adjusted - a.source.weight * a.adjusted || a.source.key!.localeCompare(b.source.key!))
    ranked.push({ model, score, coverage: coveredWeight / totalWeight, evidence: found })
  }
  const catalogOrder = new Map(models.map((model, index) => [`${model.provider}/${model.model}`, index]))
  ranked.sort((a, b) => b.score - a.score || catalogOrder.get(`${a.model.provider}/${a.model.model}`)! - catalogOrder.get(`${b.model.provider}/${b.model.model}`)!)
  return ranked
}

function evidenceLabel(item: Ranked['evidence'][number]): string {
  return `${item.source.arena}/${item.source.category} #${item.evidence.rank}/${item.evidence.rankCount}`
}

/** A bounded decision card, never a dispatch or a route mutation. */
export function formatArenaRecommendation(models: readonly ArenaCatalogModel[], query: ArenaModelQuery, document = loadArenaDocument()): string {
  if (models.length === 0) return 'No model is eligible under the current task-model rule.'
  const tags = parseTags(query.tags)
  const ranked = rankArenaModels(models, query, document)
  const requestedLimit = query.limit === undefined || !Number.isFinite(query.limit) ? 5 : Math.floor(query.limit)
  const limit = Math.min(10, Math.max(1, requestedLimit))
  const lines = [
    `Arena aggregate for ${tags.join(' + ')}: ${ranked.length} of ${models.length} eligible model(s) have matching evidence.`,
    `Source: ${document.source.dataset}@${document.source.revision.slice(0, 8)} (${document.source.license}). Scores aggregate within-board percentiles with low-vote shrinkage; missing boards are neutral.`,
    'Recommendation only: no model was selected or dispatched. Pass your explicit provider/model choice to dot_task action=dispatch; a human-named model is a pin, never a candidate to replace.',
  ]
  const shown = ranked.slice(0, limit)
  shown.forEach((entry, index) => {
    const evidence = entry.evidence.slice(0, 2).map(evidenceLabel).join(', ')
    lines.push(`${index + 1}. ${entry.model.provider}/${entry.model.model} — ${entry.score.toFixed(1)}/100, coverage ${Math.round(entry.coverage * 100)}% (${evidence})`)
  })
  const shownKeys = new Set(shown.map(entry => `${entry.model.provider}/${entry.model.model}`))
  const unranked = models.filter(model => !shownKeys.has(`${model.provider}/${model.model}`) && !ranked.some(entry => entry.model.provider === model.provider && entry.model.model === model.model))
  for (const model of unranked.slice(0, Math.max(0, limit - shown.length))) {
    lines.push(`- ${model.provider}/${model.model} — no matching Arena evidence; still eligible, no score inferred`)
  }
  if (ranked.length > shown.length) lines.push(`(${ranked.length - shown.length} more ranked model(s) not shown; use raw mode to inspect every eligible route)`)
  return lines.join('\n')
}
