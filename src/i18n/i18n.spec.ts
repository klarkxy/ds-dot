import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Timer } from '../batcher.ts'
import type { RawEvent } from '../chat.ts'
import { DEFAULT_SETTINGS, type DotContextView, type DotSettings, type ScheduleTiming } from '../contracts.ts'
import type { DotHost, SessionRow, WorkspaceRow } from '../host.ts'
import { ADDRESS_MAX_CHARS, PERSONA_MAX_CHARS, defaultAddress, defaultPersona, personaSection } from '../persona.ts'
import { patchSettings } from '../settings.ts'
import { PersonaPanel, type KnowledgeApi } from '../persona-panel.tsx'
import { DotService } from '../service.ts'
import type { SettingsApi, SettingsPatch } from '../settings-panel.tsx'
import { DotStore, type DotDomainHandle } from '../store.ts'
import { timingLabel } from '../ui-copy.ts'
import {
  SUPPORTED_LOCALES,
  approvalCardCopy,
  cardCopy,
  configI18n,
  copyLocale,
  intlLocale,
  localePack,
  personaPack,
  t,
  type CopyLocale,
} from './index.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const BANNED_PERSONA_TERMS = /姐姐|妹妹|鲸鱼娘|大肥鱼|粉色虎鲸|粉毛小狗|大小姐|sister|At work|Off duty|the human/i
/** Default voice must not license hesitation. A saved custom persona is a different string and is not rewritten. */
const DITHERING: Record<CopyLocale, RegExp> = {
  zh: /呆萌|迷糊/,
  en: /scatterbrained/i,
  ja: /おっちょこちょい/,
  de: /verträumt/,
  es: /despistad/,
  fr: /étourdi/,
  pt: /distraíd/,
  ru: /рассеянн/,
}
/** The speaking-style rule every locale keeps: lead with the outcome, nothing about decision formats. */
const LEAD_WITH_OUTCOME: Record<CopyLocale, string> = {
  zh: '聊正事时先给结论',
  en: 'lead with the outcome',
  ja: 'まず結果を伝えます',
  de: 'zuerst das Ergebnis',
  es: 've al grano: el resultado',
  fr: 'le résultat d’abord',
  pt: 'comece pelo resultado',
  ru: 'сразу называй итог',
}
const SILENCE: Record<CopyLocale, string> = {
  zh: '不把沉默当成同意',
  en: 'never treat silence as consent',
  ja: '沈黙を同意とはみなしません',
  de: 'Schweigen nie als Zustimmung',
  es: 'nunca tomas el silencio como permiso',
  fr: 'ne prends jamais le silence pour un accord',
  pt: 'nunca trata o silêncio como permissão',
  ru: 'не принимай молчание за согласие',
}
const QUESTION_POLICY: Record<CopyLocale, { readonly label: string; readonly help: string }> = {
  zh: { label: '可逆的自己定', help: '缺授权，或不可逆、外部、费用后果' },
  en: { label: 'She decides', help: 'Missing authority, or an irreversible, external, or costly effect' },
  ja: { label: '彼女が決める', help: 'ドロシーが目標内の可逆な既定を決めます' },
  de: { label: 'Sie entscheidet', help: 'Fehlende Befugnis oder eine unumkehrbare, externe oder teure Folge' },
  es: { label: 'Ella decide', help: 'Si falta autorización, o el efecto es irreversible, externo o costoso' },
  fr: { label: 'Elle décide', help: 'Sans autorisation, ou si l’effet est irréversible, externe ou coûteux' },
  pt: { label: 'Ela decide', help: 'Sem autorização, ou se o efeito for irreversível, externo ou custoso' },
  ru: { label: 'Она решает', help: 'Нет разрешения, или эффект необратим, внешний или платный' },
}

const human = (text: string, time: number): RawEvent => ({
  type: 'user/message',
  time,
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
})

const reply = (text: string, time: number): RawEvent => ({
  type: 'assistant/message',
  time,
  data: { message: { content: [{ type: 'text', text }] } },
})

function extractPlaceholders(text: string): string[] {
  return [...text.matchAll(/\{[a-zA-Z0-9_]+\}/g)].map(match => match[0]).sort()
}

function flattenLeaves(obj: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[path] = value
    else if (value && typeof value === 'object') Object.assign(out, flattenLeaves(value, path))
  }
  return out
}

function extractRelativeMarkdownTargets(markdown: string): string[] {
  const stripped = markdown.replace(/`[^`\n]+`/g, '')
  const targets: string[] = []
  for (const match of stripped.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = match[1] ?? ''
    if (!raw || raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('mailto:') || raw.startsWith('#')) continue
    const clean = raw.split('#')[0]?.split('?')[0] ?? ''
    if (clean) targets.push(clean)
  }
  return targets
}

function makeFakeDomain(seed: Record<string, Record<string, unknown>> = {}) {
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
  }
  const domain: DotDomainHandle = {
    table: name => ({
      entries: () => tables[name]!.entries(),
      get: key => tables[name]!.get(key),
      put: async (key, value) => { tables[name]!.set(key, value) },
      delete: async key => tables[name]!.delete(key),
      update: async (key, recipe) => {
        const rows = tables[name]!
        if (!rows.has(key)) throw Object.assign(new Error(`missing key ${key}`), { code: 'missing-key' })
        const next = recipe(rows.get(key))
        rows.set(key, next)
        return next
      },
    }),
    close: async () => {},
  }
  return { domain, tables }
}

function makeFakeHost() {
  const workspaces: WorkspaceRow[] = []
  const dots = new Set<string>()
  const events = new Map<string, RawEvent[]>()
  const said: Array<{ sessionId: string; text: string }> = []
  let sessions = 0
  const context: DotContextView = { live: false, compactions: 0 }
  const host: DotHost = {
    listWorkspaces: () => [...workspaces],
    async createWorkspace(path, title) {
      const found = workspaces.find(row => row.path === path)
      if (found) return found
      const row = { id: `w${workspaces.length + 1}`, path, title: title ?? path, sessionCount: 0 }
      workspaces.push(row)
      return row
    },
    async listSessions(): Promise<SessionRow[]> { return [] },
    async titles() { return new Map() },
    async createSession(place) { return place.sessionId ?? `s${++sessions}` },
    async listPresets() { return { fallback: 'standard', presets: [{ id: 'standard' }, { id: 'dot' }] } },
    async listModels() { return { fallback: { provider: 'p', model: 'base' }, models: [{ provider: 'p', model: 'base', name: 'Base' }] } },
    async selectModel() {},
    async setPermission() { return true },
    async prompt() {},
    async relay() {},
    async cancel() {},
    async archive() {},
    async latestReply() { return undefined },
    async cwdOf() { return undefined },
    async createDot() {
      const id = `dot${++sessions}`
      dots.add(id)
      return id
    },
    async createInternal() { return `int${++sessions}` },
    async promptInternal() {},
    async waitIdle() {},
    async releaseInternal() {},
    async resumeDot(sessionId) { return dots.has(sessionId) },
    async releaseDot() {},
    async readEvents(sessionId) { return events.get(sessionId) ?? [] },
    async summarize() { return 'HANDOFF NOTE' },
    async ping() {},
    dotModel: () => undefined,
    sessionModel: () => undefined,
    modelKey: () => undefined,
    async say(sessionId, text) { said.push({ sessionId, text }) },
    async stop() {},
    async stopActivity() {
      return { cancelAccepted: true, queueCleared: true, idle: true, jobsSettled: true as const }
    },
    syncModel() {},
    dotEvents: () => [],
    dotContext: async () => context,
    dotTrajectory: () => ({ turns: [], earlier: 0 }),
    isRunning: () => false,
    async dispose() {},
  }
  return { host, events, said }
}

function makeManualTimer(): Timer {
  return {
    set: () => 0,
    clear: () => {},
    now: () => 1000,
  }
}

function createServiceHarness(options?: { seed?: Record<string, Record<string, unknown>>; locale?: CopyLocale; homeDir?: string }) {
  const { domain, tables } = makeFakeDomain(options?.seed)
  const store = new DotStore(domain)
  const fake = makeFakeHost()
  const homeDir = options?.homeDir ?? mkdtempSync(join(tmpdir(), 'dot-i18n-'))
  const service = new DotService({
    host: fake.host,
    store,
    homeDir,
    notes: { path: '/dot/memory.md', read: async () => '', readCognition: async () => '' },
    approvalGraceMs: 0,
    timer: makeManualTimer(),
    now: () => 1000,
    ...(options?.locale ? { locale: options.locale } : {}),
  })
  return { domain, tables, store, ...fake, homeDir, service }
}

function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value
  const propsKey = Object.keys(element).find(key => key.startsWith('__reactProps'))
  const props = propsKey ? (element as unknown as Record<string, { onChange?: (event: { target: HTMLElement }) => void }>)[propsKey] : undefined
  props?.onChange?.({ target: element })
}

describe('i18n locale resolution and pack completeness', () => {
  it('resolves all 8 supported locales, regional tags, and unknown fallbacks cleanly', () => {
    for (const loc of SUPPORTED_LOCALES) {
      expect(copyLocale(loc)).toBe(loc)
      expect(copyLocale(loc.toUpperCase())).toBe(loc)
    }
    const regional: Array<[string | undefined, CopyLocale]> = [
      ['zh-CN', 'zh'],
      ['zh-TW', 'zh'],
      ['zh_HK', 'zh'],
      ['en-US', 'en'],
      ['en_GB', 'en'],
      ['ja-JP', 'ja'],
      ['ja_JP', 'ja'],
      ['de-DE', 'de'],
      ['de-AT', 'de'],
      ['es-ES', 'es'],
      ['es-419', 'es'],
      ['fr-FR', 'fr'],
      ['fr-CA', 'fr'],
      ['pt-BR', 'pt'],
      ['pt-PT', 'pt'],
      ['ru-RU', 'ru'],
      ['ru_RU', 'ru'],
      ['ko-KR', 'en'],
      ['it-IT', 'en'],
      ['', 'en'],
      ['   ', 'en'],
      [undefined, 'en'],
    ]
    for (const [input, expected] of regional) {
      expect(copyLocale(input)).toBe(expected)
    }
    expect(copyLocale('ko-KR', 'zh')).toBe('zh')

    const expectedIntl: Record<CopyLocale, string> = {
      zh: 'zh-CN',
      en: 'en-US',
      ja: 'ja-JP',
      de: 'de-DE',
      es: 'es-ES',
      fr: 'fr-FR',
      pt: 'pt-BR',
      ru: 'ru-RU',
    }
    for (const loc of SUPPORTED_LOCALES) {
      expect(intlLocale(loc)).toBe(expectedIntl[loc])
    }
  })

  it('has identical keys, non-empty strings, and matching {placeholder} tokens across all 8 TypeScript packs', () => {
    const ref = localePack('en')
    const refSections = {
      ui: Object.keys(ref.ui).sort(),
      card: Object.keys(ref.card).sort(),
      config: Object.keys(ref.config).sort(),
      approvalCard: Object.keys(ref.approvalCard).sort(),
      persona: Object.keys(ref.persona).sort(),
    }
    const i18nConfig = configI18n()
    expect(Object.keys(i18nConfig).sort()).toEqual([...SUPPORTED_LOCALES].sort())

    for (const loc of SUPPORTED_LOCALES) {
      const pack = localePack(loc)
      expect(pack.intl).toBe(intlLocale(loc))
      expect(Object.keys(pack.ui).sort()).toEqual(refSections.ui)
      expect(Object.keys(pack.card).sort()).toEqual(refSections.card)
      expect(Object.keys(pack.config).sort()).toEqual(refSections.config)
      expect(Object.keys(pack.approvalCard).sort()).toEqual(refSections.approvalCard)
      expect(Object.keys(pack.persona).sort()).toEqual(refSections.persona)

      expect(cardCopy(loc)).toEqual(pack.card)
      expect(approvalCardCopy(loc)).toEqual(pack.approvalCard)
      expect(personaPack(loc)).toEqual(pack.persona)
      expect(i18nConfig[loc]).toEqual(pack.config)

      for (const [sectionName, sectionObj, refObj] of [
        ['ui', pack.ui, ref.ui],
        ['card', pack.card, ref.card],
        ['config', pack.config, ref.config],
        ['approvalCard', pack.approvalCard, ref.approvalCard],
        ['persona', pack.persona, ref.persona],
      ] as const) {
        for (const key of Object.keys(refObj)) {
          const val = (sectionObj as Record<string, string>)[key]
          const refVal = (refObj as Record<string, string>)[key]
          expect(typeof val, `${loc}.${sectionName}.${key}`).toBe('string')
          expect(val.trim().length, `${loc}.${sectionName}.${key} non-empty`).toBeGreaterThan(0)
          expect(extractPlaceholders(val), `${loc}.${sectionName}.${key} placeholders`).toEqual(extractPlaceholders(refVal))
        }
      }
    }
  })

  it('has matching keys and {n}/{max} placeholders across all 8 locale/*.json files and valid meta.detail', () => {
    const jsons = Object.fromEntries(
      SUPPORTED_LOCALES.map(loc => [loc, JSON.parse(readFileSync(join(REPO_ROOT, 'locale', `${loc}.json`), 'utf8')) as Record<string, unknown>]),
    ) as Record<CopyLocale, Record<string, unknown>>

    const enLeaves = flattenLeaves(jsons.en)
    const refKeys = Object.keys(enLeaves).filter(k => k !== 'meta.detail').sort()

    for (const loc of SUPPORTED_LOCALES) {
      const leaves = flattenLeaves(jsons[loc])
      if (loc === 'zh' || loc === 'ja') {
        expect(leaves['meta.detail']).toBeTruthy()
      } else {
        expect(leaves['meta.detail']).toBeUndefined()
      }
      const keys = Object.keys(leaves).filter(k => k !== 'meta.detail').sort()
      expect(keys, `locale/${loc}.json keys`).toEqual(refKeys)
      for (const key of refKeys) {
        const val = leaves[key]!
        expect(val.trim().length, `locale/${loc}.json ${key} non-empty`).toBeGreaterThan(0)
        expect(extractPlaceholders(val), `locale/${loc}.json ${key} placeholders`).toEqual(extractPlaceholders(enLeaves[key]!))
      }
    }
  })

  it('provides 7 weekday names and renders every ScheduleTiming form across all 8 locales', () => {
    const once: ScheduleTiming = { kind: 'once', at: Date.UTC(2026, 0, 15, 14, 30) }
    const everyMins: ScheduleTiming = { kind: 'every', minutes: 15, anchor: 0 }
    const everyHours: ScheduleTiming = { kind: 'every', minutes: 120, anchor: 0 }
    const dailyAll: ScheduleTiming = { kind: 'daily', time: '09:00' }
    const dailyWeekdays: ScheduleTiming = { kind: 'daily', time: '09:00', weekdays: [1, 3, 5] }

    for (const loc of SUPPORTED_LOCALES) {
      const days = t(loc, 'reminderDayNames').split('|').map(d => d.trim()).filter(Boolean)
      expect(days, `${loc} weekday count`).toHaveLength(7)

      for (const timing of [once, everyMins, everyHours, dailyAll, dailyWeekdays]) {
        const rendered = timingLabel(loc, timing)
        expect(rendered.trim().length, `${loc} ${timing.kind}`).toBeGreaterThan(0)
        expect(extractPlaceholders(rendered), `${loc} ${timing.kind} leftover placeholders`).toEqual([])
      }
      expect(timingLabel(loc, everyMins)).toContain('15')
      expect(timingLabel(loc, everyHours)).toContain('2')
      expect(timingLabel(loc, dailyAll)).toContain('09:00')
      const withDays = timingLabel(loc, dailyWeekdays)
      expect(withDays).toContain('09:00')
      expect(withDays).toContain(days[0]!)
      expect(withDays).toContain(days[2]!)
      expect(withDays).toContain(days[4]!)
    }
  })

  it('validates package.json files, meta.detail targets, and all relative Markdown links across README docs', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { files: string[] }
    expect(pkg.files).toContain('locale/*.json')
    expect(pkg.files).toContain('README.md')
    expect(pkg.files).toContain('docs/README.zh-CN.md')
    expect(pkg.files).toContain('docs/README.ja.md')
    expect(pkg.files).toContain('docs/images/dot-arrival.png')

    for (const loc of ['zh', 'ja'] as const) {
      const json = JSON.parse(readFileSync(join(REPO_ROOT, 'locale', `${loc}.json`), 'utf8')) as { meta?: { detail?: string } }
      const detail = json.meta?.detail
      expect(detail).toBeTruthy()
      expect(detail!.endsWith('.md')).toBe(true)
      expect(existsSync(join(REPO_ROOT, detail!))).toBe(true)
      expect(pkg.files).toContain(detail!)
    }

    const docs = ['README.md', 'docs/README.zh-CN.md', 'docs/README.ja.md']
    for (const rel of docs) {
      const abs = join(REPO_ROOT, rel)
      expect(existsSync(abs)).toBe(true)
      const text = readFileSync(abs, 'utf8')
      const targets = extractRelativeMarkdownTargets(text)
      expect(targets.length, `${rel} relative links`).toBeGreaterThan(0)
      for (const target of targets) {
        const resolved = resolve(dirname(abs), target)
        expect(existsSync(resolved), `${rel} -> ${target} exists`).toBe(true)
      }
    }

    expect(extractRelativeMarkdownTargets(readFileSync(join(REPO_ROOT, 'README.md'), 'utf8'))).toEqual(
      expect.arrayContaining(['docs/README.zh-CN.md', 'docs/README.ja.md', 'docs/images/dot-arrival.png']),
    )
    expect(extractRelativeMarkdownTargets(readFileSync(join(REPO_ROOT, 'docs/README.zh-CN.md'), 'utf8'))).toEqual(
      expect.arrayContaining(['../README.md', 'README.ja.md', 'images/dot-arrival.png']),
    )
    expect(extractRelativeMarkdownTargets(readFileSync(join(REPO_ROOT, 'docs/README.ja.md'), 'utf8'))).toEqual(
      expect.arrayContaining(['../README.md', 'README.zh-CN.md', 'images/dot-arrival.png']),
    )
  })

  it('keeps persona invariants, length limits, 4-part structure, and personaSection formatting across all 8 locales', () => {
    for (const loc of SUPPORTED_LOCALES) {
      const addr = defaultAddress(loc)
      const pers = defaultPersona(loc)
      const pack = personaPack(loc)

      expect(addr.length).toBeGreaterThan(0)
      expect(addr.length).toBeLessThanOrEqual(ADDRESS_MAX_CHARS)
      expect(pers.length).toBeGreaterThan(0)
      expect(pers.length).toBeLessThanOrEqual(1200)
      expect(pers.length).toBeLessThanOrEqual(PERSONA_MAX_CHARS)
      expect(pers.split(/\n\s*\n/).filter(Boolean), `${loc} 4-section persona`).toHaveLength(4)
      expect(pers, `${loc} banned terms`).not.toMatch(BANNED_PERSONA_TERMS)
      expect(pers, `${loc} dithering`).not.toMatch(DITHERING[loc])
      // String presence only. This does not run a model and is not evidence of live behavior.
      expect(pers, `${loc} lead-with-outcome`).toContain(LEAD_WITH_OUTCOME[loc])
      expect(pers, `${loc} silence is not consent`).toContain(SILENCE[loc])
      expect(t(loc, 'sQuestions_dot'), `${loc} questions label`).toBe(QUESTION_POLICY[loc].label)
      expect(t(loc, 'sQuestionsDesc_dot'), `${loc} questions help`).toContain(QUESTION_POLICY[loc].help)
      expect(t(loc, 'sQuestionsDesc_dot'), `${loc} old scope question`).not.toMatch(/scope or direction|方向或范围|範囲や方針|Umfang oder Richtung|alcance o el rumbo|portée ou l’orientation|escopo ou a direção|границы или направление/)
      expect(t(loc, 'sQuestionsDesc_dot'), `${loc} exclusive guess`).not.toMatch(/只有猜错|only when a wrong guess|ときだけ|nur, wenn ein Fehlgriff|solo si un error|seulement si une erreur|só se um erro|только если ошибка/)
      if (loc === 'ja') {
        expect(t(loc, 'sQuestions_dot')).not.toContain('自分で')
        expect(t(loc, 'sQuestionsDesc_dot')).not.toContain('自分で')
      }
      expect(t(loc, 'sApprovalsDesc_dot'), `${loc} approvals not a blanket gate`).not.toMatch(/spending or credentials|付费或涉及凭据|課金・認証情報|Ausgaben oder Zugangsdaten|gastos o credenciales|dépenses ou identifiants|gastos ou credenciais|расходы или учётные данные/)
      const kept = patchSettings({ ...DEFAULT_SETTINGS, persona: 'Custom voice kept', address: 'Kept name' }, { approvals: 'human' }, loc)
      expect(kept.persona, `${loc} custom persona survives another setting`).toBe('Custom voice kept')
      expect(kept.address, `${loc} custom address survives another setting`).toBe('Kept name')
      const restored = patchSettings(kept, { persona: defaultPersona(loc), address: defaultAddress(loc) }, loc)
      expect(restored.persona, `${loc} restoring the default text clears storage`).toBeUndefined()
      expect(restored.address, `${loc} restoring the default address clears storage`).toBeUndefined()

      const defaultBuilt = personaSection({}, loc)
      expect(defaultBuilt.startsWith(pack.sectionLead)).toBe(true)
      expect(defaultBuilt).toContain(pers)
      expect(defaultBuilt).toContain(pack.addressDefault.replace('{address}', addr))
      expect(extractPlaceholders(defaultBuilt)).toEqual([])

      const customBuilt = personaSection({ persona: 'Custom voice', address: 'Alice' }, loc)
      expect(customBuilt.startsWith(pack.sectionLead)).toBe(true)
      expect(customBuilt).toContain('Custom voice')
      expect(customBuilt).not.toContain(pers)
      expect(customBuilt).toContain(pack.addressCustom.replace('{address}', 'Alice'))
      expect(extractPlaceholders(customBuilt)).toEqual([])
    }
  })

  it("keeps $$, $&, $', and $` literal inside a custom address", () => {
    const addresses = ['$$', '$&', "$'", '$`', "O$'Brien", 'Sam$$', 'A$&B', 'pre$`post', '$1']
    for (const loc of SUPPORTED_LOCALES) {
      const pack = personaPack(loc)
      const defaultLine = personaSection({}, loc).split('\n').at(-1)
      expect(defaultLine, `${loc} default address`).toBe(pack.addressDefault.split('{address}').join(defaultAddress(loc)))

      for (const address of addresses) {
        const built = personaSection({ persona: 'Custom voice', address: `  ${address}  ` }, loc)
        const line = built.split('\n').at(-1)
        expect(line, `${loc} custom address ${address}`).toBe(pack.addressCustom.split('{address}').join(address))
        expect(line).toContain(address)
        expect(built.startsWith(pack.sectionLead)).toBe(true)
        expect(built).toContain('Custom voice')
        expect(extractPlaceholders(line ?? '')).toEqual([])
      }
    }
  })
})

describe('i18n end-to-end lifecycle and PersonaPanel integration', () => {
  const tempDirs: string[] = []
  let dom: JSDOM
  let createRoot: typeof import('react-dom/client').createRoot

  const makeTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'dot-i18n-'))
    tempDirs.push(dir)
    return dir
  }

  beforeAll(async () => {
    dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('navigator', dom.window.navigator)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    createRoot = (await import('react-dom/client')).createRoot
  })

  afterEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
  })

  afterAll(() => {
    vi.unstubAllGlobals()
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  })

  it('scenario 1: fresh install syncLocale(ja) before ensureDot freezes Japanese persona and persists uiLocale without polluting settings', async () => {
    const h = createServiceHarness({ homeDir: makeTempDir() })
    try {
      await h.service.syncLocale('ja')
      expect(h.service.locale).toBe('ja')
      expect(h.store.uiLocale).toBe('ja')
      expect('uiLocale' in h.store.settings).toBe(false)
      expect(h.store.settings.scope).toBe(DEFAULT_SETTINGS.scope)

      await h.service.ensureDot()
      expect(h.store.segment?.persona).toBe(personaSection(h.store.settings, 'ja'))
      expect(h.store.segment?.persona).toContain(defaultPersona('ja'))

      const reloaded = new DotStore(h.domain)
      expect(reloaded.uiLocale).toBe('ja')
      expect('uiLocale' in reloaded.settings).toBe(false)
    } finally {
      await h.service.dispose()
    }
  })

  it('scenario 2: untouched (before first reply) segment initialized in zh refreezes in place to ja on syncLocale(ja)', async () => {
    const h = createServiceHarness({ locale: 'zh', homeDir: makeTempDir() })
    try {
      const dot = await h.service.ensureDot()
      expect(h.store.segment?.sessionId).toBe(dot)
      expect(h.events.get(dot) ?? []).toHaveLength(0)
      expect(h.store.segment?.persona).toContain(defaultPersona('zh'))

      await h.service.syncLocale('ja')
      expect(h.store.dotSessionId).toBe(dot)
      expect(h.store.pastSegments).toHaveLength(0)
      expect(h.store.segment?.persona).toBe(personaSection(h.store.settings, 'ja'))
      expect(h.store.segment?.persona).toContain(defaultPersona('ja'))
    } finally {
      await h.service.dispose()
    }
  })

  it('scenario 3: replied segment rolls over default persona on language change and preserves custom persona & address', async () => {
    const h = createServiceHarness({ locale: 'zh', homeDir: makeTempDir() })
    try {
      const dot1 = await h.service.ensureDot()
      h.events.set(dot1, [human('hi', 10), reply('hello', 20)])

      await h.service.syncLocale('de')
      expect(h.store.dotSessionId).toBe(dot1)
      expect(h.store.segment?.persona).toContain(defaultPersona('zh'))

      await h.service.say('hello')
      const dot2 = h.store.dotSessionId!
      expect(dot2).not.toBe(dot1)
      expect(h.store.segment?.reason).toBe('prompt-changed')
      expect(h.store.segment?.persona).toBe(personaSection(h.store.settings, 'de'))
      expect(h.store.segment?.persona).toContain(defaultPersona('de'))
      expect(h.store.segment?.persona).toContain(defaultAddress('de'))

      await h.store.setSettings({ ...h.store.settings, persona: 'Custom voice', address: 'Chef' })
      await h.service.settingsChanged()
      const dot3 = h.store.dotSessionId!
      expect(dot3).toBe(dot2)

      h.events.set(dot3, [human('second', 30), reply('ack', 40)])
      await h.service.syncLocale('de-AT')
      await h.service.say('follow up')
      expect(h.store.dotSessionId).toBe(dot3)
      expect(h.store.segment?.persona).toContain('Custom voice')
      expect(h.store.segment?.persona).toContain('Chef')
      expect(h.store.segment?.persona).not.toContain(defaultPersona('de'))

      // Switching to another language still preserves custom persona and address without replacing them with defaults.
      await h.service.syncLocale('fr')
      await h.service.say('bonjour')
      const dot4 = h.store.dotSessionId!
      expect(h.store.segment?.persona).toContain('Custom voice')
      expect(h.store.segment?.persona).toContain('Chef')
      expect(h.store.segment?.persona).not.toContain(defaultPersona('fr'))
      expect(h.store.segment?.persona).not.toContain(defaultAddress('fr'))
      expect(dot4).not.toBe(dot3)
    } finally {
      await h.service.dispose()
    }
  })

  it('scenario 4: confirmFactoryReset preserves active uiLocale so the post-reset segment starts in ja', async () => {
    const h = createServiceHarness({ homeDir: makeTempDir() })
    try {
      await h.service.syncLocale('ja')
      await h.service.ensureDot()
      await h.store.setSettings({ ...h.store.settings, persona: 'Temp override' })

      const { token } = h.service.previewFactoryReset()
      await h.service.confirmFactoryReset(token)

      expect(h.store.uiLocale).toBe('ja')
      expect(h.service.locale).toBe('ja')
      expect(h.store.settings.persona).toBeUndefined()
      expect(h.store.segment?.persona).toBe(personaSection(h.store.settings, 'ja'))
      expect(h.store.segment?.persona).toContain(defaultPersona('ja'))
    } finally {
      await h.service.dispose()
    }
  })

  it('scenario 5: PersonaPanel keeps a custom persona across address restore, then restores the default, for all 8 locales', async () => {
    for (const loc of SUPPORTED_LOCALES) {
      let current: DotSettings = { ...DEFAULT_SETTINGS }
      const knowledge = {
        agreements: { text: '', maxChars: 4000, canUndo: false },
        cognition: { text: '', maxChars: 4000, history: [] },
      }

      function Harness() {
        const [settings, setSettings] = useState<DotSettings>(current)
        const api: SettingsApi & KnowledgeApi = {
          setSettings: async (patch: SettingsPatch) => {
            current = {
              ...current,
              ...(patch.persona === null ? { persona: undefined } : patch.persona !== undefined ? { persona: patch.persona } : {}),
              ...(patch.address === null ? { address: undefined } : patch.address !== undefined ? { address: patch.address } : {}),
            }
            setSettings(current)
            return current
          },
          models: async () => ({ groups: [] }),
          settingProposals: async () => [],
          decideSetting: async () => '',
          settings: async () => current,
          knowledge: async () => knowledge,
          setAgreements: async () => knowledge,
          undoAgreements: async () => knowledge,
          setCognition: async () => knowledge,
          restoreCognition: async () => knowledge,
        }
        return createElement(PersonaPanel, { locale: loc, api, settings, onSaved: setSettings })
      }

      const root = createRoot(document.getElementById('root')!)
      await act(async () => { root.render(createElement(Harness)) })
      await act(async () => { await Promise.resolve() })

      const addressInput = [...document.querySelectorAll('input')].find(el => el.getAttribute('aria-label') === t(loc, 'pAddress'))!
      const personaInput = [...document.querySelectorAll('textarea')].find(el => el.getAttribute('aria-label') === t(loc, 'pPersona'))!
      expect(addressInput.getAttribute('placeholder')).toBe(defaultAddress(loc))
      expect(addressInput.value).toBe(defaultAddress(loc))
      expect(personaInput.value).toBe(defaultPersona(loc))

      await act(async () => { changeValue(addressInput, 'Alice') })
      const addrPropsKey = Object.keys(addressInput).find(key => key.startsWith('__reactProps'))
      const addrProps = addrPropsKey ? (addressInput as unknown as Record<string, { onBlur?: () => void }>)[addrPropsKey] : undefined
      await act(async () => { addrProps?.onBlur?.() })
      await act(async () => { changeValue(personaInput, 'Custom voice') })
      const saveBtn = [...document.querySelectorAll('button')].find(btn => btn.textContent === t(loc, 'pSave'))!
      await act(async () => { saveBtn.click() })
      expect(current.address).toBe('Alice')
      expect(current.persona).toBe('Custom voice')
      expect(personaInput.value).toBe('Custom voice')
      expect(personaInput.value).not.toContain(LEAD_WITH_OUTCOME[loc])

      const restoreButtons = () => [...document.querySelectorAll('button')].filter(btn => btn.textContent === t(loc, 'pRestore'))
      expect(restoreButtons()).toHaveLength(2)

      await act(async () => { restoreButtons()[0]!.click() })
      expect(current.address).toBeUndefined()
      expect(addressInput.value).toBe(defaultAddress(loc))
      expect(current.persona, `${loc} address restore leaves the custom persona`).toBe('Custom voice')
      expect(personaInput.value, `${loc} textarea still shows the custom persona`).toBe('Custom voice')

      await act(async () => { restoreButtons()[1]!.click() })
      expect(current.persona).toBeUndefined()
      expect(personaInput.value).toBe(defaultPersona(loc))
      expect(personaInput.value).toContain(LEAD_WITH_OUTCOME[loc])
      expect(personaInput.value).toContain(SILENCE[loc])

      await act(async () => { root.unmount() })
    }
  })
})
