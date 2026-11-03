import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { identityFor, machine } from './cpu-calibration-test-support.mjs';

const { resolveRunCpuCapacity } = await import(new URL('../../tools/test/cpu-calibration-loader.mjs', import.meta.url));
const { runDag } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));

function fixture(t, { quota = '250000', memoryGiB = 3.5 } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-cpu-input-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // Producer-owned, controlled topology observations. No physical calibration
    // samples, prerequisite qualification or production-shaped cohort is created.
    const topology = machine({ logical: 8, quota });
    const identity = identityFor(topology);
    const runId = 'cpu-input-run';
    const selection = resolveRunCpuCapacity({ runId, topology, identity,
        activePointerPath: path.join(root, 'missing-active-pointer.json') });
    const tier = { id: 'ordinary', command: 'echo controlled', cacheInputs: [], executionDependsOn: [],
        services: [], parallelizable: true, exclusiveResources: [], resourceClass: 'cpu', cpuUnits: 1, memoryGiB: 1 };
    let executions = 0;
    const options = { root, runsRoot: path.join(root, 'runs'), runId, mode: 'fresh', targetTierId: tier.id,
        cpuCapacity: { selection, identity, topology },
        systemResources: { cpuCount: 256, availableCpuUnits: 999, availableMemoryGiB: memoryGiB, load1: 7 },
        currentFreeMemoryGiB: () => memoryGiB,
        snapshotWorktree: async () => ({ fingerprint: 'controlled', entries: new Map() }),
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'controlled' }, dynamicPriority: false,
        tiers: [tier], executeTier: async () =>
        {
            executions++;
            return { code: 0, signal: null };
        } };
    return { options, selection, executions: () => executions };
}

test('Fresh scheduler uses the sealed CPU fallback envelope and preserves the memory input', async (t) =>
{
    const current = fixture(t);
    const original = structuredClone(current.options.systemResources);
    const result = await runDag(current.options);
    assert.equal(result.status, 'success');
    assert.equal(current.executions(), 1);
    assert.deepEqual(result.checkpoint.resourceBudget, { cpuUnits: 2, memoryGiB: 3.5 });
    assert.deepEqual(result.checkpoint.cpuCapacityReceipt, current.selection);
    assert.equal(result.checkpoint.cpuCapacityReceipt.capacitySource, 'fallback');
    assert.equal(result.checkpoint.cpuCapacityReceipt.fallbackReceipt.uncalibrated, true);
    assert.equal(result.checkpoint.authoritative, false);
    assert.deepEqual(current.options.systemResources, original);
});

test('Fresh scheduler keeps memory admission independent of sufficient sealed CPU capacity', async (t) =>
{
    const current = fixture(t, { memoryGiB: 0.75 });
    const result = await runDag(current.options);
    assert.equal(result.status, 'failure');
    assert.equal(current.executions(), 0);
    assert.deepEqual(result.checkpoint.resourceBudget, { cpuUnits: 2, memoryGiB: 0.75 });
    assert.match(result.checkpoint.failure.reason, /unschedulable resource request/u);
});

test('Fresh scheduler preserves a fractional CPU envelope rather than rounding up admission', async (t) =>
{
    const current = fixture(t, { quota: '50000' });
    const result = await runDag(current.options);
    assert.equal(result.checkpoint.resourceBudget.cpuUnits, 0.5);
    assert.equal(result.status, 'failure');
    assert.equal(current.executions(), 0);
    assert.match(result.checkpoint.failure.reason, /cpu=1\/0\.5/u);
});

test('Fresh scheduler refuses a selection for another run before acquiring a run owner', async (t) =>
{
    const current = fixture(t);
    await assert.rejects(runDag({ ...current.options, runId: 'another-run' }), /plan CPU run identity mismatch/u);
    assert.equal(current.executions(), 0);
    assert.equal(fs.existsSync(current.options.runsRoot), false);
});

test('Fresh scheduler refuses missing current memory observations before admission', async (t) =>
{
    const current = fixture(t);
    delete current.options.systemResources.availableMemoryGiB;
    await assert.rejects(runDag(current.options), /current memory and load observations/u);
    assert.equal(current.executions(), 0);
    assert.equal(fs.existsSync(current.options.runsRoot), false);
});

test('scheduler explicitly refuses CPU reselection on Resume until restoration is implemented', async (t) =>
{
    const current = fixture(t);
    await assert.rejects(runDag({ ...current.options, mode: 'resume' }), /requires Fresh; resume capacity restoration/u);
    assert.equal(current.executions(), 0);
    assert.equal(fs.existsSync(current.options.runsRoot), false);
});
