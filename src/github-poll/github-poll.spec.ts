import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type DotSettings, type InboxEventInput } from '../contracts.ts'
import { InboxLedger, memoryInboxTable } from '../inbox.ts'
import { installInboxIngress, normalizeGithub, type WebhookRule, type WebhookRuntimeLike } from '../inbox-github.ts'
import { makeTaskLink } from '../links.ts'
import { PeerLedger } from '../peer.ts'
import { patchSettings } from '../settings.ts'
import { DotService } from '../service.ts'
import { parseInboxRecord, parsePeerDelivery } from '../storage.ts'
import { DotStore, type DotDomainHandle } from '../store.ts'
import {
  CliError,
  GhCli,
  GithubPollCursorStore,
  GithubPollSourceAdapter,
  GithubPoller,
  branchCiTriggerId,
  ciCounts,
  ciFailures,
  ciSummary,
  classifyGithubSender,
  commandError,
  commentText,
  computeRateBudget,
  formatInlineAndSpill,
  githubAddress,
  isHumanLogin,
  mentions,
  pullChecks,
  redactGithubTokens,
  repoPath,
  resolveGithubAdmission,
  reviewPlace,
  reviewThread,
  testGhAvailability,
  type ExecFileRunner,
} from './index.ts'

function memoryDomain(): { domain: DotDomainHandle; tables: Record<string, Map<string, unknown>>; puts: string[] } {
  const names = ['state', 'tasks', 'schedules', 'proposals', 'recipes', 'links', 'recipe_proposals', 'changes', 'inputs', 'runs', 'verifications', 'peers', 'inbox', 'github_poll', 'watchdog']
  const tables: Record<string, Map<string, unknown>> = {}
  for (const name of names) tables[name] = new Map()
  const puts: string[] = []
  const domain: DotDomainHandle = {
    table: name => ({
      entries: () => tables[name]!.entries(),
      get: key => tables[name]!.get(key),
      put: async (key, value) => { puts.push(`${name}:${key}`); tables[name]!.set(key, value) },
      delete: async key => { puts.push(`${name}:-${key}`); return tables[name]!.delete(key) },
      update: async (key, recipe) => {
        const rows = tables[name]!
        const next = recipe(rows.get(key))
        rows.set(key, next)
        return next
      },
    }),
    close: async () => {},
  }
  return { domain, tables, puts }
}

function makeFakeHost(home: string) {
  const relayed: Array<{ target: string; sender: string; text: string; deliveryId?: string }> = []
  const prompted: Array<{ sessionId: string; text: string }> = []
  const created: string[] = []
  let runningDot = false
  let seq = 0
  const sessionEvents = new Map<string, Array<{ type: string; time: number; data: unknown }>>()
  const host = {
    isRunning: (id: string) => (id === 'dot-1' ? runningDot : false),
    setDotRunning: (v: boolean) => { runningDot = v },
    listSessions: async () => [],
    readEvents: async (id: string) => sessionEvents.get(id) ?? [],
    listWorkspaces: () => [{ id: 'home', path: home, title: 'Dorothy', sessionCount: 0 }],
    createWorkspace: async () => ({ id: 'home', path: home, title: 'Dorothy', sessionCount: 0 }),
    createDot: async () => 'dot-1',
    resumeDot: async (id: string) => id === 'dot-1',
    findSession: async (id: string) => (created.includes(id) ? { cwd: home, preset: 'standard' } : undefined),
    createSession: async (input: { sessionId: string }) => { created.push(input.sessionId); return { sessionId: input.sessionId, cwd: home, preset: 'standard' } },
    prepareAccess: async () => 'ok' as const,
    setReadOnly: async () => true,
    setWritable: async () => true,
    verifyTaskPermission: async () => true,
    prompt: async (sessionId: string, text: string, _mode?: unknown, _signal?: unknown, requestId?: string) => {
      prompted.push({ sessionId, text })
      const rows = sessionEvents.get(sessionId) ?? []
      rows.push({ type: 'user/message', time: 1000, data: { content: text, source: { kind: 'user', rpcId: requestId } } })
      sessionEvents.set(sessionId, rows)
      return 'accepted' as const
    },
    promptReceipts: async () => 1,
    relay: async (target: string, sender: string, text: string, deliveryId?: string) => {
      relayed.push({ target, sender, text, ...(deliveryId ? { deliveryId } : {}) })
      const rows = sessionEvents.get(target) ?? []
      rows.push({
        type: 'user/message',
        time: 1000,
        data: {
          content: text,
          source: { kind: 'agent-message', form: 'relay', deliveryId, senderSessionId: sender },
        },
      })
      sessionEvents.set(target, rows)
      return 'accepted' as const
    },
    relayInserts: async (sessionId: string, deliveryId?: string) => {
      const rows = sessionEvents.get(sessionId) ?? []
      return rows.filter(r => (r.data as { deliveryId?: string })?.deliveryId === deliveryId).length
    },
    stop: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }),
    stopActivity: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }),
    listPresets: async () => ({ presets: [{ id: 'standard', name: 'Standard' }], defaultPreset: 'standard' }),
    listModels: async () => ({ models: [], defaultModel: { provider: 'p', model: 'm' } }),
    modelKey: () => 'p/m',
    dotModel: () => ({ provider: 'p', model: 'm' }),
    syncModel: () => {},
    dotContext: async () => ({ live: true, usedTokens: 100, limitTokens: 10000 }),
    latestReply: async () => 'ok',
    archive: async () => {},
  }
  return {
    host,
    relayed,
    prompted,
    nextSeq: () => ++seq,
  }
}

function makeHarness(exec: ExecFileRunner, nowFn: () => number = () => 1_700_000_000_000) {
  const home = mkdtempSync(join(tmpdir(), 'dot-gh-poll-'))
  const { domain, tables, puts } = memoryDomain()
  const store = new DotStore(domain)
  const inbox = new InboxLedger(domain.table('inbox'), parseInboxRecord)
  const peers = new PeerLedger(domain.table('peers'), parsePeerDelivery)
  const fake = makeFakeHost(home)
  const logs: string[] = []
  const traces: Array<{ event: string; message: string; data?: Record<string, unknown> }> = []
  const service = new DotService({
    host: fake.host as never,
    store,
    homeDir: home,
    inbox,
    peers,
    approvalGraceMs: 0,
    now: nowFn,
    timer: { set: () => 1, clear() {}, now: nowFn },
    log: msg => logs.push(msg),
    trace: {
      info: (event, message, data) => { traces.push({ event, message, ...(data ? { data } : {}) }); return true },
      debug: (event, message, data) => { traces.push({ event, message, ...(data ? { data } : {}) }); return true },
      warn: (event, message, _err, data) => { traces.push({ event, message, ...(data ? { data } : {}) }); return true },
    },
    ghExec: exec,
  })
  return {
    home,
    domain,
    tables,
    puts,
    store,
    inbox,
    peers,
    service,
    logs,
    traces,
    ...fake,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

function authSuccessStdout(login = 'klarkxy', host = 'github.com'): string {
  return JSON.stringify({
    hosts: {
      [host]: [{ state: 'success', active: true, host, login, tokenSource: 'GH_TOKEN' }],
    },
  })
}

function httpInclude(headers: Record<string, string>, body: unknown, status = 'HTTP/2.0 200 OK'): string {
  const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
  return `${status}\n${headerLines}\r\n\r\n${typeof body === 'string' ? body : JSON.stringify(body)}`
}

describe('gh-cli & upstream commands/read contracts', () => {
  it('enforces repo-path fence, literal argv without shell interpolation, GH_PROMPT_DISABLED, and token redaction', async () => {
    expect(() => repoPath('acme/widgets', '/repos/other')).toThrow(/restricted/)
    expect(() => repoPath('acme/widgets', '../secret')).toThrow(/restricted/)
    expect(() => repoPath('acme/widgets', 'https://evil.com/x')).toThrow(/restricted/)
    expect(repoPath('Acme/Widgets', 'issues?state=all')).toBe('repos/Acme/Widgets'.toLowerCase() + '/issues?state=all')

    const seenArgs: string[][] = []
    const seenEnvs: NodeJS.ProcessEnv[] = []
    const cli = new GhCli({
      env: { GH_TOKEN: 'ghp_supersecret1234567890' },
      exec: async (_bin, args, opts) => {
        seenArgs.push([...args])
        seenEnvs.push(opts.env)
        if (args[0] === 'api' && args[1] === 'repos/acme/widgets/issues') {
          return { stdout: '{"ok":true}', stderr: '' }
        }
        throw Object.assign(new Error('cmd failed'), {
          code: 1,
          stderr: 'gh: fatal with ghp_secret1234567890 github_pat_abcDEF123456 Bearer tok_xyz_12345 and https://alice:pass123@github.com/acme/widgets (HTTP 500)',
        })
      },
    })
    await cli.apiRaw('repos/acme/widgets/issues', ['$(whoami)', ';rm -rf /'])
    expect(seenArgs[0]).toEqual(['api', 'repos/acme/widgets/issues', '$(whoami)', ';rm -rf /'])
    expect(seenEnvs[0]!.GH_PROMPT_DISABLED).toBe('1')
    expect(seenEnvs[0]!.GH_NO_UPDATE_NOTIFIER).toBe('1')

    await expect(cli.exec(['auth', 'token'])).rejects.toThrow(/never be called/)

    let caught: unknown
    try {
      await cli.apiRaw('repos/acme/widgets/fail', ['--secret-arg-marker'])
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CliError)
    const msg = (caught as CliError).message
    expect(msg).not.toContain('ghp_secret1234567890')
    expect(msg).not.toContain('github_pat_abcDEF123456')
    expect(msg).not.toContain('tok_xyz_12345')
    expect(msg).not.toContain('pass123')
    expect(msg).not.toContain('--secret-arg-marker')
    expect(msg).toContain('[REDACTED]')
    expect(redactGithubTokens('x-access-token:ghs_abc123@github.com')).toBe('x-access-token:[REDACTED]@github.com')
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(commandError(abortErr).name).toBe('AbortError')
  })

  it('inspects gh auth status --json hosts (not exit code 0 alone), resolves win32 gh.exe, and supports --hostname', async () => {
    const calls: Array<{ bin: string; args: string[] }> = []
    const unauthed = await testGhAvailability({
      exec: async (bin, args) => {
        calls.push({ bin, args: [...args] })
        if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
        // Real gh exits 0 with empty hosts map when unauthenticated!
        return { stdout: '{"hosts":{}}', stderr: 'You are not logged into any GitHub hosts.' }
      },
    })
    expect(unauthed.ghFound).toBe(true)
    expect(unauthed.authenticated).toBe(false)
    expect(unauthed.ok).toBe(false)

    const winCalls: string[] = []
    const ghes = await testGhAvailability({
      ghPath: 'gh',
      hostname: 'github.example.com',
      repos: ['Acme/Widgets'],
      platform: 'win32',
      fileExists: p => p.endsWith('GitHub CLI\\gh.exe'),
      exec: async (bin, args) => {
        winCalls.push(bin)
        if (bin === 'gh') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
        if (args[0] === 'auth') {
          expect(args).toContain('--hostname')
          expect(args).toContain('github.example.com')
          return { stdout: authSuccessStdout('octo', 'github.example.com'), stderr: '' }
        }
        if (args.includes('rate_limit')) {
          return { stdout: JSON.stringify({ resources: { core: { remaining: 4990, limit: 5000 } } }), stderr: '' }
        }
        return { stdout: JSON.stringify({ full_name: 'acme/widgets' }), stderr: '' }
      },
    })
    expect(winCalls).toContain('gh.exe')
    expect(ghes.ok).toBe(true)
    expect(ghes.login).toBe('octo')
    expect(ghes.host).toBe('github.example.com')
    expect(ghes.rateLimitRemaining).toBe(4990)
    expect(ghes.repoChecks).toEqual([{ repo: 'acme/widgets', ok: true }])
  })

  it('parses --include headers case-insensitively and paginates with --paginate --slurp without --include', async () => {
    const calls: string[][] = []
    const cli = new GhCli({
      exec: async (_bin, args) => {
        calls.push([...args])
        if (args.includes('--include')) {
          return {
            stdout: httpInclude({
              Etag: 'W/"abc"',
              'X-Poll-Interval': '180',
              'X-Ratelimit-Remaining': '4200',
              Link: '<https://api.github.com/repos/acme/widgets/issues?page=2>; rel="next"',
            }, [{ id: 1 }]),
            stderr: '',
          }
        }
        expect(args).toContain('--paginate')
        expect(args).toContain('--slurp')
        expect(args).not.toContain('--include')
        return { stdout: JSON.stringify([[{ id: 1 }], [{ id: 2 }, { bad: true }]]), stderr: '' }
      },
    })
    const tally = { skipped: 0 }
    const res = await cli.repoPagesWithHeaders(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { safeParse: (v: any) => v && typeof v.id === 'number' ? { success: true, data: v } : { success: false } } as never,
      'acme/widgets',
      'issues?state=all',
      [],
      tally,
    )
    expect(res.notModified).toBe(false)
    expect(res.headers.etag).toBe('W/"abc"')
    expect(res.headers.pollIntervalSec).toBe(180)
    expect(res.headers.rateLimitRemaining).toBe(4200)
    if (!res.notModified) {
      expect(res.items).toEqual([{ id: 1 }, { id: 2 }])
    }
    expect(tally.skipped).toBe(1)
    expect(calls).toHaveLength(2)
  })

  it('covers upstream triggers, ciSummary, pullChecks deduplication, and reviewThread ordering', async () => {
    expect(isHumanLogin({ login: 'alice', type: 'User' })).toBe(true)
    expect(isHumanLogin({ login: 'dependabot[bot]', type: 'Bot' })).toBe(false)
    expect(mentions('Hey @Alice, PTAL', 'alice')).toBe(true)
    expect(mentions('email foo@alice.com', 'alice')).toBe(false)
    expect(githubAddress('https://github.com/Acme/Widgets/pull/12#discussion_r99', 'acme/widgets')).toEqual({
      number: 12, pr: true, discussion: 99,
    })
    expect(reviewPlace({ path: 'src/a.ts', line: 10, diff_hunk: 'a\nb\nc\nd\ne' })).toBe('src/a.ts:10\nc\nd\ne')
    expect(commentText({ id: 1, user: { login: 'bob' }, state: 'COMMENTED', body: '  ' }, 'review')).toBe('')
    expect(commentText({ id: 2, user: { login: 'bob' }, state: 'APPROVED', commit_id: 'abcdef123456', body: '' }, 'review')).toContain('APPROVED review of commit abcdef1234')

    const cli = new GhCli({
      exec: async (_bin, args) => {
        const path = args[1] ?? ''
        if (path.includes('check-runs')) {
          return { stdout: JSON.stringify({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'in_progress', conclusion: null }] }), stderr: '' }
        }
        if (path.includes('statuses')) {
          return { stdout: JSON.stringify([[{ context: 'deploy', state: 'error' }, { context: 'deploy', state: 'success' }]]), stderr: '' }
        }
        if (path.includes('pulls/7/comments')) {
          return {
            stdout: JSON.stringify([[
              { id: 20, in_reply_to_id: 10, created_at: '2026-11-26T00:02:00Z', user: { login: 'bob' }, body: 'reply' },
              { id: 10, created_at: '2026-11-26T00:01:00Z', user: { login: 'alice' }, body: 'root' },
              { id: 30, created_at: '2026-11-26T00:03:00Z', user: { login: 'carol' }, body: 'other' },
            ]]),
            stderr: '',
          }
        }
        throw new Error(`unexpected ${path}`)
      },
    })
    const snapshot = await pullChecks(cli, 'acme/widgets', '1234567890')
    expect(ciCounts(snapshot)).toEqual({ total: 3, failed: 2, running: 1 })
    expect(ciFailures(snapshot)).toEqual(['build', 'deploy'])
    expect(ciSummary(snapshot, 'acme/widgets@main', 'gh api ...')).toContain('CI failed 2/3 on acme/widgets@main at 1234567: build, deploy; 1 still running')

    const thread = await reviewThread(cli, 'acme/widgets', 7, 20)
    expect(thread.map(c => c.id)).toEqual([10, 20])
  })
})

describe('PR-5 mandatory 17+ polling, admission, routing & security scenarios', () => {
  it('1 & 3: cold-start baseline prevents historical flood, and HTTP 304 produces zero state/UI writes', async () => {
    let now = 1_700_000_000_000
    let send304 = false
    const h = makeHarness(async (_bin, args) => {
      if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
      if (args[0] === 'auth') return { stdout: authSuccessStdout(), stderr: '' }
      if (args[1] === 'rate_limit') return { stdout: JSON.stringify({ resources: { core: { remaining: 5000, limit: 5000 } } }), stderr: '' }
      if (args[1] === 'repos/acme/widgets') return { stdout: JSON.stringify({ full_name: 'acme/widgets', default_branch: 'main' }), stderr: '' }
      if (args[1]?.startsWith('repos/acme/widgets/commits/main')) return { stdout: JSON.stringify({ sha: 'sha111' }), stderr: '' }
      if (args[1]?.includes('check-runs')) return { stdout: JSON.stringify({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }), stderr: '' }
      if (args[1]?.includes('statuses')) return { stdout: JSON.stringify([[]]), stderr: '' }
      if (send304) {
        throw Object.assign(new Error('gh: HTTP 304'), { code: 1, stderr: 'gh: HTTP 304\n' })
      }
      return {
        stdout: httpInclude({ Etag: 'W/"etag-1"', 'X-Ratelimit-Remaining': '4990' }, [
          { id: 1, number: 1, title: 'Old issue', state: 'open', created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/1', user: { login: 'alice' }, body: 'old' },
        ]),
        stderr: '',
      }
    }, () => now)

    try {
      await h.store.setSettings(patchSettings(DEFAULT_SETTINGS, {
        reflection: false,
        idleCheckMinutes: 0,
        githubPoll: { enabled: true, repos: ['Acme/Widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: true, pulls: true, comments: true, ci: true }, ignoredActors: [] },
      }))
      let boardChanges = 0
      h.store.onChange(() => { boardChanges += 1 })

      // Poll 1: cold start establishes baselines without flooding historical issues/CI failures.
      const r1 = await h.service.pollGithubNow()
      expect(r1).toEqual({ ok: true, events: 0 })
      expect(h.inbox.list()).toHaveLength(0)

      // Poll 2: fetches ETag W/"etag-1" with no new items
      now += 120_000
      const r2 = await h.service.pollGithubNow()
      expect(r2).toEqual({ ok: true, events: 0 })
      expect(h.inbox.list()).toHaveLength(0)

      // Poll 3: HTTP 304 — zero writes to `state`, zero writes to `github_poll`, zero UI boardChange notifications!
      send304 = true
      h.puts.length = 0
      boardChanges = 0
      now += 120_000
      const r3 = await h.service.pollGithubNow()
      expect(r3).toEqual({ ok: true, events: 0 })
      expect(h.puts).toEqual([])
      expect(boardChanges).toBe(0)
    } finally {
      await h.service.dispose()
      h.cleanup()
    }
  })

  it('2 & 8: honors X-Poll-Interval backoff and auto-raises interval when rate-limit budget >= 50% remaining', async () => {
    const budget = computeRateBudget({
      repoCount: 3,
      enabledStreams: 4,
      userIntervalSec: 120,
      xPollIntervalSec: 180,
      rateLimitRemaining: 200, // 50% = 100/hr; 3*4*(3600/180)=240 >= 100 -> raises interval!
    })
    expect(budget.effectiveIntervalSec).toBeGreaterThan(180)
    expect(budget.hourlyRequests).toBeLessThan(100)
    expect(budget.budgetAdjusted).toBe(true)
    expect(budget.budgetWarning).toContain('Rate-limit budget guard')

    const h = makeHarness(async (_bin, args) => {
      if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
      if (args[0] === 'auth') return { stdout: authSuccessStdout(), stderr: '' }
      if (args[1] === 'rate_limit') return { stdout: JSON.stringify({ resources: { core: { remaining: 5000, limit: 5000 } } }), stderr: '' }
      if (args[1] === 'repos/acme/widgets') return { stdout: JSON.stringify({ default_branch: 'main' }), stderr: '' }
      if (args[1]?.startsWith('repos/acme/widgets/commits/main')) return { stdout: JSON.stringify({ sha: 'sha1' }), stderr: '' }
      if (args[1]?.includes('check-runs')) return { stdout: JSON.stringify({ check_runs: [] }), stderr: '' }
      if (args[1]?.includes('statuses')) return { stdout: JSON.stringify([[]]), stderr: '' }
      return { stdout: httpInclude({ 'X-Poll-Interval': '240', 'X-Ratelimit-Remaining': '40' }, []), stderr: '' }
    })
    try {
      await h.store.setSettings(patchSettings(DEFAULT_SETTINGS, {
        reflection: false,
        idleCheckMinutes: 0,
        githubPoll: { enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: true, pulls: false, comments: false, ci: false }, ignoredActors: [] },
      }))
      await h.service.pollGithubNow() // cold-start
      await h.service.pollGithubNow() // receives X-Poll-Interval: 240 and X-Ratelimit-Remaining: 40 (50% = 20/hr -> >=180s)
      const status = h.service.githubPollStatus()
      expect(status.xPollIntervalSec).toBe(240)
      expect(status.effectiveIntervalSec).toBeGreaterThanOrEqual(240)
      expect(status.budgetAdjusted).toBe(false) // 1*1*(3600/240)=15 < 20
      // Now enable all 4 streams -> 1*4*(3600/240)=60 >= 20 -> auto-raises!
      await h.store.setSettings(patchSettings(h.store.settings, {
        githubPoll: { enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: true, pulls: true, comments: true, ci: true }, ignoredActors: [] },
      }))
      const raised = h.service.githubPollStatus()
      expect(raised.budgetAdjusted).toBe(true)
      expect(raised.effectiveIntervalSec).toBeGreaterThan(240)
      expect(raised.hourlyRequests).toBeLessThan(20)
    } finally {
      await h.service.dispose()
      h.cleanup()
    }
  })

  it('4 & 7: enforces single-repo mutual exclusion and deduplicates Webhook <-> Poll handoff', async () => {
    expect(() => patchSettings(DEFAULT_SETTINGS, {
      githubPoll: { enabled: true, repos: ['Acme/Widgets'], webhookRepos: ['acme/widgets'], ghPath: 'gh', intervalSec: 120, streams: { issues: true, pulls: true, comments: true, ci: true }, ignoredActors: [] },
    })).toThrow(/invalid value/)

    let now = 1_700_000_000_000
    const h = makeHarness(async (_bin, args) => {
      if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
      if (args[0] === 'auth') return { stdout: authSuccessStdout(), stderr: '' }
      if (args[1] === 'rate_limit') return { stdout: JSON.stringify({ resources: { core: { remaining: 5000, limit: 5000 } } }), stderr: '' }
      if (args[1]?.includes('issues/comments')) {
        return {
          stdout: httpInclude({}, [
            // Same comment already delivered via webhook at t=1700000000000:
            { id: 101, body: 'Webhook comment', user: { login: 'alice' }, html_url: 'https://github.com/acme/widgets/issues/5#issuecomment-101', created_at: new Date(1_700_000_000_000).toISOString(), updated_at: new Date(1_700_000_000_000).toISOString() },
            // Newer comment arriving after switch:
            { id: 102, body: 'After switch', user: { login: 'alice' }, html_url: 'https://github.com/acme/widgets/issues/5#issuecomment-102', created_at: new Date(1_700_000_060_000).toISOString(), updated_at: new Date(1_700_000_060_000).toISOString() },
          ]),
          stderr: '',
        }
      }
      return { stdout: httpInclude({}, []), stderr: '' }
    }, () => now)

    try {
      await h.service.ensureDot()
      // Start in Webhook mode for acme/widgets
      await h.store.setSettings(patchSettings(DEFAULT_SETTINGS, {
        reflection: false,
        idleCheckMinutes: 0,
        githubPoll: { enabled: true, repos: [], webhookRepos: ['acme/widgets'], ghPath: 'gh', intervalSec: 120, streams: { issues: false, pulls: false, comments: true, ci: false }, ignoredActors: [] },
      }))
      const registered: WebhookRule[] = []
      const fakeCtx = {
        inject: (_deps: string[], cb: (c: unknown) => void) => cb({
          webhookRuntime: { register: (r: WebhookRule) => { registered.push(r); return async () => {} } } as WebhookRuntimeLike,
          effect: (fn: () => unknown) => fn(),
        }),
      }
      installInboxIngress(fakeCtx as never, h.service, () => {}, {
        shouldAccept: (repo, at) => h.service.shouldAcceptWebhookDelivery(repo, at),
      })
      const webhookDelivery = {
        kind: 'github',
        source: 'primary-github',
        deliveryId: 'wh-101',
        receivedAt: now,
        event: {
          name: 'issue_comment',
          payload: {
            action: 'created',
            repository: { full_name: 'acme/widgets' },
            issue: { number: 5, title: 'Issue 5' },
            comment: { id: 101, body: 'Webhook comment', user: { login: 'alice' }, html_url: 'https://github.com/acme/widgets/issues/5#issuecomment-101' },
          },
        },
      }
      await registered[0]!.run(webhookDelivery, new AbortController().signal)
      expect(h.inbox.list()).toHaveLength(1)
      await h.service.flushNotices()
      expect(h.inbox.list()[0]!.status).toBe('delivered')

      // Switch acme/widgets from Webhook -> Poll
      await h.store.setSettings(patchSettings(h.store.settings, {
        githubPoll: { enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: false, pulls: false, comments: true, ci: false }, ignoredActors: [] },
      }))
      // Late webhook for poll-mode repo must be dropped
      await registered[0]!.run({ ...webhookDelivery, deliveryId: 'wh-late' }, new AbortController().signal)
      expect(h.inbox.list()).toHaveLength(1)

      now += 60_000
      const res = await h.service.pollGithubNow()
      expect(res.ok).toBe(true)
      // Comment 101 is deduped via handoff; only comment 102 is added!
      expect(h.inbox.list()).toHaveLength(2)
      expect(h.inbox.list().some(r => r.summary.includes('After switch'))).toBe(true)
    } finally {
      await h.service.dispose()
      h.cleanup()
    }
  })

  it('5 & 17: >=3 consecutive failures triggers error alert and resets on recovery; missing gh silently degrades', async () => {
    let fail = true
    const h = makeHarness(async (_bin, args) => {
      if (fail) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
      if (args[0] === 'auth') return { stdout: authSuccessStdout(), stderr: '' }
      if (args[1] === 'rate_limit') return { stdout: JSON.stringify({ resources: { core: { remaining: 5000, limit: 5000 } } }), stderr: '' }
      return { stdout: httpInclude({}, []), stderr: '' }
    })
    try {
      await h.store.setSettings(patchSettings(DEFAULT_SETTINGS, {
        reflection: false,
        idleCheckMinutes: 0,
        githubPoll: { enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: true, pulls: false, comments: false, ci: false }, ignoredActors: [] },
      }))
      // Failure 1 & 2: quiet (!alert)
      await expect(h.service.pollGithubNow()).resolves.toMatchObject({ ok: false })
      expect(h.service.githubPollStatus().alert).toBe(false)
      expect(h.service.githubPollStatus().health).toBe('degraded')

      await expect(h.service.pollGithubNow()).resolves.toMatchObject({ ok: false })
      expect(h.service.githubPollStatus().alert).toBe(false)

      // Failure 3: health alert!
      await expect(h.service.pollGithubNow()).resolves.toMatchObject({ ok: false })
      expect(h.service.githubPollStatus().alert).toBe(true)
      expect(h.service.githubPollStatus().health).toBe('error')

      // Recovery resets counter to 0
      fail = false
      await expect(h.service.pollGithubNow()).resolves.toMatchObject({ ok: true })
      expect(h.service.githubPollStatus().alert).toBe(false)
      expect(h.service.githubPollStatus().consecutiveFailures).toBe(0)
      expect(h.service.githubPollStatus().health).toBe('ok')
    } finally {
      await h.service.dispose()
      h.cleanup()
    }
  })

  it('6: preserves local gh human login comments and suppresses self-sent echo IDs', async () => {
    let now = 1_700_000_000_000
    const h = makeHarness(async (_bin, args) => {
      if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
      if (args[0] === 'auth') return { stdout: authSuccessStdout('klarkxy'), stderr: '' }
      if (args[1] === 'rate_limit') return { stdout: JSON.stringify({ resources: { core: { remaining: 5000, limit: 5000 } } }), stderr: '' }
      if (args[1]?.includes('issues/comments')) {
        return {
          stdout: httpInclude({}, [
            { id: 501, body: 'Dorothy auto-posted echo', user: { login: 'klarkxy', type: 'User' }, html_url: 'https://github.com/acme/widgets/issues/3#issuecomment-501', created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() },
            { id: 502, body: 'Human typed from web UI', user: { login: 'klarkxy', type: 'User' }, html_url: 'https://github.com/acme/widgets/issues/3#issuecomment-502', created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() },
          ]),
          stderr: '',
        }
      }
      return { stdout: httpInclude({}, []), stderr: '' }
    }, () => now)

    try {
      await h.store.setSettings(patchSettings(DEFAULT_SETTINGS, {
        reflection: false,
        idleCheckMinutes: 0,
        githubPoll: { enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: false, pulls: false, comments: true, ci: false }, ignoredActors: [] },
      }))
      await h.service.pollGithubNow() // cold-start
      await h.service.recordGithubEcho('acme/widgets', '501', 'issue_comment')
      now += 10_000
      await h.service.pollGithubNow()
      expect(h.inbox.list()).toHaveLength(1)
      expect(h.inbox.list()[0]!.summary).toContain('Human typed from web UI')
      expect(h.inbox.list()[0]!.actor).toBe('klarkxy')
    } finally {
      await h.service.dispose()
      h.cleanup()
    }
  })

  it('9, 10, 11, 12, 14, 15, 16: Fast-Path matrix, many-to-many direct delivery, dot_peer bounce, payload truncation, stopped/finished guards, PR merged closure', async () => {
    const now = 1_700_000_000_000
    const h = makeHarness(async () => ({ stdout: '[]', stderr: '' }), () => now)
    try {
      const dot = await h.service.ensureDot()
      const change = await h.store.work.createChange({
        title: 'Fix auth bug',
        cwd: h.home,
        goal: 'Fix auth bug',
        requirements: [{ requirementRef: 'R1', text: 'Fix auth bug', required: true }],
        maxConcurrentRuns: 2,
        at: now,
      })
      // Active run 1 & Active run 2 on the same PR -> many-to-many
      const r1 = await h.store.work.reserveRun({
        changeId: change.id, kind: 'work', cwd: h.home,
        writeScope: { kind: 'paths', paths: [] }, at: now,
      })
      const r2 = await h.store.work.reserveRun({
        changeId: change.id, kind: 'work', cwd: h.home,
        writeScope: { kind: 'paths', paths: [] }, at: now,
      })
      if (!r1.ok || !r2.ok) throw new Error('reserve failed')
      await h.store.work.confirmSession(r1.run.id, { sessionId: r1.run.requestedSessionId, cwd: h.home })
      await h.store.work.confirmSession(r2.run.id, { sessionId: r2.run.requestedSessionId, cwd: h.home })
      const c1 = await h.store.work.claimPrompt(r1.run.id, 'p1', now)
      const c2 = await h.store.work.claimPrompt(r2.run.id, 'p2', now)
      if (!c1.ok || !c2.ok) throw new Error(`claimPrompt failed: ${JSON.stringify([c1, c2])}`)
      await h.store.work.settleDelivery(r1.run.id, c1.deliveryId, 'accepted', undefined, now)
      await h.store.work.settleDelivery(r2.run.id, c2.deliveryId, 'accepted', undefined, now)
      expect(h.store.work.run(r1.run.id)?.phase).toBe('active')
      expect(h.store.work.run(r2.run.id)?.phase).toBe('active')
      // Register run sessions as active/owned via fakeHost createSession
      await h.host.createSession({ sessionId: r1.run.requestedSessionId })
      await h.host.createSession({ sessionId: r2.run.requestedSessionId })
      await h.store.track({ sessionId: r1.run.requestedSessionId, origin: 'started', title: 'R1', goal: 'G', cwd: h.home, at: now })
      await h.store.track({ sessionId: r2.run.requestedSessionId, origin: 'started', title: 'R2', goal: 'G', cwd: h.home, at: now })

      // User-stopped change + run (must receive ZERO messages)
      const stoppedChange = await h.store.work.createChange({
        title: 'Stopped task', cwd: h.home, goal: 'Stopped',
        requirements: [{ requirementRef: 'R1', text: 'Stopped', required: true }], at: now,
      })
      const rs = await h.store.work.reserveRun({ changeId: stoppedChange.id, kind: 'work', cwd: h.home, writeScope: { kind: 'paths', paths: [] }, at: now })
      if (!rs.ok) throw new Error('reserve stopped failed')
      await h.store.work.prepareCancel(stoppedChange.id, now)
      await h.store.work.finishSettled(rs.run.id, now, 'stopped', { queueCleared: true, agentIdle: true, jobsSettled: true }, now)

      // Completed (non-stopped) change + run (bots/CI must NOT wake; human goes to inbox)
      const doneChange = await h.store.work.createChange({
        title: 'Done task', cwd: h.home, goal: 'Done',
        requirements: [{ requirementRef: 'R1', text: 'Done', required: true }], at: now,
      })
      const rd = await h.store.work.reserveRun({ changeId: doneChange.id, kind: 'work', cwd: h.home, writeScope: { kind: 'paths', paths: [] }, at: now })
      if (!rd.ok) throw new Error('reserve done failed')
      await h.store.work.confirmSession(rd.run.id, { sessionId: rd.run.requestedSessionId, cwd: h.home })
      await h.store.work.prepareFinish(rd.run.id, 'completed', now)
      await h.store.work.finishSettled(rd.run.id, now, 'completed', { queueCleared: true, agentIdle: true, jobsSettled: true }, now)

      await h.store.putLink(makeTaskLink(change.id, { repo: 'acme/widgets', number: 42 }, 'dot', now))
      await h.store.putLink(makeTaskLink(stoppedChange.id, { repo: 'acme/widgets', number: 99 }, 'dot', now))
      await h.store.putLink(makeTaskLink(doneChange.id, { repo: 'acme/widgets', number: 77 }, 'dot', now))

      const settings: DotSettings = patchSettings(DEFAULT_SETTINGS, {
        reflection: false,
        idleCheckMinutes: 0,
        githubPoll: {
          enabled: true,
          repos: ['acme/widgets'],
          webhookRepos: [],
          ghPath: 'gh',
          intervalSec: 120,
          streams: { issues: true, pulls: true, comments: true, ci: true },
          ignoredActors: ['codecov[bot]'],
          admission: [
            { repo: 'acme/widgets', eventType: 'comment', senderClass: 'listed-bot', action: 'context-only' },
          ],
        },
      })
      await h.store.setSettings(settings)

      // Verify Fast-Path admission defaults & override
      expect(classifyGithubSender('alice', 'User', ['codecov[bot]'])).toBe('human')
      expect(classifyGithubSender('codecov[bot]', 'Bot', ['codecov[bot]'])).toBe('listed-bot')
      expect(classifyGithubSender('random-ai[bot]', 'Bot', ['codecov[bot]'])).toBe('unlisted-bot')
      expect(resolveGithubAdmission(settings.githubPoll!, 'acme/widgets', 'comment', 'human')).toBe('inbox')
      expect(resolveGithubAdmission(settings.githubPoll!, 'acme/widgets', 'comment', 'listed-bot')).toBe('context-only')
      expect(resolveGithubAdmission(settings.githubPoll!, 'acme/widgets', 'comment', 'unlisted-bot')).toBe('ignore')
      expect(resolveGithubAdmission(settings.githubPoll!, 'acme/widgets', 'ci', 'listed-bot', { ciRelevant: true })).toBe('inbox')
      expect(resolveGithubAdmission(settings.githubPoll!, 'acme/widgets', 'ci', 'listed-bot', { ciRelevant: false })).toBe('ignore')

      const cursorStore = new GithubPollCursorStore(h.domain.table('github_poll'))
      const closureNotices: string[] = []
      const adapter = new GithubPollSourceAdapter({
        settings: () => settings.githubPoll!,
        cursorStore,
        homeDir: h.home,
        links: () => h.store.links,
        putLink: l => h.store.putLink(l),
        change: id => h.store.work.change(id),
        runsForChange: cid => h.store.work.listRuns().filter(r => r.changeId === cid),
        markClosureReady: (cid, detail) => h.store.work.markClosureReady(cid, detail),
        emitResultNotice: (chg, detail) => {
          closureNotices.push(`${chg.id}:${detail.outcome}`)
          h.service.notify({
            sessionId: dot,
            kind: 'result',
            changeId: chg.id,
            text: `PR ${detail.ref} ${detail.outcome}`,
            at: detail.at,
          })
        },
        inboxList: () => h.inbox.list(),
        submitInbox: ev => h.service.submitInbox(ev),
        supplementWorkRun: (rid, text, sid, exp) => h.service.supplementWorkRun(rid, text, sid, exp),
        dotSessionId: () => h.store.dotSessionId,
        now: () => now,
      })

      // 10 & 12: Long human review comment -> many-to-many supplement to BOTH r1 & r2 + spill file + 1 inbox audit
      const longBody = `Please update handler ${'x'.repeat(650)}`
      const longEv: InboxEventInput = {
        source: 'github',
        sourceId: 'primary-github',
        deliveryId: 'gh-poll:c-long',
        type: 'pull_request_review_comment.created',
        subject: 'acme/widgets#42',
        title: 'Review comment',
        actor: 'alice',
        url: 'https://github.com/acme/widgets/pull/42#discussion_r1',
        summary: longBody,
        receivedAt: now,
        originSource: 'github-poll',
      }
      const resLong = await adapter.receive(longEv, { repo: 'acme/widgets', rawBody: longBody, directContext: 'src/auth.ts:15 · reply to @bob: check null' })
      expect(resLong.directRunIds.sort()).toEqual([r1.run.id, r2.run.id].sort())
      expect(resLong.inboxResult).toBe('stored')
      // Both active runs received direct relay with fenced inline + spill pointer!
      const directRelays = h.relayed.filter(item => item.target === r1.run.requestedSessionId || item.target === r2.run.requestedSessionId)
      expect(directRelays).toHaveLength(2)
      expect(directRelays[0]!.text).toContain('src/auth.ts:15')
      expect(directRelays[0]!.text).toContain('artifacts/inbox/')
      const spill = formatInlineAndSpill({ event: longEv, rawBody: longBody, homeDir: h.home })
      expect(spill.clippedBody.length).toBeLessThanOrEqual(500)
      expect(spill.spillRelPath).toBeTruthy()
      expect(existsSync(join(h.home, spill.spillRelPath!))).toBe(true)
      expect(readFileSync(join(h.home, spill.spillRelPath!), 'utf8')).toContain(longBody)

      // 11: Worker dot_peer bounce-back to Dorothy (idempotent)
      const bounce1 = await h.service.peerSend({
        action: 'bounce',
        senderSessionId: r1.run.requestedSessionId,
        targetSessionId: 'dorothy',
        deliveryId: 'bounce-1',
        text: 'This comment asks for a billing refactor outside auth scope.',
      })
      expect(bounce1).toContain('bounced to Dorothy')
      const bounceRepeat = await h.service.peerSend({
        action: 'bounce',
        senderSessionId: r1.run.requestedSessionId,
        targetSessionId: 'dorothy',
        deliveryId: 'bounce-1',
        text: 'This comment asks for a billing refactor outside auth scope.',
      })
      expect(bounceRepeat).toContain('already bounced')
      expect(h.inbox.list().some(row => row.type === 'peer.bounce' && row.subject === `task:${change.id}`)).toBe(true)

      // Context-only listed-bot on #42: supplements active runs directly, NO inbox row!
      const inboxCountBeforeBot = h.inbox.list().length
      const resBot = await adapter.receive({
        source: 'github', sourceId: 'primary-github', deliveryId: 'gh-poll:bot-1',
        type: 'issue_comment.created', subject: 'acme/widgets#42', title: 'Codecov',
        actor: 'codecov[bot]', summary: 'coverage 91%', receivedAt: now, originSource: 'github-poll',
      }, { repo: 'acme/widgets', rawBody: 'coverage 91%', senderType: 'Bot' })
      expect(resBot.action).toBe('context-only')
      expect(resBot.directRunIds).toHaveLength(2)
      expect(h.inbox.list()).toHaveLength(inboxCountBeforeBot)

      // Unlisted bot -> ignored
      const resUnlisted = await adapter.receive({
        source: 'github', sourceId: 'primary-github', deliveryId: 'gh-poll:bot-unlisted',
        type: 'issue_comment.created', subject: 'acme/widgets#42', title: 'Unknown Bot',
        actor: 'spammy[bot]', summary: 'hi', receivedAt: now, originSource: 'github-poll',
      }, { repo: 'acme/widgets', rawBody: 'hi', senderType: 'Bot' })
      expect(resUnlisted.action).toBe('ignore')

      await h.store.putLink(makeTaskLink(doneChange.id, { repo: 'acme/widgets', branch: 'feat-done' }, 'auto', now))
      // 14: Bot/CI on finished (completed) run #77 -> never wakes finished run
      const relaysBeforeDone = h.relayed.length
      await adapter.receive({
        source: 'github', sourceId: 'primary-github', deliveryId: 'gh-poll:ci-done',
        type: 'check_suite.completed', subject: 'acme/widgets:checks:ci@feat-done', title: 'CI',
        actor: 'github-actions[bot]', summary: 'failed', receivedAt: now, originSource: 'github-poll',
      }, { repo: 'acme/widgets', rawBody: 'failed', senderType: 'Bot', ciRelevant: true })
      expect(h.relayed.filter(r => r.target === rd.run.requestedSessionId)).toHaveLength(0)
      expect(h.relayed.length).toBe(relaysBeforeDone)

      // Human comment on finished (non-stopped) run #77 -> goes to inbox (Dorothy decides)
      const resHumanDone = await adapter.receive({
        source: 'github', sourceId: 'primary-github', deliveryId: 'gh-poll:human-done',
        type: 'issue_comment.created', subject: 'acme/widgets#77', title: 'Followup',
        actor: 'alice', summary: 'One more tweak?', receivedAt: now, originSource: 'github-poll',
      }, { repo: 'acme/widgets', rawBody: 'One more tweak?' })
      expect(resHumanDone.directRunIds).toEqual([])
      expect(resHumanDone.inboxResult).toBe('stored')

      // 15: User-stopped run #99 receives ZERO messages
      const inboxCountBeforeStopped = h.inbox.list().length
      const resStopped = await adapter.receive({
        source: 'github', sourceId: 'primary-github', deliveryId: 'gh-poll:stopped-1',
        type: 'issue_comment.created', subject: 'acme/widgets#99', title: 'Ping stopped',
        actor: 'alice', summary: 'Are you still there?', receivedAt: now, originSource: 'github-poll',
      }, { repo: 'acme/widgets', rawBody: 'Are you still there?' })
      expect(resStopped.directRunIds).toEqual([])
      expect(resStopped.skippedStoppedRunIds).toEqual([rs.run.id])
      expect(h.relayed.filter(r => r.target === rs.run.requestedSessionId)).toHaveLength(0)
      expect(h.inbox.list()).toHaveLength(inboxCountBeforeStopped)

      // 16: PR opened never triggers closure; PR merged updates links.ts, flags Change closureReady, emits 1 result notice!
      await adapter.receive({
        source: 'github', sourceId: 'primary-github', deliveryId: 'gh-poll:pr-open',
        type: 'pull_request.opened', subject: 'acme/widgets#42', title: 'Fix auth',
        actor: 'alice', summary: 'opened', receivedAt: now, originSource: 'github-poll',
      }, { repo: 'acme/widgets', rawBody: 'opened' })
      expect(closureNotices).toEqual([])
      expect(h.store.work.change(change.id)?.closureReady).toBeUndefined()

      const resMerged = await adapter.receive({
        source: 'github', sourceId: 'primary-github', deliveryId: 'gh-poll:pr-merged',
        type: 'pull_request.merged', subject: 'acme/widgets#42', title: 'Fix auth',
        actor: 'alice', url: 'https://github.com/acme/widgets/pull/42', summary: 'merged', receivedAt: now + 1000, originSource: 'github-poll',
      }, { repo: 'acme/widgets', rawBody: 'merged' })
      expect(resMerged.closureNotifiedChanges).toEqual([change.id])
      expect(closureNotices).toEqual([`${change.id}:merged`])
      expect(h.store.links.find(l => l.changeId === change.id && l.number === 42)?.state).toBe('merged')
      expect(h.store.work.change(change.id)?.closureReady).toMatchObject({ ref: 'acme/widgets#42', outcome: 'merged' })
      // Change is NOT auto-accepted (verification cannot be bypassed)
      expect(h.store.work.change(change.id)?.closeout).toBeUndefined()

      await h.service.flushNotices()
      expect(h.relayed.some(r => r.target === dot && r.text.includes('result ·'))).toBe(true)
    } finally {
      await h.service.dispose()
      h.cleanup()
    }
  })

  it('handles 410 Gone quietly without failing poll round, and handles review state casing & old issue edits', async () => {
    let now = 1_700_000_000_000
    const h = makeHarness(async (_bin, args) => {
      if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
      if (args[0] === 'auth') return { stdout: authSuccessStdout(), stderr: '' }
      if (args[1] === 'rate_limit') return { stdout: JSON.stringify({ resources: { core: { remaining: 5000, limit: 5000 } } }), stderr: '' }
      if (args[1]?.startsWith('repos/acme/widgets/issues?')) {
        return {
          stdout: httpInclude({}, [
            // Old issue edited later: must NOT re-trigger issue.opened!
            { id: 1, number: 1, title: 'Old issue edited', state: 'open', created_at: new Date(now - 3600_000).toISOString(), updated_at: new Date(now).toISOString(), html_url: 'https://github.com/acme/widgets/issues/1', user: { login: 'alice' }, body: '@dot' },
            // Deleted PR -> 410 Gone
            { id: 2, number: 88, title: 'Deleted PR', state: 'open', created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), html_url: 'https://github.com/acme/widgets/pull/88', pull_request: { url: 'x' }, user: { login: 'alice' } },
          ]),
          stderr: '',
        }
      }
      if (args[1] === 'repos/acme/widgets/pulls/88') {
        throw Object.assign(new Error('gh: Gone (HTTP 410)'), { code: 1, stderr: 'gh: Gone (HTTP 410)' })
      }
      if (args[1] === 'repos/acme/widgets/pulls/12/reviews?per_page=100') {
        return {
          stdout: httpInclude({}, [
            { id: 901, state: 'COMMENTED', body: '', user: { login: 'bob' }, submitted_at: new Date(now).toISOString() },
            { id: 902, state: 'APPROVED', body: '', user: { login: 'bob' }, commit_id: 'abcdef1234', html_url: 'https://github.com/acme/widgets/pull/12#pullrequestreview-902', submitted_at: new Date(now).toISOString() },
          ]),
          stderr: '',
        }
      }
      if (args[1] === 'repos/acme/widgets/pulls/12') {
        return { stdout: JSON.stringify({ number: 12, state: 'open', html_url: 'https://github.com/acme/widgets/pull/12', user: { login: 'alice' }, head: { sha: 'abc', ref: 'feat' } }), stderr: '' }
      }
      return { stdout: httpInclude({}, []), stderr: '' }
    }, () => now)

    try {
      const change = await h.store.work.createChange({
        title: 'Active PR', cwd: h.home, goal: 'PR 12', requirements: [{ requirementRef: 'R1', text: 'PR 12', required: true }], at: now,
      })
      await h.store.putLink(makeTaskLink(change.id, { repo: 'acme/widgets', number: 12 }, 'dot', now))
      await h.store.setSettings(patchSettings(DEFAULT_SETTINGS, {
        reflection: false,
        idleCheckMinutes: 0,
        githubPoll: { enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: true, pulls: true, comments: true, ci: false }, ignoredActors: [] },
      }))
      await h.service.pollGithubNow() // cold-start
      now += 10_000
      const res = await h.service.pollGithubNow()
      expect(res.ok).toBe(true) // 410 Gone did NOT fail round!
      expect(h.service.githubPollStatus().repos[0]?.degraded410Count).toBe(1)
      // Old edited issue #1 skipped; bodyless COMMENTED 901 skipped; bodyless APPROVED 902 kept & lowercased!
      const reviews = h.inbox.list()
      expect(reviews).toHaveLength(1)
      expect(reviews[0]!.type).toBe('pull_request_review.approved')
    } finally {
      await h.service.dispose()
      h.cleanup()
    }
  })

  it('normalizes webhook deliveries with originSource inbox-github cleanly', () => {
    const ev = normalizeGithub({
      kind: 'github',
      source: 'primary-github',
      deliveryId: 'd-wh',
      receivedAt: 1000,
      event: {
        name: 'issues',
        payload: {
          action: 'opened',
          repository: { full_name: 'acme/widgets' },
          sender: { login: 'alice' },
          issue: { number: 1, title: 'Hi', html_url: 'https://github.com/acme/widgets/issues/1', body: 'test' },
        },
      },
    })
    expect(ev?.originSource).toBe('inbox-github')
    expect(branchCiTriggerId('acme/widgets', 'main', 1)).toMatch(/^gh-poll:/)
  })

  it('remediation regressions: path traversal, GHES host isolation/URLs, context-only & review dedup, old closed PR guard, spill tag budget, dispose abort, same-second cold-start, and 304 stream toggle', async () => {
    // 1. repoPath blocks backslashes & percent-encoded traversal
    expect(() => repoPath('acme/widgets', 'issues\\..\\..\\users')).toThrow(/restricted/)
    expect(() => repoPath('acme/widgets', 'issues/%2e%2e/users')).toThrow(/restricted/)
    expect(() => repoPath('acme/widgets', 'issues/%2E%2E/users')).toThrow(/restricted/)

    // 2. githubAddress supports GHES web & /api/v3/repos URLs and honors configured hostname
    expect(githubAddress('https://ghes.example.com/acme/widgets/issues/5#issuecomment-1', 'acme/widgets', 'ghes.example.com')).toEqual({ number: 5, pr: false })
    expect(githubAddress('https://ghes.example.com/api/v3/repos/acme/widgets/pulls/12#discussion_r9', 'acme/widgets', 'ghes.example.com')).toEqual({ number: 12, pr: true, discussion: 9 })
    expect(githubAddress('https://other.example.com/acme/widgets/issues/5', 'acme/widgets', 'ghes.example.com')).toBeUndefined()

    // 3. testGhAvailability with explicit GHES hostname never falls back to github.com
    const ghesMiss = await testGhAvailability({
      hostname: 'ghes.example.com',
      exec: async (_bin, args) => {
        if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
        return { stdout: JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, login: 'wrong-user' }] } }), stderr: '' }
      },
    })
    expect(ghesMiss.authenticated).toBe(false)
    expect(ghesMiss.login).toBeUndefined()
    expect(ghesMiss.host).toBe('ghes.example.com')

    // 4. dispose() mid-poll during testGhAvailability exits cleanly with zero consecutiveFailures/lastError
    let releaseVersion!: () => void
    const versionGate = new Promise<void>(resolve => { releaseVersion = resolve })
    const hAbort = makeHarness(async (_bin, args, opts) => {
      if (args[0] === '--version') {
        await new Promise<void>(resolve => {
          if (opts.signal?.aborted) { resolve(); return }
          opts.signal?.addEventListener('abort', () => resolve(), { once: true })
          releaseVersion()
        })
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      }
      return { stdout: '{}', stderr: '' }
    })
    try {
      await hAbort.store.setSettings(patchSettings(DEFAULT_SETTINGS, {
        reflection: false,
        idleCheckMinutes: 0,
        githubPoll: { enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: true, pulls: false, comments: false, ci: false }, ignoredActors: [] },
      }))
      const pollPromise = hAbort.service.pollGithubNow()
      await versionGate
      await hAbort.service.dispose()
      const abortedRes = await pollPromise
      expect(abortedRes).toEqual({ ok: true, events: 0 })
      expect(hAbort.service.githubPollStatus().consecutiveFailures).toBe(0)
      expect(hAbort.service.githubPollStatus().lastError).toBeUndefined()
      expect(hAbort.service.githubPollCursorStore.getRepoState('acme/widgets')?.consecutiveFailures ?? 0).toBe(0)
    } finally {
      hAbort.cleanup()
    }

    // 5. >500-char payload preserves both [direct-delivered to ...] and [read: ...] tags inside 500-char cap
    const nowTag = 1_700_000_000_000
    const hTag = makeHarness(async () => ({ stdout: '[]', stderr: '' }), () => nowTag)
    try {
      await hTag.service.ensureDot()
      const change = await hTag.store.work.createChange({
        title: 'Tag cap', cwd: hTag.home, goal: 'Tag cap',
        requirements: [{ requirementRef: 'R1', text: 'Tag cap', required: true }], at: nowTag,
      })
      const runRes = await hTag.store.work.reserveRun({ changeId: change.id, kind: 'work', cwd: hTag.home, writeScope: { kind: 'paths', paths: [] }, at: nowTag })
      if (!runRes.ok) throw new Error('reserve failed')
      await hTag.store.work.confirmSession(runRes.run.id, { sessionId: runRes.run.requestedSessionId, cwd: hTag.home })
      const claim = await hTag.store.work.claimPrompt(runRes.run.id, 'p1', nowTag)
      if (!claim.ok) throw new Error('claim failed')
      await hTag.store.work.settleDelivery(runRes.run.id, claim.deliveryId, 'accepted', undefined, nowTag)
      await hTag.host.createSession({ sessionId: runRes.run.requestedSessionId })
      await hTag.store.track({ sessionId: runRes.run.requestedSessionId, origin: 'started', title: 'R1', goal: 'G', cwd: hTag.home, at: nowTag })
      await hTag.store.putLink(makeTaskLink(change.id, { repo: 'acme/widgets', number: 10 }, 'dot', nowTag))

      const adapter = new GithubPollSourceAdapter({
        settings: () => ({ enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: true, pulls: true, comments: true, ci: true }, ignoredActors: ['dependabot[bot]'], admission: [] }),
        cursorStore: hTag.service.githubPollCursorStore,
        homeDir: hTag.home,
        links: () => hTag.store.links,
        putLink: l => hTag.store.putLink(l),
        change: id => hTag.store.work.change(id),
        runsForChange: cid => hTag.store.work.listRuns().filter(r => r.changeId === cid),
        markClosureReady: (cid, d) => hTag.store.work.markClosureReady(cid, d),
        emitResultNotice: () => {},
        inboxList: () => hTag.inbox.list(),
        submitInbox: ev => hTag.service.submitInbox(ev),
        supplementWorkRun: (rid, text, sid, exp) => hTag.service.supplementWorkRun(rid, text, sid, exp),
        dotSessionId: () => hTag.store.dotSessionId,
        now: () => nowTag,
      })
      const longBody = `Line1 ghp_secret99999999 ${'A'.repeat(650)}`
      const longRes = await adapter.receive({
        source: 'github',
        sourceId: 'primary-github',
        deliveryId: 'gh-poll:c-tag-cap',
        type: 'pull_request_review_comment.created',
        subject: 'acme/widgets#10',
        title: 'Long comment',
        actor: 'alice',
        url: 'https://github.com/acme/widgets/pull/10#discussion_r1',
        summary: longBody,
        receivedAt: nowTag,
        originSource: 'github-poll',
      }, { repo: 'acme/widgets', rawBody: longBody })
      expect(longRes.directRunIds).toEqual([runRes.run.id])
      const storedSummary = hTag.inbox.list()[0]!.summary
      expect(storedSummary.length).toBeLessThanOrEqual(500)
      expect(storedSummary).toContain(`[direct-delivered to ${runRes.run.id}]`)
      expect(storedSummary).toContain('[read: artifacts/inbox/gh-poll_c-tag-cap.md]')
      expect(storedSummary).not.toContain('ghp_secret99999999')
    } finally {
      await hTag.service.dispose()
      hTag.cleanup()
    }

    // 6. context-only overlap dedup, pollLinkedPrReviews cold-start/cursor, old closed PR guard, same-second cold-start, and 304 stream toggle
    let nowPoll = Date.parse('2026-11-26T10:00:00.800Z')
    let phase = 1
    let send304Issues = false
    let send304Reviews = false
    const hPoll = makeHarness(async (_bin, args) => {
      if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
      if (args[0] === 'auth') return { stdout: authSuccessStdout(), stderr: '' }
      if (args[1] === 'rate_limit') return { stdout: JSON.stringify({ resources: { core: { remaining: 5000, limit: 5000 } } }), stderr: '' }
      if (args[1]?.startsWith('repos/acme/widgets/issues/comments?')) {
        if (phase === 1) {
          return { stdout: httpInclude({}, [{ id: 100, body: 'pre-existing', user: { login: 'alice' }, html_url: 'https://github.com/acme/widgets/issues/1#issuecomment-100', created_at: '2026-11-26T10:00:00Z', updated_at: '2026-11-26T10:00:00Z' }]), stderr: '' }
        }
        return {
          stdout: httpInclude({}, [
            { id: 100, body: 'pre-existing', user: { login: 'alice' }, html_url: 'https://github.com/acme/widgets/issues/1#issuecomment-100', created_at: '2026-11-26T10:00:00Z', updated_at: '2026-11-26T10:00:00Z' },
            { id: 101, body: 'bot context update', user: { login: 'dependabot[bot]', type: 'Bot' }, html_url: 'https://github.com/acme/widgets/pull/10#issuecomment-101', created_at: '2026-11-26T10:01:00Z', updated_at: '2026-11-26T10:01:00Z' },
          ]),
          stderr: '',
        }
      }
      if (args[1]?.startsWith('repos/acme/widgets/issues?')) {
        if (send304Issues) throw Object.assign(new Error('gh: HTTP 304'), { code: 1, stderr: 'gh: HTTP 304\n' })
        if (phase === 1) {
          return {
            stdout: httpInclude({ Etag: 'W/"iss-1"' }, [
              { id: 1, number: 1, title: 'Pre-existing same-second', state: 'open', created_at: '2026-11-26T10:00:00Z', updated_at: '2026-11-26T10:00:00Z', html_url: 'https://github.com/acme/widgets/issues/1', user: { login: 'alice' }, body: 'old' },
            ]),
            stderr: '',
          }
        }
        const items: unknown[] = [
          { id: 1, number: 1, title: 'Pre-existing same-second', state: 'open', created_at: '2026-11-26T10:00:00Z', updated_at: '2026-11-26T10:00:00Z', html_url: 'https://github.com/acme/widgets/issues/1', user: { login: 'alice' }, body: 'old' },
          // New issue created 100ms after cold-start in the same UTC second!
          { id: 2, number: 2, title: 'Same-second new issue', state: 'open', created_at: '2026-11-26T10:00:00Z', updated_at: '2026-11-26T10:00:00Z', html_url: 'https://github.com/acme/widgets/issues/2', user: { login: 'alice' }, body: 'fresh' },
          // Old already-closed PR whose updated_at bumped due to a comment
          { id: 5, number: 5, title: 'Old merged PR', state: 'closed', created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-26T10:01:00Z', closed_at: '2026-11-23T00:00:00Z', html_url: 'https://github.com/acme/widgets/pull/5', pull_request: { url: 'x' }, user: { login: 'alice' } },
        ]
        if (phase >= 4) {
          items.push({ id: 11, number: 11, title: 'New PR after toggle', state: 'open', created_at: '2026-11-26T10:05:00Z', updated_at: '2026-11-26T10:05:00Z', html_url: 'https://github.com/acme/widgets/pull/11', pull_request: { url: 'x' }, user: { login: 'alice' } })
        }
        return { stdout: httpInclude({ Etag: 'W/"iss-2"' }, items), stderr: '' }
      }
      if (args[1] === 'repos/acme/widgets/pulls/5') {
        return { stdout: JSON.stringify({ number: 5, state: 'closed', merged: true, created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-26T10:01:00Z', closed_at: '2026-11-23T00:00:00Z', merged_at: '2026-11-23T00:00:00Z', html_url: 'https://github.com/acme/widgets/pull/5', user: { login: 'alice' }, head: { sha: 'abc', ref: 'old' } }), stderr: '' }
      }
      if (args[1] === 'repos/acme/widgets/pulls/11') {
        return { stdout: JSON.stringify({ number: 11, title: 'New PR after toggle', state: 'open', created_at: '2026-11-26T10:05:00Z', updated_at: '2026-11-26T10:05:00Z', html_url: 'https://github.com/acme/widgets/pull/11', user: { login: 'alice' }, head: { sha: 'def', ref: 'feat-11' } }), stderr: '' }
      }
      if (args[1] === 'repos/acme/widgets/pulls/10/reviews?per_page=100') {
        if (send304Reviews) throw Object.assign(new Error('gh: HTTP 304'), { code: 1, stderr: 'gh: HTTP 304\n' })
        return {
          stdout: httpInclude({ Etag: 'W/"rev-1"' }, [
            { id: 700, state: 'CHANGES_REQUESTED', body: 'historical review', user: { login: 'dependabot[bot]', type: 'Bot' }, html_url: 'https://github.com/acme/widgets/pull/10#pullrequestreview-700', submitted_at: '2026-11-25T10:00:00Z' },
          ]),
          stderr: '',
        }
      }
      return { stdout: httpInclude({}, []), stderr: '' }
    }, () => nowPoll)

    try {
      await hPoll.service.ensureDot()
      const ch = await hPoll.store.work.createChange({
        title: 'Active PR 10', cwd: hPoll.home, goal: 'PR 10',
        requirements: [{ requirementRef: 'R1', text: 'PR 10', required: true }], at: nowPoll,
      })
      const run = await hPoll.store.work.reserveRun({ changeId: ch.id, kind: 'work', cwd: hPoll.home, writeScope: { kind: 'paths', paths: [] }, at: nowPoll })
      if (!run.ok) throw new Error('reserve failed')
      await hPoll.store.work.confirmSession(run.run.id, { sessionId: run.run.requestedSessionId, cwd: hPoll.home })
      const claim = await hPoll.store.work.claimPrompt(run.run.id, 'p1', nowPoll)
      if (!claim.ok) throw new Error('claim failed')
      await hPoll.store.work.settleDelivery(run.run.id, claim.deliveryId, 'accepted', undefined, nowPoll)
      await hPoll.host.createSession({ sessionId: run.run.requestedSessionId })
      await hPoll.store.track({ sessionId: run.run.requestedSessionId, origin: 'started', title: 'R1', goal: 'G', cwd: hPoll.home, at: nowPoll })
      await hPoll.store.putLink(makeTaskLink(ch.id, { repo: 'acme/widgets', number: 10 }, 'dot', nowPoll))

      // Start with issues + comments enabled, pulls disabled
      await hPoll.store.setSettings(patchSettings(DEFAULT_SETTINGS, {
        reflection: false,
        idleCheckMinutes: 0,
        githubPoll: { enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: true, pulls: false, comments: true, ci: false }, ignoredActors: [] },
      }))

      // Poll 1: cold-start at .800Z -> 0 events, historical review #700 and pre-existing issue #1/comment #100 suppressed!
      const c1 = await hPoll.service.pollGithubNow()
      expect(c1).toEqual({ ok: true, events: 0 })
      expect(hPoll.inbox.list()).toHaveLength(0)
      expect(hPoll.relayed.filter(r => r.target === run.run.requestedSessionId)).toHaveLength(0)

      // Poll 2 (100ms + 1 poll later): same-second new issue #2 IS ingested; pre-existing #1 & #100 skipped; dependabot comment #101 delivered ONCE!
      phase = 2
      nowPoll += 60_000
      const c2 = await hPoll.service.pollGithubNow()
      expect(c2.ok).toBe(true)
      expect(hPoll.inbox.list().map(i => i.subject)).toEqual(['acme/widgets#2'])
      expect(hPoll.relayed.filter(r => r.target === run.run.requestedSessionId && r.text.includes('bot context update'))).toHaveLength(1)

      // Poll 3: 5s overlap window re-fetches #101 -> MUST NOT re-deliver context-only comment #101!
      phase = 3
      nowPoll += 120_000
      await hPoll.service.pollGithubNow()
      expect(hPoll.relayed.filter(r => r.target === run.run.requestedSessionId && r.text.includes('bot context update'))).toHaveLength(1)
      expect(hPoll.relayed.filter(r => r.target === run.run.requestedSessionId && r.text.includes('historical review'))).toHaveLength(0)

      // Toggle pulls ON while /issues returns 304 -> startedPulls is persisted on 304, old closed PR #5 ignored, new PR #11 ingested on next 200 OK!
      await hPoll.store.setSettings(patchSettings(hPoll.store.settings, {
        githubPoll: { enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: true, pulls: true, comments: true, ci: false }, ignoredActors: [] },
      }))
      send304Issues = true
      send304Reviews = true
      nowPoll += 60_000
      await hPoll.service.pollGithubNow()
      expect(hPoll.service.githubPollCursorStore.getStreamCursor('acme/widgets', 'issues')?.startedPulls).toBeDefined()

      // Subsequent unchanged 304 does ZERO writes
      hPoll.puts.length = 0
      nowPoll += 60_000
      await hPoll.service.pollGithubNow()
      expect(hPoll.puts).toEqual([])

      // Next 200 OK: PR #5 (closed 3 days ago, updated now) does NOT emit pull_request.merged; new PR #11 IS ingested!
      send304Issues = false
      phase = 4
      nowPoll += 60_000
      await hPoll.service.pollGithubNow()
      const subjects = hPoll.inbox.list().map(i => i.subject)
      expect(subjects).not.toContain('acme/widgets#5')
      expect(subjects).toContain('acme/widgets#11')
    } finally {
      await hPoll.service.dispose()
      hPoll.cleanup()
    }
  })

  it('skips PR endpoints for linked issues (URL and shorthand fallback), preserves events, and isolates genuine PR 404 failures', async () => {
    // 1. Linked Issue via explicit /issues/1 URL: NEVER hits pulls/1*, keeps health ok, zero-write 304, delivers comments to active run
    let nowUrl = 1_700_000_000_000
    let urlPhase = 1
    let send304Url = false
    const urlCalls: string[] = []
    const hUrl = makeHarness(async (_bin, args) => {
      if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
      if (args[0] === 'auth') return { stdout: authSuccessStdout(), stderr: '' }
      if (args[1]) urlCalls.push(args[1])
      if (args[1] === 'rate_limit') return { stdout: JSON.stringify({ resources: { core: { remaining: 5000, limit: 5000 } } }), stderr: '' }
      if (args[1] === 'repos/acme/widgets') return { stdout: JSON.stringify({ default_branch: 'main', html_url: 'https://github.com/acme/widgets' }), stderr: '' }
      if (args[1] === 'repos/acme/widgets/commits/main') return { stdout: JSON.stringify({ sha: 'main-sha' }), stderr: '' }
      if (args[1]?.startsWith('repos/acme/widgets/commits/main-sha/check-runs')) return { stdout: JSON.stringify({ total_count: 0, check_runs: [] }), stderr: '' }
      if (args[1]?.startsWith('repos/acme/widgets/commits/main-sha/statuses')) return { stdout: JSON.stringify([]), stderr: '' }
      if (args[1]?.startsWith('repos/acme/widgets/issues/comments?')) {
        if (send304Url) throw Object.assign(new Error('gh: HTTP 304'), { code: 1, stderr: 'gh: HTTP 304\n' })
        if (urlPhase === 1) return { stdout: httpInclude({ Etag: 'W/"ic-1"' }, []), stderr: '' }
        return {
          stdout: httpInclude({ Etag: 'W/"ic-2"' }, [
            { id: 1001, body: 'Human reply on issue #1', user: { login: 'bob', type: 'User' }, html_url: 'https://github.com/acme/widgets/issues/1#issuecomment-1001', created_at: new Date(nowUrl).toISOString(), updated_at: new Date(nowUrl).toISOString() },
          ]),
          stderr: '',
        }
      }
      if (args[1]?.startsWith('repos/acme/widgets/pulls/1')) {
        throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { code: 1, stderr: 'gh: Not Found (HTTP 404)' })
      }
      if (send304Url) throw Object.assign(new Error('gh: HTTP 304'), { code: 1, stderr: 'gh: HTTP 304\n' })
      return { stdout: httpInclude({ Etag: 'W/"empty"' }, []), stderr: '' }
    }, () => nowUrl)

    try {
      await hUrl.service.ensureDot()
      const ch = await hUrl.store.work.createChange({
        title: 'Issue 1 work', cwd: hUrl.home, goal: 'Fix issue 1',
        requirements: [{ requirementRef: 'R1', text: 'Fix issue 1', required: true }], at: nowUrl,
      })
      const run = await hUrl.store.work.reserveRun({ changeId: ch.id, kind: 'work', cwd: hUrl.home, writeScope: { kind: 'paths', paths: [] }, at: nowUrl })
      if (!run.ok) throw new Error('reserve failed')
      await hUrl.store.work.confirmSession(run.run.id, { sessionId: run.run.requestedSessionId, cwd: hUrl.home })
      const claim = await hUrl.store.work.claimPrompt(run.run.id, 'p1', nowUrl)
      if (!claim.ok) throw new Error('claim failed')
      await hUrl.store.work.settleDelivery(run.run.id, claim.deliveryId, 'accepted', undefined, nowUrl)
      await hUrl.host.createSession({ sessionId: run.run.requestedSessionId })
      await hUrl.store.track({ sessionId: run.run.requestedSessionId, origin: 'started', title: 'R1', goal: 'G', cwd: hUrl.home, at: nowUrl })
      await hUrl.store.putLink(makeTaskLink(ch.id, { repo: 'acme/widgets', number: 1, url: 'https://github.com/acme/widgets/issues/1' }, 'dot', nowUrl))

      await hUrl.store.setSettings(patchSettings(DEFAULT_SETTINGS, {
        reflection: false,
        idleCheckMinutes: 0,
        githubPoll: { enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: true, pulls: true, comments: true, ci: true }, ignoredActors: [] },
      }))

      await expect(hUrl.service.pollGithubNow()).resolves.toEqual({ ok: true, events: 0 })
      urlPhase = 2
      nowUrl += 10_000
      const p2 = await hUrl.service.pollGithubNow()
      expect(p2).toEqual({ ok: true, events: 1 })
      expect(hUrl.service.githubPollStatus().health).toBe('ok')
      expect(hUrl.service.githubPollStatus().consecutiveFailures).toBe(0)
      expect(hUrl.inbox.list().map(r => r.subject)).toEqual(['acme/widgets#1'])
      expect(hUrl.relayed.some(r => r.target === run.run.requestedSessionId && r.text.includes('Human reply on issue #1'))).toBe(true)
      expect(urlCalls.some(c => c.includes('pulls/1'))).toBe(false)

      // Repeat 304 poll does zero writes and never hits pulls/1
      send304Url = true
      hUrl.puts.length = 0
      urlCalls.length = 0
      nowUrl += 10_000
      await expect(hUrl.service.pollGithubNow()).resolves.toEqual({ ok: true, events: 0 })
      expect(hUrl.puts).toEqual([])
      expect(urlCalls.some(c => c.includes('pulls/1'))).toBe(false)
    } finally {
      await hUrl.service.dispose()
      hUrl.cleanup()
    }

    // 2. Shorthand owner/repo#1 (no URL yet) + linked PR #5: probes issues/1 on 404, caches issue classification,
    //    delivers issue comment & PR review/CI normally, and skips pulls/1* + issues/1 with zero writes on subsequent 304s.
    let nowShort = 1_700_000_000_000
    let shortPhase = 1
    let send304Short = false
    const shortCalls: string[] = []
    const hShort = makeHarness(async (_bin, args) => {
      if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
      if (args[0] === 'auth') return { stdout: authSuccessStdout(), stderr: '' }
      if (args[1]) shortCalls.push(args[1])
      if (args[1] === 'rate_limit') return { stdout: JSON.stringify({ resources: { core: { remaining: 5000, limit: 5000 } } }), stderr: '' }
      if (args[1] === 'repos/acme/widgets') return { stdout: JSON.stringify({ default_branch: 'main', html_url: 'https://github.com/acme/widgets' }), stderr: '' }
      if (args[1] === 'repos/acme/widgets/commits/main') return { stdout: JSON.stringify({ sha: 'main-sha' }), stderr: '' }
      if (args[1]?.startsWith('repos/acme/widgets/commits/main-sha/check-runs')) return { stdout: JSON.stringify({ total_count: 0, check_runs: [] }), stderr: '' }
      if (args[1]?.startsWith('repos/acme/widgets/commits/main-sha/statuses')) return { stdout: JSON.stringify([]), stderr: '' }
      if (args[1] === 'repos/acme/widgets/pulls/1/reviews?per_page=100' || args[1] === 'repos/acme/widgets/pulls/1') {
        throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { code: 1, stderr: 'gh: Not Found (HTTP 404)' })
      }
      if (args[1] === 'repos/acme/widgets/issues/1') {
        return {
          stdout: JSON.stringify({ id: 1, number: 1, title: 'Shorthand issue', state: 'open', html_url: 'https://github.com/acme/widgets/issues/1', user: { login: 'alice' } }),
          stderr: '',
        }
      }
      if (args[1] === 'repos/acme/widgets/pulls/5') {
        return {
          stdout: JSON.stringify({ number: 5, state: 'open', html_url: 'https://github.com/acme/widgets/pull/5', user: { login: 'alice' }, head: { sha: 'pr5-sha', ref: 'feat/5' } }),
          stderr: '',
        }
      }
      if (args[1]?.startsWith('repos/acme/widgets/commits/pr5-sha/check-runs')) {
        return {
          stdout: JSON.stringify({
            total_count: 1,
            check_runs: shortPhase >= 3 ? [{ id: 1, name: 'pr-ci', status: 'completed', conclusion: 'failure' }] : [],
          }),
          stderr: '',
        }
      }
      if (args[1]?.startsWith('repos/acme/widgets/commits/pr5-sha/statuses')) return { stdout: JSON.stringify([]), stderr: '' }
      if (args[1] === 'repos/acme/widgets/pulls/5/reviews?per_page=100') {
        if (send304Short) throw Object.assign(new Error('gh: HTTP 304'), { code: 1, stderr: 'gh: HTTP 304\n' })
        return {
          stdout: httpInclude({ Etag: 'W/"rev-5"' }, shortPhase >= 2
            ? [{ id: 801, state: 'APPROVED', body: 'ship it', user: { login: 'carol', type: 'User' }, html_url: 'https://github.com/acme/widgets/pull/5#pullrequestreview-801', submitted_at: new Date(nowShort).toISOString() }]
            : []),
          stderr: '',
        }
      }
      if (args[1]?.startsWith('repos/acme/widgets/issues/comments?')) {
        if (send304Short) throw Object.assign(new Error('gh: HTTP 304'), { code: 1, stderr: 'gh: HTTP 304\n' })
        return {
          stdout: httpInclude({ Etag: `W/"ic-${shortPhase}"` }, shortPhase >= 2
            ? [
                { id: 2001, body: 'bot note', user: { login: 'dependabot[bot]', type: 'Bot' }, html_url: 'https://github.com/acme/widgets/issues/1#issuecomment-2001', created_at: new Date(nowShort).toISOString(), updated_at: new Date(nowShort).toISOString() },
                { id: 2002, body: 'human note on #1', user: { login: 'alice', type: 'User' }, html_url: 'https://github.com/acme/widgets/issues/1#issuecomment-2002', created_at: new Date(nowShort).toISOString(), updated_at: new Date(nowShort).toISOString() },
              ]
            : []),
          stderr: '',
        }
      }
      if (send304Short) throw Object.assign(new Error('gh: HTTP 304'), { code: 1, stderr: 'gh: HTTP 304\n' })
      return { stdout: httpInclude({ Etag: 'W/"empty"' }, []), stderr: '' }
    }, () => nowShort)

    try {
      await hShort.service.ensureDot()
      const chIssue = await hShort.store.work.createChange({
        title: 'Shorthand Issue 1', cwd: hShort.home, goal: 'Issue 1',
        requirements: [{ requirementRef: 'R1', text: 'Issue 1', required: true }], at: nowShort,
      })
      const chPr = await hShort.store.work.createChange({
        title: 'PR 5', cwd: hShort.home, goal: 'PR 5',
        requirements: [{ requirementRef: 'R1', text: 'PR 5', required: true }], at: nowShort,
      })
      await hShort.store.putLink(makeTaskLink(chIssue.id, { repo: 'acme/widgets', number: 1 }, 'dot', nowShort))
      await hShort.store.putLink(makeTaskLink(chPr.id, { repo: 'acme/widgets', number: 5, url: 'https://github.com/acme/widgets/pull/5' }, 'dot', nowShort))

      await hShort.store.setSettings(patchSettings(DEFAULT_SETTINGS, {
        reflection: false,
        idleCheckMinutes: 0,
        githubPoll: { enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: true, pulls: true, comments: true, ci: true }, ignoredActors: [] },
      }))

      // Poll 1 (cold-start): pulls/1/reviews 404 -> probes issues/1 once -> caches known issue -> pollLinkedPrCi skips pulls/1!
      await expect(hShort.service.pollGithubNow()).resolves.toEqual({ ok: true, events: 0 })
      expect(hShort.service.githubPollStatus().health).toBe('ok')
      expect(hShort.service.githubPollStatus().consecutiveFailures).toBe(0)
      expect(hShort.service.githubPollCursorStore.isKnownIssue('acme/widgets', 1)).toBe(true)
      expect(hShort.store.links.find(l => l.number === 1)?.targetKind).toBe('issue')
      expect(shortCalls.filter(c => c === 'repos/acme/widgets/pulls/1')).toHaveLength(0)
      expect(shortCalls.filter(c => c === 'repos/acme/widgets/issues/1')).toHaveLength(1)

      // Poll 2: issue #1 comment AND PR #5 review admitted with zero pulls/1* calls
      shortCalls.length = 0
      shortPhase = 2
      nowShort += 10_000
      const p2 = await hShort.service.pollGithubNow()
      expect(p2).toEqual({ ok: true, events: 2 })
      expect(shortCalls.some(c => c.includes('pulls/1') || c === 'repos/acme/widgets/issues/1')).toBe(false)
      expect(hShort.inbox.list().some(r => r.subject === 'acme/widgets#1' && r.summary.includes('human note on #1'))).toBe(true)
      expect(hShort.inbox.list().some(r => r.subject === 'acme/widgets#5' && r.type === 'pull_request_review.approved')).toBe(true)

      // Poll 3: PR #5 CI failure still detected normally!
      shortCalls.length = 0
      shortPhase = 3
      nowShort += 10_000
      const p3 = await hShort.service.pollGithubNow()
      expect(p3).toEqual({ ok: true, events: 1 })
      expect(hShort.inbox.list().some(r => r.type === 'check_suite.completed' && r.subject === 'acme/widgets:checks:ci@feat/5')).toBe(true)

      // Poll 4: 304 unchanged -> ZERO writes & zero pulls/1* calls
      send304Short = true
      shortCalls.length = 0
      hShort.puts.length = 0
      nowShort += 10_000
      await expect(hShort.service.pollGithubNow()).resolves.toEqual({ ok: true, events: 0 })
      expect(hShort.puts).toEqual([])
      expect(shortCalls.some(c => c.includes('pulls/1') || c === 'repos/acme/widgets/issues/1')).toBe(false)
    } finally {
      await hShort.service.dispose()
      hShort.cleanup()
    }

    // 3. Genuine inaccessible PR (404 on both pulls/99 and issues/99): isolates per-target error, preserves earlier
    //    comment & sibling PR #5 events, triggers >=3 consecutive failure error alert, and skips after 24h retry window.
    let nowErr = 1_700_000_000_000
    let errPhase = 1
    const hErr = makeHarness(async (_bin, args) => {
      if (args[0] === '--version') return { stdout: 'gh version 2.102.0\n', stderr: '' }
      if (args[0] === 'auth') return { stdout: authSuccessStdout(), stderr: '' }
      if (args[1] === 'rate_limit') return { stdout: JSON.stringify({ resources: { core: { remaining: 5000, limit: 5000 } } }), stderr: '' }
      if (args[1] === 'repos/acme/widgets/pulls/99/reviews?per_page=100' || args[1] === 'repos/acme/widgets/issues/99') {
        throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { code: 1, stderr: 'gh: Not Found (HTTP 404)' })
      }
      if (args[1] === 'repos/acme/widgets/pulls/5/reviews?per_page=100') {
        return {
          stdout: httpInclude({}, errPhase === 2
            ? [{ id: 951, state: 'APPROVED', body: 'ok', user: { login: 'carol', type: 'User' }, html_url: 'https://github.com/acme/widgets/pull/5#pullrequestreview-951', submitted_at: new Date(nowErr).toISOString() }]
            : []),
          stderr: '',
        }
      }
      if (args[1]?.startsWith('repos/acme/widgets/issues/comments?')) {
        return {
          stdout: httpInclude({}, errPhase === 2
            ? [{ id: 3001, body: 'comment preserved despite #99 404', user: { login: 'alice', type: 'User' }, html_url: 'https://github.com/acme/widgets/issues/6#issuecomment-3001', created_at: new Date(nowErr).toISOString(), updated_at: new Date(nowErr).toISOString() }]
            : []),
          stderr: '',
        }
      }
      return { stdout: httpInclude({}, []), stderr: '' }
    }, () => nowErr)

    try {
      const ch99 = await hErr.store.work.createChange({
        title: 'Missing PR 99', cwd: hErr.home, goal: 'Missing PR 99',
        requirements: [{ requirementRef: 'R1', text: 'PR 99', required: true }], at: nowErr,
      })
      const ch5 = await hErr.store.work.createChange({
        title: 'Healthy PR 5', cwd: hErr.home, goal: 'Healthy PR 5',
        requirements: [{ requirementRef: 'R1', text: 'PR 5', required: true }], at: nowErr,
      })
      await hErr.store.putLink(makeTaskLink(ch99.id, { repo: 'acme/widgets', number: 99, url: 'https://github.com/acme/widgets/pull/99' }, 'dot', nowErr))
      await hErr.store.putLink(makeTaskLink(ch5.id, { repo: 'acme/widgets', number: 5, url: 'https://github.com/acme/widgets/pull/5' }, 'dot', nowErr))

      await hErr.store.setSettings(patchSettings(DEFAULT_SETTINGS, {
        reflection: false,
        idleCheckMinutes: 0,
        githubPoll: { enabled: true, repos: ['acme/widgets'], webhookRepos: [], ghPath: 'gh', intervalSec: 120, streams: { issues: false, pulls: false, comments: true, ci: false }, ignoredActors: [] },
      }))

      // Failure 1 (cold-start): #99 404 -> degraded, 1 failure
      await expect(hErr.service.pollGithubNow()).resolves.toEqual({ ok: false, events: 0 })
      expect(hErr.service.githubPollStatus().health).toBe('degraded')
      expect(hErr.service.githubPollStatus().consecutiveFailures).toBe(1)

      // Failure 2: comment on #6 AND sibling PR #5 review are BOTH admitted (not discarded!), while ok=false tracks #99
      errPhase = 2
      nowErr += 10_000
      const f2 = await hErr.service.pollGithubNow()
      expect(f2).toEqual({ ok: false, events: 2 })
      expect(hErr.inbox.list().map(r => r.subject).sort()).toEqual(['acme/widgets#5', 'acme/widgets#6'])
      expect(hErr.service.githubPollStatus().consecutiveFailures).toBe(2)
      expect(hErr.service.githubPollStatus().alert).toBe(false)

      // Failure 3: reaches error alert threshold
      errPhase = 3
      nowErr += 10_000
      await expect(hErr.service.pollGithubNow()).resolves.toEqual({ ok: false, events: 0 })
      expect(hErr.service.githubPollStatus().alert).toBe(true)
      expect(hErr.service.githubPollStatus().health).toBe('error')

      // After 24h retry window, #99 is skipped and poller recovers cleanly
      nowErr += 24 * 60 * 60_000 + 1000
      await expect(hErr.service.pollGithubNow()).resolves.toEqual({ ok: true, events: 0 })
      expect(hErr.service.githubPollStatus().health).toBe('ok')
      expect(hErr.service.githubPollStatus().consecutiveFailures).toBe(0)
    } finally {
      await hErr.service.dispose()
      hErr.cleanup()
    }
  })
})
