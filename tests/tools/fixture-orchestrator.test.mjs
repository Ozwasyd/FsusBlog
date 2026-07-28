import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildProducerDag
} from '../../tools/test-fixtures/dag.mjs'
import {
  cleanup,
  createProducerContext,
  plan,
  prepare,
  verify
} from '../../tools/test-fixtures/orchestrator.mjs'
import { classifyDevFixtureReceiptTransition } from '../../tools/test-fixtures/cli.mjs'
import { createTerminalState } from '../../tools/test-fixtures/terminal-state.mjs'
import {
  fixtureCatalogDigest,
  readFixtureCatalogs
} from '../../tools/testing/fixture-catalog.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function mockPort(spec, hooks = {}) {
  const calls = { prepare: 0, verify: 0, cleanup: 0, prepareOrder: [] }
  const port = {
    id: spec.id,
    strategy: spec.strategy,
    providedCapabilities: [...spec.provides],
    consumedCapabilities: [...spec.consumes],
    calls,
    async prepare(context, signal) {
      calls.prepare += 1
      calls.prepareOrder.push(spec.id)
      if (hooks.onPrepare) {
        const result = await hooks.onPrepare(context, signal, calls)
        return {
          ...result,
          variantIds: result?.variantIds ?? context.variantPlan.variants.map((item) => item.id),
          producerVariantPlanDigest: result?.producerVariantPlanDigest
            ?? context.variantPlan.producerVariantPlanDigest
        }
      }
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      return {
        producerId: spec.id,
        strategy: spec.strategy,
        ok: true,
        variantIds: context.variantPlan.variants.map((item) => item.id),
        producerVariantPlanDigest: context.variantPlan.producerVariantPlanDigest
      }
    },
    async verify(context, receipt) {
      calls.verify += 1
      if (hooks.onVerify) return hooks.onVerify(context, receipt, calls)
      return { ok: true, producerId: spec.id }
    },
    async cleanup(context, receipt, signal) {
      calls.cleanup += 1
      if (hooks.onCleanup) return hooks.onCleanup(context, receipt, signal, calls)
    }
  }
  return port
}

function portsForPlan(planDocument, hookMap = {}) {
  return planDocument.producerSpecs.map((spec) => mockPort(spec, hookMap[spec.id]))
}

test('none plan has empty DAG and prepare is zero-mutation', async () => {
  const planned = plan({ profileId: 'none', profileSource: 'dev-cli' })
  assert.deepEqual(planned.producers, [])
  assert.deepEqual(planned.order, [])
  assert.deepEqual(planned.waves, [])
  assert.equal(planned.mutationPolicy, 'zero-mutation')
  const receipt = await prepare(planned, [])
  assert.equal(receipt.schema, 'fsusblog.fixture-prepare-state.v1')
  assert.equal(receipt.terminalState, 'prepared')
  assert.equal(receipt.zeroData, true)
  assert.deepEqual(receipt.mutations, [])
  const verified = await verify(receipt, [])
  assert.equal(verified.schema, 'fsusblog.fixture-receipt.v2')
  assert.equal(verified.terminalStatus, 'verified')
  assert.equal(verified.zeroBusinessMutation, true)
  assert.deepEqual(verified.orderedProducerReceiptDigests, [])
})

test('profile expands to a single producer DAG resolver', () => {
  const catalogs = readFixtureCatalogs()
  const dag = buildProducerDag('scale-xs', catalogs)
  assert.deepEqual(dag.producers.map((item) => item.id), ['public-content', 'scale-data'])
  assert.deepEqual(dag.waves, [['public-content'], ['scale-data']])
  const planned = plan({ profileId: 'scale-xs', profileSource: 'dev-cli' })
  assert.deepEqual(planned.producers, dag.producers.map((item) => item.id))
  assert.deepEqual(planned.order, dag.order)
})

test('producer dependency cycle fails before mutation', () => {
  const catalogs = readFixtureCatalogs()
  const mutated = structuredClone(catalogs)
  const auth = mutated.producer.producers.find((item) => item.id === 'auth-session')
  const messaging = mutated.producer.producers.find((item) => item.id === 'account-messaging')
  // Force a cycle between auth-session and account-messaging via consumes.
  auth.consumes = ['messages.thread']
  auth.stateDomains = [...new Set([...auth.stateDomains, ...messaging.stateDomains])].sort()
  assert.throws(
    () => buildProducerDag('account-messaging', mutated),
    /dependency cycle|not in the producer DAG|cycle/i
  )
})

test('two producers providing the same capability fail closed', () => {
  const catalogs = readFixtureCatalogs()
  const mutated = structuredClone(catalogs)
  const scale = mutated.producer.producers.find((item) => item.id === 'scale-data')
  scale.provides = [...scale.provides, 'public.article.published'].sort()
  assert.throws(
    () => buildProducerDag('public-minimal', mutated),
    /two producers provide the same capability|exactly owner|public\.article\.published/
  )
})

test('API producer failure does not run later DB-style producers and records one strategy', async () => {
  const planned = plan({ profileId: 'scale-xs', profileSource: 'dev-cli' })
  const ports = portsForPlan(planned, {
    'public-content': {
      onPrepare: async () => {
        throw new Error('admin API seed failed')
      }
    },
    'scale-data': {
      onPrepare: async () => {
        throw new Error('scale should not run')
      }
    }
  })
  await assert.rejects(() => prepare(planned, ports), /admin API seed failed/)
  const publicPort = ports.find((item) => item.id === 'public-content')
  const scalePort = ports.find((item) => item.id === 'scale-data')
  assert.equal(publicPort.calls.prepare, 1)
  assert.equal(scalePort.calls.prepare, 0)
  assert.equal(publicPort.strategy, 'transaction-fixture')
})

test('producer cannot return a fallback strategy', async () => {
  const planned = plan({ profileId: 'public-minimal', profileSource: 'dev-cli' })
  const ports = portsForPlan(planned, {
    'public-content': {
      onPrepare: async () => ({ strategy: 'public-api-scenario', ok: true })
    }
  })
  await assert.rejects(() => prepare(planned, ports), /cannot fallback|strategy/)
})

test('producer output must exactly declare registered planned variants and entity bindings', async () => {
  const planned = plan({ profileId: 'public-minimal', profileSource: 'dev-cli' })
  const unregistered = portsForPlan(planned, {
    'public-content': {
      onPrepare: async () => ({
        ok: true,
        strategy: 'transaction-fixture',
        variantIds: ['unregistered.fixture.variant']
      })
    }
  })
  await assert.rejects(
    () => prepare(planned, unregistered),
    /output variant IDs must exactly match/
  )

  const missingVariantEvidence = portsForPlan(planned, {
    'public-content': {
      onPrepare: async (context) => ({
        ok: true,
        enforceVariantEvidence: true,
        strategy: 'transaction-fixture',
        variantIds: context.variantPlan.variants.map((item) => item.id),
        entityIdentities: [{ kind: 'article', id: '101', variantId: context.variantPlan.variants[0].id }],
        observations: { database: { entities: [{ kind: 'article', id: '101', variantId: context.variantPlan.variants[0].id, fields: {} }] } }
      })
    }
  })
  await assert.rejects(() => prepare(planned, missingVariantEvidence), /has no exact entity binding or live evidence/)

  const missingEntityBinding = portsForPlan(planned, {
    'public-content': {
      onPrepare: async (context) => ({
        ok: true,
        strategy: 'transaction-fixture',
        variantIds: context.variantPlan.variants.map((item) => item.id),
        entityIdentities: [{ kind: 'article', id: '101' }]
      })
    }
  })
  await assert.rejects(
    () => prepare(planned, missingEntityBinding),
    /has no registered planned variant/
  )

  const wrongDigest = portsForPlan(planned, {
    'public-content': {
      onPrepare: async (context) => ({
        ok: true,
        strategy: 'transaction-fixture',
        variantIds: context.variantPlan.variants.map((item) => item.id),
        producerVariantPlanDigest: `sha256:${'0'.repeat(64)}`
      })
    }
  })
  await assert.rejects(
    () => prepare(planned, wrongDigest),
    /typed variant plan digest does not match/
  )
})

test('AbortSignal stops prepare and runs reverse-topo cleanup of successes', async () => {
  const planned = plan({ profileId: 'scale-xs', profileSource: 'dev-cli' })
  const controller = new AbortController()
  const ports = portsForPlan(planned, {
    'public-content': {
      onPrepare: async () => ({ ok: true, producerId: 'public-content', strategy: 'transaction-fixture' })
    },
    'scale-data': {
      onPrepare: async (_context, signal) => {
        controller.abort(new Error('cancelled-by-test'))
        if (signal.aborted) throw signal.reason
        return { ok: true }
      }
    }
  })
  await assert.rejects(() => prepare(planned, ports, controller.signal), /cancelled-by-test|aborted/)
  const publicPort = ports.find((item) => item.id === 'public-content')
  assert.equal(publicPort.calls.prepare, 1)
  assert.equal(publicPort.calls.cleanup, 1)
})

test('cleanup failure does not overwrite primary failure', async () => {
  const planned = plan({ profileId: 'scale-xs', profileSource: 'dev-cli' })
  const ports = portsForPlan(planned, {
    'public-content': {
      onPrepare: async () => ({ ok: true, producerId: 'public-content', strategy: 'transaction-fixture' }),
      onCleanup: async () => {
        throw new Error('cleanup boom')
      }
    },
    'scale-data': {
      onPrepare: async () => {
        throw new Error('primary boom')
      }
    }
  })
  try {
    await prepare(planned, ports)
    assert.fail('expected prepare to throw')
  } catch (error) {
    assert.match(error.message, /primary boom/)
    assert.equal(error.receipt.primaryFailure.message, 'primary boom')
    assert.equal(error.receipt.cleanupFailure.message, 'cleanup boom')
    assert.notEqual(error.receipt.terminalState, 'prepared')
  }
})

test('none profile rejects forced producer registration', () => {
  assert.throws(
    () => plan({ profileId: 'none', profileSource: 'dev-cli' }, { forcedProducers: ['auth-session'] }),
    /none profile cannot register producers/
  )
})

test('producer env strategy override is rejected by default ports', async () => {
  const planned = plan({ profileId: 'public-minimal', profileSource: 'dev-cli' })
  process.env.FSUSBLOG_FORCE_DIRECT_DB_SEED = '1'
  try {
    const { createPublicContentPort } = await import('../../tools/test-fixtures/producers/catalog-ports.mjs')
    const port = createPublicContentPort()
    await assert.rejects(
      () => port.prepare({
        plan: planned,
        producerOutputs: {},
        handles: {}
      }),
      /strategy\/env override|FSUSBLOG_FORCE_DIRECT_DB_SEED/
    )
  } finally {
    delete process.env.FSUSBLOG_FORCE_DIRECT_DB_SEED
  }
})

test('default structural port keeps pre-cutover profiles preparable without claiming typed entity evidence', async () => {
  const planned = plan({ profileId: 'account-messaging', profileSource: 'dev-cli' })
  const { createAccountMessagingPort } = await import('../../tools/test-fixtures/producers/catalog-ports.mjs')
  const port = createAccountMessagingPort()
  const context = createProducerContext({
    plan: planned,
    producerId: 'account-messaging',
    producerOutputs: {
      'auth-session': { producerId: 'auth-session', postconditions: ['user-active'] }
    }
  })
  const result = await port.prepare(context)
  assert.equal(result.structuralOnly, true)
  assert.equal(result.enforceVariantEvidence, undefined)
  assert.deepEqual(result.variantIds, context.variantPlan.variants.map((item) => item.id).sort())
})

test('state-domain conflicting producers are not scheduled in the same wave', () => {
  const dag = buildProducerDag('acceptance-representative')
  // account-messaging and comment-moderation share postgres.settings → not same wave.
  const waveSets = dag.waves.map((wave) => new Set(wave))
  for (const wave of waveSets) {
    assert.equal(
      wave.has('account-messaging') && wave.has('comment-moderation'),
      false,
      'account-messaging and comment-moderation must not share a wave'
    )
  }
})

test('partial result cannot be published as prepared', () => {
  const terminal = createTerminalState('planned')
  terminal.transition('preparing')
  assert.throws(() => terminal.assertPublishable('prepared'), /partial result cannot be published as prepared/)
  terminal.transition('failed')
  assert.throws(() => terminal.assertPublishable('prepared'), /partial result cannot be published as prepared/)
})

test('matrix sealed digests fail closed on catalog drift', () => {
  const digest = fixtureCatalogDigest()
  const live = plan({ profileId: 'none', profileSource: 'dev-cli' })
  assert.throws(
    () => plan({
      profileId: 'none',
      profileSource: 'matrix',
      sealed: {
        fixtureProfileId: 'none',
        fixtureCatalogDigest: 'sha256:deadbeef',
        expandedCapabilityDigest: digest,
        fixtureVariantIds: [],
        fixtureVariantPlanDigest: live.variantPlanDigest,
        executionClass: 'runtime'
      }
    }),
    /catalog digest drifted|fixture catalog digest/
  )
})

test('verify and cleanup succeed for prepared mock plan with observations', async () => {
  const planned = plan({ profileId: 'auth-basic', profileSource: 'dev-cli' })
  const ports = portsForPlan(planned, {
    'auth-session': {
      onPrepare: async () => ({
        ok: true,
        producerId: 'auth-session',
        strategy: 'transaction-fixture',
        entityIdentities: [
          { kind: 'user', id: 'u1', variantId: 'canonical.auth.user.active' },
          { kind: 'admin', id: 'a1', variantId: 'canonical.auth.admin.full-permission' },
          { kind: 'session', id: 's1', variantId: 'canonical.session.single-device' }
        ],
        observations: {
          database: {
            namespace: null,
            schemaIdentity: 'public',
            entities: [
              { kind: 'user', id: 'u1', variantId: 'canonical.auth.user.active', fields: { status: 'active', deleted: false } },
              { kind: 'admin', id: 'a1', variantId: 'canonical.auth.admin.full-permission', fields: { permission: 'full' } },
              { kind: 'session', id: 's1', variantId: 'canonical.session.single-device', fields: { active: true } }
            ]
          },
          redis: {
            namespace: null,
            keys: [
              { domain: 'redis.session', key: 'session:s1', present: true, sessionRevoked: false }
            ]
          },
          cache: { namespace: null, entries: [] }
        }
      })
    }
  })
  const prepared = await prepare(planned, ports)
  assert.equal(prepared.schema, 'fsusblog.fixture-prepare-state.v1')
  assert.equal(prepared.terminalState, 'prepared')
  assert.deepEqual(prepared.producerReceipts, [])
  const verified = await verify(prepared, ports)
  assert.equal(verified.schema, 'fsusblog.fixture-receipt.v2')
  assert.equal(verified.terminalStatus, 'verified')
  assert.ok(verified.receiptDigest.startsWith('sha256:'))
  assert.equal(verified.producerReceipts.length, 1)
  const cleaned = await cleanup(verified, ports)
  assert.equal(cleaned.terminalState, 'cleaned')
  assert.equal(ports[0].calls.cleanup, 1)
})

test('verify fails closed without service observations', async () => {
  const planned = plan({ profileId: 'auth-basic', profileSource: 'dev-cli' })
  const ports = portsForPlan(planned)
  const prepared = await prepare(planned, ports)
  await assert.rejects(() => verify(prepared, ports), /missing database\/redis\/cache observations|verify failed|postcondition/)
})

test('shell dual paths and prepare package scripts are gone', () => {
  const bootstrap = readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8')
  const start = readFileSync(path.join(root, 'tools/dev/start.sh'), 'utf8')
  const suite = readFileSync(path.join(root, 'tools/test/lanes/_suite-support.sh'), 'utf8')
  const pkg = JSON.parse(readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'))
  const publicProducer = readFileSync(path.join(root, 'tools/test-fixtures/producers/public-content-producer.mjs'), 'utf8')

  for (const source of [bootstrap, start, suite]) {
    assert.match(source, /tools\/test-fixtures\/cli\.mjs/)
    assert.doesNotMatch(source, /\bPrepareAuthFixturesOnce\b/)
    assert.doesNotMatch(source, /\bPreparePublicFixturesOnce\b/)
  }
  // Comment may mention the deleted name; require no callable dual orchestrator.
  assert.doesNotMatch(suite, /^\s*PrepareRuntimeFixturesOnce\b/mu)
  assert.doesNotMatch(suite, /\bPrepareRuntimeFixturesOnce\s*\(/u)
  assert.match(suite, /\bInvokeLaneFixtureOrchestrator\b/)
  assert.doesNotMatch(bootstrap, /\bPrepareFixtures\s*\(/)
  assert.doesNotMatch(bootstrap, /RunParallel "bootstrap-runtime-fixtures"/)
  assert.equal(pkg.scripts['prepare:binary-smoke:auth-users'], undefined)
  assert.equal(pkg.scripts['prepare:playwright:fixtures'], undefined)
  assert.equal(pkg.scripts['prepare:playwright:sessions'], undefined)
  assert.doesNotMatch(publicProducer, /using direct DB seed|seedPublicFixturesViaApi|buildSeededArticleFallback/)
  assert.match(publicProducer, /transaction-fixture/)
})

test('dev receipt transition reuses only the exact run and cleans profile or service drift', () => {
  const executionIdentity = {
    runId: 'dev-0123456789abcdef',
    namespace: 'dev-0123456789abcdef',
    sourceIdentity: {
      commit: 'a'.repeat(40),
      worktreeFingerprint: `sha256:${'b'.repeat(64)}`
    },
    handles: {
      serviceGeneration: `sha256:${'c'.repeat(64)}`
    }
  }
  const receipt = {
    schema: 'fsusblog.fixture-receipt.v2',
    terminalStatus: 'verified',
    profileIdentity: {
      profileId: 'demo-public',
      profileSource: 'dev-cli',
      executionClass: 'development'
    },
    executionIdentity: {
      runId: executionIdentity.runId,
      namespace: executionIdentity.namespace,
      source: executionIdentity.sourceIdentity,
      serviceGeneration: executionIdentity.handles.serviceGeneration
    }
  }
  assert.deepEqual(
    classifyDevFixtureReceiptTransition(receipt, {
      profileId: 'demo-public',
      executionIdentity
    }),
    { action: 'reuse', reason: 'same-execution-identity' }
  )
  assert.deepEqual(
    classifyDevFixtureReceiptTransition(receipt, {
      profileId: 'none',
      executionIdentity
    }),
    { action: 'cleanup', reason: 'profile-changed' }
  )
  assert.deepEqual(
    classifyDevFixtureReceiptTransition({
      ...receipt,
      profileIdentity: {
        ...receipt.profileIdentity,
        executionClass: 'diagnostic'
      }
    }, {
      profileId: 'demo-public',
      executionIdentity
    }),
    { action: 'cleanup', reason: 'profile-evidence-changed' }
  )
  assert.deepEqual(
    classifyDevFixtureReceiptTransition(receipt, {
      profileId: 'demo-public',
      executionIdentity: {
        ...executionIdentity,
        handles: { serviceGeneration: `sha256:${'d'.repeat(64)}` }
      }
    }),
    { action: 'cleanup', reason: 'execution-identity-changed' }
  )
  assert.deepEqual(
    classifyDevFixtureReceiptTransition(null, {
      profileId: 'demo-public',
      executionIdentity
    }),
    { action: 'none', reason: 'no-previous-demo-receipt' }
  )
  assert.throws(
    () => classifyDevFixtureReceiptTransition(receipt, {
      profileId: 'demo-public',
      executionIdentity: {}
    }),
    /requires exact run, namespace, source, and service generation identity/
  )
})

test('acceptance orchestrator waves run auth and public before dependents', async () => {
  const planned = plan({ profileId: 'acceptance-representative', profileSource: 'dev-cli' })
  const order = []
  const ports = portsForPlan(planned, {
    'auth-session': { onPrepare: async () => { order.push('auth-session'); return { ok: true, strategy: 'transaction-fixture', producerId: 'auth-session' } } },
    'public-content': { onPrepare: async () => { order.push('public-content'); return { ok: true, strategy: 'transaction-fixture', producerId: 'public-content' } } },
    'account-messaging': { onPrepare: async () => { order.push('account-messaging'); return { ok: true, strategy: 'transaction-fixture', producerId: 'account-messaging' } } },
    'comment-moderation': { onPrepare: async () => { order.push('comment-moderation'); return { ok: true, strategy: 'transaction-fixture', producerId: 'comment-moderation' } } }
  })
  const receipt = await prepare(planned, ports)
  assert.equal(receipt.terminalState, 'prepared')
  assert.ok(order.indexOf('auth-session') < order.indexOf('account-messaging'))
  assert.ok(order.indexOf('public-content') < order.indexOf('comment-moderation'))
})

test('prepare passes only a verified exact-run prior FixtureReceipt to its producer', async () => {
  const planned = plan(
    { profileId: 'demo-public', profileSource: 'dev-cli', executionClass: 'development' },
    { runId: 'demo-run', namespace: 'demo-namespace' }
  )
  const demoResult = {
    producerId: 'development-demo',
    strategy: 'transaction-fixture',
    entityIdentities: [{
      kind: 'article',
      id: '101',
      variantId: 'diagnostic.development.demo.dataset',
      owner: 'demo-fixture:0123456789abcdef01234567',
      digest: `sha256:${'a'.repeat(64)}`
    }],
    observations: {
      source: 'service',
      database: {
        namespace: 'demo-namespace',
        schemaIdentity: 'public',
        entities: [{
          kind: 'article',
          id: '101',
          owned: true,
          variantId: 'diagnostic.development.demo.dataset',
          owner: 'demo-fixture:0123456789abcdef01234567'
        }]
      },
      redis: { namespace: 'demo-namespace', keys: [] },
      cache: { namespace: 'demo-namespace', entries: [] }
    },
    providedCapabilities: ['development.demo.dataset'],
    cleanupContract: { kind: 'receipt-exact-identities' }
  }
  const firstPorts = portsForPlan(planned, {
    'development-demo': {
      onPrepare: async () => demoResult,
      onVerify: async () => ({ ok: true })
    }
  })
  const firstPrepared = await prepare(planned, firstPorts)
  const verified = await verify(firstPrepared, firstPorts)

  let receivedPrevious = null
  const secondPorts = portsForPlan(planned, {
    'development-demo': {
      onPrepare: async (context) => {
        receivedPrevious = context.previousProducerReceipt
        return demoResult
      }
    }
  })
  await prepare(planned, secondPorts, undefined, { previousFixtureReceipt: verified })
  assert.deepEqual(receivedPrevious, verified.producerReceipts[0])

  const crossRun = plan(
    { profileId: 'demo-public', profileSource: 'dev-cli', executionClass: 'development' },
    { runId: 'other-run', namespace: 'demo-namespace' }
  )
  const crossRunPorts = portsForPlan(crossRun)
  await assert.rejects(
    prepare(crossRun, crossRunPorts, undefined, { previousFixtureReceipt: verified }),
    /execution identity mismatch|cross-run/
  )
  assert.equal(crossRunPorts[0].calls.prepare, 0)
})
