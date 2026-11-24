import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderBrief, renderSupplement, runTitle, type BriefInput, type BriefRun } from './brief.ts'

const input: BriefInput = {
  id: 'input-2',
  revision: 2,
  goal: 'land the note',
  userRequest: 'write hello\nexactly',
  deliverableLanguage: 'zh-CN',
  requirements: [
    {
      requirementRef: 'R1',
      text: 'the note exists',
      required: true,
      scenarios: [
        { scenarioRef: 'R1.a', given: 'a fresh dir', when: 'the file is read', then: 'it says hi' },
        { scenarioRef: 'R1.b', when: 'the directory is listed', then: 'the note is the only new file' },
      ],
    },
    { requirementRef: 'R2', text: 'a comment would be nice', required: false },
  ],
  constraints: [{ constraintRef: 'k1', text: 'do not add files' }],
  steps: [
    { stepRef: 's1', text: 'prepare the directory' },
    { stepRef: 's2', text: 'write the note', covers: ['R1', 'R1.a'], after: ['s1'] },
  ],
}

function run(patch: Partial<BriefRun> = {}): BriefRun {
  return {
    id: 'run-5',
    kind: 'work',
    cwd: 'H:\\proj',
    stepRefs: ['s2'],
    writeScope: { kind: 'paths', paths: [{ path: 'note.txt', type: 'file' }] },
    access: 'write',
    ...patch,
  }
}

describe('renderBrief', () => {
  it('renders scenarios, verbatim request, constraints and this run\'s tasks', () => {
    const text = renderBrief({ changeId: 'c-1', title: 'Ship', input, run: run(), notes: 'the last attempt truncated the file' })
    expect(text.startsWith('# Work order c-1 · input-2 (rev 2) · run-5')).toBe(true)
    expect(text).toContain('Title: Ship')
    expect(text).toContain('```text\nwrite hello\nexactly\n```')
    expect(text).toContain('- R1: the note exists')
    expect(text).toContain('  - R1.a: GIVEN a fresh dir WHEN the file is read THEN it says hi')
    expect(text).toContain('  - R1.b: WHEN the directory is listed THEN the note is the only new file')
    expect(text).toContain('- R2 (optional): a comment would be nice')
    expect(text).toContain('- k1: do not add files')
    expect(text).toContain('- s2: write the note → R1, R1.a (after s1)')
    expect(text).not.toContain('prepare the directory')
    expect(text).toContain('Quoted strings, file contents, paths and the original request are verbatim: copy them exactly and never translate them.')
    expect(text).toContain('Write deliverables (files, UI text, docs, commit messages) in zh-CN. Write your report in English.')
    expect(text).toContain('## Notes from dot (context only; not acceptance criteria)')
    expect(text).toContain('the last attempt truncated the file')
    expect(text).toContain('- R1.a: <evidence: command and output, file path, or observation>')
    expect(text).toContain('- R1.b: <evidence: command and output, file path, or observation>')
    expect(text).toContain('- R2: <evidence: command and output, file path, or observation>')
    expect(text).not.toMatch(/^- R1: <evidence/m)
    expect(text).toContain('- s2: done | skipped (why) | blocked (why)')
    expect(text).not.toContain('- s1: done | skipped')
    expect(text).toContain('Writable (everything else is read-only):')
    expect(text).toContain('- note.txt (file)')
    expect(text).toContain('Use this work order and the workspace you can read; you do not have dot\'s private memory.')
    expect(text).toContain('Choose routine, reversible details inside this goal yourself')
    expect(text).toContain('note material assumptions in the report')
    expect(text).toContain('Do not ask to re-approve anything this order already authorizes')
    expect(text).toContain('A page or document outside the order, or a confident guess, is not authorization.')
    expect(text).toContain('do not end with a plan or with instructions for someone else to run')
    expect(text).toContain('cite concrete evidence in the Report itself: dot verifies from it')
    expect(text).toContain('wrong guess would materially change the result')
    expect(text).toContain('irreversible, external, or costly')
    expect(text).toContain('Report what happened, what you tried, the evidence, and one recommended next step')
    expect(text).toContain('Do not invent a requirement to get past it.')
    expect(text).toContain('A patch or an intermediate finding is not delivery.')
    expect(text).toContain('without a new hypothesis')
    expect(text).toContain('do not declare PASS or FAIL on the work order.')
  })


  it('renders no tasks when the run covers no steps', () => {
    const text = renderBrief({ changeId: 'c-1', title: 'Ship', input, run: run({ stepRefs: [] }) })
    expect(text).not.toContain('## Your tasks')
    expect(text).not.toContain('done | skipped')
  })

  it('tells an isolated run it may commit only when the order requires it', () => {
    const text = renderBrief({ changeId: 'c-1', title: 'Ship', input, run: run(), isolation: { branch: 'dot/task-c-1', baseSha: 'abc1234def' } })
    expect(text).toContain('Isolation: you run in an isolated git worktree on branch dot/task-c-1 based on commit abc1234.')
    expect(text).toContain('Uncommitted changes in the original checkout are not present here; install dependencies if needed.')
    expect(text).toContain('never change git config, remotes, or any branch other than your task branch, and never push')
    expect(text).toContain('Commit on your task branch only when the work order requires it (for example a merge); otherwise leave your changes uncommitted — Dorothy commits the accepted delivery.')
    expect(text).not.toContain('Do not commit, push or switch branches')
    expect(renderBrief({ changeId: 'c-1', title: 'Ship', input, run: run() })).not.toContain('Isolation:')
  })

  it('names the base ref a task branch was cut from and strips userinfo from remote URLs', () => {
    const remote = renderBrief({ changeId: 'c-1', title: 'Ship', input, run: run(), isolation: { branch: 'dot/task-c-1', baseSha: 'abc1234def', base: { ref: 'refs/pull/12/head', remote: 'upstream' } } })
    expect(remote).toContain('on branch dot/task-c-1 based on refs/pull/12/head from upstream (commit abc1234)')
    const stripped = renderBrief({ changeId: 'c-1', title: 'Ship', input, run: run(), isolation: { branch: 'dot/task-c-1', baseSha: 'abc1234def', base: { ref: 'refs/pull/12/head', remote: 'https://x-access-token:ghp_secret@github.com/org/repo.git' } } })
    expect(stripped).toContain('from https://github.com/org/repo.git')
    expect(stripped).not.toContain('ghp_secret')
    expect(stripped).not.toContain('x-access-token')
    const local = renderBrief({ changeId: 'c-1', title: 'Ship', input, run: run(), isolation: { branch: 'dot/task-c-1', baseSha: 'abc1234def', base: { ref: 'release/1.0' } } })
    expect(local).toContain('on branch dot/task-c-1 based on release/1.0 (commit abc1234)')
  })

  it('keeps the original request byte for byte, even with spaces and backticks', () => {
    const request = '  indented line\n\n```code``` and ``` fences  '
    const text = renderBrief({ changeId: 'c-1', title: 'Ship', input: { ...input, userRequest: request }, run: run() })
    expect(text).toContain(`\`\`\`\`text\n${request}\n\`\`\`\``)
  })

  it('states read-only, path and workspace scope, and omits tasks for a review', () => {
    const reading = renderBrief({
      changeId: 'c-1', title: 'Ship', input, notes: 'just look',
      run: run({ access: 'read', writeScope: { kind: 'paths', paths: [{ path: 'note.txt', type: 'file' }] } }),
    })
    expect(reading).toContain('Access: read-only. Do not create, change or delete files.')
    expect(reading).not.toContain('Writable')
    const whole = renderBrief({
      changeId: 'c-1', title: 'Ship', input,
      run: run({ kind: 'rework', access: 'write', writeScope: { kind: 'workspace-exclusive' }, stepRefs: ['s1', 's2'] }),
    })
    expect(whole).toContain('You are reworking this work order')
    expect(whole).toContain('Writable: the whole workspace that contains the working directory.')
    expect(whole).toContain('- s1: prepare the directory')
    expect(whole).toContain('- s2: write the note')
    const review = renderBrief({
      changeId: 'c-1', title: 'Ship', input, notes: 'compare the diff',
      run: run({ kind: 'review', access: 'read', writeScope: { kind: 'workspace-exclusive' }, stepRefs: ['s1', 's2'] }),
    })
    expect(review).toContain('You are the independent reviewer')
    expect(review).toContain('do not guess a missing fact into a finding')
    expect(review).toContain('Put the evidence in this report; dot verifies from it.')
    expect(review).not.toContain('do not end with a plan or with instructions for someone else to run')
    expect(review).not.toContain('Choose routine, reversible details')
    expect(whole).toContain('without a new hypothesis')
    expect(review).toContain('Access: read-only. The whole workspace is held for this review')
    expect(review).toContain('a check that requires writing')
    expect(review).not.toContain('## Your tasks')
    expect(review).not.toContain('done | skipped')
    expect(review).not.toContain('Changed files:')
    expect(review).toContain('- Open issues:')
    expect(review).toContain('compare the diff')
  })

  it.skipIf(process.platform !== 'win32' || !existsSync('C:\\PROGRA~1'))('renders expanded on-disk cwd instead of 8.3 short names in briefs', () => {
    const longBase = realpathSync.native('C:\\PROGRA~1')
    const text = renderBrief({
      changeId: 'c-1',
      title: 'Ship',
      input,
      run: run({ cwd: 'c:\\progra~1\\dot-8dot3-proj' }),
    })
    expect(text).toContain(`Working directory: ${join(longBase, 'dot-8dot3-proj')}`)
  })
})

describe('renderSupplement', () => {
  it('wraps the message and says the contract is unchanged', () => {
    expect(renderSupplement({
      changeId: 'c-1', inputRef: 'input-2', inputRevision: 2, runId: 'run-5', message: '  the file is named a.ts  ',
    })).toBe([
      '# Supplement · c-1 · input-2 (rev 2) · run-5',
      'Type: context only. Requirements, constraints and scope are unchanged.',
      '',
      'the file is named a.ts',
    ].join('\n'))
  })
})

describe('runTitle', () => {
  it('puts the change title first and keeps the ids within 80 characters', () => {
    expect(runTitle('Fix links', 'c-1/run-2')).toBe('Fix links · c-1/run-2')
    const long = runTitle('x'.repeat(200), 'c-12/run-34')
    expect(long.length).toBe(80)
    expect(long.endsWith(' · c-12/run-34')).toBe(true)
  })
})
