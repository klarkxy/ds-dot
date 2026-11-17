import { describe, expect, it } from 'vitest'
import { DOT_INSTRUCTIONS } from './prompt.ts'
import { TOOL } from './contracts.ts'
import { TASK_ACTIONS } from './tools.ts'
import { formatNotices } from './batcher.ts'

describe('coordinator prompt contract', () => {
  it('teaches every supported task action without the removed ceremony', () => {
    const mentioned = new Set([...DOT_INSTRUCTIONS.matchAll(/action=([a-z]+)/g)].map(match => match[1]))
    for (const action of TASK_ACTIONS) expect(mentioned.has(action), action).toBe(true)
    for (const action of ['reserve', 'baseline', 'subject', 'evidence', 'verify', 'hold', 'accept', 'move', 'note', 'delete', 'update', 'board']) expect(mentioned.has(action), action).toBe(false)
    expect(DOT_INSTRUCTIONS).toContain(TOOL.task)
    expect(DOT_INSTRUCTIONS).not.toContain('${TOOL.')
  })
  it('keeps request facts separate from resident approval guidance', () => {
    const notice = formatNotices([{ sessionId: 'task', kind: 'approval', requestId: 'ap-1', text: 'ap-1 · pwsh · sandbox boundary', at: 0 }])
    expect(notice).toContain('ap-1')
    expect(notice).toContain('sandbox boundary')
    expect(notice).not.toMatch(/Ask the human|credentials|publishing/)
    expect(DOT_INSTRUCTIONS).toMatch(/approvals=human/)
    expect(DOT_INSTRUCTIONS).toMatch(/questions=human/)
  })
  it('retains reply and asynchronous coordination boundaries', () => {
    expect(DOT_INSTRUCTIONS).toMatch(/show_view/)
    expect(DOT_INSTRUCTIONS).toMatch(/wait for notifications/)
    expect(DOT_INSTRUCTIONS).toMatch(/independent reviewer is optional/i)
    expect(DOT_INSTRUCTIONS).toMatch(/Cancellation does not authorize deleting/)
  })
  it('writes agent-facing work in English and keeps the human\'s words verbatim', () => {
    const language = DOT_INSTRUCTIONS.split('\n').find((entry) => entry.startsWith('- Language:'))
    expect(language).toBeDefined()
    for (const phrase of ['is written in English', 'user_request', 'verbatim', 'never translate them', 'deliverable_language', "in the human's language"]) expect(language).toContain(phrase)
  })
  it('specifies requirements by scenario and leaves the contract to the rendered brief', () => {
    for (const phrase of ['scenarios', 'scenarioRef', 'constraintRef', 'covers', 'Write each fact once', "The service renders the run's first prompt from the stored input", 'Do not restate requirements or scope there', 'is not checked, so revise the input instead', 'Report section', 'a claim, not a verdict', 'every one of its scenarios is backed by evidence']) {
      expect(DOT_INSTRUCTIONS).toContain(phrase)
    }
  })
})
