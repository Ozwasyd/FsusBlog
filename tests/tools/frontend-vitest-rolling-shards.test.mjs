import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    canonicalCoverageHitMap,
    canonicalVitestId,
    collectTransformDelta,
    createImmutableTransformBase,
    createTransformDeltaForHost,
    isFrontendCoverageOwnedFile,
    mergeCoordinatorReports,
    mergeIsolatedTransformCaches,
    planRollingVitestPartitions,
    readLiveVitestGrant,
    resolveRollingVitestTopology,
    runRollingVitestCoordinator,
    validateExactVitestExecution,
    validateZeroHitCoverageUniverse,
    verifyImmutableTransformBase
} from '../../tools/test/run-frontend-vitest-rolling-shards.mjs';

test('coverage equivalence clamps runtime counts while retaining instrumentation identity', () =>
{
    const entry = {
        path: '/repo/source.ts',
        statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
        fnMap: {},
        branchMap: { 0: { type: 'if', locations: [{ start: { line: 1, column: 0 }, end: { line: 1, column: 1 } }] } },
        s: { 0: 2 },
        f: {},
        b: { 0: [5, 0] }
    };
    const first = canonicalCoverageHitMap({ '/repo/source.ts': entry });
    const second = canonicalCoverageHitMap({ '/repo/source.ts': {
        ...entry,
        s: { 0: 200 },
        b: { 0: [1, 0] }
    } });
    assert.deepEqual(first, second);
    assert.deepEqual(first['/repo/source.ts'].s, { 0: 1 });
    assert.deepEqual(first['/repo/source.ts'].b, { 0: [1, 0] });
    const changedInstrumentation = structuredClone(second);
    changedInstrumentation['/repo/source.ts'].statementMap[0].end.column = 2;
    assert.notDeepEqual(first, changedInstrumentation);
});

function catalog(count = 12, identityDigest = 'catalog-a')
{
    return {
        schema: 'fsusblog.frontend-vitest-catalog.v1',
        identityDigest,
        files: Array.from({ length: count }, (_, index) => ({
            file: `/repo/tests/frontend/unit/file-${String(index).padStart(2, '0')}.test.ts`,
            projectName: 'unit',
            tests: [`suite ${index} > first`, `suite ${index} > second`]
        }))
    };
}

function partitions(count)
{
    return Array.from({ length: count }, (_, index) => ({
        id: `partition-${index + 1}`,
        files: [{ file: `/repo/file-${index}.test.ts`, tests: [`test ${index}`] }],
        identityDigest: `identity-${index}`,
        coverageUniverseOwner: false
    }));
}

test('authoritative catalog exact-once validates files and test IDs, not only pass status', () =>
{
    const input = catalog(1);
    const file = input.files[0].file;
    const report = {
        testResults: [{
            name: file,
            assertionResults: [
                { ancestorTitles: ['suite 0'], title: 'first', status: 'passed' },
                { fullName: 'suite 0 second', status: 'passed' }
            ]
        }]
    };
    assert.deepEqual(validateExactVitestExecution(input, [report]), {
        catalogFileCount: 1,
        catalogTestIdCount: 2,
        executedFileCount: 1,
        executedTestIdCount: 2,
        exactOnce: true
    });
    assert.match(canonicalVitestId(file, 'suite 0 > first'), /#suite 0 first$/u);
    assert.throws(() => validateExactVitestExecution(input, [report, report]), /duplicateFiles=1[\s\S]*duplicateTests=2/u);
    assert.throws(() => validateExactVitestExecution(input, [{ testResults: [] }]), /missingFiles=1[\s\S]*missingTests=2/u);
    const incomplete = structuredClone(report);
    incomplete.testResults[0].assertionResults.pop();
    assert.throws(() => validateExactVitestExecution(input, [incomplete]), /missingTests=1/u);
});

test('4/8/16/32 CPU models derive legal decoupled host, worker and partition topology', () =>
{
    for (const cpu of [4, 8, 16, 32])
    {
        const topology = resolveRollingVitestTopology({ machineCpu: cpu, machineMemoryGiB: cpu * 1.5, fileCount: 100 });
        assert.ok(topology.hostLimit >= 1);
        assert.ok(topology.preferredWorkersPerHost >= 1);
        assert.ok(topology.hostLimit < cpu, `default topology must not create one full host per CPU at ${cpu} CPUs`);
        assert.ok(topology.partitionCount > topology.hostLimit);
        assert.ok(topology.partitionCount < 100, 'default topology must not create one process per file');
        assert.ok(topology.baseMemoryGiB + topology.memoryPerWorkerGiB <= topology.machineMemoryGiB);
    }
});

test('immutable LPT partitions are deterministic, balanced and bound to catalog identity', () =>
{
    const topology = resolveRollingVitestTopology({ machineCpu: 8, machineMemoryGiB: 12, fileCount: 24 });
    const first = planRollingVitestPartitions(catalog(24, 'catalog-a'), topology);
    const second = planRollingVitestPartitions(catalog(24, 'catalog-a'), topology);
    assert.deepEqual(first, second);
    assert.deepEqual(first, planRollingVitestPartitions(catalog(24, 'catalog-a'), topology, {
        timingHistory: { '/repo/file-0.test.ts': [999999] }
    }));
    assert.equal(new Set(first.flatMap((partition) => partition.files.map((entry) => entry.file))).size, 24);
    assert.equal(first.flatMap((partition) => partition.files).length, 24);
    assert.equal(first.filter((partition) => partition.coverageUniverseOwner).length, 0);
    const changed = planRollingVitestPartitions(catalog(24, 'catalog-b'), topology);
    assert.notEqual(first[0].identityDigest, changed[0].identityDigest);
});

test('a measured dynamic-import timeout uses an isolated one-worker host without changing IDs', () =>
{
    const input = catalog(6);
    input.files[2].hostMaxWorkers = 1;
    const planned = planRollingVitestPartitions(input, { partitionCount: 3 });
    const isolated = planned.find((partition) => partition.hostMaxWorkers === 1);
    assert.deepEqual(isolated.files.map((entry) => entry.file), [input.files[2].file]);
    assert.equal(isolated.exclusiveHost, true);
    assert.equal(planned.flatMap((partition) => partition.files).length, input.files.length);
    assert.equal(new Set(planned.flatMap((partition) => partition.files.map((entry) => entry.file))).size, input.files.length);
});

test('an import-sensitive partition owns an exclusive one-worker admission window', async () =>
{
    const launches = [];
    let activeHosts = 0;
    const partitions = [
        { id: 'isolated', files: [], hostMaxWorkers: 1, exclusiveHost: true },
        { id: 'ordinary', files: [], hostMaxWorkers: null, exclusiveHost: false }
    ];
    await runRollingVitestCoordinator({
        partitions,
        topology: { hostLimit: 2, preferredWorkersPerHost: 2, baseMemoryGiB: 0.25, memoryPerWorkerGiB: 0.25 },
        readGrant: async () => ({ cpuUnits: 4, memoryGiB: 4 }),
        pollIntervalMs: 1,
        launchHost: async ({ partition, workers }) =>
        {
            activeHosts += 1;
            launches.push({ id: partition.id, workers, activeAtLaunch: activeHosts });
            await new Promise((resolve) => setTimeout(resolve, 5));
            activeHosts -= 1;
            return { status: 'success', code: 0 };
        }
    });
    assert.deepEqual(launches.map(({ id, workers }) => ({ id, workers })), [
        { id: 'isolated', workers: 1 },
        { id: 'ordinary', workers: 2 }
    ]);
    assert.deepEqual(launches.map((entry) => entry.activeAtLaunch), [1, 1]);
});

test('live grant 1 to 2 to 4 admits additional hosts without duplicate partitions', async () =>
{
    const launches = [];
    const threeHostsAdmitted = Promise.withResolvers();
    let grantReadCount = 0;
    const topology = {
        machineCpu: 4,
        preferredWorkersPerHost: 2,
        hostLimit: 3,
        baseMemoryGiB: 0.25,
        memoryPerWorkerGiB: 0.125
    };
    const result = await runRollingVitestCoordinator({
        partitions: partitions(7),
        topology,
        pollIntervalMs: 1,
        readGrant: () =>
        {
            const cpuUnits = [1, 2, 4][Math.min(grantReadCount, 2)];
            grantReadCount += 1;
            return { cpuUnits, memoryGiB: 4, source: 'test' };
        },
        launchHost: async (entry) =>
        {
            launches.push({ partitionId: entry.partition.id, workers: entry.workers });
            if (launches.length === 3)
            {
                threeHostsAdmitted.resolve();
            }
            await threeHostsAdmitted.promise;
            return { code: 0, status: 'success' };
        }
    });
    assert.deepEqual(result.grantHistory.map((entry) => entry.cpuUnits), [1, 2, 4]);
    assert.equal(result.initialHostCount, 1);
    assert.equal(result.peakHostCount, 3);
    assert.ok(launches.some((entry) => entry.workers === 2));
    assert.equal(new Set(launches.map((entry) => entry.partitionId)).size, 7);
});

test('grant contraction never kills active hosts and blocks new claims until usage fits', async () =>
{
    const startedAt = Date.now();
    const launches = [];
    const result = await runRollingVitestCoordinator({
        partitions: partitions(5),
        topology: {
            machineCpu: 4,
            preferredWorkersPerHost: 2,
            hostLimit: 2,
            baseMemoryGiB: 0.25,
            memoryPerWorkerGiB: 0.125
        },
        pollIntervalMs: 2,
        readGrant: () => ({ cpuUnits: Date.now() - startedAt < 10 ? 4 : 1, memoryGiB: 4, source: 'test' }),
        launchHost: async (entry) =>
        {
            const ordinal = launches.length;
            launches.push({ id: entry.partition.id, atMs: Date.now() - startedAt, workers: entry.workers });
            await new Promise((resolve) => setTimeout(resolve, ordinal === 0 ? 30 : 55));
            return { code: 0, status: 'success' };
        }
    });
    assert.equal(result.results.length, 5);
    assert.ok(launches[2].atMs >= 45, `new host started while contraction was overcommitted at ${launches[2].atMs}ms`);
    assert.equal(launches[2].workers, 1);
});

test('one host failure does not prevent independent partitions from being collected', async () =>
{
    const result = await runRollingVitestCoordinator({
        partitions: partitions(4),
        topology: {
            machineCpu: 4,
            preferredWorkersPerHost: 2,
            hostLimit: 2,
            baseMemoryGiB: 0.25,
            memoryPerWorkerGiB: 0.125
        },
        readGrant: () => ({ cpuUnits: 4, memoryGiB: 4 }),
        launchHost: async ({ partition }) => ({
            code: partition.id === 'partition-1' ? 7 : 0,
            status: partition.id === 'partition-1' ? 'failure' : 'success'
        })
    });
    assert.equal(result.results.length, 4);
    assert.equal(result.results.filter((entry) => entry.status === 'failure').length, 1);
    assert.equal(new Set(result.results.map((entry) => entry.partitionId)).size, 4);
});

test('cancellation stops coordinator admission while the runner owns process-group termination', async () =>
{
    const controller = new AbortController();
    const cancellationSignals = [];
    const settleHosts = [];
    let settledHostCount = 0;
    const execution = runRollingVitestCoordinator({
        partitions: partitions(3),
        topology: {
            machineCpu: 2,
            preferredWorkersPerHost: 1,
            hostLimit: 2,
            baseMemoryGiB: 0.25,
            memoryPerWorkerGiB: 0.125
        },
        pollIntervalMs: 2,
        readGrant: () => ({ cpuUnits: 2, memoryGiB: 2 }),
        launchHost: () => new Promise((resolve) =>
        {
            settleHosts.push(resolve);
        }).finally(() =>
        {
            settledHostCount += 1;
        }),
        signal: controller.signal,
        cancelActive: (signal) =>
        {
            cancellationSignals.push(signal);
            for (const settleHost of settleHosts)
            {
                settleHost({ code: 143, signal });
            }
        }
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(execution, /cancelled/u);
    assert.deepEqual(cancellationSignals, ['SIGTERM']);
    assert.equal(settledHostCount, 2);
});

test('deadline escalates to SIGKILL and drains an unresponsive active host before rejecting', async () =>
{
    const cancellationSignals = [];
    let settleHost;
    let settledHostCount = 0;
    await assert.rejects(runRollingVitestCoordinator({
        partitions: partitions(1),
        topology: {
            machineCpu: 1,
            preferredWorkersPerHost: 1,
            hostLimit: 1,
            baseMemoryGiB: 0.25,
            memoryPerWorkerGiB: 0.125
        },
        pollIntervalMs: 2,
        deadlineAtMs: Date.now() + 10,
        cancellationGraceMs: 5,
        readGrant: () => ({ cpuUnits: 1, memoryGiB: 1 }),
        launchHost: () => new Promise((resolve) =>
        {
            settleHost = resolve;
        }).finally(() =>
        {
            settledHostCount += 1;
        }),
        cancelActive: (signal) =>
        {
            cancellationSignals.push(signal);
            if (signal === 'SIGKILL')
            {
                settleHost?.({ code: 137, signal });
            }
        }
    }), /exceeded its step deadline/u);
    assert.deepEqual(cancellationSignals, ['SIGTERM', 'SIGKILL']);
    assert.equal(settledHostCount, 1);
});

test('live grant is atomic, run-bound and fails closed on stale identity', () =>
{
    const env = {
        FSUSBLOG_TEST_RUN_ID: 'run-a',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/grant.json',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'vitest'
    };
    const document = {
        schema: 'fsusblog.test-matrix.resource-grants.v1',
        runId: 'run-a',
        resourceBudget: { cpuUnits: 4, memoryGiB: 4 },
        grants: { vitest: { cpuUnits: 3, memoryGiB: 2.5 } }
    };
    assert.deepEqual(readLiveVitestGrant(env, () => JSON.stringify(document)), {
        cpuUnits: 3, memoryGiB: 2.5, source: 'scheduler-resource-grants'
    });
    assert.throws(() => readLiveVitestGrant(env, () => JSON.stringify({ ...document, runId: 'stale' })), /runId mismatch/u);
    for (const resourceBudget of [undefined, { cpuUnits: 2, memoryGiB: 4 }, { cpuUnits: 4, memoryGiB: 2 }, { cpuUnits: 3.5, memoryGiB: 4 }])
    {
        assert.throws(() => readLiveVitestGrant(env, () => JSON.stringify({ ...document, resourceBudget })), /parent resource budget/u);
    }
    assert.throws(() => readLiveVitestGrant({ FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/grant.json' }), /both grant file and tier id/u);
});

test('immutable transform base exposes symlink views and merges only host delta entries', () =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-host-delta-'));
    const basePath = path.join(temporary, 'base');
    fs.mkdirSync(path.join(basePath, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(basePath, 'seed'), 'seed');
    fs.writeFileSync(path.join(basePath, 'nested', 'shared'), 'shared');
    const base = createImmutableTransformBase(basePath);
    const host = createTransformDeltaForHost({ runRoot: temporary }, 'host-01', base);
    assert.equal(host.cloneMode, 'symlink-immutable-base');
    assert.equal(fs.lstatSync(path.join(host.hostCachePath, 'seed')).isSymbolicLink(), true);
    fs.writeFileSync(path.join(host.hostCachePath, 'new-entry'), 'new');
    host.recordedPaths.add('new-entry');
    const delta = collectTransformDelta(base, host);
    assert.deepEqual({ cloneMode: delta.cloneMode, baseBytes: delta.baseBytes, deltaBytes: delta.deltaBytes,
        deltaFiles: delta.deltaFiles, viewTraversalCount: delta.viewTraversalCount,
        mergeTraversalCount: delta.mergeTraversalCount }, {
        cloneMode: 'symlink-immutable-base', baseBytes: 10, deltaBytes: 3, deltaFiles: 1,
        viewTraversalCount: 1, mergeTraversalCount: 1
    });
    assert.deepEqual(mergeIsolatedTransformCaches(basePath, [delta.deltaEntries]), {
        hostCacheCount: 1, addedFiles: 1, identicalFiles: 0, metadataVariants: 0, mergeTraversalCount: 1
    });
    fs.writeFileSync(path.join(basePath, 'seed'), 'polluted');
    assert.throws(() => verifyImmutableTransformBase(base), /immutable Vitest transform base was polluted/u);
    fs.rmSync(temporary, { recursive: true, force: true });
});

test('missing base links and links outside the immutable base fail closed', () =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-host-pollution-'));
    const basePath = path.join(temporary, 'base');
    fs.mkdirSync(basePath, { recursive: true });
    fs.writeFileSync(path.join(basePath, 'seed'), 'seed');
    const base = createImmutableTransformBase(basePath);
    const missing = createTransformDeltaForHost({ runRoot: temporary }, 'missing', base);
    fs.unlinkSync(path.join(missing.hostCachePath, 'seed'));
    missing.recordedPaths.add('seed');
    assert.throws(() => collectTransformDelta(base, missing), /base view is incomplete/u);
    const polluted = createTransformDeltaForHost({ runRoot: temporary }, 'polluted', base);
    fs.unlinkSync(path.join(polluted.hostCachePath, 'seed'));
    fs.symlinkSync('/tmp/not-the-base', path.join(polluted.hostCachePath, 'seed'));
    polluted.recordedPaths.add('seed');
    assert.throws(() => collectTransformDelta(base, polluted), /polluted base link/u);
    fs.rmSync(temporary, { recursive: true, force: true });
});

test('host-private transform deltas merge deterministically and reject conflicting entries', () =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-host-cache-'));
    const base = path.join(temporary, 'base');
    const first = path.join(temporary, 'first');
    const second = path.join(temporary, 'second');
    for (const directory of [base, first, second])
    {
        fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(base, 'seed'), 'seed');
    fs.writeFileSync(path.join(first, 'seed'), 'seed');
    fs.writeFileSync(path.join(first, 'one'), 'one');
    fs.writeFileSync(path.join(second, 'one'), 'one');
    fs.writeFileSync(path.join(second, 'two'), 'two');
    assert.deepEqual(mergeIsolatedTransformCaches(base, [second, first]), {
        hostCacheCount: 2, addedFiles: 2, identicalFiles: 2, metadataVariants: 0, mergeTraversalCount: 4
    });
    fs.writeFileSync(path.join(second, 'seed'), 'corrupt');
    assert.throws(() => mergeIsolatedTransformCaches(base, [second]), /transform cache executable conflict: seed/u);
    fs.writeFileSync(path.join(base, 'variant'), 'code\n//# vitestCache=short');
    fs.writeFileSync(path.join(first, 'variant'), 'code\n//# vitestCache=longer-metadata');
    assert.deepEqual(mergeIsolatedTransformCaches(base, [first]), {
        hostCacheCount: 1, addedFiles: 0, identicalFiles: 2, metadataVariants: 1, mergeTraversalCount: 3
    });
    assert.match(fs.readFileSync(path.join(base, 'variant'), 'utf8'), /longer-metadata/u);
    fs.rmSync(temporary, { recursive: true, force: true });
});

test('zero-hit coverage universe and coordinator-native JSON/JUnit merge fail closed', () =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-report-merge-'));
    const universe = path.join(temporary, 'universe.json');
    fs.writeFileSync(universe, JSON.stringify({ '/repo/source.ts': { s: { 0: 0 }, f: { 0: 0 }, b: { 0: [0, 0] } } }));
    assert.equal(validateZeroHitCoverageUniverse(universe).zeroHit, true);
    fs.writeFileSync(universe, JSON.stringify({ '/repo/source.ts': { s: { 0: 1 }, f: { 0: 0 }, b: { 0: [0, 0] } } }));
    assert.throws(() => validateZeroHitCoverageUniverse(universe), /contains execution hits/u);
    const jsonFile = path.join(temporary, 'merged.json');
    const junitFile = path.join(temporary, 'merged.xml');
    const junitInputs = [0, 1].map((index) =>
    {
        const file = path.join(temporary, `${index}.xml`);
        fs.writeFileSync(file, `<?xml version="1.0"?><testsuites><testsuite name="suite-${index}" tests="1"></testsuite></testsuites>`);
        return file;
    });
    const reports = [0, 1].map((index) => ({ numTotalTestSuites: 1, numPassedTestSuites: 1,
        numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 1, numPassedTests: 1,
        numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, startTime: 100 + index,
        success: true, snapshot: {}, testResults: [{ name: `/repo/file-${index}.test.ts`, assertionResults: [] }] }));
    assert.deepEqual(mergeCoordinatorReports(reports, junitInputs, { jsonFile, junitFile }), {
        jsonReportCount: 2, junitReportCount: 2, testResultCount: 2, processStartupCount: 0
    });
    assert.equal(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).numTotalTests, 2);
    assert.match(fs.readFileSync(junitFile, 'utf8'), /suite-0[\s\S]*suite-1/u);
    assert.throws(() => mergeCoordinatorReports(reports, junitInputs.slice(1), { jsonFile, junitFile }), /matching non-empty/u);
    fs.rmSync(temporary, { recursive: true, force: true });
});

test('coverage ownership includes Blog frontend sources but excludes local FsusUI aliases', () =>
{
    const repositoryRoot = '/workspace/FsusBlog';
    const frontendDirectory = `${repositoryRoot}/src/frontend`;
    const options = { repositoryRoot, frontendDirectory };
    assert.equal(isFrontendCoverageOwnedFile(`${frontendDirectory}/src/router/index.ts`, options), true);
    assert.equal(isFrontendCoverageOwnedFile(`${repositoryRoot}/tests/frontend/support/playwright/testSession.ts`, options), true);
    assert.equal(isFrontendCoverageOwnedFile(`${repositoryRoot}/tests/frontend/unit/example.test.ts`, options), false);
    assert.equal(isFrontendCoverageOwnedFile('/workspace/FsusUI/vue/packages/motion/src/runtime.ts', options), false);
});

test('runner uses one authoritative catalog, local Vitest entry, independent universe and delta-only merge', () =>
{
    const source = fs.readFileSync('tools/test/run-frontend-vitest-rolling-shards.mjs', 'utf8');
    const config = fs.readFileSync('src/frontend/vitest.production.config.ts', 'utf8');
    const privacyProjection = fs.readFileSync('tools/test/lanes/project-privacy-zk-production.mjs', 'utf8');
    assert.equal((source.match(/'list', '--config'/gu) ?? []).length, 1);
    assert.doesNotMatch(source, /spawn\('npx'|--mergeReports=/u);
    assert.match(source, /runRollingVitestCoordinator[\s\S]*?readLiveVitestGrant/u);
    assert.match(source, /hostId.*partition\.id[\s\S]*?outputFile\.json[\s\S]*?outputFile\.junit[\s\S]*?outputFile\.blob/u);
    assert.match(source, /vitestEntry[\s\S]*?spawn\(process\.execPath/u);
    assert.match(source, /buildZeroHitCoverageUniverse[\s\S]*?--coverage\.all=true/u);
    assert.match(source, /createTransformDeltaForHost[\s\S]*?symlink-immutable-base/u);
    assert.match(source, /mergeIsolatedTransformCaches[\s\S]*?transform cache executable conflict/u);
    assert.match(source, /validateExactVitestExecution\(catalog, reports\)/u);
    assert.match(source, /mergeCoordinatorReports/u);
    assert.match(source, /isFrontendCoverageOwnedFile[\s\S]*?excludedExternalFileCount/u);
    assert.match(source, /terminateAllChildren\('SIGTERM'\)[\s\S]*?terminateAllChildren\('SIGKILL'\)/u);
    assert.match(source, /catalogIdentityDigest[\s\S]*?grantHistory[\s\S]*?hostStartupMs[\s\S]*?transformCache/u);
    assert.match(source, /processEvidence[\s\S]*?cacheEvidence[\s\S]*?criticalPathTailMs/u);
    assert.match(config, /FSUSBLOG_VITEST_ROLLING_HOST === '1'/u);
    assert.match(config, /FSUSBLOG_VITEST_COVERAGE_UNIVERSE_OWNER === '1'/u);
    assert.match(privacyProjection, /fsusblog\.frontend-vitest-rolling\.v2/u);
});
