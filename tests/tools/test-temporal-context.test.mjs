import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  TemporalContractError,
  assertMonotonicMeasurementSource,
  bindProducerTemporalArtifacts,
  createBusinessWallClock,
  createTemporalActual,
  createTemporalPlan,
  createTemporalReceipt,
  defaultTimeoutPolicyDigest,
  digestCanonical,
  materializeTemporalEnvironment,
  monotonicNow,
  projectDataScaleBusinessOutcome,
  projectSessionFixtureBusinessOutcome,
  qualificationTemporalContext,
  semanticOutcomeDigest,
  validateTemporalLedgerDocument,
  validateTemporalObservations,
  verifyTemporalReplay
} from '../../tools/test/temporal-context.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const identity = {
  sourceCommit: 'a'.repeat(40),
  sourceFingerprint: `sha256:${'b'.repeat(64)}`,
  producerId: 'temporal-contract-tests',
  schedulerRunId: 'run-temporal-001',
  businessEpochUtc: '2024-02-29T23:59:59.000Z',
  locale: 'en-US',
  uiLocale: 'ja-JP',
  timeoutPolicyDigest: `sha256:${'c'.repeat(64)}`
}

function fixture() {
  const context = qualificationTemporalContext(identity)
  const plan = createTemporalPlan(context)
  const actual = createTemporalActual(context, {
    backendCulture: 'Invariant',
    nodeTimezone: 'UTC',
    postgresTimezone: 'UTC'
  })
  const receipt = createTemporalReceipt({
    plan,
    actual,
    outcome: { rows: 3, scheduledPublishAt: '2024-03-01T00:00:00.000Z' },
    generatedAt: '2026-07-28T00:00:00.000Z'
  })
  return { actual, context, plan, receipt }
}

test('qualification context binds source, run, producer, epoch and immutable ledger', () => {
  const { context } = fixture()
  assert.equal(context.businessClockMode, 'fixed')
  assert.equal(context.businessClockStepPolicy, 'explicit-only')
  assert.equal(context.timezone, 'UTC')
  assert.equal(context.nodeTimezone, 'UTC')
  assert.equal(context.postgresTimezone, 'UTC')
  assert.equal(context.backendCulture, 'Invariant')
  assert.equal(context.ledgerSource.authorityKind, 'immutable-ledger')
})

test('plan, actual and receipt must exact-match every run-bound identity', () => {
  const { actual, plan, receipt } = fixture()
  assert.deepEqual(verifyTemporalReplay({ plan, actual, receipt }), {
    qualificationEligible: true,
    reasonCode: 'temporal.ok',
    context: actual.temporalContext,
    receiptDigest: receipt.digest
  })

  const mismatchedUnsigned = {
    ...actual,
    digest: undefined,
    run: { schedulerRunId: 'another-run' }
  }
  delete mismatchedUnsigned.digest
  const mismatched = { ...mismatchedUnsigned, digest: digestCanonical(mismatchedUnsigned) }
  assert.throws(
    () => verifyTemporalReplay({ plan, actual: mismatched, receipt }),
    (error) => error instanceof TemporalContractError && error.reasonCode === 'temporal.run-binding-mismatch'
  )
})

test('qualification fails closed when plan, actual or receipt binding is absent', () => {
  const { actual, plan, receipt } = fixture()
  assert.throws(
    () => verifyTemporalReplay({ plan: null, actual, receipt }),
    (error) => error.reasonCode === 'temporal.plan-binding-missing'
  )
  assert.throws(
    () => verifyTemporalReplay({ plan, actual: null, receipt }),
    (error) => error.reasonCode === 'temporal.actual-context-missing'
  )
  assert.throws(
    () => verifyTemporalReplay({ plan, actual, receipt: null }),
    (error) => error.reasonCode === 'temporal.receipt-binding-missing'
  )
})

test('artifact metadata does not alter semantic outcome digest', () => {
  const first = semanticOutcomeDigest({
    rows: 3,
    scheduledPublishAt: '2024-03-01T00:00:00.000Z',
    generatedAt: '2026-07-28T00:00:00.000Z'
  })
  const second = semanticOutcomeDigest({
    rows: 3,
    scheduledPublishAt: '2024-03-01T00:00:00.000Z',
    generatedAt: '2030-01-01T00:00:00.000Z'
  })
  assert.equal(first, second)
})

test('business fields remain in semantic outcome digest', () => {
  assert.notEqual(
    semanticOutcomeDigest({ scheduledPublishAt: '2024-03-01T00:00:00.000Z' }),
    semanticOutcomeDigest({ scheduledPublishAt: '2024-03-02T00:00:00.000Z' })
  )
})

test('unknown and requires-explicit ledger dispositions are both unresolved', () => {
  const base = {
    path: 'tests/example.test.mjs',
    symbol: 'example',
    sourceAnchor: 'Date.now()',
    api: 'Date.now',
    clockKind: 'business-wall',
    authorityKind: 'canonical-business-epoch',
    ingress: 'canonical-injected',
    owner: 'test-governance',
    semanticEffect: 'included'
  }
  const result = validateTemporalLedgerDocument({
    schema: 'fsusblog.temporal-callsite-ledger.v1',
    authorityKind: 'immutable-ledger',
    governedSources: ['tests/example.test.mjs'],
    entries: [
      { ...base, callSiteId: 'example.unknown', disposition: 'unknown' },
      { ...base, callSiteId: 'example.requires-explicit', disposition: 'requires-explicit' }
    ]
  })
  assert.deepEqual(
    result.unresolved.map((entry) => entry.callSiteId),
    ['example.unknown', 'example.requires-explicit']
  )
})

test('tampered plan self digest fails closed before qualification', () => {
  const { actual, plan, receipt } = fixture()
  const tampered = {
    ...plan,
    temporalContext: {
      ...plan.temporalContext,
      uiLocale: 'ko-KR'
    }
  }
  assert.throws(
    () => verifyTemporalReplay({ plan: tampered, actual, receipt }),
    (error) => error.reasonCode === 'temporal.receipt-binding-mismatch'
  )
})

test('node, postgres and backend culture observation mismatches fail with dedicated reason codes', () => {
  const context = qualificationTemporalContext(identity)
  assert.throws(
    () => validateTemporalObservations(context, { nodeTimezone: 'America/Los_Angeles' }),
    (error) => error instanceof TemporalContractError && error.reasonCode === 'temporal.node-timezone-mismatch'
  )
  assert.throws(
    () => validateTemporalObservations(context, { postgresTimezone: 'Asia/Shanghai' }),
    (error) => error.reasonCode === 'temporal.postgres-timezone-mismatch'
  )
  assert.throws(
    () => validateTemporalObservations(context, { backendCulture: 'zh-CN' }),
    (error) => error.reasonCode === 'temporal.backend-culture-mismatch'
  )
})

test('locale matrix cases must declare locale; missing locale fails closed', () => {
  assert.throws(
    () => qualificationTemporalContext({
      ...identity,
      locale: undefined
    }),
    (error) => error.reasonCode === 'temporal.context-invalid'
  )
})

test('benchmark duration cannot use a frozen business wall clock', () => {
  assert.throws(
    () => assertMonotonicMeasurementSource('fixed'),
    (error) => error.reasonCode === 'temporal.mixed-clock'
  )
  assert.throws(
    () => assertMonotonicMeasurementSource('date-now'),
    (error) => error.reasonCode === 'temporal.mixed-clock'
  )
  assert.throws(
    () => assertMonotonicMeasurementSource('dotnet-utc-now'),
    (error) => error.reasonCode === 'temporal.mixed-clock'
  )
  assert.equal(assertMonotonicMeasurementSource('performance-now'), 'performance-now')
  const first = monotonicNow('performance-now')
  const second = monotonicNow('performance-now')
  assert.ok(Number.isFinite(first))
  assert.ok(second >= first)
})

test('semantic outcome keeps business timestamps and ignores artifact metadata only', () => {
  const withSchedule = semanticOutcomeDigest({
    scheduledPublishAt: '2024-03-01T00:00:00.000Z',
    expiresAt: '2024-03-08T00:00:00.000Z',
    generatedAt: '2026-07-28T00:00:00.000Z'
  })
  const withoutSchedule = semanticOutcomeDigest({
    expiresAt: '2024-03-08T00:00:00.000Z',
    generatedAt: '2026-07-28T00:00:00.000Z'
  })
  assert.notEqual(withSchedule, withoutSchedule)
})

test('host TZ env does not rewrite fixed qualification temporal context fields', () => {
  const previous = process.env.TZ
  try {
    process.env.TZ = 'America/Los_Angeles'
    const context = qualificationTemporalContext(identity)
    assert.equal(context.timezone, 'UTC')
    assert.equal(context.nodeTimezone, 'UTC')
    assert.equal(context.postgresTimezone, 'UTC')
    assert.equal(context.businessEpochUtc, '2024-02-29T23:59:59.000Z')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('business wall clock advances explicitly without freezing monotonic measurement', () => {
  const context = qualificationTemporalContext(identity)
  const wall = createBusinessWallClock(context)
  const firstMono = monotonicNow('performance-now')
  assert.equal(wall.nowIso(), '2024-02-29T23:59:59.000Z')
  assert.equal(wall.advanceMs(3_600_000), '2024-03-01T00:59:59.000Z')
  const secondMono = monotonicNow('performance-now')
  assert.ok(secondMono >= firstMono)
  assert.throws(
    () => wall.advanceMs(-1),
    (error) => error.reasonCode === 'temporal.context-invalid'
  )
})

test('data-scale projection is stable under fixed business epoch and changes when epoch changes', () => {
  const first = projectDataScaleBusinessOutcome({
    businessEpochUtc: '2024-02-29T23:59:59.000Z',
    tier: 'scale-xs',
    namespace: 'local'
  })
  const second = projectDataScaleBusinessOutcome({
    businessEpochUtc: '2024-02-29T23:59:59.000Z',
    tier: 'scale-xs',
    namespace: 'local'
  })
  assert.deepEqual(first, second)
  assert.equal(first.businessTimestamps.articles[0].createTime, '2024-02-29T23:59:58.000Z')
  assert.equal(first.businessTimestamps.articles[0].publishedAt, '2024-02-28T23:59:59.000Z')
  assert.equal(
    semanticOutcomeDigest(first),
    semanticOutcomeDigest(second)
  )
  const shifted = projectDataScaleBusinessOutcome({
    businessEpochUtc: '2024-03-01T00:00:00.000Z',
    tier: 'scale-xs',
    namespace: 'local'
  })
  assert.notEqual(semanticOutcomeDigest(first), semanticOutcomeDigest(shifted))
})

test('producer plan/actual/receipt bind data-scale seed outcome end-to-end', () => {
  const outcome = projectDataScaleBusinessOutcome({
    businessEpochUtc: identity.businessEpochUtc,
    tier: 'scale-xs',
    namespace: 'local'
  })
  const bound = bindProducerTemporalArtifacts({
    contextInput: identity,
    outcome,
    observations: {
      backendCulture: 'Invariant',
      nodeTimezone: 'UTC',
      postgresTimezone: 'UTC',
      businessEpochUtc: identity.businessEpochUtc,
      timezone: 'UTC',
      locale: identity.locale,
      uiLocale: identity.uiLocale,
      calendar: 'gregory',
      firstDayOfWeek: 'monday',
      monotonicClockSource: 'performance-now'
    },
    generatedAt: '2026-07-28T12:00:00.000Z'
  })
  assert.equal(bound.verification.reasonCode, 'temporal.ok')
  assert.equal(bound.plan.producer.producerId, 'temporal-contract-tests')
  assert.equal(bound.receipt.semanticOutcomeDigest, semanticOutcomeDigest(outcome))
  const env = materializeTemporalEnvironment(bound.context)
  assert.equal(env.TZ, 'UTC')
  assert.equal(env.FSUSBLOG_TEST_BUSINESS_EPOCH_UTC, identity.businessEpochUtc)
  assert.ok(env.FSUSBLOG_TEMPORAL_CONTEXT_JSON.includes(identity.businessEpochUtc))
})

test('CLI data-scale-seed producer writes verifiable temporal plan/actual/receipt', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-temporal-producer-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const outDir = path.join(temp, 'out')
  const env = {
    ...process.env,
    FSUSBLOG_TEST_RUN_ID: 'run-temporal-producer-001',
    FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: `sha256:${'b'.repeat(64)}`,
    FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: '2024-02-29T23:59:59.000Z',
    FSUSBLOG_TIMEOUT_POLICY_DIGEST: defaultTimeoutPolicyDigest()
  }
  const produce = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'tools/test/produce-temporal-qualification.mjs'),
      '--producer', 'data-scale-seed',
      '--tier', 'scale-xs',
      '--out-dir', outDir
    ],
    { cwd: repositoryRoot, encoding: 'utf8', env, timeout: 15_000 }
  )
  assert.equal(produce.status, 0, produce.stderr || produce.stdout)
  const plan = JSON.parse(fs.readFileSync(path.join(outDir, 'temporal-plan.json'), 'utf8'))
  const actual = JSON.parse(fs.readFileSync(path.join(outDir, 'temporal-actual.json'), 'utf8'))
  const receipt = JSON.parse(fs.readFileSync(path.join(outDir, 'temporal-receipt.json'), 'utf8'))
  assert.equal(plan.producer.producerId, 'data-scale-seed')
  assert.equal(verifyTemporalReplay({ plan, actual, receipt }).reasonCode, 'temporal.ok')

  const verify = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'tools/test/verify-temporal-replay.mjs'),
      '--plan', path.join(outDir, 'temporal-plan.json'),
      '--actual', path.join(outDir, 'temporal-actual.json'),
      '--receipt', path.join(outDir, 'temporal-receipt.json')
    ],
    { cwd: repositoryRoot, encoding: 'utf8', timeout: 10_000 }
  )
  assert.equal(verify.status, 0, verify.stderr || verify.stdout)
  assert.match(verify.stdout, /qualificationEligible=true/)
})

test('session-fixture projection binds JWT/session expiry to fixed business epoch', () => {
  const first = projectSessionFixtureBusinessOutcome({
    businessEpochUtc: '2024-02-29T23:59:59.000Z',
    accessTokenExpiresMinutes: 15,
    rememberMe: false
  })
  const second = projectSessionFixtureBusinessOutcome({
    businessEpochUtc: '2024-02-29T23:59:59.000Z',
    accessTokenExpiresMinutes: 15,
    rememberMe: false
  })
  assert.deepEqual(first, second)
  assert.equal(first.authenticatedAtEpochSeconds, 1_709_251_199)
  assert.equal(first.accessTokenExpiresAtEpochSeconds, 1_709_251_199 + 15 * 60)
  assert.equal(first.userSession.idleExpiresOffsetSeconds, 2 * 3_600)
  assert.equal(first.adminSession.absoluteExpiresOffsetSeconds, 12 * 3_600)
  assert.equal(semanticOutcomeDigest(first), semanticOutcomeDigest(second))
  const shifted = projectSessionFixtureBusinessOutcome({
    businessEpochUtc: '2024-03-01T00:00:00.000Z',
    accessTokenExpiresMinutes: 15,
    rememberMe: false
  })
  assert.notEqual(semanticOutcomeDigest(first), semanticOutcomeDigest(shifted))
})

test('CLI session-fixture producer writes verifiable temporal plan/actual/receipt', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-temporal-session-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const outDir = path.join(temp, 'out')
  const env = {
    ...process.env,
    FSUSBLOG_TEST_RUN_ID: 'run-temporal-session-001',
    FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: `sha256:${'b'.repeat(64)}`,
    FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: '2024-02-29T23:59:59.000Z',
    FSUSBLOG_TIMEOUT_POLICY_DIGEST: defaultTimeoutPolicyDigest()
  }
  const produce = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'tools/test/produce-temporal-qualification.mjs'),
      '--producer', 'session-fixture',
      '--out-dir', outDir
    ],
    { cwd: repositoryRoot, encoding: 'utf8', env, timeout: 15_000 }
  )
  assert.equal(produce.status, 0, produce.stderr || produce.stdout)
  const plan = JSON.parse(fs.readFileSync(path.join(outDir, 'temporal-plan.json'), 'utf8'))
  const actual = JSON.parse(fs.readFileSync(path.join(outDir, 'temporal-actual.json'), 'utf8'))
  const receipt = JSON.parse(fs.readFileSync(path.join(outDir, 'temporal-receipt.json'), 'utf8'))
  const outcome = JSON.parse(fs.readFileSync(path.join(outDir, 'semantic-outcome.json'), 'utf8'))
  assert.equal(plan.producer.producerId, 'session-fixture')
  assert.equal(outcome.authenticatedAtEpochSeconds, 1_709_251_199)
  assert.equal(verifyTemporalReplay({ plan, actual, receipt }).reasonCode, 'temporal.ok')
  assert.equal(receipt.semanticOutcomeDigest, semanticOutcomeDigest(outcome))
})
