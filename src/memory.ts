/**
 * dot's two prompt blocks that the human and dot keep current:
 *
 * - agreements: the human's own standing requirements, one entry per rule,
 *   written verbatim when they ask dot to remember something. They win over
 *   cognition on a clash and are never truncated.
 * - cognition: dot's understanding of the human and of herself — preferences
 *   formed here, shared jokes and what they have accomplished together — kept
 *   as ranked entries: pinned first, then most recently confirmed. Only the
 *   top entries reach the prompt; the rest stay stored as dormant.
 *
 * Both live in DotStore, not on disk, so a task opened in dot's workspace can
 * never edit them or inject into dot's prompt. This file holds the entry rules.
 */
import { TOOL, type AgreementEntry, type CognitionEntry, type KnowledgeEdit } from './contracts.ts'

export class KnowledgeError extends Error {
  constructor(readonly code: 'dot/invalid' | 'dot/unknown-agreement' | 'dot/ambiguous-agreement' | 'dot/unknown-entry' | 'dot/ambiguous-entry' | 'dot/pinned', message: string) { super(message); this.name = 'KnowledgeError' }
}
const BULLET = /^\s*[-*]\s+/
const HEADING = /^\s*#{1,6}\s/

/** One entry as a single line, without a list marker. */
export function normalizeEntry(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(BULLET, '').trim()
}

/**
 * Bulk or legacy text split into entry texts: every non-empty line is one
 * entry with a leading `- `/`* ` marker stripped. `dropHeadings` additionally
 * skips markdown heading lines (cognition); agreements keep them verbatim.
 */
export function splitEntryText(text: string, dropHeadings = false): string[] {
  return text.split(/\r?\n/)
    .filter(line => !dropHeadings || !HEADING.test(line))
    .map(line => line.replace(BULLET, '').trim())
    .filter(Boolean)
}

/** Two entry lists hold the same knowledge when every entry matches field by field. */
export function sameEntries<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((entry, index) => JSON.stringify(entry) === JSON.stringify(b[index]))
}

/**
 * Whether two cognition lists carry the same content — same length and, per
 * position, the same id, text and pin flag. Timestamps do not count: a
 * confirm-only change leaves the content untouched.
 */
export function sameCognitionContent(a: readonly CognitionEntry[], b: readonly CognitionEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => {
    const other = b[index]!
    return entry.id === other.id && entry.text === other.text && (entry.pinned === true) === (other.pinned === true)
  })
}

/** The id a new entry gets: prefix plus one above the largest numeric suffix already in the list. */
export function nextEntryId(prefix: 'a' | 'c', entries: readonly { readonly id: string }[]): string {
  let max = 0
  for (const entry of entries) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(entry.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `${prefix}${max + 1}`
}

/**
 * Agreement bulk text converted to entries: an identical existing entry keeps
 * its id and timestamps; new lines get fresh ids. Used wherever stored text
 * becomes entries — migration, proposal approval, bulk sets.
 */
export function agreementEntriesFromText(text: string, existing: readonly AgreementEntry[], now: number): AgreementEntry[] {
  const pool = [...existing]
  const next: AgreementEntry[] = []
  for (const line of splitEntryText(text)) {
    const index = pool.findIndex(entry => entry.text === line)
    next.push(index >= 0 ? pool.splice(index, 1)[0]! : { id: nextEntryId('a', [...next, ...pool]), text: line, createdAt: now, updatedAt: now })
  }
  return next
}

/** Cognition bulk text converted to entries under the same reuse rule, headings dropped. */
export function cognitionEntriesFromText(text: string, existing: readonly CognitionEntry[], now: number): CognitionEntry[] {
  const pool = [...existing]
  const next: CognitionEntry[] = []
  for (const line of splitEntryText(text, true)) {
    const index = pool.findIndex(entry => entry.text === line)
    next.push(index >= 0 ? pool.splice(index, 1)[0]! : { id: nextEntryId('c', [...next, ...pool]), text: line, createdAt: now, updatedAt: now, seenAt: now })
  }
  return next
}

/** Legacy agreements text converted to entries; every non-empty line is kept. */
export function migrateAgreementEntries(text: string, now: number): AgreementEntry[] {
  return agreementEntriesFromText(text, [], now)
}

/** Legacy cognition text converted to entries; markdown headings are dropped. */
export function migrateCognitionEntries(text: string, now: number): CognitionEntry[] {
  return cognitionEntriesFromText(text, [], now)
}

/** The single entry `needle` names, by exact text or a unique substring. */
export function matchEntry<T extends { readonly id: string; readonly text: string }>(entries: readonly T[], needle: string, kind: 'agreement' | 'cognition'): T {
  const wanted = normalizeEntry(needle).toLowerCase()
  if (!wanted) throw new KnowledgeError('dot/invalid', 'text must be non-empty')
  const exact = entries.filter(entry => entry.text.toLowerCase() === wanted)
  const matches = exact.length > 0 ? exact : entries.filter(entry => entry.text.toLowerCase().includes(wanted))
  const label = kind === 'agreement' ? 'agreement' : 'cognition entry'
  const unknown = kind === 'agreement' ? 'dot/unknown-agreement' : 'dot/unknown-entry'
  const ambiguous = kind === 'agreement' ? 'dot/ambiguous-agreement' : 'dot/ambiguous-entry'
  if (matches.length === 0) {
    throw new KnowledgeError(unknown, entries.length === 0 ? `there is no ${label} to match` : `no ${label} matches "${normalizeEntry(needle)}". Current ${label}s:\n${entries.map(entry => `- ${entry.text}`).join('\n')}`)
  }
  if (matches.length > 1) {
    throw new KnowledgeError(ambiguous, `"${normalizeEntry(needle)}" matches ${matches.length} ${label}s; quote more of the specific entry:\n${matches.map(entry => `- ${entry.text}`).join('\n')}`)
  }
  return matches[0]!
}

/** One entry the id names, or a refusal for the human panel. */
function byId<T extends { readonly id: string }>(entries: readonly T[], id: string): T {
  const hit = entries.find(entry => entry.id === id)
  if (!hit) throw new KnowledgeError('dot/unknown-entry', `no entry has id ${id}`)
  return hit
}

/** The human panel's single agreements edit applied to the entry list. */
export function applyAgreementEdit(entries: readonly AgreementEntry[], edit: KnowledgeEdit, now: number): AgreementEntry[] {
  switch (edit.op) {
    case 'add': {
      const note = normalizeEntry(edit.text)
      if (!note) throw new KnowledgeError('dot/invalid', 'text must be non-empty')
      if (entries.some(entry => entry.text === note)) return [...entries]
      return [...entries, { id: nextEntryId('a', entries), text: note, createdAt: now, updatedAt: now }]
    }
    case 'edit': {
      const note = normalizeEntry(edit.text)
      if (!note) throw new KnowledgeError('dot/invalid', 'text must be non-empty')
      byId(entries, edit.id)
      return entries.map(entry => entry.id === edit.id ? { ...entry, text: note, updatedAt: now } : entry)
    }
    case 'remove':
      byId(entries, edit.id)
      return entries.filter(entry => entry.id !== edit.id)
    default:
      throw new KnowledgeError('dot/invalid', 'agreements edit.op must be add, edit or remove')
  }
}

/** The human panel's single cognition edit applied to the entry list; pin only toggles the flag. */
export function applyCognitionEdit(entries: readonly CognitionEntry[], edit: KnowledgeEdit, now: number): CognitionEntry[] {
  switch (edit.op) {
    case 'add': {
      const note = normalizeEntry(edit.text)
      if (!note) throw new KnowledgeError('dot/invalid', 'text must be non-empty')
      if (entries.some(entry => entry.text === note)) return [...entries]
      return [...entries, { id: nextEntryId('c', entries), text: note, createdAt: now, updatedAt: now, seenAt: now }]
    }
    case 'edit': {
      const note = normalizeEntry(edit.text)
      if (!note) throw new KnowledgeError('dot/invalid', 'text must be non-empty')
      byId(entries, edit.id)
      return entries.map(entry => entry.id === edit.id ? { ...entry, text: note, updatedAt: now, seenAt: now } : entry)
    }
    case 'remove':
      byId(entries, edit.id)
      return entries.filter(entry => entry.id !== edit.id)
    case 'pin':
      byId(entries, edit.id)
      return entries.map(entry => {
        if (entry.id !== edit.id) return entry
        if (edit.pinned) return { ...entry, pinned: true }
        const { pinned: _pinned, ...rest } = entry
        return rest
      })
    default:
      throw new KnowledgeError('dot/invalid', 'cognition edit.op must be add, edit, remove or pin')
  }
}

/** Display and prompt order: pinned first, then most recently confirmed, ties keep stored order. */
export function rankCognition(entries: readonly CognitionEntry[]): CognitionEntry[] {
  return [...entries].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.seenAt - a.seenAt || b.createdAt - a.createdAt)
}

/**
 * The entries in ranked order with their prompt state: every pinned entry is
 * active, then unpinned entries fill the remaining slots up to `limit` total.
 * The rest are dormant — stored, but not in dot's prompt.
 */
export function cognitionWithActive(entries: readonly CognitionEntry[], limit: number): (CognitionEntry & { readonly active: boolean })[] {
  const ranked = rankCognition(entries)
  let slots = Math.max(0, Math.trunc(limit)) - ranked.filter(entry => entry.pinned === true).length
  return ranked.map(entry => {
    if (entry.pinned === true) return { ...entry, active: true }
    const active = slots > 0
    if (active) slots -= 1
    return { ...entry, active }
  })
}

/** The cognition ops the reflection pass submits: a JSON array applied together. */
export type CognitionOp =
  | { readonly op: 'add'; readonly text: string }
  | { readonly op: 'update'; readonly id: string; readonly text: string }
  | { readonly op: 'remove'; readonly id: string }
  | { readonly op: 'confirm'; readonly id: string }

/** Parse the reflection tool's `ops` payload; every op is checked before anything applies. */
export function parseCognitionOps(raw: string): CognitionOp[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new KnowledgeError('dot/invalid', 'ops must be a JSON array of cognition operations') }
  if (!Array.isArray(parsed)) throw new KnowledgeError('dot/invalid', 'ops must be a JSON array of cognition operations')
  const seen = new Set<string>()
  return parsed.map((item, index) => {
    if (item === null || typeof item !== 'object') throw new KnowledgeError('dot/invalid', `ops[${index}] must be an operation object`)
    const row = item as Record<string, unknown>
    const op = row.op
    if (op === 'add') {
      const text = normalizeEntry(typeof row.text === 'string' ? row.text : '')
      if (!text) throw new KnowledgeError('dot/invalid', `ops[${index}] add needs a non-empty text`)
      return { op: 'add', text }
    }
    if (op !== 'update' && op !== 'remove' && op !== 'confirm') throw new KnowledgeError('dot/invalid', `ops[${index}].op must be add, update, remove or confirm`)
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (!id) throw new KnowledgeError('dot/invalid', `ops[${index}] needs a cognition entry id`)
    if (seen.has(id)) throw new KnowledgeError('dot/invalid', `ops names cognition entry ${id} more than once`)
    seen.add(id)
    if (op === 'update') {
      const text = normalizeEntry(typeof row.text === 'string' ? row.text : '')
      if (!text) throw new KnowledgeError('dot/invalid', `ops[${index}] update needs a non-empty text`)
      return { op: 'update', id, text }
    }
    return { op, id }
  })
}

/** The ops applied to the stored entries; validation runs first so a bad op drops the whole set. */
export function applyCognitionOps(entries: readonly CognitionEntry[], ops: readonly CognitionOp[], now: number): CognitionEntry[] {
  for (const op of ops) {
    if (op.op === 'add') continue
    const hit = byId(entries, op.id)
    if (hit.pinned === true && op.op !== 'confirm') {
      throw new KnowledgeError('dot/pinned', `cognition entry ${op.id} is pinned; the human owns it, only confirm is allowed`)
    }
  }
  return ops.reduce<CognitionEntry[]>((list, op) => {
    switch (op.op) {
      case 'add': return [...list, { id: nextEntryId('c', list), text: op.text, createdAt: now, updatedAt: now, seenAt: now }]
      case 'update': return list.map(entry => entry.id === op.id ? { ...entry, text: op.text, updatedAt: now, seenAt: now } : entry)
      case 'remove': return list.filter(entry => entry.id !== op.id)
      case 'confirm': return list.map(entry => entry.id === op.id ? { ...entry, seenAt: now } : entry)
    }
  }, [...entries])
}

/** The canonical bulk text of the agreements: one `- entry` line each, trailing newline. */
export function agreementsText(entries: readonly AgreementEntry[]): string {
  return entries.length > 0 ? `${entries.map(entry => `- ${entry.text}`).join('\n')}\n` : ''
}

/** The canonical bulk text of the cognition entries, same shape. */
export function cognitionText(entries: readonly CognitionEntry[]): string {
  return entries.length > 0 ? `${entries.map(entry => `- ${entry.text}`).join('\n')}\n` : ''
}

/** The texts the human typed, stored the one canonical way (proposal before/after values). */
export function normalizeAgreements(text: string): string {
  const body = text.replace(/\r\n/g, '\n')
  return body.trim() ? `${body.replace(/\s+$/, '')}\n` : ''
}

/**
 * The [agreements] block of dot's system prompt; empty when there are none.
 * Every entry is carried in stored order: they are the human's own rules.
 */
export function agreementsSection(entries: readonly AgreementEntry[]): string {
  if (entries.length === 0) return ''
  return [
    '[agreements]',
    `The human's standing rules, kept in their own words. They take precedence over your cognition: whenever the two conflict, follow the agreements. The human can view and edit them directly; add an entry with ${TOOL.agreement} (action=add) only when explicitly asked to remember a rule, and remove one only when asked to drop it.`,
    '',
    ...entries.map(entry => `- ${entry.text}`),
  ].join('\n')
}

/**
 * The [cognition] block of dot's system prompt; empty while dot has written
 * none. Pinned entries lead, then the most recently confirmed ones up to the
 * prompt limit; dormant entries stay stored for background reflection.
 */
export function cognitionSection(entries: readonly CognitionEntry[], limit: number): string {
  const active = cognitionWithActive(entries, limit).filter(entry => entry.active)
  if (active.length === 0) return ''
  return [
    '[cognition]',
    `Your evolving understanding, kept as separate entries: what you know about the human and how best to work with them, and what you know about yourself — preferences formed here, jokes you share, and what you have accomplished together. Treat this as background knowledge rather than a message to answer. Entries the human pinned come first, then the ones most recently confirmed; older entries stay stored for your background reflection without appearing here. Change entries with ${TOOL.cognition}. The human can inspect, pin, and restore earlier versions. Whenever cognition conflicts with [agreements], the agreements win.`,
    '',
    ...active.map(entry => `- ${entry.text}`),
  ].join('\n')
}

/**
 * The one-time note the reflection pass leaves about the agreements. It rides
 * the carried prefix of the next human message and asks dot to mention it
 * briefly, then the human decides — the reflection pass never edits the
 * agreements itself.
 */
export function agreementNotesBlock(notes: string): string {
  const body = notes.trim()
  if (!body) return ''
  return [
    '[dot agreement notes]',
    'Your background reflection pass flagged [agreements] entries that may be outdated or mutually conflicting. Do not edit [agreements] yourself; mention this briefly in your reply so the human can decide:',
    '',
    body,
  ].join('\n')
}
