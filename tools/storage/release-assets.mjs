import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isValidReleaseId, RELEASE_ID_CONTRACT } from '../release/release-id.mjs';
import { validateCurrentReleaseAssetInventory } from './release-asset-value-contract.mjs';

export const RELEASE_ASSET_MANIFEST_SCHEMA = 'fsusblog.release-assets.v1';
export const MATERIALIZATION_REPORT_SCHEMA = 'fsusblog.release-assets.materialization.v1';

const MUTABLE_ENTRY_NAMES = new Set([
    'index.html',
    'sw.js',
  'manifest.webmanifest',
  'release-compatibility.json',
  '.vite/manifest.json'
])
const GENERATED_RELEASE_FILES = new Set(['asset-manifest.json', 'release-compatibility.json'])

export function sha256Buffer(payload) {
  return `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`
}

export function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file))
}

export function normalizeReleaseId(value)
{
    const releaseId = String(value ?? '');
    if (!isValidReleaseId(releaseId))
{
        throw new Error('releaseId must be a safe immutable identifier');
    }
    return releaseId;
}

export function normalizeSlot(value) {
  const slot = String(value ?? '')
  if (slot !== 'blue' && slot !== 'green') throw new Error('slot must be blue or green')
  return slot
}

export function normalizeRelativePath(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error('asset path must be a non-empty relative path')
  }
  const segments = normalized.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`asset path contains traversal or empty segments: ${value}`)
  }
  return segments.join('/')
}

export function releaseAssetUrl(releaseId, relativePath) {
  return `/release-assets/${normalizeReleaseId(releaseId)}/${normalizeRelativePath(relativePath)}`
}

export function isMutableEntry(relativePath) {
  const normalized = normalizeRelativePath(relativePath)
  return MUTABLE_ENTRY_NAMES.has(normalized)
}

export function enumerateAssetFiles(sourceDirectory) {
  const source = path.resolve(sourceDirectory)
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`asset source directory does not exist: ${source}`)
  }
  const result = []
  const visit = (directory, prefix = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const relativePath = normalizeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name)
      const absolutePath = path.join(directory, entry.name)
      if (!prefix && GENERATED_RELEASE_FILES.has(relativePath)) continue
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are forbidden in release assets: ${relativePath}`)
      if (entry.isDirectory()) visit(absolutePath, relativePath)
      else if (entry.isFile()) result.push({ relativePath, absolutePath })
      else throw new Error(`unsupported release asset entry: ${relativePath}`)
    }
  }
  visit(source)
  return result
}

export function buildReleaseAssetManifest({ releaseId, slot, sourceDirectory, compatibility = null }) {
  const normalizedReleaseId = normalizeReleaseId(releaseId)
  const normalizedSlot = normalizeSlot(slot)
  const files = enumerateAssetFiles(sourceDirectory).map(({ relativePath, absolutePath }) => {
    const stat = fs.statSync(absolutePath)
    const mutable = isMutableEntry(relativePath)
    return {
      path: relativePath,
      sha256: sha256File(absolutePath),
      bytes: stat.size,
      class: mutable ? 'mutable-entry' : 'immutable-static',
      releaseUrl: releaseAssetUrl(normalizedReleaseId, relativePath),
      cacheControl: mutable
        ? 'no-store,max-age=0,must-revalidate'
        : 'public,max-age=31536000,immutable'
    }
  })
  const manifest = {
    schema: RELEASE_ASSET_MANIFEST_SCHEMA,
    releaseId: normalizedReleaseId,
    slot: normalizedSlot,
    frontendBuildId: normalizedReleaseId,
    files,
    compatibilityFile: compatibility ? 'release-compatibility.json' : null
  }
  if (compatibility === null) validateCurrentReleaseAssetInventory(manifest, normalizedReleaseId, RELEASE_ID_CONTRACT)
  return manifest
}

export function materializeReleaseAssets({
  releaseId,
  slot,
  sourceDirectory,
  storeDirectory,
  compatibility = null,
  dryRun = true
}) {
  const store = path.resolve(storeDirectory)
  if (!dryRun) {
    fs.mkdirSync(store, { recursive: true, mode: 0o755 })
    fs.chmodSync(store, 0o755)
  }
  const manifest = buildReleaseAssetManifest({ releaseId, slot, sourceDirectory, compatibility })
  const sourceByRelativePath = new Map(enumerateAssetFiles(sourceDirectory).map(file => [file.relativePath, file.absolutePath]))
  const actions = []

  for (const file of manifest.files) {
    const objectPath = path.join(store, 'objects', file.sha256.slice('sha256:'.length), file.path)
    const releasePath = path.join(store, 'releases', manifest.releaseId, file.path)
    for (const target of [objectPath, releasePath]) {
      const existing = fs.statSync(target, { throwIfNoEntry: false })
      if (existing) {
        if (!existing.isFile()) throw new Error(`release asset target is not a file: ${target}`)
        const existingHash = sha256File(target)
        if (existingHash !== file.sha256) {
          throw new Error(`append-only asset conflict at ${target}: expected ${file.sha256}, found ${existingHash}`)
        }
        actions.push({ action: 'retain-identical', path: target, sha256: file.sha256 })
        continue
      }
      actions.push({ action: 'install', path: target, sha256: file.sha256 })
      if (!dryRun) installFileNoReplace(sourceByRelativePath.get(file.path), target, file.sha256)
    }
  }

  const manifestPayload = `${JSON.stringify(manifest, null, 2)}\n`
  const manifestHash = sha256Buffer(manifestPayload)
  const manifestPath = path.join(store, 'releases', manifest.releaseId, 'asset-manifest.json')
  const existingManifest = fs.statSync(manifestPath, { throwIfNoEntry: false })
  if (existingManifest) {
    const existingHash = sha256File(manifestPath)
    if (existingHash !== manifestHash) {
      throw new Error(`release asset manifest conflict for ${manifest.releaseId}: expected ${manifestHash}, found ${existingHash}`)
    }
    actions.push({ action: 'retain-identical', path: manifestPath, sha256: manifestHash })
  } else {
    actions.push({ action: 'install-manifest', path: manifestPath, sha256: manifestHash })
    if (!dryRun) installBufferNoReplace(Buffer.from(manifestPayload), manifestPath, manifestHash)
  }

  let compatibilityPath = null
  let boundCompatibility = null
  if (compatibility) {
    boundCompatibility = {
      ...compatibility,
      assetManifestSha256: manifestHash
    }
    const compatibilityPayload = `${JSON.stringify(boundCompatibility, null, 2)}\n`
    const compatibilityHash = sha256Buffer(compatibilityPayload)
    compatibilityPath = path.join(store, 'releases', manifest.releaseId, 'release-compatibility.json')
    const existingCompatibility = fs.statSync(compatibilityPath, { throwIfNoEntry: false })
    if (existingCompatibility) {
      const existingHash = sha256File(compatibilityPath)
      if (existingHash !== compatibilityHash) {
        throw new Error(`release compatibility metadata conflict for ${manifest.releaseId}: expected ${compatibilityHash}, found ${existingHash}`)
      }
      actions.push({ action: 'retain-identical', path: compatibilityPath, sha256: compatibilityHash })
    } else {
      actions.push({ action: 'install-compatibility', path: compatibilityPath, sha256: compatibilityHash })
      if (!dryRun) installBufferNoReplace(Buffer.from(compatibilityPayload), compatibilityPath, compatibilityHash)
    }
  }

  const report = {
    schema: MATERIALIZATION_REPORT_SCHEMA,
    status: dryRun ? 'dry-run' : 'ok',
    releaseId: manifest.releaseId,
    slot: manifest.slot,
    dryRun,
    storeDirectory: store,
    assetManifest: manifestPath,
    assetManifestSha256: manifestHash,
    compatibilityMetadata: compatibilityPath,
    compatibility: boundCompatibility,
    assets: manifest.files,
    actions,
    errors: []
  }
  return { manifest, report }
}

export function writeJsonAtomic(file, value, { replace = true } = {}) {
  const target = path.resolve(file)
  const payload = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  if (!replace) return installBufferNoReplace(payload, target, sha256Buffer(payload))
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
  fs.chmodSync(path.dirname(target), 0o755)
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(temporary, payload, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, target)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function installFileNoReplace(source, target, expectedHash) {
  if (!source) throw new Error(`source asset is missing for ${target}`)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
  fs.chmodSync(path.dirname(target), 0o755)
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(temporary, 0o444)
    if (sha256File(temporary) !== expectedHash) throw new Error(`asset changed while materializing: ${source}`)
    try {
      fs.linkSync(temporary, target)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existingHash = sha256File(target)
      if (existingHash !== expectedHash) throw new Error(`append-only asset conflict at ${target}`)
    }
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function installBufferNoReplace(payload, target, expectedHash) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(temporary, payload, { flag: 'wx', mode: 0o444 })
    if (sha256File(temporary) !== expectedHash) throw new Error(`generated asset hash changed before install: ${target}`)
    try {
      fs.linkSync(temporary, target)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existingHash = sha256File(target)
      if (existingHash !== expectedHash) throw new Error(`append-only generated asset conflict at ${target}`)
    }
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}
