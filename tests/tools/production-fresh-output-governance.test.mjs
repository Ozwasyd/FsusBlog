import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cleanupSensitiveFixtures } from '../../tools/run-test-matrix.mjs'
import {
  assertProductionFreshBundleProducerWiring,
  assertProductionFreshProducerConfiguration,
  assertProductionFreshSchedulerProducerWiring,
  createProductionFreshOutputRoot,
  productionFreshProducerInventory,
  productionFreshOutputEnvironment
} from '../../tools/test-matrix/production-fresh-run-bound-outputs.mjs'

const releaseCollectorSource = fs.readFileSync(
  new URL('../../tools/operations/collect-release-evidence.sh', import.meta.url),
  'utf8')

test('release collector consumes configured Fresh producer roots without ambient fallback reads', () => {
  for (const configuredRoot of [
    'FSUSBLOG_COVERAGE_EVIDENCE_DIR',
    'FSUSBLOG_SECURITY_OUTPUT_ROOT',
    'FSUSBLOG_PERF_EVIDENCE_DIR',
    'FSUSBLOG_FRONTEND_OUTPUT_ROOT',
    'FSUSBLOG_UX_OUTPUT_ROOT',
    'FSUSBLOG_OPERATIONS_EVIDENCE_SOURCE_DIR',
    'FSUSBLOG_GATE_LOG_SOURCE_DIR',
    'FSUSBLOG_FAULT_EVIDENCE_DIR',
    'FSUSBLOG_SOAK_EVIDENCE_DIR',
    'FSUSBLOG_FUZZ_EVIDENCE_DIR'
  ]) assert.match(releaseCollectorSource, new RegExp(configuredRoot))
  assert.match(
    releaseCollectorSource,
    /FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT[^]*return[^]*restore-downloaded-artifacts\.sh/)
  for (const fixedRead of [
    '$ROOT_DIR/.tmp/perf/release-summaries/performance-saturation-v2.json',
    '$ROOT_DIR/.tmp/ux" ux',
    '$ROOT_DIR/.tmp/frontend/dom-budget.json',
    '$ROOT_DIR/.tmp/frontend/route-render-pressure.json'
  ]) assert.equal(releaseCollectorSource.includes(fixedRead), false, fixedRead)
})

test('Fresh sensitive fixture cleanup writes evidence and deletes auth only inside the attempt root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-output-cleanup-'))
  try {
    const layout = createProductionFreshOutputRoot({ root, runId: 'fresh-run' })
    const environment = productionFreshOutputEnvironment(layout, 'production')
    const fixtureRoot = path.join(environment.FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT, 'fresh-run')
    const globalFixtureRoot = path.join(root, '.tmp', 'fixtures', 'fresh-run', 'auth')
    fs.mkdirSync(path.join(fixtureRoot, 'auth'), { recursive: true })
    fs.writeFileSync(path.join(fixtureRoot, 'auth', 'state.json'), '{}')
    fs.mkdirSync(globalFixtureRoot, { recursive: true })
    fs.writeFileSync(path.join(globalFixtureRoot, 'unowned.json'), '{}')

    cleanupSensitiveFixtures('fresh-run', environment)

    assert.equal(fs.existsSync(path.join(fixtureRoot, 'auth')), false)
    assert.equal(fs.existsSync(globalFixtureRoot), true)
    const receiptFile = path.join(
      environment.FSUSBLOG_RELEASE_EVIDENCE_DIR,
      'sensitive-fixture-cleanup.json')
    assert.equal(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).status, 'ok')
    assert.equal(fs.existsSync(path.join(root, '.tmp', 'release-evidence')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Fresh producer output environment rejects fixed global correctness defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-output-governance-'))
  try {
    const layout = createProductionFreshOutputRoot({ root, runId: 'fresh-run' })
    const env = productionFreshOutputEnvironment(layout, 'local-production-backend-tests')
    for (const [name, value] of Object.entries(env)) {
      if (name === 'FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID') continue
      assert.ok(value.startsWith(`${layout.outputRoot}${path.sep}`) || value === layout.outputRoot)
      assert.equal(value.includes(`${path.sep}.tmp${path.sep}coverage`), false)
      assert.equal(value.includes(`${path.sep}.tmp${path.sep}test-results`), false)
      assert.equal(value.includes(`${path.sep}.tmp${path.sep}release-evidence`), false)
    }
    assert.match(env.FSUSBLOG_BACKEND_TRX_DIR, /outputs[\\/]attempts[\\/]attempt-0001[\\/]reports[\\/]trx[\\/]backend$/)
    assert.match(env.FSUSBLOG_PERCEPTION_RUNTIME_EVIDENCE_FILE, /outputs[\\/]attempts[\\/]attempt-0001[\\/]runtime[\\/]perception-v2-e2e-runtime\.json$/)
    assert.match(env.FSUSBLOG_PERCEPTION_MATRIX_SUMMARY_FILE, /outputs[\\/]attempts[\\/]attempt-0001[\\/]artifacts[\\/]perception-v2-test-matrix\.json$/)
    assert.match(env.FSUSBLOG_PERCEPTION_RELEASE_EVIDENCE_FILE, /outputs[\\/]attempts[\\/]attempt-0001[\\/]release-evidence[\\/]perception-v2-release-evidence\.json$/)
    assert.deepEqual(Object.keys(productionFreshProducerInventory.bundles).sort(), [
      'backend-tests',
      'build-static',
      'frontend-tests',
      'performance-evidence',
      'runtime-browser'
    ])
    assert.ok(Object.values(productionFreshProducerInventory.bundles)
      .every((producers) => producers.length > 0))
    assert.equal(assertProductionFreshProducerConfiguration(layout, env), true)
    for (const [name, fixed] of [
      ['FSUSBLOG_TEST_RESULTS_ROOT', path.join(root, '.tmp/test-results')],
      ['FSUSBLOG_COVERAGE_ROOT', path.join(root, '.tmp/coverage')],
      ['FSUSBLOG_BACKEND_TRX_DIR', path.join(root, '.tmp/test-results/backend')],
      ['PLAYWRIGHT_OUTPUT_DIR', path.join(root, 'src/frontend/test-results/playwright')],
      ['FSUSBLOG_BENCHMARK_ARTIFACT_ROOT', path.join(root, 'BenchmarkDotNet.Artifacts')],
      ['FSUSBLOG_RELEASE_EVIDENCE_DIR', path.join(root, '.tmp/release-evidence')]
    ]) {
      assert.throws(
        () => assertProductionFreshProducerConfiguration(layout, { ...env, [name]: fixed }),
        new RegExp(name))
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('runtime producer wiring rejects missing and unexpected physical or scheduler producers', () => {
  for (const [bundleId, producerIds] of Object.entries(productionFreshProducerInventory.bundles)) {
    assert.equal(assertProductionFreshBundleProducerWiring(bundleId, producerIds), true)
    assert.throws(
      () => assertProductionFreshBundleProducerWiring(bundleId, producerIds.slice(1)),
      /wiring mismatch.*missing=/)
    assert.throws(
      () => assertProductionFreshBundleProducerWiring(bundleId, [...producerIds, 'global-output-adapter']),
      /unexpected=global-output-adapter/)
  }
  const schedulerDeclarations = Object.fromEntries(
    productionFreshProducerInventory.schedulerProducers.map((producerId) => [producerId, [`runtime/${producerId}.json`]]))
  assert.equal(assertProductionFreshSchedulerProducerWiring(schedulerDeclarations), true)
  assert.throws(
    () => assertProductionFreshSchedulerProducerWiring({
      ...schedulerDeclarations,
      'forbidden-output-observation': []
    }),
    /missing=forbidden-output-observation/)
  assert.throws(
    () => assertProductionFreshSchedulerProducerWiring({
      ...schedulerDeclarations,
      'global-file-lock': ['runtime/global-file-lock.json']
    }),
    /unexpected=global-file-lock/)
})
