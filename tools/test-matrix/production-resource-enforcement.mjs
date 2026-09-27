import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

const { createSystemdResourceTransport, inspectProductionSystemdServiceBinding, prepareProductionSystemdResourceBoundary } = await import(new URL('./production-systemd-resource-boundary.mjs', import.meta.url));
const { collectProcessIdentity } = await import(new URL('../test/process-identity.mjs', import.meta.url));

export const resourceEnforcementSchema = 'fsusblog.production.resource-enforcement.v1';
const controllers = ['cpu', 'memory', 'pids'];
const bytesPerGiB = 1024 ** 3;
let observedMemoryPageBytes;

function memoryPageBytes(machine)
{
    let value = machine.memoryPageBytes;
    if (value === undefined)
    {
        if (observedMemoryPageBytes === undefined)
        {
            if (process.platform === 'linux')
            {
                const result = spawnSync('getconf', ['PAGESIZE'], {
                    encoding: 'utf8', shell: false, timeout: 5000, maxBuffer: 1024
                });
                if (result.error || result.status !== 0 || !/^\d+\s*$/u.test(result.stdout ?? ''))
                {
                    throw new Error('Linux memory page size is unavailable for exact cgroup limits');
                }
                observedMemoryPageBytes = Number(result.stdout.trim());
            }
            else
            {
                // A non-Linux projection is advisory; it does not attest kernel enforcement.
                observedMemoryPageBytes = 1;
            }
        }
        value = observedMemoryPageBytes;
    }
    if (!Number.isSafeInteger(value) || value <= 0 || value > 16 * 1024 ** 2 || (value & (value - 1)) !== 0)
    {
        throw new Error('memory page size must be an exact supported power of two');
    }
    return value;
}

function exceedsFloatingPointEnvelope(value, envelope)
{
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(envelope)) * 4;
    return value > envelope + tolerance;
}

function safeSegment(value, name)
{
    const segment = String(value ?? '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(segment))
    {
        throw new Error(`${name} is not cgroup-safe`);
    }
    return segment;
}

function readText(file)
{
    try
    {
        return fs.readFileSync(file, 'utf8').trim();
    }
    catch
    {
        return null;
    }
}

function parseKeyValues(value)
{
    if (value === null)
    {
        return null;
    }
    return Object.fromEntries(value.split('\n').filter(Boolean).map((line) =>
    {
        const [key, raw] = line.trim().split(/\s+/u);
        const number = Number(raw);
        return [key, Number.isFinite(number) ? number : raw];
    }));
}

function numericOrNull(value)
{
    if (value === null || value === '')
    {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function selfCgroupPath(procCgroup = readText('/proc/self/cgroup'))
{
    const unified = String(procCgroup ?? '').split('\n').find((line) => line.startsWith('0::'));
    return unified ? unified.slice(3) : null;
}

export function resolveProductionCgroupCapabilities(options = {})
{
    if ((options.platform ?? process.platform) !== 'linux')
    {
        return { status: 'unsupported', reason: 'non-linux', cgroupVersion: null, delegateRoot: null, controllers: [] };
    }
    const mountRoot = path.resolve(options.mountRoot ?? '/sys/fs/cgroup');
    const mountType = options.mountType ?? (() =>
    {
        try
        {
            return fs.statfsSync(mountRoot).type === 0x63677270 ? 'cgroup2fs' : 'other';
        }
        catch
        {
            return 'unavailable';
        }
    })();
    if (mountType !== 'cgroup2fs')
    {
        return { status: 'unsupported', reason: 'cgroup-v2-unavailable', cgroupVersion: mountType, delegateRoot: null, controllers: [] };
    }
    const explicitRoot = options.delegateRoot ?? process.env.FSUSBLOG_CGROUP_DELEGATE_ROOT;
    const relativeSelf = selfCgroupPath(options.procCgroup);
    const delegateRoot = path.resolve(explicitRoot || path.join(mountRoot, relativeSelf ?? '/'));
    if (!delegateRoot.startsWith(`${mountRoot}${path.sep}`) && delegateRoot !== mountRoot)
    {
        return { status: 'unavailable', reason: 'delegate-root-outside-cgroup-mount', cgroupVersion: 2, delegateRoot, controllers: [] };
    }
    const available = String(readText(path.join(delegateRoot, 'cgroup.controllers')) ?? '').split(/\s+/u).filter(Boolean);
    const missing = controllers.filter((controller) => !available.includes(controller));
    if (missing.length)
    {
        return { status: 'unavailable', reason: `controllers-missing:${missing.join(',')}`, cgroupVersion: 2, delegateRoot, controllers: available };
    }
    try
    {
        fs.accessSync(delegateRoot, fs.constants.W_OK);
    }
    catch
    {
        return { status: 'unavailable', reason: 'delegate-root-not-writable', cgroupVersion: 2, delegateRoot, controllers: available };
    }
    return { status: 'available', reason: null, cgroupVersion: 2, delegateRoot, controllers: available };
}

function writeControl(file, value)
{
    fs.writeFileSync(file, String(value));
    const effective = readText(file);
    return effective;
}

function enableControllers(directory)
{
    return writeControl(path.join(directory, 'cgroup.subtree_control'), controllers.map((name) => `+${name}`).join(' '));
}

export function resolveCgroupLimits(grant, machine)
{
    const pageBytes = memoryPageBytes(machine);
    const cpuUnits = Number(grant.cpuUnits);
    const memoryGiB = Number(grant.memoryGiB);
    const machineCpu = Math.max(1, Number(machine.cpuUnits ?? machine.cpuCount) || os.availableParallelism?.() || 1);
    const machineMemoryGiB = Math.max(Number.EPSILON, Number(machine.memoryGiB) || os.totalmem() / bytesPerGiB);
    const machineMemoryBytes = Math.max(1, Math.round(machineMemoryGiB * bytesPerGiB));
    if (!Number.isFinite(cpuUnits) || cpuUnits <= 0 || !Number.isFinite(memoryGiB) || memoryGiB <= 0)
    {
        throw new Error('cgroup limits require positive CPU and memory grants');
    }
    if (exceedsFloatingPointEnvelope(cpuUnits, machineCpu))
    {
        throw new Error(`cgroup CPU grant ${cpuUnits} exceeds machine envelope ${machineCpu}`);
    }
    const requestedMemoryBytes = Math.max(1, Math.round(memoryGiB * bytesPerGiB));
    if (requestedMemoryBytes > machineMemoryBytes)
    {
        throw new Error(`cgroup memory grant ${memoryGiB} GiB exceeds machine envelope ${machineMemoryGiB} GiB`);
    }
    const periodUs = Math.max(10_000, Math.min(1_000_000, Math.round(100_000 * Math.sqrt(machineCpu) / Math.sqrt(cpuUnits))));
    const quotaUs = Math.max(1_000, Math.floor(periodUs * cpuUnits));
    const memoryHighBytes = Math.max(16 * 1024 ** 2, Math.floor(requestedMemoryBytes / pageBytes) * pageBytes);
    const headroomBytes = Math.max(64 * 1024 ** 2, Math.round(memoryHighBytes / Math.sqrt(machineCpu * 16)));
    const memoryMaxBytes = Math.floor(Math.min(machineMemoryBytes, memoryHighBytes + headroomBytes) / pageBytes) * pageBytes;
    const cpuWeight = Math.max(1, Math.min(10_000, Math.round(10_000 * cpuUnits / machineCpu)));
    const pidsMax = Math.max(64, Math.min(8192,
        Math.ceil(Math.max(cpuUnits * 128, memoryGiB * 64))));
    return {
        cpuUnits,
        memoryGiB,
        memoryPageBytes: pageBytes,
        cpuWeight,
        cpuMax: `${quotaUs} ${periodUs}`,
        cpuMaxPolicy: 'hard-grant-ceiling',
        memoryHighBytes,
        memoryMaxBytes,
        memoryHeadroomBytes: memoryMaxBytes - memoryHighBytes,
        pidsMax,
        cpuset: null,
        cpusetStatus: 'disabled-topology-and-numa-not-proven'
    };
}

function containerReservationLimits(value)
{
    const keys = ['cpuUnits', 'memoryHighBytes', 'memoryMaxBytes', 'pidsMax'];
    if (!value || !isDeepStrictEqual(Object.keys(value).sort(), keys.sort())
        || typeof value.cpuUnits !== 'number' || value.cpuUnits <= 0 || !Number.isSafeInteger(value.cpuUnits * 1e9)
        || keys.slice(1).some((key) => !Number.isSafeInteger(value[key]) || value[key] <= 0)
        || value.memoryHighBytes > value.memoryMaxBytes)
    {
        throw new Error('container reservation requires exact positive CPU/memory/pids limits');
    }
    return { ...value };
}

/** Partition one scheduler grant between the process slice and external containers. */
export function partitionContainerResourceGrant(grant, reservations, machine)
{
    if (!Array.isArray(reservations))
    {
        throw new Error('container reservations must be an explicit list');
    }
    const total = resolveCgroupLimits(grant, machine);
    const reserved = { cpuUnits: 0, memoryHighBytes: 0, memoryMaxBytes: 0, pidsMax: 0 };
    let nanoCpus = 0;
    for (const reservation of reservations)
    {
        const limits = containerReservationLimits(reservation);
        if (limits.memoryHighBytes % total.memoryPageBytes !== 0 || limits.memoryMaxBytes % total.memoryPageBytes !== 0)
        {
            throw new Error('container memory reservations must match the cgroup page granularity');
        }
        nanoCpus += limits.cpuUnits * 1e9;
        for (const key of ['memoryHighBytes', 'memoryMaxBytes', 'pidsMax'])
        {
            reserved[key] += limits[key];
            if (!Number.isSafeInteger(reserved[key]))
            {
                throw new Error('container reservation sum is not exactly representable');
            }
        }
    }
    if (!Number.isSafeInteger(nanoCpus))
    {
        throw new Error('container CPU reservation sum is not exactly representable');
    }
    reserved.cpuUnits = nanoCpus / 1e9;
    if (reservations.length === 0)
    {
        return { total, process: { ...total }, reserved };
    }
    const cpuUnits = total.cpuUnits - reserved.cpuUnits;
    const memoryHighBytes = total.memoryHighBytes - reserved.memoryHighBytes;
    const memoryMaxBytes = total.memoryMaxBytes - reserved.memoryMaxBytes;
    const pidsMax = total.pidsMax - reserved.pidsMax;
    const period = Number(total.cpuMax.split(' ')[1]);
    const quota = Math.floor(cpuUnits * period);
    if (cpuUnits <= 0 || quota < 1000 || memoryHighBytes < 16 * 1024 ** 2
        || memoryMaxBytes < memoryHighBytes || pidsMax < 1)
    {
        throw new Error('container reservations leave no valid process share inside the bundle grant');
    }
    const processLimits = resolveCgroupLimits({ cpuUnits: quota / period, memoryGiB: memoryHighBytes / bytesPerGiB }, machine);
    return { total, reserved, process: {
        ...processLimits, cpuMax: `${quota} ${period}`, memoryHighBytes, memoryMaxBytes,
        memoryHeadroomBytes: memoryMaxBytes - memoryHighBytes, pidsMax
    } };
}

function sampleCgroup(directory)
{
    return {
        path: directory,
        cpuMax: readText(path.join(directory, 'cpu.max')),
        cpuWeight: readText(path.join(directory, 'cpu.weight')),
        cpuStat: parseKeyValues(readText(path.join(directory, 'cpu.stat'))),
        cpuPressure: readText(path.join(directory, 'cpu.pressure')),
        memoryHigh: readText(path.join(directory, 'memory.high')),
        memoryMax: readText(path.join(directory, 'memory.max')),
        memoryCurrent: numericOrNull(readText(path.join(directory, 'memory.current'))),
        memoryEvents: parseKeyValues(readText(path.join(directory, 'memory.events'))),
        memoryPressure: readText(path.join(directory, 'memory.pressure')),
        pidsCurrent: numericOrNull(readText(path.join(directory, 'pids.current'))),
        pidsMax: readText(path.join(directory, 'pids.max')),
        pidsEvents: parseKeyValues(readText(path.join(directory, 'pids.events'))),
        processIds: String(readText(path.join(directory, 'cgroup.procs')) ?? '').split(/\s+/u).filter(Boolean).map(Number),
        sampledAt: new Date().toISOString()
    };
}

function grantConsistency(limits, sample)
{
    const expected = {
        cpuMax: limits.cpuMax,
        cpuWeight: String(limits.cpuWeight),
        memoryHigh: String(limits.memoryHighBytes),
        memoryMax: String(limits.memoryMaxBytes),
        pidsMax: String(limits.pidsMax)
    };
    const effective = Object.fromEntries(Object.keys(expected).map((key) => [key, sample[key]]));
    return {
        status: Object.keys(expected).every((key) => effective[key] === expected[key]) ? 'consistent' : 'mismatch',
        declaredGrant: { cpuUnits: limits.cpuUnits, memoryGiB: limits.memoryGiB },
        expected,
        effective
    };
}

export function cleanupStaleProductionCgroups(campaignRoot, { currentRunId = null, removeDirectory } = {})
{
    const result = { removed: [], retainedActive: [], errors: [] };
    if (!fs.existsSync(campaignRoot))
    {
        return result;
    }
    const remove = removeDirectory ?? ((directory) => fs.rmdirSync(directory));
    for (const entry of fs.readdirSync(campaignRoot, { withFileTypes: true }))
    {
        if (!entry.isDirectory() || entry.name === currentRunId)
        {
            continue;
        }
        const runDirectory = path.join(campaignRoot, entry.name);
        const bundles = fs.readdirSync(runDirectory, { withFileTypes: true })
            .filter((candidate) => candidate.isDirectory())
            .map((candidate) => path.join(runDirectory, candidate.name));
        if (bundles.some((directory) => String(readText(path.join(directory, 'cgroup.procs')) ?? '').trim() !== ''))
        {
            result.retainedActive.push(entry.name);
            continue;
        }
        try
        {
            for (const directory of bundles)
            {
                remove(directory);
            }
            remove(runDirectory);
            result.removed.push(entry.name);
        }
        catch (error)
        {
            result.errors.push({ runId: entry.name, error: `${error.code ?? 'error'}:${error.message}` });
        }
    }
    return result;
}

function cleanupStaleManagerCgroups(delegateRoot, removeDirectory)
{
    const removed = [];
    const retainedActive = [];
    const remove = removeDirectory ?? ((value) => fs.rmdirSync(value));
    for (const entry of fs.readdirSync(delegateRoot, { withFileTypes: true }))
    {
        if (!entry.isDirectory() || !entry.name.startsWith('.fsusblog-manager-'))
        {
            continue;
        }
        const directory = path.join(delegateRoot, entry.name);
        if (String(readText(path.join(directory, 'cgroup.procs')) ?? '').trim() !== '')
        {
            retainedActive.push(entry.name);
            continue;
        }
        try
        {
            remove(directory);
            removed.push(entry.name);
        }
        catch
        {
            // Empty stale manager cleanup is best-effort; active leaves are retained above.
        }
    }
    return { removed, retainedActive };
}

export async function createProductionResourceEnforcer(options)
{
    const requestedMode = String(options.mode ?? process.env.FSUSBLOG_CGROUP_ENFORCEMENT ?? 'auto').toLowerCase();
    if (!['auto', 'strict', 'advisory', 'off'].includes(requestedMode))
    {
        throw new Error(`invalid cgroup enforcement mode: ${requestedMode}`);
    }
    const strict = requestedMode === 'strict' || options.strict === true;
    const runId = safeSegment(options.runId, 'runId');
    const bundleIds = [...new Set(options.bundleIds ?? [])].map((value) => safeSegment(value, 'bundleId'));
    let capabilities = resolveProductionCgroupCapabilities(options);
    const systemdOwners = new Map();
    let systemdTransport = null;
    let systemdContext = null;
    const systemdRequested = Boolean(options.systemdBoundary) && !['off', 'advisory'].includes(requestedMode)
        && (options.platform ?? process.platform) === 'linux';
    if (systemdRequested)
    {
        if (options.delegateRoot || process.env.FSUSBLOG_CGROUP_DELEGATE_ROOT)
        {
            throw new Error('systemd resource enforcement cannot substitute for an explicitly selected filesystem delegate root');
        }
        const binding = options.systemdBoundary;
        if (typeof binding.retainBinding !== 'function'
            || !Number.isSafeInteger(binding.commandBudgetMs) || binding.commandBudgetMs <= 0
            || !Number.isSafeInteger(binding.startupBudgetMs) || binding.startupBudgetMs <= 0
            || !binding.context || binding.context.runId !== runId
            || Object.keys(binding.context).sort().join(',') !== 'namespace,root,runId,schedulerOwnerToken,sourceState')
        {
            throw new Error('systemd resource enforcement requires independent retention, exact context and explicit command/startup budgets');
        }
        systemdContext = structuredClone(binding.context);
        try
        {
            systemdTransport = options.systemdTransport ?? createSystemdResourceTransport({ commandBudgetMs: binding.commandBudgetMs });
            const runtime = systemdTransport.runtimeIdentity();
            capabilities = { status: 'available', reason: null, cgroupVersion: 2,
                backend: 'systemd-user-manager', delegateRoot: runtime.cgroup.path, controllers: [...controllers],
                memoryPageBytes: runtime.memoryPageBytes };
        }
        catch (error)
        {
            // Only an unavailable local capability can become advisory. Identity/protocol failures remain errors.
            if (!['ENOENT', 'EACCES', 'ENOTSUP'].includes(error.code))
            {
                throw error;
            }
            capabilities = { status: 'unavailable', reason: `systemd-capability-unavailable:${error.code}`,
                cgroupVersion: null, backend: 'systemd-user-manager', delegateRoot: null, controllers: [] };
        }
    }
    let machine = Object.freeze({ ...options.machine, memoryPageBytes: 1 });
    const evidence = {
        schema: resourceEnforcementSchema,
        requestedMode,
        mode: 'advisory',
        status: capabilities.status,
        reason: capabilities.reason,
        runId,
        machine,
        capabilities,
        cpuPolicy: 'cpu.weight plus cpu.max hard grant ceiling; quota is isolation, never a speed optimization',
        memoryPolicy: 'memory.high projects the grant downward to kernel pages; memory.max adds page-aligned machine-derived safety headroom',
        cpusetPolicy: 'disabled unless topology, NUMA, and dynamic redistribution are proven',
        bundles: {},
        cleanup: null,
        generatedAt: new Date().toISOString()
    };
    let runRoot = null;
    if (systemdRequested && capabilities.status === 'available')
    {
        const binding = options.systemdBoundary;
        const observedPageBytes = capabilities.memoryPageBytes;
        if (options.machine?.memoryPageBytes !== undefined && options.machine.memoryPageBytes !== observedPageBytes)
        {
            throw new Error('resource enforcer machine page size differs from the observed host');
        }
        machine = Object.freeze({ ...options.machine, memoryPageBytes: observedPageBytes });
        evidence.machine = machine;
        try
        {
            for (const bundleId of bundleIds)
            {
                const owner = await prepareProductionSystemdResourceBoundary({ ...systemdContext, bundleId }, {
                    retainBinding: binding.retainBinding,
                    commandBudgetMs: binding.commandBudgetMs,
                    startupBudgetMs: binding.startupBudgetMs,
                    transport: systemdTransport,
                    ...(options.systemdControllerIdentity ? { controllerIdentity: options.systemdControllerIdentity } : {}),
                    ...(options.observeSystemdController ? { observeController: options.observeSystemdController } : {})
                });
                systemdOwners.set(bundleId, owner);
                const state = owner.evidence();
                evidence.bundles[bundleId] = { path: state.state.unitIdentity.path, grants: [], samples: [], attachedPid: null,
                    resourceReference: owner.reference, resourceUnitName: state.owner.unitName };
            }
            evidence.mode = 'enforced';
            evidence.status = 'active';
            evidence.reason = null;
        }
        catch (error)
        {
            const reconciled = [];
            for (const [bundleId, owner] of [...systemdOwners].reverse())
            {
                try
                {
                    reconciled.push({ bundleId, ...owner.cleanup() });
                }
                catch (cleanupError)
                {
                    reconciled.push({ bundleId, status: 'recovery-required', reference: owner.reference, reason: cleanupError.message });
                }
            }
            error.enforcerSetupCleanup = { priorFailure: error.resourceCleanup ?? null, boundaries: reconciled };
            throw error;
        }
    }
    else if (!systemdRequested && !['off', 'advisory'].includes(requestedMode) && capabilities.status === 'available')
    {
        const createdDirectories = [];
        let managerRoot = null;
        try
        {
            const observedPageBytes = memoryPageBytes({});
            if (options.machine?.memoryPageBytes !== undefined && options.machine.memoryPageBytes !== observedPageBytes)
            {
                throw new Error('resource enforcer machine page size differs from the observed host');
            }
            machine = Object.freeze({ ...options.machine, memoryPageBytes: observedPageBytes });
            evidence.machine = machine;
            evidence.managerCleanup = cleanupStaleManagerCgroups(capabilities.delegateRoot, options.removeDirectory);
            try
            {
                enableControllers(capabilities.delegateRoot);
            }
            catch (error)
            {
                const parentPids = String(readText(path.join(capabilities.delegateRoot, 'cgroup.procs')) ?? '')
                    .split(/\s+/u).filter(Boolean).map(Number);
                if (error.code !== 'EBUSY' || parentPids.some((pid) => pid !== process.pid))
                {
                    throw error;
                }
                managerRoot = path.join(capabilities.delegateRoot, `.fsusblog-manager-${runId}`);
                fs.mkdirSync(managerRoot);
                options.prepareDirectory?.(managerRoot);
                writeControl(path.join(managerRoot, 'cgroup.procs'), process.pid);
                evidence.managerCgroup = {
                    path: managerRoot,
                    pid: process.pid,
                    status: 'runner-moved-to-leaf-until-process-exit'
                };
                enableControllers(capabilities.delegateRoot);
            }
            const campaignRoot = path.join(capabilities.delegateRoot, 'fsusblog-production');
            const campaignExisted = fs.existsSync(campaignRoot);
            fs.mkdirSync(campaignRoot, { recursive: true });
            if (!campaignExisted)
            {
                createdDirectories.push(campaignRoot);
            }
            options.prepareDirectory?.(campaignRoot);
            enableControllers(campaignRoot);
            evidence.staleCleanup = cleanupStaleProductionCgroups(campaignRoot, {
                currentRunId: runId,
                removeDirectory: options.removeDirectory
            });
            runRoot = path.join(campaignRoot, runId);
            fs.mkdirSync(runRoot);
            createdDirectories.push(runRoot);
            options.prepareDirectory?.(runRoot);
            enableControllers(runRoot);
            for (const bundleId of bundleIds)
            {
                const directory = path.join(runRoot, bundleId);
                fs.mkdirSync(directory);
                createdDirectories.push(directory);
                options.prepareDirectory?.(directory);
                evidence.bundles[bundleId] = { path: directory, grants: [], samples: [], attachedPid: null };
            }
            evidence.mode = 'enforced';
            evidence.status = 'active';
            evidence.reason = null;
        }
        catch (error)
        {
            evidence.status = 'unavailable';
            evidence.reason = `delegation-setup-failed:${error.code ?? error.message}`;
            const removeDirectory = options.removeDirectory ?? ((directory) => fs.rmdirSync(directory));
            const cleanupErrors = [];
            for (const directory of createdDirectories.reverse())
            {
                try
                {
                    removeDirectory(directory);
                }
                catch (cleanupError)
                {
                    if (!['ENOENT', 'ENOTEMPTY', 'EBUSY'].includes(cleanupError.code))
                    {
                        cleanupErrors.push(`${cleanupError.code ?? 'error'}:${directory}`);
                    }
                }
            }
            if (managerRoot)
            {
                try
                {
                    writeControl(path.join(capabilities.delegateRoot, 'cgroup.procs'), process.pid);
                    const removeDirectory = options.removeDirectory ?? ((directory) => fs.rmdirSync(directory));
                    removeDirectory(managerRoot);
                }
                catch (managerError)
                {
                    cleanupErrors.push(`${managerError.code ?? 'error'}:${managerRoot}`);
                }
            }
            evidence.setupCleanup = { attempted: createdDirectories.length, errors: cleanupErrors };
            runRoot = null;
        }
    }
    else if (requestedMode === 'off')
    {
        evidence.status = 'disabled';
        evidence.reason = 'explicitly-disabled';
    }
    else if (requestedMode === 'advisory')
    {
        evidence.status = 'advisory';
        evidence.reason = 'explicit-advisory-mode';
    }
    if (strict && evidence.mode !== 'enforced')
    {
        throw new Error(`strict cgroup enforcement unavailable: ${evidence.reason ?? evidence.status}`);
    }

    const mode = evidence.mode;
    const ownedPaths = new Map(Object.entries(evidence.bundles).map(([id, bundle]) => [id, bundle.path]));
    const admittedGrants = new Map();
    const totalGrants = new Map();
    const containerReservations = new Map();
    const managedServices = new Map();
    const usedReservationIds = new Set();
    let closed = false;
    let closing = false;
    const requireBundle = (bundleIdValue) =>
    {
        const bundleId = safeSegment(bundleIdValue, 'bundleId');
        if (closed)
        {
            throw new Error('resource enforcement owner is closed');
        }
        if (closing)
        {
            throw new Error('resource enforcement owner is finalizing retained resources');
        }
        if (mode === 'enforced' && (!ownedPaths.has(bundleId)
            || evidence.bundles[bundleId]?.path !== ownedPaths.get(bundleId)))
        {
            throw new Error('resource enforcement requires an unchanged owned bundle path');
        }
        const bundle = evidence.bundles[bundleId] ??= { path: null, grants: [], samples: [], attachedPid: null };
        return { bundleId, bundle };
    };
    const verifyGrant = (bundleId, bundle, limits) =>
    {
        bundle.effectiveLimits = null;
        bundle.consistency = { status: 'unverified' };
        try
        {
            if (systemdOwners.has(bundleId))
            {
                systemdOwners.get(bundleId).assertAdmitted();
            }
            bundle.effectiveLimits = sampleCgroup(ownedPaths.get(bundleId));
            bundle.consistency = grantConsistency(limits, bundle.effectiveLimits);
            if (bundle.consistency.status !== 'consistent')
            {
                throw new Error('effective process controls differ from the declared resource grant');
            }
        }
        catch (error)
        {
            admittedGrants.delete(bundleId);
            throw error;
        }
    };
    const applyGrant = (bundleIdValue, grant, reservations) =>
    {
        const { bundleId, bundle } = requireBundle(bundleIdValue);
        const allocation = partitionContainerResourceGrant(grant, reservations.map((entry) => entry.limits), machine);
        const limits = allocation.process;
        admittedGrants.delete(bundleId);
        bundle.consistency = { status: 'unverified' };
        if (mode === 'enforced')
        {
            const [quotaUs, periodUs] = limits.cpuMax.split(' ').map(Number);
            if (quotaUs / periodUs > limits.cpuUnits)
            {
                throw new Error('cgroup CPU grant is below the minimum representable process quota');
            }
            if (limits.memoryHighBytes > Math.round(limits.memoryGiB * bytesPerGiB))
            {
                throw new Error('cgroup memory grant is below the minimum 16 MiB process envelope');
            }
            if (systemdOwners.has(bundleId))
            {
                systemdOwners.get(bundleId).update(limits);
            }
            else
            {
                writeControl(path.join(bundle.path, 'cpu.weight'), limits.cpuWeight);
                writeControl(path.join(bundle.path, 'cpu.max'), limits.cpuMax);
                const currentMemoryMax = Number(readText(path.join(bundle.path, 'memory.max')));
                if (Number.isFinite(currentMemoryMax) && currentMemoryMax < limits.memoryMaxBytes)
                {
                    writeControl(path.join(bundle.path, 'memory.max'), limits.memoryMaxBytes);
                    writeControl(path.join(bundle.path, 'memory.high'), limits.memoryHighBytes);
                }
                else
                {
                    writeControl(path.join(bundle.path, 'memory.high'), limits.memoryHighBytes);
                    writeControl(path.join(bundle.path, 'memory.max'), limits.memoryMaxBytes);
                }
                writeControl(path.join(bundle.path, 'pids.max'), limits.pidsMax);
            }
            verifyGrant(bundleId, bundle, limits);
        }
        else
        {
            bundle.effectiveLimits = null;
            bundle.consistency = { status: 'advisory', declaredGrant: { cpuUnits: limits.cpuUnits, memoryGiB: limits.memoryGiB } };
        }
        admittedGrants.set(bundleId, Object.freeze({ ...limits }));
        const previous = bundle.grants.at(-1);
        if (!previous || previous.cpuMax !== limits.cpuMax
            || previous.cpuWeight !== limits.cpuWeight
            || previous.memoryHighBytes !== limits.memoryHighBytes
            || previous.memoryMaxBytes !== limits.memoryMaxBytes
            || previous.pidsMax !== limits.pidsMax
            || !isDeepStrictEqual(previous.containerReservations ?? [], reservations))
        {
            bundle.grants.push({ ...limits, totalGrant: { ...allocation.total },
                containerReservations: structuredClone(reservations), effectiveAt: new Date().toISOString() });
        }
        bundle.allocation = { total: { ...allocation.total }, process: { ...limits },
            reserved: { ...allocation.reserved }, containerReservations: structuredClone(reservations) };
        return { ...limits, mode, cgroupPath: bundle.path, totalGrant: { ...allocation.total },
            containerReservations: structuredClone(reservations) };
    };
    const update = (bundleIdValue, grant) =>
    {
        const bundleId = safeSegment(bundleIdValue, 'bundleId');
        const reservations = [...(containerReservations.get(bundleId)?.values() ?? [])];
        const result = applyGrant(bundleId, grant, reservations);
        totalGrants.set(bundleId, { cpuUnits: Number(grant.cpuUnits), memoryGiB: Number(grant.memoryGiB) });
        return result;
    };
    const observeReservationProcess = options.observeContainerReservationProcess ?? collectProcessIdentity;
    const readReservationProcessCgroup = options.readContainerReservationProcessCgroup
        ?? ((pid) => fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'));
    const observeReservationService = options.inspectContainerReservationService
        ?? ((binding) => inspectProductionSystemdServiceBinding(binding, {
            commandBudgetMs: options.systemdBoundary.commandBudgetMs, transport: systemdTransport
        }));
    const requireReservationProcess = (identity, expectedCgroup) =>
    {
        const observed = observeReservationProcess(identity?.pid);
        const cgroup = readReservationProcessCgroup(identity?.pid);
        const unified = String(cgroup).trim().split(/\r?\n/u).filter((line) => line.startsWith('0::'));
        if (observed?.status !== 'verified' || observed.pid !== identity?.pid
            || observed.processStartIdentity !== identity.processStartIdentity
            || unified.length !== 1 || unified[0].slice(3) !== expectedCgroup)
        {
            throw new Error('container reservation requires its live attached systemd process');
        }
    };
    const reserveContainerResources = (bundleIdValue, request) =>
    {
        const bundleId = safeSegment(bundleIdValue, 'bundleId');
        if (mode !== 'enforced' || !systemdOwners.has(bundleId) || !totalGrants.has(bundleId)
            || closed || closing || !admittedGrants.has(bundleId))
        {
            throw new Error('container reservation requires a live systemd-enforced admitted bundle grant');
        }
        if (!request || !isDeepStrictEqual(Object.keys(request).sort(), ['id', 'identity', 'limits']))
        {
            throw new Error('container reservation requires an exact request');
        }
        const id = safeSegment(request.id, 'reservationId');
        const identity = structuredClone(request.identity);
        const identityKeys = ['root', 'runId', 'namespace', 'bundleId', 'stepId', 'sourceState'];
        if (!identity || !isDeepStrictEqual(Object.keys(identity).sort(), identityKeys.sort())
            || identity.root !== systemdContext.root || identity.runId !== runId
            || identity.namespace !== systemdContext.namespace
            || !isDeepStrictEqual(identity.sourceState, systemdContext.sourceState)
            || ![bundleId, `matrix:${bundleId}`].includes(identity.bundleId)
            || typeof identity.stepId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(identity.stepId))
        {
            throw new Error('container reservation identity must bind the systemd owner and exact producer/source');
        }
        const limits = containerReservationLimits(request.limits);
        const key = `${bundleId}/${id}`;
        if (usedReservationIds.has(key))
        {
            throw new Error('container reservation identity cannot be reused');
        }
        const reservations = containerReservations.get(bundleId) ?? new Map();
        const reservation = { id, identity, limits };
        applyGrant(bundleId, totalGrants.get(bundleId), [...reservations.values(), reservation]);
        reservations.set(id, reservation);
        containerReservations.set(bundleId, reservations);
        usedReservationIds.add(key);
        let releasing = false;
        const assertHeld = (context) =>
        {
            if (closed || closing || reservations.get(id) !== reservation || !admittedGrants.has(bundleId)
                || identityKeys.some((field) => !isDeepStrictEqual(context?.[field], identity[field]))
                || !isDeepStrictEqual(context?.resourceGrant, limits))
            {
                throw new Error('container resource reservation is absent or crosses its exact owner');
            }
            const bundle = evidence.bundles[bundleId];
            const launcher = bundle.launcherAdmission;
            const managed = managedServices.get(bundleId);
            if (Boolean(launcher) === Boolean(managed))
            {
                throw new Error('container reservation requires one live attached systemd process owner');
            }
            if (managed)
            {
                const service = observeReservationService(managed.serviceBinding);
                if (service?.status !== 'present' || service.unit?.ActiveState !== 'active'
                    || !service.group?.processIds?.includes(managed.processIdentity.pid)
                    || !isDeepStrictEqual(service.identity, managed.serviceBinding.identity))
                {
                    throw new Error('container reservation managed service identity or membership changed');
                }
                requireReservationProcess(managed.processIdentity, service.identity.controlGroup);
            }
            else
            {
                if (bundle.attachStatus !== 'attached' || launcher.processIdentity?.pid !== bundle.attachedPid)
                {
                    throw new Error('container reservation requires its live attached systemd launcher process');
                }
                requireReservationProcess(launcher.processIdentity, launcher.launcher.controlGroup);
            }
            const allocation = partitionContainerResourceGrant(totalGrants.get(bundleId),
                [...reservations.values()].map((entry) => entry.limits), machine);
            if (!isDeepStrictEqual(admittedGrants.get(bundleId), allocation.process))
            {
                throw new Error('container reservation process grant changed outside its owner');
            }
            verifyGrant(bundleId, bundle, allocation.process);
            if (managed)
            {
                requireReservationProcess(managed.processIdentity, managed.serviceBinding.identity.controlGroup);
            }
            else
            {
                requireReservationProcess(launcher.processIdentity, launcher.launcher.controlGroup);
            }
            return { runId, bundleId, reservation: structuredClone(reservation),
                process: { ...allocation.process }, total: { ...allocation.total } };
        };
        return Object.freeze({
            assertHeld,
            snapshot: () => ({ runId, bundleId, ...structuredClone(reservation), held: reservations.get(id) === reservation }),
            async releaseAfterCleanup(cleanup)
            {
                if (closed || closing || reservations.get(id) !== reservation || releasing || typeof cleanup !== 'function')
                {
                    throw new Error('container resource release requires one active owner and its exact cleanup');
                }
                releasing = true;
                try
                {
                    const result = await cleanup();
                    if (!isDeepStrictEqual(result, { containerAbsent: true, credentialsRemoved: true }))
                    {
                        throw new Error('container resource release lacks complete lifecycle cleanup');
                    }
                    applyGrant(bundleId, totalGrants.get(bundleId), [...reservations.values()].filter((entry) => entry !== reservation));
                    reservations.delete(id);
                    return result;
                }
                finally
                {
                    releasing = false;
                }
            }
        });
    };
    const bindManagedService = (bundleIdValue, identityValue, authorityValue) =>
    {
        const bundleId = safeSegment(bundleIdValue, 'bundleId');
        if (mode !== 'enforced' || !systemdOwners.has(bundleId) || closed || closing
            || !admittedGrants.has(bundleId) || !(containerReservations.get(bundleId)?.size > 0)
            || managedServices.has(bundleId))
        {
            throw new Error('container reservation service binding requires one live reserved systemd owner');
        }
        const identity = structuredClone(identityValue);
        const authority = structuredClone(authorityValue);
        const binding = authority?.serviceBinding;
        if (authority?.phase !== 'pre-exec' || identity?.status !== 'verified'
            || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
            || !isDeepStrictEqual(authority.supervisorProcessIdentity, identity)
            || !isDeepStrictEqual(binding?.reference, systemdOwners.get(bundleId).reference)
            || !isDeepStrictEqual(binding?.reference?.context, { ...systemdContext, bundleId })
            || !binding?.identity || typeof binding.identity.controlGroup !== 'string')
        {
            throw new Error('container reservation service binding crosses its retained process or resource owner');
        }
        const service = observeReservationService(binding);
        if (service?.status !== 'present' || service.unit?.ActiveState !== 'active'
            || !service.group?.processIds?.includes(identity.pid)
            || !isDeepStrictEqual(service.identity, binding.identity))
        {
            throw new Error('container reservation service binding lacks its exact live service');
        }
        requireReservationProcess(identity, service.identity.controlGroup);
        const managed = { processIdentity: identity, serviceBinding: binding };
        managedServices.set(bundleId, managed);
        evidence.bundles[bundleId].managedServiceAdmission = {
            authorityId: authority.authorityId, pid: identity.pid,
            processStartIdentity: identity.processStartIdentity, serviceBinding: structuredClone(binding)
        };
        return structuredClone(evidence.bundles[bundleId].managedServiceAdmission);
    };
    const attach = async (bundleIdValue, pid, identity = null) =>
    {
        const { bundleId, bundle } = requireBundle(bundleIdValue);
        if (!Number.isInteger(Number(pid)) || Number(pid) <= 0)
        {
            throw new Error('cgroup attach requires a positive PID');
        }
        if (mode === 'enforced')
        {
            const limits = admittedGrants.get(bundleId);
            if (!limits)
            {
                throw new Error('cgroup attach requires a verified current resource grant');
            }
            verifyGrant(bundleId, bundle, limits);
            if (systemdOwners.has(bundleId))
            {
                if (identity?.pid !== Number(pid))
                {
                    throw new Error('systemd resource attachment requires the exact registered launcher identity');
                }
                bundle.launcherAdmission = await systemdOwners.get(bundleId).attachLauncher(identity, {
                    startupBudgetMs: options.systemdBoundary.startupBudgetMs
                });
            }
            else
            {
                writeControl(path.join(bundle.path, 'cgroup.procs'), Number(pid));
                const members = String(readText(path.join(bundle.path, 'cgroup.procs')) ?? '').split(/\s+/u).map(Number);
                if (!members.includes(Number(pid)))
                {
                    throw new Error('cgroup attach membership read-back does not contain the admitted PID');
                }
            }
            verifyGrant(bundleId, bundle, limits);
        }
        bundle.attachedPid = Number(pid);
        bundle.attachStatus = mode === 'enforced' ? 'attached' : 'advisory';
        return bundle.attachStatus;
    };
    const sample = () =>
    {
        for (const [bundleId, directory] of ownedPaths)
        {
            const bundle = evidence.bundles[bundleId];
            if (mode === 'enforced' && directory)
            {
                if (bundle.samples.length >= 4096)
                {
                    bundle.samples = bundle.samples.filter((_, index) => index % 2 === 0);
                }
                bundle.samples.push(sampleCgroup(directory));
            }
        }
        return evidence;
    };
    const cleanup = () =>
    {
        if (closed)
        {
            return evidence.cleanup;
        }
        const held = [...containerReservations.entries()].flatMap(([bundleId, reservations]) =>
            [...reservations.values()].map((entry) => ({ bundleId, reservationId: entry.id })));
        if (held.length)
        {
            evidence.cleanup = { status: 'retained-container-reservations', reservations: held, completedAt: new Date().toISOString() };
            return evidence.cleanup;
        }
        closing = true;
        admittedGrants.clear();
        sample();
        if (systemdOwners.size > 0)
        {
            const boundaries = [];
            for (const [bundleId, owner] of systemdOwners)
            {
                try
                {
                    boundaries.push({ bundleId, ...owner.cleanup() });
                }
                catch (error)
                {
                    boundaries.push({ bundleId, status: 'recovery-required', reference: owner.reference, reason: error.message });
                }
            }
            const removed = boundaries.every((entry) => entry.status === 'removed');
            evidence.cleanup = { status: removed ? 'removed' : 'retained-resources', boundaries, completedAt: new Date().toISOString() };
            if (removed)
            {
                admittedGrants.clear();
                closed = true;
            }
            return evidence.cleanup;
        }
        if (mode !== 'enforced' || !runRoot)
        {
            evidence.cleanup = { status: 'not-applicable', completedAt: new Date().toISOString() };
            return evidence.cleanup;
        }
        const busy = [...ownedPaths].filter(([, directory]) =>
            String(readText(path.join(directory, 'cgroup.procs')) ?? '').trim() !== '');
        if (busy.length)
        {
            evidence.cleanup = { status: 'retained-active', bundles: busy.map(([bundleId]) => bundleId), completedAt: new Date().toISOString() };
            return evidence.cleanup;
        }
        try
        {
            const removeDirectory = options.removeDirectory ?? ((directory) => fs.rmdirSync(directory));
            for (const directory of ownedPaths.values())
            {
                removeDirectory(directory);
            }
            removeDirectory(runRoot);
            const campaignRoot = path.dirname(runRoot);
            try
            {
                removeDirectory(campaignRoot);
            }
            catch (error)
            {
                if (!['ENOTEMPTY', 'EBUSY'].includes(error.code))
                {
                    throw error;
                }
            }
            evidence.cleanup = { status: 'removed', completedAt: new Date().toISOString() };
            admittedGrants.clear();
            closed = true;
        }
        catch (error)
        {
            evidence.cleanup = { status: 'failed', error: `${error.code ?? 'error'}:${error.message}`, completedAt: new Date().toISOString() };
        }
        return evidence.cleanup;
    };
    return {
        mode,
        capabilities,
        update,
        reserveContainerResources,
        bindManagedService,
        attach,
        sample,
        cleanup,
        executionBoundary(bundleIdValue)
        {
            const { bundleId, bundle } = requireBundle(bundleIdValue);
            const owner = systemdOwners.get(bundleId);
            if (!owner)
            {
                return null;
            }
            const limits = admittedGrants.get(bundleId);
            if (!limits)
            {
                throw new Error('systemd execution boundary requires a verified current resource grant');
            }
            verifyGrant(bundleId, bundle, limits);
            return owner.executionBoundary(() =>
            {
                requireBundle(bundleId);
                const current = admittedGrants.get(bundleId);
                if (!current)
                {
                    throw new Error('systemd execution boundary lost its verified current resource grant');
                }
                verifyGrant(bundleId, bundle, current);
            });
        },
        environment(bundleId)
        {
            return {
                FSUSBLOG_CGROUP_ENFORCEMENT_MODE: mode,
                FSUSBLOG_CGROUP_BUNDLE_PATH: mode === 'enforced' ? (ownedPaths.get(safeSegment(bundleId, 'bundleId')) ?? '') : '',
                FSUSBLOG_CGROUP_ENFORCEMENT_REASON: evidence.reason ?? ''
            };
        },
        evidence: () => evidence
    };
}

export function dockerResourceArguments(environment = process.env)
{
    const rawLimits = [
        environment.FSUSBLOG_DOCKER_CPU_UNITS,
        environment.FSUSBLOG_DOCKER_MEMORY_MAX_BYTES,
        environment.FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES,
        environment.FSUSBLOG_DOCKER_PIDS_MAX
    ];
    if (rawLimits.every((value) => String(value ?? '').trim() === ''))
    {
        return [];
    }
    if (rawLimits.some((value) => String(value ?? '').trim() === ''))
    {
        throw new Error('Docker resource enforcement requires a complete CPU, memory high/max, and pids grant');
    }
    const [cpuUnits, memoryBytes, memoryHighBytes, pidsMax] = rawLimits.map(Number);
    if (!Number.isFinite(cpuUnits) || cpuUnits <= 0
    || !Number.isInteger(memoryBytes) || memoryBytes <= 0
    || !Number.isInteger(memoryHighBytes) || memoryHighBytes <= 0 || memoryHighBytes > memoryBytes
    || !Number.isInteger(pidsMax) || pidsMax <= 0)
    {
        throw new Error('Docker resource enforcement grant is invalid');
    }
    const identities = [
        environment.FSUSBLOG_TEST_RUN_ID,
        environment.FSUSBLOG_PHYSICAL_BUNDLE_ID,
        environment.FSUSBLOG_STEP_ID
    ];
    if (identities.some((value) => String(value ?? '').trim() === ''))
    {
        throw new Error('Docker resource enforcement requires run, bundle, and step identity');
    }
    const labels = [
        ['io.fsusblog.test.run-id', environment.FSUSBLOG_TEST_RUN_ID],
        ['io.fsusblog.test.bundle-id', environment.FSUSBLOG_PHYSICAL_BUNDLE_ID],
        ['io.fsusblog.test.step-id', environment.FSUSBLOG_STEP_ID],
        ['io.fsusblog.test.cpu-units', cpuUnits],
        ['io.fsusblog.test.memory-high-bytes', memoryHighBytes],
        ['io.fsusblog.test.memory-max-bytes', memoryBytes],
        ['io.fsusblog.test.pids-max', pidsMax]
    ].filter(([, value]) => String(value ?? '').trim() !== '');
    return [
        '--cpus', String(cpuUnits),
        '--memory-reservation', String(Math.round(memoryHighBytes)),
        '--memory', String(Math.round(memoryBytes)),
        '--pids-limit', String(Math.round(pidsMax)),
        ...labels.flatMap(([key, value]) => ['--label', `${key}=${value}`])
    ];
}
