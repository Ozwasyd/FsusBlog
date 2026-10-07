import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { materializeTestMatrixRunner } from './support/esm-fixture-materializer-contracts.mjs';

const {
    createProductionResourceEnforcer,
    dockerResourceArguments,
    partitionContainerResourceGrant,
    resolveCgroupLimits,
    resolveProductionCgroupCapabilities
} = await import(new URL('../../tools/test-matrix/production-resource-enforcement.mjs', import.meta.url));
const { runDag } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const {
    createSystemdResourceTransport,
    inspectProductionSystemdResourceBoundary,
    inspectProductionSystemdServiceBinding,
    prepareProductionSystemdResourceBoundary,
    prepareProductionSystemdServiceAdmission,
    readProductionSystemdResourceBoundaryBinding,
    recoverProductionSystemdResourceBoundary,
    systemdResourceProperties
} = await import(new URL('../../tools/test-matrix/production-systemd-resource-boundary.mjs', import.meta.url));
const {
    bindProductionBuildLayoutSource,
    failClosedProductionBuildLayout,
    finalizeProductionBuildLayout,
    markProductionBuildServiceCreationAttempt,
    prepareProductionBuildLayout,
    productionBuildRunIsActive,
    registerProductionBuildCompiler,
    retainProductionBuildResourceBoundary,
    retainProductionBuildServiceContainment,
    settleProductionBuildResidentService,
    transferProductionBuildResidentService
} = await import(new URL('../../tools/test-matrix/production-build-layout.mjs', import.meta.url));
const { createSchedulerRunOwner, schedulerCandidateIdentityDigest } = await import(new URL('../../tools/test-matrix/scheduler-run-owner.mjs', import.meta.url));
const { collectProcessIdentity, currentProcessIdentity, processIdentityStatus } = await import(new URL('../../tools/test/process-identity.mjs', import.meta.url));
const { cleanupPhysicalExecutionResourceArtifacts, runPhysicalExecution, terminatePhysicalExecutionAuthoritySync } = await import(new URL('../../tools/test/physical-execution-process-tree.mjs', import.meta.url));
const { writePrivateJson } = await import(new URL('../../tools/test-fixtures/receipt/private-io.mjs', import.meta.url));
const { runProductionBuildLifecycle } = await import(new URL('../../tools/test-matrix/production-build-lifecycle.mjs', import.meta.url));
const { acquireProductionCapacityReservation } = await import(new URL('../../tools/test-matrix/production-capacity-reservation.mjs', import.meta.url));

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

function resourceBuildLayout(fixture)
{
    const { root, runId, sourceState, namespace, schedulerOwnerToken } = fixture.context;
    const layout = prepareProductionBuildLayout({ root, runId, sourceState, namespace });
    const targetTierId = 'resource-fixture';
    const lock = path.join(root, '.tmp/test-runs/.locks', `${runId}.lock`);
    fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(createSchedulerRunOwner({
        runId, targetTierId, candidateIdentityDigest: schedulerCandidateIdentityDigest({ runId, targetTierId, namespace, sourceState }),
        ownerToken: schedulerOwnerToken, identity: currentProcessIdentity()
    })), { mode: 0o600 });
    bindProductionBuildLayoutSource(layout, sourceState);
    return layout;
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

test('independent resource observations require retained authority and actual absence without mutating resources', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const retain = fixture.options.retainBinding;
    const inspect = (reference) => inspectProductionSystemdResourceBoundary(fixture.context, { reference, transport: fixture.transport });
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, {
        ...fixture.options,
        async retainBinding(reference)
        {
            const acknowledgement = await retain(reference);
            assert.equal(inspect(reference).status, 'retained', 'prepared intent is not a released allocation');
            assert.equal(readProductionSystemdResourceBoundaryBinding(fixture.context, { reference }).state.phase, 'prepared');
            return acknowledgement;
        }
    });
    assert.equal(inspect(owner.reference).status, 'retained');
    assert.deepEqual(fixture.events, ['retain', 'start']);
    assert.equal(owner.cleanup().status, 'removed');
    const events = [...fixture.events];
    assert.equal(inspect(owner.reference).status, 'released');
    assert.deepEqual(fixture.events, events, 'inspection is read-only');
    fixture.runtime.busId = 'f'.repeat(32);
    assert.throws(() => inspect(owner.reference), /manager differs/u);
});

test('a lost retention acknowledgement still reconciles the exact empty prepared resource', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const retain = fixture.options.retainBinding;
    await assert.rejects(() => prepareProductionSystemdResourceBoundary(fixture.context, {
        ...fixture.options,
        async retainBinding(reference)
        {
            await retain(reference);
            throw new Error('retention response lost');
        }
    }), (error) =>
    {
        assert.match(error.message, /retention response lost/u);
        assert.equal(error.resourceCleanup.status, 'removed');
        return true;
    });
    assert.deepEqual(fixture.events, ['retain']);
    assert.equal(inspectProductionSystemdResourceBoundary(fixture.context, { reference: fixture.reference, transport: fixture.transport }).status, 'released');
});

test('build owner durably retains resource bindings before creation and rejects cross-context or conflicting references', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const layout = resourceBuildLayout(fixture);
    const retain = fixture.options.retainBinding;
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, {
        ...fixture.options,
        async retainBinding(reference)
        {
            await retain(reference);
            return retainProductionBuildResourceBoundary(layout, reference, { commandBudgetMs: 1000 });
        }
    });
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
    assert.equal(manifest.owner.processTreeReceipt.schema, 'fsusblog.production-build-process-tree-receipt.v2');
    assert.deepEqual(manifest.owner.managedResourceBoundaries, [{ reference: owner.reference, commandBudgetMs: 1000 }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(layout.activeFile, 'utf8')).owner, manifest.owner);
    assert.equal(fs.statSync(layout.manifestFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(layout.activeFile).mode & 0o777, 0o600);
    assert.deepEqual(retainProductionBuildResourceBoundary(layout, owner.reference, { commandBudgetMs: 1000 }), { bindingDigest: owner.reference.bindingDigest });
    assert.throws(() => retainProductionBuildResourceBoundary(layout, owner.reference, { commandBudgetMs: 1001 }), /conflicts/u);
    for (const field of ['runId', 'namespace', 'bundleId', 'schedulerOwnerToken'])
    {
        const changed = { ...owner.reference, context: { ...owner.reference.context, [field]: 'different' } };
        assert.throws(() => retainProductionBuildResourceBoundary(layout, changed, { commandBudgetMs: 1000 }), /exact context/u);
    }
    assert.throws(() => retainProductionBuildResourceBoundary(layout, { ...owner.reference, extra: true }, { commandBudgetMs: 1000 }), /exact context/u);
    // Fake component authority cannot be promoted to real OS release evidence by the build owner.
    assert.throws(() => finalizeProductionBuildLayout(layout, { status: 'success' }), /systemd resource/u);
    const failed = failClosedProductionBuildLayout(layout, { status: 'failure', sealFailure: new Error('resource observation failed') });
    assert.equal(failed.lifecycleFinalization.mode, 'retained-resources');
    assert.equal(failed.owner.state, 'finalizing');
    assert.equal(fs.existsSync(layout.activeFile), true);
    assert.throws(() => productionBuildRunIsActive(layout.repositoryRoot, layout.runId), /systemd resource/u);
    assert.equal(fs.existsSync(layout.runRoot), true);
});

test('build resource retention rejects late adoption, a foreign controller and non-private owner records', async (t) =>
{
    const late = fakeSystemdBoundary(t);
    const lateLayout = resourceBuildLayout(late);
    const lateOwner = await prepareProductionSystemdResourceBoundary(late.context, late.options);
    assert.throws(() => retainProductionBuildResourceBoundary(lateLayout, lateOwner.reference, { commandBudgetMs: 1000 }), /before creation/u);
    assert.equal(lateOwner.cleanup().status, 'removed');

    const foreign = fakeSystemdBoundary(t);
    const foreignLayout = resourceBuildLayout(foreign);
    const retain = foreign.options.retainBinding;
    await assert.rejects(() => prepareProductionSystemdResourceBoundary(foreign.context, {
        ...foreign.options,
        controllerIdentity: { ...currentProcessIdentity(), commandDigest: `sha256:${'f'.repeat(64)}` },
        async retainBinding(reference)
        {
            await retain(reference);
            return retainProductionBuildResourceBoundary(foreignLayout, reference, { commandBudgetMs: 1000 });
        }
    }), /controller differs/u);
    assert.equal(foreign.events.includes('start'), false);

    const privateFixture = fakeSystemdBoundary(t);
    const privateLayout = resourceBuildLayout(privateFixture);
    const retainPrivate = privateFixture.options.retainBinding;
    await assert.rejects(() => prepareProductionSystemdResourceBoundary(privateFixture.context, {
        ...privateFixture.options,
        async retainBinding(reference)
        {
            await retainPrivate(reference);
            fs.chmodSync(privateLayout.manifestFile, 0o644);
            return retainProductionBuildResourceBoundary(privateLayout, reference, { commandBudgetMs: 1000 });
        }
    }), /must be private/u);
    assert.equal(privateFixture.events.includes('start'), false);
});

test('build failure handling cannot reseal away previously retained resource references', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const layout = resourceBuildLayout(fixture);
    const retain = fixture.options.retainBinding;
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, {
        ...fixture.options,
        async retainBinding(reference)
        {
            await retain(reference);
            return retainProductionBuildResourceBoundary(layout, reference, { commandBudgetMs: 1000 });
        }
    });
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
    manifest.owner.managedResourceBoundaries = [];
    fs.writeFileSync(layout.manifestFile, JSON.stringify(manifest));
    const before = fs.readFileSync(layout.manifestFile);
    assert.throws(() => failClosedProductionBuildLayout(layout, { status: 'failure', sealFailure: new Error('partial owner write') }),
        /owner identity mismatch: .*failed bindings: dual-owner-records, process-tree-receipt/u);
    assert.equal(fs.existsSync(layout.activeFile), true);
    assert.deepEqual(fs.readFileSync(layout.manifestFile), before);
    assert.equal(owner.cleanup().status, 'removed');
});

test('failed build binding persistence preserves prior records and removes only its unpublished temporary file', async (t) =>
{
    for (const operation of ['fsyncSync', 'renameSync'])
    {
        const fixture = fakeSystemdBoundary(t);
        const layout = resourceBuildLayout(fixture);
        const before = fs.readFileSync(layout.manifestFile);
        const active = fs.readFileSync(layout.activeFile);
        const retain = fixture.options.retainBinding;
        const original = fs[operation];
        const injected = Object.assign(new Error(`injected ${operation} failure`), { code: 'ENOSPC' });
        await assert.rejects(() => prepareProductionSystemdResourceBoundary(fixture.context, {
            ...fixture.options,
            async retainBinding(reference)
            {
                await retain(reference);
                fs[operation] = (...args) =>
                {
                    const file = operation === 'fsyncSync' ? fs.readlinkSync(`/proc/self/fd/${args[0]}`) : args[0];
                    if (String(file).startsWith(`${layout.manifestFile}.next-`))
                    {
                        throw injected;
                    }
                    return original(...args);
                };
                try
                {
                    return retainProductionBuildResourceBoundary(layout, reference, { commandBudgetMs: 1000 });
                }
                finally
                {
                    fs[operation] = original;
                }
            }
        }), (error) => error === injected && error.code === 'ENOSPC' && error.resourceCleanup.status === 'removed');
        assert.deepEqual(fs.readFileSync(layout.manifestFile), before);
        assert.deepEqual(fs.readFileSync(layout.activeFile), active);
        assert.equal(fs.readdirSync(layout.runRoot).some((name) => name.includes('.next-')), false);
        assert.equal(fixture.events.includes('start'), false);
    }
});

test('retained build resources cannot authorize lifecycle post-seal callbacks', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const layout = resourceBuildLayout(fixture);
    const retain = fixture.options.retainBinding;
    const resource = await prepareProductionSystemdResourceBoundary(fixture.context, {
        ...fixture.options,
        async retainBinding(reference)
        {
            await retain(reference);
            return retainProductionBuildResourceBoundary(layout, reference, { commandBudgetMs: 1000 });
        }
    });
    let afterFinalizeCalls = 0;
    const primary = new Error('original operation failure');
    await assert.rejects(() => runProductionBuildLifecycle({
        adapters: { prepare: () => layout, finalize: finalizeProductionBuildLayout, failClosed: failClosedProductionBuildLayout },
        logger: { error()
        {} },
        async execute({ afterFinalize })
        {
            afterFinalize(() =>
            {
                afterFinalizeCalls += 1;
            });
            throw primary;
        }
    }), (error) => error === primary && Boolean(error.productionBuildFinalizeError));
    assert.equal(afterFinalizeCalls, 0, 'retained resources must not trigger callbacks authorized only by a terminal seal');
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
    assert.equal(manifest.owner.state, 'finalizing');
    assert.equal(manifest.lifecycleFinalization.mode, 'retained-resources');
    assert.equal(fs.existsSync(layout.activeFile), true);
    assert.equal(resource.cleanup().status, 'removed');
});

test('completed resource-free build lifecycles retain their post-seal callbacks', async (t) =>
{
    for (const status of ['success', 'failure', 'cancelled'])
    {
        const fixture = fakeSystemdBoundary(t);
        const layout = resourceBuildLayout(fixture);
        const observed = [];
        const result = await runProductionBuildLifecycle({
            adapters: { prepare: () => layout, finalize: finalizeProductionBuildLayout, failClosed: failClosedProductionBuildLayout },
            async execute({ afterFinalize, setFinalization })
            {
                afterFinalize((manifest) =>
                {
                    observed.push(manifest.status);
                });
                setFinalization({ status });
            }
        });
        assert.deepEqual(observed, [status]);
        assert.equal(result.buildManifest.status, status);
        assert.equal(result.sealFailure, null);
        assert.equal(fs.existsSync(layout.activeFile), false);
    }
});

test('systemd quota transport preserves exact integer controls including fractional grants', () =>
{
    for (const [quota, period] of [[163299, 489898], [314269, 254558], [282843, 282843], [200000, 400000], [1000, 1000000]])
    {
        const limits = { cpuMax: `${quota} ${period}`, cpuWeight: 417, memoryPageBytes: 4096,
            memoryHighBytes: 536870912, memoryMaxBytes: 603979776, pidsMax: 64 };
        const values = Object.fromEntries(systemdResourceProperties(limits).map(([key, , value]) => [key, value]));
        assert.equal(BigInt(values.CPUQuotaPerSecUSec) * BigInt(values.CPUQuotaPeriodUSec) / 1000000n, BigInt(quota));
        assert.equal(values.MemoryHigh, '536870912');
        assert.equal(values.MemoryMax, '603979776');
        assert.equal(values.TasksMax, '64');
        for (const changed of [{ cpuMax: 'max 100000' }, { cpuMax: '1000 0' }, { cpuMax: '1000 1000001' },
            { cpuWeight: 0 }, { memoryHighBytes: 536870913 }, { memoryPageBytes: 1000 }, { pidsMax: 0 },
            { memoryMaxBytes: 4096 }])
        {
            assert.throws(() => systemdResourceProperties({ ...limits, ...changed }), /systemd resource projection/u);
        }
    }
});

test('systemd transport rejects unsupported platforms and missing command budgets before invoking tools', () =>
{
    const execute = () =>
    {
        throw new Error('unexpected execution');
    };
    assert.throws(() => createSystemdResourceTransport({ platform: 'darwin', commandBudgetMs: 1000, execute }), /unsupported outside Linux/u);
    for (const commandBudgetMs of [undefined, 0, -1, 1.1, Infinity])
    {
        assert.throws(() => createSystemdResourceTransport({ commandBudgetMs, execute }), /explicit positive/u);
    }
});

test('systemd resource owner retains private authority before creation and requires exact live grant read-back', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
    assert.deepEqual(fixture.events, ['retain', 'start']);
    assert.throws(() => owner.assertAdmitted(), /no verified current grant/u);
    const limits = resolveCgroupLimits({ cpuUnits: 0.333333, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 });
    const first = owner.update(limits);
    assert.equal(first.controls['cpu.max'], limits.cpuMax);
    assert.equal(owner.assertAdmitted().invocationId, 'd'.repeat(32));
    assert.throws(() => owner.update({ ...limits, memoryPageBytes: 1 }), /page size differs/u);
    assert.throws(() => owner.assertAdmitted(), /no verified current grant/u);
    owner.update(limits);
    fixture.group.controls['memory.max'] = 'max';
    assert.throws(() => owner.assertAdmitted(), /controls changed/u);
    owner.update(limits);
    fixture.group.populated = true;
    assert.equal(owner.cleanup().status, 'retained-active');
    assert.equal(fixture.events.includes('stop'), false);
    fixture.group.populated = false;
    fixture.group.children = ['unknown.service'];
    assert.equal(owner.cleanup().status, 'retained-active');
    assert.equal(fixture.events.includes('stop'), false);
    fixture.group.children = [];
    assert.equal(owner.cleanup().status, 'removed');
    assert.equal(owner.cleanup().status, 'removed');
    assert.equal(fixture.events.filter((event) => event === 'stop').length, 1);
    assert.throws(() => owner.update(limits), /owner is closed/u);
});

test('systemd transport preserves executable capability errors without treating command rejection as unsupported', {
    skip: process.platform !== 'linux'
}, () =>
{
    for (const code of ['ENOENT', 'EACCES', 'ETIMEDOUT'])
    {
        const transport = createSystemdResourceTransport({ commandBudgetMs: 1000,
            execute: () => ({ error: Object.assign(new Error('injected executable failure'), { code }) }) });
        assert.throws(() => transport.inspect('-.slice'), (error) => error.code === code && error.cause.code === code);
    }
    const denied = createSystemdResourceTransport({ commandBudgetMs: 1000,
        execute: () => ({ status: 1, stdout: '', stderr: 'denied' }) });
    assert.throws(() => denied.inspect('-.slice'), (error) => error.code === undefined);
});

test('real kernel pressure enforces shared CPU, memory and PID boundaries', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    for (const scenario of ['shared-dynamic-cpu', 'memory-high', 'memory-oom', 'pids-exhaustion'])
    {
        await t.test(scenario, async (subtest) =>
        {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-resource-pressure-'));
            const context = { root, runId: 'resource-pressure', namespace: 'component',
                sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }, schedulerOwnerToken: randomUUID() };
            const enforcer = await createProductionResourceEnforcer({
                runId: context.runId, bundleIds: ['worker'], mode: 'strict', machine: { cpuUnits: 2, memoryGiB: 1 },
                systemdBoundary: { context, commandBudgetMs: 5000, startupBudgetMs: 5000,
                    retainBinding(reference)
                    {
                        writePrivateJson(path.join(root, 'independent-reference.json'), reference);
                        return { bindingDigest: reference.bindingDigest };
                    } }
            });
            const initialGrant = { cpuUnits: 0.5, memoryGiB: scenario === 'pids-exhaustion' ? 0.5 : 0.0625 };
            const controller = new AbortController();
            const deadline = AbortSignal.timeout(60_000);
            const executions = [];
            subtest.after(async () =>
            {
                controller.abort(new Error('task-owned pressure fixture cleanup'));
                await Promise.all(executions);
                assert.equal(enforcer.cleanup().status, 'removed', 'pressure fixture must leave no owned cgroup or service');
                fs.rmSync(root, { recursive: true, force: true });
            });
            const limits = enforcer.update('worker', initialGrant);
            const residentScope = enforcer.environment('worker');
            assert.equal(residentScope.FSUSBLOG_CGROUP_ENFORCEMENT_MODE, 'enforced');
            assert.equal(residentScope.FSUSBLOG_CGROUP_BUNDLE_PATH, limits.cgroupPath,
                'resident handoff must receive the real admitted systemd ancestor');
            assert.equal(fs.realpathSync(residentScope.FSUSBLOG_CGROUP_BUNDLE_PATH), limits.cgroupPath);
            assert.equal(fs.readFileSync(path.join(limits.cgroupPath, 'cpu.max'), 'utf8').trim(), limits.cpuMax);
            const script = path.join(root, 'pressure.py');
            fs.writeFileSync(script, `import errno, json, os, signal, sys, time
from pathlib import Path
root, scenario, identity = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
group = Path('/proc/self/cgroup').read_text().strip()[3:]
parent = Path('/sys/fs/cgroup' + group).parent
service = Path('/sys/fs/cgroup' + group)
def events(file):
    return {key: int(value) for key, value in (line.split() for line in file.read_text().splitlines())}
def emit(name, value):
    temporary = root / (name + '.next-' + str(os.getpid()))
    temporary.write_text(json.dumps(value))
    os.replace(temporary, root / name)
def observation():
    return dict(pid=os.getpid(), group=group, affinity=sorted(os.sched_getaffinity(0)),
        cpuBurst=int((parent / 'cpu.max.burst').read_text()), controls={key: (parent / key).read_text().strip()
        for key in ['cpu.max', 'cpu.weight', 'memory.high', 'memory.max', 'pids.max']})
emit('ready-' + identity + '.json', observation())
if scenario == 'shared-dynamic-cpu':
    for phase in range(3):
        while not (root / ('phase-' + str(phase))).exists():
            time.sleep(0.005)
        before = observation()
        started = time.monotonic()
        cpu = time.process_time()
        iterations = 0
        while time.monotonic() - started < 2:
            iterations += 1
        emit('result-' + identity + '-' + str(phase) + '.json', dict(before=before, after=observation(),
            cpuSeconds=time.process_time()-cpu, elapsedSeconds=time.monotonic()-started, iterations=iterations))
    while not (root / 'finish').exists():
        time.sleep(0.005)
elif scenario in ['memory-high', 'memory-oom']:
    maximum = int((parent / 'memory.max').read_text())
    if maximum > 128 * 1024 * 1024:
        raise RuntimeError('memory fixture safety ceiling exceeded')
    allocations = []
    with open('/dev/zero', 'rb', buffering=0) as source:
        # Bound even defective enforcement to at most twice this task's 128 MiB limit.
        if scenario == 'memory-oom':
            # Concurrent bounded allocations can exceed high's reclaim rate; the aggregate
            # attempted payload is still only twice max, not that amount per child.
            children = set()
            barrier_read, barrier_write = os.pipe()
            count = 16
            rejected = False
            try:
                for identity in range(count):
                    pid = os.fork()
                    if pid == 0:
                        try:
                            os.close(barrier_write)
                            if os.read(barrier_read, 1) != b'x':
                                os._exit(2)
                            allocation = source.read(maximum * 2 // count)
                            if len(allocation) != maximum * 2 // count:
                                os._exit(2)
                            emit('charged-' + str(identity), dict(bytes=len(allocation)))
                            time.sleep(45)
                            os._exit(0)
                        except BaseException:
                            # A child must never fall through into the parent's sibling cleanup.
                            os._exit(2)
                    children.add(pid)
                os.close(barrier_read)
                os.write(barrier_write, b'x' * count)
                os.close(barrier_write)
                while children:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                    if pid:
                        children.remove(pid)
                        if status != 0:
                            rejected = True
                            break
                    if all((root / ('charged-' + str(identity))).exists() for identity in range(count)):
                        emit('escaped-memory.json', observation())
                        break
                    time.sleep(0.01)
            finally:
                for pid in children:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                for pid in children:
                    os.waitpid(pid, 0)
            if rejected:
                sys.exit(1)
        else:
            high_before = events(parent / 'memory.events')['high']
            for offset in range(0, maximum * 2, 1024 * 1024):
                allocations.append(source.read(1024 * 1024))
                if events(parent / 'memory.events')['high'] > high_before:
                    break
            emit('memory-high.json', dict(observation(), allocated=sum(map(len, allocations)),
                events=events(parent / 'memory.events')))
else:
    maximum = int((parent / 'pids.max').read_text())
    if maximum > 64:
        raise RuntimeError('PID fixture safety ceiling exceeded')
    children = []
    denied = None
    events_before = events(service / 'pids.events')
    try:
        # A finite number of attempts, not an unbounded fork loop.
        for attempt in range(maximum + 1):
            try:
                pid = os.fork()
            except OSError as error:
                denied = error.errno
                break
            if pid == 0:
                try:
                    time.sleep(45)
                    os._exit(0)
                except BaseException:
                    os._exit(2)
            children.append(pid)
        emit('pid-denial.json', dict(observation(), children=len(children), errno=denied,
            expectedErrno=errno.EAGAIN, current=int((parent / 'pids.current').read_text()),
            serviceMaximum=(service / 'pids.max').read_text().strip(),
            serviceEventsBefore=events_before, serviceEvents=events(service / 'pids.events')))
    finally:
        for pid in children:
            os.kill(pid, signal.SIGTERM)
        for pid in children:
            os.waitpid(pid, 0)
`);
            const launch = (identity) =>
            {
                const execution = runPhysicalExecution({ command: ['python3', '-I', '-S', script, root, scenario, identity],
                    cwd: root, env: process.env, resourceBoundary: enforcer.executionBoundary('worker'),
                    resourceContext: { ...context, bundleId: 'worker' }, residualRoot: path.join(root, 'residuals'),
                    signal: AbortSignal.any([controller.signal, deadline]), stdout: null, stderr: null })
                    .then((evidence) => ({ evidence }), (error) => ({ error, evidence: error.physicalExecution }));
                executions.push(execution);
                return execution;
            };
            const waitFile = async (name) =>
            {
                const file = path.join(root, name);
                while (!fs.existsSync(file))
                {
                    deadline.throwIfAborted();
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            };
            const assertMembership = (observation, expected) =>
            {
                assert.equal(path.posix.dirname(observation.group), expected.cgroupPath.slice('/sys/fs/cgroup'.length));
                assert.equal(observation.controls['cpu.max'], expected.cpuMax);
                assert.equal(observation.controls['memory.high'], String(expected.memoryHighBytes));
                assert.equal(observation.controls['memory.max'], String(expected.memoryMaxBytes));
                assert.equal(observation.controls['pids.max'], String(expected.pidsMax));
                assert.equal(observation.cpuBurst, 0, 'the pressure oracle requires no configured quota burst');
            };
            const sample = () => structuredClone(enforcer.sample().bundles.worker.samples.at(-1));
            const before = sample();
            launch('first');
            const ready = await waitFile('ready-first.json');
            assertMembership(ready, limits);
            if (scenario === 'shared-dynamic-cpu')
            {
                launch('second');
                const second = await waitFile('ready-second.json');
                assertMembership(second, limits);
                assert.notEqual(ready.group, second.group, 'two independent services must share one parent budget');
                const identities = [ready, second].map((value) => collectProcessIdentity(value.pid));
                assert.equal(identities.every((value) => value.status === 'verified'), true);
                const kernelSliceUs = Number(fs.readFileSync('/proc/sys/kernel/sched_cfs_bandwidth_slice_us', 'utf8'));
                const allowedCpus = new Set([...ready.affinity, ...second.affinity]);
                assert.ok(allowedCpus.size > 0 && Number.isSafeInteger(kernelSliceUs) && kernelSliceUs > 0);
                const phases = [];
                for (const [phase, grant] of [{ cpuUnits: 0.25, memoryGiB: 0.0625 },
                    { cpuUnits: 0.5, memoryGiB: 0.125 }, { cpuUnits: 0.125, memoryGiB: 0.0625 }].entries())
                {
                    const effective = enforcer.update('worker', grant);
                    const start = process.hrtime.bigint();
                    const initial = sample();
                    fs.writeFileSync(path.join(root, `phase-${phase}`), 'start');
                    const observed = await Promise.all(['first', 'second'].map((id) => waitFile(`result-${id}-${phase}.json`)));
                    const final = sample();
                    const elapsedUs = Number(process.hrtime.bigint() - start) / 1000;
                    const [quotaUs, periodUs] = effective.cpuMax.split(' ').map(Number);
                    // CPU-local bandwidth can survive migration; bound all eligible CPUs, not just the two workers.
                    // https://docs.kernel.org/scheduler/sched-bwc.html#cfs-bandwidth-quota-caveats
                    const upperCpuUs = (Math.ceil(elapsedUs / periodUs) + 1) * quotaUs + allowedCpus.size * kernelSliceUs;
                    const usedCpuUs = final.cpuStat.usage_usec - initial.cpuStat.usage_usec;
                    assert.ok(usedCpuUs > 0 && usedCpuUs <= upperCpuUs, JSON.stringify({ usedCpuUs, upperCpuUs, elapsedUs }));
                    assert.ok(final.cpuStat.nr_throttled > initial.cpuStat.nr_throttled, 'busy sibling services must actually be throttled');
                    for (const [index, value] of observed.entries())
                    {
                        assertMembership(value.before, effective);
                        assertMembership(value.after, effective);
                        assert.equal(value.before.pid, identities[index].pid);
                        assert.equal(value.after.pid, identities[index].pid);
                        assert.equal(processIdentityStatus(identities[index]).status, 'live');
                        assert.deepEqual(value.before.affinity, index === 0 ? ready.affinity : second.affinity);
                        assert.deepEqual(value.after.affinity, value.before.affinity);
                        assert.ok(value.iterations > 0 && value.cpuSeconds > 0);
                    }
                    phases.push({ grant, controls: effective.cpuMax, usedCpuUs, upperCpuUs, elapsedUs,
                        kernelSliceUs, allowedCpuCount: allowedCpus.size, observed });
                }
                fs.writeFileSync(path.join(root, 'finish'), 'finish');
                subtest.diagnostic(JSON.stringify({ platform: 'linux', authority: 'real-kernel', phases }));
            }
            const outcomes = await Promise.all(executions);
            const after = sample();
            subtest.diagnostic(JSON.stringify({ platform: 'linux', authority: 'real-kernel', scenario,
                memoryEvents: after.memoryEvents, pidsEvents: after.pidsEvents, pidsCurrent: after.pidsCurrent }));
            assert.equal(deadline.aborted, false, 'a timeout is not proof of resource enforcement');
            if (scenario === 'memory-oom')
            {
                assert.ok(outcomes[0].error, 'allocation beyond the enforced boundary must not succeed');
                assert.equal(fs.existsSync(path.join(root, 'escaped-memory.json')), false);
                for (const event of ['max', 'oom_kill'])
                {
                    assert.ok(after.memoryEvents[event] > before.memoryEvents[event], `kernel memory event ${event} must advance`);
                }
            }
            else
            {
                assert.equal(outcomes.every((value) => !value.error), true, outcomes.map((value) => value.error?.message).join(';'));
                if (scenario === 'memory-high')
                {
                    const high = await waitFile('memory-high.json');
                    assertMembership(high, limits);
                    assert.ok(high.events.high > before.memoryEvents.high && after.memoryEvents.high > before.memoryEvents.high);
                    assert.equal(after.memoryEvents.oom_kill, before.memoryEvents.oom_kill, 'high pressure alone must not be mislabeled OOM');
                    subtest.diagnostic(JSON.stringify({ platform: 'linux', authority: 'real-kernel', high }));
                }
                if (scenario === 'pids-exhaustion')
                {
                    const denial = await waitFile('pid-denial.json');
                    assertMembership(denial, limits);
                    assert.equal(denial.errno, denial.expectedErrno);
                    assert.ok(denial.children > 0 && denial.children < limits.pidsMax);
                    assert.equal(denial.current, limits.pidsMax);
                    assert.ok(denial.serviceMaximum === 'max' || Number(denial.serviceMaximum) > limits.pidsMax);
                    assert.ok(denial.serviceEvents.max > denial.serviceEventsBefore.max,
                        'EAGAIN must come with the exact service cgroup PID denial evidence');
                    subtest.diagnostic(JSON.stringify({ platform: 'linux', authority: 'real-kernel', denial }));
                }
            }
            for (const outcome of outcomes)
            {
                assert.equal(outcome.evidence?.cleanup.status, 'verified', outcome.error?.message);
                assert.equal(outcome.evidence.postObservation, 'zero-members');
                assert.equal(outcome.evidence.resourceExecutionAdmission.parent.path, limits.cgroupPath);
            }
            assert.equal(after.pidsCurrent, 0);
        });
    }
});

test('real scheduler resource service retains independent creation and pre-exec ownership before payload', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    for (const variant of ['success', 'intent-ack-refused', 'registration-refused', 'receipt-refused',
        'timeout-before-release', 'global-before-release', 'cancel-before-release', 'externally-terminated',
        'resident-untransferred', 'resident-output-untransferred', 'resident-output-no-inventory',
        'resident-output-live-transfer'])
    {
        await t.test(variant, async (t) =>
        {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-scheduler-service-owner-'));
            const runId = 'service-owner';
            const namespace = 'component';
            const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
            const layout = prepareProductionBuildLayout({ root, runId, namespace, sourceState });
            // Disk sizes are simulated; build, service and resource-owner release observations are real.
            const capacityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-service-capacity-'));
            const capacity = acquireProductionCapacityReservation({
                repositoryRoot: root, runId, authorityRoot: capacityRoot,
                candidateIdentityDigest: `sha256:${'c'.repeat(64)}`,
                repositoryLeaseOwner: { ownerToken: 'component-capacity-owner' },
                plan: { planDigest: `sha256:${'d'.repeat(64)}`, producerDeclarationDigest: `sha256:${'e'.repeat(64)}`,
                    producerDeclarations: [], filesystems: [{ filesystemIdentity: 'simulated-disk',
                        observedFreeBytes: 1000, requestedBytes: 400, safetyBytes: 100 }] },
                remeasureFilesystem: (filesystem) => filesystem.observedFreeBytes
            });
            capacity.retainBuildOwner(layout);
            let reference;
            t.after(() =>
            {
                if (reference)
                {
                    assert.equal(inspectProductionSystemdResourceBoundary(reference.context, {
                        reference, commandBudgetMs: 5000
                    }).status, 'released', `owned resources must be absent before removing ${root}`);
                }
                assert.equal(fs.existsSync(capacity.activeFile), false, 'capacity must be released only after actual cleanup and build sealing');
                fs.rmSync(capacityRoot, { recursive: true, force: true });
                fs.rmSync(root, { recursive: true, force: true });
            });
            const marker = path.join(root, 'payload.json');
            const payload = path.join(root, 'payload.mjs');
            const outputBytes = 1024 * 1024 + 137;
            const residentSource = `const fs = require('node:fs');
                fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,
                    cgroup:fs.readFileSync('/proc/self/cgroup','utf8').trim().slice(3)}));
                setInterval(() => {}, 1000);`;
            const inventoryPath = path.join(root, '.tmp/test-runs', runId, 'resident-resource-leases.json');
            const residentModule = new URL('../../tools/test-matrix/resident-resource-leases.mjs', import.meta.url).href;
            const liveResidentSource = `const fs = require('node:fs'); const net = require('node:net');
                const server = net.createServer((socket) => socket.end('ready'));
                server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
                    pid: process.pid, port: server.address().port,
                    cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8').trim().slice(3) })));`;
            const consumerPayload = path.join(root, 'consumer.mjs');
            if (variant === 'resident-output-live-transfer')
            {
                fs.writeFileSync(consumerPayload, `import fs from 'node:fs'; import net from 'node:net';
                    import { consumeResidentLeaseHandoff, readResidentLeaseDocument, writeResidentLeaseDocument }
                        from ${JSON.stringify(residentModule)};
                    const inventory = readResidentLeaseDocument(process.env.FSUSBLOG_RESIDENT_LEASE_INVENTORY);
                    const handoff = readResidentLeaseDocument(process.env.FSUSBLOG_RESIDENT_LEASE_HANDOFF);
                    const service = inventory.services.find((entry) => entry.id === 'backend');
                    const reply = await new Promise((resolve, reject) => {
                        const socket = net.connect(service.port, '127.0.0.1'); let bytes = '';
                        socket.on('data', (chunk) => bytes += chunk.toString());
                        socket.on('end', () => resolve(bytes)); socket.on('error', reject);
                    });
                    if (reply !== 'ready') throw new Error('resident endpoint is not ready');
                    writeResidentLeaseDocument(process.env.FSUSBLOG_RESIDENT_LEASE_HANDOFF,
                        consumeResidentLeaseHandoff(handoff, { inventory, consumerBundleId: 'consumer' }));
                    const pid = service.identity.pid;
                    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
                    if (stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/u)[19]
                        !== service.identity.startTimeTicks) throw new Error('resident PID identity changed');
                    process.kill(pid, 'SIGTERM');
                    const deadline = Date.now() + 3000;
                    while (fs.existsSync('/proc/' + pid)) {
                        if (Date.now() > deadline) throw new Error('resident process did not exit');
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }`);
            }
            fs.writeFileSync(payload, variant === 'resident-output-live-transfer'
                ? `import fs from 'node:fs'; import { spawn } from 'node:child_process';
                    import { bindResidentLeaseEnforcement, createResidentLeaseInventory, writeResidentLeaseDocument }
                        from ${JSON.stringify(residentModule)};
                    const child = spawn(process.execPath, ['-e', ${JSON.stringify(liveResidentSource)}],
                        { detached: true, stdio: 'ignore' });
                    child.unref();
                    const deadline = Date.now() + 3000;
                    while (!fs.existsSync(${JSON.stringify(marker)})) {
                        if (Date.now() > deadline) throw new Error('resident process did not become ready');
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    const live = JSON.parse(fs.readFileSync(${JSON.stringify(marker)}, 'utf8'));
                    const stat = fs.readFileSync('/proc/' + live.pid + '/stat', 'utf8');
                    const startTimeTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/u)[19];
                    const unbound = createResidentLeaseInventory({ runId: ${JSON.stringify(runId)},
                        namespace: ${JSON.stringify(namespace)}, sourceState: ${JSON.stringify(sourceState)},
                        ownerBundleId: 'worker', resourceGrant: { cpuUnits: 1, memoryGiB: 0.25 },
                        resourceBudget: { cpuUnits: 2, memoryGiB: 2 },
                        services: [{ id: 'backend', kind: 'process',
                            identity: { pid: live.pid, startTimeTicks }, port: live.port, generation: 'backend-1',
                            health: { status: 'ready', checkedAt: new Date().toISOString() }, observedRssBytes: 4096 }] });
                    writeResidentLeaseDocument(${JSON.stringify(inventoryPath)},
                        bindResidentLeaseEnforcement(unbound, { mode: 'enforced',
                            processScope: { status: 'enforced', path: process.env.FSUSBLOG_CGROUP_BUNDLE_PATH,
                                reservation: unbound.reservation }, containers: {}, boundAt: new Date().toISOString() }));
                    process.stdout.write('resident-producer-ready');`
                : ['resident-untransferred', 'resident-output-untransferred'].includes(variant)
                ? `import fs from 'node:fs'; import { spawn } from 'node:child_process';
                    const child = spawn(process.execPath, ['-e', ${JSON.stringify(residentSource)}],
                        {detached:true,stdio:'ignore'});
                    child.unref();
                    const deadline = Date.now() + 2000;
                    while (!fs.existsSync(${JSON.stringify(marker)})) {
                        if (Date.now() > deadline) process.exit(2);
                        await new Promise(resolve => setTimeout(resolve, 5));
                    }`
                : `import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
        const group = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().slice(3);
        const parent = path.dirname('/sys/fs/cgroup' + group);
        const controls = Object.fromEntries(['cpu.max','cpu.weight','memory.high','memory.max','pids.max']
            .map(name => [name, fs.readFileSync(parent + '/' + name, 'utf8').trim()]));
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, group, controls }));
        const child = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 600)'], { stdio: 'inherit' });
        if (child.status !== 0) throw new Error('owned child failed');
        process.stdout.write('x'.repeat(${outputBytes}));`);
            const phases = [];
            let refusedRegistration = null;
            const workerTier = { id: 'worker', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(payload)}`,
                executionDependsOn: [], services: [], parallelizable: true, exclusiveResources: [], phase: 0,
                resourceClass: 'cpu', cpuUnits: 1, memoryGiB: 0.25, cacheInputs: [],
                executionKey: 'component/service-owner', executionVariant: 'ordinary', coverage: ['ordinary-unit'],
                ...(variant === 'timeout-before-release' ? { budgetMs: 50 } : {}),
                ...(['resident-output-untransferred', 'resident-output-no-inventory',
                    'resident-output-live-transfer'].includes(variant) ? {
                    residentLeaseProducer: true, residentLeaseTarget: 'consumer'
                } : {}) };
            const result = await runDag({
                root, runId, namespace, sourceState, runsRoot: path.join(root, '.tmp/test-runs'),
                tiers: [workerTier, ...(['resident-output-untransferred', 'resident-output-no-inventory',
                    'resident-output-live-transfer'].includes(variant)
                    ? [{ ...workerTier, id: 'consumer', command: variant === 'resident-output-live-transfer'
                        ? `${JSON.stringify(process.execPath)} ${JSON.stringify(consumerPayload)}` : '/bin/true',
                        executionDependsOn: ['worker'],
                        residentLeaseProducer: false, residentLeaseTarget: null, residentLeaseConsumer: true }]
                    : [])],
                maxParallel: 1,
                ...(variant === 'global-before-release' ? { wallClockBudgetMs: 500 } : {}),
                systemResources: { cpuCount: 2, availableCpuUnits: 2, availableMemoryGiB: 2, load1: 0 },
                snapshotWorktree: async () => ({ fingerprint: sourceState.worktreeFingerprint, entries: {} }),
                onSourceState: (value) => bindProductionBuildLayoutSource(layout, value),
                resourceEnforcementMode: 'strict',
                resourceEnforcementOptions: { systemdBoundary: { commandBudgetMs: 5000, startupBudgetMs: 5000,
                    retainBinding(value)
                    {
                        reference = value;
                        return retainProductionBuildResourceBoundary(layout, value, { commandBudgetMs: 5000 });
                    } } },
                retainManagedContainment(authority, tier)
                {
                    if (tier.id === 'worker')
                    {
                        assert.equal(fs.existsSync(marker), false);
                    }
                    assert.equal(authority.phase, 'prepared');
                    assert.equal(inspectProductionSystemdServiceBinding(authority.serviceBinding, { commandBudgetMs: 5000 }).status, 'absent');
                    phases.push('prepared');
                    const acknowledgement = retainProductionBuildServiceContainment(layout, authority);
                    return variant === 'intent-ack-refused' ? { authorityDigest: `sha256:${'0'.repeat(64)}` } : acknowledgement;
                },
                markManagedContainmentCreationAttempt(authority, tier, creationSender)
                {
                    if (tier.id === 'worker')
                    {
                        assert.equal(fs.existsSync(marker), false);
                    }
                    assert.equal(authority.phase, 'prepared');
                    const changed = { ...authority, createdAt: new Date(Date.parse(authority.createdAt) + 1000).toISOString() };
                    assert.throws(() => markProductionBuildServiceCreationAttempt(layout, changed),
                        /service intent differs from its exact private control carrier/u);
                    assert.throws(() => markProductionBuildServiceCreationAttempt(layout, authority),
                        /creation sender is not an exact unit submission/u);
                    assert.throws(() => markProductionBuildServiceCreationAttempt(layout, authority,
                        { ...creationSender, planDigest: `sha256:${'0'.repeat(64)}` }),
                    /creation sender is not an exact unit submission/u);
                    assert.throws(() => markProductionBuildServiceCreationAttempt(layout, authority,
                        { ...creationSender, processIdentity: { ...creationSender.processIdentity, pid: process.pid } }),
                    /creation sender is not an exact unit submission/u);
                    phases.push('create-attempted');
                    const acknowledgement = markProductionBuildServiceCreationAttempt(layout, authority, creationSender);
                    assert.throws(() => markProductionBuildServiceCreationAttempt(layout, authority, creationSender),
                        /differs from its exact unattempted intent/u);
                    return acknowledgement;
                },
                ...(variant === 'resident-output-live-transfer' ? {
                    transferManagedResidentService(authority, transfer)
                    {
                        phases.push('resident-transferred');
                        return transferProductionBuildResidentService(layout, authority, transfer);
                    },
                    settleManagedResidentService(authority, options)
                    {
                        phases.push('resident-settled');
                        return settleProductionBuildResidentService(layout, authority, options);
                    }
                } : {}),
                registerManagedProcess(identity, tier, authority)
                {
                    if (tier.id === 'worker')
                    {
                        assert.equal(fs.existsSync(marker), false, 'payload must remain behind the existing pre-exec gate');
                    }
                    const retained = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')).owner.managedContainmentAuthorities;
                    if (tier.id === 'worker')
                    {
                        assert.equal(retained.length, 1);
                        assert.equal(retained[0].phase, 'create-attempted');
                    }
                    assert.equal(authority.phase, 'pre-exec');
                    phases.push('pre-exec');
                    if (variant === 'registration-refused')
                    {
                        refusedRegistration = { identity, authority };
                        throw new Error('injected independent process registration refusal');
                    }
                    const receipt = registerProductionBuildCompiler(layout, identity, authority);
                    if (variant === 'success')
                    {
                        assert.throws(() => capacity.release('released'), (error) => error.code === 'PRODUCTION_CAPACITY_RETAINED');
                        assert.equal(capacity.receipt.filesystems[0].admittedBytes, 500);
                        const wrong = structuredClone(authority);
                        wrong.serviceBinding.identity.invocationId = '0'.repeat(32);
                        const denied = terminatePhysicalExecutionAuthoritySync({ authority: wrong, reason: 'wrong-invocation-test' });
                        assert.equal(denied.terminated, false);
                        assert.equal(denied.postObservation, 'unverifiable');
                        assert.equal(inspectProductionSystemdServiceBinding(authority.serviceBinding, { commandBudgetMs: 5000 }).status, 'present');
                    }
                    if (variant === 'cancel-before-release')
                    {
                        process.emit('SIGTERM');
                    }
                    if (variant === 'externally-terminated')
                    {
                        const termination = terminatePhysicalExecutionAuthoritySync({ authority, reason: 'owned-pre-exec-termination-test' });
                        assert.equal(termination.terminated, true, termination.reason);
                        assert.equal(termination.postObservation, 'zero-members');
                    }
                    if (variant === 'receipt-refused')
                    {
                        return { ...receipt, owner: { ...receipt.owner, managedContainmentAuthorities: [] } };
                    }
                    return receipt;
                }
            });
            if (variant === 'resident-output-live-transfer')
            {
                assert.equal(result.status, 'success', JSON.stringify(result.checkpoint.failure));
                assert.ok(phases.includes('resident-transferred'));
                assert.ok(phases.includes('resident-settled'));
                assert.equal(result.checkpoint.tiers.worker.physicalExecutionTermination.postObservation, 'resident-transferred');
                assert.equal(result.checkpoint.tiers.consumer.physicalExecutionTermination.postObservation, 'zero-members');
                assert.equal(result.checkpoint.residentResourceLeases.handoff.status, 'consumed');
                assert.equal(result.checkpoint.residentResourceLeases.status, 'released');
                const retained = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')).owner.managedContainmentAuthorities;
                assert.equal(retained.length, 2);
                const producer = retained.find((entry) => entry.phase === 'resident-transferred');
                assert.ok(producer);
                assert.equal(producer.residentTransfer.inventoryDigest,
                    `sha256:${JSON.parse(fs.readFileSync(inventoryPath, 'utf8')).digest}`);
                assert.equal(inspectProductionSystemdServiceBinding(producer.serviceBinding, { commandBudgetMs: 5000 }).status,
                    'absent');
                assert.equal(fs.existsSync(producer.controlRoot.path), false);
                assert.equal(finalizeProductionBuildLayout(layout, { status: 'success' }).owner.state, 'complete');
                assert.equal(capacity.release('released').receipt.state, 'released');
                return;
            }
            if (variant === 'resident-output-no-inventory')
            {
                assert.equal(result.status, 'failure', 'missing resident inventory must not become a service transfer');
                assert.match(result.failure.reason, /resident lease producer did not publish/u);
                assert.deepEqual(phases, ['prepared', 'create-attempted', 'pre-exec']);
                assert.equal(result.checkpoint.tiers.worker.physicalExecutionTermination.postObservation, 'zero-members');
                assert.equal(result.checkpoint.tiers.worker.log.flush.complete, true);
                const retained = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')).owner.managedContainmentAuthorities[0];
                assert.equal(retained.phase, 'pre-exec');
                assert.equal(retained.residentOutput.schema, 'fsusblog.physical-systemd-resident-output.v1');
                assert.equal(inspectProductionSystemdServiceBinding(retained.serviceBinding, { commandBudgetMs: 5000 }).status, 'absent');
                assert.equal(fs.readFileSync(path.join(root, result.checkpoint.tiers.worker.logFile), 'utf8').split('x').length - 1,
                    outputBytes);
                assert.equal(finalizeProductionBuildLayout(layout, { status: 'failure' }).owner.state, 'failed');
                assert.equal(capacity.release('aborted').receipt.state, 'aborted');
                return;
            }
            if (['resident-untransferred', 'resident-output-untransferred'].includes(variant))
            {
                assert.equal(result.status, 'failure', 'a live resident must not be accepted without a durable service transfer');
                const resident = JSON.parse(fs.readFileSync(marker, 'utf8'));
                const retained = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')).owner.managedContainmentAuthorities[0];
                assert.equal(resident.cgroup, retained.serviceBinding.identity.controlGroup);
                if (variant === 'resident-output-untransferred')
                {
                    assert.equal(retained.residentOutput.schema, 'fsusblog.physical-systemd-resident-output.v1');
                    assert.equal(result.checkpoint.tiers.worker.log.flush.complete, true);
                }
                assert.match(result.failure.reason, /parent exited before its process group became empty/u);
                assert.deepEqual(phases, ['prepared', 'create-attempted', 'pre-exec']);
                assert.equal(result.checkpoint.tiers.worker.physicalExecutionTermination.postObservation, 'zero-members');
                assert.equal(inspectProductionSystemdServiceBinding(retained.serviceBinding, { commandBudgetMs: 5000 }).status, 'absent');
                assert.equal(collectProcessIdentity(resident.pid).status, 'unverifiable');
                assert.equal(finalizeProductionBuildLayout(layout, { status: 'failure' }).owner.state, 'failed');
                assert.equal(capacity.release('aborted').receipt.state, 'aborted');
                return;
            }
            if (variant !== 'success')
            {
                assert.equal(result.status, 'failure');
                assert.equal(fs.existsSync(marker), false, 'a refused or expired admission must never execute payload');
                assert.equal(result.checkpoint.tiers.worker.physicalExecutionTermination.terminated, true);
                if (variant === 'registration-refused')
                {
                    assert.ok(refusedRegistration);
                    const deadline = Date.now() + 5000;
                    while (fs.existsSync(`/proc/${refusedRegistration.identity.pid}`) && Date.now() < deadline)
                    {
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    assert.equal(fs.existsSync(`/proc/${refusedRegistration.identity.pid}`), false,
                        'the exact task launcher must become terminal');
                    assert.equal(inspectProductionSystemdServiceBinding(refusedRegistration.authority.serviceBinding,
                        { commandBudgetMs: 5000 }).status, 'absent');
                }
                if (variant === 'timeout-before-release')
                {
                    assert.equal(result.checkpoint.tiers.worker.exitCode, 124);
                    assert.equal(result.checkpoint.tiers.worker.timeoutPhase, 'termination');
                }
                else if (variant === 'global-before-release')
                {
                    assert.equal(result.checkpoint.timedOut, true);
                    assert.equal(result.failure.exitCode, 124);
                    assert.equal(result.failure.timeoutPhase, 'global');
                }
                else
                {
                    assert.match(result.failure.reason, /independent.*(acknowledgement|registration|receipt)|SIGTERM|pre-exec.*ancestry/u);
                }
                assert.equal(finalizeProductionBuildLayout(layout, { status: 'failure' }).owner.state, 'failed');
                assert.equal(capacity.release('aborted').receipt.state, 'aborted');
                return;
            }
            assert.equal(result.status, 'success', JSON.stringify(result.checkpoint.failure));
            assert.deepEqual(phases, ['prepared', 'create-attempted', 'pre-exec']);
            const actual = JSON.parse(fs.readFileSync(marker, 'utf8'));
            const admitted = result.checkpoint.tiers.worker.resourceExecutionAdmission;
            assert.equal(actual.pid, admitted.processIdentity.pid);
            assert.equal(actual.group, admitted.service.controlGroup);
            assert.equal(path.posix.dirname(actual.group), admitted.parent.controlGroup);
            assert.deepEqual(actual.controls, admitted.parent.controls);
            assert.match(actual.controls['cpu.max'], /^[1-9]\d* [1-9]\d*$/u);
            const [quota, period] = actual.controls['cpu.max'].split(' ').map(BigInt);
            assert.equal(quota, period, 'the actual ancestor must enforce exactly the one-CPU scheduler grant');
            const binding = readProductionSystemdResourceBoundaryBinding(reference.context, { reference });
            const expectedLimits = resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 0.25 }, {
                cpuUnits: 2, memoryGiB: 2, memoryPageBytes: binding.owner.runtimeIdentity.memoryPageBytes
            });
            assert.equal(actual.controls['memory.high'], String(0.25 * 1024 ** 3));
            assert.equal(actual.controls['memory.max'], String(expectedLimits.memoryMaxBytes));
            const retained = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')).owner.managedContainmentAuthorities[0];
            assert.deepEqual(retained, result.checkpoint.tiers.worker.physicalExecutionAuthority);
            assert.equal(retained.phase, 'pre-exec');
            assert.equal(inspectProductionSystemdServiceBinding(retained.serviceBinding, { commandBudgetMs: 5000 }).status, 'absent');
            assert.equal(fs.readFileSync(path.join(root, result.checkpoint.tiers.worker.logFile), 'utf8').split('x').length - 1, outputBytes);
            assert.equal(result.checkpoint.tiers.worker.log.flush.complete, true);
            assert.equal(finalizeProductionBuildLayout(layout, { status: 'success' }).owner.state, 'complete');
            assert.equal(capacity.release('released').receipt.state, 'released');
        });
    }
});

test('dead resident controller retries exact output cleanup after recovery process SIGKILL', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    if (spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).status !== 0)
    {
        t.skip('systemd user manager is unavailable');
        return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-resident-recovery-crash-'));
    const referenceFile = path.join(root, 'reference.json');
    const authorityFile = path.join(root, 'authority.json');
    const readyFile = path.join(root, 'ready.json');
    const controllerFile = path.join(root, 'controller.mjs');
    const moduleUrl = (relative) => pathToFileURL(fileURLToPath(new URL(relative, import.meta.url))).href;
    fs.writeFileSync(controllerFile, `import fs from 'node:fs';
        import path from 'node:path';
        import {randomUUID} from 'node:crypto';
        import {createProductionResourceEnforcer} from ${JSON.stringify(moduleUrl('../../tools/test-matrix/production-resource-enforcement.mjs'))};
        import {runPhysicalExecution,loadPhysicalExecutionProcessPolicy,residentServiceTransferSchema} from ${JSON.stringify(moduleUrl('../../tools/test/physical-execution-process-tree.mjs'))};
        import {digestCanonical} from ${JSON.stringify(moduleUrl('../../tools/test-fixtures/receipt/canonical.mjs'))};
        const root=${JSON.stringify(root)}, referenceFile=${JSON.stringify(referenceFile)};
        const authorityFile=${JSON.stringify(authorityFile)}, readyFile=${JSON.stringify(readyFile)};
        const context={root,runId:'resident-recovery-crash',namespace:'component',
            sourceState:{commit:'a'.repeat(40),worktreeFingerprint:'b'.repeat(64)},
            schedulerOwnerToken:randomUUID()};
        const enforcer=await createProductionResourceEnforcer({runId:context.runId,bundleIds:['worker'],mode:'strict',
            machine:{cpuUnits:2,memoryGiB:2},systemdBoundary:{context,commandBudgetMs:5000,startupBudgetMs:5000,
                retainBinding(reference){fs.writeFileSync(referenceFile,JSON.stringify(reference),{mode:0o600});
                    return {bindingDigest:reference.bindingDigest};}}});
        enforcer.update('worker',{cpuUnits:1,memoryGiB:0.25});
        const command=[process.execPath,'-e',"const {spawn}=require('node:child_process');"+
            "const resident=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],"+
            "{detached:true,stdio:'ignore'});resident.unref();process.stdout.write('resident');"];
        const evidence=await runPhysicalExecution({command,cwd:root,resourceBoundary:enforcer.executionBoundary('worker'),
            resourceContext:{...context,bundleId:'worker'},residentServiceOutput:true,
            processOwner:{commandBudgetMs:5000,
                retain:async authority=>({authorityDigest:digestCanonical(authority)}),
                beforeCreation:async (authority,creationSender)=>({authorityDigest:digestCanonical({
                    ...authority,phase:'create-attempted',creationSender})}),
                register:async (_identity,authority)=>({owner:{managedContainmentAuthorities:[authority]}}),
                transfer:async (authority,captured)=>{
                    const residentTransfer={schema:residentServiceTransferSchema,
                        serviceBindingDigest:digestCanonical(authority.serviceBinding),
                        inventoryDigest:'sha256' + ':' + 'a'.repeat(64),
                        memberIdentities:captured.memberIdentities,supervisorIdentity:captured.supervisorIdentity,
                        outputFiles:captured.outputFiles,transferredAt:new Date().toISOString()};
                    const transferred={...authority,phase:'resident-transferred',residentTransfer};
                    fs.writeFileSync(authorityFile,JSON.stringify(transferred),{mode:0o600});
                    return {authorityDigest:digestCanonical(transferred),residentTransfer};}},
            residualRoot:path.join(root,'residuals'),policy:loadPhysicalExecutionProcessPolicy(),stdout:null,stderr:null});
        if(evidence.postObservation!=='resident-transferred')throw new Error('resident was not transferred');
        fs.writeFileSync(readyFile,JSON.stringify({phase:evidence.postObservation}),{mode:0o600});
        await new Promise(()=>setInterval(()=>{},1000));`, { mode: 0o600 });
    const controller = spawn(process.execPath, [controllerFile], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostics = '';
    controller.stderr.on('data', (chunk) => diagnostics += chunk.toString());
    const terminal = new Promise((resolve, reject) =>
    {
        controller.once('error', reject);
        controller.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let reference;
    let authority;
    let completed = false;
    t.after(async () =>
    {
        if (controller.exitCode === null && controller.signalCode === null)
        {
            controller.kill('SIGKILL');
        }
        await terminal;
        if (completed)
        {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(readyFile) && controller.exitCode === null && controller.signalCode === null && Date.now() < deadline)
    {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(readyFile), true, diagnostics);
    reference = JSON.parse(fs.readFileSync(referenceFile, 'utf8'));
    authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
    assert.equal(inspectProductionSystemdServiceBinding(authority.serviceBinding, { commandBudgetMs: 5000 }).status,
        'present');
    controller.kill('SIGKILL');
    assert.equal((await terminal).signal, 'SIGKILL');
    const termination = terminatePhysicalExecutionAuthoritySync({ authority, reason: 'dead-resident-controller-fixture' });
    assert.equal(termination.postObservation, 'zero-members', termination.reason);
    assert.equal(recoverProductionSystemdResourceBoundary(reference.context, { reference, commandBudgetMs: 5000 }).status,
        'removed');
    const crashFile = path.join(root, 'cleanup-crash.mjs');
    fs.writeFileSync(crashFile, `import fs from 'node:fs';
        import {cleanupPhysicalExecutionResourceArtifacts} from ${JSON.stringify(moduleUrl('../../tools/test/physical-execution-process-tree.mjs'))};
        const authority=JSON.parse(fs.readFileSync(${JSON.stringify(authorityFile)},'utf8'));
        const original=fs.unlinkSync;
        fs.unlinkSync=(file)=>{original(file);if(file===${JSON.stringify(path.join(authority.controlRoot.path, 'stderr.log'))})
            process.kill(process.pid,'SIGKILL');};
        cleanupPhysicalExecutionResourceArtifacts([authority],{validateAuthority:()=>({status:'verified'})});`,
    { mode: 0o600 });
    const recovery = spawn(process.execPath, [crashFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    let recoveryDiagnostics = '';
    recovery.stderr.on('data', (chunk) => recoveryDiagnostics += chunk.toString());
    const recoveryTerminal = await new Promise((resolve, reject) =>
    {
        recovery.once('error', reject);
        recovery.once('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(recoveryTerminal.signal, 'SIGKILL', recoveryDiagnostics);
    assert.equal(fs.existsSync(path.join(authority.controlRoot.path, 'stderr.log')), false);
    assert.equal(fs.existsSync(path.join(authority.controlRoot.path, 'resident-cleanup-plan.json')), true);
    assert.equal(fs.existsSync(path.join(authority.controlRoot.path, 'resource-boundary.json')), true);
    const artifacts = cleanupPhysicalExecutionResourceArtifacts([authority], {
        validateAuthority: () => ({ status: 'verified' })
    });
    assert.ok(artifacts.every((entry) => entry.status === 'absent'));
    assert.equal(inspectProductionSystemdResourceBoundary(reference.context, { reference, commandBudgetMs: 5000 }).status,
        'released');
    completed = true;
});

test('real nested service requests share the original resource owner and survive caller cancellation or exit', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    for (const scenario of ['recursive', 'synchronous-sink', 'null-sink', 'cancel', 'caller-exit', 'caller-exit-output'])
    {
        await t.test(scenario, async (t) =>
        {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-nested-service-'));
            const runId = 'nested-service';
            const namespace = 'nested-component';
            const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
            const layout = prepareProductionBuildLayout({ root, runId, namespace, sourceState });
            let reference;
            t.after(() =>
            {
                if (reference)
                {
                    assert.equal(inspectProductionSystemdResourceBoundary(reference.context, { reference, commandBudgetMs: 5000 }).status,
                        'released', `do not delete retained resources for ${root}`);
                }
                fs.rmSync(root, { recursive: true, force: true });
            });
            const physicalModule = new URL('../../tools/test/physical-execution-process-tree.mjs', import.meta.url).href;
            const driver = path.join(root, 'driver.mjs');
            const leaf = path.join(root, 'leaf.mjs');
            const middle = path.join(root, 'middle.mjs');
            const descriptorFile = path.join(root, 'channel.json');
            const resumeFile = path.join(root, 'resume');
            const marker = path.join(root, 'leaf.json');
            const forgedMarker = path.join(root, 'forged');
            fs.writeFileSync(leaf, `import fs from 'node:fs';
                ${scenario === 'caller-exit-output' ? "process.stdout.write('nested-before-disconnect');" : ''}
                fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid,
                    group: fs.readFileSync('/proc/self/cgroup', 'utf8').trim().slice(3) }));
                    ${scenario === 'recursive' ? "process.stdout.write('nested-output'.repeat(100000));"
                    : scenario.endsWith('-sink') ? "process.stdout.write('nested-small-output');" : 'setInterval(() => {}, 1000);'}`);
            fs.writeFileSync(middle, `import { runPhysicalExecution } from ${JSON.stringify(physicalModule)};
                await runPhysicalExecution({ command: [process.execPath, ${JSON.stringify(leaf)}] });`);
            fs.writeFileSync(driver, `import fs from 'node:fs'; import assert from 'node:assert/strict'; import { Writable } from 'node:stream';
                import { runPhysicalExecution } from ${JSON.stringify(physicalModule)};
                const key = 'FSUSBLOG_PHYSICAL_EXECUTION_CHANNEL';
                fs.writeFileSync(${JSON.stringify(descriptorFile)}, process.env[key]);
                while (!fs.existsSync(${JSON.stringify(resumeFile)})) await new Promise(resolve => setTimeout(resolve, 10));
                const original = process.env[key];
                const forged = JSON.parse(original); forged.id = '00000000-0000-4000-8000-000000000000';
                process.env[key] = JSON.stringify(forged);
                await assert.rejects(() => runPhysicalExecution({ command: [process.execPath, ${JSON.stringify(leaf)}] }), /retained service/);
                process.env[key] = original;
                await assert.rejects(() => runPhysicalExecution({ command: [process.execPath, ${JSON.stringify(leaf)}],
                    platform: 'darwin' }), /canonical Linux/);
                delete process.env[key];
                await assert.rejects(() => runPhysicalExecution({ command: [process.execPath, ${JSON.stringify(leaf)}] }), /missing its original owner channel/);
                process.env[key] = original;
                const controller = new AbortController();
                let observedOutput = false;
                const stdout = ${JSON.stringify(scenario)} === 'null-sink' ? null
                    : ${JSON.stringify(scenario)} === 'synchronous-sink' ? { write(chunk) { observedOutput = true; } }
                    : new Writable({ write(chunk, encoding, done) { observedOutput = true; process.stdout.write(chunk, done); } });
                const execution = runPhysicalExecution({ command: [process.execPath,
                    ${JSON.stringify(scenario === 'recursive' ? middle : leaf)}], signal: controller.signal, stdout });
                if (${JSON.stringify(scenario)} === 'recursive') await execution;
                else if (${JSON.stringify(scenario)}.endsWith('-sink')) {
                    const evidence = await execution;
                    assert.equal(evidence.stdout, 'nested-small-output');
                    assert.equal(observedOutput, ${JSON.stringify(scenario)} === 'synchronous-sink');
                }
                else {
                    while (!fs.existsSync(${JSON.stringify(marker)})) await new Promise(resolve => setTimeout(resolve, 10));
                    if (${JSON.stringify(scenario)} === 'caller-exit-output') {
                        while (!observedOutput) await new Promise(resolve => setTimeout(resolve, 10));
                        process.exit(0);
                    }
                    if (${JSON.stringify(scenario)} === 'caller-exit') process.exit(0);
                    controller.abort(new Error('nested cancellation fixture'));
                    await assert.rejects(execution, error => error.physicalExecution?.postObservation === 'zero-members');
                }`);
            const running = runDag({ root, runId, namespace, sourceState, runsRoot: path.join(root, '.tmp/test-runs'),
                tiers: [{ id: 'worker', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(driver)}`,
                    executionDependsOn: [], services: [], parallelizable: true, exclusiveResources: [], phase: 0,
                    resourceClass: 'cpu', cpuUnits: 1, memoryGiB: 0.5, cacheInputs: [],
                    executionKey: 'component/nested-service', executionVariant: 'ordinary', coverage: ['ordinary-unit'] }],
                maxParallel: 1, wallClockBudgetMs: 60_000,
                systemResources: { cpuCount: 2, availableCpuUnits: 2, availableMemoryGiB: 2, load1: 0 },
                snapshotWorktree: async () => ({ fingerprint: sourceState.worktreeFingerprint, entries: {} }),
                onSourceState: (value) => bindProductionBuildLayoutSource(layout, value),
                resourceEnforcementMode: 'strict',
                resourceEnforcementOptions: { systemdBoundary: { commandBudgetMs: 5000, startupBudgetMs: 5000,
                    retainBinding(value)
                    {
                        reference = value;
                        return retainProductionBuildResourceBoundary(layout, value, { commandBudgetMs: 5000 });
                    } } },
                retainManagedContainment: (authority) => retainProductionBuildServiceContainment(layout, authority),
                markManagedContainmentCreationAttempt: (authority, _tier, creationSender) =>
                    markProductionBuildServiceCreationAttempt(layout, authority, creationSender),
                registerManagedProcess: (identity, _tier, authority) => registerProductionBuildCompiler(layout, identity, authority)
            });
            let settled = false;
            const markSettled = () =>
            {
                settled = true;
            };
            running.then(markSettled, markSettled);
            while (!settled && !fs.existsSync(descriptorFile))
            {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.equal(fs.existsSync(descriptorFile), true, JSON.stringify(await (settled ? running : Promise.resolve(null))));
            const descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'));
            const rejected = await new Promise((resolve, reject) =>
            {
                const socket = net.createConnection(descriptor.socket.path);
                socket.setTimeout(5000, () => socket.destroy(new Error('foreign peer rejection timed out')));
                let response = '';
                socket.on('error', reject);
                socket.once('connect', () => socket.write(`${JSON.stringify({ kind: 'run', nonce: descriptor.id,
                    command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(forgedMarker)}, 'bad')`],
                    cwd: root, env: process.env, linuxPrivateNetwork: false, linuxNetworkPolicy: null, linuxReadWritePaths: [] })}\n`));
                socket.on('data', (chunk) =>
                {
                    response += chunk.toString('utf8');
                    if (response.includes('\n'))
                    {
                        socket.destroy();
                        resolve(JSON.parse(response.trim()));
                    }
                });
            });
            assert.equal(rejected.kind, 'error');
            assert.match(rejected.error.message, /not a member/u, 'copied channel cannot replace kernel peer membership');
            assert.equal(fs.existsSync(forgedMarker), false);
            fs.writeFileSync(resumeFile, 'continue');
            const result = await running;
            const incompleteLog = scenario === 'caller-exit-output';
            assert.equal(result.status, incompleteLog ? 'failure' : 'success', JSON.stringify(result.checkpoint.tiers.worker));
            if (incompleteLog)
            {
                assert.match(result.failure.reason, /nested execution output became unverifiable/u);
                assert.equal(result.checkpoint.tiers.worker.physicalExecutionTermination.postObservation, 'zero-members');
            }
            const authorities = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')).owner.managedContainmentAuthorities;
            assert.equal(authorities.length, scenario === 'recursive' ? 3 : 2);
            assert.equal(new Set(authorities.map((authority) => authority.serviceBinding.parent.controlGroup)).size, 1);
            assert.equal(authorities.every((authority) => authority.phase === 'pre-exec'), true);
            for (const authority of authorities)
            {
                assert.equal(inspectProductionSystemdServiceBinding(authority.serviceBinding, { commandBudgetMs: 5000 }).status, 'absent');
            }
            const actual = JSON.parse(fs.readFileSync(marker, 'utf8'));
            assert.equal(path.posix.dirname(actual.group), authorities[0].serviceBinding.parent.controlGroup);
            assert.equal(result.checkpoint.tiers.worker.physicalExecutionNested.records.length, scenario === 'recursive' ? 2 : 1);
            assert.equal(result.checkpoint.tiers.worker.physicalExecutionNested.postObservation, 'zero-members');
            assert.equal(result.checkpoint.tiers.worker.physicalExecutionNested.logComplete, !incompleteLog);
            if (scenario === 'recursive')
            {
                const output = fs.readFileSync(path.join(root, result.checkpoint.tiers.worker.logFile), 'utf8');
                assert.equal(output.split('nested-output').length - 1, 100000, 'nested transport must not truncate or duplicate the authoritative log');
            }
            assert.equal(finalizeProductionBuildLayout(layout, { status: incompleteLog ? 'failure' : 'success' }).owner.state,
                incompleteLog ? 'failed' : 'complete');
        });
    }
});

test('dead build controller recovery terminates only retained nested services and retains an unknown sibling', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const build = await import(new URL('../../tools/test-matrix/production-build-layout.mjs', import.meta.url));
    const scheduler = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-build-crash-'));
    // Execute the actual isolated runtime closure, not scripts borrowed from the source checkout.
    materializeTestMatrixRunner(fileURLToPath(new URL('../..', import.meta.url)), root);
    const runId = 'crashed-nested';
    const layout = build.resolveProductionBuildLayout({ root, runId });
    const referenceFile = path.join(root, 'reference.json');
    const capacityRoot = `${root}-capacity`;
    const capacityFile = path.join(root, 'capacity-reference.json');
    const capacityPlan = { planDigest: `sha256:${'d'.repeat(64)}`, producerDeclarationDigest: `sha256:${'e'.repeat(64)}`,
        producerDeclarations: [], filesystems: [{ filesystemIdentity: 'fixture:crash', canonicalPaths: [root],
            rootIds: ['build-root'], observedFreeBytes: 4096, requestedBytes: 400, safetyBytes: 100 }] };
    const marker = path.join(root, 'leaf.json');
    const modules = Object.fromEntries(['production-build-layout', 'scheduler'].map((name) =>
        [name, pathToFileURL(path.join(root, `tools/test-matrix/${name}.mjs`)).href]));
    const physical = pathToFileURL(path.join(root, 'tools/test/physical-execution-process-tree.mjs')).href;
    const leaf = path.join(root, 'leaf.mjs');
    const middle = path.join(root, 'middle.mjs');
    const worker = path.join(root, 'worker.mjs');
    const controllerFile = path.join(root, 'controller.mjs');
    const fixtureBudgetMs = 60_000;
    const nestedFailureFiles = [worker, middle].map((file) => `${file}.error.json`);
    fs.writeFileSync(leaf, `import fs from 'node:fs'; import { spawn } from 'node:child_process';
        const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid:process.pid, daemonPid:daemon.pid }));
        setInterval(() => {}, 1000);`);
    for (const [file, target] of [[middle, leaf], [worker, middle]])
    {
        fs.writeFileSync(file, `import fs from 'node:fs'; import { runPhysicalExecution } from ${JSON.stringify(physical)};
            runPhysicalExecution({command:[process.execPath,${JSON.stringify(target)}]}).catch(error => {
                fs.writeFileSync(${JSON.stringify(`${file}.error.json`)}, JSON.stringify({name:error.name,message:error.message}), {mode:0o600});
            });
            setInterval(() => {}, 1000);`);
    }
    fs.writeFileSync(controllerFile, `import fs from 'node:fs';
        import * as build from ${JSON.stringify(modules['production-build-layout'])};
        import { runDag } from ${JSON.stringify(modules.scheduler)};
        import { acquireProductionCapacityReservation } from ${JSON.stringify(pathToFileURL(path.join(root, 'tools/test-matrix/production-capacity-reservation.mjs')).href)};
        const root=${JSON.stringify(root)}, runId=${JSON.stringify(runId)}, namespace='crash-component';
        const sourceState={commit:'a'.repeat(40),worktreeFingerprint:'b'.repeat(64)};
        const capacity=acquireProductionCapacityReservation({repositoryRoot:root,runId,
            authorityRoot:${JSON.stringify(capacityRoot)},plan:${JSON.stringify(capacityPlan)},
            candidateIdentityDigest:'sha256:'+'c'.repeat(64),repositoryLeaseOwner:{ownerToken:'crash-capacity-original-lease'},
            remeasureFilesystem:value=>value.observedFreeBytes});
        const layout=build.prepareProductionBuildLayout({root,runId,namespace,sourceState});
        capacity.retainBuildOwner(layout);
        fs.writeFileSync(${JSON.stringify(capacityFile)},JSON.stringify({activeFile:capacity.activeFile,receipt:capacity.receipt}));
        fs.writeFileSync(${JSON.stringify(referenceFile)},JSON.stringify(build.retainProductionBuildCapacityOwner(layout)));
        await runDag({root,runId,namespace,sourceState,runsRoot:root+'/.tmp/test-runs',
            tiers:[{id:'worker',command:${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(worker)}`)},
                executionDependsOn:[],services:[],parallelizable:true,exclusiveResources:[],phase:0,
                resourceClass:'cpu',cpuUnits:1,memoryGiB:0.5,cacheInputs:[],executionKey:'component/crash',
                executionVariant:'ordinary',coverage:['ordinary-unit']}],maxParallel:1,wallClockBudgetMs:${fixtureBudgetMs},
            systemResources:{cpuCount:2,availableCpuUnits:2,availableMemoryGiB:2,load1:0},
            snapshotWorktree:async()=>({fingerprint:sourceState.worktreeFingerprint,entries:{}}),
            onSourceState:value=>build.bindProductionBuildLayoutSource(layout,value),resourceEnforcementMode:'strict',
            resourceEnforcementOptions:{systemdBoundary:{commandBudgetMs:5000,startupBudgetMs:5000,
                retainBinding:reference=>build.retainProductionBuildResourceBoundary(layout,reference,{commandBudgetMs:5000})}},
            retainManagedContainment:authority=>build.retainProductionBuildServiceContainment(layout,authority),
            markManagedContainmentCreationAttempt:(authority,_tier,creationSender)=>
                build.markProductionBuildServiceCreationAttempt(layout,authority,creationSender),
            registerManagedProcess:(identity,tier,authority)=>build.registerProductionBuildCompiler(layout,identity,authority)});`);
    const controller = spawn(process.execPath, [controllerFile], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
    const terminal = new Promise((resolve, reject) =>
    {
        controller.once('error', reject);
        controller.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let authorities = [];
    let resource;
    let unknownUnit;
    let unknownInvocation;
    const systemctl = (args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 5000 });
    t.after(async () =>
    {
        if (controller.exitCode === null && controller.signalCode === null)
        {
            controller.kill('SIGKILL');
        }
        await terminal;
        if (unknownUnit)
        {
            assert.equal(systemctl(['show', '--property=InvocationID', '--value', '--', unknownUnit]).stdout.trim(), unknownInvocation);
            systemctl(['kill', '--kill-who=all', '--signal=SIGKILL', '--', unknownUnit]);
            systemctl(['stop', '--', unknownUnit]);
        }
        if (fs.existsSync(layout.manifestFile))
        {
            authorities = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')).owner.managedContainmentAuthorities;
            resource ??= JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')).owner.managedResourceBoundaries[0];
        }
        for (const authority of [...authorities].reverse())
        {
            assert.equal(terminatePhysicalExecutionAuthoritySync({ authority, reason: 'task-owned-crash-fixture-cleanup' }).terminated, true);
        }
        if (resource)
        {
            recoverProductionSystemdResourceBoundary(resource.reference.context, resource);
            assert.equal(inspectProductionSystemdResourceBoundary(resource.reference.context, resource).status, 'released');
        }
        // Keep owner diagnostics even after successful exact carrier recovery; failed recovery retains its carriers.
        t.diagnostic(`retained interrupted-owner diagnostics: ${root}`);
    });
    // Readiness belongs to the existing scheduler fixture budget, not a shorter second startup gate.
    const deadline = Date.now() + fixtureBudgetMs;
    while (!fs.existsSync(marker) && !nestedFailureFiles.some((file) => fs.existsSync(file))
        && controller.exitCode === null && controller.signalCode === null && Date.now() < deadline)
    {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(marker), true, `actual grandchild must execute before interrupting its controller: ${
        nestedFailureFiles.filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file, 'utf8')).join('; ')
    }`);
    const reference = JSON.parse(fs.readFileSync(referenceFile, 'utf8'));
    const owner = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')).owner;
    authorities = owner.managedContainmentAuthorities;
    resource = owner.managedResourceBoundaries[0];
    assert.equal(authorities.length, 3);
    const leafObservation = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const daemon = collectProcessIdentity(leafObservation.daemonPid);
    assert.equal(daemon.status, 'verified');
    const daemonStat = fs.readFileSync(`/proc/${daemon.pid}/stat`, 'utf8');
    const daemonFields = daemonStat.slice(daemonStat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    assert.equal(Number(daemonFields[2]), daemon.pid, 'detached descendant owns a distinct process group');
    assert.equal(Number(daemonFields[3]), daemon.pid, 'detached descendant owns a distinct session');
    assert.equal(fs.readFileSync(`/proc/${daemon.pid}/cgroup`, 'utf8').trim(),
        `0::${authorities[2].serviceBinding.identity.controlGroup}`);
    assert.throws(() => build.recoverProductionBuildResourceTree(reference), /proven dead controller/u);
    await assert.rejects(() => scheduler.reconcileSchedulerResourceGrants(reference), /proven dead controller/u);
    controller.kill('SIGKILL');
    assert.equal((await terminal).signal, 'SIGKILL');
    assert.equal(processIdentityStatus(daemon).status, 'live', 'daemon must actually survive the original controller');
    assert.equal(inspectProductionSystemdServiceBinding(authorities[2].serviceBinding, { commandBudgetMs: 5000 }).status, 'present');
    assert.equal(build.inspectProductionBuildCapacityOwner(reference).status, 'retained');
    const runDirectory = path.join(root, '.tmp/test-runs', runId);
    const checkpointFile = path.join(runDirectory, 'checkpoint.json');
    const grantFile = path.join(runDirectory, 'resource-grants.json');
    const checkpointBytes = fs.readFileSync(checkpointFile, 'utf8');
    const grantBytes = fs.readFileSync(grantFile, 'utf8');
    assert.deepEqual(JSON.parse(checkpointBytes).resourceUtilization.retainedResourceGrants, {});
    assert.deepEqual(JSON.parse(grantBytes).grants, { worker: { cpuUnits: 1, memoryGiB: 0.5 } });
    const { RunEvidenceObjectStore } = await import(new URL('../../tools/test-matrix/content-addressed-evidence-store.mjs', import.meta.url));
    const store = new RunEvidenceObjectStore({ root: path.join(runDirectory, 'evidence-store'), runId,
        sourceState: { commit: reference.sourceCommit, worktreeFingerprint: reference.worktreeFingerprint } });
    const grantEvent = store.readJournal().filter((entry) => entry.eventType === 'resource-grants-updated').at(-1);
    assert.ok(grantEvent, 'the interrupted real worker grant must survive in the existing durable journal');
    assert.deepEqual(store.readObject(grantEvent.payloadDigest).value.operations.find((operation) =>
        operation.path.join('.') === 'resourceUtilization.resourceGrants').value, JSON.parse(grantBytes));
    assert.equal(JSON.parse(grantBytes).schedulerOwnerToken, owner.schedulerLockIdentity.ownerToken);
    const journalFile = path.join(store.journalsDirectory, `${runId}.jsonl`);
    const journalBytes = fs.readFileSync(journalFile, 'utf8');
    for (const mode of ['fresh', 'resume'])
    {
        let rebound = false;
        let spawned = false;
        await assert.rejects(() => runDag({ root, runId, runsRoot: path.dirname(runDirectory), mode,
            namespace: 'crash-component', targetTierId: 'worker',
            sourceState: { commit: reference.sourceCommit, worktreeFingerprint: reference.worktreeFingerprint },
            snapshotWorktree: async () => ({ fingerprint: reference.worktreeFingerprint, entries: {} }),
            tiers: [{ id: 'worker', command: '/bin/true', executionDependsOn: [], services: [],
                parallelizable: true, exclusiveResources: [], phase: 0, resourceClass: 'cpu',
                cpuUnits: 1, memoryGiB: 0.5, cacheInputs: [], executionKey: 'component/crash',
                executionVariant: 'ordinary', coverage: ['ordinary-unit'] }],
            onSourceState: () => rebound = true,
            executeTier: async () =>
            {
                spawned = true;
                return { code: 0, signal: null };
            }
        }), /unsettled resource grants; independent owner reconciliation required/u);
        assert.equal(rebound, false, `${mode} must reject the interrupted active grant before binding source`);
        assert.equal(spawned, false, `${mode} must not admit a replacement worker`);
        assert.equal(fs.readFileSync(checkpointFile, 'utf8'), checkpointBytes);
        assert.equal(fs.readFileSync(grantFile, 'utf8'), grantBytes);
        assert.equal(fs.readFileSync(journalFile, 'utf8'), journalBytes);
        assert.equal(processIdentityStatus(daemon).status, 'live');
    }
    assert.throws(() => build.recoverProductionBuildResourceTree({ ...reference, sourceCommit: 'c'.repeat(40) }), /reference differs/u);
    await assert.rejects(() => scheduler.reconcileSchedulerResourceGrants({ ...reference, sourceCommit: 'c'.repeat(40) }), /reference differs/u);
    assert.throws(() => build.recoverProductionBuildResourceTree({ ...reference,
        directoryIdentity: { ...reference.directoryIdentity, inode: `${BigInt(reference.directoryIdentity.inode) + 1n}` } }), /reference differs/u);
    const recoveryMarker = path.join(layout.runRoot, '.reclaim.json');
    const ownedMarker = JSON.stringify({ independentRecovery: 'already in progress' });
    fs.writeFileSync(recoveryMarker, ownedMarker, { flag: 'wx', mode: 0o600 });
    try
    {
        assert.throws(() => build.recoverProductionBuildResourceTree(reference), { code: 'EEXIST' });
        assert.equal(fs.readFileSync(recoveryMarker, 'utf8'), ownedMarker);
    }
    finally
    {
        fs.unlinkSync(recoveryMarker);
    }
    const activeMode = fs.statSync(layout.activeFile).mode;
    fs.chmodSync(layout.activeFile, 0o644);
    try
    {
        assert.throws(() => build.recoverProductionBuildResourceTree(reference), /private, literal and singly linked/u);
    }
    finally
    {
        fs.chmodSync(layout.activeFile, activeMode & 0o777);
    }
    const denied = terminatePhysicalExecutionAuthoritySync({ authority: authorities[2], reason: 'revoked-recovery-owner',
        validateAuthority: () => ({ status: 'unverifiable', reason: 'independent owner changed' }) });
    assert.equal(denied.terminated, false);
    assert.match(denied.reason, /independent owner changed/u);
    for (const authority of authorities)
    {
        assert.equal(inspectProductionSystemdServiceBinding(authority.serviceBinding, { commandBudgetMs: 5000 }).status, 'present');
    }
    const plannedUnit = `fsus-crash-unknown-${path.basename(root).replaceAll(/[^a-zA-Z0-9]/gu, '')}.service`;
    const created = spawnSync('systemd-run', ['--user', '--quiet', '--collect', `--unit=${plannedUnit}`,
        `--slice=${authorities[0].serviceBinding.parent.unitName}`, '--property=KillMode=control-group',
        '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(created.status, 0, created.stderr);
    unknownUnit = plannedUnit;
    unknownInvocation = systemctl(['show', '--property=InvocationID', '--value', '--', unknownUnit]).stdout.trim();
    assert.match(unknownInvocation, /^[a-f0-9]{32}$/u);
    assert.throws(() => build.recoverProductionBuildResourceTree(reference), (error) =>
    {
        assert.match(error.message, /resource boundaries remain retained/u);
        assert.equal(error.resourceRecovery.services.length, 3);
        assert.equal(error.resourceRecovery.services.every((entry) => entry.termination.postObservation === 'zero-members'), true);
        return true;
    });
    assert.equal(processIdentityStatus(daemon).status, 'dead', 'exact service recovery must terminate the surviving setsid daemon');
    for (const authority of authorities)
    {
        assert.equal(inspectProductionSystemdServiceBinding(authority.serviceBinding, { commandBudgetMs: 5000 }).status, 'absent');
        assert.equal(fs.existsSync(authority.serviceBinding.identity.path), false, 'actual retained service cgroup is gone');
    }
    assert.equal(systemctl(['is-active', unknownUnit]).stdout.trim(), 'active', 'unknown sibling must not be killed or adopted');
    await assert.rejects(() => scheduler.reconcileSchedulerResourceGrants(reference), /resource boundaries remain retained/u);
    assert.equal(fs.readFileSync(journalFile, 'utf8'), journalBytes, 'unknown sibling cannot authorize journal settlement');
    assert.equal(fs.readFileSync(grantFile, 'utf8'), grantBytes);
    assert.equal(systemctl(['is-active', unknownUnit]).stdout.trim(), 'active');
    assert.equal(build.inspectProductionBuildCapacityOwner(reference).status, 'retained');
    assert.equal(systemctl(['show', '--property=InvocationID', '--value', '--', unknownUnit]).stdout.trim(), unknownInvocation);
    assert.equal(systemctl(['stop', '--', unknownUnit]).status, 0);
    unknownUnit = null;
    recoverProductionSystemdResourceBoundary(resource.reference.context, resource);
    assert.equal(inspectProductionSystemdResourceBoundary(resource.reference.context, resource).status, 'released');
    assert.equal(build.inspectProductionBuildCapacityOwner(reference).status, 'retained',
        'control and channel carriers must retain capacity after actual OS resources are absent');
    assert.equal(build.productionBuildRunIsActive(root, runId), true, 'GC must retain the authority needed for carrier recovery');
    assert.throws(() => build.prepareProductionBuildLayout({ root, runId, fresh: true }), /already active/u);
    const control = authorities[0].controlRoot.path;
    const channel = authorities[0].nestedChannel;
    const roots = [...authorities.map((authority) => authority.controlRoot.path), channel.directory.path];
    const roster = () => roots.map((directory) => ({ directory, files: fs.readdirSync(directory).sort() }));
    const assertCarrierRefusal = (pattern) =>
    {
        const before = roster();
        assert.throws(() => build.inspectProductionBuildCapacityOwner(reference), pattern);
        assert.throws(() => build.recoverProductionBuildResourceTree(reference), pattern);
        assert.deepEqual(roster(), before, 'complete carrier preflight must precede any deletion');
        assert.equal(fs.existsSync(layout.manifestFile), true);
    };
    const extra = path.join(control, 'unknown.txt');
    fs.writeFileSync(extra, 'fixture-owned unknown file', { mode: 0o600, flag: 'wx' });
    try
    {
        assertCarrierRefusal(/control carrier contains unknown files/u);
    }
    finally
    {
        fs.unlinkSync(extra);
    }
    for (const directory of [control, channel.directory.path])
    {
        const retained = `${directory}.fixture-retained`;
        fs.renameSync(directory, retained);
        fs.mkdirSync(directory, { mode: 0o700 });
        try
        {
            assertCarrierRefusal(/carrier (directory )?identity/u);
        }
        finally
        {
            fs.rmdirSync(directory);
            fs.renameSync(retained, directory);
        }
    }
    const sentinel = path.join(root, 'unrelated-sentinel');
    fs.writeFileSync(sentinel, 'must remain untouched', { mode: 0o600, flag: 'wx' });
    for (const linked of [false, true])
    {
        const file = path.join(control, 'command.json');
        const retained = path.join(root, 'retained-command.json');
        fs.renameSync(file, retained);
        if (linked)
        {
            fs.linkSync(sentinel, file);
        }
        else
        {
            fs.symlinkSync(sentinel, file);
        }
        try
        {
            assertCarrierRefusal(/private, singly linked regular files/u);
            assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must remain untouched');
        }
        finally
        {
            fs.unlinkSync(file);
            fs.renameSync(retained, file);
        }
    }
    const extraSocket = path.join(channel.directory.path, 'unknown.sock');
    fs.writeFileSync(extraSocket, 'not a socket', { mode: 0o600, flag: 'wx' });
    try
    {
        assertCarrierRefusal(/channel carrier identity or contents/u);
    }
    finally
    {
        fs.unlinkSync(extraSocket);
    }
    const retainedSocket = path.join(root, 'retained-owner.sock');
    fs.renameSync(channel.socket.path, retainedSocket);
    fs.writeFileSync(channel.socket.path, 'not the retained socket', { mode: 0o600, flag: 'wx' });
    try
    {
        assertCarrierRefusal(/channel socket identity/u);
    }
    finally
    {
        fs.unlinkSync(channel.socket.path);
        fs.renameSync(retainedSocket, channel.socket.path);
    }
    const firstFile = path.join(control, 'admission.json');
    assert.equal(fs.existsSync(firstFile), true);
    assert.throws(() => cleanupPhysicalExecutionResourceArtifacts(authorities, {
        validateAuthority: () => ({ status: fs.existsSync(firstFile) ? 'verified' : 'unverifiable' })
    }), /artifact recovery owner validation failed/u);
    assert.equal(fs.existsSync(firstFile), false, 'injected owner revocation occurs after the first exact removal');
    assert.equal(fs.existsSync(path.join(control, 'resource-boundary.json')), true, 'interrupted cleanup keeps its original binding');
    assert.equal(build.inspectProductionBuildCapacityOwner(reference).status, 'retained');
    const result = build.recoverProductionBuildResourceTree(reference);
    assert.equal(result.status, 'resources-released');
    assert.equal(result.services.length, 3);
    assert.deepEqual(result.retainedArtifacts, []);
    for (const authority of authorities)
    {
        assert.equal(fs.existsSync(authority.controlRoot.path), false);
    }
    assert.equal(fs.existsSync(path.dirname(authorities[0].nestedChannel.socket.path)), false);
    assert.equal(build.inspectProductionBuildCapacityOwner(reference).status, 'retained',
        'OS and carrier absence cannot release capacity while the original scheduler grant is unsettled');
    assert.equal(build.productionBuildRunIsActive(root, runId), true,
        'GC must retain the original build owner needed for journal reconciliation');
    assert.throws(() => build.prepareProductionBuildLayout({ root, runId, fresh: true }), /already active/u);
    assert.equal(fs.readFileSync(grantFile, 'utf8'), grantBytes, 'resource recovery cannot silently clear the scheduler grant');
    assert.equal(fs.readFileSync(journalFile, 'utf8'), journalBytes);
    const senderJournalFile = path.join(layout.runRoot, '.sender-terminal-recovery.json');
    const senderJournalBytes = fs.readFileSync(senderJournalFile, 'utf8');
    const senderJournal = JSON.parse(senderJournalBytes);
    assert.equal(senderJournal.terminals.length, authorities.length);
    assert.equal(senderJournal.terminals.every((entry) => entry.receipt.submission === 'sender-returned'), true);
    const forgedJournal = structuredClone(senderJournal);
    forgedJournal.terminals[0].receipt.signature = `${'A'.repeat(86)}==`;
    fs.writeFileSync(senderJournalFile, `${JSON.stringify(forgedJournal)}\n`);
    try
    {
        assert.throws(() => build.recoverProductionBuildResourceTree(reference),
            /sender terminal journal entry is foreign or invalid/u);
        assert.equal(build.inspectProductionBuildCapacityOwner(reference).status, 'retained');
        assert.equal(fs.readFileSync(grantFile, 'utf8'), grantBytes);
    }
    finally
    {
        fs.writeFileSync(senderJournalFile, senderJournalBytes);
    }
    const retainedSenderJournal = `${senderJournalFile}.fixture-retained`;
    fs.renameSync(senderJournalFile, retainedSenderJournal);
    try
    {
        assert.throws(() => build.recoverProductionBuildResourceTree(reference),
            /independent reconciliation of pending service creation/u);
        assert.equal(build.inspectProductionBuildCapacityOwner(reference).status, 'retained');
    }
    finally
    {
        fs.renameSync(retainedSenderJournal, senderJournalFile);
    }
    const repeated = build.recoverProductionBuildResourceTree(reference);
    assert.equal(repeated.status, 'resources-released');
    assert.equal(repeated.artifacts.length, 4);
    assert.equal(repeated.artifacts.every((entry) => entry.status === 'absent'), true);
    assert.equal(JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')).owner.processTreeReceipt.receiptDigest,
        owner.processTreeReceipt.receiptDigest, 'recovery must not adopt or reseal the interrupted execution as success');
    const originalManifest = fs.readFileSync(layout.manifestFile, 'utf8');
    const originalActive = fs.readFileSync(layout.activeFile, 'utf8');
    const originalCapacity = JSON.parse(fs.readFileSync(capacityFile, 'utf8'));
    const { acquireProductionFreshExclusiveLease } = await import(new URL('../../tools/test-matrix/production-fresh-exclusive-lease.mjs', import.meta.url));
    fs.mkdirSync(path.join(root, '.git'), { mode: 0o700 });
    const recoveryRunId = 'recover-crashed-nested';
    const lease = acquireProductionFreshExclusiveLease({ root, runId: recoveryRunId, targetTierId: 'production',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) } });
    t.after(() => lease.release('failed'));
    const capacityOptions = { repositoryRoot: root, runId: recoveryRunId, authorityRoot: capacityRoot,
        plan: capacityPlan, candidateIdentityDigest: lease.owner.candidateIdentityDigest,
        repositoryLeaseOwner: lease.owner, remeasureFilesystem: (value) => value.observedFreeBytes };
    const forgedLease = acquireProductionCapacityReservation({ ...capacityOptions,
        repositoryLeaseOwner: { ...lease.owner, ownerToken: 'copied-but-not-current-repository-lease' } });
    try
    {
        await assert.rejects(() => forgedLease.reconcilePriorBuildResources(), /live admitted owner and repository lease/u);
        assert.equal(fs.readFileSync(grantFile, 'utf8'), grantBytes);
        assert.equal(fs.readFileSync(journalFile, 'utf8'), journalBytes);
    }
    finally
    {
        forgedLease.release('aborted');
    }
    const recoveryCapacity = acquireProductionCapacityReservation(capacityOptions);
    t.after(() => recoveryCapacity.release('aborted'));
    assert.equal(recoveryCapacity.receipt.filesystems[0].activeReservedBytesBefore, 500,
        'the old reservation stays charged while the next run admits its own capacity');
    const recoveryLock = (identity, changedReference = reference) => ({
        schema: 'fsusblog.production-build-resource-recovery-lock.v1',
        identity, nonce: randomUUID(), reference: changedReference
    });
    for (const [retained, pattern] of [
        [{ independentRecovery: 'unknown owner' }, /foreign, live or unverifiable/u],
        [recoveryLock(currentProcessIdentity()), /foreign, live or unverifiable/u]
    ])
    {
        const bytes = `${JSON.stringify(retained)}\n`;
        fs.writeFileSync(recoveryMarker, bytes, { flag: 'wx', mode: 0o600 });
        try
        {
            await assert.rejects(() => recoveryCapacity.reconcilePriorBuildResources(), pattern);
            assert.equal(fs.readFileSync(recoveryMarker, 'utf8'), bytes,
                'an unknown or live recovery owner must retain its original lock');
            assert.equal(fs.readFileSync(grantFile, 'utf8'), grantBytes);
            assert.equal(fs.readFileSync(journalFile, 'utf8'), journalBytes);
        }
        finally
        {
            fs.unlinkSync(recoveryMarker);
        }
    }
    const priorRecovery = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const priorTerminal = new Promise((resolve, reject) =>
    {
        priorRecovery.once('error', reject);
        priorRecovery.once('exit', (code, signal) => resolve({ code, signal }));
    });
    t.after(async () =>
    {
        if (priorRecovery.exitCode === null && priorRecovery.signalCode === null)
        {
            priorRecovery.kill('SIGKILL');
        }
        await priorTerminal;
    });
    let priorIdentity;
    const priorDeadline = Date.now() + 5000;
    while (Date.now() < priorDeadline)
    {
        priorIdentity = collectProcessIdentity(priorRecovery.pid);
        if (priorIdentity.status === 'verified')
        {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(priorIdentity.status, 'verified');
    priorRecovery.kill('SIGKILL');
    assert.equal((await priorTerminal).signal, 'SIGKILL');
    assert.equal(processIdentityStatus(priorIdentity).status, 'dead');
    const foreignReference = { ...reference, sourceCommit: 'c'.repeat(40) };
    const foreignMarker = `${JSON.stringify(recoveryLock(priorIdentity, foreignReference))}\n`;
    fs.writeFileSync(recoveryMarker, foreignMarker, { flag: 'wx', mode: 0o600 });
    try
    {
        await assert.rejects(() => recoveryCapacity.reconcilePriorBuildResources(), /foreign, live or unverifiable/u);
        assert.equal(fs.readFileSync(recoveryMarker, 'utf8'), foreignMarker);
    }
    finally
    {
        fs.unlinkSync(recoveryMarker);
    }
    const staleMarker = `${JSON.stringify(recoveryLock(priorIdentity))}\n`;
    fs.writeFileSync(recoveryMarker, staleMarker, { flag: 'wx', mode: 0o600 });
    assert.throws(() => build.recoverProductionBuildResourceTree(reference), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(recoveryMarker, 'utf8'), staleMarker,
        'a bare build reference cannot take over even an exact dead recovery lock');
    const blockedCheckpointPublication = `${checkpointFile}.next-${process.pid}`;
    fs.mkdirSync(blockedCheckpointPublication, { mode: 0o700 });
    try
    {
        await assert.rejects(() => recoveryCapacity.reconcilePriorBuildResources(), { code: 'EISDIR' });
        assert.equal(fs.existsSync(recoveryMarker), false,
            'a dead exact lock may be replaced only under the exclusive recovery lease');
        assert.equal(fs.readFileSync(grantFile, 'utf8'), grantBytes);
        assert.equal(fs.existsSync(originalCapacity.activeFile), true,
            'interrupted grant publication must retain the original capacity reservation');
    }
    finally
    {
        fs.rmdirSync(blockedCheckpointPublication);
    }
    assert.throws(() => build.recoverProductionBuildResourceTree(reference, { schedulerRecovery: {} }),
        /acquired scheduler recovery capability/u);
    assert.throws(() => scheduler.completeSchedulerResourceRecovery({}, { reference, schedulerOwner: owner.schedulerLockIdentity }),
        /acquired scheduler recovery capability/u);
    const innerRecoveryLock = path.join(path.dirname(resource.reference.ownerFile), 'recovery.lock');
    const innerRecoveryOwner = path.join(innerRecoveryLock, 'owner.json');
    fs.mkdirSync(innerRecoveryLock, { mode: 0o700 });
    const innerOwnerBytes = `${JSON.stringify({ identity: priorIdentity, nonce: 'a'.repeat(64) })}\n`;
    fs.writeFileSync(innerRecoveryOwner, innerOwnerBytes, { mode: 0o600, flag: 'wx' });
    assert.throws(() => recoverProductionSystemdResourceBoundary(resource.reference.context, resource), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(innerRecoveryOwner, 'utf8'), innerOwnerBytes,
        'the resource adapter cannot take over a dead inner lock without the build recovery lease');
    let interruptedJournal;
    for (const file of [checkpointFile, grantFile])
    {
        const obstruction = `${file}.next-${process.pid}`;
        fs.mkdirSync(obstruction, { mode: 0o700 });
        try
        {
            await assert.rejects(() => recoveryCapacity.reconcilePriorBuildResources(), { code: 'EISDIR' });
            assert.equal(fs.existsSync(innerRecoveryLock), false,
                'the exclusive build recovery lease must reconcile the exact dead inner lock');
            assert.equal(fs.existsSync(originalCapacity.activeFile), true,
                'failed grant publication must preserve the exact original capacity reservation');
            assert.throws(() => build.inspectProductionBuildCapacityOwner(reference), /projection differs from its durable journal/u);
            assert.equal(fs.readFileSync(grantFile, 'utf8'), grantBytes, 'a failed publication must keep the held worker projection');
            const bytes = fs.readFileSync(journalFile, 'utf8');
            if (interruptedJournal)
            {
                assert.equal(bytes, interruptedJournal, 'retry must not append a second release after journal fsync');
            }
            interruptedJournal = bytes;
            assert.equal(bytes.startsWith(journalBytes), true);
            assert.equal(fs.readFileSync(layout.manifestFile, 'utf8'), originalManifest);
        }
        finally
        {
            fs.rmdirSync(obstruction);
        }
    }
    const reconciled = await recoveryCapacity.reconcilePriorBuildResources();
    assert.deepEqual(reconciled, [{ reservationId: originalCapacity.receipt.reservationId,
        runId, status: 'resources-and-grants-released' }]);
    assert.equal(fs.existsSync(originalCapacity.activeFile), false);
    const terminalCapacity = JSON.parse(fs.readFileSync(path.join(capacityRoot, 'terminal',
        `${originalCapacity.receipt.reservationId}.json`), 'utf8'));
    assert.equal(terminalCapacity.state, 'aborted');
    assert.deepEqual(terminalCapacity.buildOwnerReference, originalCapacity.receipt.buildOwnerReference);
    assert.deepEqual(terminalCapacity.ownerIdentity, originalCapacity.receipt.ownerIdentity);
    assert.equal(recoveryCapacity.receipt.filesystems[0].admittedBytes, 500,
        'settling the old owner does not silently release the new reservation');
    const finalGrants = JSON.parse(fs.readFileSync(grantFile, 'utf8'));
    assert.deepEqual(finalGrants.grants, {});
    assert.deepEqual(finalGrants.residentReservation, { cpuUnits: 0, memoryGiB: 0 });
    assert.equal(finalGrants.schedulerOwnerToken, owner.schedulerLockIdentity.ownerToken);
    const finalCheckpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
    assert.equal(finalCheckpoint.status, 'failure', 'cleanup cannot relabel the interrupted run as successful');
    assert.deepEqual(finalCheckpoint.resourceReconciliation.priorResourceGrants, JSON.parse(grantBytes));
    assert.notEqual(finalCheckpoint.resourceReconciliation.recoveryOwner.ownerToken, owner.schedulerLockIdentity.ownerToken);
    assert.equal(build.inspectProductionBuildCapacityOwner(reference).status, 'released');
    assert.equal(build.productionBuildRunIsActive(root, runId), false);
    assert.equal(fs.readFileSync(layout.manifestFile, 'utf8'), originalManifest);
    assert.equal(fs.readFileSync(layout.activeFile, 'utf8'), originalActive);
    const settledJournal = fs.readFileSync(journalFile, 'utf8');
    assert.equal(settledJournal.startsWith(journalBytes), true, 'the original grant journal must remain an exact prefix');
    const retry = await scheduler.reconcileSchedulerResourceGrants(reference);
    assert.equal(retry.status, 'resources-and-grants-released');
    assert.deepEqual(await recoveryCapacity.reconcilePriorBuildResources(), []);
    assert.equal(fs.readFileSync(journalFile, 'utf8'), settledJournal, 'retry must not append a second grant release');
    assert.equal(fs.readFileSync(layout.manifestFile, 'utf8'), originalManifest);
});

test('dead build recovery distinguishes unattempted and submitted service creation', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    for (const interruption of ['before-creation', 'attempted-before-release', 'after-creation',
        'sender-terminal-missing', 'sender-receipt-invalid', 'unexpected-service'])
    {
        await t.test(interruption, async (t) =>
        {
            const build = await import(new URL('../../tools/test-matrix/production-build-layout.mjs', import.meta.url));
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-pending-service-'));
            const runId = 'pending-service';
            const referenceFile = path.join(root, 'references.json');
            const readyFile = path.join(root, 'prepared-service-ready.json');
            const payloadFile = path.join(root, 'business-payload.json');
            const controllerFile = path.join(root, 'controller.mjs');
            const moduleUrl = (relative) => pathToFileURL(fileURLToPath(new URL(relative, import.meta.url))).href;
            fs.writeFileSync(controllerFile, `import fs from 'node:fs';
        import { randomUUID } from 'node:crypto';
        import path from 'node:path';
        import * as build from ${JSON.stringify(moduleUrl('../../tools/test-matrix/production-build-layout.mjs'))};
        import { createSchedulerRunOwner, schedulerCandidateIdentityDigest } from ${JSON.stringify(moduleUrl('../../tools/test-matrix/scheduler-run-owner.mjs'))};
        import { prepareProductionSystemdResourceBoundary } from ${JSON.stringify(moduleUrl('../../tools/test-matrix/production-systemd-resource-boundary.mjs'))};
        import { resolveCgroupLimits } from ${JSON.stringify(moduleUrl('../../tools/test-matrix/production-resource-enforcement.mjs'))};
        import { createPhysicalExecutionLinuxSystemdAdapter } from ${JSON.stringify(moduleUrl('../../tools/test/physical-execution-linux-systemd-adapter.mjs'))};
        import { currentProcessIdentity } from ${JSON.stringify(moduleUrl('../../tools/test/process-identity.mjs'))};
        import { loadPhysicalExecutionProcessPolicy, physicalExecutionProcessTreeSchema } from ${JSON.stringify(moduleUrl('../../tools/test/physical-execution-process-tree.mjs'))};
        const root=${JSON.stringify(root)}, runId=${JSON.stringify(runId)}, namespace='pending-component';
        const sourceState={commit:'a'.repeat(40),worktreeFingerprint:'b'.repeat(64)};
        const layout=build.prepareProductionBuildLayout({root,runId,namespace,sourceState});
        const capacityReference=build.retainProductionBuildCapacityOwner(layout);
        const targetTierId='pending-component', ownerToken=randomUUID();
        const lock=path.join(root,'.tmp/test-runs/.locks',runId+'.lock');
        fs.mkdirSync(lock,{recursive:true,mode:0o700});
        fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify(createSchedulerRunOwner({runId,targetTierId,
            candidateIdentityDigest:schedulerCandidateIdentityDigest({runId,targetTierId,namespace,sourceState}),
            ownerToken,identity:currentProcessIdentity()})),{mode:0o600});
        build.bindProductionBuildLayoutSource(layout,sourceState);
        const context={root,runId,namespace,bundleId:'pending-bundle',sourceState,schedulerOwnerToken:ownerToken};
        const resource=await prepareProductionSystemdResourceBoundary(context,{commandBudgetMs:5000,startupBudgetMs:5000,
            retainBinding:reference=>build.retainProductionBuildResourceBoundary(layout,reference,{commandBudgetMs:5000})});
        resource.update(resolveCgroupLimits({cpuUnits:0.5,memoryGiB:0.25},{cpuUnits:2,memoryGiB:2,
            memoryPageBytes:resource.evidence().owner.runtimeIdentity.memoryPageBytes}));
        fs.writeFileSync(${JSON.stringify(referenceFile)},JSON.stringify({capacityReference,resourceReference:resource.reference}));
        const adapter=createPhysicalExecutionLinuxSystemdAdapter();
        await adapter.run({command:[process.execPath,'-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(payloadFile)}, 'executed')`)}],
            cwd:root,env:process.env,controlEnv:process.env,
            policy:loadPhysicalExecutionProcessPolicy(${JSON.stringify(fileURLToPath(new URL('../../config/testing/physical-execution-process-policy.json', import.meta.url)))}),
            stdout:process.stdout,stderr:process.stderr,schema:physicalExecutionProcessTreeSchema,
            resourceBoundary:resource.executionBoundary(),resourceContext:context,
            processOwner:{commandBudgetMs:5000,
                retain:authority=>build.retainProductionBuildServiceContainment(layout,authority),
                beforeCreation:async (authority,creationSender)=>{
                    if (${JSON.stringify(interruption)}==='attempted-before-release') {
                        const acknowledgement=build.markProductionBuildServiceCreationAttempt(layout,authority,creationSender);
                        fs.writeFileSync(${JSON.stringify(readyFile)},JSON.stringify({phase:'create-attempted-gated'}));
                        await new Promise(()=>setInterval(()=>{},1000));
                        return acknowledgement;
                    }
                    if (!['after-creation','sender-terminal-missing','sender-receipt-invalid']
                        .includes(${JSON.stringify(interruption)})) {
                        fs.writeFileSync(${JSON.stringify(readyFile)},JSON.stringify({phase:'prepared'}));
                        await new Promise(()=>setInterval(()=>{},1000));
                    }
                    return build.markProductionBuildServiceCreationAttempt(layout,authority,creationSender);
                },
                register:async()=>{fs.writeFileSync(${JSON.stringify(readyFile)},JSON.stringify({phase:'prepared'}));
                    await new Promise(()=>{});}}});`);
            const controller = spawn(process.execPath, [controllerFile], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
            const terminal = new Promise((resolve, reject) =>
            {
                controller.once('error', reject);
                controller.once('exit', (code, signal) => resolve({ code, signal }));
            });
            let authority;
            let resourceReference;
            t.after(async () =>
            {
                if (controller.exitCode === null && controller.signalCode === null)
                {
                    controller.kill('SIGKILL');
                }
                await terminal;
                const layout = build.resolveProductionBuildLayout({ root, runId });
                if (fs.existsSync(layout.manifestFile))
                {
                    const owner = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')).owner;
                    authority ??= owner.managedContainmentAuthorities[0];
                    resourceReference ??= owner.managedResourceBoundaries[0]?.reference;
                }
                if (authority)
                {
                    assert.equal(terminatePhysicalExecutionAuthoritySync({ authority, reason: 'pending-fixture-teardown' }).terminated, true);
                }
                if (resourceReference)
                {
                    assert.equal(recoverProductionSystemdResourceBoundary(resourceReference.context, {
                        reference: resourceReference, commandBudgetMs: 5000
                    }).status, 'removed');
                }
                if (authority && resourceReference)
                {
                    cleanupPhysicalExecutionResourceArtifacts([authority], { validateAuthority: () => ({ status: 'verified' }) });
                }
                fs.rmSync(root, { recursive: true, force: true });
            });
            const deadline = Date.now() + 30_000;
            while (!fs.existsSync(readyFile) && controller.exitCode === null && controller.signalCode === null && Date.now() < deadline)
            {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.equal(fs.existsSync(readyFile), true, 'the real service must reach the prepared-to-pre-exec interruption window');
            assert.equal(fs.existsSync(payloadFile), false, 'business payload remains behind the pre-exec gate');
            const { capacityReference, resourceReference: retainedResource } = JSON.parse(fs.readFileSync(referenceFile, 'utf8'));
            resourceReference = retainedResource;
            const layout = build.resolveProductionBuildLayout({ root, runId });
            authority = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')).owner.managedContainmentAuthorities[0];
            assert.equal(authority.phase,
                ['attempted-before-release', 'after-creation', 'sender-terminal-missing', 'sender-receipt-invalid']
                    .includes(interruption) ? 'create-attempted' : 'prepared');
            assert.equal(inspectProductionSystemdServiceBinding(authority.serviceBinding, { commandBudgetMs: 5000 }).status,
                ['after-creation', 'sender-terminal-missing', 'sender-receipt-invalid']
                    .includes(interruption) ? 'present' : 'absent');
            controller.kill('SIGKILL');
            assert.equal((await terminal).signal, 'SIGKILL');
            if (interruption === 'unexpected-service')
            {
                const binding = authority.serviceBinding;
                const started = spawnSync('systemd-run', ['--user', '--quiet', '--collect', '--service-type=exec',
                    `--property=Slice=${binding.parent.unitName}`, `--property=Description=${binding.description}`,
                    `--unit=${binding.unitName.slice(0, -'.service'.length)}`, '/bin/sleep', '30'],
                { encoding: 'utf8', timeout: 5000 });
                assert.equal(started.status, 0, started.stderr);
                assert.equal(inspectProductionSystemdServiceBinding(binding, { commandBudgetMs: 5000 }).status, 'present');
                assert.throws(() => build.recoverProductionBuildResourceTree(capacityReference), (error) =>
                    /unattempted service unexpectedly exists/u.test(error.message)
                    && error.resourceRecovery?.services.length === 0
                    && error.resourceRecovery?.resources.length === 0);
                assert.equal(inspectProductionSystemdResourceBoundary(resourceReference.context, {
                    reference: resourceReference, commandBudgetMs: 5000
                }).status, 'retained');
                assert.equal(fs.existsSync(path.join(layout.runRoot, '.reclaim.json')), false);
                assert.equal(fs.existsSync(payloadFile), false);
                return;
            }
            if (interruption === 'before-creation')
            {
                const report = build.recoverProductionBuildResourceTree(capacityReference);
                assert.equal(report.status, 'resources-released');
                assert.equal(report.services.length, 1);
                assert.equal(report.services[0].phase, 'prepared');
                assert.equal(report.services[0].termination.terminated, true);
                assert.equal(report.services[0].termination.postObservation, 'zero-members');
                assert.equal(report.resources.length, 1);
                assert.equal(report.retainedArtifacts.length, 0);
                assert.equal(inspectProductionSystemdResourceBoundary(resourceReference.context, {
                    reference: resourceReference, commandBudgetMs: 5000
                }).status, 'released');
                assert.equal(fs.existsSync(layout.activeFile), true,
                    'resource cleanup does not seal or delete the separate build owner');
                assert.equal(fs.existsSync(payloadFile), false);
                return;
            }
            if (interruption === 'attempted-before-release')
            {
                const receiptFile = path.join(authority.controlRoot.path, 'sender-terminal.json');
                const deadline = Date.now() + 10_000;
                while ((!fs.existsSync(receiptFile)
                    || processIdentityStatus(authority.creationSender.processIdentity).status !== 'dead')
                    && Date.now() < deadline)
                {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                assert.equal(fs.existsSync(receiptFile), true);
                const report = build.recoverProductionBuildResourceTree(capacityReference);
                assert.equal(report.status, 'resources-released');
                assert.equal(report.services[0].senderTerminal.status, 'terminal');
                assert.equal(report.services[0].senderTerminal.submission, 'not-submitted');
                assert.equal(report.services[0].termination.postObservation, 'zero-members');
                assert.equal(report.resources.length, 1);
                assert.equal(fs.existsSync(payloadFile), false);
                return;
            }
            if (interruption === 'after-creation')
            {
                const report = build.recoverProductionBuildResourceTree(capacityReference);
                assert.equal(report.status, 'resources-released');
                assert.equal(report.services.length, 1);
                assert.equal(report.services[0].phase, 'create-attempted');
                assert.equal(report.services[0].senderTerminal.status, 'terminal');
                assert.equal(report.services[0].senderTerminal.submission, 'sender-returned');
                assert.equal(report.services[0].termination.postObservation, 'zero-members');
                assert.equal(report.resources.length, 1);
                assert.equal(report.retainedArtifacts.length, 0);
                assert.equal(inspectProductionSystemdResourceBoundary(resourceReference.context, {
                    reference: resourceReference, commandBudgetMs: 5000
                }).status, 'released');
                assert.equal(fs.existsSync(payloadFile), false);
                return;
            }
            if (interruption === 'sender-receipt-invalid')
            {
                assert.equal(terminatePhysicalExecutionAuthoritySync({ authority,
                    reason: 'invalid-receipt-fixture-stop' }).terminated, true);
                const receiptFile = path.join(authority.controlRoot.path, 'sender-terminal.json');
                const deadline = Date.now() + 10_000;
                while ((!fs.existsSync(receiptFile)
                    || processIdentityStatus(authority.creationSender.processIdentity).status !== 'dead')
                    && Date.now() < deadline)
                {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                assert.equal(fs.existsSync(receiptFile), true);
                const forged = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
                forged.signature = `${'A'.repeat(86)}==`;
                fs.writeFileSync(receiptFile, `${JSON.stringify(forged)}\n`);
                assert.throws(() => build.recoverProductionBuildResourceTree(capacityReference), (error) =>
                    /terminal receipt is invalid or foreign/u.test(error.message)
                    && error.resourceRecovery?.services.length === 0
                    && error.resourceRecovery?.resources.length === 0);
                assert.equal(inspectProductionSystemdResourceBoundary(resourceReference.context, {
                    reference: resourceReference, commandBudgetMs: 5000
                }).status, 'retained');
                assert.equal(build.inspectProductionBuildCapacityOwner(capacityReference).status, 'retained');
                assert.equal(fs.existsSync(payloadFile), false);
                return;
            }
            assert.equal(interruption, 'sender-terminal-missing');
            const senderIdentity = authority.creationSender.processIdentity;
            assert.equal(processIdentityStatus(senderIdentity).status, 'live');
            process.kill(senderIdentity.pid, 'SIGKILL');
            assert.throws(() => build.recoverProductionBuildResourceTree(capacityReference), (error) =>
                /independent reconciliation of pending service creation/u.test(error.message)
        && error.resourceRecovery?.services?.length === 1
        && error.resourceRecovery.services[0].phase === 'create-attempted'
        && error.resourceRecovery.services[0].termination.terminated === true
        && error.resourceRecovery.services[0].termination.postObservation === 'zero-members'
        && error.resourceRecovery.resources.length === 0);
            assert.equal(inspectProductionSystemdServiceBinding(authority.serviceBinding, { commandBudgetMs: 5000 }).status, 'absent');
            assert.equal(inspectProductionSystemdResourceBoundary(resourceReference.context, {
                reference: resourceReference, commandBudgetMs: 5000
            }).status, 'retained', 'unresolved creation cannot release the parent resource boundary');
            assert.equal(build.inspectProductionBuildCapacityOwner(capacityReference).status, 'retained');
            assert.equal(fs.existsSync(path.join(layout.runRoot, '.reclaim.json')), false);
            assert.throws(() => build.recoverProductionBuildResourceTree(capacityReference), (error) =>
                /independent reconciliation of pending service creation/u.test(error.message)
        && error.resourceRecovery?.services?.[0]?.status === 'pending-creation-unresolved'
        && error.resourceRecovery.services[0].termination === null
        && error.resourceRecovery.resources.length === 0,
            'an absent prepared service is not proof that its creation request can never complete');
            assert.equal(build.inspectProductionBuildCapacityOwner(capacityReference).status, 'retained');
            assert.equal(fs.existsSync(path.join(layout.runRoot, '.reclaim.json')), false);
            assert.equal(fs.existsSync(payloadFile), false);
        });
    }
});

test('service admission requires a live owner capability and exact service, process and ancestor observations', async (t) =>
{
    for (const variant of ['valid', 'description', 'parent', 'invocation', 'membership', 'process-move', 'controls', 'dead-controller'])
    {
        await t.test(variant, async (subtest) =>
        {
            const fixture = fakeSystemdBoundary(subtest);
            const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
            const limits = resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 });
            owner.update(limits);
            const boundary = owner.executionBoundary();
            const authorityId = '22222222-2222-4222-8222-222222222222';
            const unitName = `fsusblog-physical-${authorityId.replaceAll('-', '')}.service`;
            let unit = null;
            let group = null;
            const inspect = fixture.transport.inspect;
            const cgroup = fixture.transport.cgroup;
            fixture.transport.inspect = (name) => name === unitName ? structuredClone(unit ?? {
                ActiveState: 'inactive', ControlGroup: '', FragmentPath: '', DropInPaths: '', Transient: 'no', InvocationID: ''
            }) : inspect(name);
            fixture.transport.cgroup = (name, options) => name === group?.controlGroup ? structuredClone(group) : cgroup(name, options);
            fixture.transport.serviceProcess = (identity) =>
            {
                assert.deepEqual(identity, fixture.launcherProcess);
                return { controlGroup: variant === 'process-move' ? '/outside' : group.controlGroup };
            };
            assert.throws(() => prepareProductionSystemdServiceAdmission(structuredClone(boundary), { unitName, authorityId }), /live resource-owner capability/u);
            assert.throws(() => prepareProductionSystemdServiceAdmission(boundary, { unitName: 'wrong.service', authorityId }), /exact process authority/u);
            for (const mismatch of [{ runId: 'other-run' }, { bundleId: 'other-bundle' }, { namespace: 'other' },
                { schedulerOwnerToken: '33333333-3333-4333-8333-333333333333' }, { sourceState: { ...fixture.context.sourceState, commit: 'c'.repeat(40) } }])
            {
                assert.throws(() => prepareProductionSystemdServiceAdmission(boundary, {
                    unitName, authorityId, expectedContext: { ...fixture.context, ...mismatch }
                }), /execution context differs/u);
            }
            const admission = prepareProductionSystemdServiceAdmission(boundary, { unitName, authorityId, expectedContext: fixture.context });
            assert.equal(inspectProductionSystemdServiceBinding(admission.serviceBinding, { transport: fixture.transport }).status, 'absent');
            const controlGroup = `${fixture.unit.ControlGroup}/${unitName}`;
            unit = { ActiveState: 'active', Transient: 'yes', Description: admission.description, Slice: boundary.admission.unitName,
                ControlGroup: controlGroup, FragmentPath: `/run/user/${process.getuid()}/systemd/transient/${unitName}`,
                DropInPaths: '', InvocationID: 'f'.repeat(32) };
            group = { controlGroup, path: path.join(fixture.group.path, unitName), device: 1, inode: 2,
                processIds: [fixture.launcherProcess.pid] };
            const retainedBinding = { ...admission.serviceBinding, identity: admission.assertOwnedOrAbsent().identity };
            assert.equal(inspectProductionSystemdServiceBinding(retainedBinding, { transport: fixture.transport }).status, 'present');
            assert.throws(() => prepareProductionSystemdServiceAdmission(boundary, { unitName, authorityId, expectedContext: fixture.context }), /existing unit/u);
            if (variant === 'description')
            {
                unit.Description = 'unowned';
            }
            if (variant === 'parent')
            {
                unit.Slice = 'app.slice';
            }
            if (variant === 'invocation')
            {
                unit.InvocationID = '0'.repeat(32);
            }
            if (variant === 'membership')
            {
                group.processIds = [];
            }
            if (variant === 'controls')
            {
                fixture.group.controls['cpu.max'] = 'max 100000';
            }
            if (variant === 'dead-controller')
            {
                fixture.setControllerStatus('dead');
            }
            if (['description', 'parent', 'invocation'].includes(variant))
            {
                assert.throws(() => inspectProductionSystemdServiceBinding(retainedBinding, { transport: fixture.transport }),
                    /exact process-owner binding|invocation, cgroup or artifacts changed/u);
            }
            if (variant === 'valid')
            {
                const observed = admission.admit(fixture.launcherProcess, controlGroup);
                assert.deepEqual(observed.parent.controls, fixture.group.controls);
                assert.equal(observed.service.controlGroup, controlGroup);
            }
            else
            {
                assert.throws(() => admission.admit(fixture.launcherProcess, controlGroup), /binding|changed|ancestry|live original controller/u);
            }
            assert.throws(() => admission.admit(fixture.launcherProcess, controlGroup), /one-shot/u);
            if (variant === 'controls')
            {
                assert.ok(admission.assertOwnedOrAbsent(), 'quota drift must not steal exact process cleanup authority');
            }
        });
    }
});

test('systemd resource creation rejects an unacknowledged binding or existing unit before creation', async (t) =>
{
    const unacknowledged = fakeSystemdBoundary(t);
    await assert.rejects(() => prepareProductionSystemdResourceBoundary(unacknowledged.context, {
        ...unacknowledged.options, retainBinding: async () => ({ bindingDigest: `sha256:${'0'.repeat(64)}` })
    }), /exact binding/u);
    assert.deepEqual(unacknowledged.events, []);
    const existing = fakeSystemdBoundary(t);
    existing.transport.inspect = () => ({ ActiveState: 'active', Transient: 'yes' });
    await assert.rejects(() => prepareProductionSystemdResourceBoundary(existing.context, existing.options), /existing unit/u);
    assert.deepEqual(existing.events, []);
    assert.equal(fs.existsSync(path.join(existing.context.root, '.tmp/production-resource-owners')), false);
});

test('systemd resource update failure invalidates admission and preserves a recoverable owner record', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
    const limits = resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 });
    owner.update(limits);
    fixture.transport.setLimits = () =>
    {
        fixture.group.controls['cpu.max'] = 'max 100000';
        throw new Error('injected partial manager update');
    };
    assert.throws(() => owner.update(limits), /injected partial/u);
    assert.throws(() => owner.assertAdmitted(), /no verified current grant/u);
    assert.equal(owner.evidence().state.phase, 'update-attempted');
    assert.equal(owner.cleanup().status, 'removed');
});

test('systemd resource identity drift and unowned drop-ins cannot authorize updates or cleanup', async (t) =>
{
    for (const change of ['manager', 'invocation', 'cgroup', 'description', 'drop-in'])
    {
        const fixture = fakeSystemdBoundary(t);
        const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
        if (change === 'manager')
        {
            fixture.runtime.busOwner = ':1.9';
        }
        if (change === 'invocation')
        {
            fixture.unit.InvocationID = 'e'.repeat(32);
        }
        if (change === 'cgroup')
        {
            fixture.group.inode += 1;
        }
        if (change === 'description')
        {
            fixture.unit.Description = 'other owner';
        }
        if (change === 'drop-in')
        {
            fixture.unit.DropInPaths = `${fixture.unit.FragmentPath}.d/unowned.conf`;
        }
        assert.throws(() => owner.cleanup(), /retained creation binding|ownership binding|identity changed/u);
        assert.equal(fixture.events.includes('stop'), false);
    }
});

test('systemd resource cleanup rejects changed, linked or public authority records', async (t) =>
{
    for (const change of ['bytes', 'symlink', 'hardlink', 'permissions'])
    {
        const fixture = fakeSystemdBoundary(t);
        const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
        const file = owner.reference.ownerFile;
        if (change === 'bytes')
        {
            fs.appendFileSync(file, '\n');
        }
        if (change === 'permissions')
        {
            fs.chmodSync(file, 0o644);
        }
        if (change === 'hardlink')
        {
            fs.linkSync(file, `${file}.linked`);
        }
        if (change === 'symlink')
        {
            fs.renameSync(file, `${file}.saved`);
            fs.symlinkSync(`${file}.saved`, file);
        }
        assert.throws(() => owner.cleanup(), /retained authority changed|symlink|one link|private/u);
        assert.equal(fixture.events.includes('stop'), false);
    }
});

test('empty systemd resource recovery requires dead controller and exact independently retained context', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
    const options = { reference: owner.reference, transport: fixture.transport, observeController: fixture.options.observeController };
    for (const status of ['live', 'mismatch', 'unverifiable'])
    {
        fixture.setControllerStatus(status);
        assert.throws(() => recoverProductionSystemdResourceBoundary(fixture.context, options), /proven dead controller/u);
    }
    fixture.setControllerStatus('dead');
    assert.throws(() => recoverProductionSystemdResourceBoundary(fixture.context, {
        ...options, reference: { ...owner.reference, bindingDigest: `sha256:${'0'.repeat(64)}` }
    }), /independently retained/u);
    fixture.group.populated = true;
    assert.equal(recoverProductionSystemdResourceBoundary(fixture.context, options).status, 'retained-active');
    assert.equal(fixture.events.includes('stop'), false);
    fixture.group.populated = false;
    assert.equal(recoverProductionSystemdResourceBoundary(fixture.context, options).status, 'removed');
    assert.equal(fs.existsSync(path.join(path.dirname(owner.reference.ownerFile), 'recovery.lock')), false);
});

test('interrupted systemd resource recovery replaces only an exact dead inner lock under a live recovery guard', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
    fixture.setControllerStatus('dead');
    const options = { reference: owner.reference, transport: fixture.transport,
        observeController: fixture.options.observeController };
    const previous = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const terminal = new Promise((resolve, reject) =>
    {
        previous.once('error', reject);
        previous.once('exit', (code, signal) => resolve({ code, signal }));
    });
    t.after(async () =>
    {
        if (previous.exitCode === null && previous.signalCode === null)
        {
            previous.kill('SIGKILL');
        }
        await terminal;
    });
    let previousIdentity;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline)
    {
        previousIdentity = collectProcessIdentity(previous.pid);
        if (previousIdentity.status === 'verified')
        {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(previousIdentity.status, 'verified');
    previous.kill('SIGKILL');
    assert.equal((await terminal).signal, 'SIGKILL');
    assert.equal(processIdentityStatus(previousIdentity).status, 'dead');
    const lock = path.join(path.dirname(owner.reference.ownerFile), 'recovery.lock');
    const lockFile = path.join(lock, 'owner.json');
    fs.mkdirSync(lock, { mode: 0o700 });
    const writeLock = (identity, nonce = 'a'.repeat(64)) =>
        fs.writeFileSync(lockFile, `${JSON.stringify({ identity, nonce })}\n`, { mode: 0o600, flag: 'wx' });
    const guard = () => ({ status: 'verified' });
    assert.throws(() => recoverProductionSystemdResourceBoundary(fixture.context, {
        ...options, validateRecoveryAuthority: guard
    }), /unknown entries/u, 'an interrupted lock without an owner record cannot be adopted');
    assert.deepEqual(fs.readdirSync(lock), []);
    assert.equal(fixture.events.includes('stop'), false);
    for (const record of [
        { identity: previousIdentity, nonce: 'not-an-owner-nonce' },
        { identity: currentProcessIdentity(), nonce: 'a'.repeat(64) }
    ])
    {
        writeLock(record.identity, record.nonce);
        const original = fs.readFileSync(lockFile, 'utf8');
        assert.throws(() => recoverProductionSystemdResourceBoundary(fixture.context, {
            ...options, validateRecoveryAuthority: guard
        }), /foreign, live or unverifiable/u);
        assert.equal(fs.readFileSync(lockFile, 'utf8'), original);
        assert.equal(fixture.events.includes('stop'), false);
        fs.unlinkSync(lockFile);
    }
    writeLock(previousIdentity);
    const retained = fs.readFileSync(lockFile, 'utf8');
    const foreignFile = path.join(lock, 'unknown.txt');
    fs.writeFileSync(foreignFile, 'foreign', { mode: 0o600, flag: 'wx' });
    assert.throws(() => recoverProductionSystemdResourceBoundary(fixture.context, {
        ...options, validateRecoveryAuthority: guard
    }), /unknown entries/u);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), retained);
    fs.unlinkSync(foreignFile);
    const savedOwner = `${lock}.saved-owner`;
    fs.renameSync(lockFile, savedOwner);
    fs.symlinkSync(savedOwner, lockFile);
    try
    {
        assert.throws(() => recoverProductionSystemdResourceBoundary(fixture.context, {
            ...options, validateRecoveryAuthority: guard
        }), /private|literal|one link|symlink/u);
        assert.equal(fs.readFileSync(savedOwner, 'utf8'), retained);
    }
    finally
    {
        fs.unlinkSync(lockFile);
        fs.renameSync(savedOwner, lockFile);
    }
    assert.throws(() => recoverProductionSystemdResourceBoundary(fixture.context, options), { code: 'EEXIST' });
    assert.throws(() => recoverProductionSystemdResourceBoundary(fixture.context, {
        ...options, validateRecoveryAuthority: () => ({ status: 'unverifiable' })
    }), /authority is no longer exclusive/u);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), retained);
    assert.equal(fixture.events.includes('stop'), false);
    let validations = 0;
    assert.equal(recoverProductionSystemdResourceBoundary(fixture.context, {
        ...options, validateRecoveryAuthority: () =>
        {
            validations += 1;
            return { status: 'verified' };
        }
    }).status, 'removed');
    assert.ok(validations > 3, 'the guard must be rechecked across takeover, effects and lock removal');
    assert.equal(fs.existsSync(lock), false);
    assert.deepEqual(fixture.events, ['retain', 'start', 'stop']);
});

test('systemd resource preparation failure after creation removes only its exact empty transient unit', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const start = fixture.transport.start;
    fixture.transport.start = (...args) =>
    {
        start(...args);
        throw new Error('injected interruption after creation');
    };
    await assert.rejects(() => prepareProductionSystemdResourceBoundary(fixture.context, fixture.options), (error) =>
    {
        assert.match(error.message, /interruption after creation/u);
        assert.equal(error.resourceCleanup.status, 'removed');
        return true;
    });
    assert.deepEqual(fixture.events, ['retain', 'start', 'stop']);
});

test('systemd authority changed during external retention cannot create or adopt a unit', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const retain = fixture.options.retainBinding;
    await assert.rejects(() => prepareProductionSystemdResourceBoundary(fixture.context, {
        ...fixture.options,
        async retainBinding(reference)
        {
            const acknowledgement = await retain(reference);
            fs.appendFileSync(reference.ownerFile, '\n');
            return acknowledgement;
        }
    }), /retained authority changed/u);
    assert.deepEqual(fixture.events, ['retain']);
});

test('systemd resource recovery cannot cross context or steal an interrupted recovery lock', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
    fixture.setControllerStatus('dead');
    const options = { reference: owner.reference, transport: fixture.transport, observeController: fixture.options.observeController };
    for (const field of ['runId', 'namespace', 'bundleId', 'schedulerOwnerToken'])
    {
        const different = { ...owner.reference, context: { ...owner.reference.context, [field]: 'different' } };
        assert.throws(() => recoverProductionSystemdResourceBoundary(fixture.context, { ...options, reference: different }), /independently retained/u);
    }
    const lock = path.join(path.dirname(owner.reference.ownerFile), 'recovery.lock');
    fs.mkdirSync(lock, { mode: 0o700 });
    assert.throws(() => recoverProductionSystemdResourceBoundary(fixture.context, options), { code: 'EEXIST' });
    assert.equal(fixture.events.includes('stop'), false);
    assert.equal(fs.existsSync(lock), true);
});

test('systemd owner refuses duplicate preparation for one scheduler incarnation and rejects unknown context fields', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
    // A real manager would observe the fresh random name as an empty implicit slice.
    const inspect = fixture.transport.inspect;
    const unitName = owner.evidence().owner.unitName;
    fixture.transport.inspect = (name) => name === unitName ? inspect(name) : {
        ActiveState: 'inactive', ControlGroup: '', FragmentPath: '', DropInPaths: '', Transient: 'no', InvocationID: ''
    };
    await assert.rejects(() => prepareProductionSystemdResourceBoundary(fixture.context, fixture.options), { code: 'EEXIST' });
    await assert.rejects(() => prepareProductionSystemdResourceBoundary({ ...fixture.context, latest: true }, fixture.options), /exact repository/u);
    fixture.transport.inspect = inspect;
    assert.equal(fixture.events.filter((event) => event === 'start').length, 1);
    assert.equal(owner.cleanup().status, 'removed');
});

test('systemd launcher is admitted under the shared grant only while its exact process remains stopped', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
    const budget = { startupBudgetMs: 1000 };
    await assert.rejects(() => owner.attachLauncher(fixture.launcherProcess, budget), /no verified current grant/u);
    const first = owner.update(resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 }));
    await assert.rejects(() => owner.attachLauncher(fixture.launcherProcess, { startupBudgetMs: 0 }), /explicit positive/u);
    fixture.launcherObservation.stopped = false;
    await assert.rejects(() => owner.attachLauncher(fixture.launcherProcess, budget), /remain stopped/u);
    fixture.launcherObservation.stopped = true;
    await assert.rejects(() => owner.attachLauncher({ ...fixture.launcherProcess, pid: 4243 }, budget), /identity must match/u);
    assert.equal(fixture.events.includes('start-launcher'), false);
    const admitted = await owner.attachLauncher(fixture.launcherProcess, budget);
    assert.deepEqual(admitted.parent, first);
    assert.equal(admitted.launcher.controlGroup, `${first.controlGroup}/${admitted.launcher.unitName}`);
    assert.deepEqual(admitted.processIdentity, fixture.launcherProcess);
    assert.equal(fixture.events.filter((event) => event === 'set').length, 1, 'the scope receives no duplicate grant');
    owner.update(resolveCgroupLimits({ cpuUnits: 0.5, memoryGiB: 0.5 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 }));
    assert.equal(fixture.launcherGroup.processIds[0], admitted.processIdentity.pid);
    assert.equal(owner.cleanup().status, 'retained-active');
    assert.equal(fixture.events.includes('stop-launcher'), false);
    owner.update(resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 }));
    await assert.rejects(() => owner.attachLauncher(fixture.launcherProcess, budget), /already attempted/u);
    fixture.launcherGroup.populated = false;
    fixture.launcherGroup.processIds = [];
    fixture.group.populated = false;
    assert.equal(owner.cleanup().status, 'removed');
    assert.deepEqual(fixture.events.slice(-2), ['stop-launcher', 'stop']);
    assert.equal(owner.cleanup().status, 'removed');
});

test('systemd launcher rejects wrong membership and invalidates admission after partial creation', async (t) =>
{
    for (const mutation of [
        (fixture) =>
        {
            fixture.launcherObservation.controlGroup = '/other-run';
        },
        (fixture) =>
        {
            fixture.launcherGroup.processIds = [4243];
        },
        (fixture) =>
        {
            fixture.launcherObservation.stopped = false;
        },
        (fixture) =>
        {
            fixture.launcherUnit.ControlGroup = '/other-run/wrong.scope';
        },
        (fixture) =>
        {
            fixture.group.controls['cpu.max'] = 'max 100000';
        }
    ])
    {
        const fixture = fakeSystemdBoundary(t);
        const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
        owner.update(resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 }));
        const start = fixture.transport.startLauncher;
        fixture.transport.startLauncher = (...args) =>
        {
            start(...args);
            mutation(fixture);
        };
        await assert.rejects(() => owner.attachLauncher(fixture.launcherProcess, { startupBudgetMs: 1000 }),
            /membership|remain stopped|ownership binding|controls changed/u);
        assert.throws(() => owner.assertAdmitted(), /no verified current grant/u);
        assert.equal(fixture.events.includes('stop-launcher'), false);
        assert.equal(fixture.events.includes('stop'), false);
    }
});

test('systemd launcher cleanup rejects identity drift and never removes unknown children', async (t) =>
{
    for (const mutation of [
        (fixture) =>
        {
            fixture.launcherUnit.Description = 'foreign owner';
        },
        (fixture) =>
        {
            fixture.launcherUnit.InvocationID = 'f'.repeat(32);
        },
        (fixture) =>
        {
            fixture.launcherGroup.inode += 1;
        },
        (fixture) =>
        {
            fixture.launcherUnit.DropInPaths = `${fixture.launcherUnit.FragmentPath}.d/foreign.conf`;
        }
    ])
    {
        const fixture = fakeSystemdBoundary(t);
        const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
        owner.update(resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 }));
        await owner.attachLauncher(fixture.launcherProcess, { startupBudgetMs: 1000 });
        fixture.launcherGroup.populated = false;
        fixture.group.populated = false;
        mutation(fixture);
        assert.throws(() => owner.cleanup(), /ownership binding|invocation, cgroup or artifacts/u);
        assert.equal(fixture.events.includes('stop-launcher'), false);
        assert.equal(fixture.events.includes('stop'), false);
    }
    const fixture = fakeSystemdBoundary(t);
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
    owner.update(resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 }));
    await owner.attachLauncher(fixture.launcherProcess, { startupBudgetMs: 1000 });
    fixture.launcherGroup.populated = false;
    fixture.launcherGroup.children = ['unknown'];
    fixture.group.populated = false;
    assert.equal(owner.cleanup().status, 'retained-active');
    assert.equal(fixture.events.includes('stop-launcher'), false);
});

test('dead-controller recovery retains a partially created populated launcher and removes it only after termination', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
    owner.update(resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 }));
    const start = fixture.transport.startLauncher;
    fixture.transport.startLauncher = (...args) =>
    {
        start(...args);
        throw new Error('controller interrupted before scope identity persistence');
    };
    await assert.rejects(() => owner.attachLauncher(fixture.launcherProcess, { startupBudgetMs: 1000 }), /controller interrupted/u);
    assert.equal(owner.evidence().state.launcher.identity, null);
    fixture.setControllerStatus('dead');
    const options = { reference: owner.reference, transport: fixture.transport, observeController: fixture.options.observeController };
    assert.equal(recoverProductionSystemdResourceBoundary(fixture.context, options).status, 'retained-active');
    assert.equal(fixture.events.includes('stop-launcher'), false);
    fixture.launcherGroup.populated = false;
    fixture.launcherGroup.processIds = [];
    fixture.group.populated = false;
    assert.equal(recoverProductionSystemdResourceBoundary(fixture.context, options).status, 'removed');
    assert.deepEqual(fixture.events.slice(-2), ['stop-launcher', 'stop']);
});

test('systemd launcher refuses a pre-existing scope and cleans a failed creation with no scope', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
    owner.update(resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 }));
    const inspect = fixture.transport.inspect;
    fixture.transport.inspect = (name) => name.endsWith('.scope')
        ? { ...inspect(name), ActiveState: 'active', Transient: 'yes', Description: 'unrelated owner' } : inspect(name);
    await assert.rejects(() => owner.attachLauncher(fixture.launcherProcess, { startupBudgetMs: 1000 }), /refuses an existing unit/u);
    assert.equal(owner.evidence().state.launcher, null);
    assert.equal(fixture.events.includes('start-launcher'), false);
    fixture.transport.inspect = inspect;
    fixture.transport.startLauncher = () =>
    {
        throw new Error('creation refused before effects');
    };
    await assert.rejects(() => owner.attachLauncher(fixture.launcherProcess, { startupBudgetMs: 1000 }), /refused before effects/u);
    assert.equal(owner.evidence().state.launcher.phase, 'attach-attempted');
    assert.throws(() => owner.assertAdmitted(), /no verified current grant/u);
    assert.equal(owner.cleanup().status, 'removed');
    assert.equal(fixture.events.includes('stop-launcher'), false);
});

test('systemd launcher rejects a last-moment stopped-process move after identity persistence', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
    owner.update(resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 }));
    const stopped = fixture.transport.stoppedProcess;
    fixture.transport.stoppedProcess = (identity) =>
    {
        if (owner.evidence().state.launcher?.phase === 'active')
        {
            fixture.launcherObservation.controlGroup = '/moved-after-persistence';
        }
        return stopped(identity);
    };
    await assert.rejects(() => owner.attachLauncher(fixture.launcherProcess, { startupBudgetMs: 1000 }), /membership changed before resume/u);
    assert.throws(() => owner.assertAdmitted(), /no verified current grant/u);
    assert.equal(owner.cleanup().status, 'retained-active');
    assert.equal(fixture.events.includes('stop-launcher'), false);
});

test('systemd launcher waits for activation before reading its cgroup and retains a timed-out creation', async (t) =>
{
    const fixture = fakeSystemdBoundary(t);
    const owner = await prepareProductionSystemdResourceBoundary(fixture.context, fixture.options);
    owner.update(resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 }));
    const inspect = fixture.transport.inspect;
    let pendingObservations = 2;
    fixture.transport.inspect = (name) =>
    {
        const observed = inspect(name);
        return name.endsWith('.scope') && fixture.launcherUnit && pendingObservations-- > 0
            ? { ...observed, ActiveState: 'activating', ControlGroup: '', InvocationID: '' } : observed;
    };
    const admission = await owner.attachLauncher(fixture.launcherProcess, { startupBudgetMs: 1000 });
    assert.equal(admission.launcher.controlGroup, fixture.launcherUnit.ControlGroup);
    assert.ok(pendingObservations <= 0);
    fixture.launcherGroup.populated = false;
    fixture.launcherGroup.processIds = [];
    fixture.group.populated = false;
    assert.equal(owner.cleanup().status, 'removed');

    const timedOut = fakeSystemdBoundary(t);
    const timedOutOwner = await prepareProductionSystemdResourceBoundary(timedOut.context, timedOut.options);
    timedOutOwner.update(resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 }));
    const inspectTimedOut = timedOut.transport.inspect;
    timedOut.transport.inspect = (name) =>
    {
        const observed = inspectTimedOut(name);
        return name.endsWith('.scope') && timedOut.launcherUnit
            ? { ...observed, ActiveState: 'activating', ControlGroup: '', InvocationID: '' } : observed;
    };
    await assert.rejects(() => timedOutOwner.attachLauncher(timedOut.launcherProcess, { startupBudgetMs: 5 }), /within its startup budget/u);
    assert.throws(() => timedOutOwner.assertAdmitted(), /no verified current grant/u);
    timedOut.transport.inspect = inspectTimedOut;
    assert.equal(timedOutOwner.cleanup().status, 'retained-active');
    assert.equal(timedOut.events.includes('stop-launcher'), false);
    assert.equal(timedOut.events.includes('stop'), false);
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
        Math.floor(Math.floor(machineMemoryGiB * 1024 ** 3) / one.memoryPageBytes) * one.memoryPageBytes
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

test('every enforced control mismatch rejects admission and is not recorded as an effective grant', async (t) =>
{
    for (const control of ['cpu.max', 'cpu.weight', 'memory.high', 'memory.max', 'pids.max'])
    {
        const fixture = fakeCgroup();
        t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
        const enforcer = await createProductionResourceEnforcer({
            runId: 'readback-run', bundleIds: ['worker'], mode: 'strict',
            machine: { cpuUnits: 8, memoryGiB: 16 },
            platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot,
            prepareDirectory: fixture.prepareDirectory,
            removeDirectory: (directory) => fs.rmSync(directory, { recursive: true })
        });
        const first = enforcer.update('worker', { cpuUnits: 2, memoryGiB: 2 });
        const readFile = fs.readFileSync;
        const wrongValue = control === 'cpu.max' ? 'max 100000' : '1';
        const mock = t.mock.method(fs, 'readFileSync', (file, ...args) =>
            file === path.join(first.cgroupPath, control) ? wrongValue : readFile(file, ...args));
        assert.throws(() => enforcer.update('worker', { cpuUnits: 3, memoryGiB: 3.000001 }), /controls differ/u);
        const bundle = enforcer.evidence().bundles.worker;
        assert.equal(bundle.consistency.status, 'mismatch');
        assert.equal(bundle.grants.length, 1);
        assert.equal(bundle.grants[0].cpuUnits, 2);
        assert.equal(bundle.attachedPid, null);
        await assert.rejects(() => enforcer.attach('worker', 4242), /verified current resource grant/u);
        mock.mock.restore();
        assert.equal(enforcer.cleanup().status, 'removed');
    }
});

test('an enforced owner rejects a forged page size before creating resource directories', async (t) =>
{
    const fixture = fakeCgroup();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const observedPageBytes = resolveCgroupLimits({ cpuUnits: 1, memoryGiB: 1 }, {
        cpuUnits: 8, memoryGiB: 16
    }).memoryPageBytes;
    await assert.rejects(() => createProductionResourceEnforcer({
        runId: 'page-run', bundleIds: ['worker'], mode: 'strict',
        machine: { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: observedPageBytes === 4096 ? 16384 : 4096 },
        platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot
    }), /page size differs from the observed host/u);
    assert.equal(fs.existsSync(path.join(fixture.delegateRoot, 'fsusblog-production')), false);
});

test('attach requires live controls, rejects drift and cannot reuse a failed update or a closed owner', async (t) =>
{
    const fixture = fakeCgroup();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const enforcer = await createProductionResourceEnforcer({
        runId: 'admission-run', bundleIds: ['worker'], mode: 'strict',
        machine: { cpuUnits: 8, memoryGiB: 16 },
        platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot,
        prepareDirectory: fixture.prepareDirectory,
        removeDirectory: (directory) => fs.rmSync(directory, { recursive: true })
    });
    await assert.rejects(() => enforcer.attach('worker', 4242), /verified current resource grant/u);
    assert.throws(() => enforcer.update('worker', { cpuUnits: 1, memoryGiB: 0.001 }), /minimum 16 MiB/u);
    assert.throws(() => enforcer.update('worker', { cpuUnits: 0.00001, memoryGiB: 1 }), /minimum representable process quota/u);
    assert.equal(fs.readFileSync(path.join(enforcer.evidence().bundles.worker.path, 'cpu.max'), 'utf8'), 'max 100000');
    assert.throws(() => enforcer.update('unowned', { cpuUnits: 2, memoryGiB: 2 }), /owned bundle path/u);
    await assert.rejects(() => enforcer.attach('unowned', 4242), /owned bundle path/u);
    const limits = enforcer.update('worker', { cpuUnits: 2, memoryGiB: 2 });
    const membersFile = path.join(limits.cgroupPath, 'cgroup.procs');
    fs.writeFileSync(path.join(limits.cgroupPath, 'memory.max'), 'max');
    await assert.rejects(() => enforcer.attach('worker', 4242), /controls differ/u);
    assert.equal(fs.readFileSync(membersFile, 'utf8'), '');
    enforcer.update('worker', { cpuUnits: 2, memoryGiB: 2 });
    const writeFile = fs.writeFileSync;
    const mock = t.mock.method(fs, 'writeFileSync', (file, ...args) =>
    {
        if (file === path.join(limits.cgroupPath, 'pids.max'))
        {
            throw new Error('injected control write failure');
        }
        return writeFile(file, ...args);
    });
    assert.throws(() => enforcer.update('worker', { cpuUnits: 3, memoryGiB: 3 }), /injected control write failure/u);
    assert.equal(enforcer.evidence().bundles.worker.consistency.status, 'unverified');
    assert.equal(enforcer.evidence().bundles.worker.grants.length, 1);
    await assert.rejects(() => enforcer.attach('worker', 4242), /verified current resource grant/u);
    assert.equal(fs.readFileSync(membersFile, 'utf8'), '');
    mock.mock.restore();
    enforcer.update('worker', { cpuUnits: 2, memoryGiB: 2 });
    enforcer.evidence().bundles.worker.grants[0].memoryMaxBytes = 1;
    enforcer.evidence().mode = 'advisory';
    assert.equal(enforcer.mode, 'enforced');
    assert.equal(enforcer.environment('worker').FSUSBLOG_CGROUP_ENFORCEMENT_MODE, 'enforced');
    fs.writeFileSync(path.join(limits.cgroupPath, 'cpu.max'), 'max 100000');
    await assert.rejects(() => enforcer.attach('worker', 4242), /controls differ/u);
    enforcer.update('worker', { cpuUnits: 2, memoryGiB: 2 });
    await enforcer.attach('worker', 4242);
    assert.equal(fs.readFileSync(membersFile, 'utf8'), '4242');
    fs.writeFileSync(membersFile, '');
    enforcer.evidence().bundles.worker.path = path.join(fixture.root, 'unowned');
    fs.mkdirSync(enforcer.evidence().bundles.worker.path);
    assert.throws(() => enforcer.update('worker', { cpuUnits: 2, memoryGiB: 2 }), /owned bundle path/u);
    assert.equal(enforcer.environment('worker').FSUSBLOG_CGROUP_BUNDLE_PATH, limits.cgroupPath);
    assert.equal(enforcer.cleanup().status, 'removed');
    assert.equal(fs.existsSync(path.join(fixture.root, 'unowned')), true);
    assert.equal(fs.existsSync(limits.cgroupPath), false);
    assert.equal(enforcer.cleanup().status, 'removed');
    await assert.rejects(() => enforcer.attach('worker', 4242), /owner is closed/u);
    assert.throws(() => enforcer.update('worker', { cpuUnits: 2, memoryGiB: 2 }), /owner is closed/u);
});

test('attach refuses a kernel membership read-back that does not contain the requested PID', async (t) =>
{
    const fixture = fakeCgroup();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const enforcer = await createProductionResourceEnforcer({
        runId: 'membership-run', bundleIds: ['worker'], mode: 'strict',
        machine: { cpuUnits: 8, memoryGiB: 16 },
        platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot,
        prepareDirectory: fixture.prepareDirectory
    });
    const limits = enforcer.update('worker', { cpuUnits: 2, memoryGiB: 2 });
    const readFile = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) =>
        file === path.join(limits.cgroupPath, 'cgroup.procs') ? '1234\n' : readFile(file, ...args));
    await assert.rejects(() => enforcer.attach('worker', 4242), /membership read-back/u);
    assert.equal(enforcer.evidence().bundles.worker.attachedPid, null);
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

test('scheduler terminal evidence rejects retained or failed resource cleanup without replacing the primary failure', async (t) =>
{
    for (const scenario of ['removed', 'retained-active', 'failed', 'primary-failure', 'hook-failure'])
    {
        await t.test(scenario, async (subtest) =>
        {
            const fixture = fakeCgroup();
            subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
            const runId = `cleanup-${scenario}`;
            const bundlePath = path.join(fixture.delegateRoot, 'fsusblog-production', runId, 'worker');
            const invocation = () => runDag({
                tiers: [{
                    id: 'worker', command: `${process.execPath} -e "process.exit(0)"`,
                    dependsOn: [], services: [], parallelizable: true, exclusiveResources: [],
                    phase: 0, resourceClass: 'cpu', maxParallel: 1, cpuUnits: 1, memoryGiB: 0.25,
                    cacheInputs: ['tools/**'], executionKey: 'test/worker',
                    executionVariant: 'ordinary', coverage: ['ordinary-unit']
                }],
                root: fixture.root, runsRoot: path.join(fixture.root, 'runs'), runId, maxParallel: 1,
                systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
                snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} }),
                executeTier: async () =>
                {
                    if (['retained-active', 'primary-failure'].includes(scenario))
                    {
                        // Synthetic filesystem observation, not a real process or Linux qualification.
                        fs.writeFileSync(path.join(bundlePath, 'cgroup.procs'), '4242\n');
                    }
                    return { code: scenario === 'primary-failure' ? 7 : 0, signal: null };
                },
                onTierStart: () =>
                {
                    if (scenario === 'hook-failure')
                    {
                        throw new Error('primary scheduler hook failure');
                    }
                },
                resourceEnforcementMode: 'strict',
                resourceEnforcementOptions: {
                    platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot,
                    prepareDirectory: fixture.prepareDirectory,
                    removeDirectory: (directory) =>
                    {
                        if (['failed', 'hook-failure'].includes(scenario))
                        {
                            throw Object.assign(new Error('fixture refuses owned cgroup removal'), { code: 'EBUSY' });
                        }
                        fs.rmSync(directory, { recursive: true });
                    }
                }
            });
            if (scenario === 'hook-failure')
            {
                await assert.rejects(invocation, (error) =>
                {
                    assert.equal(error.message, 'primary scheduler hook failure');
                    assert.equal(error.schedulerFinalizationFailures?.length, 1);
                    assert.equal(error.schedulerFinalizationFailures[0].resourceEnforcement.cleanup.status, 'failed');
                    return true;
                });
                assert.equal(fs.existsSync(bundlePath), true);
                return;
            }
            const result = await invocation();
            const persisted = JSON.parse(fs.readFileSync(result.checkpointPath, 'utf8'));
            assert.equal(result.status, scenario === 'removed' ? 'success' : 'failure');
            assert.equal(persisted.status, result.status);
            assert.equal(persisted.resourceEnforcement.cleanup.status,
                scenario === 'primary-failure' ? 'retained-active' : scenario);
            if (scenario !== 'removed')
            {
                assert.match(persisted.resourceCleanupFailure.reason, /resource enforcement cleanup incomplete/u);
                assert.ok(persisted.failures.some((failure) => failure.reason === persisted.resourceCleanupFailure.reason));
                assert.equal(persisted.resourceUtilization.status, 'partial');
                assert.equal(result.failure.exitCode, scenario === 'primary-failure' ? 7 : 1);
                assert.equal(fs.existsSync(bundlePath), true, 'unresolved owned resources must remain inspectable');
                const checkpointBytes = fs.readFileSync(result.checkpointPath, 'utf8');
                for (const mode of ['fresh', 'resume'])
                {
                    let rebound = false;
                    await assert.rejects(() => runDag({ root: fixture.root, runsRoot: path.join(fixture.root, 'runs'), runId,
                        mode, tiers: [], snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} }),
                        onSourceState: () => rebound = true }), /unsettled resource grants; independent owner reconciliation required/u);
                    assert.equal(rebound, false, `${mode} must retain failed resource-owner cleanup even when worker grants are zero`);
                    assert.equal(fs.readFileSync(result.checkpointPath, 'utf8'), checkpointBytes);
                }
            }
        });
    }
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
    for (const mode of ['auto', 'advisory', 'off'])
    {
        const unenforced = await createProductionResourceEnforcer({ ...options, mode });
        const limits = unenforced.update('bundle', { cpuUnits: 0.1, memoryGiB: 0.01 });
        assert.equal(limits.mode, 'advisory');
        assert.equal(unenforced.evidence().bundles.bundle.consistency.status, 'advisory');
        assert.equal(await unenforced.attach('bundle', 4242), 'advisory');
    }
});

test('scheduler does not publish an active grant whose control read-back failed', async (t) =>
{
    const fixture = fakeCgroup();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const runsRoot = path.join(fixture.root, 'runs');
    const runId = 'publication-run';
    const grantFile = path.join(runsRoot, runId, 'resource-grants.json');
    const controlFile = path.join(fixture.delegateRoot, 'fsusblog-production', runId, 'worker', 'cpu.max');
    let corruptReadback = false;
    const readFile = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) =>
        corruptReadback && file === controlFile ? 'max 100000' : readFile(file, ...args));
    await assert.rejects(() => runDag({
        tiers: [{
            id: 'worker', command: `${process.execPath} -e "process.exit(0)"`,
            dependsOn: [], services: [], parallelizable: true, exclusiveResources: [],
            phase: 0, resourceClass: 'cpu', maxParallel: 1, cpuUnits: 1, memoryGiB: 0.25,
            cacheInputs: ['tools/**'], executionKey: 'test/worker',
            executionVariant: 'ordinary', coverage: ['ordinary-unit']
        }],
        root: fixture.root, runsRoot, runId, maxParallel: 1,
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} }),
        executeTier: async () => ({ code: 0, signal: null }),
        onTierStart: () =>
        {
            corruptReadback = true;
        },
        resourceEnforcementMode: 'strict',
        resourceEnforcementOptions: {
            platform: 'linux', mountRoot: fixture.mountRoot, mountType: 'cgroup2fs', delegateRoot: fixture.delegateRoot,
            prepareDirectory: fixture.prepareDirectory,
            removeDirectory: (directory) => fs.rmSync(directory, { recursive: true })
        }
    }), /controls differ/u);
    assert.equal(fs.existsSync(grantFile) && Object.hasOwn(JSON.parse(readFile(grantFile, 'utf8')).grants, 'worker'), false);
    assert.equal(fs.existsSync(path.dirname(controlFile)), false);
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

test('scheduler MySQL recovery precedes original tree release and gates the grant commit', () =>
{
    const source = fs.readFileSync(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url), 'utf8');
    const recovery = source.slice(source.indexOf('export async function reconcileSchedulerResourceGrants('),
        source.indexOf('function assertPriorSchedulerResourcesSettled('));
    const mysql = recovery.indexOf('recovery.mysqlFixtureReconciliation = await reconcileRetainedMySqlFixtureServices(');
    const tree = recovery.indexOf('result = build.recoverProductionBuildResourceTree(');
    assert.ok(mysql >= 0 && mysql < tree, 'retained MySQL lifecycle must settle before original tree/grant release');
    const completion = source.slice(source.indexOf('export function completeSchedulerResourceRecovery('),
        source.indexOf('export async function reconcileSchedulerResourceGrants('));
    const verification = completion.indexOf('assertMySqlFixtureRecoveryComplete(checkpoint, recovery.mysqlFixtureReconciliation');
    const release = completion.indexOf('checkpoint.resourceUtilization.resourceGrants =');
    assert.ok(verification >= 0 && verification < release, 'grant completion must independently require current MySQL cleanup');
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

test('scheduler MySQL recovery publication retry preserves its sealed proof', async () =>
{
    const drift = false;
    const { runInNewContext } = await import('node:vm');
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const sealed = await reconcileRetainedMySqlFixtureServices(fixture);
    fixture.record.status = 'cleaned';
    fixture.record.cleanup = structuredClone(sealed[0].cleanup);
    const verify = fixture.lifecycle.verifyMySqlFixtureServiceCleanup;
    fixture.lifecycle.verifyMySqlFixtureServiceCleanup = (...args) =>
    {
        const observed = verify(...args);
        if (drift)
        {
            observed.stateDigest = 'sha256:' + '1'.repeat(64);
        }
        return observed;
    };
    const current = await reconcileRetainedMySqlFixtureServices(fixture);
    const checkpoint = { mysqlFixtureServices: fixture.allocations,
        resourceReconciliation: { mysqlFixtureReconciliation: structuredClone(sealed) },
        resourceUtilization: { resourceGrants: { grants: {}, residentReservation: { cpuUnits: 0, memoryGiB: 0 } } } };
    const fingerprint = value => JSON.stringify(value);
    const originalCheckpoint = fingerprint(checkpoint);
    const journalBytes = 'original sealed resource-grants-reconciled event\n';
    const views = { journal: journalBytes, compatibility: 'old compatibility bytes', grants: 'old grant bytes' };
    const originalViews = structuredClone(views);
    const writes = [];
    const capability = {};
    const recovery = { binding: fixture.binding, reference: { runId: fixture.binding.runId },
        checkpointDigest: fingerprint(checkpoint), mysqlFixtureReconciliation: current,
        mysqlFixtureLifecycle: fixture.lifecycle };
    const source = fs.readFileSync(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('export function completeSchedulerResourceRecovery(');
    const end = source.indexOf('/** Reconcile only the original retained build', start);
    assert.ok(start >= 0 && end > start);
    // Execute the exact completion function with memory-only I/O and held-lease adapters.
    // This is a publication component regression, not live Docker or recovery qualification.
    const context = { fingerprint, path,
        assertSchedulerResourceRecovery: () => ({ status: 'verified' }),
        schedulerResourceRecoveries: new Map([[capability, recovery]]),
        readOriginalSchedulerResourceCheckpoint: () => ({ checkpointFile: '/owned/runs/owned-run/checkpoint.json', checkpoint }),
        assertMySqlFixtureRecoveryComplete: (value, records, lifecycle) =>
            assertRetainedMySqlFixtureRecoveryComplete({ allocations: value.mysqlFixtureServices, records, lifecycle }),
        schedulerResourceReconciliationIsComplete: value =>
        {
            assertRetainedMySqlFixtureRecoveryComplete({ allocations: value.mysqlFixtureServices,
                records: value.resourceReconciliation.mysqlFixtureReconciliation, requireCleaned: true });
            return true;
        },
        checkpointPersistence: new Map(),
        schedulerPersistence: () => ({ store: { readJournal: () => [{ sequence: 1 }] } }),
        publishCheckpointBoundary: () =>
        {
            writes.push('compatibility');
            views.compatibility = fingerprint(checkpoint);
        },
        fs: {
            writeFileSync: (_file, bytes) =>
            {
                writes.push('grant');
                views.grants = bytes;
            },
            renameSync: () => writes.push('grant-rename')
        },
        process: { pid: process.pid },
        schedulerResourcesUnsettled: () => false };
    runInNewContext(source.slice(start, end).replace('export function ', 'function ')
        + '\nglobalThis.complete = completeSchedulerResourceRecovery;', context);
    if (drift)
    {
        assert.notEqual(current[0].stateDigest, sealed[0].stateDigest);
        assert.throws(() => context.complete(capability, { reference: recovery.reference }), /changed before grant release/u);
        assert.deepEqual(writes, []);
        assert.deepEqual(views, originalViews, 'rejection preserves original journal, grant and compatibility bytes');
    }
    else
    {
        context.complete(capability, { reference: recovery.reference });
        assert.deepEqual(writes, ['compatibility', 'grant', 'grant-rename']);
        assert.equal(views.journal, journalBytes, 'normal publication retry cannot append a second release');
    }
    assert.equal(fingerprint(checkpoint), originalCheckpoint, 'neither retry can replace the sealed cleanup proof');
});

test('scheduler MySQL recovery publication retry rejects rehashed cleanup', async () =>
{
    const drift = true;
    const { runInNewContext } = await import('node:vm');
    const { reconcileRetainedMySqlFixtureServices, assertRetainedMySqlFixtureRecoveryComplete } = await import(new URL('../../tools/test-matrix/mysql-fixture-recovery.mjs', import.meta.url));
    const fixture = retainedMySqlRecoveryFixture();
    const sealed = await reconcileRetainedMySqlFixtureServices(fixture);
    fixture.record.status = 'cleaned';
    fixture.record.cleanup = structuredClone(sealed[0].cleanup);
    const verify = fixture.lifecycle.verifyMySqlFixtureServiceCleanup;
    fixture.lifecycle.verifyMySqlFixtureServiceCleanup = (...args) =>
    {
        const observed = verify(...args);
        if (drift)
        {
            observed.stateDigest = 'sha256:' + '1'.repeat(64);
        }
        return observed;
    };
    const current = await reconcileRetainedMySqlFixtureServices(fixture);
    const checkpoint = { mysqlFixtureServices: fixture.allocations,
        resourceReconciliation: { mysqlFixtureReconciliation: structuredClone(sealed) },
        resourceUtilization: { resourceGrants: { grants: {}, residentReservation: { cpuUnits: 0, memoryGiB: 0 } } } };
    const fingerprint = value => JSON.stringify(value);
    const originalCheckpoint = fingerprint(checkpoint);
    const journalBytes = 'original sealed resource-grants-reconciled event\n';
    const views = { journal: journalBytes, compatibility: 'old compatibility bytes', grants: 'old grant bytes' };
    const originalViews = structuredClone(views);
    const writes = [];
    const capability = {};
    const recovery = { binding: fixture.binding, reference: { runId: fixture.binding.runId },
        checkpointDigest: fingerprint(checkpoint), mysqlFixtureReconciliation: current,
        mysqlFixtureLifecycle: fixture.lifecycle };
    const source = fs.readFileSync(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('export function completeSchedulerResourceRecovery(');
    const end = source.indexOf('/** Reconcile only the original retained build', start);
    assert.ok(start >= 0 && end > start);
    // Execute the exact completion function with memory-only I/O and held-lease adapters.
    // This is a publication component regression, not live Docker or recovery qualification.
    const context = { fingerprint, path,
        assertSchedulerResourceRecovery: () => ({ status: 'verified' }),
        schedulerResourceRecoveries: new Map([[capability, recovery]]),
        readOriginalSchedulerResourceCheckpoint: () => ({ checkpointFile: '/owned/runs/owned-run/checkpoint.json', checkpoint }),
        assertMySqlFixtureRecoveryComplete: (value, records, lifecycle) =>
            assertRetainedMySqlFixtureRecoveryComplete({ allocations: value.mysqlFixtureServices, records, lifecycle }),
        schedulerResourceReconciliationIsComplete: value =>
        {
            assertRetainedMySqlFixtureRecoveryComplete({ allocations: value.mysqlFixtureServices,
                records: value.resourceReconciliation.mysqlFixtureReconciliation, requireCleaned: true });
            return true;
        },
        checkpointPersistence: new Map(),
        schedulerPersistence: () => ({ store: { readJournal: () => [{ sequence: 1 }] } }),
        publishCheckpointBoundary: () =>
        {
            writes.push('compatibility');
            views.compatibility = fingerprint(checkpoint);
        },
        fs: {
            writeFileSync: (_file, bytes) =>
            {
                writes.push('grant');
                views.grants = bytes;
            },
            renameSync: () => writes.push('grant-rename')
        },
        process: { pid: process.pid },
        schedulerResourcesUnsettled: () => false };
    runInNewContext(source.slice(start, end).replace('export function ', 'function ')
        + '\nglobalThis.complete = completeSchedulerResourceRecovery;', context);
    if (drift)
    {
        assert.notEqual(current[0].stateDigest, sealed[0].stateDigest);
        assert.throws(() => context.complete(capability, { reference: recovery.reference }), /changed before grant release/u);
        assert.deepEqual(writes, []);
        assert.deepEqual(views, originalViews, 'rejection preserves original journal, grant and compatibility bytes');
    }
    else
    {
        context.complete(capability, { reference: recovery.reference });
        assert.deepEqual(writes, ['compatibility', 'grant', 'grant-rename']);
        assert.equal(views.journal, journalBytes, 'normal publication retry cannot append a second release');
    }
    assert.equal(fingerprint(checkpoint), originalCheckpoint, 'neither retry can replace the sealed cleanup proof');
});

async function privateLauncherLeaseFixture(t)
{
    const { fixture, options } = systemdEnforcerFixture(t);
    const original = structuredClone(fixture.launcherProcess);
    const foreign = { ...original, pid: original.pid + 1, processStartIdentity: 'foreign-live-start' };
    const foreignGroup = '/foreign-live-group';
    const observedPids = [];
    options.observeContainerReservationProcess = (pid) =>
    {
        observedPids.push(pid);
        return structuredClone(pid === original.pid ? original : foreign);
    };
    options.readContainerReservationProcessCgroup = (pid) =>
        `0::${pid === original.pid ? fixture.launcherUnit.ControlGroup : foreignGroup}\n`;
    const enforcer = await createProductionResourceEnforcer(options);
    const bundleId = fixture.context.bundleId;
    enforcer.update(bundleId, { cpuUnits: 4, memoryGiB: 4 });
    const callerIdentity = structuredClone(original);
    await enforcer.attach(bundleId, original.pid, callerIdentity);
    const identity = { root: fixture.context.root, runId: fixture.context.runId,
        namespace: fixture.context.namespace, bundleId: `matrix:${bundleId}`, stepId: 'migration-services',
        sourceState: fixture.context.sourceState };
    const limits = { cpuUnits: 1, memoryHighBytes: 512 * 1024 ** 2,
        memoryMaxBytes: 576 * 1024 ** 2, pidsMax: 128 };
    const lease = enforcer.reserveContainerResources(bundleId, { id: 'mysql', identity, limits });
    const context = { ...identity, resourceGrant: limits };
    assert.equal(lease.assertHeld(context).process.cpuUnits, 3, 'real held path succeeds before report mutation');
    assert.deepEqual(observedPids, [original.pid, original.pid]);
    observedPids.length = 0;
    return { fixture, enforcer, bundleId, lease, context, original, foreign, foreignGroup, observedPids, callerIdentity };
}

test('held launcher rejects a complete foreign-live public report without rebinding its private authority', async (t) =>
{
    const value = await privateLauncherLeaseFixture(t);
    const report = value.enforcer.evidence().bundles[value.bundleId];
    const originalReport = structuredClone(report.launcherAdmission);
    report.launcherAdmission = { ...originalReport, processIdentity: value.foreign,
        launcher: { ...originalReport.launcher, controlGroup: value.foreignGroup } };
    report.attachedPid = value.foreign.pid;
    report.attachStatus = 'attached';
    assert.throws(() => value.lease.assertHeld(value.context), /report differs from its private admission/u);
    assert.deepEqual(value.observedPids, [], 'foreign report must not select an observed process');
    assert.equal(value.lease.snapshot().held, true);
    assert.equal(value.enforcer.cleanup().status, 'retained-container-reservations');
    report.launcherAdmission = originalReport;
    report.attachedPid = value.original.pid;
    assert.equal(value.lease.assertHeld(value.context).process.cpuUnits, 3);
    assert.deepEqual(value.observedPids, [value.original.pid, value.original.pid]);
});

test('held launcher rejects independent and nested report mutations while preserving its original admission', async (t) =>
{
    const value = await privateLauncherLeaseFixture(t);
    const report = value.enforcer.evidence().bundles[value.bundleId];
    const originalReport = structuredClone(report.launcherAdmission);
    for (const mutate of [
        () => report.attachedPid = value.foreign.pid,
        () => report.attachStatus = 'advisory',
        () => report.launcherAdmission.processIdentity.processStartIdentity = value.foreign.processStartIdentity,
        () => report.launcherAdmission.launcher.controlGroup = value.foreignGroup
    ])
    {
        mutate();
        assert.throws(() => value.lease.assertHeld(value.context), /report differs from its private admission/u);
        assert.deepEqual(value.observedPids, []);
        report.attachedPid = value.original.pid;
        report.attachStatus = 'attached';
        report.launcherAdmission = structuredClone(originalReport);
        assert.equal(value.lease.assertHeld(value.context).process.cpuUnits, 3);
        assert.deepEqual(value.observedPids, [value.original.pid, value.original.pid]);
        value.observedPids.length = 0;
    }
});

test('held launcher detaches caller identity and retains its private admission through failed cleanup', async (t) =>
{
    const value = await privateLauncherLeaseFixture(t);
    value.callerIdentity.pid = value.foreign.pid;
    value.callerIdentity.processStartIdentity = value.foreign.processStartIdentity;
    assert.equal(value.lease.assertHeld(value.context).process.cpuUnits, 3);
    assert.deepEqual(value.observedPids, [value.original.pid, value.original.pid]);
    const failure = new Error('exact owned fixture cleanup failed');
    await assert.rejects(value.lease.releaseAfterCleanup(async () =>
    {
        throw failure;
    }), error => error === failure);
    assert.equal(value.lease.snapshot().held, true);
    value.observedPids.length = 0;
    assert.equal(value.lease.assertHeld(value.context).process.cpuUnits, 3);
    assert.deepEqual(value.observedPids, [value.original.pid, value.original.pid]);
    await value.lease.releaseAfterCleanup(async () => ({ containerAbsent: true, credentialsRemoved: true }));
    assert.throws(() => value.lease.assertHeld(value.context), /absent or crosses/u);
});

test('fractional byte grants and machine envelopes round downward before kernel page projection', () =>
{
    const byteUnit = 1024 ** 3;
    const pageBytes = 4096;
    const boundary = 512 * 1024 ** 2;
    for (const fraction of [-0.25, 0, 0.25, 0.75])
    {
        const requestedBytes = boundary + fraction;
        const limits = resolveCgroupLimits({ cpuUnits: 2, memoryGiB: requestedBytes / byteUnit }, {
            cpuUnits: 8, memoryGiB: 16, memoryPageBytes: pageBytes
        });
        assert.equal(limits.memoryHighBytes, Math.floor(requestedBytes / pageBytes) * pageBytes);
        assert.ok(limits.memoryHighBytes <= requestedBytes);
        const bounded = resolveCgroupLimits({ cpuUnits: 2, memoryGiB: requestedBytes / byteUnit }, {
            cpuUnits: 8, memoryGiB: requestedBytes / byteUnit, memoryPageBytes: pageBytes
        });
        assert.ok(bounded.memoryHighBytes <= requestedBytes);
        assert.ok(bounded.memoryMaxBytes <= requestedBytes);
        assert.equal(bounded.memoryMaxBytes, Math.floor(requestedBytes / pageBytes) * pageBytes);
    }
});

test('fractional byte projection preserves the original enforced grant without enlarging a container partition', async (t) =>
{
    const { fixture, options } = systemdEnforcerFixture(t);
    const enforcer = await createProductionResourceEnforcer(options);
    const requestedBytes = 512 * 1024 ** 2 - 0.25;
    const limits = enforcer.update(fixture.context.bundleId, { cpuUnits: 2, memoryGiB: requestedBytes / 1024 ** 3 });
    assert.equal(limits.memoryHighBytes, 536866816);
    assert.ok(limits.memoryHighBytes < requestedBytes);
    assert.equal(fs.readFileSync(path.join(limits.cgroupPath, 'memory.high'), 'utf8'), '536866816');
    assert.equal(enforcer.evidence().bundles[fixture.context.bundleId].consistency.status, 'consistent');
    const allocation = partitionContainerResourceGrant({ cpuUnits: 4, memoryGiB: (2 * 1024 ** 3 - 0.25) / 1024 ** 3 }, [{
        cpuUnits: 1, memoryHighBytes: 512 * 1024 ** 2, memoryMaxBytes: 576 * 1024 ** 2, pidsMax: 128
    }], { cpuUnits: 8, memoryGiB: 16, memoryPageBytes: 4096 });
    assert.equal(allocation.process.memoryHighBytes + allocation.reserved.memoryHighBytes,
        allocation.total.memoryHighBytes);
    assert.ok(allocation.total.memoryHighBytes < 2 * 1024 ** 3 - 0.25);
    assert.equal(enforcer.cleanup().status, 'removed');
});
