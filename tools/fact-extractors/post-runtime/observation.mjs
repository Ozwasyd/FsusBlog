import { BehaviorId } from '../../contracts/behavior-contract-catalog.mjs'
import { validateProducerReceiptAgainstRegistry } from '../../test-matrix/post-runtime-producer-registry.mjs'
import { isPlainObject, stable } from '../lib/canonicalize.mjs'
import { validateCandidatePlan } from './candidate.mjs'
import {
  authority,
  classReceiptSchema,
  defaultRoot,
  explicitJson,
  fail,
  observationReceiptSchema,
  prefixedDigest,
  receiptReference,
  seal,
  validateAcceptedClaims,
  verifyReference,
  verifySeal,
  writeReceipt
} from './common.mjs'
import { validateSemanticFacts } from './semantic-contracts.mjs'

export function produceClassReceipt({ candidatePlan, classId, result, repositoryRoot = defaultRoot })
{
  const planInput = explicitJson(candidatePlan, 'candidate plan', repositoryRoot)
  const plan = validateCandidatePlan(planInput.value, { repositoryRoot })
  const input = explicitJson(result, `${classId} result`, repositoryRoot)
  const { registry, producer } = authority(repositoryRoot)
  const definition = registry.observationClasses[classId]
  if (!definition) fail(`unknown observation class ${classId}`)
  validateProducerReceiptAgainstRegistry({
    registry, producerId: producer.producerId, receipt: input.value, classId, repositoryRoot
  })
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
    runtimeId: plan.candidate.runtimeId,
    runId: plan.candidate.runId,
    attemptId: plan.candidate.attemptId,
    fixtureId: plan.candidate.fixtureId,
    profileId: plan.candidate.profileId,
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
  if (!Array.isArray(definition.requiredSemanticFactFields))
  {
    validateSemanticFacts(classId, input.value.semanticFacts)
  }
  return seal({
    schema: classReceiptSchema,
    classId,
    observationSchema: definition.schema,
    producerId: producer.producerId,
    sourceState: plan.sourceState,
    candidatePlanDigest: plan.contentDigest,
    candidatePlanRef: receiptReference(planInput, 'candidate plan'),
    buildReceiptDigest: plan.build.receiptContentDigest,
    candidate: plan.candidate,
    modes,
    semanticFacts: stable(input.value.semanticFacts),
    rawResultRef: { ...receiptReference(input, `${classId} raw result`), role: 'raw-result' },
    status: 'qualified'
  })
}

export function validateClassReceipt(receipt, { repositoryRoot = defaultRoot } = {})
{
  if (receipt?.schema !== classReceiptSchema || receipt.status !== 'qualified')
  {
    fail('class receipt schema/status mismatch')
  }
  verifySeal(receipt, `class receipt ${receipt.classId ?? '<missing>'}`)
  const planInput = verifyReference(receipt.candidatePlanRef, 'class receipt candidate plan', repositoryRoot)
  const rawReference = receipt.rawResultRef
  if (!isPlainObject(rawReference)
    || rawReference.role !== 'raw-result'
    || JSON.stringify(Object.keys(rawReference).sort())
      !== JSON.stringify(['contentDigest', 'fileDigest', 'path', 'role', 'schema']))
  {
    fail(`${receipt.classId ?? 'unknown'} raw result reference shape is invalid`)
  }
  const rawInput = verifyReference(
    Object.fromEntries(Object.entries(rawReference).filter(([key]) => key !== 'role')),
    `${receipt.classId ?? 'unknown'} raw result`,
    repositoryRoot
  )
  if (rawInput.value.schema !== receipt.observationSchema)
  {
    fail(`${receipt.classId ?? 'unknown'} raw result schema mismatch`)
  }
  const replay = produceClassReceipt({
    candidatePlan: planInput.relative,
    classId: receipt.classId,
    result: rawInput.relative,
    repositoryRoot
  })
  if (replay.contentDigest !== receipt.contentDigest) fail(`${receipt.classId} class receipt replay mismatch`)
  return receipt
}

export function produceObservationReceipt({ scope, candidatePlan, acceptedClaimsReceipt, classReceipts, repositoryRoot = defaultRoot })
{
  const planInput = explicitJson(candidatePlan, 'candidate plan', repositoryRoot)
  const plan = validateCandidatePlan(planInput.value, { repositoryRoot })
  const claimsInput = explicitJson(acceptedClaimsReceipt, 'accepted claims receipt', repositoryRoot)
  const claims = validateAcceptedClaims(claimsInput.value, { expectedRunId: plan.candidate.runId, repositoryRoot })
  if (claims.contentDigest !== plan.acceptedClaimsReceiptDigest) fail('accepted claims do not match candidate plan')
  const scopeClasses = scope === 'application'
    ? ['aot-spa-hydration', 'browser-behavior-contract', 'cache-search-outbox-convergence', 'route-response-error', 'session-cookie-runtime']
    : scope === 'release-deployment'
      ? ['blue-green-containment', 'release-identity-readiness']
      : fail(`unknown observation scope ${scope}`)
  const receiptInputs = classReceipts.map((entry, index) => explicitJson(entry, `class receipt ${index}`, repositoryRoot))
  for (const { value: receipt } of receiptInputs)
  {
    validateClassReceipt(receipt, { repositoryRoot })
    if (receipt.candidatePlanDigest !== plan.contentDigest) fail(`${receipt.classId} candidate plan mismatch`)
  }
  if (JSON.stringify(receiptInputs.map(({ value }) => value.classId).sort()) !== JSON.stringify(scopeClasses.sort()))
  {
    fail(`${scope} class receipt closure must be exact-one`)
  }
  return seal({
    schema: observationReceiptSchema,
    scope,
    behaviorId: BehaviorId('browserless-production-correctness'),
    producerId: plan.producerId,
    sourceState: plan.sourceState,
    candidate: plan.candidate,
    build: plan.build,
    buildReceiptDigest: plan.build.receiptContentDigest,
    candidatePlanDigest: plan.contentDigest,
    candidatePlanRef: receiptReference(planInput, 'candidate plan'),
    preRuntimeReceiptDigest: plan.preRuntimeReceiptDigest,
    acceptedClaimsReceiptDigest: claims.contentDigest,
    acceptedClaimsReceiptRef: receiptReference(claimsInput, 'accepted claims receipt'),
    acceptedClaimRefs: claims.claims.map(({ claimId }) => claimId).sort(),
    requiredClasses: [...scopeClasses].sort(),
    observedClasses: receiptInputs.map(({ value }) => value.classId).sort(),
    observations: receiptInputs.sort((left, right) => left.value.classId.localeCompare(right.value.classId))
      .map((input) => ({
        classId: input.value.classId,
        receiptDigest: input.value.contentDigest,
        classReceiptRef: { ...receiptReference(input, `${input.value.classId} class receipt`), role: 'class' },
        modes: input.value.modes,
        rawResultRef: input.value.rawResultRef,
        semanticFacts: input.value.semanticFacts
      })),
    status: 'qualified',
    failureReasons: []
  })
}

export function validateObservationReceipt(receipt, { repositoryRoot = defaultRoot } = {})
{
  if (receipt?.schema !== observationReceiptSchema || receipt.status !== 'qualified')
  {
    fail('observation receipt schema/status mismatch')
  }
  verifySeal(receipt, 'observation receipt')
  const plan = verifyReference(receipt.candidatePlanRef, 'observation candidate plan', repositoryRoot)
  const claims = verifyReference(receipt.acceptedClaimsReceiptRef, 'observation accepted claims', repositoryRoot)
  const observations = Array.isArray(receipt.observations) ? receipt.observations : []
  const classPaths = observations.map((observation) => {
    const reference = observation?.classReceiptRef
    if (!isPlainObject(reference)
      || reference.role !== 'class'
      || JSON.stringify(Object.keys(reference).sort())
        !== JSON.stringify(['contentDigest', 'fileDigest', 'path', 'role', 'schema']))
    {
      fail(`${observation?.classId ?? 'unknown'} class receipt reference shape is invalid`)
    }
    const input = verifyReference(Object.fromEntries(Object.entries(reference).filter(([key]) => key !== 'role')),
      `${observation.classId} class receipt`, repositoryRoot)
    if (input.value.schema !== classReceiptSchema
      || input.value.classId !== observation.classId
      || input.value.contentDigest !== observation.receiptDigest)
    {
      fail(`${observation.classId} class receipt reference identity mismatch`)
    }
    return reference.path
  })
  const replay = produceObservationReceipt({
    scope: receipt.scope,
    candidatePlan: plan.relative,
    acceptedClaimsReceipt: claims.relative,
    classReceipts: classPaths,
    repositoryRoot
  })
  if (replay.contentDigest !== receipt.contentDigest) fail('observation receipt replay mismatch')
  return receipt
}

export function runObservationCli({ argv, scope, repositoryRoot = defaultRoot })
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
  if (command === 'verify')
  {
    const actual = explicitJson(options.receipt, 'observation receipt', repositoryRoot).value
    const validated = validateObservationReceipt(actual, { repositoryRoot })
    if (validated.scope !== scope) fail(`observation receipt scope does not match ${scope} verifier`)
    return validated
  }
  if (command !== 'produce') fail('command must be produce or verify')
  const produced = produceObservationReceipt({ scope, ...options, repositoryRoot })
  if (!options.out) fail('observation production requires an explicit current-run output path')
  writeReceipt(options.out, produced, repositoryRoot)
  return produced
}
