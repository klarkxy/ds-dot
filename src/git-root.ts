/** Discover the Git common directory shared by ordinary and linked worktrees. */
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { RootHint } from './work.ts'

/** Keep relative scopes pinned to cwd while using the common directory for exclusion. */
export function detectWorkspaceRoot(cwd: string): RootHint {
  const start = resolve(cwd)
  try {
    let cursor = start
    while (true) {
      const dotGit = resolve(cursor, '.git')
      const stat = statSync(dotGit, { throwIfNoEntry: false })
      if (stat) {
        let gitDir = dotGit
        if (!stat.isDirectory()) {
          if (!stat.isFile()) throw new Error(`invalid Git marker: ${dotGit}`)
          const firstLine = readFileSync(dotGit, 'utf8').split(/\r?\n/, 1)[0]?.trim() ?? ''
          const match = /^gitdir:\s*(.+)$/i.exec(firstLine)
          if (!match?.[1]) throw new Error(`invalid Git pointer: ${dotGit}`)
          gitDir = resolve(cursor, match[1].trim())
        }
        return { workspaceRoot: start, gitCommonDir: resolveCommonFromGitDir(gitDir) }
      }
      const parent = dirname(cursor)
      if (parent === cursor) return { workspaceRoot: start }
      cursor = parent
    }
  } catch {
    // A failed read is not evidence of an independent checkout.
    return { workspaceRoot: start, uncertain: true }
  }
}

function resolveCommonFromGitDir(gitDir: string): string {
  if (!statSync(gitDir).isDirectory()) throw new Error(`invalid Git directory: ${gitDir}`)
  const commonFile = resolve(gitDir, 'commondir')
  const stat = statSync(commonFile, { throwIfNoEntry: false })
  if (!stat) return gitDir
  if (!stat.isFile()) throw new Error(`invalid Git common directory pointer: ${commonFile}`)
  const common = readFileSync(commonFile, 'utf8').trim()
  if (!common) throw new Error(`empty Git common directory pointer: ${commonFile}`)
  return isAbsolute(common) ? resolve(common) : resolve(gitDir, common)
}
