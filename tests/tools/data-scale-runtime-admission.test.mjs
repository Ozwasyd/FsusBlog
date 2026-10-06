import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createDataScaleRuntimeAdmission } = await import(new URL('../../tools/test/data-scale-runtime-admission.mjs', import.meta.url));
const { productionCapacityReservationSchema } = await import(new URL('../../tools/test-matrix/production-capacity-reservation.mjs', import.meta.url));
const { productionDiskDemandDigest } = await import(new URL('../../tools/test-matrix/production-disk-demand.mjs', import.meta.url));

// Capacity, native-pool and Docker doubles below cover API controls only. They are never
// native capacity admission, runtime qualification or physical Docker evidence.
function fixture()
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-admission-unit-'));
    const events = [];
    const candidateIdentityDigest = `sha256:${'a'.repeat(64)}`;
    const plan = { parentSchedulerRunId: 'unit-run', namespace: 'unit-scale', dataScaleRunId: 'unit-scale-1',
        invocationId: 'unit-invocation', attemptId: 'unit-attempt', sourceCommit: 'b'.repeat(40),
        worktreeFingerprint: `sha256:${'c'.repeat(64)}` };
    const productionCapacityPlan = { planDigest: `sha256:${'d'.repeat(64)}`,
        producerDeclarationDigest: `sha256:${'e'.repeat(64)}`,
        producerDeclarations: [{ producerId: 'unit-producer', rootId: 'unit-root', peakAdditionalBytes: 1,
            rollbackOrRecoveryBytes: 1, uncertaintyBytes: 1 }],
        filesystems: [{ filesystemIdentity: 'unit-filesystem', rootIds: ['unit-root'] }] };
    const productionCapacityReservation = {
        receipt: { schema: productionCapacityReservationSchema, state: 'active', runId: plan.parentSchedulerRunId,
            repositoryIdentity: productionDiskDemandDigest(repositoryRoot), candidateIdentityDigest,
            planDigest: productionCapacityPlan.planDigest, producerDeclarationDigest: productionCapacityPlan.producerDeclarationDigest },
        assertPlan(value)
        {
            assert.equal(value, productionCapacityPlan);
            events.push('assert');
        },
        guardProducer()
        {
            throw new Error('the parent manager exclusively guards the producer');
        },
        completeProducer()
        {
            throw new Error('the parent manager exclusively completes the producer');
        },
        heartbeat()
        {
            events.push('heartbeat');
        }
    };
    const nativeContainerContext = { root: repositoryRoot, runId: plan.parentSchedulerRunId,
        namespace: 'original-scheduler-namespace', bundleId: 'unit-bundle', stepId: 'unit-producer',
        sourceState: { commit: plan.sourceCommit, worktreeFingerprint: 'c'.repeat(64) },
        resourceGrant: { cpuUnits: 1.2, memoryHighBytes: 0.25 * 1024 ** 3,
            memoryMaxBytes: 0.25 * 1024 ** 3, pidsMax: 192 } };
    let nativeHeld = true;
    let nativeExited = false;
    let nativeCleanup = false;
    let retainedIdentity = null;
    const originalNativeIdentity = Object.fromEntries(['root', 'runId', 'namespace', 'bundleId', 'stepId', 'sourceState']
        .map((key) => [key, nativeContainerContext[key]]));
    const nativeReceipt = () => ({ runId: nativeContainerContext.runId, bundleId: nativeContainerContext.bundleId,
        reservation: { id: 'unit-native-reservation', identity: retainedIdentity ?? originalNativeIdentity,
            limits: nativeContainerContext.resourceGrant } });
    const cleanupCapability = Object.freeze({ assertRetained()
    {
        assert.equal(nativeHeld, true, 'unit original native lease must remain held');
        assert.equal(nativeExited, true, 'unit exact original service must be terminal');
        events.push('retained');
        return nativeReceipt();
    } });
    const nativeContainerReservation = {
        assertHeld(context)
        {
            if (!nativeHeld || nativeExited || nativeCleanup)
            {
                throw new Error('unit native reservation is no longer held');
            }
            assert.deepEqual(context, nativeContainerContext);
            return nativeReceipt();
        },
        retainCleanupCustody(context)
        {
            assert.deepEqual(context, nativeContainerContext);
            cleanupCapability.assertRetained();
            nativeCleanup = true;
            return cleanupCapability;
        }
    };
    const options = { repositoryRoot, plan, productionCapacityPlan, productionCapacityReservation,
        candidateIdentityDigest, capacityProducerId: 'unit-producer', ownerBundleId: 'unit-bundle',
        resourceGrant: { cpuUnits: 1.2, memoryGiB: 0.25 }, schedulerResourceGrant: { cpuUnits: 1.2, memoryGiB: 0.25 },
        nativeContainerContext, nativeContainerReservation,
        checkpointFile: path.join(repositoryRoot, 'unit-checkpoint.json'),
        checkpointAuthority()
        {
            throw new Error('unit fixture has no resident checkpoint authority');
        },
        execute()
        {
            throw new Error('unit refusal must not execute physical commands');
        } };
    return { options, events, cleanupCapability,
        exit: () =>
        {
            nativeExited = true;
        },
        retainedIdentity: (value) =>
        {
            retainedIdentity = value;
        },
        setNativeHeld: (value) =>
        {
            nativeHeld = value;
        },
        remove: () => fs.rmSync(repositoryRoot, { recursive: true, force: true }) };
}

test('DataScale admission refuses missing live scheduler capabilities before any resource mutation', async () =>
{
    const unit = fixture();
    try
    {
        await assert.rejects(createDataScaleRuntimeAdmission({ ...unit.options, checkpointAuthority: undefined }), /checkpoint authority/u);
        await assert.rejects(createDataScaleRuntimeAdmission({ ...unit.options, productionCapacityReservation: {
            receipt: unit.options.productionCapacityReservation.receipt } }), /live capacity capability/u);
        await assert.rejects(createDataScaleRuntimeAdmission({ ...unit.options, capacityProducerId: undefined }), /capacityProducerId/u);
        await assert.rejects(createDataScaleRuntimeAdmission({ ...unit.options, nativeContainerReservation: undefined }), /live native container/u);
        await assert.rejects(createDataScaleRuntimeAdmission({ ...unit.options,
            nativeContainerReservation: { limits: unit.options.nativeContainerContext.resourceGrant } }), /live native container/u);
        assert.deepEqual(unit.events, []);
        assert.equal(fs.existsSync(path.join(unit.options.repositoryRoot, '.tmp')), false);
    }
    finally
    {
        unit.remove();
    }
});

test('DataScale admission binds source, candidate, declared producer and scheduler envelope before allocation', async () =>
{
    const unit = fixture();
    try
    {
        await assert.rejects(createDataScaleRuntimeAdmission({ ...unit.options,
            plan: { ...unit.options.plan, worktreeFingerprint: 'unchecked' } }), /exact source state/u);
        await assert.rejects(createDataScaleRuntimeAdmission({ ...unit.options,
            candidateIdentityDigest: `sha256:${'f'.repeat(64)}` }), /binding mismatch/u);
        await assert.rejects(createDataScaleRuntimeAdmission({ ...unit.options,
            productionCapacityPlan: { ...unit.options.productionCapacityPlan, producerDeclarations: [] } }), /declaration is missing/u);
        await assert.rejects(createDataScaleRuntimeAdmission({ ...unit.options,
            resourceGrant: { cpuUnits: 2, memoryGiB: 1 } }), /exceeds scheduler grant/u);
        await assert.rejects(createDataScaleRuntimeAdmission({ ...unit.options,
            schedulerResourceGrant: { cpuUnits: 2, memoryGiB: 1 } }), /dedicated scheduler grant/u);
        assert.deepEqual(unit.events, []);
        assert.equal(fs.existsSync(path.join(unit.options.repositoryRoot, '.tmp')), false);
    }
    finally
    {
        unit.remove();
    }
});

function attemptBind(port)
{
    return new Promise((resolve, reject) =>
    {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => server.close(resolve));
    });
}

test('DataScale unit capacity seam owns real loopback reservations and writes only observed terminal releases', async () =>
{
    const unit = fixture();
    let admission;
    try
    {
        admission = await createDataScaleRuntimeAdmission(unit.options);
        assert.deepEqual(unit.events, ['assert', 'heartbeat']);
        for (const [role, minimum, maximum] of [['postgres', 20000, 21999], ['redis', 22000, 23999], ['debug-backend', 24000, 25999]])
        {
            assert.ok(admission.port(role) >= minimum && admission.port(role) <= maximum);
            await assert.rejects(attemptBind(admission.port(role)), { code: 'EADDRINUSE' });
            assert.ok(admission.dockerArguments(role).includes('--cpus'));
        }
        const limits = ['postgres', 'redis', 'debug-backend'].map((role) => admission.limits(role));
        assert.ok(limits.every((limit) => Number.isInteger(limit.cpuUnits * 1e9)));
        assert.ok(limits.reduce((sum, limit) => sum + limit.cpuUnits, 0) <= unit.options.nativeContainerContext.resourceGrant.cpuUnits + 1e-9);
        assert.ok(limits.reduce((sum, limit) => sum + Math.round(limit.memoryGiB * 1024 ** 3), 0) <= unit.options.nativeContainerContext.resourceGrant.memoryMaxBytes);
        assert.ok(limits.reduce((sum, limit) => sum + limit.pidsMax, 0) <= unit.options.nativeContainerContext.resourceGrant.pidsMax);
        const manifest = JSON.parse(fs.readFileSync(admission.manifestFile, 'utf8'));
        const { contentDigest, ...unsigned } = manifest;
        assert.equal(contentDigest, productionDiskDemandDigest(unsigned));
        assert.equal(manifest.schema, 'fsusblog.data-scale-port-admission.v1');
        assert.equal(manifest.controlMode, 'in-process-capability');
        assert.equal(Object.hasOwn(manifest, 'controlSocketPath'), false);
        assert.equal(manifest.leases.every((lease) => lease.handoffState === 'reserved'), true);
        assert.match(admission.inventoryFile, /\.tmp\/data-scale-admissions\//u);
        const common = Object.fromEntries(admission.labels().filter((_, index) => index % 2).map((label) =>
        {
            const index = label.indexOf('=');
            return [label.slice(0, index), label.slice(index + 1)];
        }));
        assert.equal(admission.owns({ Labels: common }), true);
        assert.equal(admission.owns({ Labels: { ...common, 'io.fsusblog.test.bundle-id': 'foreign-bundle' } }), false);
        assert.ok(admission.labels('permission-helper').includes('io.fsusblog.test.runtime-role=permission-helper'));
        const blocked = await admission.release({ cleanup: { status: 'blocked' } });
        assert.equal(blocked.status, 'blocked');
        assert.equal(fs.existsSync(admission.terminalReceiptFile), false);
        const released = await admission.release({ cleanup: { status: 'complete' } });
        assert.equal(released.status, 'complete');
        assert.equal(released.leaseObservations.length, 3);
        assert.ok(released.leaseObservations.every((observation) => observation.postStatus === 'released'));
        assert.deepEqual(unit.events, ['assert', 'heartbeat']);
        for (const role of ['postgres', 'redis', 'debug-backend'])
        {
            await attemptBind(admission.port(role));
        }
        assert.deepEqual(await admission.release({ cleanup: { status: 'complete' } }), released);
    }
    finally
    {
        if (admission)
        {
            await admission.release({ cleanup: { status: 'complete' } });
        }
        unit.remove();
    }
});

test('DataScale admission refuses missing original native context and rechecks held capabilities before every mutation', async () =>
{
    const unit = fixture();
    let admission;
    try
    {
        await assert.rejects(createDataScaleRuntimeAdmission({ ...unit.options,
            nativeContainerContext: { ...unit.options.nativeContainerContext, root: path.dirname(unit.options.repositoryRoot) } }), /original scheduler context/u);
        await assert.rejects(createDataScaleRuntimeAdmission({ ...unit.options,
            resourceGrant: { cpuUnits: 1.1, memoryGiB: 0.25 }, schedulerResourceGrant: { cpuUnits: 1.1, memoryGiB: 0.25 } }), /held native CPU\/memory envelope/u);
        unit.setNativeHeld(false);
        await assert.rejects(createDataScaleRuntimeAdmission(unit.options), /no longer held/u);
        assert.equal(fs.existsSync(path.join(unit.options.repositoryRoot, '.tmp')), false);
        unit.setNativeHeld(true);
        admission = await createDataScaleRuntimeAdmission(unit.options);
        unit.setNativeHeld(false);
        assert.throws(() => admission.assertHeld(), /no longer held/u);
        assert.throws(() => admission.labels('postgres'), /no longer held/u);
        assert.throws(() => admission.dockerArguments('postgres'), /no longer held/u);
        await assert.rejects(admission.beginHandoff('postgres'), /no longer held/u);
        await assert.rejects(admission.completeHandoff('postgres', '1'.repeat(64)), /no longer held/u);
        await assert.rejects(admission.publishResident({ services: [] }), /no longer held/u);
        await assert.rejects(admission.release({ cleanup: { status: 'complete' } }), /no longer held/u);
        assert.equal(fs.existsSync(admission.terminalReceiptFile), false);
    }
    finally
    {
        unit.setNativeHeld(true);
        if (admission)
        {
            await admission.release({ cleanup: { status: 'complete' } });
        }
        unit.remove();
    }
});

test('DataScale handoff refuses forged OCI custody and retains uncertain port observations', async () =>
{
    const unit = fixture();
    let failObservations = true;
    let admission;
    unit.options.execute = (program, args, options) =>
    {
        if (program === 'docker')
        {
            return { status: 0, stdout: JSON.stringify([{ Id: '1'.repeat(64),
                Created: '2026-10-06T00:00:00.000Z', State: { Running: true }, Config: { Labels: {} } }]) };
        }
        if (failObservations)
        {
            return { status: 1, stdout: '' };
        }
        return spawnSync(program, args, options);
    };
    try
    {
        admission = await createDataScaleRuntimeAdmission(unit.options);
        await assert.rejects(admission.completeHandoff('postgres', '1'.repeat(64)), /must begin/u);
        await admission.beginHandoff('postgres');
        await assert.rejects(admission.completeHandoff('postgres', '1'.repeat(64)), /custody mismatch/u);
        await assert.rejects(admission.publishResident({ services: [] }), /exact three-service roster/u);
        unit.exit();
        admission.activateRetainedCleanup(unit.cleanupCapability);
        const retained = await admission.release({ cleanup: { status: 'complete' } });
        assert.equal(retained.status, 'blocked');
        assert.equal(retained.leaseObservations.length, 0);
        assert.equal(fs.existsSync(admission.terminalReceiptFile), false);
    }
    finally
    {
        failObservations = false;
        if (admission)
        {
            await admission.release({ cleanup: { status: 'complete' } });
        }
        unit.remove();
    }
});

test('DataScale unit Docker seam binds enforced resident inventory and refuses failed absence observations', async () =>
{
    const unit = fixture();
    let admission;
    let removed = false;
    let dockerUnavailable = false;
    let checkpoint = { runId: unit.options.plan.parentSchedulerRunId };
    const documents = new Map();
    unit.options.checkpointAuthority = (file, update) =>
    {
        checkpoint = update(structuredClone(checkpoint));
        fs.writeFileSync(file, JSON.stringify(checkpoint));
        return checkpoint;
    };
    unit.options.execute = (program, args, options) =>
    {
        if (program !== 'docker')
        {
            return spawnSync(program, args, options);
        }
        if (dockerUnavailable)
        {
            return { status: 1, stdout: '' };
        }
        if (args[0] === 'inspect')
        {
            return { status: 0, stdout: JSON.stringify([documents.get(args[1])]) };
        }
        if (args[0] === 'stats')
        {
            return { status: 0, stdout: JSON.stringify({ MemUsage: '1MiB / 128MiB' }) };
        }
        if (args[0] === 'update')
        {
            const document = documents.get(args.at(-1));
            document.HostConfig.NanoCpus = Math.round(Number(args[args.indexOf('--cpus') + 1]) * 1e9);
            document.HostConfig.MemoryReservation = Number(args[args.indexOf('--memory-reservation') + 1]);
            document.HostConfig.Memory = Number(args[args.indexOf('--memory') + 1]);
            return { status: 0, stdout: document.Id };
        }
        if (args[0] === 'container' && args[1] === 'ls')
        {
            return { status: 0, stdout: removed ? '' : [...documents.keys()].join('\n') };
        }
        throw new Error('unexpected unit Docker observation');
    };
    try
    {
        admission = await createDataScaleRuntimeAdmission(unit.options);
        const services = [];
        for (const [index, role] of ['postgres', 'redis', 'debug-backend'].entries())
        {
            const containerId = String(index + 1).repeat(64);
            const containerPort = role === 'postgres' ? 5432 : role === 'redis' ? 6379 : 8080;
            const custody = Object.fromEntries(admission.labels(role).filter((_, item) => item % 2).map((label) =>
            {
                const separator = label.indexOf('=');
                return [label.slice(0, separator), label.slice(separator + 1)];
            }));
            documents.set(containerId, { Id: containerId, Created: '2026-10-06T00:00:00.000Z',
                State: { Running: true }, Config: { Labels: custody }, HostConfig: {},
                NetworkSettings: { Ports: { [`${containerPort}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(admission.port(role)) }] } } });
            await admission.beginHandoff(role);
            await admission.completeHandoff(role, containerId);
            services.push({ role, containerId, health: { status: 'ready', checkedAt: '2026-10-06T00:00:00.000Z' } });
        }
        const inventory = await admission.publishResident({ services });
        assert.equal(inventory.enforcement.mode, 'enforced');
        assert.equal(inventory.services.length, 3);
        assert.equal(checkpoint.residentResourceLeases.status, 'acquired');
        assert.equal(unit.events.filter((event) => event === 'complete').length, 0);
        unit.exit();
        admission.activateRetainedCleanup(unit.cleanupCapability);
        const live = await admission.release({ cleanup: { status: 'complete' } });
        assert.equal(live.status, 'blocked');
        assert.equal(fs.existsSync(admission.terminalReceiptFile), false);
        dockerUnavailable = true;
        const unknown = await admission.release({ cleanup: { status: 'complete' } });
        assert.equal(unknown.status, 'blocked');
        assert.ok(unknown.failures.every((failure) => failure.includes('unknown')));
        dockerUnavailable = false;
        removed = true;
        const released = await admission.release({ cleanup: { status: 'complete' } });
        assert.equal(released.status, 'complete');
        assert.equal(released.leaseObservations.length, 4);
        assert.equal(checkpoint.residentResourceLeases.status, 'released');
        assert.equal(checkpoint.residentResourceLeases.reservation.cpuUnits, 0);
        assert.equal(unit.events.filter((event) => event === 'complete').length, 0);
    }
    finally
    {
        dockerUnavailable = false;
        removed = true;
        if (admission)
        {
            await admission.release({ cleanup: { status: 'complete' } });
        }
        unit.remove();
    }
});


test('DataScale retained cleanup accepts only the original opaque capability and closes provisioning after exit', async () =>
{
    const unit = fixture();
    let admission;
    try
    {
        admission = await createDataScaleRuntimeAdmission(unit.options);
        assert.throws(() => admission.activateRetainedCleanup(unit.cleanupCapability), /terminal/u);
        unit.exit();
        assert.throws(() => admission.labels(), /no longer held/u);
        assert.throws(() => admission.activateRetainedCleanup({ assertRetained: unit.cleanupCapability.assertRetained }), /opaque/u);
        admission.activateRetainedCleanup(unit.cleanupCapability);
        admission.activateRetainedCleanup(unit.cleanupCapability);
        assert.throws(() => admission.labels(), /cleanup only/u);
        assert.throws(() => admission.limits('postgres'), /cleanup only/u);
        assert.throws(() => admission.dockerArguments('postgres'), /cleanup only/u);
        await assert.rejects(admission.beginHandoff('postgres'), /cleanup only/u);
        await assert.rejects(admission.completeHandoff('postgres', 'foreign-container'), /cleanup only/u);
        await assert.rejects(admission.publishResident({ services: [] }), /cleanup only/u);
        assert.equal((await admission.release({ cleanup: { status: 'blocked' } })).status, 'blocked');
        assert.equal(fs.existsSync(admission.terminalReceiptFile), false);
        assert.equal((await admission.release({ cleanup: { status: 'complete' } })).status, 'complete');
        assert.ok(unit.events.filter((event) => event === 'retained').length >= 5);
        unit.setNativeHeld(false);
        await assert.rejects(admission.release({ cleanup: { status: 'complete' } }), /remain held/u);
    }
    finally
    {
        unit.setNativeHeld(true);
        if (admission)
        {
            await admission.release({ cleanup: { status: 'complete' } });
        }
        unit.remove();
    }
});

test('DataScale retained cleanup rejects changed original Native identity without releasing ports', async () =>
{
    const unit = fixture();
    let admission;
    try
    {
        admission = await createDataScaleRuntimeAdmission(unit.options);
        unit.exit();
        const originalIdentity = Object.fromEntries(['root', 'runId', 'namespace', 'bundleId', 'stepId', 'sourceState']
            .map((key) => [key, unit.options.nativeContainerContext[key]]));
        unit.retainedIdentity({ ...originalIdentity, runId: 'foreign-run' });
        assert.throws(() => admission.activateRetainedCleanup(unit.cleanupCapability), /grant\/context drift/u);
        assert.equal(fs.existsSync(admission.terminalReceiptFile), false);
        await assert.rejects(attemptBind(admission.port('postgres')), { code: 'EADDRINUSE' });
        unit.retainedIdentity(originalIdentity);
        admission.activateRetainedCleanup(unit.cleanupCapability);
        assert.equal((await admission.release({ cleanup: { status: 'complete' } })).status, 'complete');
    }
    finally
    {
        unit.retainedIdentity(null);
        if (admission)
        {
            admission.activateRetainedCleanup(unit.cleanupCapability);
            await admission.release({ cleanup: { status: 'complete' } });
        }
        unit.remove();
    }
});
