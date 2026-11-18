import { de } from './locales/de.ts'
import { en } from './locales/en.ts'
import { es } from './locales/es.ts'
import { fr } from './locales/fr.ts'
import { ja } from './locales/ja.ts'
import { pt } from './locales/pt.ts'
import { ru } from './locales/ru.ts'
import { zh } from './locales/zh.ts'
import {
  SUPPORTED_LOCALES,
  type ApprovalCardCopy,
  type CardCopy,
  type CardTextKey,
  type ConfigCopy,
  type CopyLocale,
  type LocalePack,
  type PersonaCopy,
  type TextKey,
  type UiText,
} from './types.ts'

export {
  SUPPORTED_LOCALES,
  type ApprovalCardCopy,
  type CardCopy,
  type CardTextKey,
  type ConfigCopy,
  type CopyLocale,
  type LocalePack,
  type PersonaCopy,
  type TextKey,
  type UiText,
}

const PACKS: Record<CopyLocale, LocalePack> = {
  zh,
  en,
  ja,
  de,
  es,
  fr,
  pt,
  ru,
}

export function localePack(locale: CopyLocale): LocalePack {
  return PACKS[locale] ?? PACKS.en
}

export function isCopyLocale(value: unknown): value is CopyLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

export function copyLocale(active: string | undefined, fallback: CopyLocale = 'en'): CopyLocale {
  const trimmed = active?.trim().toLowerCase()
  if (!trimmed) return fallback
  const primary = trimmed.split(/[-_]/)[0]
  return isCopyLocale(primary) ? primary : fallback
}

export function intlLocale(locale: CopyLocale): string {
  return (PACKS[locale] ?? PACKS.en).intl
}

export function uiText(locale: CopyLocale): UiText {
  return (PACKS[locale] ?? PACKS.en).ui
}

export function t(locale: CopyLocale, key: TextKey): string {
  return uiText(locale)[key]
}

export function cardCopy(locale: CopyLocale): CardCopy {
  return (PACKS[locale] ?? PACKS.en).card
}

export function approvalCardCopy(locale: CopyLocale): ApprovalCardCopy {
  return (PACKS[locale] ?? PACKS.en).approvalCard
}

export function personaPack(locale: CopyLocale): PersonaCopy {
  return (PACKS[locale] ?? PACKS.en).persona
}

export function configI18n(): Record<CopyLocale, ConfigCopy> {
  return Object.fromEntries(SUPPORTED_LOCALES.map(locale => [locale, PACKS[locale].config])) as Record<CopyLocale, ConfigCopy>
}
