import assert from 'node:assert/strict';
import test from 'node:test';

import { digest, machine, observed, rawTopology, topology, unavailable } from './cpu-calibration-test-support.mjs';

test('CPU topology distinguishes host online allowed and SMT physical identities', () =>
{
    const receipt = machine({ allowed: '0-7' });
    assert.equal(receipt.projection.host.value.length, 16);
    assert.equal(receipt.projection.allowed.value.length, 8);
    assert.equal(receipt.projection.physical.value.count, 4);
    assert.equal('effectiveCpuUnits' in receipt, false);
    topology.validateMachineCpuTopology(receipt);
});

test('CPU topology intersects restricted cpuset and counts partial sibling visibility without guessing', () =>
{
    const receipt = machine({ allowed: '0-7', cpuset: '0,2,4,6' });
    assert.deepEqual(receipt.projection.allowed.value, [0, 2, 4, 6]);
    assert.equal(receipt.projection.physical.value.count, 4);
    assert.deepEqual(receipt.projection.physical.value.cores[0].siblings, [0, 1]);
    assert.deepEqual(receipt.projection.physical.value.cores[0].allowedSiblings, [0]);
});

test('CPU topology observes non SMT and heterogeneous core class rather than logical half', () =>
{
    const receipt = machine({ logical: 8, smt: false });
    assert.equal(receipt.projection.physical.value.count, 8);
    assert.equal(receipt.projection.physical.value.cores[0].coreClass.value, 'performance');
    assert.equal(receipt.projection.physical.value.cores[7].coreClass.value, 'efficiency');
});

test('CPU topology refuses missing and colliding physical mappings explicitly', () =>
{
    const missing = rawTopology();
    missing.sources.cores.value.pop();
    assert.equal(topology.buildMachineCpuTopology(missing).projection.physical.disposition, 'unknown');
    const collision = rawTopology();
    collision.sources.cores.value[1].core = '9';
    assert.match(topology.buildMachineCpuTopology(collision).projection.physical.reason, /collision/u);
    const mismatch = rawTopology();
    mismatch.sources.cores.value[1].siblings = '1';
    assert.equal(topology.buildMachineCpuTopology(mismatch).projection.physical.disposition, 'unknown');
});

test('CPU topology verifies fractional and ancestor minimum limits and distinguishes unlimited unknown', () =>
{
    const raw = rawTopology({ quota: '150000' });
    raw.sources.boundary.value.limits.push({ locator: 'ancestor', quota: '125000', period: '100000' });
    assert.equal(topology.buildMachineCpuTopology(raw).projection.finiteBoundary.value.cores, 1.25);
    assert.equal(machine({ quota: 'max' }).projection.finiteBoundary.disposition, 'unlimited');
    raw.sources.boundary = unavailable();
    assert.equal(topology.buildMachineCpuTopology(raw).projection.finiteBoundary.value, null);
    raw.sources.boundary = observed({ kind: 'linux-cgroup-v2', ancestryComplete: false,
        limits: [{ locator: 'hidden', quota: '100000', period: '100000' }] });
    assert.equal(topology.buildMachineCpuTopology(raw).projection.finiteBoundary.disposition, 'unknown');
});

test('CPU topology Linux and Windows fixtures preserve equivalent actual process sets and job limit', () =>
{
    const linux = machine({ allowed: '0-7', quota: '600000' });
    const windows = machine({ platform: 'win32', allowed: '0-7', quota: '600000' });
    assert.deepEqual(windows.projection.allowed, linux.projection.allowed);
    assert.deepEqual(windows.projection.physical, linux.projection.physical);
    assert.equal(windows.projection.finiteBoundary.value.cores, 6);
    assert.equal(windows.projection.finiteBoundary.value.kind, 'windows-job');
});

test('CPU topology independent recomputation rejects raw and projection digest drift', () =>
{
    const receipt = structuredClone(machine());
    receipt.raw.sources.allowed.value = '0-3';
    assert.throws(() => topology.validateMachineCpuTopology(receipt), /digest/u);
    const changed = structuredClone(machine());
    changed.projection.physical.value.count = 99;
    const body = structuredClone(changed);
    delete body.contentDigest;
    changed.contentDigest = digest(body);
    assert.throws(() => topology.validateMachineCpuTopology(changed), /recomputation/u);
    assert.throws(() => topology.validateMachineCpuTopology(machine(), digest('stale')), /stale/u);
});

test('CPU topology real collector records process allowed set and never invents finite enforcement', () =>
{
    const receipt = topology.collectMachineCpuTopology();
    topology.validateMachineCpuTopology(receipt);
    assert.equal(receipt.raw.platform, process.platform);
    assert.ok(['observed', 'unknown', 'unsupported', 'unlimited'].includes(receipt.projection.finiteBoundary.disposition));
    assert.equal('effectiveCpuUnits' in receipt, false);
});
