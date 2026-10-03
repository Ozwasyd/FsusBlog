import { readFileSync } from 'node:fs'
import path from 'node:path'

import { verifyProductionBuildReceipt } from '../../ci/production-build-artifacts.mjs'
import { validateRolloutId } from '../../deployment/release-rollout-evidence-receipt-contract.mjs'
import { productionBuildBinding } from '../../release/test-evidence-receipts.mjs'
import { assertPreRuntimeQualified } from '../../test-matrix/behavior-evidence-pre-runtime.mjs'
import { resolveSourceCommit, resolveWorktreeFingerprint } from '../identity.mjs'
import { digestValue, isPlainObject, stable } from '../lib/canonicalize.mjs'
import {
  authority,
  candidatePlanSchema,
  canonicalCurrentRunDirectory,
  canonicalCurrentRunJsonPath,
  currentRegistryBinding,
  defaultRoot,
  digestPattern,
  explicitJson,
  fail,
  identityAuthoritySchema,
  prefixedDigest,
  receiptReference,
  requiredModes,
  schedulerRunIdPattern,
  seal,
  validateAcceptedClaims,
  verifyReference,
  verifySeal,
  writeReceipt
} from './common.mjs'

export function produceCandidateContext({
  preRuntimeReceipt,
  runId,
  attemptId = 'attempt-0001',
  candidate: overrides = {},
  repositoryRoot = defaultRoot
})
{
  const preInput = explicitJson(preRuntimeReceipt, 'pre-runtime receipt', repositoryRoot)
  const pre = preInput.value
  assertPreRuntimeQualified(pre)
  if (!schedulerRunIdPattern.test(String(runId ?? ''))
    || !/^attempt-[0-9]{4}$/u.test(String(attemptId ?? '')))
  {
    fail('candidate context requires a stable lowercase runId and canonical attempt-NNNN identity')
  }
  const observationSchema = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  const typedIdentity = observationSchema.properties?.sourceState?.properties?.runtimeId !== undefined
  if (typedIdentity && !/^[0-9]{14}-[a-f0-9]{12}$/u.test(String(overrides.releaseId ?? '')))
  {
    fail('typed candidate context requires an explicit canonical releaseId')
  }
  return seal({
    schema: 'fsusblog.post-runtime-candidate-context.v1',
    preRuntimeReceiptRef: receiptReference(preInput, 'pre-runtime receipt'),
    sourceState: {
      commit: pre.sourceIdentity.commit,
      worktreeFingerprint: prefixedDigest(pre.sourceIdentity.worktreeFingerprint)
    },
    candidate: stable({
      candidateId: overrides.candidateId ?? `${runId}${typedIdentity ? ':' : '-'}candidate`,
      runId,
      attemptId,
      fixtureId: overrides.fixtureId ?? `${runId}${typedIdentity ? ':' : '-'}fixture`,
      profileId: overrides.profileId ?? 'acceptance-representative',
      runtimeId: overrides.runtimeId ?? `${runId}${typedIdentity ? ':' : '-'}runtime`,
      browserId: overrides.browserId ?? `${runId}${typedIdentity ? ':' : '-'}browser-contract`,
      releaseId: overrides.releaseId ?? `${runId}-release`,
      rolloutId: validateRolloutId(overrides.rolloutId ?? `${runId}-rollout`)
    }),
    status: 'planned-before-runtime'
  })
}

export function validateCandidateContext(run, repositoryRoot = defaultRoot)
{
  if (run?.schema !== 'fsusblog.post-runtime-candidate-context.v1'
    || run.status !== 'planned-before-runtime')
  {
    fail('candidate context schema/status mismatch')
  }
  verifySeal(run, 'candidate context')
  const preInput = verifyReference(run.preRuntimeReceiptRef, 'candidate context pre-runtime receipt', repositoryRoot)
  assertPreRuntimeQualified(preInput.value)
  const expectedSource = {
    commit: preInput.value.sourceIdentity.commit,
    worktreeFingerprint: prefixedDigest(preInput.value.sourceIdentity.worktreeFingerprint)
  }
  if (JSON.stringify(stable(run.sourceState)) !== JSON.stringify(stable(expectedSource)))
  {
    fail('candidate context source identity does not replay from pre-runtime authority')
  }
  const candidate = run.candidate ?? {}
  if (!schedulerRunIdPattern.test(String(candidate.runId ?? ''))
    || !/^attempt-[0-9]{4}$/u.test(String(candidate.attemptId ?? ''))
    || ['candidateId', 'fixtureId', 'profileId', 'runtimeId', 'browserId', 'releaseId', 'rolloutId']
      .some((field) => typeof candidate[field] !== 'string' || candidate[field].length < 3))
  {
    fail('candidate context identities are not canonically derived')
  }
  const observationSchema = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  if (observationSchema.properties?.sourceState?.properties?.runtimeId !== undefined
    && (candidate.candidateId !== `${candidate.runId}:candidate`
      || candidate.runtimeId !== `${candidate.runId}:runtime`
      || candidate.browserId !== `${candidate.runId}:browser-contract`
      || candidate.fixtureId !== `${candidate.runId}:fixture`
      || !/^[0-9]{14}-[a-f0-9]{12}$/u.test(candidate.releaseId)))
  {
    fail('typed candidate identities do not exact-match the run/release authority')
  }
  validateRolloutId(candidate.rolloutId)
  const profileCatalog = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/testing/fixture-profile-catalog.json'), 'utf8'))
  if (!(profileCatalog.profiles ?? []).some(({ id }) => id === candidate.profileId))
  {
    fail('candidate context profile identity is absent from the fixture-profile authority')
  }
  return run
}

function identityAuthoritySource(candidateContext)
{
  return stable({
    sourceCommit: candidateContext.sourceState.commit,
    worktreeFingerprint: candidateContext.sourceState.worktreeFingerprint,
    runId: candidateContext.candidate.runId,
    attemptId: candidateContext.candidate.attemptId,
    fixtureId: candidateContext.candidate.fixtureId,
    profileId: candidateContext.candidate.profileId
  })
}

function produceIdentityAuthorities({ candidateContext, outputDirectory, repositoryRoot })
{
  const normalizedOutputDirectory = String(outputDirectory ?? '').replaceAll(path.sep, '/')
  if (!canonicalCurrentRunDirectory(normalizedOutputDirectory))
  {
    fail('candidate plan requires a canonical repository-relative current-run identity-authority directory')
  }
  const identities = {
    plan: candidateContext.candidate.runId,
    attempt: candidateContext.candidate.attemptId,
    fixture: candidateContext.candidate.fixtureId,
    profile: candidateContext.candidate.profileId
  }
  const refs = {}
  for (const [role, authorityId] of Object.entries(identities))
  {
    const receipt = seal({
      schema: identityAuthoritySchema,
      role,
      authorityId,
      sourceState: identityAuthoritySource(candidateContext)
    })
    const output = path.posix.join(normalizedOutputDirectory, `${role}.json`)
    writeReceipt(output, receipt, repositoryRoot)
    const input = explicitJson(output, `${role} identity authority`, repositoryRoot)
    refs[role] = stable({
      path: input.relative,
      fileDigest: input.fileDigest,
      contentDigest: receipt.contentDigest,
      schema: identityAuthoritySchema,
      role
    })
  }
  return stable(refs)
}

export function verifyIdentityAuthorities(refs, candidateContext, repositoryRoot)
{
  if (!isPlainObject(refs)
    || JSON.stringify(Object.keys(refs).sort()) !== JSON.stringify(['attempt', 'fixture', 'plan', 'profile']))
  {
    fail('candidate plan identity authority closure must be exact')
  }
  const expectedIds = {
    plan: candidateContext.candidate.runId,
    attempt: candidateContext.candidate.attemptId,
    fixture: candidateContext.candidate.fixtureId,
    profile: candidateContext.candidate.profileId
  }
  const paths = new Set()
  for (const [role, authorityId] of Object.entries(expectedIds))
  {
    const reference = refs[role]
    if (!isPlainObject(reference)
      || JSON.stringify(Object.keys(reference).sort())
        !== JSON.stringify(['contentDigest', 'fileDigest', 'path', 'role', 'schema'])
      || reference.schema !== identityAuthoritySchema || reference.role !== role
      || !digestPattern.test(String(reference.fileDigest ?? ''))
      || !digestPattern.test(String(reference.contentDigest ?? '')))
    {
      fail(`${role} identity authority reference is invalid`)
    }
    if (paths.has(reference.path)) fail('identity authorities must use distinct files')
    paths.add(reference.path)
    const input = explicitJson(reference.path, `${role} identity authority`, repositoryRoot)
    const authority = input.value
    if (input.fileDigest !== reference.fileDigest || authority.schema !== identityAuthoritySchema
      || authority.role !== role || authority.authorityId !== authorityId
      || authority.contentDigest !== reference.contentDigest)
    {
      fail(`${role} identity authority bytes or identity mismatch`)
    }
    verifySeal(authority, `${role} identity authority`)
    if (JSON.stringify(stable(authority.sourceState))
      !== JSON.stringify(identityAuthoritySource(candidateContext)))
    {
      fail(`${role} identity authority sourceState mismatch`)
    }
  }
  return refs
}

export function verifyProductionBuildInput(input, expectedSourceState, repositoryRoot)
{
  const binding = productionBuildBinding(input.value, input.relative ?? 'in-memory-build.json')
  if (input.relative !== null)
  {
    const absolute = path.join(repositoryRoot, input.relative)
    verifyProductionBuildReceipt({
      artifactRoot: path.dirname(absolute),
      receiptFile: path.basename(absolute),
      expectedSourceState,
      expectedReceiptDigest: binding.receiptContentDigest,
      repairReadOnlySeal: false
    })
  }
  return binding
}

export function verifyCurrentRepositoryIdentity(sourceState, repositoryRoot)
{
  const actual = {
    commit: resolveSourceCommit(repositoryRoot),
    worktreeFingerprint: prefixedDigest(resolveWorktreeFingerprint(repositoryRoot))
  }
  if (sourceState.commit !== actual.commit || sourceState.worktreeFingerprint !== actual.worktreeFingerprint)
  {
    fail('candidate source identity does not exact-match the current repository worktree')
  }
}

export function observationEnvelopeAuthorityFields({
  plan,
  candidatePlanRef,
  repositoryRoot = defaultRoot
})
{
  const schema = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  const required = new Set(schema.required ?? [])
  if (!required.has('attemptAuthorityRef')) return { candidatePlanRef }
  verifyIdentityAuthorities(plan.identityAuthorityRefs, {
    sourceState: plan.sourceState,
    candidate: plan.candidate
  }, repositoryRoot)
  return stable({
    registryDigest: currentRegistryBinding(repositoryRoot, plan.producerId).contentDigest,
    observationSchemaDigest: `sha256:${digestValue(schema)}`,
    candidatePlanRef: plan.identityAuthorityRefs.plan,
    attemptAuthorityRef: plan.identityAuthorityRefs.attempt,
    fixtureAuthorityRef: plan.identityAuthorityRefs.fixture,
    profileAuthorityRef: plan.identityAuthorityRefs.profile
  })
}

export function produceCandidatePlan({
  preRuntimeReceipt,
  acceptedClaimsReceipt,
  buildReceipt,
  context,
  identityAuthorityDirectory,
  observationPaths,
  repositoryRoot = defaultRoot
})
{
  const preInput = explicitJson(preRuntimeReceipt, 'pre-runtime receipt', repositoryRoot)
  const pre = preInput.value
  assertPreRuntimeQualified(pre)
  const claimsInput = explicitJson(acceptedClaimsReceipt, 'accepted claims receipt', repositoryRoot)
  const buildInput = explicitJson(buildReceipt, 'production build receipt', repositoryRoot)
  const runInput = explicitJson(context, 'candidate context', repositoryRoot)
  const run = validateCandidateContext(runInput.value, repositoryRoot)
  const claims = validateAcceptedClaims(claimsInput.value, { expectedRunId: run.candidate.runId, repositoryRoot })
  const sourceState = { commit: pre.sourceIdentity.commit, worktreeFingerprint: prefixedDigest(pre.sourceIdentity.worktreeFingerprint) }
  verifyCurrentRepositoryIdentity(sourceState, repositoryRoot)
  const build = verifyProductionBuildInput(buildInput, sourceState, repositoryRoot)
  if (build.sourceState.commit !== sourceState.commit
    || prefixedDigest(build.sourceState.worktreeFingerprint) !== sourceState.worktreeFingerprint
    || claims.sourceState.commit !== sourceState.commit
    || claims.sourceState.worktreeFingerprint !== sourceState.worktreeFingerprint
    || run.sourceState?.commit !== sourceState.commit
    || prefixedDigest(run.sourceState?.worktreeFingerprint) !== sourceState.worktreeFingerprint)
  {
    fail('candidate inputs do not share one source/worktree identity')
  }
  const { registry, producer } = authority(repositoryRoot, claims.producerId)
  const classes = [...new Set(Object.values(producer.requiredObservations).flat())].sort()
  if (!isPlainObject(observationPaths) || JSON.stringify(Object.keys(observationPaths).sort()) !== JSON.stringify(classes))
  {
    fail('candidate plan must bind exact-one output path for every canonical observation class')
  }
  const observations = classes.map((classId) => {
    const receiptPath = String(observationPaths[classId] ?? '')
    if (!canonicalCurrentRunJsonPath(receiptPath)) fail(`${classId} receipt path is not canonical repository-relative current-run JSON`)
    return { classId, schema: registry.observationClasses[classId].schema, receiptPath, requiredModes: requiredModes(producer, classId) }
  })
  if (new Set(observations.map(({ receiptPath }) => receiptPath)).size !== observations.length)
  {
    fail('candidate plan observation output paths must be exact-one per class')
  }
  const identityAuthorityRefs = produceIdentityAuthorities({
    candidateContext: run,
    outputDirectory: identityAuthorityDirectory,
    repositoryRoot
  })
  return seal({
    schema: candidatePlanSchema,
    producerId: producer.producerId,
    registryBinding: currentRegistryBinding(repositoryRoot, producer.producerId),
    sourceState,
    build,
    candidate: stable(run.candidate),
    preRuntimeReceiptRef: receiptReference(preInput, 'pre-runtime receipt'),
    acceptedClaimsReceiptRef: receiptReference(claimsInput, 'accepted claims receipt'),
    buildReceiptRef: receiptReference(buildInput, 'production build receipt'),
    candidateContextRef: receiptReference(runInput, 'candidate context'),
    identityAuthorityRefs,
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
  const { registry, producer } = authority(repositoryRoot, plan.producerId)
  if (plan.producerId !== producer.producerId) fail('candidate plan producer mismatch')
  if (JSON.stringify(stable(plan.registryBinding)) !== JSON.stringify(currentRegistryBinding(repositoryRoot, plan.producerId)))
  {
    fail('candidate plan registry/schema/tool identity binding mismatch')
  }
  const preInput = verifyReference(plan.preRuntimeReceiptRef, 'candidate plan pre-runtime receipt', repositoryRoot)
  assertPreRuntimeQualified(preInput.value)
  const claimsInput = verifyReference(plan.acceptedClaimsReceiptRef, 'candidate plan accepted claims receipt', repositoryRoot)
  const buildInput = verifyReference(plan.buildReceiptRef, 'candidate plan production build receipt', repositoryRoot)
  const contextInput = verifyReference(plan.candidateContextRef, 'candidate plan context receipt', repositoryRoot)
  const run = validateCandidateContext(contextInput.value, repositoryRoot)
  const claims = validateAcceptedClaims(claimsInput.value, { expectedRunId: run.candidate.runId, repositoryRoot })
  if (claims.producerId !== plan.producerId) fail('candidate plan accepted claims producer mismatch')
  const sourceState = {
    commit: preInput.value.sourceIdentity.commit,
    worktreeFingerprint: prefixedDigest(preInput.value.sourceIdentity.worktreeFingerprint)
  }
  verifyCurrentRepositoryIdentity(sourceState, repositoryRoot)
  const build = verifyProductionBuildInput(buildInput, sourceState, repositoryRoot)
  if (JSON.stringify(stable(plan.sourceState)) !== JSON.stringify(stable(sourceState))
    || JSON.stringify(stable(plan.build)) !== JSON.stringify(stable(build))
    || JSON.stringify(stable(plan.candidate)) !== JSON.stringify(stable(run.candidate))
    || plan.preRuntimeReceiptDigest !== prefixedDigest(preInput.value.contentDigest)
    || plan.acceptedClaimsReceiptDigest !== prefixedDigest(claims.contentDigest)
    || claims.sourceState.commit !== sourceState.commit
    || claims.sourceState.worktreeFingerprint !== sourceState.worktreeFingerprint
    || run.sourceState.commit !== sourceState.commit
    || run.sourceState.worktreeFingerprint !== sourceState.worktreeFingerprint)
  {
    fail('candidate plan upstream replay identity mismatch')
  }
  verifyIdentityAuthorities(plan.identityAuthorityRefs, run, repositoryRoot)
  const expected = [...new Set(Object.values(producer.requiredObservations).flat())].sort()
  const actual = (plan.observations ?? []).map(({ classId }) => classId).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('candidate plan observation closure mismatch')
  if (new Set((plan.observations ?? []).map(({ receiptPath }) => receiptPath)).size !== expected.length)
  {
    fail('candidate plan observation output paths must be exact-one per class')
  }
  for (const observation of plan.observations)
  {
    const definition = registry.observationClasses[observation.classId]
    if (observation.schema !== definition.schema
      || JSON.stringify([...(observation.requiredModes ?? [])].sort())
        !== JSON.stringify(requiredModes(producer, observation.classId)))
    {
      fail(`${observation.classId} candidate plan authority binding mismatch`)
    }
    if (!canonicalCurrentRunJsonPath(observation.receiptPath))
    {
      fail(`${observation.classId} candidate plan path is not canonical repository-relative current-run JSON`)
    }
  }
  return plan
}
