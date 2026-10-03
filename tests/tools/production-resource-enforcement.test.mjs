import assert from 'node:assert/strict';
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

test('dynamic grants update effective CPU, memory and pids controls without restarting the bundle', () =>
{
    const fixture = fakeCgroup();
    const enforcer = createProductionResourceEnforcer({
        runId: 'run-1', bundleIds: ['frontend-tests'], mode: 'strict',
        machine: { cpuUnits: 8, memoryGiB: 16 },
        platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot,
        prepareDirectory: fixture.prepareDirectory,
        removeDirectory: (directory) => fs.rmSync(directory, { recursive: true })
    });
    assert.equal(enforcer.mode, 'enforced');
    const first = enforcer.update('frontend-tests', { cpuUnits: 2, memoryGiB: 3 });
    enforcer.attach('frontend-tests', 4242);
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

test('active cgroups are retained while cancellation cleanup removes empty owned groups', () =>
{
    const fixture = fakeCgroup();
    const enforcer = createProductionResourceEnforcer({
        runId: 'cancel-run', bundleIds: ['runtime-browser'], mode: 'strict',
        machine: { cpuUnits: 4, memoryGiB: 8 },
        platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot,
        prepareDirectory: fixture.prepareDirectory,
        removeDirectory: (directory) => fs.rmSync(directory, { recursive: true })
    });
    const limits = enforcer.update('runtime-browser', { cpuUnits: 2, memoryGiB: 2 });
    enforcer.attach('runtime-browser', 99);
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

test('strict mode fails closed while auto and advisory modes expose degradation', () =>
{
    const options = {
        runId: 'unsupported', bundleIds: ['bundle'], machine: { cpuUnits: 2, memoryGiB: 2 }, platform: 'darwin'
    };
    assert.throws(() => createProductionResourceEnforcer({ ...options, mode: 'strict' }), /strict cgroup enforcement unavailable/u);
    const advisory = createProductionResourceEnforcer({ ...options, mode: 'auto' });
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
