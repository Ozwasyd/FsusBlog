import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPublicContentPlan,
  preparePublicContent,
  verifyPublicContent
} from '../../tools/test-fixtures/producers/public-content-producer.mjs'
import { createPublicContentPort } from '../../tools/test-fixtures/producers/catalog-ports.mjs'
import {
  plan,
  prepare,
  verify
} from '../../tools/test-fixtures/orchestrator.mjs'
import {
  buildFixtureVariantPlan,
  buildProducerFixtureVariantPlan,
  readFixtureCatalogs,
  resolveFixtureVariants
} from '../../tools/testing/fixture-catalog.mjs'
import {
  runPostcondition,
  assertPostconditionRegistryComplete
} from '../../tools/test-fixtures/receipt/postconditions.mjs'

const catalogs = readFixtureCatalogs()

function producerVariantContext(capabilities) {
  const ids = resolveFixtureVariants(capabilities, 'runtime', catalogs)
  const typed = buildFixtureVariantPlan(ids, catalogs)
  const variantPlan = buildProducerFixtureVariantPlan({
    producerId: 'public-content',
    variantIds: typed.byProducer
      .find((item) => item.producerId === 'public-content')?.variants.map((item) => item.id) ?? [],
    fixtureVariantIds: typed.variants.map((item) => item.id),
    fixtureVariantPlanDigest: typed.variantPlanDigest,
    catalogs
  })
  return {
    variantPlan,
    catalogs
  }
}

function minimalObservations({ empty = false } = {}) {
  if (empty) {
    return {
      source: 'service',
      database: { namespace: 'ns', schemaIdentity: 'public', entities: [] },
      redis: {
        namespace: 'ns',
        keys: [
          { domain: 'redis.cache.public', key: 'blog:top_articles', present: false },
          { domain: 'redis.cache.public', key: 'featured-hot', present: false }
        ]
      },
      cache: {
        namespace: 'ns',
        generation: 0,
        entries: [{ domain: 'home', endpoint: 'article/list/home', matchesDb: true, visibleEntityIds: [] }]
      }
    }
  }

  return {
    source: 'service',
    database: {
      namespace: 'ns',
      schemaIdentity: 'public',
      entities: [
        { kind: 'category', id: '11', capabilityHint: 'taxonomy-category-tag', fields: { name: 'fxpc:ns:run:category' } },
        { kind: 'tag', id: '22', capabilityHint: 'taxonomy-category-tag', fields: { name: 'fxpc:ns:run:tag' } },
        {
          kind: 'article',
          id: '101',
          capabilityHint: 'article-published',
          projection: 'featured-hot',
          fields: {
            status: 'published',
            deleted: false,
            currentPublicationId: '501',
            currentRevisionId: '601',
            revisionIds: ['601', '602'],
            publicDetailReadable: true,
            featured: true,
            hot: true,
            views: 42,
            coverImageUrl: '/fixtures/acceptance-cover-primary.svg',
            hasCover: true,
            title: 'fxpc:ns:run:published:primary'
          }
        },
        {
          kind: 'article',
          id: '102',
          capabilityHint: 'article-published',
          projection: 'featured-hot',
          fields: {
            status: 'published',
            deleted: false,
            currentPublicationId: '502',
            currentRevisionId: '603',
            revisionIds: ['603'],
            publicDetailReadable: true,
            featured: true,
            hot: true,
            views: 30,
            coverImageUrl: '/fixtures/acceptance-cover-focus.svg',
            hasCover: true
          }
        },
        {
          kind: 'article',
          id: '103',
          capabilityHint: 'article-published',
          projection: 'featured-hot',
          fields: {
            status: 'published',
            deleted: false,
            currentPublicationId: '503',
            currentRevisionId: '604',
            revisionIds: ['604'],
            publicDetailReadable: true,
            featured: false,
            hot: true,
            views: 18,
            coverImageUrl: null,
            hasCover: false
          }
        }
      ]
    },
    redis: {
      namespace: 'ns',
      keys: [
        { domain: 'redis.cache.public', key: 'blog:top_articles', present: true, memberIds: ['101', '102', '103'] },
        { domain: 'redis.cache.public', key: 'featured-hot', present: true, memberIds: ['101', '102'] }
      ]
    },
    cache: {
      namespace: 'ns',
      generation: 1,
      entries: [
        {
          domain: 'home',
          endpoint: 'article/hot',
          matchesDb: true,
          requireOwnedVisible: true,
          visibleEntityIds: ['101', '102', '103']
        },
        {
          domain: 'search',
          endpoint: 'search',
          matchesDb: true,
          searchHit: true,
          searchToken: 'FXPC_PRIMARY_BODY',
          visibleEntityIds: ['101']
        },
        {
          domain: 'list',
          endpoint: 'article/list/home',
          matchesDb: true,
          requireOwnedVisible: true,
          visibleEntityIds: ['101', '102', '103']
        }
      ]
    }
  }
}

test('public-content catalog strategy is transaction-fixture with single owner', () => {
  const catalogs = readFixtureCatalogs()
  const producer = catalogs.producer.producers.find((item) => item.id === 'public-content')
  assert.equal(producer.strategy, 'transaction-fixture')
  const owners = catalogs.capability.capabilities
    .filter((item) => item.id.startsWith('public.'))
    .map((item) => item.ownerProducerId)
  assert.ok(owners.every((id) => id === 'public-content'))
  assertPostconditionRegistryComplete(catalogs)
})

test('public-minimal plan requires exactly 3 published articles and cover mix', () => {
  const planDocument = buildPublicContentPlan([
    'public.article.published',
    'public.article.revision-history',
    'public.home.featured-hot',
    'public.search.indexed',
    'public.taxonomy.category-tag'
  ])
  assert.equal(planDocument.strategy, 'transaction-fixture')
  assert.equal(planDocument.mode, 'public-minimal')
  assert.equal(planDocument.publishedArticleCount, 3)
  assert.equal(planDocument.requireCoverMix, true)
  assert.equal(planDocument.empty, false)
})

test('public-content-lifecycle plan covers draft/scheduled/archived/deleted/multi rev-pub', () => {
  const planDocument = buildPublicContentPlan([
    'public.article.archived',
    'public.article.deleted',
    'public.article.draft',
    'public.article.multiple-publications',
    'public.article.multiple-revisions',
    'public.article.published',
    'public.article.revision-history',
    'public.article.scheduled',
    'public.home.featured-hot',
    'public.search.indexed',
    'public.taxonomy.category-tag'
  ])
  assert.equal(planDocument.mode, 'public-content-lifecycle')
  assert.equal(planDocument.lifecycle.draft, true)
  assert.equal(planDocument.lifecycle.scheduled, true)
  assert.equal(planDocument.lifecycle.archived, true)
  assert.equal(planDocument.lifecycle.deleted, true)
  assert.equal(planDocument.requireMultipleRevisions, true)
  assert.equal(planDocument.requireMultiplePublications, true)
})

test('public-empty plan is exclusive and zero published', () => {
  const planDocument = buildPublicContentPlan(['public.empty'])
  assert.equal(planDocument.mode, 'public-empty')
  assert.equal(planDocument.publishedArticleCount, 0)
  assert.equal(planDocument.empty, true)
  assert.throws(
    () => buildPublicContentPlan(['public.empty', 'public.article.published']),
    /cannot mix/
  )
})

test('prepare uses injected domain-port adapter and forbids strategy env override', async () => {
  process.env.FSUSBLOG_FORCE_DIRECT_DB_SEED = '1'
  try {
    await assert.rejects(
      () => preparePublicContent({
        plan: { capabilities: ['public.article.published'] },
        handles: {}
      }),
      /strategy\/env override|FSUSBLOG_FORCE_DIRECT_DB_SEED/
    )
  } finally {
    delete process.env.FSUSBLOG_FORCE_DIRECT_DB_SEED
  }

  const variantContext = producerVariantContext([
    'public.article.published',
    'public.article.revision-history',
    'public.home.featured-hot',
    'public.search.indexed',
    'public.taxonomy.category-tag'
  ])
  const result = await preparePublicContent({
    ...variantContext,
    plan: {
      capabilities: [
        'public.article.published',
        'public.article.revision-history',
        'public.home.featured-hot',
        'public.search.indexed',
        'public.taxonomy.category-tag'
      ]
    },
    namespace: 'ns',
    runIdentity: 'run',
    handles: {
      publicContentAdapter: {
        async prepare() {
          return {
            strategy: 'transaction-fixture',
            entityIdentities: [
              { kind: 'category', id: '11' },
              { kind: 'tag', id: '22' },
              { kind: 'article', id: '101' },
              { kind: 'article', id: '102' },
              { kind: 'article', id: '103' }
            ],
            observations: minimalObservations()
          }
        }
      }
    }
  })
  assert.equal(result.strategy, 'transaction-fixture')
  assert.equal(result.entityIdentities.filter((item) => item.kind === 'article').length, 3)
  assert.equal(result.observations.database.entities.filter((item) => item.kind === 'article').length, 3)
  assert.equal(result.entityIdentities.every((item) => Boolean(item.variantId)), true)
  assert.equal(result.observations.database.entities.every((item) => Boolean(item.variantId)), true)
  assert.equal(
    result.producerVariantPlanDigest,
    variantContext.variantPlan.producerVariantPlanDigest
  )
})

test('prepare fails closed without baseUrl when adapter missing (no env discovery)', async () => {
  const previous = process.env.FSUSBLOG_BASE_URL
  delete process.env.FSUSBLOG_BASE_URL
  try {
    await assert.rejects(
      () => preparePublicContent({
        plan: { capabilities: ['public.article.published'] },
        handles: {}
      }),
      /requires handles\.baseUrl|refusing env discovery/
    )
  } finally {
    if (previous != null) process.env.FSUSBLOG_BASE_URL = previous
  }
})

test('prepare rejects local-fallback and incomplete published set', async () => {
  await assert.rejects(
    () => preparePublicContent({
      plan: { capabilities: ['public.article.published'] },
      handles: {
        publicContentAdapter: {
          async prepare() {
            return {
              strategy: 'transaction-fixture',
              observations: { ...minimalObservations(), source: 'local-fallback' },
              entityIdentities: [{ kind: 'article', id: '1' }]
            }
          }
        }
      }
    }),
    /local-fallback|fallback/
  )

  await assert.rejects(
    () => preparePublicContent({
      plan: { capabilities: ['public.article.published'] },
      handles: {
        publicContentAdapter: {
          async prepare() {
            const obs = minimalObservations()
            obs.database.entities = obs.database.entities.filter((item) => item.kind !== 'article' || item.id === '101')
            return { strategy: 'transaction-fixture', observations: obs, entityIdentities: [{ kind: 'article', id: '101' }] }
          }
        }
      }
    }),
    /exactly 3 published/
  )
})

test('canonical public-content rejects a real rights recompute sentinel in observed entity fields', async () => {
  const capabilities = ['public.article.published', 'public.taxonomy.category-tag']
  const context = producerVariantContext(capabilities)
  await assert.rejects(
    () => preparePublicContent({
      ...context,
      plan: { capabilities },
      handles: {
        publicContentAdapter: {
          async prepare() {
            const observations = minimalObservations()
            observations.database.entities.find((item) => item.id === '101').fields.policyHash = 'rights-v3:policy-hash:recompute'
            return { strategy: 'transaction-fixture', observations, entityIdentities: [{ kind: 'article', id: '101' }] }
          }
        }
      }
    }),
    /contains forbidden sentinel rights-v3-policy-hash-recompute/
  )
})

test('negative and migration public variants cannot relabel canonical producer output', async () => {
  const negative = buildProducerFixtureVariantPlan({
    producerId: 'public-content',
    variantIds: ['negative.public-article-published-rights-recompute'],
    fixtureVariantIds: ['negative.public-article-published-rights-recompute'],
    fixtureVariantPlanDigest: buildFixtureVariantPlan(['negative.public-article-published-rights-recompute'], catalogs).variantPlanDigest,
    catalogs
  })
  await assert.rejects(
    () => preparePublicContent({ plan: { capabilities: ['public.article.published'] }, variantPlan: negative, catalogs, handles: {} }),
    /requires a dedicated variant adapter/
  )
  await assert.rejects(
    () => preparePublicContent({
      plan: { capabilities: ['public.article.published'] }, variantPlan: negative, catalogs,
      handles: {
        publicContentVariantAdapter: {
          async prepare() {
            return {
              source: 'live-service',
              variants: [{ variantId: 'negative.public-article-published-rights-recompute', rejected: false, invariantIds: [] }]
            }
          }
        }
      }
    }),
    /requires exact rejected invariant rights-policy-hash-ready/
  )
  const result = await preparePublicContent({
    plan: { capabilities: ['public.article.published'] }, variantPlan: negative, catalogs,
    handles: {
      publicContentVariantAdapter: {
        async prepare({ variants }) {
          const [variant] = variants
          return {
            source: 'live-service',
            variants: [{
              variantId: variant.id,
              rejected: true,
              injectedSentinelId: variant.injectedSentinelId,
              injectedSentinelValue: variant.injectedSentinelValue,
              invariantIds: [variant.expectedInvariantId]
            }]
          }
        }
      }
    }
  })
  assert.equal(result.variantEvidence.variants[0].injectedSentinelId, 'rights-v3-policy-hash-recompute')
  assert.equal(result.variantEvidence.variants[0].injectedSentinelValue, 'rights-v3:policy-hash:recompute')
})

test('postconditions: published, taxonomy, search, empty, multi rev/pub', () => {
  const publishedObs = minimalObservations()
  assert.equal(runPostcondition('article-published', { observations: publishedObs }).ok, true)
  assert.equal(runPostcondition('taxonomy-category-tag', { observations: publishedObs }).ok, true)
  assert.equal(runPostcondition('search-indexed', { observations: publishedObs }).ok, true)
  assert.equal(runPostcondition('home-featured-hot', { observations: publishedObs }).ok, true)
  assert.equal(runPostcondition('article-revision-history', { observations: publishedObs }).ok, true)

  const multi = structuredClone(publishedObs)
  multi.database.entities.push({
    kind: 'article',
    id: '101',
    capabilityHint: 'article-multiple-revisions',
    fields: { multipleRevisions: true, revisionCount: 2, revisionIds: ['1', '2'], status: 'published' }
  })
  multi.database.entities.push({
    kind: 'article',
    id: '102',
    capabilityHint: 'article-multiple-publications',
    fields: { multiplePublications: true, publicationCount: 2, status: 'published' }
  })
  assert.equal(runPostcondition('article-multiple-revisions', { observations: multi }).ok, true)
  assert.equal(runPostcondition('article-multiple-publications', { observations: multi }).ok, true)

  const emptyObs = minimalObservations({ empty: true })
  assert.equal(runPostcondition('public-empty', { observations: emptyObs }).ok, true)
  assert.equal(runPostcondition('public-empty', { observations: publishedObs }).ok, false)

  // Missing publication pointer fails published.
  const broken = structuredClone(publishedObs)
  broken.database.entities[2].fields.currentPublicationId = null
  assert.equal(runPostcondition('article-published', { observations: broken }).ok, false)
})

test('orchestrator public-minimal verify with injected adapter yields verified receipt', async () => {
  const planned = plan({ profileId: 'public-minimal', profileSource: 'dev-cli' }, {
    runId: 'run-public-1712',
    namespace: 'ns-1712',
    handles: { serviceGeneration: 'gen-1' }
  })
  assert.deepEqual(planned.producers, ['public-content'])
  assert.ok(planned.capabilities.includes('public.article.published'))
  assert.ok(planned.capabilities.includes('public.taxonomy.category-tag'))

  const port = createPublicContentPort()
  const prepared = await prepare(planned, [port], undefined, {
    handles: {
      publicContentAdapter: {
        async prepare() {
          return {
            strategy: 'transaction-fixture',
            entityIdentities: [
              { kind: 'category', id: '11' },
              { kind: 'tag', id: '22' },
              { kind: 'article', id: '101' },
              { kind: 'article', id: '102' },
              { kind: 'article', id: '103' }
            ],
            observations: minimalObservations()
          }
        }
      }
    }
  })
  assert.equal(prepared.terminalState, 'prepared')
  const verified = await verify(prepared, [port], {
    handles: {
      publicContentAdapter: {
        async verify() {
          return { ok: true }
        }
      }
    }
  })
  assert.equal(verified.terminalStatus, 'verified')
  assert.equal(verified.producerReceipts[0].strategy, 'transaction-fixture')
  assert.ok(verified.producerReceipts[0].entityIdentities.some((item) => item.kind === 'article'))
})

test('default public-empty profile proves an observed empty set without inventing an entity', async () => {
  const planned = plan({ profileId: 'public-empty', profileSource: 'dev-cli' }, {
    runId: 'run-public-empty',
    namespace: 'ns-public-empty',
    handles: { serviceGeneration: 'gen-empty' }
  })
  const port = createPublicContentPort()
  const prepared = await prepare(planned, [port], undefined, {
    handles: {
      publicContentAdapter: {
        async prepare() {
          return {
            strategy: 'transaction-fixture',
            entityIdentities: [],
            observations: minimalObservations({ empty: true })
          }
        }
      }
    }
  })
  assert.deepEqual(prepared.producerResults[0].entityIdentities, [])
  assert.equal(prepared.producerResults[0].variantEvidence.variants[0].emptyVerified, true)
  const verified = await verify(prepared, [port], {
    handles: { publicContentAdapter: { async verify() { return { ok: true } } } }
  })
  assert.equal(verified.terminalStatus, 'verified')
  assert.deepEqual(verified.producerReceipts[0].entityIdentities, [])
})

test('verify rejects strategy drift and missing observations', async () => {
  const ok = await verifyPublicContent({}, {
    strategy: 'transaction-fixture',
    observations: minimalObservations()
  })
  assert.equal(ok.ok, true)

  const drift = await verifyPublicContent({}, {
    strategy: 'public-api-scenario',
    observations: minimalObservations()
  })
  assert.equal(drift.ok, false)

  const missing = await verifyPublicContent({}, { strategy: 'transaction-fixture' })
  assert.equal(missing.ok, false)
})

test('code search: old public producer fallbacks are gone', async () => {
  const { readFileSync } = await import('node:fs')
  const { pathToFileURL } = await import('node:url')
  const root = new URL('../..', pathToFileURL(`${process.cwd()}/`)).pathname
  // Use relative repo paths from test file location.
  const producer = readFileSync(new URL('../../tools/test-fixtures/producers/public-content-producer.mjs', import.meta.url), 'utf8')
  const ports = readFileSync(new URL('../../tools/test-fixtures/producers/catalog-ports.mjs', import.meta.url), 'utf8')
  const registry = readFileSync(new URL('../../config/testing/fixture-producer-registry.json', import.meta.url), 'utf8')
  assert.doesNotMatch(producer, /seedPublicFixturesViaApi|buildSeededArticleFallback|function seedPublicFixtures\s*\(|waitForPublicFixtureSnapshot/)
  assert.doesNotMatch(ports, /discover-playwright-fixtures|public-api-scenario only/)
  assert.match(registry, /"strategy": "transaction-fixture"/)
  assert.match(registry, /public-content-producer\.mjs/)
  assert.doesNotMatch(registry, /discover-playwright-fixtures/)
  void root
})
