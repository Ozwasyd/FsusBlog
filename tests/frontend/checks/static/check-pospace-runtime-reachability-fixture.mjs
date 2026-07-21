#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { checkPoSpaceRuntimeReachability } from './check-pospace-runtime-reachability.mjs';
import { executorReachabilityCases } from './pospace-runtime-reachability-executor-cases.mjs';
import { hostRuntimeCases } from './pospace-runtime-reachability-host-cases.mjs';
import { workerRuntimeCases } from './pospace-runtime-reachability-worker-cases.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const checkerPath = path.join(repoRoot, 'tests/frontend/checks/static/check-pospace-runtime-reachability.mjs');
const sourcePaths = [
    'src/frontend/src/security/challenge-capability-registry.ts',
    'src/frontend/src/services/securityPoSpaceChallengeExecutor.ts',
    'src/frontend/src/services/securityPoSpaceClient.ts',
    'src/frontend/src/services/securityPoSpaceRuntime.ts',
    'src/frontend/src/workers/security/pospace.worker.ts',
    'src/frontend/src/components/security/FsusSecurityChallenge.vue',
    'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
    'src/frontend/src/composables/useNotification.ts'
];

const cases = [
    ...executorReachabilityCases,
    ...hostRuntimeCases,
    ...workerRuntimeCases
];

function createFixtureRoot()
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-pospace-reachability-'));
    for (const relative of sourcePaths)
    {
        const destination = path.join(root, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(path.join(repoRoot, relative), 'utf8'));
    }
    return root;
}

for (const testCase of cases)
{
    const root = createFixtureRoot();
    try
    {
        const target = path.join(root, testCase.file);
        const original = readFileSync(target, 'utf8');
        const mutated = testCase.mutate(original);
        assert.notEqual(mutated, original, `${testCase.name} fixture must alter its source`);
        writeFileSync(target, mutated);

        if (testCase.shouldPass)
        {
            assert.doesNotThrow(
                () => checkPoSpaceRuntimeReachability(root),
                `${testCase.name} must preserve the runtime edge`
            );
            continue;
        }

        assert.throws(
            () => checkPoSpaceRuntimeReachability(root),
            error => error instanceof assert.AssertionError
        && new RegExp(testCase.expected, 'u').test(error.message),
            `${testCase.name} must fail for the expected reason`
        );
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
}

const poisonedRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-pospace-authority-'));
try
{
    const result = spawnSync(process.execPath, [checkerPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, FSUSBLOG_POSPACE_REACHABILITY_ROOT: poisonedRoot }
    });
    assert.equal(
        result.status,
        0,
        `environment variables must not replace the authoritative scan root: ${result.stderr || result.stdout}`
    );
}
finally
{
    rmSync(poisonedRoot, { recursive: true, force: true });
}

console.log(`[pospace-runtime-reachability-fixture] ok cases=${cases.length}`);
