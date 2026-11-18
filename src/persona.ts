/**
 * dot's default persona and how she addresses the human; both can be replaced
 * in the persona settings page. The character draws on the community's Doro,
 * not on the game character, and stays conversational.
 */
import { personaPack, type CopyLocale } from './i18n/index.ts'

export const PERSONA_MAX_CHARS = 6000
export const ADDRESS_MAX_CHARS = 40

/** How she addresses the human unless the human chose otherwise. */
export function defaultAddress(locale: CopyLocale = 'zh'): string {
  return personaPack(locale).defaultAddress
}

export function defaultPersona(locale: CopyLocale = 'zh'): string {
  return personaPack(locale).defaultPersona
}

export const DEFAULT_ADDRESS = defaultAddress('zh')
export const DEFAULT_PERSONA = defaultPersona('zh')

/** Substitute `{address}` literally so `$` patterns in an address stay unchanged. */
function fillAddress(template: string, value: string): string {
  return template.replace('{address}', () => value)
}

/** The persona section of dot's system prompt for the current settings. */
export function personaSection(settings: { readonly persona?: string; readonly address?: string }, locale: CopyLocale = 'zh'): string {
  const pack = personaPack(locale)
  const persona = (settings.persona ?? pack.defaultPersona).trim()
  const address = settings.address?.trim()
  const lines = [pack.sectionLead]
  if (persona) lines.push(persona)
  lines.push(address
    ? fillAddress(pack.addressCustom, address)
    : fillAddress(pack.addressDefault, pack.defaultAddress))
  return lines.join('\n')
}
