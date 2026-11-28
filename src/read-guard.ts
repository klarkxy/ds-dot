/**
 * Fail-closed boundary for every file path Dorothy reads. The guard works on
 * the model-supplied text before a host tool runs: hostile Windows forms are
 * refused everywhere, symlink hops and realpaths all count, and every
 * candidate must stay inside one live readable root.
 */
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { credentialLikePath } from './approval-risk.ts'
import { pathInsideRoot, withoutNamespace } from './path-inspect.ts'

export const CREDENTIAL_READ_REFUSAL = 'That path looks like a credential file and will not be read.'
export const OUTSIDE_READ_REFUSAL = "That path is outside Dorothy's readable roots. Ask the human to attach the file or register a workspace for it, or dispatch a task with access to it."
export const HOSTILE_READ_REFUSAL = 'That path uses a Windows network or alternate-stream form and will not be read.'
export const UNRESOLVABLE_READ_REFUSAL = 'That path cannot be resolved safely and will not be read.'

type PathApi = typeof posix

function apiFor(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? win32 : posix
}

export function expandHome(raw: string): string {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

function missingSegment(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function realpathOf(path: string): string {
  return withoutNamespace((realpathSync.native ?? realpathSync)(path))
}

/**
 * Collect the lexical path plus every reachable symlink target and realpath.
 * Filesystem errors other than a missing segment are fatal to the check: a
 * path whose hops cannot be inspected is not allowed through on partial data.
 */
export function resolveExistingAndLinks(candidate: string, platform: NodeJS.Platform = process.platform): readonly string[] {
  const api = apiFor(platform)
  const out = new Set<string>([candidate])
  const walk = (inputPath: string, depth: number): void => {
    if (depth > 16) throw new Error('too many symlink hops')
    const tail: string[] = []
    let cur = inputPath
    while (true) {
      let stat: ReturnType<typeof lstatSync> | undefined
      try {
        stat = lstatSync(cur)
      } catch (error) {
        if (!missingSegment(error)) throw error
      }
      if (stat?.isSymbolicLink()) {
        const rawLink = expandHome(readlinkSync(cur))
        const target = api.isAbsolute(rawLink) ? api.resolve(rawLink) : api.resolve(api.dirname(cur), rawLink)
        const next = tail.length > 0 ? api.join(target, ...tail) : target
        if (!out.has(next)) {
          out.add(next)
          walk(next, depth + 1)
        }
      }
      if (existsSync(cur)) {
        const real = realpathOf(cur)
        out.add(tail.length > 0 ? api.join(real, ...tail) : real)
      }
      const parent = api.dirname(cur)
      if (parent === cur) break
      const base = cur.slice(parent.length).replace(/^[/\\]+/, '')
      if (base) tail.unshift(base)
      cur = parent
    }
  }
  walk(candidate, 0)
  return [...out]
}

/**
 * Alternate data streams and network paths are hostile no matter which host
 * runs Dorothy: the model supplies text, and a later Windows tool must never
 * reinterpret it outside the checked file boundary. Only the long-path form
 * `\\?\C:\...` remains accepted; `\\?\UNC\...` is still a network path.
 */
function windowsHostilePath(raw: string): boolean {
  const lower = raw.toLowerCase()
  if (lower.startsWith('\\\\?\\unc\\')) return true
  const longDrive = raw.length > 5
    && raw.startsWith('\\\\?\\')
    && /[a-z]/i.test(raw[4]!)
    && raw[5] === ':'
  if ((raw.startsWith('\\\\') || raw.startsWith('//')) && !longDrive) return true
  const normalized = withoutNamespace(raw)
  const driveEnd = /^[a-z]:/i.test(normalized) ? 2 : 0
  return normalized.indexOf(':', driveEnd) !== -1
}

/**
 * A glob filter is not a file path, but an absolute filter or a `..` segment
 * would escape the already-checked search root before the host globber runs.
 */
export function dotGlobPatternRefusal(pattern: string): string | undefined {
  if (pattern.startsWith('/') || pattern.startsWith('\\') || /^[a-z]:/i.test(pattern)) return OUTSIDE_READ_REFUSAL
  if (pattern.split(/[/\\]/).includes('..')) return OUTSIDE_READ_REFUSAL
  if (credentialLikePath(pattern)) return CREDENTIAL_READ_REFUSAL
  return undefined
}

function resolvedBases(bases: readonly string[], platform: NodeJS.Platform): readonly string[] {
  const api = apiFor(platform)
  const out: string[] = []
  const seen = new Set<string>()
  for (const base of bases) {
    if (!base.trim()) continue
    const resolved = api.resolve(withoutNamespace(expandHome(base)))
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved
    if (!seen.has(key)) {
      seen.add(key)
      out.push(resolved)
    }
  }
  return out
}

/** A root authorizes both its registered spelling and its realpath; a root that cannot resolve authorizes nothing. */
function readableRoots(roots: readonly string[], platform: NodeJS.Platform): readonly string[] {
  const api = apiFor(platform)
  const out: string[] = []
  const seen = new Set<string>()
  const add = (root: string) => {
    const resolved = api.resolve(root)
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved
    if (!seen.has(key)) {
      seen.add(key)
      out.push(resolved)
    }
  }
  for (const root of roots) {
    if (!root.trim()) continue
    const expanded = withoutNamespace(expandHome(root))
    let real: string
    try { real = realpathOf(expanded) } catch { continue }
    add(expanded)
    add(real)
  }
  return out
}

/**
 * Return the model-facing refusal for one path, or undefined when every
 * interpretation of it stays inside `roots`. Relative input is resolved against
 * every base; because the base list is part of the evidence, every resulting
 * candidate must pass too.
 */
export function dotReadRefusal(raw: string, opts: { readonly bases: readonly string[]; readonly roots: readonly string[]; readonly platform?: NodeJS.Platform }): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const platform = opts.platform ?? process.platform
  const api = apiFor(platform)
  if (windowsHostilePath(trimmed)) return HOSTILE_READ_REFUSAL
  const expanded = expandHome(trimmed)
  if (windowsHostilePath(expanded)) return HOSTILE_READ_REFUSAL
  const normalized = withoutNamespace(expanded)
  const absolute = api.isAbsolute(normalized)
  const bases = resolvedBases(opts.bases, platform)
  if (!absolute && bases.length === 0) return undefined
  const resolvedInputs = absolute
    ? [api.resolve(normalized)]
    : bases.map(base => api.resolve(base, normalized))
  if (resolvedInputs.length === 0) return OUTSIDE_READ_REFUSAL
  const candidates: string[] = []
  const seen = new Set<string>()
  try {
    for (const input of resolvedInputs) {
      for (const candidate of resolveExistingAndLinks(input, platform)) {
        const key = platform === 'win32' ? candidate.toLowerCase() : candidate
        if (!seen.has(key)) {
          seen.add(key)
          candidates.push(candidate)
        }
      }
    }
  } catch {
    return UNRESOLVABLE_READ_REFUSAL
  }
  if (credentialLikePath(trimmed) || credentialLikePath(expanded) || credentialLikePath(normalized) || candidates.some(candidate => credentialLikePath(candidate))) {
    return CREDENTIAL_READ_REFUSAL
  }
  const roots = readableRoots(opts.roots, platform)
  if (roots.length === 0) return OUTSIDE_READ_REFUSAL
  for (const candidate of candidates) {
    if (!roots.some(root => pathInsideRoot(root, candidate, platform))) return OUTSIDE_READ_REFUSAL
  }
  return undefined
}
