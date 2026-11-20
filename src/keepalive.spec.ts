import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './contracts.ts'
import { CACHE_TTL_MAX_MINUTES, cacheTtlKey, cacheTtlMinutes, defaultCacheTtl, keepaliveIntervalMs } from './keepalive.ts'

describe('cacheTtlKey', () => {
  it('joins provider and model like the task-model list', () => {
    expect(cacheTtlKey('magpie', 'klarkxy/claude-opus-5-5')).toBe('magpie/klarkxy/claude-opus-5-5')
  })
})

describe('defaultCacheTtl', () => {
  it('matches the model family on the joined key, gateway prefix included', () => {
    expect(defaultCacheTtl('magpie', 'klarkxy/claude-opus-5-5')).toBe(5)
    expect(defaultCacheTtl('x', 'deepseek-v4.1-flash')).toBe(60)
    expect(defaultCacheTtl('moonshot', 'kimi-k2')).toBe(5)
    expect(defaultCacheTtl('azure', 'o4-mini')).toBe(5)
  })

  it('falls back to the default for unknown families', () => {
    expect(defaultCacheTtl('p', 'base')).toBe(5)
    expect(defaultCacheTtl('x', 'model-without-family')).toBe(5)
  })
})

describe('cacheTtlMinutes', () => {
  it('lets a per-model override win over the table', () => {
    const settings = { ...DEFAULT_SETTINGS, cacheTtl: { 'x/deepseek-v4.1-flash': 30, 'p/base': 0 } }
    expect(cacheTtlMinutes(settings, 'x', 'deepseek-v4.1-flash')).toBe(30)
    expect(cacheTtlMinutes(settings, 'p', 'base')).toBe(0)
    expect(cacheTtlMinutes(settings, 'p', 'big')).toBe(5)
  })
})

describe('keepaliveIntervalMs', () => {
  it('pings at 80% of the cache lifetime', () => {
    expect(keepaliveIntervalMs(5)).toBe(Math.floor(5 * 60_000 * 0.8))
    expect(keepaliveIntervalMs(60)).toBe(Math.floor(60 * 60_000 * 0.8))
    expect(keepaliveIntervalMs(5)).toBe(240_000)
  })

  it('is disabled at zero and below', () => {
    expect(keepaliveIntervalMs(0)).toBeUndefined()
    expect(keepaliveIntervalMs(-1)).toBeUndefined()
  })

  it('accepts the largest stored override', () => {
    expect(keepaliveIntervalMs(CACHE_TTL_MAX_MINUTES)).toBe(Math.floor(1440 * 60_000 * 0.8))
  })
})
