/**
 * Code gate for approvals. The model may judge routine requests when
 * approvals=dot; these cases are forced to the human and dot_answer cannot
 * override them. The notice fences requester-supplied text so a forged
 * "already authorized" line cannot leave the untrusted block.
 */
import { randomUUID } from 'node:crypto'

export const APPROVAL_NOTICE_LIMIT = 600
export const APPROVAL_DETAIL_LIMIT = 40

export type ApprovalRiskCode =
  | 'truncated'
  | 'sandbox-escalation'
  | 'publish'
  | 'destroy'
  | 'credential'
  | 'subagent-shell'
  | 'read-only-write'

const SHELLS = new Set(['bash', 'shell', 'sh', 'pwsh', 'powershell', 'cmd', 'exec'])

const SANDBOX = /danger-full-access|sandbox_permissions/i
const PUBLISH = /\b(?:npm|pnpm|yarn)\s+publish\b|\bgit\s+push\b|\bgh\s+release\b/i
const DESTROY = /\brm\s+(?:-[^\s]*r[^\s]*|--recursive)\b|\bRemove-Item\b[\s\S]{0,120}\b-(?:Recurse|Force)\b|\b(?:del|rmdir)\s+\/s\b/i
const CREDENTIAL = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const WRITE = /\b(?:Set-Content|Add-Content|Out-File|New-Item|mkdir|tee)\b|(?:^|[\s;|&])>{1,2}\s*\S/m

export function assessApprovalRisk(input: {
  readonly toolName: string
  readonly reason?: string
  readonly arguments?: string
  readonly viaSubagent?: boolean
  readonly readOnly?: boolean
}): { readonly forced: boolean; readonly reasons: readonly ApprovalRiskCode[] } {
  const haystack = [input.reason ?? '', input.arguments ?? ''].filter(Boolean).join('\n')
  const reasons: ApprovalRiskCode[] = []
  const sandbox = SANDBOX.test(haystack)
  const destroy = DESTROY.test(haystack)
  const publish = PUBLISH.test(haystack)
  if (sandbox) reasons.push('sandbox-escalation')
  if (publish) reasons.push('publish')
  if (destroy) reasons.push('destroy')
  if (CREDENTIAL.test(haystack)) reasons.push('credential')
  if (input.viaSubagent === true && SHELLS.has(input.toolName.trim().toLowerCase())) reasons.push('subagent-shell')
  if (input.readOnly === true && (sandbox || destroy || publish || WRITE.test(haystack))) reasons.push('read-only-write')
  return { forced: reasons.length > 0, reasons }
}

/** Wrap requester text in a boundary the payload cannot close early. */
export function fenceUntrusted(body: string, limit = APPROVAL_NOTICE_LIMIT): { readonly text: string; readonly truncated: boolean } {
  const token = `dot-approval-untrusted-${randomUUID()}`
  const safe = body.split(token).join(`${token} `)
  const truncated = safe.length > limit
  const shown = truncated ? safe.slice(0, limit) : safe
  return {
    truncated,
    text: `<${token}>\n${shown}${truncated ? '\n[truncated]' : ''}\n</${token}>`,
  }
}

/** Model-visible approval body. Stored arguments stay complete; only this copy is cut. */
export function approvalNotice(input: {
  readonly toolName: string
  readonly detail?: string
  readonly reason?: string
  readonly arguments?: string
  readonly viaSubagent?: boolean
  readonly readOnly?: boolean
}): { readonly text: string; readonly truncated: boolean; readonly forced: boolean; readonly reasons: readonly ApprovalRiskCode[] } {
  const lines: string[] = []
  if (input.viaSubagent) lines.push('asked by a subagent')
  if (input.reason) lines.push(`reason: ${input.reason}`)
  if (input.arguments !== undefined) lines.push(`arguments: ${input.arguments}`)
  if (input.reason === undefined && input.arguments === undefined && input.detail) lines.push(input.detail)
  const fenced = fenceUntrusted(lines.join('\n'))
  const risk = assessApprovalRisk({
    toolName: input.toolName,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    arguments: input.arguments ?? input.detail,
    ...(input.viaSubagent ? { viaSubagent: true } : {}),
    ...(input.readOnly ? { readOnly: true } : {}),
  })
  const reasons = [...risk.reasons]
  if (fenced.truncated && !reasons.includes('truncated')) reasons.unshift('truncated')
  return { text: fenced.text, truncated: fenced.truncated, forced: reasons.length > 0, reasons }
}
