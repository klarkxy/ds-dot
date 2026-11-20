/**
 * Provider prompt caches expire minutes after the last request while dot waits
 * idle on running tasks. This file holds the pure keepalive numbers: how long
 * each model family's cache lives and how often it is pinged.
 */
import type { DotSettings } from './contracts.ts'

/** Prompt-cache lifetime in minutes by model family, from the providers' published defaults. */
export const CACHE_TTL_TABLE: readonly { readonly match: RegExp; readonly minutes: number }[] = [
  { match: /claude|anthropic/i, minutes: 5 },
  { match: /kimi|moonshot/i, minutes: 5 },
  { match: /gpt|openai|\bo[1-9]\b/i, minutes: 5 },
  { match: /gemini/i, minutes: 5 },
  { match: /deepseek/i, minutes: 60 },
]

export const DEFAULT_CACHE_TTL_MINUTES = 5
export const CACHE_TTL_MAX_MINUTES = 1440
/** Overrides the human may store, keyed by `provider/model`. */
export const CACHE_TTL_MAX_ENTRIES = 200
/** Cache pings one idle stretch may send before it rolls the segment over or gives up. */
export const KEEPALIVE_MAX_PINGS = 8

/** Same `provider/model` key format the task-model list uses; the model id often carries a gateway prefix. */
export const cacheTtlKey = (provider: string, model: string) => `${provider}/${model}`

/** First table match on the joined key, else the default. */
export function defaultCacheTtl(provider: string, model: string): number {
  const key = cacheTtlKey(provider, model)
  return CACHE_TTL_TABLE.find(row => row.match.test(key))?.minutes ?? DEFAULT_CACHE_TTL_MINUTES
}

/** The human's per-model override wins; 0 disables keepalive for that model. */
export function cacheTtlMinutes(settings: DotSettings, provider: string, model: string): number {
  return settings.cacheTtl?.[cacheTtlKey(provider, model)] ?? defaultCacheTtl(provider, model)
}

/** Ping at 80% of the cache lifetime so the next request still lands inside it. */
export function keepaliveIntervalMs(minutes: number): number | undefined {
  return minutes > 0 ? Math.floor(minutes * 60_000 * 0.8) : undefined
}
