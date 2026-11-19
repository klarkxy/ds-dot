/**
 * Hides background request-handling noise from Dorothy's human-facing chat.
 *
 * Routine approvals/questions settled silently by Dorothy and requests already
 * answered in their own session (`dot/unknown-request`) stay in the session log
 * and Trajectory view, while the chat panel only shows requests that need the
 * human's attention or carry a substantive message/card/error.
 */
import { TOOL, type ChatItem } from './contracts.ts'
import { parseNotice } from './chat-format.ts'

export interface FilteredChat {
  readonly items: readonly ChatItem[]
  readonly hiddenRequestIds: ReadonlySet<string>
  readonly silentTail: boolean
}

type InputItem = Extract<ChatItem, { kind: 'user' | 'answer' | 'notice' }>
type ReplyItem = Exclude<ChatItem, { kind: 'segment' | 'user' | 'answer' | 'notice' }>
type ToolItem = Extract<ChatItem, { kind: 'tool' }>

interface ExchangeBlock {
  readonly segment?: Extract<ChatItem, { kind: 'segment' }>
  readonly inputs: InputItem[]
  readonly replies: ReplyItem[]
}

const UNKNOWN_REQ_RE = /^Error \[dot\/unknown-request\]:\s*no waiting request (\S+)/
const ANSWERED_OK_RE = /^Answered (\S+) for /

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  TOOL.overview,
  TOOL.read,
  TOOL.listModels,
  TOOL.searchHistory,
  TOOL.readHistory,
  'list_sessions',
  'search_sessions',
  'read_session',
  'dsh_docs',
  'dsh_plugins',
])

/** list/read are queries. A missing or unknown action is a change, so the turn stays visible. */
function isQueryTool(tool: ToolItem): boolean {
  const action = typeof tool.args?.action === 'string' ? tool.args.action : undefined
  if (tool.name === TOOL.workspace) return action === 'list' || action === 'inspect' || action === 'files'
  if (tool.name === TOOL.schedule) return action === 'list'
  if (tool.name === TOOL.task) return action === 'read' || action === 'list'
  return READ_ONLY_TOOLS.has(tool.name)
}

/** A grant, refusal or submitted answer. A lost race is not a decision this turn made. */
function isRequestDecision(tool: ToolItem): boolean {
  if (tool.name !== TOOL.answerPending || unknownRequestIdOf(tool)) return false
  return tool.args?.allow === true || tool.args?.allow === false || Array.isArray(tool.args?.answers)
}

function strId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function unknownRequestIdOf(item: ToolItem): string | undefined {
  if (item.name !== TOOL.answerPending) return undefined
  if (item.display?.error?.code === 'dot/unknown-request') return strId(item.args?.id)
  if (item.display) return undefined
  const detail = item.detail?.trim() ?? ''
  const match = UNKNOWN_REQ_RE.exec(detail)
  if (!match) return undefined
  return strId(item.args?.id) ?? match[1]
}

function routineSettledIdOf(item: ToolItem): string | undefined {
  const unknownId = unknownRequestIdOf(item)
  if (unknownId) return unknownId
  if (item.name !== TOOL.answerPending || item.status !== 'done') return undefined
  if (item.args?.allow === false) return undefined
  if (item.args?.allow === true || Array.isArray(item.args?.answers)) {
    return strId(item.args.id) ?? ANSWERED_OK_RE.exec(item.detail?.trim() ?? '')?.[1]
  }
  return ANSWERED_OK_RE.exec(item.detail?.trim() ?? '')?.[1]
}

function groupBlocks(items: readonly ChatItem[]): ExchangeBlock[] {
  const blocks: ExchangeBlock[] = []
  let current: ExchangeBlock | undefined
  let currentTurn: number | undefined

  for (const item of items) {
    if (item.kind === 'segment') {
      blocks.push({ segment: item, inputs: [], replies: [] })
      current = undefined
      currentTurn = undefined
      continue
    }
    if (item.turn !== undefined) {
      if (!current || currentTurn !== item.turn) {
        current = { inputs: [], replies: [] }
        currentTurn = item.turn
        blocks.push(current)
      }
      if (item.kind === 'user' || item.kind === 'answer' || item.kind === 'notice') current.inputs.push(item)
      else current.replies.push(item)
      continue
    }
    if (item.kind === 'user' || item.kind === 'answer' || item.kind === 'notice') {
      if (
        current !== undefined
        && !current.segment
        && current.replies.length === 0
        && !current.inputs.some(input => input.kind === 'user' || input.kind === 'answer')
      ) {
        current.inputs.push(item)
      } else {
        current = { inputs: [item], replies: [] }
        blocks.push(current)
      }
      continue
    }
    if (!current || current.segment) {
      current = { inputs: [], replies: [item] }
      blocks.push(current)
    } else {
      current.replies.push(item)
    }
  }
  return blocks
}

export function filterVisibleChat(
  items: readonly ChatItem[],
  options?: { readonly streaming?: boolean; readonly running?: boolean; readonly preparingCard?: boolean },
): FilteredChat {
  const blocks = groupBlocks(items)
  const out: ChatItem[] = []
  const hiddenRequestIds = new Set<string>()
  let silentTail = false

  blocks.forEach((block, index) => {
    if (block.segment) {
      out.push(block.segment)
      return
    }
    const isLast = index === blocks.length - 1
    const streamingHere = isLast && options?.streaming === true
    const tools = block.replies.filter((reply): reply is ToolItem => reply.kind === 'tool')
    const bots = block.replies.filter((reply): reply is Extract<ChatItem, { kind: 'bot' }> => reply.kind === 'bot')
    const hasVisibleView = block.replies.some(reply => reply.kind === 'view' && !reply.failed && reply.presentation !== undefined)
    const hasTurnError = block.replies.some(reply => reply.kind === 'error')
    const hasToolError = tools.some(tool => tool.status === 'error')
    const hasInvalidView = block.replies.some(reply => reply.kind === 'view' && (reply.failed || reply.presentation === undefined))
    // dot_answer stays out of this flag so a routine approval notice can still settle silently.
    // An idle check asks isRequestDecision on its own and does not treat that call as a query.
    const hasSideEffectTool = tools.some(tool => tool.name !== TOOL.answerPending && !isQueryTool(tool))
    const hasRequestDecision = tools.some(isRequestDecision)
    const hasHumanInput = block.inputs.some(input => input.kind === 'user' || input.kind === 'answer') || block.replies.some(reply => reply.trigger === 'human')
    if (isLast && !hasHumanInput && !hasVisibleView && bots.length === 0) silentTail = true
    const notices = block.inputs.filter((input): input is Extract<ChatItem, { kind: 'notice' }> => input.kind === 'notice')
    const parsedNotices = notices.map(notice => notice.notice ?? parseNotice(notice.text))
    const isRoutineOnly = !hasHumanInput && notices.length > 0 && parsedNotices.every(parsed => !parsed.isReminder && parsed.entries.length > 0 && parsed.entries.every(entry => entry.kind === 'idle-check'))

    // Leading window tail from a race-lost request turn whose notice scrolled past the window.
    if (
      block.inputs.length === 0
      && !hasHumanInput
      && !hasVisibleView
      && !hasTurnError
      && !hasSideEffectTool
      && !streamingHere
      && tools.length > 0
      && tools.every(tool => unknownRequestIdOf(tool) !== undefined)
      && bots.every(bot => /^(?:`?[^`\s]+`?\s*)?(?:已在原会话处理[。.]?|already settled[.!]?)$/i.test(bot.text.trim()))
    ) {
      for (const tool of tools) {
        const id = unknownRequestIdOf(tool)
        if (id) hiddenRequestIds.add(id)
      }
      if (isLast) silentTail = true
      return
    }

    // Pure background request wake-up (only approval/question notices, no user message).
    if (!hasHumanInput && notices.length > 0) {
      // A pure query leaves nothing the human must see. The turn stays hidden only
      // while it produced no reply text either; a non-empty reply is visible now
      // that ordinary replies are plain text, mirroring hasVisibleView for cards.
      if (isRoutineOnly && !hasVisibleView && !hasInvalidView && !hasTurnError && !hasToolError && !hasSideEffectTool && !hasRequestDecision && !streamingHere
        && !bots.some(bot => bText(bot).trim())) {
        if (isLast) silentTail = true
        return
      }
      const isRequestOnly = parsedNotices.every(
        parsed => !parsed.isReminder
          && parsed.entries.length > 0
          && parsed.entries.every(entry => entry.kind === 'approval' || entry.kind === 'question'),
      )
      if (isRequestOnly && !hasVisibleView && !hasTurnError && !hasSideEffectTool && !streamingHere) {
        const noticeIds = parsedNotices
          .flatMap(parsed => parsed.entries)
          .map(entry => entry.kind !== 'reminder' ? entry.requestId : undefined)
          .filter((id): id is string => Boolean(id))
        const routineIds = new Set(
          tools.map(routineSettledIdOf).filter((id): id is string => Boolean(id)),
        )
        const allRoutinelySettled = noticeIds.length > 0
          && noticeIds.every(id => routineIds.has(id))
          && !bots.some(bot => /[?？]/.test(bText(bot)))
        const onlySettledAcknowledgements = bots.length > 0 && tools.some(tool => unknownRequestIdOf(tool) !== undefined) && bots.every(bot => /^(?:`?[^`\s]+`?\s*)?(?:已在原会话处理[。.]?|already settled[.!]?)$/i.test(bot.text.trim()))
        if ((bots.length === 0 && (allRoutinelySettled || noticeIds.length > 0)) || onlySettledAcknowledgements) {
          for (const id of noticeIds) hiddenRequestIds.add(id)
          for (const id of routineIds) hiddenRequestIds.add(id)
          if (isLast) silentTail = true
          return
        }
      }
    }

    // Shown block: still drop race-lost dot_answer calls and unmentioned routine settlements in mixed notices.
    const droppedTools = new Set<ToolItem>()
    for (const tool of tools) {
      const unknownId = unknownRequestIdOf(tool)
      if (unknownId) {
        hiddenRequestIds.add(unknownId)
        droppedTools.add(tool)
        continue
      }
      // An idle check keeps the decision itself. Approval notices still drop an unmentioned settlement.
      if (notices.length > 0 && !hasVisibleView && !hasHumanInput && !isRoutineOnly) {
        const routineId = routineSettledIdOf(tool)
        if (routineId && !bots.some(bot => bot.text.includes(routineId))) {
          hiddenRequestIds.add(routineId)
          droppedTools.add(tool)
        }
      }
    }

    for (const input of block.inputs) {
      if (input.kind === 'notice' && hiddenRequestIds.size > 0) {
        const parsed = input.notice ?? parseNotice(input.text)
        if (!parsed.isReminder && parsed.entries.length > 0) {
          const visibleEntries = parsed.entries.filter(
            entry => entry.kind === 'reminder' || !entry.requestId || !hiddenRequestIds.has(entry.requestId),
          )
          if (visibleEntries.length === 0) continue
        }
      }
      out.push(input)
    }
    for (const reply of block.replies) {
      // Text and a card in the same reply both show: ordinary replies are plain text,
      // and a card no longer swallows the message written beside it.
      if (reply.kind === 'view' && (reply.failed || !reply.presentation) && !(isRoutineOnly && hasInvalidView)) continue
      if (reply.kind === 'tool' && droppedTools.has(reply)) continue
      out.push(reply)
    }
  })

  return { items: out, hiddenRequestIds, silentTail }
}

function bText(bot: Extract<ChatItem, { kind: 'bot' }>): string {
  return bot.text
}
