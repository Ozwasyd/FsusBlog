#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  candidatePlanPathForObservation,
  observationEnvelopeAuthorityFields,
  observationSourceReceipt,
  observationSourceState,
  observationUpstreamPath,
  seal,
  writeReceipt
} from '../fact-extractors/post-runtime/adapter.mjs'
import {
  loadPostRuntimeProducerRegistry,
  root,
  validateProducerReceiptAgainstRegistry
} from '../test-matrix/post-runtime-producer-registry.mjs'
import { crossValidate } from './blue-green-containment-cross-validation.mjs'
import { loadSources } from './blue-green-containment-observations.mjs'
import {
  bytesDigest,
  classId,
  fail,
  failureReceiptSchema,
  forbiddenPathPattern,
  planContext,
  privacySafeMessage,
  roles,
  safeInput,
  semanticDigest,
  sourceBundleSchema,
  verifySeal
} from './blue-green-containment-support.mjs'
import { verifyCanonicalReleaseAuthorities } from './canonical-release-authorities.mjs'
import { deriveBlueGreenAuthorityFacts } from './release-authority-facts-contract.mjs'
import {
  buildBlueGreenAuthorityBundle,
  canonicalAuthorityBundleSchema
} from './release-authority-bundle-contract.mjs'
export { canonicalAuthorityBundleSchema } from './release-authority-bundle-contract.mjs'
export {
  failureReceiptSchema,
  sourceBundleSchema,
  sourceReceiptSchema
} from './blue-green-containment-support.mjs'

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
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  if (registry.observationClasses['blue-green-containment'].sourceReceipt.schema
    === canonicalAuthorityBundleSchema)
  {
    fail('legacy blue-green source cannot satisfy the required native authority bundle')
  }
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
  currentSchemaReceiptRef,
  output,
  repositoryRoot = root
})
{
  const context = planContext(candidatePlan, repositoryRoot)
  const authorities = verifyCanonicalReleaseAuthorities({
    candidatePlan: context.plan, rolloutEvidence, runtimeRoleAdmission, currentSchemaReceiptRef, repositoryRoot
  })
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  const producer = registry.producers.find(({ producerId }) => producerId === context.plan.producerId)
  const { rawFacts } = deriveBlueGreenAuthorityFacts({ authorities })
  const sourceState = observationSourceState({
    classId, plan: context.plan, artifactDigest: authorities.authorityDigest, repositoryRoot
  })
  return buildBlueGreenAuthorityBundle({ candidatePlan, context, authorities, producer, sourceState, rawFacts, output })
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
    currentSchemaReceiptRef: source.value.currentSchemaReceiptRef,
    repositoryRoot
  })
  for (const [label, expected, actual] of [
    ['rollout', source.value.rolloutEvidenceRef, authorities.rollout.ref],
    ['runtime-role', source.value.runtimeRoleAdmissionRef, authorities.runtimeRole.admission.ref]
  ])
  {
    const contentDigest = actual.contentDigest?.startsWith('sha256:')
      ? actual.contentDigest : `sha256:${actual.contentDigest}`
    if (expected?.fileDigest !== actual.fileDigest || expected?.contentDigest !== contentDigest)
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
  const { legacyFacts, typedFacts } = deriveBlueGreenAuthorityFacts({ authorities })
  const semanticFacts = Array.isArray(registry.observationClasses[classId].requiredSemanticFactFields)
    ? typedFacts
    : legacyFacts
  const sourceState = observationSourceState({
    classId,
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
  })
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const canonicalRerunCommand = `node tools/test-evidence/blue-green-containment-raw.mjs produce-authorities --candidate-plan ${quote(candidatePlan)} --source ${quote(source.ref.path)} --out ${quote(context.planned.receiptPath)}`
  const independentVerifyCommand = `node tools/test-evidence/blue-green-containment-raw.mjs verify --candidate-plan ${quote(candidatePlan)} --receipt ${quote(context.planned.receiptPath)}`
  return seal({
    schema: context.definition.schema,
    producerId: context.plan.producerId,
    toolVersion: context.toolVersion,
    sourceState,
    executionClass: 'correctness', evidenceClass: 'correctness', qualificationEligible: true,
    planned: true, executed: true, outcome: 'passed', recovered: false,
    modes: context.planned.requiredModes,
    terminal: { timeout: false, cancelled: false, processTreeTerminated: false, priorAttemptDigest: null },
    semanticFacts,
    ...observationEnvelopeAuthorityFields({
      plan: context.plan, candidatePlanRef: context.candidatePlanRef, repositoryRoot
    }),
    sourceReceiptRef: observationSourceReceipt({
      classId, plan: context.plan, sourceState, upstreamRef: source.ref,
      canonicalRerunCommand, independentVerifyCommand, repositoryRoot
    }),
    canonicalRerunCommand,
    independentVerifyCommand
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
  const upstreamPath = observationUpstreamPath(receipt, repositoryRoot)
  const source = safeInput(upstreamPath, repositoryRoot, 'blue-green source receipt')
  const replay = source.value.schema === canonicalAuthorityBundleSchema
    ? produceBlueGreenAuthoritiesRaw({
        candidatePlan: planPath,
        sourceReceipt: upstreamPath,
        repositoryRoot
      })
    : produceBlueGreenContainmentRaw({
        candidatePlan: planPath,
        sourceReceipt: upstreamPath,
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
      runtimeRoleAdmission: parsed['runtime-role-admission'],
      currentSchemaReceiptRef: {
        path: parsed['current-schema-receipt'],
        fileDigest: parsed['current-schema-file-digest'],
        contentDigest: parsed['current-schema-content-digest'],
        schema: 'fsusblog.current-schema-receipt.v1'
      },
      output: parsed.out,
      repositoryRoot: root
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
