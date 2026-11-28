/**
 * dot's context page in the settings view: how full her window is, what fills
 * it, where her conversation moves to a new segment, where her preset compacts
 * as a fallback, and cumulative token usage across segments. The composition
 * and usage widgets come from dsh-context v0.82.2 (Apache-2.0).
 */
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { COMPACTION_POLICY, type DotContextSections, type DotContextView, type WatchdogAnnotation, type WatchdogDiagnosticsView, type WatchdogHitRecord } from './contracts.ts'
import { makeCurrentComposition } from './context-current-composition.tsx'
import { Donut } from './context-donut.tsx'
import { IconDatabase } from './context-icons.ts'
import { SliceList } from './context-slice-list.tsx'
import { makeLegend, makeStackedBar } from './context-stacked-bar.tsx'
import { officialSurfaceParts } from './context-surface.ts'
import { SurfaceBrowser, SURFACE_CATEGORIES, SURFACE_COLORS } from './context-surface-browser.tsx'
import type { PartsPart, ViewKit } from './context-widget-types.ts'
import { formatPercent, formatTokens, formatWhen, intlLocale, t, type CopyLocale, type TextKey } from './ui-copy.ts'
import { PaneSkeleton } from './settings-panel.tsx'

const REFRESH_MS = 5_000

export interface ContextApi {
  context(signal: AbortSignal): Promise<DotContextView>
  newSegment(): Promise<string>
  clearUsage?(): Promise<DotContextView>
  watchdogDiagnostics?(signal?: AbortSignal): Promise<WatchdogDiagnosticsView>
  annotateWatchdog?(id: string, annotation: WatchdogAnnotation): Promise<WatchdogDiagnosticsView>
}

function useContext(api: ContextApi): {
  view?: DotContextView
  error?: string
  refresh: () => void
  setView: (next: DotContextView) => void
} {
  const [state, setState] = useState<{ view?: DotContextView; error?: string }>({})
  const [round, setRound] = useState(0)
  useEffect(() => {
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () => {
      api.context(lifetime.signal).then(
        view => { if (!lifetime.signal.aborted) setState({ view }) },
        failure => { if (!lifetime.signal.aborted) setState(prev => ({ ...prev, error: failure instanceof Error ? failure.message : String(failure) })) },
      ).finally(() => { if (!lifetime.signal.aborted) timer = setTimeout(run, REFRESH_MS) })
    }
    run()
    return () => { lifetime.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [api, round])
  const refresh = useCallback(() => setRound(value => value + 1), [])
  const setView = useCallback((view: DotContextView) => setState({ view }), [])
  return { ...state, refresh, setView }
}

const fill = (key: TextKey, values: Record<string, string | number>, locale: CopyLocale) =>
  Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(locale, key))

const WIDGET_KEYS: Record<string, TextKey> = {
  'overview.title': 'ctxCurrent',
  'overview.used': 'ctxUsed',
  'overview.estimate': 'ctxEstimate',
  'overview.free': 'ctxFree',
  'overview.ofUsed': 'ctxOfUsed',
  'overview.ofWindow': 'ctxOfWindow',
  'overview.reserveHeadroom': 'ctxCompactHeadroom',
  'overview.reserveHeadroomTip': 'ctxCompactHeadroomTip',
  'overview.reserveHeadroomBuffer': 'ctxCompactHeadroomBuffer',
  'overview.reserveOutput': 'ctxOutputReserve',
  'overview.reserveOutputTip': 'ctxOutputReserveTip',
  'overview.reserveTrigger': 'ctxCompactTrigger',
  'overview.reserveTriggerTip': 'ctxCompactTriggerTip',
}

function useWidgetKit(locale: CopyLocale): ViewKit {
  return useMemo(() => ({
    t: (key, params) => fill(WIDGET_KEYS[key] ?? 'ctxUsed', params ?? {}, locale),
    fmt: formatTokens,
    fmtShare: (value, total) => total > 0 ? formatPercent(value / total) : '0%',
    catLabel: key => {
      const labels: Record<string, TextKey> = {
        system: 'ctxSystem', tools: 'ctxTools', messages: 'ctxMessages', free: 'ctxFree',
        user: 'ctxUserMessages', inject: 'ctxInjections', skill: 'ctxSkillInjections', assistant: 'ctxAssistantMessages', tool: 'ctxToolResults',
        input: 'ctxInput', cacheRead: 'ctxCacheRead', cacheWrite: 'ctxCacheWrite', output: 'ctxOutput',
      }
      return t(locale, labels[key] ?? 'ctxMessages')
    },
  }), [locale])
}

/** Keep dsh-context's raw estimates while anchoring the bar to measured occupancy. */
function anchoredParts(parts: PartsPart[], target: number | null): PartsPart[] {
  const sourced = parts.map(p => ({ ...p, raw: p.raw ?? p.value }))
  if (target === null || target <= 0) return sourced
  let total = 0
  for (const p of sourced) total += p.raw
  if (total <= 0) return sourced
  if (total === target) return sourced.map(p => ({ ...p, value: p.raw }))
  const scale = target / total
  return sourced.map(p => ({ ...p, value: Math.round(p.raw * scale) }))
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="dsh-dot-ctx-fact"><dt>{label}</dt><dd>{value}</dd></div>
}

/** The prompt blocks this segment actually carries: persona, agreements, cognition and the handoff. */
function PromptSections({ locale, sections }: { locale: CopyLocale; sections: DotContextSections }) {
  const rows: readonly { key: TextKey; text: string }[] = [
    { key: 'ctxSectionPersona', text: sections.persona },
    { key: 'ctxSectionAgreements', text: sections.agreements },
    { key: 'ctxSectionCognition', text: sections.cognition },
    { key: 'ctxSectionHandoff', text: sections.handoff },
  ]
  return (
    <section className="dsh-dot-ctx-section" aria-label={t(locale, 'ctxPromptSections')}>
      <div className="lc-card-title">
        <span className="lc-card-title-text">{t(locale, 'ctxPromptSections')}</span>
        <span className="lc-card-rate">{t(locale, 'ctxPromptSectionsHint')}</span>
      </div>
      <dl className="dsh-dot-ctx-sections">
        {rows.map(row => (
          <div className="dsh-dot-ctx-section-row" key={row.key}>
            <dt>{t(locale, row.key)}</dt>
            <dd>
              {row.text.trim()
                ? <pre className="dsh-dot-ctx-section-text">{row.text}</pre>
                : <span className="dsh-ui-hint">{t(locale, 'ctxSectionEmpty')}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function WatchdogDiagnosticsSection({ locale, watchdog, canAnnotate, savingId, error, onAnnotate }: {
  locale: CopyLocale
  watchdog: WatchdogDiagnosticsView
  canAnnotate: boolean
  savingId?: string
  error?: string
  onAnnotate: (id: string, annotation: WatchdogAnnotation) => void
}) {
  const cal = watchdog.calibration
  const fallback = watchdog.modelFallbackNotice
  const modeTone = watchdog.mode === 'auto' ? 'info' : watchdog.mode === 'observe' ? 'outline' : 'quiet'
  return (
    <section className="dsh-dot-ctx-section dsh-dot-wd" aria-label={t(locale, 'ctxWatchdogTitle')}>
      <div className="lc-card-title dsh-dot-wd-head">
        <span className="lc-card-title-text">{t(locale, 'ctxWatchdogTitle')}</span>
        <div className="dsh-dot-wd-badges">
          <span className="dsh-dot-wd-mode" data-mode={watchdog.mode}>
            <Tag tone={modeTone}>{t(locale, `ctxWatchdogMode_${watchdog.mode}`)}</Tag>
          </span>
          <span className="dsh-dot-wd-stops" data-watchdog-stops={watchdog.watchdogStops}>
            <Tag tone={watchdog.watchdogStops > 0 ? 'warning' : 'neutral'}>
              {t(locale, 'ctxWatchdogStops')}: {fill('ctxWatchdogStopsCount', { n: watchdog.watchdogStops }, locale)}
            </Tag>
          </span>
        </div>
      </div>

      <dl className="dsh-dot-ctx-facts dsh-dot-wd-meta">
        <Fact label={t(locale, 'ctxWatchdogModeLabel')} value={t(locale, `ctxWatchdogMode_${watchdog.mode}`)} />
        <Fact label={t(locale, 'ctxWatchdogModelLabel')} value={watchdog.configuredModel ?? t(locale, 'ctxWatchdogModelDefault')} />
      </dl>

      {fallback ? (
        <div className="dsh-dot-wd-fallback" role="alert">
          <div className="dsh-dot-wd-fallback-title">{t(locale, 'ctxWatchdogFallbackTitle')}</div>
          <div className="dsh-dot-wd-fallback-body">
            {fill('ctxWatchdogFallbackBody', {
              model: fallback.configuredModel,
              reason: t(locale, `ctxWatchdogFallbackReason_${fallback.reason}` as TextKey),
            }, locale)}
          </div>
          {fallback.detail ? <div className="dsh-dot-wd-fallback-detail">{fallback.detail}</div> : null}
        </div>
      ) : null}

      <div className="dsh-dot-wd-calibration">
        <div className="dsh-dot-wd-subhead">
          <span>{fill('ctxWatchdogCalTitle', { days: cal.windowDays }, locale)}</span>
          <span className="dsh-dot-wd-target">{t(locale, 'ctxWatchdogCalTargetHint')}</span>
        </div>
        <dl className="dsh-dot-wd-stats">
          <div className="dsh-dot-wd-stat" data-stat="total"><dt>{t(locale, 'ctxWatchdogCalTotal')}</dt><dd>{cal.total14d}</dd></div>
          <div className="dsh-dot-wd-stat" data-stat="reviewed"><dt>{t(locale, 'ctxWatchdogCalReviewed')}</dt><dd>{cal.reviewed14d}</dd></div>
          <div className="dsh-dot-wd-stat" data-stat="accurate"><dt>{t(locale, 'ctxWatchdogCalAccurate')}</dt><dd>{cal.accurate14d}</dd></div>
          <div className="dsh-dot-wd-stat" data-stat="false-positive"><dt>{t(locale, 'ctxWatchdogCalFalsePositive')}</dt><dd>{cal.falsePositive14d}</dd></div>
          <div className="dsh-dot-wd-stat" data-stat="fp-rate">
            <dt>{t(locale, 'ctxWatchdogCalFpRate')}</dt>
            <dd>{cal.falsePositiveRate === null ? t(locale, 'ctxWatchdogCalNoReviews') : formatPercent(cal.falsePositiveRate)}</dd>
          </div>
        </dl>
      </div>

      <div className="dsh-dot-wd-hits">
        <div className="dsh-dot-wd-subhead">
          <span>{t(locale, 'ctxWatchdogHitsTitle')}</span>
        </div>
        {error ? <div className="dsh-ui-error dsh-dot-ctx-inline-error" role="alert">{t(locale, 'ctxWatchdogAnnotateFailed')}{error}</div> : null}
        {watchdog.hits.length === 0 ? (
          <div className="dsh-ui-hint dsh-dot-wd-empty">{t(locale, 'ctxWatchdogHitsEmpty')}</div>
        ) : (
          <ul className="dsh-dot-wd-hit-list">
            {watchdog.hits.map((hit: WatchdogHitRecord) => {
              const saving = savingId === hit.id
              const accurateActive = hit.annotation === 'accurate'
              const fpActive = hit.annotation === 'false-positive'
              return (
                <li key={hit.id} className="dsh-dot-wd-hit" data-hit-id={hit.id} data-signal={hit.signal}>
                  <div className="dsh-dot-wd-hit-head">
                    <span className="dsh-dot-wd-hit-signal">{t(locale, `ctxWatchdogSignal_${hit.signal}` as TextKey)}</span>
                    <Tag tone="quiet">{hit.mode}</Tag>
                    {hit.hardLimitReached ? <Tag tone="danger">{t(locale, 'ctxWatchdogHardLimitBadge')}</Tag> : null}
                    {hit.stopped ? <Tag tone="warning">{t(locale, 'ctxWatchdogStoppedBadge')}</Tag> : null}
                    <span className="dsh-dot-wd-hit-time">{formatWhen(hit.at)}</span>
                  </div>
                  <div className="dsh-dot-wd-hit-meta">
                    {fill('ctxWatchdogRunMeta', {
                      runId: hit.runId,
                      phase: hit.runPhase,
                      changeId: hit.changeId,
                      rev: hit.inputRevision,
                    }, locale)}
                  </div>
                  {hit.judge ? (
                    <div className="dsh-dot-wd-hit-judge">
                      <Tag tone={hit.judge.verdict === 'progressing' ? 'success' : 'warning'}>
                        {fill('ctxWatchdogJudgeBadge', {
                          verdict: t(locale, `ctxWatchdogVerdict_${hit.judge.verdict}` as TextKey),
                          confidence: t(locale, `ctxWatchdogConfidence_${hit.judge.confidence}` as TextKey),
                        }, locale)}
                      </Tag>
                      <span className="dsh-dot-wd-hit-judge-summary">{hit.judge.summary}</span>
                    </div>
                  ) : null}
                  {hit.evidence.length > 0 ? (
                    <ul className="dsh-dot-wd-evidence">
                      {hit.evidence.map((line, index) => <li key={index}>{line}</li>)}
                    </ul>
                  ) : null}
                  <div className="dsh-dot-wd-hit-actions">
                    <Button
                      variant={accurateActive ? 'primary' : 'outline'}
                      size="sm"
                      className={accurateActive ? 'dsh-dot-wd-btn dsh-dot-wd-btn--active' : 'dsh-dot-wd-btn'}
                      aria-pressed={accurateActive}
                      data-annotation="accurate"
                      disabled={saving || !canAnnotate}
                      onClick={() => onAnnotate(hit.id, 'accurate')}
                    >
                      {t(locale, 'ctxWatchdogAnnotateAccurate')}
                    </Button>
                    <Button
                      variant={fpActive ? 'primary' : 'outline'}
                      size="sm"
                      className={fpActive ? 'dsh-dot-wd-btn dsh-dot-wd-btn--active' : 'dsh-dot-wd-btn'}
                      aria-pressed={fpActive}
                      data-annotation="false-positive"
                      disabled={saving || !canAnnotate}
                      onClick={() => onAnnotate(hit.id, 'false-positive')}
                    >
                      {t(locale, 'ctxWatchdogAnnotateFalsePositive')}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}

export function ContextPanel({ locale, api, running = false }: { locale: CopyLocale; api: ContextApi; running?: boolean }) {
  const { view, error, refresh, setView } = useContext(api)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [usageHoverKey, setUsageHoverKey] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const [moveStatus, setMoveStatus] = useState<{ ok: boolean; text: string }>()
  const [clearingUsage, setClearingUsage] = useState(false)
  const [clearError, setClearError] = useState<string>()
  const [watchdogFallback, setWatchdogFallback] = useState<WatchdogDiagnosticsView>()
  const [annotatingId, setAnnotatingId] = useState<string>()
  const [annotateError, setAnnotateError] = useState<string>()
  useEffect(() => {
    if (!api.watchdogDiagnostics || view?.watchdog !== undefined) return
    const life = new AbortController()
    api.watchdogDiagnostics(life.signal).then(
      next => { if (!life.signal.aborted) setWatchdogFallback(next) },
      () => {},
    )
    return () => life.abort()
  }, [api, view?.watchdog])
  const watchdog = view?.watchdog ?? watchdogFallback
  const annotateWatchdog = useCallback((id: string, annotation: WatchdogAnnotation) => {
    if (!api.annotateWatchdog) return
    setAnnotatingId(id)
    setAnnotateError(undefined)
    api.annotateWatchdog(id, annotation).then(
      next => {
        setWatchdogFallback(next)
        if (view) setView({ ...view, watchdog: next })
      },
      failure => setAnnotateError(failure instanceof Error ? failure.message : String(failure)),
    ).finally(() => setAnnotatingId(undefined))
  }, [api, setView, view])
  const startSegment = () => {
    setMoving(true)
    setMoveStatus(undefined)
    api.newSegment().then(
      () => {
        setMoveStatus({ ok: true, text: t(locale, 'ctxNewSegmentDone') })
        refresh()
      },
      failure => setMoveStatus({ ok: false, text: failure instanceof Error ? failure.message : String(failure) }),
    ).finally(() => setMoving(false))
  }
  const resetUsage = () => {
    if (!api.clearUsage) return
    setClearingUsage(true)
    setClearError(undefined)
    api.clearUsage().then(
      next => setView(next),
      failure => setClearError(failure instanceof Error ? failure.message : String(failure)),
    ).finally(() => setClearingUsage(false))
  }
  const kit = useWidgetKit(locale)
  const CurrentComposition = useMemo(() => {
    const StackedBar = makeStackedBar(kit)
    const Legend = makeLegend(kit)
    return makeCurrentComposition(kit, StackedBar, Legend)
  }, [kit])

  if (!view) {
    return error
      ? <div className="dsh-ui-error" role="alert">{t(locale, 'ctxFailed')}{error}</div>
      : <PaneSkeleton label={t(locale, 'ctxLoading')} rows={3} />
  }
  if (!view.live) {
    return watchdog ? (
      <div className="dsh-dot-pane dsh-dot-context">
        <div className="dsh-ui-empty">{t(locale, 'ctxIdle')}</div>
        <WatchdogDiagnosticsSection
          locale={locale}
          watchdog={watchdog}
          canAnnotate={typeof api.annotateWatchdog === 'function'}
          {...annotatingId !== undefined ? { savingId: annotatingId } : {}}
          {...annotateError !== undefined ? { error: annotateError } : {}}
          onAnnotate={annotateWatchdog}
        />
      </div>
    ) : <div className="dsh-ui-empty">{t(locale, 'ctxIdle')}</div>
  }

  const { contextWindow: windowSize, usedTokens: used, compactAt, rolloverAt, breakdown } = view
  const detailed = view.surface ? officialSurfaceParts(view.surface.parts, breakdown) : undefined
  const rawParts: PartsPart[] = detailed ? SURFACE_CATEGORIES.map(key => ({ key, color: SURFACE_COLORS[key], value: detailed[key] })) : breakdown ? [
    { key: 'system', color: 'var(--dsw-alias-brand-primary)', value: breakdown.system },
    { key: 'tools', color: 'var(--dsw-alias-state-warn-primary)', value: breakdown.tools },
    { key: 'messages', color: 'var(--dsw-alias-state-business-primary)', value: breakdown.messages },
  ] : used !== undefined ? [
    { key: 'messages', color: 'var(--dsw-alias-state-business-primary)', value: used },
  ] : []
  const estimated = rawParts.reduce((sum, part) => sum + part.value, 0)
  const parts = anchoredParts(rawParts, used ?? null)
  const occupied = used ?? (estimated > 0 ? estimated : undefined)
  const occupiedTokens = occupied ?? 0
  const model = view.provider && view.model ? `${view.provider} / ${view.model}` : undefined
  const reserve = compactAt !== undefined && windowSize !== undefined ? {
    threshold: compactAt,
    headroom: COMPACTION_POLICY.headroomTokens,
    output: Math.min(view.reservedOutput ?? 0, windowSize),
  } : undefined

  const usage = view.usage
  const usageParts: PartsPart[] = usage ? [
    { key: 'input', color: 'var(--dsw-alias-brand-primary)', value: usage.input },
    { key: 'cacheRead', color: 'var(--dsw-alias-state-success-primary)', value: usage.cacheRead },
    { key: 'cacheWrite', color: 'var(--dsw-alias-state-warn-primary)', value: usage.cacheWrite },
    { key: 'output', color: 'var(--dsw-alias-state-business-primary)', value: usage.output },
  ] : []
  const total = usageParts.reduce((sum, part) => sum + part.value, 0)
  const shownUsage = total > 0 ? usageParts.filter(part => part.value > 0) : usageParts
  const prompt = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0
  const time = view.lastCompactionAt !== undefined
    ? new Date(view.lastCompactionAt).toLocaleString(intlLocale(locale), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : undefined

  return (
    <div className="dsh-dot-pane dsh-dot-context">
      <section className="dsh-dot-ctx-section" aria-label={t(locale, 'ctxSegmentTitle')}>
        <div className="dsh-dot-ctx-handoff">
          <div className="dsh-dot-ctx-handoff-copy">
            <span className="dsh-ui-label">{t(locale, 'ctxSegmentTitle')}</span>
            <p className="dsh-ui-help">{t(locale, running ? 'ctxNewSegmentBusy' : 'ctxNewSegmentHelp')}</p>
          </div>
          <Button variant="outline" size="sm" disabled={moving || running} onClick={startSegment}>{moving ? t(locale, 'ctxNewSegmentRunning') : t(locale, 'ctxNewSegment')}</Button>
        </div>
        {moveStatus ? <div className={moveStatus.ok ? 'dsh-ui-notice' : 'dsh-ui-error'} role={moveStatus.ok ? 'status' : 'alert'}>{moveStatus.text}</div> : null}
      </section>
      <section className="dsh-dot-ctx-section" aria-label={t(locale, 'ctxCurrent')}>
        <CurrentComposition
          head={{
            tokens: occupiedTokens,
            ...windowSize !== undefined ? { window: windowSize } : {},
            pct: occupied !== undefined && windowSize !== undefined && windowSize > 0 ? Math.min(100, (occupied / windowSize) * 100) : null,
            parts,
            ...reserve ? { reserve } : {},
          }}
          subtitle={model}
          hoverKey={hoverKey}
          onHoverKey={setHoverKey}
        />
        {used === undefined ? <div className="dsh-ui-hint">{t(locale, 'ctxFirstReply')}</div> : null}
      </section>

      {view.surface ? <SurfaceBrowser locale={locale} surface={view.surface} /> : null}

      {view.sections ? <PromptSections locale={locale} sections={view.sections} /> : null}

      {usage ? (
        <section className="dsh-dot-ctx-section lc-col-donut" aria-label={t(locale, 'ctxTotals')}>
          <div className="lc-card-title">
            <span className="lc-card-title-text"><IconDatabase size={14} />{t(locale, 'ctxTotals')}</span>
            <div className="dsh-dot-ctx-title-actions">
              {prompt > 0 ? <span className="lc-card-rate">{t(locale, 'ctxHitRate')} {formatPercent(usage.cacheRead / prompt)}</span> : null}
              {api.clearUsage ? (
                <Button variant="outline" size="sm" disabled={clearingUsage || total === 0} onClick={resetUsage}>
                  {clearingUsage ? t(locale, 'ctxClearUsageRunning') : t(locale, 'ctxClearUsage')}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="lc-donut-row">
            <Donut
              segments={shownUsage}
              size={96}
              centerTop={formatTokens(total)}
              centerSub={t(locale, 'ctxTotal')}
              hoverKey={usageHoverKey}
              onHoverKey={setUsageHoverKey}
            />
            <SliceList
              rows={shownUsage.map(part => ({
                key: part.key,
                color: part.color,
                label: kit.catLabel(part.key),
                pct: kit.fmtShare(part.value, total),
                count: formatTokens(part.value),
              }))}
              hoverKey={usageHoverKey}
              onHoverKey={setUsageHoverKey}
            />
          </div>
          {clearError ? <div className="dsh-ui-error dsh-dot-ctx-inline-error" role="alert">{clearError}</div> : null}
        </section>
      ) : null}

      <section className="dsh-dot-ctx-section" aria-label={t(locale, 'ctxCompactLine')}>
        <div className="lc-card-title"><span className="lc-card-title-text">{t(locale, 'ctxCompactLine')}</span></div>
        <dl className="dsh-dot-ctx-facts">
          {rolloverAt !== undefined ? (
            <Fact
              label={t(locale, 'ctxRollover')}
              value={occupied !== undefined && occupied >= rolloverAt
                ? fill('ctxRolloverDue', { n: formatTokens(rolloverAt) }, locale)
                : fill('ctxRolloverLeft', { n: formatTokens(rolloverAt), left: formatTokens(Math.max(0, rolloverAt - occupiedTokens)) }, locale)}
            />
          ) : null}
          {compactAt !== undefined ? (
            <Fact
              label={t(locale, 'ctxCompactTrigger')}
              value={occupied !== undefined && occupied >= compactAt
                ? fill('ctxCompactDue', { n: formatTokens(compactAt) }, locale)
                : fill('ctxCompactLeft', { n: formatTokens(compactAt), left: formatTokens(Math.max(0, compactAt - occupiedTokens)) }, locale)}
            />
          ) : null}
          <Fact
            label={t(locale, 'ctxCompactions')}
            value={time ? fill('ctxCompactionsLast', { n: view.compactions, time }, locale) : fill('ctxCompactionsValue', { n: view.compactions }, locale)}
          />
        </dl>
      </section>

      {watchdog ? (
        <WatchdogDiagnosticsSection
          locale={locale}
          watchdog={watchdog}
          canAnnotate={typeof api.annotateWatchdog === 'function'}
          {...annotatingId !== undefined ? { savingId: annotatingId } : {}}
          {...annotateError !== undefined ? { error: annotateError } : {}}
          onAnnotate={annotateWatchdog}
        />
      ) : null}
    </div>
  )
}

// Upstream widget CSS, scoped to dot and stripped of dsh-context's card shells.
export const contextCss = `
.dsh-dot-chat .dsh-dot-context { gap: 0; }
.dsh-dot-chat .dsh-dot-ctx-section { min-width: 0; padding: 4px 0 18px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-dot-chat .dsh-dot-ctx-section + .dsh-dot-ctx-section { padding-top: 18px; }
.dsh-dot-chat .dsh-dot-ctx-section:last-child { padding-bottom: 0; border-bottom: 0; }
.dsh-dot-chat .dsh-dot-ctx-handoff { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dsh-dot-chat .dsh-dot-ctx-handoff-copy { display: flex; flex-direction: column; gap: 2px; flex: 1 1 0; min-width: 0; }
.dsh-dot-chat .dsh-dot-ctx-handoff > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-ctx-handoff .dsh-dot-ctx-handoff-copy .dsh-ui-help { margin: 0; }
.dsh-dot-chat .dsh-dot-ctx-handoff + .dsh-ui-notice,
.dsh-dot-chat .dsh-dot-ctx-handoff + .dsh-ui-error { margin-top: 10px; }
.dsh-dot-chat .dsh-dot-ctx-inline-error { margin-top: 10px; }
.dsh-dot-chat .lc-card { min-width: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.dsh-dot-chat .lc-card-title { font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-dot-chat .lc-card-title:not(:has(.lc-gran, .lc-kinds)) { flex-wrap: nowrap; }
.dsh-dot-chat .lc-card-title-text { display: inline-flex; align-items: center; gap: 6px; flex: none; white-space: nowrap; }
.dsh-dot-chat .lc-card-title-text svg { flex: none; color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-ctx-title-actions { margin-left: auto; display: inline-flex; align-items: center; gap: 10px; flex-shrink: 0; min-width: 0; }
.dsh-dot-chat .dsh-dot-ctx-title-actions > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-chat .lc-card-sub, .dsh-dot-chat .lc-card-rate { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-dot-chat .lc-card-sub { font-weight: 400; color: var(--dsw-alias-label-secondary); font-size: 12px; margin-left: auto; }
.dsh-dot-chat .lc-card-rate { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 400; }
.dsh-dot-chat .lc-overview-num { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.dsh-dot-chat .lc-overview-num > b { font-size: 20px; }
.dsh-dot-chat .lc-overview-num span { color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .lc-overview-pct { margin-left: auto; font-size: 11px; }
.dsh-dot-chat .lc-overview-pct b { font-size: 20px; color: var(--dsw-alias-label-primary); margin-right: 4px; }
.dsh-dot-chat .lc-stacked-wrap { position: relative; width: 100%; }
.dsh-dot-chat .lc-stacked { display: flex; width: 100%; border-radius: 5px; overflow: hidden; background: var(--dsw-alias-border-l1); position: relative; }
.dsh-dot-chat .lc-occupied-box { position: absolute; top: 0; bottom: 0; left: 0; border: 2px solid var(--dsw-alias-label-tertiary); border-radius: 5px; box-sizing: border-box; pointer-events: none; opacity: 0; transition: opacity var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out); }
.dsh-dot-chat .lc-occupied-box-on { opacity: 1; }
.dsh-dot-chat .lc-tip { position: absolute; z-index: 6; width: max-content; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 6px 10px; font-size: 12px; color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-shadow-lv3, 0 2px 8px rgba(0, 0, 0, 0.18)); pointer-events: none; opacity: 0; transition: opacity var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out); }
.dsh-dot-chat .lc-bar-tip { bottom: calc(100% + 6px); transform: translateX(-50%); z-index: 5; box-sizing: border-box; max-width: min(220px, 70%); padding: 5px 8px; line-height: 1.45; display: flex; flex-direction: column; }
.dsh-dot-chat .lc-bar-tip-on { opacity: 1; }
.dsh-dot-chat .lc-bar-tip-head { font-weight: 600; }
.dsh-dot-chat .lc-bar-tip-fig { font-variant-numeric: tabular-nums; }
.dsh-dot-chat .lc-bar-tip-note { color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .lc-stacked > div { height: 100%; }
.dsh-dot-chat .lc-stacked-seg { transition: filter var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out), opacity var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out); }
.dsh-dot-chat .lc-stacked-free { box-sizing: border-box; transition: box-shadow var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out), opacity var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out); }
.dsh-dot-chat .lc-stacked-seg, .dsh-dot-chat .lc-stacked-free { transform-origin: 0 50%; }
.dsh-dot-chat .lc-stacked-seg-on { filter: brightness(1.18); }
.dsh-dot-chat .lc-reserve { position: absolute; top: 0; bottom: 0; z-index: 1; pointer-events: auto; cursor: help; }
.dsh-dot-chat .lc-reserve-headroom { background: repeating-linear-gradient(45deg, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 24%, transparent) 0 5px, transparent 5px 10px); }
.dsh-dot-chat .lc-reserve-output { background: repeating-linear-gradient(45deg, color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, transparent) 0 5px, transparent 5px 10px); }
.dsh-dot-chat .lc-trigger { position: absolute; top: 0; bottom: 0; width: 9px; transform: translateX(-50%); z-index: 1; pointer-events: auto; cursor: help; }
.dsh-dot-chat .lc-trigger::after { content: ''; position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px; background: var(--dsw-alias-state-warn-primary); }
.dsh-dot-chat .lc-stacked-free-on { border: 2px dashed var(--dsw-alias-label-secondary); border-radius: 3px; }
.dsh-dot-chat .lc-stacked-dim .lc-stacked-seg { opacity: 0.35; }
.dsh-dot-chat .lc-stacked-dim .lc-stacked-seg-on { opacity: 1; }
.dsh-dot-chat .lc-stacked-dim .lc-stacked-free { opacity: 0.35; }
.dsh-dot-chat .lc-stacked-dim .lc-stacked-free-on { opacity: 1; }
.dsh-dot-chat .lc-legend { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(180px, 100%), 1fr)); gap: 6px 14px; margin-top: 10px; }
.dsh-dot-chat .lc-chip { display: flex; align-items: center; gap: 5px; min-width: 0; color: var(--dsw-alias-label-primary); padding: 1px 6px; border-radius: 6px; cursor: pointer; transition: background-color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out); }
.dsh-dot-chat .lc-chip-label { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.dsh-dot-chat .lc-chip-nums { margin-left: auto; flex: none; display: inline-flex; align-items: baseline; gap: 6px; white-space: nowrap; }
.dsh-dot-chat .lc-chip i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; transition: box-shadow var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out); }
.dsh-dot-chat .lc-chip em { font-style: normal; color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .lc-chip-on { font-weight: 600; background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-chat .lc-chip-on i { box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.dsh-dot-chat .lc-stacked-seg:focus-visible, .dsh-dot-chat .lc-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-dot-chat .lc-donut-row { display: flex; align-items: center; justify-content: flex-start; gap: 16px; min-width: 0; }
.dsh-dot-chat .lc-col-donut { display: flex; flex-direction: column; }
.dsh-dot-chat .lc-donut { position: relative; flex: none; }
.dsh-dot-chat .lc-donut svg { display: block; }
.dsh-dot-chat .lc-donut-track { fill: none; stroke: var(--dsw-alias-border-l1); stroke-width: 4; }
.dsh-dot-chat .lc-donut-seg { fill: none; stroke-width: 4; transition: opacity var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out); }
.dsh-dot-chat .lc-donut-dim .lc-donut-seg { opacity: 0.35; }
.dsh-dot-chat .lc-donut-dim .lc-donut-seg-on { opacity: 1; }
.dsh-dot-chat .lc-donut-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; pointer-events: none; text-align: center; padding: 0 7px; box-sizing: border-box; }
.dsh-dot-chat .lc-donut-center b { line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.dsh-dot-chat .lc-donut-center span { color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-dot-chat .lc-sl { flex: 1 1 200px; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(148px, 100%), 1fr)); gap: 6px 10px; min-width: 0; }
.dsh-dot-chat .lc-sl-row { display: flex; flex-direction: column; gap: 1px; font-size: 12px; min-width: 0; border-radius: 6px; padding: 3px 6px; cursor: pointer; transition: background-color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out); }
.dsh-dot-chat .lc-sl-row-on { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-chat .lc-sl-row-dim { opacity: 0.55; }
.dsh-dot-chat .lc-sl-main { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-dot-chat .lc-sl-dot { flex: none; width: 8px; height: 8px; border-radius: 2px; }
.dsh-dot-chat .lc-sl-label { flex: 1 1 auto; min-width: 0; line-height: 1.25; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-dot-chat .lc-sl-pct { flex: none; min-width: 30px; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
.dsh-dot-chat .lc-sl-sub { margin-left: 14px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.3; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-dot-chat .dsh-dot-ctx-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 24px; margin: 0; }
.dsh-dot-chat .dsh-dot-ctx-fact { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-dot-chat .dsh-dot-ctx-fact dt { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 16px; }
.dsh-dot-chat .dsh-dot-ctx-fact dd { margin: 0; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.dsh-dot-chat .dsh-dot-ctx-section .dsh-ui-help { margin: 12px 0 0; }
.dsh-dot-chat .dsh-dot-ctx-sections { display: flex; flex-direction: column; gap: 10px; margin: 0; }
.dsh-dot-chat .dsh-dot-ctx-section-row { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-dot-chat .dsh-dot-ctx-section-row > dt { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 16px; }
.dsh-dot-chat .dsh-dot-ctx-section-row > dd { margin: 0; min-width: 0; }
.dsh-dot-chat .dsh-dot-ctx-section-text {
  margin: 0; max-height: 160px; overflow: auto; padding: 8px 10px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); font: 12px/18px var(--ds-font-family-code);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
@keyframes lc-donut-in { from { stroke-dasharray: 0 100; } }
@keyframes lc-stacked-in { from { transform: scaleX(0); } }
.dsh-dot-chat .animate-lc-donut-in { animation: lc-donut-in 0.45s cubic-bezier(0.4, 0, 0.2, 1) calc(var(--lc-i, 0) * 50ms) backwards; }
.dsh-dot-chat .animate-lc-stacked-in { animation: lc-stacked-in 0.4s cubic-bezier(0.4, 0, 0.2, 1) calc(var(--lc-i, 0) * 40ms) backwards; }
@media (prefers-reduced-motion: reduce) { .dsh-dot-chat .animate-lc-donut-in, .dsh-dot-chat .animate-lc-stacked-in { animation: none; } }
@media (max-width: 420px) { .dsh-dot-chat .lc-donut-row { flex-wrap: wrap; } .dsh-dot-chat .lc-sl { flex-basis: 100%; } }
@container (max-width: 420px) {
  .dsh-dot-chat .lc-donut-row { flex-wrap: wrap; }
  .dsh-dot-chat .lc-sl { flex-basis: 100%; }
  .dsh-dot-chat .dsh-dot-ctx-handoff { flex-wrap: wrap; }
  .dsh-dot-chat .lc-card-title:not(:has(.lc-gran, .lc-kinds)) { flex-wrap: wrap; }
}
.dsh-dot-chat .dsh-dot-surface-groups { display: flex; flex-direction: column; gap: 4px; }
.dsh-dot-chat .dsh-dot-surface-group { min-width: 0; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); overflow: hidden; }
.dsh-dot-chat .dsh-dot-surface-category { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border: 0; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }
.dsh-dot-chat .dsh-dot-surface-category:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-chat .dsh-dot-surface-category:disabled { cursor: default; opacity: 0.55; }
.dsh-dot-chat .dsh-dot-surface-chevron { flex: none; width: 10px; font-size: 11px; color: var(--dsw-alias-label-tertiary); text-align: center; }
.dsh-dot-chat .dsh-dot-surface-category > i { flex: none; width: 8px; height: 8px; border-radius: 2px; }
.dsh-dot-chat .dsh-dot-surface-category-label { min-width: 0; font-weight: 500; }
.dsh-dot-chat .dsh-dot-surface-category-count { margin-left: auto; color: var(--dsw-alias-label-tertiary); font-size: 12px; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-surface-category-tokens { flex: none; min-width: 56px; text-align: right; font-variant-numeric: tabular-nums; }
.dsh-dot-chat .dsh-dot-surface-nodes { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-dot-chat .dsh-dot-surface-node + .dsh-dot-surface-node { border-top: 0.5px solid var(--dsw-alias-border-l1); }
.dsh-dot-chat .dsh-dot-surface-node > button { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 8px 12px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dsh-dot-chat .dsh-dot-surface-node > button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-chat .dsh-dot-surface-node-name { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-surface-node-preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-dot-chat .dsh-dot-surface-node-tokens { margin-left: auto; flex: none; color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant: tabular-nums; }
.dsh-dot-chat .dsh-dot-surface-node-content { padding: 0 12px 10px; }
.dsh-dot-chat .dsh-dot-surface-node-content pre { max-height: 280px; margin: 0; padding: 10px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); font: 12px/1.6 monospace; }
.dsh-dot-chat .dsh-dot-surface-node-content .dsh-ui-help { display: block; margin-top: 6px; }
@media (max-width: 420px) { .dsh-dot-chat .dsh-dot-surface-node-preview { display: none; } .dsh-dot-chat .dsh-dot-surface-node-name { max-width: 70%; } }
@container (max-width: 420px) { .dsh-dot-chat .dsh-dot-surface-node-preview { display: none; } .dsh-dot-chat .dsh-dot-surface-node-name { max-width: 70%; } }
.dsh-dot-chat .dsh-dot-wd { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dsh-dot-chat .dsh-dot-wd-head { margin-bottom: 0; }
.dsh-dot-chat .dsh-dot-wd-badges { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-dot-chat .dsh-dot-wd-meta { gap: 8px 20px; }
.dsh-dot-chat .dsh-dot-wd-fallback { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: var(--dsw-radius-md); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-state-warn-primary); font-size: 12px; line-height: 18px; }
.dsh-dot-chat .dsh-dot-wd-fallback-title { font-weight: 600; }
.dsh-dot-chat .dsh-dot-wd-fallback-detail { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-wd-calibration,
.dsh-dot-chat .dsh-dot-wd-hits { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dsh-dot-chat .dsh-dot-wd-subhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: 12px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-wd-target { font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-wd-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin: 0; }
.dsh-dot-chat .dsh-dot-wd-stat { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke); min-width: 0; }
.dsh-dot-chat .dsh-dot-wd-stat dt { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-wd-stat dd { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-wd-empty { margin: 0; }
.dsh-dot-chat .dsh-dot-wd-hit-list { display: flex; flex-direction: column; gap: 8px; list-style: none; margin: 0; padding: 0; }
.dsh-dot-chat .dsh-dot-wd-hit { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke); min-width: 0; }
.dsh-dot-chat .dsh-dot-wd-hit-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.dsh-dot-chat .dsh-dot-wd-hit-signal { font-size: 13px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-wd-hit-time { margin-left: auto; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dsh-dot-chat .dsh-dot-wd-hit-meta { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); font-family: var(--ds-font-family-code); overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-wd-hit-judge { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-wd-hit-judge-summary { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-wd-evidence { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-wd-hit-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding-top: 2px; }
`
