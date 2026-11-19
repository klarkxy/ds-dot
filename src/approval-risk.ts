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
  | 'remote-exec'
  | 'subagent-shell'
  | 'read-only-write'

const SHELLS = new Set(['bash', 'shell', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd', 'exec', 'terminal', 'run_command'])
const WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'patch',
  'create_file',
  'delete_file',
  'remove_file',
  'move_file',
  'rename_file',
  'notebook_edit',
])

const SANDBOX = /danger-full-access|sandbox_permissions/i
const PUBLISH = /\b(?:npm|pnpm|yarn|bun|cargo)(?:\s+--?[A-Za-z0-9-]+(?:=\S+|\s+(?!publish\b)[^-\s]\S*)?)*\s+publish\b|\bgit(?:\s+(?:-[Cc]\s+\S+|--?[A-Za-z0-9-]+(?:=\S+|\s+(?!push\b)[^-\s]\S*)?))*\s+push\b|\bgh(?:\s+--?[A-Za-z0-9-]+(?:=\S+|\s+(?!release\b|pr\b)[^-\s]\S*)?)*\s+(?:release\b|pr\s+merge\b)|\btwine\s+upload\b/i
const DESTROY = /\brm\b[^;&|\n]{0,200}?(?:\s|^)(?:-[A-Za-z]*r[A-Za-z]*|--recursive)(?=\s|$|["'\\])|\bRemove-Item\b[\s\S]{0,160}?(?:\s|^)-(?:Recurse|Force|r)\b|\b(?:del|rmdir)\b[^;&|\n]{0,120}\/s\b|\bgit(?:\s+(?:-[Cc]\s+\S+|--?[A-Za-z0-9-]+(?:=\S+)?))*\s+(?:reset\s+--hard|clean\s+-[A-Za-z]*f[A-Za-z]*)\b|\bshutil\.rmtree\s*\(|\bfs\.(?:rmSync|rm|rmdirSync)\s*\([\s\S]{0,160}\brecursive\s*:\s*true\b|\brimraf\b|\bfind\b[^;&|\n]{0,200}?(?:\s|^)-delete\b|\bkubectl\b[^;&|\n]{0,80}\bdelete\b|\bdocker\s+system\s+prune\b|\bdocker\s+rm\b[^;&|\n]{0,120}(?:\s|^)(?:-[A-Za-z]*f[A-Za-z]*|--force)\b|\bdocker\s+volume\s+(?:rm|prune)\b|\bterraform\s+destroy\b|\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\s+)?[A-Za-z_"]/i
const CREDENTIAL = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,}|sk-(?:live|proj)-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36})\b|(?:^|[\s"'=:/\\])(?:\.ssh[/\\]+id_(?:rsa|ed25519|ecdsa|dsa)|\.aws[/\\]+credentials|\.npmrc|\.pypirc|\.netrc|\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[\w-]+)*)(?=$|[\s"'&;|/\\])/i
const REMOTE_EXEC = /\b(?:curl|wget)\b[^;&|\n]{0,300}?\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|python[0-9.]*|node|iex|pwsh|powershell)\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&|\n]{0,300}?\|\s*(?:iex|Invoke-Expression)\b/i
const WRITE = /\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|mkdir|touch|cp|mv|rm|truncate|tee)\b|\b(?:sed|perl)\s+-[A-Za-z]*i\b|\bdd\b[^;&|\n]*\bof=|\bfs\.(?:writeFileSync|writeFile|appendFileSync|appendFile|unlinkSync|unlink|renameSync)\s*\(|\bshutil\.(?:copy|move)\s*\(|(?:^|[\s;|&])>{1,2}\s*\S/m

/** A filesystem path that would expose credentials when read. Same rules as the credential gate. */
export function credentialLikePath(path: string): boolean {
  return CREDENTIAL.test(path)
}

export function assessApprovalRisk(input: {
  readonly toolName: string
  readonly reason?: string
  readonly arguments?: string
  readonly viaSubagent?: boolean
  readonly readOnly?: boolean
}): { readonly forced: boolean; readonly reasons: readonly ApprovalRiskCode[] } {
  const normalizedTool = input.toolName.trim().toLowerCase()
  const haystack = [input.reason ?? '', input.arguments ?? ''].filter(Boolean).join('\n')
  const reasons: ApprovalRiskCode[] = []
  const sandbox = SANDBOX.test(haystack)
  const destroy = DESTROY.test(haystack)
  const publish = PUBLISH.test(haystack)
  if (sandbox) reasons.push('sandbox-escalation')
  if (publish) reasons.push('publish')
  if (destroy) reasons.push('destroy')
  if (CREDENTIAL.test(haystack)) reasons.push('credential')
  if (REMOTE_EXEC.test(haystack)) reasons.push('remote-exec')
  if (input.viaSubagent === true && SHELLS.has(normalizedTool)) reasons.push('subagent-shell')
  if (input.readOnly === true && (sandbox || destroy || publish || WRITE_TOOLS.has(normalizedTool) || WRITE.test(haystack))) {
    reasons.push('read-only-write')
  }
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
