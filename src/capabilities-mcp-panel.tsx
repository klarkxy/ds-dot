/**
 * The unified Extra capabilities & MCP module. Capability authorization and
 * dot-local MCP server management share one scannable view: connected servers
 * with their status, credentials and grants, plugin/host capability groups as
 * clean group-level rows whose tools stay collapsed until expanded, plus the
 * recommended catalog and the custom-server form in one place. Overrides reset
 * through an explicit text control that is visually distinct from removing a
 * server.
 */
import { Button, Checkbox, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconSearchOutlineRegular, Input, SegmentedTabs, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { mcpCredentialName, mcpPrefix, mcpServerOf, isMcpServerUrl, MCP_NEW_SERVER_NAME_PATTERN, type CapabilityGrant, type CapabilityCatalogView, type CapabilityGroupView, type CapabilityToolView, type DotMcpCatalogEntry, type DotMcpListView, type DotMcpServer, type DotMcpServerView, type DotSettings } from './contracts.ts'
import type { SettingsApi, SettingsPatch } from './settings-panel.tsx'
import { PaneSkeleton } from './settings-panel.tsx'
import { t, type CopyLocale, type TextKey } from './ui-copy.ts'

const GRANT_MODES: readonly [CapabilityGrant, CapabilityGrant, CapabilityGrant] = ['off', 'ask', 'auto']

export function SegmentedChoice<T extends string>({ locale, label, value, options, labelKeyOf, titleKeyOf, onChange }: {
  locale: CopyLocale
  label: string
  value: T
  options: readonly [T, ...T[]]
  labelKeyOf: (option: T) => TextKey
  titleKeyOf?: (option: T) => TextKey
  onChange: (next: T) => void
}) {
  const baseId = useId()
  const items = useMemo(() => options.map(option => ({
    id: `${baseId}-${option}`,
    panelId: `${baseId}-${option}-panel`,
    value: option,
    label: <span className="dsh-dot-seg-label" title={t(locale, titleKeyOf === undefined ? labelKeyOf(option) : titleKeyOf(option))}>{t(locale, labelKeyOf(option))}</span>,
  })) as unknown as readonly [SegmentedTab<T>, ...SegmentedTab<T>[]], [baseId, locale, options, labelKeyOf, titleKeyOf])
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

/** Explicit text reset of one stored grant row. Never an icon, never next to a remove control. */
export function GrantReset({ locale, selector, onPick }: {
  locale: CopyLocale
  selector: string
  onPick: (selector: string, grant: CapabilityGrant | undefined) => void
}) {
  return <Button variant="ghost" size="sm" className="dsh-dot-cap-clear" onClick={() => onPick(selector, undefined)}>{t(locale, 'sCapClear')}</Button>
}

/**
 * The off/ask/auto control of one row. A row without its own grant row shows
 * the value it inherits, dimmed; the clear button removes its own override.
 */
export function GrantPicker({ locale, label, chain, grants, applied, onPick, hideClear }: {
  locale: CopyLocale
  label: string
  /** Selectors this row answers to, most specific first; the first owns the write. */
  chain: readonly string[]
  grants: Readonly<Record<string, CapabilityGrant>>
  /** Grant the live segment applied to this tool; compared for the next-segment badge. */
  applied?: CapabilityGrant | undefined
  /** Drop the reset slot (managed server rows reset through the override row instead). */
  hideClear?: boolean
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
      <SegmentedChoice locale={locale} label={label} value={effective} options={GRANT_MODES} labelKeyOf={option => `sCapShort_${option}` as TextKey} titleKeyOf={option => `sCap_${option}` as TextKey} onChange={next => { if (own !== undefined) onPick(own, next) }} />
      {hideClear === true ? null : (
        <span className="dsh-dot-cap-clear-slot">{hasOwn ? (
          <GrantReset locale={locale} selector={own!} onPick={onPick} />
        ) : null}</span>
      )}
      {applied !== undefined && applied !== effective ? <span className="dsh-dot-cap-badge">{t(locale, 'sCapNext')}</span> : null}
    </span>
  )
}

/** Status-dot tone for one MCP group's connection state. */
function mcpStateTone(state: string | undefined): 'ok' | 'warn' | 'bad' | 'muted' {
  if (state === 'connected') return 'ok'
  if (state === 'connecting' || state === 'reconnecting' || state === 'waiting-credentials') return 'warn'
  if (state === 'failed' || state === 'closed') return 'bad'
  return 'muted'
}

function McpStateDot({ state }: { state?: string }) {
  return <span className={`dsh-dot-mcp-state dsh-dot-mcp-state--${mcpStateTone(state)}`} />
}

/** One-line status text for a dot-local MCP server row. */
function mcpStatusText(locale: CopyLocale, server: DotMcpServerView): string {
  const state = server.status?.state
  if (!server.enabled || state === 'off') return t(locale, 'sMcpStateOff')
  if (state === 'connected') return t(locale, 'sCapToolCount').replace('{n}', String(server.status?.toolCount ?? 0))
  if (state === 'waiting-credentials') return t(locale, 'sMcpStateWaiting')
  if (state === 'failed' || state === 'closed') return `${t(locale, 'sMcpStateFailed')}${server.status?.diagnostic !== undefined ? `: ${server.status.diagnostic}` : ''}`
  return t(locale, 'sMcpStateConnecting')
}

type CapViewState = {
  readonly view: CapabilityCatalogView | undefined
  readonly error: string
}

type McpViewState = {
  readonly view: DotMcpListView | undefined
  readonly error: string
}

function useCapabilityCatalog(api: SettingsApi): CapViewState {
  const [state, setState] = useState<CapViewState>({ view: undefined, error: '' })
  useEffect(() => {
    if (api.capabilities === undefined) return
    const life = new AbortController()
    const load = () => api.capabilities!(life.signal).then(
      next => { setState({ view: next, error: '' }) },
      failure => { if (!life.signal.aborted) setState(prev => ({ ...prev, error: failure instanceof Error ? failure.message : String(failure) })) },
    )
    void load()
    const timer = setInterval(load, 5000)
    return () => { life.abort(); clearInterval(timer) }
  }, [api])
  return state
}

function useMcpList(api: SettingsApi): McpViewState {
  const [state, setState] = useState<McpViewState>({ view: undefined, error: '' })
  useEffect(() => {
    if (api.mcpList === undefined) return
    const life = new AbortController()
    const load = () => api.mcpList!(life.signal).then(
      next => { setState({ view: next, error: '' }) },
      failure => { if (!life.signal.aborted) setState(prev => ({ ...prev, error: failure instanceof Error ? failure.message : String(failure) })) },
    )
    void load()
    const timer = setInterval(load, 5000)
    return () => { life.abort(); clearInterval(timer) }
  }, [api])
  return state
}

export function CapabilitiesMcpPanel({ locale, api, settings, onPick, onSaved }: {
  locale: CopyLocale
  api: SettingsApi
  settings: DotSettings
  onPick: (selector: string, grant: CapabilityGrant | undefined) => void
  onSaved: (next: DotSettings) => void
}) {
  const grants = settings.capabilities?.grants ?? {}
  const cap = useCapabilityCatalog(api)
  const mcp = useMcpList(api)
  const [capFilter, setCapFilter] = useState('')
  const [onlyOn, setOnlyOn] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [tokenFor, setTokenFor] = useState<string>()
  const [tokenDraft, setTokenDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [customToken, setCustomToken] = useState('')
  const [customError, setCustomError] = useState('')
  // Summary clicks record the user's choice against the automatic answer
  // then showing. Search, and any later change to that automatic answer,
  // drop the override. The native toggle event is ignored: mounting
  // <details open> fires one and would lock the first painted state.
  const manual = useRef<Record<string, boolean>>({})
  const manualAuto = useRef<Record<string, boolean>>({})
  const needleSeen = useRef<string | null>(null)
  const [detailsRev, bumpDetails] = useState(0)

  if (api.capabilities === undefined && api.mcpList === undefined) return null
  const capPending = api.capabilities !== undefined && cap.view === undefined && cap.error === ''
  const mcpPending = api.mcpList !== undefined && mcp.view === undefined && mcp.error === ''
  const nothingYet = (capPending || api.capabilities === undefined) && (mcpPending || api.mcpList === undefined)
  if (nothingYet && (capPending || mcpPending)) return <PaneSkeleton label={t(locale, 'settingsLoading')} />

  const capView = cap.view
  const mcpView = mcp.view
  const applied = capView?.applied ?? {}
  const servers = settings.mcpServers ?? {}

  /* ---------- shared grant helpers ---------- */
  const effectiveFor = (chain: readonly string[]): CapabilityGrant => {
    for (const selector of chain) { const grant = grants[selector]; if (grant !== undefined) return grant }
    return 'off'
  }

  /* ---------- server management actions ---------- */
  const fail = (failure: unknown) => setSaveError(failure instanceof Error ? failure.message : String(failure))
  const attemptPatch = async (patch: SettingsPatch): Promise<boolean> => {
    try {
      const saved = await api.setSettings(patch)
      setSaveError('')
      onSaved(saved)
      return true
    } catch (failure) {
      fail(failure)
      return false
    }
  }
  const savePatch = async (patch: SettingsPatch): Promise<boolean> => {
    setBusy(true)
    try { return await attemptPatch(patch) } finally { setBusy(false) }
  }
  const saveServers = (next: Record<string, DotMcpServer>) => savePatch({ mcpServers: next })
  const catalogRow = (entry: DotMcpCatalogEntry): DotMcpServer => ({
    catalog: entry.id, url: entry.url, ...(entry.headers !== undefined ? { headers: entry.headers } : {}), enabled: true,
  })
  const connect = async (entry: DotMcpCatalogEntry, token?: string) => {
    // Row first, token second: credential.set only accepts a stored server
    // name. A failed token write keeps the row, which then offers the
    // waiting-for-token field for a retry.
    setBusy(true)
    try {
      if (!await attemptPatch({ mcpServers: { ...servers, [entry.id]: catalogRow(entry) } })) return
      if (entry.auth === 'token' && token !== undefined && token !== '' && api.mcpCredentialSet !== undefined) {
        await api.mcpCredentialSet(entry.id, token)
      }
      setTokenFor(undefined); setTokenDraft('')
    } catch (failure) { fail(failure) } finally { setBusy(false) }
  }
  const saveToken = async (server: string, value: string) => {
    if (api.mcpCredentialSet === undefined) return
    setBusy(true)
    try {
      await api.mcpCredentialSet(server, value)
      setTokenFor(undefined); setTokenDraft('')
    } catch (failure) { fail(failure) } finally { setBusy(false) }
  }
  const removeServer = (name: string) => {
    const next = { ...servers }
    delete next[name]
    // Dropping a server drops its grants in the same patch: the mcp: selector
    // plus only the tool: selectors longest-prefix attribution gives to it —
    // tools owned by an overlapping name (team vs team__docs) or by nothing
    // keep their selectors.
    const names = Object.keys(servers)
    const cleaned = Object.fromEntries(Object.entries(grants).filter(([selector]) => {
      if (selector === `mcp:${name}`) return false
      if (!selector.startsWith('tool:')) return true
      return mcpServerOf(selector.slice('tool:'.length), names) !== name
    }))
    void savePatch({ mcpServers: next, capabilities: { grants: cleaned } })
  }
  const addCustom = () => {
    const name = customName.trim()
    const url = customUrl.trim()
    if (!MCP_NEW_SERVER_NAME_PATTERN.test(name)) { setCustomError(t(locale, 'sMcpErrName')); return }
    if (name in servers) { setCustomError(t(locale, 'sMcpErrDuplicate')); return }
    if (mcpView?.globals?.includes(name) === true) { setCustomError(t(locale, 'sMcpGlobal')); return }
    if (!isMcpServerUrl(url)) { setCustomError(t(locale, 'sMcpErrUrl')); return }
    setCustomError('')
    const headers = customToken === '' ? undefined : { Authorization: `Bearer \${credential:${mcpCredentialName(name)}}` }
    void (async () => {
      setBusy(true)
      try {
        if (!await attemptPatch({ mcpServers: { ...servers, [name]: { url, ...(headers !== undefined ? { headers } : {}), enabled: true } } })) return
        if (customToken !== '' && api.mcpCredentialSet !== undefined) {
          await api.mcpCredentialSet(name, customToken)
        }
        setCustomName(''); setCustomUrl(''); setCustomToken('')
      } catch (failure) { fail(failure) } finally { setBusy(false) }
    })()
  }

  /* ---------- capability catalog helpers ---------- */
  const capNeedle = capFilter.trim().toLowerCase()
  if (needleSeen.current !== capNeedle) {
    if (needleSeen.current !== null) {
      manual.current = {}
      manualAuto.current = {}
    }
    needleSeen.current = capNeedle
  }
  const matchesTool = (tool: CapabilityToolView) => capNeedle === '' || tool.name.toLowerCase().includes(capNeedle) || (tool.description ?? '').toLowerCase().includes(capNeedle)
  const displayedLabel = (group: CapabilityGroupView): string =>
    group.kind === 'host' ? t(locale, 'sCapHostGroup')
    : group.id === 'builtin' ? t(locale, 'sCapBuiltinGroup')
    : group.id.startsWith('builtin:') ? t(locale, `sCapBuiltin_${group.id.slice('builtin:'.length)}` as TextKey) || group.label
    // `bundle / entry` labels and bare entry ids may carry an npm scope; drop it
    // for display (the full id stays on `title`).
    : group.label.split(' / ').map(part => part.startsWith('@') && part.includes('/') ? part.slice(part.indexOf('/') + 1) : part).join(' / ')
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
  const countsTowardGroup = (tool: CapabilityToolView): boolean => tool.taskOnly !== true && tool.missing !== true
  const kindLabel = (group: CapabilityGroupView): string =>
    group.kind === 'mcp' ? t(locale, 'sCapKind_mcp')
    : group.kind === 'builtin' ? t(locale, 'sCapKind_builtin')
    : group.kind === 'plugin' || group.kind === 'entry' ? t(locale, 'sCapKind_plugin')
    : t(locale, 'sCapKind_unknown')
  /** A group counts as "on" when any tool in it resolves to a grant above off. */
  const groupGranted = (group: CapabilityGroupView, parents: readonly string[] = []): boolean => {
    const chain = group.kind === 'host' || group.id === 'builtin' ? parents : [group.id, ...parents]
    return group.tools.some(tool => tool.taskOnly !== true && effectiveFor([`tool:${tool.name}`, ...chain]) !== 'off')
      || (group.tools.length === 0 && (group.children ?? []).length === 0 && group.kind !== 'host' && group.id !== 'builtin' && effectiveFor(chain) !== 'off')
      || (group.children ?? []).some(child => groupGranted(child, chain))
  }

  /**
   * Details expansion: collapsed by default, opening only while searched or
   * while any grant is in effect; a manual toggle wins once, then reverts to
   * the automatic answer so the view never sticks open.
   */
  const expandDetails = (id: string, auto: boolean): boolean => {
    void detailsRev
    if (capNeedle !== '') return auto
    const picked = manual.current[id]
    if (picked === undefined) return auto
    if (manualAuto.current[id] !== auto) {
      delete manual.current[id]
      delete manualAuto.current[id]
      return auto
    }
    return picked
  }
  const onDetailsClick = (id: string, auto: boolean) => (event: MouseEvent<HTMLElement>) => {
    const target = event.target as { closest?: (selector: string) => unknown } | null
    if (target && typeof target.closest === 'function' && target.closest('button, a, input, textarea, [role="tab"]')) return
    const details = event.currentTarget.parentElement
    if (!details || details.tagName !== 'DETAILS') return
    manual.current[id] = !(details as HTMLDetailsElement).open
    manualAuto.current[id] = auto
    bumpDetails(rev => rev + 1)
  }

  /** Compact collapsed row of one tool inside an expanded group body. */
  const toolRow = (group: CapabilityGroupView, tool: CapabilityToolView, chain: readonly string[]): ReactNode => {
    const toolChain = [`tool:${tool.name}`, ...chain]
    // Only a grantable group with exactly one tool has a picker to stand in for this row.
    // Search that leaves a single visible tool must not hide the tool-level control.
    const soloNoOwnGrant = group.kind !== 'host' && group.id !== 'builtin'
      && group.tools.length === 1 && (group.children ?? []).length === 0
      && grants[`tool:${tool.name}`] === undefined
    const toolPrefix = mcpPrefix(group.label)
    const toolLabel = group.kind === 'mcp' && tool.name.startsWith(toolPrefix) ? tool.name.slice(toolPrefix.length) : tool.name
    return (
      <div key={tool.name} className="dsh-dot-cap-row">
        <span className="dsh-dot-cap-name dsh-dot-cap-tool" title={tool.name}>
          <code>{toolLabel}</code>
          {tool.description !== undefined ? <span className="dsh-dot-cap-desc">{tool.description}</span> : null}
        </span>
        {tool.missing === true ? <span className="dsh-dot-cap-badge">{t(locale, 'sCapMissing')}</span> : null}
        {tool.conditional ? <span className="dsh-dot-cap-badge">{t(locale, 'sCapConditional')}</span> : null}
        {tool.taskOnly === true ? <span className="dsh-dot-cap-badge dsh-dot-cap-badge--warn" title={t(locale, 'sCapTaskOnlyHint')}>{t(locale, 'sCapTaskOnly')}</span> : null}
        {tool.taskOnly === true ? (
          grants[`tool:${tool.name}`] !== undefined ? (
            <span className="dsh-dot-cap-grant">
              <GrantReset locale={locale} selector={`tool:${tool.name}`} onPick={onPick} />
            </span>
          ) : null
        ) : soloNoOwnGrant ? null : (
          <GrantPicker locale={locale} label={tool.name} chain={toolChain} grants={grants} applied={tool.missing === true ? undefined : (applied[tool.name] ?? 'off')} onPick={onPick} />
        )}
      </div>
    )
  }

  /**
   * One capability group as a clean group-level row: name, kind tag, tool
   * count and a group grant control. Individual tools stay collapsed in the
   * expandable body and render as compact wrapping rows.
   */
  const groupRows = (group: CapabilityGroupView, parents: readonly string[], showFull = false): ReactNode => {
    // The host and builtin groups are display-only: their tools grant one by one / via children.
    const chain = group.kind === 'host' || group.id === 'builtin' ? parents : [group.id, ...parents]
    const changed = group.tools.some(tool => countsTowardGroup(tool) && (applied[tool.name] ?? 'off') !== effectiveFor([`tool:${tool.name}`, ...chain]))
    const label = displayedLabel(group)
    const selfHit = showFull || groupSelfHits(group)
    if (capNeedle !== '' && !selfHit && !groupHits(group)) return null
    const tools = selfHit || capNeedle === '' ? group.tools : group.tools.filter(matchesTool)
    const displayGrant = group.kind === 'host' || group.id === 'builtin' ? 'off' : effectiveFor(chain)
    // Host/builtin roots always show their tools: they are display-only and
    // collapsing them would hide the only grant controls those tools have.
    const displayOnly = group.kind === 'host' || group.id === 'builtin'
    const autoOpen = displayOnly || capNeedle !== ''
    const open = expandDetails(`group:${group.id}`, autoOpen)
    return (
      <details key={group.id} className="dsh-dot-cap-group" data-grant={displayGrant === 'off' ? 'off' : undefined} open={open}>
        <summary className="dsh-dot-cap-head" onClick={onDetailsClick(`group:${group.id}`, autoOpen)}>
          <IconChevronRightOutlineRegular size={12} className="dsh-dot-cap-chev" />
          <span className="dsh-dot-cap-name" title={group.id}>
            {group.kind === 'mcp' && group.status !== undefined ? <McpStateDot state={group.status.state} /> : null}
            {label}{group.kind === 'builtin' && group.id !== 'builtin' ? null : <span className="dsh-dot-cap-tag">{kindLabel(group)}</span>}
            {group.scope === 'dot' ? <span className="dsh-dot-cap-tag dsh-dot-cap-tag--dot">{t(locale, 'sCapDotOnly')}</span> : null}
            <span className="dsh-dot-cap-count">{t(locale, 'sCapToolCount').replace('{n}', String(countTools(group)))}</span>
          </span>
          {group.missing === true ? <span className="dsh-dot-cap-badge">{t(locale, 'sCapMissing')}</span> : null}
          {changed ? <span className="dsh-dot-cap-badge">{t(locale, 'sCapNext')}</span> : null}
          {group.kind === 'host' || group.id === 'builtin' ? null : groupAllTaskOnly(group) ? (
            grants[group.id] !== undefined ? (
              <span className="dsh-dot-cap-control" onClick={event => event.preventDefault()}>
                <span className="dsh-dot-cap-grant">
                  <GrantReset locale={locale} selector={group.id} onPick={onPick} />
                </span>
              </span>
            ) : null
          ) : (
            <span className="dsh-dot-cap-control" onClick={event => event.preventDefault()}>
              <GrantPicker locale={locale} label={label} chain={chain} grants={grants} applied={undefined} onPick={onPick} />
            </span>
          )}
        </summary>
        <div className="dsh-dot-cap-body">
          {tools.map(tool => toolRow(group, tool, chain))}
          {(group.children ?? []).map(child => groupRows(child, chain, selfHit))}
        </div>
      </details>
    )
  }

  /* ---------- server rows: status + credentials + grants in one card ---------- */
  const tokenField = (server: string, tokenUrl?: string, tokenHelpKey?: string) => (
    <div className="dsh-dot-mcp-token">
      <Input
        type="password"
        placeholder={t(locale, 'sMcpTokenPlaceholder')}
        value={tokenDraft}
        onChange={event => setTokenDraft(event.target.value)}
      />
      <Button variant="primary" size="sm" disabled={busy || tokenDraft.trim() === ''} onClick={() => void saveToken(server, tokenDraft.trim())}>{t(locale, 'sMcpTokenSave')}</Button>
      {tokenUrl !== undefined ? <a className="dsh-dot-mcp-token-link" href={tokenUrl} target="_blank" rel="noreferrer">{t(locale, 'sMcpTokenLink')}</a> : null}
      {tokenHelpKey !== undefined ? <span className="dsh-dot-mcp-token-help">{t(locale, tokenHelpKey as TextKey)}</span> : null}
    </div>
  )
  const connectField = (entry: DotMcpCatalogEntry) => (
    <div className="dsh-dot-mcp-token">
      <Input
        type="password"
        placeholder={t(locale, 'sMcpTokenPlaceholder')}
        value={tokenDraft}
        onChange={event => setTokenDraft(event.target.value)}
      />
      <Button variant="primary" size="sm" disabled={busy} title={tokenDraft.trim() === '' ? t(locale, 'sMcpConnectNoToken') : undefined} onClick={() => void connect(entry, tokenDraft.trim())}>{t(locale, 'sMcpConnect')}</Button>
      {entry.tokenUrl !== undefined ? <a className="dsh-dot-mcp-token-link" href={entry.tokenUrl} target="_blank" rel="noreferrer">{t(locale, 'sMcpTokenLink')}</a> : null}
      {entry.tokenHelp !== undefined ? <span className="dsh-dot-mcp-token-help">{t(locale, entry.tokenHelp as TextKey)}</span> : null}
    </div>
  )

  /** The capability catalog group matching one connected server, when the host reports one. */
  const groupForServer = (name: string): CapabilityGroupView | undefined =>
    capView?.groups.find(group => group.kind === 'mcp' && group.id === `mcp:${name}`)

  /**
   * One connected server as a single card: state, name, status, actions
   * (enable/disable, replace token, remove) and its group grant control,
   * with the server's own tools collapsed underneath. Removing a server is a
   * destructive action kept away from the grant control; resetting a grant
   * override is the explicit "Reset to inherited" text button.
   */
  const serverRow = (server: DotMcpServerView): ReactNode => {
    const group = groupForServer(server.name)
    const needsToken = server.auth === 'token' && server.credential?.configured !== true
    const groupChain = [`mcp:${server.name}`]
    const serverTools = group?.tools ?? []
    const autoOpen = capNeedle !== '' || needsToken
    const open = expandDetails(`server:${server.name}`, autoOpen)
    const body = (
      <>
        <div className="dsh-dot-mcp-grant">
          <GrantPicker locale={locale} label={server.name} chain={groupChain} grants={grants} applied={undefined} hideClear={serverTools.length === 0} onPick={onPick} />
        </div>
        {serverTools.length > 0 ? (
          <div className="dsh-dot-mcp-tools">
            {serverTools.map(tool => {
              const baseGroup: CapabilityGroupView = group ?? { id: `mcp:${server.name}`, kind: 'mcp', label: server.name, tools: [] }
              return toolRow(baseGroup, tool, groupChain)
            })}
          </div>
        ) : null}
        {needsToken ? tokenField(server.name, server.tokenUrl, server.catalog === 'github' ? 'sMcpTokenHelp_github' : undefined) : null}
        {tokenFor === server.name && !needsToken ? tokenField(server.name, server.tokenUrl) : null}
      </>
    )
    if (serverTools.length === 0) {
      return (
        <div key={server.name} className="dsh-dot-mcp-row">
          <div className="dsh-dot-mcp-line">
            <McpStateDot state={server.status?.state ?? (server.enabled ? 'connecting' : 'off')} />
            <span className="dsh-dot-mcp-name" title={server.name}>{server.name}</span>
            <span className="dsh-dot-mcp-status" title={server.status?.diagnostic}>{mcpStatusText(locale, server)}</span>
            <span className="dsh-dot-mcp-actions">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void saveServers({ ...servers, [server.name]: { ...servers[server.name]!, enabled: !server.enabled } })}>
                {server.enabled ? t(locale, 'sMcpDisable') : t(locale, 'sMcpEnable')}
              </Button>
              {server.auth === 'token' ? (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setTokenFor(tokenFor === server.name ? undefined : server.name); setTokenDraft('') }}>
                  {t(locale, 'sMcpRetoken')}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" className="dsh-dot-mcp-remove" disabled={busy} onClick={() => removeServer(server.name)}>{t(locale, 'sMcpRemove')}</Button>
            </span>
          </div>
          {body}
        </div>
      )
    }
    return (
      <details key={server.name} className="dsh-dot-mcp-row dsh-dot-mcp-server" open={open}>
        <summary className="dsh-dot-mcp-summary" onClick={onDetailsClick(`server:${server.name}`, autoOpen)}>
          <IconChevronRightOutlineRegular size={12} className="dsh-dot-cap-chev" />
          <div className="dsh-dot-mcp-line">
            <McpStateDot state={server.status?.state ?? (server.enabled ? 'connecting' : 'off')} />
            <span className="dsh-dot-mcp-name" title={server.name}>{server.name}</span>
            <span className="dsh-dot-mcp-status" title={server.status?.diagnostic}>{mcpStatusText(locale, server)}</span>
            <span className="dsh-dot-mcp-actions" onClick={event => event.preventDefault()}>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void saveServers({ ...servers, [server.name]: { ...servers[server.name]!, enabled: !server.enabled } })}>
                {server.enabled ? t(locale, 'sMcpDisable') : t(locale, 'sMcpEnable')}
              </Button>
              {server.auth === 'token' ? (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setTokenFor(tokenFor === server.name ? undefined : server.name); setTokenDraft('') }}>
                  {t(locale, 'sMcpRetoken')}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" className="dsh-dot-mcp-remove" disabled={busy} onClick={() => removeServer(server.name)}>{t(locale, 'sMcpRemove')}</Button>
            </span>
          </div>
        </summary>
        {body}
      </details>
    )
  }

  /* ---------- assembly ---------- */
  const mcpServers = mcpView?.servers ?? []
  const catalog = mcpView?.catalog ?? []
  // Servers already configured locally connect through their card instead of the catalog.
  const catalogVisible = catalog.filter(entry => !(entry.id in servers))
  const sectionOf = (group: CapabilityGroupView): 'mcp' | 'plugin' | 'host' =>
    group.kind === 'mcp' ? 'mcp' : group.kind === 'plugin' || group.kind === 'entry' ? 'plugin' : 'host'
  // Dot-local MCP servers are managed through their own cards; the capability
  // section renders them only when there is no management half to own them.
  const managedNames = new Set(mcpServers.map(server => server.name))
  const allGroups = capView?.groups ?? []
  const catalogGroups = api.mcpList !== undefined
    ? allGroups.filter(group => !(group.kind === 'mcp' && managedNames.has(group.id.slice('mcp:'.length))))
    : allGroups
  const shownGroups = catalogGroups.filter(group => (capNeedle === '' || groupHits(group)) && (!onlyOn || groupGranted(group)))

  const mcpHalf = api.mcpList === undefined ? null : (
    <div className="dsh-dot-mcp">
      {mcp.error ? <div className="dsh-ui-error" role="alert">{mcp.error}</div> : null}
      {saveError !== '' ? (
        <div className="dsh-ui-error" role="alert">
          {saveError}
          <Button variant="ghost" size="sm" aria-label={t(locale, 'dismissError')} title={t(locale, 'dismissError')} onClick={() => setSaveError('')}><IconCloseOutlineRegular size={12} /></Button>
        </div>
      ) : null}
      {mcpView === undefined ? null : (
        <>
          {mcpServers.length > 0 ? <div className="dsh-dot-cap-section">{t(locale, 'sMcpConnected')}</div> : null}
          {mcpServers.map(serverRow)}
          {catalogVisible.length > 0 ? <div className="dsh-dot-cap-section">{t(locale, 'sMcpRecommended')}</div> : null}
          {catalogVisible.map(entry => {
            const global = mcpView.globals?.includes(entry.id) === true
            return (
              <div key={entry.id} className="dsh-dot-mcp-row">
                <div className="dsh-dot-mcp-line">
                  <span className="dsh-dot-mcp-name">{entry.name}</span>
                  <span className="dsh-dot-mcp-about">{t(locale, entry.about as TextKey)}</span>
                  <span className="dsh-dot-mcp-actions">
                    {global ? null : entry.auth === 'none' ? (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void connect(entry)}>{t(locale, 'sMcpConnect')}</Button>
                    ) : (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setTokenFor(tokenFor === entry.id ? undefined : entry.id); setTokenDraft('') }}>{t(locale, 'sMcpConnect')}</Button>
                    )}
                  </span>
                </div>
                {global ? <div className="dsh-dot-mcp-global"><span className="dsh-dot-cap-badge">{t(locale, 'sMcpGlobal')}</span><span className="dsh-dot-mcp-token-help">{t(locale, 'sMcpGlobalHint')}</span></div> : null}
                {!global && tokenFor === entry.id ? connectField(entry) : null}
              </div>
            )
          })}
          <details className="dsh-dot-mcp-custom">
            <summary>{t(locale, 'sMcpCustom')}</summary>
            <div className="dsh-dot-mcp-custom-body">
              <Input placeholder={t(locale, 'sMcpNamePlaceholder')} value={customName} onChange={event => setCustomName(event.target.value)} />
              <Input placeholder={t(locale, 'sMcpUrlPlaceholder')} value={customUrl} onChange={event => setCustomUrl(event.target.value)} />
              <Input type="password" placeholder={t(locale, 'sMcpTokenOptional')} value={customToken} onChange={event => setCustomToken(event.target.value)} />
              {customError !== '' ? <div className="dsh-ui-error" role="alert">{customError}</div> : null}
              <Button variant="primary" size="sm" disabled={busy} onClick={addCustom}>{t(locale, 'sMcpAdd')}</Button>
            </div>
          </details>
          {mcpServers.length === 0 && catalog.length === 0 ? <div className="dsh-dot-model-empty">{t(locale, 'sMcpEmpty')}</div> : null}
        </>
      )}
    </div>
  )

  const capHalf = api.capabilities === undefined ? null : (
    <div className="dsh-dot-caps">
      <div className="dsh-dot-cap-section dsh-dot-cap-section--main">{t(locale, 'sCapGrants')}</div>
      <div className="dsh-dot-cap-toolbar">
        <Input
          className="dsh-dot-cap-search"
          icon={<IconSearchOutlineRegular size={13} />}
          type="search"
          aria-label={t(locale, 'sCapFilter')}
          placeholder={t(locale, 'sCapFilter')}
          value={capFilter}
          onChange={event => setCapFilter(event.target.value)}
        />
        <Checkbox checked={onlyOn} label={t(locale, 'sCapOnlyOn')} onChange={next => setOnlyOn(next)} />
      </div>
      {cap.error ? <div className="dsh-ui-error" role="alert">{cap.error}</div> : null}
      {capView === undefined ? null : (
        <>
          {capView.groups.length === 0 ? <div className="dsh-dot-model-empty">{t(locale, 'sCapEmpty')}</div> : null}
          {(['mcp', 'plugin', 'host'] as const).map(section => {
            const rows = shownGroups.filter(group => sectionOf(group) === section)
            if (rows.length === 0) return null
            return (
              <div key={section} className="dsh-dot-cap-section-wrap">
                <div className="dsh-dot-cap-section">{t(locale, `sCapSec_${section}` as TextKey)}</div>
                {rows.map(group => groupRows(group, []))}
              </div>
            )
          })}
          <details className="dsh-dot-cap-group dsh-dot-cap-group--locked">
            <summary className="dsh-dot-cap-head">
              <span className="dsh-dot-cap-name">{t(locale, 'sCapLockedTitle')}<span className="dsh-dot-cap-count">{t(locale, 'sCapToolCount').replace('{n}', String(capView.locked.length))}</span></span>
              <span className="dsh-dot-cap-badge dsh-dot-cap-badge--on">{t(locale, 'sCapAlways')}</span>
            </summary>
            <div className="dsh-dot-cap-body dsh-dot-cap-locked">{capView.locked.map(name => <span key={name} className="dsh-dot-cap-locked-name">{name}</span>)}</div>
          </details>
        </>
      )}
    </div>
  )

  return (
    <div className="dsh-dot-capmcp">
      <p className="dsh-dot-cap-intro">{t(locale, 'sCapIntro')}</p>
      {mcpHalf}
      {capHalf}
    </div>
  )
}
