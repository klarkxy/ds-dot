import { Button, SegmentedTabs, StateDot, Tag, type SegmentedTab, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { BOARD_ROOT } from './board.tsx'
import { FINISHED_SHOWN } from './board-groups.ts'
import { t, type CopyLocale, type TextKey } from './ui-copy.ts'
import {
  acceptPayload, groupWork, lookRequest, rejectPayload, resumePayload, scopeText, shortId, workFactKey, workFactTone, workFailure,
  type PendingGlance, type WorkAcceptPayload, type WorkBoardItem, type WorkReadRequest, type WorkRejectPayload, type WorkRunView, type WorkStatus,
} from './work-board.ts'

const STATUS_KEY: Record<WorkStatus, TextKey> = {
  cancelled: 'workStatusCancelled', rework: 'workStatusRework', unverified: 'workStatusUnverified', done: 'workStatusDone',
  review: 'workStatusReview', settling: 'workStatusSettling', running: 'workStatusRunning', waiting: 'workStatusWaiting',
}
const STATUS_TONE: Record<WorkStatus, TagTone> = {
  cancelled: 'quiet', rework: 'danger', unverified: 'warning', done: 'success',
  review: 'warning', settling: 'info', running: 'info', waiting: 'neutral',
}
const FAILURE_KEY: Record<ReturnType<typeof workFailure>, TextKey> = {
  stale: 'workStale', withdrawn: 'workWithdrawn', conflict: 'workConflict', unknown: 'workUnknown',
}

export interface WorkApi {
  workAccept(payload: WorkAcceptPayload): Promise<void>
  workReject(payload: WorkRejectPayload): Promise<void>
  workAnswer(payload: { readonly id: string; readonly allow: boolean }): Promise<void>
  workResume(payload: { readonly id: string }): Promise<void>
  workRead?(request: WorkReadRequest): Promise<{ readonly source: string; readonly body: string; readonly truncated?: boolean; readonly totalBytes?: number }>
}

type WorkRead = NonNullable<WorkApi['workRead']>

/** Which groups the drawer filter keeps: everything, only what needs the human, or only work in progress. */
export type WorkFilter = 'all' | 'waiting' | 'active'

export function WorkBoard({ locale, items, pending, notice, filter = 'all', onAccept, onReject, onAnswer, onResume, onRead }: {
  readonly locale: CopyLocale
  readonly filter?: WorkFilter
  readonly items: readonly WorkBoardItem[]
  readonly pending: readonly PendingGlance[]
  readonly notice?: string
  readonly onAccept: (payload: WorkAcceptPayload) => void
  readonly onReject: (payload: WorkRejectPayload) => void
  readonly onAnswer: (payload: { readonly id: string; readonly allow: boolean }) => void
  readonly onResume: (payload: { readonly id: string }) => void
  readonly onRead?: WorkRead
}) {
  const groups = useMemo(() => groupWork(items, pending), [items, pending])
  // Finished work folds away like finished tickets; it would otherwise grow without end.
  const [showDone, setShowDone] = useState(false)
  const section = (title: TextKey, rows: readonly WorkBoardItem[]) => rows.length === 0 ? null : (
    <section className="dsh-ui-stack" aria-label={t(locale, title)}>
      <span className="dsh-ui-meta">{t(locale, title)} · {rows.length}</span>
      {rows.map(row => <WorkRow key={row.id} locale={locale} item={row} pending={pending} onAccept={onAccept} onReject={onReject} onAnswer={onAnswer} onResume={onResume} {...onRead ? { onRead } : {}} />)}
    </section>
  )
  return (
    <div className={BOARD_ROOT} data-work-board="">
      <div className="dsh-ui-stack">
        {notice ? <div className="dsh-ui-error" role="alert">{notice}</div> : null}
        {items.length === 0 && filter === 'all' ? <p className="dsh-ui-hint">{t(locale, 'workEmpty')}</p> : null}
        {filter !== 'active' ? section('workNeedsHuman', groups.needsHuman) : null}
        {filter !== 'waiting' ? section('workActive', groups.active) : null}
        {filter === 'all' && groups.done.length > 0 ? (
          <section className="dsh-ui-stack" aria-label={t(locale, 'workDone')}>
            <Button variant="ghost" size="sm" className="dsh-dot-fold" aria-expanded={showDone} onClick={() => setShowDone(open => !open)}>
              {t(locale, 'workDone')} · {groups.done.length}
            </Button>
            {showDone ? groups.done.slice(0, FINISHED_SHOWN).map(row => <WorkRow key={row.id} locale={locale} item={row} pending={pending} onAccept={onAccept} onReject={onReject} onAnswer={onAnswer} onResume={onResume} {...onRead ? { onRead } : {}} />) : null}
          </section>
        ) : null}
      </div>
    </div>
  )
}

function factLabel(locale: CopyLocale, group: 'kind' | 'phase' | 'verdict' | 'check' | 'delivery' | 'change', value: string): string {
  const key = workFactKey(group, value)
  return key ? t(locale, key) : value
}

const PREVIEW_LIMIT = 65_536

type SourceBody = { readonly ok: true; readonly body: string; readonly truncated: boolean; readonly totalBytes?: number } | { readonly ok: false; readonly message: string }
type FullBody = { readonly phase: 'loading' } | { readonly phase: 'ready'; readonly body: string } | { readonly phase: 'error'; readonly message: string }
type SourcePane = 'evidence' | 'files'
type SourceSlot = { readonly identity: string; readonly loaded: Readonly<Record<string, SourceBody>>; readonly full: Readonly<Record<string, FullBody>> }

function previewFrom(result: { readonly body: string; readonly truncated?: boolean; readonly totalBytes?: number }): SourceBody {
  const cut = result.body.length > PREVIEW_LIMIT
  const body = cut ? `${result.body.slice(0, PREVIEW_LIMIT)}\n… [truncated]` : result.body
  const truncated = cut || result.truncated === true
  return { ok: true, body, truncated, ...(typeof result.totalBytes === 'number' ? { totalBytes: result.totalBytes } : {}) }
}

function exclusionReason(locale: CopyLocale, reason: string): string {
  if (reason === 'ignored directory') return t(locale, 'workExcludeDir')
  if (reason === 'ignored file') return t(locale, 'workExcludeFile')
  if (reason === 'symlink' || reason.startsWith('symlink:')) {
    const target = reason.startsWith('symlink:') ? reason.slice('symlink:'.length) : ''
    const label = t(locale, 'workExcludeLink')
    return target ? `${label} → ${target}` : label
  }
  return reason
}

function WorkFacts({ locale, item, onRead }: {
  readonly locale: CopyLocale
  readonly item: WorkBoardItem
  readonly onRead?: WorkRead
}) {
  const verification = item.verification
  const checks = verification?.checks ?? []
  const changes = verification?.changes ?? []
  const exclusions = verification?.exclusions ?? []
  const outOfScope = verification?.outOfScopePaths ?? []
  const evidence = [...new Set(checks.flatMap(check => check.evidenceRefs))]
  const evidenceKey = evidence.join('\n')
  const changeKey = changes.map(change => `${change.kind}:${change.path}`).join('\n')
  const verificationId = verification?.id ?? ''
  const inputRef = verification?.inputRef ?? ''
  const inputRevision = verification?.inputRevision ?? 0
  const changeInputRef = item.inputRef
  const changeRevision = item.revision
  const identity = verificationId ? `${item.id}|${changeInputRef}|${changeRevision}|${verificationId}|${inputRef}|${inputRevision}` : ''
  const [slot, setSlot] = useState<SourceSlot>({ identity: '', loaded: {}, full: {} })
  const [pane, setPane] = useState<SourcePane>('evidence')
  // Sources are read only once the human opens this card's details: a closed card costs no request and no preview text.
  const [open, setOpen] = useState(false)
  const loaded = slot.identity === identity ? slot.loaded : {}
  const fullState = slot.identity === identity ? slot.full : {}
  const fullFlights = useRef(new Set<string>())
  const slotRef = useRef(slot)
  slotRef.current = slot
  const life = useRef(0)
  useEffect(() => () => { life.current += 1 }, [])
  const loadPreview = useCallback((kind: 'evidence' | 'change', ref: string, token: string, isCancelled?: () => boolean) => {
    if (!onRead || !verificationId) return
    const key = `${kind}:${ref}`
    const ticket = life.current
    void onRead({ id: item.id, kind, ref, verificationId, inputRef, inputRevision }).then(result => {
      if (isCancelled?.() || life.current !== ticket) return
      const row = previewFrom(result)
      setSlot(current => current.identity === token ? { ...current, loaded: { ...current.loaded, [key]: row } } : current)
    }, failure => {
      if (isCancelled?.() || life.current !== ticket) return
      const message = failure instanceof Error ? failure.message : String(failure)
      setSlot(current => current.identity === token ? { ...current, loaded: { ...current.loaded, [key]: { ok: false, message } } } : current)
    })
  }, [onRead, item.id, verificationId, inputRef, inputRevision])
  const loadFull = useCallback((kind: 'evidence' | 'change', ref: string, token: string) => {
    if (!onRead || !verificationId || !token) return
    const key = `${kind}:${ref}`
    const flight = `${token}\0${key}`
    if (fullFlights.current.has(flight)) return
    fullFlights.current.add(flight)
    const ticket = life.current
    setSlot(current => current.identity === token ? { ...current, full: { ...current.full, [key]: { phase: 'loading' } } } : current)
    void onRead({ id: item.id, kind, ref, verificationId, inputRef, inputRevision, forceFull: true }).then(result => {
      fullFlights.current.delete(flight)
      if (life.current !== ticket) return
      setSlot(current => current.identity === token ? { ...current, full: { ...current.full, [key]: { phase: 'ready', body: result.body } } } : current)
    }, failure => {
      fullFlights.current.delete(flight)
      if (life.current !== ticket) return
      const message = failure instanceof Error ? failure.message : String(failure)
      setSlot(current => current.identity === token ? { ...current, full: { ...current.full, [key]: { phase: 'error', message } } } : current)
    })
  }, [onRead, item.id, verificationId, inputRef, inputRevision])
  useEffect(() => {
    if (!open || !onRead || !verificationId) return
    let cancel = false
    const token = identity
    setSlot(current => current.identity === token ? current : { identity: token, loaded: {}, full: {} })
    const evidenceJobs = evidenceKey.split('\n').filter(Boolean).map(ref => ({ kind: 'evidence' as const, ref }))
    const changeJobs = changeKey.split('\n').filter(Boolean).filter(row => !row.startsWith('deleted:')).map(row => ({ kind: 'change' as const, ref: row.slice(row.indexOf(':') + 1) }))
    // Reopening keeps what was already read; only missing or failed sources are asked for again.
    const known = slotRef.current.identity === token ? slotRef.current.loaded : {}
    for (const job of [...evidenceJobs, ...changeJobs]) if (known[`${job.kind}:${job.ref}`]?.ok !== true) loadPreview(job.kind, job.ref, token, () => cancel)
    return () => { cancel = true }
  }, [open, onRead, loadPreview, evidenceKey, changeKey, identity, verificationId])
  const outcome = (kind: 'evidence' | 'change', ref: string) => {
    const key = `${kind}:${ref}`
    const row = loaded[key]
    if (!row) return null
    if (!row.ok) {
      const stale = /not bound|not a delivered|no current verification/.test(row.message)
      const missing = /missing|empty|deleted/.test(row.message)
      return (
        <div className="dsh-dot-work-source-note">
          <p role="alert">{stale ? t(locale, 'workEvidenceStale') : missing ? t(locale, 'workEvidenceMissing') : `${t(locale, 'workEvidenceFailed')}${row.message}`}</p>
          <Button variant="ghost" size="sm" onClick={() => loadPreview(kind, ref, identity)}>{t(locale, 'workEvidenceRetry')}</Button>
        </div>
      )
    }
    if (inputRef !== changeInputRef || inputRevision !== changeRevision) return null
    const full = fullState[key]
    if (full?.phase === 'ready') return <pre className="dsh-dot-work-pre" data-evidence-body={key}>{full.body}</pre>
    const loading = full?.phase === 'loading'
    const failed = full?.phase === 'error'
    const bytes = row.totalBytes === undefined ? '' : ` (${row.totalBytes} bytes)`
    return (
      <>
        <pre className="dsh-dot-work-pre" data-evidence-body={key}>{row.body}</pre>
        {row.truncated || loading || failed ? (
          <Button variant="ghost" size="sm" disabled={loading} aria-busy={loading || undefined} onClick={() => loadFull(kind, ref, identity)}>
            {loading ? t(locale, 'workEvidenceLoading') : failed ? t(locale, 'workEvidenceRetry') : `${t(locale, 'workEvidenceFull')}${bytes}`}
          </Button>
        ) : null}
        {full?.phase === 'error' ? <p role="alert">{`${t(locale, 'workEvidenceFailed')}${full.message}`}</p> : null}
      </>
    )
  }
  const evidencePane = evidence.length === 0 ? null : evidence.map(ref => (
    <div key={ref} className="dsh-dot-work-source">
      <a className="dsh-dot-work-source-head" href={`#evidence-${encodeURIComponent(ref)}`} data-evidence-ref={ref} onClick={event => { event.preventDefault(); if (identity && loaded[`evidence:${ref}`]?.ok !== true) loadPreview('evidence', ref, identity) }}>
        <FileGlyph />
        <span>{t(locale, 'workEvidence')} {ref}</span>
      </a>
      {outcome('evidence', ref)}
    </div>
  ))
  const filesPane = changes.length === 0 ? null : changes.map(change => (
    <div key={change.path} className="dsh-dot-work-source">
      {change.kind === 'deleted'
        ? <span className="dsh-dot-work-source-head"><FileGlyph /><span>{change.path}</span><Tag tone="danger">{factLabel(locale, 'change', change.kind)}</Tag></span>
        : (
          <a className="dsh-dot-work-source-head" href={`#change-${encodeURIComponent(change.path)}`} data-change-path={change.path} onClick={event => { event.preventDefault(); if (identity && loaded[`change:${change.path}`]?.ok !== true) loadPreview('change', change.path, identity) }}>
            <FileGlyph />
            <span>{change.path}</span>
            <Tag tone={change.kind === 'added' ? 'success' : 'info'}>{factLabel(locale, 'change', change.kind)}</Tag>
          </a>
        )}
      {outcome('change', change.path)}
    </div>
  ))
  const shownPane = evidencePane && filesPane ? pane : evidencePane ? 'evidence' : 'files'
  const review = item.runs.find(run => run.kind === 'review')
  return (
    <details className="dsh-dot-work-facts" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{t(locale, 'workDetails')}</summary>
      <div className="dsh-dot-work-facts-body">
        {item.summary ? <p className="dsh-dot-work-summary"><span className="dsh-ui-meta">{t(locale, 'workSummary')}</span> {item.summary}</p> : null}
        {checks.length > 0 ? (
          <div className="dsh-dot-work-list">
            {checks.map(check => (
              <div key={check.requirementRef} className="dsh-dot-work-check">
                <span className="dsh-dot-work-check-ref">{check.requirementRef}</span>
                {check.note ? <span className="dsh-dot-work-check-note">{check.note}</span> : <span className="dsh-ui-spacer" />}
                <Tag tone={workFactTone(check.verdict)}>{factLabel(locale, 'check', check.verdict)}</Tag>
              </div>
            ))}
          </div>
        ) : null}
        {evidencePane && filesPane ? <SourceTabs locale={locale} value={pane} evidence={evidence.length} files={changes.length} onChange={setPane} /> : null}
        {evidencePane ? <div className="dsh-dot-work-pane" hidden={shownPane !== 'evidence'}>{evidencePane}</div> : null}
        {filesPane ? <div className="dsh-dot-work-pane" hidden={shownPane !== 'files'}>{!evidencePane ? <span className="dsh-ui-meta">{t(locale, 'workFiles')}</span> : null}{filesPane}</div> : null}
        <details className="dsh-dot-work-diag">
          <summary>{t(locale, 'workDiagnostics')}</summary>
          <div className="dsh-dot-work-list">
            <span className="dsh-dot-work-facts-line">
              {item.id} · {t(locale, 'workRevision').replace('{n}', String(item.revision))} · {t(locale, 'workInput')} {shortId(item.inputRef)}
              {verification ? ` · ${t(locale, 'workVerification')} ${verification.id}` : ''}
              {verification?.subjectKey ? ` · ${t(locale, 'workSubject')} ${shortId(verification.subjectKey)}` : ''}
            </span>
            {item.runs.map(run => <RunFacts key={run.id} locale={locale} run={run} />)}
            {review ? <span className="dsh-dot-work-facts-line">{t(locale, 'workReview')} {review.id}</span> : null}
            {item.closeout ? <span className="dsh-dot-work-facts-line">{t(locale, 'workCloseout')} {item.closeout.verificationId}</span> : null}
            {item.blockers.length > 0 ? <span className="dsh-dot-work-facts-line">{t(locale, 'workBlockers')} {item.blockers.join(', ')}</span> : null}
            {outOfScope.length > 0 ? <p className="dsh-dot-work-summary"><span className="dsh-ui-meta">{t(locale, 'workOutOfScope')}</span>{outOfScope.map(path => ` · ${path}`)}</p> : null}
            {exclusions.length > 0 ? (
              <p className="dsh-dot-work-summary">
                <span className="dsh-ui-meta">{t(locale, 'workExcluded')}</span>
                {exclusions.map((ex, index) => <span key={`${ex.path}\0${index}`}>{` · ${ex.path} (${exclusionReason(locale, ex.reason)})`}</span>)}
              </p>
            ) : null}
          </div>
        </details>
      </div>
    </details>
  )
}

function SourceTabs({ locale, value, evidence, files, onChange }: { locale: CopyLocale; value: SourcePane; evidence: number; files: number; onChange: (next: SourcePane) => void }) {
  const baseId = useId()
  const items = useMemo(() => ([
    { id: `${baseId}-evidence`, panelId: `${baseId}-evidence-panel`, value: 'evidence', label: `${t(locale, 'workEvidence')} (${evidence})` },
    { id: `${baseId}-files`, panelId: `${baseId}-files-panel`, value: 'files', label: `${t(locale, 'workFiles')} (${files})` },
  ]) as unknown as readonly [SegmentedTab<SourcePane>, ...SegmentedTab<SourcePane>[]], [baseId, locale, evidence, files])
  return <SegmentedTabs<SourcePane> size="sm" label={t(locale, 'workDetails')} items={items} value={value} onChange={onChange} />
}

function FileGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 1.8H4.2a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5.6z" />
      <path d="M9 1.8v3.8h3.8" />
    </svg>
  )
}

function RunFacts({ locale, run }: { readonly locale: CopyLocale; readonly run: WorkRunView }) {
  const paths = scopeText(run.writeScope)
  const exclusive = run.writeScope?.kind === 'workspace-exclusive'
  return (
    <div className="dsh-dot-work-run">
      <span className="dsh-dot-work-run-line">
        <span className="dsh-dot-work-mono">{run.id}</span> {factLabel(locale, 'kind', run.kind)}/{factLabel(locale, 'phase', run.phase)}
        {run.writeScope ? ` · ${t(locale, 'workScope')} ${exclusive ? t(locale, 'workScopeExclusive') : paths || t(locale, 'workScopeNone')}` : ''}
      </span>
      {(run.deliveries ?? []).map(delivery => (
        <span key={delivery.id} className="dsh-dot-work-run-line">
          <span className="dsh-dot-work-mono">{delivery.id}</span> <Tag tone={workFactTone(delivery.status)}>{factLabel(locale, 'delivery', delivery.status)}</Tag>
          {delivery.contentRef ? ` ${delivery.contentRef}` : ''}
          {delivery.evidence ? ` · ${t(locale, 'workEvidence')} ${delivery.evidence}` : ''}
        </span>
      ))}
    </div>
  )
}

function itemDot(item: WorkBoardItem, needsHuman: boolean): StateDotState {
  if (item.status === 'done') return 'done'
  if (item.status === 'cancelled') return 'idle'
  if (item.status === 'rework') return 'error'
  if (needsHuman || item.status === 'unverified' || item.status === 'review') return 'warning'
  if (item.status === 'waiting') return 'idle'
  return 'ongoing'
}

function WorkRow({ locale, item, pending, onAccept, onReject, onAnswer, onResume, onRead }: {
  readonly locale: CopyLocale
  readonly item: WorkBoardItem
  readonly pending: readonly PendingGlance[]
  readonly onAccept: (payload: WorkAcceptPayload) => void
  readonly onReject: (payload: WorkRejectPayload) => void
  readonly onAnswer: (payload: { readonly id: string; readonly allow: boolean }) => void
  readonly onResume: (payload: { readonly id: string }) => void
  readonly onRead?: WorkRead
}) {
  const accept = acceptPayload(item)
  const reject = rejectPayload(item)
  const resume = resumePayload(item)
  const look = lookRequest(item, pending)
  const lookOpen = Boolean(look && look !== 'stale' && look !== 'withdrawn')
  const actions = lookOpen || accept || reject || resume
  const delivery = item.runs.flatMap(run => run.deliveries ?? []).at(-1)
  return (
    <div className="dsh-dot-work" data-work={item.id} data-status={item.status}>
      <div className="dsh-dot-work-head">
        <StateDot state={itemDot(item, Boolean(accept) || lookOpen)} />
        <div className="dsh-dot-work-main">
          <span className="dsh-dot-work-title">{item.title}</span>
          <span className="dsh-dot-work-meta">
            <Tag tone={STATUS_TONE[item.status]}>{t(locale, STATUS_KEY[item.status])}</Tag>
            {item.priority === 3 ? <Tag tone="warning">{t(locale, 'priorityHigh')}</Tag> : null}
            {item.verification ? <Tag tone={workFactTone(item.verification.verdict)}>{t(locale, 'workVerification')} {factLabel(locale, 'verdict', item.verification.verdict)}</Tag> : null}
            {delivery ? <Tag tone={workFactTone(delivery.status)}>{t(locale, 'workSubject')} {factLabel(locale, 'delivery', delivery.status)}</Tag> : null}
          </span>
        </div>
      </div>
      {actions ? (
        <div className="dsh-dot-work-actions">
          {lookOpen && typeof look === 'object' && look ? <Button variant="primary" size="sm" onClick={() => onAnswer({ id: look.id, allow: true })}>{t(locale, 'workLookAccept')}</Button> : null}
          {lookOpen && typeof look === 'object' && look ? <Button variant="ghost" size="sm" onClick={() => onAnswer({ id: look.id, allow: false })}>{t(locale, 'workLookReject')}</Button> : null}
          {accept ? <Button variant="primary" size="sm" onClick={() => onAccept(accept)}>{t(locale, 'workAccept')}</Button> : null}
          {reject ? <Button variant="ghost" size="sm" onClick={() => onReject(reject)}>{t(locale, 'workReject')}</Button> : null}
          {resume ? <Button variant="ghost" size="sm" onClick={() => onResume(resume)}>{t(locale, 'workResume')}</Button> : null}
        </div>
      ) : null}
      {look === 'stale' ? <p className="dsh-ui-hint">{t(locale, 'workLookStale')}</p> : null}
      {look === 'withdrawn' ? <p className="dsh-ui-hint">{t(locale, 'workLookWithdrawn')}</p> : null}
      <WorkFacts locale={locale} item={item} {...onRead ? { onRead } : {}} />
    </div>
  )
}
/** Renders the board's work and sends versioned actions. A refusal stays on screen; the parent re-reads the board after every action. */
export function WorkBoardPanel({ locale, api, items, pending, filter = 'all', onChanged }: {
  readonly locale: CopyLocale
  readonly api: WorkApi
  readonly items: readonly WorkBoardItem[]
  readonly pending: readonly PendingGlance[]
  readonly filter?: WorkFilter
  readonly onChanged: () => void
}) {
  const [notice, setNotice] = useState<string>()
  const run = (work: Promise<unknown>) => {
    setNotice(undefined)
    void work.then(onChanged, failure => {
      const kind = workFailure(failure instanceof Error ? failure.message : String(failure))
      const text = t(locale, FAILURE_KEY[kind])
      setNotice(kind === 'unknown' ? `${text}${failure instanceof Error ? failure.message : String(failure)}` : text)
      onChanged()
    })
  }
  return (
    <WorkBoard
      locale={locale}
      items={items}
      pending={pending}
      filter={filter}
      {...notice === undefined ? {} : { notice }}
      onAccept={payload => run(api.workAccept(payload))}
      onReject={payload => run(api.workReject(payload))}
      onAnswer={payload => run(api.workAnswer(payload))}
      onResume={payload => run(api.workResume(payload))}
      {...api.workRead ? { onRead: api.workRead } : {}}
    />
  )
}