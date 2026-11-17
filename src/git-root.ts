/**
 * Pure filesystem Git root and worktree common-dir discovery.
 * Avoids spawning git subprocesses while letting linked Git worktrees share one
 * mutual-exclusion root (`exclusiveRoot`) when a whole-workspace lock is taken.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { RootHint } from './work.ts'

/**
 * Locate the enclosing `.git` directory or worktree `commondir` for `cwd`.
 * `workspaceRoot` stays pinned to `cwd` so relative run paths continue to
 * resolve against the Change directory, while `gitCommonDir` identifies any
 * shared repository backing multiple worktrees or subdirectories.
 */
export function detectWorkspaceRoot(cwd: string): RootHint {
  const start = resolve(cwd)
  let cursor = start
  for (let depth = 0; depth < 32; depth += 1) {
    const dotGit = resolve(cursor, '.git')
    if (existsSync(dotGit)) {
      const common = resolveGitCommonDir(cursor, dotGit)
      return common ? { workspaceRoot: start, gitCommonDir: common } : { workspaceRoot: start }
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return { workspaceRoot: start }
}

function resolveGitCommonDir(checkoutDir: string, dotGit: string): string | undefined {
  try {
    const stat = statSync(dotGit)
    if (stat.isDirectory()) return resolveCommonFromGitDir(dotGit)
    if (!stat.isFile()) return undefined
    const firstLine = readFileSync(dotGit, 'utf8').split(/\r?\n/, 1)[0]?.trim() ?? ''
    const match = /^gitdir:\s*(.+)$/i.exec(firstLine)
    if (!match?.[1]) return undefined
    const rawGitDir = match[1].trim()
    const gitDir = isAbsolute(rawGitDir) ? resolve(rawGitDir) : resolve(checkoutDir, rawGitDir)
    return resolveCommonFromGitDir(gitDir)
  } catch {
    return undefined
  }
}

function resolveCommonFromGitDir(gitDir: string): string | undefined {
  const commonFile = resolve(gitDir, 'commondir')
  try {
    if (existsSync(commonFile) && statSync(commonFile).isFile()) {
      const rel = readFileSync(commonFile, 'utf8').trim()
      if (rel) return isAbsolute(rel) ? resolve(rel) : resolve(gitDir, rel)
    }
  } catch {
    // Fall back to gitDir when commondir cannot be read.
  }
  return gitDir
}
