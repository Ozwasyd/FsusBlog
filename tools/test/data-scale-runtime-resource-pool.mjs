import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const tierId = 'release-reliability-fresh';
const bytesPerGiB = 1024 ** 3;
const roles = ['postgres', 'redis', 'backend'];

function safeId(value, label)
{
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value))
    {
        throw new Error(`DataScale resource pool ${label} is invalid`);
    }
    return value;
}

function fingerprint(value)
{
    return String(value ?? '').replace(/^sha256:/u, '');
}

function absentPath(root, relative)
{
    let cursor = root;
    for (const segment of relative.split('/'))
    {
        cursor = path.join(cursor, segment);
        const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
        if (!stat)
        {
            return true;
        }
        if (stat.isSymbolicLink())
        {
            throw new Error('DataScale resource cleanup has a symlink in its owned ancestry');
        }
        if (cursor !== path.join(root, relative) && !stat.isDirectory())
        {
            throw new Error('DataScale resource cleanup has unsafe owned ancestry');
        }
    }
    return false;
}

// Reservations are capabilities from the original native enforcer. The
// immutable admission binds identity; it does not itself authorize resources.
export function createDataScaleRuntimeResourcePool({
    resourceEnforcer, bundleId, admission, resourceGrant, repositoryRoot,
    execute = spawnSync
})
{
    const root = fs.realpathSync(repositoryRoot);
    safeId(bundleId, 'bundleId');
    safeId(admission?.runId, 'runId');
    safeId(admission?.namespace, 'namespace');
    if (admission?.currentTierId !== tierId
        || !/^[a-f0-9]{40}$/u.test(admission.sourceState?.commit ?? '')
        || !/^[a-f0-9]{64}$/u.test(fingerprint(admission.sourceState?.worktreeFingerprint))
        || typeof resourceEnforcer?.reserveContainerResources !== 'function')
    {
        throw new Error('DataScale resource pool requires its exact tier and original native reservation owner');
    }
    const total = structuredClone(resourceGrant);
    const page = Number(total.memoryPageBytes);
    const cpu = Number(total.cpuUnits);
    const high = Number(total.memoryHighBytes);
    const max = Number(total.memoryMaxBytes);
    const pids = Number(total.pidsMax);
    if (!Number.isFinite(cpu) || cpu <= 0 || !Number.isSafeInteger(cpu * 1e9)
        || !Number.isSafeInteger(page) || page < 1 || (page & (page - 1)) !== 0
        || !Number.isSafeInteger(high) || !Number.isSafeInteger(max) || max < high
        || high % page !== 0 || max % page !== 0
        || !Number.isSafeInteger(pids) || pids <= 0)
    {
        throw new Error('DataScale resource pool requires the actual representable native total controls');
    }
    // Six OCI residents retain two thirds of the parent envelope. Both host
    // frontend processes, the launcher and measured commands share the original
    // enforced process remainder. Divide by the complete resident roster, never
    // the transient number of bootstrap workers.
    let perRoleMilliCpu = Math.floor(cpu * 1000 / 9);
    while (perRoleMilliCpu > 0
        && (!Number.isSafeInteger(perRoleMilliCpu / 1000 * 1e9)
            || !Number.isSafeInteger(perRoleMilliCpu * 3 / 1000 * 1e9)))
    {
        perRoleMilliCpu -= 1;
    }
    const perRole = {
        cpuUnits: perRoleMilliCpu / 1000,
        memoryHighBytes: Math.floor(high / page / 9) * page,
        memoryMaxBytes: Math.floor(high / page / 9) * page,
        pidsMax: Math.floor(pids / 9)
    };
    const aggregate = {
        cpuUnits: perRoleMilliCpu * 3 / 1000,
        memoryHighBytes: perRole.memoryHighBytes * 3,
        memoryMaxBytes: perRole.memoryMaxBytes * 3,
        pidsMax: perRole.pidsMax * 3
    };
    if (perRole.cpuUnits < 0.001 || perRole.memoryHighBytes < 16 * 1024 ** 2 || perRole.pidsMax < 1
        || cpu - aggregate.cpuUnits * 2 <= 0
        || high - aggregate.memoryHighBytes * 2 < 16 * 1024 ** 2
        || pids - aggregate.pidsMax * 2 < 1)
    {
        throw new Error('DataScale complete resident roster leaves no valid native process remainder');
    }
    const identity = {
        root, runId: admission.runId, namespace: admission.namespace, bundleId,
        stepId: tierId, sourceState: structuredClone(admission.sourceState)
    };
    const context = { ...identity, resourceGrant: aggregate };
    const held = [];
    const plans = new Map();
    let released = false;
    let releasePromise = null;

    function command(args)
    {
        const result = execute('docker', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
        if (result?.status !== 0 || result.error)
        {
            throw new Error('DataScale resource cleanup cannot independently observe the complete Docker inventory');
        }
        return String(result.stdout ?? '').trim();
    }

    function observeCleanup()
    {
        const ids = command(['container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'])
            .split('\n').filter(Boolean);
        if (new Set(ids).size !== ids.length || ids.some((id) => !/^[a-f0-9]{64}$/u.test(id)))
        {
            throw new Error('DataScale resource cleanup received an incomplete or invalid Docker inventory');
        }
        for (const id of ids)
        {
            const documents = JSON.parse(command(['inspect', id]));
            if (!Array.isArray(documents) || documents.length !== 1 || documents[0].Id !== id
                || !documents[0].Config || typeof documents[0].Config !== 'object'
                || (documents[0].Config.Labels !== null && typeof documents[0].Config.Labels !== 'object'))
            {
                throw new Error('DataScale resource cleanup cannot bind a Docker inventory identity');
            }
            const labels = documents[0].Config?.Labels ?? {};
            if (labels['io.fsusblog.test.run-id'] === identity.runId
                || labels['io.fsusblog.test.parent-run-id'] === identity.runId)
            {
                throw new Error('DataScale resource pool retains a parent-run OCI identity');
            }
        }
        const credentials = [`.tmp/env/${identity.namespace}.env`,
            `.tmp/env/${identity.namespace}.${identity.runId}.container.env`];
        if (credentials.some((relative) => !absentPath(root, relative))
            || [...plans.values()].some((relative) => !absentPath(root, relative)))
        {
            throw new Error('DataScale resource pool retains its owned credentials or runtime root');
        }
        return { containerAbsent: true, credentialsRemoved: true };
    }

    const pool = {
        // Numeric transport values never substitute for this held-capability
        // check. The private caller runs this before each baseline OCI creation.
        baselineContainerControls()
        {
            if (released || held.length !== 2)
            {
                throw new Error('DataScale baseline resource pool is not held');
            }
            held[0].assertHeld(structuredClone(context));
            return {
                runId: identity.runId, namespace: identity.namespace,
                sourceState: structuredClone(identity.sourceState),
                roles: Object.fromEntries(roles.map((role) => [role, { ...perRole }]))
            };
        },
        retainDataScalePlan(plan)
        {
            if (released || plan?.parentSchedulerRunId !== identity.runId
                || plan.sourceCommit !== identity.sourceState.commit
                || fingerprint(plan.worktreeFingerprint) !== fingerprint(identity.sourceState.worktreeFingerprint)
                || !/^data-scale-[a-f0-9]{20}$/u.test(plan.dataScaleRunId ?? '')
                || plan.namespace !== `scale-${plan.dataScaleRunId.slice('data-scale-'.length)}`)
            {
                throw new Error('DataScale resource pool plan crosses its original source owner');
            }
            plans.set(plan.dataScaleRunId, `.tmp/data-scale-runtime/${plan.dataScaleRunId}`);
        },
        releaseAfterCleanup()
        {
            if (released)
            {
                return Promise.resolve({ containerAbsent: true, credentialsRemoved: true });
            }
            releasePromise ??= (async () =>
            {
                // Independently re-observe before each reservation restoration.
                // A partial restoration preserves every still-held capability.
                for (let index = held.length - 1; index >= 0; index -= 1)
                {
                    await held[index].releaseAfterCleanup(async () => observeCleanup());
                    held.splice(index, 1);
                }
                released = true;
                return { containerAbsent: true, credentialsRemoved: true };
            })().catch((error) =>
            {
                releasePromise = null;
                throw error;
            });
            return releasePromise;
        }
    };
    try
    {
        for (const id of ['qualified-baseline', 'data-scale-runtime'])
        {
            held.push(resourceEnforcer.reserveContainerResources(bundleId, {
                id, identity: structuredClone(identity), limits: { ...aggregate }
            }));
        }
    }
    catch (error)
    {
        // The original enforcer retains partially reserved grants. Carry the
        // actual cleanup closure with the failure instead of fabricating release.
        Object.defineProperty(error, 'dataScaleResourcePool', { value: pool });
        throw error;
    }
    pool.dataScale = Object.freeze({
        resourceGrant: Object.freeze({ cpuUnits: aggregate.cpuUnits, memoryGiB: aggregate.memoryHighBytes / bytesPerGiB }),
        containerLimits: Object.freeze({ ...aggregate }),
        nativeContainerReservation: held[1],
        nativeContainerContext: structuredClone(context)
    });
    return Object.freeze(pool);
}
