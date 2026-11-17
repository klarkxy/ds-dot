/**
 * An illegal verification must not lock a home, and it must not release the
 * review that was still settling. The rows are built in a temporary directory.
 * Nothing reads or writes a shared evidence home.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { openCompatibleDomain } from '@klarkxy/dsh-plugin-kit/domain'
import { dotDomain } from './storage.ts'
import { DotStore } from './store.ts'
import { verificationSchema } from './work.ts'

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

describe('self-contained home copy', () => {
  it('opens a planted illegal verification without locking the home or releasing the settling review', async () => {
    const root = join(tmpdir(), `dot-home-copy-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(root, { recursive: true })
    const opened = await openHome(root)
    try {
      const change = await opened.store.work.createChange({
        title: 'Ship', cwd: 'H:\\repo', goal: 'land it',
        requirements: [
          { requirementRef: 'R1', text: 'builds', required: true },
          { requirementRef: 'R2', text: 'tests', required: true },
        ],
        at: 1,
      })
      const reserved = await opened.store.work.reserveRun({
        changeId: change.id, kind: 'review', cwd: 'H:\\repo', root: { workspaceRoot: 'H:\\repo' },
        writeScope: { kind: 'workspace-exclusive' }, at: 2,
      })
      if (!reserved.ok) throw new Error(reserved.message)
      const reviewId = reserved.run.id
      await closeHome(opened)

      const runPath = join(root, 'klarkxy_dsh_dot', 'runs', `${reviewId}.json`)
      const runFile = JSON.parse(await readFile(runPath, 'utf8')) as { version: number; record: Record<string, unknown> }
      const run = runFile.record
      const deliveries = run.deliveries as Array<Record<string, unknown>>
      deliveries[0]!.status = 'accepted'
      run.phase = 'settling'
      run.creation = 'confirmed'
      run.sessionId = run.requestedSessionId
      delete run.closeIntent
      await writeFile(runPath, JSON.stringify(runFile, null, 2))

      const illegal = {
        id: 'v-1', changeId: change.id, inputRevision: change.currentRevision, inputRef: change.currentInputRef,
        runIds: [reviewId],
        checks: [{ requirementRef: 'R1', applicability: 'required', verdict: 'pass', evidenceRefs: ['log'] }],
        verdict: 'unverified', createdAt: 3, reviewRunId: reviewId, reviewerSessionId: run.sessionId,
        subject: {
          workspaceRoot: change.cwd, cwd: change.cwd, artifactRef: 'snap',
          baselineRefs: [{ workspaceRoot: change.cwd, artifactRef: 'base' }],
          changes: [], protectedDirty: [], exclusions: [],
        },
      }
      const strict = verificationSchema.safeParse(illegal)
      expect(strict.success).toBe(false)
      const issueText = strict.success ? '' : JSON.stringify(strict.error.issues)
      expect(issueText).toContain('scopeKey')
      expect(issueText).toContain('applicability')
      const verificationPath = join(root, 'klarkxy_dsh_dot', 'verifications', 'v-1.json')
      await mkdir(join(root, 'klarkxy_dsh_dot', 'verifications'), { recursive: true })
      const planted = JSON.stringify({ version: runFile.version, record: illegal }, null, 2)
      await writeFile(verificationPath, planted)

      const home = await openHome(root)
      try {
        const problems = home.store.work.illegalVerifications()
        expect(home.store.work.recoveryError).toContain('applicability')
        expect(home.store.work.recoveryError).toContain('baseline scopeKey')
        expect(home.store.work.verification('v-1')).toBeUndefined()
        expect(problems.find(row => row.id === 'v-1')?.reasons).toEqual(expect.arrayContaining(['applicability', 'baseline scopeKey']))
        expect(home.store.work.run(reviewId)?.phase).toBe('settling')
        expect(home.store.work.occupying().some(run => run.id === reviewId)).toBe(true)
        const current = home.store.work.change(change.id)
        expect(current).toBeTruthy()
        const refused = await home.store.work.recordVerification(change.id, [{
          requirementRef: 'R1', applicability: 'required' as 'applicable', verdict: 'pass', evidenceRefs: ['log'],
        }], [reviewId], 9, {
          inputRef: current!.currentInputRef, inputRevision: current!.currentRevision,
          reviewRunId: reviewId, reviewerSessionId: String(run.sessionId),
        })
        expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('not required') })
        const trimmed = await home.store.work.recordVerification(change.id, [{
          requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['kept'],
        }], [reviewId], 10, {
          inputRef: current!.currentInputRef, inputRevision: current!.currentRevision,
          reviewRunId: reviewId, reviewerSessionId: String(run.sessionId),
          subject: illegal.subject as never,
        })
        expect(trimmed).toMatchObject({ ok: false, message: expect.stringContaining('scopeKey') })
        const subject = {
          workspaceRoot: current!.cwd, cwd: current!.cwd, artifactRef: 'snap',
          baselineRefs: [{ workspaceRoot: current!.cwd, scopeKey: 'workspace-exclusive', artifactRef: 'base' }],
          changes: [], protectedDirty: [], exclusions: [],
        }
        const recorded = await home.store.work.recordVerification(change.id, [{
          requirementRef: 'R1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['kept'],
        }], [reviewId], 11, {
          inputRef: current!.currentInputRef, inputRevision: current!.currentRevision,
          reviewRunId: reviewId, reviewerSessionId: String(run.sessionId), subject,
        })
        expect(recorded).toMatchObject({ id: 'v-2' })
        if (!('id' in recorded)) throw new Error('expected a new verification')
        expect(recorded.id).not.toBe('v-1')
        const refusedAccept = await home.store.work.accept(change.id, recorded.id, current!.currentInputRef, recorded.subjectKey ?? '', 'user', 12, {
          expectedInputRevision: current!.currentRevision, expectedVerificationId: recorded.id,
        })
        expect(refusedAccept).toMatchObject({ ok: false })
        expect(home.store.work.run(reviewId)?.phase).toBe('settling')
        expect(await readFile(verificationPath, 'utf8')).toBe(planted)
        await closeHome(home)

        const again = await openHome(root)
        try {
          expect(again.store.work.verification('v-2')?.checks[0]?.applicability).toBe('applicable')
          expect(again.store.work.verification('v-1')).toBeUndefined()
          expect(again.store.work.illegalVerifications().some(row => row.id === 'v-1')).toBe(true)
          expect(again.store.work.run(reviewId)?.phase).toBe('settling')
          expect(again.store.work.occupying().some(run => run.id === reviewId)).toBe(true)
          const after = await readFile(verificationPath, 'utf8')
          expect(after).toBe(planted)
          expect(sha(after)).toBe(sha(planted))
        } finally {
          await closeHome(again)
        }
      } finally {
        await closeHome(home)
      }
    } finally {
      await closeHome(opened)
      await rm(root, { recursive: true, force: true })
    }
  })
})

function openHome(root: string): Promise<{ backend: JsonStorageBackend; facility: DomainFacility; domain: Awaited<ReturnType<typeof openCompatibleDomain>>; store: DotStore }> {
  const backend = new JsonStorageBackend(root)
  const facility = new DomainFacility({
    storage: { backend: { get: (name: string) => name === 'json' ? backend : undefined } },
    logger: { error() {}, warn() {}, emit() {} },
  } as never, { backend: 'json' })
  return openCompatibleDomain(spec => facility.open(spec), dotDomain).then(domain => ({ backend, facility, domain, store: new DotStore(domain) }))
}

async function closeHome(home: { backend: JsonStorageBackend; facility: DomainFacility; domain: { close(): Promise<void> } }): Promise<void> {
  await home.domain.close().catch(() => undefined)
  await home.facility.closeAll().catch(() => undefined)
  await home.backend.close().catch(() => undefined)
}
