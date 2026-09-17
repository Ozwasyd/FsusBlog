import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  loadNativeGovernance,
  validateNativeGovernance,
  validateNativeReceipt
} from '../../tools/test/native-test-governance.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function clonedGovernance() {
  const { catalog, matrix } = loadNativeGovernance(root)
  return {
    catalog: structuredClone(catalog),
    matrix: structuredClone(matrix)
  }
}

test('native catalog discovers every C++ CMake target and binds production/release consumers exact-once', () => {
  const { catalog, matrix } = clonedGovernance()
  assert.deepEqual(validateNativeGovernance({ root, catalog, matrix }), [])
})

test('unregistered native source fails closed', () => {
  const { catalog, matrix } = clonedGovernance()
  catalog.targets = catalog.targets.filter((entry) => entry.kind !== 'smoke')
  assert.match(validateNativeGovernance({ root, catalog, matrix }).join('\n'), /native asset is not registered/)
})

test('duplicate matrix owner fails closed', () => {
  const { catalog, matrix } = clonedGovernance()
  matrix.tiers.find((entry) => entry.id === 'native-smoke').owner = 'ServerContractAgent'
  assert.match(validateNativeGovernance({ root, catalog, matrix }).join('\n'), /wrong owner/)
})

test('duplicate production consumer fails exact-once validation', () => {
  const { catalog, matrix } = clonedGovernance()
  matrix.tiers.find((entry) => entry.id === 'production-correctness').executionDependsOn.push('native-smoke')
  assert.match(validateNativeGovernance({ root, catalog, matrix }).join('\n'), /exactly once/)
})

test('missing fuzz corpus fails closed', () => {
  const { catalog, matrix } = clonedGovernance()
  catalog.corpora = []
  assert.match(validateNativeGovernance({ root, catalog, matrix }).join('\n'), /no registered corpus/)
})

test('target rename without catalog mapping fails closed', () => {
  const { catalog, matrix } = clonedGovernance()
  catalog.targets.find((entry) => entry.kind === 'fuzz').cmakeTarget = 'RenamedFuzzTarget'
  assert.match(validateNativeGovernance({ root, catalog, matrix }).join('\n'), /renamed without catalog mapping/)
})

test('release evidence omission fails closed', () => {
  const { catalog, matrix } = clonedGovernance()
  matrix.tiers.find((entry) => entry.id === 'native-fuzz-sanitizer').evidence = []
  assert.match(validateNativeGovernance({ root, catalog, matrix }).join('\n'), /does not own receipt/)
})

test('receipt validator rejects stale source and incomplete crash identity', () => {
  const { catalog } = clonedGovernance()
  const profile = catalog.profiles.find((entry) => entry.id === 'smoke')
  const target = catalog.targets.find((entry) => entry.profile === 'smoke')
  const receipt = {
    schema: 'fsusblog.native-test-receipt.v1',
    profile: profile.id,
    testId: target.testId,
    target: target.cmakeTarget,
    source: { commit: 'a'.repeat(40), inputDigest: `sha256:${'b'.repeat(64)}` },
    toolchain: { compilerPath: '/usr/bin/c++', compilerVersion: 'c++ 1', cmakeVersion: 'cmake 1' },
    flags: { sanitizers: [], fuzzer: [] },
    corpus: { identity: `sha256:${'c'.repeat(64)}` },
    crashArtifacts: { count: 0, digest: 'missing' },
    preflight: { status: 'ready', missingReason: null },
    outcome: 'passed'
  }
  const errors = validateNativeReceipt(receipt, profile, target, { expectedCommit: 'd'.repeat(40) })
  assert.match(errors.join('\n'), /does not match the requested commit/)
  assert.match(errors.join('\n'), /crash artifact digest is invalid/)
})
