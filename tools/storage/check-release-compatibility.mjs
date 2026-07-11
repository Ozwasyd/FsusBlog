#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { normalizeReleaseId, writeJsonAtomic } from './release-assets.mjs'
import { buildCompatibilityMatrix, COMPATIBILITY_MATRIX_SCHEMA } from './release-compatibility.mjs'
import { normalizeGcState } from './release-gc.mjs'

let options = {}
try {
  options = parseArgs(process.argv.slice(2))
  const store = path.resolve(options.store ?? process.env.FSUSBLOG_RELEASE_ASSET_STORE ?? '/var/lib/fsusblog/release-assets')
  const candidateReleaseId = normalizeReleaseId(required(options, 'candidate'))
  const activeReleaseId = normalizeReleaseId(required(options, 'active'))
  const previousReleaseId = normalizeReleaseId(required(options, 'previous'))
  const stateFile = path.resolve(options.state ?? process.env.FSUSBLOG_RELEASE_RETENTION_STATE ?? path.join(store, 'retention-state.json'))
  const state = normalizeGcState(JSON.parse(fs.readFileSync(stateFile, 'utf8')))
  const matrix = buildCompatibilityMatrix({
    candidate: readCompatibility(store, candidateReleaseId),
    active: readCompatibility(store, activeReleaseId),
    previous: readCompatibility(store, previousReleaseId),
    retainedAssetReleaseIds: [
      state.activeReleaseId,
      state.previousReleaseId,
      ...state.drainingReleaseIds,
      ...state.retentionReleaseIds,
      ...state.referencedReleaseIds
    ].filter(Boolean)
  })
  const report = { ...matrix, storeDirectory: store, retentionState: stateFile }
  emit(report, options.out)
  if (matrix.status !== 'pass') process.exitCode = 1
} catch (error) {
  const report = {
    schema: COMPATIBILITY_MATRIX_SCHEMA,
    status: 'fail',
    scenarios: [],
    errors: [error instanceof Error ? error.message : String(error)]
  }
  try { emit(report, options.out) } catch { process.stdout.write(`${JSON.stringify(report)}\n`) }
  process.exitCode = 1
}

function readCompatibility(store, releaseId) {
  const releaseDirectory = path.join(store, 'releases', releaseId)
  const manifestFile = path.join(releaseDirectory, 'asset-manifest.json')
  const compatibilityFile = path.join(releaseDirectory, 'release-compatibility.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const compatibility = JSON.parse(fs.readFileSync(compatibilityFile, 'utf8'))
  if (manifest.releaseId !== releaseId || compatibility.releaseId !== releaseId) {
    throw new Error(`release compatibility metadata is missing or mismatched: ${releaseId}`)
  }
  return compatibility
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${name ?? '<end>'}`)
    parsed[name.slice(2)] = value
  }
  return parsed
}

function required(parsed, name) {
  if (!parsed[name]) throw new Error(`missing --${name}`)
  return parsed[name]
}

function emit(report, outputFile) {
  if (outputFile) writeJsonAtomic(path.resolve(outputFile), report)
  process.stdout.write(`${JSON.stringify(report)}\n`)
}
