import { describe, expect, it } from 'vitest'
import { DOT_INSTRUCTIONS } from './prompt.ts'
import { TOOL } from './contracts.ts'
import { TASK_ACTIONS } from './tools.ts'
import { formatNotices } from './batcher.ts'

describe('coordinator prompt contract', () => {
  it('names only real actions and real tools, without the removed ceremony', () => {
    const mentioned = new Set([...DOT_INSTRUCTIONS.matchAll(/action=([a-z]+)/g)].map(match => match[1]!))
    // Every action named belongs to a registered enum: dot_task's own, dot_settings', or dot_recipe's.
    const known = new Set<string>([...TASK_ACTIONS, 'propose', 'save', 'restore', 'remove'])
    for (const action of mentioned) expect(known.has(action), action).toBe(true)
    for (const action of ['reserve', 'baseline', 'subject', 'evidence', 'verify', 'hold', 'accept', 'move', 'note', 'delete', 'update', 'board']) expect(mentioned.has(action), action).toBe(false)
    // The core lifecycle is still taught.
    for (const action of ['create', 'dispatch', 'check', 'finish', 'closeout', 'reject', 'revise', 'supplement']) expect(mentioned.has(action), action).toBe(true)
    expect(DOT_INSTRUCTIONS).toContain(TOOL.task)
    expect(DOT_INSTRUCTIONS).toContain(TOOL.workspace)
    expect(DOT_INSTRUCTIONS).toContain('mcp__github__*')
    expect(DOT_INSTRUCTIONS).not.toContain('${TOOL.')
  })
  it('keeps model recommendations subordinate to explicit human and dot choices', () => {
    expect(DOT_INSTRUCTIONS).toContain('when the human names a model or route, pass it exactly and never substitute another')
    expect(DOT_INSTRUCTIONS).toContain("A recipe's saved model is the default for that recipe")
    expect(DOT_INSTRUCTIONS).toContain('keep it unless the human names a different one for this task')
    expect(DOT_INSTRUCTIONS).toContain('never overrides a recipe model')
    expect(DOT_INSTRUCTIONS).toContain('any different model requires a new explicit dispatch by you')
    expect(DOT_INSTRUCTIONS).toContain('a human-pinned model requires their approval first')
  })
  it('teaches the evidence grammar and the workspace read', () => {
    expect(DOT_INSTRUCTIONS).toContain('run:<runId>#<scenarioRef>')
    expect(DOT_INSTRUCTIONS).toContain('run:<runId>')
    expect(DOT_INSTRUCTIONS).toContain('file:<path>')
    expect(DOT_INSTRUCTIONS).toContain(`${TOOL.workspace} action=read`)
  })
  it('keeps request facts separate from resident approval guidance', () => {
    const notice = formatNotices([{ sessionId: 'task', kind: 'approval', requestId: 'ap-1', text: 'ap-1 · pwsh · sandbox boundary', at: 0 }])
    expect(notice).toContain('ap-1')
    expect(notice).toContain('sandbox boundary')
    expect(notice).not.toMatch(/Ask the human|credentials|publishing/)
    expect(DOT_INSTRUCTIONS).toMatch(/approvals=human/)
    expect(DOT_INSTRUCTIONS).toMatch(/questions=human/)
    expect(DOT_INSTRUCTIONS).toMatch(/human-required/)
  })
  it('answers in plain text and reserves cards for structure or interaction', () => {
    expect(DOT_INSTRUCTIONS).toMatch(/plain Markdown text/)
    expect(DOT_INSTRUCTIONS).toMatch(/show_view/)
    expect(DOT_INSTRUCTIONS).toMatch(/await_reply/)
    expect(DOT_INSTRUCTIONS).toMatch(/approval_id/)
    expect(DOT_INSTRUCTIONS).toMatch(/no text and no card/)
  })
  it('retains asynchronous coordination boundaries', () => {
    expect(DOT_INSTRUCTIONS).toMatch(/wait for notifications/)
    expect(DOT_INSTRUCTIONS).toMatch(/independent reviewer is optional/i)
    expect(DOT_INSTRUCTIONS).toMatch(/reviews are read-only/)
    expect(DOT_INSTRUCTIONS).toMatch(/Cancellation does not authorize deleting/)
    expect(DOT_INSTRUCTIONS).toMatch(/three failed rounds/)
    expect(DOT_INSTRUCTIONS).toMatch(/one recommended next step/)
    expect(DOT_INSTRUCTIONS).toMatch(/Silence is not consent/)
    expect(DOT_INSTRUCTIONS).toMatch(/one recommended option/)
  })
  it('writes agent-facing work in English and keeps the human\'s words verbatim', () => {
    const language = DOT_INSTRUCTIONS.split('\n').find((entry) => entry.startsWith('- Language:'))
    expect(language).toBeDefined()
    for (const phrase of ['is in English', 'verbatim', 'original language', 'deliverable_language', "in the human's language"]) expect(language).toContain(phrase)
    expect(DOT_INSTRUCTIONS).toContain('user_request')
  })
  it('draws the line between her own session and a task run', () => {
    expect(DOT_INSTRUCTIONS).toContain('What you do yourself and what goes to a run:')
    expect(DOT_INSTRUCTIONS).toContain('You never edit files or run commands yourself, even if a tool for it appears; those tools belong to runs.')
    expect(DOT_INSTRUCTIONS).toContain(`reading a delivered file or two with ${TOOL.workspace} action=read`)
    expect(DOT_INSTRUCTIONS).toContain('Choose task presets by fit: "ptc" for scripted batch work, "cordis" for DSH plugin development.')
  })
  it('carries no leftover vocabulary from the removed regimes', () => {
    for (const stale of ['approvalNotice', 'assessApprovalRisk', 'EPERM', 'call action=list', 'dot_start_task', 'check_only', 'Every reply to the human ends with', 'every reply goes inside a card', 'end with one show_view']) {
      expect(DOT_INSTRUCTIONS, stale).not.toContain(stale)
    }
  })
})
