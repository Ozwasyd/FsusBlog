#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  candidatePlanPathForObservation,
  explicitJson,
  observationEnvelopeAuthorityFields,
  observationSourceReceipt,
  observationSourceState,
  observationUpstreamPath,
  seal,
  validateCandidatePlan,
  writeReceipt
} from '../fact-extractors/post-runtime/adapter.mjs'
import {
  loadPostRuntimeProducerRegistry,
  root,
  validateProducerReceiptAgainstRegistry
} from '../test-matrix/post-runtime-producer-registry.mjs'
import { verifyCanonicalReleaseAuthorities } from './canonical-release-authorities.mjs'
import { deriveReleaseReadinessAuthorityFacts } from './release-authority-facts-contract.mjs'
import {
  buildReleaseReadinessAuthorityBundle,
  releaseReadinessAuthorityBundleSchema
} from './release-authority-bundle-contract.mjs'
import { validateReleaseReadinessSource } from './release-readiness-source-contract.mjs'
import {
  currentJson,
  fail,
  releaseReadinessObservationSchema,
  semanticDigest,
  verifySeal
} from './release-readiness-source-support.mjs'
export { releaseReadinessAuthorityBundleSchema } from './release-authority-bundle-contract.mjs'
export { validateReleaseReadinessSource } from './release-readiness-source-contract.mjs'
export {
  releaseReadinessObservationSchema,
  releaseReadinessSourceSchema
} from './release-readiness-source-support.mjs'

export function projectReleaseReadinessRaw({ candidatePlan, sourceReceipt, repositoryRoot = root })
{
  const planInput = currentJson(candidatePlan, 'candidate plan', repositoryRoot)
  const plan = validateCandidatePlan(planInput.value, { repositoryRoot })
  const sourceInput = currentJson(sourceReceipt, 'release readiness source', repositoryRoot)
  const validated = validateReleaseReadinessSource(sourceInput.value, { candidatePlan: plan, repositoryRoot })
  const planned = plan.observations.find(({ classId }) => classId === 'release-identity-readiness')
  if (!planned || planned.schema !== releaseReadinessObservationSchema)
  {
    fail('candidate plan does not own release-identity-readiness')
  }
  const { source, manifest, build, versionDigest } = validated
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  const producer = registry.producers.find(({ producerId }) => producerId === plan.producerId)
  if (!producer) fail('candidate plan producer is absent from registry')
  const readiness = source.observations.readiness
  const facts = {
    imageDigest: manifest.manifest.imageDigest,
    packageDigest: build.packageDigest,
    configDigest: source.observations.config.observedDigest,
    schemaDigest: source.observations.databaseSchema.schemaDigest,
    manifestDigest: manifest.ref.fileDigest,
    signingDigest: semanticDigest(source.observations.signing),
    trustDigest: semanticDigest(source.observations.trust),
    readinessReceiptDigest: semanticDigest(readiness),
    serviceReady: readiness.checks.service.expectedDigest === source.observations.runtimeRole.serviceIdentityDigest,
    routeDataReady: readiness.checks.routeData.semanticMatch === true,
    cacheReady: readiness.checks.cache.semanticMatch === true,
    dependenciesReady: readiness.checks.dependencies.expectedDigest === source.observations.databaseSchema.schemaDigest,
    versionReady: readiness.checks.version.expectedDigest === versionDigest,
    credentialReady: readiness.checks.credential.expectedDigest === source.observations.trust.policyDigest,
    identityMatch: true,
    runtimeRoleContractSatisfied: source.observations.runtimeRole.roleContractSatisfied,
    monolithicOwnershipSatisfied: source.observations.runtimeRole.monolithicOwnershipSatisfied
  }
  return seal({
    schema: releaseReadinessObservationSchema,
    producerId: plan.producerId,
    toolVersion: producer.toolVersion,
    sourceState: {
      ...source.sourceState,
      schemaIdentity: releaseReadinessObservationSchema,
      toolchainIdentity: build.toolchainIdentity
    },
    executionClass: 'correctness',
    evidenceClass: 'correctness',
    qualificationEligible: true,
    planned: true,
    executed: true,
    outcome: 'passed',
    recovered: false,
    modes: planned.requiredModes,
    terminal: { timeout: false, cancelled: false, processTreeTerminated: false, priorAttemptDigest: null },
    semanticFacts: facts,
    candidatePlanRef: planInput.ref,
    sourceReceiptRef: sourceInput.ref,
    canonicalRerunCommand: source.provenance.rerunCommand,
    independentVerifyCommand: `node tools/test-evidence/release-readiness-raw.mjs verify --receipt ${planned.receiptPath}`
  })
}

export function produceReleaseReadinessAuthorityBundle({
  candidatePlan,
  rolloutEvidence,
  runtimeRoleAdmission,
  repositoryRoot = root
})
{
  const planInput = currentJson(candidatePlan, 'candidate plan', repositoryRoot)
  const plan = validateCandidatePlan(planInput.value, { repositoryRoot })
  const authorities = verifyCanonicalReleaseAuthorities({
    candidatePlan: plan, rolloutEvidence, runtimeRoleAdmission, repositoryRoot
  })
  return buildReleaseReadinessAuthorityBundle({ planInput, plan, authorities })
}

function releaseAuthorityBundle(sourceReceipt, plan, repositoryRoot)
{
  const source = currentJson(sourceReceipt, 'release readiness authority bundle', repositoryRoot)
  verifySeal(source.value, 'release readiness authority bundle')
  if (source.value.schema !== releaseReadinessAuthorityBundleSchema)
  {
    fail('release readiness source is not a canonical authority bundle')
  }
  const authorities = verifyCanonicalReleaseAuthorities({
    candidatePlan: plan,
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
  if (source.value.authorityDigest !== authorities.authorityDigest) fail('release authority closure digest mismatch')
  return { source, authorities }
}

export function projectReleaseReadinessAuthoritiesRaw({ candidatePlan, sourceReceipt, repositoryRoot = root })
{
  const planInput = currentJson(candidatePlan, 'candidate plan', repositoryRoot)
  const plan = validateCandidatePlan(planInput.value, { repositoryRoot })
  const planned = plan.observations.find(({ classId }) => classId === 'release-identity-readiness')
  if (!planned || planned.schema !== releaseReadinessObservationSchema) fail('candidate plan does not own release readiness')
  const { source, authorities } = releaseAuthorityBundle(sourceReceipt, plan, repositoryRoot)
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  const producer = registry.producers.find(({ producerId }) => producerId === plan.producerId)
  if (!producer) fail('candidate plan producer is absent from registry')
  const rollout = authorities.rollout.value
  const build = buildFacts(plan, repositoryRoot)
  const { legacyFacts, typedFacts } = deriveReleaseReadinessAuthorityFacts({ plan, authorities, build })
  const semanticFacts = Array.isArray(registry.observationClasses['release-identity-readiness'].requiredSemanticFactFields)
    ? typedFacts
    : legacyFacts
  const sourceState = observationSourceState({
    classId: 'release-identity-readiness',
    plan, artifactDigest: authorities.authorityDigest, repositoryRoot,
    legacy: {
      sourceCommit: plan.sourceState.commit, worktreeFingerprint: plan.sourceState.worktreeFingerprint,
      buildIdentity: plan.build.receiptContentDigest, artifactDigest: authorities.authorityDigest,
      candidateId: plan.candidate.candidateId, releaseId: plan.candidate.releaseId,
      runtimeId: plan.candidate.runtimeId, runId: plan.candidate.runId,
      attemptId: plan.candidate.attemptId, slot: rollout.target.slot
    }
  })
  const canonicalRerunCommand = `node tools/test-evidence/release-readiness-raw.mjs project-authorities --candidate-plan ${planInput.ref.path} --source ${source.ref.path} --out ${planned.receiptPath}`
  const independentVerifyCommand = `node tools/test-evidence/release-readiness-raw.mjs verify --candidate-plan ${planInput.ref.path} --receipt ${planned.receiptPath}`
  return seal({
    schema: releaseReadinessObservationSchema,
    producerId: plan.producerId,
    toolVersion: producer.toolVersion,
    sourceState,
    executionClass: 'correctness', evidenceClass: 'correctness', qualificationEligible: true,
    planned: true, executed: true, outcome: 'passed', recovered: false,
    modes: planned.requiredModes,
    terminal: { timeout: false, cancelled: false, processTreeTerminated: false, priorAttemptDigest: null },
    semanticFacts,
    ...observationEnvelopeAuthorityFields({ plan, candidatePlanRef: planInput.ref, repositoryRoot }),
    sourceReceiptRef: observationSourceReceipt({
      classId: 'release-identity-readiness', plan, sourceState, upstreamRef: source.ref,
      upstreamSchema: source.value.schema,
      canonicalRerunCommand, independentVerifyCommand, repositoryRoot
    }),
    canonicalRerunCommand,
    independentVerifyCommand
  })
}

export function verifyReleaseReadinessRaw(receiptPath, repositoryRoot = root, candidatePlan = null)
{
  const input = currentJson(receiptPath, 'release readiness raw receipt', repositoryRoot)
  if (input.value.schema !== releaseReadinessObservationSchema) fail('raw receipt schema mismatch')
  verifySeal(input.value, 'release readiness raw receipt')
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  validateProducerReceiptAgainstRegistry({
    registry, producerId: input.value.producerId, receipt: input.value,
    classId: 'release-identity-readiness', repositoryRoot
  })
  for (const [label, reference] of [['source receipt', input.value.sourceReceiptRef]])
  {
    const current = currentJson(reference?.path, label, repositoryRoot)
    if (current.ref.fileDigest !== reference?.fileDigest
      || (reference?.contentDigest !== null && current.ref.contentDigest !== reference.contentDigest))
    {
      fail(`${label} digest mismatch after raw projection`)
    }
  }
  const planPath = candidatePlanPathForObservation(input.value, candidatePlan)
  const upstreamPath = observationUpstreamPath(input.value, repositoryRoot)
  const source = currentJson(upstreamPath, 'source receipt', repositoryRoot)
  const replay = source.value.schema === releaseReadinessAuthorityBundleSchema
    ? projectReleaseReadinessAuthoritiesRaw({
        candidatePlan: planPath,
        sourceReceipt: upstreamPath,
        repositoryRoot
      })
    : projectReleaseReadinessRaw({
        candidatePlan: planPath,
        sourceReceipt: upstreamPath,
        repositoryRoot
      })
  if (replay.contentDigest !== input.value.contentDigest) fail('release readiness raw replay mismatch')
  return input.value
}

function options(argv)
{
  const [command, ...args] = argv
  const parsed = { command }
  for (let index = 0; index < args.length; index += 2)
  {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value == null || value.startsWith('--')) fail(`invalid option near ${key ?? '<end>'}`)
    parsed[key.slice(2)] = value
  }
  return parsed
}

function main()
{
  const parsed = options(process.argv.slice(2))
  if (parsed.command === 'bundle-authorities')
  {
    if (!parsed.out) fail('authority bundle requires --out')
    const receipt = produceReleaseReadinessAuthorityBundle({
      candidatePlan: parsed['candidate-plan'], rolloutEvidence: parsed['rollout-evidence'],
      runtimeRoleAdmission: parsed['runtime-role-admission'], repositoryRoot: root
    })
    writeReceipt(parsed.out, receipt, root)
    process.stdout.write(`[release-readiness-raw] bundled authorities path=${parsed.out} digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'project-authorities')
  {
    const receipt = projectReleaseReadinessAuthoritiesRaw({
      candidatePlan: parsed['candidate-plan'], sourceReceipt: parsed.source, repositoryRoot: root
    })
    const plan = explicitJson(parsed['candidate-plan'], 'candidate plan', root).value
    const planned = plan.observations.find(({ classId }) => classId === 'release-identity-readiness')
    if (!parsed.out || parsed.out !== planned?.receiptPath) fail('raw output path must exact-match candidate plan')
    writeReceipt(parsed.out, receipt, root)
    verifyReleaseReadinessRaw(parsed.out, root, parsed['candidate-plan'])
    process.stdout.write(`[release-readiness-raw] projected canonical authorities path=${parsed.out} digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'project')
  {
    const receipt = projectReleaseReadinessRaw({
      candidatePlan: parsed['candidate-plan'],
      sourceReceipt: parsed.source,
      repositoryRoot: root
    })
    const plan = explicitJson(parsed['candidate-plan'], 'candidate plan', root).value
    const planned = plan.observations.find(({ classId }) => classId === 'release-identity-readiness')
    const output = parsed.out ?? planned?.receiptPath
    if (!output || output !== planned?.receiptPath) fail('raw output path must exact-match candidate plan')
    writeReceipt(output, receipt, root)
    verifyReleaseReadinessRaw(output, root, parsed['candidate-plan'])
    process.stdout.write(`[release-readiness-raw] projected path=${output} digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'verify')
  {
    const receipt = verifyReleaseReadinessRaw(parsed.receipt, root, parsed['candidate-plan'])
    process.stdout.write(`[release-readiness-raw] verified digest=${receipt.contentDigest}\n`)
    return
  }
  fail('usage: project --candidate-plan <path> --source <path> --out <planned-path> or verify --receipt <path>')
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
