import { createCurrentRolloutFixtureBinding } from './support/release-rollout-evidence-fixture.mjs'
import assert from 'node:assert/strict';
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRolloutState, writeRolloutStateAtomic } from '../../tools/deployment/release-rollout-lib.mjs'
import {
  createEmptySlotState,
  recordSlotStart,
  setActiveSlot,
  writeSlotStateAtomic
} from '../../tools/deployment/slot-lib.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const tool = path.join(root, 'tools/storage/prepare-release-retention.mjs')
const sourceRelease = '20260710010101-aaaaaaaaaaaa'
const targetRelease = '20260711010101-bbbbbbbbbbbb'
const sourceDigest = `sha256:${'a'.repeat(64)}`
const targetDigest = `sha256:${'b'.repeat(64)}`

test('retention transition protects target and source before switch then clears only drain marker', (t) => {
  const fixture = createFixture(t)

  const prepared = run(fixture, 'prepare', fixture.preparedEvidence)
  assert.equal(prepared.status, 0, prepared.stderr)
  let state = JSON.parse(fs.readFileSync(fixture.retentionState, 'utf8'))
  assert.equal(state.activeReleaseId, targetRelease)
  assert.equal(state.previousReleaseId, sourceRelease)
  assert.deepEqual(state.drainingReleaseIds, [sourceRelease])
  assert.equal(state.minimumRetainedReleaseCount, 2)
  const preparedEvidence = JSON.parse(fs.readFileSync(fixture.preparedEvidence, 'utf8'))
  assert.equal(preparedEvidence.status, 'pass')
  assert.equal(preparedEvidence.rolloutId, fixture.rollout.rolloutId)
  assert.match(preparedEvidence.retentionStateSha256, /^sha256:[0-9a-f]{64}$/u)

  setActiveSlot(fixture.slots, { slot: 'green', kind: 'switch' })
  writeSlotStateAtomic(fixture.slotState, fixture.slots)
  const completed = run(fixture, 'complete-drain', fixture.completedEvidence)
  assert.equal(completed.status, 0, completed.stderr)
  state = JSON.parse(fs.readFileSync(fixture.retentionState, 'utf8'))
  assert.equal(state.activeReleaseId, targetRelease)
  assert.equal(state.previousReleaseId, sourceRelease)
  assert.deepEqual(state.drainingReleaseIds, [])
})

test('retention transition fails closed when durable active identity is not rollout source', (t) => {
  const fixture = createFixture(t)
  setActiveSlot(fixture.slots, { slot: 'green', kind: 'switch' })
  writeSlotStateAtomic(fixture.slotState, fixture.slots)

  const result = run(fixture, 'prepare', fixture.preparedEvidence)

  assert.notEqual(result.status, 0)
  const evidence = JSON.parse(fs.readFileSync(fixture.preparedEvidence, 'utf8'))
  assert.equal(evidence.status, 'fail')
  assert.match(evidence.errors.join('\n'), /does not match rollout source before switch/u)
  assert.equal(fs.existsSync(fixture.retentionState), false)
})

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-retention-transition-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = path.join(directory, 'assets')
  materializeMetadata(store, sourceRelease, 'blue')
  materializeMetadata(store, targetRelease, 'green')
  const slotState = path.join(directory, 'slots.json')
  const slots = createEmptySlotState('2026-07-11T00:00:00.000Z')
  recordSlotStart(slots, {
    slot: 'blue', releaseId: sourceRelease,
    imageRef: `registry.example/fsusblog@${sourceDigest}`,
    imageDigest: sourceDigest,
    startedAt: '2026-07-11T00:00:01.000Z'
  })
  setActiveSlot(slots, { slot: 'blue', kind: 'bootstrap', changedAt: '2026-07-11T00:00:02.000Z' })
  recordSlotStart(slots, {
    slot: 'green', releaseId: targetRelease,
    imageRef: `registry.example/fsusblog@${targetDigest}`,
    imageDigest: targetDigest,
    startedAt: '2026-07-11T00:00:03.000Z'
  })
  writeSlotStateAtomic(slotState, slots)
  const rolloutFile = path.join(directory, 'rollout.json')
  const manifestPath = path.join(directory, 'target-release-manifest.json')
  fs.writeFileSync(manifestPath, '{}\n')
  const rollout = createRolloutState({
    ...createCurrentRolloutFixtureBinding(),
    manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'),
    rolloutId: 'retention-transition-001',
    manifestPath,
    source: { slot: 'blue', releaseId: sourceRelease, imageDigest: sourceDigest, runtimeGeneration: 1 },
    target: { slot: 'green', releaseId: targetRelease, imageDigest: targetDigest, runtimeGeneration: 2 },
    createdAtUtc: '2026-07-11T00:00:04.000Z'
  })
  writeRolloutStateAtomic(rolloutFile, rollout)
  return {
    directory, store, slotState, slots, rolloutFile, rollout,
    retentionState: path.join(directory, 'retention-state.json'),
    preparedEvidence: path.join(directory, 'retention-prepared.json'),
    completedEvidence: path.join(directory, 'retention-completed.json')
  }
}

function materializeMetadata(store, releaseId, slot) {
  const releaseDirectory = path.join(store, 'releases', releaseId)
  fs.mkdirSync(releaseDirectory, { recursive: true })
  const manifestFile = path.join(releaseDirectory, 'asset-manifest.json')
  fs.writeFileSync(manifestFile, `${JSON.stringify({
    schema: 'fsusblog.release-assets.v1',
    releaseId,
    slot,
    frontendBuildId: releaseId,
    files: []
  }, null, 2)}\n`)
  const manifestHash = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex')}`
  fs.writeFileSync(path.join(releaseDirectory, 'release-compatibility.json'), `${JSON.stringify({ releaseId, assetManifestSha256: manifestHash }, null, 2)}\n`)
}

function run(fixture, command, out) {
  return spawnSync(process.execPath, [
    tool, command,
    '--rollout-state', fixture.rolloutFile,
    '--slot-state', fixture.slotState,
    '--state', fixture.retentionState,
    '--store', fixture.store,
    '--out', out
  ], { cwd: root, encoding: 'utf8' })
}
