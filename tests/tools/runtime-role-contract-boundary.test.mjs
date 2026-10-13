import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { root } from '../../tools/fact-extractors/registry.mjs'
import { resolveDotnetProjectSourceClosure } from '../../tools/fact-extractors/identity.mjs'
import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import { validateCurrentSchemaCodeContractObservation, validateMinimalContractBuildReceipt } from '../../tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs'
import { createCurrentSchemaCodeContractFixture, createRuntimeRoleMinimalV3Fixture, createRuntimeRoleMinimalV4Fixture } from './support/runtime-role-minimal-v3-fixture.mjs'

const runtimeProject = 'tools/contracts/FsusBlog.RuntimeRoleObservation/FsusBlog.RuntimeRoleObservation.csproj'

test('runtime-role source closure follows every reachable SDK project and lock file', () => {
  const closure = resolveDotnetProjectSourceClosure(root, [runtimeProject])
  const expected = [
    'Directory.Build.props',
    'Directory.Packages.props',
    'src/backend/FsusBlog.Server.csproj',
    'src/backend/packages.lock.json',
    'src/backend/Infrastructure/Operations/ReleaseId.cs',
    'src/backend/Infrastructure/Operations/ReleaseIdContract.Generated.cs',
    'src/core/FsusBlog.Core.csproj',
    'src/core/packages.lock.json',
    'src/migration/FsusBlog.Migration.csproj',
    'src/migration/packages.lock.json',
    'src/shared/FsusBlog.Shared.csproj',
    'src/shared/packages.lock.json',
    'tools/architecture/FsusBlog.DiLifetimeAnalyzer/FsusBlog.DiLifetimeAnalyzer.csproj',
    'tools/contracts/FsusBlog.RuntimeRoleObservation/packages.lock.json'
  ]
  for (const relative of expected) assert.ok(closure.includes(relative), `missing ${relative}`)
  assert.ok(closure.filter((relative) => relative.endsWith('.cs')).length > 700)
  assert.ok(closure.every((relative) => !/(?:^|\/)bin(?:\/|$)|(?:^|\/)obj(?:\/|$)/u.test(relative)))
})

test('runtime-role schemas are independent strict contracts', () => {
  const observation = JSON.parse(fs.readFileSync(
    path.join(root, 'config/schemas/runtime-role-observation.schema.json'),
    'utf8'
  ))
  const deployment = JSON.parse(fs.readFileSync(
    path.join(root, 'config/schemas/runtime-role-deployment-observation.schema.json'),
    'utf8'
  ))
  assert.equal(observation.$id, 'fsusblog.runtime-role-observation.v3')
  assert.equal(deployment.$id, 'fsusblog.runtime-role-deployment-observation.v1')
  assert.equal(observation.additionalProperties, false)
  assert.equal(deployment.additionalProperties, false)
  assert.notEqual(observation, deployment)
  assert.ok(observation.properties.deploymentAuthority)
  assert.ok(deployment.properties.ownership)
  assert.match(validateJsonSchema({}, observation).join('\n'), /must have required property/u)
  assert.match(validateJsonSchema({}, deployment).join('\n'), /must have required property/u)
  assert.match(validateJsonSchema({ schema: 'fsusblog.runtime-role-observation.v2', extra: true }, observation).join('\n'), /must NOT have additional properties/u)
})

test('runtime-role CLI validates both output paths against the repository root', () => {
  const program = fs.readFileSync(
    path.join(root, 'tools/contracts/FsusBlog.RuntimeRoleObservation/Program.cs'),
    'utf8'
  )
  assert.match(program, /ResolveContainedWritableFile\(repositoryRoot, output, "output"\)/u)
  assert.match(program, /ResolveContainedRegularFile\([\s\S]*deploymentObservation[\s\S]*allowAbsolute: true/u)
  assert.match(program, /runtime_role_output_path_not_canonical/u)
  assert.match(program, /runtime_role_output_path_escape/u)
  assert.match(program, /runtime_role_output_path_symlink/u)
})

// SOURCE controls only: these read the real observer but do not execute its compiled CLI or any database oracle.
test('required production code-model probes complete before deployment oracles and output publication', () =>
{
    const program = fs.readFileSync(path.join(root, 'tools/contracts/FsusBlog.RuntimeRoleObservation/Program.cs'), 'utf8')
    assert.match(program, /var probe = ProbeCurrentSchemaProductionContract\(\);/u)
    const refusal = program.indexOf('CurrentSchemaContractObservation currentSchemaContract = ObserveCurrentSchemaContract();')
    const deployment = program.indexOf('Observe(ReadDeploymentProbe(deploymentObservationPath), currentSchemaContract)')
    const publication = program.indexOf('File.WriteAllText(outputPath,')
    assert.ok(refusal >= 0 && deployment > refusal && publication > deployment)
})

test('compiled observer no longer constructs retired release windows or synthetic successful database history', () =>
{
    const program = fs.readFileSync(path.join(root, 'tools/contracts/FsusBlog.RuntimeRoleObservation/Program.cs'), 'utf8')
    assert.doesNotMatch(program, /\b(?:OnlineSchemaMigrationMetadata|OnlineSchemaMigrationCatalog|SchemaCompatibilityCoordinate|OnlineSchemaCompatibilityWindow|OnlineSchemaCompatibilityEvaluator|OnlineSchemaContractGate|OnlineSchemaDatabaseSnapshot|OnlineSchemaMigrationHistorySnapshot|CreateCatalogReleaseId|WriteReleaseManifest|LoadReleaseManifest)\b/u)
    assert.doesNotMatch(program, /FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE|fsusblog\.release-manifest\.v2|Succeeded:\s*true|sourceReport\.Ready|targetReport\.Ready/u)
})

test('required observer invokes production value validators without native issuer or service inputs', () =>
{
    const program = fs.readFileSync(path.join(root, 'tools/contracts/FsusBlog.RuntimeRoleObservation/Program.cs'), 'utf8')
    assert.match(program, /Schema = "fsusblog\.runtime-role-observation\.v3"/u)
    assert.match(program, /CurrentSchemaContract = currentSchemaContract/u)
    assert.match(program, /CurrentSchemaReceiptCodec\.Deserialize\(bytes\)/u)
    assert.match(program, /CurrentSchemaReceiptAdmission\.Validate\(bytes, artifactSha256, actual\)/u)
    assert.match(program, /"pre-runtime", "compiled-production-code-model", CurrentSchemaReceiptCodec\.Format/u)
    assert.doesNotMatch(program, /OfflineMigrationCurrentSchemaIssuer|IssueArtifactAsync|VerifyAsync\(|NpgsqlConnection|DbConnection|SchemaOverlapObservation/u)
})

test('compiled contract exact fixture positive never establishes native qualification', () =>
{
    const value = createCurrentSchemaCodeContractFixture()
    assert.equal(validateCurrentSchemaCodeContractObservation(value), value)
    assert.equal(value.fixtureOnly, true)
    assert.equal(value.nativeQualification, false)
    assert.notEqual(value.fixtureArtifactSha256, value.fixtureContentDigest)
    assert.equal(Object.keys(value.refusalControls).length, 20)
})

test('compiled contract refuses ambiguous shape, incomplete controls, and native claims', () =>
{
    for (const mutate of [
        value => { value.schema = 'fsusblog.online-schema-overlap-observation.v1' },
        value => { value.evidenceStage = 'post-runtime' },
        value => { value.nativeQualification = true },
        value => { value.fixtureOnly = false },
        value => { value.contractValidated = false },
        value => { value.fixtureArtifactSha256 = value.fixtureContentDigest },
        value => { value.unknown = true },
        value => { delete value.refusalControls['whole-file-drift'] },
        value => { value.refusalControls['missing-plan'] = 'unexpectedly-accepted' },
        value => { value.observationDigest = 'f'.repeat(64) }
    ])
    {
        const value = createCurrentSchemaCodeContractFixture()
        mutate(value)
        assert.throws(() => validateCurrentSchemaCodeContractObservation(value))
    }
})

test('current minimal build binds v4 model stage while old runtime build versions refuse', () =>
{
    const source = { sourceCommit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
    assert.ok(validateMinimalContractBuildReceipt(createRuntimeRoleMinimalV4Fixture('contract-control', source)))
    assert.throws(() => validateMinimalContractBuildReceipt(createRuntimeRoleMinimalV3Fixture('contract-control', source)))
})
