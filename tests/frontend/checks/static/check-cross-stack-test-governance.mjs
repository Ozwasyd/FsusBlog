#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assert,
  assertPathExists,
  flattenMatrixRoutes,
  loadMatrix,
  root
} from '../support/crossStackMatrix.mjs'

const matrix = loadMatrix()
const pkg = JSON.parse(readFileSync(resolve(root, 'src/frontend/package.json'), 'utf8'))
const testSh = readFileSync(resolve(root, 'tools/test.sh'), 'utf8')
const legacyTestSh = readFileSync(resolve(root, 'tools/test/legacy-test.sh'), 'utf8')
const testEntrypoints = `${testSh}\n${legacyTestSh}`
const testMatrix = readFileSync(resolve(root, 'tests/matrix.yml'), 'utf8')
const requirementIds = new Set((matrix.requirements || []).map(requirement => requirement.id))

assert(matrix.version === 'fsusblog-cross-stack-contract-matrix-v1', 'cross-stack matrix version drifted')
assert((matrix.profiles || []).length >= 11, 'cross-stack matrix has too few profiles')
assert((matrix.requirements || []).length >= 20, 'cross-stack matrix has too few requirements')
assert((matrix.fixtureFamilies || []).length >= 14, 'fixture families are incomplete')
assert((matrix.publicArtifactRoutes || []).length >= 9, 'public artifact routes are incomplete')
assert(flattenMatrixRoutes(matrix).length >= 70, 'binary route matrix is incomplete')

for (const profile of matrix.profiles) {
  assert(pkg.scripts?.[profile.command.replace('npm run ', '')], `missing package script ${profile.command}`)
  assert(profile.risk, `${profile.id} lacks risk`)
  for (const requirement of profile.requirements || []) {
    assert(requirementIds.has(requirement), `${profile.id} references unknown requirement ${requirement}`)
  }
  for (const path of profile.evidencePaths || []) {
    assertPathExists(path)
  }
}

for (const requirement of matrix.requirements) {
  assert(/^CROSS-[A-Z0-9-]+$/.test(requirement.id), `invalid requirement id ${requirement.id}`)
  assert(requirement.risk && requirement.coverage, `${requirement.id} lacks risk/coverage`)
}

for (const path of Object.values(matrix.schema)) {
  assertPathExists(path)
}

for (const token of [
  'npm run check:contract:binary-matrix',
  'npm run check:contract:api-parity',
  'npm run check:contract:frame-schema',
  'npm run check:contract:negative-matrix',
  'npm run check:coherence:runtime-matrix',
  'npm run check:cross-stack-test-governance'
]) {
  assert(testEntrypoints.includes(token), `fast gate does not run ${token}`)
}

assert(testEntrypoints.includes('cross-stack-contract)'), 'tools/test.sh lacks cross-stack-contract tier')
assert(testMatrix.includes('id: cross-stack-contract'), 'tests/matrix.yml lacks cross-stack-contract tier')
assert(testMatrix.includes('CROSS-BINARY-ENDPOINT-MATRIX'), 'tests/matrix.yml lacks cross-stack requirements')

console.log(`[cross-stack-test-governance] ok profiles=${matrix.profiles.length} requirements=${matrix.requirements.length} routes=${flattenMatrixRoutes(matrix).length}`)
