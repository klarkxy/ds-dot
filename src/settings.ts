/**
 * Host-side reading and patching of dot's settings. Stored rows read field by
 * field, so one bad value falls back to its default instead of losing the rest;
 * patches from the panel are checked strictly and refused as a whole.
 */
import { z } from 'zod'
import { isTaskOnlySelector } from './capabilities.ts'
import { DEFAULT_GITHUB_POLL_SETTINGS, DEFAULT_SETTINGS, GITHUB_ADMISSION_ACTIONS, GITHUB_EVENT_TYPES, GITHUB_POLL_DEFAULT_INTERVAL_SEC, GITHUB_POLL_DEFAULT_SOURCE_ID, GITHUB_POLL_MAX_INTERVAL_SEC, GITHUB_POLL_MIN_INTERVAL_SEC, GITHUB_SENDER_CLASSES, SETTING_FIELDS, TASK_MODEL_LIST_MAX, TASK_PRESET_OPTIONS, WATCHDOG_MODES, isMcpServerHeaders, isMcpServerUrl, MCP_NEW_SERVER_NAME_PATTERN, MCP_SERVER_NAME_PATTERN, mcpServerOf, type CapabilityGroupView, type DotSettings, type GithubPollSettings, type ModelChoice, type SettingField, type TaskPermission } from './contracts.ts'
import { type CopyLocale } from './i18n/index.ts'
import { CACHE_TTL_MAX_ENTRIES, CACHE_TTL_MAX_MINUTES } from './keepalive.ts'
import { ADDRESS_MAX_CHARS, PERSONA_MAX_CHARS, defaultAddress, defaultPersona } from './persona.ts'

export const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/
export const GITHUB_POLL_MAX_REPOS = 50
export const GITHUB_POLL_MAX_ACTORS = 100
export const GITHUB_POLL_MAX_ADMISSION_RULES = 200
const GITHUB_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/

export function normalizeGithubRepo(repo: string): string {
  return repo.trim().toLowerCase()
}

function normalizeGithubRepoList(repos: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of repos) {
    const norm = normalizeGithubRepo(raw)
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

const githubAdmissionRuleSchema = z.object({
  repo: z.string().trim().min(1).max(200).transform(v => v === '*' ? '*' : normalizeGithubRepo(v)).refine(v => v === '*' || GITHUB_REPO_RE.test(v)),
  eventType: z.enum(GITHUB_EVENT_TYPES),
  senderClass: z.enum(GITHUB_SENDER_CLASSES),
  action: z.enum(GITHUB_ADMISSION_ACTIONS),
}).strict()

const githubRepoEntrySchema = z.string().trim().min(1).max(200).refine(v => GITHUB_REPO_RE.test(v)).transform(normalizeGithubRepo)

const githubPollSchema = z.object({
  enabled: z.boolean().default(false),
  repos: z.array(githubRepoEntrySchema).max(GITHUB_POLL_MAX_REPOS).default([]).transform(normalizeGithubRepoList),
  webhookRepos: z.array(githubRepoEntrySchema).max(GITHUB_POLL_MAX_REPOS).default([]).transform(normalizeGithubRepoList),
  ghPath: z.string().trim().min(1).max(500).default('gh'),
  hostname: z.string().trim().max(253).optional().transform(v => {
    const norm = v?.trim().toLowerCase()
    return norm && norm !== 'github.com' ? norm : undefined
  }).refine(v => v === undefined || GITHUB_HOST_RE.test(v)),
  intervalSec: z.number().int().min(GITHUB_POLL_MIN_INTERVAL_SEC).max(GITHUB_POLL_MAX_INTERVAL_SEC).default(GITHUB_POLL_DEFAULT_INTERVAL_SEC),
  streams: z.object({
    issues: z.boolean().default(true),
    pulls: z.boolean().default(true),
    comments: z.boolean().default(true),
    ci: z.boolean().default(true),
  }).strict().default({ issues: true, pulls: true, comments: true, ci: true }),
  ignoredActors: z.array(z.string().trim().min(1).max(100)).max(GITHUB_POLL_MAX_ACTORS).default([]).transform(list => [...new Set(list.map(v => v.trim().toLowerCase()))]),
  sourceId: z.string().trim().min(1).max(120).optional().transform(v => v || GITHUB_POLL_DEFAULT_SOURCE_ID),
  admission: z.array(githubAdmissionRuleSchema).max(GITHUB_POLL_MAX_ADMISSION_RULES).optional().default([]),
}).strict().refine(value => {
  const webhookSet = new Set(value.webhookRepos)
  return !value.repos.some(repo => webhookSet.has(repo))
}, { message: 'a repository cannot be enabled for both GitHub polling and webhook simultaneously' })

export function effectiveGithubPollSettings(settings?: Pick<DotSettings, 'githubPoll'>): GithubPollSettings {
  const raw = settings?.githubPoll
  if (!raw) return DEFAULT_GITHUB_POLL_SETTINGS
  return {
    ...DEFAULT_GITHUB_POLL_SETTINGS,
    ...raw,
    repos: normalizeGithubRepoList(raw.repos ?? []),
    webhookRepos: normalizeGithubRepoList(raw.webhookRepos ?? []),
    streams: {
      issues: raw.streams?.issues ?? true,
      pulls: raw.streams?.pulls ?? true,
      comments: raw.streams?.comments ?? true,
      ci: raw.streams?.ci ?? true,
    },
    ignoredActors: raw.ignoredActors ?? [],
    sourceId: raw.sourceId || GITHUB_POLL_DEFAULT_SOURCE_ID,
    admission: raw.admission ?? [],
  }
}

/** One stored `mcpServers` row; patches parse the record as a whole, stored reads drop bad rows. */
const MCP_SERVER_ROW = z.object({
  catalog: z.string().trim().min(1).max(100).optional(),
  url: z.string().trim().min(1).max(2000).refine(isMcpServerUrl),
  headers: z.record(z.string(), z.string().max(2000)).refine(isMcpServerHeaders).optional(),
  enabled: z.boolean(),
}).strict()

const FIELDS = {
  model: z.object({
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(200),
    reasoningEffort: z.string().trim().min(1).max(40).optional(),
  }).strict(),
  approvals: z.enum(['dot', 'human', 'deny']),
  questions: z.enum(['dot', 'human', 'off']),
  scope: z.enum(['all', 'tracked']),
  taskModels: z.object({
    mode: z.enum(['all', 'allow', 'deny']),
    list: z.array(z.string().trim().min(1).max(400)).max(TASK_MODEL_LIST_MAX),
  }).strict(),
  taskPermission: z.enum(['workspace-write', 'danger-full-access', 'safe-auto', 'auto']),
  defaultTaskPreset: z.enum(TASK_PRESET_OPTIONS),
  reflection: z.boolean(),
  autoUpdate: z.boolean(),
  idleCheckMinutes: z.number().int().min(0).max(1440),
  watchdogMode: z.enum(WATCHDOG_MODES),
  watchdogModel: z.union([
    z.string().trim().max(400).refine(v => v === '' || parseWatchdogModelChoice(v) !== undefined),
    z.object({
      provider: z.string().trim().min(1).max(200),
      model: z.string().trim().min(1).max(200),
      reasoningEffort: z.string().trim().min(1).max(40).optional(),
    }).strict(),
  ]).transform(v => typeof v === 'string' ? v : `${v.provider}/${v.model}`),
  cacheTtl: z.record(z.string().trim().min(1).max(400), z.number().int().min(0).max(CACHE_TTL_MAX_MINUTES))
    .refine(map => Object.keys(map).length <= CACHE_TTL_MAX_ENTRIES),
  persona: z.string().max(PERSONA_MAX_CHARS),
  address: z.string().trim().min(1).max(ADDRESS_MAX_CHARS),
  capabilities: z.object({
    grants: z.record(z.string().trim().min(1).max(400), z.enum(['off', 'ask', 'auto']))
      .refine(map => Object.keys(map).length <= CAPABILITY_GRANTS_MAX),
  }).strict(),
  mcpServers: z.record(
    z.string().regex(MCP_SERVER_NAME_PATTERN),
    MCP_SERVER_ROW,
  ).refine(map => Object.keys(map).length <= MCP_SERVERS_MAX),
  githubPoll: githubPollSchema,
  locks: z.object(Object.fromEntries(SETTING_FIELDS.map(field => [field, z.boolean().optional()]))).strict(),
} as const

/** Parse a canonical `provider/model` string into a ModelChoice, or undefined if empty/malformed. */
export function parseWatchdogModelChoice(value: string | undefined): ModelChoice | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 400) return undefined
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash >= trimmed.length - 1) return undefined
  const provider = trimmed.slice(0, slash).trim()
  const model = trimmed.slice(slash + 1).trim()
  if (!provider || !model || provider.length > 200 || model.length > 200) return undefined
  return { provider, model }
}

/** Selector rows the capabilities field may hold at once. */
export const CAPABILITY_GRANTS_MAX = 500

/** Dot-local MCP servers the settings field may hold at once. */
export const MCP_SERVERS_MAX = 100

/** Settings a patch may clear with null, going back to their defaults. */
const CLEARABLE = new Set<string>(['model', 'watchdogModel', 'persona', 'address', 'mcpServers', 'githubPoll'])

type Field = keyof typeof FIELDS

export class SettingsError extends Error {
  constructor(message: string) { super(message); this.name = 'SettingsError' }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export const TASK_PERMISSIONS = new Set<string>(['workspace-write', 'danger-full-access', 'safe-auto', 'auto'])

/** Stored `default` (follow host) from before that option was dropped. */
export function migrateTaskPermissionBaseline(value: unknown): unknown {
  return value === 'default' ? 'workspace-write' : value
}

/**
 * The stored settings; read field by field. A value that is not one of the
 * known presets leaves the default in place; a stored 'default' from before
 * the option was dropped migrates to 'workspace-write'.
 */
export function parseSettings(value: unknown): DotSettings {
  const row = isRecord(value) ? value : {}
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(FIELDS) as Field[]) {
    if (!(key in row)) continue
    if (key === 'locks' && isRecord(row.locks)) {
      const locks: Record<string, boolean> = {}
      for (const field of SETTING_FIELDS) {
        if (typeof row.locks[field] === 'boolean') locks[field] = row.locks[field] as boolean
      }
      out.locks = locks
      continue
    }
    if (key === 'mcpServers' && isRecord(row.mcpServers)) {
      const servers: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(row.mcpServers)) {
        if (!MCP_SERVER_NAME_PATTERN.test(name)) continue
        const parsed = MCP_SERVER_ROW.safeParse(value)
        if (parsed.success) servers[name] = parsed.data
      }
      if (Object.keys(servers).length > 0) out.mcpServers = servers
      continue
    }
    const parsed = FIELDS[key].safeParse(row[key])
    if (!parsed.success) continue
    if (key === 'watchdogModel' && parsed.data === '') continue
    out[key] = parsed.data
  }
  const permission = row.taskPermission
  if (permission === 'default') out.taskPermission = 'workspace-write'
  else if (typeof permission === 'string' && TASK_PERMISSIONS.has(permission)) out.taskPermission = permission as TaskPermission
  return out as unknown as DotSettings
}

/** Apply a patch from the settings view; null on model, watchdogModel, persona or address goes back to the default. */
export function patchSettings(current: DotSettings, patch: unknown, locale: CopyLocale = 'zh', groups?: readonly CapabilityGroupView[]): DotSettings {
  if (!isRecord(patch)) throw new SettingsError('settings patch must be an object')
  const defaults: Record<string, string> = { persona: defaultPersona(locale), address: defaultAddress(locale) }
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in FIELDS)) throw new SettingsError(`unknown setting: ${key}`)
    if (CLEARABLE.has(key) && (value === null || (key === 'watchdogModel' && typeof value === 'string' && value.trim() === ''))) { delete next[key]; continue }
    const parsed = FIELDS[key as Field].safeParse(value)
    if (!parsed.success) throw new SettingsError(`invalid value for ${key}`)
    if (key === 'mcpServers') {
      // A stored legacy name still passes through on unrelated saves, but a
      // key absent in current settings is an addition and must be strict.
      for (const name of Object.keys(parsed.data as Record<string, unknown>)) {
        if (!(name in (current.mcpServers ?? {})) && !MCP_NEW_SERVER_NAME_PATTERN.test(name)) {
          throw new SettingsError(`invalid value for ${key}`)
        }
      }
    }
    // Task-run tools (and all-task-only groups) are never granted to dot; a
    // grant row on one is a dead write. A patch carrying a stored row
    // unchanged is a carry-along, not a new grant, and deleting the row stays
    // allowed.
    if (key === 'capabilities') {
      const stored = current.capabilities?.grants ?? {}
      for (const [sel, grant] of Object.entries((parsed.data as { grants: Record<string, 'off' | 'ask' | 'auto'> }).grants)) {
        if (isTaskOnlySelector(sel, groups) && stored[sel] !== grant) {
          const name = sel.startsWith('tool:') ? sel.slice(5) : sel
          throw new SettingsError(`${name} belongs to task runs and cannot be granted to Dorothy; remove the selector instead`)
        }
      }
    }
    if (key in defaults && (parsed.data as string).trim() === defaults[key]!.trim()) { delete next[key]; continue }
    next[key] = parsed.data
  }
  // A newly added server never inherits grants a human gave to something
  // else: drop its `mcp:` selector and every `tool:` selector that resolves
  // to it under longest-prefix attribution over the resulting server set.
  const servers = (next as Partial<DotSettings>).mcpServers
  if (servers !== undefined) {
    const names = Object.keys(servers)
    const added = names.filter(name => !(name in (current.mcpServers ?? {})))
    if (added.length > 0) {
      const grants = { ...((next as Partial<DotSettings>).capabilities?.grants ?? {}) }
      let touched = false
      for (const name of added) {
        if (`mcp:${name}` in grants) { delete grants[`mcp:${name}`]; touched = true }
      }
      for (const selector of Object.keys(grants)) {
        if (!selector.startsWith('tool:')) continue
        const owner = mcpServerOf(selector.slice('tool:'.length), names)
        if (owner !== undefined && added.includes(owner)) { delete grants[selector]; touched = true }
      }
      if (touched) next.capabilities = { grants }
    }
  }
  return next as unknown as DotSettings
}

/** Dorothy can only propose unlocked fields; neither model nor panel proposals can change locks. */
export function lockedField(current: DotSettings, field: string): SettingField | undefined {
  if (!SETTING_FIELDS.some(key => key === field)) throw new SettingsError(`unknown setting: ${field}`)
  const key = field as SettingField
  if (current.locks?.[key] === true) throw new SettingsError(`${field} is locked by the human`)
  return key
}
