import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { digestValue, stable } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { resolveSourceCommit } from '../../tools/fact-extractors/identity.mjs'
import { seal } from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import { root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
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
import {
  createPureReleaseAuthorityFixture,
  createReadinessManifest,
  createReleaseRolloutEvidenceFixture,
  createCurrentSchemaCodeContractFixture,
  createRuntimeRoleMinimalV4Fixture,
  createRuntimeRoleStaticV4Fixture,
  digest,
  fileDigest,
  semanticDigest,
  write
} from './support/release-authority-test-fixtures.mjs'

const pureAuthorityFixture = () => createPureReleaseAuthorityFixture(semanticDigest)

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
  const manifest = createReadinessManifest(releaseId, source.sourceCommit)
  const rolloutFixture = createReleaseRolloutEvidenceFixture({
    rolloutId, manifest, target: { slot: 'green', releaseId, imageDigest: digest('1'), runtimeGeneration: 42 }
  })
  const rolloutDirectory = path.join(directory, '.tmp', 'rollout')
  const data = { directory: rolloutDirectory, stateFile: path.join(rolloutDirectory, 'state.json'),
    commandDirectory: path.join(rolloutDirectory, 'commands'), artifactDirectory: path.join(rolloutDirectory, 'artifacts') }
  rolloutFixture.advanceState(data, { includeFinalStage: true })
  const artifacts = rolloutFixture.writeArtifacts(data)
  const auxiliary = rolloutFixture.writeAuxiliary(data)
  write(auxiliary.releaseManifest, manifest)
  const rolloutFile = path.join(rolloutDirectory, 'release-rollout.json')
  const finalized = rolloutFixture.runEvidence(['finalize', '--state', data.stateFile, '--out', rolloutFile,
    ...rolloutFixture.artifactArgs(artifacts), ...rolloutFixture.auxiliaryArgs(auxiliary)])
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout)
  const rollout = rolloutFixture.parseStdout(finalized)
  const minimal = createRuntimeRoleMinimalV4Fixture('canonical-value-test', source)
  const artifact = minimal.artifacts['runtime-role-observation']
  const observation = { schema: 'fsusblog.runtime-role-observation.v3', ownership: { claimEligible: true },
    currentSchemaContract: createCurrentSchemaCodeContractFixture(),
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
  const admission = createRuntimeRoleStaticV4Fixture('canonical-value-test', source, {
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
  assert.equal(actual.runtimeRole.buildReceipt.schema, 'fsusblog.runtime-role-observation-build-receipt.v4')
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
    ['v3 build downgrade', values => { values.artifact.buildReceipt.schema = 'fsusblog.runtime-role-observation-build-receipt.v3' }],
    ['unowned producer', values => { values.artifact.buildReceipt.producer = 'fixture-self-approval' }],
    ['empty source closure', values => {
      values.minimal.sourceClosureDigests = []
      values.artifact.buildReceipt.reproducibleBuild.sourceClosureDigest = digestValue([])
    }],
    ['v1 runtime observation', values => { values.observation.schema = 'fsusblog.runtime-role-observation.v1' }],
    ['v2 runtime observation', values => { values.observation.schema = 'fsusblog.runtime-role-observation.v2' }],
    ['pre model claims native qualification', values => { values.observation.currentSchemaContract.nativeQualification = true }],
    ['pre model missing refusal', values => { delete values.observation.currentSchemaContract.refusalControls['content-seal-as-file-sha'] }],
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
    'fsusblog.runtime-role-observation-build-receipt.v4', 'current producer authority inventory changed; re-audit the v4 boundary')
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
  assert.equal(cases.length, 26)
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
    let mutated = false
    context.mock.method(fs, 'readFileSync', (descriptor, ...args) => {
      const bytes = originalRead.call(fs, descriptor, ...args)
      if (typeof descriptor === 'number' && !mutated)
      {
        mutated = true
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
      if (['node:crypto', 'node:path', 'node:util'].includes(match[1])) continue
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

// Source refusal controls; synthetic metadata is deliberately unable to qualify.
test('disconnected native collector refuses legacy windows and claimed current schema facts', () =>
{
  for (const claimedCurrentSchema of [undefined, {
    status: 'verified-current', verified: true, qualificationEligible: true,
    nativeQualification: true, receipt: { contentDigest: digest('1') },
    admission: { value: { status: 'pass' } }
  }])
  {
    const fixture = pureAuthorityFixture()
    fixture.authorities.currentSchema = claimedCurrentSchema
    assert.throws(() => deriveReleaseReadinessAuthorityFacts(fixture), /admitted native collector is not connected/u)
    assert.throws(() => deriveBlueGreenAuthorityFacts(fixture), /admitted native collector is not connected/u)
  }
})
