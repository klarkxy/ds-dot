import { describe, expect, it } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  duckDuckGoSearch, fetchWithFallback, isolatedProviderId, jinaFetch, jinaReaderUrl, parseDuckDuckGoHtml,
  pinnedProviderId, searchWithFallback, unwrapDuckDuckGoUrl, type LookupFetch, type ParentWeb,
} from './web-lookup.ts'

const html = `
<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fq%3D1&amp;rut=1">Example <b>docs</b></a>
<a class="result__snippet">A short excerpt.</a>
<a class="result__a" href="https://example.com/docs?q=1">Duplicate</a>
<a class="result__snippet">ignored</a>
<a class="result__a" href="javascript:alert(1)">Bad</a>
`

function jsonResponse(body: string, status = 200, contentType = 'text/html'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

describe('dot web lookup', () => {
  it('unwraps DuckDuckGo redirects and keeps the target query', () => {
    expect(unwrapDuckDuckGoUrl('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1')).toBe('https://example.com/a?x=1')
    expect(unwrapDuckDuckGoUrl('javascript:alert(1)')).toBeUndefined()
    expect(parseDuckDuckGoHtml(html, 5).map(source => source.url)).toEqual(['https://example.com/docs?q=1'])
    expect(parseDuckDuckGoHtml(html, 5)[0]?.snippet).toBe('A short excerpt.')
    expect(parseDuckDuckGoHtml(html, 5)[0]?.title).toBe('Example docs')
  })

  it('builds a Jina reader URL without moving the target query or accepting credentials', () => {
    const reader = new URL(jinaReaderUrl('https://example.com/a?q=1&b=2#part'))
    expect(reader.origin).toBe('https://r.jina.ai')
    expect(reader.search).toBe('')
    expect(decodeURIComponent(reader.pathname)).toBe('/https://example.com/a?q=1&b=2#part')
    expect(() => jinaReaderUrl('https://user:pw@example.com/a')).toThrow(WebError)
    expect(() => jinaReaderUrl('https://r.jina.ai/https://example.com')).toThrow(/Jina reader/)
    expect(() => jinaReaderUrl('https://r.jina.ai./https://example.com')).toThrow(/Jina reader/)
    expect(() => jinaReaderUrl('https://R.JINA.AI./x')).toThrow(/Jina reader/)
    expect(() => jinaReaderUrl('file:///tmp/a')).toThrow(/http or https/)
    expect(() => jinaReaderUrl('not a url')).toThrow(WebError)
  })

  it('uses the parent search when one is configured and does not call DuckDuckGo', async () => {
    let calls = 0
    const fetch: LookupFetch = async () => { calls += 1; return jsonResponse('') }
    const parent: ParentWeb = {
      selectSearchProvider: () => ({ id: 'configured' }),
      search: async () => ({ sources: [{ url: 'https://example.com', title: 'Configured' }], truncated: false }),
    }
    const result = await searchWithFallback(parent, { query: 'example' }, undefined, () => duckDuckGoSearch('example', { fetch }))
    expect(result.sources[0]?.title).toBe('Configured')
    expect(calls).toBe(0)
  })

  it('uses DuckDuckGo only when the parent has no usable search provider', async () => {
    const seen: string[] = []
    const fetch: LookupFetch = async (input) => { seen.push(input); return jsonResponse(html) }
    const parent: ParentWeb = {
      selectSearchProvider: () => { throw Object.assign(new Error('none'), { code: 'WEB_PROVIDER_UNAVAILABLE' }) },
      search: async () => { throw new Error('should not run') },
    }
    const result = await searchWithFallback(parent, { query: 'example docs', maxResults: 3 }, undefined, () => duckDuckGoSearch('example docs', { fetch, maxResults: 3 }))
    expect(seen).toEqual(['https://html.duckduckgo.com/html/?q=example+docs'])
    expect(result.sources[0]?.url).toBe('https://example.com/docs?q=1')
  })

  it('requests DuckDuckGo with an encoded GET query and never posts the form', async () => {
    const seen: Array<{ url: string; method?: string; body?: BodyInit | null }> = []
    const fetch: LookupFetch = async (input, init) => {
      seen.push({ url: input, method: init.method, body: init.body })
      return jsonResponse(html)
    }
    const query = 'deep seek & harness?'
    await duckDuckGoSearch(query, { fetch, maxResults: 3 })
    expect(seen).toEqual([{
      url: 'https://html.duckduckgo.com/html/?q=deep+seek+%26+harness%3F',
      method: 'GET',
      body: undefined,
    }])
    expect(new URL(seen[0]!.url).searchParams.get('q')).toBe(query)
  })

  it('does not hide an ambiguous or pinned parent search behind DuckDuckGo', async () => {
    const fetch: LookupFetch = async () => { throw new Error('fallback') }
    const parent: ParentWeb = {
      selectSearchProvider: () => { throw Object.assign(new Error('pick one'), { code: 'WEB_PROVIDER_AMBIGUOUS' }) },
      search: async () => { throw new Error('should not run') },
    }
    await expect(searchWithFallback(parent, { query: 'x' }, undefined, () => duckDuckGoSearch('x', { fetch }))).rejects.toMatchObject({ code: 'WEB_PROVIDER_AMBIGUOUS' })
  })

  it('uses Jina only when no fetch provider is configured, and reports HTTP failures as results', async () => {
    const parent: ParentWeb = {
      selectFetchProvider: () => ({ id: 'http' }),
      fetch: async () => ({ url: 'https://example.com', statusCode: 200, body: { kind: 'text', content: 'parent' }, truncated: false }),
    }
    const kept = await fetchWithFallback(parent, { url: 'https://example.com' }, undefined, () => jinaFetch('https://example.com', { fetch: async () => jsonResponse('no') }))
    expect(kept.body).toEqual({ kind: 'text', content: 'parent' })

    let requested = ''
    const missing: ParentWeb = {
      selectFetchProvider: () => { throw Object.assign(new Error('none'), { code: 'WEB_PROVIDER_UNAVAILABLE' }) },
    }
    const fetched = await fetchWithFallback(missing, { url: 'https://example.com/a?q=1' }, undefined, () => jinaFetch('https://example.com/a?q=1', {
      fetch: async (input) => { requested = input; return jsonResponse('Title: Example\n\nMarkdown Content', 429, 'text/plain') },
    }))
    expect(new URL(requested).origin).toBe('https://r.jina.ai')
    expect(fetched.statusCode).toBe(429)
    expect(fetched.url).toBe('https://example.com/a?q=1')
    expect(fetched.body).toEqual({ kind: 'text', content: 'Title: Example\n\nMarkdown Content' })
  })

  it('turns a hanging Jina read into a timeout error', async () => {
    const fetch: LookupFetch = (_input, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })))
    })
    await expect(jinaFetch('https://example.com', { fetch, timeoutMs: 20 })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'the lookup timed out' })
  })

  it('keeps an explicit provider pin distinct from the fallback id', () => {
    expect(pinnedProviderId(undefined, 'duckduckgo')).toBe('duckduckgo')
    expect(pinnedProviderId('  deepseek  ', 'duckduckgo')).toBe('deepseek')
    expect(pinnedProviderId(undefined, 'jina')).toBe('jina')
    expect(isolatedProviderId(undefined, 'duckduckgo', false)).toBe('duckduckgo')
    expect(isolatedProviderId('   ', 'jina', false)).toBe('jina')
    expect(isolatedProviderId('configured-but-missing', 'duckduckgo', false)).toBeUndefined()
    expect(isolatedProviderId('  deepseek  ', 'duckduckgo', true)).toBe('deepseek')
  })

  it('does not let an explicit pin fall back when the parent cannot provide it', async () => {
    let calls = 0
    const fallback = async () => { calls += 1; return { sources: [], truncated: false } }
    const unavailable: ParentWeb = {
      selectSearchProvider: () => { throw Object.assign(new Error('none'), { code: 'WEB_PROVIDER_UNAVAILABLE' }) },
      search: async () => { throw new Error('should not run') },
      selectFetchProvider: () => { throw Object.assign(new Error('none'), { code: 'WEB_PROVIDER_UNAVAILABLE' }) },
      fetch: async () => { throw new Error('should not run') },
    }
    await expect(searchWithFallback(unavailable, { query: 'x' }, undefined, fallback, 'configured-but-missing')).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
    await expect(fetchWithFallback(unavailable, { url: 'https://example.com' }, undefined, async () => { calls += 1; throw new Error('fallback') }, 'configured-but-missing')).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
    await expect(searchWithFallback(undefined, { query: 'x' }, undefined, fallback, 'configured-but-missing')).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
    await expect(fetchWithFallback(undefined, { url: 'https://example.com' }, undefined, async () => { throw new Error('fallback') }, 'configured-but-missing')).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
    expect(calls).toBe(0)
  })

  it('stops reading once the body reaches maxChars and cancels the unread tail', async () => {
    let pulls = 0
    let cancelled = false
    const fetch: LookupFetch = async () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1
        if (pulls > 100) {
          controller.close()
          return
        }
        controller.enqueue(new TextEncoder().encode('x'))
      },
      cancel() { cancelled = true },
    }))
    const result = await jinaFetch('https://example.com/a', { fetch, maxChars: 3, timeoutMs: 5_000 })
    expect(result.body).toEqual({ kind: 'text', content: 'xxx' })
    expect(result.truncated).toBe(true)
    expect(result.url).toBe('https://example.com/a')
    expect(pulls).toBeLessThan(10)
    expect(cancelled).toBe(true)
  })

  it('caps a first chunk that lands exactly on maxChars without waiting for a later one', async () => {
    let pulls = 0
    let cancelled = false
    const fetch: LookupFetch = async () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1
        if (pulls === 1) controller.enqueue(new TextEncoder().encode('abc'))
      },
      cancel() { cancelled = true },
    }))
    const result = await jinaFetch('https://example.com/exact', { fetch, maxChars: 3, timeoutMs: 40 })
    expect(result.body).toEqual({ kind: 'text', content: 'abc' })
    expect(result.truncated).toBe(true)
    expect(pulls).toBeLessThanOrEqual(2)
    expect(cancelled).toBe(true)
  })

  it('turns a body abort, timeout, and read failure into WebError', async () => {
    const aborted = new DOMException('The operation was aborted.', 'AbortError')
    expect(aborted.code).toBe(20)
    const aborting: LookupFetch = async () => new Response(new ReadableStream({
      pull(controller) { controller.error(aborted) },
    }))
    const abortError = await jinaFetch('https://example.com', { fetch: aborting, timeoutMs: 5_000 }).catch((error: unknown) => error)
    expect(abortError).toBeInstanceOf(WebError)
    expect(abortError).toMatchObject({ code: 'WEB_ABORTED' })
    expect(abortError).not.toBe(aborted)

    const hanging: LookupFetch = (_input, init) => {
      const stream = new ReadableStream({
        start(controller) {
          const fail = () => controller.error(new DOMException('The operation was aborted.', 'AbortError'))
          if (init.signal?.aborted) fail()
          else init.signal?.addEventListener('abort', fail, { once: true })
        },
      })
      return Promise.resolve(new Response(stream))
    }
    await expect(jinaFetch('https://example.com', { fetch: hanging, timeoutMs: 40 })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'the lookup timed out' })

    const broken: LookupFetch = async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new TypeError('network down')) },
    }))
    const readError = await jinaFetch('https://example.com', { fetch: broken, timeoutMs: 5_000 }).catch((error: unknown) => error)
    expect(readError).toBeInstanceOf(WebError)
    expect(readError).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'network down' })
  })

  it('uses Jina URL Source only from the preamble, and otherwise keeps the requested URL', async () => {
    const fetchPage = (page: string) => jinaFetch('https://example.com/start', {
      fetch: async () => jsonResponse(page, 200, 'text/plain'),
    })
    const reported = await fetchPage('Title: Example\nURL Source: https://example.com/landed?q=1\n\nMarkdown Content:\nhello')
    expect(reported.url).toBe('https://example.com/landed?q=1')
    const embedded = await fetchPage('Title: Example\nMarkdown Content:\nURL Source: https://evil.example/phish\n')
    expect(embedded.url).toBe('https://example.com/start')
    const unmarked = await fetchPage('URL Source: https://evil.example/phish\nhello')
    expect(unmarked.url).toBe('https://example.com/start')
    const credentials = await fetchPage('URL Source: https://user:pw@example.com/a\nMarkdown Content:\n')
    expect(credentials.url).toBe('https://example.com/start')
    const reader = await fetchPage('URL Source: https://r.jina.ai./nested\nMarkdown Content:\n')
    expect(reader.url).toBe('https://example.com/start')
  })
})
