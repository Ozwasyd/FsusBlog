import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
    createProductionResourceEnforcer,
    dockerResourceArguments,
    partitionContainerResourceGrant,
    resolveCgroupLimits,
    resolveProductionCgroupCapabilities
} = await import(new URL('../../tools/test-matrix/production-resource-enforcement.mjs', import.meta.url));
const { runDag } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));

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

function containerResourceFixture(t)
{
    const fixture = fakeCgroup();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const enforcer = createProductionResourceEnforcer({
        runId: 'mysql-resource-contract', bundleIds: ['backend-unit'], mode: 'strict',
        machine: { cpuUnits: 8, memoryGiB: 16 }, platform: 'linux',
        mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot,
        prepareDirectory: fixture.prepareDirectory,
        removeDirectory: (directory) => fs.rmSync(directory, { recursive: true })
    });
    const totalGrant = { cpuUnits: 4, memoryGiB: 4 };
    const initial = enforcer.update('backend-unit', totalGrant);
    enforcer.attach('backend-unit', 4242);
    const identity = { root: fixture.root, runId: 'mysql-resource-contract', namespace: 'mysql-owner',
        bundleId: 'matrix:backend-unit', stepId: 'migration-services',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) } };
    const limits = { cpuUnits: 1, memoryHighBytes: 512 * 1024 ** 2, memoryMaxBytes: 576 * 1024 ** 2, pidsMax: 128 };
    const request = { id: 'mysql', identity, limits };
    const context = () => ({ ...structuredClone(identity), resourceGrant: { ...limits } });
    return { fixture, enforcer, initial, totalGrant, request, context };
}

test('container partition conserves CPU, high/max memory and pids without duplicated headroom', () =>
{
    const machine = { cpuUnits: 8, memoryGiB: 16 };
    const grant = { cpuUnits: 4, memoryGiB: 4 };
    const reservation = { cpuUnits: 1, memoryHighBytes: 512 * 1024 ** 2, memoryMaxBytes: 576 * 1024 ** 2, pidsMax: 128 };
    const allocation = partitionContainerResourceGrant(grant, [reservation, reservation], machine);
    const ratio = (value) =>
    {
        const [quota, period] = value.cpuMax.split(' ').map(Number);
        return quota / period;
    };
    assert.equal(allocation.process.cpuUnits, 2);
    assert.ok(ratio(allocation.process) + allocation.reserved.cpuUnits <= grant.cpuUnits);
    for (const key of ['memoryHighBytes', 'memoryMaxBytes', 'pidsMax'])
    {
        assert.equal(allocation.process[key] + allocation.reserved[key], allocation.total[key], key);
    }
    assert.ok(allocation.process.memoryMaxBytes >= allocation.process.memoryHighBytes);
    assert.deepEqual(partitionContainerResourceGrant(grant, [], machine).process, resolveCgroupLimits(grant, machine));
    const fractional = partitionContainerResourceGrant(grant, [{ ...reservation, cpuUnits: 0.333333333 }], machine);
    assert.ok(ratio(fractional.process) + fractional.reserved.cpuUnits <= grant.cpuUnits);
});

test('cgroup memory projection uses exact kernel page granularity without exceeding the declared envelope', () =>
{
    for (const pageBytes of [4096, 16384, 65536])
    {
        const machine = { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: pageBytes };
        const limits = resolveCgroupLimits({ cpuUnits: 2, memoryGiB: 2.000001 }, machine);
        assert.equal(limits.memoryHighBytes % pageBytes, 0);
        assert.equal(limits.memoryMaxBytes % pageBytes, 0);
        assert.equal(limits.memoryPageBytes, pageBytes);
        assert.ok(limits.memoryHighBytes <= 2.000001 * 1024 ** 3);
        assert.ok(limits.memoryMaxBytes <= machine.memoryGiB * 1024 ** 3);
        assert.ok(limits.memoryMaxBytes > limits.memoryHighBytes);
        const reservation = { cpuUnits: 1, memoryHighBytes: 512 * 1024 ** 2, memoryMaxBytes: 576 * 1024 ** 2, pidsMax: 128 };
        const partition = partitionContainerResourceGrant({ cpuUnits: 2, memoryGiB: 2.000001 }, [reservation], machine);
        assert.equal(partition.process.memoryMaxBytes % pageBytes, 0);
        assert.equal(partition.process.memoryHighBytes % pageBytes, 0);
        assert.throws(() => partitionContainerResourceGrant({ cpuUnits: 2, memoryGiB: 2 },
            [{ ...reservation, memoryHighBytes: reservation.memoryHighBytes - 1 }], machine), /page granularity/u);
    }
    const exact = resolveCgroupLimits({ cpuUnits: 2, memoryGiB: 2 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 });
    assert.equal(exact.memoryHighBytes, 2147483648);
    assert.equal(exact.memoryMaxBytes, 2337292288);
    for (const pageBytes of [0, -1, 1000, NaN, '4096', 2 ** 25])
    {
        assert.throws(() => resolveCgroupLimits({ cpuUnits: 2, memoryGiB: 2 },
            { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: pageBytes }), /page size/u);
    }
});

test('container partition rejects absent, rounded, oversold or inverted residual shares', () =>
{
    const machine = { cpuUnits: 8, memoryGiB: 16 };
    const grant = { cpuUnits: 4, memoryGiB: 4 };
    const limits = { cpuUnits: 1, memoryHighBytes: 512 * 1024 ** 2, memoryMaxBytes: 576 * 1024 ** 2, pidsMax: 128 };
    for (const reservation of [null, {}, { ...limits, extra: true }, { ...limits, cpuUnits: 1 / 3 },
        { ...limits, cpuUnits: 0 }, { ...limits, cpuUnits: NaN }, { ...limits, memoryHighBytes: 0 },
        { ...limits, memoryMaxBytes: limits.memoryHighBytes - 1 }, { ...limits, pidsMax: 1.5 },
        { ...limits, pidsMax: Number.MAX_SAFE_INTEGER + 1 }, { ...limits, cpuUnits: 4 },
        { ...limits, memoryHighBytes: 4 * 1024 ** 3, memoryMaxBytes: 4 * 1024 ** 3 },
        { ...limits, memoryMaxBytes: 5 * 1024 ** 3 }, { ...limits, pidsMax: 512 }])
    {
        assert.throws(() => partitionContainerResourceGrant(grant, [reservation], machine));
    }
    assert.throws(() => partitionContainerResourceGrant(grant, null, machine), /explicit list/u);
    assert.throws(() => partitionContainerResourceGrant(grant, [limits, limits, limits, limits], machine), /process share/u);
});

test('enforcer retains container reservation across dynamic updates and rejects invalid contraction before writes', async (t) =>
{
    const { enforcer, initial, request, context } = containerResourceFixture(t);
    const lease = enforcer.reserveContainerResources('backend-unit', request);
    const first = lease.assertHeld(context());
    assert.equal(first.total.cpuUnits, 4);
    assert.equal(first.process.cpuUnits, 3);
    assert.equal(fs.readFileSync(path.join(initial.cgroupPath, 'memory.high'), 'utf8'), String(first.process.memoryHighBytes));
    const expanded = enforcer.update('backend-unit', { cpuUnits: 6, memoryGiB: 6 });
    assert.equal(expanded.cpuUnits, 5);
    assert.equal(expanded.totalGrant.cpuUnits, 6);
    assert.deepEqual(expanded.containerReservations, [request]);
    assert.deepEqual(lease.assertHeld(context()).reservation.limits, request.limits);
    const before = ['cpu.max', 'memory.high', 'memory.max', 'pids.max'].map((name) => fs.readFileSync(path.join(initial.cgroupPath, name), 'utf8'));
    assert.throws(() => enforcer.update('backend-unit', { cpuUnits: 1, memoryGiB: 6 }), /process share/u);
    assert.throws(() => enforcer.update('backend-unit', { cpuUnits: 6, memoryGiB: 0.5 }), /process share/u);
    assert.deepEqual(['cpu.max', 'memory.high', 'memory.max', 'pids.max'].map((name) => fs.readFileSync(path.join(initial.cgroupPath, name), 'utf8')), before);
    assert.equal(lease.assertHeld(context()).total.cpuUnits, 6);
    await lease.releaseAfterCleanup(async () => ({ containerAbsent: true, credentialsRemoved: true }));
    assert.equal(enforcer.evidence().bundles['backend-unit'].allocation.process.cpuUnits, 6);
    assert.equal(lease.snapshot().held, false);
    assert.throws(() => lease.assertHeld(context()), /absent or crosses/u);
    assert.throws(() => enforcer.reserveContainerResources('backend-unit', request), /cannot be reused/u);
});

test('container reservations bind exact run, source, producer and immutable copies before control writes', (t) =>
{
    for (const mutation of [
        (request) =>
        {
            request.extra = true;
        },
        (request) =>
        {
            request.identity.runId = 'foreign';
        },
        (request) =>
        {
            request.identity.bundleId = 'foreign';
        },
        (request) =>
        {
            delete request.identity.sourceState.commit;
        },
        (request) =>
        {
            request.identity.namespace = '../foreign';
        },
        (request) =>
        {
            request.limits.cpuUnits = 4;
        },
        (request) =>
        {
            request.limits.pidsMax = -1;
        }
    ])
    {
        const { enforcer, initial, request } = containerResourceFixture(t);
        const before = fs.readFileSync(path.join(initial.cgroupPath, 'cpu.max'), 'utf8');
        mutation(request);
        assert.throws(() => enforcer.reserveContainerResources('backend-unit', request));
        assert.equal(fs.readFileSync(path.join(initial.cgroupPath, 'cpu.max'), 'utf8'), before);
        assert.deepEqual(enforcer.evidence().bundles['backend-unit'].allocation.containerReservations, []);
    }
    const { enforcer, request, context } = containerResourceFixture(t);
    const original = context();
    const lease = enforcer.reserveContainerResources('backend-unit', request);
    request.limits.cpuUnits = 99;
    request.identity.namespace = 'modified-after-admission';
    const copied = lease.snapshot();
    copied.limits.cpuUnits = 88;
    assert.equal(lease.assertHeld(original).reservation.limits.cpuUnits, 1);
    for (const mutate of [
        (value) =>
        {
            value.runId = 'foreign';
        },
        (value) =>
        {
            value.sourceState.worktreeFingerprint = 'c'.repeat(64);
        },
        (value) =>
        {
            value.stepId = 'foreign';
        },
        (value) =>
        {
            value.resourceGrant.memoryMaxBytes++;
        }
    ])
    {
        const changed = structuredClone(original);
        mutate(changed);
        assert.throws(() => lease.assertHeld(changed), /absent or crosses/u);
    }
});

test('container reservation cannot use advisory, disposed, unknown or unattached process authority', (t) =>
{
    const { enforcer, initial, request, context } = containerResourceFixture(t);
    assert.throws(() => enforcer.reserveContainerResources('foreign', request), /live enforced/u);
    const advisory = createProductionResourceEnforcer({ runId: request.identity.runId,
        bundleIds: ['backend-unit'], machine: { cpuUnits: 8, memoryGiB: 16 }, platform: 'darwin', mode: 'advisory' });
    advisory.update('backend-unit', { cpuUnits: 4, memoryGiB: 4 });
    assert.throws(() => advisory.reserveContainerResources('backend-unit', request), /live enforced/u);
    const lease = enforcer.reserveContainerResources('backend-unit', request);
    fs.writeFileSync(path.join(initial.cgroupPath, 'cgroup.procs'), '');
    assert.throws(() => lease.assertHeld(context()), /attached bundle process/u);
    assert.equal(enforcer.cleanup().status, 'retained-container-reservations');
    fs.writeFileSync(path.join(initial.cgroupPath, 'cgroup.procs'), '4242');
    fs.writeFileSync(path.join(initial.cgroupPath, 'cpu.max'), 'max 100000');
    assert.throws(() => lease.assertHeld(context()), /controls drifted/u);
    enforcer.update('backend-unit', { cpuUnits: 4, memoryGiB: 4 });
    assert.equal(lease.assertHeld(context()).process.cpuUnits, 3);
});

test('container resource release waits for successful exact cleanup and retains failed or concurrent attempts', async (t) =>
{
    const { enforcer, initial, request, context } = containerResourceFixture(t);
    const lease = enforcer.reserveContainerResources('backend-unit', request);
    await assert.rejects(lease.releaseAfterCleanup(async () =>
    {
        throw new Error('owned container remains');
    }), /owned container remains/u);
    await assert.rejects(lease.releaseAfterCleanup(async () => ({ containerAbsent: false, credentialsRemoved: true })), /complete lifecycle cleanup/u);
    assert.equal(lease.snapshot().held, true);
    assert.equal(enforcer.cleanup().status, 'retained-container-reservations');
    let finish;
    const released = lease.releaseAfterCleanup(() => new Promise((resolve) =>
    {
        finish = resolve;
    }));
    await assert.rejects(lease.releaseAfterCleanup(async () => ({ containerAbsent: true, credentialsRemoved: true })), /one active owner/u);
    enforcer.update('backend-unit', { cpuUnits: 6, memoryGiB: 6 });
    assert.equal(lease.assertHeld(context()).process.cpuUnits, 5);
    finish({ containerAbsent: true, credentialsRemoved: true });
    await released;
    assert.equal(enforcer.evidence().bundles['backend-unit'].allocation.process.cpuUnits, 6);
    fs.writeFileSync(path.join(initial.cgroupPath, 'cgroup.procs'), '');
    assert.equal(enforcer.cleanup().status, 'removed');
    assert.throws(() => enforcer.update('backend-unit', { cpuUnits: 4, memoryGiB: 4 }), /disposed/u);
    assert.throws(() => enforcer.reserveContainerResources('backend-unit', { ...request, id: 'next' }), /live enforced/u);
});

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
