import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    buildSettledPhaseJoinEvidence,
    executeWeightedStepDag,
    performanceSteps,
    resolveBundleRuntimeCapacity,
    resolveBundleSteps,
    resolveConcurrentStepCapacities,
    resolveMachineExecutionTimeoutMs,
    resolveStepRuntimeCapacity,
    runtimeSteps
} from '../../tools/test/bundles/bundle-steps.mjs';
import { parseRuntimeEnvironment } from '../../tools/test/bundles/runtime-environment.mjs';
import { resolveWorkerTestSession } from '../frontend/support/test-session.mjs';

const byId = (steps) => new Map(steps.map((step) => [step.id, step]));

const runtimeEnvironmentFixture = (overrides = {}) => ({
    FSUSBLOG_TEST_NAMESPACE: 'runtime-focused-1',
    FSUSBLOG_DEBUG_BACKEND_PORT: '24501',
    FSUSBLOG_DEBUG_FRONTEND_PORT: '26501',
    FSUSBLOG_RELEASE_PREVIEW_PORT: '28501',
    FSUSBLOG_DEBUG_BACKEND_URL: 'http://127.0.0.1:24501',
    FSUSBLOG_DEBUG_FRONTEND_URL: 'http://127.0.0.1:26501',
    FSUSBLOG_RELEASE_PREVIEW_URL: 'http://127.0.0.1:28501',
    Jwt__SecretKey: 'test-only-secret-that-is-long-enough',
    Testing__EnforceProductionCsp: 'true',
    RuntimeTuning__ThreadPool__Enabled: 'true',
    RuntimeTuning__ThreadPool__MinThreadsPerCpu: '20',
    ...overrides
});

const serializeRuntimeEnvironment = (environment) => Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

test('runtime environment parser preserves non-shell values and binds all URLs to the current namespace', () =>
{
    const environment = parseRuntimeEnvironment(
        serializeRuntimeEnvironment(runtimeEnvironmentFixture({
            ConnectionStrings__DefaultConnection: 'Host=127.0.0.1;Port=24501;Password=value=with=equals',
            ActiveReleaseFence__AllowSyntheticLocalFence: 'true',
            FSUSBLOG_TEST_RUN_ID: 'production-2026-07-21_23-10-14-563-1341343',
            FSUSBLOG_PHYSICAL_BUNDLE_ID: 'runtime-browser',
            FSUSBLOG_STEP_ID: 'bootstrap',
            FSUSBLOG_TEST_RUNTIME_MODE: 'single',
            FSUSBLOG_TEST_NODE_COUNT: '1',
            FSUSBLOG_TEST_ARTIFACT_STORAGE: 'local',
            FSUSBLOG_TEST_COORDINATION_STORE: 'none',
            FSUSBLOG_TEST_CLUSTER_SCENARIO: 'none',
            FSUSBLOG_TEST_CLUSTER_BOOTSTRAP: 'none',
            FSUSBLOG_TEST_CLUSTER_FIXTURES: '',
            FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME: '0',
            FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID: ''
        })),
        'runtime-focused-1'
    );
    assert.equal(environment.Jwt__SecretKey, 'test-only-secret-that-is-long-enough');
    assert.equal(environment.Testing__EnforceProductionCsp, 'true');
    assert.equal(environment.RuntimeTuning__ThreadPool__Enabled, 'true');
    assert.equal(environment.RuntimeTuning__ThreadPool__MinThreadsPerCpu, '20');
    assert.equal(environment.ActiveReleaseFence__AllowSyntheticLocalFence, 'true');
    assert.equal(environment.FSUSBLOG_TEST_RUN_ID, 'production-2026-07-21_23-10-14-563-1341343');
    assert.equal(environment.FSUSBLOG_PHYSICAL_BUNDLE_ID, 'runtime-browser');
    assert.equal(environment.FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME, '0');
    assert.equal(
        environment.ConnectionStrings__DefaultConnection,
        'Host=127.0.0.1;Port=24501;Password=value=with=equals'
    );
});

test('runtime environment parser rejects foreign namespaces, unsafe keys, and URL-port mismatches', () =>
{
    const fixture = runtimeEnvironmentFixture();
    assert.throws(
        () => parseRuntimeEnvironment(serializeRuntimeEnvironment(fixture), 'another-run'),
        /namespace does not match/u
    );
    assert.throws(
        () => parseRuntimeEnvironment(`${serializeRuntimeEnvironment(fixture)}\nNODE_OPTIONS=--require=payload`, 'runtime-focused-1'),
        /key is not allowed: NODE_OPTIONS/u
    );
    assert.throws(
        () => parseRuntimeEnvironment(serializeRuntimeEnvironment({
            ...fixture,
            FSUSBLOG_RELEASE_PREVIEW_URL: 'http://127.0.0.1:28502'
        }), 'runtime-focused-1'),
        /not bound to loopback/u
    );
    for (const invalidUrl of [
        'https://127.0.0.1:28501',
        'http://localhost:28501',
        'http://user:secret@127.0.0.1:28501',
        'http://127.0.0.1:28501/unexpected',
        'http://127.0.0.1:28501/?query=1'
    ])
    {
        assert.throws(
            () => parseRuntimeEnvironment(serializeRuntimeEnvironment({
                ...fixture,
                FSUSBLOG_RELEASE_PREVIEW_URL: invalidUrl
            }), 'runtime-focused-1'),
            /not bound to loopback/u
        );
    }
    assert.throws(
        () => parseRuntimeEnvironment(`${serializeRuntimeEnvironment(fixture)}\nJwt__SecretKey=duplicate`, 'runtime-focused-1'),
        /key is duplicated/u
    );
    assert.throws(
        () => parseRuntimeEnvironment(serializeRuntimeEnvironment(fixture), '../runtime-focused-1'),
        /expected namespace is invalid/u
    );
});

test('runtime bundle loads its generated environment only after bootstrap and before step overrides', () =>
{
    const source = readFileSync(new URL('../../tools/test/bundles/run-bundle.mjs', import.meta.url), 'utf8');
    const processEnvironment = source.indexOf('...childBaseEnvironment');
    const runtimeEnvironment = source.indexOf('...runtimeChildEnvironment', processEnvironment);
    const stepEnvironment = source.indexOf('...(step.env ?? {})', runtimeEnvironment);
    assert.ok(processEnvironment >= 0 && runtimeEnvironment > processEnvironment && stepEnvironment > runtimeEnvironment);

    const bootstrapExecution = source.indexOf("if (step.id === 'bootstrap') {\n      const runtimeLayout = prepareProductionRuntimeLayout(productionBuildLayout)");
    const environmentRead = source.indexOf('...readRuntimeEnvironment(root, namespace)', bootstrapExecution);
    assert.ok(bootstrapExecution >= 0 && environmentRead > bootstrapExecution);
    assert.doesNotMatch(source.slice(bootstrapExecution, environmentRead), /source\s+[^\n]*\.env/u);
    assert.match(source.slice(bootstrapExecution, environmentRead), /prepareProductionRuntimeLayout\(productionBuildLayout\)/u);
    assert.match(source.slice(environmentRead, environmentRead + 300), /\.\.\.productionRuntimeChildEnvironment/u);
});

test('runtime correctness runner does not resolve, wrap, or emit counted Chromium admission', () =>
{
    const source = readFileSync(new URL('../../tools/test/bundles/run-bundle.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /resolveRuntimeBrowserLanePlan|resolveChromiumLaneCapacity|FSUSBLOG_CHROMIUM_LANE_MAX_SLOTS/u);
    assert.doesNotMatch(source, /createBrowserLaneProxySet|FSUSBLOG_BROWSER_LANE_|browser-lanes/u);
    assert.doesNotMatch(source, /runtime-browser-admission|browserAdmission/u);
    assert.match(source, /terminateProcessGroup\(child, terminationGraceMs\)/u);
});

test('browser lane session prefixes isolate workers and preserve the worker suffix', () =>
{
    assert.equal(resolveWorkerTestSession(3, {
        FSUSBLOG_TEST_SESSION_PREFIX: 'Lane Runtime Alpha'
    }), 'lane-runtime-alpha-3');
    const bounded = resolveWorkerTestSession(27, {
        FSUSBLOG_TEST_SESSION_PREFIX: 'lane-with-a-prefix-that-is-deliberately-longer-than-the-header-contract'
    });
    assert.match(bounded, /-27$/u);
    assert.ok(bounded.length <= 41);

    const crossBrowser = readFileSync(new URL('../../tools/test/lanes/cross-browser-smoke.sh', import.meta.url), 'utf8');
    assert.match(crossBrowser, /PLAYWRIGHT_OUTPUT_DIR="\$\{PLAYWRIGHT_OUTPUT_DIR:-test-results\/playwright\/cross-browser\}"/u);
});

function deferred()
{
    let resolve;
    const promise = new Promise((resolvePromise) =>
    {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 2_000)
{
    const deadline = Date.now() + timeoutMs;
    while (!predicate())
    {
        if (Date.now() >= deadline)
        {
            throw new Error('timed out waiting for DAG test condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test('runtime bundle removes artificial serial dependencies while retaining every logical member', () =>
{
    const steps = runtimeSteps();
    const index = byId(steps);
    assert.equal(steps.length, 21);
    assert.deepEqual(steps.flatMap((step) => step.members).sort(), [
        'bootstrap', 'cross-stack-contract', 'csrf-browser-matrix',
        'endpoint-depth', 'integration', 'release', 'resilience', 'security-authenticated-dast',
        'rights-v3-test-matrix', 'security'
    ].sort());

    assert.deepEqual(index.get('release-public-hydration').dependsOn, ['runtime-integration']);
    assert.deepEqual(index.get('security-runtime-core').dependsOn, ['bootstrap']);
    for (const id of [
        'endpoint-depth',
        'local-runtime-exposure'
    ])
    {
        assert.deepEqual(index.get(id).dependsOn, ['release-public-hydration']);
    }
    assert.deepEqual(index.get('runtime-integration').dependsOn, ['security-runtime-core']);
    assert.deepEqual(index.get('zap-baseline').dependsOn, [
        'security-runtime-core', 'authenticated-dast', 'release-public', 'resilience', 'cross-stack-runtime'
    ]);
    assert.deepEqual(index.get('authenticated-dast').dependsOn, ['security-runtime-core']);
    assert.deepEqual(index.get('cross-stack-runtime').dependsOn, ['runtime-integration']);
    assert.deepEqual(index.get('render-structure').dependsOn, ['frontend-build-ready']);
    assert.deepEqual(index.get('resilience').dependsOn, ['release-public']);
    assert.deepEqual(index.get('rights-matrix').dependsOn, ['runtime-integration']);
    assert.deepEqual(index.get('release-public').dependsOn, [
        'release-public-hydration', 'runtime-integration'
    ]);
    assert.match(index.get('release-public').command, /FSUSBLOG_RELEASE_HYDRATION_PREPARED_BY_DAG=1/u);

    assert.deepEqual(index.get('cross-stack').dependsOn, ['security-static', 'backend-build-ready']);
    assert.deepEqual(index.get('csrf-matrix').dependsOn, ['security-static', 'backend-build-ready']);

    assert.deepEqual(index.get('bootstrap').dependsOn, [
        'backend-build-ready', 'frontend-build-ready', 'security-static'
    ]);
    for (const id of ['backend-build-ready', 'frontend-build-ready'])
    {
        assert.deepEqual(index.get(id).dependsOn, []);
        assert.deepEqual(index.get(id).resources, { coordinationOnly: true });
    }
    assert.deepEqual(index.get('resilience').resources, {
        cpuWeight: 2,
        memoryWeight: 2,
        minCpuUnits: 1
    });
    assert.deepEqual(index.get('security-static').dependsOn, []);
    assert.deepEqual(index.get('security-static').members, []);
    assert.deepEqual(index.get('security-static').resources, {
        cpuWeight: 2,
        memoryWeight: 2,
        minCpuUnits: 1
    });
    assert.deepEqual(index.get('security-runtime-core').resources, {
        cpuWeight: 2,
        memoryWeight: 2,
        minCpuUnits: 1
    });
    assert.deepEqual(index.get('local-runtime-exposure').dependsOn, ['release-public-hydration']);
    assert.deepEqual(index.get('local-runtime-exposure').members, []);
    assert.match(index.get('local-runtime-exposure').command, /check-local-runtime-exposure\.mjs/u);
    assert.match(index.get('security-runtime-core').command, /FSUSBLOG_LOCAL_RUNTIME_EXPOSURE_IN_DAG=1/u);
    assert.deepEqual(index.get('authenticated-dast').dependsOn, ['security-runtime-core']);
    assert.deepEqual(index.get('authenticated-dast').members, ['security-authenticated-dast']);
    assert.deepEqual(index.get('authenticated-dast').resources, {
        cpuWeight: 1,
        memoryWeight: 1,
        minCpuUnits: 1
    });
    assert.deepEqual(index.get('security-join').dependsOn, ['security-static', 'security-runtime-core', 'local-runtime-exposure', 'zap-baseline']);
    assert.deepEqual(index.get('security-join').members, ['security']);
    assert.deepEqual(index.get('security-join').resources, { coordinationOnly: true });
    assert.equal(index.get('security-join').runAfterSettled, true);
    assert.deepEqual(index.get('cross-stack-join').dependsOn, ['cross-stack', 'cross-stack-runtime']);
    assert.deepEqual(index.get('cross-stack-join').members, ['cross-stack-contract']);
    assert.deepEqual(index.get('cross-stack-join').resources, { coordinationOnly: true });
    assert.equal(index.get('cross-stack-join').runAfterSettled, true);
    assert.deepEqual(index.get('zap-baseline').members, []);
    assert.equal(steps[0].id, 'backend-build-ready');
    assert.equal(steps[1].id, 'frontend-build-ready');
    assert.equal(steps[2].id, 'security-static', 'static security is the sole t0 executable task');
    assert.equal(steps[3].id, 'bootstrap', 'bootstrap follows markers and all pre-bootstrap source work');
    assert.equal(steps[4].id, 'release-public-hydration', 'release dist writes must settle before preview readers');
    assert.equal(steps[5].id, 'security-runtime-core', 'runtime security enters the first post-hydration wave');
    assert.equal(steps[6].id, 'authenticated-dast', 'authenticated DAST follows runtime security');
    assert.equal(steps[9].id, 'endpoint-depth', 'browserless endpoint depth follows stable release hydration');
    assert.equal(index.has('privacy-zk'), false);
    assert.deepEqual(index.get('runtime-state-stable').dependsOn, [
        'runtime-integration', 'release-public', 'endpoint-depth', 'security-runtime-core',
        'local-runtime-exposure', 'authenticated-dast', 'zap-baseline', 'cross-stack-join', 'render-structure',
        'rights-matrix', 'csrf-matrix', 'resilience'
    ]);
    assert.deepEqual(index.get('runtime-state-stable').resources, { coordinationOnly: true });
    assert.equal(index.get('runtime-state-stable').dependsOn.includes('security-static'), false);
    assert.equal(index.get('runtime-state-stable').dependsOn.includes('security-join'), false);
    assert.equal(index.has('data-scale-xs'), false);
    assert.equal(index.has('fault-injection'), false);
    assert.equal(steps.some((step) => Object.hasOwn(step.resources, 'cpuUnits') || Object.hasOwn(step.resources, 'memoryGiB')), false);
});

test('security phase join evidence binds every phase log and the complete concurrent span', () =>
{
    const joined = buildSettledPhaseJoinEvidence({
        stepId: 'security-join',
        dependencyIds: ['security-static', 'security-runtime-core', 'zap-baseline'],
        dependencyOutcomes: {
            'security-static': 'success',
            'security-runtime-core': 'success',
            'zap-baseline': 'success'
        },
        dependencyResults: new Map([
            ['security-static', { startedAtMs: 100, finishedAtMs: 500, durationMs: 400, logFile: 'static.log' }],
            ['security-runtime-core', { startedAtMs: 300, finishedAtMs: 800, durationMs: 500, logFile: 'core.log' }],
            ['zap-baseline', { startedAtMs: 350, finishedAtMs: 600, durationMs: 250, logFile: 'zap.log' }]
        ]),
        generatedAt: '2026-07-12T00:00:00.000Z'
    });
    assert.equal(joined.evidence.status, 'success');
    assert.deepEqual(joined.evidence.dependencies.map((entry) => entry.id), [
        'security-static', 'security-runtime-core', 'zap-baseline'
    ]);
    assert.deepEqual(joined.dependencyLogs, ['static.log', 'core.log', 'zap.log']);
    assert.equal(joined.durationMs, 700);
});

test('performance bundle folds the complete backend benchmark into the mixed window and joins exact evidence', () =>
{
    const steps = performanceSteps();
    const index = byId(steps);
    const measurements = ['backend-perf', 'mixed-performance-window', 'aeds-frame-cost'];
    const timedMeasurements = [
        'backend-perf', 'privacy-zk-benchmark', 'mixed-performance-window', 'aeds-frame-cost'
    ];
    const evidenceInputs = [
        'backend-perf', 'privacy-zk-benchmark', 'privacy-zk-finalize', 'mixed-performance-window',
        'aeds-frame-cost', 'aeds-compression'
    ];
    assert.equal(steps.length, 27);
    for (const id of measurements)
    {
        assert.deepEqual(index.get(id).dependsOn, ['performance-measurement-ready']);
        assert.deepEqual(index.get(id).resources.exclusiveResources, ['benchmark-window']);
    }
    assert.deepEqual(index.get('privacy-zk-performance-ready').dependsOn, ['privacy-zk-project-functional']);
    assert.equal(index.get('privacy-zk-performance-ready').resources.exclusiveResources, undefined);
    assert.deepEqual(index.get('privacy-zk-benchmark').dependsOn, ['performance-measurement-ready']);
    assert.deepEqual(index.get('privacy-zk-benchmark').resources.exclusiveResources, ['benchmark-window']);
    assert.deepEqual(index.get('privacy-zk-benchmark').members, ['privacy-zk-comment-matrix']);
    assert.deepEqual(index.get('privacy-zk-finalize').dependsOn, [
        'backend-perf', 'privacy-zk-benchmark', 'mixed-performance-window', 'aeds-frame-cost'
    ]);
    assert.deepEqual(index.get('privacy-zk-finalize').members, ['privacy-zk-comment-matrix']);
    assert.equal(index.get('privacy-zk-finalize').resources.exclusiveResources, undefined);
    assert.deepEqual(index.get('coverage-merge').dependsOn, ['backend-coverage-ready', 'frontend-coverage-ready']);
    assert.equal(index.get('coverage-threshold').resources.exclusiveResources, undefined);
    assert.deepEqual(index.get('aeds-compression').dependsOn, [
        'frontend-build-ready', 'benchmark-build-ready'
    ]);
    assert.equal(index.get('aeds-compression').resources.exclusiveResources, undefined);
    assert.deepEqual(index.get('performance-summary').dependsOn, ['coverage-threshold', ...evidenceInputs]);
    assert.deepEqual(index.get('release-evidence').dependsOn, ['performance-summary']);
    assert.deepEqual(index.get('production-summary').dependsOn, ['release-evidence']);
    assert.equal(index.get('mixed-performance-window').members.length, 18);
    assert.ok(index.get('mixed-performance-window').members.includes('backend-benchmark-regression'));
    assert.equal(index.has('backend-benchmark'), false);
    assert.equal(steps.some((step) => /\b(?:skip|maxFailures)\b/u.test(step.command)), false);
    assert.match(index.get('mixed-performance-window').command, /--reuse-passed/u);
    assert.equal(steps.some((step) => Object.hasOwn(step.resources, 'cpuUnits') || Object.hasOwn(step.resources, 'memoryGiB')), false);
    assert.ok(steps.every((step) => [
        'coordination', 'preparation', 'measurement', 'post-measurement'
    ].includes(step.evidencePhase)));
    assert.deepEqual(steps.filter((step) => step.evidencePhase === 'measurement').map((step) => step.id), timedMeasurements);
    assert.equal(steps.some((step) => step.evidencePhase !== 'measurement'
    && step.resources.exclusiveResources?.includes('benchmark-window')), false);
});

test('AEDS compression is deterministic preparation rather than a timed profiler', () =>
{
    const source = readFileSync(new URL('../../benchmarks/core/Program.cs', import.meta.url), 'utf8');
    const start = source.indexOf('internal static class AedsCompressionProfiler');
    const end = source.indexOf('internal static class ProfilerSupport', start);
    assert.ok(start >= 0 && end > start);
    const profiler = source.slice(start, end);

    for (const token of ['encodedFrameBytes', 'ratio', 'bytesSaved', 'etag'])
    {
        assert.match(profiler, new RegExp(`\\b${token}\\b`, 'u'));
    }
    assert.doesNotMatch(profiler, /Stopwatch|ProfileMeasurement|AverageMs|P95Ms|durationMs/u);
});

test('scheduler grants use the full live machine capacity without bundle reference caps', () =>
{
    for (const cpuUnits of [4, 8, 16])
    {
        const capacity = resolveBundleRuntimeCapacity({
            availableCpu: cpuUnits,
            availableMemoryGiB: cpuUnits * 2,
            inheritedCpuBudget: String(cpuUnits),
            inheritedMemoryGiB: String(cpuUnits * 1.5),
            cpuWeight: 2,
            memoryWeight: 3
        });
        assert.deepEqual(capacity, {
            maxParallel: cpuUnits,
            cpuUnits,
            memoryGiB: cpuUnits * 1.5
        });
    }

    assert.deepEqual(resolveBundleRuntimeCapacity({
        availableCpu: 12,
        availableMemoryGiB: 18,
        cpuWeight: 1,
        memoryWeight: 1
    }), { maxParallel: 12, cpuUnits: 12, memoryGiB: 18 });
});

test('each concurrent wave divides its actual CPU and memory grants by weights and minima', () =>
{
    const steps = resolveBundleSteps('any', [
        { id: 'light', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
        { id: 'heavy', resources: { cpuWeight: 3, memoryWeight: 2, minCpuUnits: 2 } }
    ], { cpuUnits: 8, memoryGiB: 12 });
    const allocations = resolveConcurrentStepCapacities(steps, { cpuUnits: 8, memoryGiB: 12 });
    assert.deepEqual(allocations, [
        { maxParallel: 2, cpuUnits: 2, memoryGiB: 4 },
        { maxParallel: 6, cpuUnits: 6, memoryGiB: 8 }
    ]);
    assert.equal(allocations.reduce((total, entry) => total + entry.cpuUnits, 0), 8);
    assert.equal(allocations.reduce((total, entry) => total + entry.memoryGiB, 0), 12);

    assert.deepEqual(
        resolveStepRuntimeCapacity('any', { id: 'only', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }, { cpuUnits: 6, memoryGiB: 9 }),
        { maxParallel: 6, cpuUnits: 6, memoryGiB: 9 }
    );
});

test('coordination-only gates consume no CPU or memory while executable siblings retain the full grant', () =>
{
    const allocations = resolveConcurrentStepCapacities([
        { id: 'build-ready', resources: { coordinationOnly: true } },
        { id: 'vitest', resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: 1 } }
    ], { cpuUnits: 3, memoryGiB: 2 });

    assert.deepEqual(allocations, [
        { maxParallel: 0, cpuUnits: 0, memoryGiB: 0 },
        { maxParallel: 3, cpuUnits: 3, memoryGiB: 2 }
    ]);
});

test('coordination-only admission remains valid after executable siblings consume the live grant', () =>
{
    assert.deepEqual(resolveConcurrentStepCapacities([
        { id: 'settled-join', resources: { coordinationOnly: true } }
    ], { cpuUnits: 0, memoryGiB: 0 }), [
        { maxParallel: 0, cpuUnits: 0, memoryGiB: 0 }
    ]);
});

test('coordination-only gates can wait without reducing a running sibling grant', async () =>
{
    const gate = deferred();
    const started = [];
    await executeWeightedStepDag([
        { id: 'build-ready', resources: { coordinationOnly: true } },
        { id: 'vitest', resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: 1 } },
        {
            id: 'postbuild',
            dependsOn: ['build-ready'],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
        }
    ], { maxParallel: 3, cpuUnits: 3, memoryGiB: 2 }, async (entry) =>
    {
        started.push({ id: entry.id, capacity: entry.runtimeCapacity });
        if (entry.id === 'build-ready')
        {
            await gate.promise;
        }
        if (entry.id === 'vitest')
        {
            gate.resolve();
        }
    });

    assert.deepEqual(started.slice(0, 2), [
        { id: 'build-ready', capacity: { maxParallel: 0, cpuUnits: 0, memoryGiB: 0 } },
        { id: 'vitest', capacity: { maxParallel: 3, cpuUnits: 3, memoryGiB: 2 } }
    ]);
    assert.equal(started[2].id, 'postbuild');
});

test('coordination-only marker waits do not consume a one-CPU admission slot', async () =>
{
    const backend = deferred();
    const frontend = deferred();
    const security = deferred();
    const started = [];
    const execution = executeWeightedStepDag([
        { id: 'backend-build-ready', resources: { coordinationOnly: true } },
        { id: 'frontend-build-ready', resources: { coordinationOnly: true } },
        { id: 'security-static', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
    ], { maxParallel: 1, cpuUnits: 1, memoryGiB: 1 }, async (entry) =>
    {
        started.push(entry.id);
        if (entry.id === 'backend-build-ready')
        {
            await backend.promise;
        }
        if (entry.id === 'frontend-build-ready')
        {
            await frontend.promise;
        }
        if (entry.id === 'security-static')
        {
            await security.promise;
        }
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['backend-build-ready', 'frontend-build-ready', 'security-static']);
    backend.resolve();
    frontend.resolve();
    security.resolve();
    await execution;
});

test('bundle cancellation interrupts an active coordination marker without admitting descendants', async () =>
{
    const controller = new AbortController();
    const started = [];
    const execution = executeWeightedStepDag([
        { id: 'marker-ready', resources: { coordinationOnly: true } },
        { id: 'dependent', dependsOn: ['marker-ready'], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
    ], () => ({
        maxParallel: 1,
        cpuUnits: 1,
        memoryGiB: 1,
        signal: controller.signal
    }), async (entry) =>
    {
        started.push(entry.id);
        if (entry.id === 'marker-ready')
        {
            await new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => reject(
                new Error('marker wait cancelled')
            ), { once: true }));
        }
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('bundle cancelled'));
    await assert.rejects(execution, /bundle cancelled|marker wait cancelled/u);
    assert.deepEqual(started, ['marker-ready']);
});

test('exact performance markers release preparation while unrelated runtime tail remains active', async () =>
{
    const backendCoverage = deferred();
    const frontendCoverage = deferred();
    const frontendBuild = deferred();
    const benchmarkBuild = deferred();
    const runtimeTailActive = true;
    const started = [];
    const index = byId(performanceSteps());
    const execution = executeWeightedStepDag([
        index.get('backend-coverage-ready'),
        index.get('frontend-coverage-ready'),
        index.get('frontend-build-ready'),
        index.get('benchmark-build-ready'),
        index.get('coverage-merge'),
        index.get('aeds-compression')
    ], { maxParallel: 2, cpuUnits: 2, memoryGiB: 2 }, async (entry) =>
    {
        started.push(entry.id);
        if (entry.id === 'backend-coverage-ready')
        {
            await backendCoverage.promise;
        }
        if (entry.id === 'frontend-coverage-ready')
        {
            await frontendCoverage.promise;
        }
        if (entry.id === 'frontend-build-ready')
        {
            await frontendBuild.promise;
        }
        if (entry.id === 'benchmark-build-ready')
        {
            await benchmarkBuild.promise;
        }
    });
    await new Promise((resolve) => setImmediate(resolve));
    backendCoverage.resolve();
    frontendCoverage.resolve();
    frontendBuild.resolve();
    benchmarkBuild.resolve();
    await waitFor(() => started.includes('coverage-merge') && started.includes('aeds-compression'));
    assert.equal(runtimeTailActive, true);
    await execution;
});

test('failed exact producer blocks only its marker descendants while independent preparation completes', async () =>
{
    const index = byId(performanceSteps());
    const started = [];
    await assert.rejects(executeWeightedStepDag([
        index.get('backend-coverage-ready'),
        index.get('frontend-coverage-ready'),
        index.get('frontend-build-ready'),
        index.get('benchmark-build-ready'),
        index.get('coverage-merge'),
        index.get('aeds-compression')
    ], { maxParallel: 3, cpuUnits: 3, memoryGiB: 3 }, async (entry) =>
    {
        started.push(entry.id);
        if (entry.id === 'backend-coverage-ready')
        {
            throw new Error('backend coverage producer failed');
        }
    }), /backend coverage producer failed/u);
    assert.ok(started.includes('aeds-compression'));
    assert.equal(started.includes('coverage-merge'), false);
});

test('weighted DAG fills each dependency-ready wave from actual grants across machine sizes', async () =>
{
    for (const cpuUnits of [4, 8, 16])
    {
        const capacity = { maxParallel: cpuUnits, cpuUnits, memoryGiB: cpuUnits * 1.5 };
        for (const steps of [runtimeSteps(), performanceSteps()])
        {
            const executed = [];
            await executeWeightedStepDag(steps, {
                ...capacity,
                exclusiveResources: ['runtime-services', 'load-window', 'database-writes', 'benchmark-window']
            }, async (step) => executed.push({ id: step.id, capacity: step.runtimeCapacity }));
            assert.equal(executed.length, steps.length);
            const coordinationIds = new Set(steps
                .filter((entry) => entry.resources.coordinationOnly)
                .map((entry) => entry.id));
            assert.ok(executed.every((entry) => entry.capacity.cpuUnits >= (coordinationIds.has(entry.id) ? 0 : 1)));
            assert.ok(executed.every((entry) => entry.capacity.memoryGiB >= (coordinationIds.has(entry.id) ? 0 : Number.EPSILON)));
        }
    }
});

test('runtime bundle is browserless and leaves browser admission to contract and diagnostics', () =>
{
    const index = byId(runtimeSteps());
    for (const id of ['ux-risk-matrix', 'cross-browser', 'render-pressure'])
    {
        assert.equal(index.has(id), false, `${id} must stay in scheduled/manual diagnostics`);
    }
    assert.equal(index.has('acceptance'), false);
    assert.equal(index.has('render-structure'), true);
    assert.equal([...index.values()].some((entry) => Object.hasOwn(entry.resources, 'countedResources')), false);
});

test('two-CPU runtime grant gives each dependency-ready serial phase the complete grant', async () =>
{
    const bootstrap = deferred();
    const hydration = deferred();
    const security = deferred();
    const integration = deferred();
    const started = [];
    const index = byId(runtimeSteps());
    const selected = [
        { ...index.get('bootstrap'), dependsOn: [] },
        index.get('release-public-hydration'),
        index.get('security-runtime-core'),
        index.get('runtime-integration')
    ];
    const execution = executeWeightedStepDag(selected, {
        maxParallel: 2,
        cpuUnits: 2,
        memoryGiB: 5
    }, async (entry) =>
    {
        started.push({ id: entry.id, capacity: entry.runtimeCapacity });
        if (entry.id === 'bootstrap')
        {
            await bootstrap.promise;
        }
        if (entry.id === 'release-public-hydration')
        {
            await hydration.promise;
        }
        if (entry.id === 'security-runtime-core')
        {
            await security.promise;
        }
        if (entry.id === 'runtime-integration')
        {
            await integration.promise;
        }
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started.map((entry) => entry.id), ['bootstrap']);
    bootstrap.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started.slice(1).map((entry) => entry.id), ['security-runtime-core']);
    assert.equal(started.at(-1).capacity.cpuUnits, 2);
    assert.equal(started.at(-1).capacity.memoryGiB, 5);
    security.resolve();
    await waitFor(() => started.some((entry) => entry.id === 'runtime-integration'));
    assert.equal(started.some((entry) => entry.id === 'release-public-hydration'), false);
    assert.equal(started.at(-1).capacity.cpuUnits, 2);
    integration.resolve();
    await waitFor(() => started.some((entry) => entry.id === 'release-public-hydration'));
    assert.equal(started.at(-1).capacity.cpuUnits, 2);
    hydration.resolve();
    await execution;
});

test('elastic 3/4/6 CPU grants immediately widen an independent runtime wave', async () =>
{
    const core = deferred();
    const structure = deferred();
    const dast = deferred();
    const integration = deferred();
    const release = deferred();
    const endpoint = deferred();
    const started = [];
    let capacity = { maxParallel: 2, cpuUnits: 2, memoryGiB: 4 };
    const index = byId(runtimeSteps());
    const selected = [
        { ...index.get('security-runtime-core'), dependsOn: [] },
        { ...index.get('render-structure'), dependsOn: [] },
        { ...index.get('authenticated-dast'), dependsOn: [] },
        { ...index.get('runtime-integration'), dependsOn: [] },
        { ...index.get('release-public'), dependsOn: [] },
        { ...index.get('endpoint-depth'), dependsOn: [] }
    ];
    const execution = executeWeightedStepDag(selected, () => capacity, async (entry) =>
    {
        started.push({ id: entry.id, capacity: entry.runtimeCapacity });
        if (entry.id === 'security-runtime-core')
        {
            await core.promise;
        }
        if (entry.id === 'render-structure')
        {
            await structure.promise;
        }
        if (entry.id === 'authenticated-dast')
        {
            await dast.promise;
        }
        if (entry.id === 'runtime-integration')
        {
            await integration.promise;
        }
        if (entry.id === 'release-public')
        {
            await release.promise;
        }
        if (entry.id === 'endpoint-depth')
        {
            await endpoint.promise;
        }
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started.map((entry) => entry.id), ['security-runtime-core', 'render-structure']);
    assert.deepEqual(started.map((entry) => entry.capacity.cpuUnits), [1, 1]);

    capacity = { maxParallel: 3, cpuUnits: 3, memoryGiB: 6 };
    await waitFor(() => started.some((entry) => entry.id === 'authenticated-dast'));
    assert.deepEqual(started.map((entry) => entry.id), [
        'security-runtime-core', 'render-structure', 'authenticated-dast'
    ]);

    capacity = { maxParallel: 4, cpuUnits: 4, memoryGiB: 8 };
    await waitFor(() => started.at(-1)?.id === 'runtime-integration');
    assert.equal(started.at(-1).id, 'runtime-integration');
    assert.equal(started.at(-1).capacity.cpuUnits, 1);
    assert.equal(started.some((entry) => entry.id === 'release-public'), false);

    capacity = { maxParallel: 6, cpuUnits: 6, memoryGiB: 12 };
    await waitFor(() => started.some((entry) => entry.id === 'endpoint-depth'));
    assert.deepEqual(started.map((entry) => entry.id), [
        'security-runtime-core',
        'render-structure',
        'authenticated-dast',
        'runtime-integration',
        'release-public',
        'endpoint-depth'
    ]);
    assert.deepEqual(started.slice(-2).map((entry) => entry.capacity.cpuUnits), [1, 1]);

    dast.resolve();
    integration.resolve();
    release.resolve();
    endpoint.resolve();
    core.resolve();
    structure.resolve();
    await execution;
});

test('t0 static security is followed by cross-stack and CSRF in the backend/frontend marker gap', async () =>
{
    const backend = deferred();
    const frontend = deferred();
    const staticSecurity = deferred();
    const crossStack = deferred();
    const csrf = deferred();
    const bootstrap = deferred();
    const started = [];
    const index = byId(runtimeSteps());
    const selected = [
        index.get('backend-build-ready'),
        index.get('frontend-build-ready'),
        index.get('security-static'),
        index.get('bootstrap'),
        index.get('cross-stack'),
        index.get('csrf-matrix')
    ];
    const execution = executeWeightedStepDag(selected, {
        maxParallel: 1,
        cpuUnits: 1,
        memoryGiB: 3
    }, async (entry) =>
    {
        started.push(entry.id);
        if (entry.id === 'backend-build-ready')
        {
            await backend.promise;
        }
        if (entry.id === 'frontend-build-ready')
        {
            await frontend.promise;
        }
        if (entry.id === 'security-static')
        {
            await staticSecurity.promise;
        }
        if (entry.id === 'cross-stack')
        {
            await crossStack.promise;
        }
        if (entry.id === 'csrf-matrix')
        {
            await csrf.promise;
        }
        if (entry.id === 'bootstrap')
        {
            await bootstrap.promise;
        }
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['backend-build-ready', 'frontend-build-ready', 'security-static']);
    staticSecurity.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.includes('cross-stack'), false);
    backend.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.at(-1), 'cross-stack');
    crossStack.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.at(-1), 'csrf-matrix');
    csrf.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.includes('bootstrap'), false);
    frontend.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.at(-1), 'bootstrap');
    bootstrap.resolve();
    await execution;
});

test('failed-run timing model gives bootstrap hydration and browser phases the complete grant', async () =>
{
    const backend = deferred();
    const frontend = deferred();
    const staticSecurity = deferred();
    const crossStack = deferred();
    const csrf = deferred();
    const bootstrap = deferred();
    const hydration = deferred();
    const security = deferred();
    const integration = deferred();
    const started = [];
    let capacity = { maxParallel: 1, cpuUnits: 1, memoryGiB: 3 };
    const index = byId(runtimeSteps());
    const selected = [
        index.get('backend-build-ready'),
        index.get('frontend-build-ready'),
        index.get('security-static'),
        index.get('cross-stack'),
        index.get('csrf-matrix'),
        index.get('bootstrap'),
        index.get('release-public-hydration'),
        index.get('security-runtime-core'),
        index.get('runtime-integration')
    ];
    const execution = executeWeightedStepDag(selected, () => capacity, async (entry) =>
    {
        started.push({ id: entry.id, capacity: entry.runtimeCapacity });
        if (entry.id === 'backend-build-ready')
        {
            await backend.promise;
        }
        if (entry.id === 'frontend-build-ready')
        {
            await frontend.promise;
        }
        if (entry.id === 'security-static')
        {
            await staticSecurity.promise;
        }
        if (entry.id === 'cross-stack')
        {
            await crossStack.promise;
        }
        if (entry.id === 'csrf-matrix')
        {
            await csrf.promise;
        }
        if (entry.id === 'bootstrap')
        {
            await bootstrap.promise;
        }
        if (entry.id === 'release-public-hydration')
        {
            await hydration.promise;
        }
        if (entry.id === 'security-runtime-core')
        {
            await security.promise;
        }
        if (entry.id === 'runtime-integration')
        {
            await integration.promise;
        }
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started.map((entry) => entry.id), ['backend-build-ready', 'frontend-build-ready', 'security-static']);
    assert.equal(started.at(-1).capacity.cpuUnits, 1);
    staticSecurity.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.some((entry) => entry.id === 'cross-stack'), false);

    backend.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.at(-1).id, 'cross-stack');
    crossStack.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.at(-1).id, 'csrf-matrix');
    csrf.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.some((entry) => entry.id === 'bootstrap'), false);

    capacity = { maxParallel: 2, cpuUnits: 2, memoryGiB: 4 };
    frontend.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const bootstrapStart = started.find((entry) => entry.id === 'bootstrap');
    assert.deepEqual(bootstrapStart?.capacity, { maxParallel: 2, cpuUnits: 2, memoryGiB: 4 });
    assert.equal(started.some((entry) => entry.id === 'release-public-hydration'), false);

    bootstrap.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.at(-1).id, 'security-runtime-core');
    assert.equal(started.at(-1).capacity.cpuUnits, 2);
    security.resolve();
    await waitFor(() => started.some((entry) => entry.id === 'runtime-integration'));
    integration.resolve();
    await waitFor(() => started.some((entry) => entry.id === 'release-public-hydration'));
    assert.equal(started.at(-1).capacity.cpuUnits, 2);
    hydration.resolve();
    await execution;
});

test('security join preserves the static preflight through the post-bootstrap core wave', async () =>
{
    const bootstrap = deferred();
    const securityStatic = deferred();
    const securityCore = deferred();
    const started = [];
    const selected = runtimeSteps()
        .filter((entry) => ['bootstrap', 'security-static', 'security-runtime-core', 'security-join'].includes(entry.id))
        .map((entry) =>
        {
            if (entry.id === 'bootstrap')
            {
                return { ...entry, dependsOn: ['security-static'] };
            }
            if (entry.id === 'security-join')
            {
                return { ...entry, dependsOn: ['security-static', 'security-runtime-core'] };
            }
            return entry;
        });
    const execution = executeWeightedStepDag(selected, {
        maxParallel: 5,
        cpuUnits: 5,
        memoryGiB: 5
    }, async (entry) =>
    {
        started.push({ id: entry.id, capacity: entry.runtimeCapacity });
        if (entry.id === 'bootstrap')
        {
            await bootstrap.promise;
        }
        if (entry.id === 'security-static')
        {
            await securityStatic.promise;
        }
        if (entry.id === 'security-runtime-core')
        {
            await securityCore.promise;
        }
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started.map((entry) => entry.id), ['security-static']);
    securityStatic.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.at(-1).id, 'bootstrap');
    bootstrap.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.at(-1).id, 'security-runtime-core');
    assert.ok(!started.some((entry) => entry.id === 'security-join'));
    securityCore.resolve();
    await execution;
    assert.equal(started.at(-1).id, 'security-join');
});

test('performance tail runs isolated data scales together then overlaps summary with fault injection', async () =>
{
    const xs = deferred();
    const small = deferred();
    const summary = deferred();
    const fault = deferred();
    const started = [];
    const index = byId(performanceSteps());
    const selected = [
        { id: 'runtime-state-ready', command: null, members: [], dependsOn: [], resources: { coordinationOnly: true } },
        { id: 'resident-handoff-ready', command: null, members: [], dependsOn: [], resources: { coordinationOnly: true } },
        index.get('data-scale-xs'),
        index.get('data-scale-s'),
        index.get('data-scale-summary'),
        index.get('fault-injection')
    ];
    const execution = executeWeightedStepDag(selected, {
        maxParallel: 4,
        cpuUnits: 4,
        memoryGiB: 4
    }, async (entry) =>
    {
        started.push(entry.id);
        if (entry.id === 'data-scale-xs')
        {
            await xs.promise;
        }
        if (entry.id === 'data-scale-s')
        {
            await small.promise;
        }
        if (entry.id === 'data-scale-summary')
        {
            await summary.promise;
        }
        if (entry.id === 'fault-injection')
        {
            await fault.promise;
        }
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['runtime-state-ready', 'resident-handoff-ready', 'data-scale-xs', 'data-scale-s']);
    xs.resolve();
    small.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started.slice(-2), ['data-scale-summary', 'fault-injection']);
    summary.resolve();
    fault.resolve();
    await execution;
});

test('settled security join runs after independent phase failures and the DAG aggregates every cause', async () =>
{
    const first = new Error('security static failed');
    const second = new Error('security runtime failed');
    const started = [];
    await assert.rejects(executeWeightedStepDag([
        { id: 'security-static', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
        { id: 'bootstrap', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
        {
            id: 'security-runtime-core',
            dependsOn: ['bootstrap'],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
        },
        {
            id: 'security-join',
            dependsOn: ['security-static', 'security-runtime-core'],
            runAfterSettled: true,
            resources: { coordinationOnly: true }
        }
    ], { maxParallel: 2, cpuUnits: 2, memoryGiB: 2 }, async (entry) =>
    {
        started.push({ id: entry.id, outcomes: entry.dependencyOutcomes });
        if (entry.id === 'security-static')
        {
            throw first;
        }
        if (entry.id === 'security-runtime-core')
        {
            throw second;
        }
    }), (error) =>
    {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [first, second]);
        return true;
    });
    assert.deepEqual(started.at(-1), {
        id: 'security-join',
        outcomes: { 'security-static': 'failure', 'security-runtime-core': 'failure' }
    });
});

test('weighted DAG re-reads an elastic scheduler grant before admitting waiting work', async () =>
{
    let capacity = {
        maxParallel: 1,
        cpuUnits: 1,
        memoryGiB: 2,
        exclusiveResources: []
    };
    const executed = [];
    const running = executeWeightedStepDag([
        { id: 'needs-expanded-grant', resources: { cpuWeight: 2, memoryWeight: 1, minCpuUnits: 2 } }
    ], () => capacity, async (entry) => executed.push(entry.runtimeCapacity));

    await new Promise((resolve) => setTimeout(resolve, 20));
    capacity = { ...capacity, maxParallel: 4, cpuUnits: 4, memoryGiB: 4 };
    await running;
    assert.deepEqual(executed, [{ maxParallel: 4, cpuUnits: 4, memoryGiB: 4 }]);
});

test('a fixed worker pool starts after its preflight with the complete then-current grant', async () =>
{
    let capacity = {
        maxParallel: 2,
        cpuUnits: 2,
        memoryGiB: 3,
        exclusiveResources: []
    };
    const executed = [];
    await executeWeightedStepDag([
        { id: 'preflight', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
        {
            id: 'fixed-worker-pool',
            dependsOn: ['preflight'],
            resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: 1 }
        }
    ], () => capacity, async (entry) =>
    {
        executed.push({ id: entry.id, capacity: entry.runtimeCapacity });
        if (entry.id === 'preflight')
        {
            capacity = { ...capacity, maxParallel: 5, cpuUnits: 5, memoryGiB: 6 };
        }
    });

    assert.deepEqual(executed, [
        { id: 'preflight', capacity: { maxParallel: 2, cpuUnits: 2, memoryGiB: 3 } },
        { id: 'fixed-worker-pool', capacity: { maxParallel: 5, cpuUnits: 5, memoryGiB: 6 } }
    ]);
});

test('weighted DAG rolls freed grants into newly-ready work without a whole-wave barrier', async () =>
{
    const events = [];
    let releaseLong;
    let releaseShort;
    const long = new Promise((resolve) =>
    {
        releaseLong = resolve;
    });
    const short = new Promise((resolve) =>
    {
        releaseShort = resolve;
    });
    let activeCpu = 0;
    let activeMemory = 0;

    const running = executeWeightedStepDag([
        { id: 'long', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
        { id: 'short', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
        { id: 'after-short', dependsOn: ['short'], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
    ], { maxParallel: 2, cpuUnits: 4, memoryGiB: 8 }, async (entry) =>
    {
        activeCpu += entry.runtimeCapacity.cpuUnits;
        activeMemory += entry.runtimeCapacity.memoryGiB;
        assert.ok(activeCpu <= 4);
        assert.ok(activeMemory <= 8);
        events.push(`${entry.id}:start`);
        if (entry.id === 'long')
        {
            await long;
        }
        if (entry.id === 'short')
        {
            await short;
        }
        events.push(`${entry.id}:end`);
        activeCpu -= entry.runtimeCapacity.cpuUnits;
        activeMemory -= entry.runtimeCapacity.memoryGiB;
    });

    await new Promise((resolve) => setImmediate(resolve));
    releaseShort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(events.includes('after-short:start'));
    assert.equal(events.includes('long:end'), false);
    releaseLong();
    await running;
    assert.ok(events.indexOf('after-short:start') < events.indexOf('long:end'));
});

test('different exclusive resources and ordinary work share the same admission wave', async () =>
{
    const events = [];
    const gates = new Map(['build', 'benchmark', 'ordinary'].map((id) => [id, deferred()]));

    const running = executeWeightedStepDag([
        {
            id: 'build',
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['build-output'] }
        },
        {
            id: 'benchmark',
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['benchmark-window'] }
        },
        { id: 'ordinary', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
    ], {
        maxParallel: 3,
        cpuUnits: 3,
        memoryGiB: 6,
        exclusiveResources: ['build-output', 'benchmark-window']
    }, async (entry) =>
    {
        events.push(`${entry.id}:start`);
        await gates.get(entry.id).promise;
        events.push(`${entry.id}:end`);
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['build:start', 'benchmark:start', 'ordinary:start']);
    for (const gate of gates.values())
    {
        gate.resolve();
    }
    await running;
});

test('generic counted resources overlap independent work, serialize at one, and block after contraction', async () =>
{
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const started = [];
    const waits = [];
    let capacity = {
        maxParallel: 3,
        cpuUnits: 3,
        memoryGiB: 6,
        countedResources: { externalLane: 2 },
        onWaitState: (stepId, state) => waits.push({ stepId, state })
    };
    const running = executeWeightedStepDag([
        { id: 'first', resources: { countedResources: { externalLane: 1 } } },
        { id: 'second', resources: { countedResources: { externalLane: 1 } } },
        { id: 'third', resources: { countedResources: { externalLane: 1 } } }
    ], () => capacity, async (entry) =>
    {
        started.push(entry.id);
        if (entry.id === 'first')
        {
            await first.promise;
        }
        if (entry.id === 'second')
        {
            await second.promise;
        }
        if (entry.id === 'third')
        {
            await third.promise;
        }
    });
    await waitFor(() => started.length === 2);
    assert.deepEqual(started, ['first', 'second']);
    assert.ok(waits.some((entry) => entry.stepId === 'third' && entry.state?.countedResources?.externalLane));
    capacity = { ...capacity, countedResources: { externalLane: 1 } };
    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(started.includes('third'), false);
    second.resolve();
    await waitFor(() => started.includes('third'));
    third.resolve();
    await running;
});

test('failed counted-resource holder releases its slot and independent lanes still settle', async () =>
{
    const events = [];
    const failure = new Error('external lane failed');
    await assert.rejects(executeWeightedStepDag([
        { id: 'failed', resources: { countedResources: { externalLane: 1 } } },
        { id: 'next', resources: { countedResources: { externalLane: 1 } } },
        { id: 'coordination', resources: { coordinationOnly: true } }
    ], {
        maxParallel: 2,
        cpuUnits: 2,
        memoryGiB: 4,
        countedResources: { externalLane: 1 }
    }, async (entry) =>
    {
        events.push(entry.id);
        if (entry.id === 'failed')
        {
            throw failure;
        }
    }), /external lane failed/u);
    assert.deepEqual(events, ['failed', 'coordination', 'next']);
});

test('same exclusive resource is serialized within a wave and reports its holder', async () =>
{
    const events = [];
    const first = deferred();
    const second = deferred();
    const other = deferred();
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try
    {
        const running = executeWeightedStepDag([
            { id: 'first', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['window'] } },
            { id: 'second', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['window'] } },
            { id: 'other', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['other-window'] } }
        ], {
            maxParallel: 3,
            cpuUnits: 3,
            memoryGiB: 6,
            exclusiveResources: ['window', 'other-window']
        }, async (entry) =>
        {
            events.push(`${entry.id}:start`);
            if (entry.id === 'first')
            {
                await first.promise;
            }
            if (entry.id === 'second')
            {
                await second.promise;
            }
            if (entry.id === 'other')
            {
                await other.promise;
            }
            events.push(`${entry.id}:end`);
        });

        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(events, ['first:start', 'other:start']);
        assert.ok(logs.some((line) => line.includes('wait second exclusiveResource=window heldBy=first holderState=admission-wave')));
        first.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(events.includes('second:start'));
        second.resolve();
        other.resolve();
        await running;
    }
    finally
    {
        console.log = originalLog;
    }
});

test('a newly ready step observes the resource set of an already active holder', async () =>
{
    const holder = deferred();
    const waiter = deferred();
    const events = [];
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try
    {
        const running = executeWeightedStepDag([
            { id: 'holder', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['window'] } },
            { id: 'ready', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
            {
                id: 'waiter',
                dependsOn: ['ready'],
                resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['window'] }
            }
        ], { maxParallel: 2, cpuUnits: 2, memoryGiB: 4, exclusiveResources: ['window'] }, async (entry) =>
        {
            events.push(`${entry.id}:start`);
            if (entry.id === 'holder')
            {
                await holder.promise;
            }
            if (entry.id === 'waiter')
            {
                await waiter.promise;
            }
            events.push(`${entry.id}:end`);
        });

        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(events.includes('ready:end'));
        assert.equal(events.includes('waiter:start'), false);
        assert.ok(logs.some((line) => line.includes('wait waiter exclusiveResource=window heldBy=holder holderState=active')));
        holder.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(events.includes('waiter:start'));
        waiter.resolve();
        await running;
    }
    finally
    {
        console.log = originalLog;
    }
});

test('failed exclusive holder releases only its named resource and failures still aggregate', async () =>
{
    const events = [];
    const firstFailure = new Error('first failed');
    const independentFailure = new Error('independent failed');
    await assert.rejects(executeWeightedStepDag([
        { id: 'first', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['window'] } },
        { id: 'waiter', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['window'] } },
        { id: 'independent', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
    ], { maxParallel: 2, cpuUnits: 2, memoryGiB: 4, exclusiveResources: ['window'] }, async (entry) =>
    {
        events.push(entry.id);
        if (entry.id === 'first')
        {
            throw firstFailure;
        }
        if (entry.id === 'independent')
        {
            throw independentFailure;
        }
    }), (error) =>
    {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [firstFailure, independentFailure]);
        return true;
    });
    assert.deepEqual(events, ['first', 'independent', 'waiter']);
});

test('CPU capacity still delays non-conflicting exclusive work', async () =>
{
    const first = deferred();
    const events = [];
    const running = executeWeightedStepDag([
        { id: 'first', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['first-window'] } },
        { id: 'second', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['second-window'] } }
    ], {
        maxParallel: 1,
        cpuUnits: 1,
        memoryGiB: 2,
        exclusiveResources: ['first-window', 'second-window']
    }, async (entry) =>
    {
        events.push(`${entry.id}:start`);
        if (entry.id === 'first')
        {
            await first.promise;
        }
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['first:start']);
    first.resolve();
    await running;
    assert.deepEqual(events, ['first:start', 'second:start']);
});

test('memory capacity still delays non-conflicting exclusive work until the active grant is released', async () =>
{
    const first = deferred();
    const events = [];
    const waits = [];
    const running = executeWeightedStepDag([
        {
            id: 'first',
            resources: {
                cpuWeight: 1,
                memoryWeight: 1,
                minCpuUnits: 1,
                minMemoryGiB: 1.5,
                exclusiveResources: ['first-window']
            }
        },
        {
            id: 'second',
            resources: {
                cpuWeight: 1,
                memoryWeight: 1,
                minCpuUnits: 1,
                minMemoryGiB: 1.5,
                exclusiveResources: ['second-window']
            }
        }
    ], {
        maxParallel: 2,
        cpuUnits: 2,
        memoryGiB: 2,
        exclusiveResources: ['first-window', 'second-window'],
        onWaitState: (stepId, state) => waits.push({ stepId, state })
    }, async (entry) =>
    {
        events.push(`${entry.id}:start`);
        if (entry.id === 'first')
        {
            await first.promise;
        };
    });

    await waitFor(() => events.length === 1);
    assert.deepEqual(events, ['first:start']);
    assert.ok(waits.some((entry) => entry.stepId === 'second' && entry.state?.capacity?.memory === true));
    first.resolve();
    await running;
    assert.deepEqual(events, ['first:start', 'second:start']);
});

test('machine execution deadlines derive pressure from workload weights and actual grants', () =>
{
    const workload = { cpuWeight: 5, memoryWeight: 5, minCpuUnits: 1 };
    assert.equal(resolveMachineExecutionTimeoutMs({
        baseTimeoutMs: 100_000,
        workload,
        actualCapacity: { cpuUnits: 5, memoryGiB: 5 }
    }), 100_000);
    assert.equal(resolveMachineExecutionTimeoutMs({
        baseTimeoutMs: 100_000,
        workload,
        actualCapacity: { cpuUnits: 10, memoryGiB: 10 }
    }), 100_000);
    assert.equal(resolveMachineExecutionTimeoutMs({
        baseTimeoutMs: 100_000,
        workload,
        actualCapacity: { cpuUnits: 2.5, memoryGiB: 10 }
    }), 200_000);
    assert.equal(resolveMachineExecutionTimeoutMs({
        baseTimeoutMs: 100_000,
        workload,
        actualCapacity: { cpuUnits: 10, memoryGiB: 2.5 }
    }), 200_000);
});

test('machine-specific absolute step declarations fail closed', () =>
{
    for (const resources of [
        { cpuUnits: 2, memoryWeight: 1 },
        { cpuWeight: 1, memoryGiB: 2 }
    ])
    {
        assert.throws(
            () => resolveBundleSteps('any', [{ id: 'invalid', resources }], { cpuUnits: 8, memoryGiB: 12 }),
            /machine-specific; declare weights instead/u
        );
    }
});

test('weighted DAG exposes independent failures together and blocks descendants', async () =>
{
    const ran = [];
    await assert.rejects(
        executeWeightedStepDag([
            { id: 'a', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
            { id: 'b', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
            { id: 'blocked', dependsOn: ['a'], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
        ], { maxParallel: 2, cpuUnits: 2, memoryGiB: 4 }, async (step) =>
        {
            ran.push(step.id);
            if (step.id !== 'blocked')
            {
                throw new Error(step.id);
            }
        }),
        (error) => error instanceof AggregateError && error.errors.length === 2
    );
    assert.deepEqual(ran.sort(), ['a', 'b']);
});

test('weighted DAG propagates a failed dependency through reverse-ordered descendants', async () =>
{
    const ran = [];
    await assert.rejects(
        executeWeightedStepDag([
            { id: 'tail', dependsOn: ['middle'], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
            { id: 'middle', dependsOn: ['root'], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
            { id: 'root', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
        ], { maxParallel: 1, cpuUnits: 1, memoryGiB: 1 }, async (step) =>
        {
            ran.push(step.id);
            throw new Error('root failed');
        }),
        /root failed/u
    );
    assert.deepEqual(ran, ['root']);
});
