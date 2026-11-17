import { act } from 'react'
import { mkdtempSync, rmSync } from 'node:fs'
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

describe('WorkBoard', () => {
  it('sends the versions on the projection and does not claim a withdrawn look succeeded', async () => {
    const onAccept = vi.fn()
    const onAnswer = vi.fn()
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(
      <WorkBoard locale="en" items={[item]} pending={[]} notice="The look request was withdrawn or is gone. No decision was recorded." onAccept={onAccept} onReject={vi.fn()} onAnswer={onAnswer} onResume={vi.fn()} />,
    ))
    expect(document.body.textContent).toContain('Version 4')
    expect(document.body.textContent).toContain('v-3 Acceptable')
    expect(document.body.textContent).toContain('No decision was recorded')
    expect(document.body.textContent).not.toContain('Looks good')
    await click('Accept')
    expect(onAccept).toHaveBeenCalledWith({
      id: 'c-1', verificationId: 'v-3', expectedInputRef: 'in-4', expectedInputRevision: 4, expectedSubjectKey: 'subject-key-long',
    })
    expect(onAnswer).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })

  it('reloads the projection when a pending update rerenders the panel', async () => {
    const running = {
      ...item, title: 'Version 1', revision: 1, status: 'running' as const,
      runs: [{ id: 'run-1', kind: 'work', phase: 'active', cwd: 'H:/repo' }],
      blockers: ['run-1'], verification: undefined, oversight: undefined, humanAction: undefined,
    }
    const done = { ...running, title: 'Version 2', revision: 2, status: 'done' as const, runs: [{ id: 'run-1', kind: 'work', phase: 'completed', cwd: 'H:/repo' }], blockers: [] }
    let rows: readonly WorkBoardItem[] = [running]
    let calls = 0
    const api = {
      workList: async () => { calls += 1; return rows },
      workAccept: async () => {},
      workReject: async () => {},
      workAnswer: async () => {},
      workResume: async () => {},
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(<WorkBoardPanel locale="en" api={api} pending={[]} />); await Promise.resolve() })
    expect(calls).toBe(1)
    expect(document.body.textContent).toContain('Version 1')
    expect(document.body.textContent).toContain('Running')
    rows = [done]
    await act(async () => { root.render(<WorkBoardPanel locale="en" api={api} pending={[{ id: 'p-2', kind: 'approval' }]} />); await Promise.resolve() })
    expect(calls).toBe(2)
    expect(document.body.textContent).toContain('Version 2')
    expect(document.body.textContent).toContain('Done')
    expect(document.body.textContent).not.toContain('Version 1')
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
    expect(text).toContain('施工')
    expect(text).toContain('进行中')
    expect(text).toContain('src/a.ts')
    expect(text).toContain('修改')
    expect(text).not.toContain('modified')
    expect(text).toContain('write result.txt')
    expect(text).toContain('未知')
    expect(text).toContain('log-1')
    expect(text).toContain('build failed')
    expect(text).toContain('未通过')
    expect(text).toContain('未证实')
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
      service.saveWorkEvidence('final-c-log', marker)
      service.saveWorkEvidence('old-log', 'OLD_BODY_NOT_BOUND')
      const current = store.work.change(change.id)!
      const recorded = await service.recordWorkVerification(change.id, [
        { requirementRef: 'r1', applicability: 'applicable', verdict: 'pass', evidenceRefs: ['final-c-log'], note: 'seen' },
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
      const text = document.body.textContent ?? ''
      expect(document.querySelectorAll('a[data-evidence-ref]')).toHaveLength(1)
      expect(text).toContain(marker)
      expect(text).not.toContain('OLD_BODY_NOT_BOUND')
      expect(service.readWorkSource(change.id, 'evidence', 'old-log', {
        verificationId: view.verification?.id ?? '', inputRef: view.verification?.inputRef ?? '', inputRevision: view.verification?.inputRevision ?? 0,
      })).toMatchObject({ ok: false, code: 'stale' })
      await act(async () => root.unmount())
      const failed = createRoot(document.getElementById('root')!)
      await act(async () => {
        failed.render(<WorkBoard locale="zh" items={[view]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={() => Promise.reject(new Error('evidence final-c-log is missing'))} />)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(document.body.textContent).toContain('证据不存在或是空的')
      expect(document.body.textContent).not.toContain('已完成')
      expect(document.body.textContent).not.toContain(marker)
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
    expect(calls).toEqual(['v-old:evidence:log-1', 'v-old:change:a.ts'])
    await act(async () => {
      late.splice(0).forEach(resolve => resolve({ source: 'evidence:log-1', body: 'OLD_MARKED_BODY' }))
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('OLD_MARKED_BODY')
    const seen = calls.length
    await act(async () => { root.render(<WorkBoard locale="en" items={[second]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve(); await Promise.resolve() })
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
    expect(document.body.textContent).toContain('OLD_MARKED_BODY')
    expect(document.querySelectorAll('[data-evidence-body]')).toHaveLength(2)
    hang = true
    await act(async () => { root.render(<WorkBoard locale="en" items={[bumped]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve() })
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
    expect(calls).toEqual([0, 0])
    await act(async () => { root.render(<WorkBoard locale="en" items={[bumped]} pending={[]} onAccept={vi.fn()} onReject={vi.fn()} onAnswer={vi.fn()} onResume={vi.fn()} onRead={onRead} />); await Promise.resolve() })
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
})
