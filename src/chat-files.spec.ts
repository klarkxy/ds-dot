import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { base64Length } from './chat-images.ts'
import {
  attachRequestBytes,
  canonicalBase64Bytes,
  CHAT_ATTACH_BODY_BYTES,
  CHAT_FILE_BYTES,
  CHAT_FILE_NAME_CHARS,
  CHAT_FILE_RECEIPT_LIMIT,
  CHAT_FILE_RECEIPT_TTL_MS,
  CHAT_RPC_BODY_BYTES,
  checkChatFileData,
  checkChatFileIds,
  checkChatFileRef,
  type ChatFileRef,
  fileName,
  humanBytes,
} from './chat-files.ts'
import type { DotHost } from './host.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'

function makeReceiptRig() {
  const homeDir = mkdtempSync(join(tmpdir(), 'dsh-dot-receipts-'))
  let clock = 1_000_000
  let attachSeq = 0
  const delivered: Array<{ readonly text: string; readonly files: readonly ChatFileRef[] }> = []
  let onSay: ((text: string, files: readonly ChatFileRef[]) => Promise<void>) | undefined
  const host = {
    createWorkspace: async (path: string, title: string) => ({ id: 'ws-dot', title, path, sessionCount: 0 }),
    listWorkspaces: () => [],
    createDot: async () => 'dot-1',
    resumeDot: async () => true,
    isRunning: () => false,
    readEvents: async () => [],
    modelKey: () => undefined,
    syncModel: () => {},
    attachFile: async (name: string) => ({ attachmentId: `att-${++attachSeq}`, name, bytes: 3 }),
    say: async (_sessionId: string, text: string, _carried?: string, _answer?: unknown, _images?: unknown, _notice?: unknown, files?: readonly ChatFileRef[]) => {
      if (onSay) await onSay(text, files ?? [])
      delivered.push({ text, files: files ?? [] })
    },
  } as unknown as DotHost
  const service = new DotService({
    host,
    store: new DotStore(undefined),
    homeDir,
    now: () => clock,
    timer: { set: () => ({}), clear: () => {} },
  })
  return {
    service,
    delivered,
    advance(ms: number) { clock += ms },
    setSayHook(hook: typeof onSay) { onSay = hook },
    cleanup() { rmSync(homeDir, { recursive: true, force: true }) },
  }
}

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

  it('validates canonical base64 size and rejects duplicate receipt ids', () => {
    expect(canonicalBase64Bytes('')).toBe(0)
    expect(canonicalBase64Bytes('AAAA')).toBe(3)
    expect(canonicalBase64Bytes('AAA=')).toBe(2)
    expect(canonicalBase64Bytes('AAA')).toBeUndefined()
    expect(canonicalBase64Bytes('AA A')).toBeUndefined()
    expect(() => checkChatFileIds(['one', 'two'])).not.toThrow()
    expect(() => checkChatFileIds(['dup', 'dup'])).toThrow(/could not be uploaded/)
    expect(() => checkChatFileIds(Array.from({ length: 11 }, (_, i) => `id-${i}`))).toThrow(/At most 10 files/)
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

  it('consumes a file receipt atomically across concurrent say calls and keeps it on host failure', async () => {
    const rig = makeReceiptRig()
    try {
      const payload = Buffer.from('abc').toString('base64')
      const receipt = await rig.service.attachFile('spec.pdf', payload)
      let releaseFirst!: () => void
      const gate = new Promise<void>(resolve => { releaseFirst = resolve })
      rig.setSayHook(async () => { await gate })

      const first = rig.service.say('first', undefined, [], [receipt.id])
      const second = rig.service.say('second', undefined, [], [receipt.id])
      releaseFirst()

      const outcomes = await Promise.allSettled([first, second])
      expect(outcomes[0]).toEqual({ status: 'fulfilled', value: undefined })
      expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringMatching(/Attach the file again/) }) })
      expect(rig.delivered).toHaveLength(1)
      expect(rig.delivered[0]?.files).toEqual([{ attachmentId: 'att-1', name: 'spec.pdf', bytes: 3 }])

      // A failed host.say leaves the unconsumed receipt intact for a retry.
      const retryReceipt = await rig.service.attachFile('retry.pdf', payload)
      rig.setSayHook(async () => { throw new Error('transient send failure') })
      await expect(rig.service.say('will fail', undefined, [], [retryReceipt.id])).rejects.toThrow(/transient send failure/)
      rig.setSayHook(undefined)
      await expect(rig.service.say('succeeds on retry', undefined, [], [retryReceipt.id])).resolves.toBeUndefined()
      expect(rig.delivered).toHaveLength(2)
    } finally {
      rig.cleanup()
    }
  })

  it('evicts receipts beyond the 50-item cap and expires receipts older than 1 hour', async () => {
    const rig = makeReceiptRig()
    try {
      const payload = Buffer.from('abc').toString('base64')
      const issued = []
      for (let index = 0; index <= CHAT_FILE_RECEIPT_LIMIT; index += 1) {
        issued.push(await rig.service.attachFile(`f-${index}.txt`, payload))
        rig.advance(10)
      }
      // 51st upload evicts the oldest receipt (f-0.txt) while keeping f-1.txt live.
      await expect(rig.service.say('', undefined, [], [issued[0]!.id])).rejects.toThrow(/Attach the file again/)
      await expect(rig.service.say('', undefined, [], [issued[1]!.id])).resolves.toBeUndefined()

      // Advancing past CHAT_FILE_RECEIPT_TTL_MS expires remaining unconsumed receipts.
      const fresh = await rig.service.attachFile('expiring.txt', payload)
      rig.advance(CHAT_FILE_RECEIPT_TTL_MS + 1)
      await expect(rig.service.say('', undefined, [], [fresh.id])).rejects.toThrow(/Attach the file again/)
    } finally {
      rig.cleanup()
    }
  })
})
