/**
 * Model-free contract for the board's `work.*` RPC surface: a projection
 * forwards the same versioned arguments every consumer sends. A service-level
 * double-check keeps an older input, decision or delivery from being applied.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { DEFAULT_SETTINGS } from './contracts.ts'
import { rejectPayload } from './work-board.ts'

const str = (payload: unknown, key: string): string => typeof (payload as Record<string, unknown> | null)?.[key] === 'string' ? (payload as Record<string, string>)[key] : ''
const num = (payload: unknown, key: string): number | undefined => typeof (payload as Record<string, unknown> | null)?.[key] === 'number' ? (payload as Record<string, number>)[key] : undefined
const field = (payload: unknown, key: string): unknown => payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'dot-rpc-home-'))
  const project = mkdtempSync(join(tmpdir(), 'dot-rpc-proj-'))
  const store = new DotStore(undefined)
  void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
  const calls: string[] = []
  const sessions = new Map<string, { cwd?: string; preset?: string }>()
  const notes = { path: '/dot/memory.md', text: '', cognition: '', read: async () => notes.text, readCognition: async () => notes.cognition }
  const host = {
    isRunning: () => false,
    listSessions: async () => [...sessions.keys()].map(id => ({ sessionId: id, running: false, archived: false })),
    latestReply: async () => 'ok',
    readEvents: async () => [],
    cancel: async () => {},
    archive: async () => {},
    modelKey: () => 'fake/model',
    syncModel: () => {},
    createWorkspace: async () => ({ id: 'ws-1', title: 'p', path: project }),
    listWorkspaces: () => [{ id: 'ws-1', title: 'p', path: project }],
    cwdOf: async () => project,
    setReadOnly: async () => true,
    setWritable: async () => true,
    verifyTaskPermission: async () => true,
    findSession: async id => sessions.get(id),
    createSession: async input => {
      const id = input.sessionId ?? `session-${sessions.size}`
      sessions.set(id, { cwd: input.cwd })
      calls.push(`create ${id}`)
      return id
    },
    prompt: async () => { calls.push('prompt') },
    stopActivity: async () => { calls.push('stop'); return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true } },
  }
  const service = new DotService({ host: host as never, store, homeDir: home, notes, approvalGraceMs: 0, timer: { set: (cb, ms) => setTimeout(cb, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now() }, now: () => 1000 })
  return { home, project, store, service, calls, sessions, host }
}

async function readyChange(h: Awaited<ReturnType<typeof setup>>, title = 'Ship', body = 'after', reviewNote = 'built') {
  writeFileSync(join(h.project, 'a.ts'), 'before')
  writeFileSync(join(h.project, 'gone.ts'), 'gone')
  const change = await h.service.createWorkChange({ title, cwd: h.project, goal: 'land it', requirements: [{ requirementRef: 'r1', text: 'edits', required: true }], at: 1 })
  const reserved = await h.service.reserveWorkRun({ changeId: change.id, kind: 'work', cwd: h.project, root: { workspaceRoot: h.project }, writeScope: { kind: 'paths', paths: [{ path: join(h.project, 'a.ts'), type: 'file' }] }, at: 2 })
  if (!reserved.ok) throw new Error(reserved.message)
  const run = reserved.run
  await h.service.captureWorkBaseline(run.id)
  const launched = await h.service.launchWorkRun(run.id, 'edit it')
  if (!launched.ok) throw new Error(launched.message)
  rmSync(join(h.project, 'gone.ts'))
  writeFileSync(join(h.project, 'a.ts'), body)
  const prepared = await h.store.work.prepareFinish(run.id, 'completed', 3)
  if (!prepared.ok) throw new Error(prepared.message)
  const finished = await h.store.work.finishSettled(run.id, prepared.updatedAt, 'completed', { queueCleared: true, agentIdle: true, jobsSettled: true }, 4)
  if (!finished.ok) throw new Error(`finishSettled: ${finished.message}`)
  const review = await h.service.reserveWorkRun({ changeId: change.id, kind: 'review', cwd: h.project, root: { workspaceRoot: h.project }, writeScope: { kind: 'workspace-exclusive' }, at: 5 })
  if (!review.ok) throw new Error(review.message)
  await h.service.captureWorkBaseline(review.run.id)
  const launchedReview = await h.service.launchWorkRun(review.run.id, 'check it')
  if (!launchedReview.ok) throw new Error(launchedReview.message)
  const held = await h.service.holdWorkReview(review.run.id)
  if (!('id' in held)) throw new Error(held.message)

  const subject = await h.service.captureWorkSubject(change.id)
  const current = h.store.work.change(change.id)!
  mkdirSync(join(h.home, 'artifacts', 'evidence'), { recursive: true })
  writeFileSync(join(h.home, 'artifacts', 'evidence', `${run.id}.md`), reviewNote)
  const verified = await h.service.recordWorkVerification(change.id, [{ requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: [`run:${run.id}`], note: reviewNote }], [run.id], {
    inputRef: current.currentInputRef, inputRevision: current.currentRevision,
    reviewRunId: review.run.id, reviewerSessionId: h.store.work.run(review.run.id)!.sessionId, subject,
  })
  if (!('id' in verified) || !verified.subjectKey) throw new Error('verification failed')
  return { change, run, review: review.run, subject, verified, current }
}

describe('work.* RPC contract', () => {
  it('work.list returns the derived projection, never ticket internals', async () => {
    const h = await setup()
    const { change } = await readyChange(h)
    const rows = h.service.store.work.listChanges().map(row => h.service.workBoard(row.id)).filter(row => row !== undefined)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: change.id, status: 'review' })
    expect(rows[0]).not.toHaveProperty('sessions')
    expect(rows[0]).not.toHaveProperty('rounds')
    rmSync(h.project, { recursive: true, force: true })
    rmSync(h.home, { recursive: true, force: true })
  })

  it('work.accept applies the same versioned check as the model accept', async () => {
    const h = await setup()
    const { change, verified, current } = await readyChange(h)
    const stale = await h.service.acceptWork(change.id, verified.id, current.currentInputRef, verified.subjectKey, 'user', {
      expectedInputRevision: current.currentRevision - 1, expectedVerificationId: verified.id,
    })
    expect(stale).toMatchObject({ code: 'stale' })
    const accepted = await h.service.acceptWork(change.id, verified.id, current.currentInputRef, verified.subjectKey, 'user', {
      expectedInputRevision: current.currentRevision, expectedVerificationId: verified.id,
    })
    expect(accepted).toHaveProperty('closeout')
    expect(h.store.work.workView(change.id)?.status).toBe('done')
    rmSync(h.project, { recursive: true, force: true })
    rmSync(h.home, { recursive: true, force: true })
  })

  it('work.answer only writes the pending versioned decision, not the closeout', async () => {
    const h = await setup()
    const { change, verified, current } = await readyChange(h)
    await h.service.manageTask({
      action: 'decide', task_id: change.id, verification_id: verified.id,
      expected_input_revision: current.currentRevision, expected_subject_key: verified.subjectKey,
    })
    const pending = h.service.pending.list().at(-1)!
    expect(h.service.workBoard(change.id)?.humanAction).toBeUndefined()
    await h.service.answerWorkReview(pending.id, true)
    expect(h.service.workBoard(change.id)?.humanAction).toMatchObject({ expectedVerificationId: verified.id })
    expect(h.store.work.change(change.id)?.oversight?.decision).toMatchObject({ result: 'accept', verificationId: verified.id, subjectKey: verified.subjectKey })
    expect(h.store.work.change(change.id)?.closeout).toBeUndefined()
    const rejected = await h.service.answerWorkReview(pending.id, false).catch(error => error)
    expect(rejected).toBeInstanceOf(Error)
    rmSync(h.project, { recursive: true, force: true })
    rmSync(h.home, { recursive: true, force: true })
  })

  it('work.reject releases the settled review without a closeout', async () => {
    const h = await setup()
    const { change, review, verified, current } = await readyChange(h)
    const released = await h.service.rejectWork(change.id, review.id, current.currentRevision)
    expect(released).toMatchObject({ ok: true })
    expect(h.store.work.run(review.id)?.phase).toBe('stopped')
    expect(h.store.work.change(change.id)?.closeout).toBeUndefined()
    expect(h.store.work.workView(change.id)?.status).not.toBe('done')
    rmSync(h.project, { recursive: true, force: true })
    rmSync(h.home, { recursive: true, force: true })
  })

  it('sends an active review back from the board only after its stop is proven', async () => {
    const h = await setup()
    try {
      const change = await h.service.createWorkChange({ title: 'Active review', cwd: h.project, goal: 'check it' })
      const reserved = await h.service.reserveWorkRun({ changeId: change.id, kind: 'review', cwd: h.project, writeScope: { kind: 'workspace-exclusive' } })
      if (!reserved.ok) throw new Error(reserved.message)
      await h.service.captureWorkBaseline(reserved.run.id)
      expect(await h.service.launchWorkRun(reserved.run.id, 'check it')).toMatchObject({ ok: true })
      expect(h.store.work.run(reserved.run.id)?.phase).toBe('active')
      const payload = rejectPayload(h.service.workBoard(change.id)!)!
      expect(payload.reviewRunId).toBe(reserved.run.id)
      expect(await h.service.rejectWork(change.id, reserved.run.id, change.currentRevision + 1)).toMatchObject({ code: 'stale' })
      const other = await h.service.createWorkChange({ title: 'Other', cwd: h.project, goal: 'other' })
      expect(await h.service.rejectWork(other.id, reserved.run.id, other.currentRevision)).toMatchObject({ code: 'missing' })
      expect(h.calls).not.toContain('stop')
      let report!: (value: { cancelAccepted: boolean; queueCleared: boolean; idle: boolean; jobsSettled: boolean }) => void
      let entered!: () => void
      const stopping = new Promise<void>(resolve => { entered = resolve })
      h.host.stopActivity = async () => { entered(); return new Promise(resolve => { report = resolve }) }
      const rejected = h.service.rejectWork(payload.id, payload.reviewRunId, payload.expectedInputRevision)
      await stopping
      expect(h.store.work.run(reserved.run.id)?.phase).toBe('settling')
      expect(h.service.workBoard(change.id)?.blockers).toHaveLength(1)
      report({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: false })
      expect(await rejected).toMatchObject({ ok: false, code: 'unknown' })
      expect(h.store.work.run(reserved.run.id)?.phase).toBe('settling')
      expect(h.service.workBoard(change.id)?.blockers).toHaveLength(1)
      h.host.stopActivity = async () => ({ cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true })
      expect(await h.service.rejectWork(payload.id, payload.reviewRunId, payload.expectedInputRevision)).toMatchObject({ ok: true })
      expect(h.store.work.run(reserved.run.id)).toMatchObject({ phase: 'stopped', closeReason: 'rework', closureEvidence: { jobsSettled: true } })
      expect(h.service.workBoard(change.id)?.blockers).toEqual([])
      expect(h.store.work.change(change.id)?.closeout).toBeUndefined()
    } finally { await h.service.dispose(); rmSync(h.project, { recursive: true, force: true }); rmSync(h.home, { recursive: true, force: true }) }
  })

  it('work.resume finishes a held review only when its closeout already landed', async () => {
    const h = await setup()
    const { change, verified, current } = await readyChange(h)
    const pending = await h.service.resumeWorkCloseout(change.id)
    expect(pending).toMatchObject({ ok: true, released: false })
    const accepted = await h.service.acceptWork(change.id, verified.id, current.currentInputRef, verified.subjectKey, 'user', {
      expectedInputRevision: current.currentRevision, expectedVerificationId: verified.id,
    })
    expect(accepted).toHaveProperty('closeout')
    const released = await h.service.resumeWorkCloseout(change.id)
    expect(released).toMatchObject({ ok: true, released: false })
    rmSync(h.project, { recursive: true, force: true })
    rmSync(h.home, { recursive: true, force: true })
  })

  it('reads the bound evidence body and delivery bytes, and refuses an unbound or deleted source', async () => {
    const h = await setup()
    const marker = 'FINAL_C_EVIDENCE_BODY_7C: npm check exit=0, both A and B verified'
    const { change, run } = await readyChange(h, 'Ship', 'after', marker)


    const view = h.service.workBoard(change.id)
    const source = {
      verificationId: view?.verification?.id ?? '',
      inputRef: view?.verification?.inputRef ?? '',
      inputRevision: view?.verification?.inputRevision ?? 0,
    }
    const bound = h.service.readWorkSource(change.id, 'evidence', `run:${run.id}`, source)
    expect(bound).toMatchObject({ ok: true, source: `evidence:run:${run.id}`, body: marker })
    expect(h.service.readWorkSource(change.id, 'evidence', 'run:run-9', source)).toMatchObject({ ok: false, code: 'stale' })
    expect(h.service.readWorkSource(change.id, 'evidence', '../secret', source)).toMatchObject({ ok: false, code: 'invalid' })
    const delivered = view?.verification?.changes?.find(item => item.kind === 'modified')
    expect(delivered?.path).toBeTruthy()
    const file = h.service.readWorkSource(change.id, 'change', delivered!.path, source)
    expect(file.ok).toBe(true)
    if (file.ok) expect(file.body).toContain('after')
    expect(h.service.readWorkSource(change.id, 'change', 'not-in-this-delivery.txt', source)).toMatchObject({ ok: false, code: 'stale' })
    rmSync(h.project, { recursive: true, force: true })
    rmSync(h.home, { recursive: true, force: true })
  })

  it('resolves a scenario ref bullet-first and a file ref to the delivered snapshot', async () => {
    const h = await setup()
    const report = '### Report\n- r1: a.ts now holds the edit\n- r2: pnpm test passed'
    const { change, run, subject, current } = await readyChange(h, 'Ship', 'after', report)
    const recorded = await h.service.recordWorkVerification(change.id, [
      { requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: [`run:${run.id}#r2`, `run:${run.id}#r9`, 'file:a.ts'] },
    ], [], { inputRef: current.currentInputRef, inputRevision: current.currentRevision, subject })
    if (!('id' in recorded)) throw new Error(recorded.message)
    const bound = { verificationId: recorded.id, inputRef: current.currentInputRef, inputRevision: current.currentRevision }
    const scenario = h.service.readWorkSource(change.id, 'evidence', `run:${run.id}#r2`, bound)
    expect(scenario.ok).toBe(true)
    if (scenario.ok) {
      expect(scenario.source).toBe(`evidence:run:${run.id}#r2`)
      expect(scenario.body.startsWith('- r2: pnpm test passed')).toBe(true)
      expect(scenario.body).toContain('- r1: a.ts now holds the edit')
    }
    expect(h.service.readWorkSource(change.id, 'evidence', `run:${run.id}#r9`, bound)).toMatchObject({ ok: false, code: 'missing' })
    const file = h.service.readWorkSource(change.id, 'evidence', 'file:a.ts', bound)
    expect(file).toMatchObject({ ok: true, source: 'change:a.ts' })
    if (file.ok) expect(file.body).toContain('after')
    rmSync(h.project, { recursive: true, force: true })
    rmSync(h.home, { recursive: true, force: true })
  })

  it('previews long sources and reads the complete bound content on demand without bypassing version checks', async () => {
    const h = await setup()
    const body = `${'验收内容'.repeat(30_000)}\nEND_OF_COMPLETE_SOURCE`
    try {
      const { change, run, verified, current } = await readyChange(h, 'Long delivery', body, body)

      const bound = { verificationId: verified.id, inputRef: current.currentInputRef, inputRevision: current.currentRevision }
      for (const [kind, ref] of [['evidence', `run:${run.id}`], ['change', 'a.ts']] as const) {
        const preview = h.service.readWorkSource(change.id, kind, ref, bound)
        expect(preview).toMatchObject({ ok: true, truncated: true, totalBytes: Buffer.byteLength(body) })
        if (preview.ok) expect(preview.body).not.toContain('END_OF_COMPLETE_SOURCE')
        const full = h.service.readWorkSource(change.id, kind, ref, bound, { forceFull: true })
        expect(full).toMatchObject({ ok: true, truncated: false, body, totalBytes: Buffer.byteLength(body) })
      }
      expect(h.service.readWorkSource(change.id, 'evidence', 'run:run-9', bound, { forceFull: true })).toMatchObject({ ok: false, code: 'stale' })
      await h.service.reviseWorkChange(change.id, { goal: 'changed goal', at: 30 })
      expect(h.service.readWorkSource(change.id, 'change', 'a.ts', bound, { forceFull: true })).toMatchObject({ ok: false, code: 'stale' })
    } finally {
      await h.service.dispose()
      rmSync(h.project, { recursive: true, force: true })
      rmSync(h.home, { recursive: true, force: true })
    }
  })

  it('reads a bound run report file without a registration write API', async () => {
    const h = await setup()
    try {
      const change = await h.service.createWorkChange({ title: 'History', cwd: h.project, goal: 'read history' })
      const recorded = await h.service.recordWorkVerification(change.id, [{ requirementRef: 'goal', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['run:run-1'] }], [], { inputRef: change.currentInputRef, inputRevision: change.currentRevision })
      if (!('id' in recorded)) throw new Error(recorded.message)
      mkdirSync(join(h.home, 'artifacts', 'evidence'), { recursive: true })
      writeFileSync(join(h.home, 'artifacts', 'evidence', 'run-1.md'), 'persisted run report')
      expect(h.service.readWorkSource(change.id, 'evidence', 'run:run-1', { verificationId: recorded.id, inputRef: change.currentInputRef, inputRevision: change.currentRevision })).toMatchObject({ ok: true, body: 'persisted run report' })
      await expect(h.service.manageTask({ action: 'evidence', task_id: change.id, evidence_ref: 'run:run-1', summary: 'replace' })).rejects.toMatchObject({ code: 'dot/invalid' })
      expect(readFileSync(join(h.home, 'artifacts', 'evidence', 'run-1.md'), 'utf8')).toBe('persisted run report')
    } finally { await h.service.dispose(); rmSync(h.project, { recursive: true, force: true }); rmSync(h.home, { recursive: true, force: true }) }
  })

  it.each(['session:review:42', 'test-output'])('refuses an unresolvable evidence reference: %s', async ref => {
    const h = await setup()
    try {
      const change = await h.service.createWorkChange({ title: 'Reference', cwd: h.project, goal: 'show reference' })
      const verification = await h.service.recordWorkVerification(change.id, [{ requirementRef: 'goal', applicability: 'applicable', verdict: 'pass', evidenceRefs: [ref] }], [], { inputRef: change.currentInputRef, inputRevision: change.currentRevision })
      if (!('id' in verification)) throw new Error(verification.message)
      expect(h.service.readWorkSource(change.id, 'evidence', ref, { verificationId: verification.id, inputRef: change.currentInputRef, inputRevision: change.currentRevision })).toMatchObject({ ok: false, code: 'invalid' })
      expect(h.service.readWorkSource(change.id, 'evidence', 'run:run-9', { verificationId: verification.id, inputRef: change.currentInputRef, inputRevision: change.currentRevision })).toMatchObject({ ok: false, code: 'stale' })
    } finally { await h.service.dispose(); rmSync(h.project, { recursive: true, force: true }); rmSync(h.home, { recursive: true, force: true }) }
  })

  it('reports a bound run ref with no captured report as missing', async () => {
    const h = await setup()
    try {
      const change = await h.service.createWorkChange({ title: 'Reference', cwd: h.project, goal: 'show reference' })
      const verification = await h.service.recordWorkVerification(change.id, [{ requirementRef: 'goal', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['run:run-9'] }], [], { inputRef: change.currentInputRef, inputRevision: change.currentRevision })
      if (!('id' in verification)) throw new Error(verification.message)
      expect(h.service.readWorkSource(change.id, 'evidence', 'run:run-9', { verificationId: verification.id, inputRef: change.currentInputRef, inputRevision: change.currentRevision })).toMatchObject({ ok: false, code: 'missing' })
    } finally { await h.service.dispose(); rmSync(h.project, { recursive: true, force: true }); rmSync(h.home, { recursive: true, force: true }) }
  })

  it('refuses a verification body after the input moves on, and does not switch to another verification with the same name', async () => {
    const h = await setup()
    const marker = 'FINAL_C_EVIDENCE_BODY_7C: npm check exit=0, both A and B verified'
    const { change, run, verified, current } = await readyChange(h, 'Ship', 'after', marker)

    const bound = { verificationId: verified.id, inputRef: current.currentInputRef, inputRevision: current.currentRevision }
    expect(h.service.readWorkSource(change.id, 'evidence', `run:${run.id}`, bound)).toMatchObject({ ok: true, body: marker })
    const revised = await h.service.reviseWorkChange(change.id, { goal: 'second', at: 30 })
    if (!('id' in revised)) throw new Error(revised.message)
    expect(revised.currentRevision).toBe(current.currentRevision + 1)
    expect(h.service.workBoard(change.id)?.humanAction).toBeUndefined()
    const stale = h.service.readWorkSource(change.id, 'evidence', `run:${run.id}`, bound)
    expect(stale).toMatchObject({ ok: false, code: 'stale' })
    expect(stale).not.toHaveProperty('body')
    const next = h.store.work.change(change.id)!

    writeFileSync(join(h.home, 'artifacts', 'evidence', 'run-9.md'), 'REV2_ONLY')
    const recorded = await h.service.recordWorkVerification(change.id, [
      { requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['run:run-9'], note: 'REV2_ONLY' },
    ], [], { inputRef: next.currentInputRef, inputRevision: next.currentRevision })
    if (!('id' in recorded)) throw new Error(recorded.message)
    const moved = { verificationId: recorded.id, inputRef: next.currentInputRef, inputRevision: next.currentRevision }
    expect(h.service.readWorkSource(change.id, 'evidence', `run:${run.id}`, moved)).toMatchObject({ ok: false, code: 'stale' })
    expect(h.service.readWorkSource(change.id, 'evidence', 'run:run-9', bound)).toMatchObject({ ok: false, code: 'stale' })
    expect(h.service.readWorkSource(change.id, 'evidence', 'run:run-9', moved)).toMatchObject({ ok: true, body: 'REV2_ONLY' })
    rmSync(h.project, { recursive: true, force: true })
    rmSync(h.home, { recursive: true, force: true })
  })
})

/** Workspace-wide delivery with one modified, one added and one deleted file — and a binary added file. */
async function readyDiffChange(h: Awaited<ReturnType<typeof setup>>) {
  writeFileSync(join(h.project, 'a.ts'), 'line alpha\nline beta\nline gamma\n')
  writeFileSync(join(h.project, 'gone.ts'), 'line gone\n')
  const change = await h.service.createWorkChange({ title: 'Diff it', cwd: h.project, goal: 'land it', requirements: [{ requirementRef: 'r1', text: 'edits', required: true }], at: 1 })
  const reserved = await h.service.reserveWorkRun({ changeId: change.id, kind: 'work', cwd: h.project, root: { workspaceRoot: h.project }, writeScope: { kind: 'workspace-exclusive' }, at: 2 })
  if (!reserved.ok) throw new Error(reserved.message)
  const run = reserved.run
  await h.service.captureWorkBaseline(run.id)
  const launched = await h.service.launchWorkRun(run.id, 'edit it')
  if (!launched.ok) throw new Error(launched.message)
  rmSync(join(h.project, 'gone.ts'))
  writeFileSync(join(h.project, 'a.ts'), 'line alpha\nline beta edited\nline gamma\nline delta\n')
  writeFileSync(join(h.project, 'new.ts'), 'fresh body\n')
  writeFileSync(join(h.project, 'bin.dat'), Buffer.from([0xff, 0xfe, 0x01, 0x02, 0x80, 0x81]))
  const prepared = await h.store.work.prepareFinish(run.id, 'completed', 3)
  if (!prepared.ok) throw new Error(prepared.message)
  const finished = await h.store.work.finishSettled(run.id, prepared.updatedAt, 'completed', { queueCleared: true, agentIdle: true, jobsSettled: true }, 4)
  if (!finished.ok) throw new Error(`finishSettled: ${finished.message}`)
  const review = await h.service.reserveWorkRun({ changeId: change.id, kind: 'review', cwd: h.project, root: { workspaceRoot: h.project }, writeScope: { kind: 'workspace-exclusive' }, at: 5 })
  if (!review.ok) throw new Error(review.message)
  await h.service.captureWorkBaseline(review.run.id)
  const launchedReview = await h.service.launchWorkRun(review.run.id, 'check it')
  if (!launchedReview.ok) throw new Error(launchedReview.message)
  const held = await h.service.holdWorkReview(review.run.id)
  if (!('id' in held)) throw new Error(held.message)
  const subject = await h.service.captureWorkSubject(change.id)
  const current = h.store.work.change(change.id)!
  mkdirSync(join(h.home, 'artifacts', 'evidence'), { recursive: true })
  writeFileSync(join(h.home, 'artifacts', 'evidence', `${run.id}.md`), 'built')
  const verified = await h.service.recordWorkVerification(change.id, [
    { requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: [`run:${run.id}`], note: 'built' },
  ], [run.id], {
    inputRef: current.currentInputRef, inputRevision: current.currentRevision,
    reviewRunId: review.run.id, reviewerSessionId: h.store.work.run(review.run.id)!.sessionId, subject,
  })
  if (!('id' in verified) || !verified.subjectKey) throw new Error('verification failed')
  return { change, run, review: review.run, subject, verified, current }
}

describe('work.read diff view', () => {
  it('diffs modified, added and deleted deliveries against the writer baseline', async () => {
    const h = await setup()
    const { change, subject, verified, current } = await readyDiffChange(h)
    expect(subject.changes.map(row => `${row.kind}:${row.path}`)).toEqual(
      expect.arrayContaining(['modified:a.ts', 'deleted:gone.ts', 'added:new.ts', 'added:bin.dat']),
    )
    // Both the writer's and the review's baselines are bound; the writer one is the left side.
    expect(subject.baselineRefs.length).toBeGreaterThanOrEqual(2)
    const bound = { verificationId: verified.id, inputRef: current.currentInputRef, inputRevision: current.currentRevision }
    const modified = h.service.readWorkSource(change.id, 'change', 'a.ts', bound, { view: 'diff' })
    expect(modified.ok).toBe(true)
    if (modified.ok) {
      expect(modified.body).toContain('--- a/a.ts')
      expect(modified.body).toContain('+++ b/a.ts')
      expect(modified.body).toContain('-line beta')
      expect(modified.body).toContain('+line beta edited')
      expect(modified.body).toContain('+line delta')
    }
    const added = h.service.readWorkSource(change.id, 'change', 'new.ts', bound, { view: 'diff' })
    expect(added.ok).toBe(true)
    if (added.ok) {
      expect(added.body).toContain('+fresh body')
      expect(added.body).not.toContain('-line')
    }
    const deleted = h.service.readWorkSource(change.id, 'change', 'gone.ts', bound, { view: 'diff' })
    expect(deleted.ok).toBe(true)
    if (deleted.ok) {
      expect(deleted.body).toContain('-line gone')
      expect(deleted.body).not.toContain('+line')
    }
    rmSync(h.project, { recursive: true, force: true })
    rmSync(h.home, { recursive: true, force: true })
  })

  it('refuses binary or oversized diff sides and keeps the full read', async () => {
    const h = await setup()
    const { change, verified, current } = await readyDiffChange(h)
    const bound = { verificationId: verified.id, inputRef: current.currentInputRef, inputRevision: current.currentRevision }
    const binary = h.service.readWorkSource(change.id, 'change', 'bin.dat', bound, { view: 'diff' })
    expect(binary).toMatchObject({ ok: false, code: 'invalid' })
    if (!binary.ok) expect(binary.message).toContain('open the full file')
    writeFileSync(join(h.project, 'big.txt'), 'x'.repeat(300_000))
    const rebaseline = await h.service.captureWorkSubject(change.id)
    const now = h.store.work.change(change.id)!
    const reverify = await h.service.recordWorkVerification(change.id, [
      { requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: [] },
    ], [], { inputRef: now.currentInputRef, inputRevision: now.currentRevision, subject: rebaseline })
    if (!('id' in reverify)) throw new Error(reverify.message)
    const rebound = { verificationId: reverify.id, inputRef: now.currentInputRef, inputRevision: now.currentRevision }
    expect(h.service.readWorkSource(change.id, 'change', 'big.txt', rebound, { view: 'diff' })).toMatchObject({ ok: false, code: 'invalid' })
    // The oversized row still reads through the full view, truncated as usual.
    expect(h.service.readWorkSource(change.id, 'change', 'big.txt', rebound)).toMatchObject({ ok: true, truncated: true })
    // Staleness and kind checks apply before any diff work.
    expect(h.service.readWorkSource(change.id, 'change', 'a.ts', { ...bound, verificationId: 'v-nope' }, { view: 'diff' })).toMatchObject({ ok: false, code: 'stale' })
    expect(h.service.readWorkSource(change.id, 'evidence', 'file:a.ts', bound, { view: 'diff' })).toMatchObject({ ok: false, code: 'invalid' })
    rmSync(h.project, { recursive: true, force: true })
    rmSync(h.home, { recursive: true, force: true })
  })
})
