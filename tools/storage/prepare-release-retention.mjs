#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { readRolloutState } from '../deployment/release-rollout-lib.mjs'
import { readSlotState } from '../deployment/slot-lib.mjs'
import { normalizeGcState, RELEASE_GC_STATE_SCHEMA } from './release-gc.mjs'
import { normalizeReleaseId, sha256File, writeJsonAtomic } from './release-assets.mjs'

const EVIDENCE_SCHEMA = 'fsusblog.release-assets.retention-transition.v1'

let options = {}
try {
  const { command, parsed } = parseArgs(process.argv.slice(2))
  options = parsed
  const rolloutFile = requiredPath(options, 'rollout-state')
  const slotFile = requiredPath(options, 'slot-state')
  const stateFile = requiredPath(options, 'state')
  const store = path.resolve(options.store ?? process.env.FSUSBLOG_RELEASE_ASSET_STORE ?? '/var/lib/fsusblog/release-assets')
  const rollout = readRolloutState(rolloutFile)
  const slots = readSlotState(slotFile, { allowMissing: false })
  assertTransitionIdentity(slots, rollout, command)
  assertMaterializedRelease(store, rollout.source.releaseId)
  assertMaterializedRelease(store, rollout.target.releaseId)
  const previous = readOptionalState(stateFile)
  const next = command === 'prepare'
    ? prepareState(previous, rollout)
    : completeDrainState(previous, rollout)
  writeJsonAtomic(stateFile, next)
  const persisted = normalizeGcState(JSON.parse(fs.readFileSync(stateFile, 'utf8')))
  if (JSON.stringify(persisted) !== JSON.stringify(next)) throw new Error('persisted retention state changed during atomic write')
  const report = {
    schema: EVIDENCE_SCHEMA,
    status: 'pass',
    action: command,
    rolloutId: rollout.rolloutId,
    source: rollout.source,
    target: rollout.target,
    retentionState: stateFile,
    retentionStateSha256: sha256File(stateFile),
    state: persisted,
    errors: []
  }
  emit(report, options.out)
} catch (error) {
  const report = {
    schema: EVIDENCE_SCHEMA,
    status: 'fail',
    action: options.command ?? null,
    rolloutId: null,
    errors: [error instanceof Error ? error.message : String(error)]
  }
  try { emit(report, options.out) } catch { process.stdout.write(`${JSON.stringify(report)}\n`) }
  process.exitCode = 1
}

function parseArgs(argv) {
  const command = argv.shift()
  if (!['prepare', 'complete-drain'].includes(command)) {
    throw new Error('usage: prepare-release-retention.mjs <prepare|complete-drain> --rollout-state <file> --slot-state <file> --state <file> --store <dir> --out <file>')
  }
  const parsed = { command }
  while (argv.length > 0) {
    const name = argv.shift()
    const value = argv.shift()
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`invalid argument near ${name ?? '<end>'}`)
    parsed[name.slice(2)] = value
  }
  return { command, parsed }
}

function requiredPath(parsed, name) {
  if (!parsed[name]) throw new Error(`missing --${name}`)
  return path.resolve(parsed[name])
}

function readOptionalState(file) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return null
  return normalizeGcState(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function assertTransitionIdentity(slots, rollout, command) {
  if (slots.status !== 'stable') throw new Error('slot state must be stable before retention transition')
  const expected = command === 'prepare' ? rollout.source : rollout.target
  if (slots.activeSlot !== expected.slot
    || slots.activeReleaseId !== expected.releaseId
    || slots.activeImageDigest !== expected.imageDigest) {
    throw new Error(`durable active slot does not match rollout ${command === 'prepare' ? 'source before switch' : 'target after switch'}`)
  }
}

function assertMaterializedRelease(store, releaseIdValue) {
  const releaseId = normalizeReleaseId(releaseIdValue)
  const manifestFile = path.join(store, 'releases', releaseId, 'asset-manifest.json')
  const compatibilityFile = path.join(store, 'releases', releaseId, 'release-compatibility.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const compatibility = JSON.parse(fs.readFileSync(compatibilityFile, 'utf8'))
  if (manifest.schema !== 'fsusblog.release-assets.v1' || manifest.releaseId !== releaseId || !Array.isArray(manifest.files)) {
    throw new Error(`release asset manifest is invalid: ${releaseId}`)
  }
  if (compatibility.releaseId !== releaseId || compatibility.assetManifestSha256 !== sha256File(manifestFile)) {
    throw new Error(`release compatibility metadata is not bound to assets: ${releaseId}`)
  }
}

function prepareState(previous, rollout) {
  const existing = previous ?? emptyState(rollout.source.releaseId)
  return normalizeGcState({
    schema: RELEASE_GC_STATE_SCHEMA,
    activeReleaseId: rollout.target.releaseId,
    previousReleaseId: rollout.source.releaseId,
    drainingReleaseIds: unique([...existing.drainingReleaseIds, rollout.source.releaseId]),
    retentionReleaseIds: unique(existing.retentionReleaseIds),
    referencedReleaseIds: unique(existing.referencedReleaseIds),
    minimumRetainedReleaseCount: Math.max(2, existing.minimumRetainedReleaseCount)
  })
}

function completeDrainState(previous, rollout) {
  if (!previous) throw new Error('retention state must be prepared before source drain completion')
  if (previous.activeReleaseId !== rollout.target.releaseId || previous.previousReleaseId !== rollout.source.releaseId) {
    throw new Error('retention state is not bound to this rollout transition')
  }
  return normalizeGcState({
    ...previous,
    drainingReleaseIds: previous.drainingReleaseIds.filter(releaseId => releaseId !== rollout.source.releaseId)
  })
}

function emptyState(activeReleaseId) {
  return {
    schema: RELEASE_GC_STATE_SCHEMA,
    activeReleaseId,
    previousReleaseId: null,
    drainingReleaseIds: [],
    retentionReleaseIds: [],
    referencedReleaseIds: [],
    minimumRetainedReleaseCount: 2
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function emit(report, outputFile) {
  if (outputFile) writeJsonAtomic(path.resolve(outputFile), report)
  process.stdout.write(`${JSON.stringify(report)}\n`)
}
