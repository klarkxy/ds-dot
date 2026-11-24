import { describe, expect, it } from 'vitest'
import type { AgreementEntry, CognitionEntry } from './contracts.ts'
import {
  agreementEntriesFromText, agreementsSection, agreementsText, applyAgreementEdit, applyCognitionEdit, applyCognitionOps,
  cognitionEntriesFromText, cognitionSection, cognitionText, cognitionWithActive, filterCognitionEntries, matchEntry, maxEntrySuffix, migrateAgreementEntries,
  migrateCognitionEntries, normalizeEntry, parseCognitionOps, parseKnowledgeEdit, rankCognition, sameCognitionContent, sameEntries, splitEntryText,
} from './memory.ts'

const agreement = (id: string, text: string, at = 0): AgreementEntry => ({ id, text, createdAt: at, updatedAt: at })
const cognition = (id: string, text: string, at = 0, seenAt = at, pinned?: true): CognitionEntry => ({ id, text, createdAt: at, updatedAt: at, seenAt, ...(pinned ? { pinned } : {}) })
/** An id allocator standing in for the persisted counter, continuing above `start`. */
const ids = (prefix: 'a' | 'c', start = 0) => { let n = start; return () => `${prefix}${++n}` }

describe('entry text splitting', () => {
  it('splits non-empty lines, strips bullets, keeps inner spacing verbatim and keeps headings only for agreements', () => {
    const text = '# About the human\n\n- calls me Dot\n* prefers short answers\nfree prose\n-not an item\n- two  spaces\tinside\n'
    expect(splitEntryText(text)).toEqual(['# About the human', 'calls me Dot', 'prefers short answers', 'free prose', '-not an item', 'two  spaces\tinside'])
    expect(splitEntryText(text, true)).toEqual(['calls me Dot', 'prefers short answers', 'free prose', '-not an item', 'two  spaces\tinside'])
    expect(normalizeEntry('  -  likes\n  tea ')).toBe('likes tea')
  })

  it('migrates the real cognition shape: two headings, 6 + 7 bullets, a blank line → 13 entries', () => {
    const legacy = [
      '## 对人类的理解',
      ...Array.from({ length: 6 }, (_, i) => `- 人类条目 ${i + 1}`),
      '',
      '## 对自己的理解',
      ...Array.from({ length: 7 }, (_, i) => `- 自身条目 ${i + 1}`),
    ].join('\n')
    const entries = migrateCognitionEntries(legacy, 99, ids('c'))
    expect(entries).toHaveLength(13)
    expect(entries.map(entry => entry.text)).toEqual([...Array.from({ length: 6 }, (_, i) => `人类条目 ${i + 1}`), ...Array.from({ length: 7 }, (_, i) => `自身条目 ${i + 1}`)])
    expect(entries.every(entry => entry.createdAt === 99 && entry.updatedAt === 99 && entry.seenAt === 99)).toBe(true)
    expect(entries.map(entry => entry.id)).toEqual(Array.from({ length: 13 }, (_, i) => `c${i + 1}`))
  })

  it('migrates agreements keeping every non-empty line', () => {
    const entries = migrateAgreementEntries('# 标题\n- one\nfree prose\n\n- two\n', 7, ids('a'))
    expect(entries.map(entry => entry.text)).toEqual(['# 标题', 'one', 'free prose', 'two'])
    expect(entries.map(entry => entry.id)).toEqual(['a1', 'a2', 'a3', 'a4'])
  })

  it('migrates near-duplicate lines verbatim without deduping, and a unique literal still matches', () => {
    // Inner spacing is stored as written; the comparison key still equates them.
    const entries = migrateAgreementEntries('- A  B\n- A B\n', 5, ids('a'))
    expect(entries.map(entry => entry.text)).toEqual(['A  B', 'A B'])
    // Quoting one row verbatim reaches that row even though the folded keys collide.
    expect(matchEntry(entries, 'A B', 'agreement').text).toBe('A B')
    expect(matchEntry(entries, 'A  B', 'agreement').text).toBe('A  B')
    // A folded needle that is not a unique literal stays ambiguous.
    expect(() => matchEntry(entries, 'a b', 'agreement')).toThrowError(expect.objectContaining({ code: 'dot/ambiguous-agreement' }))
  })

  it('dedups a proposal by entryKey while migration keeps historical near-duplicates', () => {
    const existing = [agreement('a1', 'Likes tea', 5)]
    const next = agreementEntriesFromText('- likes  tea\n- Likes tea\n- a new rule\n', existing, 9, ids('a', 1), true)
    expect(next.map(entry => entry.id)).toEqual(['a1', 'a2'])
    expect(next.map(entry => entry.text)).toEqual(['Likes tea', 'a new rule'])
    const migrated = migrateAgreementEntries('- A  B\n- A B\n', 5, ids('a'))
    expect(migrated.map(entry => entry.text)).toEqual(['A  B', 'A B'])
  })

  it('keeps double spaces and tabs verbatim through agreement and cognition migration', () => {
    const text = '- 只归档文件「Release  Notes.md」\n- 缩进\t靠 tab\n'
    expect(migrateAgreementEntries(text, 5, ids('a')).map(entry => entry.text)).toEqual(['只归档文件「Release  Notes.md」', '缩进\t靠 tab'])
    expect(migrateCognitionEntries(`## 认知\n${text}`, 5, ids('c')).map(entry => entry.text)).toEqual(['只归档文件「Release  Notes.md」', '缩进\t靠 tab'])
  })

  it('reuses ids and timestamps for identical lines when text becomes entries', () => {
    const existing = [agreement('a1', 'keep me', 5), agreement('a2', 'drop me', 5)]
    const next = agreementEntriesFromText('- keep me\n- new rule\n', existing, 9, ids('a', 2))
    expect(next.map(entry => entry.id)).toEqual(['a1', 'a3'])
    expect(next[0]).toEqual(existing[0])
    expect(next[1]).toMatchObject({ text: 'new rule', createdAt: 9, updatedAt: 9 })
    const cog = cognitionEntriesFromText('- keep me\n- new idea\n', [cognition('c1', 'keep me', 5, 6)], 9, ids('c', 1))
    expect(cog.map(entry => entry.id)).toEqual(['c1', 'c2'])
    expect(cog[1]).toMatchObject({ seenAt: 9 })
  })

  it('reads the largest id suffix across lists to seed the counter', () => {
    expect(maxEntrySuffix('a', [[agreement('a2', 'x'), agreement('a10', 'y')], [agreement('a4', 'z')]])).toBe(10)
    expect(maxEntrySuffix('c', [[]])).toBe(0)
  })
})

describe('knowledge edits', () => {
  it('adds, edits and removes agreement entries', () => {
    const base = [agreement('a1', 'one', 1), agreement('a2', 'two', 2)]
    const added = applyAgreementEdit(base, { op: 'add', text: '  - three ' }, 10, ids('a', 2))
    expect(added.map(entry => entry.id)).toEqual(['a1', 'a2', 'a3'])
    expect(added[2]).toMatchObject({ text: 'three', createdAt: 10, updatedAt: 10 })
    // A duplicate add keeps the list untouched.
    expect(sameEntries(applyAgreementEdit(added, { op: 'add', text: 'one' }, 11, ids('a', 3)), added)).toBe(true)
    const edited = applyAgreementEdit(added, { op: 'edit', id: 'a2', text: 'two point five' }, 12, ids('a', 3))
    expect(edited[1]).toMatchObject({ id: 'a2', text: 'two point five', createdAt: 2, updatedAt: 12 })
    expect(applyAgreementEdit(edited, { op: 'remove', id: 'a1' }, 13, ids('a', 3)).map(entry => entry.id)).toEqual(['a2', 'a3'])
    expect(() => applyAgreementEdit(base, { op: 'add', text: '   ' }, 1, ids('a', 2))).toThrow(/non-empty/)
    expect(() => applyAgreementEdit(base, { op: 'remove', id: 'a9' }, 1, ids('a', 2))).toThrow(/no entry has id a9/)
    expect(() => applyAgreementEdit(base, { op: 'pin', id: 'a1', pinned: true }, 1, ids('a', 2))).toThrow(/add, edit or remove/)
  })

  it('dedups agreement add by entryKey and no-ops an edit that normalizes to the same text', () => {
    const base = [agreement('a1', 'Likes tea', 1), agreement('a2', 'A  B', 2)]
    expect(sameEntries(applyAgreementEdit(base, { op: 'add', text: 'likes  tea' }, 10, ids('a', 2)), base)).toBe(true)
    expect(sameEntries(applyAgreementEdit(base, { op: 'add', text: 'A B' }, 10, ids('a', 2)), base)).toBe(true)
    const noop = applyAgreementEdit(base, { op: 'edit', id: 'a1', text: '- Likes tea\n' }, 10, ids('a', 2))
    expect(sameEntries(noop, base)).toBe(true)
    expect(() => applyAgreementEdit(base, { op: 'edit', id: 'a2', text: 'likes tea' }, 10, ids('a', 2))).toThrow(/already has that text/)
  })

  it('edits cognition entries: edit bumps seenAt, pin does not', () => {
    const base = [cognition('c1', 'one', 1, 3), cognition('c2', 'two', 2, 4, true)]
    const edited = applyCognitionEdit(base, { op: 'edit', id: 'c1', text: 'one v2' }, 20, ids('c', 2))
    expect(edited[0]).toMatchObject({ text: 'one v2', updatedAt: 20, seenAt: 20, createdAt: 1 })
    const pinned = applyCognitionEdit(edited, { op: 'pin', id: 'c1', pinned: true }, 30, ids('c', 2))
    expect(pinned[0]).toMatchObject({ pinned: true, seenAt: 20 })
    const unpinned = applyCognitionEdit(pinned, { op: 'pin', id: 'c1', pinned: false }, 40, ids('c', 2))
    expect(unpinned[0]).not.toHaveProperty('pinned')
    expect(unpinned[0]!.seenAt).toBe(20)
  })

  it('refreshes seenAt when re-adding an existing cognition entry by entryKey', () => {
    const base = [cognition('c1', 'Likes tea', 1, 3), cognition('c2', 'other', 2, 4)]
    const woken = applyCognitionEdit(base, { op: 'add', text: 'likes  tea' }, 20, ids('c', 2))
    expect(woken.map(entry => entry.id)).toEqual(['c1', 'c2'])
    expect(woken[0]).toMatchObject({ text: 'Likes tea', createdAt: 1, updatedAt: 1, seenAt: 20 })
    expect(woken[1]).toEqual(base[1])
    expect(sameCognitionContent(woken, base)).toBe(true)
    const leftover = [cognition('c1', 'A  B', 1, 3), cognition('c2', 'A B', 2, 4)]
    expect(sameEntries(applyCognitionEdit(leftover, { op: 'add', text: 'A B' }, 20, ids('c', 2)), leftover)).toBe(true)
    const noopEdit = applyCognitionEdit(base, { op: 'edit', id: 'c1', text: '- Likes tea\n' }, 20, ids('c', 2))
    expect(sameEntries(noopEdit, base)).toBe(true)
  })

  it('matches one entry by exact text or a unique substring, whitespace-insensitive, with kind-specific errors', () => {
    const list = [agreement('a1', 'likes green tea'), agreement('a2', 'likes short answers')]
    expect(matchEntry(list, 'likes green tea', 'agreement').id).toBe('a1')
    expect(matchEntry(list, 'green', 'agreement').id).toBe('a1')
    // Internal whitespace differences do not matter on either side.
    expect(matchEntry([agreement('a1', 'A  B')], 'A B', 'agreement').id).toBe('a1')
    expect(matchEntry([agreement('a1', 'A B')], 'A   B', 'agreement').id).toBe('a1')
    // The whole entry wins over entries that merely contain it.
    expect(matchEntry([agreement('a1', 'tea'), agreement('a2', 'green tea')], 'tea', 'agreement').id).toBe('a1')
    // Case and spacing differences still find the stored text.
    expect(matchEntry([agreement('a1', '只归档文件「Release  Notes.md」')], 'release notes.md', 'agreement').id).toBe('a1')
    // A stored bullet keeps its literal text: '- staging' stays a distinct
    // entry, only reached by quoting the dash too ('staging' alone is ambiguous).
    const bullet = [agreement('a1', '- staging'), agreement('a2', '不要部署到 staging')]
    expect(matchEntry(bullet, '- - staging', 'agreement').id).toBe('a1')
    expect(() => matchEntry(bullet, 'staging', 'agreement')).toThrowError(expect.objectContaining({ code: 'dot/ambiguous-agreement' }))
    expect(() => matchEntry(list, 'likes', 'agreement')).toThrowError(expect.objectContaining({ code: 'dot/ambiguous-agreement' }))
    expect(() => matchEntry(list, 'coffee', 'agreement')).toThrowError(expect.objectContaining({ code: 'dot/unknown-agreement' }))
    expect(() => matchEntry([cognition('c1', 'x')], 'y', 'cognition')).toThrowError(expect.objectContaining({ code: 'dot/unknown-entry' }))
    expect(() => matchEntry([cognition('c1', 'xa'), cognition('c2', 'xb')], 'x', 'cognition')).toThrowError(expect.objectContaining({ code: 'dot/ambiguous-entry' }))
    expect(() => matchEntry(list, '', 'cognition', 'match')).toThrow(/match must be non-empty/)
    expect(() => matchEntry(list, '', 'agreement')).toThrow(/text must be non-empty/)
    const many = Array.from({ length: 45 }, (_, i) => cognition(`c${i + 1}`, `fact ${i + 1}`))
    expect(() => matchEntry(many, 'missing', 'cognition')).toThrow(/… and 5 more/)
    expect(() => matchEntry(many, 'missing', 'cognition')).toThrow(/dot_cognition action=list/)
    expect(() => matchEntry(many, 'missing', 'cognition')).toThrow(/cognition entries/)
    expect(() => matchEntry(many, 'missing', 'cognition')).not.toThrow(/cognition entrys/)
    // When >40 entries exist, partial/token hits bubble to the top of the error echo.
    const buried = [
      ...Array.from({ length: 45 }, (_, i) => cognition(`c${i + 1}`, `unrelated routine note ${i + 1}`, i + 1)),
      cognition('c46', 'prefers drinking green jasmine tea in the afternoon', 46),
    ]
    expect(() => matchEntry(buried, 'likes green tea', 'cognition')).toThrow(/prefers drinking green jasmine tea in the afternoon/)
    expect(filterCognitionEntries(buried, 'tea green').map(entry => entry.id)).toEqual(['c46'])
    expect(filterCognitionEntries(buried, '').length).toBe(46)
  })
})

describe('parseKnowledgeEdit', () => {
  it('accepts well-typed edits and rejects bad field types including pinned: "false"', () => {
    expect(parseKnowledgeEdit({ op: 'add', text: 'one' }, 'agreements')).toEqual({ op: 'add', text: 'one' })
    expect(parseKnowledgeEdit({ op: 'edit', id: ' a1 ', text: 'two' }, 'agreements')).toEqual({ op: 'edit', id: 'a1', text: 'two' })
    expect(parseKnowledgeEdit({ op: 'remove', id: 'a1' }, 'agreements')).toEqual({ op: 'remove', id: 'a1' })
    expect(parseKnowledgeEdit({ op: 'pin', id: 'c1', pinned: true }, 'cognition')).toEqual({ op: 'pin', id: 'c1', pinned: true })
    expect(parseKnowledgeEdit({ op: 'pin', id: 'c1', pinned: false }, 'cognition')).toEqual({ op: 'pin', id: 'c1', pinned: false })
    expect(() => parseKnowledgeEdit({ op: 'pin', id: 'c1', pinned: 'false' }, 'cognition')).toThrowError(expect.objectContaining({ code: 'dot/invalid' }))
    expect(() => parseKnowledgeEdit({ op: 'pin', id: 'c1', pinned: 'false' }, 'cognition')).toThrow(/pinned must be a boolean/)
    expect(() => parseKnowledgeEdit({ op: 'add', text: 1 }, 'agreements')).toThrow(/edit.text must be a string/)
    expect(() => parseKnowledgeEdit({ op: 'remove', id: 1 }, 'cognition')).toThrow(/edit.id must be a non-empty string/)
    expect(() => parseKnowledgeEdit(null, 'agreements')).toThrow(/edit must be an object/)
    expect(() => parseKnowledgeEdit({ op: 'pin', id: 'a1', pinned: true }, 'agreements')).toThrow(/add, edit or remove/)
  })
})

describe('reflection ops', () => {
  it('parses and applies add, update, remove and confirm together', () => {
    const base = [cognition('c1', 'one', 1, 3), cognition('c2', 'two', 2, 4)]
    const ops = parseCognitionOps(JSON.stringify([{ op: 'add', text: 'three' }, { op: 'update', id: 'c1', text: 'one v2' }, { op: 'confirm', id: 'c2' }]))
    const next = applyCognitionOps(base, ops, 50, ids('c', 2))
    expect(next.map(entry => entry.id)).toEqual(['c1', 'c2', 'c3'])
    expect(next[0]).toMatchObject({ text: 'one v2', updatedAt: 50, seenAt: 50 })
    expect(next[1]).toMatchObject({ text: 'two', seenAt: 50, updatedAt: 2 })
    expect(next[2]).toMatchObject({ text: 'three', createdAt: 50, seenAt: 50 })
    expect(applyCognitionOps(base, parseCognitionOps('[{"op":"remove","id":"c2"}]'), 9, ids('c', 2)).map(entry => entry.id)).toEqual(['c1'])
  })

  it('refreshes seenAt instead of duplicating when a reflection add hits an existing entryKey', () => {
    const base = [cognition('c1', 'Likes tea', 1, 3)]
    const next = applyCognitionOps(base, parseCognitionOps('[{"op":"add","text":"likes  tea"}]'), 50, ids('c', 1))
    expect(next.map(entry => entry.id)).toEqual(['c1'])
    expect(next[0]).toMatchObject({ text: 'Likes tea', seenAt: 50, updatedAt: 1 })
    expect(sameCognitionContent(next, base)).toBe(true)
  })

  it('keeps a folded-key replacement when the same batch removes or retargets the old row', () => {
    const base = [cognition('c1', 'workdir is /Work', 1, 3)]
    const addThenRemove = applyCognitionOps(
      base,
      parseCognitionOps(JSON.stringify([{ op: 'add', text: 'workdir is /work' }, { op: 'remove', id: 'c1' }])),
      50,
      ids('c', 1),
    )
    expect(addThenRemove.map(entry => entry.text)).toEqual(['workdir is /work'])
    expect(addThenRemove[0]!.id).toBe('c2')
    const removeThenAdd = applyCognitionOps(
      base,
      parseCognitionOps(JSON.stringify([{ op: 'remove', id: 'c1' }, { op: 'add', text: 'workdir is /work' }])),
      50,
      ids('c', 1),
    )
    expect(removeThenAdd.map(entry => entry.text)).toEqual(['workdir is /work'])
    expect(removeThenAdd[0]!.id).toBe('c2')
    const addThenUpdate = applyCognitionOps(
      base,
      parseCognitionOps(JSON.stringify([{ op: 'add', text: 'workdir is /work' }, { op: 'update', id: 'c1', text: 'new fact' }])),
      50,
      ids('c', 1),
    )
    expect(addThenUpdate.map(entry => ({ id: entry.id, text: entry.text }))).toEqual([
      { id: 'c1', text: 'new fact' },
      { id: 'c2', text: 'workdir is /work' },
    ])
  })

  it('allows merging via [update, remove] in either order and swapping keys across updates', () => {
    const base = [
      cognition('c1', 'prefers concise review replies', 1, 3),
      cognition('c2', 'likes concise replies', 2, 4),
    ]
    const updateThenRemove = applyCognitionOps(
      base,
      parseCognitionOps(JSON.stringify([{ op: 'update', id: 'c1', text: 'likes concise replies' }, { op: 'remove', id: 'c2' }])),
      50,
      ids('c', 2),
    )
    expect(updateThenRemove.map(entry => ({ id: entry.id, text: entry.text }))).toEqual([
      { id: 'c1', text: 'likes concise replies' },
    ])
    const removeThenUpdate = applyCognitionOps(
      base,
      parseCognitionOps(JSON.stringify([{ op: 'remove', id: 'c2' }, { op: 'update', id: 'c1', text: 'likes concise replies' }])),
      50,
      ids('c', 2),
    )
    expect(removeThenUpdate.map(entry => ({ id: entry.id, text: entry.text }))).toEqual([
      { id: 'c1', text: 'likes concise replies' },
    ])
    const swapped = applyCognitionOps(
      base,
      parseCognitionOps(JSON.stringify([
        { op: 'update', id: 'c1', text: 'likes concise replies' },
        { op: 'update', id: 'c2', text: 'prefers concise review replies' },
      ])),
      50,
      ids('c', 2),
    )
    expect(swapped.map(entry => ({ id: entry.id, text: entry.text }))).toEqual([
      { id: 'c1', text: 'likes concise replies' },
      { id: 'c2', text: 'prefers concise review replies' },
    ])
  })

  it('rejects a reflection update that collides with another remaining entryKey', () => {
    const base = [cognition('c1', 'Likes tea', 1, 3), cognition('c2', 'other fact', 2, 4)]
    expect(() => applyCognitionOps(base, parseCognitionOps('[{"op":"update","id":"c2","text":"likes  tea"}]'), 50, ids('c', 2)))
      .toThrowError(expect.objectContaining({ code: 'dot/invalid' }))
    expect(() => applyCognitionOps(base, parseCognitionOps('[{"op":"update","id":"c2","text":"likes  tea"}]'), 50, ids('c', 2)))
      .toThrow(/already has that text/)
    expect(() => applyCognitionOps(base, parseCognitionOps('[{"op":"update","id":"c1","text":"shared"},{"op":"update","id":"c2","text":"Shared"}]'), 50, ids('c', 2)))
      .toThrow(/already has that text/)
    expect(() => applyCognitionEdit(base, { op: 'edit', id: 'c2', text: 'likes  tea' }, 50, ids('c', 2)))
      .toThrow(/already has that text/)
  })

  it('never hands a removed id out again: the counter decides, not the list', () => {
    const base = [cognition('c1', 'one', 1, 3), cognition('c2', 'two', 2, 4)]
    const nextId = ids('c', 4)
    const next = applyCognitionOps(base, [...parseCognitionOps('[{"op":"remove","id":"c2"}]'), ...parseCognitionOps('[{"op":"add","text":"three"}]')], 9, nextId)
    // Even though c2 was the highest id in the list, the counter already passed it.
    expect(next.map(entry => entry.id)).toEqual(['c1', 'c5'])
  })

  it('validates everything first: a bad op drops the whole set', () => {
    const base = [cognition('c1', 'one', 1, 3), cognition('c2', 'two', 2, 4, true)]
    // Pinned entries can only be confirmed.
    for (const bad of ['[{"op":"add","text":"x"},{"op":"update","id":"c2","text":"y"}]', '[{"op":"remove","id":"c2"}]', '[{"op":"update","id":"c9","text":"y"}]', '[{"op":"add","text":"x"},{"op":"add"}]', 'not json', '{}', '[{"op":"remove","id":"c1"},{"op":"confirm","id":"c1"}]']) {
      expect(() => applyCognitionOps(base, parseCognitionOps(bad), 5, ids('c', 2))).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^dot\//) }))
    }
    // Confirm on a pinned entry is fine and only touches seenAt.
    const confirmed = applyCognitionOps(base, parseCognitionOps('[{"op":"confirm","id":"c2"}]'), 77, ids('c', 2))
    expect(confirmed[1]).toMatchObject({ pinned: true, text: 'two', seenAt: 77, updatedAt: 2 })
  })
})

describe('cognition ranking and rendering', () => {
  const list = [
    cognition('c1', 'oldest', 1, 10),
    cognition('c2', 'pinned one', 2, 5, true),
    cognition('c3', 'newest', 3, 30),
    cognition('c4', 'middle', 4, 20),
    cognition('c5', 'pinned two', 5, 15, true),
  ]

  it('ranks pinned first, then by seenAt descending, stable on ties', () => {
    expect(rankCognition(list).map(entry => entry.id)).toEqual(['c5', 'c2', 'c3', 'c4', 'c1'])
    const tied = [cognition('c1', 'a', 1, 10), cognition('c2', 'b', 5, 10), cognition('c3', 'c', 3, 10)]
    // Equal seenAt: createdAt wins, then stored order.
    expect(rankCognition(tied).map(entry => entry.id)).toEqual(['c2', 'c3', 'c1'])
    expect(rankCognition(tied).map(entry => entry.id)).toEqual(['c2', 'c3', 'c1'])
  })

  it('limits only unpinned entries; pinned beyond the limit all stay active', () => {
    const flagged = cognitionWithActive(list, 2)
    expect(flagged.filter(entry => entry.active).map(entry => entry.id)).toEqual(['c5', 'c2'])
    expect(flagged.filter(entry => !entry.active).map(entry => entry.id)).toEqual(['c3', 'c4', 'c1'])
    // Limit 0 → pinned only.
    expect(cognitionWithActive(list, 0).filter(entry => entry.active).map(entry => entry.id)).toEqual(['c5', 'c2'])
    const onePin = cognitionWithActive([cognition('c1', 'p', 1, 1, true), cognition('c2', 'a', 2, 9), cognition('c3', 'b', 3, 8)], 2)
    expect(onePin.filter(entry => entry.active).map(entry => entry.id)).toEqual(['c1', 'c2'])
  })

  it('renders [cognition] with active entries in ranked order and no ids', () => {
    const block = cognitionSection(list, 3)
    expect(block.startsWith('[cognition]\n')).toBe(true)
    expect(block).toContain('what you know about the human')
    expect(block).toContain('pinned come first')
    expect(block).toContain('the agreements win')
    expect(block).toContain('- pinned two\n- pinned one\n- newest')
    expect(block).not.toContain('middle')
    expect(block).not.toContain('c2')
    // Rendering is deterministic from stored data — it never consults the clock.
    expect(cognitionSection(list, 3)).toBe(block)
    expect(cognitionSection([], 30)).toBe('')
  })

  it('renders every agreement in stored order as a bullet', () => {
    expect(agreementsSection([])).toBe('')
    const block = agreementsSection([agreement('a1', 'first'), agreement('a2', 'second')])
    expect(block.startsWith('[agreements]\n')).toBe(true)
    expect(block).toContain('take precedence over your cognition')
    expect(block.endsWith('\n\n- first\n- second')).toBe(true)
  })

  it('normalizes bulk text the one canonical way', () => {
    expect(agreementsText([agreement('a1', 'a'), agreement('a2', 'b')])).toBe('- a\n- b\n')
    expect(agreementsText([])).toBe('')
    expect(cognitionText([cognition('c1', 'x')])).toBe('- x\n')
  })
})
