import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TASK_BRANCH_PREFIX, TASK_WORKTREES_DIR, commitAll, createTaskWorktree, hasCommitsBeyond, listTaskWorktrees,
  mergeInto, removeManagedWorktreeDir, removeTaskWorktree, runGit, taskWorktreeRoot,
} from './git-worktree.ts'

let gitAvailable = true
try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { gitAvailable = false }

function makeRepo(): { repo: string; home: string; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), 'dot-wt-repo-'))
  const home = mkdtempSync(join(tmpdir(), 'dot-wt-home-'))
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'dot@spec.local'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'dot spec'], { stdio: 'ignore' })
  writeFileSync(join(repo, 'a.txt'), 'base')
  mkdirSync(join(repo, 'sub'))
  writeFileSync(join(repo, 'sub', 'b.txt'), 'sub')
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'ignore' })
  return { repo, home, cleanup: () => { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) } }
}

describe.skipIf(!gitAvailable)('git worktrees (real git)', () => {
  it('creates a worktree from the repo root with a dot/task-* branch', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      expect(created.repoRoot.replace(/\\/g, '/')).toBe(repo.replace(/\\/g, '/'))
      expect(created.branch).toMatch(new RegExp(`^${TASK_BRANCH_PREFIX.replace('/', '\\/')}`))
      expect(created.cwd).toBe(created.worktree)
      expect(created.baseSha).toBe(await runGit(['rev-parse', 'HEAD'], repo))
      expect(existsSync(join(created.worktree, 'a.txt'))).toBe(true)
      expect(listTaskWorktrees(home)).toEqual([join(home, TASK_WORKTREES_DIR, created.branch.slice(TASK_BRANCH_PREFIX.length))])
      expect(await runGit(['branch', '--show-current'], created.worktree)).toBe(created.branch)
    } finally { cleanup() }
  })

  it('maps a subdirectory cwd into the worktree', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const created = await createTaskWorktree({ dir: join(repo, 'sub'), homeDir: home })
      expect(created.cwd).toBe(join(created.worktree, 'sub'))
      expect(existsSync(join(created.cwd, 'b.txt'))).toBe(true)
    } finally { cleanup() }
  })

  it('refuses a directory outside git and an unborn HEAD', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dot-wt-home-'))
    const plain = mkdtempSync(join(tmpdir(), 'dot-wt-plain-'))
    const unborn = mkdtempSync(join(tmpdir(), 'dot-wt-unborn-'))
    try {
      execFileSync('git', ['init'], { cwd: unborn, stdio: 'ignore' })
      await expect(createTaskWorktree({ dir: plain, homeDir: home })).rejects.toThrow(/git checkout/)
      await expect(createTaskWorktree({ dir: unborn, homeDir: home })).rejects.toThrow(/no HEAD/)
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); rmSync(unborn, { recursive: true, force: true }) }
  })

  it('commits work, merges it, and reports a clean result', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      writeFileSync(join(created.worktree, 'made.txt'), 'made')
      const sha = await commitAll(created.worktree, 'task commit')
      expect(sha).toBeTruthy()
      expect(await hasCommitsBeyond(repo, created.baseSha, created.branch)).toBe(true)
      const merged = await mergeInto({ repoRoot: repo, branch: created.branch })
      expect(merged).toMatchObject({ ok: true, mergedInto: 'main' })
      expect(readFileSync(join(repo, 'made.txt'), 'utf-8')).toBe('made')
      await removeTaskWorktree({ repoRoot: repo, worktree: created.worktree, branch: created.branch, baseSha: created.baseSha })
      expect(existsSync(created.worktree)).toBe(false)
      // The merged branch delets cleanly with -d.
      expect(await runGit(['branch', '--list', created.branch], repo)).toBe('')
    } finally { cleanup() }
  })

  it('commitAll returns undefined when the tree is clean', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      expect(await commitAll(created.worktree, 'nothing')).toBeUndefined()
    } finally { cleanup() }
  })

  it('aborts a conflicting merge and reports the conflicting files', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      writeFileSync(join(created.worktree, 'a.txt'), 'task side')
      await commitAll(created.worktree, 'task commit')
      writeFileSync(join(repo, 'a.txt'), 'checkout side')
      await runGit(['add', 'a.txt'], repo)
      await runGit(['commit', '-m', 'checkout side'], repo)
      const merged = await mergeInto({ repoRoot: repo, branch: created.branch })
      expect(merged.ok).toBe(false)
      expect(merged.conflicts).toEqual(['a.txt'])
      expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('checkout side')
      expect(await runGit(['status', '--porcelain'], repo)).toBe('')
    } finally { cleanup() }
  })

  it('refuses a merge when delivered paths are dirty in the checkout', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      writeFileSync(join(created.worktree, 'a.txt'), 'task side')
      await commitAll(created.worktree, 'task commit')
      writeFileSync(join(repo, 'a.txt'), 'unsaved edit')
      const merged = await mergeInto({ repoRoot: repo, branch: created.branch, deliveredPaths: ['a.txt'] })
      expect(merged.ok).toBe(false)
      expect(merged.message).toMatch(/uncommitted changes.*a\.txt/)
      expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('unsaved edit')
    } finally { cleanup() }
  })

  it('merges anyway when the dirty file is outside the delivery', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      writeFileSync(join(created.worktree, 'made.txt'), 'made')
      await commitAll(created.worktree, 'task commit')
      writeFileSync(join(repo, 'unrelated.txt'), 'unsaved')
      const merged = await mergeInto({ repoRoot: repo, branch: created.branch, deliveredPaths: ['made.txt'] })
      expect(merged.ok).toBe(true)
    } finally { cleanup() }
  })

  it('removeTaskWorktree keeps a branch with commits, deletes one without', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const withWork = await createTaskWorktree({ dir: repo, homeDir: home })
      writeFileSync(join(withWork.worktree, 'made.txt'), 'made')
      await commitAll(withWork.worktree, 'task commit')
      await removeTaskWorktree({ repoRoot: repo, worktree: withWork.worktree, branch: withWork.branch, baseSha: withWork.baseSha })
      expect(await runGit(['branch', '--list', withWork.branch], repo)).toBe(withWork.branch)

      const empty = await createTaskWorktree({ dir: repo, homeDir: home })
      await removeTaskWorktree({ repoRoot: repo, worktree: empty.worktree, branch: empty.branch, baseSha: empty.baseSha })
      expect(await runGit(['branch', '--list', empty.branch], repo)).toBe('')

      const forced = await createTaskWorktree({ dir: repo, homeDir: home })
      writeFileSync(join(forced.worktree, 'made.txt'), 'made')
      await commitAll(forced.worktree, 'task commit')
      await removeTaskWorktree({ repoRoot: repo, worktree: forced.worktree, branch: forced.branch, force: true })
      expect(await runGit(['branch', '--list', forced.branch], repo)).toBe('')
    } finally { cleanup() }
  })

  it('removeManagedWorktreeDir discovers the repo and drops the branch', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      const root = await removeManagedWorktreeDir(created.worktree)
      expect(root?.replace(/\\/g, '/')).toBe(repo.replace(/\\/g, '/'))
      expect(existsSync(created.worktree)).toBe(false)
      expect(await runGit(['branch', '--list', created.branch], repo)).toBe('')
    } finally { cleanup() }
  })
})

describe('taskWorktreeRoot', () => {
  it('maps a managed cwd to its worktree row and ignores others', () => {
    const home = join(tmpdir(), 'dot-wt-root-home')
    expect(taskWorktreeRoot(join(home, 'worktrees', 'abc123', 'sub', 'dir'), home)).toBe(join(home, 'worktrees', 'abc123'))
    expect(taskWorktreeRoot(join(home, 'worktrees', 'abc123'), home)).toBe(join(home, 'worktrees', 'abc123'))
    expect(taskWorktreeRoot(join(home, 'worktrees'), home)).toBeUndefined()
    expect(taskWorktreeRoot(join(home, 'other', 'abc123'), home)).toBeUndefined()
    expect(taskWorktreeRoot('C:\\somewhere\\else', home)).toBeUndefined()
  })
})
