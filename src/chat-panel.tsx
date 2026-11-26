/**
 * Dorothy's own chat. Her sessions carry the subagent origin, so the host's
 * conversation view never shows them; this panel draws them as one chat instead:
 * messages, tool activity, task updates, deep-view cards, a marker where the
 * conversation moved to a new session segment, and a composer. It long-polls
 * the host feed and redraws on every change.
 */
import {
  Button, DisclosureRow, IconCheckOutlineRegular, IconChecklistOutlineRegular, IconChevronDownOutlineRegular,
  IconCloseOutlineRegular, IconCordisPluginOutlineRegular, IconEditOutlineRegular, IconGaugeOutlineRegular, IconGlobeOutlineRegular,
  IconInspectOutlineRegular, IconShieldOutlineRegular, IconSlidersTwoOutlineRegular, IconUserOutlineRegular,
  IconWarningOutlineRegular, MarkdownText, Modal, modalSelector, StateDot, Tag, TextShimmer, Tooltip, UserMessageBubble,
  type MarkdownLabels, type StateDotState, type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { backendMissingText, backendOutdatedStore, writeSelfBackup } from './backend-state.ts'
import { Board, boardCounts, type BoardFilter } from './board.tsx'
import { groupBoard, headerBoardCounts, sessionLookup } from './board-groups.ts'
import { filterVisibleChat } from './chat-filter.ts'
import { formatToolDetail, parseNotice, permissionLabel, resolveSessionBadge, summarizeNotice, summarizeToolCall, summarizeToolGroup, type NoticeEntry, type ParsedNotice, type SessionBadge, type TaskLookup } from './chat-format.ts'
import { BellGlyph, Composer, GearGlyph, JumpGlyph, NarrowGlyph, ToolGlyph, WidenGlyph } from './composer.tsx'
import {
  DRAWER_MIN_PX, useBoard, useChatFeed, useContextUse, useDrawerGuard, useLocalEchoes, useRecipes, useReminderRemoval, useScrollPin, useSettings,
  type DrawerAction, type DrawerTab, type SettingsSection,
} from './chat-hooks.ts'
import { ContextPanel, type ContextApi } from './context-panel.tsx'
import { PersonaPanel, type KnowledgeApi } from './persona-panel.tsx'
import { TrajectoryPanel, type TrajectoryApi } from './trajectory-panel.tsx'
import type { BoardView, ChatItem, ChatSnapshot, DotSettings, RecipeBoardRow, RolloverReason, SelfStatusView } from './contracts.ts'
import type { ChatImage } from './chat-images.ts'
import { humanBytes, type ChatFileReceipt } from './chat-files.ts'
import { SettingsPanel, useSettingProposals, type SaveNotice, type SettingsApi } from './settings-panel.tsx'
import type { RenderFactorySlot } from '@klarkxy/dsh-plugin-kit/model-picker'
import { cardCopy, fillText, formatDuration, formatTokens, formatWhen, intlLocale, t, toolLabel, type CopyLocale, type TextKey } from './ui-copy.ts'
import { mergedRecipeBody } from './recipes.ts'
import { WorkBoardPanel, type WorkApi } from './work-board.tsx'
import type { WorkAcceptPayload, PendingGlance, WorkBoardItem, WorkIntegratePayload, WorkReadRequest, WorkRejectPayload } from './work-board.ts'
import { DotAvatar } from './whale.tsx'

export { chatCss } from './chat-panel-css.ts'
export type { DrawerTab } from './chat-hooks.ts'


export const CHAT_ROOT = 'dsh-dot-chat'

export interface ChatApi extends SettingsApi, ContextApi, TrajectoryApi, KnowledgeApi {
  chat(itemsRev: number, signal: AbortSignal): Promise<ChatSnapshot | undefined>
  wait(rev: number, itemsRev: number, signal: AbortSignal): Promise<ChatSnapshot | undefined>
  attach(name: string, data: string): Promise<ChatFileReceipt>
  say(text: string, images?: readonly ChatImage[], files?: readonly string[]): Promise<void>
  stop(): Promise<void>
  board(signal: AbortSignal): Promise<BoardView>
  /** Remove one of Dorothy's reminders from the board. */
  removeSchedule(id: string): Promise<boolean>
  /** Stop watching a session. Does not archive or change the host session. */
  unwatch?(sessionId: string): Promise<boolean>
  /** Recipes with per-revision stats, in-flight changes and bound reminders. */
  recipes?(signal: AbortSignal): Promise<readonly RecipeBoardRow[]>
  /** Create + dispatch a recipe task from the Tasks panel. */
  recipeRun?(id: string): Promise<{ readonly ok: true; readonly changeId: string; readonly runId?: string } | { readonly ok: false; readonly reason: string }>
  /** Approve or dismiss a pending recipe proposal. */
  recipeProposalDecide?(id: string, allow: boolean): Promise<string>
  workAccept?(payload: WorkAcceptPayload): Promise<void>
  workReject?(payload: WorkRejectPayload): Promise<void>
  workAnswer?(payload: { readonly id: string; readonly allow: boolean; readonly note?: string }): Promise<void>
  workResume?(payload: { readonly id: string }): Promise<void>
  workForceRelease?(payload: { readonly id: string }): Promise<void>
  workIntegrate?(payload: WorkIntegratePayload): Promise<void>
  workRead?(request: WorkReadRequest): Promise<{ readonly source: string; readonly body: string; readonly truncated?: boolean; readonly totalBytes?: number }>
  settings(signal: AbortSignal): Promise<DotSettings>
  /** Where this install runs from and its newest kept pre-upgrade backup; absent on backends older than the endpoint. */
  selfStatus?(signal: AbortSignal): Promise<SelfStatusView>
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
  readonly widthPx: number | undefined
  readonly onWidth: (px: number | undefined) => void
  readonly onSaved: (next: DotSettings) => void
  readonly onProposalCount: (count: number) => void
}

const SETTINGS_SECTIONS: ReadonlySet<DrawerTab> = new Set<SettingsSection>([
  'proposals', 'general', 'takeover', 'dispatch', 'capabilities', 'mcp',
])

function isSettingsSection(tab: DrawerTab): tab is SettingsSection {
  return SETTINGS_SECTIONS.has(tab)
}

interface DrawerNavItem {
  readonly value: DrawerTab
  readonly label: string
  readonly title: string
  readonly icon: ReactNode
  readonly badge?: number
  readonly dirty?: boolean
}

/**
 * Overlay drawer for the board and every settings page: it always floats over the
 * chat stage behind a backdrop, never docking side-by-side. The left edge is a drag
 * handle — dragging resizes within safe bounds, Arrow keys nudge, double-click resets.
 */
function WorkDrawer({ locale, api, tab, wide, settings, trajectoryRev, running, waiting, proposalCount, tasks, renderFactorySlot, personaDirty, pendingAction, discardSignal, onRequest, onCancelPending, onDiscardPending, onDirtyChange, onWide, widthPx, onWidth, onSaved, onProposalCount }: DrawerProps) {
  const [saveNotice, setSaveNotice] = useState<SaveNotice>()
  useEffect(() => { setSaveNotice(undefined) }, [tab])
  const requestClose = useCallback(() => { onRequest({ kind: 'close' }) }, [onRequest])
  const requestTab = useCallback((next: DrawerTab) => { onRequest({ kind: 'tab', tab: next }) }, [onRequest])
  const asideRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ right: number }>()
  const [dragging, setDragging] = useState(false)
  const [sliderMax, setSliderMax] = useState(1200)
  const [sliderNow, setSliderNow] = useState(DRAWER_MIN_PX)
  const effectiveWide = wide && widthPx === undefined
  /** Clamp into [min, layer width]; the overlay layer spans the stage, so 100% is the natural ceiling. */
  const clampWidth = useCallback((px: number) => {
    const layer = asideRef.current?.parentElement
    const max = layer ? layer.clientWidth : window.innerWidth
    return Math.max(DRAWER_MIN_PX, Math.min(px, max))
  }, [])
  const onResizePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const aside = asideRef.current
    if (!aside || event.button !== 0) return
    dragRef.current = { right: aside.getBoundingClientRect().right }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }, [])
  const onResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    onWidth(clampWidth(drag.right - event.clientX))
  }, [clampWidth, onWidth])
  const endResizeDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = undefined
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])
  const onResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const aside = asideRef.current
    if (!aside) return
    event.preventDefault()
    const step = (event.shiftKey ? 64 : 16) * (event.key === 'ArrowLeft' ? 1 : -1)
    onWidth(clampWidth(aside.getBoundingClientRect().width + step))
  }, [clampWidth, onWidth])
  const resetWidth = useCallback(() => { dragRef.current = undefined; onWidth(undefined) }, [onWidth])
  useEffect(() => {
    const aside = asideRef.current
    const layer = aside?.parentElement
    if (!aside || !layer) return
    const sync = () => {
      setSliderMax(Math.max(DRAWER_MIN_PX, layer.clientWidth || 0))
      const measured = Math.round(aside.getBoundingClientRect().width)
      setSliderNow(measured > 0 ? measured : (widthPx ?? DRAWER_MIN_PX))
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sync)
    observer.observe(layer)
    return () => observer.disconnect()
  }, [widthPx, wide])
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
  const reloadSettings = useCallback(() => {
    api.settings(new AbortController().signal).then(onSaved, () => {})
  }, [api, onSaved])
  const proposalState = useSettingProposals(api, !isTasks, reloadSettings, onProposalCount)
  useEffect(() => {
    if (tab === 'proposals' && proposalState.loaded && proposalState.rows.length === 0 && !proposalState.error) {
      requestTab('general')
    }
  }, [tab, proposalState.loaded, proposalState.rows.length, proposalState.error, requestTab])

  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [navCompact, setNavCompact] = useState(false)
  useEffect(() => {
    const el = bodyRef.current
    if (isTasks || !el || typeof ResizeObserver === 'undefined') { setNavCompact(false); return }
    const sync = (width: number) => {
      if (width > 0) setNavCompact(width < 440)
    }
    sync(el.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? el.getBoundingClientRect().width
      sync(width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [isTasks])
  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0
  }, [tab])

  const proposalItems: readonly DrawerNavItem[] = !isTasks && (proposalCount > 0 || tab === 'proposals') ? [
    { value: 'proposals', label: t(locale, 'tabProposals'), title: t(locale, 'sProposals'), icon: <IconEditOutlineRegular size={15} />, badge: proposalCount },
  ] : []
  const configItems: readonly DrawerNavItem[] = isTasks ? [] : [
    { value: 'general', label: t(locale, 'tabGeneral'), title: t(locale, 'tabGeneral'), icon: <IconSlidersTwoOutlineRegular size={15} /> },
    { value: 'takeover', label: t(locale, 'tabTakeover'), title: t(locale, 'sRequests'), icon: <IconShieldOutlineRegular size={15} /> },
    { value: 'dispatch', label: t(locale, 'tabDispatch'), title: t(locale, 'sTasks'), icon: <IconChecklistOutlineRegular size={15} /> },
    { value: 'capabilities', label: t(locale, 'tabCapabilities'), title: t(locale, 'sCapabilities'), icon: <IconCordisPluginOutlineRegular size={15} /> },
    { value: 'mcp', label: t(locale, 'tabMcp'), title: t(locale, 'sMcp'), icon: <IconGlobeOutlineRegular size={15} /> },
    { value: 'persona', label: t(locale, 'tabPersona'), title: t(locale, 'personaTitle'), icon: <IconUserOutlineRegular size={15} />, dirty: personaDirty },
  ]
  const inspectItems: readonly DrawerNavItem[] = isTasks ? [] : [
    { value: 'context', label: t(locale, 'tabContext'), title: t(locale, 'ctxTitle'), icon: <IconGaugeOutlineRegular size={15} /> },
    { value: 'trajectory', label: t(locale, 'viewTrajectory'), title: t(locale, 'trTitle'), icon: <IconInspectOutlineRegular size={15} /> },
  ]
  const allItems: readonly DrawerNavItem[] = isTasks
    ? [{ value: 'tasks', label: t(locale, 'tasks'), title: t(locale, 'tasks'), icon: null, badge: waiting }]
    : [...proposalItems, ...configItems, ...inspectItems]
  const activeItem = allItems.find(item => item.value === tab) ?? allItems[0]!

  const renderNavButton = (item: DrawerNavItem) => (
    <Tooltip key={item.value} label={item.label} side="right" portal disabled={!navCompact}>
      <button
        type="button"
        className="dsh-dot-nav-item"
        data-nav={item.value}
        aria-pressed={tab === item.value}
        aria-controls={`dsh-dot-drawer-panel-${item.value}`}
        onClick={() => requestTab(item.value)}
      >
        <span className="dsh-dot-nav-icon" aria-hidden="true">{item.icon}</span>
        <span className="dsh-dot-nav-label">{item.label}</span>
        {item.badge && item.badge > 0 ? <span className="dsh-dot-nav-badge">{item.badge}</span> : null}
        {item.dirty ? <span className="dsh-dot-dirty-dot" aria-hidden="true" /> : null}
      </button>
    </Tooltip>
  )

  return (
    <div className="dsh-dot-drawer-layer" data-kind={isTasks ? 'tasks' : 'settings'}>
    <button type="button" tabIndex={-1} className="dsh-dot-drawer-backdrop" aria-label={t(locale, 'closeDrawer')} onClick={requestClose} />
    <aside ref={asideRef} className="dsh-dot-drawer" data-kind={isTasks ? 'tasks' : 'settings'} data-wide={wide && widthPx === undefined ? '' : undefined} data-resizing={dragging ? '' : undefined} role="dialog" aria-label={isTasks ? t(locale, 'tasks') : t(locale, 'settings')} {...widthPx === undefined ? {} : { style: { width: widthPx } }}>
      <div
        className="dsh-dot-drawer-resize"
        role="slider"
        tabIndex={0}
        aria-label={t(locale, 'resizeDrawer')}
        aria-orientation="vertical"
        aria-valuemin={DRAWER_MIN_PX}
        aria-valuemax={sliderMax}
        aria-valuenow={sliderNow}
        title={t(locale, 'resizeDrawer')}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResizeDrag}
        onPointerCancel={endResizeDrag}
        onKeyDown={onResizeKeyDown}
        onDoubleClick={resetWidth}
      />
      <header className="dsh-dot-drawer-head">
        <h2 className="dsh-dot-drawer-title">
          {activeItem.title}
          {isTasks && waiting > 0 ? <span className="dsh-dot-nav-badge">{waiting}</span> : null}
        </h2>
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
        <Button variant="ghost" size="sm" className="dsh-dot-drawer-widen" icon={effectiveWide ? <NarrowGlyph /> : <WidenGlyph />} aria-label={t(locale, effectiveWide ? 'narrowDrawer' : 'widenDrawer')} title={t(locale, effectiveWide ? 'narrowDrawer' : 'widenDrawer')} aria-pressed={effectiveWide} onClick={onWide} />
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
      <div className="dsh-dot-drawer-body" ref={bodyRef}>
        {!isTasks ? (
          <nav className="dsh-dot-drawer-nav" aria-label={t(locale, 'drawerTabs')}>
            {proposalItems.length > 0 ? (
              <>
                {proposalItems.map(renderNavButton)}
                <div className="dsh-dot-nav-sep" role="separator" />
              </>
            ) : null}
            <div className="dsh-dot-nav-group-label">{t(locale, 'sNavGroupConfig')}</div>
            {configItems.map(renderNavButton)}
            <div className="dsh-dot-nav-sep" role="separator" />
            <div className="dsh-dot-nav-group-label">{t(locale, 'sNavGroupInspect')}</div>
            {inspectItems.map(renderNavButton)}
          </nav>
        ) : null}
        <div className="dsh-dot-settings-scroll" ref={scrollerRef}>
          <div className="dsh-dot-settings" data-tab={tab} id={`dsh-dot-drawer-panel-${tab}`} role="region" aria-label={activeItem.title}>
            {tab === 'tasks'
              ? tasks
              : isSettingsSection(tab)
                ? <SettingsPanel locale={locale} api={api} section={tab} proposals={proposalState} {...settings ? { settings } : {}} onSaved={onSaved} onStatusChange={setSaveNotice} onProposalCount={onProposalCount} onSectionChange={requestTab} {...renderFactorySlot ? { renderFactorySlot } : {}} />
                : tab === 'persona'
                  ? <PersonaPanel locale={locale} api={api} {...settings ? { settings } : {}} discardSignal={discardSignal} onDirtyChange={onDirtyChange} onSaved={onSaved} onStatusChange={setSaveNotice} />
                  : tab === 'context'
                    ? <ContextPanel locale={locale} api={api} running={running} />
                    : <TrajectoryPanel locale={locale} api={api} {...trajectoryRev === undefined ? {} : { rev: trajectoryRev }} running={running} />}
          </div>
        </div>
      </div>
    </aside>
    </div>
  )
}

/** The Recipes filter: saved work orders with stats, bound reminders and a two-step Run now. */
/** The display form of one requirement: text plus the flags a revise can flip. */
function requirementSummary(row: import('./work.ts').Requirement): string {
  return `${row.text}${row.required ? '' : ' (optional)'}${row.scenarios?.length ? ` [${row.scenarios.map(item => item.when).join('; ')}]` : ''}`
}

/** Old→new for one text field; added/removed/changed lines for the lists — always diffed against the body approve would save. */
function ProposalDiff({ locale, proposal }: { locale: CopyLocale; proposal: NonNullable<RecipeBoardRow['proposal']> }) {
  const base = proposal.base ?? { goal: '', requirementsFromGoal: false, requirements: [], constraints: [] }
  const merged = mergedRecipeBody(base, proposal.patch ?? {})
  const rows: { label: string; before?: string; after?: string; added?: readonly string[]; removed?: readonly string[]; changed?: readonly { before: string; after: string }[] }[] = []
  if (merged.goal !== base.goal) rows.push({ label: t(locale, 'proposalGoal'), before: base.goal, after: merged.goal })
  if ((merged.notes ?? '') !== (base.notes ?? '')) rows.push({ label: t(locale, 'proposalNotes'), before: base.notes ?? '', after: merged.notes ?? '' })
  {
    const want = merged.requirements
    const have = base.requirements
    const added = want.filter(row => !have.some(old => old.requirementRef === row.requirementRef)).map(requirementSummary)
    const removed = have.filter(old => !want.some(row => row.requirementRef === old.requirementRef)).map(requirementSummary)
    const changed = want.flatMap(row => {
      const old = have.find(item => item.requirementRef === row.requirementRef)
      return old && JSON.stringify(old) !== JSON.stringify(row) ? [{ before: requirementSummary(old), after: requirementSummary(row) }] : []
    })
    if (added.length > 0 || removed.length > 0 || changed.length > 0) rows.push({ label: t(locale, 'proposalRequirements'), added, removed, changed })
  }
  {
    const want = merged.constraints ?? []
    const have = base.constraints ?? []
    const added = want.filter(row => !have.some(old => old.constraintRef === row.constraintRef)).map(row => row.text)
    const removed = have.filter(old => !want.some(row => row.constraintRef === old.constraintRef)).map(row => row.text)
    const changed = want.flatMap(row => {
      const old = have.find(item => item.constraintRef === row.constraintRef)
      return old && old.text !== row.text ? [{ before: old.text, after: row.text }] : []
    })
    if (added.length > 0 || removed.length > 0 || changed.length > 0) rows.push({ label: t(locale, 'proposalConstraints'), added, removed, changed })
  }
  if (rows.length === 0) return null
  return (
    <div className="dsh-dot-recipe-proposal-diff">
      {rows.map((row, index) => (
        <div key={`${row.label}-${index}`} className="dsh-dot-recipe-proposal-field">
          <span className="dsh-ui-meta">{row.label}</span>
          {row.before !== undefined ? <span className="dsh-ui-meta dsh-dot-recipe-diff-change">«{row.before}» → «{row.after}»</span> : null}
          {row.changed?.map(pair => <span key={`~${pair.before}`} className="dsh-ui-meta dsh-dot-recipe-diff-change">«{pair.before}» → «{pair.after}»</span>)}
          {row.added?.map(text => <span key={`+${text}`} className="dsh-ui-meta dsh-dot-recipe-diff-add">+ {text}</span>)}
          {row.removed?.map(text => <span key={`-${text}`} className="dsh-ui-meta dsh-dot-recipe-diff-remove">− {text}</span>)}
        </div>
      ))}
    </div>
  )
}

export function RecipesView({ locale, api, rows, error, onChanged }: {
  locale: CopyLocale; api: ChatApi; rows: readonly RecipeBoardRow[]; error?: string; onChanged: () => void
}) {
  const [arm, setArm] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [refusals, setRefusals] = useState<Readonly<Record<string, string>>>({})
  const [ran, setRan] = useState<Readonly<Record<string, string>>>({})
  const [approveArm, setApproveArm] = useState<string>()
  const [proposalBusy, setProposalBusy] = useState<string>()
  const [proposalErrors, setProposalErrors] = useState<Readonly<Record<string, string>>>({})
  const armTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => { if (armTimer.current !== undefined) clearTimeout(armTimer.current) }, [])
  const decide = (proposalId: string, allow: boolean) => {
    if (!api.recipeProposalDecide || proposalBusy) return
    if (allow && approveArm !== proposalId) {
      setApproveArm(proposalId)
      if (armTimer.current !== undefined) clearTimeout(armTimer.current)
      armTimer.current = setTimeout(() => setApproveArm(current => current === proposalId ? undefined : current), 5000)
      return
    }
    setApproveArm(undefined)
    setProposalBusy(proposalId)
    api.recipeProposalDecide(proposalId, allow).then(() => {
      setProposalErrors(prev => { const next = { ...prev }; delete next[proposalId]; return next })
      onChanged()
    }, (failure: unknown) => {
      setProposalErrors(prev => ({ ...prev, [proposalId]: failure instanceof Error ? failure.message : String(failure) }))
      onChanged()
    }).finally(() => setProposalBusy(undefined))
  }
  const run = (row: RecipeBoardRow) => {
    if (!api.recipeRun || busy) return
    if (arm !== row.id) {
      setArm(row.id)
      if (armTimer.current !== undefined) clearTimeout(armTimer.current)
      armTimer.current = setTimeout(() => setArm(current => current === row.id ? undefined : current), 5000)
      return
    }
    setArm(undefined)
    setBusy(row.id)
    api.recipeRun(row.id).then(result => {
      if (result.ok) {
        setRefusals(prev => { const next = { ...prev }; delete next[row.id]; return next })
        setRan(prev => ({ ...prev, [row.id]: result.changeId }))
        onChanged()
      } else {
        setRan(prev => { const next = { ...prev }; delete next[row.id]; return next })
        setRefusals(prev => ({ ...prev, [row.id]: result.reason }))
      }
    }, failure => {
      setRefusals(prev => ({ ...prev, [row.id]: failure instanceof Error ? failure.message : String(failure) }))
    }).finally(() => setBusy(undefined))
  }
  if (rows.length === 0) {
    if (error === undefined) return <p className="dsh-ui-hint">{t(locale, 'recipeEmpty')}</p>
    return <div className="dsh-ui-row" role="alert"><span className="dsh-ui-error" style={{ whiteSpace: 'pre-line' }}>{backendMissingText(locale, error) ?? `${t(locale, 'loadFailed')}: ${error}`}</span><Button variant="ghost" onClick={onChanged}>{t(locale, 'retry')}</Button></div>
  }
  return (
    <div className="dsh-dot-board dsh-dot-recipes">
      {error !== undefined ? <p className="dsh-ui-hint" role="status">{t(locale, 'recipesRefreshFailed')}: {error}</p> : null}
      {rows.map(row => {
        const inFlight = row.inFlight.length > 0
        const armed = arm === row.id
        return (
          <div key={row.id} className="dsh-dot-recipe" data-recipe={row.id}>
            <div className="dsh-dot-recipe-head">
              <span className="dsh-ui-compact dsh-ui-truncate">{row.name}</span>
              <Tag tone="neutral">{fillText(t(locale, 'recipeRev'), { n: String(row.revision) })}</Tag>
              <span className="dsh-ui-spacer" />
              <Button variant="primary" size="sm" disabled={inFlight || busy === row.id || !api.recipeRun} title={inFlight ? t(locale, 'recipeInFlightTip') : undefined} onClick={() => run(row)}>
                {armed ? t(locale, 'recipeRunConfirm') : t(locale, 'recipeRunNow')}
              </Button>
            </div>
            {row.stats.length > 0 ? (
              <div className="dsh-dot-recipe-stats">
                {row.stats.map(stat => (
                  <span key={stat.revision} className="dsh-ui-meta">
                    {fillText(t(locale, 'recipeRev'), { n: String(stat.revision) })}: {stat.accepted} {t(locale, 'recipeAccepted')} · {stat.cancelled} {t(locale, 'recipeCancelled')} · {stat.failedRounds} {t(locale, 'recipeFailedRounds')} · {stat.inFlight} {t(locale, 'recipeInFlight')}{(stat.avgTokens !== undefined || stat.avgWallMs !== undefined) ? ` · ${t(locale, 'recipeAvg')}: ${[stat.avgTokens !== undefined ? `${formatTokens(stat.avgTokens)} ${t(locale, 'workTokens')}` : '', stat.avgWallMs !== undefined ? formatDuration(stat.avgWallMs) : ''].filter(Boolean).join(' · ')}` : ''}
                  </span>
                ))}
              </div>
            ) : <span className="dsh-ui-meta">{t(locale, 'recipeNoRuns')}</span>}
            {row.reminders.length > 0 ? (
              <div className="dsh-dot-recipe-reminders">
                {row.reminders.map(reminder => (
                  <span key={reminder.id} className="dsh-ui-hint dsh-ui-truncate">
                    {reminder.title} · {t(locale, 'reminderNext').replace('{when}', formatWhen(reminder.nextAt))}
                  </span>
                ))}
              </div>
            ) : null}
            {row.inFlight.map(item => (
              <span key={item.changeId} className="dsh-ui-meta">{t(locale, 'recipeInFlightLabel')} {item.changeId} {item.title} ({item.status})</span>
            ))}
            {row.proposal ? (
              <div className="dsh-dot-recipe-proposal" data-proposal={row.proposal.id}>
                <div className="dsh-dot-recipe-proposal-head">
                  <Tag tone="warning">{row.proposal.kind === 'restore' ? t(locale, 'proposalKindRestore') : t(locale, 'proposalKindRevise')}</Tag>
                  <Tag tone="neutral">{row.proposal.origin === 'detector' ? t(locale, 'proposalOriginDetector') : t(locale, 'proposalOriginReflection')}</Tag>
                  {row.proposal.kind === 'restore' && row.proposal.targetRevision !== undefined
                    ? <span className="dsh-ui-meta">{fillText(t(locale, 'proposalRestoreLine'), { n: String(row.proposal.targetRevision) })}</span>
                    : null}
                </div>
                <span className="dsh-ui-hint">{row.proposal.reason}</span>
                {row.proposal.kind === 'revise' ? <ProposalDiff locale={locale} proposal={row.proposal} /> : null}
                <div className="dsh-dot-recipe-proposal-actions">
                  <Button variant="primary" size="sm" disabled={proposalBusy === row.proposal.id || !api.recipeProposalDecide} onClick={() => decide(row.proposal!.id, true)}>
                    {approveArm === row.proposal.id ? t(locale, 'proposalApproveConfirm') : t(locale, 'proposalApprove')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={proposalBusy === row.proposal.id || !api.recipeProposalDecide} onClick={() => decide(row.proposal!.id, false)}>
                    {t(locale, 'proposalDismiss')}
                  </Button>
                </div>
                {proposalErrors[row.proposal.id] ? <p className="dsh-ui-hint dsh-dot-recipe-refusal" role="alert">{proposalErrors[row.proposal.id]}</p> : null}
              </div>
            ) : null}
            {ran[row.id] ? <span className="dsh-ui-hint">{fillText(t(locale, 'recipeRunDone'), { id: ran[row.id]! })}</span> : null}
            {refusals[row.id] ? <p className="dsh-ui-hint dsh-dot-recipe-refusal">{fillText(t(locale, 'recipeRunFailed'), { reason: refusals[row.id]! })}</p> : null}
          </div>
        )
      })}
    </div>
  )
}

/** The board tab: a filter row, the work changes waiting on the human, then the board. */
function TasksTab({ locale, view, api, workApi, boardError, pendingRemoveTitle, onUndoRemove, onOpen, onRetry, onRemoveSchedule }: {
  locale: CopyLocale; view?: BoardView; api: ChatApi; workApi?: WorkApi; boardError?: string
  pendingRemoveTitle?: string; onUndoRemove?: () => void
  onOpen: (sessionId: string) => void; onRetry: () => void; onRemoveSchedule: (id: string) => void
}) {
  const [filter, setFilter] = useState<BoardFilter | 'recipes'>('all')
  const counts = boardCounts(view)
  const totalCount = useMemo(() => {
    if (!view) return 0
    const groups = groupBoard(view)
    const openWork = (view.work ?? []).filter(w => w.status !== 'done' && w.status !== 'cancelled').length
    return openWork + groups.requests.length + groups.watched.length + view.schedules.length
  }, [view])
  const [recipes, recipesError, refreshRecipes] = useRecipes(api)
  const filters: readonly { value: BoardFilter | 'recipes'; label: string }[] = [
    { value: 'all', label: totalCount > 0 ? `${t(locale, 'filterAll')} (${totalCount})` : t(locale, 'filterAll') },
    { value: 'waiting', label: `${t(locale, 'filterWaiting')} (${counts.waiting})` },
    { value: 'active', label: `${t(locale, 'filterActive')} (${counts.active})` },
    { value: 'watch', label: `${t(locale, 'filterWatch')} (${counts.watch})` },
    { value: 'recipes', label: `${t(locale, 'filterRecipes')} (${recipes.length})` },
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
      {filter === 'recipes' ? <RecipesView locale={locale} api={api} rows={recipes} {...recipesError === undefined ? {} : { error: recipesError }} onChanged={() => { refreshRecipes(); onRetry() }} /> : null}
      {workApi && filter !== 'watch' && filter !== 'recipes' ? <WorkBoardPanel locale={locale} api={workApi} filter={filter} items={view?.work ?? NO_WORK} pending={view?.pending ?? NO_PENDING} onChanged={onRetry} onOpenSession={onOpen} /> : null}
      {filter !== 'recipes' ? <Board locale={locale} view={view} filter={filter} suppressEmpty={(view?.work?.length ?? 0) > 0 || (Boolean(workApi) && filter === 'all')} {...boardError === undefined ? {} : { error: boardError }} onOpen={onOpen} onRetry={onRetry} onRemoveSchedule={onRemoveSchedule} onUnwatch={sessionId => { if (!api.unwatch) return; void api.unwatch(sessionId).then(onRetry, onRetry) }} /> : null}
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
      ...(api.workIntegrate ? { workIntegrate: api.workIntegrate } : {}),
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
  // One mount-time probe: the newest self-upgrade backup caches for the
  // backendMissing restore hint. An older backend's not-found is the version
  // skew the RPC wrapper already records; it must never break the panel.
  useEffect(() => {
    if (!api.selfStatus) return
    const life = new AbortController()
    api.selfStatus(life.signal).then(status => {
      if (!life.signal.aborted) writeSelfBackup(status?.lastBackup)
    }, () => {})
    return () => life.abort()
  }, [api])
  // Merge/deploy publishes lastBackup on the chat snapshot so an already-open
  // panel caches the restore path without waiting for a remount.
  useEffect(() => {
    if (snapshot?.lastBackup) writeSelfBackup(snapshot.lastBackup)
  }, [snapshot?.lastBackup?.dir, snapshot?.lastBackup?.lib])
  const backendOutdated = useSyncExternalStore(backendOutdatedStore.subscribe, backendOutdatedStore.getSnapshot)
  const { drawerTab, drawerWide, drawerWidthPx, personaDirty, discardSignal, pendingDrawerAction, configOpen, requestDrawer, discardDrawerAction, cancelDrawerAction, setPersonaDirty, toggleDrawerWide, setDrawerWidthPx } = useDrawerGuard()
  const labels = useMemo<MarkdownLabels>(() => {
    const c = cardCopy(locale)
    return { code: { copyLabel: c.copy, copiedLabel: c.copied }, footnotes: c.footnotes }
  }, [locale])

  const { pendingEchoes, pushEcho, removeEcho } = useLocalEchoes(state.items)

  const send = useCallback(async (text: string, images: readonly ChatImage[], files: readonly ChatFileReceipt[]) => {
    setSendError(undefined)
    const echo = pushEcho(text, images, files)
    try {
      await api.say(text, images, files.map(file => file.id))
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
        <Button variant="ghost" size="sm" className="dsh-dot-gear" aria-label={t(locale, 'settings')} aria-pressed={configOpen} title={t(locale, 'settings')} onClick={() => requestDrawer(configOpen ? { kind: 'close' } : { kind: 'tab', tab: 'general' })}>
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
          {pendingEchoes.map(echo => (
            <div key={'echo:' + echo.at} className="dsh-dot-user dsh-dot-echo">
              {echo.text ? <UserMessageBubble>{echo.text}</UserMessageBubble> : null}
              {echo.images.length > 0 ? <ImageNotes locale={locale} images={echo.images.map(image => ({ mediaType: image.mediaType, previewUrl: `data:${image.mediaType};base64,${image.data}`, ...(image.name ? { name: image.name } : {}) }))} onPreview={openPreview} /> : null}
              {echo.files.length > 0 ? <FileNotes files={echo.files} /> : null}
            </div>
          ))}
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
      {backendOutdated ? (
        <div className="dsh-dot-banner-wrap">
          <div className="dsh-dot-banner" role="status">
            <IconWarningOutlineRegular size={14} className="dsh-dot-banner-icon" />
            <span className="dsh-dot-banner-text">{t(locale, 'backendOutdated')}</span>
          </div>
        </div>
      ) : null}
      {error !== undefined ? (
        <div className="dsh-dot-banner-wrap">
          <div className="dsh-dot-banner" role="alert">
            <IconWarningOutlineRegular size={14} className="dsh-dot-banner-icon" />
            <span className="dsh-dot-banner-text" style={{ whiteSpace: 'pre-line' }}>{backendMissingText(locale, error) ?? `${t(locale, 'loadFailed')}: ${error}`}</span>
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
        onOpenSettings={() => requestDrawer({ kind: 'tab', tab: 'general' })}
        onAttach={(name, data) => api.attach(name, data)}
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
          tasks={<TasksTab locale={locale} api={api} {...board ? { view: board } : {}} {...workApi ? { workApi } : {}} {...boardError === undefined ? {} : { boardError }} {...pendingRemoval ? { pendingRemoveTitle: pendingRemoval.title, onUndoRemove: undoRemoveSchedule } : {}} onOpen={onOpenSession} onRetry={refreshBoard} onRemoveSchedule={removeSchedule} />}
          {...renderFactorySlot ? { renderFactorySlot } : {}}
          personaDirty={personaDirty}
          {...pendingDrawerAction ? { pendingAction: pendingDrawerAction } : {}}
          discardSignal={discardSignal}
          onRequest={requestDrawer}
          onCancelPending={cancelDrawerAction}
          onDiscardPending={discardDrawerAction}
          onDirtyChange={setPersonaDirty}
          onWide={toggleDrawerWide}
          widthPx={drawerWidthPx}
          onWidth={setDrawerWidthPx}
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
          {item.files && item.files.length > 0 ? <FileNotes files={item.files} /> : null}
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
  'recipe-run': 'success',
  'recipe-proposal': 'info',
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
    case 'recipe-run': return t(locale, 'recipeRunTag')
    case 'recipe-proposal': return t(locale, 'recipeProposalTag')
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
        {entry.refused ? <div className="dsh-dot-card-body">{fillText(t(locale, 'recipeRunFailed'), { reason: entry.refused })}</div> : null}
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

function FileNotes({ files }: { files: readonly { readonly name: string; readonly bytes: number }[] }) {
  return (
    <div className="dsh-dot-files">
      {files.map((file, index) => <span key={`${file.name}:${index}`} className="dsh-dot-file-chip">{file.name} · {humanBytes(file.bytes)}</span>)}
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
