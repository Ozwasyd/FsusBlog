import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeReleaseId, sha256File, writeJsonAtomic } from './release-assets.mjs'

export const RELEASE_GC_STATE_SCHEMA = 'fsusblog.release-assets.gc-state.v1'
export const RELEASE_GC_EVIDENCE_SCHEMA = 'fsusblog.release-assets.gc-evidence.v1'
export const RELEASE_GC_PLAN_SCHEMA = 'fsusblog.release-assets.gc-plan.v1'

const GC_STATE_FIELDS = [
  'activeReleaseId', 'drainingReleaseIds', 'minimumRetainedReleaseCount', 'previousReleaseId',
  'referencedReleaseIds', 'retentionReleaseIds', 'schema'
]

export function normalizeGcState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('GC state must be an object')
  assertExactFields(state, GC_STATE_FIELDS, 'GC state')
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
  assertSafeStoreRoot(store)
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
    .map(sha256 => {
      if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error(`unknown-owned object directory is not a canonical digest: ${sha256}`)
      return {
        sha256: `sha256:${sha256}`,
        protected: retainedObjectHashes.has(sha256),
        action: retainedObjectHashes.has(sha256) ? 'retain' : 'delete'
      }
    })

  const payload = {
    schema: RELEASE_GC_PLAN_SCHEMA,
    storeDirectory: store,
    state: normalizedState,
    releases,
    objects
  }
  return Object.freeze({ ...payload, planSha256: digestJson(payload) })
}

export function verifyReleaseAssetGcPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('GC plan must be an object')
  assertExactFields(plan, ['objects', 'planSha256', 'releases', 'schema', 'state', 'storeDirectory'], 'GC plan')
  if (plan.schema !== RELEASE_GC_PLAN_SCHEMA) throw new Error(`GC plan schema must be ${RELEASE_GC_PLAN_SCHEMA}`)
  const { planSha256, ...payload } = plan
  if (digestJson(payload) !== planSha256) throw new Error('GC plan digest does not match its closed content')
  normalizeGcState(plan.state)
  assertSafeStoreRoot(path.resolve(plan.storeDirectory))
  return plan
}

export function executeReleaseAssetGc({
  storeDirectory,
  state,
  apply = false,
  evidenceFile = null,
  lockFile = null,
  activeProtection = null,
  refreshProtection = null
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
    const plan = verifyReleaseAssetGcPlan(planReleaseAssetGc({ storeDirectory: store, state }))
    const before = snapshotStore(store)
    if (apply) {
      const protection = normalizeActiveProtection(activeProtection)
      if (protection.releaseId !== plan.state.activeReleaseId) {
        throw new Error('GC active protection does not match the planned active release')
      }
      if (typeof refreshProtection !== 'function') throw new Error('GC apply requires a durable active identity refresh')
      const refreshed = normalizeActiveProtection(refreshProtection())
      if (JSON.stringify(refreshed) !== JSON.stringify(protection)) {
        throw new Error('durable active identity changed after GC planning')
      }
      verifyReleaseAssetGcPlan(plan)
      const releaseTargets = plan.releases.filter(release => release.action === 'delete')
        .map(release => path.join(store, 'releases', release.releaseId))
      const objectTargets = plan.objects.filter(object => object.action === 'delete')
        .map(object => path.join(store, 'objects', object.sha256.slice('sha256:'.length)))
      for (const target of releaseTargets) assertDeletionTarget(store, target, protection.releaseId)
      for (const target of objectTargets) assertDeletionTarget(store, target, null)
      for (const target of [...releaseTargets, ...objectTargets]) {
        fs.rmSync(target, { recursive: true, force: false })
      }
    }
    const after = snapshotStore(store)
    const evidence = {
      schema: RELEASE_GC_EVIDENCE_SCHEMA,
      status: apply ? 'ok' : 'dry-run',
      dryRun: !apply,
      storeDirectory: store,
      lockFile: resolvedLockFile,
      planSha256: plan.planSha256,
      activeProtection: apply ? normalizeActiveProtection(activeProtection) : null,
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
  const normalized = value.map(normalizeReleaseId)
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicate release identity`)
  return normalized
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
  const metadata = fs.lstatSync(manifestFile, { throwIfNoEntry: false })
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`protected release asset manifest must be a regular non-symlink file: ${manifestFile}`)
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read protected release asset manifest ${manifestFile}: ${error.message}`)
  }
  assertExactFields(manifest, [
    'compatibilityFile', 'files', 'frontendBuildId', 'releaseId', 'schema', 'slot'
  ], 'release asset manifest')
  if (manifest.schema !== 'fsusblog.release-assets.v1'
      || manifest.releaseId !== path.basename(releaseDirectory)
      || manifest.frontendBuildId !== manifest.releaseId
      || !['blue', 'green'].includes(manifest.slot)
      || (manifest.compatibilityFile !== null && manifest.compatibilityFile !== 'release-compatibility.json')
      || !Array.isArray(manifest.files)
      || manifest.files.some(file => {
        assertExactFields(file, ['bytes', 'cacheControl', 'class', 'path', 'releaseUrl', 'sha256'], 'release asset manifest file')
        return !/^sha256:[0-9a-f]{64}$/u.test(String(file.sha256))
          || !Number.isSafeInteger(file.bytes) || file.bytes < 0
          || !['mutable-entry', 'immutable-static'].includes(file.class)
          || typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split('/').some(segment => !segment || segment === '.' || segment === '..')
          || file.releaseUrl !== `/release-assets/${manifest.releaseId}/${file.path}`
          || typeof file.cacheControl !== 'string' || file.cacheControl.length === 0
      })) {
    throw new Error(`protected release asset manifest is invalid: ${manifestFile}`)
  }
  return manifest
}

function normalizeActiveProtection(value) {
  assertExactFields(value, [
    'deploymentGeneration', 'imageDigest', 'releaseId', 'rolloutId', 'slot'
  ], 'GC active protection')
  return {
    releaseId: normalizeReleaseId(value.releaseId),
    slot: ['blue', 'green'].includes(value.slot) ? value.slot : invalid('GC active protection slot is invalid'),
    imageDigest: /^sha256:[0-9a-f]{64}$/u.test(value.imageDigest) ? value.imageDigest : invalid('GC active protection image digest is invalid'),
    deploymentGeneration: Number.isSafeInteger(value.deploymentGeneration) && value.deploymentGeneration > 0
      ? value.deploymentGeneration : invalid('GC active protection generation is invalid'),
    rolloutId: /^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/u.test(value.rolloutId)
      ? value.rolloutId : invalid('GC active protection rollout id is invalid')
  }
}

function assertSafeStoreRoot(store) {
  const metadata = fs.lstatSync(store, { throwIfNoEntry: false })
  if (metadata?.isSymbolicLink()) throw new Error('release asset store root must not be a symlink')
  if (metadata && !metadata.isDirectory()) throw new Error('release asset store root must be a directory')
  if (metadata && fs.realpathSync(store) !== path.resolve(store)) {
    throw new Error('release asset store path contains a symlink or non-canonical segment')
  }
  for (const child of ['releases', 'objects']) {
    const childPath = path.join(store, child)
    const childMetadata = fs.lstatSync(childPath, { throwIfNoEntry: false })
    if (childMetadata?.isSymbolicLink()) throw new Error(`release asset ${child} root must not be a symlink`)
    if (childMetadata && !childMetadata.isDirectory()) throw new Error(`release asset ${child} root must be a directory`)
  }
}

function assertDeletionTarget(store, target, activeReleaseId) {
  const relative = path.relative(store, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('GC deletion target escapes the release asset store')
  const metadata = fs.lstatSync(target, { throwIfNoEntry: false })
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new Error(`GC deletion target is not an owned directory: ${target}`)
  const canonicalStore = fs.realpathSync(store)
  const canonicalTarget = fs.realpathSync(target)
  if (canonicalTarget !== path.resolve(target)
      || !canonicalTarget.startsWith(`${canonicalStore}${path.sep}`)) {
    throw new Error('GC deletion target escapes the canonical release asset store')
  }
  if (activeReleaseId && path.basename(target) === activeReleaseId) throw new Error('GC deletion target is the active release')
  rejectSymlinks(target)
}

function rejectSymlinks(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`GC deletion target contains a symlink: ${candidate}`)
    if (entry.isDirectory()) rejectSymlinks(candidate)
  }
}

function digestJson(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function assertExactFields(value, expectedFields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  if (Object.keys(value).sort().join(',') !== [...expectedFields].sort().join(',')) {
    throw new Error(`${label} fields are not closed exact`)
  }
}

function invalid(message) {
  throw new Error(message)
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
