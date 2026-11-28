/**
 * Code gate for approvals. The model may judge routine requests when
 * approvals=dot; hard cases are forced to the human and dot_answer cannot
 * override them, while soft cases reach the model as cautions it must weigh.
 * The notice fences requester-supplied text so a forged "already authorized"
 * line cannot leave the untrusted block.
 */
import { randomUUID } from 'node:crypto'
import { APPROVAL_FENCE_PREFIX, mcpPrefix, mcpServerOf } from './contracts.ts'

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

const MCP_LOOKUP_WORDS = new Set([
  'get',
  'list',
  'search',
  'read',
  'fetch',
  'query',
  'describe',
  'view',
  'show',
  'find',
  'lookup',
  'count',
  'check',
  'inspect',
  'stat',
  'status',
])

/**
 * MCP servers run outside the sandbox and expose no readOnly annotations, so a
 * read-only run can only go by the `mcp__<server>__<tool>` name. Lookup-shaped
 * first words are allowed; every other shape — including malformed names —
 * fails closed as a possible write.
 */
export function mcpToolMayWrite(toolName: string, servers?: readonly string[]): boolean {
  const trimmed = toolName.trim()
  if (!trimmed.toLowerCase().startsWith('mcp__')) return false
  const mayWriteRaw = (raw: string): boolean => {
    if (raw === '') return true
    const first = raw.split(/[_-]|(?<=[a-z])(?=[A-Z])/)[0] ?? ''
    return !MCP_LOOKUP_WORDS.has(first)
  }
  const server = servers === undefined ? undefined : mcpServerOf(trimmed, servers)
  if (server !== undefined) {
    const prefix = mcpPrefix(server)
    // A clipped prefix belongs to a lossy hashed public name; the raw tool
    // name is unknowable from it, so the only safe answer is "may write".
    if (!trimmed.startsWith(prefix)) return true
    return mayWriteRaw(trimmed.slice(prefix.length))
  }
  const rest = trimmed.slice('mcp__'.length)
  // Without the server list the server/tool boundary is ambiguous whenever the
  // server itself contains `__`: every possible raw tail must read as a lookup.
  let found = false
  for (let at = rest.indexOf('__'); at !== -1; at = rest.indexOf('__', at + 1)) {
    if (at === 0) return true
    found = true
    if (mayWriteRaw(rest.slice(at + 2))) return true
  }
  return !found
}

const SANDBOX = /danger-full-access|sandbox_permissions/i
const PUBLISH = /\b(?:npm|pnpm|yarn|bun|cargo)(?:\s+--?[A-Za-z0-9-]+(?:=\S+|\s+(?!publish\b)[^-\s]\S*)?)*\s+publish\b|\bgit(?:\s+(?:-[Cc]\s+\S+|--?[A-Za-z0-9-]+(?:=\S+|\s+(?!push\b)[^-\s]\S*)?))*\s+push\b|\bgh(?:\s+--?[A-Za-z0-9-]+(?:=\S+|\s+(?!release\b|pr\b)[^-\s]\S*)?)*\s+(?:release\b|pr\s+merge\b)|\btwine\s+upload\b/i
const SHELL_TOKEN = String.raw`\\"(?:[^"\\]|\\.)*\\"|"(?:[^"\\]|\\.)*"|'[^']*'|\S+`
const NON_FLAG_VALUE = String.raw`\\"(?:[^"\\]|\\.)*\\"|"(?:[^"\\]|\\.)*"|'[^']*'|[^-\s]\S*`
const GIT_OTHER_FLAG = String.raw`--[A-Za-z0-9-]+(?:=(?:${SHELL_TOKEN})|\s+(?!reset\b|clean\b)(?:${NON_FLAG_VALUE}))?|-[A-BD-Za-z0-9][A-Za-z0-9-]*(?:=(?:${SHELL_TOKEN})|\s+(?!reset\b|clean\b)(?:${NON_FLAG_VALUE}))?`
const DESTROY_GIT = new RegExp(
  String.raw`\bgit(?:\s+(?:-[Cc]\s*(?:${SHELL_TOKEN})|${GIT_OTHER_FLAG}))*\s+(?:reset\s+--hard|clean\s+-[A-Za-z]*f[A-Za-z]*)\b`,
  'i',
)
const DESTROY = /\brm\b[^;&|\n]{0,200}?(?:\s|^)(?:-[A-Za-z]*r[A-Za-z]*|--recursive)(?=\s|$|["'\\])|\bRemove-Item\b[\s\S]{0,160}?(?:\s|^)-(?:Recurse|Force|r)\b|\b(?:del|rmdir)\b[^;&|\n]{0,120}\/s\b|\bshutil\.rmtree\s*\(|\bfs\.(?:rmSync|rm|rmdirSync)\s*\([\s\S]{0,160}\brecursive\s*:\s*true\b|\brimraf\b|\bfind\b[^;&|\n]{0,200}?(?:\s|^)-delete\b|\bkubectl\b[^;&|\n]{0,80}\bdelete\b|\bdocker\s+system\s+prune\b|\bdocker\s+rm\b[^;&|\n]{0,120}(?:\s|^)(?:-[A-Za-z]*f[A-Za-z]*|--force)\b|\bdocker\s+volume\s+(?:rm|prune)\b|\bterraform\s+destroy\b|\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\s+)?[A-Za-z_"]/i
/** A directory switch or git pointer aims the destructive command at another checkout. */
const GIT_RETARGET = /(?:^|[\s;|&"'\\])--(?:git-dir|work-tree)(?:[\s=]|$)|(?<![-/\\.\w])GIT_(?:WORK_TREE|DIR)\s*=|(?<![-/\\.\w])(?:cd|pushd|Set-Location|Push-Location|sl|chdir)\b/i
const GIT_C_FLAG = new RegExp(
  String.raw`(?:^|[\s;|&"'(\\])-C(?=$|[\s"'./\\~])|\b[Gg][Ii][Tt](?:\s+${GIT_OTHER_FLAG})*\s+-C\S+`,
)
const CREDENTIAL = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,}|sk-(?:live|proj)-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36})\b|(?:^|[\s"'=:/\\])(?:\.ssh|\.aws|\.gnupg|\.kube|id_(?:rsa|ed25519|ecdsa|dsa)(?![\w.*-]*\.pub(?=$|[\s"'&;|/\\]))[\w.*-]*|[*\w.-]+\.(?:pem|p12|pfx)|(?:\*+|[\w.-]*[/\\][*\w.-]+)\.key|\.npmrc|\.pypirc|\.netrc|\*+\.env|\.env(?!(?:\.(?:example|sample|template|dist))(?=$|[\s"'&;|/\\]))(?:\.[^\s"'&;|/\\]+)?)(?=$|[\s"'&;|/\\])/i
const CREDENTIAL_PATH_EXT = /(?:^|[/\\])(?:[^/\\]+\.(?:pem|key|p12|pfx|\{[^}]*\b(?:pem|key|p12|pfx)\b[^}]*\})|[^/\\]+\.env)(?=$|[/\\])/i
const CREDENTIAL_PATH_ONLY = /(?:^|[/\\])\.config[/\\]gh[/\\]hosts\.yml$|(?:^|[/\\])github cli[/\\]hosts\.yml$|(?:^|[/\\])\.git-credentials$|(?:^|[/\\])\.docker[/\\]config\.json$|(?:^|[/\\])\.config[/\\]gcloud[/\\]|(?:^|[/\\])\.azure(?:[/\\]|$)|^[/\\]proc[/\\](?:\d+|self)[/\\]environ$|(?:^|[/\\])terraform\.tfstate(?:\.backup)?$|(?:^|[/\\])\.credentials\.(?:ya?ml|json)$|(?:^|[/\\])credentials\.json$/i
const REMOTE_EXEC = /\b(?:curl|wget)\b[^;&|\n]{0,300}?\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|python[0-9.]*|node|iex|pwsh|powershell)\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&|\n]{0,300}?\|\s*(?:iex|Invoke-Expression)\b/i
const WRITE = /\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|mkdir|touch|cp|mv|rm|truncate|tee)\b|\b(?:sed|perl)\s+-[A-Za-z]*i\b|\bdd\b[^;&|\n]*\bof=|\bfs\.(?:writeFileSync|writeFile|appendFileSync|appendFile|unlinkSync|unlink|renameSync)\s*\(|\bshutil\.(?:copy|move)\s*\(|(?:^|[\s;|&])>{1,2}\s*\S/m

/** A filesystem path that would expose credentials when read. Same rules as the credential gate. */
export function credentialLikePath(path: string): boolean {
  return CREDENTIAL.test(path) || CREDENTIAL_PATH_EXT.test(path) || CREDENTIAL_PATH_ONLY.test(path)
}

/** Unstructured text that names or contains credential material. */
export function credentialLikeText(text: string): boolean {
  return CREDENTIAL.test(text)
}

/**
 * Codes split into hard `reasons` (forced to the human) and soft `cautions`
 * (advisory; the model judges by authority and impact). `forced` counts hard
 * reasons only.
 */
export function assessApprovalRisk(input: {
  readonly toolName: string
  readonly reason?: string
  readonly arguments?: string
  readonly viaSubagent?: boolean
  readonly readOnly?: boolean
  /** The requester's run writes inside its own active task worktree. */
  readonly ownWorktree?: boolean
  /** Known MCP server names used to attribute the raw tool name before judging it. */
  readonly mcpServers?: readonly string[]
}): { readonly forced: boolean; readonly reasons: readonly ApprovalRiskCode[]; readonly cautions: readonly ApprovalRiskCode[] } {
  const normalizedTool = input.toolName.trim().toLowerCase()
  const haystack = [input.reason ?? '', input.arguments ?? ''].filter(Boolean).join('\n')
  const reasons: ApprovalRiskCode[] = []
  const cautions: ApprovalRiskCode[] = []
  const sandbox = SANDBOX.test(haystack)
  const destroyGit = DESTROY_GIT.test(haystack)
  const destroyOther = DESTROY.test(haystack)
  const publish = PUBLISH.test(haystack)
  if (sandbox) cautions.push('sandbox-escalation')
  if (publish) reasons.push('publish')
  // A git reset/clean inside the run's own worktree is dot's call; a pointer at
  // another checkout or any other destructive shape stays with the human.
  if (destroyOther) reasons.push('destroy')
  else if (destroyGit) {
    const ownRepoOnly = input.ownWorktree === true && !GIT_RETARGET.test(haystack) && !GIT_C_FLAG.test(haystack)
    ;(ownRepoOnly ? cautions : reasons).push('destroy')
  }
  if (CREDENTIAL.test(haystack)) reasons.push('credential')
  if (REMOTE_EXEC.test(haystack)) reasons.push('remote-exec')
  if (input.viaSubagent === true && SHELLS.has(normalizedTool)) reasons.push('subagent-shell')
  if (input.readOnly === true && (sandbox || destroyOther || destroyGit || publish || WRITE_TOOLS.has(normalizedTool) || WRITE.test(haystack) || mcpToolMayWrite(input.toolName, input.mcpServers))) {
    reasons.push('read-only-write')
  }
  return { forced: reasons.length > 0, reasons, cautions }
}

/** Wrap requester text in a boundary the payload cannot close early. */
export function fenceUntrusted(body: string, limit = APPROVAL_NOTICE_LIMIT): { readonly text: string; readonly truncated: boolean } {
  const token = `${APPROVAL_FENCE_PREFIX}${randomUUID()}`
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
  readonly ownWorktree?: boolean
  readonly mcpServers?: readonly string[]
}): { readonly text: string; readonly truncated: boolean; readonly forced: boolean; readonly reasons: readonly ApprovalRiskCode[]; readonly cautions: readonly ApprovalRiskCode[] } {
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
    ...(input.ownWorktree ? { ownWorktree: true } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
  })
  const cautions = [...risk.cautions]
  if (fenced.truncated && !cautions.includes('truncated')) cautions.unshift('truncated')
  return { text: fenced.text, truncated: fenced.truncated, forced: risk.forced, reasons: risk.reasons, cautions }
}
