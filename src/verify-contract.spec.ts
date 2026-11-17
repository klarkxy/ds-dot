/**
 * The registered verify tool must not treat a snapshot id as the delivery.
 * subject_ref loads the capture for this change and input; a trimmed object,
 * an older input, another run, or a missing required check is refused.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, TOOL } from './contracts.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { apply } from './tools.ts'

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dot-verify-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-verify-proj-'))
  writeFileSync(join(project, 'a.ts'), 'before')
  const store = new DotStore(undefined)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const sessions = new Map<string, { cwd?: string }>()
  const host = {
    isRunning: () => false,
    listSessions: async () => [],
    readEvents: async () => [],
    findSession: async (id: string) => sessions.get(id),
    createSession: async (input: { sessionId?: string; cwd?: string }) => {
      const id = input.sessionId ?? `session-${sessions.size}`
      sessions.set(id, { cwd: input.cwd })
      return id
    },
    setWritable: async () => true,
    setReadOnly: async () => true,
    verifyTaskPermission: async () => true,
    prompt: async () => {},
    stopActivity: async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }),
  }
  const notes = { path: join(home, 'memory.md'), read: async () => '', readCognition: async () => '' }
  const service = new DotService({
    host: host as never, store, homeDir: home, notes, approvalGraceMs: 0,
    timer: { set: () => 1, clear() {}, now: () => 1000 },
    now: () => 1000,
  })
  const registered: Array<Record<string, unknown>> = []
  apply({
    tools: { schemas: () => [], restrict: () => () => {}, register(definition: Record<string, unknown>) { registered.push(definition); return () => {} } },
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    dot: service,
    effect(fn: () => unknown) { fn() },
  } as never)
  const task = registered.find(row => row.name === TOOL.task) as {
    description: string
    parameters: { properties: Record<string, { description?: string }> }
    execute(args: Record<string, unknown>): Promise<string>
  }
  return { home, project, store, service, task, cleanup: () => { rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) } }
}

describe('verify tool contract', () => {
  it('resolves subject_ref and refuses a snapshot id, a stale input, another run, a trimmed subject, and a shrunk check list', async () => {
    const h = harness()
    try {
      expect(h.task.description).toContain('subject_ref')
      expect(h.task.description).toContain('evidence_ref')
      expect(h.task.parameters.properties.subject_ref?.description).toContain('action=subject')
      expect(h.task.parameters.properties.subject?.description).toContain('not a snapshot id')
      expect(h.task.parameters.properties.checks?.description).toContain('action=evidence')
      expect(h.task.parameters.properties.evidence_ref?.description).toContain('Not a subjectRef')
      const change = await h.service.createWorkChange({
        title: 'Ship', cwd: h.project, goal: 'land',
        requirements: [
          { requirementRef: 'R1', text: 'edit', required: true },
          { requirementRef: 'R2', text: 'check', required: true },
        ],
        at: 1,
      })
      const writer = await h.service.reserveWorkRun({
        changeId: change.id, cwd: h.project, root: { workspaceRoot: h.project },
        writeScope: { kind: 'paths', paths: [{ path: join(h.project, 'a.ts'), type: 'file' }] }, at: 2,
      })
      if (!writer.ok) throw new Error(writer.message)
      await h.service.captureWorkBaseline(writer.run.id)
      const started = await h.service.launchWorkRun(writer.run.id, 'edit')
      if (!started.ok) throw new Error(started.message)
      writeFileSync(join(h.project, 'a.ts'), 'after')
      const prepared = await h.store.work.prepareFinish(writer.run.id, 'completed', 3)
      if (!prepared.ok) throw new Error(prepared.message)
      const finished = await h.store.work.finishSettled(writer.run.id, prepared.updatedAt, 'completed', { queueCleared: true, agentIdle: true, jobsSettled: true }, 4)
      if (!finished.ok) throw new Error(finished.message)
      const review = await h.service.reserveWorkRun({
        changeId: change.id, kind: 'review', cwd: h.project, root: { workspaceRoot: h.project },
        writeScope: { kind: 'workspace-exclusive' }, at: 5,
      })
      if (!review.ok) throw new Error(review.message)
      await h.service.captureWorkBaseline(review.run.id)
      const startedReview = await h.service.launchWorkRun(review.run.id, 'check')
      if (!startedReview.ok) throw new Error(startedReview.message)
      const held = await h.service.holdWorkReview(review.run.id)
      if (!('id' in held)) throw new Error(held.message)
      await h.service.saveWorkEvidence('log', 'seen')
      const captured = JSON.parse(await h.task.execute({ action: 'subject', task_id: change.id })) as { subjectRef: string; artifactRef: string; changes: unknown[] }
      expect(captured.subjectRef).toBe(captured.artifactRef)
      expect(captured.subjectRef.startsWith('sub-')).toBe(true)
      const current = h.store.work.change(change.id)!
      const base = {
        action: 'verify', task_id: change.id, run_ids: JSON.stringify([writer.run.id]),
        review_run_id: review.run.id, session_id: h.store.work.run(review.run.id)!.sessionId,
        expected_input_ref: current.currentInputRef, expected_input_revision: current.currentRevision,
      }
      const checks = JSON.stringify([
        { requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log'] },
        { requirementRef: 'R2', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log'] },
      ])
      const idError = await h.task.execute({ ...base, checks, subject: captured.subjectRef })
      expect(idError).toContain(`subject ${captured.subjectRef} is a snapshot id`)
      expect(idError).toContain('subject_ref')
      expect(idError).not.toContain('must be JSON')
      expect(h.store.work.latestVerification(change.id)).toBeUndefined()
      const required = await h.task.execute({
        ...base, subject_ref: captured.subjectRef,
        checks: JSON.stringify([{ requirementRef: 'R1', applicability: 'required', verdict: 'pass', evidenceRefs: ['log'] }]),
      })
      expect(required).toContain('applicability must be applicable or not-applicable, not required')
      expect(required).toContain('Do not drop it')
      const trimmed = await h.task.execute({
        ...base, checks, subject: JSON.stringify({ ...captured, baselineRefs: [{ workspaceRoot: current.cwd, artifactRef: 'base' }], changes: [] }),
      })
      expect(trimmed).toContain(`does not match captured delivery ${captured.subjectRef}`)
      expect(trimmed).toContain('Do not drop scopeKey')
      const shrunk = await h.task.execute({
        ...base, subject_ref: captured.subjectRef,
        checks: JSON.stringify([{ requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log'] }]),
      })
      expect(shrunk).toContain('checks are incomplete: required R2 has no check')
      expect(shrunk).toContain('Do not remove requirements')
      const elsewhere = mkdtempSync(join(tmpdir(), 'dot-verify-other-'))
      try {
        const other = await h.service.createWorkChange({ title: 'Other', cwd: elsewhere, goal: 'else', at: 6 })
        const otherReview = await h.service.reserveWorkRun({
          changeId: other.id, kind: 'review', cwd: elsewhere, root: { workspaceRoot: elsewhere },
          writeScope: { kind: 'workspace-exclusive' }, at: 7,
        })
        if (!otherReview.ok) throw new Error(otherReview.message)
        const foreign = await h.task.execute({ ...base, checks, subject_ref: captured.subjectRef, review_run_id: otherReview.run.id })
        expect(foreign).toContain('verification has no review run')
        expect(foreign).toContain('Do not edit checks')
      } finally {
        rmSync(elsewhere, { recursive: true, force: true })
      }
      expect(h.store.work.latestVerification(change.id)).toBeUndefined()
      const snapshotEvidence = await h.task.execute({
        ...base, subject_ref: captured.subjectRef,
        checks: JSON.stringify([
          { requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: [captured.subjectRef] },
          { requirementRef: 'R2', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log'] },
        ]),
      })
      expect(snapshotEvidence).toContain(`${captured.subjectRef} is a snapshot, baseline, or session id`)
      expect(snapshotEvidence).toContain('action=evidence')
      expect(snapshotEvidence).toContain('Do not edit checks')
      const otherIds = await h.task.execute({
        ...base, subject_ref: captured.subjectRef,
        checks: JSON.stringify([
          { requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['base-run-1-3'] },
          { requirementRef: 'R2', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['session-run-2'] },
        ]),
      })
      expect(otherIds).toContain('base-run-1-3 is a snapshot, baseline, or session id')
      expect(otherIds).not.toContain('must be JSON')
      const unregistered = await h.task.execute({
        ...base, subject_ref: captured.subjectRef,
        checks: JSON.stringify([
          { requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['not-registered'] },
          { requirementRef: 'R2', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log'] },
        ]),
      })
      expect(unregistered).toContain('not-registered is not a registered evidence_ref')
      expect(unregistered).toContain('action=evidence')
      const refusedName = await h.task.execute({ action: 'evidence', task_id: change.id, evidence_ref: captured.subjectRef, summary: 'no' })
      expect(refusedName).toContain('snapshot, baseline, or session id')
      const registered = await h.task.execute({ action: 'evidence', task_id: change.id, evidence_ref: 'build-log', summary: 'ok' })
      expect(registered).toContain('evidence_ref build-log')
      expect(registered).toContain('Do not substitute')
      expect(h.store.work.latestVerification(change.id)).toBeUndefined()
      const byRef = JSON.parse(await h.task.execute({ ...base, checks, subject_ref: captured.subjectRef })) as { id: string; verdict: string }
      expect(byRef).toMatchObject({ id: 'v-1', verdict: 'accept' })
      const byObject = JSON.parse(await h.task.execute({ ...base, checks, subject: JSON.stringify(captured) })) as { id: string }
      expect(byObject.id).toBe('v-2')
      const revised = await h.service.reviseWorkChange(change.id, { goal: 'land it again', at: 8 })
      if (!('id' in revised)) throw new Error(revised.message)
      const stale = await h.task.execute({
        ...base, checks, subject_ref: captured.subjectRef,
        expected_input_ref: revised.currentInputRef, expected_input_revision: revised.currentRevision,
      })
      expect(stale).toContain(`subject_ref ${captured.subjectRef} is for ${current.currentInputRef}@${current.currentRevision}`)
      expect(stale).toContain('Call action=subject again')
      expect(h.store.work.verification('v-1')?.inputRef).toBe(current.currentInputRef)
      expect(h.store.work.latestVerification(change.id)?.id).toBe('v-2')
    } finally {
      h.cleanup()
    }
  })
})
