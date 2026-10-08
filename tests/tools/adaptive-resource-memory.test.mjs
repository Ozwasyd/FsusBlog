import assert from 'node:assert/strict';
import test from 'node:test';

const { recommendMemory } = await import(new URL('../../tools/resource-model/memory-recommendations.mjs', import.meta.url));
const { appendSampleCandidate, createSampleCandidate } = await import(new URL('../../tools/resource-model/sample-ledger.mjs', import.meta.url));

import { fixture } from './support/adaptive-resource-fixtures.mjs';

test('adaptive memory uses both reserve floors on small and large machines', (context) =>
{
    for (const [totalMemoryGiB, reserve] of [[8, 2], [128, 12.8]])
    {
        const data = fixture(context, { capacity: { totalMemoryGiB },
            defaults: { alpha: { memoryGiB: 2 }, beta: { memoryGiB: 2 } } });
        const result = recommendMemory(data.inputs);
        assert.equal(result.recommendedSystemReserveGiB, reserve);
        assert.equal(result.recommendations[0].recommendedMemoryGiB, 2.4);
        assert.deepEqual(recommendMemory(data.inputs), result);
    }
});

test('adaptive memory vetoes shrinking under PSI faults GC allocation and unknown attribution', (context) =>
{
    for (const row of [{ memoryPsi: 1 }, { majorFaults: 1 }, { gcPressure: 1 },
        { allocationPressure: 1 }, { attribution: 'unknown' }])
    {
        const data = fixture(context, { row: { alpha: row } });
        const result = recommendMemory(data.inputs).recommendations[0];
        assert.equal(result.recommendedMemoryGiB, 4);
        assert.equal(result.decision, 'no-change');
    }
});

test('adaptive memory distinguishes resident reservations from transient concurrency', (context) =>
{
    const data = fixture(context, { row: { alpha: { attribution: 'resident' } },
        capacity: { maxConcurrentInstances: { alpha: 10, beta: 2 } } });
    const result = recommendMemory(data.inputs);
    assert.equal(result.recommendations[0].attribution, 'resident');
    assert.equal(result.concurrentDemandGiB, 3.2 + 3.2 * 2);
    assert.equal(result.recommendations[0].lifetimeMs, 10000);
});

test('adaptive memory refuses oversold CPU concurrency plan and fixed benchmark shrink', (context) =>
{
    const data = fixture(context, { capacity: { maxConcurrentInstances: { alpha: 3, beta: 3 } } });
    assert.throws(() => recommendMemory(data.inputs), { code: 'infeasible-memory-envelope' });
    const protectedData = fixture(context, { defaults: { alpha: { benchmark: true } } });
    assert.equal(recommendMemory(protectedData.inputs).recommendations[0].recommendedMemoryGiB, 4);
});

test('adaptive memory resists a single RSS outlier and low sample confidence', (context) =>
{
    const data = fixture(context);
    const input = data.makeSample(99, (facts) =>
    {
        facts.resource.observations[0].peakRssGiB = 1000;
    });
    const head = appendSampleCandidate({ ...data.inputs.ledger, sample: createSampleCandidate(input) });
    const result = recommendMemory({ ...data.inputs, ledger: { ...data.inputs.ledger, head } });
    assert.equal(result.recommendations[0].recommendedMemoryGiB, 3.2);
    const insufficient = fixture(context, { count: 1 });
    assert.equal(recommendMemory(insufficient.inputs).recommendations[0].decision, 'no-change');
});

test('adaptive memory never estimates demand from failed low RSS swap or OOM runs', (context) =>
{
    const data = fixture(context, { count: 0 });
    for (const mutate of [
        (facts) =>
        {
            facts.run.status = 'failed';
            facts.resource.observations[0].peakRssGiB = 0;
        },
        (facts) =>
        {
            facts.resource.swap = 1;
        },
        (facts) =>
        {
            facts.resource.oom = 1;
        },
        (facts) =>
        {
            facts.resource.resourceKills = 1;
        }
    ])
    {
        assert.throws(() => createSampleCandidate(data.makeSample(0, mutate)));
    }
});
