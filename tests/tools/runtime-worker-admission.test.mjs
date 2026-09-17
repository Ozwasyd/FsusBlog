import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { resolveAdaptiveManifestWorkers } = await import(
    pathToFileURL(path.join(root, 'tools/test/run-command-manifest.mjs')).href
);

test('orchestration admission shares one granted CPU between two bounded children', () =>
{
    const env = {
        FSUSBLOG_TEST_RUN_ID: 'runtime-integration-live',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/runtime-integration-grants.json',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'runtime',
        FSUSBLOG_STEP_CPU_BUDGET: '1',
        FSUSBLOG_STEP_MEMORY_GIB: '3',
        FSUSBLOG_COMMAND_MANIFEST_WORKERS: '9'
    };
    const document = JSON.stringify({
        schema: 'fsusblog.test-matrix.resource-grants.v1',
        runId: 'runtime-integration-live',
        resourceBudget: { cpuUnits: 8, memoryGiB: 8 },
        grants: { runtime: { cpuUnits: 1, memoryGiB: 3 } }
    });

    assert.equal(resolveAdaptiveManifestWorkers({
        env,
        cpuCount: 8,
        freeMemoryBytes: 4 * 1024 ** 3,
        totalMemoryBytes: 8 * 1024 ** 3,
        load1: 7,
        readGrantFile: () => document,
        workload: 'orchestration'
    }), 2);
});

test('focused orchestration uses its inherited grant without a live grant file', () =>
{
    assert.equal(resolveAdaptiveManifestWorkers({
        env: {
            FSUSBLOG_STEP_CPU_BUDGET: '1',
            FSUSBLOG_STEP_MEMORY_GIB: '3',
            FSUSBLOG_COMMAND_MANIFEST_WORKERS: '9'
        },
        cpuCount: 8,
        freeMemoryBytes: 4 * 1024 ** 3,
        totalMemoryBytes: 8 * 1024 ** 3,
        load1: 7,
        workload: 'orchestration'
    }), 2);
});
