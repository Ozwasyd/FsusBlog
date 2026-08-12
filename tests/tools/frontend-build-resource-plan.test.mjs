import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveConcurrentStageResources,
    resolveFrontendBuildCapacity,
    resolveFrontendBuildDeadline,
    resolveStageEnvironment
} from '../../tools/frontend/build.mjs';
import { resolveEnsureWasmHashWorkers } from '../../tools/frontend/ensure-wasm.mjs';

test('frontend build capacity follows the live STEP grant and host ceilings', () =>
{
    const capacity = resolveFrontendBuildCapacity({
        env: {
            FSUSBLOG_STEP_CPU_BUDGET: '6',
            FSUSBLOG_STEP_MEMORY_GIB: '9'
        },
        availableCpu: 8,
        freeMemoryGiB: 12
    });

    assert.deepEqual(capacity, {
        cpuUnits: 6,
        memoryGiB: 9,
        maxParallel: 6
    });
});

test('direct frontend build deadline scales from the effective bundle grant', () =>
{
    const workload = {
        cpuWeight: 8,
        memoryWeight: 3,
        minCpuUnits: 2
    };

    assert.equal(resolveFrontendBuildDeadline({
        env: {},
        baseTimeoutMs: 300_000,
        workload,
        actualCapacity: {
            cpuUnits: 1,
            memoryGiB: 8
        }
    }), 2_400_000);
    assert.equal(resolveFrontendBuildDeadline({
        env: {},
        baseTimeoutMs: 300_000,
        workload,
        actualCapacity: {
            cpuUnits: 8,
            memoryGiB: 8
        }
    }), 300_000);
});

test('an inherited frontend step deadline remains the strict authority', () =>
{
    assert.equal(resolveFrontendBuildDeadline({
        env: {
            FSUSBLOG_STEP_DEADLINE_MS: '60000',
            FSUSBLOG_BUNDLE_CPU_BUDGET: '1',
            FSUSBLOG_BUNDLE_MEMORY_GIB: '8'
        },
        baseTimeoutMs: 300_000,
        workload: {
            cpuWeight: 8,
            memoryWeight: 3,
            minCpuUnits: 2
        },
        actualCapacity: {
            cpuUnits: 1,
            memoryGiB: 8
        }
    }), 60_000);
});

test('frontend build consumes a four-CPU production step grant and divides it exactly across parallel stages', () =>
{
    const capacity = resolveFrontendBuildCapacity({
        env: {
            FSUSBLOG_STEP_CPU_BUDGET: '4',
            FSUSBLOG_STEP_MEMORY_GIB: '8'
        },
        availableCpu: 8,
        freeMemoryGiB: 12
    });
    const plan = resolveConcurrentStageResources(2, capacity);

    assert.deepEqual(capacity, { cpuUnits: 4, memoryGiB: 8, maxParallel: 4 });
    assert.equal(plan.concurrent, true);
    assert.deepEqual(plan.stages.map((stage) => stage.cpuUnits), [2, 2]);
    assert.equal(plan.stages.reduce((total, stage) => total + stage.cpuUnits, 0), 4);
});

test('independent frontend stages divide CPU and memory grants without overselling them', () =>
{
    const plan = resolveConcurrentStageResources(2, {
        cpuUnits: 5,
        memoryGiB: 7
    });

    assert.equal(plan.concurrent, true);
    assert.deepEqual(plan.stages.map((stage) => stage.cpuUnits), [2.5, 2.5]);
    assert.deepEqual(plan.stages.map((stage) => stage.memoryGiB), [3.5, 3.5]);
    assert.equal(plan.stages.reduce((total, stage) => total + stage.cpuUnits, 0), 5);
    assert.equal(plan.stages.reduce((total, stage) => total + stage.memoryGiB, 0), 7);
});

test('frontend stages remain serial when the live grant cannot give each child one CPU', () =>
{
    const plan = resolveConcurrentStageResources(2, {
        cpuUnits: 1,
        memoryGiB: 4
    });

    assert.equal(plan.concurrent, false);
    assert.deepEqual(plan.stages.map((stage) => stage.cpuUnits), [1, 1]);
    assert.deepEqual(plan.stages.map((stage) => stage.memoryGiB), [4, 4]);
});

test('child environment replaces inherited bundle grants with the dynamically split share', () =>
{
    const env = resolveStageEnvironment({ cpuUnits: 2, memoryGiB: 3.25 }, {
        FSUSBLOG_BUNDLE_CPU_BUDGET: '12',
        FSUSBLOG_BUNDLE_MEMORY_GIB: '48'
    });

    assert.equal(env.FSUSBLOG_STEP_CPU_BUDGET, '2');
    assert.equal(env.FSUSBLOG_STEP_MEMORY_GIB, '3.25');
    assert.equal(env.FSUSBLOG_BUNDLE_CPU_UNITS, '2');
    assert.equal(env.FSUSBLOG_BUNDLE_CPU_BUDGET, '2');
    assert.equal(env.FSUSBLOG_BUNDLE_MEMORY_GIB, '3.25');
    assert.equal(env.FSUSBLOG_COMMAND_MANIFEST_WORKERS, '2');
    assert.equal(env.FSUSBLOG_NODE_TEST_CONCURRENCY, '2');
    assert.equal(env.UV_THREADPOOL_SIZE, '2');
});

test('ensure-wasm hash workers use the scheduler CPU grant without reapplying host memory ratios', () =>
{
    assert.equal(resolveEnsureWasmHashWorkers({
        env: {
            FSUSBLOG_STEP_CPU_BUDGET: '3',
            FSUSBLOG_STEP_MEMORY_GIB: '2'
        },
        itemCount: 20,
        availableCpu: 8,
        freeMemoryBytes: 1024,
        totalMemoryBytes: 8192
    }), 3);
});

test('direct ensure-wasm hashing derives its memory cap from the current host', () =>
{
    assert.equal(resolveEnsureWasmHashWorkers({
        env: {},
        itemCount: 20,
        availableCpu: 8,
        freeMemoryBytes: 2048,
        totalMemoryBytes: 8192
    }), 2);
});
