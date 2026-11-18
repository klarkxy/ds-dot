/**
 * Immutable content snapshots for a baseline or a delivery subject.
 * A saved manifest is never overwritten. Bodies are written first; a failure
 * leaves no manifest and does not delete one that already exists.
 * Directory walks skip dependency/VCS trees and record those paths plus source
 * link boundaries in `exclusions` without following them.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { lstat as lstatAsync, readFile as readFileAsync, readdir as readdirAsync, readlink as readlinkAsync, realpath as realpathAsync, stat as statAsync } from 'node:fs/promises'
import path, { dirname, join, relative, resolve } from 'node:path'
import { absoluteScopePath, canonicalPath, scopeWrites, type WriteScope } from './work.ts'

/** Maximum single-file size admitted into an in-memory snapshot buffer (64 MiB). */
export const SNAPSHOT_MAX_FILE_BYTES = 64 * 1024 * 1024
const ASYNC_READ_CONCURRENCY = 8

/**
 * Dependency, VCS, and transient build caches skipped during directory walks.
 * Explicit `type: 'file'` scopes still read the named file directly.
 */
export const SNAPSHOT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  '.venv',
  '__pycache__',
  '.turbo',
  '.next',
  '.nuxt',
  '.cache',
  '.pytest_cache',
  '.svelte-kit',
  '.parcel-cache',
  '.vite',
  '.gradle',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
])

const SNAPSHOT_IGNORED_FILES: ReadonlySet<string> = new Set([
  '.DS_Store',
])

export interface SnapshotEntry {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly deleted?: boolean
}

export interface SnapshotExclusion {
  readonly path: string
  readonly reason: string
}

export interface SnapshotManifest {
  readonly root: string
  /** True only when the collector scanned the scope and found no files. */
  readonly empty: boolean
  readonly saved: readonly SnapshotEntry[]
  readonly deleted: readonly string[]
  /**
   * Top-level skipped trees and link boundaries. Omitted on pre-exclusion
   * manifests; an empty array means the scan declared none.
   */
  readonly exclusions?: readonly SnapshotExclusion[]
}

export interface SnapshotSource {
  readonly path: string
  readonly body?: Uint8Array
  readonly deleted?: boolean
}

export interface SnapshotCapture {
  readonly root: string
  readonly empty?: boolean
  readonly exclusions?: readonly SnapshotExclusion[]
}

export interface ScopeCapture {
  readonly files: SnapshotSource[]
  readonly empty: boolean
  readonly exclusions: readonly SnapshotExclusion[]
}

export class SnapshotError extends Error {
  constructor(message: string) { super(message); this.name = 'SnapshotError' }
}

export function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

/** Save bodies first and the manifest only after every body is on disk. */
export function saveSnapshot(dir: string, files: readonly SnapshotSource[], failOn?: string, capture?: SnapshotCapture): SnapshotManifest {
  const manifestPath = join(dir, 'manifest.json')
  if (existsSync(manifestPath)) throw new SnapshotError(`snapshot ${dir} is immutable`)
  const blobs = join(dir, 'blobs')
  mkdirSync(blobs, { recursive: true })
  const saved: SnapshotEntry[] = []
  const deleted: string[] = []
  for (const file of files) {
    if (failOn && file.path === failOn) throw new SnapshotError(`SAVE_ENTRY_FAILED ${file.path}`)
    if (file.deleted) {
      deleted.push(file.path)
      continue
    }
    if (!file.body) throw new SnapshotError(`missing body for ${file.path}`)
    const hash = sha256(file.body)
    const target = join(blobs, hash)
    if (!existsSync(target)) {
      writeFileSync(target, file.body, { flag: 'wx' })
    } else if (sha256(readFileSync(target)) !== hash) {
      throw new SnapshotError(`corrupt blob ${file.path}`)
    }
    saved.push({ path: file.path, sha256: hash, bytes: file.body.byteLength })
  }
  const manifest: SnapshotManifest = {
    root: capture?.root ?? '',
    empty: capture?.empty === true,
    saved,
    deleted,
    exclusions: capture?.exclusions ?? [],
  }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return manifest
}

/** Remove all snapshots, evidence, subject records, and shared CAS blobs under `homeDir`. */
export function wipeArtifacts(homeDir: string): void {
  rmSync(join(homeDir, 'artifacts'), { recursive: true, force: true })
  rmSync(join(homeDir, 'cas-blobs'), { recursive: true, force: true })
}

/** Prune completed baseline/subject snapshot directories not present in `keepRefs`. */
export function pruneSnapshots(homeDir: string, keepRefs: ReadonlySet<string>): number {
  const root = join(homeDir, 'artifacts')
  if (!existsSync(root)) return 0
  let removed = 0
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!/^(?:base|sub)-/.test(entry.name) || keepRefs.has(entry.name)) continue
    const dir = join(root, entry.name)
    if (!existsSync(join(dir, 'manifest.json'))) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      removed += 1
    } catch { /* best-effort GC */ }
  }
  return removed
}

function resolveBlobPath(dir: string, hash: string): string {
  const local = join(dir, 'blobs', hash)
  if (existsSync(local)) return local
  // Older homes may store the body only in the sibling CAS directory.
  return join(dirname(dirname(resolve(dir))), 'cas-blobs', hash)
}

/** Read the live scope into snapshot sources. The caller saves them with {@link saveSnapshot}. */
export function captureScope(root: string, scope: string, type: 'file' | 'directory', platform: NodeJS.Platform = process.platform, maxFileBytes = SNAPSHOT_MAX_FILE_BYTES): ScopeCapture {
  const scanned = scanScope(root, scope, type, platform)
  const files: SnapshotSource[] = scanned.files.map(rel => {
    const full = join(root, ...rel.split('/'))
    const size = statSync(full).size
    if (size > maxFileBytes) {
      throw new SnapshotError(`file ${rel} exceeds snapshot size limit (${size} > ${maxFileBytes} bytes)`)
    }
    return { path: rel, body: new Uint8Array(readFileSync(full)) }
  })
  return { files, empty: scanned.files.length === 0, exclusions: scanned.exclusions }
}

/** Non-blocking async equivalent of {@link captureScope} with bounded file-read concurrency. */
export async function captureScopeAsync(root: string, scope: string, type: 'file' | 'directory', platform: NodeJS.Platform = process.platform, maxFileBytes = SNAPSHOT_MAX_FILE_BYTES): Promise<ScopeCapture> {
  const scanned = await scanScopeAsync(root, scope, type, platform)
  const files = new Array<SnapshotSource>(scanned.files.length)
  let cursor = 0
  // One failed worker stops the others at their next iteration, so a rejected
  // capture does not keep reading the scope after the caller saw the failure.
  let stop = false
  const workers = Array.from({ length: Math.min(ASYNC_READ_CONCURRENCY, scanned.files.length) }, async () => {
    while (!stop && cursor < scanned.files.length) {
      const index = cursor++
      const rel = scanned.files[index]!
      const full = join(root, ...rel.split('/'))
      const info = await statAsync(full)
      if (info.size > maxFileBytes) {
        stop = true
        throw new SnapshotError(`file ${rel} exceeds snapshot size limit (${info.size} > ${maxFileBytes} bytes)`)
      }
      files[index] = { path: rel, body: new Uint8Array(await readFileAsync(full)) }
    }
  })
  try {
    await Promise.all(workers)
  } catch (error) {
    stop = true
    throw error
  }
  return { files, empty: scanned.files.length === 0, exclusions: scanned.exclusions }
}

/**
 * Read and verify a snapshot manifest and blob presence/byte-lengths without
 * reading every blob body into memory. Use when only metadata/hashes are needed.
 */
export function readManifest(dir: string): SnapshotManifest {
  const manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
  for (const entry of manifest.saved) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new SnapshotError(`invalid blob hash ${entry.path}`)
    const target = resolveBlobPath(dir, entry.sha256)
    let size = -1
    try { size = statSync(target).size } catch { throw new SnapshotError(`missing blob ${entry.path}`) }
    if (size !== entry.bytes) throw new SnapshotError(`corrupt blob ${entry.path}`)
  }
  return manifest
}

/** Read and SHA-256 verify a single file body from a saved snapshot. */
export function readSnapshotEntry(dir: string, relPath: string, platform: NodeJS.Platform = process.platform): Uint8Array | undefined {
  const manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
  const entry = manifest.saved.find(item => sameRel(item.path, relPath, platform))
  if (!entry) return undefined
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new SnapshotError(`invalid blob hash ${entry.path}`)
  const body = readFileSync(resolveBlobPath(dir, entry.sha256))
  if (sha256(body) !== entry.sha256 || body.byteLength !== entry.bytes) throw new SnapshotError(`corrupt blob ${entry.path}`)
  return new Uint8Array(body)
}

export function readSnapshot(dir: string): { readonly manifest: SnapshotManifest; readonly bodies: ReadonlyMap<string, Uint8Array> } {
  const manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
  const bodies = new Map<string, Uint8Array>()
  for (const entry of manifest.saved) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new SnapshotError(`invalid blob hash ${entry.path}`)
    const body = readFileSync(resolveBlobPath(dir, entry.sha256))
    if (sha256(body) !== entry.sha256 || body.byteLength !== entry.bytes) throw new SnapshotError(`corrupt blob ${entry.path}`)
    bodies.set(entry.path, body)
  }
  return { manifest, bodies }
}

/**
 * A baseline covers a write scope only when its root matches and every live
 * file in that scope was saved with the same bytes. A declared cover list is
 * not evidence. An empty scope is valid only when the snapshot says it was
 * scanned empty and the directory still has no files.
 */
export function baselineCaptures(run: { readonly cwd: string; readonly workspaceRoot: string; readonly writeScope: WriteScope }, manifest: SnapshotManifest, platform: NodeJS.Platform = process.platform): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (!scopeWrites(run.writeScope)) return { ok: true }
  if (!manifest.root) return { ok: false, reason: 'snapshot has no captured root' }
  const expected = canonicalPath(run.workspaceRoot, platform)
  if (canonicalPath(manifest.root, platform) !== expected) return { ok: false, reason: `snapshot root ${manifest.root} is not ${run.workspaceRoot}` }
  const scopes = run.writeScope.kind === 'workspace-exclusive'
    ? [{ path: run.workspaceRoot, type: 'directory' as const }]
    : run.writeScope.paths
  for (const scope of scopes) {
    let absolute: string
    try {
      absolute = absoluteScope(run.workspaceRoot, scope.path, platform)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'scope could not be resolved' }
    }
    if (!pathIsInside(expected, canonicalPath(absolute, platform), platform)) return { ok: false, reason: `scope ${scope.path} is outside ${run.workspaceRoot}` }
    let live: readonly string[]
    try {
      live = scanScope(manifest.root, absolute, scope.type, platform).files
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'scope could not be read' }
    }
    for (const rel of live) {
      if (manifest.deleted.some(item => sameRel(item, rel, platform))) return { ok: false, reason: `deleted path still exists: ${rel}` }
      const saved = manifest.saved.find(item => sameRel(item.path, rel, platform))
      if (!saved) return { ok: false, reason: `omitted ${rel}` }
      const body = readFileSync(join(manifest.root, ...rel.split('/')))
      if (sha256(body) !== saved.sha256 || body.byteLength !== saved.bytes) return { ok: false, reason: `content mismatch ${rel}` }
    }
    if (live.length === 0) {
      const noted = [
        ...manifest.saved.map(item => item.path),
        ...manifest.deleted,
        ...(manifest.exclusions ?? []).map(item => item.path),
      ].some(item => scopeMentions(absolute, manifest.root, item, platform))
      if (!noted && !manifest.empty) return { ok: false, reason: `empty scope ${scope.path} has no capture evidence` }
    }
  }
  return { ok: true }
}

export function relativePath(root: string, file: string): string {
  return relative(root, file).replaceAll('\\', '/')
}

/** Slash-normalized relative path; case-folded only on Windows. */
export function foldRel(value: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = value.replaceAll('\\', '/')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function ignoredDirName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (SNAPSHOT_IGNORED_DIRS.has(name)) return true
  if (platform !== 'win32') return false
  const lower = name.toLowerCase()
  for (const item of SNAPSHOT_IGNORED_DIRS) if (item.toLowerCase() === lower) return true
  return false
}

export function ignoredFileName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (SNAPSHOT_IGNORED_FILES.has(name)) return true
  if (platform !== 'win32') return false
  const lower = name.toLowerCase()
  for (const item of SNAPSHOT_IGNORED_FILES) if (item.toLowerCase() === lower) return true
  return false
}

/**
 * First default-ignored directory prefix of `rel`, using the path's own
 * component spelling. A `type: 'file'` leaf named like a dependency dir is
 * allowed (scan captures that ordinary file); a `.git` gitfile is still
 * refused. Directory targets and any ancestor ignored directory refuse.
 */
export function defaultIgnoreCover(rel: string, platform: NodeJS.Platform = process.platform, type: 'file' | 'directory' = 'directory'): string | undefined {
  const parts = rel.replaceAll('\\', '/').split('/').filter(Boolean)
  const built: string[] = []
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!
    built.push(part)
    const last = i === parts.length - 1
    if (last && type === 'file') {
      if (foldRel(part, platform) === '.git' || ignoredFileName(part, platform)) return built.join('/')
      continue
    }
    if (ignoredDirName(part, platform)) return built.join('/')
  }
  return undefined
}

export function relUnder(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const folder = foldRel(parent, platform).replace(/\/+$/, '')
  const rel = foldRel(child, platform)
  return rel === folder || rel.startsWith(`${folder}/`)
}

export function isIgnoredDirectoryReason(reason: string): boolean {
  return reason === 'ignored directory'
}

export function isLinkReason(reason: string): boolean {
  return reason === 'symlink' || reason.startsWith('symlink:')
}

/** True when `rel` sits at or under a recorded ignored-directory tree. */
export function ignoreCovered(exclusions: readonly SnapshotExclusion[], rel: string, platform: NodeJS.Platform = process.platform): boolean {
  return exclusions.some(item => isIgnoredDirectoryReason(item.reason) && relUnder(item.path, rel, platform))
}

function isLink(target: string): boolean {
  const stat = lstatSync(target)
  if (stat.isSymbolicLink()) return true
  try {
    return canonicalPath(unwrap(realpathSync(target))) !== canonicalPath(unwrap(resolve(target)))
  } catch {
    return true
  }
}

function unwrap(value: string): string {
  return value.replace(/^\\\\\?\\/, '')
}

function linkReason(target: string): string {
  try {
    return `symlink:${readlinkSync(target, 'utf8').replaceAll('\\', '/')}`
  } catch {
    return 'symlink'
  }
}

function linkAt(target: string): boolean {
  try { return isLink(target) } catch { return true }
}

export interface ScopeScan {
  readonly files: readonly string[]
  readonly exclusions: readonly SnapshotExclusion[]
}

/**
 * Walk one explicit scope and name live files plus top-level exclusions.
 * Does not read file bodies. Child dependency/VCS trees and links are recorded
 * and not traversed. A link at the target is refused; an explicit directory is
 * walked even when its basename is ignored.
 */
export function scanScope(root: string, scope: string, type: 'file' | 'directory', platform: NodeJS.Platform = process.platform): ScopeScan {
  if (!existsSync(scope)) return { files: [], exclusions: [] }
  if (isLink(scope)) throw new SnapshotError(`refusing to follow a link at ${scope}`)
  if (type === 'file') {
    if (!lstatSync(scope).isFile()) throw new SnapshotError(`${scope} is not a file`)
    return { files: [relativePath(root, scope)], exclusions: [] }
  }
  const files: string[] = []
  const exclusions: SnapshotExclusion[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.' || entry.name === '..') continue
      const full = join(dir, entry.name)
      const rel = relativePath(root, full)
      if (entry.isSymbolicLink() || linkAt(full)) {
        exclusions.push({
          path: rel,
          reason: ignoredDirName(entry.name, platform) ? 'ignored directory' : linkReason(full),
        })
        continue
      }
      if (entry.isDirectory()) {
        if (ignoredDirName(entry.name, platform)) {
          exclusions.push({ path: rel, reason: 'ignored directory' })
          continue
        }
        walk(full)
      } else if (entry.isFile()) {
        if (ignoredFileName(entry.name, platform)) {
          exclusions.push({ path: rel, reason: 'ignored file' })
          continue
        }
        if (foldRel(entry.name, platform) === '.git') {
          exclusions.push({ path: rel, reason: 'ignored directory' })
          continue
        }
        files.push(rel)
      }
    }
  }
  walk(scope)
  return { files, exclusions }
}

async function isLinkAsync(target: string): Promise<boolean> {
  const stat = await lstatAsync(target)
  if (stat.isSymbolicLink()) return true
  try {
    return canonicalPath(unwrap(await realpathAsync(target))) !== canonicalPath(unwrap(resolve(target)))
  } catch {
    return true
  }
}

async function linkAtAsync(target: string): Promise<boolean> {
  try { return await isLinkAsync(target) } catch { return true }
}

async function linkReasonAsync(target: string): Promise<string> {
  try {
    return `symlink:${(await readlinkAsync(target, 'utf8')).replaceAll('\\', '/')}`
  } catch {
    return 'symlink'
  }
}

/** Non-blocking async directory walk matching {@link scanScope} semantics. */
export async function scanScopeAsync(root: string, scope: string, type: 'file' | 'directory', platform: NodeJS.Platform = process.platform): Promise<ScopeScan> {
  let scopeStat: Awaited<ReturnType<typeof lstatAsync>> | undefined
  try { scopeStat = await lstatAsync(scope) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], exclusions: [] }
    throw error
  }
  if (await isLinkAsync(scope)) throw new SnapshotError(`refusing to follow a link at ${scope}`)
  if (type === 'file') {
    if (!scopeStat.isFile()) throw new SnapshotError(`${scope} is not a file`)
    return { files: [relativePath(root, scope)], exclusions: [] }
  }
  const files: string[] = []
  const exclusions: SnapshotExclusion[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdirAsync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue
      const full = join(dir, entry.name)
      const rel = relativePath(root, full)
      if (entry.isSymbolicLink() || await linkAtAsync(full)) {
        exclusions.push({
          path: rel,
          reason: ignoredDirName(entry.name, platform) ? 'ignored directory' : await linkReasonAsync(full),
        })
        continue
      }
      if (entry.isDirectory()) {
        if (ignoredDirName(entry.name, platform)) {
          exclusions.push({ path: rel, reason: 'ignored directory' })
          continue
        }
        await walk(full)
      } else if (entry.isFile()) {
        if (ignoredFileName(entry.name, platform)) {
          exclusions.push({ path: rel, reason: 'ignored file' })
          continue
        }
        if (foldRel(entry.name, platform) === '.git') {
          exclusions.push({ path: rel, reason: 'ignored directory' })
          continue
        }
        files.push(rel)
      }
    }
  }
  await walk(scope)
  return { files, exclusions }
}

function absoluteScope(root: string, scope: string, platform: NodeJS.Platform): string {
  return absoluteScopePath(root, scope, platform)
}

function pathIsInside(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix
  const rel = api.relative(parent, child)
  const folded = platform === 'win32' ? rel.toLowerCase() : rel
  return folded === '' || (folded !== '..' && !folded.startsWith(`..${api.sep}`) && !folded.startsWith('../') && !api.isAbsolute(rel))
}

function sameRel(left: string, right: string, platform: NodeJS.Platform): boolean {
  const fold = (value: string) => value.replaceAll('\\', '/')
  return platform === 'win32' ? fold(left).toLowerCase() === fold(right).toLowerCase() : fold(left) === fold(right)
}

function scopeMentions(scope: string, root: string, entry: string, platform: NodeJS.Platform): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix
  const absolute = api.isAbsolute(root) ? api.resolve(root, entry) : resolve(root, entry)
  return pathIsInside(canonicalPath(scope, platform), canonicalPath(absolute, platform), platform)
}

function parseManifest(value: unknown): SnapshotManifest {
  if (!value || typeof value !== 'object') throw new SnapshotError('invalid manifest')
  const record = value as { root?: unknown; empty?: unknown; saved?: unknown; deleted?: unknown; exclusions?: unknown }
  if (!Array.isArray(record.saved) || !Array.isArray(record.deleted)) throw new SnapshotError('invalid manifest')
  const saved = record.saved.map(entry => {
    if (!entry || typeof entry !== 'object') throw new SnapshotError('invalid manifest')
    const row = entry as { path?: unknown; sha256?: unknown; bytes?: unknown }
    if (typeof row.path !== 'string' || typeof row.sha256 !== 'string' || typeof row.bytes !== 'number') throw new SnapshotError('invalid manifest')
    return { path: row.path, sha256: row.sha256, bytes: row.bytes }
  })
  if (!record.deleted.every(item => typeof item === 'string')) throw new SnapshotError('invalid manifest')
  if (record.root !== undefined && typeof record.root !== 'string') throw new SnapshotError('invalid manifest')
  if (record.empty !== undefined && typeof record.empty !== 'boolean') throw new SnapshotError('invalid manifest')
  const exclusions = parseExclusions(record.exclusions)
  return {
    root: typeof record.root === 'string' ? record.root : '',
    empty: record.empty === true,
    saved,
    deleted: record.deleted,
    ...(exclusions ? { exclusions } : {}),
  }
}

function parseExclusions(value: unknown): SnapshotExclusion[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new SnapshotError('invalid manifest')
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new SnapshotError('invalid manifest')
    const row = item as { path?: unknown; reason?: unknown }
    if (typeof row.path !== 'string' || row.path.length === 0 || typeof row.reason !== 'string' || row.reason.length === 0) {
      throw new SnapshotError('invalid manifest')
    }
    return { path: row.path, reason: row.reason }
  })
}
