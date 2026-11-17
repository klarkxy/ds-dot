/**
 * Read-only workspace inspection for Dorothy. Listing stays inside one
 * workspace root; file and shell writes stay on task sessions.
 */
import type { Dirent } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const WORKSPACE_LIST_MAX = 200
export const WORKSPACE_LIST_DEPTH = 2
const SKIP = new Set(['node_modules', '.git'])

/** Strip a Windows long-path prefix so relative() compares the same volume. */
export function withoutNamespace(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`
  if (path.startsWith('\\\\?\\')) return path.slice(4)
  return path
}

export function pathInsideRoot(root: string, target: string): boolean {
  const rel = relative(withoutNamespace(resolve(root)), withoutNamespace(resolve(target)))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

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
