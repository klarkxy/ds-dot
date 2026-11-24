/**
 * Host-side reading and patching of dot's settings. Stored rows read field by
 * field, so one bad value falls back to its default instead of losing the rest;
 * patches from the panel are checked strictly and refused as a whole.
 */
import { z } from 'zod'
import { DEFAULT_SETTINGS, SETTING_FIELDS, TASK_MODEL_LIST_MAX, isMcpServerHeaders, isMcpServerUrl, MCP_NEW_SERVER_NAME_PATTERN, MCP_SERVER_NAME_PATTERN, mcpServerOf, type DotSettings, type SettingField, type TaskPermission } from './contracts.ts'
import { type CopyLocale } from './i18n/index.ts'
import { CACHE_TTL_MAX_ENTRIES, CACHE_TTL_MAX_MINUTES } from './keepalive.ts'
import { ADDRESS_MAX_CHARS, PERSONA_MAX_CHARS, defaultAddress, defaultPersona } from './persona.ts'

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
  reflection: z.boolean(),
  autoUpdate: z.boolean(),
  idleCheckMinutes: z.number().int().min(0).max(1440),
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
  locks: z.object(Object.fromEntries(SETTING_FIELDS.map(field => [field, z.boolean().optional()]))).strict(),
} as const

/** Selector rows the capabilities field may hold at once. */
export const CAPABILITY_GRANTS_MAX = 500

/** Dot-local MCP servers the settings field may hold at once. */
export const MCP_SERVERS_MAX = 100

/** Settings a patch may clear with null, going back to their defaults. */
const CLEARABLE = new Set<string>(['model', 'persona', 'address', 'mcpServers'])

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
    out[key] = parsed.data
  }
  const permission = row.taskPermission
  if (permission === 'default') out.taskPermission = 'workspace-write'
  else if (typeof permission === 'string' && TASK_PERMISSIONS.has(permission)) out.taskPermission = permission as TaskPermission
  return out as unknown as DotSettings
}

/** Apply a patch from the settings view; null on model, persona or address goes back to the default. */
export function patchSettings(current: DotSettings, patch: unknown, locale: CopyLocale = 'zh'): DotSettings {
  if (!isRecord(patch)) throw new SettingsError('settings patch must be an object')
  const defaults: Record<string, string> = { persona: defaultPersona(locale), address: defaultAddress(locale) }
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in FIELDS)) throw new SettingsError(`unknown setting: ${key}`)
    if (CLEARABLE.has(key) && value === null) { delete next[key]; continue }
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
