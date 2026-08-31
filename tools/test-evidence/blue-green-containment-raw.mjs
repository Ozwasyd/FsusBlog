#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import {
  candidatePlanPathForObservation,
  explicitJson,
  observationEnvelopeAuthorityFields,
  observationSourceState,
  seal,
  validateCandidatePlan,
  writeReceipt
} from '../fact-extractors/post-runtime/adapter.mjs'
import {
  loadPostRuntimeProducerRegistry,
  root,
  validateProducerReceiptAgainstRegistry
} from '../test-matrix/post-runtime-producer-registry.mjs'
import { productionBuildBinding } from '../release/test-evidence-receipts.mjs'
import { verifyCanonicalReleaseAuthorities } from './canonical-release-authorities.mjs'

export const sourceReceiptSchema = 'fsusblog.blue-green-containment-source-receipt.v1'
export const sourceBundleSchema = 'fsusblog.blue-green-containment-source-bundle.v1'
export const failureReceiptSchema = 'fsusblog.observation.blue-green-containment.failure.v1'
export const canonicalAuthorityBundleSchema = 'fsusblog.blue-green-containment-authority-bundle.v1'

const classId = 'blue-green-containment'
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const forbiddenPathPattern = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const roles = Object.freeze([
  'state-before',
  'state-after',
  'promotion',
  'switch',
  'health',
  'rollback',
  'failure',
  'traffic',
  'artifact',
  'volume',
  'schema',
  'process',
  'cleanup',
  'terminal'
])
const identityFields = Object.freeze([
  'sourceCommit',
  'worktreeFingerprint',
  'buildIdentity',
  'candidateId',
  'releaseId',
  'rolloutId',
  'deploymentId',
  'runtimeId',
  'runId',
  'attemptId',
  'producerId',
  'schemaIdentity',
  'toolchainIdentity'
])

const fail = (message) => { throw new Error(`[blue-green-containment-raw] ${message}`) }
const bytesDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`

function privacySafeMessage(error)
{
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?<name>password|passwd|token|secret|credential)\s*[=:]\s*[^\s,;}]+/giu, '$<name>=<redacted>')
    .slice(0, 2048)
}

function exactKeys(value, expected, label)
{
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0'))
  {
    fail(`${label} fields do not exact-match its contract`)
  }
}

function requireDigest(value, label)
{
  if (!digestPattern.test(String(value ?? ''))) fail(`${label} must be a sha256 digest`)
}

function requireId(value, label)
{
  if (!safeIdentifierPattern.test(String(value ?? ''))) fail(`${label} must be an exact identifier`)
}

function safeInput(relative, repositoryRoot, label)
{
  if (typeof relative !== 'string' || relative.length === 0 || !relative.endsWith('.json')
    || path.isAbsolute(relative) || forbiddenPathPattern.test(relative))
  {
    fail(`${label} must be an explicit current-run JSON path`)
  }
  const normalized = relative.replaceAll('\\', '/')
  if (path.posix.normalize(normalized) !== normalized
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..'))
  {
    fail(`${label} path is not canonical`)
  }
  const base = path.resolve(repositoryRoot)
  const absolute = path.resolve(base, normalized)
  if (!absolute.startsWith(`${base}${path.sep}`)) fail(`${label} escapes the repository`)
  let cursor = absolute
  while (cursor !== base)
  {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail(`${label} contains a symlink`)
    cursor = path.dirname(cursor)
  }
  if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) fail(`${label} is missing`)
  const bytes = fs.readFileSync(absolute)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) }
  catch { fail(`${label} is not structured JSON`) }
  return {
    value,
    ref: {
      path: normalized,
      fileDigest: bytesDigest(bytes),
      contentDigest: value.contentDigest ?? null,
      schema: value.schema ?? null
    }
  }
}

function verifySeal(receipt, label)
{
  requireDigest(receipt?.contentDigest, `${label} contentDigest`)
  const replay = seal(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))
  if (receipt.contentDigest !== replay.contentDigest) fail(`${label} contentDigest mismatch`)
}

function planContext(candidatePlan, repositoryRoot)
{
  const input = safeInput(candidatePlan, repositoryRoot, 'candidate plan')
  const plan = validateCandidatePlan(input.value, { repositoryRoot })
  const planned = plan.observations.find((entry) => entry.classId === classId)
  if (!planned) fail('candidate plan does not own blue-green-containment')
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  const definition = registry.observationClasses[classId]
  const producer = registry.producers.find(({ producerId }) => producerId === plan.producerId)
  if (!definition || planned.schema !== definition.schema) fail('candidate plan blue-green schema authority mismatch')
  if (!producer) fail('candidate plan producer is absent from registry')
  const build = explicitJson(plan.build.receipt, 'production build receipt', repositoryRoot).value
  const buildBinding = productionBuildBinding(build, plan.build.receipt)
  if (buildBinding.receiptContentDigest !== plan.build.receiptContentDigest
    || buildBinding.sourceState.commit !== plan.sourceState.commit
    || `sha256:${String(buildBinding.sourceState.worktreeFingerprint).replace(/^sha256:/u, '')}`
      !== plan.sourceState.worktreeFingerprint)
  {
    fail('production build receipt does not exact-match the candidate plan')
  }
  return {
    plan,
    planned,
    definition,
    toolVersion: producer.toolVersion,
    candidatePlanRef: {
      path: input.ref.path,
      fileDigest: input.ref.fileDigest,
      contentDigest: input.ref.contentDigest
    },
    toolchainIdentity: semanticDigest(build.toolchain ?? build.producer)
  }
}

function expectedIdentity(context, deploymentId)
{
  const { plan, definition, toolchainIdentity } = context
  return {
    sourceCommit: plan.sourceState.commit,
    worktreeFingerprint: plan.sourceState.worktreeFingerprint,
    buildIdentity: plan.build.receiptContentDigest,
    candidateId: plan.candidate.candidateId,
    releaseId: plan.candidate.releaseId,
    rolloutId: plan.candidate.rolloutId,
    deploymentId,
    runtimeId: plan.candidate.runtimeId,
    runId: plan.candidate.runId,
    attemptId: plan.candidate.attemptId,
    producerId: plan.producerId,
    schemaIdentity: definition.schema,
    toolchainIdentity
  }
}

function requireIdentity(receipt, expected, role)
{
  exactKeys(receipt.sourceState, identityFields, `${role} sourceState`)
  for (const field of identityFields)
  {
    if (receipt.sourceState[field] !== expected[field]) fail(`${role} ${field} does not exact-match the candidate plan`)
  }
}

function slotIdentity(value, label)
{
  exactKeys(value, [
    'slot', 'releaseId', 'imageDigest', 'artifactDigest', 'volumeDigest',
    'schemaDigest', 'processDigest', 'runtimeRole'
  ], label)
  if (!['blue', 'green'].includes(value.slot)) fail(`${label} slot must be blue or green`)
  requireId(value.releaseId, `${label} releaseId`)
  for (const field of ['imageDigest', 'artifactDigest', 'volumeDigest', 'schemaDigest', 'processDigest'])
  {
    requireDigest(value[field], `${label} ${field}`)
  }
  if (value.runtimeRole !== 'monolithic') fail(`${label} runtime role must be observed as monolithic`)
  return value
}

function stateObservation(value, role)
{
  exactKeys(value, ['active', 'standby'], `${role} observation`)
  const active = slotIdentity(value.active, `${role} active`)
  const standby = slotIdentity(value.standby, `${role} standby`)
  if (active.slot === standby.slot || active.releaseId === standby.releaseId)
  {
    fail(`${role} active and standby identities are ambiguous`)
  }
  return { active, standby }
}

function transitionObservation(value, role, expectedStatus)
{
  exactKeys(value, [
    'sourceSlot', 'targetSlot', 'sourceReleaseId', 'targetReleaseId',
    'activeReleaseId', 'gatewayGeneration', 'status'
  ], `${role} observation`)
  if (!['blue', 'green'].includes(value.sourceSlot) || !['blue', 'green'].includes(value.targetSlot)
    || value.sourceSlot === value.targetSlot)
  {
    fail(`${role} slot transition is invalid`)
  }
  for (const field of ['sourceReleaseId', 'targetReleaseId', 'activeReleaseId']) requireId(value[field], `${role} ${field}`)
  if (!Number.isSafeInteger(value.gatewayGeneration) || value.gatewayGeneration < 1) fail(`${role} gatewayGeneration is invalid`)
  if (value.status !== expectedStatus) fail(`${role} status must be ${expectedStatus}`)
  return value
}

function healthObservation(value)
{
  const booleans = [
    'serviceReady', 'routeDataReady', 'cacheReady', 'dependenciesReady',
    'versionReady', 'credentialReady'
  ]
  exactKeys(value, ['releaseId', ...booleans, 'status'], 'health observation')
  requireId(value.releaseId, 'health releaseId')
  if (value.status !== 'passed' || booleans.some((field) => value[field] !== true))
  {
    fail('health observation is incomplete; process, port, HTTP, or file existence cannot substitute readiness')
  }
  return value
}

function failureObservation(value)
{
  exactKeys(value, ['cases', 'status'], 'failure observation')
  if (value.status !== 'passed' || !Array.isArray(value.cases) || value.cases.length === 0) fail('failure cases are missing')
  const ids = new Set()
  for (const item of value.cases)
  {
    exactKeys(item, [
      'caseId', 'beforeActiveReleaseId', 'attemptedReleaseId',
      'afterActiveReleaseId', 'terminalState'
    ], 'failure case')
    requireId(item.caseId, 'failure caseId')
    if (ids.has(item.caseId)) fail(`duplicate failure case ${item.caseId}`)
    ids.add(item.caseId)
    for (const field of ['beforeActiveReleaseId', 'attemptedReleaseId', 'afterActiveReleaseId'])
    {
      requireId(item[field], `failure ${field}`)
    }
    if (item.beforeActiveReleaseId !== item.afterActiveReleaseId || item.terminalState !== 'contained')
    {
      fail(`failure case ${item.caseId} changed or obscured the active release`)
    }
  }
  return value
}

function trafficObservation(value)
{
  exactKeys(value, [
    'activeReleaseId', 'ownerReleaseIds', 'partialSwitch', 'splitBrain',
    'unknownOwner', 'status'
  ], 'traffic observation')
  requireId(value.activeReleaseId, 'traffic activeReleaseId')
  if (value.status !== 'passed' || value.partialSwitch !== false || value.splitBrain !== false
    || value.unknownOwner !== false || !Array.isArray(value.ownerReleaseIds)
    || value.ownerReleaseIds.length !== 1 || value.ownerReleaseIds[0] !== value.activeReleaseId)
  {
    fail('traffic ownership is partial, split-brain, or ambiguous')
  }
  return value
}

function containmentObservation(value, role)
{
  exactKeys(value, [
    'activeReleaseId', 'inactiveReleaseId', 'activePreserved',
    'inactiveOperationOwned', 'sharedPreserved', 'status'
  ], `${role} observation`)
  requireId(value.activeReleaseId, `${role} activeReleaseId`)
  requireId(value.inactiveReleaseId, `${role} inactiveReleaseId`)
  if (value.activeReleaseId === value.inactiveReleaseId || value.status !== 'passed'
    || value.activePreserved !== true || value.inactiveOperationOwned !== true
    || value.sharedPreserved !== true)
  {
    fail(`${role} containment did not preserve active/shared facts or prove inactive ownership`)
  }
  return value
}

function processObservation(value)
{
  const observation = containmentObservation(value, 'process')
  if (observation.runtimeRoleContractSatisfied !== undefined) fail('process observation contains an unsupported inferred runtime role')
  return observation
}

function cleanupObservation(value)
{
  exactKeys(value, [
    'operationOwnedReleaseId', 'deletedReleaseIds', 'preservedReleaseIds',
    'activeTouched', 'sharedTouched', 'otherRunTouched', 'status'
  ], 'cleanup observation')
  requireId(value.operationOwnedReleaseId, 'cleanup operationOwnedReleaseId')
  if (!Array.isArray(value.deletedReleaseIds) || !Array.isArray(value.preservedReleaseIds)
    || value.deletedReleaseIds.some((releaseId) => !safeIdentifierPattern.test(releaseId))
    || value.preservedReleaseIds.some((releaseId) => !safeIdentifierPattern.test(releaseId))
    || !value.deletedReleaseIds.includes(value.operationOwnedReleaseId)
    || value.status !== 'passed' || value.activeTouched !== false
    || value.sharedTouched !== false || value.otherRunTouched !== false)
  {
    fail('cleanup is not limited to current-operation owned inactive facts')
  }
  return value
}

function terminalObservation(value)
{
  exactKeys(value, [
    'status', 'errors', 'timedOut', 'cancelled', 'automaticRetryCount',
    'privacySafe', 'canonicalRerunCommand'
  ], 'terminal observation')
  if (value.status !== 'passed' || !Array.isArray(value.errors) || value.errors.length !== 0
    || value.timedOut !== false || value.cancelled !== false || value.automaticRetryCount !== 0
    || value.privacySafe !== true || typeof value.canonicalRerunCommand !== 'string'
    || value.canonicalRerunCommand.length === 0)
  {
    fail('terminal receipt is failed, incomplete, retried, or not privacy-safe')
  }
  return value
}

function verifyObservation(role, value)
{
  if (role === 'state-before' || role === 'state-after') return stateObservation(value, role)
  if (role === 'promotion') return transitionObservation(value, role, 'promoted')
  if (role === 'switch') return transitionObservation(value, role, 'committed')
  if (role === 'rollback') return transitionObservation(value, role, 'rolled-back')
  if (role === 'health') return healthObservation(value)
  if (role === 'failure') return failureObservation(value)
  if (role === 'traffic') return trafficObservation(value)
  if (['artifact', 'volume', 'schema'].includes(role)) return containmentObservation(value, role)
  if (role === 'process') return processObservation(value)
  if (role === 'cleanup') return cleanupObservation(value)
  if (role === 'terminal') return terminalObservation(value)
  fail(`unknown source role ${role}`)
}

function loadSources(paths, context, deploymentId, repositoryRoot)
{
  if (!Array.isArray(paths) || paths.length !== roles.length) fail('source receipt closure must be exact-one per role')
  requireId(deploymentId, 'deploymentId')
  const expected = expectedIdentity(context, deploymentId)
  const byRole = new Map()
  for (const [index, relative] of paths.entries())
  {
    const input = safeInput(relative, repositoryRoot, `source receipt ${index}`)
    const receipt = input.value
    if (receipt.schema !== sourceReceiptSchema || !roles.includes(receipt.role)) fail('source receipt schema/role mismatch')
    if (byRole.has(receipt.role)) fail(`duplicate source receipt role ${receipt.role}`)
    verifySeal(receipt, `${receipt.role} source receipt`)
    requireIdentity(receipt, expected, receipt.role)
    if (receipt.executionClass !== 'correctness' || receipt.evidenceClass !== 'correctness'
      || receipt.qualificationEligible !== true || receipt.planned !== true
      || receipt.executed !== true || receipt.outcome !== 'passed'
      || receipt.recovered !== false || receipt.diagnostic !== false
      || receipt.stale !== false || receipt.crossCandidate !== false)
    {
      fail(`${receipt.role} is diagnostic, recovered, stale, cross-candidate, blocked, unknown, or not passed`)
    }
    if (typeof receipt.canonicalRerunCommand !== 'string' || receipt.canonicalRerunCommand.length === 0)
    {
      fail(`${receipt.role} canonical rerun command is missing`)
    }
    const observation = verifyObservation(receipt.role, receipt.observation)
    byRole.set(receipt.role, { receipt, observation, ref: input.ref })
  }
  if (roles.some((role) => !byRole.has(role))) fail('source receipt closure has missing roles')
  return { expected, byRole }
}

function crossValidate(byRole, candidateReleaseId)
{
  const before = byRole.get('state-before').observation
  const after = byRole.get('state-after').observation
  const promotion = byRole.get('promotion').observation
  const switched = byRole.get('switch').observation
  const health = byRole.get('health').observation
  const rollback = byRole.get('rollback').observation
  const failures = byRole.get('failure').observation
  const traffic = byRole.get('traffic').observation
  const cleanup = byRole.get('cleanup').observation

  if (before.standby.releaseId !== candidateReleaseId || after.active.releaseId !== candidateReleaseId
    || before.active.releaseId !== after.standby.releaseId
    || before.active.slot !== after.standby.slot || before.standby.slot !== after.active.slot)
  {
    fail('before/after active and standby identities do not prove one exact promotion')
  }
  if (promotion.sourceSlot !== before.active.slot || promotion.targetSlot !== before.standby.slot
    || promotion.sourceReleaseId !== before.active.releaseId
    || promotion.targetReleaseId !== candidateReleaseId
    || promotion.activeReleaseId !== candidateReleaseId
    || switched.sourceSlot !== promotion.sourceSlot || switched.targetSlot !== promotion.targetSlot
    || switched.sourceReleaseId !== promotion.sourceReleaseId
    || switched.targetReleaseId !== promotion.targetReleaseId
    || switched.activeReleaseId !== candidateReleaseId
    || health.releaseId !== candidateReleaseId || traffic.activeReleaseId !== candidateReleaseId)
  {
    fail('promotion, switch, health, traffic, and candidate identities disagree')
  }
  if (rollback.sourceReleaseId !== candidateReleaseId
    || rollback.targetReleaseId !== before.active.releaseId
    || rollback.activeReleaseId !== before.active.releaseId)
  {
    fail('rollback did not restore the exact pre-promotion active identity')
  }
  if (failures.cases.some((item) => item.beforeActiveReleaseId !== before.active.releaseId
    || item.attemptedReleaseId !== candidateReleaseId))
  {
    fail('failure containment cases are not bound to the same active/candidate identities')
  }
  for (const role of ['artifact', 'volume', 'schema', 'process'])
  {
    const observation = byRole.get(role).observation
    if (observation.activeReleaseId !== candidateReleaseId
      || observation.inactiveReleaseId !== before.active.releaseId)
    {
      fail(`${role} containment identities disagree with the terminal active/standby state`)
    }
  }
  if (cleanup.operationOwnedReleaseId !== before.active.releaseId
    || !cleanup.preservedReleaseIds.includes(candidateReleaseId)
    || cleanup.deletedReleaseIds.includes(candidateReleaseId))
  {
    fail('cleanup touched the active release or was not bound to the operation-owned inactive release')
  }
  return { before, after }
}

export function produceBlueGreenContainmentSourceBundle({
  candidatePlan,
  deploymentId,
  sourceReceipts,
  repositoryRoot = root
})
{
  const context = planContext(candidatePlan, repositoryRoot)
  const { expected, byRole } = loadSources(sourceReceipts, context, deploymentId, repositoryRoot)
  return seal({
    schema: sourceBundleSchema,
    sourceState: expected,
    deploymentId,
    candidatePlanRef: context.candidatePlanRef,
    sourceReceiptRefs: roles.map((role) => ({ role, ...byRole.get(role).ref })),
    canonicalRerunCommand: `node tools/test-evidence/blue-green-containment-raw.mjs bundle --candidate-plan ${candidatePlan} --deployment-id ${deploymentId} ${sourceReceipts.map((receipt) => `--source-receipt ${receipt}`).join(' ')}`
  })
}

function loadSourceBundle(sourceReceipt, context, repositoryRoot)
{
  const input = safeInput(sourceReceipt, repositoryRoot, 'blue-green source bundle')
  const bundle = input.value
  if (bundle.schema !== sourceBundleSchema) fail('blue-green source bundle schema mismatch')
  verifySeal(bundle, 'blue-green source bundle')
  if (bundle.candidatePlanRef?.fileDigest !== context.candidatePlanRef.fileDigest
    || bundle.candidatePlanRef?.contentDigest !== context.candidatePlanRef.contentDigest)
  {
    fail('blue-green source bundle candidate binding mismatch')
  }
  const sourceReceipts = bundle.sourceReceiptRefs?.map((reference) => {
    const current = safeInput(reference?.path, repositoryRoot, `${reference?.role ?? 'unknown'} source receipt`)
    if (current.ref.fileDigest !== reference?.fileDigest
      || current.ref.contentDigest !== reference?.contentDigest || current.ref.schema !== reference?.schema)
    {
      fail(`source receipt reference digest mismatch: ${reference?.path ?? '<missing>'}`)
    }
    return reference.path
  })
  return { input, bundle, sourceReceipts }
}

export function produceBlueGreenContainmentRaw({
  candidatePlan,
  sourceReceipt,
  repositoryRoot = root
})
{
  const context = planContext(candidatePlan, repositoryRoot)
  const source = loadSourceBundle(sourceReceipt, context, repositoryRoot)
  const deploymentId = source.bundle.deploymentId
  const { expected, byRole } = loadSources(source.sourceReceipts, context, deploymentId, repositoryRoot)
  const { before, after } = crossValidate(byRole, context.plan.candidate.releaseId)
  const digestFor = (role) => semanticDigest(byRole.get(role).observation)
  const facts = {
    activeBeforeDigest: semanticDigest(before.active),
    standbyBeforeDigest: semanticDigest(before.standby),
    activeAfterDigest: semanticDigest(after.active),
    standbyAfterDigest: semanticDigest(after.standby),
    promotionReceiptDigest: byRole.get('promotion').receipt.contentDigest,
    switchReceiptDigest: byRole.get('switch').receipt.contentDigest,
    healthReceiptDigest: byRole.get('health').receipt.contentDigest,
    rollbackReceiptDigest: byRole.get('rollback').receipt.contentDigest,
    failureReceiptDigest: byRole.get('failure').receipt.contentDigest,
    trafficOwnershipDigest: digestFor('traffic'),
    artifactContainmentDigest: digestFor('artifact'),
    volumeContainmentDigest: digestFor('volume'),
    schemaContainmentDigest: digestFor('schema'),
    processContainmentDigest: digestFor('process'),
    cleanupReceiptDigest: byRole.get('cleanup').receipt.contentDigest,
    terminalReceiptDigest: byRole.get('terminal').receipt.contentDigest,
    activeReleaseProtected: true,
    activeIdentityKnown: true,
    switchComplete: true,
    splitBrainAbsent: true,
    cleanupInactiveOnly: true,
    sharedFactsPreserved: true,
    runtimeRoleContractSatisfied: before.active.runtimeRole === 'monolithic'
      && before.standby.runtimeRole === 'monolithic'
      && after.active.runtimeRole === 'monolithic'
      && after.standby.runtimeRole === 'monolithic'
  }
  return seal({
    schema: context.definition.schema,
    producerId: context.plan.producerId,
    toolVersion: context.toolVersion,
    sourceState: expected,
    executionClass: 'correctness',
    evidenceClass: 'correctness',
    qualificationEligible: true,
    planned: true,
    executed: true,
    outcome: 'passed',
    recovered: false,
    modes: context.planned.requiredModes,
    terminal: { timeout: false, cancelled: false, processTreeTerminated: false, priorAttemptDigest: null },
    semanticFacts: facts,
    candidatePlanRef: context.candidatePlanRef,
    sourceReceiptRef: {
      path: source.input.ref.path,
      fileDigest: source.input.ref.fileDigest,
      contentDigest: source.input.ref.contentDigest
    },
    canonicalRerunCommand: `node tools/test-evidence/blue-green-containment-raw.mjs produce --candidate-plan ${candidatePlan} --source ${source.input.ref.path} --out ${context.planned.receiptPath}`,
    independentVerifyCommand: `node tools/test-evidence/blue-green-containment-raw.mjs verify --receipt ${context.planned.receiptPath}`
  })
}

export function produceBlueGreenAuthorityBundle({
  candidatePlan,
  rolloutEvidence,
  runtimeRoleAdmission,
  repositoryRoot = root
})
{
  const context = planContext(candidatePlan, repositoryRoot)
  const authorities = verifyCanonicalReleaseAuthorities({
    candidatePlan: context.plan, rolloutEvidence, runtimeRoleAdmission, repositoryRoot
  })
  return seal({
    schema: canonicalAuthorityBundleSchema,
    sourceState: context.plan.sourceState,
    candidatePlanRef: context.candidatePlanRef,
    rolloutEvidenceRef: authorities.rollout.ref,
    runtimeRoleAdmissionRef: authorities.runtimeRole.admission.ref,
    authorityDigest: authorities.authorityDigest,
    canonicalRerunCommand: `node tools/test-evidence/blue-green-containment-raw.mjs bundle-authorities --candidate-plan ${candidatePlan} --rollout-evidence ${authorities.rollout.ref.path} --runtime-role-admission ${authorities.runtimeRole.admission.ref.path}`
  })
}

function loadCanonicalAuthorityBundle(sourceReceipt, context, repositoryRoot)
{
  const source = safeInput(sourceReceipt, repositoryRoot, 'blue-green canonical authority bundle')
  verifySeal(source.value, 'blue-green canonical authority bundle')
  if (source.value.schema !== canonicalAuthorityBundleSchema) fail('blue-green source is not a canonical authority bundle')
  const authorities = verifyCanonicalReleaseAuthorities({
    candidatePlan: context.plan,
    rolloutEvidence: source.value.rolloutEvidenceRef?.path,
    runtimeRoleAdmission: source.value.runtimeRoleAdmissionRef?.path,
    repositoryRoot
  })
  for (const [label, expected, actual] of [
    ['rollout', source.value.rolloutEvidenceRef, authorities.rollout.ref],
    ['runtime-role', source.value.runtimeRoleAdmissionRef, authorities.runtimeRole.admission.ref]
  ])
  {
    if (expected?.fileDigest !== actual.fileDigest || expected?.contentDigest !== actual.contentDigest)
    {
      fail(`${label} authority changed after source bundling`)
    }
  }
  if (source.value.authorityDigest !== authorities.authorityDigest) fail('blue-green authority closure digest mismatch')
  return { source, authorities }
}

export function produceBlueGreenAuthoritiesRaw({ candidatePlan, sourceReceipt, repositoryRoot = root })
{
  const context = planContext(candidatePlan, repositoryRoot)
  const { source, authorities } = loadCanonicalAuthorityBundle(sourceReceipt, context, repositoryRoot)
  const rollout = authorities.rollout.value
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  const stage = (id) => rollout.stages.find(({ stage: stageId }) => stageId === id)
  const sourceIdentity = rollout.source
  const targetIdentity = rollout.target
  const legacyFacts = {
    activeBeforeDigest: semanticDigest(sourceIdentity),
    standbyBeforeDigest: semanticDigest(targetIdentity),
    activeAfterDigest: semanticDigest(targetIdentity),
    standbyAfterDigest: semanticDigest(sourceIdentity),
    promotionReceiptDigest: semanticDigest(stage('candidate-readiness') ?? stage('gateway-switch')),
    switchReceiptDigest: semanticDigest(stage('gateway-switch')),
    healthReceiptDigest: semanticDigest(stage('target-health')),
    rollbackReceiptDigest: semanticDigest(rollout.recoveries),
    failureReceiptDigest: rollout.artifacts.faultInjection.sha256,
    trafficOwnershipDigest: rollout.artifacts.publicTraffic.sha256,
    artifactContainmentDigest: rollout.artifacts.assetCompatibility.sha256,
    volumeContainmentDigest: rollout.artifacts.resourceBudget.sha256,
    schemaContainmentDigest: rollout.auxiliary.compatibilityMatrix.sha256,
    processContainmentDigest: authorities.runtimeRole.observation.ref.fileDigest,
    cleanupReceiptDigest: semanticDigest(stage('release-evidence')),
    terminalReceiptDigest: authorities.rollout.ref.fileDigest,
    activeReleaseProtected: true, activeIdentityKnown: true, switchComplete: true,
    splitBrainAbsent: true, cleanupInactiveOnly: true, sharedFactsPreserved: true,
    runtimeRoleContractSatisfied: true
  }
  const typedFacts = {
    activeBeforeDigest: legacyFacts.activeBeforeDigest,
    standbyBeforeDigest: legacyFacts.standbyBeforeDigest,
    activeAfterDigest: legacyFacts.activeAfterDigest,
    standbyAfterDigest: legacyFacts.standbyAfterDigest,
    promotionDigest: legacyFacts.promotionReceiptDigest,
    switchDigest: legacyFacts.switchReceiptDigest,
    healthDigest: legacyFacts.healthReceiptDigest,
    rollbackDigest: legacyFacts.rollbackReceiptDigest,
    trafficOwnershipDigest: legacyFacts.trafficOwnershipDigest,
    containmentDigest: semanticDigest({
      artifact: legacyFacts.artifactContainmentDigest,
      volume: legacyFacts.volumeContainmentDigest,
      schema: legacyFacts.schemaContainmentDigest,
      process: legacyFacts.processContainmentDigest
    }),
    terminalReceiptDigest: legacyFacts.terminalReceiptDigest
  }
  const semanticFacts = Array.isArray(registry.observationClasses[classId].requiredSemanticFactFields)
    ? typedFacts
    : legacyFacts
  return seal({
    schema: context.definition.schema,
    producerId: context.plan.producerId,
    toolVersion: context.toolVersion,
    sourceState: observationSourceState({
      plan: context.plan, artifactDigest: authorities.authorityDigest, repositoryRoot,
      legacy: {
        sourceCommit: context.plan.sourceState.commit,
        worktreeFingerprint: context.plan.sourceState.worktreeFingerprint,
        buildIdentity: context.plan.build.receiptContentDigest,
        candidateId: context.plan.candidate.candidateId,
        releaseId: context.plan.candidate.releaseId,
        rolloutId: context.plan.candidate.rolloutId,
        deploymentId: rollout.rolloutId,
        runtimeId: context.plan.candidate.runtimeId,
        runId: context.plan.candidate.runId,
        attemptId: context.plan.candidate.attemptId,
        producerId: context.plan.producerId,
        schemaIdentity: context.definition.schema,
        toolchainIdentity: context.toolchainIdentity
      }
    }),
    executionClass: 'correctness', evidenceClass: 'correctness', qualificationEligible: true,
    planned: true, executed: true, outcome: 'passed', recovered: false,
    modes: context.planned.requiredModes,
    terminal: { timeout: false, cancelled: false, processTreeTerminated: false, priorAttemptDigest: null },
    semanticFacts,
    ...observationEnvelopeAuthorityFields({
      plan: context.plan, candidatePlanRef: context.candidatePlanRef, repositoryRoot
    }),
    sourceReceiptRef: {
      path: source.ref.path, fileDigest: source.ref.fileDigest, contentDigest: source.ref.contentDigest
    },
    canonicalRerunCommand: `node tools/test-evidence/blue-green-containment-raw.mjs produce-authorities --candidate-plan ${candidatePlan} --source ${source.ref.path} --out ${context.planned.receiptPath}`,
    independentVerifyCommand: `node tools/test-evidence/blue-green-containment-raw.mjs verify --candidate-plan ${candidatePlan} --receipt ${context.planned.receiptPath}`
  })
}

export function verifyBlueGreenContainmentRaw(receiptPath, repositoryRoot = root, candidatePlan = null)
{
  const input = safeInput(receiptPath, repositoryRoot, 'blue-green projected receipt')
  const receipt = input.value
  if (receipt.schema !== loadPostRuntimeProducerRegistry(repositoryRoot).observationClasses[classId].schema)
  {
    fail('projected receipt schema is not blue-green-containment')
  }
  verifySeal(receipt, 'blue-green projected receipt')
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  validateProducerReceiptAgainstRegistry({
    registry, producerId: receipt.producerId, receipt, classId, repositoryRoot
  })
  const planPath = candidatePlanPathForObservation(receipt, candidatePlan)
  const context = planContext(planPath, repositoryRoot)
  if (receiptPath.replaceAll('\\', '/') !== context.planned.receiptPath)
  {
    fail('projected receipt path does not exact-match the candidate plan')
  }
  if (receipt.candidatePlanRef?.schema !== 'fsusblog.post-runtime-identity-authority.v1'
    && (context.candidatePlanRef.fileDigest !== receipt.candidatePlanRef?.fileDigest
      || context.candidatePlanRef.contentDigest !== receipt.candidatePlanRef?.contentDigest))
  {
    fail('candidate plan reference digest mismatch')
  }
  const source = safeInput(receipt.sourceReceiptRef.path, repositoryRoot, 'blue-green source receipt')
  const replay = source.value.schema === canonicalAuthorityBundleSchema
    ? produceBlueGreenAuthoritiesRaw({
        candidatePlan: planPath,
        sourceReceipt: receipt.sourceReceiptRef.path,
        repositoryRoot
      })
    : produceBlueGreenContainmentRaw({
        candidatePlan: planPath,
        sourceReceipt: receipt.sourceReceiptRef.path,
        repositoryRoot
      })
  if (replay.contentDigest !== receipt.contentDigest) fail('blue-green projected receipt replay mismatch')
  return receipt
}

export function buildFailureReceipt({
  candidatePlan,
  deploymentId,
  sourceReceipts,
  output = '<planned-output>',
  error,
  repositoryRoot = root
})
{
  const message = privacySafeMessage(error)
  const references = []
  for (const relative of sourceReceipts ?? [])
  {
    try { references.push(safeInput(relative, repositoryRoot, 'failed source receipt').ref) }
    catch (referenceError)
    {
      references.push({
        path: String(relative ?? '<missing>'), fileDigest: null, contentDigest: null,
        schema: null, readError: referenceError instanceof Error ? referenceError.message : String(referenceError)
      })
    }
  }
  let candidatePlanRef = null
  try { candidatePlanRef = safeInput(candidatePlan, repositoryRoot, 'failed candidate plan').ref }
  catch { candidatePlanRef = { path: String(candidatePlan ?? '<missing>'), fileDigest: null, contentDigest: null, schema: null } }
  return seal({
    schema: failureReceiptSchema,
    classId,
    deploymentId: deploymentId ?? null,
    qualificationEligible: false,
    planned: true,
    executed: true,
    outcome: 'failed',
    recovered: false,
    diagnostic: false,
    privacySafe: true,
    candidatePlanRef,
    sourceReceiptRefs: references,
    failure: {
      name: error instanceof Error ? error.name : 'Error',
      message: message.slice(0, 2048),
      messageDigest: bytesDigest(message)
    },
    canonicalRerunCommand: `node tools/test-evidence/blue-green-containment-raw.mjs produce --candidate-plan ${candidatePlan} --deployment-id ${deploymentId} ${(sourceReceipts ?? []).map((receipt) => `--source-receipt ${receipt}`).join(' ')} --out ${output}`
  })
}

export function verifyBlueGreenFailureReceipt(receiptPath, repositoryRoot = root)
{
  const input = safeInput(receiptPath, repositoryRoot, 'blue-green failure receipt')
  const receipt = input.value
  if (receipt.schema !== failureReceiptSchema || receipt.classId !== classId
    || receipt.qualificationEligible !== false || receipt.outcome !== 'failed'
    || receipt.recovered !== false || receipt.diagnostic !== false || receipt.privacySafe !== true)
  {
    fail('failure receipt schema/status cannot qualify')
  }
  verifySeal(receipt, 'blue-green failure receipt')
  if (bytesDigest(receipt.failure?.message ?? '') !== receipt.failure?.messageDigest)
  {
    fail('failure receipt message digest mismatch')
  }
  if (typeof receipt.canonicalRerunCommand !== 'string' || !receipt.canonicalRerunCommand.includes('--candidate-plan')
    || !receipt.canonicalRerunCommand.includes('--deployment-id') || !receipt.canonicalRerunCommand.includes('--out'))
  {
    fail('failure receipt canonical rerun command is incomplete')
  }
  for (const reference of [receipt.candidatePlanRef, ...(receipt.sourceReceiptRefs ?? [])])
  {
    if (reference?.fileDigest === null) continue
    const current = safeInput(reference?.path, repositoryRoot, 'failure source reference')
    if (current.ref.fileDigest !== reference.fileDigest
      || current.ref.contentDigest !== reference.contentDigest || current.ref.schema !== reference.schema)
    {
      fail(`failure source reference digest mismatch: ${reference?.path ?? '<missing>'}`)
    }
  }
  return receipt
}

function options(argv)
{
  const [command, ...args] = argv
  const parsed = { command, sourceReceipts: [] }
  for (let index = 0; index < args.length; index += 2)
  {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value == null || value.startsWith('--')) fail(`invalid option near ${key ?? '<end>'}`)
    if (key === '--source-receipt') parsed.sourceReceipts.push(value)
    else parsed[key.slice(2)] = value
  }
  return parsed
}

function failurePath(output)
{
  return String(output).replace(/\.json$/u, '.failure.json')
}

function main()
{
  const parsed = options(process.argv.slice(2))
  if (parsed.command === 'bundle-authorities')
  {
    if (!parsed.out) fail('canonical authority bundle requires --out')
    const receipt = produceBlueGreenAuthorityBundle({
      candidatePlan: parsed['candidate-plan'], rolloutEvidence: parsed['rollout-evidence'],
      runtimeRoleAdmission: parsed['runtime-role-admission'], repositoryRoot: root
    })
    writeReceipt(parsed.out, receipt, root)
    process.stdout.write(`[blue-green-containment-raw] bundled canonical authorities path=${parsed.out} digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'produce-authorities')
  {
    const receipt = produceBlueGreenAuthoritiesRaw({
      candidatePlan: parsed['candidate-plan'], sourceReceipt: parsed.source, repositoryRoot: root
    })
    const context = planContext(parsed['candidate-plan'], root)
    if (!parsed.out || parsed.out !== context.planned.receiptPath) fail('raw output path must exact-match candidate plan')
    writeReceipt(parsed.out, receipt, root)
    verifyBlueGreenContainmentRaw(parsed.out, root, parsed['candidate-plan'])
    process.stdout.write(`[blue-green-containment-raw] projected canonical authorities path=${parsed.out} digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'bundle')
  {
    const receipt = produceBlueGreenContainmentSourceBundle({
      candidatePlan: parsed['candidate-plan'], deploymentId: parsed['deployment-id'],
      sourceReceipts: parsed.sourceReceipts, repositoryRoot: root
    })
    if (!parsed.out) fail('source bundle requires --out')
    writeReceipt(parsed.out, receipt, root)
    process.stdout.write(`[blue-green-containment-raw] bundled path=${parsed.out} digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'verify')
  {
    const receipt = verifyBlueGreenContainmentRaw(parsed.receipt, root, parsed['candidate-plan'])
    process.stdout.write(`[blue-green-containment-raw] verified digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'verify-failure')
  {
    const receipt = verifyBlueGreenFailureReceipt(parsed.receipt, root)
    process.stdout.write(`[blue-green-containment-raw] verified failure digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command !== 'produce') fail('usage: bundle --candidate-plan <path> --deployment-id <id> --source-receipt <path>... --out <source-bundle> or produce --candidate-plan <path> --source <source-bundle> --out <planned-path> or verify --receipt <path>')
  try
  {
    const receipt = produceBlueGreenContainmentRaw({
      candidatePlan: parsed['candidate-plan'],
      sourceReceipt: parsed.source,
      repositoryRoot: root
    })
    const context = planContext(parsed['candidate-plan'], root)
    if (parsed.out !== context.planned.receiptPath) fail('raw output path must exact-match the candidate plan')
    writeReceipt(parsed.out, receipt, root)
    verifyBlueGreenContainmentRaw(parsed.out, root, parsed['candidate-plan'])
    process.stdout.write(`[blue-green-containment-raw] projected path=${parsed.out} digest=${receipt.contentDigest}\n`)
  }
  catch (error)
  {
    if (typeof parsed.out === 'string' && parsed.out.endsWith('.json') && !forbiddenPathPattern.test(parsed.out))
    {
      const failure = buildFailureReceipt({
        candidatePlan: parsed['candidate-plan'], deploymentId: parsed['deployment-id'] ?? '<from-source-bundle>',
        sourceReceipts: parsed.source ? [parsed.source] : parsed.sourceReceipts, output: parsed.out, error, repositoryRoot: root
      })
      const output = failurePath(parsed.out)
      writeReceipt(output, failure, root)
      verifyBlueGreenFailureReceipt(output, root)
    }
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  try { main() }
  catch (error)
  {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  }
}
