import { describe, expect, it } from 'vitest'
import { COORDINATOR_DISCIPLINES, DOT_INSTRUCTIONS } from './prompt.ts'
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
    expect(DOT_INSTRUCTIONS).toContain(`reading a delivered file or two with read or ${TOOL.workspace} action=read`)
    expect(DOT_INSTRUCTIONS).toContain('Files attached in chat arrive as saved read-only paths')
    expect(DOT_INSTRUCTIONS).toContain('Choose task presets by fit: "ptc" for scripted batch work, "cordis" for DSH plugin development.')
  })
  it('carries no leftover vocabulary from the removed regimes', () => {
    for (const stale of ['approvalNotice', 'assessApprovalRisk', 'EPERM', 'call action=list', 'dot_start_task', 'check_only', 'Every reply to the human ends with', 'every reply goes inside a card', 'end with one show_view']) {
      expect(DOT_INSTRUCTIONS, stale).not.toContain(stale)
    }
  })
  it('grounds repo references in real files and git refs, accounting for linked worktrees', () => {
    const repoCheck = DOT_INSTRUCTIONS.split('\n').find((entry) => entry.includes('names a repository script, remote, or branch'))
    expect(repoCheck).toBeDefined()
    for (const phrase of ['package.json', "main checkout's .git/config", 'pointer file', 'linked worktree', 'reading .git/config there fails', 'never proves a branch exists', 'verify refs inside the run', 'base_ref', 'base_remote']) {
      expect(repoCheck).toContain(phrase)
    }
  })
  it('guards promised follow-ups and worktree creation against stale baselines and disabled idle checks', () => {
    const followUp = DOT_INSTRUCTIONS.split('\n').find((entry) => entry.includes('promise follow-up work for later'))
    expect(followUp).toBeDefined()
    for (const phrase of ['isolation=worktree', 'stacked PR', 'never call action=create early on a stale HEAD', TOOL.schedule, 'prerequisite task ID', 'idleCheckMinutes === 0', 'land in the target checkout', 'panel acceptance']) {
      expect(followUp).toContain(phrase)
    }
  })
  it('registers project workspaces only when dispatching work there and informs the human', () => {
    const workspace = DOT_INSTRUCTIONS.split('\n').find((entry) => entry.includes('Register a new workspace'))
    expect(workspace).toBeDefined()
    for (const phrase of ['dispatch work into', 'mention it to the human', 'do not register broad parent folders']) {
      expect(workspace).toContain(phrase)
    }
  })
  it('enforces the 4 coordinator communication disciplines within the 1,200-char budget', () => {
    const added = Object.values(COORDINATOR_DISCIPLINES).join('\n')
    expect(added.length).toBeLessThanOrEqual(1200)
    expect(DOT_INSTRUCTIONS).toContain(COORDINATOR_DISCIPLINES.singleQuestion)
    expect(DOT_INSTRUCTIONS).toContain(COORDINATOR_DISCIPLINES.prNotDelivery)
    expect(DOT_INSTRUCTIONS).toContain(COORDINATOR_DISCIPLINES.quietProgress)
    expect(DOT_INSTRUCTIONS).toContain(COORDINATOR_DISCIPLINES.channelOutput)
    expect(DOT_INSTRUCTIONS).toMatch(/one focused, structured question/i)
    expect(DOT_INSTRUCTIONS).toMatch(/opening a PR is not delivery/i)
    expect(DOT_INSTRUCTIONS).toMatch(/intermediate steps, automatic retries, and internal sync silent/i)
    expect(DOT_INSTRUCTIONS).toMatch(/no fixed word limit/i)
  })
})
