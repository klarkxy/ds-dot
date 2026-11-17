/**
 * Extracted legacy Ticket operations kept solely for `legacyWorkEntries` test
 * compatibility and v1-v5 domain migration reads. Production routes all new
 * work through `WorkBook` (`Change` / `Run` / `Verification`).
 */
import { isAbsolute, resolve } from 'node:path'
import type { ModelChoice, SessionRole, Ticket, TicketAccess, TicketPriority, TicketStatus } from './contracts.ts'
import type { DotHost, WorkspaceRow } from './host.ts'
import { clip, formatAge } from './ledger.ts'
import { directoriesConflict } from './lock.ts'
import type { Notice } from './batcher.ts'
import type { PendingHub } from './pending.ts'
import { DotError, messageOf } from './service.ts'
import type { DotStore } from './store.ts'
import { QUEUED_INSTRUCTION_HINT, updateStatusRefusal } from './task-hints.ts'
import { modelKey } from './task-models.ts'
import type { TaskPresetChoice } from './task-presets.ts'
import { TICKET_STATUSES } from './ticket.ts'
import { DOT_TRACE, type DotTraceInput } from './trace.ts'

export interface LegacyTicketDeps {
  readonly store: DotStore
  readonly host: DotHost
  readonly pending: PendingHub
  now(): number
  assertOpen(): void
  isDot(sessionId: string | undefined): boolean
  homeWorkspace(): Promise<WorkspaceRow>
  taskPreset(requested?: string): Promise<TaskPresetChoice>
  taskModel(requested?: string): Promise<ModelChoice | undefined>
  notify(notice: Notice, urgent?: boolean): void
  notifyTaskHuman(ticketId: string, text: string): void
  announceLockFree(before: Ticket | undefined, after: Ticket): void
  emit(input: DotTraceInput): void
}

function humanTarget(store: DotStore, id: string): Ticket {
  const ticket = store.ticket(id)
  if (!ticket) throw new DotError('dot/invalid', `unknown task ${id}`)
  return ticket
}

export async function stopLegacyTicketSessions(deps: LegacyTicketDeps, ticket: Ticket): Promise<void> {
  const sessionIds = new Set([
    ...ticket.sessions.map(row => row.sessionId),
    ...deps.store.list().filter(row => row.ticketId === ticket.id).map(row => row.sessionId),
  ])
  const hostRows = await deps.host.listSessions(new AbortController().signal)
  for (const sessionId of sessionIds) {
    const actual = hostRows.find(row => row.sessionId === sessionId)
    if (actual?.archived && !actual.running) continue
    if (!deps.host.cancelAndWait || !(await deps.host.cancelAndWait(sessionId, 30_000))) {
      throw new DotError('dot/session-still-running', `could not confirm ${sessionId} stopped; ${ticket.id} retains its lock`)
    }
  }
}

export async function confirmLegacyTask(deps: LegacyTicketDeps, id: string): Promise<Ticket> {
  const before = humanTarget(deps.store, id)
  if (before.status !== 'draft') throw new DotError('dot/invalid', `${id} is not a draft`)
  const moved = await deps.store.moveTicket(id, 'todo', 'human', 'confirmed on the board', deps.now())
  deps.notifyTaskHuman(id, `the human confirmed draft ${id} "${moved.title}"`)
  return moved
}

export async function deleteLegacyDraft(deps: LegacyTicketDeps, id: string): Promise<boolean> {
  const before = humanTarget(deps.store, id)
  if (before.status !== 'draft') throw new DotError('dot/invalid', `${id} is not a draft`)
  await deps.store.deleteTicket(id)
  deps.notify({ kind: 'task-human', ticketId: id, sessionId: deps.store.dotSessionId ?? '', text: `the human deleted draft ${id} "${before.title}"`, at: deps.now() })
  return true
}

export async function cancelLegacyTask(deps: LegacyTicketDeps, id: string): Promise<Ticket> {
  const before = humanTarget(deps.store, id)
  if (before.status === 'done' || before.status === 'cancelled') throw new DotError('dot/invalid', `${id} is already ${before.status}`)
  await stopLegacyTicketSessions(deps, before)
  const moved = await deps.store.moveTicket(id, 'cancelled', 'human', 'cancelled on the board', deps.now())
  deps.notifyTaskHuman(id, `the human cancelled task ${id} "${moved.title}" (was ${before.status})`)
  deps.announceLockFree(before, moved)
  return moved
}

export async function reviewLegacyTask(deps: LegacyTicketDeps, id: string, pass: boolean, note?: string): Promise<Ticket> {
  const before = humanTarget(deps.store, id)
  if (before.status !== 'review') throw new DotError('dot/invalid', `${id} is not waiting for review`)
  const text = clip((note ?? '').replace(/\s+/g, ' ').trim(), 600)
  const at = deps.now()
  if (pass) {
    if (before.access === 'write') await stopLegacyTicketSessions(deps, before)
    const moved = await deps.store.moveTicket(id, 'done', 'human', text || 'approved on the board', at)
    deps.notifyTaskHuman(id, `the human approved task ${id} "${moved.title}" as done${text ? `: ${text}` : ''}`)
    deps.announceLockFree(before, moved)
    return moved
  }
  await deps.store.moveTicket(id, 'active', 'human', text || 'sent back on the board', at)
  const moved = await deps.store.noteTicket(id, { n: (before.rounds.at(-1)?.n ?? 0) + 1, at, role: 'review', summary: text || 'Sent back by the human.', verdict: 'fail' })
  deps.notifyTaskHuman(id, `the human sent task ${id} "${moved.title}" back to active${text ? `: ${text}` : ''}`)
  return moved
}

export async function setLegacyTaskPriority(deps: LegacyTicketDeps, id: string, priority: TicketPriority): Promise<Ticket> {
  humanTarget(deps.store, id)
  if (priority !== 1 && priority !== 2 && priority !== 3) throw new DotError('dot/invalid', 'invalid priority')
  return deps.store.updateTicket(id, { priority }, deps.now())
}

export async function assertLegacyExecutable(deps: LegacyTicketDeps, ticket: Ticket, mode: 'start' | 'send', signal: AbortSignal, sessionId?: string): Promise<boolean> {
  if (ticket.status !== 'active' && ticket.status !== 'review' && !(mode === 'start' && ticket.status === 'todo')) {
    throw new DotError('dot/task-closed', `task ${ticket.id} is ${ticket.status}; move it to an executable state first`)
  }
  const rows = await deps.host.listSessions(signal)
  const runningTarget = !!sessionId && (deps.host.isRunning(sessionId) || rows.some(row => row.sessionId === sessionId && row.running))
  if (sessionId) {
    const recorded = deps.store.task(sessionId)?.cwd
    const actual = rows.find(row => row.sessionId === sessionId)?.cwd
    const normalize = (dir: string) => process.platform === 'win32' ? resolve(dir).toLowerCase() : resolve(dir)
    if (!recorded || normalize(recorded) !== normalize(ticket.dir) || (actual && normalize(actual) !== normalize(ticket.dir))) {
      throw new DotError('dot/invalid', `session ${sessionId} does not use task ${ticket.id}'s current directory`)
    }
  }
  if (ticket.access !== 'write') return runningTarget
  const holders = deps.store.ticketLockHolders(ticket.dir, ticket.id)
  if (holders.length) {
    deps.emit({ event: DOT_TRACE.lockConflict, message: `Directory of ${ticket.id} is held.`, ticketId: ticket.id, data: { holders: holders.map(row => row.id).join(',') } })
    throw new DotError('dot/locked', `directory held by ${holders.map(row => `${row.id} "${row.title}" (${row.status})`).join(', ')}`)
  }
  const running = rows.find(row => row.sessionId !== sessionId && row.running && !row.archived && (() => {
    const owner = deps.store.ticketForSession(row.sessionId)
    const dir = row.cwd ?? deps.store.task(row.sessionId)?.cwd
    return !!owner && !!dir && directoriesConflict(dir, ticket.dir)
  })())
  if (running) {
    deps.emit({ event: DOT_TRACE.lockConflict, message: 'A conflicting write session is still running.', ticketId: ticket.id, sessionId: running.sessionId })
    throw new DotError('dot/locked', `conflicting write session ${running.sessionId} is still running`)
  }
  return runningTarget
}

export async function manageLegacyTicket(deps: LegacyTicketDeps, args: Record<string, unknown>): Promise<string> {
  const text = (key: string) => typeof args[key] === 'string' ? args[key] as string : undefined
  const action = text('action')
  const id = text('task_id') ?? ''
  const store = deps.store
  if (action === 'list') {
    const tickets = store.listTickets().filter(ticket => !text('status') || ticket.status === text('status'))
    return tickets.length ? tickets.map(ticket => `${ticket.id} ${ticket.status.toUpperCase()} P${ticket.priority} ${ticket.access} ${ticket.dir} "${ticket.title}"`).join('\n') : 'No tasks.'
  }
  if (action === 'read') {
    const ticket = store.ticket(id)
    if (!ticket) throw new DotError('dot/invalid', `unknown task ${id}`)
    return JSON.stringify(ticket)
  }
  if (action === 'delete') return await store.deleteTicket(id) ? `Deleted ${id}.` : `Unknown task ${id}.`
  if (action === 'move') {
    const before = store.ticket(id)
    const target = (text('to') ?? '') as TicketStatus
    if (!TICKET_STATUSES.includes(target) || !text('reason')?.trim()) throw new DotError('dot/invalid', 'a valid status and reason are required')
    if (before && before.access === 'write' && (before.status === 'active' || before.status === 'review') && target !== 'active' && target !== 'review') {
      await stopLegacyTicketSessions(deps, before)
    }
    const moved = await store.moveTicket(id, target, 'dot', text('reason') ?? '', deps.now())
    deps.emit({ event: DOT_TRACE.ticketMoved, message: `Task ${moved.id} moved from ${before?.status ?? 'new'} to ${moved.status}.`, ticketId: moved.id, data: { from: before?.status ?? '', to: moved.status, by: 'dot' } })
    deps.announceLockFree(before, moved)
    return JSON.stringify(moved)
  }
  if (action === 'note') {
    const ticket = store.ticket(id)
    if (!ticket) throw new DotError('dot/invalid', `unknown task ${id}`)
    const role = text('role')
    const verdict = text('verdict')
    if (!['work', 'rework', 'review'].includes(role ?? '') || (verdict && !['pass', 'fail'].includes(verdict))) throw new DotError('dot/invalid', 'invalid role or verdict')
    const noted = await store.noteTicket(id, {
      n: (ticket.rounds.at(-1)?.n ?? 0) + 1,
      at: deps.now(),
      role: role as SessionRole,
      summary: text('summary') ?? '',
      ...(text('session_id') ? { sessionId: text('session_id')! } : {}),
      ...(verdict ? { verdict: verdict as 'pass' | 'fail' } : {}),
    })
    deps.emit({ event: DOT_TRACE.ticketNoted, message: `Recorded a ${role} round on ${id}.`, ticketId: id, data: { role: role ?? '', ...(verdict ? { verdict } : {}) } })
    return JSON.stringify(noted)
  }
  const access = text('access')
  const priority = args.priority
  if (access !== undefined && access !== 'read' && access !== 'write') throw new DotError('dot/invalid', 'invalid access')
  if (priority !== undefined && priority !== 1 && priority !== 2 && priority !== 3) throw new DotError('dot/invalid', 'invalid priority')
  const workspaceId = text('workspace_id')
  const workspace = workspaceId ? deps.host.listWorkspaces().find(row => row.id === workspaceId) : undefined
  if (workspaceId && !workspace) throw new DotError('dot/unknown-workspace', `no workspace ${workspaceId}`)
  const patch = {
    ...(text('title') !== undefined ? { title: text('title')! } : {}),
    ...(text('goal') !== undefined ? { goal: text('goal')! } : {}),
    ...(text('deliverable') !== undefined ? { deliverable: text('deliverable')! } : {}),
    ...(text('acceptance') !== undefined ? { acceptance: text('acceptance')! } : {}),
    ...(text('dir') || workspace ? { dir: workspace?.path ?? text('dir')! } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(access ? { access: access as TicketAccess } : {}),
    ...(priority !== undefined ? { priority: priority as TicketPriority } : {}),
    ...(typeof args.human_review === 'boolean' ? { humanReview: args.human_review } : {}),
  }
  if (patch.dir !== undefined && !isAbsolute(patch.dir)) throw new DotError('dot/invalid', 'directory must be absolute')
  if (action === 'update') {
    const target = text('to')
    if (target) {
      const current = store.ticket(id)
      if (!current) throw new DotError('dot/invalid', `unknown task ${id}`)
      deps.emit({ event: DOT_TRACE.ticketUpdateRejected, message: `Update refused; ${current.id} is still ${current.status}.`, ticketId: current.id, data: { status: current.status, to: target } })
      throw new DotError('dot/invalid', updateStatusRefusal(current.id, current.status, target))
    }
    return JSON.stringify(await store.updateTicket(id, patch, deps.now()))
  }
  if (action !== 'create') throw new DotError('dot/invalid', 'unknown task action')
  if (!patch.title?.trim() || !patch.goal?.trim() || !access) throw new DotError('dot/invalid', 'title, goal and access are required')
  const home = patch.dir ? undefined : await deps.homeWorkspace()
  const created = await store.createTicket({ ...patch, title: patch.title, goal: patch.goal, access: access as TicketAccess, dir: patch.dir ?? home!.path, ...(home ? { workspaceId: home.id } : {}), draft: args.draft === true, at: deps.now() })
  deps.emit({ event: DOT_TRACE.ticketCreated, message: `Created task ${created.id}.`, ticketId: created.id, data: { status: created.status, access: created.access } })
  return JSON.stringify(created)
}

export async function startLegacyTicketSession(
  deps: LegacyTicketDeps,
  input: { workspaceId?: string; cwd?: string; title: string; instruction: string; goal?: string; model?: string; preset?: string; taskId?: string; role?: SessionRole; access?: TicketAccess; acceptance?: string; deliverable?: string; priority?: TicketPriority; checkOnly?: boolean },
  signal: AbortSignal,
): Promise<string> {
  const instruction = input.instruction.trim()
  if (!instruction && !input.checkOnly) throw new DotError('dot/invalid', 'instruction must be non-empty')
  const existing = input.taskId ? deps.store.ticket(input.taskId) : undefined
  if (input.taskId && !existing) throw new DotError('dot/invalid', `unknown task ${input.taskId}`)
  let workspaceId = existing ? existing.workspaceId : input.workspaceId
  let cwd = existing?.dir ?? input.cwd
  if (workspaceId) {
    const workspace = deps.host.listWorkspaces().find(row => row.id === workspaceId)
    if (!workspace) throw new DotError('dot/unknown-workspace', `no workspace ${workspaceId}`)
    if (existing && workspace.path !== existing.dir) workspaceId = undefined
    else cwd = workspace.path
  } else if (!cwd) {
    const home = await deps.homeWorkspace()
    workspaceId = home.id
    cwd = home.path
  }
  if (!cwd || !isAbsolute(cwd)) throw new DotError('dot/invalid', 'directory must be absolute')
  if (input.role && !['work', 'rework', 'review'].includes(input.role)) throw new DotError('dot/invalid', 'invalid role')
  if (input.access && !['read', 'write'].includes(input.access)) throw new DotError('dot/invalid', 'invalid access')
  if (input.priority !== undefined && ![1, 2, 3].includes(input.priority)) throw new DotError('dot/invalid', 'invalid priority')
  const access = existing?.access ?? input.access ?? 'write'
  const conflicts = access === 'write' ? deps.store.ticketLockHolders(cwd, existing?.id) : []
  const otherRows = access === 'write'
    ? (await deps.host.listSessions(signal)).filter(row => !row.subagent && !row.blank && !row.archived && !deps.isDot(row.sessionId) && !deps.store.ticketForSession(row.sessionId) && row.cwd && directoriesConflict(row.cwd, cwd!))
    : []
  const titles = await deps.host.titles(otherRows.map(row => row.sessionId), signal).catch(() => new Map<string, string>())
  const others = otherRows.length ? `\nOther sessions in this directory that you did not start:\n${otherRows.map(row => `- ${row.sessionId} ${row.running ? 'RUNNING' : 'idle'} "${titles.get(row.sessionId) ?? '(untitled)'}" last active ${formatAge(deps.now() - row.updatedAt)} ago`).join('\n')}` : ''
  if (input.checkOnly) return `${conflicts.length ? `Directory locked by ${conflicts.map(row => `${row.id} "${row.title}" (${row.status})`).join(', ')}` : 'Directory lock is available.'}${others}`
  const ticket = existing ?? await deps.store.createTicket({
    title: input.title,
    goal: input.goal ?? instruction,
    dir: cwd,
    access,
    ...(workspaceId ? { workspaceId } : {}),
    ...(input.acceptance !== undefined ? { acceptance: input.acceptance } : {}),
    ...(input.deliverable !== undefined ? { deliverable: input.deliverable } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    at: deps.now(),
  })
  await assertLegacyExecutable(deps, ticket, 'start', signal)
  const preset = await deps.taskPreset(input.preset)
  const model = await deps.taskModel(input.model)
  const nextStatus = input.role === 'review' ? 'review' : ticket.status === 'todo' ? 'active' : ticket.status
  if (nextStatus !== ticket.status) await deps.store.moveTicket(ticket.id, nextStatus, 'dot', 'starting session', deps.now())
  const sessionId = await deps.host.createSession({ ...workspaceId ? { workspaceId } : { cwd }, ...preset.named && preset.id ? { preset: preset.id } : {} })
  deps.assertOpen()
  if (model) {
    try { await deps.host.selectModel(sessionId, model) } catch (error) {
      throw new DotError('dot/model-failed', `session ${sessionId} was created but could not be put on ${modelKey(model)}, so nothing was sent to it: ${messageOf(error)}`)
    }
  }
  deps.assertOpen()
  const permission = deps.store.settings.taskPermission
  const enforced = access === 'read' ? await deps.host.setReadOnly?.(sessionId) === true : false
  if (access === 'read' && !enforced) {
    if (nextStatus !== ticket.status) await deps.store.moveTicket(ticket.id, ticket.status, 'dot', 'read-only enforcement failed', deps.now())
    throw new DotError('dot/read-only-unavailable', `session ${sessionId} was created but read-only could not be enforced; no instruction was sent`)
  }
  if (access === 'write' && permission !== 'default' && !(await deps.host.setPermission(sessionId, permission))) {
    throw new DotError('dot/permission-failed', `session ${sessionId} was created but ${permission} could not be applied, so nothing was sent to it`)
  }
  await deps.store.track({ sessionId, origin: 'started', title: input.title, goal: input.goal ?? instruction, cwd, ...workspaceId ? { workspaceId } : {}, ...preset.id ? { preset: preset.id } : {}, at: deps.now() })
  await deps.store.attachTicketSession(ticket.id, sessionId, input.role ?? 'work', deps.now())
  try {
    deps.assertOpen()
    await deps.host.prompt(sessionId, instruction, 'queue', signal)
  } catch (error) {
    await deps.store.apply({ type: 'error', sessionId, at: deps.now(), message: `first instruction not delivered: ${messageOf(error)}` }, deps.pending.list())
    deps.emit({ event: DOT_TRACE.sessionSendRefused, level: 'warn', message: `The first instruction for ${sessionId} was not delivered.`, sessionId, ticketId: ticket.id, data: { code: 'dot/prompt-failed' } })
    throw new DotError('dot/prompt-failed', `session ${sessionId} was created but the instruction was not delivered: ${messageOf(error)}`)
  }
  const permissionText = access === 'read' && enforced ? 'read-only permissions' : access === 'read' ? `${permission} permissions; read-only was not enforced` : permission === 'default' ? 'host default permissions' : `${permission} permissions`
  deps.emit({ event: DOT_TRACE.sessionDispatched, message: `Started session ${sessionId} for ${ticket.id}.`, ticketId: ticket.id, sessionId, data: { role: input.role ?? 'work', access } })
  if (access === 'write') deps.emit({ event: DOT_TRACE.lockHeld, message: `Task ${ticket.id} holds ${cwd}.`, ticketId: ticket.id, data: { dir: cwd } })
  return `Started task ${sessionId} "${input.title}" (task ${ticket.id}) in ${cwd}${preset.named && preset.id ? ` with the ${preset.id} preset` : ''}${model ? ` on ${modelKey(model)}` : ''}. It runs with ${permissionText}.${others}\n${QUEUED_INSTRUCTION_HINT}`
}
