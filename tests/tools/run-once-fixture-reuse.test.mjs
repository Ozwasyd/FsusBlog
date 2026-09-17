/**
 * #1711: run-once fixture reuse must revalidate FixtureReceipt postconditions.
 * File presence / fingerprint alone is not success evidence.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { runOnce } from '../../tools/test/run-once.mjs'
import {
  buildFixtureReceipt,
  buildProducerReceipt,
  digestCanonical,
  FIXTURE_REUSE_REASON_CODES,
  FIXTURE_RUN_ONCE_REUSE_CONTRACT,
  runFixtureOnce,
  writeFixtureReceipt
} from '../../tools/test-fixtures/index.mjs'
import {
  buildFixtureVariantPlan,
  buildProducerFixtureVariantPlan,
  fixtureCatalogDigest,
  readFixtureCatalogs,
  validateFixtureCatalogs
} from '../../tools/testing/fixture-catalog.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalogs = readFixtureCatalogs()
const catalogDigest = fixtureCatalogDigest(catalogs)
const articleVariantIds = Object.freeze(['canonical.public.article.published'])
const articleVariantPlan = buildFixtureVariantPlan(articleVariantIds, catalogs)
const articleProducerVariantPlan = buildProducerFixtureVariantPlan({
  producerId: 'public-content',
  variantIds: articleVariantIds,
  fixtureVariantIds: articleVariantIds,
  fixtureVariantPlanDigest: articleVariantPlan.variantPlanDigest,
  catalogs
})

function articleObservations(overrides = {}) {
  const namespace = overrides.namespace ?? 'run-a'
  return {
    database: {
      namespace,
      schemaIdentity: 'public',
      catalogDigest,
      serviceGeneration: overrides.serviceGeneration ?? 'gen-1',
      entities: [{
        kind: 'article',
        id: '101',
        variantId: articleVariantIds[0],
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
      serviceGeneration: overrides.serviceGeneration ?? 'gen-1',
      keys: [{ domain: 'redis.cache.public', key: 'hot:101', present: true }]
    },
    cache: {
      namespace,
      serviceGeneration: overrides.serviceGeneration ?? 'gen-1',
      entries: [{
        domain: 'public.home.featured-hot',
        generation: overrides.cacheGeneration ?? 'g1',
        matchesDb: true,
        visibleEntityIds: ['101']
      }]
    }
  }
}

function buildVerifiedReceipt(observations, extra = {}) {
  const producer = buildProducerReceipt({
    producerId: 'public-content',
    strategy: 'transaction-fixture',
    runId: 'run-a',
    namespace: 'run-a',
    source: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
    fixtureCatalogDigest: catalogDigest,
    profileId: 'public-minimal',
    expandedCapabilityDigest: digestCanonical(['public.article.published']),
    fixtureVariantIds: articleVariantIds,
    variantPlanDigest: articleVariantPlan.variantPlanDigest,
    producerVariantPlanDigest: articleProducerVariantPlan.producerVariantPlanDigest,
    producedVariantIds: articleVariantIds,
    serviceGeneration: 'gen-1',
    providedCapabilities: ['public.article.published'],
    ownedStateDomains: [
      'fixture.public-content',
      'postgres.article',
      'postgres.outbox',
      'redis.cache.public'
    ],
    entityIdentities: [{ kind: 'article', id: '101', variantId: articleVariantIds[0] }],
    postconditionObservations: [{
      capabilityId: 'public.article.published',
      postconditionId: 'article-published',
      ok: true,
      detail: { articleIds: ['101'] }
    }],
    databaseObservation: observations.database,
    redisObservation: observations.redis,
    cacheObservation: observations.cache,
    catalogs
  })
  return buildFixtureReceipt({
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
    fixtureVariantIds: articleVariantIds,
    variantPlanDigest: articleVariantPlan.variantPlanDigest,
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
    outputArtifacts: extra.outputArtifacts ?? [],
    catalogs
  })
}

function tempRoot(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-fixture-reuse-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

async function prepareOnce(directory, {
  observations,
  observe,
  fingerprint = 'fp-1',
  key = 'public-fixtures',
  serviceGeneration = 'gen-1'
}) {
  const receiptPath = path.join(directory, 'fixture-receipt.json')
  const projectionPath = path.join(directory, 'public-fixtures.json')
  let executions = 0
  const run = () => runFixtureOnce({
    root: path.join(directory, 'run-once'),
    namespace: 'ns',
    key,
    fingerprint,
    fixtureReceiptPath: receiptPath,
    requiredOutputs: [projectionPath],
    currentStateGeneration: serviceGeneration,
    expectedCatalogDigest: catalogDigest,
    expectedProfileId: 'public-minimal',
    expectedExecutionIdentity: {
      runId: 'run-a',
      namespace: 'run-a',
      source: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
      serviceGeneration
    },
    observeCurrentState: observe ?? (async () => observations),
    catalogs
  }, async () => {
    executions += 1
    fs.writeFileSync(projectionPath, `${JSON.stringify({ articleId: '101' })}\n`, { mode: 0o600 })
    writeFixtureReceipt(receiptPath, buildVerifiedReceipt(observations, {
      outputArtifacts: [{
        path: projectionPath,
        digest: digestCanonical({ articleId: '101' }),
        role: 'fixture-output'
      }]
    }), { catalogs })
  })
  return { run, get executions() { return executions }, receiptPath, projectionPath }
}

test('catalog registers fixture-receipt reuse verifier on every producer', () => {
  const errors = validateFixtureCatalogs()
  assert.deepEqual(errors, [])
  for (const producer of catalogs.producer.producers) {
    assert.equal(producer.reuseVerifier, 'fixture-receipt', producer.id)
  }
  assert.ok(FIXTURE_REUSE_REASON_CODES.includes('fixture.database-drift'))
  assert.equal(FIXTURE_RUN_ONCE_REUSE_CONTRACT, 'fixture-receipt')
})

test('ordinary run-once still reuses on fingerprint + outputs without fixture verifier', async (context) => {
  const directory = tempRoot(context)
  const output = path.join(directory, 'dist', 'index.html')
  let executions = 0
  const options = {
    root: path.join(directory, 'run-once'),
    namespace: 'build',
    key: 'frontend-release',
    fingerprint: 'src-a',
    requiredOutputs: [output]
  }
  const operation = async () => {
    executions += 1
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, '<html/>\n')
  }
  assert.equal((await runOnce(options, operation)).status, 'executed')
  const second = await runOnce(options, operation)
  assert.equal(second.status, 'shared-current-run')
  assert.equal(second.reuse.reasonCode, 'run-once.output-match')
  assert.equal(executions, 1)
})

test('fixture reuse succeeds only when receipt postconditions still hold', async (context) => {
  const directory = tempRoot(context)
  const observations = articleObservations()
  const helper = await prepareOnce(directory, { observations })
  const first = await helper.run()
  assert.equal(first.status, 'executed')
  assert.equal(helper.executions, 1)
  const second = await helper.run()
  assert.equal(second.status, 'shared-current-run')
  assert.equal(second.reuse.reasonCode, 'fixture.reusable')
  assert.ok(second.reuse.observationDigest?.startsWith('sha256:'))
  assert.equal(helper.executions, 1)
})

test('counterexample: delete public article but keep fixture file → re-execute', async (context) => {
  const directory = tempRoot(context)
  const live = { current: articleObservations() }
  const helper = await prepareOnce(directory, {
    observations: articleObservations(),
    observe: async () => live.current
  })
  await helper.run()
  live.current = {
    ...articleObservations(),
    database: {
      ...articleObservations().database,
      entities: []
    }
  }
  const second = await helper.run()
  assert.equal(second.status, 'executed')
  assert.equal(second.reuseRejection.reasonCode, 'fixture.database-drift')
  assert.equal(helper.executions, 2)
})

test('counterexample: revoke auth session while storage state file remains → re-execute', async (context) => {
  const directory = tempRoot(context)
  // Use redis session revoked observation against published article receipt fields:
  // drift redis keys / presence to force redis-drift (session revoked scenario).
  const live = { current: articleObservations() }
  const helper = await prepareOnce(directory, {
    observations: articleObservations(),
    observe: async () => live.current
  })
  await helper.run()
  live.current = {
    ...articleObservations(),
    redis: {
      namespace: 'run-a',
      serviceGeneration: 'gen-1',
      keys: [{ domain: 'redis.session', key: 'session:s1', present: false, sessionRevoked: true }]
    }
  }
  const second = await helper.run()
  assert.equal(second.status, 'executed')
  assert.equal(second.reuseRejection.reasonCode, 'fixture.redis-drift')
  assert.equal(helper.executions, 2)
})

test('counterexample: delete Redis hot key → re-execute', async (context) => {
  const directory = tempRoot(context)
  const live = { current: articleObservations() }
  const helper = await prepareOnce(directory, {
    observations: articleObservations(),
    observe: async () => live.current
  })
  await helper.run()
  live.current = {
    ...articleObservations(),
    redis: { namespace: 'run-a', serviceGeneration: 'gen-1', keys: [] }
  }
  const second = await helper.run()
  assert.equal(second.status, 'executed')
  assert.equal(second.reuseRejection.reasonCode, 'fixture.redis-drift')
})

test('counterexample: modify MFA / article field drift → re-execute', async (context) => {
  const directory = tempRoot(context)
  const live = { current: articleObservations() }
  const helper = await prepareOnce(directory, {
    observations: articleObservations(),
    observe: async () => live.current
  })
  await helper.run()
  live.current = articleObservations({ fields: { currentPublicationId: '' } })
  const second = await helper.run()
  assert.equal(second.status, 'executed')
  assert.equal(second.reuseRejection.reasonCode, 'fixture.database-drift')
})

test('counterexample: cache generation changes → re-execute', async (context) => {
  const directory = tempRoot(context)
  const live = { current: articleObservations() }
  const helper = await prepareOnce(directory, {
    observations: articleObservations(),
    observe: async () => live.current
  })
  await helper.run()
  live.current = articleObservations({ cacheGeneration: 'g2-drifted' })
  const second = await helper.run()
  assert.equal(second.status, 'executed')
  assert.equal(second.reuseRejection.reasonCode, 'fixture.cache-drift')
})

test('counterexample: same container identity but row drift → re-execute', async (context) => {
  const directory = tempRoot(context)
  const live = { current: articleObservations() }
  const helper = await prepareOnce(directory, {
    observations: articleObservations(),
    observe: async () => live.current,
    serviceGeneration: 'gen-1'
  })
  await helper.run()
  live.current = articleObservations({ fields: { status: 'draft', currentPublicationId: 'pub-1' } })
  const second = await helper.run()
  assert.equal(second.status, 'executed')
  assert.equal(second.reuseRejection.reasonCode, 'fixture.database-drift')
})

test('counterexample: verifier after another step mutates state generation → refuse reuse', async (context) => {
  const directory = tempRoot(context)
  const observations = articleObservations()
  const receiptPath = path.join(directory, 'fixture-receipt.json')
  const projectionPath = path.join(directory, 'public-fixtures.json')
  let executions = 0
  const base = {
    root: path.join(directory, 'run-once'),
    namespace: 'ns',
    key: 'public-fixtures',
    fingerprint: 'fp-1',
    fixtureReceiptPath: receiptPath,
    requiredOutputs: [projectionPath],
    expectedCatalogDigest: catalogDigest,
    expectedProfileId: 'public-minimal',
    expectedExecutionIdentity: {
      runId: 'run-a',
      namespace: 'run-a',
      source: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
      serviceGeneration: 'gen-1'
    },
    observeCurrentState: async () => observations,
    catalogs
  }
  const operation = async () => {
    executions += 1
    fs.writeFileSync(projectionPath, `${JSON.stringify({ articleId: '101' })}\n`, { mode: 0o600 })
    writeFixtureReceipt(receiptPath, buildVerifiedReceipt(observations), { catalogs })
  }
  assert.equal((await runFixtureOnce({ ...base, currentStateGeneration: 'gen-1' }, operation)).status, 'executed')
  // Another step advanced service generation (TOCTOU / lease boundary).
  const second = await runFixtureOnce({ ...base, currentStateGeneration: 'gen-2' }, operation)
  assert.equal(second.status, 'executed')
  assert.equal(second.reuseRejection.reasonCode, 'fixture.generation-mismatch')
  assert.equal(executions, 2)
})

test('counterexample: tampered receipt digest binding → refuse reuse', async (context) => {
  const directory = tempRoot(context)
  const observations = articleObservations()
  const helper = await prepareOnce(directory, { observations })
  await helper.run()
  // Keep on-disk receipt bytes (output digests) intact; forge the reuse-contract binding.
  const stateFile = path.join(directory, 'run-once', 'ns', 'public-fixtures.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.reuseContract.fixtureReceiptDigest = `sha256:${'0'.repeat(64)}`
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  const second = await helper.run()
  assert.equal(second.status, 'executed')
  assert.equal(second.reuseRejection.reasonCode, 'fixture.receipt-invalid')
})

test('counterexample: old schema receipt → refuse reuse', async (context) => {
  const directory = tempRoot(context)
  const observations = articleObservations()
  const helper = await prepareOnce(directory, { observations })
  await helper.run()
  // Forge reuse contract path to a retired v1 receipt while keeping required outputs intact.
  const retiredPath = path.join(directory, 'retired-receipt.json')
  fs.writeFileSync(retiredPath, `${JSON.stringify({
    schema: 'fsusblog.fixture-receipt.v1',
    kind: 'fixture-receipt',
    generatedAt: new Date().toISOString()
  }, null, 2)}\n`, { mode: 0o600 })
  const stateFile = path.join(directory, 'run-once', 'ns', 'public-fixtures.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.reuseContract.fixtureReceiptPath = retiredPath
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  const second = await helper.run()
  assert.equal(second.status, 'executed')
  assert.ok(
    second.reuseRejection.reasonCode === 'fixture.receipt-invalid'
      || second.reuseRejection.reasonCode === 'fixture.receipt-missing'
  )
})

test('counterexample: verifier throws → fail closed, not silent cache miss', async (context) => {
  const directory = tempRoot(context)
  const observations = articleObservations()
  const receiptPath = path.join(directory, 'fixture-receipt.json')
  const projectionPath = path.join(directory, 'public-fixtures.json')
  let phase = 'prepare'
  const options = {
    root: path.join(directory, 'run-once'),
    namespace: 'ns',
    key: 'public-fixtures',
    fingerprint: 'fp-1',
    fixtureReceiptPath: receiptPath,
    requiredOutputs: [projectionPath],
    currentStateGeneration: 'gen-1',
    expectedCatalogDigest: catalogDigest,
    expectedProfileId: 'public-minimal',
    expectedExecutionIdentity: {
      runId: 'run-a',
      namespace: 'run-a',
      source: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
      serviceGeneration: 'gen-1'
    },
    observeCurrentState: async () => {
      if (phase === 'reuse') throw new Error('observer exploded')
      return observations
    },
    catalogs
  }
  const operation = async () => {
    fs.writeFileSync(projectionPath, `${JSON.stringify({ articleId: '101' })}\n`, { mode: 0o600 })
    writeFixtureReceipt(receiptPath, buildVerifiedReceipt(observations), { catalogs })
  }
  assert.equal((await runFixtureOnce(options, operation)).status, 'executed')
  phase = 'reuse'
  await assert.rejects(
    () => runFixtureOnce(options, operation),
    (error) => {
      assert.match(String(error.message), /observer exploded/)
      assert.equal(error.reasonCode, 'fixture.verifier-fault')
      return true
    }
  )
})

test('counterexample: plain run-once has no fixture verifier and is not fixture-coupled', async (context) => {
  const directory = tempRoot(context)
  const output = path.join(directory, 'out.bin')
  const result = await runOnce({
    root: path.join(directory, 'run-once'),
    namespace: 'build',
    key: 'wasm',
    fingerprint: 'w1',
    requiredOutputs: [output]
  }, async () => {
    fs.writeFileSync(output, 'wasm')
  })
  assert.equal(result.status, 'executed')
  assert.equal(result.reuseRejection, null)
  const source = fs.readFileSync(path.join(root, 'tools/test/run-once.mjs'), 'utf8')
  assert.doesNotMatch(source, /postgresql|redis\.createClient|fixture-receipt|readFixtureReceipt/iu)
  assert.match(source, /verifyReusableState/)
})

test('counterexample: skip/fast bypass env is forbidden', async (context) => {
  const directory = tempRoot(context)
  const observations = articleObservations()
  const previous = process.env.FSUSBLOG_SKIP_FIXTURE_VERIFY
  process.env.FSUSBLOG_SKIP_FIXTURE_VERIFY = '1'
  context.after(() => {
    if (previous === undefined) delete process.env.FSUSBLOG_SKIP_FIXTURE_VERIFY
    else process.env.FSUSBLOG_SKIP_FIXTURE_VERIFY = previous
  })
  await assert.rejects(
    () => runFixtureOnce({
      root: path.join(directory, 'run-once'),
      namespace: 'ns',
      key: 'public-fixtures',
      fingerprint: 'fp-1',
      fixtureReceiptPath: path.join(directory, 'fixture-receipt.json'),
      currentStateGeneration: 'gen-1',
      observeCurrentState: async () => observations,
      catalogs
    }, async () => {}),
    /FSUSBLOG_SKIP_FIXTURE_VERIFY is forbidden|skip-bypass/
  )
})

test('counterexample: legacy file-digest-only state is not reusable under fixture contract', async (context) => {
  const directory = tempRoot(context)
  const observations = articleObservations()
  const helper = await prepareOnce(directory, { observations })
  await helper.run()
  // Strip reuse contract to simulate pre-#1711 fixture run-once state.
  const stateFile = path.join(directory, 'run-once', 'ns', 'public-fixtures.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  delete state.reuseContract
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  const second = await helper.run()
  assert.equal(second.status, 'executed')
  assert.equal(second.reuseRejection.reasonCode, 'fixture.receipt-missing')
  assert.equal(helper.executions, 2)
})

test('governance: runFixtureOnce is the sole fixture run-once entry', () => {
  const runOnceSource = fs.readFileSync(path.join(root, 'tools/test/run-once.mjs'), 'utf8')
  const wrapperSource = fs.readFileSync(path.join(root, 'tools/test-fixtures/run-fixture-once.mjs'), 'utf8')
  const catalogSource = fs.readFileSync(path.join(root, 'tools/testing/fixture-catalog.mjs'), 'utf8')
  assert.match(wrapperSource, /createFixtureReceiptReuseVerifier/)
  assert.match(wrapperSource, /verifyReusableState/)
  assert.match(catalogSource, /reuseVerifier=fixture-receipt/)
  assert.doesNotMatch(runOnceSource, /from ['"].*test-fixtures/)
  // No second fixture-run-once implementation.
  assert.equal(
    fs.existsSync(path.join(root, 'tools/test-fixtures/fixture-run-once.mjs')),
    false
  )
})
