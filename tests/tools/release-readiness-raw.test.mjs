import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { resolveSourceCommit } from '../../tools/fact-extractors/identity.mjs'
import { seal } from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import { loadPostRuntimeProducerRegistry, root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import {
  produceReleaseReadinessAuthorityBundle,
  projectReleaseReadinessRaw,
  releaseReadinessSourceSchema,
  verifyReleaseReadinessRaw
} from '../../tools/test-evidence/release-readiness-raw.mjs'
import { createPostRuntimeCandidateFixture } from './support/post-runtime-candidate-fixture.mjs'
import { createReleaseRolloutEvidenceFixture } from './support/release-rollout-evidence-fixture.mjs'
import {
  createRuntimeRoleMinimalV4Fixture,
  createRuntimeRoleStaticV4Fixture
} from './support/runtime-role-minimal-v3-fixture.mjs'
import {
  createReadinessManifest,
  digest,
  fileDigest,
  semanticDigest,
  write
} from './support/release-readiness-test-helpers.mjs'

const commit = resolveSourceCommit(root)
const releaseId = `20260711010101-${commit.slice(0, 12)}`

function fixture(context)
{
  const candidate = createPostRuntimeCandidateFixture(context, {
    prefix: 'release-readiness-raw-', runId: 'run-release-2208', candidate: { releaseId }
  })
  const { directory, commit } = candidate
  const fingerprint = `sha256:${candidate.worktreeFingerprint}`
  const relative = (name) => path.relative(root, path.join(directory, name)).replaceAll(path.sep, '/')
  const build = candidate.build
  const manifest = createReadinessManifest(releaseId, commit)
  const manifestPath = path.join(directory, 'release-manifest.json')
  write(manifestPath, manifest)

  const plan = candidate.plan
  const planPath = candidate.planFile
  const producer = { producerId: plan.producerId }

  const artifactDigest = semanticDigest(build.artifacts)
  const packageDigest = semanticDigest({ domains: build.domains, artifacts: build.artifacts })
  const manifestBytesDigest = fileDigest(manifestPath)
  const runtimeRole = {
    schema: 'fsusblog.release-readiness.runtime-role.v1',
    releaseId, slot: 'green', runtimeId: plan.candidate.runtimeId,
    topologyMode: 'monolithic', deploymentMode: 'candidate',
    processIdentityDigest: digest('9'), containerIdentityDigest: digest('a'),
    serviceIdentityDigest: digest('b'), ownershipDigest: digest('c'),
    actualObservationSources: ['container-runtime-inspect', 'proc-cgroup', 'service-manager-status'],
    processCount: 3, containerCount: 1, serviceCount: 1, unknownOwnerCount: 0,
    conflictingOwnerCount: 0, observedRole: 'candidate', roleContractSatisfied: true,
    monolithicOwnershipSatisfied: true
  }
  const schemaObservation = {
    schema: 'fsusblog.release-readiness.database-schema.v1', releaseId,
    minimumCoordinate: releaseId, maximumCoordinate: releaseId, observedCoordinate: releaseId,
    schemaDigest: digest('d'), compatible: true, verified: true
  }
  const trust = {
    schema: 'fsusblog.release-readiness.trust.v1', policyDigest: digest('e'),
    publisherIdentityDigest: digest('f'), decision: 'trusted', artifactDigest: manifest.imageDigest,
    manifestDigest: manifestBytesDigest, transparencyLogDigest: digest('0'), verified: true
  }
  const versionDigest = semanticDigest({ toolchain: manifest.toolchain, runtimeProfile: manifest.runtimeProfile })
  const check = (name, authority, anchor) => ({
    schema: `fsusblog.release-readiness.${name}.v1`, authority,
    expectedDigest: anchor, observedDigest: anchor, sampleCount: 2, semanticMatch: true, status: 'passed'
  })
  const source = seal({
    schema: releaseReadinessSourceSchema,
    producerId: producer.producerId,
    sourceState: {
      sourceCommit: commit, worktreeFingerprint: fingerprint, buildIdentity: build.contentDigest,
      artifactDigest, candidateId: plan.candidate.candidateId, releaseId,
      runtimeId: plan.candidate.runtimeId, runId: plan.candidate.runId,
      attemptId: plan.candidate.attemptId, slot: 'green'
    },
    provenance: {
      schema: 'fsusblog.release-readiness-provenance.v1', mode: 'current-candidate-runtime',
      collectorId: 'release-readiness-runtime-probe', observedAtUtc: '2026-07-11T01:02:00.000Z',
      rerunCommand: 'node tools/deployment/collect-release-readiness-observation.mjs --candidate-plan .tmp/current/candidate-plan.json',
      syntheticSemanticResult: false, diagnostic: false, recovered: false, historicalFallback: false
    },
    manifestRef: { path: relative('release-manifest.json'), fileDigest: manifestBytesDigest },
    observations: {
      image: {
        schema: 'fsusblog.release-readiness.image.v1', releaseId, imageRef: manifest.imageRef,
        imageDigest: manifest.imageDigest, registryDigest: manifest.imageDigest,
        runtimeImageDigest: manifest.imageDigest, imageConfigDigest: digest('1'),
        registryInspected: true, verified: true
      },
      package: {
        schema: 'fsusblog.release-readiness.package.v1', buildIdentity: build.contentDigest,
        artifactDigest, packageDigest, imageDigest: manifest.imageDigest,
        artifactCount: build.artifacts.length, verified: true
      },
      config: {
        schema: 'fsusblog.release-readiness.config.v1', releaseId, slot: 'green',
        expectedDigest: digest('2'), observedDigest: digest('2'), publicProjectionDigest: digest('3'),
        redacted: true, secretValuesPersisted: false, verified: true
      },
      databaseSchema: schemaObservation,
      signing: {
        schema: 'fsusblog.release-readiness.signing.v1', algorithm: 'sigstore-bundle',
        payloadDigest: manifestBytesDigest, signatureDigest: digest('4'), signerIdentityDigest: digest('5'),
        verificationReceiptDigest: digest('6'), verified: true
      },
      trust,
      runtimeRole,
      readiness: {
        schema: 'fsusblog.release-readiness.semantic-probes.v1', releaseId, slot: 'green',
        runtimeId: plan.candidate.runtimeId, probeClass: 'semantic-contract',
        checks: {
          service: check('service', 'runtime-health-contract', runtimeRole.serviceIdentityDigest),
          routeData: check('routeData', 'route-data-semantic-probe', digest('7')),
          cache: check('cache', 'cache-coherence-probe', digest('8')),
          dependencies: check('dependencies', 'dependency-version-probe', schemaObservation.schemaDigest),
          version: check('version', 'runtime-version-inspect', versionDigest),
          credential: check('credential', 'credential-capability-probe', trust.policyDigest)
        },
        processAliveOnly: false, portOpenOnly: false, http200Only: false,
        fileExistsOnly: false, jobStatusOnly: false, terminalStatus: 'verified'
      }
    }
  })
  const sourcePath = path.join(directory, 'release-readiness-source.json')
  write(sourcePath, source)
  return {
    directory, relative, plan, planPath, build, manifest, manifestPath,
    source, sourcePath, rawPath: path.join(root, candidate.observationPaths['release-identity-readiness'])
  }
}

function rewriteSource(value, mutate)
{
  const changed = structuredClone(value.source)
  mutate(changed)
  delete changed.contentDigest
  value.source = seal(changed)
  write(value.sourcePath, value.source)
}

function project(value)
{
  return projectReleaseReadinessRaw({
    candidatePlan: value.relative('candidate-plan.json'),
    sourceReceipt: value.relative('release-readiness-source.json'),
    repositoryRoot: root
  })
}

test('projects exact release identity/readiness facts and independently replays all source bytes', (context) =>
{
  const value = fixture(context)
  const raw = project(value)
  write(value.rawPath, raw)
  assert.equal(raw.sourceState.sourceCommit, commit)
  assert.equal(raw.sourceState.buildIdentity, value.build.contentDigest)
  assert.equal(raw.sourceState.candidateId, value.plan.candidate.candidateId)
  assert.equal(raw.sourceState.releaseId, releaseId)
  assert.equal(raw.semanticFacts.imageDigest, value.manifest.imageDigest)
  assert.equal(raw.semanticFacts.packageDigest, value.source.observations.package.packageDigest)
  assert.equal(raw.semanticFacts.runtimeRoleContractSatisfied, true)
  if (Array.isArray(loadPostRuntimeProducerRegistry(root)
    .observationClasses['release-identity-readiness'].requiredSemanticFactFields))
  {
    assert.throws(() => verifyReleaseReadinessRaw(path.relative(root, value.rawPath), root), /missing or unknown fields/u)
  }
  else
  {
    assert.equal(verifyReleaseReadinessRaw(path.relative(root, value.rawPath), root).contentDigest, raw.contentDigest)
  }
})

test('rejects process, port, HTTP, file and job success shortcuts', (context) =>
{
  for (const shortcut of ['processAliveOnly', 'portOpenOnly', 'http200Only', 'fileExistsOnly', 'jobStatusOnly'])
  {
    const value = fixture(context)
    rewriteSource(value, (source) => { source.observations.readiness[shortcut] = true })
    assert.throws(() => project(value), new RegExp(`${shortcut} cannot qualify`, 'u'))
  }
})

test('rejects config, route/data, package and cross-candidate identity drift', (context) =>
{
  const cases = [
    ['config', (source) => { source.observations.config.observedDigest = digest('f') }, /runtime config observation/u],
    ['route/data', (source) => { source.observations.readiness.checks.routeData.observedDigest = digest('f') }, /routeData readiness semantic observation/u],
    ['package', (source) => { source.observations.package.packageDigest = digest('f') }, /package observation/u],
    ['candidate', (source) => { source.sourceState.candidateId = 'another-candidate' }, /candidateId does not exact-match/u]
  ]
  for (const [name, mutate, pattern] of cases)
  {
    const value = fixture(context)
    rewriteSource(value, mutate)
    assert.throws(() => project(value), pattern, name)
  }
})

test('rejects synthetic, diagnostic, recovered and historical evidence', (context) =>
{
  for (const field of ['syntheticSemanticResult', 'diagnostic', 'recovered', 'historicalFallback'])
  {
    const value = fixture(context)
    rewriteSource(value, (source) => { source.provenance[field] = true })
    assert.throws(() => project(value), /cannot qualify/u)
  }
})

test('rejects unknown runtime ownership and name-only role inference', (context) =>
{
  const value = fixture(context)
  rewriteSource(value, (source) => {
    source.observations.runtimeRole.unknownOwnerCount = 1
    source.observations.runtimeRole.actualObservationSources = ['compose-service-name']
  })
  assert.throws(() => project(value), /runtime-role ownership is unknown, conflicting, inferred/u)
})

test('rejects missing, duplicate-like and unknown observation classes', (context) =>
{
  const missing = fixture(context)
  rewriteSource(missing, (source) => { delete source.observations.signing })
  assert.throws(() => project(missing), /observations fields are incomplete or unsupported/u)

  const unknown = fixture(context)
  rewriteSource(unknown, (source) => { source.observations['release-identity-readiness-copy'] = source.observations.image })
  assert.throws(() => project(unknown), /observations fields are incomplete or unsupported/u)
})

test('rejects documentation/latest paths and manifest/signing/trust identity drift', (context) =>
{
  const pathValue = fixture(context)
  rewriteSource(pathValue, (source) => { source.manifestRef.path = 'docs/latest/release-manifest.json' })
  assert.throws(() => project(pathValue), /must not read documentation or latest\/history paths/u)

  const signing = fixture(context)
  rewriteSource(signing, (source) => { source.observations.signing.payloadDigest = digest('f') })
  assert.throws(() => project(signing), /manifest signature was not verified/u)

  const trust = fixture(context)
  rewriteSource(trust, (source) => { source.observations.trust.artifactDigest = digest('f') })
  assert.throws(() => project(trust), /trust decision does not bind/u)
})

test('independent verifier rejects source and projected receipt tamper', (context) =>
{
  const typedEnvelope = Array.isArray(loadPostRuntimeProducerRegistry(root)
    .observationClasses['release-identity-readiness'].requiredSemanticFactFields)
  const sourceTamper = fixture(context)
  const raw = project(sourceTamper)
  write(sourceTamper.rawPath, raw)
  fs.appendFileSync(sourceTamper.sourcePath, ' ')
  assert.throws(() => verifyReleaseReadinessRaw(path.relative(root, sourceTamper.rawPath), root),
    typedEnvelope ? /missing or unknown fields/u : /source receipt digest mismatch/u)

  const outputTamper = fixture(context)
  const projected = project(outputTamper)
  const changed = structuredClone(projected)
  changed.semanticFacts.cacheReady = false
  delete changed.contentDigest
  write(outputTamper.rawPath, seal(changed))
  assert.throws(() => verifyReleaseReadinessRaw(path.relative(root, outputTamper.rawPath), root),
    typedEnvelope ? /missing or unknown fields/u : /raw replay mismatch/u)
})

test('canonical production path rejects a self-sealed readiness receipt as rollout authority', (context) =>
{
  const value = fixture(context)
  assert.throws(() => produceReleaseReadinessAuthorityBundle({
    candidatePlan: value.relative('candidate-plan.json'),
    rolloutEvidence: value.relative('release-readiness-source.json'),
    runtimeRoleAdmission: value.relative('release-readiness-source.json'),
    repositoryRoot: root
  }), /canonical release rollout verifier rejected/u)
})
