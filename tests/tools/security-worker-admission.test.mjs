import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { resolveAdaptiveManifestWorkers } = await import(
    pathToFileURL(path.join(root, 'tools/test/run-command-manifest.mjs')).href
);

test('security domain checker runs through Node without executable permission', () =>
{
    const checker = path.join(root, 'tools/security/check-security-domain-layout.mjs');
    assert.equal(statSync(checker).mode & 0o111, 0);
    const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[security-domain\] ok:/u);
});

test('scheduler-admitted security pool follows a current live grant', () =>
{
    const env = {
        FSUSBLOG_TEST_RUN_ID: 'security-static-live',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/security-static-grants.json',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'runtime',
        FSUSBLOG_STEP_CPU_BUDGET: '1',
        FSUSBLOG_STEP_MEMORY_GIB: '1',
        FSUSBLOG_COMMAND_MANIFEST_WORKERS: '5'
    };
    const document = JSON.stringify({
        schema: 'fsusblog.test-matrix.resource-grants.v1',
        runId: 'security-static-live',
        resourceBudget: { cpuUnits: 8, memoryGiB: 8 },
        grants: { runtime: { cpuUnits: 2, memoryGiB: 2 } }
    });
    assert.equal(resolveAdaptiveManifestWorkers({
        env,
        cpuCount: 8,
        freeMemoryBytes: 128 * 1024 ** 2,
        totalMemoryBytes: 8 * 1024 ** 3,
        load1: 8,
        readGrantFile: () => document,
        workload: 'scheduler-admitted'
    }), 2);
});

test('ordinary security pool follows an admitted grant despite stale host pressure', () =>
{
    const env = {
        FSUSBLOG_TEST_RUN_ID: 'security-runtime-live',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/security-runtime-grants.json',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'runtime',
        FSUSBLOG_STEP_CPU_BUDGET: '1',
        FSUSBLOG_STEP_MEMORY_GIB: '1'
    };
    const document = JSON.stringify({
        schema: 'fsusblog.test-matrix.resource-grants.v1',
        runId: 'security-runtime-live',
        resourceBudget: { cpuUnits: 8, memoryGiB: 8 },
        grants: { runtime: { cpuUnits: 3, memoryGiB: 3 } }
    });
    assert.equal(resolveAdaptiveManifestWorkers({
        env,
        cpuCount: 8,
        freeMemoryBytes: 128 * 1024 ** 2,
        totalMemoryBytes: 64 * 1024 ** 3,
        load1: 8,
        readGrantFile: () => document
    }), 3);
});
