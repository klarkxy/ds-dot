/**
 * Task sessions dot opens may message each other. They may not open another
 * session. The delivery row is written before followup, and an unknown row is
 * never followed up again.
 */
import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeContainsPath } from './acceptance.ts'
import type { PeerDelivery } from './storage.ts'
import { scopeWithinRoot, scopeWrites, type WriteScope } from './work.ts'

/** Model-facing tool on a session dot opened. Not one of dot's own preset tools. */
export const PEER_TOOL = 'dot_peer'

/**
 * Host tools that start or drive another session. Names absent from the live
 * registry are not passed to `tools.restrict` (unknown names throw); a call is
 * still denied.
 */
export const CHILD_SESSION_TOOLS = [
  'subagent',
  'subagent_fork',
  'spawn_teammate',
  'list_subagent_models',
  'list_agents',
  'send_message',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  'workflow',
] as const

const CHILD_SESSION_TOOL_SET: ReadonlySet<string> = new Set(CHILD_SESSION_TOOLS)
const DELIVERY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const TEXT_MAX = 8_000
const DENY_REASON = 'This session cannot start or control another session (subagent, teammate, Team, workflow). Use dot_peer to message a peer session that dot already opened.'
const SEALED = Symbol('dot.child-seal')

export function isChildSessionTool(name: string): boolean {
  return CHILD_SESSION_TOOL_SET.has(name)
}

export interface OwnedSessionInput {
  readonly dotSessionId?: string
  readonly runs: readonly { readonly sessionId?: string; readonly requestedSessionId: string; readonly creation: string }[]
  readonly tasks: readonly { readonly sessionId: string; readonly origin: string }[]
  readonly tickets: readonly { readonly sessions: readonly { readonly sessionId: string }[] }[]
}

/** Sessions dot opened. A reserved id that was never sent to the host is not one of them. */
export function ownedSessionIds(input: OwnedSessionInput): string[] {
  const ids = new Set<string>()
  for (const run of input.runs) {
    if (run.sessionId) ids.add(run.sessionId)
    if (run.requestedSessionId && run.creation !== 'intent') ids.add(run.requestedSessionId)
  }
  for (const task of input.tasks) if (task.origin === 'started') ids.add(task.sessionId)
  for (const ticket of input.tickets) for (const session of ticket.sessions) ids.add(session.sessionId)
  if (input.dotSessionId) ids.delete(input.dotSessionId)
  return [...ids]
}

export function sessionIsOwned(sessionId: string, input: OwnedSessionInput): boolean {
  return ownedSessionIds(input).includes(sessionId)
}

export interface PeerTable {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
  entries(): IterableIterator<[unknown, unknown]>
  delete?(key: string): Promise<unknown>
}

export interface PeerSendInput {
  readonly senderSessionId: string
  readonly targetSessionId: string
  readonly deliveryId: string
  readonly text: string
}

export interface PeerDeliveryDeps {
  now(): number
  owns(sessionId: string): boolean
  get(id: string): PeerDelivery | undefined
  put(row: PeerDelivery): Promise<void>
  /** Inserts already in the target log. Undefined means the log could not be read. */
  prove(targetSessionId: string, senderSessionId: string, deliveryId: string, text: string): Promise<number | undefined>
  relay(targetSessionId: string, senderSessionId: string, text: string, deliveryId: string): Promise<void>
  /** Record the target run as in-flight before the host call. */
  hold(targetSessionId: string, senderSessionId: string, deliveryId: string, text: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>
  /** Drop or accept the in-flight mark. A rejected mark was never followed up. */
  release(targetSessionId: string, deliveryId: string, status: 'accepted' | 'rejected'): Promise<void>
  /** Target run is still allowed to receive input. */
  admit(targetSessionId: string): { readonly ok: true } | { readonly ok: false; readonly message: string }
  trace?(event: string, message: string, data: Record<string, string | number | boolean>): void
}

/** One in-flight peer decision at a time. `write` does not take the queue, so a decision may call it. */
export class PeerLedger {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly table: PeerTable, private readonly parse: (value: unknown) => PeerDelivery | undefined) {}

  read(id: string): PeerDelivery | undefined {
    return this.parse(this.table.get(id))
  }

  write(row: PeerDelivery): Promise<void> {
    return this.table.put(row.id, row)
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    const job = this.tail.then(work, work)
    this.tail = job.then(() => undefined, () => undefined)
    return job
  }

  /** Drop every delivery row. Used by factory reset. */
  async clear(): Promise<void> {
    const remove = this.table.delete
    if (typeof remove !== 'function') return
    const keys = [...this.table.entries()].map(([key]) => String(key))
    for (const key of keys) await remove.call(this.table, key)
  }
}

/**
 * Record the attempt, then follow up at most once. A row that already exists
 * is reconciled from the target log and is not sent again.
 */
export async function deliverPeer(input: PeerSendInput, deps: PeerDeliveryDeps): Promise<string> {
  const deliveryId = input.deliveryId.trim()
  const text = input.text
  const sender = input.senderSessionId.trim()
  const target = input.targetSessionId.trim()
  const refuse = (message: string, code: string) => {
    deps.trace?.('peer.refused', message, { senderSessionId: sender, targetSessionId: target, deliveryId, code })
    return `Error [${code}]: ${message}`
  }
  if (!DELIVERY_ID_RE.test(deliveryId)) return refuse('delivery_id must be 1–64 letters, digits, or . _ : -', 'dot/peer-refused')
  if (!sender || !target) return refuse('sender and target are required; nothing was sent.', 'dot/peer-refused')
  if (sender === target) return refuse('a session cannot peer-message itself; nothing was sent.', 'dot/peer-refused')
  if (text.trim() === '' || text.length > TEXT_MAX) return refuse('text must be non-empty and at most 8000 characters; nothing was sent.', 'dot/peer-refused')
  if (!deps.owns(sender) || !deps.owns(target)) return refuse('peer messages stay inside sessions dot opened; nothing was sent.', 'dot/peer-refused')
  const existing = deps.get(deliveryId)
  if (existing && (existing.senderSessionId !== sender || existing.targetSessionId !== target || existing.text !== text)) {
    return refuse(`delivery ${deliveryId} is already bound to a different message; nothing was sent.`, 'dot/peer-refused')
  }
  const row = (status: PeerDelivery['status']): PeerDelivery => ({
    id: deliveryId, senderSessionId: sender, targetSessionId: target, text, status, updatedAt: deps.now(),
  })
  if (existing) {
    const count = await deps.prove(target, sender, deliveryId, text)
    if (count !== undefined && count > 0) {
      if (existing.status !== 'accepted') await deps.put(row('accepted'))
      deps.trace?.('peer.duplicate', `Delivery ${deliveryId} already landed.`, { senderSessionId: sender, targetSessionId: target, deliveryId, status: 'accepted' })
      return `delivery ${deliveryId} already landed; not sent again.`
    }
    if (existing.status !== 'unknown') await deps.put(row('unknown'))
    deps.trace?.('peer.unknown', `Delivery ${deliveryId} was not resent.`, { senderSessionId: sender, targetSessionId: target, deliveryId, status: 'unknown' })
    return `delivery ${deliveryId} is unknown and was not resent.`
  }
  const before = await deps.prove(target, sender, deliveryId, text)
  if (before === undefined) {
    await deps.put(row('unknown'))
    deps.trace?.('peer.unknown', `Delivery ${deliveryId} could not be proved.`, { senderSessionId: sender, targetSessionId: target, deliveryId, status: 'unknown' })
    return `delivery ${deliveryId} is unknown; nothing was sent.`
  }
  if (before > 0) {
    await deps.put(row('accepted'))
    deps.trace?.('peer.duplicate', `Delivery ${deliveryId} already landed.`, { senderSessionId: sender, targetSessionId: target, deliveryId, status: 'accepted' })
    return `delivery ${deliveryId} already landed; not sent again.`
  }
  const gate = deps.admit(target)
  if (!gate.ok) return refuse(gate.message, 'dot/peer-refused')
  const held = await deps.hold(target, sender, deliveryId, text)
  if (!held.ok) return refuse(held.message, 'dot/peer-refused')
  try { await deps.put(row('intent')) } catch {
    await deps.release(target, deliveryId, 'rejected')
    return refuse('the delivery could not be recorded; nothing was sent.', 'dot/peer-failed')
  }
  try { await deps.relay(target, sender, text, deliveryId) } catch {
    await deps.release(target, deliveryId, 'rejected')
    await deps.put(row('unknown'))
    deps.trace?.('peer.unknown', `Delivery ${deliveryId} was not proved.`, { senderSessionId: sender, targetSessionId: target, deliveryId, status: 'unknown' })
    return `delivery ${deliveryId} is unknown and was not resent.`
  }
  const after = await deps.prove(target, sender, deliveryId, text)
  if (after !== undefined && after > before) {
    await deps.release(target, deliveryId, 'accepted')
    await deps.put(row('accepted'))
    deps.trace?.('peer.sent', `Relayed delivery ${deliveryId} to ${target}.`, { senderSessionId: sender, targetSessionId: target, deliveryId, status: 'accepted' })
    return `delivery ${deliveryId} accepted: relayed to ${target}.`
  }
  await deps.put(row('unknown'))
  deps.trace?.('peer.unknown', `Delivery ${deliveryId} was not proved.`, { senderSessionId: sender, targetSessionId: target, deliveryId, status: 'unknown' })
  return `delivery ${deliveryId} is unknown and was not resent.`
}

/** Re-apply deny lists after a global tool appears. The set belongs to one service instance. */
export function refreshChildSeals(refreshers: ReadonlySet<() => void>): void {
  for (const refresh of [...refreshers]) refresh()
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const FILE_MUTATION_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'multi_edit',
  'create_file',
  'delete_file',
  'remove_file',
  'move_file',
  'rename_file',
  'notebook_edit',
  'apply_patch',
  'patch',
])

const PATH_FIELDS = ['file_path', 'path', 'filePath', 'target_file', 'targetFile', 'notebook_path', 'source', 'destination', 'from_path', 'to_path'] as const
const PATCH_FILE_RE = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)$/gm
const PATCH_MOVE_RE = /^\*\*\*\s+Move\s+to:\s*(.+)$/gm

export interface PreExecuteToolCall {
  readonly name: string
  readonly input?: unknown
  readonly arguments?: unknown
  readonly args?: unknown
}

export type ChildToolGuard = (exec: PreExecuteToolCall) => { readonly allow: true } | { readonly allow: false; readonly reason: string }

function parseToolPayload(exec: PreExecuteToolCall): Record<string, unknown> | undefined {
  for (const candidate of [exec.input, exec.args, exec.arguments]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate as Record<string, unknown>
    if (typeof candidate === 'string' && candidate.trim()) {
      try {
        const parsed: unknown = JSON.parse(candidate)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        return { patch: candidate }
      }
    }
  }
  return undefined
}

function extractMutationPaths(payload: Record<string, unknown> | undefined): string[] {
  if (!payload) return []
  const found: string[] = []
  const push = (val: unknown) => {
    if (typeof val === 'string' && val.trim()) found.push(val.trim())
  }
  for (const key of PATH_FIELDS) push(payload[key])
  if (Array.isArray(payload.edits)) {
    for (const edit of payload.edits) {
      if (edit && typeof edit === 'object') {
        for (const key of PATH_FIELDS) push((edit as Record<string, unknown>)[key])
      }
    }
  }
  for (const patchKey of ['patch', 'diff', 'input', 'content']) {
    const raw = payload[patchKey]
    if (typeof raw !== 'string' || !raw.includes('*** ')) continue
    for (const match of raw.matchAll(PATCH_FILE_RE)) push(match[1])
    for (const match of raw.matchAll(PATCH_MOVE_RE)) push(match[1])
  }
  return [...new Set(found)]
}

/** Enforce a run's declared read/write scope at tool pre-execution time for structured file tools. */
export function guardRunWriteTool(
  run: { readonly id: string; readonly cwd: string; readonly workspaceRoot: string; readonly writeScope: WriteScope; readonly access?: 'read' | 'write' },
  exec: PreExecuteToolCall,
  platform: NodeJS.Platform = process.platform,
): { readonly allow: true } | { readonly allow: false; readonly reason: string } {
  const tool = exec.name.trim().toLowerCase()
  if (!FILE_MUTATION_TOOLS.has(tool)) return { allow: true }
  if (run.access === 'read' || !scopeWrites(run.writeScope)) {
    return { allow: false, reason: `Run ${run.id} is read-only and cannot execute file-modifying tool "${exec.name}".` }
  }
  const api = platform === 'win32' ? path.win32 : path.posix
  const targets = extractMutationPaths(parseToolPayload(exec))
  if (targets.length === 0) {
    if (run.writeScope.kind === 'paths') {
      return { allow: false, reason: `Run ${run.id} restricts writes to declared paths, and "${exec.name}" did not name a verifiable target path.` }
    }
    return { allow: true }
  }
  const root = run.workspaceRoot || run.cwd
  for (const raw of targets) {
    const abs = api.isAbsolute(raw) ? api.normalize(raw) : api.resolve(run.cwd, raw)
    if (!scopeWithinRoot(root, abs, platform)) {
      return { allow: false, reason: `Path "${raw}" is outside workspace root ${root} for run ${run.id}.` }
    }
    if (run.writeScope.kind === 'paths') {
      const rel = api.relative(root, abs).replaceAll('\\', '/')
      if (!scopeContainsPath(run.writeScope, root, rel, platform)) {
        const allowed = run.writeScope.paths.map(item => item.path).join(', ')
        return { allow: false, reason: `Path "${raw}" is outside run ${run.id}'s write scope (${allowed}).` }
      }
    }
  }
  return { allow: true }
}

/** Hide global child-session tools and gate scoped calls before publishing the seal. */
export function sealChildSession(agent: unknown, send: (input: PeerSendInput) => Promise<string>, refreshers: Set<() => void>, guardTool?: ChildToolGuard): { readonly applied: boolean; release(): void } {
  const live = agent as Agent & { [SEALED]?: boolean }
  if (live[SEALED]) return { applied: false, release() {} }
  const ctx = live.ctx
  const denied = new Set<string>()
  const disposers: (() => void)[] = []
  const refresh = () => {
    // An unscoped view names globals only: restrict deliberately rejects scoped tools.
    const fresh = ctx.tools.schemas().map(tool => tool.name).filter(name => isChildSessionTool(name) && !denied.has(name))
    if (fresh.length === 0) return
    // restrict emits tools/change synchronously; claim before listeners refresh us.
    for (const name of fresh) denied.add(name)
    try { disposers.push(ctx.tools.restrict({ deny: fresh })) } catch (error) {
      for (const name of fresh) denied.delete(name)
      throw error
    }
  }
  try {
    refresh()
    disposers.push(ctx.on('tools/pre-execute', (exec, next) => {
      if (isChildSessionTool(exec.name)) return Promise.resolve({ kind: 'deny', reason: DENY_REASON })
      const verdict = guardTool?.(exec as PreExecuteToolCall)
      if (verdict && !verdict.allow) return Promise.resolve({ kind: 'deny', reason: verdict.reason })
      return next()
    }))
    disposers.push(ctx.systemPrompt.section({
      name: 'dot:peer-session',
      order: 80,
      text: 'Child sessions are disabled in this session. Do not call subagent, subagent_fork, spawn_teammate, list_subagent_models, list_agents, send_message, wait_agent, interrupt_agent, team_task_create, team_task_list, team_task_get, team_task_update, or workflow. To wake another session that dot opened, call dot_peer only when that session\'s run is still active and still holds its scope. A finished or superseded run is refused. Reuse a delivery_id only to reconcile that same message. If the result is unknown, do not send it again.',
    }))
    disposers.push(ctx.tools.register(defineTool({
      name: PEER_TOOL,
      description: 'Wake one other session that dot opened and deliver one message as this session. Do not pass a sender; the caller is this session. target_session_id must be a different session whose run is still active and still holds its input and scope. A finished, stopped, settling, or superseded run is refused and nothing is sent. delivery_id is the idempotency key for this exact text: the same id is never followed up twice. unknown means the send was not proved — do not retry with this id or a new one. A new id is a new message and can double-send.',
      parameters: {
        target_session_id: { type: 'string', required: true, description: 'Session id of the peer dot opened.' },
        delivery_id: { type: 'string', required: true, description: 'Idempotency key, 1–64 letters, digits, or . _ : -.' },
        text: { type: 'string', required: true, description: 'Message text, 1–8000 characters.' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        return send({ senderSessionId: live.session.id, targetSessionId: args.target_session_id, deliveryId: args.delivery_id, text: args.text })
      },
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  live[SEALED] = true
  refreshers.add(refresh)
  return { applied: true, release: () => { refreshers.delete(refresh) } }
}
