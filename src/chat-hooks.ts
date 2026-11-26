/**
 * The chat panel's state hooks: feed polling, board polling, settings, context
 * usage, local send echoes, the scroll-bottom pin, the dirty-persona drawer
 * guard, and reminder removal with undo.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { BoardView, ChatItem, ChatSnapshot, DotSettings, RecipeBoardRow } from './contracts.ts'
import type { ChatImage } from './chat-images.ts'
import type { ChatFileReceipt } from './chat-files.ts'
import type { ChatApi } from './chat-panel.tsx'

const BOARD_POLL_MS = 5_000
const BOARD_FALLBACK_POLL_MS = 30_000
const RETRY_MS = 2_000
/** A sent message waits this long to show up in the log before its local echo is dropped. */
const ECHO_MS = 60_000
const STICK_PX = 96
const UNDO_REMINDER_MS = 4_500
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

export function useChatFeed(api: ChatApi): { state: ChatState; error?: string; retry: () => void } {
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

export function useBoard(api: ChatApi, feedBoardRev?: number): [BoardView | undefined, string | undefined, () => void] {
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

export function useRecipes(api: ChatApi): [readonly RecipeBoardRow[], string | undefined, () => void] {
  const [rows, setRows] = useState<readonly RecipeBoardRow[]>([])
  const [error, setError] = useState<string>()
  const [round, setRound] = useState(0)
  const lastTextRef = useRef('')
  useEffect(() => {
    if (!api.recipes) return
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    // Same cadence and unchanged-text optimisation as the board poll; a failed
    // poll surfaces an error but keeps the last good rows.
    const run = () => {
      api.recipes!(lifetime.signal).then(next => {
        if (lifetime.signal.aborted) return
        const text = JSON.stringify(next)
        if (text !== lastTextRef.current) { lastTextRef.current = text; setRows(next) }
        setError(undefined)
      }, failure => {
        if (!lifetime.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
      }).finally(() => {
        if (!lifetime.signal.aborted) timer = setTimeout(run, BOARD_POLL_MS)
      })
    }
    run()
    return () => { lifetime.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [api, round])
  return [rows, error, useCallback(() => setRound(value => value + 1), [])]
}

export function useSettings(api: ChatApi): [DotSettings | undefined, (next: DotSettings) => void] {
  const [settings, setSettings] = useState<DotSettings>()
  useEffect(() => {
    const lifetime = new AbortController()
    api.settings(lifetime.signal).then(setSettings, () => {})
    return () => lifetime.abort()
  }, [api])
  return [settings, setSettings]
}

export function useContextUse(api: ChatApi, rev: number | undefined, running: boolean): { used: number; window: number } | undefined {
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

export type SettingsSection = 'proposals' | 'general' | 'takeover' | 'dispatch' | 'capabilities' | 'mcp'
export type DrawerTab = 'tasks' | SettingsSection | 'persona' | 'context' | 'trajectory'
const CONFIG_TABS: ReadonlySet<DrawerTab> = new Set([
  'proposals', 'general', 'takeover', 'dispatch', 'capabilities', 'mcp', 'persona', 'context', 'trajectory',
])

/** A close or a tab switch; while the persona page holds unsaved edits the request waits for the human. */
export type DrawerAction = { readonly kind: 'close' } | { readonly kind: 'tab'; readonly tab: DrawerTab }

/** A message shown in the log before the host feed confirms it was accepted. */
export interface LocalEcho {
  readonly text: string
  readonly at: number
  readonly images: readonly ChatImage[]
  readonly files: readonly ChatFileReceipt[]
}

/**
 * Local echoes for sends the host has not logged yet. An echo leaves once the
 * feed holds a matching message sent after it; pendingEchoes is filtered during
 * render as well, so the frame that brings the logged copy never shows both.
 */
export function useLocalEchoes(items: readonly ChatItem[]): {
  pendingEchoes: readonly LocalEcho[]
  pushEcho: (text: string, images: readonly ChatImage[], files: readonly ChatFileReceipt[]) => LocalEcho
  removeEcho: (echo: LocalEcho) => void
} {
  const [echoes, setEchoes] = useState<LocalEcho[]>([])
  const delivered = useCallback((echo: LocalEcho) => items.some(item => item.kind === 'user' && item.text.trim() === echo.text && (item.images?.length ?? 0) === echo.images.length && (item.files?.length ?? 0) === echo.files.length && echo.files.every((file, index) => item.files?.[index]?.name === file.name && item.files[index].bytes === file.bytes) && item.at >= echo.at - 5_000), [items])
  const pendingEchoes = useMemo(() => echoes.filter(echo => !delivered(echo)), [echoes, delivered])
  useEffect(() => {
    if (echoes.length === 0) return
    const now = Date.now()
    const left = echoes.filter(echo => now - echo.at < ECHO_MS && !delivered(echo))
    if (left.length !== echoes.length) setEchoes(left)
  }, [echoes, delivered])
  const pushEcho = useCallback((text: string, images: readonly ChatImage[], files: readonly ChatFileReceipt[]) => {
    const echo: LocalEcho = { text, at: Date.now(), images, files }
    setEchoes(list => [...list, echo])
    return echo
  }, [])
  const removeEcho = useCallback((echo: LocalEcho) => {
    setEchoes(list => list.filter(item => item !== echo))
  }, [])
  return { pendingEchoes, pushEcho, removeEcho }
}

/**
 * Bottom pin for the scrolling log. Direction-aware: any real upward scroll
 * releases the pin, even within STICK_PX of the bottom, so streaming updates
 * cannot yank the viewport back. Scrolling back down to within STICK_PX re-pins.
 * A scrollTop drop that lands at the bottom is a browser clamp after the content
 * shrank, not a user gesture, so it keeps the pin.
 */
export function useScrollPin(activitySig: string, watch: readonly unknown[]): {
  scroller: React.RefObject<HTMLDivElement>
  pinned: boolean
  unreadBelow: boolean
  onScroll: () => void
  scrollToBottom: () => void
} {
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const lastTop = useRef(0)
  const [pinned, setPinned] = useState(true)
  const [unreadBelow, setUnreadBelow] = useState(false)
  const prevActivitySig = useRef(activitySig)
  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    const up = el.scrollTop < lastTop.current - 3 && gap > 3
    const nextPinned = up ? false : gap < STICK_PX
    stuck.current = nextPinned
    lastTop.current = el.scrollTop
    setPinned(prev => prev === nextPinned ? prev : nextPinned)
    if (nextPinned) setUnreadBelow(false)
  }, [])
  const scrollToBottom = useCallback(() => {
    const el = scroller.current
    stuck.current = true
    setPinned(true)
    setUnreadBelow(false)
    if (el) {
      el.scrollTop = el.scrollHeight
      lastTop.current = el.scrollTop
    }
  }, [])
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stuck.current) {
      el.scrollTop = el.scrollHeight
      lastTop.current = el.scrollTop
    } else if (!stuck.current && prevActivitySig.current !== activitySig) {
      setUnreadBelow(true)
    }
    prevActivitySig.current = activitySig
  }, [activitySig, ...watch])
  return { scroller, pinned, unreadBelow, onScroll, scrollToBottom }
}

export interface DrawerGuard {
  readonly drawerTab: DrawerTab | null
  readonly drawerWide: boolean
  readonly drawerWidthPx: number | undefined
  readonly personaDirty: boolean
  readonly discardSignal: number
  readonly pendingDrawerAction: DrawerAction | undefined
  readonly configOpen: boolean
  readonly requestDrawer: (action: DrawerAction) => void
  readonly discardDrawerAction: () => void
  readonly cancelDrawerAction: () => void
  readonly setPersonaDirty: (dirty: boolean) => void
  readonly toggleDrawerWide: () => void
  readonly setDrawerWidthPx: (px: number | undefined) => void
}

const DRAWER_WIDTH_KEY = 'dsh-dot:drawer-width'
/** Narrowest dragged drawer. Shared with the resize handle so a stored value cannot reopen thinner than the drag floor. */
export const DRAWER_MIN_PX = 340

/** Dragged drawer widths survive reopens; a malformed or too-narrow entry falls back to the CSS presets. */
function readDrawerWidth(): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(DRAWER_WIDTH_KEY)
    if (!raw) return undefined
    const px = Number(raw)
    return Number.isFinite(px) && px >= DRAWER_MIN_PX ? px : undefined
  } catch {
    return undefined
  }
}

/**
 * One guard for every way the drawer closes or switches: the header shortcuts,
 * the tab strip, Escape and the backdrop all pass through requestDrawer, so a
 * dirty persona page holds the request instead of dropping the draft.
 */
export function useDrawerGuard(): DrawerGuard {
  const [drawerTab, setDrawerTab] = useState<DrawerTab | null>(null)
  const [drawerWide, setDrawerWide] = useState(false)
  const [drawerWidthPx, setWidthPx] = useState<number | undefined>(readDrawerWidth)
  const [personaDirty, setPersonaDirty] = useState(false)
  const [discardSignal, setDiscardSignal] = useState(0)
  const [pendingDrawerAction, setPendingDrawerAction] = useState<DrawerAction>()
  const applyDrawerAction = useCallback((action: DrawerAction) => {
    setDrawerTab(action.kind === 'close' ? null : action.tab)
  }, [])
  const requestDrawer = useCallback((action: DrawerAction) => {
    if (action.kind === 'tab' && action.tab === drawerTab) return
    if (drawerTab === 'persona' && personaDirty) { setPendingDrawerAction(action); return }
    applyDrawerAction(action)
  }, [drawerTab, personaDirty, applyDrawerAction])
  const discardDrawerAction = useCallback(() => {
    const action = pendingDrawerAction
    setPendingDrawerAction(undefined)
    setPersonaDirty(false)
    setDiscardSignal(value => value + 1)
    if (action) applyDrawerAction(action)
  }, [pendingDrawerAction, applyDrawerAction])
  const cancelDrawerAction = useCallback(() => setPendingDrawerAction(undefined), [])
  const setDrawerWidthPx = useCallback((px: number | undefined) => {
    setWidthPx(px)
    try {
      if (px === undefined) globalThis.localStorage?.removeItem(DRAWER_WIDTH_KEY)
      else globalThis.localStorage?.setItem(DRAWER_WIDTH_KEY, String(Math.round(px)))
    } catch { /* a quota or privacy-mode failure must not break resizing */ }
  }, [])
  // The widen control follows the width actually on screen. A dragged width is not
  // the wide preset, so the next click clears it and applies 90cqw instead of
  // collapsing to the narrow preset.
  const toggleDrawerWide = useCallback(() => {
    const effective = drawerWide && drawerWidthPx === undefined
    setDrawerWidthPx(undefined)
    setDrawerWide(!effective)
  }, [drawerWide, drawerWidthPx, setDrawerWidthPx])
  // Leaving the persona page settles the guard: a saved page has nothing left to hold.
  useEffect(() => {
    if (drawerTab !== 'persona') { setPersonaDirty(false); setPendingDrawerAction(undefined) }
  }, [drawerTab])
  useEffect(() => { if (!personaDirty) setPendingDrawerAction(undefined) }, [personaDirty])
  return { drawerTab, drawerWide, drawerWidthPx, personaDirty, discardSignal, pendingDrawerAction, configOpen: drawerTab !== null && CONFIG_TABS.has(drawerTab), requestDrawer, discardDrawerAction, cancelDrawerAction, setPersonaDirty, toggleDrawerWide, setDrawerWidthPx }
}

export interface ReminderRemoval {
  readonly board: BoardView | undefined
  readonly pendingRemoval: { readonly id: string; readonly title: string } | undefined
  readonly removeSchedule: (id: string) => void
  readonly undoRemoveSchedule: () => void
}

/**
 * Deferred reminder removal so the tasks drawer can offer an undo. The row stays
 * hidden while the removal is in flight: a slow RPC must not show it again,
 * which would invite a second remove on top of the first.
 */
export function useReminderRemoval(api: ChatApi, refreshBoard: () => void, rawBoard: BoardView | undefined): ReminderRemoval {
  const [pendingRemoval, setPendingRemoval] = useState<{ id: string; title: string }>()
  const pendingRemovalRef = useRef<{ id: string; title: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined)
  const commitPendingRemoval = useCallback((id: string) => api.removeSchedule(id).then(refreshBoard, refreshBoard), [api, refreshBoard])
  useEffect(() => () => {
    if (pendingRemovalRef.current) {
      clearTimeout(pendingRemovalRef.current.timer)
      void api.removeSchedule(pendingRemovalRef.current.id).catch(() => {})
      pendingRemovalRef.current = undefined
    }
  }, [api])
  const removeSchedule = useCallback((id: string) => {
    if (pendingRemovalRef.current) {
      clearTimeout(pendingRemovalRef.current.timer)
      void commitPendingRemoval(pendingRemovalRef.current.id)
      pendingRemovalRef.current = undefined
    }
    const found = rawBoard?.schedules.find(item => item.id === id)
    if (!found) { void commitPendingRemoval(id); return }
    const timer = setTimeout(() => {
      pendingRemovalRef.current = undefined
      void commitPendingRemoval(id).finally(() => {
        setPendingRemoval(current => current?.id === id ? undefined : current)
      })
    }, UNDO_REMINDER_MS)
    pendingRemovalRef.current = { id, title: found.title, timer }
    setPendingRemoval({ id, title: found.title })
  }, [rawBoard, commitPendingRemoval])
  const undoRemoveSchedule = useCallback(() => {
    if (!pendingRemovalRef.current) return
    clearTimeout(pendingRemovalRef.current.timer)
    pendingRemovalRef.current = undefined
    setPendingRemoval(undefined)
  }, [])
  const board = useMemo<BoardView | undefined>(() => {
    if (!rawBoard || !pendingRemoval) return rawBoard
    return { ...rawBoard, schedules: rawBoard.schedules.filter(item => item.id !== pendingRemoval.id) }
  }, [rawBoard, pendingRemoval])
  return { board, pendingRemoval, removeSchedule, undoRemoveSchedule }
}
