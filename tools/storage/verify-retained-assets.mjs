#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { readReleaseManifest } from '../release/release-manifest.mjs'
import { normalizeSlot, sha256File, writeJsonAtomic } from './release-assets.mjs'
import { normalizeGcState, planReleaseAssetGc } from './release-gc.mjs'

const schema = 'fsusblog.release-assets.retention-verification.v1'
let options = {}
try {
  options = parseArgs(process.argv.slice(2))
  const releaseManifestFile = requiredPath(options, 'release-manifest')
  const releaseManifest = readReleaseManifest(releaseManifestFile, { requireRegistryDigest: true })
  const slot = normalizeSlot(options.slot)
  const storeDirectory = path.resolve(options.store ?? process.env.FSUSBLOG_RELEASE_ASSET_STORE ?? '/var/lib/fsusblog/release-assets')
  const stateFile = path.resolve(options.state ?? process.env.FSUSBLOG_RELEASE_RETENTION_STATE ?? path.join(storeDirectory, 'retention-state.json'))
  const state = normalizeGcState(JSON.parse(fs.readFileSync(stateFile, 'utf8')))
  const plan = planReleaseAssetGc({ storeDirectory, state })
  const candidate = plan.releases.find(release => release.releaseId === releaseManifest.releaseId)
  const errors = []
  if (!candidate) errors.push(`candidate release assets are missing: ${releaseManifest.releaseId}`)
  else if (!candidate.protected) errors.push(`candidate release is not protected by retention state: ${releaseManifest.releaseId}`)
  const protectedReleases = plan.releases.filter(release => release.protected)
  if (protectedReleases.length < 2) errors.push('retention state must protect at least active and previous releases')

  const assets = []
  for (const release of protectedReleases) {
    verifyRelease(storeDirectory, release.releaseId, assets, errors)
  }
  const report = {
    schema,
    status: errors.length === 0 ? (options['dry-run'] === true ? 'dry-run' : 'pass') : 'fail',
    releaseId: releaseManifest.releaseId,
    slot,
    dryRun: options['dry-run'] === true,
    releaseManifest: releaseManifestFile,
    retentionState: stateFile,
    protectedReleaseIds: protectedReleases.map(release => release.releaseId),
    assets,
    errors
  }
  emit(report, options.out)
  if (errors.length > 0) process.exitCode = 1
} catch (error) {
  const report = {
    schema,
    status: 'fail',
    releaseId: null,
    slot: options.slot ?? null,
    dryRun: options['dry-run'] === true,
    protectedReleaseIds: [],
    assets: [],
    errors: [error instanceof Error ? error.message : String(error)]
  }
  try { emit(report, options.out) } catch { process.stdout.write(`${JSON.stringify(report)}\n`) }
  process.exitCode = 1
}

function verifyRelease(store, releaseId, assets, errors) {
  const releaseDirectory = path.join(store, 'releases', releaseId)
  const manifestFile = path.join(releaseDirectory, 'asset-manifest.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch (error) {
    errors.push(`cannot read retained manifest ${releaseId}: ${error.message}`)
    return
  }
  if (manifest.releaseId !== releaseId || !Array.isArray(manifest.files)) {
    errors.push(`retained manifest identity is invalid: ${releaseId}`)
    return
  }
  const manifestSha256 = sha256File(manifestFile)
  const compatibilityFile = path.join(releaseDirectory, 'release-compatibility.json')
  if (!fs.statSync(compatibilityFile, { throwIfNoEntry: false })?.isFile()) {
    errors.push(`retained compatibility metadata is missing: ${releaseId}`)
  } else {
    try {
      const compatibility = JSON.parse(fs.readFileSync(compatibilityFile, 'utf8'))
      if (compatibility.releaseId !== releaseId || compatibility.assetManifestSha256 !== manifestSha256) {
        errors.push(`retained compatibility metadata is not bound to asset manifest: ${releaseId}`)
      }
    } catch (error) {
      errors.push(`retained compatibility metadata is invalid ${releaseId}: ${error.message}`)
    }
  }
  for (const file of manifest.files) {
    const releasePath = path.join(releaseDirectory, file.path)
    const objectPath = path.join(store, 'objects', String(file.sha256).slice('sha256:'.length), file.path)
    const item = { releaseId, path: file.path, sha256: file.sha256, releaseCopy: 'missing', objectCopy: 'missing' }
    for (const [field, candidate] of [['releaseCopy', releasePath], ['objectCopy', objectPath]]) {
      if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
        errors.push(`${releaseId}:${file.path} ${field} is missing`)
        continue
      }
      const actual = sha256File(candidate)
      item[field] = actual === file.sha256 ? 'verified' : 'hash-mismatch'
      if (actual !== file.sha256) errors.push(`${releaseId}:${file.path} ${field} hash mismatch`)
    }
    assets.push(item)
  }
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--dry-run') {
      parsed['dry-run'] = true
      continue
    }
    if (!name?.startsWith('--')) throw new Error(`invalid argument: ${name ?? '<end>'}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`)
    parsed[name.slice(2)] = value
    index += 1
  }
  return parsed
}

function requiredPath(parsed, name) {
  if (!parsed[name]) throw new Error(`missing --${name}`)
  return path.resolve(parsed[name])
}

function emit(report, outputFile) {
  if (outputFile) writeJsonAtomic(path.resolve(outputFile), report)
  process.stdout.write(`${JSON.stringify(report)}\n`)
}
