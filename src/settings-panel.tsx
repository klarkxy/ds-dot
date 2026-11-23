/**
 * Dorothy's settings view, opened from the gear in her panel's header. Every
 * change saves at once; free-text fields save when they lose focus.
 */
import { groupModelMenuChoices, modelMenuShortName, parseModelMenuChoices, type ModelMenuChoice } from '@klarkxy/dsh-plugin-kit/model-menu'
import { renderModelPicker, type RenderFactorySlot } from '@klarkxy/dsh-plugin-kit/model-picker'
import { Button, Checkbox, IconInfoOutlineRegular, IconSearchOutlineRegular, Input, SegmentedTabs, Switch, Tooltip, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SettingsSection } from './chat-hooks.ts'
export type { SettingsSection } from './chat-hooks.ts'
import { type ApprovalMode, type CapabilityCatalogView, type CapabilityGrant, type CapabilityGroupView, type CapabilityToolView, type DotSettings, type FactoryResetPreview, type FactoryResetResult, type KeepaliveInfo, type ModelChoice, type SettingField, type SettingProposal, type TakeoverMode, type TaskModelRule, type TaskPermission } from './contracts.ts'
import { DESKTOP_NOTIFY_KEY } from './attention-client.ts'
import type { UpdateResult, UpdateStatus } from './auto-update.ts'
import { factoryResetScope, formatWhen, t, type CopyLocale, type TextKey } from './ui-copy.ts'

/** null on model, persona or address goes back to the default. */
export type SettingsPatch = { readonly [K in keyof DotSettings]?: K extends 'model' ? ModelChoice | null : K extends 'persona' | 'address' ? string | null : DotSettings[K] }
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
  /** Live task-permission options; absent in tests. */
  taskPermissionOptions?(signal: AbortSignal): Promise<{ options: TaskPermission[] }>
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

function PadlockGlyph({ locked }: { locked: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.25" y="7.25" width="9.5" height="6.5" rx="1.6" stroke="currentColor" strokeWidth="1.25" />
      {locked
        ? <path d="M5.25 7.25V5.2a2.75 2.75 0 0 1 5.5 0v2.05" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        : <path d="M5.25 7.25V5.1a2.75 2.75 0 0 1 5.15-1.35" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />}
    </svg>
  )
}

/** Subtle monochrome lock toggle: quiet icon while unlocked, visible badge once locked. */
export function LockToggle({ locale, label, locked, onLock }: { locale: CopyLocale; label: string; locked: boolean; onLock: (locked: boolean) => void }) {
  return (
    <button
      type="button"
      className="dsh-dot-lock"
      data-locked={locked ? '' : undefined}
      aria-label={t(locale, locked ? 'sUnlock' : 'sLock').replace('{field}', label)}
      title={t(locale, locked ? 'sLockTip' : 'sUnlockTip')}
      aria-pressed={locked}
      onClick={() => onLock(!locked)}
    >
      <PadlockGlyph locked={locked} />
      {locked ? <span className="dsh-dot-lock-badge">{t(locale, 'sLockedBadge')}</span> : null}
    </button>
  )
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

function Field({ label, tip, help, helpTone, trailing, children, locked, onLock }: {
  label: string
  tip?: string | undefined
  help?: string | undefined
  helpTone?: 'warn' | undefined
  trailing?: ReactNode
  children: ReactNode
  locked?: boolean
  onLock?: (locked: boolean) => void
}) {
  const locale = useContext(LocaleContext)
  return (
    <div className="dsh-ui-field">
      <div className="dsh-dot-setting-head">
        <span className="dsh-ui-label">
          <span>{label}</span>
          {tip ? <HelpTip locale={locale} fieldLabel={label} text={tip} /> : null}
        </span>
        <div className="dsh-dot-setting-tools">
          {trailing}
          {onLock ? <LockToggle locale={locale} label={label} locked={locked === true} onLock={onLock} /> : null}
        </div>
      </div>
      {children}
      {help ? <span className={helpTone === 'warn' ? 'dsh-ui-help dsh-ui-warn' : 'dsh-ui-help'}>{help}</span> : null}
    </div>
  )
}

/** Single-row setting for boolean switches and compact numeric inputs. */
function InlineField({ label, tip, control, below, locked, onLock }: {
  label: string
  tip?: string | undefined
  control: ReactNode
  below?: ReactNode
  locked?: boolean
  onLock?: (locked: boolean) => void
}) {
  const locale = useContext(LocaleContext)
  return (
    <div className="dsh-ui-field">
      <div className="dsh-dot-inline-row">
        <span className="dsh-ui-label dsh-dot-inline-label">
          <span>{label}</span>
          {tip ? <HelpTip locale={locale} fieldLabel={label} text={tip} /> : null}
        </span>
        <div className="dsh-dot-inline-control">
          {onLock ? <LockToggle locale={locale} label={label} locked={locked === true} onLock={onLock} /> : null}
          {control}
        </div>
      </div>
      {below}
    </div>
  )
}

function formatProposalValue(locale: CopyLocale, field: SettingProposal['field'], value: unknown, choices: readonly ModelMenuChoice[]): { text: string; block: boolean } {
  if (value === null || value === undefined || value === '') {
    return { text: field === 'model' ? t(locale, 'sModelFollow') : t(locale, 'sProposalDefault'), block: false }
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

const GRANT_MODES: readonly [CapabilityGrant, CapabilityGrant, CapabilityGrant] = ['off', 'ask', 'auto']

/**
 * The off/ask/auto control of one row. A row without its own grant row shows
 * the value it inherits, dimmed; the clear button removes its own override.
 */
function GrantPicker({ locale, label, chain, grants, applied, onPick }: {
  locale: CopyLocale
  label: string
  /** Selectors this row answers to, most specific first; the first owns the write. */
  chain: readonly string[]
  grants: Readonly<Record<string, CapabilityGrant>>
  /** Grant the live segment applied to this tool; compared for the next-segment badge. */
  applied?: CapabilityGrant | undefined
  onPick: (selector: string, grant: CapabilityGrant | undefined) => void
}) {
  const own = chain[0]
  let effective: CapabilityGrant = 'off'
  for (const selector of chain) {
    const grant = grants[selector]
    if (grant !== undefined) { effective = grant; break }
  }
  const hasOwn = own !== undefined && grants[own] !== undefined
  return (
    <span className="dsh-dot-cap-grant" data-inherited={hasOwn ? undefined : ''}>
      <SegmentedChoice locale={locale} label={label} value={effective} options={GRANT_MODES} labelKeyOf={option => `sCap_${option}` as TextKey} onChange={next => { if (own !== undefined) onPick(own, next) }} />
      {hasOwn ? <Button variant="ghost" size="sm" className="dsh-dot-cap-clear" onClick={() => { if (own !== undefined) onPick(own, undefined) }}>{t(locale, 'sCapClear')}</Button> : null}
      {applied !== undefined && applied !== effective ? <span className="dsh-dot-cap-badge">{t(locale, 'sCapNext')}</span> : null}
    </span>
  )
}

/**
 * The grantable catalog: locked dot tools on top, then MCP servers, plugins
 * with their entries, and the unattributed rest. Grants save as one whole
 * `capabilities` patch through the shared settings channel.
 */
function Capabilities({ locale, api, grants, onPick }: {
  locale: CopyLocale
  api: SettingsApi
  grants: Readonly<Record<string, CapabilityGrant>>
  onPick: (selector: string, grant: CapabilityGrant | undefined) => void
}) {
  const [view, setView] = useState<CapabilityCatalogView>()
  const [error, setError] = useState('')
  const [capFilter, setCapFilter] = useState('')
  useEffect(() => {
    if (api.capabilities === undefined) return
    const life = new AbortController()
    const load = () => api.capabilities!(life.signal).then(
      next => { setView(next); setError('') },
      failure => { if (!life.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)) },
    )
    void load()
    const timer = setInterval(load, 5000)
    return () => { life.abort(); clearInterval(timer) }
  }, [api])
  if (api.capabilities === undefined) return null
  if (view === undefined && !error) return <PaneSkeleton label={t(locale, 'settingsLoading')} />
  const applied = view?.applied ?? {}
  const capNeedle = capFilter.trim().toLowerCase()
  const matchesTool = (tool: CapabilityToolView) => capNeedle === '' || tool.name.toLowerCase().includes(capNeedle) || (tool.description ?? '').toLowerCase().includes(capNeedle)
  const displayedLabel = (group: CapabilityGroupView): string =>
    group.kind === 'host' ? t(locale, 'sCapHostGroup')
    : group.id === 'builtin' ? t(locale, 'sCapBuiltinGroup')
    : group.id.startsWith('builtin:') ? t(locale, `sCapBuiltin_${group.id.slice('builtin:'.length)}` as TextKey) || group.label
    : group.label
  const groupSelfHits = (group: CapabilityGroupView): boolean =>
    capNeedle !== '' && (displayedLabel(group).toLowerCase().includes(capNeedle) || group.id.toLowerCase().includes(capNeedle))
  const groupHits = (group: CapabilityGroupView): boolean =>
    groupSelfHits(group) || group.tools.some(matchesTool) || (group.children ?? []).some(groupHits)
  const countTools = (group: CapabilityGroupView): number =>
    group.tools.length + (group.children ?? []).reduce((sum, child) => sum + countTools(child), 0)
  const countTaskOnly = (group: CapabilityGroupView): number =>
    group.tools.filter(tool => tool.taskOnly === true).length
      + (group.children ?? []).reduce((sum, child) => sum + countTaskOnly(child), 0)
  // A group grant can never apply to task-only tools, so a group whose tools
  // are all task-only has nothing for the picker to do. Empty groups keep it.
  const groupAllTaskOnly = (group: CapabilityGroupView): boolean =>
    countTools(group) > 0 && countTaskOnly(group) === countTools(group)
  const kindLabel = (group: CapabilityGroupView): string =>
    group.kind === 'mcp' ? t(locale, 'sCapKind_mcp')
    : group.kind === 'builtin' ? t(locale, 'sCapKind_builtin')
    : group.kind === 'plugin' || group.kind === 'entry' ? t(locale, 'sCapKind_plugin')
    : t(locale, 'sCapKind_unknown')
  const effectiveFor = (chain: readonly string[]): CapabilityGrant => {
    for (const selector of chain) { const grant = grants[selector]; if (grant !== undefined) return grant }
    return 'off'
  }
  const groupRows = (group: CapabilityGroupView, parents: readonly string[], showFull = false): ReactNode => {
    // The host and builtin groups are display-only: their tools grant one by one / via children.
    const chain = group.kind === 'host' || group.id === 'builtin' ? parents : [group.id, ...parents]
    const changed = group.tools.some(tool => (applied[tool.name] ?? 'off') !== effectiveFor([`tool:${tool.name}`, ...chain]))
    const granted = group.tools.some(tool => effectiveFor([`tool:${tool.name}`, ...chain]) !== 'off')
      || (group.children ?? []).some(child => child.tools.some(tool => effectiveFor([`tool:${tool.name}`, child.id, ...chain]) !== 'off'))
    const label = displayedLabel(group)
    const selfHit = showFull || groupSelfHits(group)
    if (capNeedle !== '' && !selfHit && !groupHits(group)) return null
    const tools = selfHit || capNeedle === '' ? group.tools : group.tools.filter(matchesTool)
    return (
      <details key={group.id} className="dsh-dot-cap-group" open={granted || capNeedle !== ''}>
        <summary className="dsh-dot-cap-head">
          <span className="dsh-dot-cap-name" title={group.id}>{label}{group.kind === 'builtin' && group.id !== 'builtin' ? null : <span className="dsh-dot-cap-tag">{kindLabel(group)}</span>}<span className="dsh-dot-cap-count">{t(locale, 'sCapToolCount').replace('{n}', String(countTools(group)))}</span></span>
          {group.missing === true ? <span className="dsh-dot-cap-badge">{t(locale, 'sCapMissing')}</span> : null}
          {changed ? <span className="dsh-dot-cap-badge">{t(locale, 'sCapNext')}</span> : null}
          {group.kind === 'host' || group.id === 'builtin' || groupAllTaskOnly(group) ? null : (
            <span className="dsh-dot-cap-control" onClick={event => event.preventDefault()}>
              <GrantPicker locale={locale} label={label} chain={chain} grants={grants} applied={undefined} onPick={onPick} />
            </span>
          )}
        </summary>
        <div className="dsh-dot-cap-body">
          {tools.map(tool => {
            const toolChain = [`tool:${tool.name}`, ...chain]
            // Only a grantable group with exactly one tool has a picker to stand in for this row.
            // Search that leaves a single visible tool must not hide the tool-level control.
            const soloNoOwnGrant = group.kind !== 'host' && group.id !== 'builtin'
              && group.tools.length === 1 && (group.children ?? []).length === 0
              && grants[`tool:${tool.name}`] === undefined
            return (
              <div key={tool.name} className="dsh-dot-cap-row">
                <span className="dsh-dot-cap-name dsh-dot-cap-tool">
                  <code>{tool.name}</code>
                  {tool.description !== undefined ? <span className="dsh-dot-cap-desc">{tool.description}</span> : null}
                </span>
                {tool.missing === true ? <span className="dsh-dot-cap-badge">{t(locale, 'sCapMissing')}</span> : null}
                {tool.conditional ? <span className="dsh-dot-cap-badge">{t(locale, 'sCapConditional')}</span> : null}
                {tool.taskOnly === true ? <span className="dsh-dot-cap-badge dsh-dot-cap-badge--warn" title={t(locale, 'sCapTaskOnlyHint')}>{t(locale, 'sCapTaskOnly')}</span> : null}
                {soloNoOwnGrant || tool.taskOnly === true ? null : <GrantPicker locale={locale} label={tool.name} chain={toolChain} grants={grants} applied={tool.missing === true ? undefined : (applied[tool.name] ?? 'off')} onPick={onPick} />}
              </div>
            )
          })}
          {(group.children ?? []).map(child => groupRows(child, chain, selfHit))}
        </div>
      </details>
    )
  }
  return (
    <div className="dsh-dot-caps">
      <p className="dsh-dot-cap-intro">{t(locale, 'sCapIntro')}</p>
      <Input
        className="dsh-dot-cap-search"
        icon={<IconSearchOutlineRegular size={13} />}
        type="search"
        aria-label={t(locale, 'sCapFilter')}
        placeholder={t(locale, 'sCapFilter')}
        value={capFilter}
        onChange={event => setCapFilter(event.target.value)}
      />
      {error ? <div className="dsh-ui-error" role="alert">{error}</div> : null}
      {view === undefined ? null : (
        <>
          <details className="dsh-dot-cap-group dsh-dot-cap-group--locked">
            <summary className="dsh-dot-cap-head">
              <span className="dsh-dot-cap-name">{t(locale, 'sCapLockedTitle')}<span className="dsh-dot-cap-count">{t(locale, 'sCapToolCount').replace('{n}', String(view.locked.length))}</span></span>
              <span className="dsh-dot-cap-badge dsh-dot-cap-badge--on">{t(locale, 'sCapAlways')}</span>
            </summary>
            <div className="dsh-dot-cap-body dsh-dot-cap-locked">{view.locked.map(name => <span key={name} className="dsh-dot-cap-locked-name">{name}</span>)}</div>
          </details>
          {view.groups.length === 0 ? <div className="dsh-dot-model-empty">{t(locale, 'sCapEmpty')}</div> : null}
          {view.groups.map(group => groupRows(group, []))}
        </>
      )}
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

function SegmentedChoice<T extends string>({ locale, label, value, options, labelKeyOf, onChange }: {
  locale: CopyLocale
  label: string
  value: T
  options: readonly [T, ...T[]]
  labelKeyOf: (option: T) => TextKey
  onChange: (next: T) => void
}) {
  const baseId = useId()
  const items = useMemo(() => options.map(option => ({
    id: `${baseId}-${option}`,
    panelId: `${baseId}-${option}-panel`,
    value: option,
    label: <span className="dsh-dot-seg-label">{t(locale, labelKeyOf(option))}</span>,
  })) as unknown as readonly [SegmentedTab<T>, ...SegmentedTab<T>[]], [baseId, locale, options, labelKeyOf])
  return (
    <SegmentedTabs<T>
      size="sm"
      label={label}
      items={items}
      value={value}
      onChange={next => { if (next !== value) onChange(next) }}
    />
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
    <div className="dsh-dot-pane-section dsh-dot-factory">
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
  const modelGroups = groupModelMenuChoices(choices, '')
  const pickModel = (key: string) => {
    if (key === FOLLOW) { save({ model: null }); return }
    const choice = choices.find(item => keyOf(item) === key)
    if (choice) save({ model: { provider: choice.provider, model: choice.model } })
  }
  const approvalModes: readonly [ApprovalMode, ApprovalMode, ApprovalMode] = ['dot', 'human', 'deny']
  const questionModes: readonly [TakeoverMode, TakeoverMode, TakeoverMode] = ['dot', 'human', 'off']
  const permissionModes: readonly [TaskPermission, ...TaskPermission[]] = (livePermissions.includes(settings.taskPermission)
    ? livePermissions
    : [...livePermissions, settings.taskPermission]) as [TaskPermission, ...TaskPermission[]]
  const lock = (field: SettingField) => ({ locked: settings?.locks?.[field] === true, onLock: (locked: boolean) => save({ locks: { ...settings?.locks, [field]: locked } }) })

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

  return (
    <LocaleContext.Provider value={locale}><div className="dsh-dot-pane dsh-dot-settings-pane">
      {!onStatusChange && status?.kind === 'saved' ? <div className="dsh-ui-notice" role="status">{t(locale, 'saved')}</div> : null}
      {!onStatusChange && status?.kind === 'error' ? <div className="dsh-ui-error" role="alert">{t(locale, 'saveFailed')}{status.message}</div> : null}
      {show('proposals') ? <Proposals locale={locale} choices={choices} state={proposalState} showTitle={allSections} /> : null}
      {show('general') ? (
        <>
          <div className="dsh-dot-pane-section">
            <div className="dsh-ui-form">
              <Field label={t(locale, 'sModel')} help={modelHelp} helpTone={models.failed ? 'warn' : undefined} {...lock('model')}>
                {renderModelPicker(renderFactorySlot, {
                  locale,
                  choices,
                  selected: chosen ? { provider: chosen.provider, model: chosen.model } : undefined,
                  onPick: picked => save({ model: { provider: picked.provider, model: picked.model } }),
                  leading: [{ id: 'follow', label: t(locale, 'sModelFollow'), selected: !chosen }],
                  onPickLeading: () => save({ model: null }),
                  triggerLabel: chosen ? (choices.find(item => item.provider === chosen.provider && item.model === chosen.model)?.label ?? `${chosen.provider} / ${chosen.model}`) : t(locale, 'sModelFollow'),
                  modelLabel: t(locale, 'sModel'),
                  searchPlaceholder: t(locale, 'sTaskModelsFilter'),
                  emptyLabel: t(locale, 'sTaskModelsNoMatch'),
                  clearSearchLabel: t(locale, 'sTaskModelsClear'),
                  retryLabel: t(locale, 'retry'),
                  listClassName: 'dsh-dot-chat',
                }, {
                  fallback: (
                    <select className="dsh-ui-select" aria-label={t(locale, 'sModel')} value={chosen ? keyOf(chosen) : FOLLOW} onChange={event => pickModel(event.target.value)}>
                      <option value={FOLLOW}>{t(locale, 'sModelFollow')}</option>
                      {modelGroups.map(group => (
                        <optgroup key={group.provider} label={group.name}>
                          {group.items.map(choice => <option key={keyOf(choice)} value={keyOf(choice)}>{choice.label}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  ),
                })}
                {keepalive ? (
                  <div className="dsh-dot-keepalive-row">
                    <span className="dsh-dot-keepalive-label">
                      <span>{t(locale, 'sCacheTtl')}</span>
                      <HelpTip
                        locale={locale}
                        fieldLabel={t(locale, 'sCacheTtl')}
                        text={t(locale, 'sCacheTtlDesc').replace('{key}', `${keepalive.provider}/${keepalive.model}`).replace('{n}', String(keepalive.defaultMinutes))}
                      />
                    </span>
                    <IdleCheckInput
                      locale={locale}
                      label={t(locale, 'sCacheTtl')}
                      unit={t(locale, 'sCacheTtlUnit')}
                      value={settings.cacheTtl?.[`${keepalive.provider}/${keepalive.model}`] ?? keepalive.minutes}
                      onCommit={minutes => {
                        const key = `${keepalive.provider}/${keepalive.model}`
                        const next = { ...settings.cacheTtl }
                        if (minutes === keepalive.defaultMinutes) delete next[key]
                        else next[key] = minutes
                        save({ cacheTtl: next })
                      }}
                    />
                  </div>
                ) : null}
              </Field>
              <InlineField
                label={t(locale, 'sReflection')}
                tip={t(locale, 'sReflectionDesc')}
                {...lock('reflection')}
                control={<Switch checked={settings.reflection} label={t(locale, 'sReflection')} onChange={next => save({ reflection: next })} />}
              />
              <InlineField
                label={t(locale, 'sAutoUpdate')}
                tip={t(locale, 'sAutoUpdateDesc')}
                control={<Switch checked={settings.autoUpdate} label={t(locale, 'sAutoUpdate')} onChange={next => save({ autoUpdate: next })} />}
                below={api.updateStatus ? <AutoUpdateLine locale={locale} api={api} /> : null}
              />
              <DesktopNotifyField locale={locale} />
            </div>
          </div>
          {api.previewFactoryReset && api.confirmFactoryReset ? <FactoryResetField locale={locale} api={api} onSaved={onSaved} /> : null}
        </>
      ) : null}
      {show('takeover') ? (
        <div className="dsh-dot-pane-section">
          {allSections ? <h3 className="dsh-dot-pane-section-title">{t(locale, 'sRequests')}</h3> : null}
          <div className="dsh-ui-form">
            <Field label={t(locale, 'sScope')} tip={t(locale, 'sScopeDesc')} {...lock('scope')}>
              <SegmentedChoice locale={locale} label={t(locale, 'sScope')} value={settings.scope} options={['all', 'tracked']} labelKeyOf={opt => `sScope_${opt}`} onChange={next => save({ scope: next })} />
            </Field>
            <Field label={t(locale, 'sApprovals')} tip={approvalHelp} {...lock('approvals')}>
              <SegmentedChoice locale={locale} label={t(locale, 'sApprovals')} value={settings.approvals} options={approvalModes} labelKeyOf={opt => `sApprovals_${opt}`} onChange={next => save({ approvals: next })} />
            </Field>
            <Field label={t(locale, 'sQuestions')} tip={t(locale, `sQuestionsDesc_${settings.questions}` as TextKey)} {...lock('questions')}>
              <SegmentedChoice locale={locale} label={t(locale, 'sQuestions')} value={settings.questions} options={questionModes} labelKeyOf={opt => `sQuestions_${opt}`} onChange={next => save({ questions: next })} />
            </Field>
          </div>
        </div>
      ) : null}
      {show('dispatch') ? (
        <div className="dsh-dot-pane-section">
          {allSections ? <h3 className="dsh-dot-pane-section-title">{t(locale, 'sTasks')}</h3> : null}
          <div className="dsh-ui-form">
            <Field
              label={t(locale, 'sTaskPermission')}
              tip={t(locale, `sTaskPermissionDesc_${settings.taskPermission}` as TextKey)}
              help={livePermissions.includes(settings.taskPermission) ? undefined : t(locale, 'sTaskPermissionUnavailable').replace('{name}', t(locale, `sTaskPermission_${settings.taskPermission}` as TextKey))}
              helpTone={livePermissions.includes(settings.taskPermission) ? undefined : 'warn'}
              {...lock('taskPermission')}
            >
              <SegmentedChoice locale={locale} label={t(locale, 'sTaskPermission')} value={settings.taskPermission} options={permissionModes} labelKeyOf={opt => `sTaskPermission_${opt}`} onChange={next => save({ taskPermission: next })} />
            </Field>
            <Field label={t(locale, 'sTaskModels')} help={taskModelsHelp} helpTone={taskModelsHelp ? 'warn' : undefined} {...lock('taskModels')}>
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
                    <span className="dsh-ui-meta">{t(locale, 'sTaskModelsSelected').replace('{n}', String(rule.list.length))}</span>
                    {rule.list.length > 0 ? (
                      <Button variant="ghost" size="sm" onClick={() => save({ taskModels: { mode: rule.mode, list: [] } })}>{t(locale, 'sTaskModelsClear')}</Button>
                    ) : null}
                  </div>
                  {rule.list.length > 0 ? (
                    <div className="dsh-dot-model-chips" data-tone={rule.mode} aria-label={t(locale, 'sTaskModelsSelected').replace('{n}', String(rule.list.length))}>
                      {rule.list.map(key => {
                        const choice = catalogChoices.find(item => taskModelKey(item) === key)
                        const stale = choice === undefined
                        return (
                          <span key={key} className="dsh-dot-model-chip" data-stale={stale ? '' : undefined} title={stale ? `${key} ${t(locale, 'sTaskModelsGone')}` : choice.label}>
                            <span className="dsh-dot-model-chip-name">{choice ? modelMenuShortName(choice) : key}</span>
                            {choice ? <span className="dsh-dot-model-chip-provider">{choice.providerLabel ?? choice.provider}</span> : null}
                            <button type="button" className="dsh-dot-model-chip-remove" aria-label={t(locale, 'sTaskModelsRemove').replace('{name}', choice ? modelMenuShortName(choice) : key)} onClick={() => toggleTaskModel(key, false)}>×</button>
                          </span>
                        )
                      })}
                    </div>
                  ) : null}
                  <div className="dsh-dot-model-list">
                    {filteredGroups.length === 0 && staleKeys.length === 0 ? (
                      <div className="dsh-dot-model-empty">{catalogChoices.length === 0 && !models.failed ? t(locale, 'sModelLoading') : t(locale, 'sTaskModelsNoMatch')}</div>
                    ) : null}
                    {filteredGroups.map(group => {
                      const keys = group.items.map(taskModelKey)
                      const selected = keys.filter(key => rule.list.includes(key))
                      return (
                        <details className="dsh-dot-model-group" key={group.provider} open={modelFilter.trim() !== '' || selected.length > 0}>
                          <summary className="dsh-dot-model-group-title">
                            <span className="dsh-dot-model-group-label">{group.name}<span className="dsh-dot-model-group-count">{selected.length}/{keys.length}</span></span>
                            <button type="button" className="dsh-dot-model-group-toggle" onClick={event => { event.preventDefault(); event.stopPropagation(); toggleTaskGroup(keys, selected.length !== keys.length) }}>{t(locale, selected.length === keys.length ? 'sTaskModelsGroupNone' : 'sTaskModelsGroupAll')}</button>
                          </summary>
                          {group.items.map(choice => {
                            const key = taskModelKey(choice)
                            return (
                              <Checkbox
                                key={key}
                                className="dsh-dot-model-item"
                                checked={rule.list.includes(key)}
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
                            className="dsh-dot-model-item"
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
              {...lock('idleCheckMinutes')}
              control={<IdleCheckInput locale={locale} value={settings.idleCheckMinutes} onCommit={minutes => save({ idleCheckMinutes: minutes })} />}
            />
          </div>
        </div>
      ) : null}
      {show('capabilities') ? (
        <div className="dsh-dot-pane-section">
          {allSections ? <h3 className="dsh-dot-pane-section-title">{t(locale, 'sCapabilities')}</h3> : null}
          <div className="dsh-ui-form">
            <Field label={t(locale, 'sCapGrants')} tip={t(locale, 'sCapabilitiesDesc')} {...lock('capabilities')}>
              <Capabilities locale={locale} api={api} grants={settings.capabilities?.grants ?? {}} onPick={(selector, grant) => {
                const grants = { ...settings.capabilities?.grants }
                if (grant === undefined) delete grants[selector]
                else grants[selector] = grant
                save({ capabilities: { grants } })
              }} />
            </Field>
          </div>
        </div>
      ) : null}
    </div></LocaleContext.Provider>
  )
}

// Selectors spell the root out (.dsh-dot-chat = CHAT_ROOT) so the repository scope check can read them.
export const settingsCss = `
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
.dsh-dot-chat .dsh-dot-lock {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; white-space: nowrap; height: 22px; padding: 0 5px;
  border: 0; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer;
  transition: opacity var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out), background-color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out), color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out);
}
.dsh-dot-chat .dsh-dot-lock:hover,
.dsh-dot-chat .dsh-dot-lock:focus-visible { opacity: 1; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-lock[data-locked] { opacity: 1; padding: 0 7px; background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-state-warn-primary); }
.dsh-dot-chat .dsh-dot-lock-badge { font-size: 11px; line-height: 16px; font-weight: 500; }
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
.dsh-dot-chat .dsh-dot-proposal-blocks > div { display: flex; flex-direction: column; gap: 4px; }
.dsh-dot-chat .dsh-dot-proposal-blocks > div > span { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-proposal-blocks pre {
  margin: 0; max-height: 160px; overflow: auto; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere;
  background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-radius-sm); font: 12px/18px var(--ds-font-family-code); color: var(--dsw-alias-label-primary);
}
.dsh-dot-chat .dsh-dot-model-picker {
  display: flex; flex-direction: column; gap: 8px; margin-top: 4px; padding: 10px;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke);
}
.dsh-dot-chat .dsh-dot-model-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-dot-chat .dsh-dot-model-toolbar > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-model-search { flex: 1 1 160px; min-width: 0; height: 28px; }
.dsh-dot-chat .dsh-dot-model-list { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow-y: auto; padding: 2px; }
.dsh-dot-chat .dsh-dot-model-chips { display: flex; flex-wrap: wrap; gap: 4px; max-height: 96px; overflow-y: auto; }
.dsh-dot-chat .dsh-dot-model-chip { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; padding: 1px 4px 1px 7px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-model-chip[data-stale] { color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-model-chip[data-stale] .dsh-dot-model-chip-name { text-decoration: line-through; }
.dsh-dot-chat .dsh-dot-model-chips[data-tone='deny'] .dsh-dot-model-chip { color: var(--dsw-alias-state-warn-primary); }
.dsh-dot-chat .dsh-dot-model-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-model-chip-provider { flex-shrink: 0; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-model-chip-remove { border: 0; background: none; padding: 0 2px; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; }
.dsh-dot-chat .dsh-dot-model-group > summary { display: flex; align-items: center; gap: 6px; list-style: none; cursor: pointer; }
.dsh-dot-chat .dsh-dot-model-group > summary::-webkit-details-marker { display: none; }
.dsh-dot-chat .dsh-dot-model-group > summary::before { content: '›'; display: inline-block; transition: transform 0.12s; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-model-group[open] > summary::before { transform: rotate(90deg); }
.dsh-dot-chat .dsh-dot-model-group-label { flex: 1 1 auto; min-width: 0; }
.dsh-dot-chat .dsh-dot-model-group-count { margin-left: 6px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-model-group-toggle { flex-shrink: 0; border: 0; background: none; padding: 0 6px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; cursor: pointer; }
.dsh-dot-chat .dsh-dot-model-group-toggle:hover { color: var(--dsw-alias-label-primary); }
.dsh-dot-chat .dsh-dot-model-empty { padding: 12px 8px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-model-group { display: flex; flex-direction: column; gap: 2px; }
.dsh-dot-chat .dsh-dot-model-group-title { padding: 4px 6px 2px; font-size: 11px; line-height: 16px; font-weight: 600; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-model-item { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: var(--dsw-radius-sm); font-size: 13px; line-height: 20px; cursor: pointer; }
.dsh-dot-chat .dsh-dot-model-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dot-chat .dsh-dot-idle-check { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-update { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
.dsh-dot-chat .dsh-dot-update-meta { flex: 1 1 160px; min-width: 0; }
.dsh-dot-chat .dsh-dot-idle-input { width: 72px; flex: 0 0 auto; }
.dsh-dot-chat .dsh-dot-keepalive-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; padding-top: 8px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.dsh-dot-chat .dsh-dot-keepalive-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.dsh-dot-chat .dsh-dot-factory { display: flex; flex-direction: column; gap: 10px; }
.dsh-dot-chat .dsh-dot-factory-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; }
.dsh-dot-chat .dsh-dot-factory-preview { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; padding: 10px 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke); }
.dsh-dot-chat .dsh-dot-factory-preview ul { margin: 0; padding-left: 18px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-caps { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.dsh-dot-chat .dsh-dot-cap-intro { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-dot-chat .dsh-dot-cap-search { height: 28px; }
.dsh-dot-chat .dsh-dot-cap-group { border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke); }
.dsh-dot-chat .dsh-dot-cap-group > summary { list-style: none; }
.dsh-dot-chat .dsh-dot-cap-group > summary::-webkit-details-marker { display: none; }
.dsh-dot-chat .dsh-dot-cap-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; padding: 8px 12px; cursor: pointer; }
.dsh-dot-chat .dsh-dot-cap-group--locked .dsh-dot-cap-head { cursor: pointer; }
.dsh-dot-chat .dsh-dot-cap-name { flex: 1 1 auto; min-width: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-cap-tag { margin-left: 6px; padding: 0 5px; border-radius: var(--dsw-radius-sm); font-size: 10px; line-height: 14px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-cap-count { margin-left: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-cap-control { flex: 0 0 auto; margin-left: auto; }
.dsh-dot-chat .dsh-dot-cap-body { display: flex; flex-direction: column; gap: 2px; padding: 0 12px 10px; }
.dsh-dot-chat .dsh-dot-cap-body .dsh-dot-cap-group { box-shadow: none; background: var(--dsw-alias-bg-layer-2); }
.dsh-dot-chat .dsh-dot-cap-row { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 4px 8px; padding: 4px 0 4px 8px; }
.dsh-dot-chat .dsh-dot-cap-tool { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
.dsh-dot-chat .dsh-dot-cap-tool code { font-family: var(--ds-font-family-code); font-size: 12px; }
.dsh-dot-chat .dsh-dot-cap-desc { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-cap-grant { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-cap-grant[data-inherited] [role='tablist'] { opacity: 0.55; }
.dsh-dot-chat .dsh-dot-cap-badge {
  flex-shrink: 0; padding: 1px 6px; border-radius: var(--dsw-radius-sm); font-size: 11px; line-height: 16px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary);
}
.dsh-dot-chat .dsh-dot-cap-badge--on { color: var(--dsw-alias-state-success-primary); }
.dsh-dot-chat .dsh-dot-cap-badge--warn { color: var(--dsw-alias-state-warn-primary); }
.dsh-dot-chat .dsh-dot-cap-clear { flex-shrink: 0; }
.dsh-dot-chat .dsh-dot-cap-locked { flex-direction: row; flex-wrap: wrap; gap: 4px; }
.dsh-dot-chat .dsh-dot-cap-locked-name { padding: 1px 6px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); font-size: 11px; font-family: var(--ds-font-family-code); color: var(--dsw-alias-label-secondary); }
`
