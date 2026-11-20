/**
 * Dorothy's own chat. Her sessions carry the subagent origin, so the host's
 * conversation view never shows them; this panel draws them as one chat instead:
 * messages, tool activity, task updates, deep-view cards, a marker where the
 * conversation moved to a new session segment, and a composer. It long-polls
 * the host feed and redraws on every change.
 */
import {
  Button, DisclosureRow, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconWarningOutlineRegular,
  MarkdownText, Modal, modalSelector, StateDot, Tag, TextShimmer, UserMessageBubble,
  type MarkdownLabels, type StateDotState, type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { Board, boardCounts, type BoardFilter } from './board.tsx'
import { groupBoard, headerBoardCounts, sessionLookup } from './board-groups.ts'
import { filterVisibleChat } from './chat-filter.ts'
import { formatToolDetail, parseNotice, permissionLabel, resolveSessionBadge, summarizeNotice, summarizeToolCall, summarizeToolGroup, type NoticeEntry, type ParsedNotice, type SessionBadge, type TaskLookup } from './chat-format.ts'
import { BellGlyph, Composer, GearGlyph, JumpGlyph, NarrowGlyph, ToolGlyph, WidenGlyph } from './composer.tsx'
import {
  useBoard, useChatFeed, useContextUse, useDrawerGuard, useLocalEchoes, useReminderRemoval, useScrollPin, useSettings,
  type DrawerAction, type DrawerTab,
} from './chat-hooks.ts'
import { ContextPanel, type ContextApi } from './context-panel.tsx'
import { PersonaPanel, type KnowledgeApi } from './persona-panel.tsx'
import { TrajectoryPanel, type TrajectoryApi } from './trajectory-panel.tsx'
import type { BoardView, ChatItem, ChatSnapshot, DotSettings, RolloverReason } from './contracts.ts'
import type { ChatImage } from './chat-images.ts'
import { SettingsPanel, type SaveNotice, type SettingsApi } from './settings-panel.tsx'
import type { RenderFactorySlot } from '@klarkxy/dsh-plugin-kit/model-picker'
import { cardCopy, fillText, intlLocale, t, toolLabel, type CopyLocale, type TextKey } from './ui-copy.ts'
import { WorkBoardPanel, type WorkApi } from './work-board.tsx'
import type { WorkAcceptPayload, PendingGlance, WorkBoardItem, WorkReadRequest, WorkRejectPayload } from './work-board.ts'
import { DotAvatar } from './whale.tsx'

export { chatCss } from './chat-panel-css.ts'
export type { DrawerTab } from './chat-hooks.ts'


export const CHAT_ROOT = 'dsh-dot-chat'

export interface ChatApi extends SettingsApi, ContextApi, TrajectoryApi, KnowledgeApi {
  chat(itemsRev: number, signal: AbortSignal): Promise<ChatSnapshot | undefined>
  wait(rev: number, itemsRev: number, signal: AbortSignal): Promise<ChatSnapshot | undefined>
  say(text: string, images?: readonly ChatImage[]): Promise<void>
  stop(): Promise<void>
  board(signal: AbortSignal): Promise<BoardView>
  /** Remove one of Dorothy's reminders from the board. */
  removeSchedule(id: string): Promise<boolean>
  workAccept?(payload: WorkAcceptPayload): Promise<void>
  workReject?(payload: WorkRejectPayload): Promise<void>
  workAnswer?(payload: { readonly id: string; readonly allow: boolean; readonly note?: string }): Promise<void>
  workResume?(payload: { readonly id: string }): Promise<void>
  workForceRelease?(payload: { readonly id: string }): Promise<void>
  workRead?(request: WorkReadRequest): Promise<{ readonly source: string; readonly body: string; readonly truncated?: boolean; readonly totalBytes?: number }>
  settings(signal: AbortSignal): Promise<DotSettings>
}

/** deep-view's client card, read from its service when that plugin is installed. */
export type CardComponent = ComponentType<{ sessionId: string; callId: string; presentation?: unknown; title?: unknown; view?: unknown; failed?: boolean; answer?: { id: string; action: string; values: Record<string, unknown> } }>

const NO_PENDING: readonly PendingGlance[] = []
const NO_WORK: readonly WorkBoardItem[] = []

export type Row =
  | { kind: 'item'; item: ChatItem; lead: boolean }
  | { kind: 'tools'; key: string; items: Extract<ChatItem, { kind: 'tool' }>[]; lead: boolean }

/** Consecutive tool calls fold into one activity row; a reply block shows the avatar once.
 *  A failed card stays: the filter already drops one when later text covers it, and an idle check must show the failure. */
export function rowsOf(items: readonly ChatItem[]): Row[] {
  const rows: Row[] = []
  let inReply = false
  for (const item of items) {
    const replyPart = item.kind === 'bot' || item.kind === 'tool' || item.kind === 'view' || item.kind === 'error'
    const lead = replyPart && !inReply
    inReply = replyPart
    const last = rows.at(-1)
    if (item.kind === 'tool' && last?.kind === 'tools') { last.items.push(item); continue }
    rows.push(item.kind === 'tool' ? { kind: 'tools', key: item.key, items: [item], lead } : { kind: 'item', item, lead })
  }
  return rows
}

interface DrawerProps {
  readonly locale: CopyLocale
  readonly api: ChatApi
  readonly tab: DrawerTab
  readonly wide: boolean
  readonly settings?: DotSettings
  readonly trajectoryRev?: number
  readonly running: boolean
  readonly waiting: number
  readonly proposalCount: number
  readonly tasks: ReactNode
  readonly renderFactorySlot?: RenderFactorySlot
  readonly personaDirty: boolean
  readonly pendingAction?: DrawerAction
  readonly discardSignal: number
  readonly onRequest: (action: DrawerAction) => void
  readonly onCancelPending: () => void
  readonly onDiscardPending: () => void
  readonly onDirtyChange: (dirty: boolean) => void
  readonly onWide: () => void
  readonly onSaved: (next: DotSettings) => void
  readonly onProposalCount: (count: number) => void
}

/**
 * One drawer docked beside the chat for the board and every settings page.
 * It has no backdrop, so the conversation and the composer stay usable while it is open.
 */
function WorkDrawer({ locale, api, tab, wide, settings, trajectoryRev, running, waiting, proposalCount, tasks, renderFactorySlot, personaDirty, pendingAction, discardSignal, onRequest, onCancelPending, onDiscardPending, onDirtyChange, onWide, onSaved, onProposalCount }: DrawerProps) {
  const [saveNotice, setSaveNotice] = useState<SaveNotice>()
  useEffect(() => { setSaveNotice(undefined) }, [tab])
  const requestClose = useCallback(() => { onRequest({ kind: 'close' }) }, [onRequest])
  const requestTab = useCallback((next: DrawerTab) => { onRequest({ kind: 'tab', tab: next }) }, [onRequest])
  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector(modalSelector)) requestClose()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [requestClose])
  useEffect(() => {
    if (saveNotice?.kind !== 'saved') return
    const timer = setTimeout(() => setSaveNotice(undefined), 2200)
    return () => clearTimeout(timer)
  }, [saveNotice])
  const isTasks = tab === 'tasks'
  const items: readonly { value: DrawerTab; label: string; title: string; badge: number }[] = isTasks ? [
    { value: 'tasks', label: t(locale, 'tasks'), title: t(locale, 'tasks'), badge: waiting },
  ] : [
    { value: 'settings', label: t(locale, 'settings'), title: t(locale, 'settings'), badge: proposalCount },
    { value: 'persona', label: t(locale, 'tabPersona'), title: t(locale, 'personaTitle'), badge: 0 },
    { value: 'context', label: t(locale, 'tabContext'), title: t(locale, 'ctxTitle'), badge: 0 },
    { value: 'trajectory', label: t(locale, 'viewTrajectory'), title: t(locale, 'trTitle'), badge: 0 },
  ]
  const activeItem = items.find(item => item.value === tab) ?? items[0]!
  return (
    <div className="dsh-dot-drawer-layer">
    <button type="button" tabIndex={-1} className="dsh-dot-drawer-backdrop" aria-label={t(locale, 'closeDrawer')} onClick={requestClose} />
    <aside className="dsh-dot-drawer" data-kind={isTasks ? 'tasks' : 'settings'} data-wide={wide ? '' : undefined} role="dialog" aria-label={isTasks ? t(locale, 'tasks') : t(locale, 'settings')}>
      <header className="dsh-dot-drawer-head">
        {isTasks ? (
          <h2 className="dsh-dot-drawer-title">
            {t(locale, 'tasks')}
            {waiting > 0 ? <span className="dsh-dot-nav-badge">{waiting}</span> : null}
          </h2>
        ) : (
        <nav className="dsh-dot-drawer-tabs" aria-label={t(locale, 'drawerTabs')}>
          {items.map(item => (
            <button
              key={item.value}
              type="button"
              aria-pressed={tab === item.value}
              aria-controls={`dsh-dot-drawer-panel-${item.value}`}
              onClick={() => requestTab(item.value)}
            >
              <span className="dsh-dot-nav-label">{item.label}</span>
              {item.badge > 0 ? <span className="dsh-dot-nav-badge">{item.badge}</span> : null}
              {item.value === 'persona' && personaDirty ? <span className="dsh-dot-dirty-dot" aria-hidden="true" /> : null}
            </button>
          ))}
        </nav>
        )}
        <span className="dsh-dot-spacer" />
        {saveNotice?.kind === 'saved' ? (
          <span className="dsh-dot-settings-status" role="status">
            <IconCheckOutlineRegular size={13} />
            {t(locale, 'saved')}
          </span>
        ) : null}
        {saveNotice?.kind === 'error' ? (
          <span className="dsh-dot-settings-status dsh-dot-settings-status--error" role="alert" title={saveNotice.message}>
            {t(locale, 'saveFailed')}{saveNotice.message}
          </span>
        ) : null}
        <Button variant="ghost" size="sm" className="dsh-dot-drawer-widen" icon={wide ? <NarrowGlyph /> : <WidenGlyph />} aria-label={t(locale, wide ? 'narrowDrawer' : 'widenDrawer')} title={t(locale, wide ? 'narrowDrawer' : 'widenDrawer')} aria-pressed={wide} onClick={onWide} />
        <Button variant="ghost" size="sm" icon={<IconCloseOutlineRegular size={15} />} aria-label={t(locale, 'closeDrawer')} title={t(locale, 'closeDrawer')} onClick={requestClose} />
      </header>
      {pendingAction ? (
        <div className="dsh-dot-unsaved-bar" role="alert">
          <span>{t(locale, 'unsavedChanges')}</span>
          <span className="dsh-dot-spacer" />
          <Button variant="ghost" size="sm" onClick={onCancelPending}>{t(locale, 'unsavedKeepEditing')}</Button>
          <Button variant="primary" size="sm" onClick={onDiscardPending}>{t(locale, 'unsavedDiscard')}</Button>
        </div>
      ) : null}
      <div className="dsh-dot-settings-scroll">
        <div className="dsh-dot-settings" data-tab={tab} id={`dsh-dot-drawer-panel-${tab}`} role="region" aria-label={activeItem.title}>
          {tab === 'tasks'
            ? tasks
            : tab === 'settings'
              ? <SettingsPanel locale={locale} api={api} {...settings ? { settings } : {}} onSaved={onSaved} onStatusChange={setSaveNotice} onProposalCount={onProposalCount} {...renderFactorySlot ? { renderFactorySlot } : {}} />
              : tab === 'persona'
                ? <PersonaPanel locale={locale} api={api} {...settings ? { settings } : {}} discardSignal={discardSignal} onDirtyChange={onDirtyChange} onSaved={onSaved} onStatusChange={setSaveNotice} />
                : tab === 'context'
                  ? <ContextPanel locale={locale} api={api} running={running} />
                  : <TrajectoryPanel locale={locale} api={api} {...trajectoryRev === undefined ? {} : { rev: trajectoryRev }} running={running} />}
        </div>
      </div>
    </aside>
    </div>
  )
}

/** The board tab: a filter row, the work changes waiting on the human, then the board. */
function TasksTab({ locale, view, workApi, boardError, pendingRemoveTitle, onUndoRemove, onOpen, onRetry, onRemoveSchedule }: {
  locale: CopyLocale; view?: BoardView; workApi?: WorkApi; boardError?: string
  pendingRemoveTitle?: string; onUndoRemove?: () => void
  onOpen: (sessionId: string) => void; onRetry: () => void; onRemoveSchedule: (id: string) => void
}) {
  const [filter, setFilter] = useState<BoardFilter>('all')
  const counts = boardCounts(view)
  const totalCount = useMemo(() => {
    if (!view) return 0
    const groups = groupBoard(view)
    const openWork = (view.work ?? []).filter(w => w.status !== 'done' && w.status !== 'cancelled').length
    return openWork + groups.requests.length + groups.watched.length + view.schedules.length
  }, [view])
  const filters: readonly { value: BoardFilter; label: string }[] = [
    { value: 'all', label: totalCount > 0 ? `${t(locale, 'filterAll')} (${totalCount})` : t(locale, 'filterAll') },
    { value: 'waiting', label: `${t(locale, 'filterWaiting')} (${counts.waiting})` },
    { value: 'active', label: `${t(locale, 'filterActive')} (${counts.active})` },
    { value: 'watch', label: `${t(locale, 'filterWatch')} (${counts.watch})` },
  ]
  return (
    <div className="dsh-dot-tasks">
      <div className="dsh-dot-filters" role="group" aria-label={t(locale, 'tasks')}>
        {filters.map(item => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}
      </div>
      {pendingRemoveTitle && onUndoRemove ? (
        <div className="dsh-dot-undo-bar" role="status">
          <span className="dsh-dot-undo-text">{fillText(t(locale, 'reminderRemoved'), { title: pendingRemoveTitle })}</span>
          <Button variant="ghost" size="sm" onClick={onUndoRemove}>{t(locale, 'undoAction')}</Button>
        </div>
      ) : null}
      {workApi && filter !== 'watch' ? <WorkBoardPanel locale={locale} api={workApi} filter={filter} items={view?.work ?? NO_WORK} pending={view?.pending ?? NO_PENDING} onChanged={onRetry} onOpenSession={onOpen} /> : null}
      <Board locale={locale} view={view} filter={filter} suppressEmpty={(view?.work?.length ?? 0) > 0 || (Boolean(workApi) && filter === 'all')} {...boardError === undefined ? {} : { error: boardError }} onOpen={onOpen} onRetry={onRetry} onRemoveSchedule={onRemoveSchedule} />
    </div>
  )
}

/** Live context occupancy for the header pill; read again whenever the log changes or a turn ends. */
function compactTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K` : String(value)
}
export interface ChatPanelProps {
  readonly locale: CopyLocale
  readonly api: ChatApi
  readonly Card?: CardComponent
  readonly onOpenSession: (sessionId: string) => void
  readonly renderFactorySlot?: RenderFactorySlot
}

function imageCacheKey(text: string, images: readonly { readonly mediaType: string; readonly name?: string }[]): string {
  return `${text.trim()}\0${images.map(img => `${img.mediaType}:${img.name ?? ''}`).join('|')}`
}

export function ChatPanel({ locale, api, Card, onOpenSession, renderFactorySlot }: ChatPanelProps) {
  const { state, error, retry } = useChatFeed(api)
  const [rawBoard, boardError, refreshBoard] = useBoard(api, state.snapshot?.boardRev)
  const { board, pendingRemoval, removeSchedule, undoRemoveSchedule } = useReminderRemoval(api, refreshBoard, rawBoard)
  const workApi = useMemo<WorkApi | undefined>(() => {
    if (!api.workAccept || !api.workReject || !api.workAnswer || !api.workResume) return undefined
    return {
      workAccept: api.workAccept, workReject: api.workReject, workAnswer: api.workAnswer, workResume: api.workResume,
      ...(api.workForceRelease ? { workForceRelease: api.workForceRelease } : {}),
      ...(api.workRead ? { workRead: api.workRead } : {}),
    }
  }, [api])
  const snapshot = state.snapshot
  const running = snapshot?.running === true
  const streaming = snapshot?.streaming ?? ''
  const [sentPreviews, setSentPreviews] = useState<Readonly<Record<string, readonly string[]>>>({})
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string }>()
  const [sendError, setSendError] = useState<string>()
  const [settings, setSettings] = useSettings(api)
  const [proposalCount, setProposalCount] = useState(0)
  useEffect(() => {
    const life = new AbortController()
    api.settingProposals(life.signal).then(rows => { if (!life.signal.aborted) setProposalCount(rows.length) }, () => {})
    return () => life.abort()
  }, [api])
  const { drawerTab, drawerWide, personaDirty, discardSignal, pendingDrawerAction, configOpen, requestDrawer, discardDrawerAction, cancelDrawerAction, setPersonaDirty, toggleDrawerWide } = useDrawerGuard()
  const labels = useMemo<MarkdownLabels>(() => {
    const c = cardCopy(locale)
    return { code: { copyLabel: c.copy, copiedLabel: c.copied }, footnotes: c.footnotes }
  }, [locale])

  const { pendingEchoes, pushEcho, removeEcho } = useLocalEchoes(state.items)

  const send = useCallback(async (text: string, images: readonly ChatImage[]) => {
    setSendError(undefined)
    const echo = pushEcho(text, images)
    try {
      await api.say(text, images)
    } catch (failure) {
      removeEcho(echo)
      const message = failure instanceof Error ? failure.message : String(failure)
      setSendError(/\bHTTP 413\b/.test(message) ? t(locale, 'sendTooLarge') : message)
      throw failure
    }
    // Keep the local bytes only for a message the host accepted: a rejected send must not
    // leave a thumbnail keyed by text and file name for the next message that happens to match.
    if (images.length > 0) {
      const key = imageCacheKey(text, images)
      const urls = images.map(img => `data:${img.mediaType};base64,${img.data}`)
      setSentPreviews(prev => ({ ...prev, [key]: urls }))
    }
  }, [api, locale, pushEcho, removeEcho])

  const hasStreaming = Boolean(streaming.trim())
  const preparingCard = snapshot?.preparingCard === true
  const filtered = useMemo(() => filterVisibleChat(state.items, { streaming: hasStreaming, running, preparingCard }), [state.items, hasStreaming, running, preparingCard])
  const rows = useMemo(() => rowsOf(filtered.items), [filtered.items])
  const composerInsert = useRef<((text: string) => void) | undefined>(undefined)
  const activitySig = `${rows.length}:${snapshot?.itemsRev ?? 0}:${streaming.length}`
  const { scroller, pinned, unreadBelow, onScroll, scrollToBottom } = useScrollPin(activitySig, [rows, streaming, pendingEchoes, running])

  const counts = useMemo(() => headerBoardCounts(board), [board])
  const live = counts.liveCount
  // The badge counts requests, human-review items, drafts, and closeout-ready Changes.
  const waiting = counts.waitingCount
  const tasksBySession = useMemo<TaskLookup>(() => sessionLookup(board), [board])
  // The log is the heaviest part of the panel (markdown, cards). Keeping its elements stable lets
  // opening a drawer, typing or a board poll skip redrawing every message.
  const sessionId = snapshot?.sessionId ?? ''
  const openPreview = useCallback((src: string, name: string) => setPreviewImage({ src, name }), [])
  const logRows = useMemo(() => rows.map(row => <Fragment key={row.kind === 'tools' ? 'tools:' + row.key : row.item.key}>{renderRow(row, { locale, labels, Card, sessionId, answers: state.answers, hiddenRequestIds: filtered.hiddenRequestIds, tasks: tasksBySession, sentPreviews, onPreviewImage: openPreview, onOpenSession })}</Fragment>), [rows, locale, labels, Card, sessionId, state.answers, filtered.hiddenRequestIds, tasksBySession, sentPreviews, openPreview, onOpenSession])
  const lastRow = rows.at(-1)
  const lastTool = lastRow?.kind === 'tools'
  const lastInReply = lastRow !== undefined && (lastRow.kind === 'tools' || lastRow.item.kind === 'bot' || lastRow.item.kind === 'view' || lastRow.item.kind === 'error')
  const showStreaming = running && !preparingCard && hasStreaming
  const showThinking = running && !preparingCard && !hasStreaming && !lastTool && !filtered.silentTail
  const segmentCount = useMemo(() => 1 + state.items.filter(item => item.kind === 'segment').length, [state.items])
  const contextUse = useContextUse(api, snapshot?.itemsRev, running)
  const contextPct = contextUse ? Math.min(100, (contextUse.used / contextUse.window) * 100) : undefined

  return (
    <div className={CHAT_ROOT}>
      <header className="dsh-dot-head">
        <DotAvatar size={28} />
        <div className="dsh-dot-head-text">
          <span className="dsh-dot-name">{t(locale, 'dot')}</span>
          <span className="dsh-dot-status" data-running={running ? '' : undefined}><span className="dsh-dot-status-dot" aria-hidden="true" />{running ? t(locale, 'working') : t(locale, 'online')}</span>
          {segmentCount > 1 ? <span className="dsh-dot-segment-count" title={t(locale, 'segmentMark')}>{t(locale, 'segmentNumber').replace('{n}', String(segmentCount))}</span> : null}
        </div>
        <span className="dsh-dot-spacer" />
        {contextUse && contextPct !== undefined ? (
          <Button variant="ghost" size="sm" className="dsh-dot-ctx-pill" aria-pressed={drawerTab === 'context'} title={t(locale, 'ctxPill').replace('{pct}', `${contextPct.toFixed(1)}%`)} onClick={() => requestDrawer(drawerTab === 'context' ? { kind: 'close' } : { kind: 'tab', tab: 'context' })}>
            <span className="dsh-dot-ctx-track" aria-hidden="true"><span style={{ width: `${contextPct}%` }} /></span>
            <span className="dsh-dot-ctx-num">{compactTokens(contextUse.used)}</span>
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" aria-expanded={drawerTab === 'tasks'} aria-pressed={drawerTab === 'tasks'} onClick={() => requestDrawer(drawerTab === 'tasks' ? { kind: 'close' } : { kind: 'tab', tab: 'tasks' })}>
          {t(locale, 'tasks')}{live > 0 ? ` ${live}` : ''}{waiting > 0 ? <span className="dsh-dot-badge">{waiting}</span> : null}
        </Button>
        <Button variant="ghost" size="sm" className="dsh-dot-gear" aria-label={t(locale, 'settings')} aria-pressed={configOpen} title={t(locale, 'settings')} onClick={() => requestDrawer(configOpen ? { kind: 'close' } : { kind: 'tab', tab: 'settings' })}>
          <GearGlyph />
          {proposalCount > 0 ? <span className="dsh-dot-gear-dot" aria-hidden="true" /> : null}
        </Button>
      </header>
      <div className="dsh-dot-stage">
      <section className="dsh-dot-chatcol">
      <div className="dsh-dot-scroll-wrap">
      <div className="dsh-dot-scroll" ref={scroller} onScroll={onScroll}>
        <div className="dsh-dot-log" role="log" aria-live="polite" aria-relevant="additions">
          {snapshot === undefined && error === undefined ? <div className="dsh-dot-center"><DotAvatar size={56} /><span className="dsh-dot-muted">{t(locale, 'loading')}</span></div> : null}
          {snapshot !== undefined && rows.length === 0 && pendingEchoes.length === 0 && !showStreaming && (!running || filtered.silentTail) ? (
            <div className="dsh-dot-center">
              <DotAvatar size={72} />
              <span className="dsh-dot-greeting">{t(locale, 'greeting')}</span>
              <span className="dsh-dot-muted">{t(locale, 'greetingHint')}</span>
              <div className="dsh-dot-starters">
                {(['starter1', 'starter2', 'starter3'] as const).map(key => (
                  <button key={key} type="button" className="dsh-dot-starter" disabled={running} onClick={() => composerInsert.current?.(t(locale, key))}>{t(locale, key)}</button>
                ))}
              </div>
            </div>
          ) : null}
          {logRows}
          {pendingEchoes.map(echo => <div key={'echo:' + echo.at} className="dsh-dot-user dsh-dot-echo">{echo.text ? <UserMessageBubble>{echo.text}</UserMessageBubble> : null}{echo.images.length > 0 ? <ImageNotes locale={locale} images={echo.images.map(image => ({ mediaType: image.mediaType, previewUrl: `data:${image.mediaType};base64,${image.data}`, ...(image.name ? { name: image.name } : {}) }))} onPreview={openPreview} /> : null}</div>)}
          {showStreaming ? <BotLine lead={!lastInReply}><MarkdownText text={streaming} labels={labels} variant="body" streaming /></BotLine> : null}
          {preparingCard ? <BotLine lead={!lastInReply}><span role="status"><TextShimmer active>{t(locale, 'cardPreparing')}</TextShimmer></span></BotLine> : null}
          {showThinking ? <BotLine lead={!lastInReply}><TextShimmer active>{t(locale, 'thinking')}</TextShimmer></BotLine> : null}
        </div>
      </div>
      {!pinned ? (
        <button type="button" className="dsh-dot-scroll-fab" data-unread={unreadBelow ? '' : undefined} onClick={scrollToBottom}>
          <IconChevronDownOutlineRegular size={13} />
          <span>{t(locale, unreadBelow ? 'scrollNew' : 'scrollBottom')}</span>
        </button>
      ) : null}
      </div>
      {error !== undefined ? (
        <div className="dsh-dot-banner-wrap">
          <div className="dsh-dot-banner" role="alert">
            <IconWarningOutlineRegular size={14} className="dsh-dot-banner-icon" />
            <span className="dsh-dot-banner-text">{t(locale, 'loadFailed')}: {error}</span>
            <Button variant="ghost" size="sm" onClick={retry}>{t(locale, 'retry')}</Button>
          </div>
        </div>
      ) : null}
      <Composer
        locale={locale}
        sessionId={sessionId}
        running={running}
        disabled={snapshot === undefined}
        items={state.items}
        onNewSegment={() => api.newSegment()}
        onOpenTasks={() => requestDrawer({ kind: 'tab', tab: 'tasks' })}
        onOpenSettings={() => requestDrawer({ kind: 'tab', tab: 'settings' })}
        onSend={send}
        onStop={() => { void api.stop() }}
        onDismissError={() => setSendError(undefined)}
        insertRef={composerInsert}
        {...sendError === undefined ? {} : { error: sendError }}
      />
      </section>
      {drawerTab !== null ? (
        <WorkDrawer
          locale={locale}
          api={api}
          tab={drawerTab}
          wide={drawerWide}
          {...settings ? { settings } : {}}
          {...snapshot ? { trajectoryRev: snapshot.itemsRev } : {}}
          running={running}
          waiting={waiting}
          proposalCount={proposalCount}
          tasks={<TasksTab locale={locale} {...board ? { view: board } : {}} {...workApi ? { workApi } : {}} {...boardError === undefined ? {} : { boardError }} {...pendingRemoval ? { pendingRemoveTitle: pendingRemoval.title, onUndoRemove: undoRemoveSchedule } : {}} onOpen={onOpenSession} onRetry={refreshBoard} onRemoveSchedule={removeSchedule} />}
          {...renderFactorySlot ? { renderFactorySlot } : {}}
          personaDirty={personaDirty}
          {...pendingDrawerAction ? { pendingAction: pendingDrawerAction } : {}}
          discardSignal={discardSignal}
          onRequest={requestDrawer}
          onCancelPending={cancelDrawerAction}
          onDiscardPending={discardDrawerAction}
          onDirtyChange={setPersonaDirty}
          onWide={toggleDrawerWide}
          onSaved={setSettings}
          onProposalCount={setProposalCount}
        />
      ) : null}
      </div>
      <Modal
        open={previewImage !== undefined}
        onClose={() => setPreviewImage(undefined)}
        title={previewImage?.name ?? t(locale, 'imagePreview')}
        closeLabel={t(locale, 'closeDrawer')}
      >
        {previewImage ? (
          <div className="dsh-dot-lightbox">
            <img src={previewImage.src} alt={previewImage.name} className="dsh-dot-lightbox-img" />
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

const SEGMENT_REASON: Record<RolloverReason, TextKey> = {
  'context-full': 'segmentWhy_contextFull', 'idle-expired': 'segmentWhy_idle', 'model-switch': 'segmentWhy_model',
  'prompt-changed': 'segmentWhy_prompt', 'capabilities-changed': 'segmentWhy_capabilities', lost: 'segmentWhy_lost', manual: 'segmentWhy_manual', 'dot-requested': 'segmentWhy_dot',
}

/** Where the conversation moved to a new session segment; opening it says why and when. */
function SegmentMark({ locale, reason, at }: { locale: CopyLocale; reason?: RolloverReason; at: number }) {
  const [open, setOpen] = useState(false)
  const when = new Date(at).toLocaleString(intlLocale(locale), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  return (
    <div className="dsh-dot-segment-wrap">
      <div className="dsh-dot-segment" role="separator">
        <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          <span>{t(locale, 'segmentMark')}</span>
          <span className="dsh-dot-segment-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
      </div>
      {open ? (
        <div className="dsh-dot-segment-note">
          <span className="dsh-dot-segment-time">{when}</span>
          <span>{t(locale, reason ? SEGMENT_REASON[reason] : 'segmentWhy_unknown')}</span>
        </div>
      ) : null}
    </div>
  )
}

function BotLine({ lead, children }: { lead: boolean; children: ReactNode }) {
  return (
    <div className="dsh-dot-bot">
      <span className="dsh-dot-gutter">{lead ? <DotAvatar size={28} /> : null}</span>
      <div className="dsh-dot-body">{children}</div>
    </div>
  )
}

interface RenderContext {
  readonly locale: CopyLocale
  readonly labels: MarkdownLabels
  readonly Card?: CardComponent
  readonly sessionId: string
  readonly answers: NonNullable<ChatSnapshot['answers']>
  readonly hiddenRequestIds: ReadonlySet<string>
  readonly tasks: TaskLookup
  readonly sentPreviews: Readonly<Record<string, readonly string[]>>
  readonly onPreviewImage: (src: string, name: string) => void
  readonly onOpenSession: (sessionId: string) => void
}

function renderRow(row: Row, context: RenderContext): ReactNode {
  if (row.kind === 'tools') return <BotLine lead={row.lead}><ToolActivity locale={context.locale} items={row.items} tasks={context.tasks} onOpenSession={context.onOpenSession} /></BotLine>
  const item = row.item
  switch (item.kind) {
    case 'user': {
      const previews = item.images && item.images.length > 0 ? context.sentPreviews[imageCacheKey(item.text, item.images)] : undefined
      return (
        <div className="dsh-dot-user">
          {item.text ? <UserMessageBubble>{item.text}</UserMessageBubble> : null}
          {item.images && item.images.length > 0 ? (
            <ImageNotes
              locale={context.locale}
              images={item.images.map((img, idx) => ({ ...img, ...(previews?.[idx] ? { previewUrl: previews[idx] } : {}) }))}
              onPreview={context.onPreviewImage}
            />
          ) : null}
        </div>
      )
    }
    case 'answer':
      return <div className="dsh-dot-user dsh-dot-answer"><UserMessageBubble>{item.text}</UserMessageBubble></div>
    case 'notice':
      return <Notice locale={context.locale} text={item.text} {...item.notice ? { structured: item.notice } : {}} hiddenRequestIds={context.hiddenRequestIds} tasks={context.tasks} onOpenSession={context.onOpenSession} />
    case 'segment':
      return <SegmentMark locale={context.locale} reason={item.reason} at={item.at} />
    case 'bot':
      return <BotLine lead={row.lead}><MarkdownText text={item.text} labels={context.labels} variant="body" /></BotLine>
    case 'error':
      return <BotLine lead={row.lead}><div className="dsh-dot-turn-error"><StateDot state="error" /><span><strong>{t(context.locale, 'errorTitle')}</strong> {item.text}</span></div></BotLine>
    case 'view': {
      if (item.failed) {
        return <BotLine lead={row.lead}><div className="dsh-dot-turn-error" role="alert"><StateDot state="error" /><span>{t(context.locale, 'cardFailed')}</span></div></BotLine>
      }
      const Card = context.Card
      const viewId = typeof item.presentation?.viewId === 'string' ? item.presentation.viewId : undefined
      const answer = viewId ? context.answers[viewId] : undefined
      const badge = item.presentation?.dotCard as { number?: number; expired?: boolean } | undefined
      return (
        <BotLine lead={row.lead}>
          <div className="dsh-dot-view" data-expired={badge?.expired && !answer ? '' : undefined}>
          {badge?.number ? <div className="dsh-dot-view-number" title={badge.expired && !answer ? t(context.locale, 'cardsHint') : undefined}><Tag tone="quiet">#{badge.number}{badge.expired && !answer ? ` · ${t(context.locale, 'cardExpired')}` : ''}</Tag></div> : null}
          {Card
            ? <Card sessionId={context.sessionId} callId={item.key} {...item.presentation ? { presentation: item.presentation } : {}} title={item.title} view={item.view} {...item.failed ? { failed: true } : {}} {...answer && viewId ? { answer: { id: viewId, ...answer } } : {}} />
            : <span className="dsh-dot-muted">{t(context.locale, 'cardsMissing')}</span>}
          </div>
        </BotLine>
      )
    }
    default:
      return null
  }
}

function SessionLink({ badge, locale, onOpen }: { badge: SessionBadge; locale: CopyLocale; onOpen: (sessionId: string) => void }) {
  return (
    <button
      type="button"
      className="dsh-dot-session-btn"
      title={`${t(locale, 'openSessionTip')} · ${badge.tooltip}`}
      onClick={() => onOpen(badge.sessionId)}
    >
      <span className="dsh-dot-session-label">{badge.label}</span>
      <JumpGlyph />
    </button>
  )
}

function RowSummary({ text, tone }: { text: string; tone?: 'normal' | 'muted' | 'error' }) {
  return (
    <>
      <span className="dsh-dot-row-sep" data-shimmer-decoration aria-hidden="true" />
      <span className="dsh-dot-row-summary" data-tone={tone}>{text}</span>
    </>
  )
}

function ToolCallRow({
  item,
  single,
  locale,
  tasks,
  onOpenSession,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>
  single?: boolean
  locale: CopyLocale
  tasks: TaskLookup
  onOpenSession: (sessionId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen(value => !value), [])
  const call = useMemo(() => summarizeToolCall(item, locale, tasks), [item, locale, tasks])
  const detail = useMemo(() => formatToolDetail(item, locale, tasks), [item, locale, tasks])
  const state: StateDotState = item.status === 'running'
    ? 'ongoing'
    : item.status === 'error'
      ? 'error'
      : detail?.tone === 'muted' || call.tone === 'muted'
        ? 'idle'
        : 'done'
  const expandable = detail !== undefined
  const icon = single && item.status !== 'error' ? <ToolGlyph /> : <StateDot state={state} />
  const collapsedNode = call.summary
    ? <RowSummary text={call.summary} {...call.tone ? { tone: call.tone } : {}} />
    : undefined

  return (
    <DisclosureRow
      icon={icon}
      title={toolLabel(locale, item.name)}
      open={open && expandable}
      expandable={expandable}
      onToggle={toggle}
      running={item.status === 'running'}
      expandOnRowClick
      keepContentWhenOpen
      collapsedContent={collapsedNode}
      className="dsh-dot-activity"
      contentClassName="dsh-dot-row-content"
      contentLayoutClassName="dsh-dot-row-layout"
    >
      {detail ? (
        <div className="dsh-dot-tool-body" data-tone={detail.tone} data-multiline={detail.multiline ? '' : undefined}>
          <div className="dsh-dot-tool-text">{detail.text}</div>
          {detail.session ? (
            detail.multiline
              ? <div className="dsh-dot-tool-foot"><SessionLink badge={detail.session} locale={locale} onOpen={onOpenSession} /></div>
              : <SessionLink badge={detail.session} locale={locale} onOpen={onOpenSession} />
          ) : null}
        </div>
      ) : null}
    </DisclosureRow>
  )
}

function ToolActivity({ locale, items, tasks, onOpenSession }: { locale: CopyLocale; items: Extract<ChatItem, { kind: 'tool' }>[]; tasks: TaskLookup; onOpenSession: (sessionId: string) => void }) {
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen(value => !value), [])
  const summary = useMemo(() => summarizeToolGroup(items, locale, tasks), [items, locale, tasks])
  if (items.length === 1) {
    return <ToolCallRow item={items[0]!} single locale={locale} tasks={tasks} onOpenSession={onOpenSession} />
  }
  const running = items.some(item => item.status === 'running')
  const latest = items.at(-1)!
  const title = `${toolLabel(locale, latest.name)} · ${items.length} ${t(locale, 'actions')}`
  const collapsedNode = summary ? <RowSummary text={summary} /> : undefined
  return (
    <DisclosureRow
      icon={<ToolGlyph />}
      title={title}
      open={open}
      expandable
      onToggle={toggle}
      running={running}
      expandOnRowClick
      collapsedContent={collapsedNode}
      className="dsh-dot-activity"
      contentClassName="dsh-dot-row-content"
      contentLayoutClassName="dsh-dot-row-layout"
    >
      <div className="dsh-dot-tool-group">
        {items.map(item => (
          <ToolCallRow key={item.key} item={item} locale={locale} tasks={tasks} onOpenSession={onOpenSession} />
        ))}
      </div>
    </DisclosureRow>
  )
}

const NOTICE_TAG_TONE: Record<Exclude<NoticeEntry['kind'], 'reminder'>, TagTone> = {
  approval: 'warning',
  question: 'info',
  'turn-end': 'success',
  error: 'danger',
  'task-human': 'info',
  'idle-check': 'quiet',
  inbox: 'info',
}

function noticeTagLabel(locale: CopyLocale, kind: Exclude<NoticeEntry['kind'], 'reminder'>): string {
  switch (kind) {
    case 'approval': return t(locale, 'approval')
    case 'question': return t(locale, 'question')
    case 'turn-end': return t(locale, 'turnEnd')
    case 'error': return t(locale, 'error')
    case 'task-human': return t(locale, 'taskHuman')
    case 'idle-check': return t(locale, 'idleCheck')
    case 'inbox': return t(locale, 'inboxEvent')
  }
}

function NoticeCard({ entry, locale, tasks, onOpenSession }: { entry: NoticeEntry; locale: CopyLocale; tasks: TaskLookup; onOpenSession: (sessionId: string) => void }) {
  if (entry.kind === 'reminder') {
    const timing = [
      entry.due,
      entry.once ? t(locale, 'reminderOnce') : entry.next ? t(locale, 'reminderNext').replace('{when}', entry.next) : undefined,
    ].filter(Boolean).join(' · ')
    return (
      <div className="dsh-dot-notice-entry">
        <div className="dsh-dot-card-head">
          <Tag tone="info">{t(locale, 'reminderTag')}</Tag>
          <span className="dsh-dot-card-subject">{entry.title}</span>
          {entry.late ? <Tag tone="warning">{t(locale, 'lateDelivery')}</Tag> : null}
          {timing ? (
            <>
              <span className="dsh-dot-spacer" />
              <span className="dsh-dot-card-meta">{timing}</span>
            </>
          ) : null}
        </div>
        {entry.prompt ? <div className="dsh-dot-card-body">{entry.prompt}</div> : null}
      </div>
    )
  }

  const badge = resolveSessionBadge(entry.sessionId, tasks, {
    ...entry.taskTitle ? { taskTitle: entry.taskTitle } : {},
    ...entry.cwd ? { cwd: entry.cwd } : {},
  })
  const perm = permissionLabel(locale, entry.permission)
  const hasQuestions = Boolean(entry.questions && entry.questions.length > 0)

  return (
    <div className="dsh-dot-notice-entry" data-kind={entry.kind}>
      <div className="dsh-dot-card-head">
        <Tag tone={NOTICE_TAG_TONE[entry.kind]}>{noticeTagLabel(locale, entry.kind)}</Tag>
        {entry.kind === 'approval' && entry.subject ? <code className="dsh-dot-code-pill">{entry.subject}</code> : null}
        {entry.requestId ? <span className="dsh-dot-req-id">{entry.requestId}</span> : null}
        {perm ? <Tag tone="outline">{perm}</Tag> : null}
        {entry.viaSubagent ? <Tag tone="quiet">{t(locale, 'subagentTag')}</Tag> : null}
        <span className="dsh-dot-spacer" />
        <SessionLink badge={badge} locale={locale} onOpen={onOpenSession} />
      </div>
      {entry.reason ? <div className="dsh-dot-card-body">{entry.reason}</div> : null}
      {entry.description ? <div className="dsh-dot-card-desc">{entry.description}</div> : null}
      {entry.command ? <pre className="dsh-dot-cmd">{entry.command}</pre> : null}
      {hasQuestions ? (
        <div className="dsh-dot-questions">
          {entry.questions!.map(item => (
            <div key={item.id} className="dsh-dot-question-item">
              <div className="dsh-dot-card-body">
                {item.question}
                {item.multiSelect ? <span className="dsh-dot-question-multi">（{t(locale, 'multiSelect')}）</span> : null}
              </div>
              {item.options && item.options.length > 0 ? (
                <div className="dsh-dot-question-opts">
                  {item.options.map(opt => <Tag key={opt} tone="neutral">{opt}</Tag>)}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : entry.kind === 'question' && entry.subject ? (
        <div className="dsh-dot-card-body">{entry.subject}</div>
      ) : null}
      {entry.extraArgs && entry.extraArgs.length > 0 ? (
        <div className="dsh-dot-kv-list">
          {entry.extraArgs.map(pair => (
            <div key={pair.key} className="dsh-dot-kv-row">
              <span className="dsh-dot-kv-key">{pair.key}</span>
              <span className="dsh-dot-kv-val">{pair.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {entry.summary !== undefined ? (
        <div className={'dsh-dot-card-body' + (entry.kind === 'error' ? ' dsh-dot-card-error' : '')}>
          {entry.summary === '(no text)' ? t(locale, 'noReplyText') : entry.summary}
        </div>
      ) : null}
    </div>
  )
}

function Notice({ locale, text, structured, hiddenRequestIds, tasks, onOpenSession }: { locale: CopyLocale; text: string; structured?: ParsedNotice; hiddenRequestIds?: ReadonlySet<string>; tasks: TaskLookup; onOpenSession: (sessionId: string) => void }) {
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen(value => !value), [])
  const parsed = useMemo(() => {
    const base = structured ?? parseNotice(text)
    if (!hiddenRequestIds || hiddenRequestIds.size === 0 || base.isReminder || base.entries.length === 0) return base
    return {
      ...base,
      entries: base.entries.filter(entry => entry.kind === 'reminder' || !entry.requestId || !hiddenRequestIds.has(entry.requestId)),
    }
  }, [text, structured, hiddenRequestIds])
  const summary = useMemo(() => summarizeNotice(parsed, locale, tasks), [parsed, locale, tasks])
  const collapsedNode = summary ? <RowSummary text={summary} /> : undefined
  return (
    <div className="dsh-dot-notice">
      <DisclosureRow
        icon={<BellGlyph />}
        title={t(locale, parsed.isReminder ? 'reminderNotice' : 'notice')}
        open={open}
        expandable
        onToggle={toggle}
        expandOnRowClick
        collapsedContent={collapsedNode}
        contentClassName="dsh-dot-row-content"
        contentLayoutClassName="dsh-dot-row-layout"
      >
        <div className="dsh-dot-notice-list">
          {parsed.entries.length > 0
            ? parsed.entries.map((entry, idx) => <NoticeCard key={idx} entry={entry} locale={locale} tasks={tasks} onOpenSession={onOpenSession} />)
            : <div className="dsh-dot-notice-entry"><div className="dsh-dot-card-body">{parsed.fallback ?? text}</div></div>}
        </div>
      </DisclosureRow>
    </div>
  )
}

function ImageNotes({ locale, images, onPreview }: {
  locale: CopyLocale
  images: readonly { readonly mediaType: string; readonly name?: string; readonly previewUrl?: string }[]
  onPreview?: (src: string, name: string) => void
}) {
  return (
    <div className="dsh-dot-images">
      {images.map((image, index) => {
        const label = image.name ? `${t(locale, 'imageAttached')} · ${image.name}` : t(locale, 'imageAttached')
        if (image.previewUrl && onPreview) {
          return (
            <button
              key={`${image.name ?? image.mediaType}:${index}`}
              type="button"
              className="dsh-dot-image-thumb"
              title={t(locale, 'imagePreview')}
              onClick={() => onPreview(image.previewUrl!, image.name ?? t(locale, 'imageAttached'))}
            >
              <img src={image.previewUrl} alt={label} className="dsh-dot-image-thumb-img" />
              <span className="dsh-dot-image-thumb-name">{label}</span>
            </button>
          )
        }
        return <span key={`${image.name ?? image.mediaType}:${index}`} className="dsh-dot-image-chip">{label}</span>
      })}
    </div>
  )
}
