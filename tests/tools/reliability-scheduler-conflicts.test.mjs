import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const {loadReleaseReliabilityCatalog, releaseReliabilityResourceConflict, releaseReliabilitySchedulerProjection} = await import(new URL('../../tools/test-matrix/release-reliability-scheduler-projection.mjs', import.meta.url));
const {runDag} = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const {readSchedulerProducerTerminalFailure} = await import(new URL('../../tools/test-matrix/scheduler-run-owner.mjs', import.meta.url));
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

test('outer scheduler serializes the globally exclusive fixture and records resource plus holder', schedulerAuthorityTest, async (context) =>
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
            matrixTier('full-reliability-fixture', {
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
        currentFreeMemoryGiB: () => 8,
        snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} }),
        executeTier: async (current) =>
        {
            events.push(`start:${current.id}`);
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await delay(current.id === 'full-reliability-fixture' ? 30 : 15);
            active -= 1;
            events.push(`end:${current.id}`);
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'success', JSON.stringify(result.failure));
    assert.equal(result.checkpoint.authoritative, false);
    let authorityReads = 0;
    assert.throws(() => readSchedulerProducerTerminalFailure({
        runsRoot: path.join(directory, 'runs'),
        runId: result.runId,
        targetTierId: result.checkpoint.targetTierId,
        namespace: result.checkpoint.namespace,
        sourceState: result.checkpoint.sourceState,
        producerTierId: 'runtime-http-holder',
        activity: () =>
        {
            authorityReads += 1;
            return { status: 'active' };
        }
    }), /checkpoint authority identity mismatch/u);
    assert.equal(authorityReads, 0, 'injected telemetry must be refused before consulting physical owner authority');
    const fullStart = events.indexOf('start:full-reliability-fixture');
    const fullEnd = events.indexOf('end:full-reliability-fixture');
    assert.ok(fullStart >= 0 && fullEnd > fullStart);
    assert.ok(events.every((event, index) => !event.startsWith('start:')
        || event === 'start:full-reliability-fixture'
        || index < fullStart || index > fullEnd));
    assert.ok(maximumActive >= 1);
    const waits = JSON.stringify(result.checkpoint.resourceUtilization.waits);
    assert.match(waits, /runtime-http/u);
    assert.match(waits, /runtime-http-holder/u);
});

function controlledMemoryFixture(context)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-controlled-memory-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return {
        tiers: [{
            id: 'controlled-memory',
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
            executionKey: 'fixture/controlled-memory',
            executionVariant: 'ordinary',
            coverage: ['ordinary-unit']
        }],
        root: directory,
        runsRoot: path.join(directory, 'runs'),
        runId: 'controlled-memory',
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} })
    };
}

test('injected scheduler memory failure refuses execution without a fallback', async (context) =>
{
    const failure = new Error('controlled memory probe refused');
    let executions = 0;
    await assert.rejects(() => runDag({
        ...controlledMemoryFixture(context),
        currentFreeMemoryGiB: () =>
        {
            throw failure;
        },
        executeTier: async () =>
        {
            executions += 1;
            return { code: 0, signal: null };
        }
    }), (error) => error === failure);
    assert.equal(executions, 0);
});

test('injected scheduler telemetry cannot bypass strict physical resource refusal', async (context) =>
{
    let samples = 0;
    let executions = 0;
    await assert.rejects(() => runDag({
        ...controlledMemoryFixture(context),
        currentFreeMemoryGiB: () =>
        {
            samples += 1;
            return 2;
        },
        executeTier: async () =>
        {
            executions += 1;
            return { code: 0, signal: null };
        },
        resourceEnforcementMode: 'strict',
        resourceEnforcementOptions: { platform: 'darwin' }
    }), /strict cgroup enforcement unavailable/u);
    assert.equal(samples, 0);
    assert.equal(executions, 0);
});

test('production reliability owner admission refuses the controlled fixture before payload execution', async (context) =>
{
    const options = controlledMemoryFixture(context);
    options.tiers[0].id = 'release-reliability-fresh';
    options.tiers[0].parallelizable = false;
    options.tiers[0].exclusiveResources = ['release-reliability'];
    let executions = 0;
    const result = await runDag({
        ...options,
        currentFreeMemoryGiB: () => 2,
        executeTier: async () =>
        {
            executions += 1;
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'failure');
    assert.match(result.failure.reason, /ENOENT.*\.git/u);
    assert.equal(result.failure.producerSpawnCount, 0);
    assert.equal(result.checkpoint.authoritative, false);
    assert.equal(executions, 0);
});
