/**
 * Images a person can attach to Dorothy's chat. Unsupported bytes are rejected
 * here; nothing is coerced or dropped on the way to the model.
 */
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type ChatImageType = typeof CHAT_IMAGE_TYPES[number]
export const CHAT_IMAGE_LIMIT = 4
export const CHAT_IMAGE_BYTES = 8_000_000
/** plugin-kit 0.8.0 rejects a host RPC body above this unless the caller raises it. */
export const HOST_RPC_DEFAULT_BODY_BYTES = 64 * 1024

/** Base64 length of `bytes` raw bytes. */
export function base64Length(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid image size')
  return Math.ceil(bytes / 3) * 4
}

const SAY_TEXT_CHARS = 20_000
const SAY_NAME_CHARS = 80

/**
 * UTF-8 size of a `/dsh-dot/say` client-request. `textBytes` and `nameBytes`
 * are the bytes JSON places between the quotes, so a character JSON escapes
 * as `\\u0000` counts as six. The shape matches the browser caller: a
 * client-request whose payload is `{ text, images: [{ mediaType, data, name }] }`.
 */
export function sayRequestBytes(textBytes: number, images: readonly { readonly dataBytes: number; readonly nameBytes: number }[]): number {
  const head = '{"type":"client-request","rpcId":"00000000-0000-4000-8000-000000000000","method":"say","payload":{"text":"'
  const mid = '","images":['
  const imageHead = '{"mediaType":"image/jpeg","data":"'
  const imageMid = '","name":"'
  const imageTail = '"}'
  const tail = ']}}'
  let total = head.length + textBytes + mid.length
  images.forEach((image, index) => {
    if (index > 0) total += 1
    total += imageHead.length + image.dataBytes + imageMid.length + image.nameBytes + imageTail.length
  })
  return total + tail.length
}

/**
 * What `registerHostRpc` must accept. The kit default is 64 KiB, and a 51 KB
 * PNG is already 68,040 bytes of base64, so it never reached `say`. Four
 * images at the advertised cap, with 80-character names budgeted at four UTF-8
 * bytes per character and a 20,000-character text escaped at six bytes each, still fit.
 */
export const CHAT_SAY_BODY_BYTES = sayRequestBytes(
  SAY_TEXT_CHARS * 6,
  Array.from({ length: CHAT_IMAGE_LIMIT }, () => ({ dataBytes: base64Length(CHAT_IMAGE_BYTES), nameBytes: SAY_NAME_CHARS * 4 })),
)

export interface ChatImage {
  readonly mediaType: ChatImageType
  readonly data: string
  readonly name?: string
}

export type ChatImageError = 'unsupported' | 'too-large' | 'too-many' | 'invalid' | 'mismatch'

const MESSAGES: Record<ChatImageError, string> = {
  unsupported: 'Only PNG, JPEG, WebP and GIF images are accepted.',
  'too-large': `That image is too large. Each image must be ${CHAT_IMAGE_BYTES / 1_000_000} MB or smaller.`,
  'too-many': `At most ${CHAT_IMAGE_LIMIT} images per message.`,
  invalid: 'That image could not be read.',
  mismatch: 'The image bytes do not match the declared type.',
}

export class ChatImageRejected extends Error {
  readonly code: ChatImageError
  constructor(code: ChatImageError) {
    super(MESSAGES[code])
    this.name = 'ChatImageRejected'
    this.code = code
  }
}

export function imageTypeOf(bytes: Uint8Array): ChatImageType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return undefined
}

export function inspectImageBytes(bytes: Uint8Array, declared?: string): { ok: true; mediaType: ChatImageType } | { ok: false; error: ChatImageError } {
  if (bytes.byteLength > CHAT_IMAGE_BYTES) return { ok: false, error: 'too-large' }
  const sniffed = imageTypeOf(bytes)
  if (!sniffed) return { ok: false, error: 'unsupported' }
  if (declared !== undefined && declared !== '' && declared !== sniffed) return { ok: false, error: 'mismatch' }
  return { ok: true, mediaType: sniffed }
}

function decodedBase64Length(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor(data.length * 3 / 4) - padding
}

function decodeBase64(data: string): Uint8Array | undefined {
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined
  if (decodedBase64Length(data) > CHAT_IMAGE_BYTES) return undefined
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return undefined
  }
}

/** Sanitize a display filename without letting a long stem swallow its extension. */
export function attachmentName(name: unknown, maxChars = 120): string | undefined {
  if (typeof name !== 'string') return undefined
  const base = name.replaceAll('\\', '/').split('/').pop()?.replace(/[^\p{L}\p{M}\p{N}_.\- ()[\]]+/gu, '').trim()
  if (!base || /^\.+$/.test(base)) return undefined
  if (base.length <= maxChars) return base
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot) : ''
  const keepExt = ext.length > 1 && ext.length <= 20 && !/\s/.test(ext)
  const suffix = keepExt ? ext : ''
  const stem = (keepExt ? base.slice(0, -suffix.length) : base).trim() || 'file'
  return `${stem.slice(0, Math.max(1, maxChars - suffix.length))}${suffix}`
}

export function imageName(name: unknown): string | undefined {
  return attachmentName(name, 80)
}

/** Validate a `say` payload. Undefined means no images. A bad entry throws. */
export function checkChatImages(value: unknown): readonly ChatImage[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ChatImageRejected('invalid')
  if (value.length > CHAT_IMAGE_LIMIT) throw new ChatImageRejected('too-many')
  return value.map(entry => {
    const row = entry !== null && typeof entry === 'object' ? entry as Record<string, unknown> : undefined
    const declared = typeof row?.mediaType === 'string' ? row.mediaType : ''
    const data = typeof row?.data === 'string' ? row.data.replace(/\s+/g, '') : ''
    if (!declared || !data) throw new ChatImageRejected('invalid')
    if (!(CHAT_IMAGE_TYPES as readonly string[]).includes(declared)) throw new ChatImageRejected('unsupported')
    if (decodedBase64Length(data) > CHAT_IMAGE_BYTES) throw new ChatImageRejected('too-large')
    const bytes = decodeBase64(data)
    if (!bytes) throw new ChatImageRejected('invalid')
    const inspected = inspectImageBytes(bytes, declared)
    if (!inspected.ok) throw new ChatImageRejected(inspected.error)
    const name = imageName(row?.name)
    return { mediaType: inspected.mediaType, data, ...(name ? { name } : {}) }
  })
}
