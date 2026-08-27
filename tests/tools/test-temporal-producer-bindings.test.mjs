import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { defaultTimeoutPolicyDigest, digestCanonical, playwrightTemporalContextOptions, qualificationTemporalContext, semanticOutcomeDigest } = await import(new URL("../../tools/test/temporal-context.mjs", import.meta.url));
const { bindCorrectnessProducerTemporalArtifacts, observeBrowserTemporalContext, postgresTemporalSessionSql, validateTemporalProducerBindings, verifyPostgresTemporalObservation } = await import(new URL("../../tools/test/temporal-producer-bindings.mjs", import.meta.url));
const { buildProducerChildEnv } = await import(new URL("../../tools/test-fixtures/producers/spawn-helper.mjs", import.meta.url));
const { buildFixtureVariantPlan, buildProducerFixtureVariantPlan } = await import(new URL("../../tools/testing/fixture-catalog.mjs", import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceCommit = 'a'.repeat(40);
const sourceFingerprint = `sha256:${'b'.repeat(64)}`;
const timeoutPolicyDigest = defaultTimeoutPolicyDigest();

function contextInput(overrides = {})
{
    return {
        sourceCommit,
        sourceFingerprint,
        schedulerRunId: 'temporal-producer-test',
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        locale: 'en-US',
        uiLocale: 'en-US',
        timeoutPolicyDigest,
        ...overrides
    };
}

test('every fixture inventory implementation has one canonical temporal binding', () =>
{
    assert.deepEqual(validateTemporalProducerBindings(), {
        producerCount: 7,
        implementationCount: 15,
        cutoverExclusionCount: 0,
        digest: validateTemporalProducerBindings().digest
    });
});

test('producer child env canonicalizes temporal ingress to one inline source', () =>
{
    const temporalContext = qualificationTemporalContext(contextInput({
        producerId: 'auth-session'
    }));
    const fixturePlan = buildFixtureVariantPlan([]);
    const variantPlan = buildProducerFixtureVariantPlan({
        producerId: 'auth-session',
        variantIds: [],
        fixtureVariantIds: [],
        fixtureVariantPlanDigest: fixturePlan.variantPlanDigest
    });
    const child = buildProducerChildEnv(
        { temporalContext, variantPlan },
        {
            FSUSBLOG_TEMPORAL_CONTEXT_FILE: '/tmp/ambient-context.json',
            FSUSBLOG_TEMPORAL_CONTEXT_JSON: '{"ambient":true}'
        }
    );
    assert.equal(child.FSUSBLOG_TEMPORAL_CONTEXT_FILE, undefined);
    assert.deepEqual(
        JSON.parse(child.FSUSBLOG_TEMPORAL_CONTEXT_JSON),
        temporalContext
    );
});

test('independent repository producer discovery rejects an inventory-hidden implementation', () =>
{
    const inventory = JSON.parse(readFileSync(
        path.join(
            repositoryRoot,
            'config/testing/fixture-consumer-inventory.generated.json'
        ),
        'utf8'
    ));
    const declarations = {
        producers: [
            ...inventory.producerImplementations,
            {
                producerId: 'scale-data',
                source: 'tools/test-fixtures/producers/hidden-scale-producer.mjs'
            }
        ]
    };
    assert.throws(
        () => validateTemporalProducerBindings({ inventory, declarations }),
        /independent repository producer discovery/u
    );
});

test('every correctness producer can bind an exact plan actual and receipt', () =>
{
    for (const producerId of [
        'account-messaging',
        'auth-session',
        'comment-moderation',
        'development-demo',
        'public-content',
        'scale-data',
        'security-state'
    ])
    {
        const bound = bindCorrectnessProducerTemporalArtifacts({
            producerId,
            contextInput: contextInput(),
            outcome: {
                producerId,
                scheduledPublishAt: '2024-03-01T00:00:00.000Z'
            },
            observations: {
                businessEpochUtc: '2024-02-29T23:59:59.000Z',
                timezone: 'UTC',
                locale: 'en-US',
                uiLocale: 'en-US',
                backendCulture: 'Invariant',
                postgresTimezone: 'UTC',
                nodeTimezone: 'UTC',
                calendar: 'gregory',
                firstDayOfWeek: 'monday',
                monotonicClockSource: 'performance-now',
                observationBoundary: 'test-producer'
            },
            generatedAt: '2026-07-28T00:00:00.000Z'
        });
        assert.equal(bound.verification.qualificationEligible, true);
        assert.equal(bound.plan.producer.producerId, producerId);
        assert.equal(bound.receipt.planDigest, bound.plan.digest);
        assert.equal(bound.receipt.actualDigest, bound.actual.digest);
        assert.equal(bound.environment.TZ, 'UTC');
    }
});

test('canonical correctness runner injects context and publishes replayable temporal artifacts', () =>
{
    const runId = `temporal-runner-test-${process.pid}`;
    const executionRoot = path.join(repositoryRoot, '.tmp/physical-executions', runId);
    const run = (businessEpochUtc) => spawnSync(process.execPath, [
        'tools/test/run-deterministic-command.mjs',
        '--key', runId,
        '--execution-class', 'correctness',
        '--producer-id', 'scale-data',
        '--path', 'tools/test/temporal-context.mjs',
        '--',
        process.execPath,
        '--eval',
        'if (!process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON || process.env.TZ !== "UTC") process.exit(9)'
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceCommit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceFingerprint,
            FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: businessEpochUtc
        }
    });
    try
    {
        const result = run('2024-02-29T23:59:59.000Z');
        assert.equal(result.status, 0, result.stderr);
        const match = result.stdout.match(/temporal-receipt=(\S+)/u);
        assert.ok(match, result.stdout);
        const receiptFile = match[1];
        const planFile = receiptFile.replace(/-receipt\.json$/u, '-plan.json');
        const actualFile = receiptFile.replace(/-receipt\.json$/u, '-actual.json');
        const replay = spawnSync(process.execPath, [
            'tools/test/verify-temporal-replay.mjs',
            '--plan', planFile,
            '--actual', actualFile,
            '--receipt', receiptFile
        ], {
            cwd: repositoryRoot,
            encoding: 'utf8'
        });
        assert.equal(replay.status, 0, replay.stderr);
        assert.match(replay.stdout, /qualificationEligible=true/u);

        const perturbed = run('2024-03-01T00:00:00.000Z');
        assert.equal(perturbed.status, 0, perturbed.stderr);
        const originalPhysicalReceipt = result.stdout.match(/\sreceipt=(\S+)/u)?.[1];
        const perturbedPhysicalReceipt = perturbed.stdout.match(/\sreceipt=(\S+)/u)?.[1];
        assert.ok(originalPhysicalReceipt);
        assert.ok(perturbedPhysicalReceipt);
        assert.notEqual(
            originalPhysicalReceipt,
            perturbedPhysicalReceipt,
            'business epoch must participate in the physical execution contract'
        );
    }
    finally
    {
        rmSync(executionRoot, { recursive: true, force: true });
    }
});

test('target child exit handshake rejects child-owned timezone and epoch drift', () =>
{
    const runId = `temporal-child-drift-${process.pid}`;
    const executionRoot = path.join(repositoryRoot, '.tmp/physical-executions', runId);
    const result = spawnSync(process.execPath, [
        'tools/test/run-deterministic-command.mjs',
        '--key', runId,
        '--execution-class', 'correctness',
        '--producer-id', 'scale-data',
        '--path', 'tools/test/temporal-context.mjs',
        '--',
        process.execPath,
        '--eval',
        [
            "process.env.TZ = 'Asia/Shanghai'",
            "process.env.FSUSBLOG_TEST_BUSINESS_EPOCH_UTC = '2030-01-01T00:00:00.000Z'"
        ].join(';')
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceCommit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceFingerprint,
            FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: '2024-02-29T23:59:59.000Z'
        }
    });
    try
    {
        assert.notEqual(result.status, 0);
        assert.match(
            `${result.stdout}\n${result.stderr}`,
            /temporal exit handshake|observation does not match planned temporal context|Asia\/Shanghai|2030-01-01/u
        );
    }
    finally
    {
        rmSync(executionRoot, { recursive: true, force: true });
    }
});

test('target Bash exit handshake rejects shell-owned timezone and epoch drift', () =>
{
    const runId = `temporal-bash-child-drift-${process.pid}`;
    const executionRoot = path.join(repositoryRoot, '.tmp/physical-executions', runId);
    const result = spawnSync(process.execPath, [
        'tools/test/run-deterministic-command.mjs',
        '--key',
        runId,
        '--execution-class',
        'correctness',
        '--producer-id',
        'scale-data',
        '--path',
        'tools/data-scale/seed.sh',
        '--',
        'bash',
        '-c',
        [
            "export TZ='Asia/Shanghai'",
            "export FSUSBLOG_TEST_BUSINESS_EPOCH_UTC='2030-01-01T00:00:00.000Z'"
        ].join(';')
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceCommit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceFingerprint,
            FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: '2024-02-29T23:59:59.000Z'
        }
    });
    try
    {
        assert.notEqual(result.status, 0);
        assert.match(
            `${result.stdout}\n${result.stderr}`,
            /temporal exit handshake|observation does not match planned temporal context|Asia\/Shanghai|2030-01-01/u
        );
    }
    finally
    {
        rmSync(executionRoot, { recursive: true, force: true });
    }
});

test('correctness runner rejects a target that suppresses its exit handshake', () =>
{
    const runId = `temporal-child-handshake-missing-${process.pid}`;
    const executionRoot = path.join(repositoryRoot, '.tmp/physical-executions', runId);
    const result = spawnSync(process.execPath, [
        'tools/test/run-deterministic-command.mjs',
        '--key', runId,
        '--execution-class', 'correctness',
        '--producer-id', 'scale-data',
        '--path', 'tools/test/temporal-context.mjs',
        '--',
        process.execPath,
        '--eval',
        "process.removeAllListeners('exit')"
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceCommit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceFingerprint,
            FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: '2024-02-29T23:59:59.000Z'
        }
    });
    try
    {
        assert.notEqual(result.status, 0);
        assert.match(
            `${result.stdout}\n${result.stderr}`,
            /exactly one temporal exit handshake/u
        );
    }
    finally
    {
        rmSync(executionRoot, { recursive: true, force: true });
    }
});

test('PostgreSQL session SQL binds timezone and business epoch and mismatches fail', () =>
{
    const context = qualificationTemporalContext({
        ...contextInput(),
        producerId: 'scale-data'
    });
    const sql = postgresTemporalSessionSql(context);
    assert.match(sql, /set_config\('TimeZone', 'UTC', false\)/u);
    assert.match(sql, /fsusblog\.test_business_epoch_utc/u);
    assert.equal(verifyPostgresTemporalObservation(context, {
        timezone: 'UTC',
        businessEpochUtc: context.businessEpochUtc
    }), true);
    assert.throws(
        () => verifyPostgresTemporalObservation(context, {
            timezone: 'Asia/Shanghai',
            businessEpochUtc: context.businessEpochUtc
        }),
        /temporal\.postgres-timezone-mismatch/u
    );
});

test('browser context binds explicit locale and timezone instead of Node TZ only', () =>
{
    const context = qualificationTemporalContext({
        ...contextInput({ locale: 'ja-JP', uiLocale: 'ja-JP' }),
        producerId: 'comment-moderation'
    });
    assert.deepEqual(playwrightTemporalContextOptions(context), {
        locale: 'ja-JP',
        timezoneId: 'UTC'
    });
    assert.equal(observeBrowserTemporalContext(context, {
        locale: 'ja-JP',
        timezoneId: 'UTC',
        nodeTimezone: 'UTC'
    }).uiLocale, 'ja-JP');
    assert.throws(
        () => observeBrowserTemporalContext(context, {
            locale: 'ja-JP',
            timezoneId: 'America/Los_Angeles',
            nodeTimezone: 'UTC'
        }),
        (error) => error.reasonCode === 'temporal.actual-context-mismatch'
    );
});

test('host TZ perturbation cannot change a fixed semantic business outcome', () =>
{
    const outputRoot = path.join(repositoryRoot, '.tmp/temporal-host-perturbation');
    const preload = path.join(repositoryRoot, 'tests/fixtures/temporal-wall-clock-offset.cjs');
    const digests = [
        ['UTC', '0'],
        ['America/Los_Angeles', '86400000'],
        ['Asia/Shanghai', '-86400000']
    ].map(([TZ, clockOffset], index) =>
    {
        const runId = `temporal-host-perturbation-${process.pid}-${index}`;
        const output = path.join(outputRoot, `${index}.json`);
        const script = `
      const fs = require('node:fs')
      const path = require('node:path')
      const context = JSON.parse(process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON)
      fs.mkdirSync(path.dirname(process.env.TEMPORAL_OUT), { recursive: true })
      fs.writeFileSync(process.env.TEMPORAL_OUT, JSON.stringify({
        businessEpochUtc: context.businessEpochUtc,
        scheduledPublishAt: '2024-03-01T00:00:00.000Z',
        expiresAt: '2024-03-01T01:00:00.000Z',
        effectiveTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      }))
    `;
        const result = spawnSync(process.execPath, [
            'tools/test/run-deterministic-command.mjs',
            '--key', runId,
            '--execution-class', 'correctness',
            '--producer-id', 'scale-data',
            '--path', 'tools/test/temporal-context.mjs',
            '--output', output,
            '--',
            'env',
            `NODE_OPTIONS=--require=${preload}`,
            `FSUSBLOG_TEST_HOST_CLOCK_OFFSET_MS=${clockOffset}`,
            process.execPath,
            '--eval',
            script
        ], {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                TZ,
                TEMPORAL_OUT: output,
                FSUSBLOG_TEST_RUN_ID: runId,
                FSUSBLOG_TEST_SOURCE_COMMIT: sourceCommit,
                FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceFingerprint,
                FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: '2024-02-29T23:59:59.000Z'
            }
        });
        assert.equal(result.status, 0, result.stderr);
        return semanticOutcomeDigest(JSON.parse(readFileSync(output, 'utf8')));
    });
    try
    {
        assert.equal(new Set(digests).size, 1);
    }
    finally
    {
        rmSync(outputRoot, { recursive: true, force: true });
        for (let index = 0; index < 3; index += 1)
        {
            rmSync(
                path.join(
                    repositoryRoot,
                    '.tmp/physical-executions',
                    `temporal-host-perturbation-${process.pid}-${index}`
                ),
                { recursive: true, force: true }
            );
        }
    }
});

test('leap day DST transitions and UTC midnight use the unique temporal shape catalog', () =>
{
    const catalog = JSON.parse(readFileSync(
        path.join(repositoryRoot, 'config/testing/temporal-shape-catalog.json'),
        'utf8'
    ));
    assert.equal(catalog.schema, 'fsusblog.temporal-shape-catalog.v1');
    const tags = new Set(catalog.shapes.flatMap((shape) => shape.boundaryTags));
    for (const boundary of [
        'utc-midnight',
        'leap-day',
        'month-boundary',
        'year-boundary',
        'dst-forward',
        'dst-backward'
    ])
    {
        assert.equal(tags.has(boundary), true, boundary);
    }
});

test('business timestamps remain semantic while generatedAt remains artifact-only', () =>
{
    const first = {
        scheduledPublishAt: '2024-03-01T00:00:00.000Z',
        expiresAt: '2024-03-01T01:00:00.000Z',
        generatedAt: '2026-07-28T00:00:00.000Z'
    };
    assert.equal(
        semanticOutcomeDigest(first),
        semanticOutcomeDigest({ ...first, generatedAt: '2030-01-01T00:00:00.000Z' })
    );
    assert.notEqual(
        semanticOutcomeDigest(first),
        semanticOutcomeDigest({ ...first, expiresAt: '2024-03-01T02:00:00.000Z' })
    );
    assert.notEqual(
        digestCanonical(first),
        digestCanonical({ ...first, generatedAt: '2030-01-01T00:00:00.000Z' })
    );
});

test('producer sources do not use un-injected business wall clocks or correctness sleeps', () =>
{
    const catalog = JSON.parse(readFileSync(
        path.join(repositoryRoot, 'config/testing/temporal-producer-bindings.json'),
        'utf8'
    ));
    for (const source of new Set(catalog.producerBindings.flatMap((row) => row.implementations)))
    {
        const text = readFileSync(path.join(repositoryRoot, source), 'utf8');
        assert.doesNotMatch(text, /\bDateTime(?:Offset)?\.UtcNow\b/u, source);
        assert.doesNotMatch(text, /\bDate\.now\(\)/u, source);
        assert.doesNotMatch(text, /\bsleep\s+[1-9][0-9]*(?:\.[0-9]+)?\b/u, source);
        if (!['tools/data-scale/seed.sh', 'tools/data-scale/cleanup.sh'].includes(source))
        {
            assert.doesNotMatch(text, /\bclock_timestamp\(\)/u, source);
        }
        if (source !== 'tools/data-scale/cleanup.sh')
        {
            assert.doesNotMatch(text, /(?<![a-z_.])now\(\)/u, source);
        }
    }
});
