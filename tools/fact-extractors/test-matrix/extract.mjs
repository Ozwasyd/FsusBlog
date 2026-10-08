import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isExternalBehaviorDocAdmissionDependency
} from '../../test-matrix/behavior-doc-static-admission-contract.mjs'
import { parseMatrix, tierExecutionDependencies } from '../../test-matrix/parse-matrix.mjs'
import { digestText, digestValue } from '../lib/canonicalize.mjs'
import {
  resolveContainedPath
} from '../identity.mjs'
import {
  hostDeclarations,
  minimalContractSourceClosureDigests,
  removeRuntimeRoleVerificationBuild,
  reproduceRuntimeRoleAssembly,
  runtimeReproduciblePathMapArgument
} from '../../docs/behavior-doc-minimal-contract-build.mjs'
import {
  resolveDockerComposeOracleIdentity
} from '../../governance/check-monolithic-distributed-architecture.mjs'
import {
  abortGatewayTransition,
  beginGatewayTransition,
  createEmptySlotState,
  markGatewayRollbackRequired,
  recordSlotStart,
  recordSlotStop,
  reserveRuntimeGeneration,
  setActiveSlot,
  SLOT_STATE_SCHEMA,
  validateSlotState
} from '../../deployment/slot-lib.mjs'
import {
  createRolloutState,
  failRolloutStage,
  ROLLOUT_SCHEMA,
  ROLLOUT_STAGES,
  startRolloutStage
} from '../../deployment/release-rollout-lib.mjs'
import { planReleaseAssetGc, RELEASE_GC_STATE_SCHEMA } from '../../storage/release-gc.mjs'
import { RELEASE_ASSET_MANIFEST_SCHEMA } from '../../storage/release-assets.mjs'
import {
  assertUnsupportedOperation,
  validateDestructiveOperationAuthority,
  verifyArtifactGcActiveIdentity
} from '../../deployment/destructive-operation-authority.mjs'
import {
  buildReleaseFinalizerPlan,
  validateCanonicalReleaseFinalEvidenceInputs
} from '../../test-matrix/release-final-evidence-contract.mjs'
import { validateRequiredEvidenceCatalog } from '../../test-matrix/required-evidence-catalog.mjs'
import { adaptReleaseFinalizerSemanticOutcome } from '../../test-matrix/outcomes/release-finalizer-adapter.mjs'
import { postRuntimeReceiptSchema } from '../../test-matrix/behavior-evidence-post-runtime.mjs'

const requiredFactKeys = Object.freeze([
  'test.topology.profiles',
  'test.topology.tiers',
  'test.topology.bundles',
  'test.topology.dependencies',
  'test.topology.command-groups',
  'test.topology.blocking-stages',
  'test.execution-classes',
  'test.evidence-classes',
  'test.static-governance.membership',
  'test.candidate-admission-predecessors',
  'release-final.finalizer-authority',
  'release-final.required-input-schemas',
  'release-final.output-schema',
  'release-final.summary-tiers',
  'release-final.aggregate-contract',
  'deployment.runtime-role-contract',
  'deployment.blue-green-contract',
  'production-fresh.bundle-ordering'
])

const declaredFactSources = Object.freeze([
  'tests/matrix.yml',
  'tests/matrix.schema.json',
  'tests/coverage-registry.json',
  'config/testing/producer-execution-class-contract.json',
  'tools/test-matrix/behavior-doc-static-admission-contract.mjs',
  'tests/governance/monolithic-distributed-architecture.json',
  'src/backend/FsusBlog.Server.csproj',
  'ops/docker/FsusBlog.Server.Dockerfile',
  'ops/docker/docker-compose.production.yml',
  'tools/governance/check-monolithic-distributed-architecture.mjs',
  'config/deployment/destructive-operation-authority.json',
  'tools/deployment/destructive-operation-authority.mjs',
  'src/migration',
  'src/backend/Infrastructure/SchemaMigration',
  'src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationCompatibility.cs'
])

const consumerInputs = Object.freeze([
  'tools/test/lanes',
  'src/frontend/package.json',
  'tools/docs/generate-testing-docs.mjs',
  'tools/test/lanes/release-final.sh'
])

function failResult(reasons)
{
  return {
    status: 'failed',
    failureReasons: reasons.map(String),
    observations: {}
  }
}

function sha256(bytes)
{
  return createHash('sha256').update(bytes).digest('hex')
}

function exactKeys(value, expected)
{
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
}

function readBoundArtifact(repositoryRoot, relative, label)
{
  const absolute = resolveContainedPath(repositoryRoot, relative, 'file')
  return { absolute, bytes: readFileSync(absolute) }
}

const verifiedRuntimeAttestations = new Map()

function verifyRuntimeReproducibleBuild(repositoryRoot, runtimeBinding, minimalReceipt)
{
  const attestation = runtimeBinding.buildReceipt?.reproducibleBuild
  const expectedKeys = [
    'schema', 'project', 'command', 'outputRoot', 'assemblyPath', 'assemblyDigest',
    'sourceClosureDigest'
  ]
  const expectedOutputRoot = `.tmp/runtime-role-reproducible-builds/${minimalReceipt.buildKey}`
  const expectedCommand = [
    'dotnet', 'build', runtimeBinding.project, '--configuration', 'Release',
    '--no-incremental', '--disable-build-servers', '--artifacts-path', expectedOutputRoot,
    '/p:Deterministic=true', '/p:ContinuousIntegrationBuild=true',
    runtimeReproduciblePathMapArgument,
    '/p:NuGetAudit=false', '/m:1'
  ]
  if (!exactKeys(attestation, expectedKeys)
    || attestation.schema !== 'fsusblog.runtime-role-reproducible-build-attestation.v1'
    || attestation.project !== runtimeBinding.project
    || attestation.outputRoot !== expectedOutputRoot
    || attestation.assemblyPath !== runtimeBinding.assemblyPath
    || attestation.assemblyDigest !== runtimeBinding.assemblyDigest
    || attestation.sourceClosureDigest !== digestValue(minimalReceipt.sourceClosureDigests)
    || JSON.stringify(attestation.command) !== JSON.stringify(expectedCommand))
  {
    throw new Error('runtime-role reproducible build attestation is not exact')
  }
  const trustedKey = digestValue({
    sourceCommit: minimalReceipt.sourceCommit,
    worktreeFingerprint: minimalReceipt.worktreeFingerprint,
    project: runtimeBinding.project,
    projectDigest: runtimeBinding.projectDigest
  })
  const previouslyVerified = verifiedRuntimeAttestations.get(trustedKey)
  if (previouslyVerified !== undefined)
  {
    if (previouslyVerified !== runtimeBinding.assemblyDigest)
    {
      throw new Error('runtime-role assembly differs from the independently verified upstream build')
    }
    return
  }
  let reproduced
  try
  {
    reproduced = reproduceRuntimeRoleAssembly({
      repositoryRoot,
      buildKey: minimalReceipt.buildKey,
      verification: true
    })
    const normalized = {
      ...reproduced,
      command: reproduced.command.map((value) => value === reproduced.outputRoot
        ? attestation.outputRoot
        : value),
      outputRoot: attestation.outputRoot,
      assemblyPath: attestation.assemblyPath
    }
    if (reproduced.assemblyDigest !== runtimeBinding.assemblyDigest
      || digestValue(normalized) !== digestValue({
        schema: attestation.schema,
        project: attestation.project,
        command: attestation.command,
        outputRoot: attestation.outputRoot,
        assemblyPath: attestation.assemblyPath,
        assemblyDigest: attestation.assemblyDigest
      }))
    {
      throw new Error('runtime-role assembly does not match the canonical reproducible build')
    }
    verifiedRuntimeAttestations.set(trustedKey, reproduced.assemblyDigest)
  }
  finally
  {
    if (reproduced?.outputRoot)
    {
      removeRuntimeRoleVerificationBuild(repositoryRoot, reproduced.outputRoot)
    }
  }
}

function sortedUniqueStrings(values)
{
  return [...new Set(values.map(String).filter((value) => value.length > 0))].sort((left, right) =>
    (left < right ? -1 : left > right ? 1 : 0))
}

function compareText(left, right)
{
  return left < right ? -1 : left > right ? 1 : 0
}

function isSortedUniqueStrings(values)
{
  if (!Array.isArray(values)) return false
  if (values.some((value) => typeof value !== 'string' || value.length === 0)) return false
  if (new Set(values).size !== values.length) return false
  const sorted = [...values].sort(compareText)
  return sorted.every((value, index) => value === values[index])
}

function allowedInputSet(extractor)
{
  return new Set((extractor.consumedInputs ?? []).map((entry) => String(entry).replaceAll(path.sep, '/')))
}

function assertAllowed(relative, allowed)
{
  const normalized = relative.replaceAll(path.sep, '/')
  if (!allowed.has(normalized))
  {
    throw new Error(`test-matrix-fact-extractor attempted to read undeclared input ${normalized}`)
  }
  return normalized
}

function readText(repositoryRoot, relative, allowed)
{
  const normalized = assertAllowed(relative, allowed)
  const absolute = path.join(repositoryRoot, normalized)
  if (!existsSync(absolute) || !statSync(absolute).isFile())
  {
    throw new Error(`missing declared input file ${normalized}`)
  }
  return readFileSync(absolute, 'utf8')
}

function readJson(repositoryRoot, relative, allowed)
{
  return JSON.parse(readText(repositoryRoot, relative, allowed))
}

function fileExists(repositoryRoot, relative)
{
  const absolute = path.join(repositoryRoot, relative)
  return existsSync(absolute) && statSync(absolute).isFile()
}

function directoryExists(repositoryRoot, relative)
{
  const absolute = path.join(repositoryRoot, relative)
  return existsSync(absolute) && statSync(absolute).isDirectory()
}

function commandEntrypoint(command)
{
  const text = String(command ?? '').trim()
  if (!text) return null
  const tokens = text.split(/\s+/u).filter(Boolean)
  for (const token of tokens)
  {
    if (token.startsWith('tools/') || token.startsWith('./tools/') || token.endsWith('.sh') || token.endsWith('.mjs'))
    {
      return token.replace(/^\.\//u, '')
    }
  }
  return tokens[0] ?? null
}

function commandDigest(command)
{
  return digestText(String(command ?? '').trim())
}

function detectDependencyCycles(nodes, edges)
{
  const adjacency = new Map(nodes.map((id) => [id, []]))
  for (const edge of edges)
  {
    const [from, to] = edge.split('->')
    if (!adjacency.has(from) || !adjacency.has(to)) continue
    adjacency.get(from).push(to)
  }
  const visiting = new Set()
  const visited = new Set()
  const cycles = []

  function visit(node, stack)
  {
    if (visiting.has(node))
    {
      const start = stack.indexOf(node)
      cycles.push([...stack.slice(start), node].join('->'))
      return
    }
    if (visited.has(node)) return
    visiting.add(node)
    stack.push(node)
    for (const next of adjacency.get(node) ?? []) visit(next, stack)
    stack.pop()
    visiting.delete(node)
    visited.add(node)
  }

  for (const node of nodes) visit(node, [])
  return sortedUniqueStrings(cycles)
}

function topoOrderConstraintIds(nodes, edges)
{
  // Emit stable predecessor constraints as "after:X requires:Y" for non-empty edges only.
  return sortedUniqueStrings(edges.map((edge) =>
  {
    const [from, to] = edge.split('->')
    return `after:${to}|requires:${from}`
  })).filter((entry) =>
  {
    const match = entry.match(/^after:([^|]+)\|requires:(.+)$/u)
    return match && nodes.includes(match[1]) && nodes.includes(match[2])
  })
}

function collectCoverageIds(coverageRegistry)
{
  const entries = Array.isArray(coverageRegistry?.entries) ? coverageRegistry.entries : []
  return sortedUniqueStrings(entries.map((entry) => entry?.id).filter(Boolean))
}

function captureError(callback)
{
  try
  {
    callback()
    return 'unexpectedly-accepted'
  }
  catch (error)
  {
    return error instanceof Error ? error.message : String(error)
  }
}

function projectVolumeTopology(volumeTopology)
{
  return Object.fromEntries(Object.entries(volumeTopology).map(([target, value]) => [
    target.slice(1).replaceAll('/', '.'),
    Object.fromEntries(Object.entries({ target, ...value }).filter(([, member]) => member != null))
  ]))
}

function projectEffectiveCompose(effectiveCompose)
{
  const projectServices = (services) => Object.fromEntries(Object.entries(services ?? {}).map(
    ([id, service]) => [id, {
      image: String(service.image ?? ''),
      buildState: service.build == null ? 'absent' : 'present',
      pullPolicy: String(service.pullPolicy ?? ''),
      profileState: Array.isArray(service.profiles) && service.profiles.length > 0
        ? `profiled:${service.profiles.join(',')}`
        : 'default-active',
      entrypointState: service.entrypoint == null ? 'absent' : 'present',
      commandState: service.command == null ? 'absent' : 'present'
    }]))
  return {
    oracle: String(effectiveCompose?.oracle ?? ''),
    oracleVersion: String(effectiveCompose?.oracleVersion ?? ''),
    dockerExecutable: {
      canonicalPath: String(effectiveCompose?.dockerExecutable?.canonicalPath ?? ''),
      digest: String(effectiveCompose?.dockerExecutable?.digest ?? ''),
      version: String(effectiveCompose?.dockerExecutable?.version ?? '')
    },
    composeImplementation: {
      canonicalPath: String(effectiveCompose?.composeImplementation?.canonicalPath ?? ''),
      digest: String(effectiveCompose?.composeImplementation?.digest ?? ''),
      version: String(effectiveCompose?.composeImplementation?.version ?? '')
    },
    sourcePath: String(effectiveCompose?.sourcePath ?? ''),
    defaultServices: projectServices(effectiveCompose?.defaultServices),
    allProfileServices: projectServices(effectiveCompose?.allProfileServices),
    modelDigest: String(effectiveCompose?.modelDigest ?? '')
  }
}

function observeBlueGreenFacts(moduleSources, runtimeObservation, destructiveAuthority)
{
  const at = '2026-01-01T00:00:00Z'
  const digestA = `sha256:${'a'.repeat(64)}`
  const digestB = `sha256:${'b'.repeat(64)}`
  const releaseA = `20260101000000-${'a'.repeat(12)}`
  const releaseB = `20260101000001-${'b'.repeat(12)}`
  const state = createEmptySlotState(at)
  reserveRuntimeGeneration(state, { slot: 'blue', reservedAt: at })
  recordSlotStart(state, { slot: 'blue', releaseId: releaseA, imageDigest: digestA,
    imageRef: `registry.example/fsusblog@${digestA}`, deploymentGeneration: 1, startedAt: at })
  reserveRuntimeGeneration(state, { slot: 'green', reservedAt: at })
  recordSlotStart(state, { slot: 'green', releaseId: releaseB, imageDigest: digestB,
    imageRef: `registry.example/fsusblog@${digestB}`, deploymentGeneration: 2, startedAt: at })
  setActiveSlot(state, { slot: 'blue', kind: 'bootstrap', changedAt: at })
  const stopActiveError = captureError(() => recordSlotStop(structuredClone(state), { slot: 'blue', stoppedAt: at }))
  const unknownIdentity = structuredClone(state)
  unknownIdentity.activeReleaseId = releaseB
  const unknownIdentityError = captureError(() => validateSlotState(unknownIdentity))
  const switching = structuredClone(state)
  beginGatewayTransition(switching, { slot: 'green', releaseId: releaseB, imageDigest: digestB, kind: 'switch', startedAt: at })
  const aborted = structuredClone(switching)
  abortGatewayTransition(aborted, { abortedAt: at, message: 'probe-failure' })
  const rollbackRequired = structuredClone(switching)
  markGatewayRollbackRequired(rollbackRequired, { failedAt: at, message: 'probe-failure' })

  const rollout = createRolloutState({
    rolloutId: 'runtime-observation-rollout',
    kind: 'deploy',
    manifestPath: '/runtime-observation/release.json',
    source: { slot: 'blue', releaseId: releaseA, imageDigest: digestA, runtimeGeneration: 1 },
    target: { slot: 'green', releaseId: releaseB, imageDigest: digestB, runtimeGeneration: 2 },
    createdAtUtc: at
  })
  const activeArtifactIdentity = verifyArtifactGcActiveIdentity({
    authority: destructiveAuthority,
    slotState: state,
    rolloutState: rollout,
    retentionState: {
      activeReleaseId: releaseA,
      previousReleaseId: releaseB,
      drainingReleaseIds: [],
      retentionReleaseIds: [],
      referencedReleaseIds: [],
      minimumRetainedReleaseCount: 2
    }
  })
  const unsupportedVolumeCleanup = assertUnsupportedOperation(
    destructiveAuthority,
    'production-volume-cleanup'
  )
  const unsupportedSchemaCleanup = assertUnsupportedOperation(
    destructiveAuthority,
    'production-schema-cleanup'
  )
  startRolloutStage(rollout, ROLLOUT_STAGES[0], at)
  failRolloutStage(rollout, ROLLOUT_STAGES[0], { failedAtUtc: at, errorCode: 'probe_failure' })

  const store = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-gc-observation-'))
  let activeAssetProtection
  try
  {
    for (const releaseId of [releaseA, releaseB])
    {
      const releaseDirectory = path.join(store, 'releases', releaseId)
      mkdirSync(releaseDirectory, { recursive: true })
      const manifest = {
        compatibilityFile: null,
        files: [],
        frontendBuildId: releaseId,
        releaseId,
        schema: RELEASE_ASSET_MANIFEST_SCHEMA,
        slot: releaseId === releaseA ? 'blue' : 'green'
      }
      writeFileSync(path.join(releaseDirectory, 'asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    }
    mkdirSync(path.join(store, 'objects'), { recursive: true })
    const gcPlan = planReleaseAssetGc({ storeDirectory: store, state: {
      schema: RELEASE_GC_STATE_SCHEMA,
      activeReleaseId: releaseA,
      previousReleaseId: releaseB,
      drainingReleaseIds: [], retentionReleaseIds: [], referencedReleaseIds: [],
      minimumRetainedReleaseCount: 2
    } })
    activeAssetProtection = gcPlan.releases.find((release) => release.releaseId === releaseA)
  }
  finally
  {
    rmSync(store, { recursive: true, force: true })
  }

  const volumeTopology = runtimeObservation?.deploymentAuthority?.volumeTopology ?? {}
  const volumeScopes = Object.fromEntries(['operator-shared', 'release-artifact-store', 'release-identity',
    'shared-between-slots', 'slot-private'].map((scope) => [scope, Object.entries(volumeTopology)
    .filter(([, value]) => value?.scope === scope).map(([target]) => target).sort()]))
  const schemaOverlap = runtimeObservation?.schemaOverlap
  const claimEligibilityReasons = ['production-current-active-resource-evidence-absent']
  if (runtimeObservation?.ownership?.claimEligible !== true) claimEligibilityReasons.push('runtime-ownership-authority-conflict')
  if (Object.values(volumeScopes).flat().length !== 10) claimEligibilityReasons.push('volume-topology-incomplete')
  if (unsupportedVolumeCleanup.status !== 'unsupported') claimEligibilityReasons.push('volume-cleanup-authority-conflict')
  if (unsupportedSchemaCleanup.status !== 'unsupported') claimEligibilityReasons.push('schema-cleanup-authority-conflict')
  if (schemaOverlap?.claimEligible !== true) claimEligibilityReasons.push('schema-overlap-authority-conflict')

  return {
    evidenceClass: 'synthetic-library-proof',
    authorityModules: Object.fromEntries(Object.entries(moduleSources).map(([id, source]) => [id, {
      sourcePath: source.path,
      sourceDigest: digestText(source.text)
    }])),
    proofIds: [
      'release-assets.active-release-retained',
      'rollout.failed-stage-recovery-derived',
      'slot.active-stop-rejected',
      'slot.gateway-transition-state-derived',
      'slot.identity-mismatch-rejected'
    ],
    slotStateSchema: SLOT_STATE_SCHEMA,
    rolloutStateSchema: ROLLOUT_SCHEMA,
    slots: Object.keys(state.slots).sort(),
    activeIdentity: ['activeImageDigest', 'activeReleaseId', 'activeSlot'],
    switchState: switching.status,
    rollbackRequiredState: rollbackRequired.status,
    abortedTransitionStatus: aborted.lastTrafficTransition.status,
    stopActiveResult: stopActiveError,
    unknownIdentityResult: unknownIdentityError,
    rolloutFailureState: rollout.status,
    rolloutRecoveryAction: rollout.recovery.action,
    rolloutStages: ROLLOUT_STAGES,
    activeAssetAction: activeAssetProtection.action,
    activeAssetReasons: activeAssetProtection.reasons,
    activeArtifactIdentity,
    destructiveAuthority: {
      schema: destructiveAuthority.schema,
      contentDigest: destructiveAuthority.contentDigest,
      volumeCleanupStatus: unsupportedVolumeCleanup.status,
      schemaCleanupStatus: unsupportedSchemaCleanup.status
    },
    volumeTopology: projectVolumeTopology(volumeTopology),
    volumeScopes,
    schemaOverlap,
    runtimeProtectionAuthorityState: 'synthetic-library-proof',
    artifactProtectionAuthorityState: 'synthetic-library-proof',
    schemaProtectionAuthorityState: 'synthetic-library-proof',
    volumeProtectionAuthorityState: 'synthetic-library-proof',
    ...(claimEligibilityReasons.length > 0 ? { claimEligibilityReasons } : {}),
    claimEligible: claimEligibilityReasons.length === 0,
    authorityState: 'synthetic-library-proof'
  }
}

function observeReleaseFinalFacts({ matrix, canonical, ledger, dispositionLedger, repositoryRoot,
  moduleSources, sourceCommit, worktreeFingerprint, buildIdentity })
{
  const plan = buildReleaseFinalizerPlan(matrix, 'release-final', canonical)
  const errors = [
    ...validateCanonicalReleaseFinalEvidenceInputs(canonical),
    ...(plan.errors ?? []),
    ...validateRequiredEvidenceCatalog(ledger, {
      canonicalInputs: canonical.inputs,
      dispositionLedger,
      root: repositoryRoot
    })
  ]
  if (errors.length > 0)
  {
    throw new Error(`release-final authority validation failed: ${errors.join('; ')}`)
  }

  const digest = (value) => `sha256:${digestText(value)}`
  const sourceRefs = Object.values(moduleSources).map((source) => ({
    kind: 'repository-authority',
    path: source.path,
    digest: digest(source.text)
  }))
  const identity = {
    buildIdentity: digest(JSON.stringify(buildIdentity)),
    executionEnvelopeDigest: digest('release-final-observation-envelope'),
    producerId: 'release-finalizer-semantic-outcome',
    replayPlanDigest: digest(JSON.stringify(plan)),
    schedulerRunId: 'release-final-observation-run',
    sourceCommit,
    temporalContextDigest: digest('release-final-observation-temporal-context'),
    toolchainDigest: digest('release-final-observation-toolchain'),
    worktreeFingerprint: `sha256:${worktreeFingerprint}`
  }
  const attemptEligibility = {
    aggregateDigest: digest('release-final-observation-aggregate'),
    attemptDigest: digest('release-final-observation-attempt'),
    attemptNumber: 1,
    cleanFirstAttempt: true,
    firstFailure: false,
    qualificationEligible: true
  }
  const semanticPlan = { inputIds: plan.inputTierIds, outputIds: [plan.outputReceiptSchema] }
  const completeEvidence = {
    consumedIds: plan.inputTierIds,
    verifiedIds: plan.inputTierIds,
    failedIds: [],
    blockedIds: [],
    producedOutputIds: [plan.outputReceiptSchema],
    outputDigests: { [plan.outputReceiptSchema]: digest('release-final-observation-output') }
  }
  const successful = adaptReleaseFinalizerSemanticOutcome({
    identity, inputAuthorityRefs: sourceRefs, attemptEligibility,
    plan: semanticPlan, evidence: completeEvidence
  })
  const missingInput = adaptReleaseFinalizerSemanticOutcome({
    identity, inputAuthorityRefs: sourceRefs, attemptEligibility, plan: semanticPlan,
    evidence: {
      ...completeEvidence,
      consumedIds: plan.inputTierIds.slice(0, -1),
      verifiedIds: plan.inputTierIds.slice(0, -1)
    }
  })
  const postRuntimeAuthority = ledger.entries.find((entry) =>
    entry.authorityId === 'behavior-evidence-post-runtime')
  if (postRuntimeAuthority?.receiptSchema !== postRuntimeReceiptSchema)
  {
    throw new Error('post-runtime seal schema conflicts with the required-evidence catalog')
  }

  return {
    authorityModules: Object.fromEntries(Object.entries(moduleSources).map(([id, source]) => [id, {
      sourcePath: source.path,
      sourceDigest: digest(source.text)
    }])),
    planSchema: plan.schema,
    targetTier: plan.target,
    selectedTierIds: plan.selectedTierIds,
    inputTierIds: plan.inputTierIds,
    inputCount: plan.inputTierIds.length,
    inputContractSchema: plan.inputContractSchema,
    outputReceiptSchema: plan.outputReceiptSchema,
    artifactOnly: plan.artifactOnly,
    executesTestCommands: plan.executesTestCommands,
    requiredEvidenceCatalog: {
      schema: ledger.schema,
      contentDigest: ledger.contentDigest,
      authorityIds: ledger.entries.map((entry) => entry.authorityId),
      locatorBindingKeys: ledger.entries.map((entry) => entry.locatorBindingKey).sort()
    },
    postRuntimeSeal: {
      authorityId: postRuntimeAuthority.authorityId,
      receiptSchema: postRuntimeReceiptSchema,
      exactness: postRuntimeAuthority.exactness
    },
    semanticAdapterContractProbe: {
      completeMembershipStatus: successful.outcome.status,
      missingMembershipStatus: missingInput.outcome.status,
      missingInputReasonKinds: sortedUniqueStrings(
        missingInput.outcome.reasons.map((reason) => reason.kind)),
      producerAuthorityId: successful.producerAuthorityId
    },
    currentRunBindingState: 'not-observed-by-static-authority-extractor',
    publishGateState: 'blocked-current-run-binding-unverified',
    claimEligible: false,
    authorityState: 'conflict-unknown'
  }
}

function walkFiles(directory, out = [])
{
  if (!existsSync(directory)) return out
  for (const entry of readdirSync(directory, { withFileTypes: true }))
  {
    if (entry.name === '.' || entry.name === '..') continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) walkFiles(absolute, out)
    else if (entry.isFile()) out.push(absolute)
  }
  return out
}

/**
 * Bidirectional consumer checks. Consumers may not define topology;
 * inconsistency fails closed (never silently prefer matrix over stale consumers).
 */
function validateConsumers({
  repositoryRoot,
  allowed,
  matrix,
  tierIds,
  profileIds,
  retiredFromIds,
  finalizer
})
{
  const errors = []
  const publicEntryTargets = new Set([...tierIds, ...profileIds, 'help', 'list', 'validate', 'plan', 'run', 'docs'])

  // Lane entrypoints declared by matrix must exist; lanes must not host a second tier DAG.
  if (allowed.has('tools/test/lanes') && directoryExists(repositoryRoot, 'tools/test/lanes'))
  {
    for (const tier of matrix.tiers)
    {
      const entrypoint = commandEntrypoint(tier.command)
      if (!entrypoint) continue
      if (!entrypoint.startsWith('tools/test/lanes/')) continue
      if (!fileExists(repositoryRoot, entrypoint))
      {
        errors.push(`matrix tier ${tier.id} declares missing lane entrypoint ${entrypoint}`)
      }
    }

    const laneRoot = path.join(repositoryRoot, 'tools/test/lanes')
    for (const absolute of walkFiles(laneRoot))
    {
      const relative = path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/')
      const base = path.posix.basename(relative)
      if (base.startsWith('_')) continue
      if (!relative.endsWith('.sh') && !relative.endsWith('.mjs')) continue
      const source = readFileSync(absolute, 'utf8')
      // Source-only libraries must refuse direct execution.
      if (source.includes('source-only') && /is source-only/u.test(source)) continue

      // Second tier dispatch only when case switches on matrix tier identity variables.
      const tierCasePattern = new RegExp(
        String.raw`case\s+["']?\$\{?(?:TIER|MATRIX_JOB|CURRENT_TIER|FSUSBLOG_TEST_TIER)\}?["']?\s+in([\s\S]*?)\nesac`,
        'gu'
      )
      const tierDispatchBlocks = [...source.matchAll(tierCasePattern)]
      for (const block of tierDispatchBlocks)
      {
        const caseArms = [...block[1].matchAll(/^\s*([a-z][a-z0-9-]*)\)\s*$/gmu)].map((match) => match[1])
        const tierArms = caseArms.filter((arm) => tierIds.includes(arm) || retiredFromIds.has(arm))
        if (tierArms.length >= 2)
        {
          errors.push(`${relative} maintains second tier dispatch (${tierArms.slice(0, 8).join(',')})`)
        }
      }
      for (const retired of retiredFromIds)
      {
        // Direct retired-tier lane filenames or tools/test.sh retired targets.
        if (new RegExp(`tools/test\\.sh\\s+${retired}\\b`, 'u').test(source)
          || new RegExp(`lanes/${retired}\\.sh`, 'u').test(source))
        {
          errors.push(`${relative} references retired tier alias ${retired}`)
        }
      }
    }
  }
  else if (allowed.has('tools/test/lanes'))
  {
    errors.push('declared consumer input tools/test/lanes is missing')
  }

  // Package script aliases for matrix profiles/tiers must use the public shell entry.
  if (allowed.has('src/frontend/package.json') && fileExists(repositoryRoot, 'src/frontend/package.json'))
  {
    const packageJson = JSON.parse(readText(repositoryRoot, 'src/frontend/package.json', allowed))
    const scripts = packageJson?.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {}
    for (const [name, body] of Object.entries(scripts))
    {
      const text = String(body ?? '')
      const isMatrixAlias = /^test:(?:fast|integration|ci|release|acceptance|visual|production)$/u.test(name)
        || /^test:[a-z0-9-]+$/u.test(name) && /tools\/test\.sh/u.test(text)
      if (isMatrixAlias)
      {
        const directLane = text.match(/(?:bash\s+)?(?:\.\.\/)*tools\/test\/lanes\/([a-z0-9-]+)\.sh/u)
        if (directLane)
        {
          errors.push(`package script ${name} bypasses matrix public entry via direct lane ${directLane[1]}`)
        }
      }
      const testSh = [...text.matchAll(/(?:bash\s+)?(?:\.\.\/)*tools\/test\.sh\s+([a-z0-9-]+)/gu)]
      for (const match of testSh)
      {
        const target = match[1]
        if (retiredFromIds.has(target))
        {
          errors.push(`package script ${name} points to retired tier alias ${target}`)
        }
        else if (!publicEntryTargets.has(target)
          && !tierIds.includes(target)
          && !profileIds.includes(target))
        {
          errors.push(`package script ${name} points to undeclared matrix target ${target}`)
        }
      }
      // Any script that still targets a retired lane path fails closed.
      for (const retired of retiredFromIds)
      {
        if (new RegExp(`lanes/${retired}\\.sh`, 'u').test(text)
          || new RegExp(`tools/test\\.sh\\s+${retired}\\b`, 'u').test(text))
        {
          errors.push(`package script ${name} points to retired tier alias ${retired}`)
        }
      }
    }
  }
  else if (allowed.has('src/frontend/package.json'))
  {
    errors.push('declared consumer input src/frontend/package.json is missing')
  }

  // Generated testing docs must consume matrix observation sources, never docs topology prose.
  if (allowed.has('tools/docs/generate-testing-docs.mjs')
    && fileExists(repositoryRoot, 'tools/docs/generate-testing-docs.mjs'))
  {
    const source = readText(repositoryRoot, 'tools/docs/generate-testing-docs.mjs', allowed)
    if (/docs\/testing\.md|docs\/testing\.generated\.md/u.test(source)
      && /readFileSync|loadMatrix|parseMatrix/u.test(source))
    {
      // Reading generated/hand docs as topology authority is forbidden.
      if (/readFileSync\([^)]*docs\/testing/u.test(source)
        || /from\s+['"][^'"]*docs\/testing/u.test(source))
      {
        errors.push('generate-testing-docs reads docs/testing as topology authority')
      }
    }
    if (!/tests\/matrix\.yml|loadMatrix/u.test(source))
    {
      errors.push('generate-testing-docs must consume matrix observation source tests/matrix.yml')
    }
    if (/expectedBundleOrder|legacyTierAlias|compatBundle|topologyBaseline/u.test(source))
    {
      errors.push('generate-testing-docs embeds second topology baseline/alias tables')
    }
  }
  else if (allowed.has('tools/docs/generate-testing-docs.mjs'))
  {
    errors.push('declared consumer input tools/docs/generate-testing-docs.mjs is missing')
  }

  // release-final script must match matrix finalizer authority.
  if (allowed.has('tools/test/lanes/release-final.sh')
    && fileExists(repositoryRoot, 'tools/test/lanes/release-final.sh'))
  {
    const script = readText(repositoryRoot, 'tools/test/lanes/release-final.sh', allowed)
    if (finalizer?.command && !fileExists(repositoryRoot, finalizer.command))
    {
      errors.push(`release-final finalizer command missing: ${finalizer.command}`)
    }
    if (!/check-release-final\.mjs/u.test(script))
    {
      errors.push('release-final lane does not invoke check-release-final authority')
    }
    if (finalizer?.outputReceiptSchema
      && !script.includes('release-final')
      && !script.includes('check-release-final'))
    {
      errors.push('release-final lane diverges from matrix finalizer authority')
    }
  }
  else if (allowed.has('tools/test/lanes/release-final.sh'))
  {
    errors.push('declared consumer input tools/test/lanes/release-final.sh is missing')
  }

  return errors
}

function buildObservations({
  matrix,
  matrixSchema,
  coverageRegistry,
  executionClassContract
})
{
  const errors = []
  const profileIds = sortedUniqueStrings(Object.keys(matrix.localProfiles ?? {}))
  const tiers = Array.isArray(matrix.tiers) ? matrix.tiers : []
  const tierIds = sortedUniqueStrings(tiers.map((tier) => tier?.id).filter(Boolean))
  if (tierIds.length === 0) errors.push('matrix exposes no tier identifiers')
  if (tiers.length !== tierIds.length) errors.push('matrix tier ids must be unique')

  const tierById = new Map(tiers.map((tier) => [tier.id, tier]))
  const dependencyEdges = []
  const missingNodes = []
  for (const tier of tiers)
  {
    if (Object.hasOwn(tier ?? {}, 'dependsOn'))
    {
      errors.push(`tier ${tier.id} uses retired dependsOn; executionDependsOn is required`)
    }
    const deps = tierExecutionDependencies(tier)
    if (!Array.isArray(deps))
    {
      errors.push(`tier ${tier.id} executionDependsOn must be an array`)
      continue
    }
    for (const dep of deps)
    {
      if (!tierById.has(dep)) missingNodes.push(`${tier.id}->${dep}`)
      dependencyEdges.push(`${dep}->${tier.id}`)
    }
  }
  if (missingNodes.length > 0)
  {
    errors.push(`dependency graph references missing nodes: ${sortedUniqueStrings(missingNodes).join(',')}`)
  }
  const cycles = detectDependencyCycles(tierIds, sortedUniqueStrings(dependencyEdges))
  if (cycles.length > 0)
  {
    errors.push(`dependency graph cycle: ${cycles.join(' | ')}`)
  }

  // Bundle projection: map keys only (receipt forbids arrays of objects / empty lists).
  const bundleIdsByProfile = {}
  const bundleMembers = {}
  const bundleDependsOn = {}
  const bundleCommandEntrypoints = {}
  const bundleCommandDigests = {}
  const productionFreshOrdering = {
    profileId: 'production',
    hasDependencyEdges: false
  }
  let productionBundleIds = []
  let productionBundleEdges = []
  let productionTopoConstraints = []

  for (const profileId of profileIds)
  {
    const profile = matrix.localProfiles[profileId]
    const bundles = Array.isArray(profile?.bundles) ? profile.bundles : []
    const bundleIds = sortedUniqueStrings(bundles.map((bundle) => bundle?.id).filter(Boolean))
    const bundleEdges = []
    if (bundleIds.length > 0) bundleIdsByProfile[profileId] = bundleIds
    for (const bundle of bundles)
    {
      if (!bundle?.id) continue
      const key = `${profileId}.${bundle.id}`
      const dependsOn = sortedUniqueStrings(bundle.dependsOn ?? [])
      for (const dep of dependsOn)
      {
        if (!bundleIds.includes(dep)
          && !bundles.some((entry) => entry.id === dep)
          && !isExternalBehaviorDocAdmissionDependency(dep))
        {
          errors.push(`profile ${profileId} bundle ${bundle.id} depends on missing bundle ${dep}`)
        }
        if (!isExternalBehaviorDocAdmissionDependency(dep))
        {
          bundleEdges.push(`${dep}->${bundle.id}`)
        }
      }
      const members = sortedUniqueStrings(bundle.members ?? [])
      for (const member of members)
      {
        if (!tierById.has(member))
        {
          errors.push(`profile ${profileId} bundle ${bundle.id} member ${member} is not a matrix tier`)
        }
      }
      if (members.length > 0) bundleMembers[key] = members
      if (dependsOn.length > 0) bundleDependsOn[key] = dependsOn
      const entrypoint = commandEntrypoint(bundle.command)
      if (entrypoint) bundleCommandEntrypoints[key] = entrypoint
      bundleCommandDigests[key] = commandDigest(bundle.command)
    }
    const bundleCycles = detectDependencyCycles(bundleIds, sortedUniqueStrings(bundleEdges))
    if (bundleCycles.length > 0)
    {
      errors.push(`profile ${profileId} bundle dependency cycle: ${bundleCycles.join(' | ')}`)
    }
    if (profileId === 'production')
    {
      productionBundleIds = bundleIds
      productionBundleEdges = sortedUniqueStrings(bundleEdges)
      productionTopoConstraints = topoOrderConstraintIds(bundleIds, productionBundleEdges)
      productionFreshOrdering.hasDependencyEdges = productionBundleEdges.length > 0
    }
  }

  const commandGroupLanes = {}
  const commandGroupSchemas = {}
  const commandGroupCommandIds = {}
  const commandGroupStages = {}
  const commandGroupDependencyEdges = {}
  const blockingStages = {}
  for (const [groupId, group] of Object.entries(matrix.commandGroups ?? {}))
  {
    const commands = Array.isArray(group?.commands) ? group.commands : []
    const commandIds = sortedUniqueStrings(commands.map((command) => command?.id).filter(Boolean))
    commandGroupLanes[groupId] = group.lane ?? groupId
    if (group.schema) commandGroupSchemas[groupId] = group.schema
    if (commandIds.length > 0) commandGroupCommandIds[groupId] = commandIds
    const commandDeps = []
    for (const command of commands)
    {
      if (!command?.id) continue
      const stage = command.stage == null ? 'unspecified' : String(command.stage)
      commandGroupStages[`${groupId}.${command.id}`] = stage
      if (stage === 'blocking-prebuild' || stage === 'blocking')
      {
        if (!blockingStages[stage]) blockingStages[stage] = []
        blockingStages[stage].push(`${groupId}::${command.id}`)
      }
      for (const dep of command.dependsOn ?? [])
      {
        commandDeps.push(`${dep}->${command.id}`)
      }
    }
    const sortedDeps = sortedUniqueStrings(commandDeps)
    if (sortedDeps.length > 0) commandGroupDependencyEdges[groupId] = sortedDeps
  }
  for (const stage of Object.keys(blockingStages))
  {
    blockingStages[stage] = sortedUniqueStrings(blockingStages[stage])
  }

  if (executionClassContract?.schema !== 'fsusblog.test-producer-execution-class.v1')
  {
    errors.push('producer execution-class contract schema is invalid')
  }
  const executionClassByEvidence = {}
  const executionClassRequires = {}
  const executionClassQualification = {}
  for (const [evidenceClass, mapping] of Object.entries(executionClassContract?.classes ?? {}))
  {
    executionClassByEvidence[evidenceClass] = mapping.executionClass
    if (Array.isArray(mapping.requires) && mapping.requires.length > 0)
    {
      executionClassRequires[evidenceClass] = [...mapping.requires]
    }
    executionClassQualification[evidenceClass] = mapping.qualificationEligible !== false
  }
  const evidenceClasses = {}
  for (const tier of tiers)
  {
    const evidenceClass = tier.evidenceClass ?? 'correctness'
    if (!evidenceClasses[evidenceClass]) evidenceClasses[evidenceClass] = []
    evidenceClasses[evidenceClass].push(tier.id)
    if (!executionClassByEvidence[evidenceClass])
    {
      errors.push(`tier ${tier.id} evidenceClass ${evidenceClass} lacks execution-class mapping`)
    }
  }
  for (const key of Object.keys(evidenceClasses))
  {
    evidenceClasses[key] = sortedUniqueStrings(evidenceClasses[key])
  }

  // Coverage registry contributes ID references only — no topology fields, no DocClaim prose.
  const coverageIds = collectCoverageIds(coverageRegistry)
  const matrixCoverageIds = sortedUniqueStrings(
    tiers.flatMap((tier) => (Array.isArray(tier.coverage) ? tier.coverage : []))
  )
  const coverageIdSet = new Set(coverageIds)
  const matrixCoverageRefs = matrixCoverageIds.filter((id) => coverageIdSet.has(id))

  const staticGovernanceTier = tiers.filter((tier) => tier.id === 'static-governance'
    || tier.id === 'frontend-static-governance')
  const membershipBundles = []
  for (const [key, members] of Object.entries(bundleMembers))
  {
    if (members.includes('static-governance') || members.includes('frontend-static-governance'))
    {
      membershipBundles.push(key)
    }
  }
  const staticGovernancePredecessors = {}
  for (const tier of staticGovernanceTier)
  {
    const deps = sortedUniqueStrings(tierExecutionDependencies(tier))
    if (deps.length > 0) staticGovernancePredecessors[tier.id] = deps
  }
  const staticGovernanceMembership = {
    tierIds: sortedUniqueStrings(staticGovernanceTier.map((tier) => tier.id)),
    hasBundleMemberships: membershipBundles.length > 0,
    predecessorCount: Object.keys(staticGovernancePredecessors).length
  }
  if (membershipBundles.length > 0)
  {
    staticGovernanceMembership.bundleMemberships = sortedUniqueStrings(membershipBundles)
  }
  if (Object.keys(staticGovernancePredecessors).length > 0)
  {
    staticGovernanceMembership.predecessors = staticGovernancePredecessors
  }

  const candidateTargets = ['production-correctness', 'production', 'release-final', 'fast', 'ci']
  const candidateExecutionDependsOn = {}
  const candidateEvidenceFrom = {}
  for (const targetId of candidateTargets)
  {
    const tier = tierById.get(targetId)
    if (!tier) continue
    const deps = sortedUniqueStrings(tierExecutionDependencies(tier))
    const evidence = sortedUniqueStrings(tier.requiresEvidenceFrom ?? [])
    if (deps.length > 0) candidateExecutionDependsOn[targetId] = deps
    if (evidence.length > 0) candidateEvidenceFrom[targetId] = evidence
  }
  const candidateAdmissionPredecessors = {
    targets: sortedUniqueStrings(Object.keys(candidateExecutionDependsOn).concat(Object.keys(candidateEvidenceFrom)))
  }
  if (Object.keys(candidateExecutionDependsOn).length > 0)
  {
    candidateAdmissionPredecessors.executionDependsOn = candidateExecutionDependsOn
  }
  if (Object.keys(candidateEvidenceFrom).length > 0)
  {
    candidateAdmissionPredecessors.requiresEvidenceFrom = candidateEvidenceFrom
  }

  const finalizer = matrix.finalizerAuthorities?.['release-final'] ?? null
  if (!finalizer)
  {
    errors.push('matrix missing finalizerAuthorities.release-final')
  }
  const releaseFinalTiers = sortedUniqueStrings(finalizer?.summaryTierIds ?? [])
  const releaseFinalRequiredInputSchemas = sortedUniqueStrings(
    [finalizer?.inputContractSchema].filter(Boolean)
  )
  const releaseFinalOutputSchema = finalizer?.outputReceiptSchema ?? null
  const releaseFinalTierRecord = tierById.get('release-final')
  if (releaseFinalTierRecord)
  {
    const evidence = sortedUniqueStrings(releaseFinalTierRecord.requiresEvidenceFrom ?? [])
    if (evidence.length === 0)
    {
      errors.push('release-final requiresEvidenceFrom must declare evidence input tier ids')
    }
  }

  if (matrixSchema?.title !== 'FsusBlog Test Matrix' && matrixSchema?.$schema == null)
  {
    errors.push('matrix schema projection is not the canonical test matrix schema')
  }

  const sortedDependencyEdges = sortedUniqueStrings(dependencyEdges)
  const dependencyProjection = {
    edgeCount: sortedDependencyEdges.length,
    hasCycles: cycles.length > 0,
    hasMissingNodes: missingNodes.length > 0
  }
  if (sortedDependencyEdges.length > 0) dependencyProjection.edges = sortedDependencyEdges
  const topoConstraints = topoOrderConstraintIds(tierIds, sortedDependencyEdges)
  if (topoConstraints.length > 0) dependencyProjection.topoOrderConstraints = topoConstraints

  const facts = {
    'test.topology.profiles': profileIds.length > 0 ? profileIds : ['none'],
    'test.topology.tiers': tierIds,
    'test.topology.bundles': {
      idsByProfile: Object.keys(bundleIdsByProfile).length > 0
        ? bundleIdsByProfile
        : { none: ['none'] },
      members: Object.keys(bundleMembers).length > 0 ? bundleMembers : { none: ['none'] },
      dependsOn: Object.keys(bundleDependsOn).length > 0
        ? bundleDependsOn
        : { none: ['none'] },
      commandEntrypoints: Object.keys(bundleCommandEntrypoints).length > 0
        ? bundleCommandEntrypoints
        : { none: 'none' },
      commandDigests: Object.keys(bundleCommandDigests).length > 0
        ? bundleCommandDigests
        : { none: digestText('none') }
    },
    'test.topology.dependencies': dependencyProjection,
    'test.topology.command-groups': {
      lanes: Object.keys(commandGroupLanes).length > 0 ? commandGroupLanes : { none: 'none' },
      schemas: Object.keys(commandGroupSchemas).length > 0 ? commandGroupSchemas : { none: 'none' },
      commandIds: Object.keys(commandGroupCommandIds).length > 0
        ? commandGroupCommandIds
        : { none: ['none'] },
      stages: Object.keys(commandGroupStages).length > 0 ? commandGroupStages : { none: 'none' },
      dependencyEdges: Object.keys(commandGroupDependencyEdges).length > 0
        ? commandGroupDependencyEdges
        : { none: ['none'] }
    },
    'test.topology.blocking-stages': Object.keys(blockingStages).length > 0
      ? blockingStages
      : { none: ['none'] },
    'test.execution-classes': {
      byEvidenceClass: Object.keys(executionClassByEvidence).length > 0
        ? executionClassByEvidence
        : { none: 'none' },
      requires: Object.keys(executionClassRequires).length > 0
        ? executionClassRequires
        : { none: ['none'] },
      qualificationEligible: Object.keys(executionClassQualification).length > 0
        ? executionClassQualification
        : { none: false }
    },
    'test.evidence-classes': Object.keys(evidenceClasses).length > 0
      ? evidenceClasses
      : { none: ['none'] },
    'test.static-governance.membership': staticGovernanceMembership,
    'test.candidate-admission-predecessors': candidateAdmissionPredecessors,
    'release-final.finalizer-authority': finalizer
      ? {
          id: finalizer.id,
          commandKind: finalizer.commandKind,
          commandEntrypoint: commandEntrypoint(finalizer.command) ?? finalizer.command,
          commandDigest: commandDigest(finalizer.command)
        }
      : {
          id: 'missing',
          commandKind: 'missing',
          commandEntrypoint: 'missing',
          commandDigest: digestText('missing')
        },
    'release-final.required-input-schemas': releaseFinalRequiredInputSchemas.length > 0
      ? releaseFinalRequiredInputSchemas
      : ['missing'],
    'release-final.output-schema': releaseFinalOutputSchema ?? 'missing',
    'release-final.summary-tiers': releaseFinalTiers.length > 0 ? releaseFinalTiers : ['missing'],
    'production-fresh.bundle-ordering': {
      profileId: productionFreshOrdering.profileId,
      hasDependencyEdges: productionFreshOrdering.hasDependencyEdges,
      bundleIds: productionBundleIds.length > 0 ? productionBundleIds : ['none'],
      edges: productionBundleEdges.length > 0 ? productionBundleEdges : ['none'],
      topoOrderConstraints: productionTopoConstraints.length > 0
        ? productionTopoConstraints
        : ['none']
    }
  }

  const topologyDigest = digestValue(
    Object.fromEntries(requiredFactKeys.map((key) => [key, facts[key]]))
  )

  // Top-level observation keys must be [A-Za-z_][A-Za-z0-9_]*; dotted fact IDs live under facts.
  const observations = {
    facts,
    topologyDigest,
    matrixVersion: matrix.version ?? 'unknown',
    coverageIdCount: coverageIds.length,
    matrixCoverageRefCount: matrixCoverageRefs.length,
    observationSource: 'tests_matrix_yml_producer_execution_class_coverage_ids'
  }
  if (matrixCoverageRefs.length > 0)
  {
    observations.matrixCoverageRefs = matrixCoverageRefs
  }

  return { observations, errors, tierIds, profileIds, finalizer, facts }
}

/**
 * matrix-projection extractor for browserless-production-correctness.
 * Projects test/release topology facts from the formal matrix and governance catalogs only.
 * Never reads docs/testing, historical generated docs, fixture baselines, or expected tables.
 */
export function extract(context)
{
  const extractor = context?.extractor
  if (!extractor || extractor.id !== 'test-matrix-fact-extractor')
  {
    return failResult(['test-matrix-fact-extractor requires registered extractor context'])
  }

  const allowed = allowedInputSet(extractor)
  const runtimeIdentity = context.buildIdentity
  const runtimeIdentityKeys = [
    'schema', 'artifactId', 'receiptDigest', 'artifactDigest', 'sourceDigests', 'sourceDigest'
  ]
  if (!exactKeys(runtimeIdentity, runtimeIdentityKeys)
    || runtimeIdentity.schema !== 'fsusblog.build-identity.v1'
    || runtimeIdentity.artifactId !== 'runtime-role-observation'
    || !/^[a-f0-9]{64}$/u.test(String(runtimeIdentity.artifactDigest ?? ''))
    || !/^[a-f0-9]{64}$/u.test(String(runtimeIdentity.receiptDigest ?? ''))
    || !/^[a-f0-9]{64}$/u.test(String(runtimeIdentity.sourceDigest ?? ''))
    || !Array.isArray(runtimeIdentity.sourceDigests)
    || runtimeIdentity.sourceDigest !== digestValue(runtimeIdentity.sourceDigests)
    || typeof context.buildReceiptPath !== 'string'
    || context.buildReceiptPath.length === 0)
  {
    return failResult(['test-matrix-fact-extractor requires exact runtime-role-observation buildIdentity'])
  }
  let minimalReceipt
  let runtimeBinding
  let runtimeBytes
  let deploymentBytes
  let assemblyBytes
  let deploymentAbsolute
  let assemblyAbsolute
  try
  {
    const parent = readBoundArtifact(
      context.repositoryRoot,
      context.buildReceiptPath,
      'runtime-role minimal build receipt'
    )
    minimalReceipt = JSON.parse(parent.bytes.toString('utf8'))
    const unsignedReceipt = { ...minimalReceipt, contentDigest: null }
    if (minimalReceipt.schema !== 'fsusblog.behavior-doc-minimal-contract-build-receipt.v1'
      || minimalReceipt.contentDigest !== digestValue(unsignedReceipt)
      || minimalReceipt.contentDigest !== runtimeIdentity.receiptDigest
      || minimalReceipt.sourceCommit !== context.sourceCommit
      || minimalReceipt.worktreeFingerprint !== context.worktreeFingerprint
      || minimalReceipt.buildRoot !== `.tmp/behavior-doc-contract-builds/${minimalReceipt.buildKey}`
      || minimalReceipt.status !== 'ok'
      || !Array.isArray(minimalReceipt.failureReasons)
      || minimalReceipt.failureReasons.length !== 0
      || minimalReceipt.buildKey !== digestValue({
        sourceIdentity: {
          sourceCommit: minimalReceipt.sourceCommit,
          worktreeFingerprint: minimalReceipt.worktreeFingerprint
        },
        toolchain: minimalReceipt.toolchain,
        sourceClosureDigests: minimalReceipt.sourceClosureDigests
      })
      || runtimeIdentity.sourceDigest !== digestValue(minimalReceipt.sourceClosureDigests)
      || JSON.stringify(runtimeIdentity.sourceDigests)
        !== JSON.stringify(minimalReceipt.sourceClosureDigests))
    {
      return failResult(['runtime-role minimal build receipt identity mismatch'])
    }
    const currentDotnet = spawnSync('dotnet', ['--version'], {
      cwd: context.repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    })
    if (currentDotnet.status !== 0
      || String(currentDotnet.stdout ?? '').trim() !== minimalReceipt.toolchain?.dotnet
      || minimalReceipt.toolchain?.configuration !== 'Release'
      || minimalReceipt.toolchain?.targetFramework !== 'net10.0')
    {
      return failResult(['runtime-role minimal build toolchain differs from the current verifier'])
    }
    const registryArtifact = readBoundArtifact(
      context.repositoryRoot,
      'config/contracts/behavior-fact-extractors.json',
      'behavior fact extractor registry'
    )
    const currentRegistry = JSON.parse(registryArtifact.bytes.toString('utf8'))
    const currentCompiled = Array.isArray(currentRegistry?.extractors)
      ? currentRegistry.extractors.filter((entry) => entry?.kind === 'compiled-assembly')
      : []
    const currentArtifactIds = currentCompiled.map((entry) => entry.requiredBuildArtifact).sort()
    if (JSON.stringify(currentArtifactIds) !== JSON.stringify(Object.keys(hostDeclarations).sort())
      || digestValue(minimalReceipt.sourceClosureDigests)
        !== digestValue(minimalContractSourceClosureDigests(context.repositoryRoot, currentCompiled)))
    {
      return failResult(['runtime-role minimal build source closure differs from current consumed inputs'])
    }
    runtimeBinding = minimalReceipt.artifacts?.['runtime-role-observation']
    if (!exactKeys(runtimeBinding, [
      'project', 'projectDigest', 'path', 'artifactPath', 'artifactDigest', 'assemblyPath',
      'assemblyDigest', 'deploymentArtifactPath', 'deploymentArtifactDigest',
      'buildReceipt'
    ])
      || runtimeBinding.project !== 'tools/contracts/FsusBlog.RuntimeRoleObservation/FsusBlog.RuntimeRoleObservation.csproj'
      || runtimeBinding.artifactPath !== '.tmp/contracts/runtime-role/runtime-role-observation.json'
      || runtimeBinding.artifactDigest !== runtimeIdentity.artifactDigest
      || !/^[a-f0-9]{64}$/u.test(runtimeBinding.assemblyDigest ?? '')
      || !/^[a-f0-9]{64}$/u.test(runtimeBinding.deploymentArtifactDigest ?? ''))
    {
      return failResult(['runtime-role artifact binding is not exact in minimal build receipt'])
    }
    const runtimeArtifact = readBoundArtifact(
      context.repositoryRoot,
      runtimeBinding.path,
      'runtime-role cached observation'
    )
    const deploymentArtifact = readBoundArtifact(
      context.repositoryRoot,
      runtimeBinding.deploymentArtifactPath,
      'runtime-role deployment observation'
    )
    const assemblyArtifact = readBoundArtifact(
      context.repositoryRoot,
      runtimeBinding.assemblyPath,
      'runtime-role compiled assembly'
    )
    runtimeBytes = runtimeArtifact.bytes
    deploymentBytes = deploymentArtifact.bytes
    assemblyBytes = assemblyArtifact.bytes
    deploymentAbsolute = deploymentArtifact.absolute
    assemblyAbsolute = assemblyArtifact.absolute
    if (sha256(runtimeBytes) !== runtimeIdentity.artifactDigest
      || sha256(deploymentBytes) !== runtimeBinding.deploymentArtifactDigest
      || sha256(assemblyBytes) !== runtimeBinding.assemblyDigest
      || sha256(readFileSync(path.join(context.repositoryRoot, runtimeBinding.project)))
        !== runtimeBinding.projectDigest)
    {
      return failResult(['runtime-role minimal build artifact or assembly digest mismatch'])
    }
    verifyRuntimeReproducibleBuild(context.repositoryRoot, runtimeBinding, minimalReceipt)
  }
  catch (error)
  {
    return failResult([`runtime-role upstream receipt validation failed: ${error instanceof Error ? error.message : String(error)}`])
  }
  const runtimeRelative = runtimeBinding.path
  const runtimeArtifactDigest = sha256(runtimeBytes)
  if (runtimeArtifactDigest !== runtimeIdentity.artifactDigest)
  {
    return failResult(['runtime-role observation artifact digest mismatch'])
  }
  let runtimeObservation
  try
  {
    runtimeObservation = JSON.parse(runtimeBytes.toString('utf8'))
  }
  catch (error)
  {
    return failResult([`runtime-role observation parse failed: ${error instanceof Error ? error.message : String(error)}`])
  }
  const runtimeModes = Array.isArray(runtimeObservation?.modes) ? runtimeObservation.modes : []
  const runtimeUnsigned = {
    schema: runtimeObservation?.schema,
    modes: runtimeObservation?.modes,
    staticRoleCapabilities: runtimeObservation?.staticRoleCapabilities,
    unsupportedCombinations: runtimeObservation?.unsupportedCombinations,
    ownership: runtimeObservation?.ownership,
    deploymentAuthority: runtimeObservation?.deploymentAuthority,
    schemaOverlap: runtimeObservation?.schemaOverlap
  }
  const runtimeContentDigest = createHash('sha256')
    .update(JSON.stringify(runtimeUnsigned), 'utf8').digest('hex')
  if (runtimeObservation?.schema !== 'fsusblog.runtime-role-observation.v2'
    || runtimeObservation?.observationDigest !== runtimeContentDigest
    || runtimeModes.map((mode) => mode.id).sort().join(',') !== 'adaptive,single,static-role'
    || runtimeObservation?.ownership?.authorityState !== 'closed-current'
    || runtimeObservation?.ownership?.claimEligible !== true
    || runtimeObservation?.ownership?.failureReasons?.length !== 0
    || runtimeObservation?.deploymentAuthority?.schema !== 'fsusblog.runtime-role-deployment-observation.v1'
    || runtimeObservation?.deploymentAuthority?.authoritySchema !== 'fsusblog.monolithic-distributed-architecture.v2'
    || !/^sha256:[a-f0-9]{64}$/u.test(String(runtimeObservation?.deploymentAuthority?.authorityContentDigest ?? ''))
    || !/^sha256:[a-f0-9]{64}$/u.test(String(runtimeObservation?.deploymentAuthority?.observationDigest ?? ''))
    || !exactKeys(runtimeObservation?.deploymentAuthority?.effectiveCompose?.dockerExecutable,
      ['canonicalPath', 'digest', 'version'])
    || !exactKeys(runtimeObservation?.deploymentAuthority?.effectiveCompose?.composeImplementation,
      ['canonicalPath', 'digest', 'version'])
    || !/^[a-f0-9]{64}$/u.test(String(
      runtimeObservation?.deploymentAuthority?.effectiveCompose?.dockerExecutable?.digest ?? ''))
    || !/^[a-f0-9]{64}$/u.test(String(
      runtimeObservation?.deploymentAuthority?.effectiveCompose?.composeImplementation?.digest ?? ''))
    || runtimeObservation?.schemaOverlap?.authorityState !== 'observed-in-current-schema-manifest-probe'
    || runtimeObservation?.schemaOverlap?.claimEligible !== true
    || runtimeObservation?.schemaOverlap?.evidenceClass !== 'current-manifest-catalog-production-provider-model'
    || runtimeObservation?.schemaOverlap?.manifestDescriptorCount !== runtimeObservation?.schemaOverlap?.catalogMetadataCount
    || !/^sha256:[a-f0-9]{64}$/u.test(String(runtimeObservation?.schemaOverlap?.manifestDigest ?? ''))
    || !/^sha256:[a-f0-9]{64}$/u.test(String(runtimeObservation?.schemaOverlap?.catalogDigest ?? ''))
    || !/^sha256:[a-f0-9]{64}$/u.test(String(runtimeObservation?.schemaOverlap?.databaseObservationDigest ?? ''))
    || !/^sha256:[a-f0-9]{64}$/u.test(String(runtimeObservation?.schemaOverlap?.sourceReleaseManifestDigest ?? ''))
    || !/^sha256:[a-f0-9]{64}$/u.test(String(runtimeObservation?.schemaOverlap?.targetReleaseManifestDigest ?? ''))
    || runtimeObservation?.schemaOverlap?.sourceReleaseId === runtimeObservation?.schemaOverlap?.targetReleaseId
    || runtimeObservation?.schemaOverlap?.previousRollbackReleaseId === runtimeObservation?.schemaOverlap?.sourceReleaseId
    || runtimeObservation?.schemaOverlap?.sameReleaseFailureCode !== 'schema_previous_rollback_release_not_distinct'
    || JSON.stringify(runtimeObservation?.schemaOverlap?.missingExpandFailureCodes)
      !== JSON.stringify(['schema_expand_pending'])
    || JSON.stringify(runtimeObservation?.schemaOverlap?.concurrentContractFailureCodes) !== JSON.stringify([
      'schema_contract_backfill_incomplete',
      'schema_contract_backfill_unverified',
      'schema_contract_backup_restore_stale',
      'schema_contract_confirmation_missing',
      'schema_contract_current_release_dependency',
      'schema_contract_exclusive_mode_missing',
      'schema_contract_observation_window',
      'schema_contract_old_writes_enabled',
      'schema_contract_previous_release_dependency',
      'schema_contract_release_window_open',
      'schema_contract_rollback_manifest_open',
      'schema_contract_slot_switch_in_progress'
    ])
    || !Array.isArray(runtimeObservation?.unsupportedCombinations)
    || runtimeObservation.unsupportedCombinations.some((entry) => entry.errorCode === 'unexpectedly-accepted'))
  {
    return failResult(['runtime-role observation is partial, conflicting, or unsupported'])
  }
    let replayDirectory;
    try
    {
        const replayParentRelative = path.dirname(runtimeBinding.artifactPath).replaceAll(path.sep, '/');
        const segments = replayParentRelative.split('/');
        for (let count = 1; count <= segments.length; count += 1)
        {
            const relative = segments.slice(0, count).join('/');
            const absolute = path.join(context.repositoryRoot, relative);
            if (!existsSync(absolute))
            {
                mkdirSync(absolute, { mode: 0o700 });
            }
            resolveContainedPath(context.repositoryRoot, relative, 'directory');
        }
        const replayParent = resolveContainedPath(
            context.repositoryRoot,
            replayParentRelative,
            'directory'
        );
        replayDirectory = mkdtempSync(path.join(replayParent, 'replay-'));
        const replayOutput = path.join(replayDirectory, 'runtime-role-observation.json');
        const replay = spawnSync('dotnet', [
            assemblyAbsolute,
            '--deployment-observation', deploymentAbsolute,
            '--output', replayOutput
        ], {
            cwd: context.repositoryRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 5 * 60_000
        });
        if (replay.status !== 0 || !existsSync(replayOutput)
            || sha256(readFileSync(replayOutput)) !== runtimeArtifactDigest)
        {
            return failResult([
                `runtime-role compiled producer replay mismatch: ${String(replay.stderr ?? replay.stdout ?? '').trim()}`
            ]);
        }
    }
    catch (error)
    {
        return failResult([
            `runtime-role compiled producer replay mismatch: ${error instanceof Error ? error.message : String(error)}`
        ]);
    }
    finally
    {
        if (replayDirectory)
        {
            rmSync(replayDirectory, { recursive: true, force: true });
        }
    }
  const expectedDeploymentSources = {
    policy: 'tests/governance/monolithic-distributed-architecture.json',
    project: 'src/backend/FsusBlog.Server.csproj',
    dockerfile: 'ops/docker/FsusBlog.Server.Dockerfile',
    productionCompose: 'ops/docker/docker-compose.production.yml'
  }
  const deploymentSources = runtimeObservation.deploymentAuthority.sourceDigests
  if (deploymentSources == null || typeof deploymentSources !== 'object' || Array.isArray(deploymentSources)
    || Object.keys(deploymentSources).sort().join('\0') !== Object.keys(expectedDeploymentSources).sort().join('\0'))
  {
    return failResult(['runtime-role deployment source roster is not exact'])
  }
  try
  {
    for (const [id, expectedPath] of Object.entries(expectedDeploymentSources))
    {
      const source = deploymentSources[id]
      if (source == null || typeof source !== 'object' || Array.isArray(source)
        || Object.keys(source).sort().join('\0') !== 'digest\0path'
        || source.path !== expectedPath
        || !/^[a-f0-9]{64}$/u.test(String(source.digest ?? ''))
        || !allowed.has(source.path))
      {
        return failResult([`runtime-role deployment source shape is invalid: ${id}`])
      }
      if (digestText(readText(context.repositoryRoot, source.path, allowed)) !== source.digest)
      {
        return failResult([`runtime-role deployment source digest mismatch: ${source.path}`])
      }
    }
    const policy = JSON.parse(readText(
      context.repositoryRoot,
      expectedDeploymentSources.policy,
      allowed
    ))
    const { contentDigest, ...unsignedPolicy } = policy
    if (policy.schema !== runtimeObservation.deploymentAuthority.authoritySchema
      || contentDigest !== runtimeObservation.deploymentAuthority.authorityContentDigest
      || contentDigest !== `sha256:${digestValue(unsignedPolicy)}`)
    {
      return failResult(['runtime-role deployment policy authority digest mismatch'])
    }
    const currentOracleIdentity = resolveDockerComposeOracleIdentity({ root: context.repositoryRoot })
    if (digestValue(currentOracleIdentity)
      !== digestValue({
        dockerExecutable: runtimeObservation.deploymentAuthority.effectiveCompose?.dockerExecutable,
        composeImplementation: runtimeObservation.deploymentAuthority.effectiveCompose?.composeImplementation
      }))
    {
      return failResult(['runtime-role Docker Compose oracle executable identity mismatch'])
    }
  }
  catch (error)
  {
    return failResult([`runtime-role deployment source validation failed: ${error instanceof Error ? error.message : String(error)}`])
  }
  const expectedRuntimeBuildReceipt = {
    schema: 'fsusblog.runtime-role-observation-build-receipt.v3',
    artifactId: 'runtime-role-observation',
    artifactPath: '.tmp/contracts/runtime-role/runtime-role-observation.json',
    artifactDigest: runtimeArtifactDigest,
    configuration: 'Release',
    sourceCommit: context.sourceCommit,
    worktreeFingerprint: context.worktreeFingerprint,
    projectDigest: runtimeBinding.projectDigest,
    assemblyPath: runtimeBinding.assemblyPath,
    assemblyDigest: runtimeBinding.assemblyDigest,
    reproducibleBuild: runtimeBinding.buildReceipt.reproducibleBuild,
    deploymentArtifactPath: runtimeBinding.deploymentArtifactPath,
    deploymentArtifactDigest: runtimeBinding.deploymentArtifactDigest,
    producer: 'dotnet-run-content-addressed-minimal-contract-host',
    externalOracle: runtimeObservation.deploymentAuthority.effectiveCompose?.oracle,
    externalOracleVersion: runtimeObservation.deploymentAuthority.effectiveCompose?.oracleVersion,
    dockerExecutable: runtimeObservation.deploymentAuthority.effectiveCompose?.dockerExecutable,
    composeImplementation: runtimeObservation.deploymentAuthority.effectiveCompose?.composeImplementation,
    effectiveComposeModelDigest: runtimeObservation.deploymentAuthority.effectiveCompose?.modelDigest,
    deploymentAuthoritySchema: runtimeObservation.deploymentAuthority.authoritySchema,
    deploymentAuthorityContentDigest: runtimeObservation.deploymentAuthority.authorityContentDigest,
    deploymentObservationDigest: runtimeObservation.deploymentAuthority.observationDigest
  }
  if (!exactKeys(runtimeBinding.buildReceipt, Object.keys(expectedRuntimeBuildReceipt))
    || digestValue(runtimeBinding.buildReceipt) !== digestValue(expectedRuntimeBuildReceipt))
  {
    return failResult(['runtime-role observation build receipt digest mismatch'])
  }
  for (const source of declaredFactSources)
  {
    if (!allowed.has(source))
    {
      return failResult([`registry must declare fact source ${source}`])
    }
  }

  // Refuse docs/testing or historical generated docs as inputs.
  for (const input of allowed)
  {
    if (/^docs\/testing(?:\.|\/)/u.test(input) || /testing\.generated\.md$/u.test(input))
    {
      return failResult([`refuses docs/testing authority input ${input}`])
    }
    if (/(?:^|\/)(?:fixtures?|golden|baselines?)(?:\/|$)/iu.test(input))
    {
      return failResult([`refuses fixture/baseline authority input ${input}`])
    }
  }

  let matrixText
  let matrixSchema
  let coverageRegistry
  let executionClassContract
  try
    {
    matrixText = readText(context.repositoryRoot, 'tests/matrix.yml', allowed)
    matrixSchema = readJson(context.repositoryRoot, 'tests/matrix.schema.json', allowed)
    coverageRegistry = readJson(context.repositoryRoot, 'tests/coverage-registry.json', allowed)
    executionClassContract = readJson(
      context.repositoryRoot,
      'config/testing/producer-execution-class-contract.json',
      allowed
    )
    }
  catch (error)
  {
    return failResult([error instanceof Error ? error.message : String(error)])
  }

  // Guard against reverse generation from generated testing docs.
  if (matrixText.includes('generated by tools/docs/generate-testing-docs')
    || matrixText.includes('# Generated Test Matrix'))
  {
    return failResult(['matrix source must not be reverse-loaded from generated testing docs'])
  }

  let matrix
  try
  {
    matrix = parseMatrix(matrixText, { validateDependencyFields: true })
  }
  catch (error)
  {
    return failResult([`matrix parse failed: ${error instanceof Error ? error.message : String(error)}`])
  }

  const built = buildObservations({
    matrix,
    matrixSchema,
    coverageRegistry,
    executionClassContract
  })

  const retiredFromIds = new Set(
    (matrix.governance?.retiredTiers ?? []).map((entry) => entry?.from).filter(Boolean)
  )

  const consumerErrors = validateConsumers({
    repositoryRoot: context.repositoryRoot,
    allowed,
    matrix,
    tierIds: built.tierIds,
    profileIds: built.profileIds,
    retiredFromIds,
    finalizer: built.finalizer
  })

  const failureReasons = [...built.errors, ...consumerErrors]
  if (failureReasons.length > 0)
  {
    return failResult(failureReasons)
  }

  const facts = built.facts ?? built.observations?.facts
  if (facts == null || typeof facts !== 'object')
  {
    return failResult(['topology facts map missing'])
  }
  const releaseFinalPaths = {
    requiredEvidenceLedger: 'config/testing/required-evidence-authority-ledger.json',
    dispositionLedger: 'config/testing/release-domain-assertion-dispositions.json',
    evidenceContract: 'tools/test-matrix/release-final-evidence-contract.mjs',
    evidenceCatalog: 'tools/test-matrix/required-evidence-catalog.mjs',
    semanticOutcome: 'tools/test-matrix/outcomes/release-finalizer-adapter.mjs',
    adapterSupport: 'tools/test-matrix/outcomes/adapter-support.mjs',
    outcomeContract: 'tools/test-matrix/outcomes/outcome-contract.mjs',
    releaseDomainLedger: 'tools/test-matrix/release-domain-ledger.mjs',
    failureTaxonomy: 'config/testing/outcome-failure-taxonomy.json',
    fieldDispositions: 'config/testing/outcome-field-dispositions.json',
    attemptProvenance: 'tools/test/attempt-provenance.mjs',
    postRuntimeSeal: 'tools/test-matrix/behavior-evidence-post-runtime.mjs'
  }
  const releaseFinalSources = Object.fromEntries(Object.entries(releaseFinalPaths).map(([id, sourcePath]) => [id, {
    path: sourcePath,
    text: readText(context.repositoryRoot, sourcePath, allowed)
  }]))
  const releaseFinalLedger = JSON.parse(releaseFinalSources.requiredEvidenceLedger.text)
  const canonicalReleaseFinalInputs = sortedUniqueStrings(releaseFinalLedger.entries
    .filter((entry) => entry.allowDiagnostic !== true)
    .flatMap((entry) => entry.producerTierIds ?? []))
  try
    {
    facts['release-final.aggregate-contract'] = observeReleaseFinalFacts({
      matrix,
      canonical: {
        schema: 'fsusblog.release-final-evidence-inputs.v1',
        targetTier: 'release-final',
        inputs: canonicalReleaseFinalInputs
      },
      ledger: releaseFinalLedger,
      dispositionLedger: JSON.parse(releaseFinalSources.dispositionLedger.text),
      repositoryRoot: context.repositoryRoot,
      moduleSources: releaseFinalSources,
      sourceCommit: context.sourceCommit,
      worktreeFingerprint: context.worktreeFingerprint,
      buildIdentity: context.buildIdentity
    })
    }
  catch (error)
  {
    return failResult([error instanceof Error ? error.message : String(error)])
  }
  const { failureReasons: runtimeOwnershipFailureReasons, ...runtimeOwnership } = runtimeObservation.ownership
  facts['deployment.runtime-role-contract'] = {
    schema: runtimeObservation.schema,
    modes: Object.fromEntries(runtimeModes.map((mode) => [mode.id, {
      staticRoles: mode.staticRoles.length > 0 ? mode.staticRoles : ['none'],
      clusterMembershipEnabled: mode.clusterMembershipEnabled,
      adaptiveSchedulerEnabled: mode.adaptiveSchedulerEnabled,
      distributedInvalidationEnabled: mode.distributedInvalidationEnabled,
      localInvocationOnly: mode.localInvocationOnly,
      roleCombinationState: mode.roleCombinationState
    }])),
    staticRoleCapabilities: runtimeObservation.staticRoleCapabilities,
    unsupportedCombinations: Object.fromEntries(
      runtimeObservation.unsupportedCombinations.map((entry) => [entry.id, entry.errorCode])),
    ownership: {
      ...runtimeOwnership,
      ...(runtimeOwnershipFailureReasons.length > 0 ? { failureReasons: runtimeOwnershipFailureReasons } : {})
    },
    deploymentAuthority: {
      ...runtimeObservation.deploymentAuthority,
      effectiveCompose: projectEffectiveCompose(runtimeObservation.deploymentAuthority.effectiveCompose),
      volumeTopology: projectVolumeTopology(runtimeObservation.deploymentAuthority.volumeTopology)
    },
    schemaOverlap: runtimeObservation.schemaOverlap,
    observationDigest: runtimeObservation.observationDigest,
    artifactDigest: runtimeArtifactDigest
  }
  const blueGreenModulePaths = {
    slot: 'tools/deployment/slot-lib.mjs',
    rollout: 'tools/deployment/release-rollout-lib.mjs',
    releaseAssetsGc: 'tools/storage/release-gc.mjs',
    destructiveOperations: 'tools/deployment/destructive-operation-authority.mjs',
    onlineSchema: 'src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationCompatibility.cs',
    topologyAuthority: 'tools/governance/check-monolithic-distributed-architecture.mjs'
  }
  let destructiveAuthority
  try
  {
    destructiveAuthority = validateDestructiveOperationAuthority(JSON.parse(readText(
      context.repositoryRoot,
      'config/deployment/destructive-operation-authority.json',
      allowed
    )))
  }
  catch (error)
  {
    return failResult([`destructive-operation authority invalid: ${error instanceof Error ? error.message : String(error)}`])
  }
  facts['deployment.blue-green-contract'] = observeBlueGreenFacts(Object.fromEntries(
    Object.entries(blueGreenModulePaths).map(([id, sourcePath]) => [id, {
      path: sourcePath,
      text: readText(context.repositoryRoot, sourcePath, allowed)
    }])
  ), runtimeObservation, destructiveAuthority)
  built.observations.topologyDigest = digestValue(
    Object.fromEntries(requiredFactKeys.map((key) => [key, facts[key]]))
  )
  // Hyphen-free aliases mirror the exact fields bound by controlled prose claims.
  built.observations.releaseFinalAggregate = {
    executesTestCommands: facts['release-final.aggregate-contract'].executesTestCommands,
    artifactOnly: facts['release-final.aggregate-contract'].artifactOnly
  }
  built.observations.deploymentBlueGreen = {
    claimEligible: facts['deployment.blue-green-contract'].claimEligible
  }
  for (const key of requiredFactKeys)
  {
    if (!Object.hasOwn(facts, key))
    {
      return failResult([`missing required fact ${key}`])
    }
  }
  if (!isSortedUniqueStrings(facts['test.topology.tiers']))
  {
    return failResult(['test.topology.tiers must be a sorted unique ID set'])
  }
  if (!isSortedUniqueStrings(facts['test.topology.profiles'])
    && !(Array.isArray(facts['test.topology.profiles'])
      && facts['test.topology.profiles'].length === 1
      && facts['test.topology.profiles'][0] === 'none'))
  {
    return failResult(['test.topology.profiles must be a sorted unique ID set'])
  }

  return {
    status: 'ok',
    failureReasons: [],
    observations: built.observations
  }
}

export const TEST_MATRIX_REQUIRED_FACT_KEYS = requiredFactKeys
export const TEST_MATRIX_DECLARED_FACT_SOURCES = declaredFactSources
export const TEST_MATRIX_CONSUMER_INPUTS = consumerInputs;
