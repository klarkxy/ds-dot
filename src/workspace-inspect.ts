/**
 * Read-only workspace inspection for Dorothy. Listing stays inside one
 * workspace root; file and shell writes stay on task sessions.
 */
import { constants, type Dirent } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { credentialLikePath } from './approval-risk.ts'
import { pathInsideRoot, withoutNamespace } from './path-inspect.ts'
import { dotReadRefusal } from './read-guard.ts'

export { pathInsideRoot, withoutNamespace } from './path-inspect.ts'

export const WORKSPACE_LIST_MAX = 200
export const WORKSPACE_LIST_DEPTH = 2
const SKIP = new Set(['node_modules', '.git'])

export interface WorkspaceFileRow {
  readonly path: string
  readonly type: 'file' | 'directory'
}

export async function listWorkspaceFiles(root: string, relPath = '.', depth = WORKSPACE_LIST_DEPTH, max = WORKSPACE_LIST_MAX): Promise<readonly WorkspaceFileRow[]> {
  const base = resolve(root)
  const start = resolve(base, relPath)
  if (!pathInsideRoot(base, start)) throw new Error('path is outside the workspace')
  const realBase = withoutNamespace(await realpath(base))
  let realStart: string
  try { realStart = withoutNamespace(await realpath(start)) } catch (error) {
    throw new Error(`cannot read ${displayPath(base, start)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!pathInsideRoot(realBase, realStart)) throw new Error('path is outside the workspace')
  const rows: WorkspaceFileRow[] = []
  await walk(base, realBase, start, Math.max(0, depth), max, rows)
  return rows
}

async function walk(base: string, realBase: string, dir: string, depth: number, max: number, rows: WorkspaceFileRow[]): Promise<void> {
  if (rows.length >= max || depth < 0) return
  let entries: Dirent[]
  try { entries = await readdir(dir, { encoding: 'utf8', withFileTypes: true }) } catch (error) {
    throw new Error(`cannot read ${displayPath(base, dir)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of sorted) {
    if (rows.length >= max) return
    if (SKIP.has(entry.name) || entry.name === '.' || entry.name === '..') continue
    const full = resolve(dir, entry.name)
    if (!pathInsideRoot(base, full)) continue
    let realFull: string
    try { realFull = withoutNamespace(await realpath(full)) } catch { continue }
    if (!pathInsideRoot(realBase, realFull)) continue
    const isDir = entry.isDirectory()
    rows.push({ path: displayPath(base, full), type: isDir ? 'directory' : 'file' })
    if (isDir && depth > 0) await walk(base, realBase, full, depth - 1, max, rows)
  }
}

function displayPath(base: string, full: string): string {
  const rel = relative(base, full)
  return rel === '' ? '.' : rel.split(sep).join('/')
}

export function formatWorkspaceFiles(rows: readonly WorkspaceFileRow[], truncated: boolean): string {
  if (rows.length === 0) return 'No files in this path.'
  const lines = rows.map(row => `- ${row.type === 'directory' ? `${row.path}/` : row.path}`)
  if (truncated) lines.push(`(truncated at ${rows.length} entries)`)
  return lines.join('\n')
}

export const WORKSPACE_READ_DEFAULT_LINES = 400
export const WORKSPACE_READ_MAX_LINES = 2000
const WORKSPACE_READ_MAX_BYTES = 2 * 1024 * 1024
const NUL_SCAN_BYTES = 8 * 1024

export interface WorkspaceRead {
  /** Resolved real path of the file that was read. */
  readonly path: string
  readonly totalLines: number
  readonly start: number
  readonly end: number
  /** More lines exist after `end`. */
  readonly truncated: boolean
  readonly lines: readonly string[]
}

/**
 * Read a text file inside one of the authorized roots. Relative targets resolve
 * under `baseDir` and must stay inside it; absolute targets must land inside a
 * registered workspace, a change directory, Dorothy's home, chat attachments,
 * or Office outputs. Credential-like paths, binary files, and large files
 * remain refused, and the opened file is checked against the realpath that
 * passed those checks.
 */
export async function readWorkspaceText(
  authorizedRoots: readonly string[],
  baseDir: string | undefined,
  target: string,
  options?: { readonly startLine?: number; readonly maxLines?: number },
): Promise<WorkspaceRead> {
  const trimmed = target.trim()
  if (!trimmed) throw new Error('read requires a path')
  const startLine = options?.startLine ?? 1
  const maxLines = options?.maxLines ?? WORKSPACE_READ_DEFAULT_LINES
  if (!Number.isInteger(startLine) || startLine < 1) throw new Error('start_line must be a positive integer')
  const limit = Math.min(Math.max(1, Math.floor(maxLines)), WORKSPACE_READ_MAX_LINES)
  const refusal = dotReadRefusal(trimmed, { bases: baseDir ? [baseDir] : [], roots: authorizedRoots })
  if (refusal) throw new Error(refusal)
  const absolute = isAbsolute(trimmed)
  if (!absolute && !baseDir) throw new Error('no workspace applies to a relative path')
  const raw = absolute ? resolve(trimmed) : resolve(baseDir!, trimmed)
  let real: string
  try { real = withoutNamespace(await realpath(raw)) } catch (error) {
    throw new Error(`cannot read ${trimmed}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!absolute) {
    const realBase = withoutNamespace(await realpath(baseDir!))
    if (!pathInsideRoot(realBase, real)) throw new Error(`${trimmed} is outside the workspace`)
  }
  if (credentialLikePath(trimmed) || credentialLikePath(real)) throw new Error(`${trimmed} looks like a credential file and will not be read`)
  const info = await stat(real)
  if (info.isDirectory()) throw new Error(`${trimmed} is a directory; use action=files to list it`)
  if (!info.isFile()) throw new Error(`${trimmed} is not a regular file`)
  if (info.size > WORKSPACE_READ_MAX_BYTES) throw new Error(`${trimmed} is ${info.size} bytes; files over 2 MiB are not read`)
  // O_NOFOLLOW keeps a symlink swapped in after realpath() from redirecting the
  // open; comparing the opened handle's dev/ino catches any other swap — the
  // read is refused rather than serving a different file than the one checked.
  const flags = constants.O_NOFOLLOW === undefined ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW
  const handle = await open(real, flags)
  let body: string
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`${trimmed} changed while it was being opened; try again`)
    const head = Buffer.alloc(Math.min(info.size, NUL_SCAN_BYTES))
    await handle.read(head, 0, head.length, 0)
    if (head.includes(0)) throw new Error(`${trimmed} is a binary file`)
    body = (await handle.readFile('utf8')).toString()
  } finally { await handle.close() }
  const all = body.split('\n')
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  const lines = all.map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
  const start = Math.min(startLine, Math.max(1, lines.length))
  const shown = lines.slice(start - 1, start - 1 + limit)
  const end = start - 1 + shown.length
  return { path: real, totalLines: lines.length, start, end, truncated: end < lines.length, lines: shown }
}
