/**
 * dot's two prompt blocks that the human and dot keep current:
 *
 * - agreements: the human's own standing requirements, written verbatim when
 *   they ask dot to remember something. They win over cognition on a clash.
 * - cognition: dot's understanding of the human and of herself — preferences
 *   formed here, shared jokes and what they have accomplished together —
 *   rewritten whole by dot or by the reflection pass.
 *
 * Both live in DotStore, not on disk, so a task opened in dot's workspace can
 * never edit them or inject into dot's prompt. This file holds the text rules.
 */
import { AGREEMENTS_MAX_CHARS, AGREEMENT_ENTRY_MAX_CHARS, COGNITION_MAX_CHARS, TOOL } from './contracts.ts'

export { AGREEMENTS_MAX_CHARS, AGREEMENT_ENTRY_MAX_CHARS, COGNITION_MAX_CHARS }

export class KnowledgeError extends Error {
  constructor(readonly code: 'dot/invalid' | 'dot/agreements-full' | 'dot/unknown-agreement' | 'dot/ambiguous-agreement', message: string) { super(message); this.name = 'KnowledgeError' }
}
const BULLET = /^\s*[-*]\s+/

/** One agreement as a single line, without a list marker. */
export function normalizeEntry(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(BULLET, '').trim()
}

/** The list items of the agreements, in text order. Other lines (headings, prose) are not entries. */
export function entriesOf(text: string): string[] {
  return text.split(/\r?\n/).filter(line => BULLET.test(line)).map(line => line.replace(BULLET, '').trim()).filter(Boolean)
}

/** The agreements with one more list item at the end. */
export function addEntry(text: string, entry: string, maxChars = AGREEMENTS_MAX_CHARS, entryMaxChars = AGREEMENT_ENTRY_MAX_CHARS): string {
  const note = normalizeEntry(entry)
  if (!note) throw new KnowledgeError('dot/invalid', 'text must be non-empty')
  if (note.length > entryMaxChars) throw new KnowledgeError('dot/invalid', `one agreement is at most ${entryMaxChars} characters; this one has ${note.length}. Keep the rule concise and omit extra detail.`)
  if (entriesOf(text).some(existing => existing.toLowerCase() === note.toLowerCase())) return text
  const body = text.replace(/\s+$/, '')
  const next = `${body}${body ? '\n' : ''}- ${note}\n`
  if (next.trim().length > maxChars) {
    throw new KnowledgeError('dot/agreements-full', `your agreements are full (${text.trim().length} of ${maxChars} characters). Remove or consolidate one with ${TOOL.agreement} (action=remove) first, then add this one.`)
  }
  return next
}

/** The agreements without the one list item that holds `needle`. */
export function removeEntry(text: string, needle: string): { readonly text: string; readonly removed: string } {
  const wanted = normalizeEntry(needle).toLowerCase()
  if (!wanted) throw new KnowledgeError('dot/invalid', 'text must be non-empty')
  const lines = text.split(/\r?\n/)
  const items = lines.flatMap((line, index) => BULLET.test(line) ? [{ index, note: line.replace(BULLET, '').trim() }] : [])
  const exact = items.filter(item => item.note.toLowerCase() === wanted)
  const matches = exact.length > 0 ? exact : items.filter(item => item.note.toLowerCase().includes(wanted))
  if (matches.length === 0) {
    throw new KnowledgeError('dot/unknown-agreement', items.length === 0 ? 'there is no agreement to remove' : `no agreement matches "${normalizeEntry(needle)}". Current agreements:\n${items.map(item => `- ${item.note}`).join('\n')}`)
  }
  if (matches.length > 1) {
    throw new KnowledgeError('dot/ambiguous-agreement', `"${normalizeEntry(needle)}" matches ${matches.length} agreements; quote more of the specific entry:\n${matches.map(item => `- ${item.note}`).join('\n')}`)
  }
  const hit = matches[0]!
  lines.splice(hit.index, 1)
  return { text: lines.join('\n'), removed: hit.note }
}

/** The texts the human typed, stored the one canonical way. */
export function normalizeAgreements(text: string): string {
  const body = text.replace(/\r\n/g, '\n')
  return body.trim() ? `${body.replace(/\s+$/, '')}\n` : ''
}

export function normalizeCognition(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '')
}

/**
 * The [agreements] block of dot's system prompt; empty when there are none.
 * The text is carried whole, even past AGREEMENTS_MAX_CHARS: the limit guards new
 * writes, and no user rule at the tail may be cut out of the prompt.
 */
export function agreementsSection(text: string): string {
  const body = text.trim()
  if (!body) return ''
  return [
    '[agreements]',
    `The human's standing rules, kept in their own words. They take precedence over your cognition: whenever the two conflict, follow the agreements. The human can view and edit them directly; add an entry with ${TOOL.agreement} (action=add) only when explicitly asked to remember a rule, and remove one only when asked to drop it.`,
    '',
    body,
  ].join('\n')
}

/**
 * The [cognition] block of dot's system prompt; empty while dot has written none.
 * Like the agreements, it is carried whole; the size limit only guards new writes.
 */
export function cognitionSection(text: string): string {
  const body = text.trim()
  if (!body) return ''
  return [
    '[cognition]',
    `Your evolving understanding in two parts: what you know about the human and how best to work with them, and what you know about yourself — preferences formed here, jokes you share, and what you have accomplished together. Treat this as background knowledge rather than a message to answer; rewrite the entire block with ${TOOL.cognition} to keep it current. The human can inspect and restore earlier versions. Whenever cognition conflicts with [agreements], the agreements win.`,
    '',
    body,
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
