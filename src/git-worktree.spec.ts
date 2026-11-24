import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256 } from './artifacts.ts'
import {
  TASK_BRANCH_PREFIX, TASK_WORKTREES_DIR, commitAll, commitDelivery, createTaskWorktree, GitWorktreeError, hasCommitsBeyond, listTaskWorktrees,
  mergeInto, removeTaskWorktree, runGit, taskWorktreeRoot, type GitRunner,
} from './git-worktree.ts'

let gitAvailable = true
try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { gitAvailable = false }

function makeRepo(): { repo: string; home: string; cleanup: () => void } {
  // git reports the long physical path; resolve 8.3 short names (Windows CI) up front.
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'dot-wt-repo-')))
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

describe.skipIf(!gitAvailable)('git worktrees (real git)', { timeout: 30_000 }, () => {
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

  it('refuses a merge over a dirty path with spaces or a rename', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      writeFileSync(join(created.worktree, 'a.txt'), 'task side')
      await commitAll(created.worktree, 'task commit')
      execFileSync('git', ['-C', repo, 'mv', 'a.txt', 'a renamed.txt'], { stdio: 'ignore' })
      let merged = await mergeInto({ repoRoot: repo, branch: created.branch, deliveredPaths: ['a.txt'] })
      expect(merged.ok).toBe(false)
      expect(merged.message).toMatch(/uncommitted changes.*a\.txt/)
      merged = await mergeInto({ repoRoot: repo, branch: created.branch, deliveredPaths: ['a renamed.txt'] })
      expect(merged.ok).toBe(false)
      expect(merged.message).toMatch(/uncommitted changes.*a renamed\.txt/)
      execFileSync('git', ['-C', repo, 'reset', '--hard', 'HEAD'], { stdio: 'ignore' })
      writeFileSync(join(repo, 'new file.txt'), 'unsaved')
      merged = await mergeInto({ repoRoot: repo, branch: created.branch, deliveredPaths: ['new file.txt'] })
      expect(merged.ok).toBe(false)
      expect(merged.message).toMatch(/uncommitted changes.*new file\.txt/)
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

  it('commitDelivery commits exactly the delivery, even an ignored file', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      // A .gitignore that hides the delivered file: -f staging still commits it.
      writeFileSync(join(repo, '.gitignore'), 'made.log\n')
      await runGit(['add', '-A'], repo)
      await runGit(['commit', '-m', 'ignore log files'], repo)
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      writeFileSync(join(created.worktree, 'made.log'), 'made')
      const files = [{ path: 'made.log', kind: 'added' as const, sha256: sha256(new TextEncoder().encode('made')) }]
      const committed = await commitDelivery({ worktree: created.worktree, files, message: 'deliver' })
      expect(committed).toMatchObject({ ok: true })
      expect(await runGit(['ls-tree', '-r', '--name-only', created.branch], repo)).toContain('made.log')
      // Nothing left to commit: a second call reports a clean tree, no sha.
      expect(await commitDelivery({ worktree: created.worktree, files, message: 'deliver' })).toEqual({ ok: true })
    } finally { cleanup() }
  })

  it('commitDelivery refuses edits, missing delivered files and anything extra', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      const files = [
        { path: 'made.txt', kind: 'added' as const, sha256: sha256(new TextEncoder().encode('made')) },
        { path: 'gone.txt', kind: 'deleted' as const },
      ]
      // The delivered file itself must match the acceptance bytes.
      writeFileSync(join(created.worktree, 'made.txt'), 'made')
      writeFileSync(join(created.worktree, 'stray.txt'), 'not delivered')
      let result = await commitDelivery({ worktree: created.worktree, files, message: 'deliver' })
      expect(result).toMatchObject({ ok: false })
      expect(result.ok ? '' : result.message).toMatch(/changed since acceptance.*stray\.txt/)
      rmSync(join(created.worktree, 'stray.txt'))
      // A restored deleted file refuses too.
      writeFileSync(join(created.worktree, 'gone.txt'), 'back')
      result = await commitDelivery({ worktree: created.worktree, files, message: 'deliver' })
      expect(result.ok ? '' : result.message).toMatch(/changed since acceptance.*gone\.txt/)
      rmSync(join(created.worktree, 'gone.txt'))
      writeFileSync(join(created.worktree, 'made.txt'), 'edited later')
      result = await commitDelivery({ worktree: created.worktree, files, message: 'deliver' })
      expect(result.ok ? '' : result.message).toMatch(/changed since acceptance.*made\.txt/)
      // Restoring the exact bytes unblocks the commit.
      writeFileSync(join(created.worktree, 'made.txt'), 'made')
      result = await commitDelivery({ worktree: created.worktree, files, message: 'deliver' })
      expect(result).toMatchObject({ ok: true })
    } finally { cleanup() }
  })

  it('commitDelivery handles [id] pathspecs and files inside new directories', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      mkdirSync(join(repo, 'app', 'i'), { recursive: true })
      writeFileSync(join(repo, 'app', 'i', 'page.tsx'), 'look-alike')
      await runGit(['add', '-A'], repo)
      await runGit(['commit', '-m', 'look-alike page'], repo)
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      mkdirSync(join(created.worktree, 'app', '[id]'), { recursive: true })
      writeFileSync(join(created.worktree, 'app', '[id]', 'page.tsx'), 'made')
      mkdirSync(join(created.worktree, 'newdir'), { recursive: true })
      writeFileSync(join(created.worktree, 'newdir', 'a.txt'), 'inside new dir')
      const files = [
        { path: 'app/[id]/page.tsx', kind: 'added' as const, sha256: sha256(new TextEncoder().encode('made')) },
        { path: 'newdir/a.txt', kind: 'added' as const, sha256: sha256(new TextEncoder().encode('inside new dir')) },
      ]
      const committed = await commitDelivery({ worktree: created.worktree, files, message: 'deliver' })
      expect(committed).toMatchObject({ ok: true })
      const names = await runGit(['show', '--name-only', '--format=', 'HEAD'], created.worktree)
      expect(names.split('\n').sort()).toEqual(['app/[id]/page.tsx', 'newdir/a.txt'])
      // The glob look-alike was not staged or modified by the delivery.
      expect(await runGit(['diff', 'HEAD', '--', 'app/i/page.tsx'], created.worktree)).toBe('')
    } finally { cleanup() }
  })

  it('mergeInto refuses while the checkout has an operation in progress', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      writeFileSync(join(created.worktree, 'made.txt'), 'made')
      await commitAll(created.worktree, 'task commit')
      // Park the human's own conflicting merge in the checkout.
      writeFileSync(join(repo, 'a.txt'), 'other')
      await runGit(['checkout', '-b', 'other'], repo)
      await runGit(['add', 'a.txt'], repo)
      await runGit(['commit', '-m', 'other side'], repo)
      await runGit(['checkout', 'main'], repo)
      writeFileSync(join(repo, 'a.txt'), 'main side')
      await runGit(['add', 'a.txt'], repo)
      await runGit(['commit', '-m', 'main side'], repo)
      await runGit(['merge', 'other'], repo).catch(() => undefined)
      // The in-progress merge is the human's: dot's mergeInto refuses before touching it.
      const refused = await mergeInto({ repoRoot: repo, branch: created.branch })
      expect(refused.ok).toBe(false)
      expect(refused.message).toMatch(/merge in progress/)
      // Cleaning up the human merge restores mergeability.
      await runGit(['merge', '--abort'], repo)
      const merged = await mergeInto({ repoRoot: repo, branch: created.branch })
      expect(merged).toMatchObject({ ok: true, mergedInto: 'main' })
    } finally { cleanup() }
  })

  it('mergeInto refuses to overwrite an untracked or ignored file the delivery adds', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home })
      writeFileSync(join(created.worktree, 'new.txt'), 'from the task')
      await commitAll(created.worktree, 'task commit')
      // An untracked file on the delivered path is refused too (when the
      // delivered-paths dirty check also fires, its message lands first).
      writeFileSync(join(repo, 'new.txt'), 'human draft')
      let merged = await mergeInto({ repoRoot: repo, branch: created.branch, addedPaths: ['new.txt'] })
      expect(merged.ok).toBe(false)
      expect(merged.message).toMatch(/untracked files.*new\.txt/)
      rmSync(join(repo, 'new.txt'))
      // Same for a file ignored in the checkout.
      writeFileSync(join(repo, '.gitignore'), 'new.txt\n')
      await runGit(['add', '.gitignore'], repo)
      await runGit(['commit', '-m', 'ignore it'], repo)
      writeFileSync(join(repo, 'new.txt'), 'ignored draft')
      merged = await mergeInto({ repoRoot: repo, branch: created.branch, addedPaths: ['new.txt'] })
      expect(merged.ok).toBe(false)
      expect(merged.message).toMatch(/untracked files.*new\.txt/)
      // Once the path is clear the merge applies.
      rmSync(join(repo, 'new.txt'))
      merged = await mergeInto({ repoRoot: repo, branch: created.branch, addedPaths: ['new.txt'] })
      expect(merged).toMatchObject({ ok: true })
      expect(readFileSync(join(repo, 'new.txt'), 'utf-8')).toBe('from the task')
    } finally { cleanup() }
  })

  it('cuts the task branch from a local ref instead of HEAD', async () => {
    const { repo, home, cleanup } = makeRepo()
    try {
      writeFileSync(join(repo, 'pr.txt'), 'on the pr branch')
      await runGit(['add', 'pr.txt'], repo)
      await runGit(['commit', '-m', 'pr head'], repo)
      const prSha = await runGit(['rev-parse', 'HEAD'], repo)
      await runGit(['branch', 'pr-branch', prSha], repo)
      // Put the checkout back on the earlier commit so HEAD ≠ base.
      await runGit(['reset', '--hard', 'HEAD~1'], repo)
      const created = await createTaskWorktree({ dir: repo, homeDir: home, base: { ref: 'pr-branch' } })
      expect(created.baseSha).toBe(prSha)
      expect(readFileSync(join(created.worktree, 'pr.txt'), 'utf-8')).toBe('on the pr branch')
      expect(await runGit(['branch', '--show-current'], created.worktree)).toBe(created.branch)
    } finally { cleanup() }
  })

  it('fetches a remote ref into a temp ref, cuts from it, and leaves no fetch residue', async () => {
    const { repo, home, cleanup } = makeRepo()
    const upstream = makeRepo()
    try {
      writeFileSync(join(upstream.repo, 'up.txt'), 'upstream head')
      execFileSync('git', ['-C', upstream.repo, 'add', 'up.txt'], { stdio: 'ignore' })
      execFileSync('git', ['-C', upstream.repo, 'commit', '-m', 'pr head'], { stdio: 'ignore' })
      const upSha = (await runGit(['rev-parse', 'HEAD'], upstream.repo)).trim()
      execFileSync('git', ['-C', repo, 'remote', 'add', 'upstream', upstream.repo], { stdio: 'ignore' })
      const created = await createTaskWorktree({ dir: repo, homeDir: home, base: { ref: 'main', remote: 'upstream' } })
      expect(created.baseSha).toBe(upSha)
      expect(readFileSync(join(created.worktree, 'up.txt'), 'utf-8')).toBe('upstream head')
      // The temp ref is gone and --no-write-fetch-head left no FETCH_HEAD.
      expect(await runGit(['for-each-ref', 'refs/dot/base/'], repo)).toBe('')
      expect(existsSync(join(repo, '.git', 'FETCH_HEAD'))).toBe(false)
    } finally { cleanup(); upstream.cleanup() }
  })
})

describe('createTaskWorktree base plumbing (fake git)', () => {
  const makeDir = (prefix: string) => realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))

  it('records the fetch refspec and resolves then deletes the temp ref', async () => {
    const repo = makeDir('dot-wt-repo-')
    const home = makeDir('dot-wt-home-')
    const calls: string[][] = []
    const git: GitRunner = async (args) => {
      calls.push([...args])
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repo
      if (args[0] === 'remote') return 'origin\nupstream'
      if (args[0] === 'rev-parse') return 'deadbeefcafe'
      return ''
    }
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home, base: { ref: 'refs/pull/12/head', remote: 'upstream' } }, git)
      const fetch = calls.find(args => args[0] === 'fetch')
      const tempRef = /\+refs\/pull\/12\/head:(refs\/dot\/base\/[0-9a-f]+)/.exec(fetch?.join(' ') ?? '')?.[1]
      expect(tempRef).toBeTruthy()
      expect(fetch?.slice(0, 3)).toEqual(['fetch', '--no-tags', '--no-write-fetch-head'])
      expect(fetch).toContain('upstream')
      expect(calls.some(args => args[0] === 'rev-parse' && args.includes(`${tempRef}^{commit}`))).toBe(true)
      expect(calls.some(args => args[0] === 'update-ref' && args[1] === '-d' && args[2] === tempRef)).toBe(true)
      const added = calls.find(args => args[0] === 'worktree' && args[1] === 'add')
      expect(added?.at(-1)).toBe('deadbeefcafe')
      expect(created.baseSha).toBe('deadbeefcafe')
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  })

  it('deletes the temp ref even when worktree add fails', async () => {
    const repo = makeDir('dot-wt-repo-')
    const home = makeDir('dot-wt-home-')
    const calls: string[][] = []
    const git: GitRunner = async (args) => {
      calls.push([...args])
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repo
      if (args[0] === 'remote') return 'origin'
      if (args[0] === 'rev-parse') return 'abc1234'
      if (args[0] === 'worktree') throw new GitWorktreeError('worktree add exploded')
      return ''
    }
    try {
      await expect(createTaskWorktree({ dir: repo, homeDir: home, base: { ref: 'pr', remote: 'origin' } }, git)).rejects.toThrow(/exploded/)
      const tempRef = /\+pr:(refs\/dot\/base\/[0-9a-f]+)/.exec(calls.find(args => args[0] === 'fetch')?.join(' ') ?? '')?.[1]
      expect(calls.some(args => args[0] === 'update-ref' && args[1] === '-d' && args[2] === tempRef)).toBe(true)
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  })

  it('resolves a local ref without fetching and refuses unsafe base values', async () => {
    const repo = makeDir('dot-wt-repo-')
    const home = makeDir('dot-wt-home-')
    const calls: string[][] = []
    const git: GitRunner = async (args) => {
      calls.push([...args])
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repo
      if (args[0] === 'remote') return 'origin'
      if (args[0] === 'rev-parse') return 'beadfeed'
      return ''
    }
    try {
      const created = await createTaskWorktree({ dir: repo, homeDir: home, base: { ref: 'v1.2.3' } }, git)
      expect(created.baseSha).toBe('beadfeed')
      expect(calls.some(args => args[0] === 'rev-parse' && args.includes('v1.2.3^{commit}'))).toBe(true)
      expect(calls.some(args => args[0] === 'fetch')).toBe(false)
      for (const bad of ['', '  ', '--mirror', 'bad ref', 'bad\tref']) {
        await expect(createTaskWorktree({ dir: repo, homeDir: home, base: { ref: bad } }, git)).rejects.toThrow(/invalid base ref/)
      }
      // An https URL is allowed as a remote; anything else must be configured.
      await expect(createTaskWorktree({ dir: repo, homeDir: home, base: { ref: 'pr', remote: 'not-a-remote' } }, git)).rejects.toThrow(/not a configured remote/)
      await expect(createTaskWorktree({ dir: repo, homeDir: home, base: { ref: 'pr', remote: 'ssh://git@x' } }, git)).rejects.toThrow(/not a configured remote/)
      calls.length = 0
      await createTaskWorktree({ dir: repo, homeDir: home, base: { ref: 'pr', remote: 'https://example.com/repo.git' } }, git)
      expect(calls.some(args => args[0] === 'fetch' && args.includes('https://example.com/repo.git'))).toBe(true)
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
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

  it('folds case on win32 but stays case-sensitive elsewhere', () => {
    // The managed-row match must survive drive-letter and name casing on
    // Windows, and must NOT merge distinct rows on case-sensitive systems.
    expect(taskWorktreeRoot('c:\\Home\\Worktrees\\AbC\\sub', 'C:\\HOME', 'win32')).toBe('C:\\HOME\\worktrees\\abc')
    expect(taskWorktreeRoot('/home/x/worktrees/AbC/sub', '/home/x', 'linux')).toBe('/home/x/worktrees/AbC')
    expect(taskWorktreeRoot('/Home/x/worktrees/abc', '/home/x', 'linux')).toBeUndefined()
    expect(taskWorktreeRoot('/home/x/Worktrees/abc', '/home/x', 'linux')).toBeUndefined()
    expect(taskWorktreeRoot('/home/x/worktrees', '/home/x', 'linux')).toBeUndefined()
    expect(taskWorktreeRoot('/home/x/worktrees-other/abc', '/home/x', 'linux')).toBeUndefined()
  })
})
