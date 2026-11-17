/**
 * Snapshot default skips, recorded exclusions, link boundaries, and acceptance
 * tree matching. Does not change worktree exclusive locks.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { subjectMaterial, type DeliverySubject, type SubjectLook } from './acceptance.ts'
import {
  captureScope, defaultIgnoreCover, ignoredDirName, readSnapshot, restoreSnapshot,
  saveSnapshot, scanScope, sha256,
} from './artifacts.ts'
import { DEFAULT_SETTINGS } from './contracts.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import type { BaselineRef, RunRecord } from './work.ts'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function lookAt(artifacts: string, liveExtra: readonly string[] = []): SubjectLook {
  return {
    read(ref) {
      try {
        const manifest = readSnapshot(join(artifacts, ref)).manifest
        return { root: manifest.root, saved: manifest.saved, deleted: manifest.deleted, exclusions: manifest.exclusions }
      } catch { return undefined }
    },
    evidence: () => true,
    live(root) {
      try {
        return [...scanScope(root, root, 'directory').files, ...liveExtra]
      } catch { return undefined }
    },
    boundaries(root) {
      try { return [...scanScope(root, root, 'directory').exclusions] } catch { return undefined }
    },
    body(root, path) {
      try { return new Uint8Array(readFileSync(join(root, ...path.split('/')))) } catch { return undefined }
    },
  }
}

function writerRun(root: string, artifactRef: string, writeScope: RunRecord['writeScope']): RunRecord {
  return {
    id: 'run-1', changeId: 'c-1', kind: 'work', inputRevision: 1, inputRef: 'in-1', stepRefs: [],
    cwd: root, workspaceRoot: root, exclusiveRoot: root, uncertainBoundary: false, writeScope,
    baselineRefs: [{ workspaceRoot: root, scopeKey: 'k', artifactRef }],
    requestedSessionId: 's-1', creation: 'confirmed', deliveries: [], phase: 'completed',
    createdAt: 1, updatedAt: 1,
  } as RunRecord
}

function subjectOf(root: string, artifactRef: string, patch: Partial<DeliverySubject> = {}): DeliverySubject {
  return {
    workspaceRoot: root, cwd: root,
    baselineRefs: [{ workspaceRoot: root, scopeKey: 'k', artifactRef: 'base-1' } satisfies BaselineRef],
    artifactRef, changes: [], protectedDirty: [], exclusions: [],
    ...patch,
  }
}

function workHarness() {
  const home = tmp('dot-excl-home-')
  const project = tmp('dot-excl-proj-')
  const store = new DotStore(undefined)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false })
  const host = {
    isRunning: () => false,
    listSessions: async () => [],
    titles: async () => new Map<string, string>(),
    latestReply: async () => '',
    readEvents: async () => [],
    cancel: async () => {},
    archive: async () => {},
    modelKey: () => 'p/ok',
    syncModel: () => {},
    createWorkspace: async (path: string, title?: string) => ({ id: 'ws-1', title: title ?? 'proj', path, sessionCount: 0 }),
    listWorkspaces: () => [{ id: 'ws-1', title: 'proj', path: project, sessionCount: 0 }],
    cwdOf: async () => project,
    listModels: async () => ({ fallback: { provider: 'p', model: 'ok' }, models: [{ provider: 'p', model: 'ok', name: 'Ok' }] }),
    listPresets: async () => ({ fallback: 'standard', presets: [{ id: 'standard' }] }),
    selectModel: async () => {},
    setReadOnly: async () => true,
    setWritable: async () => true,
    verifyTaskPermission: async () => true,
    createDot: async () => 'dot-session',
    resumeDot: async () => true,
    releaseDot: async () => {},
    dotContext: async () => ({ live: true, compactions: 0 }),
    summarize: async () => '',
    findSession: async () => undefined,
    createSession: async () => 'session-1',
    prompt: async () => {},
    relay: async () => {},
    stopActivity: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }),
  }
  const service = new DotService({
    host: host as never,
    store,
    homeDir: home,
    notes: { path: join(home, 'memory.md'), read: async () => '', readCognition: async () => '' },
    approvalGraceMs: 0,
    timer: { set: () => 1, clear: () => {}, now: () => 1000 },
    now: () => 1000,
  })
  return {
    service, store, home, project,
    cleanup: () => {
      rmSync(project, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

describe('snapshot default exclusions', () => {
  it('records top-level dependency/VCS trees without walking them, and keeps a file named node_modules', () => {
    const root = tmp('dot-excl-scan-')
    try {
      mkdirSync(join(root, '.git', 'objects'), { recursive: true })
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'secret')
      mkdirSync(join(root, 'src', 'node_modules'), { recursive: true })
      writeFileSync(join(root, 'src', 'node_modules', 'nested.js'), 'nested')
      writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1\n')
      mkdirSync(join(root, 'misc'))
      writeFileSync(join(root, 'misc', 'node_modules'), 'not-a-dir')
      writeFileSync(join(root, '.DS_Store'), 'mac')
      writeFileSync(join(root, 'src', '.DS_Store'), 'mac-src')
      writeFileSync(join(root, 'node_modules', '.DS_Store'), 'mac-dep')
      const captured = captureScope(root, root, 'directory')
      expect(captured.files.map(file => file.path).sort()).toEqual(['misc/node_modules', 'src/app.ts'])
      expect(captured.exclusions).toEqual(expect.arrayContaining([
        { path: '.git', reason: 'ignored directory' },
        { path: 'node_modules', reason: 'ignored directory' },
        { path: 'src/node_modules', reason: 'ignored directory' },
        { path: '.DS_Store', reason: 'ignored file' },
        { path: 'src/.DS_Store', reason: 'ignored file' },
      ]))
      expect(captured.exclusions.some(item => item.path.startsWith('node_modules/'))).toBe(false)
      expect(captured.exclusions.some(item => item.path === 'src/node_modules/nested.js')).toBe(false)
      expect(captured.exclusions.some(item => item.path === 'node_modules/.DS_Store')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records a source symlink as a boundary without following it, and restore still refuses links', () => {
    const root = tmp('dot-excl-link-')
    const outside = tmp('dot-excl-out-')
    const home = tmp('dot-excl-art-')
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'app.ts'), 'ok')
      writeFileSync(join(outside, 'secret.txt'), 'secret')
      symlinkSync(outside, join(root, 'src', 'vendor'), 'junction')
      const captured = captureScope(root, root, 'directory')
      expect(captured.files.map(file => file.path)).toEqual(['src/app.ts'])
      const vendor = captured.exclusions.find(item => item.path === 'src/vendor')
      expect(vendor?.reason.startsWith('symlink:')).toBe(true)
      expect(captured.files.some(file => file.path.includes('secret'))).toBe(false)
      const snap = join(home, 'artifacts', 'escape')
      saveSnapshot(snap, [{ path: 'src/vendor/pwn.txt', body: new TextEncoder().encode('no') }], undefined, { root, exclusions: captured.exclusions })
      expect(() => restoreSnapshot(snap, root)).toThrow(/link/)
      expect(existsSync(join(outside, 'pwn.txt'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reads a pre-exclusion manifest and treats missing exclusions as undeclared', () => {
    const root = tmp('dot-excl-old-')
    const dir = join(root, 'snap')
    try {
      const body = new TextEncoder().encode('hello')
      const saved = saveSnapshot(dir, [{ path: 'a.ts', body }], undefined, { root })
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
        root, empty: false, saved: saved.saved, deleted: [],
      }))
      const read = readSnapshot(dir)
      expect(read.manifest.exclusions).toBeUndefined()
      expect(read.manifest.saved[0]?.path).toBe('a.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('folds ignored directory names on Windows only', () => {
    expect(ignoredDirName('Node_Modules', 'win32')).toBe(true)
    expect(ignoredDirName('Node_Modules', 'linux')).toBe(false)
    expect(ignoredDirName('node_modules', 'linux')).toBe(true)
    expect(defaultIgnoreCover('Node_Modules/pkg/index.js', 'win32')).toBe('Node_Modules')
    expect(defaultIgnoreCover('Node_Modules/pkg/index.js', 'linux')).toBeUndefined()
    expect(defaultIgnoreCover('src/app.ts', 'win32')).toBeUndefined()
    expect(defaultIgnoreCover('misc/node_modules', 'win32', 'file')).toBeUndefined()
    expect(defaultIgnoreCover('misc/node_modules', 'linux', 'file')).toBeUndefined()
    expect(defaultIgnoreCover('misc/node_modules', 'linux', 'directory')).toBe('misc/node_modules')
    expect(defaultIgnoreCover('node_modules/pkg/index.js', 'linux', 'file')).toBe('node_modules')
    expect(defaultIgnoreCover('.git', 'linux', 'file')).toBe('.git')
    expect(defaultIgnoreCover('src/.git', 'win32', 'file')).toBe('src/.git')
    expect(defaultIgnoreCover('.DS_Store', 'linux', 'file')).toBe('.DS_Store')
    expect(defaultIgnoreCover('src/.DS_Store', 'win32', 'file')).toBe('src/.DS_Store')
  })
})

describe('acceptance exclusion trees and source links', () => {
  it('does not reject dependency-tree cache files, and refuses a forged exclusion that would hide new source', () => {
    const project = tmp('dot-excl-acc-')
    const artifacts = tmp('dot-excl-acc-art-')
    try {
      mkdirSync(join(project, 'src'), { recursive: true })
      mkdirSync(join(project, 'node_modules', 'pkg'), { recursive: true })
      const app = new TextEncoder().encode('app')
      writeFileSync(join(project, 'src', 'app.ts'), app)
      writeFileSync(join(project, 'node_modules', 'pkg', 'index.js'), 'cache-1')
      const captured = captureScope(project, project, 'directory')
      saveSnapshot(join(artifacts, 'base-1'), captured.files, undefined, { root: project, exclusions: captured.exclusions })
      saveSnapshot(join(artifacts, 'delivery-1'), captured.files, undefined, { root: project, exclusions: captured.exclusions })
      writeFileSync(join(project, 'node_modules', 'pkg', 'index.js'), 'cache-2')
      const ok = subjectOf(project, 'delivery-1', {
        protectedDirty: ['src/app.ts'],
        exclusions: [...captured.exclusions],
      })
      const run = writerRun(project, 'base-1', { kind: 'paths', paths: [{ path: join(project, 'src', 'app.ts'), type: 'file' }] })
      expect(subjectMaterial(ok, ok.baselineRefs, [run], [], lookAt(artifacts, ['node_modules/pkg/index.js']))).toBeUndefined()

      writeFileSync(join(project, 'src', 'secret.ts'), 'hidden')
      const forged = subjectOf(project, 'delivery-1', {
        protectedDirty: ['src/app.ts'],
        exclusions: [...captured.exclusions, { path: 'src/secret.ts', reason: 'ignored directory' }],
      })
      expect(subjectMaterial(forged, forged.baselineRefs, [run], [], lookAt(artifacts))).toMatch(/exclusions do not match/)
      const listed = subjectMaterial(ok, ok.baselineRefs, [run], [], lookAt(artifacts, ['src/secret.ts']))
      expect(listed).toMatch(/live file src\/secret\.ts/)
    } finally {
      rmSync(project, { recursive: true, force: true })
      rmSync(artifacts, { recursive: true, force: true })
    }
  })

  it('detects a new or retargeted link inside a covered directory, not a pre-existing link outside a file scope', () => {
    const project = tmp('dot-excl-scope-')
    const artifacts = tmp('dot-excl-scope-art-')
    const outside = tmp('dot-excl-scope-out-')
    const other = tmp('dot-excl-scope-other-')
    try {
      mkdirSync(join(project, 'src'), { recursive: true })
      const app = new TextEncoder().encode('app')
      writeFileSync(join(project, 'src', 'app.ts'), app)
      writeFileSync(join(outside, 'lib.txt'), 'lib')
      symlinkSync(outside, join(project, 'src', 'vendor'), 'junction')
      const whole = captureScope(project, project, 'directory')
      saveSnapshot(join(artifacts, 'base-1'), [{ path: 'src/app.ts', body: app }], undefined, { root: project, exclusions: [] })
      saveSnapshot(join(artifacts, 'delivery-1'), [{ path: 'src/app.ts', body: app }], undefined, { root: project, exclusions: whole.exclusions })
      const fileRun = writerRun(project, 'base-1', { kind: 'paths', paths: [{ path: join(project, 'src', 'app.ts'), type: 'file' }] })
      const allowed = subjectOf(project, 'delivery-1', {
        protectedDirty: ['src/app.ts'],
        exclusions: [...whole.exclusions],
      })
      expect(subjectMaterial(allowed, allowed.baselineRefs, [fileRun], [], lookAt(artifacts))).toBeUndefined()

      const dirBase = captureScope(project, join(project, 'src'), 'directory')
      saveSnapshot(join(artifacts, 'base-dir'), dirBase.files, undefined, { root: project, exclusions: dirBase.exclusions })
      writeFileSync(join(other, 'other.txt'), 'other')
      rmSync(join(project, 'src', 'vendor'), { force: true })
      symlinkSync(other, join(project, 'src', 'vendor'), 'junction')
      const after = captureScope(project, project, 'directory')
      saveSnapshot(join(artifacts, 'delivery-dir'), after.files, undefined, { root: project, exclusions: after.exclusions })
      const dirRun = writerRun(project, 'base-dir', { kind: 'paths', paths: [{ path: join(project, 'src'), type: 'directory' }] })
      const changed = subjectOf(project, 'delivery-dir', {
        baselineRefs: [{ workspaceRoot: project, scopeKey: 'k', artifactRef: 'base-dir' }],
        protectedDirty: ['src/app.ts'],
        exclusions: [...after.exclusions],
      })
      expect(subjectMaterial(changed, changed.baselineRefs, [dirRun], [], lookAt(artifacts))).toMatch(/source link appeared or changed/)
    } finally {
      rmSync(project, { recursive: true, force: true })
      rmSync(artifacts, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('keeps posix path comparison case-sensitive', () => {
    expect(subjectMaterial(
      subjectOf('/proj', 'delivery-1', { workspaceRoot: '/proj', cwd: '/proj', protectedDirty: ['Foo.ts'] }),
      [{ workspaceRoot: '/proj', scopeKey: 'k', artifactRef: 'base-1' }],
      [],
      [],
      {
        read: ref => ref === 'delivery-1' || ref === 'base-1'
          ? { root: '/proj', saved: [{ path: 'Foo.ts', sha256: 'aa' }], deleted: [], exclusions: [] }
          : undefined,
        evidence: () => true,
        live: () => ['foo.ts'],
        boundaries: () => [],
        body: () => new Uint8Array([1]),
      },
      'linux',
    )).toMatch(/live file foo\.ts/)
  })
})

describe('explicit ignored write scopes at baseline', () => {
  it('refuses a file or directory target inside node_modules and still ships a.ts when a pre-existing link sits outside the write scope', async () => {
    const ignored = workHarness()
    try {
      mkdirSync(join(ignored.project, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(ignored.project, 'node_modules', 'pkg', 'index.js'), 'dep')
      writeFileSync(join(ignored.project, 'a.ts'), 'before')
      const change = await ignored.service.createWorkChange({
        title: 'Deps', cwd: ignored.project, goal: 'edit', at: 1,
        requirements: [{ requirementRef: 'r1', text: 'builds', required: true }],
      })
      const fileInside = await ignored.service.reserveWorkRun({
        changeId: change.id, cwd: ignored.project, root: { workspaceRoot: ignored.project },
        writeScope: { kind: 'paths', paths: [{ path: join(ignored.project, 'node_modules', 'pkg', 'index.js'), type: 'file' }] }, at: 2,
      })
      if (!fileInside.ok) throw new Error(fileInside.message)
      await expect(ignored.service.captureWorkBaseline(fileInside.run.id)).rejects.toThrow(/default-ignored path\/file/)

      const dsFile = workHarness()
      try {
        writeFileSync(join(dsFile.project, '.DS_Store'), 'mac')
        mkdirSync(join(dsFile.project, 'src'))
        writeFileSync(join(dsFile.project, 'src', '.DS_Store'), 'mac-src')
        const dsChange = await dsFile.service.createWorkChange({
          title: 'Dots', cwd: dsFile.project, goal: 'skip', at: 1, maxConcurrentRuns: 2,
          requirements: [{ requirementRef: 'r1', text: 'builds', required: true }],
        })
        const dsRoot = await dsFile.service.reserveWorkRun({
          changeId: dsChange.id, cwd: dsFile.project, root: { workspaceRoot: dsFile.project },
          writeScope: { kind: 'paths', paths: [{ path: join(dsFile.project, '.DS_Store'), type: 'file' }] }, at: 2,
        })
        if (!dsRoot.ok) throw new Error(dsRoot.message)
        await expect(dsFile.service.captureWorkBaseline(dsRoot.run.id)).rejects.toThrow(/default-ignored path\/file/)
        const dsNested = await dsFile.service.reserveWorkRun({
          changeId: dsChange.id, cwd: dsFile.project, root: { workspaceRoot: dsFile.project },
          writeScope: { kind: 'paths', paths: [{ path: join(dsFile.project, 'src', '.DS_Store'), type: 'file' }] }, at: 3,
        })
        if (!dsNested.ok) throw new Error(dsNested.message)
        await expect(dsFile.service.captureWorkBaseline(dsNested.run.id)).rejects.toThrow(/default-ignored path\/file/)
      } finally {
        dsFile.cleanup()
      }

      const leafFile = workHarness()
      try {
        mkdirSync(join(leafFile.project, 'misc'))
        writeFileSync(join(leafFile.project, 'misc', 'node_modules'), 'not-a-dir')
        const leafChange = await leafFile.service.createWorkChange({
          title: 'Leaf', cwd: leafFile.project, goal: 'edit', at: 1,
          requirements: [{ requirementRef: 'r1', text: 'builds', required: true }],
        })
        const leaf = await leafFile.service.reserveWorkRun({
          changeId: leafChange.id, cwd: leafFile.project, root: { workspaceRoot: leafFile.project },
          writeScope: { kind: 'paths', paths: [{ path: join(leafFile.project, 'misc', 'node_modules'), type: 'file' }] }, at: 2,
        })
        if (!leaf.ok) throw new Error(leaf.message)
        expect(await leafFile.service.captureWorkBaseline(leaf.run.id)).toMatchObject({ applied: true })
      } finally {
        leafFile.cleanup()
      }
    } finally {
      ignored.cleanup()
    }

    const h = workHarness()
    const outside = tmp('dot-excl-pre-out-')
    try {
      mkdirSync(join(h.project, 'src'), { recursive: true })
      writeFileSync(join(h.project, 'a.ts'), 'before')
      writeFileSync(join(outside, 'lib.txt'), 'lib')
      symlinkSync(outside, join(h.project, 'src', 'vendor'), 'junction')
      const change = await h.service.createWorkChange({
        title: 'Ship', cwd: h.project, goal: 'edit a.ts', at: 1,
        requirements: [{ requirementRef: 'r1', text: 'builds', required: true }],
      })
      const reserved = await h.service.reserveWorkRun({
        changeId: change.id, cwd: h.project, root: { workspaceRoot: h.project },
        writeScope: { kind: 'paths', paths: [{ path: join(h.project, 'a.ts'), type: 'file' }] }, at: 2,
      })
      if (!reserved.ok) throw new Error(reserved.message)
      expect(await h.service.captureWorkBaseline(reserved.run.id)).toMatchObject({ applied: true })
      writeFileSync(join(h.project, 'a.ts'), 'after')
      const subject = await h.service.captureWorkSubject(change.id)
      expect(subject.changes).toEqual([expect.objectContaining({ path: 'a.ts', kind: 'modified', sha256: sha256(new TextEncoder().encode('after')) })])
      expect(subject.exclusions.some(item => item.path === 'src/vendor' && item.reason.startsWith('symlink:'))).toBe(true)
      expect(subject.exclusions.some(item => item.path === 'a.ts')).toBe(false)
      const look = lookAt(join(h.home, 'artifacts'))
      const current = h.store.work.change(change.id)!
      const runs = h.store.work.listRuns().filter(run => run.changeId === change.id)
      expect(subjectMaterial(subject, current.baselineRefs, runs, [], look)).toBeUndefined()
    } finally {
      h.cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
