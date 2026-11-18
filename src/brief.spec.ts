import { describe, expect, it } from 'vitest'
import { inputConstraints, legacyConstraints, renderBrief, renderSupplement, runTitle, type BriefInput, type BriefRun } from './brief.ts'

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
    expect(text).toContain('Read the original request, the requirements, and the workspace before you choose.')
    expect(text).toContain('choose routine reversible details yourself')
    expect(text).toContain('Do not ask to re-approve work this order already authorizes.')
    expect(text).toContain('wrong guess would materially change the result')
    expect(text).toContain('externally unauthorized, or costly')
    expect(text).toContain('Silence is not consent.')
    expect(text).toContain('one recommended next step')
    expect(text).toContain('Do not invent a requirement to get past it.')
    expect(text).toContain('An intermediate finding or a patch is not delivery.')
    expect(text).toContain('without a new hypothesis')
    expect(text).toContain('do not declare PASS or FAIL on the work order.')
  })

  it('turns a legacy behaviorNotes JSON string into C1..Cn and keeps plain text as one constraint', () => {
    const notes = '["keep the tests","do not touch src/prompt.ts"]'
    expect(legacyConstraints(notes)).toEqual([
      { constraintRef: 'C1', text: 'keep the tests' },
      { constraintRef: 'C2', text: 'do not touch src/prompt.ts' },
    ])
    expect(legacyConstraints('be careful')).toEqual([{ constraintRef: 'C1', text: 'be careful' }])
    expect(legacyConstraints('[not json')).toEqual([{ constraintRef: 'C1', text: '[not json' }])
    const legacy: BriefInput = { ...input, constraints: undefined, behaviorNotes: notes, deliverableLanguage: undefined, userRequest: undefined }
    expect(inputConstraints(legacy).map(item => item.constraintRef)).toEqual(['C1', 'C2'])
    const text = renderBrief({ changeId: 'c-1', title: 'Ship', input: legacy, run: run() })
    expect(text).toContain('- C1: keep the tests')
    expect(text).toContain('- C2: do not touch src/prompt.ts')
    expect(text).toContain('Write deliverables in the language the original request and existing files use. Write your report in English.')
    expect(text).not.toContain('## Original request')
    const named = renderBrief({ changeId: 'c-1', title: 'Ship', input, run: run() })
    expect(named).toContain('- k1: do not add files')
    expect(named).not.toContain('- C1:')
    const cleared = renderBrief({ changeId: 'c-1', title: 'Ship', input: { ...legacy, constraints: [] }, run: run() })
    expect(cleared).not.toContain('## Constraints')
  })

  it('renders no tasks when the run covers no steps', () => {
    const text = renderBrief({ changeId: 'c-1', title: 'Ship', input, run: run({ stepRefs: [] }) })
    expect(text).not.toContain('## Your tasks')
    expect(text).not.toContain('done | skipped')
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
      run: run({ kind: 'review', access: 'write', writeScope: { kind: 'workspace-exclusive' }, stepRefs: ['s1', 's2'] }),
    })
    expect(review).toContain('You are the independent reviewer')
    expect(review).toContain('Do not guess a missing fact into a finding.')
    expect(review).toContain('Do not change the delivery.')
    expect(review).not.toContain('choose routine reversible details yourself')
    expect(review).not.toContain('Silence is not consent.')
    expect(whole).toContain('without a new hypothesis')
    expect(review).toContain('Access: the whole workspace is held for this review.')
    expect(review).not.toContain('## Your tasks')
    expect(review).not.toContain('done | skipped')
    expect(review).not.toContain('Changed files:')
    expect(review).toContain('- Open issues:')
    expect(review).toContain('compare the diff')
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
