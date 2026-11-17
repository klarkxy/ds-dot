import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatWorkspaceFiles, listWorkspaceFiles, pathInsideRoot } from './workspace-inspect.ts'

describe('workspace inspect listing', () => {
  it('lists files inside the root and refuses a path that escapes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dot-ws-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'a')
    writeFileSync(join(root, 'README.md'), 'hi')
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'no')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'HEAD'), 'ref')

    const rows = await listWorkspaceFiles(root)
    expect(rows.map(row => row.path)).toEqual(['README.md', 'src', 'src/a.ts'])
    expect(rows.find(row => row.path === 'src')?.type).toBe('directory')
    await expect(listWorkspaceFiles(root, '..')).rejects.toThrow(/outside/)
    expect(pathInsideRoot(root, join(root, 'src', 'a.ts'))).toBe(true)
    expect(pathInsideRoot(root, join(root, '..', 'other'))).toBe(false)
  })

  it('caps the listing and marks truncation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dot-ws-'))
    for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.txt`), 'x')
    const rows = await listWorkspaceFiles(root, '.', 1, 3)
    expect(rows).toHaveLength(3)
    expect(formatWorkspaceFiles(rows, true)).toContain('truncated at 3')
  })

  it('refuses an explicitly selected junction escaping the workspace root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-dot-ws-junc-'))
    const root = join(parent, 'workspace')
    const external = join(parent, 'external')
    mkdirSync(root)
    mkdirSync(external)
    writeFileSync(join(external, 'outside-marker.txt'), 'probe only')
    writeFileSync(join(root, 'inside.txt'), 'ok')
    symlinkSync(external, join(root, 'external-link'), 'junction')
    await expect(listWorkspaceFiles(root, 'external-link')).rejects.toThrow(/outside/)
    const rows = await listWorkspaceFiles(root)
    expect(rows.map(row => row.path)).toEqual(['inside.txt'])
    expect(rows.map(row => row.path).join('\n')).not.toContain('outside-marker')
  })
})
