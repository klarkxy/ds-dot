import type { uiEn } from '@klarkxy/dsh-deep-view/copy'
import type { zhUi } from './locales/zh.ts'

export const SUPPORTED_LOCALES = ['zh', 'en', 'ja', 'de', 'es', 'fr', 'pt', 'ru'] as const

export type CopyLocale = (typeof SUPPORTED_LOCALES)[number]

export type TextKey = keyof typeof zhUi

export type UiText = Record<TextKey, string>

export type CardTextKey = keyof typeof uiEn

export type CardCopy = Record<CardTextKey, string>

export type ConfigCopy = {
  readonly homeDir: string
  readonly approvalGraceMs: string
  readonly cognitionPromptEntries: string
}

export type ApprovalCardCopy = {
  readonly title: string
  readonly approve: string
  readonly deny: string
  readonly session: string
  readonly request: string
}

export type PersonaCopy = {
  readonly defaultAddress: string
  readonly defaultPersona: string
  readonly sectionLead: string
  readonly addressCustom: string
  readonly addressDefault: string
}

export type LocalePack = {
  readonly intl: string
  readonly ui: UiText
  readonly card: CardCopy
  readonly config: ConfigCopy
  readonly approvalCard: ApprovalCardCopy
  readonly persona: PersonaCopy
}
