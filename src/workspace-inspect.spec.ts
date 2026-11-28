import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatWorkspaceFiles, listWorkspaceFiles, pathInsideRoot, readWorkspaceText, WORKSPACE_READ_MAX_LINES } from './workspace-inspect.ts'

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

describe('workspace read', () => {
  it('reads a file inside the workspace with line windows and truncation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dot-read-'))
    writeFileSync(join(root, 'doc.txt'), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'))
    const full = await readWorkspaceText(root, 'doc.txt')
    expect(full.totalLines).toBe(10)
    expect(full.start).toBe(1)
    expect(full.end).toBe(10)
    expect(full.truncated).toBe(false)
    expect(full.lines).toHaveLength(10)

    const window = await readWorkspaceText(root, 'doc.txt', { startLine: 4, maxLines: 3 })
    expect(window.lines).toEqual(['line 4', 'line 5', 'line 6'])
    expect(window.start).toBe(4)
    expect(window.end).toBe(6)
    expect(window.truncated).toBe(true)

    const clamped = await readWorkspaceText(root, 'doc.txt', { maxLines: WORKSPACE_READ_MAX_LINES + 500 })
    expect(clamped.truncated).toBe(false)
    const many = mkdtempSync(join(tmpdir(), 'dsh-dot-read-many-'))
    writeFileSync(join(many, 'big.txt'), Array.from({ length: WORKSPACE_READ_MAX_LINES + 5 }, () => 'x').join('\n'))
    const capped = await readWorkspaceText(many, 'big.txt', { maxLines: WORKSPACE_READ_MAX_LINES + 500 })
    expect(capped.lines).toHaveLength(WORKSPACE_READ_MAX_LINES)
    expect(capped.truncated).toBe(true)
  })

  it('reads any non-credential absolute path and keeps relative paths inside their workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-dot-read-ws-'))
    const change = mkdtempSync(join(tmpdir(), 'dsh-dot-read-chg-'))
    const outside = mkdtempSync(join(tmpdir(), 'dsh-dot-read-out-'))
    writeFileSync(join(change, 'a.ts'), 'change file')
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    const inChange = await readWorkspaceText(workspace, join(change, 'a.ts'))
    expect(inChange.lines).toEqual(['change file'])
    const outsideRead = await readWorkspaceText(workspace, join(outside, 'secret.txt'))
    expect(outsideRead.lines).toEqual(['nope'])
    await expect(readWorkspaceText(workspace, join(outside, '..', '..'))).rejects.toThrow(/directory/)
    await expect(readWorkspaceText(undefined, 'relative.txt')).rejects.toThrow(/workspace/)
  })

  it('refuses a symlink escaping the workspace', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-dot-read-link-'))
    const root = join(parent, 'workspace')
    const external = join(parent, 'external')
    mkdirSync(root)
    mkdirSync(external)
    writeFileSync(join(external, 'out.txt'), 'outside')
    symlinkSync(external, join(root, 'link'), 'junction')
    await expect(readWorkspaceText(root, join('link', 'out.txt'))).rejects.toThrow(/outside/)
    await expect(readWorkspaceText(root, 'link')).rejects.toThrow(/outside/)
  })

  it('refuses directories, binaries, oversized files, and credential-like paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dot-read-refuse-'))
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x89, 0x00, 0x50]))
    writeFileSync(join(root, 'huge.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
    writeFileSync(join(root, '.env'), 'TOKEN=x')
    writeFileSync(join(root, '.env.example'), 'TOKEN=')
    await expect(readWorkspaceText(root, 'sub')).rejects.toThrow(/directory/)
    await expect(readWorkspaceText(root, 'bin.dat')).rejects.toThrow(/binary/)
    await expect(readWorkspaceText(root, 'huge.txt')).rejects.toThrow(/2 MiB/)
    await expect(readWorkspaceText(root, '.env')).rejects.toThrow(/credential/)
    const template = await readWorkspaceText(root, '.env.example')
    expect(template.lines).toEqual(['TOKEN='])
    await expect(readWorkspaceText(root, '.env.local')).rejects.toThrow(/cannot read|credential/)
  })

  it.skipIf(process.platform === 'win32')('refuses a named pipe instead of hanging on it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dot-read-fifo-'))
    const fifo = join(root, 'pipe')
    spawnSync('mkfifo', [fifo])
    await expect(readWorkspaceText(root, 'pipe')).rejects.toThrow(/not a regular file/)
  })

  it('rejects a bad start_line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dot-read-lines-'))
    writeFileSync(join(root, 'a.txt'), 'one')
    await expect(readWorkspaceText(root, 'a.txt', { startLine: 0 })).rejects.toThrow(/start_line/)
  })
})
