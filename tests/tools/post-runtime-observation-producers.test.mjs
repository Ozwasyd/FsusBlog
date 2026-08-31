import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { writeReceipt } from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import { root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'

const bundlePath = path.join(root, 'tools/test/bundles/post-runtime-observation-producers.sh')
const candidatePlanLanePath = path.join(root, 'tools/test/lanes/post-runtime-candidate-plan.sh')

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

test('candidate and observation outputs preserve each run attempt while accepted claims remain run-level', () =>
{
  const candidateLane = fs.readFileSync(candidatePlanLanePath, 'utf8')
  const producerBundle = fs.readFileSync(bundlePath, 'utf8')
  for (const source of [candidateLane, producerBundle])
  {
    assert.match(source, /post-runtime-plan\/\$RUN_ID/u)
    assert.match(source, /\$CLAIMS_DIR\/\$ATTEMPT_ID/u)
    assert.match(source, /post-runtime-raw\/\$RUN_ID\/\$ATTEMPT_ID/u)
  }
  assert.match(candidateLane, /\$CLAIMS_DIR\/accepted-claims\.json/u)
  assert.doesNotMatch(candidateLane, /\$OUT_DIR\/accepted-claims\.json/u)
  assert.match(producerBundle, /post-runtime-observations\/\$RUN_ID\/\$ATTEMPT_ID/u)
  assert.match(producerBundle, /post-runtime-sources\/\$RUN_ID\/\$ATTEMPT_ID/u)
  assert.match(producerBundle, /runtime-observation-probes\/\$RUN_ID\/\$ATTEMPT_ID/u)
  const adapter = fs.readFileSync(path.join(root, 'tools/fact-extractors/post-runtime/adapter.mjs'), 'utf8')
  assert.match(adapter, /post-runtime-source-receipts\/\$\{plan\.candidate\.runId\}\/\$\{plan\.candidate\.attemptId\}/u)
  assert.match(adapter, /production requires an explicit current-run output path/u)
})

test('post-runtime writers never overwrite retained attempt evidence', (context) =>
{
  const tempRoot = path.join(root, '.tmp')
  fs.mkdirSync(tempRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tempRoot, 'post-runtime-no-overwrite-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const output = path.relative(root, path.join(directory, 'receipt.json')).replaceAll(path.sep, '/')
  writeReceipt(output, { schema: 'fsusblog.test.v1', status: 'diagnostic' }, root)
  assert.throws(
    () => writeReceipt(output, { schema: 'fsusblog.test.v1', status: 'qualified' }, root),
    /must not overwrite an existing current-run record/u)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, output), 'utf8')).status, 'diagnostic')
})
