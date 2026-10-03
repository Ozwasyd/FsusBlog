#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { digestCatalog, validateCatalog } from '../contracts/behavior-contract-catalog.mjs'
import { validatePostRuntimeAcceptedClaimsValue } from '../docs/post-runtime-accepted-claims.mjs'
import { validateApplicationRuntimeObservation } from '../fact-extractors/post-runtime/application-runtime.mjs'
import { validateReleaseDeploymentObservation } from '../fact-extractors/post-runtime/release-deployment.mjs'
import { digestValue, isPlainObject, stable } from '../fact-extractors/lib/canonicalize.mjs'
import { assertPreRuntimeQualified } from './behavior-evidence-pre-runtime.mjs'
import {
  requiredObservationClasses,
  validatePostRuntimeProducerRegistry
} from './post-runtime-producer-registry.mjs'
import {
  schedulerTierAdmissionActivity,
  schedulerTierAdmissionSchema
} from './scheduler-run-owner.mjs'
import { validateJsonSchema } from './schema-validator/validate.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const postRuntimeReceiptSchema = 'fsusblog.behavior-evidence-post-runtime-receipt.v2'

const observationReceiptSchema = 'fsusblog.post-runtime-observation-receipt.v2'
const acceptedClaimsSchema = 'fsusblog.post-runtime-accepted-claims.v1'
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const unsafePathPattern = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu
const requiredScopes = Object.freeze(['application', 'release-deployment'])
const graphCache = new Map()

function fail(message)
{
  throw new Error(`[behavior-evidence-post-runtime] ${message}`)
}

const prefixedDigest = (value) => `sha256:${String(value ?? '').replace(/^sha256:/u, '')}`
const sameValue = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right))
const sameSet = (left, right) => [...left].sort().join('\0') === [...right].sort().join('\0')
const sortedUnique = (values) => [...new Set(values)].sort()
const exactSet = (actual, expected) => Array.isArray(actual)
  && new Set(actual).size === actual.length && sameSet(actual, expected)
const sealedDigest = (value) => `sha256:${digestValue(
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contentDigest'))
)}`

function canonicalRelativeJson(input, label, repositoryRoot)
{
  if (typeof input !== 'string' || input.length === 0 || !input.endsWith('.json')
    || input.includes('\\') || unsafePathPattern.test(input))
  {
    fail(`${label} must be an explicit canonical current-run JSON path`)
  }
  const repository = path.resolve(repositoryRoot)
  const absolute = path.resolve(repository, input)
  if (absolute === repository || !absolute.startsWith(`${repository}${path.sep}`))
  {
    fail(`${label} escapes the repository`)
  }
  const relative = path.relative(repository, absolute).replaceAll(path.sep, '/')
  if (path.posix.normalize(relative) !== relative
    || relative.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
  {
    fail(`${label} must be an explicit canonical current-run JSON path`)
  }
  return { repository, absolute, relative }
}

function readCurrentJson(input, label, repositoryRoot = root)
{
  const { repository, absolute, relative } = canonicalRelativeJson(input, label, repositoryRoot)
  if (fs.realpathSync.native(repository) !== repository) fail(`${label} repository root is not canonical`)
  const rootStat = fs.lstatSync(repository)
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || fs.realpathSync.native(absolute) !== absolute)
  {
    fail(`${label} must be a regular non-symlink single-link current-run file`)
  }
  let descriptor
  try
  {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const before = fs.fstatSync(descriptor, { bigint: true })
    const bytes = fs.readFileSync(descriptor)
    const after = fs.fstatSync(descriptor, { bigint: true })
    const current = fs.lstatSync(absolute, { bigint: true })
    for (const field of ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'])
    {
      if (before[field] !== after[field] || after[field] !== current[field])
      {
        fail(`${label} changed while being read`)
      }
    }
    return {
      value: JSON.parse(bytes.toString('utf8')),
      path: relative,
      fileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    }
  }
  finally
  {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function readReference(reference, label, repositoryRoot)
{
  if (!isPlainObject(reference)
    || !digestPattern.test(String(reference.fileDigest ?? ''))
    || !digestPattern.test(String(reference.contentDigest ?? '')))
  {
    fail(`${label} reference is incomplete`)
  }
  const input = readCurrentJson(reference.path, label, repositoryRoot)
  if (input.fileDigest !== reference.fileDigest
    || prefixedDigest(input.value?.contentDigest) !== prefixedDigest(reference.contentDigest)
    || (reference.schema != null && input.value?.schema !== reference.schema))
  {
    fail(`${label} reference bytes, schema, or content identity changed`)
  }
  return input
}

function requiredGraph(catalog, registry, repositoryRoot)
{
  const cacheKey = `${path.resolve(repositoryRoot)}\0${digestValue(catalog)}\0${digestValue(registry)}`
  const cached = graphCache.get(cacheKey)
  if (cached) return cached
  validateCatalog(catalog, repositoryRoot)
  validatePostRuntimeProducerRegistry(registry, { catalog, repositoryRoot })
  const contracts = catalog.contracts
    .filter((contract) => contract.status === 'active'
      && contract.releaseQualification === true
      && contract.evidenceStage === 'post-runtime')
    .sort((left, right) => left.id.localeCompare(right.id))
  const producers = [...registry.producers].sort((left, right) =>
    left.producerId.localeCompare(right.producerId))
  if (!sameSet(contracts.map(({ id }) => id), producers.map(({ behaviorId }) => behaviorId)))
  {
    fail('catalog and registry post-runtime behavior ownership differs')
  }
  const contractByBehavior = new Map(contracts.map((contract) => [contract.id, contract]))
  const classOwner = new Map()
  const claimOwner = new Map()
  for (const producer of producers)
  {
    const contract = contractByBehavior.get(producer.behaviorId)
    if (!contract
      || contract.runtimeEvidence?.producerTierId !== producer.producerTierId
      || contract.runtimeEvidence?.observationSchema !== producer.observationSchema)
    {
      fail(`producer ${producer.producerId} does not exact-match its BehaviorCatalog authority`)
    }
    for (const classId of sortedUnique(Object.values(producer.requiredObservations).flat()))
    {
      if (classOwner.has(classId)) fail(`observation class ${classId} has multiple producers`)
      classOwner.set(classId, producer.producerId)
    }
    for (const claimId of producer.acceptedClaimRefs)
    {
      if (claimOwner.has(claimId)) fail(`accepted claim ${claimId} has multiple producers`)
      claimOwner.set(claimId, producer.producerId)
    }
  }
  if (!sameSet([...classOwner.keys()], Object.keys(registry.observationClasses)))
  {
    fail('producer class union does not exact-match all registry observation classes')
  }
  const graph = {
    contracts,
    producers,
    contractByBehavior,
    producerById: new Map(producers.map((producer) => [producer.producerId, producer])),
    classOwner,
    claimOwner
  }
  graphCache.set(cacheKey, graph)
  return graph
}

function observationReference(input)
{
  return {
    scope: input.value.scope,
    producerId: input.value.producerId,
    path: input.path,
    fileDigest: input.fileDigest,
    contentDigest: prefixedDigest(input.value.contentDigest)
  }
}

function scopedClassClosure(graph, registry)
{
  return graph.producers.flatMap((producer) => requiredScopes.flatMap((scope) =>
  {
    const classes = requiredObservationClasses(registry, producer, scope)
    return classes.length === 0 ? [] : [{ producer, scope, classes }]
  }))
}

function validateAggregateObservations({ observations, graph, registry, preRuntimeReceipt })
{
  const closure = scopedClassClosure(graph, registry)
  const key = ({ producerId, scope }) => `${producerId}\0${scope}`
  if (!Array.isArray(observations) || observations.length === 0
    || !exactSet(observations.map(key), closure.map(({ producer, scope }) =>
      key({ producerId: producer.producerId, scope }))))
  {
    fail('aggregate observation producer/scope closure must be exact-one')
  }
  if (!sameSet(sortedUnique(closure.map(({ scope }) => scope)), requiredScopes))
  {
    fail('application and release-deployment observation receipts are both required')
  }
  const first = observations[0]
  const identityFields = [
    'sourceState', 'candidate', 'build', 'buildReceiptDigest', 'preRuntimeReceiptDigest'
  ]
  const producerFields = [
    'behaviorId', 'producerId', 'candidatePlanDigest', 'candidatePlanRef',
    'acceptedClaimsReceiptDigest', 'acceptedClaimsReceiptRef', 'acceptedClaimRefs'
  ]
  const aggregatesByProducer = new Map()
  for (const receipt of observations)
  {
    if (receipt.schema !== observationReceiptSchema || receipt.status !== 'qualified'
      || !Array.isArray(receipt.failureReasons) || receipt.failureReasons.length !== 0)
    {
      fail(`${receipt.scope ?? 'unknown'} observation receipt is not qualified`)
    }
    const producer = graph.producerById.get(receipt.producerId)
    if (!producer || producer.behaviorId !== receipt.behaviorId)
    {
      fail(`${receipt.scope} observation owner does not exact-match the registry`)
    }
    if (prefixedDigest(receipt.preRuntimeReceiptDigest)
      !== prefixedDigest(preRuntimeReceipt.contentDigest))
    {
      fail(`${receipt.scope} observation does not bind the current pre-runtime receipt`)
    }
    for (const field of identityFields)
    {
      if (!sameValue(receipt[field], first[field]))
      {
        fail(`${receipt.scope} observation ${field} differs across current-candidate scopes`)
      }
    }
    const producerFirst = aggregatesByProducer.get(producer.producerId)
    if (producerFirst)
    {
      for (const field of producerFields)
      {
        if (!sameValue(receipt[field], producerFirst[field]))
          fail(`${producer.producerId} observation ${field} differs across owned scopes`)
      }
    }
    else aggregatesByProducer.set(producer.producerId, receipt)
    const expectedClasses = requiredObservationClasses(registry, producer, receipt.scope)
    const observedClasses = receipt.observations?.map(({ classId }) => classId) ?? []
    if (!exactSet(receipt.requiredClasses, expectedClasses)
      || !exactSet(receipt.observedClasses, expectedClasses)
      || !exactSet(observedClasses, expectedClasses)
      || !exactSet(receipt.acceptedClaimRefs, producer.acceptedClaimRefs))
    {
      fail(`${producer.producerId}/${receipt.scope} observation class/claim closure is not exact-one`)
    }
    for (const observation of receipt.observations)
    {
      const expectedModes = Object.entries(producer.requiredObservations)
        .filter(([, classes]) => classes.includes(observation.classId)).map(([mode]) => mode)
      if (graph.classOwner.get(observation.classId) !== producer.producerId
        || !exactSet(observation.modes, expectedModes)
        || prefixedDigest(observation.receiptDigest) !== observation.classReceiptRef?.contentDigest)
      {
        fail(`${observation.classId} proof does not belong to its scoped producer`)
      }
    }
  }
  const classEntries = observations.flatMap((receipt) =>
    receipt.observations.map((observation) => ({
      ...observation, scope: receipt.scope, producerId: receipt.producerId, behaviorId: receipt.behaviorId
    })))
  if (!exactSet(classEntries.map(({ classId }) => classId), [...graph.classOwner.keys()]))
  {
    fail('joined observation classes do not exact-match the current registry')
  }
  return { closure, aggregatesByProducer, classEntries }
}

function validateClaims({ receipt, reference, producer, aggregate, candidateContext, repositoryRoot })
{
  if (receipt.schema !== acceptedClaimsSchema || receipt.status !== 'accepted'
    || receipt.producerId !== producer.producerId)
  {
    fail('accepted claims receipt does not belong to the current producer')
  }
  if (!sameValue(reference, Object.fromEntries(Object.entries(
    aggregate.acceptedClaimsReceiptRef ?? {}).filter(([field]) => field !== 'schema')))
    || prefixedDigest(receipt.contentDigest) !== reference?.contentDigest
    || prefixedDigest(aggregate.acceptedClaimsReceiptDigest) !== reference.contentDigest)
  {
    fail('accepted claims reference does not bind its producer aggregate')
  }
  validatePostRuntimeAcceptedClaimsValue({
    receipt,
    expectedRunId: aggregate.candidate.runId,
    producerId: producer.producerId,
    repositoryRoot
  })
  const expectedCandidateIdentityDigest = `sha256:${digestValue({
    id: aggregate.candidate.candidateId,
    digest: prefixedDigest(candidateContext.contentDigest)
  })}`
  const expectedBuildIdentityDigest = `sha256:${digestValue({
    id: `${aggregate.candidate.runId}:build`,
    digest: prefixedDigest(aggregate.buildReceiptDigest)
  })}`
  const expectedSourceState = {
    commit: aggregate.sourceState.commit,
    worktreeFingerprint: prefixedDigest(aggregate.sourceState.worktreeFingerprint),
    schedulerRunId: aggregate.candidate.runId,
    attemptId: aggregate.candidate.attemptId,
    candidateIdentityDigest: expectedCandidateIdentityDigest,
    buildIdentityDigest: expectedBuildIdentityDigest
  }
  if (!sameValue(receipt.sourceState, expectedSourceState))
  {
    fail('accepted claims do not exact-match the current candidate/build identity')
  }
  if (!sameSet(receipt.claims.map(({ claimId }) => claimId), producer.acceptedClaimRefs))
  {
    fail('accepted claims do not exact-match the registry claim closure')
  }
  return expectedSourceState
}

export function validatePostRuntimeSchedulerEvidence({
  admission,
  reference,
  preRuntimeReceipt,
  repositoryRoot = root
})
{
  if (admission?.schema !== schedulerTierAdmissionSchema
    || admission.status !== 'admitted' || admission.mode !== 'fresh'
    || admission.currentTierId !== 'behavior-evidence-post-runtime'
    || admission.targetTierId !== 'release-final'
    || admission.runId !== preRuntimeReceipt.runIdentity
    || admission.sourceState?.commit !== preRuntimeReceipt.sourceIdentity.commit
    || prefixedDigest(admission.sourceState?.worktreeFingerprint)
      !== prefixedDigest(preRuntimeReceipt.sourceIdentity.worktreeFingerprint))
  {
    fail('scheduler admission run/source/tier identity is invalid')
  }
  if (admission.releaseFinalSpawnCountBeforeAdmission !== 0
    || admission.activeTierIds?.includes('release-final'))
  {
    fail('release-final was spawned before the post-runtime receipt')
  }
  const expectedPath = `.tmp/test-runs/${admission.runId}/scheduler-admissions/`
    + `${admission.schedulerOwnerToken}-${admission.admissionSequence}-`
    + `${admission.currentTierId}.json`
  if (reference.path !== expectedPath) fail('scheduler admission path identity is invalid')
  const activity = schedulerTierAdmissionActivity({
    runsRoot: path.join(path.resolve(repositoryRoot), '.tmp/test-runs'),
    admission,
    reference: {
      schema: admission.schema,
      ref: reference.path,
      fileDigest: reference.fileDigest,
      contentDigest: admission.contentDigest,
      currentTierId: admission.currentTierId,
      admissionSequence: admission.admissionSequence
    }
  })
  if (activity.status !== 'active')
  {
    fail(`scheduler admission is not live and exact: ${activity.status}:${activity.reason}`)
  }
  return admission
}

// Join arithmetic over already verified inputs is not native observation
// authority. Qualification consumers must use the persisted-input replay entry
// below; it invokes the original scope/class/raw receipt verifiers.
export function joinVerifiedPostRuntimeObservations({
  preRuntimeReceipt,
  catalog,
  registry,
  observations,
  observationReferences,
  acceptedClaims,
  acceptedClaimsReferences,
  candidateContext,
  schedulerAdmission,
  schedulerReference,
  repositoryRoot = root
})
{
  const pre = assertPreRuntimeQualified(structuredClone(preRuntimeReceipt))
  const graph = requiredGraph(catalog, registry, repositoryRoot)
  if (prefixedDigest(pre.catalogDigest) !== `sha256:${digestCatalog(catalog)}`)
  {
    fail('pre-runtime receipt catalog digest does not match the current BehaviorCatalog')
  }
  const aggregate = validateAggregateObservations({
    observations,
    graph,
    registry,
    preRuntimeReceipt: pre
  })
  const first = observations[0]
  const observationKey = ({ producerId, scope }) => `${producerId}\0${scope}`
  if (!Array.isArray(observationReferences)
    || !exactSet(observationReferences.map(observationKey), observations.map(observationKey)))
    fail('observation reference producer/scope closure must be exact-one')
  for (const observation of observations)
  {
    const reference = observationReferences.find((entry) =>
      observationKey(entry) === observationKey(observation))
    if (reference.contentDigest !== prefixedDigest(observation.contentDigest)
      || observation.contentDigest !== sealedDigest(observation))
      fail('observation reference does not bind its exact producer aggregate')
  }
  if (candidateContext?.schema !== 'fsusblog.post-runtime-candidate-context.v1'
    || !sameValue(candidateContext.sourceState, first.sourceState)
    || !sameValue(candidateContext.candidate, first.candidate)
    || !sameValue(first.sourceState, pre.sourceIdentity)
    || first.candidate.runId !== pre.runIdentity
    || prefixedDigest(candidateContext.preRuntimeReceiptRef?.contentDigest) !== pre.contentDigest)
  {
    fail('candidate context does not exact-match observation candidate identity')
  }
  if (!Array.isArray(acceptedClaims)
    || !exactSet(acceptedClaims.map(({ producerId }) => producerId), [...graph.producerById.keys()])
    || !isPlainObject(acceptedClaimsReferences)
    || !exactSet(Object.keys(acceptedClaimsReferences), [...graph.producerById.keys()]))
  {
    fail('accepted claims producer closure must be exact-one')
  }
  const executionIdentities = acceptedClaims.map((claims) => validateClaims({
    receipt: claims,
    reference: acceptedClaimsReferences[claims.producerId],
    producer: graph.producerById.get(claims.producerId),
    aggregate: aggregate.aggregatesByProducer.get(claims.producerId),
    candidateContext,
    repositoryRoot
  }))
  const executionIdentity = executionIdentities[0]
  if (executionIdentities.some((identity) => !sameValue(identity, executionIdentity)))
    fail('accepted claims execution identities differ across current producers')
  const terminalDigests = acceptedClaims.map((claims) =>
    prefixedDigest(claims.terminalReceiptRef.payloadContentDigest))
  if (new Set(terminalDigests).size !== 1)
    fail('accepted claims do not bind one original global document terminal')
  validatePostRuntimeSchedulerEvidence({
    admission: schedulerAdmission,
    reference: schedulerReference,
    preRuntimeReceipt: pre,
    repositoryRoot
  })
  if (schedulerAdmission.runId !== first.candidate.runId
    || acceptedClaims.some((claims) => schedulerAdmission.runId !== claims.sourceState.schedulerRunId))
  {
    fail('scheduler, candidate, and accepted claims run identities differ')
  }
  const behaviorIds = graph.contracts.map(({ id }) => id)
  const requiredProducerClasses = Object.fromEntries(graph.producers.map((producer) => [
    producer.producerId,
    sortedUnique(Object.values(producer.requiredObservations).flat())
  ]))
  const observedProducerClasses = Object.fromEntries(graph.producers.map((producer) => [
    producer.producerId,
    aggregate.classEntries
      .filter((observation) => producer.producerId === observation.producerId)
      .map(({ classId }) => classId)
      .sort()
  ]))
  const observedBehaviorResults = aggregate.classEntries
    .map((observation) => ({
      behaviorId: observation.behaviorId,
      extractorId: graph.contractByBehavior.get(observation.behaviorId).factExtractorId,
      producerId: observation.producerId,
      scope: observation.scope,
      classId: observation.classId,
      classReceiptPath: observation.classReceiptRef.path,
      classReceiptDigest: prefixedDigest(observation.receiptDigest),
      rawReceiptPath: observation.rawResultRef.path,
      rawReceiptDigest: prefixedDigest(observation.rawResultRef.contentDigest),
      semanticFactsDigest: `sha256:${digestValue(observation.semanticFacts)}`,
      status: 'ok'
    }))
    .sort((left, right) => left.classId.localeCompare(right.classId))
  const receipt = {
    schema: postRuntimeReceiptSchema,
    scope: 'post-runtime',
    runIdentity: pre.runIdentity,
    sourceIdentity: pre.sourceIdentity,
    candidateIdentity: {
      sourceCommit: first.sourceState.commit,
      worktreeFingerprint: prefixedDigest(first.sourceState.worktreeFingerprint),
      buildIdentity: prefixedDigest(first.buildReceiptDigest),
      ...stable(first.candidate)
    },
    executionIdentity,
    preRuntimeReceiptDigest: prefixedDigest(pre.contentDigest),
    staticClaimVerificationDigest: pre.staticClaimVerificationDigest == null
      ? null
      : prefixedDigest(pre.staticClaimVerificationDigest),
    catalogDigest: `sha256:${digestCatalog(catalog)}`,
    registryDigest: `sha256:${digestValue(registry)}`,
    behaviorIds,
    requiredRuntimeProducers: graph.producers.map(({ producerId }) => producerId),
    requiredObservationScopes: [...requiredScopes],
    requiredProducerClasses,
    observedProducerClasses,
    requiredProducerScopes: Object.fromEntries(graph.producers.map(({ producerId }) => [
      producerId, aggregate.closure.filter(({ producer }) => producer.producerId === producerId)
        .map(({ scope }) => scope).sort()
    ])),
    requiredProducerClaims: Object.fromEntries(graph.producers.map((producer) => [
      producer.producerId, [...producer.acceptedClaimRefs].sort()
    ])),
    observedProducerClaims: Object.fromEntries(acceptedClaims.map((claims) => [
      claims.producerId, claims.claims.map(({ claimId }) => claimId).sort()
    ])),
    observedBehaviorResults,
    observationRefs: [...observationReferences].sort((left, right) =>
      `${left.producerId}:${left.scope}`.localeCompare(`${right.producerId}:${right.scope}`)),
    acceptedClaimsRefs: acceptedClaimsReferences,
    documentClaimDigests: Object.fromEntries(acceptedClaims.flatMap((claims) =>
      claims.claims.map(({ claimId, claimDigest }) => [claimId, prefixedDigest(claimDigest)]))),
    documentClaimTerminalDigest: terminalDigests[0],
    schedulerEvidence: schedulerReference,
    missing: [],
    orphans: [],
    conflicts: [],
    stale: [],
    diagnostics: [],
    findingCounts: { missing: 0, orphans: 0, conflicts: 0, stale: 0, diagnostics: 0 },
    releaseFinalSpawnCountBeforeReceipt: schedulerAdmission.releaseFinalSpawnCountBeforeAdmission,
    status: 'ok',
    failureReasons: [],
    contentDigest: null
  }
  receipt.contentDigest = sealedDigest(receipt)
  return validatePostRuntimeReceipt(receipt)
}

export function joinBehaviorEvidencePostRuntime({
  preRuntimeReceipt,
  catalog = 'config/contracts/behavior-contracts.json',
  registry = 'config/testing/post-runtime-producer-registry.json',
  observationReceipts = [],
  schedulerEvidence,
  repositoryRoot = root,
  ...unsupported
} = {})
{
  if (Object.keys(unsupported).length > 0) fail('legacy or unknown join inputs are forbidden')
  if (!Array.isArray(observationReceipts) || observationReceipts.length === 0
    || new Set(observationReceipts).size !== observationReceipts.length)
  {
    fail('explicit unique aggregate observation receipt paths are required')
  }
  const preInput = readCurrentJson(preRuntimeReceipt, 'pre-runtime receipt', repositoryRoot)
  const catalogInput = readCurrentJson(catalog, 'BehaviorCatalog', repositoryRoot)
  const registryInput = readCurrentJson(registry, 'post-runtime producer registry', repositoryRoot)
  const observationInputs = observationReceipts.map((input, index) =>
    readCurrentJson(input, `aggregate observation ${index}`, repositoryRoot))
  const graph = requiredGraph(catalogInput.value, registryInput.value, repositoryRoot)
  const closure = scopedClassClosure(graph, registryInput.value)
  const expectedKeys = closure.map(({ producer, scope }) => `${producer.producerId}\0${scope}`)
  if (!exactSet(observationInputs.map(({ value }) => `${value.producerId}\0${value.scope}`), expectedKeys))
    fail('aggregate observation producer/scope closure must be exact-one')
  const byProducerScope = new Map()
  for (const input of observationInputs)
  {
    const key = `${input.value.producerId}\0${input.value.scope}`
    if (byProducerScope.has(key)) fail(`duplicate ${key} aggregate observation`)
    if (input.value.scope === 'application')
    {
      validateApplicationRuntimeObservation(input.value, { repositoryRoot })
    }
    else if (input.value.scope === 'release-deployment')
    {
      validateReleaseDeploymentObservation(input.value, { repositoryRoot })
    }
    else
    {
      fail(`unknown aggregate observation scope ${input.value.scope ?? 'missing'}`)
    }
    byProducerScope.set(key, input)
  }
  const claimsInputs = graph.producers.map((producer) =>
  {
    const aggregate = observationInputs.find(({ value }) => value.producerId === producer.producerId)
    return {
      producerId: producer.producerId,
      ...readReference(aggregate.value.acceptedClaimsReceiptRef, 'accepted claims receipt', repositoryRoot)
    }
  })
  const contextInputs = observationInputs.map(({ value }) =>
  {
    const plan = readReference(value.candidatePlanRef, 'candidate plan', repositoryRoot)
    return {
      reference: plan.value.candidateContextRef,
      ...readReference(plan.value.candidateContextRef, 'candidate context', repositoryRoot)
    }
  })
  const contextInput = contextInputs[0]
  if (contextInputs.some((input) => !sameValue(input.reference, contextInput.reference)
    || !sameValue(input.value, contextInput.value)))
    fail('producer plans do not bind one exact current candidate context')
  const schedulerInput = readCurrentJson(
    schedulerEvidence,
    'scheduler tier admission',
    repositoryRoot
  )
  return joinVerifiedPostRuntimeObservations({
    preRuntimeReceipt: preInput.value,
    catalog: catalogInput.value,
    registry: registryInput.value,
    observations: observationInputs.map(({ value }) => value),
    observationReferences: observationInputs.map(observationReference),
    acceptedClaims: claimsInputs.map(({ value }) => value),
    acceptedClaimsReferences: Object.fromEntries(claimsInputs.map((input) => [input.producerId, {
      path: input.path,
      fileDigest: input.fileDigest,
      contentDigest: prefixedDigest(input.value.contentDigest)
    }])),
    candidateContext: contextInput.value,
    schedulerAdmission: schedulerInput.value,
    schedulerReference: {
      path: schedulerInput.path,
      fileDigest: schedulerInput.fileDigest,
      contentDigest: prefixedDigest(schedulerInput.value.contentDigest)
    },
    repositoryRoot
  })
}

export function validatePostRuntimeReceipt(receipt)
{
  const schema = JSON.parse(fs.readFileSync(
    path.join(root, 'config/schemas/behavior-evidence-post-runtime-receipt.schema.json'),
    'utf8'
  ))
  const schemaErrors = validateJsonSchema(receipt, schema)
  if (schemaErrors.length > 0) fail(`receipt schema validation failed: ${schemaErrors.join('; ')}`)
  if (receipt.contentDigest !== sealedDigest(receipt)) fail('receipt contentDigest mismatch')
  if (receipt.releaseFinalSpawnCountBeforeReceipt !== 0)
  {
    fail('releaseFinalSpawnCountBeforeReceipt must be 0')
  }
  if (receipt.status !== 'ok' || receipt.failureReasons.length !== 0)
  {
    fail('qualified post-runtime receipt must have status=ok and no failures')
  }
  for (const category of ['missing', 'orphans', 'conflicts', 'stale', 'diagnostics'])
  {
    if (receipt.findingCounts[category] !== receipt[category].length)
    {
      fail('receipt finding counts do not exact-match categorized findings')
    }
  }
  const resultsByProducer = new Map()
  for (const result of receipt.observedBehaviorResults)
  {
    const values = resultsByProducer.get(result.producerId) ?? []
    values.push(result.classId)
    resultsByProducer.set(result.producerId, values)
  }
  for (const values of [receipt.requiredProducerClasses, receipt.observedProducerClasses,
    receipt.requiredProducerScopes, receipt.requiredProducerClaims, receipt.observedProducerClaims,
    receipt.acceptedClaimsRefs])
  {
    if (!exactSet(Object.keys(values), receipt.requiredRuntimeProducers))
      fail('receipt producer maps do not exact-match required producers')
  }
  const globalClasses = Object.values(receipt.requiredProducerClasses).flat()
  const globalClaims = Object.values(receipt.requiredProducerClaims).flat()
  if (!exactSet(globalClasses, receipt.observedBehaviorResults.map(({ classId }) => classId))
    || !exactSet(globalClaims, Object.keys(receipt.documentClaimDigests)))
    fail('receipt global class/claim union is missing, duplicate, or extra')
  for (const producerId of receipt.requiredRuntimeProducers)
  {
    if (!exactSet(receipt.requiredProducerClasses[producerId],
      receipt.observedProducerClasses[producerId])
      || !exactSet(receipt.observedProducerClasses[producerId],
        resultsByProducer.get(producerId) ?? []))
    {
      fail(`receipt producer classes do not exact-match ${producerId}`)
    }
    if (!exactSet(receipt.requiredProducerClaims[producerId], receipt.observedProducerClaims[producerId]))
      fail(`receipt producer claims do not exact-match ${producerId}`)
    const resultScopes = sortedUnique(receipt.observedBehaviorResults
      .filter((result) => result.producerId === producerId).map(({ scope }) => scope))
    if (!exactSet(receipt.requiredProducerScopes[producerId], resultScopes))
      fail(`receipt producer scopes do not exact-match ${producerId}`)
  }
  const key = ({ producerId, scope }) => `${producerId}\0${scope}`
  const requiredReferences = Object.entries(receipt.requiredProducerScopes)
    .flatMap(([producerId, scopes]) => scopes.map((scope) => key({ producerId, scope })))
  if (!exactSet(receipt.observationRefs.map(key), requiredReferences)
    || !exactSet(sortedUnique(receipt.observationRefs.map(({ scope }) => scope)),
      receipt.requiredObservationScopes))
  {
    fail('receipt observation references do not exact-match required scopes')
  }
  return receipt
}

export function verifyBehaviorEvidencePostRuntime({ receipt, ...inputs })
{
  const receiptInput = readCurrentJson(
    receipt,
    'post-runtime receipt',
    inputs.repositoryRoot ?? root
  )
  validatePostRuntimeReceipt(receiptInput.value)
  const replay = joinBehaviorEvidencePostRuntime(inputs)
  if (receiptInput.value.contentDigest !== replay.contentDigest)
  {
    fail('receipt does not exact-match independent current-input replay')
  }
  return receiptInput.value
}

function writeReceipt(output, receipt, repositoryRoot)
{
  const { repository, absolute } = canonicalRelativeJson(output, 'output', repositoryRoot)
  if (output !== '.tmp/behavior-evidence-post-runtime/receipt.json')
  {
    fail('output must use the canonical post-runtime receipt path')
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 })
  if (fs.existsSync(absolute)) fail('output must not overwrite an existing receipt')
  const temporary = `${absolute}.prepared-${process.pid}`
  try
  {
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600
    })
    fs.linkSync(temporary, absolute)
  }
  finally
  {
    fs.rmSync(temporary, { force: true })
  }
  if (fs.realpathSync.native(repository) !== repository
    || fs.realpathSync.native(absolute) !== absolute
    || fs.lstatSync(absolute).nlink !== 1)
  {
    fs.rmSync(absolute, { force: true })
    fail('published receipt path identity is not canonical and exclusive')
  }
}

function parseArgs(argv)
{
  const options = { observationReceipts: [] }
  const singleton = new Set()
  for (let index = 0; index < argv.length; index += 1)
  {
    const argument = argv[index]
    const value = argv[index + 1]
    if (!argument?.startsWith('--') || value == null || value.startsWith('--'))
    {
      fail(`${argument ?? '<missing option>'} requires one explicit value`)
    }
    if (argument !== '--observation')
    {
      if (singleton.has(argument)) fail(`${argument} must not be duplicated`)
      singleton.add(argument)
    }
    if (argument === '--pre-runtime') options.preRuntimeReceipt = value
    else if (argument === '--catalog') options.catalog = value
    else if (argument === '--registry') options.registry = value
    else if (argument === '--observation') options.observationReceipts.push(value)
    else if (argument === '--scheduler-evidence') options.schedulerEvidence = value
    else if (argument === '--verify-receipt') options.verifyReceipt = value
    else if (argument === '--out') options.output = value
    else fail(`unknown option ${argument}`)
    index += 1
  }
  if (options.verifyReceipt && options.output)
  {
    fail('--verify-receipt and --out are mutually exclusive')
  }
  return options
}

export function runBehaviorEvidencePostRuntimeCli(argv, repositoryRoot = root)
{
  const options = parseArgs(argv)
  const inputs = {
    preRuntimeReceipt: options.preRuntimeReceipt,
    catalog: options.catalog,
    registry: options.registry,
    observationReceipts: options.observationReceipts,
    schedulerEvidence: options.schedulerEvidence,
    repositoryRoot
  }
  const receipt = options.verifyReceipt
    ? verifyBehaviorEvidencePostRuntime({ receipt: options.verifyReceipt, ...inputs })
    : joinBehaviorEvidencePostRuntime(inputs)
  if (options.output) writeReceipt(options.output, receipt, repositoryRoot)
  console.log(`[behavior-evidence-post-runtime] ok behaviors=${receipt.behaviorIds.length} classes=${receipt.observedBehaviorResults.length}`)
  return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  try
  {
    runBehaviorEvidencePostRuntimeCli(process.argv.slice(2))
  }
  catch (error)
  {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
