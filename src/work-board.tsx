import { Button, StateDot, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState } from 'react'
import { BOARD_ROOT } from './board.tsx'
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
  workList(signal: AbortSignal): Promise<readonly WorkBoardItem[]>
  workAccept(payload: WorkAcceptPayload): Promise<void>
  workReject(payload: WorkRejectPayload): Promise<void>
  workAnswer(payload: { readonly id: string; readonly allow: boolean }): Promise<void>
  workResume(payload: { readonly id: string }): Promise<void>
  workRead?(request: WorkReadRequest): Promise<{ readonly source: string; readonly body: string }>
}

export function WorkBoard({ locale, items, pending, notice, onAccept, onReject, onAnswer, onResume, onRead }: {
  readonly locale: CopyLocale
  readonly items: readonly WorkBoardItem[]
  readonly pending: readonly PendingGlance[]
  readonly notice?: string
  readonly onAccept: (payload: WorkAcceptPayload) => void
  readonly onReject: (payload: WorkRejectPayload) => void
  readonly onAnswer: (payload: { readonly id: string; readonly allow: boolean }) => void
  readonly onResume: (payload: { readonly id: string }) => void
  readonly onRead?: (request: WorkReadRequest) => Promise<{ readonly source: string; readonly body: string }>
}) {
  const groups = groupWork(items)
  const section = (title: TextKey, rows: readonly WorkBoardItem[]) => rows.length === 0 ? null : (
    <section className="dsh-ui-stack" aria-label={t(locale, title)}>
      <span className="dsh-ui-meta">{t(locale, title)} · {rows.length}</span>
      {rows.map(row => <WorkRow key={row.id} locale={locale} item={row} pending={pending} onAccept={onAccept} onReject={onReject} onAnswer={onAnswer} onResume={onResume} {...onRead ? { onRead } : {}} />)}
    </section>
  )
  return (
    <div className={BOARD_ROOT} data-work-board="">
      <div className="dsh-ui-stack">
        <span className="dsh-ui-meta">{t(locale, 'workBoard')}</span>
        {notice ? <div className="dsh-ui-error" role="alert">{notice}</div> : null}
        {items.length === 0 ? <p className="dsh-ui-hint">{t(locale, 'workEmpty')}</p> : null}
        {section('workNeedsHuman', groups.needsHuman)}
        {section('workActive', groups.active)}
        {section('workDone', groups.done)}
      </div>
    </div>
  )
}

function factLabel(locale: CopyLocale, group: 'kind' | 'phase' | 'verdict' | 'check' | 'delivery' | 'change', value: string): string {
  const key = workFactKey(group, value)
  return key ? t(locale, key) : value
}

function WorkFacts({ locale, item, onRead }: {
  readonly locale: CopyLocale
  readonly item: WorkBoardItem
  readonly onRead?: (request: WorkReadRequest) => Promise<{ readonly source: string; readonly body: string }>
}) {
  const verification = item.verification
  const checks = verification?.checks ?? []
  const changes = verification?.changes ?? []
  const evidence = [...new Set(checks.flatMap(check => check.evidenceRefs))]
  const evidenceKey = evidence.join('\n')
  const changeKey = changes.map(change => `${change.kind}:${change.path}`).join('\n')
  const verificationId = verification?.id ?? ''
  const inputRef = verification?.inputRef ?? ''
  const inputRevision = verification?.inputRevision ?? 0
  const changeInputRef = item.inputRef
  const changeRevision = item.revision
  const identity = verificationId ? `${item.id}|${changeInputRef}|${changeRevision}|${verificationId}|${inputRef}|${inputRevision}` : ''
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [slot, setSlot] = useState<{ readonly identity: string; readonly loaded: Readonly<Record<string, { readonly ok: true; readonly body: string } | { readonly ok: false; readonly message: string }>> }>({ identity: '', loaded: {} })
  const loaded = slot.identity === identity ? slot.loaded : {}
  const loadOne = useCallback((kind: 'evidence' | 'change', ref: string, token: string, isCancelled?: () => boolean) => {
    if (!onRead || !verificationId) return
    const key = `${kind}:${ref}`
    void onRead({ id: item.id, kind, ref, verificationId, inputRef, inputRevision }).then(result => {
      if (isCancelled?.()) return
      const clipped = result.body.length > 65_536 ? `${result.body.slice(0, 65_536)}\n… [truncated]` : result.body
      setSlot(current => current.identity === token ? { identity: token, loaded: { ...current.loaded, [key]: { ok: true, body: clipped } } } : current)
    }, failure => {
      if (isCancelled?.()) return
      const message = failure instanceof Error ? failure.message : String(failure)
      setSlot(current => current.identity === token ? { identity: token, loaded: { ...current.loaded, [key]: { ok: false, message } } } : current)
    })
  }, [onRead, item.id, verificationId, inputRef, inputRevision])
  useEffect(() => {
    if (!onRead || !verificationId) return
    let cancel = false
    const token = identity
    setSlot(current => current.identity === token ? current : { identity: token, loaded: {} })
    const evidenceJobs = evidenceKey.split('\n').filter(Boolean).map(ref => ({ kind: 'evidence' as const, ref }))
    const changeJobs = changeKey.split('\n').filter(Boolean).filter(row => !row.startsWith('deleted:')).map(row => ({ kind: 'change' as const, ref: row.slice(row.indexOf(':') + 1) }))
    const allJobs = [...evidenceJobs, ...changeJobs]
    // Eagerly preload small deliveries (<= 8 sources); defer large file sets until expanded or clicked.
    const eager = allJobs.length <= 8 || detailsOpen ? allJobs : evidenceJobs.slice(0, 8)
    for (const job of eager) loadOne(job.kind, job.ref, token, () => cancel)
    return () => { cancel = true }
  }, [onRead, loadOne, detailsOpen, evidenceKey, changeKey, identity, verificationId, changeInputRef, changeRevision])
  const visible = Boolean(item.summary) || item.runs.some(run => run.writeScope || (run.deliveries?.length ?? 0) > 0) || checks.length > 0 || changes.length > 0
  if (!visible) return null
  const outcome = (key: string) => {
    const row = loaded[key]
    if (!row) return null
    if (row.ok && (inputRef !== changeInputRef || inputRevision !== changeRevision)) return null
    if (row.ok) return <pre data-evidence-body={key}>{row.body}</pre>
    const stale = /not bound|not a delivered|no current verification/.test(row.message)
    const missing = /missing|empty|deleted/.test(row.message)
    return <p role="alert">{stale ? t(locale, 'workEvidenceStale') : missing ? t(locale, 'workEvidenceMissing') : `${t(locale, 'workEvidenceFailed')}${row.message}`}</p>
  }
  return (
    <details className="dsh-ui-hint" onToggle={event => setDetailsOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>{t(locale, 'workDetails')}</summary>
      {item.summary ? <p>{t(locale, 'workSummary')}: {item.summary}</p> : null}
      {item.runs.map(run => <RunFacts key={run.id} locale={locale} run={run} />)}
      {item.verification ? (
        <p>
          {t(locale, 'workVerification')} {item.verification.id} {factLabel(locale, 'verdict', item.verification.verdict)}
          {checks.map(check => (
            <span key={check.requirementRef}>
              {` · ${check.requirementRef} `}
              <Tag tone={workFactTone(check.verdict)}>{factLabel(locale, 'check', check.verdict)}</Tag>
              {check.note ? ` ${check.note}` : ''}
            </span>
          ))}
        </p>
      ) : null}
      {evidence.map(ref => (
        <div key={ref}>
          <a href={`#evidence-${encodeURIComponent(ref)}`} data-evidence-ref={ref} onClick={event => { event.preventDefault(); if (identity && !loaded[`evidence:${ref}`]) loadOne('evidence', ref, identity) }}>{t(locale, 'workEvidence')} {ref}</a>
          {outcome(`evidence:${ref}`)}
        </div>
      ))}
      {changes.length > 0 ? (
        <div>
          <p>{t(locale, 'workFiles')}</p>
          {changes.map(change => (
            <div key={change.path}>
              {change.kind === 'deleted' ? <span>{change.path} ({factLabel(locale, 'change', change.kind)})</span> : <a href={`#change-${encodeURIComponent(change.path)}`} data-change-path={change.path} onClick={event => { event.preventDefault(); if (identity && !loaded[`change:${change.path}`]) loadOne('change', change.path, identity) }}>{change.path} ({factLabel(locale, 'change', change.kind)})</a>}
              {outcome(`change:${change.path}`)}
            </div>
          ))}
        </div>
      ) : null}
    </details>
  )
}

function RunFacts({ locale, run }: { readonly locale: CopyLocale; readonly run: WorkRunView }) {
  const paths = scopeText(run.writeScope)
  const exclusive = run.writeScope?.kind === 'workspace-exclusive'
  return (
    <div>
      <p>
        {run.id} {factLabel(locale, 'kind', run.kind)}/{factLabel(locale, 'phase', run.phase)}
        {run.writeScope ? ` · ${t(locale, 'workScope')} ${exclusive ? t(locale, 'workScopeExclusive') : paths || t(locale, 'workScopeNone')}` : ''}
      </p>
      {(run.deliveries ?? []).map(delivery => (
        <p key={delivery.id}>
          {delivery.id} <Tag tone={workFactTone(delivery.status)}>{factLabel(locale, 'delivery', delivery.status)}</Tag>
          {delivery.contentRef ? ` ${delivery.contentRef}` : ''}
          {delivery.evidence ? ` · ${t(locale, 'workEvidence')} ${delivery.evidence}` : ''}
        </p>
      ))}
    </div>
  )
}

function WorkRow({ locale, item, pending, onAccept, onReject, onAnswer, onResume, onRead }: {
  readonly locale: CopyLocale
  readonly item: WorkBoardItem
  readonly pending: readonly PendingGlance[]
  readonly onAccept: (payload: WorkAcceptPayload) => void
  readonly onReject: (payload: WorkRejectPayload) => void
  readonly onAnswer: (payload: { readonly id: string; readonly allow: boolean }) => void
  readonly onResume: (payload: { readonly id: string }) => void
  readonly onRead?: (request: WorkReadRequest) => Promise<{ readonly source: string; readonly body: string }>
}) {
  const accept = acceptPayload(item)
  const reject = rejectPayload(item)
  const resume = resumePayload(item)
  const look = lookRequest(item, pending)
  const review = item.runs.find(run => run.kind === 'review')
  return (
    <div className="dsh-dot-ticket" data-work={item.id}>
      <div className="dsh-dot-ticket-head">
        <div className="dsh-dot-row">
          <StateDot state={item.status === 'done' ? 'done' : item.status === 'rework' || item.status === 'unverified' ? 'warning' : 'ongoing'} />
          <span className="dsh-dot-main">
            <span className="dsh-dot-titleline">
              <span className="dsh-ui-compact dsh-ui-truncate">{item.title}</span>
              <Tag tone={STATUS_TONE[item.status]}>{t(locale, STATUS_KEY[item.status])}</Tag>
            </span>
            <span className="dsh-ui-hint dsh-ui-truncate">
              {t(locale, 'workRevision').replace('{n}', String(item.revision))}
              {` · ${t(locale, 'workInput')} ${shortId(item.inputRef)}`}
              {item.verification ? ` · ${t(locale, 'workVerification')} ${item.verification.id} ${factLabel(locale, 'verdict', item.verification.verdict)}` : ''}
              {item.verification?.subjectKey ? ` · ${t(locale, 'workSubject')} ${shortId(item.verification.subjectKey)}` : ''}
            </span>
            <span className="dsh-ui-hint dsh-ui-truncate" title={item.runs.map(run => `${run.id} ${factLabel(locale, 'kind', run.kind)} ${factLabel(locale, 'phase', run.phase)}`).join(', ')}>
              {item.runs.length === 0 ? t(locale, 'workNoRuns') : item.runs.map(run => `${run.id} ${factLabel(locale, 'kind', run.kind)}/${factLabel(locale, 'phase', run.phase)}`).join(' · ')}
              {review ? ` · ${t(locale, 'workReview')} ${review.id}` : ''}
              {item.closeout ? ` · ${t(locale, 'workCloseout')} ${item.closeout.verificationId}` : ''}
              {item.blockers.length > 0 ? ` · ${t(locale, 'workBlockers')} ${item.blockers.join(', ')}` : ''}
            </span>
          </span>
        </div>
        <div className="dsh-dot-ticket-actions">
          {look && look !== 'stale' && look !== 'withdrawn' ? <Button variant="primary" size="sm" onClick={() => onAnswer({ id: look.id, allow: true })}>{t(locale, 'workLookAccept')}</Button> : null}
          {look && look !== 'stale' && look !== 'withdrawn' ? <Button variant="ghost" size="sm" onClick={() => onAnswer({ id: look.id, allow: false })}>{t(locale, 'workLookReject')}</Button> : null}
          {accept ? <Button variant="primary" size="sm" onClick={() => onAccept(accept)}>{t(locale, 'workAccept')}</Button> : null}
          {reject ? <Button variant="ghost" size="sm" onClick={() => onReject(reject)}>{t(locale, 'workReject')}</Button> : null}
          {resume ? <Button variant="ghost" size="sm" onClick={() => onResume(resume)}>{t(locale, 'workResume')}</Button> : null}
        </div>
      </div>
      {look === 'stale' ? <p className="dsh-ui-hint">{t(locale, 'workLookStale')}</p> : null}
      {look === 'withdrawn' ? <p className="dsh-ui-hint">{t(locale, 'workLookWithdrawn')}</p> : null}
      <WorkFacts locale={locale} item={item} {...onRead ? { onRead } : {}} />
    </div>
  )
}

/** Loads the projection and sends versioned actions. A refusal stays on screen and is not treated as done. */
export function WorkBoardPanel({ locale, api, pending, initialItems }: { readonly locale: CopyLocale; readonly api: WorkApi; readonly pending: readonly PendingGlance[]; readonly initialItems?: readonly WorkBoardItem[] }) {
  const [items, setItems] = useState<readonly WorkBoardItem[]>(initialItems ?? [])
  const [notice, setNotice] = useState<string>()
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick(value => value + 1), [])
  useEffect(() => {
    const lifetime = new AbortController()
    void api.workList(lifetime.signal).then(rows => {
      if (!lifetime.signal.aborted) setItems(rows)
    }, failure => {
      if (!lifetime.signal.aborted) setNotice(`${t(locale, 'workUnknown')}${failure instanceof Error ? failure.message : String(failure)}`)
    })
    return () => lifetime.abort()
  }, [api, locale, tick, pending])
  const run = (work: Promise<unknown>) => {
    setNotice(undefined)
    void work.then(refresh, failure => {
      const kind = workFailure(failure instanceof Error ? failure.message : String(failure))
      const text = t(locale, FAILURE_KEY[kind])
      setNotice(kind === 'unknown' ? `${text}${failure instanceof Error ? failure.message : String(failure)}` : text)
      refresh()
    })
  }
  return (
    <WorkBoard
      locale={locale}
      items={items}
      pending={pending}
      {...notice === undefined ? {} : { notice }}
      onAccept={payload => run(api.workAccept(payload))}
      onReject={payload => run(api.workReject(payload))}
      onAnswer={payload => run(api.workAnswer(payload))}
      onResume={payload => run(api.workResume(payload))}
      {...api.workRead ? { onRead: (request: WorkReadRequest) => api.workRead!(request) } : {}}
    />
  )
}
