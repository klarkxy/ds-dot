/**
 * Ordinary-session execution for a reserved run. Host calls stay outside the
 * record lock. Accepted means the host took the message, not that the work finished.
 */
import type { DotHost } from './host.ts'
import { scopeWrites, type RunCursor, type RunPhase, type RunRecord, type WorkBook, type WorkRefusal } from './work.ts'

export interface FoundSession { readonly cwd?: string; readonly preset?: string }
export interface CreatedSession { readonly sessionId: string; readonly cwd?: string; readonly preset?: string }
export interface StopReport {
  readonly cancelAccepted: boolean
  readonly queueCleared: boolean
  readonly idle: boolean
  readonly jobsSettled: boolean | 'unknown'
}
export interface RelayEvent { readonly type?: string; readonly data?: unknown }

export interface RunSessionHost {
  findSession(sessionId: string): Promise<FoundSession | undefined>
  createSession(input: { readonly sessionId: string; readonly cwd: string; readonly preset?: string }): Promise<CreatedSession>
  /** Set and verify the run's permission. `ok` is the only result that may deliver. */
  prepareAccess(sessionId: string, access: 'read' | 'write'): Promise<'ok' | 'rejected' | 'unknown'>
  prompt(sessionId: string, text: string, requestId: string): Promise<'accepted' | 'rejected'>
  /** Authoritative first-prompt receipts for one request id. Undefined means the log could not be read. */
  promptReceipts(sessionId: string, requestId: string, text: string): Promise<number | undefined>
  relay(sessionId: string, senderId: string, text: string, deliveryId: string): Promise<'accepted' | 'rejected'>
  /** Authoritative input inserts for one delivery. Undefined means the log could not be read. */
  relayInserts(sessionId: string, deliveryId: string, senderId: string, text: string): Promise<number | undefined>
  /** Select the model after the session identity is confirmed and before the first prompt. */
  selectModel?(sessionId: string, choice: { readonly provider: string; readonly model: string }): Promise<void>
  stop(sessionId: string): Promise<StopReport>
  watch?(sessionId: string): Promise<RunCursor>
}

export async function launchReservedRun(book: WorkBook, host: RunSessionHost, runId: string, text: string, preset?: string, model?: { readonly provider: string; readonly model: string }, onReady?: (runId: string) => Promise<void>): Promise<{ readonly ok: true; readonly phase: RunRecord['phase']; readonly requestId?: string } | WorkRefusal> {
  const run = book.run(runId)
  if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
  if (run.phase !== 'reserved') return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
  if (run.creation === 'rejected') return { ok: false, code: 'closed-run', message: `${runId} session identity was rejected` }
  const initial = run.deliveries.find(item => item.kind === 'initial')
  const promptOwned = initial?.status === 'unknown' || initial?.status === 'accepted' || initial?.hostRequestId !== undefined
  let actualId = run.sessionId ?? run.requestedSessionId
  let liveClaim = false
  try {
  if (!promptOwned && run.creation !== 'confirmed') {
    const claim = await book.claimSession(runId, preset)
    if (!claim.ok) return claim
    if (!claim.owned) return { ok: false, code: 'unknown', message: `${runId} already has a host call in progress` }
    liveClaim = true
    let located: FoundSession | undefined
    try {
      located = await host.findSession(run.requestedSessionId)
    } catch {
      await book.markCreation(runId, 'unknown')
      return { ok: false, code: 'unknown', message: `${runId} session lookup failed; no second session was created` }
    }
    const afterLookup = book.dispatchAllowed(runId)
    if (!afterLookup.ok) {
      if (!located) {
        await book.markCreation(runId, 'intent')
        const current = book.run(runId)
        if (current?.phase === 'settling') await book.releaseUnsent(runId, current.updatedAt)
      } else await book.noteHostSession(runId, run.requestedSessionId)
      return afterLookup
    }
    let cwd: string | undefined
    let seenPreset: string | undefined
    if (!located) {
      const current = book.run(runId)
      if (current?.creation === 'unknown') return { ok: false, code: 'unknown', message: `${runId} was not found; a second session was not created` }
      try {
        const pinned = book.run(runId)?.expectedPreset
        const created = await host.createSession({ sessionId: run.requestedSessionId, cwd: run.cwd, ...(pinned !== undefined ? { preset: pinned } : {}) })
        actualId = created.sessionId
        cwd = created.cwd
        seenPreset = created.preset
      } catch {
        await book.markCreation(runId, 'unknown')
        return { ok: false, code: 'unknown', message: `${runId} session create failed; it was not retried with a new id` }
      }
      const afterCreate = book.dispatchAllowed(runId)
      if (!afterCreate.ok) {
        await book.noteHostSession(runId, actualId)
        return afterCreate
      }
    } else {
      cwd = located.cwd
      seenPreset = located.preset
    }
    const confirmed = await book.confirmSession(runId, { sessionId: actualId, ...(cwd !== undefined ? { cwd } : {}), ...(seenPreset !== undefined ? { preset: seenPreset } : {}) })
    if (!confirmed.ok) return confirmed
    if (!confirmed.prompt) {
      const code = confirmed.run.creation === 'unknown' ? 'unknown' as const : 'closed-run' as const
      return { ok: false, code, message: `${runId} kept the unexpected session and was not prompted` }
    }
    actualId = confirmed.run.sessionId ?? actualId
  }
  // Own the session after its identity is confirmed and before the first prompt, so a completion or error during that prompt is not dropped. A rejected or unknown identity is not ours.
  const ready = book.run(runId)
  if (onReady && ready?.creation === 'confirmed' && ready.sessionId && ready.sessionId === ready.requestedSessionId) await onReady(runId)
  if (model) {
    if (!host.selectModel) return { ok: false, code: 'closed-run', message: `${runId} cannot select a model; nothing was sent` }
    try { await host.selectModel(actualId, model) } catch {
      return { ok: false, code: 'closed-run', message: `${runId} was created but the model was not selected; nothing was sent` }
    }
    const afterModel = book.dispatchAllowed(runId)
    if (!afterModel.ok) return afterModel
  }
  const access = await ensureAccess(book, host, runId)
  if (access) return access
  const armed = await book.claimPrompt(runId, text)
  if (!armed.ok) return armed
  if (!armed.send) {
    const proved = await proveInitial(book, host, runId, armed.deliveryId, actualId, armed.requestId, armed.text)
    if (proved) return proved
    return { ok: false, code: 'unknown', message: `${runId} initial delivery is already in flight` }
  }
  const beforeSend = book.dispatchAllowed(runId)
  if (!beforeSend.ok) return beforeSend
  let status: 'accepted' | 'rejected' | 'unknown'
  try {
    status = await host.prompt(actualId, armed.text, armed.requestId)
  } catch {
    status = 'unknown'
  }
  const gate = book.dispatchAllowed(runId)
  const settled = await book.settleDelivery(runId, armed.deliveryId, status === 'unknown' ? 'unknown' : status)
  if (!settled.ok) return settled
  if (!gate.ok) return gate
  return { ok: true, phase: settled.phase, ...(status === 'accepted' ? { requestId: armed.requestId } : {}) }
  } finally {
    if (liveClaim) book.releaseLiveSessionClaim(runId)
  }
}

export async function supplementRun(book: WorkBook, host: RunSessionHost, runId: string, text: string, senderId: string, at = Date.now(), expected?: { readonly inputRef: string; readonly inputRevision: number }): Promise<{ readonly ok: true; readonly phase: RunRecord['phase'] } | WorkRefusal> {
  const run = book.run(runId)
  if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
  if (run.phase !== 'active') return { ok: false, code: 'closed-run', message: `${runId} is ${run.phase}` }
  const claim = await book.claimRelay(runId, text, senderId, at, expected)
  if (!claim.ok) return claim
  const proved = await settleRelay(book, host, runId, claim.delivery.id, claim.delivery.targetSessionId, senderId, claim.delivery.contentRef, claim.send, at)
  if (!proved.ok) return proved
  return { ok: true, phase: proved.phase }
}

/** Close an existing relay delivery from the target log. An intent may be sent once; unknown is never sent again. */
async function settleRelay(book: WorkBook, host: RunSessionHost, runId: string, deliveryId: string, sessionId: string, senderId: string, text: string, allowSend: boolean, at: number): Promise<{ readonly ok: true; readonly phase: RunPhase } | WorkRefusal> {
  let before: number | undefined
  try { before = await host.relayInserts(sessionId, deliveryId, senderId, text) } catch { before = undefined }
  if (before === 1) {
    const settled = await book.settleDelivery(runId, deliveryId, 'accepted', undefined, at)
    return settled.ok ? { ok: true, phase: settled.phase } : settled
  }
  if (before !== 0 || !allowSend) {
    const settled = await book.settleDelivery(runId, deliveryId, 'unknown', undefined, at)
    return settled.ok ? { ok: false, code: 'unknown', message: `${runId} delivery ${deliveryId} was not proved` } : settled
  }
  const access = await ensureAccess(book, host, runId)
  if (access) return access
  const marked = await book.settleDelivery(runId, deliveryId, 'unknown', undefined, at)
  if (!marked.ok) return marked
  const beforeSend = book.dispatchAllowed(runId)
  if (!beforeSend.ok) return beforeSend
  let call: 'sent' | 'rejected' | 'unknown' = 'sent'
  book.claimLiveRelay(deliveryId)
  try {
    const status = await host.relay(sessionId, senderId, text, deliveryId)
    call = status === 'rejected' ? 'rejected' : 'sent'
  } catch { call = 'unknown' }
  finally { book.releaseLiveRelay(deliveryId) }
  let after: number | undefined
  try { after = await host.relayInserts(sessionId, deliveryId, senderId, text) } catch { after = undefined }
  const gate = book.dispatchAllowed(runId)
  const status = after === 1 && gate.ok ? 'accepted' : after === 0 && call === 'rejected' && gate.ok ? 'rejected' : 'unknown'
  const settled = await book.settleDelivery(runId, deliveryId, status, undefined, at)
  if (!settled.ok) return settled
  if (!gate.ok) return gate
  if (status === 'unknown') return { ok: false, code: 'unknown', message: `${runId} delivery ${deliveryId} was not proved` }
  return { ok: true, phase: settled.phase }
}

async function ensureAccess(book: WorkBook, host: RunSessionHost, runId: string): Promise<WorkRefusal | undefined> {
  const run = book.run(runId)
  if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
  const allowed = book.dispatchAllowed(runId)
  if (!allowed.ok) return allowed
  const access = run.access ?? (scopeWrites(run.writeScope) ? 'write' : 'read')
  let result: 'ok' | 'rejected' | 'unknown'
  try { result = await host.prepareAccess(run.sessionId ?? run.requestedSessionId, access) } catch { result = 'unknown' }
  if (result !== 'ok') return { ok: false, code: result === 'rejected' ? 'closed-run' : 'unknown', message: `${runId} permission was ${result}` }
  const again = book.dispatchAllowed(runId)
  return again.ok ? undefined : again
}

export async function cancelWork(book: WorkBook, host: RunSessionHost, changeId: string, at = Date.now()): Promise<{ readonly ok: true; readonly runs: readonly { readonly id: string; readonly released: boolean }[] } | WorkRefusal> {
  const prepared = await book.prepareCancel(changeId, at)
  if (!prepared.ok) return prepared
  const runs: { id: string; released: boolean }[] = []
  for (const run of prepared.runs) {
    const released = await releaseStopped(book, host, run.id, run.updatedAt, 'stopped', at)
    runs.push({ id: run.id, released })
  }
  return { ok: true, runs }
}

/** Move one open run through settling without cancelling its change. Idle alone does not finish it. */
export async function finishWork(book: WorkBook, host: RunSessionHost, runId: string, phase: 'completed' | 'failed', at = Date.now()): Promise<{ readonly ok: true; readonly phase: RunPhase } | WorkRefusal> {
  const current = book.run(runId)
  const owner = current ? book.change(current.changeId) : undefined
  // A review keeps the workspace until closeout. finish must not release it or look like a missing stop.
  if (current?.kind === 'review' && owner && owner.control !== 'cancelled' && !owner.closeout && current.phase !== 'completed' && current.phase !== 'failed' && current.phase !== 'stopped') {
    return { ok: false, code: 'unknown', message: `${runId} stays reserved until closeout; use action=closeout or action=reject for the review instead of finish` }
  }
  const prepared = await book.prepareFinish(runId, phase, at)
  if (!prepared.ok) return prepared
  const released = await releaseStopped(book, host, runId, prepared.updatedAt, phase, at)
  if (!released) return { ok: false, code: 'unknown', message: `${runId} is not confirmed ${phase}` }
  return { ok: true, phase }
}

async function releaseStopped(book: WorkBook, host: RunSessionHost, runId: string, seenUpdatedAt: number, phase: 'completed' | 'failed' | 'stopped', at: number): Promise<boolean> {
  const run = book.run(runId)
  if (!run) return false
  // A found session whose cwd, preset, or identity was not proved is not this run.
  // Stopping it would act on someone else's session, and the scope stays occupied.
  if (run.creation === 'rejected') return false
  if (run.creation === 'unknown') {
    if (phase === 'stopped' && run.sessionId === undefined) {
      let confirmedAbsent = false
      try { confirmedAbsent = await host.findSession(run.requestedSessionId) === undefined } catch { confirmedAbsent = false }
      if (confirmedAbsent) {
        const released = await book.releaseAbsentUnknown(runId, seenUpdatedAt, at)
        return released.ok
      }
    }
    return false
  }
  const sessionId = run.sessionId ?? run.requestedSessionId
  let absent = false
  try { absent = await host.findSession(sessionId) === undefined } catch { absent = false }
  if (absent && phase === 'stopped') {
    const unsent = await book.releaseUnsent(runId, seenUpdatedAt, at)
    if (unsent.ok) return true
  }
  let report: StopReport
  try { report = await host.stop(sessionId) } catch {
    report = { cancelAccepted: false, queueCleared: false, idle: false, jobsSettled: 'unknown' }
  }
  const evidence = report.queueCleared && report.idle && report.jobsSettled === true
    ? { queueCleared: true as const, agentIdle: true as const, jobsSettled: true as const }
    : undefined
  const finished = await book.finishSettled(runId, seenUpdatedAt, phase, evidence, at)
  return finished.ok
}

/** Record a cursor. Idle is not completion, and a terminal run does not move. */
export async function observeRun(book: WorkBook, host: RunSessionHost, runId: string, at = Date.now()): Promise<{ readonly ok: true; readonly phase: RunPhase } | WorkRefusal> {
  const run = book.run(runId)
  if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
  const sessionId = run.sessionId ?? run.requestedSessionId
  let cursor: RunCursor = { queue: 'unknown' }
  if (host.watch) {
    try { cursor = { queue: 'unknown', ...await host.watch(sessionId) } } catch { cursor = { queue: 'unknown' } }
  }
  return book.noteCursor(runId, cursor, at)
}

/**
 * Recovery reads the reserved id. It never creates another session and never
 * sends the first prompt.
 */
export async function reconcileReserved(book: WorkBook, host: RunSessionHost, runId: string): Promise<{ readonly ok: true; readonly action: 'absent' | 'confirmed' | 'held' | 'left'; readonly created: false; readonly prompted: false } | WorkRefusal> {
  const run = book.run(runId)
  if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
  if (run.phase !== 'reserved') return { ok: true, action: 'left', created: false, prompted: false }
  let located: FoundSession | undefined
  try { located = await host.findSession(run.requestedSessionId) } catch {
    const marked = await book.markCreation(runId, 'unknown')
    if (!('id' in marked)) return marked
    return { ok: false, code: 'unknown', message: `${runId} session lookup failed; no second session was created` }
  }
  if (!located) {
    if (run.creation === 'unknown' && run.sessionId === undefined) {
      const reset = await book.abandonUnknownCreation(runId)
      if (!reset.ok) return reset
    }
    return { ok: true, action: 'absent', created: false, prompted: false }
  }
  const confirmed = await book.confirmSession(runId, {
    sessionId: run.requestedSessionId,
    ...(located.cwd !== undefined ? { cwd: located.cwd } : {}),
    ...(located.preset !== undefined ? { preset: located.preset } : {}),
  })
  if (!confirmed.ok) return confirmed
  return { ok: true, action: confirmed.prompt ? 'confirmed' : 'held', created: false, prompted: false }
}

/** Recover a reserved or active run without creating a session or sending again. A cancelled change pulls every open run back into its stop. */
export async function reconcileRun(book: WorkBook, host: RunSessionHost, runId: string, at = Date.now()): Promise<{ readonly ok: true; readonly action: string; readonly created: false; readonly prompted: false } | WorkRefusal> {
  const run = book.run(runId)
  if (!run) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
  if (run.phase === 'completed' || run.phase === 'failed' || run.phase === 'stopped') return { ok: true, action: 'left', created: false, prompted: false }
  const adopted = await book.adoptCancel(runId, at)
  if (!adopted.ok) return adopted
  await recoverLeftoverClaim(book, host, runId, at)
  await proveOpenDeliveries(book, host, runId, at)
  const current = book.run(runId)
  if (!current) return { ok: false, code: 'missing', message: `unknown run ${runId}` }
  if (current.phase === 'settling') return continueClose(book, host, runId, at)
  if (current.phase === 'reserved') {
    const session = await reconcileReserved(book, host, runId)
    if (!session.ok) return session
    return session
  }
  await observeRun(book, host, runId, at)
  return { ok: true, action: 'reconciled', created: false, prompted: false }
}

async function recoverLeftoverClaim(book: WorkBook, host: RunSessionHost, runId: string, at: number): Promise<void> {
  const run = book.run(runId)
  if (!run || book.liveSessionClaim(runId)) return
  if (run.actionClaim !== 'session' && run.creation !== 'inflight') return
  let located: FoundSession | undefined
  try { located = await host.findSession(run.requestedSessionId) } catch { return }
  if (!located) {
    await book.abandonSessionClaim(runId, at)
    return
  }
  await book.settleSessionClaim(runId, {
    sessionId: run.requestedSessionId,
    ...(located.cwd !== undefined ? { cwd: located.cwd } : {}),
    ...(located.preset !== undefined ? { preset: located.preset } : {}),
  }, at)
}

async function proveOpenDeliveries(book: WorkBook, host: RunSessionHost, runId: string, at: number): Promise<void> {
  const run = book.run(runId)
  if (!run) return
  for (const delivery of run.deliveries) {
    if (delivery.status !== 'unknown' && delivery.status !== 'intent') continue
    if (delivery.kind === 'initial') {
      if (!delivery.hostRequestId) continue
      await proveInitial(book, host, runId, delivery.id, delivery.targetSessionId, delivery.hostRequestId, delivery.contentRef, at)
      continue
    }
    let count: number | undefined
    try { count = await host.relayInserts(delivery.targetSessionId, delivery.id, delivery.source, delivery.contentRef) } catch { count = undefined }
    if (count === 1) await book.settleDelivery(runId, delivery.id, 'accepted', undefined, at)
  }
}

async function proveInitial(book: WorkBook, host: RunSessionHost, runId: string, deliveryId: string, sessionId: string, requestId: string, text: string, at = Date.now()): Promise<{ readonly ok: true; readonly phase: RunPhase; readonly requestId: string } | undefined> {
  let count: number | undefined
  try { count = await host.promptReceipts(sessionId, requestId, text) } catch { count = undefined }
  if (count !== 1) return undefined
  const settled = await book.settleDelivery(runId, deliveryId, 'accepted', undefined, at)
  return settled.ok ? { ok: true, phase: settled.phase, requestId } : undefined
}

async function continueClose(book: WorkBook, host: RunSessionHost, runId: string, at: number): Promise<{ readonly ok: true; readonly action: string; readonly created: false; readonly prompted: false }> {
  const current = book.run(runId)
  if (!current || current.phase !== 'settling') return { ok: true, action: 'reconciled', created: false, prompted: false }
  if (current.kind === 'review') {
    const change = book.change(current.changeId)
    if (change?.closeout) {
      const resumed = await book.resumeCloseout(current.changeId, at)
      return { ok: true, action: resumed.ok && resumed.released ? 'closed' : 'held', created: false, prompted: false }
    }
    if (change?.control !== 'cancelled') {
      // A review waiting for accept keeps the workspace. Generic finish must not release it.
      if (current.creation !== 'confirmed') return { ok: true, action: 'held', created: false, prompted: false }
      const sessionId = current.sessionId ?? current.requestedSessionId
      let report: StopReport
      try { report = await host.stop(sessionId) } catch {
        report = { cancelAccepted: false, queueCleared: false, idle: false, jobsSettled: 'unknown' }
      }
      if (report.queueCleared && report.idle && report.jobsSettled === true) {
        await book.holdReview(runId, { queueCleared: true, agentIdle: true, jobsSettled: true }, at)
      }
      return { ok: true, action: 'held', created: false, prompted: false }
    }
  }
  if (current.creation === 'rejected') {
    return { ok: true, action: 'held', created: false, prompted: false }
  }
  if (current.creation === 'unknown') {
    if (current.closeIntent === 'stopped' && current.sessionId === undefined) {
      let confirmedAbsent = false
      try { confirmedAbsent = await host.findSession(current.requestedSessionId) === undefined } catch { confirmedAbsent = false }
      if (confirmedAbsent) {
        const released = await book.releaseAbsentUnknown(runId, current.updatedAt, at)
        if (released.ok) return { ok: true, action: 'closed', created: false, prompted: false }
      }
    }
    return { ok: true, action: 'held', created: false, prompted: false }
  }
  const sessionId = current.sessionId ?? current.requestedSessionId
  if (!current.closeIntent) {
    try { await host.stop(sessionId) } catch { /* a stop that cannot be read stays occupying */ }
    return { ok: true, action: 'held', created: false, prompted: false }
  }
  const released = await releaseStopped(book, host, runId, current.updatedAt, current.closeIntent, at)
  return { ok: true, action: released ? 'closed' : 'held', created: false, prompted: false }
}

/** Count authoritative first-prompt receipts. One message id is one receipt even when the host logs it twice. */
export function countPromptReceipts(events: readonly RelayEvent[], requestId: string, text: string): number {
  return countMessages(events, (row, source) => {
    if (!source || (source.kind !== 'user' && source.kind !== 'retry') || source.rpcId !== requestId) return false
    return textOf(row.content) === text
  })
}

/** Count authoritative relay inserts. A user prompt does not qualify. */
export function countRelayInserts(events: readonly RelayEvent[], deliveryId: string, senderId: string, text: string): number {
  return countMessages(events, (row, source) => {
    if (source?.kind !== 'agent-message' || source.form !== 'relay') return false
    if (source.deliveryId !== deliveryId || source.senderSessionId !== senderId) return false
    return textOf(row.content) === text
  })
}

function countMessages(events: readonly RelayEvent[], accept: (row: Record<string, unknown>, source: Record<string, unknown> | undefined) => boolean): number {
  const seen = new Set<string>()
  let anonymous = 0
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced' && event.type !== 'user/message') continue
    const data = recordOf(event.data)
    const inserted = event.type === 'agent/inbox/spliced' ? asArray(data?.inserted) : data ? [data] : []
    for (const message of inserted) {
      const row = recordOf(message)
      if (!row || !accept(row, recordOf(row.source))) continue
      const id = typeof row.id === 'string' && row.id ? row.id : undefined
      if (!id) { anonymous += 1; continue }
      if (seen.has(id)) continue
      seen.add(id)
    }
  }
  return seen.size + anonymous
}

/** Adapt the public host. Relay acceptance still has to be proved from the log. */
export function bindRunSession(host: DotHost, writablePreset = 'default'): RunSessionHost {
  return {
    async findSession(sessionId) {
      if (!host.findSession) throw new Error('session lookup is unavailable')
      return host.findSession(sessionId)
    },
    async createSession(input) {
      const sessionId = await host.createSession({ cwd: input.cwd, sessionId: input.sessionId, ...(input.preset ? { preset: input.preset } : {}) })
      const found = host.findSession ? await host.findSession(sessionId).catch(() => undefined) : undefined
      return { sessionId, ...(found?.cwd !== undefined ? { cwd: found.cwd } : {}), ...(found?.preset !== undefined ? { preset: found.preset } : {}) }
    },
    async prepareAccess(sessionId, access) {
      try {
        if (access === 'read') {
          if (!host.setReadOnly || !host.verifyTaskPermission) return 'unknown'
          if (!await host.setReadOnly(sessionId)) return 'rejected'
          return await host.verifyTaskPermission(sessionId, 'read', 'read-only') ? 'ok' : 'rejected'
        }
        if (!host.setWritable || !host.verifyTaskPermission) return 'unknown'
        if (!await host.setWritable(sessionId, writablePreset)) return 'rejected'
        return await host.verifyTaskPermission(sessionId, 'write', writablePreset) ? 'ok' : 'rejected'
      } catch { return 'unknown' }
    },
    async prompt(sessionId, text, requestId) {
      await host.prompt(sessionId, text, 'queue', AbortSignal.timeout(120_000), requestId)
      return 'accepted'
    },
    async promptReceipts(sessionId, requestId, text) {
      try { return countPromptReceipts(await host.readEvents(sessionId), requestId, text) } catch { return undefined }
    },
    async relay(sessionId, senderId, text, deliveryId) {
      await host.relay(sessionId, senderId, text, deliveryId)
      return 'accepted'
    },
    async relayInserts(sessionId, deliveryId, senderId, text) {
      try { return countRelayInserts(await host.readEvents(sessionId), deliveryId, senderId, text) } catch { return undefined }
    },
    async selectModel(sessionId, choice) { await host.selectModel(sessionId, choice) },
    async stop(sessionId) {
      if (!host.stopActivity) return { cancelAccepted: false, queueCleared: false, idle: false, jobsSettled: 'unknown' }
      return host.stopActivity(sessionId)
    },
    async watch(sessionId) {
      if (!host.watchSession) return { queue: 'unknown' }
      return host.watchSession(sessionId)
    },
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    const row = recordOf(block)
    return row?.type === 'text' && typeof row.text === 'string' ? row.text : ''
  }).join('')
}
