import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SETTING_FIELDS, validateMcpCredentialSet } from './contracts.ts'
import { DEFAULT_ADDRESS, DEFAULT_PERSONA, PERSONA_MAX_CHARS } from './persona.ts'
import { lockedField, parseSettings, patchSettings } from './settings.ts'
import { DotStore } from './store.ts'

describe('parseSettings', () => {
  it('validates idle check interval with zero as disabled', () => {
    expect(parseSettings({}).idleCheckMinutes).toBe(10)
    expect(parseSettings({ idleCheckMinutes: 0 }).idleCheckMinutes).toBe(0)
    expect(parseSettings({ idleCheckMinutes: 1441 }).idleCheckMinutes).toBe(10)
    expect(() => patchSettings(DEFAULT_SETTINGS, { idleCheckMinutes: -1 })).toThrow()
    expect(() => patchSettings(DEFAULT_SETTINGS, { idleCheckMinutes: 1.5 })).toThrow()
  })
  it('defaults auto update on and round-trips a boolean', () => {
    expect(parseSettings({}).autoUpdate).toBe(true)
    expect(parseSettings({ autoUpdate: false }).autoUpdate).toBe(false)
    expect(parseSettings({ autoUpdate: 'no' }).autoUpdate).toBe(true)
    expect(patchSettings(DEFAULT_SETTINGS, { autoUpdate: false }).autoUpdate).toBe(false)
    expect(() => patchSettings(DEFAULT_SETTINGS, { autoUpdate: 'no' })).toThrow()
  })
  it('fills defaults and keeps each valid field on its own', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    const parsed = parseSettings({ approvals: 'deny', questions: 'nonsense', taskPermission: 'inherit', approvalAllowlist: ['read'], notifyQuietSeconds: 30, awayMinutes: 20, model: { provider: 'p', model: 'm' } })
    expect(parsed.approvals).toBe('deny')
    expect(parsed.questions).toBe('dot')
    expect(parsed.taskPermission).toBe('workspace-write')
    expect(parsed).not.toHaveProperty('approvalAllowlist')
    expect(parsed).not.toHaveProperty('notifyQuietSeconds')
    expect(parsed).not.toHaveProperty('awayMinutes')
    expect(parsed.model).toEqual({ provider: 'p', model: 'm' })
    expect(parseSettings({ approvals: 'off' }).approvals).toBe('dot')
  })

  it('defaults a fresh install to workspace write and keeps a saved permission', () => {
    expect(DEFAULT_SETTINGS.scope).toBe('tracked')
    expect(DEFAULT_SETTINGS.taskPermission).toBe('workspace-write')
    expect(parseSettings({}).taskPermission).toBe('workspace-write')
    expect(parseSettings({ taskPermission: 'danger-full-access' }).taskPermission).toBe('danger-full-access')
    expect(parseSettings({ taskPermission: 'default' }).taskPermission).toBe('workspace-write')
    // An unknown value never replaces a known one.
    expect(parseSettings({ taskPermission: 'inherit' }).taskPermission).toBe('workspace-write')
  })



  it('defaults defaultTaskPreset to standard and validates known options', () => {
    expect(DEFAULT_SETTINGS.defaultTaskPreset).toBe('standard')
    expect(parseSettings({}).defaultTaskPreset).toBe('standard')
    expect(parseSettings({ defaultTaskPreset: 'dot-worker' }).defaultTaskPreset).toBe('dot-worker')
    expect(parseSettings({ defaultTaskPreset: 'ptc' }).defaultTaskPreset).toBe('standard')
    expect(parseSettings({ defaultTaskPreset: 123 }).defaultTaskPreset).toBe('standard')

    const updated = patchSettings(DEFAULT_SETTINGS, { defaultTaskPreset: 'dot-worker' })
    expect(updated.defaultTaskPreset).toBe('dot-worker')
    expect(patchSettings(updated, { defaultTaskPreset: 'standard' }).defaultTaskPreset).toBe('standard')
    expect(() => patchSettings(DEFAULT_SETTINGS, { defaultTaskPreset: 'ptc' })).toThrow(/defaultTaskPreset/)
    expect(() => patchSettings(DEFAULT_SETTINGS, { defaultTaskPreset: null })).toThrow(/defaultTaskPreset/)

    const locked = patchSettings(DEFAULT_SETTINGS, { locks: { defaultTaskPreset: true } })
    expect(locked.locks).toEqual({ defaultTaskPreset: true })
    expect(parseSettings({ locks: { defaultTaskPreset: true } }).locks).toEqual({ defaultTaskPreset: true })
  })
})

describe('patchSettings', () => {
  it('applies a valid patch and clears the model with null', () => {
    const withModel = patchSettings(DEFAULT_SETTINGS, { model: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
    expect(withModel.model).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
    expect(patchSettings(withModel, { model: null }).model).toBeUndefined()
  })

  it('stores a changed persona and address, and clears them back to the defaults', () => {
    const custom = patchSettings(DEFAULT_SETTINGS, { persona: 'A calm librarian.', address: ' 老板 ' })
    expect(custom.persona).toBe('A calm librarian.')
    expect(custom.address).toBe('老板')
    const restored = patchSettings(custom, { persona: null, address: null })
    expect(restored.persona).toBeUndefined()
    expect(restored.address).toBeUndefined()
    // Saving the default text keeps following the default.
    expect(patchSettings(custom, { persona: DEFAULT_PERSONA + '\n', address: DEFAULT_ADDRESS }).persona).toBeUndefined()
    expect(() => patchSettings(DEFAULT_SETTINGS, { address: '   ' })).toThrow(/address/)
    expect(parseSettings({ persona: 'x'.repeat(PERSONA_MAX_CHARS + 1), address: '小鱼' })).toMatchObject({ address: '小鱼' })
    expect(parseSettings({ persona: 'x'.repeat(PERSONA_MAX_CHARS + 1) }).persona).toBeUndefined()
  })

  it('uses a three-section Chinese default persona that is warm, encouraging and honest', () => {
    expect(DEFAULT_PERSONA).toContain('你叫桃乐丝')
    expect(DEFAULT_PERSONA).toContain('英文名 Dorothy')
    expect(DEFAULT_PERSONA).toContain('简称 dot')
    expect(DEFAULT_PERSONA).toContain('鼓励')
    expect(DEFAULT_PERSONA).not.toContain('不是《妮姬》')
    expect(DEFAULT_PERSONA).not.toContain('社区里的 doro')
    for (const heading of ['【性格和在意的东西】', '【怎么说话】', '【和用户的关系】']) expect(DEFAULT_PERSONA).toContain(heading)
    // sectionLead already introduces the persona, so the body starts without a heading.
    expect(DEFAULT_PERSONA.startsWith('【')).toBe(false)
    expect(DEFAULT_PERSONA).toContain('聊正事时先给结论。')
    expect(DEFAULT_PERSONA).not.toContain('确实需要用户拍板时')
    expect(DEFAULT_PERSONA.length).toBeLessThanOrEqual(1200)
    expect(DEFAULT_PERSONA).not.toMatch(/姐姐|妹妹|鲸鱼娘|大肥鱼|粉色虎鲸|粉毛小狗|大小姐|sister|At work|Off duty|the human/i)
  })

  it('stores the task model list and keeps the default for settings saved before it existed', () => {
    expect(parseSettings({ approvals: 'human' }).taskModels).toEqual({ mode: 'all', list: [] })
    const next = patchSettings(DEFAULT_SETTINGS, { taskModels: { mode: 'deny', list: [' magpie/team/pro '] } })
    expect(next.taskModels).toEqual({ mode: 'deny', list: ['magpie/team/pro'] })
    expect(parseSettings(next).taskModels).toEqual(next.taskModels)
    expect(() => patchSettings(DEFAULT_SETTINGS, { taskModels: { mode: 'block', list: [] } })).toThrow(/taskModels/)
    expect(() => patchSettings(DEFAULT_SETTINGS, { taskModels: { mode: 'allow' } })).toThrow(/taskModels/)
    expect(parseSettings({ taskModels: { mode: 'allow', list: 'p/m' } }).taskModels).toEqual({ mode: 'all', list: [] })
  })

  it('refuses unknown keys and bad values as a whole', () => {
    expect(() => patchSettings(DEFAULT_SETTINGS, { colour: 'pink' })).toThrow(/unknown setting/)
    expect(() => patchSettings(DEFAULT_SETTINGS, { approvals: 'allowlist' })).toThrow(/approvals/)
    // The removed blanket allow mode cannot be set again.
    expect(() => patchSettings(DEFAULT_SETTINGS, { approvals: 'allow' })).toThrow(/approvals/)
    expect(() => patchSettings(DEFAULT_SETTINGS, { approvalAllowlist: ['read'] })).toThrow(/unknown setting/)
    expect(() => patchSettings(DEFAULT_SETTINGS, { notifyQuietSeconds: 30 })).toThrow(/unknown setting/)
    expect(() => patchSettings(DEFAULT_SETTINGS, { awayMinutes: 10 })).toThrow(/unknown setting/)
    expect(() => patchSettings(DEFAULT_SETTINGS, { taskPermission: 'inherit' })).toThrow(/taskPermission/)
    expect(() => patchSettings(DEFAULT_SETTINGS, 'off')).toThrow(/object/)
  })

  it('stores the task permission and the reflection switch', () => {
    const next = patchSettings(DEFAULT_SETTINGS, { taskPermission: 'danger-full-access', reflection: false })
    expect(next.taskPermission).toBe('danger-full-access')
    expect(next.reflection).toBe(false)
    expect(parseSettings(next).taskPermission).toBe('danger-full-access')
    expect(parseSettings(next).reflection).toBe(false)
  })

  it('stores per-model cache TTL overrides and refuses bad values', () => {
    const next = patchSettings(DEFAULT_SETTINGS, { cacheTtl: { 'p/base': 12, 'x/deepseek-v4': 0 } })
    expect(next.cacheTtl).toEqual({ 'p/base': 12, 'x/deepseek-v4': 0 })
    expect(parseSettings(next).cacheTtl).toEqual(next.cacheTtl)
    expect(() => patchSettings(DEFAULT_SETTINGS, { cacheTtl: { 'p/base': -1 } })).toThrow(/cacheTtl/)
    expect(() => patchSettings(DEFAULT_SETTINGS, { cacheTtl: { 'p/base': 1441 } })).toThrow(/cacheTtl/)
    expect(() => patchSettings(DEFAULT_SETTINGS, { cacheTtl: { 'p/base': 1.5 } })).toThrow(/cacheTtl/)
    expect(() => patchSettings(DEFAULT_SETTINGS, { cacheTtl: { '': 5 } })).toThrow(/cacheTtl/)
    expect(() => patchSettings(DEFAULT_SETTINGS, { cacheTtl: null })).toThrow(/cacheTtl/)
    const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`p/m${index}`, 5]))
    expect(() => patchSettings(DEFAULT_SETTINGS, { cacheTtl: tooMany })).toThrow(/cacheTtl/)
  })

  it('ignores a malformed stored cache TTL map field by field', () => {
    expect(parseSettings({ cacheTtl: { 'p/base': 'soon' } }).cacheTtl).toBeUndefined()
    expect(parseSettings({ cacheTtl: 'yes' }).cacheTtl).toBeUndefined()
    expect(parseSettings({ cacheTtl: { 'p/base': 30 } }).cacheTtl).toEqual({ 'p/base': 30 })
  })

  it('keeps every setting unlocked by default and saves individual locks', () => {
    expect(parseSettings(undefined).locks).toBeUndefined()
    const next = patchSettings(DEFAULT_SETTINGS, { locks: { model: true, agreements: false } })
    expect(next.locks).toEqual({ model: true, agreements: false })
    expect(parseSettings(next).locks).toEqual(next.locks)
    expect(parseSettings({ locks: { model: true, taskPermission: true } }).locks).toEqual({ model: true, taskPermission: true })
    expect(() => patchSettings(DEFAULT_SETTINGS, { locks: { locks: true } })).toThrow()
  })
})

describe('DotStore settings', () => {
  it('keeps settings next to the dot session id', async () => {
    const rows = new Map<string, unknown>()
    const table = { entries: () => rows.entries(), get: (key: string) => rows.get(key), put: async (key: string, value: unknown) => { rows.set(key, value) } }
    const empty = new Map<string, unknown>()
    const domain = { table: (name: 'state' | 'tasks') => name === 'state' ? table : { entries: () => empty.entries(), get: () => undefined, put: async () => {} }, close: async () => {} }
    const store = new DotStore(domain)
    await store.setDot({ dotSessionId: 'dot1' })
    await store.setSettings(patchSettings(store.settings, { scope: 'tracked' }))
    const reloaded = new DotStore(domain)
    expect(reloaded.dotSessionId).toBe('dot1')
    expect(reloaded.settings.scope).toBe('tracked')
  })
})

describe('mcpServers setting', () => {
  const deepwiki = { url: 'https://mcp.deepwiki.com/mcp', enabled: true }
  it('accepts a valid remote row and a loopback http url', () => {
    const next = patchSettings(DEFAULT_SETTINGS, { mcpServers: { deepwiki } })
    expect(next.mcpServers?.deepwiki).toEqual(deepwiki)
    for (const url of ['http://127.0.0.1:8080/mcp', 'http://localhost/mcp', 'http://[::1]/mcp']) {
      expect(patchSettings(DEFAULT_SETTINGS, { mcpServers: { local: { url, enabled: true } } }).mcpServers?.local?.url).toBe(url)
    }
    expect(parseSettings({ mcpServers: { deepwiki } }).mcpServers?.deepwiki).toEqual(deepwiki)
  })
  it('rejects bad names, non-https non-loopback urls and malformed templates', () => {
    expect(() => patchSettings(DEFAULT_SETTINGS, { mcpServers: { 'bad name!': deepwiki } })).toThrow(/invalid value/)
    for (const url of ['http://example.com/mcp', 'ftp://x', 'notaurl', '']) {
      expect(() => patchSettings(DEFAULT_SETTINGS, { mcpServers: { s: { url, enabled: true } } }), url).toThrow(/invalid value/)
    }
    for (const value of ['Bearer ${bad}', '${credential:}', 'x ${credential:1BAD}', '${credential:OK}${other}', 'unclosed ${credential:OK']) {
      const row = { url: deepwiki.url, headers: { Authorization: value }, enabled: true }
      expect(() => patchSettings(DEFAULT_SETTINGS, { mcpServers: { s: row } }), value).toThrow(/invalid value/)
    }
    const good = { url: deepwiki.url, headers: { Authorization: 'Bearer ${credential:DOT_MCP_GH_TOKEN}', 'X-Extra': 'plain' }, enabled: true }
    expect(patchSettings(DEFAULT_SETTINGS, { mcpServers: { s: good } }).mcpServers?.s).toEqual(good)
    expect(() => patchSettings(DEFAULT_SETTINGS, { mcpServers: { s: { ...good, headers: { 'bad header': 'x' } } } })).toThrow(/invalid value/)
  })
  it('holds NEW names to the stricter rule but lets stored legacy rows through', () => {
    // `__` or edge `_` would let a tool name be claimed by two servers at
    // once, so one grant would silently cover both.
    for (const name of ['team__docs', 'a__b', '_edge', 'edge_', '__', '_']) {
      expect(() => patchSettings(DEFAULT_SETTINGS, { mcpServers: { [name]: deepwiki } }), name).toThrow(/invalid value/)
    }
    // A stored legacy row still saves on unrelated edits; only additions are strict.
    const legacy = { ...DEFAULT_SETTINGS, mcpServers: { 'team__docs': deepwiki } }
    const next = patchSettings(legacy, { mcpServers: { 'team__docs': deepwiki, other: deepwiki } })
    expect(Object.keys(next.mcpServers ?? {}).sort()).toEqual(['other', 'team__docs'])
  })
  it('drops grants a newly added server would inherit from an earlier owner', () => {
    const previous = {
      ...DEFAULT_SETTINGS,
      capabilities: { grants: {
        'mcp:deepwiki': 'auto' as const,
        'tool:mcp__deepwiki__ask': 'auto' as const,
        'tool:mcp__other__x': 'ask' as const,
        'plugin:bundle': 'auto' as const,
      } },
    }
    const next = patchSettings(previous, { mcpServers: { deepwiki } })
    expect(next.capabilities?.grants).toEqual({ 'tool:mcp__other__x': 'ask', 'plugin:bundle': 'auto' })
    // No grants touched when the write adds nothing new.
    const existing = { ...previous, mcpServers: { deepwiki } }
    const kept = patchSettings(existing, { mcpServers: { deepwiki } })
    expect(kept.capabilities?.grants).toEqual(previous.capabilities?.grants)
  })
  it('drops bad stored rows one by one and clears on null', () => {
    const parsed = parseSettings({ mcpServers: { deepwiki, 'bad name': deepwiki, bad: { url: 'http://x.com/mcp', enabled: true }, also_bad: 'junk' } })
    expect(Object.keys(parsed.mcpServers ?? {})).toEqual(['deepwiki'])
    expect(parseSettings({ mcpServers: 'junk' }).mcpServers).toBeUndefined()
    const cleared = patchSettings({ ...DEFAULT_SETTINGS, mcpServers: { deepwiki } }, { mcpServers: null })
    expect(cleared.mcpServers).toBeUndefined()
  })
})

describe('validateMcpCredentialSet', () => {
  const known = new Set(['deepwiki', 'github'])
  it('rejects bad servers and values, accepts the panel flow', () => {
    expect(validateMcpCredentialSet('deepwiki', 'tok', known)).toBeUndefined()
    expect(validateMcpCredentialSet('github', 'x'.repeat(4096), known)).toBeUndefined()
    expect(validateMcpCredentialSet(1, 'tok', known)).toBe('bad-server')
    expect(validateMcpCredentialSet('bad name!', 'tok', known)).toBe('bad-server')
    expect(validateMcpCredentialSet('ghost', 'tok', known)).toBe('unknown-server')
    expect(validateMcpCredentialSet('deepwiki', 5, known)).toBe('bad-credential')
    expect(validateMcpCredentialSet('deepwiki', '', known)).toBe('bad-credential')
    expect(validateMcpCredentialSet('deepwiki', '   ', known)).toBe('bad-credential')
    expect(validateMcpCredentialSet('deepwiki', 'x'.repeat(4097), known)).toBe('bad-credential')
  })
})

describe('githubPoll setting', () => {
  it('normalizes repos, enforces single-repo mutual exclusion, validates bounds and admission matrix, and excludes githubPoll from SETTING_FIELDS', () => {
    expect((SETTING_FIELDS as readonly string[]).includes('githubPoll')).toBe(false)
    expect(() => lockedField(DEFAULT_SETTINGS, 'githubPoll')).toThrow(/unknown setting/)

    const saved = patchSettings(DEFAULT_SETTINGS, {
      githubPoll: {
        enabled: true,
        repos: ['Acme/Widgets', 'acme/widgets'],
        webhookRepos: ['Acme/Other'],
        ghPath: 'gh',
        hostname: 'GHES.Example.COM',
        intervalSec: 120,
        streams: { issues: true, pulls: true, comments: true, ci: true },
        ignoredActors: ['Bot[bot]'],
        admission: [{ repo: 'Acme/Widgets', eventType: 'comment', senderClass: 'listed-bot', action: 'ignore' }],
      },
    })
    expect(saved.githubPoll).toMatchObject({
      enabled: true,
      repos: ['acme/widgets'],
      webhookRepos: ['acme/other'],
      hostname: 'ghes.example.com',
      intervalSec: 120,
      ignoredActors: ['bot[bot]'],
      admission: [{ repo: 'acme/widgets', eventType: 'comment', senderClass: 'listed-bot', action: 'ignore' }],
    })
    expect(parseSettings(saved).githubPoll).toEqual(saved.githubPoll)

    // Mutual exclusion across Poll and Webhook
    expect(() => patchSettings(DEFAULT_SETTINGS, {
      githubPoll: {
        enabled: true,
        repos: ['Acme/Widgets'],
        webhookRepos: ['acme/widgets'],
        ghPath: 'gh',
        intervalSec: 120,
        streams: { issues: true, pulls: true, comments: true, ci: true },
        ignoredActors: [],
      },
    })).toThrow(/invalid value/)

    // Out-of-bounds interval
    expect(() => patchSettings(DEFAULT_SETTINGS, {
      githubPoll: {
        enabled: true,
        repos: ['acme/widgets'],
        webhookRepos: [],
        ghPath: 'gh',
        intervalSec: 30,
        streams: { issues: true, pulls: true, comments: true, ci: true },
        ignoredActors: [],
      },
    })).toThrow(/invalid value/)

    expect(patchSettings(saved, { githubPoll: null }).githubPoll).toBeUndefined()
  })

  it('defaults watchdogMode to observe and validates watchdogMode and watchdogModel', () => {
    expect(DEFAULT_SETTINGS.watchdogMode).toBe('observe')
    expect(DEFAULT_SETTINGS.watchdogModel).toBeUndefined()
    expect(parseSettings({}).watchdogMode).toBe('observe')
    expect(parseSettings({ watchdogMode: 'auto' }).watchdogMode).toBe('auto')
    expect(parseSettings({ watchdogMode: 'bogus' }).watchdogMode).toBe('observe')
    expect(parseSettings({ watchdogModel: 'openai/gpt-4o' }).watchdogModel).toBe('openai/gpt-4o')
    expect(parseSettings({ watchdogModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' } }).watchdogModel).toBe('anthropic/claude-3-7-sonnet')
    expect(parseSettings({ watchdogModel: '' }).watchdogModel).toBeUndefined()
    expect(parseSettings({ watchdogModel: 'no-slash' }).watchdogModel).toBeUndefined()

    const updated = patchSettings(DEFAULT_SETTINGS, { watchdogMode: 'auto', watchdogModel: 'openai/gpt-4o' })
    expect(updated.watchdogMode).toBe('auto')
    expect(updated.watchdogModel).toBe('openai/gpt-4o')
    expect(patchSettings(updated, { watchdogModel: null }).watchdogModel).toBeUndefined()
    expect(patchSettings(updated, { watchdogModel: '' }).watchdogModel).toBeUndefined()
    expect(patchSettings(DEFAULT_SETTINGS, { watchdogModel: { provider: 'p', model: 'm' } }).watchdogModel).toBe('p/m')
    expect(() => patchSettings(DEFAULT_SETTINGS, { watchdogMode: 'strict' })).toThrow(/watchdogMode/)
    expect(() => patchSettings(DEFAULT_SETTINGS, { watchdogModel: 'missing-slash' })).toThrow(/watchdogModel/)

    const locked = patchSettings(DEFAULT_SETTINGS, { locks: { watchdogMode: true, watchdogModel: true } })
    expect(locked.locks).toEqual({ watchdogMode: true, watchdogModel: true })
  })
})
