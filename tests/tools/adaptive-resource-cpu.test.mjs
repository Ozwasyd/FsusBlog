import assert from 'node:assert/strict';
import test from 'node:test';

const { recommendCpu } = await import(new URL('../../tools/resource-model/cpu-recommendations.mjs', import.meta.url));

import { fixture } from './support/adaptive-resource-fixtures.mjs';

test('adaptive CPU increases efficient critical capacity blocked weight with a bounded update', (context) =>
{
    const data = fixture(context);
    const result = recommendCpu(data.inputs);
    assert.equal(result.recommendations[0].recommendedCpuWeight, 2.4);
    assert.equal(result.recommendations[0].recommendedMinCpuUnits, 1);
    assert.equal(result.recommendations[0].sampleCount, 5);
    assert.ok(result.recommendations.reduce((sum, row) => sum + row.recommendedCpuUnits, 0) <= 8);
    assert.deepEqual(recommendCpu(data.inputs), result);
});

test('adaptive CPU respects dependency readiness throttling benchmark and quiet vetoes', (context) =>
{
    for (const row of [
        { waitClass: 'dependency', capacityBlockedMs: 999999 },
        { waitClass: 'readiness', capacityBlockedMs: 999999 },
        { actualCpuUnits: 0.1, throttledMs: 100, waitClass: 'io' },
        { actualCpuUnits: 0.1, waitClass: 'benchmark' },
        { actualCpuUnits: 0.1, waitClass: 'quiet' }
    ])
    {
        const data = fixture(context, { row: { alpha: row } });
        const recommendation = recommendCpu(data.inputs).recommendations[0];
        assert.equal(recommendation.recommendedCpuWeight, 2);
        assert.equal(recommendation.decision, 'no-change');
    }
});

test('adaptive CPU lowers only I/O elastic weight and preserves fixed benchmark grants', (context) =>
{
    const data = fixture(context, { row: { alpha: { waitClass: 'io', actualCpuUnits: 0.2 } },
        defaults: { beta: { benchmark: true, cpuUnits: 3 } } });
    const result = recommendCpu(data.inputs);
    assert.equal(result.recommendations[0].recommendedCpuWeight, 1.6);
    assert.equal(result.recommendations[1].recommendedCpuUnits, 3);
    assert.equal(result.recommendations[1].decision, 'no-change');
    assert.ok(result.recommendations.reduce((sum, row) => sum + row.recommendedCpuUnits, 0) <= 8);
});

test('adaptive CPU rejects infeasible support floor and cross capacity identity', (context) =>
{
    const data = fixture(context, { defaults: { alpha: { minCpuUnits: 3 }, beta: { minCpuUnits: 3 } } });
    assert.throws(() => recommendCpu(data.inputs), { code: 'infeasible-cpu-minimum' });
    assert.throws(() => recommendCpu({ ...data.inputs, capacity: { ...data.capacity, effectiveCpuUnits: 100 } }),
        { code: 'capacity-drift' });
});

test('adaptive CPU returns no change for empty and insufficient history', (context) =>
{
    for (const count of [0, 1, 4])
    {
        const data = fixture(context, { count });
        assert.ok(recommendCpu(data.inputs).recommendations.every((row) => row.decision === 'no-change'
            && row.reasonVector.includes('low-confidence')));
    }
});
