/**
 * Client-side picture of the backend's health. Two failure shapes matter:
 * the RPC route is gone entirely (the backend is not loaded — transport 404/405),
 * and the backend answers but predates the endpoint (not-found "unknown endpoint").
 * The first is a load failure to classify in place; the second is version skew,
 * kept as shared state so one banner shows no matter how many calls hit it.
 */
import { fillText, t, type CopyLocale } from './ui-copy.ts'

export const SELF_BACKUP_KEY = 'dsh-dot:self-backup'

export interface SelfBackupRef {
  readonly dir: string
  readonly lib: string
}

let outdated = false
const listeners = new Set<() => void>()

export const backendOutdatedStore = {
  getSnapshot: () => outdated,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

/**
 * Record one failed RPC envelope. An old backend answers a new endpoint with
 * code not-found / "unknown endpoint: X" — a version skew, not a call failure.
 * The flag is state, not an event: once set it stays for the panel's lifetime.
 */
export function noteBackendError(code: string | undefined, message: string): void {
  if (outdated || code !== 'not-found' || !message.startsWith('unknown endpoint:')) return
  outdated = true
  for (const listener of listeners) listener()
}

/** Specs reset the shared flag between cases; production never clears it. */
export function resetBackendOutdated(): void {
  outdated = false
}

/** The cached self-upgrade backup, last seen through self.status. */
export function readSelfBackup(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): SelfBackupRef | undefined {
  if (!storage) return undefined
  try {
    const raw = storage.getItem(SELF_BACKUP_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as { dir?: unknown; lib?: unknown }
    return typeof parsed.dir === 'string' && typeof parsed.lib === 'string' ? { dir: parsed.dir, lib: parsed.lib } : undefined
  } catch {
    return undefined
  }
}

export function writeSelfBackup(backup: SelfBackupRef | undefined, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = safeStorage()): void {
  if (!storage) return
  try {
    if (backup) storage.setItem(SELF_BACKUP_KEY, JSON.stringify(backup))
    else storage.removeItem(SELF_BACKUP_KEY)
  } catch { /* storage can be unavailable or full; the hint is best effort */ }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** The host's transport failure when dot's backend is not loaded at all. */
const BACKEND_GONE = /transport failure for \/dsh-dot\/[^:]+: HTTP (404|405)\b/

/**
 * The text the load-failure row should show instead of the raw error, or
 * undefined when the error is not the missing-backend shape. A cached backup
 * appends the restore hint.
 */
export function backendMissingText(locale: CopyLocale, raw: string | undefined): string | undefined {
  if (raw === undefined || !BACKEND_GONE.test(raw)) return undefined
  const backup = readSelfBackup()
  const missing = t(locale, 'backendMissing')
  return backup === undefined
    ? missing
    : `${missing}\n${fillText(t(locale, 'backendMissingRestore'), { backup: backup.dir, lib: backup.lib })}`
}
