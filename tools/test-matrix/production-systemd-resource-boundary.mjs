import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const { canonicalJson, digestCanonical, freezeDeep, sha256Bytes } = await import(new URL('../test-fixtures/receipt/canonical.mjs', import.meta.url));
const { readPrivateFile } = await import(new URL('../test-fixtures/receipt/private-io.mjs', import.meta.url));
const { currentProcessIdentity, processIdentitySchema, processIdentityStatus } = await import(new URL('../test/process-identity.mjs', import.meta.url));

export const systemdResourceBoundarySchema = 'fsusblog.production-systemd-resource-boundary.v1';
export const systemdServiceBindingSchema = 'fsusblog.production-systemd-service-binding.v1';
const unitPattern = /^fsusblogresource[a-f0-9]{32}\.slice$/u;
const launcherPattern = /^fsusblogresourcelauncher[a-f0-9]{32}\.scope$/u;
const servicePattern = /^fsusblog-physical-[a-f0-9]{32}\.service$/u;
const executionBoundaries = new WeakMap();
const managerDestination = ['org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager'];
const properties = ['LoadState', 'ActiveState', 'SubState', 'ControlGroup', 'Description', 'Transient', 'FragmentPath', 'DropInPaths', 'InvocationID'];
const resourceDropIns = ['CPUQuota', 'CPUQuotaPeriodSec', 'CPUWeight', 'MemoryHigh', 'MemoryMax', 'TasksMax'];

function launcherUnitName(unitName)
{
    return unitName.replace('fsusblogresource', 'fsusblogresourcelauncher').replace('.slice', '.scope');
}

function exactKeys(value, keys)
{
    return value && typeof value === 'object' && !Array.isArray(value)
        && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function requireBudget(value, label)
{
    if (!Number.isSafeInteger(value) || value <= 0)
    {
        throw new Error(`${label} requires an explicit positive millisecond budget`);
    }
    return value;
}

function requireContext(context)
{
    if (!exactKeys(context, ['root', 'runId', 'namespace', 'bundleId', 'sourceState', 'schedulerOwnerToken'])
        || typeof context.root !== 'string' || fs.realpathSync(context.root) !== context.root
        || !exactKeys(context.sourceState, ['commit', 'worktreeFingerprint'])
        || !/^[a-f0-9]{40}$/u.test(context.sourceState.commit)
        || !/^[a-f0-9]{64}$/u.test(context.sourceState.worktreeFingerprint)
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(context.schedulerOwnerToken)
        || ['runId', 'namespace', 'bundleId'].some((key) =>
            typeof context[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(context[key])))
    {
        throw new Error('systemd resource boundary requires an exact repository/run/source/namespace/bundle/scheduler-owner context');
    }
    return freezeDeep(structuredClone(context));
}

function syncDirectory(directory)
{
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function requireDirectory(directory)
{
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
        || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
    {
        throw new Error('systemd resource authority requires a private, literal, current-user directory');
    }
    return { device: stat.dev, inode: stat.ino };
}

function recordPaths(context)
{
    const contextDigest = digestCanonical(context).slice(7);
    // This authority must survive fresh scheduler checkpoint-directory resets.
    const authorityRoot = path.join(context.root, '.tmp/production-resource-owners');
    const directory = path.join(authorityRoot, contextDigest);
    return { authorityRoot, directory, owner: path.join(directory, 'owner.json'), state: path.join(directory, 'state.json') };
}

function prepareDirectory(context, paths)
{
    const temporaryRoot = path.join(context.root, '.tmp');
    for (const directory of [temporaryRoot, paths.authorityRoot])
    {
        try
        {
            fs.mkdirSync(directory, { mode: 0o700 });
            syncDirectory(path.dirname(directory));
        }
        catch (error)
        {
            if (error.code !== 'EEXIST')
            {
                throw error;
            }
        }
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory)
        {
            throw new Error('systemd resource authority path cannot traverse a symlink or special file');
        }
    }
    requireDirectory(paths.authorityRoot);
    fs.mkdirSync(paths.directory, { mode: 0o700 });
    syncDirectory(paths.authorityRoot);
    return requireDirectory(paths.directory);
}

function readRecord(file)
{
    const stat = fs.lstatSync(file);
    if (stat.uid !== process.getuid() || stat.nlink !== 1)
    {
        throw new Error('systemd resource authority record must have the current owner and one link');
    }
    const value = readPrivateFile(file, { label: 'systemd resource authority' });
    return { ...value, digest: sha256Bytes(value.bytes), document: JSON.parse(value.bytes.toString('utf8')) };
}

function writeRecord(file, document, expectedDigest = null)
{
    if (expectedDigest !== null && readRecord(file).digest !== expectedDigest)
    {
        throw new Error('systemd resource authority changed before durable write');
    }
    const temporary = `${file}.${randomBytes(16).toString('hex')}.next`;
    const bytes = Buffer.from(`${canonicalJson(document)}\n`);
    const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try
    {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    try
    {
        if (expectedDigest === null)
        {
            fs.linkSync(temporary, file);
        }
        else
        {
            if (readRecord(file).digest !== expectedDigest)
            {
                throw new Error('systemd resource authority changed during durable write');
            }
            fs.renameSync(temporary, file);
        }
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
        syncDirectory(path.dirname(file));
    }
    const written = readRecord(file);
    if (!written.bytes.equals(bytes))
    {
        throw new Error('systemd resource authority write did not preserve exact bytes');
    }
    return written.digest;
}

/** Project an already admitted grant, without allocating another per-unit grant. */
export function systemdResourceProperties(limits)
{
    const match = typeof limits?.cpuMax === 'string' ? /^([1-9]\d*) ([1-9]\d*)$/u.exec(limits.cpuMax) : null;
    if (!match)
    {
        throw new Error('systemd resource projection requires a finite exact CPU quota and period');
    }
    const quota = BigInt(match[1]);
    const period = BigInt(match[2]);
    const perSecond = (quota * 1000000n + period - 1n) / (period || 1n);
    if (quota < 1000n || quota > BigInt(Number.MAX_SAFE_INTEGER) || period < 1000n || period > 1000000n
        || perSecond > BigInt(Number.MAX_SAFE_INTEGER) || perSecond * period / 1000000n !== quota
        || !Number.isSafeInteger(limits.cpuWeight) || limits.cpuWeight < 1 || limits.cpuWeight > 10000
        || !Number.isSafeInteger(limits.memoryPageBytes) || limits.memoryPageBytes < 1 || limits.memoryPageBytes > 16 * 1024 ** 2
        || (limits.memoryPageBytes & (limits.memoryPageBytes - 1)) !== 0
        || ['memoryHighBytes', 'memoryMaxBytes', 'pidsMax'].some((key) => !Number.isSafeInteger(limits[key]) || limits[key] <= 0)
        || limits.memoryHighBytes > limits.memoryMaxBytes
        || limits.memoryHighBytes % limits.memoryPageBytes !== 0 || limits.memoryMaxBytes % limits.memoryPageBytes !== 0)
    {
        throw new Error('systemd resource projection cannot represent the exact bounded control tuple');
    }
    return [
        ['CPUQuotaPerSecUSec', 't', String(perSecond)], ['CPUQuotaPeriodUSec', 't', String(period)],
        ['CPUWeight', 't', String(limits.cpuWeight)], ['MemoryHigh', 't', String(limits.memoryHighBytes)],
        ['MemoryMax', 't', String(limits.memoryMaxBytes)], ['TasksMax', 't', String(limits.pidsMax)]
    ];
}

/** Local user-manager transport; callers retain and compare its observed identity. */
export function createSystemdResourceTransport({
    commandBudgetMs,
    execute = spawnSync,
    platform = process.platform,
    mountRoot = '/sys/fs/cgroup'
})
{
    if (platform !== 'linux')
    {
        throw new Error('systemd resource transport is unsupported outside Linux');
    }
    requireBudget(commandBudgetMs, 'systemd command');
    const runtimeDirectory = `/run/user/${process.getuid()}`;
    const busSocket = path.join(runtimeDirectory, 'bus');
    const environment = Object.freeze({ ...process.env, XDG_RUNTIME_DIR: runtimeDirectory,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${busSocket}` });
    const invoke = (command, args, allowedStatuses = [0]) =>
    {
        const result = execute(command, args, { encoding: 'utf8', shell: false, timeout: commandBudgetMs,
            maxBuffer: 1024 * 1024, env: environment });
        if (result?.error || !allowedStatuses.includes(result?.status))
        {
            throw Object.assign(new Error(`systemd resource ${command} operation failed`, { cause: result?.error }), {
                code: result?.error?.code
            });
        }
        return String(result.stdout ?? '').trim();
    };
    const bus = (destination, method, args = []) =>
        invoke('busctl', ['--user', 'call', ...destination, method, ...args]);
    const dbus = ['org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus'];
    const busValue = (method, type, args = []) =>
    {
        const value = JSON.parse(invoke('busctl', ['--user', '--json=short', 'call', ...dbus, method, ...args]));
        if (value.type !== type || !Array.isArray(value.data) || value.data.length !== 1)
        {
            throw new Error('systemd resource manager returned an invalid typed D-Bus identity');
        }
        return value.data[0];
    };
    const inspect = (unitName) =>
    {
        if (!unitPattern.test(unitName) && !launcherPattern.test(unitName) && !servicePattern.test(unitName) && unitName !== '-.slice')
        {
            throw new Error('systemd resource transport refuses an unscoped unit name');
        }
        // A collected scope is not an implicit slice: show returns 4 and a complete not-found record.
        const requestedProperties = servicePattern.test(unitName) ? [...properties, 'Slice'] : properties;
        const output = invoke('systemctl', ['--user', 'show', ...requestedProperties.flatMap((key) => ['-p', key]), '--', unitName],
            launcherPattern.test(unitName) || servicePattern.test(unitName) ? [0, 4] : [0]);
        const values = {};
        for (const line of output.split('\n'))
        {
            const separator = line.indexOf('=');
            const key = line.slice(0, separator);
            if (separator < 0 || !requestedProperties.includes(key) || Object.hasOwn(values, key))
            {
                throw new Error('systemd resource unit returned an ambiguous property set');
            }
            values[key] = line.slice(separator + 1);
        }
        if (!exactKeys(values, requestedProperties))
        {
            throw new Error('systemd resource unit property observation is incomplete');
        }
        return values;
    };
    const cgroup = (controlGroup, { readControls = true } = {}) =>
    {
        if (typeof controlGroup !== 'string' || !controlGroup.startsWith('/') || controlGroup === '/'
            || path.posix.normalize(controlGroup) !== controlGroup)
        {
            throw new Error('systemd resource cgroup must be a literal non-root absolute path');
        }
        const directory = path.join(mountRoot, controlGroup);
        if (fs.realpathSync(directory) !== directory || fs.statfsSync(directory).type !== 0x63677270)
        {
            throw new Error('systemd resource boundary is not a literal cgroup v2 directory');
        }
        const stat = fs.statSync(directory);
        const read = (name) => fs.readFileSync(path.join(directory, name), 'utf8').trim();
        const events = Object.fromEntries(read('cgroup.events').split('\n').map((line) => line.split(/\s+/u)));
        if (!['0', '1'].includes(events.populated))
        {
            throw new Error('systemd resource populated observation is unavailable');
        }
        return {
            path: directory, device: stat.dev, inode: stat.ino, populated: events.populated === '1',
            children: fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
            processIds: read('cgroup.procs').split(/\s+/u).filter(Boolean).map(Number),
            ...(readControls ? { controls: Object.fromEntries(['cpu.max', 'cpu.weight', 'memory.high', 'memory.max', 'pids.max']
                .map((name) => [name, read(name)])) } : {})
        };
    };
    return {
        runtimeIdentity()
        {
            requireDirectory(runtimeDirectory);
            const socket = fs.lstatSync(busSocket);
            if (!socket.isSocket() || socket.uid !== process.getuid())
            {
                throw new Error('systemd resource manager requires the local current-user bus socket');
            }
            const busId = busValue('GetId', 's');
            const hasManager = busValue('NameHasOwner', 'b', ['s', 'org.freedesktop.systemd1']);
            if (typeof hasManager !== 'boolean')
            {
                throw new Error('systemd resource manager presence response is invalid');
            }
            if (!hasManager)
            {
                throw Object.assign(new Error('systemd user manager is unavailable on the local bus'), { code: 'ENOTSUP' });
            }
            const busOwner = busValue('GetNameOwner', 's', ['s', 'org.freedesktop.systemd1']);
            const managerPid = busValue('GetConnectionUnixProcessID', 'u', ['s', busOwner]);
            const managerUid = busValue('GetConnectionUnixUser', 'u', ['s', busOwner]);
            if (!Number.isSafeInteger(managerPid) || managerPid <= 0 || managerUid !== process.getuid())
            {
                throw new Error('systemd resource manager D-Bus peer credentials are not the local current user');
            }
            // A user manager may be nondumpable: /proc/<pid>/exe then legitimately denies
            // same-UID reads. Bind the broker-authenticated connection plus boot/start ticks;
            // never pretend this is the executable/argv identity required for a workload.
            const stat = fs.readFileSync(`/proc/${managerPid}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
            const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
            if (stat.lastIndexOf(')') < 0 || !/^[1-9]\d*$/u.test(fields[19] ?? '') || fields[0] === 'Z'
                || !/^[a-f0-9-]{36}$/u.test(bootId) || fs.statSync(`/proc/${managerPid}`).uid !== managerUid)
            {
                throw new Error('systemd resource manager process incarnation is unavailable');
            }
            const managerConnection = { pid: managerPid, uid: managerUid, bootId, startTicks: fields[19] };
            const pageText = invoke('getconf', ['PAGESIZE']);
            const memoryPageBytes = Number(pageText);
            if (!/^\d+$/u.test(pageText) || !Number.isSafeInteger(memoryPageBytes) || memoryPageBytes <= 0
                || memoryPageBytes > 16 * 1024 ** 2 || (memoryPageBytes & (memoryPageBytes - 1)) !== 0)
            {
                throw new Error('systemd resource memory page size is unavailable');
            }
            const rootUnit = inspect('-.slice');
            const rootGroup = cgroup(rootUnit.ControlGroup);
            if (!/^[a-f0-9]{32}$/u.test(busId) || !/^:\d+\.\d+$/u.test(busOwner)
                || busValue('GetId', 's') !== busId || busValue('GetNameOwner', 's', ['s', 'org.freedesktop.systemd1']) !== busOwner)
            {
                throw new Error('systemd resource manager identity is incomplete or changed during observation');
            }
            return { busId, busOwner, managerConnection, memoryPageBytes, uid: process.getuid(),
                busSocket: { path: busSocket, device: socket.dev, inode: socket.ino }, controlGroup: rootUnit.ControlGroup,
                cgroup: { path: rootGroup.path, device: rootGroup.device, inode: rootGroup.inode } };
        },
        inspect,
        cgroup,
        artifacts(unit)
        {
            return [unit.FragmentPath, ...unit.DropInPaths.split(' ').filter(Boolean)].map((file) =>
            {
                const stat = fs.lstatSync(file);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
                    || fs.realpathSync(file) !== file)
                {
                    throw new Error('systemd resource unit artifact is not a literal current-user regular file');
                }
                const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                try
                {
                    const observed = fs.fstatSync(descriptor);
                    if (observed.ino !== stat.ino || observed.dev !== stat.dev)
                    {
                        throw new Error('systemd resource unit artifact changed during observation');
                    }
                    return { path: file, contentDigest: sha256Bytes(fs.readFileSync(descriptor)) };
                }
                finally
                {
                    fs.closeSync(descriptor);
                }
            }).sort((left, right) => left.path.localeCompare(right.path));
        },
        start(unitName, description)
        {
            if (!unitPattern.test(unitName) || !/^fsusblog-resource-owner:[a-f0-9]{64}$/u.test(description))
            {
                throw new Error('systemd resource creation requires an exact owned name and description');
            }
            const values = [['Description', 's', description], ['CPUAccounting', 'b', 'true'],
                ['MemoryAccounting', 'b', 'true'], ['TasksAccounting', 'b', 'true']];
            return bus(managerDestination, 'StartTransientUnit', ['ssa(sv)a(sa(sv))', unitName, 'fail', String(values.length), ...values.flat(), '0']);
        },
        stoppedProcess(identity)
        {
            if (processIdentityStatus(identity).status !== 'live')
            {
                throw new Error('systemd resource launcher requires its exact live process identity');
            }
            const stat = fs.readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
            const close = stat.lastIndexOf(')');
            const controlGroup = fs.readFileSync(`/proc/${identity.pid}/cgroup`, 'utf8').trim();
            if (close < 0 || stat.slice(close + 2).split(' ')[0] !== 'T'
                || !/^0::\/[^\n]+$/u.test(controlGroup)
                || processIdentityStatus(identity).status !== 'live')
            {
                throw new Error('systemd resource launcher must remain stopped with a verified unified cgroup');
            }
            return { controlGroup: controlGroup.slice(3) };
        },
        serviceProcess(identity)
        {
            if (processIdentityStatus(identity).status !== 'live')
            {
                throw new Error('systemd resource service requires its exact live process identity');
            }
            const controlGroup = fs.readFileSync(`/proc/${identity.pid}/cgroup`, 'utf8').trim();
            if (!/^0::\/[^\n]+$/u.test(controlGroup) || processIdentityStatus(identity).status !== 'live')
            {
                throw new Error('systemd resource service process identity or unified cgroup changed');
            }
            return { controlGroup: controlGroup.slice(3) };
        },
        startLauncher(unitName, description, slice, identity)
        {
            if (!launcherPattern.test(unitName) || !unitPattern.test(slice)
                || unitName !== launcherUnitName(slice) || !/^fsusblog-resource-launcher:[a-f0-9]{64}$/u.test(description)
                || !Number.isSafeInteger(identity?.pid) || identity.pid <= 0 || identity.pid > 0xffffffff)
            {
                throw new Error('systemd resource launcher requires an exact scoped unit, parent and PID');
            }
            this.stoppedProcess(identity);
            const values = [['Description', 's', description], ['Slice', 's', slice],
                ['PIDs', 'au', '1', String(identity.pid)], ['CollectMode', 's', 'inactive-or-failed']];
            return bus(managerDestination, 'StartTransientUnit', ['ssa(sv)a(sa(sv))', unitName, 'fail', String(values.length), ...values.flat(), '0']);
        },
        setLimits(unitName, limits)
        {
            if (!unitPattern.test(unitName))
            {
                throw new Error('systemd resource update requires an exact owned name');
            }
            const values = systemdResourceProperties(limits);
            bus(managerDestination, 'SetUnitProperties', ['sba(sv)', unitName, 'true', String(values.length), ...values.flat()]);
        },
        stop(unitName)
        {
            if (!unitPattern.test(unitName) && !launcherPattern.test(unitName))
            {
                throw new Error('systemd resource stop requires an exact owned name');
            }
            invoke('systemctl', ['--user', 'stop', '--', unitName]);
        }
    };
}

function emptyUnit(unit)
{
    return unit.ActiveState === 'inactive' && !unit.ControlGroup && !unit.FragmentPath && !unit.DropInPaths
        && unit.Transient === 'no' && !unit.InvocationID;
}

function controlTuple(limits)
{
    return { 'cpu.max': limits.cpuMax, 'cpu.weight': String(limits.cpuWeight), 'memory.high': String(limits.memoryHighBytes),
        'memory.max': String(limits.memoryMaxBytes), 'pids.max': String(limits.pidsMax) };
}

function openBoundarySession({ context, paths, owner, ownerDigest, state, stateDigest, directoryIdentity, transport,
    observeController, recovery = false, validateRecoveryAuthority = null })
{
    let admittedLimits = null;
    const description = `fsusblog-resource-owner:${owner.bindingDigest.slice(7)}`;
    const launcherName = launcherUnitName(owner.unitName);
    const launcherDescription = `fsusblog-resource-launcher:${owner.bindingDigest.slice(7)}`;
    const reference = freezeDeep({ schema: systemdResourceBoundarySchema, context, ownerFile: paths.owner, bindingDigest: owner.bindingDigest });
    const assertRecord = () =>
    {
        if (validateRecoveryAuthority !== null && validateRecoveryAuthority()?.status !== 'verified')
        {
            throw new Error('systemd resource recovery authority changed before an owned effect');
        }
        if (canonicalJson(requireDirectory(paths.directory)) !== canonicalJson(directoryIdentity)
            || readRecord(paths.owner).digest !== ownerDigest || readRecord(paths.state).digest !== stateDigest)
        {
            throw new Error('systemd resource retained authority changed');
        }
        if (canonicalJson(transport.runtimeIdentity()) !== canonicalJson(owner.runtimeIdentity))
        {
            throw new Error('systemd resource manager differs from its retained creation binding');
        }
    };
    const persist = (next) =>
    {
        assertRecord();
        state = { ...state, ...next };
        stateDigest = writeRecord(paths.state, state, stateDigest);
    };
    const owned = ({ allowAbsent = false } = {}) =>
    {
        assertRecord();
        const unit = transport.inspect(owner.unitName);
        if (emptyUnit(unit) && allowAbsent)
        {
            return null;
        }
        const fragmentPath = `/run/user/${owner.runtimeIdentity.uid}/systemd/transient/${owner.unitName}`;
        const allowedDropIns = resourceDropIns.map((name) => `${fragmentPath}.d/50-${name}.conf`);
        const dropIns = unit.DropInPaths.split(' ').filter(Boolean);
        if (unit.Transient !== 'yes' || unit.Description !== description
            || new Set(dropIns).size !== dropIns.length || dropIns.some((file) => !allowedDropIns.includes(file))
            || !/^[a-f0-9]{32}$/u.test(unit.InvocationID)
            || unit.ControlGroup !== `${owner.runtimeIdentity.controlGroup}/${owner.unitName}`
            || unit.FragmentPath !== fragmentPath)
        {
            throw new Error('systemd resource unit does not match its retained ownership binding');
        }
        const group = transport.cgroup(unit.ControlGroup);
        const identity = { controlGroup: unit.ControlGroup, fragmentPath: unit.FragmentPath, invocationId: unit.InvocationID,
            path: group.path, device: group.device, inode: group.inode };
        if (state.unitIdentity && canonicalJson(identity) !== canonicalJson(state.unitIdentity))
        {
            throw new Error('systemd resource unit invocation or cgroup identity changed');
        }
        const artifacts = transport.artifacts(unit);
        if (state.unitArtifacts && state.phase !== 'update-attempted' && canonicalJson(artifacts) !== canonicalJson(state.unitArtifacts))
        {
            throw new Error('systemd resource unit artifacts changed outside its property update');
        }
        return { unit, group, identity, artifacts };
    };
    const ownedLauncher = ({ allowAbsent = false } = {}) =>
    {
        assertRecord();
        const unit = transport.inspect(launcherName);
        const fragment = `/run/user/${owner.runtimeIdentity.uid}/systemd/transient/${launcherName}`;
        const expectedGroup = `${owner.runtimeIdentity.controlGroup}/${owner.unitName}/${launcherName}`;
        if (emptyUnit(unit) && allowAbsent)
        {
            const previousPath = state.launcher?.identity?.path ?? path.join(owner.runtimeIdentity.cgroup.path, owner.unitName, launcherName);
            if (fs.lstatSync(previousPath, { throwIfNoEntry: false }) || fs.lstatSync(fragment, { throwIfNoEntry: false })
                || fs.lstatSync(`${fragment}.d`, { throwIfNoEntry: false }))
            {
                throw new Error('systemd resource launcher absence has uncollected artifacts');
            }
            return null;
        }
        if (!state.launcher || unit.Transient !== 'yes' || unit.Description !== launcherDescription
            || unit.DropInPaths !== '' || unit.FragmentPath !== fragment || unit.ControlGroup !== expectedGroup
            || !/^[a-f0-9]{32}$/u.test(unit.InvocationID))
        {
            throw new Error('systemd resource launcher does not match its retained ownership binding');
        }
        // The grant belongs to the shared parent; systemd need not enable controllers on this leaf.
        const group = transport.cgroup(unit.ControlGroup, { readControls: false });
        const identity = { controlGroup: unit.ControlGroup, fragmentPath: fragment, invocationId: unit.InvocationID,
            path: group.path, device: group.device, inode: group.inode };
        const artifacts = transport.artifacts(unit);
        if ((state.launcher.identity && canonicalJson(identity) !== canonicalJson(state.launcher.identity))
            || (state.launcher.artifacts && canonicalJson(artifacts) !== canonicalJson(state.launcher.artifacts)))
        {
            throw new Error('systemd resource launcher invocation, cgroup or artifacts changed');
        }
        return { unit, group, identity, artifacts };
    };
    const requireLiveController = () =>
    {
        if (recovery || observeController(owner.controllerIdentity)?.status !== 'live')
        {
            throw new Error('systemd resource admission requires its live original controller');
        }
    };
    const assertAdmitted = () =>
    {
        requireLiveController();
        if (!admittedLimits)
        {
            throw new Error('systemd resource boundary has no verified current grant');
        }
        const current = owned();
        if (current.unit.ActiveState !== 'active' || canonicalJson(current.group.controls) !== canonicalJson(controlTuple(admittedLimits)))
        {
            admittedLimits = null;
            throw new Error('systemd resource controls changed before workload admission');
        }
        return freezeDeep({ unitName: owner.unitName, ...current.identity, controls: current.group.controls });
    };
    const cleanup = () =>
    {
        admittedLimits = null;
        let current = owned({ allowAbsent: true });
        if (state.launcher)
        {
            const launcher = ownedLauncher({ allowAbsent: true });
            // The execution owner, not this resource owner, must terminate populated trees.
            if (launcher && !launcher.group.populated && launcher.group.children.length === 0)
            {
                persist({ phase: 'cleanup-pending' });
                assertRecord();
                transport.stop(launcherName);
                if (ownedLauncher({ allowAbsent: true }))
                {
                    throw new Error('systemd resource launcher cleanup did not prove absence');
                }
                current = owned({ allowAbsent: true });
            }
        }
        if (current && (current.group.populated || current.group.children.length > 0))
        {
            const result = { status: 'retained-active', populated: current.group.populated, children: current.group.children };
            persist({ phase: 'cleanup-pending', cleanup: result });
            return freezeDeep(result);
        }
        persist({ phase: 'cleanup-pending' });
        if (current)
        {
            assertRecord();
            transport.stop(owner.unitName);
        }
        const after = transport.inspect(owner.unitName);
        const previousPath = state.unitIdentity?.path ?? current?.identity.path;
        const fragment = `/run/user/${owner.runtimeIdentity.uid}/systemd/transient/${owner.unitName}`;
        if (!emptyUnit(after) || (previousPath && fs.lstatSync(previousPath, { throwIfNoEntry: false }))
            || fs.lstatSync(fragment, { throwIfNoEntry: false }) || fs.lstatSync(`${fragment}.d`, { throwIfNoEntry: false }))
        {
            throw new Error('systemd resource cleanup did not prove unit and cgroup absence');
        }
        const result = { status: 'removed', unitName: owner.unitName };
        persist({ phase: 'released', cleanup: result, limits: null });
        return freezeDeep(result);
    };
    return {
        reference,
        async start(startupBudgetMs)
        {
            requireLiveController();
            assertRecord();
            persist({ phase: 'create-attempted' });
            transport.start(owner.unitName, description);
            const deadline = Date.now() + requireBudget(startupBudgetMs, 'systemd startup');
            for (;;)
            {
                assertRecord();
                const observed = transport.inspect(owner.unitName);
                if (observed.Transient !== 'yes' || observed.Description !== description
                    || !['inactive', 'activating', 'active'].includes(observed.ActiveState))
                {
                    throw new Error('systemd resource startup did not retain its exact transient identity');
                }
                if (observed.ActiveState === 'active')
                {
                    const current = owned();
                    persist({ phase: 'active', unitIdentity: current.identity, unitArtifacts: current.artifacts });
                    return;
                }
                if (Date.now() >= deadline)
                {
                    throw new Error('systemd resource slice did not become active within its startup budget');
                }
                await delay(Math.min(10, Math.max(1, deadline - Date.now())));
            }
        },
        update(limits)
        {
            requireLiveController();
            admittedLimits = null;
            if (state.phase === 'released')
            {
                throw new Error('systemd resource owner is closed');
            }
            // Retain only the transport tuple, never caller metadata or mutable objects.
            limits = Object.fromEntries(['cpuMax', 'cpuWeight', 'memoryPageBytes', 'memoryHighBytes', 'memoryMaxBytes', 'pidsMax']
                .map((key) => [key, limits?.[key]]));
            systemdResourceProperties(limits);
            if (limits.memoryPageBytes !== owner.runtimeIdentity.memoryPageBytes)
            {
                throw new Error('systemd resource grant page size differs from its observed host');
            }
            const before = owned();
            if (before.unit.ActiveState !== 'active')
            {
                throw new Error('systemd resource grant requires an active owned slice');
            }
            persist({ phase: 'update-attempted', limits: null });
            transport.setLimits(owner.unitName, limits);
            const after = owned();
            if (canonicalJson(after.group.controls) !== canonicalJson(controlTuple(limits)))
            {
                throw new Error('systemd resource effective controls differ from the admitted grant');
            }
            persist({ phase: 'active', limits: structuredClone(limits), unitArtifacts: after.artifacts });
            admittedLimits = freezeDeep(structuredClone(limits));
            return freezeDeep({ unitName: owner.unitName, ...after.identity, controls: after.group.controls });
        },
        assertAdmitted,
        executionBoundary(validateAdmission = () =>
        {})
        {
            if (typeof validateAdmission !== 'function')
            {
                throw new Error('systemd execution boundary requires a live admission verifier');
            }
            const verify = () =>
            {
                validateAdmission();
                return assertAdmitted();
            };
            const boundary = freezeDeep({ reference, admission: verify() });
            executionBoundaries.set(boundary, { verify, transport, owner, assertRecord });
            return boundary;
        },
        async attachLauncher(identity, { startupBudgetMs })
        {
            requireBudget(startupBudgetMs, 'systemd launcher startup');
            assertAdmitted();
            if (state.launcher)
            {
                throw new Error('systemd resource launcher admission already attempted for this boundary');
            }
            identity = freezeDeep(structuredClone(identity));
            transport.stoppedProcess(identity);
            if (!emptyUnit(transport.inspect(launcherName)))
            {
                throw new Error('systemd resource launcher refuses an existing unit or configuration');
            }
            persist({ launcher: { phase: 'attach-attempted', processIdentity: identity, identity: null, artifacts: null } });
            try
            {
                transport.startLauncher(launcherName, launcherDescription, owner.unitName, identity);
                const deadline = Date.now() + startupBudgetMs;
                for (;;)
                {
                    const parent = assertAdmitted();
                    const observed = transport.inspect(launcherName);
                    const observedProcess = transport.stoppedProcess(identity);
                    if (observed.Transient !== 'yes' || observed.Description !== launcherDescription
                        || !['inactive', 'activating', 'active'].includes(observed.ActiveState))
                    {
                        throw new Error('systemd resource launcher startup did not retain its exact transient identity');
                    }
                    if (observed.ActiveState === 'active')
                    {
                        const current = ownedLauncher();
                        if (current.unit.ActiveState !== 'active' || observedProcess.controlGroup !== current.identity.controlGroup
                            || !current.group.processIds.includes(identity.pid))
                        {
                            throw new Error('systemd resource launcher membership differs from its stopped process');
                        }
                        persist({ launcher: { ...state.launcher, phase: 'active', identity: current.identity, artifacts: current.artifacts } });
                        assertAdmitted();
                        const finalLauncher = ownedLauncher();
                        if (transport.stoppedProcess(identity).controlGroup !== current.identity.controlGroup
                            || finalLauncher.unit.ActiveState !== 'active' || !finalLauncher.group.processIds.includes(identity.pid))
                        {
                            throw new Error('systemd resource launcher membership changed before resume admission');
                        }
                        return freezeDeep({ parent, launcher: { unitName: launcherName, ...current.identity }, processIdentity: identity });
                    }
                    if (Date.now() >= deadline)
                    {
                        throw new Error('systemd resource launcher did not become active within its startup budget');
                    }
                    await delay(Math.min(10, Math.max(1, deadline - Date.now())));
                }
            }
            catch (error)
            {
                admittedLimits = null;
                error.resourceReference = reference;
                throw error;
            }
        },
        observe()
        {
            const current = owned({ allowAbsent: true });
            const launcher = state.launcher ? ownedLauncher({ allowAbsent: true }) : null;
            if (!current)
            {
                const directory = state.unitIdentity?.path ?? path.join(owner.runtimeIdentity.cgroup.path, owner.unitName);
                const fragment = `/run/user/${owner.runtimeIdentity.uid}/systemd/transient/${owner.unitName}`;
                if (fs.lstatSync(directory, { throwIfNoEntry: false }) || fs.lstatSync(fragment, { throwIfNoEntry: false })
                    || fs.lstatSync(`${fragment}.d`, { throwIfNoEntry: false }) || launcher)
                {
                    throw new Error('systemd resource absence has uncollected artifacts');
                }
            }
            if (state.phase === 'released' && current)
            {
                throw new Error('released systemd resource boundary still has OS resources');
            }
            return freezeDeep({ reference, phase: state.phase, status: state.phase === 'released' ? 'released' : 'retained',
                unitName: owner.unitName, populated: current?.group.populated ?? false,
                children: current?.group.children ?? [], qualificationEligible: false });
        },
        cleanup,
        evidence: () => freezeDeep({ owner, state, qualificationEligible: false })
    };
}

function readBoundaryBinding(contextValue, reference)
{
    const context = requireContext(contextValue);
    const paths = recordPaths(context);
    const directoryIdentity = requireDirectory(paths.directory);
    const ownerRecord = readRecord(paths.owner);
    const stateRecord = readRecord(paths.state);
    const owner = ownerRecord.document;
    const state = stateRecord.document;
    const { bindingDigest, ...body } = owner;
    if (!exactKeys(reference, ['schema', 'context', 'ownerFile', 'bindingDigest'])
        || reference.schema !== systemdResourceBoundarySchema || reference.ownerFile !== paths.owner
        || canonicalJson(reference.context) !== canonicalJson(context) || reference.bindingDigest !== bindingDigest
        || !exactKeys(owner, ['schema', 'context', 'unitName', 'nonce', 'controllerIdentity', 'runtimeIdentity', 'directoryIdentity', 'bindingDigest'])
        || owner.schema !== systemdResourceBoundarySchema || digestCanonical(body) !== bindingDigest
        || canonicalJson(owner.context) !== canonicalJson(context) || !unitPattern.test(owner.unitName)
        || !/^[a-f0-9]{64}$/u.test(owner.nonce)
        || canonicalJson(owner.directoryIdentity) !== canonicalJson(directoryIdentity)
        || !exactKeys(state, ['schema', 'bindingDigest', 'phase', 'unitIdentity', 'unitArtifacts', 'limits', 'cleanup', 'launcher'])
        || state.schema !== systemdResourceBoundarySchema || state.bindingDigest !== bindingDigest
        || (state.launcher !== null && (!exactKeys(state.launcher, ['phase', 'processIdentity', 'identity', 'artifacts'])
            || !['attach-attempted', 'active'].includes(state.launcher.phase)))
        || !['prepared', 'create-attempted', 'active', 'update-attempted', 'cleanup-pending', 'released'].includes(state.phase))
    {
        throw new Error('systemd resource ownership requires the exact independently retained creation binding');
    }
    return { context, paths, directoryIdentity, ownerRecord, stateRecord, owner, state };
}

/** Read the exact creation record without adopting, mutating, or releasing its resource. */
export function readProductionSystemdResourceBoundaryBinding(contextValue, { reference })
{
    const binding = readBoundaryBinding(contextValue, reference);
    return freezeDeep({ owner: binding.owner, state: binding.state,
        ownerDigest: binding.ownerRecord.digest, stateDigest: binding.stateRecord.digest });
}

/** Reobserve retained authority and actual OS absence; a file claiming release is insufficient. */
export function inspectProductionSystemdResourceBoundary(contextValue, {
    reference,
    commandBudgetMs,
    transport = createSystemdResourceTransport({ commandBudgetMs })
})
{
    const binding = readBoundaryBinding(contextValue, reference);
    const session = openBoundarySession({ ...binding, ownerDigest: binding.ownerRecord.digest,
        stateDigest: binding.stateRecord.digest, transport, observeController: processIdentityStatus, recovery: true });
    return session.observe();
}

export function productionSystemdServiceBindingIsComplete(binding)
{
    const parent = binding?.parent;
    const identity = binding?.identity;
    return Boolean(exactKeys(binding, ['schema', 'reference', 'authorityId', 'unitName', 'parent', 'description', 'identity'])
        && binding.schema === systemdServiceBindingSchema
        && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(binding.authorityId)
        && binding.unitName === `fsusblog-physical-${binding.authorityId.replaceAll('-', '')}.service`
        && exactKeys(parent, ['unitName', 'controlGroup', 'fragmentPath', 'invocationId', 'path', 'device', 'inode'])
        && unitPattern.test(parent.unitName) && /^[a-f0-9]{32}$/u.test(parent.invocationId)
        && typeof parent.controlGroup === 'string' && parent.controlGroup.endsWith(`/${parent.unitName}`)
        && typeof parent.path === 'string' && path.isAbsolute(parent.path)
        && Number.isSafeInteger(parent.device) && parent.device >= 0
        && Number.isSafeInteger(parent.inode) && parent.inode > 0
        && exactKeys(binding.reference, ['schema', 'context', 'ownerFile', 'bindingDigest'])
        && binding.reference.schema === systemdResourceBoundarySchema
        && /^sha256:[a-f0-9]{64}$/u.test(binding.reference.bindingDigest)
        && binding.description === `fsusblog-resource-service:${digestCanonical({
            bindingDigest: binding.reference.bindingDigest, unitName: binding.unitName, authorityId: binding.authorityId
        }).slice(7)}`
        && (identity === null || (exactKeys(identity, ['unitName', 'controlGroup', 'invocationId', 'path', 'device', 'inode', 'artifacts'])
            && identity.unitName === binding.unitName && identity.controlGroup === `${parent.controlGroup}/${binding.unitName}`
            && identity.path === path.join(parent.path, binding.unitName) && /^[a-f0-9]{32}$/u.test(identity.invocationId)
            && Number.isSafeInteger(identity.device) && identity.device >= 0
            && Number.isSafeInteger(identity.inode) && identity.inode > 0
            && Array.isArray(identity.artifacts) && identity.artifacts.length === 1
            && identity.artifacts.every((artifact) => exactKeys(artifact, ['path', 'contentDigest'])
                && /^sha256:[a-f0-9]{64}$/u.test(artifact.contentDigest)))));
}

function inspectBoundService(binding, { transport, owner, assertRecord })
{
    assertRecord();
    const { unitName, parent, description } = binding;
    const unit = transport.inspect(unitName);
    const fragment = `/run/user/${owner.runtimeIdentity.uid}/systemd/transient/${unitName}`;
    if (emptyUnit(unit))
    {
        for (const file of [fragment, `${fragment}.d`, path.join(parent.path, unitName)])
        {
            if (fs.lstatSync(file, { throwIfNoEntry: false }))
            {
                throw new Error('systemd resource service absence has uncollected artifacts');
            }
        }
        return null;
    }
    if (unit.Transient !== 'yes' || unit.Description !== description || unit.Slice !== parent.unitName
        || unit.ControlGroup !== `${parent.controlGroup}/${unitName}` || unit.FragmentPath !== fragment
        || unit.DropInPaths !== '' || !/^[a-f0-9]{32}$/u.test(unit.InvocationID))
    {
        throw new Error('systemd resource service does not match its exact process-owner binding');
    }
    const group = transport.cgroup(unit.ControlGroup, { readControls: false });
    const identity = { unitName, controlGroup: unit.ControlGroup, invocationId: unit.InvocationID,
        path: group.path, device: group.device, inode: group.inode, artifacts: transport.artifacts(unit) };
    if (binding.identity && canonicalJson(identity) !== canonicalJson(binding.identity))
    {
        throw new Error('systemd resource service invocation, cgroup or artifacts changed');
    }
    assertRecord();
    return { unit, group, identity };
}

/** Read-only verification for an independently retained process-owner service intent or admission. */
export function inspectProductionSystemdServiceBinding(serviceBinding, {
    commandBudgetMs,
    transport = createSystemdResourceTransport({ commandBudgetMs })
})
{
    if (!productionSystemdServiceBindingIsComplete(serviceBinding))
    {
        throw new Error('systemd process-owner service binding is incomplete');
    }
    const binding = readBoundaryBinding(serviceBinding.reference.context, serviceBinding.reference);
    const { unitName, ...parentIdentity } = serviceBinding.parent;
    if (unitName !== binding.owner.unitName || canonicalJson(parentIdentity) !== canonicalJson(binding.state.unitIdentity))
    {
        throw new Error('systemd process-owner service parent differs from retained resource identity');
    }
    const session = openBoundarySession({ ...binding, ownerDigest: binding.ownerRecord.digest,
        stateDigest: binding.stateRecord.digest, transport, observeController: processIdentityStatus, recovery: true });
    const observed = inspectBoundService(serviceBinding, { transport, owner: binding.owner, assertRecord: () => session.observe() });
    return freezeDeep(observed ? { status: 'present', ...observed } : { status: 'absent', identity: null });
}

/** Bind an existing process owner's planned service to a live, in-process resource admission. */
export function prepareProductionSystemdServiceAdmission(boundary, { unitName, authorityId, expectedContext })
{
    const binding = executionBoundaries.get(boundary);
    if (!binding || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(authorityId ?? '')
        || unitName !== `fsusblog-physical-${authorityId.replaceAll('-', '')}.service`)
    {
        throw new Error('systemd service requires its exact process authority and live resource-owner capability');
    }
    if (canonicalJson(requireContext(expectedContext)) !== canonicalJson(boundary.reference.context))
    {
        throw new Error('systemd resource service execution context differs from its live resource owner');
    }
    const { transport, owner } = binding;
    const parent = binding.verify();
    if (!emptyUnit(transport.inspect(unitName)))
    {
        throw new Error('systemd resource service refuses an existing unit');
    }
    const description = `fsusblog-resource-service:${digestCanonical({ bindingDigest: owner.bindingDigest, unitName, authorityId }).slice(7)}`;
    const expectedGroup = `${parent.controlGroup}/${unitName}`;
    const parentIdentity = Object.fromEntries(['unitName', 'controlGroup', 'fragmentPath', 'invocationId', 'path', 'device', 'inode']
        .map((key) => [key, parent[key]]));
    const serviceBinding = freezeDeep({ schema: systemdServiceBindingSchema, reference: boundary.reference,
        authorityId, unitName, parent: parentIdentity, description, identity: null });
    let serviceIdentity = null;
    let admissionAttempted = false;
    let admittedProcess = null;
    const assertOwnedOrAbsent = () =>
    {
        // Process cleanup verifies ownership, not quota correctness; drift must not prevent terminating our service.
        const observed = inspectBoundService({ ...serviceBinding, identity: serviceIdentity }, binding);
        serviceIdentity ??= observed ? freezeDeep(observed.identity) : null;
        return observed;
    };
    const verifyProcess = (identity, controlGroup) =>
    {
        const currentParent = binding.verify();
        const service = assertOwnedOrAbsent();
        if (!service || service.unit.ActiveState !== 'active' || controlGroup !== expectedGroup
                || !service.group.processIds.includes(identity?.pid)
                || transport.serviceProcess(identity).controlGroup !== expectedGroup)
        {
            throw new Error('systemd resource service pre-exec process ancestry is invalid');
        }
        binding.verify();
        const finalService = assertOwnedOrAbsent();
        if (!finalService || !finalService.group.processIds.includes(identity.pid)
                || transport.serviceProcess(identity).controlGroup !== expectedGroup)
        {
            throw new Error('systemd resource service process moved before release');
        }
        return freezeDeep({ reference: boundary.reference, parent: currentParent,
            service: finalService.identity, processIdentity: identity,
            serviceBinding: { ...serviceBinding, identity: finalService.identity } });
    };
    return Object.freeze({
        reference: boundary.reference, unitName, sliceUnitName: parent.unitName, description, serviceBinding,
        assertOwnedOrAbsent,
        admit(identity, controlGroup)
        {
            if (admissionAttempted)
            {
                throw new Error('systemd resource service admission is one-shot');
            }
            admissionAttempted = true;
            const result = verifyProcess(identity, controlGroup);
            admittedProcess = freezeDeep(structuredClone(identity));
            return result;
        },
        revalidate()
        {
            if (!admittedProcess)
            {
                throw new Error('systemd resource service has no successful pre-exec admission');
            }
            return verifyProcess(admittedProcess, expectedGroup);
        }
    });
}

/** Empty-only recovery; process-tree termination remains with the existing execution owner. */
export function recoverProductionSystemdResourceBoundary(contextValue, {
    reference,
    commandBudgetMs,
    transport = createSystemdResourceTransport({ commandBudgetMs }),
    observeController = processIdentityStatus,
    validateRecoveryAuthority = null
})
{
    if (validateRecoveryAuthority !== null && typeof validateRecoveryAuthority !== 'function')
    {
        throw new Error('systemd resource recovery authority must be callable');
    }
    const assertRecoveryAuthority = () =>
    {
        if (validateRecoveryAuthority !== null && validateRecoveryAuthority()?.status !== 'verified')
        {
            throw new Error('systemd resource recovery authority is no longer exclusive');
        }
    };
    const { context, paths, directoryIdentity, ownerRecord, stateRecord, owner, state } = readBoundaryBinding(contextValue, reference);
    if (observeController(owner.controllerIdentity)?.status !== 'dead')
    {
        throw new Error('systemd resource recovery requires a proven dead controller');
    }
    const lock = path.join(paths.directory, 'recovery.lock');
    const lockFile = path.join(lock, 'owner.json');
    const staleLock = fs.lstatSync(lock, { throwIfNoEntry: false });
    if (staleLock && validateRecoveryAuthority !== null)
    {
        assertRecoveryAuthority();
        const staleDirectoryIdentity = requireDirectory(lock);
        if (staleLock.dev !== staleDirectoryIdentity.device || staleLock.ino !== staleDirectoryIdentity.inode
            || canonicalJson(fs.readdirSync(lock).sort()) !== canonicalJson(['owner.json']))
        {
            throw new Error('systemd resource recovery lock contains unknown entries or changed identity');
        }
        const staleFileIdentity = fs.lstatSync(lockFile);
        const staleRecord = readRecord(lockFile);
        const previous = staleRecord.document;
        if (!exactKeys(previous, ['identity', 'nonce'])
            || !exactKeys(previous.identity, ['status', 'schema', 'pid', 'processStartIdentity',
                'executablePath', 'executableDigest', 'commandDigest'])
            || previous.identity.status !== 'verified' || previous.identity.schema !== processIdentitySchema
            || !Number.isSafeInteger(previous.identity.pid) || previous.identity.pid <= 0
            || !/^[a-f0-9]{64}$/u.test(previous.nonce)
            || canonicalJson(previous.identity) === canonicalJson(owner.controllerIdentity)
            || processIdentityStatus(previous.identity).status !== 'dead')
        {
            throw new Error('systemd resource recovery lock owner is foreign, live or unverifiable');
        }
        assertRecoveryAuthority();
        const currentFileIdentity = fs.lstatSync(lockFile);
        if (canonicalJson(requireDirectory(lock)) !== canonicalJson(staleDirectoryIdentity)
            || ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'ctimeMs', 'mtimeMs'].some((key) =>
                currentFileIdentity[key] !== staleFileIdentity[key])
            || canonicalJson(fs.readdirSync(lock).sort()) !== canonicalJson(['owner.json'])
            || readRecord(lockFile).digest !== staleRecord.digest)
        {
            throw new Error('systemd resource recovery lock changed before dead-owner takeover');
        }
        fs.unlinkSync(lockFile);
        fs.rmdirSync(lock);
        syncDirectory(paths.directory);
        assertRecoveryAuthority();
    }
    assertRecoveryAuthority();
    fs.mkdirSync(lock, { mode: 0o700 });
    syncDirectory(paths.directory);
    const lockIdentity = requireDirectory(lock);
    const lockDigest = writeRecord(lockFile, { identity: currentProcessIdentity(), nonce: randomBytes(32).toString('hex') });
    let result;
    let failure;
    try
    {
        if (observeController(owner.controllerIdentity)?.status !== 'dead')
        {
            throw new Error('systemd resource recovery controller state changed after lock acquisition');
        }
        const session = openBoundarySession({ context, paths, owner, ownerDigest: ownerRecord.digest,
            state, stateDigest: stateRecord.digest, directoryIdentity, transport, observeController, recovery: true,
            validateRecoveryAuthority });
        result = session.cleanup();
    }
    catch (error)
    {
        failure = error;
    }
    try
    {
        assertRecoveryAuthority();
        if (canonicalJson(requireDirectory(lock)) !== canonicalJson(lockIdentity) || readRecord(lockFile).digest !== lockDigest)
        {
            throw new Error('systemd resource recovery lock identity changed; refusing removal');
        }
        fs.unlinkSync(lockFile);
        fs.rmdirSync(lock);
        syncDirectory(paths.directory);
    }
    catch (error)
    {
        if (failure)
        {
            failure.recoveryLockCleanupError = error.message;
        }
        else
        {
            failure = error;
        }
    }
    if (failure)
    {
        throw failure;
    }
    return result;
}

/** Prepare one shared resource ancestor; no workload may use it before update/read-back. */
export async function prepareProductionSystemdResourceBoundary(contextValue, {
    retainBinding,
    startupBudgetMs,
    commandBudgetMs,
    transport = createSystemdResourceTransport({ commandBudgetMs }),
    controllerIdentity = currentProcessIdentity(),
    observeController = processIdentityStatus
})
{
    const context = requireContext(contextValue);
    requireBudget(startupBudgetMs, 'systemd startup');
    if (typeof retainBinding !== 'function' || observeController(controllerIdentity)?.status !== 'live')
    {
        throw new Error('systemd resource creation requires independent binding retention and a live controller');
    }
    const paths = recordPaths(context);
    const runtimeIdentity = transport.runtimeIdentity();
    const unitName = `fsusblogresource${randomBytes(16).toString('hex')}.slice`;
    if (!emptyUnit(transport.inspect(unitName)))
    {
        throw new Error('systemd resource creation refuses an existing unit or configuration');
    }
    const directoryIdentity = prepareDirectory(context, paths);
    const body = { schema: systemdResourceBoundarySchema, context, unitName, nonce: randomBytes(32).toString('hex'),
        controllerIdentity: structuredClone(controllerIdentity), runtimeIdentity, directoryIdentity };
    const owner = freezeDeep({ ...body, bindingDigest: digestCanonical(body) });
    const ownerDigest = writeRecord(paths.owner, owner);
    const state = { schema: systemdResourceBoundarySchema, bindingDigest: owner.bindingDigest, phase: 'prepared',
        unitIdentity: null, unitArtifacts: null, limits: null, cleanup: null, launcher: null };
    const stateDigest = writeRecord(paths.state, state);
    const session = openBoundarySession({ context, paths, owner, ownerDigest, state, stateDigest, directoryIdentity, transport, observeController });
    // The caller must durably retain this reference outside the candidate record before effects.
    try
    {
        const acknowledgement = await retainBinding(session.reference);
        if (!exactKeys(acknowledgement, ['bindingDigest']) || acknowledgement.bindingDigest !== owner.bindingDigest)
        {
            throw new Error('systemd resource independent retention did not acknowledge the exact binding');
        }
        await session.start(startupBudgetMs);
        return Object.freeze({ reference: session.reference, update: session.update, assertAdmitted: session.assertAdmitted, executionBoundary: session.executionBoundary, attachLauncher: session.attachLauncher,
            cleanup: session.cleanup, evidence: session.evidence });
    }
    catch (error)
    {
        try
        {
            error.resourceCleanup = session.cleanup();
        }
        catch (cleanupError)
        {
            error.resourceCleanup = { status: 'recovery-required', message: cleanupError.message, reference: session.reference };
        }
        throw error;
    }
}
