import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from './auto-update.ts'
import { detectSelfInstall, insideOrEqual } from './self-root.ts'

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
})
