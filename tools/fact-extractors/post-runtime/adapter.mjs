import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadCatalog } from '../../contracts/behavior-contract-catalog.mjs'
import { validateGlobalClaimExactnessReceipt } from '../../docs/global-claim-exactness-final.mjs'
import { digestValue, isPlainObject, stable } from '../lib/canonicalize.mjs'
import { productionBuildBinding } from '../../release/test-evidence-receipts.mjs'
import { assertPreRuntimeQualified } from '../../test-matrix/behavior-evidence-pre-runtime.mjs'
import {
  loadPostRuntimeProducerRegistry,
  root as defaultRoot,
  validateAcceptedClaimsReceiptAgainstRegistry,
  validatePostRuntimeProducerRegistry,
  validateProducerReceiptAgainstRegistry
} from '../../test-matrix/post-runtime-producer-registry.mjs'
import { validateSemanticFacts } from './semantic-contracts.mjs'

export const acceptedClaimsSchema = 'fsusblog.post-runtime-accepted-claims.v1'
export const candidatePlanSchema = 'fsusblog.post-runtime-candidate-plan.v1'
export const classReceiptSchema = 'fsusblog.post-runtime-class-receipt.v1'
export const observationReceiptSchema = 'fsusblog.post-runtime-observation-receipt.v1'

const digestPattern = /^(?:sha256:)?[a-f0-9]{64}$/u
const unsafePathPattern = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu
const fail = (message) => { throw new Error(`[post-runtime-observation] ${message}`) }
const normalizedDigest = (value) => String(value ?? '').replace(/^sha256:/u, '')
const prefixedDigest = (value) => `sha256:${normalizedDigest(value)}`

function withoutDigest(value)
{
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contentDigest'))
}

export function seal(value)
{
  const receipt = { ...stable(value), contentDigest: null }
  receipt.contentDigest = `sha256:${digestValue(withoutDigest(receipt))}`
  return receipt
}

function verifySeal(value, label)
{
  if (!digestPattern.test(String(value?.contentDigest ?? ''))) fail(`${label} contentDigest is invalid`)
  if (prefixedDigest(value.contentDigest) !== seal(withoutDigest(value)).contentDigest) fail(`${label} contentDigest mismatch`)
}

export function explicitJson(input, label, repositoryRoot = defaultRoot)
{
  if (isPlainObject(input)) return { value: structuredClone(input), relative: null }
  if (typeof input !== 'string' || input.length === 0) fail(`${label} requires an explicit JSON path`)
  const root = path.resolve(repositoryRoot)
  const absolute = path.resolve(root, input)
  if (!absolute.startsWith(`${root}${path.sep}`) || !input.endsWith('.json') || unsafePathPattern.test(input))
  {
    fail(`${label} must be a current-run JSON path inside the repository`)
  }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`${label} is missing`)
  return {
    value: JSON.parse(readFileSync(absolute, 'utf8')),
    relative: path.relative(root, absolute).replaceAll(path.sep, '/')
  }
}

export function writeReceipt(output, receipt, repositoryRoot = defaultRoot)
{
  const root = path.resolve(repositoryRoot)
  const absolute = path.resolve(root, output)
  if (!absolute.startsWith(`${root}${path.sep}`) || !output.endsWith('.json') || unsafePathPattern.test(output))
  {
    fail('output must be a current-run JSON path inside the repository')
  }
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(receipt, null, 2)}\n`)
  return path.relative(root, absolute).replaceAll(path.sep, '/')
}

function authority(repositoryRoot = defaultRoot)
{
  const catalog = loadCatalog(path.join(repositoryRoot, 'config/contracts/behavior-contracts.json'))
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  validatePostRuntimeProducerRegistry(registry, { catalog })
  if (registry.producers.length !== 1) fail('post-runtime registry must resolve exact-one producer')
  return { registry, producer: registry.producers[0] }
}

function requiredModes(producer, classId)
{
  return Object.entries(producer.requiredObservations)
    .filter(([, classes]) => classes.includes(classId))
    .map(([mode]) => mode)
    .sort()
}

export function produceAcceptedClaims({ terminalReceipt, repositoryRoot = defaultRoot })
{
  const terminalInput = explicitJson(terminalReceipt, 'terminal receipt', repositoryRoot)
  if (terminalInput.relative === null) fail('accepted claims require a persisted terminal receipt path')
  const terminal = terminalInput.value
  validateGlobalClaimExactnessReceipt(terminal)
  const { registry, producer } = authority(repositoryRoot)
  const ledger = JSON.parse(readFileSync(path.join(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
  if (normalizedDigest(terminal.source?.migrationLedgerDigest) !== digestValue(ledger))
  {
    fail('terminal receipt migration ledger digest does not match current #2205 authority')
  }
  const claimOwners = new Map()
  for (const scope of ledger.scopes ?? [])
  {
    for (const entry of scope.entries ?? [])
    {
      for (const claimId of entry.claimIds ?? [])
      {
        if (claimOwners.has(claimId)) fail(`claim ${claimId} has duplicate ledger owners`)
        claimOwners.set(claimId, { behaviorId: entry.behaviorId, scopeId: scope.scopeId })
      }
    }
  }
  const claims = producer.acceptedClaimRefs.map((claimId) => {
    const owner = claimOwners.get(claimId)
    if (!owner) fail(`accepted claim ${claimId} is absent from the #2205 ledger`)
    return { claimId, ...owner }
  }).sort((left, right) => left.claimId.localeCompare(right.claimId))
  return seal({
    schema: acceptedClaimsSchema,
    sourceState: {
      commit: terminal.source.sourceCommit,
      worktreeFingerprint: prefixedDigest(terminal.source.worktreeFingerprint)
    },
    producerId: producer.producerId,
    toolVersion: registry.receiptSemantics.acceptedClaimsToolVersion,
    terminalReceiptRef: {
      path: terminalInput.relative,
      fileDigest: `sha256:${createHash('sha256').update(readFileSync(path.join(repositoryRoot, terminalInput.relative))).digest('hex')}`,
      contentDigest: prefixedDigest(terminal.contentDigest),
      schema: terminal.schema
    },
    migrationLedgerDigest: prefixedDigest(terminal.source.migrationLedgerDigest),
    claims,
    status: 'accepted'
  })
}

export function validateAcceptedClaims(receipt, { repositoryRoot = defaultRoot } = {})
{
  const { registry, producer } = authority(repositoryRoot)
  validateAcceptedClaimsReceiptAgainstRegistry({
    registry,
    producerId: producer.producerId,
    receipt,
    repositoryRoot
  })
  return receipt
}

export function produceCandidateContext({ preRuntimeReceipt, runId, attemptId = 'attempt-1', repositoryRoot = defaultRoot })
{
  const pre = explicitJson(preRuntimeReceipt, 'pre-runtime receipt', repositoryRoot).value
  assertPreRuntimeQualified(pre)
  if (typeof runId !== 'string' || runId.length === 0 || typeof attemptId !== 'string' || attemptId.length === 0)
  {
    fail('candidate context requires runId and attemptId')
  }
  return seal({
    schema: 'fsusblog.post-runtime-candidate-context.v1',
    sourceState: {
      commit: pre.sourceIdentity.commit,
      worktreeFingerprint: prefixedDigest(pre.sourceIdentity.worktreeFingerprint)
    },
    candidate: {
      candidateId: `${runId}:candidate`,
      runId,
      attemptId,
      fixtureId: `${runId}:fixture`,
      profileId: 'production-fresh',
      runtimeId: `${runId}:runtime`,
      browserId: `${runId}:browser-contract`,
      releaseId: `${runId}:release`,
      rolloutId: `${runId}:rollout`
    },
    status: 'planned-before-runtime'
  })
}

export function produceCandidatePlan({ preRuntimeReceipt, acceptedClaimsReceipt, buildReceipt, context, observationPaths, repositoryRoot = defaultRoot })
{
  const pre = explicitJson(preRuntimeReceipt, 'pre-runtime receipt', repositoryRoot).value
  assertPreRuntimeQualified(pre)
  const claims = validateAcceptedClaims(explicitJson(acceptedClaimsReceipt, 'accepted claims receipt', repositoryRoot).value, { repositoryRoot })
  const buildInput = explicitJson(buildReceipt, 'production build receipt', repositoryRoot)
  const build = productionBuildBinding(buildInput.value, buildInput.relative ?? 'in-memory-build.json')
  const run = explicitJson(context, 'candidate context', repositoryRoot).value
  verifySeal(run, 'candidate context')
  if (run.schema !== 'fsusblog.post-runtime-candidate-context.v1') fail('candidate context schema mismatch')
  const sourceState = { commit: pre.sourceIdentity.commit, worktreeFingerprint: prefixedDigest(pre.sourceIdentity.worktreeFingerprint) }
  if (build.sourceState.commit !== sourceState.commit
    || prefixedDigest(build.sourceState.worktreeFingerprint) !== sourceState.worktreeFingerprint
    || claims.sourceState.commit !== sourceState.commit
    || claims.sourceState.worktreeFingerprint !== sourceState.worktreeFingerprint
    || run.sourceState?.commit !== sourceState.commit
    || prefixedDigest(run.sourceState?.worktreeFingerprint) !== sourceState.worktreeFingerprint)
  {
    fail('candidate inputs do not share one source/worktree identity')
  }
  const { registry, producer } = authority(repositoryRoot)
  const classes = Object.keys(registry.observationClasses).sort()
  if (!isPlainObject(observationPaths) || JSON.stringify(Object.keys(observationPaths).sort()) !== JSON.stringify(classes))
  {
    fail('candidate plan must bind exact-one output path for every canonical observation class')
  }
  const observations = classes.map((classId) => {
    const receiptPath = String(observationPaths[classId] ?? '')
    if (!receiptPath.endsWith('.json') || unsafePathPattern.test(receiptPath)) fail(`${classId} receipt path is not current-run explicit`)
    return { classId, schema: registry.observationClasses[classId].schema, receiptPath, requiredModes: requiredModes(producer, classId) }
  })
  return seal({
    schema: candidatePlanSchema,
    producerId: producer.producerId,
    sourceState,
    build,
    candidate: stable(run.candidate),
    preRuntimeReceiptDigest: prefixedDigest(pre.contentDigest),
    acceptedClaimsReceiptDigest: prefixedDigest(claims.contentDigest),
    observations,
    status: 'planned'
  })
}

export function validateCandidatePlan(plan, { repositoryRoot = defaultRoot } = {})
{
  if (plan?.schema !== candidatePlanSchema || plan.status !== 'planned') fail('candidate plan schema/status mismatch')
  verifySeal(plan, 'candidate plan')
  const { registry, producer } = authority(repositoryRoot)
  if (plan.producerId !== producer.producerId) fail('candidate plan producer mismatch')
  const expected = Object.keys(registry.observationClasses).sort()
  const actual = (plan.observations ?? []).map(({ classId }) => classId).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('candidate plan observation closure mismatch')
  for (const observation of plan.observations)
  {
    const definition = registry.observationClasses[observation.classId]
    if (observation.schema !== definition.schema
      || JSON.stringify([...(observation.requiredModes ?? [])].sort())
        !== JSON.stringify(requiredModes(producer, observation.classId)))
    {
      fail(`${observation.classId} candidate plan authority binding mismatch`)
    }
    if (typeof observation.receiptPath !== 'string' || !observation.receiptPath.endsWith('.json')
      || unsafePathPattern.test(observation.receiptPath))
    {
      fail(`${observation.classId} candidate plan path is not current-run explicit`)
    }
  }
  return plan
}

export function produceClassReceipt({ candidatePlan, classId, result, repositoryRoot = defaultRoot })
{
  const plan = validateCandidatePlan(explicitJson(candidatePlan, 'candidate plan', repositoryRoot).value, { repositoryRoot })
  const input = explicitJson(result, `${classId} result`, repositoryRoot)
  const { registry, producer } = authority(repositoryRoot)
  const definition = registry.observationClasses[classId]
  if (!definition) fail(`unknown observation class ${classId}`)
  validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt: input.value, classId })
  const planned = plan.observations.find((entry) => entry.classId === classId)
  if (!planned || input.relative !== planned.receiptPath) fail(`${classId} result path does not match candidate plan`)
  const source = input.value.sourceState ?? input.value.sourceIdentity ?? {}
  if ((source.sourceCommit ?? source.commit) !== plan.sourceState.commit
    || prefixedDigest(source.worktreeFingerprint) !== plan.sourceState.worktreeFingerprint)
  {
    fail(`${classId} source identity mismatch`)
  }
  for (const field of definition.requiredIdentityFields)
  {
    if (field === 'contentDigest') continue
    if (source[field] == null && input.value[field] == null) fail(`${classId} is missing required identity ${field}`)
  }
  const identities = { ...source, ...input.value }
  const exactIdentity = {
    sourceCommit: plan.sourceState.commit,
    worktreeFingerprint: plan.sourceState.worktreeFingerprint,
    buildIdentity: plan.build.receiptContentDigest,
    candidateId: plan.candidate.candidateId,
    runId: plan.candidate.runId,
    browserIdentity: plan.candidate.browserId,
    releaseId: plan.candidate.releaseId,
    rolloutId: plan.candidate.rolloutId
  }
  for (const [field, expected] of Object.entries(exactIdentity))
  {
    if (definition.requiredIdentityFields.includes(field)
      && prefixedDigest(identities[field]) !== prefixedDigest(expected))
    {
      fail(`${classId} ${field} does not match candidate plan`)
    }
  }
  const modes = [...(input.value.modes ?? [])].sort()
  if (JSON.stringify(modes) !== JSON.stringify(planned.requiredModes)) fail(`${classId} result modes do not exact-match registry`)
  validateSemanticFacts(classId, input.value.semanticFacts)
  return seal({
    schema: classReceiptSchema,
    classId,
    observationSchema: definition.schema,
    producerId: producer.producerId,
    sourceState: plan.sourceState,
    candidatePlanDigest: plan.contentDigest,
    buildReceiptDigest: plan.build.receiptContentDigest,
    candidate: plan.candidate,
    modes,
    semanticFacts: stable(input.value.semanticFacts),
    rawResult: { path: input.relative, contentDigest: prefixedDigest(input.value.contentDigest) },
    status: 'qualified'
  })
}

export function produceObservationReceipt({ scope, candidatePlan, acceptedClaimsReceipt, classReceipts, repositoryRoot = defaultRoot })
{
  const plan = validateCandidatePlan(explicitJson(candidatePlan, 'candidate plan', repositoryRoot).value, { repositoryRoot })
  const claims = validateAcceptedClaims(explicitJson(acceptedClaimsReceipt, 'accepted claims receipt', repositoryRoot).value, { repositoryRoot })
  if (claims.contentDigest !== plan.acceptedClaimsReceiptDigest) fail('accepted claims do not match candidate plan')
  const scopeClasses = scope === 'application'
    ? ['aot-spa-hydration', 'browser-behavior-contract', 'cache-search-outbox-convergence', 'route-response-error', 'session-cookie-runtime']
    : scope === 'release-deployment'
      ? ['blue-green-containment', 'release-identity-readiness']
      : fail(`unknown observation scope ${scope}`)
  const receipts = classReceipts.map((entry, index) => explicitJson(entry, `class receipt ${index}`, repositoryRoot).value)
  for (const receipt of receipts)
  {
    if (receipt.schema !== classReceiptSchema || receipt.status !== 'qualified') fail('class receipt schema/status mismatch')
    verifySeal(receipt, `class receipt ${receipt.classId}`)
    if (receipt.candidatePlanDigest !== plan.contentDigest) fail(`${receipt.classId} candidate plan mismatch`)
    const replay = produceClassReceipt({
      candidatePlan: plan,
      classId: receipt.classId,
      result: receipt.rawResult?.path,
      repositoryRoot
    })
    if (replay.contentDigest !== receipt.contentDigest) fail(`${receipt.classId} class receipt replay mismatch`)
  }
  if (JSON.stringify(receipts.map(({ classId }) => classId).sort()) !== JSON.stringify(scopeClasses.sort()))
  {
    fail(`${scope} class receipt closure must be exact-one`)
  }
  return seal({
    schema: observationReceiptSchema,
    scope,
    behaviorId: 'browserless-production-correctness',
    producerId: plan.producerId,
    sourceState: plan.sourceState,
    candidate: plan.candidate,
    build: plan.build,
    buildReceiptDigest: plan.build.receiptContentDigest,
    candidatePlanDigest: plan.contentDigest,
    preRuntimeReceiptDigest: plan.preRuntimeReceiptDigest,
    acceptedClaimsReceiptDigest: claims.contentDigest,
    acceptedClaimRefs: claims.claims.map(({ claimId }) => claimId).sort(),
    requiredClasses: [...scopeClasses].sort(),
    observedClasses: receipts.map(({ classId }) => classId).sort(),
    observations: receipts.sort((left, right) => left.classId.localeCompare(right.classId)).map((receipt) => ({
      classId: receipt.classId,
      receiptDigest: receipt.contentDigest,
      modes: receipt.modes,
      rawResult: receipt.rawResult,
      semanticFacts: receipt.semanticFacts
    })),
    status: 'qualified',
    failureReasons: []
  })
}

export function runObservationCli({ argv, scope, defaultOutput, repositoryRoot = defaultRoot })
{
  const command = argv[0]
  const options = { classReceipts: [] }
  for (let index = 1; index < argv.length; index += 2)
  {
    const key = argv[index]
    const value = argv[index + 1]
    if (!value) fail(`${key} requires a value`)
    if (key === '--candidate-plan') options.candidatePlan = value
    else if (key === '--accepted-claims') options.acceptedClaimsReceipt = value
    else if (key === '--class-receipt') options.classReceipts.push(value)
    else if (key === '--out') options.out = value
    else if (key === '--receipt') options.receipt = value
    else fail(`unknown option ${key}`)
  }
  const produced = produceObservationReceipt({ scope, ...options, repositoryRoot })
  if (command === 'verify')
  {
    const actual = explicitJson(options.receipt, 'observation receipt', repositoryRoot).value
    verifySeal(actual, 'observation receipt')
    if (actual.contentDigest !== produced.contentDigest) fail('observation receipt replay mismatch')
    return actual
  }
  if (command !== 'produce') fail('command must be produce or verify')
  writeReceipt(options.out ?? defaultOutput, produced, repositoryRoot)
  return produced
}
