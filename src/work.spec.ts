import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSnapshot, saveSnapshot, sha256, baselineCaptures } from './artifacts.ts'
import { WorkBook, judgeVerification, occupantsConflict, parseInput, workspaceIdentity, type ExternalOccupant, type WorkPersist } from './work.ts'

function memoryPersist(fail?: () => boolean): { persist: WorkPersist; rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>()
  const persist: WorkPersist = async (table, key, value) => {
    if (fail?.()) throw new Error('disk failure')
    rows.set(`${table}:${key}`, structuredClone(value))
  }
  return { persist, rows }
}

function openBook(fail?: () => boolean): { book: WorkBook; rows: Map<string, unknown> } {
  const stored = memoryPersist(fail)
  return { book: new WorkBook(stored.persist, 'win32'), rows: stored.rows }
}

function unknownState(): Error {
  const error = new Error('durable outcome unknown')
  ;(error as { code?: string }).code = 'unknown-state'
  return error
}

describe('work records', () => {
  it('publishes an input before the change points at it, and drops nothing on a failed change write', async () => {
    let writes = 0
    const rows = new Map<string, unknown>()
    const persist: WorkPersist = async (table, key, value) => {
      writes += 1
      if (table === 'changes') throw new Error('change disk')
      rows.set(`${table}:${key}`, value)
    }
    const work = new WorkBook(persist, 'win32')
    await expect(work.createChange({ title: 'Ship', cwd: 'H:\\proj', goal: 'land it', at: 1 })).rejects.toThrow('change disk')
    expect(work.listChanges()).toEqual([])
    expect(work.occupying()).toEqual([])
    expect([...rows.keys()][0]).toMatch(/^inputs:/)
    expect(writes).toBe(2)
  })

  it('keeps an unreferenced input out of scheduling and retains history after a revision', async () => {
    const { book } = openBook()
    const change = await book.createChange({
      title: 'Ship', cwd: 'H:\\proj', goal: 'first', requirements: [{ requirementRef: 'r1', text: 'builds', required: true }],
      steps: [{ stepRef: 's1', text: 'implement' }], at: 1,
    })
    const revised = await book.reviseChange(change.id, { goal: 'second', at: 2 })
    if (!('id' in revised)) throw new Error('expected change')
    expect(revised.currentRevision).toBe(2)
    expect(book.input(change.currentInputRef)?.goal).toBe('first')
    expect(book.input(revised.currentInputRef)?.supersedes).toBe(change.currentInputRef)
    const title = await book.reviseChange(change.id, { title: 'Renamed', priority: 3, at: 3 })
    if (!('id' in title)) throw new Error('expected change')
    expect(title.currentRevision).toBe(2)
    expect(title.title).toBe('Renamed')
  })

  it('refuses overlapping files, parent directories, sibling checkouts and uncertain boundaries', async () => {
    const { book } = openBook()
    const left = await book.createChange({ title: 'A', cwd: 'H:\\proj\\pkg', goal: 'a', at: 1 })
    const right = await book.createChange({ title: 'B', cwd: 'H:\\proj\\other', goal: 'b', at: 1 })
    const root = await book.createChange({ title: 'Root', cwd: 'H:\\proj', goal: 'root', at: 1 })
    const held = await book.reserveRun({ changeId: left.id, cwd: 'H:\\proj\\pkg', writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\pkg\\src', type: 'directory' }] }, at: 2 })
    if (!held.ok) throw new Error(held.message)
    const file = await book.reserveRun({ changeId: right.id, cwd: 'H:\\proj\\pkg', writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\pkg\\src\\a.ts', type: 'file' }] }, at: 3 })
    expect(file.ok).toBe(false)
    if (!file.ok) expect(file.blockers).toEqual([held.run.id])
    const sibling = await book.reserveRun({ changeId: right.id, cwd: 'H:\\proj\\other', writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\other\\a.ts', type: 'file' }] }, at: 3 })
    expect(sibling.ok).toBe(true)
    const exclusive = await book.reserveRun({ changeId: root.id, cwd: 'H:\\proj', root: { gitCommonDir: 'H:\\proj\\.git' }, writeScope: { kind: 'workspace-exclusive' }, at: 4 })
    expect(exclusive.ok).toBe(false)
    const elsewhere = await book.createChange({ title: 'D', cwd: 'D:\\else', goal: 'd', at: 1 })
    const other = await book.reserveRun({ changeId: elsewhere.id, cwd: 'D:\\else', root: { gitCommonDir: 'D:\\else\\.git' }, writeScope: { kind: 'workspace-exclusive' }, at: 5 })
    expect(other.ok).toBe(true)
    const unknown = await book.reserveRun({ changeId: elsewhere.id, cwd: 'E:\\mystery', root: { uncertain: true }, writeScope: { kind: 'paths', paths: [{ path: 'E:\\mystery\\a.ts', type: 'file' }] }, at: 6 })
    expect(unknown.ok).toBe(false)
  })

  it('counts reserved runs against the quota and does not reopen a finished one', async () => {
    const { book } = openBook()
    const change = await book.createChange({ title: 'A', cwd: 'H:\\proj', goal: 'a', maxConcurrentRuns: 1, at: 1 })
    const first = await book.reserveRun({ changeId: change.id, cwd: 'H:\\a', writeScope: { kind: 'paths', paths: [{ path: 'H:\\a\\x.ts', type: 'file' }] }, at: 2 })
    const second = await book.reserveRun({ changeId: change.id, cwd: 'H:\\b', writeScope: { kind: 'paths', paths: [{ path: 'H:\\b\\y.ts', type: 'file' }] }, at: 3 })
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: false, code: 'quota' })
    await book.setControl(change.id, 'paused', 4)
    expect(await book.reserveRun({ changeId: change.id, cwd: 'H:\\c', writeScope: { kind: 'paths', paths: [] }, at: 5 })).toMatchObject({ code: 'paused' })
  })

  it('blocks on an external session and refuses the first write until the baseline is published at the same revision', async () => {
    const { book } = openBook()
    const change = await book.createChange({ title: 'A', cwd: 'H:\\proj', goal: 'a', maxConcurrentRuns: 2, at: 1 })
    const external: ExternalOccupant = { id: 'user-session', cwd: 'H:\\proj\\src', workspaceRoot: 'H:\\proj', exclusiveRoot: 'H:\\proj', writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\src\\a.ts', type: 'file' }] } }
    const blocked = await book.reserveRun({ changeId: change.id, cwd: 'H:\\proj', writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\src\\a.ts', type: 'file' }] }, external: [external], at: 2 })
    expect(blocked).toMatchObject({ ok: false, code: 'conflict', blockers: ['user-session'] })
    const reserved = await book.reserveRun({ changeId: change.id, cwd: 'H:\\proj\\docs', writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\docs\\a.md', type: 'file' }] }, at: 3 })
    if (!reserved.ok) throw new Error(reserved.message)
    expect(book.dispatchAllowed(reserved.run.id)).toMatchObject({ code: 'baseline' })
    const stale = book.revision
    const other = await book.reserveRun({ changeId: change.id, cwd: 'H:\\proj\\pic', writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\pic\\a.png', type: 'file' }] }, at: 4 })
    expect(other.ok).toBe(true)
    const rejected = await book.publishBaseline(reserved.run.id, stale, 'artifact-old', 5)
    expect(rejected).toMatchObject({ ok: false, code: 'stale' })
    expect(book.dispatchAllowed(reserved.run.id).ok).toBe(false)
    const published = await book.publishBaseline(reserved.run.id, book.revision, 'artifact-1', 6)
    expect(published).toMatchObject({ applied: true })
    expect(book.dispatchAllowed(reserved.run.id)).toEqual({ ok: true })
    expect(book.change(change.id)?.baselineRefs.map(item => item.artifactRef)).toEqual(['artifact-1'])
  })

  it('replaces only the publishing run baseline and keeps an earlier same-scope ref', async () => {
    const { book } = openBook()
    const change = await book.createChange({ title: 'A', cwd: 'H:\\proj', goal: 'a', at: 1 })
    const writer = await book.reserveRun({
      changeId: change.id, cwd: 'H:\\proj', root: { workspaceRoot: 'H:\\proj', gitCommonDir: 'H:\\proj\\.git' },
      writeScope: { kind: 'workspace-exclusive' }, at: 2,
    })
    if (!writer.ok) throw new Error(writer.message)
    expect((await book.publishBaseline(writer.run.id, book.revision, 'base-writer', 3)).applied).toBe(true)
    expect((await book.publishBaseline(writer.run.id, book.revision, 'base-writer-2', 4)).applied).toBe(true)
    expect(book.run(writer.run.id)?.baselineRefs.map(item => item.artifactRef)).toEqual(['base-writer-2'])
    expect(book.change(change.id)?.baselineRefs.map(item => item.artifactRef)).toEqual(['base-writer-2'])
    const prepared = await book.prepareFinish(writer.run.id, 'completed', 5)
    if (!prepared.ok) throw new Error(prepared.message)
    expect((await book.finishSettled(writer.run.id, prepared.updatedAt, 'completed', { queueCleared: true, agentIdle: true, jobsSettled: true }, 6)).ok).toBe(true)
    const review = await book.reserveRun({
      changeId: change.id, kind: 'review', cwd: 'H:\\proj', root: { workspaceRoot: 'H:\\proj', gitCommonDir: 'H:\\proj\\.git' },
      writeScope: { kind: 'workspace-exclusive' }, at: 7,
    })
    if (!review.ok) throw new Error(review.message)
    expect((await book.publishBaseline(review.run.id, book.revision, 'base-review', 8)).applied).toBe(true)
    expect(book.change(change.id)?.baselineRefs.map(item => item.artifactRef)).toEqual(['base-writer-2', 'base-review'])
    expect(book.run(writer.run.id)?.baselineRefs.map(item => item.artifactRef)).toEqual(['base-writer-2'])
    expect(book.run(review.run.id)?.baselineRefs.map(item => item.artifactRef)).toEqual(['base-review'])
    expect(book.dispatchAllowed(review.run.id)).toEqual({ ok: true })
  })

  it('leaves memory unchanged when the run write fails and rebuilds occupancy from the saved rows', async () => {
    let fail = false
    const { book, rows } = openBook(() => fail)
    const change = await book.createChange({ title: 'A', cwd: 'H:\\proj', goal: 'a', maxConcurrentRuns: 2, at: 1 })
    fail = true
    await expect(book.reserveRun({ changeId: change.id, cwd: 'H:\\proj\\src', writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\src\\a.ts', type: 'file' }] }, at: 2 })).rejects.toThrow('disk failure')
    expect(book.occupying()).toEqual([])
    fail = false
    const reserved = await book.reserveRun({ changeId: change.id, cwd: 'H:\\proj\\src', writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\src\\a.ts', type: 'file' }] }, at: 3 })
    if (!reserved.ok) throw new Error(reserved.message)
    const restored = WorkBook.restore({
      changes: [rows.get(`changes:${change.id}`)],
      inputs: [...rows.values()].filter(value => value && typeof value === 'object' && 'goal' in value),
      runs: [rows.get(`runs:${reserved.run.id}`)],
    }, async () => {}, 'win32')
    expect(restored.occupying().map(row => row.id)).toEqual([reserved.run.id])
    expect(await restored.reserveRun({ changeId: change.id, cwd: 'H:\\proj\\src\\a.ts', writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\src\\a.ts', type: 'file' }] }, at: 4 })).toMatchObject({ code: 'conflict' })
  })

  it('rejects a new delivery on a settling run and accepts only covered required checks', async () => {
    const { book } = openBook()
    const change = await book.createChange({
      title: 'A', cwd: 'H:\\proj', goal: 'a', requirements: [
        { requirementRef: 'r1', text: 'builds', required: true },
        { requirementRef: 'r2', text: 'docs', required: false },
      ], at: 1,
    })
    const reserved = await book.reserveRun({ changeId: change.id, writeScope: { kind: 'paths', paths: [] }, at: 2 })
    if (!reserved.ok) throw new Error(reserved.message)
    expect(book.dispatchAllowed(reserved.run.id)).toEqual({ ok: true })
    const closed = { ...reserved.run, phase: 'settling' as const }
    const settling = WorkBook.restore({ changes: [book.change(change.id)], inputs: [book.input(change.currentInputRef)], runs: [closed] }, async () => {}, 'win32')
    expect(await settling.addDelivery(closed.id, { kind: 'context', targetSessionId: closed.requestedSessionId, inputRevision: 1, contentRef: 'c', source: 'dot', status: 'intent' })).toMatchObject({ code: 'closed-run' })
    const accepted = await book.recordVerification(change.id, [{ requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log'] }], [reserved.run.id], 3, {
      inputRef: change.currentInputRef, inputRevision: change.currentRevision,
    })
    expect(accepted).toMatchObject({ verdict: 'accept' })
    const empty = judgeVerification([{ requirementRef: 'r1', text: 'builds', required: true }], [{ requirementRef: 'r1', applicability: 'not-applicable', verdict: 'not-applicable', evidenceRefs: [], note: 'out of scope' }])
    expect(empty).toBe('unverified')
  })

  it('treats a shared git dir as one exclusion root even when the cwd strings differ', () => {
    const left = workspaceIdentity('H:\\proj\\a', { gitCommonDir: 'H:\\proj\\.git' }, 'win32')
    const right = workspaceIdentity('H:\\proj\\b', { gitCommonDir: 'H:\\proj\\.git' }, 'win32')
    expect(left.exclusiveRoot).toBe(right.exclusiveRoot)
    expect(occupantsConflict(
      { id: 'a', cwd: left.workspaceRoot, workspaceRoot: left.workspaceRoot, exclusiveRoot: left.exclusiveRoot, uncertainBoundary: false, writeScope: { kind: 'workspace-exclusive' } },
      { id: 'b', cwd: 'h:\\proj\\b\\src', workspaceRoot: right.workspaceRoot, exclusiveRoot: right.exclusiveRoot, uncertainBoundary: false, writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\b\\src\\a.ts', type: 'file' }] } },
      'win32',
    )).toBe(true)
  })

  it('covers a sibling of an exclusive cwd when the checkout root is known, and blocks when the shared root is not', async () => {
    const { book } = openBook()
    const pkg = await book.createChange({ title: 'Pkg', cwd: 'H:\\repo\\pkg', goal: 'pkg', maxConcurrentRuns: 4, at: 1 })
    const other = await book.createChange({ title: 'Other', cwd: 'H:\\repo\\other', goal: 'other', maxConcurrentRuns: 4, at: 1 })
    const held = await book.reserveRun({
      changeId: pkg.id, cwd: 'H:\\repo\\pkg', root: { workspaceRoot: 'H:\\repo', gitCommonDir: 'H:\\repo\\.git' },
      writeScope: { kind: 'workspace-exclusive' }, at: 2,
    })
    if (!held.ok) throw new Error(held.message)
    const sibling = await book.reserveRun({
      changeId: other.id, cwd: 'H:\\repo\\other', root: { workspaceRoot: 'H:\\repo' },
      writeScope: { kind: 'paths', paths: [{ path: 'H:\\repo\\other\\a.ts', type: 'file' }] }, at: 3,
    })
    expect(sibling).toMatchObject({ ok: false, code: 'conflict', blockers: [held.run.id] })
    expect(occupantsConflict(
      { id: 'git', cwd: 'h:\\repo\\pkg', workspaceRoot: 'h:\\repo', exclusiveRoot: 'h:\\repo\\.git', uncertainBoundary: false, writeScope: { kind: 'workspace-exclusive' } },
      { id: 'path', cwd: 'h:\\repo\\other', workspaceRoot: 'h:\\repo', exclusiveRoot: 'h:\\repo', uncertainBoundary: false, writeScope: { kind: 'paths', paths: [{ path: 'H:\\repo\\other\\a.ts', type: 'file' }] } },
      'win32',
    )).toBe(true)
    const elsewhere = await book.createChange({ title: 'Else', cwd: 'D:\\else', goal: 'else', at: 1 })
    const far = await book.reserveRun({
      changeId: elsewhere.id, cwd: 'D:\\else', root: { workspaceRoot: 'D:\\else', gitCommonDir: 'D:\\else\\.git' },
      writeScope: { kind: 'paths', paths: [{ path: 'D:\\else\\a.ts', type: 'file' }] }, at: 4,
    })
    expect(far.ok).toBe(true)
    const unknown = await book.reserveRun({
      changeId: other.id, cwd: 'E:\\mystery', writeScope: { kind: 'workspace-exclusive' }, at: 5,
    })
    expect(unknown).toMatchObject({ ok: false, code: 'conflict' })
  })

  it('refuses dispatch and delivery after cancel, closeout or a newer input, and allows them again only for a current open change', async () => {
    const { book } = openBook()
    const change = await book.createChange({
      title: 'A', cwd: 'H:\\proj', goal: 'first', requirements: [{ requirementRef: 'r1', text: 'builds', required: true }], maxConcurrentRuns: 4, at: 1,
    })
    const reserved = await book.reserveRun({ changeId: change.id, writeScope: { kind: 'paths', paths: [] }, at: 2 })
    if (!reserved.ok) throw new Error(reserved.message)
    const foreign = await book.addDelivery(reserved.run.id, {
      kind: 'context', targetSessionId: 'someone-else', inputRevision: 1, contentRef: 'c', source: 'dot', status: 'intent', at: 3,
    })
    expect(foreign).toMatchObject({ code: 'ownership' })
    await book.setControl(change.id, 'cancelled', 4)
    expect(book.dispatchAllowed(reserved.run.id)).toMatchObject({ code: 'cancelled' })
    expect(await book.addDelivery(reserved.run.id, {
      kind: 'context', targetSessionId: reserved.run.requestedSessionId, inputRevision: 1, contentRef: 'c', source: 'dot', status: 'intent', at: 5,
    })).toMatchObject({ code: 'cancelled' })
    await book.setControl(change.id, 'open', 6)
    expect(book.dispatchAllowed(reserved.run.id)).toEqual({ ok: true })
    const revised = await book.reviseChange(change.id, { goal: 'second', at: 7 })
    if (!('id' in revised)) throw new Error('expected change')
    expect(book.dispatchAllowed(reserved.run.id)).toMatchObject({ code: 'stale' })
    expect(await book.addDelivery(reserved.run.id, {
      kind: 'context', targetSessionId: reserved.run.requestedSessionId, inputRevision: 1, contentRef: 'old', source: 'dot', status: 'intent', at: 8,
    })).toMatchObject({ code: 'stale' })
    const replacement = await book.reserveRun({ changeId: change.id, cwd: 'H:\\other', writeScope: { kind: 'paths', paths: [] }, at: 9 })
    expect(replacement.ok).toBe(true)
    const current = book.change(change.id)!
    const accepted = await book.recordVerification(change.id, [{ requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log'] }], [], 10, {
      inputRef: current.currentInputRef, inputRevision: current.currentRevision,
    })
    if (!('id' in accepted)) throw new Error('expected verification')
    expect(await book.closeOut(change.id, accepted.id, 'user', 11)).toMatchObject({ code: 'closed' })
    expect(book.change(change.id)?.closeout).toBeUndefined()
    expect(book.dispatchAllowed(replacement.ok ? replacement.run.id : reserved.run.id)).toEqual({ ok: true })
    const reopened = await book.reviseChange(change.id, { goal: 'third', at: 13 })
    if (!('id' in reopened)) throw new Error('expected revision')
    expect(reopened.closeout).toBeUndefined()
    expect((await book.reserveRun({ changeId: change.id, cwd: 'H:\\third', writeScope: { kind: 'paths', paths: [] }, at: 14 })).ok).toBe(true)
  })

  it('publishes only the run baseline and restores it without a change mirror', async () => {
    const rows = new Map<string, unknown>()
    const writes: string[] = []
    const book = new WorkBook(async (table, key, value) => {
      writes.push(table)
      rows.set(`${table}:${key}`, structuredClone(value))
    }, 'win32')
    const change = await book.createChange({ title: 'A', cwd: 'H:\\proj', goal: 'a', at: 1 })
    const reserved = await book.reserveRun({ changeId: change.id, writeScope: { kind: 'paths', paths: [{ path: 'a.md', type: 'file' }] }, at: 2 })
    if (!reserved.ok) throw new Error(reserved.message)
    writes.length = 0
    expect((await book.publishBaseline(reserved.run.id, book.revision, 'artifact-1', 3)).applied).toBe(true)
    expect(writes).toEqual(['runs'])
    expect(rows.get(`changes:${change.id}`)).not.toHaveProperty('baselineRefs')
    const restored = WorkBook.restore({
      changes: [{ ...(rows.get(`changes:${change.id}`) as object), baselineRefs: [{ artifactRef: 'obsolete-mirror' }] }],
      inputs: [rows.get(`inputs:${change.currentInputRef}`)], runs: [rows.get(`runs:${reserved.run.id}`)],
    }, async () => {}, 'win32')
    expect(restored.recoveryError).toBeUndefined()
    expect(restored.change(change.id)?.baselineRefs.map(ref => ref.artifactRef)).toEqual(['artifact-1'])
    expect(restored.dispatchAllowed(reserved.run.id)).toEqual({ ok: true })
  })

  it('blocks dispatch after an unknown baseline write until storage is reopened', async () => {
    const rows = new Map<string, unknown>()
    let unknown = false
    let attempts = 0
    const book = new WorkBook(async (table, key, value) => {
      rows.set(`${table}:${key}`, structuredClone(value))
      if (unknown) { attempts += 1; throw Object.assign(new Error('receipt lost'), { code: 'unknown-state' }) }
    }, 'win32')
    const change = await book.createChange({ title: 'A', cwd: 'H:/proj', goal: 'a' })
    const reserved = await book.reserveRun({ changeId: change.id, writeScope: { kind: 'paths', paths: [{ path: 'a.ts', type: 'file' }] } })
    if (!reserved.ok) throw new Error(reserved.message)
    unknown = true
    await expect(book.publishBaseline(reserved.run.id, book.revision, 'base-1')).rejects.toThrow('receipt lost')
    expect(attempts).toBe(1)
    expect(book.dispatchAllowed(reserved.run.id)).toMatchObject({ code: 'recovery' })
    const reopened = WorkBook.restore({ changes: [rows.get(`changes:${change.id}`)], inputs: [rows.get(`inputs:${change.currentInputRef}`)], runs: [rows.get(`runs:${reserved.run.id}`)] }, async () => {}, 'win32')
    expect(reopened.dispatchAllowed(reserved.run.id)).toEqual({ ok: true })
  })

  it('refuses scheduling when a core record is illegal instead of dropping it', async () => {
    const restored = WorkBook.restore({ changes: [{ id: 'nope' }], runs: [] }, async () => {}, 'win32')
    expect(restored.recoveryError).toMatch(/illegal changes/)
    expect(await restored.reserveRun({ changeId: 'c-1', writeScope: { kind: 'paths', paths: [] } })).toMatchObject({ code: 'recovery' })
    expect(restored.dispatchAllowed('run-1')).toMatchObject({ code: 'recovery' })
  })

  it('keeps an illegal verification without releasing its run or inventing the missing fields', async () => {
    const { book } = openBook()
    const change = await book.createChange({ title: 'Ship', cwd: 'H:\\repo', goal: 'land it', requirements: [{ requirementRef: 'r1', text: 'builds', required: true }], at: 1 })
    const reserved = await book.reserveRun({
      changeId: change.id, kind: 'review', cwd: 'H:\\repo', root: { workspaceRoot: 'H:\\repo' },
      writeScope: { kind: 'workspace-exclusive' }, at: 2,
    })
    if (!reserved.ok) throw new Error(reserved.message)
    const review = {
      ...reserved.run,
      creation: 'confirmed' as const,
      sessionId: reserved.run.requestedSessionId,
      deliveries: [{
        id: 'del-1', kind: 'initial' as const, targetSessionId: reserved.run.requestedSessionId,
        inputRevision: reserved.run.inputRevision, contentRef: 'check', source: 'reserve', status: 'accepted' as const,
        createdAt: 2, updatedAt: 2,
      }],
    }
    const illegal = {
      id: 'v-9', changeId: change.id, inputRevision: change.currentRevision, inputRef: change.currentInputRef,
      runIds: [review.id], checks: [{ requirementRef: 'r1', applicability: 'required', verdict: 'pass', evidenceRefs: ['log'] }],
      verdict: 'unverified', createdAt: 3, reviewRunId: review.id, reviewerSessionId: review.sessionId,
      subject: {
        workspaceRoot: 'H:\\repo', cwd: 'H:\\repo', artifactRef: 'snap',
        baselineRefs: [{ workspaceRoot: 'H:\\repo', artifactRef: 'base' }],
        changes: [], protectedDirty: [], exclusions: [],
      },
    }
    const writes: string[] = []
    const restored = WorkBook.restore({
      changes: [change], inputs: [book.input(change.currentInputRef)!], runs: [review], verifications: [illegal],
    }, async (table, key) => { writes.push(`${table}:${key}`) }, 'win32')
    expect(restored.recoveryError).toContain('applicability')
    expect(restored.recoveryError).toContain('baseline scopeKey')
    expect(restored.recoveryError).toContain(review.id)
    expect(restored.verification('v-9')).toBeUndefined()
    expect(restored.preservedVerification('v-9')).toEqual(illegal)
    expect(restored.occupying().map(run => run.id)).toEqual([review.id])
    expect(await restored.reserveRun({ changeId: change.id, writeScope: { kind: 'paths', paths: [] } })).not.toMatchObject({ code: 'recovery' })
    const required = await restored.recordVerification(change.id, [{ requirementRef: 'r1', applicability: 'required' as 'applicable', verdict: 'pass', evidenceRefs: ['log'] }], [review.id], 4, {
      inputRef: change.currentInputRef, inputRevision: change.currentRevision, reviewRunId: review.id, reviewerSessionId: review.sessionId,
    })
    expect(required).toMatchObject({ ok: false, message: expect.stringContaining('not required') })
    const trimmed = await restored.recordVerification(change.id, [{ requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log'] }], [review.id], 5, {
      inputRef: change.currentInputRef, inputRevision: change.currentRevision, reviewRunId: review.id, reviewerSessionId: review.sessionId,
      subject: illegal.subject as never,
    })
    expect(trimmed).toMatchObject({ ok: false, message: expect.stringContaining('scopeKey') })
    expect(writes).toEqual([])
    const subject = {
      workspaceRoot: 'H:\\repo', cwd: 'H:\\repo', artifactRef: 'snap',
      baselineRefs: [{ workspaceRoot: 'H:\\repo', scopeKey: 'workspace-exclusive', artifactRef: 'base' }],
      changes: [], protectedDirty: [], exclusions: [],
    }
    const recorded = await restored.recordVerification(change.id, [{ requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['log'] }], [review.id], 6, {
      inputRef: change.currentInputRef, inputRevision: change.currentRevision, reviewRunId: review.id, reviewerSessionId: review.sessionId, subject,
    })
    expect('id' in recorded).toBe(true)
    expect(restored.preservedVerification('v-9')).toEqual(illegal)
    expect(restored.occupying().map(run => run.id)).toEqual([review.id])
    expect(writes.some(item => item.startsWith('verifications:v-9'))).toBe(false)
  })

  it('returns rework when an applicable required check fails with evidence', () => {
    expect(judgeVerification(
      [{ requirementRef: 'r1', text: 'builds', required: true }],
      [{ requirementRef: 'r1', applicability: 'applicable', verdict: 'fail', evidenceRefs: ['log'] }],
    )).toBe('rework')
    expect(judgeVerification(
      [{ requirementRef: 'r1', text: 'builds', required: true }],
      [{ requirementRef: 'r1', applicability: 'applicable', verdict: 'fail', evidenceRefs: [] }],
    )).toBe('unverified')
    expect(judgeVerification(
      [{ requirementRef: 'r1', text: 'builds', required: true }, { requirementRef: 'r2', text: 'docs', required: true }],
      [
        { requirementRef: 'r1', applicability: 'applicable', verdict: 'fail', evidenceRefs: ['log'] },
        { requirementRef: 'r2', applicability: 'applicable', verdict: 'unverified', evidenceRefs: [] },
      ],
    )).toBe('rework')
    expect(judgeVerification(
      [{ requirementRef: 'r1', text: 'builds', required: true }],
      [{ requirementRef: 'r1', applicability: 'not-applicable', verdict: 'pass', evidenceRefs: ['log'], note: 'skipped' }],
    )).toBe('unverified')
  })

  it('seals scheduling after an unknown durable cancel or reserve, and a reopened book follows the saved rows', async () => {
    const rows = new Map<string, unknown>()
    let mode: 'off' | 'cancel' | 'reserve' = 'off'
    const persist: WorkPersist = async (table, key, value) => {
      rows.set(`${table}:${key}`, structuredClone(value))
      const record = value as { control?: string }
      if (mode === 'cancel' && table === 'changes' && record.control === 'cancelled') throw unknownState()
      if (mode === 'reserve' && table === 'runs') throw unknownState()
    }
    const book = new WorkBook(persist, 'win32')
    const change = await book.createChange({ title: 'A', cwd: 'H:\\proj', goal: 'a', maxConcurrentRuns: 4, at: 1 })
    const reserved = await book.reserveRun({ changeId: change.id, cwd: 'H:\\proj\\docs', writeScope: { kind: 'paths', paths: [] }, at: 2 })
    if (!reserved.ok) throw new Error(reserved.message)
    mode = 'cancel'
    await expect(book.setControl(change.id, 'cancelled', 3)).rejects.toMatchObject({ code: 'unknown-state' })
    expect(book.change(change.id)?.control).toBe('open')
    expect(rows.get(`changes:${change.id}`)).toMatchObject({ control: 'cancelled' })
    expect(book.dispatchAllowed(reserved.run.id)).toMatchObject({ code: 'recovery' })
    expect(await book.addDelivery(reserved.run.id, {
      kind: 'context', targetSessionId: reserved.run.requestedSessionId, inputRevision: 1, contentRef: 'c', source: 'dot', status: 'intent', at: 4,
    })).toMatchObject({ code: 'recovery' })
    const reopened = WorkBook.restore({
      changes: [rows.get(`changes:${change.id}`)],
      inputs: [rows.get(`inputs:${change.currentInputRef}`)],
      runs: [rows.get(`runs:${reserved.run.id}`)],
    }, async () => {}, 'win32')
    expect(reopened.recoveryError).toBeUndefined()
    expect(reopened.dispatchAllowed(reserved.run.id)).toMatchObject({ code: 'cancelled' })
    const other = await reopened.createChange({ title: 'B', cwd: 'D:\\else', goal: 'b', at: 5 })
    expect((await reopened.reserveRun({ changeId: other.id, cwd: 'D:\\else', writeScope: { kind: 'paths', paths: [] }, at: 6 })).ok).toBe(true)

    mode = 'reserve'
    const fresh = new WorkBook(persist, 'win32')
    const again = await fresh.createChange({ title: 'C', cwd: 'E:\\one', goal: 'c', maxConcurrentRuns: 4, at: 7 })
    await expect(fresh.reserveRun({ changeId: again.id, cwd: 'E:\\one', writeScope: { kind: 'paths', paths: [{ path: 'E:\\one\\a.ts', type: 'file' }] }, at: 8 })).rejects.toMatchObject({ code: 'unknown-state' })
    expect(fresh.occupying()).toEqual([])
    expect(fresh.recoveryError).toMatch(/unknown-state/)
    expect(await fresh.reserveRun({ changeId: again.id, cwd: 'E:\\two', writeScope: { kind: 'paths', paths: [] }, at: 9 })).toMatchObject({ code: 'recovery' })
    const savedRun = [...rows.values()].find(value => value && typeof value === 'object' && 'phase' in value && (value as { changeId?: string }).changeId === again.id)
    const resumed = WorkBook.restore({
      changes: [rows.get(`changes:${again.id}`)],
      inputs: [...rows.values()].filter(value => value && typeof value === 'object' && (value as { changeId?: string }).changeId === again.id && 'goal' in value),
      runs: savedRun ? [savedRun] : [],
    }, async () => {}, 'win32')
    expect(resumed.recoveryError).toBeUndefined()
    expect(resumed.occupying()).toHaveLength(1)
    expect((await resumed.reserveRun({ changeId: again.id, cwd: 'E:\\two', writeScope: { kind: 'paths', paths: [] }, at: 10 })).ok).toBe(true)

    const plain = new WorkBook(async () => { throw new Error('disk failure') }, 'win32')
    await expect(plain.createChange({ title: 'D', cwd: 'H:\\proj', goal: 'd', at: 1 })).rejects.toThrow('disk failure')
    expect(plain.recoveryError).toBeUndefined()
  })
})

describe('content snapshots', () => {
  it('publishes an immutable manifest only after all bodies are saved and verifies their hashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'dot-snapshot-'))
    try {
      const dir = join(root, 'artifact')
      expect(() => saveSnapshot(dir, [{ path: 'edit.txt', body: new TextEncoder().encode('before') }, { path: 'kept.txt', body: new TextEncoder().encode('kept') }], 'kept.txt')).toThrow(/SAVE_ENTRY_FAILED/)
      expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
      const saved = saveSnapshot(dir, [{ path: 'edit.txt', body: new TextEncoder().encode('after') }, { path: 'gone.txt', deleted: true }])
      expect(saved.deleted).toEqual(['gone.txt'])
      expect(new TextDecoder().decode(readSnapshot(dir).bodies.get('edit.txt'))).toBe('after')
      expect(() => saveSnapshot(dir, [])).toThrow(/immutable/)
      writeFileSync(join(dir, 'blobs', saved.saved[0]!.sha256), 'broken')
      expect(() => readSnapshot(dir)).toThrow(/corrupt blob/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('rejects a snapshot that omits a live file, misses a directory member, or names the wrong root, and accepts a scanned empty directory', () => {
    const project = mkdtempSync(join(tmpdir(), 'dot-capture-'))
    const docs = join(project, 'docs')
    mkdirSync(docs)
    writeFileSync(join(docs, 'a.md'), 'whole')
    writeFileSync(join(docs, 'b.md'), 'other')
    const run = { cwd: project, workspaceRoot: project, writeScope: { kind: 'paths' as const, paths: [{ path: join(docs, 'a.md'), type: 'file' as const }] } }
    const omitted = saveSnapshot(join(project, 'snap-omit'), [], undefined, { root: project, empty: true })
    expect(baselineCaptures(run, omitted, 'win32').ok).toBe(false)
    const wrong = saveSnapshot(join(project, 'snap-wrong'), [{ path: 'docs/a.md', body: new TextEncoder().encode('whole') }], undefined, { root: join(project, 'other') })
    expect(baselineCaptures(run, wrong, 'win32')).toMatchObject({ ok: false })
    const directory = { cwd: project, workspaceRoot: project, writeScope: { kind: 'paths' as const, paths: [{ path: docs, type: 'directory' as const }] } }
    const partial = saveSnapshot(join(project, 'snap-partial'), [{ path: 'docs/a.md', body: new TextEncoder().encode('whole') }], undefined, { root: project })
    expect(baselineCaptures(directory, partial, 'win32')).toMatchObject({ ok: false, reason: expect.stringContaining('omitted') })
    const complete = saveSnapshot(join(project, 'snap-file'), [{ path: 'docs/a.md', body: new TextEncoder().encode('whole') }], undefined, { root: project })
    expect(baselineCaptures(run, complete, 'win32')).toEqual({ ok: true })
    const emptyDir = mkdtempSync(join(tmpdir(), 'dot-empty-'))
    const emptyRun = { cwd: emptyDir, workspaceRoot: emptyDir, writeScope: { kind: 'paths' as const, paths: [{ path: emptyDir, type: 'directory' as const }] } }
    const declared = saveSnapshot(join(project, 'snap-declared'), [], undefined, { root: emptyDir })
    expect(baselineCaptures(emptyRun, declared, 'win32').ok).toBe(false)
    const scanned = saveSnapshot(join(project, 'snap-empty'), [], undefined, { root: emptyDir, empty: true })
    expect(baselineCaptures(emptyRun, scanned, 'win32')).toEqual({ ok: true })
    rmSync(project, { recursive: true, force: true })
    rmSync(emptyDir, { recursive: true, force: true })
  })

  it('projects the current summary, write scope, delivery and check evidence without changing status', async () => {
    const { book } = openBook()
    const change = await book.createChange({
      title: 'Ship', cwd: 'H:\\proj', goal: 'land the fix',
      requirements: [{ requirementRef: 'r1', text: 'builds', required: true }], at: 1,
    })
    const reserved = await book.reserveRun({
      changeId: change.id, cwd: 'H:\\proj', root: { workspaceRoot: 'H:\\proj' },
      writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\a.ts', type: 'file' }] }, at: 2,
    })
    if (!reserved.ok) throw new Error(reserved.message)
    const recorded = await book.recordVerification(change.id, [
      { requirementRef: 'r1', applicability: 'applicable', verdict: 'fail', evidenceRefs: ['log-1'], note: 'build failed' },
    ], [reserved.run.id], 3, { inputRef: change.currentInputRef, inputRevision: change.currentRevision })
    if (!('id' in recorded)) throw new Error(recorded.message)
    const view = book.workView(change.id)
    expect(view?.status).toBe('rework')
    expect(view?.summary).toBe('land the fix')
    expect(view?.runs[0]?.writeScope).toEqual({ kind: 'paths', paths: [{ path: 'H:\\proj\\a.ts', type: 'file' }] })
    expect(view?.runs[0]?.deliveries?.[0]).toMatchObject({ kind: 'initial', status: 'intent' })
    expect(view?.verification?.checks).toEqual([
      { requirementRef: 'r1', verdict: 'fail', evidenceRefs: ['log-1'], note: 'build failed' },
    ])
    expect(view?.humanAction).toBeUndefined()
  })
})

/** The stored shape of input-2 from a version-5 domain row, without the newer fields. */
const legacyInput = {
  id: 'input-2',
  changeId: 'c-1',
  revision: 2,
  goal: '在交付目录写入 site/r10.txt，第一行「R10 标记」、第二行尾注「R10 confirmed」',
  requirements: [
    { requirementRef: 'R1', text: 'site/r10.txt 存在且两行内容精确', required: true },
    { requirementRef: 'R2', text: '后台作业在校验通过之后才结束', required: true },
  ],
  steps: [
    { stepRef: 'S1', text: '启动后台作业' },
    { stepRef: 'S2', text: '写入 site/r10.txt' },
  ],
  source: 'revision',
  createdAt: 1794832206080,
  behaviorNotes: '["写入必须发生在后台作业运行期间","不得写入交付目录以外的任何路径","第二行尾注必须精确为「R10 confirmed」"]',
  supersedes: 'input-1',
}

describe('work input contract', () => {
  it('reads a stored input that has no scenarios, constraints or step links', () => {
    const parsed = parseInput(legacyInput)
    // A retired free-text field of old rows is dropped on read.
    expect(parsed && 'behaviorNotes' in parsed).toBe(false)
    expect(parsed?.constraints).toBeUndefined()
    expect(parsed?.requirements[0]?.scenarios).toBeUndefined()
    expect(parsed?.steps[0]?.covers).toBeUndefined()
    const stored = memoryPersist()
    const restored = WorkBook.restore({ inputs: [legacyInput] }, stored.persist, 'win32')
    expect(restored.recoveryError).toBeUndefined()
    expect(restored.input('input-2')?.goal).toContain('site/r10.txt')
    expect(restored.input('input-2')?.constraints).toBeUndefined()
  })

  it('stores scenarios, constraints and step links, and carries unspecified fields into the next input', async () => {
    const { book } = openBook()
    const change = await book.createChange({
      title: 'Ship', cwd: 'H:\\proj', goal: 'land',
      userRequest: 'please write the note',
      deliverableLanguage: 'zh-CN',
      constraints: [{ constraintRef: 'k1', text: 'do not add files' }],
      requirements: [{
        requirementRef: 'R1', text: 'note exists', required: true,
        scenarios: [{ scenarioRef: 'R1.a', given: 'a fresh dir', when: 'the file is read', then: 'it says hi' }],
      }],
      steps: [
        { stepRef: 's1', text: 'prepare' },
        { stepRef: 's2', text: 'write', covers: ['R1', 'R1.a'], after: ['s1'] },
      ],
      at: 1,
    })
    expect(book.input(change.currentInputRef)).toMatchObject({
      userRequest: 'please write the note',
      deliverableLanguage: 'zh-CN',
      constraints: [{ constraintRef: 'k1', text: 'do not add files' }],
      requirements: [{ scenarios: [{ scenarioRef: 'R1.a', given: 'a fresh dir', when: 'the file is read', then: 'it says hi' }] }],
      steps: [{ stepRef: 's1', text: 'prepare' }, { stepRef: 's2', covers: ['R1', 'R1.a'], after: ['s1'] }],
    })
    const renamed = await book.reviseChange(change.id, { title: 'Renamed', at: 2 })
    if (!('id' in renamed)) throw new Error(renamed.message)
    expect(renamed.currentRevision).toBe(1)
    const revised = await book.reviseChange(change.id, { goal: 'land later', at: 3 })
    if (!('id' in revised)) throw new Error(revised.message)
    expect(revised.currentRevision).toBe(2)
    expect(book.input(revised.currentInputRef)).toMatchObject({
      goal: 'land later',
      userRequest: 'please write the note',
      deliverableLanguage: 'zh-CN',
      constraints: [{ constraintRef: 'k1', text: 'do not add files' }],
      supersedes: change.currentInputRef,
    })
    const cleared = await book.reviseChange(change.id, { constraints: [], at: 5 })
    if (!('id' in cleared)) throw new Error(cleared.message)
    expect(book.input(cleared.currentInputRef)?.constraints).toEqual([])
    expect('behaviorNotes' in book.input(cleared.currentInputRef)!).toBe(false)
  })

  it('refuses duplicate refs, unknown links and step cycles without storing them', async () => {
    const { book } = openBook()
    await expect(book.createChange({
      title: 'A', cwd: 'H:\\proj', goal: 'a',
      requirements: [
        { requirementRef: 'R1', text: 'a', required: true, scenarios: [{ scenarioRef: 'R1.a', when: 'now', then: 'yes' }] },
        { requirementRef: 'R1', text: 'b', required: false },
      ],
      at: 1,
    })).rejects.toThrow('duplicate requirementRef R1')
    await expect(book.createChange({
      title: 'A', cwd: 'H:\\proj', goal: 'a',
      requirements: [
        { requirementRef: 'R1', text: 'a', required: true, scenarios: [{ scenarioRef: 'S', when: 'now', then: 'yes' }] },
        { requirementRef: 'R2', text: 'b', required: true, scenarios: [{ scenarioRef: 'S', when: 'later', then: 'no' }] },
      ],
      at: 1,
    })).rejects.toThrow('duplicate scenarioRef S')
    await expect(book.createChange({
      title: 'A', cwd: 'H:\\proj', goal: 'a',
      constraints: [{ constraintRef: 'k1', text: 'a' }, { constraintRef: 'k1', text: 'b' }],
      at: 1,
    })).rejects.toThrow('duplicate constraintRef k1')
    await expect(book.createChange({
      title: 'A', cwd: 'H:\\proj', goal: 'a',
      steps: [{ stepRef: 's1', text: 'a', covers: ['missing'] }],
      at: 1,
    })).rejects.toThrow('step s1 covers missing, which is not a requirement or scenario')
    await expect(book.createChange({
      title: 'A', cwd: 'H:\\proj', goal: 'a',
      steps: [{ stepRef: 's1', text: 'a', after: ['s9'] }],
      at: 1,
    })).rejects.toThrow('step s1 is after s9, which is not a step')
    expect(book.listChanges()).toEqual([])

    const change = await book.createChange({ title: 'A', cwd: 'H:\\proj', goal: 'a', at: 2 })
    const cycled = await book.reviseChange(change.id, {
      steps: [
        { stepRef: 's1', text: 'a', after: ['s2'] },
        { stepRef: 's2', text: 'b', after: ['s1'] },
      ],
      at: 3,
    })
    expect(cycled).toMatchObject({ ok: false, code: 'invalid', message: 'step order cycles: s1 → s2 → s1' })
    expect(book.change(change.id)?.currentRevision).toBe(1)
    expect(book.inputsFor(change.id)).toHaveLength(1)
  })
})
