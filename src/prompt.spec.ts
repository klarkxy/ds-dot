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
      ['- A goal arrives:', [TOOL.task]],
      ['- Dispatch a run:', [TOOL.task, TOOL.startTask]],
      ['- An ordinary supplement arrives:', [TOOL.task]],
      ['- A run reports done or fails:', [TOOL.task]],
      ['- Verify the delivery:', [TOOL.task]],
      ['- Close out:', [TOOL.task]],
    ]
    for (const [prefix, tools] of expectedTools) {
      const line = lines.find((entry) => entry.startsWith(prefix))
      expect(line).toBeDefined()
      for (const tool of tools) expect(line).toContain(tool)
    }
  })

  it('keeps change responsibility after a turn and infers routine acceptance criteria', () => {
    expect(DOT_INSTRUCTIONS).toContain('Ending your current turn does not end your responsibility for a change')
    expect(DOT_INSTRUCTIONS).toContain('verifiable acceptance criteria yourself')
    expect(DOT_INSTRUCTIONS).toContain('scope, authorization or an important trade-off')
  })

  it('waits for notifications instead of polling or repeating supplements', () => {
    expect(DOT_INSTRUCTIONS).toContain('end your turn and wait for notifications')
    expect(DOT_INSTRUCTIONS).toContain('action=supplement')
    expect(DOT_INSTRUCTIONS).toContain('a refusal means the input moved on')
    expect(DOT_INSTRUCTIONS).toContain('do not resend or poll for it')
    expect(DOT_INSTRUCTIONS).toContain('do not repeatedly read, resend or nudge')
    expect(DOT_INSTRUCTIONS).toContain('no matter how casually the human phrases it')
    expect(DOT_INSTRUCTIONS).toContain('never resend the same content through another path')
    expect(DOT_INSTRUCTIONS).toContain('One investigation at a time')
    expect(DOT_INSTRUCTIONS).toContain('retry action=finish only when something actually changed')
    expect(DOT_INSTRUCTIONS).toContain('end that turn silently')
  })

  it('covers change, reservation, supplement, settlement, verification and closeout', () => {
    for (const action of ['action=create', 'action=revise', 'action=supplement', 'action=reserve', 'action=baseline', 'action=step', 'action=finish', 'action=subject', 'action=verify', 'action=reject', 'action=accept', 'action=pause', 'action=resume', 'action=cancel']) {
      expect(DOT_INSTRUCTIONS).toContain(action)
    }
    expect(DOT_INSTRUCTIONS).toContain('a finished session turn is not a finished change')
    expect(DOT_INSTRUCTIONS).toContain('a completed run is not an accepted verification')
    expect(DOT_INSTRUCTIONS).toContain('specific failed criteria and evidence')
    expect(DOT_INSTRUCTIONS).toContain('conflicting criteria or missing authorization')
    expect(DOT_INSTRUCTIONS).toContain('After three consecutive unsuccessful verification rounds, ask the human')
  })

  it('keeps UNKNOWN and refusal semantics instead of blind retries', () => {
    for (const phrase of ['conflict, quota, baseline, stale, unknown, recovery, closed and cancelled', 'are durable facts, not retry hints', 'reconcile instead of repeating the call', 'never fabricate a fresh session or second prompt']) {
      expect(DOT_INSTRUCTIONS).toContain(phrase)
    }
    expect(DOT_INSTRUCTIONS).toContain('An unknown stop keeps the run occupied')
    expect(DOT_INSTRUCTIONS).toContain('do not free its paths or reuse them for a new run')
    for (const phrase of ['even with small argument changes', 'is still that fact', 'take a safe alternate path', 'escalate to the human', 'never repeat the same action without new evidence']) {
      expect(DOT_INSTRUCTIONS).toContain(phrase)
    }
  })

  it('includes four generic patterns rather than embedding acceptance prompts', () => {
    expect(DOT_INSTRUCTIONS).toContain('Representative examples (patterns, not fixed task sequences)')
    for (const phrase of ['Exact text into a file', 'Several linked requirements', 'normal follow-up while work runs', 'still running normally']) expect(DOT_INSTRUCTIONS).toContain(phrase)
    for (const phrase of ['picnic', 'dinner-plan', 'weekend-note', 'quiet-note', 'alpha.txt', 'beta.txt']) expect(DOT_INSTRUCTIONS).not.toContain(phrase)
  })

  it('keeps workspace preflight and whole-workspace review', () => {
    expect(DOT_INSTRUCTIONS).toContain('with check_only')
    expect(DOT_INSTRUCTIONS).toContain("their own session is running there")
    expect(DOT_INSTRUCTIONS).toContain('a review run reserves the whole workspace')
    expect(DOT_INSTRUCTIONS).toContain('reserve the review run first')
    expect(DOT_INSTRUCTIONS).not.toContain('role=review')
  })

  it('keeps cancellation separate from permission to clean up the workspace', () => {
    expect(DOT_INSTRUCTIONS).toContain('each open run is settled in turn')
    expect(DOT_INSTRUCTIONS).toContain('report what remains in its workspace')
    expect(DOT_INSTRUCTIONS).toContain('do not automatically clean up deliverables or intermediate files')
  })

  it('keeps step attribution tied to the run\'s own result on the current input', () => {
    expect(DOT_INSTRUCTIONS).toContain('step_refs')
    expect(DOT_INSTRUCTIONS).toContain('stable ids')
    expect(DOT_INSTRUCTIONS).toContain('a readable result')
    expect(DOT_INSTRUCTIONS).toContain('an accepted first prompt is not a result')
    expect(DOT_INSTRUCTIONS).toContain('belongs to whoever wrote it next')
    expect(DOT_INSTRUCTIONS).toContain('behavior_notes')
    expect(DOT_INSTRUCTIONS).toContain('max_concurrent')
    expect(DOT_INSTRUCTIONS).toContain('execution configuration')
    expect(DOT_INSTRUCTIONS).toContain('changing it alone does not make a new input')
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
    expect(DOT_INSTRUCTIONS).toContain('If they give only a name, start a read run to research the character before drafting')
    expect(DOT_INSTRUCTIONS).toContain('action=propose, field=persona')
    expect(DOT_INSTRUCTIONS).toContain('Changing persona never clears or archives cognition')
  })

  it('allows small talk from memory only with an unverified caveat and checks exact answers in a run', () => {
    expect(DOT_INSTRUCTIONS).toContain('from memory and unverified')
    expect(DOT_INSTRUCTIONS).toContain('look it up yourself with web_search')
    expect(DOT_INSTRUCTIONS).toContain('web_fetch')
    expect(DOT_INSTRUCTIONS).toContain('Do not open a session for a small lookup')
    expect(DOT_INSTRUCTIONS).not.toContain('start a task to check rather than guess')
  })
})
