/**
 * The rc.3 domain rejects update of a missing key. This opens that package
 * over a temporary json backend, not the preserved stage-5 home.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { openCompatibleDomain } from '@klarkxy/dsh-plugin-kit/domain'
import { dotDomain } from './storage.ts'
import { DotStore } from './store.ts'

const require = createRequire(import.meta.url)
const domainPackage = require('@deepseek-ai/dsh-storage-domain/package.json') as { version: string }

describe('rc.3 work persistence', () => {
  it('puts the first input on the real domain and updates the existing change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dot-persist-live-'))
    const backend = new JsonStorageBackend(root)
    const facility = new DomainFacility({
      storage: { backend: { get: (name: string) => {
        if (name !== 'json') throw new Error('unexpected backend')
        return backend
      } } }, logger: { error() {}, warn() {} }, emit() {},
    } as never, { backend: 'json' })
    const lines: string[] = []
    const say = (line: string) => { lines.push(line); console.log(line) }
    try {
      say(`DOMAIN @deepseek-ai/dsh-storage-domain@${domainPackage.version}`)
      const domain = await openCompatibleDomain(spec => facility.open(spec), dotDomain)
      const missing = await domain.table('inputs').update('input-1', value => value).then(() => 'UNEXPECTED PASS', error => error instanceof Error ? `${(error as { code?: string }).code ?? 'error'}: ${error.message}` : String(error))
      say(`MISSING_UPDATE ${missing}`)
      expect(missing).toContain('missing-key')
      expect(missing).toContain("has no record 'input-1' to update")
      const store = new DotStore(domain)
      const change = await store.work.createChange({ title: 'Recipe', cwd: 'H:\\shared', goal: 'land it', at: 1 })
      const reserved = await store.work.reserveRun({ changeId: change.id, cwd: 'H:\\shared', writeScope: { kind: 'paths', paths: [] }, at: 2 })
      if (!reserved.ok) throw new Error(reserved.message)
      const paused = await store.work.setControl(change.id, 'paused', 3)
      if (!('id' in paused)) throw new Error(paused.message)
      say(`CREATE input=${change.currentInputRef} change=${change.id} run=${reserved.run.id}`)
      say(`MEMORY control=${store.work.change(change.id)?.control}`)
      await domain.close()
      const again = await openCompatibleDomain(spec => facility.open(spec), dotDomain)
      const reloaded = new DotStore(again)
      const row = reloaded.work.change(change.id)
      say(`REOPEN control=${row?.control} goal=${reloaded.work.input(row?.currentInputRef ?? '')?.goal} run=${reloaded.work.run(reserved.run.id)?.phase}`)
      expect(row?.control).toBe('paused')
      expect(reloaded.work.input(row?.currentInputRef ?? '')?.goal).toBe('land it')
      expect(reloaded.work.run(reserved.run.id)?.phase).toBe('reserved')
      await again.close()
      say('LIVE PASS')
    } finally {
      await facility.closeAll()
      await backend.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
