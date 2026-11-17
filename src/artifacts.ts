/**
 * Immutable content snapshots for a baseline or a delivery subject.
 * A saved manifest is never overwritten. Bodies are written first; a failure
 * leaves no manifest and does not delete one that already exists.
 * Directory walks skip dependency/VCS trees and record those paths plus source
 * link boundaries in `exclusions` without following them. Restore still refuses
 * to follow a symlink or junction out of the target root.
 */
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path, { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { absoluteScopePath, canonicalPath, scopeWrites, type WriteScope } from './work.ts'

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

/**
 * Sibling CAS directory (`<home>/cas-blobs`) used when `dir` lives under `<home>/artifacts/<id>`.
 * Kept outside `artifacts/` so directory listings of `artifacts/` only see snapshot ids.
 */
function sharedCasDir(dir: string): string | undefined {
  const parent = dirname(resolve(dir))
  if (basename(parent) !== 'artifacts') return undefined
  return join(dirname(parent), 'cas-blobs')
}

/**
 * Store one content-addressed body for a snapshot, reusing the shared CAS copy.
 * Copies are block clones when the filesystem supports them and plain copies
 * otherwise — never hard links. A snapshot's blobs must stay independent files:
 * a hard link would share its inode with the CAS and with every other snapshot,
 * so one in-place write could corrupt snapshots that still claim to be immutable.
 */
function writeBlobWithCas(blobsDir: string, casDir: string | undefined, hash: string, body: Uint8Array): void {
  const target = join(blobsDir, hash)
  if (existsSync(target)) return
  if (!casDir) {
    writeFileSync(target, body)
    return
  }
  mkdirSync(casDir, { recursive: true })
  const casBlob = join(casDir, hash)
  if (!existsSync(casBlob)) {
    const temp = `${casBlob}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(temp, body)
    try {
      renameSync(temp, casBlob)
    } catch {
      // Another writer landed the same content-addressed body first; its bytes are identical.
    } finally {
      rmSync(temp, { force: true })
    }
  }
  try {
    copyFileSync(casBlob, target, constants.COPYFILE_FICLONE)
  } catch {
    try { copyFileSync(casBlob, target) } catch { writeFileSync(target, body) }
  }
}

/** Save bodies first and the manifest only after every body is on disk. */
export function saveSnapshot(dir: string, files: readonly SnapshotSource[], failOn?: string, capture?: SnapshotCapture): SnapshotManifest {
  const manifestPath = join(dir, 'manifest.json')
  if (existsSync(manifestPath)) throw new SnapshotError(`snapshot ${dir} is immutable`)
  const blobs = join(dir, 'blobs')
  mkdirSync(blobs, { recursive: true })
  const casDir = sharedCasDir(dir)
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
    writeBlobWithCas(blobs, casDir, hash, file.body)
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

/** Read the live scope into snapshot sources. The caller saves them with {@link saveSnapshot}. */
export function captureScope(root: string, scope: string, type: 'file' | 'directory', platform: NodeJS.Platform = process.platform): ScopeCapture {
  const scanned = scanScope(root, scope, type, platform)
  const files: SnapshotSource[] = scanned.files.map(rel => ({
    path: rel,
    body: new Uint8Array(readFileSync(join(root, ...rel.split('/')))),
  }))
  return { files, empty: scanned.files.length === 0, exclusions: scanned.exclusions }
}

export function readSnapshot(dir: string): { readonly manifest: SnapshotManifest; readonly bodies: ReadonlyMap<string, Uint8Array> } {
  const manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
  const bodies = new Map<string, Uint8Array>()
  for (const entry of manifest.saved) {
    const body = readFileSync(join(dir, 'blobs', entry.sha256))
    if (sha256(body) !== entry.sha256 || body.byteLength !== entry.bytes) throw new SnapshotError(`corrupt blob ${entry.path}`)
    bodies.set(entry.path, body)
  }
  return { manifest, bodies }
}

/** Restore saved bytes and remove paths recorded as deleted. Does not touch other files. */
export function restoreSnapshot(dir: string, root: string): SnapshotManifest {
  mkdirSync(root, { recursive: true })
  const { manifest, bodies } = readSnapshot(dir)
  const writes = manifest.saved.map(entry => ({ entry, target: containedTarget(root, entry.path) }))
  const deletions = manifest.deleted.map(name => containedTarget(root, name))
  for (const { entry, target } of writes) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bodies.get(entry.path)!)
  }
  for (const target of deletions) rmSync(target, { force: true })
  return manifest
}

export function filesMatch(dir: string, root: string): boolean {
  const { manifest, bodies } = readSnapshot(dir)
  try {
    for (const entry of manifest.saved) {
      const target = containedTarget(root, entry.path)
      if (!existsSync(target)) return false
      const body = readFileSync(target)
      if (sha256(body) !== entry.sha256) return false
    }
    for (const name of manifest.deleted) if (existsSync(containedTarget(root, name))) return false
  } catch (error) {
    if (error instanceof SnapshotError) return false
    throw error
  }
  return bodies.size === manifest.saved.length
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

/** Lexical path of `entry` when it stays strictly inside `root`. */
export function insideRoot(root: string, entry: string): string {
  if (!entry || entry.includes('\0')) throw new SnapshotError('path escapes snapshot root')
  const base = resolve(root)
  const full = resolve(base, entry)
  const rel = relative(base, full)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sepOf(rel)}`) || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
    throw new SnapshotError(`path escapes snapshot root: ${entry}`)
  }
  return full
}

/**
 * Same as {@link insideRoot}, then refuses an existing symlink, junction, or
 * any ancestor whose real path leaves the target root. Missing tail components
 * are not created here.
 */
export function containedTarget(root: string, entry: string): string {
  const lexical = insideRoot(root, entry)
  const base = resolve(root)
  let rootReal: string
  try {
    rootReal = realpathSync(base)
  } catch (error) {
    throw new SnapshotError(`snapshot root is not available: ${messageOf(error)}`)
  }
  if (isLink(base)) throw new SnapshotError('refusing to follow a link at the snapshot root')
  let cursor = base
  for (const part of relative(base, lexical).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) return lexical
    if (isLink(cursor)) throw new SnapshotError(`refusing to follow a link at ${entry}`)
    let real: string
    try {
      real = realpathSync(cursor)
    } catch (error) {
      throw new SnapshotError(`path cannot be resolved: ${messageOf(error)}`)
    }
    if (!pathIsInside(canonicalPath(rootReal), canonicalPath(real), process.platform)) throw new SnapshotError(`path escapes snapshot root: ${entry}`)
  }
  return lexical
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

function sepOf(value: string): string {
  return value.includes('\\') ? '\\' : '/'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown'
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
