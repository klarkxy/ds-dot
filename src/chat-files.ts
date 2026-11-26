/**
 * Verbatim files a person can attach to Dorothy's chat. Files upload ahead of
 * the message and the message carries only their short-lived receipt ids.
 */
import { base64Length, attachmentName, CHAT_SAY_BODY_BYTES } from './chat-images.ts'

export const CHAT_FILE_BYTES = 32 * 1024 * 1024
export const CHAT_FILE_LIMIT = 10
export const CHAT_FILE_NAME_CHARS = 120
const RECEIPT_TTL_MS = 60 * 60 * 1000
export const CHAT_FILE_RECEIPT_TTL_MS = RECEIPT_TTL_MS
export const CHAT_FILE_RECEIPT_LIMIT = 50

/** Structural copy of dsh-attachment's FileAttachmentRef. */
export interface ChatFileRef {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

/** Receipt the composer keeps after a successful upload. */
export interface ChatFileReceipt {
  readonly id: string
  readonly name: string
  readonly bytes: number
}

export type ChatFileError = 'too-large' | 'too-many' | 'invalid'

/** Compact byte count shared by the composer rail and history file chips. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0).replace(/\.0$/, '')} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace(/\.0$/, '')} MB`
}

const MESSAGES: Record<ChatFileError, string> = {
  'too-large': `That file is too large. Each file must be ${CHAT_FILE_BYTES / 1024 / 1024} MB or smaller.`,
  'too-many': `At most ${CHAT_FILE_LIMIT} files per message.`,
  invalid: 'That file could not be uploaded.',
}

export class ChatFileRejected extends Error {
  readonly code: ChatFileError
  constructor(code: ChatFileError) {
    super(MESSAGES[code])
    this.name = 'ChatFileRejected'
    this.code = code
  }
}

export function fileName(name: unknown): string | undefined {
  return attachmentName(name, CHAT_FILE_NAME_CHARS)
}

/** Decoded byte length of canonical base64, or undefined for malformed input. */
export function canonicalBase64Bytes(data: unknown): number | undefined {
  if (typeof data !== 'string') return undefined
  if (data.length === 0) return 0
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined
  if (/=/.test(data.slice(0, -2))) return undefined
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor(data.length * 3 / 4) - padding
}

/** Validate one upload payload and return its canonical base64 text. */
export function checkChatFileData(value: unknown): string {
  const bytes = canonicalBase64Bytes(value)
  if (bytes === undefined) throw new ChatFileRejected('invalid')
  if (bytes > CHAT_FILE_BYTES) throw new ChatFileRejected('too-large')
  return value as string
}

/** Validate the receipt-id list on a `say` payload. Undefined means no files. */
export function checkChatFileIds(value: unknown): readonly string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ChatFileRejected('invalid')
  if (value.length > CHAT_FILE_LIMIT) throw new ChatFileRejected('too-many')
  return value.map(entry => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 64) throw new ChatFileRejected('invalid')
    return entry
  })
}

/** Structural validation for a stored reference crossing service/host seams. */
export function checkChatFileRef(value: unknown): ChatFileRef {
  const row = value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
  const attachmentId = typeof row?.attachmentId === 'string' ? row.attachmentId : ''
  const name = typeof row?.name === 'string' ? row.name : ''
  const bytes = typeof row?.bytes === 'number' && Number.isSafeInteger(row.bytes) && row.bytes >= 0 ? row.bytes : -1
  if (!attachmentId || !name || name.length > 255 || bytes < 0) throw new ChatFileRejected('invalid')
  return { attachmentId, name, bytes }
}

/**
 * UTF-8 size of an `/dsh-dot/attach` client-request. Names may contain Unicode
 * letters, so the budget uses four UTF-8 bytes per serialized name character.
 */
export function attachRequestBytes(nameBytes: number, dataBytes: number): number {
  const head = '{"type":"client-request","rpcId":"00000000-0000-4000-8000-000000000000","method":"attach","payload":{"name":"'
  const mid = '","data":"'
  const tail = '","uiLocale":"zh-CN"}}'
  return head.length + nameBytes + mid.length + dataBytes + tail.length
}

export const CHAT_ATTACH_BODY_BYTES = attachRequestBytes(CHAT_FILE_NAME_CHARS * 4, base64Length(CHAT_FILE_BYTES))
/** One host-RPC body cap shared by image-bearing `say` and file-upload `attach`. */
export const CHAT_RPC_BODY_BYTES = Math.max(CHAT_SAY_BODY_BYTES, CHAT_ATTACH_BODY_BYTES)
