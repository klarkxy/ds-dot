import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectWorkspaceRoot } from './git-root.ts'
import { occupantsConflict, workspaceIdentity } from './work.ts'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), statSync: vi.fn(actual.statSync) }
})

const roots: string[] = []
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'dot-git-root-'))
  roots.push(root)
  return root
}
afterEach(() => {
  vi.mocked(readFileSync).mockClear()
  vi.mocked(statSync).mockClear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Git exclusion identity', () => {
  it('distinguishes a directory outside Git from an ordinary repository', () => {
    const root = directory()
    expect(detectWorkspaceRoot(root)).toEqual({ workspaceRoot: root })
    mkdirSync(join(root, '.git'))
    expect(detectWorkspaceRoot(root)).toEqual({ workspaceRoot: root, gitCommonDir: join(root, '.git') })
  })

  it('resolves a linked worktree to its shared common directory', () => {
    const root = directory()
    const common = join(root, 'repo.git')
    const gitDir = join(common, 'worktrees', 'one')
    const checkout = join(root, 'checkout')
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(join(checkout, 'src'), { recursive: true })
    writeFileSync(join(checkout, '.git'), `gitdir: ${gitDir}`)
    writeFileSync(join(gitDir, 'commondir'), '../..')
    expect(detectWorkspaceRoot(join(checkout, 'src'))).toEqual({ workspaceRoot: join(checkout, 'src'), gitCommonDir: common })
  })

  it.each(['stat', 'gitdir', 'commondir'] as const)('keeps %s read failure uncertain and conflicting', kind => {
    const root = directory()
    if (kind === 'stat') {
      vi.mocked(statSync).mockImplementationOnce(() => { throw new Error('access denied') })
    } else if (kind === 'gitdir') {
      writeFileSync(join(root, '.git'), 'gitdir: ../private')
      vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error('access denied') })
    } else {
      mkdirSync(join(root, '.git'))
      writeFileSync(join(root, '.git', 'commondir'), '../common')
      vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error('access denied') })
    }
    const hint = detectWorkspaceRoot(root)
    expect(hint).toEqual({ workspaceRoot: root, uncertain: true })
    const left = { id: 'uncertain', cwd: root, ...workspaceIdentity(root, hint), writeScope: { kind: 'workspace-exclusive' as const } }
    const elsewhere = resolve(root, '../elsewhere')
    const right = { id: 'other', cwd: elsewhere, ...workspaceIdentity(elsewhere), writeScope: { kind: 'workspace-exclusive' as const } }
    expect(occupantsConflict(left, right)).toBe(true)
  })
})
