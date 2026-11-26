import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AgreementEntry } from './contracts.ts'
import { SelfSettings } from './self-settings.ts'
import { agreementEntriesFromText } from './memory.ts'
import { parseSettingProposal } from './storage.ts'
import { DotStore } from './store.ts'

function setup() {
  const store = new DotStore(undefined)
  const state = { entries: [] as AgreementEntry[], writes: [] as string[], nextId: 0 }
  const view = async () => ({
    agreements: { entries: state.entries, canUndo: false },
    cognition: { entries: [] as unknown[], history: [] },
  })
  const service = {
    store,
    knowledgeView: view,
    setAgreements: async (text: string) => { state.entries = agreementEntriesFromText(text, state.entries, 1, () => `a${++state.nextId}`); state.writes.push(text); return view() },
    settingsChanged: async () => {},
    serialSettings: async <T>(work: () => Promise<T>) => work(),
  }
  return { store, state, self: new SelfSettings(service as never) }
}

describe('Dorothy self settings', () => {
  it('defaults to unlocked and changes nothing until the human approves', async () => {
    const h = setup()
    expect(await h.self.read()).toContain('scope: tracked')
    const result = await h.self.propose({ field: 'scope', value: 'all', reason: 'watch every session' })
    expect(result).toMatch(/setting-.*Nothing changed yet/)
    expect(h.store.settings.scope).toBe('tracked')
    const id = h.store.settingProposals[0]!.id
    expect(await h.self.decide(id, true)).toContain('scope is now all')
    expect(h.store.settings.scope).toBe('all')
    expect(h.store.settingProposals).toEqual([])
  })

  it('honours locks for proposals, existing requests and the agreements field', async () => {
    const h = setup()
    await h.store.setSettings({ ...DEFAULT_SETTINGS, locks: { scope: true, agreements: true } })
    await expect(h.self.propose({ field: 'scope', value: 'tracked', reason: 'test' })).rejects.toThrow(/locked by the human/)
    await expect(h.self.propose({ field: 'locks', value: {}, reason: 'unlock' })).rejects.toThrow(/unknown setting/)
    await expect(h.self.propose({ field: 'agreements', value: '- note', reason: 'test' })).rejects.toThrow(/locked by the human/)
  })

  it('keeps a stale proposal instead of overwriting a newer human edit', async () => {
    const h = setup()
    await h.self.propose({ field: 'taskPermission', value: 'danger-full-access', reason: 'faster' })
    await h.store.setSettings({ ...DEFAULT_SETTINGS, taskPermission: 'default' })
    const id = h.store.settingProposals[0]!.id
    await expect(h.self.decide(id, true)).rejects.toMatchObject({ code: 'dot/proposal-stale' })
    expect(h.store.settings.taskPermission).toBe('default')
    expect(h.store.settingProposals).toHaveLength(1)
    expect(await h.self.decide(id, false)).toContain('no settings changed')
  })

  it('approves a follow-host baseline proposal after the upgrade migration', async () => {
    const h = setup()
    const proposal = parseSettingProposal({
      id: 'setting-upgrade', field: 'taskPermission', before: 'default', after: 'danger-full-access', reason: 'faster', createdAt: 1,
    })
    expect(proposal?.before).toBe('workspace-write')
    await h.store.putSettingProposal(proposal!)
    expect(await h.self.decide(proposal!.id, true)).toContain('danger-full-access')
    expect(h.store.settings.taskPermission).toBe('danger-full-access')
    expect(h.store.settingProposals).toEqual([])
  })

  it('refuses to propose anything but a real setting field', async () => {
    const h = setup()
    await expect(h.self.propose({ field: 'policy', value: 'ask before push', reason: 'safer' })).rejects.toThrow(/unknown setting/)
    expect(h.store.settingProposals).toHaveLength(0)
  })

  it('rewrites the agreements only after approval', async () => {
    const h = setup()
    await h.self.propose({ field: 'agreements', value: '- likes tea', reason: 'remember this' })
    expect(h.state.writes).toEqual([])
    await h.self.decide(h.store.settingProposals[0]!.id, true)
    expect(h.state.writes).toEqual(['- likes tea\n'])
    expect(h.state.entries.map(entry => entry.text)).toEqual(['likes tea'])
  })

  it('reuses entry ids for unchanged lines and accepts a proposal of any size', async () => {
    const h = setup()
    h.state.entries = agreementEntriesFromText('- keep me\n- drop me\n', [], 1, () => `a${++h.state.nextId}`)
    const long = 'x'.repeat(5000)
    await h.self.propose({ field: 'agreements', value: `- keep me\n- ${long}`, reason: 'remember' })
    await h.self.decide(h.store.settingProposals[0]!.id, true)
    expect(h.state.entries.map(entry => entry.id)).toEqual(['a1', 'a3'])
    expect(h.state.entries[1]!.text).toBe(long)
  })

  it('approves an agreements proposal saved before the entry-list migration', async () => {
    const h = setup()
    // A proposal from the string era stores its baseline as raw text; the
    // current entries compare as normalized lines, so it is not stale.
    h.state.entries = agreementEntriesFromText('- 先给结论\n', [], 1, () => `a${++h.state.nextId}`)
    await h.store.putSettingProposal({
      id: 'setting-legacy', field: 'agreements', before: '* 先给结论\n', after: '- 先给结论\n- 改完先跑测试\n', reason: 'add a rule', createdAt: 1,
    })
    expect(await h.self.decide('setting-legacy', true)).toContain('Approved')
    expect(h.state.entries.map(entry => entry.text)).toEqual(['先给结论', '改完先跑测试'])
  })

  it('still refuses an agreements proposal when the entries moved meanwhile', async () => {
    const h = setup()
    h.state.entries = agreementEntriesFromText('- 先给结论\n- 新规矩\n', [], 1, () => `a${++h.state.nextId}`)
    await h.store.putSettingProposal({
      id: 'setting-legacy', field: 'agreements', before: '* 先给结论\n', after: '- 先给结论\n- 改完先跑测试\n', reason: 'add a rule', createdAt: 1,
    })
    await expect(h.self.decide('setting-legacy', true)).rejects.toMatchObject({ code: 'dot/proposal-stale' })
    expect(h.state.entries.map(entry => entry.text)).toEqual(['先给结论', '新规矩'])
  })

  it('treats an inside-spacing difference as a real change, not a formatting one', async () => {
    const h = setup()
    h.state.entries = agreementEntriesFromText('- 先给 结论\n', [], 1, () => `a${++h.state.nextId}`)
    await h.store.putSettingProposal({
      id: 'setting-legacy', field: 'agreements', before: '- 先给  结论\n', after: '- 先给  结论\n- 新规矩\n', reason: 'add a rule', createdAt: 1,
    })
    await expect(h.self.decide('setting-legacy', true)).rejects.toMatchObject({ code: 'dot/proposal-stale' })
  })

  it('keeps internal whitespace verbatim when a bulk proposal is approved', async () => {
    const h = setup()
    await h.self.propose({ field: 'agreements', value: '- keep  me\n- tab\tline\n', reason: 'remember' })
    await h.self.decide(h.store.settingProposals[0]!.id, true)
    expect(h.state.entries.map(entry => entry.text)).toEqual(['keep  me', 'tab\tline'])
  })

  it('refuses an old proposal after the human locks it, including the agreements field', async () => {
    const h = setup()
    await h.self.propose({ field: 'agreements', value: '- old', reason: 'old' })
    await h.store.setSettings({ ...DEFAULT_SETTINGS, locks: { agreements: true } })
    const id = h.store.settingProposals[0]!.id
    await expect(h.self.decide(id, true)).rejects.toThrow(/locked by the human/)
    expect(h.state.writes).toEqual([])
    expect(h.store.settingProposals).toHaveLength(1)
  })

  it('normalizes an agreements proposal so approval does not cause a spurious change', async () => {
    const h = setup()
    await h.self.propose({ field: 'agreements', value: '- likes tea\r\n', reason: 'remember' })
    expect(h.store.settingProposals[0]!.after).toBe('- likes tea\n')
  })

  it('reads, proposes, approves, and enforces locks on defaultTaskPreset', async () => {
    const h = setup()
    expect(await h.self.read()).toContain('defaultTaskPreset: standard')

    await h.self.propose({ field: 'defaultTaskPreset', value: 'dot-worker', reason: 'prefer 5s auto-promote' })
    const proposal = h.store.settingProposals[0]!
    expect(proposal).toMatchObject({ field: 'defaultTaskPreset', before: 'standard', after: 'dot-worker' })
    expect(parseSettingProposal(proposal)).toMatchObject({ field: 'defaultTaskPreset', after: 'dot-worker' })

    expect(await h.self.decide(proposal.id, true)).toContain('defaultTaskPreset is now dot-worker')
    expect(h.store.settings.defaultTaskPreset).toBe('dot-worker')

    await h.store.setSettings({ ...h.store.settings, locks: { defaultTaskPreset: true } })
    await expect(h.self.propose({ field: 'defaultTaskPreset', value: 'standard', reason: 'revert' })).rejects.toThrow(/locked by the human/)
  })

  it('reads, proposes, approves, clears, and enforces locks on watchdogMode and watchdogModel', async () => {
    const h = setup()
    expect(await h.self.read()).toContain('watchdogMode: observe')

    await h.self.propose({ field: 'watchdogMode', value: 'auto', reason: 'enable automated judge' })
    const modeProposal = h.store.settingProposals[0]!
    expect(modeProposal).toMatchObject({ field: 'watchdogMode', before: 'observe', after: 'auto' })
    expect(await h.self.decide(modeProposal.id, true)).toContain('watchdogMode is now auto')
    expect(h.store.settings.watchdogMode).toBe('auto')

    await h.self.propose({ field: 'watchdogModel', value: 'openai/gpt-4o', reason: 'dedicated cheap judge' })
    const modelProposal = h.store.settingProposals[0]!
    expect(modelProposal).toMatchObject({ field: 'watchdogModel', before: null, after: 'openai/gpt-4o' })
    expect(await h.self.decide(modelProposal.id, true)).toContain('watchdogModel is now openai/gpt-4o')
    expect(h.store.settings.watchdogModel).toBe('openai/gpt-4o')

    await h.store.setSettings({ ...h.store.settings, locks: { watchdogMode: true } })
    await expect(h.self.propose({ field: 'watchdogMode', value: 'off', reason: 'disable' })).rejects.toThrow(/locked by the human/)
  })
})
