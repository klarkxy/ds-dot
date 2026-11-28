import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREDENTIAL_READ_REFUSAL, dotReadRefusal, HOSTILE_READ_REFUSAL, OUTSIDE_READ_REFUSAL, UNRESOLVABLE_READ_REFUSAL } from './read-guard.ts'

function link(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'junction')
    return true
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}

describe('dot read guard', () => {
  it('allows absolute and relative reads inside a readable root', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dot-read-guard-'))
    writeFileSync(join(root, 'note.txt'), 'hello')
    expect(dotReadRefusal(join(root, 'note.txt'), { bases: [], roots: [root] })).toBeUndefined()
    expect(dotReadRefusal('note.txt', { bases: [root], roots: [root] })).toBeUndefined()
  })

  it('refuses an absolute path outside every readable root', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dot-read-guard-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'dsh-dot-read-guard-out-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    expect(dotReadRefusal(join(outside, 'secret.txt'), { bases: [], roots: [root] })).toBe(OUTSIDE_READ_REFUSAL)
  })

  it('refuses a symlink inside a root when its target escapes the root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-dot-read-guard-link-'))
    const root = join(parent, 'root')
    const outside = join(parent, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'out.txt'), 'outside')
    if (!link(outside, join(root, 'link'))) return
    expect(dotReadRefusal(join('link', 'out.txt'), { bases: [root], roots: [root] })).toBe(OUTSIDE_READ_REFUSAL)
  })

  it('refuses a multi-hop link chain whose middle hop is credential-like', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dot-read-guard-env-link-'))
    const target = join(root, 'target')
    mkdirSync(target)
    writeFileSync(join(target, 'ok.txt'), 'ok')
    if (!link(target, join(root, '.env'))) return
    if (!link(join(root, '.env'), join(root, 'first'))) return
    expect(dotReadRefusal(join('first', 'ok.txt'), { bases: [root], roots: [root] })).toBe(CREDENTIAL_READ_REFUSAL)
  })

  it('refuses Windows alternate-stream and network path forms on every host', () => {
    for (const raw of [
      String.raw`C:\app\.env::$DATA`,
      'notes.txt:hidden',
      String.raw`\\host\share\a`,
      '//host/share/a',
      String.raw`\\?\UNC\host\share\a`,
    ]) {
      expect(dotReadRefusal(raw, { bases: [], roots: [] }), raw).toBe(HOSTILE_READ_REFUSAL)
    }
  })

  it.skipIf(process.platform !== 'win32')('allows the Windows long-path prefix for a file inside a root', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dot-read-guard-long-'))
    writeFileSync(join(root, 'note.txt'), 'hello')
    expect(dotReadRefusal('\\\\?\\' + join(root, 'note.txt'), { bases: [], roots: [root] })).toBeUndefined()
  })

  it('fails closed when the filesystem cannot inspect a candidate', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-dot-read-guard-error-'))
    expect(dotReadRefusal(join(root, 'bad\0file'), { bases: [], roots: [root] })).toBe(UNRESOLVABLE_READ_REFUSAL)
  })

  it('expands a home-relative path before applying the roots', () => {
    expect(dotReadRefusal('~/dsh-dot-read-guard-home-probe', { bases: [], roots: [homedir()] })).toBeUndefined()
  })
})
