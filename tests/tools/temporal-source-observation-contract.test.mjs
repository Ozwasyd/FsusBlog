import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { validateTemporalSourceObservation } = await import(new URL(
    '../../tools/test/temporal-source-observation-contract.mjs', import.meta.url));
const { defaultTimeoutPolicyDigest, materializeTemporalEnvironment, qualificationTemporalContext, readTemporalReplayAuthority } = await import(new URL(
    '../../tools/test/temporal-context.mjs', import.meta.url));

function fixture()
{
    const context = qualificationTemporalContext({
        sourceCommit: 'a'.repeat(40),
        sourceFingerprint: `sha256:${'b'.repeat(64)}`,
        producerId: 'matrix-governance',
        schedulerRunId: 'temporal-source-observation-controls',
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        locale: 'en-US',
        uiLocale: 'en-US',
        timeoutPolicyDigest: defaultTimeoutPolicyDigest()
    });
    const backend = {
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        backendCulture: 'Invariant',
        postgresTimezone: 'UTC'
    };
    return {
        context,
        authority: readTemporalReplayAuthority(),
        observations: {
            backend,
            node: {
                businessEpochUtc: backend.businessEpochUtc,
                timezone: 'UTC',
                locale: 'en-US',
                nodeTimezone: 'UTC',
                monotonicClockSource: 'performance-now',
                observationBoundary: 'target-node-process-exit-handshake'
            },
            postgres: { businessEpochUtc: backend.businessEpochUtc, timezone: 'UTC' },
            browser: {
                ...backend,
                browserBusinessEpochUtc: backend.businessEpochUtc,
                locale: 'en-US',
                timezoneId: 'UTC',
                nodeTimezone: 'UTC'
            }
        }
    };
}

function verify(kind, observation, values = fixture())
{
    return validateTemporalSourceObservation({ kind, context: values.context, observation }, values.authority);
}

function cliFixture(t)
{
    const values = fixture();
    const scratch = mkdtempSync(path.join(tmpdir(), 'temporal-source-ingress-'));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const env = { ...process.env, ...materializeTemporalEnvironment(values.context) };
    delete env.FSUSBLOG_TEMPORAL_CONTEXT_FILE;
    const cliPath = fileURLToPath(new URL('../../tools/test/verify-temporal-producers.mjs', import.meta.url));
    return {
        ...values,
        run(kind, observationJson)
        {
            const file = path.join(scratch, 'observation.json');
            writeFileSync(file, observationJson);
            return spawnSync(process.execPath, [cliPath, '--kind', kind, '--observation', file], {
                cwd: scratch, env, encoding: 'utf8', timeout: 10_000
            });
        }
    };
}

test('source verifier accepts complete actual observations without copying plan-only fields', () =>
{
    const values = fixture();
    for (const [kind, observation] of Object.entries(values.observations))
    {
        const input = { ...observation, producerEvidence: 'original-source-evidence' };
        const before = structuredClone(input);
        const actual = verify(kind, input, values);
        assert.equal(Object.isFrozen(actual), true);
        assert.equal(actual.businessEpochUtc, observation.businessEpochUtc);
        assert.equal(actual.producerEvidence, input.producerEvidence);
        assert.equal(Object.hasOwn(actual, 'calendar'), false);
        assert.equal(Object.hasOwn(actual, 'firstDayOfWeek'), false);
        assert.deepEqual(input, before);
    }
});

test('source verifier refuses empty and non-object backend and node ingress', () =>
{
    for (const kind of ['backend', 'node', 'postgres', 'browser'])
    {
        for (const observation of [{}, null, undefined, [], 'observed'])
        {
            assert.throws(() => verify(kind, observation),
                { reasonCode: 'temporal.actual-context-missing' });
        }
    }
});

test('source verifier refuses every missing or malformed required actual field', () =>
{
    const values = fixture();
    for (const [kind, observation] of Object.entries(values.observations))
    {
        for (const field of Object.keys(observation).filter((key) => key !== 'observationBoundary'))
        {
            for (const value of [undefined, null, '', ' ', 0, {}])
            {
                assert.throws(() => verify(kind, { ...observation, [field]: value }, values),
                    { reasonCode: 'temporal.actual-context-missing' });
            }
            const missing = { ...observation };
            delete missing[field];
            assert.throws(() => verify(kind, missing, values),
                { reasonCode: 'temporal.actual-context-missing' });
        }
    }
});

test('source verifier requires actual own fields rather than inherited observations', () =>
{
    const values = fixture();
    for (const [kind, observation] of Object.entries(values.observations))
    {
        assert.throws(() => verify(kind, Object.create(observation), values),
            { reasonCode: 'temporal.actual-context-missing' });
    }
});

test('source verifier refuses exact-epoch, culture, timezone, locale and measurement drift', () =>
{
    const values = fixture();
    const mutations = [
        ['backend', 'businessEpochUtc', '2024-03-01T00:00:00.000Z', 'temporal.actual-context-mismatch'],
        ['backend', 'businessEpochUtc', '2024-02-29T23:59:59.0000Z', 'temporal.actual-context-mismatch'],
        ['backend', 'backendCulture', 'zh-CN', 'temporal.backend-culture-mismatch'],
        ['backend', 'postgresTimezone', 'Asia/Shanghai', 'temporal.postgres-timezone-mismatch'],
        ['node', 'timezone', 'Asia/Shanghai', 'temporal.actual-context-mismatch'],
        ['node', 'locale', 'zh-CN', 'temporal.browser-context-mismatch'],
        ['node', 'nodeTimezone', 'Asia/Shanghai', 'temporal.node-timezone-mismatch'],
        ['node', 'monotonicClockSource', 'fixed', 'temporal.mixed-clock'],
        ['postgres', 'timezone', 'Asia/Shanghai', 'temporal.postgres-timezone-mismatch'],
        ['browser', 'browserBusinessEpochUtc', '2024-03-01T00:00:00.000Z', 'temporal.actual-context-mismatch'],
        ['browser', 'locale', 'zh-CN', 'temporal.browser-context-mismatch']
    ];
    for (const [kind, field, value, reasonCode] of mutations)
    {
        assert.throws(() => verify(kind, { ...values.observations[kind], [field]: value }, values),
            { reasonCode });
    }
});

test('source verifier preserves and validates optional actual fields instead of dropping drift', () =>
{
    const values = fixture();
    assert.throws(() => verify('backend', {
        ...values.observations.backend, nodeTimezone: 'Asia/Shanghai'
    }, values), { reasonCode: 'temporal.node-timezone-mismatch' });
    assert.throws(() => verify('browser', {
        ...values.observations.browser, monotonicClockSource: 'fixed'
    }, values), { reasonCode: 'temporal.mixed-clock' });
});

test('source verifier refuses conflicting aliases and spoofed browser boundaries', () =>
{
    const values = fixture();
    for (const [kind, extra] of [
        ['browser', { timezone: 'Asia/Shanghai' }],
        ['browser', { uiLocale: 'zh-CN' }],
        ['postgres', { postgresTimezone: 'Asia/Shanghai' }]
    ])
    {
        assert.throws(() => verify(kind, { ...values.observations[kind], ...extra }, values),
            { reasonCode: 'temporal.actual-context-mismatch' });
    }
    assert.throws(() => verify('browser', {
        ...values.observations.browser, observationBoundary: 'planned-only'
    }, values), { reasonCode: 'temporal.browser-context-mismatch' });
    assert.equal(verify('browser', values.observations.browser, values).observationBoundary, 'browser-runtime');
});

test('source verifier consumes explicit immutable authority and rejects context drift', () =>
{
    const values = fixture();
    assert.throws(() => validateTemporalSourceObservation({
        kind: 'backend', context: values.context, observation: values.observations.backend
    }), /policy/u);
    for (const field of ['temporalPolicyDigest', 'ledgerSource'])
    {
        const context = structuredClone(values.context);
        if (field === 'ledgerSource')
        {
            context.ledgerSource.digest = `sha256:${'c'.repeat(64)}`;
        }
        else
        {
            context[field] = `sha256:${'c'.repeat(64)}`;
        }
        assert.throws(() => validateTemporalSourceObservation({
            kind: 'backend', context, observation: values.observations.backend
        }, values.authority), /digest/u);
    }
    for (const kind of ['catalog', 'constructor', '__proto__', 'unknown'])
    {
        assert.throws(() => verify(kind, values.observations.backend, values),
            { reasonCode: 'temporal.context-invalid' });
    }
});

test('canonical temporal CLI requires complete actual observations for all runtime kinds', (t) =>
{
    const values = cliFixture(t);
    for (const [kind, observation] of Object.entries(values.observations))
    {
        const complete = values.run(kind, JSON.stringify(observation));
        assert.equal(complete.error, undefined);
        assert.equal(complete.status, 0, complete.stderr);
        assert.equal(complete.stdout, `[temporal-producers] ${kind}=ok\n`);
        assert.equal(complete.stderr, '');

        const empty = values.run(kind, '{}');
        assert.equal(empty.error, undefined);
        assert.equal(empty.status, 1);
        assert.equal(empty.stdout, '');
        assert.match(empty.stderr, /temporal.actual-context-missing/u);

        const drift = values.run(kind, JSON.stringify({
            ...observation, businessEpochUtc: '2024-03-01T00:00:00.000Z'
        }));
        assert.equal(drift.error, undefined);
        assert.equal(drift.status, 1);
        assert.equal(drift.stdout, '');
        assert.match(drift.stderr, /temporal.actual-context-mismatch/u);
    }
});

test('canonical temporal CLI keeps malformed ingress and unsupported kinds fail closed', (t) =>
{
    const values = cliFixture(t);
    const malformed = values.run('backend', '{');
    assert.equal(malformed.error, undefined);
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stdout, '');
    assert.match(malformed.stderr, /temporal.context-invalid/u);
    const unsupported = values.run('unknown', JSON.stringify(values.observations.backend));
    assert.equal(unsupported.error, undefined);
    assert.equal(unsupported.status, 1);
    assert.equal(unsupported.stdout, '');
    assert.match(unsupported.stderr, /unsupported temporal source observation kind/u);
});

test('canonical temporal CLI preserves catalog verification output', (t) =>
{
    const result = cliFixture(t).run('catalog', '{}');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\[temporal-producers\] producers=9 implementations=29 digest=sha256:[a-f0-9]{64}\n$/u);
    assert.equal(result.stderr, '');
});
