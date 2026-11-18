/**
 * Dorothy's own chat. Her sessions carry the subagent origin, so the host's
 * conversation view never shows them; this panel draws them as one chat instead:
 * messages, tool activity, task updates, deep-view cards, a marker where the
 * conversation moved to a new session segment, and a composer. It long-polls
 * the host feed and redraws on every change.
 */
import {
  Button, DisclosureRow, IconCheckOutlineRegular, IconCloseOutlineRegular, IconWarningOutlineRegular,
  MarkdownText, StateDot, Tag, TextShimmer, Tooltip, UserMessageBubble, useDismissOnOutsidePointer,
  type MarkdownLabels, type StateDotState, type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type ComponentType, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Board, boardCounts, type BoardFilter } from './board.tsx'
import { headerBoardCounts, sessionLookup } from './board-groups.ts'
import { filterVisibleChat } from './chat-filter.ts'
import { formatToolDetail, parseNotice, permissionLabel, resolveSessionBadge, summarizeNotice, summarizeToolCall, summarizeToolGroup, type NoticeEntry, type ParsedNotice, type SessionBadge, type TaskLookup } from './chat-format.ts'
import { ContextPanel, type ContextApi } from './context-panel.tsx'
import { PersonaPanel, type KnowledgeApi } from './persona-panel.tsx'
import { TrajectoryPanel, type TrajectoryApi } from './trajectory-panel.tsx'
import type { BoardView, ChatItem, ChatSnapshot, DotSettings, RolloverReason } from './contracts.ts'
import { CHAT_IMAGE_LIMIT, ChatImageRejected, imageName, inspectImageBytes, type ChatImage, type ChatImageError } from './chat-images.ts'
import { SettingsPanel, settingsCss, type SaveNotice, type SettingsApi } from './settings-panel.tsx'
import type { RenderFactorySlot } from '@klarkxy/dsh-plugin-kit/model-picker'
import { cardCopy, intlLocale, t, toolLabel, type CopyLocale, type TextKey } from './ui-copy.ts'
import { WorkBoardPanel, type WorkApi } from './work-board.tsx'
import type { WorkAcceptPayload, PendingGlance, WorkBoardItem, WorkReadRequest, WorkRejectPayload } from './work-board.ts'
import { DotAvatar } from './whale.tsx'

export const CHAT_ROOT = 'dsh-dot-chat'

const BOARD_POLL_MS = 5_000
const BOARD_FALLBACK_POLL_MS = 30_000
const RETRY_MS = 2_000
/** A sent message waits this long to show up in the log before its local echo is dropped. */
const ECHO_MS = 60_000
const STICK_PX = 96

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
  workAnswer?(payload: { readonly id: string; readonly allow: boolean }): Promise<void>
  workResume?(payload: { readonly id: string }): Promise<void>
  workForceRelease?(payload: { readonly id: string }): Promise<void>
  workRead?(request: WorkReadRequest): Promise<{ readonly source: string; readonly body: string; readonly truncated?: boolean; readonly totalBytes?: number }>
  settings(signal: AbortSignal): Promise<DotSettings>
}

/** deep-view's client card, read from its service when that plugin is installed. */
export type CardComponent = ComponentType<{ sessionId: string; callId: string; presentation?: unknown; title?: unknown; view?: unknown; failed?: boolean; answer?: { id: string; action: string; values: Record<string, unknown> } }>

interface ChatState {
  readonly snapshot?: ChatSnapshot
  readonly items: readonly ChatItem[]
  readonly answers: NonNullable<ChatSnapshot['answers']>
}

/** Keep the item list across snapshots that leave it out. */
function merge(state: ChatState, next: ChatSnapshot | undefined): ChatState {
  if (!next) return state
  return next.items ? { snapshot: next, items: next.items, answers: next.answers ?? {} } : { ...state, snapshot: next }
}

function useChatFeed(api: ChatApi): { state: ChatState; error?: string; retry: () => void } {
  const [state, setState] = useState<ChatState>({ items: [], answers: {} })
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const lifetime = new AbortController()
    let current: ChatState = { items: [], answers: {} }
    const apply = (next: ChatSnapshot | undefined) => { current = merge(current, next); setState(current); setError(undefined) }
    void (async () => {
      while (!lifetime.signal.aborted) {
        try {
          const known = current.snapshot
          apply(known ? await api.wait(known.rev, known.itemsRev, lifetime.signal) : await api.chat(0, lifetime.signal))
        } catch (failure) {
          if (lifetime.signal.aborted) return
          setError(failure instanceof Error ? failure.message : String(failure))
          await new Promise(resolve => setTimeout(resolve, RETRY_MS))
        }
      }
    })()
    return () => lifetime.abort()
  }, [api, attempt])
  return { state, ...error === undefined ? {} : { error }, retry: useCallback(() => setAttempt(value => value + 1), []) }
}

function useBoard(api: ChatApi, feedBoardRev?: number): [BoardView | undefined, string | undefined, () => void] {
  const [view, setView] = useState<BoardView>()
  const [error, setError] = useState<string>()
  const [round, setRound] = useState(0)
  const lastTextRef = useRef('')
  const pollMs = feedBoardRev !== undefined ? BOARD_FALLBACK_POLL_MS : BOARD_POLL_MS
  useEffect(() => {
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    // An unchanged poll keeps the old object, so the chat and the board do not redraw every few seconds.
    const run = () => {
      api.board(lifetime.signal).then(next => {
        if (lifetime.signal.aborted) return
        const text = JSON.stringify(next)
        if (text !== lastTextRef.current) { lastTextRef.current = text; setView(next) }
        setError(undefined)
      }, failure => {
        if (!lifetime.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
      }).finally(() => {
        if (!lifetime.signal.aborted) timer = setTimeout(run, pollMs)
      })
    }
    run()
    return () => { lifetime.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [api, round, feedBoardRev, pollMs])
  return [view, error, useCallback(() => setRound(value => value + 1), [])]
}

function useSettings(api: ChatApi): [DotSettings | undefined, (next: DotSettings) => void] {
  const [settings, setSettings] = useState<DotSettings>()
  useEffect(() => {
    const lifetime = new AbortController()
    api.settings(lifetime.signal).then(setSettings, () => {})
    return () => lifetime.abort()
  }, [api])
  return [settings, setSettings]
}

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

export type DrawerTab = 'tasks' | 'settings' | 'persona' | 'context' | 'trajectory'
const CONFIG_TABS: ReadonlySet<DrawerTab> = new Set(['settings', 'persona', 'context', 'trajectory'])

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
  readonly onTab: (tab: DrawerTab) => void
  readonly onWide: () => void
  readonly onSaved: (next: DotSettings) => void
  readonly onProposalCount: (count: number) => void
  readonly onClose: () => void
}

/**
 * One drawer docked beside the chat for the board and every settings page.
 * It has no backdrop, so the conversation and the composer stay usable while it is open.
 */
function WorkDrawer({ locale, api, tab, wide, settings, trajectoryRev, running, waiting, proposalCount, tasks, renderFactorySlot, onTab, onWide, onSaved, onProposalCount, onClose }: DrawerProps) {
  const [saveNotice, setSaveNotice] = useState<SaveNotice>()
  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose])
  useEffect(() => { setSaveNotice(undefined) }, [tab])
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
    <button type="button" tabIndex={-1} className="dsh-dot-drawer-backdrop" aria-label={t(locale, 'closeDrawer')} onClick={onClose} />
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
              onClick={() => onTab(item.value)}
            >
              <span className="dsh-dot-nav-label">{item.label}</span>
              {item.badge > 0 ? <span className="dsh-dot-nav-badge">{item.badge}</span> : null}
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
        <Button variant="ghost" size="sm" icon={<IconCloseOutlineRegular size={15} />} aria-label={t(locale, 'closeDrawer')} title={t(locale, 'closeDrawer')} onClick={onClose} />
      </header>
      <div className="dsh-dot-settings-scroll">
        <div className="dsh-dot-settings" data-tab={tab} id={`dsh-dot-drawer-panel-${tab}`} role="region" aria-label={activeItem.title}>
          {tab === 'tasks'
            ? tasks
            : tab === 'settings'
              ? <SettingsPanel locale={locale} api={api} {...settings ? { settings } : {}} onSaved={onSaved} onStatusChange={setSaveNotice} onProposalCount={onProposalCount} {...renderFactorySlot ? { renderFactorySlot } : {}} />
              : tab === 'persona'
                ? <PersonaPanel locale={locale} api={api} {...settings ? { settings } : {}} onSaved={onSaved} onStatusChange={setSaveNotice} />
                : tab === 'context'
                  ? <ContextPanel locale={locale} api={api} running={running} />
                  : <TrajectoryPanel locale={locale} api={api} {...trajectoryRev === undefined ? {} : { rev: trajectoryRev }} running={running} />}
        </div>
      </div>
    </aside>
    </div>
  )
}

/** The board tab: a filter row, the work changes waiting on the human, then the ticket board. */
function TasksTab({ locale, view, workApi, boardError, onOpen, onRetry, onRemoveSchedule }: {
  locale: CopyLocale; view?: BoardView; workApi?: WorkApi; boardError?: string
  onOpen: (sessionId: string) => void; onRetry: () => void; onRemoveSchedule: (id: string) => void
}) {
  const [filter, setFilter] = useState<BoardFilter>('all')
  const counts = boardCounts(view)
  const filters: readonly { value: BoardFilter; label: string }[] = [
    { value: 'all', label: t(locale, 'filterAll') },
    { value: 'waiting', label: `${t(locale, 'filterWaiting')} (${counts.waiting})` },
    { value: 'active', label: `${t(locale, 'filterActive')} (${counts.active})` },
    { value: 'watch', label: `${t(locale, 'filterWatch')} (${counts.watch})` },
  ]
  return (
    <div className="dsh-dot-tasks">
      <div className="dsh-dot-filters" role="group" aria-label={t(locale, 'tasks')}>
        {filters.map(item => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}
      </div>
      {workApi && filter !== 'watch' ? <WorkBoardPanel locale={locale} api={workApi} filter={filter} items={view?.work ?? NO_WORK} pending={view?.pending ?? NO_PENDING} onChanged={onRetry} /> : null}
      <Board locale={locale} view={view} filter={filter} suppressEmpty={(view?.work?.length ?? 0) > 0} {...boardError === undefined ? {} : { error: boardError }} onOpen={onOpen} onRetry={onRetry} onRemoveSchedule={onRemoveSchedule} />
    </div>
  )
}

/** Live context occupancy for the header pill; read again whenever the log changes or a turn ends. */
function useContextUse(api: ChatApi, rev: number | undefined, running: boolean): { used: number; window: number } | undefined {
  const [use, setUse] = useState<{ used: number; window: number }>()
  useEffect(() => {
    if (rev === undefined || running) return
    const life = new AbortController()
    api.context(life.signal).then(view => {
      if (life.signal.aborted) return
      setUse(view.usedTokens !== undefined && view.contextWindow ? { used: view.usedTokens, window: view.contextWindow } : undefined)
    }, () => {})
    return () => life.abort()
  }, [api, rev, running])
  return use
}

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

export function ChatPanel({ locale, api, Card, onOpenSession, renderFactorySlot }: ChatPanelProps) {
  const { state, error, retry } = useChatFeed(api)
  const [board, boardError, refreshBoard] = useBoard(api, state.snapshot?.boardRev)
  const removeSchedule = useCallback((id: string) => { void api.removeSchedule(id).then(refreshBoard, refreshBoard) }, [api, refreshBoard])
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
  const [echoes, setEchoes] = useState<{ text: string; at: number; images: readonly ChatImage[] }[]>([])
  const [sendError, setSendError] = useState<string>()
  const [drawerTab, setDrawerTab] = useState<DrawerTab | null>(null)
  const [drawerWide, setDrawerWide] = useState(false)
  const [settings, setSettings] = useSettings(api)
  const [proposalCount, setProposalCount] = useState(0)
  useEffect(() => {
    const life = new AbortController()
    api.settingProposals(life.signal).then(rows => { if (!life.signal.aborted) setProposalCount(rows.length) }, () => {})
    return () => life.abort()
  }, [api])
  const closeDrawer = useCallback(() => setDrawerTab(null), [])
  const configOpen = drawerTab !== null && CONFIG_TABS.has(drawerTab)
  const labels = useMemo<MarkdownLabels>(() => {
    const c = cardCopy(locale)
    return { code: { copyLabel: c.copy, copiedLabel: c.copied }, footnotes: c.footnotes }
  }, [locale])

  // A local echo leaves once the log holds a matching message sent after it.
  // Filtered during render as well, so the frame that brings the logged copy
  // never shows both.
  const delivered = useCallback((echo: { text: string; at: number; images: readonly ChatImage[] }) => state.items.some(item => item.kind === 'user' && item.text.trim() === echo.text && (item.images?.length ?? 0) === echo.images.length && item.at >= echo.at - 5_000), [state.items])
  const pendingEchoes = useMemo(() => echoes.filter(echo => !delivered(echo)), [echoes, delivered])
  useEffect(() => {
    if (echoes.length === 0) return
    const now = Date.now()
    const left = echoes.filter(echo => now - echo.at < ECHO_MS && !delivered(echo))
    if (left.length !== echoes.length) setEchoes(left)
  }, [echoes, delivered])

  const send = useCallback(async (text: string, images: readonly ChatImage[]) => {
    setSendError(undefined)
    const echo = { text, at: Date.now(), images }
    setEchoes(list => [...list, echo])
    try { await api.say(text, images) } catch (failure) {
      setEchoes(list => list.filter(item => item !== echo))
      const message = failure instanceof Error ? failure.message : String(failure)
      setSendError(/\bHTTP 413\b/.test(message) ? t(locale, 'sendTooLarge') : message)
      throw failure
    }
  }, [api])

  const hasStreaming = Boolean(streaming.trim())
  const preparingCard = snapshot?.preparingCard === true
  const filtered = useMemo(() => filterVisibleChat(state.items, { streaming: hasStreaming, running }), [state.items, hasStreaming, running])
  const rows = useMemo(() => rowsOf(filtered.items), [filtered.items])
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const lastTop = useRef(0)
  // Direction-aware: any real upward scroll releases the bottom pin, even within STICK_PX of the
  // bottom, so streaming updates cannot yank the viewport back. Scrolling back down to within
  // STICK_PX re-pins. A scrollTop drop that lands at the bottom is a browser clamp after the
  // content shrank, not a user gesture, so it keeps the pin.
  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    const up = el.scrollTop < lastTop.current - 3 && gap > 3
    stuck.current = up ? false : gap < STICK_PX
    lastTop.current = el.scrollTop
  }, [])
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stuck.current) {
      el.scrollTop = el.scrollHeight
      lastTop.current = el.scrollTop
    }
  }, [rows, streaming, pendingEchoes, running])

  const counts = useMemo(() => headerBoardCounts(board), [board])
  const live = counts.liveCount
  // The badge counts requests, human-review items, drafts, and closeout-ready Changes.
  const waiting = counts.waitingCount
  const tasksBySession = useMemo<TaskLookup>(() => sessionLookup(board), [board])
  // The log is the heaviest part of the panel (markdown, cards). Keeping its elements stable lets
  // opening a drawer, typing or a board poll skip redrawing every message.
  const sessionId = snapshot?.sessionId ?? ''
  const logRows = useMemo(() => rows.map(row => <Fragment key={row.kind === 'tools' ? 'tools:' + row.key : row.item.key}>{renderRow(row, { locale, labels, Card, sessionId, answers: state.answers, hiddenRequestIds: filtered.hiddenRequestIds, tasks: tasksBySession, onOpenSession })}</Fragment>), [rows, locale, labels, Card, sessionId, state.answers, filtered.hiddenRequestIds, tasksBySession, onOpenSession])
  const lastTool = rows.at(-1)?.kind === 'tools'
  const showThinking = running && !preparingCard && !lastTool && !filtered.silentTail
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
          <Button variant="ghost" size="sm" className="dsh-dot-ctx-pill" aria-pressed={drawerTab === 'context'} title={t(locale, 'ctxPill').replace('{pct}', `${contextPct.toFixed(1)}%`)} onClick={() => setDrawerTab(current => current === 'context' ? null : 'context')}>
            <span className="dsh-dot-ctx-track" aria-hidden="true"><span style={{ width: `${contextPct}%` }} /></span>
            <span className="dsh-dot-ctx-num">{compactTokens(contextUse.used)}</span>
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" aria-expanded={drawerTab === 'tasks'} aria-pressed={drawerTab === 'tasks'} onClick={() => setDrawerTab(current => current === 'tasks' ? null : 'tasks')}>
          {t(locale, 'tasks')} {live}{waiting > 0 ? <span className="dsh-dot-badge">{waiting}</span> : null}
        </Button>
        <Button variant="ghost" size="sm" className="dsh-dot-gear" aria-label={t(locale, 'settings')} aria-pressed={configOpen} title={t(locale, 'settings')} onClick={() => setDrawerTab(configOpen ? null : 'settings')}>
          <GearGlyph />
          {proposalCount > 0 ? <span className="dsh-dot-gear-dot" aria-hidden="true" /> : null}
        </Button>
      </header>
      <div className="dsh-dot-stage">
      <section className="dsh-dot-chatcol">
      <div className="dsh-dot-scroll" ref={scroller} onScroll={onScroll}>
        <div className="dsh-dot-log">
          {snapshot === undefined && error === undefined ? <div className="dsh-dot-center"><DotAvatar size={56} /><span className="dsh-dot-muted">{t(locale, 'loading')}</span></div> : null}
          {snapshot !== undefined && rows.length === 0 && pendingEchoes.length === 0 && (!running || filtered.silentTail) ? (
            <div className="dsh-dot-center">
              <DotAvatar size={72} />
              <span className="dsh-dot-greeting">{t(locale, 'greeting')}</span>
              <span className="dsh-dot-muted">{t(locale, 'greetingHint')}</span>
              <div className="dsh-dot-starters">
                {(['starter1', 'starter2', 'starter3'] as const).map(key => (
                  <button key={key} type="button" className="dsh-dot-starter" disabled={running} onClick={() => { void send(t(locale, key), []).catch(() => {}) }}>{t(locale, key)}</button>
                ))}
              </div>
            </div>
          ) : null}
          {logRows}
          {pendingEchoes.map(echo => <div key={'echo:' + echo.at} className="dsh-dot-user dsh-dot-echo"><UserMessageBubble>{echo.text}</UserMessageBubble>{echo.images.length > 0 ? <ImageNotes locale={locale} images={echo.images.map(image => ({ mediaType: image.mediaType, ...(image.name ? { name: image.name } : {}) }))} /> : null}</div>)}
          {preparingCard ? <BotLine lead={!lastTool}><span role="status"><TextShimmer active>{t(locale, 'cardPreparing')}</TextShimmer></span></BotLine> : null}
          {showThinking ? <BotLine lead={!lastTool}><TextShimmer active>{t(locale, 'thinking')}</TextShimmer></BotLine> : null}
        </div>
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
        onOpenTasks={() => setDrawerTab('tasks')}
        onOpenSettings={() => setDrawerTab('settings')}
        onSend={send}
        onStop={() => { void api.stop() }}
        onDismissError={() => setSendError(undefined)}
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
          tasks={<TasksTab locale={locale} {...board ? { view: board } : {}} {...workApi ? { workApi } : {}} {...boardError === undefined ? {} : { boardError }} onOpen={onOpenSession} onRetry={refreshBoard} onRemoveSchedule={removeSchedule} />}
          {...renderFactorySlot ? { renderFactorySlot } : {}}
          onTab={setDrawerTab}
          onWide={() => setDrawerWide(value => !value)}
          onSaved={setSettings}
          onProposalCount={setProposalCount}
          onClose={closeDrawer}
        />
      ) : null}
      </div>
    </div>
  )
}

const SEGMENT_REASON: Record<RolloverReason, TextKey> = {
  'context-full': 'segmentWhy_contextFull', 'idle-expired': 'segmentWhy_idle', 'model-switch': 'segmentWhy_model',
  'prompt-changed': 'segmentWhy_prompt', lost: 'segmentWhy_lost', manual: 'segmentWhy_manual', 'dot-requested': 'segmentWhy_dot',
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
  readonly onOpenSession: (sessionId: string) => void
}

function renderRow(row: Row, context: RenderContext): ReactNode {
  if (row.kind === 'tools') return <BotLine lead={row.lead}><ToolActivity locale={context.locale} items={row.items} tasks={context.tasks} onOpenSession={context.onOpenSession} /></BotLine>
  const item = row.item
  switch (item.kind) {
    case 'user':
      return (
        <div className="dsh-dot-user">
          {item.text ? <UserMessageBubble>{item.text}</UserMessageBubble> : null}
          {item.images && item.images.length > 0 ? <ImageNotes locale={context.locale} images={item.images} /> : null}
        </div>
      )
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
  archived: 'quiet',
  'lock-free': 'success',
  'task-human': 'info',
  'idle-check': 'quiet',
}

function noticeTagLabel(locale: CopyLocale, kind: Exclude<NoticeEntry['kind'], 'reminder'>): string {
  switch (kind) {
    case 'approval': return t(locale, 'approval')
    case 'question': return t(locale, 'question')
    case 'turn-end': return t(locale, 'turnEnd')
    case 'error': return t(locale, 'error')
    case 'archived': return t(locale, 'archived')
    case 'lock-free': return t(locale, 'lockFree')
    case 'task-human': return t(locale, 'taskHuman')
    case 'idle-check': return t(locale, 'idleCheck')
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

function imageErrorText(locale: CopyLocale, code: ChatImageError): string {
  switch (code) {
    case 'unsupported': return t(locale, 'imageUnsupported')
    case 'too-large': return t(locale, 'imageTooLarge')
    case 'too-many': return t(locale, 'imageTooMany')
    case 'mismatch': return t(locale, 'imageMismatch')
    default: return t(locale, 'imageInvalid')
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

async function readImageFile(file: File): Promise<ChatImage> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const inspected = inspectImageBytes(bytes, file.type)
  if (!inspected.ok) throw new ChatImageRejected(inspected.error)
  const name = imageName(file.name)
  return { mediaType: inspected.mediaType, data: bytesToBase64(bytes), ...(name ? { name } : {}) }
}

function ImageNotes({ locale, images }: { locale: CopyLocale; images: readonly { readonly mediaType: string; readonly name?: string }[] }) {
  return (
    <div className="dsh-dot-images">
      {images.map((image, index) => <span key={`${image.name ?? image.mediaType}:${index}`} className="dsh-dot-image-chip">{t(locale, 'imageAttached')}{image.name ? ` · ${image.name}` : ''}</span>)}
    </div>
  )
}

const COMPOSER_TEXT_LIMIT = 20_000
const DRAFT_KEY_PREFIX = 'dsh-dot:draft:'

function readDraft(sessionId: string): string {
  if (!sessionId) return ''
  try { return globalThis.localStorage?.getItem(DRAFT_KEY_PREFIX + sessionId) ?? '' } catch { return '' }
}

function writeDraft(sessionId: string, value: string): void {
  if (!sessionId) return
  try {
    if (value) globalThis.localStorage?.setItem(DRAFT_KEY_PREFIX + sessionId, value)
    else globalThis.localStorage?.removeItem(DRAFT_KEY_PREFIX + sessionId)
  } catch { /* storage blocked in restricted frames */ }
}

interface SlashCommandItem {
  readonly id: string
  readonly cmd: string
  readonly keywords?: string
  readonly label: string
  readonly desc: string
  readonly disabled?: boolean
  readonly run: () => void
}

/**
 * Lower is a closer match. A command id outranks keywords, and both outrank
 * label and description text, so `/se` stays on `/settings` instead of a
 * sentence that merely contains "session".
 */
function slashMatchRank(item: SlashCommandItem, token: string): number | undefined {
  const id = item.cmd.slice(1)
  if (id === token) return 0
  if (id.startsWith(token)) return 1
  if (id.includes(token) || item.keywords?.toLowerCase().includes(token)) return 2
  if (item.label.toLowerCase().includes(token) || item.desc.toLowerCase().includes(token)) return 3
  return undefined
}

interface ComposerProps {
  readonly locale: CopyLocale
  readonly sessionId: string
  readonly running: boolean
  readonly disabled: boolean
  readonly items: readonly ChatItem[]
  readonly error?: string
  readonly onNewSegment: () => Promise<string>
  readonly onOpenTasks: () => void
  readonly onOpenSettings: () => void
  readonly onSend: (text: string, images: readonly ChatImage[]) => Promise<void>
  readonly onStop: () => void
  readonly onDismissError: () => void
}

function Composer({
  locale, sessionId, running, disabled, items, error,
  onNewSegment, onOpenTasks, onOpenSettings, onSend, onStop, onDismissError,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ChatImage[]>([])
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [localError, setLocalError] = useState<string>()
  const [segmentBusy, setSegmentBusy] = useState(false)
  const [segmentDone, setSegmentDone] = useState(false)
  const [slashPinned, setSlashPinned] = useState(false)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [historyCursor, setHistoryCursor] = useState(-1)
  const historyDraft = useRef('')
  const dragDepth = useRef(0)
  const hydratedSession = useRef('')
  const textRef = useRef('')
  const composerRef = useRef<HTMLDivElement>(null)
  const slashList = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  textRef.current = text

  // The first id keeps text typed before the snapshot arrived. A later id is a new
  // segment: keep the visible draft and store it there, so reload does not leave it
  // on the segment that just ended. An empty composer loads that session's draft.
  useEffect(() => {
    if (!sessionId || hydratedSession.current === sessionId) return
    const previous = hydratedSession.current
    hydratedSession.current = sessionId
    const visible = textRef.current
    if (!previous) {
      const saved = readDraft(sessionId)
      if (!visible && saved) setText(saved)
      else if (visible) writeDraft(sessionId, visible)
      return
    }
    setHistoryCursor(-1)
    historyDraft.current = ''
    if (visible) writeDraft(sessionId, visible)
    else {
      const saved = readDraft(sessionId)
      if (saved) setText(saved)
    }
  }, [sessionId])

  const updateText = useCallback((next: string, resetHistory = true) => {
    setText(next)
    writeDraft(sessionId, next)
    if (resetHistory) setHistoryCursor(-1)
    if (!next.startsWith('/')) setSlashDismissed(false)
  }, [sessionId])

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    const cap = expanded ? 360 : 180
    el.style.height = Math.min(el.scrollHeight, cap) + 'px'
  }, [text, expanded])

  useEffect(() => {
    if (!segmentDone) return
    const timer = setTimeout(() => setSegmentDone(false), 2200)
    return () => clearTimeout(timer)
  }, [segmentDone])

  // dragenter/dragleave are continuous and often both fire before `dragging` re-renders.
  // Counting from the ref, and clearing on dragend, keeps the drop mask from sticking.
  useEffect(() => {
    const end = () => { dragDepth.current = 0; setDragging(false) }
    window.addEventListener('dragend', end)
    return () => window.removeEventListener('dragend', end)
  }, [])

  const sentHistory = useMemo(() => {
    const out: string[] = []
    for (const item of items) {
      if (item.kind === 'user' && item.text.trim()) {
        if (out.at(-1) !== item.text) out.push(item.text)
      }
    }
    return out.slice(-30)
  }, [items])

  const addFiles = useCallback(async (files: readonly File[]) => {
    setLocalError(undefined)
    const next = [...images]
    for (const file of files) {
      if (next.length >= CHAT_IMAGE_LIMIT) { setLocalError(imageErrorText(locale, 'too-many')); break }
      try { next.push(await readImageFile(file)) } catch (failure) {
        setLocalError(failure instanceof ChatImageRejected ? imageErrorText(locale, failure.code) : imageErrorText(locale, 'invalid'))
        break
      }
    }
    setImages(next)
  }, [images, locale])

  const submit = useCallback(() => {
    const body = text.trim()
    if ((!body && images.length === 0) || busy || disabled) return
    setBusy(true)
    setSlashPinned(false)
    const sending = images
    onSend(body, sending)
      .then(() => {
        setText('')
        writeDraft(sessionId, '')
        setImages([])
        setHistoryCursor(-1)
        setExpanded(false)
      }, () => {})
      .finally(() => { setBusy(false); area.current?.focus() })
  }, [text, images, busy, disabled, sessionId, onSend])

  const startNewSegment = useCallback(() => {
    if (disabled || running || segmentBusy) return
    setSegmentBusy(true)
    setLocalError(undefined)
    setSlashPinned(false)
    onNewSegment().then(
      () => { setSegmentDone(true) },
      failure => setLocalError(failure instanceof Error ? failure.message : String(failure)),
    ).finally(() => setSegmentBusy(false))
  }, [disabled, running, segmentBusy, onNewSegment])

  const insertTemplate = useCallback((template: string) => {
    setSlashPinned(false)
    updateText(template)
    requestAnimationFrame(() => {
      const el = area.current
      if (!el) return
      el.focus()
      el.setSelectionRange(template.length, template.length)
    })
  }, [updateText])

  const firePrompt = useCallback((promptText: string) => {
    setSlashPinned(false)
    if (running || busy || disabled) {
      insertTemplate(promptText)
      return
    }
    setBusy(true)
    onSend(promptText, [])
      .then(() => {
        if (text.trim().startsWith('/')) {
          setText('')
          writeDraft(sessionId, '')
        }
      }, () => {})
      .finally(() => { setBusy(false); area.current?.focus() })
  }, [running, busy, disabled, text, sessionId, onSend, insertTemplate])

  const commands = useMemo<readonly SlashCommandItem[]>(() => [
    {
      id: 'overview',
      cmd: '/overview',
      label: t(locale, 'starter1'),
      desc: t(locale, 'cmdOverviewDesc'),
      run: () => firePrompt(t(locale, 'starter1')),
    },
    {
      id: 'pending',
      cmd: '/pending',
      label: t(locale, 'starter2'),
      desc: t(locale, 'cmdPendingDesc'),
      run: () => firePrompt(t(locale, 'starter2')),
    },
    {
      id: 'task',
      cmd: '/task',
      label: t(locale, 'cmdTaskLabel'),
      desc: t(locale, 'cmdTaskDesc'),
      run: () => insertTemplate(t(locale, 'cmdTaskTemplate')),
    },
    {
      id: 'remind',
      cmd: '/remind',
      label: t(locale, 'cmdRemindLabel'),
      desc: t(locale, 'cmdRemindDesc'),
      run: () => insertTemplate(t(locale, 'cmdRemindTemplate')),
    },
    {
      id: 'board',
      cmd: '/board',
      label: t(locale, 'tasks'),
      desc: t(locale, 'cmdBoardDesc'),
      run: () => {
        if (text.trim().startsWith('/')) updateText('')
        setSlashPinned(false)
        onOpenTasks()
      },
    },
    {
      id: 'settings',
      cmd: '/settings',
      keywords: 'model 模型',
      label: t(locale, 'settings'),
      desc: `${t(locale, 'sModel')} · ${t(locale, 'sRequests')}`,
      run: () => {
        if (text.trim().startsWith('/')) updateText('')
        setSlashPinned(false)
        onOpenSettings()
      },
    },
    {
      id: 'segment',
      cmd: '/segment',
      label: t(locale, 'ctxNewSegment'),
      desc: running ? t(locale, 'ctxNewSegmentBusy') : t(locale, 'ctxNewSegmentHelp'),
      disabled: running || segmentBusy,
      run: () => {
        if (text.trim().startsWith('/')) updateText('')
        startNewSegment()
      },
    },
  ], [locale, running, segmentBusy, text, firePrompt, insertTemplate, startNewSegment, updateText, onOpenTasks, onOpenSettings])

  const slashToken = useMemo(() => {
    if (!text.startsWith('/') || text.includes('\n') || /\s/.test(text)) return undefined
    return text.slice(1).toLowerCase()
  }, [text])

  const filteredCommands = useMemo(() => {
    if (slashPinned && slashToken === undefined) return commands
    if (slashToken === undefined) return []
    if (!slashToken) return commands
    return commands
      .map((item, index) => ({ item, index, rank: slashMatchRank(item, slashToken) }))
      .filter((row): row is { item: SlashCommandItem; index: number; rank: number } => row.rank !== undefined)
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(row => row.item)
  }, [commands, slashPinned, slashToken])

  const slashOpen = !disabled && filteredCommands.length > 0 && (slashPinned || (slashToken !== undefined && !slashDismissed))

  useEffect(() => { setSlashIndex(0) }, [slashToken, slashPinned])
  useLayoutEffect(() => {
    if (historyCursor < 0) return
    const el = area.current
    if (!el) return
    const pos = el.value.length
    el.setSelectionRange(pos, pos)
  }, [historyCursor, text])
  useEffect(() => {
    if (!slashOpen) return
    const list = slashList.current
    const active = list?.querySelector<HTMLElement>('[data-active]')
    if (!list || !active) return
    const listRect = list.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    if (listRect.height === 0 || activeRect.height === 0) return
    if (activeRect.top < listRect.top) list.scrollTop -= listRect.top - activeRect.top
    else if (activeRect.bottom > listRect.bottom) list.scrollTop += activeRect.bottom - listRect.bottom
  }, [slashOpen, slashIndex, filteredCommands])
  useDismissOnOutsidePointer(composerRef, slashOpen, open => {
    if (!open) {
      setSlashPinned(false)
      if (slashToken !== undefined) setSlashDismissed(true)
    }
  })

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (slashOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashIndex(idx => (idx + 1) % filteredCommands.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashIndex(idx => (idx + filteredCommands.length - 1) % filteredCommands.length)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashPinned(false)
        setSlashDismissed(true)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        const picked = filteredCommands[slashIndex] ?? filteredCommands[0]
        if (picked) {
          event.preventDefault()
          if (!picked.disabled) picked.run()
          return
        }
      }
    }

    // Recall recent sent prompts with ArrowUp / ArrowDown. Once browsing, the
    // arrows walk history even after the caret moves to the end of the recall.
    const recall = (value: string, cursor: number) => {
      setHistoryCursor(cursor)
      setText(value)
      writeDraft(sessionId, value)
    }
    if (event.key === 'ArrowUp' && !event.shiftKey && !event.altKey && !event.metaKey && sentHistory.length > 0) {
      const el = event.currentTarget
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0
      if (text === '' ? atStart : historyCursor >= 0) {
        event.preventDefault()
        if (historyCursor === -1) historyDraft.current = text
        const nextIdx = historyCursor === -1 ? sentHistory.length - 1 : Math.max(0, historyCursor - 1)
        recall(sentHistory[nextIdx] ?? '', nextIdx)
        return
      }
    }
    if (event.key === 'ArrowDown' && !event.shiftKey && !event.altKey && !event.metaKey && historyCursor >= 0) {
      event.preventDefault()
      if (historyCursor >= sentHistory.length - 1) {
        const restored = historyDraft.current
        setHistoryCursor(-1)
        setText(restored)
        writeDraft(sessionId, restored)
      } else {
        const nextIdx = historyCursor + 1
        recall(sentHistory[nextIdx] ?? '', nextIdx)
      }
      return
    }

    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    submit()
  }, [slashOpen, filteredCommands, slashIndex, sentHistory, text, historyCursor, submit, sessionId])

  const onPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    event.preventDefault()
    void addFiles(files)
  }, [addFiles])

  const onPick = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = [...event.target.files ?? []]
    event.target.value = ''
    if (files.length > 0) void addFiles(files)
  }, [addFiles])

  const hasDragFiles = (event: DragEvent<HTMLElement>) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasDragFiles(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }, [disabled])
  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasDragFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [disabled])
  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (dragDepth.current === 0) return
    event.preventDefault()
    dragDepth.current -= 1
    if (dragDepth.current === 0) setDragging(false)
  }, [])
  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (disabled) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = [...event.dataTransfer?.files ?? []]
    if (files.length > 0) void addFiles(files)
  }, [disabled, addFiles])

  const clearAll = useCallback(() => {
    updateText('')
    setImages([])
    setLocalError(undefined)
    setExpanded(false)
    onDismissError()
    area.current?.focus()
  }, [updateText, onDismissError])

  const shownError = localError ?? error
  const canSend = !disabled && !busy && (Boolean(text.trim()) || images.length > 0)
  const hasContent = text.length > 0 || images.length > 0
  const showExpandToggle = expanded || text.length > 100 || text.includes('\n')
  const charCount = text.length

  return (
    <div className="dsh-dot-composer" ref={composerRef}>
      {shownError !== undefined ? (
        <div className="dsh-dot-error" role="alert">
          <IconWarningOutlineRegular size={14} className="dsh-dot-error-icon" />
          <span className="dsh-dot-error-text">{localError !== undefined ? shownError : `${t(locale, 'sendFailed')}${shownError}`}</span>
          <button
            type="button"
            className="dsh-dot-error-dismiss"
            aria-label={t(locale, 'dismissError')}
            title={t(locale, 'dismissError')}
            onClick={() => { setLocalError(undefined); onDismissError() }}
          >
            <IconCloseOutlineRegular size={13} />
          </button>
        </div>
      ) : null}

      {slashOpen ? (
        <div className="dsh-dot-slash-menu" role="listbox" aria-label={t(locale, 'quickActions')}>
          <div className="dsh-dot-slash-head">
            <span>{t(locale, 'quickActions')}</span>
            <span className="dsh-dot-slash-kbd">↑↓ · Enter</span>
          </div>
          <div className="dsh-dot-slash-list" ref={slashList}>
            {filteredCommands.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={idx === slashIndex}
                {...(item.disabled ? { disabled: true } : {})}
                className="dsh-dot-slash-item"
                data-active={idx === slashIndex ? '' : undefined}
                onMouseEnter={() => setSlashIndex(idx)}
                onClick={() => item.run()}
              >
                <code className="dsh-dot-slash-cmd">{item.cmd}</code>
                <div className="dsh-dot-slash-copy">
                  <span className="dsh-dot-slash-label">{item.label}</span>
                  <span className="dsh-dot-slash-desc">{item.desc}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div
        className="dsh-dot-composer-card"
        data-running={running ? '' : undefined}
        data-disabled={disabled ? '' : undefined}
        data-dragging={dragging ? '' : undefined}
        data-expanded={expanded ? '' : undefined}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragging ? (
          <div className="dsh-dot-drop-mask" aria-hidden="true">
            <ImageGlyph />
            <span>{t(locale, 'dropImagesHint').replace('{max}', String(CHAT_IMAGE_LIMIT))}</span>
          </div>
        ) : null}

        {images.length > 0 ? (
          <div className="dsh-dot-attachments">
            {images.map((image, index) => (
              <div key={`${image.name ?? image.mediaType}:${index}`} className="dsh-dot-attachment">
                <img
                  className="dsh-dot-attachment-thumb"
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt={image.name ?? t(locale, 'imageAttached')}
                />
                <div className="dsh-dot-attachment-meta">
                  <span className="dsh-dot-attachment-name">{image.name ?? t(locale, 'imageAttached')}</span>
                  <span className="dsh-dot-attachment-ext">{image.mediaType.replace('image/', '').toUpperCase()}</span>
                </div>
                <button
                  type="button"
                  className="dsh-dot-attachment-remove"
                  aria-label={t(locale, 'removeImage')}
                  title={t(locale, 'removeImage')}
                  onClick={() => setImages(list => list.filter((_, item) => item !== index))}
                >
                  ×
                </button>
              </div>
            ))}
            {images.length < CHAT_IMAGE_LIMIT ? (
              <button
                type="button"
                className="dsh-dot-attachment-add"
                disabled={disabled || busy}
                aria-label={t(locale, 'attachImage')}
                title={`${t(locale, 'attachImage')} (${images.length}/${CHAT_IMAGE_LIMIT})`}
                onClick={() => picker.current?.click()}
              >
                <PlusGlyph />
                <span>{images.length}/{CHAT_IMAGE_LIMIT}</span>
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="dsh-dot-editor-wrap">
          <textarea
            ref={area}
            className="dsh-dot-input"
            rows={1}
            maxLength={COMPOSER_TEXT_LIMIT}
            value={text}
            placeholder={running ? t(locale, 'placeholderRunning') : t(locale, 'placeholder')}
            onChange={event => updateText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={disabled}
          />
          {showExpandToggle ? (
            <Tooltip label={t(locale, expanded ? 'collapseInput' : 'expandInput')} side="top">
              <button
                type="button"
                className="dsh-dot-expand-btn"
                aria-label={t(locale, expanded ? 'collapseInput' : 'expandInput')}
                aria-pressed={expanded}
                onClick={() => setExpanded(value => !value)}
              >
                {expanded ? <NarrowGlyph /> : <WidenGlyph />}
              </button>
            </Tooltip>
          ) : null}
        </div>

        <div className="dsh-dot-composer-bar">
          <div className="dsh-dot-composer-tools">
            <input ref={picker} className="dsh-dot-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={onPick} />
            <Tooltip label={t(locale, 'attachImage')} side="top">
              <button
                type="button"
                className="dsh-dot-tool-btn"
                disabled={disabled || busy || images.length >= CHAT_IMAGE_LIMIT}
                aria-label={t(locale, 'attachImage')}
                onClick={() => picker.current?.click()}
              >
                <ImageGlyph />
                {images.length > 0 ? <span className="dsh-dot-tool-count">{images.length}</span> : null}
              </button>
            </Tooltip>

            <Tooltip label={t(locale, 'quickActions')} side="top">
              <button
                type="button"
                className="dsh-dot-tool-btn"
                disabled={disabled}
                aria-label={t(locale, 'quickActions')}
                aria-expanded={slashOpen}
                aria-pressed={slashOpen}
                onClick={() => {
                  if (slashOpen) {
                    setSlashPinned(false)
                    setSlashDismissed(true)
                    return
                  }
                  setSlashDismissed(false)
                  setSlashPinned(true)
                }}
              >
                <SlashCommandGlyph />
              </button>
            </Tooltip>

            {segmentBusy || segmentDone ? (
              <span className="dsh-dot-seg-feedback" data-done={segmentDone ? '' : undefined} role="status">
                {segmentDone ? <IconCheckOutlineRegular size={12} /> : null}
                <span>{segmentBusy ? t(locale, 'ctxNewSegmentRunning') : t(locale, 'ctxNewSegmentDone')}</span>
              </span>
            ) : null}
          </div>

          <div className="dsh-dot-composer-right">
            {charCount >= 200 ? (
              <span className="dsh-dot-char-count" data-warn={charCount >= COMPOSER_TEXT_LIMIT * 0.9 ? '' : undefined}>
                {charCount.toLocaleString()}/{COMPOSER_TEXT_LIMIT.toLocaleString()}
              </span>
            ) : (
              <span className="dsh-dot-composer-hint">{t(locale, 'composerHint')}</span>
            )}

            {hasContent && !busy ? (
              <Tooltip label={t(locale, 'clearInput')} side="top">
                <button
                  type="button"
                  className="dsh-dot-tool-btn dsh-dot-clear-btn"
                  aria-label={t(locale, 'clearInput')}
                  onClick={clearAll}
                >
                  <ClearGlyph />
                </button>
              </Tooltip>
            ) : null}

            {running ? (
              <button type="button" className="dsh-dot-stop-btn" onClick={onStop}>
                <StopSquareGlyph />
                <span>{t(locale, 'stop')}</span>
              </button>
            ) : null}

            <button
              type="button"
              className="dsh-dot-send-btn"
              disabled={!canSend}
              onClick={submit}
            >
              <SendArrowGlyph />
              <span>{busy ? t(locale, 'sending') : t(locale, 'send')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ImageGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <circle cx="5.6" cy="6" r="1.1" />
      <path d="M2.5 11.5 6 8.2a1 1 0 0 1 1.4 0L10 10.7l1.6-1.5a1 1 0 0 1 1.4 0l1 1" />
    </svg>
  )
}

function SlashCommandGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="3" />
      <path d="M9.6 4.8 6.4 11.2" />
    </svg>
  )
}

function ClearGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4.5h10M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3M4.5 4.5l.6 8.2c0 .7.6 1.3 1.3 1.3h3.2c.7 0 1.3-.6 1.3-1.3l.6-8.2" />
    </svg>
  )
}

function PlusGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  )
}

function SendArrowGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 12.8V3.5M4.2 7.2 8 3.4l3.8 3.8" />
    </svg>
  )
}

function StopSquareGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="8" height="8" rx="1.8" />
    </svg>
  )
}

function ToolGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.8 2.6a3.2 3.2 0 0 0 3.6 4.2L8.2 12a1.7 1.7 0 0 1-2.4-2.4l5.2-5.2" />
      <path d="M3 13l1.6-1.6" />
    </svg>
  )
}

function WidenGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
    </svg>
  )
}

function NarrowGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14" />
    </svg>
  )
}

function GearGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function BellGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 10.5V7a4 4 0 0 1 8 0v3.5l1 1.5H3z" />
      <path d="M6.6 13.6a1.5 1.5 0 0 0 2.8 0" />
    </svg>
  )
}

function JumpGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4h6v6" />
      <path d="M12 4L4.5 11.5" />
    </svg>
  )
}

// Selectors spell the root out (.dsh-dot-chat = CHAT_ROOT) so the repository scope check can read them.
export const chatCss = settingsCss + `
.dsh-dot-chat {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  padding-top: var(--dsh-frame-top-clearance);
}
.dsh-dot-chat .dsh-dot-head {
  display: flex; align-items: center; gap: 10px; padding: 10px 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.dsh-dot-chat .dsh-dot-head > button,
.dsh-dot-chat .dsh-dot-drawer-head > button,
.dsh-dot-chat .dsh-dot-composer-bar button,
.dsh-dot-chat .dsh-dot-banner > button,
.dsh-dot-chat .dsh-ui-actions > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-chat .dsh-ui-actions { flex-wrap: wrap; }
.dsh-dot-chat .dsh-dot-head-text { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-dot-chat .dsh-dot-name { font-size: 14px; line-height: 20px; font-weight: 600; }
.dsh-dot-chat .dsh-dot-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.dsh-dot-chat .dsh-dot-status[data-running] { color: var(--dsw-alias-state-business-primary); }
.dsh-dot-chat .dsh-dot-status-dot { width: 6px; height: 6px; border-radius: 3px; background: var(--dsw-alias-state-success-primary); }
.dsh-dot-chat .dsh-dot-status[data-running] .dsh-dot-status-dot { background: var(--dsw-alias-state-business-primary); animation: dsh-dot-pulse 1.4s ease-in-out infinite; }
@keyframes dsh-dot-pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .dsh-dot-chat .dsh-dot-status[data-running] .dsh-dot-status-dot { animation: none; } }
.dsh-dot-chat .dsh-dot-head { min-height: 48px; box-sizing: border-box; padding: 6px 12px 6px 16px; gap: 8px; }
.dsh-dot-chat .dsh-dot-segment-count {
  padding: 1px 6px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
  font: 11px/16px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary); white-space: nowrap;
}
@container (max-width: 420px) { .dsh-dot-chat .dsh-dot-segment-count { display: none; } }
.dsh-dot-chat .dsh-dot-starters { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; max-width: 480px; margin-top: 12px; }
.dsh-dot-chat .dsh-dot-starter {
  padding: 6px 12px; border: 0; border-radius: var(--dsw-radius-sm); cursor: pointer;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke);
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px;
}
.dsh-dot-chat .dsh-dot-starter:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-chat .dsh-dot-starter:disabled { opacity: 0.5; cursor: default; }
.dsh-dot-chat .dsh-dot-segment-wrap { display: flex; flex-direction: column; gap: 6px; }
.dsh-dot-chat .dsh-dot-segment button {
  display: inline-flex; align-items: center; gap: 4px; padding: 0 2px; border: 0; background: none; cursor: pointer;
  color: inherit; font: inherit;
}
.dsh-dot-chat .dsh-dot-segment button:hover { color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-segment-note {
  display: flex; gap: 8px; align-items: baseline; align-self: center; max-width: 100%;
  padding: 6px 12px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-dot-chat .dsh-dot-segment-time { font-family: var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary); flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-spacer { flex: 1; }
.dsh-dot-chat .dsh-dot-badge {
  display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px;
  margin-left: 6px; padding: 0 4px; border-radius: 8px; font-size: 11px;
  background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary-foreground);
}
.dsh-dot-chat .dsh-dot-head .dsh-dot-gear { position: relative; }
.dsh-dot-chat .dsh-dot-gear-dot {
  position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: 3px;
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-dot-chat .dsh-dot-ctx-pill { gap: 8px; font-variant-numeric: tabular-nums; }
.dsh-dot-chat .dsh-dot-ctx-track {
  display: inline-block; width: 40px; height: 6px; border-radius: 3px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-dot-chat .dsh-dot-ctx-track > span { display: block; height: 100%; border-radius: 3px; background: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-ctx-num { font: 12px/16px var(--ds-font-family-code); color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-stage { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: row; container-type: inline-size; }
.dsh-dot-chat .dsh-dot-chatcol { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.dsh-dot-chat .dsh-dot-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.dsh-dot-chat .dsh-dot-drawer-layer { position: absolute; inset: 0; z-index: 10; display: flex; justify-content: flex-end; overflow: hidden; }
.dsh-dot-chat .dsh-dot-drawer-backdrop {
  position: absolute; inset: 0; padding: 0; border: 0; border-radius: 0; cursor: default;
  background: var(--dsw-alias-bg-mask-1); animation: dsh-dot-fade var(--ds-transition-duration, 0.2s) ease-out;
}
.dsh-dot-chat .dsh-dot-drawer {
  position: relative; width: min(460px, 100%); height: 100%; min-height: 0; display: flex; flex-direction: column;
  border-left: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-prominent);
  transition: width var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-out);
  animation: dsh-dot-drawer-in var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-out);
}
.dsh-dot-chat .dsh-dot-drawer[data-wide] { width: min(640px, 100%); }
.dsh-dot-chat .dsh-dot-drawer-title {
  display: inline-flex; align-items: center; gap: 8px; margin: 0; padding: 0 6px;
  font-size: 14px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary);
}
@keyframes dsh-dot-drawer-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes dsh-dot-fade { from { opacity: 0; } to { opacity: 1; } }.dsh-dot-chat .dsh-dot-drawer-head {
  display: flex; align-items: center; gap: 4px; min-height: 46px; padding: 6px 8px 6px 10px; box-sizing: border-box;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-dot-chat .dsh-dot-drawer-head > button { flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-drawer-tabs { display: flex; align-items: center; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.dsh-dot-chat .dsh-dot-drawer-tabs button,
.dsh-dot-chat .dsh-dot-filters button {
  display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; padding: 5px 10px;
  border: 0; border-radius: var(--dsw-radius-sm); background: transparent; white-space: nowrap;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-drawer-tabs button:hover,
.dsh-dot-chat .dsh-dot-filters button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-drawer-tabs button[aria-pressed='true'],
.dsh-dot-chat .dsh-dot-filters button[aria-pressed='true'] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); font-weight: 500; }
.dsh-dot-chat .dsh-dot-drawer-tabs button:focus-visible,
.dsh-dot-chat .dsh-dot-filters button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dsh-dot-chat .dsh-dot-nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-nav-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 11px; line-height: 16px; font-weight: 500;
  background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary-foreground);
}
.dsh-dot-chat .dsh-dot-settings-status {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 1; min-width: 0; margin-right: 2px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-state-success-primary); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-dot-chat .dsh-dot-settings-status--error { color: var(--dsw-alias-label-error); }
.dsh-dot-chat .dsh-dot-settings-scroll { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; container-type: inline-size; }
.dsh-dot-chat .dsh-dot-settings { display: flex; flex-direction: column; padding: 16px 18px 28px; }
.dsh-dot-chat .dsh-dot-settings[data-tab='tasks'] { padding: 12px 12px 24px; }
.dsh-dot-chat .dsh-dot-settings[data-tab='trajectory'] { padding: 0; }
.dsh-dot-chat .dsh-dot-settings[data-tab='trajectory'] .dsh-dot-tr { flex: none; }
.dsh-dot-chat .dsh-dot-settings[data-tab='trajectory'] .dsh-dot-tr-list { overflow: visible; }
.dsh-dot-chat .dsh-dot-trajectory-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dsh-dot-chat .dsh-dot-tasks { display: flex; flex-direction: column; gap: 12px; }
.dsh-dot-chat .dsh-dot-tasks .dsh-dot-board { padding: 0; height: auto; overflow: visible; }
.dsh-dot-chat .dsh-dot-filters { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; }
.dsh-dot-chat .dsh-dot-filters button { padding: 3px 9px; font-size: 12px; line-height: 18px; }
@container (max-width: 560px) { .dsh-dot-chat .dsh-dot-drawer-widen { display: none; } }
@media (prefers-reduced-motion: reduce) { .dsh-dot-chat .dsh-dot-drawer, .dsh-dot-chat .dsh-dot-drawer-backdrop { transition: none; animation: none; } }
.dsh-dot-chat .dsh-dot-settings-pane { gap: 0; }
.dsh-dot-chat .dsh-dot-settings-pane > .dsh-ui-notice,
.dsh-dot-chat .dsh-dot-settings-pane > .dsh-ui-error { margin-bottom: 16px; }
.dsh-dot-chat .dsh-dot-pane-section { padding: 18px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-dot-chat .dsh-dot-pane > .dsh-dot-pane-section:first-child { padding-top: 0; }
.dsh-dot-chat .dsh-dot-pane > .dsh-dot-pane-section:last-child { padding-bottom: 0; border-bottom: 0; }
.dsh-dot-chat .dsh-dot-pane-section .dsh-ui-form > .dsh-ui-field:first-child { padding-top: 4px; }
.dsh-dot-chat .dsh-dot-pane-section .dsh-ui-form > .dsh-ui-field:last-child { padding-bottom: 0; }
.dsh-dot-chat .dsh-dot-pane-section-title {
  margin: 0 0 8px; font-size: 12px; line-height: 18px; font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.dsh-dot-chat .dsh-dot-settings-note { margin: 0; padding-top: 16px; }
.dsh-dot-chat .dsh-dot-pane { display: flex; flex-direction: column; gap: 12px; }
.dsh-dot-chat .dsh-dot-log {
  display: flex; flex-direction: column; gap: 12px;
  max-width: 760px; margin: 0 auto; padding: 20px 16px 12px;
}
.dsh-dot-chat .dsh-dot-center {
  display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center;
  padding: 48px 24px;
}
.dsh-dot-chat .dsh-dot-greeting { font-size: 16px; line-height: 24px; font-weight: 600; }
.dsh-dot-chat .dsh-dot-muted { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); max-width: 420px; }
.dsh-dot-chat .dsh-dot-user { display: flex; justify-content: flex-end; padding-left: 48px; }
.dsh-dot-chat .dsh-dot-user > * { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-echo { opacity: 0.55; }
.dsh-dot-chat .dsh-dot-bot { display: flex; gap: 10px; align-items: flex-start; }
.dsh-dot-chat .dsh-dot-gutter { flex: 0 0 28px; width: 28px; min-height: 1px; }
.dsh-dot-chat .dsh-dot-body { flex: 1; min-width: 0; padding-top: 3px; }
.dsh-dot-chat .dsh-dot-view-number { margin-bottom: 4px; }
.dsh-dot-chat .dsh-dot-view[data-expired] { opacity: 0.7; }
.dsh-dot-chat .dsh-dot-activity { color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-row-content { flex: 1 1 auto; min-width: 0; }
.dsh-dot-chat .dsh-dot-row-layout { min-width: 0; }
.dsh-dot-chat .dsh-dot-row-sep {
  flex: none; width: 2px; height: 2px; margin: 0 8px;
  border-radius: 1px; background: var(--dsw-alias-label-caption);
}
.dsh-dot-chat .dsh-dot-row-summary {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption);
}
.dsh-dot-chat .dsh-dot-row-summary[data-tone="error"] { color: var(--dsw-alias-label-error); }
.dsh-dot-chat .dsh-dot-tool-group {
  display: flex; flex-direction: column; gap: 2px;
  margin: 4px 0 2px 7px; padding-left: 14px;
  border-left: 1px solid var(--dsw-alias-border-l2);
}
.dsh-dot-chat .dsh-dot-tool-body {
  display: flex; align-items: center; gap: 8px;
  margin: 3px 0 4px 22px; padding: 7px 11px; max-height: 200px; overflow-y: auto;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-dot-chat .dsh-dot-tool-body[data-multiline] { flex-direction: column; align-items: stretch; gap: 6px; }
.dsh-dot-chat .dsh-dot-tool-body[data-tone="muted"] { color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-tool-body[data-tone="error"] { color: var(--dsw-alias-label-error); }
.dsh-dot-chat .dsh-dot-tool-text { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-tool-foot { display: flex; justify-content: flex-end; }
.dsh-dot-chat .dsh-dot-notice { padding-left: 38px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-notice-list {
  display: flex; flex-direction: column; gap: 10px;
  margin: 4px 0 2px 7px; padding: 2px 0 2px 14px;
  border-left: 1px solid var(--dsw-alias-border-l2);
}
.dsh-dot-chat .dsh-dot-notice-entry { display: flex; flex-direction: column; gap: 5px; color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-notice-entry + .dsh-dot-notice-entry { padding-top: 10px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.dsh-dot-chat .dsh-dot-card-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.dsh-dot-chat .dsh-dot-card-subject { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary); min-width: 0; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-code-pill {
  padding: 1px 6px; border-radius: 6px; background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary); font: 12px/18px var(--ds-font-family-code);
}
.dsh-dot-chat .dsh-dot-req-id { font: 11px/17px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-card-meta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-card-body { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-card-error { color: var(--dsw-alias-label-error); }
.dsh-dot-chat .dsh-dot-card-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-cmd {
  margin: 0; padding: 7px 10px; max-height: 160px; overflow-y: auto;
  border: 0; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: 12px/18px var(--ds-font-family-code); white-space: pre-wrap; overflow-wrap: anywhere;
}
.dsh-dot-chat .dsh-dot-questions { display: flex; flex-direction: column; gap: 6px; }
.dsh-dot-chat .dsh-dot-question-item { display: flex; flex-direction: column; gap: 4px; }
.dsh-dot-chat .dsh-dot-question-multi { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-question-opts { display: flex; flex-wrap: wrap; gap: 4px; }
.dsh-dot-chat .dsh-dot-kv-list { display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 18px; }
.dsh-dot-chat .dsh-dot-kv-row { display: flex; gap: 6px; min-width: 0; }
.dsh-dot-chat .dsh-dot-kv-key { flex-shrink: 0; font-family: var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-kv-val { min-width: 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-session-btn {
  display: inline-flex; align-items: center; gap: 3px; max-width: 220px; min-width: 0;
  padding: 1px 6px; border: 0; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-session-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-session-btn:focus-visible { outline: 1px solid var(--dsw-focus-ring-color); outline-offset: 1px; }
.dsh-dot-chat .dsh-dot-session-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-turn-error {
  display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-stroke); font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-error);
}
.dsh-dot-chat .dsh-dot-turn-error > [data-state] { margin-top: 6px; flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-segment {
  display: flex; align-items: center; gap: 10px; padding: 4px 0;
  font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
}
.dsh-dot-chat .dsh-dot-segment::before, .dsh-dot-chat .dsh-dot-segment::after { content: ''; flex: 1; height: 0.5px; background: var(--dsw-alias-border-l2); }
.dsh-dot-chat .dsh-dot-banner-wrap {
  width: 100%; max-width: 760px; margin: 0 auto; padding: 4px 16px 0; box-sizing: border-box;
}
.dsh-dot-chat .dsh-dot-banner {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px 7px 12px;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-stroke);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-error);
}
.dsh-dot-chat .dsh-dot-banner-icon { flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-banner-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-error {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px 7px 12px;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-stroke);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-error);
}
.dsh-dot-chat .dsh-dot-error-icon { flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-error-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-error-dismiss {
  display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
  padding: 0; border: 0; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-tertiary); cursor: pointer; flex-shrink: 0;
}
.dsh-dot-chat .dsh-dot-error-dismiss:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-composer {
  position: relative; display: flex; flex-direction: column; gap: 8px;
  width: 100%; max-width: 760px; margin: 0 auto; padding: 8px 16px 16px; box-sizing: border-box;
}
.dsh-dot-chat .dsh-dot-composer-card {
  position: relative; display: flex; flex-direction: column;
  border-radius: 14px; background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22));
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
  transition: border-color var(--ds-transition-duration, 0.18s) ease, box-shadow var(--ds-transition-duration, 0.18s) ease, background-color var(--ds-transition-duration, 0.18s) ease;
}
.dsh-dot-chat .dsh-dot-composer-card:hover:not([data-disabled]) {
  border-color: var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.34));
}
.dsh-dot-chat .dsh-dot-composer-card:focus-within {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.16), 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 16%, transparent);
}
.dsh-dot-chat .dsh-dot-composer-card[data-running]:not(:focus-within) {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 40%, var(--dsw-alias-border-l2, transparent));
}
.dsh-dot-chat .dsh-dot-composer-card[data-disabled] { opacity: 0.65; }
.dsh-dot-chat .dsh-dot-composer-card[data-dragging] {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
}
.dsh-dot-chat .dsh-dot-drop-mask {
  position: absolute; inset: 3px; z-index: 4; display: flex; align-items: center; justify-content: center; gap: 8px;
  border-radius: 11px; border: 1.5px dashed var(--dsw-alias-brand-primary, #4d6bfe);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 90%, var(--dsw-alias-brand-primary, #4d6bfe));
  color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; pointer-events: none;
}
.dsh-dot-chat .dsh-dot-attachments {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 10px 12px 2px;
}
.dsh-dot-chat .dsh-dot-attachment {
  position: relative; display: inline-flex; align-items: center; gap: 8px; max-width: 200px;
  padding: 4px 26px 4px 4px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-stroke);
}
.dsh-dot-chat .dsh-dot-attachment-thumb {
  width: 36px; height: 36px; border-radius: 6px; object-fit: cover; flex-shrink: 0;
  background: var(--dsw-alias-bg-base);
}
.dsh-dot-chat .dsh-dot-attachment-meta { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.dsh-dot-chat .dsh-dot-attachment-name {
  font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-dot-chat .dsh-dot-attachment-ext {
  font: 10px/13px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary);
}
.dsh-dot-chat .dsh-dot-attachment-remove {
  position: absolute; top: 4px; right: 4px; width: 18px; height: 18px;
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
  border: 0; border-radius: 9px; background: transparent; color: var(--dsw-alias-label-tertiary);
  font-size: 14px; line-height: 1; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-attachment-remove:hover {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
}
.dsh-dot-chat .dsh-dot-attachment-add {
  display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  width: 44px; height: 44px; padding: 0; border-radius: 9px;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: 10px/12px var(--ds-font-family-code); cursor: pointer;
}
.dsh-dot-chat .dsh-dot-attachment-add:hover:not(:disabled) {
  border-color: var(--dsw-alias-label-secondary); color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-dot-chat .dsh-dot-editor-wrap {
  position: relative; display: flex; align-items: flex-start; gap: 6px;
  padding: 11px 12px 4px 14px;
}
.dsh-dot-chat .dsh-dot-input {
  flex: 1; min-width: 0; min-height: 26px; max-height: 180px; resize: none;
  border: 0; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px;
  padding: 2px 0; overflow-y: auto;
}
.dsh-dot-chat .dsh-dot-composer-card[data-expanded] .dsh-dot-input {
  min-height: 132px; max-height: 360px;
}
.dsh-dot-chat .dsh-dot-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-dot-chat .dsh-dot-expand-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  padding: 0; border: 0; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-tertiary); cursor: pointer; flex-shrink: 0;
}
.dsh-dot-chat .dsh-dot-expand-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
}
.dsh-dot-chat .dsh-dot-composer-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 4px 8px 8px 10px; flex-wrap: wrap;
}
.dsh-dot-chat .dsh-dot-composer-tools {
  display: flex; align-items: center; gap: 4px; min-width: 0;
}
.dsh-dot-chat .dsh-dot-composer-right {
  display: flex; align-items: center; gap: 6px; margin-left: auto; flex-shrink: 0;
}
.dsh-dot-chat .dsh-dot-tool-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  min-width: 28px; height: 28px; padding: 0 6px; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.dsh-dot-chat .dsh-dot-tool-btn:hover:not(:disabled),
.dsh-dot-chat .dsh-dot-tool-btn[aria-pressed='true'] {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
}
.dsh-dot-chat .dsh-dot-tool-btn:disabled { opacity: 0.4; cursor: default; }
.dsh-dot-chat .dsh-dot-tool-count {
  font: 11px/14px var(--ds-font-family-code); padding: 0 4px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
}
.dsh-dot-chat .dsh-dot-seg-feedback {
  display: inline-flex; align-items: center; gap: 4px; margin-left: 4px;
  font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); white-space: nowrap;
}
.dsh-dot-chat .dsh-dot-seg-feedback[data-done] { color: var(--dsw-alias-state-success-primary); }
.dsh-dot-chat .dsh-dot-composer-hint {
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-dimmed);
  white-space: nowrap; user-select: none; margin-right: 2px;
}
.dsh-dot-chat .dsh-dot-char-count {
  font: 11px/16px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums; white-space: nowrap; margin-right: 2px;
}
.dsh-dot-chat .dsh-dot-char-count[data-warn] { color: var(--dsw-alias-state-warn-primary); }
@container (max-width: 560px) {
  .dsh-dot-chat .dsh-dot-composer-hint { display: none; }
}
.dsh-dot-chat .dsh-dot-stop-btn {
  display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 11px;
  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 15px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; line-height: 16px; font-weight: 500; white-space: nowrap; cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.dsh-dot-chat .dsh-dot-stop-btn:hover {
  border-color: var(--dsw-alias-label-error); color: var(--dsw-alias-label-error);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-dot-chat .dsh-dot-send-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 30px; padding: 0 13px 0 11px; border: 0; border-radius: 15px;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
  font: inherit; font-size: 12px; line-height: 16px; font-weight: 500; white-space: nowrap; cursor: pointer;
  transition: opacity 0.15s ease, transform 0.12s ease, background-color 0.15s ease;
}
.dsh-dot-chat .dsh-dot-send-btn:hover:not(:disabled) { filter: brightness(1.08); }
.dsh-dot-chat .dsh-dot-send-btn:active:not(:disabled) { transform: scale(0.97); }
.dsh-dot-chat .dsh-dot-send-btn:disabled {
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-dimmed);
  cursor: default; filter: none;
}
.dsh-dot-chat .dsh-dot-slash-menu {
  position: absolute; left: 16px; right: 16px; bottom: calc(100% - 4px); z-index: 8;
  max-width: 440px; border-radius: 12px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-elevation-prominent);
  animation: dsh-dot-fade 0.14s ease-out;
}
.dsh-dot-chat .dsh-dot-slash-head {
  display: flex; align-items: center; justify-content: space-between; padding: 7px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  font-size: 11px; line-height: 16px; font-weight: 600; color: var(--dsw-alias-label-tertiary);
}
.dsh-dot-chat .dsh-dot-slash-kbd { font-family: var(--ds-font-family-code); font-weight: 400; }
.dsh-dot-chat .dsh-dot-slash-list {
  display: flex; flex-direction: column; gap: 2px; max-height: 256px; overflow-y: auto; padding: 5px;
}
.dsh-dot-chat .dsh-dot-slash-item {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 9px;
  border: 0; border-radius: 8px; background: transparent; text-align: left;
  color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-slash-item[data-active]:not(:disabled),
.dsh-dot-chat .dsh-dot-slash-item:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-dot-chat .dsh-dot-slash-item[data-active]:disabled,
.dsh-dot-chat .dsh-dot-slash-item[data-active][disabled] {
  background-color: rgba(128, 128, 128, 0.22);
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, 0.7);
}
.dsh-dot-chat .dsh-dot-slash-item:disabled { opacity: 0.45; cursor: default; }
.dsh-dot-chat .dsh-dot-slash-cmd {
  flex-shrink: 0; padding: 2px 6px; border-radius: 5px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font: 11px/16px var(--ds-font-family-code);
}
.dsh-dot-chat .dsh-dot-slash-copy { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.dsh-dot-chat .dsh-dot-slash-label {
  font-size: 13px; line-height: 18px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-dot-chat .dsh-dot-slash-desc {
  font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-dot-chat .dsh-dot-file { display: none; }
.dsh-dot-chat .dsh-dot-images { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-dot-chat .dsh-dot-image-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 2px 8px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-dot-chat .dsh-dot-image-chip button {
  border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0; font: inherit;
}
`
