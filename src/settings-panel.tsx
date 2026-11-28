/**
 * Dorothy's settings view, opened from the gear in her panel's header. Every
 * change saves at once; free-text fields save when they lose focus.
 */
import { groupModelMenuChoices, modelMenuShortName, parseModelMenuChoices, type ModelMenuChoice } from '@klarkxy/dsh-plugin-kit/model-menu'
import { renderModelPicker, type RenderFactorySlot } from '@klarkxy/dsh-plugin-kit/model-picker'
import { Button, Checkbox, IconCheckOutlineRegular, IconInfoOutlineRegular, IconSearchOutlineRegular, IconWarningOutlineRegular, Input, Switch, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SettingsSection } from './chat-hooks.ts'
export type { SettingsSection } from './chat-hooks.ts'
import { CapabilitiesMcpPanel, SegmentedChoice } from './capabilities-mcp-panel.tsx'
import {
  DEFAULT_GITHUB_POLL_SETTINGS, GITHUB_ADMISSION_ACTIONS, GITHUB_EVENT_TYPES, GITHUB_POLL_DEFAULT_SOURCE_ID,
  GITHUB_POLL_MAX_INTERVAL_SEC, GITHUB_POLL_MIN_INTERVAL_SEC, GITHUB_SENDER_CLASSES, TASK_PRESET_OPTIONS,
  WATCHDOG_MODES,
  type ApprovalMode, type CapabilityCatalogView, type CapabilityGrant, type DefaultTaskPreset, type DotMcpListView,
  type DotSettings, type FactoryResetPreview, type FactoryResetResult, type GithubAdmissionAction,
  type GithubAdmissionRule, type GithubEventType, type GithubPollSettings, type GithubPollStatusView,
  type GithubPollTestResult, type GithubSenderClass, type KeepaliveInfo, type ModelChoice, type SettingField,
  type SettingProposal, type TakeoverMode, type TaskModelRule, type TaskPermission, type WatchdogMode,
} from './contracts.ts'
import { DESKTOP_NOTIFY_KEY } from './attention-client.ts'
import type { UpdateResult, UpdateStatus } from './auto-update.ts'
import { cacheTtlModelOf } from './keepalive.ts'
import { parseWatchdogModelChoice } from './settings.ts'
import { factoryResetScope, formatWhen, t, type CopyLocale, type TextKey } from './ui-copy.ts'

/** null on model, watchdogModel, persona, address, mcpServers or githubPoll goes back to the default. */
export type SettingsPatch = { readonly [K in keyof DotSettings]?: K extends 'model' ? ModelChoice | null : K extends 'watchdogModel' ? string | ModelChoice | null : K extends 'persona' | 'address' ? string | null : K extends 'mcpServers' | 'githubPoll' ? DotSettings[K] | null : DotSettings[K] }
export type SaveNotice = { readonly kind: 'saved' } | { readonly kind: 'error'; readonly message: string }

export interface SettingsApi {
  setSettings(patch: SettingsPatch): Promise<DotSettings>
  /** The provider/model dot's next request would run on and its cache TTL; absent without keepalive UI. */
  keepalive?(signal: AbortSignal): Promise<KeepaliveInfo | undefined>
  /** Raw host model catalog; parsed here. */
  models(): Promise<unknown>
  settingProposals(signal: AbortSignal): Promise<SettingProposal[]>
  decideSetting(id: string, allow: boolean): Promise<string>
  /** Extra-capability catalog + what the live segment applied; absent in tests. */
  capabilities?(signal: AbortSignal): Promise<CapabilityCatalogView>
  /** Dot-local MCP servers + recommended catalog; absent in tests. */
  mcpList?(signal: AbortSignal): Promise<DotMcpListView>
  /** Store a server's token in the host credential store; returns only its state. */
  mcpCredentialSet?(server: string, value: string): Promise<{ configured: boolean; masked?: string }>
  mcpCredentialUnset?(server: string): Promise<{ configured: boolean }>
  /** Live task-permission options; absent in tests. */
  taskPermissionOptions?(signal: AbortSignal): Promise<{ options: TaskPermission[] }>
  /** Passive GitHub polling status snapshot; absent in tests. */
  githubPollStatus?(signal: AbortSignal): Promise<GithubPollStatusView>
  /** Interactive `gh` CLI & repo connectivity probe; absent in tests. */
  githubPollTest?(request: { readonly ghPath?: string; readonly hostname?: string; readonly repos?: readonly string[] }): Promise<GithubPollTestResult>
  settings(signal: AbortSignal): Promise<DotSettings>
  previewFactoryReset?(): Promise<FactoryResetPreview>
  confirmFactoryReset?(token: string): Promise<FactoryResetResult>
  updateStatus?(signal: AbortSignal): Promise<UpdateStatus | null>
  updateCheck?(): Promise<UpdateStatus>
}

const LocaleContext = createContext<CopyLocale>('zh')

const FOLLOW = ''
const keyOf = (choice: { provider: string; model: string }) => JSON.stringify([choice.provider, choice.model])
/** Entry of the task model list; the host side builds the same key (task-models.ts). */
const taskModelKey = (choice: { provider: string; model: string }) => `${choice.provider}/${choice.model}`

function useModels(api: SettingsApi): { choices?: ModelMenuChoice[]; failed: boolean } {
  const [state, setState] = useState<{ choices?: ModelMenuChoice[]; failed: boolean }>({ failed: false })
  useEffect(() => {
    let live = true
    api.models().then(
      value => { if (live) setState({ choices: parseModelMenuChoices(value), failed: false }) },
      () => { if (live) setState({ failed: true }) },
    )
    return () => { live = false }
  }, [api])
  return state
}

/** Shared trigger for the main and review-model pickers; the optional factory upgrades the same write path when installed. */
function ModelPickerInput({ locale, renderFactorySlot, choices, selected, onPick, onClear, followLabel, label }: {
  locale: CopyLocale
  renderFactorySlot: RenderFactorySlot | undefined
  choices: readonly ModelMenuChoice[]
  selected: { provider: string; model: string } | undefined
  onPick: (choice: { provider: string; model: string }) => void
  onClear: () => void
  followLabel: string
  label: string
}) {
  const groups = groupModelMenuChoices(choices, '')
  const pickKey = (key: string) => {
    if (key === FOLLOW) { onClear(); return }
    const choice = choices.find(item => keyOf(item) === key)
    if (choice) onPick({ provider: choice.provider, model: choice.model })
  }
  return renderModelPicker(renderFactorySlot, {
    locale,
    choices,
    selected,
    onPick,
    leading: [{ id: 'follow', label: followLabel, selected: selected === undefined }],
    onPickLeading: onClear,
    triggerLabel: selected ? (choices.find(item => item.provider === selected.provider && item.model === selected.model)?.label ?? `${selected.provider} / ${selected.model}`) : followLabel,
    modelLabel: label,
    searchPlaceholder: t(locale, 'sTaskModelsFilter'),
    emptyLabel: t(locale, 'sTaskModelsNoMatch'),
    clearSearchLabel: t(locale, 'sTaskModelsClear'),
    retryLabel: t(locale, 'retry'),
    listClassName: 'dsh-dot-chat',
  }, {
    fallback: (
      <select className="dsh-ui-select" aria-label={label} value={selected ? keyOf(selected) : FOLLOW} onChange={event => pickKey(event.target.value)}>
        <option value={FOLLOW}>{followLabel}</option>
        {groups.map(group => (
          <optgroup key={group.provider} label={group.name}>
            {group.items.map(choice => <option key={keyOf(choice)} value={keyOf(choice)}>{choice.label}</option>)}
          </optgroup>
        ))}
      </select>
    ),
  })
}

/** Info icon button that shows field guidance on hover/focus and pins it on click or tap. */
export function HelpTip({ locale, fieldLabel, text }: { locale: CopyLocale; fieldLabel: string; text: string }) {
  return (
    <Tooltip label={text} side="top" portal maxWidth={260} openOnClick>
      <button
        type="button"
        className="dsh-dot-help-tip"
        aria-label={t(locale, 'sHelpTip').replace('{field}', fieldLabel)}
      >
        <IconInfoOutlineRegular size={13} />
      </button>
    </Tooltip>
  )
}

function Field({ label, tip, help, helpTone, children }: {
  label: string
  tip?: string | undefined
  help?: string | undefined
  helpTone?: 'warn' | undefined
  children: ReactNode
}) {
  const locale = useContext(LocaleContext)
  return (
    <div className="dsh-ui-field">
      <div className="dsh-dot-setting-head">
        <span className="dsh-ui-label">
          <span>{label}</span>
          {tip ? <HelpTip locale={locale} fieldLabel={label} text={tip} /> : null}
        </span>
      </div>
      {children}
      {help ? <span className={helpTone === 'warn' ? 'dsh-ui-help dsh-ui-warn' : 'dsh-ui-help'}>{help}</span> : null}
    </div>
  )
}

/** Single-row setting for boolean switches and compact numeric inputs. */
function InlineField({ label, tip, control, below }: {
  label: string
  tip?: string | undefined
  control: ReactNode
  below?: ReactNode
}) {
  const locale = useContext(LocaleContext)
  return (
    <div className="dsh-ui-field">
      <div className="dsh-dot-inline-row">
        <span className="dsh-ui-label dsh-dot-inline-label">
          <span>{label}</span>
          {tip ? <HelpTip locale={locale} fieldLabel={label} text={tip} /> : null}
        </span>
        <div className="dsh-dot-inline-control">{control}</div>
      </div>
      {below}
    </div>
  )
}

function formatProposalValue(locale: CopyLocale, field: SettingProposal['field'], value: unknown, choices: readonly ModelMenuChoice[]): { text: string; block: boolean } {
  if (value === null || value === undefined || value === '') {
    return {
      text: field === 'model' ? t(locale, 'sModelFollow')
        : field === 'watchdogModel' ? t(locale, 'sWatchdogModelFollow')
        : t(locale, 'sProposalDefault'),
      block: false,
    }
  }
  switch (field) {
    case 'model': {
      const route = value as Partial<ModelChoice>
      if (typeof route.provider === 'string' && typeof route.model === 'string') {
        const hit = choices.find(item => item.provider === route.provider && item.model === route.model)
        return { text: hit?.label ?? `${route.provider} / ${route.model}`, block: false }
      }
      break
    }
    case 'watchdogMode':
      if (value === 'off' || value === 'observe' || value === 'auto') return { text: t(locale, `sWatchdogMode_${value}`), block: false }
      break
    case 'watchdogModel': {
      const route = typeof value === 'string' ? parseWatchdogModelChoice(value) : (value as Partial<ModelChoice>)
      if (route && typeof route.provider === 'string' && typeof route.model === 'string') {
        const hit = choices.find(item => item.provider === route.provider && item.model === route.model)
        return { text: hit?.label ?? `${route.provider} / ${route.model}`, block: false }
      }
      break
    }
    case 'scope':
      if (value === 'all' || value === 'tracked') return { text: t(locale, `sScope_${value}`), block: false }
      break
    case 'approvals':
      if (value === 'dot' || value === 'human' || value === 'deny') return { text: t(locale, `sApprovals_${value}`), block: false }
      break
    case 'questions':
      if (value === 'dot' || value === 'human' || value === 'off') return { text: t(locale, `sQuestions_${value}`), block: false }
      break
    case 'taskPermission':
      if (value === 'workspace-write' || value === 'danger-full-access' || value === 'safe-auto' || value === 'auto') return { text: t(locale, `sTaskPermission_${value}`), block: false }
      break
    case 'defaultTaskPreset':
      if (value === 'standard' || value === 'dot-worker') return { text: t(locale, `sDefaultTaskPreset_${value}`), block: false }
      break
    case 'reflection':
      if (typeof value === 'boolean') return { text: t(locale, value ? 'sReflection_on' : 'sReflection_off'), block: false }
      break
    case 'taskModels': {
      const rule = value as Partial<TaskModelRule>
      if (rule.mode === 'all') return { text: t(locale, 'sTaskModels_all'), block: false }
      if (rule.mode === 'allow' || rule.mode === 'deny') {
        const names = (rule.list ?? []).map(key => choices.find(item => taskModelKey(item) === key)?.label ?? key)
        const prefix = t(locale, `sTaskModels_${rule.mode}`)
        const joined = names.length > 0
          ? t(locale, 'sTaskModelsList').replace('{mode}', prefix).replace('{models}', names.join(', '))
          : t(locale, 'sTaskModelsNone').replace('{mode}', prefix).replace('{empty}', t(locale, 'sProposalDefault'))
        return { text: joined, block: joined.length > 56 }
      }
      break
    }
    default:
      break
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { text, block: field !== 'address' && (text.includes('\n') || text.length > 56) }
}

export interface ProposalsState {
  readonly rows: readonly SettingProposal[]
  readonly error: string
  readonly loaded: boolean
  readonly decide: (id: string, allow: boolean) => void
  readonly revision: number
}

/** Shared polling/decision hook so the settings drawer keeps badge counts live across every view. */
export function useSettingProposals(
  api: Pick<SettingsApi, 'settingProposals' | 'decideSetting'>,
  enabled: boolean,
  onDecided?: () => void,
  onCountChange?: (count: number) => void,
): ProposalsState {
  const [rows, setRows] = useState<SettingProposal[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [decidedRev, setDecidedRev] = useState(0)
  const onDecidedRef = useRef(onDecided)
  onDecidedRef.current = onDecided
  const onCountRef = useRef(onCountChange)
  onCountRef.current = onCountChange

  useEffect(() => {
    if (!enabled) return
    const life = new AbortController()
    const load = () => api.settingProposals(life.signal).then(
      next => { setRows(next); setLoaded(true); onCountRef.current?.(next.length); setError('') },
      failure => { if (!life.signal.aborted) { setLoaded(true); setError(failure instanceof Error ? failure.message : String(failure)) } },
    )
    void load()
    const timer = setInterval(load, 5000)
    return () => { life.abort(); clearInterval(timer) }
  }, [api, enabled, refresh])

  const decide = useCallback((id: string, allow: boolean) => {
    setError('')
    api.decideSetting(id, allow).then(() => {
      setRows(current => {
        const next = current.filter(row => row.id !== id)
        onCountRef.current?.(next.length)
        return next
      })
      setRefresh(value => value + 1)
      if (allow) setDecidedRev(value => value + 1)
      onDecidedRef.current?.()
    }, failure => setError(failure instanceof Error ? failure.message : String(failure)))
  }, [api])

  return { rows, error, loaded, decide, revision: decidedRev }
}

function Proposals({ locale, choices, state, showTitle }: { locale: CopyLocale; choices: readonly ModelMenuChoice[]; state: ProposalsState; showTitle: boolean }) {
  const { rows, error, decide } = state
  if (rows.length === 0 && !error) return null
  return (
    <div className="dsh-dot-pane-section">
      {showTitle ? <h3 className="dsh-dot-pane-section-title">{t(locale, 'sProposals')}</h3> : null}
      {error ? <div className="dsh-ui-error" role="alert">{error}</div> : null}
      <div className="dsh-dot-proposals">
        {rows.map(row => {
          const before = formatProposalValue(locale, row.field, row.before, choices)
          const after = formatProposalValue(locale, row.field, row.after, choices)
          const block = before.block || after.block
          return (
            <section className="dsh-dot-proposal" key={row.id}>
              <div className="dsh-dot-proposal-head">
                <strong>{t(locale, `field_${row.field}` as TextKey)}</strong>
              </div>
              <p className="dsh-dot-proposal-reason">{row.reason}</p>
              {block ? (
                <div className="dsh-dot-proposal-blocks">
                  <div><span>{t(locale, 'sProposalBefore')}</span><pre>{before.text}</pre></div>
                  <div><span>{t(locale, 'sProposalAfter')}</span><pre>{after.text}</pre></div>
                </div>
              ) : (
                <div className="dsh-dot-proposal-inline">
                  <span className="dsh-dot-proposal-chip" title={t(locale, 'sProposalBefore')}>{before.text}</span>
                  <span className="dsh-dot-proposal-arrow" aria-hidden="true">→</span>
                  <span className="dsh-dot-proposal-chip dsh-dot-proposal-chip--next" title={t(locale, 'sProposalAfter')}>{after.text}</span>
                </div>
              )}
              <div className="dsh-ui-actions">
                <Button variant="primary" size="sm" onClick={() => decide(row.id, true)}>{t(locale, 'sApprove')}</Button>
                <Button variant="ghost" size="sm" onClick={() => decide(row.id, false)}>{t(locale, 'sDecline')}</Button>
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

/** The longest routine-check interval the host accepts, in minutes; 0 turns the check off. */
const IDLE_CHECK_MAX = 1440

/** Minutes between routine checks; saved when the field loses focus, and a value the host would refuse goes back to the saved one. */
function IdleCheckInput({ locale, value, onCommit, label, unit }: { locale: CopyLocale; value: number; onCommit: (minutes: number) => void; label?: string; unit?: string }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = () => {
    const text = draft.trim()
    const minutes = Number(text)
    if (text === '' || !Number.isInteger(minutes) || minutes < 0 || minutes > IDLE_CHECK_MAX) { setDraft(String(value)); return }
    if (minutes !== value) onCommit(minutes)
  }
  return (
    <div className="dsh-dot-idle-check">
      <Input
        className="dsh-dot-idle-input"
        type="number"
        inputMode="numeric"
        min={0}
        max={IDLE_CHECK_MAX}
        step={1}
        aria-label={label ?? t(locale, 'sIdleCheck')}
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
      />
      <span className="dsh-ui-meta">{unit ?? t(locale, 'sIdleCheckUnit')}</span>
    </div>
  )
}

const UPDATE_RESULT_KEY: Record<UpdateResult['kind'], TextKey> = {
  updated: 'sUpdateResult_updated',
  'up-to-date': 'sUpdateResult_upToDate',
  'not-updatable': 'sUpdateResult_notUpdatable',
  unavailable: 'sUpdateResult_unavailable',
  'restart-required': 'sUpdateResult_restartRequired',
  failed: 'sUpdateResult_failed',
}

/** Last self-update check with its outcome, and a manual check button. */
function AutoUpdateLine({ locale, api }: { locale: CopyLocale; api: SettingsApi }) {
  const [status, setStatus] = useState<UpdateStatus | null>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const life = new AbortController()
    api.updateStatus!(life.signal).then(
      next => { if (!life.signal.aborted) setStatus(next) },
      () => { if (!life.signal.aborted) setStatus(null) },
    )
    return () => life.abort()
  }, [api])
  const check = () => {
    if (busy || !api.updateCheck) return
    setBusy(true)
    api.updateCheck().then(next => { setStatus(next); setBusy(false) }, () => setBusy(false))
  }
  const result = status?.lastResult
  const resultText = status?.pending ? t(locale, 'sUpdatePending').replace('{to}', status.pending.to)
    : result ? t(locale, UPDATE_RESULT_KEY[result.kind]).replace('{from}', result.from ?? '').replace('{to}', result.to ?? '').replace('{message}', result.message ?? '')
    : ''
  const line = status?.lastCheckAt ? `${t(locale, 'sUpdateLastCheck').replace('{at}', formatWhen(status.lastCheckAt))}${resultText ? ` · ${resultText}` : ''}` : resultText
  return (
    <div className="dsh-dot-update">
      {line ? <span className="dsh-ui-meta dsh-dot-update-meta">{line}</span> : <span />}
      <Button variant="ghost" size="sm" disabled={busy || !api.updateCheck} onClick={check}>{busy ? t(locale, 'sUpdateChecking') : t(locale, 'sUpdateCheck')}</Button>
    </div>
  )
}

function FactoryResetField({ locale, api, onSaved }: { locale: CopyLocale; api: SettingsApi; onSaved: (next: DotSettings) => void }) {
  const [preview, setPreview] = useState<FactoryResetPreview>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const load = () => {
    setBusy(true); setError(''); setDone('')
    api.previewFactoryReset!().then(next => { setPreview(next); setBusy(false) }, failure => {
      setError(failure instanceof Error ? failure.message : String(failure)); setBusy(false)
    })
  }
  const confirm = () => {
    if (!preview) return
    setBusy(true); setError('')
    api.confirmFactoryReset!(preview.token).then(result => {
      setPreview(undefined)
      if (result.archiveFailed.length > 0) {
        setDone('')
        setError(result.archiveFailed.map(row => `${row.sessionId}: ${row.message}`).join('\n'))
      } else {
        setDone(t(locale, 'sFactoryDone'))
      }
      setBusy(false)
      api.settings(new AbortController().signal).then(onSaved, () => {})
    }, failure => {
      setPreview(undefined)
      setError(failure instanceof Error ? failure.message : String(failure)); setBusy(false)
      api.settings(new AbortController().signal).then(onSaved, () => {})
    })
  }
  return (
    <div className="dsh-dot-pane-section dsh-dot-factory" data-tone="danger">
      <div className="dsh-dot-factory-head">
        <span className="dsh-ui-label">
          <span>{t(locale, 'sFactory')}</span>
          <HelpTip locale={locale} fieldLabel={t(locale, 'sFactory')} text={t(locale, 'sFactoryDesc')} />
        </span>
        {!preview ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={load}>{busy ? t(locale, 'sFactoryBusy') : t(locale, error ? 'sFactoryRetry' : 'sFactoryPreview')}</Button>
        ) : null}
      </div>
      {preview ? (
        <>
          <div className="dsh-dot-factory-preview">
            <div className="dsh-ui-label">{t(locale, 'sFactoryScope')}</div>
            <ul>{factoryResetScope(locale, preview).map(line => <li key={line}>{line}</li>)}</ul>
            <p className="dsh-ui-help">{t(locale, 'sFactoryKeep')}</p>
          </div>
          <div className="dsh-ui-actions">
            <Button variant="primary" size="sm" className="dsh-dot-danger" disabled={busy} onClick={confirm}>{busy ? t(locale, 'sFactoryBusy') : t(locale, 'sFactoryConfirm')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setPreview(undefined); setError(''); setDone('') }}>{t(locale, 'sFactoryCancel')}</Button>
          </div>
        </>
      ) : null}
      {error ? <div className="dsh-ui-error" role="alert">{t(locale, 'sFactoryFailed')}{error}</div> : null}
      {done ? <div className="dsh-ui-notice" role="status">{done}</div> : null}
    </div>
  )
}

/**
 * Browser-local desktop-notification switch. The pref lives in localStorage of
 * this browser only — it is not a DotSettings field, so there is no lock and
 * Dorothy cannot propose it. The permission request stays inside the click's
 * user gesture; a non-granted result leaves the switch off with an inline note.
 */
function DesktopNotifyField({ locale }: { locale: CopyLocale }) {
  const supported = typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function'
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(DESKTOP_NOTIFY_KEY) === '1' } catch { return false }
  })
  const [status, setStatus] = useState<'blocked' | 'unsupported'>()
  const shown = status ?? (enabled ? (supported ? (Notification.permission === 'granted' ? undefined : 'blocked') : 'unsupported') : undefined)
  const onChange = (next: boolean) => {
    if (!next) {
      try { localStorage.removeItem(DESKTOP_NOTIFY_KEY) } catch { /* storage may be unavailable */ }
      setEnabled(false)
      setStatus(undefined)
      return
    }
    const ok = typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function'
    if (!ok) { setStatus('unsupported'); return }
    void Notification.requestPermission().then(permission => {
      if (permission !== 'granted') { setStatus('blocked'); return }
      try { localStorage.setItem(DESKTOP_NOTIFY_KEY, '1') } catch { /* storage may be unavailable */ }
      setEnabled(true)
      setStatus(undefined)
    }, () => setStatus('blocked'))
  }
  return (
    <InlineField
      label={t(locale, 'sNotify')}
      tip={t(locale, 'sNotifyDesc')}
      control={<Switch checked={enabled} label={t(locale, 'sNotify')} onChange={onChange} />}
      below={shown ? <span className="dsh-ui-help">{t(locale, shown === 'blocked' ? 'sNotifyBlocked' : 'sNotifyUnsupported')}</span> : null}
    />
  )
}

/** Placeholder blocks while a drawer page reads its data; the label stays for screen readers. */
export function PaneSkeleton({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div className="dsh-dot-skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="dsh-dot-skeleton-card" aria-hidden="true">
          <span className="dsh-dot-skeleton-bar" data-w="title" />
          <span className="dsh-dot-skeleton-bar" data-w="field" />
          <span className="dsh-dot-skeleton-bar" data-w="line" />
        </div>
      ))}
    </div>
  )
}

const CLIENT_GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/

function normalizeRepoInput(raw: string): string {
  return raw.trim().toLowerCase()
}

function normalizeRepoListClient(repos: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of repos) {
    const norm = normalizeRepoInput(raw)
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

function effectiveGithubPollClient(settings: DotSettings): GithubPollSettings {
  const raw = settings.githubPoll
  if (!raw) return DEFAULT_GITHUB_POLL_SETTINGS
  return {
    ...DEFAULT_GITHUB_POLL_SETTINGS,
    ...raw,
    repos: normalizeRepoListClient(raw.repos ?? []),
    webhookRepos: normalizeRepoListClient(raw.webhookRepos ?? []),
    streams: {
      issues: raw.streams?.issues ?? true,
      pulls: raw.streams?.pulls ?? true,
      comments: raw.streams?.comments ?? true,
      ci: raw.streams?.ci ?? true,
    },
    ignoredActors: raw.ignoredActors ?? [],
    sourceId: raw.sourceId || GITHUB_POLL_DEFAULT_SOURCE_ID,
    admission: raw.admission ?? [],
  }
}

/** Poll-primary GitHub intake settings, connection tester, Fast-Path admission matrix, and collapsed Webhook overrides. */
function GithubSettingsSection({ locale, api, settings, onSave }: {
  locale: CopyLocale
  api: SettingsApi
  settings: DotSettings
  onSave: (next: GithubPollSettings) => void
}) {
  const gh = effectiveGithubPollClient(settings)
  const [pollStatus, setPollStatus] = useState<GithubPollStatusView>()
  const [statusTick, setStatusTick] = useState(0)

  const [pollRepoDraft, setPollRepoDraft] = useState('')
  const [pollRepoError, setPollRepoError] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [webhookRepoDraft, setWebhookRepoDraft] = useState('')
  const [webhookRepoError, setWebhookRepoError] = useState('')

  const [draftGhPath, setDraftGhPath] = useState(gh.ghPath)
  const [draftHostname, setDraftHostname] = useState(gh.hostname ?? '')
  const [draftInterval, setDraftInterval] = useState(String(gh.intervalSec))
  const [draftActors, setDraftActors] = useState(gh.ignoredActors.join(', '))
  const [draftSourceId, setDraftSourceId] = useState(gh.sourceId ?? GITHUB_POLL_DEFAULT_SOURCE_ID)

  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState<GithubPollTestResult>()
  const [testError, setTestError] = useState('')

  const [admRepo, setAdmRepo] = useState('*')
  const [admEvent, setAdmEvent] = useState<GithubEventType>('comment')
  const [admSender, setAdmSender] = useState<GithubSenderClass>('human')
  const [admAction, setAdmAction] = useState<GithubAdmissionAction>('inbox')
  const [admError, setAdmError] = useState('')

  useEffect(() => { setDraftGhPath(gh.ghPath) }, [gh.ghPath])
  useEffect(() => { setDraftHostname(gh.hostname ?? '') }, [gh.hostname])
  useEffect(() => { setDraftInterval(String(gh.intervalSec)) }, [gh.intervalSec])
  useEffect(() => { setDraftActors(gh.ignoredActors.join(', ')) }, [gh.ignoredActors])
  useEffect(() => { setDraftSourceId(gh.sourceId ?? GITHUB_POLL_DEFAULT_SOURCE_ID) }, [gh.sourceId])

  const ghSig = JSON.stringify(gh)
  useEffect(() => {
    if (!api.githubPollStatus) return
    const life = new AbortController()
    const load = () => api.githubPollStatus!(life.signal).then(
      next => { if (!life.signal.aborted) setPollStatus(next) },
      () => {},
    )
    void load()
    const timer = setInterval(load, 5000)
    return () => { life.abort(); clearInterval(timer) }
  }, [api, ghSig, statusTick])

  const commit = (patch: Partial<GithubPollSettings>) => {
    const rawHost = ('hostname' in patch ? patch.hostname : gh.hostname)?.trim().toLowerCase()
    const cleanHost = rawHost && rawHost !== 'github.com' ? rawHost : undefined
    const next: GithubPollSettings = {
      enabled: patch.enabled ?? gh.enabled,
      repos: normalizeRepoListClient(patch.repos ?? gh.repos),
      webhookRepos: normalizeRepoListClient(patch.webhookRepos ?? gh.webhookRepos),
      ghPath: (patch.ghPath ?? gh.ghPath).trim() || 'gh',
      ...(cleanHost ? { hostname: cleanHost } : {}),
      intervalSec: patch.intervalSec ?? gh.intervalSec,
      streams: patch.streams ?? gh.streams,
      ignoredActors: [...new Set((patch.ignoredActors ?? gh.ignoredActors).map(a => a.trim().toLowerCase()).filter(Boolean))],
      sourceId: (patch.sourceId ?? gh.sourceId)?.trim() || GITHUB_POLL_DEFAULT_SOURCE_ID,
      admission: patch.admission ?? gh.admission ?? [],
    }
    onSave(next)
  }

  const addPollRepo = () => {
    const norm = normalizeRepoInput(pollRepoDraft)
    if (!CLIENT_GITHUB_REPO_RE.test(norm)) {
      setPollRepoError(t(locale, 'sGhErrRepoFormat'))
      return
    }
    if (gh.webhookRepos.includes(norm)) {
      setPollRepoError(t(locale, 'sGhErrMutualExclusionPoll').replace('{repo}', norm))
      setAdvancedOpen(true)
      return
    }
    if (gh.repos.includes(norm)) {
      setPollRepoError(t(locale, 'sGhErrDuplicateRepo').replace('{repo}', norm))
      return
    }
    setPollRepoError('')
    setPollRepoDraft('')
    commit({ repos: [...gh.repos, norm] })
  }

  const addWebhookRepo = () => {
    const norm = normalizeRepoInput(webhookRepoDraft)
    if (!CLIENT_GITHUB_REPO_RE.test(norm)) {
      setWebhookRepoError(t(locale, 'sGhErrRepoFormat'))
      return
    }
    if (gh.repos.includes(norm)) {
      setWebhookRepoError(t(locale, 'sGhErrMutualExclusionWebhook').replace('{repo}', norm))
      return
    }
    if (gh.webhookRepos.includes(norm)) {
      setWebhookRepoError(t(locale, 'sGhErrDuplicateRepo').replace('{repo}', norm))
      return
    }
    setWebhookRepoError('')
    setWebhookRepoDraft('')
    commit({ webhookRepos: [...gh.webhookRepos, norm] })
  }

  const commitInterval = () => {
    const text = draftInterval.trim()
    const num = Number(text)
    if (text === '' || !Number.isInteger(num) || num < GITHUB_POLL_MIN_INTERVAL_SEC || num > GITHUB_POLL_MAX_INTERVAL_SEC) {
      setDraftInterval(String(gh.intervalSec))
      return
    }
    if (num !== gh.intervalSec) commit({ intervalSec: num })
  }

  const commitGhPath = () => {
    const clean = draftGhPath.trim()
    if (!clean) { setDraftGhPath(gh.ghPath); return }
    if (clean !== gh.ghPath) commit({ ghPath: clean })
  }

  const commitHostname = () => {
    const clean = draftHostname.trim().toLowerCase()
    const normalized = clean && clean !== 'github.com' ? clean : undefined
    if (normalized !== gh.hostname) commit({ hostname: normalized })
  }

  const commitActors = () => {
    const list = [...new Set(draftActors.split(/[,\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean))]
    if (JSON.stringify(list) !== JSON.stringify(gh.ignoredActors)) commit({ ignoredActors: list })
  }

  const commitSourceId = () => {
    const clean = draftSourceId.trim() || GITHUB_POLL_DEFAULT_SOURCE_ID
    setDraftSourceId(clean)
    if (clean !== (gh.sourceId ?? GITHUB_POLL_DEFAULT_SOURCE_ID)) commit({ sourceId: clean })
  }

  const runTest = () => {
    if (testBusy || !api.githubPollTest) return
    setTestBusy(true)
    setTestError('')
    const hostVal = draftHostname.trim().toLowerCase()
    api.githubPollTest({
      ghPath: draftGhPath.trim() || gh.ghPath,
      ...(hostVal && hostVal !== 'github.com' ? { hostname: hostVal } : {}),
      repos: gh.repos,
    }).then(
      res => { setTestResult(res); setTestBusy(false); setStatusTick(v => v + 1) },
      failure => { setTestResult(undefined); setTestError(failure instanceof Error ? failure.message : String(failure)); setTestBusy(false) },
    )
  }

  const rules = gh.admission ?? []
  const advancedCount = rules.length + gh.webhookRepos.length
  const addAdmissionRule = () => {
    const raw = admRepo.trim()
    const norm = raw === '*' ? '*' : normalizeRepoInput(raw)
    if (norm !== '*' && !CLIENT_GITHUB_REPO_RE.test(norm)) {
      setAdmError(t(locale, 'sGhErrAdmissionRepo'))
      return
    }
    setAdmError('')
    const nextRule: GithubAdmissionRule = { repo: norm, eventType: admEvent, senderClass: admSender, action: admAction }
    const idx = rules.findIndex(r => r.repo === norm && r.eventType === admEvent && r.senderClass === admSender)
    const nextRules = idx >= 0
      ? rules.map((r, i) => (i === idx ? nextRule : r))
      : [...rules, nextRule]
    commit({ admission: nextRules })
  }

  const statusErrorText = pollStatus?.lastError ?? pollStatus?.repos.find(r => r.lastError)?.lastError ?? ''
  const showHealthAlert = Boolean(pollStatus && (pollStatus.alert || pollStatus.health === 'error'))
  const showHealthDegraded = Boolean(pollStatus && !showHealthAlert && (pollStatus.health === 'degraded' || pollStatus.consecutiveFailures > 0))
  const showBudgetWarn = Boolean(pollStatus && (pollStatus.budgetAdjusted || pollStatus.budgetWarning))

  return (
    <>
      <div className="dsh-dot-pane-section dsh-dot-gh" data-gh-card="poll">
        <div className="dsh-dot-gh-head">
          <h4 className="dsh-dot-gh-title">{t(locale, 'sGhPollCardTitle')}</h4>
          {pollStatus ? (
            <span className="dsh-dot-gh-health" data-health={pollStatus.health}>
              {t(locale, `sGhHealth_${pollStatus.health}` as TextKey)}
            </span>
          ) : null}
        </div>
        <p className="dsh-dot-gh-desc">{t(locale, 'sGhPollCardDesc')}</p>

        {showHealthAlert && pollStatus ? (
          <div className="dsh-dot-gh-banner dsh-dot-gh-banner--error" role="alert">
            <IconWarningOutlineRegular size={14} />
            <span>{t(locale, 'sGhHealthError').replace('{count}', String(pollStatus.consecutiveFailures)).replace('{error}', statusErrorText)}</span>
          </div>
        ) : null}
        {showHealthDegraded && pollStatus ? (
          <div className="dsh-dot-gh-banner dsh-dot-gh-banner--warn" role="status">
            <IconWarningOutlineRegular size={14} />
            <span>{t(locale, 'sGhHealthDegraded').replace('{count}', String(pollStatus.consecutiveFailures)).replace('{error}', statusErrorText)}</span>
          </div>
        ) : null}
        {showBudgetWarn && pollStatus ? (
          <div className="dsh-dot-gh-banner dsh-dot-gh-banner--warn" role="status" data-gh-budget="warn">
            <IconWarningOutlineRegular size={14} />
            <span>
              {t(locale, 'sGhBudgetWarning')
                .replace('{hourly}', String(pollStatus.hourlyRequests ?? '?'))
                .replace('{limit}', String(pollStatus.budgetLimitPerHour ?? '?'))
                .replace('{user}', String(pollStatus.userIntervalSec))
                .replace('{effective}', String(pollStatus.effectiveIntervalSec))}
            </span>
          </div>
        ) : null}

        <div className="dsh-ui-form">
          <InlineField
            label={t(locale, 'sGhEnabled')}
            tip={t(locale, 'sGhEnabledDesc')}
            control={<Switch checked={gh.enabled} label={t(locale, 'sGhEnabled')} onChange={checked => commit({ enabled: checked })} />}
          />

          <Field
            label={t(locale, 'sGhRepos')}
            tip={t(locale, 'sGhReposDesc')}
            help={pollRepoError || undefined}
            helpTone={pollRepoError ? 'warn' : undefined}
          >
            {gh.repos.length > 0 ? (
              <div className="dsh-dot-gh-chips" data-gh-list="poll">
                {gh.repos.map(repo => {
                  const repoStatus = pollStatus?.repos.find(r => r.repo === repo && r.mode === 'poll')
                  return (
                    <span key={repo} className="dsh-dot-gh-chip" data-failures={repoStatus?.consecutiveFailures ?? 0}>
                      <span className="dsh-dot-gh-chip-name">{repo}</span>
                      <button
                        type="button"
                        className="dsh-dot-gh-chip-remove"
                        aria-label={t(locale, 'sGhRepoRemove').replace('{repo}', repo)}
                        onClick={() => commit({ repos: gh.repos.filter(r => r !== repo) })}
                      >×</button>
                    </span>
                  )
                })}
              </div>
            ) : (
              <div className="dsh-dot-gh-empty">{t(locale, 'sGhReposEmpty')}</div>
            )}
            <div className="dsh-dot-gh-add-row">
              <Input
                aria-label={t(locale, 'sGhRepos')}
                placeholder={t(locale, 'sGhRepoPlaceholder')}
                value={pollRepoDraft}
                onChange={event => { setPollRepoDraft(event.target.value); if (pollRepoError) setPollRepoError('') }}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addPollRepo() } }}
              />
              <Button variant="outline" size="sm" onClick={addPollRepo}>{t(locale, 'sGhRepoAdd')}</Button>
            </div>
          </Field>

        </div>

        <div className="dsh-dot-gh-test-bar">
          <Button variant="outline" size="sm" disabled={testBusy || !api.githubPollTest} onClick={runTest}>
            {testBusy ? t(locale, 'sGhTesting') : t(locale, 'sGhTestBtn')}
          </Button>
        </div>

        {testError ? <div className="dsh-ui-error" role="alert">{testError}</div> : null}
        {testResult ? (
          <div className="dsh-dot-gh-test-result" data-ok={testResult.ok ? '' : undefined} role="status">
            <div className="dsh-dot-gh-test-head">
              {testResult.ok ? <IconCheckOutlineRegular size={14} /> : <IconWarningOutlineRegular size={14} />}
              <strong>{t(locale, testResult.ok ? 'sGhTestOk' : 'sGhTestFail')}</strong>
            </div>
            <div className="dsh-dot-gh-test-lines">
              <div>
                {testResult.ghFound
                  ? t(locale, 'sGhTestCliFound').replace('{path}', testResult.resolvedPath ?? gh.ghPath).replace('{version}', testResult.version ?? '?')
                  : t(locale, 'sGhTestCliMissing')}
              </div>
              {testResult.ghFound ? (
                <div>
                  {testResult.authenticated
                    ? t(locale, 'sGhTestAuthOk').replace('{login}', testResult.login ?? '?').replace('{host}', testResult.host)
                    : t(locale, 'sGhTestAuthFail').replace('{host}', testResult.host)}
                </div>
              ) : null}
              {testResult.rateLimitRemaining !== undefined ? (
                <div>{t(locale, 'sGhRateQuota').replace('{remaining}', String(testResult.rateLimitRemaining)).replace('{limit}', String(testResult.rateLimitLimit ?? '?'))}</div>
              ) : null}
              {testResult.repoChecks?.map(chk => (
                <div key={chk.repo} className="dsh-dot-gh-test-repo" data-ok={chk.ok ? '' : undefined}>
                  <code>{chk.repo}</code>: {chk.ok ? t(locale, 'sGhTestRepoOk') : (chk.error ?? 'error')}
                </div>
              ))}
              {testResult.error ? <div className="dsh-ui-error">{testResult.error}</div> : null}
            </div>
          </div>
        ) : null}
      </div>

      <details className="dsh-dot-gh-details dsh-dot-gh-advanced" data-gh-section="advanced" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
        <summary className="dsh-dot-gh-details-summary">
          <span>{t(locale, 'sGhAdvanced')}</span>
          {advancedCount > 0 ? <span className="dsh-dot-model-group-count">{advancedCount}</span> : null}
        </summary>
        <div className="dsh-dot-gh-details-body">
          <div className="dsh-ui-form">
          <Field label={t(locale, 'sGhStreams')} tip={t(locale, 'sGhStreamsDesc')}>
            <div className="dsh-dot-gh-streams" role="group" aria-label={t(locale, 'sGhStreams')}>
              <Checkbox checked={gh.streams.issues} label={t(locale, 'sGhStreamIssues')} onChange={checked => commit({ streams: { ...gh.streams, issues: checked } })} />
              <Checkbox checked={gh.streams.pulls} label={t(locale, 'sGhStreamPulls')} onChange={checked => commit({ streams: { ...gh.streams, pulls: checked } })} />
              <Checkbox checked={gh.streams.comments} label={t(locale, 'sGhStreamComments')} onChange={checked => commit({ streams: { ...gh.streams, comments: checked } })} />
              <Checkbox checked={gh.streams.ci} label={t(locale, 'sGhStreamCi')} onChange={checked => commit({ streams: { ...gh.streams, ci: checked } })} />
            </div>
          </Field>

          <Field label={t(locale, 'sGhInterval')} tip={t(locale, 'sGhIntervalDesc')}>
            <div className="dsh-dot-idle-check">
              <Input
                className="dsh-dot-idle-input"
                type="number"
                inputMode="numeric"
                min={GITHUB_POLL_MIN_INTERVAL_SEC}
                max={GITHUB_POLL_MAX_INTERVAL_SEC}
                step={1}
                aria-label={t(locale, 'sGhInterval')}
                value={draftInterval}
                onChange={event => setDraftInterval(event.target.value)}
                onBlur={commitInterval}
                onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
              />
              <span className="dsh-ui-meta">{t(locale, 'sGhIntervalUnit')}</span>
            </div>
            <div className="dsh-dot-gh-meta-row">
              <span className="dsh-ui-meta">{t(locale, 'sGhEffectiveInterval').replace('{sec}', String(pollStatus?.effectiveIntervalSec ?? gh.intervalSec))}</span>
              {pollStatus?.xPollIntervalSec !== undefined ? (
                <span className="dsh-ui-meta">{t(locale, 'sGhXPollInterval').replace('{sec}', String(pollStatus.xPollIntervalSec))}</span>
              ) : null}
              {pollStatus?.hourlyRequests !== undefined ? (
                <span className="dsh-ui-meta">{t(locale, 'sGhHourlyEstimate').replace('{n}', String(pollStatus.hourlyRequests))}</span>
              ) : null}
              {pollStatus?.rateLimitRemaining !== undefined ? (
                <span className="dsh-ui-meta">{t(locale, 'sGhRateQuota').replace('{remaining}', String(pollStatus.rateLimitRemaining)).replace('{limit}', String(pollStatus.rateLimitLimit ?? '?'))}</span>
              ) : null}
            </div>
          </Field>

          <Field label={t(locale, 'sGhGhPath')} tip={t(locale, 'sGhGhPathDesc')}>
            <Input
              aria-label={t(locale, 'sGhGhPath')}
              value={draftGhPath}
              onChange={event => setDraftGhPath(event.target.value)}
              onBlur={commitGhPath}
              onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
            />
          </Field>

          <Field label={t(locale, 'sGhHostname')} tip={t(locale, 'sGhHostnameDesc')}>
            <Input
              aria-label={t(locale, 'sGhHostname')}
              placeholder={t(locale, 'sGhHostnamePlaceholder')}
              value={draftHostname}
              onChange={event => setDraftHostname(event.target.value)}
              onBlur={commitHostname}
              onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
            />
          </Field>

          <Field label={t(locale, 'sGhIgnoredActors')} tip={t(locale, 'sGhIgnoredActorsDesc')}>
            <Input
              aria-label={t(locale, 'sGhIgnoredActors')}
              placeholder={t(locale, 'sGhIgnoredActorsPlaceholder')}
              value={draftActors}
              onChange={event => setDraftActors(event.target.value)}
              onBlur={commitActors}
              onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
            />
          </Field>
          </div>
          <div className="dsh-dot-gh-subhead">{t(locale, 'sGhAdvAdmissionTitle')}</div>
          <div data-gh-section="admission">
          <p className="dsh-dot-gh-desc">{t(locale, 'sGhAdmissionDefaults')}</p>
          {rules.length > 0 ? (
            <div className="dsh-dot-gh-rules">
              {rules.map((rule, index) => (
                <div key={`${rule.repo}:${rule.eventType}:${rule.senderClass}`} className="dsh-dot-gh-rule-row">
                  <code className="dsh-dot-gh-rule-repo">{rule.repo}</code>
                  <span className="dsh-dot-gh-rule-meta">{t(locale, `sGhEvent_${rule.eventType}` as TextKey)}</span>
                  <span className="dsh-dot-gh-rule-meta">{t(locale, `sSender_${rule.senderClass}` as TextKey)}</span>
                  <select
                    className="dsh-ui-select dsh-dot-gh-rule-select"
                    aria-label={`${rule.repo} ${rule.eventType} ${rule.senderClass}`}
                    value={rule.action}
                    onChange={event => {
                      const nextAction = event.target.value as GithubAdmissionAction
                      commit({ admission: rules.map((r, i) => (i === index ? { ...r, action: nextAction } : r)) })
                    }}
                  >
                    {GITHUB_ADMISSION_ACTIONS.map(action => (
                      <option key={action} value={action}>{t(locale, `sAction_${action}` as TextKey)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="dsh-dot-gh-chip-remove"
                    aria-label={t(locale, 'sGhAdmissionRemove')}
                    onClick={() => commit({ admission: rules.filter((_, i) => i !== index) })}
                  >×</button>
                </div>
              ))}
            </div>
          ) : (
            <div className="dsh-dot-gh-empty">{t(locale, 'sGhAdmissionEmpty')}</div>
          )}
          <div className="dsh-dot-gh-rule-form">
            <Input
              aria-label={t(locale, 'sGhAdmissionRepo')}
              placeholder="*"
              value={admRepo}
              onChange={event => { setAdmRepo(event.target.value); if (admError) setAdmError('') }}
            />
            <select
              className="dsh-ui-select"
              aria-label={t(locale, 'sGhAdmissionEvent')}
              value={admEvent}
              onChange={event => setAdmEvent(event.target.value as GithubEventType)}
            >
              {GITHUB_EVENT_TYPES.map(ev => <option key={ev} value={ev}>{t(locale, `sGhEvent_${ev}` as TextKey)}</option>)}
            </select>
            <select
              className="dsh-ui-select"
              aria-label={t(locale, 'sGhAdmissionSender')}
              value={admSender}
              onChange={event => setAdmSender(event.target.value as GithubSenderClass)}
            >
              {GITHUB_SENDER_CLASSES.map(sc => <option key={sc} value={sc}>{t(locale, `sSender_${sc}` as TextKey)}</option>)}
            </select>
            <select
              className="dsh-ui-select"
              aria-label={t(locale, 'sGhAdmissionAction')}
              value={admAction}
              onChange={event => setAdmAction(event.target.value as GithubAdmissionAction)}
            >
              {GITHUB_ADMISSION_ACTIONS.map(act => <option key={act} value={act}>{t(locale, `sAction_${act}` as TextKey)}</option>)}
            </select>
            <Button variant="outline" size="sm" onClick={addAdmissionRule}>{t(locale, 'sGhAdmissionAdd')}</Button>
          </div>
          {admError ? <span className="dsh-ui-help dsh-ui-warn">{admError}</span> : null}
          </div>
          <div className="dsh-dot-gh-subhead">{t(locale, 'sGhAdvWebhookTitle')}</div>
          <div data-gh-section="webhook">
          <p className="dsh-dot-gh-desc">{t(locale, 'sGhWebhookDesc')}</p>
          <div className="dsh-ui-form">
            <Field
              label={t(locale, 'sGhWebhookRepos')}
              help={webhookRepoError || undefined}
              helpTone={webhookRepoError ? 'warn' : undefined}
            >
              {gh.webhookRepos.length > 0 ? (
                <div className="dsh-dot-gh-chips" data-gh-list="webhook">
                  {gh.webhookRepos.map(repo => (
                    <span key={repo} className="dsh-dot-gh-chip">
                      <span className="dsh-dot-gh-chip-name">{repo}</span>
                      <button
                        type="button"
                        className="dsh-dot-gh-chip-remove"
                        aria-label={t(locale, 'sGhRepoRemove').replace('{repo}', repo)}
                        onClick={() => commit({ webhookRepos: gh.webhookRepos.filter(r => r !== repo) })}
                      >×</button>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="dsh-dot-gh-empty">{t(locale, 'sGhWebhookReposEmpty')}</div>
              )}
              <div className="dsh-dot-gh-add-row">
                <Input
                  aria-label={t(locale, 'sGhWebhookRepos')}
                  placeholder={t(locale, 'sGhRepoPlaceholder')}
                  value={webhookRepoDraft}
                  onChange={event => { setWebhookRepoDraft(event.target.value); if (webhookRepoError) setWebhookRepoError('') }}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addWebhookRepo() } }}
                />
                <Button variant="outline" size="sm" onClick={addWebhookRepo}>{t(locale, 'sGhRepoAdd')}</Button>
              </div>
            </Field>
            <Field label={t(locale, 'sGhSourceId')} tip={t(locale, 'sGhSourceIdDesc')}>
              <Input
                aria-label={t(locale, 'sGhSourceId')}
                value={draftSourceId}
                onChange={event => setDraftSourceId(event.target.value)}
                onBlur={commitSourceId}
                onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
              />
            </Field>
          </div>
          </div>
        </div>
      </details>
    </>
  )
}

const LOCK_SETTING_FIELDS: readonly SettingField[] = [
  'model', 'reflection', 'scope', 'approvals', 'questions', 'taskPermission', 'taskModels', 'idleCheckMinutes',
  'capabilities', 'address', 'persona', 'agreements', 'defaultTaskPreset', 'watchdogMode', 'watchdogModel',
]

export function SettingsPanel({ locale, api, settings, section = 'all', proposals, onSaved, onStatusChange, onProposalCount, renderFactorySlot }: {
  locale: CopyLocale
  api: SettingsApi
  settings?: DotSettings
  section?: SettingsSection | 'all'
  proposals?: ProposalsState
  onSaved: (next: DotSettings) => void
  onStatusChange?: (status: SaveNotice | undefined) => void
  onProposalCount?: (count: number) => void
  renderFactorySlot?: RenderFactorySlot
}) {
  const models = useModels(api)
  const [status, setStatus] = useState<SaveNotice>()
  const [modelFilter, setModelFilter] = useState('')
  const [keepalive, setKeepalive] = useState<KeepaliveInfo>()
  const [keepaliveRefresh, setKeepaliveRefresh] = useState(0)
  const [livePermissions, setLivePermissions] = useState<TaskPermission[]>(['workspace-write', 'danger-full-access'])
  const manualOpen = useRef<Record<string, boolean | undefined>>({})
  const manualAuto = useRef<Record<string, boolean | undefined>>({})
  const [, bumpDetails] = useState(0)
  const show = (target: SettingsSection) => section === 'all' || section === target
  const reloadSettings = useCallback(() => {
    api.settings(new AbortController().signal).then(onSaved, () => {})
  }, [api, onSaved])
  const ownProposals = useSettingProposals(api, proposals === undefined && show('proposals'), reloadSettings, onProposalCount)
  const proposalState = proposals ?? ownProposals
  const hasSettings = settings !== undefined
  const modelKey = settings?.model ? `${settings.model.provider}/${settings.model.model}` : ''
  const cacheTtlSig = JSON.stringify(settings?.cacheTtl ?? null)
  useEffect(() => {
    if (!api.keepalive || !hasSettings) return
    const life = new AbortController()
    api.keepalive(life.signal).then(
      info => { if (!life.signal.aborted) setKeepalive(info) },
      () => { if (!life.signal.aborted) setKeepalive(undefined) },
    )
    return () => { life.abort() }
  }, [api, keepaliveRefresh, hasSettings, modelKey, cacheTtlSig, proposalState.revision])
  useEffect(() => {
    if (!api.taskPermissionOptions) return
    if (section !== 'all' && section !== 'dispatch') return
    const life = new AbortController()
    api.taskPermissionOptions(life.signal).then(
      value => { if (!life.signal.aborted && Array.isArray(value?.options)) setLivePermissions(value.options) },
      () => {},
    )
    return () => { life.abort() }
  }, [api, section])
  const reportStatus = useCallback((next: SaveNotice | undefined) => {
    setStatus(next)
    onStatusChange?.(next)
  }, [onStatusChange])
  const save = useCallback((patch: SettingsPatch) => {
    reportStatus(undefined)
    api.setSettings(patch).then(
      next => { onSaved(next); reportStatus({ kind: 'saved' }); if ('model' in patch || 'cacheTtl' in patch) setKeepaliveRefresh(value => value + 1) },
      failure => reportStatus({ kind: 'error', message: failure instanceof Error ? failure.message : String(failure) }),
    )
  }, [api, onSaved, reportStatus])

  if (!settings) return <PaneSkeleton label={t(locale, 'settingsLoading')} />

  const chosen = settings.model
  const choices = [...models.choices ?? []]
  if (chosen && !choices.some(choice => choice.provider === chosen.provider && choice.model === chosen.model)) {
    choices.push({ provider: chosen.provider, model: chosen.model, label: `${chosen.provider} / ${chosen.model}`, efforts: [] })
  }
  const watchdogChosen = parseWatchdogModelChoice(settings.watchdogModel)
  const watchdogChoices = [...models.choices ?? []]
  if (watchdogChosen && !watchdogChoices.some(choice => choice.provider === watchdogChosen.provider && choice.model === watchdogChosen.model)) {
    watchdogChoices.push({ provider: watchdogChosen.provider, model: watchdogChosen.model, label: `${watchdogChosen.provider} / ${watchdogChosen.model}`, efforts: [] })
  }
  const watchdogModes: readonly [WatchdogMode, WatchdogMode, WatchdogMode] = WATCHDOG_MODES
  const approvalModes: readonly [ApprovalMode, ApprovalMode, ApprovalMode] = ['dot', 'human', 'deny']
  const questionModes: readonly [TakeoverMode, TakeoverMode, TakeoverMode] = ['dot', 'human', 'off']
  const permissionModes: readonly [TaskPermission, ...TaskPermission[]] = (livePermissions.includes(settings.taskPermission)
    ? livePermissions
    : [...livePermissions, settings.taskPermission]) as [TaskPermission, ...TaskPermission[]]

  // Models dot may start tasks on: provider-grouped catalog choices, followed by listed entries the catalog no longer has.
  const rule = settings.taskModels
  const catalogChoices = models.choices ?? []
  const catalogKeys = new Set((models.choices ?? []).map(taskModelKey))
  const filteredGroups = groupModelMenuChoices(catalogChoices, modelFilter)
  const needle = modelFilter.trim().toLowerCase()
  const staleKeys = rule.list.filter(key => !catalogKeys.has(key) && (!needle || key.toLowerCase().includes(needle)))
  const toggleTaskModel = (key: string, checked: boolean) => {
    const list = checked ? [...rule.list.filter(item => item !== key), key] : rule.list.filter(item => item !== key)
    save({ taskModels: { mode: rule.mode, list } })
  }
  const toggleTaskGroup = (keys: readonly string[], checked: boolean) => {
    const drop = new Set(keys)
    const list = checked ? [...rule.list, ...keys.filter(key => !rule.list.includes(key))] : rule.list.filter(key => !drop.has(key))
    save({ taskModels: { mode: rule.mode, list } })
  }
  /**
   * Details expansion: automatic answer (searched or has selections) unless the
   * user folded or unfolded the group by hand; that manual answer is forgotten
   * when the automatic answer changes, so the list never sticks open or closed.
   */
  const expandDetails = (id: string, auto: boolean): boolean => {
    if (needle !== '') return auto
    const picked = manualOpen.current[id]
    if (picked === undefined) return auto
    if (manualAuto.current[id] !== auto) {
      delete manualOpen.current[id]
      delete manualAuto.current[id]
      return auto
    }
    return picked
  }
  const onDetailsClick = (id: string, auto: boolean) => (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as { closest?: (selector: string) => unknown } | null
    if (target && typeof target.closest === 'function' && target.closest('button, a, input, textarea, [role="tab"]')) return
    const details = event.currentTarget.parentElement
    if (!details || details.tagName !== 'DETAILS') return
    manualOpen.current[id] = !(details as HTMLDetailsElement).open
    manualAuto.current[id] = auto
    bumpDetails(rev => rev + 1)
  }
  const emptyAllowList = rule.mode === 'allow' && rule.list.length === 0
  const modelHelp = models.failed ? t(locale, 'sModelFailed')
    : models.choices ? undefined
    : t(locale, 'sModelLoading')
  const taskModelsHelp = rule.mode !== 'all' && models.failed ? t(locale, 'sModelFailed')
    : emptyAllowList ? t(locale, 'sTaskModelsEmpty')
    : undefined
  const approvalHelp = settings.approvals === 'dot' ? t(locale, 'sApprovalsDesc_dot')
    : settings.approvals === 'human' ? t(locale, 'sApprovalsDesc_human')
    : t(locale, 'sApprovalsDesc_deny')
  const allSections = section === 'all'
  const cacheKey = keepalive ? `${keepalive.provider}/${keepalive.model}` : ''
  const saveCapabilityGrant = (selector: string, grant: CapabilityGrant | undefined) => {
    const grants = { ...settings.capabilities?.grants }
    if (grant === undefined) delete grants[selector]
    else grants[selector] = grant
    save({ capabilities: { grants } })
  }

  return (
    <LocaleContext.Provider value={locale}><div className="dsh-dot-pane dsh-dot-settings-pane">
      {!onStatusChange && status?.kind === 'saved' ? <div className="dsh-ui-notice" role="status">{t(locale, 'saved')}</div> : null}
      {!onStatusChange && status?.kind === 'error' ? <div className="dsh-ui-error" role="alert">{t(locale, 'saveFailed')}{status.message}</div> : null}
      {show('proposals') ? <Proposals locale={locale} choices={choices} state={proposalState} showTitle={allSections} /> : null}

      {show('general') ? (
        <>
          <div className="dsh-dot-pane-section">
            <div className="dsh-ui-form">
              <Field label={t(locale, 'sModel')} help={modelHelp} helpTone={models.failed ? 'warn' : undefined}>
                <ModelPickerInput
                  locale={locale}
                  renderFactorySlot={renderFactorySlot}
                  choices={choices}
                  selected={chosen ? { provider: chosen.provider, model: chosen.model } : undefined}
                  onPick={picked => save({ model: { provider: picked.provider, model: picked.model } })}
                  onClear={() => save({ model: null })}
                  followLabel={t(locale, 'sModelFollow')}
                  label={t(locale, 'sModel')}
                />
              </Field>
            </div>
          </div>
          <div className="dsh-dot-pane-section">
            <div className="dsh-ui-form">
              <InlineField
                label={t(locale, 'sReflection')}
                tip={t(locale, 'sReflectionDesc')}
                control={<Switch checked={settings.reflection} label={t(locale, 'sReflection')} onChange={next => save({ reflection: next })} />}
              />
              <DesktopNotifyField locale={locale} />
              <InlineField
                label={t(locale, 'sAutoUpdate')}
                tip={t(locale, 'sAutoUpdateDesc')}
                control={<Switch checked={settings.autoUpdate} label={t(locale, 'sAutoUpdate')} onChange={next => save({ autoUpdate: next })} />}
                below={api.updateStatus ? <AutoUpdateLine locale={locale} api={api} /> : null}
              />
            </div>
          </div>
        </>
      ) : null}

      {show('takeover') ? (
        <div className="dsh-dot-pane-section">
          <div className="dsh-ui-form">
            <Field label={t(locale, 'sScope')} tip={t(locale, 'sScopeDesc')}>
              <SegmentedChoice locale={locale} label={t(locale, 'sScope')} value={settings.scope} options={['all', 'tracked']} labelKeyOf={opt => `sScope_${opt}`} onChange={next => save({ scope: next })} />
            </Field>
            <Field label={t(locale, 'sApprovals')} tip={approvalHelp}>
              <SegmentedChoice locale={locale} label={t(locale, 'sApprovals')} value={settings.approvals} options={approvalModes} labelKeyOf={opt => `sApprovals_${opt}`} onChange={next => save({ approvals: next })} />
            </Field>
            <Field label={t(locale, 'sQuestions')} tip={t(locale, `sQuestionsDesc_${settings.questions}` as TextKey)}>
              <SegmentedChoice locale={locale} label={t(locale, 'sQuestions')} value={settings.questions} options={questionModes} labelKeyOf={opt => `sQuestions_${opt}`} onChange={next => save({ questions: next })} />
            </Field>
          </div>
        </div>
      ) : null}

      {show('dispatch') ? (
        <div className="dsh-dot-pane-section dsh-dot-dispatch">
          <div className="dsh-ui-form dsh-dot-dispatch-stack">
            <Field
              label={t(locale, 'sTaskPermission')}
              tip={t(locale, `sTaskPermissionDesc_${settings.taskPermission}` as TextKey)}
              help={livePermissions.includes(settings.taskPermission) ? undefined : t(locale, 'sTaskPermissionUnavailable').replace('{name}', t(locale, `sTaskPermission_${settings.taskPermission}` as TextKey))}
              helpTone={livePermissions.includes(settings.taskPermission) ? undefined : 'warn'}
            >
              <SegmentedChoice locale={locale} label={t(locale, 'sTaskPermission')} value={settings.taskPermission} options={permissionModes} labelKeyOf={opt => `sTaskPermission_${opt}`} onChange={next => save({ taskPermission: next })} />
            </Field>
            <Field label={t(locale, 'sTaskModels')} help={taskModelsHelp} helpTone={taskModelsHelp ? 'warn' : undefined}>
              <SegmentedChoice locale={locale} label={t(locale, 'sTaskModels')} value={rule.mode} options={['all', 'allow', 'deny']} labelKeyOf={opt => `sTaskModels_${opt}`} onChange={next => save({ taskModels: { mode: next, list: rule.list } })} />
              {rule.mode === 'all' ? null : (
                <div className="dsh-dot-model-picker" role="group" aria-label={t(locale, `sTaskModels_${rule.mode}`)}>
                  <div className="dsh-dot-model-toolbar">
                    <Input
                      className="dsh-dot-model-search"
                      icon={<IconSearchOutlineRegular size={13} />}
                      type="search"
                      aria-label={t(locale, 'sTaskModelsFilter')}
                      placeholder={t(locale, 'sTaskModelsFilter')}
                      value={modelFilter}
                      onChange={event => setModelFilter(event.target.value)}
                    />
                    <div className="dsh-dot-model-summary">
                      <span className="dsh-ui-meta">{t(locale, 'sTaskModelsSelected').replace('{n}', String(rule.list.length))}</span>
                      {rule.list.length > 0 ? (
                        <Button variant="ghost" size="sm" onClick={() => save({ taskModels: { mode: rule.mode, list: [] } })}>{t(locale, 'sTaskModelsClear')}</Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="dsh-dot-model-list">
                    {filteredGroups.length === 0 && staleKeys.length === 0 ? (
                      <div className="dsh-dot-model-empty">{catalogChoices.length === 0 && !models.failed ? t(locale, 'sModelLoading') : t(locale, 'sTaskModelsNoMatch')}</div>
                    ) : null}
                    {filteredGroups.map(group => {
                      const keys = group.items.map(taskModelKey)
                      const selected = keys.filter(key => rule.list.includes(key))
                      const auto = needle !== '' || selected.length > 0
                      return (
                        <details className="dsh-dot-model-group" key={group.provider} open={expandDetails(group.provider, auto)}>
                          <summary className="dsh-dot-model-group-title" onClick={onDetailsClick(group.provider, auto)}>
                            <span className="dsh-dot-model-group-label"><span className="dsh-dot-model-group-name" title={group.name}>{group.name}</span><span className="dsh-dot-model-group-count">{selected.length}/{keys.length}</span></span>
                            <button type="button" className="dsh-dot-model-group-toggle" onClick={event => { event.preventDefault(); event.stopPropagation(); toggleTaskGroup(keys, selected.length !== keys.length) }} onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>{t(locale, selected.length === keys.length ? 'sTaskModelsGroupNone' : 'sTaskModelsGroupAll')}</button>
                          </summary>
                          {group.items.map(choice => {
                            const key = taskModelKey(choice)
                            const on = rule.list.includes(key)
                            return (
                              <Checkbox
                                key={key}
                                className={on ? 'dsh-dot-model-item dsh-dot-model-item--on' : 'dsh-dot-model-item'}
                                checked={on}
                                label={modelMenuShortName(choice)}
                                title={choice.label}
                                onChange={checked => toggleTaskModel(key, checked)}
                              />
                            )
                          })}
                        </details>
                      )
                    })}
                    {staleKeys.length > 0 ? (
                      <div className="dsh-dot-model-group">
                        <div className="dsh-dot-model-group-title">{t(locale, 'sTaskModelsStaleGroup')}</div>
                        {staleKeys.map(key => (
                          <Checkbox
                            key={key}
                            className="dsh-dot-model-item dsh-dot-model-item--on"
                            checked={rule.list.includes(key)}
                            label={`${key} ${t(locale, 'sTaskModelsGone')}`}
                            onChange={checked => toggleTaskModel(key, checked)}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
            </Field>
            <InlineField
              label={t(locale, 'sIdleCheck')}
              tip={t(locale, 'sIdleCheckDesc')}
              control={<IdleCheckInput locale={locale} value={settings.idleCheckMinutes} onCommit={minutes => save({ idleCheckMinutes: minutes })} />}
            />
          </div>
        </div>
      ) : null}

      {show('github') ? (
        <GithubSettingsSection
          locale={locale}
          api={api}
          settings={settings}
          onSave={next => save({ githubPoll: next })}
        />
      ) : null}

      {show('capabilities') ? (
        <CapabilitiesMcpPanel locale={locale} api={api} settings={settings} onSaved={onSaved} onPick={saveCapabilityGrant} />
      ) : null}

      {show('advanced') ? (
        <>
          <div className="dsh-dot-pane-section">
            <div className="dsh-ui-form">
              {keepalive ? (
                <InlineField
                  label={t(locale, 'sCacheTtl')}
                  tip={t(locale, 'sCacheTtlDesc').replace('{key}', cacheKey).replace('{n}', String(keepalive.defaultMinutes))}
                  control={<IdleCheckInput
                    locale={locale}
                    label={t(locale, 'sCacheTtl')}
                    unit={t(locale, 'sCacheTtlUnit')}
                    value={settings.cacheTtl?.[cacheKey] ?? keepalive.minutes}
                    onCommit={minutes => {
                      const next = { ...settings.cacheTtl }
                      const aliased = Object.keys(next).some(key => key !== cacheKey && cacheTtlModelOf(key) === keepalive.model)
                      if (minutes !== keepalive.defaultMinutes || aliased) next[cacheKey] = minutes
                      else delete next[cacheKey]
                      save({ cacheTtl: next })
                    }}
                  />}
                />
              ) : null}
              <Field label={t(locale, 'sDefaultTaskPreset')} tip={t(locale, 'sDefaultTaskPresetDesc')}>
                <SegmentedChoice locale={locale} label={t(locale, 'sDefaultTaskPreset')} value={settings.defaultTaskPreset ?? 'standard'} options={TASK_PRESET_OPTIONS} labelKeyOf={opt => `sDefaultTaskPreset_${opt}`} onChange={next => save({ defaultTaskPreset: next })} />
              </Field>
              <Field label={t(locale, 'sWatchdogMode')} tip={t(locale, 'sWatchdogModeDesc')}>
                <SegmentedChoice
                  locale={locale}
                  label={t(locale, 'sWatchdogMode')}
                  value={settings.watchdogMode ?? 'observe'}
                  options={watchdogModes}
                  labelKeyOf={opt => `sWatchdogMode_${opt}`}
                  onChange={next => save({ watchdogMode: next })}
                />
              </Field>
              {(settings.watchdogMode ?? 'observe') === 'auto' || Boolean(settings.watchdogModel) ? (
                <Field label={t(locale, 'sWatchdogModel')} tip={t(locale, 'sWatchdogModelDesc')} help={modelHelp} helpTone={models.failed ? 'warn' : undefined}>
                  <ModelPickerInput
                    locale={locale}
                    renderFactorySlot={renderFactorySlot}
                    choices={watchdogChoices}
                    selected={watchdogChosen ? { provider: watchdogChosen.provider, model: watchdogChosen.model } : undefined}
                    onPick={picked => save({ watchdogModel: `${picked.provider}/${picked.model}` })}
                    onClear={() => save({ watchdogModel: null })}
                    followLabel={t(locale, 'sWatchdogModelFollow')}
                    label={t(locale, 'sWatchdogModel')}
                  />
                </Field>
              ) : null}
            </div>
          </div>
          <div className="dsh-dot-pane-section">
            <div className="dsh-ui-form">
              <Field label={t(locale, 'sLocks')} tip={t(locale, 'sLocksDesc')}>
                <div className="dsh-dot-lock-grid">
                  {LOCK_SETTING_FIELDS.map(field => {
                    const label = t(locale, `field_${field}` as TextKey)
                    return (
                      <Checkbox
                        key={field}
                        className="dsh-dot-lock-check"
                        checked={settings.locks?.[field] === true}
                        label={label}
                        onChange={checked => save({ locks: { ...settings.locks, [field]: checked } })}
                      />
                    )
                  })}
                </div>
              </Field>
            </div>
          </div>
          {api.previewFactoryReset && api.confirmFactoryReset ? <FactoryResetField locale={locale} api={api} onSaved={onSaved} /> : null}
        </>
      ) : null}
    </div></LocaleContext.Provider>
  )
}

// Selectors spell the root out (.dsh-dot-chat = CHAT_ROOT) so the repository scope check can read them.
export const settingsCss = `
.dsh-dot-chat .dsh-dot-settings-pane .dsh-ui-form { display: flex; flex-direction: column; }
.dsh-dot-chat .dsh-dot-settings-pane .dsh-ui-form > .dsh-ui-field { min-width: 0; }
.dsh-dot-chat .dsh-dot-setting-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 22px; }
.dsh-dot-chat .dsh-dot-setting-tools { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-help-tip {
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 18px; height: 18px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer;
  transition: background-color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out), color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out);
}
.dsh-dot-chat .dsh-dot-help-tip:hover,
.dsh-dot-chat .dsh-dot-help-tip:focus-visible { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-inline-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; }
.dsh-dot-chat .dsh-dot-inline-label { flex: 1 1 auto; min-width: 0; }
.dsh-dot-chat .dsh-dot-inline-control { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; }
/* Settings segmented controls: release the primitive's fixed 30px height so a
   long label can wrap to at most two lines (clamped), keeping grid-equal row
   heights; the sliding indicator still stretches to the taller track. */
.dsh-dot-chat .dsh-dot-settings-pane [role='tablist'][data-size='sm'] [role='tab'] {
  height: auto; min-height: 30px; padding-top: 4px; padding-bottom: 4px; line-height: 16px; white-space: normal;
}
.dsh-dot-chat .dsh-dot-seg-label {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  overflow-wrap: break-word; text-align: center;
}
.dsh-dot-chat .dsh-dot-danger { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-foreground); }
.dsh-dot-chat .dsh-dot-danger:hover:not(:disabled) { background: var(--dsw-alias-state-error-primary); filter: brightness(0.9); }
.dsh-dot-chat .dsh-dot-proposals { display: flex; flex-direction: column; gap: 10px; }
.dsh-dot-chat .dsh-dot-proposal {
  display: flex; flex-direction: column; gap: 8px; padding: 12px 14px;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke);
}
.dsh-dot-chat .dsh-dot-proposal-head { display: flex; align-items: center; gap: 6px; font-size: 13px; line-height: 20px; }
.dsh-dot-chat .dsh-dot-proposal-reason { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-proposal-inline { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12px; line-height: 18px; }
.dsh-dot-chat .dsh-dot-proposal-chip { padding: 2px 8px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-proposal-chip--next { color: var(--dsw-alias-label-primary); font-weight: 500; border: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-dot-chat .dsh-dot-proposal-arrow { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-dot-chat .dsh-dot-proposal-blocks { display: grid; gap: 8px; }
@container (min-width: 560px) {
  .dsh-dot-chat .dsh-dot-proposal-blocks { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
}
.dsh-dot-chat .dsh-dot-proposal-blocks > div { display: flex; flex-direction: column; gap: 4px; }
.dsh-dot-chat .dsh-dot-proposal-blocks > div > span { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-proposal-blocks pre {
  margin: 0; max-height: 160px; overflow: auto; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere;
  background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-radius-sm); font: 12px/18px var(--ds-font-family-code); color: var(--dsw-alias-label-primary);
}
.dsh-dot-chat .dsh-dot-dispatch { min-width: 0; }
.dsh-dot-chat .dsh-dot-dispatch-stack { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dsh-dot-chat .dsh-dot-model-picker {
  display: flex; flex-direction: column; gap: 10px; min-width: 0; margin-top: 10px;
}
.dsh-dot-chat .dsh-dot-model-toolbar { display: flex; flex-direction: column; align-items: stretch; gap: 8px; min-width: 0; }
.dsh-dot-chat .dsh-dot-model-summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; min-height: 24px; }
.dsh-dot-chat .dsh-dot-model-summary > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-model-summary .dsh-ui-meta { font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-model-search { display: flex; width: 100%; min-width: 0; height: 32px; box-sizing: border-box; }
/* The settings scroller is the only vertical scroll. Capping the list or the tokens adds a nested scrollbar. */
.dsh-dot-chat .dsh-dot-model-list { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dsh-dot-chat .dsh-dot-model-group {
  display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 2px 0;
}
.dsh-dot-chat .dsh-dot-model-group > summary {
  display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 28px; padding: 2px 4px 2px 2px;
  list-style: none; cursor: pointer; border-radius: var(--dsw-radius-sm);
}
.dsh-dot-chat .dsh-dot-model-group > summary::-webkit-details-marker { display: none; }
.dsh-dot-chat .dsh-dot-model-group > summary:hover:not(:has(.dsh-dot-model-group-toggle:hover)) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-chat .dsh-dot-model-group > summary:focus-visible { outline: 1.5px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.dsh-dot-chat .dsh-dot-model-group > summary::before {
  content: '›'; display: inline-block; flex-shrink: 0; width: 12px; text-align: center;
  transition: transform var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease); color: var(--dsw-alias-label-tertiary);
}
.dsh-dot-chat .dsh-dot-model-group[open] > summary::before { transform: rotate(90deg); }
.dsh-dot-chat .dsh-dot-model-group-label { display: inline-flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; }
.dsh-dot-chat .dsh-dot-model-group-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-model-group-count {
  flex-shrink: 0; padding: 0 6px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2);
  font-weight: 500; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary);
}
.dsh-dot-chat .dsh-dot-model-group-toggle {
  flex-shrink: 0; margin-left: auto; padding: 2px 8px; border: 0; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-model-group-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-model-group-toggle:focus-visible { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); outline: 1.5px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.dsh-dot-chat .dsh-dot-model-empty { padding: 12px 8px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-model-picker .dsh-dot-model-empty {
  padding: 18px 12px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); line-height: 18px;
}
.dsh-dot-chat .dsh-dot-model-group-title { padding: 4px 6px 2px; font-size: 12px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-model-item {
  display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; box-sizing: border-box;
  min-height: 30px; padding: 4px 8px; border-radius: var(--dsw-radius-sm); font-size: 13px; line-height: 20px; cursor: pointer;
}
.dsh-dot-chat .dsh-dot-model-item > span { min-width: 0; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-model-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-chat .dsh-dot-model-item--on { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent); }
.dsh-dot-chat .dsh-dot-model-item--on:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, var(--dsw-alias-interactive-bg-hover)); }
@media (prefers-reduced-motion: reduce) {
  .dsh-dot-chat .dsh-dot-model-group > summary::before { transition: none; }
}
.dsh-dot-chat .dsh-dot-idle-check { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-update { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
.dsh-dot-chat .dsh-dot-update-meta { flex: 1 1 160px; min-width: 0; }
.dsh-dot-chat .dsh-dot-idle-input { width: 72px; flex: 0 0 auto; }
.dsh-dot-chat .dsh-dot-keepalive-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; padding-top: 8px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.dsh-dot-chat .dsh-dot-keepalive-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.dsh-dot-chat .dsh-dot-factory { display: flex; flex-direction: column; gap: 10px; }
/* The factory-reset card reads as a danger zone: quiet until opened, then the
   destructive confirm keeps its red fill while everything else stays muted. */
.dsh-dot-chat .dsh-dot-factory .dsh-ui-label { color: var(--dsw-alias-state-error-primary); }
.dsh-dot-chat .dsh-dot-factory-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; }
.dsh-dot-chat .dsh-dot-factory-preview { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; padding: 10px 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke); }
.dsh-dot-chat .dsh-dot-factory-preview ul { margin: 0; padding-left: 18px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-caps { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.dsh-dot-chat .dsh-dot-cap-intro { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-cap-search { height: 28px; }
.dsh-dot-chat .dsh-dot-cap-group { border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke); }
.dsh-dot-chat .dsh-dot-cap-group > summary { list-style: none; }
.dsh-dot-chat .dsh-dot-cap-group > summary::-webkit-details-marker { display: none; }
.dsh-dot-chat .dsh-dot-cap-toolbar { display: flex; align-items: center; gap: 12px; }
.dsh-dot-chat .dsh-dot-cap-toolbar .dsh-dot-cap-search { flex: 1 1 auto; }
.dsh-dot-chat .dsh-dot-cap-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; padding: 8px 12px; cursor: pointer; }
.dsh-dot-chat .dsh-dot-cap-group--locked .dsh-dot-cap-head { cursor: pointer; }
.dsh-dot-chat .dsh-dot-cap-chev { flex-shrink: 0; color: var(--dsw-alias-label-tertiary); transition: transform 0.12s ease; }
.dsh-dot-chat .dsh-dot-cap-group[open] > summary .dsh-dot-cap-chev { transform: rotate(90deg); }
.dsh-dot-chat .dsh-dot-cap-name { flex: 1 1 120px; min-width: 120px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-cap-group[data-grant='off'] > summary .dsh-dot-cap-name { color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-cap-section { margin: 10px 4px 2px; font-size: 11px; line-height: 16px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-cap-section-wrap { display: flex; flex-direction: column; gap: 8px; }
.dsh-dot-chat .dsh-dot-cap-mcplink { align-self: flex-start; margin: 0 4px; padding: 0; border: none; background: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-accent-primary, var(--dsw-alias-label-tertiary)); cursor: pointer; }
.dsh-dot-chat .dsh-dot-cap-tag { margin-left: 6px; padding: 0 5px; border-radius: var(--dsw-radius-sm); font-size: 10px; line-height: 14px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-cap-tag--dot { color: var(--dsw-alias-state-success-primary); }
.dsh-dot-chat .dsh-dot-cap-count { margin-left: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-cap-control { flex: 0 0 auto; margin-left: auto; }
.dsh-dot-chat .dsh-dot-cap-body { display: flex; flex-direction: column; gap: 2px; padding: 0 12px 10px; }
.dsh-dot-chat .dsh-dot-cap-body .dsh-dot-cap-group { box-shadow: none; background: var(--dsw-alias-bg-layer-2); }
.dsh-dot-chat .dsh-dot-cap-row { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 4px 8px; padding: 4px 0 4px 8px; }
.dsh-dot-chat .dsh-dot-cap-tool { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; overflow: visible; text-overflow: clip; white-space: normal; }
.dsh-dot-chat .dsh-dot-cap-tool code { font-family: var(--ds-font-family-code); font-size: 12px; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-cap-desc { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-cap-grant { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-cap-grant[data-inherited] [role='tablist'] { opacity: 0.55; }
.dsh-dot-chat .dsh-dot-cap-badge {
  flex-shrink: 0; padding: 1px 6px; border-radius: var(--dsw-radius-sm); font-size: 11px; line-height: 16px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary);
}
.dsh-dot-chat .dsh-dot-cap-badge--on { color: var(--dsw-alias-state-success-primary); }
.dsh-dot-chat .dsh-dot-cap-badge--warn { color: var(--dsw-alias-state-warn-primary); }
.dsh-dot-chat .dsh-dot-cap-clear { flex-shrink: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.dsh-dot-chat .dsh-dot-cap-clear:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-cap-clear-slot { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-cap-clear-slot .dsh-dot-cap-clear { padding: 2px 4px; }
.dsh-dot-chat .dsh-dot-cap-locked { flex-direction: row; flex-wrap: wrap; gap: 4px; }
.dsh-dot-chat .dsh-dot-cap-locked-name { padding: 1px 6px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); font-size: 11px; font-family: var(--ds-font-family-code); color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-mcp { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.dsh-dot-chat .dsh-dot-mcp-row { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke); }
.dsh-dot-chat .dsh-dot-mcp-line { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-width: 0; }
.dsh-dot-chat .dsh-dot-mcp-name { flex-shrink: 0; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-mcp-status, .dsh-dot-chat .dsh-dot-mcp-about { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-mcp-actions { display: inline-flex; align-items: center; gap: 0; margin-left: auto; flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-mcp-grant { display: flex; align-items: center; }
.dsh-dot-chat .dsh-dot-mcp-state { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-cap-name .dsh-dot-mcp-state { margin-right: 6px; vertical-align: middle; }
.dsh-dot-chat .dsh-dot-mcp-state--ok { background: var(--dsw-alias-state-success-primary); }
.dsh-dot-chat .dsh-dot-mcp-state--warn { background: var(--dsw-alias-state-warn-primary); }
.dsh-dot-chat .dsh-dot-mcp-state--bad { background: var(--dsw-alias-state-danger-primary, var(--dsw-alias-state-warn-primary)); }
.dsh-dot-chat .dsh-dot-mcp-state--muted { background: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-mcp-token { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding-top: 2px; }
.dsh-dot-chat .dsh-dot-mcp-token .dsh-ui-input, .dsh-dot-chat .dsh-dot-mcp-token input { flex: 1 1 140px; min-width: 0; }
.dsh-dot-chat .dsh-dot-mcp-token-link { font-size: 11px; }
.dsh-dot-chat .dsh-dot-mcp-token-help { flex-basis: 100%; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-mcp-global { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; }
.dsh-dot-chat .dsh-dot-mcp-global .dsh-dot-mcp-token-help { flex-basis: auto; }
.dsh-dot-chat .dsh-dot-mcp-custom > summary { padding: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); cursor: pointer; list-style: none; }
.dsh-dot-chat .dsh-dot-mcp-custom > summary::-webkit-details-marker { display: none; }
.dsh-dot-chat .dsh-dot-mcp-custom > summary::before { content: '▸'; margin-right: 6px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-mcp-custom[open] > summary::before { content: '▾'; }
.dsh-dot-chat .dsh-dot-mcp-custom-body { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke); }
/* Unified capabilities & MCP module: one connected-server card carries status,
   grants and credentials; its individual tools stay collapsed until expanded. */
.dsh-dot-chat .dsh-dot-capmcp { display: flex; flex-direction: column; gap: 10px; }
.dsh-dot-chat .dsh-dot-mcp-server { padding: 0; }
.dsh-dot-chat .dsh-dot-mcp-server > summary { display: flex; align-items: center; gap: 2px 6px; padding: 8px 12px 4px; list-style: none; cursor: pointer; min-width: 0; }
.dsh-dot-chat .dsh-dot-mcp-server > summary::-webkit-details-marker { display: none; }
.dsh-dot-chat .dsh-dot-mcp-server[open] > summary .dsh-dot-cap-chev { transform: rotate(90deg); }
.dsh-dot-chat .dsh-dot-mcp-server > summary .dsh-dot-mcp-line { flex: 1 1 auto; min-width: 0; }
.dsh-dot-chat .dsh-dot-mcp-server > .dsh-dot-mcp-grant { padding: 0 12px; }
.dsh-dot-chat .dsh-dot-mcp-server > .dsh-dot-mcp-token { padding: 0 12px 2px; }
.dsh-dot-chat .dsh-dot-mcp-server > .dsh-dot-mcp-tools { padding: 0 12px 10px 22px; }
.dsh-dot-chat .dsh-dot-mcp-tools { display: flex; flex-direction: column; gap: 2px; }
.dsh-dot-chat .dsh-dot-mcp-remove { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-tertiary)); }
.dsh-dot-chat .dsh-dot-mcp-remove:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary)); background: var(--dsw-alias-interactive-bg-hover); }
/* GitHub poll-primary settings card, status banners, connection check, and collapsed advanced panels. */
.dsh-dot-chat .dsh-dot-gh { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dsh-dot-chat .dsh-dot-pane-section.dsh-dot-gh, .dsh-dot-chat .dsh-dot-pane-section.dsh-dot-factory { padding-top: 14px; padding-bottom: 14px; }
.dsh-dot-chat .dsh-dot-gh-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dsh-dot-chat .dsh-dot-gh-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-gh-desc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-gh-health { padding: 1px 8px; border-radius: var(--dsw-radius-sm); font-size: 11px; line-height: 18px; font-weight: 500; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-gh-health[data-health='ok'] { color: var(--dsw-alias-state-success-primary); }
.dsh-dot-chat .dsh-dot-gh-health[data-health='degraded'] { color: var(--dsw-alias-state-warn-primary); }
.dsh-dot-chat .dsh-dot-gh-health[data-health='error'] { color: var(--dsw-alias-state-error-primary); }
.dsh-dot-chat .dsh-dot-gh-banner { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: var(--dsw-radius-sm); font-size: 12px; line-height: 18px; }
.dsh-dot-chat .dsh-dot-gh-banner--warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-state-warn-primary); }
.dsh-dot-chat .dsh-dot-gh-banner--error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
.dsh-dot-chat .dsh-dot-gh-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.dsh-dot-chat .dsh-dot-gh-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-stroke); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-gh-chip-name { font-family: var(--ds-font-family-code); }
.dsh-dot-chat .dsh-dot-gh-chip-remove { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font-size: 13px; line-height: 1; }
.dsh-dot-chat .dsh-dot-gh-chip-remove:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-gh-empty { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); margin-bottom: 6px; }
.dsh-dot-chat .dsh-dot-gh-add-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-dot-chat .dsh-dot-gh-add-row > :first-child { flex: 1 1 auto; min-width: 0; }
.dsh-dot-chat .dsh-dot-gh-streams { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.dsh-dot-chat .dsh-dot-gh-meta-row { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 4px; }
.dsh-dot-chat .dsh-dot-gh-test-bar { display: flex; align-items: center; gap: 8px; padding-top: 4px; }
.dsh-dot-chat .dsh-dot-gh-test-result { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 18px; }
.dsh-dot-chat .dsh-dot-gh-test-head { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-state-warn-primary); }
.dsh-dot-chat .dsh-dot-gh-test-result[data-ok] .dsh-dot-gh-test-head { color: var(--dsw-alias-state-success-primary); }
.dsh-dot-chat .dsh-dot-gh-test-lines { display: flex; flex-direction: column; gap: 2px; color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-gh-test-repo[data-ok] { color: var(--dsw-alias-state-success-primary); }
.dsh-dot-chat .dsh-dot-gh-details { border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke); }
.dsh-dot-chat .dsh-dot-gh-details-summary { display: flex; align-items: center; gap: 8px; padding: 10px 14px; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary); cursor: pointer; list-style: none; }
.dsh-dot-chat .dsh-dot-gh-details-summary::-webkit-details-marker { display: none; }
.dsh-dot-chat .dsh-dot-gh-details-summary::before { content: '▸'; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-gh-details[open] > .dsh-dot-gh-details-summary::before { content: '▾'; }
.dsh-dot-chat .dsh-dot-gh-details-body { display: flex; flex-direction: column; gap: 10px; padding: 0 14px 12px; }
.dsh-dot-chat .dsh-dot-gh-rules { display: flex; flex-direction: column; gap: 6px; }
.dsh-dot-chat .dsh-dot-gh-rule-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 6px 8px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); font-size: 12px; }
.dsh-dot-chat .dsh-dot-gh-rule-repo { font-family: var(--ds-font-family-code); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-gh-rule-meta { color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-gh-rule-select { margin-left: auto; width: auto; }
.dsh-dot-chat .dsh-dot-gh-rule-form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dsh-dot-chat .dsh-dot-gh-rule-form > :first-child { flex: 1 1 120px; min-width: 100px; }
.dsh-dot-chat .dsh-dot-lock-grid { display: grid; grid-template-columns: 1fr; gap: 2px 18px; }
@container (min-width: 560px) {
  .dsh-dot-chat .dsh-dot-lock-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.dsh-dot-chat .dsh-dot-lock-check { min-height: 30px; padding: 4px 0; }
.dsh-dot-chat .dsh-dot-gh-subhead { margin-top: 12px; font-size: 12px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-cap-section { text-transform: none; letter-spacing: normal; font-size: 12px; }
.dsh-dot-chat .dsh-dot-cap-section--main { margin-top: 14px; }
.dsh-dot-chat .dsh-dot-cap-body .dsh-dot-cap-group { background: transparent; }
.dsh-dot-chat .dsh-dot-factory-preview { background: transparent; box-shadow: none; border: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-dot-chat .dsh-dot-mcp-custom-body { background: transparent; box-shadow: none; border: 0.5px solid var(--dsw-alias-border-l2); }
`
