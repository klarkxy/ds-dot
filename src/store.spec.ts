import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './contracts.ts'
import { reasonBeforeDelivery } from './segments.ts'
import { parseSettingProposal, STATE_KEY } from './storage.ts'
import { DotStore, type DotDomainHandle } from './store.ts'

function fakeDomain(seed: Record<string, Record<string, unknown>> = {}) {
  const tables: Record<string, Map<string, unknown>> = {
    state: new Map(Object.entries(seed.state ?? {})),
    tasks: new Map(Object.entries(seed.tasks ?? {})),
    tickets: new Map(Object.entries(seed.tickets ?? {})),
    schedules: new Map(Object.entries(seed.schedules ?? {})),
    recipes: new Map(Object.entries(seed.recipes ?? {})),
    recipe_proposals: new Map(Object.entries(seed.recipe_proposals ?? {})),
    proposals: new Map(Object.entries(seed.proposals ?? {})),
    changes: new Map(Object.entries(seed.changes ?? {})),
    inputs: new Map(Object.entries(seed.inputs ?? {})),
    runs: new Map(Object.entries(seed.runs ?? {})),
    verifications: new Map(Object.entries(seed.verifications ?? {})),
    peers: new Map(Object.entries(seed.peers ?? {})),
    inbox: new Map(Object.entries(seed.inbox ?? {})),
    links: new Map(Object.entries(seed.links ?? {})),
  }
  const puts: string[] = []
  const domain: DotDomainHandle = {
    table: name => ({
      entries: () => tables[name]!.entries(),
      get: key => tables[name]!.get(key),
      put: async (key, value) => { puts.push(`${name}:${key}`); tables[name]!.set(key, value) },
      delete: async key => { puts.push(`${name}:-${key}`); return tables[name]!.delete(key) },
      update: async (key, recipe) => {
        const rows = tables[name]!
        if (!rows.has(key)) {
          const error = new Error(`domain 'klarkxy_dsh_dot' table '${name}' has no record '${key}' to update`)
          ;(error as { code?: string }).code = 'missing-key'
          throw error
        }
        puts.push(`${name}:update:${key}`)
        const next = recipe(rows.get(key))
        rows.set(key, next)
        return next
      },
    }),
    close: async () => {},
  }
  return { domain, tables, puts }
}

function unknownState(): Error {
  const error = new Error('durable outcome unknown')
  ;(error as { code?: string }).code = 'unknown-state'
  return error
}


describe('DotStore', () => {
  it('round-trips tasks and the dot identity through the domain', async () => {
    const { domain, tables } = fakeDomain()
    const store = new DotStore(domain)
    await store.setDot({ dotSessionId: 'dot', dotWorkspaceId: 'w' })
    await store.track({ sessionId: 's1', origin: 'started', title: 'T', goal: 'G', cwd: '/w', at: 1 })
    await store.apply({ type: 'turn-end', sessionId: 's1', at: 2, note: 'ok' }, [])
    const reloaded = new DotStore(domain)
    expect(reloaded.dotSessionId).toBe('dot')
    expect(reloaded.task('s1')).toMatchObject({ status: 'idle', unseenTurns: 1, lastNote: 'ok' })
    expect(tables.tasks!.size).toBe(1)
  })

  it('skips malformed rows and rows filed under another key', () => {
    const { domain } = fakeDomain({ tasks: { bad: { nope: true }, other: { sessionId: 'x', origin: 'started', title: '', goal: '', cwd: '', status: 'idle', createdAt: 0, updatedAt: 0, unseenTurns: 0 } } })
    expect(new DotStore(domain).list()).toEqual([])
  })

  it('ignores events of untracked sessions without writing', async () => {
    const { domain, puts } = fakeDomain()
    const store = new DotStore(domain)
    await store.apply({ type: 'status', sessionId: 'nobody', status: 'running', at: 1 }, [])
    expect(puts).toEqual([])
  })

  it('re-tracking an archived task revives it and keeps history', async () => {
    const store = new DotStore(undefined)
    await store.track({ sessionId: 's', origin: 'watched', title: 'T', goal: 'first', cwd: '/', at: 1 })
    await store.apply({ type: 'archived', sessionId: 's', at: 2 }, [])
    const again = await store.track({ sessionId: 's', origin: 'watched', title: 'T', goal: '', cwd: '/', at: 3 })
    expect(again).toMatchObject({ status: 'idle', goal: 'first', createdAt: 1 })
  })

  it('syncs blocked flags and clears unread counters', async () => {
    const store = new DotStore(undefined)
    await store.track({ sessionId: 's', origin: 'started', title: 'T', goal: 'G', cwd: '/', at: 1 })
    await store.apply({ type: 'turn-end', sessionId: 's', at: 2 }, [])
    await store.syncPending([{ id: 'ap-1', kind: 'approval', sessionId: 's', createdAt: 2, subject: 'bash' }])
    expect(store.task('s')!.status).toBe('blocked')
    await store.markAllSeen()
    expect(store.task('s')!.unseenTurns).toBe(0)
    expect(store.board([]).tasks).toHaveLength(0)
    await store.track({ sessionId: 'w', origin: 'watched', title: 'W', goal: '', cwd: '/', at: 3 })
    expect(store.board([]).tasks.map(task => task.sessionId)).toEqual(['w'])
  })


  it('round-trips task links and deletes them for good', async () => {
    const { domain, tables, puts } = fakeDomain()
    const store = new DotStore(domain)
    await store.putLink({ id: 'link-a', changeId: 'c-1', repo: 'acme/widgets', number: 12, origin: 'dot', state: 'open', addedAt: 1 })
    await store.putLink({ id: 'link-b', changeId: 'c-1', repo: 'acme/widgets', branch: 'feature/x', url: 'https://gh/x', origin: 'auto', state: 'merged', addedAt: 2, lastEvent: { type: 'workflow_run.completed', title: 'CI failure', summary: 's', url: 'https://gh/ci', at: 5, count: 3 } })
    await store.putLink({ id: 'link-bad', changeId: 'c-1', repo: 'acme/widgets', origin: 'dot', state: 'open', addedAt: 0.5 })
    const reloaded = new DotStore(domain)
    expect(reloaded.links.map(link => link.id)).toEqual(['link-bad', 'link-a', 'link-b'])
    expect(reloaded.linksFor('c-1')).toHaveLength(3)
    expect(reloaded.link('link-b')).toMatchObject({ branch: 'feature/x', state: 'merged', lastEvent: { count: 3 } })
    expect(reloaded.linksFor('c-404')).toEqual([])
    await reloaded.deleteLink('link-a')
    await reloaded.deleteLink('link-a')
    expect(tables.links!.has('link-a')).toBe(false)
    expect(puts.at(-1)).toBe('links:-link-a')
    expect(new DotStore(domain).links.map(link => link.id)).toEqual(['link-bad', 'link-b'])
  })

  it('attaches links to work rows on the board', async () => {
    const { domain } = fakeDomain()
    const store = new DotStore(domain)
    const change = await store.work.createChange({ title: 'Linked', cwd: '/repo', goal: 'g', at: 1 })
    const bare = await store.work.createChange({ title: 'Bare', cwd: '/repo', goal: 'g', at: 2 })
    await store.putLink({ id: 'link-a', changeId: change.id, repo: 'acme/widgets', number: 12, origin: 'dot', state: 'open', addedAt: 1 })
    const board = store.board([])
    const linked = board.work!.find(row => row.id === change.id)!
    expect(linked.links).toHaveLength(1)
    expect(linked.links![0]).toMatchObject({ repo: 'acme/widgets', number: 12, state: 'open' })
    expect(board.work!.find(row => row.id === bare.id)!.links).toBeUndefined()
  })

  it('keeps reminders across a reload, the one due first on top, and deletes them for good', async () => {
    const { domain, tables, puts } = fakeDomain({ schedules: { broken: { id: 'broken' }, moved: { id: 'other', title: 't', prompt: 'p', timing: { kind: 'once', at: 5 }, createdAt: 1, nextAt: 5 } } })
    const store = new DotStore(domain)
    expect(store.schedules).toEqual([])
    await store.putSchedule({ id: 'sch-b', title: 'later', prompt: 'p', timing: { kind: 'daily', time: '09:00', weekdays: [1, 3] }, createdAt: 1, nextAt: 900 })
    await store.putSchedule({ id: 'sch-a', title: 'sooner', prompt: 'p', timing: { kind: 'every', minutes: 30, anchor: 1 }, createdAt: 2, nextAt: 300, lastFiredAt: 100 })
    const reloaded = new DotStore(domain)
    expect(reloaded.schedules.map(record => record.id)).toEqual(['sch-a', 'sch-b'])
    expect(reloaded.schedule('sch-a')).toMatchObject({ lastFiredAt: 100, timing: { kind: 'every', minutes: 30 } })
    expect(reloaded.board([]).schedules).toHaveLength(2)
    expect(await reloaded.deleteSchedule('sch-a')).toBe(true)
    expect(await reloaded.deleteSchedule('sch-a')).toBe(false)
    expect(tables.schedules!.has('sch-a')).toBe(false)
    expect(puts.at(-1)).toBe('schedules:-sch-a')
    expect(new DotStore(domain).schedules.map(record => record.id)).toEqual(['sch-b'])
  })

  it('round-trips a recipe-bound reminder and resolves its name on the board', async () => {
    const { domain } = fakeDomain()
    const store = new DotStore(domain)
    await store.putSchedule({ id: 'sch-r', title: 'bound', prompt: '', timing: { kind: 'every', minutes: 60, anchor: 1 }, createdAt: 3, nextAt: 600, recipe: 'rcp-1' })
    await store.putSchedule({ id: 'sch-p', title: 'plain', prompt: 'p', timing: { kind: 'every', minutes: 30, anchor: 1 }, createdAt: 2, nextAt: 300 })
    const reloaded = new DotStore(domain)
    expect(reloaded.schedule('sch-r')?.recipe).toBe('rcp-1')
    expect(reloaded.schedule('sch-p')?.recipe).toBeUndefined()
    await reloaded.putRecipe({ id: 'rcp-1', name: 'Weekly', revision: 1, history: [], outcomes: [], goal: 'g', requirements: [{ requirementRef: 'g', text: 'g', required: true }], createdAt: 1, updatedAt: 1 })
    expect(reloaded.board([]).schedules.find(row => row.id === 'sch-r')?.recipeName).toBe('Weekly')
    expect(reloaded.board([]).schedules.find(row => row.id === 'sch-p')?.recipeName).toBeUndefined()
  })

  it('keeps a capabilities-changed rollover reason on current and past segments across a reload', async () => {
    const { domain } = fakeDomain()
    const store = new DotStore(domain)
    await store.setDot({ dotSessionId: 'dot-1' })
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: 'p' })
    await store.beginSegment(
      { sessionId: 'dot-2', startedAt: 2, persona: 'p', reason: 'capabilities-changed' },
      { reason: 'capabilities-changed' },
    )
    const reloaded = new DotStore(domain)
    expect(reloaded.segment?.sessionId).toBe('dot-2')
    expect(reloaded.segment?.reason).toBe('capabilities-changed')
    expect(reloaded.pastSegments.at(-1)).toMatchObject({ sessionId: 'dot-1', reason: 'capabilities-changed' })
  })

  it('keeps the frozen capabilities signature on the current segment across a reload', async () => {
    const { domain } = fakeDomain()
    const store = new DotStore(domain)
    await store.setDot({ dotSessionId: 'dot-1' })
    const signature = '{"tool:bash":"auto"}'
    await store.beginSegment({ sessionId: 'dot-1', startedAt: 1, persona: 'p', capabilities: signature })
    const reloaded = new DotStore(domain)
    expect(reloaded.segment?.capabilities).toBe(signature)
    expect(reasonBeforeDelivery({
      replied: true,
      now: 10,
      persona: 'p',
      frozenPersona: 'p',
      capabilities: signature,
      frozenCapabilities: reloaded.segment?.capabilities,
    })).toBeUndefined()
  })

  it('serializes writes in call order', async () => {
    const { domain, puts } = fakeDomain()
    const store = new DotStore(domain)
    void store.track({ sessionId: 'a', origin: 'started', title: 'A', goal: '', cwd: '/', at: 1 })
    void store.setDot({ dotSessionId: 'd' })
    void store.track({ sessionId: 'b', origin: 'started', title: 'B', goal: '', cwd: '/', at: 2 })
    await store.flush()
    expect(puts).toEqual(['tasks:a', 'state:current', 'tasks:b'])
  })

  it('loads run-owned baselines without repairing the legacy change mirror', async () => {
    const { domain, tables } = fakeDomain()
    const store = new DotStore(domain)
    const change = await store.work.createChange({ title: 'A', cwd: 'H:\\proj', goal: 'a', at: 1 })
    const reserved = await store.work.reserveRun({ changeId: change.id, cwd: 'H:\\proj\\docs', writeScope: { kind: 'paths', paths: [{ path: 'H:\\proj\\docs\\a.md', type: 'file' }] }, at: 2 })
    if (!reserved.ok) throw new Error(reserved.message)
    const diverged = { ...reserved.run, baselineRefs: [{ workspaceRoot: reserved.run.workspaceRoot, scopeKey: 'stale', artifactRef: 'ghost' }] }
    tables.runs!.set(reserved.run.id, diverged)
    const reloaded = new DotStore(domain)
    expect(reloaded.work.run(reserved.run.id)?.baselineRefs).toEqual(diverged.baselineRefs)
    expect(reloaded.work.dispatchAllowed(reserved.run.id)).toMatchObject({ code: 'baseline' })
    await reloaded.flush()
    expect(tables.runs!.get(reserved.run.id)).toEqual(diverged)
  })

  it('refuses a new reservation when the runs table cannot be read or a core row is illegal', async () => {
    const { domain } = fakeDomain()
    const unreadable: DotDomainHandle = {
      ...domain,
      table: name => {
        if (name === 'runs') throw new Error('runs unreadable')
        return domain.table(name)
      },
    }
    const blocked = new DotStore(unreadable)
    expect(blocked.work.recoveryError).toMatch(/unreadable runs/)
    expect(await blocked.work.reserveRun({ changeId: 'c-1', writeScope: { kind: 'paths', paths: [] } })).toMatchObject({ code: 'recovery' })
    const { domain: illegalDomain, tables } = fakeDomain()
    tables.runs!.set('bad', { id: 'bad' })
    const illegal = new DotStore(illegalDomain)
    expect(illegal.work.recoveryError).toMatch(/illegal runs/)
    expect(await illegal.work.reserveRun({ changeId: 'c-1', writeScope: { kind: 'paths', paths: [] } })).toMatchObject({ code: 'recovery' })
  })


  it('puts the first input and change, then updates the saved change', async () => {
    const { domain, puts, tables } = fakeDomain()
    await expect(domain.table('inputs').update!('input-1', value => value)).rejects.toMatchObject({ code: 'missing-key' })
    const store = new DotStore(domain)
    const change = await store.work.createChange({ title: 'Recipe', cwd: 'H:\\shared', goal: 'land it', at: 1 })
    expect(puts.slice(0, 2)).toEqual(['inputs:input-1', 'changes:c-1'])
    expect(puts.some(op => op.startsWith('inputs:update:') || op.startsWith('changes:update:'))).toBe(false)
    const reserved = await store.work.reserveRun({ changeId: change.id, cwd: 'H:\\shared', writeScope: { kind: 'paths', paths: [] }, at: 2 })
    if (!reserved.ok) throw new Error(reserved.message)
    expect(puts).toContain(`runs:${reserved.run.id}`)
    expect(puts).not.toContain(`runs:update:${reserved.run.id}`)
    const paused = await store.work.setControl(change.id, 'paused', 3)
    expect(paused).toMatchObject({ id: change.id, control: 'paused' })
    expect(puts.at(-1)).toBe(`changes:update:${change.id}`)
    const reloaded = new DotStore(domain)
    expect(reloaded.work.change(change.id)?.control).toBe('paused')
    expect(reloaded.work.input(change.currentInputRef)?.goal).toBe('land it')
    expect(tables.inputs!.has('input-1')).toBe(true)
    expect(tables.changes!.has(change.id)).toBe(true)
  })

  it('seals scheduling when updating an existing work row is unknown', async () => {
    const { domain } = fakeDomain()
    const original = domain.table.bind(domain)
    let unknown = false
    const wrapped: DotDomainHandle = {
      ...domain,
      table: name => {
        const table = original(name)
        return {
          ...table,
          update: async (key, recipe) => {
            if (unknown && name === 'changes') throw unknownState()
            return table.update!(key, recipe)
          },
        }
      },
    }
    const store = new DotStore(wrapped)
    const change = await store.work.createChange({ title: 'A', cwd: 'H:\\proj', goal: 'a', at: 1 })
    unknown = true
    await expect(store.work.setControl(change.id, 'paused', 2)).rejects.toMatchObject({ code: 'unknown-state' })
    expect(store.work.change(change.id)?.control).toBe('open')
    expect(store.work.recoveryError).toMatch(/unknown-state/)
    expect(await store.work.reserveRun({ changeId: change.id, cwd: 'H:\\else', writeScope: { kind: 'paths', paths: [] }, at: 3 })).toMatchObject({ code: 'recovery' })
  })

  it('shows watched sessions in tasks and started sessions under startedTasks', async () => {
    const { domain } = fakeDomain({ tasks: {
      s: { sessionId: 's', origin: 'started', title: 'T', goal: 'G', cwd: '/work', status: 'idle', createdAt: 3, updatedAt: 3, unseenTurns: 0 },
      w: { sessionId: 'w', origin: 'watched', title: 'W', goal: 'G', cwd: '/home', status: 'running', createdAt: 2, updatedAt: 4, unseenTurns: 2 },
    } })
    const store = new DotStore(domain)
    const board = store.board([{ id: 'ap-1', kind: 'approval', sessionId: 's', createdAt: 4, subject: 'bash' }])
    expect(board.tasks.map(task => task.sessionId)).toEqual(['w'])
    expect(board.startedTasks?.map(task => task.sessionId)).toEqual(['s'])
  })

  it('seals scheduling when a schedule delete, proposal delete, or direct state write is unknown', async () => {
    const { domain } = fakeDomain()
    const original = domain.table.bind(domain)
    let mode = 'off'
    const wrapped: DotDomainHandle = {
      ...domain,
      table: name => {
        const table = original(name)
        return {
          ...table,
          put: async (key, value) => {
            await table.put(key, value)
            if (mode === 'state' && name === 'state') throw unknownState()
          },
          delete: async key => {
            if (mode === 'schedule-disk' && name === 'schedules') throw new Error('disk failure')
            const removed = await table.delete(key)
            if (mode === 'schedule' && name === 'schedules') throw unknownState()
            if (mode === 'proposal' && name === 'proposals') throw unknownState()
            return removed
          },
        }
      },
    }
    const store = new DotStore(wrapped)
    const change = await store.work.createChange({ title: 'A', cwd: 'H:\\proj', goal: 'a', maxConcurrentRuns: 4, at: 1 })
    const reserved = await store.work.reserveRun({ changeId: change.id, writeScope: { kind: 'paths', paths: [] }, at: 2 })
    if (!reserved.ok) throw new Error(reserved.message)
    const followUp = { kind: 'context' as const, targetSessionId: reserved.run.requestedSessionId, inputRevision: reserved.run.inputRevision, contentRef: 'c', source: 'dot', status: 'intent' as const }
    await store.putSchedule({ id: 'sch-1', title: 't', prompt: 'p', timing: { kind: 'once', at: 5 }, createdAt: 1, nextAt: 5 })
    mode = 'schedule'
    await expect(store.deleteSchedule('sch-1')).rejects.toMatchObject({ code: 'unknown-state' })
    expect(store.work.recoveryError).toMatch(/unknown-state/)
    expect(store.work.dispatchAllowed(reserved.run.id)).toMatchObject({ code: 'recovery' })
    expect(await store.work.addDelivery(reserved.run.id, followUp)).toMatchObject({ code: 'recovery' })
    expect(await store.work.reserveRun({ changeId: change.id, cwd: 'D:\\else', writeScope: { kind: 'paths', paths: [] }, at: 3 })).toMatchObject({ code: 'recovery' })
    const reopened = new DotStore(domain)
    expect(reopened.work.recoveryError).toBeUndefined()
    expect(reopened.schedule('sch-1')).toBeUndefined()
    expect(reopened.work.dispatchAllowed(reserved.run.id)).toEqual({ ok: true })

    mode = 'off'
    const proposals = new DotStore(wrapped)
    await proposals.putSettingProposal({ id: 'setting-1', field: 'scope', before: 'all', after: 'tracked', reason: 'test', createdAt: 1 })
    mode = 'proposal'
    await expect(proposals.deleteSettingProposal('setting-1')).rejects.toMatchObject({ code: 'unknown-state' })
    expect(proposals.work.dispatchAllowed(reserved.run.id)).toMatchObject({ code: 'recovery' })
    expect(await proposals.work.addDelivery(reserved.run.id, followUp)).toMatchObject({ code: 'recovery' })
    expect(await proposals.work.reserveRun({ changeId: change.id, cwd: 'D:\\else', writeScope: { kind: 'paths', paths: [] }, at: 4 })).toMatchObject({ code: 'recovery' })

    mode = 'off'
    const state = new DotStore(wrapped)
    mode = 'state'
    await expect(state.setAgreements('a rule')).rejects.toMatchObject({ code: 'unknown-state' })
    expect(state.work.dispatchAllowed(reserved.run.id)).toMatchObject({ code: 'recovery' })
    expect(await state.work.addDelivery(reserved.run.id, followUp)).toMatchObject({ code: 'recovery' })
    expect(await state.work.reserveRun({ changeId: change.id, cwd: 'D:\\else', writeScope: { kind: 'paths', paths: [] }, at: 5 })).toMatchObject({ code: 'recovery' })

    mode = 'schedule-disk'
    const plain = new DotStore(wrapped)
    await plain.putSchedule({ id: 'sch-2', title: 't', prompt: 'p', timing: { kind: 'once', at: 5 }, createdAt: 1, nextAt: 5 })
    await expect(plain.deleteSchedule('sch-2')).rejects.toThrow('disk failure')
    expect(plain.work.recoveryError).toBeUndefined()
    expect(plain.work.dispatchAllowed(reserved.run.id)).toEqual({ ok: true })
  })
})

describe('DotStore settings proposals', () => {
  it('keeps pending decisions across reload and removes them once settled', async () => {
    const { domain, tables } = fakeDomain()
    const store = new DotStore(domain)
    const proposal = { id: 'setting-1', field: 'scope' as const, before: 'all', after: 'tracked', reason: 'test', createdAt: 1 }
    await store.putSettingProposal(proposal)
    expect(new DotStore(domain).settingProposals).toEqual([proposal])
    await store.deleteSettingProposal(proposal.id)
    expect(tables.proposals!.size).toBe(0)
  })

  it('migrates a follow-host task-permission proposal baseline on load', () => {
    expect(parseSettingProposal({
      id: 'keep', field: 'taskPermission', before: 'default', after: 'danger-full-access', reason: 'faster', createdAt: 1,
    })).toMatchObject({ before: 'workspace-write', after: 'danger-full-access' })
    expect(parseSettingProposal({
      id: 'drop', field: 'taskPermission', before: 'workspace-write', after: 'default', reason: 'follow host', createdAt: 2,
    })).toBeUndefined()
    const { domain } = fakeDomain({
      state: { [STATE_KEY]: { settings: { taskPermission: 'default' } } },
      proposals: {
        keep: { id: 'keep', field: 'taskPermission', before: 'default', after: 'danger-full-access', reason: 'faster', createdAt: 1 },
        drop: { id: 'drop', field: 'taskPermission', before: 'workspace-write', after: 'default', reason: 'follow host', createdAt: 2 },
      },
    })
    const store = new DotStore(domain)
    expect(store.settings.taskPermission).toBe('workspace-write')
    expect(store.settingProposals.map(row => row.id)).toEqual(['keep'])
    expect(store.settingProposals[0]).toMatchObject({ before: 'workspace-write', after: 'danger-full-access' })
  })
})

describe('DotStore agreements and cognition', () => {

  it('keeps agreements and one undo step across a reload', async () => {
    const { domain } = fakeDomain()
    const store = new DotStore(domain)
    expect(store.agreements).toBe('')
    expect(store.agreementsUndo).toBeUndefined()
    await store.setAgreements('- use the standard preset\n')
    await store.setAgreements('- never push to main\n')
    expect(new DotStore(domain).agreements).toBe('- never push to main\n')
    expect(store.agreementsUndo).toBe('- use the standard preset\n')
    expect(await store.undoAgreements()).toBe(true)
    expect(store.agreements).toBe('- use the standard preset\n')
    // One step is kept: taking back again swaps the same two texts.
    expect(store.agreementsUndo).toBe('- never push to main\n')
    expect(await store.undoAgreements()).toBe(true)
    expect(store.agreements).toBe('- never push to main\n')
    expect(new DotStore(domain).agreements).toBe('- never push to main\n')
  })

  it('records each cognition replacement in a capped, strictly increasing history', async () => {
    const store = new DotStore(undefined)
    expect(store.cognitionHistory).toEqual([])
    // Same millisecond writes still get distinct, increasing timestamps.
    for (let index = 0; index < 12; index++) await store.setCognition(`v${index}`, 1000)
    expect(store.cognition).toBe('v11')
    expect(store.cognitionHistory).toHaveLength(10)
    // Newest first; the oldest two fell off.
    expect(store.cognitionHistory[0]!.text).toBe('v10')
    expect(store.cognitionHistory[9]!.text).toBe('v1')
    const ats = store.cognitionHistory.map(entry => entry.at)
    expect(new Set(ats).size).toBe(ats.length)
    for (let index = 1; index < ats.length; index++) expect(ats[index]!).toBeLessThan(ats[index - 1]!)
  })

  it('restores an older cognition text and pushes the replaced one back onto the history', async () => {
    const store = new DotStore(undefined)
    await store.setCognition('first', 10)
    await store.setCognition('second', 20)
    await store.setCognition('third', 30)
    const target = store.cognitionHistory.find(entry => entry.text === 'first')!
    expect(await store.restoreCognition(target.at, 40)).toBe(true)
    expect(store.cognition).toBe('first')
    // The text it replaced is now the newest history entry.
    expect(store.cognitionHistory[0]!.text).toBe('third')
    expect(await store.restoreCognition(999, 50)).toBe(false)
  })

  it('lets the empty text be a restorable version', async () => {
    const store = new DotStore(undefined)
    await store.setCognition('something', 10)
    const empty = store.cognitionHistory.find(entry => entry.text === '')!
    expect(empty).toBeDefined()
    expect(await store.restoreCognition(empty.at, 20)).toBe(true)
    expect(store.cognition).toBe('')
  })

})


describe('factory reset of the store', () => {
  it('wipes tables, restores default settings, and wipes data clean', async () => {
    const { domain, tables } = fakeDomain({
      tasks: { s1: { sessionId: 's1', origin: 'started', title: 't', goal: 'g', cwd: '/w', status: 'idle', createdAt: 1, updatedAt: 1, unseenTurns: 0 } },
      schedules: { sch: { id: 'sch', title: 'ping', prompt: 'check', timing: { kind: 'once', at: 9 }, createdAt: 1, nextAt: 9 } },
      proposals: { p1: { id: 'p1', field: 'scope', before: 'all', after: 'tracked', reason: 'less', createdAt: 1 } },
    })
    const store = new DotStore(domain)
    await store.setSettings({ ...DEFAULT_SETTINGS, scope: 'all', reflection: false })
    await store.setAgreements('do not push')
    await store.setCognition('short answers')
    expect(store.list()).toHaveLength(1)
    await store.factoryReset(5000)
    expect(store.list()).toEqual([])
    expect(store.schedules).toEqual([])
    expect(store.recipes).toEqual([])
    expect(store.settingProposals).toEqual([])
    expect(store.agreements).toBe('')
    expect(store.cognition).toBe('')
    expect(store.settings).toEqual(DEFAULT_SETTINGS)
    expect(store.lastFactoryResetAt).toBe(5000)
    expect(store.dotSessionId).toBeUndefined()
    expect([...tables.tasks.keys()]).toEqual([])
    expect([...tables.schedules.keys()]).toEqual([])
    const reloaded = new DotStore(domain)
    expect(reloaded.settings).toEqual(DEFAULT_SETTINGS)
    expect(reloaded.lastFactoryResetAt).toBe(5000)
    expect(reloaded.list()).toEqual([])
  })

})


describe('task recipe storage', () => {
  const recipeRow = {
    id: 'rcp-abc123', name: 'Weekly', revision: 2, reason: 'v2', createdAt: 1, updatedAt: 2,
    goal: 'write the weekly report',
    requirements: [{ requirementRef: 'goal', text: 'write the weekly report', required: true }],
    notes: 'be terse', dir: '/proj', preset: 'cordis', access: 'read' as const,
    history: [{ goal: 'report', requirements: [], revision: 1, name: 'Weekly', reason: 'v1', at: 1 }],
    outcomes: [{ changeId: 'c-1', title: 'Run', revision: 1, result: 'accepted' as const, failedRounds: 0, at: 2 }],
  }

  it('round-trips a recipe, resolves it by id or name, and deletes it', async () => {
    const { domain, tables } = fakeDomain()
    const store = new DotStore(domain)
    await store.putRecipe(recipeRow)
    expect([...tables.recipes.keys()]).toEqual(['rcp-abc123'])
    const reloaded = new DotStore(domain)
    expect(reloaded.recipe('rcp-abc123')).toMatchObject({ name: 'Weekly', revision: 2 })
    expect(reloaded.recipe('weekly')).toMatchObject({ id: 'rcp-abc123' })
    expect(reloaded.recipe('missing')).toBeUndefined()
    expect(await reloaded.deleteRecipe('rcp-abc123')).toBe(true)
    expect(reloaded.recipe('rcp-abc123')).toBeUndefined()
    expect(new DotStore(domain).recipes).toEqual([])
  })

  it('round-trips outcome cost fields while legacy outcomes stay readable', () => {
    const { domain } = fakeDomain({ recipes: { 'rcp-abc123': {
      ...recipeRow,
      outcomes: [
        { changeId: 'c-1', title: 'Run', revision: 2, result: 'accepted', failedRounds: 0, tokens: 12_800, wallMs: 252_000, at: 2 },
        { changeId: 'c-2', title: 'Old', revision: 2, result: 'cancelled', failedRounds: 1, at: 3 },
      ],
    } } })
    const store = new DotStore(domain)
    const outcomes = store.recipe('rcp-abc123')!.outcomes
    expect(outcomes[0]).toMatchObject({ changeId: 'c-1', tokens: 12_800, wallMs: 252_000 })
    expect(outcomes[1]).toMatchObject({ changeId: 'c-2', result: 'cancelled' })
    expect(outcomes[1]).not.toHaveProperty('tokens')
    expect(outcomes[1]).not.toHaveProperty('wallMs')
  })

  it('reads a malformed recipe row as absent', () => {
    const { domain } = fakeDomain({ recipes: {
      'rcp-bad': { id: 'rcp-bad', name: 5 },
      'rcp-stray': { ...recipeRow, id: 'rcp-other' },
      'rcp-abc123': recipeRow,
    } })
    const store = new DotStore(domain)
    expect(store.recipes.map(row => row.id)).toEqual(['rcp-abc123'])
  })

  it('still loads a change row written before the recipe tag existed', () => {
    const { domain } = fakeDomain({ changes: {
      'c-1': {
        id: 'c-1', title: 'Old', cwd: '/w', priority: 2, control: 'open', maxConcurrentRuns: 1,
        currentRevision: 1, currentInputRef: 'input-1', steps: [], createdAt: 1, updatedAt: 1,
      },
    }, inputs: {
      'input-1': { id: 'input-1', changeId: 'c-1', revision: 1, goal: 'g', requirements: [], steps: [], source: 'create', createdAt: 1 },
    } })
    const store = new DotStore(domain)
    const change = store.work.change('c-1')
    expect(change).toMatchObject({ id: 'c-1', title: 'Old' })
    expect(change?.recipe).toBeUndefined()
  })
})
