/** Locate dot's own installation so write work never lands in her live checkout. */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
          let root: string
          try {
            root = realpathSync.native(cursor)
          } catch {
            // Virtual-drive / subst paths can throw; the resolved cursor is still this package.
            root = resolve(cursor)
          }
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

/**
 * Realpath of `dir`. When the leaf does not exist yet, realpath the first
 * existing ancestor and join the remaining segments so a symlink on that
 * ancestor still classifies the write target.
 */
export function realpathOrResolve(dir: string): string {
  const resolved = resolve(dir)
  try {
    return realpathSync.native(resolved)
  } catch {
    // Fall through and walk up.
  }
  const missing: string[] = []
  let cursor = resolved
  while (true) {
    const parent = dirname(cursor)
    if (parent === cursor) return resolved
    missing.unshift(basename(cursor))
    cursor = parent
    try {
      if (!existsSync(cursor)) continue
      const real = realpathSync.native(cursor)
      return missing.length === 0 ? real : join(real, ...missing)
    } catch {
      return resolved
    }
  }
}

/** child lives at or under parent, compared through canonicalPath (case-folded on win32). */
export function insideOrEqual(parent: string, child: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** sha256 of every file under `lib/`, hashed in deterministic relative-path order. */
export function libHashOf(root: string): string | undefined {
  try {
    const lib = resolve(root, 'lib')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const row of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(dir, row.name)
        if (row.isDirectory()) walk(full)
        else if (row.isFile()) files.push(full)
      }
    }
    walk(lib)
    if (files.length === 0) return undefined
    const hash = createHash('sha256')
    for (const file of files) {
      hash.update(relative(lib, file).split(sep).join('/'))
      hash.update('\0')
      hash.update(readFileSync(file))
      hash.update('\0')
    }
    return hash.digest('hex')
  } catch {
    return undefined
  }
}

/** How much of the build output a refusal or report keeps. */
const SELF_BUILD_OUTPUT_TAIL = 4_000
const SELF_BUILD_TIMEOUT_MS = 10 * 60_000
const SELF_BUILD_OUTPUT_CAP = 4 * 1024 * 1024

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolvePromise => {
    child.once('exit', () => resolvePromise())
    child.once('error', () => resolvePromise())
  })
}

/** Kill `pid` and every descendant (POSIX process group, Windows `taskkill /T`). */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise(resolvePromise => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      const done = () => resolvePromise()
      killer.once('exit', done)
      killer.once('error', done)
      return
    }
    try { process.kill(-pid, 'SIGKILL') } catch {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    resolvePromise()
  })
}

/**
 * Run `command` (via the shell) in `root`, killing the whole process tree on
 * timeout or abort and not resolving until that tree is gone.
 */
export function runSelfBuild(root: string, command: string, signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly output: string }> {
  return new Promise(resolvePromise => {
    let settled = false
    const child = spawn(command, {
      cwd: root,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let collected = ''
    const append = (chunk: Buffer | string): void => {
      collected += String(chunk)
      if (collected.length > SELF_BUILD_OUTPUT_CAP) collected = collected.slice(-SELF_BUILD_OUTPUT_CAP)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const finish = (ok: boolean, extra = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const reap = async () => {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          await killProcessTree(child.pid)
          await waitForChildExit(child)
        }
        const output = `${collected}${extra}`.trim()
        resolvePromise({ ok, output: output.length > SELF_BUILD_OUTPUT_TAIL ? `…${output.slice(-SELF_BUILD_OUTPUT_TAIL)}` : output })
      }
      void reap()
    }

    const onAbort = () => finish(false, '\nbuild aborted')
    const timer = setTimeout(() => finish(false, '\nbuild timed out'), SELF_BUILD_TIMEOUT_MS)
    if (signal) {
      if (signal.aborted) {
        finish(false, '\nbuild aborted')
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('error', error => finish(false, `\n${error instanceof Error ? error.message : String(error)}`))
    child.on('exit', (code, killSignal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const output = collected.trim()
      const ok = code === 0 && killSignal === null
      resolvePromise({ ok, output: output.length > SELF_BUILD_OUTPUT_TAIL ? `…${output.slice(-SELF_BUILD_OUTPUT_TAIL)}` : output })
    })
  })
}

/** The production rebuild: `pnpm build` inside dot's own checkout, keeping only the output tail. */
export function defaultSelfBuild(root: string, signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly output: string }> {
  return runSelfBuild(root, 'pnpm build', signal)
}
