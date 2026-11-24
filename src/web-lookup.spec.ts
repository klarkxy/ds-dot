import { describe, expect, it } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  compactGitHubJson, duckDuckGoSearch, fetchWithFallback, gitHubApiFetch, isolatedProviderId, jinaFetch, jinaReaderUrl,
  parseDuckDuckGoHtml, pinnedProviderId, searchWithFallback, unwrapDuckDuckGoUrl, type LookupFetch, type ParentWeb,
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

  it('compacts GitHub API JSON, keeping content fields and dropping endpoint noise', () => {
    const issue = {
      url: 'https://api.github.com/repos/o/r/issues/5',
      repository_url: 'https://api.github.com/repos/o/r',
      labels_url: 'https://api.github.com/repos/o/r/issues/5/labels{/name}',
      comments_url: 'https://api.github.com/repos/o/r/issues/5/comments',
      html_url: 'https://github.com/o/r/issues/5',
      id: 1, node_id: 'I_abc', number: 5,
      title: 'Bug', state: 'open', locked: false,
      body: 'repro steps',
      user: { login: 'octo', id: 7, node_id: 'U_1', avatar_url: 'https://avatars/x', type: 'User', url: 'https://api.github.com/users/octo' },
      labels: [{ id: 9, node_id: 'L_1', url: 'https://api.github.com/labels/bug', name: 'bug', color: 'd73a4a', default: true }],
      assignee: null,
      comments: 3,
      created_at: '2025-01-01T00:00:00Z',
      reactions: { url: 'https://api.github.com/reactions/1', total_count: 2 },
      performed_via_github_app: null,
      score: 1.0,
    }
    const compact = compactGitHubJson(issue) as Record<string, unknown>
    expect(compact).toEqual({
      html_url: 'https://github.com/o/r/issues/5',
      id: 1, number: 5,
      title: 'Bug', state: 'open', locked: false,
      body: 'repro steps',
      user: 'octo',
      labels: ['bug'],
      assignee: null,
      comments: 3,
      created_at: '2025-01-01T00:00:00Z',
      score: 1.0,
    })
  })

  it('collapses repository and review shapes inside a GitHub API response', () => {
    const review = {
      id: 80, node_id: 'PRR_x',
      user: { login: 'reviewer', avatar_url: 'https://avatars/y', type: 'Bot', site_admin: false },
      body: 'looks good', state: 'APPROVED', submitted_at: '2025-01-02T00:00:00Z',
      commit_id: 'abc123',
      html_url: 'https://github.com/o/r/pull/5#pullrequestreview-80',
      pull_request_url: 'https://api.github.com/repos/o/r/pulls/5',
      _links: { html: { href: 'x' } },
      author_association: 'MEMBER',
    }
    const pr = {
      number: 5, title: 'Fix', state: 'open', draft: false, mergeable: true,
      head: {
        ref: 'feat/x', sha: 'aaa',
        user: { login: 'forker', avatar_url: 'u', type: 'User' },
        repo: { id: 3, node_id: 'R_1', name: 'r', full_name: 'forker/r', owner: { login: 'forker', avatar_url: 'a', type: 'User' }, private: false, url: 'https://api.github.com/repos/forker/r', description: 'the fork', fork: true },
      },
      base: {
        ref: 'main', sha: 'bbb',
        user: { login: 'o', avatar_url: 'u2', type: 'User' },
        repo: { id: 1, node_id: 'R_0', name: 'r', full_name: 'o/r', owner: { login: 'o', avatar_url: 'a2', type: 'User' }, private: false, url: 'https://api.github.com/repos/o/r', description: 'the repo', fork: false },
      },
      url: 'https://api.github.com/repos/o/r/pulls/5',
      html_url: 'https://github.com/o/r/pull/5',
      diff_url: 'https://github.com/o/r/pull/5.diff',
      patch_url: 'https://github.com/o/r/pull/5.patch',
      issue_url: 'https://api.github.com/repos/o/r/issues/5',
      commits_url: 'https://api.github.com/repos/o/r/pulls/5/commits',
      review_comments_url: 'https://api.github.com/repos/o/r/pulls/5/comments',
      statuses_url: 'https://api.github.com/repos/o/r/statuses/aaa',
      user: { login: 'author', avatar_url: 'b', type: 'User' },
      assignee: { login: 'owner1', avatar_url: 'c', type: 'User' },
      assignees: [{ login: 'owner1', avatar_url: 'c', type: 'User' }],
      requested_reviewers: [{ login: 'rev1', avatar_url: 'd', type: 'User' }],
      merged_by: { login: 'maintainer', avatar_url: 'e', type: 'User' },
      labels: [{ name: 'ready', color: '0e8a16' }],
      merged_at: null, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-03T00:00:00Z',
      additions: 12, deletions: 4, changed_files: 2,
    }
    expect(compactGitHubJson(review)).toEqual({
      id: 80,
      user: 'reviewer',
      body: 'looks good', state: 'APPROVED', submitted_at: '2025-01-02T00:00:00Z',
      commit_id: 'abc123',
      html_url: 'https://github.com/o/r/pull/5#pullrequestreview-80',
      author_association: 'MEMBER',
    })
    expect(compactGitHubJson(pr)).toEqual({
      number: 5, title: 'Fix', state: 'open', draft: false, mergeable: true,
      head: { ref: 'feat/x', sha: 'aaa', user: 'forker', repo: 'forker/r' },
      base: { ref: 'main', sha: 'bbb', user: 'o', repo: 'o/r' },
      html_url: 'https://github.com/o/r/pull/5',
      user: 'author',
      assignee: 'owner1',
      assignees: ['owner1'],
      requested_reviewers: ['rev1'],
      merged_by: 'maintainer',
      labels: ['ready'],
      merged_at: null, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-03T00:00:00Z',
      additions: 12, deletions: 4, changed_files: 2,
    })
    const raw = JSON.stringify({ review, pr })
    const small = JSON.stringify(compactGitHubJson({ review, pr }))
    expect(small.length).toBeLessThan(raw.length / 2)
  })

  it('preserves primary API records for repo details, user profiles, labels, and repo search', () => {
    const repo = {
      id: 42, node_id: 'R_42', name: 'ds-dot', full_name: 'klarkxy/ds-dot',
      private: false,
      owner: { login: 'klarkxy', id: 1, node_id: 'U_1', avatar_url: 'https://avatars/1', type: 'User' },
      organization: { login: 'klarkxy', id: 1, node_id: 'O_1', avatar_url: 'https://avatars/1', type: 'Organization' },
      html_url: 'https://github.com/klarkxy/ds-dot',
      url: 'https://api.github.com/repos/klarkxy/ds-dot',
      pulls_url: 'https://api.github.com/repos/klarkxy/ds-dot/pulls{/number}',
      description: 'Dorothy sidebar coordinator',
      default_branch: 'dev',
      fork: false,
    }
    expect(compactGitHubJson(repo)).toEqual({
      id: 42, name: 'ds-dot', full_name: 'klarkxy/ds-dot',
      private: false,
      owner: 'klarkxy',
      organization: 'klarkxy',
      html_url: 'https://github.com/klarkxy/ds-dot',
      description: 'Dorothy sidebar coordinator',
      default_branch: 'dev',
      fork: false,
    })

    const user = {
      login: 'klarkxy', id: 7, node_id: 'U_7',
      avatar_url: 'https://avatars/7', gravatar_id: '',
      url: 'https://api.github.com/users/klarkxy',
      html_url: 'https://github.com/klarkxy',
      repos_url: 'https://api.github.com/users/klarkxy/repos',
      type: 'User', name: 'Klark', bio: 'Building tools', public_repos: 12,
    }
    expect(compactGitHubJson(user)).toEqual({
      login: 'klarkxy', id: 7,
      html_url: 'https://github.com/klarkxy',
      type: 'User', name: 'Klark', bio: 'Building tools', public_repos: 12,
    })

    const labels = [
      { id: 1, node_id: 'L_1', url: 'https://api.github.com/repos/klarkxy/ds-dot/labels/bug', name: 'bug', color: 'd73a4a', default: true, description: 'Broken behavior' },
      { id: 2, node_id: 'L_2', url: 'https://api.github.com/repos/klarkxy/ds-dot/labels/feat', name: 'feat', color: '0e8a16', default: false, description: 'New capability' },
    ]
    expect(compactGitHubJson(labels)).toEqual([
      { id: 1, name: 'bug', color: 'd73a4a', default: true, description: 'Broken behavior' },
      { id: 2, name: 'feat', color: '0e8a16', default: false, description: 'New capability' },
    ])

    const searchRepos = {
      total_count: 1,
      incomplete_results: false,
      items: [repo],
    }
    expect(compactGitHubJson(searchRepos)).toEqual({
      total_count: 1,
      incomplete_results: false,
      items: [{
        id: 42, name: 'ds-dot', full_name: 'klarkxy/ds-dot',
        private: false,
        owner: 'klarkxy',
        organization: 'klarkxy',
        html_url: 'https://github.com/klarkxy/ds-dot',
        description: 'Dorothy sidebar coordinator',
        default_branch: 'dev',
        fork: false,
      }],
    })
  })

  it('fetches api.github.com directly and returns compacted JSON', async () => {
    const seen: Array<{ url: string; headers: unknown }> = []
    const fetch: LookupFetch = async (input, init) => {
      seen.push({ url: input, headers: init.headers })
      return jsonResponse(JSON.stringify({ number: 5, title: 'Bug', node_id: 'I_x', url: 'https://api.github.com/repos/o/r/issues/5', html_url: 'https://github.com/o/r/issues/5', user: { login: 'octo', avatar_url: 'a', type: 'User' } }), 200, 'application/json')
    }
    const attempt = await gitHubApiFetch('https://api.github.com/repos/o/r/issues/5', { fetch })
    expect(seen).toEqual([{ url: 'https://api.github.com/repos/o/r/issues/5', headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-dot' } }])
    expect(attempt?.ok).toBe(true)
    if (!attempt?.ok) throw new Error('expected a direct result')
    const result = attempt.result
    expect(result).toMatchObject({ url: 'https://api.github.com/repos/o/r/issues/5', statusCode: 200, truncated: false })
    expect(result.body).toEqual({ kind: 'text', content: JSON.stringify({ number: 5, title: 'Bug', html_url: 'https://github.com/o/r/issues/5', user: 'octo' }, null, 1) })
  })

  it('upgrades http://api.github.com to https:// on the wire', async () => {
    const seen: string[] = []
    const fetch: LookupFetch = async (input) => {
      seen.push(input)
      return jsonResponse(JSON.stringify({ full_name: 'o/r', default_branch: 'dev', owner: { login: 'o', avatar_url: 'a', type: 'User' } }), 200, 'application/json')
    }
    const attempt = await gitHubApiFetch('http://api.github.com/repos/o/r?per_page=10', { fetch })
    expect(seen).toEqual(['https://api.github.com/repos/o/r?per_page=10'])
    expect(attempt?.ok).toBe(true)
    if (!attempt?.ok) throw new Error('expected upgraded direct result')
    expect(attempt.result.url).toBe('https://api.github.com/repos/o/r?per_page=10')
  })

  it('reads >200k raw PR lists cleanly before compacting, truncates only post-compaction, and falls back past rawCap', async () => {
    const noiseRepo = {
      id: 1, node_id: 'R_1', name: 'r', full_name: 'o/r',
      owner: { login: 'o', avatar_url: 'https://avatars/o', type: 'User', followers_url: 'https://api.github.com/users/o/followers' },
      description: 'x'.repeat(3_000),
      pulls_url: 'https://api.github.com/repos/o/r/pulls{/number}',
      issues_url: 'https://api.github.com/repos/o/r/issues{/number}',
      statuses_url: 'https://api.github.com/repos/o/r/statuses/{sha}',
    }
    const prs = Array.from({ length: 40 }, (_, idx) => ({
      number: idx + 1,
      title: `PR ${idx + 1}`,
      state: 'open',
      node_id: `PR_${idx + 1}`,
      url: `https://api.github.com/repos/o/r/pulls/${idx + 1}`,
      html_url: `https://github.com/o/r/pull/${idx + 1}`,
      user: { login: `dev${idx + 1}`, avatar_url: 'a', type: 'User' },
      head: { ref: `feat/${idx + 1}`, sha: `sha${idx + 1}`, repo: noiseRepo },
      base: { ref: 'dev', sha: 'base', repo: noiseRepo },
      reactions: { url: 'https://api.github.com/reactions/1', total_count: 0 },
    }))
    const raw = JSON.stringify(prs)
    expect(raw.length).toBeGreaterThan(200_000)

    const fetch: LookupFetch = async () => jsonResponse(raw, 200, 'application/json')
    const full = await gitHubApiFetch('https://api.github.com/repos/o/r/pulls', { fetch, maxChars: 200_000 })
    expect(full?.ok).toBe(true)
    if (!full?.ok) throw new Error('expected compacted list')
    expect(full.result.truncated).toBe(false)
    expect(full.result.body.kind).toBe('text')
    const parsed = JSON.parse((full.result.body as { content: string }).content) as Array<{ number: number }>
    expect(parsed).toHaveLength(40)
    expect(parsed.map(item => item.number)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))

    const clipped = await gitHubApiFetch('https://api.github.com/repos/o/r/pulls', { fetch, maxChars: 200 })
    expect(clipped?.ok).toBe(true)
    if (!clipped?.ok) throw new Error('expected clipped result')
    expect(clipped.result.truncated).toBe(true)
    expect((clipped.result.body as { content: string }).content).toHaveLength(200)

    let cancelled = false
    const oversized: LookupFetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`[{"title":"${'a'.repeat(2_000_100)}"}]`))
      },
      cancel() { cancelled = true },
    }))
    expect(await gitHubApiFetch('https://api.github.com/repos/o/r/pulls', { fetch: oversized, maxChars: 200_000 })).toEqual({ ok: false, cooldown: false })
    expect(cancelled).toBe(true)
  })

  it('marks rate limits and network failures as cooldown-worthy, other misses as one-off', async () => {
    const status = (code: number): LookupFetch => async () => jsonResponse('no', code)
    expect(await gitHubApiFetch('https://api.github.com/rate_limit', { fetch: status(403) })).toEqual({ ok: false, cooldown: true })
    expect(await gitHubApiFetch('https://api.github.com/rate_limit', { fetch: status(429) })).toEqual({ ok: false, cooldown: true })
    expect(await gitHubApiFetch('https://api.github.com/missing', { fetch: status(404) })).toEqual({ ok: false, cooldown: false })
    expect(await gitHubApiFetch('https://api.github.com/broken', { fetch: status(500) })).toEqual({ ok: false, cooldown: false })
    const network: LookupFetch = async () => { throw new TypeError('connect reset') }
    expect(await gitHubApiFetch('https://api.github.com/', { fetch: network })).toEqual({ ok: false, cooldown: true })
    const notJson: LookupFetch = async () => jsonResponse('<html>no</html>', 200)
    expect(await gitHubApiFetch('https://api.github.com/', { fetch: notJson })).toEqual({ ok: false, cooldown: false })
  })

  it('times the direct attempt out on its own short budget', async () => {
    const hanging: LookupFetch = (_input, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })))
    })
    expect(await gitHubApiFetch('https://api.github.com/slow', { fetch: hanging, timeoutMs: 20 })).toEqual({ ok: false, cooldown: true })
  })

  it('propagates a caller abort instead of falling back or cooling down', async () => {
    const calls: string[] = []
    const fetch: LookupFetch = async (input, init) => {
      calls.push(input)
      init.signal?.addEventListener('abort', () => {})
      return jsonResponse('{}')
    }
    const already = AbortSignal.abort()
    await expect(gitHubApiFetch('https://api.github.com/x', { fetch, signal: already })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(calls).toEqual([])

    const controller = new AbortController()
    const hanging: LookupFetch = (_input, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    const attempt = gitHubApiFetch('https://api.github.com/y', { fetch: hanging, signal: controller.signal, timeoutMs: 5_000 })
    controller.abort()
    await expect(attempt).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('defers to the normal path on other hosts and invalid URLs', async () => {
    let calls = 0
    const other: LookupFetch = async () => { calls += 1; return jsonResponse('{}') }
    expect(await gitHubApiFetch('https://github.com/o/r', { fetch: other })).toBeUndefined()
    expect(await gitHubApiFetch('https://api.github.com.evil/x', { fetch: other })).toBeUndefined()
    expect(await gitHubApiFetch('not a url', { fetch: other })).toBeUndefined()
    expect(calls).toBe(0)
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
