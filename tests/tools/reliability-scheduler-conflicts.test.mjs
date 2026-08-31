import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
    loadReleaseReliabilityCatalog,
    releaseReliabilityResourceConflict,
    releaseReliabilitySchedulerProjection
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test-matrix/release-reliability-scheduler-projection.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { runDag } from '../../tools/test-matrix/scheduler.mjs';

const catalog = loadReleaseReliabilityCatalog();
const schedulerAuthorityAvailable = Object.hasOwn(catalog, 'schedulerTimeoutPolicies');
const schedulerAuthorityTest = {
    skip: schedulerAuthorityAvailable ? false : 'scheduler catalog authority is activated by the dependent projection slice'
};
const tier = (id) => ({ id, ...releaseReliabilitySchedulerProjection(catalog, id) });

function assertConflict(candidateId, holder)
{
    const conflict = releaseReliabilityResourceConflict(tier(candidateId), [holder]);
    assert.ok(conflict);
    assert.equal(conflict.holder, holder.id);
    assert.match(conflict.reason, new RegExp(`${conflict.resource}.*${holder.id}`, 'u'));
}

test('load and soak cannot overlap on runtime-http', schedulerAuthorityTest, () =>
{
    assertConflict('release-load-peak', tier('release-soak-min'));
});

test('memory and handle scenarios cannot overlap', schedulerAuthorityTest, () =>
{
    assertConflict('release-memory-leak-budget', tier('release-open-handle-budget'));
});

test('mutation conflicts with native fuzz on build-artifacts', schedulerAuthorityTest, () =>
{
    assertConflict('release-mutation-critical-slice', {
        id: 'native-fuzz-fixture',
        exclusiveResources: ['build-artifacts']
    });
});

test('data-scale conflicts with shared database/runtime owners', schedulerAuthorityTest, () =>
{
    assertConflict('release-data-scale-m', {
        id: 'shared-data-scale-database-fixture',
        exclusiveResources: ['data-scale-postgres']
    });
});

test('benchmark measurements share performance-counters exclusively', schedulerAuthorityTest, () =>
{
    assertConflict('release-load-burst', tier('release-load-peak'));
});

test('conflict evidence is null only when domains do not intersect', schedulerAuthorityTest, () =>
{
    assert.equal(releaseReliabilityResourceConflict(tier('release-load-peak'), [{
        id: 'static-governance-fixture',
        exclusiveResources: ['static-source']
    }]), null);
});

test('outer scheduler serializes the full authority and records resource plus holder', schedulerAuthorityTest, async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-reliability-conflict-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const events = [];
    let active = 0;
    let maximumActive = 0;
    const matrixTier = (id, overrides = {}) => ({
        id,
        command: `${process.execPath} -e "process.exit(0)"`,
        executionDependsOn: [],
        services: [],
        parallelizable: true,
        exclusiveResources: [],
        phase: 0,
        resourceClass: 'cpu',
        cpuUnits: 1,
        memoryGiB: 0.1,
        cacheInputs: [],
        executionKey: `fixture/${id}`,
        executionVariant: 'ordinary',
        coverage: ['ordinary-unit'],
        ...overrides
    });
    const result = await runDag({
        tiers: [
            matrixTier('release-reliability-fresh', {
                parallelizable: false,
                exclusiveResources: ['release-reliability'],
                cpuUnits: 4,
                memoryGiB: 1
            }),
            matrixTier('unrelated-ready-tier'),
            matrixTier('runtime-http-holder', {
                exclusiveResources: ['runtime-http']
            }),
            matrixTier('runtime-http-candidate', {
                exclusiveResources: ['runtime-http']
            })
        ],
        root: directory,
        runsRoot: path.join(directory, 'runs'),
        runId: 'reliability-conflict',
        maxParallel: 4,
        systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
        snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} }),
        executeTier: async (current) =>
        {
            events.push(`start:${current.id}`);
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await delay(current.id === 'release-reliability-fresh' ? 30 : 15);
            active -= 1;
            events.push(`end:${current.id}`);
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'success');
    const fullStart = events.indexOf('start:release-reliability-fresh');
    const fullEnd = events.indexOf('end:release-reliability-fresh');
    assert.ok(fullStart >= 0 && fullEnd > fullStart);
    assert.ok(events.every((event, index) => !event.startsWith('start:')
        || event === 'start:release-reliability-fresh'
        || index < fullStart || index > fullEnd));
    assert.ok(maximumActive >= 1);
    const waits = JSON.stringify(result.checkpoint.resourceUtilization.waits);
    assert.match(waits, /runtime-http/u);
    assert.match(waits, /runtime-http-holder/u);
});
