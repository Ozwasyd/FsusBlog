import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { root } from '../../tools/fact-extractors/registry.mjs'
import { resolveDotnetProjectSourceClosure } from '../../tools/fact-extractors/identity.mjs'
import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'

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
  assert.equal(observation.$id, 'fsusblog.runtime-role-observation.v2')
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
test('required schema observation refuses before deployment oracles and output publication', () =>
{
    const program = fs.readFileSync(path.join(root, 'tools/contracts/FsusBlog.RuntimeRoleObservation/Program.cs'), 'utf8')
    assert.match(program, /private static SchemaOverlapObservation ObserveSchemaOverlap\(\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*throw new InvalidOperationException\("runtime_role_current_schema_observation_unavailable"\);\s*\}/u)
    const refusal = program.indexOf('SchemaOverlapObservation schemaOverlap = ObserveSchemaOverlap();')
    const deployment = program.indexOf('Observe(ReadDeploymentProbe(deploymentObservationPath), schemaOverlap)')
    const publication = program.indexOf('File.WriteAllText(outputPath,')
    assert.ok(refusal >= 0 && deployment > refusal && publication > deployment)
})

test('compiled observer no longer constructs retired release windows or synthetic successful database history', () =>
{
    const program = fs.readFileSync(path.join(root, 'tools/contracts/FsusBlog.RuntimeRoleObservation/Program.cs'), 'utf8')
    assert.doesNotMatch(program, /\b(?:OnlineSchemaMigrationMetadata|OnlineSchemaMigrationCatalog|SchemaCompatibilityCoordinate|OnlineSchemaCompatibilityWindow|OnlineSchemaCompatibilityEvaluator|OnlineSchemaContractGate|OnlineSchemaDatabaseSnapshot|OnlineSchemaMigrationHistorySnapshot|CreateCatalogReleaseId|WriteReleaseManifest|LoadReleaseManifest)\b/u)
    assert.doesNotMatch(program, /FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE|fsusblog\.release-manifest\.v2|Succeeded:\s*true|sourceReport\.Ready|targetReport\.Ready/u)
})

test('required observer keeps the original receipt contract rather than an empty or fabricated current success', () =>
{
    const program = fs.readFileSync(path.join(root, 'tools/contracts/FsusBlog.RuntimeRoleObservation/Program.cs'), 'utf8')
    assert.match(program, /Schema = "fsusblog\.runtime-role-observation\.v2"/u)
    assert.match(program, /SchemaOverlap = schemaOverlap/u)
    assert.match(program, /private static RuntimeRoleObservation Observe\(\s*RuntimeRoleDeploymentProbe deploymentProbe,\s*SchemaOverlapObservation schemaOverlap\)/u)
    assert.doesNotMatch(program, /new SchemaOverlapObservation|observed-in-current-schema-manifest-probe|unexpectedly-accepted.*current_schema/u)
    // Refusal is not a successful observation, an optional observer, or native current-schema admission.
})
