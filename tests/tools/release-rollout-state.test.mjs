import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCurrentRolloutFixtureBinding } from './support/release-rollout-evidence-fixture.mjs'
import { validateCurrentSchemaAdmissionOutput } from '../../tools/release/release-manifest-value-contract.mjs'
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
    ...createCurrentRolloutFixtureBinding(),
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
    for (let index = 0; index < end; index++)
{
        const stage = ROLLOUT_STAGES[index];
        startRolloutStage(state, stage, `2026-07-11T00:${String(index).padStart(2, '0')}:00.000Z`);
        if (stage === 'source-drain') {markDestructiveCutoverStarted(state, `2026-07-11T00:${String(index).padStart(2, '0')}:00.500Z`)};
        if (stage === 'active-fence') {markActivationCommitted(state, `2026-07-11T00:${String(index).padStart(2, '0')}:00.500Z`)};
        completeRolloutStage(state, stage, { completedAtUtc: `2026-07-11T00:${String(index).padStart(2, '0')}:01.000Z` });
        if (stage === 'gateway-switch') {markGatewaySwitchCommitted(state, 9, '2026-07-11T00:09:02.000Z')};
    }
}

test('rollout state completes the only ordered production stage sequence with immutable evidence', () => {
  const state = createState()
    for (let index = 0; index < ROLLOUT_STAGES.length; index++)
{
        const stage = ROLLOUT_STAGES[index];
        startRolloutStage(state, stage, `2026-07-11T00:${String(index).padStart(2, '0')}:00.000Z`);
        if (stage === 'source-drain') {markDestructiveCutoverStarted(state, `2026-07-11T00:${String(index).padStart(2, '0')}:00.500Z`)};
        if (stage === 'active-fence') {markActivationCommitted(state, `2026-07-11T00:${String(index).padStart(2, '0')}:00.500Z`)};
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
    ['current-schema-admission', 'preserve-source-stop-candidate'],
    ['candidate-start', 'preserve-source-stop-candidate'],
    ['candidate-readiness', 'preserve-source-stop-candidate'],
    ['asset-materialize', 'preserve-source-stop-candidate'],
        ['candidate-smoke', 'preserve-source-stop-candidate'],
        ['compatibility-smoke', 'preserve-source-stop-candidate'],
        ['gateway-switch', 'gateway-recover'],
        ['source-drain', 'resume-release-activation-same-cutover'],
        ['active-fence', 'resume-release-activation-same-cutover'],
        ['public-verify', 'resume-release-activation-same-cutover'],
        ['source-stop', 'retain-source-report-cleanup-blocker'],
        ['release-evidence', 'resume-release-evidence']
    ]);

  for (let index = 0; index < ROLLOUT_STAGES.length; index++) {
    const stage = ROLLOUT_STAGES[index]
    const state = createState()
    completeThrough(state, stage)
    startRolloutStage(state, stage, `2026-07-11T02:${String(index).padStart(2, '0')}:00.000Z`)
    failRolloutStage(state, stage, {
      errorCode: `fault:${stage}`,
      failedAtUtc: `2026-07-11T02:${String(index).padStart(2, '0')}:01.000Z`
    })

        const recovery = planRolloutRecovery(state);
        assert.equal(recovery.action, expected.get(stage), stage);
        assert.equal(recovery.failedStage, stage);
        if (stage === 'source-drain')
{
            assert.equal(recovery.reason, 'post_switch_old_source_rollback_forbidden');
        }
        if (stage === 'active-fence' || stage === 'public-verify')
{
            assert.equal(recovery.reason, 'destructive_cutover_started_old_source_rollback_forbidden');
            assert.notEqual(recovery.action, 'rollback-gateway-to-source');
        }
        assert.equal(state.status, 'recovery_required');
    }
});

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
    assert.equal(state.currentStage, 'candidate-start');
});

test('post-switch source drain failures cannot restore an old image before or after cutover', () =>
{
    const state = createState();
    completeThrough(state, 'source-drain');
    startRolloutStage(state, 'source-drain', '2026-07-11T02:40:00.000Z');
    failRolloutStage(state, 'source-drain', {
        errorCode: 'source_drain_failed_before_cutover',
        failedAtUtc: '2026-07-11T02:40:01.000Z'
    });
    assert.throws(() => completeRolloutRecovery(state, {
    action: 'rollback-gateway-to-source',
    evidencePath: '/var/lib/fsusblog/evidence/post-switch-rollback.json',
    terminalStatus: 'rolled_back',
    completedAtUtc: '2026-07-11T02:40:02.000Z'
  }), /recovery.action/u)

    assert.equal(state.status, 'recovery_required');
    assert.equal(state.outcome, null);
    assert.equal(planRolloutRecovery(state).action, 'resume-release-activation-same-cutover');

    const irreversible = createState();
    completeThrough(irreversible, 'source-drain');
    startRolloutStage(irreversible, 'source-drain', '2026-07-11T02:41:00.000Z');
    markDestructiveCutoverStarted(irreversible, '2026-07-11T02:41:00.500Z');
    failRolloutStage(irreversible, 'source-drain', { errorCode: 'receipt_lost', failedAtUtc: '2026-07-11T02:41:01.000Z' });
    assert.equal(planRolloutRecovery(irreversible).action, 'resume-release-activation-same-cutover');
});

test('retired serve-time Contract mutation refuses without changing durable state', () =>
{
  const state = createState()
  completeThrough(state, 'source-stop')
  const before = structuredClone(state)
  assert.throws(() => markContractMigrationApplied(state, '2026-07-11T03:00:00.000Z'), /are retired/u)
  assert.deepEqual(state, before)
  startRolloutStage(state, 'source-stop', '2026-07-11T03:00:01.000Z')
  failRolloutStage(state, 'source-stop', {
    errorCode: 'docker_stop_failed',
    failedAtUtc: '2026-07-11T03:00:02.000Z'
  })

  assert.equal(state.rollbackAllowed, false)
  assert.equal(planRolloutRecovery(state).action, 'retain-source-report-cleanup-blocker')
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

test('current rollout requires explicit complete bindings and cannot resume legacy or image rollback state', () => {
  const valid = createState()
  assert.equal(valid.schema, 'fsusblog.release-rollout-state.v2')
  assert.equal(valid.rollbackAllowed, false)
  assert.equal(Object.hasOwn(valid, 'contractMigrationApplied'), false)
  for (const patch of [
    { schema: 'fsusblog.release-rollout-state.v1' }, { kind: 'rollback' },
    { manifestSha256: null }, { manifestSha256: [valid.manifestSha256] },
    { candidateSourceRevision: null }, { candidateSourceRevision: [valid.candidateSourceRevision] },
    { candidateSourceRevision: '0'.repeat(40) }, { currentSchema: null },
    { rollbackAllowed: true }, { contractMigrationApplied: false },
    { status: 'rolled_back', outcome: 'rolled_back' },
    { currentSchema: { ...valid.currentSchema, receipt: { ...valid.currentSchema.receipt, reference: '/receipts/latest/current.json' } } }
  ]) {
    const state = { ...structuredClone(valid), ...patch }
    const before = structuredClone(state)
    assert.throws(() => startRolloutStage(state, 'manifest-validate'))
    assert.deepEqual(state, before)
  }
})

test('Server admission output binds every current receipt, database, physical schema and candidate field', () => {
  const binding = createCurrentRolloutFixtureBinding()
  const output = { status: 'verified-current', candidateSourceRevision: binding.candidateSourceRevision,
    artifactSha256: binding.currentSchema.receipt.sha256, target: binding.currentSchema.target,
    database: binding.currentSchema.database, actualSchemaDigest: binding.currentSchema.actualSchemaDigest }
  assert.deepEqual(validateCurrentSchemaAdmissionOutput(output, binding.currentSchema, binding.candidateSourceRevision), [])
  for (const value of [null, {}, { ...output, status: undefined }, { ...output, status: 'pass' },
    { ...output, candidateSourceRevision: 'a'.repeat(40) }, { ...output, artifactSha256: 'a'.repeat(64) },
    { ...output, target: { ...output.target, contentDigest: 'a'.repeat(64) } },
    { ...output, database: { ...output.database, databaseId: 'other' } },
    { ...output, database: { ...output.database, provider: 1 } },
    { ...output, actualSchemaDigest: output.target.contentDigest }, { ...output, nativeAdmission: true }
  ]) assert.ok(validateCurrentSchemaAdmissionOutput(value, binding.currentSchema, binding.candidateSourceRevision).length > 0)
  assert.ok(validateCurrentSchemaAdmissionOutput(output, binding.currentSchema, [binding.candidateSourceRevision]).length > 0)
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
