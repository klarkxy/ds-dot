/**
 * Shared delivery subject and the checks behind the one accept entry.
 * Snapshots stay in the artifact store. This module only names and compares them.
 */
import { createHash } from 'node:crypto'
import type { BaselineRef, RunRecord, WriteScope } from './work.ts'

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
}

export function subjectKey(subject: DeliverySubject): string {
  const body = JSON.stringify({
    workspaceRoot: subject.workspaceRoot,
    cwd: subject.cwd,
    baselineRefs: subject.baselineRefs.map(ref => `${ref.workspaceRoot}|${ref.scopeKey}|${ref.artifactRef}`).sort(),
    artifactRef: subject.artifactRef,
    changes: subject.changes.map(change => `${change.kind}|${change.path}|${change.sha256 ?? ''}`).sort(),
    protectedDirty: [...subject.protectedDirty].sort(),
    exclusions: subject.exclusions.map(item => `${item.path}|${item.reason}`).sort(),
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
}

/** Reads the artifact store and the live workspace. A missing read is a refusal, not a skip. */
export interface SubjectLook {
  read(ref: string): SubjectSnapshot | undefined
  evidence(ref: string): boolean
  /** Relative paths in the workspace now. Undefined means the tree could not be read. */
  live(workspaceRoot: string): readonly string[] | undefined
  body(workspaceRoot: string, path: string): Uint8Array | undefined
}

/** A snapshot, baseline, or session id is not an evidence_ref, even if a file was saved under that name. */
export function isForeignEvidenceId(ref: string): boolean {
  return /^(?:sub|base|session)-/.test(ref)
}

/** Why this id cannot be used in evidenceRefs. Undefined means it is a registered evidence_ref. */
export function evidenceRefGap(ref: string, registered: boolean): string | undefined {
  if (isForeignEvidenceId(ref)) return `evidence ${ref} is a snapshot, baseline, or session id, not a registered evidence_ref. Call action=evidence and use the evidence_ref it returns.`
  if (!registered) return `evidence ${ref} is not a registered evidence_ref. Call action=evidence and use the evidence_ref it returns. Do not substitute a snapshot, baseline, or session id.`
  return undefined
}

function samePlace(left: string, right: string): boolean {
  const fold = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return fold(left) === fold(right)
}

function sameRel(left: string, right: string): boolean {
  return left.replaceAll('\\', '/').toLowerCase() === right.replaceAll('\\', '/').toLowerCase()
}

function digest(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

function artifactId(ref: string): boolean {
  return /^[A-Za-z0-9._-]{1,80}$/.test(ref) && ref !== '.' && ref !== '..'
}

function pathKey(value: string): string {
  return value.replaceAll('\\', '/').toLowerCase()
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
): { readonly files: readonly { readonly path: string; readonly sha256: string }[]; readonly missing?: string } {
  const writers = new Set(runs.filter(run => run.kind !== 'review').flatMap(run => run.baselineRefs.map(ref => ref.artifactRef)))
  const reviewOnly = new Set(runs.filter(run => run.kind === 'review').flatMap(run => run.baselineRefs.map(ref => ref.artifactRef)).filter(id => !writers.has(id)))
  const files: { path: string; sha256: string }[] = []
  const seen = new Set<string>()
  for (const ref of baselines) {
    const snapshot = read(ref.artifactRef)
    if (!snapshot) return { files, missing: ref.artifactRef }
    if (reviewOnly.has(ref.artifactRef)) continue
    for (const entry of snapshot.saved) {
      const key = pathKey(entry.path)
      if (seen.has(key)) continue
      seen.add(key)
      files.push({ path: entry.path, sha256: entry.sha256 })
    }
  }
  return { files }
}

/** The caller's added, modified, deleted and protectedDirty labels have to match the writer baseline. */
export function contributionGap(
  subject: DeliverySubject,
  prior: readonly { readonly path: string; readonly sha256: string }[],
  manifest: SubjectSnapshot,
): string | undefined {
  const earlier = new Map(prior.map(file => [pathKey(file.path), file]))
  const saved = new Map(manifest.saved.map(file => [pathKey(file.path), file]))
  const excluded = (rel: string) => subject.exclusions.some(item => sameRel(item.path, rel))
  const changeOf = (rel: string) => subject.changes.find(item => sameRel(item.path, rel))
  const dirty = (rel: string) => subject.protectedDirty.some(item => sameRel(item, rel))
  for (const entry of manifest.saved) {
    if (excluded(entry.path)) continue
    const before = earlier.get(pathKey(entry.path))
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
    if (excluded(file.path) || saved.has(pathKey(file.path))) continue
    if (!manifest.deleted.some(item => sameRel(item, file.path))) return `baseline file ${file.path} is missing from the delivery`
    const change = changeOf(file.path)
    if (!change || change.kind !== 'deleted') return `${file.path} was removed from its original baseline`
  }
  for (const name of subject.protectedDirty) {
    const before = earlier.get(pathKey(name))
    const entry = saved.get(pathKey(name))
    if (!before || !entry || before.sha256 !== entry.sha256) return `protectedDirty ${name} does not match its original baseline`
  }
  for (const change of subject.changes) {
    const before = earlier.get(pathKey(change.path))
    if (change.kind === 'added' && before) return `added ${change.path} is already in the original baseline`
    if (change.kind === 'modified' && (!before || before.sha256 === saved.get(pathKey(change.path))?.sha256)) return `modified ${change.path} does not differ from its original baseline`
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
): string | undefined {
  const named = subjectGap(subject, baselines, runs)
  if (named) return named
  if (!look) return 'subject is not bound to a snapshot'
  if (!artifactId(subject.artifactRef)) return `delivery snapshot ${subject.artifactRef} is not a single relative id`
  const manifest = look.read(subject.artifactRef)
  if (!manifest) return `delivery snapshot ${subject.artifactRef} is missing or incomplete`
  if (!manifest.root || !samePlace(manifest.root, subject.workspaceRoot)) return `delivery snapshot root is not ${subject.workspaceRoot}`
  for (const change of subject.changes) {
    if (change.kind === 'deleted') {
      if (!manifest.deleted.some(item => sameRel(item, change.path))) return `deleted ${change.path} is not in the snapshot`
      continue
    }
    const saved = manifest.saved.find(item => sameRel(item.path, change.path))
    if (!saved || !change.sha256 || change.sha256 !== saved.sha256) return `changed ${change.path} has no matching content`
  }
  const accounted = (rel: string) => subject.changes.some(item => sameRel(item.path, rel))
    || subject.protectedDirty.some(item => sameRel(item, rel))
    || subject.exclusions.some(item => sameRel(item.path, rel))
  for (const entry of manifest.saved) if (!accounted(entry.path)) return `snapshot file ${entry.path} is not in the delivery`
  for (const name of manifest.deleted) if (!accounted(name)) return `snapshot deletion ${name} is not in the delivery`
  for (const ref of subject.baselineRefs) {
    if (!artifactId(ref.artifactRef)) return `baseline ${ref.artifactRef} is not a single relative id`
    const baseline = look.read(ref.artifactRef)
    if (!baseline) return `baseline ${ref.artifactRef} is missing or incomplete`
    if (!baseline.root || !samePlace(baseline.root, ref.workspaceRoot)) return `baseline ${ref.artifactRef} is not ${ref.workspaceRoot}`
  }
  for (const ref of evidenceRefs) {
    const gap = evidenceRefGap(ref, look.evidence(ref))
    if (gap) return gap
  }
  const live = look.live(subject.workspaceRoot)
  if (!live) return 'workspace could not be read'
  for (const ref of subject.baselineRefs) {
    const baseline = look.read(ref.artifactRef)
    if (!baseline) continue
    for (const entry of baseline.saved) {
      const kept = manifest.saved.some(item => sameRel(item.path, entry.path))
        || manifest.deleted.some(item => sameRel(item, entry.path))
        || subject.exclusions.some(item => sameRel(item.path, entry.path))
      if (!kept) return `baseline file ${entry.path} is missing from the delivery`
    }
  }
  for (const rel of live) {
    if (subject.exclusions.some(item => sameRel(item.path, rel))) continue
    if (manifest.deleted.some(item => sameRel(item, rel))) return `deleted ${rel} is still in the workspace`
    const saved = manifest.saved.find(item => sameRel(item.path, rel))
    if (!saved) return `live file ${rel} is not in the delivery`
    const body = look.body(subject.workspaceRoot, rel)
    if (!body || digest(body) !== saved.sha256) return `workspace changed since the delivery snapshot: ${rel}`
  }
  for (const name of manifest.deleted) {
    if (live.some(rel => sameRel(rel, name))) return `deleted ${name} is still in the workspace`
  }
  for (const entry of manifest.saved) {
    if (live.some(rel => sameRel(rel, entry.path))) continue
    return `snapshot file ${entry.path} is gone from the workspace`
  }
  const prior = writerPrior(baselines, runs, ref => look.read(ref))
  if (prior.missing) return `baseline ${prior.missing} is missing or incomplete`
  return contributionGap(subject, prior.files, manifest)
}
