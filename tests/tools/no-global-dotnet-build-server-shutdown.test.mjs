import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const qualificationSources = [
  'tools/run-test-matrix.mjs',
  'tools/test/run-backend-production-shards.mjs'
]

test('Production qualification never invokes the global dotnet build-server shutdown command', () => {
  const forbidden = /spawnSync\(\s*['"]dotnet['"]\s*,\s*\[\s*['"]build-server['"]\s*,\s*['"]shutdown['"]\s*\]/u
  for (const file of qualificationSources) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), forbidden, file)
  }
})

test('qualification uses identity-bound inventory and leaves manual maintenance outside receipt generation', () => {
  const runner = fs.readFileSync('tools/run-test-matrix.mjs', 'utf8')
  assert.match(runner, /dotnetBuildServerInventory/u)
  assert.match(runner, /productionBuildRunIsActive/u)
  assert.doesNotMatch(runner, /spawnSync\('dotnet'/u)
})
