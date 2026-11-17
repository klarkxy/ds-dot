import { createServer, request as httpRequest, type Server } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { registerHostRpc, type HostRpcContext } from '@klarkxy/dsh-plugin-kit/host-rpc'
import { CHAT_SAY_BODY_BYTES, HOST_RPC_DEFAULT_BODY_BYTES, checkChatImages } from './chat-images.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
})

function png(bytes: number): Buffer {
  const raw = Buffer.alloc(bytes)
  raw.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return raw
}

function sayBody(images: readonly { mediaType: string; data: string; name?: string }[], text = ''): string {
  return JSON.stringify({
    type: 'client-request',
    rpcId: '00000000-0000-4000-8000-000000000000',
    method: 'say',
    payload: { text, images },
  })
}

async function host(maxBodyBytes?: number) {
  let handler: Parameters<HostRpcContext['webServer']['register']>[0]['handler']
  const seen: unknown[] = []
  registerHostRpc({
    connection: { requestRejection: () => undefined },
    webServer: { register: route => { handler = route.handler; return () => {} } },
  }, '/dsh-dot', async (endpoint, payload) => {
    seen.push(endpoint)
    try {
      const images = checkChatImages(payload !== null && typeof payload === 'object' ? (payload as { images?: unknown }).images : undefined)
      seen.push(images.length)
      return { ok: true, value: true }
    } catch (error) {
      return { ok: false, error: { code: 'dot/failed', message: error instanceof Error ? error.message : 'bad' } }
    }
  }, maxBodyBytes === undefined ? {} : { maxBodyBytes })
  const server = createServer((req, res) => { void handler!(req, res) })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server address')
  return { seen, url: `http://127.0.0.1:${address.port}/dsh-dot/say` }
}

function post(url: string, body: string | Buffer): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const SHOT = png(51_029).toString('base64')

it('registers the raised say body limit', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  expect(source).toContain('maxBodyBytes: CHAT_SAY_BODY_BYTES')
})

it('rejects a 51029-byte png at the kit default and accepts it at the say cap', async () => {
  expect(SHOT.length).toBe(68_040)
  const body = sayBody([{ mediaType: 'image/png', data: SHOT, name: 'shot.png' }])
  expect(Buffer.byteLength(body)).toBeGreaterThan(HOST_RPC_DEFAULT_BODY_BYTES)
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(CHAT_SAY_BODY_BYTES)

  const blocked = await host()
  expect((await post(blocked.url, body)).status).toBe(413)
  expect(blocked.seen).toEqual([])

  const allowed = await host(CHAT_SAY_BODY_BYTES)
  const accepted = await post(allowed.url, body)
  expect(accepted.status).toBe(200)
  expect(accepted.text).toContain('"ok":true')
  expect(allowed.seen).toEqual(['say', 1])
})

it('reports an unsupported type instead of 413, and still rejects a body over the cap', async () => {
  const { url, seen } = await host(CHAT_SAY_BODY_BYTES)
  const typed = await post(url, sayBody([{ mediaType: 'image/svg+xml', data: SHOT }]))
  expect(typed.status).toBe(200)
  expect(typed.text).toContain('Only PNG, JPEG, WebP and GIF')
  expect(seen).toEqual(['say'])

  const over = await post(url, Buffer.alloc(CHAT_SAY_BODY_BYTES + 1, 0x20))
  expect(over.status).toBe(413)
  expect(seen).toEqual(['say'])
})
