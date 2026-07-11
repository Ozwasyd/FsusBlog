import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeReleaseId, sha256File, writeJsonAtomic } from './release-assets.mjs'

export const RELEASE_GC_STATE_SCHEMA = 'fsusblog.release-assets.gc-state.v1'
export const RELEASE_GC_EVIDENCE_SCHEMA = 'fsusblog.release-assets.gc-evidence.v1'

export function normalizeGcState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('GC state must be an object')
  if (state.schema !== RELEASE_GC_STATE_SCHEMA) throw new Error(`GC state schema must be ${RELEASE_GC_STATE_SCHEMA}`)
  const activeReleaseId = normalizeReleaseId(state.activeReleaseId)
  const previousReleaseId = state.previousReleaseId === null ? null : normalizeReleaseId(state.previousReleaseId)
  const drainingReleaseIds = normalizeReleaseIds(state.drainingReleaseIds, 'drainingReleaseIds')
  const retentionReleaseIds = normalizeReleaseIds(state.retentionReleaseIds, 'retentionReleaseIds')
  const referencedReleaseIds = normalizeReleaseIds(state.referencedReleaseIds, 'referencedReleaseIds')
  const minimumRetainedReleaseCount = state.minimumRetainedReleaseCount ?? 2
  if (!Number.isSafeInteger(minimumRetainedReleaseCount) || minimumRetainedReleaseCount < 2 || minimumRetainedReleaseCount > 100) {
    throw new Error('minimumRetainedReleaseCount must be an integer from 2 through 100')
  }
  return {
    schema: RELEASE_GC_STATE_SCHEMA,
    activeReleaseId,
    previousReleaseId,
    drainingReleaseIds,
    retentionReleaseIds,
    referencedReleaseIds,
    minimumRetainedReleaseCount
  }
}

export function planReleaseAssetGc({ storeDirectory, state }) {
  const store = path.resolve(storeDirectory)
  const normalizedState = normalizeGcState(state)
  const releaseRoot = path.join(store, 'releases')
  const releaseIds = listDirectories(releaseRoot).map(normalizeReleaseId)
  if (!releaseIds.includes(normalizedState.activeReleaseId)) {
    throw new Error(`active release assets are missing: ${normalizedState.activeReleaseId}`)
  }
  if (normalizedState.previousReleaseId && !releaseIds.includes(normalizedState.previousReleaseId)) {
    throw new Error(`previous release assets are missing: ${normalizedState.previousReleaseId}`)
  }
  for (const [label, protectedReleaseIds] of [
    ['draining', normalizedState.drainingReleaseIds],
    ['retention', normalizedState.retentionReleaseIds],
    ['referenced', normalizedState.referencedReleaseIds]
  ]) {
    for (const releaseId of protectedReleaseIds) {
      if (!releaseIds.includes(releaseId)) throw new Error(`${label} release assets are missing: ${releaseId}`)
    }
  }

  const protectedReasons = new Map()
  protect(protectedReasons, normalizedState.activeReleaseId, 'active')
  if (normalizedState.previousReleaseId) protect(protectedReasons, normalizedState.previousReleaseId, 'previous')
  for (const releaseId of normalizedState.drainingReleaseIds) protect(protectedReasons, releaseId, 'draining')
  for (const releaseId of normalizedState.retentionReleaseIds) protect(protectedReasons, releaseId, 'retention-window')
  for (const releaseId of normalizedState.referencedReleaseIds) protect(protectedReasons, releaseId, 'external-reference')

  const newest = releaseIds
    .map(releaseId => ({ releaseId, mtimeMs: fs.statSync(path.join(releaseRoot, releaseId)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.releaseId.localeCompare(left.releaseId, 'en'))
    .slice(0, normalizedState.minimumRetainedReleaseCount)
  for (const { releaseId } of newest) protect(protectedReasons, releaseId, 'minimum-retention-count')

  const releases = releaseIds.sort((left, right) => left.localeCompare(right, 'en')).map(releaseId => ({
    releaseId,
    protected: protectedReasons.has(releaseId),
    reasons: [...(protectedReasons.get(releaseId) ?? [])].sort(),
    action: protectedReasons.has(releaseId) ? 'retain' : 'delete'
  }))

  const retainedObjectHashes = new Set()
  for (const release of releases.filter(release => release.protected)) {
    for (const file of readAssetManifest(path.join(releaseRoot, release.releaseId)).files) {
      retainedObjectHashes.add(file.sha256.slice('sha256:'.length))
    }
  }
  const objects = listDirectories(path.join(store, 'objects'))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map(sha256 => ({
      sha256: `sha256:${sha256}`,
      protected: retainedObjectHashes.has(sha256),
      action: retainedObjectHashes.has(sha256) ? 'retain' : 'delete'
    }))

  return {
    storeDirectory: store,
    state: normalizedState,
    releases,
    objects
  }
}

export function executeReleaseAssetGc({
  storeDirectory,
  state,
  apply = false,
  evidenceFile = null,
  lockFile = null
}) {
  const store = path.resolve(storeDirectory)
  const resolvedLockFile = path.resolve(lockFile ?? path.join(store, '.gc.lock'))
  fs.mkdirSync(path.dirname(resolvedLockFile), { recursive: true, mode: 0o700 })
  let lockDescriptor
  try {
    lockDescriptor = fs.openSync(resolvedLockFile, 'wx', 0o600)
    fs.writeFileSync(lockDescriptor, `${JSON.stringify({ schema: 'fsusblog.release-assets.gc-lock.v1', pid: process.pid, token: crypto.randomUUID() })}\n`)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`release asset GC lock already exists: ${resolvedLockFile}`)
    throw error
  }

  try {
    const plan = planReleaseAssetGc({ storeDirectory: store, state })
    const before = snapshotStore(store)
    if (apply) {
      for (const release of plan.releases.filter(release => release.action === 'delete')) {
        fs.rmSync(path.join(store, 'releases', release.releaseId), { recursive: true, force: false })
      }
      for (const object of plan.objects.filter(object => object.action === 'delete')) {
        fs.rmSync(path.join(store, 'objects', object.sha256.slice('sha256:'.length)), { recursive: true, force: false })
      }
    }
    const after = snapshotStore(store)
    const evidence = {
      schema: RELEASE_GC_EVIDENCE_SCHEMA,
      status: apply ? 'ok' : 'dry-run',
      dryRun: !apply,
      storeDirectory: store,
      lockFile: resolvedLockFile,
      protectedReleaseIds: plan.releases.filter(release => release.protected).map(release => release.releaseId),
      releaseActions: plan.releases,
      objectActions: plan.objects,
      before,
      after,
      errors: []
    }
    if (evidenceFile) writeJsonAtomic(evidenceFile, evidence)
    return evidence
  } finally {
    if (lockDescriptor !== undefined) fs.closeSync(lockDescriptor)
    fs.rmSync(resolvedLockFile, { force: true })
  }
}

function normalizeReleaseIds(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return [...new Set(value.map(normalizeReleaseId))]
}

function protect(reasons, releaseId, reason) {
  const existing = reasons.get(releaseId) ?? new Set()
  existing.add(reason)
  reasons.set(releaseId, existing)
}

function listDirectories(root) {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
}

function readAssetManifest(releaseDirectory) {
  const manifestFile = path.join(releaseDirectory, 'asset-manifest.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read protected release asset manifest ${manifestFile}: ${error.message}`)
  }
  if (!Array.isArray(manifest.files)
      || manifest.files.some(file => !/^sha256:[0-9a-f]{64}$/u.test(String(file?.sha256)))) {
    throw new Error(`protected release asset manifest is invalid: ${manifestFile}`)
  }
  return manifest
}

function snapshotStore(store) {
  const releases = listDirectories(path.join(store, 'releases')).sort()
  const objects = listDirectories(path.join(store, 'objects')).sort()
  const manifests = releases.map(releaseId => {
    const file = path.join(store, 'releases', releaseId, 'asset-manifest.json')
    return {
      releaseId,
      sha256: fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? sha256File(file) : null
    }
  })
  return { releases, objects: objects.map(sha256 => `sha256:${sha256}`), manifests }
}
