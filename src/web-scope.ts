/**
 * Dot's own web capability. `ctx.isolate('web')` keeps the agent scope, so the
 * official `web_search` / `web_fetch` tools registered here shadow the global
 * ones for Dorothy only. Providers are registered on that isolated service,
 * never on the deployment web service.
 */
import type { Context } from '@deepseek-ai/cordis'
import { applyWebFetchTool, applyWebSearchTool } from '@deepseek-ai/dsh-tool-web'
import { WebRuntime, type WebFetchProvider, type WebSearchProvider } from '@deepseek-ai/dsh-web'
import {
  duckDuckGoSearch, fetchReady, fetchWithFallback, isolatedProviderId, jinaFetch, searchReady, searchWithFallback,
  type LookupFetch, type ParentWeb,
} from './web-lookup.ts'

const SEARCH_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 30_000
const SEARCH_MAX_RESULTS = 8
const SEARCH_MAX_QUERIES = 4
const SEARCH_SUMMARY_MAX = 800
const FETCH_MAX_CHARS = 200_000

function parentWeb(ctx: Context): ParentWeb | undefined {
  try {
    const web = (ctx as Context & { web?: ParentWeb }).web
    return web && typeof web === 'object' ? web : undefined
  } catch {
    return undefined
  }
}

function canDelegateSearch(parent: ParentWeb | undefined): boolean {
  return typeof parent?.selectSearchProvider === 'function' && typeof parent.search === 'function'
}

function canDelegateFetch(parent: ParentWeb | undefined): boolean {
  return typeof parent?.selectFetchProvider === 'function' && typeof parent.fetch === 'function'
}

export function dotSearchProvider(parent: ParentWeb | undefined, fetch: LookupFetch = globalThis.fetch.bind(globalThis)): WebSearchProvider | undefined {
  const pinned = process.env.DSH_WEB_SEARCH_PROVIDER?.trim() || undefined
  const id = isolatedProviderId(pinned, 'duckduckgo', canDelegateSearch(parent))
  if (!id) return undefined
  return {
    id,
    available: () => true,
    ready: llmProvider => searchReady(parent, llmProvider),
    search: (request, signal) => searchWithFallback(parent, request, signal, () => duckDuckGoSearch(request.query, {
      fetch, signal, timeoutMs: SEARCH_TIMEOUT_MS, maxResults: request.maxResults,
    }), pinned),
  }
}

export function dotFetchProvider(parent: ParentWeb | undefined, fetch: LookupFetch = globalThis.fetch.bind(globalThis)): WebFetchProvider | undefined {
  const pinned = process.env.DSH_WEB_FETCH_PROVIDER?.trim() || undefined
  const id = isolatedProviderId(pinned, 'jina', canDelegateFetch(parent))
  if (!id) return undefined
  return {
    id,
    available: () => true,
    ready: llmProvider => fetchReady(parent, llmProvider),
    fetch: (request, signal) => fetchWithFallback(parent, request, signal, () => jinaFetch(request.url, {
      fetch, signal, timeoutMs: FETCH_TIMEOUT_MS, maxChars: FETCH_MAX_CHARS,
    }), pinned),
  }
}

/** Start Dorothy's web tools. No-op outside a Cordis context, so unit fixtures that only compile schemas stay quiet. */
export function installDotWeb(ctx: Context): void {
  if (typeof ctx.isolate !== 'function') return
  const parent = parentWeb(ctx)
  const scoped = ctx.isolate('web')
  new WebRuntime(scoped, {
    searchProvider: { get: () => undefined },
    fetchProvider: { get: () => undefined },
  } as never)
  const search = dotSearchProvider(parent)
  const fetchProvider = dotFetchProvider(parent)
  if (search) scoped.web.registerSearchProvider(search)
  if (fetchProvider) scoped.web.registerFetchProvider(fetchProvider)
  applyWebSearchTool(scoped, SEARCH_MAX_RESULTS, SEARCH_MAX_QUERIES, SEARCH_SUMMARY_MAX, SEARCH_TIMEOUT_MS, true)
  applyWebFetchTool(scoped, FETCH_TIMEOUT_MS, FETCH_MAX_CHARS)
}
