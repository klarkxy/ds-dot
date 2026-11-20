/** UI copy for the browser half; the model-facing text stays in prompt.ts. */
import type { FactoryResetPreview, ScheduleTiming } from './contracts.ts'
import {
  approvalCardCopy,
  cardCopy,
  copyLocale,
  intlLocale,
  t,
  uiText,
  type ApprovalCardCopy,
  type CardCopy,
  type CardTextKey,
  type CopyLocale,
  type TextKey,
} from './i18n/index.ts'

export {
  approvalCardCopy,
  cardCopy,
  copyLocale,
  intlLocale,
  t,
  type ApprovalCardCopy,
  type CardCopy,
  type CardTextKey,
  type CopyLocale,
  type TextKey,
}

/** Server-rendered approval card uses both languages when client locale is unavailable. */
export const APPROVAL_CARD_COPY = {
  title: '审批 / Approval', approve: '批准 / Approve', deny: '拒绝 / Deny',
  session: '会话 / Session', request: '请求 / Request',
} as const

/** Fill `{name}` slots in one pass: an inserted title or note is never re-scanned for a slot,
 *  and it is not read as a `$` replacement pattern the way `String.replace` would. */
export function fillText(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (slot: string, name: string) => values[name] ?? slot)
}

/** Compact token count: 860, 12.4K, 512K, 1.05M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return (k < 100 ? k.toFixed(1).replace(/\.0$/, '') : String(Math.round(k))) + 'K'
  }
  const m = n / 1_000_000
  return (m < 10 ? m.toFixed(2).replace(/\.?0+$/, '') : m.toFixed(1).replace(/\.0$/, '')) + 'M'
}

/** 850ms, 4.2s, 3m 05s. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** "12.3%"; one decimal below 10%, whole numbers above. */
export function formatPercent(ratio: number): string {
  const pct = ratio * 100
  return (pct < 10 ? pct.toFixed(1) : String(Math.round(pct))) + '%'
}

/** When a reminder repeats: "每天 09:00", "周一、周三 09:00", "每 30 分钟", "一次". */
export function timingLabel(locale: CopyLocale, timing: ScheduleTiming): string {
  switch (timing.kind) {
    case 'once': return t(locale, 'reminderOnce')
    case 'every': return timing.minutes % 60 === 0
      ? t(locale, 'reminderEveryHour').replace('{n}', String(timing.minutes / 60))
      : t(locale, 'reminderEveryMin').replace('{n}', String(timing.minutes))
    case 'daily': {
      if (!timing.weekdays) return t(locale, 'reminderDaily').replace('{time}', timing.time)
      const names = t(locale, 'reminderDayNames').split('|')
      const days = timing.weekdays.map(day => names[day - 1] ?? String(day)).join(t(locale, 'reminderDaySep'))
      return t(locale, 'reminderDays').replace('{days}', days).replace('{time}', timing.time)
    }
  }
}

/** A moment in the browser's local time: "09:00" today, "07-14 09:00" on another day. */
export function formatWhen(at: number, now = Date.now()): string {
  const date = new Date(at)
  const two = (value: number) => String(value).padStart(2, '0')
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`
  const today = new Date(now)
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  if (sameDay) return time
  const day = `${two(date.getMonth() + 1)}-${two(date.getDate())}`
  return date.getFullYear() === today.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}-${day} ${time}`
}

export function factoryResetScope(locale: CopyLocale, preview: FactoryResetPreview): string[] {
  const n = (key: TextKey, value: number) => t(locale, key).replace('{n}', String(value))
  const rows = [
    n('sFactoryTasks', preview.tasks),
    n('sFactoryChanges', preview.changes),
    n('sFactoryRuns', preview.runs),
    n('sFactorySchedules', preview.schedules),
    n('sFactoryProposals', preview.proposals),
    n('sFactoryCards', preview.cards),
    n('sFactoryInbox', preview.inbox),
    n('sFactorySegments', preview.pastSegments),
    n('sFactoryReflections', preview.reflections),
  ]
  if (preview.hasAgreements) rows.push(t(locale, 'sFactoryAgreements'))
  if (preview.hasCognition) rows.push(t(locale, 'sFactoryCognition'))
  // Archive ids are a union: sessions she opened plus her own conversation
  // segments and background runs. Showing the owned count beside the total made
  // "0 opened / 1 archived" look contradictory, so one row states the total and,
  // when her own sessions add to it, says so.
  const archiveTotal = preview.archiveSessionIds.length
  const selfSessions = archiveTotal - preview.ownedSessions
  rows.push(selfSessions > 0
    ? t(locale, 'sFactoryArchiveSelf').replace('{n}', String(archiveTotal)).replace('{m}', String(selfSessions))
    : n('sFactoryArchive', archiveTotal))
  return rows
}

/** Label of one of dot's tool calls; other tools keep their own name. */
export function toolLabel(locale: CopyLocale, name: string): string {
  const key = `tool_${name}`
  const ui = uiText(locale)
  if (Object.hasOwn(ui, key)) return ui[key as TextKey]
  if (name.startsWith('mcp__')) {
    const parts = name.split('__').filter(Boolean)
    if (parts.length >= 3) return parts.slice(2).join('__')
  }
  return name
}
