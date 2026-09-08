import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { root } from '../../tools/fact-extractors/registry.mjs'
import { resolveDotnetProjectSourceClosure } from '../../tools/fact-extractors/identity.mjs'

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
