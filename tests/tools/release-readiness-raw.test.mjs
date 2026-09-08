import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { digestValue, stable } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { resolveSourceCommit } from '../../tools/fact-extractors/identity.mjs'
import { seal } from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import { createReleaseManifest } from '../../tools/release/release-manifest.mjs'
import {
  produceReleaseReadinessAuthorityBundle,
  projectReleaseReadinessRaw,
  releaseReadinessSourceSchema,
  verifyReleaseReadinessRaw
} from '../../tools/test-evidence/release-readiness-raw.mjs'
import { loadPostRuntimeProducerRegistry, root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { createPostRuntimeCandidateFixture } from './support/post-runtime-candidate-fixture.mjs'
import { buildReleaseReadinessAuthorityBundle, buildBlueGreenAuthorityBundle }
  from '../../tools/test-evidence/release-authority-bundle-contract.mjs'
import { deriveReleaseReadinessAuthorityFacts, deriveBlueGreenAuthorityFacts }
  from '../../tools/test-evidence/release-authority-facts-contract.mjs'
import { seal as pureSeal } from '../../tools/fact-extractors/post-runtime/receipt-seal-contract.mjs'
import {
  canonicalAuthorityMaxBytes,
  createCanonicalReleaseAuthorityReader,
  verifyCanonicalReleaseAuthorities
} from '../../tools/test-evidence/canonical-release-authorities.mjs'
import { verifyCanonicalReleaseAuthorityValues }
  from '../../tools/test-evidence/canonical-release-authorities-value-contract.mjs'
import { createReleaseRolloutEvidenceFixture } from './support/release-rollout-evidence-fixture.mjs'
import { createRuntimeRoleMinimalV3Fixture, createRuntimeRoleStaticV3Fixture }
  from './support/runtime-role-minimal-v3-fixture.mjs'

// Synthetic source values exercise binding logic only, never runtime qualification.
function canonicalAuthorityFixture(context)
{
  const directory = fs.mkdtempSync(path.join(root, '.tmp', 'canonical-authority-values-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = { sourceCommit: 'b'.repeat(40), worktreeFingerprint: 'c'.repeat(64) }
  const releaseId = '20260711010101-bbbbbbbbbbbb'
  const rolloutId = 'rollout-canonical-value-fixture'
  for (const file of [
    'config/contracts/behavior-fact-extractors.json',
    'src/shared/Contracts/Validation/release-id-contract.json',
    'src/shared/Contracts/Validation/schema-compatibility-coordinate.json'
  ])
  {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
    fs.copyFileSync(path.join(root, file), path.join(directory, file))
  }
  const rolloutFixture = createReleaseRolloutEvidenceFixture({
    rolloutId, target: { slot: 'green', releaseId, imageDigest: digest('1'), runtimeGeneration: 42 }
  })
  const rolloutDirectory = path.join(directory, '.tmp', 'rollout')
  const data = { directory: rolloutDirectory, stateFile: path.join(rolloutDirectory, 'state.json'),
    commandDirectory: path.join(rolloutDirectory, 'commands'), artifactDirectory: path.join(rolloutDirectory, 'artifacts') }
  rolloutFixture.advanceState(data, { includeFinalStage: true })
  const artifacts = rolloutFixture.writeArtifacts(data)
  const auxiliary = rolloutFixture.writeAuxiliary(data)
  const manifest = createReadinessManifest(releaseId, source.sourceCommit)
  write(auxiliary.releaseManifest, manifest)
  const rolloutFile = path.join(rolloutDirectory, 'release-rollout.json')
  const finalized = rolloutFixture.runEvidence(['finalize', '--state', data.stateFile, '--out', rolloutFile,
    ...rolloutFixture.artifactArgs(artifacts), ...rolloutFixture.auxiliaryArgs(auxiliary)])
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout)
  const rollout = rolloutFixture.parseStdout(finalized)
  const minimal = createRuntimeRoleMinimalV3Fixture('canonical-value-test', source)
  const artifact = minimal.artifacts['runtime-role-observation']
  const observation = { schema: 'fsusblog.runtime-role-observation.v2', ownership: { claimEligible: true },
    deploymentAuthority: { observationDigest: artifact.buildReceipt.deploymentObservationDigest } }
  const deployment = { schema: 'fsusblog.runtime-role-deployment-observation.v1', ownership: { claimEligible: true },
    observationDigest: artifact.buildReceipt.deploymentObservationDigest }
  write(path.join(directory, artifact.path), observation)
  write(path.join(directory, artifact.deploymentArtifactPath), deployment)
  artifact.artifactDigest = fileDigest(path.join(directory, artifact.path)).slice('sha256:'.length)
  artifact.buildReceipt.artifactDigest = artifact.artifactDigest
  artifact.deploymentArtifactDigest = fileDigest(path.join(directory, artifact.deploymentArtifactPath)).slice('sha256:'.length)
  artifact.buildReceipt.deploymentArtifactDigest = artifact.deploymentArtifactDigest
  minimal.contentDigest = null
  minimal.contentDigest = digestValue(minimal)
  const extractorIds = JSON.parse(fs.readFileSync(path.join(directory, 'config/contracts/behavior-fact-extractors.json')))
    .extractors.map(extractor => extractor.id).sort()
  const admission = createRuntimeRoleStaticV3Fixture('canonical-value-test', source, {
    repositoryRoot: directory, extractorIds, minimalContractBuild: minimal
  })
  const admissionFile = path.join(directory, '.tmp', 'admission.json')
  write(admissionFile, admission)
  const plan = { sourceState: { commit: source.sourceCommit, worktreeFingerprint: `sha256:${source.worktreeFingerprint}` },
    candidate: { releaseId, rolloutId } }
  const options = { candidatePlan: plan, rolloutEvidence: path.relative(directory, rolloutFile),
    runtimeRoleAdmission: path.relative(directory, admissionFile), repositoryRoot: directory, now: Date.now() }
  const snapshots = new Map()
  const capture = dir => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }))
    {
      const file = path.join(dir, item.name)
      if (item.isDirectory()) capture(file)
      else snapshots.set(file, fs.readFileSync(file))
    }
  }
  capture(directory)
  const readers = map => {
    const readBytes = file => {
      const value = map.get(path.resolve(directory, file))
      if (!value) throw new Error(`missing test bytes: ${file}`)
      return Buffer.from(value)
    }
    const readJson = file => {
      const bytes = readBytes(file)
      const value = JSON.parse(bytes.toString('utf8'))
      return { value, ref: { path: path.relative(directory, path.resolve(directory, file)),
        fileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, contentDigest: value.contentDigest ?? null } }
    }
    return { readJson, readBytes }
  }
  return { directory, options, snapshots, readers, rolloutFile, rollout, admissionFile, admission, artifact }
}

test('canonical authority synthetic value replay and contained wrapper agree without qualifying a runtime', context =>
{
  const fixture = canonicalAuthorityFixture(context)
  const actual = verifyCanonicalReleaseAuthorityValues({ ...fixture.options, ...fixture.readers(fixture.snapshots) })
  const wrapped = verifyCanonicalReleaseAuthorities(fixture.options)
  assert.deepEqual(actual, wrapped)
  assert.equal(actual.authorityDigest, semanticDigest({
    rollout: actual.rollout.ref.fileDigest, runtimeRole: actual.runtimeRole.observation.ref.fileDigest,
    deployment: actual.runtimeRole.deployment.ref.fileDigest, manifest: actual.manifest.ref.fileDigest
  }))
  assert.equal(actual.runtimeRole.buildReceipt.schema, 'fsusblog.runtime-role-observation-build-receipt.v3')
})

test('canonical authority values reject coordinated source mutations and the current legacy producer', context =>
{
  const fixture = canonicalAuthorityFixture(context)
  const currentBuildSchema = fs.readFileSync(path.join(root, 'tools/contracts/lib/runtime-role-observation.mjs'), 'utf8')
    .match(/schema: '(fsusblog\.runtime-role-observation-build-receipt\.v\d+)'/u)?.[1]
  assert.equal(typeof currentBuildSchema, 'string', 'current producer schema must remain independently discoverable')
  const cases = [
    ['current legacy producer', values => { values.artifact.buildReceipt.schema = currentBuildSchema }],
    ['v2 build downgrade', values => { values.artifact.buildReceipt.schema = 'fsusblog.runtime-role-observation-build-receipt.v2' }],
    ['unowned producer', values => { values.artifact.buildReceipt.producer = 'fixture-self-approval' }],
    ['empty source closure', values => {
      values.minimal.sourceClosureDigests = []
      values.artifact.buildReceipt.reproducibleBuild.sourceClosureDigest = digestValue([])
    }],
    ['v1 runtime observation', values => { values.observation.schema = 'fsusblog.runtime-role-observation.v1' }],
    ['runtime ownership unknown', values => { values.observation.ownership.claimEligible = false }],
    ['deployment ownership unknown', values => { values.deployment.ownership.claimEligible = false }],
    ['deployment observation mismatch', values => { values.observation.deploymentAuthority.observationDigest = digest('f') }],
    ['build observation mismatch', values => { values.deployment.observationDigest = digest('f'); values.observation.deploymentAuthority.observationDigest = digest('f') }],
    ['runtime byte drift', values => { values.observation.changed = true }, { bindRuntime: false }],
    ['manifest byte drift', values => { values.manifest.runtimeProfile.nativeAot = true }, { bindManifest: false }],
    ['resealed manifest runtime profile', values => { values.manifest.runtimeProfile.nativeAot = true }],
    ['resealed manifest sensitive field', values => { values.manifest.toolchain.extra = [{ secret: 'synthetic' }] }],
    ['legacy manifest', values => { values.manifest.schema = 'fsusblog.release-manifest.v1' }],
    ['candidate rollout mismatch', values => { values.plan.candidate.rolloutId = 'other-rollout' }],
    ['candidate release mismatch', values => { values.plan.candidate.releaseId = '20260711010101-aaaaaaaaaaaa' }],
    ['candidate source mismatch', values => { values.plan.sourceState.commit = 'a'.repeat(40) }],
    ['admission source mismatch', values => { values.admission.source.worktreeFingerprint = 'f'.repeat(64) }],
    ['admission worktree mismatch', values => { values.admission.worktree.root = '/another-worktree' }],
    ['admission early spawn', values => { values.admission.candidateSpawnCountBeforeReceipt = 1 }],
    ['admission unknown field', values => { values.admission.unknown = true }],
    ['independent extractor roster drift', values => { values.registry.extractors.pop() }]
  ]
  assert.notEqual(currentBuildSchema,
    'fsusblog.runtime-role-observation-build-receipt.v3', 'current producer authority inventory changed; re-audit the v3 gap')
  for (const [name, mutate, binding = {}] of cases)
  {
    const bytes = new Map(fixture.snapshots)
    const readers = fixture.readers(bytes)
    const admission = readers.readJson(fixture.admissionFile).value
    const minimal = admission.minimalContractBuild
    const artifact = minimal.artifacts['runtime-role-observation']
    const rollout = readers.readJson(fixture.rolloutFile).value
    const values = { admission, minimal, artifact, rollout,
      plan: structuredClone(fixture.options.candidatePlan),
      observation: readers.readJson(artifact.path).value,
      deployment: readers.readJson(artifact.deploymentArtifactPath).value,
      manifest: readers.readJson(rollout.auxiliary.releaseManifest.path).value,
      registry: readers.readJson('config/contracts/behavior-fact-extractors.json').value }
    mutate(values)
    const put = (file, value) => bytes.set(path.resolve(fixture.directory, file), Buffer.from(`${JSON.stringify(value, null, 2)}\n`))
    put(artifact.path, values.observation)
    put(artifact.deploymentArtifactPath, values.deployment)
    put(rollout.auxiliary.releaseManifest.path, values.manifest)
    put('config/contracts/behavior-fact-extractors.json', values.registry)
    if (binding.bindRuntime !== false)
    {
      artifact.artifactDigest = readers.readJson(artifact.path).ref.fileDigest.slice('sha256:'.length)
      artifact.buildReceipt.artifactDigest = artifact.artifactDigest
      artifact.deploymentArtifactDigest = readers.readJson(artifact.deploymentArtifactPath).ref.fileDigest.slice('sha256:'.length)
      artifact.buildReceipt.deploymentArtifactDigest = artifact.deploymentArtifactDigest
    }
    if (binding.bindManifest !== false)
    {
      const file = rollout.auxiliary.releaseManifest.path
      rollout.auxiliary.releaseManifest.sha256 = readers.readJson(file).ref.fileDigest
      rollout.auxiliary.releaseManifest.bytes = readers.readBytes(file).length
    }
    minimal.contentDigest = null
    minimal.contentDigest = digestValue(minimal)
    admission.contentDigest = null
    admission.contentDigest = digestValue(admission)
    put(fixture.admissionFile, admission)
    put(fixture.rolloutFile, rollout)
    assert.throws(() => verifyCanonicalReleaseAuthorityValues({
      ...fixture.options, candidatePlan: values.plan, ...readers
    }), /canonical-release-authorities|BehaviorDoc admission|minimal contract build/u, name)
  }
  assert.equal(cases.length, 22)
})

function authorityReaderFixture(context)
{
  const directory = fs.mkdtempSync(path.join(root, '.tmp', 'canonical-authority-reader-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const repositoryRoot = path.join(directory, 'repository')
  fs.mkdirSync(repositoryRoot)
  const file = path.join(repositoryRoot, 'evidence.json')
  fs.writeFileSync(file, '{"status":"pass"}\n')
  return { directory, repositoryRoot, file, reader: createCanonicalReleaseAuthorityReader(repositoryRoot) }
}

test('canonical authority reader preserves contained absolute and relative bytes and rejects escaped paths', context =>
{
  const fixture = authorityReaderFixture(context)
  const expected = fs.readFileSync(fixture.file)
  assert.deepEqual(fixture.reader.readBytes(fixture.file), expected)
  assert.deepEqual(fixture.reader.readBytes('evidence.json'), expected)
  const json = fixture.reader.readJson('evidence.json', 'test evidence')
  assert.deepEqual(json.value, { status: 'pass' })
  assert.equal(json.ref.path, 'evidence.json')
  assert.equal(json.ref.fileDigest, `sha256:${createHash('sha256').update(expected).digest('hex')}`)
  const outside = path.join(fixture.directory, 'outside.json')
  fs.writeFileSync(outside, '{}')
  for (const file of [outside, '../outside.json', 'directory/../evidence.json', 'directory\\evidence.json', ''])
    assert.throws(() => fixture.reader.readBytes(file), /path|repository/u)
})

test('canonical authority reader rejects symlinks hardlinks directories and oversized inputs', context =>
{
  const fixture = authorityReaderFixture(context)
  const symlink = path.join(fixture.repositoryRoot, 'symbolic.json')
  fs.symlinkSync(fixture.file, symlink)
  assert.throws(() => fixture.reader.readBytes(symlink), /symlink/u)
  const alias = path.join(fixture.repositoryRoot, 'alias')
  fs.symlinkSync(fixture.repositoryRoot, alias)
  assert.throws(() => fixture.reader.readBytes('alias/evidence.json'), /symlink/u)
  const hardlink = path.join(fixture.repositoryRoot, 'hard.json')
  fs.linkSync(fixture.file, hardlink)
  assert.throws(() => fixture.reader.readBytes(hardlink), /single-link/u)
  const directory = path.join(fixture.repositoryRoot, 'directory.json')
  fs.mkdirSync(directory)
  assert.throws(() => fixture.reader.readBytes(directory), /regular file/u)
  const oversized = path.join(fixture.repositoryRoot, 'oversized.json')
  const descriptor = fs.openSync(oversized, 'w')
  fs.ftruncateSync(descriptor, canonicalAuthorityMaxBytes + 1)
  fs.closeSync(descriptor)
  assert.throws(() => fixture.reader.readBytes(oversized), /bounded/u)
})

test('canonical authority reader rejects in-place and replacement TOCTOU during a byte read', context =>
{
  const fixture = authorityReaderFixture(context)
  const originalRead = fs.readFileSync
  for (const replace of [false, true])
  {
    fs.writeFileSync(fixture.file, '{"status":"pass"}\n')
    const replacement = path.join(fixture.repositoryRoot, 'replacement.json')
    fs.writeFileSync(replacement, '{"status":"fail"}\n')
    context.mock.method(fs, 'readFileSync', (descriptor, ...args) => {
      const bytes = originalRead.call(fs, descriptor, ...args)
      if (typeof descriptor === 'number')
      {
        if (replace) fs.renameSync(replacement, fixture.file)
        else fs.writeFileSync(fixture.file, '{"status":"fail"}\n')
      }
      return bytes
    })
    try { assert.throws(() => fixture.reader.readBytes(fixture.file), /changed while reading/u) }
    finally { context.mock.restoreAll() }
  }
})

test('canonical authority value verifier imports only pure fixed validators and requires explicit I/O', async () =>
{
  const seen = new Set()
  const visit = async file => {
    if (seen.has(file)) return
    seen.add(file)
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /\b(?:process|require)\s*(?:\.|\()|\bimport\s*\(/u)
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/gu))
    {
      if (['node:crypto', 'node:path'].includes(match[1])) continue
      assert.ok(match[1].startsWith('.'), `unexpected import ${match[1]}`)
      await visit(path.resolve(path.dirname(file), match[1]))
    }
    await import(file)
  }
  await visit(path.join(root, 'tools/test-evidence/canonical-release-authorities-value-contract.mjs'))
  assert.ok(seen.has(path.join(root, 'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs')))
  assert.ok(seen.has(path.join(root, 'tools/release/release-manifest-value-contract.mjs')))
  assert.throws(() => verifyCanonicalReleaseAuthorityValues({ candidatePlan: {}, repositoryRoot: root }), /explicit JSON\/byte readers/u)
})

function pureAuthorityFixture()
{
  const reference = (name) => ({ path: `.tmp/${name}.json`, fileDigest: semanticDigest(name), contentDigest: null })
  return {
    plan: { sourceState: { commit: 'a'.repeat(40) }, candidate: { candidateId: 'candidate-1', releaseId: 'release-1' } },
    planInput: { ref: reference('plan') },
    build: { packageDigest: semanticDigest('package') },
    authorities: {
      authorityDigest: semanticDigest('authority'),
      rollout: { ref: reference('rollout'), value: {
        source: { releaseId: 'old' }, target: { releaseId: 'new', imageDigest: semanticDigest('image') },
        stages: ['candidate-readiness', 'gateway-switch', 'target-health', 'release-evidence'].map(stage => ({ stage, status: 'pass' })),
        recoveries: [],
        artifacts: Object.fromEntries(['faultInjection', 'publicTraffic', 'assetCompatibility', 'resourceBudget'].map(name => [name, { sha256: semanticDigest(name) }])),
        auxiliary: { compatibilityMatrix: { sha256: semanticDigest('matrix') }, releaseManifest: { sha256: semanticDigest('manifest') } }
      } },
      runtimeRole: { admission: { ref: reference('admission') }, deployment: { ref: reference('deployment') }, observation: { ref: reference('observation') } },
      manifest: { ref: reference('manifest'), value: { schemaCompatibility: { minimum: 1, maximum: 2 } } }
    }
  }
}

test('pure release authority helpers have a crypto-only transitive import closure', async () =>
{
  const seen = new Set()
  const visit = async (file) => {
    if (seen.has(file)) return
    seen.add(file)
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /\b(?:process|require)\s*(?:\.|\()/u)
    assert.doesNotMatch(source, /\bimport\s*\(/u)
    const dependencies = [...source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/gu)].map(match => match[1])
    for (const dependency of dependencies)
    {
      if (dependency === 'node:crypto') continue
      assert.ok(dependency.startsWith('.'), `non-pure import: ${dependency}`)
      await visit(path.resolve(path.dirname(file), dependency))
    }
    await import(file)
  }
  await visit(path.join(root, 'tools/test-evidence/release-authority-bundle-contract.mjs'))
  await visit(path.join(root, 'tools/test-evidence/release-authority-facts-contract.mjs'))
  assert.equal(seen.size, 4)
})

test('pure release authority seal preserves the original digest convention', () =>
{
  const value = { z: [{ b: 2, a: 1 }], a: true, contentDigest: 'stale' }
  const expected = { ...stable(value), contentDigest: null }
  expected.contentDigest = semanticDigest(Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'contentDigest')))
  assert.deepEqual(pureSeal(value), expected)
  assert.equal(seal, pureSeal)
  assert.equal(value.contentDigest, 'stale')
})

test('pure release authority bundle and facts preserve original-body golden parity', () =>
{
  const fixture = pureAuthorityFixture()
  const snapshot = structuredClone(fixture)
  const context = { plan: fixture.plan, candidatePlanRef: fixture.planInput.ref }
  const actual = {
    releaseBundle: buildReleaseReadinessAuthorityBundle(fixture),
    blueGreenBundle: buildBlueGreenAuthorityBundle({ ...fixture, candidatePlan: fixture.planInput.ref.path, context }),
    releaseFacts: deriveReleaseReadinessAuthorityFacts(fixture),
    blueGreenFacts: deriveBlueGreenAuthorityFacts(fixture)
  }
  // Captured from original bundle bodies at 0e8ed680 and projector bodies at 311cf194e.
  assert.equal(semanticDigest(actual), 'sha256:52c0b87d0be0abf9a13d578164af0910679485fa3e7f6ac7b3b7df494fa0e0d4')
  assert.deepEqual(fixture, snapshot)
})

test('pure release authority facts follow current inputs and preserve projection fallbacks', () =>
{
  const fixture = pureAuthorityFixture()
  fixture.build.packageDigest = semanticDigest('changed-package')
  fixture.authorities.manifest.value.schemaCompatibility.contentDigest = semanticDigest('explicit-schema')
  const release = deriveReleaseReadinessAuthorityFacts(fixture)
  assert.equal(release.typedFacts.packageDigest, fixture.build.packageDigest)
  assert.equal(release.legacyFacts.packageDigest, fixture.build.packageDigest)
  assert.equal(release.typedFacts.schemaDigest, fixture.authorities.manifest.value.schemaCompatibility.contentDigest)
  fixture.authorities.rollout.value.stages = fixture.authorities.rollout.value.stages.filter(({ stage }) => stage !== 'candidate-readiness')
  const blue = deriveBlueGreenAuthorityFacts(fixture)
  assert.equal(blue.typedFacts.promotionDigest, blue.typedFacts.switchDigest)
  fixture.authorities.rollout.value.artifacts.assetCompatibility.sha256 = semanticDigest('changed-assets')
  assert.notEqual(deriveBlueGreenAuthorityFacts(fixture).typedFacts.containmentDigest, blue.typedFacts.containmentDigest)
})

const commit = resolveSourceCommit(root)
const releaseId = `20260711010101-${commit.slice(0, 12)}`
const digest = (character) => `sha256:${character.repeat(64)}`
const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`
const fileDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`

function write(file, value)
{
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function createReadinessManifest(releaseId, commit)
{
  return createReleaseManifest({
    releaseId,
    commitSha: commit,
    imageRepository: 'ghcr.io/fsusblog/app',
    imageTag: `ghcr.io/fsusblog/app:${releaseId}`,
    imageDigest: digest('1'),
    registryDigestVerified: true,
    createdAtUtc: '2026-07-11T01:01:01.000Z',
    frontendManifestHash: digest('2'),
    wasmArtifactHash: digest('3'),
    schemaMinimumCoordinate: releaseId,
    schemaMaximumCoordinate: releaseId,
    dotnetVersion: '10.0.100',
    nodeVersion: '24.0.0',
    dockerVersion: '28.0.0',
    dockerfileDigest: digest('4'),
    runtimeProfile: {
      id: 'throughput-musl', manifestDigest: digest('5'), profileDigest: digest('6'),
      baseImageFamily: 'musl', targetRuntime: 'linux-musl-x64', singleFile: true,
      readyToRun: false, tieredPgo: true, quickJitForLoops: true, serverGc: true,
      nativeAot: false, threadPoolMode: 'runtime-default', topologyMode: 'smt-visible'
    },
    target: 'final'
  })
}

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
