/**
 * A pre-cleanup data directory must still open: read schemas strip keys they
 * no longer declare, the removed `tickets` table is never read, and proposals
 * naming a retired field are dropped on load. Nothing is migrated or written
 * back; retired data is simply invisible to the current code.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { openCompatibleDomain } from '@klarkxy/dsh-plugin-kit/domain'
import { STATE_KEY, dotDomain } from './storage.ts'
import { DotStore } from './store.ts'

describe('old data directory', () => {
  it('opens a 0.3.0-shaped home with retired fields and a tickets table', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dot-old-open-'))
    const backend = new JsonStorageBackend(root)
    const facility = new DomainFacility({
      storage: { backend: { get: (name: string) => {
        if (name !== 'json') throw new Error('unexpected backend')
        return backend
      } } }, logger: { error() {}, warn() {} }, emit() {},
    } as never, { backend: 'json' })
    const oldDocument = {
      unit: { name: 'klarkxy_dsh_dot', version: 5 },
      global: null,
      tables: {
        state: {
          [STATE_KEY]: {
            ticketSequence: 9,
            ticketsMigrated: true,
            memory: 'free-form notes of the old model',
            memoryUndo: 'older notes',
            knowledgeMigrated: true,
            dotSessionId: 'dot-1',
            agreements: '- keep this',
            segment: {
              sessionId: 'dot-1',
              startedAt: 1,
              persona: 'persona text',
              memory: 'pre-split notes',
              memorySeen: 'pre-split notes',
              openCard: 'card-7',
              agreements: '- keep this',
            },
          },
        },
        tasks: {
          's-1': {
            sessionId: 's-1',
            ticketId: 'ticket-3',
            role: 'worker',
            origin: 'watched',
            title: 'Old task',
            goal: 'goal',
            cwd: 'H:\\shared',
            status: 'idle',
            unseenTurns: 0,
          },
        },
        proposals: {
          'prop-old': { id: 'prop-old', field: 'policy', before: null, after: 'x', reason: 'written before the cleanup', createdAt: 1 },
          'prop-gone': { id: 'prop-gone', field: 'memory', before: null, after: 'x', reason: 'old name of agreements', createdAt: 2 },
          'prop-ok': { id: 'prop-ok', field: 'model', before: null, after: { provider: 'p', model: 'm' }, reason: 'still a field', createdAt: 3 },
        },
        tickets: {
          'ticket-3': { title: 'retired row the current domain never reads', status: 'done' },
        },
      },
    }
    await writeFile(join(root, 'klarkxy_dsh_dot.json'), JSON.stringify(oldDocument), 'utf8')
    try {
      const domain = await openCompatibleDomain(spec => facility.open(spec), dotDomain)
      const store = new DotStore(domain)
      // Retired keys are stripped on read; current data survives untouched.
      const stateRow = domain.table('state').get(STATE_KEY) as Record<string, unknown>
      expect(stateRow.dotSessionId).toBe('dot-1')
      expect(stateRow.agreements).toBe('- keep this')
      for (const key of ['ticketSequence', 'ticketsMigrated', 'memory', 'memoryUndo', 'knowledgeMigrated']) {
        expect(key in stateRow, key).toBe(false)
      }
      const segmentRow = stateRow.segment as Record<string, unknown>
      for (const key of ['memory', 'memorySeen', 'openCard']) expect(key in segmentRow, key).toBe(false)
      expect(store.agreements).toBe('- keep this')
      // The task ledger opens; the oldest rows still default their timestamps.
      const task = store.task('s-1')!
      expect(task.status).toBe('idle')
      expect(task.createdAt).toBe(0)
      expect('ticketId' in task).toBe(false)
      expect('role' in task).toBe(false)
      // Proposals for retired fields never reach the human.
      expect(store.settingProposals.map(proposal => proposal.id)).toEqual(['prop-ok'])
      await domain.close()
    } finally {
      await facility.closeAll()
      await backend.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
