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

  it('opens a v9 directory holding a links row, then writes and rereads a recipe proposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dot-v9-open-'))
    const backend = new JsonStorageBackend(root)
    const facility = new DomainFacility({
      storage: { backend: { get: (name: string) => {
        if (name !== 'json') throw new Error('unexpected backend')
        return backend
      } } }, logger: { error() {}, warn() {} }, emit() {},
    } as never, { backend: 'json' })
    const v9Document = {
      unit: { name: 'klarkxy_dsh_dot', version: 9 },
      global: null,
      tables: {
        state: { [STATE_KEY]: { dotSessionId: 'dot-1' } },
        links: {
          'lnk-1': { id: 'lnk-1', changeId: 'chg-1', repo: 'org/repo', number: 7, origin: 'auto', state: 'open', addedAt: 1 },
        },
        recipes: {
          'rcp-1': {
            id: 'rcp-1', name: 'weekly', revision: 1, goal: 'weekly report', requirements: [],
            requirementsFromGoal: true, history: [], outcomes: [], createdAt: 1, updatedAt: 1,
          },
        },
      },
    }
    await writeFile(join(root, 'klarkxy_dsh_dot.json'), JSON.stringify(v9Document), 'utf8')
    try {
      const domain = await openCompatibleDomain(spec => facility.open(spec), dotDomain)
      const store = new DotStore(domain)
      expect(store.link('lnk-1')).toMatchObject({ changeId: 'chg-1', repo: 'org/repo', number: 7 })
      await store.putRecipeProposal({
        id: 'rpp-1', recipeId: 'rcp-1', baseRevision: 1, kind: 'restore', targetRevision: 1,
        reason: 'rev 1: 1/4 accepted; rev 2 better', origin: 'detector', regression: 'acceptance',
        status: 'pending', createdAt: 2,
      })
      await domain.close()
      // Reopen over the same directory: both tables read back under v10.
      const again = await openCompatibleDomain(spec => facility.open(spec), dotDomain)
      const store2 = new DotStore(again)
      expect(store2.link('lnk-1')).toMatchObject({ repo: 'org/repo', number: 7 })
      expect(store2.recipeProposal('rpp-1')).toMatchObject({ recipeId: 'rcp-1', status: 'pending', regression: 'acceptance' })
      await again.close()
    } finally {
      await facility.closeAll()
      await backend.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
