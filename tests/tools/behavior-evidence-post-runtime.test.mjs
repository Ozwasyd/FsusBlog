import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { digestCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'
import { buildPostRuntimeAcceptedClaimsReceipt } from '../../tools/docs/post-runtime-accepted-claims.mjs'
import { resolveSourceCommit, resolveWorktreeFingerprint } from '../../tools/fact-extractors/identity.mjs'
import { digestValue, stable } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import {
  joinBehaviorEvidencePostRuntime,
  joinVerifiedPostRuntimeObservations,
  root,
  validatePostRuntimeReceipt,
  validatePostRuntimeSchedulerEvidence
} from '../../tools/test-matrix/behavior-evidence-post-runtime.mjs'
import { RunEvidenceObjectStore } from '../../tools/test-matrix/content-addressed-evidence-store.mjs'
import { requiredObservationClasses } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import {
  acquireSchedulerRunLock,
  createSchedulerTierAdmission,
  schedulerCandidateIdentityDigest,
  writeSchedulerTierAdmission
} from '../../tools/test-matrix/scheduler-run-owner.mjs'
import {
  beginCurrentRunEvidencePublication,
  finalizeCurrentRunEvidencePublication
} from '../../tools/test/current-run-evidence-publication.mjs'

const catalog = JSON.parse(fs.readFileSync(path.join(root,
  'config/contracts/behavior-contracts.json'), 'utf8'))
const registry = JSON.parse(fs.readFileSync(path.join(root,
  'config/testing/post-runtime-producer-registry.json'), 'utf8'))
const producer = registry.producers[0]
const commit = resolveSourceCommit(root)
const worktreeFingerprint = resolveWorktreeFingerprint(root)
const runId = 'issue2209-join-current-0001'
const namespace = 'issue2209-join-current'
const attemptId = 'attempt-0001'
const buildDigest = `sha256:${'d'.repeat(64)}`
const candidate = {
  candidateId: `${runId}:candidate`,
  runId,
  attemptId,
  fixtureId: `${runId}:fixture`,
  profileId: 'acceptance-representative',
  runtimeId: `${runId}:runtime`,
  browserId: `${runId}:browser-contract`,
  releaseId: `20260921000000-${commit.slice(0, 12)}`,
  rolloutId: `${runId}-rollout`
}
const seal = (value) => {
  const content = structuredClone(value)
  delete content.contentDigest
  return { ...content, contentDigest: `sha256:${digestValue(content)}` }
}
const reference = (name, contentDigest = `sha256:${digestValue({ name })}`) => ({
  path: `.tmp/issue2209/${name}.json`,
  fileDigest: `sha256:${digestValue({ bytes: name })}`,
  contentDigest
})

function preRuntime()
{
  return seal({
    schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1',
    scope: 'pre-runtime',
    runIdentity: runId,
    sourceIdentity: { commit, worktreeFingerprint: `sha256:${worktreeFingerprint}` },
    buildIdentities: {},
    catalogDigest: `sha256:${digestCatalog(catalog)}`,
    registryDigest: `sha256:${'3'.repeat(64)}`,
    staticAdmissionDigest: `sha256:${'4'.repeat(64)}`,
    behaviorGraphDigest: `sha256:${'5'.repeat(64)}`,
    testEvidenceDigests: [`sha256:${'6'.repeat(64)}`],
    rawResultDigests: { testEvidence: `sha256:${'7'.repeat(64)}` },
    mutationEvidenceDigest: null,
    behaviorIds: [producer.behaviorId],
    requiredTestKinds: { [producer.behaviorId]: [] },
    observedTestKinds: { [producer.behaviorId]: [] },
    mutationStatus: {
      [producer.behaviorId]: {
        behaviorId: producer.behaviorId,
        mutationRequired: false,
        mutationStatus: 'not-applicable',
        qualified: true,
        failures: []
      }
    },
    staticClaimVerificationDigest: '8'.repeat(64),
    missing: [],
    orphans: [],
    conflicts: [],
    runtimeCandidateSpawnCountBeforeReceipt: 0,
    status: 'ok',
    failureReasons: []
  })
}

function candidateContext()
{
  return seal({
    schema: 'fsusblog.post-runtime-candidate-context.v1',
    preRuntimeReceiptRef: {
      path: '.tmp/issue2209/pre.json',
      fileDigest: `sha256:${'1'.repeat(64)}`,
      contentDigest: preRuntime().contentDigest,
      schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1'
    },
    sourceState: { commit, worktreeFingerprint: `sha256:${worktreeFingerprint}` },
    candidate,
    status: 'planned-before-runtime'
  })
}

function claimsFixture(context)
{
  const claimsRoot = path.join(root, '.tmp/issue2209-claims')
  const authority = registry.receiptSemantics.acceptedTerminalAuthority
  const directory = path.join(root, authority.referenceRoot, runId, attemptId)
  fs.rmSync(claimsRoot, { recursive: true, force: true })
  fs.rmSync(directory, { recursive: true, force: true })
  fs.mkdirSync(claimsRoot, { recursive: true })
  fs.mkdirSync(directory, { recursive: true })
  context.after(() => fs.rmSync(claimsRoot, { recursive: true, force: true }))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const ledger = JSON.parse(fs.readFileSync(path.join(root,
    'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
  const claimAcceptance = ledger.scopes.flatMap((scope) => scope.entries.flatMap((entry) =>
    entry.claimIds.map((claimId, index) => ({
      claimId,
      behaviorId: entry.behaviorId,
      scopeId: scope.scopeId,
      documentPath: entry.documentPath,
      claimType: entry.generatedSectionIds[index] ? 'generated-section' : 'prose',
      generatedSectionId: entry.generatedSectionIds[index] ?? null,
      claimDigest: `sha256:${digestValue({ claimId })}`
    })))).sort((left, right) => left.claimId.localeCompare(right.claimId))
  const generatedClaimCount = claimAcceptance
    .filter(({ claimType }) => claimType === 'generated-section').length
  const terminal = {
    schema: 'fsusblog.global-claim-exactness-terminal-receipt.v1',
    scopeId: 'global-document-claim-exactness',
    runId,
    claimAcceptance,
    source: {
      sourceCommit: commit,
      worktreeFingerprint,
      catalogDigest: '1'.repeat(64),
      migrationLedgerDigest: digestValue(ledger),
      sectionCatalogDigest: '2'.repeat(64),
      observationDigests: {}
    },
    authorityDigests: [],
    counts: {
      requiredBehaviors: 10,
      scopes: 6,
      ledgerEntries: 10,
      generatedClaimCount,
      proseClaimCount: claimAcceptance.length - generatedClaimCount,
      proseTotal: 1,
      proseVerified: 1,
      generatedSectionsVerified: 1,
      generatedSectionDrifts: 0,
      missing: 0,
      extra: 0,
      residue: 0,
      mutationKilled: 1,
      mutationTotal: 1,
      warnings: 0
    },
    mutationAggregate: { killed: 1, total: 1 },
    residue: [],
    proseVerification: {},
    status: 'ok',
    failureReasons: [],
    contentDigest: null
  }
  terminal.contentDigest = digestValue(terminal)
  const contextValue = candidateContext()
  const publicationContext = {
    schema: 'fsusblog.current-run-evidence-context.v1',
    schedulerRunId: runId,
    attemptId,
    sourceCommit: commit,
    worktreeFingerprint: `sha256:${worktreeFingerprint}`,
    candidateIdentity: { id: candidate.candidateId, digest: contextValue.contentDigest },
    buildIdentity: { id: `${runId}:build`, digest: buildDigest },
    ownedRoots: [path.relative(root, directory).replaceAll(path.sep, '/')]
  }
  publicationContext.contentDigest = `sha256:${digestValue(publicationContext)}`
  const outputPath = path.relative(root, path.join(directory,
    authority.referenceName)).replaceAll(path.sep, '/')
  const payloadPath = path.relative(root, path.join(directory,
    authority.payloadName)).replaceAll(path.sep, '/')
  const options = {
    authorityId: authority.authorityId,
    producerId: authority.producerId,
    context: publicationContext,
    outputPath,
    payloadPath,
    repositoryRoot: root
  }
  const session = beginCurrentRunEvidencePublication(options)
  fs.writeFileSync(path.join(root, payloadPath), `${JSON.stringify(terminal, null, 2)}\n`)
  finalizeCurrentRunEvidencePublication({
    ...options,
    sessionId: session.sessionId,
    payloadSchema: terminal.schema,
    terminalStatus: 'success'
  })
  const claims = registry.producers.map(({ producerId }) => buildPostRuntimeAcceptedClaimsReceipt({
    terminalReceiptPath: outputPath,
    expectedRunId: runId,
    producerId,
    repositoryRoot: root
  }))
  return {
    claims,
    claimsReferences: Object.fromEntries(claims.map((receipt) => [receipt.producerId,
      reference(`accepted-claims-${receipt.producerId}`, receipt.contentDigest)])),
    candidateContext: contextValue
  }
}

function aggregateObservations(pre)
{
  const make = (producer, scope, classes) => seal({
    schema: 'fsusblog.post-runtime-observation-receipt.v2',
    scope,
    behaviorId: producer.behaviorId,
    producerId: producer.producerId,
    sourceState: { commit, worktreeFingerprint: `sha256:${worktreeFingerprint}` },
    candidate,
    build: {
      receipt: '.tmp/issue2209/build.json',
      receiptContentDigest: buildDigest,
      sourceState: { commit, worktreeFingerprint: `sha256:${worktreeFingerprint}` },
      profile: 'production'
    },
    buildReceiptDigest: buildDigest,
    candidatePlanDigest: `sha256:${'9'.repeat(64)}`,
    candidatePlanRef: {
      path: '.tmp/issue2209/plan.json',
      fileDigest: `sha256:${'a'.repeat(64)}`,
      contentDigest: `sha256:${'9'.repeat(64)}`,
      schema: 'fsusblog.post-runtime-candidate-plan.v1'
    },
    preRuntimeReceiptDigest: pre.contentDigest,
    acceptedClaimsReceiptDigest: `sha256:${'b'.repeat(64)}`,
    acceptedClaimsReceiptRef: {
      path: '.tmp/issue2209/accepted-claims.json',
      fileDigest: `sha256:${'c'.repeat(64)}`,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      schema: 'fsusblog.post-runtime-accepted-claims.v1'
    },
    acceptedClaimRefs: [...producer.acceptedClaimRefs].sort(),
    requiredClasses: classes,
    observedClasses: classes,
    observations: classes.map((classId) => ({
      classId,
      receiptDigest: `sha256:${digestValue({ classId, receipt: true })}`,
      classReceiptRef: {
        path: `.tmp/issue2209/classes/${classId}.json`,
        fileDigest: `sha256:${digestValue({ classId, bytes: true })}`,
        contentDigest: `sha256:${digestValue({ classId, receipt: true })}`,
        schema: 'fsusblog.post-runtime-class-receipt.v1',
        role: 'class'
      },
      modes: Object.entries(producer.requiredObservations)
        .filter(([, values]) => values.includes(classId))
        .map(([mode]) => mode)
        .sort(),
      rawResultRef: {
        path: `.tmp/issue2209/raw/${classId}.json`,
        fileDigest: `sha256:${digestValue({ classId, rawBytes: true })}`,
        contentDigest: `sha256:${digestValue({ classId, raw: true })}`,
        schema: registry.observationClasses[classId].schema,
        role: 'raw-result'
      },
      semanticFacts: { classId, verified: true }
    })),
    status: 'qualified',
    failureReasons: []
  })
  return registry.producers.flatMap((producer) => ['application', 'release-deployment']
    .flatMap((scope) =>
    {
      const classes = requiredObservationClasses(registry, producer, scope)
      return classes.length === 0 ? [] : [make(producer, scope, classes)]
    }))
}

function schedulerFixture(context, pre)
{
  const runsRoot = path.join(root, '.tmp/test-runs')
  const runDirectory = path.join(runsRoot, runId)
  const lockDirectory = path.join(runsRoot, '.locks', `${runId}.lock`)
  fs.rmSync(runDirectory, { recursive: true, force: true })
  fs.rmSync(lockDirectory, { recursive: true, force: true })
  const candidateDigest = schedulerCandidateIdentityDigest({
    runId,
    targetTierId: 'release-final',
    namespace,
    sourceState: { commit, worktreeFingerprint },
    budgetPolicyDigest: null
  })
  const lock = acquireSchedulerRunLock({
    runsRoot,
    runId,
    candidateIdentityDigest: candidateDigest,
    targetTierId: 'release-final'
  })
  assert.equal(lock.markRunning(), true)
  context.after(() => {
    lock.finalize('complete')
    fs.rmSync(runDirectory, { recursive: true, force: true })
    fs.rmSync(lockDirectory, { recursive: true, force: true })
  })
  const store = new RunEvidenceObjectStore({
    root: path.join(runDirectory, 'evidence-store'),
    runId,
    sourceState: { commit, worktreeFingerprint }
  })
  const admission = createSchedulerTierAdmission({
    runId,
    targetTierId: 'release-final',
    currentTierId: 'behavior-evidence-post-runtime',
    namespace,
    mode: 'fresh',
    sourceState: { commit, worktreeFingerprint },
    schedulerCandidateIdentityDigest: candidateDigest,
    schedulerOwnerToken: lock.owner.ownerToken,
    budgetPolicyDigest: null,
    schedulerCheckpointRevision: 1,
    admissionSequence: 1,
    activeTierIds: [],
    releaseFinalSpawnCountBeforeAdmission: 0
  })
  const published = writeSchedulerTierAdmission({ runsRoot, admission })
  const schedulerReference = {
    path: path.relative(root, published.file).replaceAll(path.sep, '/'),
    fileDigest: published.fileDigest,
    contentDigest: published.contentDigest
  }
  store.appendJournalEvent({
    eventType: 'tier-admitted',
    tier: admission.currentTierId,
    step: 'scheduler',
    status: 'running',
    payload: {
      operations: [{
        kind: 'set',
        path: ['schedulerAdmissions', admission.currentTierId],
        value: {
          schema: published.schema,
          ref: schedulerReference.path,
          fileDigest: schedulerReference.fileDigest,
          contentDigest: schedulerReference.contentDigest,
          currentTierId: published.currentTierId,
          admissionSequence: published.admissionSequence
        }
      }]
    }
  })
  assert.equal(validatePostRuntimeSchedulerEvidence({
    admission,
    reference: schedulerReference,
    preRuntimeReceipt: pre,
    repositoryRoot: root
  }).contentDigest, admission.contentDigest)
  return { admission, schedulerReference }
}

function inputs(context)
{
  const pre = preRuntime()
  const claims = claimsFixture(context)
  const scheduler = schedulerFixture(context, pre)
  const observations = aggregateObservations(pre).map((observation) =>
  {
    const accepted = claims.claims.find(({ producerId }) => producerId === observation.producerId)
    return seal({
      ...observation,
      acceptedClaimsReceiptDigest: accepted.contentDigest,
      acceptedClaimsReceiptRef: {
        ...claims.claimsReferences[accepted.producerId],
        schema: 'fsusblog.post-runtime-accepted-claims.v1'
      }
    })
  })
  return {
    preRuntimeReceipt: pre,
    catalog: structuredClone(catalog),
    registry: structuredClone(registry),
    observations,
    observationReferences: observations.map((receipt) => ({
      scope: receipt.scope,
      producerId: receipt.producerId,
      ...reference(`${receipt.producerId}-${receipt.scope}-observation`, receipt.contentDigest)
    })),
    acceptedClaims: claims.claims,
    acceptedClaimsReferences: claims.claimsReferences,
    candidateContext: claims.candidateContext,
    schedulerAdmission: scheduler.admission,
    schedulerReference: scheduler.schedulerReference,
    repositoryRoot: root
  }
}

test('joins current application and release/deployment aggregates into one exact receipt', (context) =>
{
  const value = inputs(context)
  const receipt = joinVerifiedPostRuntimeObservations(value)
  assert.equal(validatePostRuntimeReceipt(receipt).contentDigest, receipt.contentDigest)
  assert.deepEqual(receipt.behaviorIds, registry.producers.map(({ behaviorId }) => behaviorId).sort())
  assert.deepEqual(receipt.requiredRuntimeProducers, registry.producers.map(({ producerId }) => producerId).sort())
  assert.equal(receipt.observedBehaviorResults.length, Object.keys(registry.observationClasses).length)
  assert.equal(receipt.releaseFinalSpawnCountBeforeReceipt, 0)
  assert.equal(receipt.candidateIdentity.releaseId, candidate.releaseId)
  assert.equal(Object.keys(receipt.documentClaimDigests).length,
    registry.producers.flatMap(({ acceptedClaimRefs }) => acceptedClaimRefs).length)
  assert.equal(receipt.executionIdentity.schedulerRunId, runId)
  assert.equal(receipt.observedBehaviorResults.every(({ behaviorId, extractorId }) =>
    extractorId === catalog.contracts.find(({ id }) => id === behaviorId).factExtractorId), true)
})

test('missing, duplicate, extra and cross-scope observations fail closed', (context) =>
{
  const cases = [
    ['missing class', (value) => value.observations[0].observations.pop()],
    ['duplicate class', (value) => value.observations[1].observations.push(
      structuredClone(value.observations[0].observations[0]))],
    ['extra class', (value) => value.observations[0].observations.push({
      ...structuredClone(value.observations[0].observations[0]),
      classId: 'unknown-class'
    })],
    ['cross candidate', (value) => { value.observations[1].candidate.runtimeId = 'other-runtime' }],
    ['duplicate scope', (value) => { value.observations[1].scope = 'application' }]
  ]
  for (const [name, mutate] of cases)
  {
    const value = inputs(context)
    mutate(value)
    assert.throws(() => joinVerifiedPostRuntimeObservations(value), undefined, name)
  }
})

test('diagnostic, recovered, stale and claim-downgraded aggregates cannot qualify', (context) =>
{
  const cases = [
    ['diagnostic', (value) => { value.observations[0].status = 'diagnostic' }],
    ['recovered', (value) => { value.observations[1].status = 'recovered' }],
    ['stale pre-runtime', (value) => {
      value.observations[0].preRuntimeReceiptDigest = `sha256:${'f'.repeat(64)}`
    }],
    ['claim downgrade', (value) => { value.acceptedClaims[0].claims.pop() }],
    ['catalog drift', (value) => { value.preRuntimeReceipt.catalogDigest = `sha256:${'f'.repeat(64)}` }]
  ]
  for (const [name, mutate] of cases)
  {
    const value = inputs(context)
    mutate(value)
    assert.throws(() => joinVerifiedPostRuntimeObservations(value), undefined, name)
  }
})

test('scheduler proof rejects early release-final spawn and stale owner evidence', (context) =>
{
  const early = inputs(context)
  early.schedulerAdmission = seal({
    ...early.schedulerAdmission,
    releaseFinalSpawnCountBeforeAdmission: 1
  })
  assert.throws(() => joinVerifiedPostRuntimeObservations(early),
    /release-final was spawned/u)

  const stale = inputs(context)
  stale.schedulerAdmission.schedulerOwnerToken = 'stale-owner'
  assert.throws(() => joinVerifiedPostRuntimeObservations(stale),
    /not live and exact|path identity/u)
})

test('closed receipt validation rejects owner, class, count and digest tamper', (context) =>
{
  const receipt = joinVerifiedPostRuntimeObservations(inputs(context))
  const cases = [
    [(value) => { value.observedBehaviorResults[0].producerId = 'other-producer' },
      /producer classes/u],
    [(value) => { value.observedProducerClasses[producer.producerId].pop() },
      /producer classes/u],
    [(value) => { value.findingCounts.stale = 1 }, /finding counts/u],
    [(value) => { value.releaseFinalSpawnCountBeforeReceipt = 1 }, /schema validation/u],
    [(value) => { value.unknown = true }, /schema validation/u]
  ]
  for (const [mutate, expected] of cases)
  {
    const changed = structuredClone(receipt)
    mutate(changed)
    changed.contentDigest = `sha256:${digestValue(
      Object.fromEntries(Object.entries(changed).filter(([key]) => key !== 'contentDigest'))
    )}`
    assert.throws(() => validatePostRuntimeReceipt(changed), expected)
  }
  const digestTamper = structuredClone(receipt)
  digestTamper.documentClaimTerminalDigest = `sha256:${'f'.repeat(64)}`
  assert.throws(() => validatePostRuntimeReceipt(digestTamper), /contentDigest mismatch/u)
})

test('path join requires persisted scoped aggregates and invokes both independent producer verifiers', () =>
{
  assert.throws(() => joinBehaviorEvidencePostRuntime({
    preRuntimeReceipt: '.tmp/issue2209/pre.json',
    observationReceipts: []
  }), /explicit unique aggregate observation/u)
  assert.throws(() => joinBehaviorEvidencePostRuntime({
    preRuntimeReceipt: '.tmp/history/pre.json',
    observationReceipts: ['a.json', 'b.json']
  }), /current-run/u)
  const source = fs.readFileSync(path.join(root,
    'tools/test-matrix/behavior-evidence-post-runtime.mjs'), 'utf8')
  assert.match(source, /validateApplicationRuntimeObservation\(input\.value/u)
  assert.match(source, /validateReleaseDeploymentObservation\(input\.value/u)
  assert.match(source, /validatePostRuntimeAcceptedClaimsValue\(/u)
  assert.match(source, /schedulerTierAdmissionActivity\(/u)
  assert.doesNotMatch(source, /(?:spawn|execFile|execSync)\(/u)
  assert.doesNotMatch(source, /produceApplicationRuntimeObservation|produceReleaseDeploymentObservation/u)
  assert.doesNotMatch(source, /readFileSync\([^)]*(?:docs\/|\.md)/u)
  const bundle = fs.readFileSync(path.join(root,
    'tools/test/bundles/behavior-evidence-post-runtime.sh'), 'utf8')
  assert.match(bundle, /application-runtime-observation-producer\.json/u)
  assert.match(bundle, /release-deployment-observation-producer\.json/u)
  assert.match(bundle, /--observation "\$APPLICATION"[\s\S]*--observation "\$RELEASE"/u)
  assert.doesNotMatch(bundle,
    /application-runtime\.mjs|release-deployment\.mjs|post-runtime-observation-producers/u)
})

// These are join/closure controls using the original claims publication fixture.
// Synthetic class facts here do not replace the path join's independent class
// replay or the actual current-schema issuer/database observation obligation.
function resealObservationInputs(value)
{
  value.observations = value.observations.map(seal)
  value.observationReferences = value.observations.map((receipt) => ({
    producerId: receipt.producerId,
    scope: receipt.scope,
    ...reference(`${receipt.producerId}-${receipt.scope}-observation`, receipt.contentDigest)
  }))
}

test('v2 joins the registered disjoint producers, claims, and proof scopes without empty owners', (context) =>
{
  const value = inputs(context)
  assert.equal(registry.schema, 'fsusblog.post-runtime-producer-registry.v3')
  assert.equal(registry.producers.length, 2)
  const receipt = joinVerifiedPostRuntimeObservations(value)
  assert.equal(receipt.schema, 'fsusblog.behavior-evidence-post-runtime-receipt.v2')
  for (const owner of registry.producers)
  {
    const expectedClasses = [...new Set(Object.values(owner.requiredObservations).flat())].sort()
    assert.deepEqual(receipt.requiredProducerClasses[owner.producerId], expectedClasses)
    assert.deepEqual(receipt.observedProducerClasses[owner.producerId], expectedClasses)
    assert.deepEqual(receipt.requiredProducerClaims[owner.producerId], [...owner.acceptedClaimRefs].sort())
    assert.deepEqual(receipt.observedProducerClaims[owner.producerId], [...owner.acceptedClaimRefs].sort())
    assert.deepEqual(receipt.requiredProducerScopes[owner.producerId],
      ['application', 'release-deployment'].filter((scope) =>
        requiredObservationClasses(registry, owner, scope).length > 0).sort())
    assert.deepEqual(receipt.acceptedClaimsRefs[owner.producerId], value.acceptedClaimsReferences[owner.producerId])
  }
  assert.equal(new Set(receipt.observedBehaviorResults.map(({ classId }) => classId)).size,
    Object.keys(registry.observationClasses).length)
})

test('resealed scoped receipts cannot move classes, claims, or proof ownership between producers', (context) =>
{
  const cases = [
    ['missing producer', (value) => { value.observations = value.observations.filter((receipt) =>
      receipt.producerId !== registry.producers[1].producerId) }],
    ['duplicate producer scope', (value) => { value.observations.push(structuredClone(value.observations[0])) }],
    ['unregistered producer', (value) => { value.observations[0].producerId = 'unregistered-runtime-producer' }],
    ['wrong producer class', (value) => {
      const other = value.observations.find((receipt) => receipt.producerId !== value.observations[0].producerId)
      const moved = structuredClone(other.observations[0])
      value.observations[0].observations[0] = moved
      value.observations[0].requiredClasses[0] = moved.classId
      value.observations[0].observedClasses[0] = moved.classId
    }],
    ['wrong owned scope', (value) => {
      const native = value.observations.find((receipt) => receipt.producerId === registry.producers[1].producerId)
      native.scope = native.scope === 'application' ? 'release-deployment' : 'application'
    }],
    ['reduced modes', (value) => { value.observations[0].observations[0].modes.pop() }],
    ['cross producer claims', (value) => {
      const otherId = registry.producers[1].producerId
      value.observations[0].acceptedClaimsReceiptRef = {
        ...value.acceptedClaimsReferences[otherId], schema: 'fsusblog.post-runtime-accepted-claims.v1'
      }
      value.observations[0].acceptedClaimsReceiptDigest = value.acceptedClaimsReferences[otherId].contentDigest
      value.observations[0].acceptedClaimRefs = [...registry.producers[1].acceptedClaimRefs]
    }],
    ['missing claims producer', (value) => { value.acceptedClaims.pop() }],
    ['duplicate claims producer', (value) => { value.acceptedClaims.push(structuredClone(value.acceptedClaims[0])) }],
    ['orphan claim reference', (value) => { value.acceptedClaimsReferences.orphan = reference('orphan') }]
  ]
  for (const [name, mutate] of cases)
  {
    const value = inputs(context)
    assert.doesNotThrow(() => joinVerifiedPostRuntimeObservations(value), `${name} valid precondition`)
    mutate(value)
    resealObservationInputs(value)
    assert.throws(() => joinVerifiedPostRuntimeObservations(value), undefined, name)
  }
})

test('strict v2 rejects old aggregate and outer v1 receipts rather than relabelling them', (context) =>
{
  const value = inputs(context)
  const receipt = joinVerifiedPostRuntimeObservations(value)
  const oldOuter = seal({ ...receipt, schema: 'fsusblog.behavior-evidence-post-runtime-receipt.v1' })
  assert.throws(() => validatePostRuntimeReceipt(oldOuter), /schema validation/u)
  value.observations[0].schema = 'fsusblog.post-runtime-observation-receipt.v1'
  resealObservationInputs(value)
  assert.throws(() => joinVerifiedPostRuntimeObservations(value), /not qualified/u)
})

test('resealed v2 outer maps reject duplicate class union, extra claims, and scoped reference swaps', (context) =>
{
  const receipt = joinVerifiedPostRuntimeObservations(inputs(context))
  const cases = [
    (value) => { value.observedBehaviorResults.push(structuredClone(value.observedBehaviorResults[0])) },
    (value) => { value.documentClaimDigests.orphan = `sha256:${'f'.repeat(64)}` },
    (value) => { value.observedProducerClaims[producer.producerId].pop() },
    (value) => { value.observationRefs[0].producerId = registry.producers[1].producerId },
    (value) => { delete value.acceptedClaimsRefs[registry.producers[1].producerId] }
  ]
  for (const mutate of cases)
  {
    const changed = structuredClone(receipt)
    mutate(changed)
    assert.throws(() => validatePostRuntimeReceipt(seal(changed)))
  }
})
