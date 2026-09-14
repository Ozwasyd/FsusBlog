import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkRuntimeCacheEvidence } from '../../tools/test/check-runtime-cache-evidence.mjs'
import {
  digest,
  loadRuntimeCacheCatalog,
  loadRuntimeCacheSchema,
  sealReceipt,
  validateRuntimeCacheReceipt,
  validateRuntimeCacheReceiptSet,
  writeReceiptPreservingFirstFailure
} from '../../tools/test/runtime-cache-evidence-contract.mjs'
import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const source = { commit: 'a'.repeat(40), dirty: false, worktreeFingerprint: `sha256:${'b'.repeat(64)}` }
const fixtureDigest = `sha256:${'c'.repeat(64)}`
const payloadDigest = `sha256:${'d'.repeat(64)}`
const runtimeDigest = `sha256:${'e'.repeat(64)}`
const dependencyDigest = `sha256:${'f'.repeat(64)}`
const temporaryRoots = []

function tinyCatalog() {
  const catalog = structuredClone(loadRuntimeCacheCatalog())
  for (const scenario of catalog.scenarios) {
    scenario.requests = 1
    scenario.concurrency = 1
    scenario.warmupRequests = 0
    scenario.requiredAssertions = []
    scenario.requirements = {}
  }
  return catalog
}

function makeReceipt(scenarioId, overrides = {}) {
  const timestamp = '2026-09-14T00:00:00.000Z'
  return sealReceipt({
    schema: 'fsusblog.runtime-cache-scenario-receipt.v1',
    scenarioId,
    status: 'passed',
    generatedAt: timestamp,
    source,
    runtime: { digest: runtimeDigest, imageDigest: null, dotnetVersion: '10.0.0', processId: 42, kestrelUrl: 'http://127.0.0.1:7568' },
    dependencies: {
      postgres: { version: '18.0', topology: 'isolated-database', digest: dependencyDigest },
      redis: { version: '8.0', topology: 'isolated-namespace', digest: dependencyDigest }
    },
    machine: { os: 'test', arch: 'arm64', cpuModel: 'fixture', logicalCpuCount: 1, memoryBytes: 1024, runtime: 'node-test' },
    input: { fixtureDigest, requestCount: 1, concurrency: 1, parameters: {} },
    windows: { warmup: { startedAt: timestamp, endedAt: timestamp, requestCount: 0 }, sample: { startedAt: timestamp, endedAt: timestamp, requestCount: 1 } },
    requests: [{ id: `${scenarioId}-1`, method: 'GET', path: '/fixture', status: 200, payloadDigest, parityGroup: 'fixture', layerSource: 'l1-frame', latencyMs: 1, allocatedBytes: 0, redisCommands: [], dbCommands: [] }],
    commandSummary: { redis: { count: 0, byCategory: {} }, database: { count: 0, byCategory: {} } },
    memory: { entries: 1, logicalBytes: 1, capacityBytes: 1, logicalBudgetBytes: 2, capacityBudgetBytes: 2, allocatedBytes: 0, gen0Collections: 0, gen1Collections: 0, gen2Collections: 0, residentBytes: 1 },
    latencyMs: { p50: 1, p95: 1, p99: 1, max: 1 },
    faultTimeline: [],
    cleanupProof: { status: 'passed', namespaceRemoved: true, activeKeyedEntries: 0, durableRowsBefore: 0, durableRowsAfter: 0, checkedAt: timestamp },
    assertions: [{ id: 'fixture', status: 'passed', expected: true, actual: true }],
    firstFailure: null,
    ...overrides
  })
}

test.after(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true })
})

test('catalog is the only current 13-scenario runtime cache catalog', () => {
  const catalog = loadRuntimeCacheCatalog()
  assert.equal(catalog.schema, 'fsusblog.runtime-cache-evidence-catalog.v1')
  assert.equal(catalog.receiptSchema, 'fsusblog.runtime-cache-scenario-receipt.v1')
  assert.equal(catalog.scenarios.length, 13)
  assert.equal(new Set(catalog.scenarios.map((scenario) => scenario.id)).size, 13)
  assert.ok(catalog.scenarios.every((scenario) => !('requiredTokens' in scenario) && !('forbiddenTokens' in scenario)))
})

test('canonical fixture validates against the current schema and has a valid content seal', () => {
  const fixture = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/runtime-cache-scenario-receipt.v1.json'), 'utf8'))
  assert.deepEqual(validateJsonSchema(fixture, loadRuntimeCacheSchema()), [])
  assert.equal(sealReceipt(fixture).contentDigest, fixture.contentDigest)
})

test('current checker rejects legacy receipt schemas and token-only fields', () => {
  const catalog = tinyCatalog()
  const legacy = makeReceipt('public-hot-read')
  legacy.schema = 'backend-qps-collector-evidence'
  assert.match(validateRuntimeCacheReceipt(legacy, { catalog, expectedSource: source })[0], /schema/u)

  const tokenOnly = { ...makeReceipt('public-hot-read'), requiredTokens: ['singleflight'] }
  assert.ok(validateRuntimeCacheReceipt(tokenOnly, { catalog, expectedSource: source }).some((error) => error.includes('requiredTokens')))
})

test('checker binds exact source identity and direct request command traces', () => {
  const catalog = tinyCatalog()
  const receipt = makeReceipt('public-hot-read')
  assert.deepEqual(validateRuntimeCacheReceipt(receipt, { catalog, expectedSource: source }), [])

  const stale = sealReceipt({ ...receipt, source: { ...source, commit: '0'.repeat(40) } })
  assert.ok(validateRuntimeCacheReceipt(stale, { catalog, expectedSource: source }).some((error) => error.includes('source.commit')))

  const unbound = structuredClone(receipt)
  unbound.commandSummary.redis.count = 1
  const unboundSealed = sealReceipt(unbound)
  assert.ok(validateRuntimeCacheReceipt(unboundSealed, { catalog, expectedSource: source }).some((error) => error.includes('rollup')))
})

test('checker requires all and only the 13 current scenario receipts', () => {
  const catalog = tinyCatalog()
  const receipts = catalog.scenarios.map((scenario) => makeReceipt(scenario.id))
  assert.deepEqual(validateRuntimeCacheReceiptSet(receipts, { catalog, expectedSource: source }), [])
  assert.ok(validateRuntimeCacheReceiptSet(receipts.slice(1), { catalog, expectedSource: source }).some((error) => error.includes('missing current-schema receipt')))
})

test('aggregate checker writes a passed summary only for a complete current set', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'runtime-cache-receipts-'))
  temporaryRoots.push(directory)
  const receiptDir = path.join(directory, 'receipts')
  const summary = path.join(directory, 'summary.json')
  mkdirSync(receiptDir)
  const catalog = tinyCatalog()
  for (const scenario of catalog.scenarios) writeFileSync(path.join(receiptDir, `${scenario.id}.json`), `${JSON.stringify(makeReceipt(scenario.id))}\n`)
  const result = checkRuntimeCacheEvidence({ receiptDir, summary, catalog, expectedSource: source, repositoryRoot: root })
  assert.equal(result.status, 'passed')
  assert.equal(Object.keys(result.receiptDigests).length, 13)
})

test('first failure survives a later successful write', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'runtime-cache-first-failure-'))
  temporaryRoots.push(directory)
  const file = path.join(directory, 'receipt.json')
  const failure = { capturedAt: '2026-09-14T00:00:00.000Z', requestId: 'request-1', assertionId: 'budget', message: 'failed first', redisCommands: [], dbCommands: [], faultTimeline: [] }
  writeReceiptPreservingFirstFailure(file, makeReceipt('public-hot-read', { status: 'failed', firstFailure: failure }))
  const rewritten = writeReceiptPreservingFirstFailure(file, makeReceipt('public-hot-read'))
  assert.deepEqual(rewritten.firstFailure, failure)
  assert.equal(rewritten.contentDigest, digest(Object.fromEntries(Object.entries(rewritten).filter(([key]) => key !== 'contentDigest'))))
})
