/** Steps are progress notes; checks and run settlement decide completion. */
import { describe, expect, it } from 'vitest'
import { WorkBook } from './work.ts'

async function setup() {
  const book = new WorkBook(async () => {})
  const change = await book.createChange({ title: 'Ship', cwd: 'H:/project', goal: 'land', requirements: [{ requirementRef: 'R1', text: 'works', required: true }], steps: [{ stepRef: 's1', text: 'work' }] })
  return { book, change }
}

describe('step progress notes', () => {
  it('records a progress note without a run or result proof and does not accept the change', async () => {
    const { book, change } = await setup()
    expect(await book.noteStep(change.id, 's1', undefined, change.currentRevision)).toMatchObject({ steps: [{ stepRef: 's1', done: true }] })
    expect(book.change(change.id)?.steps[0]).not.toHaveProperty('subjectRef')
    expect(book.workView(change.id)?.status).toBe('waiting')
    expect(book.change(change.id)?.closeout).toBeUndefined()
  })

  it('allows a reserved run to annotate progress and refuses a stale input', async () => {
    const { book, change } = await setup()
    const reserved = await book.reserveRun({ changeId: change.id, writeScope: { kind: 'paths', paths: [] } })
    if (!reserved.ok) throw new Error(reserved.message)
    expect(await book.noteStep(change.id, 's1', reserved.run.id, change.currentRevision)).toMatchObject({ steps: [{ done: true, runId: reserved.run.id }] })
    expect(book.run(reserved.run.id)?.phase).toBe('reserved')
    await book.reviseChange(change.id, { goal: 'later' })
    expect(await book.noteStep(change.id, 's1', reserved.run.id, change.currentRevision)).toMatchObject({ code: 'stale' })
    expect(book.change(change.id)?.steps[0]?.done).toBe(false)
  })
})
