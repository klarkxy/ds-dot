import { act } from 'react'
import { Simulate } from 'react-dom/test-utils'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RecipesView, type ChatApi } from './chat-panel.tsx'
import { useRecipes } from './chat-hooks.ts'
import type { RecipeBoardRow } from './contracts.ts'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('navigator', dom.window.navigator)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
dom.window.requestAnimationFrame = (callback: FrameRequestCallback) => { callback(0); return 0 }
vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame)
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => { createRoot = (await import('react-dom/client')).createRoot })
afterEach(() => { document.body.innerHTML = '<div id="root"></div>' })

function row(partial: Partial<RecipeBoardRow> = {}): RecipeBoardRow {
  return {
    id: 'rcp-1', name: 'Weekly report', revision: 2, updatedAt: 100,
    stats: [{ revision: 2, accepted: 3, cancelled: 1, failedRounds: 2, inFlight: 0 }],
    inFlight: [], reminders: [{ id: 'sch-1', title: 'run weekly', nextAt: Date.now() + 3600_000 }],
    ...partial,
  }
}

function api(run: ChatApi['recipeRun']): ChatApi {
  return { recipeRun: run } as unknown as ChatApi
}

async function mount(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  return { root, container }
}

describe('RecipesView', () => {
  it('renders stats, bound reminders and the empty state', async () => {
    const { container } = await mount(<RecipesView locale="en" api={api(async () => ({ ok: false, reason: 'x' }))} rows={[row()]} onChanged={() => {}} />)
    expect(container.textContent).toContain('Weekly report')
    expect(container.textContent).toContain('rev 2')
    expect(container.textContent).toContain('3 accepted')
    expect(container.textContent).toContain('run weekly')
    const empty = await mount(<RecipesView locale="en" api={api(async () => ({ ok: false, reason: 'x' }))} rows={[]} onChanged={() => {}} />)
    expect(empty.container.textContent).toContain('No recipes')
  })

  it('requires a second click to run and refreshes on success', async () => {
    const calls: string[] = []
    let changed = 0
    const a = api(async id => { calls.push(id); return { ok: true, changeId: 'chg-9', runId: 'run-9' } })
    const { container } = await mount(<RecipesView locale="en" api={a} rows={[row()]} onChanged={() => { changed += 1 }} />)
    const button = container.querySelector<HTMLButtonElement>('.dsh-dot-recipe-head button')!
    expect(button.textContent).toBe('Run now')
    await act(async () => { Simulate.click(button) })
    expect(calls).toHaveLength(0)
    expect(button.textContent).toBe('Confirm run')
    await act(async () => { Simulate.click(button) })
    expect(calls).toEqual(['rcp-1'])
    expect(changed).toBe(1)
    expect(container.textContent).toContain('Dispatched chg-9')
  })

  it('disables Run now while a run is in flight and shows refusals inline', async () => {
    const a = api(async () => ({ ok: false, reason: 'previous run still in flight' }))
    const { container } = await mount(<RecipesView locale="en" api={a} rows={[row({ inFlight: [{ changeId: 'chg-1', title: 'T', status: 'running' }] })]} onChanged={() => {}} />)
    const button = container.querySelector<HTMLButtonElement>('.dsh-dot-recipe-head button')!
    expect(button.disabled).toBe(true)
    expect(container.textContent).toContain('chg-1')
  })

  it('shows a retryable error when nothing loaded and a refresh hint over stale rows', async () => {
    let changed = 0
    const a = api(async () => ({ ok: false, reason: 'x' }))
    const { container } = await mount(<RecipesView locale="en" api={a} rows={[]} error="offline" onChanged={() => { changed += 1 }} />)
    expect(container.textContent).toContain('Could not reach Dorothy')
    expect(container.textContent).not.toContain('No recipes')
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!
    await act(async () => { Simulate.click(retry) })
    expect(changed).toBe(1)

    const stale = await mount(<RecipesView locale="en" api={a} rows={[row()]} error="offline" onChanged={() => {}} />)
    expect(stale.container.textContent).toContain('Weekly report')
    expect(stale.container.textContent).toContain('Could not refresh the recipe list')
  })

  it('exposes poll failures through useRecipes and clears them on a good pass', async () => {
    let calls = 0
    const a = {
      recipes: async () => {
        calls += 1
        if (calls === 1) throw new Error('offline')
        return [row()]
      },
    } as unknown as ChatApi
    function Probe() {
      const [rows, error, refresh] = useRecipes(a)
      return <div>
        <span data-part="rows">{rows.length}</span>
        <span data-part="error">{error ?? ''}</span>
        <button onClick={refresh}>refresh</button>
      </div>
    }
    const { container } = await mount(<Probe />)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-part="rows"]')!.textContent).toBe('0')
    expect(container.querySelector('[data-part="error"]')!.textContent).toBe('offline')
    // A manual refresh reruns the poll; a good pass clears the error.
    const button = container.querySelector('button')!
    await act(async () => { Simulate.click(button); await Promise.resolve() })
    expect(container.querySelector('[data-part="rows"]')!.textContent).toBe('1')
    expect(container.querySelector('[data-part="error"]')!.textContent).toBe('')
  })

  it('keeps stale rows and re-shows the error when a later poll fails', async () => {
    let calls = 0
    const a = {
      recipes: async () => {
        calls += 1
        return calls === 1 ? [row()] : Promise.reject(new Error('gone'))
      },
    } as unknown as ChatApi
    function Probe() {
      const [rows, error, refresh] = useRecipes(a)
      return <div>
        <span data-part="rows">{rows.length}</span>
        <span data-part="error">{error ?? ''}</span>
        <button onClick={refresh}>refresh</button>
      </div>
    }
    const { container } = await mount(<Probe />)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-part="rows"]')!.textContent).toBe('1')
    const button = container.querySelector('button')!
    await act(async () => { Simulate.click(button); await Promise.resolve() })
    expect(container.querySelector('[data-part="rows"]')!.textContent).toBe('1')
    expect(container.querySelector('[data-part="error"]')!.textContent).toBe('gone')
  })

  it('shows the refusal message inline on failure', async () => {
    const a = api(async () => ({ ok: false, reason: 'directory locked by run-3' }))
    const { container } = await mount(<RecipesView locale="en" api={a} rows={[row()]} onChanged={() => {}} />)
    const button = container.querySelector<HTMLButtonElement>('.dsh-dot-recipe-head button')!
    await act(async () => { Simulate.click(button) })
    await act(async () => { Simulate.click(button) })
    expect(container.textContent).toContain('directory locked by run-3')
  })
})

describe('RecipesView proposals', () => {
  const decideApi = (decide: ChatApi['recipeProposalDecide']) => ({ recipeProposalDecide: decide } as unknown as ChatApi)

  it('renders a pending detector restore proposal and approves in two clicks', async () => {
    const calls: { id: string; allow: boolean }[] = []
    let changed = 0
    const a = decideApi(async (id, allow) => { calls.push({ id, allow }); return 'ok' })
    const withProposal = row({
      proposal: {
        id: 'rpp-1', kind: 'restore', origin: 'detector', baseRevision: 2, targetRevision: 1,
        reason: 'rev 2: 1/4 accepted, 2.5 failed rounds avg; rev 1: 4/5 accepted, 0.4 failed rounds avg',
        base: { goal: 'old goal', requirementsFromGoal: false, requirements: [{ requirementRef: 'r1', text: 'req a', required: true }], constraints: [] },
        createdAt: 5,
      },
    })
    const { container } = await mount(<RecipesView locale="en" api={a} rows={[withProposal]} onChanged={() => { changed += 1 }} />)
    const block = container.querySelector('[data-proposal="rpp-1"]')!
    expect(block.textContent).toContain('restore')
    expect(block.textContent).toContain('detector')
    expect(block.textContent).toContain('rev 2: 1/4 accepted')
    expect(block.textContent).toContain('restore rev 1 content')
    const approve = [...block.querySelectorAll('button')].find(btn => btn.textContent === 'Approve')!
    // First click arms only.
    await act(async () => { Simulate.click(approve) })
    expect(calls).toHaveLength(0)
    const armed = [...block.querySelectorAll('button')].find(btn => btn.textContent === 'Confirm approve')!
    await act(async () => { Simulate.click(armed); await Promise.resolve() })
    expect(calls).toEqual([{ id: 'rpp-1', allow: true }])
    expect(changed).toBe(1)
  })

  it('dismisses without a second click', async () => {
    const calls: { id: string; allow: boolean }[] = []
    const a = decideApi(async (id, allow) => { calls.push({ id, allow }); return 'ok' })
    const withProposal = row({
      proposal: {
        id: 'rpp-2', kind: 'restore', origin: 'reflection', baseRevision: 2, targetRevision: 1,
        reason: 'suggestion', base: { goal: 'g', requirementsFromGoal: false, requirements: [], constraints: [] }, createdAt: 5,
      },
    })
    const { container } = await mount(<RecipesView locale="en" api={a} rows={[withProposal]} onChanged={() => {}} />)
    const dismiss = [...container.querySelectorAll('button')].find(btn => btn.textContent === 'Dismiss')!
    await act(async () => { Simulate.click(dismiss); await Promise.resolve() })
    expect(calls).toEqual([{ id: 'rpp-2', allow: false }])
  })

  it('shows the field-level diff for a revise proposal', async () => {
    const withProposal = row({
      proposal: {
        id: 'rpp-3', kind: 'revise', origin: 'reflection', baseRevision: 2,
        reason: 'cadence changed',
        patch: {
          goal: 'monthly report',
          requirements: [{ requirementRef: 'r2', text: 'covers last month', required: true }],
          constraints: [{ constraintRef: 'c2', text: 'under two pages' }],
        },
        base: {
          goal: 'weekly report', requirementsFromGoal: false,
          requirements: [{ requirementRef: 'r1', text: 'covers last week', required: true }],
          constraints: [{ constraintRef: 'c1', text: 'under one page' }],
        },
        createdAt: 5,
      },
    })
    const { container } = await mount(<RecipesView locale="en" api={decideApi(async () => 'ok')} rows={[withProposal]} onChanged={() => {}} />)
    const block = container.querySelector('[data-proposal="rpp-3"]')!
    expect(block.textContent).toContain('revise')
    expect(block.textContent).toContain('«weekly report» → «monthly report»')
    expect(block.textContent).toContain('+ covers last month')
    expect(block.textContent).toContain('− covers last week')
    expect(block.textContent).toContain('+ under two pages')
    expect(block.textContent).toContain('− under one page')
  })

  it('keeps untouched requirements and constraints out of a goal-only diff', async () => {
    const withProposal = row({
      proposal: {
        id: 'rpp-5', kind: 'revise', origin: 'reflection', baseRevision: 2,
        reason: 'new cadence',
        patch: { goal: 'monthly report' },
        base: {
          goal: 'weekly report', requirementsFromGoal: false,
          requirements: [{ requirementRef: 'r1', text: 'covers last week', required: true }],
          constraints: [{ constraintRef: 'c1', text: 'under one page' }],
        },
        createdAt: 5,
      },
    })
    const { container } = await mount(<RecipesView locale="en" api={decideApi(async () => 'ok')} rows={[withProposal]} onChanged={() => {}} />)
    const block = container.querySelector('[data-proposal="rpp-5"]')!
    expect(block.textContent).toContain('«weekly report» → «monthly report»')
    // Approval keeps the explicit lists, so nothing renders as removed.
    expect(block.textContent).not.toContain('−')
    expect(block.textContent).not.toContain('covers last week')
  })

  it('shows a required/scenario flip as a changed requirement, not add+remove', async () => {
    const withProposal = row({
      proposal: {
        id: 'rpp-6', kind: 'revise', origin: 'reflection', baseRevision: 2,
        reason: 'soften',
        patch: {
          requirements: [
            { requirementRef: 'r1', text: 'covers last week', required: false },
            { requirementRef: 'r2', text: 'links to the tracker', required: true, scenarios: [{ scenarioRef: 's1', when: 'the tracker moves', then: 'relink' }] },
          ],
        },
        base: {
          goal: 'weekly report', requirementsFromGoal: false,
          requirements: [
            { requirementRef: 'r1', text: 'covers last week', required: true },
            { requirementRef: 'r2', text: 'links to the tracker', required: true },
          ],
          constraints: [],
        },
        createdAt: 5,
      },
    })
    const { container } = await mount(<RecipesView locale="en" api={decideApi(async () => 'ok')} rows={[withProposal]} onChanged={() => {}} />)
    const block = container.querySelector('[data-proposal="rpp-6"]')!
    expect(block.textContent).toContain('«covers last week» → «covers last week (optional)»')
    expect(block.textContent).toContain('[the tracker moves]')
    // Same refs with the same text are changes, not removals.
    expect(block.textContent).not.toContain('−')
    expect(block.textContent).not.toContain('+')
  })

  it('shows a decision error inline', async () => {
    const a = decideApi(async () => { throw new Error('proposal rpp-4 is stale') })
    const withProposal = row({
      proposal: {
        id: 'rpp-4', kind: 'restore', origin: 'detector', baseRevision: 2, targetRevision: 1,
        reason: 'r', base: { goal: 'g', requirementsFromGoal: false, requirements: [], constraints: [] }, createdAt: 5,
      },
    })
    const { container } = await mount(<RecipesView locale="en" api={a} rows={[withProposal]} onChanged={() => {}} />)
    const block = container.querySelector('[data-proposal="rpp-4"]')!
    const approve = [...block.querySelectorAll('button')].find(btn => btn.textContent === 'Approve')!
    await act(async () => { Simulate.click(approve) })
    const armed = [...block.querySelectorAll('button')].find(btn => btn.textContent === 'Confirm approve')!
    await act(async () => { Simulate.click(armed); await Promise.resolve() })
    expect(block.textContent).toContain('proposal rpp-4 is stale')
  })
})
