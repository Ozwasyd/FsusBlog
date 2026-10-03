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
import { validateCurrentSchemaBinding } from '../../tools/release/release-manifest-value-contract.mjs'
import { createHistoricalWindowReleaseAuthorityFixture } from './support/pure-release-authority-fixture.mjs'
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

test('pure release fixture carries current-only references without issuing native evidence', () =>
{
  const value = pureAuthorityFixture().authorities.manifest.value
  assert.equal(value.schema, 'fsusblog.release-manifest.v3')
  assert.equal(Object.hasOwn(value, 'schemaCompatibility'), false)
  const errors = []
  validateCurrentSchemaBinding(value.currentSchema, errors)
  assert.deepEqual(errors, [])
  const legacyErrors = []
  validateCurrentSchemaBinding({ minimum: 1, maximum: 2 }, legacyErrors)
  assert.ok(legacyErrors.length > 0)
  for (const mutate of [
    binding => { delete binding.receipt },
    binding => { binding.receipt.reference = 'receipts/latest/current.json' },
    binding => { binding.receipt.sha256 = `sha256:${binding.receipt.sha256}` },
    binding => { binding.receipt.contentDigest = '5'.repeat(64) }
  ])
  {
    const changed = structuredClone(value.currentSchema)
    mutate(changed)
    const refused = []
    validateCurrentSchemaBinding(changed, refused)
    assert.ok(refused.length > 0)
  }
})

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
    'src/shared/Contracts/Validation/release-id-contract.json'
  ])
  {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
    fs.copyFileSync(path.join(root, file), path.join(directory, file))
  }
  const manifest = createReadinessManifest(releaseId, source.sourceCommit)
  // Metadata-only values: the placeholder content seal is not a codec-issued
  // receipt and cannot enter the missing admitted native collector.
  const currentReceipt = { format: 'fsusblog.current-schema-receipt.v1', status: 'verified-current',
    target: structuredClone(manifest.currentSchema.target), database: structuredClone(manifest.currentSchema.database),
    actualSchemaDigest: manifest.currentSchema.actualSchemaDigest, contentDigest: '5'.repeat(64) }
  const currentReceiptFile = path.join(directory, '.tmp', 'current-schema-contract-values.json')
  write(currentReceiptFile, currentReceipt)
  const currentSchemaReceiptRef = { path: path.relative(directory, currentReceiptFile),
    fileDigest: fileDigest(currentReceiptFile), contentDigest: `sha256:${currentReceipt.contentDigest}`,
    schema: 'fsusblog.current-schema-receipt.v1' }
  manifest.currentSchema.receipt = { reference: currentSchemaReceiptRef.path,
    sha256: currentSchemaReceiptRef.fileDigest.slice('sha256:'.length) }
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
    runtimeRoleAdmission: path.relative(directory, admissionFile), currentSchemaReceiptRef,
    repositoryRoot: directory, now: Date.now() }
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
  return { directory, options, snapshots, readers, rolloutFile, rollout, admissionFile, admission, artifact,
    currentReceiptFile, currentReceipt }
}

test('canonical authority synthetic values bind references without qualifying a native runtime', context =>
{
  const fixture = canonicalAuthorityFixture(context)
  const actual = verifyCanonicalReleaseAuthorityValues({ ...fixture.options, ...fixture.readers(fixture.snapshots) })
  assert.equal(actual.authorityDigest, semanticDigest({
    rollout: actual.rollout.ref.fileDigest, runtimeRole: actual.runtimeRole.observation.ref.fileDigest,
    deployment: actual.runtimeRole.deployment.ref.fileDigest, manifest: actual.manifest.ref.fileDigest,
    currentSchemaReceipt: actual.currentSchema.receiptRef.fileDigest,
    currentSchemaReceiptContent: actual.currentSchema.receiptRef.contentDigest,
    currentSchemaAdmission: actual.currentSchema.admission.ref.fileDigest
  }))
  assert.deepEqual(actual.currentSchema.receiptRef, fixture.options.currentSchemaReceiptRef)
  assert.deepEqual(actual.currentSchema.receipt, fixture.currentReceipt)
  assert.equal(actual.currentSchema.admission.ref.contentDigest, null)
  assert.equal(actual.runtimeRole.buildReceipt.schema, 'fsusblog.runtime-role-observation-build-receipt.v4')
})

// Requires the separately frozen original post-v2 I/O wrapper; no synthetic
// metadata authority can substitute for its still-unconnected native collector.
test('canonical authority I/O refuses metadata when the admitted native collector is missing', context =>
{
  const fixture = canonicalAuthorityFixture(context)
  assert.throws(() => verifyCanonicalReleaseAuthorities(fixture.options), {
    message: '[canonical-release-authorities] current-schema post-runtime admitted native collector is not connected'
  })
})

test('current-schema value bindings reject old formats, digest aliases and admission drift', context =>
{
  const fixture = canonicalAuthorityFixture(context)
  for (const mutate of [
    value => { delete value.ref.schema },
    value => { value.ref.schema = 'fsusblog.current-schema-receipt.v2' },
    value => { value.ref.fileDigest = value.ref.fileDigest.slice('sha256:'.length) },
    value => { value.ref.contentDigest = value.ref.contentDigest.slice('sha256:'.length) },
    value => { value.ref.fileDigest = value.ref.contentDigest },
    value => { value.ref.contentDigest = value.ref.fileDigest },
    value => { value.receipt.format = 'fsusblog.current-schema-receipt.v2' },
    value => { value.receipt.target.contentDigest = '9'.repeat(64) },
    value => { value.receipt.database.databaseId = 'other-database' },
    value => { value.admission.candidateSourceRevision = 'f'.repeat(40) },
    value => { value.admission.artifactSha256 = value.receipt.contentDigest },
    value => { value.admission.contentDigest = '7'.repeat(64) }
  ])
  {
    const bytes = new Map(fixture.snapshots)
    const readers = fixture.readers(bytes)
    const admissionFile = fixture.rollout.auxiliary.currentSchemaAdmission.path
    const values = { ref: structuredClone(fixture.options.currentSchemaReceiptRef),
      receipt: structuredClone(fixture.currentReceipt), admission: readers.readJson(admissionFile).value }
    mutate(values)
    const put = (file, value) => bytes.set(path.resolve(fixture.directory, file),
      Buffer.from(`${JSON.stringify(value, null, 2)}\n`))
    put(fixture.currentReceiptFile, values.receipt)
    put(admissionFile, values.admission)
    assert.throws(() => verifyCanonicalReleaseAuthorityValues({
      ...fixture.options, currentSchemaReceiptRef: values.ref, ...readers
    }), /canonical-release-authorities/u)
  }
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

test('pure current-only release authority bundle and facts bind the complete v2 material contract', () =>
{
  const fixture = pureAuthorityFixture()
  const snapshot = structuredClone(fixture)
  const context = { plan: fixture.plan, candidatePlanRef: fixture.planInput.ref }
  const releaseFacts = deriveReleaseReadinessAuthorityFacts(fixture)
  const blueGreenFacts = deriveBlueGreenAuthorityFacts(fixture)
  const actual = {
    releaseBundle: buildReleaseReadinessAuthorityBundle({ ...fixture, rawFacts: releaseFacts.rawFacts,
      output: '.tmp/contract-fixture-release-bundle.json' }),
    blueGreenBundle: buildBlueGreenAuthorityBundle({ ...fixture, candidatePlan: fixture.planInput.ref.path, context,
      rawFacts: blueGreenFacts.rawFacts, output: '.tmp/contract-fixture-blue-green-bundle.json' }),
    releaseFacts,
    blueGreenFacts
  }
  const current = fixture.authorities.currentSchema
  const schemaView = { target: current.receipt.target, actualSchemaDigest: current.receipt.actualSchemaDigest }
  assert.deepEqual(schemaView, {
    target: { modelVersion: 'contract-fixture-model.v1', extractorVersion: 'contract-fixture-extractor.v1',
      generatorVersion: 'contract-fixture-generator.v1', sourceDigest: '2'.repeat(64), contentDigest: '3'.repeat(64) },
    actualSchemaDigest: '4'.repeat(64)
  })
  assert.deepEqual(current.receiptRef, { path: fixture.authorities.manifest.value.currentSchema.receipt.reference,
    fileDigest: `sha256:${fixture.authorities.manifest.value.currentSchema.receipt.sha256}`,
    contentDigest: `sha256:${current.receipt.contentDigest}`, schema: 'fsusblog.current-schema-receipt.v1' })
  assert.equal(current.admission.ref.contentDigest, null)
  assert.deepEqual(releaseFacts.rawFacts, {
    artifact: { rollout: fixture.authorities.rollout.ref, runtimeRole: fixture.authorities.runtimeRole.observation.ref,
      manifest: fixture.authorities.manifest.ref, currentSchema: current.receiptRef },
    image: fixture.authorities.rollout.value.target.imageDigest,
    package: { receipt: fixture.build.receipt.ref, artifacts: fixture.build.receipt.value.artifacts },
    config: fixture.authorities.runtimeRole.deployment.value,
    schema: schemaView,
    runtimeRole: 'monolithic', candidateId: fixture.plan.candidate.candidateId, releaseId: fixture.plan.candidate.releaseId,
    readiness: { rollout: fixture.authorities.rollout.ref, currentSchemaAdmission: current.admission }
  })
  assert.equal(releaseFacts.legacyFacts.schemaDigest, semanticDigest(schemaView))
  assert.equal(releaseFacts.typedFacts.schemaDigest, semanticDigest(schemaView))
  const rollout = fixture.authorities.rollout
  const stage = name => rollout.value.stages.find(value => value.stage === name)
  assert.deepEqual(blueGreenFacts.rawFacts, {
    activeBefore: rollout.value.source, standbyBefore: rollout.value.target,
    activeAfter: rollout.value.target, standbyAfter: rollout.value.source,
    promotion: stage('candidate-readiness'), switch: stage('gateway-switch'), health: stage('target-health'),
    rollback: rollout.value.recoveries, trafficOwnership: rollout.value.artifacts.publicTraffic,
    containment: { artifact: rollout.value.artifacts.assetCompatibility.sha256,
      volume: rollout.value.artifacts.resourceBudget.sha256,
      schema: rollout.value.auxiliary.compatibilityMatrix.sha256,
      process: fixture.authorities.runtimeRole.observation.ref.fileDigest,
      currentSchema: current.receiptRef, nativeAdmission: current.admission },
    terminalReceipt: rollout.ref
  })
  for (const [field, value] of Object.entries(releaseFacts.rawFacts))
    assert.deepEqual(releaseFacts.typedFacts[field === 'runtimeRole' || field.endsWith('Id') ? field : `${field}Digest`],
      field === 'runtimeRole' || field.endsWith('Id') ? value : semanticDigest(value))
  for (const [field, value] of Object.entries(blueGreenFacts.rawFacts))
    assert.equal(blueGreenFacts.typedFacts[`${field}Digest`], semanticDigest(value))
  assert.deepEqual(blueGreenFacts.rawFacts.containment.currentSchema, current.receiptRef)
  assert.deepEqual(blueGreenFacts.rawFacts.containment.nativeAdmission, current.admission)
  for (const [bundle, schema, rawFacts] of [
    [actual.releaseBundle, 'fsusblog.release-identity-readiness-authority-bundle.v2', releaseFacts.rawFacts],
    [actual.blueGreenBundle, 'fsusblog.blue-green-containment-authority-bundle.v2', blueGreenFacts.rawFacts]
  ])
  {
    assert.equal(bundle.schema, schema)
    assert.equal(bundle.producerId, fixture.producer.producerId)
    assert.equal(bundle.toolVersion, 'production-correctness-scheduler@2')
    assert.deepEqual(bundle.sourceState, fixture.sourceState)
    assert.deepEqual(bundle.rawFacts, rawFacts)
    assert.deepEqual(bundle.currentSchemaReceiptRef, current.receiptRef)
    assert.equal(bundle.runtimeRoleAdmissionRef.schema, 'fsusblog.behavior-doc-static-admission-receipt.v2')
    assert.equal(bundle.runtimeRoleAdmissionRef.role, 'runtime-role-admission')
    assert.equal(bundle.rolloutEvidenceRef.schema, 'fsusblog.release-rollout-evidence.v1')
    assert.equal(bundle.rolloutEvidenceRef.role, 'release-rollout')
    assert.deepEqual(bundle.candidatePlanRef, fixture.planInput.ref)
    assert.equal(bundle.authorityDigest, fixture.authorities.authorityDigest)
    assert.deepEqual(pureSeal(bundle), bundle)
  }
  assert.deepEqual(fixture, snapshot)
})

test('pure release authority facts follow current inputs and preserve projection fallbacks', () =>
{
  const fixture = pureAuthorityFixture()
  fixture.build.packageDigest = semanticDigest('changed-package')
  fixture.build.receipt.value.artifacts[0].fileDigest = semanticDigest('changed-package-artifact')
  const current = fixture.authorities.currentSchema
  current.receipt.target.contentDigest = 'f'.repeat(64)
  fixture.authorities.manifest.value.currentSchema.target.contentDigest = current.receipt.target.contentDigest
  const expectedSchemaView = { target: current.receipt.target, actualSchemaDigest: current.receipt.actualSchemaDigest }
  const release = deriveReleaseReadinessAuthorityFacts(fixture)
  assert.equal(release.typedFacts.packageDigest, semanticDigest({
    receipt: fixture.build.receipt.ref, artifacts: fixture.build.receipt.value.artifacts
  }))
  assert.equal(release.legacyFacts.packageDigest, fixture.build.packageDigest)
  assert.deepEqual(release.rawFacts.schema, expectedSchemaView)
  assert.equal(release.typedFacts.schemaDigest, semanticDigest(expectedSchemaView))
  assert.equal(release.legacyFacts.schemaDigest, semanticDigest(expectedSchemaView))
  current.receipt.actualSchemaDigest = 'e'.repeat(64)
  fixture.authorities.manifest.value.currentSchema.actualSchemaDigest = current.receipt.actualSchemaDigest
  const changedSchema = deriveReleaseReadinessAuthorityFacts(fixture)
  assert.notEqual(changedSchema.typedFacts.schemaDigest, release.typedFacts.schemaDigest)
  assert.equal(changedSchema.legacyFacts.schemaDigest, changedSchema.typedFacts.schemaDigest)
  fixture.authorities.rollout.value.stages = fixture.authorities.rollout.value.stages.filter(({ stage }) => stage !== 'candidate-readiness')
  const blue = deriveBlueGreenAuthorityFacts(fixture)
  assert.equal(blue.typedFacts.promotionDigest, blue.typedFacts.switchDigest)
  fixture.authorities.rollout.value.artifacts.assetCompatibility.sha256 = semanticDigest('changed-assets')
  assert.notEqual(deriveBlueGreenAuthorityFacts(fixture).typedFacts.containmentDigest, blue.typedFacts.containmentDigest)
})

test('pure current-only projection cannot fall back to a historical window when native material is absent', () =>
{
  const fixture = pureAuthorityFixture()
  delete fixture.authorities.currentSchema
  fixture.authorities.manifest.value.schemaCompatibility = { minimum: 1, maximum: 2,
    contentDigest: semanticDigest('historical-window') }
  for (const project of [deriveReleaseReadinessAuthorityFacts, deriveBlueGreenAuthorityFacts])
    assert.throws(() => project(fixture), {
      message: '[canonical-release-authorities] independently verified native material is unavailable'
    })
})

test('current v2 consumers refuse the unchanged historical window fixture', () =>
{
  const historical = createHistoricalWindowReleaseAuthorityFixture(semanticDigest)
  const snapshot = structuredClone(historical)
  // Historical golden custody: original test/body is fixed at 7beb094e.
  // assert.equal(semanticDigest(actual), 'sha256:52c0b87d0be0abf9a13d578164af0910679485fa3e7f6ac7b3b7df494fa0e0d4')
  // No historical projector is executed here and no replacement golden is invented.
  assert.deepEqual(historical.authorities.manifest.value, { schemaCompatibility: { minimum: 1, maximum: 2 } })
  for (const project of [deriveReleaseReadinessAuthorityFacts, deriveBlueGreenAuthorityFacts])
    assert.throws(() => project(historical), {
      message: '[canonical-release-authorities] independently verified native material is unavailable'
    })
  const current = pureAuthorityFixture()
  const options = { ...historical, plan: current.plan, producer: current.producer, sourceState: current.sourceState,
    rawFacts: {}, output: '.tmp/contract-fixture-legacy-bundle.json', candidatePlan: historical.planInput.ref.path,
    context: { plan: current.plan, candidatePlanRef: historical.planInput.ref } }
  for (const build of [buildReleaseReadinessAuthorityBundle, buildBlueGreenAuthorityBundle])
    assert.throws(() => build(options), {
      message: '[canonical-release-authorities] current-schema native verification owner is unavailable'
    })
  assert.deepEqual(historical, snapshot)
})

test('current schema facts bind every target field and the observed physical schema independently', () =>
{
  const original = pureAuthorityFixture()
  const expected = deriveReleaseReadinessAuthorityFacts(original)
  for (const field of ['modelVersion', 'extractorVersion', 'generatorVersion', 'sourceDigest', 'contentDigest', 'actualSchemaDigest'])
  {
    const changed = structuredClone(original)
    const current = changed.authorities.currentSchema
    if (field === 'actualSchemaDigest')
    {
      current.receipt.actualSchemaDigest = 'e'.repeat(64)
      changed.authorities.manifest.value.currentSchema.actualSchemaDigest = current.receipt.actualSchemaDigest
    }
    else
    {
      current.receipt.target[field] = field.endsWith('Digest') ? 'f'.repeat(64) : `changed-${field}`
      changed.authorities.manifest.value.currentSchema.target[field] = current.receipt.target[field]
    }
    const actual = deriveReleaseReadinessAuthorityFacts(changed)
    assert.deepEqual(actual.rawFacts.schema, { target: current.receipt.target,
      actualSchemaDigest: current.receipt.actualSchemaDigest })
    assert.notEqual(actual.typedFacts.schemaDigest, expected.typedFacts.schemaDigest, field)
    assert.equal(actual.legacyFacts.schemaDigest, actual.typedFacts.schemaDigest, field)
    for (const key of Object.keys(expected.typedFacts).filter(key => key !== 'schemaDigest'))
      assert.deepEqual(actual.typedFacts[key], expected.typedFacts[key], `${field}:${key}`)
  }
})

const commit = resolveSourceCommit(root)
const releaseId = `20260711010101-${commit.slice(0, 12)}`
