import type { PendingView, TaskRecord } from './contracts.ts'
import { realTimer, type Timer } from './batcher.ts'

export interface WorkIdleItem {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly priority: 1 | 2 | 3
  readonly control: string
  readonly status: string
  readonly sessionIds: readonly string[]
  readonly awaitingHumanOversight?: boolean
  readonly readyToAccept?: boolean
}

export interface IdleCandidate {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly reason: string
}

export function idleCandidates(
  tasks: readonly TaskRecord[],
  pending: readonly PendingView[],
  changes: readonly WorkIdleItem[] = [],
): IdleCandidate[] {
  const out: IdleCandidate[] = []
  for (const change of changes) {
    if (change.control !== 'open' || change.status === 'done' || change.status === 'cancelled') continue
    const running = change.sessionIds.some(sessionId => tasks.some(task => task.sessionId === sessionId && task.status === 'running'))
    const waiting = change.sessionIds.some(sessionId => pending.some(item => item.sessionId === sessionId))
    if (running || waiting || change.awaitingHumanOversight) continue
    let reason: string | undefined
    if (change.readyToAccept) reason = 'verified delivery ready to close out'
    else if (change.status === 'rework' || change.status === 'unverified') reason = `${change.status} needs follow-up`
    else if (change.status === 'waiting') reason = 'open change has no active run'
    if (!reason) continue
    const mappedStatus = change.readyToAccept ? 'review' : change.status === 'waiting' ? 'todo' : 'active'
    out.push({ id: change.id, title: change.title, status: mappedStatus, reason })
  }
  return out
}

export function idleFingerprint(candidates: readonly IdleCandidate[]): string {
  return candidates.map(row => `${row.id}:${row.status}:${row.reason}`).sort().join('|')
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
