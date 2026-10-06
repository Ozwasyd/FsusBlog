import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const { validateTemporalClockClassification } = await import(new URL('../../tools/test/temporal-context-contract.mjs', import.meta.url));

const { discoverRepositoryTemporalSources, validateWallClockGovernance, verifyRepositoryWallClockGovernance } = await import(new URL("../../tools/test/check-wall-clock-governance.mjs", import.meta.url));

function entry(overrides = {})
{
    return {
        callSiteId: 'fixture.performance',
        path: 'fixture.mjs',
        symbol: 'measure',
        sourceAnchor: 'return performance.now()',
        api: 'performance.now',
        clockKind: 'monotonic-measurement',
        authorityKind: 'runtime-monotonic',
        disposition: 'monotonic-measurement',
        ingress: 'runtime-monotonic',
        owner: 'test-governance',
        semanticEffect: 'excluded',
        ...overrides
    };
}

function ledger(entries)
{
    return {
        schema: 'fsusblog.temporal-callsite-ledger.v1',
        authorityKind: 'immutable-ledger',
        governedSources: ['fixture.mjs'],
        entries
    };
}

test('repository temporal ledger has finite closure over real correctness producers', () =>
{
    assert.deepEqual(verifyRepositoryWallClockGovernance(), {
        callSiteCount: 130,
        mixedClockCount: 0,
        pendingCount: 0,
        unknownCount: 0,
        governedSourceCount: 76
    });
});

test('Program binds the canonical test business clock before application services', () =>
{
    const source = fs.readFileSync(new URL('../../src/backend/Program.cs', import.meta.url), 'utf8');
    const temporalIndex = source.indexOf(
        'TimeProvider? testBusinessTimeProvider = TestTemporalRuntimeContext.Configure(builder);'
    );
    const applicationIndex = source.indexOf(
        'builder.ConfigureFsusApplication(testBusinessTimeProvider);'
    );
    assert.ok(temporalIndex >= 0);
    assert.ok(applicationIndex > temporalIndex);
});

test('moderation runtime clock cannot escape the producer execution boundary', () =>
{
    const sourcePath = 'src/backend/Services/Moderation/ModerationRuntimeStateService.cs';
    const source = fs.readFileSync(new URL(`../../${sourcePath}`, import.meta.url), 'utf8');
    const mutated = source.replace('timeProvider.GetUtcNow().UtcDateTime', 'DateTime.UtcNow');
    assert.notEqual(source, mutated);
    const independentlyDiscoveredSources = discoverRepositoryTemporalSources({
        sourceOverrides: new Map([[sourcePath, mutated]])
    });
    // Boundary sources are checked even without an independent discovery marker.
    independentlyDiscoveredSources.set(sourcePath, mutated);
    assert.throws(() => verifyRepositoryWallClockGovernance({ independentlyDiscoveredSources }),
        (error) => error.reasonCode === 'temporal.ledger-unresolved');
});

test('independent full-repository discovery rejects a hidden temporal producer callsite', () =>
{
    const hiddenSource = 'tools/test-fixtures/producers/hidden-temporal-producer.mjs';
    const independentlyDiscoveredSources = discoverRepositoryTemporalSources({
        sourceOverrides: new Map([[
            hiddenSource,
            [
                '/* fixture-catalog:',
                ' producer=scale-data */\nconst hiddenWallClock = DateTime.Now\n'
            ].join('')
        ]])
    });
    assert.equal(independentlyDiscoveredSources.has(hiddenSource), true);
    assert.throws(
        () => verifyRepositoryWallClockGovernance({ independentlyDiscoveredSources }),
        (error) => error.reasonCode === 'temporal.ledger-source-mismatch'
      && error.details.missing.includes(hiddenSource)
    );
});

test('unknown and requires-explicit both block closure', () =>
{
    for (const disposition of ['unknown', 'requires-explicit'])
    {
        assert.throws(
            () => validateWallClockGovernance({
                ledger: ledger([entry({ disposition })]),
                sources: new Map([['fixture.mjs', 'return performance.now()']])
            }),
            (error) => error.reasonCode === 'temporal.ledger-unresolved'
        );
    }
});

test('unowned wall clock calls fail closed instead of receiving a heuristic disposition', () =>
{
    assert.throws(
        () => validateWallClockGovernance({
            ledger: ledger([]),
            sources: new Map([['fixture.mjs', 'const now = Date.now()']])
        }),
        (error) => error.reasonCode === 'temporal.ledger-unresolved'
    );
});

test('business clocks require canonical injection and measurement clocks require monotonic authority', () =>
{
    assert.throws(
        () => validateWallClockGovernance({
            ledger: ledger([entry({
                api: 'Date.now',
                authorityKind: 'artifact-observation',
                clockKind: 'business-wall',
                disposition: 'business-wall',
                ingress: 'artifact-only',
                sourceAnchor: 'return Date.now()'
            })]),
            sources: new Map([['fixture.mjs', 'return Date.now()']])
        }),
        (error) => error.reasonCode === 'temporal.context-invalid'
    );
    assert.throws(
        () => validateWallClockGovernance({
            ledger: ledger([entry({ authorityKind: 'canonical-business-epoch', ingress: 'canonical-injected' })]),
            sources: new Map([['fixture.mjs', 'return performance.now()']])
        }),
        (error) => error.reasonCode === 'temporal.mixed-clock'
    );
});

test('mtime cannot select correctness receipts', () =>
{
    assert.throws(
        () => validateWallClockGovernance({
            ledger: ledger([entry({
                api: 'file-timestamp',
                authorityKind: 'artifact-observation',
                clockKind: 'artifact-metadata',
                disposition: 'artifact-metadata',
                ingress: 'artifact-only',
                sourceAnchor: 'return stat.mtimeMs'
            })]),
            sources: new Map([['fixture.mjs', 'return stat.mtimeMs']])
        }),
        (error) => error.reasonCode === 'temporal.context-invalid'
    );
});

test('unowned PostgreSQL clock_timestamp on a governed correctness source fails closed', () =>
{
    assert.throws(
        () => validateWallClockGovernance({
            ledger: ledger([]),
            sources: new Map([['fixture.mjs', "INSERT INTO posts(created_at) VALUES (clock_timestamp())"]])
        }),
        (error) => error.reasonCode === 'temporal.ledger-unresolved'
      && String(error.message).includes('unowned clock calls')
    );
});

test('real correctness sleep on a governed source fails closed', () =>
{
    assert.throws(
        () => validateWallClockGovernance({
            ledger: ledger([]),
            sources: new Map([['fixture.mjs', 'sleep 60']])
        }),
        (error) => error.reasonCode === 'temporal.ledger-unresolved'
      && error.details.uncovered.some((call) => call.api === 'shell.sleep')
    );
});

test('symbols that mix business and measurement clocks fail closed', () =>
{
    assert.throws(
        () => validateWallClockGovernance({
            ledger: ledger([
                entry({
                    callSiteId: 'fixture.business',
                    api: 'Date.now',
                    authorityKind: 'canonical-business-epoch',
                    clockKind: 'business-wall',
                    disposition: 'business-wall',
                    ingress: 'canonical-injected',
                    sourceAnchor: 'const business = Date.now()',
                    symbol: 'mixed'
                }),
                entry({
                    callSiteId: 'fixture.measure',
                    api: 'performance.now',
                    authorityKind: 'runtime-monotonic',
                    clockKind: 'monotonic-measurement',
                    disposition: 'monotonic-measurement',
                    ingress: 'runtime-monotonic',
                    sourceAnchor: 'const measure = performance.now()',
                    symbol: 'mixed'
                })
            ]),
            sources: new Map([['fixture.mjs', 'const business = Date.now()\nconst measure = performance.now()']])
        }),
        (error) => error.reasonCode === 'temporal.mixed-clock'
    );
});


test('live credential expiry and observed publication remain included business values', () =>
{
    const live = entry({ path: 'tools/test-fixtures/receipt/projection.mjs', api: 'Date.now',
        clockKind: 'business-wall', disposition: 'business-wall', authorityKind: 'runtime-business-wall',
        ingress: 'runtime-wall', semanticEffect: 'included' });
    const publication = entry({ path: 'tests/browser-contract/public-shell-locale-first-response.mjs', api: 'new Date(value)',
        clockKind: 'business-wall', disposition: 'business-wall', authorityKind: 'observed-business-value',
        ingress: 'observed-business', semanticEffect: 'included' });
    for (const value of [live, publication])
    {
        assert.doesNotThrow(() => validateTemporalClockClassification(value));
        for (const mutation of [
            { semanticEffect: 'excluded' },
            { clockKind: 'artifact-metadata', disposition: 'artifact-metadata', authorityKind: 'artifact-observation',
                ingress: 'artifact-only', semanticEffect: 'excluded' },
            { authorityKind: 'canonical-business-epoch', ingress: 'canonical-injected' }
        ])
        {
            assert.throws(() => validateTemporalClockClassification({ ...value, ...mutation }),
                (error) => error.reasonCode === 'temporal.context-invalid');
        }
    }
});

test('actual file and document identities retain assertions and cannot become excluded metadata', () =>
{
    const file = entry({ api: 'file-timestamp', clockKind: 'runtime-identity', disposition: 'runtime-identity',
        authorityKind: 'runtime-file-identity', ingress: 'operability-only', semanticEffect: 'included' });
    const document = entry({ api: 'performance.timeOrigin', clockKind: 'runtime-identity', disposition: 'runtime-identity',
        authorityKind: 'runtime-document-identity', ingress: 'observed-identity', semanticEffect: 'included' });
    for (const value of [file, document])
    {
        assert.doesNotThrow(() => validateTemporalClockClassification(value));
        for (const mutation of [
            { semanticEffect: 'excluded' }, { ingress: 'artifact-only' },
            { authorityKind: 'runtime-monotonic' },
            { clockKind: 'artifact-metadata', disposition: 'artifact-metadata', authorityKind: 'artifact-observation',
                ingress: 'operability-only', semanticEffect: 'excluded' }
        ])
        {
            assert.throws(() => validateTemporalClockClassification({ ...value, ...mutation }),
                (error) => error.reasonCode === 'temporal.context-invalid');
        }
    }
});

test('wall clocks cannot be relabeled as a live monotonic budget', () =>
{
    for (const api of ['Date.now', 'new Date()', 'new Date(value)', 'performance.timeOrigin', 'file-timestamp'])
    {
        assert.throws(() => validateTemporalClockClassification(entry({ api })),
            (error) => ['temporal.mixed-clock', 'temporal.context-invalid'].includes(error.reasonCode));
    }
    assert.doesNotThrow(() => validateTemporalClockClassification(entry({ api: 'process.hrtime.bigint' })));
});
