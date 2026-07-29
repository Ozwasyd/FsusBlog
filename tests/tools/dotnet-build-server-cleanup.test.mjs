import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    dotnetBuildServerInventory,
    managedOrphanDotnetBuildServer,
    prepareBenchmarkMeasurementBuildServers,
    selectOrphanDotnetBuildServers,
    terminateOrphanDotnetBuildServers
} from '../../tools/test-matrix/dotnet-build-server-cleanup.mjs';

const root = '/workspace/FsusBlog';
const currentRunId = 'production-2026-07-12_12-07-56-517-700';
const currentNamespace = `${currentRunId}-fresh-local-production-0`;

function benchmarkCleanupDocument(payload)
{
    return {
        ...payload,
        contentDigest: `sha256:${createHash('sha256')
            .update(JSON.stringify(payload))
            .digest('hex')}`
    };
}

function msbuildRecord(overrides = {})
{
    return {
        pid: 100,
        ppid: 1,
        startTimeTicks: '123456',
        executable: '/usr/lib/dotnet/dotnet',
        cwd: root,
        args: [
            '/usr/lib/dotnet/dotnet',
            '/usr/lib/dotnet/sdk/10.0.108/MSBuild.dll',
            '/noautoresponse',
            '/nologo',
            '/nodemode:1',
            '/nodeReuse:true',
            '/low:false'
        ],
        env: {
            FSUSBLOG_TEST_RUN_ID: currentRunId,
            FSUSBLOG_TEST_NAMESPACE: currentNamespace,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: `${root}/.tmp/build/${currentRunId}`,
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh'
        },
        ...overrides
    };
}

function vbcsRecord(overrides = {})
{
    return msbuildRecord({
        executable: '/usr/lib/dotnet/sdk/10.0.108/Roslyn/bincore/VBCSCompiler',
        cwd: '/usr/lib/dotnet/sdk/10.0.108/Roslyn/bincore',
        args: [
            '/usr/lib/dotnet/sdk/10.0.108/Roslyn/bincore/VBCSCompiler',
            '-pipename:2hxbgLpVrNu40E+8ENeq41ZhsYP_LvIihfOIm1xFoE8'
        ],
        ...overrides
    });
}

test('managed dotnet build-server shape requires run binding, orphan PPID, start identity, and exact command', () =>
{
    assert.equal(managedOrphanDotnetBuildServer(msbuildRecord(), { root }), true);
    assert.equal(managedOrphanDotnetBuildServer(msbuildRecord({ ppid: 42 }), { root }), false);
    assert.equal(managedOrphanDotnetBuildServer(msbuildRecord({ startTimeTicks: '' }), { root }), false);
    assert.equal(managedOrphanDotnetBuildServer(msbuildRecord({ cwd: '/usr/lib/dotnet/sdk/10.0.108' }), { root }), true);
    assert.equal(managedOrphanDotnetBuildServer(msbuildRecord({ env: {} }), { root }), false);
    assert.equal(managedOrphanDotnetBuildServer(msbuildRecord({
        args: [...msbuildRecord().args, '/m']
    }), { root }), false);
    assert.equal(managedOrphanDotnetBuildServer(msbuildRecord({
        args: ['/usr/lib/dotnet/dotnet', '/tmp/MSBuild.dll', '/nodemode:1']
    }), { root }), false);
});

test('managed VBCSCompiler shape is exact and rejects a developer compiler command', () =>
{
    const compiler = vbcsRecord();
    const legacyCompiler = msbuildRecord({
        args: [
            '/usr/lib/dotnet/dotnet',
            'exec',
            '/usr/lib/dotnet/sdk/10.0.108/Roslyn/bincore/VBCSCompiler.dll',
            '-pipename:compiler-server-123'
        ]
    });
    assert.equal(managedOrphanDotnetBuildServer(compiler, { root }), true);
    assert.equal(managedOrphanDotnetBuildServer(legacyCompiler, { root }), true);
    assert.equal(managedOrphanDotnetBuildServer({
        ...compiler,
        args: ['/usr/lib/dotnet/dotnet', 'build', 'src/backend/FsusBlog.Server.csproj']
    }, { root }), false);
    assert.equal(managedOrphanDotnetBuildServer(vbcsRecord({
        cwd: root
    }), { root }), false);
    assert.equal(managedOrphanDotnetBuildServer(vbcsRecord({
        args: [
            '/tmp/sdk/10.0.108/Roslyn/bincore/VBCSCompiler',
            '-pipename:2hxbgLpVrNu40E+8ENeq41ZhsYP_LvIihfOIm1xFoE8'
        ]
    }), { root }), false);
    const fakeBackslashExecutable = '/tmp/fake\\sdk\\10.0.108\\Roslyn\\bincore\\VBCSCompiler';
    assert.equal(managedOrphanDotnetBuildServer(vbcsRecord({
        executable: fakeBackslashExecutable,
        cwd: '/tmp',
        args: [
            fakeBackslashExecutable,
            '-pipename:2hxbgLpVrNu40E+8ENeq41ZhsYP_LvIihfOIm1xFoE8'
        ]
    }), { root }), false);
    assert.equal(managedOrphanDotnetBuildServer(vbcsRecord({
        args: [
            '/usr/lib/dotnet/sdk/10.0.108/Roslyn/bincore/VBCSCompiler',
            '-pipename:unsafe pipe'
        ]
    }), { root }), false);
});

test('selection cleans only the exact current binding', () =>
{
    const staleRunId = 'production-2026-07-12_11-00-00-000-600';
    const stale = msbuildRecord({
        pid: 101,
        env: {
            FSUSBLOG_TEST_RUN_ID: staleRunId,
            FSUSBLOG_TEST_NAMESPACE: `${staleRunId}-fresh-local-production-0`,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: `${root}/.tmp/build/${staleRunId}`,
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh'
        }
    });
    const activeRunId = 'production-2026-07-12_11-30-00-000-650';
    const active = msbuildRecord({
        pid: 102,
        env: {
            FSUSBLOG_TEST_RUN_ID: activeRunId,
            FSUSBLOG_TEST_NAMESPACE: `${activeRunId}-fresh-local-production-0`,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: `${root}/.tmp/build/${activeRunId}`,
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh'
        }
    });
    const manual = msbuildRecord({
        pid: 103,
        env: {
            FSUSBLOG_TEST_RUN_ID: 'developer-build',
            FSUSBLOG_TEST_NAMESPACE: 'developer-build'
        }
    });
    const selected = selectOrphanDotnetBuildServers([
        msbuildRecord(), stale, active, manual, msbuildRecord({ pid: 104, ppid: 900 })
    ], {
        root,
        currentRunId,
        currentNamespace,
        currentStartSource: 'fresh',
        includeCurrentBinding: true,
        runActivity: ({ runId }) => ({ status: runId === activeRunId ? 'active' : 'inactive' })
    });
    assert.deepEqual(selected.map(({ pid }) => pid), [100]);
});

test('selection retains a same-run server whose start source cannot prove this Fresh invocation', () =>
{
    const selected = selectOrphanDotnetBuildServers([
        msbuildRecord({ env: { ...msbuildRecord().env, FSUSBLOG_TEST_EXECUTION_SOURCE: 'resume' } }),
        msbuildRecord({ pid: 101, env: { ...msbuildRecord().env, FSUSBLOG_TEST_EXECUTION_SOURCE: '' } })
    ], {
        root,
        currentRunId,
        currentNamespace,
        currentStartSource: 'fresh',
        includeCurrentBinding: true
    });
    assert.deepEqual(selected, []);
});

test('readiness termination selects an attached exact current server but never a sibling, IDE, external, or unknown server', () =>
{
    const siblingRunId = 'production-2026-07-12_12-07-56-517-701';
    const records = [
        vbcsRecord({ pid: 100, ppid: 900 }),
        msbuildRecord({ pid: 101, ppid: 901, env: {
            FSUSBLOG_TEST_RUN_ID: siblingRunId,
            FSUSBLOG_TEST_NAMESPACE: `${siblingRunId}-fresh-local-production-0`,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: `${root}/.tmp/build/${siblingRunId}`,
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh'
        } }),
        msbuildRecord({ pid: 102, ppid: 902, env: {} }),
        msbuildRecord({ pid: 103, ppid: 903, env: {
            FSUSBLOG_TEST_RUN_ID: currentRunId,
            FSUSBLOG_TEST_NAMESPACE: currentNamespace,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: '/unknown/build-root'
        } })
    ];
    const signals = [];
    const terminated = terminateOrphanDotnetBuildServers(records, {
        root,
        currentRunId,
        currentNamespace,
        currentStartSource: 'fresh',
        includeCurrentBinding: true,
        includeAttachedCurrentBinding: true,
        readProcess: (pid) => records.find((record) => record.pid === pid) ?? null,
        signalProcess: (pid, signal) => signals.push([pid, signal]),
        processExists: () => false,
        terminationGraceMs: 1
    });
    assert.deepEqual(terminated, [100]);
    assert.deepEqual(signals, [[100, 'SIGTERM']]);
});

test('build-root replacement after selection is not signalled', () =>
{
    const selected = msbuildRecord();
    const signals = [];
    const terminated = terminateOrphanDotnetBuildServers([selected], {
        root,
        currentRunId,
        currentNamespace,
        currentStartSource: 'fresh',
        includeCurrentBinding: true,
        readProcess: () => ({
            ...selected,
            env: { ...selected.env, FSUSBLOG_PRODUCTION_BUILD_ROOT: '/replacement/build-root' }
        }),
        signalProcess: (pid, signal) => signals.push([pid, signal]),
        processExists: () => false,
        terminationGraceMs: 1
    });
    assert.deepEqual(terminated, []);
    assert.deepEqual(signals, []);
});

test('inventory proves exact run and build-root ownership without classifying sibling, IDE, or unknown servers as current', () =>
{
    const siblingRunId = 'production-2026-07-12_12-07-56-517-701';
    const unverifiableRunId = 'production-2026-07-12_12-07-56-517-702';
    const inventory = dotnetBuildServerInventory([
        msbuildRecord(),
        msbuildRecord({ pid: 101, env: {
            FSUSBLOG_TEST_RUN_ID: siblingRunId,
            FSUSBLOG_TEST_NAMESPACE: `${siblingRunId}-fresh-local-production-0`,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: `${root}/.tmp/build/${siblingRunId}`,
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh'
        } }),
        msbuildRecord({ pid: 105, env: {
            FSUSBLOG_TEST_RUN_ID: unverifiableRunId,
            FSUSBLOG_TEST_NAMESPACE: `${unverifiableRunId}-fresh-local-production-0`,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: `${root}/.tmp/build/${unverifiableRunId}`,
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh'
        } }),
        msbuildRecord({ pid: 102, env: {
            FSUSBLOG_TEST_RUN_ID: currentRunId,
            FSUSBLOG_TEST_NAMESPACE: currentNamespace,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: '/unverifiable/build-root',
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh'
        } }),
        msbuildRecord({ pid: 103, env: {} }),
        msbuildRecord({ pid: 104, args: ['/usr/lib/dotnet/dotnet', 'build', 'other.csproj'] })
    ], {
        root,
        currentRunId,
        currentNamespace,
        currentStartSource: 'fresh',
        runActivity: ({ runId }) => ({
            status: runId === siblingRunId ? 'active' : runId === unverifiableRunId ? 'unverifiable' : 'inactive'
        })
    });
    assert.equal(inventory.length, 5);
    assert.deepEqual(inventory.map((entry) => entry.startedByCurrentRun), [true, false, false, false, false]);
    assert.deepEqual(inventory.map((entry) => entry.sharedWithOtherRun), [false, true, true, true, true]);
    assert.deepEqual(inventory.map((entry) => entry.ownerState), [
        'current', 'active-other-run', 'owner-unverifiable', 'unknown-current-run', 'external-unknown'
    ]);
    assert.equal(inventory[0].serverKind, 'msbuild-node');
    assert.equal(inventory[0].buildRoot, `${root}/.tmp/build/${currentRunId}`);
    assert.equal(inventory[0].startSource, 'fresh');
    assert.equal(inventory[0].processIdentity.startTimeTicks, '123456');
});

test('benchmark readiness persists exact current-run cleanup inventory before measurement admission', () =>
{
    const temporaryRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fsus-benchmark-cleanup-'));
    const runId = 'production-correctness-2026-07-29_19-20-30-724-1071197';
    const namespace = `${runId}-fresh-production-summary-0`;
    const buildRoot = path.join(temporaryRoot, '.tmp/build', runId);
    const current = vbcsRecord({
        ppid: 1,
        env: {
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_TEST_NAMESPACE: namespace,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: buildRoot,
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh'
        }
    });
    const resumedCurrent = vbcsRecord({
        pid: 102,
        ppid: 1,
        env: {
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_TEST_NAMESPACE: namespace,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: buildRoot,
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'resume'
        }
    });
    const siblingRunId = 'production-correctness-2026-07-29_19-20-30-724-1071198';
    const sibling = msbuildRecord({
        pid: 101,
        cwd: temporaryRoot,
        env: {
            FSUSBLOG_TEST_RUN_ID: siblingRunId,
            FSUSBLOG_TEST_NAMESPACE: `${siblingRunId}-fresh-production-summary-0`,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: path.join(temporaryRoot, '.tmp/build', siblingRunId),
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh'
        }
    });
    const discoveries = [
        [current, resumedCurrent, sibling],
        [resumedCurrent, sibling]
    ];
    const terminationCalls = [];
    try
    {
        const result = prepareBenchmarkMeasurementBuildServers({
            root: temporaryRoot,
            env: {
                FSUSBLOG_TEST_RUN_ID: runId,
                FSUSBLOG_TEST_NAMESPACE: namespace,
                FSUSBLOG_PRODUCTION_BUILD_ROOT: buildRoot,
                FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh'
            },
            discover: () => discoveries.shift() ?? [],
            terminate: (records, options) =>
            {
                terminationCalls.push({ records, options });
                return [current.pid];
            },
            now: () => '2026-07-30T04:00:00.000Z'
        });
        assert.equal(result.status, 'complete');
        assert.equal(result.document.status, 'complete');
        assert.equal(result.document.schema, 'fsusblog.benchmark-build-server-cleanup.v2');
        assert.deepEqual(result.document.binding, { runId, namespace, buildRoot });
        assert.equal(result.document.events.length, 1);
        assert.equal(result.document.events[0].startSource, 'fresh');
        assert.deepEqual(result.document.events[0].selectedCurrentPids, [current.pid]);
        assert.deepEqual(result.document.events[0].terminatedPids, [current.pid]);
        assert.deepEqual(
            result.document.events[0].inventoryBefore.map((entry) => entry.startedByCurrentRun),
            [true, false, false]
        );
        assert.equal(result.document.events[0].inventoryAfter.length, 2);
        assert.equal(result.document.events[0].inventoryAfter[0].startSource, 'resume');
        assert.equal(result.document.events[0].inventoryAfter[0].ownerState, 'unknown-current-run');
        assert.equal(result.document.events[0].inventoryAfter[0].sharedWithOtherRun, true);
        assert.equal(Object.hasOwn(result.document.events[0].inventoryBefore[0], 'record'), false);
        assert.deepEqual(result.document.events[0].inventoryBefore[0].processIdentity, {
            pid: current.pid,
            ppid: current.ppid,
            startTimeTicks: current.startTimeTicks,
            executable: current.executable,
            cwd: current.cwd,
            args: current.args
        });
        assert.equal(terminationCalls.length, 1);
        assert.equal(terminationCalls[0].options.includeCurrentBinding, true);
        assert.equal(terminationCalls[0].options.includeAttachedCurrentBinding, true);
        assert.equal(terminationCalls[0].options.currentRunId, runId);
        assert.equal(terminationCalls[0].options.currentNamespace, namespace);
        assert.equal(terminationCalls[0].options.currentStartSource, 'fresh');
        assert.deepEqual(
            terminationCalls[0].records.map((record) => record.pid),
            [current.pid, resumedCurrent.pid, sibling.pid]
        );
        assert.equal(
            result.receiptFile,
            path.join(
                temporaryRoot,
                '.tmp/run-once',
                namespace,
                'backend-benchmark-release-build.cleanup.json'
            )
        );
        assert.deepEqual(JSON.parse(fs.readFileSync(result.receiptFile, 'utf8')), result.document);
        assert.doesNotMatch(fs.readFileSync(result.receiptFile, 'utf8'), /lyuaoss@gmail/u);

        const firstEvent = structuredClone(result.document.events[0]);
        const resumeDiscoveries = [[current, resumedCurrent], [current]];
        const resumeEnv = {
            ...current.env,
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'resume'
        };
        const next = prepareBenchmarkMeasurementBuildServers({
            root: temporaryRoot,
            env: resumeEnv,
            discover: () => resumeDiscoveries.shift() ?? [],
            terminate: (records, options) =>
            {
                terminationCalls.push({ records, options });
                return [resumedCurrent.pid];
            },
            now: () => '2026-07-30T04:01:00.000Z'
        });
        assert.equal(next.document.events.length, 2);
        assert.deepEqual(next.document.binding, result.document.binding);
        assert.deepEqual(next.document.events[0], firstEvent);
        assert.equal(next.document.events[1].sequence, 2);
        assert.equal(next.document.events[1].startSource, 'resume');
        assert.deepEqual(next.document.events[1].selectedCurrentPids, [resumedCurrent.pid]);
        assert.deepEqual(next.document.events[1].terminatedPids, [resumedCurrent.pid]);
        assert.deepEqual(
            next.document.events[1].inventoryBefore.map((entry) => entry.startedByCurrentRun),
            [false, true]
        );
        assert.equal(next.document.events[1].inventoryAfter[0].startSource, 'fresh');
        assert.equal(next.document.events[1].inventoryAfter[0].startedByCurrentRun, false);
        assert.equal(terminationCalls.length, 2);
        assert.equal(terminationCalls[1].options.currentStartSource, 'resume');
        assert.deepEqual(
            terminationCalls[1].records.map((record) => record.pid),
            [current.pid, resumedCurrent.pid]
        );
        assert.notEqual(next.document.contentDigest, result.document.contentDigest);

        const firstTwoEvents = structuredClone(next.document.events);
        const final = prepareBenchmarkMeasurementBuildServers({
            root: temporaryRoot,
            env: resumeEnv,
            discover: () => [],
            terminate: () => [],
            now: () => '2026-07-30T04:02:00.000Z'
        });
        assert.equal(final.document.events.length, 3);
        assert.deepEqual(final.document.events.slice(0, 2), firstTwoEvents);
        assert.equal(final.document.events[2].sequence, 3);
        assert.equal(final.document.events[2].startSource, 'resume');
        assert.notEqual(final.document.contentDigest, next.document.contentDigest);

        const { contentDigest: _contentDigest, ...validPayload } = final.document;
        const assertRejectedBeforeInventory = (document, label = '') =>
        {
            let inventoryCalls = 0;
            fs.writeFileSync(result.receiptFile, `${JSON.stringify(document)}\n`);
            assert.throws(() => prepareBenchmarkMeasurementBuildServers({
                root: temporaryRoot,
                env: resumeEnv,
                discover: () =>
                {
                    inventoryCalls += 1;
                    throw new Error('inventory must not run after receipt integrity failure');
                },
                terminate: () => []
            }), /receipt integrity validation failed/u, label);
            assert.equal(inventoryCalls, 0, label);
        };

        const oldBindingShape = structuredClone(validPayload);
        oldBindingShape.binding.startSource = 'fresh';
        assertRejectedBeforeInventory(benchmarkCleanupDocument(oldBindingShape));

        const oldSchema = structuredClone(validPayload);
        oldSchema.schema = 'fsusblog.benchmark-build-server-cleanup.v1';
        assertRejectedBeforeInventory(benchmarkCleanupDocument(oldSchema));

        const tamperedBinding = structuredClone(validPayload);
        tamperedBinding.binding.runId = `${runId}-tampered`;
        assertRejectedBeforeInventory(benchmarkCleanupDocument(tamperedBinding));

        assertRejectedBeforeInventory({
            ...final.document,
            contentDigest: `sha256:${'0'.repeat(64)}`
        });

        const tamperedEventSource = structuredClone(validPayload);
        tamperedEventSource.events[0].startSource = 'retry';
        assertRejectedBeforeInventory(benchmarkCleanupDocument(tamperedEventSource));

        const tamperedSequence = structuredClone(validPayload);
        tamperedSequence.events[1].sequence = 3;
        assertRejectedBeforeInventory(benchmarkCleanupDocument(tamperedSequence));

        const semanticMutants = [
            ['document status differs from last event', (payload) =>
            {
                payload.status = 'failed';
            }],
            ['complete event has failures', (payload) =>
            {
                payload.events[0].failures = ['tampered'];
            }],
            ['failed event has no failures', (payload) =>
            {
                payload.events[0].status = 'failed';
            }],
            ['selected PID is zero', (payload) =>
            {
                payload.events[0].selectedCurrentPids = [0];
            }],
            ['terminated PID is negative', (payload) =>
            {
                payload.events[0].terminatedPids = [-1];
            }],
            ['selected PIDs are duplicated', (payload) =>
            {
                payload.events[0].selectedCurrentPids = [current.pid, current.pid];
            }],
            ['terminated PID is not selected', (payload) =>
            {
                payload.events[0].terminatedPids = [999];
            }],
            ['inventory PIDs are duplicated', (payload) =>
            {
                payload.events[0].inventoryBefore.push(
                    structuredClone(payload.events[0].inventoryBefore[0])
                );
                payload.events[0].selectedCurrentPids.push(current.pid);
            }],
            ['inventory contains null', (payload) =>
            {
                payload.events[0].inventoryBefore = [null];
            }],
            ['inventory contains an empty object', (payload) =>
            {
                payload.events[0].inventoryBefore = [{}];
            }],
            ['inventory PID is zero', (payload) =>
            {
                payload.events[0].inventoryBefore[0].processIdentity.pid = 0;
                payload.events[0].selectedCurrentPids = [0];
                payload.events[0].terminatedPids = [0];
            }],
            ['current inventory source drifts', (payload) =>
            {
                payload.events[0].inventoryBefore[0].startSource = 'resume';
            }],
            ['current inventory stable binding drifts', (payload) =>
            {
                payload.events[0].inventoryBefore[0].runId = `${runId}-tampered`;
            }],
            ['exact current binding is disguised as noncurrent', (payload) =>
            {
                const item = payload.events[0].inventoryBefore[0];
                item.startedByCurrentRun = false;
                item.ownerState = 'unknown-current-run';
                item.sharedWithOtherRun = true;
                payload.events[0].selectedCurrentPids = [];
                payload.events[0].terminatedPids = [];
            }],
            ['noncurrent inventory claims current owner state', (payload) =>
            {
                payload.events[0].inventoryBefore[1].ownerState = 'current';
            }],
            ['noncurrent inventory is not marked shared', (payload) =>
            {
                payload.events[0].inventoryBefore[1].sharedWithOtherRun = false;
            }]
        ];
        for (const [label, mutate] of semanticMutants)
        {
            const mutant = structuredClone(validPayload);
            mutate(mutant);
            assertRejectedBeforeInventory(benchmarkCleanupDocument(mutant), label);
        }
    }
    finally
    {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('benchmark readiness fails closed and records a current-run server left after cleanup', () =>
{
    const temporaryRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fsus-benchmark-blocked-'));
    const runId = 'production-correctness-2026-07-29_19-20-30-724-1071197';
    const namespace = `${runId}-fresh-production-summary-0`;
    const buildRoot = path.join(temporaryRoot, '.tmp/build', runId);
    const current = vbcsRecord({
        ppid: 900,
        env: {
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_TEST_NAMESPACE: namespace,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: buildRoot,
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh'
        }
    });
    const receiptFile = path.join(
        temporaryRoot,
        '.tmp/run-once',
        namespace,
        'backend-benchmark-release-build.cleanup.json'
    );
    try
    {
        assert.throws(() => prepareBenchmarkMeasurementBuildServers({
            root: temporaryRoot,
            env: current.env,
            discover: () => [current],
            terminate: () => [],
            now: () => '2026-07-30T04:00:00.000Z'
        }), /current-run build servers remain after cleanup/u);
        const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        assert.equal(receipt.status, 'failed');
        assert.equal(receipt.events[0].status, 'failed');
        assert.deepEqual(receipt.events[0].selectedCurrentPids, [current.pid]);
        assert.deepEqual(receipt.events[0].terminatedPids, []);
        assert.match(receipt.events[0].failures[0], /current-run build servers remain/u);
    }
    finally
    {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('benchmark ensure settles and receipts build servers after either build readiness path', () =>
{
    const source = fs.readFileSync('tools/test/ensure-benchmark-release-build.sh', 'utf8');
    const localVerification = source.indexOf('verify-benchmark-build-ready.mjs');
    const runOnceBuild = source.indexOf('"$NODE_BIN" "$ROOT_DIR/tools/test/run-once.mjs" run');
    const localCleanup = source.indexOf('PrepareBenchmarkMeasurement', localVerification);
    const finalCleanup = source.lastIndexOf('PrepareBenchmarkMeasurement');
    assert.ok(localVerification >= 0);
    assert.ok(runOnceBuild >= 0);
    assert.ok(localCleanup > localVerification);
    assert.ok(finalCleanup > runOnceBuild);
    assert.match(source, /run-with-dotnet-release-build-lock\.sh" \\\n\s*"\$NODE_BIN" "\$ROOT_DIR\/tools\/test-matrix\/dotnet-build-server-cleanup\.mjs"/u);
    assert.doesNotMatch(source, /dotnet\s+build-server\s+shutdown/u);
});

test('termination revalidates PID start time, PPID, cwd, args, run id, and namespace before signaling', () =>
{
    const source = fs.readFileSync('tools/test-matrix/dotnet-build-server-cleanup.mjs', 'utf8');
    for (const contract of [
        'observed.ppid === expected.ppid',
        'observed.startTimeTicks === expected.startTimeTicks',
        'observed.executable === expected.executable',
        'observed.cwd === expected.cwd',
        "observed.args.join('\\0') === expected.args.join('\\0')",
        'observed.env.FSUSBLOG_TEST_RUN_ID === expected.env.FSUSBLOG_TEST_RUN_ID',
        'observed.env.FSUSBLOG_TEST_NAMESPACE === expected.env.FSUSBLOG_TEST_NAMESPACE',
        'observed.env.FSUSBLOG_PRODUCTION_BUILD_ROOT === expected.env.FSUSBLOG_PRODUCTION_BUILD_ROOT',
        'observed.env.FSUSBLOG_TEST_EXECUTION_SOURCE === expected.env.FSUSBLOG_TEST_EXECUTION_SOURCE'
    ])
    {
        assert.ok(source.includes(contract), `missing identity revalidation: ${contract}`);
    }
});
