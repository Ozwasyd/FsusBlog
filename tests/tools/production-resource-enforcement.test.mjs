import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createProductionResourceEnforcer,
    dockerResourceArguments,
    partitionContainerResourceGrant,
    resolveCgroupLimits,
    resolveProductionCgroupCapabilities
} from '../../tools/test-matrix/production-resource-enforcement.mjs';
import { runDag } from '../../tools/test-matrix/scheduler.mjs';

function fakeCgroup()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-cgroup-v2-'));
    const mountRoot = path.join(root, 'cgroup');
    const delegateRoot = path.join(mountRoot, 'delegated');
    fs.mkdirSync(delegateRoot, { recursive: true });
    const prepareDirectory = (directory) =>
    {
        for (const [name, value] of Object.entries({
            'cgroup.controllers': 'cpu memory pids',
            'cgroup.subtree_control': '',
            'cgroup.procs': '',
            'cpu.weight': '100',
            'cpu.max': 'max 100000',
            'cpu.stat': 'usage_usec 10\nnr_periods 2\nnr_throttled 1\nthrottled_usec 3',
            'cpu.pressure': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0',
            'memory.high': 'max',
            'memory.max': 'max',
            'memory.current': '1048576',
            'memory.events': 'low 0\nhigh 2\nmax 0\noom 1\noom_kill 1',
            'memory.pressure': 'some avg10=0.01 avg60=0.00 avg300=0.00 total=5',
            'pids.current': '1',
            'pids.max': 'max',
            'pids.events': 'max 0'
        }))
        {
            const file = path.join(directory, name);
            if (!fs.existsSync(file))
            {
                fs.writeFileSync(file, value);
            }
        }
    };
    prepareDirectory(delegateRoot);
    return { root, mountRoot, delegateRoot, prepareDirectory };
}

test('capability probe distinguishes cgroup v2 delegation from unsupported platforms', () =>
{
    const fixture = fakeCgroup();
    const available = resolveProductionCgroupCapabilities({
        platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot
    });
    assert.equal(available.status, 'available');
    assert.deepEqual(available.controllers, ['cpu', 'memory', 'pids']);
    fs.writeFileSync(path.join(fixture.delegateRoot, 'cgroup.controllers'), 'cpu memory');
    const missing = resolveProductionCgroupCapabilities({
        platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot
    });
    assert.equal(missing.status, 'unavailable');
    assert.equal(missing.reason, 'controllers-missing:pids');
    assert.equal(resolveProductionCgroupCapabilities({ platform: 'darwin' }).reason, 'non-linux');
    fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('dynamic grants update effective CPU, memory and pids controls without restarting the bundle', async () =>
{
    const fixture = fakeCgroup();
    const enforcer = await createProductionResourceEnforcer({
        runId: 'run-1', bundleIds: ['frontend-tests'], mode: 'strict',
        machine: { cpuUnits: 8, memoryGiB: 16 },
        platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot,
        prepareDirectory: fixture.prepareDirectory,
        removeDirectory: (directory) => fs.rmSync(directory, { recursive: true })
    });
    assert.equal(enforcer.mode, 'enforced');
    const first = enforcer.update('frontend-tests', { cpuUnits: 2, memoryGiB: 3 });
    await enforcer.attach('frontend-tests', 4242);
    assert.equal(fs.readFileSync(path.join(first.cgroupPath, 'cgroup.procs'), 'utf8'), '4242');
    assert.equal(fs.readFileSync(path.join(first.cgroupPath, 'cpu.max'), 'utf8'), first.cpuMax);
    const expanded = enforcer.update('frontend-tests', { cpuUnits: 5, memoryGiB: 7 });
    assert.notEqual(expanded.cpuMax, first.cpuMax);
    assert.equal(fs.readFileSync(path.join(first.cgroupPath, 'memory.high'), 'utf8'), String(expanded.memoryHighBytes));
    const evidence = enforcer.sample();
    assert.equal(evidence.bundles['frontend-tests'].grants.length, 2);
    assert.equal(evidence.bundles['frontend-tests'].samples.at(-1).cpuStat.nr_throttled, 1);
    assert.equal(evidence.bundles['frontend-tests'].samples.at(-1).memoryEvents.oom_kill, 1);
    assert.match(evidence.bundles['frontend-tests'].samples.at(-1).memoryPressure, /avg10=0\.01/u);
    fs.writeFileSync(path.join(first.cgroupPath, 'cgroup.procs'), '');
    assert.equal(enforcer.cleanup().status, 'removed');
    fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('hard CPU ceiling prevents a sibling from consuming more CPUs than its grant', () =>
{
    const one = resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16 });
    const four = resolveCgroupLimits({ cpuUnits: 4, memoryGiB: 4 }, { cpuUnits: 8, memoryGiB: 16 });
    const machineMemoryGiB = 12.799172019958496;
    const roundedSameMemoryGrantGiB = 12.799172019958498;
    const ratio = (limit) =>
    {
        const [quota, period] = limit.cpuMax.split(' ').map(Number);
        return quota / period;
    };
    assert.equal(ratio(one), 1);
    assert.equal(ratio(four), 4);
    for (const cpuUnits of [0.123456, 0.333333, 0.666667, 1.23456789, 2.7182818])
    {
        const fractional = resolveCgroupLimits({ cpuUnits, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16 });
        assert.ok(ratio(fractional) <= cpuUnits, 'quota quantization must not enlarge the CPU grant');
    }
    assert.ok(one.cpuWeight < four.cpuWeight);
    assert.ok(one.memoryMaxBytes > one.memoryHighBytes);
    assert.equal(one.cpuset, null);
    assert.equal(
        resolveCgroupLimits(
            { cpuUnits: 8 + Number.EPSILON * 8, memoryGiB: roundedSameMemoryGrantGiB },
            { cpuUnits: 8, memoryGiB: machineMemoryGiB }
        ).memoryHighBytes,
        Math.floor(Math.round(machineMemoryGiB * 1024 ** 3) / one.memoryPageBytes) * one.memoryPageBytes
    );
    assert.throws(
        () => resolveCgroupLimits({ cpuUnits: 9, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16 }),
        /CPU grant 9 exceeds machine envelope 8/u
    );
    assert.throws(
        () => resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 17 }, { cpuUnits: 8, memoryGiB: 16 }),
        /memory grant 17 GiB exceeds machine envelope 16 GiB/u
    );
    assert.throws(
        () => resolveCgroupLimits(
            { cpuUnits: 1, memoryGiB: machineMemoryGiB + 2 / (1024 ** 3) },
            { cpuUnits: 8, memoryGiB: machineMemoryGiB }
        ),
        /memory grant .* exceeds machine envelope/u
    );
});

test('active cgroups are retained while cancellation cleanup removes empty owned groups', async () =>
{
    const fixture = fakeCgroup();
    const enforcer = await createProductionResourceEnforcer({
        runId: 'cancel-run', bundleIds: ['runtime-browser'], mode: 'strict',
        machine: { cpuUnits: 4, memoryGiB: 8 },
        platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot,
        prepareDirectory: fixture.prepareDirectory,
        removeDirectory: (directory) => fs.rmSync(directory, { recursive: true })
    });
    const limits = enforcer.update('runtime-browser', { cpuUnits: 2, memoryGiB: 2 });
    await enforcer.attach('runtime-browser', 99);
    assert.equal(enforcer.cleanup().status, 'retained-active');
    fs.writeFileSync(path.join(limits.cgroupPath, 'cgroup.procs'), '');
    assert.equal(enforcer.cleanup().status, 'removed');
    fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('unexpected scheduler failure still removes its empty enforced hierarchy', async () =>
{
    const fixture = fakeCgroup();
    await assert.rejects(() => runDag({
        tiers: [{
            id: 'failing-hook',
            command: `${process.execPath} -e "process.exit(0)"`,
            dependsOn: [],
            services: [],
            parallelizable: true,
            exclusiveResources: [],
            phase: 0,
            resourceClass: 'cpu',
            maxParallel: 1,
            cpuUnits: 1,
            memoryGiB: 0.25,
            cacheInputs: ['tools/**'],
            executionKey: 'test/failing-hook',
            executionVariant: 'ordinary',
            coverage: ['ordinary-unit']
        }],
        root: fixture.root,
        runsRoot: path.join(fixture.root, 'runs'),
        runId: 'unexpected-failure',
        maxParallel: 1,
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} }),
        executeTier: async () => ({ code: 0, signal: null }),
        onTierStart: () =>
        {
            throw new Error('synthetic scheduler hook failure');
        },
        resourceEnforcementMode: 'strict',
        resourceEnforcementOptions: {
            platform: 'linux',
            mountRoot: fixture.mountRoot,
            mountType: 'cgroup2fs',
            delegateRoot: fixture.delegateRoot,
            prepareDirectory: fixture.prepareDirectory,
            removeDirectory: (directory) => fs.rmSync(directory, { recursive: true })
        }
    }), /synthetic scheduler hook failure/u);
    assert.equal(fs.existsSync(path.join(
        fixture.delegateRoot,
        'fsusblog-production',
        'unexpected-failure'
    )), false);
    fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('strict mode fails closed while auto and advisory modes expose degradation', async () =>
{
    const options = {
        runId: 'unsupported', bundleIds: ['bundle'], machine: { cpuUnits: 2, memoryGiB: 2 }, platform: 'darwin'
    };
    await assert.rejects(() => createProductionResourceEnforcer({ ...options, mode: 'strict' }), /strict cgroup enforcement unavailable/u);
    const advisory = await createProductionResourceEnforcer({ ...options, mode: 'auto' });
    assert.equal(advisory.mode, 'advisory');
    assert.equal(advisory.evidence().status, 'unsupported');
    assert.equal(advisory.evidence().reason, 'non-linux');
});

test('Docker OCI arguments bind the current run, bundle and step to equivalent limits', () =>
{
    const args = dockerResourceArguments({
        FSUSBLOG_DOCKER_CPU_UNITS: '2.5',
        FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES: '1000',
        FSUSBLOG_DOCKER_MEMORY_MAX_BYTES: '1200',
        FSUSBLOG_DOCKER_PIDS_MAX: '64',
        FSUSBLOG_TEST_RUN_ID: 'run',
        FSUSBLOG_PHYSICAL_BUNDLE_ID: 'runtime-browser',
        FSUSBLOG_STEP_ID: 'bootstrap'
    });
    assert.deepEqual(args.slice(0, 8), ['--cpus', '2.5', '--memory-reservation', '1000', '--memory', '1200', '--pids-limit', '64']);
    assert.ok(args.includes('io.fsusblog.test.run-id=run'));
    assert.ok(args.includes('io.fsusblog.test.bundle-id=runtime-browser'));
    assert.ok(args.includes('io.fsusblog.test.step-id=bootstrap'));
    assert.ok(args.includes('io.fsusblog.test.cpu-units=2.5'));
    assert.ok(args.includes('io.fsusblog.test.memory-max-bytes=1200'));
    assert.deepEqual(dockerResourceArguments({}), []);
    assert.throws(() => dockerResourceArguments({
        FSUSBLOG_DOCKER_CPU_UNITS: '1'
    }), /requires a complete/u);
    assert.throws(() => dockerResourceArguments({
        FSUSBLOG_DOCKER_CPU_UNITS: '1',
        FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES: '1200',
        FSUSBLOG_DOCKER_MEMORY_MAX_BYTES: '1000',
        FSUSBLOG_DOCKER_PIDS_MAX: '64',
        FSUSBLOG_TEST_RUN_ID: 'run',
        FSUSBLOG_PHYSICAL_BUNDLE_ID: 'bundle',
        FSUSBLOG_STEP_ID: 'step'
    }), /grant is invalid/u);
    assert.throws(() => dockerResourceArguments({
        FSUSBLOG_DOCKER_CPU_UNITS: '1',
        FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES: '1000',
        FSUSBLOG_DOCKER_MEMORY_MAX_BYTES: '1200',
        FSUSBLOG_DOCKER_PIDS_MAX: '64'
    }), /requires run, bundle, and step identity/u);
});

test('production wiring attaches a stopped bundle before resume and propagates OCI limits', () =>
{
    const scheduler = fs.readFileSync('tools/test-matrix/scheduler.mjs', 'utf8');
    const bundle = fs.readFileSync('tools/test/bundles/run-bundle.mjs', 'utf8');
    const bootstrap = fs.readFileSync('tools/bootstrap-acceptance-env.sh', 'utf8');
    const postgresFixture = fs.readFileSync('tests/backend/Fixtures/PostgresSchemaMigrationFixture.cs', 'utf8');
    const backendShards = fs.readFileSync('tools/test/run-backend-production-shards.mjs', 'utf8');
    assert.match(scheduler, /kill -STOP \$\$; exec "\$@"[\s\S]*?resourceEnforcer\.attach[\s\S]*?execution\.resume/u);
    assert.match(scheduler, /writeActiveResourceGrants[\s\S]*?resourceEnforcer\.update/u);
    assert.match(scheduler, /scheduler interrupted by[\s\S]*?finalizeResourceEnforcer/u);
    assert.match(bundle, /FSUSBLOG_DOCKER_CPU_UNITS[\s\S]*?FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES[\s\S]*?FSUSBLOG_DOCKER_PIDS_MAX/u);
    assert.match(bundle, /docker', \['inspect'[\s\S]*?consistency/u);
/* eslint-disable @stylistic/indent, @stylistic/semi */
  assert.match(bootstrap, /DOCKER_RESOURCE_ARGS=\([\s\S]*?--cpus[\s\S]*?--memory-reservation[\s\S]*?--pids-limit/u)
  assert.match(bootstrap, /const dockerCpu = Math\.max\(0\.001, Math\.floor\(childCpu \* 1000\) \/ 1000\)/u)
  assert.match(bootstrap, /child\.FSUSBLOG_DOCKER_CPU_UNITS = String\(dockerCpu\)/u)
    /* eslint-enable @stylistic/indent, @stylistic/semi */
    assert.match(bootstrap, /bundleIdentity="\$\{FSUSBLOG_PHYSICAL_BUNDLE_ID:-standalone\}"/u);
    assert.match(bootstrap, /stepIdentity="\$\{FSUSBLOG_STEP_ID:-bootstrap\}"/u);
    assert.match(bootstrap, /docker update[\s\S]*?docker run -d/u);
    assert.match(postgresFixture, /BuildDockerResourceArguments[\s\S]*?io\.fsusblog\.test\.step-id/u);
    assert.match(postgresFixture, /BuildDockerResourceArguments[\s\S]*?--cpus[\s\S]*?--memory-reservation/u);
    assert.match(backendShards, /backendPartitionEnvironment[\s\S]*?dockerLimitEnvironment\(processors, memoryGiB, env\)/u);
});

function retainedMySqlRecoveryFixture()
{
    const controller = { pid: 123, processStartIdentity: 'original-start', executableDigest: 'sha256:' + 'a'.repeat(64), commandDigest: 'sha256:' + 'b'.repeat(64) };
    const binding = { root: '/owned/repository', runId: 'owned-run', namespace: 'owned-namespace',
        sourceState: { commit: 'c'.repeat(40), worktreeFingerprint: 'sha256:' + 'd'.repeat(64) },
        resourceBundleIds: ['backend-tests'], schedulerOwner: controller };
    const context = { root: binding.root, runId: binding.runId, namespace: binding.namespace,
        sourceState: { ...binding.sourceState }, bundleId: 'backend-tests', stepId: 'migration-services' };
    const record = { context, stateFile: '/owned/repository/retained/mysql/state.json',
        bindingDigest: 'sha256:' + 'e'.repeat(64), status: 'prepared' };
    const canonicalStateFile = record.stateFile;
    const calls = [];
    const lifecycle = {
        readRetainedMySqlFixtureLifecycle(value, digest)
        {
            calls.push('read');
            assert.deepEqual(value, context);
            assert.equal(digest, record.bindingDigest);
            return { paths: { stateFile: canonicalStateFile }, state: { controllerIdentity: controller } };
        },
        async recoverMySqlFixtureService(value, options)
        {
            calls.push('recover');
            assert.deepEqual(value, context);
            assert.equal(options.expectedBindingDigest, record.bindingDigest);
        },
        verifyMySqlFixtureServiceCleanup(value, options)
        {
            calls.push('verify');
            assert.deepEqual(value, context);
            assert.equal(options.expectedBindingDigest, record.bindingDigest);
            return { qualificationEligible: false, stateFile: record.stateFile,
                bindingDigest: record.bindingDigest, stateDigest: 'sha256:' + 'f'.repeat(64),
                cleanup: { containerAbsent: true, credentialsRemoved: true } };
        }
    };
    return { binding, allocations: { 'physical-backend-tests': record }, record, context, controller, calls, lifecycle,
        assertRecovery: () => calls.push('guard') };
}

test('scheduler MySQL recovery proves both cleanup observations without qualifying execution', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const result = await reconcileRetainedMySqlFixtureServices(fixture);
    assert.deepEqual(fixture.calls.filter(value => value !== 'guard'), ['read', 'recover', 'verify']);
    assert.equal(result.length, 1);
    assert.equal(result[0].qualificationEligible, false);
    assert.deepEqual(result[0].cleanup, { containerAbsent: true, credentialsRemoved: true });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result[0]), true);
});


test('scheduler MySQL recovery rejects root before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.root = '/foreign';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects run before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.runId = 'foreign';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects namespace before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.namespace = 'foreign';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects source commit before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.sourceState.commit = '0'.repeat(40);
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects source fingerprint before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.sourceState.worktreeFingerprint = 'sha256:' + '0'.repeat(64);
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects bundle before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.bundleId = 'frontend';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects step before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.stepId = 'foreign';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects resource roster before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.binding.resourceBundleIds = [];
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects missing digest before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    delete fixture.record.bindingDigest;
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects unknown status before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.record.status = 'assumed';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects unknown field before touching a service', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.record.approved = true;
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /original run\/source\/resource binding/u);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects a foreign retained controller and duplicate allocation before cleanup', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    for (const key of ['pid', 'processStartIdentity', 'executableDigest', 'commandDigest'])
    {
        const fixture = retainedMySqlRecoveryFixture();
        fixture.binding.schedulerOwner = { ...fixture.controller, [key]: key === 'pid' ? 124 : 'foreign' };
        await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /foreign path, controller or duplicate identity/u);
        assert.equal(fixture.calls.includes('recover'), false);
    }
    const duplicate = retainedMySqlRecoveryFixture();
    duplicate.allocations.second = structuredClone(duplicate.record);
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(duplicate), /foreign path, controller or duplicate identity/u);
    assert.equal(duplicate.calls.includes('recover'), false);
});

test('scheduler MySQL recovery rejects incomplete cleanup and preserves the original lifecycle failure', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    for (const key of ['containerAbsent', 'credentialsRemoved'])
    {
        const fixture = retainedMySqlRecoveryFixture();
        const verify = fixture.lifecycle.verifyMySqlFixtureServiceCleanup;
        fixture.lifecycle.verifyMySqlFixtureServiceCleanup = (...args) =>
        {
            const observed = verify(...args);
            observed.cleanup[key] = false;
            return observed;
        };
        await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), /prove exact container and credential cleanup/u);
    }
    const failed = retainedMySqlRecoveryFixture();
    const original = new Error('owned container still present');
    failed.lifecycle.recoverMySqlFixtureService = async () =>
    {
        throw original;
    };
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(failed), error => error === original);
    assert.equal(failed.calls.includes('verify'), false);
});

test('scheduler MySQL recovery requires the held guard and treats no allocation as zero work', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices({ ...fixture, assertRecovery: undefined }), /acquired recovery guard/u);
    const original = new Error('recovery lease lost');
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices({ ...fixture, assertRecovery: () =>
    {
        throw original;
    } }), error => error === original);
    assert.deepEqual(await reconcileRetainedMySqlFixtureServices({ ...fixture, allocations: undefined }), []);
    assert.deepEqual(await reconcileRetainedMySqlFixtureServices({ ...fixture, allocations: {} }), []);
    assert.equal(fixture.calls.includes('recover'), false);
});

test('scheduler MySQL recovery supports the independent standalone resource identity without adopting it', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    fixture.context.bundleId = 'matrix:backend-unit';
    fixture.binding.resourceBundleIds = ['backend-unit'];
    const results = await reconcileRetainedMySqlFixtureServices(fixture);
    assert.equal(results[0].qualificationEligible, false);
    assert.equal(fixture.context.bundleId, 'matrix:backend-unit');
});

test('scheduler MySQL recovery preflights foreign paths and later allocations before any cleanup', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const foreignPath = retainedMySqlRecoveryFixture();
    foreignPath.record.stateFile = '/foreign/state.json';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(foreignPath), /foreign path/u);
    assert.equal(foreignPath.calls.includes('recover'), false);
    const later = retainedMySqlRecoveryFixture();
    later.allocations.second = structuredClone(later.record);
    later.allocations.second.context.runId = 'foreign';
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(later), /original run\/source\/resource binding/u);
    assert.equal(later.calls.includes('recover'), false);
});

test('scheduler MySQL recovery refuses a lease lost during cleanup without accepting its result', async () =>
{
    const { reconcileRetainedMySqlFixtureServices } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const original = new Error('held scheduler recovery lease changed');
    let held = true;
    fixture.assertRecovery = () =>
    {
        if (!held)
        {
            throw original;
        }
    };
    fixture.lifecycle.recoverMySqlFixtureService = async () =>
    {
        fixture.calls.push('recover');
        held = false;
    };
    await assert.rejects(() => reconcileRetainedMySqlFixtureServices(fixture), error => error === original);
    assert.equal(fixture.calls.includes('verify'), false);
});

test('scheduler MySQL recovery completion reobserves the exact state before grant release and seals replay', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = await reconcileRetainedMySqlFixtureServices(fixture);
    fixture.calls.length = 0;
    assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records });
    assert.deepEqual(fixture.calls, ['verify']);
    fixture.record.status = 'cleaned';
    fixture.record.cleanup = { containerAbsent: true, credentialsRemoved: true };
    assertRetainedMySqlFixtureRecoveryComplete({ allocations: fixture.allocations, records: structuredClone(records), requireCleaned: true });
    assert.deepEqual(fixture.calls, ['verify'], 'durable replay validation must not claim a new live observation');
});


test('scheduler MySQL recovery completion rejects absent proof before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records.length = 0;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects foreign tier before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].tierId = 'foreign';
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects foreign path before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].stateFile = '/foreign/state.json';
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects foreign digest before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].bindingDigest = 'sha256:' + '0'.repeat(64);
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects missing state digest before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    delete records[0].stateDigest;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects missing container absence before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].cleanup.containerAbsent = false;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects missing credential removal before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].cleanup.credentialsRemoved = false;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects forged qualification before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].qualificationEligible = true;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects unknown proof field before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].approved = true;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects unknown cleanup field before live verification', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = structuredClone(await reconcileRetainedMySqlFixtureServices(fixture));
    fixture.calls.length = 0;
    records[0].cleanup.approved = true;
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /MySQL scheduler recovery completion/u);
    assert.deepEqual(fixture.calls, []);
});

test('scheduler MySQL recovery completion rejects stale cleanup observations and preserves observer failures', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    for (const mutate of [
        observed => observed.stateDigest = 'sha256:' + '0'.repeat(64),
        observed => observed.stateFile = '/foreign/state.json',
        observed => observed.bindingDigest = 'sha256:' + '0'.repeat(64),
        observed => observed.cleanup.containerAbsent = false,
        observed => observed.cleanup.credentialsRemoved = false,
        observed => observed.qualificationEligible = true
    ])
    {
        const fixture = retainedMySqlRecoveryFixture();
        const records = await reconcileRetainedMySqlFixtureServices(fixture);
        const verify = fixture.lifecycle.verifyMySqlFixtureServiceCleanup;
        fixture.lifecycle.verifyMySqlFixtureServiceCleanup = (...args) =>
        {
            const observed = verify(...args);
            mutate(observed);
            return observed;
        };
        assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), /changed before grant release/u);
    }
    const fixture = retainedMySqlRecoveryFixture();
    const records = await reconcileRetainedMySqlFixtureServices(fixture);
    const original = new Error('Docker daemon identity no longer matches');
    fixture.lifecycle.verifyMySqlFixtureServiceCleanup = () =>
    {
        throw original;
    };
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records }), error => error === original);
});

test('scheduler MySQL recovery completion rejects incomplete durable cleanup and malformed rosters', async () =>
{
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const records = await reconcileRetainedMySqlFixtureServices(fixture);
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records, requireCleaned: true }), /crosses its retained allocation/u);
    fixture.record.status = 'cleaned';
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ ...fixture, records, requireCleaned: true }), /crosses its retained allocation/u);
    for (const allocations of [null, [], 'foreign'])
    {
        assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ allocations, records: [] }), /retained allocation map/u);
    }
    for (const value of [undefined, null, {}])
    {
        assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ allocations: undefined, records: value }), /allocation roster/u);
    }
    const duplicate = structuredClone(records);
    duplicate.push(structuredClone(duplicate[0]));
    assert.throws(() => assertRetainedMySqlFixtureRecoveryComplete({ allocations: { ...fixture.allocations, second: fixture.record }, records: duplicate }), /invalid cleanup proof/u);
    assertRetainedMySqlFixtureRecoveryComplete({ allocations: undefined, records: [] });
});

test('container partition conserves one CPU, memory and PID envelope and rejects oversold shares', () =>
{
    const machine = { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 };
    const grant = { cpuUnits: 4, memoryGiB: 4 };
    const limits = { cpuUnits: 1, memoryHighBytes: 512 * 1024 ** 2,
        memoryMaxBytes: 576 * 1024 ** 2, pidsMax: 128 };
    const allocation = partitionContainerResourceGrant(grant, [limits, limits], machine);
    assert.equal(allocation.process.cpuUnits, 2);
    for (const key of ['memoryMaxBytes', 'pidsMax'])
    {
        assert.equal(allocation.process[key] + allocation.reserved[key], allocation.total[key], key);
    }
    assert.ok(allocation.process.memoryHighBytes + allocation.reserved.memoryHighBytes
        <= allocation.total.memoryHighBytes);
    assert.ok(allocation.process.memoryHighBytes <= allocation.process.memoryMaxBytes);
    const asymmetric = partitionContainerResourceGrant({ cpuUnits: 2, memoryGiB: 2.43 }, [{
        cpuUnits: 1, memoryHighBytes: 512 * 1024 ** 2,
        memoryMaxBytes: 1024 * 1024 ** 2, pidsMax: 128
    }], machine);
    assert.equal(asymmetric.process.memoryHighBytes, asymmetric.process.memoryMaxBytes);
    assert.ok(asymmetric.process.memoryHighBytes + asymmetric.reserved.memoryHighBytes
        < asymmetric.total.memoryHighBytes);
    assert.equal(asymmetric.process.memoryMaxBytes + asymmetric.reserved.memoryMaxBytes,
        asymmetric.total.memoryMaxBytes);
    assert.deepEqual(partitionContainerResourceGrant(grant, [], machine).process, resolveCgroupLimits(grant, machine));
    for (const invalid of [{ ...limits, cpuUnits: 4 }, { ...limits, memoryMaxBytes: 5 * 1024 ** 3 },
        { ...limits, memoryHighBytes: limits.memoryHighBytes - 1 }, { ...limits, pidsMax: 8192 },
        { ...limits, extra: true }])
    {
        assert.throws(() => partitionContainerResourceGrant(grant, [invalid], machine));
    }
});

test('memory grants project downward to the kernel page size without enlarging the admitted envelope', () =>
{
    for (const pageBytes of [4096, 16384, 65536])
    {
        const machine = { cpuUnits: 8, memoryGiB: 16.000001, memoryPageBytes: pageBytes };
        for (const memoryGiB of [2.000001, machine.memoryGiB])
        {
            const limits = resolveCgroupLimits({ cpuUnits: 2, memoryGiB }, machine);
            assert.equal(limits.memoryPageBytes, pageBytes);
            assert.equal(limits.memoryHighBytes % pageBytes, 0);
            assert.equal(limits.memoryMaxBytes % pageBytes, 0);
            assert.ok(limits.memoryHighBytes <= memoryGiB * 1024 ** 3);
            assert.ok(limits.memoryMaxBytes <= machine.memoryGiB * 1024 ** 3);
            assert.ok(limits.memoryHighBytes <= limits.memoryMaxBytes);
        }
    }
    const exact = resolveCgroupLimits({ cpuUnits: 2, memoryGiB: 2 }, {
        cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096
    });
    assert.equal(exact.memoryHighBytes, 2147483648);
    assert.equal(exact.memoryMaxBytes, 2337292288);
    for (const pageBytes of [0, -1, 1000, NaN, '4096', 2 ** 25])
    {
        assert.throws(() => resolveCgroupLimits({ cpuUnits: 2, memoryGiB: 2 }, {
            cpuUnits: 8, memoryGiB: 16, memoryPageBytes: pageBytes
        }), /page size/u);
    }
});

function fakeSystemdBoundary(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-systemd-resource-owner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const context = { root, runId: 'run', namespace: 'production', bundleId: 'worker',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
        schedulerOwnerToken: '11111111-1111-4111-8111-111111111111' };
    const events = [];
    const runtime = { uid: process.getuid(), memoryPageBytes: 4096, busId: 'c'.repeat(32), busOwner: ':1.2',
        controlGroup: `/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service`, cgroup: { path: root } };
    let unit = null;
    let group = null;
    let launcherUnit = null;
    let launcherGroup = null;
    const launcherProcess = { status: 'verified', schema: 'fsusblog.process-identity.v1', pid: 4242,
        processStartIdentity: 'fake:start:1', executablePath: '/fake/launcher', executableDigest: `sha256:${'1'.repeat(64)}`,
        commandDigest: `sha256:${'2'.repeat(64)}` };
    const launcherObservation = { stopped: true, controlGroup: '/original-launcher-group' };
    let artifactContents = '';
    let controllerStatus = 'live';
    let reference;
    const absent = () => ({ LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', ControlGroup: '',
        Description: 'Implicit slice', Transient: 'no', FragmentPath: '', DropInPaths: '', InvocationID: '' });
    const transport = {
        runtimeIdentity: () => structuredClone(runtime),
        inspect: (name) => structuredClone((name.endsWith('.scope') ? launcherUnit : unit) ?? absent()),
        cgroup(controlGroup, { readControls = true } = {})
        {
            if (controlGroup === launcherUnit?.ControlGroup)
            {
                assert.equal(readControls, false, 'a launcher scope inherits parent limits without requiring leaf control files');
                return structuredClone(launcherGroup);
            }
            assert.equal(readControls, true, 'the shared parent still requires every exact control');
            return structuredClone(group);
        },
        artifacts: (observed) => [{ path: observed.FragmentPath,
            contentDigest: `sha256:${createHash('sha256').update(observed.Description).digest('hex')}` },
        ...observed.DropInPaths.split(' ').filter(Boolean).map((file) => ({ path: file,
            contentDigest: `sha256:${createHash('sha256').update(artifactContents).digest('hex')}` }))],
        start(name, description)
        {
            events.push('start');
            assert.ok(reference, 'independent retention must happen before unit creation');
            const owner = JSON.parse(fs.readFileSync(reference.ownerFile, 'utf8'));
            const state = JSON.parse(fs.readFileSync(path.join(path.dirname(reference.ownerFile), 'state.json'), 'utf8'));
            assert.equal(owner.bindingDigest, reference.bindingDigest);
            assert.equal(state.phase, 'create-attempted');
            const directory = path.join(root, name);
            fs.mkdirSync(directory);
            const stat = fs.statSync(directory);
            unit = { ...absent(), ActiveState: 'active', SubState: 'active', Description: description,
                Transient: 'yes', InvocationID: 'd'.repeat(32), ControlGroup: `${runtime.controlGroup}/${name}`,
                FragmentPath: `/run/user/${process.getuid()}/systemd/transient/${name}` };
            group = { path: directory, device: stat.dev, inode: stat.ino, populated: false, children: [], processIds: [],
                controls: { 'cpu.max': 'max 100000', 'cpu.weight': '100', 'memory.high': 'max', 'memory.max': 'max', 'pids.max': 'max' } };
        },
        stoppedProcess(identity)
        {
            assert.deepEqual(identity, launcherProcess, 'launcher identity must match');
            if (!launcherObservation.stopped)
            {
                throw new Error('launcher must remain stopped');
            }
            return { controlGroup: launcherObservation.controlGroup };
        },
        startLauncher(name, description, slice, identity)
        {
            events.push('start-launcher');
            const state = JSON.parse(fs.readFileSync(path.join(path.dirname(reference.ownerFile), 'state.json'), 'utf8'));
            assert.equal(state.launcher.phase, 'attach-attempted');
            assert.deepEqual(state.launcher.processIdentity, launcherProcess);
            assert.equal(unit.ControlGroup, `${runtime.controlGroup}/${slice}`);
            const directory = path.join(group.path, name);
            fs.mkdirSync(directory);
            const stat = fs.statSync(directory);
            launcherUnit = { ...absent(), ActiveState: 'active', SubState: 'running', Description: description,
                Transient: 'yes', InvocationID: 'e'.repeat(32), ControlGroup: `${unit.ControlGroup}/${name}`,
                FragmentPath: `/run/user/${process.getuid()}/systemd/transient/${name}` };
            launcherGroup = { path: directory, device: stat.dev, inode: stat.ino, populated: true, children: [], processIds: [identity.pid] };
            launcherObservation.controlGroup = launcherUnit.ControlGroup;
            group.children.push(name);
            group.populated = true;
        },
        setLimits(_name, limits)
        {
            events.push('set');
            group.controls = { 'cpu.max': limits.cpuMax, 'cpu.weight': String(limits.cpuWeight),
                'memory.high': String(limits.memoryHighBytes), 'memory.max': String(limits.memoryMaxBytes), 'pids.max': String(limits.pidsMax) };
            artifactContents = JSON.stringify(group.controls);
            unit.DropInPaths = ['CPUQuota', 'CPUQuotaPeriodSec', 'CPUWeight', 'MemoryHigh', 'MemoryMax', 'TasksMax']
                .map((name) => `${unit.FragmentPath}.d/50-${name}.conf`).join(' ');
        },
        stop(name)
        {
            if (name.endsWith('.scope'))
            {
                events.push('stop-launcher');
                assert.equal(launcherGroup.populated, false);
                fs.rmdirSync(launcherGroup.path);
                group.children = group.children.filter((child) => child !== name);
                launcherUnit = null;
                launcherGroup = null;
                return;
            }
            events.push('stop');
            fs.rmdirSync(group.path);
            unit = null;
            group = null;
        }
    };
    const options = {
        transport, startupBudgetMs: 1000,
        observeController: () => ({ status: controllerStatus }),
        async retainBinding(value)
        {
            reference = value;
            events.push('retain');
            assert.equal(fs.statSync(value.ownerFile).mode & 0o777, 0o600);
            return { bindingDigest: value.bindingDigest };
        }
    };
    return { context, options, transport, events, runtime, launcherProcess, launcherObservation, get reference()
    {
        return reference;
    },
    get unit()
    {
        return unit;
    }, get group()
    {
        return group;
    }, get launcherUnit()
    {
        return launcherUnit;
    }, get launcherGroup()
    {
        return launcherGroup;
    },
    setControllerStatus(value)
    {
        controllerStatus = value;
    } };
}

function systemdEnforcerFixture(t)
{
    const fixture = fakeSystemdBoundary(t);
    const synchronizeControls = () =>
    {
        for (const [name, value] of Object.entries(fixture.group.controls))
        {
            fs.writeFileSync(path.join(fixture.group.path, name), value);
        }
    };
    const start = fixture.transport.start;
    fixture.transport.start = (...args) =>
    {
        start(...args);
        synchronizeControls();
    };
    const setLimits = fixture.transport.setLimits;
    fixture.transport.setLimits = (...args) =>
    {
        setLimits(...args);
        synchronizeControls();
    };
    const stop = fixture.transport.stop;
    fixture.transport.stop = (name) =>
    {
        if (name.endsWith('.slice'))
        {
            for (const control of Object.keys(fixture.group.controls))
            {
                fs.unlinkSync(path.join(fixture.group.path, control));
            }
        }
        stop(name);
    };
    const context = { ...fixture.context };
    delete context.bundleId;
    const options = { runId: context.runId, bundleIds: [fixture.context.bundleId], mode: 'strict',
        machine: { cpuUnits: 8, memoryGiB: 16 }, systemdTransport: fixture.transport,
        observeSystemdController: fixture.options.observeController,
        systemdBoundary: { context, retainBinding: fixture.options.retainBinding, commandBudgetMs: 1000, startupBudgetMs: 1000 } };
    return { fixture, options };
}

test('systemd container reservation retains the original grant until exact cleanup', async (t) =>
{
    const { fixture, options } = systemdEnforcerFixture(t);
    options.observeContainerReservationProcess = () => fixture.launcherProcess;
    options.readContainerReservationProcessCgroup = () => `0::${fixture.launcherUnit.ControlGroup}\n`;
    const enforcer = await createProductionResourceEnforcer(options);
    const bundleId = fixture.context.bundleId;
    const initial = enforcer.update(bundleId, { cpuUnits: 4, memoryGiB: 4 });
    await enforcer.attach(bundleId, fixture.launcherProcess.pid, fixture.launcherProcess);
    const identity = { root: fixture.context.root, runId: fixture.context.runId,
        namespace: fixture.context.namespace, bundleId: `matrix:${bundleId}`, stepId: 'migration-services',
        sourceState: fixture.context.sourceState };
    const limits = { cpuUnits: 1, memoryHighBytes: 512 * 1024 ** 2,
        memoryMaxBytes: 576 * 1024 ** 2, pidsMax: 128 };
    const request = { id: 'mysql', identity, limits };
    const context = { ...structuredClone(identity), resourceGrant: { ...limits } };
    const lease = enforcer.reserveContainerResources(bundleId, request);
    assert.equal(lease.assertHeld(context).process.cpuUnits, 3);
    assert.equal(enforcer.evidence().bundles[bundleId].allocation.total.cpuUnits, 4);
    assert.equal(enforcer.cleanup().status, 'retained-container-reservations');
    const expanded = enforcer.update(bundleId, { cpuUnits: 6, memoryGiB: 6 });
    assert.equal(expanded.cpuUnits, 5);
    assert.equal(lease.assertHeld(context).total.cpuUnits, 6);
    const prior = fs.readFileSync(path.join(initial.cgroupPath, 'cpu.max'), 'utf8');
    assert.throws(() => enforcer.update(bundleId, { cpuUnits: 1, memoryGiB: 6 }), /process share/u);
    assert.equal(fs.readFileSync(path.join(initial.cgroupPath, 'cpu.max'), 'utf8'), prior);
    await assert.rejects(lease.releaseAfterCleanup(async () => ({ containerAbsent: false, credentialsRemoved: true })),
        /complete lifecycle cleanup/u);
    assert.equal(lease.snapshot().held, true);
    await lease.releaseAfterCleanup(async () => ({ containerAbsent: true, credentialsRemoved: true }));
    assert.equal(enforcer.evidence().bundles[bundleId].allocation.process.cpuUnits, 6);
    assert.throws(() => lease.assertHeld(context), /absent or crosses/u);
    assert.throws(() => enforcer.reserveContainerResources(bundleId, request), /cannot be reused/u);
    fixture.launcherGroup.populated = false;
    fixture.launcherGroup.processIds = [];
    fixture.group.populated = false;
    assert.equal(enforcer.cleanup().status, 'removed');
});

test('systemd container reservation rejects crossed source, process and controls', async (t) =>
{
    const { fixture, options } = systemdEnforcerFixture(t);
    let observedIdentity = fixture.launcherProcess;
    options.observeContainerReservationProcess = () => observedIdentity;
    options.readContainerReservationProcessCgroup = () => `0::${fixture.launcherUnit.ControlGroup}\n`;
    const enforcer = await createProductionResourceEnforcer(options);
    const bundleId = fixture.context.bundleId;
    enforcer.update(bundleId, { cpuUnits: 4, memoryGiB: 4 });
    await enforcer.attach(bundleId, fixture.launcherProcess.pid, fixture.launcherProcess);
    const identity = { root: fixture.context.root, runId: fixture.context.runId,
        namespace: fixture.context.namespace, bundleId: `matrix:${bundleId}`, stepId: 'migration-services',
        sourceState: fixture.context.sourceState };
    const limits = { cpuUnits: 1, memoryHighBytes: 512 * 1024 ** 2,
        memoryMaxBytes: 576 * 1024 ** 2, pidsMax: 128 };
    const request = { id: 'mysql', identity, limits };
    assert.throws(() => enforcer.reserveContainerResources(bundleId, { ...request,
        identity: { ...identity, sourceState: { ...identity.sourceState, commit: 'f'.repeat(40) } } }), /exact producer\/source/u);
    const lease = enforcer.reserveContainerResources(bundleId, request);
    assert.throws(() => lease.assertHeld({ ...identity, resourceGrant: { ...limits, pidsMax: 127 } }), /absent or crosses/u);
    observedIdentity = { ...fixture.launcherProcess, processStartIdentity: 'reused-pid' };
    assert.throws(() => lease.assertHeld({ ...identity, resourceGrant: limits }), /live attached/u);
    observedIdentity = fixture.launcherProcess;
    fixture.group.controls['cpu.max'] = 'max 100000';
    assert.throws(() => lease.assertHeld({ ...identity, resourceGrant: limits }), /controls changed|effective process controls/u);
});

test('systemd container reservation binds the independently retained managed service before admission', async (t) =>
{
    const { fixture, options } = systemdEnforcerFixture(t);
    const processIdentity = fixture.launcherProcess;
    let serviceBinding;
    options.observeContainerReservationProcess = () => processIdentity;
    options.readContainerReservationProcessCgroup = () => `0::${serviceBinding.identity.controlGroup}\n`;
    options.inspectContainerReservationService = (binding) =>
    {
        assert.deepEqual(binding, serviceBinding);
        return { status: 'present', unit: { ActiveState: 'active' },
            group: { processIds: [processIdentity.pid] }, identity: serviceBinding.identity };
    };
    const enforcer = await createProductionResourceEnforcer(options);
    const bundleId = fixture.context.bundleId;
    enforcer.update(bundleId, { cpuUnits: 4, memoryGiB: 4 });
    const identity = { root: fixture.context.root, runId: fixture.context.runId,
        namespace: fixture.context.namespace, bundleId: `matrix:${bundleId}`, stepId: 'migration-services',
        sourceState: fixture.context.sourceState };
    const limits = { cpuUnits: 1, memoryHighBytes: 512 * 1024 ** 2,
        memoryMaxBytes: 576 * 1024 ** 2, pidsMax: 128 };
    const lease = enforcer.reserveContainerResources(bundleId, { id: 'mysql', identity, limits });
    const reference = fixture.reference;
    const serviceIdentity = { unitName: 'fsusblog-physical-test.service',
        controlGroup: `${fixture.unit.ControlGroup}/fsusblog-physical-test.service`,
        path: path.join(fixture.group.path, 'fsusblog-physical-test.service'),
        device: 1, inode: 2, invocationId: 'c'.repeat(32), artifacts: [] };
    serviceBinding = { reference, identity: serviceIdentity };
    const authority = { phase: 'pre-exec', authorityId: randomUUID(), serviceBinding,
        supervisorProcessIdentity: processIdentity };
    assert.throws(() => lease.assertHeld({ ...identity, resourceGrant: limits }), /one live attached/u);
    assert.throws(() => enforcer.bindManagedService(bundleId, processIdentity, { ...authority,
        serviceBinding: { ...serviceBinding, reference: { ...reference, bindingDigest: `sha256:${'f'.repeat(64)}` } } }),
    /retained process or resource owner/u);
    const binding = enforcer.bindManagedService(bundleId, processIdentity, authority);
    assert.equal(binding.pid, processIdentity.pid);
    assert.equal(lease.assertHeld({ ...identity, resourceGrant: limits }).process.cpuUnits, 3);
    assert.throws(() => enforcer.bindManagedService(bundleId, processIdentity, authority), /one live reserved/u);
    await lease.releaseAfterCleanup(async () => ({ containerAbsent: true, credentialsRemoved: true }));
    assert.equal(enforcer.cleanup().status, 'removed');
});

test('systemd enforcer uses the existing total grant and retains cleanup without reopening admission', async (t) =>
{
    const { fixture, options } = systemdEnforcerFixture(t);
    const enforcer = await createProductionResourceEnforcer(options);
    const bundleId = fixture.context.bundleId;
    assert.equal(enforcer.mode, 'enforced');
    assert.equal(enforcer.capabilities.backend, 'systemd-user-manager');
    assert.throws(() => enforcer.executionBoundary(bundleId), /verified current resource grant/u);
    const first = enforcer.update(bundleId, { cpuUnits: 1, memoryGiB: 1 });
    const boundary = enforcer.executionBoundary(bundleId);
    assert.deepEqual(boundary.reference, fixture.reference);
    assert.equal(boundary.admission.path, first.cgroupPath);
    await assert.rejects(() => enforcer.attach(bundleId, fixture.launcherProcess.pid), /exact registered launcher identity/u);
    assert.equal(fixture.events.includes('start-launcher'), false);
    assert.equal(await enforcer.attach(bundleId, fixture.launcherProcess.pid, fixture.launcherProcess), 'attached');
    assert.equal(enforcer.evidence().bundles[bundleId].launcherAdmission.parent.unitName, boundary.admission.unitName);
    assert.ok(fixture.launcherUnit.ControlGroup.startsWith(`${fixture.unit.ControlGroup}/`));
    const second = enforcer.update(bundleId, { cpuUnits: 0.333333, memoryGiB: 0.500001 });
    assert.equal(second.cpuMax, '163299 489898');
    assert.equal(fixture.launcherGroup.processIds[0], fixture.launcherProcess.pid);
    const evidence = enforcer.sample();
    assert.equal(evidence.bundles[bundleId].grants.length, 2);
    assert.equal(evidence.bundles[bundleId].consistency.status, 'consistent');
    assert.equal(evidence.bundles[bundleId].samples.at(-1).memoryCurrent, null, 'missing counters must not become fabricated zeroes');
    assert.equal(enforcer.cleanup().status, 'retained-resources');
    assert.throws(() => enforcer.update(bundleId, { cpuUnits: 1, memoryGiB: 1 }), /finalizing retained/u);
    await assert.rejects(() => enforcer.attach(bundleId, fixture.launcherProcess.pid, fixture.launcherProcess), /finalizing retained/u);
    fixture.launcherGroup.populated = false;
    fixture.launcherGroup.processIds = [];
    fixture.group.populated = false;
    assert.equal(enforcer.cleanup().status, 'removed');
    assert.equal(enforcer.cleanup().status, 'removed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(fixture.reference.ownerFile), 'state.json'))).phase, 'released');
});

test('systemd enforcer invalidates changed-control admission and rejects context or retention failures', async (t) =>
{
    const { fixture, options } = systemdEnforcerFixture(t);
    const bundleId = fixture.context.bundleId;
    await assert.rejects(() => createProductionResourceEnforcer({ ...options,
        systemdBoundary: { ...options.systemdBoundary, context: { ...options.systemdBoundary.context, runId: 'wrong-run' } } }), /exact context/u);
    await assert.rejects(() => createProductionResourceEnforcer({ ...options, delegateRoot: '/sys/fs/cgroup/selected' }), /explicitly selected/u);
    const enforcer = await createProductionResourceEnforcer(options);
    enforcer.update(bundleId, { cpuUnits: 1, memoryGiB: 1 });
    fixture.group.controls['pids.max'] = '4096';
    assert.throws(() => enforcer.executionBoundary(bundleId), /controls changed/u);
    assert.equal(enforcer.evidence().bundles[bundleId].consistency.status, 'unverified');
    fixture.group.controls['pids.max'] = '128';
    await assert.rejects(() => enforcer.attach(bundleId, fixture.launcherProcess.pid, fixture.launcherProcess), /verified current resource grant/u);
    enforcer.update(bundleId, { cpuUnits: 1, memoryGiB: 1 });
    assert.equal(enforcer.executionBoundary(bundleId).reference.bindingDigest, fixture.reference.bindingDigest);
    assert.equal(enforcer.cleanup().status, 'removed');

    const denied = systemdEnforcerFixture(t);
    await assert.rejects(() => createProductionResourceEnforcer({ ...denied.options, mode: 'auto', systemdBoundary: {
        ...denied.options.systemdBoundary, retainBinding: () => ({ bindingDigest: `sha256:${'0'.repeat(64)}` })
    } }), /did not acknowledge/u);
    assert.equal(denied.fixture.events.includes('start'), false);
});

test('systemd enforcer preserves explicit unsupported modes without converting identity drift into advisory', async (t) =>
{
    const { fixture, options } = systemdEnforcerFixture(t);
    let calls = 0;
    fixture.transport.runtimeIdentity = () =>
    {
        calls += 1;
        throw Object.assign(new Error('local manager absent'), { code: 'ENOENT' });
    };
    for (const mode of ['off', 'advisory'])
    {
        const enforcer = await createProductionResourceEnforcer({ ...options, mode });
        assert.equal(enforcer.mode, 'advisory');
    }
    assert.equal(calls, 0);
    const automatic = await createProductionResourceEnforcer({ ...options, mode: 'auto' });
    assert.equal(automatic.mode, 'advisory');
    assert.match(automatic.evidence().reason, /systemd-capability-unavailable:ENOENT/u);
    await assert.rejects(() => createProductionResourceEnforcer(options), /strict cgroup enforcement unavailable/u);
    const beforeUnsupported = calls;
    const unsupported = await createProductionResourceEnforcer({ ...options, mode: 'auto', platform: 'darwin' });
    assert.equal(unsupported.evidence().reason, 'non-linux');
    assert.equal(calls, beforeUnsupported);
    fixture.transport.runtimeIdentity = () =>
    {
        throw new Error('manager identity changed');
    };
    await assert.rejects(() => createProductionResourceEnforcer({ ...options, mode: 'auto' }), /manager identity changed/u);
    assert.equal(fixture.events.length, 0);
});

test('partial systemd enforcer construction reconciles only its independently retained owners', async (t) =>
{
    const { fixture, options } = systemdEnforcerFixture(t);
    const retained = [];
    const retain = options.systemdBoundary.retainBinding;
    options.systemdBoundary.retainBinding = async (reference) =>
    {
        retained.push(reference);
        return retain(reference);
    };
    let firstName = null;
    const inspect = fixture.transport.inspect;
    const absent = inspect('unused');
    fixture.transport.inspect = (name) => name === firstName ? inspect(name) : structuredClone(absent);
    const start = fixture.transport.start;
    fixture.transport.start = (...args) =>
    {
        if (firstName)
        {
            throw new Error('second exact creation denied');
        }
        [firstName] = args;
        start(...args);
    };
    await assert.rejects(() => createProductionResourceEnforcer({ ...options, bundleIds: ['first', 'second'], mode: 'auto' }), (error) =>
        /second exact creation denied/u.test(error.message)
        && error.enforcerSetupCleanup.boundaries.length === 1
        && error.enforcerSetupCleanup.boundaries[0].status === 'removed'
        && error.enforcerSetupCleanup.priorFailure.status === 'removed');
    assert.equal(retained.length, 2);
    for (const reference of retained)
    {
        assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(reference.ownerFile), 'state.json'))).phase, 'released');
    }
    assert.equal(fixture.events.filter((event) => event === 'stop').length, 1);
});
