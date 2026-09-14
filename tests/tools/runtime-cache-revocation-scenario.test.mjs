import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inspectRevocationRequest,
  runRevocationSample
} from '../../tools/test/runtime-cache-scenarios/revocation.mjs'

const sizes = [1, 10, 100, 1000, 10000, 100000]

function scenario() {
  return {
    id: 'revocation',
    subcases: sizes.map((size) => `size-${size}`),
    requests: 18,
    concurrency: 1,
    warmupRequests: 4,
    requiredAssertions: ['lookup-growth-constant', 'classification-count'],
    requirements: { sizes, classificationCount: 1, lookupGrowth: 'constant' }
  }
}

function authority(count) {
  return {
    requestedCount: count,
    registrySeededCount: count,
    redisHashLengthBefore: 7,
    redisHashLengthAfter: 7 + count,
    redisHashLengthDelta: count,
    maximumGeneration: Math.max(count, 1)
  }
}

function observedRequest(spec, ordinal, lookupMilliseconds = 0.2) {
  const identityDigest = `sha256:${'a'.repeat(64)}`
  return {
    id: `revocation-request-${ordinal + 1}`,
    subcaseId: spec.subcaseId,
    status: 503,
    layerSource: 'l1-frame',
    redisCommands: [],
    redisFailureEvents: [],
    dbCommands: [],
    latencyMs: 1,
    allocatedBytes: 0,
    cacheEvents: [
      {
        sequence: 1,
        elapsedMilliseconds: 0.1,
        family: 'public-hot-read-classification',
        identityDigest,
        outcome: 'hit',
        source: 'runtime-cache-evidence-observation'
      },
      {
        sequence: 2,
        elapsedMilliseconds: 0.1 + lookupMilliseconds,
        family: 'public-artifact-revocation-lookup',
        identityDigest,
        outcome: 'negative',
        source: 'runtime-cache-evidence-observation'
      }
    ]
  }
}

test('Revocation handler executes 1..100000 authority sizes including all required large cases', async () => {
  const prepared = []
  const result = await runRevocationSample({
    scenario: scenario(),
    runId: 'revocation-run',
    articleId: 42,
    prepare: async (count) => {
      prepared.push(count)
      return authority(count)
    },
    collect: async (spec, ordinal) => observedRequest(spec, ordinal)
  })

  assert.deepEqual(prepared, [...sizes, 0])
  assert.equal(result.requests.length, 18)
  assert.deepEqual(result.assertionResults.map((item) => item.assertion.status), ['passed', 'passed'])
  assert.deepEqual(result.assertionResults[0].assertion.actual.authoritativeSizes, sizes)
  assert.equal(result.assertionResults[1].assertion.actual, 1)
  assert.deepEqual(Object.keys(result.parameters.authorityBySize).map(Number), sizes)
})

test('Revocation classification is derived from cache events, never HTTP status', () => {
  const request = observedRequest({ subcaseId: 'size-100000' }, 0)
  request.status = 418
  assert.deepEqual(inspectRevocationRequest(request), { classificationCount: 1, lookupMilliseconds: 0.20000000000000004 })

  request.cacheEvents.push({ ...request.cacheEvents[0], sequence: 3 })
  assert.throws(() => inspectRevocationRequest(request), /exactly one public hot classification/u)
})

test('Revocation handler fails the constant lookup assertion on large-N event growth', async () => {
  const result = await runRevocationSample({
    scenario: scenario(),
    runId: 'revocation-growth-failure',
    articleId: 42,
    prepare: async (count) => authority(count),
    collect: async (spec, ordinal) => {
      const size = Number(spec.subcaseId.slice('size-'.length))
      return observedRequest(spec, ordinal, size === 100000 ? 10 : 0.2)
    }
  })

  assert.equal(result.assertionResults[0].assertion.status, 'failed')
  assert.equal(result.assertionResults[0].assertion.actual.constant, false)
  assert.equal(result.assertionResults[1].assertion.status, 'passed')
})
