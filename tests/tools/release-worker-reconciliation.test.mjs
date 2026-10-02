import { createCurrentRolloutFixtureBinding } from './support/release-rollout-evidence-fixture.mjs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createRolloutState,
  writeRolloutStateAtomic
} from '../../tools/deployment/release-rollout-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cli = path.join(root, 'tools/deployment/release-worker-reconciliation.mjs')
const normalKinds = [
  'scheduled-publish',
  'article-mutation-outbox',
  'audit-writer',
  'visit-view-projection',
  'public-hot-aot',
  'upload-cleanup',
  'active-singleton-control',
  'multi-consumer-safe-control'
]
const qualificationKinds = [...normalKinds, 'forced-source-recovery']
const source = {
  slot: 'blue',
  releaseId: '20260711010101-aaaaaaaaaaaa',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtimeGeneration: 71
}
const target = {
  slot: 'green',
  releaseId: '20260711020202-bbbbbbbbbbbb',
  imageDigest: `sha256:${'b'.repeat(64)}`,
  runtimeGeneration: 72
}

test('normal mode proves graceful reconciliation without a synthetic forced-source event', t => {
  const fixture = makeFixture(t, 'normal')
  const rollout = writeState(fixture, 'normal-rollout-20260711')
  const ledger = workerLedger(rollout, normalKinds, { forced: false })
  writeJson(fixture.ledger, ledger)
  writeJson(fixture.health, targetHealth(rollout, fixture.ledger))
  writeJson(fixture.drain, {
    schema: 'fsusblog.release-rollout-gate.v1',
    gate: 'source-drain',
    status: 'pass',
    observations: { blockers: [] },
    errors: []
  })

  const result = runCli([
    '--mode', 'normal',
    '--rollout-state', fixture.state,
    '--ledger', fixture.ledger,
    '--source-drain', fixture.drain,
    '--target-health', fixture.health,
    '--out', fixture.out
  ])
  assert.equal(result.status, 0, result.stderr)
  const evidence = readJson(fixture.out)
  assert.equal(evidence.schema, 'fsusblog.release-worker-reconciliation-evidence.v2')
  assert.equal(evidence.mode, 'normal')
  assert.equal(evidence.status, 'pass')
  assert.equal(evidence.gracefulDrainVerified, true)
  assert.equal(evidence.forcedSourceRecoveryRequired, false)
  assert.equal(evidence.forcedSourceRecoveryVerified, false)
  assert.equal(evidence.checks.requiredWorkerKindsCovered, true)
  assert.deepEqual(evidence.kinds.sort(), [...normalKinds].sort())
  assert.ok(evidence.requiredChecks.includes('graceful-source-drain'))
})

test('qualification mode binds a nine-kind SIGKILL takeover to immutable target and policy identities', t => {
  const fixture = makeFixture(t, 'qualification')
  const rollout = writeState(fixture, 'qualification-rollout-20260711')
  const qualificationId = 'worker-qualification-run-20260711'
  const ledger = workerLedger(rollout, qualificationKinds, { forced: true, qualificationId })
  writeJson(fixture.ledger, ledger)
  writeJson(fixture.health, targetHealth(rollout, fixture.ledger))
  writeJson(fixture.scenario, { schema: 'fsusblog.release-worker-drill-plan.v1', rolloutId: rollout.rolloutId })
  writeJson(fixture.policy, {
    schema: 'fsusblog.zero-downtime-resource-policy.v1',
    minimumSupported: { cpuCores: 4, memoryMiB: 6144, freeDiskMiB: 10240 },
    budgets: { dualSlotCpuPercent: 360 },
    sampling: { intervalMs: 1000, minimumOverlapSamples: 10 }
  })
  writeJson(fixture.control, qualificationControl(rollout, fixture.ledger, fixture.scenario, ledger))

  const result = runCli([
    '--mode', 'qualification',
    '--qualification-id', qualificationId,
    '--rollout-state', fixture.state,
    '--ledger', fixture.ledger,
    '--qualification-control', fixture.control,
    '--resource-policy', fixture.policy,
    '--target-health', fixture.health,
    '--out', fixture.out
  ])
  assert.equal(result.status, 0, result.stderr)
  const evidence = readJson(fixture.out)
  assert.equal(evidence.mode, 'qualification')
  assert.equal(evidence.status, 'pass')
  assert.equal(evidence.forcedSourceRecoveryRequired, true)
  assert.equal(evidence.forcedSourceRecoveryVerified, true)
  assert.equal(evidence.checks.allKindsRecoveredByTarget, true)
  assert.equal(evidence.qualification.qualificationId, qualificationId)
  assert.equal(evidence.qualification.targetImageDigest, target.imageDigest)
  assert.match(evidence.qualification.resourcePolicySha256, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(evidence.qualification.freshNormalRolloutRequired, true)
  assert.equal(evidence.qualification.normalRolloutSeparationVerified, false)
  assert.ok(evidence.requiredChecks.includes('nine-worker-kind-forced-recovery'))
})

test('qualification post-check rejects reuse of the destructive rollout as the normal rollout', t => {
  const fixture = makeFixture(t, 'qualification-reuse')
  const rollout = writeState(fixture, 'qualification-rollout-reused')
  const qualificationId = 'worker-qualification-run-reused'
  const ledger = workerLedger(rollout, qualificationKinds, { forced: true, qualificationId })
  writeJson(fixture.ledger, ledger)
  writeJson(fixture.health, targetHealth(rollout, fixture.ledger))
  writeJson(fixture.scenario, { schema: 'fsusblog.release-worker-drill-plan.v1', rolloutId: rollout.rolloutId })
  writeJson(fixture.policy, {
    schema: 'fsusblog.zero-downtime-resource-policy.v1',
    minimumSupported: { cpuCores: 4 }, budgets: {}, sampling: {}
  })
  writeJson(fixture.control, qualificationControl(rollout, fixture.ledger, fixture.scenario, ledger))

  const result = runCli([
    '--mode', 'qualification',
    '--qualification-id', qualificationId,
    '--rollout-state', fixture.state,
    '--ledger', fixture.ledger,
    '--qualification-control', fixture.control,
    '--resource-policy', fixture.policy,
    '--target-health', fixture.health,
    '--normal-rollout-state', fixture.state,
    '--out', fixture.out
  ])
  assert.equal(result.status, 1)
  const evidence = readJson(fixture.out)
  assert.equal(evidence.status, 'fail')
  assert.equal(evidence.checks.normalRolloutSeparationVerified, false)
  assert.ok(evidence.errors.includes('qualification and expected normal rolloutId must differ'))
})

test('semantic failures retain every upstream error without a maximum-error cap', t => {
  const fixture = makeFixture(t, 'all-errors')
  const rollout = writeState(fixture, 'normal-rollout-all-errors')
  const ledger = workerLedger(rollout, normalKinds, { forced: false })
  ledger.status = 'fail'
  ledger.errors = Array.from({ length: 64 }, (_, index) => `ledger-error-${index}`)
  writeJson(fixture.ledger, ledger)
  writeJson(fixture.health, targetHealth(rollout, fixture.ledger))
  writeJson(fixture.drain, {
    schema: 'fsusblog.release-rollout-gate.v1', gate: 'source-drain', status: 'pass', observations: { blockers: [] }, errors: []
  })

  const result = runCli([
    '--mode', 'normal',
    '--rollout-state', fixture.state,
    '--ledger', fixture.ledger,
    '--source-drain', fixture.drain,
    '--target-health', fixture.health,
    '--out', fixture.out
  ])
  assert.equal(result.status, 1)
  const evidence = readJson(fixture.out)
  for (let index = 0; index < 64; index += 1) {
    assert.ok(evidence.errors.includes(`worker ledger: ledger-error-${index}`))
  }
  assert.ok(evidence.errors.length >= 65)
})

function makeFixture(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-worker-reconciliation-${name}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return Object.fromEntries([
    'state', 'ledger', 'health', 'drain', 'scenario', 'policy', 'control', 'out'
  ].map(name => [name, path.join(directory, `${name}.json`)]))
}

function writeState(fixture, rolloutId) {
  const state = createRolloutState({
    ...createCurrentRolloutFixtureBinding(),
    rolloutId,
    kind: 'deploy',
    manifestPath: path.join(path.dirname(fixture.state), 'release-manifest.json'),
    source,
    target,
    createdAtUtc: '2026-07-11T00:00:00.000Z'
  })
  writeRolloutStateAtomic(fixture.state, state)
  return state
}

function workerLedger(rollout, kinds, { forced, qualificationId = null }) {
  const terminationCompletedAtUtc = '2026-07-11T00:10:00.000Z'
  const events = kinds.map((kind, index) => {
    const event = {
      logicalEventId: `worker-${kind}-${index}`,
      kind,
      attemptCount: forced ? 2 : 1,
      finalEffectCount: 1,
      finalEffectKey: `effect-${kind}-${index}`,
      finalReleaseId: rollout.target.releaseId,
      finalGeneration: rollout.target.runtimeGeneration,
      staleGenerationCommitCount: 0,
      pendingCountAtDrain: forced ? 1 : 0,
      durableReplaySource: 'postgres-outbox',
      observationBindings: Object.fromEntries([
        'finalEffectCount',
        'finalEffectKey',
        'finalReleaseId',
        'finalGeneration',
        'staleGenerationCommitCount'
      ].map(field => [field, { observedAtUtc: '2026-07-11T00:10:02.000Z' }])),
      errors: []
    }
    if (kind === 'audit-writer') {
      Object.assign(event, { expectedAuditCount: 1, actualAuditCount: 1 })
      event.observationBindings.actualAuditCount = { observedAtUtc: '2026-07-11T00:10:02.000Z' }
    }
    if (kind === 'visit-view-projection') {
      Object.assign(event, { expectedProjectionCount: 1, actualProjectionCount: 1 })
      event.observationBindings.actualProjectionCount = { observedAtUtc: '2026-07-11T00:10:02.000Z' }
    }
    if (kind === 'forced-source-recovery') {
      Object.assign(event, { forcedSourceTermination: true, recoveredByTarget: true })
      event.observationBindings.recoveredByTarget = { observedAtUtc: '2026-07-11T00:10:02.000Z' }
    }
    return event
  })
  return {
    schema: 'fsusblog.release-worker-event-ledger.v1',
    status: 'pass',
    rolloutId: rollout.rolloutId,
    source: ledgerIdentity(rollout.source),
    target: ledgerIdentity(rollout.target),
    drill: forced
      ? {
          runId: qualificationId,
          coordination: { mode: 'file-handshake', status: 'pass' },
          terminationBoundary: { status: 'pass' },
          targetReadiness: { status: 'pass', completedAtUtc: '2026-07-11T00:09:59.000Z' },
          sourceTermination: {
            type: 'docker-kill',
            status: 'pass',
            forced: true,
            completedAtUtc: terminationCompletedAtUtc,
            observation: { signal: 'SIGKILL' }
          },
          targetTakeover: { status: 'pass', completedAtUtc: '2026-07-11T00:10:01.000Z' }
        }
      : null,
    events,
    errors: []
  }
}

function ledgerIdentity(identity) {
  return {
    releaseId: identity.releaseId,
    slot: identity.slot,
    generation: identity.runtimeGeneration
  }
}

function targetHealth(rollout, ledgerFile) {
  const ledger = readJson(ledgerFile)
  return {
    schema: 'fsusblog.release-worker-target-health.v1',
    status: 'healthy',
    rolloutId: rollout.rolloutId,
    releaseId: rollout.target.releaseId,
    generation: rollout.target.runtimeGeneration,
    slot: rollout.target.slot,
    sourceLedger: artifact(ledgerFile),
    readiness: ledger.drill?.targetReadiness ?? { status: 'pass' },
    takeover: ledger.drill?.targetTakeover ?? { status: 'pass' },
    errors: []
  }
}

function qualificationControl(rollout, ledgerFile, scenarioFile, ledger) {
  const policyBinding = {
    targetReleaseId: rollout.target.releaseId,
    targetImageDigest: rollout.target.imageDigest,
    targetRuntimeGeneration: rollout.target.runtimeGeneration,
    scenarioSha256: hashFile(scenarioFile),
    sourceTerminationType: 'docker-kill',
    coordinationMode: 'file-handshake'
  }
  return {
    schema: 'fsusblog.release-worker-qualification-control.v1',
    status: 'pass',
    rolloutId: rollout.rolloutId,
    source: rollout.source,
    target: rollout.target,
    qualificationMode: 'forced-source-worker-termination',
    policyBinding,
    policyHash: sha256(JSON.stringify(policyBinding)),
    ledger: artifact(ledgerFile),
    scenario: artifact(scenarioFile),
    coordination: ledger.drill.coordination,
    sourceTermination: ledger.drill.sourceTermination,
    targetReadiness: ledger.drill.targetReadiness,
    targetTakeover: ledger.drill.targetTakeover,
    observations: { blockers: [] },
    errors: []
  }
}

function runCli(arguments_) {
  return spawnSync(process.execPath, [cli, ...arguments_], { encoding: 'utf8' })
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function artifact(file) {
  return { path: file, sha256: hashFile(file) }
}

function hashFile(file) {
  return sha256(fs.readFileSync(file))
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}
