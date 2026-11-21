/** dot owns asynchronous cards independently of the host's one-open-card channel. */
import type { ShownView, ViewAnswer, ViewNode, ViewPresentation } from '@klarkxy/dsh-deep-view/contracts'
import { checkShownView, validateViewAnswer } from '@klarkxy/dsh-deep-view/core'
import { answerText } from '@klarkxy/dsh-deep-view/answer-text'
import type { CopyLocale } from './i18n/types.ts'
import type { DotStore } from './store.ts'

export interface DotCardRecord {
  readonly id: string
  readonly number: number
  readonly sessionId: string
  readonly callId: string
  readonly title: string
  readonly view: ViewNode
  readonly expired: boolean
  readonly approvalId?: string
  readonly approvalDetail?: import('./contracts.ts').ApprovalDetail
  readonly notificationPending?: boolean
  readonly answer?: ViewAnswer
  /** When the card was presented; orders synthetic feed rows where the call waits. */
  readonly shownAt?: number
  /** An approval card whose request settles it: later cards and bulk expiry leave it live. */
  readonly keepAlive?: true
}
export type DotCardPresentation = ViewPresentation & { dotCard?: { number: number; expired?: boolean } }

export class DotCards {
  private readonly claims = new Set<string>()
  constructor(private readonly store: DotStore, private readonly log?: (message: string) => void, private readonly now: () => number = Date.now) {}

  async present(shown: ShownView, callId: string, approvalId?: string): Promise<DotCardPresentation> {
    const base: ViewPresentation = { owner: 'dsh-deep-view', ...shown, awaitReply: shown.interactive }
    if (!shown.interactive) return base
    const sessionId = this.store.dotSessionId
    if (!sessionId || !callId) throw new Error('The active dot session and call id are required')
    const number = this.store.cardSequence + 1
    const id = `dot-card-${number}`
    const approvalDetail = approvalId ? this.store.approvalDetails.find(row => row.requestId === approvalId) : undefined
    // Approval calls wait on their card, so a parallel or later card must not
    // expire it; the request's own settlement (or a restart sweep) does.
    const keepAlive = callId.startsWith('capability:') || callId.startsWith('install:')
    const record: DotCardRecord = { id, number, sessionId, callId, title: shown.title, view: shown.view, expired: false, shownAt: this.now(), ...(keepAlive ? { keepAlive: true as const } : {}), ...(approvalId ? { approvalId } : {}), ...(approvalDetail ? { approvalDetail } : {}) }
    await this.store.addCard(record)
    return { ...base, viewId: id, dotCard: { number } }
  }

  pending(callId: string): DotCardRecord | null {
    const card = this.store.cards.find(card => card.callId === callId && !card.answer)
    return card && !('error' in checkShownView(card.title, card.view)) ? card : null
  }

  /** Expired cards cannot authorize actions; a fresh request needs a fresh card. */
  async answer(id: string, action: string, values: unknown, deliver: (card: DotCardRecord, answer: ViewAnswer) => Promise<boolean | void>): Promise<{ notificationPending: boolean }> {
    const card = this.store.cards.find(row => row.id === id)
    if (!card || card.answer) throw new Error('This card is already answered or unavailable')
    if (card.expired) throw new Error('This card has expired; its answer was not applied')
    if ('error' in checkShownView(card.title, card.view)) throw new Error('This card is no longer supported')
    if (this.claims.has(id)) throw new Error('This card is already being answered')
    if (!values || typeof values !== 'object' || Array.isArray(values) || typeof action !== 'string') throw new Error('Invalid card answer')
    const checked = validateViewAnswer(card.view, action, values)
    if (checked.error !== undefined) throw new Error(String(checked.error))
    const answer: ViewAnswer = { id, action, values: checked }
    this.claims.add(id)
    try {
      const notificationPending = await deliver(card, answer) === true
      // A committed approval must never become answerable again on write failure.
      await this.store.setCardAnswer(id, answer, notificationPending).catch(error => this.log?.(`dsh-dot: card answer checkpoint failed: ${String(error)}`))
      return { notificationPending }
    } finally { this.claims.delete(id) }
  }
}

const CARD_REPLY_HEAD: Record<CopyLocale, (n: number, title: string) => string> = {
  zh: (n, title) => `[答复卡片 #${n}「${title}」]`,
  en: (n, title) => `[Card reply #${n} "${title}"]`,
  ja: (n, title) => `[カード返信 #${n}「${title}」]`,
  de: (n, title) => `[Kartenantwort #${n} „${title}"]`,
  es: (n, title) => `[Respuesta a tarjeta #${n} «${title}»]`,
  fr: (n, title) => `[Réponse à la carte #${n} « ${title} »]`,
  pt: (n, title) => `[Resposta ao cartão #${n} "${title}"]`,
  ru: (n, title) => `[Ответ на карточку #${n} «${title}»]`,
}

export function cardAnswerText(card: DotCardRecord, answer: ViewAnswer, locale: CopyLocale = 'zh'): string {
  const head = (CARD_REPLY_HEAD[locale] ?? CARD_REPLY_HEAD.en)(card.number, card.title)
  return `${head} ${answerText(card, answer.action, answer.values)}`
}
