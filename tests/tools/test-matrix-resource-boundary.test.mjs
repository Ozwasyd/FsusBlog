import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { materializeTestMatrixRunner } from './support/esm-fixture-materializer-runner.mjs';
import { materializeEsmFixture, preflightMaterializedEsmFixture } from './support/esm-fixture-materializer.mjs';

const { RunEvidenceObjectStore } = await import(new URL('../../tools/test-matrix/content-addressed-evidence-store.mjs', import.meta.url));
const { bindResidentLeaseEnforcement, createResidentLeaseInventory } = await import(new URL('../../tools/test-matrix/resident-resource-leases.mjs', import.meta.url));
const { sealSchedulerRunOwner } = await import(new URL('../../tools/test-matrix/scheduler-run-owner.mjs', import.meta.url));
const scheduler = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function createTempDir(name)
{
    return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`));
}

async function loadScheduler()
{
    return scheduler;
}

function tier(id, overrides = {})
{
    return {
        id,
        command: `${process.execPath} -e "process.exit(0)"`,
        executionDependsOn: [],
        services: [],
        parallelizable: true,
        exclusiveResources: [],
        phase: 0,
        resourceClass: 'cpu',
        maxParallel: 8,
        cpuUnits: 1,
        memoryGiB: 0.1,
        cacheInputs: [],
        executionKey: `test/${id}`,
        executionVariant: 'ordinary',
        coverage: ['ordinary-unit'],
        ...overrides
    };
}

const stableSnapshot = async () => ({ fingerprint: 'stable', entries: {} });

test('ESM fixture materializer follows literal dynamic imports without treating comments as dependencies', async (t) =>
{
    const source = createTempDir('dynamic-import-source');
    const fixture = createTempDir('dynamic-import-target');
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    fs.mkdirSync(path.join(source, 'tools'));
    fs.writeFileSync(path.join(source, 'tools/entry.mjs'), [
        "// import('./missing-comment.mjs')",
        'const text = "import(\'./missing-string.mjs\')";',
        'export const value = (await import(`./adapter.mjs`)).value;',
        'export { text };',
        'process.stdout.write(String(value));'
    ].join('\n'));
    fs.writeFileSync(path.join(source, 'tools/adapter.mjs'),
        "export const value = (await import(new URL('./leaf.mjs', import.meta.url))).value;\n");
    fs.writeFileSync(path.join(source, 'tools/leaf.mjs'), 'export const value = 42;\n');
    const declaration = { entries: ['tools/entry.mjs'], allowedRoots: ['tools'] };
    const result = materializeEsmFixture({ repositoryRoot: source, fixtureRoot: fixture, ...declaration });
    assert.deepEqual(result.files, ['tools/adapter.mjs', 'tools/entry.mjs', 'tools/leaf.mjs']);
    assert.equal(execFileSync(process.execPath, [result.entryFiles[0]], { encoding: 'utf8' }), '42');
    fs.unlinkSync(path.join(fixture, 'tools/adapter.mjs'));
    assert.throws(() => preflightMaterializedEsmFixture({ fixtureRoot: fixture, ...declaration }),
        /local dependency is missing.*specifier=\.\/adapter\.mjs/u);
});

test('ESM fixture materializer carries declared runtime assets without parsing them as modules', (t) =>
{
    const source = createTempDir('runtime-asset-source');
    const fixture = createTempDir('runtime-asset-target');
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    fs.mkdirSync(path.join(source, 'tools'));
    fs.writeFileSync(path.join(source, 'tools/entry.mjs'), 'export const runtimeAsset = "worker.py";\n');
    const bytes = 'import sys\nprint("materialized asset")\n';
    fs.writeFileSync(path.join(source, 'tools/worker.py'), bytes, { mode: 0o755 });
    const declaration = { entries: ['tools/entry.mjs'], assets: ['tools/worker.py'], allowedRoots: ['tools'] };
    const result = materializeEsmFixture({ repositoryRoot: source, fixtureRoot: fixture, ...declaration });
    assert.deepEqual(result.files, ['tools/entry.mjs', 'tools/worker.py']);
    assert.equal(fs.readFileSync(path.join(fixture, 'tools/worker.py'), 'utf8'), bytes);
    assert.equal(fs.statSync(path.join(fixture, 'tools/worker.py')).mode & 0o777,
        fs.statSync(path.join(source, 'tools/worker.py')).mode & 0o777);
    assert.deepEqual(preflightMaterializedEsmFixture({ fixtureRoot: fixture, ...declaration }), result.files);
    fs.unlinkSync(path.join(fixture, 'tools/worker.py'));
    assert.throws(() => preflightMaterializedEsmFixture({ fixtureRoot: fixture, ...declaration }), /runtime asset.*missing/u);
});

test('ESM fixture runtime assets reject undeclared roots, missing files and symlinks before copying', (t) =>
{
    const source = createTempDir('runtime-asset-boundary');
    const fixture = createTempDir('runtime-asset-refused');
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    fs.mkdirSync(path.join(source, 'tools'));
    fs.writeFileSync(path.join(source, 'tools/entry.mjs'), 'export const value = true;\n');
    fs.writeFileSync(path.join(source, 'outside.py'), 'sentinel\n');
    fs.symlinkSync(path.join(source, 'outside.py'), path.join(source, 'tools/linked.py'));
    for (const [asset, pattern] of [
        ['outside.py', /escapes allowed roots/u],
        ['tools/missing.py', /runtime asset.*missing/u],
        ['tools/linked.py', /runtime asset.*literal regular file/u],
        ['tools', /runtime asset.*literal regular file/u]
    ])
    {
        assert.throws(() => materializeEsmFixture({ repositoryRoot: source, fixtureRoot: fixture,
            entries: ['tools/entry.mjs'], assets: [asset], allowedRoots: ['tools'] }), pattern);
        assert.deepEqual(fs.readdirSync(fixture), [], 'validate the complete source closure before any copy');
    }
    assert.equal(fs.readFileSync(path.join(source, 'outside.py'), 'utf8'), 'sentinel\n');
});

test('materialized runner retains the actual physical execution scripts, platform assets and canonical inputs', (t) =>
{
    const fixture = createTempDir('runner-runtime-assets');
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    materializeTestMatrixRunner(root, fixture);
    for (const file of [
        'tools/test/physical-execution-unix-bootstrap.mjs',
        'tools/test/physical-execution-linux-systemd-bootstrap.mjs',
        'tools/test/physical-execution-linux-preexec.py',
        'tools/test/physical-execution-nested-socket.py',
        'tools/test/physical-execution-windows-job.ps1',
        'tools/test-matrix/windows-job-members.ps1',
        'tools/test-matrix/windows-job-supervisor.ps1',
        'tools/test/lanes/release-final.sh',
        'tests/fixtures/test-matrix/release-final-evidence-inputs.json'
    ])
    {
        assert.deepEqual(fs.readFileSync(path.join(fixture, file)), fs.readFileSync(path.join(root, file)), file);
        assert.equal(fs.statSync(path.join(fixture, file)).mode & 0o777,
            fs.statSync(path.join(root, file)).mode & 0o777, file);
    }
    const input = 'tests/fixtures/test-matrix/release-final-evidence-inputs.json';
    fs.unlinkSync(path.join(fixture, input));
    assert.throws(() => preflightMaterializedEsmFixture({ fixtureRoot: fixture,
        entries: ['tools/run-test-matrix.mjs'], assets: [input],
        allowedRoots: ['tools', 'src/frontend/scripts/fsusui-root.mjs', input] }), /runtime asset.*missing/u);
});


test('scheduler checkpoint recovery applies grant journal payloads beyond the compact boundary', async (t) =>
{
    const temp = createTempDir('scheduler-grant-journal-recovery');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const runId = 'interrupted-grant';
    const checkpointFile = path.join(temp, 'runs', runId, 'checkpoint.json');
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const first = await loadScheduler();
    const baseline = first.recordCheckpointFailure(checkpointFile, runId,
        { tierId: 'worker', exitCode: 1, reason: 'fixture interruption' }, { targetTierId: 'worker', sourceState });
    const baselineBytes = fs.readFileSync(checkpointFile, 'utf8');
    const grant = { schema: 'fsusblog.test-matrix.resource-grants.v1', runId, sourceState,
        schedulerOwnerToken: '11111111-1111-4111-8111-111111111111', resourceBudget: { cpuUnits: 2, memoryGiB: 2 },
        residentReservation: { cpuUnits: 0, memoryGiB: 0 }, grants: { worker: { cpuUnits: 1, memoryGiB: 0.5 } },
        generatedAt: new Date().toISOString() };
    const store = new RunEvidenceObjectStore({ root: path.join(path.dirname(checkpointFile), 'evidence-store'), runId, sourceState });
    store.appendJournalEvent({ eventType: 'resource-grants-updated', status: 'failure', step: 'scheduler', payload: { operations: [
        { kind: 'set', path: ['revision'], value: baseline.revision + 1 },
        { kind: 'set', path: ['schedulerRunOwnerToken'], value: grant.schedulerOwnerToken },
        { kind: 'set', path: ['resourceUtilization'], value: { resourceGrants: grant, retainedResourceGrants: {} } }
    ] } });
    assert.equal(fs.readFileSync(checkpointFile, 'utf8'), baselineBytes, 'journal append must not rewrite the compact compatibility view');
    const recoveryProbe = fileURLToPath(new URL('./support/scheduler-checkpoint-recovery-probe.mjs', import.meta.url));
    const recovered = JSON.parse(execFileSync(process.execPath, [recoveryProbe, checkpointFile, runId],
        { encoding: 'utf8' }));
    const restarted = await loadScheduler();
    assert.equal(recovered.revision, baseline.revision + 2);
    assert.deepEqual(recovered.resourceUtilization.resourceGrants, grant,
        'the existing checkpoint writer must retain the journal payload, not pass the event envelope as its patch');
    const grantFile = path.join(path.dirname(checkpointFile), 'resource-grants.json');
    const sentinel = path.join(temp, 'grant-sentinel.json');
    fs.writeFileSync(sentinel, JSON.stringify(grant), { mode: 0o600 });
    const journalFile = path.join(store.journalsDirectory, `${runId}.jsonl`);
    const journalBytes = fs.readFileSync(journalFile, 'utf8');
    const checkpointBytes = fs.readFileSync(checkpointFile, 'utf8');
    for (const [variant, pattern] of [
        ['missing', /projection differs from its durable journal/u],
        ['valid-active', /unsettled resource grants/u],
        ['zeroed', /projection differs from its durable journal/u],
        ['forged-compatibility', /projection differs from its durable journal/u],
        ['source', /projection differs from its durable journal/u],
        ['owner', /projection differs from its durable journal/u],
        ['run', /projection is incomplete or invalid/u],
        ['negative', /projection is incomplete or invalid/u],
        ['symlink', /owned, literal, singly linked regular file/u],
        ['hardlink', /owned, literal, singly linked regular file/u]
    ])
    {
        const changed = structuredClone(grant);
        if (['zeroed', 'forged-compatibility'].includes(variant))
        {
            changed.grants = {};
        }
        if (variant === 'forged-compatibility')
        {
            const forged = JSON.parse(checkpointBytes);
            forged.revision += 1;
            forged.resourceUtilization.resourceGrants = changed;
            fs.writeFileSync(checkpointFile, JSON.stringify(forged));
        }
        if (variant === 'source')
        {
            changed.sourceState.commit = 'c'.repeat(40);
        }
        if (variant === 'owner')
        {
            changed.schedulerOwnerToken = '22222222-2222-4222-8222-222222222222';
        }
        if (variant === 'run')
        {
            changed.runId = 'another-run';
        }
        if (variant === 'negative')
        {
            changed.grants.worker.cpuUnits = -1;
        }
        if (variant === 'symlink')
        {
            fs.symlinkSync(sentinel, grantFile);
        }
        else if (variant === 'hardlink')
        {
            fs.linkSync(sentinel, grantFile);
        }
        else if (variant !== 'missing')
        {
            fs.writeFileSync(grantFile, JSON.stringify(changed), { mode: 0o600, flag: 'wx' });
        }
        try
        {
            const expectedCheckpointBytes = fs.readFileSync(checkpointFile, 'utf8');
            for (const mode of ['fresh', 'resume'])
            {
                let rebound = false;
                await assert.rejects(() => restarted.runDag({ root: temp, runsRoot: path.join(temp, 'runs'), runId, mode,
                    tiers: [], sourceState, snapshotWorktree: stableSnapshot, onSourceState: () => rebound = true }), pattern);
                assert.equal(rebound, false, `${mode}/${variant} cannot erase a journaled grant`);
                assert.equal(fs.readFileSync(journalFile, 'utf8'), journalBytes);
                assert.equal(fs.readFileSync(checkpointFile, 'utf8'), expectedCheckpointBytes);
            }
        }
        finally
        {
            if (variant !== 'missing' && fs.lstatSync(grantFile, { throwIfNoEntry: false }))
            {
                fs.unlinkSync(grantFile);
            }
            if (variant === 'forged-compatibility')
            {
                fs.writeFileSync(checkpointFile, checkpointBytes);
            }
        }
    }
});

test('scheduler journals changed grants before worker dispatch and settles the same projection to zero', async (t) =>
{
    const temp = createTempDir('scheduler-grant-publication');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const { runDag, inspectSchedulerResourceRetention } = await loadScheduler();
    const runId = 'grant-publication';
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const runDirectory = path.join(temp, '.tmp/test-runs', runId);
    let started = 0;
    let retainedOwner;
    const options = { root: temp, runsRoot: path.dirname(runDirectory), runId, sourceState,
        tiers: [tier('worker')], snapshotWorktree: stableSnapshot,
        executeTier: async () =>
        {
            const projection = JSON.parse(fs.readFileSync(path.join(runDirectory, 'resource-grants.json'), 'utf8'));
            const store = new RunEvidenceObjectStore({ root: path.join(runDirectory, 'evidence-store'), runId, sourceState });
            const grantEvent = store.readJournal().filter((event) => event.eventType === 'resource-grants-updated').at(-1);
            assert.ok(grantEvent, 'grant event must be persisted before executor entry');
            const payload = store.readObject(grantEvent.payloadDigest).value;
            assert.deepEqual(payload.operations.find((operation) =>
                operation.path.join('.') === 'resourceUtilization.resourceGrants').value, projection);
            assert.deepEqual(projection.grants.worker, { cpuUnits: 1, memoryGiB: 0.1 });
            assert.deepEqual(projection.sourceState, sourceState);
            retainedOwner = JSON.parse(fs.readFileSync(path.join(temp, '.tmp/test-runs/.locks', `${runId}.lock/owner.json`), 'utf8'));
            assert.equal(inspectSchedulerResourceRetention({ root: temp, runId, namespace: 'test-matrix', sourceState,
                schedulerOwner: retainedOwner }).status, 'retained');
            started += 1;
            return { code: 0, signal: null };
        } };
    for (let index = 0; index < 2; index += 1)
    {
        const result = await runDag(options);
        assert.equal(result.status, 'success');
        const projection = JSON.parse(fs.readFileSync(path.join(runDirectory, 'resource-grants.json'), 'utf8'));
        assert.deepEqual(projection.grants, {});
        assert.deepEqual(result.checkpoint.resourceUtilization.resourceGrants, projection);
        assert.equal(projection.schedulerOwnerToken, result.checkpoint.schedulerRunOwnerToken);
        const binding = { root: temp, runId, namespace: 'test-matrix', sourceState, schedulerOwner: retainedOwner };
        assert.equal(inspectSchedulerResourceRetention(binding).status, 'released');
        for (const changed of [
            { namespace: 'wrong-namespace' },
            { sourceState: { ...sourceState, commit: 'c'.repeat(40) } },
            { schedulerOwner: { ...retainedOwner, ownerToken: 'different-owner' } },
            { schedulerOwner: sealSchedulerRunOwner({ ...retainedOwner, ownerToken: '22222222-2222-4222-8222-222222222222' }) },
            { runId: 'missing-run' }
        ])
        {
            assert.throws(() => inspectSchedulerResourceRetention({ ...binding, ...changed }), /scheduler resource retention/u);
        }
        for (const file of ['resource-grants.json', `evidence-store/journals/${runId}.jsonl`])
        {
            const original = path.join(runDirectory, file);
            const saved = `${original}.fixture-retained`;
            fs.renameSync(original, saved);
            try
            {
                assert.throws(() => inspectSchedulerResourceRetention(binding), /journal|projection/u,
                    `missing ${file} cannot release capacity`);
            }
            finally
            {
                fs.renameSync(saved, original);
            }
        }
        const journalFile = path.join(runDirectory, 'evidence-store/journals', `${runId}.jsonl`);
        const journalBytes = fs.readFileSync(journalFile, 'utf8');
        for (const bytes of ['', `${journalBytes.trimEnd().split('\n').slice(0, -1).join('\n')}\n`])
        {
            fs.writeFileSync(journalFile, bytes);
            try
            {
                assert.throws(() => inspectSchedulerResourceRetention(binding), /journal.*(missing|truncated)/u);
            }
            finally
            {
                fs.writeFileSync(journalFile, journalBytes);
            }
        }
        assert.equal(inspectSchedulerResourceRetention(binding).status, 'released');
    }
    assert.equal(started, 2, 'an actually settled previous grant does not block independent Fresh execution');
});


test('runDag retains a rejected settlement grant and closes admission even when collecting failures', async (t) =>
{
    const { runDag } = await loadScheduler();
    for (const collectFailures of [false, true])
    {
        for (const executionCode of [0, 23])
        {
            await t.test(`collect=${collectFailures}, exit=${executionCode}`, async (t) =>
            {
                const temp = createTempDir('scheduler-retained-settlement');
                t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
                const executed = [];
                const result = await runDag({
                    tiers: [tier('retained'), tier('must-not-start', { phase: 1 })],
                    root: temp,
                    runsRoot: path.join(temp, 'runs'),
                    runId: 'retained-settlement',
                    maxParallel: 1,
                    collectFailures,
                    systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
                    snapshotWorktree: stableSnapshot,
                    executeTier: async (current) =>
                    {
                        executed.push(current.id);
                        return { code: executionCode, signal: null };
                    },
                    afterTierSettled: async (current) =>
                    {
                        if (current.id === 'retained')
                        {
                            throw new Error('exact service cleanup remains unverifiable');
                        }
                    }
                });
                assert.equal(result.status, 'failure');
                assert.deepEqual(executed, ['retained']);
                assert.equal(result.checkpoint.tiers['must-not-start'].status, 'blocked');
                assert.match(result.checkpoint.tiers['must-not-start'].reason, /settlement.*retained/u);
                assert.equal(result.checkpoint.tiers.retained.exitCode, executionCode || 1);
                assert.match(result.checkpoint.tiers.retained.settlementFailure.reason, /exact service cleanup/u);
                if (executionCode !== 0)
                {
                    assert.match(result.failure.reason, /exited 23/u);
                }
                const retained = result.checkpoint.resourceUtilization.retainedResourceGrants.retained;
                assert.equal(retained.status, 'retained');
                assert.equal(retained.bundleId, 'retained');
                assert.deepEqual(retained.resourceGrant, { cpuUnits: 1, memoryGiB: 0.1 });
                const finalSample = result.checkpoint.resourceUtilization.samples.at(-1);
                assert.equal(finalSample.activeCount, 0);
                assert.equal(finalSample.reservedCpuUnits, 1);
                assert.equal(finalSample.reservedMemoryGiB, 0.1);
                const grants = JSON.parse(fs.readFileSync(path.join(result.runDirectory, 'resource-grants.json'), 'utf8'));
                assert.deepEqual(grants.grants, { retained: retained.resourceGrant });
                const checkpointBytes = fs.readFileSync(result.checkpointPath, 'utf8');
                for (const mode of ['fresh', 'resume'])
                {
                    let rebound = false;
                    await assert.rejects(runDag({
                        tiers: [tier('retained'), tier('must-not-start', { phase: 1 })],
                        root: temp,
                        runsRoot: path.join(temp, 'runs'),
                        runId: 'retained-settlement',
                        mode,
                        snapshotWorktree: stableSnapshot,
                        onSourceState: () =>
                        {
                            rebound = true;
                        }
                    }), /retains unsettled resource grants; independent owner reconciliation required/u);
                    assert.equal(rebound, false, `${mode} must not rebind resources before reconciliation`);
                    assert.equal(fs.readFileSync(result.checkpointPath, 'utf8'), checkpointBytes);
                }
            });
        }
    }
});

test('runDag rejects incomplete physical termination before invoking the settlement owner', async (t) =>
{
    const { runDag } = await loadScheduler();
    for (const termination of [
        { terminated: false, postObservation: 'unverifiable', reason: 'identity drift' },
        { terminated: false, postObservation: 'members-remain', reason: 'owned child still live' },
        { terminated: true, postObservation: 'unverifiable', reason: 'inconsistent result' },
        { terminated: true, postObservation: 'zero-members', reason: 'producer-deadline' }
    ])
    {
        await t.test(`${termination.terminated}:${termination.postObservation}`, async (t) =>
        {
            const temp = createTempDir('scheduler-termination-settlement');
            t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
            const complete = termination.terminated && termination.postObservation === 'zero-members';
            const settled = [];
            const result = await runDag({
                tiers: [tier('terminated'), tier('next', { phase: 1 })],
                root: temp,
                runsRoot: path.join(temp, 'runs'),
                runId: 'termination-settlement',
                maxParallel: 1,
                collectFailures: true,
                systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
                snapshotWorktree: stableSnapshot,
                executeTier: async (current) => current.id === 'terminated'
                    ? { code: 7, signal: null, physicalExecutionTermination: termination }
                    : { code: 0, signal: null },
                afterTierSettled: (current) =>
                {
                    settled.push(current.id);
                }
            });
            assert.equal(result.status, 'failure');
            assert.equal(result.failure.exitCode, 7);
            assert.match(result.failure.reason, /exited 7/u);
            assert.deepEqual(result.checkpoint.tiers.terminated.physicalExecutionTermination, termination);
            assert.deepEqual(settled, complete ? ['terminated', 'next'] : []);
            assert.equal(result.checkpoint.tiers.next.status, complete ? 'success' : 'blocked');
            if (!complete)
            {
                assert.equal(result.checkpoint.resourceUtilization.retainedResourceGrants.terminated.status, 'retained');
                assert.match(result.checkpoint.tiers.terminated.settlementFailure.reason, /physical execution termination incomplete/u);
            }
        });
    }
});

test('runDag accounts for an asynchronous settlement until its owner finishes', async (t) =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-pending-settlement');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    let settlementStartedAt;
    let settlementFinishedAt;
    const events = [];
    const result = await runDag({
        tiers: [tier('finishing'), tier('next')],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'pending-settlement',
        maxParallel: 1,
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            events.push(`execute:${current.id}`);
            return { code: 0, signal: null };
        },
        afterTierSettled: async (current) =>
        {
            if (current.id === 'finishing')
            {
                settlementStartedAt = Date.now();
                // Span the scheduler's existing 500 ms observation interval.
                await delay(650);
                settlementFinishedAt = Date.now();
                events.push('settled:finishing');
            }
        }
    });
    assert.equal(result.status, 'success');
    assert.deepEqual(events, ['execute:finishing', 'settled:finishing', 'execute:next']);
    const observations = result.checkpoint.resourceUtilization.samples.filter((sample) =>
        sample.atMs > settlementStartedAt && sample.atMs < settlementFinishedAt);
    assert.ok(observations.length > 0, 'settlement must be observed while its owner is pending');
    for (const sample of observations)
    {
        assert.equal(sample.activeCount, 1);
        assert.equal(sample.reservedCpuUnits, 1);
        assert.equal(sample.reservedMemoryGiB, 0.1);
    }
    assert.deepEqual(result.checkpoint.resourceUtilization.retainedResourceGrants, {});
    assert.equal(result.checkpoint.resourceUtilization.samples.at(-1).reservedCpuUnits, 0);
});

test('runDag drains active siblings without expanding or releasing a rejected settlement grant', async (t) =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-settlement-drain');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const executed = [];
    const aborted = [];
    const settled = [];
    let releaseSibling;
    let grantFile;
    let grantsAtAbort;
    let grantsBeforeFailure;
    const dynamicTier = (id) => tier(id, {
        resourceGrantMode: 'dynamic',
        cpuWeight: 1,
        memoryWeight: 1,
        minCpuUnits: 1,
        cpuUnits: 4,
        memoryGiB: 4
    });
    const result = await runDag({
        tiers: [dynamicTier('a-retained'), dynamicTier('b-running'), tier('next', { phase: 1 })],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'settlement-drain',
        maxParallel: 2,
        collectFailures: true,
        systemResources: { cpuCount: 4, availableCpuUnits: 4, availableMemoryGiB: 4, load1: 0 },
        currentFreeMemoryGiB: () => 4,
        snapshotWorktree: stableSnapshot,
        executeTier: async (current, context) =>
        {
            executed.push(current.id);
            grantFile = context.env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE;
            if (current.id === 'b-running')
            {
                // The fallback bounds a regression without treating elapsed time as cleanup evidence.
                await Promise.race([new Promise((resolve) =>
                {
                    releaseSibling = resolve;
                }), delay(500)]);
            }
            return { code: 0, signal: null };
        },
        afterTierSettled: async (current) =>
        {
            settled.push(current.id);
            if (current.id === 'a-retained')
            {
                grantsBeforeFailure = JSON.parse(fs.readFileSync(grantFile, 'utf8')).grants;
                throw new Error('service remains owned but cleanup is unverified');
            }
        },
        abortTier: (current) =>
        {
            aborted.push(current.id);
            grantsAtAbort = JSON.parse(fs.readFileSync(grantFile, 'utf8')).grants;
            releaseSibling?.();
        }
    });
    assert.equal(result.status, 'failure');
    assert.deepEqual(executed, ['a-retained', 'b-running']);
    assert.deepEqual(aborted, ['b-running']);
    assert.deepEqual(settled, ['a-retained', 'b-running']);
    assert.deepEqual(grantsAtAbort, grantsBeforeFailure);
    assert.equal(result.checkpoint.tiers['b-running'].status, 'cancelled');
    assert.equal(result.checkpoint.tiers.next.status, 'blocked');
    assert.deepEqual(JSON.parse(fs.readFileSync(grantFile, 'utf8')).grants, {
        'a-retained': grantsBeforeFailure['a-retained']
    });
    const finalSample = result.checkpoint.resourceUtilization.samples.at(-1);
    assert.equal(finalSample.reservedCpuUnits, grantsBeforeFailure['a-retained'].cpuUnits);
    assert.equal(finalSample.reservedMemoryGiB, grantsBeforeFailure['a-retained'].memoryGiB);
});

test('real scheduler subprocess settlement refusal prevents the next workload from starting', {
    skip: process.platform === 'win32'
}, async (t) =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-real-settlement-refusal');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const completedMarker = path.join(temp, 'completed');
    const forbiddenMarker = path.join(temp, 'must-not-start');
    const command = (marker) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`
    )}`;
    const result = await runDag({
        tiers: [
            tier('retained', { command: command(completedMarker) }),
            tier('next', { command: command(forbiddenMarker), phase: 1 })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'real-settlement-refusal',
        maxParallel: 1,
        collectFailures: true,
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: stableSnapshot,
        afterTierSettled: () =>
        {
            // The subprocess is real; owner refusal is an explicitly injected negative.
            throw new Error('injected independent-owner settlement refusal');
        }
    });
    assert.equal(result.status, 'failure');
    assert.equal(fs.readFileSync(completedMarker, 'utf8'), 'executed');
    assert.equal(fs.existsSync(forbiddenMarker), false);
    assert.equal(result.checkpoint.tiers.next.status, 'blocked');
    assert.deepEqual(result.checkpoint.resourceUtilization.retainedResourceGrants.retained.resourceGrant,
        { cpuUnits: 1, memoryGiB: 0.1 });
});


test('enforced resident scope verifies the real PID incarnation and cgroup before handoff', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const { verifyResidentProcessResourceScope } = await loadScheduler();
    assert.equal(typeof verifyResidentProcessResourceScope, 'function');
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const group = /^0::(\/[^\n]*)$/u.exec(fs.readFileSync('/proc/self/cgroup', 'utf8').trim())?.[1];
    if (!group || group === '/')
    {
        t.skip('a non-root cgroup v2 process path is required');
        return;
    }
    const scopePath = path.join('/sys/fs/cgroup', group);
    const service = { id: 'backend', kind: 'process', identity: { pid: process.pid, startTimeTicks: fields[19] },
        port: 24001, generation: 'self', health: { status: 'ready', checkedAt: new Date().toISOString() },
        observedRssBytes: 4096 };
    const value = createResidentLeaseInventory({
        runId: 'resident-real-scope', namespace: 'component', ownerBundleId: 'runtime-browser',
        resourceGrant: { cpuUnits: 1, memoryGiB: 1 }, services: [service]
    });
    const bind = (pathValue, source = value) => bindResidentLeaseEnforcement(source, {
        mode: 'enforced', processScope: { status: 'enforced', path: pathValue, reservation: source.reservation },
        containers: {}, boundAt: new Date().toISOString()
    });
    const admitted = verifyResidentProcessResourceScope(bind(scopePath), scopePath);
    assert.equal(admitted.status, 'verified');
    assert.deepEqual(admitted.processes, [{ id: 'backend', pid: process.pid, status: 'live', cgroup: group }]);
    const ancestorPath = path.dirname(scopePath);
    if (ancestorPath !== '/sys/fs/cgroup')
    {
        assert.equal(verifyResidentProcessResourceScope(bind(ancestorPath), ancestorPath,
            { serviceControlGroup: group }).status, 'verified');
        assert.throws(() => verifyResidentProcessResourceScope(bind(ancestorPath), ancestorPath,
            { serviceControlGroup: `${group}-other-unit` }), /outside its exact bound service/u);
        assert.throws(() => verifyResidentProcessResourceScope(bind(ancestorPath), ancestorPath,
            { serviceControlGroup: `${group}/nested-unit` }), /outside its exact bound service/u);
        assert.throws(() => verifyResidentProcessResourceScope(bind(ancestorPath), ancestorPath,
            { serviceControlGroup: path.dirname(group) }), /service cgroup differs from its enforced resource ancestor/u);
    }
    assert.throws(() => verifyResidentProcessResourceScope(bind(path.dirname(scopePath)), scopePath),
        /differs from its actual Linux resource ancestor/u);
    assert.throws(() => verifyResidentProcessResourceScope(bind(`${scopePath}-foreign`), `${scopePath}-foreign`),
        /ENOENT|resource ancestor/u);
    const changed = createResidentLeaseInventory({
        runId: 'resident-real-scope', namespace: 'component', ownerBundleId: 'runtime-browser',
        resourceGrant: { cpuUnits: 1, memoryGiB: 1 },
        services: [{ ...service, identity: { ...service.identity, startTimeTicks: (BigInt(fields[19]) + 1n).toString() } }]
    });
    assert.throws(() => verifyResidentProcessResourceScope(bind(scopePath, changed), scopePath),
        /identity changed before cgroup read-back/u);
});
