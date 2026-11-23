/** Locate dot's own installation so write work never lands in her live checkout. */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_NAME } from './auto-update.ts'
import { canonicalPath } from './work.ts'

export interface SelfInstall {
  /** Physical package root (the directory holding package.json). */
  readonly root: string
  /** 'installed' under node_modules (plugin-manager owned), 'linked' for a linked checkout. */
  readonly mode: 'linked' | 'installed'
}

export interface SelfBackup {
  readonly dir: string
  readonly lib: string
}

/** Marker persisted after a successful self-upgrade build; resolved on next start. */
export interface SelfUpgradeMarker {
  readonly at: number
  readonly commitSha: string
  readonly backupDir: string
  readonly libHash: string
}

/** Resolve dot's own package root by walking up from the running module (src or bundled lib). */
export function detectSelfInstall(from: string = import.meta.url): SelfInstall | undefined {
  let start: string
  try {
    start = from.startsWith('file:') ? fileURLToPath(from) : resolve(from)
  } catch {
    return undefined
  }
  const stat = statSync(start, { throwIfNoEntry: false })
  let cursor = stat?.isDirectory() ? start : dirname(start)
  while (true) {
    const manifest = resolve(cursor, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
        if (parsed.name === PACKAGE_NAME) {
          const root = realpathSync.native(cursor)
          const mode = root.split(/[\\/]+/).some(part => part.toLowerCase() === 'node_modules') ? 'installed' : 'linked'
          return { root, mode }
        }
      } catch {
        // An unreadable manifest says nothing about ancestry; keep walking.
      }
    }
    const parent = dirname(cursor)
    if (parent === cursor) return undefined
    cursor = parent
  }
}

/** Realpath when the entry exists, plain resolve otherwise. */
export function realpathOrResolve(dir: string): string {
  try {
    return realpathSync.native(dir)
  } catch {
    return resolve(dir)
  }
}

/** child lives at or under parent, compared through canonicalPath (case-folded on win32). */
export function insideOrEqual(parent: string, child: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** sha256 of the deployed bundle entry, undefined when it cannot be read. */
export function libHashOf(root: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(resolve(root, 'lib', 'index.js'))).digest('hex')
  } catch {
    return undefined
  }
}

/** How much of the build output a refusal or report keeps. */
const SELF_BUILD_OUTPUT_TAIL = 4_000

/** The production rebuild: `pnpm build` inside dot's own checkout, keeping only the output tail. */
export function defaultSelfBuild(root: string, signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly output: string }> {
  return new Promise(resolvePromise => {
    execFile('pnpm build', { cwd: root, shell: true, timeout: 10 * 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
      resolvePromise({ ok: error === null, output: output.length > SELF_BUILD_OUTPUT_TAIL ? `…${output.slice(-SELF_BUILD_OUTPUT_TAIL)}` : output })
    })
  })
}
