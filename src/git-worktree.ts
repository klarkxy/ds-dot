/**
 * Git worktrees for isolated writer tasks (phase 1). Every dot-managed
 * worktree lives under `<homeDir>/worktrees/<slug>` on a `dot/task-<slug>`
 * branch cut from the checkout's current HEAD. The human integrates the
 * delivery from the panel; nothing here touches a checkout dot did not create.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'

export const TASK_WORKTREES_DIR = 'worktrees'
export const TASK_BRANCH_PREFIX = 'dot/task-'

export class GitWorktreeError extends HarnessError {
  constructor(message: string) { super(message, 'dot/invalid') }
}

export type GitRunner = (args: readonly string[], cwd: string, opts?: { readonly timeoutMs?: number; readonly raw?: boolean }) => Promise<string>

/** `git -C <cwd> <args>` with stdout captured; non-zero exits raise a GitWorktreeError carrying stderr. Pass `raw` to keep stdout untrimmed (porcelain rows lead with a space). */
export const runGit: GitRunner = (args, cwd, opts = {}) =>
  new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout: opts.timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (typeof stderr === 'string' ? stderr : '').trim() || error.message
        reject(new GitWorktreeError(`git ${args.join(' ')} failed: ${detail}`))
        return
      }
      resolvePromise(opts.raw === true ? stdout : stdout.trim())
    })
  })

export interface TaskWorktree {
  readonly repoRoot: string
  readonly worktree: string
  /** The worktree-side counterpart of the requested dir. */
  readonly cwd: string
  readonly branch: string
  readonly baseSha: string
}

const slug = (): string => randomBytes(3).toString('hex')

/**
 * Cut a `dot/task-<slug>` worktree for `dir` off the repo's current HEAD.
 * Refuses when `dir` is not inside a git checkout or HEAD is unborn, so the
 * caller can fall back to a plain change instead of leaving half a worktree.
 */
export async function createTaskWorktree(input: { readonly dir: string; readonly homeDir: string }, git: GitRunner = runGit): Promise<TaskWorktree> {
  const dir = resolve(input.dir)
  const repoRoot = await git(['rev-parse', '--show-toplevel'], dir).catch(failure => {
    throw new GitWorktreeError(`worktree isolation needs a git checkout: ${failure instanceof Error ? failure.message : String(failure)}`)
  })
  const baseSha = await git(['rev-parse', '--verify', 'HEAD'], repoRoot).catch(() => {
    throw new GitWorktreeError('worktree isolation needs a commit to branch from (the checkout has no HEAD yet)')
  })
  const root = join(resolve(input.homeDir), TASK_WORKTREES_DIR)
  mkdirSync(root, { recursive: true })
  // Branch and directory names share one slug; a collision retries with a new one.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const name = slug()
    const branch = `${TASK_BRANCH_PREFIX}${name}`
    const worktree = join(root, name)
    try {
      await git(['worktree', 'add', '-b', branch, worktree, baseSha], repoRoot)
    } catch (failure) {
      if (attempt < 4 && /already exists/i.test(failure instanceof Error ? failure.message : '')) continue
      throw failure
    }
    const relative = repoRoot === dir ? '' : dir.slice(repoRoot.length).replace(/^[/\\]+/, '')
    return { repoRoot, worktree, cwd: relative ? join(worktree, relative) : worktree, branch, baseSha }
  }
  throw new GitWorktreeError('could not allocate a unique task worktree name')
}

/** Commit every change in the worktree; returns the new sha, or undefined when the tree was clean. */
export async function commitAll(worktree: string, message: string, git: GitRunner = runGit): Promise<string | undefined> {
  await git(['add', '-A'], worktree)
  const dirty = await git(['status', '--porcelain'], worktree)
  if (dirty === '') return undefined
  await git(['commit', '-m', message], worktree)
  return git(['rev-parse', 'HEAD'], worktree)
}

/** True when `ref` (a branch) contains commits the base does not. */
export async function hasCommitsBeyond(repoRoot: string, baseSha: string, ref: string, git: GitRunner = runGit): Promise<boolean> {
  const ahead = await git(['rev-list', '--count', `${baseSha}..${ref}`], repoRoot).catch(() => '0')
  return Number(ahead.trim() || '0') > 0
}

export interface MergeResult {
  readonly ok: boolean
  /** Conflicting paths when the merge was aborted. */
  readonly conflicts?: readonly string[]
  /** Branch the task branch merged into. */
  readonly mergedInto?: string
  readonly message?: string
}

/**
 * Merge the task branch into `repoRoot`'s current branch with --no-ff.
 * Refuses on a detached HEAD or uncommitted changes in any of `deliveredPaths`
 * (the human may have edits the delivery would overwrite). A conflict aborts
 * the merge and reports the conflicting paths.
 */
export async function mergeInto(input: { readonly repoRoot: string; readonly branch: string; readonly deliveredPaths?: readonly string[] }, git: GitRunner = runGit): Promise<MergeResult> {
  const current = await git(['branch', '--show-current'], input.repoRoot)
  if (!current) return { ok: false, message: `${input.repoRoot} is on a detached HEAD; check out a branch first` }
  const status = await git(['status', '--porcelain'], input.repoRoot, { raw: true })
  const dirty = status.split('\n').map(line => line.slice(3).trim()).filter(Boolean)
  const blocking = (input.deliveredPaths ?? []).filter(path => dirty.some(row => row === path || row.startsWith(`${path}/`)))
  if (blocking.length > 0) {
    return { ok: false, message: `uncommitted changes in the checkout overlap the delivery: ${blocking.join(', ')}` }
  }
  try {
    await git(['merge', '--no-ff', '--no-edit', input.branch], input.repoRoot)
  } catch (failure) {
    const conflicts = await git(['diff', '--name-only', '--diff-filter=U'], input.repoRoot).catch(() => '')
    await git(['merge', '--abort'], input.repoRoot).catch(() => undefined)
    return {
      ok: false,
      ...(conflicts ? { conflicts: conflicts.split('\n').filter(Boolean) } : {}),
      message: `merge of ${input.branch} conflicted and was aborted: ${failure instanceof Error ? failure.message : String(failure)}`,
    }
  }
  return { ok: true, mergedInto: current }
}

/**
 * Remove the worktree and optionally its branch. `git branch -d` refuses
 * unmerged work, so the default path can never drop delivered commits — a
 * branch that was never committed (or was already merged) deletes cleanly,
 * anything else stays for the human. `force` uses -D for explicit discards.
 */
export async function removeTaskWorktree(input: { readonly repoRoot: string; readonly worktree: string; readonly branch?: string; readonly baseSha?: string; readonly force?: boolean }, git: GitRunner = runGit): Promise<void> {
  await git(['worktree', 'remove', '--force', input.worktree], input.repoRoot).catch(() => {
    // The dir may already be gone (a removed entry is not an error worth surfacing).
    rmSync(input.worktree, { recursive: true, force: true })
    git(['worktree', 'prune'], input.repoRoot).catch(() => undefined)
  })
  if (!input.branch) return
  if (input.force) {
    await git(['branch', '-D', input.branch], input.repoRoot).catch(() => undefined)
    return
  }
  await git(['branch', '-d', input.branch], input.repoRoot).catch(() => undefined)
}

/**
 * Remove one dot-managed worktree directory during factory reset, discovering
 * its repo and branch from git itself. The `dot/task-*` branch is deleted only
 * with `branch -d`, which git refuses for unmerged work, so committed output
 * survives a reset; a worktree dot never created (its branch lacks the prefix)
 * keeps both. Returns the discovered repo root, or undefined when nothing was
 * removed.
 */
export async function removeManagedWorktreeDir(worktree: string, git: GitRunner = runGit): Promise<string | undefined> {
  let repoRoot: string | undefined
  let branch = ''
  try {
    const commonDir = await git(['rev-parse', '--git-common-dir'], worktree)
    if (commonDir) repoRoot = dirname(commonDir)
    branch = await git(['branch', '--show-current'], worktree).catch(() => '')
  } catch { repoRoot = undefined }
  if (repoRoot === undefined) {
    // Not a readable worktree (half-created row): remove the dir, nothing else.
    rmSync(worktree, { recursive: true, force: true })
    return undefined
  }
  await git(['worktree', 'remove', '--force', worktree], repoRoot).catch(() => {
    rmSync(worktree, { recursive: true, force: true })
    git(['worktree', 'prune'], repoRoot).catch(() => undefined)
  })
  if (branch.startsWith(TASK_BRANCH_PREFIX)) await git(['branch', '-d', branch], repoRoot).catch(() => undefined)
  return repoRoot
}

/** The `<homeDir>/worktrees` row this cwd belongs to, or undefined. */
export function taskWorktreeRoot(cwd: string, homeDir: string): string | undefined {
  // Stored cwds are canonicalized (lowercased on win32), so compare through the
  // same normalisation or a `C:` vs `c:` mismatch silently misses every row.
  const normalize = (value: string) => resolve(value).toLowerCase().replaceAll(sep, '/')
  const root = normalize(join(homeDir, TASK_WORKTREES_DIR))
  const absolute = normalize(cwd)
  if (absolute === root) return undefined
  const relative = absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : undefined
  if (relative === undefined) return undefined
  const first = relative.split('/')[0]
  return first ? join(resolve(homeDir), TASK_WORKTREES_DIR, first) : undefined
}

/** Directory names dot currently manages under `<homeDir>/worktrees` (for reset preview/cleanup). */
export function listTaskWorktrees(homeDir: string): readonly string[] {
  const root = join(resolve(homeDir), TASK_WORKTREES_DIR)
  try {
    return readdirSync(root, { withFileTypes: true }).filter(row => row.isDirectory()).map(row => join(root, row.name))
  } catch {
    return []
  }
}
