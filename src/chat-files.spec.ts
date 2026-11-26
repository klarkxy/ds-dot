import { describe, expect, it } from 'vitest'
import { base64Length } from './chat-images.ts'
import {
  attachRequestBytes,
  canonicalBase64Bytes,
  CHAT_ATTACH_BODY_BYTES,
  CHAT_FILE_BYTES,
  CHAT_FILE_NAME_CHARS,
  CHAT_RPC_BODY_BYTES,
  checkChatFileData,
  checkChatFileIds,
  checkChatFileRef,
  fileName,
  humanBytes,
} from './chat-files.ts'

describe('chat files', () => {
  it('sanitizes long names while keeping their extension', () => {
    expect(fileName(' C:/tmp/../report final.pdf ')).toBe('report final.pdf')
    expect(fileName('需求说明.md')).toBe('需求说明.md')
    expect(fileName('C:/tmp/需求说明.md')).toBe('需求说明.md')
    expect(fileName('bad:name?.md')).toBe('badname.md')
    const long = `${'a'.repeat(140)}.pdf`
    expect(fileName(long)).toBe(`${'a'.repeat(116)}.pdf`)
    expect(fileName('../..')).toBeUndefined()
  })

  it('preserves host attachment refs byte-identically while validating their shape', () => {
    const ref = { attachmentId: 'att-1', name: '需求说明.md', bytes: 123 }
    expect(checkChatFileRef(ref)).toEqual(ref)
    expect(checkChatFileRef({ attachmentId: 'att-1', name: 'x'.repeat(255), bytes: CHAT_FILE_BYTES + 1 })).toMatchObject({ bytes: CHAT_FILE_BYTES + 1 })
    expect(() => checkChatFileRef({ attachmentId: '', name: 'a.md', bytes: 1 })).toThrow()
    expect(() => checkChatFileRef({ attachmentId: 'att-1', name: '', bytes: 1 })).toThrow()
    expect(() => checkChatFileRef({ attachmentId: 'att-1', name: 'x'.repeat(256), bytes: 1 })).toThrow()
    expect(() => checkChatFileRef({ attachmentId: 'att-1', name: 'a.md', bytes: -1 })).toThrow()
  })

  it('formats bytes consistently for composer cards and history chips', () => {
    expect(humanBytes(0)).toBe('0 B')
    expect(humanBytes(72)).toBe('72 B')
    expect(humanBytes(193)).toBe('193 B')
    expect(humanBytes(1024)).toBe('1 KB')
    expect(humanBytes(1536)).toBe('1.5 KB')
  })

  it('validates canonical base64 size without decoding it', () => {
    expect(canonicalBase64Bytes('')).toBe(0)
    expect(canonicalBase64Bytes('AAAA')).toBe(3)
    expect(canonicalBase64Bytes('AAA=')).toBe(2)
    expect(canonicalBase64Bytes('AAA')).toBeUndefined()
    expect(canonicalBase64Bytes('AA A')).toBeUndefined()
    expect(() => checkChatFileIds(['one', 'two'])).not.toThrow()
    expect(() => checkChatFileIds(Array.from({ length: 11 }, () => 'x'))).toThrow(/At most 10 files/)
    expect(checkChatFileData('')).toBe('')
  })

  it('budgets an attach body the way the browser serializes one', () => {
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: '00000000-0000-4000-8000-000000000000',
      method: 'attach',
      payload: { name: 'n', data: 'abcd', uiLocale: 'zh-CN' },
    })
    expect(Buffer.byteLength(body)).toBe(attachRequestBytes(1, 4))
    const dataLength = base64Length(CHAT_FILE_BYTES)
    expect(CHAT_ATTACH_BODY_BYTES).toBe(attachRequestBytes(CHAT_FILE_NAME_CHARS * 4, dataLength))
    expect(CHAT_RPC_BODY_BYTES).toBeGreaterThanOrEqual(CHAT_ATTACH_BODY_BYTES)
  })
})
