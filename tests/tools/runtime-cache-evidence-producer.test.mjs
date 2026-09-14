import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadRuntimeCacheCatalog, validateRuntimeCacheReceipt } from '../../tools/test/runtime-cache-evidence-contract.mjs'
import {
  collectObservedRequest,
  implementedRuntimeCacheScenarios,
  producePublicHotReadReceipt,
  runRuntimeCacheProducer
} from '../../tools/test/run-runtime-cache-evidence.mjs'
import { produceArticleDetailL1Receipt } from '../../tools/test/runtime-cache-scenarios/article-detail-l1.mjs'
import { producePaginationReceipt } from '../../tools/test/runtime-cache-scenarios/pagination.mjs'
import { produceRelatedReadingReceipt } from '../../tools/test/runtime-cache-scenarios/related-reading.mjs'
import { produceSitemapReceipt } from '../../tools/test/runtime-cache-scenarios/sitemap.mjs'

const secret = 'runtime-cache-producer-test-secret'
const source = {
  commit: 'a'.repeat(40),
  dirty: false,
  statusDigest: `sha256:${'1'.repeat(64)}`,
  worktreeFingerprint: `sha256:${'b'.repeat(64)}`
}
const identity = {
  source,
  runtime: {
    digest: `sha256:${'c'.repeat(64)}`,
    imageDigest: `sha256:${'2'.repeat(64)}`,
    dotnetVersion: '10.0.0',
    processId: 42,
    kestrelUrl: 'http://127.0.0.1:1'
  },
  dependencies: {
    postgres: { version: '18.0', topology: 'container:test-postgres;database:test', digest: `sha256:${'d'.repeat(64)}` },
    redis: { version: '8.0', topology: 'container:test-redis;role:master;replicas:0;cluster:0', digest: `sha256:${'e'.repeat(64)}` }
  },
  machine: { os: 'test', arch: 'arm64', cpuModel: 'fixture', logicalCpuCount: 1, memoryBytes: 1024, runtime: 'node-test' },
  fixtureDigest: `sha256:${'f'.repeat(64)}`,
  fixtureFile: '/fixture/current.json',
  redisContainer: 'test-redis'
}
const temporaryDirectories = []

function scenario(overrides = {}) {
  return {
    id: 'public-hot-read',
    subcases: ['fixed-ip', 'unique-ip'],
    requests: 4,
    concurrency: 2,
    warmupRequests: 2,
    requiredAssertions: ['fixed-ip-l0-allow', 'unique-ip-l0-allow'],
    requirements: { redisCommandsMax: 0, dbCommandsMax: 0 },
    ...overrides
  }
}

function catalog(current = scenario()) {
  return {
    schema: 'fsusblog.runtime-cache-evidence-catalog.v2',
    receiptSchema: 'fsusblog.runtime-cache-scenario-receipt.v2',
    rawEvidenceSchema: 'fsusblog.runtime-cache-raw-evidence.v2',
    scenarios: [current]
  }
}

function memory() {
  return {
    entries: 0,
    logicalBytes: 0,
    capacityBytes: 0,
    logicalBudgetBytes: 0,
    capacityBudgetBytes: 0,
    allocatedBytes: 24,
    gen0Collections: 1,
    gen1Collections: 0,
    gen2Collections: 0,
    residentBytes: 4096
  }
}

function cleanup() {
  return {
    status: 'passed',
    namespaceRemoved: true,
    activeKeyedEntries: 0,
    durableRowsBefore: 0,
    durableRowsAfter: 0,
    checkedAt: new Date().toISOString()
  }
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function startObservationServer({ redisCommands = [], redisFailureEvents = [] } = {}) {
  const observations = new Map()
  const calls = []
  let sitemapBuildCount = 0
  const relatedReadingBuilds = new Set()
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const call = {
      method: request.method,
      path: url.pathname,
      contentType: request.headers['content-type'],
      secret: request.headers['x-fsus-runtime-evidence-secret'],
      requestId: request.headers['x-fsus-runtime-evidence-request']
    }
    calls.push(call)
    if (url.pathname === '/api/binary/system/seo') {
      const body = Buffer.from('qualified-runtime-payload')
      const requestId = request.headers['x-fsus-runtime-evidence-request']
      assert.equal(request.headers['x-fsus-runtime-evidence-secret'], secret)
      observations.set(requestId, {
        requestId,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        status: 200,
        payloadDigest: sha256(body),
        layerSource: 'l0-allow',
        latencyMs: 1.5,
        allocatedBytes: 6,
        redisCommands,
        redisFailureEvents,
        cacheEvents: [],
        databaseFingerprints: [],
        databaseCommandCount: 0,
        databaseDroppedCommandCount: 0,
        databaseLateCommandCount: 0,
        databaseObservationStatus: 'complete',
        databaseAttributionComplete: true
      })
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(body)
      return
    }
    if (url.pathname === '/api/binary/article/17.aeds') {
      const body = Buffer.from('qualified-article-detail-frame')
      const requestId = request.headers['x-fsus-runtime-evidence-request']
      observations.set(requestId, {
        requestId,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        status: 200,
        payloadDigest: sha256(body),
        layerSource: 'l1-frame',
        latencyMs: 2,
        allocatedBytes: 0,
        redisCommands: [],
        redisFailureEvents: [],
        cacheEvents: [],
        databaseFingerprints: [],
        databaseCommandCount: 0,
        databaseDroppedCommandCount: 0,
        databaseLateCommandCount: 0,
        databaseObservationStatus: 'complete',
        databaseAttributionComplete: true
      })
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(body)
      return
    }
    if (url.pathname === '/api/binary/comment') {
      const requestChunks = []
      for await (const chunk of request) requestChunks.push(chunk)
      call.body = Buffer.concat(requestChunks)
      const body = Buffer.from(`qualified-${request.method.toLowerCase()}-response`)
      const requestId = request.headers['x-fsus-runtime-evidence-request']
      assert.equal(request.headers['x-fsus-runtime-evidence-secret'], secret)
      observations.set(requestId, {
        requestId,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        status: 201,
        payloadDigest: sha256(body),
        layerSource: 'database',
        latencyMs: 2.5,
        allocatedBytes: 12,
        redisCommands,
        redisFailureEvents: [],
        cacheEvents: [],
        databaseFingerprints: [],
        databaseCommandCount: 0,
        databaseDroppedCommandCount: 0,
        databaseLateCommandCount: 0,
        databaseObservationStatus: 'complete',
        databaseAttributionComplete: true
      })
      response.writeHead(201, { 'content-type': 'application/octet-stream' })
      response.end(body)
      return
    }
    const paginationMatch = /^\/api\/binary\/article\/list\/home\/(\d+)\/10\.aeds$/u.exec(url.pathname)
    if (paginationMatch) {
      const page = Number.parseInt(paginationMatch[1], 10)
      const cursor = url.searchParams.get('cursor')
      const cursorlessDeep = page > 1 && !cursor
      const body = Buffer.from(cursorlessDeep ? 'cursor-required' : `qualified-page-${page}`)
      const requestId = request.headers['x-fsus-runtime-evidence-request']
      observations.set(requestId, {
        requestId,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        status: cursorlessDeep ? 400 : 200,
        payloadDigest: sha256(body),
        layerSource: 'database',
        latencyMs: cursorlessDeep ? 0.5 : 2,
        allocatedBytes: 0,
        redisCommands: [],
        redisFailureEvents: [],
        cacheEvents: [],
        databaseFingerprints: cursorlessDeep ? [] : [sha256('pagination-keyset-select')],
        databaseCommandCount: cursorlessDeep ? 0 : 1,
        databaseDroppedCommandCount: 0,
        databaseLateCommandCount: 0,
        databaseObservationStatus: 'complete',
        databaseAttributionComplete: true
      })
      response.writeHead(cursorlessDeep ? 400 : 200, { 'content-type': 'application/octet-stream' })
      response.end(body)
      return
    }
    const relatedMatch = /^\/api\/binary\/article\/(\d+)\/related\.aeds$/u.exec(url.pathname)
    if (relatedMatch) {
      const articleId = relatedMatch[1]
      const body = Buffer.from(`qualified-related-reading-${articleId}`)
      const requestId = request.headers['x-fsus-runtime-evidence-request']
      const built = !relatedReadingBuilds.has(articleId)
      relatedReadingBuilds.add(articleId)
      observations.set(requestId, {
        requestId,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        status: 200,
        payloadDigest: sha256(body),
        layerSource: built ? 'database' : 'l1-frame',
        latencyMs: built ? 3 : 1,
        allocatedBytes: built ? 64 : 0,
        redisCommands: [],
        redisFailureEvents: [],
        cacheEvents: [{
          sequence: 1,
          elapsedMilliseconds: built ? 2 : 0.5,
          family: 'related-reading',
          identityDigest: sha256(`related-reading:${articleId}`),
          outcome: built ? 'built' : 'hit'
        }],
        databaseFingerprints: built ? [sha256('related-reading-select')] : [],
        databaseCommandCount: built ? 1 : 0,
        databaseDroppedCommandCount: 0,
        databaseLateCommandCount: 0,
        databaseObservationStatus: 'complete',
        databaseAttributionComplete: true
      })
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(body)
      return
    }
    if (url.pathname === '/sitemap.xml') {
      const body = Buffer.from('qualified-sitemap')
      const requestId = request.headers['x-fsus-runtime-evidence-request']
      const cacheHit = sitemapBuildCount > 0
      if (!cacheHit) sitemapBuildCount += 1
      observations.set(requestId, {
        requestId,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        status: 200,
        payloadDigest: sha256(body),
        layerSource: cacheHit ? 'l1-object' : 'database',
        latencyMs: cacheHit ? 1 : 4,
        allocatedBytes: cacheHit ? 0 : 64,
        redisCommands: [],
        redisFailureEvents: [],
        cacheEvents: [{
          sequence: 1,
          elapsedMilliseconds: cacheHit ? 0.5 : 3,
          family: 'sitemap',
          identityDigest: sha256('sitemap:generation:0'),
          outcome: cacheHit ? 'hit' : 'built'
        }],
        databaseFingerprints: cacheHit ? [] : [sha256('sitemap-select')],
        databaseCommandCount: cacheHit ? 0 : 1,
        databaseDroppedCommandCount: 0,
        databaseLateCommandCount: 0,
        databaseObservationStatus: 'complete',
        databaseAttributionComplete: true
      })
      response.writeHead(200, { 'content-type': 'application/xml' })
      response.end(body)
      return
    }
    if (url.pathname === '/_fsus/testing/runtime-cache/runtime-snapshot') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        capturedAt: new Date().toISOString(),
        processId: 42,
        entries: 1,
        logicalBytes: 64,
        capacityBytes: 64,
        logicalBudgetBytes: 1024,
        capacityBudgetBytes: 1024,
        totalAllocatedBytes: 128,
        gen0Collections: 0,
        gen1Collections: 0,
        gen2Collections: 0,
        residentBytes: 4096,
        activeKeyedEntries: 0,
        sitemap: {
          generation: 0,
          artifactCount: sitemapBuildCount,
          residentBytes: sitemapBuildCount * 64,
          buildCount: sitemapBuildCount
        },
        policies: []
      }))
      return
    }
    const match = /^\/_fsus\/testing\/runtime-cache\/observations\/([^/]+)$/u.exec(url.pathname)
    if (match) {
      assert.equal(request.headers['x-fsus-runtime-evidence-secret'], secret)
      const requestId = decodeURIComponent(match[1])
      const observation = observations.get(requestId)
      if (!observation) {
        response.writeHead(404).end()
        return
      }
      observations.delete(requestId)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(observation))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

test.after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
})

test('request collector binds response bytes to the authenticated server observation', async () => {
  const runtime = await startObservationServer({
    redisFailureEvents: [{ sequence: 1, elapsedMilliseconds: 1.25, operationClass: 'ContentCacheRead', failureKind: 'ConnectionUnavailable', failAction: 'bounded-origin-gate' }]
  })
  try {
    const request = await collectObservedRequest({
      baseUrl: runtime.baseUrl,
      secret,
      scenarioId: 'public-hot-read',
      ordinal: 1,
      spec: { method: 'GET', path: '/api/binary/system/seo', subcaseId: 'fixed-ip', parityGroup: 'fixed-ip', headers: {} }
    })
    assert.equal(request.layerSource, 'l0-allow')
    assert.equal(request.payloadDigest, sha256(Buffer.from('qualified-runtime-payload')))
    assert.deepEqual(request.redisCommands, [])
    assert.deepEqual(request.redisFailureEvents, [{
      sequence: 1,
      elapsedMilliseconds: 1.25,
      operationClass: 'ContentCacheRead',
      failureKind: 'ConnectionUnavailable',
      failAction: 'bounded-origin-gate',
      source: 'redis-operation-executor'
    }])
    assert.deepEqual(request.dbCommands, [])
    assert.equal(runtime.calls.length, 2)
  } finally {
    await runtime.close()
  }
})

test('request collector sends POST and PUT bodies to the spec secondary base URL', async () => {
  const primaryRuntime = await startObservationServer()
  const secondaryRuntime = await startObservationServer()
  try {
    const postBody = Buffer.from([0, 1, 2, 255])
    const post = await collectObservedRequest({
      baseUrl: primaryRuntime.baseUrl,
      secret,
      scenarioId: 'distributed-invalidation',
      ordinal: 1,
      spec: {
        baseUrl: secondaryRuntime.baseUrl,
        method: 'POST',
        path: '/api/binary/comment',
        body: postBody,
        contentType: 'application/octet-stream',
        subcaseId: 'comment-mutation',
        parityGroup: 'comment-mutation',
        headers: {}
      }
    })
    const putBody = '{"state":"approved"}'
    const put = await collectObservedRequest({
      baseUrl: primaryRuntime.baseUrl,
      secret,
      scenarioId: 'distributed-invalidation',
      ordinal: 2,
      spec: {
        baseUrl: secondaryRuntime.baseUrl,
        method: 'PUT',
        path: '/api/binary/comment',
        body: putBody,
        contentType: 'application/json; charset=utf-8',
        subcaseId: 'comment-mutation',
        parityGroup: 'comment-mutation',
        headers: {}
      }
    })

    assert.equal(primaryRuntime.calls.length, 0)
    assert.equal(secondaryRuntime.calls.length, 4)
    assert.deepEqual(secondaryRuntime.calls[0].body, postBody)
    assert.equal(secondaryRuntime.calls[0].contentType, 'application/octet-stream')
    assert.equal(secondaryRuntime.calls[2].body.toString('utf8'), putBody)
    assert.equal(secondaryRuntime.calls[2].contentType, 'application/json; charset=utf-8')
    assert.deepEqual({ method: post.method, path: post.path, status: post.status, payloadDigest: post.payloadDigest }, {
      method: 'POST',
      path: '/api/binary/comment',
      status: 201,
      payloadDigest: sha256(Buffer.from('qualified-post-response'))
    })
    assert.deepEqual({ method: put.method, path: put.path, status: put.status, payloadDigest: put.payloadDigest }, {
      method: 'PUT',
      path: '/api/binary/comment',
      status: 201,
      payloadDigest: sha256(Buffer.from('qualified-put-response'))
    })
    assert.equal(JSON.stringify([post, put]).includes(secret), false)
  } finally {
    await Promise.all([primaryRuntime.close(), secondaryRuntime.close()])
  }
})

test('public hot-read producer emits a checker-valid receipt from real HTTP observations', async () => {
  const runtime = await startObservationServer()
  const directory = temporaryDirectory('runtime-cache-producer-pass-')
  const outputFile = path.join(directory, '.tmp/perf/runtime-cache/receipts/public-hot-read.json')
  const currentCatalog = catalog()
  try {
    const receipt = await producePublicHotReadReceipt({
      repositoryRoot: directory,
      catalog: currentCatalog,
      scenario: currentCatalog.scenarios[0],
      identity: { ...identity, runtime: { ...identity.runtime, kestrelUrl: runtime.baseUrl } },
      baseUrl: runtime.baseUrl,
      secret,
      outputFile,
      collectMemory: async () => memory(),
      collectCleanup: async () => cleanup(),
      captureSource: () => source,
      runId: 'producer-pass',
      attemptNumber: 1
    })
    assert.equal(receipt.status, 'passed')
    assert.equal(receipt.requests.length, 4)
    assert.equal(runtime.calls.length, 12)
    assert.deepEqual(validateRuntimeCacheReceipt(receipt, { catalog: currentCatalog, expectedSource: source, repositoryRoot: directory }), [])
    assert.ok(runtime.calls.every((call) => call.secret === secret))
    assert.equal(JSON.stringify(receipt).includes(secret), false)
  } finally {
    await runtime.close()
  }
})

test('article detail L1 handler proves zero commands while real Redis is paused', async () => {
  const runtime = await startObservationServer()
  const directory = temporaryDirectory('runtime-cache-article-l1-')
  const fixtureFile = path.join(directory, 'public-projection.json')
  writeFileSync(fixtureFile, JSON.stringify({
    articleId: '17',
    entities: [{ producerId: 'public-content', kind: 'article', id: '17' }]
  }))
  const currentScenario = scenario({
    id: 'article-detail-l1',
    subcases: ['l1-hit', 'redis-fault'],
    requests: 4,
    concurrency: 2,
    warmupRequests: 2,
    requiredAssertions: ['l1-zero-commands', 'redis-fault-latency'],
    requirements: { redisCommandsMax: 0, dbCommandsMax: 0, redisFaultLatencyRatioMax: 1.25 }
  })
  const currentCatalog = catalog(currentScenario)
  let pauseMs = 0
  try {
    const receipt = await produceArticleDetailL1Receipt({
      repositoryRoot: directory,
      catalog: currentCatalog,
      scenario: currentScenario,
      identity: {
        ...identity,
        fixtureFile,
        runtime: { ...identity.runtime, kestrelUrl: runtime.baseUrl }
      },
      baseUrl: runtime.baseUrl,
      secret,
      outputFile: path.join(directory, '.tmp/perf/runtime-cache/receipts/article-detail-l1.json'),
      collectMemory: async () => memory(),
      collectCleanup: async () => cleanup(),
      captureSource: () => source,
      injectRedisPause: async (value) => { pauseMs = value },
      runId: 'article-l1-pass',
      attemptNumber: 1
    })
    assert.equal(pauseMs, 500)
    assert.equal(receipt.status, 'passed')
    assert.deepEqual(validateRuntimeCacheReceipt(receipt, {
      catalog: currentCatalog,
      expectedSource: source,
      repositoryRoot: directory
    }), [])
  } finally {
    await runtime.close()
  }
})

test('sitemap handler binds one warmup build and a 100-request L1 generation window', async () => {
  const runtime = await startObservationServer()
  const directory = temporaryDirectory('runtime-cache-sitemap-')
  const currentScenario = scenario({
    id: 'sitemap',
    subcases: ['same-generation-100', 'l1-hit'],
    requests: 101,
    concurrency: 32,
    warmupRequests: 8,
    requiredAssertions: ['l1-zero-commands', 'same-generation-build', 'rebuild-count'],
    requirements: { redisCommandsMaxBySubcase: { 'l1-hit': 0 }, dbCommandsMaxBySubcase: { 'l1-hit': 0 }, rebuildCountBySubcase: { 'same-generation-100': 1 } }
  })
  const currentCatalog = catalog(currentScenario)
  try {
    const receipt = await produceSitemapReceipt({
      repositoryRoot: directory,
      catalog: currentCatalog,
      scenario: currentScenario,
      identity: { ...identity, runtime: { ...identity.runtime, kestrelUrl: runtime.baseUrl } },
      baseUrl: runtime.baseUrl,
      secret,
      outputFile: path.join(directory, '.tmp/perf/runtime-cache/receipts/sitemap.json'),
      collectMemory: async () => memory(),
      collectCleanup: async () => cleanup(),
      captureSource: () => source,
      runId: 'sitemap-pass',
      attemptNumber: 1
    })
    assert.equal(receipt.status, 'passed')
    assert.equal(receipt.requests.length, 101)
    assert.equal(receipt.requests.filter((request) => request.layerSource === 'database').length, 1)
    assert.equal(receipt.requests.at(-1).layerSource, 'l1-object')
    assert.deepEqual(receipt.assertions.find((assertion) => assertion.id === 'rebuild-count').actual, { 'same-generation-100': 1 })
    assert.deepEqual(validateRuntimeCacheReceipt(receipt, {
      catalog: currentCatalog,
      expectedSource: source,
      repositoryRoot: directory
    }), [])
  } finally {
    await runtime.close()
  }
})

test('related-reading handler derives one burst rebuild from request cache events', async () => {
  const runtime = await startObservationServer()
  const directory = temporaryDirectory('runtime-cache-related-reading-')
  const fixtureFile = path.join(directory, 'public-projection.json')
  writeFileSync(fixtureFile, JSON.stringify({
    entities: [
      { producerId: 'public-content', kind: 'article', id: '17' },
      { producerId: 'public-content', kind: 'article', id: '18' }
    ]
  }))
  const currentScenario = scenario({
    id: 'related-reading',
    subcases: ['cold', 'same-key-100', 'hot'],
    requests: 102,
    concurrency: 100,
    warmupRequests: 1,
    requiredAssertions: ['cold-db-budget', 'same-key-build', 'rebuild-count', 'hot-direct-frame'],
    requirements: { coldDbCommandsMax: 2, rebuildCountBySubcase: { 'same-key-100': 1 }, hotLayer: 'l1-frame' }
  })
  const currentCatalog = catalog(currentScenario)
  try {
    const receipt = await produceRelatedReadingReceipt({
      repositoryRoot: directory,
      catalog: currentCatalog,
      scenario: currentScenario,
      identity: { ...identity, fixtureFile, runtime: { ...identity.runtime, kestrelUrl: runtime.baseUrl } },
      baseUrl: runtime.baseUrl,
      secret,
      outputFile: path.join(directory, '.tmp/perf/runtime-cache/receipts/related-reading.json'),
      collectMemory: async () => memory(),
      collectCleanup: async () => cleanup(),
      captureSource: () => source,
      runId: 'related-reading-pass',
      attemptNumber: 1
    })
    assert.equal(receipt.status, 'passed')
    assert.equal(receipt.requests.length, 102)
    assert.deepEqual(receipt.assertions.find((assertion) => assertion.id === 'rebuild-count').actual, { 'same-key-100': 1 })
    assert.deepEqual(validateRuntimeCacheReceipt(receipt, {
      catalog: currentCatalog,
      expectedSource: source,
      repositoryRoot: directory
    }), [])
  } finally {
    await runtime.close()
  }
})

test('pagination handler uses production cursors and rejects cursorless deep reads without commands', async () => {
  const runtime = await startObservationServer()
  const directory = temporaryDirectory('runtime-cache-pagination-')
  const fixtureFile = path.join(directory, 'public-projection.json')
  writeFileSync(fixtureFile, JSON.stringify({
    pagination: {
      route: 'article/list/home',
      sort: 'latest',
      pageSize: 10,
      generation: 47,
      articleCount: 10023,
      ownedArticleCount: 10020,
      cursors: [
        { logicalPage: 10, cursor: 'opaque-page-10' },
        { logicalPage: 100, cursor: 'opaque-page-100' },
        { logicalPage: 1000, cursor: 'opaque-page-1000' }
      ]
    }
  }))
  const currentScenario = scenario({
    id: 'pagination',
    subcases: ['page-1', 'page-10', 'page-100', 'page-1000', 'cursorless-deep'],
    requests: 8,
    concurrency: 1,
    warmupRequests: 4,
    requiredAssertions: ['logical-page-command-constant', 'cursorless-deep-zero-commands'],
    requirements: { logicalPages: [1, 10, 100, 1000], constantDbCommands: true, cursorlessDeepRedisCommandsMax: 0, cursorlessDeepDbCommandsMax: 0 }
  })
  const currentCatalog = catalog(currentScenario)
  try {
    const receipt = await producePaginationReceipt({
      repositoryRoot: directory,
      catalog: currentCatalog,
      scenario: currentScenario,
      identity: { ...identity, fixtureFile, runtime: { ...identity.runtime, kestrelUrl: runtime.baseUrl } },
      baseUrl: runtime.baseUrl,
      secret,
      outputFile: path.join(directory, '.tmp/perf/runtime-cache/receipts/pagination.json'),
      collectMemory: async () => memory(),
      collectCleanup: async () => cleanup(),
      captureSource: () => source,
      runId: 'pagination-pass',
      attemptNumber: 1
    })
    assert.equal(receipt.status, 'passed')
    assert.equal(receipt.requests.length, 8)
    assert.ok(receipt.requests.slice(0, 4).every((request) => request.status === 200))
    assert.ok(receipt.requests.slice(4).every((request) => request.status === 400))
    assert.deepEqual(receipt.assertions.map((assertion) => assertion.status), ['passed', 'passed'])
    assert.deepEqual(validateRuntimeCacheReceipt(receipt, {
      catalog: currentCatalog,
      expectedSource: source,
      repositoryRoot: directory
    }), [])
  } finally {
    await runtime.close()
  }
})

test('first command-budget failure remains authoritative after a later clean run', async () => {
  const directory = temporaryDirectory('runtime-cache-producer-first-failure-')
  const outputFile = path.join(directory, '.tmp/perf/runtime-cache/receipts/public-hot-read.json')
  const currentCatalog = catalog()
  const failingRuntime = await startObservationServer({ redisCommands: ['GET'] })
  try {
    await assert.rejects(() => producePublicHotReadReceipt({
      repositoryRoot: directory,
      catalog: currentCatalog,
      scenario: currentCatalog.scenarios[0],
      identity: { ...identity, runtime: { ...identity.runtime, kestrelUrl: failingRuntime.baseUrl } },
      baseUrl: failingRuntime.baseUrl,
      secret,
      outputFile,
      collectMemory: async () => memory(),
      collectCleanup: async () => cleanup(),
      captureSource: () => source,
      runId: 'producer-failure',
      attemptNumber: 1
    }), /l0-allow failed/u)
  } finally {
    await failingRuntime.close()
  }

  const first = JSON.parse(readFileSync(outputFile, 'utf8'))
  assert.equal(first.status, 'failed')
  assert.equal(first.firstFailure.assertionId, 'fixed-ip-l0-allow')
  assert.match(first.firstFailure.rawEvidenceDigest, /^sha256:[a-f0-9]{64}$/u)
  const preservedFailure = JSON.parse(readFileSync(path.join(path.dirname(outputFile), 'first-failure.json'), 'utf8'))
  assert.deepEqual(first.firstFailure, preservedFailure)

  const passingRuntime = await startObservationServer()
  try {
    await assert.rejects(() => producePublicHotReadReceipt({
      repositoryRoot: directory,
      catalog: currentCatalog,
      scenario: currentCatalog.scenarios[0],
      identity: { ...identity, runtime: { ...identity.runtime, kestrelUrl: passingRuntime.baseUrl } },
      baseUrl: passingRuntime.baseUrl,
      secret,
      outputFile,
      collectMemory: async () => memory(),
      collectCleanup: async () => cleanup(),
      captureSource: () => source,
      runId: 'producer-failure',
      attemptNumber: 1
    }), /attempt evidence already exists/u)
  } finally {
    await passingRuntime.close()
  }
  const unchanged = JSON.parse(readFileSync(outputFile, 'utf8'))
  assert.deepEqual(unchanged, first)
  assert.deepEqual(JSON.parse(readFileSync(path.join(path.dirname(outputFile), 'first-failure.json'), 'utf8')), preservedFailure)
})

test('catalog scenarios without a runtime handler fail and retain a producer firstFailure artifact', async () => {
  assert.deepEqual(implementedRuntimeCacheScenarios, loadRuntimeCacheCatalog().scenarios.map((item) => item.id))
  const directory = temporaryDirectory('runtime-cache-producer-dispatch-')
  const absent = scenario({ id: 'future-scenario', subcases: ['probe'], requiredAssertions: ['probe-present'], requirements: {}, requests: 1, warmupRequests: 0, concurrency: 1 })
  const result = await runRuntimeCacheProducer({
    repositoryRoot: directory,
    outputDirectory: directory,
    catalog: catalog(absent),
    scenarioIds: ['future-scenario'],
    source,
    identity,
    baseUrl: 'http://127.0.0.1:7568',
    secret
  })
  assert.equal(result.status, 'failed')
  assert.match(result.results[0].error, /handler is absent/u)
  const failure = JSON.parse(readFileSync(path.join(directory, 'failures/future-scenario.producer-failure.json'), 'utf8'))
  assert.equal(failure.status, 'failed')
  assert.equal(failure.firstFailure.stage, 'dispatch')
  assert.match(failure.firstFailure.message, /future-scenario/u)
  assert.equal(path.join(directory, 'receipts/future-scenario.json') === result.results[0].outputFile, true)
})
