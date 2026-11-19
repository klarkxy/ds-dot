import { act } from 'react'
import { Simulate } from 'react-dom/test-utils'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from './contracts.ts'
import { DotService } from './service.ts'
import { DotStore } from './store.ts'
import { WorkBoard, WorkBoardPanel } from './work-board.tsx'
import type { WorkBoardItem, WorkReadRequest } from './work-board.ts'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('navigator', dom.window.navigator)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => { createRoot = (await import('react-dom/client')).createRoot })
afterEach(() => { document.body.innerHTML = '<div id="root"></div>' })

const item: WorkBoardItem = {
  id: 'c-1', title: 'Ship', priority: 2, revision: 4, inputRef: 'in-4', control: 'open', status: 'review',
  runs: [{ id: 'run-2', kind: 'review', phase: 'settling', cwd: 'H:/repo' }],
  blockers: ['run-2'],
  verification: { id: 'v-3', verdict: 'accept', subjectKey: 'subject-key-long', inputRef: 'in-4', inputRevision: 4 },
  oversight: { requested: true, inputRef: 'in-4', inputRevision: 4 },
  humanAction: { action: 'accept', expectedInputRef: 'in-4', expectedInputRevision: 4, expectedVerificationId: 'v-3', expectedSubjectKey: 'subject-key-long' },
}

const click = (text: string) => act(async () => {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent === text)
  button?.click()
})

const buttonIncluding = (text: string) => [...document.querySelectorAll('button')].find(node => (node.textContent ?? '').includes(text))

/** Open every card's details the way a click does; sources are read only after that. */
async function openDetails() {
  await act(async () => {
    for (const node of document.querySelectorAll<HTMLDetailsElement>('details.dsh-dot-work-facts')) {
      if (node.open) continue
      node.open = true
      node.dispatchEvent(new dom.window.Event('toggle'))
    }
    await Promise.resolve(); await Promise.resolve()
  })
}

const longBody = (head: string, tail: string, size = 80_000) => `${head}${'a'.repeat(size)}${tail}`

describe('WorkBoard', () => {
  it('keeps only the groups of the drawer filter', async () => {
    const running: WorkBoardItem = { ...item, id: 'c-2', title: 'Still going', status: 'running', humanAction: undefined }
    const root = createRoot(document.getElementById('root')!)
    const sections = () => [...document.querySelectorAll('section[aria-label]')].map(node => node.getAttribute('aria-label'))
    const props = { locale: 'en' as const, items: [item, running], pending: [], onAccept: vi.fn(), onReject: vi.fn(), onAnswer: vi.fn(), onResume: vi.fn() }
    await act(async () => root.render(<WorkBoard {...props} filter="waiting" />))
    expect(sections()).toEqual(['Needs you'])
    await act(async () => root.render(<WorkBoard {...props} filter="active" />))
    expect(sections()).toEqual(['In progress'])
    await act(async () => root.render(<WorkBoard {...props} />))
    expect(sections()).toEqual(['Needs you', 'In progress'])
    await act(async () => root.unmount())
  })

  it('labels the dispatch message status, hides it once accepted, and asks twice before releasing', async () => {
    vi.useFakeTimers()
    try {
      const onForceRelease = vi.fn()
      const cancelled: WorkBoardItem = {
        ...item, id: 'c-9', title: 'Gone', status: 'cancelled', blockers: ['run-9'], verification: undefined, oversight: undefined, humanAction: undefined,
        runs: [{ id: 'run-9', kind: 'work', phase: 'stopped', cwd: 'H:/repo', deliveries: [{ id: 'd-1', kind: 'dispatch', status: 'unknown', contentRef: 'r-1' }] }],
      }
      const root = createRoot(document.getElementById('root')!)
      await act(async () => root.render(
        <WorkBoard locale="en" items={[cancelled]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onForceRelease={onForceRelease} />,
      ))
      await click('Finished · 1')
      expect(document.body.textContent).toContain('Dispatch: unknown')
      expect(document.body.textContent).not.toContain('Delivery Unknown')
      await click('Release lock')
      expect(onForceRelease).not.toHaveBeenCalled()
      expect(buttonIncluding('Confirm release')).toBeTruthy()
      await act(async () => { vi.advanceTimersByTime(6_000) })
      expect(buttonIncluding('Confirm release')).toBeUndefined()
      await click('Release lock')
      await click('Confirm release')
      expect(onForceRelease).toHaveBeenCalledWith({ id: 'c-9' })

      const delivered: WorkBoardItem = {
        ...cancelled, id: 'c-10', blockers: [],
        runs: [{ id: 'run-10', kind: 'work', phase: 'completed', cwd: 'H:/repo', deliveries: [{ id: 'd-2', kind: 'dispatch', status: 'accepted', contentRef: 'r-2' }] }],
      }
      await act(async () => root.render(
        <WorkBoard locale="en" items={[delivered]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onForceRelease={onForceRelease} />,
      ))
      await click('Finished · 1')
      expect(document.body.textContent).not.toContain('Dispatch:')
      await act(async () => root.unmount())
    } finally {
      vi.useRealTimers()
    }
  })


  it('sends the versions on the projection and does not claim a withdrawn look succeeded', async () => {
    const onAccept = vi.fn()
    const onAnswer = vi.fn()
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(
      <WorkBoard locale="en" items={[item]} pending={[]} notice="The look request was withdrawn or is gone. No decision was recorded." onAccept={onAccept} onReject={vi.fn()} onAnswer={onAnswer} onResume={vi.fn()} />,
    ))
    expect(document.body.textContent).toContain('Version 4')
    await act(async () => { document.querySelector<HTMLDetailsElement>('details.dsh-dot-work-facts')!.open = true })
    expect(document.body.textContent).toContain('v-3')
    expect(document.body.textContent).toContain('Acceptable')
    expect(document.body.textContent).toContain('No decision was recorded')
    expect(document.body.textContent).not.toContain('Looks good')
    await click('Accept')
    expect(onAccept).toHaveBeenCalledWith({
      id: 'c-1', verificationId: 'v-3', expectedInputRef: 'in-4', expectedInputRevision: 4, expectedSubjectKey: 'subject-key-long',
    })
    expect(onAnswer).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })

  it('renders the parent board.work as it is: a background update with an unchanged pending set redraws the card', async () => {
    const running = {
      ...item, title: 'Version 1', revision: 1, status: 'running' as const,
      runs: [{ id: 'run-1', kind: 'work', phase: 'active', cwd: 'H:/repo' }],
      blockers: ['run-1'], verification: undefined, oversight: undefined, humanAction: undefined,
    }
    const finishing = { ...running, title: 'Version 2', revision: 2, runs: [{ id: 'run-1', kind: 'work', phase: 'settling', cwd: 'H:/repo' }] }
    const done = { ...finishing, title: 'Version 3', revision: 3, status: 'done' as const, blockers: [] }
    const api = { workAccept: async () => {}, workReject: async () => {}, workAnswer: async () => {}, workResume: async () => {} }
    const pending = [{ id: 'p-2', kind: 'approval' }]
    const onChanged = vi.fn()
    const draw = (items: readonly WorkBoardItem[]) => root.render(<WorkBoardPanel locale="en" api={api} items={items} pending={pending} onChanged={onChanged} />)
    const root = createRoot(document.getElementById('root')!)
    await act(async () => draw([running]))
    expect(document.body.textContent).toContain('Version 1')
    await act(async () => draw([finishing]))
    expect(document.body.textContent).toContain('Version 2')
    expect(document.body.textContent).not.toContain('Version 1')
    await act(async () => draw([done]))
    expect(document.body.textContent).not.toContain('Version 2')
    await act(async () => { buttonIncluding('Finished · 1')!.click() })
    expect(document.body.textContent).toContain('Version 3')
    await act(async () => root.unmount())
  })

  it('asks the parent to refresh after an action, also when it is refused', async () => {
    const onChanged = vi.fn()
    let refuse = false
    const api = {
      workAccept: async () => { if (refuse) throw new Error('stale version') },
      workReject: async () => {}, workAnswer: async () => {}, workResume: async () => {},
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<WorkBoardPanel locale="en" api={api} items={[item]} pending={[]} onChanged={onChanged} />))
    await click('Accept')
    expect(onChanged).toHaveBeenCalledTimes(1)
    refuse = true
    await click('Accept')
    expect(onChanged).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('refused')
    await act(async () => root.unmount())
  })
  it('shows scope, delivery and evidence in Chinese without painting a refusal as done', async () => {
    const detailed: WorkBoardItem = {
      ...item, status: 'running', title: 'Ship', summary: 'land the fix',
      runs: [{
        id: 'run-1', kind: 'work', phase: 'active', cwd: 'H:/repo',
        writeScope: { kind: 'paths', paths: [{ path: 'src/a.ts', type: 'file' }] },
        deliveries: [{ id: 'del-1', kind: 'initial', status: 'unknown', contentRef: 'write result.txt', evidence: 'not confirmed' }],
      }],
      verification: {
        id: 'v-3', verdict: 'unverified', subjectKey: 'subject-key-long', inputRef: 'in-4', inputRevision: 4,
        checks: [{ requirementRef: 'goal', verdict: 'fail', evidenceRefs: ['log-1'], note: 'build failed' }],
        changes: [{ path: 'src/a.ts', kind: 'modified' }],
      },
      humanAction: undefined,
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(
      <WorkBoard locale="zh" items={[detailed]} pending={[]} notice="这是旧版本，已拒绝。请看刷新后的工作。" onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} />,
    ))
    const text = document.body.textContent ?? ''
    expect(text).toContain('执行中')
    expect(text).toContain('执行')
    expect(text).toContain('进行中')
    expect(text).toContain('src/a.ts')
    expect(text).toContain('修改')
    expect(text).not.toContain('modified')
    expect(text).toContain('write result.txt')
    expect(text).toContain('未知')
    expect(text).toContain('log-1')
    expect(text).toContain('build failed')
    expect(text).toContain('未通过')
    expect(text).toContain('未验证')
    expect(text).not.toContain('已完成')
    expect(text).toContain('已拒绝')
    await act(async () => root.unmount())
  })

  it('shows a uniquely marked evidence body from the service and a failure for a missing read', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dot-evidence-home-'))
    const project = mkdtempSync(join(tmpdir(), 'dot-evidence-proj-'))
    const store = new DotStore(undefined)
    void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
    const service = new DotService({
      host: { isRunning: () => false, listSessions: async () => [], readEvents: async () => [], listModels: async () => ({ fallback: { provider: 'p', model: 'ok' }, models: [] }), listPresets: async () => ({ fallback: 'standard', presets: [] }) } as never,
      store, homeDir: home, notes: { path: '/dot/memory.md', text: '', cognition: '', read: async () => '', readCognition: async () => '' },
      approvalGraceMs: 0,
      timer: { set: (cb, ms) => setTimeout(cb, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now() },
      now: () => 1000,
    })
    const marker = 'FINAL_C_EVIDENCE_BODY_7C: npm check exit=0, both A and B verified'
    try {
      const change = await service.createWorkChange({ title: 'Ship', cwd: project, goal: 'land it', requirements: [{ requirementRef: 'r1', text: 'edits', required: true }], at: 1 })
      const current = store.work.change(change.id)!
      mkdirSync(join(home, 'artifacts', 'evidence'), { recursive: true })
      writeFileSync(join(home, 'artifacts', 'evidence', 'run-1.md'), marker)
      const recorded = await service.recordWorkVerification(change.id, [
        { requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['run:run-1'], note: marker },
      ], [], { inputRef: current.currentInputRef, inputRevision: current.currentRevision })
      if (!('id' in recorded)) throw new Error(recorded.message)
      const view = service.workBoard(change.id)
      if (!view) throw new Error('missing projection')
      const read = (request: WorkReadRequest) => {
        const result = service.readWorkSource(request.id, request.kind, request.ref, {
          verificationId: request.verificationId, inputRef: request.inputRef, inputRevision: request.inputRevision,
        })
        if (!result.ok) throw new Error(result.message)
        return Promise.resolve({ source: result.source, body: result.body })
      }
      const root = createRoot(document.getElementById('root')!)
      await act(async () => { root.render(<WorkBoard locale="zh" items={[view]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={read} />); await Promise.resolve(); await Promise.resolve() })
      await openDetails()
      const text = document.body.textContent ?? ''
      expect(document.querySelectorAll('a[data-evidence-ref]')).toHaveLength(1)
      expect(text).toContain(marker)
      expect(service.readWorkSource(change.id, 'evidence', 'run:run-9', {
        verificationId: view.verification?.id ?? '', inputRef: view.verification?.inputRef ?? '', inputRevision: view.verification?.inputRevision ?? 0,
      })).toMatchObject({ ok: false, code: 'stale' })
      await act(async () => root.unmount())
      const failed = createRoot(document.getElementById('root')!)
      await act(async () => {
        failed.render(<WorkBoard locale="zh" items={[view]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={() => Promise.reject(new Error('run report run-1 is missing'))} />)
        await Promise.resolve()
        await Promise.resolve()
      })
      await openDetails()
      expect(document.body.textContent).toContain('证据不存在或内容为空')
      expect(document.body.textContent).not.toContain('已完成')
      expect(document.querySelector('[data-evidence-body]')).toBeNull()
      await act(async () => failed.unmount())
    } finally {
      rmSync(project, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('hides the previous body when the verification changes and does not apply a late response', async () => {
    const checks = [{ requirementRef: 'r1', verdict: 'pass', evidenceRefs: ['log-1'] }]
    const changes = [{ path: 'a.ts', kind: 'modified' }]
    const first: WorkBoardItem = {
      ...item, revision: 1, inputRef: 'in-1', title: 'Version 1',
      verification: { id: 'v-old', verdict: 'accept', subjectKey: 'subject-old', inputRef: 'in-1', inputRevision: 1, checks, changes },
    }
    const second: WorkBoardItem = {
      ...first, revision: 2, inputRef: 'in-2', title: 'Version 2',
      verification: { id: 'v-new', verdict: 'accept', subjectKey: 'subject-new', inputRef: 'in-2', inputRevision: 2, checks, changes },
    }
    const calls: string[] = []
    const late: Array<(value: { source: string; body: string }) => void> = []
    const onRead = (request: WorkReadRequest) => {
      calls.push(`${request.verificationId}:${request.kind}:${request.ref}`)
      if (request.verificationId === 'v-old') return new Promise<{ source: string; body: string }>(resolve => { late.push(resolve) })
      return Promise.resolve({ source: `${request.kind}:${request.ref}`, body: `NEW:${request.ref}` })
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<WorkBoard locale="en" items={[first]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve() })
    await openDetails()
    expect(calls).toEqual(['v-old:evidence:log-1', 'v-old:change:a.ts'])
    await act(async () => {
      late.splice(0).forEach(resolve => resolve({ source: 'evidence:log-1', body: 'OLD_MARKED_BODY' }))
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('OLD_MARKED_BODY')
    const seen = calls.length
    await act(async () => { root.render(<WorkBoard locale="en" items={[second]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve(); await Promise.resolve() })
    await openDetails()
    expect(document.body.textContent).toContain('Version 2')
    expect(document.body.textContent).not.toContain('OLD_MARKED_BODY')
    expect(calls.length).toBeGreaterThan(seen)
    expect(calls).toContain('v-new:evidence:log-1')
    await act(async () => {
      late.splice(0).forEach(resolve => resolve({ source: 'evidence:log-1', body: 'OLD_MARKED_BODY' }))
      await Promise.resolve()
    })
    expect(document.body.textContent).not.toContain('OLD_MARKED_BODY')
    expect(document.body.textContent).toContain('NEW:log-1')
    await act(async () => root.unmount())
  })

  it('hides a loaded body as soon as only the change input moves on', async () => {
    const checks = [{ requirementRef: 'r1', verdict: 'pass', evidenceRefs: ['log-1'] }]
    const changes = [{ path: 'a.ts', kind: 'modified' }]
    const verification = { id: 'v-1', verdict: 'accept' as const, subjectKey: 'subject-old', inputRef: 'in-1', inputRevision: 1, checks, changes }
    const first: WorkBoardItem = { ...item, revision: 1, inputRef: 'in-1', title: 'Version 1', verification }
    const bumped: WorkBoardItem = { ...first, revision: 2, inputRef: 'in-2', title: 'Version 2' }
    let hang = false
    const onRead = () => {
      if (!hang) return Promise.resolve({ source: 'evidence:log-1', body: 'OLD_MARKED_BODY' })
      return new Promise<{ source: string; body: string }>(() => undefined)
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<WorkBoard locale="en" items={[first]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve(); await Promise.resolve() })
    await openDetails()
    expect(document.body.textContent).toContain('OLD_MARKED_BODY')
    expect(document.querySelectorAll('[data-evidence-body]')).toHaveLength(2)
    hang = true
    await act(async () => { root.render(<WorkBoard locale="en" items={[bumped]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve() })
    await openDetails()
    expect(document.body.textContent).toContain('Version 2')
    expect(document.body.textContent).toContain('v-1')
    expect(document.body.textContent).not.toContain('OLD_MARKED_BODY')
    expect(document.querySelectorAll('[data-evidence-body]')).toHaveLength(0)
    await act(async () => root.unmount())
  })

  it('does not restore the old body when that read resolves after only the input moves on', async () => {
    const checks = [{ requirementRef: 'r1', verdict: 'pass', evidenceRefs: ['log-1'] }]
    const changes = [{ path: 'a.ts', kind: 'modified' }]
    const verification = { id: 'v-1', verdict: 'accept' as const, subjectKey: 'subject-old', inputRef: 'in-1', inputRevision: 1, checks, changes }
    const first: WorkBoardItem = { ...item, revision: 1, inputRef: 'in-1', title: 'Version 1', verification }
    const bumped: WorkBoardItem = { ...first, revision: 2, inputRef: 'in-2', title: 'Version 2' }
    const calls: number[] = []
    const early: Array<(value: { source: string; body: string }) => void> = []
    const onRead = () => {
      const wave = calls.length < 2 ? 0 : 1
      calls.push(wave)
      if (wave === 0) return new Promise<{ source: string; body: string }>(resolve => { early.push(resolve) })
      return new Promise<{ source: string; body: string }>(() => undefined)
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<WorkBoard locale="en" items={[first]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve() })
    await openDetails()
    expect(calls).toEqual([0, 0])
    await act(async () => { root.render(<WorkBoard locale="en" items={[bumped]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve() })
    await openDetails()
    expect(document.body.textContent).toContain('Version 2')
    expect(document.querySelectorAll('[data-evidence-body]')).toHaveLength(0)
    expect(calls.filter(wave => wave === 1).length).toBeGreaterThan(0)
    await act(async () => {
      early.splice(0).forEach(resolve => resolve({ source: 'evidence:log-1', body: 'OLD_MARKED_BODY' }))
      await Promise.resolve()
    })
    expect(document.body.textContent).not.toContain('OLD_MARKED_BODY')
    expect(document.querySelectorAll('[data-evidence-body]')).toHaveLength(0)
    await act(async () => root.unmount())
  })

  it('shows a short preview when the backend truncates above 256KiB and the full tail after forceFull', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dot-evidence-full-'))
    const project = mkdtempSync(join(tmpdir(), 'dot-evidence-full-proj-'))
    const store = new DotStore(undefined)
    void store.setSettings({ ...DEFAULT_SETTINGS, reflection: false, idleCheckMinutes: 0 })
    const service = new DotService({
      host: { isRunning: () => false, listSessions: async () => [], readEvents: async () => [], listModels: async () => ({ fallback: { provider: 'p', model: 'ok' }, models: [] }), listPresets: async () => ({ fallback: 'standard', presets: [] }) } as never,
      store, homeDir: home, notes: { path: '/dot/memory.md', text: '', cognition: '', read: async () => '', readCognition: async () => '' },
      approvalGraceMs: 0,
      timer: { set: (cb, ms) => setTimeout(cb, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now() },
      now: () => 1000,
    })
    const tail = 'TAIL_MARK_AFTER_256K'
    const body = `${'x'.repeat(262_145)}${tail}`
    try {
      const change = await service.createWorkChange({ title: 'Ship', cwd: project, goal: 'land it', requirements: [{ requirementRef: 'r1', text: 'edits', required: true }], at: 1 })
      const current = store.work.change(change.id)!
      mkdirSync(join(home, 'artifacts', 'evidence'), { recursive: true })
      writeFileSync(join(home, 'artifacts', 'evidence', 'run-1.md'), body)
      const recorded = await service.recordWorkVerification(change.id, [
        { requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['run:run-1'], note: 'long report' },
      ], [], { inputRef: current.currentInputRef, inputRevision: current.currentRevision })
      if (!('id' in recorded)) throw new Error(recorded.message)
      const view = service.workBoard(change.id)
      if (!view) throw new Error('missing projection')
      const read = (request: WorkReadRequest) => {
        const result = service.readWorkSource(request.id, request.kind, request.ref, {
          verificationId: request.verificationId, inputRef: request.inputRef, inputRevision: request.inputRevision,
        }, { forceFull: request.forceFull === true })
        if (!result.ok) throw new Error(result.message)
        return Promise.resolve({ source: result.source, body: result.body, truncated: result.truncated, totalBytes: result.totalBytes })
      }
      const root = createRoot(document.getElementById('root')!)
      await act(async () => { root.render(<WorkBoard locale="en" items={[view]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={read} />); await Promise.resolve(); await Promise.resolve() })
      await openDetails()
      const preview = document.querySelector('[data-evidence-body="evidence:run:run-1"]')?.textContent ?? ''
      expect(preview).not.toContain(tail)
      expect(preview.length).toBeLessThan(70_000)
      expect(preview).toContain('[truncated]')
      await act(async () => { buttonIncluding('View full content')?.click(); await Promise.resolve(); await Promise.resolve() })
      const shown = document.querySelector('[data-evidence-body="evidence:run:run-1"]')?.textContent ?? ''
      expect(shown.endsWith(tail)).toBe(true)
      expect(buttonIncluding('View full content')).toBeUndefined()
      await act(async () => root.unmount())
    } finally {
      rmSync(project, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not mistake UTF-8 byte counts for a truncated short Chinese source', async () => {
    const body = '验收通过，证据完整。'
    const row: WorkBoardItem = {
      ...item,
      verification: {
        id: 'v-3', verdict: 'accept', subjectKey: 'subject-key-long', inputRef: 'in-4', inputRevision: 4,
        checks: [{ requirementRef: 'r1', verdict: 'pass', evidenceRefs: ['log-1'] }],
      },
    }
    const onRead = async () => ({ source: 'evidence:log-1', body, truncated: false, totalBytes: Buffer.byteLength(body) })
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<WorkBoard locale="zh" items={[row]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve(); await Promise.resolve() })
    await openDetails()
    expect(document.querySelector('[data-evidence-body="evidence:log-1"]')?.textContent).toBe(body)
    expect(buttonIncluding('查看全文')).toBeUndefined()
    await act(async () => root.unmount())
  })

  it('keeps a 64KiB preview when the server reports truncated false and expands the unmarked full body', async () => {
    const tail = 'END_MARK_64'
    const body = longBody('HEAD64_', tail)
    const checks = [{ requirementRef: 'r1', verdict: 'pass', evidenceRefs: ['log-1'] }]
    const row: WorkBoardItem = {
      ...item,
      verification: { id: 'v-3', verdict: 'accept', subjectKey: 'subject-key-long', inputRef: 'in-4', inputRevision: 4, checks },
    }
    const calls: boolean[] = []
    const onRead = (request: WorkReadRequest) => {
      calls.push(request.forceFull === true)
      if (request.forceFull === true) return Promise.resolve({ source: 'evidence:log-1', body })
      return Promise.resolve({ source: 'evidence:log-1', body, truncated: false, totalBytes: body.length })
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<WorkBoard locale="en" items={[row]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve(); await Promise.resolve() })
    await openDetails()
    const preview = document.querySelector('[data-evidence-body="evidence:log-1"]')?.textContent ?? ''
    expect(preview.startsWith('HEAD64_')).toBe(true)
    expect(preview).not.toContain(tail)
    expect(preview).toContain('[truncated]')
    expect(calls).toEqual([false])
    await act(async () => { buttonIncluding('View full content')?.click(); await Promise.resolve() })
    const shown = document.querySelector('[data-evidence-body="evidence:log-1"]')?.textContent ?? ''
    expect(shown).toContain(tail)
    expect(shown).not.toContain('[truncated]')
    expect(calls).toEqual([false, true])
    await act(async () => root.unmount())
  })

  it('retries a failed preview without reloading the board', async () => {
    const row: WorkBoardItem = {
      ...item,
      verification: {
        id: 'v-3', verdict: 'accept', subjectKey: 'subject-key-long', inputRef: 'in-4', inputRevision: 4,
        checks: [{ requirementRef: 'r1', verdict: 'pass', evidenceRefs: ['log-1'] }],
      },
    }
    let attempts = 0
    const onRead = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('preview temporarily unavailable')
      return { source: 'evidence:log-1', body: 'PREVIEW_RECOVERED', truncated: false }
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<WorkBoard locale="en" items={[row]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve(); await Promise.resolve() })
    await openDetails()
    expect(document.body.textContent).toContain('preview temporarily unavailable')
    await act(async () => { buttonIncluding('Retry')?.click(); await Promise.resolve() })
    expect(attempts).toBe(2)
    expect(document.querySelector('[data-evidence-body="evidence:log-1"]')?.textContent).toBe('PREVIEW_RECOVERED')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('keeps the preview when a full read fails and shows the tail after retry', async () => {
    const tail = 'RETRY_TAIL'
    const body = longBody('KEEP_PREVIEW_', tail)
    const checks = [{ requirementRef: 'r1', verdict: 'pass', evidenceRefs: ['log-1'] }]
    const row: WorkBoardItem = {
      ...item,
      verification: { id: 'v-3', verdict: 'accept', subjectKey: 'subject-key-long', inputRef: 'in-4', inputRevision: 4, checks },
    }
    let fail = true
    let fullCalls = 0
    const onRead = (request: WorkReadRequest) => {
      if (request.forceFull !== true) return Promise.resolve({ source: 'evidence:log-1', body, truncated: false, totalBytes: body.length })
      fullCalls += 1
      if (fail) return Promise.reject(new Error('read broke'))
      return Promise.resolve({ source: 'evidence:log-1', body })
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<WorkBoard locale="en" items={[row]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve(); await Promise.resolve() })
    await openDetails()
    expect(document.body.textContent).toContain('KEEP_PREVIEW_')
    expect(document.body.textContent).not.toContain(tail)
    await act(async () => { buttonIncluding('View full content')?.click(); await Promise.resolve() })
    expect(document.body.textContent).toContain('KEEP_PREVIEW_')
    expect(document.body.textContent).not.toContain(tail)
    expect(document.body.textContent).toContain('Could not be read: read broke')
    expect(fullCalls).toBe(1)
    fail = false
    await act(async () => { buttonIncluding('Retry')?.click(); await Promise.resolve() })
    expect(document.body.textContent).toContain(tail)
    expect(fullCalls).toBe(2)
    await act(async () => root.unmount())
  })

  it('does not send a second full read while one is in flight', async () => {
    const tail = 'LATE_TAIL'
    const body = longBody('HEAD_KEEP_', tail)
    const checks = [{ requirementRef: 'r1', verdict: 'pass', evidenceRefs: ['log-1'] }]
    const row: WorkBoardItem = {
      ...item,
      verification: { id: 'v-3', verdict: 'accept', subjectKey: 'subject-key-long', inputRef: 'in-4', inputRevision: 4, checks },
    }
    let fullCalls = 0
    let release: (value: { source: string; body: string }) => void = () => undefined
    const onRead = (request: WorkReadRequest) => {
      if (request.forceFull !== true) return Promise.resolve({ source: 'evidence:log-1', body, truncated: false, totalBytes: body.length })
      fullCalls += 1
      return new Promise<{ source: string; body: string }>(resolve => { release = resolve })
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<WorkBoard locale="en" items={[row]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve(); await Promise.resolve() })
    await openDetails()
    await act(async () => {
      const open = buttonIncluding('View full content')
      open?.click()
      open?.click()
    })
    expect(fullCalls).toBe(1)
    const busy = buttonIncluding('Loading') as HTMLButtonElement | undefined
    expect(busy?.disabled).toBe(true)
    expect(document.body.textContent).toContain('HEAD_KEEP_')
    expect(document.body.textContent).not.toContain(tail)
    await act(async () => { busy?.click() })
    expect(fullCalls).toBe(1)
    await act(async () => { release({ source: 'evidence:log-1', body }); await Promise.resolve() })
    expect(document.body.textContent).toContain(tail)
    expect(fullCalls).toBe(1)
    await act(async () => root.unmount())
  })

  it('does not apply a pending full read after the input version changes', async () => {
    const filler = 'd'.repeat(70_000)
    const checks = [{ requirementRef: 'r1', verdict: 'pass', evidenceRefs: ['log-1'] }]
    const first: WorkBoardItem = {
      ...item, revision: 1, inputRef: 'in-1', title: 'Version 1',
      verification: { id: 'v-old', verdict: 'accept', subjectKey: 'subject-old', inputRef: 'in-1', inputRevision: 1, checks },
    }
    const second: WorkBoardItem = {
      ...first, revision: 2, inputRef: 'in-2', title: 'Version 2',
      verification: { id: 'v-new', verdict: 'accept', subjectKey: 'subject-new', inputRef: 'in-2', inputRevision: 2, checks },
    }
    let resolveFull: ((value: { source: string; body: string }) => void) | undefined
    const onRead = (request: WorkReadRequest) => {
      if (request.forceFull === true) return new Promise<{ source: string; body: string }>(resolve => { resolveFull = resolve })
      const head = request.verificationId === 'v-old' ? 'OLD_PREVIEW_HEAD' : 'NEW_PREVIEW_HEAD'
      return Promise.resolve({ source: 'evidence:log-1', body: `${head}${filler}`, truncated: false, totalBytes: head.length + filler.length })
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<WorkBoard locale="en" items={[first]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve(); await Promise.resolve() })
    await openDetails()
    expect(document.body.textContent).toContain('OLD_PREVIEW_HEAD')
    await act(async () => { buttonIncluding('View full content')?.click() })
    expect(buttonIncluding('Loading')).toBeTruthy()
    await act(async () => { root.render(<WorkBoard locale="en" items={[second]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve(); await Promise.resolve() })
    await openDetails()
    expect(document.body.textContent).toContain('Version 2')
    expect(document.body.textContent).toContain('NEW_PREVIEW_HEAD')
    expect(document.body.textContent).not.toContain('OLD_PREVIEW_HEAD')
    expect(document.body.textContent).not.toContain('OLD_FULL_BODY_MARK')
    await act(async () => { resolveFull?.({ source: 'evidence:log-1', body: `OLD_FULL_BODY_MARK${filler}` }); await Promise.resolve() })
    expect(document.body.textContent).not.toContain('OLD_FULL_BODY_MARK')
    expect(document.body.textContent).toContain('NEW_PREVIEW_HEAD')
    await act(async () => root.unmount())
  })

  it('shows localized exclusion reasons inside the current details', async () => {
    const detailed: WorkBoardItem = {
      ...item,
      verification: {
        id: 'v-3', verdict: 'accept', subjectKey: 'subject-key-long', inputRef: 'in-4', inputRevision: 4,
        checks: [{ requirementRef: 'goal', verdict: 'pass', evidenceRefs: [] }],
        exclusions: [
          { path: 'node_modules', reason: 'ignored directory' },
          { path: 'tmp/skip.log', reason: 'ignored file' },
          { path: 'src/vendor', reason: 'symlink:D:/outside/vendor' },
          { path: 'src/bare-link', reason: 'symlink' },
        ],
      },
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<WorkBoard locale="zh" items={[detailed]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} />))
    const details = document.querySelector('details')?.textContent ?? ''
    expect(details).toContain('详情')
    expect(details).toContain('未纳入快照')
    expect(details).toContain('node_modules')
    expect(details).toContain('忽略的目录')
    expect(details).toContain('tmp/skip.log')
    expect(details).toContain('忽略的文件')
    expect(details).toContain('src/vendor')
    expect(details).toContain('符号链接 → D:/outside/vendor')
    expect(details).toContain('src/bare-link')
    expect(details).toContain('符号链接)')
    expect(details).not.toContain('ignored directory')
    expect(details).not.toContain('ignored file')
    expect(details).not.toContain('symlink')
    await act(async () => root.unmount())
  })

  it('reads nothing while details are closed, then every listed source without an 8-item cap once opened', async () => {
    const refs = Array.from({ length: 9 }, (_, index) => `log-${index}`)
    const calls: string[] = []
    const onRead = (request: WorkReadRequest) => {
      calls.push(`${request.kind}:${request.ref}:${request.forceFull === true}`)
      return Promise.resolve({ source: request.ref, body: `BODY_${request.ref}` })
    }
    const row: WorkBoardItem = {
      ...item,
      verification: {
        id: 'v-3', verdict: 'accept', subjectKey: 'subject-key-long', inputRef: 'in-4', inputRevision: 4,
        checks: [{ requirementRef: 'goal', verdict: 'pass', evidenceRefs: refs }],
      },
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<WorkBoard locale="en" items={[row]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve(); await Promise.resolve() })
    expect(calls).toEqual([])
    await openDetails()
    expect(calls).toEqual(refs.map(ref => `evidence:${ref}:false`))
    for (const ref of refs) expect(document.body.textContent).toContain(`BODY_${ref}`)
    // Closing and reopening keeps what was read instead of asking again.
    await act(async () => { const node = document.querySelector<HTMLDetailsElement>('details')!; node.open = false; node.dispatchEvent(new dom.window.Event('toggle')) })
    await openDetails()
    expect(calls).toHaveLength(refs.length)
    await act(async () => root.unmount())
  })

  it('collects an optional reject note, jumps to the bound run session, and auto-folds secondary changed files', async () => {
    const onReject = vi.fn()
    const onOpenSession = vi.fn()
    const multi: WorkBoardItem = {
      ...item,
      runs: [{ id: 'run-2', kind: 'review', phase: 'settling', cwd: 'H:/repo', sessionId: 'sess-review-2' }],
      verification: {
        id: 'v-3', verdict: 'accept', subjectKey: 'subject-key-long', inputRef: 'in-4', inputRevision: 4,
        changes: [
          { path: 'src/first.ts', kind: 'modified' },
          { path: 'src/second.ts', kind: 'added' },
        ],
      },
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => {
      root.render(
        <WorkBoard
          locale="zh"
          items={[multi]}
          pending={[]}
          onAccept={vi.fn()}
          onReject={onReject}
          onAnswer={vi.fn()}
          onResume={vi.fn()}
          onOpenSession={onOpenSession}
          onRead={req => Promise.resolve({ source: req.ref, body: `FILE_${req.ref}` })}
        />,
      )
    })

    await act(async () => { buttonIncluding('打开会话')?.click() })
    expect(onOpenSession).toHaveBeenCalledWith('sess-review-2')

    await click('退回')
    const input = document.querySelector<HTMLInputElement>('.dsh-dot-work-reject-input input, input.dsh-dot-work-reject-input')!
    // react-dom is initialized before this spec stubs the JSDOM globals, so its
    // input/change listener support is off; drive the controlled field through
    // React's own event path instead of a raw DOM event.
    await act(async () => {
      Simulate.change(input, { target: { value: '请补充边界单测' } } as never)
    })
    await click('确认退回')
    expect(onReject).toHaveBeenCalledWith({
      id: 'c-1', reviewRunId: 'run-2', expectedInputRevision: 4, note: '请补充边界单测',
    })

    await openDetails()
    const bodies = [...document.querySelectorAll<HTMLElement>('.dsh-dot-work-source-body')]
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.hasAttribute('data-collapsed')).toBe(false)
    expect(bodies[1]!.hasAttribute('data-collapsed')).toBe(true)
    await click('全部展开')
    expect(bodies[1]!.hasAttribute('data-collapsed')).toBe(false)

    await act(async () => root.unmount())
  })

  it('opens a folded changed file on the first click while its preview is still pending', async () => {
    const pending: Array<(error: Error) => void> = []
    const onRead = (request: WorkReadRequest) => {
      if (request.ref !== 'src/second.ts') return Promise.resolve({ source: request.ref, body: `FILE_${request.ref}` })
      return new Promise<never>((_resolve, reject) => { pending.push(reject) })
    }
    const multi: WorkBoardItem = {
      ...item,
      verification: {
        id: 'v-3', verdict: 'accept', subjectKey: 'subject-key-long', inputRef: 'in-4', inputRevision: 4,
        changes: [
          { path: 'src/first.ts', kind: 'modified' },
          { path: 'src/second.ts', kind: 'added' },
        ],
      },
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => {
      root.render(<WorkBoard locale="zh" items={[multi]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />)
    })
    await openDetails()
    const head = document.querySelector<HTMLAnchorElement>('a[data-change-path="src/second.ts"]')!
    const body = head.parentElement!.querySelector<HTMLElement>('.dsh-dot-work-source-body')!
    expect(body.hasAttribute('data-collapsed')).toBe(true)
    expect(pending.length).toBeGreaterThan(0)
    await act(async () => { head.click() })
    expect(body.hasAttribute('data-collapsed')).toBe(false)
    await act(async () => {
      for (const reject of [...pending]) reject(new Error('preview unavailable'))
      await Promise.resolve()
    })
    expect(body.hasAttribute('data-collapsed')).toBe(false)
    expect(body.textContent).toContain('读取失败')
    expect(body.textContent).toContain('preview unavailable')
    await act(async () => root.unmount())
  })
})
