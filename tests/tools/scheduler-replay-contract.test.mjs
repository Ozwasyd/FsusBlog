/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createSchedulerReplayActual,
    createSchedulerReplayPlan,
    validateSchedulerReplayActual,
    validateSchedulerReplayPlan
} from '../../tools/test/scheduler-replay-contract.mjs';
import { runDag } from '../../tools/test-matrix/scheduler.mjs';

const tiers = [
    { id: 'build', executionDependsOn: [], executionClass: 'build', parallelizable: true },
    { id: 'unit', executionDependsOn: ['build'], executionClass: 'runtime', parallelizable: true },
    { id: 'browser', executionDependsOn: ['build'], executionClass: 'browser', parallelizable: true }
];

function plan()
{
    return createSchedulerReplayPlan({
        tiers,
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: `sha256:${'b'.repeat(64)}`,
        schedulerRunId: 'scheduler-replay-run',
        readyOrderPolicy: 'seeded-shuffle',
        shuffleSeed: 'scheduler-seed',
        concurrencyCap: 2,
        expectedAdmissionSequence: ['build', 'unit', 'browser']
    });
}

function checkpoint()
{
    return {
        runId: 'scheduler-replay-run',
        maxParallel: 2,
        status: 'success',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
        priorityScheduling: {
            waves: [
                {
                    wave: 1,
                    readyTierIds: ['build'],
                    admissionOrder: ['build'],
                    decisions: [{ tierId: 'build', admitted: true, hardConstraint: null, rank: 0 }]
                },
                {
                    wave: 2,
                    readyTierIds: ['unit', 'browser'],
                    admissionOrder: ['unit', 'browser'],
                    decisions: [
                        { tierId: 'unit', admitted: true, hardConstraint: null, rank: 0 },
                        { tierId: 'browser', admitted: true, hardConstraint: null, rank: 1 }
                    ]
                }
            ]
        },
        tiers: {
            build: { status: 'success', priorityDecision: { rank: 0 } },
            unit: { status: 'success', priorityDecision: { rank: 0 } },
            browser: { status: 'success', priorityDecision: { rank: 1 } }
        }
    };
}

test('scheduler plan binds canonical DAG, policy, seed, eligible set and cap', () =>
{
    const sealed = plan();
    assert.equal(validateSchedulerReplayPlan(sealed, { tiers: [...tiers].reverse(), maxParallel: 2 }), sealed);
    assert.deepEqual(sealed.eligibleStepIds, ['browser', 'build', 'unit']);
});

test('actual scheduler admissions retain ready sets, blockers and admission rather than completion order', () =>
{
    const sealed = plan();
    const actual = createSchedulerReplayActual({ plan: sealed, checkpoint: checkpoint() });
    assert.deepEqual(actual.admittedStepIds, ['build', 'unit', 'browser']);
    assert.deepEqual(actual.admissionEvents[1].readySet, ['unit', 'browser']);
    assert.equal(validateSchedulerReplayActual(actual, sealed), actual);
});

test('catalog, cap, missing, duplicate and admission drift fail closed', () =>
{
    const sealed = plan();
    assert.throws(() => validateSchedulerReplayPlan(sealed, {
        tiers: [...tiers, { id: 'extra', executionDependsOn: [] }],
        maxParallel: 2
    }), /catalog\/dependency drift/u);
    assert.throws(() => validateSchedulerReplayPlan(sealed, { tiers, maxParallel: 1 }), /cap drift/u);
    const missing = checkpoint();
    missing.priorityScheduling.waves[1].decisions.pop();
    assert.throws(() => createSchedulerReplayActual({ plan: sealed, checkpoint: missing }), /admission sequence drift/u);
    const duplicate = checkpoint();
    duplicate.priorityScheduling.waves[1].decisions[1].tierId = 'unit';
    assert.throws(() => createSchedulerReplayActual({ plan: sealed, checkpoint: duplicate }), /admission sequence drift/u);
});

test('resource/state blockers remain visible and cannot be bypassed by replay', () =>
{
    const sealed = plan();
    const blocked = checkpoint();
    blocked.priorityScheduling.waves[1].decisions.splice(1, 0, {
        tierId: 'exclusive-peer',
        admitted: false,
        hardConstraint: 'exclusive-resource',
        rank: 1
    });
    const actual = createSchedulerReplayActual({ plan: sealed, checkpoint: blocked });
    assert.deepEqual(actual.admissionEvents[1].blockers, [{ tierId: 'exclusive-peer', blocker: 'exclusive-resource' }]);
});

test('production scheduler consumes a sealed plan and persists exact actual admissions', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-scheduler-replay-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourceState = {
        commit: 'c'.repeat(40),
        worktreeFingerprint: `sha256:${'d'.repeat(64)}`
    };
    const executableTiers = [
        { id: 'left', executionDependsOn: [] },
        { id: 'right', executionDependsOn: [] },
        { id: 'join', executionDependsOn: ['left', 'right'] }
    ].map((entry) => ({
        command: `${process.execPath} --version`,
        services: [],
        parallelizable: true,
        exclusiveResources: [],
        phase: 0,
        resourceClass: 'cpu',
        maxParallel: 2,
        cpuUnits: 1,
        memoryGiB: 0.1,
        cacheInputs: [],
        executionClass: 'runtime',
        executionKey: `test/${entry.id}`,
        executionVariant: 'ordinary',
        coverage: ['ordinary-unit'],
        ...entry
    }));
    const replayPlan = createSchedulerReplayPlan({
        tiers: executableTiers,
        sourceCommit: sourceState.commit,
        worktreeFingerprint: sourceState.worktreeFingerprint,
        schedulerRunId: 'scheduler-replay-production',
        readyOrderPolicy: 'canonical',
        shuffleSeed: 'unused-canonical-seed',
        concurrencyCap: 2,
        expectedAdmissionSequence: ['left', 'right', 'join']
    });
    const result = await runDag({
        tiers: executableTiers,
        root: directory,
        runsRoot: path.join(directory, 'runs'),
        runId: replayPlan.schedulerRunId,
        maxParallel: 2,
        sourceState,
        snapshotWorktree: async () => ({ fingerprint: sourceState.worktreeFingerprint, entries: {} }),
        systemResources: { cpuCount: 2, availableMemoryGiB: 4, load1: 0 },
        executionReplayPlan: replayPlan,
        executeTier: async (_tier, execution) =>
        {
            execution.writeOutput('passed\n');
            return { code: 0, signal: null };
        }
    });
    const checkpoint = JSON.parse(fs.readFileSync(path.join(
        directory,
        'runs',
        replayPlan.schedulerRunId,
        'checkpoint.json'
    ), 'utf8'));
    assert.equal(result.status, 'success');
    assert.equal(checkpoint.status, 'success');
    assert.equal(checkpoint.executionReplay.planDigest, replayPlan.planDigest);
    assert.deepEqual(checkpoint.executionReplay.actual.admittedStepIds, ['left', 'right', 'join']);
    assert.equal(validateSchedulerReplayActual(checkpoint.executionReplay.actual, replayPlan), checkpoint.executionReplay.actual);
});
