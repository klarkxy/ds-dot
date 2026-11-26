// Adapted from deepseek-ai/dsh-superagent-prototype@8c32a9d (MIT).
import { execFile as nodeExecFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { GithubPollTestResult } from '../contracts.ts'
import { GITHUB_REPO_RE, normalizeGithubRepo } from '../settings.ts'

export const GH_CLI_TIMEOUT_MS = 30_000
export const GH_CLI_MAX_BUFFER = 8 * 1024 * 1024

const TOKEN_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
  /(Authorization:\s*(?:Bearer|token|Basic)\s+)\S+/gi,
  /\b((?:Bearer|token)\s+)[A-Za-z0-9._+/=-]{6,}/gi,
  /x-access-token:[^\s@]+@/gi,
  /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
  /(https?:\/\/)([^/\s:@]+)@/gi,
] as const

/** Scrub GitHub tokens, auth headers, and URL userinfo from stderr/logs before storing or surfacing. */
export function redactGithubTokens(text: string): string {
  if (!text) return text
  return text
    .replace(TOKEN_PATTERNS[0], '[REDACTED]')
    .replace(TOKEN_PATTERNS[1], '$1[REDACTED]')
    .replace(TOKEN_PATTERNS[2], '$1[REDACTED]')
    .replace(TOKEN_PATTERNS[3], 'x-access-token:[REDACTED]@')
    .replace(TOKEN_PATTERNS[4], '$1[REDACTED]:[REDACTED]@')
    .replace(TOKEN_PATTERNS[5], '$1[REDACTED]@')
}

export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) {
    super(redactGithubTokens(message))
    this.name = 'CliError'
  }
}

export interface ExecFileOptions {
  readonly windowsHide: boolean
  readonly timeout: number
  readonly maxBuffer: number
  readonly signal?: AbortSignal
  readonly env: NodeJS.ProcessEnv
  readonly shell?: false
}

export type ExecFileRunner = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string }>

function defaultExecFile(file: string, args: readonly string[], options: ExecFileOptions): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFileCallback(
      file,
      [...args],
      {
        windowsHide: options.windowsHide,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
        env: options.env,
        shell: false,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          const enriched = error as Error & { stdout?: string; stderr?: string }
          if (typeof stdout === 'string' && enriched.stdout === undefined) enriched.stdout = stdout
          if (typeof stderr === 'string' && enriched.stderr === undefined) enriched.stderr = stderr
          reject(enriched)
          return
        }
        resolve({ stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''), stderr: typeof stderr === 'string' ? stderr : String(stderr ?? '') })
      },
    )
  })
}

function windowsGhCandidates(ghPath: string, exists: (p: string) => boolean = existsSync): string[] {
  const trimmed = ghPath.trim() || 'gh'
  const candidates = [trimmed]
  if (trimmed === 'gh') {
    candidates.push('gh.exe')
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : undefined,
      'C:\\Program Files',
    ].filter((v): v is string => typeof v === 'string' && v.length > 0)
    for (const root of roots) {
      const full = join(root, 'GitHub CLI', 'gh.exe')
      if (exists(full) && !candidates.includes(full)) candidates.push(full)
    }
  }
  return candidates
}

function endedDescription(error: unknown): string {
  const row = error as { code?: unknown; signal?: unknown; killed?: unknown; message?: unknown } | undefined
  if (row?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output exceeded buffer limit'
  if (row?.killed && row?.signal === 'SIGTERM') return 'timed out'
  if (typeof row?.signal === 'string' && row.signal) return `killed by ${row.signal}`
  if (typeof row?.code === 'number') return `exited with status ${row.code}`
  if (typeof row?.code === 'string' && row.code) return `failed (${row.code})`
  return row?.message ? String(row.message) : 'failed'
}

/** Convert an execFile failure into a token-redacted CliError without ever echoing argv. */
export function commandError(error: unknown, program = 'gh'): Error {
  if (error instanceof CliError) return error
  if ((error instanceof Error || (typeof error === 'object' && error !== null)) && (error as { name?: unknown }).name === 'AbortError') {
    return error instanceof Error ? error : Object.assign(new Error('Aborted'), { name: 'AbortError' })
  }
  const row = error as { code?: unknown; stderr?: unknown } | undefined
  const exitCode = typeof row?.code === 'number' ? row.code : undefined
  const stderr = typeof row?.stderr === 'string' ? redactGithubTokens(row.stderr).trim() : ''
  if (stderr) {
    const jsonIndex = stderr.indexOf('{')
    if (jsonIndex >= 0) {
      try {
        const parsed = JSON.parse(stderr.slice(jsonIndex)) as { error?: { message?: unknown; code?: unknown }; message?: unknown; status?: unknown }
        const msg = typeof parsed?.error?.message === 'string'
          ? parsed.error.message
          : typeof parsed?.message === 'string' ? parsed.message : undefined
        const code = typeof parsed?.error?.code === 'number'
          ? parsed.error.code
          : typeof parsed?.status === 'number' ? parsed.status : undefined
        if (msg) return new CliError(msg, code, exitCode)
      } catch { /* fall through to HTTP regex / plain stderr */ }
    }
    const httpMatch = /\bHTTP (\d{3})\b/.exec(stderr)
    const code = httpMatch ? Number(httpMatch[1]) : undefined
    return new CliError(stderr.slice(0, 2000), code, exitCode)
  }
  return new CliError(`${basename(program)} ${endedDescription(error)}`, undefined, exitCode)
}

export function validItems<T>(schema: z.ZodType<T>, list: readonly unknown[], tally?: { skipped: number }): T[] {
  const out: T[] = []
  for (const item of list) {
    const parsed = schema.safeParse(item)
    if (parsed.success) out.push(parsed.data)
    else if (tally) tally.skipped += 1
  }
  return out
}

const UNSAFE_SUBPATH_RE = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i

/** Restrict GitHub API paths strictly to the configured `owner/repo` subtree. */
export function repoPath(repo: string, subPath = ''): string {
  const normalized = normalizeGithubRepo(repo)
  if (!GITHUB_REPO_RE.test(normalized)) {
    throw new CliError(`Invalid GitHub repository: ${repo}`)
  }
  const trimmed = subPath.trim()
  if (trimmed && UNSAFE_SUBPATH_RE.test(trimmed)) {
    throw new CliError('GitHub calls are restricted to the configured repository')
  }
  return trimmed ? `repos/${normalized}/${trimmed}` : `repos/${normalized}`
}

export function normalizeGhHostname(hostname?: string): string | undefined {
  const trimmed = hostname?.trim().toLowerCase()
  if (!trimmed || trimmed === 'github.com') return undefined
  return trimmed
}

export interface GhHeaders {
  readonly status?: number
  readonly etag?: string
  readonly lastModified?: string
  readonly pollIntervalSec?: number
  readonly rateLimitRemaining?: number
  readonly rateLimitLimit?: number
  readonly rateLimitResetAt?: number
  readonly link?: string
  readonly hasNext: boolean
  readonly raw: ReadonlyMap<string, string>
}

export interface GhApiIncludeResponse {
  readonly notModified: boolean
  readonly status: number
  readonly headers: GhHeaders
  readonly body: string
}

/**
 * Parse `gh api --include` stdout. Note empirical Win32/POSIX `gh` format:
 * HTTP/2 status line ends with `\n` while headers end with `\r\n`, and header
 * names are case-normalized (`Etag:`, `X-Ratelimit-Remaining:`, etc.).
 */
export function parseIncludeResponse(stdout: string): { readonly status: number; readonly headers: GhHeaders; readonly body: string } {
  const sep = /\r?\n\r?\n/.exec(stdout)
  const headerBlock = sep ? stdout.slice(0, sep.index) : stdout
  const body = sep ? stdout.slice(sep.index + sep[0].length) : ''
  const lines = headerBlock.split(/\r?\n/)
  const statusLine = lines[0] ?? ''
  const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})\b/i.exec(statusLine)
  const status = statusMatch ? Number(statusMatch[1]) : 200
  const raw = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (!key) continue
    const prev = raw.get(key)
    raw.set(key, prev ? `${prev}, ${value}` : value)
  }
  const intHeader = (name: string): number | undefined => {
    const v = raw.get(name)
    if (v === undefined) return undefined
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined
  }
  const link = raw.get('link')
  const resetSec = intHeader('x-ratelimit-reset')
  const pollInt = intHeader('x-poll-interval')
  const headers: GhHeaders = {
    status,
    ...(raw.get('etag') ? { etag: raw.get('etag') } : {}),
    ...(raw.get('last-modified') ? { lastModified: raw.get('last-modified') } : {}),
    ...(pollInt !== undefined && pollInt > 0 ? { pollIntervalSec: pollInt } : {}),
    ...(intHeader('x-ratelimit-remaining') !== undefined ? { rateLimitRemaining: intHeader('x-ratelimit-remaining') } : {}),
    ...(intHeader('x-ratelimit-limit') !== undefined ? { rateLimitLimit: intHeader('x-ratelimit-limit') } : {}),
    ...(resetSec !== undefined ? { rateLimitResetAt: resetSec * 1000 } : {}),
    ...(link ? { link } : {}),
    hasNext: link ? /<[^>]+>;\s*rel="next"/i.test(link) : false,
    raw,
  }
  return { status, headers, body }
}

export interface GhCliOptions {
  readonly ghPath?: string
  readonly hostname?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly exec?: ExecFileRunner
  readonly platform?: NodeJS.Platform
  readonly fileExists?: (path: string) => boolean
}

export class GhCli {
  readonly ghPath: string
  readonly hostname?: string
  private readonly extraEnv: Readonly<Record<string, string | undefined>>
  private readonly runner: ExecFileRunner
  private readonly platform: NodeJS.Platform
  private readonly fileExists: (path: string) => boolean
  private resolvedBin?: string

  constructor(options: GhCliOptions = {}) {
    this.ghPath = options.ghPath?.trim() || 'gh'
    this.hostname = normalizeGhHostname(options.hostname)
    this.extraEnv = options.env ?? {}
    this.runner = options.exec ?? defaultExecFile
    this.platform = options.platform ?? process.platform
    this.fileExists = options.fileExists ?? existsSync
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const [key, value] of Object.entries(this.extraEnv)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    env.GH_PROMPT_DISABLED = '1'
    env.GH_NO_UPDATE_NOTIFIER = '1'
    return env
  }

  /** Execute `gh` without shell interpolation; never passes `gh auth token`. */
  async exec(args: readonly string[], signal?: AbortSignal): Promise<{ readonly stdout: string; readonly stderr: string; readonly binary: string }> {
    if (args[0] === 'auth' && args[1] === 'token') {
      throw new CliError('Refused: gh auth token must never be called')
    }
    const candidates = this.resolvedBin
      ? [this.resolvedBin]
      : (this.platform === 'win32' ? windowsGhCandidates(this.ghPath, this.fileExists) : [this.ghPath])
    const env = this.buildEnv()
    let lastError: unknown
    for (const bin of candidates) {
      try {
        const res = await this.runner(bin, args, {
          windowsHide: true,
          timeout: GH_CLI_TIMEOUT_MS,
          maxBuffer: GH_CLI_MAX_BUFFER,
          ...(signal ? { signal } : {}),
          env,
          shell: false,
        })
        this.resolvedBin = bin
        return { stdout: res.stdout, stderr: redactGithubTokens(res.stderr), binary: bin }
      } catch (error) {
        lastError = error
        const code = (error as { code?: unknown } | undefined)?.code
        if (code === 'ENOENT') continue
        throw commandError(error, bin)
      }
    }
    throw commandError(lastError, candidates[0] ?? this.ghPath)
  }

  private apiArgs(path: string, extraArgs: readonly string[]): string[] {
    return ['api', ...(this.hostname ? ['--hostname', this.hostname] : []), path, ...extraArgs]
  }

  async apiRaw(path: string, extraArgs: readonly string[] = [], signal?: AbortSignal): Promise<string> {
    const { stdout } = await this.exec(this.apiArgs(path, extraArgs), signal)
    return stdout
  }

  async api<T>(schema: z.ZodType<T>, path: string, extraArgs: readonly string[] = [], signal?: AbortSignal): Promise<T> {
    const raw = await this.apiRaw(path, extraArgs, signal)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new CliError('Invalid JSON from gh api')
    }
    const checked = schema.safeParse(parsed)
    if (!checked.success) {
      throw new CliError(`Unexpected GitHub API payload: ${checked.error.issues[0]?.message ?? 'schema mismatch'}`)
    }
    return checked.data
  }

  /**
   * Fetch page 1 with `--include` (never combined with `--paginate --slurp`).
   * Catches HTTP 304 cleanly so callers never parse empty bodies or dirty state.
   */
  async apiWithHeaders(path: string, extraArgs: readonly string[] = [], signal?: AbortSignal): Promise<GhApiIncludeResponse> {
    if (extraArgs.includes('--paginate') || extraArgs.includes('--slurp')) {
      throw new CliError('Cannot combine --include with --paginate or --slurp')
    }
    try {
      const { stdout } = await this.exec(this.apiArgs(path, ['--include', ...extraArgs]), signal)
      const parsed = parseIncludeResponse(stdout)
      return {
        notModified: parsed.status === 304,
        status: parsed.status,
        headers: parsed.headers,
        body: parsed.body,
      }
    } catch (error) {
      if (error instanceof CliError && error.code === 304) {
        return {
          notModified: true,
          status: 304,
          headers: { status: 304, hasNext: false, raw: new Map() },
          body: '',
        }
      }
      throw error
    }
  }

  async pages<T>(schema: z.ZodType<T>, path: string, tally?: { skipped: number }, signal?: AbortSignal): Promise<T[]> {
    const raw = await this.apiRaw(path, ['--paginate', '--slurp'], signal)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new CliError('Invalid JSON from paginated gh api')
    }
    const pages = z.array(z.array(z.unknown())).safeParse(parsed)
    if (!pages.success) {
      throw new CliError('Expected paginated array of arrays from gh api --paginate --slurp')
    }
    return validItems(schema, pages.data.flat(), tally)
  }

  /**
   * Repository-scoped fetch with `--include` headers on page 1 and automatic
   * `--paginate --slurp` follow-up (without `--include`) when `Link: rel="next"` is present.
   */
  async repoPagesWithHeaders<T>(
    schema: z.ZodType<T>,
    repo: string,
    subPath: string,
    extraArgs: readonly string[] = [],
    tally?: { skipped: number },
    signal?: AbortSignal,
  ): Promise<{ readonly notModified: true; readonly headers: GhHeaders } | { readonly notModified: false; readonly headers: GhHeaders; readonly items: T[] }> {
    const path = repoPath(repo, subPath)
    const first = await this.apiWithHeaders(path, extraArgs, signal)
    if (first.notModified) return { notModified: true, headers: first.headers }
    if (first.headers.hasNext) {
      const items = await this.pages(schema, path, tally, signal)
      return { notModified: false, headers: first.headers, items }
    }
    let parsed: unknown
    try {
      parsed = first.body.trim() ? JSON.parse(first.body) : []
    } catch {
      throw new CliError('Invalid JSON body from gh api --include')
    }
    if (!Array.isArray(parsed)) {
      throw new CliError('Expected JSON array from gh api list endpoint')
    }
    return { notModified: false, headers: first.headers, items: validItems(schema, parsed, tally) }
  }

  async repoApi<T>(schema: z.ZodType<T>, repo: string, subPath = '', extraArgs: readonly string[] = [], signal?: AbortSignal): Promise<T> {
    return this.api(schema, repoPath(repo, subPath), extraArgs, signal)
  }

  async repoPages<T>(schema: z.ZodType<T>, repo: string, subPath: string, tally?: { skipped: number }, signal?: AbortSignal): Promise<T[]> {
    return this.pages(schema, repoPath(repo, subPath), tally, signal)
  }
}

const authHostsSchema = z.object({
  hosts: z.record(z.string(), z.array(z.object({
    state: z.string().optional(),
    active: z.boolean().optional(),
    host: z.string().optional(),
    login: z.string().optional(),
  }).loose())).optional(),
}).loose()

const rateLimitSchema = z.object({
  resources: z.object({
    core: z.object({
      remaining: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      reset: z.number().int().optional(),
    }).loose(),
  }).loose().optional(),
  rate: z.object({
    remaining: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    reset: z.number().int().optional(),
  }).loose().optional(),
}).loose()

/**
 * Probe `gh` binary availability, active authentication for the target host
 * (`--json hosts` inspected directly since `gh auth status --json hosts` exits 0
 * even when unauthenticated!), rate-limit quota, and optional per-repo access.
 */
export async function testGhAvailability(options: {
  readonly ghPath?: string
  readonly hostname?: string
  readonly repos?: readonly string[]
  readonly signal?: AbortSignal
  readonly exec?: ExecFileRunner
  readonly platform?: NodeJS.Platform
  readonly fileExists?: (path: string) => boolean
} = {}): Promise<GithubPollTestResult> {
  const cli = new GhCli(options)
  const host = cli.hostname ?? 'github.com'
  let resolvedPath: string | undefined
  let version: string | undefined
  try {
    const ver = await cli.exec(['--version'], options.signal)
    resolvedPath = ver.binary
    const line = ver.stdout.split(/\r?\n/)[0]?.trim()
    version = line || undefined
  } catch (error) {
    return {
      ok: false,
      ghFound: false,
      authenticated: false,
      host,
      error: redactGithubTokens(error instanceof Error ? error.message : String(error)),
    }
  }

  let authenticated = false
  let login: string | undefined
  let authError: string | undefined
  const authArgs = ['auth', 'status', '--active', ...(cli.hostname ? ['--hostname', cli.hostname] : []), '--json', 'hosts']
  try {
    const auth = await cli.exec(authArgs, options.signal)
    const parsedJson = JSON.parse(auth.stdout) as unknown
    const parsed = authHostsSchema.safeParse(parsedJson)
    if (parsed.success && parsed.data.hosts) {
      const entries = parsed.data.hosts[host] ?? Object.values(parsed.data.hosts).flat()
      const active = entries.find(entry => entry.state === 'success' && (entry.active ?? true))
      if (active) {
        authenticated = true
        login = active.login
      } else {
        authError = `Not authenticated to ${host}. Run: gh auth login${cli.hostname ? ` --hostname ${cli.hostname}` : ''}`
      }
    } else {
      authError = `Not authenticated to ${host}.`
    }
  } catch (error) {
    // Fallback for older gh versions without `--json hosts`
    try {
      const legacy = await cli.exec(['auth', 'status', ...(cli.hostname ? ['--hostname', cli.hostname] : [])], options.signal)
      const combined = `${legacy.stdout}\n${legacy.stderr}`
      const loginMatch = /Logged in to [^\s]+ account ([^\s(]+)/i.exec(combined)
      if (loginMatch || /Logged in to/i.test(combined)) {
        authenticated = true
        login = loginMatch?.[1]
      } else {
        authError = redactGithubTokens(combined.trim()) || `Not authenticated to ${host}.`
      }
    } catch (fallbackErr) {
      authError = redactGithubTokens(fallbackErr instanceof Error ? fallbackErr.message : error instanceof Error ? error.message : String(error))
    }
  }

  if (!authenticated) {
    return {
      ok: false,
      ghFound: true,
      ...(resolvedPath ? { resolvedPath } : {}),
      ...(version ? { version } : {}),
      authenticated: false,
      host,
      ...(authError ? { error: authError } : {}),
    }
  }

  let rateLimitRemaining: number | undefined
  let rateLimitLimit: number | undefined
  try {
    const rl = await cli.api(rateLimitSchema, 'rate_limit', [], options.signal)
    const core = rl.resources?.core ?? rl.rate
    if (core) {
      rateLimitRemaining = core.remaining
      rateLimitLimit = core.limit
    }
  } catch (error) {
    const message = redactGithubTokens(error instanceof Error ? error.message : String(error))
    return {
      ok: false,
      ghFound: true,
      ...(resolvedPath ? { resolvedPath } : {}),
      ...(version ? { version } : {}),
      authenticated: true,
      ...(login ? { login } : {}),
      host,
      error: message,
    }
  }

  const repoChecks: Array<{ readonly repo: string; readonly ok: boolean; readonly error?: string }> = []
  for (const rawRepo of options.repos ?? []) {
    const repo = normalizeGithubRepo(rawRepo)
    if (!repo) continue
    try {
      await cli.repoApi(z.object({ full_name: z.string() }).loose(), repo, '', [], options.signal)
      repoChecks.push({ repo, ok: true })
    } catch (error) {
      repoChecks.push({ repo, ok: false, error: redactGithubTokens(error instanceof Error ? error.message : String(error)) })
    }
  }

  const allReposOk = repoChecks.every(check => check.ok)
  return {
    ok: allReposOk,
    ghFound: true,
    ...(resolvedPath ? { resolvedPath } : {}),
    ...(version ? { version } : {}),
    authenticated: true,
    ...(login ? { login } : {}),
    host,
    ...(rateLimitRemaining !== undefined ? { rateLimitRemaining } : {}),
    ...(rateLimitLimit !== undefined ? { rateLimitLimit } : {}),
    ...(repoChecks.length > 0 ? { repoChecks } : {}),
    ...(!allReposOk ? { error: repoChecks.filter(c => !c.ok).map(c => `${c.repo}: ${c.error}`).join('; ') } : {}),
  }
}
