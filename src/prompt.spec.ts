import { describe, expect, it } from 'vitest'
import { DOT_INSTRUCTIONS } from './prompt.ts'
import { TOOL } from './contracts.ts'
import { formatNotices } from './batcher.ts'

describe('dot approval instructions', () => {
  it('keeps approval principles resident while notices contain only request facts', () => {
    for (const phrase of ['deleting data outside the project', 'pushing or publishing', 'spending money', 'credentials or secrets', 'allowed-once', 'explicit agreements']) {
      expect(DOT_INSTRUCTIONS).toContain(phrase)
    }
    const notice = formatNotices([{ sessionId: 'task', kind: 'approval', requestId: 'ap-1', text: 'ap-1 · task title · pwsh · sandbox boundary', at: 0 }])
    expect(notice).toContain('ap-1')
    expect(notice).toContain('sandbox boundary')
    expect(notice).not.toContain('credentials')
    expect(notice).not.toContain('Ask the human')
    expect(DOT_INSTRUCTIONS).not.toContain('instruction attached to it')
  })

  it('states human hard gates and applies the same approval rules to every preset', () => {
    expect(DOT_INSTRUCTIONS).toContain('When approvals=human, relay every approval to the human and never decide it yourself')
    expect(DOT_INSTRUCTIONS).toContain('When questions=human, relay every question unchanged and wait')
    expect(DOT_INSTRUCTIONS).toContain('including cordis tasks')
    expect(DOT_INSTRUCTIONS).not.toContain('allow all')
  })

  it('explains settled requests, permission boundaries and Windows retries', () => {
    expect(DOT_INSTRUCTIONS).toContain('Already settled')
    expect(DOT_INSTRUCTIONS).toContain('do not retry')
    expect(DOT_INSTRUCTIONS).toContain('spawn EPERM')
    expect(DOT_INSTRUCTIONS).toContain('taskPermission is independent')
    expect(DOT_INSTRUCTIONS).toContain('approval routing is not a sandbox or a guarantee')
  })

  it('closes every user-facing reply with one show_view card and keeps the background silent', () => {
    expect(DOT_INSTRUCTIONS).toContain('Every reply to the human ends with one show_view card')
    expect(DOT_INSTRUCTIONS).toContain('Calling it ends the turn at once')
    expect(DOT_INSTRUCTIONS).toContain('every ViewNode needs a "type" field')
    expect(DOT_INSTRUCTIONS).toContain('correct it and call it again in the same turn')
    expect(DOT_INSTRUCTIONS).toContain('A background wake-up with nothing the human must see')
    expect(DOT_INSTRUCTIONS).toContain('end that turn silently with no message')
  })

  it('interpolates actual tool names in every work-loop instruction', () => {
    expect(DOT_INSTRUCTIONS).not.toContain('${TOOL.')
    const lines = DOT_INSTRUCTIONS.split('\n')
    const expectedTools: Array<[string, string[]]> = [
      ['- A goal arrives:', [TOOL.startTask]],
      ['- An ordinary supplement arrives:', [TOOL.task, TOOL.sendToSession, TOOL.interruptSession]],
      ['- A work session ends:', [TOOL.read, TOOL.task]],
      ['- Review fails:', [TOOL.task]],
    ]
    for (const [prefix, tools] of expectedTools) {
      const line = lines.find((entry) => entry.startsWith(prefix))
      expect(line).toBeDefined()
      for (const tool of tools) expect(line).toContain(tool)
    }
  })

  it('keeps task responsibility after a turn and infers routine acceptance criteria', () => {
    expect(DOT_INSTRUCTIONS).toContain('Ending your current turn does not end your responsibility for a task')
    expect(DOT_INSTRUCTIONS).toContain('reasonable, verifiable acceptance criteria yourself')
    expect(DOT_INSTRUCTIONS).toContain('scope, authorization or an important trade-off')
  })

  it('waits for notifications instead of polling or repeating supplements', () => {
    expect(DOT_INSTRUCTIONS).toContain('If nothing else can move, end your turn and wait for notifications')
    expect(DOT_INSTRUCTIONS).toContain('relay the supplement once')
    expect(DOT_INSTRUCTIONS).toContain('do not resend or poll for it')
    expect(DOT_INSTRUCTIONS).toContain('do not repeatedly read, resend or nudge')
    expect(DOT_INSTRUCTIONS).toContain('This does not cancel or interrupt current work')
  })

  it('organizes review failure, acceptance and the next queued task into one loop', () => {
    expect(DOT_INSTRUCTIONS).toContain('specific failed criteria and evidence')
    expect(DOT_INSTRUCTIONS).toContain('conflicting criteria or missing authorization')
    expect(DOT_INSTRUCTIONS).toContain('advance any todo task released by the directory lock')
  })

  it('includes four generic patterns rather than embedding acceptance prompts', () => {
    expect(DOT_INSTRUCTIONS).toContain('Representative examples (patterns, not fixed task sequences)')
    for (const phrase of ['Exact text into a file', 'Several linked requirements', 'normal follow-up while work runs', 'still running normally']) expect(DOT_INSTRUCTIONS).toContain(phrase)
    for (const phrase of ['picnic', 'dinner-plan', 'weekend-note', 'quiet-note', 'alpha.txt', 'beta.txt']) expect(DOT_INSTRUCTIONS).not.toContain(phrase)
  })

  it('keeps directory preflight and treats build or test verification as write work', () => {
    expect(DOT_INSTRUCTIONS).toContain('with check_only')
    expect(DOT_INSTRUCTIONS).toContain("their own session is running there")
    expect(DOT_INSTRUCTIONS).toContain('verification that runs builds or tests, or writes temporary data, is a write task')
    expect(DOT_INSTRUCTIONS).toContain("shares the task's directory lock")
    expect(DOT_INSTRUCTIONS).not.toContain('Use read-only access for research and review.')
  })

  it('normally assigns independent review and knows when to stop or wait for the human', () => {
    expect(DOT_INSTRUCTIONS).toContain('open a new session with role=review')
    expect(DOT_INSTRUCTIONS).toContain('reports conclusions without changing the deliverable')
    expect(DOT_INSTRUCTIONS).toContain('review small tasks yourself')
    expect(DOT_INSTRUCTIONS).toContain('After three consecutive unsuccessful review rounds, ask the human')
    expect(DOT_INSTRUCTIONS).toContain('set human_review and move the task to review')
    expect(DOT_INSTRUCTIONS).toContain('move it to done only after their confirmation')
  })

  it('keeps cancellation separate from permission to clean up the directory', () => {
    expect(DOT_INSTRUCTIONS).toContain('When cancelling a task, report what remains in its directory')
    expect(DOT_INSTRUCTIONS).toContain('do not automatically clean up deliverables or intermediate files')
  })

  it('keeps identity in the persona section and facts independent of its tone', () => {
    expect(DOT_INSTRUCTIONS).not.toMatch(/Dorothy|桃乐丝/)
    expect(DOT_INSTRUCTIONS).not.toContain('persona lives in your tone and in small talk')
    expect(DOT_INSTRUCTIONS).not.toContain('drop the play')
    expect(DOT_INSTRUCTIONS).toContain('That is you, not a role you are playing')
    expect(DOT_INSTRUCTIONS).toContain('Facts, task results, approval decisions and questions must be accurate')
    expect(DOT_INSTRUCTIONS).toContain('while remaining yourself')
  })

  it('drafts and proposes persona changes without erasing cognition', () => {
    expect(DOT_INSTRUCTIONS).toContain('If they give only a name, start a read task to research the character before drafting')
    expect(DOT_INSTRUCTIONS).toContain('action=propose, field=persona')
    expect(DOT_INSTRUCTIONS).toContain('Changing persona never clears or archives cognition')
  })

  it('allows small talk from memory only with an unverified caveat and checks exact answers in a task', () => {
    expect(DOT_INSTRUCTIONS).toContain('from memory and unverified')
    expect(DOT_INSTRUCTIONS).toContain('start a task to check rather than guess')
  })
})
