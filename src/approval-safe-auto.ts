/**
 * When Dorothy should leave an approval to Safe Auto instead of her own
 * routing (`approvals=deny` included). Overlay membership alone is not enough:
 * a task pinned away from `safe-auto` must not skip deny-all.
 */
import type { TaskPermission } from './contracts.ts'

export interface SafeAutoDeferral {
  /** `safeAutoRuntime.sessionActive(sessionId)` */
  readonly overlayActive: boolean
  /**
   * Permission Dorothy pinned on this session's run. Absent for human sessions
   * and for pre-0.4.1 records that only stored `read` | `write`.
   */
  readonly intendedPermission: TaskPermission | undefined
}

/**
 * Skip Dorothy's approval handler only when Safe Auto is actually intended to
 * review this session. Residual overlay after a native re-pin must not win.
 */
export function shouldDeferApprovalToSafeAuto(input: SafeAutoDeferral): boolean {
  if (!input.overlayActive) return false
  const intended = input.intendedPermission
  if (intended === 'workspace-write' || intended === 'danger-full-access' || intended === 'auto') return false
  return true
}
