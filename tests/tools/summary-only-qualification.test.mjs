import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateSummaryOnlyConsumerSource } from '../../tools/test-matrix/check-summary-only-consumers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('correctness consumers reject a status-only projection fixture', () => {
  const unsafe = 'if (projection.status === "complete-success") publish()'
  assert.deepEqual(validateSummaryOnlyConsumerSource(unsafe, 'fixture'), [
    'fixture reads projection status without entry, qualification, and external-binding validation'
  ])
  for (const file of [
    'tools/release/check-release-final.mjs',
    'tools/test/lanes/release-final.sh',
    'tools/run-test-matrix.mjs'
  ]) {
    assert.deepEqual(validateSummaryOnlyConsumerSource(fs.readFileSync(path.join(root, file), 'utf8'), file), [])
  }
})
