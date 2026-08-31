import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import {
  candidatePlanSchema,
  currentRegistryBinding,
  seal
} from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import {
  buildFailureReceipt,
  failureReceiptSchema,
  produceBlueGreenContainmentRaw,
  produceBlueGreenContainmentSourceBundle,
  sourceReceiptSchema,
  verifyBlueGreenFailureReceipt,
  verifyBlueGreenContainmentRaw
} from '../../tools/test-evidence/blue-green-containment-raw.mjs'
import {
  loadPostRuntimeProducerRegistry,
  root
} from '../../tools/test-matrix/post-runtime-producer-registry.mjs'

const commit = 'a'.repeat(40)
const fingerprint = `sha256:${'b'.repeat(64)}`
const digest = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`
const oldRelease = 'release-old'
const candidateRelease = 'release-candidate'
const deploymentId = 'deployment-1'
const roles = [
  'state-before', 'state-after', 'promotion', 'switch', 'health', 'rollback',
  'failure', 'traffic', 'artifact', 'volume', 'schema', 'process', 'cleanup', 'terminal'
]

function write(directory, name, value)
{
  const target = path.join(directory, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
  return path.relative(root, target).replaceAll(path.sep, '/')
}

function slot(slotId, releaseId, marker)
{
  return {
    slot: slotId,
    releaseId,
    imageDigest: digest(`${marker}1`),
    artifactDigest: digest(`${marker}2`),
    volumeDigest: digest(`${marker}3`),
    schemaDigest: digest(`${marker}4`),
    processDigest: digest(`${marker}5`),
    runtimeRole: 'monolithic'
  }
}

function observations()
{
  const beforeActive = slot('blue', oldRelease, '1')
  const beforeStandby = slot('green', candidateRelease, '2')
  return {
    'state-before': { active: beforeActive, standby: beforeStandby },
    'state-after': { active: beforeStandby, standby: beforeActive },
    promotion: {
      sourceSlot: 'blue', targetSlot: 'green', sourceReleaseId: oldRelease,
      targetReleaseId: candidateRelease, activeReleaseId: candidateRelease,
      gatewayGeneration: 2, status: 'promoted'
    },
    switch: {
      sourceSlot: 'blue', targetSlot: 'green', sourceReleaseId: oldRelease,
      targetReleaseId: candidateRelease, activeReleaseId: candidateRelease,
      gatewayGeneration: 2, status: 'committed'
    },
    health: {
      releaseId: candidateRelease, serviceReady: true, routeDataReady: true,
      cacheReady: true, dependenciesReady: true, versionReady: true,
      credentialReady: true, status: 'passed'
    },
    rollback: {
      sourceSlot: 'green', targetSlot: 'blue', sourceReleaseId: candidateRelease,
      targetReleaseId: oldRelease, activeReleaseId: oldRelease,
      gatewayGeneration: 3, status: 'rolled-back'
    },
    failure: {
      cases: [
        {
          caseId: 'candidate-health-failure', beforeActiveReleaseId: oldRelease,
          attemptedReleaseId: candidateRelease, afterActiveReleaseId: oldRelease,
          terminalState: 'contained'
        },
        {
          caseId: 'post-switch-failure', beforeActiveReleaseId: oldRelease,
          attemptedReleaseId: candidateRelease, afterActiveReleaseId: oldRelease,
          terminalState: 'contained'
        }
      ],
      status: 'passed'
    },
    traffic: {
      activeReleaseId: candidateRelease, ownerReleaseIds: [candidateRelease],
      partialSwitch: false, splitBrain: false, unknownOwner: false, status: 'passed'
    },
    artifact: containment(),
    volume: containment(),
    schema: containment(),
    process: containment(),
    cleanup: {
      operationOwnedReleaseId: oldRelease, deletedReleaseIds: [oldRelease],
      preservedReleaseIds: [candidateRelease], activeTouched: false,
      sharedTouched: false, otherRunTouched: false, status: 'passed'
    },
    terminal: {
      status: 'passed', errors: [], timedOut: false, cancelled: false,
      automaticRetryCount: 0, privacySafe: true,
      canonicalRerunCommand: 'bash tools/deployment/zero-downtime-rehearsal.sh --run-id run-1'
    }
  }
}

function containment()
{
  return {
    activeReleaseId: candidateRelease,
    inactiveReleaseId: oldRelease,
    activePreserved: true,
    inactiveOperationOwned: true,
    sharedPreserved: true,
    status: 'passed'
  }
}

function fixture(context)
{
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true })
  const directory = fs.mkdtempSync(path.join(root, '.tmp', 'blue-green-containment-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const registry = loadPostRuntimeProducerRegistry(root)
  const producer = registry.producers[0]
  const classes = Object.keys(registry.observationClasses).sort()
  const build = seal({
    schema: 'fsusblog.ci-production-build-receipt.v1',
    status: 'complete',
    sourceState: { commit, worktreeFingerprint: fingerprint },
    build: { profile: 'production-fresh' },
    producer: { workflow: 'fixture', runId: 'run-1', runAttempt: 1 },
    toolchain: { node: '24.8.0', dotnet: '10.0.0' },
    domains: []
  })
  const buildPath = write(directory, 'build.json', build)
  const outputPath = path.relative(root, path.join(directory, 'blue-green-containment.json')).replaceAll(path.sep, '/')
  const plan = seal({
    schema: candidatePlanSchema,
    producerId: producer.producerId,
    registryBinding: currentRegistryBinding(root),
    sourceState: { commit, worktreeFingerprint: fingerprint },
    build: {
      receipt: buildPath,
      receiptContentDigest: build.contentDigest,
      sourceCommit: commit,
      worktreeFingerprint: fingerprint
    },
    candidate: {
      candidateId: 'candidate-1', runId: 'run-1', attemptId: 'attempt-1',
      fixtureId: 'fixture-1', profileId: 'production-fresh', runtimeId: 'runtime-1',
      browserId: 'browser-1', releaseId: candidateRelease, rolloutId: 'rollout-1'
    },
    preRuntimeReceiptDigest: digest('b'),
    acceptedClaimsReceiptDigest: digest('c'),
    observations: classes.map((classId) => ({
      classId,
      schema: registry.observationClasses[classId].schema,
      receiptPath: classId === 'blue-green-containment'
        ? outputPath
        : path.relative(root, path.join(directory, `${classId}.json`)).replaceAll(path.sep, '/'),
      requiredModes: Object.entries(producer.requiredObservations)
        .filter(([, classIds]) => classIds.includes(classId))
        .map(([mode]) => mode)
        .sort()
    })),
    status: 'planned'
  })
  const planPath = write(directory, 'candidate-plan.json', plan)
  const toolchainIdentity = `sha256:${digestValue(build.toolchain)}`
  const sourceState = {
    sourceCommit: commit,
    worktreeFingerprint: fingerprint,
    buildIdentity: plan.build.receiptContentDigest,
    candidateId: plan.candidate.candidateId,
    releaseId: plan.candidate.releaseId,
    rolloutId: plan.candidate.rolloutId,
    deploymentId,
    runtimeId: plan.candidate.runtimeId,
    runId: plan.candidate.runId,
    attemptId: plan.candidate.attemptId,
    producerId: plan.producerId,
    schemaIdentity: registry.observationClasses['blue-green-containment'].schema,
    toolchainIdentity
  }
  const values = observations()
  const sourcePaths = roles.map((role) => write(directory, `${role}.json`, seal({
    schema: sourceReceiptSchema,
    role,
    sourceState,
    executionClass: 'correctness',
    evidenceClass: 'correctness',
    qualificationEligible: true,
    planned: true,
    executed: true,
    outcome: 'passed',
    recovered: false,
    diagnostic: false,
    stale: false,
    crossCandidate: false,
    observation: values[role],
    canonicalRerunCommand: `run-blue-green-role ${role}`
  })))
  const sourceBundlePath = write(directory, 'source-bundle.json', produceBlueGreenContainmentSourceBundle({
    candidatePlan: planPath, deploymentId, sourceReceipts: sourcePaths, repositoryRoot: root
  }))
  return {
    directory, plan, planPath, outputPath, sourcePaths, sourceBundlePath,
    pathFor: (role) => sourcePaths[roles.indexOf(role)]
  }
}

function refreshSourceBundle(value)
{
  const bundle = produceBlueGreenContainmentSourceBundle({
    candidatePlan: value.planPath, deploymentId, sourceReceipts: value.sourcePaths, repositoryRoot: root
  })
  fs.writeFileSync(path.join(root, value.sourceBundlePath), `${JSON.stringify(bundle, null, 2)}\n`)
  return value.sourceBundlePath
}

function produce(value)
{
  return produceBlueGreenContainmentRaw({
    candidatePlan: value.planPath,
    sourceReceipt: value.sourceBundlePath,
    repositoryRoot: root
  })
}

function rewrite(relative, mutate)
{
  const absolute = path.join(root, relative)
  const value = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  mutate(value)
  fs.writeFileSync(absolute, `${JSON.stringify(seal(Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'contentDigest')
  )), null, 2)}\n`)
}

test('projects and independently replays exact blue-green containment identities', (context) =>
{
  const value = fixture(context)
  const receipt = produce(value)
  assert.equal(receipt.qualificationEligible, true)
  assert.equal(receipt.outcome, 'passed')
  assert.deepEqual(receipt.modes, ['boundary', 'failure'])
  assert.equal(receipt.sourceReceiptRef.path, value.sourceBundlePath)
  assert.equal(receipt.semanticFacts.activeReleaseProtected, true)
  assert.equal(receipt.semanticFacts.splitBrainAbsent, true)
  assert.equal(receipt.semanticFacts.cleanupInactiveOnly, true)
  assert.equal(receipt.semanticFacts.runtimeRoleContractSatisfied, true)
  write(value.directory, 'blue-green-containment.json', receipt)
  assert.equal(verifyBlueGreenContainmentRaw(value.outputPath, root).contentDigest, receipt.contentDigest)
})

test('requires exact-one source receipt for every containment role', (context) =>
{
  const value = fixture(context)
  assert.throws(() => produceBlueGreenContainmentSourceBundle({
    candidatePlan: value.planPath,
    deploymentId,
    sourceReceipts: value.sourcePaths.slice(1),
    repositoryRoot: root
  }), /closure must be exact-one/u)
  assert.throws(() => produceBlueGreenContainmentSourceBundle({
    candidatePlan: value.planPath,
    deploymentId,
    sourceReceipts: [...value.sourcePaths.slice(0, -1), value.pathFor('state-before')],
    repositoryRoot: root
  }), /duplicate source receipt role/u)
})

const invalidCases = [
  ['unknown active identity', 'traffic', (receipt) => { receipt.observation.unknownOwner = true }, /ambiguous/u],
  ['partial switch', 'traffic', (receipt) => { receipt.observation.partialSwitch = true }, /partial/u],
  ['split brain', 'traffic', (receipt) => { receipt.observation.splitBrain = true }, /split-brain/u],
  ['rollback changed active identity', 'rollback', (receipt) => { receipt.observation.activeReleaseId = candidateRelease }, /rollback did not restore/u],
  ['cleanup touches active', 'cleanup', (receipt) => { receipt.observation.activeTouched = true }, /cleanup is not limited/u],
  ['cleanup touches shared facts', 'cleanup', (receipt) => { receipt.observation.sharedTouched = true }, /cleanup is not limited/u],
  ['runtime role mismatch', 'state-after', (receipt) => { receipt.observation.active.runtimeRole = 'worker' }, /runtime role must be observed/u],
  ['diagnostic result', 'health', (receipt) => { receipt.diagnostic = true }, /diagnostic/u],
  ['recovered result', 'health', (receipt) => { receipt.recovered = true }, /recovered/u],
  ['blocked result', 'health', (receipt) => { receipt.outcome = 'blocked'; receipt.qualificationEligible = false }, /blocked/u],
  ['unknown result', 'health', (receipt) => { receipt.outcome = 'unknown'; receipt.qualificationEligible = false }, /unknown/u],
  ['cross-candidate result', 'health', (receipt) => { receipt.crossCandidate = true }, /cross-candidate/u],
  ['cross-candidate identity', 'health', (receipt) => { receipt.sourceState.releaseId = 'other-release' }, /releaseId does not exact-match/u],
  ['process-only readiness shortcut', 'health', (receipt) => {
    receipt.observation = { processAlive: true, portOpen: true, httpStatus: 200, fileExists: true }
  }, /fields do not exact-match/u]
]

for (const [name, role, mutate, expected] of invalidCases)
{
  test(`fails closed for ${name}`, (context) =>
  {
    const value = fixture(context)
    rewrite(value.pathFor(role), mutate)
    assert.throws(() => {
      refreshSourceBundle(value)
      produce(value)
    }, expected)
  })
}

test('independent verifier rejects source-receipt byte tamper', (context) =>
{
  const value = fixture(context)
  const receipt = produce(value)
  write(value.directory, 'blue-green-containment.json', receipt)
  fs.appendFileSync(path.join(root, value.pathFor('terminal')), ' ')
  assert.throws(() => verifyBlueGreenContainmentRaw(value.outputPath, root), /reference digest mismatch/u)
})

test('source and output paths reject history/latest fallback', (context) =>
{
  const value = fixture(context)
  assert.throws(() => produceBlueGreenContainmentSourceBundle({
    candidatePlan: value.planPath,
    deploymentId,
    sourceReceipts: [...value.sourcePaths.slice(0, -1), '.tmp/history/terminal.json'],
    repositoryRoot: root
  }), /current-run JSON path/u)
})

test('failure receipt remains sealed, privacy-safe, and never qualification eligible', (context) =>
{
  const value = fixture(context)
  rewrite(value.pathFor('health'), (receipt) => {
    receipt.outcome = 'blocked'
    receipt.qualificationEligible = false
  })
  const result = spawnSync(process.execPath, [
    path.join(root, 'tools/test-evidence/blue-green-containment-raw.mjs'),
    'produce', '--candidate-plan', value.planPath, '--deployment-id', deploymentId,
    '--source', value.sourceBundlePath,
    '--out', value.outputPath
  ], { cwd: root, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.equal(fs.existsSync(path.join(root, value.outputPath)), false)
  const failurePath = value.outputPath.replace(/\.json$/u, '.failure.json')
  const failure = JSON.parse(fs.readFileSync(path.join(root, failurePath), 'utf8'))
  assert.equal(failure.schema, failureReceiptSchema)
  assert.equal(failure.qualificationEligible, false)
  assert.equal(failure.outcome, 'failed')
  assert.equal(failure.recovered, false)
  assert.equal(failure.privacySafe, true)
  assert.match(failure.contentDigest, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(failure.sourceReceiptRefs.length, 1)
  assert.equal(verifyBlueGreenFailureReceipt(failurePath, root).contentDigest, failure.contentDigest)
})

test('failure receipt helper seals exact error and raw references without promoting it', (context) =>
{
  const value = fixture(context)
  const receipt = buildFailureReceipt({
    candidatePlan: value.planPath,
    deploymentId,
    sourceReceipts: value.sourcePaths,
    output: value.outputPath,
    error: new Error('failure source is incomplete; token=private-value'),
    repositoryRoot: root
  })
  assert.equal(receipt.schema, failureReceiptSchema)
  assert.equal(receipt.qualificationEligible, false)
  assert.equal(receipt.failure.name, 'Error')
  assert.doesNotMatch(receipt.failure.message, /private-value/u)
  assert.match(receipt.failure.messageDigest, /^sha256:[a-f0-9]{64}$/u)
  assert.match(receipt.canonicalRerunCommand, /--source-receipt/u)
})

test('producer source never reads documentation or infers from process, port, HTTP, file, latest, or job status', () =>
{
  const source = fs.readFileSync(path.join(root, 'tools/test-evidence/blue-green-containment-raw.mjs'), 'utf8')
  for (const forbidden of [
    /readFileSync\([^\n]*(?:\.md|docs\/)/u,
    /jobStatus/u,
    /manualActive/u,
    /allowDiagnostic/u
  ]) assert.doesNotMatch(source, forbidden)
})
