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
import { contextCss } from './context-panel.tsx'
import { personaCss } from './persona-panel.tsx'
import { trajectoryCss } from './trajectory-panel.tsx'
import { PLUGIN_NAME, RPC_CHANNEL, type BoardView, type ChatSnapshot, type DotContextView, type DotSettings, type FactoryResetPreview, type FactoryResetResult, type KnowledgeView, type ReflectionRun, type SettingProposal, type TrajectoryView } from './contracts.ts'
import { copyLocale, t, type CopyLocale } from './ui-copy.ts'
import type { WorkBoardItem } from './work-board.ts'
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
    try {
      const reply = await rpc.call(RPC_CHANNEL, endpoint, payload, signal) as RpcReply<T>
      if (!reply || reply.ok !== true) throw new Error(reply?.ok === false ? reply.error.message : 'rpc failed')
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
    confirmTask: async id => { await call('task.confirm', { id }) },
    deleteTask: async id => { await call('task.delete', { id }) },
    cancelTask: async id => { await call('task.cancel', { id }) },
    reviewTask: async (id, pass, note) => { await call('task.review', { id, pass, ...note === undefined ? {} : { note } }) },
    setTaskPriority: async (id, priority) => { await call('task.priority', { id, priority }) },
    workList: signal => call<WorkBoardItem[]>('work.list', {}, signal),
    workAccept: async payload => { await call('work.accept', payload) },
    workReject: async payload => { await call('work.reject', payload) },
    workAnswer: async payload => { await call('work.answer', payload) },
    workResume: async payload => { await call('work.resume', payload) },
    workRead: request => call<{ source: string; body: string }>('work.read', request),
    settings: signal => call<DotSettings>('settings', {}, signal),
    setSettings: patch => call<DotSettings>('settings.set', { patch }),
    settingProposals: signal => call<SettingProposal[]>('settings.proposals', {}, signal),
    decideSetting: (id, allow) => call<string>('settings.decide', { id, allow }),
    newSegment: () => call<string>('segment.new'),
    knowledge: signal => call<KnowledgeView>('knowledge', {}, signal),
    setAgreements: text => call<KnowledgeView>('agreements.set', { text }),
    undoAgreements: () => call<KnowledgeView>('agreements.undo'),
    setCognition: text => call<KnowledgeView>('cognition.set', { text }),
    restoreCognition: at => call<KnowledgeView>('cognition.restore', { at }),
    context: signal => call<DotContextView>('context', {}, signal),
    clearUsage: () => call<DotContextView>('context.clearUsage'),
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
  // Reuse the renderer, but keep every pending/reply request on dot's durable
  // asynchronous channel. The adapter runs once, so feed updates do not remount inputs.
  const ownCards = createDotCards(call, client.locale)
  const cards = (): CardComponent => ownCards.Card
  const localeOf = (): CopyLocale => copyLocale(client.locale?.getSnapshot().active)

  client.effect(() => {
    const stops: Array<() => void> = []
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
      return <DotIcon size={size ?? 16} active={active === true} />
    })))
    return () => { for (const stop of stops.reverse()) stop() }
  })
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
