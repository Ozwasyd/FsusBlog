import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createDataScaleRuntimeResourcePool } = await import(new URL('../../tools/test/data-scale-runtime-resource-pool.mjs', import.meta.url));

// This exercises the native API contract with controlled capabilities and OCI
// observations. It is not a native systemd, Docker or qualification receipt.
function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-resource-pool-unit-'));
    const admission = { runId: 'unit-pool', namespace: 'unit-pool', currentTierId: 'release-reliability-fresh',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) } };
    const resourceGrant = { cpuUnits: 4, memoryHighBytes: 3 * 1024 ** 3,
        memoryMaxBytes: 4 * 1024 ** 3, pidsMax: 512, memoryPageBytes: 4096 };
    const requests = [];
    const capabilities = [];
    const released = [];
    let attached = false;
    let exited = false;
    let cleanupPhase = false;
    const cleanupObservations = [];
    let documents = [];
    let inventoryFails = false;
    let reservationFails = false;
    let releaseFails = false;
    const options = {
        repositoryRoot: root, admission, resourceGrant, bundleId: 'release-reliability-fresh',
        resourceEnforcer: {
            reserveContainerResources(bundleId, request)
            {
                assert.equal(bundleId, 'release-reliability-fresh');
                if (reservationFails && request.id === 'data-scale-runtime')
                {
                    throw new Error('controlled second reservation refusal');
                }
                requests.push(request);
                let held = true;
                const cleanupCapability = Object.freeze({ assertRetained()
                {
                    assert.equal(held, true);
                    assert.equal(exited, true, 'unit exact service must be terminal');
                    cleanupObservations.push(request.id);
                    return { runId: admission.runId, bundleId, reservation: request, total: resourceGrant };
                } });
                const capability = {
                    assertHeld(context)
                    {
                        assert.equal(held, true);
                        assert.deepEqual(context, { ...request.identity, resourceGrant: request.limits });
                        if (!attached || exited || cleanupPhase)
                        {
                            throw new Error('original native owner is not attached');
                        }
                        return { reservation: request, total: resourceGrant };
                    },
                    retainCleanupCustody(context)
                    {
                        assert.deepEqual(context, { ...request.identity, resourceGrant: request.limits });
                        cleanupCapability.assertRetained();
                        cleanupPhase = true;
                        return cleanupCapability;
                    },
                    async releaseAfterCleanup(cleanup)
                    {
                        assert.equal(held, true);
                        assert.deepEqual(await cleanup(), { containerAbsent: true, credentialsRemoved: true });
                        if (releaseFails && request.id === 'qualified-baseline')
                        {
                            throw new Error('controlled native restore refusal');
                        }
                        held = false;
                        released.push(request.id);
                    }
                };
                capabilities.push(capability);
                return capability;
            }
        },
        execute(command, args)
        {
            assert.equal(command, 'docker');
            if (args[0] === 'container')
            {
                return { status: inventoryFails ? 1 : 0, stdout: documents.map((document) => document.Id).join('\n') };
            }
            assert.equal(args[0], 'inspect');
            return { status: 0, stdout: JSON.stringify(documents.filter((document) => document.Id === args[1])) };
        }
    };
    return { root, admission, options, requests, capabilities, released, cleanupObservations,
        exit: (value = true) =>
        {
            exited = value;
        },
        attach: () =>
        {
            attached = true;
        },
        documents: (value) =>
        {
            documents = value;
        },
        inventoryFails: (value) =>
        {
            inventoryFails = value;
        },
        reservationFails: () =>
        {
            reservationFails = true;
        },
        releaseFails: (value) =>
        {
            releaseFails = value;
        },
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('DataScale pools debit one native total for six containers and preserve positive host controls', async () =>
{
    const unit = fixture();
    try
    {
        const pool = createDataScaleRuntimeResourcePool(unit.options);
        assert.deepEqual(unit.requests.map((request) => request.id), ['qualified-baseline', 'data-scale-runtime']);
        assert.equal(pool.dataScale.nativeContainerReservation, unit.capabilities[1]);
        assert.throws(() => pool.baselineContainerControls(), /not attached/u);
        unit.attach();
        const controls = pool.baselineContainerControls();
        assert.equal(controls.namespace, unit.admission.namespace);
        assert.deepEqual(controls.sourceState, unit.admission.sourceState);
        const aggregate = pool.dataScale.containerLimits;
        for (const field of ['cpuUnits', 'memoryHighBytes', 'memoryMaxBytes', 'pidsMax'])
        {
            assert.equal(controls.roles.postgres[field] * 3, aggregate[field]);
            assert.ok(unit.options.resourceGrant[field] - aggregate[field] * 2 > 0);
        }
        assert.equal(aggregate.memoryMaxBytes, aggregate.memoryHighBytes);
        assert.equal(aggregate.memoryHighBytes / 3 % 4096, 0);
        assert.equal(aggregate.cpuUnits / 3 * 1000, Math.round(aggregate.cpuUnits / 3 * 1000));
        assert.deepEqual(pool.dataScale.nativeContainerContext,
            { ...unit.requests[1].identity, resourceGrant: unit.requests[1].limits });
        // A transport consumer cannot mutate the held context or role controls.
        controls.roles.postgres.cpuUnits = 1000;
        controls.sourceState.commit = 'f'.repeat(40);
        assert.notEqual(pool.baselineContainerControls().roles.postgres.cpuUnits, 1000);
        await pool.releaseAfterCleanup();
        assert.deepEqual(unit.released, ['data-scale-runtime', 'qualified-baseline']);
    }
    finally
    {
        unit.cleanup();
    }
});

test('DataScale missing native API and unrepresentable complete budgets reject before reservation', () =>
{
    const unit = fixture();
    try
    {
        assert.throws(() => createDataScaleRuntimeResourcePool({ ...unit.options, resourceEnforcer: {} }), /original native/u);
        assert.throws(() => createDataScaleRuntimeResourcePool({ ...unit.options,
            resourceGrant: { ...unit.options.resourceGrant, memoryHighBytes: 32 * 1024 ** 2 } }), /remainder/u);
        assert.throws(() => createDataScaleRuntimeResourcePool({ ...unit.options,
            resourceGrant: { ...unit.options.resourceGrant, memoryHighBytes: 100 } }), /representable/u);
        const unknownPage = { ...unit.options.resourceGrant };
        delete unknownPage.memoryPageBytes;
        assert.throws(() => createDataScaleRuntimeResourcePool({ ...unit.options,
            resourceGrant: unknownPage }), /representable/u);
        assert.equal(unit.requests.length, 0);
    }
    finally
    {
        unit.cleanup();
    }
});

test('DataScale fractional grants retain exact native nanoCPU and page representations', async () =>
{
    for (const cpuUnits of [1.5, 2.997, 4.2, 3.042])
    {
        const unit = fixture();
        try
        {
            const pool = createDataScaleRuntimeResourcePool({ ...unit.options,
                resourceGrant: { ...unit.options.resourceGrant, cpuUnits } });
            unit.attach();
            const role = pool.baselineContainerControls().roles.postgres;
            const aggregate = pool.dataScale.containerLimits;
            assert.ok(Number.isSafeInteger(aggregate.cpuUnits * 1e9));
            assert.ok(Number.isSafeInteger(role.cpuUnits * 1e9));
            assert.equal(role.cpuUnits * 1e9 * 3, aggregate.cpuUnits * 1e9);
            assert.ok(aggregate.cpuUnits * 1e9 * 2 < cpuUnits * 1e9);
            await pool.releaseAfterCleanup();
        }
        finally
        {
            unit.cleanup();
        }
    }
});

test('DataScale terminal restoration independently rejects OCI query failures and both parent labels', async () =>
{
    const unit = fixture();
    try
    {
        const pool = createDataScaleRuntimeResourcePool(unit.options);
        unit.inventoryFails(true);
        await assert.rejects(pool.releaseAfterCleanup(), /complete Docker inventory/u);
        unit.inventoryFails(false);
        for (const label of ['io.fsusblog.test.run-id', 'io.fsusblog.test.parent-run-id'])
        {
            unit.documents([{ Id: 'c'.repeat(64), State: { Running: false },
                Config: { Labels: { [label]: unit.admission.runId } } }]);
            await assert.rejects(pool.releaseAfterCleanup(), /retains a parent-run OCI/u);
        }
        assert.equal(unit.released.length, 0);
        unit.documents([{ Id: 'd'.repeat(64) }]);
        await assert.rejects(pool.releaseAfterCleanup(), /bind a Docker inventory identity/u);
        unit.documents([{ Id: 'd'.repeat(64), Config: { Labels: { 'io.fsusblog.test.run-id': 'unrelated-run' } } }]);
        await pool.releaseAfterCleanup();
        assert.equal(unit.released.length, 2);
    }
    finally
    {
        unit.cleanup();
    }
});

test('DataScale terminal restoration refuses owned credentials, runtime roots and unsafe ancestry', async () =>
{
    const unit = fixture();
    try
    {
        const pool = createDataScaleRuntimeResourcePool(unit.options);
        const envRoot = path.join(unit.root, '.tmp', 'env');
        fs.mkdirSync(envRoot, { recursive: true });
        for (const name of ['unit-pool.env', 'unit-pool.unit-pool.container.env'])
        {
            const file = path.join(envRoot, name);
            fs.writeFileSync(file, 'controlled-unit-secret');
            await assert.rejects(pool.releaseAfterCleanup(), /owned credentials/u);
            fs.rmSync(file);
        }
        const plan = { parentSchedulerRunId: unit.admission.runId, sourceCommit: unit.admission.sourceState.commit,
            worktreeFingerprint: `sha256:${unit.admission.sourceState.worktreeFingerprint}`,
            dataScaleRunId: `data-scale-${'e'.repeat(20)}`, namespace: `scale-${'e'.repeat(20)}` };
        assert.throws(() => pool.retainDataScalePlan({ ...plan, sourceCommit: 'f'.repeat(40) }), /original source/u);
        pool.retainDataScalePlan(plan);
        const runtimeRoot = path.join(unit.root, '.tmp', 'data-scale-runtime', plan.dataScaleRunId);
        fs.mkdirSync(runtimeRoot, { recursive: true });
        await assert.rejects(pool.releaseAfterCleanup(), /runtime root/u);
        fs.rmSync(runtimeRoot, { recursive: true });
        fs.rmSync(envRoot, { recursive: true });
        fs.symlinkSync(os.tmpdir(), envRoot);
        await assert.rejects(pool.releaseAfterCleanup(), /symlink/u);
        assert.equal(unit.released.length, 0);
        fs.rmSync(envRoot);
        await pool.releaseAfterCleanup();
    }
    finally
    {
        unit.cleanup();
    }
});

test('DataScale partial native reservation and restoration failures retain real cleanup closures', async () =>
{
    const unit = fixture();
    try
    {
        unit.reservationFails();
        let failed;
        try
        {
            createDataScaleRuntimeResourcePool(unit.options);
        }
        catch (error)
        {
            failed = error;
        }
        assert.match(failed.message, /second reservation/u);
        assert.equal(unit.requests.length, 1);
        assert.throws(() => failed.dataScaleResourcePool.baselineContainerControls(), /not held/u);
        await failed.dataScaleResourcePool.releaseAfterCleanup();
        assert.deepEqual(unit.released, ['qualified-baseline']);
    }
    finally
    {
        unit.cleanup();
    }
    const restore = fixture();
    try
    {
        const pool = createDataScaleRuntimeResourcePool(restore.options);
        restore.releaseFails(true);
        await assert.rejects(pool.releaseAfterCleanup(), /restore refusal/u);
        assert.deepEqual(restore.released, ['data-scale-runtime']);
        restore.releaseFails(false);
        await pool.releaseAfterCleanup();
        assert.deepEqual(restore.released, ['data-scale-runtime', 'qualified-baseline']);
        await pool.releaseAfterCleanup();
        assert.equal(restore.released.length, 2);
    }
    finally
    {
        restore.cleanup();
    }
});


test('DataScale parent cleanup binds the captured attempt and retains both grants until independent absence', async () =>
{
    const unit = fixture();
    try
    {
        const pool = createDataScaleRuntimeResourcePool(unit.options);
        const plan = { parentSchedulerRunId: unit.admission.runId, sourceCommit: unit.admission.sourceState.commit,
            worktreeFingerprint: `sha256:${unit.admission.sourceState.worktreeFingerprint}`,
            dataScaleRunId: `data-scale-${'e'.repeat(20)}`, namespace: `scale-${'e'.repeat(20)}`,
            invocationId: 'unit-invocation', attemptId: 'unit-attempt', contentDigest: 'captured-unit-plan' };
        pool.retainDataScalePlan(plan);
        assert.throws(() => pool.dataScale.retainCleanupCustody(plan), /terminal/u);
        unit.exit();
        for (const field of ['parentSchedulerRunId', 'invocationId', 'attemptId', 'contentDigest'])
        {
            assert.throws(() => pool.dataScale.retainCleanupCustody({ ...plan, [field]: 'foreign' }), /original retained/u);
        }
        assert.throws(() => pool.retainDataScalePlan({ ...plan, attemptId: 'foreign-attempt' }), /changed retained/u);
        const capability = pool.dataScale.retainCleanupCustody(plan);
        assert.equal(pool.dataScale.retainCleanupCustody(plan), capability);
        assert.throws(() => pool.baselineContainerControls(), /not attached/u);
        const runtimeRoot = path.join(unit.root, '.tmp/data-scale-runtime', plan.dataScaleRunId);
        fs.mkdirSync(runtimeRoot, { recursive: true });
        await assert.rejects(pool.releaseAfterCleanup(), /runtime root/u);
        assert.equal(unit.released.length, 0);
        fs.rmSync(runtimeRoot, { recursive: true });
        const credential = path.join(unit.root, '.tmp/env', `${unit.admission.namespace}.env`);
        fs.mkdirSync(path.dirname(credential), { recursive: true });
        fs.writeFileSync(credential, 'unit-owned-secret');
        await assert.rejects(pool.releaseAfterCleanup(), /credentials/u);
        assert.equal(unit.released.length, 0);
        fs.rmSync(credential);
        unit.inventoryFails(true);
        await assert.rejects(pool.releaseAfterCleanup(), /Docker inventory/u);
        unit.inventoryFails(false);
        unit.documents([{ Id: 'a'.repeat(64), Config: { Labels: { 'io.fsusblog.test.parent-run-id': unit.admission.runId } } }]);
        await assert.rejects(pool.releaseAfterCleanup(), /parent-run OCI/u);
        unit.documents([]);
        unit.exit(false);
        await assert.rejects(pool.releaseAfterCleanup(), /terminal/u);
        assert.equal(unit.released.length, 0);
        unit.exit();
        const observations = unit.cleanupObservations.length;
        await pool.releaseAfterCleanup();
        assert.deepEqual(unit.released, ['data-scale-runtime', 'qualified-baseline']);
        assert.equal(unit.cleanupObservations.length - observations, 4);
        assert.throws(() => capability.assertRetained());
    }
    finally
    {
        unit.cleanup();
    }
});
