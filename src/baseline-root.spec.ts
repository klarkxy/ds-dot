/**
 * Relative baseline paths resolve against the run's workspace root.
 * A failed snapshot stays on disk; the next attempt either finishes the
 * directory that has no manifest, or takes a new id when a manifest is already there.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { openCompatibleDomain } from '@klarkxy/dsh-plugin-kit/domain'
import { readSnapshot } from './artifacts.ts'
import { dotDomain } from './storage.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { occupantsConflict, scopeKey, scopeWithinRoot } from './work.ts'

const require = createRequire(import.meta.url)
const domainPackage = require('@deepseek-ai/dsh-storage-domain/package.json') as { version: string }

describe('baseline workspace root', () => {
  it('treats a relative scope and its absolute form as one path, and rejects an escape', () => {
    const root = 'H:\\shared'
    const relative = { kind: 'paths' as const, paths: [{ path: 'site/a.md', type: 'file' as const }, { path: 'site/b.md', type: 'file' as const }] }
    const absolute = { kind: 'paths' as const, paths: [{ path: 'H:\\shared\\site\\b.md', type: 'file' as const }, { path: 'H:\\shared\\site\\a.md', type: 'file' as const }] }
    const key = scopeKey(relative, root, 'win32')
    expect(key).toBe(scopeKey(absolute, root, 'win32'))
    expect(key).toContain('h:\\shared\\site\\a.md')
    expect(key).not.toContain('runtime')
    expect(scopeKey({ kind: 'workspace-exclusive' }, root, 'win32')).toBe('workspace-exclusive')
    expect(scopeWithinRoot(root, 'site/a.md', 'win32')).toBe(true)
    expect(scopeWithinRoot(root, '..\\secret.txt', 'win32')).toBe(false)
    expect(scopeWithinRoot(root, 'H:\\runtime\\site\\a.md', 'win32')).toBe(false)
    const occupant = (id: string, path: string) => ({
      id, cwd: 'h:\\shared', workspaceRoot: 'h:\\shared', exclusiveRoot: 'h:\\shared', uncertainBoundary: false,
      writeScope: { kind: 'paths' as const, paths: [{ path, type: 'file' as const }] },
    })
    expect(occupantsConflict(occupant('rel', 'site/a.md'), occupant('abs', 'H:\\shared\\site\\a.md'), 'win32')).toBe(true)
    expect(occupantsConflict(occupant('a', 'site/a.md'), occupant('b', 'site/b.md'), 'win32')).toBe(false)
  })

  it('reads the shared workspace, not the runtime directory, and recovers a failed snapshot', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dot-baseline-root-'))
    const previous = process.cwd()
    try {
      const lines = await exercise(parent)
      expect(lines.join('\n')).toContain('BODY from-shared')
      expect(lines.join('\n')).toContain('DECOY unread')
      expect(lines.join('\n')).toContain('RETRY dispatch=true')
      expect(lines.join('\n')).toContain('PLANTED kept')
      expect(lines.join('\n')).toContain('STILL phase=reserved')
    } finally {
      process.chdir(previous)
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('does the same on the real rc.3 domain and reopens the published baseline', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dot-baseline-live-'))
    const previous = process.cwd()
    const backend = new JsonStorageBackend(join(parent, 'domain'))
    const facility = new DomainFacility({
      storage: { backend: { get: (name: string) => {
        if (name !== 'json') throw new Error('unexpected backend')
        return backend
      } } }, logger: { error() {}, warn() {} }, emit() {},
    } as never, { backend: 'json' })
    const say = (line: string) => console.log(line)
    try {
      say(`DOMAIN @deepseek-ai/dsh-storage-domain@${domainPackage.version}`)
      const domain = await openCompatibleDomain(spec => facility.open(spec), dotDomain)
      const store = new DotStore(domain)
      const lines = await exercise(parent, store)
      for (const line of lines) say(line)
      await domain.close()
      const again = await openCompatibleDomain(spec => facility.open(spec), dotDomain)
      const reloaded = new DotStore(again)
      const relative = reloaded.work.run(lines.relativeRunId)
      const stuck = reloaded.work.run(lines.stuckRunId)
      say(`REOPEN artifact=${relative?.baselineRefs.at(-1)?.artifactRef} phase=${relative?.phase} stuck=${stuck?.phase} stuckBaselines=${stuck?.baselineRefs.length}`)
      expect(relative?.baselineRefs.at(-1)?.artifactRef).toBe(lines.relativeArtifact)
      expect(relative?.phase).toBe('reserved')
      expect(text(readSnapshot(join(parent, 'home', 'artifacts', lines.relativeArtifact)).bodies.get('site/a.md'))).toBe('from-shared')
      expect(stuck?.phase).toBe('reserved')
      expect(stuck?.baselineRefs).toEqual([])
      expect(reloaded.work.occupying().some(run => run.id === lines.stuckRunId)).toBe(true)
      await again.close()
      say('LIVE PASS')
    } finally {
      process.chdir(previous)
      await facility.closeAll()
      await backend.close()
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

function text(body: Uint8Array | undefined): string {
  return body ? new TextDecoder().decode(body) : ''
}

function artifactDirs(home: string): string[] {
  const root = join(home, 'artifacts')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

function openService(store: DotStore, home: string): DotService {
  const notes = { path: join(home, 'memory.md'), read: async () => '', readCognition: async () => '' }
  return new DotService({
    host: { isRunning: () => false } as never,
    store, homeDir: home, notes, now: () => 10,
    timer: { set: () => 1, clear() {}, now: () => 10 },
  })
}

async function exercise(parent: string, existing?: DotStore): Promise<string[] & { relativeRunId: string; relativeArtifact: string; stuckRunId: string }> {
  const shared = join(parent, 'shared')
  const runtime = join(parent, 'runtime')
  const home = join(parent, 'home')
  mkdirSync(join(shared, 'site'), { recursive: true })
  mkdirSync(join(runtime, 'site'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(shared, 'site', 'a.md'), 'from-shared')
  writeFileSync(join(shared, 'site', 'b.md'), 'from-shared-b')
  writeFileSync(join(shared, 'site', 'c.md'), 'from-shared-c')
  writeFileSync(join(shared, 'site', 'd.md'), 'from-shared-d')
  for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) writeFileSync(join(runtime, 'site', name), 'from-runtime')
  writeFileSync(join(parent, 'secret.txt'), 'from-secret')
  process.chdir(runtime)
  const store = existing ?? new DotStore(undefined)
  const service = openService(store, home)
  const lines: string[] = []
  const say = (line: string) => lines.push(line)
  const change = await store.work.createChange({ title: 'Recipe', cwd: shared, goal: 'land it', maxConcurrentRuns: 4, at: 1 })
  const reserve = async (paths: readonly { path: string; type: 'file' | 'directory' }[], at: number) => {
    const reserved = await store.work.reserveRun({
      changeId: change.id, cwd: shared, root: { workspaceRoot: shared },
      writeScope: { kind: 'paths', paths }, at,
    })
    if (!reserved.ok) throw new Error(reserved.message)
    return reserved.run
  }
  const relativeRun = await reserve([{ path: 'site/a.md', type: 'file' }, { path: 'site/b.md', type: 'file' }], 2)
  const plantedRun = await reserve([{ path: 'site/c.md', type: 'file' }], 3)
  const outsideRun = await reserve([{ path: '../secret.txt', type: 'file' }], 4)
  const stuckRun = await reserve([{ path: 'site/d.md', type: 'file' }], 5)

  const beforeHalf = artifactDirs(home)
  await expect(service.captureWorkBaseline(relativeRun.id, { failOn: 'site/b.md' })).rejects.toThrow(/SAVE_ENTRY_FAILED/)
  const halfDirs = artifactDirs(home).filter(name => !beforeHalf.includes(name))
  expect(halfDirs).toHaveLength(1)
  const halfId = halfDirs[0]!
  expect(existsSync(join(home, 'artifacts', halfId, 'manifest.json'))).toBe(false)
  const partialBlobs = readdirSync(join(home, 'artifacts', halfId, 'blobs'))
  expect(partialBlobs.length).toBeGreaterThan(0)
  expect(store.work.run(relativeRun.id)?.baselineRefs).toEqual([])
  expect(store.work.dispatchAllowed(relativeRun.id).ok).toBe(false)
  const finished = await service.captureWorkBaseline(relativeRun.id)
  if (!('applied' in finished) || !finished.applied) throw new Error('half-written baseline did not finish')
  expect(artifactDirs(home).filter(name => !beforeHalf.includes(name))).toEqual([halfId])
  expect(readdirSync(join(home, 'artifacts', halfId, 'blobs'))).toEqual(expect.arrayContaining(partialBlobs))
  const ref = store.work.run(relativeRun.id)!.baselineRefs.at(-1)!
  const snap = readSnapshot(join(home, 'artifacts', ref.artifactRef))
  expect(text(snap.bodies.get('site/a.md'))).toBe('from-shared')
  expect(text(snap.bodies.get('site/b.md'))).toBe('from-shared-b')
  expect([...snap.bodies.values()].map(body => text(body))).not.toContain('from-runtime')
  const absoluteKey = scopeKey({
    kind: 'paths',
    paths: [{ path: join(shared, 'site', 'a.md'), type: 'file' }, { path: join(shared, 'site', 'b.md'), type: 'file' }],
  }, relativeRun.workspaceRoot)
  expect(ref.scopeKey).toBe(absoluteKey)
  expect(ref.scopeKey).not.toContain('runtime')
  expect(store.work.dispatchAllowed(relativeRun.id)).toEqual({ ok: true })
  say(`RELATIVE artifact=${ref.artifactRef} key=${ref.scopeKey}`)
  say('BODY from-shared')
  say('DECOY unread')
  say(`RETRY dispatch=true same=${halfId}`)

  const beforePlanted = artifactDirs(home)
  await expect(service.captureWorkBaseline(plantedRun.id, { failOn: 'site/c.md' })).rejects.toThrow(/SAVE_ENTRY_FAILED/)
  const plantedId = artifactDirs(home).filter(name => !beforePlanted.includes(name))[0]!
  const planted = JSON.stringify({ root: 'wrong', empty: true, saved: [], deleted: [] })
  writeFileSync(join(home, 'artifacts', plantedId, 'manifest.json'), planted)
  const refused = await service.publishWorkBaseline(plantedRun.id, store.work.revision, plantedId)
  expect(refused).toMatchObject({ code: 'baseline' })
  expect(store.work.run(plantedRun.id)?.baselineRefs).toEqual([])
  expect(store.work.occupying().some(run => run.id === plantedRun.id)).toBe(true)
  const recovered = await service.captureWorkBaseline(plantedRun.id)
  if (!('applied' in recovered) || !recovered.applied) throw new Error('immutable failure did not recover')
  const recoveredRef = store.work.run(plantedRun.id)!.baselineRefs.at(-1)!
  expect(recoveredRef.artifactRef).not.toBe(plantedId)
  expect(readFileSync(join(home, 'artifacts', plantedId, 'manifest.json'), 'utf8')).toBe(planted)
  expect(text(readSnapshot(join(home, 'artifacts', recoveredRef.artifactRef)).bodies.get('site/c.md'))).toBe('from-shared-c')
  expect(store.work.dispatchAllowed(plantedRun.id)).toEqual({ ok: true })
  say(`PLANTED kept id=${plantedId} recovered=${recoveredRef.artifactRef}`)

  const beforeOutside = artifactDirs(home)
  await expect(service.captureWorkBaseline(outsideRun.id)).rejects.toThrow(/outside/)
  expect(artifactDirs(home)).toEqual(beforeOutside)
  expect(readFileSync(join(parent, 'secret.txt'), 'utf8')).toBe('from-secret')
  expect(store.work.run(outsideRun.id)?.baselineRefs).toEqual([])
  expect(store.work.occupying().some(run => run.id === outsideRun.id)).toBe(true)
  say(`OUTSIDE occupied=true run=${outsideRun.id}`)

  await expect(service.captureWorkBaseline(stuckRun.id, { failOn: 'site/d.md' })).rejects.toThrow(/SAVE_ENTRY_FAILED/)
  await expect(service.captureWorkBaseline(stuckRun.id, { failOn: 'site/d.md' })).rejects.toThrow(/SAVE_ENTRY_FAILED/)
  expect(store.work.run(stuckRun.id)?.baselineRefs).toEqual([])
  expect(store.work.run(stuckRun.id)?.phase).toBe('reserved')
  expect(store.work.dispatchAllowed(stuckRun.id).ok).toBe(false)
  expect(store.work.occupying().map(run => run.id)).toEqual(expect.arrayContaining([relativeRun.id, plantedRun.id, outsideRun.id, stuckRun.id]))
  expect(store.work.recoveryError).toBeUndefined()
  say(`STILL phase=reserved run=${stuckRun.id} baselines=0`)

  const outcome = lines as string[] & { relativeRunId: string; relativeArtifact: string; stuckRunId: string }
  outcome.relativeRunId = relativeRun.id
  outcome.relativeArtifact = ref.artifactRef
  outcome.stuckRunId = stuckRun.id
  return outcome
}
