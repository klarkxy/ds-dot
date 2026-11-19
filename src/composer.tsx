/**
 * The message composer below the chat log: per-session draft persistence, image
 * attachments, the slash-command menu and quick actions. The glyph exports are
 * shared with the panel header, rows and the task drawer.
 */
import { IconCheckOutlineRegular, IconCloseOutlineRegular, IconWarningOutlineRegular, Tooltip, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MutableRefObject } from 'react'
import type { ChatItem } from './contracts.ts'
import { CHAT_IMAGE_LIMIT, ChatImageRejected, imageName, inspectImageBytes, type ChatImage, type ChatImageError } from './chat-images.ts'
import { t, type CopyLocale } from './ui-copy.ts'

function imageErrorText(locale: CopyLocale, code: ChatImageError): string {
  switch (code) {
    case 'unsupported': return t(locale, 'imageUnsupported')
    case 'too-large': return t(locale, 'imageTooLarge')
    case 'too-many': return t(locale, 'imageTooMany')
    case 'mismatch': return t(locale, 'imageMismatch')
    default: return t(locale, 'imageInvalid')
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

async function readImageFile(file: File): Promise<ChatImage> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const inspected = inspectImageBytes(bytes, file.type)
  if (!inspected.ok) throw new ChatImageRejected(inspected.error)
  const name = imageName(file.name)
  return { mediaType: inspected.mediaType, data: bytesToBase64(bytes), ...(name ? { name } : {}) }
}

const COMPOSER_TEXT_LIMIT = 20_000
const DRAFT_KEY_PREFIX = 'dsh-dot:draft:'

function readDraft(sessionId: string): string {
  if (!sessionId) return ''
  try { return globalThis.localStorage?.getItem(DRAFT_KEY_PREFIX + sessionId) ?? '' } catch { return '' }
}

function writeDraft(sessionId: string, value: string): void {
  if (!sessionId) return
  try {
    if (value) globalThis.localStorage?.setItem(DRAFT_KEY_PREFIX + sessionId, value)
    else globalThis.localStorage?.removeItem(DRAFT_KEY_PREFIX + sessionId)
  } catch { /* storage blocked in restricted frames */ }
}

interface SlashCommandItem {
  readonly id: string
  readonly cmd: string
  readonly keywords?: string
  readonly label: string
  readonly desc: string
  readonly disabled?: boolean
  readonly run: () => void
}

/**
 * Lower is a closer match. A command id outranks keywords, and both outrank
 * label and description text, so `/se` stays on `/settings` instead of a
 * sentence that merely contains "session".
 */
function slashMatchRank(item: SlashCommandItem, token: string): number | undefined {
  const id = item.cmd.slice(1)
  if (id === token) return 0
  if (id.startsWith(token)) return 1
  if (id.includes(token) || item.keywords?.toLowerCase().includes(token)) return 2
  if (item.label.toLowerCase().includes(token) || item.desc.toLowerCase().includes(token)) return 3
  return undefined
}

interface ComposerProps {
  readonly locale: CopyLocale
  readonly sessionId: string
  readonly running: boolean
  readonly disabled: boolean
  readonly items: readonly ChatItem[]
  readonly error?: string
  readonly onNewSegment: () => Promise<string>
  readonly onOpenTasks: () => void
  readonly onOpenSettings: () => void
  readonly onSend: (text: string, images: readonly ChatImage[]) => Promise<void>
  readonly onStop: () => void
  readonly onDismissError: () => void
  /** Register the composer's draft-insertion handler so the panel's starter chips fill it. */
  readonly insertRef?: MutableRefObject<((text: string) => void) | undefined>
}

export function Composer({
  locale, sessionId, running, disabled, items, error,
  onNewSegment, onOpenTasks, onOpenSettings, onSend, onStop, onDismissError, insertRef,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ChatImage[]>([])
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [localError, setLocalError] = useState<string>()
  const [segmentBusy, setSegmentBusy] = useState(false)
  const [segmentDone, setSegmentDone] = useState(false)
  const [slashPinned, setSlashPinned] = useState(false)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [historyCursor, setHistoryCursor] = useState(-1)
  const historyDraft = useRef('')
  const dragDepth = useRef(0)
  const hydratedSession = useRef('')
  const textRef = useRef('')
  const composerRef = useRef<HTMLDivElement>(null)
  const slashList = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  textRef.current = text

  // The first id keeps text typed before the snapshot arrived. A later id is a new
  // segment: keep the visible draft and store it there, so reload does not leave it
  // on the segment that just ended. An empty composer loads that session's draft.
  useEffect(() => {
    if (!sessionId || hydratedSession.current === sessionId) return
    const previous = hydratedSession.current
    hydratedSession.current = sessionId
    const visible = textRef.current
    if (!previous) {
      const saved = readDraft(sessionId)
      if (!visible && saved) setText(saved)
      else if (visible) writeDraft(sessionId, visible)
      return
    }
    setHistoryCursor(-1)
    historyDraft.current = ''
    if (visible) writeDraft(sessionId, visible)
    else {
      const saved = readDraft(sessionId)
      if (saved) setText(saved)
    }
  }, [sessionId])

  const updateText = useCallback((next: string, resetHistory = true) => {
    setText(next)
    writeDraft(sessionId, next)
    if (resetHistory) setHistoryCursor(-1)
    if (!next.startsWith('/')) setSlashDismissed(false)
  }, [sessionId])

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    const cap = expanded ? 360 : 180
    el.style.height = Math.min(el.scrollHeight, cap) + 'px'
  }, [text, expanded])

  useEffect(() => {
    if (!segmentDone) return
    const timer = setTimeout(() => setSegmentDone(false), 2200)
    return () => clearTimeout(timer)
  }, [segmentDone])

  // dragenter/dragleave are continuous and often both fire before `dragging` re-renders.
  // Counting from the ref, and clearing on dragend, keeps the drop mask from sticking.
  useEffect(() => {
    const end = () => { dragDepth.current = 0; setDragging(false) }
    window.addEventListener('dragend', end)
    return () => window.removeEventListener('dragend', end)
  }, [])

  const sentHistory = useMemo(() => {
    const out: string[] = []
    for (const item of items) {
      if (item.kind === 'user' && item.text.trim()) {
        if (out.at(-1) !== item.text) out.push(item.text)
      }
    }
    return out.slice(-30)
  }, [items])

  const addFiles = useCallback(async (files: readonly File[]) => {
    setLocalError(undefined)
    const next = [...images]
    for (const file of files) {
      if (next.length >= CHAT_IMAGE_LIMIT) { setLocalError(imageErrorText(locale, 'too-many')); break }
      try { next.push(await readImageFile(file)) } catch (failure) {
        setLocalError(failure instanceof ChatImageRejected ? imageErrorText(locale, failure.code) : imageErrorText(locale, 'invalid'))
        break
      }
    }
    setImages(next)
  }, [images, locale])

  const submit = useCallback(() => {
    const body = text.trim()
    if ((!body && images.length === 0) || busy || disabled) return
    setBusy(true)
    setSlashPinned(false)
    const sending = images
    onSend(body, sending)
      .then(() => {
        setText('')
        writeDraft(sessionId, '')
        setImages([])
        setHistoryCursor(-1)
        setExpanded(false)
      }, () => {})
      .finally(() => { setBusy(false); area.current?.focus() })
  }, [text, images, busy, disabled, sessionId, onSend])

  const startNewSegment = useCallback(() => {
    if (disabled || running || segmentBusy) return
    setSegmentBusy(true)
    setLocalError(undefined)
    setSlashPinned(false)
    onNewSegment().then(
      () => { setSegmentDone(true) },
      failure => setLocalError(failure instanceof Error ? failure.message : String(failure)),
    ).finally(() => setSegmentBusy(false))
  }, [disabled, running, segmentBusy, onNewSegment])

  const insertTemplate = useCallback((template: string) => {
    setSlashPinned(false)
    updateText(template)
    requestAnimationFrame(() => {
      const el = area.current
      if (!el) return
      el.focus()
      el.setSelectionRange(template.length, template.length)
    })
  }, [updateText])

  useEffect(() => {
    if (!insertRef) return
    insertRef.current = insertTemplate
    return () => { insertRef.current = undefined }
  }, [insertRef, insertTemplate])

  const commands = useMemo<readonly SlashCommandItem[]>(() => [
    {
      id: 'overview',
      cmd: '/overview',
      label: t(locale, 'starter1'),
      desc: t(locale, 'cmdOverviewDesc'),
      run: () => insertTemplate(t(locale, 'starter1')),
    },
    {
      id: 'pending',
      cmd: '/pending',
      label: t(locale, 'starter2'),
      desc: t(locale, 'cmdPendingDesc'),
      run: () => insertTemplate(t(locale, 'starter2')),
    },
    {
      id: 'task',
      cmd: '/task',
      label: t(locale, 'cmdTaskLabel'),
      desc: t(locale, 'cmdTaskDesc'),
      run: () => insertTemplate(t(locale, 'cmdTaskTemplate')),
    },
    {
      id: 'remind',
      cmd: '/remind',
      label: t(locale, 'cmdRemindLabel'),
      desc: t(locale, 'cmdRemindDesc'),
      run: () => insertTemplate(t(locale, 'cmdRemindTemplate')),
    },
    {
      id: 'board',
      cmd: '/board',
      label: t(locale, 'tasks'),
      desc: t(locale, 'cmdBoardDesc'),
      run: () => {
        if (text.trim().startsWith('/')) updateText('')
        setSlashPinned(false)
        onOpenTasks()
      },
    },
    {
      id: 'settings',
      cmd: '/settings',
      keywords: 'model 模型',
      label: t(locale, 'settings'),
      desc: `${t(locale, 'sModel')} · ${t(locale, 'sRequests')}`,
      run: () => {
        if (text.trim().startsWith('/')) updateText('')
        setSlashPinned(false)
        onOpenSettings()
      },
    },
    {
      id: 'segment',
      cmd: '/segment',
      label: t(locale, 'ctxNewSegment'),
      desc: running ? t(locale, 'ctxNewSegmentBusy') : t(locale, 'ctxNewSegmentHelp'),
      disabled: running || segmentBusy,
      run: () => {
        if (text.trim().startsWith('/')) updateText('')
        startNewSegment()
      },
    },
  ], [locale, running, segmentBusy, text, insertTemplate, startNewSegment, updateText, onOpenTasks, onOpenSettings])

  const slashToken = useMemo(() => {
    if (!text.startsWith('/') || text.includes('\n') || /\s/.test(text)) return undefined
    return text.slice(1).toLowerCase()
  }, [text])

  const filteredCommands = useMemo(() => {
    if (slashPinned && slashToken === undefined) return commands
    if (slashToken === undefined) return []
    if (!slashToken) return commands
    return commands
      .map((item, index) => ({ item, index, rank: slashMatchRank(item, slashToken) }))
      .filter((row): row is { item: SlashCommandItem; index: number; rank: number } => row.rank !== undefined)
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(row => row.item)
  }, [commands, slashPinned, slashToken])

  const slashOpen = !disabled && filteredCommands.length > 0 && (slashPinned || (slashToken !== undefined && !slashDismissed))

  useEffect(() => { setSlashIndex(0) }, [slashToken, slashPinned])
  useLayoutEffect(() => {
    if (historyCursor < 0) return
    const el = area.current
    if (!el) return
    const pos = el.value.length
    el.setSelectionRange(pos, pos)
  }, [historyCursor, text])
  useEffect(() => {
    if (!slashOpen) return
    const list = slashList.current
    const active = list?.querySelector<HTMLElement>('[data-active]')
    if (!list || !active) return
    const listRect = list.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    if (listRect.height === 0 || activeRect.height === 0) return
    if (activeRect.top < listRect.top) list.scrollTop -= listRect.top - activeRect.top
    else if (activeRect.bottom > listRect.bottom) list.scrollTop += activeRect.bottom - listRect.bottom
  }, [slashOpen, slashIndex, filteredCommands])
  useDismissOnOutsidePointer(composerRef, slashOpen, open => {
    if (!open) {
      setSlashPinned(false)
      if (slashToken !== undefined) setSlashDismissed(true)
    }
  })

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (slashOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashIndex(idx => (idx + 1) % filteredCommands.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashIndex(idx => (idx + filteredCommands.length - 1) % filteredCommands.length)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashPinned(false)
        setSlashDismissed(true)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        const picked = filteredCommands[slashIndex] ?? filteredCommands[0]
        if (picked) {
          event.preventDefault()
          if (!picked.disabled) picked.run()
          return
        }
      }
    }

    // Recall recent sent prompts with ArrowUp / ArrowDown. Once browsing, the
    // arrows walk history even after the caret moves to the end of the recall.
    const recall = (value: string, cursor: number) => {
      setHistoryCursor(cursor)
      setText(value)
      writeDraft(sessionId, value)
    }
    if (event.key === 'ArrowUp' && !event.shiftKey && !event.altKey && !event.metaKey && sentHistory.length > 0) {
      const el = event.currentTarget
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0
      if (text === '' ? atStart : historyCursor >= 0) {
        event.preventDefault()
        if (historyCursor === -1) historyDraft.current = text
        const nextIdx = historyCursor === -1 ? sentHistory.length - 1 : Math.max(0, historyCursor - 1)
        recall(sentHistory[nextIdx] ?? '', nextIdx)
        return
      }
    }
    if (event.key === 'ArrowDown' && !event.shiftKey && !event.altKey && !event.metaKey && historyCursor >= 0) {
      event.preventDefault()
      if (historyCursor >= sentHistory.length - 1) {
        const restored = historyDraft.current
        setHistoryCursor(-1)
        setText(restored)
        writeDraft(sessionId, restored)
      } else {
        const nextIdx = historyCursor + 1
        recall(sentHistory[nextIdx] ?? '', nextIdx)
      }
      return
    }

    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    submit()
  }, [slashOpen, filteredCommands, slashIndex, sentHistory, text, historyCursor, submit, sessionId])

  const onPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    event.preventDefault()
    void addFiles(files)
  }, [addFiles])

  const onPick = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = [...event.target.files ?? []]
    event.target.value = ''
    if (files.length > 0) void addFiles(files)
  }, [addFiles])

  const hasDragFiles = (event: DragEvent<HTMLElement>) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasDragFiles(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }, [disabled])
  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasDragFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [disabled])
  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (dragDepth.current === 0) return
    event.preventDefault()
    dragDepth.current -= 1
    if (dragDepth.current === 0) setDragging(false)
  }, [])
  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (disabled) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = [...event.dataTransfer?.files ?? []]
    if (files.length > 0) void addFiles(files)
  }, [disabled, addFiles])

  const clearAll = useCallback(() => {
    updateText('')
    setImages([])
    setLocalError(undefined)
    setExpanded(false)
    onDismissError()
    area.current?.focus()
  }, [updateText, onDismissError])

  const shownError = localError ?? error
  const canSend = !disabled && !busy && (Boolean(text.trim()) || images.length > 0)
  const hasContent = text.length > 0 || images.length > 0
  const showExpandToggle = expanded || text.length > 100 || text.includes('\n')
  const charCount = text.length

  return (
    <div className="dsh-dot-composer" ref={composerRef}>
      {shownError !== undefined ? (
        <div className="dsh-dot-error" role="alert">
          <IconWarningOutlineRegular size={14} className="dsh-dot-error-icon" />
          <span className="dsh-dot-error-text">{localError !== undefined ? shownError : `${t(locale, 'sendFailed')}${shownError}`}</span>
          <button
            type="button"
            className="dsh-dot-error-dismiss"
            aria-label={t(locale, 'dismissError')}
            title={t(locale, 'dismissError')}
            onClick={() => { setLocalError(undefined); onDismissError() }}
          >
            <IconCloseOutlineRegular size={13} />
          </button>
        </div>
      ) : null}

      {slashOpen ? (
        <div className="dsh-dot-slash-menu" role="listbox" aria-label={t(locale, 'quickActions')}>
          <div className="dsh-dot-slash-head">
            <span>{t(locale, 'quickActions')}</span>
            <span className="dsh-dot-slash-kbd">↑↓ · Enter</span>
          </div>
          <div className="dsh-dot-slash-list" ref={slashList}>
            {filteredCommands.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={idx === slashIndex}
                {...(item.disabled ? { disabled: true } : {})}
                className="dsh-dot-slash-item"
                data-active={idx === slashIndex ? '' : undefined}
                onMouseEnter={() => setSlashIndex(idx)}
                onClick={() => item.run()}
              >
                <code className="dsh-dot-slash-cmd">{item.cmd}</code>
                <div className="dsh-dot-slash-copy">
                  <span className="dsh-dot-slash-label">{item.label}</span>
                  <span className="dsh-dot-slash-desc">{item.desc}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div
        className="dsh-dot-composer-card"
        data-running={running ? '' : undefined}
        data-disabled={disabled ? '' : undefined}
        data-dragging={dragging ? '' : undefined}
        data-expanded={expanded ? '' : undefined}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragging ? (
          <div className="dsh-dot-drop-mask" aria-hidden="true">
            <ImageGlyph />
            <span>{t(locale, 'dropImagesHint').replace('{max}', String(CHAT_IMAGE_LIMIT))}</span>
          </div>
        ) : null}

        {images.length > 0 ? (
          <div className="dsh-dot-attachments">
            {images.map((image, index) => (
              <div key={`${image.name ?? image.mediaType}:${index}`} className="dsh-dot-attachment">
                <img
                  className="dsh-dot-attachment-thumb"
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt={image.name ?? t(locale, 'imageAttached')}
                />
                <div className="dsh-dot-attachment-meta">
                  <span className="dsh-dot-attachment-name">{image.name ?? t(locale, 'imageAttached')}</span>
                  <span className="dsh-dot-attachment-ext">{image.mediaType.replace('image/', '').toUpperCase()}</span>
                </div>
                <button
                  type="button"
                  className="dsh-dot-attachment-remove"
                  aria-label={t(locale, 'removeImage')}
                  title={t(locale, 'removeImage')}
                  onClick={() => setImages(list => list.filter((_, item) => item !== index))}
                >
                  ×
                </button>
              </div>
            ))}
            {images.length < CHAT_IMAGE_LIMIT ? (
              <button
                type="button"
                className="dsh-dot-attachment-add"
                disabled={disabled || busy}
                aria-label={t(locale, 'attachImage')}
                title={`${t(locale, 'attachImage')} (${images.length}/${CHAT_IMAGE_LIMIT})`}
                onClick={() => picker.current?.click()}
              >
                <PlusGlyph />
                <span>{images.length}/{CHAT_IMAGE_LIMIT}</span>
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="dsh-dot-editor-wrap">
          <textarea
            ref={area}
            className="dsh-dot-input"
            rows={1}
            maxLength={COMPOSER_TEXT_LIMIT}
            value={text}
            placeholder={running ? t(locale, 'placeholderRunning') : t(locale, 'placeholder')}
            onChange={event => updateText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={disabled}
          />
          {showExpandToggle ? (
            <Tooltip label={t(locale, expanded ? 'collapseInput' : 'expandInput')} side="top">
              <button
                type="button"
                className="dsh-dot-expand-btn"
                aria-label={t(locale, expanded ? 'collapseInput' : 'expandInput')}
                aria-pressed={expanded}
                onClick={() => setExpanded(value => !value)}
              >
                {expanded ? <NarrowGlyph /> : <WidenGlyph />}
              </button>
            </Tooltip>
          ) : null}
        </div>

        <div className="dsh-dot-composer-bar">
          <div className="dsh-dot-composer-tools">
            <input ref={picker} className="dsh-dot-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={onPick} />
            <Tooltip label={t(locale, 'attachImage')} side="top">
              <button
                type="button"
                className="dsh-dot-tool-btn"
                disabled={disabled || busy || images.length >= CHAT_IMAGE_LIMIT}
                aria-label={t(locale, 'attachImage')}
                onClick={() => picker.current?.click()}
              >
                <ImageGlyph />
                {images.length > 0 ? <span className="dsh-dot-tool-count">{images.length}</span> : null}
              </button>
            </Tooltip>

            <Tooltip label={t(locale, 'quickActions')} side="top">
              <button
                type="button"
                className="dsh-dot-tool-btn"
                disabled={disabled}
                aria-label={t(locale, 'quickActions')}
                aria-expanded={slashOpen}
                aria-pressed={slashOpen}
                onClick={() => {
                  if (slashOpen) {
                    setSlashPinned(false)
                    setSlashDismissed(true)
                    return
                  }
                  setSlashDismissed(false)
                  setSlashPinned(true)
                }}
              >
                <SlashCommandGlyph />
              </button>
            </Tooltip>

            {segmentBusy || segmentDone ? (
              <span className="dsh-dot-seg-feedback" data-done={segmentDone ? '' : undefined} role="status">
                {segmentDone ? <IconCheckOutlineRegular size={12} /> : null}
                <span>{segmentBusy ? t(locale, 'ctxNewSegmentRunning') : t(locale, 'ctxNewSegmentDone')}</span>
              </span>
            ) : null}
          </div>

          <div className="dsh-dot-composer-right">
            {charCount >= 200 ? (
              <span className="dsh-dot-char-count" data-warn={charCount >= COMPOSER_TEXT_LIMIT * 0.9 ? '' : undefined}>
                {charCount.toLocaleString()}/{COMPOSER_TEXT_LIMIT.toLocaleString()}
              </span>
            ) : (
              <span className="dsh-dot-composer-hint">{t(locale, 'composerHint')}</span>
            )}

            {hasContent && !busy ? (
              <Tooltip label={t(locale, 'clearInput')} side="top">
                <button
                  type="button"
                  className="dsh-dot-tool-btn dsh-dot-clear-btn"
                  aria-label={t(locale, 'clearInput')}
                  onClick={clearAll}
                >
                  <ClearGlyph />
                </button>
              </Tooltip>
            ) : null}

            {running ? (
              <button type="button" className="dsh-dot-stop-btn" onClick={onStop}>
                <StopSquareGlyph />
                <span>{t(locale, 'stop')}</span>
              </button>
            ) : null}

            <button
              type="button"
              className="dsh-dot-send-btn"
              disabled={!canSend}
              onClick={submit}
            >
              <SendArrowGlyph />
              <span>{busy ? t(locale, 'sending') : t(locale, 'send')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ImageGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <circle cx="5.6" cy="6" r="1.1" />
      <path d="M2.5 11.5 6 8.2a1 1 0 0 1 1.4 0L10 10.7l1.6-1.5a1 1 0 0 1 1.4 0l1 1" />
    </svg>
  )
}

function SlashCommandGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="3" />
      <path d="M9.6 4.8 6.4 11.2" />
    </svg>
  )
}

function ClearGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4.5h10M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3M4.5 4.5l.6 8.2c0 .7.6 1.3 1.3 1.3h3.2c.7 0 1.3-.6 1.3-1.3l.6-8.2" />
    </svg>
  )
}

function PlusGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  )
}

function SendArrowGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 12.8V3.5M4.2 7.2 8 3.4l3.8 3.8" />
    </svg>
  )
}

function StopSquareGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="8" height="8" rx="1.8" />
    </svg>
  )
}

export function ToolGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.8 2.6a3.2 3.2 0 0 0 3.6 4.2L8.2 12a1.7 1.7 0 0 1-2.4-2.4l5.2-5.2" />
      <path d="M3 13l1.6-1.6" />
    </svg>
  )
}

export function WidenGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
    </svg>
  )
}

export function NarrowGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14" />
    </svg>
  )
}

export function GearGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function BellGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 10.5V7a4 4 0 0 1 8 0v3.5l1 1.5H3z" />
      <path d="M6.6 13.6a1.5 1.5 0 0 0 2.8 0" />
    </svg>
  )
}

export function JumpGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4h6v6" />
      <path d="M12 4L4.5 11.5" />
    </svg>
  )
}
