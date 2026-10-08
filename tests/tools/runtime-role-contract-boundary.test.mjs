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
  assert.equal(observation.$id, 'fsusblog.runtime-role-observation.v3')
  assert.equal(deployment.$id, 'fsusblog.runtime-role-deployment-observation.v1')
  assert.equal(observation.additionalProperties, false)
  assert.equal(deployment.additionalProperties, false)
  assert.notEqual(observation, deployment)
  assert.ok(observation.properties.deploymentAuthority)
  assert.ok(deployment.properties.ownership)
  assert.match(validateJsonSchema({}, observation).join('\n'), /must have required property/u)
  assert.match(validateJsonSchema({}, deployment).join('\n'), /must have required property/u)
  assert.match(validateJsonSchema({ schema: 'fsusblog.runtime-role-observation.v3', extra: true }, observation).join('\n'), /must NOT have additional properties/u)
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


test('compiled current-schema observation refuses retired windows, early native claims and changed bindings', async () => {
  const { validateRuntimeRoleCurrentSchemaContract } = await import('../../tools/contracts/lib/runtime-role-current-schema-contract.mjs')
  const { currentSchemaContractFixture, sealRuntimeRoleFixture } = await import('./support/runtime-role-current-schema-fixture.mjs')
  const make = () => sealRuntimeRoleFixture({ schema: 'fsusblog.runtime-role-observation.v3', modes: [],
    staticRoleCapabilities: {}, unsupportedCombinations: [], ownership: {}, deploymentAuthority: {},
    currentSchemaContract: currentSchemaContractFixture() })
  const original = make()
  assert.equal(validateRuntimeRoleCurrentSchemaContract(original, { sourceCommit: 'a'.repeat(40) }), true)
  const mutations = [
    ['old observation', (value) => { value.schema = 'fsusblog.runtime-role-observation.v2' }],
    ['retired window', (value) => { value.schemaOverlap = { sourceReadiness: 'ready' } }],
    ['missing contract', (value) => { delete value.currentSchemaContract }],
    ['early native stage', (value) => { value.currentSchemaContract.stage = 'native-current' }],
    ['database self report', (value) => { value.currentSchemaContract.actualDatabaseObserved = true }],
    ['native eligibility', (value) => { value.currentSchemaContract.nativeClaimEligible = true }],
    ['second receipt', (value) => { value.currentSchemaContract.receiptFormat = 'fsusblog.other-receipt.v1' }],
    ['retired field', (value) => { value.currentSchemaContract.sourceReadiness = 'ready' }],
    ['missing recipe', (value) => { value.currentSchemaContract.requiredRecipeCount = 0 }],
    ['zero source', (value) => { value.currentSchemaContract.producer.sourceCommit = '0'.repeat(40) }],
    ['different source', (value) => { value.currentSchemaContract.producer.sourceCommit = 'b'.repeat(40) }],
    ['artifact/content confusion', (value) => { value.currentSchemaContract.target.contentDigest = 'sha256:' + 'c'.repeat(64) }],
    ['owner substitution', (value) => { value.currentSchemaContract.nativeVerifier = 'fixture-verifier' }]
  ]
  for (const [label, mutate] of mutations) {
    const value = make()
    mutate(value)
    // A resealed object still cannot acquire a stage or ownership capability.
    const resealed = { ...value, observationDigest: sealRuntimeRoleFixture(value).observationDigest }
    assert.equal(validateRuntimeRoleCurrentSchemaContract(resealed, { sourceCommit: 'a'.repeat(40) }), false, label)
  }
  const changed = make()
  changed.currentSchemaContract.target.contentDigest = 'd'.repeat(64)
  assert.equal(validateRuntimeRoleCurrentSchemaContract(changed), false, 'unsealed target drift')
})
