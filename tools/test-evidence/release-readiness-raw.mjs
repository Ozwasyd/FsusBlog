#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import {
  explicitJson,
  seal,
  validateCandidatePlan,
  writeReceipt
} from '../fact-extractors/post-runtime/adapter.mjs'
import { validateReleaseManifest } from '../release/release-manifest.mjs'
import { root } from '../test-matrix/post-runtime-producer-registry.mjs'

export const releaseReadinessSourceSchema = 'fsusblog.release-identity-readiness-current-run.v1'
export const releaseReadinessObservationSchema = 'fsusblog.observation.release-identity-readiness.v1'

const digestPattern = /^sha256:[a-f0-9]{64}$/u
const commitPattern = /^[a-f0-9]{40}$/u
const releaseIdPattern = /^\d{14}-[a-f0-9]{12}$/u
const forbiddenPathPattern = /(?:^|[/\\])(?:docs|latest|history|historical)(?:[/\\]|$)/iu
const forbiddenSensitiveKeyPattern = /(?:password|passwd|privatekey|secret|access[_-]?token|refresh[_-]?token)$/iu
const fail = (message) => { throw new Error(`[release-readiness-raw] ${message}`) }
const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`
const bytesDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`

const observationSchemas = Object.freeze({
  image: 'fsusblog.release-readiness.image.v1',
  package: 'fsusblog.release-readiness.package.v1',
  config: 'fsusblog.release-readiness.config.v1',
  databaseSchema: 'fsusblog.release-readiness.database-schema.v1',
  signing: 'fsusblog.release-readiness.signing.v1',
  trust: 'fsusblog.release-readiness.trust.v1',
  readiness: 'fsusblog.release-readiness.semantic-probes.v1',
  runtimeRole: 'fsusblog.release-readiness.runtime-role.v1'
})

const readinessChecks = Object.freeze({
  service: 'runtime-health-contract',
  routeData: 'route-data-semantic-probe',
  cache: 'cache-coherence-probe',
  dependencies: 'dependency-version-probe',
  version: 'runtime-version-inspect',
  credential: 'credential-capability-probe'
})

function exactKeys(value, keys, label)
{
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail(`${label} fields are incomplete or unsupported`)
  return value
}

function requireDigest(value, label)
{
  if (!digestPattern.test(String(value ?? ''))) fail(`${label} must be sha256:<64 lowercase hex>`)
  return value
}

function requireString(value, label)
{
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is required`)
  return value
}

function verifySeal(value, label)
{
  requireDigest(value?.contentDigest, `${label}.contentDigest`)
  const { contentDigest: ignored, ...payload } = value
  if (seal(payload).contentDigest !== value.contentDigest) fail(`${label} contentDigest mismatch`)
}

function assertPrivacySafe(value, label, seen = new Set())
{
  if (value === null || value === undefined || typeof value !== 'object')
  {
    if (typeof value === 'string' && /(?:authorization:\s*(?:bearer|basic)|cookie:\s*[^*]|-----BEGIN [A-Z ]+PRIVATE KEY-----)/iu.test(value))
    {
      fail(`${label} contains credential material`)
    }
    return
  }
  if (seen.has(value)) return
  seen.add(value)
  for (const [key, nested] of Object.entries(value))
  {
    if (forbiddenSensitiveKeyPattern.test(key)) fail(`${label} contains forbidden sensitive field ${key}`)
    assertPrivacySafe(nested, `${label}.${key}`, seen)
  }
}

function currentJson(relative, label, repositoryRoot)
{
  if (typeof relative !== 'string' || forbiddenPathPattern.test(relative))
  {
    fail(`${label} must not read documentation or latest/history paths`)
  }
  const input = explicitJson(relative, label, repositoryRoot)
  const absolute = path.resolve(repositoryRoot, input.relative)
  return {
    value: input.value,
    ref: {
      path: input.relative,
      fileDigest: bytesDigest(absolute),
      contentDigest: input.value?.contentDigest ?? null
    }
  }
}

function sourceState(value, plan)
{
  exactKeys(value, [
    'sourceCommit', 'worktreeFingerprint', 'buildIdentity', 'artifactDigest',
    'candidateId', 'releaseId', 'runtimeId', 'runId', 'attemptId', 'slot'
  ], 'sourceState')
  if (!commitPattern.test(String(value.sourceCommit ?? ''))) fail('sourceState.sourceCommit is invalid')
  requireDigest(value.worktreeFingerprint, 'sourceState.worktreeFingerprint')
  requireDigest(value.buildIdentity, 'sourceState.buildIdentity')
  requireDigest(value.artifactDigest, 'sourceState.artifactDigest')
  if (!releaseIdPattern.test(String(value.releaseId ?? ''))) fail('sourceState.releaseId is not canonical')
  if (!['blue', 'green'].includes(value.slot)) fail('sourceState.slot must be blue or green')
  for (const field of ['candidateId', 'runtimeId', 'runId', 'attemptId']) requireString(value[field], `sourceState.${field}`)
  const expected = {
    sourceCommit: plan.sourceState.commit,
    worktreeFingerprint: plan.sourceState.worktreeFingerprint,
    buildIdentity: plan.build.receiptContentDigest,
    candidateId: plan.candidate.candidateId,
    releaseId: plan.candidate.releaseId,
    runtimeId: plan.candidate.runtimeId,
    runId: plan.candidate.runId,
    attemptId: plan.candidate.attemptId
  }
  for (const [field, expectedValue] of Object.entries(expected))
  {
    if (value[field] !== expectedValue) fail(`sourceState.${field} does not exact-match candidate plan`)
  }
  return value
}

function provenance(value)
{
  exactKeys(value, [
    'schema', 'mode', 'collectorId', 'observedAtUtc', 'rerunCommand',
    'syntheticSemanticResult', 'diagnostic', 'recovered', 'historicalFallback'
  ], 'provenance')
  if (value.schema !== 'fsusblog.release-readiness-provenance.v1'
    || value.mode !== 'current-candidate-runtime'
    || value.collectorId !== 'release-readiness-runtime-probe')
  {
    fail('provenance does not identify the canonical current-runtime collector')
  }
  if (value.syntheticSemanticResult !== false || value.diagnostic !== false
    || value.recovered !== false || value.historicalFallback !== false)
  {
    fail('synthetic, diagnostic, recovered, or historical evidence cannot qualify')
  }
  if (!Number.isFinite(Date.parse(value.observedAtUtc)) || !String(value.observedAtUtc).endsWith('Z'))
  {
    fail('provenance.observedAtUtc must be an ISO UTC timestamp')
  }
  requireString(value.rerunCommand, 'provenance.rerunCommand')
  return value
}

function manifestReference(value, repositoryRoot, source, plan)
{
  exactKeys(value, ['path', 'fileDigest'], 'manifestRef')
  requireDigest(value.fileDigest, 'manifestRef.fileDigest')
  const input = currentJson(value.path, 'release manifest', repositoryRoot)
  if (input.ref.fileDigest !== value.fileDigest) fail('release manifest bytes changed after source observation')
  const errors = validateReleaseManifest(input.value, {
    requireRegistryDigest: true,
    requireConcreteRuntimeProfile: true,
    expectedReleaseId: source.releaseId,
    expectedImageDigest: input.value.imageDigest,
    expectedCommitSha: source.sourceCommit
  })
  if (errors.length > 0) fail(`release manifest is invalid: ${errors.join('; ')}`)
  if (input.value.releaseId !== plan.candidate.releaseId || input.value.commitSha !== plan.sourceState.commit)
  {
    fail('release manifest identity does not exact-match candidate plan')
  }
  return { manifest: input.value, ref: input.ref }
}

function buildFacts(plan, repositoryRoot)
{
  const build = currentJson(plan.build.receipt, 'production build receipt', repositoryRoot)
  if (build.value.contentDigest !== plan.build.receiptContentDigest
    || build.value.sourceState?.commit !== plan.sourceState.commit
    || String(build.value.sourceState?.worktreeFingerprint ?? '').replace(/^sha256:/u, '')
      !== plan.sourceState.worktreeFingerprint.replace(/^sha256:/u, ''))
  {
    fail('production build receipt does not exact-match candidate plan')
  }
  if (build.value.schema !== 'fsusblog.ci-production-build-receipt.v1' || build.value.status !== 'complete')
  {
    fail('production build receipt schema/status mismatch')
  }
  verifySeal(build.value, 'production build receipt')
  if (!Array.isArray(build.value.artifacts) || build.value.artifacts.length === 0) fail('production build has no artifact package')
  return {
    receipt: build,
    artifactDigest: semanticDigest(build.value.artifacts),
    packageDigest: semanticDigest({ domains: build.value.domains, artifacts: build.value.artifacts }),
    toolchainIdentity: semanticDigest(build.value.toolchain)
  }
}

function imageObservation(value, source, manifest)
{
  exactKeys(value, [
    'schema', 'releaseId', 'imageRef', 'imageDigest', 'registryDigest',
    'runtimeImageDigest', 'imageConfigDigest', 'registryInspected', 'verified'
  ], 'observations.image')
  if (value.schema !== observationSchemas.image) fail('observations.image schema mismatch')
  for (const field of ['imageDigest', 'registryDigest', 'runtimeImageDigest', 'imageConfigDigest'])
  {
    requireDigest(value[field], `observations.image.${field}`)
  }
  if (value.releaseId !== source.releaseId || value.imageRef !== manifest.imageRef
    || value.imageDigest !== manifest.imageDigest || value.registryDigest !== manifest.imageDigest
    || value.runtimeImageDigest !== manifest.imageDigest
    || value.registryInspected !== true || value.verified !== true)
  {
    fail('image registry/runtime identity is not exact')
  }
}

function packageObservation(value, source, manifest, build)
{
  exactKeys(value, [
    'schema', 'buildIdentity', 'artifactDigest', 'packageDigest', 'imageDigest',
    'artifactCount', 'verified'
  ], 'observations.package')
  if (value.schema !== observationSchemas.package) fail('observations.package schema mismatch')
  for (const field of ['buildIdentity', 'artifactDigest', 'packageDigest', 'imageDigest'])
  {
    requireDigest(value[field], `observations.package.${field}`)
  }
  if (value.buildIdentity !== source.buildIdentity || value.artifactDigest !== build.artifactDigest
    || value.packageDigest !== build.packageDigest || value.imageDigest !== manifest.imageDigest
    || value.artifactCount !== build.receipt.value.artifacts.length || value.verified !== true)
  {
    fail('package observation does not match production build and image')
  }
}

function configObservation(value, source)
{
  exactKeys(value, [
    'schema', 'releaseId', 'slot', 'expectedDigest', 'observedDigest',
    'publicProjectionDigest', 'redacted', 'secretValuesPersisted', 'verified'
  ], 'observations.config')
  if (value.schema !== observationSchemas.config) fail('observations.config schema mismatch')
  for (const field of ['expectedDigest', 'observedDigest', 'publicProjectionDigest'])
  {
    requireDigest(value[field], `observations.config.${field}`)
  }
  if (value.releaseId !== source.releaseId || value.slot !== source.slot
    || value.expectedDigest !== value.observedDigest || value.redacted !== true
    || value.secretValuesPersisted !== false || value.verified !== true)
  {
    fail('runtime config observation is mismatched or not privacy-safe')
  }
}

function schemaObservation(value, source, manifest)
{
  exactKeys(value, [
    'schema', 'releaseId', 'minimumCoordinate', 'maximumCoordinate',
    'observedCoordinate', 'schemaDigest', 'compatible', 'verified'
  ], 'observations.databaseSchema')
  if (value.schema !== observationSchemas.databaseSchema) fail('observations.databaseSchema schema mismatch')
  requireDigest(value.schemaDigest, 'observations.databaseSchema.schemaDigest')
  if (value.releaseId !== source.releaseId
    || value.minimumCoordinate !== manifest.schemaCompatibility.minimumCoordinate
    || value.maximumCoordinate !== manifest.schemaCompatibility.maximumCoordinate
    || !releaseIdPattern.test(String(value.observedCoordinate ?? ''))
    || value.observedCoordinate < value.minimumCoordinate || value.observedCoordinate > value.maximumCoordinate
    || value.compatible !== true || value.verified !== true)
  {
    fail('database schema coordinate is outside the release compatibility window')
  }
}

function signingObservation(value, manifestDigest)
{
  exactKeys(value, [
    'schema', 'algorithm', 'payloadDigest', 'signatureDigest',
    'signerIdentityDigest', 'verificationReceiptDigest', 'verified'
  ], 'observations.signing')
  if (value.schema !== observationSchemas.signing
    || !['cosign-keyless', 'sigstore-bundle'].includes(value.algorithm))
  {
    fail('signing observation schema/algorithm mismatch')
  }
  for (const field of ['payloadDigest', 'signatureDigest', 'signerIdentityDigest', 'verificationReceiptDigest'])
  {
    requireDigest(value[field], `observations.signing.${field}`)
  }
  if (value.payloadDigest !== manifestDigest || value.verified !== true) fail('release manifest signature was not verified')
}

function trustObservation(value, imageDigest, manifestDigest)
{
  exactKeys(value, [
    'schema', 'policyDigest', 'publisherIdentityDigest', 'decision',
    'artifactDigest', 'manifestDigest', 'transparencyLogDigest', 'verified'
  ], 'observations.trust')
  if (value.schema !== observationSchemas.trust) fail('observations.trust schema mismatch')
  for (const field of ['policyDigest', 'publisherIdentityDigest', 'artifactDigest', 'manifestDigest', 'transparencyLogDigest'])
  {
    requireDigest(value[field], `observations.trust.${field}`)
  }
  if (value.decision !== 'trusted' || value.artifactDigest !== imageDigest
    || value.manifestDigest !== manifestDigest || value.verified !== true)
  {
    fail('release trust decision does not bind the image and manifest')
  }
}

function runtimeRoleObservation(value, source)
{
  exactKeys(value, [
    'schema', 'releaseId', 'slot', 'runtimeId', 'topologyMode', 'deploymentMode',
    'processIdentityDigest', 'containerIdentityDigest', 'serviceIdentityDigest',
    'ownershipDigest', 'actualObservationSources', 'processCount', 'containerCount',
    'serviceCount', 'unknownOwnerCount', 'conflictingOwnerCount', 'observedRole',
    'roleContractSatisfied', 'monolithicOwnershipSatisfied'
  ], 'observations.runtimeRole')
  if (value.schema !== observationSchemas.runtimeRole) fail('observations.runtimeRole schema mismatch')
  for (const field of ['processIdentityDigest', 'containerIdentityDigest', 'serviceIdentityDigest', 'ownershipDigest'])
  {
    requireDigest(value[field], `observations.runtimeRole.${field}`)
  }
  const actualSources = ['container-runtime-inspect', 'proc-cgroup', 'service-manager-status']
  if (value.releaseId !== source.releaseId || value.slot !== source.slot || value.runtimeId !== source.runtimeId
    || value.topologyMode !== 'monolithic' || value.deploymentMode !== 'candidate'
    || JSON.stringify(value.actualObservationSources) !== JSON.stringify(actualSources)
    || !Number.isSafeInteger(value.processCount) || value.processCount < 1
    || value.containerCount !== 1 || value.serviceCount !== 1
    || value.unknownOwnerCount !== 0 || value.conflictingOwnerCount !== 0
    || value.observedRole !== 'candidate' || value.roleContractSatisfied !== true
    || value.monolithicOwnershipSatisfied !== true)
  {
    fail('runtime-role ownership is unknown, conflicting, inferred, or non-monolithic')
  }
}

function readinessObservation(value, source, anchors)
{
  exactKeys(value, [
    'schema', 'releaseId', 'slot', 'runtimeId', 'probeClass', 'checks',
    'processAliveOnly', 'portOpenOnly', 'http200Only', 'fileExistsOnly',
    'jobStatusOnly', 'terminalStatus'
  ], 'observations.readiness')
  if (value.schema !== observationSchemas.readiness || value.releaseId !== source.releaseId
    || value.slot !== source.slot || value.runtimeId !== source.runtimeId
    || value.probeClass !== 'semantic-contract' || value.terminalStatus !== 'verified')
  {
    fail('readiness observation identity/schema mismatch')
  }
  for (const shortcut of ['processAliveOnly', 'portOpenOnly', 'http200Only', 'fileExistsOnly', 'jobStatusOnly'])
  {
    if (value[shortcut] !== false) fail(`${shortcut} cannot qualify readiness`)
  }
  exactKeys(value.checks, Object.keys(readinessChecks), 'observations.readiness.checks')
  for (const [checkId, authority] of Object.entries(readinessChecks))
  {
    const check = value.checks[checkId]
    exactKeys(check, [
      'schema', 'authority', 'expectedDigest', 'observedDigest', 'sampleCount',
      'semanticMatch', 'status'
    ], `observations.readiness.checks.${checkId}`)
    if (check.schema !== `fsusblog.release-readiness.${checkId}.v1` || check.authority !== authority)
    {
      fail(`${checkId} readiness authority/schema mismatch`)
    }
    requireDigest(check.expectedDigest, `${checkId}.expectedDigest`)
    requireDigest(check.observedDigest, `${checkId}.observedDigest`)
    if (check.expectedDigest !== check.observedDigest || !Number.isSafeInteger(check.sampleCount)
      || check.sampleCount < 1 || check.semanticMatch !== true || check.status !== 'passed')
    {
      fail(`${checkId} readiness semantic observation did not match`)
    }
  }
  for (const [checkId, digest] of Object.entries(anchors))
  {
    if (value.checks[checkId].expectedDigest !== digest) fail(`${checkId} readiness is not bound to its authority digest`)
  }
}

export function validateReleaseReadinessSource(value, { candidatePlan, repositoryRoot = root } = {})
{
  const plan = validateCandidatePlan(candidatePlan, { repositoryRoot })
  exactKeys(value, [
    'schema', 'producerId', 'sourceState', 'provenance', 'manifestRef',
    'observations', 'contentDigest'
  ], 'release readiness source')
  if (value.schema !== releaseReadinessSourceSchema || value.producerId !== plan.producerId)
  {
    fail('release readiness source schema/producer mismatch')
  }
  verifySeal(value, 'release readiness source')
  assertPrivacySafe(value, 'release readiness source')
  const source = sourceState(value.sourceState, plan)
  provenance(value.provenance)
  const manifestInput = manifestReference(value.manifestRef, repositoryRoot, source, plan)
  const build = buildFacts(plan, repositoryRoot)
  if (source.artifactDigest !== build.artifactDigest) fail('sourceState.artifactDigest does not match production build package')
  exactKeys(value.observations, Object.keys(observationSchemas), 'observations')
  imageObservation(value.observations.image, source, manifestInput.manifest)
  packageObservation(value.observations.package, source, manifestInput.manifest, build)
  configObservation(value.observations.config, source)
  schemaObservation(value.observations.databaseSchema, source, manifestInput.manifest)
  signingObservation(value.observations.signing, manifestInput.ref.fileDigest)
  trustObservation(value.observations.trust, manifestInput.manifest.imageDigest, manifestInput.ref.fileDigest)
  runtimeRoleObservation(value.observations.runtimeRole, source)
  const versionDigest = semanticDigest({
    toolchain: manifestInput.manifest.toolchain,
    runtimeProfile: manifestInput.manifest.runtimeProfile
  })
  readinessObservation(value.observations.readiness, source, {
    service: value.observations.runtimeRole.serviceIdentityDigest,
    dependencies: value.observations.databaseSchema.schemaDigest,
    version: versionDigest,
    credential: value.observations.trust.policyDigest
  })
  return { source: value, plan, manifest: manifestInput, build, versionDigest }
}

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
    semanticFacts: facts,
    candidatePlanRef: planInput.ref,
    sourceReceiptRef: sourceInput.ref,
    manifestRef: manifest.ref,
    canonicalRerunCommand: source.provenance.rerunCommand,
    independentVerifyCommand: `node tools/test-evidence/release-readiness-raw.mjs verify --receipt ${planned.receiptPath}`
  })
}

export function verifyReleaseReadinessRaw(receiptPath, repositoryRoot = root)
{
  const input = currentJson(receiptPath, 'release readiness raw receipt', repositoryRoot)
  if (input.value.schema !== releaseReadinessObservationSchema) fail('raw receipt schema mismatch')
  verifySeal(input.value, 'release readiness raw receipt')
  for (const [label, reference] of [
    ['candidate plan', input.value.candidatePlanRef],
    ['source receipt', input.value.sourceReceiptRef],
    ['release manifest', input.value.manifestRef]
  ])
  {
    const current = currentJson(reference?.path, label, repositoryRoot)
    if (current.ref.fileDigest !== reference?.fileDigest
      || (reference?.contentDigest !== null && current.ref.contentDigest !== reference.contentDigest))
    {
      fail(`${label} digest mismatch after raw projection`)
    }
  }
  const replay = projectReleaseReadinessRaw({
    candidatePlan: input.value.candidatePlanRef.path,
    sourceReceipt: input.value.sourceReceiptRef.path,
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
    verifyReleaseReadinessRaw(output, root)
    process.stdout.write(`[release-readiness-raw] projected path=${output} digest=${receipt.contentDigest}\n`)
    return
  }
  if (parsed.command === 'verify')
  {
    const receipt = verifyReleaseReadinessRaw(parsed.receipt, root)
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
