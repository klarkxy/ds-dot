/**
 * Shared channel between the `ds-dot/mcp` preset row (mounted inside dot's
 * preset scope) and the main plugin module (service, capabilities, RPC). Both
 * bundle entries load their own module instance, so the registry lives on
 * globalThis keyed by `Symbol.for` — the same trick attribution.ts uses.
 */
import type { CapabilityMcpStatus, DotSettings } from './contracts.ts'

const SHARED_KEY = Symbol.for('ds-dot/mcp')

export interface DotMcpShared {
  /** Set by index.ts: live settings for the row's reconcile loop. */
  settings?: () => DotSettings
  /** Set by the row: invoked when settings change so mounts can reconcile. */
  onSettingsChanged?: () => void
  /** Set by service.ts: invoked (debounced by the row) when the preset-scope
   *  MCP tool-name set changed, so the live agent's restrict re-applies. */
  onToolsChanged?: () => void
  /** Set by index.ts: sorted names of the preset-scope tools attributed to
   *  dot-local servers; part of the row's change signature. */
  presetToolNames?: () => Promise<readonly string[]>
  /** Per-server status published by the row; read by catalog and mcp.list. */
  readonly servers: Map<string, CapabilityMcpStatus>
}

export function sharedDotMcp(): DotMcpShared {
  const world = globalThis as Record<symbol, DotMcpShared | undefined>
  return (world[SHARED_KEY] ??= { servers: new Map() })
}
