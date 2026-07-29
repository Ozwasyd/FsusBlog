import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { runLocalProfile } = await import(new URL("../../tools/run-test-matrix.mjs", import.meta.url));
const { currentProcessIdentity } = await import(new URL("../../tools/test/process-identity.mjs", import.meta.url));
const { parseMatrix } = await import(new URL("../../tools/test-matrix/parse-matrix.mjs", import.meta.url));
const { acquireProductionCapacityReservation } = await import(new URL("../../tools/test-matrix/production-capacity-reservation.mjs", import.meta.url));
const { productionDiskDemandDigest } = await import(new URL("../../tools/test-matrix/production-disk-demand.mjs", import.meta.url));
const { createProductionFreshOutputRoot, finalizeProductionFreshAttempt } = await import(new URL("../../tools/test-matrix/production-fresh-run-bound-outputs.mjs", import.meta.url));
const { isProjectionOnlyCheckpointFailure, runDag } = await import(new URL("../../tools/test-matrix/scheduler.mjs", import.meta.url));

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const runner = fs.readFileSync(path.join(repositoryRoot, 'tools/run-test-matrix.mjs'), 'utf8');
const scheduler = fs.readFileSync(path.join(repositoryRoot, 'tools/test-matrix/scheduler.mjs'), 'utf8');

function productionRuntime(repository, runId)
{
    const sourceState = {
        commit: 'a'.repeat(40),
        worktreeFingerprint: productionDiskDemandDigest('fixture-worktree')
    };
    return {
        root: repository,
        productionFreshLeaseHeld: true,
        productionFreshLeaseOwner: {
            ownerToken: 'fixture-lease-owner',
            candidateIdentityDigest: productionDiskDemandDigest('fixture-candidate')
        },
        productionFreshRunIdentity: {
            runsRoot: path.join(repository, '.tmp/test-runs'),
            runId
        },
        productionFreshSourceState: sourceState,
        snapshotSourceState: async () => sourceState,
        detectedResources: {
            cpuCount: 8,
            availableCpuUnits: 8,
            availableMemoryGiB: 16,
            load1: 0,
            launchParallelism: 2,
            memoryReserveGiB: 1
        },
        resolveDockerRoot: () => repository,
        resolveFilesystem: (candidate) => ({
            filesystemIdentity: 'fixture:host',
            canonicalPath: path.resolve(candidate),
            availableBytes: 128 * 1024 ** 3
        }),
        inspectProductionFreshCacheTransactions: () => []
    };
}

async function createProjectionResumeFixture(name)
{
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const repository = path.join(parent, 'repository');
    fs.mkdirSync(repository);
    const runId = name;
    const firstAttempt = createProductionFreshOutputRoot({ root: repository, runId });
    const summaryFile = path.join(firstAttempt.outputRoot, 'summary/run.json');
    fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
    fs.writeFileSync(summaryFile, `${JSON.stringify({
        status: 'failure',
        qualificationEligible: false,
        executionSource: 'fresh',
        failure: { reason: 'logical projection failed' },
        failures: [{ reason: 'logical projection failed' }]
    })}\n`);
    await finalizeProductionFreshAttempt(firstAttempt, async () =>
    {});
    const checkpointPath = path.join(repository, '.tmp/test-runs', runId, 'checkpoint.json');
    const checkpoint = {
        runId,
        revision: 7,
        targetTierId: 'production',
        status: 'failure',
        mode: 'fresh',
        authoritative: true,
        failure: {
            reason: 'checkpoint evidence finalization failed: logical projection failed'
        },
        ungeneratedEvidence: [{
            tierId: 'production',
            declaration: 'logicalTierProjection'
        }],
        productionFreshOutputAttemptId: firstAttempt.attemptId,
        tiers: Object.fromEntries([
            'build-static',
            'backend-tests',
            'frontend-tests',
            'runtime-browser',
            'performance-evidence'
        ].map((id) => [id, { status: 'success', reused: false }]))
    };
    fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    return {
        parent,
        repository,
        runId,
        checkpointPath,
        firstAttempt,
        capacityAuthorityRoot: path.join(parent, 'capacity-authority')
    };
}

function removeProtectedFixture(directory)
{
    if (!fs.existsSync(directory))
    {
        return;
    }
    const makeWritable = (current) =>
    {
        const metadata = fs.lstatSync(current);
        if (metadata.isDirectory() && !metadata.isSymbolicLink())
        {
            fs.chmodSync(current, 0o700);
            for (const name of fs.readdirSync(current))
            {
                makeWritable(path.join(current, name));
            }
        }
        else if (!metadata.isSymbolicLink())
        {
            fs.chmodSync(current, 0o600);
        }
    };
    makeWritable(directory);
    fs.rmSync(directory, { recursive: true, force: true });
}

async function commitProjectionCheckpoint(
    checkpointPath,
    expectedRunId,
    _evidenceBuilder,
    options
)
{
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    assert.equal(checkpoint.runId, expectedRunId);
    const preparedCheckpoint = structuredClone(checkpoint);
    preparedCheckpoint.status = 'success';
    preparedCheckpoint.failure = null;
    delete preparedCheckpoint.ungeneratedEvidence;
    preparedCheckpoint.logicalTierProjection = {
        status: 'complete-success',
        qualificationEligible: true,
        logicalTierIds: []
    };
    await options.beforeCommit({
        checkpoint: structuredClone(preparedCheckpoint),
        evidence: {
            logicalTierProjection: structuredClone(preparedCheckpoint.logicalTierProjection)
        },
        checkpointFile: checkpointPath
    });
    fs.writeFileSync(checkpointPath, `${JSON.stringify(preparedCheckpoint, null, 2)}\n`);
    return preparedCheckpoint;
}

test('reservation is acquired before runtime/output/cache cleanup and build-root preparation', () =>
{
    const inspection = runner.indexOf('inspectProductionFreshCacheTransactions)(profileRoot)');
    const acquire = runner.indexOf('acquireReservation({');
    const staleRuntimeCleanup = runner.indexOf('executeProductionFreshPreflight({', acquire);
    const outputCleanup = runner.indexOf('cleanLocalProductionOutputs)(profileRoot', acquire);
    const buildRoot = runner.indexOf('runProductionBuildLifecycle({', acquire);
    assert.ok(inspection > 0);
    assert.ok(acquire > inspection);
    assert.ok(staleRuntimeCleanup > acquire);
    assert.ok(outputCleanup > staleRuntimeCleanup);
    assert.ok(buildRoot > outputCleanup);
});

test('live guard runs before output retirement, log creation and producer spawn', () =>
{
    const guard = scheduler.indexOf('await options.beforeTierStart?.(');
    const retirement = scheduler.indexOf('resume-candidate-retired', guard);
    const cleanup = scheduler.indexOf('cleanFreshOwnedFiles(root', guard);
    const log = scheduler.indexOf('createAsyncLogPipeline({', guard);
    const spawn = scheduler.indexOf('beginSubprocess(tier', guard);
    assert.ok(guard > 0);
    assert.ok(retirement > guard);
    assert.ok(cleanup > guard);
    assert.ok(log > cleanup);
    assert.ok(spawn > log);
});

test('--plan-only resolves and prints demand without acquiring reservation', () =>
{
    const guardedAcquire = runner.indexOf(
        'if (productionFresh && !options.planOnly && runtime.productionCapacityReservationHeld !== true)');
    const acquire = runner.indexOf('acquireReservation({', guardedAcquire);
    const planOnlyMatch = /if \(options\.planOnly\)\s*\{/u.exec(runner.slice(acquire));
    const planOnly = planOnlyMatch ? acquire + planOnlyMatch.index : -1;
    const printDemand = runner.indexOf('const diskPlan = resolveCapacityPlan()', planOnly);
    assert.ok(guardedAcquire > 0);
    assert.ok(acquire > guardedAcquire);
    assert.ok(planOnly > 0);
    assert.ok(printDemand > planOnly);
});

test('capacity rejection leaves every destructive action and old evidence at zero mutation', (t) =>
{
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-preflight-zero-'));
    const repository = path.join(parent, 'repository');
    const authority = path.join(parent, 'authority');
    fs.mkdirSync(repository);
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const oldEvidence = path.join(repository, 'failure-evidence.json');
    fs.writeFileSync(oldEvidence, '{"status":"old"}\n');
    const before = productionDiskDemandDigest(fs.readFileSync(oldEvidence));
    const actionCounts = {
        runtimeKillOrRemove: 0,
        containerRemove: 0,
        outputDeletion: 0,
        checkpointDeletion: 0,
        logDeletion: 0,
        cacheRenameOrDelete: 0,
        buildRootMutation: 0,
        staleBuildGcSpawn: 0,
        physicalProducerSpawn: 0
    };
    assert.throws(() => acquireProductionCapacityReservation({
        plan: {
            planDigest: productionDiskDemandDigest('plan'),
            producerDeclarationDigest: productionDiskDemandDigest('declarations'),
            producerDeclarations: [],
            filesystems: [{
                filesystemIdentity: 'fixture:full',
                canonicalPaths: [repository],
                rootIds: ['run-output'],
                observedFreeBytes: 99,
                requestedBytes: 100,
                safetyBytes: 1
            }]
        },
        runId: 'capacity-rejected',
        candidateIdentityDigest: productionDiskDemandDigest('candidate'),
        repositoryRoot: repository,
        repositoryLeaseOwner: { ownerToken: 'repository-lease-token' },
        authorityRoot: authority,
        ownerIdentity: currentProcessIdentity(),
        remeasureFilesystem: (filesystem) => filesystem.observedFreeBytes
    }), (error) =>
    {
        assert.equal(error.code, 'PRODUCTION_CAPACITY_ADMISSION_FAILED');
        assert.deepEqual(error.preflightActionCounts, {
            runtimeKillOrRemove: 0,
            containerRemove: 0,
            tempOrOutputDeletion: 0,
            checkpointDeletion: 0,
            logDeletion: 0,
            cacheRenameOrDelete: 0,
            buildRootMutation: 0,
            staleBuildGcSpawn: 0,
            physicalProducerSpawn: 0
        });
        assert.ok(fs.existsSync(error.receiptFile));
        assert.equal(path.dirname(path.dirname(error.receiptFile)), authority);
        assert.match(error.receiptDigest, /^sha256:[a-f0-9]{64}$/u);
        return true;
    });
    assert.deepEqual(actionCounts, Object.fromEntries(Object.keys(actionCounts).map((key) => [key, 0])));
    assert.equal(productionDiskDemandDigest(fs.readFileSync(oldEvidence)), before);
});

test('Production Fresh capacity rejection happens before the BehaviorDoc build callable', async (t) =>
{
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-before-behavior-doc-'));
    t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    let admissionCalls = 0;
    let reservationCalls = 0;
    await assert.rejects(
        runLocalProfile(
            matrix,
            'production',
            { planOnly: false, fresh: true, resume: false, maxParallel: 2 },
            {
                ...productionRuntime(repository, 'capacity-before-behavior-doc'),
                acquireProductionCapacityReservation: ({ plan }) =>
                {
                    reservationCalls += 1;
                    assert.ok(plan.producerDeclarations.some((entry) =>
                        entry.producerId === 'behavior-doc-static-admission'
            && entry.rootId === 'behavior-doc-cache'));
                    const error = new Error('fixture capacity rejected');
                    error.code = 'PRODUCTION_CAPACITY_ADMISSION_FAILED';
                    throw error;
                },
                runBehaviorDocStaticAdmission: async () =>
                {
                    admissionCalls += 1;
                    throw new Error('BehaviorDoc build must not be called');
                }
            }),
        /fixture capacity rejected/u);
    assert.equal(reservationCalls, 1);
    assert.equal(admissionCalls, 0);
    assert.equal(fs.existsSync(path.join(repository, '.tmp/behavior-doc-contract-builds')), false);
});

test('Production Fresh holds one reservation across one BehaviorDoc admission and continues', async (t) =>
{
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-holds-behavior-doc-'));
    t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const runId = 'capacity-holds-behavior-doc';
    const contentDigest = productionDiskDemandDigest('behavior-doc-receipt');
    let held = false;
    let acquireCalls = 0;
    let admissionCalls = 0;
    let guardCalls = 0;
    let completeCalls = 0;
    let releaseCalls = 0;
    let assertPlanCalls = 0;
    await assert.rejects(
        runLocalProfile(
            matrix,
            'production',
            { planOnly: false, fresh: true, resume: false, maxParallel: 2 },
            {
                ...productionRuntime(repository, runId),
                behaviorDocSourceIdentity: () => ({
                    sourceCommit: 'a'.repeat(40),
                    worktreeFingerprint: productionDiskDemandDigest('fixture-worktree')
                }),
                readBehaviorDocStaticAdmissionReceipt: () => ({ contentDigest }),
                acquireProductionCapacityReservation: ({ plan, runId: reservedRunId, candidateIdentityDigest }) =>
                {
                    acquireCalls += 1;
                    held = true;
                    assert.equal(reservedRunId, runId);
                    assert.equal(candidateIdentityDigest, productionDiskDemandDigest('fixture-candidate'));
                    assert.ok(plan.producerDeclarations.some((entry) =>
                        entry.producerId === 'behavior-doc-static-admission'));
                    return {
                        receipt: { reservationId: 'fixture-reservation' },
                        guardProducer: (producerId) =>
                        {
                            guardCalls += 1;
                            assert.equal(held, true);
                            assert.equal(producerId, 'behavior-doc-static-admission');
                        },
                        completeProducer: (producerId) =>
                        {
                            completeCalls += 1;
                            assert.equal(held, true);
                            assert.equal(producerId, 'behavior-doc-static-admission');
                        },
                        assertPlan: () =>
                        {
                            assertPlanCalls += 1;
                            throw new Error('continued-after-behavior-doc');
                        },
                        release: () =>
                        {
                            releaseCalls += 1;
                            held = false;
                        }
                    };
                },
                runBehaviorDocStaticAdmission: async ({ runId: admissionRunId }) =>
                {
                    admissionCalls += 1;
                    assert.equal(held, true);
                    assert.equal(admissionRunId, runId);
                    return {
                        receiptFile: path.join(repository, 'fixture-behavior-doc-receipt.json'),
                        receipt: { contentDigest }
                    };
                }
            }),
        /continued-after-behavior-doc/u);
    assert.equal(acquireCalls, 1);
    assert.equal(admissionCalls, 1);
    assert.equal(guardCalls, 1);
    assert.equal(completeCalls, 1);
    assert.equal(assertPlanCalls, 1);
    assert.equal(releaseCalls, 1);
    assert.equal(held, false);
});

test('source drift after BehaviorDoc admission fails closed and releases the reservation', async (t) =>
{
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-behavior-doc-drift-'));
    t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const runId = 'capacity-behavior-doc-drift';
    const contentDigest = productionDiskDemandDigest('behavior-doc-drift-receipt');
    let held = false;
    let admissionCalls = 0;
    let completeCalls = 0;
    let releaseCalls = 0;
    let cleanupCalls = 0;
    const runtime = productionRuntime(repository, runId);
    await assert.rejects(
        runLocalProfile(
            matrix,
            'production',
            { planOnly: false, fresh: true, resume: false, maxParallel: 2 },
            {
                ...runtime,
                snapshotSourceState: async () => ({
                    ...runtime.productionFreshSourceState,
                    worktreeFingerprint: productionDiskDemandDigest('drifted-worktree')
                }),
                acquireProductionCapacityReservation: () =>
                {
                    held = true;
                    return {
                        receipt: { reservationId: 'fixture-drift-reservation' },
                        guardProducer: () => assert.equal(held, true),
                        completeProducer: () =>
                        {
                            completeCalls += 1;
                        },
                        assertPlan: () =>
                        {},
                        release: () =>
                        {
                            releaseCalls += 1;
                            held = false;
                        }
                    };
                },
                runBehaviorDocStaticAdmission: async () =>
                {
                    admissionCalls += 1;
                    assert.equal(held, true);
                    return {
                        receiptFile: path.join(repository, 'fixture-drift-receipt.json'),
                        receipt: { contentDigest }
                    };
                },
                cleanupRuntime: () =>
                {
                    cleanupCalls += 1;
                    return {};
                }
            }),
        (error) =>
        {
            assert.equal(error.code, 'PRODUCTION_FRESH_SOURCE_DRIFT');
            assert.match(error.message, /source drifted across lease-bound BehaviorDoc verification/u);
            return true;
        });
    assert.equal(admissionCalls, 1);
    assert.equal(completeCalls, 0);
    assert.equal(cleanupCalls, 0);
    assert.equal(releaseCalls, 1);
    assert.equal(held, false);
    assert.equal(fs.existsSync(path.join(repository, '.tmp/test-runs')), false);
});

test('source drift with a pre-existing BehaviorDoc receipt also fails before cleanup', async (t) =>
{
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-existing-behavior-drift-'));
    t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const runId = 'capacity-existing-behavior-drift';
    const contentDigest = productionDiskDemandDigest('existing-behavior-receipt');
    const runtime = productionRuntime(repository, runId);
    let held = false;
    let admissionCalls = 0;
    let releaseCalls = 0;
    let cleanupCalls = 0;
    await assert.rejects(
        runLocalProfile(
            matrix,
            'production',
            { planOnly: false, fresh: true, resume: false, maxParallel: 2 },
            {
                ...runtime,
                behaviorDocStaticAdmission: {
                    receiptFile: path.join(repository, 'existing-behavior-receipt.json'),
                    runId,
                    contentDigest
                },
                behaviorDocSourceIdentity: () => ({
                    sourceCommit: 'a'.repeat(40),
                    worktreeFingerprint: productionDiskDemandDigest('fixture-worktree')
                }),
                readBehaviorDocStaticAdmissionReceipt: () => ({ contentDigest }),
                snapshotSourceState: async () => ({
                    ...runtime.productionFreshSourceState,
                    commit: 'b'.repeat(40)
                }),
                acquireProductionCapacityReservation: () =>
                {
                    held = true;
                    return {
                        receipt: { reservationId: 'fixture-existing-drift-reservation' },
                        guardProducer: () => assert.fail('pre-existing admission must not execute'),
                        completeProducer: () => assert.fail('pre-existing admission must not complete'),
                        assertPlan: () =>
                        {},
                        release: () =>
                        {
                            releaseCalls += 1;
                            held = false;
                        }
                    };
                },
                runBehaviorDocStaticAdmission: async () =>
                {
                    admissionCalls += 1;
                    throw new Error('pre-existing admission must not regenerate');
                },
                cleanupRuntime: () =>
                {
                    cleanupCalls += 1;
                    return {};
                }
            }),
        (error) =>
        {
            assert.equal(error.code, 'PRODUCTION_FRESH_SOURCE_DRIFT');
            return true;
        });
    assert.equal(admissionCalls, 0);
    assert.equal(cleanupCalls, 0);
    assert.equal(releaseCalls, 1);
    assert.equal(held, false);
});

test('BehaviorDoc admission and completion failures both release capacity before cleanup', async (t) =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    for (const failurePoint of ['admission', 'completion'])
    {
        await t.test(failurePoint, async (subtest) =>
        {
            const repository = fs.mkdtempSync(path.join(os.tmpdir(), `capacity-behavior-${failurePoint}-`));
            subtest.after(() => fs.rmSync(repository, { recursive: true, force: true }));
            const contentDigest = productionDiskDemandDigest(`${failurePoint}-receipt`);
            let held = false;
            let admissionCalls = 0;
            let completeCalls = 0;
            let releaseCalls = 0;
            let cleanupCalls = 0;
            await assert.rejects(
                runLocalProfile(
                    matrix,
                    'production',
                    { planOnly: false, fresh: true, resume: false, maxParallel: 2 },
                    {
                        ...productionRuntime(repository, `capacity-behavior-${failurePoint}`),
                        acquireProductionCapacityReservation: () =>
                        {
                            held = true;
                            return {
                                receipt: { reservationId: `fixture-${failurePoint}-reservation` },
                                guardProducer: () => assert.equal(held, true),
                                completeProducer: () =>
                                {
                                    completeCalls += 1;
                                    if (failurePoint === 'completion')
                                    {
                                        throw new Error('fixture BehaviorDoc completion failed');
                                    }
                                },
                                assertPlan: () =>
                                {},
                                release: () =>
                                {
                                    releaseCalls += 1;
                                    held = false;
                                }
                            };
                        },
                        runBehaviorDocStaticAdmission: async () =>
                        {
                            admissionCalls += 1;
                            assert.equal(held, true);
                            if (failurePoint === 'admission')
                            {
                                throw new Error('fixture BehaviorDoc admission failed');
                            }
                            return {
                                receiptFile: path.join(repository, `fixture-${failurePoint}-receipt.json`),
                                receipt: { contentDigest }
                            };
                        },
                        cleanupRuntime: () =>
                        {
                            cleanupCalls += 1;
                            return {};
                        }
                    }),
                new RegExp(`fixture BehaviorDoc ${failurePoint} failed`, 'u'));
            assert.equal(admissionCalls, 1);
            assert.equal(completeCalls, failurePoint === 'completion' ? 1 : 0);
            assert.equal(cleanupCalls, 0);
            assert.equal(releaseCalls, 1);
            assert.equal(held, false);
        });
    }
});

test('projection-only resume uses a narrow reservation and releases it as successful', async (t) =>
{
    const fixture = await createProjectionResumeFixture('capacity-projection-resume');
    t.after(() => removeProtectedFixture(fixture.parent));
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const availableBytes = 2 * 1024 ** 3;
    let admissionCalls = 0;
    let physicalSpawnCalls = 0;
    let cleanupCalls = 0;
    let dockerRootProbes = 0;
    const releases = [];
    const guardedProducers = [];
    const completedProducers = [];
    const contentDigest = productionDiskDemandDigest('projection-behavior-receipt');
    const result = await runLocalProfile(
        matrix,
        'production',
        { planOnly: false, fresh: false, resume: true, maxParallel: 2 },
        {
            ...productionRuntime(fixture.repository, fixture.runId),
            resolveDockerRoot: () =>
            {
                dockerRootProbes += 1;
                throw new Error('projection-only capacity must not resolve Docker storage');
            },
            behaviorDocSourceIdentity: () => ({
                sourceCommit: 'a'.repeat(40),
                worktreeFingerprint: productionDiskDemandDigest('fixture-worktree')
            }),
            readBehaviorDocStaticAdmissionReceipt: () => ({ contentDigest }),
            acquireProductionCapacityReservation: (options) =>
            {
                const producerIds = [...new Set(
                    options.plan.producerDeclarations.map((entry) => entry.producerId))];
                assert.deepEqual(
                    producerIds,
                    ['behavior-doc-static-admission', 'logical-projection-resume']);
                assert.ok(options.plan.filesystems.every((entry) =>
                    entry.requestedBytes + entry.safetyBytes < availableBytes));
                assert.ok(availableBytes < 19_886_243_840, 'fixture capacity must reject the full physical plan');
                const reservation = acquireProductionCapacityReservation({
                    ...options,
                    authorityRoot: fixture.capacityAuthorityRoot,
                    ownerIdentity: currentProcessIdentity(),
                    remeasureFilesystem: () => availableBytes,
                    heartbeatEveryMs: 60_000
                });
                return {
                    ...reservation,
                    get receipt()
                    {
                        return reservation.receipt;
                    },
                    guardProducer: (producerId) =>
                    {
                        guardedProducers.push(producerId);
                        return reservation.guardProducer(producerId);
                    },
                    completeProducer: (producerId) =>
                    {
                        completedProducers.push(producerId);
                        return reservation.completeProducer(producerId);
                    },
                    release: (terminalState) =>
                    {
                        releases.push(terminalState);
                        return reservation.release(terminalState);
                    }
                };
            },
            runBehaviorDocStaticAdmission: async () =>
            {
                admissionCalls += 1;
                return {
                    receiptFile: path.join(fixture.repository, 'projection-behavior-receipt.json'),
                    receipt: { contentDigest }
                };
            },
            resumeCheckpointEvidence: commitProjectionCheckpoint,
            cleanupRuntime: () =>
            {
                cleanupCalls += 1;
                return {};
            },
            executeTier: () =>
            {
                physicalSpawnCalls += 1;
                return 0;
            }
        });
    assert.equal(result.status, 'success');
    assert.equal(admissionCalls, 1);
    assert.equal(physicalSpawnCalls, 0);
    assert.equal(cleanupCalls, 0);
    assert.equal(dockerRootProbes, 0);
    assert.deepEqual(
        guardedProducers,
        ['behavior-doc-static-admission', 'logical-projection-resume']);
    assert.deepEqual(
        completedProducers,
        ['behavior-doc-static-admission', 'logical-projection-resume']);
    assert.deepEqual(releases, ['released']);
    assert.deepEqual(
        fs.readdirSync(path.join(
            fixture.repository,
            '.tmp/test-runs',
            fixture.runId,
            'outputs/attempts')).sort(),
        ['attempt-0001', 'attempt-0002']);
});

test('projection completion under-declaration preserves projection-only checkpoint for a narrow retry', async (t) =>
{
    const fixture = await createProjectionResumeFixture('capacity-projection-under-declared');
    t.after(() => removeProtectedFixture(fixture.parent));
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const availableBytes = 2 * 1024 ** 3;
    const contentDigest = productionDiskDemandDigest('projection-under-declared-receipt');
    const releases = [];
    const admittedProducerSets = [];
    let reservationCount = 0;
    const runtime = () => ({
        ...productionRuntime(fixture.repository, fixture.runId),
        behaviorDocSourceIdentity: () => ({
            sourceCommit: 'a'.repeat(40),
            worktreeFingerprint: productionDiskDemandDigest('fixture-worktree')
        }),
        readBehaviorDocStaticAdmissionReceipt: () => ({ contentDigest }),
        runBehaviorDocStaticAdmission: async () => ({
            receiptFile: path.join(fixture.repository, 'projection-under-declared-receipt.json'),
            receipt: { contentDigest }
        }),
        acquireProductionCapacityReservation: (options) =>
        {
            reservationCount += 1;
            const producerIds = [...new Set(
                options.plan.producerDeclarations.map((entry) => entry.producerId))];
            admittedProducerSets.push(producerIds);
            assert.deepEqual(
                producerIds,
                ['behavior-doc-static-admission', 'logical-projection-resume']);
            assert.ok(options.plan.filesystems.every((entry) =>
                entry.requestedBytes + entry.safetyBytes < availableBytes));
            const reservation = acquireProductionCapacityReservation({
                ...options,
                authorityRoot: fixture.capacityAuthorityRoot,
                ownerIdentity: currentProcessIdentity(),
                remeasureFilesystem: () => availableBytes,
                heartbeatEveryMs: 60_000
            });
            return {
                ...reservation,
                get receipt()
                {
                    return reservation.receipt;
                },
                completeProducer: (producerId) =>
                {
                    if (reservationCount === 1 && producerId === 'logical-projection-resume')
                    {
                        const error = new Error(
                            'Production capacity estimator under-declared logical-projection-resume');
                        error.code = 'ESTIMATOR_UNDER_DECLARED';
                        throw error;
                    }
                    return reservation.completeProducer(producerId);
                },
                release: (terminalState) =>
                {
                    releases.push(terminalState);
                    return reservation.release(terminalState);
                }
            };
        },
        resumeCheckpointEvidence: commitProjectionCheckpoint
    });

    await assert.rejects(
        runLocalProfile(
            matrix,
            'production',
            { planOnly: false, fresh: false, resume: true, maxParallel: 2 },
            runtime()),
        (error) =>
        {
            assert.equal(error.code, 'ESTIMATOR_UNDER_DECLARED');
            return true;
        });
    const failedCheckpoint = JSON.parse(fs.readFileSync(fixture.checkpointPath, 'utf8'));
    assert.equal(failedCheckpoint.status, 'failure');
    assert.equal(failedCheckpoint.logicalTierProjection, undefined);
    assert.equal(isProjectionOnlyCheckpointFailure(failedCheckpoint), true);
    assert.deepEqual(releases, ['aborted']);
    assert.deepEqual(
        fs.readdirSync(path.join(
            fixture.repository,
            '.tmp/test-runs',
            fixture.runId,
            'outputs/attempts')).sort(),
        ['attempt-0001', 'attempt-0002']);

    const retry = await runLocalProfile(
        matrix,
        'production',
        { planOnly: false, fresh: false, resume: true, maxParallel: 2 },
        runtime());
    assert.equal(retry.status, 'success');
    assert.equal(reservationCount, 2);
    assert.deepEqual(admittedProducerSets, [
        ['behavior-doc-static-admission', 'logical-projection-resume'],
        ['behavior-doc-static-admission', 'logical-projection-resume']
    ]);
    assert.deepEqual(releases, ['aborted', 'released']);
    assert.equal(
        JSON.parse(fs.readFileSync(fixture.checkpointPath, 'utf8')).status,
        'success');
    assert.deepEqual(
        fs.readdirSync(path.join(
            fixture.repository,
            '.tmp/test-runs',
            fixture.runId,
            'outputs/attempts')).sort(),
        ['attempt-0001', 'attempt-0002', 'attempt-0003']);
});

test('projection checkpoint drift after reservation aborts before creating an output attempt', async (t) =>
{
    const fixture = await createProjectionResumeFixture('capacity-projection-drift');
    t.after(() => removeProtectedFixture(fixture.parent));
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const contentDigest = productionDiskDemandDigest('projection-existing-receipt');
    const releases = [];
    let projectionCalls = 0;
    const runtime = productionRuntime(fixture.repository, fixture.runId);
    await assert.rejects(
        runLocalProfile(
            matrix,
            'production',
            { planOnly: false, fresh: false, resume: true, maxParallel: 2 },
            {
                ...runtime,
                behaviorDocStaticAdmission: {
                    receiptFile: path.join(fixture.repository, 'existing-projection-receipt.json'),
                    runId: fixture.runId,
                    contentDigest
                },
                behaviorDocSourceIdentity: () => ({
                    sourceCommit: 'a'.repeat(40),
                    worktreeFingerprint: productionDiskDemandDigest('fixture-worktree')
                }),
                readBehaviorDocStaticAdmissionReceipt: () => ({ contentDigest }),
                acquireProductionCapacityReservation: (options) =>
                {
                    const reservation = acquireProductionCapacityReservation({
                        ...options,
                        authorityRoot: fixture.capacityAuthorityRoot,
                        ownerIdentity: currentProcessIdentity(),
                        remeasureFilesystem: () => 2 * 1024 ** 3,
                        heartbeatEveryMs: 60_000
                    });
                    const checkpoint = JSON.parse(fs.readFileSync(fixture.checkpointPath, 'utf8'));
                    checkpoint.revision += 1;
                    fs.writeFileSync(fixture.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
                    return {
                        ...reservation,
                        get receipt()
                        {
                            return reservation.receipt;
                        },
                        release: (terminalState) =>
                        {
                            releases.push(terminalState);
                            return reservation.release(terminalState);
                        }
                    };
                },
                resumeCheckpointEvidence: async () =>
                {
                    projectionCalls += 1;
                    throw new Error('projection must not start after checkpoint drift');
                }
            }),
        (error) =>
        {
            assert.equal(error.code, 'PRODUCTION_RESUME_CHECKPOINT_DRIFT');
            return true;
        });
    assert.equal(projectionCalls, 0);
    assert.deepEqual(releases, ['aborted']);
    assert.deepEqual(
        fs.readdirSync(path.join(
            fixture.repository,
            '.tmp/test-runs',
            fixture.runId,
            'outputs/attempts')),
        ['attempt-0001']);
});

test('scheduler admission rejection records zero spawn and does not execute the producer', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-scheduler-zero-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, '.gitignore'), '.tmp/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
    let spawnCount = 0;
    const result = await runDag({
        root,
        runsRoot: path.join(root, '.tmp/test-runs'),
        runId: 'capacity-guard-zero-spawn',
        targetTierId: 'producer',
        namespace: 'capacity-guard',
        maxParallel: 1,
        tiers: [{
            id: 'producer',
            command: 'true',
            executionDependsOn: [],
            parallelizable: true,
            exclusiveResources: [],
            resourceClass: 'io',
            cpuUnits: 1,
            memoryGiB: 0.1
        }],
        systemResources: {
            cpuCount: 2,
            availableCpuUnits: 2,
            availableMemoryGiB: 2,
            memoryReserveGiB: 0,
            load1: 0
        },
        beforeTierStart: () =>
        {
            const error = new Error('external-capacity-loss');
            error.code = 'EXTERNAL_CAPACITY_LOSS';
            throw error;
        },
        executeTier: () =>
        {
            spawnCount += 1;
            return 0;
        }
    });
    assert.equal(result.status, 'failure');
    assert.equal(spawnCount, 0);
    assert.equal(result.checkpoint.tiers.producer.producerSpawnCount, 0);
});
