import { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DotContextView, WatchdogAnnotation, WatchdogDiagnosticsView, WatchdogHitRecord } from './contracts.ts'
import { ContextPanel, contextCss, type ContextApi } from './context-panel.tsx'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('navigator', dom.window.navigator)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => { createRoot = (await import('react-dom/client')).createRoot })
afterEach(() => { document.body.innerHTML = '<div id="root"></div>' })

function makeHit(overrides: Partial<WatchdogHitRecord> = {}): WatchdogHitRecord {
  return {
    id: 'hit-1',
    at: Date.UTC(2026, 10, 26, 12, 0),
    runId: 'run-42',
    changeId: 'chg-7',
    inputRef: 'issue#12',
    inputRevision: 2,
    sessionId: 'sess-9',
    signal: 'repeat-tool-call',
    runPhase: 'active',
    mode: 'auto',
    evidence: ['tool=read_file called 4x with identical args'],
    ...overrides,
  }
}

function makeWatchdogView(overrides: Partial<WatchdogDiagnosticsView> = {}): WatchdogDiagnosticsView {
  return {
    mode: 'observe',
    watchdogStops: 0,
    calibration: {
      windowDays: 14,
      total14d: 0,
      reviewed14d: 0,
      accurate14d: 0,
      falsePositive14d: 0,
      falsePositiveRate: null,
    },
    hits: [],
    ...overrides,
  }
}

describe('ContextPanel Watchdog Diagnostics', () => {
  it('renders Watchdog Diagnostics even when view.live is false (!live regression)', async () => {
    const view: DotContextView = {
      live: false,
      compactions: 0,
      watchdog: makeWatchdogView({
        mode: 'observe',
        watchdogStops: 2,
        calibration: {
          windowDays: 14,
          total14d: 3,
          reviewed14d: 0,
          accurate14d: 0,
          falsePositive14d: 0,
          falsePositiveRate: null,
        },
        hits: [],
      }),
    }
    const api: ContextApi = {
      context: async () => view,
      newSegment: async () => 'dot-2',
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<ContextPanel locale="en" api={api} />))
    await act(async () => { await Promise.resolve() })

    expect(document.querySelector('.dsh-ui-empty')?.textContent).toContain('first message')
    const section = document.querySelector('section.dsh-dot-wd')
    expect(section).not.toBeNull()
    expect(section?.querySelector('.dsh-dot-wd-mode')?.textContent).toBe('Observe')
    expect(section?.querySelector('[data-watchdog-stops="2"]')?.textContent).toContain('2')
    expect(section?.querySelector('[data-stat="total"] dd')?.textContent).toBe('3')
    expect(section?.querySelector('[data-stat="fp-rate"] dd')?.textContent).toBe('No reviews yet')
    expect(section?.querySelector('.dsh-dot-wd-empty')?.textContent).toContain('No Watchdog signal hits recorded yet')

    // In Chinese locale, shows 暂无复核 rather than 0%.
    await act(async () => root.render(<ContextPanel locale="zh" api={api} />))
    expect(document.querySelector('[data-stat="fp-rate"] dd')?.textContent).toBe('暂无复核')
    await act(async () => root.unmount())
  })

  it('loads Watchdog Diagnostics via watchdogDiagnostics fallback when view.watchdog is omitted', async () => {
    const watchdog = makeWatchdogView({ mode: 'auto', configuredModel: 'deepseek/chat', watchdogStops: 1 })
    const api: ContextApi = {
      context: async () => ({ live: false, compactions: 0 }),
      newSegment: async () => 'dot-2',
      watchdogDiagnostics: async () => watchdog,
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<ContextPanel locale="en" api={api} />))
    await act(async () => { await Promise.resolve() })

    expect(document.querySelector('section.dsh-dot-wd')).not.toBeNull()
    expect(document.body.textContent).toContain('deepseek/chat')
    expect(document.querySelector('[data-watchdog-stops="1"]')?.textContent).toContain('1')
    await act(async () => root.unmount())
  })

  it('renders modelFallbackNotice banner, hit details, judge verdict, and annotates accurate / false-positive', async () => {
    const hits: WatchdogHitRecord[] = [
      makeHit({
        id: 'hit-1',
        signal: 'repeat-tool-error',
        hardLimitReached: true,
        stopped: true,
        judge: {
          verdict: 'spinning',
          confidence: 'high',
          summary: 'Same test failure repeated 8 times.',
          evidence: ['exit 1 on vitest'],
        },
        evidence: ['error=ENOENT', 'consecutive=8'],
      }),
      makeHit({
        id: 'hit-2',
        signal: 'silent-stall',
        mode: 'observe',
        runId: 'run-43',
        evidence: ['no events for 11m'],
        annotation: 'accurate',
        annotatedAt: 1000,
      }),
    ]
    let currentWd: WatchdogDiagnosticsView = makeWatchdogView({
      mode: 'auto',
      configuredModel: 'missing/model-x',
      watchdogStops: 1,
      modelFallbackNotice: {
        configuredModel: 'missing/model-x',
        reason: 'not-in-catalog',
        detail: 'Model not listed in host catalog',
        at: 500,
      },
      calibration: {
        windowDays: 14,
        total14d: 2,
        reviewed14d: 1,
        accurate14d: 1,
        falsePositive14d: 0,
        falsePositiveRate: 0,
      },
      hits,
    })
    const calls: Array<{ id: string; annotation: WatchdogAnnotation }> = []
    const api: ContextApi = {
      context: async () => ({
        live: true,
        provider: 'deepseek',
        model: 'chat',
        contextWindow: 128_000,
        usedTokens: 12_000,
        compactions: 1,
        watchdog: currentWd,
      }),
      newSegment: async () => 'dot-2',
      annotateWatchdog: async (id, annotation) => {
        calls.push({ id, annotation })
        const nextHits = currentWd.hits.map(h => h.id === id ? { ...h, annotation, annotatedAt: 2000 } : h)
        const reviewed14d = nextHits.filter(h => h.annotation !== undefined).length
        const accurate14d = nextHits.filter(h => h.annotation === 'accurate').length
        const falsePositive14d = nextHits.filter(h => h.annotation === 'false-positive').length
        currentWd = {
          ...currentWd,
          hits: nextHits,
          calibration: {
            windowDays: 14,
            total14d: nextHits.length,
            reviewed14d,
            accurate14d,
            falsePositive14d,
            falsePositiveRate: reviewed14d > 0 ? falsePositive14d / reviewed14d : null,
          },
        }
        return currentWd
      },
    }

    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<ContextPanel locale="zh" api={api} />))
    await act(async () => { await Promise.resolve() })

    const fallback = document.querySelector('.dsh-dot-wd-fallback[role="alert"]')
    expect(fallback).not.toBeNull()
    expect(fallback?.textContent).toContain('missing/model-x')
    expect(fallback?.textContent).toContain('不在宿主模型目录中')
    expect(fallback?.textContent).toContain('Model not listed in host catalog')

    const row1 = document.querySelector<HTMLElement>('.dsh-dot-wd-hit[data-hit-id="hit-1"]')!
    expect(row1.textContent).toContain('连续相同工具报错')
    expect(row1.textContent).toContain('硬上限 ≥8')
    expect(row1.textContent).toContain('已自动停止')
    expect(row1.textContent).toContain('Same test failure repeated 8 times.')
    expect(row1.textContent).toContain('error=ENOENT')
    expect(row1.textContent).toContain('Run run-42 · active · chg-7 · r2')

    const fpBtn1 = row1.querySelector<HTMLButtonElement>('button[data-annotation="false-positive"]')!
    const accBtn1 = row1.querySelector<HTMLButtonElement>('button[data-annotation="accurate"]')!
    expect(fpBtn1.textContent).toBe('误报')
    expect(accBtn1.textContent).toBe('判断正确')
    expect(fpBtn1.getAttribute('aria-pressed')).toBe('false')

    await act(async () => { fpBtn1.click() })
    await act(async () => { await Promise.resolve() })
    expect(calls).toEqual([{ id: 'hit-1', annotation: 'false-positive' }])
    expect(document.querySelector('[data-hit-id="hit-1"] button[data-annotation="false-positive"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-stat="reviewed"] dd')?.textContent).toBe('2')
    expect(document.querySelector('[data-stat="accurate"] dd')?.textContent).toBe('1')
    expect(document.querySelector('[data-stat="false-positive"] dd')?.textContent).toBe('1')
    expect(document.querySelector('[data-stat="fp-rate"] dd')?.textContent).toBe('50%')

    await act(async () => root.unmount())
  })

  it('surfaces inline error when annotateWatchdog rejects and preserves .dsh-dot-chat CSS scope', async () => {
    const view: DotContextView = {
      live: false,
      compactions: 0,
      watchdog: makeWatchdogView({
        hits: [makeHit({ id: 'hit-err' })],
      }),
    }
    const api: ContextApi = {
      context: async () => view,
      newSegment: async () => 'dot-2',
      annotateWatchdog: async () => { throw new Error('disk full') },
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<ContextPanel locale="en" api={api} />))
    await act(async () => { await Promise.resolve() })

    const accBtn = document.querySelector<HTMLButtonElement>('[data-hit-id="hit-err"] button[data-annotation="accurate"]')!
    await act(async () => { accBtn.click() })
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.dsh-dot-wd-hits .dsh-ui-error[role="alert"]')?.textContent).toContain('disk full')
    await act(async () => root.unmount())

    const stripped = contextCss.replace(/\/\*[\s\S]*?\*\//g, '')
    const collectSelectors = (css: string): string[] => {
      const out: string[] = []
      let i = 0
      while (i < css.length) {
        while (i < css.length && /\s/.test(css[i]!)) i += 1
        if (i >= css.length) break
        const brace = css.indexOf('{', i)
        if (brace < 0) break
        const prelude = css.slice(i, brace).trim()
        let depth = 1
        let j = brace + 1
        while (j < css.length && depth > 0) {
          if (css[j] === '{') depth += 1
          else if (css[j] === '}') depth -= 1
          j += 1
        }
        const body = css.slice(brace + 1, j - 1)
        if (prelude.startsWith('@media') || prelude.startsWith('@container')) {
          out.push(...collectSelectors(body))
        } else if (!prelude.startsWith('@')) {
          out.push(prelude)
        }
        i = j
      }
      return out
    }
    const splitTopLevelCommas = (list: string): string[] => {
      const parts: string[] = []
      let depth = 0
      let start = 0
      for (let i = 0; i < list.length; i += 1) {
        const ch = list[i]
        if (ch === '(' || ch === '[') depth += 1
        else if ((ch === ')' || ch === ']') && depth > 0) depth -= 1
        else if (ch === ',' && depth === 0) {
          const seg = list.slice(start, i).trim()
          if (seg) parts.push(seg)
          start = i + 1
        }
      }
      const tail = list.slice(start).trim()
      if (tail) parts.push(tail)
      return parts
    }
    const nonAtSelectors = collectSelectors(stripped)
    expect(nonAtSelectors.length).toBeGreaterThan(20)
    for (const selectorList of nonAtSelectors) {
      for (const selector of splitTopLevelCommas(selectorList)) {
        expect(selector.startsWith('.dsh-dot-chat'), selector).toBe(true)
      }
    }
  })
})
