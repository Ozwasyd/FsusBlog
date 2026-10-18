import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';

import {
    contract, identityFor, machine, rawTopology, topology, unavailable, writeActivationFixture
} from './cpu-calibration-test-support.mjs';

const fallback = await import(new URL('../../tools/test/effective-cpu-fallback.mjs', import.meta.url));
const loader = await import(new URL('../../tools/test/cpu-calibration-loader.mjs', import.meta.url));
const calculate = (receipt) => fallback.calculateEffectiveCpuFallback(receipt, receipt.topologyDigest);
const resolve = (fixture, runId = 'observation-regression') => loader.resolveRunCpuCapacity({ runId,
    topology: fixture.plan.topology, identity: fixture.plan.identity, activePointerPath: fixture.pointerPath });

test('CPU observation unavailable or malformed SMT peers remain unknown independent of row ordering', () =>
{
    for (const cpu of [0, 1])
    {
        const raw = rawTopology({ logical: 2 });
        raw.sources.cores.value[cpu].siblings = null;
        const receipt = topology.buildMachineCpuTopology(raw);
        assert.deepEqual(receipt.projection.physical, { disposition: 'unknown',
            reason: 'SMT sibling mapping unavailable', value: null });
        topology.validateMachineCpuTopology(receipt);
    }
    for (const siblings of [null, '', 'malformed', '1-0', '0,0', '0-65536'])
    {
        for (const cpu of [0, 1, 2, 3, 4, 5])
        {
            for (const order of ['forward', 'reverse', 'rotated'])
            {
                const raw = rawTopology({ logical: 6, quota: '500000' });
                raw.sources.cores.value[cpu].siblings = siblings;
                if (order === 'reverse')
                {
                    raw.sources.cores.value.reverse();
                }
                else if (order === 'rotated')
                {
                    raw.sources.cores.value.push(raw.sources.cores.value.shift());
                }
                const receipt = topology.buildMachineCpuTopology(raw);
                assert.equal(receipt.collectorDisposition, 'partial');
                assert.deepEqual(receipt.projection.physical, { disposition: 'unknown',
                    reason: 'SMT sibling mapping unavailable', value: null });
                assert.deepEqual(receipt.projection.allowed.value, [0, 1, 2, 3, 4, 5]);
                assert.equal(receipt.projection.finiteBoundary.value.cores, 5);
                topology.validateMachineCpuTopology(receipt);
                const capacity = calculate(receipt);
                assert.equal(capacity.allowedPhysicalCoreCount, null);
                assert.equal(capacity.effectiveCpuUnits, 2);
                assert.equal(capacity.fallbackKind, 'uncalibrated-half-visible-logical');
                assert.equal(capacity.uncalibrated, true);
                assert.equal(capacity.calibrationSampleEligible, false);
                fallback.validateEffectiveCpuFallback(capacity, receipt, receipt.topologyDigest);
            }
        }
    }
    const raw = rawTopology({ logical: 6, cpuset: '0,2-5' });
    raw.sources.cores.value[1].siblings = null;
    assert.equal(topology.buildMachineCpuTopology(raw).projection.physical.value.count, 3);
    raw.sources.cores.value[3].siblings = null;
    raw.sources.boundary = unavailable('no host grant');
    const unknownBoundary = topology.buildMachineCpuTopology(raw);
    assert.equal(unknownBoundary.projection.physical.value, null);
    assert.equal(unknownBoundary.projection.finiteBoundary.value, null);
    assert.throws(() => calculate(unknownBoundary), /verified finite/u);
    assert.throws(() => loader.resolveRunCpuCapacity({ runId: 'no-host-grant', topology: unknownBoundary,
        identity: identityFor(unknownBoundary) }), /verified finite/u);
    const malformed = rawTopology();
    malformed.sources.cores.value[1].extra = true;
    assert.throws(() => topology.buildMachineCpuTopology(malformed), /fields must be exact/u);
    const collision = rawTopology();
    collision.sources.cores.value[1].siblings = '1';
    assert.equal(topology.buildMachineCpuTopology(collision).projection.physical.disposition, 'unknown');
    assert.equal(machine({ logical: 6 }).projection.physical.value.count, 3);
});

test('CPU observation actual collector matches process affinity or refuses unsupported authority', () =>
{
    const receipt = topology.collectMachineCpuTopology();
    topology.validateMachineCpuTopology(receipt);
    if (process.platform !== 'linux')
    {
        assert.equal(receipt.collectorDisposition, 'unsupported');
        assert.equal(receipt.projection.finiteBoundary.value, null);
        assert.throws(() => calculate(receipt), /verified finite/u);
        return;
    }
    const text = fs.readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/mu)?.[1];
    assert.ok(text);
    const expected = text.trim().split(',').flatMap((segment) =>
    {
        const [first, last = first] = segment.split('-').map(Number);
        return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
    });
    assert.deepEqual(receipt.raw.sources.allowed.value, text.trim());
    assert.deepEqual(receipt.projection.allowed.value, expected);
    assert.equal('effectiveCpuUnits' in receipt, false);
    if (receipt.projection.finiteBoundary.disposition !== 'observed')
    {
        assert.equal(receipt.projection.finiteBoundary.value, null);
        assert.throws(() => calculate(receipt), /verified finite/u);
    }
});

test('CPU observation independent resealing cannot promote forged physical counts or capacity authority', (t) =>
{
    const receipt = structuredClone(machine());
    receipt.projection.physical.value.count = 99;
    const { contentDigest, ...body } = receipt;
    assert.ok(contentDigest);
    assert.throws(() => topology.validateMachineCpuTopology(contract.sealCpuValue(body)), /recomputation/u);
    const fixture = writeActivationFixture(t);
    loader.activateCpuCalibration(fixture.pointerPath, fixture.reference);
    const selection = resolve(fixture);
    const { contentDigest: selectedDigest, ...selectedBody } = selection;
    assert.ok(selectedDigest);
    const altered = contract.sealCpuValue({ ...selectedBody, effectiveCpuUnits: 100, schedulerEnvelopeCpuUnits: 100 });
    assert.throws(() => loader.bindCpuCapacityToPlan(altered, { runId: selection.runId,
        identity: fixture.plan.identity, topology: fixture.plan.topology }), /authority|envelope/u);
});

test('CPU observation prior run provenance stays deeply frozen across pointer replacement and corruption', (t) =>
{
    const first = writeActivationFixture(t);
    const second = writeActivationFixture(t, first.plan, (raw) => ({ ...raw,
        metrics: { ...raw.metrics, wallClockMs: raw.candidate === 6 ? 600 : 1000 } }));
    loader.activateCpuCalibration(first.pointerPath, first.reference);
    const selected = resolve(first);
    const snapshot = structuredClone(selected);
    const checkFrozen = (value) =>
    {
        if (value && typeof value === 'object')
        {
            assert.equal(Object.isFrozen(value), true);
            Object.values(value).forEach(checkFrozen);
        }
    };
    checkFrozen(selected);
    loader.activateCpuCalibration(first.pointerPath, second.reference);
    assert.equal(resolve(first).calibrationDigest, second.selected.contentDigest);
    fs.writeFileSync(first.pointerPath, '{broken');
    const next = resolve(first);
    assert.equal(next.capacitySource, 'fallback');
    assert.equal(next.calibrationDigest, null);
    assert.equal(next.fallbackReceipt.calibrationSampleEligible, false);
    assert.deepEqual(selected, snapshot);
    assert.deepEqual(loader.bindCpuCapacityToPlan(selected, { runId: selected.runId,
        identity: first.plan.identity, topology: first.plan.topology }), snapshot);
    assert.throws(() =>
    {
        selected.calibrationReference.calibrationDigest = second.selected.contentDigest;
    }, TypeError);
});

test('CPU observation IPC reader sees complete atomic calibrations and crash rollback preserves bytes', { timeout: 60000 }, async (t) =>
{
    const first = writeActivationFixture(t);
    const second = writeActivationFixture(t, first.plan, (raw) => ({ ...raw,
        metrics: { ...raw.metrics, wallClockMs: raw.candidate === 6 ? 600 : 1000 } }));
    loader.activateCpuCalibration(first.pointerPath, first.reference);
    const childSource = `
        import { resolveRunCpuCapacity } from ${JSON.stringify(new URL('../../tools/test/cpu-calibration-loader.mjs', import.meta.url).href)};
        const input = ${JSON.stringify({ runId: 'ipc-observation', topology: first.plan.topology,
            identity: first.plan.identity, activePointerPath: first.pointerPath })};
        process.on('message', () => {
            try {
                const result = resolveRunCpuCapacity(input);
                process.send({ source: result.capacitySource, digest: result.calibrationDigest,
                    units: result.effectiveCpuUnits, eligible: result.fallbackReceipt?.calibrationSampleEligible });
            } catch (error) { process.send({ error: error.message }); }
        });
        process.send({ ready: true });`;
    const reader = spawn(process.execPath, ['--input-type=module', '-e', childSource],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(reader, 'exit');
    let stderr = '';
    reader.stderr.setEncoding('utf8').on('data', (chunk) =>
    {
        stderr += chunk;
    });
    t.after(async () =>
    {
        if (reader.exitCode === null && reader.signalCode === null)
        {
            reader.kill();
        }
        await exited;
    });
    const receive = async (pending) =>
    {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try
        {
            const [message] = await Promise.race([
                pending,
                once(reader, 'exit', { signal: controller.signal }).then(() =>
                {
                    throw new Error(`IPC reader exited: ${stderr}`);
                })
            ]);
            return message;
        }
        finally
        {
            clearTimeout(timer);
            controller.abort();
        }
    };
    assert.deepEqual(await receive(once(reader, 'message')), { ready: true });
    const seen = new Set();
    for (let index = 0; index < 24; index++)
    {
        const next = index % 2 ? first : second;
        const pending = once(reader, 'message');
        reader.send('read');
        loader.activateCpuCalibration(first.pointerPath, next.reference);
        const concurrent = await receive(pending);
        assert.equal(concurrent.source, 'calibration');
        assert.ok([first.selected.contentDigest, second.selected.contentDigest].includes(concurrent.digest));
        assert.equal(concurrent.units, concurrent.digest === first.selected.contentDigest ? 12 : 6);
        const acknowledged = once(reader, 'message');
        reader.send('read');
        const after = await receive(acknowledged);
        assert.equal(after.source, 'calibration');
        assert.equal(after.digest, next.selected.contentDigest);
        assert.equal(after.units, next === first ? 12 : 6);
        seen.add(after.digest);
    }
    assert.equal(seen.size, 2);
    const before = fs.readFileSync(first.pointerPath, 'utf8');
    assert.throws(() => loader.activateCpuCalibration(first.pointerPath, second.reference, () =>
    {
        throw new Error('injected pre-rename crash');
    }), /injected pre-rename/u);
    assert.equal(fs.readFileSync(first.pointerPath, 'utf8'), before);
    assert.equal(fs.readdirSync(first.directory).filter((file) => file.endsWith('.tmp')).length, 0);
    fs.writeFileSync(first.pointerPath, '{broken');
    const malformed = once(reader, 'message');
    reader.send('read');
    const refused = await receive(malformed);
    assert.equal(refused.source, 'fallback');
    assert.equal(refused.digest, null);
    assert.equal(refused.units, 8);
    assert.equal(refused.eligible, false);
    assert.equal(stderr, '');
});
