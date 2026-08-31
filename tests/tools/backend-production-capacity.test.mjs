import assert from 'node:assert/strict';
import test from 'node:test';

import {
    aggregatePartitionExecutionFailures,
    deriveBackendPartitionCount,
    readBackendResourceGrantAfterBenchmark,
    readBackendSchedulerResourceGrant,
    resolveBackendShardParallelism,
    resolveBackendPotentialProcessCount,
    runRollingPartitions
} from '../../tools/test/run-backend-production-shards.mjs';








test('backend production parallelism derives rolling process capacity from live CPU and memory budgets', () =>
{
    const resolve = (cpuBudget, memoryGiB = 64, availableCpu = cpuBudget) => (
        resolveBackendShardParallelism({
            env: {
                FSUSBLOG_BACKEND_CPU_BUDGET: String(cpuBudget),
                FSUSBLOG_BUNDLE_MEMORY_GIB: String(memoryGiB)
            },
            availableCpu,
            availableMemoryGiB: 1,
            totalMemoryGiB: 64
        })
    );
    const expected = [
        [2, 2, [1, 1]],
        [3, 2, [2, 1]],
        [4, 2, [2, 2]],
        [8, 2, [4, 4]],
        [12, 3, [4, 4, 4]],
        [16, 4, [4, 4, 4, 4]]
    ];
    for (const [cpuBudget, processCount, processorsByProcess] of expected)
    {
        const parallelism = resolve(cpuBudget);
        assert.equal(parallelism.maxConcurrentProcesses, processCount);
        assert.deepEqual(parallelism.processorsByProcess, processorsByProcess);
        assert.equal(parallelism.memoryGiBByProcess.length, processCount);
        assert.ok(Math.abs(parallelism.memoryGiBByProcess.reduce((sum, value) => sum + value, 0) - 64) < 1e-9);
        assert.equal(parallelism.allocatedCpuUnits, cpuBudget);
        assert.equal(parallelism.derivation.source, 'machine-derived');
        assert.equal(
            parallelism.derivation.formula,
            'min(max(2,floor(sqrt(cpuBudget))),cpuBudget,floor(memoryGiB/1GiB),12)'
        );
    }

    assert.equal(resolve(16, 3).maxConcurrentProcesses, 3);
    assert.equal(resolve(16, 2.25).maxConcurrentProcesses, 2);
    assert.throws(() => resolve(2, 1.99), /at least two/u);
    assert.throws(() => resolve(1, 64), /at least two available CPU units/u);

    const diagnosticOverride = resolveBackendShardParallelism({
        env: {
            FSUSBLOG_BACKEND_CPU_BUDGET: '12',
            FSUSBLOG_BUNDLE_MEMORY_GIB: '48',
            FSUSBLOG_BACKEND_PRODUCTION_SHARDS: '3'
        },
        availableCpu: 16,
        availableMemoryGiB: 1,
        totalMemoryGiB: 64
    });
    assert.equal(diagnosticOverride.maxConcurrentProcesses, 3);
    assert.deepEqual(diagnosticOverride.processorsByProcess, [4, 4, 4]);
    assert.deepEqual(diagnosticOverride.memoryGiBByProcess, [16, 16, 16]);
    assert.deepEqual(diagnosticOverride.derivation, {
        source: 'diagnostic-override',
        formula: 'min(max(2,floor(sqrt(cpuBudget))),cpuBudget,floor(memoryGiB/1GiB),12)',
        derivedProcessCount: 3,
        configuredProcessCount: 3,
        cpuAllocationFormula: 'floor(cpuBudget/processCount) plus one for the first cpuBudget%processCount processes',
        configuredProcessorsPerProcess: null,
        memoryAllocationFormula: 'memoryGiB/processCount with a 1 GiB per-testhost floor'
    });
    assert.equal(resolveBackendShardParallelism({
        env: {
            FSUSBLOG_BACKEND_CPU_BUDGET: '8',
            FSUSBLOG_BUNDLE_MEMORY_GIB: '16',
            FSUSBLOG_BACKEND_PRODUCTION_SHARDS: '3'
        },
        availableCpu: 8,
        availableMemoryGiB: 1,
        totalMemoryGiB: 64
    }).maxConcurrentProcesses, 3);
    assert.throws(() => resolveBackendShardParallelism({
        env: {
            FSUSBLOG_BACKEND_CPU_BUDGET: '8',
            FSUSBLOG_BACKEND_PRODUCTION_SHARDS: '3'
        },
        availableCpu: 8,
        availableMemoryGiB: 16,
        totalMemoryGiB: 64
    }), /exceeds memory budget limit 2/u);
    assert.throws(() => resolveBackendShardParallelism({
        env: {
            FSUSBLOG_BACKEND_CPU_BUDGET: '8',
            FSUSBLOG_BUNDLE_MEMORY_GIB: '64',
            FSUSBLOG_BACKEND_PRODUCTION_SHARDS: '3',
            FSUSBLOG_BACKEND_SHARD_PROCESSORS: '3'
        },
        availableCpu: 8,
        availableMemoryGiB: 64
    }), /allocation \[3,3,3\] must exactly consume CPU budget 8/u);
    assert.throws(() => resolveBackendShardParallelism({
        env: { FSUSBLOG_BACKEND_CPU_BUDGET: '8x', FSUSBLOG_BUNDLE_MEMORY_GIB: '8' },
        availableCpu: 8,
        availableMemoryGiB: 64
    }), /CPU budget must be a positive integer/u);
    assert.throws(() => resolveBackendShardParallelism({
        env: { FSUSBLOG_BACKEND_CPU_BUDGET: '8', FSUSBLOG_BUNDLE_MEMORY_GIB: '8GiB' },
        availableCpu: 8,
        availableMemoryGiB: 64
    }), /memory budget must be a positive number/u);
});

test('backend production derives more rolling partitions than processes from discovered class units', () =>
{
    const names = Array.from({ length: 11 }, (_, index) => `Example.Tests.Class${index}.Case`);
    const affinityGroups = [{
        name: 'endpoint',
        testNames: [names[0], names[1]]
    }];
    assert.deepEqual(deriveBackendPartitionCount(names, {
        maxConcurrentProcesses: 3,
        affinityGroups
    }), {
        partitionCount: 6,
        planningUnitCount: 10,
        testClassCount: 9,
        affinityUnitCount: 1,
        formula: 'min(planningUnitCount,max(processCount,ceil(processCount*partitionMultiplier)))'
    });
    assert.deepEqual(deriveBackendPartitionCount(names.slice(0, 5), {
        maxConcurrentProcesses: 3
    }).partitionCount, 5);
    assert.throws(() => deriveBackendPartitionCount(names.slice(0, 3), {
        maxConcurrentProcesses: 3
    }), /requires more than 3 indivisible/u);

    assert.deepEqual(deriveBackendPartitionCount(names, {
        maxConcurrentProcesses: 3,
        potentialConcurrentProcesses: 8,
        affinityGroups
    }), {
        partitionCount: 8,
        planningUnitCount: 10,
        testClassCount: 9,
        affinityUnitCount: 1,
        formula: 'min(planningUnitCount,potentialConcurrentProcesses)'
    });
    assert.equal(deriveBackendPartitionCount(names, {
        maxConcurrentProcesses: 3,
        potentialConcurrentProcesses: 5,
        affinityGroups
    }).partitionCount, 5);
});

test('backend production scheduler grant validation fails closed and derives host-bounded potential', () =>
{
    const env = {
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/resource-grants.json',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'backend',
        FSUSBLOG_TEST_RUN_ID: 'run-one'
    };
    const document = {
        schema: 'fsusblog.test-matrix.resource-grants.v1',
        runId: 'run-one',
        resourceBudget: { cpuUnits: 8, memoryGiB: 12 },
        grants: { backend: { cpuUnits: 3, memoryGiB: 4.5 } }
    };
    const grant = readBackendSchedulerResourceGrant({
        env,
        readFile: () => JSON.stringify(document)
    });
    assert.deepEqual({
        tierId: grant.tierId,
        runId: grant.runId,
        cpuUnits: grant.cpuUnits,
        memoryGiB: grant.memoryGiB,
        resourceBudget: grant.resourceBudget
    }, {
        tierId: 'backend',
        runId: 'run-one',
        cpuUnits: 3,
        memoryGiB: 4.5,
        resourceBudget: { cpuUnits: 8, memoryGiB: 12 }
    });
    assert.equal(resolveBackendPotentialProcessCount(grant, {
        availableCpu: 8,
        totalMemoryGiB: 16
    }), 8);
    assert.equal(resolveBackendPotentialProcessCount({
        resourceBudget: { cpuUnits: 32, memoryGiB: 64 }
    }, {
        availableCpu: 32,
        totalMemoryGiB: 128
    }), 12);
    assert.equal(resolveBackendPotentialProcessCount({
        resourceBudget: { cpuUnits: 16, memoryGiB: 4.5 }
    }, {
        availableCpu: 16,
        totalMemoryGiB: 64
    }), 4);
    assert.throws(() => readBackendSchedulerResourceGrant({
        env,
        readFile: () => JSON.stringify({ ...document, runId: 'run-two' })
    }), /runId mismatch/u);
    assert.throws(() => readBackendSchedulerResourceGrant({
        env,
        readFile: () => JSON.stringify({ ...document, grants: {} })
    }), /missing tier backend/u);
    assert.throws(() => readBackendSchedulerResourceGrant({
        env,
        readFile: () => JSON.stringify({ ...document, schema: 'unknown' })
    }), /invalid schema/u);
    assert.throws(() => resolveBackendPotentialProcessCount(grant, {
        availableCpu: 7,
        totalMemoryGiB: 16
    }), /exceeds host CPU or memory/u);
    assert.throws(() => readBackendResourceGrantAfterBenchmark({
        env: { FSUSBLOG_TEST_RUN_ID: 'run-one' },
        initialGrant: { cpuUnits: 3, memoryGiB: 4.5 },
        repositoryRoot: '/repo',
        exists: () => true,
        readFile: () => JSON.stringify({
            schema: 'fsusblog.local-production.benchmark-build-ready.v1',
            status: 'success',
            physicalBundleId: 'backend-tests',
            schedulerRunId: 'another-run'
        }),
        readSchedulerGrant: () => grant
    }), /not bound to run run-one/u);
    assert.equal(readBackendSchedulerResourceGrant({ env: {} }), null);
});

test('backend production rolling partitions keep the process bound, refill slots, and aggregate all failures', async () =>
{
    const partitions = Array.from({ length: 5 }, (_, index) => ({ index }));
    const gates = partitions.map(() =>
    {
        let resolve;
        const promise = new Promise((done) =>
        {
            resolve = done;
        });
        return { promise, resolve };
    });
    const started = [];
    let active = 0;
    let peakActive = 0;
    let activeCpu = 0;
    let peakCpu = 0;
    const rolling = runRollingPartitions(partitions, [2, 1], async (partition, slot) =>
    {
        started.push({ id: partition.index, slot: slot.processSlot, processors: slot.processors });
        active += 1;
        activeCpu += slot.processors;
        peakActive = Math.max(peakActive, active);
        peakCpu = Math.max(peakCpu, activeCpu);
        const result = await gates[partition.index].promise;
        active -= 1;
        activeCpu -= slot.processors;
        return { index: partition.index, code: result.code, signal: null };
    });

    await Promise.resolve();
    assert.deepEqual(started.map(({ id }) => id), [0, 1]);
    gates[0].resolve({ code: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started.slice(0, 3).map(({ id }) => id), [0, 1, 2]);
    assert.equal(started[2].slot, started[0].slot);

    gates[1].resolve({ code: 1 });
    gates[2].resolve({ code: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    for (const id of started.slice(3).map(({ id }) => id))
    {
        gates[id].resolve({ code: id === 4 ? 2 : 0 });
    }
    await new Promise((resolve) => setImmediate(resolve));
    for (let id = 0; id < gates.length; id += 1)
    {
        gates[id].resolve({ code: id === 4 ? 2 : 0 });
    }
    const outcomes = await rolling;
    assert.equal(peakActive, 2);
    assert.equal(peakCpu, 3);
    assert.deepEqual(outcomes.map(({ value }) => value.index), [0, 1, 2, 3, 4]);
    const failure = aggregatePartitionExecutionFailures(outcomes);
    assert.ok(failure instanceof AggregateError);
    assert.equal(failure.errors.length, 2);
    assert.deepEqual(failure.errors.map(({ message }) => message), [
        'partition 1: exit 1',
        'partition 4: exit 2'
    ]);
});

test('backend production rolling partitions expand deterministically from a 3-unit grant to machine potential', async () =>
{
    const partitions = Array.from({ length: 8 }, (_, index) => ({ index }));
    const gates = partitions.map(() =>
    {
        let resolve;
        const promise = new Promise((done) =>
        {
            resolve = done;
        });
        return { promise, resolve };
    });
    let grant = { cpuUnits: 3, memoryGiB: 3 };
    let publishGrant;
    const started = [];
    const rolling = runRollingPartitions(partitions, [1, 1, 1], async (partition, slot) =>
    {
        started.push({ partition: partition.index, ...slot });
        await gates[partition.index].promise;
        return { index: partition.index, code: 0, signal: null };
    }, {
        initialMemoryGiBByProcess: [1, 1, 1],
        readResourceGrant: () => grant,
        potentialProcessCount: 8,
        potentialMemoryGiB: 8,
        waitForResourceChange: () => new Promise((resolve) =>
        {
            publishGrant = resolve;
        })
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, 3);
    grant = { cpuUnits: 8, memoryGiB: 8 };
    publishGrant();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, 8);
    assert.equal(new Set(started.map(({ processSlot }) => processSlot)).size, 8);
    assert.equal(started.reduce((sum, { processors }) => sum + processors, 0), 8);
    assert.ok(started.every(({ memoryGiB }) => memoryGiB === 1));
    assert.ok(started.every(({ processSlot }) => processSlot < partitions.length));

    for (const gate of gates)
    {
        gate.resolve();
    }
    const outcomes = await rolling;
    assert.deepEqual(outcomes.map(({ value }) => value.index), partitions.map(({ index }) => index));
    assert.deepEqual(outcomes.rollingExecution, {
        dynamic: true,
        initialConcurrentProcesses: 3,
        peakConcurrentProcesses: 8,
        potentialConcurrentProcesses: 8,
        slots: Array.from({ length: 8 }, (_, processSlot) => ({
            processSlot,
            processors: 1,
            memoryGiB: 1
        })),
        observedGrant: { cpuUnits: 8, memoryGiB: 8 }
    });
});

test('backend production expansion assigns all newly admitted CPUs across a bounded host topology', async () =>
{
    const partitions = Array.from({ length: 4 }, (_, index) => ({ index }));
    const gates = partitions.map(() =>
    {
        let resolve;
        const promise = new Promise((done) =>
        {
            resolve = done;
        });
        return { promise, resolve };
    });
    let grant = { cpuUnits: 3, memoryGiB: 4 };
    let publishGrant;
    const started = [];
    const rolling = runRollingPartitions(partitions, [2, 1], async (partition, slot) =>
    {
        started.push({ partition: partition.index, ...slot });
        await gates[partition.index].promise;
        return { index: partition.index, code: 0, signal: null };
    }, {
        initialMemoryGiBByProcess: [2, 2],
        readResourceGrant: () => grant,
        potentialProcessCount: 4,
        potentialCpuUnits: 16,
        potentialMemoryGiB: 16,
        waitForResourceChange: () => new Promise((resolve) =>
        {
            publishGrant = resolve;
        })
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started.map(({ processors }) => processors), [2, 1]);
    grant = { cpuUnits: 16, memoryGiB: 16 };
    publishGrant();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, 4);
    assert.deepEqual(started.map(({ processors }) => processors), [2, 1, 7, 6]);
    assert.equal(started.reduce((sum, { processors }) => sum + processors, 0), 16);
    assert.equal(started.reduce((sum, { memoryGiB }) => sum + memoryGiB, 0), 16);

    for (const gate of gates)
    {
        gate.resolve();
    }
    const outcomes = await rolling;
    assert.equal(outcomes.rollingExecution.peakConcurrentProcesses, 4);
    assert.equal(outcomes.rollingExecution.slots.reduce((sum, { processors }) => sum + processors, 0), 16);
});

test('backend production rolling partitions bind unstarted slots to a smaller live memory grant', async () =>
{
    const partitions = [{ index: 0 }, { index: 1 }];
    const started = [];
    const outcomes = await runRollingPartitions(partitions, [1, 1], async (partition, slot) =>
    {
        started.push({ partition: partition.index, ...slot });
        return { index: partition.index, code: 0, signal: null };
    }, {
        initialMemoryGiBByProcess: [1.25, 1.25],
        readResourceGrant: () => ({ cpuUnits: 2, memoryGiB: 2 }),
        potentialProcessCount: 2,
        potentialMemoryGiB: 8
    });

    assert.equal(started.length, 2);
    assert.ok(started.every(({ memoryGiB }) => memoryGiB === 1));
    assert.deepEqual(outcomes.rollingExecution.slots, [
        { processSlot: 0, processors: 1, memoryGiB: 1 },
        { processSlot: 1, processors: 1, memoryGiB: 1 }
    ]);
});
