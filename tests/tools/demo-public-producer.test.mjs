import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanupDemoPublic,
  prepareDemoPublic,
  verifyDemoPublic
} from '../../tools/test-fixtures/producers/demo-public-producer.mjs'
import { plan } from '../../tools/test-fixtures/orchestrator.mjs'
import { buildProducerReceipt } from '../../tools/test-fixtures/receipt/index.mjs'
import { buildProducerFixtureVariantPlan } from '../../tools/testing/fixture-catalog.mjs'

const variantId = 'diagnostic.development.demo.dataset'
const owner = 'demo-fixture:0123456789abcdef01234567'
const exactEntities = [
  { kind: 'user', id: '101', handle: 'demo-reader-0123456789abcdef01234567' },
  { kind: 'admin-principal', id: '201', handle: 'demo-admin-0123456789abcdef01234567' },
  { kind: 'category', id: '301' },
  { kind: 'category', id: '302' },
  { kind: 'tag', id: '401' },
  { kind: 'tag', id: '402' },
  { kind: 'tag', id: '403' },
  { kind: 'tag', id: '404' },
  { kind: 'article', id: '501' },
  { kind: 'article', id: '502' },
  { kind: 'article', id: '503' },
  { kind: 'article-revision', id: '601' },
  { kind: 'article-publication', id: '701' },
  { kind: 'comment', id: '801' },
  { kind: 'comment', id: '802' },
  { kind: 'comment-moderation-event', id: '851' },
  { kind: 'comment-moderation-event', id: '852' },
  { kind: 'audit-event', id: '901' },
  { kind: 'audit-event', id: '902' }
].map((item, index) => ({
  ...item,
  variantId,
  owner,
  digest: `sha256:${index.toString(16).padStart(64, '0')}`
}))

function previousProducerReceipt() {
  const planned = plan(
    { profileId: 'demo-public', profileSource: 'dev-cli', executionClass: 'development' },
    { runId: 'same-run', namespace: 'same-namespace' }
  )
  const spec = planned.producerSpecs.find((item) => item.id === 'development-demo')
  const producerVariantPlan = buildProducerFixtureVariantPlan({
    producerId: 'development-demo',
    variantIds: planned.variantIds,
    fixtureVariantIds: planned.variantIds,
    fixtureVariantPlanDigest: planned.variantPlanDigest
  })
  return {
    planned,
    receipt: buildProducerReceipt({
      producerId: 'development-demo',
      strategy: spec.strategy,
      runId: 'same-run',
      namespace: 'same-namespace',
      fixtureCatalogDigest: planned.catalogDigest,
      profileId: 'demo-public',
      expandedCapabilityDigest: planned.expandedCapabilityDigest,
      fixtureVariantIds: planned.variantIds,
      variantPlanDigest: planned.variantPlanDigest,
      producerVariantPlanDigest: producerVariantPlan.producerVariantPlanDigest,
      producedVariantIds: planned.variantIds,
      providedCapabilities: ['development.demo.dataset'],
      ownedStateDomains: spec.stateDomains,
      entityIdentities: exactEntities,
      cleanupContract: { kind: 'receipt-exact-identities' }
    })
  }
}

test('cleanup sends only verified receipt identities to the protected composition root', async () => {
  const original = globalThis.fetch
  let request
  globalThis.fetch = async (url, init) => {
    request = { url, init }
    return new Response(null, { status: 204 })
  }
  try {
    await cleanupDemoPublic({ handles: { baseUrl: 'http://127.0.0.1:7568', localDemoFixtureSecret: 'test-secret' } }, { entityIdentities: exactEntities })
    assert.equal(request.url, 'http://127.0.0.1:7568/api/local/demo-fixture/cleanup')
    assert.deepEqual(JSON.parse(request.init.body).entityIdentities, exactEntities)
    assert.match(request.init.headers['X-Fsus-Test-Session'], /^demo-[0-9a-f]{24}$/u)
  } finally { globalThis.fetch = original }
})

test('verification rejects altered demo-admin state and stale cache observations', async () => {
  const base = {
    observations: { database: { entities: exactEntities.map((item) => ({ ...item, owned: true })) }, cache: { entries: [{ matchesDb: true }] } },
    entityIdentities: exactEntities
  }
  const altered = await verifyDemoPublic({}, base)
  assert.equal(altered.ok, true)
  const missingAdmin = structuredClone(base)
  missingAdmin.observations.database.entities = missingAdmin.observations.database.entities.filter((item) => item.kind !== 'admin-principal')
  assert.equal((await verifyDemoPublic({}, missingAdmin)).ok, false)
  const stale = structuredClone(base)
  stale.observations.cache.entries[0].matchesDb = false
  assert.equal((await verifyDemoPublic({}, stale)).ok, false)
  const wrongVariant = structuredClone(base)
  wrongVariant.observations.database.entities[0].variantId = 'diagnostic.development.demo.user'
  assert.equal((await verifyDemoPublic({}, wrongVariant)).ok, false)
})

test('cleanup refuses an identity set that lost its exact owner or catalog variant', async () => {
  const missingOwner = structuredClone(exactEntities)
  delete missingOwner[0].owner
  await assert.rejects(
    cleanupDemoPublic(
      { handles: { baseUrl: 'http://127.0.0.1:7568', localDemoFixtureSecret: 'test-secret' } },
      { entityIdentities: missingOwner }),
    /one exact owner and catalog variant/
  )
})

test('prepare cleans the same-run sealed ProducerReceipt before creating the replacement dataset', async () => {
  const { planned, receipt } = previousProducerReceipt()
  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (url.endsWith('/cleanup')) return new Response(null, { status: 204 })
    return Response.json({
      entityIdentities: exactEntities,
      observations: {
        source: 'service',
        database: {
          namespace: 'same-namespace',
          schemaIdentity: 'public',
          entities: exactEntities.map((item) => ({ ...item, owned: true }))
        },
        redis: { namespace: 'same-namespace', keys: [] },
        cache: { namespace: 'same-namespace', entries: [] }
      }
    })
  }
  try {
    const result = await prepareDemoPublic({
      plan: planned,
      profileIdentity: planned.profileIdentity,
      runIdentity: 'same-run',
      namespace: 'same-namespace',
      previousProducerReceipt: receipt,
      handles: {
        baseUrl: 'http://127.0.0.1:7568',
        localDemoFixtureSecret: 'test-secret'
      }
    })

    assert.deepEqual(
      requests.map((item) => item.url),
      [
        'http://127.0.0.1:7568/api/local/demo-fixture/cleanup',
        'http://127.0.0.1:7568/api/local/demo-fixture/prepare'
      ]
    )
    assert.deepEqual(
      JSON.parse(requests[0].init.body).entityIdentities,
      receipt.entityIdentities
    )
    assert.equal(
      requests[0].init.headers['X-Fsus-Test-Session'],
      requests[1].init.headers['X-Fsus-Test-Session']
    )
    assert.match(requests[1].init.headers['X-Fsus-Test-Session'], /^demo-[0-9a-f]{24}$/u)
    assert.equal(requests[1].init.headers['X-Fsus-Test-Namespace'], undefined)
    assert.equal(requests[1].init.headers['X-Fsus-Test-Run-Id'], undefined)
    assert.equal(result.entityIdentities[0].digest?.startsWith('sha256:'), true)
  } finally {
    globalThis.fetch = original
  }
})

test('prepare rejects a cross-run or tampered prior ProducerReceipt before any request', async () => {
  const { planned, receipt } = previousProducerReceipt()
  let requests = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    requests += 1
    throw new Error('must not fetch')
  }
  try {
    await assert.rejects(
      prepareDemoPublic({
        plan: planned,
        profileIdentity: planned.profileIdentity,
        runIdentity: 'different-run',
        namespace: 'same-namespace',
        previousProducerReceipt: receipt,
        handles: {
          baseUrl: 'http://127.0.0.1:7568',
          localDemoFixtureSecret: 'test-secret'
        }
      }),
      /exact run\/profile\/catalog/
    )
    const tampered = structuredClone(receipt)
    tampered.entityIdentities[0].id = '999'
    await assert.rejects(
      prepareDemoPublic({
        plan: planned,
        profileIdentity: planned.profileIdentity,
        runIdentity: 'same-run',
        namespace: 'same-namespace',
        previousProducerReceipt: tampered,
        handles: {
          baseUrl: 'http://127.0.0.1:7568',
          localDemoFixtureSecret: 'test-secret'
        }
      }),
      /digest mismatch/
    )
    assert.equal(requests, 0)
  } finally {
    globalThis.fetch = original
  }
})
