/** dot's own answer channel around Deep View's shared renderer. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, MarkdownText, Tag, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { WidgetCard, type Answer, type ButtonHost } from '@klarkxy/dsh-deep-view/widget'
import type { ViewNode } from '@klarkxy/dsh-deep-view/contracts'
import { checkShownView } from '@klarkxy/dsh-deep-view/core'
import { checkedAnswer } from '@klarkxy/dsh-deep-view/answers'
import { uiEn } from '@klarkxy/dsh-deep-view/copy'
import { cardCopy, copyLocale, t as uiT, type CardTextKey, type CopyLocale } from './ui-copy.ts'
import { approvalDisplay, folderName, permissionLabel } from './chat-format.ts'
import { APPROVAL_FENCE_PREFIX, type ApprovalDetail } from './contracts.ts'
import type { CardComponent } from './chat-panel.tsx'

interface CardLocale {
  getSnapshot(): { active: string }
  subscribe(listener: () => void): () => void
}
const translationKeys = new Map(Object.entries(uiEn).map(([key, english]) => [english, key as CardTextKey]))

const CardButton: ButtonHost = props => <Button {...props} />

const APPROVAL_FENCE = new RegExp(`</?${APPROVAL_FENCE_PREFIX}[0-9a-f-]+>`, 'gi')

/** The approval card the server sends is a stack of text dumps plus a confirm node named 'approval'. */
function isApprovalView(node: ViewNode): boolean {
  if (node.type !== 'stack' || !Array.isArray(node.children)) return false
  let confirm = false
  for (const child of node.children) {
    if (child.type === 'text') continue
    if (child.type === 'confirm' && child.id === 'approval') confirm = true
    else return false
  }
  return confirm
}

/** The text node of an approval card is a fenced dump for the model; the panel shows it only as a fallback. */
function approvalDumpText(view: ViewNode): string {
  if (!Array.isArray(view.children)) return ''
  return view.children
    .filter(child => child.type === 'text')
    .map(child => typeof child.text === 'string' ? child.text : '')
    .join('\n')
    .replace(APPROVAL_FENCE, '')
    .trim()
}

/** approvalDisplay only reads string commands; a shell argv array is joined for display. */
function approvalCommand(args: unknown, fallback: string | undefined): string | undefined {
  if (fallback || args === null || typeof args !== 'object') return fallback
  const command = (args as Record<string, unknown>).command
  if (Array.isArray(command)) return command.map(part => String(part)).join(' ') || undefined
  return undefined
}

/** justification wins over the request reason; a bare sandbox-escalation prefix is already covered by the meta line. */
function approvalReason(detail: ApprovalDetail | null | undefined, justification: string | undefined): string | undefined {
  const reason = justification ?? detail?.reason?.trim()
  const match = /^escalate sandbox to [a-z0-9_-]+(?::\s*([\s\S]+))?$/i.exec(reason ?? '')
  return match ? match[1]?.trim() || undefined : reason
}

/** Structured summary of a pending approval, parsed from the stored request arguments. */
function ApprovalSummary({ detail, dump, locale }: { detail: ApprovalDetail | null | undefined; dump: string; locale: CopyLocale }) {
  const args = useMemo<unknown>(() => {
    if (detail?.arguments === undefined) return undefined
    try { return JSON.parse(detail.arguments) } catch { return undefined }
  }, [detail?.arguments])
  const display = approvalDisplay(args)
  const command = approvalCommand(args, display.command)
  const why = approvalReason(detail, display.reason)
  const dir = display.cwd
  const sandbox = permissionLabel(locale, display.permission)
  const designed = detail != null && Boolean(command || display.description || why || dir || sandbox)
  return (
    <div className="dsh-dot-approval-summary">
      <div className="dsh-dot-approval-head">
        <Tag tone="warning">{uiT(locale, 'approvalNeeded')}</Tag>
        {detail?.toolName ? <code className="dsh-dot-code-pill">{detail.toolName}</code> : null}
      </div>
      {designed ? (
        <>
          {display.description ? <p className="dsh-dot-approval-desc">{display.description}</p> : null}
          {why ? <p className="dsh-dot-approval-why">{why}</p> : null}
          {command ? <pre className="dsh-dot-cmd">{command}</pre> : null}
          {dir || sandbox ? (
            <p className="dsh-dot-approval-meta">
              {dir ? <span title={dir}>{uiT(locale, 'approvalDir')} {folderName(dir) ?? dir}</span> : null}
              {dir && sandbox ? ' · ' : null}
              {sandbox ? <span>{uiT(locale, 'approvalSandbox')} {sandbox}</span> : null}
            </p>
          ) : null}
        </>
      ) : dump ? <p className="dsh-dot-approval-raw">{dump}</p> : null}
    </div>
  )
}

/** A focused key-value row for the approval detail panel. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="dsh-dot-detail-row">
      <span className="dsh-dot-detail-label">{label}</span>
      <span className="dsh-dot-detail-value">{value}</span>
    </div>
  )
}

/** Collapsible approval detail panel rendered outside WidgetCard to avoid 2000-char truncation. */
function ApprovalDetailPanel({ detail, locale, missing }: { detail: ApprovalDetail | null | undefined; locale: CopyLocale; missing: boolean }) {
  const [open, setOpen] = useState(false)
  const c = (key: Parameters<typeof uiT>[1]) => uiT(locale, key)
  if (missing) {
    return (
      <p className="dsh-dot-approval-missing" role="note">
        {c('approvalDetailMissing')}
      </p>
    )
  }
  if (!detail) return null
  return (
    <div className="dsh-dot-approval-detail">
      <button type="button" className="dsh-dot-approval-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        {open ? c('approvalDetailHide') : c('approvalDetailShow')}
      </button>
      {open && (
        <div className="dsh-dot-approval-body">
          <DetailRow label={c('approvalToolName')} value={detail.toolName} />
          {detail.reason ? <DetailRow label={c('approvalReason')} value={detail.reason} /> : null}
          {detail.requestId ? <DetailRow label={c('approvalRequestId')} value={detail.requestId} /> : null}
          {detail.sessionId ? <DetailRow label={c('approvalSessionId')} value={detail.sessionId} /> : null}
          {detail.callerSessionId ? <DetailRow label={c('approvalCallerSessionId')} value={detail.callerSessionId} /> : null}
          {detail.callId ? <DetailRow label={c('approvalCallId')} value={detail.callId} /> : null}
          {detail.arguments != null ? (
            <div className="dsh-dot-detail-row">
              <span className="dsh-dot-detail-label">{c('approvalArguments')}</span>
              <pre className="dsh-dot-detail-args">{detail.arguments}</pre>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function createDotCards(call: (endpoint: string, payload: unknown) => Promise<unknown>, locale?: CardLocale): { Card: CardComponent } {
  const subscribe = (listener: () => void) => locale?.subscribe(listener) ?? (() => {})
  const active = () => locale?.getSnapshot().active ?? 'en'
  const Card: CardComponent = props => {
    const language = useSyncExternalStore(subscribe, active)
    const loc = copyLocale(language)
    const dict = cardCopy(loc)
    const t = useCallback((key: string, params?: Record<string, unknown>) => {
      const text = loc !== 'en' && translationKeys.has(key) ? dict[translationKeys.get(key)!] : key
      return text.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? `{${name}}`))
    }, [loc, dict])
    const labels = useMemo<MarkdownLabels>(() => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') }), [t])
    const meta = props.presentation as { title?: unknown; view?: unknown; viewId?: string; dotCard?: { number?: number; expired?: boolean } } | undefined
    const presentationExpired = meta?.dotCard?.expired === true
    const shown = useMemo(() => checkShownView(meta?.title ?? props.title, meta?.view ?? props.view), [meta?.title, meta?.view, props.title, props.view])
    const valid = !('error' in shown) && !props.failed ? shown : undefined
    const id = meta?.viewId
    const restored = useMemo(() => valid ? checkedAnswer(props.answer, id, valid.view) : null, [props.answer, id, valid])
    const [localAnswer, setAnswer] = useState<Answer | null>(null)
    const [pending, setPending] = useState(false)
    const [rpcExpired, setRpcExpired] = useState(false)
    const [busy, setBusy] = useState(false)
    const answering = useRef(false)
    const [failed, setFailed] = useState(false)
    const [detailFailed, setDetailFailed] = useState(false)
    const [answerStatus, setAnswerStatus] = useState<'answered' | 'busy'>()
    // Approval detail state: null = not loaded, undefined = not an approval card
    const [approvalDetail, setApprovalDetail] = useState<ApprovalDetail | null | undefined>(undefined)
    const [detailMissing, setDetailMissing] = useState(false)
    // Notification retry state
    const [notifyPending, setNotifyPending] = useState(false)
    const [retryBusy, setRetryBusy] = useState(false)
    const [retryFailed, setRetryFailed] = useState(false)
    const answer = restored ?? localAnswer
    // Derive expiry from either the RPC response or the live presentation metadata.
    // presentationExpired reflects the host snapshot and re-renders immediately when
    // the card transitions from valid to expired without a new RPC round-trip.
    const expired = rpcExpired || presentationExpired
    useEffect(() => {
      let cancelled = false
      setPending(false); setRpcExpired(false); setDetailFailed(false); setAnswerStatus(undefined); setFailed(false); setAnswer(null)
      setApprovalDetail(undefined); setDetailMissing(false)
      setNotifyPending(false); setRetryFailed(false)
      if (!valid?.interactive || !id) return
      // Restore card state from persisted record via card.detail.
      void call('card.detail', { viewId: id }).then(record => {
        if (cancelled) return
        if (record !== null && typeof record === 'object') {
          const rec = record as { id?: unknown; expired?: unknown; approvalId?: unknown; approvalDetail?: unknown; notificationPending?: unknown; answer?: unknown }
          const matched = rec.id === id
          if (!matched) return
          // Always restore approvalDetail and notifyPending regardless of answer state,
          // so a remounted answered card still shows full parameters and the retry UI.
          setNotifyPending(rec.notificationPending === true)
          if (rec.approvalId !== undefined) {
            if (rec.approvalDetail && typeof rec.approvalDetail === 'object') {
              setApprovalDetail(rec.approvalDetail as ApprovalDetail)
            } else {
              // Approval card but no detail stored — explicit missing warning.
              setDetailMissing(true)
            }
          }
          setRpcExpired(rec.expired === true)
          if (rec.answer) {
            setAnswer(checkedAnswer(rec.answer as Answer, id, valid.view))
            setAnswerStatus('answered')
          } else setPending(true)
        } else setDetailFailed(true)
      }, () => { if (!cancelled) setDetailFailed(true) })
      return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [call, id, valid?.interactive])
    const submit = useCallback((action: string, values: Record<string, unknown>) => {
      if (!id || !pending || expired || busy || answering.current) return
      answering.current = true
      setBusy(true); setFailed(false)
      void call('card.answer', { viewId: id, action, values }).then(result => {
        const res = result !== null && typeof result === 'object' ? result as { notificationPending?: unknown } : null
        const np = res?.notificationPending === true
        setAnswer({ id, action, values }); setPending(false)
        setNotifyPending(np)
      }, async failure => {
        setPending(false)
        try {
          const record = await call('card.detail', { viewId: id })
          if (!record || typeof record !== 'object' || (record as { id?: unknown }).id !== id) {
            setDetailFailed(true)
            return
          }
          const rec = record as { expired?: unknown; answer?: unknown; notificationPending?: unknown }
          setNotifyPending(rec.notificationPending === true)
          if (rec.answer) {
            setAnswer(valid ? checkedAnswer(rec.answer as Answer, id, valid.view) : null)
            setAnswerStatus('answered')
          } else if (rec.expired === true) setRpcExpired(true)
          else if (String(failure).includes('already being answered')) setAnswerStatus('busy')
          else if (rec.expired === false && rec.notificationPending !== true) setPending(true)
        } catch { setDetailFailed(true) }
        setFailed(true)
      }).finally(() => { answering.current = false; setBusy(false) })
    }, [call, id, pending, expired, busy, valid])
    const retryNotification = useCallback(() => {
      if (!id || retryBusy) return
      setRetryBusy(true); setRetryFailed(false)
      void call('card.retryNotification', { viewId: id }).then(() => {
        setNotifyPending(false)
      }, () => setRetryFailed(true)).finally(() => setRetryBusy(false))
    }, [call, id, retryBusy])
    if (!valid) return <div className="dvui-root" role="alert">{dict.invalid}</div>
    // An expired card is still shown (not settled/hidden) but its submit is disabled.
    const canAnswer = valid.interactive && pending && !expired && answer === null && !notifyPending
    const approval = isApprovalView(valid.view)
    const dump = approval ? approvalDumpText(valid.view) : ''
    // checkedAnswer keeps validating against valid.view; only the widget loses the model dump.
    const shownView = approval && Array.isArray(valid.view.children)
      ? { ...valid.view, children: valid.view.children.filter(child => child.type !== 'text') }
      : valid.view
    const localNote = expired && !answer ? uiT(loc, 'cardsHint') : dict.local
    const detailPanel = (approvalDetail !== undefined || detailMissing) && (
      <ApprovalDetailPanel detail={approvalDetail} locale={loc} missing={detailMissing} />
    )
    const widget = (
      <WidgetCard title={approval ? '' : valid.title} view={shownView}
        onSubmit={canAnswer ? submit : undefined} busy={busy} answer={answer}
        settled={answer !== null || (valid.interactive && !pending && answer === null) || notifyPending}
        localOnly={valid.interactive && (!pending || expired) && answer === null && !notifyPending}
        localNote={localNote} t={t} labels={labels} Markdown={MarkdownText} ButtonComponent={CardButton} />
    )
    return (
      <div className="dvui-root">
        {approval ? (
          <div className="dsh-dot-approval-card" data-expired={expired && !answer ? '' : undefined}>
            <ApprovalSummary detail={approvalDetail ?? null} dump={dump} locale={loc} />
            {detailPanel}
            {widget}
          </div>
        ) : (
          <>
            {widget}
            {detailPanel}
          </>
        )}
        {notifyPending && (
          <div className="dsh-dot-notify-retry" role="status">
            <span>{uiT(loc, 'notifyPending')}</span>
            <button type="button" className="dsh-dot-retry-btn" disabled={retryBusy} onClick={retryNotification}>
              {uiT(loc, 'notifyRetry')}
            </button>
            {retryFailed ? <span role="alert">{uiT(loc, 'notifyRetryFailed')}</span> : null}
          </div>
        )}
        {detailFailed ? <p className="dsh-dot-card-status" data-tone="error" role="alert">{uiT(loc, 'cardDetailFailed')}</p> : null}
        {expired && !answer && !valid.interactive ? <p className="dsh-dot-card-status" role="status">{uiT(loc, 'cardsHint')}</p> : null}
        {answerStatus ? <p className="dsh-dot-card-status" role="status">{uiT(loc, answerStatus === 'answered' ? 'cardAnswered' : 'cardAnswerBusy')}</p> : null}
        {failed && !notifyPending && !expired && !answerStatus ? <p className="dsh-dot-card-status" data-tone="error" role="alert">{dict.answerFailed}</p> : null}
      </div>
    )
  }
  return { Card }
}
