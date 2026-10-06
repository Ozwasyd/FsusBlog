import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { acquireProductionFreshExclusiveLease } = await import(new URL('../test-matrix/production-fresh-exclusive-lease.mjs', import.meta.url));
const { acquireProductionCapacityReservation } = await import(new URL('../test-matrix/production-capacity-reservation.mjs', import.meta.url));
const { createDataScaleDiskDemandPlan } = await import(new URL('./data-scale-disk-demand.mjs', import.meta.url));
const { createDataScaleRuntimeResourcePool } = await import(new URL('./data-scale-runtime-resource-pool.mjs', import.meta.url));
const { startDataScaleRuntimeCaller } = await import(new URL('./data-scale-runtime-caller.mjs', import.meta.url));
const { provisionDataScaleRuntime, teardownDataScaleRuntime } = await import(new URL('./data-scale-runtime-owner.mjs', import.meta.url));

// This owner runs in the canonical scheduler process. Only observations cross
// the socket; repository/capacity/native/checkpoint capabilities stay here.
export async function createDataScaleRuntimeSchedulerOwner({
    root, runsRoot, admission, admissionReference, environment, resourceEnforcer,
    resourceGrant, checkpointFile, checkpointAuthority, registerRetainedFinalizer
})
{
    if (admission.currentTierId !== 'release-reliability-fresh')
    {
        throw new Error('DataScale scheduler owner is restricted to its canonical tier');
    }
    if (typeof resourceEnforcer?.reserveContainerResources !== 'function'
        || typeof checkpointAuthority !== 'function' || typeof registerRetainedFinalizer !== 'function')
    {
        throw new Error('DataScale requires its current native reservation, checkpoint and retained-finalizer owners');
    }
    const lease = acquireProductionFreshExclusiveLease({
        root, runId: admission.runId, targetTierId: admission.targetTierId,
        sourceState: admission.sourceState, budgetPolicyDigest: admission.budgetPolicyDigest,
        candidateIdentityDigest: admission.schedulerCandidateIdentityDigest
    });
    let capacity;
    let pool;
    let caller;
    let disposed = false;
    const invocationId = randomUUID();
    try
    {
        const buildRoot = environment.FSUSBLOG_PRODUCTION_BUILD_ROOT;
        if (!buildRoot || !fs.existsSync(buildRoot))
        {
            throw new Error('DataScale requires the actual current production build root');
        }
        const plan = createDataScaleDiskDemandPlan({
            root, runId: admission.runId, buildRoot,
            resolveDockerRoot()
            {
                const observed = spawnSync('docker', ['info', '--format', '{{.DockerRootDir}}'], {
                    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 ** 2
                });
                if (observed.error || observed.status !== 0 || !path.isAbsolute(observed.stdout.trim()))
                {
                    throw new Error('DataScale cannot observe its actual Docker storage filesystem');
                }
                return observed.stdout.trim();
            }
        });
        capacity = acquireProductionCapacityReservation({
            plan, runId: admission.runId, repositoryRoot: root,
            candidateIdentityDigest: admission.schedulerCandidateIdentityDigest,
            repositoryLeaseOwner: lease.owner
        });
        capacity.assertPlan(plan);
        capacity.guardProducer(admission.currentTierId);
        pool = createDataScaleRuntimeResourcePool({
            repositoryRoot: root, resourceEnforcer, bundleId: admission.currentTierId, admission, resourceGrant
        });
        caller = await startDataScaleRuntimeCaller({
            root, runsRoot, admission, admissionReference,
            environment: {
                ...environment,
                // The original production lane seals this complete Server
                // domain. Consume those exact producer bytes, rather than
                // treating an acceptance rebuild as the same artifact.
                FSUSBLOG_PRODUCTION_BUILD_ROOT: path.join(root, '.tmp/ci-production-build', admission.runId),
                FSUSBLOG_BACKEND_SERVER_DLL: path.join(root, '.tmp/ci-production-build', admission.runId,
                    'payload/backend-runtime/FsusBlog.Server.dll'),
                FSUSBLOG_TEST_FIXTURE_CONFIG: `.tmp/env/${admission.namespace}.env`,
                FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: admission.runId,
                FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: invocationId,
                FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID: `${invocationId}.attempt-1`
            },
            baselineContainerControls: () => pool.baselineContainerControls(),
            runtimeAdmission: {
                ...pool.dataScale, schedulerResourceGrant: pool.dataScale.resourceGrant,
                productionCapacityReservation: capacity,
                productionCapacityPlan: plan, capacityProducerId: admission.currentTierId,
                candidateIdentityDigest: admission.schedulerCandidateIdentityDigest,
                ownerBundleId: admission.currentTierId, checkpointFile, checkpointAuthority
            },
            provision: (options) => provisionDataScaleRuntime({
                ...options, repositoryRoot: root,
                async onPlan(prepared)
                {
                    await options.onPlan(prepared);
                    pool.retainDataScalePlan(prepared.plan);
                }
            }),
            teardown: (options) => teardownDataScaleRuntime({ ...options, repositoryRoot: root })
        });
        return {
            environment: { ...caller.environment, FSUSBLOG_RELEASE_INVOCATION_ID: invocationId,
                FSUSBLOG_RELEASE_RUN_ID: admission.runId },
            async dispose({ success = false } = {})
            {
                if (disposed) return;
                // A failed cleanup retains the live native/capacity/repository
                // owners; it cannot mint a released receipt or retire custody.
                await caller.dispose();
                await pool.releaseAfterCleanup();
                capacity.completeProducer(admission.currentTierId);
                capacity.release(success ? 'released' : 'aborted');
                lease.release(success ? 'complete' : 'failed');
                disposed = true;
            }
        };
    }
    catch (error)
    {
        pool ??= error.dataScaleResourcePool;
        try
        {
            await caller?.dispose();
            await pool?.releaseAfterCleanup();
            capacity?.release('aborted');
            lease.release('failed');
        }
        catch (cleanupError)
        {
            registerRetainedFinalizer(async () =>
            {
                await caller?.dispose();
                await pool?.releaseAfterCleanup();
                capacity?.release('aborted');
                lease.release('failed');
            });
            throw new AggregateError([error, cleanupError], 'DataScale scheduler admission failed with custody retained', { cause: error });
        }
        throw error;
    }
}
