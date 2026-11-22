/**
 * Shared delivery subject and the checks behind the one accept entry.
 * Snapshots stay in the artifact store. This module only names and compares them.
 */
import { createHash } from 'node:crypto'
import { absoluteScopePath, canonicalPath, pathsOverlap, scopeKey, scopeWithinRoot, type BaselineRef, type CheckRecord, type RunRecord, type WriteScope } from './work.ts'

export interface DeliveryChange {
  readonly path: string
  readonly kind: 'added' | 'modified' | 'deleted'
  readonly sha256?: string
}

export interface SubjectExclusion {
  readonly path: string
  readonly reason: string
}

/** One recoverable delivery. Baselines are the pre-work evidence, not a fresh diff. */
export interface DeliverySubject {
  readonly workspaceRoot: string
  readonly cwd: string
  readonly baselineRefs: readonly BaselineRef[]
  readonly artifactRef: string
  readonly changes: readonly DeliveryChange[]
  readonly protectedDirty: readonly string[]
  readonly exclusions: readonly SubjectExclusion[]
  /** Omitted on older subjects, which captured the full workspace. */
  readonly writeScope?: WriteScope
  /** Visible observations outside the delivery, without attribution to this change. */
  readonly outOfScopePaths?: readonly string[]
}

export function subjectKey(subject: DeliverySubject, binding?: {
  readonly inputRef: string; readonly inputRevision: number; readonly runIds: readonly string[];
  readonly checks: readonly CheckRecord[]; readonly reviewRunId?: string; readonly reviewerSessionId?: string;
}): string {
  const body = JSON.stringify({
    workspaceRoot: subject.workspaceRoot,
    cwd: subject.cwd,
    baselineRefs: subject.baselineRefs.map(ref => `${ref.workspaceRoot}|${ref.scopeKey}|${ref.artifactRef}`).sort(),
    artifactRef: subject.artifactRef,
    changes: subject.changes.map(change => `${change.kind}|${change.path}|${change.sha256 ?? ''}`).sort(),
    protectedDirty: [...subject.protectedDirty].sort(),
    exclusions: subject.exclusions.map(item => `${item.path}|${item.reason}`).sort(),
    ...(subject.writeScope ? { writeScope: scopeKey(subject.writeScope, subject.workspaceRoot) } : {}),
    ...(subject.outOfScopePaths ? { outOfScopePaths: [...subject.outOfScopePaths].sort() } : {}),
    ...(binding ? {
      inputRef: binding.inputRef, inputRevision: binding.inputRevision, runIds: [...binding.runIds].sort(),
      reviewRunId: binding.reviewRunId, reviewerSessionId: binding.reviewerSessionId,
      checks: binding.checks.map(check => ({
        requirementRef: check.requirementRef, applicability: check.applicability, verdict: check.verdict,
        evidenceRefs: [...check.evidenceRefs].sort(), note: check.note,
      })).sort((a, b) => a.requirementRef.localeCompare(b.requirementRef)),
    } : {}),
  })
  return createHash('sha256').update(body).digest('hex')
}

function scopeWrites(scope: WriteScope): boolean {
  return scope.kind === 'workspace-exclusive' || scope.paths.length > 0
}

/** The subject must name every published baseline and every writer run's baseline. */
export function subjectGap(subject: DeliverySubject, baselines: readonly BaselineRef[], runs: readonly RunRecord[]): string | undefined {
  if (!subject.artifactRef || !subject.workspaceRoot || !subject.cwd) return 'subject is not recoverable'
  for (const ref of baselines) {
    const named = subject.baselineRefs.some(item => item.workspaceRoot === ref.workspaceRoot && item.scopeKey === ref.scopeKey && item.artifactRef === ref.artifactRef)
    if (!named) return `subject omits baseline ${ref.artifactRef}`
  }
  for (const run of runs) {
    if (run.kind === 'review' || !scopeWrites(run.writeScope)) continue
    for (const ref of run.baselineRefs) {
      const named = subject.baselineRefs.some(item => item.workspaceRoot === ref.workspaceRoot && item.scopeKey === ref.scopeKey && item.artifactRef === ref.artifactRef)
      if (!named) return `subject omits the baseline for ${run.id}`
    }
  }
  return undefined
}

/** A snapshot the book has already loaded. Comparison uses these bytes, not the caller's id. */
export interface SubjectSnapshot {
  readonly root: string
  readonly saved: readonly { readonly path: string; readonly sha256: string }[]
  readonly deleted: readonly string[]
  /** Present when the on-disk manifest declared exclusions, including an empty list. */
  readonly exclusions?: readonly SubjectExclusion[]
}

/** Reads the artifact store and the live workspace. A missing read is a refusal, not a skip. */
export interface SubjectLook {
  read(ref: string): SubjectSnapshot | undefined
  /** Relative paths in the workspace now. Undefined means the tree could not be read. */
  live(workspaceRoot: string, scope?: WriteScope): readonly string[] | undefined
  body(workspaceRoot: string, path: string): Uint8Array | undefined
  /** Scan-time exclusions currently in the workspace. Undefined means the tree could not be read. */
  boundaries?(workspaceRoot: string, scope?: WriteScope): readonly SubjectExclusion[] | undefined
}

/**
 * One resolvable evidence reference: `run:<runId>` is the captured final Report
 * of a run of this change, `run:<runId>#<scenarioRef>` additionally requires a
 * matching bullet inside its `### Report` section, and `file:<relative path>` is
 * a file in the closeout's delivery subject (deletions count).
 */
export type EvidenceRef =
  | { readonly kind: 'run'; readonly runId: string; readonly scenario?: string }
  | { readonly kind: 'file'; readonly path: string }

export function parseEvidenceRef(ref: string): EvidenceRef | undefined {
  const run = /^run:([A-Za-z0-9_-]+)(?:#([^\s#]+))?$/.exec(ref)
  if (run) return { kind: 'run', runId: run[1]!, ...(run[2] !== undefined ? { scenario: run[2] } : {}) }
  const file = /^file:(.+)$/.exec(ref)
  if (file) {
    const path = file[1]!.trim()
    if (!path || path.split(/[\\/]/).includes('..') || /^[A-Za-z]:[\\/]|^[\\/]/.test(path)) return undefined
    return { kind: 'file', path }
  }
  return undefined
}

/**
 * The `- <scenarioRef>: <text>` line inside the report's `### Report` section.
 * Undefined when the bullet is missing, empty, or still the unfilled
 * `<evidence: …>` placeholder.
 */
export function reportBullet(report: string, scenarioRef: string): string | undefined {
  let inReport = false
  for (const line of report.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      inReport = /^#{1,6}\s+Report\s*$/i.test(line.trim())
      continue
    }
    if (!inReport) continue
    const bullet = new RegExp(`^\\s*[-*]\\s+${scenarioRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.*)$`).exec(line)
    if (!bullet) continue
    const text = bullet[1]!.trim()
    if (!text || /^<evidence\s*:/i.test(text)) return undefined
    return line.trim()
  }
  return undefined
}

/** Evidence must resolve to a run report or a delivered file; notes live on the check itself. */
export function evidenceRefGap(ref: string): string | undefined {
  if (!ref.trim()) return 'evidence reference is empty'
  if (!parseEvidenceRef(ref)) return `evidence ${ref} is not resolvable; use run:<runId>, run:<runId>#<scenarioRef>, or file:<relative path>`
  return undefined
}

/** The delivery is the union of writer scopes. A review's reservation does not expand it. */
export function deliveryScope(runs: readonly RunRecord[]): WriteScope {
  const writers = runs.filter(run => run.kind !== 'review')
  if (writers.some(run => run.writeScope.kind === 'workspace-exclusive')) return { kind: 'workspace-exclusive' }
  return { kind: 'paths', paths: writers.flatMap(run => run.writeScope.kind === 'paths'
    ? run.writeScope.paths.map(item => ({ ...item, path: absoluteScopePath(run.workspaceRoot, item.path) })) : []) }
}

export function scopeContainsPath(scope: WriteScope, root: string, rel: string, platform: NodeJS.Platform = process.platform): boolean {
  if (scope.kind === 'workspace-exclusive') return true
  const absolute = absoluteScopePath(root, rel, platform)
  return scope.paths.some(item => {
    const target = absoluteScopePath(root, item.path, platform)
    return item.type === 'file' ? samePlace(target, absolute, platform) : scopeWithinRoot(target, absolute, platform)
  })
}

function foldRel(value: string, platform: NodeJS.Platform): string {
  const normalized = value.replaceAll('\\', '/')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function samePlace(left: string, right: string, platform: NodeJS.Platform): boolean {
  return canonicalPath(left, platform) === canonicalPath(right, platform)
}

function sameRel(left: string, right: string, platform: NodeJS.Platform): boolean {
  return foldRel(left, platform) === foldRel(right, platform)
}

function digest(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

function artifactId(ref: string): boolean {
  return /^[A-Za-z0-9._-]{1,80}$/.test(ref) && ref !== '.' && ref !== '..'
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  return foldRel(value, platform)
}

function relUnder(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const folder = foldRel(parent, platform).replace(/\/+$/, '')
  const rel = foldRel(child, platform)
  return rel === folder || rel.startsWith(`${folder}/`)
}

function isIgnoredDirectoryReason(reason: string): boolean {
  return reason === 'ignored directory'
}

function isIgnoredFileReason(reason: string): boolean {
  return reason === 'ignored file'
}

function isLinkReason(reason: string): boolean {
  return reason === 'symlink' || reason.startsWith('symlink:')
}

function ignoreCovered(exclusions: readonly SubjectExclusion[], rel: string, platform: NodeJS.Platform): boolean {
  return exclusions.some(item => isIgnoredDirectoryReason(item.reason) && relUnder(item.path, rel, platform))
}

function exclusionKey(item: SubjectExclusion, platform: NodeJS.Platform): string {
  return `${foldRel(item.path, platform)}|${item.reason}`
}

function sameExclusionSet(left: readonly SubjectExclusion[], right: readonly SubjectExclusion[], platform: NodeJS.Platform): boolean {
  const a = left.map(item => exclusionKey(item, platform)).sort()
  const b = right.map(item => exclusionKey(item, platform)).sort()
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function declaredExclusions(snapshot: SubjectSnapshot | undefined): readonly SubjectExclusion[] | undefined {
  return snapshot?.exclusions
}

function effectiveExclusions(snapshot: SubjectSnapshot): readonly SubjectExclusion[] {
  return snapshot.exclusions ?? []
}

/** A path-scoped file baseline covers that file; a directory or workspace lock covers its tree. */
function linkCoveredByRun(run: RunRecord, linkRel: string, platform: NodeJS.Platform): boolean {
  if (run.writeScope.kind === 'workspace-exclusive') return true
  let linkAbs: string
  try {
    linkAbs = absoluteScopePath(run.workspaceRoot, linkRel, platform)
  } catch {
    return false
  }
  const linkKey = canonicalPath(linkAbs, platform)
  return run.writeScope.paths.some(scope => {
    let scopeAbs: string
    try {
      scopeAbs = absoluteScopePath(run.workspaceRoot, scope.path, platform)
    } catch {
      return false
    }
    const scopeKey = canonicalPath(scopeAbs, platform)
    if (scope.type === 'file') return scopeKey === linkKey
    return pathsOverlap(scopeKey, linkKey, platform)
  })
}

/**
 * The earliest writer baseline that names a path is its pre-work content.
 * A review run may reuse that same artifact; sharing the id does not erase the writer evidence.
 * A snapshot that only the review published is not a pre-work baseline.
 */
export function writerPrior(
  baselines: readonly BaselineRef[],
  runs: readonly RunRecord[],
  read: (ref: string) => SubjectSnapshot | undefined,
  platform: NodeJS.Platform = process.platform,
): { readonly files: readonly { readonly path: string; readonly sha256: string; readonly artifactRef: string }[]; readonly missing?: string } {
  const writers = new Set(runs.filter(run => run.kind !== 'review').flatMap(run => run.baselineRefs.map(ref => ref.artifactRef)))
  const reviewOnly = new Set(runs.filter(run => run.kind === 'review').flatMap(run => run.baselineRefs.map(ref => ref.artifactRef)).filter(id => !writers.has(id)))
  const files: { path: string; sha256: string; artifactRef: string }[] = []
  const seen = new Set<string>()
  for (const ref of baselines) {
    const snapshot = read(ref.artifactRef)
    if (!snapshot) return { files, missing: ref.artifactRef }
    if (reviewOnly.has(ref.artifactRef)) continue
    for (const entry of snapshot.saved) {
      const key = pathKey(entry.path, platform)
      if (seen.has(key)) continue
      seen.add(key)
      files.push({ path: entry.path, sha256: entry.sha256, artifactRef: ref.artifactRef })
    }
  }
  return { files }
}

/** The caller's added, modified, deleted and protectedDirty labels have to match the writer baseline. */
export function contributionGap(
  subject: DeliverySubject,
  prior: readonly { readonly path: string; readonly sha256: string }[],
  manifest: SubjectSnapshot,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const exclusions = effectiveExclusions(manifest)
  const earlier = new Map(prior.map(file => [pathKey(file.path, platform), file]))
  const saved = new Map(manifest.saved.map(file => [pathKey(file.path, platform), file]))
  const excluded = (rel: string) => ignoreCovered(exclusions, rel, platform)
  const changeOf = (rel: string) => subject.changes.find(item => sameRel(item.path, rel, platform))
  const dirty = (rel: string) => subject.protectedDirty.some(item => sameRel(item, rel, platform))
  for (const entry of manifest.saved) {
    if (excluded(entry.path)) continue
    const before = earlier.get(pathKey(entry.path, platform))
    const change = changeOf(entry.path)
    if (!before) {
      if (!change || change.kind !== 'added') return `${entry.path} is not in the original baseline and is not added`
      continue
    }
    if (before.sha256 === entry.sha256) {
      if (change) return `${entry.path} is unchanged from its original baseline`
      if (!dirty(entry.path)) return `${entry.path} is unchanged from its original baseline`
      continue
    }
    if (!change || change.kind !== 'modified') return `${entry.path} changed from its original baseline`
  }
  for (const file of prior) {
    if (excluded(file.path) || saved.has(pathKey(file.path, platform))) continue
    if (!manifest.deleted.some(item => sameRel(item, file.path, platform))) return `baseline file ${file.path} is missing from the delivery`
    const change = changeOf(file.path)
    if (!change || change.kind !== 'deleted') return `${file.path} was removed from its original baseline`
  }
  for (const name of subject.protectedDirty) {
    const before = earlier.get(pathKey(name, platform))
    const entry = saved.get(pathKey(name, platform))
    if (!before || !entry || before.sha256 !== entry.sha256) return `protectedDirty ${name} does not match its original baseline`
  }
  for (const change of subject.changes) {
    const before = earlier.get(pathKey(change.path, platform))
    if (change.kind === 'added' && before) return `added ${change.path} is already in the original baseline`
    if (change.kind === 'modified' && (!before || before.sha256 === saved.get(pathKey(change.path, platform))?.sha256)) return `modified ${change.path} does not differ from its original baseline`
    if (change.kind === 'deleted' && !before) return `deleted ${change.path} is not in the original baseline`
  }
  return undefined
}

/**
 * The delivery must be a readable snapshot of this workspace, cover every
 * baseline, and still match the live tree. Names alone are not a subject.
 */
export function subjectMaterial(
  subject: DeliverySubject,
  baselines: readonly BaselineRef[],
  runs: readonly RunRecord[],
  evidenceRefs: readonly string[],
  look: SubjectLook | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const named = subjectGap(subject, baselines, runs)
  if (named) return named
  if (!look) return 'subject is not bound to a snapshot'
  if (!artifactId(subject.artifactRef)) return `delivery snapshot ${subject.artifactRef} is not a single relative id`
  const manifest = look.read(subject.artifactRef)
  if (!manifest) return `delivery snapshot ${subject.artifactRef} is missing or incomplete`
  if (!manifest.root || !samePlace(manifest.root, subject.workspaceRoot, platform)) return `delivery snapshot root is not ${subject.workspaceRoot}`
  const scoped = (rel: string) => !subject.writeScope || scopeContainsPath(subject.writeScope, subject.workspaceRoot, rel, platform)
  if (subject.writeScope && scopeKey(subject.writeScope, subject.workspaceRoot, platform) !== scopeKey(deliveryScope(runs), subject.workspaceRoot, platform)) return 'delivery scope does not match the writer runs'
  if (manifest.saved.some(entry => !scoped(entry.path)) || manifest.deleted.some(name => !scoped(name))) return 'snapshot contains a path outside the delivery scope'
  const snapshotExclusions = effectiveExclusions(manifest)
  if (!sameExclusionSet(subject.exclusions, snapshotExclusions, platform)) return 'delivery exclusions do not match the snapshot'
  for (const change of subject.changes) {
    if (change.kind === 'deleted') {
      if (!manifest.deleted.some(item => sameRel(item, change.path, platform))) return `deleted ${change.path} is not in the snapshot`
      continue
    }
    const saved = manifest.saved.find(item => sameRel(item.path, change.path, platform))
    if (!saved || !change.sha256 || change.sha256 !== saved.sha256) return `changed ${change.path} has no matching content`
  }
  const accounted = (rel: string) => subject.changes.some(item => sameRel(item.path, rel, platform))
    || subject.protectedDirty.some(item => sameRel(item, rel, platform))
  for (const entry of manifest.saved) if (!accounted(entry.path)) return `snapshot file ${entry.path} is not in the delivery`
  for (const name of manifest.deleted) if (!accounted(name)) return `snapshot deletion ${name} is not in the delivery`
  for (const ref of subject.baselineRefs) {
    if (!artifactId(ref.artifactRef)) return `baseline ${ref.artifactRef} is not a single relative id`
    const baseline = look.read(ref.artifactRef)
    if (!baseline) return `baseline ${ref.artifactRef} is missing or incomplete`
    if (!baseline.root || !samePlace(baseline.root, ref.workspaceRoot, platform)) return `baseline ${ref.artifactRef} is not ${ref.workspaceRoot}`
  }
  for (const ref of evidenceRefs) {
    const gap = evidenceRefGap(ref)
    if (gap) return gap
  }
  const live = look.live(subject.workspaceRoot, subject.writeScope)
  if (!live) return 'workspace could not be read'
  const deliveryLinks = snapshotExclusions.filter(item => isLinkReason(item.reason))
  if (look.boundaries) {
    const liveBounds = look.boundaries(subject.workspaceRoot, subject.writeScope)
    if (!liveBounds) return 'workspace could not be read'
    const liveLinks = liveBounds.filter(item => isLinkReason(item.reason) && scoped(item.path))
    if (!sameExclusionSet(deliveryLinks, liveLinks, platform)) return 'source link appeared or changed'
  }
  for (const run of runs) {
    if (run.kind === 'review' || !scopeWrites(run.writeScope)) continue
    for (const ref of run.baselineRefs) {
      const baseline = look.read(ref.artifactRef)
      const recorded = declaredExclusions(baseline)
      if (!baseline || recorded === undefined) continue
      const scopedDelivery = deliveryLinks.filter(item => linkCoveredByRun(run, item.path, platform))
      const scopedBaseline = recorded.filter(item => isLinkReason(item.reason) && linkCoveredByRun(run, item.path, platform))
      if (!sameExclusionSet(scopedBaseline, scopedDelivery, platform)) return 'source link appeared or changed'
    }
  }
  for (const ref of subject.baselineRefs) {
    const baseline = look.read(ref.artifactRef)
    if (!baseline) continue
    for (const entry of baseline.saved) {
      if (!scoped(entry.path)) continue
      if (ignoreCovered(snapshotExclusions, entry.path, platform)) continue
      if (deliveryLinks.some(item => sameRel(item.path, entry.path, platform))) return `${entry.path} became a link`
      const kept = manifest.saved.some(item => sameRel(item.path, entry.path, platform))
        || manifest.deleted.some(item => sameRel(item, entry.path, platform))
      if (!kept) return `baseline file ${entry.path} is missing from the delivery`
    }
  }
  for (const rel of live) {
    if (!scoped(rel)) continue
    if (ignoreCovered(snapshotExclusions, rel, platform)) continue
    if (snapshotExclusions.some(item => isIgnoredFileReason(item.reason) && sameRel(item.path, rel, platform))) continue
    if (manifest.deleted.some(item => sameRel(item, rel, platform))) return `deleted ${rel} is still in the workspace`
    const saved = manifest.saved.find(item => sameRel(item.path, rel, platform))
    if (!saved) return `live file ${rel} is not in the delivery`
    const body = look.body(subject.workspaceRoot, rel)
    if (!body || digest(body) !== saved.sha256) return `workspace changed since the delivery snapshot: ${rel}`
  }
  for (const name of manifest.deleted) {
    if (live.some(rel => sameRel(rel, name, platform))) return `deleted ${name} is still in the workspace`
  }
  for (const entry of manifest.saved) {
    if (ignoreCovered(snapshotExclusions, entry.path, platform)) continue
    if (live.some(rel => sameRel(rel, entry.path, platform))) continue
    return `snapshot file ${entry.path} is gone from the workspace`
  }
  const prior = writerPrior(baselines, runs, ref => look.read(ref), platform)
  if (prior.missing) return `baseline ${prior.missing} is missing or incomplete`
  return contributionGap(subject, prior.files.filter(file => scoped(file.path)), manifest, platform)
}
