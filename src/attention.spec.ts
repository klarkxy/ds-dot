import { describe, expect, it } from 'vitest'
import { attentionItems } from './board-groups.ts'
import type { DotCardRecord } from './card-state.ts'
import type { BoardView } from './contracts.ts'
import type { WorkBoardItem } from './work-board.ts'

const card = (patch: Partial<DotCardRecord> = {}): DotCardRecord => ({
  id: 'dot-card-1', number: 1, sessionId: 'dot', callId: 'call-1', title: 'Approve build',
  view: { type: 'stack', children: [] }, expired: false, shownAt: 10,
  ...patch,
})

const board = (patch: Partial<BoardView>): BoardView => ({ tasks: [], pending: [], schedules: [], ...patch })

const workItem = (patch: Partial<WorkBoardItem> = {}): WorkBoardItem => ({
  id: 'c-1', title: 'Ship it', priority: 2, revision: 2, inputRef: 'in-2', control: 'open', status: 'waiting',
  runs: [], blockers: [],
  verification: { id: 'v-2', verdict: 'accept', subjectKey: 'key-2', inputRef: 'in-2', inputRevision: 2 },
  humanAction: { action: 'accept', expectedInputRef: 'in-2', expectedInputRevision: 2, expectedVerificationId: 'v-2', expectedSubjectKey: 'key-2' },
  ...patch,
})
const lookPending = (changeId = 'c-1', verification = 'v-2', subject = 'key-2') => ({
  id: `look-${verification}-${subject}`, kind: 'approval' as const, sessionId: 'dot', createdAt: 5, subject: `Look at ${changeId}`,
  detail: JSON.stringify({ changeId, inputRevision: 2, verificationId: verification, subjectKey: subject }),
})

describe('attentionItems', () => {
  it('lists live interactive cards and skips expired or answered ones', () => {
    const items = attentionItems([
      card({ id: 'dot-card-1', title: 'Approve build', shownAt: 10 }),
      card({ id: 'dot-card-2', expired: true, shownAt: 11 }),
      card({ id: 'dot-card-3', answer: { id: 'dot-card-3', action: 'ok', values: {} }, shownAt: 12 }),
      card({ id: 'dot-card-4', title: '', number: 4, shownAt: 9 }),
    ], board({}))
    expect(items.map(item => item.id)).toEqual(['card:dot-card-4', 'card:dot-card-1'])
    expect(items[0]).toMatchObject({ kind: 'card', title: '#4', since: 9 })
    expect(items[1]).toMatchObject({ kind: 'card', title: 'Approve build', since: 10 })
  })

  it('lists needs-human work only and never raw pending approvals or questions', () => {
    const accept = workItem()
    const look = workItem({ id: 'c-2', title: 'Check me', humanAction: undefined, oversight: { requested: true, inputRef: 'in-2', inputRevision: 2 } })
    const active = workItem({ id: 'c-3', humanAction: undefined, verification: undefined, status: 'running' })
    const done = workItem({ id: 'c-4', status: 'done' })
    const items = attentionItems([], board({
      work: [accept, look, active, done],
      pending: [
        lookPending('c-2'),
        { id: 'ap-1', kind: 'approval', sessionId: 's', createdAt: 3, subject: 'rm -rf' },
        { id: 'q-1', kind: 'question', sessionId: 's', createdAt: 4, subject: 'which one?' },
      ],
    }))
    expect(items.map(item => item.id)).toEqual(['work:c-2:v-2:key-2', 'work:c-1:v-2:key-2'])
    expect(items[0]).toMatchObject({ kind: 'work', title: 'Check me', since: 5 })
    expect(items[1]).toMatchObject({ kind: 'work', title: 'Ship it' })
    expect(items[1]!.since).toBeUndefined()
  })

  it('changes the work id when the waiting decision changes', () => {
    const before = attentionItems([], board({ work: [workItem()] }))
    const nextSubject = workItem({
      verification: { id: 'v-3', verdict: 'accept', subjectKey: 'key-3', inputRef: 'in-2', inputRevision: 2 },
      humanAction: { action: 'accept', expectedInputRef: 'in-2', expectedInputRevision: 2, expectedVerificationId: 'v-3', expectedSubjectKey: 'key-3' },
    })
    const after = attentionItems([], board({ work: [nextSubject] }))
    expect(before[0]!.id).toBe('work:c-1:v-2:key-2')
    expect(after[0]!.id).toBe('work:c-1:v-3:key-3')

    const look = workItem({ humanAction: undefined, oversight: { requested: true, inputRef: 'in-2', inputRevision: 2 } })
    const lookAgain = workItem({
      humanAction: undefined, oversight: { requested: true, inputRef: 'in-2', inputRevision: 2 },
      verification: { id: 'v-2', verdict: 'accept', subjectKey: 'key-3', inputRef: 'in-2', inputRevision: 2 },
    })
    const firstLook = attentionItems([], board({ work: [look], pending: [lookPending()] }))
    const secondLook = attentionItems([], board({ work: [lookAgain], pending: [lookPending('c-1', 'v-2', 'key-3')] }))
    expect(firstLook[0]!.id).not.toBe(secondLook[0]!.id)
  })

  it('sorts by since ascending with untimed items last', () => {
    const items = attentionItems(
      [card({ id: 'dot-card-1', shownAt: 30 })],
      board({
        work: [
          workItem({ id: 'c-1' }),
          workItem({ id: 'c-2', humanAction: undefined, oversight: { requested: true, inputRef: 'in-2', inputRevision: 2 } }),
        ],
        pending: [lookPending('c-2')],
      }),
    )
    expect(items.map(item => item.id)).toEqual(['work:c-2:v-2:key-2', 'card:dot-card-1', 'work:c-1:v-2:key-2'])
  })
})
