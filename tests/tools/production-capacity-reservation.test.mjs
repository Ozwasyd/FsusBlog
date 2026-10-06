import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { currentProcessIdentity } = await import(new URL("../../tools/test/process-identity.mjs", import.meta.url));
const { acquireProductionCapacityReservation } = await import(new URL("../../tools/test-matrix/production-capacity-reservation.mjs", import.meta.url));
const { canonicalFilesystemIdentity, productionDiskDemandDigest } = await import(new URL("../../tools/test-matrix/production-disk-demand.mjs", import.meta.url));
const { finalizeProductionBuildLayout, prepareProductionBuildLayout } = await import(new URL('../../tools/test-matrix/production-build-layout.mjs', import.meta.url));
const { acquireProductionFreshExclusiveLease } = await import(new URL('../../tools/test-matrix/production-fresh-exclusive-lease.mjs', import.meta.url));

function prepareCapacityBuild(reservationOptions)
{
    return prepareProductionBuildLayout({ root: reservationOptions.repositoryRoot, runId: reservationOptions.runId,
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }, namespace: 'capacity-test' });
}

function fixturePlan({ free = 999, requested = 400, safety = 100 } = {})
{
    const declarations = [{
        producerId: 'producer',
        rootId: 'run-output',
        peakAdditionalBytes: 250,
        terminalRetainedBytes: 100,
        rollbackOrRecoveryBytes: 50,
        uncertaintyBytes: 50,
        concurrencyClass: 'fixture',
        estimatorVersion: 'fixture-v1',
        sourceOfEstimate: 'fixture measurement'
    }];
    return {
        schema: 'fsusblog.production-disk-demand-plan.v1',
        planDigest: productionDiskDemandDigest({ plan: 'fixture', requested }),
        producerDeclarationDigest: productionDiskDemandDigest(declarations),
        producerDeclarations: declarations,
        filesystems: [{
            filesystemIdentity: 'fixture:fs',
            canonicalPaths: [os.tmpdir()],
            rootIds: ['run-output'],
            observedFreeBytes: free,
            requestedBytes: requested,
            safetyBytes: safety
        }]
    };
}

function options(t, plan = fixturePlan())
{
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-reservation-'));
    const repositoryRoot = path.join(parent, 'repository');
    const authorityRoot = path.join(parent, 'authority');
    fs.mkdirSync(repositoryRoot);
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    return {
        plan,
        runId: 'run-fixture',
        candidateIdentityDigest: productionDiskDemandDigest('candidate'),
        repositoryRoot,
        repositoryLeaseOwner: { ownerToken: 'lease-owner-token' },
        authorityRoot,
        ownerIdentity: currentProcessIdentity(),
        remeasureFilesystem: (filesystem) => filesystem.observedFreeBytes
    };
}

test('second run subtracts an active reservation on the same filesystem', (t) =>
{
    const firstOptions = options(t);
    const first = acquireProductionCapacityReservation(firstOptions);
    assert.throws(() => acquireProductionCapacityReservation({
        ...firstOptions,
        runId: 'run-second'
    }), /active reservation|admission failed/u);
    first.release('released');
    const second = acquireProductionCapacityReservation({
        ...firstOptions,
        runId: 'run-second'
    });
    second.release('released');
});

test('prior resource reconciliation is an explicit admitted-reservation operation', async (t) =>
{
    const reservation = acquireProductionCapacityReservation(options(t));
    try
    {
        assert.deepEqual(await reservation.reconcilePriorBuildResources(), []);
    }
    finally
    {
        reservation.release('aborted');
    }
    await assert.rejects(() => reservation.reconcilePriorBuildResources(), /reservation.*released/u);
});

test('capacity discovery rejects non-private or aliased original journals before adoption', async (t) =>
{
    for (const variant of ['symlink', 'hardlink', 'public-file', 'public-directory', 'wrong-filename'])
    {
        await t.test(variant, { skip: process.platform === 'win32' && ['symlink', 'public-file', 'public-directory'].includes(variant) }, (subtest) =>
        {
            const reservationOptions = options(subtest);
            const reservation = acquireProductionCapacityReservation(reservationOptions);
            const file = reservation.activeFile;
            const directory = path.dirname(file);
            const saved = path.join(reservationOptions.authorityRoot, 'saved-original.json');
            const renamed = path.join(directory, 'different-reservation.json');
            const original = fs.readFileSync(file, 'utf8');
            if (variant === 'symlink' || variant === 'hardlink')
            {
                fs.renameSync(file, saved);
                if (variant === 'symlink')
                {
                    fs.symlinkSync(saved, file);
                }
                else
                {
                    fs.linkSync(saved, file);
                }
            }
            else if (variant === 'wrong-filename')
            {
                fs.renameSync(file, renamed);
            }
            else
            {
                fs.chmodSync(variant === 'public-file' ? file : directory, 0o777);
            }
            try
            {
                assert.throws(() => acquireProductionCapacityReservation({ ...reservationOptions, runId: 'another-run' }),
                    /reservation.*(private|identity)/u);
                assert.equal(fs.readFileSync(variant === 'wrong-filename' ? renamed : file, 'utf8'), original);
                assert.equal(fs.existsSync(path.join(reservationOptions.authorityRoot, 'terminal')), false);
            }
            finally
            {
                if (variant === 'symlink' || variant === 'hardlink')
                {
                    fs.unlinkSync(file);
                    fs.renameSync(saved, file);
                }
                else if (variant === 'wrong-filename')
                {
                    fs.renameSync(renamed, file);
                }
                else
                {
                    fs.chmodSync(variant === 'public-file' ? file : directory, variant === 'public-file' ? 0o600 : 0o700);
                }
                reservation.release('aborted');
            }
        });
    }
});

test('an empty aliased active directory cannot redirect reservation writes', { skip: process.platform === 'win32' }, (t) =>
{
    const reservationOptions = options(t);
    fs.mkdirSync(reservationOptions.authorityRoot, { mode: 0o700 });
    const foreign = path.join(path.dirname(reservationOptions.repositoryRoot), 'foreign-empty-directory');
    fs.mkdirSync(foreign, { mode: 0o700 });
    fs.symlinkSync(foreign, path.join(reservationOptions.authorityRoot, 'active'));
    assert.throws(() => acquireProductionCapacityReservation(reservationOptions), /reservation directory.*private/u);
    assert.deepEqual(fs.readdirSync(foreign), []);
});

test('prior resource recovery excludes other repositories and refuses a live original controller', async (t) =>
{
    const oldOptions = options(t, fixturePlan({ free: 4096 }));
    const original = acquireProductionCapacityReservation({ ...oldOptions, heartbeatEveryMs: 60_000 });
    const layout = prepareCapacityBuild(oldOptions);
    original.retainBuildOwner(layout);
    const bytes = fs.readFileSync(original.activeFile, 'utf8');
    const foreignRoot = path.join(path.dirname(oldOptions.repositoryRoot), 'foreign-repository');
    fs.mkdirSync(foreignRoot);
    const foreign = acquireProductionCapacityReservation({ ...oldOptions, repositoryRoot: foreignRoot, runId: 'foreign-run' });
    try
    {
        assert.deepEqual(await foreign.reconcilePriorBuildResources(), []);
        assert.equal(fs.readFileSync(original.activeFile, 'utf8'), bytes);
    }
    finally
    {
        foreign.release('aborted');
    }
    fs.mkdirSync(path.join(oldOptions.repositoryRoot, '.git'));
    const runId = 'next-same-repository';
    const lease = acquireProductionFreshExclusiveLease({ root: oldOptions.repositoryRoot, runId,
        targetTierId: 'production', sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) } });
    const next = acquireProductionCapacityReservation({ ...oldOptions, runId,
        repositoryLeaseOwner: lease.owner, candidateIdentityDigest: lease.owner.candidateIdentityDigest });
    try
    {
        await assert.rejects(() => next.reconcilePriorBuildResources(), /prior build owner is live, changed or unverifiable/u);
        assert.equal(fs.readFileSync(original.activeFile, 'utf8'), bytes);
    }
    finally
    {
        next.release('aborted');
        lease.release('failed');
        finalizeProductionBuildLayout(layout, { status: 'failure' });
        original.release('aborted');
    }
});

test('a plan larger than the retired 4 GiB threshold rejects while a small declared plan admits', (t) =>
{
    const gib = 1024 ** 3;
    assert.throws(() => acquireProductionCapacityReservation(options(t, fixturePlan({
        free: 5 * gib,
        requested: 6 * gib,
        safety: 1
    }))), /capacity admission failed/u);
    const small = acquireProductionCapacityReservation(options(t, fixturePlan({
        free: 1024 ** 2,
        requested: 512 * 1024,
        safety: 128 * 1024
    })));
    small.release('released');
});

test('one insufficient filesystem rejects the whole multi-filesystem reservation', (t) =>
{
    const plan = fixturePlan();
    plan.filesystems.push({
        filesystemIdentity: 'fixture:docker',
        canonicalPaths: [os.tmpdir()],
        rootIds: ['docker-storage'],
        observedFreeBytes: 99,
        requestedBytes: 100,
        safetyBytes: 1
    });
    assert.throws(() => acquireProductionCapacityReservation(options(t, plan)), /fixture:docker/u);
});

test('admission remeasures free bytes while holding the authority lock', (t) =>
{
    const reservationOptions = options(t);
    reservationOptions.remeasureFilesystem = () => 499;
    assert.throws(
        () => acquireProductionCapacityReservation(reservationOptions),
        /capacity admission failed/u);
});

test('guard and completion re-resolve a deleted planned leaf on the same filesystem', (t) =>
{
    const plan = fixturePlan({ requested: 1, safety: 1 });
    const reservationOptions = options(t, plan);
    const plannedLeaf = path.join(
        reservationOptions.repositoryRoot,
        '.tmp',
        'behavior-doc-contract-builds');
    fs.mkdirSync(plannedLeaf, { recursive: true });
    const plannedFilesystem = canonicalFilesystemIdentity(plannedLeaf);
    plan.filesystems[0] = {
        ...plan.filesystems[0],
        filesystemIdentity: plannedFilesystem.filesystemIdentity,
        canonicalPaths: [plannedFilesystem.canonicalPath],
        observedFreeBytes: plannedFilesystem.availableBytes
    };
    delete reservationOptions.remeasureFilesystem;

    // Exercise the default path/identity remeasurement while isolating its free-byte
    // counter from unrelated writers on the shared test filesystem. Estimator
    // under-declaration is covered separately; its 300-byte fixture grant is unchanged.
    const readFilesystem = fs.statfsSync;
    const initialStatistics = readFilesystem(plannedLeaf);
    const probes = [];
    fs.statfsSync = (probe, settings) =>
    {
        const observed = readFilesystem(probe, settings);
        probes.push(String(probe));
        return { ...observed, bavail: initialStatistics.bavail };
    };
    let reservation;
    try
    {
        reservation = acquireProductionCapacityReservation(reservationOptions);
        fs.rmSync(plannedLeaf, { recursive: true, force: true });
        assert.equal(reservation.guardProducer('producer').status, 'admitted');
        assert.equal(reservation.completeProducer('producer').status, 'within-declaration');
        assert.ok(probes.filter((probe) => probe === path.dirname(plannedLeaf)).length >= 2,
            'guard and completion must independently re-resolve the deleted leaf to its existing ancestor');
    }
    finally
    {
        fs.statfsSync = readFilesystem;
        reservation?.release('released');
    }
});

test('owner PID reuse or command mismatch remains blocking', (t) =>
{
    const firstOptions = options(t);
    const first = acquireProductionCapacityReservation(firstOptions);
    assert.throws(() => acquireProductionCapacityReservation({
        ...firstOptions,
        runId: 'run-second',
        verifyOwner: () => ({ status: 'identity-mismatch' })
    }), /admission failed/u);
    const blocked = JSON.parse(fs.readFileSync(first.activeFile, 'utf8'));
    assert.equal(blocked.state, 'recovery-required');
});

test('dead owner with a live process tree remains blocking; zero residuals recover', (t) =>
{
    const firstOptions = options(t);
    const first = acquireProductionCapacityReservation(firstOptions);
    assert.throws(() => acquireProductionCapacityReservation({
        ...firstOptions,
        runId: 'run-second',
        verifyOwner: () => ({ status: 'process-tree-live' })
    }), /admission failed/u);
    const recovered = acquireProductionCapacityReservation({
        ...firstOptions,
        runId: 'run-second',
        verifyOwner: () => ({ status: 'terminal' })
    });
    recovered.release('released');
    assert.ok(first.activeFile);
});

test('plan drift is rejected before cleanup and release uses compare-owner token', (t) =>
{
    const reservation = acquireProductionCapacityReservation(options(t));
    assert.throws(() => reservation.assertPlan({
        ...fixturePlan(),
        planDigest: productionDiskDemandDigest('changed')
    }), /drift requires a new reservation/u);
    const release = reservation.release('released');
    assert.equal(release.receipt.state, 'released');
    assert.ok(fs.existsSync(release.file));
});

test('CAS rejects a resealed journal whose immutable plan identity was changed', (t) =>
{
    const reservation = acquireProductionCapacityReservation(options(t));
    const original = JSON.parse(fs.readFileSync(reservation.activeFile, 'utf8'));
    const changed = {
        ...original,
        planDigest: productionDiskDemandDigest('tampered-plan')
    };
    const payload = { ...changed };
    delete payload.contentDigest;
    changed.contentDigest = productionDiskDemandDigest(payload);
    fs.writeFileSync(reservation.activeFile, `${JSON.stringify(changed, null, 2)}\n`);
    assert.throws(() => reservation.release('released'), /compare-owner-token failed/u);
    fs.writeFileSync(reservation.activeFile, `${JSON.stringify(original, null, 2)}\n`);
    reservation.release('aborted');
});

test('a stale authority lock is recovered by full process identity, not PID alone', (t) =>
{
    const reservationOptions = options(t);
    const lock = path.join(reservationOptions.authorityRoot, 'authority.lock');
    fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
    const ownerIdentity = {
        ...currentProcessIdentity(),
        processStartIdentity: 'linux:stale-boot:1'
    };
    const payload = {
        schema: 'fsusblog.production-capacity-authority-lock.v1',
        ownerToken: 'stale-authority-owner',
        ownerIdentity,
        createdAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify({
        ...payload,
        contentDigest: productionDiskDemandDigest(payload)
    }, null, 2)}\n`);
    const reservation = acquireProductionCapacityReservation(reservationOptions);
    reservation.release('released');
});

test('a resealed authority lock with an incomplete owner fails closed', (t) =>
{
    const reservationOptions = options(t);
    const lock = path.join(reservationOptions.authorityRoot, 'authority.lock');
    fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
    const payload = {
        schema: 'fsusblog.production-capacity-authority-lock.v1',
        ownerToken: 'forged-authority-owner',
        ownerIdentity: { pid: process.pid },
        createdAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify({
        ...payload,
        contentDigest: productionDiskDemandDigest(payload)
    }, null, 2)}\n`);
    assert.throws(
        () => acquireProductionCapacityReservation(reservationOptions),
        /lock is invalid or tampered/u);
});

test('external capacity loss blocks spawn and under-declaration is classified', (t) =>
{
    let availableBytes = 999;
    const reservation = acquireProductionCapacityReservation({
        ...options(t),
        remeasureFilesystem: () => availableBytes
    });
    availableBytes = 399;
    assert.throws(
        () => reservation.guardProducer('producer'),
        (error) => error.code === 'EXTERNAL_CAPACITY_LOSS');
    availableBytes = 1000;
    reservation.guardProducer('producer');
    availableBytes = 600;
    assert.throws(
        () => reservation.completeProducer('producer'),
        (error) => error.code === 'ESTIMATOR_UNDER_DECLARED');
    reservation.release('aborted');
});

test('success, failure, timeout and cancel terminal paths seal release receipts', (t) =>
{
    for (const terminalState of ['released', 'failure', 'timeout', 'cancel'])
    {
        const reservation = acquireProductionCapacityReservation({
            ...options(t),
            runId: `run-${terminalState}`
        });
        const release = reservation.release(terminalState);
        assert.ok(fs.existsSync(release.file));
        assert.equal(release.receipt.terminalState, terminalState);
        assert.equal(release.receipt.state, terminalState === 'released' ? 'released' : 'aborted');
    }
});

test('capacity retains its exact build owner until terminal sealing and refuses new producers after retention', (t) =>
{
    const reservationOptions = options(t);
    const reservation = acquireProductionCapacityReservation(reservationOptions);
    const layout = prepareCapacityBuild(reservationOptions);
    const reference = reservation.retainBuildOwner(layout);
    assert.deepEqual(reservation.retainBuildOwner(layout), reference);
    assert.deepEqual(reservation.receipt.buildOwnerReference, reference);
    assert.throws(() => reservation.release('aborted'), (error) => error.code === 'PRODUCTION_CAPACITY_RETAINED');
    assert.equal(reservation.receipt.state, 'recovery-required');
    assert.equal(reservation.receipt.filesystems[0].admittedBytes, 500);
    assert.throws(() => reservation.guardProducer('producer'), /requires recovery/u);
    // Explicit dead-owner simulation cannot replace the actual build owner's observations.
    assert.throws(() => acquireProductionCapacityReservation({ ...reservationOptions,
        runId: 'run-second', verifyOwner: () => ({ status: 'terminal' }) }), /admission failed/u);
    assert.equal(finalizeProductionBuildLayout(layout, { status: 'failure' }).owner.state, 'failed');
    assert.equal(reservation.release('aborted').receipt.state, 'aborted');
    assert.equal(fs.existsSync(reservation.activeFile), false);
});

test('capacity binding rejects another run and cannot be erased by a resealed journal', (t) =>
{
    const reservationOptions = options(t);
    const reservation = acquireProductionCapacityReservation(reservationOptions);
    const wrong = prepareCapacityBuild({ ...reservationOptions, runId: 'another-run' });
    assert.throws(() => reservation.retainBuildOwner(wrong), /cross-bind/u);
    const layout = prepareCapacityBuild(reservationOptions);
    assert.throws(() => reservation.retainBuildOwner({ ...layout, manifestFile: wrong.manifestFile }), /canonical owner record paths/u);
    reservation.retainBuildOwner(layout);
    const original = JSON.parse(fs.readFileSync(reservation.activeFile, 'utf8'));
    const changed = { ...original, buildOwnerReference: null };
    delete changed.contentDigest;
    changed.contentDigest = productionDiskDemandDigest(changed);
    fs.writeFileSync(reservation.activeFile, JSON.stringify(changed));
    assert.throws(() => reservation.release('released'), /compare-owner-token failed/u);
    fs.writeFileSync(reservation.activeFile, JSON.stringify(original));
    finalizeProductionBuildLayout(layout, { status: 'failure' });
    reservation.release('aborted');
    finalizeProductionBuildLayout(wrong, { status: 'failure' });
});

test('capacity release and recovery retain missing, replaced or identity-drifted build owners', async (t) =>
{
    for (const variant of ['missing', 'replaced', 'source', 'receipt'])
    {
        await t.test(variant, (t) =>
        {
            const reservationOptions = options(t);
            const reservation = acquireProductionCapacityReservation(reservationOptions);
            const layout = prepareCapacityBuild(reservationOptions);
            reservation.retainBuildOwner(layout);
            finalizeProductionBuildLayout(layout, { status: 'failure' });
            if (['missing', 'replaced'].includes(variant))
            {
                fs.renameSync(layout.runRoot, `${layout.runRoot}.retained`);
                if (variant === 'replaced')
                {
                    fs.cpSync(`${layout.runRoot}.retained`, layout.runRoot, { recursive: true });
                }
            }
            else
            {
                const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
                if (variant === 'source')
                {
                    manifest.owner.sourceCommit = 'c'.repeat(40);
                }
                else
                {
                    manifest.owner.processTreeReceipt.receiptDigest = `sha256:${'0'.repeat(64)}`;
                }
                fs.writeFileSync(layout.manifestFile, JSON.stringify(manifest));
            }
            assert.throws(() => reservation.release('released'), (error) => error.code === 'PRODUCTION_CAPACITY_RETAINED');
            assert.throws(() => acquireProductionCapacityReservation({ ...reservationOptions,
                runId: 'run-second', verifyOwner: () => ({ status: 'terminal' }) }), /admission failed/u);
            assert.equal(JSON.parse(fs.readFileSync(reservation.activeFile, 'utf8')).state, 'recovery-required');
            assert.equal(fs.existsSync(path.join(reservation.authorityRoot, 'terminal', `${reservation.receipt.reservationId}.json`)), false);
        });
    }
});

test('a legacy capacity journal without an explicit build-owner binding cannot be silently recovered', (t) =>
{
    const reservationOptions = options(t);
    const reservation = acquireProductionCapacityReservation(reservationOptions);
    const original = JSON.parse(fs.readFileSync(reservation.activeFile, 'utf8'));
    const legacy = { ...original };
    delete legacy.buildOwnerReference;
    delete legacy.contentDigest;
    legacy.contentDigest = productionDiskDemandDigest(legacy);
    fs.writeFileSync(reservation.activeFile, JSON.stringify(legacy));
    assert.throws(() => acquireProductionCapacityReservation({ ...reservationOptions,
        runId: 'run-second', verifyOwner: () => ({ status: 'terminal' }) }), /invalid or tampered/u);
    fs.writeFileSync(reservation.activeFile, JSON.stringify(original));
    reservation.release('aborted');
});

test('actual exited controller with an empty retained build owner permits capacity recovery', {
    skip: process.platform === 'win32'
}, (t) =>
{
    const reservationOptions = options(t);
    const childOptions = { ...reservationOptions };
    delete childOptions.ownerIdentity;
    delete childOptions.remeasureFilesystem;
    const source = `
        import { acquireProductionCapacityReservation } from ${JSON.stringify(new URL('../../tools/test-matrix/production-capacity-reservation.mjs', import.meta.url).href)};
        import { prepareProductionBuildLayout } from ${JSON.stringify(new URL('../../tools/test-matrix/production-build-layout.mjs', import.meta.url).href)};
        const options = ${JSON.stringify(childOptions)};
        const reservation = acquireProductionCapacityReservation({ ...options,
            remeasureFilesystem: value => value.observedFreeBytes });
        const layout = prepareProductionBuildLayout({ root: options.repositoryRoot, runId: options.runId,
            sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }, namespace: 'capacity-crash' });
        reservation.retainBuildOwner(layout);
        process.stdout.write(reservation.activeFile);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        detached: true, encoding: 'utf8', timeout: 30_000
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const activeFile = child.stdout.trim();
    assert.equal(JSON.parse(fs.readFileSync(activeFile, 'utf8')).state, 'active');
    const next = acquireProductionCapacityReservation({ ...reservationOptions, runId: 'run-second' });
    assert.equal(fs.existsSync(activeFile), false);
    next.release('released');
});
