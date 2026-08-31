#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
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
import { verifyReceipt as verifyProbeReceipt } from './runtime-observation-probes.mjs'

const probeClasses = new Set([
  'route-response-error',
  'cache-search-outbox-convergence',
  'session-cookie-runtime'
])
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const fail = (message) => { throw new Error(`[runtime-observation-raw] ${message}`) }
const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`
const bytesDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`

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

function fileReference(relative, repositoryRoot, label)
{
  const input = explicitJson(relative, label, repositoryRoot)
  const absolute = path.resolve(repositoryRoot, input.relative)
  return {
    value: input.value,
    ref: {
      path: input.relative,
      fileDigest: bytesDigest(absolute),
      contentDigest: input.value.contentDigest
    }
  }
}

function exactSource(plan, probe, buildReceipt, rawSchema, repositoryRoot)
{
  const source = probe.sourceState ?? {}
  if (source.sourceCommit !== plan.sourceState.commit
    || source.worktreeFingerprint !== plan.sourceState.worktreeFingerprint
    || source.buildIdentity !== plan.build.receiptContentDigest
    || source.runId !== plan.candidate.runId
    || source.attemptId !== plan.candidate.attemptId
    || probe.buildReceipt?.path !== plan.build.receipt
    || probe.buildReceipt?.contentDigest !== bytesDigest(path.resolve(repositoryRoot, plan.build.receipt))
    || buildReceipt.contentDigest !== plan.build.receiptContentDigest)
  {
    fail('probe, build, and candidate plan identities do not exact-match')
  }
  return {
    sourceCommit: plan.sourceState.commit,
    worktreeFingerprint: plan.sourceState.worktreeFingerprint,
    buildIdentity: plan.build.receiptContentDigest,
    candidateId: plan.candidate.candidateId,
    fixtureId: plan.candidate.fixtureId,
    profileId: plan.candidate.profileId,
    runtimeId: plan.candidate.runtimeId,
    browserIdentity: plan.candidate.browserId,
    releaseId: plan.candidate.releaseId,
    rolloutId: plan.candidate.rolloutId,
    runId: plan.candidate.runId,
    attemptId: plan.candidate.attemptId,
    producerId: plan.producerId,
    schemaIdentity: rawSchema,
    sourceReceiptSchemaIdentity: probe.schema,
    toolchainIdentity: semanticDigest(buildReceipt.toolchain ?? buildReceipt.producer)
  }
}

function routeFacts(facts)
{
  const byId = new Map(facts.cases.map((entry) => [entry.id, entry]))
  return {
    statusCode: byId.get('public-missing-typed-error').status,
    typedResult: byId.get('public-missing-typed-error').typedKind,
    protocolIdentity: 'aeds-v2',
    contentIdentity: semanticDigest(facts.cases.map(({ id, status, bodyDigest, typedPayloadDigest }) => ({
      id, status, bodyDigest, typedPayloadDigest
    }))),
    authSemantics: semanticDigest(facts.cases.filter(({ id }) => id.includes('auth') || id.includes('self'))),
    permissionSemantics: semanticDigest(facts.cases.filter(({ id }) => id.includes('admin'))),
    visibilitySemantics: semanticDigest(facts.cases.filter(({ id }) => id.includes('visible') || id.includes('missing'))),
    cacheSemantics: semanticDigest(facts.cases.filter(({ id }) => id.includes('cache') || id.includes('first-read'))),
    semanticMatch: facts.coherent
  }
}

function typedRouteFacts(facts)
{
  const byId = new Map(facts.cases.map((entry) => [entry.id, entry]))
  const missing = byId.get('public-missing-typed-error')
  return {
    requestIdentity: semanticDigest({ fixtureAuthority: facts.fixtureAuthority, caseIds: facts.cases.map(({ id }) => id) }),
    responseStatus: missing.status,
    typedPayloadDigest: missing.typedPayloadDigest,
    protocolIdentity: 'aeds-v2',
    authorizationDecision: semanticDigest(facts.cases.filter(({ id }) => id.includes('auth') || id.includes('self'))),
    visibilityState: semanticDigest(facts.cases.filter(({ id }) => id.includes('visible') || id.includes('missing'))),
    cacheSemanticsDigest: semanticDigest(facts.cases.filter(({ id }) => id.includes('cache') || id.includes('first-read'))),
    errorSemanticsDigest: semanticDigest(facts.cases.filter(({ typedKind }) => typedKind === 'typed-error'))
  }
}

function cacheFacts(facts, probe)
{
  return {
    authorityCoordinateDigest: semanticDigest(facts.authorityCoordinate),
    eventDigest: semanticDigest(facts.events),
    edgeDigest: semanticDigest(facts.edges),
    generationDigest: semanticDigest(facts.generation),
    queryDigest: semanticDigest(facts.query),
    readModelDigest: semanticDigest(facts.readModel),
    outputDigest: semanticDigest(facts.output),
    terminalReceiptDigest: probe.contentDigest,
    terminalState: facts.terminal.state,
    coherent: facts.coherent
  }
}

function typedCacheFacts(facts, probe)
{
  return {
    authorityCoordinates: semanticDigest(facts.authorityCoordinate),
    eventDigest: semanticDigest(facts.events),
    edgeDigest: semanticDigest(facts.edges),
    generation: semanticDigest(facts.generation),
    queryDigest: semanticDigest(facts.query),
    readModelDigest: semanticDigest(facts.readModel),
    outputDigest: semanticDigest(facts.output),
    terminalReceiptDigest: probe.contentDigest
  }
}

function sessionFacts(facts)
{
  return {
    databaseSessionDigest: facts.database.sessionDigest,
    credentialDigest: semanticDigest(facts.credential),
    authContextDigest: facts.authContext.digest,
    jwtDigest: facts.jwt.claimsDigest,
    cookieDigest: facts.cookie.digest,
    storageClaimsDigest: semanticDigest({
      databaseSessionId: facts.database.sessionIdDigest,
      cookieNames: facts.cookie.names,
      serviceStatus: facts.service.status
    }),
    expiryDigest: facts.expiry.digest,
    revisionDigest: facts.revision.digest,
    deviceDigest: facts.device.digest,
    serviceResultDigest: facts.service.digest,
    coherent: facts.coherent
  }
}

function typedSessionFacts(facts)
{
  return {
    databaseSessionDigest: facts.database.sessionDigest,
    credentialDigest: semanticDigest(facts.credential),
    authContextDigest: facts.authContext.digest,
    jwtClaimsDigest: facts.jwt.claimsDigest,
    cookieClaimsDigest: facts.cookie.digest,
    storageClaimsDigest: semanticDigest({
      databaseSessionId: facts.database.sessionIdDigest,
      cookieNames: facts.cookie.names,
      serviceStatus: facts.service.status
    }),
    expiry: facts.expiry.digest,
    revision: facts.revision.digest,
    deviceDigest: facts.device.digest,
    serviceResultDigest: facts.service.digest
  }
}

export function projectProbeRaw({ candidatePlan, probeReceipt, repositoryRoot = root })
{
  const planInput = fileReference(candidatePlan, repositoryRoot, 'candidate plan')
  const plan = validateCandidatePlan(planInput.value, { repositoryRoot })
  const probeInput = fileReference(probeReceipt, repositoryRoot, 'runtime observation probe')
  const probe = verifyProbeReceipt(probeInput.value)
  if (!probeClasses.has(probe.kind)) fail(`probe kind ${probe.kind ?? '<missing>'} has no raw projector`)
  const planned = plan.observations.find(({ classId }) => classId === probe.kind)
  if (!planned) fail(`candidate plan does not own ${probe.kind}`)
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  const producer = registry.producers.find(({ producerId }) => producerId === plan.producerId)
  if (!producer) fail('candidate plan producer is absent from registry')
  const definition = registry.observationClasses[probe.kind]
  const build = explicitJson(plan.build.receipt, 'production build receipt', repositoryRoot).value
  const legacySourceState = exactSource(plan, probe, build, definition.schema, repositoryRoot)
  const typedEnvelope = Array.isArray(definition.requiredSemanticFactFields)
  const semanticFacts = probe.kind === 'route-response-error'
    ? typedEnvelope ? typedRouteFacts(probe.facts) : routeFacts(probe.facts)
    : probe.kind === 'cache-search-outbox-convergence'
      ? typedEnvelope ? typedCacheFacts(probe.facts, probe) : cacheFacts(probe.facts, probe)
      : typedEnvelope ? typedSessionFacts(probe.facts) : sessionFacts(probe.facts)
  const sourceState = observationSourceState({
    plan,
    artifactDigest: semanticDigest(probe.facts),
    repositoryRoot,
    legacy: legacySourceState
  })
  const canonicalRerunCommand = probe.provenance.rerunCommand
  const independentVerifyCommand = `node tools/test-evidence/runtime-observation-raw.mjs verify --receipt ${planned.receiptPath}`
  return seal({
    schema: definition.schema,
    producerId: plan.producerId,
    toolVersion: producer.toolVersion,
    sourceState,
    executionClass: 'correctness',
    evidenceClass: 'correctness',
    qualificationEligible: true,
    planned: true,
    executed: true,
    outcome: 'passed',
    recovered: false,
    modes: planned.requiredModes,
    terminal: { timeout: false, cancelled: false, processTreeTerminated: false, priorAttemptDigest: null },
    semanticFacts,
    ...observationEnvelopeAuthorityFields({ plan, candidatePlanRef: planInput.ref, repositoryRoot }),
    sourceReceiptRef: observationSourceReceipt({
      classId: probe.kind, plan, sourceState, upstreamRef: probeInput.ref,
      upstreamSchema: probeInput.value.schema,
      canonicalRerunCommand, independentVerifyCommand, repositoryRoot
    }),
    canonicalRerunCommand,
    independentVerifyCommand
  })
}

export function verifyProjectedRaw(receiptPath, repositoryRoot = root, candidatePlan = null)
{
  const input = fileReference(receiptPath, repositoryRoot, 'projected raw receipt')
  const receipt = input.value
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  const receiptClass = Object.entries(registry.observationClasses)
    .find(([, definition]) => definition.schema === receipt.schema)?.[0]
  if (!probeClasses.has(receiptClass))
  {
    fail('projected receipt schema is not owned by a real runtime probe')
  }
  validateProducerReceiptAgainstRegistry({
    registry, producerId: receipt.producerId, receipt, classId: receiptClass, repositoryRoot
  })
  for (const reference of [receipt.sourceReceiptRef])
  {
    const current = fileReference(reference?.path, repositoryRoot, 'projected dependency')
    if (!digestPattern.test(String(reference?.fileDigest ?? ''))
      || current.ref.fileDigest !== reference.fileDigest
      || current.ref.contentDigest !== reference.contentDigest)
    {
      fail(`projected dependency digest mismatch: ${reference?.path ?? '<missing>'}`)
    }
  }
  const planPath = candidatePlanPathForObservation(receipt, candidatePlan)
  const replay = projectProbeRaw({
    candidatePlan: planPath,
    probeReceipt: observationUpstreamPath(receipt, repositoryRoot),
    repositoryRoot
  })
  if (replay.contentDigest !== receipt.contentDigest) fail('projected raw replay mismatch')
  return receipt
}

function main()
{
  const parsed = options(process.argv.slice(2))
  if (parsed.command === 'project-probe')
  {
    const receipt = projectProbeRaw({ candidatePlan: parsed['candidate-plan'], probeReceipt: parsed.probe })
    const plan = explicitJson(parsed['candidate-plan'], 'candidate plan', root).value
    const probeKind = explicitJson(parsed.probe, 'probe receipt', root).value.kind
    const planned = plan.observations.find(({ classId }) => classId === probeKind)
    const output = parsed.out ?? planned?.receiptPath
    if (!output || output !== planned?.receiptPath)
    {
      fail('raw output path must exact-match the candidate plan')
    }
    writeReceipt(output, receipt, root)
    verifyProjectedRaw(output, root, parsed['candidate-plan'])
    process.stdout.write(`[runtime-observation-raw] projected path=${output} digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'verify')
  {
    const receipt = verifyProjectedRaw(parsed.receipt, root, parsed['candidate-plan'])
    process.stdout.write(`[runtime-observation-raw] verified schema=${receipt.schema} digest=${receipt.contentDigest}\n`)
    return
  }
  fail('usage: project-probe --candidate-plan <path> --probe <path> --out <planned-path> or verify --receipt <path>')
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
