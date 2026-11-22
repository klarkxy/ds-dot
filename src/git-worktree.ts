/**
 * Git worktrees for isolated writer tasks (phase 1). Every dot-managed
 * worktree lives under `<homeDir>/worktrees/<slug>` on a `dot/task-<slug>`
 * branch cut from the checkout's current HEAD. The human integrates the
 * delivery from the panel; nothing here touches a checkout dot did not create.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import path, { isAbsolute, join, relative, resolve } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { canonicalPath } from './work.ts'

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
  // git reports the physical path (8.3 names expanded, symlinks resolved), so
  // both sides of the inside check go through realpath before comparing.
  const dir = realpathSync.native(resolve(input.dir))
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
    // git reports forward slashes, expanded 8.3 names and resolved symlinks,
    // so compute the in-repo subdir with path.relative on real paths instead
    // of slicing the repoRoot prefix off the raw string.
    const inside = relative(realpathSync.native(repoRoot), dir)
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || isAbsolute(inside)) {
      throw new GitWorktreeError(`${input.dir} resolves outside ${repoRoot}`)
    }
    return { repoRoot, worktree, cwd: inside ? join(worktree, inside) : worktree, branch, baseSha }
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

/** One file the accepted delivery recorded: present content (added/modified) or an expected absence (deleted). */
export interface DeliveredFile {
  readonly path: string
  readonly kind: 'added' | 'modified' | 'deleted'
  readonly sha256?: string
}

const sha256File = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Paths a `git status --porcelain -z` stream reports, including both sides of a rename. */
const porcelainPaths = (status: string): string[] => {
  const fields = status.split('\0').filter(field => field !== '')
  const paths: string[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    const name = field.slice(3)
    if (name) paths.push(name)
    if (field[0] === 'R' || field[0] === 'C' || field[1] === 'R' || field[1] === 'C') {
      index += 1
      const original = fields[index]
      if (original) paths.push(original)
    }
  }
  return paths
}

/**
 * Commit exactly the accepted delivery in the worktree — nothing a stray write
 * added afterwards. Delivered files must still match the acceptance snapshot
 * byte for byte, delivered deletions must still be absent, and git must report
 * no other modified or untracked path. Anything else refuses with
 * `worktree changed since acceptance`, leaving the tree untouched for retry.
 */
export async function commitDelivery(input: { readonly worktree: string; readonly files: readonly DeliveredFile[]; readonly message: string }, git: GitRunner = runGit): Promise<{ readonly ok: true; readonly commitSha?: string } | { readonly ok: false; readonly message: string }> {
  const worktree = input.worktree
  const touched = new Set(input.files.map(file => file.path))
  for (const file of input.files) {
    const target = join(worktree, file.path)
    if (file.kind === 'deleted') {
      if (existsSync(target)) return { ok: false, message: `worktree changed since acceptance: ${file.path} was restored` }
      continue
    }
    if (!existsSync(target)) return { ok: false, message: `worktree changed since acceptance: ${file.path} is missing` }
    if (file.sha256 !== undefined && sha256File(target) !== file.sha256) {
      return { ok: false, message: `worktree changed since acceptance: ${file.path} was edited` }
    }
  }
  // -uall lists each new file inside an untracked directory instead of just the
  // dir name, so a delivered newdir/a.txt is not read as an extra path.
  const status = await git(['status', '--porcelain', '-z', '--untracked-files=all'], worktree, { raw: true })
  const extra = porcelainPaths(status).filter(name => !touched.has(name))
  if (extra.length > 0) {
    return { ok: false, message: `worktree changed since acceptance: unexpected changes outside the delivery (${extra.join(', ')})` }
  }
  const present = input.files.filter(file => file.kind !== 'deleted').map(file => file.path)
  const deleted = input.files.filter(file => file.kind === 'deleted').map(file => file.path)
  // -f so an ignored-but-delivered file is staged; --cached --ignore-unmatch
  // stages each delivered removal without touching other index entries.
  // --literal-pathspecs keeps names like app/[id]/page.tsx exact, never globs.
  if (present.length > 0) await git(['--literal-pathspecs', 'add', '-f', '--', ...present], worktree)
  if (deleted.length > 0) await git(['--literal-pathspecs', 'rm', '-q', '--cached', '--ignore-unmatch', '--', ...deleted], worktree)
  const clean = await git(['diff', '--cached', '--quiet'], worktree).then(() => true, () => false)
  if (clean) return { ok: true }
  await git(['commit', '-m', input.message], worktree)
  return { ok: true, commitSha: await git(['rev-parse', 'HEAD'], worktree) }
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

/** The ref a `git rev-parse --verify` names, or '' when it does not exist. */
const refAt = async (repoRoot: string, ref: string, git: GitRunner): Promise<string> =>
  git(['rev-parse', '--verify', ref], repoRoot).catch(() => '')

/** An in-progress merge/cherry-pick/revert/rebase makes this checkout unsafe to touch. */
const operationInProgress = async (repoRoot: string, git: GitRunner): Promise<string | undefined> => {
  const [merge, pick, revert, rebaseMerge, rebaseApply] = await Promise.all([
    refAt(repoRoot, 'MERGE_HEAD', git),
    refAt(repoRoot, 'CHERRY_PICK_HEAD', git),
    refAt(repoRoot, 'REVERT_HEAD', git),
    git(['rev-parse', '--git-path', 'rebase-merge'], repoRoot).catch(() => ''),
    git(['rev-parse', '--git-path', 'rebase-apply'], repoRoot).catch(() => ''),
  ])
  if (merge) return 'a merge'
  if (pick) return 'a cherry-pick'
  if (revert) return 'a revert'
  if ((rebaseMerge && existsSync(resolve(repoRoot, rebaseMerge))) || (rebaseApply && existsSync(resolve(repoRoot, rebaseApply)))) return 'a rebase'
  return undefined
}

/**
 * Merge the task branch into `repoRoot`'s current branch with --no-ff.
 * Refuses on a detached HEAD, an in-progress merge/cherry-pick/rebase,
 * uncommitted changes in any of `deliveredPaths`, or an untracked file in the
 * checkout sitting on a path the delivery adds (the merge would silently
 * overwrite it). A conflict aborts only the merge this call started — the
 * human's own MERGE_HEAD is never touched.
 */
export async function mergeInto(input: { readonly repoRoot: string; readonly branch: string; readonly deliveredPaths?: readonly string[]; readonly addedPaths?: readonly string[] }, git: GitRunner = runGit): Promise<MergeResult> {
  const current = await git(['branch', '--show-current'], input.repoRoot)
  if (!current) return { ok: false, message: `${input.repoRoot} is on a detached HEAD; check out a branch first` }
  const busy = await operationInProgress(input.repoRoot, git)
  if (busy) return { ok: false, message: `${input.repoRoot} has ${busy} in progress; finish or abort it first` }
  const status = await git(['status', '--porcelain', '-z', '--untracked-files=all'], input.repoRoot, { raw: true })
  // -z keeps paths verbatim (spaces stay unquoted); a rename/copy entry is
  // `XY <new>` followed by a bare `<old>` field, which also counts as dirty.
  const dirty = porcelainPaths(status)
  const blocking = (input.deliveredPaths ?? []).filter(path => dirty.some(row => row === path || row.startsWith(`${path}/`)))
  if (blocking.length > 0) {
    return { ok: false, message: `uncommitted changes in the checkout overlap the delivery: ${blocking.join(', ')}` }
  }
  // An added delivery path landing on an existing ignored file is an overwrite
  // git performs quietly (untracked files are already dirty-blocked above); a
  // tracked file merges or conflicts and is handled below.
  const addedPaths = input.addedPaths ?? []
  const present = addedPaths.filter(path => existsSync(join(input.repoRoot, path)))
  if (present.length > 0) {
    const listed = await git(['--literal-pathspecs', 'ls-files', '-z', '--', ...present], input.repoRoot, { raw: true })
    const tracked = new Set(listed.split('\0').filter(name => name !== ''))
    const overwritten = present.filter(path => !tracked.has(path))
    if (overwritten.length > 0) {
      return { ok: false, message: `the checkout already has untracked files the delivery would overwrite: ${overwritten.join(', ')}` }
    }
  }
  try {
    await git(['merge', '--no-ff', '--no-edit', input.branch], input.repoRoot)
  } catch (failure) {
    const conflicts = await git(['diff', '--name-only', '--diff-filter=U'], input.repoRoot).catch(() => '')
    // Abort only when the failed merge is this one — MERGE_HEAD pinned to the
    // task branch tip. Another operation's state is left exactly as found.
    const head = await refAt(input.repoRoot, 'MERGE_HEAD', git)
    if (head !== '' && head === await refAt(input.repoRoot, input.branch, git)) {
      await git(['merge', '--abort'], input.repoRoot).catch(() => undefined)
    }
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
    return git(['worktree', 'prune'], input.repoRoot).then(() => undefined, () => undefined)
  })
  if (!input.branch) return
  if (input.force) {
    await git(['branch', '-D', input.branch], input.repoRoot).catch(() => undefined)
    return
  }
  await git(['branch', '-d', input.branch], input.repoRoot).catch(() => undefined)
}

/** The `<homeDir>/worktrees` row this cwd belongs to, or undefined. */
export function taskWorktreeRoot(cwd: string, homeDir: string, platform: NodeJS.Platform = process.platform): string | undefined {
  // Stored cwds are canonicalized like WorkBook paths (case-folded on win32
  // only), so compare through canonicalPath — a `C:` vs `c:` mismatch must not
  // silently miss rows, and Linux/macOS stay case-sensitive.
  const api = platform === 'win32' ? path.win32 : path.posix
  const root = api.join(api.resolve(homeDir), TASK_WORKTREES_DIR)
  const inside = api.relative(canonicalPath(root, platform), canonicalPath(cwd, platform))
  if (inside === '' || inside === '..' || inside.startsWith(`..${api.sep}`) || api.isAbsolute(inside)) return undefined
  const first = inside.split(api.sep)[0]
  return first ? api.join(root, first) : undefined
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
