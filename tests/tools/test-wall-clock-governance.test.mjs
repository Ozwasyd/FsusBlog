import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

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
        callSiteCount: 62,
        mixedClockCount: 0,
        pendingCount: 0,
        unknownCount: 0,
        governedSourceCount: 36
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
