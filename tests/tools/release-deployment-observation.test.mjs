import assert from 'node:assert/strict'
import test from 'node:test'

import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { sealCurrentRunInput } from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import {
  produceReleaseDeploymentObservation,
  verifyReleaseDeploymentObservation
} from '../../tools/fact-extractors/post-runtime/release-deployment.mjs'
import { root } from '../../tools/fact-extractors/registry.mjs'

const SOURCE = 'a'.repeat(40)
const WORKTREE = 'b'.repeat(64)
const DIGEST = (character) => character.repeat(64)
const CLAIM_IDS = [
  'deployment.blue-green-contract',
  'deployment.runtime-role-contract',
  'release.finalizer-contract'
]

function sealWithPrefixedDigest(value)
{
  const receipt = structuredClone(value)
  delete receipt.contentDigest
  receipt.contentDigest = `sha256:${digestValue(receipt)}`
  return receipt
}

function exactnessReceipt(claimId)
{
  const receipt = {
    schema: 'fsusblog.behavior-doc-exactness-receipt.v1',
    scopeId: `fixture-${claimId}`,
    source: { commit: SOURCE, worktreeFingerprint: WORKTREE },
    rows: [{ claimId }],
    counts: { warnings: 0 },
    status: 'ok',
    failureReasons: [],
    contentDigest: null
  }
  receipt.contentDigest = digestValue(receipt)
  return receipt
}

function preRuntimeReceipt()
{
  return sealWithPrefixedDigest({
    schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1',
    scope: 'pre-runtime',
    sourceIdentity: { commit: SOURCE, worktreeFingerprint: WORKTREE },
    behaviorIds: ['browserless-production-correctness'],
    runtimeCandidateSpawnCountBeforeReceipt: 0,
    status: 'ok',
    failureReasons: []
  })
}

function identities()
{
  return {
    artifactId: 'release-image',
    artifactDigest: DIGEST('c'),
    buildId: 'build-release-1',
    buildReceiptDigest: DIGEST('d'),
    candidateId: 'candidate-release-1',
    fixtureId: 'fixture-deployment-1',
    profileId: 'production',
    runId: 'run-deployment-1',
    attemptId: 'attempt-1',
    runtimeId: 'runtime-release-1',
    toolchainDigest: DIGEST('e'),
    releaseId: 'release-1',
    deploymentId: 'deployment-1'
  }
}

const factMap = Object.freeze({
  'release-identity-readiness': {
    imageDigest: DIGEST('1'), packageDigest: DIGEST('2'), configDigest: DIGEST('3'),
    schemaDigest: DIGEST('4'), manifestDigest: DIGEST('5'), signingDigest: DIGEST('6'),
    trustDigest: DIGEST('7'), readinessReceiptDigest: DIGEST('8'),
    serviceReady: true, routeDataReady: true, cacheReady: true, dependenciesReady: true,
    versionReady: true, credentialReady: true, identityMatch: true,
    runtimeRoleContractSatisfied: true, monolithicOwnershipSatisfied: true
  },
  'blue-green-switch-rollback-containment': {
    activeBeforeDigest: DIGEST('1'), standbyBeforeDigest: DIGEST('2'),
    activeAfterDigest: DIGEST('3'), standbyAfterDigest: DIGEST('4'),
    promotionReceiptDigest: DIGEST('5'), switchReceiptDigest: DIGEST('6'),
    healthReceiptDigest: DIGEST('7'), rollbackReceiptDigest: DIGEST('8'),
    failureReceiptDigest: DIGEST('9'), trafficOwnershipDigest: DIGEST('a'),
    artifactContainmentDigest: DIGEST('b'), volumeContainmentDigest: DIGEST('c'),
    schemaContainmentDigest: DIGEST('d'), processContainmentDigest: DIGEST('e'),
    cleanupReceiptDigest: DIGEST('f'), terminalReceiptDigest: DIGEST('0'),
    activeReleaseProtected: true, activeIdentityKnown: true, switchComplete: true,
    splitBrainAbsent: true, cleanupInactiveOnly: true, sharedFactsPreserved: true,
    runtimeRoleContractSatisfied: true
  }
})

function fixtureInputs()
{
  const claims = CLAIM_IDS.map(exactnessReceipt)
  const preRuntime = preRuntimeReceipt()
  const identity = identities()
  const plan = sealCurrentRunInput({
    planId: 'release-deployment-plan-1',
    producerId: 'release-deployment-observation-producer',
    sourceCommit: SOURCE,
    worktreeFingerprint: WORKTREE,
    buildIdentity: {
      artifactId: identity.artifactId,
      receiptDigest: identity.buildReceiptDigest,
      artifactDigest: identity.artifactDigest
    },
    identities: identity,
    plannedObservationClasses: Object.keys(factMap),
    requiredOutcomes: ['positive', 'negative', 'boundary', 'failure'],
    claimReceiptDigests: Object.fromEntries(claims.map((receipt) => [receipt.rows[0].claimId, receipt.contentDigest])),
    preRuntimeReceiptDigest: preRuntime.contentDigest
  })
  const rawReceipts = Object.entries(factMap).map(([observationClass, facts]) => sealCurrentRunInput({
    producerId: 'release-deployment-observation-producer',
    observationClass,
    executionClass: 'release-deployment',
    evidenceClass: 'correctness',
    qualificationEligible: true,
    identity,
    planned: true,
    executed: true,
    outcome: 'passed',
    coveredOutcomes: ['positive', 'negative', 'boundary', 'failure'],
    attemptKind: 'qualification',
    recovered: false,
    facts,
    rawRef: `.tmp/release-deployment/run-deployment-1/${observationClass}.json`,
    rerunCommand: './tools/test.sh release-final'
  }))
  return { repositoryRoot: root, candidatePlan: plan, rawReceipts, preRuntimeReceipt: preRuntime, claimReceipts: claims }
}

test('release adapter seals identity/readiness and blue-green containment with independent replay', () =>
{
  const inputs = fixtureInputs()
  const receipt = produceReleaseDeploymentObservation(inputs)
  assert.equal(receipt.status, 'ok', receipt.failureReasons.join('\n'))
  assert.deepEqual(receipt.observations.observedObservationClasses, Object.keys(factMap).sort())
  assert.deepEqual(verifyReleaseDeploymentObservation({ ...inputs, receipt }), receipt)
})

test('release/deployment semantic and lifecycle counterexamples fail closed', () =>
{
  const cases = [
    ['process alive but route/data not ready', (inputs) => { inputs.rawReceipts[0].facts.routeDataReady = false }, /routeDataReady/u],
    ['HTTP200 with wrong release/config/data', (inputs) => { inputs.rawReceipts[0].facts.identityMatch = false }, /identityMatch/u],
    ['another candidate/release', (inputs) => { inputs.rawReceipts[0].identity = { ...inputs.rawReceipts[0].identity, releaseId: 'other-release' } }, /identity does not match/u],
    ['blue-green failure changes active release', (inputs) => { inputs.rawReceipts[1].facts.activeReleaseProtected = false }, /activeReleaseProtected/u],
    ['unknown active treated as standby', (inputs) => { inputs.rawReceipts[1].facts.activeIdentityKnown = false }, /activeIdentityKnown/u],
    ['partial switch', (inputs) => { inputs.rawReceipts[1].facts.switchComplete = false }, /switchComplete/u],
    ['split brain', (inputs) => { inputs.rawReceipts[1].facts.splitBrainAbsent = false }, /splitBrainAbsent/u],
    ['cleanup deletes active facts', (inputs) => { inputs.rawReceipts[1].facts.cleanupInactiveOnly = false }, /cleanupInactiveOnly/u],
    ['cleanup deletes shared facts', (inputs) => { inputs.rawReceipts[1].facts.sharedFactsPreserved = false }, /sharedFactsPreserved/u],
    ['runtime-role mismatch', (inputs) => { inputs.rawReceipts[1].facts.runtimeRoleContractSatisfied = false }, /runtimeRoleContractSatisfied/u],
    ['diagnostic result', (inputs) => { inputs.rawReceipts[0].attemptKind = 'diagnostic' }, /diagnostic\/recovered/u],
    ['recovered result', (inputs) => { inputs.rawReceipts[0].recovered = true }, /diagnostic\/recovered/u],
    ['historical latest fallback', (inputs) => { inputs.rawReceipts[0].rawRef = 'latest/release/receipt.json' }, /historical\/latest/u],
    ['missing observation', (inputs) => { inputs.rawReceipts.pop() }, /exact-one/u],
    ['duplicate observation', (inputs) => { inputs.rawReceipts.push(structuredClone(inputs.rawReceipts[0])) }, /observed 2/u],
    ['unknown observation', (inputs) => { inputs.rawReceipts[0].observationClass = 'process-alive' }, /unknown observation class/u],
    ['receipt identity tamper', (inputs) => { inputs.rawReceipts[0].identity.deploymentId = 'tampered' }, /contentDigest mismatch/u, false]
  ]
  for (const [label, mutate, reasonPattern, reseal = true] of cases)
  {
    const inputs = fixtureInputs()
    mutate(inputs)
    if (reseal) inputs.rawReceipts = inputs.rawReceipts.map((raw) => sealCurrentRunInput(raw))
    const receipt = produceReleaseDeploymentObservation(inputs)
    assert.equal(receipt.status, 'failed', label)
    assert.ok(receipt.failureReasons.some((reason) => reasonPattern.test(reason)), `${label}: ${receipt.failureReasons.join('; ')}`)
  }
})

test('release verifier rejects output tamper and cross-run plans', () =>
{
  const inputs = fixtureInputs()
  const receipt = produceReleaseDeploymentObservation(inputs)
  const tampered = structuredClone(receipt)
  tampered.observations.candidateFacts['release-identity-readiness'].configDigest = DIGEST('f')
  assert.throws(() => verifyReleaseDeploymentObservation({ ...inputs, receipt: tampered }), /contentDigest mismatch/u)

  const crossRun = fixtureInputs()
  crossRun.rawReceipts[0].identity = { ...crossRun.rawReceipts[0].identity, runId: 'other-run' }
  crossRun.rawReceipts[0] = sealCurrentRunInput(crossRun.rawReceipts[0])
  const failed = produceReleaseDeploymentObservation(crossRun)
  assert.equal(failed.status, 'failed')
  assert.ok(failed.failureReasons.some((reason) => /identity does not match/u.test(reason)))
})
