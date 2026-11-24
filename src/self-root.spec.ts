import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from './auto-update.ts'
import { detectSelfInstall, insideOrEqual, killProcessTree, libHashOf, realpathOrResolve, runSelfBuild } from './self-root.ts'

function makeRoot(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function plantManifest(dir: string, name = PACKAGE_NAME): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }))
}

describe('detectSelfInstall', () => {
  it('resolves this module to the repo root as a linked install', () => {
    const self = detectSelfInstall()
    expect(self).toBeDefined()
    expect(self!.mode).toBe('linked')
    expect(realpathSync.native(self!.root)).toBe(self!.root)
    expect(join(self!.root, 'src', 'self-root.ts')).toContain('self-root')
  })

  it('reports installed when a path segment is node_modules, linked otherwise', () => {
    const linked = makeRoot('dot-self-link-')
    const installed = makeRoot('dot-self-inst-')
    try {
      plantManifest(linked.dir)
      const nestedLib = join(linked.dir, 'lib')
      mkdirSync(nestedLib, { recursive: true })
      const nodeModules = join(installed.dir, 'node_modules', PACKAGE_NAME)
      mkdirSync(nestedLib, { recursive: true })
      mkdirSync(join(nodeModules, 'lib'), { recursive: true })
      plantManifest(nodeModules)

      expect(detectSelfInstall(join(linked.dir, 'lib', 'index.js'))).toMatchObject({ mode: 'linked' })
      const found = detectSelfInstall(join(nodeModules, 'lib', 'index.js'))!
      expect(found.mode).toBe('installed')
      expect(found.root).toBe(realpathSync.native(nodeModules))
      // The nested node_modules segment decides the mode, not the outer checkout.
      const nestedInside = join(linked.dir, 'node_modules', PACKAGE_NAME)
      mkdirSync(join(nestedInside, 'lib'), { recursive: true })
      plantManifest(nestedInside)
      expect(detectSelfInstall(join(nestedInside, 'lib', 'index.js'))!.mode).toBe('installed')
    } finally {
      linked.cleanup()
      installed.cleanup()
    }
  })

  it('walks up from a lib-like nested file to the matching package.json', () => {
    const { dir, cleanup } = makeRoot('dot-self-walk-')
    try {
      plantManifest(dir)
      const deep = join(dir, 'lib', 'nested', 'deep')
      mkdirSync(deep, { recursive: true })
      const found = detectSelfInstall(join(deep, 'index.js'))
      expect(found).toMatchObject({ root: realpathSync.native(dir), mode: 'linked' })
    } finally {
      cleanup()
    }
  })

  it('returns undefined when no ancestor package.json names the package', () => {
    const { dir, cleanup } = makeRoot('dot-self-none-')
    try {
      plantManifest(dir, 'some-other-plugin')
      const deep = join(dir, 'lib')
      mkdirSync(deep, { recursive: true })
      expect(detectSelfInstall(deep)).toBeUndefined()
      expect(detectSelfInstall(join(deep, 'index.js'))).toBeUndefined()
    } finally {
      cleanup()
    }
  })
})

describe('insideOrEqual', () => {
  it('matches nested and equal paths but not siblings', () => {
    expect(insideOrEqual('/a/b', '/a/b')).toBe(true)
    expect(insideOrEqual('/a/b', '/a/b/c')).toBe(true)
    expect(insideOrEqual('/a/b', '/a/bc')).toBe(false)
    expect(insideOrEqual('/a/b', '/a')).toBe(false)
    expect(insideOrEqual('/a/b', '/a/b/../b/c')).toBe(true)
  })

  it('treats a child named ..temp as inside, not as a parent walk', () => {
    expect(insideOrEqual('/a/b', '/a/b/..temp')).toBe(true)
    expect(insideOrEqual('/a/b', '/a/b/..temp/c')).toBe(true)
    expect(insideOrEqual('/a/b', '/a/b/../c')).toBe(false)
    expect(insideOrEqual('/a/b', '/a')).toBe(false)
  })
})

describe('realpathOrResolve', () => {
  it('joins a missing leaf onto the realpath of the existing ancestor', () => {
    const { dir, cleanup } = makeRoot('dot-self-missing-')
    try {
      const real = realpathSync.native(dir)
      const missing = join(dir, 'src', 'new-file.ts')
      expect(realpathOrResolve(missing)).toBe(join(real, 'src', 'new-file.ts'))
    } finally {
      cleanup()
    }
  })

  it('follows a symlink into self when the write leaf does not exist yet', () => {
    const self = makeRoot('dot-self-real-')
    const outside = makeRoot('dot-self-linksrc-')
    try {
      mkdirSync(join(self.dir, 'src'), { recursive: true })
      const link = join(outside.dir, 'into-self')
      try {
        symlinkSync(self.dir, link, 'dir')
      } catch {
        // Windows without symlink privilege: the classification is still covered on POSIX CI.
        return
      }
      const missing = join(link, 'src', 'brand-new.ts')
      const classified = realpathOrResolve(missing)
      expect(insideOrEqual(realpathSync.native(self.dir), classified)).toBe(true)
      expect(classified).toBe(join(realpathSync.native(self.dir), 'src', 'brand-new.ts'))
    } finally {
      self.cleanup()
      outside.cleanup()
    }
  })
})

describe('libHashOf', () => {
  it('changes when a non-index lib artifact changes', () => {
    const { dir, cleanup } = makeRoot('dot-self-hash-')
    try {
      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'lib', 'index.js'), 'index-v1')
      writeFileSync(join(dir, 'lib', 'client.js'), 'client-v1')
      const first = libHashOf(dir)
      expect(first).toMatch(/^[0-9a-f]{64}$/)
      writeFileSync(join(dir, 'lib', 'client.js'), 'client-v2')
      expect(libHashOf(dir)).not.toBe(first)
      writeFileSync(join(dir, 'lib', 'client.js'), 'client-v1')
      expect(libHashOf(dir)).toBe(first)
    } finally {
      cleanup()
    }
  })
})

describe('killProcessTree', () => {
  it('stops a spawned descendant so it cannot keep writing after kill returns', async () => {
    const { dir, cleanup } = makeRoot('dot-self-kill-')
    try {
      const target = join(dir, 'out.txt')
      writeFileSync(target, '')
      const inner = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(target)},'x'),20);`
      const child = spawn(process.execPath, ['-e', inner], {
        detached: process.platform !== 'win32',
        stdio: 'ignore',
        windowsHide: true,
      })
      expect(child.pid).toBeTypeOf('number')
      await viWaitForFileGrow(target)
      await killProcessTree(child.pid!)
      const afterKill = readFileSync(target, 'utf8')
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(readFileSync(target, 'utf8')).toBe(afterKill)
    } finally {
      cleanup()
    }
  })
})

describe('runSelfBuild', () => {
  it('does not resolve an aborted build until the child tree has stopped writing', async () => {
    const { dir, cleanup } = makeRoot('dot-self-abort-')
    try {
      const target = join(dir, 'out.txt')
      writeFileSync(target, '')
      writeFileSync(join(dir, 'writer.cjs'), `const fs=require('fs');\nsetInterval(()=>fs.appendFileSync(${JSON.stringify(target)},'x'),20);\n`)
      const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, 'writer.cjs'))}`
      const ac = new AbortController()
      const running = runSelfBuild(dir, command, ac.signal)
      await viWaitForFileGrow(target)
      ac.abort()
      const result = await running
      expect(result.ok).toBe(false)
      const after = readFileSync(target, 'utf8')
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(readFileSync(target, 'utf8')).toBe(after)
    } finally {
      cleanup()
    }
  })
})

async function viWaitForFileGrow(target: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 3_000) {
    try {
      if (readFileSync(target, 'utf8').length > 0) return
    } catch { /* not there yet */ }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${target} to grow`)
}
