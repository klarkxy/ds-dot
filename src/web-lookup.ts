/**
 * Dot-only web lookup. The host's configured providers stay on the parent
 * `ctx.web`. These functions never register there: another session keeps its
 * own selection, including `WEB_PROVIDER_AMBIGUOUS` when the user has not pinned one.
 */
import { WebError, type WebFetchResult, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/'
const JINA_ORIGIN = 'https://r.jina.ai'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESULTS = 5
const DEFAULT_MAX_CHARS = 100_000
const SNIPPET_MAX = 300

export interface LookupFetch {
  (input: string, init: RequestInit): Promise<Response>
}

export interface ParentWeb {
  selectSearchProvider?(): unknown
  search?(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<WebSearchResult>
  searchReady?(llmProvider: string | undefined): Promise<boolean>
  selectFetchProvider?(): unknown
  fetch?(request: { url: string }, signal?: AbortSignal): Promise<WebFetchResult>
  fetchReady?(llmProvider: string | undefined): Promise<boolean>
}

export function webErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

/** Env pins are the same field as `searchProvider` / `fetchProvider`, not a second priority. */
export function pinnedProviderId(envValue: string | undefined, fallbackId: string): string {
  const pinned = envValue?.trim()
  return pinned ? pinned : fallbackId
}

/**
 * Id to register on dot's own web service.
 * An explicit pin is registered only when a parent service can honor it.
 * Registering the fallback under that pin, with no parent, would make the
 * missing configuration look like a successful DuckDuckGo or Jina call.
 */
export function isolatedProviderId(envValue: string | undefined, fallbackId: string, parentPresent: boolean): string | undefined {
  const pinned = envValue?.trim()
  if (!pinned) return fallbackId
  return parentPresent ? pinned : undefined
}

function unavailable(error: unknown): boolean {
  return webErrorCode(error) === 'WEB_PROVIDER_UNAVAILABLE'
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

function asWebError(error: unknown, fallback: string, signal?: AbortSignal): WebError {
  if (error instanceof WebError) return error
  const name = errorName(error)
  const reasonName = errorName(signal?.reason)
  // A body read rejects with a bare AbortError; the timeout is on the signal.
  if (name === 'TimeoutError' || reasonName === 'TimeoutError') {
    return new WebError('the lookup timed out', 'WEB_PROVIDER_ERROR', { cause: error })
  }
  if (name === 'AbortError' || reasonName === 'AbortError' || signal?.aborted === true) {
    return new WebError('the lookup was cancelled', 'WEB_ABORTED', { cause: error })
  }
  const message = error instanceof Error ? error.message : fallback
  return new WebError(message || fallback, 'WEB_PROVIDER_ERROR', { cause: error })
}

/** Stop pulling once the decoded text reaches `maxChars`, and cancel the unread tail. */
async function readBounded(response: Response, maxChars: number, signal?: AbortSignal): Promise<{ content: string; truncated: boolean }> {
  const body = response.body
  if (!body) return { content: '', truncated: false }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let content = ''
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      content += decoder.decode(value, { stream: true })
      if (content.length >= maxChars) {
        content = content.slice(0, maxChars)
        truncated = true
        break
      }
    }
    if (!truncated) content += decoder.decode()
    if (content.length > maxChars) {
      content = content.slice(0, maxChars)
      truncated = true
    }
  } catch (error) {
    throw asWebError(error, 'the response body could not be read', signal)
  } finally {
    await reader.cancel().catch(() => {})
  }
  return { content, truncated }
}

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** DuckDuckGo wraps the real URL in `/l/?uddg=`. One unwrap, then only http(s). */
export function unwrapDuckDuckGoUrl(href: string): string | undefined {
  let url: URL
  try { url = new URL(href, 'https://duckduckgo.com') } catch { return undefined }
  const wrapped = url.searchParams.get('uddg')
  if (wrapped) {
    try { url = new URL(wrapped) } catch { return undefined }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username || url.password) return undefined
  return url.toString()
}

export function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  const anchors = html.matchAll(/<a\b([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>/gi)
  const snippets = [...html.matchAll(/<a\b[^>]*\bresult__snippet\b[^>]*>([\s\S]*?)<\/a>/gi)].map(match => decodeHtml(match[1] ?? '').slice(0, SNIPPET_MAX))
  let index = 0
  for (const match of anchors) {
    if (sources.length >= maxResults) break
    const attrs = match[1] ?? ''
    const href = /href="([^"]+)"/i.exec(attrs)?.[1]
    if (!href) continue
    const url = unwrapDuckDuckGoUrl(href.replaceAll('&amp;', '&'))
    if (!url || seen.has(url)) continue
    seen.add(url)
    const title = decodeHtml(match[2] ?? '')
    const snippet = snippets[index]
    index += 1
    if (!title) continue
    sources.push({ url, title, ...snippet ? { snippet } : {} })
  }
  return sources
}

export async function duckDuckGoSearch(query: string, options: {
  fetch: LookupFetch
  signal?: AbortSignal
  timeoutMs?: number
  maxResults?: number
}): Promise<WebSearchResult> {
  const text = query.trim()
  if (!text) throw new WebError('search query is empty', 'WEB_PROVIDER_ERROR')
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS
  const signal = combineSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const url = new URL(DDG_ENDPOINT)
  url.searchParams.set('q', text)
  let response: Response
  try {
    response = await options.fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal,
      headers: {
        accept: 'text/html',
        'user-agent': 'dsh-dot',
      },
    })
  } catch (error) {
    throw asWebError(error, 'DuckDuckGo search failed', signal)
  }
  if (!response.ok) throw new WebError(`DuckDuckGo search failed with HTTP ${response.status}`, 'WEB_PROVIDER_ERROR')
  const html = await readBounded(response, 1_000_000, signal)
  return { sources: parseDuckDuckGoHtml(html.content, maxResults), truncated: false }
}

/** Build `https://r.jina.ai/<original URL>` without moving the target's query onto the reader URL. */
export function jinaReaderUrl(raw: string): string {
  let target: URL
  try { target = new URL(raw) } catch {
    throw new WebError('fetch URL is not a valid absolute URL', 'WEB_PROVIDER_ERROR')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new WebError('fetch URL must be http or https', 'WEB_PROVIDER_ERROR')
  }
  if (target.username || target.password) throw new WebError('fetch URL must not carry credentials', 'WEB_PROVIDER_ERROR')
  if (isJinaReaderHost(target.hostname)) throw new WebError('fetch URL must not be the Jina reader itself', 'WEB_PROVIDER_ERROR')
  const reader = new URL(JINA_ORIGIN)
  reader.pathname = `/${target.toString()}`
  reader.search = ''
  reader.hash = ''
  return reader.toString()
}

/** `r.jina.ai.` is the same host. A trailing dot must not wrap the reader in itself. */
function isJinaReaderHost(hostname: string): boolean {
  return hostname.replace(/\.+$/, '').toLowerCase() === 'r.jina.ai'
}

/**
 * Jina's preamble reports the page it actually fetched. The marker keeps a
 * page that merely contains the same label from becoming the final URL.
 * Without a usable `URL Source`, the result keeps the requested target.
 */
function jinaReportedUrl(body: string, requested: string): string {
  const markerAt = body.indexOf('Markdown Content:')
  if (markerAt < 0) return requested
  const line = body.slice(0, markerAt).split(/\r?\n/).find(item => item.startsWith('URL Source:'))
  if (!line) return requested
  let url: URL
  try { url = new URL(line.slice('URL Source:'.length).trim()) } catch { return requested }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return requested
  if (url.username || url.password) return requested
  if (isJinaReaderHost(url.hostname)) return requested
  return url.toString()
}

export async function jinaFetch(rawUrl: string, options: {
  fetch: LookupFetch
  signal?: AbortSignal
  timeoutMs?: number
  maxChars?: number
}): Promise<WebFetchResult> {
  const readerUrl = jinaReaderUrl(rawUrl)
  const source = new URL(rawUrl).toString()
  const signal = combineSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  let response: Response
  try {
    response = await options.fetch(readerUrl, {
      method: 'GET',
      redirect: 'follow',
      signal,
      headers: { accept: 'text/plain', 'user-agent': 'dsh-dot' },
    })
  } catch (error) {
    throw asWebError(error, 'Jina fetch failed', signal)
  }
  const body = await readBounded(response, maxChars, signal)
  return {
    url: jinaReportedUrl(body.content, source),
    statusCode: response.status,
    body: { kind: 'text', content: body.content },
    truncated: body.truncated,
  }
}

function configuredMissing(pinned: string): WebError {
  return new WebError(`configured web provider "${pinned}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
}

export async function searchWithFallback(parent: ParentWeb | undefined, request: { query: string; maxResults?: number }, signal: AbortSignal | undefined, fallback: () => Promise<WebSearchResult>, pinned?: string): Promise<WebSearchResult> {
  if (parent?.selectSearchProvider && parent.search) {
    try { parent.selectSearchProvider() } catch (error) {
      if (pinned || !unavailable(error)) throw error
      return fallback()
    }
    return parent.search(request, signal)
  }
  if (pinned) throw configuredMissing(pinned)
  return fallback()
}

export async function fetchWithFallback(parent: ParentWeb | undefined, request: { url: string }, signal: AbortSignal | undefined, fallback: () => Promise<WebFetchResult>, pinned?: string): Promise<WebFetchResult> {
  if (parent?.selectFetchProvider && parent.fetch) {
    try { parent.selectFetchProvider() } catch (error) {
      if (pinned || !unavailable(error)) throw error
      return fallback()
    }
    return parent.fetch(request, signal)
  }
  if (pinned) throw configuredMissing(pinned)
  return fallback()
}

export async function searchReady(parent: ParentWeb | undefined, llmProvider: string | undefined): Promise<boolean> {
  if (!parent?.selectSearchProvider) return true
  try { parent.selectSearchProvider() } catch { return true }
  return parent.searchReady?.(llmProvider) ?? true
}

export async function fetchReady(parent: ParentWeb | undefined, llmProvider: string | undefined): Promise<boolean> {
  if (!parent?.selectFetchProvider) return true
  try { parent.selectFetchProvider() } catch { return true }
  return parent.fetchReady?.(llmProvider) ?? true
}
