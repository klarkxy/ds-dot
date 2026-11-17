import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureScope, readSnapshot, saveSnapshot, sha256 } from './artifacts.ts'
import { subjectKey, type DeliverySubject, type SubjectLook } from './acceptance.ts'
import { WorkBook, type WorkPersist } from './work.ts'

const evidence = { queueCleared: true, agentIdle: true, jobsSettled: true }
const pass = [{ requirementRef: 'r1', applicability: 'applicable' as const, verdict: 'pass' as const, evidenceRefs: ['log'] }]

function bind(dir: string): SubjectLook {
  return {
    read(ref) {
      try {
        const manifest = readSnapshot(join(dir, ref)).manifest
        return { root: manifest.root, saved: manifest.saved, deleted: manifest.deleted, exclusions: manifest.exclusions }
      } catch { return undefined }
    },
    live(root) {
      try { return captureScope(root, root, 'directory').files.map(file => file.path) } catch { return undefined }
    },
    boundaries(root) {
      try { return [...captureScope(root, root, 'directory').exclusions] } catch { return undefined }
    },
    body(root, path) {
      try { return new Uint8Array(readFileSync(join(root, ...path.split('/')))) } catch { return undefined }
    },
  }
}

async function ready(persist?: WorkPersist) {
  const project = mkdtempSync(join(tmpdir(), 'dot-subject-'))
  const artifacts = mkdtempSync(join(tmpdir(), 'dot-artifacts-'))
  mkdirSync(join(artifacts, 'evidence'), { recursive: true })
  const before = new TextEncoder().encode('before')
  writeFileSync(join(project, 'a.ts'), before)
  const book = new WorkBook(persist ?? (async () => undefined), 'win32')
  const change = await book.createChange({
    title: 'Ship', cwd: project, goal: 'land',
    requirements: [{ requirementRef: 'r1', text: 'builds', required: true }], at: 1,
  })
  const reserved = await book.reserveRun({
    changeId: change.id, cwd: project, root: { workspaceRoot: project },
    writeScope: { kind: 'paths', paths: [{ path: join(project, 'a.ts'), type: 'file' }] }, at: 2,
  })
  if (!reserved.ok) throw new Error(reserved.message)
  const root = reserved.run.workspaceRoot
  saveSnapshot(join(artifacts, 'base-1'), [{ path: 'a.ts', body: before }], undefined, { root })
  expect((await book.publishBaseline(reserved.run.id, book.revision, 'base-1', 3)).applied).toBe(true)
  const writer = book.run(reserved.run.id)!
  expect((await book.confirmSession(writer.id, { sessionId: writer.requestedSessionId, cwd: writer.cwd }, 4)).ok).toBe(true)
  await book.prepareFinish(writer.id, 'completed', 5)
  expect((await book.finishSettled(writer.id, book.run(writer.id)!.updatedAt, 'completed', evidence, 6)).ok).toBe(true)
  const review = await book.reserveRun({
    changeId: change.id, kind: 'review', cwd: project, root: { workspaceRoot: project },
    writeScope: { kind: 'workspace-exclusive' }, at: 7,
  })
  if (!review.ok) throw new Error(review.message)
  expect((await book.confirmSession(review.run.id, { sessionId: review.run.requestedSessionId, cwd: review.run.cwd }, 8)).ok).toBe(true)
  const initial = book.run(review.run.id)!.deliveries.find(item => item.kind === 'initial')!
  expect((await book.settleDelivery(review.run.id, initial.id, 'accepted', undefined, 8)).ok).toBe(true)
  expect('id' in await book.holdReview(review.run.id, evidence, 9)).toBe(true)
  const after = new TextEncoder().encode('after')
  writeFileSync(join(project, 'a.ts'), after)
  saveSnapshot(join(artifacts, 'delivery-1'), [{ path: 'a.ts', body: after }], undefined, { root })
  writeFileSync(join(artifacts, 'evidence', 'log'), 'passed')
  const held = book.run(review.run.id)!
  const subject: DeliverySubject = {
    workspaceRoot: root, cwd: held.cwd, baselineRefs: book.change(change.id)!.baselineRefs,
    artifactRef: 'delivery-1', changes: [{ path: 'a.ts', kind: 'modified', sha256: sha256(after) }],
    protectedDirty: [], exclusions: [],
  }
  const verification = await book.recordVerification(change.id, pass, [reserved.run.id], 10, {
    inputRef: change.currentInputRef, inputRevision: change.currentRevision,
    reviewRunId: review.run.id, reviewerSessionId: held.sessionId, subject,
  })
  if (!('id' in verification)) throw new Error(verification.message)
  const cleanup = () => { rmSync(project, { recursive: true, force: true }); rmSync(artifacts, { recursive: true, force: true }) }
  return { book, change, subject, verification, reviewId: review.run.id, writerId: reserved.run.id, project, artifacts, look: bind(artifacts), cleanup }
}

describe('shared delivery and closeout', () => {
  it('accepts only the current input and subject, then releases the review', async () => {
    const { book, change, subject, verification, reviewId, cleanup, look } = await ready()
    const key = verification.subjectKey!
    const accepted = await book.accept(change.id, verification.id, change.currentInputRef, key, 'user', 11, {
      expectedInputRevision: change.currentRevision, expectedVerificationId: verification.id,
    }, look)
    expect(accepted).toMatchObject({ closeout: { verificationId: verification.id, inputRef: change.currentInputRef, subjectKey: key } })
    expect(book.run(reviewId)?.phase).toBe('stopped')
    expect(book.occupying()).toEqual([])
    expect(book.workView(change.id)?.status).toBe('done')
    expect(book.workView(change.id)?.humanAction).toBeUndefined()
    expect(await book.reserveRun({ changeId: change.id, cwd: change.cwd, writeScope: { kind: 'paths', paths: [] }, at: 12 })).toMatchObject({ code: 'closed' })
    expect(await book.closeOut(change.id, verification.id, 'user', 13)).toMatchObject({ code: 'closed' })
    const reopened = await book.reviseChange(change.id, { goal: 'again', at: 14 })
    if (!('id' in reopened)) throw new Error('expected revision')
    expect(reopened.closeout).toBeUndefined()
    expect((await book.reserveRun({ changeId: change.id, cwd: change.cwd, writeScope: { kind: 'paths', paths: [] }, at: 15 })).ok).toBe(true)
    cleanup()
  })

  it('refuses a missing snapshot, a changed workspace, a changed input, and an old human version', async () => {
    const missing = await ready()
    rmSync(join(missing.artifacts, 'delivery-1'), { recursive: true, force: true })
    expect(await missing.book.accept(missing.change.id, missing.verification.id, missing.change.currentInputRef, missing.verification.subjectKey!, 'user', 12, {
      expectedInputRevision: missing.change.currentRevision, expectedVerificationId: missing.verification.id,
    }, missing.look)).toMatchObject({ code: 'baseline' })
    expect(missing.book.change(missing.change.id)?.closeout).toBeUndefined()
    expect(missing.book.occupying().map(run => run.id)).toEqual([missing.reviewId])
    missing.cleanup()

    const unread = await ready()
    rmSync(join(unread.artifacts, 'evidence', 'log'), { force: true })
    // Historical registry files do not determine the immutable checks.
    expect(await unread.book.accept(unread.change.id, unread.verification.id, unread.change.currentInputRef, unread.verification.subjectKey!, 'user', 12, {
      expectedInputRevision: unread.change.currentRevision, expectedVerificationId: unread.verification.id,
    }, unread.look)).toHaveProperty('closeout')
    unread.cleanup()

    const dirty = await ready()
    writeFileSync(join(dirty.project, 'a.ts'), 'tampered')
    expect(await dirty.book.accept(dirty.change.id, dirty.verification.id, dirty.change.currentInputRef, dirty.verification.subjectKey!, 'user', 12, {
      expectedInputRevision: dirty.change.currentRevision, expectedVerificationId: dirty.verification.id,
    }, dirty.look)).toMatchObject({ code: 'baseline' })
    expect(dirty.book.change(dirty.change.id)?.closeout).toBeUndefined()
    dirty.cleanup()

    const changed = await ready()
    await changed.book.reviseChange(changed.change.id, { goal: 'later', at: 11 })
    expect(await changed.book.accept(changed.change.id, changed.verification.id, changed.verification.inputRef, changed.verification.subjectKey!, 'user', 12)).toMatchObject({ code: 'stale' })
    expect(changed.book.change(changed.change.id)?.closeout).toBeUndefined()
    changed.cleanup()

    const old = await ready()
    expect(await old.book.accept(old.change.id, old.verification.id, old.change.currentInputRef, old.verification.subjectKey!, 'user', 12, {
      expectedInputRevision: 0, expectedVerificationId: old.verification.id,
    }, old.look)).toMatchObject({ code: 'stale' })
    expect(old.book.occupying().map(run => run.id)).toEqual([old.reviewId])
    old.cleanup()
  })

  it('owns immutable review notes and binds checks into the decision key', async () => {
    const h = await ready()
    try {
      const checks = [{ requirementRef: 'r1', applicability: 'applicable' as const, verdict: 'pass' as const, evidenceRefs: ['event:session-run-1:7'], note: 'test output passed' }]
      const detail = { inputRef: h.change.currentInputRef, inputRevision: h.change.currentRevision, subject: h.subject }
      const first = await h.book.recordVerification(h.change.id, checks, [h.writerId], 12, detail)
      if (!('id' in first)) throw new Error(first.message)
      checks[0]!.note = 'edited later'
      checks[0]!.evidenceRefs.push('test:other')
      expect(first.checks[0]!.note).toBe('test output passed')
      expect(first.checks[0]!.evidenceRefs).toEqual(['event:session-run-1:7'])
      const later = await h.book.recordVerification(h.change.id, checks, [h.writerId], 13, detail)
      if (!('id' in later)) throw new Error(later.message)
      expect(first.subjectKey).not.toBe(later.subjectKey)
      expect(() => (first.checks[0] as { note: string }).note = 'mutated').toThrow()
    } finally { h.cleanup() }
  })

  it('keeps the tested input, review session, and root on the verification', async () => {
    const { book, change, verification, reviewId, writerId, subject, look, cleanup } = await ready()
    const writer = book.run(writerId)!
    const impersonated = await book.recordVerification(change.id, pass, [writerId], 11, {
      inputRef: verification.inputRef, inputRevision: verification.inputRevision,
      reviewRunId: reviewId, reviewerSessionId: writer.sessionId, subject,
    })
    expect(impersonated).toMatchObject({ code: 'ownership' })
    const unstarted = WorkBook.restore({
      changes: [book.change(change.id)], inputs: [book.input(change.currentInputRef)],
      runs: [{ ...book.run(reviewId)!, creation: 'intent', sessionId: undefined }, writer],
      verifications: [],
    }, async () => undefined, 'win32')
    expect(await unstarted.recordVerification(change.id, pass, [writerId], 12, {
      inputRef: verification.inputRef, inputRevision: verification.inputRevision,
      reviewRunId: reviewId, reviewerSessionId: writer.requestedSessionId, subject,
    })).toMatchObject({ code: 'unknown' })
    const elsewhere = WorkBook.restore({
      changes: [book.change(change.id)], inputs: [book.input(change.currentInputRef)],
      runs: [{ ...book.run(reviewId)!, workspaceRoot: 'H:\\else', cwd: 'H:\\else' }, writer],
      verifications: [],
    }, async () => undefined, 'win32')
    expect(await elsewhere.recordVerification(change.id, pass, [writerId], 13, {
      inputRef: verification.inputRef, inputRevision: verification.inputRevision,
      reviewRunId: reviewId, reviewerSessionId: book.run(reviewId)!.sessionId, subject,
    })).toMatchObject({ code: 'ownership' })

    await book.reviseChange(change.id, { goal: 'later', at: 12 })
    const stamped = await book.recordVerification(change.id, pass, [writerId], 13, {
      inputRef: verification.inputRef, inputRevision: verification.inputRevision,
      reviewRunId: reviewId, reviewerSessionId: book.run(reviewId)!.sessionId, subject,
    })
    expect(stamped).toMatchObject({ inputRef: verification.inputRef, inputRevision: verification.inputRevision })
    expect(await book.accept(change.id, verification.id, book.change(change.id)!.currentInputRef, verification.subjectKey!, 'user', 14, {
      expectedInputRevision: book.change(change.id)!.currentRevision, expectedVerificationId: verification.id,
    }, look)).toMatchObject({ code: 'stale' })
    expect(book.change(change.id)?.closeout).toBeUndefined()
    cleanup()
  })

  it('does not accept an old pass after a later rework, and reject keeps an unknown review', async () => {
    const { book, change, verification, reviewId, writerId, subject, look, cleanup } = await ready()
    const failed = await book.recordVerification(change.id, [{ requirementRef: 'r1', applicability: 'applicable', verdict: 'fail', evidenceRefs: ['log'] }], [writerId], 11, {
      inputRef: verification.inputRef, inputRevision: verification.inputRevision,
      reviewRunId: reviewId, reviewerSessionId: book.run(reviewId)!.sessionId, subject,
    })
    if (!('id' in failed)) throw new Error('expected rework')
    expect(failed.verdict).toBe('rework')
    expect(await book.accept(change.id, verification.id, change.currentInputRef, verification.subjectKey!, 'user', 12, {
      expectedInputRevision: change.currentRevision, expectedVerificationId: verification.id,
    }, look)).toMatchObject({ code: 'stale' })
    expect(book.workView(change.id)?.status).toBe('rework')
    expect(book.workView(change.id)?.closeout).toBeUndefined()
    cleanup()

    const rejected = await ready()
    const review = rejected.book.run(rejected.reviewId)!
    const poisoned = {
      ...review, creation: 'unknown' as const,
      deliveries: review.deliveries.map(item => ({ ...item, status: 'unknown' as const })),
    }
    const restored = WorkBook.restore({
      changes: [rejected.book.change(rejected.change.id)], inputs: [rejected.book.input(rejected.change.currentInputRef)],
      runs: [poisoned, rejected.book.run(rejected.writerId)], verifications: [rejected.verification],
    }, async () => undefined, 'win32')
    expect(await restored.reopenAfterReview(rejected.change.id, rejected.reviewId, 12, rejected.change.currentRevision)).toMatchObject({ code: 'unknown' })
    expect(restored.occupying().map(run => run.id)).toEqual([rejected.reviewId])
    expect(restored.change(rejected.change.id)?.closeout).toBeUndefined()
    rejected.cleanup()
  })

  it('keeps the review when its stop is unknown, and releases it without a closeout on rejection', async () => {
    const { book, change, verification, reviewId, writerId, look, cleanup } = await ready()
    const review = book.run(reviewId)!
    const uncleared = { ...review, closureEvidence: { queueCleared: true, agentIdle: true, jobsSettled: false } }
    const blocked = WorkBook.restore({
      changes: [book.change(change.id)], inputs: [book.input(change.currentInputRef)],
      runs: [uncleared, book.run(writerId)!], verifications: [verification],
    }, async () => undefined, 'win32')
    expect(await blocked.accept(change.id, verification.id, change.currentInputRef, verification.subjectKey!, 'user', 12, {
      expectedInputRevision: change.currentRevision, expectedVerificationId: verification.id,
    }, look)).toMatchObject({ code: 'unknown' })
    expect(blocked.occupying().map(run => run.id)).toEqual([reviewId])
    expect(await blocked.reopenAfterReview(change.id, reviewId, 13, change.currentRevision)).toMatchObject({ code: 'unknown' })
    cleanup()

    const rejected = await ready()
    const released = await rejected.book.reopenAfterReview(rejected.change.id, rejected.reviewId, 12, rejected.change.currentRevision)
    expect(released).toMatchObject({ ok: true })
    expect(rejected.book.change(rejected.change.id)?.closeout).toBeUndefined()
    expect(rejected.book.run(rejected.reviewId)?.phase).toBe('stopped')
    const follow = await rejected.book.reserveRun({
      changeId: rejected.change.id, kind: 'rework', cwd: rejected.project, root: { workspaceRoot: rejected.project },
      writeScope: { kind: 'paths', paths: [{ path: join(rejected.project, 'a.ts'), type: 'file' }] }, reworkOf: rejected.writerId, at: 13,
    })
    expect(follow.ok).toBe(true)
    rejected.cleanup()
  })

  it('requires a recorded user decision when oversight was requested', async () => {
    const { book, change, verification, look, cleanup } = await ready()
    expect('id' in await book.requestOversight(change.id, 11)).toBe(true)
    expect(await book.accept(change.id, verification.id, change.currentInputRef, verification.subjectKey!, 'tool', 12, {
      expectedInputRevision: change.currentRevision, expectedVerificationId: verification.id,
    }, look)).toMatchObject({ code: 'stale' })
    expect(book.change(change.id)?.closeout).toBeUndefined()
    expect('id' in await book.noteOversight(change.id, {
      result: 'accept', verificationId: verification.id, subjectKey: verification.subjectKey, source: 'user', expectedInputRevision: change.currentRevision,
    }, 13)).toBe(true)
    expect(await book.accept(change.id, verification.id, change.currentInputRef, verification.subjectKey!, 'tool', 14, {
      expectedInputRevision: change.currentRevision, expectedVerificationId: verification.id,
    }, look)).toMatchObject({ closeout: { verificationId: verification.id } })
    cleanup()
  })

  it('rejects an empty snapshot and a file added after the snapshot, and accepts a recorded deletion', async () => {
    const late = await ready()
    writeFileSync(join(late.project, 'late.ts'), 'later')
    expect(await late.book.accept(late.change.id, late.verification.id, late.change.currentInputRef, late.verification.subjectKey!, 'user', 12, {
      expectedInputRevision: late.change.currentRevision, expectedVerificationId: late.verification.id,
    }, late.look)).toMatchObject({ code: 'baseline' })
    expect(late.book.change(late.change.id)?.closeout).toBeUndefined()
    late.cleanup()

    const empty = await ready()
    const root = empty.book.run(empty.reviewId)!.workspaceRoot
    saveSnapshot(join(empty.artifacts, 'empty-delivery'), [], undefined, { root, empty: true })
    const hollow: DeliverySubject = { ...empty.subject, artifactRef: 'empty-delivery', changes: [], protectedDirty: [] }
    const recorded = await empty.book.recordVerification(empty.change.id, pass, [empty.writerId], 12, {
      inputRef: empty.verification.inputRef, inputRevision: empty.verification.inputRevision,
      reviewRunId: empty.reviewId, reviewerSessionId: empty.book.run(empty.reviewId)!.sessionId, subject: hollow,
    })
    if (!('id' in recorded)) throw new Error(recorded.message)
    expect(await empty.book.accept(empty.change.id, recorded.id, empty.change.currentInputRef, recorded.subjectKey!, 'user', 13, {
      expectedInputRevision: empty.change.currentRevision, expectedVerificationId: recorded.id,
    }, empty.look)).toMatchObject({ code: 'baseline' })
    empty.cleanup()

    const project = mkdtempSync(join(tmpdir(), 'dot-gone-'))
    const artifacts = mkdtempSync(join(tmpdir(), 'dot-gone-art-'))
    mkdirSync(join(artifacts, 'evidence'), { recursive: true })
    const before = new TextEncoder().encode('keep')
    const gone = new TextEncoder().encode('gone')
    writeFileSync(join(project, 'a.ts'), before)
    writeFileSync(join(project, 'gone.ts'), gone)
    const book = new WorkBook(async () => undefined, 'win32')
    const change = await book.createChange({ title: 'Trim', cwd: project, goal: 'drop', requirements: [{ requirementRef: 'r1', text: 'builds', required: true }], at: 1 })
    const writer = await book.reserveRun({ changeId: change.id, cwd: project, root: { workspaceRoot: project }, writeScope: { kind: 'paths', paths: [{ path: project, type: 'directory' }] }, at: 2 })
    if (!writer.ok) throw new Error(writer.message)
    const workspace = writer.run.workspaceRoot
    saveSnapshot(join(artifacts, 'base-gone'), [{ path: 'a.ts', body: before }, { path: 'gone.ts', body: gone }], undefined, { root: workspace })
    expect((await book.publishBaseline(writer.run.id, book.revision, 'base-gone', 3)).applied).toBe(true)
    expect((await book.confirmSession(writer.run.id, { sessionId: writer.run.requestedSessionId, cwd: writer.run.cwd }, 4)).ok).toBe(true)
    await book.prepareFinish(writer.run.id, 'completed', 5)
    expect((await book.finishSettled(writer.run.id, book.run(writer.run.id)!.updatedAt, 'completed', evidence, 6)).ok).toBe(true)
    rmSync(join(project, 'gone.ts'))
    const review = await book.reserveRun({ changeId: change.id, kind: 'review', cwd: project, root: { workspaceRoot: project }, writeScope: { kind: 'workspace-exclusive' }, at: 7 })
    if (!review.ok) throw new Error(review.message)
    expect((await book.confirmSession(review.run.id, { sessionId: review.run.requestedSessionId, cwd: review.run.cwd }, 8)).ok).toBe(true)
    const initial = book.run(review.run.id)!.deliveries.find(item => item.kind === 'initial')!
    expect((await book.settleDelivery(review.run.id, initial.id, 'accepted', undefined, 8)).ok).toBe(true)
    expect('id' in await book.holdReview(review.run.id, evidence, 9)).toBe(true)
    saveSnapshot(join(artifacts, 'delivery-gone'), [{ path: 'a.ts', body: before }, { path: 'gone.ts', deleted: true }], undefined, { root: workspace })
    writeFileSync(join(artifacts, 'evidence', 'log'), 'passed')
    const subject: DeliverySubject = {
      workspaceRoot: workspace, cwd: book.run(review.run.id)!.cwd, baselineRefs: book.change(change.id)!.baselineRefs,
      artifactRef: 'delivery-gone', changes: [{ path: 'gone.ts', kind: 'deleted' }], protectedDirty: ['a.ts'], exclusions: [],
    }
    const verification = await book.recordVerification(change.id, pass, [writer.run.id], 10, {
      inputRef: change.currentInputRef, inputRevision: change.currentRevision,
      reviewRunId: review.run.id, reviewerSessionId: book.run(review.run.id)!.sessionId, subject,
    })
    if (!('id' in verification)) throw new Error(verification.message)
    expect(await book.accept(change.id, verification.id, change.currentInputRef, verification.subjectKey!, 'user', 11, {
      expectedInputRevision: change.currentRevision, expectedVerificationId: verification.id,
    }, bind(artifacts))).toMatchObject({ closeout: { verificationId: verification.id } })
    rmSync(project, { recursive: true, force: true })
    rmSync(artifacts, { recursive: true, force: true })
  })

  it('rejects a snapshot file that was deleted or renamed after capture', async () => {
    const deleted = await ready()
    rmSync(join(deleted.project, 'a.ts'))
    const refused = await deleted.book.accept(deleted.change.id, deleted.verification.id, deleted.change.currentInputRef, deleted.verification.subjectKey!, 'user', 12, {
      expectedInputRevision: deleted.change.currentRevision, expectedVerificationId: deleted.verification.id,
    }, deleted.look)
    expect(refused).toMatchObject({ code: 'baseline' })
    expect('message' in refused && refused.message).toMatch(/gone/)
    expect(deleted.book.change(deleted.change.id)?.closeout).toBeUndefined()
    deleted.cleanup()

    const renamed = await ready()
    rmSync(join(renamed.project, 'a.ts'))
    writeFileSync(join(renamed.project, 'b.ts'), 'renamed')
    const drifted = await renamed.book.accept(renamed.change.id, renamed.verification.id, renamed.change.currentInputRef, renamed.verification.subjectKey!, 'user', 12, {
      expectedInputRevision: renamed.change.currentRevision, expectedVerificationId: renamed.verification.id,
    }, renamed.look)
    expect(drifted).toMatchObject({ code: 'baseline' })
    expect(renamed.book.change(renamed.change.id)?.closeout).toBeUndefined()
    renamed.cleanup()
  })

  it('rejects a modified file disguised as protected dirty, and an unchanged file disguised as added', async () => {
    const forged = await ready()
    const disguised: DeliverySubject = { ...forged.subject, changes: [], protectedDirty: ['a.ts'] }
    const recorded = await forged.book.recordVerification(forged.change.id, pass, [forged.writerId], 12, {
      inputRef: forged.verification.inputRef, inputRevision: forged.verification.inputRevision,
      reviewRunId: forged.reviewId, reviewerSessionId: forged.book.run(forged.reviewId)!.sessionId, subject: disguised,
    })
    if (!('id' in recorded)) throw new Error(recorded.message)
    expect(await forged.book.accept(forged.change.id, recorded.id, forged.change.currentInputRef, recorded.subjectKey!, 'user', 13, {
      expectedInputRevision: forged.change.currentRevision, expectedVerificationId: recorded.id,
    }, forged.look)).toMatchObject({ code: 'baseline' })
    expect(forged.book.change(forged.change.id)?.closeout).toBeUndefined()
    forged.cleanup()

    const same = await ready()
    const before = new TextEncoder().encode('before')
    writeFileSync(join(same.project, 'a.ts'), before)
    const root = same.book.run(same.reviewId)!.workspaceRoot
    saveSnapshot(join(same.artifacts, 'delivery-same'), [{ path: 'a.ts', body: before }], undefined, { root })
    const added: DeliverySubject = {
      ...same.subject, artifactRef: 'delivery-same',
      changes: [{ path: 'a.ts', kind: 'added', sha256: sha256(before) }], protectedDirty: [],
    }
    const mislabeled = await same.book.recordVerification(same.change.id, pass, [same.writerId], 12, {
      inputRef: same.verification.inputRef, inputRevision: same.verification.inputRevision,
      reviewRunId: same.reviewId, reviewerSessionId: same.book.run(same.reviewId)!.sessionId, subject: added,
    })
    if (!('id' in mislabeled)) throw new Error(mislabeled.message)
    expect(await same.book.accept(same.change.id, mislabeled.id, same.change.currentInputRef, mislabeled.subjectKey!, 'user', 13, {
      expectedInputRevision: same.change.currentRevision, expectedVerificationId: mislabeled.id,
    }, same.look)).toMatchObject({ code: 'baseline' })
    expect(same.book.change(same.change.id)?.closeout).toBeUndefined()
    same.cleanup()
  })

  it('closes new deliveries before stop and ignores a stop receipt that arrived after a change', async () => {
    const { book, reviewId, writerId, change, cleanup } = await ready()
    const sent = book.run(reviewId)!
    const open = { ...sent, phase: 'active' as const, closureEvidence: undefined }
    const restored = WorkBook.restore({
      changes: [book.change(change.id)], inputs: [book.input(change.currentInputRef)],
      runs: [open, book.run(writerId)!], verifications: [],
    }, async () => undefined, 'win32')
    const prepared = await restored.prepareReviewHold(reviewId, 20)
    if (!prepared.ok) throw new Error(prepared.message)
    expect(restored.run(reviewId)?.phase).toBe('settling')
    expect(await restored.addDelivery(reviewId, { kind: 'context', targetSessionId: open.sessionId!, inputRevision: open.inputRevision, contentRef: 'late', source: 'dot', status: 'accepted', at: 21 })).toMatchObject({ code: 'closed-run' })
    expect((await restored.noteObservation(reviewId, 'during stop', 21)).ok).toBe(true)
    expect(await restored.completeReviewHold(reviewId, prepared.updatedAt, evidence, 22)).toMatchObject({ code: 'stale' })
    expect(restored.run(reviewId)?.closureEvidence).toBeUndefined()
    const unsent = WorkBook.restore({
      changes: [book.change(change.id)], inputs: [book.input(change.currentInputRef)],
      runs: [{ ...sent, phase: 'active' as const, closureEvidence: undefined, deliveries: sent.deliveries.map(item => item.kind === 'initial' ? { ...item, status: 'intent' as const } : item) }, book.run(writerId)!],
      verifications: [],
    }, async () => undefined, 'win32')
    expect(await unsent.prepareReviewHold(reviewId, 23)).toMatchObject({ code: 'unknown' })
    expect(await unsent.holdReview(reviewId, evidence, 24)).toMatchObject({ code: 'unknown' })
    cleanup()
  })

  it('finishes a review left behind by a half-written closeout and ignores a late observation', async () => {
    const rows = new Map<string, unknown>()
    let failRelease = false
    const { book, change, verification, reviewId, look, cleanup } = await ready(async (table, key, value) => {
      if (failRelease && table === 'runs') throw new Error('run disk')
      rows.set(`${table}:${key}`, structuredClone(value))
    })
    failRelease = true
    await expect(book.accept(change.id, verification.id, change.currentInputRef, verification.subjectKey!, 'user', 12, {
      expectedInputRevision: change.currentRevision, expectedVerificationId: verification.id,
    }, look)).rejects.toThrow('run disk')
    expect(book.change(change.id)?.closeout?.verificationId).toBe(verification.id)
    expect(book.run(reviewId)?.phase).toBe('settling')
    const restored = WorkBook.restore({
      changes: [...rows.values()].filter(row => (row as { title?: string }).title),
      inputs: [...rows.values()].filter(row => (row as { goal?: string }).goal !== undefined),
      runs: [...rows.values()].filter(row => (row as { phase?: string }).phase),
      verifications: [...rows.values()].filter(row => (row as { verdict?: string }).verdict),
    }, async () => undefined, 'win32')
    expect(await restored.resumeCloseout(change.id, 13)).toEqual({ ok: true, released: true })
    expect(await restored.resumeCloseout(change.id, 14)).toEqual({ ok: true, released: false })
    expect(await restored.noteObservation(reviewId, 'late pass', 15)).toEqual({ ok: true, phase: 'stopped' })
    expect(restored.run(reviewId)?.phase).toBe('stopped')
    expect(restored.workView(change.id)?.status).toBe('done')
    cleanup()
  })
})
