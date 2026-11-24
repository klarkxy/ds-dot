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
const BULLET = /^[-*]\s+/
const HEADING = /^\s*#{1,6}\s/

/** One entry as a single line, without a list marker; internal spacing stays verbatim. */
export function normalizeEntry(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim().replace(BULLET, '').trim()
}

/** Whitespace- and case-insensitive comparison key for matching; never stored. */
export function entryKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

const MATCH_LIST_LIMIT = 40

/** Current entries echoed in a match error, truncated so a large dormant list cannot bloat the model context. */
function formatMatchList(entries: readonly { readonly text: string }[]): string {
  const lines = entries.slice(0, MATCH_LIST_LIMIT).map(entry => `- ${entry.text}`)
  if (entries.length > MATCH_LIST_LIMIT) lines.push(`… and ${entries.length - MATCH_LIST_LIMIT} more`)
  return lines.join('\n')
}

/** Entries whose comparison key equals that of `text`. */
function entriesWithKey<T extends { readonly text: string }>(entries: readonly T[], text: string): T[] {
  const key = entryKey(text)
  return entries.filter(entry => entryKey(entry.text) === key)
}

/**
 * Bulk or legacy text split into entry texts: every non-empty line is one
 * entry with a leading `- `/`* ` marker stripped; spacing inside a line is
 * kept verbatim. `dropHeadings` additionally skips markdown heading lines
 * (cognition); agreements keep them verbatim.
 */
export function splitEntryText(text: string, dropHeadings = false): string[] {
  return text.split(/\r?\n/)
    .filter(line => !dropHeadings || !HEADING.test(line))
    .map(line => normalizeEntry(line))
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

/** Hands out fresh entry ids; the service backs it with the persisted counter so ids are never reused. */
export type NextEntryId = () => string

/** The largest numeric suffix any entry in `lists` carries for `prefix`; seeds a missing counter on load. */
export function maxEntrySuffix(prefix: 'a' | 'c', lists: readonly (readonly { readonly id: string }[])[]): number {
  const pattern = new RegExp(`^${prefix}(\\d+)$`)
  let max = 0
  for (const entries of lists) {
    for (const entry of entries) {
      const match = pattern.exec(entry.id)
      if (match) max = Math.max(max, Number(match[1]))
    }
  }
  return max
}

/**
 * Agreement bulk text converted to entries: an identical existing entry keeps
 * its id and timestamps; new lines get fresh ids. Used wherever stored text
 * becomes entries — migration, proposal approval, bulk sets.
 *
 * `uniqueByKey` is for write paths (proposal approval): skip a line whose
 * folded key is already in the result, and reuse an existing entry by key
 * when the exact text is absent. Migration leaves it false so historical
 * near-duplicates stay stored.
 */
export function agreementEntriesFromText(text: string, existing: readonly AgreementEntry[], now: number, nextId: NextEntryId, uniqueByKey = false): AgreementEntry[] {
  const pool = [...existing]
  const next: AgreementEntry[] = []
  const seen = new Set<string>()
  for (const line of splitEntryText(text)) {
    const key = entryKey(line)
    if (uniqueByKey) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    let index = pool.findIndex(entry => entry.text === line)
    if (index < 0 && uniqueByKey) index = pool.findIndex(entry => entryKey(entry.text) === key)
    next.push(index >= 0 ? pool.splice(index, 1)[0]! : { id: nextId(), text: line, createdAt: now, updatedAt: now })
  }
  return next
}

/** Cognition bulk text converted to entries under the same reuse rule, headings dropped. */
export function cognitionEntriesFromText(text: string, existing: readonly CognitionEntry[], now: number, nextId: NextEntryId): CognitionEntry[] {
  const pool = [...existing]
  const next: CognitionEntry[] = []
  for (const line of splitEntryText(text, true)) {
    const index = pool.findIndex(entry => entry.text === line)
    next.push(index >= 0 ? pool.splice(index, 1)[0]! : { id: nextId(), text: line, createdAt: now, updatedAt: now, seenAt: now })
  }
  return next
}

/** Legacy agreements text converted to entries; every non-empty line is kept. */
export function migrateAgreementEntries(text: string, now: number, nextId: NextEntryId): AgreementEntry[] {
  return agreementEntriesFromText(text, [], now, nextId)
}

/** Legacy cognition text converted to entries; markdown headings are dropped. */
export function migrateCognitionEntries(text: string, now: number, nextId: NextEntryId): CognitionEntry[] {
  return cognitionEntriesFromText(text, [], now, nextId)
}

/**
 * The single entry `needle` names, by exact key or a unique substring; stored
 * text is compared as it stands. A unique literal hit on the normalized needle
 * wins first, so leftover near-duplicates from migration are not a deadlock
 * when the tool quotes one row verbatim.
 */
export function matchEntry<T extends { readonly id: string; readonly text: string }>(entries: readonly T[], needle: string, kind: 'agreement' | 'cognition', emptyField = 'text'): T {
  const note = normalizeEntry(needle)
  const wanted = entryKey(note)
  if (!wanted) throw new KnowledgeError('dot/invalid', `${emptyField} must be non-empty`)
  const literal = entries.filter(entry => entry.text === note)
  if (literal.length === 1) return literal[0]!
  const exact = entries.filter(entry => entryKey(entry.text) === wanted)
  const matches = exact.length > 0 ? exact : entries.filter(entry => entryKey(entry.text).includes(wanted))
  const noun = kind === 'agreement' ? 'agreement' : 'cognition entry'
  const nouns = kind === 'agreement' ? 'agreements' : 'cognition entries'
  const unknown = kind === 'agreement' ? 'dot/unknown-agreement' : 'dot/unknown-entry'
  const ambiguous = kind === 'agreement' ? 'dot/ambiguous-agreement' : 'dot/ambiguous-entry'
  if (matches.length === 0) {
    throw new KnowledgeError(unknown, entries.length === 0 ? `there is no ${noun} to match` : `no ${noun} matches "${note}". Current ${nouns}:\n${formatMatchList(entries)}`)
  }
  if (matches.length > 1) {
    throw new KnowledgeError(ambiguous, `"${note}" matches ${matches.length} ${nouns}; quote more of the specific entry:\n${formatMatchList(matches)}`)
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
export function applyAgreementEdit(entries: readonly AgreementEntry[], edit: KnowledgeEdit, now: number, nextId: NextEntryId): AgreementEntry[] {
  switch (edit.op) {
    case 'add': {
      const note = normalizeEntry(edit.text)
      if (!note) throw new KnowledgeError('dot/invalid', 'text must be non-empty')
      if (entriesWithKey(entries, note).length > 0) return [...entries]
      return [...entries, { id: nextId(), text: note, createdAt: now, updatedAt: now }]
    }
    case 'edit': {
      const note = normalizeEntry(edit.text)
      if (!note) throw new KnowledgeError('dot/invalid', 'text must be non-empty')
      const hit = byId(entries, edit.id)
      if (hit.text === note) return [...entries]
      if (entries.some(entry => entry.id !== edit.id && entryKey(entry.text) === entryKey(note))) {
        throw new KnowledgeError('dot/invalid', 'another agreement already has that text')
      }
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
export function applyCognitionEdit(entries: readonly CognitionEntry[], edit: KnowledgeEdit, now: number, nextId: NextEntryId): CognitionEntry[] {
  switch (edit.op) {
    case 'add': {
      const note = normalizeEntry(edit.text)
      if (!note) throw new KnowledgeError('dot/invalid', 'text must be non-empty')
      const hits = entriesWithKey(entries, note)
      if (hits.length > 1) return [...entries]
      if (hits.length === 1) {
        const hit = hits[0]!
        return hit.seenAt === now ? [...entries] : entries.map(entry => entry.id === hit.id ? { ...entry, seenAt: now } : entry)
      }
      return [...entries, { id: nextId(), text: note, createdAt: now, updatedAt: now, seenAt: now }]
    }
    case 'edit': {
      const note = normalizeEntry(edit.text)
      if (!note) throw new KnowledgeError('dot/invalid', 'text must be non-empty')
      const hit = byId(entries, edit.id)
      if (hit.text === note) return [...entries]
      if (entries.some(entry => entry.id !== edit.id && entryKey(entry.text) === entryKey(note))) {
        throw new KnowledgeError('dot/invalid', 'another cognition entry already has that text')
      }
      return entries.map(entry => entry.id === edit.id ? { ...entry, text: note, updatedAt: now, seenAt: now } : entry)
    }
    case 'remove':
      byId(entries, edit.id)
      return entries.filter(entry => entry.id !== edit.id)
    case 'pin':
      byId(entries, edit.id)
      return entries.map(entry => {
        if (entry.id !== edit.id) return entry
        if (edit.pinned === true) return { ...entry, pinned: true }
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

/**
 * The human panel's knowledge edit, checked at the RPC boundary so a bad
 * payload cannot reach `text.replace` or treat the string `"false"` as pinned.
 */
export function parseKnowledgeEdit(raw: unknown, kind: 'agreements' | 'cognition'): KnowledgeEdit {
  if (raw === null || typeof raw !== 'object') throw new KnowledgeError('dot/invalid', 'edit must be an object')
  const row = raw as Record<string, unknown>
  const op = row.op
  if (kind === 'agreements') {
    if (op !== 'add' && op !== 'edit' && op !== 'remove') throw new KnowledgeError('dot/invalid', 'agreements edit.op must be add, edit or remove')
  } else if (op !== 'add' && op !== 'edit' && op !== 'remove' && op !== 'pin') {
    throw new KnowledgeError('dot/invalid', 'cognition edit.op must be add, edit, remove or pin')
  }
  if (op === 'add') {
    if (typeof row.text !== 'string') throw new KnowledgeError('dot/invalid', 'edit.text must be a string')
    return { op: 'add', text: row.text }
  }
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (!id) throw new KnowledgeError('dot/invalid', 'edit.id must be a non-empty string')
  if (op === 'remove') return { op: 'remove', id }
  if (op === 'edit') {
    if (typeof row.text !== 'string') throw new KnowledgeError('dot/invalid', 'edit.text must be a string')
    return { op: 'edit', id, text: row.text }
  }
  if (typeof row.pinned !== 'boolean') throw new KnowledgeError('dot/invalid', 'edit.pinned must be a boolean')
  return { op: 'pin', id, pinned: row.pinned }
}

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
export function applyCognitionOps(entries: readonly CognitionEntry[], ops: readonly CognitionOp[], now: number, nextId: NextEntryId): CognitionEntry[] {
  for (const op of ops) {
    if (op.op === 'add') continue
    const hit = byId(entries, op.id)
    if (hit.pinned === true && op.op !== 'confirm') {
      throw new KnowledgeError('dot/pinned', `cognition entry ${op.id} is pinned; the human owns it, only confirm is allowed`)
    }
  }
  return ops.reduce<CognitionEntry[]>((list, op) => {
    switch (op.op) {
      case 'add': {
        const hits = entriesWithKey(list, op.text)
        if (hits.length > 1) return list
        if (hits.length === 1) {
          const hit = hits[0]!
          return hit.seenAt === now ? list : list.map(entry => entry.id === hit.id ? { ...entry, seenAt: now } : entry)
        }
        return [...list, { id: nextId(), text: op.text, createdAt: now, updatedAt: now, seenAt: now }]
      }
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
