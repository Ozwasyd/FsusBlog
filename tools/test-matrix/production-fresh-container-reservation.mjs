import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

const execute = promisify(execFile);
const labelPrefix = 'io.fsusblog.test.';
const gateTarget = '/run/fsusblog-port-reservation';
const gateScript = `#!/bin/sh
set -eu
while [ ! -f '${gateTarget}/activate' ]; do sleep 0.05; done
IFS= read -r activation < '${gateTarget}/activate'
[ "$activation" = "$FSUSBLOG_RESERVATION_ACTIVATION" ] || exit 76
exec docker-entrypoint.sh "$@"
`;

function hash(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function docker(args)
{
    const result = await execute('docker', args, { timeout: 30000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
}

function requiredString(value, name)
{
    if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value))
    {
        throw new Error(`container reservation requires ${name}`);
    }
    return value;
}

export function validateContainerReservationOptions(options)
{
    if (process.platform !== 'linux')
    {
        throw new Error('container publisher reservation requires Linux Docker publisher observation');
    }
    if (!['postgres', 'redis'].includes(options.role))
    {
        throw new Error('container reservation supports postgres and redis only');
    }
    for (const name of ['runId', 'namespace', 'taskId', 'name', 'gateRoot'])
    {
        requiredString(options[name], name);
    }
    if (!/^fsusblog-(?:test|ci)-[a-zA-Z0-9_.-]+$/u.test(options.name))
    {
        throw new Error('container reservation requires an isolated test/ci name');
    }
    if (!/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/u.test(options.imageReference ?? ''))
    {
        throw new Error('container reservation requires a real pinned image reference');
    }
    if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535 ||
        options.containerPort !== (options.role === 'postgres' ? 5432 : 6379))
    {
        throw new Error('container reservation port contract is invalid');
    }
    const args = options.resourceArgs;
    if (!Array.isArray(args) || args.length % 2 !== 0)
    {
        throw new Error('container reservation requires explicit bounded resource arguments');
    }
    const limits = new Map();
    const labels = new Set();
    for (let index = 0; index < args.length; index += 2)
    {
        const flag = args[index];
        const value = requiredString(args[index + 1], flag);
        if (!['--cpus', '--memory-reservation', '--memory', '--pids-limit', '--label'].includes(flag))
        {
            throw new Error(`container reservation forbids resource argument ${flag}`);
        }
        if (flag === '--label')
        {
            const key = value.split('=')[0];
            const labelValue = value.slice(value.indexOf('=') + 1);
            const expectedCanonical = {
                [`${labelPrefix}run-id`]: options.runId,
                [`${labelPrefix}namespace`]: options.namespace
            };
            if (!value.includes('=') || !value.startsWith(labelPrefix) || labels.has(key) ||
                key.startsWith(`${labelPrefix}reservation-`) ||
                Object.hasOwn(expectedCanonical, key) && expectedCanonical[key] !== labelValue)
            {
                throw new Error('container reservation label conflicts with owner identity');
            }
            labels.add(key);
            continue;
        }
        if (limits.has(flag) || !/^[0-9]+(?:\.[0-9]+)?$/u.test(value) || Number(value) <= 0)
        {
            throw new Error(`container reservation resource limit is invalid: ${flag}`);
        }
        limits.set(flag, Number(value));
    }
    if (limits.size !== 4 || !Number.isInteger(limits.get('--pids-limit')) ||
        !Number.isInteger(limits.get('--memory')) || !Number.isInteger(limits.get('--memory-reservation')) ||
        limits.get('--memory-reservation') > limits.get('--memory'))
    {
        throw new Error('container reservation requires cpu, memory high/max, and pids limits');
    }
    for (const [key, value] of Object.entries(options.env ?? {}))
    {
        if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || key === 'FSUSBLOG_RESERVATION_ACTIVATION')
        {
            throw new Error('container reservation environment key is invalid');
        }
        requiredString(value, key);
    }
}

async function inspectContainer(id)
{
    return JSON.parse(await docker(['inspect', id]))[0];
}

async function publisherIdentity(port, containerPort, containerAddress)
{
    const matches = [];
    for (const entry of await fs.readdir('/proc'))
    {
        if (!/^\d+$/u.test(entry))
        {
            continue;
        }
        try
        {
            const command = await fs.readFile(`/proc/${entry}/cmdline`);
            const argv = command.toString().split('\0').filter(Boolean);
            if (path.basename(argv[0] ?? '') !== 'docker-proxy')
            {
                continue;
            }
            const argument = (name) => argv[argv.indexOf(name) + 1];
            if (argument('-host-ip') !== '127.0.0.1' || argument('-host-port') !== String(port) ||
                argument('-container-port') !== String(containerPort) || argument('-container-ip') !== containerAddress ||
                argument('-proto') !== 'tcp')
            {
                continue;
            }
            const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8');
            matches.push({ pid: Number(entry), processStartIdentity: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], commandDigest: hash(command) });
        }
        catch (error)
        {
            if (!['ENOENT', 'EACCES', 'ESRCH'].includes(error.code))
            {
                throw error;
            }
        }
    }
    if (matches.length !== 1)
    {
        throw new Error('container reservation publisher identity is unavailable or ambiguous');
    }
    const result = await execute('ss', ['-H', '-ltnpe', `sport = :${port}`], { timeout: 5000 });
    const sockets = result.stdout.split('\n').filter((line) => line.includes(`127.0.0.1:${port} `));
    if (sockets.length !== 1)
    {
        throw new Error('container reservation publisher socket is unavailable or ambiguous');
    }
    const inode = sockets[0].match(/\bino:(\d+)\b/u)?.[1];
    if (!inode)
    {
        throw new Error('container reservation publisher socket inode is unavailable');
    }
    return { ...matches[0], socketInode: inode, bindAddress: '127.0.0.1', port, protocol: 'tcp' };
}

function directoryIdentity(stat)
{
    return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 };
}

async function verifyGateDirectory(gateDirectory, expected)
{
    const resolved = path.resolve(gateDirectory);
    if (resolved !== gateDirectory || !/^container-reservation-[a-zA-Z0-9]+$/u.test(path.basename(resolved)) ||
        await fs.realpath(resolved) !== resolved)
    {
        throw new Error('container reservation gate path drift; refusing mutation');
    }
    const observed = await fs.lstat(resolved);
    if (!observed.isDirectory() || observed.isSymbolicLink() ||
        !isDeepStrictEqual(directoryIdentity(observed), expected.directory) || observed.uid !== process.getuid() ||
        (observed.mode & 0o077) !== 0 ||
        !isDeepStrictEqual(directoryIdentity(await fs.lstat(path.dirname(resolved))), expected.root))
    {
        throw new Error('container reservation gate identity drift; refusing mutation');
    }
    const scriptPath = path.join(resolved, 'entrypoint.sh');
    const script = await fs.lstat(scriptPath);
    if (!script.isFile() || script.isSymbolicLink() || script.nlink !== 1 ||
        !isDeepStrictEqual(directoryIdentity(script), expected.script) ||
        hash(await fs.readFile(scriptPath)) !== expected.scriptDigest)
    {
        throw new Error('container reservation gate script drift; refusing mutation');
    }
}

async function observePublisher(container, expected)
{
    const mapping = container.NetworkSettings.Ports[`${expected.containerPort}/tcp`];
    if (!container.State.Running || mapping?.length !== 1 || mapping[0].HostIp !== '127.0.0.1' ||
        mapping[0].HostPort !== String(expected.port))
    {
        throw new Error('container reservation mapping drift');
    }
    const addresses = Object.values(container.NetworkSettings.Networks).map((network) => network.IPAddress).filter(Boolean);
    if (addresses.length !== 1)
    {
        throw new Error('container reservation network identity is ambiguous');
    }
    const gateMounts = container.Mounts.filter((mount) => mount.Destination === gateTarget);
    if (gateMounts.length !== 1 || gateMounts[0].Source !== expected.gateDirectory || gateMounts[0].RW !== false)
    {
        throw new Error('container reservation gate mount drift');
    }
    return {
        runId: container.Config.Labels[`${labelPrefix}run-id`],
        namespace: container.Config.Labels[`${labelPrefix}namespace`],
        taskId: container.Config.Labels[`${labelPrefix}reservation-task`],
        role: container.Config.Labels[`${labelPrefix}reservation-role`],
        name: container.Name.slice(1), port: expected.port, containerPort: expected.containerPort,
        containerId: container.Id, containerCreatedAt: container.Created, containerProcessId: container.State.Pid,
        containerStartedAt: container.State.StartedAt, imageReference: container.Config.Image,
        imageId: container.Image, imageDigest: container.Config.Image.split('@')[1],
        reservationTokenDigest: container.Config.Labels[`${labelPrefix}reservation-token`],
        labels: container.Config.Labels, gateOwner: expected.gateOwner,
        resources: {
            cpuNanoUnits: container.HostConfig.NanoCpus, memoryHighBytes: container.HostConfig.MemoryReservation,
            memoryMaxBytes: container.HostConfig.Memory, pidsMax: container.HostConfig.PidsLimit
        },
        publisher: await publisherIdentity(expected.port, expected.containerPort, addresses[0])
    };
}

/** Read-only observation of the exact final publisher retained by the canonical allocator. */
export async function observeReservedContainerPublisher({ownerIdentity, gateDirectory})
{
    await verifyGateDirectory(gateDirectory, ownerIdentity.gateOwner);
    const observation = await observePublisher(await inspectContainer(ownerIdentity.containerId), {...ownerIdentity, gateDirectory});
    if (!isDeepStrictEqual(observation, ownerIdentity))
    {
        throw new Error('reserved container publisher identity drift');
    }
    return observation;
}

/** Called only by canonical allocator recovery after its reservation daemon death check. */
export async function recoverReleaseContainerPublisher({ ownerIdentity, gateDirectory })
{
    if (!ownerIdentity || !/^[a-f0-9]{64}$/u.test(ownerIdentity.containerId ?? '') ||
        !['postgres', 'redis'].includes(ownerIdentity.role) || !ownerIdentity.gateOwner ||
        !/^fsusblog-(?:test|ci)-[a-zA-Z0-9_.-]+$/u.test(ownerIdentity.name ?? ''))
    {
        throw new Error('container reservation recovery requires a complete recorded owner identity');
    }
    await verifyGateDirectory(gateDirectory, ownerIdentity.gateOwner);
    let container;
    try
    {
        container = await inspectContainer(ownerIdentity.containerId);
    }
    catch (error)
    {
        if (!/No such (?:object|container)/u.test(error.stderr ?? ''))
        {
            throw error;
        }
    }
    const previous = container ? await observePublisher(container, { ...ownerIdentity, gateDirectory }) : null;
    if (previous && !isDeepStrictEqual(previous, ownerIdentity))
    {
        throw new Error('container reservation recovery owner identity drift; refusing mutation');
    }
    await verifyGateDirectory(gateDirectory, ownerIdentity.gateOwner);
    if (container)
    {
        const confirmed = await observePublisher(await inspectContainer(ownerIdentity.containerId), { ...ownerIdentity, gateDirectory });
        if (!isDeepStrictEqual(confirmed, ownerIdentity))
        {
            throw new Error('container reservation recovery identity changed during verification; refusing mutation');
        }
        await docker(['rm', '--force', '--volumes', ownerIdentity.containerId]);
    }
    // Recheck the gate after daemon removal; a drift must never delete a replacement directory.
    await verifyGateDirectory(gateDirectory, ownerIdentity.gateOwner);
    await fs.rm(gateDirectory, { recursive: true });
    return {
        containerId: ownerIdentity.containerId, containerOutcome: container ? 'removed-exact-owner' : 'exact-id-not-found',
        gateDirectory, gateOutcome: 'removed-exact-owner', observedOwnerIdentity: previous
    };
}

/**
 * Called by the single port allocator after its admission and IPv6 guard.
 * The final container itself reserves IPv4; activation never replaces it or its publisher.
 * This primitive is not a business-readiness or executable/FD qualification receipt.
 */
export async function reserveContainerPublisher(options)
{
    validateContainerReservationOptions(options);
    options.signal?.throwIfAborted();
    const image = JSON.parse(await docker(['image', 'inspect', options.imageReference]))[0];
    if (!image.RepoDigests?.includes(options.imageReference) || !/^sha256:[a-f0-9]{64}$/u.test(image.Id) ||
        JSON.stringify(image.Config.Entrypoint) !== JSON.stringify(['docker-entrypoint.sh']) ||
        JSON.stringify(image.Config.Cmd) !== JSON.stringify([options.role === 'postgres' ? 'postgres' : 'redis-server']))
    {
        throw new Error('container reservation pinned image or official entrypoint identity mismatch');
    }
    const root = path.resolve(options.gateRoot);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root ||
        rootStat.uid !== process.getuid() || (rootStat.mode & 0o077) !== 0 || root.includes(','))
    {
        throw new Error('container reservation requires an owner-only real gate root');
    }
    const token = randomBytes(32).toString('hex');
    const tokenDigest = hash(token);
    const gateDirectory = await fs.mkdtemp(path.join(root, 'container-reservation-'));
    const gateIdentity = await fs.lstat(gateDirectory);
    const gateOwner = { directory: directoryIdentity(gateIdentity), root: directoryIdentity(rootStat) };
    try
    {
        await fs.chmod(gateDirectory, 0o700);
        await fs.writeFile(path.join(gateDirectory, 'entrypoint.sh'), gateScript, { mode: 0o500, flag: 'wx' });
        gateOwner.script = directoryIdentity(await fs.lstat(path.join(gateDirectory, 'entrypoint.sh')));
        gateOwner.scriptDigest = hash(gateScript);
    }
    catch (error)
    {
        const observed = await fs.lstat(gateDirectory);
        if (observed.dev === gateIdentity.dev && observed.ino === gateIdentity.ino && !observed.isSymbolicLink())
        {
            await fs.rm(gateDirectory, { recursive: true });
        }
        throw error;
    }
    let containerId = null;
    let ownerIdentity = null;
    let closed = false;
    let activated = false;
    let transferred = false;
    let closePromise = null;
    let activationPromise = null;
    const expectedLabels = {
        [`${labelPrefix}run-id`]: options.runId,
        [`${labelPrefix}namespace`]: options.namespace,
        [`${labelPrefix}reservation-task`]: options.taskId,
        [`${labelPrefix}reservation-role`]: options.role,
        [`${labelPrefix}reservation-token`]: tokenDigest
    };
    const requestedLimits = Object.fromEntries(options.resourceArgs.reduce((entries, argument, index, args) =>
    {
        if (index % 2 === 0)
        {
            if (argument === '--label')
            {
                const separator = args[index + 1].indexOf('=');
                expectedLabels[args[index + 1].slice(0, separator)] = args[index + 1].slice(separator + 1);
            }
            else
            {
                entries.push([argument, Number(args[index + 1])]);
            }
        }
        return entries;
    }, []));
    function assertOwned(container)
    {
        if (container.Id !== containerId || container.Image !== image.Id || container.Config.Image !== options.imageReference ||
            Object.entries(expectedLabels).some(([key, value]) => container.Config.Labels?.[key] !== value))
        {
            throw new Error('container reservation owner identity drift; refusing mutation');
        }
    }
    async function assertGateOwned()
    {
        await verifyGateDirectory(gateDirectory, gateOwner);
    }
    async function close()
    {
        if (closePromise)
        {
            return closePromise;
        }
        closed = true;
        closePromise = (async () =>
        {
            if (containerId)
            {
                let container;
                try
                {
                    container = await inspectContainer(containerId);
                }
                catch (error)
                {
                    if (!/No such (?:object|container)/u.test(error.stderr ?? ''))
                    {
                        throw error;
                    }
                }
                if (container)
                {
                    assertOwned(container);
                    await docker(['rm', '--force', '--volumes', containerId]);
                }
            }
            await assertGateOwned();
            await fs.rm(gateDirectory, { recursive: true });
            options.signal?.removeEventListener('abort', onAbort);
        })();
        return closePromise;
    }
    // The caller also awaits close on cancellation; rejection remains observable there.
    function onAbort()
    {
        void close().catch(() =>
        {});
    }
    async function observe()
    {
        if (closed)
        {
            throw new Error('container reservation is released');
        }
        if (!transferred)
        {
            options.signal?.throwIfAborted();
        }
        const container = await inspectContainer(containerId);
        assertOwned(container);
        const resources = {
            cpuNanoUnits: container.HostConfig.NanoCpus,
            memoryHighBytes: container.HostConfig.MemoryReservation,
            memoryMaxBytes: container.HostConfig.Memory,
            pidsMax: container.HostConfig.PidsLimit
        };
        if (resources.cpuNanoUnits !== Math.round(requestedLimits['--cpus'] * 1e9) ||
            resources.memoryHighBytes !== requestedLimits['--memory-reservation'] ||
            resources.memoryMaxBytes !== requestedLimits['--memory'] || resources.pidsMax !== requestedLimits['--pids-limit'])
        {
            throw new Error('container reservation resource envelope drift');
        }
        const observed = await observePublisher(container, { ...options, gateDirectory, gateOwner });
        if (ownerIdentity && !isDeepStrictEqual(observed, ownerIdentity))
        {
            throw new Error('container reservation continuous identity drift');
        }
        return observed;
    }
    try
    {
        const args = ['create', '--pull=never', '--name', options.name, ...options.resourceArgs];
        for (const [key, value] of Object.entries(expectedLabels))
        {
            args.push('--label', `${key}=${value}`);
        }
        for (const [key, value] of Object.entries(options.env ?? {}))
        {
            args.push('--env', `${key}=${value}`);
        }
        args.push('--env', `FSUSBLOG_RESERVATION_ACTIVATION=${token}`, '--mount',
            `type=bind,source=${gateDirectory},target=${gateTarget},readonly`, '--entrypoint', '/bin/sh',
            '--publish', `127.0.0.1:${options.port}:${options.containerPort}`, options.imageReference,
            `${gateTarget}/entrypoint.sh`, ...image.Config.Cmd);
        containerId = await docker(args);
        options.signal?.throwIfAborted();
        await docker(['start', containerId]);
        options.signal?.throwIfAborted();
        ownerIdentity = await observe();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        options.signal?.throwIfAborted();
        return {
            ownerIdentity, gateDirectory, observe, close,
            async transferToRuntime()
            {
                if (!activated)
                {
                    throw new Error('container reservation cannot transfer before activation');
                }
                const observed = await observe();
                if (closed)
                {
                    throw new Error('container reservation is released');
                }
                options.signal?.throwIfAborted();
                transferred = true;
                options.signal?.removeEventListener('abort', onAbort);
                return observed;
            },
            async activate()
            {
                if (activationPromise)
                {
                    return activationPromise;
                }
                activationPromise = (async () =>
                {
                    await observe();
                    await assertGateOwned();
                    if (!activated)
                    {
                        const temporary = path.join(gateDirectory, 'activate.tmp');
                        await fs.writeFile(temporary, `${token}\n`, { mode: 0o400, flag: 'wx' });
                        options.signal?.throwIfAborted();
                        await fs.rename(temporary, path.join(gateDirectory, 'activate'));
                        activated = true;
                    }
                    return observe();
                })();
                try
                {
                    return await activationPromise;
                }
                finally
                {
                    activationPromise = null;
                }
            }
        };
    }
    catch (error)
    {
        try
        {
            await close();
        }
        catch (cleanupError)
        {
            error.cleanupError = cleanupError;
        }
        throw error;
    }
}
