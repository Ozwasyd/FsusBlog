import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    aggregatePartitionExecutionFailures,
    backendPartitionEnvironment,
    runRollingPartitions
} from '../../tools/test/run-backend-production-shards.mjs';

async function observe(predicate)
{
    const deadline = Date.now() + 5000;
    while (!predicate())
    {
        assert.ok(Date.now() < deadline, 'child/admission observation timed out');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function gatedChildren(t, currentGrant, failingPartition = null)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-grant-admission-'));
    const children = new Map();
    const events = [];
    let releaseAll = false;
    let execution = null;
    const release = (id) => children.get(id)?.send('release');
    t.after(async () =>
    {
        releaseAll = true;
        for (const child of children.values()) child.kill('SIGKILL');
        await execution?.catch(() => {});
        await observe(() => children.size === 0);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const launch = (partition, slot) => new Promise((resolve, reject) =>
    {
        const child = spawn(process.execPath, ['-e', `
            const fs = require('node:fs');
            const result = { cpu: Number(process.env.FSUSBLOG_STEP_CPU_BUDGET), memory: Number(process.env.FSUSBLOG_STEP_MEMORY_GIB) };
            fs.writeFileSync(process.env.OWNED_RESULT, JSON.stringify(result));
            process.send(result);
            process.on('message', message => { if (message === 'release') process.exit(Number(process.env.OWNED_EXIT_CODE)); });
        `], {
            env: {
                ...backendPartitionEnvironment(process.env, {
                    processors: slot.processors, memoryGiB: slot.memoryGiB, namespace: 'grant-admission-test'
                }),
                OWNED_RESULT: path.join(directory, `${partition.index}.json`),
                OWNED_EXIT_CODE: String(partition.index === failingPartition ? 1 : 0)
            },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc']
        });
        children.set(partition.index, child);
        child.once('message', (allocation) =>
        {
            events.push({ type: 'admitted', id: partition.index, pid: child.pid, allocation, grant: { ...currentGrant() } });
            if (releaseAll) release(partition.index);
        });
        child.once('error', reject);
        child.once('exit', (code, signal) =>
        {
            children.delete(partition.index);
            events.push({ type: 'terminal', id: partition.index, code, signal });
            resolve({ code, signal });
        });
    });
    return {
        directory, events, children, launch, release,
        track: (running) => { execution = running; return running; },
        releaseRemaining: () =>
        {
            releaseAll = true;
            for (const id of children.keys()) release(id);
        }
    };
}

for (const shrinkingResource of ['cpu', 'memory'])
{
    test(`backend partition ${shrinkingResource} shrink preserves active real children and blocks pending admission`, { timeout: 15000 }, async (t) =>
    {
        let grant = { cpuUnits: 2, memoryGiB: 2 };
        let reads = 0;
        const fixture = gatedChildren(t, () => grant);
        const admitted = () => fixture.events.filter((event) => event.type === 'admitted');
        const running = fixture.track(runRollingPartitions(Array.from({ length: 8 }, (_, index) => ({ index, planningWeight: 8 - index })), [1, 1], fixture.launch, {
            initialMemoryGiBByProcess: [1, 1], potentialProcessCount: 4, potentialCpuUnits: 4, potentialMemoryGiB: 4,
            pollIntervalMs: 5, readResourceGrant: () => { reads += 1; return grant; }
        }));
        await observe(() => admitted().length === 2);
        grant = { cpuUnits: 4, memoryGiB: 4 };
        await observe(() => admitted().length === 4);
        assert.equal(fixture.events.filter((event) => event.type === 'terminal').length, 0, 'growth must precede every original child terminal');
        grant = shrinkingResource === 'cpu' ? { cpuUnits: 2, memoryGiB: 4 } : { cpuUnits: 4, memoryGiB: 2 };
        fixture.release(0);
        await observe(() => fixture.events.some((event) => event.type === 'terminal' && event.id === 0));
        const readsAfterTerminal = reads;
        await observe(() => reads >= readsAfterTerminal + 5 || admitted().length > 4);
        assert.equal(admitted().length, 4, 'new partition must wait while active costs exceed the shrunken grant');
        assert.equal(fixture.children.size, 3, 'shrink must not kill active children');
        fixture.release(1);
        fixture.release(2);
        await observe(() => admitted().length >= 5);
        fixture.releaseRemaining();
        const outcomes = await running;
        assert.equal(outcomes.length, 8);
        assert.deepEqual(outcomes.map((outcome) => outcome.partition.index), Array.from({ length: 8 }, (_, index) => index));
        assert.equal(new Set(admitted().map((event) => event.id)).size, 8);
        assert.equal(fixture.children.size, 0);
        assert.ok(fixture.events.filter((event) => event.type === 'terminal').every((event) => event.code === 0 && event.signal === null));
        assert.equal(fs.readdirSync(fixture.directory).length, 8, 'all exact child output owners must be retained');
        const allocations = new Map();
        for (const event of fixture.events)
        {
            if (event.type === 'terminal') allocations.delete(event.id);
            else
            {
                allocations.set(event.id, event.allocation);
                assert.ok([...allocations.values()].reduce((sum, allocation) => sum + allocation.cpu, 0) <= event.grant.cpuUnits);
                assert.ok([...allocations.values()].reduce((sum, allocation) => sum + allocation.memory, 0) <= event.grant.memoryGiB);
            }
        }
    });
}

test('invalid current backend grant drains real active children without admitting pending partitions', { timeout: 15000 }, async (t) =>
{
    let grant = { cpuUnits: 1, memoryGiB: 1 };
    let reads = 0;
    const fixture = gatedChildren(t, () => grant);
    const running = fixture.track(runRollingPartitions(Array.from({ length: 4 }, (_, index) => ({ index })), [1], fixture.launch, {
        initialMemoryGiBByProcess: [1], potentialProcessCount: 4, potentialCpuUnits: 4, potentialMemoryGiB: 4,
        pollIntervalMs: 5, readResourceGrant: () => { reads += 1; return grant; }
    }));
    const rejected = assert.rejects(running, /invalid live resource grant/u);
    await observe(() => fixture.events.some((event) => event.type === 'admitted'));
    grant = { cpuUnits: 0, memoryGiB: 1 };
    const invalidAtReads = reads;
    await observe(() => reads > invalidAtReads);
    fixture.releaseRemaining();
    await rejected;
    assert.equal(fixture.events.filter((event) => event.type === 'admitted').length, 1);
    assert.equal(fixture.children.size, 0);
});

test('real backend child failure retains independent partition execution and aggregate failure', { timeout: 15000 }, async (t) =>
{
    const fixture = gatedChildren(t, () => ({ cpuUnits: 2, memoryGiB: 2 }), 1);
    fixture.releaseRemaining();
    const outcomes = await fixture.track(runRollingPartitions(Array.from({ length: 4 }, (_, index) => ({ index })), [1, 1], fixture.launch, {
        initialMemoryGiBByProcess: [1, 1], potentialProcessCount: 2, potentialCpuUnits: 2, potentialMemoryGiB: 2,
        readResourceGrant: () => ({ cpuUnits: 2, memoryGiB: 2 }), pollIntervalMs: 5
    }));
    assert.deepEqual(outcomes.map((outcome) => outcome.value.code), [0, 1, 0, 0]);
    assert.ok(aggregatePartitionExecutionFailures(outcomes) instanceof Error);
    assert.equal(fs.readdirSync(fixture.directory).length, 4);
    assert.equal(fixture.children.size, 0);
});
