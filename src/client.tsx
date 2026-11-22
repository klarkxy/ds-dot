/**
 * Browser half: a "Dorothy" row in the sidebar's panel list whose main panel is
 * Dorothy's own chat. Her session never appears among the host's sessions; the
 * panel talks to the host through one RPC channel and long-polls its feed.
 */
import type { Context } from '@deepseek-ai/cordis'
import { officialUiCss } from '@klarkxy/dsh-plugin-kit/official-ui'
import { installClientPluginLogger } from '@klarkxy/dsh-plugin-kit/client-logger'
import type { RenderFactorySlot } from '@klarkxy/dsh-plugin-kit/model-picker'
import { createDotCards } from './card-client.tsx'
export { createDotCards } from './card-client.tsx'
import { useMemo, useSyncExternalStore } from 'react'
import { BOARD_ROOT, boardCss } from './board.tsx'
import { CHAT_ROOT, ChatPanel, chatCss, type CardComponent, type ChatApi } from './chat-panel.tsx'
import { createAttentionWatcher, DESKTOP_NOTIFY_KEY, type AttentionWatcher } from './attention-client.ts'
import { contextCss } from './context-panel.tsx'
import { personaCss } from './persona-panel.tsx'
import { trajectoryCss } from './trajectory-panel.tsx'
import { PLUGIN_NAME, RPC_CHANNEL, type AttentionView, type BoardView, type RecipeBoardRow, type CapabilityCatalogView, type ChatSnapshot, type DotContextView, type DotSettings, type FactoryResetPreview, type FactoryResetResult, type KeepaliveInfo, type KnowledgeView, type ReflectionRun, type SettingProposal, type TrajectoryView } from './contracts.ts'
import type { UpdateStatus } from './auto-update.ts'
import { copyLocale, t, type CopyLocale } from './ui-copy.ts'
import { DotIcon } from './whale.tsx'

export const name = 'dsh-dot-client'
export const inject = ['slots', 'locale', 'uiWorkspace', 'connection', 'remote', 'remote.session'] as const

const PANEL_ID = 'dsh-dot'

interface LocaleService {
  getSnapshot(): { active: string }
  subscribe(listener: () => void): () => void
}

interface SlotRegistry {
  inject(key: string, callback: () => (() => void) | void): () => void
  register(spec: Record<string, unknown>, render: (props: never) => unknown): () => void
}

type Client = Context & {
  slots: SlotRegistry
  locale?: LocaleService
  uiWorkspace?: { openSession?(sessionId: string): unknown }
  connection?: { rpc?: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> } }
  remote?: { session?: { modelCatalog?: () => Promise<unknown> } }
}

type RpcReply<T> = { ok: true; value: T } | { ok: false; error: { message: string } }

export function apply(ctx: Context): void {
  const client = ctx as Client
  const logger = installClientPluginLogger(ctx, PLUGIN_NAME)
  const call = async <T,>(endpoint: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> => {
    const rpc = client.connection?.rpc
    if (!rpc) throw new Error('connection unavailable')
    const active = client.locale?.getSnapshot().active
    const body = active !== undefined && payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>), uiLocale: active }
      : payload
    try {
      const reply = await rpc.call(RPC_CHANNEL, endpoint, body, signal) as RpcReply<T>
      if (!reply || reply.ok !== true) {
        const error = new Error(reply?.ok === false ? reply.error.message : 'rpc failed') as Error & { code?: string }
        if (reply?.ok === false) error.code = (reply.error as { readonly code?: string }).code
        throw error
      }
      return reply.value
    } catch (error) {
      if (!signal?.aborted) logger.warn('rpc.call-failed', 'Dot client RPC call failed.', error, { endpoint })
      throw error
    }
  }
  const api: ChatApi = {
    chat: (itemsRev, signal) => call<ChatSnapshot | undefined>('chat', { itemsRev }, signal),
    wait: (rev, itemsRev, signal) => call<ChatSnapshot | undefined>('wait', { rev, itemsRev }, signal),
    say: async (text, images) => { await call('say', { text, ...(images && images.length > 0 ? { images } : {}) }) },
    stop: async () => { await call('stop') },
    board: signal => call<BoardView>('board', {}, signal),
    removeSchedule: id => call<boolean>('schedule.remove', { id }),
    recipes: signal => call<RecipeBoardRow[]>('recipes', {}, signal),
    recipeRun: id => call<{ ok: true; changeId: string; runId?: string } | { ok: false; reason: string }>('recipe.run', { id }),
    workAccept: async payload => { await call('work.accept', payload) },
    workReject: async payload => { await call('work.reject', payload) },
    workAnswer: async payload => { await call('work.answer', payload) },
    workResume: async payload => { await call('work.resume', payload) },
    workForceRelease: async payload => { await call('work.release', payload) },
    workIntegrate: async payload => { await call('work.integrate', payload) },
    workRead: request => call<{ source: string; body: string; truncated?: boolean; totalBytes?: number }>('work.read', request),
    settings: signal => call<DotSettings>('settings', {}, signal),
    setSettings: patch => call<DotSettings>('settings.set', { patch }),
    settingProposals: signal => call<SettingProposal[]>('settings.proposals', {}, signal),
    decideSetting: (id, allow) => call<string>('settings.decide', { id, allow }),
    capabilities: signal => call<CapabilityCatalogView>('capabilities.catalog', {}, signal),
    newSegment: () => call<string>('segment.new'),
    updateStatus: signal => call<UpdateStatus | null>('update.status', {}, signal),
    updateCheck: () => call<UpdateStatus>('update.check'),
    keepalive: signal => call<KeepaliveInfo | undefined>('keepalive', {}, signal),
    knowledge: signal => call<KnowledgeView>('knowledge', {}, signal),
    setAgreements: text => call<KnowledgeView>('agreements.set', { text }),
    undoAgreements: () => call<KnowledgeView>('agreements.undo'),
    setCognition: text => call<KnowledgeView>('cognition.set', { text }),
    restoreCognition: at => call<KnowledgeView>('cognition.restore', { at }),
    context: signal => call<DotContextView>('context', {}, signal),
    clearUsage: () => call<DotContextView>('context.clear'),
    trajectory: signal => call<TrajectoryView>('trajectory', {}, signal),
    reflectionRuns: signal => call<readonly ReflectionRun[]>('reflection.runs', {}, signal),
    reflectionTrajectory: (sessionId, signal) => call<TrajectoryView>('reflection.trajectory', { sessionId }, signal),
    models: async () => {
      const catalog = client.remote?.session?.modelCatalog
      if (typeof catalog !== 'function') throw new Error('model catalog unavailable')
      return catalog.call(client.remote!.session)
    },
    previewFactoryReset: () => call<FactoryResetPreview>('factory.preview'),
    confirmFactoryReset: token => call<FactoryResetResult>('factory.reset', { token }),
  }
  const openSession = (sessionId: string) => { void client.uiWorkspace?.openSession?.(sessionId) }
  const layout = () => client.get?.('layout' as never) as { selectPanel?(id: string): void } | undefined
  /**
   * Polls `attention` outside the panel. The fetch bypasses `call` on purpose:
   * a failing streak should log once through the watcher, not every interval
   * through the RPC wrapper.
   */
  const attention = createAttentionWatcher({
    fetch: async signal => {
      const rpc = client.connection?.rpc
      if (!rpc) throw new Error('connection unavailable')
      const reply = await rpc.call(RPC_CHANNEL, 'attention', {}, signal) as RpcReply<AttentionView>
      if (!reply || reply.ok !== true) throw new Error(reply?.ok === false ? reply.error.message : 'rpc failed')
      return reply.value
    },
    isAttended: () => document.visibilityState === 'visible' && document.hasFocus(),
    notify: item => {
      try { if (localStorage.getItem(DESKTOP_NOTIFY_KEY) !== '1') return } catch { return }
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      const title = t(localeOf(), 'attentionTitle')
      let notification: Notification
      try {
        notification = new Notification(title, { body: item.title, tag: item.id })
      } catch {
        // Android Chrome requires a service worker; no click handler there.
        void navigator.serviceWorker?.getRegistration()
          .then(registration => registration?.showNotification(title, { body: item.title, tag: item.id }))
          .catch(() => {})
        return
      }
      notification.onclick = () => {
        window.focus()
        try { layout()?.selectPanel?.(PANEL_ID) } catch { /* an unregistered panel keeps the current view */ }
        notification.close()
      }
    },
    log: error => logger.warn('attention.poll-failed', 'Dot attention poll failed.', error),
  })
  // Reuse the renderer, but keep every pending/reply request on dot's durable
  // asynchronous channel. The adapter runs once, so feed updates do not remount inputs.
  const ownCards = createDotCards(call, client.locale)
  const cards = (): CardComponent => ownCards.Card
  const localeOf = (): CopyLocale => copyLocale(client.locale?.getSnapshot().active)

  client.effect(() => {
    const stops: Array<() => void> = []
    if (client.locale) {
      let lastActive = client.locale.getSnapshot().active
      stops.push(client.locale.subscribe(() => {
        const active = client.locale?.getSnapshot().active
        if (active !== undefined && active !== lastActive) {
          lastActive = active
          void call('locale.sync', { locale: active }).catch(() => {})
        }
      }))
    }
    stops.push(client.slots.inject('main', () => client.slots.register({
      name: 'main',
      key: PANEL_ID,
    }, (props: { renderFactorySlot?: RenderFactorySlot }) => <DotPage locale={client.locale} api={api} cards={cards} onOpenSession={openSession} renderFactorySlot={props.renderFactorySlot} />)))
    stops.push(client.slots.inject('sidebar.panellist', () => client.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 20,
      label: () => t(localeOf(), 'dot'),
    }, props => {
      const { size, active } = props as { size?: number; active?: boolean }
      return <DotSidebarIcon size={size} active={active} watcher={attention} locale={client.locale} />
    })))
    attention.start()
    stops.push(() => attention.stop())
    return () => { for (const stop of stops.reverse()) stop() }
  })
}

/**
 * Sidebar glyph with the background "needs you" count. It renders outside the
 * chat CSS scope, so everything here is inline styles over DSH tokens.
 */
function DotSidebarIcon({ size, active, watcher, locale: service }: { size?: number; active?: boolean; watcher: AttentionWatcher; locale?: LocaleService }) {
  const snapshot = useSyncExternalStore(watcher.subscribe, watcher.getSnapshot)
  const locale = useLocale(service)
  const count = snapshot.count
  return (
    <span style={{ position: 'relative', display: 'inline-flex', lineHeight: 0 }}>
      <DotIcon size={size ?? 16} active={active === true} />
      {count > 0 ? (
        <span
          aria-label={t(locale, 'attentionBadge').replace('{n}', String(count))}
          style={{
            position: 'absolute', top: -4, right: -6, boxSizing: 'border-box',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minWidth: 13, height: 13, padding: '0 3px', borderRadius: 7,
            fontSize: 9, fontWeight: 600, lineHeight: '13px',
            background: 'var(--dsw-alias-state-warn-primary)',
            color: 'var(--dsw-alias-label-primary-foreground)',
          }}
        >{count > 9 ? '9+' : count}</span>
      ) : null}
    </span>
  )
}

function useLocale(service: LocaleService | undefined): CopyLocale {
  const active = useSyncExternalStore(
    listener => service?.subscribe(listener) ?? (() => {}),
    () => service?.getSnapshot().active ?? 'en',
  )
  return copyLocale(active)
}

function DotPage({ locale: service, api, cards, onOpenSession, renderFactorySlot }: { locale?: LocaleService; api: ChatApi; cards: () => CardComponent | undefined; onOpenSession: (sessionId: string) => void; renderFactorySlot?: RenderFactorySlot }) {
  const locale = useLocale(service)
  const Card = cards()
  const css = useMemo(() => officialUiCss([BOARD_ROOT, CHAT_ROOT]) + boardCss + chatCss + contextCss + trajectoryCss + personaCss, [])
  return (
    <>
      <style>{css}</style>
      <ChatPanel locale={locale} api={api} {...Card ? { Card } : {}} onOpenSession={onOpenSession} {...renderFactorySlot ? { renderFactorySlot } : {}} />
    </>
  )
}
