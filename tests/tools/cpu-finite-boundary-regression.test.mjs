import assert from 'node:assert/strict';
import test from 'node:test';

import { rawTopology, topology, unavailable } from './cpu-calibration-test-support.mjs';

const fallback = await import(new URL('../../tools/test/effective-cpu-fallback.mjs', import.meta.url));
const kinds = ['linux-cgroup-v1', 'linux-cgroup-v2', 'windows-job'];
const overflow = '9'.repeat(400);
const boundary = (kind, quota, period = '100000') =>
{
    const raw = rawTopology({ platform: kind === 'windows-job' ? 'win32' : 'linux', quota, period });
    raw.sources.boundary.value.kind = kind;
    return raw;
};
const calculate = (receipt) => fallback.calculateEffectiveCpuFallback(receipt, receipt.topologyDigest);

test('CPU finite boundary rejects nonstring quotas instead of regex coercion', () =>
{
    for (const kind of kinds)
    {
        for (const quota of [100000, ['100000'], null, true, {}, '0', '-1', '1.5', '1e5', 'Infinity'])
        {
            if (kind === 'linux-cgroup-v1' && quota === '-1')
            {
                continue;
            }
            assert.throws(() => topology.buildMachineCpuTopology(boundary(kind, quota)), /finite boundary quota invalid/u);
        }
    }
});

test('CPU finite boundary rejects nonstring periods even for unlimited quota sentinels', () =>
{
    for (const kind of kinds)
    {
        for (const quota of ['100000', 'max', ...(kind === 'linux-cgroup-v1' ? ['-1'] : [])])
        {
            for (const period of [100000, ['100000'], null, true, {}, '0', '-1', '1.5', '1e5', 'Infinity'])
            {
                assert.throws(() => topology.buildMachineCpuTopology(boundary(kind, quota, period)), /finite boundary period invalid/u);
            }
        }
    }
});

test('CPU finite boundary rejects overflowed quotas before sealing or ancestor minimum can mask them', () =>
{
    for (const kind of kinds)
    {
        for (const mixed of [false, true])
        {
            const raw = boundary(kind, overflow);
            if (mixed)
            {
                raw.sources.boundary.value.limits.push({ locator: 'finite-ancestor', quota: '200000', period: '100000' });
                raw.sources.boundary.value.limits.reverse();
            }
            assert.throws(() => topology.buildMachineCpuTopology(raw), /finite boundary quota invalid/u);
        }
    }
});

test('CPU finite boundary rejects overflowed periods before zero NaN or unlimited projection', () =>
{
    for (const kind of kinds)
    {
        for (const quota of ['100000', overflow, 'max', ...(kind === 'linux-cgroup-v1' ? ['-1'] : [])])
        {
            assert.throws(() => topology.buildMachineCpuTopology(boundary(kind, quota, overflow)), /finite boundary period invalid/u);
        }
    }
});

test('CPU finite boundary retains positive fractional extreme finite and ancestor minimum semantics', () =>
{
    const largeFinite = `1${'0'.repeat(308)}`;
    for (const kind of kinds)
    {
        for (const [quota, period, expected] of [
            ['50000', '100000', 0.5], ['150000', '100000', 1.5],
            ['000150000', '000100000', 1.5], ['1', largeFinite, 1e-308], [largeFinite, '1', 1e308]
        ])
        {
            const receipt = topology.buildMachineCpuTopology(boundary(kind, quota, period));
            topology.validateMachineCpuTopology(receipt);
            assert.equal(receipt.projection.finiteBoundary.disposition, 'observed');
            assert.deepEqual(receipt.projection.finiteBoundary.value, { kind, cores: expected, verified: true });
            const capacity = calculate(receipt);
            assert.equal(capacity.verifiedFiniteCpuLimitCores, expected);
            assert.equal(Number.isFinite(capacity.schedulerEnvelopeCpuUnits), true);
            assert.ok(capacity.schedulerEnvelopeCpuUnits > 0 && capacity.schedulerEnvelopeCpuUnits <= expected);
            assert.equal(capacity.calibrationSampleEligible, false);
            fallback.validateEffectiveCpuFallback(capacity, receipt, receipt.topologyDigest);
        }
        const raw = boundary(kind, 'max');
        raw.sources.boundary.value.limits.push({ locator: 'parent', quota: '150000', period: '100000' },
            { locator: 'root', quota: '125000', period: '100000' });
        assert.equal(topology.buildMachineCpuTopology(raw).projection.finiteBoundary.value.cores, 1.25);
    }
});

test('CPU finite boundary retains unlimited v1 v2 Windows and unavailable ancestry refusal', () =>
{
    for (const kind of kinds)
    {
        for (const quota of ['max', ...(kind === 'linux-cgroup-v1' ? ['-1'] : [])])
        {
            const receipt = topology.buildMachineCpuTopology(boundary(kind, quota));
            assert.equal(receipt.projection.finiteBoundary.disposition, 'unlimited');
            assert.equal(receipt.projection.finiteBoundary.value, null);
            assert.throws(() => calculate(receipt), /verified finite/u);
        }
        const raw = boundary(kind, '100000');
        raw.sources.boundary.value.ancestryComplete = false;
        const incomplete = topology.buildMachineCpuTopology(raw);
        assert.equal(incomplete.projection.finiteBoundary.disposition, 'unknown');
        assert.equal(incomplete.projection.finiteBoundary.value, null);
        assert.throws(() => calculate(incomplete), /verified finite/u);
        raw.sources.boundary = unavailable('no host grant');
        const missing = topology.buildMachineCpuTopology(raw);
        assert.equal(missing.projection.finiteBoundary.value, null);
        assert.throws(() => calculate(missing), /verified finite/u);
    }
});

test('CPU fallback refuses overflowed or coerced raw boundary authority through the actual topology entry', () =>
{
    for (const kind of kinds)
    {
        for (const [quota, period] of [['100000', overflow], [100000, '100000'], ['100000', ['100000']]])
        {
            assert.throws(() => calculate(topology.buildMachineCpuTopology(boundary(kind, quota, period))), /finite boundary (?:quota|period) invalid/u);
        }
        const raw = boundary(kind, overflow);
        raw.sources.boundary.value.limits.push({ locator: 'finite-parent', quota: '200000', period: '100000' });
        assert.throws(() => calculate(topology.buildMachineCpuTopology(raw)), /finite boundary quota invalid/u);
    }
});
