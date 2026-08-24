import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { boundedSemanticScale } from './support/timing-policy.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('bounded semantic scale owns clamp, monotonicity and finite upper-bound policy', () => {
  for (const invalid of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(boundedSemanticScale(invalid), 1)
  }
  for (const belowMinimum of [-100, -1, 0, 0.5]) {
    assert.equal(boundedSemanticScale(belowMinimum), 1)
  }

  const representativeScales = [1, 2, 4, 32, Number.MAX_SAFE_INTEGER]
    .map(boundedSemanticScale)
  assert.deepEqual(representativeScales.slice(0, 4), [1, 1.25, 1.375, 1.484375])
  for (let index = 1; index < representativeScales.length; index += 1) {
    assert.ok(representativeScales[index] > representativeScales[index - 1])
  }
  for (const scale of representativeScales) {
    assert.ok(Number.isFinite(scale))
    assert.ok(scale > 0)
    assert.ok(scale <= 1.5)
  }
})

test('deployment timing callers import the shared policy without local formula copies', () => {
  const callers = [
    'tests/tools/release-rollout-probes.test.mjs',
    'tests/tools/zero-downtime-rehearsal.test.mjs'
  ]
  const directImport = /import\s+\{\s*boundedSemanticScale\s*\}\s+from\s+'\.\/support\/timing-policy\.mjs'/u
  const localOwner = /\b(?:function|const|let|var)\s+boundedSemanticScale\b/u
  const copiedFormula = /\(\s*\w+\s*-\s*1\s*\)\s*\/\s*\(\s*2\s*\*\s*\w+\s*\)/u
  const directPolicyCall = /\bboundedSemanticScale\(pressureScale\)/gu

  for (const relativePath of callers) {
    const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8')
    assert.match(source, directImport, `${relativePath} must import the shared timing policy directly`)
    assert.doesNotMatch(source, localOwner, `${relativePath} must not define a local timing policy`)
    assert.doesNotMatch(source, copiedFormula, `${relativePath} must not inline the bounded formula`)
    assert.equal(
      source.match(directPolicyCall)?.length,
      1,
      `${relativePath} must call the shared timing policy exactly once`
    )
  }
})
