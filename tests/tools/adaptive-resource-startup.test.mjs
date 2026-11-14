import assert from 'node:assert/strict';
import test from 'node:test';

const { digestJson } = await import(new URL('../../tools/resource-model/contract.mjs', import.meta.url));
const { recommendStartup } = await import(new URL('../../tools/resource-model/startup-recommendations.mjs', import.meta.url));

import { fixture, ready } from './support/adaptive-resource-fixtures.mjs';

test('adaptive startup scores critical unlock value and cost inside an eligible ready set', (context) =>
{
    const data = fixture(context, { row: { beta: { criticalPath: false, downstreamUnlockValue: 0,
        startupCpuUnits: 6, startupMemoryGiB: 10, firstProductiveChildAt: 2000 } } });
    const input = { ...data.inputs, identity: data.identity, candidates: [ready('beta'), ready('alpha')], now: 3000 };
    const result = recommendStartup(input);
    assert.equal(result.recommendations[0].producerId, 'alpha');
    assert.ok(result.recommendations[0].recommendedStartupPriority > result.recommendations[1].recommendedStartupPriority);
    assert.deepEqual(result, recommendStartup(input));
});

test('adaptive startup excludes every unsatisfied hard constraint before scoring', (context) =>
{
    const data = fixture(context);
    for (const field of ['dependenciesSatisfied', 'markersSealed', 'cpuFeasible', 'memoryFeasible',
        'exclusiveAvailable', 'filesystemOrdered', 'stateConflictFree', 'outputConflictFree', 'benchmarkAllowed'])
    {
        const result = recommendStartup({ ...data.inputs, identity: data.identity,
            candidates: [ready('alpha', { [field]: false }), ready('beta')], now: 1000 });
        assert.deepEqual(result.recommendations.map((row) => row.producerId), ['beta']);
        assert.deepEqual(result.excluded[0].reasonVector, [field]);
    }
});

test('adaptive startup deterministic aging eventually exceeds bounded learned benefit', (context) =>
{
    const data = fixture(context, { row: { beta: { criticalPath: false, downstreamUnlockValue: 0 } } });
    const result = recommendStartup({ ...data.inputs, identity: data.identity,
        candidates: [ready('alpha', { readyAt: 200000 }), ready('beta', { readyAt: 0 })], now: 200000 });
    assert.equal(result.recommendations[0].producerId, 'beta');
    assert.ok(result.recommendations[0].aging > 100);
});

test('adaptive startup keeps defaults at low confidence with stable identifier tie break', (context) =>
{
    const data = fixture(context, { count: 1 });
    const result = recommendStartup({ ...data.inputs, identity: data.identity,
        candidates: [ready('beta'), ready('alpha')], now: 1000 });
    assert.deepEqual(result.recommendations.map((row) => row.producerId), ['alpha', 'beta']);
    assert.ok(result.recommendations.every((row) => row.decision === 'no-change'
        && row.recommendedStartupPriority === 0));
});

test('adaptive startup rejects identity drift duplicate candidates and future readiness', (context) =>
{
    const data = fixture(context);
    const input = { ...data.inputs, identity: data.identity, candidates: [ready('alpha')], now: 1000 };
    assert.throws(() => recommendStartup({ ...input, identity: { ...data.identity, physicalPlanDigest: digestJson('other') } }),
        { code: 'identity-drift' });
    assert.throws(() => recommendStartup({ ...input, candidates: [ready('alpha'), ready('alpha')] }),
        { code: 'invalid-ready-set' });
    assert.throws(() => recommendStartup({ ...input, candidates: [ready('alpha', { readyAt: 2000 })] }),
        { code: 'future-ready-time' });
});
