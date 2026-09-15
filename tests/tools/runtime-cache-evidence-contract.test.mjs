import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
const sourceSnapshot = {
  commit: 'a'.repeat(40),
  dirty: false,
  statusDigest: `sha256:${'1'.repeat(64)}`,
  worktreeFingerprint: `sha256:${'b'.repeat(64)}`
}
const source = { start: sourceSnapshot, end: sourceSnapshot }
const fixtureDigest = `sha256:${'c'.repeat(64)}`
const payloadDigest = `sha256:${'d'.repeat(64)}`
const runtimeDigest = `sha256:${'e'.repeat(64)}`
const dependencyDigest = `sha256:${'f'.repeat(64)}`
const temporaryRoots = []

function createRepository() {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), 'runtime-cache-contract-'))
  temporaryRoots.push(repositoryRoot)
  for (const relative of ['.tmp/perf/runtime-cache/receipts', '.tmp/perf/runtime-cache/raw', '.tmp/release-evidence']) {
    mkdirSync(path.join(repositoryRoot, relative), { recursive: true })
  }
  return repositoryRoot
}

function tinyCatalog() {
  const catalog = structuredClone(loadRuntimeCacheCatalog())
  for (const scenario of catalog.scenarios) {
    scenario.requests = scenario.subcases.length
    scenario.concurrency = 1
    scenario.warmupRequests = 0
    scenario.requirements = {}
  }
  return catalog
}

function rawAuthority() {
  return {
    requests: 'kestrel-request-observation',
    redis: 'stackexchange-redis-profiler',
    redisFailure: 'redis-operation-executor',
    database: 'sqlsugar-aop',
    cache: 'runtime-cache-evidence-observation',
    fault: 'runtime-fault-controller'
  }
}

function makeEvidence(scenario, repositoryRoot, options = {}) {
  const timestamp = '2026-09-14T00:00:00.000Z'
  const runId = options.runId ?? 'run-1'
  const attemptNumber = options.attemptNumber ?? 1
  const attemptId = `${runId}.attempt-${attemptNumber}`
  const requests = scenario.subcases.map((subcaseId, index) => ({
    id: `${scenario.id}.${index + 1}`,
    subcaseId,
    method: 'GET',
    path: `/fixture/${subcaseId}`,
    status: 200,
    payloadDigest,
    parityGroup: 'fixture',
    layerSource: 'l1-frame',
    latencyMs: index + 1,
    allocatedBytes: 0
  }))
  const authority = rawAuthority()
  const raw = {
    schema: 'fsusblog.runtime-cache-raw-evidence.v2',
    runId,
    scenarioId: scenario.id,
    attemptId,
    authority,
    requests,
    redisCommands: [],
    redisFailureEvents: [],
    cacheEvents: [],
    databaseCommands: [],
    cacheClassifications: requests.map((request) => ({
      requestId: request.id,
      subcaseId: request.subcaseId,
      layerSource: request.layerSource,
      source: authority.cache
    })),
    faultTimeline: []
  }
  for (const [subcaseId, count] of Object.entries(scenario.requirements.rebuildCountBySubcase ?? {})) {
    const request = requests.find((item) => item.subcaseId === subcaseId)
    for (let index = 0; request && index < count; index += 1) {
      raw.cacheEvents.push({
        requestId: request.id,
        subcaseId,
        sequence: index + 1,
        elapsedMilliseconds: index + 1,
        family: scenario.id,
        identityDigest: payloadDigest,
        outcome: 'built',
        source: authority.cache
      })
    }
  }
  options.mutateRaw?.(raw)
  const rawRelativePath = `.tmp/perf/runtime-cache/raw/${scenario.id}.${attemptNumber}.json`
  const rawBytes = `${JSON.stringify(raw, null, 2)}\n`
  writeFileSync(path.join(repositoryRoot, rawRelativePath), rawBytes)

  const latencies = requests.map((request) => request.latencyMs).sort((a, b) => a - b)
  const percentile = (p) => latencies[Math.max(0, Math.ceil((p / 100) * latencies.length) - 1)]
  const receipt = {
    schema: 'fsusblog.runtime-cache-scenario-receipt.v2',
    catalogDigest: digest(options.catalog ?? loadRuntimeCacheCatalog()),
    runId,
    scenarioId: scenario.id,
    attemptId,
    attemptNumber,
    subcases: [...scenario.subcases],
    status: 'passed',
    generatedAt: timestamp,
    source,
    runtime: { digest: runtimeDigest, imageDigest: runtimeDigest, dotnetVersion: '10.0.0', processId: 42, kestrelUrl: 'http://127.0.0.1:7568' },
    dependencies: {
      postgres: { version: '18.0', topology: 'isolated-database', digest: dependencyDigest },
      redis: { version: '8.0', topology: 'isolated-namespace', digest: dependencyDigest }
    },
    machine: { os: 'test', arch: 'arm64', cpuModel: 'fixture', logicalCpuCount: 1, memoryBytes: 1024, runtime: 'node-test' },
    input: { fixtureDigest, requestCount: requests.length, concurrency: 1, parameters: {} },
    windows: { warmup: { startedAt: timestamp, endedAt: timestamp, requestCount: 0 }, sample: { startedAt: timestamp, endedAt: timestamp, requestCount: requests.length } },
    rawEvidence: {
      schema: raw.schema,
      path: rawRelativePath,
      digest: digest(rawBytes),
      authority: structuredClone(authority),
      rowCounts: {
        requests: raw.requests.length,
        redisCommands: raw.redisCommands.length,
        redisFailureEvents: raw.redisFailureEvents.length,
        cacheEvents: raw.cacheEvents.length,
        databaseCommands: raw.databaseCommands.length,
        cacheClassifications: raw.cacheClassifications.length,
        faultEvents: raw.faultTimeline.length
      }
    },
    requests,
    commandSummary: { redis: { count: 0, byVerb: {}, byCategory: {} }, database: { count: 0, byFingerprint: {} } },
    memory: { entries: 1, logicalBytes: 1, capacityBytes: 1, logicalBudgetBytes: 2, capacityBudgetBytes: 2, allocatedBytes: 0, gen0Collections: 0, gen1Collections: 0, gen2Collections: 0, residentBytes: 1 },
    latencyMs: { p50: percentile(50), p95: percentile(95), p99: percentile(99), max: Math.max(...latencies) },
    faultTimeline: [],
    cleanupProof: { status: 'passed', namespaceRemoved: true, activeKeyedEntries: 0, durableRowsBefore: 0, durableRowsAfter: 0, checkedAt: timestamp },
    assertions: scenario.requiredAssertions.map((id) => ({ id, status: 'passed', expected: true, actual: true })),
    firstFailure: null
  }
  options.mutateReceipt?.(receipt)
  return { receipt: sealReceipt(receipt), raw, rawRelativePath }
}

function rewriteRaw(repositoryRoot, evidence, mutation) {
  mutation(evidence.raw)
  const bytes = `${JSON.stringify(evidence.raw, null, 2)}\n`
  writeFileSync(path.join(repositoryRoot, evidence.rawRelativePath), bytes)
  evidence.receipt.rawEvidence.digest = digest(bytes)
  evidence.receipt = sealReceipt(evidence.receipt)
  return evidence.receipt
}

function writeCompleteSet(repositoryRoot, catalog) {
  const receiptDir = path.join(repositoryRoot, '.tmp/perf/runtime-cache/receipts')
  const receipts = catalog.scenarios.map((scenario) => makeEvidence(scenario, repositoryRoot, { catalog }).receipt)
  for (const receipt of receipts) writeFileSync(path.join(receiptDir, `${receipt.scenarioId}.json`), `${JSON.stringify(receipt, null, 2)}\n`)
  return { receiptDir, receipts }
}

test.after(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true })
})

test('catalog seals one exact current set of 13 scenarios and subcases', () => {
  const catalog = loadRuntimeCacheCatalog()
  assert.equal(catalog.schema, 'fsusblog.runtime-cache-evidence-catalog.v2')
  assert.equal(catalog.receiptSchema, 'fsusblog.runtime-cache-scenario-receipt.v2')
  assert.equal(catalog.rawEvidenceSchema, 'fsusblog.runtime-cache-raw-evidence.v2')
  assert.equal(catalog.scenarios.length, 13)
  assert.equal(new Set(catalog.scenarios.map((scenario) => scenario.id)).size, 13)
  assert.ok(catalog.scenarios.every((scenario) => scenario.subcases.length > 0 && new Set(scenario.subcases).size === scenario.subcases.length))
  assert.ok(catalog.scenarios.every((scenario) => !('requiredTokens' in scenario) && !('forbiddenTokens' in scenario)))
})

test('canonical fixture validates only against the current sealed schema', () => {
  const fixture = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/runtime-cache-scenario-receipt.v2.json'), 'utf8'))
  assert.deepEqual(validateJsonSchema(fixture, loadRuntimeCacheSchema()), [])
  assert.equal(sealReceipt(fixture).contentDigest, fixture.contentDigest)
})

test('source start/end and exact dirty identity fail closed on drift', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const evidence = makeEvidence(catalog.scenarios[0], repositoryRoot, { catalog })
  assert.deepEqual(validateRuntimeCacheReceipt(evidence.receipt, { catalog, repositoryRoot, expectedSource: sourceSnapshot }), [])

  const changedDuringRun = sealReceipt({ ...evidence.receipt, source: { start: sourceSnapshot, end: { ...sourceSnapshot, dirty: true } } })
  assert.ok(validateRuntimeCacheReceipt(changedDuringRun, { catalog, repositoryRoot, expectedSource: sourceSnapshot }).some((error) => error.includes('changed between start and end')))
  const staleDirty = sealReceipt({ ...evidence.receipt, source: { start: { ...sourceSnapshot, dirty: true }, end: { ...sourceSnapshot, dirty: true } } })
  assert.ok(validateRuntimeCacheReceipt(staleDirty, { catalog, repositoryRoot, expectedSource: sourceSnapshot }).some((error) => error.includes('source.start.dirty')))
})

test('receipt requires the exact catalog subcases and assertion IDs', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const evidence = makeEvidence(catalog.scenarios[0], repositoryRoot, { catalog })
  const missingSubcase = sealReceipt({ ...evidence.receipt, subcases: evidence.receipt.subcases.slice(1) })
  assert.ok(validateRuntimeCacheReceipt(missingSubcase, { catalog, repositoryRoot, expectedSource: sourceSnapshot }).some((error) => error.includes('subcases must exactly match')))
  const extraAssertion = sealReceipt({ ...evidence.receipt, assertions: [...evidence.receipt.assertions, { id: 'unknown-assertion', status: 'passed', expected: true, actual: true }] })
  assert.ok(validateRuntimeCacheReceipt(extraAssertion, { catalog, repositoryRoot, expectedSource: sourceSnapshot }).some((error) => error.includes('assertion IDs must exactly match')))
})

test('article-detail Redis fault latency is derived from request traces', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const scenario = catalog.scenarios.find((item) => item.id === 'article-detail-l1')
  scenario.requirements = { redisCommandsMax: 0, dbCommandsMax: 0, redisFaultLatencyRatioMax: 1.25 }
  const evidence = makeEvidence(scenario, repositoryRoot, { catalog })

  const errors = validateRuntimeCacheReceipt(evidence.receipt, {
    catalog,
    repositoryRoot,
    expectedSource: sourceSnapshot
  })

  assert.ok(errors.some((error) => error.includes('Redis fault changed L1 latency ratio')))
  assert.ok(!errors.some((error) => error.includes('did not remain on an L1 path')))
})

test('telemetry allocation budget uses the authenticated UnifiedCache boundary rather than HTTP transport allocation', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const scenario = catalog.scenarios.find((item) => item.id === 'telemetry')
  scenario.requirements = {
    unsampledL1AllocationBytesMax: 0,
    unsampledL1AllocationAuthority: 'runtime-cache-l1-boundary'
  }
  const evidence = makeEvidence(scenario, repositoryRoot, {
    catalog,
    mutateRaw: (raw) => { raw.requests[0].allocatedBytes = 12_392 },
    mutateReceipt: (receipt) => {
      receipt.input.parameters.unsampledL1AllocationAuthority = 'runtime-cache-l1-boundary'
      const assertion = receipt.assertions.find((item) => item.id === 'unsampled-l1-zero-allocation')
      assertion.expected = { observed: true, sameThread: true, maxBytes: 0 }
      assertion.actual = { observed: true, sameThread: true, maxBytes: 0 }
    }
  })

  assert.deepEqual(validateRuntimeCacheReceipt(evidence.receipt, {
    catalog,
    repositoryRoot,
    expectedSource: sourceSnapshot
  }), [])

  const missingAuthority = structuredClone(evidence.receipt)
  delete missingAuthority.input.parameters.unsampledL1AllocationAuthority
  assert.ok(validateRuntimeCacheReceipt(sealReceipt(missingAuthority), {
    catalog,
    repositoryRoot,
    expectedSource: sourceSnapshot
  }).some((error) => error.includes('allocation authority')))
})

test('singleflight rebuild counts are exact per cold identity group', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const scenario = catalog.scenarios.find((item) => item.id === 'cache-miss-singleflight')
  scenario.requirements = { rebuildCountBySubcase: { 'same-key-100': 1, 'same-key-1000': 1 } }
  const evidence = makeEvidence(scenario, repositoryRoot, { catalog })

  const errors = validateRuntimeCacheReceipt(evidence.receipt, {
    catalog,
    repositoryRoot,
    expectedSource: sourceSnapshot
  })

  assert.ok(errors.some((error) => error.includes('rebuild counts must exactly match')))
})

test('hot and featured atomic publication is derived from request-bound raw evidence', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const scenario = catalog.scenarios.find((item) => item.id === 'hot-featured-frame')
  scenario.requirements = { atomicRedisPublication: true }
  const expected = {
    hotPublicationCount: 1,
    featuredPublicationCount: 1,
    hotAtomicPublisherCount: 1,
    featuredAtomicPublisherCount: 1
  }
  const evidence = makeEvidence(scenario, repositoryRoot, {
    catalog,
    mutateRaw: (raw) => {
      for (const [index, request] of raw.requests.entries()) {
        raw.cacheEvents.push({
          requestId: request.id,
          subcaseId: request.subcaseId,
          sequence: 1,
          elapsedMilliseconds: 1,
          family: `article-${request.subcaseId}-frame`,
          identityDigest: payloadDigest,
          outcome: 'published',
          source: raw.authority.cache
        })
        raw.redisCommands.push({
          requestId: request.id,
          subcaseId: request.subcaseId,
          verb: 'EVALSHA',
          category: 'atomic-script',
          source: raw.authority.redis
        })
      }
    },
    mutateReceipt: (receipt) => {
      const assertion = receipt.assertions.find((item) => item.id === 'atomic-redis-publication')
      assertion.expected = expected
      assertion.actual = expected
      receipt.commandSummary.redis = {
        count: 2,
        byVerb: { EVALSHA: 2 },
        byCategory: { 'atomic-script': 2 }
      }
    }
  })

  assert.deepEqual(validateRuntimeCacheReceipt(evidence.receipt, {
    catalog,
    repositoryRoot,
    expectedSource: sourceSnapshot
  }), [])

  let missingAtomicCommand = rewriteRaw(repositoryRoot, evidence, (raw) => {
    raw.redisCommands = []
  })
  missingAtomicCommand.rawEvidence.rowCounts.redisCommands = 0
  missingAtomicCommand.commandSummary.redis = { count: 0, byVerb: {}, byCategory: {} }
  missingAtomicCommand = sealReceipt(missingAtomicCommand)
  assert.ok(validateRuntimeCacheReceipt(missingAtomicCommand, {
    catalog,
    repositoryRoot,
    expectedSource: sourceSnapshot
  }).some((error) => error.includes('atomic Redis publication was not proven')))
})

test('raw request, command, cache and rollup closure is recomputed independently', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const evidence = makeEvidence(catalog.scenarios[0], repositoryRoot, { catalog })
  const receipt = rewriteRaw(repositoryRoot, evidence, (raw) => {
    raw.redisCommands.push({ requestId: 'missing-request', subcaseId: raw.requests[0].subcaseId, verb: 'GET', category: 'read', source: raw.authority.redis })
  })
  receipt.rawEvidence.rowCounts.redisCommands = 1
  const sealed = sealReceipt(receipt)
  const errors = validateRuntimeCacheReceipt(sealed, { catalog, repositoryRoot, expectedSource: sourceSnapshot })
  assert.ok(errors.some((error) => error.includes('references unknown request')))
  assert.ok(errors.some((error) => error.includes('Redis command rollup')))
})

test('request-bound Redis failures require executor authority and request closure', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const evidence = makeEvidence(catalog.scenarios[0], repositoryRoot, { catalog })
  const receipt = rewriteRaw(repositoryRoot, evidence, (raw) => {
    raw.redisFailureEvents.push({
      requestId: raw.requests[0].id,
      subcaseId: raw.requests[0].subcaseId,
      sequence: 1,
      elapsedMilliseconds: 2.5,
      operationClass: 'ContentCacheRead',
      failureKind: 'CommandTimeout',
      failAction: 'bounded-origin-gate',
      source: raw.authority.redisFailure
    })
  })
  receipt.rawEvidence.rowCounts.redisFailureEvents = 1
  assert.deepEqual(validateRuntimeCacheReceipt(sealReceipt(receipt), { catalog, repositoryRoot, expectedSource: sourceSnapshot }), [])

  const invalidReceipt = rewriteRaw(repositoryRoot, evidence, (raw) => {
    raw.redisFailureEvents[0].requestId = 'missing-request'
  })
  assert.ok(validateRuntimeCacheReceipt(invalidReceipt, { catalog, repositoryRoot, expectedSource: sourceSnapshot })
    .some((error) => error.includes('references unknown request')))
})

test('request-bound cache events require digested identities and closed outcomes', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const evidence = makeEvidence(catalog.scenarios[0], repositoryRoot, { catalog })
  const receipt = rewriteRaw(repositoryRoot, evidence, (raw) => {
    raw.cacheEvents.push({
      requestId: raw.requests[0].id,
      subcaseId: raw.requests[0].subcaseId,
      sequence: 1,
      elapsedMilliseconds: 1.5,
      family: 'related-reading',
      identityDigest: payloadDigest,
      outcome: 'built',
      source: raw.authority.cache
    })
  })
  receipt.rawEvidence.rowCounts.cacheEvents = 1
  assert.deepEqual(validateRuntimeCacheReceipt(sealReceipt(receipt), { catalog, repositoryRoot, expectedSource: sourceSnapshot }), [])

  const invalid = rewriteRaw(repositoryRoot, evidence, (raw) => { raw.cacheEvents[0].outcome = 'claimed' })
  assert.ok(validateRuntimeCacheReceipt(invalid, { catalog, repositoryRoot, expectedSource: sourceSnapshot })
    .some((error) => error.includes('outcome is invalid')))
})

test('raw evidence rejects unknown fields and unsupported authorities', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const unknown = makeEvidence(catalog.scenarios[0], repositoryRoot, { catalog, mutateRaw: (raw) => { raw.unknown = true } })
  assert.ok(validateRuntimeCacheReceipt(unknown.receipt, { catalog, repositoryRoot, expectedSource: sourceSnapshot }).some((error) => error.includes('fields must be exact')))

  const unsupported = makeEvidence(catalog.scenarios[1], repositoryRoot, { catalog })
  const unsupportedReceipt = rewriteRaw(repositoryRoot, unsupported, (raw) => { raw.authority.redis = 'mock-command-counter' })
  assert.ok(validateRuntimeCacheReceipt(unsupportedReceipt, { catalog, repositoryRoot, expectedSource: sourceSnapshot }).some((error) => error.includes('unsupported Redis authority')))
})

test('legacy, unknown, unsupported and waived receipt states are rejected', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const receipt = makeEvidence(catalog.scenarios[0], repositoryRoot, { catalog }).receipt
  for (const mutation of [
    { schema: 'fsusblog.runtime-cache-scenario-receipt.v1' },
    { scenarioId: 'unknown-runtime-cache-scenario' },
    { status: 'waived' },
    { unsupported: true }
  ]) {
    const invalid = sealReceipt({ ...receipt, ...mutation })
    assert.ok(validateRuntimeCacheReceipt(invalid, { catalog, repositoryRoot, expectedSource: sourceSnapshot }).length > 0)
  }
})

test('raw evidence path escape and symlink are rejected before reading', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const evidence = makeEvidence(catalog.scenarios[0], repositoryRoot, { catalog })
  const escaped = sealReceipt({ ...evidence.receipt, rawEvidence: { ...evidence.receipt.rawEvidence, path: '.tmp/perf/runtime-cache/../outside.json' } })
  assert.ok(validateRuntimeCacheReceipt(escaped, { catalog, repositoryRoot, expectedSource: sourceSnapshot }).some((error) => error.includes('escapes')))

  const target = path.join(repositoryRoot, evidence.rawRelativePath)
  const link = path.join(repositoryRoot, '.tmp/perf/runtime-cache/raw/link.json')
  symlinkSync(target, link)
  const linked = sealReceipt({ ...evidence.receipt, rawEvidence: { ...evidence.receipt.rawEvidence, path: '.tmp/perf/runtime-cache/raw/link.json' } })
  assert.ok(validateRuntimeCacheReceipt(linked, { catalog, repositoryRoot, expectedSource: sourceSnapshot }).some((error) => error.includes('non-symlink')))

  const outside = mkdtempSync(path.join(tmpdir(), 'runtime-cache-physical-escape-'))
  temporaryRoots.push(outside)
  writeFileSync(path.join(outside, 'raw.json'), readFileSync(target))
  symlinkSync(outside, path.join(repositoryRoot, '.tmp/perf/runtime-cache/raw-parent'))
  const parentLinked = sealReceipt({ ...evidence.receipt, rawEvidence: { ...evidence.receipt.rawEvidence, path: '.tmp/perf/runtime-cache/raw-parent/raw.json' } })
  assert.ok(validateRuntimeCacheReceipt(parentLinked, { catalog, repositoryRoot, expectedSource: sourceSnapshot }).some((error) => error.includes('physical path escapes')))
})

test('first failure and attempt receipts are append-only and block later success', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const scenario = catalog.scenarios[0]
  const evidence = makeEvidence(scenario, repositoryRoot, { catalog })
  const failure = {
    attemptId: evidence.receipt.attemptId,
    attemptNumber: 1,
    capturedAt: '2026-09-14T00:00:00.000Z',
    requestId: evidence.receipt.requests[0].id,
    subcaseId: evidence.receipt.requests[0].subcaseId,
    assertionId: evidence.receipt.assertions[0].id,
    message: 'first failure',
    rawEvidenceDigest: evidence.receipt.rawEvidence.digest,
    faultTimeline: []
  }
  const attemptDirectory = path.join(repositoryRoot, '.tmp/perf/runtime-cache/attempts/public-hot-read')
  const firstAttempt = path.join(attemptDirectory, 'attempt-1.json')
  const failed = writeReceiptPreservingFirstFailure(firstAttempt, { ...evidence.receipt, status: 'failed', firstFailure: failure })
  const firstFailureBytes = readFileSync(path.join(attemptDirectory, 'first-failure.json'), 'utf8')
  assert.equal(failed.firstFailure.message, 'first failure')
  assert.throws(() => writeReceiptPreservingFirstFailure(firstAttempt, evidence.receipt), /first failure is append-only/u)

  const retry = makeEvidence(scenario, repositoryRoot, { catalog, attemptNumber: 2 }).receipt
  assert.throws(() => writeReceiptPreservingFirstFailure(path.join(attemptDirectory, 'attempt-2.json'), retry), /blocks a later success/u)
  assert.equal(readFileSync(path.join(attemptDirectory, 'first-failure.json'), 'utf8'), firstFailureBytes)
})

test('checker requires one clean first attempt for all 13 scenarios', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const { receipts } = writeCompleteSet(repositoryRoot, catalog)
  assert.deepEqual(validateRuntimeCacheReceiptSet(receipts, { catalog, repositoryRoot, expectedSource: sourceSnapshot }), [])
  assert.ok(validateRuntimeCacheReceiptSet(receipts.slice(1), { catalog, repositoryRoot, expectedSource: sourceSnapshot }).some((error) => error.includes('missing current-schema receipt')))
  const retry = sealReceipt({ ...receipts[0], attemptNumber: 2, attemptId: 'run-1.attempt-2' })
  assert.ok(validateRuntimeCacheReceiptSet([retry, ...receipts.slice(1)], { catalog, repositoryRoot, expectedSource: sourceSnapshot }).some((error) => error.includes('only clean first-attempt success qualifies')))
})

test('aggregate checker rejects extra and legacy artifact contamination', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const { receiptDir } = writeCompleteSet(repositoryRoot, catalog)
  const summary = path.join(repositoryRoot, '.tmp/release-evidence/runtime-cache-summary.json')
  const result = checkRuntimeCacheEvidence({ receiptDir, summary, catalog, expectedSource: sourceSnapshot, repositoryRoot })
  assert.equal(result.status, 'passed')

  writeFileSync(path.join(receiptDir, 'backend-qps-summary.json'), '{}\n')
  assert.throws(() => checkRuntimeCacheEvidence({ receiptDir, summary, catalog, expectedSource: sourceSnapshot, repositoryRoot }), /legacy artifact contaminates/u)
  rmSync(path.join(receiptDir, 'backend-qps-summary.json'))
  const legacyRoot = path.join(repositoryRoot, '.tmp/perf/backend-qps')
  mkdirSync(legacyRoot, { recursive: true })
  writeFileSync(path.join(legacyRoot, 'old.json'), '{}\n')
  assert.throws(() => checkRuntimeCacheEvidence({ receiptDir, summary, catalog, expectedSource: sourceSnapshot, repositoryRoot }), /legacy backend-qps artifact contamination/u)
})

test('checker rejects receipt and summary paths outside their owned roots', () => {
  const repositoryRoot = createRepository()
  const catalog = tinyCatalog()
  const outside = mkdtempSync(path.join(tmpdir(), 'runtime-cache-outside-'))
  temporaryRoots.push(outside)
  assert.throws(() => checkRuntimeCacheEvidence({ receiptDir: outside, summary: path.join(repositoryRoot, '.tmp/release-evidence/summary.json'), catalog, expectedSource: sourceSnapshot, repositoryRoot }), /receipt directory escapes/u)
  const { receiptDir } = writeCompleteSet(repositoryRoot, catalog)
  assert.throws(() => checkRuntimeCacheEvidence({ receiptDir, summary: path.join(outside, 'summary.json'), catalog, expectedSource: sourceSnapshot, repositoryRoot }), /summary path escapes/u)
})
