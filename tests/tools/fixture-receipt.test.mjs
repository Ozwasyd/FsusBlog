/**
 * FixtureReceipt / ProducerReceipt contract tests (#1710).
 * Covers schema, digests, postconditions, observations, private I/O, and required counterexamples.
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertNotAuthoritativeReceipt,
  assertPostconditionRegistryComplete,
  buildFixtureReceipt,
  buildProducerReceipt,
  digestCanonical,
  emptyDatabaseObservation,
  FIXTURE_ID_PROJECTION_SCHEMA,
  FIXTURE_RECEIPT_SCHEMA,
  listPostconditionIds,
  PRODUCER_RECEIPT_SCHEMA,
  projectFixtureIds,
  readFixtureReceipt,
  readPrivateJson,
  runPostcondition,
  validateFixtureReceipt,
  validateProducerReceipt,
  writeFixtureReceipt,
  writePrivateJson
} from '../../tools/test-fixtures/receipt/index.mjs'
import {
  plan as planOrchestration,
  prepare,
  verify
} from '../../tools/test-fixtures/index.mjs'
import {
  fixtureCatalogDigest,
  readFixtureCatalogs
} from '../../tools/testing/fixture-catalog.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalogs = readFixtureCatalogs()
const catalogDigest = fixtureCatalogDigest(catalogs)

function articlePublishedObservations(overrides = {}) {
  const namespace = overrides.namespace ?? 'run-a'
  return {
    database: {
      namespace,
      schemaIdentity: 'public',
      catalogDigest,
      entities: [{
        kind: 'article',
        id: '101',
        owned: true,
        fields: {
          status: 'published',
          deleted: false,
          currentPublicationId: 'pub-1',
          publicDetailReadable: true,
          ...(overrides.fields ?? {})
        }
      }]
    },
    redis: {
      namespace,
      keys: [{ domain: 'redis.cache.public', key: 'hot:101', present: true }]
    },
    cache: {
      namespace,
      entries: [{
        domain: 'public.home.featured-hot',
        generation: 'g1',
        matchesDb: true,
        visibleEntityIds: ['101']
      }]
    },
    ...overrides.top
  }
}

function baseProducerReceiptInput(extra = {}) {
  const namespace = extra.namespace ?? 'run-a'
  const observations = articlePublishedObservations({ namespace })
  return {
    producerId: 'public-content',
    strategy: 'transaction-fixture',
    runId: extra.runId ?? 'run-a',
    namespace,
    source: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
    fixtureCatalogDigest: catalogDigest,
    profileId: 'public-minimal',
    expandedCapabilityDigest: digestCanonical(['public.article.published']),
    serviceGeneration: 'gen-1',
    providedCapabilities: ['public.article.published'],
    ownedStateDomains: [
      'fixture.public-content',
      'postgres.article',
      'postgres.outbox',
      'redis.cache.public'
    ],
    entityIdentities: [{ kind: 'article', id: '101' }],
    postconditionObservations: [{
      capabilityId: 'public.article.published',
      postconditionId: 'article-published',
      ok: true,
      detail: { articleIds: ['101'] }
    }],
    databaseObservation: observations.database,
    redisObservation: observations.redis,
    cacheObservation: observations.cache,
    catalogs,
    ...extra,
    // Keep observation namespace aligned with identity after spread.
    namespace,
    databaseObservation: extra.databaseObservation ?? observations.database,
    redisObservation: extra.redisObservation ?? observations.redis,
    cacheObservation: extra.cacheObservation ?? observations.cache
  }
}

test('postcondition registry binds every #1707 capability postconditionId', () => {
  assertPostconditionRegistryComplete(catalogs)
  const ids = listPostconditionIds(catalogs)
  assert.ok(ids.includes('article-published'))
  assert.ok(ids.includes('user-mfa-enabled'))
  assert.ok(ids.includes('home-featured-hot'))
  assert.equal(ids.length >= 30, true)
})

test('ProducerReceipt and FixtureReceipt have unique schemas, validators, and digests', () => {
  const producer = buildProducerReceipt(baseProducerReceiptInput())
  assert.equal(producer.schema, PRODUCER_RECEIPT_SCHEMA)
  assert.ok(producer.producerReceiptDigest.startsWith('sha256:'))
  validateProducerReceipt(producer, { catalogs })

  const fixture = buildFixtureReceipt({
    terminalStatus: 'verified',
    executionIdentity: {
      runId: 'run-a',
      namespace: 'run-a',
      source: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
      serviceGeneration: 'gen-1'
    },
    profileIdentity: {
      profileId: 'public-minimal',
      profileSource: 'dev-cli',
      executionClass: 'runtime'
    },
    catalogDigest,
    expandedCapabilityDigest: digestCanonical(['public.article.published']),
    orderedProducerReceiptDigests: [producer.producerReceiptDigest],
    producerReceipts: [producer],
    capabilityMap: [{
      capabilityId: 'public.article.published',
      producerId: 'public-content',
      postconditionIds: ['article-published']
    }],
    serviceIdentity: {
      databaseSchema: 'public',
      databaseInstance: 'fsusblog-test-postgres-run-a',
      redisInstance: 'fsusblog-test-redis-run-a',
      redisNamespace: 'FsusBlog_run-a_'
    },
    catalogs
  })
  assert.equal(fixture.schema, FIXTURE_RECEIPT_SCHEMA)
  assert.equal(fixture.terminalStatus, 'verified')
  assert.ok(fixture.receiptDigest.startsWith('sha256:'))
  assert.ok(fixture.databaseObservationDigest.startsWith('sha256:'))
  assert.ok(fixture.redisObservationDigest.startsWith('sha256:'))
  assert.ok(fixture.cacheObservationDigest.startsWith('sha256:'))
  validateFixtureReceipt(fixture, { catalogs, requireVerified: true })
})

test('none receipt proves zero business fixture mutation', async () => {
  const planned = planOrchestration({ profileId: 'none', profileSource: 'dev-cli' }, {
    runId: 'run-none',
    namespace: 'ns-none'
  })
  const prepared = await prepare(planned, [])
  const verified = await verify(prepared, [])
  assert.equal(verified.terminalStatus, 'verified')
  assert.equal(verified.zeroBusinessMutation, true)
  assert.deepEqual(verified.databaseObservation.entities, [])
  assert.deepEqual(verified.redisObservation.keys, [])
  assert.deepEqual(verified.cacheObservation.entries, [])
  assert.deepEqual(verified.outputArtifacts, [])
  assert.deepEqual(verified.orderedProducerReceiptDigests, [])
})

test('counterexample: article row exists but current_publication_id empty', () => {
  const result = runPostcondition('article-published', {
    observations: articlePublishedObservations({ fields: { currentPublicationId: '' } }),
    entityIdentities: [{ kind: 'article', id: '101' }],
    capabilityId: 'public.article.published',
    producerId: 'public-content'
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /current_publication_id/)
})

test('counterexample: DB correct but Redis hot key missing', () => {
  const result = runPostcondition('home-featured-hot', {
    observations: {
      database: articlePublishedObservations().database,
      redis: { namespace: 'run-a', keys: [] },
      cache: articlePublishedObservations().cache
    },
    entityIdentities: [{ kind: 'article', id: '101' }],
    capabilityId: 'public.home.featured-hot',
    producerId: 'public-content'
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /Redis hot|missing/i)
})

test('counterexample: auth storage file exists but session revoked', () => {
  const result = runPostcondition('session-single-device', {
    observations: {
      database: {
        entities: [{ kind: 'session', id: 's1', fields: { active: true } }]
      },
      redis: {
        keys: [{ domain: 'redis.session', key: 'session:s1', present: true, sessionRevoked: true }]
      }
    },
    entityIdentities: [{ kind: 'session', id: 's1' }],
    capabilityId: 'session.single-device',
    producerId: 'auth-session'
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /revoked/i)
})

test('counterexample: producer provides undeclared capability', () => {
  assert.throws(
    () => buildProducerReceipt(baseProducerReceiptInput({
      providedCapabilities: ['public.article.published', 'auth.user.active']
    })),
    /undeclared capability/
  )
})

test('counterexample: receipt profile digest inconsistent with catalog capabilities', () => {
  const producer = buildProducerReceipt(baseProducerReceiptInput())
  const fixture = buildFixtureReceipt({
    terminalStatus: 'verified',
    executionIdentity: { runId: 'run-a', namespace: 'run-a', source: null, serviceGeneration: 'g' },
    profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
    catalogDigest,
    expandedCapabilityDigest: digestCanonical(['public.article.published']),
    orderedProducerReceiptDigests: [producer.producerReceiptDigest],
    producerReceipts: [producer],
    capabilityMap: [{
      capabilityId: 'public.article.published',
      producerId: 'public-content',
      postconditionIds: ['article-published']
    }],
    catalogs
  })
  // Body digest must fail when catalogDigest is rewritten without re-sealing.
  const wrongCatalog = { ...fixture, catalogDigest: `sha256:${'c'.repeat(64)}` }
  assert.throws(() => validateFixtureReceipt(wrongCatalog, { catalogs }), /digest mismatch|tampered/)
  // Cross-identity reuse: live catalog digest expectation refuses foreign receipt.
  assert.throws(
    () => validateFixtureReceipt(fixture, {
      catalogs,
      expectedCatalogDigest: `sha256:${'d'.repeat(64)}`
    }),
    /catalogDigest does not match|cross-identity/
  )
  // Producer expandedCapabilityDigest is profile-scoped; a different capability set differs.
  assert.notEqual(
    producer.expandedCapabilityDigest,
    digestCanonical(['public.article.published', 'public.home.featured-hot'])
  )
  // Re-bind with wrong ordered digests fails.
  assert.throws(
    () => buildFixtureReceipt({
      terminalStatus: 'verified',
      executionIdentity: { runId: 'run-a', namespace: 'run-a', source: null, serviceGeneration: 'g' },
      profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
      catalogDigest,
      expandedCapabilityDigest: digestCanonical(['public.article.published']),
      orderedProducerReceiptDigests: [`sha256:${'e'.repeat(64)}`],
      producerReceipts: [producer],
      capabilityMap: [{
        capabilityId: 'public.article.published',
        producerId: 'public-content',
        postconditionIds: ['article-published']
      }],
      catalogs
    }),
    /orderedProducerReceiptDigests must match/
  )
})

test('counterexample: partial producer success cannot be verified', async () => {
  const planned = planOrchestration({ profileId: 'scale-xs', profileSource: 'dev-cli' })
  const ports = planned.producerSpecs.map((spec) => ({
    id: spec.id,
    strategy: spec.strategy,
    providedCapabilities: [...spec.provides],
    consumedCapabilities: [...spec.consumes],
    async prepare() {
      if (spec.id === 'scale-data') throw new Error('scale partial failure')
      return {
        ok: true,
        producerId: spec.id,
        strategy: spec.strategy,
        observations: articlePublishedObservations()
      }
    },
    async verify() { return { ok: true } },
    async cleanup() {}
  }))
  await assert.rejects(() => prepare(planned, ports), /scale partial failure/)
  try {
    await prepare(planned, ports)
  } catch (error) {
    assert.ok(error.receipt)
    assert.notEqual(error.receipt.terminalState, 'prepared')
    assert.deepEqual(error.receipt.producerReceipts, [])
    if (error.fixtureReceipt) {
      assert.notEqual(error.fixtureReceipt.terminalStatus, 'verified')
    }
  }
})

test('counterexample: tampered receipt fails integrity', () => {
  const producer = buildProducerReceipt(baseProducerReceiptInput())
  const fixture = buildFixtureReceipt({
    terminalStatus: 'verified',
    executionIdentity: { runId: 'run-a', namespace: 'run-a', source: null, serviceGeneration: 'g' },
    profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
    catalogDigest,
    expandedCapabilityDigest: digestCanonical(['public.article.published']),
    orderedProducerReceiptDigests: [producer.producerReceiptDigest],
    producerReceipts: [producer],
    capabilityMap: [{
      capabilityId: 'public.article.published',
      producerId: 'public-content',
      postconditionIds: ['article-published']
    }],
    catalogs
  })
  const tampered = { ...fixture, verifiedAt: '2099-01-01T00:00:00.000Z' }
  assert.throws(() => validateFixtureReceipt(tampered, { catalogs }), /digest mismatch|tampered/)
})

test('counterexample: symlink receipt is rejected', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fixture-receipt-symlink-'))
  try {
    const real = path.join(directory, 'real.json')
    const link = path.join(directory, 'link.json')
    const producer = buildProducerReceipt(baseProducerReceiptInput())
    const fixture = buildFixtureReceipt({
      terminalStatus: 'verified',
      executionIdentity: { runId: 'run-a', namespace: 'run-a', source: null, serviceGeneration: 'g' },
      profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
      catalogDigest,
      expandedCapabilityDigest: digestCanonical(['public.article.published']),
      orderedProducerReceiptDigests: [producer.producerReceiptDigest],
      producerReceipts: [producer],
      capabilityMap: [{
        capabilityId: 'public.article.published',
        producerId: 'public-content',
        postconditionIds: ['article-published']
      }],
      catalogs
    })
    writeFixtureReceipt(real, fixture, { catalogs })
    symlinkSync(real, link)
    assert.throws(() => readFixtureReceipt(link, { catalogs }), /symlink/)
    assert.throws(() => writeFixtureReceipt(link, fixture, { catalogs }), /symlink/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('counterexample: none profile with fixture rows cannot verify', () => {
  assert.throws(
    () => buildFixtureReceipt({
      terminalStatus: 'verified',
      executionIdentity: { runId: 'r', namespace: 'n', source: null },
      profileIdentity: { profileId: 'none', profileSource: 'dev-cli' },
      catalogDigest,
      expandedCapabilityDigest: digestCanonical([]),
      orderedProducerReceiptDigests: [],
      producerReceipts: [],
      capabilityMap: [],
      databaseObservation: {
        entities: [{ kind: 'article', id: '1', fields: { status: 'published' } }]
      },
      catalogs
    }),
    /zero business fixture mutation/
  )
})

test('counterexample: cache endpoint still returns old article', () => {
  const result = runPostcondition('home-featured-hot', {
    observations: {
      database: {
        entities: [{
          kind: 'article',
          id: '101',
          fields: { featured: true, hot: true, status: 'published' }
        }]
      },
      redis: {
        keys: [{ domain: 'redis.cache.public', key: 'hot:101', present: true }]
      },
      cache: {
        entries: [{
          domain: 'public.home.featured-hot',
          matchesDb: false,
          visibleEntityIds: ['999']
        }]
      }
    },
    entityIdentities: [{ kind: 'article', id: '101' }],
    capabilityId: 'public.home.featured-hot',
    producerId: 'public-content'
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /stale|non-DB|missing/i)
})

test('counterexample: receipt containing access token is rejected', () => {
  assert.throws(
    () => buildProducerReceipt(baseProducerReceiptInput({
      entityIdentities: [{ kind: 'user', id: 'u1', accessToken: 'secret-token-value' }]
    })),
    /secret field|secret\/token|forbids|accessToken/
  )
  assert.throws(
    () => buildProducerReceipt(baseProducerReceiptInput({
      entityIdentities: [{ kind: 'user', id: 'u1', handle: 'Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb' }]
    })),
    /secret\/token|forbids/
  )
})

test('counterexample: current run refuses previous run receipt', () => {
  const producer = buildProducerReceipt(baseProducerReceiptInput({
    runId: 'run-old',
    namespace: 'ns-old'
  }))
  const fixture = buildFixtureReceipt({
    terminalStatus: 'verified',
    executionIdentity: {
      runId: 'run-old',
      namespace: 'ns-old',
      source: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
      serviceGeneration: 'g1'
    },
    profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
    catalogDigest,
    expandedCapabilityDigest: digestCanonical(['public.article.published']),
    orderedProducerReceiptDigests: [producer.producerReceiptDigest],
    producerReceipts: [producer],
    capabilityMap: [{
      capabilityId: 'public.article.published',
      producerId: 'public-content',
      postconditionIds: ['article-published']
    }],
    catalogs
  })
  assert.throws(
    () => validateFixtureReceipt(fixture, {
      catalogs,
      requireVerified: true,
      expectedExecutionIdentity: {
        runId: 'run-new',
        namespace: 'ns-new',
        source: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
        serviceGeneration: 'g1'
      }
    }),
    /execution identity mismatch|cross-run/
  )
})

test('atomic private write enforces 0600, integrity, and no dual v1 adapter', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fixture-receipt-io-'))
  try {
    const producer = buildProducerReceipt(baseProducerReceiptInput())
    const fixture = buildFixtureReceipt({
      terminalStatus: 'verified',
      executionIdentity: { runId: 'run-a', namespace: 'run-a', source: null, serviceGeneration: 'g' },
      profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
      catalogDigest,
      expandedCapabilityDigest: digestCanonical(['public.article.published']),
      orderedProducerReceiptDigests: [producer.producerReceiptDigest],
      producerReceipts: [producer],
      capabilityMap: [{
        capabilityId: 'public.article.published',
        producerId: 'public-content',
        postconditionIds: ['article-published']
      }],
      catalogs
    })
    const file = path.join(directory, 'fixture-receipt.json')
    const written = writeFixtureReceipt(file, fixture, { catalogs })
    assert.ok(written.contentDigest.startsWith('sha256:'))
    if (process.platform !== 'win32') {
      assert.equal(written.mode & 0o777, 0o600)
    }
    const loaded = readFixtureReceipt(file, { catalogs, requireVerified: true })
    assert.equal(loaded.receiptDigest, fixture.receiptDigest)

    // retired schema adapter must fail
    const retired = path.join(directory, 'retired.json')
    writePrivateJson(retired, {
      schema: 'fsusblog.fixture-receipt.v1',
      kind: 'fixture-receipt',
      generatedAt: new Date().toISOString()
    })
    assert.throws(() => readFixtureReceipt(retired, { catalogs }), /retired|no dual adapter|schema/)

    // world-readable mode fails closed on unix
    if (process.platform !== 'win32') {
      chmodSync(file, 0o644)
      assert.throws(() => readPrivateJson(file, { label: 'FixtureReceipt' }), /private|0600/)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('narrow ID projection derives from verified receipt and is not authoritative', () => {
  const producer = buildProducerReceipt(baseProducerReceiptInput({
    entityIdentities: [
      { kind: 'article', id: '101' },
      { kind: 'category', id: '11' },
      { kind: 'tag', id: '22' }
    ]
  }))
  const fixture = buildFixtureReceipt({
    terminalStatus: 'verified',
    executionIdentity: { runId: 'run-a', namespace: 'run-a', source: null, serviceGeneration: 'g' },
    profileIdentity: { profileId: 'public-minimal', profileSource: 'dev-cli' },
    catalogDigest,
    expandedCapabilityDigest: digestCanonical(['public.article.published']),
    orderedProducerReceiptDigests: [producer.producerReceiptDigest],
    producerReceipts: [producer],
    capabilityMap: [{
      capabilityId: 'public.article.published',
      producerId: 'public-content',
      postconditionIds: ['article-published']
    }],
    catalogs
  })
  const projection = projectFixtureIds(fixture, { catalogs })
  assert.equal(projection.schema, FIXTURE_ID_PROJECTION_SCHEMA)
  assert.equal(projection.notAuthoritative, true)
  assert.equal(projection.articleId, '101')
  assert.equal(projection.categoryId, '11')
  assert.equal(projection.tagId, '22')
  assert.equal(projection.sourceReceiptDigest, fixture.receiptDigest)
  assert.throws(() => assertNotAuthoritativeReceipt(projection), /not an authoritative/)
  assert.throws(
    () => assertNotAuthoritativeReceipt({ schema: 'fsusblog.fixture-receipt.v1' }),
    /retired|cannot authorize/
  )
})

test('local fallback observations cannot verify postconditions', () => {
  const result = runPostcondition('article-published', {
    observations: {
      ...articlePublishedObservations(),
      source: 'local-fallback',
      fallback: true
    },
    entityIdentities: [{ kind: 'article', id: '101' }],
    capabilityId: 'public.article.published',
    producerId: 'public-content'
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /fallback|warning|stale/)
})

test('observation digests are stable and sensitive to field drift not mtime', () => {
  const left = emptyDatabaseObservation({ namespace: 'n', catalogDigest, serviceGeneration: 'g' })
  const right = emptyDatabaseObservation({ namespace: 'n', catalogDigest, serviceGeneration: 'g' })
  assert.equal(digestCanonical(left), digestCanonical(right))
  const drifted = {
    ...articlePublishedObservations().database,
    entities: [{
      kind: 'article',
      id: '101',
      fields: {
        status: 'published',
        deleted: false,
        currentPublicationId: 'pub-2',
        publicDetailReadable: true,
        mtime: 'ignored-by-absence'
      }
    }]
  }
  assert.notEqual(
    digestCanonical(articlePublishedObservations().database),
    digestCanonical(drifted)
  )
})

test('code search: retired dual receipt adapters and local fallback success evidence are gone', () => {
  const cli = readFileSync(path.join(root, 'tools/test-fixtures/cli.mjs'), 'utf8')
  const catalog = readFileSync(path.join(root, 'tools/testing/fixture-catalog.mjs'), 'utf8')
  const publicProducer = readFileSync(path.join(root, 'tools/test-fixtures/producers/public-content-producer.mjs'), 'utf8')
  const bootstrap = readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8')
  assert.doesNotMatch(cli, /toLegacyFixtureReceipt|function toLegacy/)
  assert.doesNotMatch(cli, /fsusblog\.fixture-receipt\.v1/)
  assert.match(cli, /dual\/legacy receipt paths were deleted|FixtureReceipt v2 is the sole authority/)
  assert.match(catalog, /kind=fixture-receipt was deleted|FixtureReceipt v2/)
  assert.doesNotMatch(publicProducer, /function buildSeededArticleFallback|function seedPublicFixtures\(|function runPsql\(|seedPublicFixturesViaApi/)
  assert.doesNotMatch(publicProducer, /using direct DB seed|admin API seeding unavailable; using direct DB seed/)
  assert.match(publicProducer, /transaction-fixture/)
  assert.doesNotMatch(bootstrap, /--legacy-|toLegacyFixtureReceipt/)
  assert.match(bootstrap, /notFixtureCompletenessEvidence|runtime-topology-only|FixtureReceipt/)
})
