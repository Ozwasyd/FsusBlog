import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EXPECTED_BACKEND_QPS_MODES,
  loadCatalog,
  runStaticInvariants,
  aggregateSummary
} from '../../tools/test/run-backend-qps-scenarios.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalogPath = path.join(repositoryRoot, 'config/testing/backend-qps-scenario-catalog.json')
const temporaryRoots = []

function createTmpDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'backend-qps-test-'))
  temporaryRoots.push(dir)
  return dir
}

test.after(() => {
  for (const dir of temporaryRoots) {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog contains exactly 13 backend QPS scenarios matching expected modes 1:1', () => {
  const catalog = loadCatalog(catalogPath)
  assert.equal(catalog.schema, 'fsusblog.backend-qps-scenario-catalog.v1')
  assert.equal(catalog.scenarios.length, 13)

  const scenarioIds = catalog.scenarios.map((s) => s.id)
  assert.deepEqual(scenarioIds, EXPECTED_BACKEND_QPS_MODES)
})

test('rejects catalog with missing or duplicate scenario IDs', () => {
  const tmpDir = createTmpDir()
  const invalidCatalogPath = path.join(tmpDir, 'invalid-catalog.json')

  // Missing scenario
  const incompleteCatalog = {
    schema: 'fsusblog.backend-qps-scenario-catalog.v1',
    scenarios: [
      { id: 'view-count-flush' }
    ]
  }
  writeFileSync(invalidCatalogPath, JSON.stringify(incompleteCatalog))
  assert.throws(() => loadCatalog(invalidCatalogPath), /must contain exactly 13 scenarios/)

  // Duplicate scenario
  const catalogData = JSON.parse(readFileSync(catalogPath, 'utf8'))
  catalogData.scenarios[1] = { ...catalogData.scenarios[0] }
  writeFileSync(invalidCatalogPath, JSON.stringify(catalogData))
  assert.throws(() => loadCatalog(invalidCatalogPath), /missing scenario in catalog/)
})

test('exact 1:1 mapping between legacy QPS mode identifiers and new catalog scenarios', () => {
  const catalog = loadCatalog(catalogPath)
  const legacyModes = [
    'view-count-flush',
    'visitlog-invalidation',
    'cache-hit',
    'comment-cursor',
    'hotread',
    'cache-miss-singleflight',
    'risk-filter',
    'related-reading',
    'list-pagination',
    'article-detail-miss',
    'cache-registry',
    'cache-invalidation-batch',
    'index-plan'
  ]

  assert.equal(catalog.scenarios.length, legacyModes.length)
  for (let i = 0; i < legacyModes.length; i++) {
    assert.equal(catalog.scenarios[i].id, legacyModes[i])
    assert.ok(catalog.scenarios[i].route, `scenario ${legacyModes[i]} must define a route`)
    assert.ok(catalog.scenarios[i].trafficMode, `scenario ${legacyModes[i]} must define trafficMode`)
    assert.ok(Array.isArray(catalog.scenarios[i].checks), `scenario ${legacyModes[i]} must define checks`)
  }
})

test('static invariant checker validates required and forbidden tokens using cached source reader', () => {
  const mockCache = {
    checkRequiredToken(file, token) {
      if (token === 'missing_token') return false
      return true
    },
    checkForbiddenToken(file, token) {
      if (token === 'forbidden_present') return true
      return false
    }
  }

  const scenario = {
    id: 'test-scenario',
    requiredTokens: [
      { file: 'src/backend/Test.cs', token: 'valid_token' },
      { file: 'src/backend/Test.cs', token: 'missing_token' }
    ],
    forbiddenTokens: [
      { file: 'src/backend/Test.cs', token: 'forbidden_present' }
    ]
  }

  const failures = runStaticInvariants(scenario, mockCache)
  assert.equal(failures.length, 2)
  assert.ok(failures[0].includes('missing token'))
  assert.ok(failures[1].includes('forbidden token'))
})

test('aggregateSummary creates structured summary evidence file and handles missing artifacts cleanly', () => {
  const tmpDir = createTmpDir()
  const outDir = path.join(tmpDir, 'perf')
  const summaryFile = path.join(tmpDir, 'summary.json')

  mkdirSync(outDir, { recursive: true })

  // Write 12 of 13 artifacts
  for (let i = 0; i < 12; i++) {
    const mode = EXPECTED_BACKEND_QPS_MODES[i]
    writeFileSync(path.join(outDir, `${mode}.json`), JSON.stringify({
      status: 'ok',
      scenario: mode,
      staticEvidence: { status: 'ok' },
      runtimeMeasurement: { status: 'ok' }
    }))
  }

  // Expect throw due to missing artifact when failOnMissing is true
  assert.throws(() => aggregateSummary({ outDir, summaryFile, failOnMissing: true }), /missing collector artifacts/)

  // When failOnMissing is false, writes blocked summary
  const summary = aggregateSummary({ outDir, summaryFile, failOnMissing: false })
  assert.equal(summary.status, 'blocked')
  assert.equal(summary.expectedModes.length, 13)
  assert.equal(summary.resultCount, 12)
  assert.ok(readFileSync(summaryFile, 'utf8').includes('"status": "blocked"'))
})
