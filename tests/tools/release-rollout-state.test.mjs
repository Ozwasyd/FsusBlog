import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ROLLOUT_STAGES,
  completeRollout,
  completeRolloutRecovery,
  completeRolloutStage,
  createRolloutState,
  failRolloutStage,
  failRolloutRecovery,
  markCandidateOnly,
  markActivationCommitted,
  markContractMigrationApplied,
  markDestructiveCutoverStarted,
  markGatewaySwitchCommitted,
  planRolloutRecovery,
  readRolloutState,
  startRolloutStage,
  validateRolloutState,
  writeRolloutStateAtomic
} from '../../tools/deployment/release-rollout-lib.mjs'

const sourceDigest = `sha256:${'a'.repeat(64)}`
const targetDigest = `sha256:${'b'.repeat(64)}`

function createState() {
  return createRolloutState({
    rolloutId: 'rollout-20260711-0001',
    kind: 'deploy',
    manifestPath: '/var/lib/fsusblog/releases/target/release-manifest.json',
    source: { slot: 'blue', releaseId: '20260710010101-aaaaaaaaaaaa', imageDigest: sourceDigest, runtimeGeneration: 11 },
    target: { slot: 'green', releaseId: '20260711010101-bbbbbbbbbbbb', imageDigest: targetDigest, runtimeGeneration: 12 },
    createdAtUtc: '2026-07-11T00:00:00.000Z'
  })
}

function completeThrough(state, exclusiveStage) {
  const end = ROLLOUT_STAGES.indexOf(exclusiveStage)
  for (let index = 0; index < end; index++) {
    const stage = ROLLOUT_STAGES[index]
    startRolloutStage(state, stage, `2026-07-11T00:${String(index).padStart(2, '0')}:00.000Z`)
    if (stage === 'source-drain') markDestructiveCutoverStarted(state, `2026-07-11T00:${String(index).padStart(2, '0')}:00.500Z`)
    if (stage === 'active-fence') markActivationCommitted(state, `2026-07-11T00:${String(index).padStart(2, '0')}:00.500Z`)
    completeRolloutStage(state, stage, { completedAtUtc: `2026-07-11T00:${String(index).padStart(2, '0')}:01.000Z` })
    if (stage === 'gateway-switch') markGatewaySwitchCommitted(state, 9, '2026-07-11T00:09:02.000Z')
  }
}

test('rollout state completes the only ordered production stage sequence with immutable evidence', () => {
  const state = createState()
  for (let index = 0; index < ROLLOUT_STAGES.length; index++) {
    const stage = ROLLOUT_STAGES[index]
    startRolloutStage(state, stage, `2026-07-11T00:${String(index).padStart(2, '0')}:00.000Z`)
    if (stage === 'source-drain') markDestructiveCutoverStarted(state, `2026-07-11T00:${String(index).padStart(2, '0')}:00.500Z`)
    if (stage === 'active-fence') markActivationCommitted(state, `2026-07-11T00:${String(index).padStart(2, '0')}:00.500Z`)
    completeRolloutStage(state, stage, {
      completedAtUtc: `2026-07-11T00:${String(index).padStart(2, '0')}:01.000Z`,
      evidencePath: `/var/lib/fsusblog/evidence/${stage}.json`
    })
    if (stage === 'gateway-switch') markGatewaySwitchCommitted(state, 9, '2026-07-11T00:09:02.000Z')
  }
  completeRollout(state, {
    evidencePath: '/var/lib/fsusblog/evidence/manifest.json',
    completedAtUtc: '2026-07-11T01:00:00.000Z'
  })

  assert.equal(state.status, 'completed')
  assert.deepEqual(state.completedStages, ROLLOUT_STAGES)
  assert.equal(state.gatewayGeneration, 9)
  assert.equal(state.source.releaseId, '20260710010101-aaaaaaaaaaaa')
  assert.equal(state.target.releaseId, '20260711010101-bbbbbbbbbbbb')
  assert.equal(state.stages.every(record => record.status === 'ok'), true)
})

test('candidate-only mode is terminal only after smoke and compatibility without traffic mutation', () => {
  const state = createState()
  completeThrough(state, 'gateway-switch')
  markCandidateOnly(state, '2026-07-11T00:20:00.000Z')

  assert.equal(state.status, 'candidate_ready')
  assert.equal(state.candidateOnly, true)
  assert.equal(state.switchCommitted, false)
  assert.equal(state.completedStages.at(-1), 'compatibility-smoke')
  assert.throws(() => startRolloutStage(state, 'gateway-switch'), /terminal/u)
})

test('every injected stage failure produces the phase-correct recovery action', () => {
  const expected = new Map([
    ['manifest-validate', 'preserve-source-stop-candidate'],
    ['capacity-preflight', 'preserve-source-stop-candidate'],
    ['backup-restore-gate', 'preserve-source-stop-candidate'],
    ['expand-migration', 'preserve-source-stop-candidate'],
    ['candidate-start', 'preserve-source-stop-candidate'],
    ['candidate-readiness', 'preserve-source-stop-candidate'],
    ['asset-materialize', 'preserve-source-stop-candidate'],
    ['candidate-smoke', 'preserve-source-stop-candidate'],
    ['compatibility-smoke', 'preserve-source-stop-candidate'],
    ['gateway-switch', 'gateway-recover'],
    ['source-drain', 'rollback-gateway-to-source'],
    ['active-fence', 'resume-release-activation-same-cutover'],
    ['public-verify', 'resume-release-activation-same-cutover'],
    ['source-stop', 'retain-source-report-cleanup-blocker'],
    ['release-evidence', 'resume-release-evidence']
  ])

  for (let index = 0; index < ROLLOUT_STAGES.length; index++) {
    const stage = ROLLOUT_STAGES[index]
    const state = createState()
    completeThrough(state, stage)
    startRolloutStage(state, stage, `2026-07-11T02:${String(index).padStart(2, '0')}:00.000Z`)
    failRolloutStage(state, stage, {
      errorCode: `fault:${stage}`,
      failedAtUtc: `2026-07-11T02:${String(index).padStart(2, '0')}:01.000Z`
    })

    const recovery = planRolloutRecovery(state)
    assert.equal(recovery.action, expected.get(stage), stage)
    assert.equal(recovery.failedStage, stage)
    if (stage === 'source-drain') {
      assert.equal(recovery.reason, 'post_switch_gate_failed_before_source_drain')
    }
    if (stage === 'active-fence' || stage === 'public-verify') {
      assert.equal(recovery.reason, 'destructive_cutover_started_old_source_rollback_forbidden')
      assert.notEqual(recovery.action, 'rollback-gateway-to-source')
    }
    assert.equal(state.status, 'recovery_required')
  }
})

test('failed stages cannot resume until their exact recovery action has durable evidence', () => {
  const state = createState()
  completeThrough(state, 'candidate-start')
  startRolloutStage(state, 'candidate-start', '2026-07-11T02:30:00.000Z')
  failRolloutStage(state, 'candidate-start', {
    errorCode: 'candidate_start_failed',
    failedAtUtc: '2026-07-11T02:30:01.000Z'
  })

  assert.throws(() => startRolloutStage(state, 'candidate-start'), /recovery must complete/u)
  assert.throws(() => completeRolloutRecovery(state, {
    action: 'gateway-recover',
    evidencePath: '/var/lib/fsusblog/evidence/recovery.json'
  }), /action mismatch/u)
  failRolloutRecovery(state, {
    action: 'preserve-source-stop-candidate',
    errorCode: 'candidate_cleanup_failed',
    failedAtUtc: '2026-07-11T02:30:02.000Z'
  })
  assert.equal(state.status, 'recovery_required')
  completeRolloutRecovery(state, {
    action: 'preserve-source-stop-candidate',
    evidencePath: '/var/lib/fsusblog/evidence/candidate-cleanup.json',
    completedAtUtc: '2026-07-11T02:30:03.000Z'
  })
  startRolloutStage(state, 'candidate-start', '2026-07-11T02:30:04.000Z')

  assert.equal(state.recoveries.length, 2)
  assert.deepEqual(state.recoveries.map(item => item.status), ['failed', 'ok'])
  assert.equal(state.currentStage, 'candidate-start')
})

test('pre-cutover source drain failure may rollback, while a started cutover can only resume target activation', () => {
  const state = createState()
  completeThrough(state, 'source-drain')
  startRolloutStage(state, 'source-drain', '2026-07-11T02:40:00.000Z')
  failRolloutStage(state, 'source-drain', {
    errorCode: 'source_drain_failed_before_cutover',
    failedAtUtc: '2026-07-11T02:40:01.000Z'
  })
  completeRolloutRecovery(state, {
    action: 'rollback-gateway-to-source',
    evidencePath: '/var/lib/fsusblog/evidence/post-switch-rollback.json',
    terminalStatus: 'rolled_back',
    completedAtUtc: '2026-07-11T02:40:02.000Z'
  })

  assert.equal(state.status, 'rolled_back')
  assert.equal(state.outcome, 'rolled_back')
  assert.throws(() => startRolloutStage(state, 'source-drain'), /terminal/u)

  const irreversible = createState()
  completeThrough(irreversible, 'source-drain')
  startRolloutStage(irreversible, 'source-drain', '2026-07-11T02:41:00.000Z')
  markDestructiveCutoverStarted(irreversible, '2026-07-11T02:41:00.500Z')
  failRolloutStage(irreversible, 'source-drain', { errorCode: 'receipt_lost', failedAtUtc: '2026-07-11T02:41:01.000Z' })
  assert.equal(planRolloutRecovery(irreversible).action, 'resume-release-activation-same-cutover')
})

test('Contract migration disables automatic rollback and survives a later failure as manual recovery', () => {
  const state = createState()
  completeThrough(state, 'source-stop')
  markContractMigrationApplied(state, '2026-07-11T03:00:00.000Z')
  startRolloutStage(state, 'source-stop', '2026-07-11T03:00:01.000Z')
  failRolloutStage(state, 'source-stop', {
    errorCode: 'docker_stop_failed',
    failedAtUtc: '2026-07-11T03:00:02.000Z'
  })

  assert.equal(state.rollbackAllowed, false)
  assert.equal(planRolloutRecovery(state).action, 'manual-contract-recovery')
  assert.equal(planRolloutRecovery(state).automatic, false)
})

test('durable rollout state ignores interrupted temporary files and remains mode 0600', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-rollout-state-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'state', 'rollout.json')
  const state = createState()
  startRolloutStage(state, 'manifest-validate', '2026-07-11T04:00:00.000Z')
  completeRolloutStage(state, 'manifest-validate', { completedAtUtc: '2026-07-11T04:00:01.000Z' })
  writeRolloutStateAtomic(file, state)
  fs.writeFileSync(path.join(path.dirname(file), '.rollout.json.tmp-interrupted'), '{partial')

  const recovered = readRolloutState(file)
  assert.deepEqual(recovered.completedStages, ['manifest-validate'])
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('state rejects reordered stages, mutable identities, generation reuse and incomplete completion', () => {
  const state = createState()
  assert.throws(() => startRolloutStage(state, 'candidate-start'), /expected manifest-validate/u)
  assert.throws(() => completeRollout(state, { evidencePath: '/tmp/evidence.json' }), /all rollout stages/u)
  assert.throws(() => createRolloutState({
    rolloutId: 'rollout-invalid',
    manifestPath: '/tmp/release-manifest.json',
    source: { slot: 'blue', releaseId: 'latest', imageDigest: sourceDigest, runtimeGeneration: 1 },
    target: { slot: 'green', releaseId: 'release-target', imageDigest: targetDigest, runtimeGeneration: 1 }
  }), /source.releaseId/u)
  const tampered = structuredClone(state)
  tampered.target.runtimeGeneration = 0
  assert.throws(() => validateRolloutState(tampered), /target.runtimeGeneration/u)
})
