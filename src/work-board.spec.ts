import { describe, expect, it } from 'vitest'
import { acceptPayload, groupWork, lookRequest, rejectPayload, resumePayload, workFactTone, workFailure, type WorkBoardItem } from './work-board.ts'

const item = (patch: Partial<WorkBoardItem> = {}): WorkBoardItem => ({
  id: 'c-1', title: 'Ship', priority: 2, revision: 4, inputRef: 'in-4', control: 'open', status: 'review',
  runs: [{ id: 'run-2', kind: 'review', phase: 'settling', cwd: 'H:/repo' }],
  blockers: ['run-2'],
  verification: { id: 'v-3', verdict: 'accept', subjectKey: 'subject-key', inputRef: 'in-4', inputRevision: 4 },
  oversight: { requested: true, inputRef: 'in-4', inputRevision: 4 },
  humanAction: { action: 'accept', expectedInputRef: 'in-4', expectedInputRevision: 4, expectedVerificationId: 'v-3', expectedSubjectKey: 'subject-key' },
  ...patch,
})

const pending = (detail: unknown, id = 'ap-1') => ({ id, kind: 'approval', detail: JSON.stringify(detail) })

describe('work board actions', () => {
  it('copies the accept versions from the projection and does not invent them', () => {
    expect(acceptPayload(item())).toEqual({
      id: 'c-1', verificationId: 'v-3', expectedInputRef: 'in-4', expectedInputRevision: 4, expectedSubjectKey: 'subject-key',
    })
    expect(acceptPayload(item({ humanAction: undefined }))).toBeUndefined()
  })

  it('rejects only the open review at the revision on screen', () => {
    expect(rejectPayload(item())).toEqual({ id: 'c-1', reviewRunId: 'run-2', expectedInputRevision: 4 })
    expect(rejectPayload(item({ runs: [{ id: 'run-2', kind: 'review', phase: 'stopped', cwd: 'H:/repo' }] }))).toBeUndefined()
    expect(rejectPayload(item({ closeout: { verificationId: 'v-3', source: 'user' } }))).toBeUndefined()
  })

  it('offers resume only while a stored closeout still holds a run', () => {
    expect(resumePayload(item({ closeout: { verificationId: 'v-3', source: 'user' }, blockers: ['run-2'] }))).toEqual({ id: 'c-1' })
    expect(resumePayload(item({ closeout: { verificationId: 'v-3', source: 'user' }, blockers: [] }))).toBeUndefined()
  })

  it('answers only the pending card for this version', () => {
    const current = pending({ changeId: 'c-1', inputRevision: 4, verificationId: 'v-3', subjectKey: 'subject-key' })
    expect(lookRequest(item(), [current])).toMatchObject({ id: 'ap-1', verificationId: 'v-3' })
    const older = pending({ changeId: 'c-1', inputRevision: 3, verificationId: 'v-2', subjectKey: 'old' }, 'ap-old')
    expect(lookRequest(item(), [older])).toBe('stale')
    expect(lookRequest(item(), [])).toBe('withdrawn')
    expect(lookRequest(item({ oversight: { requested: true, inputRef: 'in-3', inputRevision: 3 } }), [current])).toBe('stale')
    expect(lookRequest(item({ verification: { id: 'v-3', verdict: 'accept', subjectKey: 'subject-key', inputRef: 'in-3', inputRevision: 3 } }), [current])).toBe('stale')
  })

  it('keeps a refusal from looking like success', () => {
    expect(workFailure({ code: 'dot/unknown-request', message: 'work review ap-1 is no longer pending' })).toBe('withdrawn')
    expect(workFailure('the decision is for an older version')).toBe('stale')
    expect(workFailure({ code: 'conflict', message: 'run-1 is still open' })).toBe('conflict')
    expect(workFailure('disk offline')).toBe('unknown')
  })

  it('puts a change that needs a person ahead of ordinary work', () => {
    const groups = groupWork([
      item({ id: 'c-run', status: 'running', humanAction: undefined, oversight: undefined }),
      item({ id: 'c-done', status: 'done', humanAction: undefined, oversight: undefined }),
      item({ id: 'c-look' }),
    ])
    expect(groups.needsHuman.map(row => row.id)).toEqual(['c-look'])
    expect(groups.active.map(row => row.id)).toEqual(['c-run'])
    expect(groups.done.map(row => row.id)).toEqual(['c-done'])
  })

  it('keeps withdrawn or stale requests out of the needs-human group until there is a current action', () => {
    const waiting = item({ humanAction: undefined })
    const current = pending({ changeId: waiting.id, inputRevision: 4, verificationId: 'v-3', subjectKey: 'subject-key' })
    const stale = pending({ changeId: waiting.id, inputRevision: 3, verificationId: 'v-2', subjectKey: 'old' })
    expect(groupWork([waiting], []).needsHuman).toEqual([])
    expect(groupWork([waiting], [stale]).active.map(row => row.id)).toEqual([waiting.id])
    expect(groupWork([waiting], [current]).needsHuman.map(row => row.id)).toEqual([waiting.id])
  })

  it('does not treat unknown, rejected or unverified facts as success', () => {
    for (const value of ['unknown', 'rejected', 'fail', 'unverified', 'stale', 'rework']) {
      expect(workFactTone(value)).not.toBe('success')
    }
    expect(workFactTone('unknown')).toBe('warning')
    expect(workFactTone('rejected')).toBe('danger')
    expect(workFactTone('accept')).toBe('info')
  })
})
