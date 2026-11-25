/**
 * Dorothy's persona page in the settings view: how she addresses you, who she
 * is, and the two blocks her prompt carries — the agreements you set and her
 * own cognition. Each part can be edited; changes apply from her next step.
 */
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CognitionEntry, DotSettings, KnowledgeEdit, KnowledgeView, SettingField } from './contracts.ts'
import { ADDRESS_MAX_CHARS, PERSONA_MAX_CHARS, defaultAddress, defaultPersona } from './persona.ts'
import { HelpTip, LockToggle, PaneSkeleton, Subgroup, type SaveNotice, type SettingsApi, type SettingsPatch } from './settings-panel.tsx'
import { formatWhen, t, type CopyLocale } from './ui-copy.ts'

export interface KnowledgeApi {
  knowledge(signal: AbortSignal): Promise<KnowledgeView>
  editAgreements(edit: KnowledgeEdit): Promise<KnowledgeView>
  undoAgreements(): Promise<KnowledgeView>
  editCognition(edit: KnowledgeEdit): Promise<KnowledgeView>
  /** The `at` of the version to return to; taken from a history entry. */
  restoreCognition(at: number): Promise<KnowledgeView>
}

/** One knowledge entry: text, inline edit and delete; cognition rows also carry pin state and a dormant tag. */
function EntryRow({
  locale,
  entry,
  dormant,
  canPin,
  editing,
  busy,
  onStartEdit,
  onDoneEdit,
  onEdit,
  onRemove,
  onPin,
}: {
  locale: CopyLocale
  entry: { readonly id: string; readonly text: string; readonly pinned?: true }
  dormant?: boolean
  canPin?: boolean
  editing: boolean
  busy?: boolean
  onStartEdit: () => void
  onDoneEdit: () => void
  onEdit: (id: string, text: string) => Promise<boolean>
  onRemove: (id: string) => void
  onPin?: (id: string, pinned: boolean) => void
}) {
  const [draft, setDraft] = useState(entry.text)
  useEffect(() => { if (editing) setDraft(entry.text) }, [editing, entry.text])
  if (editing) {
    return (
      <div className="dsh-dot-entry">
        <textarea
          className="dsh-ui-textarea dsh-dot-entry-editor"
          aria-label={t(locale, 'pEntryEdit')}
          rows={2}
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
        <div className="dsh-ui-actions">
          <Button variant="primary" size="sm" disabled={busy || !draft.trim() || draft.trim() === entry.text}
            onClick={() => { void onEdit(entry.id, draft.trim()).then(saved => { if (saved) onDoneEdit() }) }}>
            {t(locale, 'pSave')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDoneEdit}>{t(locale, 'pDiscard')}</Button>
        </div>
      </div>
    )
  }
  return (
    <div className="dsh-dot-entry" {...dormant ? { 'data-dormant': '' } : {}}>
      <div className="dsh-dot-entry-row">
        <span className="dsh-dot-entry-text">{entry.text}</span>
        {entry.pinned === true ? <Tag tone="quiet">{t(locale, 'pPinned')}</Tag> : null}
        {dormant ? <Tag tone="quiet">{t(locale, 'pDormant')}</Tag> : null}
        <span className="dsh-dot-entry-tools">
          {canPin && onPin
            ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => onPin(entry.id, entry.pinned !== true)}>{entry.pinned === true ? t(locale, 'pUnpin') : t(locale, 'pPin')}</Button>
            : null}
          <Button variant="ghost" size="sm" disabled={busy} onClick={onStartEdit}>{t(locale, 'pEntryEdit')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRemove(entry.id)}>{t(locale, 'pEntryDelete')}</Button>
        </span>
      </div>
    </div>
  )
}

/** One knowledge list with an add input at the bottom; drafts keep the drawer dirty until saved or discarded. */
function EntryList({
  locale,
  entries,
  placeholder,
  empty,
  dormantHint,
  canPin,
  busy,
  discardSignal,
  onChanged,
  onEdit,
}: {
  locale: CopyLocale
  entries: readonly { readonly id: string; readonly text: string; readonly pinned?: true; readonly active?: boolean }[]
  placeholder: string
  empty: string
  dormantHint?: string
  canPin?: boolean
  busy?: boolean
  discardSignal?: number
  onChanged?: (changed: boolean) => void
  onEdit: (edit: KnowledgeEdit) => Promise<boolean>
}) {
  const [addDraft, setAddDraft] = useState('')
  const [editingId, setEditingId] = useState<string>()
  useEffect(() => { setAddDraft(''); setEditingId(undefined) }, [discardSignal])
  // A save may drop the row under edit (a proposal reload, an undo); the draft is stale then.
  useEffect(() => { if (editingId !== undefined && !entries.some(entry => entry.id === editingId)) setEditingId(undefined) }, [entries, editingId])
  const dirty = addDraft.trim() !== '' || editingId !== undefined
  useEffect(() => { onChanged?.(dirty) }, [dirty, onChanged])
  useEffect(() => () => { onChanged?.(false) }, [onChanged])
  const submit = () => {
    const text = addDraft.trim()
    if (!text) return
    void onEdit({ op: 'add', text }).then(saved => { if (saved) setAddDraft('') })
  }
  const hasDormant = entries.some(entry => entry.active === false)
  return (
    <>
      {entries.length === 0 ? <span className="dsh-ui-help">{empty}</span> : (
        <div className="dsh-dot-entries">
          {entries.map(entry => (
            <EntryRow
              key={entry.id}
              locale={locale}
              entry={entry}
              dormant={entry.active === false}
              canPin={canPin}
              editing={editingId === entry.id}
              busy={busy}
              onStartEdit={() => setEditingId(entry.id)}
              onDoneEdit={() => setEditingId(undefined)}
              onEdit={(id, text) => onEdit({ op: 'edit', id, text })}
              onRemove={id => void onEdit({ op: 'remove', id })}
              {...canPin ? { onPin: (id, pinned) => void onEdit({ op: 'pin', id, pinned }) } : {}}
            />
          ))}
        </div>
      )}
      {hasDormant && dormantHint ? <span className="dsh-ui-help">{dormantHint}</span> : null}
      <div className="dsh-dot-entry-add">
        <Input
          aria-label={t(locale, 'pEntryAdd')}
          placeholder={placeholder}
          value={addDraft}
          onChange={event => setAddDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) submit() }}
        />
        <Button variant="outline" size="sm" disabled={busy || !addDraft.trim()} onClick={submit}>{t(locale, 'pEntryAdd')}</Button>
      </div>
    </>
  )
}

/** The earlier versions of Dorothy's cognition, newest first, each restorable. */
function CognitionHistory({ locale, knowledge, busy, onRestore }: {
  locale: CopyLocale
  knowledge: KnowledgeView
  busy?: boolean
  onRestore: (at: number) => void
}) {
  const history = knowledge.cognition.history
  if (history.length === 0) return <span className="dsh-ui-help">{t(locale, 'pCognitionHistoryEmpty')}</span>
  return (
    <div className="dsh-dot-versions">
      {history.map((version, index) => (
        <div className="dsh-dot-version" key={`${version.at}:${index}`}>
          <div className="dsh-dot-version-head">
            <span className="dsh-dot-version-time">
              {t(locale, 'pCognitionVersionAt').replace('{time}', formatWhen(version.at))}
            </span>
            <span className="dsh-dot-spacer" />
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onRestore(version.at)}>
              {t(locale, 'pCognitionRestore')}
            </Button>
          </div>
          <p className="dsh-dot-version-text">
            {version.entries.length > 0 ? version.entries.map((entry: CognitionEntry) => `- ${entry.text}`).join('\n') : t(locale, 'ctxSectionEmpty')}
          </p>
        </div>
      ))}
    </div>
  )
}

/**
 * Dorothy's knowledge: the agreements you set and her own cognition. The
 * agreements keep one step of undo; the cognition keeps its last versions.
 */
function KnowledgeSection({ locale, api, onStatus, locked, onLock, discardSignal, onDirtyChange }: {
  locale: CopyLocale
  api: KnowledgeApi
  onStatus: (status: SaveNotice | undefined) => void
  locked: boolean
  onLock: (field: SettingField, locked: boolean) => void
  discardSignal?: number
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [knowledge, setKnowledge] = useState<KnowledgeView>()
  const [failed, setFailed] = useState<string>()
  const [agreementsDirty, setAgreementsDirty] = useState(false)
  const [cognitionDirty, setCognitionDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  useEffect(() => { onDirtyChange?.(agreementsDirty || cognitionDirty) }, [agreementsDirty, cognitionDirty, onDirtyChange])
  useEffect(() => () => { onDirtyChange?.(false) }, [onDirtyChange])
  useEffect(() => {
    const lifetime = new AbortController()
    api.knowledge(lifetime.signal).then(
      next => { if (!lifetime.signal.aborted) { setKnowledge(next); setFailed(undefined) } },
      failure => { if (!lifetime.signal.aborted) setFailed(failure instanceof Error ? failure.message : String(failure)) },
    )
    return () => lifetime.abort()
  }, [api])
  const run = (work: () => Promise<KnowledgeView>): Promise<boolean> => {
    if (busyRef.current) return Promise.resolve(false)
    busyRef.current = true
    setBusy(true)
    onStatus(undefined)
    return work().then(
      next => { setKnowledge(next); setFailed(undefined); onStatus({ kind: 'saved' }); return true },
      failure => { onStatus({ kind: 'error', message: failure instanceof Error ? failure.message : String(failure) }); return false },
    ).finally(() => { busyRef.current = false; setBusy(false) })
  }
  if (knowledge === undefined) {
    return (
      <div className="dsh-dot-pane-section">
        <div className="dsh-ui-form">
          <div className="dsh-ui-field">
            <span className={failed === undefined ? 'dsh-ui-help' : 'dsh-ui-error'}>
              {failed === undefined ? t(locale, 'pKnowledgeLoading') : t(locale, 'pKnowledgeFailed') + failed}
            </span>
          </div>
        </div>
      </div>
    )
  }
  const agreements = knowledge.agreements
  const cognition = knowledge.cognition
  return (
    <>
      <div className="dsh-dot-pane-section">
        <div className="dsh-ui-form">
          <div className="dsh-ui-field">
            <div className="dsh-dot-setting-head">
              <span className="dsh-ui-label">
                <span>{t(locale, 'pAgreements')}</span>
                <HelpTip locale={locale} fieldLabel={t(locale, 'pAgreements')} text={t(locale, 'pAgreementsHint')} />
              </span>
              <div className="dsh-dot-setting-tools">
                {agreements.canUndo ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => api.undoAgreements())}>{t(locale, 'pAgreementsUndo')}</Button> : null}
                <LockToggle locale={locale} label={t(locale, 'pAgreements')} locked={locked} onLock={next => onLock('agreements', next)} />
              </div>
            </div>
            <EntryList
              locale={locale}
              entries={agreements.entries}
              placeholder={t(locale, 'pAgreementsPlaceholder')}
              empty={t(locale, 'pAgreementsEmpty')}
              busy={busy}
              {...discardSignal === undefined ? {} : { discardSignal }}
              onChanged={setAgreementsDirty}
              onEdit={edit => run(() => api.editAgreements(edit))}
            />
          </div>
        </div>
      </div>
      <div className="dsh-dot-pane-section">
        <div className="dsh-ui-form">
          <div className="dsh-ui-field">
            <div className="dsh-dot-setting-head">
              <span className="dsh-ui-label">
                <span>{t(locale, 'pCognition')}</span>
                <HelpTip locale={locale} fieldLabel={t(locale, 'pCognition')} text={t(locale, 'pCognitionHint')} />
              </span>
            </div>
            <EntryList
              locale={locale}
              entries={cognition.entries}
              placeholder={t(locale, 'pCognitionPlaceholder')}
              empty={t(locale, 'pCognitionEmpty')}
              dormantHint={t(locale, 'pDormantHint')}
              canPin
              busy={busy}
              {...discardSignal === undefined ? {} : { discardSignal }}
              onChanged={setCognitionDirty}
              onEdit={edit => run(() => api.editCognition(edit))}
            />
            <div className="dsh-dot-setting-head dsh-dot-versions-head">
              <span className="dsh-ui-label">{t(locale, 'pCognitionHistory')}</span>
            </div>
            <CognitionHistory locale={locale} knowledge={knowledge} busy={busy} onRestore={at => run(() => api.restoreCognition(at))} />
          </div>
        </div>
      </div>
    </>
  )
}

export function PersonaPanel({ locale, api, settings, onSaved, onStatusChange, discardSignal, onDirtyChange }: {
  locale: CopyLocale
  api: SettingsApi & KnowledgeApi
  settings?: DotSettings
  onSaved: (next: DotSettings) => void
  onStatusChange?: (status: SaveNotice | undefined) => void
  discardSignal?: number
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [status, setStatus] = useState<SaveNotice>()
  const [knowledgeDirty, setKnowledgeDirty] = useState(false)
  const defaultAddr = defaultAddress(locale)
  const defaultPers = defaultPersona(locale)
  const savedAddress = settings?.address ?? defaultAddr
  const savedPersona = settings?.persona ?? defaultPers
  const [address, setAddress] = useState(savedAddress)
  const [persona, setPersona] = useState(savedPersona)
  // The address field commits on blur. Once that save is submitted, the drawer
  // guard must not treat the same text as an unsaved draft: blur runs before the
  // click that leaves the page, and Discard cannot undo a save already in flight.
  const [addressSubmitted, setAddressSubmitted] = useState<string | undefined>()
  useEffect(() => { setAddress(savedAddress) }, [savedAddress, discardSignal])
  useEffect(() => { setPersona(savedPersona) }, [savedPersona, discardSignal])
  useEffect(() => { setAddressSubmitted(undefined) }, [discardSignal])
  const addressDirty = Boolean(settings) && address.trim() !== '' && address.trim() !== savedAddress && address.trim() !== addressSubmitted
  const personaDirty = Boolean(settings) && persona !== savedPersona
  const anyDirty = addressDirty || personaDirty || knowledgeDirty
  useEffect(() => { onDirtyChange?.(anyDirty) }, [anyDirty, onDirtyChange])
  useEffect(() => () => { onDirtyChange?.(false) }, [onDirtyChange])
  const reportStatus = useCallback((next: SaveNotice | undefined) => {
    setStatus(next)
    onStatusChange?.(next)
  }, [onStatusChange])

  const save = (patch: SettingsPatch, onError?: () => void) => {
    reportStatus(undefined)
    api.setSettings(patch).then(
      next => { onSaved(next); reportStatus({ kind: 'saved' }) },
      failure => {
        onError?.()
        reportStatus({ kind: 'error', message: failure instanceof Error ? failure.message : String(failure) })
      },
    )
  }
  const commitAddress = () => {
    const text = address.trim()
    if (!text) { setAddress(savedAddress); setAddressSubmitted(undefined); return }
    if (text === savedAddress) return
    setAddressSubmitted(text)
    save({ address: text }, () => setAddressSubmitted(current => current === text ? undefined : current))
  }

  if (!settings) return <PaneSkeleton label={t(locale, 'settingsLoading')} rows={3} />
  const personaChanged = persona !== savedPersona
  const personaCustom = settings.persona !== undefined
  const addressCustom = settings.address !== undefined
  const onLock = (field: SettingField, locked: boolean) => save({ locks: { ...settings.locks, [field]: locked } })

  return (
    <div className="dsh-dot-pane dsh-dot-settings-pane">
      {!onStatusChange && status?.kind === 'saved' ? <div className="dsh-ui-notice" role="status">{t(locale, 'saved')}</div> : null}
      {!onStatusChange && status?.kind === 'error' ? <div className="dsh-ui-error" role="alert">{t(locale, 'saveFailed')}{status.message}</div> : null}
      <div className="dsh-dot-pane-section">
        <div className="dsh-dot-subgroups">
        <Subgroup label={t(locale, 'sGroupVoice')}>
        <div className="dsh-ui-field">
          <div className="dsh-dot-setting-head">
            <span className="dsh-ui-label">{t(locale, 'pAddress')}</span>
            <div className="dsh-dot-setting-tools">
              <LockToggle locale={locale} label={t(locale, 'pAddress')} locked={settings.locks?.address === true} onLock={next => onLock('address', next)} />
            </div>
          </div>
          <div className="dsh-dot-persona-row">
            <Input aria-label={t(locale, 'pAddress')} maxLength={ADDRESS_MAX_CHARS} placeholder={defaultAddr} value={address}
              onChange={event => setAddress(event.target.value)} onBlur={commitAddress}
              onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) commitAddress() }} />
            <Button variant="ghost" size="sm" disabled={!addressCustom} onClick={() => save({ address: null })}>{t(locale, 'pRestore')}</Button>
          </div>
        </div>
        <div className="dsh-ui-field">
          <div className="dsh-dot-setting-head">
            <span className="dsh-ui-label">
              {t(locale, 'pPersona')}
              {personaCustom ? <Tag tone="quiet">{t(locale, 'pCustom')}</Tag> : null}
            </span>
            <div className="dsh-dot-setting-tools">
              <span className="dsh-ui-hint">{t(locale, 'pCharCount').replace('{n}', String(persona.length)).replace('{max}', String(PERSONA_MAX_CHARS))}</span>
              <LockToggle locale={locale} label={t(locale, 'pPersona')} locked={settings.locks?.persona === true} onLock={next => onLock('persona', next)} />
            </div>
          </div>
          <textarea className="dsh-ui-textarea dsh-dot-persona-text" aria-label={t(locale, 'pPersona')} rows={9} maxLength={PERSONA_MAX_CHARS}
            value={persona} onChange={event => setPersona(event.target.value)} />
          <div className="dsh-ui-actions">
            <Button variant="primary" size="sm" disabled={!personaChanged} onClick={() => save({ persona })}>{t(locale, 'pSave')}</Button>
            <Button variant="ghost" size="sm" disabled={!personaChanged} onClick={() => setPersona(savedPersona)}>{t(locale, 'pDiscard')}</Button>
            <span className="dsh-ui-spacer" />
            <Button variant="outline" size="sm" disabled={!personaCustom && !personaChanged} onClick={() => { setPersona(defaultPers); save({ persona: null }) }}>{t(locale, 'pRestore')}</Button>
          </div>
        </div>
        </Subgroup>
        </div>
      </div>
      <KnowledgeSection locale={locale} api={api} onStatus={reportStatus} locked={settings.locks?.agreements === true} onLock={onLock} {...discardSignal === undefined ? {} : { discardSignal }} onDirtyChange={setKnowledgeDirty} />
      <p className="dsh-ui-hint dsh-dot-settings-note">{t(locale, 'pNote')}</p>
    </div>
  )
}

// Selectors spell the root out (.dsh-dot-chat = CHAT_ROOT) so the repository scope check can read them.
export const personaCss = `
.dsh-dot-chat .dsh-dot-persona-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dsh-dot-chat .dsh-dot-persona-row > :first-child { flex: 1 1 160px; min-width: 0; max-width: 340px; }
.dsh-dot-chat .dsh-dot-persona-row > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-persona-text { min-height: 180px; font-family: inherit; font-size: 13px; line-height: 1.6; }
.dsh-dot-chat .dsh-dot-entries { display: flex; flex-direction: column; gap: 6px; }
.dsh-dot-chat .dsh-dot-entry { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke); }
.dsh-dot-chat .dsh-dot-entry-row { display: flex; align-items: flex-start; gap: 8px; }
.dsh-dot-chat .dsh-dot-entry-text { flex: 1 1 auto; min-width: 0; font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-dot-chat .dsh-dot-entry[data-dormant] .dsh-dot-entry-text { color: var(--dsw-alias-label-tertiary); }
.dsh-dot-chat .dsh-dot-entry-tools { display: flex; flex: none; align-items: center; gap: 4px; }
.dsh-dot-chat .dsh-dot-entry-editor { min-height: 44px; font-family: inherit; font-size: 13px; line-height: 1.6; }
.dsh-dot-chat .dsh-dot-entry-add { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.dsh-dot-chat .dsh-dot-entry-add > :first-child { flex: 1 1 auto; min-width: 0; }
.dsh-dot-chat .dsh-dot-versions-head { margin-top: 14px; }
.dsh-dot-chat .dsh-dot-versions { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.dsh-dot-chat .dsh-dot-version { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-stroke); }
.dsh-dot-chat .dsh-dot-version-head { display: flex; align-items: center; gap: 8px; }
.dsh-dot-chat .dsh-dot-version-head > button { flex-shrink: 0; white-space: nowrap; }
.dsh-dot-chat .dsh-dot-version-time { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dsh-dot-chat .dsh-dot-version-text { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 5.4em; overflow-y: auto; }
`
