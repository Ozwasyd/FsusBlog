import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

import { contract, digest, identityFor, machine, planFor, topology, writeActivationFixture } from './cpu-calibration-test-support.mjs';

const loader = await import(new URL('../../tools/test/cpu-calibration-loader.mjs', import.meta.url));
const resolve = (fixture, identity = fixture.plan.identity) => loader.resolveRunCpuCapacity({ runId: 'fixture-run',
    topology: fixture.plan.topology, identity, activePointerPath: fixture.pointerPath });

test('CPU loader exact identity activates calibration with exact one authority and sealed run provenance', (t) =>
{
    const fixture = writeActivationFixture(t);
    loader.activateCpuCalibration(fixture.pointerPath, fixture.reference);
    const receipt = resolve(fixture);
    assert.equal(receipt.capacitySource, 'calibration');
    assert.equal(receipt.effectiveCpuUnits, 12);
    assert.equal(receipt.calibrationDigest, fixture.selected.contentDigest);
    assert.equal(receipt.fallbackReceipt, null);
    assert.equal(loader.bindCpuCapacityToPlan(receipt, { runId: 'fixture-run', identity: fixture.plan.identity, topology: fixture.plan.topology }).contentDigest, receipt.contentDigest);
});

test('CPU loader rejects every bound identity drift without mixing fallback and calibration', (t) =>
{
    const fixture = writeActivationFixture(t);
    loader.activateCpuCalibration(fixture.pointerPath, fixture.reference);
    for (const field of contract.cpuIdentityFields)
    {
        const identity = { ...fixture.plan.identity, [field]: digest('drift') };
        if (['machine', 'topology', 'finiteBoundary', 'platform', 'arch', 'kernel', 'powerPolicy'].includes(field))
        {
            assert.throws(() => resolve(fixture, identity), /identity|stale/u);
        }
        else
        {
            const receipt = resolve(fixture, identity);
            assert.equal(receipt.capacitySource, 'fallback');
            assert.equal(receipt.effectiveCpuUnits, 8);
            assert.equal(receipt.calibrationDigest, null);
            assert.equal(receipt.fallbackReceipt.uncalibrated, true);
        }
    }
    const topology = machine({ quota: '600000' });
    const receipt = loader.resolveRunCpuCapacity({ runId: 'drift-run', topology,
        identity: identityFor(topology), activePointerPath: fixture.pointerPath });
    assert.equal(receipt.capacitySource, 'fallback');
    assert.equal(receipt.effectiveCpuUnits, 6);
});

test('CPU loader corrupt missing and tampered receipts use deterministic fallback without cached authority', (t) =>
{
    const fixture = writeActivationFixture(t);
    assert.equal(resolve(fixture).capacitySource, 'fallback');
    loader.activateCpuCalibration(fixture.pointerPath, fixture.reference);
    assert.equal(resolve(fixture).capacitySource, 'calibration');
    fs.writeFileSync(fixture.pointerPath, '{broken');
    assert.equal(resolve(fixture).capacitySource, 'fallback');
    loader.activateCpuCalibration(fixture.pointerPath, fixture.reference);
    fs.writeFileSync(fixture.reference.calibrationLocator, '{}');
    assert.equal(resolve(fixture).capacitySource, 'fallback');
    assert.throws(() => loader.activateCpuCalibration(fixture.pointerPath, fixture.reference), /digest/u);
});

test('CPU atomic pointer crash before rename preserves old bytes and removes uncommitted temporary', (t) =>
{
    const fixture = writeActivationFixture(t);
    loader.activateCpuCalibration(fixture.pointerPath, fixture.reference);
    const before = fs.readFileSync(fixture.pointerPath, 'utf8');
    assert.throws(() => loader.activateCpuCalibration(fixture.pointerPath, fixture.reference, () =>
    {
        assert.equal(fs.readFileSync(fixture.pointerPath, 'utf8'), before);
        throw new Error('crash before rename');
    }), /crash/u);
    assert.equal(fs.readFileSync(fixture.pointerPath, 'utf8'), before);
    assert.equal(fs.readdirSync(fixture.directory).filter((file) => file.endsWith('.tmp')).length, 0);
    assert.equal(resolve(fixture).capacitySource, 'calibration');
});

test('CPU loader contract fixtures cannot activate and sealed capacity cannot mutate during a run', (t) =>
{
    const fixture = writeActivationFixture(t, planFor());
    assert.throws(() => loader.activateCpuCalibration(fixture.pointerPath, fixture.reference), /fixture/u);
    const receipt = resolve(fixture);
    assert.equal(receipt.capacitySource, 'fallback');
    assert.throws(() =>
    {
        receipt.effectiveCpuUnits = 99;
    }, TypeError);
    assert.throws(() =>
    {
        receipt.identity.kernel = digest('changed');
    }, TypeError);
    fs.writeFileSync(fixture.pointerPath, '{}');
    assert.equal(receipt.capacitySource, 'fallback');
    assert.throws(() => loader.bindCpuCapacityToPlan(receipt, { runId: 'other', identity: fixture.plan.identity, topology: fixture.plan.topology }), /run identity/u);
});

test('CPU loader consistent topology kernel quota power drift selects the exact new fallback', (t) =>
{
    const fixture = writeActivationFixture(t);
    loader.activateCpuCalibration(fixture.pointerPath, fixture.reference);
    for (const mutate of [
        (raw) =>
        {
            raw.kernel = 'new-kernel';
        },
        (raw) =>
        {
            raw.sources.allowed.value = '0-7';
        },
        (raw) =>
        {
            raw.sources.boundary.value.limits[0].quota = '400000';
        },
        (raw) =>
        {
            raw.sources.power.value = 'new-power';
        }
    ])
    {
        const raw = structuredClone(fixture.plan.topology.raw);
        mutate(raw);
        const changed = topology.buildMachineCpuTopology(raw);
        const receipt = loader.resolveRunCpuCapacity({ runId: 'changed-run', topology: changed,
            identity: identityFor(changed), activePointerPath: fixture.pointerPath });
        assert.equal(receipt.capacitySource, 'fallback');
        assert.equal(receipt.schedulerEnvelopeCpuUnits, receipt.fallbackReceipt.schedulerEnvelopeCpuUnits);
        assert.equal(receipt.calibrationDigest, null);
    }
    const fractional = machine({ quota: '50000' });
    const receipt = loader.resolveRunCpuCapacity({ runId: 'fractional-run', topology: fractional,
        identity: identityFor(fractional), activePointerPath: fixture.pointerPath });
    assert.equal(receipt.schedulerEnvelopeCpuUnits, 0.5);
});

test('CPU atomic pointer concurrent real process readers observe complete old or new calibration', async (t) =>
{
    const first = writeActivationFixture(t);
    const second = writeActivationFixture(t, first.plan, (raw) => ({ ...raw,
        metrics: { ...raw.metrics, wallClockMs: raw.candidate === 6 ? 600 : 1000 } }));
    loader.activateCpuCalibration(first.pointerPath, first.reference);
    const script = `
        import { resolveRunCpuCapacity } from ${JSON.stringify(new URL('../../tools/test/cpu-calibration-loader.mjs', import.meta.url).href)};
        let reads = 0, errors = [];
        const input = ${JSON.stringify({ runId: 'reader-run', topology: first.plan.topology,
            identity: first.plan.identity, activePointerPath: first.pointerPath })};
        process.on('message', (message) => {
            if (message === 'stop') {
                process.send({ reads, errors });
                process.exit(errors.length ? 1 : 0);
            }
        });
        function read() {
            try {
                const value = resolveRunCpuCapacity(input);
                if (value.capacitySource !== 'calibration' || ![6,12].includes(value.effectiveCpuUnits)) {
                    errors.push(value.invalidReason ?? 'wrong capacity');
                }
            } catch (error) { errors.push(error.message); }
            reads++;
            setImmediate(read);
        }
        process.send('ready');
        read();`;
    const reader = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() =>
    {
        if (reader.exitCode === null)
        {
            reader.kill();
        }
    });
    const exited = new Promise((resolveExit, reject) =>
    {
        reader.once('error', reject);
        reader.once('exit', (code) => resolveExit(code));
    });
    await new Promise((ready, reject) =>
    {
        reader.once('message', ready);
        reader.once('error', reject);
        reader.once('exit', () => reject(new Error('reader exited before ready')));
    });
    for (let index = 0; index < 20; index++)
    {
        loader.activateCpuCalibration(first.pointerPath, index % 2 ? first.reference : second.reference);
        await new Promise((next) => setImmediate(next));
    }
    const result = new Promise((done) => reader.once('message', done));
    reader.send('stop');
    const report = await result;
    assert.equal(await exited, 0);
    assert.ok(report.reads > 0);
    assert.deepEqual(report.errors, []);
    assert.equal(resolve(first).capacitySource, 'calibration');
});

test('CPU plan independently rejects resealed capacity tampering and retains selected immutable authority', (t) =>
{
    const fixture = writeActivationFixture(t);
    loader.activateCpuCalibration(fixture.pointerPath, fixture.reference);
    const selected = resolve(fixture);
    const { contentDigest, ...body } = selected;
    assert.ok(contentDigest);
    const changed = contract.sealCpuValue({ ...body, effectiveCpuUnits: 100, schedulerEnvelopeCpuUnits: 100 });
    assert.throws(() => loader.bindCpuCapacityToPlan(changed, { runId: 'fixture-run', identity: fixture.plan.identity,
        topology: fixture.plan.topology }), /authority|envelope/u);
    const second = writeActivationFixture(t, fixture.plan, (raw) => ({ ...raw,
        metrics: { ...raw.metrics, wallClockMs: raw.candidate === 6 ? 600 : 1000 } }));
    loader.activateCpuCalibration(fixture.pointerPath, second.reference);
    assert.equal(resolve(fixture).effectiveCpuUnits, 6);
    const bound = loader.bindCpuCapacityToPlan(selected, { runId: 'fixture-run', identity: fixture.plan.identity,
        topology: fixture.plan.topology });
    assert.equal(bound.effectiveCpuUnits, 12);
    assert.equal(bound.calibrationDigest, fixture.selected.contentDigest);
});

test('CPU independent plan verifier rejects resealed machine boundary identities even with matching fallback math', (t) =>
{
    const fixture = writeActivationFixture(t, planFor());
    const original = resolve(fixture);
    const { contentDigest, ...body } = original;
    assert.ok(contentDigest);
    for (const field of ['machine', 'finiteBoundary', 'platform', 'arch', 'kernel', 'powerPolicy'])
    {
        const identity = { ...original.identity, [field]: digest('incorrect-machine-binding') };
        const altered = contract.sealCpuValue({ ...body, identity });
        assert.throws(() => loader.bindCpuCapacityToPlan(altered, { runId: 'fixture-run', identity,
            topology: fixture.plan.topology }), /machine identity mismatch/u);
    }
});
