import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { produceHotFeaturedFrameReceipt } from '../../tools/test/runtime-cache-scenarios/hot-featured-frame.mjs'

const identityDigest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function scenario() {
  return {
    id: 'hot-featured-frame',
    subcases: ['hot', 'featured', 'atomic-publication'],
    requests: 4,
    concurrency: 2,
    warmupRequests: 0,
    requiredAssertions: ['same-identity-build', 'rebuild-count', 'db-command-budget', 'atomic-redis-publication'],
    requirements: {
      rebuildCountBySubcase: { hot: 1, featured: 1 },
      dbCommandsMaxPerIdentity: 1,
      atomicRedisPublication: true
    }
  }
}

function observedRequest(spec, index, includePublication = true) {
  const kind = spec.subcaseId
  const builder = index === 0 || index === 2
  const digest = identityDigest(`${kind}-identity`)
  return {
    id: `request-${index + 1}`,
    subcaseId: kind,
    method: 'GET',
    path: spec.path,
    status: 200,
    payloadDigest: identityDigest(`${kind}-frame`),
    parityGroup: spec.parityGroup,
    layerSource: builder ? 'database' : 'l1-frame',
    latencyMs: builder ? 5 : 1,
    allocatedBytes: builder ? 64 : 0,
    redisCommands: builder
      ? [
          { verb: 'SET', category: 'write', source: 'stackexchange-redis-profiler' },
          { verb: 'EVALSHA', category: 'atomic-script', source: 'stackexchange-redis-profiler' }
        ]
      : [],
    redisFailureEvents: [],
    cacheEvents: builder
      ? [
          { sequence: 1, elapsedMilliseconds: 1, family: 'cache-miss-singleflight', identityDigest: identityDigest(`policy:${kind}-identity`), outcome: 'built', source: 'runtime-cache-evidence-observation' },
          ...(includePublication
            ? [{ sequence: 2, elapsedMilliseconds: 4, family: `article-${kind}-frame`, identityDigest: digest, outcome: 'published', source: 'runtime-cache-evidence-observation' }]
            : [])
        ]
      : [{ sequence: 1, elapsedMilliseconds: 1, family: `article-${kind}-frame`, identityDigest: digest, outcome: 'hit', source: 'runtime-cache-evidence-observation' }],
    dbCommands: builder
      ? [{ fingerprint: identityDigest(`${kind}-select`), source: 'npgsql-interceptor' }]
      : []
  }
}

async function execute(includePublication = true) {
  const specs = []
  const fakeProducer = async (_options, plan) => {
    assert.deepEqual(await plan.warmup({}), [])
    return plan.sample({
      runId: 'qualified-run',
      collect: async (spec, index) => {
        specs.push(spec)
        return observedRequest(spec, index, includePublication)
      }
    })
  }
  const result = await produceHotFeaturedFrameReceipt({
    scenario: scenario(),
    adminHeaders: { Authorization: 'Bearer test-admin-token' },
    produceMeasuredScenarioReceipt: fakeProducer
  })
  return { result, specs }
}

test('hot-featured-frame targets only real admin whole-frame routes and proves both atomic cold builds', async () => {
  const { result, specs } = await execute()

  assert.equal(specs.length, 4)
  assert.ok(specs.slice(0, 2).every((spec) => spec.path === '/api/binary/admin/article/hot?size=49'))
  assert.ok(specs.slice(2).every((spec) => spec.path === '/api/binary/admin/article/featured?size=9'))
  assert.ok(specs.every((spec) => spec.headers.Authorization === 'Bearer test-admin-token'))
  assert.deepEqual(result.assertionResults.map(({ assertion }) => [assertion.id, assertion.status]), [
    ['same-identity-build', 'passed'],
    ['rebuild-count', 'passed'],
    ['db-command-budget', 'passed'],
    ['atomic-redis-publication', 'passed']
  ])
  assert.deepEqual(result.parameters.observedDatabaseCommands, { hot: 1, featured: 1 })
})

test('hot-featured-frame does not infer atomic publication from an EVAL command without publication evidence', async () => {
  const { result } = await execute(false)
  const atomic = result.assertionResults.find(({ assertion }) => assertion.id === 'atomic-redis-publication').assertion

  assert.equal(atomic.status, 'failed')
  assert.deepEqual(atomic.actual, {
    hotPublicationCount: 0,
    featuredPublicationCount: 0,
    hotAtomicPublisherCount: 0,
    featuredAtomicPublisherCount: 0
  })
})

test('hot-featured-frame rejects non-admin credential headers', async () => {
  await assert.rejects(
    produceHotFeaturedFrameReceipt({
      scenario: scenario(),
      adminHeaders: { 'X-Fsus-Device-Fp': 'anonymous' },
      produceMeasuredScenarioReceipt: async () => {
        throw new Error('must not run')
      }
    }),
    /exactly one Authorization or Cookie admin header/u)
})
