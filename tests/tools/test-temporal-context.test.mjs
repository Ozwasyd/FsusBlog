import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { TemporalContractError, assertMonotonicMeasurementSource, bindProducerTemporalArtifacts, createBusinessWallClock, createTemporalActual, createTemporalPlan, createTemporalReceipt, defaultTimeoutPolicyDigest, digestCanonical, materializeTemporalEnvironment, monotonicNow, projectDataScaleBusinessOutcome, projectSessionFixtureBusinessOutcome, qualificationTemporalContext, semanticOutcomeDigest, validateTemporalLedgerDocument, validateTemporalObservations, verifyTemporalReplay } = await import(new URL("../../tools/test/temporal-context.mjs", import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const identity = {
    sourceCommit: 'a'.repeat(40),
    sourceFingerprint: `sha256:${'b'.repeat(64)}`,
    producerId: 'temporal-contract-tests',
    schedulerRunId: 'run-temporal-001',
    businessEpochUtc: '2024-02-29T23:59:59.000Z',
    locale: 'en-US',
    uiLocale: 'ja-JP',
    timeoutPolicyDigest: `sha256:${'c'.repeat(64)}`
};

function fixture()
{
    const context = qualificationTemporalContext(identity);
    const plan = createTemporalPlan(context);
    const actual = createTemporalActual(context, {
        businessEpochUtc: createBusinessWallClock(context).nowIso(),
        backendCulture: 'Invariant',
        nodeTimezone: 'UTC',
        postgresTimezone: 'UTC'
    });
    const receipt = createTemporalReceipt({
        plan,
        actual,
        outcome: { rows: 3, scheduledPublishAt: '2024-03-01T00:00:00.000Z' },
        generatedAt: '2026-07-28T00:00:00.000Z'
    });
    return { actual, context, plan, receipt };
}

test('qualification context binds source, run, producer, epoch and immutable ledger', () =>
{
    const { context } = fixture();
    assert.equal(context.businessClockMode, 'fixed');
    assert.equal(context.businessClockStepPolicy, 'explicit-only');
    assert.equal(context.timezone, 'UTC');
    assert.equal(context.nodeTimezone, 'UTC');
    assert.equal(context.postgresTimezone, 'UTC');
    assert.equal(context.backendCulture, 'Invariant');
    assert.equal(context.ledgerSource.authorityKind, 'immutable-ledger');
});

test('plan, actual and receipt must exact-match every run-bound identity', () =>
{
    const { actual, plan, receipt } = fixture();
    assert.deepEqual(verifyTemporalReplay({ plan, actual, receipt }), {
        qualificationEligible: true,
        reasonCode: 'temporal.ok',
        context: actual.temporalContext,
        receiptDigest: receipt.digest
    });

    const mismatchedUnsigned = {
        ...actual,
        digest: undefined,
        run: { schedulerRunId: 'another-run' }
    };
    delete mismatchedUnsigned.digest;
    const mismatched = { ...mismatchedUnsigned, digest: digestCanonical(mismatchedUnsigned) };
    assert.throws(
        () => verifyTemporalReplay({ plan, actual: mismatched, receipt }),
        (error) => error instanceof TemporalContractError && error.reasonCode === 'temporal.run-binding-mismatch'
    );
});

test('coordinated envelope resealing cannot replace the source run or producer observed by the context', () =>
{
    for (const [section, field, changed, reasonCode] of [
        ['source', 'commit', 'd'.repeat(40), 'temporal.source-binding-mismatch'],
        ['source', 'fingerprint', `sha256:${'e'.repeat(64)}`, 'temporal.source-binding-mismatch'],
        ['run', 'schedulerRunId', 'unobserved-run', 'temporal.run-binding-mismatch'],
        ['producer', 'producerId', 'unobserved-producer', 'temporal.producer-binding-mismatch']
    ])
    {
        for (const remove of [false, true])
        {
            const { actual, plan, receipt } = structuredClone(fixture());
            for (const artifact of [plan, actual, receipt])
            {
                if (remove)
                {
                    delete artifact[section][field];
                }
                else
                {
                    artifact[section][field] = changed;
                }
                delete artifact.digest;
            }
            plan.digest = digestCanonical(plan);
            actual.digest = digestCanonical(actual);
            receipt.planDigest = plan.digest;
            receipt.actualDigest = actual.digest;
            receipt.digest = digestCanonical(receipt);
            assert.throws(() => verifyTemporalReplay({ plan, actual, receipt }),
                (error) => error instanceof TemporalContractError && error.reasonCode === reasonCode);
        }
    }
});

test('actual ingress and independent replay reject absent observed business epochs even with fresh digests', () =>
{
    const { actual, context, plan } = fixture();
    for (const observations of [undefined, null, {}, { nodeTimezone: 'UTC' },
        { ...actual.observations, businessEpochUtc: '' }])
    {
        assert.throws(() => createTemporalActual(context, observations),
            (error) => error.reasonCode === 'temporal.actual-context-missing');
        const unsignedActual = { ...actual, observations };
        delete unsignedActual.digest;
        const missing = { ...unsignedActual, digest: digestCanonical(unsignedActual) };
        const receipt = createTemporalReceipt({
            plan,
            actual: missing,
            outcome: { rows: 3 },
            generatedAt: '2026-07-28T00:00:00.000Z'
        });
        assert.throws(() => verifyTemporalReplay({ plan, actual: missing, receipt }),
            (error) => error.reasonCode === 'temporal.actual-context-missing');
    }
    assert.throws(() => bindProducerTemporalArtifacts({
        contextInput: identity,
        outcome: { rows: 3 },
        generatedAt: '2026-07-28T00:00:00.000Z'
    }), (error) => error.reasonCode === 'temporal.actual-context-missing');
});

test('qualification fails closed when plan, actual or receipt binding is absent', () =>
{
    const { actual, plan, receipt } = fixture();
    assert.throws(
        () => verifyTemporalReplay({ plan: null, actual, receipt }),
        (error) => error.reasonCode === 'temporal.plan-binding-missing'
    );
    assert.throws(
        () => verifyTemporalReplay({ plan, actual: null, receipt }),
        (error) => error.reasonCode === 'temporal.actual-context-missing'
    );
    assert.throws(
        () => verifyTemporalReplay({ plan, actual, receipt: null }),
        (error) => error.reasonCode === 'temporal.receipt-binding-missing'
    );
});

test('actual ingress and independent replay reject absent observed business epochs even with fresh digests', () =>
{
    const { actual, context, plan } = fixture();
    for (const observations of [undefined, null, {}, { nodeTimezone: 'UTC' },
        { ...actual.observations, businessEpochUtc: '' }])
    {
        assert.throws(() => createTemporalActual(context, observations),
            (error) => error.reasonCode === 'temporal.actual-context-missing');
        const unsignedActual = { ...actual, observations };
        delete unsignedActual.digest;
        const missing = { ...unsignedActual, digest: digestCanonical(unsignedActual) };
        const receipt = createTemporalReceipt({
            plan,
            actual: missing,
            outcome: { rows: 3 },
            generatedAt: '2026-07-28T00:00:00.000Z'
        });
        assert.throws(() => verifyTemporalReplay({ plan, actual: missing, receipt }),
            (error) => error.reasonCode === 'temporal.actual-context-missing');
    }
    assert.throws(() => bindProducerTemporalArtifacts({
        contextInput: identity,
        outcome: { rows: 3 },
        generatedAt: '2026-07-28T00:00:00.000Z'
    }), (error) => error.reasonCode === 'temporal.actual-context-missing');
});

test('artifact metadata does not alter semantic outcome digest', () =>
{
    const first = semanticOutcomeDigest({
        rows: 3,
        scheduledPublishAt: '2024-03-01T00:00:00.000Z',
        generatedAt: '2026-07-28T00:00:00.000Z'
    });
    const second = semanticOutcomeDigest({
        rows: 3,
        scheduledPublishAt: '2024-03-01T00:00:00.000Z',
        generatedAt: '2030-01-01T00:00:00.000Z'
    });
    assert.equal(first, second);
});

test('artifact metadata schema rejects unknown and business-bearing fields', () =>
{
    assert.equal(
        semanticOutcomeDigest({
            rows: 3,
            artifactMetadata: {
                generatedAt: '2026-07-28T00:00:00.000Z'
            }
        }),
        semanticOutcomeDigest({
            rows: 3,
            artifactMetadata: {
                generatedAt: '2030-01-01T00:00:00.000Z'
            }
        })
    );
    assert.throws(
        () => semanticOutcomeDigest({
            rows: 3,
            artifactMetadata: {
                generatedAt: '2026-07-28T00:00:00.000Z',
                exporterVersion: 'unclassified'
            }
        }),
        (error) => error.reasonCode === 'temporal.context-invalid'
    );
    assert.throws(
        () => semanticOutcomeDigest({
            rows: 3,
            artifactMetadata: {
                scheduledPublishAt: '2024-03-01T00:00:00.000Z'
            }
        }),
        (error) => error.reasonCode === 'temporal.context-invalid'
    );
});

test('business fields remain in semantic outcome digest', () =>
{
    assert.notEqual(
        semanticOutcomeDigest({ scheduledPublishAt: '2024-03-01T00:00:00.000Z' }),
        semanticOutcomeDigest({ scheduledPublishAt: '2024-03-02T00:00:00.000Z' })
    );
});

test('unknown and requires-explicit ledger dispositions are both unresolved', () =>
{
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
    };
    const result = validateTemporalLedgerDocument({
        schema: 'fsusblog.temporal-callsite-ledger.v1',
        authorityKind: 'immutable-ledger',
        governedSources: ['tests/example.test.mjs'],
        entries: [
            { ...base, callSiteId: 'example.unknown', disposition: 'unknown' },
            { ...base, callSiteId: 'example.requires-explicit', disposition: 'requires-explicit' }
        ]
    });
    assert.deepEqual(
        result.unresolved.map((entry) => entry.callSiteId),
        ['example.unknown', 'example.requires-explicit']
    );
});

test('tampered plan self digest fails closed before qualification', () =>
{
    const { actual, plan, receipt } = fixture();
    const tampered = {
        ...plan,
        temporalContext: {
            ...plan.temporalContext,
            uiLocale: 'ko-KR'
        }
    };
    assert.throws(
        () => verifyTemporalReplay({ plan: tampered, actual, receipt }),
        (error) => error.reasonCode === 'temporal.receipt-binding-mismatch'
    );
});

test('node, postgres and backend culture observation mismatches fail with dedicated reason codes', () =>
{
    const context = qualificationTemporalContext(identity);
    assert.throws(
        () => validateTemporalObservations(context, { nodeTimezone: 'America/Los_Angeles' }),
        (error) => error instanceof TemporalContractError && error.reasonCode === 'temporal.node-timezone-mismatch'
    );
    assert.throws(
        () => validateTemporalObservations(context, { postgresTimezone: 'Asia/Shanghai' }),
        (error) => error.reasonCode === 'temporal.postgres-timezone-mismatch'
    );
    assert.throws(
        () => validateTemporalObservations(context, { backendCulture: 'zh-CN' }),
        (error) => error.reasonCode === 'temporal.backend-culture-mismatch'
    );
});

test('locale matrix cases must declare locale; missing locale fails closed', () =>
{
    assert.throws(
        () => qualificationTemporalContext({
            ...identity,
            locale: undefined
        }),
        (error) => error.reasonCode === 'temporal.context-invalid'
    );
});

test('benchmark duration cannot use a frozen business wall clock', () =>
{
    assert.throws(
        () => assertMonotonicMeasurementSource('fixed'),
        (error) => error.reasonCode === 'temporal.mixed-clock'
    );
    assert.throws(
        () => assertMonotonicMeasurementSource('date-now'),
        (error) => error.reasonCode === 'temporal.mixed-clock'
    );
    assert.throws(
        () => assertMonotonicMeasurementSource('dotnet-utc-now'),
        (error) => error.reasonCode === 'temporal.mixed-clock'
    );
    assert.equal(assertMonotonicMeasurementSource('performance-now'), 'performance-now');
    const first = monotonicNow('performance-now');
    const second = monotonicNow('performance-now');
    assert.ok(Number.isFinite(first));
    assert.ok(second >= first);
});

test('semantic outcome keeps business timestamps and ignores artifact metadata only', () =>
{
    const withSchedule = semanticOutcomeDigest({
        scheduledPublishAt: '2024-03-01T00:00:00.000Z',
        expiresAt: '2024-03-08T00:00:00.000Z',
        generatedAt: '2026-07-28T00:00:00.000Z'
    });
    const withoutSchedule = semanticOutcomeDigest({
        expiresAt: '2024-03-08T00:00:00.000Z',
        generatedAt: '2026-07-28T00:00:00.000Z'
    });
    assert.notEqual(withSchedule, withoutSchedule);
});

test('host TZ env does not rewrite fixed qualification temporal context fields', () =>
{
    const previous = process.env.TZ;
    try
    {
        process.env.TZ = 'America/Los_Angeles';
        const context = qualificationTemporalContext(identity);
        assert.equal(context.timezone, 'UTC');
        assert.equal(context.nodeTimezone, 'UTC');
        assert.equal(context.postgresTimezone, 'UTC');
        assert.equal(context.businessEpochUtc, '2024-02-29T23:59:59.000Z');
    }
    finally
    {
        if (previous === undefined)
        {
            delete process.env.TZ;
        }
        else
        {
            process.env.TZ = previous;
        }
    }
});

test('business wall clock advances explicitly without freezing monotonic measurement', () =>
{
    const context = qualificationTemporalContext(identity);
    const wall = createBusinessWallClock(context);
    const firstMono = monotonicNow('performance-now');
    assert.equal(wall.nowIso(), '2024-02-29T23:59:59.000Z');
    assert.equal(wall.advanceMs(3_600_000), '2024-03-01T00:59:59.000Z');
    const secondMono = monotonicNow('performance-now');
    assert.ok(secondMono >= firstMono);
    assert.throws(
        () => wall.advanceMs(-1),
        (error) => error.reasonCode === 'temporal.context-invalid'
    );
});

test('business epoch ingress rejects normalized calendar dates before clock construction', () =>
{
    for (const businessEpochUtc of [
        '2023-02-29T12:00:00Z',
        '2024-02-30T12:00:00.000Z',
        '2024-04-31T12:00:00.0000000Z',
        '2024-02-29T24:00:00Z',
        '0000-01-01T00:00:00Z'
    ])
    {
        assert.ok(Number.isFinite(Date.parse(businessEpochUtc)));
        assert.throws(() => qualificationTemporalContext({ ...identity, businessEpochUtc }),
            (error) => error instanceof TemporalContractError && error.reasonCode === 'temporal.context-invalid');
        for (const project of [projectSessionFixtureBusinessOutcome, projectDataScaleBusinessOutcome])
        {
            assert.throws(() => project({ businessEpochUtc, articleCount: 1, commentCount: 1 }),
                (error) => error instanceof TemporalContractError && error.reasonCode === 'temporal.context-invalid');
        }
    }
});

test('business epoch ingress preserves valid leap century and boundary dates', () =>
{
    for (const businessEpochUtc of [
        '0001-01-01T00:00:00Z',
        '2000-02-29T00:00:00.000Z',
        '2024-02-29T23:59:59.1230000Z',
        '9999-12-31T23:59:59.999Z'
    ])
    {
        const wall = createBusinessWallClock(qualificationTemporalContext({ ...identity, businessEpochUtc }));
        assert.equal(wall.nowIso(), businessEpochUtc);
    }
});

test('advancement cannot leave the backend calendar range or alter the admitted instant on rejection', () =>
{
    const businessEpochUtc = '9999-12-31T23:59:59.999Z';
    const wall = createBusinessWallClock(qualificationTemporalContext({ ...identity, businessEpochUtc }));
    assert.throws(() => wall.advanceMs(1),
        (error) => error instanceof TemporalContractError && error.reasonCode === 'temporal.context-invalid');
    assert.equal(wall.nowIso(), businessEpochUtc);
    assert.equal(wall.advanceMs(0), businessEpochUtc);
});

test('business epoch ingress rejects nonzero submillisecond digits before clock construction', () =>
{
    for (const businessEpochUtc of [
        '2024-02-29T23:59:59.0001Z',
        '2024-02-29T23:59:59.1234567Z',
        '2024-02-29T23:59:59.0000001Z'
    ])
    {
        assert.match(businessEpochUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,7}Z$/u);
        assert.ok(Number.isFinite(Date.parse(businessEpochUtc)));
        assert.throws(
            () => qualificationTemporalContext({ ...identity, businessEpochUtc }),
            (error) => error instanceof TemporalContractError && error.reasonCode === 'temporal.precision-loss'
        );
        for (const project of [projectSessionFixtureBusinessOutcome, projectDataScaleBusinessOutcome])
        {
            assert.throws(() => project({ businessEpochUtc, articleCount: 1, commentCount: 1 }),
                (error) => error instanceof TemporalContractError && error.reasonCode === 'temporal.precision-loss');
        }
    }
});

test('business clock formats its actual instant with every original lossless RFC3339 shape', () =>
{
    for (const [businessEpochUtc, advancedEpochUtc] of [
        ['2024-02-29T23:59:59Z', '2024-02-29T23:59:59.001Z'],
        ['2024-02-29T23:59:59.1Z', '2024-02-29T23:59:59.101Z'],
        ['2024-02-29T23:59:59.12Z', '2024-02-29T23:59:59.121Z'],
        ['2024-02-29T23:59:59.123Z', '2024-02-29T23:59:59.124Z'],
        ['2024-02-29T23:59:59.1230Z', '2024-02-29T23:59:59.1240Z'],
        ['2024-02-29T23:59:59.12300Z', '2024-02-29T23:59:59.12400Z'],
        ['2024-02-29T23:59:59.123000Z', '2024-02-29T23:59:59.124000Z'],
        ['2024-02-29T23:59:59.1230000Z', '2024-02-29T23:59:59.1240000Z']
    ])
    {
        const context = qualificationTemporalContext({ ...identity, businessEpochUtc });
        const wall = createBusinessWallClock(context);
        assert.equal(wall.nowMs(), Date.parse(businessEpochUtc));
        assert.equal(wall.nowIso(), businessEpochUtc);
        for (const project of [projectSessionFixtureBusinessOutcome, projectDataScaleBusinessOutcome])
        {
            const projected = project({ businessEpochUtc: wall.nowIso(), articleCount: 1, commentCount: 1 });
            assert.equal(projected.businessEpochUtc, businessEpochUtc);
            assert.equal(Date.parse(projected.businessEpochUtc), wall.nowMs());
        }
        const plan = createTemporalPlan(context);
        const actual = createTemporalActual(context, { businessEpochUtc: wall.nowIso(), nodeTimezone: 'UTC' });
        const receipt = createTemporalReceipt({ plan, actual, outcome: { actualEpoch: wall.nowIso() },
            generatedAt: '2026-10-03T00:00:00.000Z' });
        assert.equal(verifyTemporalReplay({ plan, actual, receipt }).reasonCode, 'temporal.ok');

        assert.equal(wall.advanceMs(1), advancedEpochUtc);
        assert.equal(wall.nowMs(), Date.parse(businessEpochUtc) + 1);
        assert.equal(wall.nowIso(), advancedEpochUtc);
        assert.notEqual(wall.nowIso(), businessEpochUtc);
        for (const project of [projectSessionFixtureBusinessOutcome, projectDataScaleBusinessOutcome])
        {
            const projected = project({ businessEpochUtc: wall.nowIso(), articleCount: 1, commentCount: 1 });
            assert.equal(projected.businessEpochUtc, advancedEpochUtc);
            assert.equal(Date.parse(projected.businessEpochUtc), wall.nowMs());
        }
        assert.throws(
            () => createTemporalActual(context, { businessEpochUtc: wall.nowIso() }),
            (error) => error.reasonCode === 'temporal.actual-context-mismatch'
        );
    }
});

test('fractional and overflowing business clock advances cannot alter the admitted instant', () =>
{
    const context = qualificationTemporalContext(identity);
    const wall = createBusinessWallClock(context);
    const originalInstant = wall.nowMs();
    for (const deltaMs of [0.1, Number.MAX_SAFE_INTEGER])
    {
        assert.throws(() => wall.advanceMs(deltaMs),
            (error) => error.reasonCode === 'temporal.context-invalid');
        assert.equal(wall.nowMs(), originalInstant);
        assert.equal(wall.nowIso(), identity.businessEpochUtc);
    }
});

test('data-scale projection is stable under fixed business epoch and changes when epoch changes', () =>
{
    const first = projectDataScaleBusinessOutcome({
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        tier: 'scale-xs',
        namespace: 'local'
    });
    const second = projectDataScaleBusinessOutcome({
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        tier: 'scale-xs',
        namespace: 'local'
    });
    assert.deepEqual(first, second);
    assert.equal(first.businessTimestamps.articles[0].createTime, '2024-02-29T23:59:58.000Z');
    assert.equal(first.businessTimestamps.articles[0].publishedAt, '2024-02-28T23:59:59.000Z');
    assert.equal(
        semanticOutcomeDigest(first),
        semanticOutcomeDigest(second)
    );
    const shifted = projectDataScaleBusinessOutcome({
        businessEpochUtc: '2024-03-01T00:00:00.000Z',
        tier: 'scale-xs',
        namespace: 'local'
    });
    assert.notEqual(semanticOutcomeDigest(first), semanticOutcomeDigest(shifted));
});

test('producer plan/actual/receipt bind data-scale seed outcome end-to-end', () =>
{
    const outcome = projectDataScaleBusinessOutcome({
        businessEpochUtc: identity.businessEpochUtc,
        tier: 'scale-xs',
        namespace: 'local'
    });
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
    });
    assert.equal(bound.verification.reasonCode, 'temporal.ok');
    assert.equal(bound.plan.producer.producerId, 'temporal-contract-tests');
    assert.equal(bound.receipt.semanticOutcomeDigest, semanticOutcomeDigest(outcome));
    const env = materializeTemporalEnvironment(bound.context);
    assert.equal(env.TZ, 'UTC');
    assert.equal(env.FSUSBLOG_TEST_BUSINESS_EPOCH_UTC, identity.businessEpochUtc);
    assert.ok(env.FSUSBLOG_TEMPORAL_CONTEXT_JSON.includes(identity.businessEpochUtc));
});

test('CLI data-scale-seed producer writes verifiable temporal plan/actual/receipt', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-temporal-producer-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const outDir = path.join(temp, 'out');
    const env = {
        ...process.env,
        FSUSBLOG_TEST_RUN_ID: 'run-temporal-producer-001',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: `sha256:${'b'.repeat(64)}`,
        FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: '2024-02-29T23:59:59.000Z',
        FSUSBLOG_TIMEOUT_POLICY_DIGEST: defaultTimeoutPolicyDigest()
    };
    const produce = spawnSync(
        process.execPath,
        [
            path.join(repositoryRoot, 'tools/test/produce-temporal-qualification.mjs'),
            '--producer', 'data-scale-seed',
            '--tier', 'scale-xs',
            '--out-dir', outDir
        ],
        { cwd: repositoryRoot, encoding: 'utf8', env, timeout: 15_000 }
    );
    assert.equal(produce.status, 0, produce.stderr || produce.stdout);
    const plan = JSON.parse(fs.readFileSync(path.join(outDir, 'temporal-plan.json'), 'utf8'));
    const actual = JSON.parse(fs.readFileSync(path.join(outDir, 'temporal-actual.json'), 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(path.join(outDir, 'temporal-receipt.json'), 'utf8'));
    assert.equal(plan.producer.producerId, 'data-scale-seed');
    assert.equal(verifyTemporalReplay({ plan, actual, receipt }).reasonCode, 'temporal.ok');

    const verify = spawnSync(
        process.execPath,
        [
            path.join(repositoryRoot, 'tools/test/verify-temporal-replay.mjs'),
            '--plan', path.join(outDir, 'temporal-plan.json'),
            '--actual', path.join(outDir, 'temporal-actual.json'),
            '--receipt', path.join(outDir, 'temporal-receipt.json')
        ],
        { cwd: repositoryRoot, encoding: 'utf8', timeout: 10_000 }
    );
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    assert.match(verify.stdout, /qualificationEligible=true/);
});

test('session-fixture projection binds JWT/session expiry to fixed business epoch', () =>
{
    const first = projectSessionFixtureBusinessOutcome({
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        accessTokenExpiresMinutes: 15,
        rememberMe: false
    });
    const second = projectSessionFixtureBusinessOutcome({
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        accessTokenExpiresMinutes: 15,
        rememberMe: false
    });
    assert.deepEqual(first, second);
    assert.equal(first.authenticatedAtEpochSeconds, 1_709_251_199);
    assert.equal(first.accessTokenExpiresAtEpochSeconds, 1_709_251_199 + 15 * 60);
    assert.equal(first.userSession.idleExpiresOffsetSeconds, 2 * 3_600);
    assert.equal(first.adminSession.absoluteExpiresOffsetSeconds, 12 * 3_600);
    assert.equal(semanticOutcomeDigest(first), semanticOutcomeDigest(second));
    const shifted = projectSessionFixtureBusinessOutcome({
        businessEpochUtc: '2024-03-01T00:00:00.000Z',
        accessTokenExpiresMinutes: 15,
        rememberMe: false
    });
    assert.notEqual(semanticOutcomeDigest(first), semanticOutcomeDigest(shifted));
});

test('CLI session-fixture producer writes verifiable temporal plan/actual/receipt', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-temporal-session-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const outDir = path.join(temp, 'out');
    const env = {
        ...process.env,
        FSUSBLOG_TEST_RUN_ID: 'run-temporal-session-001',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: `sha256:${'b'.repeat(64)}`,
        FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: '2024-02-29T23:59:59.000Z',
        FSUSBLOG_TIMEOUT_POLICY_DIGEST: defaultTimeoutPolicyDigest()
    };
    const produce = spawnSync(
        process.execPath,
        [
            path.join(repositoryRoot, 'tools/test/produce-temporal-qualification.mjs'),
            '--producer', 'session-fixture',
            '--out-dir', outDir
        ],
        { cwd: repositoryRoot, encoding: 'utf8', env, timeout: 15_000 }
    );
    assert.equal(produce.status, 0, produce.stderr || produce.stdout);
    const plan = JSON.parse(fs.readFileSync(path.join(outDir, 'temporal-plan.json'), 'utf8'));
    const actual = JSON.parse(fs.readFileSync(path.join(outDir, 'temporal-actual.json'), 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(path.join(outDir, 'temporal-receipt.json'), 'utf8'));
    const outcome = JSON.parse(fs.readFileSync(path.join(outDir, 'semantic-outcome.json'), 'utf8'));
    assert.equal(plan.producer.producerId, 'session-fixture');
    assert.equal(outcome.authenticatedAtEpochSeconds, 1_709_251_199);
    assert.equal(verifyTemporalReplay({ plan, actual, receipt }).reasonCode, 'temporal.ok');
    assert.equal(receipt.semanticOutcomeDigest, semanticOutcomeDigest(outcome));
});


test('temporal replay reads fresh policy bytes and rejects a redirected authority', (t) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-temporal-fresh-authority-'));
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    for (const relative of [
        'tools/test/temporal-context.mjs',
        'tools/test/temporal-context-contract.mjs',
        'config/testing/temporal-policy.json',
        'config/testing/temporal-callsite-dispositions.json'
    ])
    {
        const target = path.join(fixtureRoot, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, relative), target);
    }
    const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { readTemporalReplayAuthority, qualificationTemporalContext, validateTemporalContext }
            from './tools/test/temporal-context.mjs';
        const file = 'config/testing/temporal-policy.json';
        const input = ${JSON.stringify(identity)};
        const previous = qualificationTemporalContext(input);
        const original = readTemporalReplayAuthority();
        const changed = structuredClone(original.policy);
        changed.qualificationDefaults.calendar = 'fresh-policy-calendar';
        fs.writeFileSync(file, JSON.stringify(changed));
        assert.deepEqual(readTemporalReplayAuthority().policy, changed);
        assert.throws(() => validateTemporalContext(previous), /qualification policy|policy digest/);
        const current = qualificationTemporalContext(input);
        assert.equal(current.calendar, changed.qualificationDefaults.calendar);
        assert.notEqual(current.temporalPolicyDigest, previous.temporalPolicyDigest);
        fs.renameSync(file, file + '.original');
        fs.symlinkSync('temporal-policy.json.original', file);
        assert.throws(() => readTemporalReplayAuthority(), /must not be a symlink/);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: fixtureRoot, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
});
