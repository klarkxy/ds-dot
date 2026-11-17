/**
 * Turns dot's session log into the rows its chat draws. Pure over raw events,
 * so the host can rebuild the whole list or fold in one new event the same way.
 */
import type { ChatItem } from './contracts.ts'
import { AGREEMENT_NOTES_HEAD } from './contracts.ts'
import { cardText } from './cards.ts'
import { toolDisplay, type ParsedNotice, type ToolDisplay } from './chat-format.ts'

export interface RawEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
}

const SHOW_VIEW = 'show_view'
const DETAIL_MAX = 1600
const ARG_MAX = 200
const ERROR_PREFIX = /^Error \[([^\]]+)\]:/

type Rec = Record<string, unknown>
const rec = (value: unknown): Rec | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Rec : undefined

/** Native failure state wins; the text fallback reads logs made before it was recorded. */
export function toolResultFailed(data: Rec): boolean {
  const message = rec(data.message)
  if (message?.isError === true) return true
  const detail = textOf(message?.content).trim()
  // Older Dorothy tools returned an Error string as a successful result. New
  // Dorothy successes carry display metadata, so only unmarked old rows use it.
  if (rec(rec(data.meta)?.dshDot)?.display) return false
  const oldError = ERROR_PREFIX.exec(detail)
  if (oldError) return oldError[1] !== 'dot/unknown-request'
  try {
    const value = rec(JSON.parse(detail))
    return value?.status === 'failed' || value?.status === 'error' || value?.ok === false
  } catch { return false }
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    const row = rec(block)
    return row?.type === 'text' && typeof row.text === 'string' ? row.text : ''
  }).join('')
}

function imageNotes(content: unknown): { readonly mediaType: string; readonly name?: string }[] {
  if (!Array.isArray(content)) return []
  const notes: { readonly mediaType: string; readonly name?: string }[] = []
  for (const block of content) {
    const row = rec(block)
    if (row?.type !== 'image') continue
    const attachment = rec(row.attachment)
    const mediaType = typeof attachment?.mediaType === 'string' ? attachment.mediaType : 'image'
    const name = typeof attachment?.name === 'string' ? attachment.name : undefined
    notes.push({ mediaType, ...(name ? { name } : {}) })
  }
  return notes
}

/**
 * A human message can carry held notices into the same model turn. The source
 * stores only their character count; readers split the log text back into the
 * notice and the human's own words, so neither view shows a merged fake message.
 */
export function splitCarriedNotice(source: unknown, content: unknown): { readonly text: string; readonly notice?: string } {
  const count = rec(rec(source)?.dshDot)?.carriedChars
  const full = textOf(content)
  if (rec(source)?.kind !== 'user') return { text: full }
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0 || count >= full.length) return { text: full }
  const notice = full.slice(0, count)
  // The carried prefix holds batched updates and/or a one-time agreement note;
  // either marks the block as system context rather than the human's own words.
  if (!notice.startsWith('[dot notice]') && !notice.startsWith(AGREEMENT_NOTES_HEAD)) return { text: full }
  return { notice, text: full.slice(count).trim() }
}

function parseArgs(raw: unknown): Rec | undefined {
  if (typeof raw !== 'string') return rec(raw)
  try { return rec(JSON.parse(raw)) } catch { return undefined }
}

function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > ARG_MAX ? value.slice(0, ARG_MAX) + '…' : value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (depth >= 2) return undefined
  if (Array.isArray(value)) return value.slice(0, 10).map(item => compactValue(item, depth + 1)).filter(item => item !== undefined)
  const row = rec(value)
  if (!row) return undefined
  const out: Rec = {}
  for (const [key, entry] of Object.entries(row).slice(0, 12)) {
    const next = compactValue(entry, depth + 1)
    if (next !== undefined) out[key] = next
  }
  return out
}

function compactArgs(raw: unknown): Rec | undefined {
  const parsed = parseArgs(raw)
  if (!parsed) return undefined
  const compacted = compactValue(parsed) as Rec | undefined
  return compacted && Object.keys(compacted).length > 0 ? compacted : undefined
}

/** Answer facts deep-view stores on the human's reply to a card. */
export function viewAnswerOf(source: unknown): { id: string; action: string; values: Record<string, unknown> } | undefined {
  const answer = rec(rec(rec(source)?.deepView)?.answer)
  if (!answer || typeof answer.id !== 'string' || typeof answer.action !== 'string') return undefined
  return { id: answer.id, action: answer.action, values: rec(answer.values) ?? {} }
}

/** Mutable builder: feed events in log order, read items any time. */
export class ChatFold {
  private readonly list: ChatItem[] = []
  private readonly byCall = new Map<string, number>()
  readonly answers: Record<string, { action: string; values: Record<string, unknown> }> = {}

  private turn?: number
  private trigger: 'human' | 'background' = 'background'
  private inTurn = false

  get items(): readonly ChatItem[] { return this.list }

  private push(item: ChatItem): void {
    this.list.push(this.turn === undefined ? item : { ...item, turn: this.turn, trigger: this.trigger })
  }

  /** @returns whether the visible list changed. */
  add(event: RawEvent): boolean {
    const data = rec(event.data) ?? {}
    const at = typeof event.time === 'number' ? event.time : 0
    const key = String(event.seq ?? this.list.length)
    switch (event.type) {
      case 'turn/start': {
        this.turn = event.seq ?? (this.turn ?? 0) + 1
        this.inTurn = true
        return false
      }
      case 'user/message': {
        const source = rec(data.source)
        if (source?.kind === 'user') {
          this.trigger = 'human'
          if (this.inTurn && this.turn !== undefined) {
            for (let index = this.list.length - 1; index >= 0 && this.list[index]?.turn === this.turn; index--) this.list[index] = { ...this.list[index]!, trigger: 'human' }
          }
        } else if (!this.inTurn) this.trigger = 'background'
        const parts = splitCarriedNotice(source, data.content)
        const text = parts.text.trim()
        const images = source?.kind === 'user' ? imageNotes(data.content) : []
        const notice = rec(rec(source?.dshDot)?.notices) as unknown as ParsedNotice | undefined
        if (parts.notice) this.push({ kind: 'notice', key: `${key}:notice`, text: parts.notice, ...notice ? { notice } : {}, at })
        if (!text && images.length === 0) return parts.notice !== undefined
        if (source?.kind === 'user') {
          const answer = viewAnswerOf(source)
          if (answer) {
            this.answers[answer.id] = { action: answer.action, values: answer.values }
            this.push({ kind: 'answer', key, text, at })
          } else this.push({ kind: 'user', key, text, at, ...(images.length > 0 ? { images } : {}) })
          return true
        }
        if (source?.kind === 'agent-message') { this.push({ kind: 'notice', key, text, ...notice ? { notice } : {}, at }); return true }
        return false
      }
      case 'assistant/message': {
        const content = rec(data.message)?.content
        let changed = false
        if (Array.isArray(content)) {
          content.forEach((block, index) => {
            const row = rec(block)
            if (row?.type === 'text' && typeof row.text === 'string' && row.text.trim()) {
              this.push({ kind: 'bot', key: `${key}:${index}`, text: row.text, at })
              changed = true
            }
          })
        }
        return changed
      }
      case 'tool/call': {
        const callId = typeof data.callId === 'string' ? data.callId : key
        const name = typeof data.name === 'string' ? data.name : 'tool'
        this.byCall.set(callId, this.list.length)
        if (name === SHOW_VIEW) {
          const args = parseArgs(data.arguments)
          this.push({ kind: 'view', key: callId, title: args?.title, view: args?.view, at })
        } else {
          const args = compactArgs(data.arguments)
          this.push({ kind: 'tool', key: callId, name, status: 'running', ...args ? { args } : {}, at })
        }
        return true
      }
      case 'tool/result': {
        const message = rec(data.message)
        const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : undefined
        const index = callId === undefined ? undefined : this.byCall.get(callId)
        if (index === undefined) return false
        const item = this.list[index]!
        if (item.kind === 'view') {
          const meta = rec(data.meta)
          this.list[index] = meta && message?.isError !== true && cardText(meta) !== undefined ? { ...item, presentation: meta } : { ...item, failed: true }
        } else if (item.kind === 'tool') {
          const detail = textOf(message?.content).trim()
          const failed = toolResultFailed(data)
          const saved = rec(rec(data.meta)?.dshDot)?.display as ToolDisplay | undefined
          const error = rec(data.error)
          const legacy = !saved && (typeof message?.isError !== 'boolean' || message.isError === false && ERROR_PREFIX.test(detail))
          const display = legacy ? undefined : failed ? toolDisplay(item.name, detail, {
            ...typeof error?.code === 'string' ? { code: error.code } : {},
            message: typeof error?.reason === 'string' ? error.reason : detail.replace(/^Error: /, ''),
          }) : saved ?? toolDisplay(item.name, detail)
          this.list[index] = { ...item, status: failed ? 'error' : 'done', ...display ? { display } : {}, ...detail ? { detail: detail.length > DETAIL_MAX ? detail.slice(0, DETAIL_MAX) + '…' : detail } : {} }
        }
        return true
      }
      case 'turn/end': {
        this.inTurn = false
        this.turn = undefined
        this.trigger = 'background'
        const reason = rec(data.reason)
        if (reason?.kind !== 'error') return false
        const error = rec(reason.error)
        const text = typeof error?.message === 'string' ? error.message : 'The turn failed.'
        this.push({ kind: 'error', key, text, at })
        return true
      }
      default:
        return false
    }
  }
}

export function chatItems(events: readonly RawEvent[]): readonly ChatItem[] {
  const fold = new ChatFold()
  for (const event of events) fold.add(event)
  return fold.items
}
