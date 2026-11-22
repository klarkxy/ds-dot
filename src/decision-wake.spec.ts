/**
 * A version-matched user decision wakes dot through the existing notice queue.
 * It does not accept, reject, decide again, or open another session.
 * A restart delivers the same decision once, then stays quiet.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './contracts.ts'
import { DotService } from './service.ts'
import { DotStore, type DotDomainHandle } from './store.ts'

function memoryDomain() {
  const names = ['state', 'tasks', 'tickets', 'schedules', 'proposals', 'recipes', 'links', 'changes', 'inputs', 'runs', 'verifications']
  const tables: Record<string, Map<string, unknown>> = {}
  for (const name of names) tables[name] = new Map()
  const domain: DotDomainHandle = {
    table: name => ({
      entries: () => tables[name]!.entries(),
      get: key => tables[name]!.get(key),
      put: async (key, value) => { tables[name]!.set(key, value) },
      delete: async key => tables[name]!.delete(key),
      update: async (key, recipe) => {
        const rows = tables[name]!
        const next = recipe(rows.get(key))
        rows.set(key, next)
        return next
      },
    }),
    close: async () => {},
  }
  return domain
}

function harness(domain: DotDomainHandle, home: string) {
  const relayed: Array<{ target: string; text: string }> = []
  const opened: string[] = []
  const host = {
    isRunning: () => false,
    listSessions: async () => [],
    readEvents: async () => [],
    listWorkspaces: () => [],
    createWorkspace: async () => ({ id: 'home', path: home, title: 'Dorothy', sessionCount: 0 }),
    createDot: async () => { opened.push('dot'); return 'dot-1' },
    resumeDot: async (id: string) => id === 'dot-1',
    createSession: async () => { opened.push('session'); return 'session-1' },
    createInternal: async () => { opened.push('internal'); return 'internal-1' },
    prompt: async () => { opened.push('prompt') },
    relay: async (target: string, _sender: string, text: string) => { relayed.push({ target, text }) },
    modelKey: () => undefined,
    syncModel: () => {},
  }
  const store = new DotStore(domain)
  const notes = { path: join(home, 'memory.md'), text: '', cognition: '', read: async () => '', readCognition: async () => '' }
  const service = new DotService({
    host: host as never, store, homeDir: home, notes, approvalGraceMs: 0,
    timer: { set: () => 1, clear() {}, now: () => 1000 },
    now: () => 1000,
  })
  return { service, store, relayed, opened }
}

async function ask(service: DotService, changeId: string, revision: number, verificationId: string, subjectKey: string): Promise<string> {
  const asked = await service.manageTask({
    action: 'decide', task_id: changeId, verification_id: verificationId,
    expected_input_revision: revision, expected_subject_key: subjectKey,
  })
  return /pending (\S+)/.exec(asked)![1]!
}

describe('work decision wake', () => {
  it('wakes dot once for a recorded decision and does not accept or open a session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dot-wake-home-'))
    const domain = memoryDomain()
    const first = harness(domain, home)
    try {
      await first.store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
      const dot = await first.service.ensureDot()
      const change = await first.service.createWorkChange({ title: 'Look', cwd: home, goal: 'see', at: 1 })
      const pending = await ask(first.service, change.id, change.currentRevision, 'v-9', 'subject-9')
      await first.service.answerWorkReview(pending, true)
      expect(first.store.work.change(change.id)?.closeout).toBeUndefined()
      expect(first.store.work.change(change.id)?.oversight?.decision).toMatchObject({ result: 'accept', verificationId: 'v-9', subjectKey: 'subject-9', source: 'user' })
      expect(first.relayed).toEqual([])
      await first.service.flushNotices()
      expect(first.relayed).toHaveLength(1)
      expect(first.relayed[0]!.target).toBe(dot)
      expect(first.relayed[0]!.text).toContain(`${change.id} user accept is already recorded`)
      expect(first.relayed[0]!.text).toContain('verification v-9')
      expect(first.relayed[0]!.text).toContain('subject subject-9')
      expect(first.relayed[0]!.text).toContain('Do not call decide again')
      expect(first.relayed[0]!.text).toContain('action=closeout')
      expect(first.relayed[0]!.text).toContain(`expected_input_ref=${change.currentInputRef}`)
      expect(first.relayed[0]!.text).toContain(`expected_input_revision=${change.currentRevision}`)
      expect(first.relayed[0]!.text).not.toContain('action=accept')
      expect(first.relayed[0]!.text).toContain('does not accept, reject, or open a session')
      expect(first.store.work.change(change.id)?.oversight?.decision?.notifiedAt).toBe(1000)
      expect(first.store.work.change(change.id)?.closeout).toBeUndefined()
      expect(first.opened).toEqual(['dot'])
      await expect(first.service.answerWorkReview(pending, true)).rejects.toThrow(/no longer pending/)
      await first.service.flushNotices()
      await first.service.reconcile()
      await first.service.flushNotices()
      expect(first.relayed).toHaveLength(1)

      const again = harness(domain, home)
      await again.service.ensureDot()
      await again.service.reconcile()
      await again.service.flushNotices()
      expect(again.relayed).toEqual([])
      expect(again.opened).toEqual([])
      expect(again.store.work.change(change.id)?.closeout).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('names the independent review when a rejected verification has one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dot-wake-review-'))
    const domain = memoryDomain()
    const first = harness(domain, home)
    try {
      await first.store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
      await first.service.ensureDot()
      const change = await first.service.createWorkChange({ title: 'Reviewed', cwd: home, goal: 'see', at: 1 })
      const review = await first.store.work.reserveRun({ changeId: change.id, kind: 'review', writeScope: { kind: 'workspace-exclusive' }, at: 2 })
      if (!review.ok) throw new Error(review.message)
      await domain.table('verifications').put('v-4', {
        id: 'v-4', changeId: change.id, inputRef: change.currentInputRef, inputRevision: change.currentRevision,
        runIds: [], reviewRunId: review.run.id, checks: [], verdict: 'unverified', subjectKey: 'subject-4', createdAt: 3,
      })
      const restored = harness(domain, home)
      const pending = await ask(restored.service, change.id, change.currentRevision, 'v-4', 'subject-4')
      await restored.service.answerWorkReview(pending, false)
      await restored.service.flushNotices()
      const text = restored.relayed[0]!.text
      expect(text).toContain(`action=reject with task_id=${change.id}, review_run_id=${review.run.id}`)
      expect(text).toContain(`expected_input_revision=${change.currentRevision}`)
      expect(text).not.toContain('action=revise')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('delivers an undelivered decision after restart, once, including a rejection', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dot-wake-redo-'))
    const domain = memoryDomain()
    const first = harness(domain, home)
    try {
      await first.store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
      await first.service.ensureDot()
      const change = await first.service.createWorkChange({ title: 'Look', cwd: home, goal: 'see', at: 1 })
      const pending = await ask(first.service, change.id, change.currentRevision, 'v-3', 'subject-3')
      await first.service.answerWorkReview(pending, false)
      expect(first.store.work.change(change.id)?.oversight?.decision?.notifiedAt).toBeUndefined()
      expect(first.relayed).toEqual([])

      const second = harness(domain, home)
      await second.service.reconcile()
      await second.service.flushNotices()
      expect(second.relayed).toHaveLength(1)
      expect(second.relayed[0]!.target).toBe('dot-1')
      expect(second.relayed[0]!.text).toContain('user reject is already recorded')
      expect(second.relayed[0]!.text).toContain('action=revise')
      expect(second.relayed[0]!.text).toContain('role=rework')
      expect(second.relayed[0]!.text).not.toContain('action=reject')
      expect(second.relayed[0]!.text).toContain('Do not call decide again')
      expect(second.store.work.change(change.id)?.oversight?.decision?.notifiedAt).toBe(1000)
      expect(second.store.work.change(change.id)?.closeout).toBeUndefined()
      expect(second.opened).toEqual([])

      const third = harness(domain, home)
      await third.service.reconcile()
      await third.service.flushNotices()
      expect(third.relayed).toEqual([])
      expect(third.opened).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
