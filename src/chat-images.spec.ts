import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { CHAT_IMAGE_BYTES, CHAT_SAY_BODY_BYTES, HOST_RPC_DEFAULT_BODY_BYTES, ChatImageRejected, base64Length, checkChatImages, inspectImageBytes, sayRequestBytes } from './chat-images.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('chat images', () => {
  it('accepts a sniffed png and rejects a mismatched or unknown type', () => {
    expect(inspectImageBytes(PNG, 'image/png')).toEqual({ ok: true, mediaType: 'image/png' })
    expect(inspectImageBytes(PNG, 'image/jpeg').ok).toBe(false)
    expect(inspectImageBytes(Uint8Array.from([1, 2, 3, 4])).ok).toBe(false)
  })

  it('accepts a real png payload and refuses a text file labeled as one', () => {
    expect(checkChatImages([{ mediaType: 'image/png', data: PNG_B64, name: 'a.png' }])).toEqual([
      { mediaType: 'image/png', data: PNG_B64, name: 'a.png' },
    ])
    expect(() => checkChatImages([{ mediaType: 'image/png', data: btoa('not an image!!') }])).toThrow(ChatImageRejected)
    expect(() => checkChatImages([{ mediaType: 'image/svg+xml', data: PNG_B64 }])).toThrow(/PNG, JPEG, WebP and GIF/)
    expect(checkChatImages(undefined)).toEqual([])
  })

  it('accepts a 51029-byte png and names the 8 MB cap when one is larger', () => {
    const raw = Buffer.alloc(51_029)
    raw.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const data = raw.toString('base64')
    expect(data.length).toBe(68_040)
    expect(data.length).toBeGreaterThan(HOST_RPC_DEFAULT_BODY_BYTES)
    expect(checkChatImages([{ mediaType: 'image/png', data, name: 'shot.png' }])[0]).toMatchObject({ mediaType: 'image/png', name: 'shot.png' })
    const over = Buffer.alloc(CHAT_IMAGE_BYTES + 1)
    over.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(() => checkChatImages([{ mediaType: 'image/png', data: over.toString('base64') }])).toThrow(/8 MB or smaller/)
    for (const size of [CHAT_IMAGE_BYTES - 1, CHAT_IMAGE_BYTES]) {
      const atCap = Buffer.alloc(size)
      atCap.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(checkChatImages([{ mediaType: 'image/png', data: atCap.toString('base64') }])).toHaveLength(1)
    }
  })

  it('budgets a say body the way the browser serializes one', () => {
    const text = '\u0000'.repeat(3)
    const data = 'abcd'
    const name = 'n'
    const rpcId = '00000000-0000-4000-8000-000000000000'
    const body = JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'say',
      payload: { text, images: [{ mediaType: 'image/jpeg', data, name }] },
    })
    const textBytes = Buffer.byteLength(JSON.stringify(text)) - 2
    expect(textBytes).toBe(18)
    expect(Buffer.byteLength(body)).toBe(sayRequestBytes(textBytes, [{ dataBytes: data.length, nameBytes: name.length }]))
    expect(base64Length(51_029)).toBe(68_040)
    expect(CHAT_SAY_BODY_BYTES).toBeGreaterThan(4 * base64Length(CHAT_IMAGE_BYTES))
  })
})
