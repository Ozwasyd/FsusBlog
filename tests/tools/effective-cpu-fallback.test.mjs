import assert from 'node:assert/strict';
import test from 'node:test';

import { digest, machine } from './cpu-calibration-test-support.mjs';

const fallback = await import(new URL('../../tools/test/effective-cpu-fallback.mjs', import.meta.url));
const calculate = (topology) => fallback.calculateEffectiveCpuFallback(topology, topology.topologyDigest);

test('CPU fallback exactly calculates half visible logical for one two three four eight sixteen CPUs', () =>
{
    for (const [logical, expected] of [[1, 1], [2, 1], [3, 1], [4, 2], [8, 4], [16, 8]])
    {
        const topology = machine({ logical, quota: '1600000', physical: false });
        const receipt = calculate(topology);
        assert.equal(receipt.effectiveCpuUnits, expected);
        assert.equal(receipt.fallbackKind, 'uncalibrated-half-visible-logical');
        assert.equal(receipt.uncalibrated, true);
        assert.equal(receipt.calibrationSampleEligible, false);
        fallback.validateEffectiveCpuFallback(receipt, topology, topology.topologyDigest);
    }
});

test('CPU fallback uses trustworthy allowed physical count bounded by fractional finite quota', () =>
{
    assert.equal(calculate(machine({ quota: '600000' })).effectiveCpuUnits, 6);
    assert.equal(calculate(machine({ quota: '650000' })).effectiveCpuUnits, 6);
    assert.equal(calculate(machine({ quota: '1200000', physical: false })).effectiveCpuUnits, 6);
    const fractional = calculate(machine({ quota: '50000' }));
    assert.equal(fractional.effectiveCpuUnits, 1);
    assert.equal(fractional.schedulerEnvelopeCpuUnits, 0.5);
});

test('CPU fallback rejects unlimited unknown unverified boundaries and stale receipts', () =>
{
    assert.throws(() => calculate(machine({ quota: 'max' })), /verified finite/u);
    const current = machine();
    assert.throws(() => fallback.calculateEffectiveCpuFallback(current), /current topology/u);
    assert.throws(() => fallback.calculateEffectiveCpuFallback(current, digest('stale')), /stale/u);
    const receipt = structuredClone(calculate(current));
    receipt.effectiveCpuUnits = 16;
    assert.throws(() => fallback.validateEffectiveCpuFallback(receipt, current, current.topologyDigest), /digest/u);
});
