import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'

const bundlePath = path.join(root, 'tools/test/bundles/post-runtime-observation-producers.sh')

test('shared producer bundle invokes and independently verifies all seven canonical classes', () =>
{
  const source = fs.readFileSync(bundlePath, 'utf8')
  for (const producer of [
    'aot-spa-hydration-raw.mjs',
    'blue-green-containment-raw.mjs',
    'browser-contract-observation-raw.mjs',
    'release-readiness-raw.mjs',
    'runtime-observation-raw.mjs'
  ]) assert.match(source, new RegExp(producer.replaceAll('.', '\\.')))
  for (const classId of [
    'aot-spa-hydration', 'blue-green-containment', 'browser-behavior-contract',
    'cache-search-outbox-convergence', 'release-identity-readiness',
    'route-response-error', 'session-cookie-runtime'
  ]) assert.match(source, new RegExp(classId))
  assert.match(source, /application-runtime\.mjs verify/u)
  assert.match(source, /release-deployment\.mjs verify/u)
})

test('shared producer bundle fails closed instead of fabricating missing current-run inputs', () =>
{
  const result = spawnSync('bash', [bundlePath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FSUSBLOG_TEST_RUN_ID: 'missing-current-run' }
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /required current-run input is missing/u)
})
