import { DotError, messageOf, type DotService } from './service.ts'
import { SETTING_FIELDS, TOOL, type DotSettings, type SettingField, type SettingProposal } from './contracts.ts'
import { type CopyLocale } from './i18n/index.ts'
import { lockedField, patchSettings } from './settings.ts'
import { defaultAddress, defaultPersona } from './persona.ts'
import { agreementsText, normalizeAgreements } from './memory.ts'

/** A proposal for the agreements field rewrites the stored agreements text. */
function valueOf(settings: DotSettings, field: SettingField, agreementsText: string, locale: CopyLocale = 'zh'): unknown {
  if (field === 'agreements') return agreementsText || null
  if (field === 'persona') return settings.persona ?? defaultPersona(locale)
  if (field === 'address') return settings.address ?? defaultAddress(locale)
  return settings[field] ?? null
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return '(default / empty)'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

export function proposalText(proposal: SettingProposal): string {
  return `${proposal.field}\nBefore: ${textOf(proposal.before)}\nAfter: ${textOf(proposal.after)}\nWhy: ${proposal.reason}`
}

/**
 * Compact read-only snapshot of the core hard-switch settings injected into
 * dot's system prompt. Rendered on every request so a settings change reaches
 * dot in the same segment without requiring a new segment rollover.
 */
export function settingsSnapshotBlock(settings: DotSettings): string {
  return [
    '[settings snapshot — read-only; use dot_settings to propose a change]',
    `scope: ${settings.scope}`,
    `approvals: ${settings.approvals}`,
    `questions: ${settings.questions}`,
    `taskPermission: ${settings.taskPermission}`,
    `reflection: ${settings.reflection}`,
    `idleCheckMinutes: ${settings.idleCheckMinutes}`,
  ].join('\n')
}

export class SelfSettings {
  constructor(private readonly dot: DotService) {}

  async read(): Promise<string> {
    const knowledge = await this.dot.knowledgeView()
    const locale = this.dot.locale ?? 'zh'
    const locks = this.dot.store.settings.locks ?? {}
    const fields = SETTING_FIELDS.map(field => `${field}${locks[field] ? ' [locked by the human]' : ''}: ${textOf(valueOf(this.dot.store.settings, field, agreementsText(knowledge.agreements.entries), locale))}`)
    const pending = this.dot.store.settingProposals.map(proposal => `${proposal.id} · ${proposal.field}: ${proposal.reason}`).join('\n')
    return `${fields.join('\n')}\n\nOnly propose an unlocked field with ${TOOL.settings} (action=propose); the human must approve it. Locks and homeDir are human-only.${pending ? `\n\nWaiting proposals:\n${pending}` : ''}`
  }

  async propose(input: { field: string; value: unknown; reason: string }): Promise<string> {
    return this.dot.serialSettings(() => this.proposeNow(input))
  }

  private async proposeNow(input: { field: string; value: unknown; reason: string }): Promise<string> {
    const field = lockedField(this.dot.store.settings, input.field)!
    if (!input.reason.trim()) throw new DotError('dot/invalid', 'reason must explain why the change helps')
    const locale = this.dot.locale ?? 'zh'
    let before: unknown
    let after: unknown
    if (field === 'agreements') {
      if (input.value !== null && typeof input.value !== 'string') throw new DotError('dot/invalid', 'agreements must be text or null')
      const knowledge = await this.dot.knowledgeView()
      before = agreementsText(knowledge.agreements.entries) || null
      const normalized = input.value === null ? '' : normalizeAgreements(String(input.value))
      after = normalized || null
    } else {
      const patch = { [field]: input.value }
      before = valueOf(this.dot.store.settings, field, '', locale)
      after = valueOf(patchSettings(this.dot.store.settings, patch, locale), field, '', locale)
    }
    if (this.dot.store.settingProposals.some(proposal => proposal.field === field)) throw new DotError('dot/proposal-exists', `a change to ${field} already waits for the human; ask them to review it before proposing another`)
    if (equal(before, after)) throw new DotError('dot/invalid', `${field} already has this value`)
    const proposal: SettingProposal = { id: `setting-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, field, before, after, reason: input.reason.trim(), createdAt: Date.now() }
    await this.dot.store.putSettingProposal(proposal)
    return `Proposal ${proposal.id} waits for the human in Settings > Proposed changes. Nothing changed yet.\n${proposalText(proposal)}`
  }

  async decide(id: string, allow: boolean): Promise<string> {
    const result = await this.dot.serialSettings(() => this.decideNow(id, allow))
    // settingsChanged queues on the same serial lane decideNow ran in, so it
    // can only be awaited after that lane work has returned.
    if (result.changed) await this.dot.settingsChanged()
    return result.message
  }

  private async decideNow(id: string, allow: boolean): Promise<{ message: string; changed: boolean }> {
    const proposal = this.dot.store.settingProposal(id)
    if (!proposal) throw new DotError('dot/unknown-proposal', `no waiting settings proposal ${id}`)
    const field = lockedField(this.dot.store.settings, proposal.field)!
    if (!allow) {
      await this.dot.store.deleteSettingProposal(id)
      return { message: `Declined ${id}; no settings changed.`, changed: false }
    }
    const locale = this.dot.locale ?? 'zh'
    const knowledge = await this.dot.knowledgeView()
    const current = field === 'agreements' ? agreementsText(knowledge.agreements.entries) || null : valueOf(this.dot.store.settings, field, '', locale)
    if (!equal(current, proposal.before)) throw new DotError('dot/proposal-stale', `${field} changed after this proposal. Decline it and ask Dorothy to propose the change again from the current value.`)
    try {
      if (field === 'agreements') await this.dot.setAgreements(proposal.after === null ? '' : String(proposal.after), 'human')
      else await this.dot.store.setSettings(patchSettings(this.dot.store.settings, { [field]: proposal.after }, locale))
    } catch (error) {
      throw new DotError('dot/proposal-failed', messageOf(error))
    }
    await this.dot.store.deleteSettingProposal(id)
    const now = field === 'agreements' ? agreementsText((await this.dot.knowledgeView()).agreements.entries) || null : valueOf(this.dot.store.settings, field, '', locale)
    // Agreements already reach dot before the next message; other fields apply through settingsChanged.
    return { message: `Approved ${id}; ${field} is now ${textOf(now)}.`, changed: field !== 'agreements' }
  }
}
