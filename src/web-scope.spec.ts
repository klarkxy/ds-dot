import { describe, expect, it } from 'vitest'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { installDotWeb } from './web-scope.ts'

const html = '<a class="result__a" href="https://example.com/docs">Example</a>'

function scopeFixture(parent?: object) {
  let isolated: WebRuntime | undefined
  const ctx = {
    ...(parent ? { web: parent } : {}),
    isolate(name: string) {
      expect(name).toBe('web')
      const scoped = {
        web: undefined as WebRuntime | undefined,
        effect(work: () => Iterator<unknown>) {
          const iterator = work()
          if (!iterator || typeof iterator.next !== 'function') return () => {}
          const cleanups: Array<() => void> = []
          let step = iterator.next()
          while (!step.done) {
            if (typeof step.value === 'function') cleanups.push(step.value as () => void)
            step = iterator.next()
          }
          return () => { for (const cleanup of cleanups.reverse()) cleanup() }
        },
        reflect: { provide(_name: string, service: WebRuntime) { scoped.web = service; isolated = service } },
        events: { dispatch() { return [] } },
        systemPrompt: {
          getSectionOrder() { return 50 },
          section() { return () => {} },
        },
        tools: {
          get() { return { name: 'present' } },
          register(definition: { name?: string }) {
            expect(['web_search', 'web_fetch']).toContain(definition.name)
            return () => {}
          },
        },
      }
      return scoped
    },
  }
  return {
    ctx,
    runtime() {
      if (!isolated) throw new Error('web runtime was not installed')
      return isolated
    },
  }
}

async function withPins(search: string | undefined, fetchPin: string | undefined, run: () => Promise<void>): Promise<void> {
  const previousSearch = process.env.DSH_WEB_SEARCH_PROVIDER
  const previousFetch = process.env.DSH_WEB_FETCH_PROVIDER
  if (search === undefined) delete process.env.DSH_WEB_SEARCH_PROVIDER
  else process.env.DSH_WEB_SEARCH_PROVIDER = search
  if (fetchPin === undefined) delete process.env.DSH_WEB_FETCH_PROVIDER
  else process.env.DSH_WEB_FETCH_PROVIDER = fetchPin
  try {
    await run()
  } finally {
    if (previousSearch === undefined) delete process.env.DSH_WEB_SEARCH_PROVIDER
    else process.env.DSH_WEB_SEARCH_PROVIDER = previousSearch
    if (previousFetch === undefined) delete process.env.DSH_WEB_FETCH_PROVIDER
    else process.env.DSH_WEB_FETCH_PROVIDER = previousFetch
  }
}

async function withFetchSpy(run: (calls: string[]) => Promise<void>, body = 'unused'): Promise<void> {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

describe('dot web scope', () => {
  it('registers the fallback providers on an isolated web service and leaves the parent registry alone', async () => {
    const parentCalls: string[] = []
    await withPins(undefined, undefined, async () => {
      const { ctx, runtime } = scopeFixture({
        registerSearchProvider() { parentCalls.push('search') },
        registerFetchProvider() { parentCalls.push('fetch') },
        selectSearchProvider() { throw Object.assign(new Error('none'), { code: 'WEB_PROVIDER_UNAVAILABLE' }) },
        selectFetchProvider() { throw Object.assign(new Error('none'), { code: 'WEB_PROVIDER_UNAVAILABLE' }) },
      })
      installDotWeb(ctx as never)
      expect(parentCalls).toEqual([])
      expect(runtime().selectSearchProvider().id).toBe('duckduckgo')
      expect(runtime().selectFetchProvider().id).toBe('jina')
    })
  })

  it('reports a missing search pin instead of running DuckDuckGo when no parent web service exists', async () => {
    await withPins('configured-but-missing', undefined, async () => {
      await withFetchSpy(async calls => {
        const { ctx, runtime } = scopeFixture()
        installDotWeb(ctx as never)
        await expect(runtime().search({ query: 'example' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
        expect(calls).toEqual([])
      })
    })
  })

  it('reports a missing fetch pin instead of running Jina when no parent web service exists', async () => {
    await withPins(undefined, 'configured-but-missing', async () => {
      await withFetchSpy(async calls => {
        const { ctx, runtime } = scopeFixture()
        installDotWeb(ctx as never)
        await expect(runtime().fetch({ url: 'https://example.com' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
        expect(calls).toEqual([])
      })
    })
  })

  it('does not replace an explicit pin when the parent has no usable provider', async () => {
    await withPins('configured-but-missing', 'configured-but-missing', async () => {
      await withFetchSpy(async calls => {
        const unavailable = () => { throw Object.assign(new Error('none'), { code: 'WEB_PROVIDER_UNAVAILABLE' }) }
        const { ctx, runtime } = scopeFixture({
          selectSearchProvider: unavailable,
          search: async () => { throw new Error('should not run') },
          selectFetchProvider: unavailable,
          fetch: async () => { throw new Error('should not run') },
        })
        installDotWeb(ctx as never)
        await expect(runtime().search({ query: 'example' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
        await expect(runtime().fetch({ url: 'https://example.com' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
        expect(calls).toEqual([])
      })
    })
  })

  it('delegates an explicit pin to the parent and still falls back only when nothing is pinned', async () => {
    await withPins('configured', 'configured-fetch', async () => {
      await withFetchSpy(async calls => {
        const { ctx, runtime } = scopeFixture({
          selectSearchProvider: () => ({ id: 'configured' }),
          search: async () => ({ sources: [{ url: 'https://example.com', title: 'Parent' }], truncated: false }),
          selectFetchProvider: () => ({ id: 'configured-fetch' }),
          fetch: async () => ({ url: 'https://example.com/page', statusCode: 200, body: { kind: 'text', content: 'parent' }, truncated: false }),
        })
        installDotWeb(ctx as never)
        expect(runtime().selectSearchProvider().id).toBe('configured')
        expect(runtime().selectFetchProvider().id).toBe('configured-fetch')
        await expect(runtime().search({ query: 'example' })).resolves.toMatchObject({ sources: [{ title: 'Parent' }] })
        await expect(runtime().fetch({ url: 'https://example.com' })).resolves.toMatchObject({ body: { content: 'parent' } })
        expect(calls).toEqual([])
      })
    })
    await withPins(undefined, undefined, async () => {
      await withFetchSpy(async calls => {
        const unavailable = () => { throw Object.assign(new Error('none'), { code: 'WEB_PROVIDER_UNAVAILABLE' }) }
        const { ctx, runtime } = scopeFixture({
          selectSearchProvider: unavailable,
          search: async () => { throw new Error('should not run') },
        })
        installDotWeb(ctx as never)
        await expect(runtime().search({ query: 'example docs' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/docs' }] })
        expect(calls).toEqual(['https://html.duckduckgo.com/html/?q=example+docs'])
      }, html)
    })
  })
})
