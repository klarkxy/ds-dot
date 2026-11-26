// Adapted from deepseek-ai/dsh-superagent-prototype@8c32a9d (MIT).
import { createHash } from 'node:crypto'
import { normalizeGithubRepo } from '../settings.ts'
import { parseGithubPollEntry, type GithubPollEntry } from '../storage.ts'
import type { DotTable } from '../store.ts'

export const ECHO_TTL_MS = 24 * 60 * 60_000
export const RETRY_WINDOW_MS = 24 * 60 * 60_000
const MAX_ECHO_ENTRIES = 500
const MAX_410_SUBJECTS = 200

export type StreamName = 'issues' | 'comments' | 'review-comments'
export type StreamCursor = Extract<GithubPollEntry, { kind: 'stream' }>
export type CiBaseline = Extract<GithubPollEntry, { kind: 'ci' }>
export type PrCiBaseline = Extract<GithubPollEntry, { kind: 'pr-ci' }>
export type EchoLedger = Extract<GithubPollEntry, { kind: 'echo' }>
export type RepoState = Extract<GithubPollEntry, { kind: 'repo' }>

/** DomainFacility requires every table record key to match `/^[a-zA-Z0-9_-]+$/`. */
function pollKey(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`
}

function streamKey(repo: string, stream: StreamName): string {
  return pollKey('stream', normalizeGithubRepo(repo), stream)
}
function ciKey(repo: string): string {
  return pollKey('ci', normalizeGithubRepo(repo))
}
function prCiKey(repo: string, number: number): string {
  return pollKey('prci', normalizeGithubRepo(repo), String(number))
}
function echoKey(repo: string): string {
  return pollKey('echo', normalizeGithubRepo(repo))
}
function repoKey(repo: string): string {
  return pollKey('repo', normalizeGithubRepo(repo))
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Durable KV store for GitHub poll cursors, CI baselines, echo suppression,
 * and webhook<->poll handoff timestamps. Writes ONLY to the dedicated `github_poll`
 * table on real changes — 304 / empty poll rounds perform zero writes and never
 * touch the main `state` doc or fire `DotStore.changed()`.
 */
export class GithubPollCursorStore {
  private readonly cache = new Map<string, GithubPollEntry>()

  constructor(private readonly table: DotTable | undefined) {
    if (table) {
      for (const [key, value] of table.entries()) {
        const parsed = parseGithubPollEntry(value)
        if (parsed) this.cache.set(String(key), parsed)
      }
    }
  }

  private async putIfChanged(key: string, next: GithubPollEntry): Promise<void> {
    const prev = this.cache.get(key)
    if (prev && sameJson(prev, next)) return
    this.cache.set(key, next)
    if (this.table) await this.table.put(key, next)
  }

  private async deleteKey(key: string): Promise<void> {
    if (!this.cache.delete(key)) return
    if (this.table) await this.table.delete(key)
  }

  getStreamCursor(repo: string, stream: StreamName): StreamCursor | undefined {
    const entry = this.cache.get(streamKey(repo, stream))
    return entry?.kind === 'stream' ? entry : undefined
  }

  async setStreamCursor(repo: string, stream: StreamName, cursor: Omit<StreamCursor, 'kind' | 'repo' | 'stream'>): Promise<void> {
    const norm = normalizeGithubRepo(repo)
    await this.putIfChanged(streamKey(norm, stream), {
      kind: 'stream',
      repo: norm,
      stream,
      ...cursor,
    })
  }

  async clearStreamCursor(repo: string, stream: StreamName): Promise<void> {
    await this.deleteKey(streamKey(repo, stream))
  }

  getCiBaseline(repo: string): CiBaseline | undefined {
    const entry = this.cache.get(ciKey(repo))
    return entry?.kind === 'ci' ? entry : undefined
  }

  async setCiBaseline(repo: string, baseline: Omit<CiBaseline, 'kind' | 'repo'>): Promise<void> {
    const norm = normalizeGithubRepo(repo)
    await this.putIfChanged(ciKey(norm), {
      kind: 'ci',
      repo: norm,
      ...baseline,
    })
  }

  async clearCiBaseline(repo: string): Promise<void> {
    await this.deleteKey(ciKey(repo))
  }

  getPrCiBaseline(repo: string, number: number): PrCiBaseline | undefined {
    const entry = this.cache.get(prCiKey(repo, number))
    return entry?.kind === 'pr-ci' ? entry : undefined
  }

  async setPrCiBaseline(repo: string, number: number, baseline: Omit<PrCiBaseline, 'kind' | 'repo' | 'number'>): Promise<void> {
    const norm = normalizeGithubRepo(repo)
    await this.putIfChanged(prCiKey(norm, number), {
      kind: 'pr-ci',
      repo: norm,
      number,
      ...baseline,
    })
  }

  async clearPrCiBaseline(repo: string, number: number): Promise<void> {
    await this.deleteKey(prCiKey(repo, number))
  }

  hasEcho(repo: string, id: string, now = Date.now(), ttlMs = ECHO_TTL_MS): boolean {
    const entry = this.cache.get(echoKey(repo))
    if (entry?.kind !== 'echo') return false
    const targetId = String(id)
    return entry.entries.some(item => item.id === targetId && now - item.sentAt <= ttlMs)
  }

  async recordEcho(
    repo: string,
    record: { readonly id: string; readonly kind: 'issue_comment' | 'review_comment' | 'review'; readonly sentAt: number },
    now = Date.now(),
    ttlMs = ECHO_TTL_MS,
  ): Promise<void> {
    const norm = normalizeGithubRepo(repo)
    const key = echoKey(norm)
    const existing = this.cache.get(key)
    const currentEntries = existing?.kind === 'echo' ? existing.entries : []
    const live = currentEntries.filter(item => now - item.sentAt <= ttlMs && item.id !== record.id)
    live.push({ id: String(record.id), kind: record.kind, sentAt: record.sentAt })
    const bounded = live.slice(-MAX_ECHO_ENTRIES)
    await this.putIfChanged(key, {
      kind: 'echo',
      repo: norm,
      entries: bounded,
      updatedAt: now,
    })
  }

  getRepoState(repo: string): RepoState | undefined {
    const entry = this.cache.get(repoKey(repo))
    return entry?.kind === 'repo' ? entry : undefined
  }

  listRepoStates(): RepoState[] {
    return [...this.cache.values()].filter((entry): entry is RepoState => entry.kind === 'repo')
  }

  async updateRepoState(
    repo: string,
    patch: Partial<Omit<RepoState, 'kind' | 'repo'>>,
  ): Promise<RepoState> {
    const norm = normalizeGithubRepo(repo)
    const key = repoKey(norm)
    const prev = this.getRepoState(norm) ?? { kind: 'repo' as const, repo: norm, consecutiveFailures: 0 }
    const merged: Record<string, unknown> = { ...prev, ...patch, kind: 'repo', repo: norm }
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined) delete merged[k]
    }
    const next = merged as unknown as RepoState
    await this.putIfChanged(key, next)
    return next
  }

  async recordDelivery(repo: string, mode: 'poll' | 'webhook', deliveredAt: number): Promise<void> {
    const prev = this.getRepoState(repo)
    const latest = Math.max(prev?.lastDeliveredAt ?? 0, deliveredAt)
    await this.updateRepoState(repo, {
      lastDeliveredAt: latest,
      lastMode: mode,
    })
  }

  is410Gone(repo: string, subject: string): boolean {
    return this.getRepoState(repo)?.deleted410Subjects?.includes(subject) ?? false
  }

  async mark410Gone(repo: string, subject: string): Promise<void> {
    const prev = this.getRepoState(repo)
    const current = prev?.deleted410Subjects ?? []
    if (current.includes(subject)) return
    await this.updateRepoState(repo, {
      deleted410Subjects: [...current.slice(-(MAX_410_SUBJECTS - 1)), subject],
    })
  }

  async clear(): Promise<void> {
    const keys = [...this.cache.keys()]
    this.cache.clear()
    if (this.table) {
      for (const key of keys) await this.table.delete(key)
    }
  }
}
