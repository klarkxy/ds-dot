import type { PendingView, TaskRecord, Ticket } from './contracts.ts'
import { lockHolders } from './lock.ts'
import { realTimer, type Timer } from './batcher.ts'

export interface IdleCandidate { readonly ticket: Ticket; readonly reason: string }
export function idleCandidates(tickets: readonly Ticket[], tasks: readonly TaskRecord[], pending: readonly PendingView[]): IdleCandidate[] {
  const out: IdleCandidate[] = []
  for (const ticket of tickets) {
    const running = ticket.sessions.some(row => tasks.some(task => task.sessionId === row.sessionId && task.status === 'running'))
    const waiting = ticket.sessions.some(row => pending.some(item => item.sessionId === row.sessionId))
    if (ticket.status === 'todo' && (ticket.access === 'read' || lockHolders(tickets, ticket.dir, ticket.id).length === 0)) out.push({ ticket, reason: 'ready to start' })
    else if (ticket.status === 'active' && !running && !waiting) out.push({ ticket, reason: 'no session running or waiting' })
    else if (ticket.status === 'review' && !running && !waiting && !ticket.humanReview) out.push({ ticket, reason: 'review has no running or waiting session' })
  }
  return out
}
export function idleFingerprint(candidates: readonly IdleCandidate[]): string {
  return candidates.map(row => `${row.ticket.id}:${row.ticket.status}:${row.reason}`).sort().join('|')
}
export class IdleChecker {
  private handle: unknown
  private previous = ''
  constructor(private readonly check: () => readonly IdleCandidate[], private readonly notify: (candidates: readonly IdleCandidate[]) => void, private readonly timer: Timer = realTimer, private readonly onRepeat?: () => void) {}
  cancel(): void { if (this.handle !== undefined) this.timer.clear(this.handle); this.handle = undefined }
  arm(minutes: number, elapsedMs = 0): void {
    this.cancel()
    if (minutes <= 0) return
    this.handle = this.timer.set(() => { this.handle = undefined; this.run() }, Math.max(0, minutes * 60_000 - elapsedMs))
  }
  run(): void {
    const candidates = this.check()
    const fingerprint = idleFingerprint(candidates)
    if (!fingerprint || fingerprint === this.previous) {
      if (fingerprint && fingerprint === this.previous) this.onRepeat?.()
      return
    }
    this.previous = fingerprint
    this.notify(candidates)
  }
}
