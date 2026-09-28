import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { prepareProductionSystemdServiceAdmission } = await import(new URL('../test-matrix/production-systemd-resource-boundary.mjs', import.meta.url));
const { digestCanonical, freezeDeep } = await import(new URL('../test-fixtures/receipt/canonical.mjs', import.meta.url));

import { resolveExecutablePath } from './execution-envelope-environment.mjs';
import { createPhysicalExecutionOutputTracker, residentServiceOutputSchema,
    resourceServiceContainmentIsComplete, resourceServiceContainmentSchema } from './physical-execution-process-tree.mjs';
import { systemdSenderReadyIsComplete, verifySystemdSenderTerminal } from './physical-execution-systemd-sender.mjs';
import {
    tmpIdentity,
    verifyPrivateDotnetScratchBinding,
    verifyPrivateTmpNamespace
} from './physical-execution-private-dotnet-scratch.mjs';
import {
    collectProcessGroupOrJobIdentity,
    collectProcessIdentity,
    processIdentityStatus
} from './process-identity.mjs';

const bootstrap = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'physical-execution-linux-systemd-bootstrap.mjs'
);
const senderBootstrap = path.join(path.dirname(fileURLToPath(import.meta.url)), 'physical-execution-systemd-sender.mjs');

function executableSnapshot(command, environment, cwd)
{
    const candidates = command[0].includes('/') ? [command[0]]
        : (environment.PATH ?? '/usr/bin:/bin').split(':').map((directory) =>
            directory ? `${directory}${directory.endsWith('/') ? '' : '/'}${command[0]}` : command[0]);
    return candidates.map((candidate) =>
    {
        let descriptor;
        try
        {
            const absolute = path.resolve(cwd, candidate);
            if (!fs.statSync(absolute).isFile())
            {
                return { path: candidate, code: 'EACCES' };
            }
            descriptor = fs.openSync(absolute, 'r');
            const metadata = fs.fstatSync(descriptor, { bigint: true });
            const hasher = createHash('sha256');
            const buffer = Buffer.alloc(1024 * 1024);
            let count;
            while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
            {
                hasher.update(buffer.subarray(0, count));
            }
            const sha256 = hasher.digest('hex');
            return {
                path: candidate,
                realPath: fs.realpathSync(absolute),
                device: Number(metadata.dev),
                inode: Number(metadata.ino),
                mode: Number(metadata.mode),
                size: Number(metadata.size),
                modified: String(metadata.mtimeNs),
                changed: String(metadata.ctimeNs),
                sha256
            };
        }
        catch (error)
        {
            return { path: candidate, code: error.code };
        }
        finally
        {
            if (descriptor !== undefined)
            {
                fs.closeSync(descriptor);
            }
        }
    });
}

function delay(milliseconds)
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class WaitForFileCancellation extends Error
{
    constructor(phase, reason)
    {
        super(`physical execution ${phase} aborted`);
        this.name = 'WaitForFileCancellation';
        this.reason = reason;
    }
}

function cancellationPrimary(reason)
{
    if (reason instanceof Error)
    {
        return reason;
    }
    const safeReason = ['string', 'number', 'boolean'].includes(typeof reason)
        ? reason
        : reason == null
      ? null
      : '[non-error abort reason]';
    const error = new Error('physical execution cancelled', { cause: safeReason });
    error.name = 'AbortError';
    error.abortReason = safeReason;
    return error;
}

function systemctl(args)
{
    return spawnSync('systemctl', ['--user', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
}

function commandResultEvidence(args, result)
{
    const error = result?.error;
    return {
        args,
        status: Number.isInteger(result?.status) ? result.status : null,
        signal: result?.signal ?? null,
        error: error
            ? {
          name: error.name,
          code: error.code ?? null,
          message: error.message
        }
            : null,
        stdout: String(result?.stdout ?? ''),
        stderr: String(result?.stderr ?? '')
    };
}

function requireSystemdAuthority(runSystemctl)
{
    const result = runSystemctl(['show-environment']);
    if (result.status !== 0)
    {
        throw new Error(
            `physical execution Linux cgroup authority is unavailable: ${
                String(result.stderr ?? result.stdout ?? '').trim() || `exit ${result.status}`
            }`
        );
    }
}

function unitProperties(unitName, runSystemctl)
{
    const args = [
        'show',
        unitName,
        '--property=LoadState',
        '--property=ActiveState',
        '--property=ControlGroup',
        '--property=MainPID',
        '--property=PrivateNetwork',
        '--property=IPAddressAllow',
        '--property=IPAddressDeny',
        '--property=PrivateTmp',
        '--property=ProtectHome',
        '--property=ProtectSystem',
        '--property=ReadWritePaths',
        '--no-pager'
    ];
    let result;
    try
    {
        result = runSystemctl(args);
    }
    catch (error)
    {
        result = { status: null, stdout: '', stderr: '', error };
    }
    if (result.status !== 0)
    {
        return {
            status: 'unverifiable',
            reason: String(result.stderr ?? result.stdout ?? '').trim() ||
        result.error?.message ||
        `exit ${result.status}`,
            command: commandResultEvidence(args, result)
        };
    }
    const values = Object.fromEntries(String(result.stdout).trim().split(/\r?\n/u)
        .map((line) => line.split(/=(.*)/su).slice(0, 2)));
    return { status: 'verified', values, command: commandResultEvidence(args, result) };
}

function exactPropertyTokens(value, expected)
{
    const actualTokens = String(value ?? '').trim().split(/\s+/u).filter(Boolean).sort();
    const expectedTokens = [...expected].sort();
    return actualTokens.length === expectedTokens.length
        && actualTokens.every((token, index) => token === expectedTokens[index]);
}

function cgroupMemberPids(controlGroup)
{
    if (!controlGroup)
    {
        return [];
    }
    const file = path.join('/sys/fs/cgroup', controlGroup.replace(/^\/+/u, ''), 'cgroup.procs');
    try
    {
        return fs.readFileSync(file, 'utf8').trim().split(/\s+/u)
            .filter(Boolean)
            .map(Number)
            .filter((pid) => Number.isInteger(pid) && pid > 0)
            .sort((left, right) => left - right);
    }
    catch (error)
    {
        if (error.code === 'ENOENT')
        {
            return [];
        }
        throw error;
    }
}

function waitForFile({
    file,
    phase,
    child,
    intervalMs,
    signal,
    deadlineAt = Number.POSITIVE_INFINITY,
    getChildError = () => null,
    allowExitedChild = false
})
{
    return new Promise((resolve, reject) =>
    {
        let timer = null;
        let settled = false;
        const finish = (callback, value) =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            if (timer !== null)
            {
                clearTimeout(timer);
            }
            signal?.removeEventListener('abort', onAbort);
            callback(value);
        };
        const onAbort = () => finish(reject, new WaitForFileCancellation(phase, signal.reason));
        const inspect = () =>
        {
            if (signal?.aborted)
            {
                onAbort();
                return;
            }
            if (fs.existsSync(file))
            {
                finish(resolve);
                return;
            }
            const childError = getChildError();
            if (childError)
            {
                finish(reject, childError);
                return;
            }
            if (!allowExitedChild && (child.exitCode !== null || child.signalCode !== null))
            {
                finish(
                    reject,
                    new Error(`physical execution systemd supervisor exited before the ${phase} handshake completed`)
                );
                return;
            }
            if (Date.now() >= deadlineAt)
            {
                finish(reject, new Error(`physical execution ${phase} handshake timed out`));
                return;
            }
            timer = setTimeout(
                inspect,
                Math.max(1, Math.min(intervalMs, Number.isFinite(deadlineAt)
                    ? deadlineAt - Date.now()
                    : intervalMs))
            );
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        inspect();
    });
}

function writePrivateJsonFile(controlRoot, name, value, { durable = false } = {})
{
    const file = path.join(controlRoot, name);
    const temporary = `${file}.next-${randomUUID()}`;
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string')
    {
        throw new Error(`physical execution private carrier ${name} is not JSON serializable`);
    }
    const flags = fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
    let descriptor;
    let temporaryCreated = false;
    try
    {
        descriptor = fs.openSync(temporary, flags, 0o600);
        temporaryCreated = true;
        fs.writeFileSync(descriptor, `${serialized}\n`, 'utf8');
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
        {
            throw new Error(`physical execution private carrier ${name} is not a regular 0600 file`);
        }
        if (durable)
        {
            fs.fsyncSync(descriptor);
        }
        // Publish complete bytes without replacing an existing carrier or symlink.
        fs.linkSync(temporary, file);
        fs.unlinkSync(temporary);
        temporaryCreated = false;
        if (durable)
        {
            const directory = fs.openSync(controlRoot, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try
            {
                fs.fsyncSync(directory);
            }
            finally
            {
                fs.closeSync(directory);
            }
        }
    }
    finally
    {
        if (descriptor !== undefined)
        {
            fs.closeSync(descriptor);
        }
        if (temporaryCreated)
        {
            fs.unlinkSync(temporary);
        }
    }
}

/** Prepare exact private files before a nonblocking resident service can open its output. */
export function prepareResidentServiceOutput(controlRoot)
{
    const directory = fs.lstatSync(controlRoot);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()
        || (directory.mode & 0o077) !== 0 || fs.realpathSync(controlRoot) !== controlRoot)
    {
        throw new Error('resident service output requires a literal owned private control root');
    }
    const files = {};
    for (const name of ['stdout', 'stderr'])
    {
        const file = path.join(controlRoot, `${name}.log`);
        const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT |
            fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        try
        {
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
                || stat.nlink !== 1)
            {
                throw new Error(`resident service ${name} output is not an owned private file`);
            }
            fs.fsyncSync(descriptor);
            files[name] = { path: file, device: stat.dev, inode: stat.ino };
        }
        finally
        {
            fs.closeSync(descriptor);
        }
    }
    const descriptor = fs.openSync(controlRoot, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try
    {
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    return Object.freeze({ schema: residentServiceOutputSchema,
        controlRoot: { path: controlRoot, device: directory.dev, inode: directory.ino }, files });
}

function residentOutputFile(carrier)
{
    const stat = fs.lstatSync(carrier.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o777) !== 0o600 || stat.dev !== carrier.device || stat.ino !== carrier.inode
        || fs.realpathSync(carrier.path) !== carrier.path)
    {
        throw new Error('resident service output carrier identity changed');
    }
    return stat;
}

function residentOutputDigest(carrier)
{
    const descriptor = fs.openSync(carrier.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try
    {
        const before = fs.fstatSync(descriptor);
        if (before.dev !== carrier.device || before.ino !== carrier.inode || before.nlink !== 1
            || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600)
        {
            throw new Error('resident service output descriptor identity changed');
        }
        const digest = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let bytes = 0;
        let read;
        while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
        {
            bytes += read;
            digest.update(buffer.subarray(0, read));
        }
        const after = fs.fstatSync(descriptor);
        if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
            || after.ctimeMs !== before.ctimeMs)
        {
            throw new Error('resident service output changed during digest read-back');
        }
        return { path: carrier.path, device: carrier.device, inode: carrier.inode,
            byteCount: bytes, digest: `sha256:${digest.digest('hex')}` };
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function assertResidentOutputWritersAbsent(carriers, members, supervisorPid)
{
    const identities = Object.values(carriers.files).map((file) => `${file.device}:${file.inode}`);
    for (const pid of members)
    {
        if (!Number.isSafeInteger(pid) || pid <= 0)
        {
            throw new Error('resident service output member identity is invalid');
        }
        if (pid === supervisorPid)
        {
            continue;
        }
        const directory = `/proc/${pid}/fd`;
        for (const entry of fs.readdirSync(directory))
        {
            const stat = fs.statSync(path.join(directory, entry));
            if (identities.includes(`${stat.dev}:${stat.ino}`))
            {
                throw new Error(`resident service member ${pid} retains the producer output descriptor`);
            }
        }
    }
}

/** Capture a stable prefix; the live service and final output read-back remain with the caller's owner. */
export async function captureResidentServiceOutput(carriers, {
    readMembers,
    supervisorPid,
    outputTracker
})
{
    const directory = fs.lstatSync(carriers?.controlRoot?.path);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()
        || directory.dev !== carriers.controlRoot.device || directory.ino !== carriers.controlRoot.inode
        || (directory.mode & 0o077) !== 0 || fs.realpathSync(carriers.controlRoot.path) !== carriers.controlRoot.path
        || typeof readMembers !== 'function'
        || (supervisorPid !== null && (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 0))
        || typeof outputTracker?.attach !== 'function' || typeof outputTracker.close !== 'function')
    {
        throw new Error('resident service output capture authority is incomplete');
    }
    const beforeMembers = readMembers();
    if (!Array.isArray(beforeMembers) || (supervisorPid === null
        ? beforeMembers.length !== 0 : !beforeMembers.includes(supervisorPid)))
    {
        throw new Error('resident service output capture lacks its exact live supervisor');
    }
    assertResidentOutputWritersAbsent(carriers, beforeMembers, supervisorPid);
    const before = Object.fromEntries(Object.entries(carriers.files).map(([name, carrier]) =>
        [name, residentOutputFile(carrier)]));
    for (const name of ['stdout', 'stderr'])
    {
        outputTracker.attach(fs.createReadStream(carriers.files[name].path, {
            flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
        }), name);
    }
    const output = await outputTracker.close();
    const afterMembers = readMembers();
    if (!output.logComplete || JSON.stringify(afterMembers) !== JSON.stringify(beforeMembers))
    {
        throw new Error('resident service output capture or member roster changed');
    }
    assertResidentOutputWritersAbsent(carriers, afterMembers, supervisorPid);
    const outputFiles = {};
    for (const name of ['stdout', 'stderr'])
    {
        const after = residentOutputFile(carriers.files[name]);
        if (after.size !== before[name].size || after.mtimeMs !== before[name].mtimeMs
            || after.ctimeMs !== before[name].ctimeMs)
        {
            throw new Error(`resident service ${name} output changed during capture`);
        }
        outputFiles[name] = residentOutputDigest(carriers.files[name]);
    }
    if (JSON.stringify(readMembers()) !== JSON.stringify(beforeMembers))
    {
        throw new Error('resident service output member roster changed after digest read-back');
    }
    return { ...output, outputFiles };
}

function createControlRoot({ env, linuxReadWritePaths })
{
    const configured = String(env.FSUSBLOG_TOOL_CACHE ?? '').trim();
    if (linuxReadWritePaths.length === 0)
    {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-physical-systemd-'));
    }
    if (!configured)
    {
        throw new Error(
            'physical execution systemd control carrier requires the declared tool-cache root'
        );
    }

    const toolCache = path.resolve(configured);
    let realToolCache;
    try
    {
        realToolCache = fs.realpathSync(toolCache);
    }
    catch (error)
    {
        throw new Error(
            'physical execution systemd control carrier must use an existing declared tool-cache root',
            { cause: error }
        );
    }
    if (!linuxReadWritePaths.includes(realToolCache))
    {
        throw new Error(
            'physical execution systemd control carrier is not included in declared read-write paths'
        );
    }
    return fs.mkdtempSync(path.join(realToolCache, 'physical-systemd-'));
}

async function observeStableEmpty({
    unitName,
    controlGroup,
    supervisorPid,
    inventory,
    policy,
    deadlineAt,
    runSystemctl,
    readCgroupMemberPids,
    readProcessIdentity
})
{
    let zeroObservations = 0;
    while (Date.now() <= deadlineAt)
    {
        const properties = unitProperties(unitName, runSystemctl);
        const pids = readCgroupMemberPids(controlGroup).filter((pid) => pid !== supervisorPid);
        for (const pid of pids)
        {
            const identity = readProcessIdentity(pid);
            if (identity.status !== 'verified')
            {
                throw new Error(`physical execution cgroup member ${pid} identity is unverifiable: ${identity.reason}`);
            }
            inventory.set(`${pid}:${identity.processStartIdentity}`, identity);
        }
        const inactive = properties.status === 'verified' &&
      ['inactive', 'failed'].includes(properties.values.ActiveState);
        if (pids.length === 0 && (inactive || properties.values?.LoadState === 'not-found'))
        {
            zeroObservations += 1;
            if (zeroObservations >= policy.zeroMemberObservations)
            {
                return true;
            }
        }
        else
        {
            zeroObservations = 0;
        }
        await delay(policy.observationIntervalMs);
    }
    return false;
}

export function createPhysicalExecutionLinuxSystemdAdapter({
    spawnProcess = spawn,
    runSystemctl = systemctl,
    readCgroupMemberPids = cgroupMemberPids,
    readProcessIdentity = collectProcessIdentity,
    readProcessGroupIdentity = (pid) =>
        collectProcessGroupOrJobIdentity(pid, { platform: 'linux' }),
    readExecutableSnapshot = executableSnapshot,
    resolvePython = (environment) => resolveExecutablePath(environment.FSUSBLOG_PYTHON ?? 'python3', {
        pathValue: environment.PATH
    }),
    removeControlRoot = (controlRoot) => fs.rmSync(controlRoot, { recursive: true, force: true }),
    handshakeTimeoutMs = 10_000
} = {})
{
    if (!Number.isInteger(handshakeTimeoutMs) || handshakeTimeoutMs <= 0)
    {
        throw new Error('physical execution systemd handshake timeout must be a positive integer');
    }
    return {
        async run({
            command,
            cwd,
            env,
            controlEnv = process.env,
            linuxPrivateNetwork = false,
            linuxNetworkPolicy = null,
            linuxReadWritePaths = [],
            privateDotnetScratch = null,
            signal,
            policy,
            stdout,
            stderr,
            schema,
            outputTracker = null,
            resourceBoundary = null,
            resourceContext = null,
            processOwner = null,
            residentServiceOutput = false
        })
        {
            requireSystemdAuthority(runSystemctl);
            if (resourceBoundary === null && resourceContext !== null)
            {
                throw new Error('systemd resource execution context requires its live boundary capability');
            }
            if (processOwner !== null && (resourceBoundary === null
                || typeof processOwner.retain !== 'function' || typeof processOwner.beforeCreation !== 'function'
                || typeof processOwner.register !== 'function'
                || !Number.isSafeInteger(processOwner.commandBudgetMs) || processOwner.commandBudgetMs <= 0))
            {
                throw new Error('systemd service process owner requires resource admission, retention, registration and an explicit budget');
            }
            if (residentServiceOutput && (processOwner === null || resourceBoundary === null))
            {
                throw new Error('resident service output requires its original durable process and resource owners');
            }
            const authorityId = randomUUID();
            const { privateKey, publicKey } = generateKeyPairSync('ed25519');
            let python;
            const unitName = `fsusblog-physical-${authorityId.replaceAll('-', '')}`;
            // A serialized report or a slice name cannot replace the original owner's live capability.
            const resourceAdmission = resourceBoundary === null ? null : prepareProductionSystemdServiceAdmission(
                resourceBoundary, { unitName: `${unitName}.service`, authorityId, expectedContext: resourceContext }
            );
            if (resourceAdmission)
            {
                const literalCwd = path.resolve(cwd);
                if (fs.realpathSync(literalCwd) !== literalCwd)
                {
                    throw new Error('systemd resource service requires a literal working directory');
                }
                const relative = path.relative(resourceContext.root, literalCwd);
                if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
                {
                    throw new Error('systemd resource service working directory escapes its bound repository');
                }
                cwd = literalCwd;
            }
            const hostMountNamespace = privateDotnetScratch
                ? fs.readlinkSync('/proc/self/ns/mnt') : null;
            const hostTmpIdentity = privateDotnetScratch ? tmpIdentity('/tmp') : null;
            const controlRoot = createControlRoot({
                env,
                linuxReadWritePaths
            });
            let residentOutput = null;
            try
            {
                residentOutput = residentServiceOutput ? prepareResidentServiceOutput(controlRoot) : null;
            }
            catch (error)
            {
                removeControlRoot(controlRoot);
                throw error;
            }
            const readyFile = path.join(controlRoot, 'ready');
            const startFile = path.join(controlRoot, 'start');
            const childFile = path.join(controlRoot, 'child.json');
            const resultFile = path.join(controlRoot, 'result.json');
            const finalizeFile = path.join(controlRoot, 'finalize');
            let containmentAuthority = null;
            let privateDotnetScratchReceipt = null;
            let privateTmpMountNamespace = null;
            const removeUnestablishedRoot = (primaryError) =>
            {
                try
                {
                    removeControlRoot(controlRoot);
                }
                catch (removeError)
                {
                    primaryError.physicalExecutionFinalizeError = {
                        name: removeError.name,
                        message: `control root removal failed: ${removeError.message}`,
                        cleanup: {
                            status: 'unverifiable',
                            reason: `control root removal failed: ${removeError.message}`,
                            authorityEstablished: false,
                            knownRuntimeResiduals: [],
                            controlRoot
                        }
                    };
                }
            };
            try
            {
                if (privateDotnetScratch)
                {
                    if (linuxReadWritePaths.length === 0)
                    {
                        throw new Error('private .NET scratch requires protected filesystem execution');
                    }
                    verifyPrivateDotnetScratchBinding(privateDotnetScratch, {
                        environment: env, cwd, controlRoot
                    });
                }
                writePrivateJsonFile(controlRoot, 'command.json', command);
                writePrivateJsonFile(controlRoot, 'environment.json', env);
                python = resolvePython(controlEnv);
                writePrivateJsonFile(controlRoot, 'admission.json', {
                    authorityId,
                    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
                    python,
                    privateDotnetScratch: privateDotnetScratch
                        ? { ...privateDotnetScratch, unitName, hostMountNamespace, hostTmpIdentity }
                        : null
                });
                if (resourceAdmission)
                {
                    if (processOwner)
                    {
                        const stat = fs.lstatSync(controlRoot);
                        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
                            || (stat.mode & 0o077) !== 0 || fs.realpathSync(controlRoot) !== controlRoot)
                        {
                            throw new Error('systemd process intent requires its exact private control carrier');
                        }
                        containmentAuthority = freezeDeep({ schema: resourceServiceContainmentSchema,
                            platform: 'linux', kind: 'systemd-resource-service', authorityId, killPolicy: 'control-group',
                            phase: 'prepared', createdAt: new Date().toISOString(), serviceBinding: resourceAdmission.serviceBinding,
                            commandBudgetMs: processOwner.commandBudgetMs,
                            nestedChannel: processOwner.nestedChannel ?? null,
                            controlRoot: { path: controlRoot, device: stat.dev, inode: stat.ino },
                            supervisorProcessIdentity: null, creationSender: null,
                            ...(residentOutput ? { residentOutput } : {}) });
                        if (!resourceServiceContainmentIsComplete(containmentAuthority))
                        {
                            throw new Error('systemd process creation intent is incomplete');
                        }
                    }
                    writePrivateJsonFile(controlRoot, 'resource-boundary.json', {
                        authorityId,
                        unitName: resourceAdmission.unitName,
                        sliceUnitName: resourceAdmission.sliceUnitName,
                        description: resourceAdmission.description,
                        reference: resourceAdmission.reference,
                        containmentAuthority
                    }, { durable: true });
                    if (processOwner)
                    {
                        const acknowledgement = await processOwner.retain(containmentAuthority);
                        if (acknowledgement?.authorityDigest !== digestCanonical(containmentAuthority))
                        {
                            throw new Error('systemd process intent lacks exact independent durable acknowledgement');
                        }
                        if (signal?.aborted)
                        {
                            throw new WaitForFileCancellation('process-intent', signal.reason);
                        }
                    }
                }
            }
            catch (error)
            {
                removeUnestablishedRoot(error);
                throw error;
            }
            const systemdArgs = [
                '--user',
                '--quiet',
                ...(residentOutput ? ['--no-block'] : ['--wait', '--pipe']),
                '--collect',
                '--service-type=exec',
                '--property=KillMode=control-group',
                '--property=ExitType=cgroup',
                ...(resourceAdmission ? [
                    `--property=Slice=${resourceAdmission.sliceUnitName}`,
                    `--property=Description=${resourceAdmission.description}`
                ] : []),
                ...(residentOutput ? [
                    `--property=StandardOutput=append:${residentOutput.files.stdout.path}`,
                    `--property=StandardError=append:${residentOutput.files.stderr.path}`
                ] : []),
                ...(linuxPrivateNetwork ? ['--property=PrivateNetwork=yes'] : []),
                ...(linuxNetworkPolicy ? [
                    `--property=IPAddressDeny=${linuxNetworkPolicy.deny}`,
                    `--property=IPAddressAllow=${linuxNetworkPolicy.allow}`
                ] : []),
                ...(linuxReadWritePaths.length > 0 ? [
                    '--property=ProtectSystem=strict',
                    '--property=ProtectHome=read-only',
                    '--property=PrivateTmp=yes',
                    ...linuxReadWritePaths.map((entry) => `--property=ReadWritePaths=${entry}`)
                ] : []),
                `--working-directory=${cwd}`,
                `--unit=${unitName}`,
                process.execPath,
                bootstrap,
                controlRoot
            ];
            let child;
            let gatedSender = null;
            try
            {
                if (processOwner)
                {
                    if (signal?.aborted)
                    {
                        throw new WaitForFileCancellation('service-creation-attempt', signal.reason);
                    }
                    const senderPlan = { authorityId, args: systemdArgs, cwd };
                    writePrivateJsonFile(controlRoot, 'sender-plan.json', senderPlan, { durable: true });
                    gatedSender = spawnProcess(process.execPath, [senderBootstrap, controlRoot], {
                        cwd, env: controlEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
                    });
                    const ready = await new Promise((resolve, reject) =>
                    {
                        const timer = setTimeout(() => finish(reject,
                            new Error('systemd creation sender readiness timed out')), handshakeTimeoutMs);
                        const finish = (settle, value) =>
                        {
                            clearTimeout(timer);
                            gatedSender.off('message', onMessage);
                            gatedSender.off('error', onError);
                            gatedSender.off('exit', onExit);
                            settle(value);
                        };
                        const onMessage = (message) => finish(resolve, message);
                        const onError = (error) => finish(reject, error);
                        const onExit = (code, childSignal) => finish(reject,
                            new Error(`systemd creation sender exited before readiness: ${code ?? childSignal}`));
                        gatedSender.once('message', onMessage);
                        gatedSender.once('error', onError);
                        gatedSender.once('exit', onExit);
                    });
                    if (!systemdSenderReadyIsComplete(ready)
                        || ready.authorityId !== authorityId
                        || ready.planDigest !== digestCanonical(senderPlan)
                        || ready.processIdentity.pid !== gatedSender.pid
                        || digestCanonical(readProcessIdentity(gatedSender.pid)) !== digestCanonical(ready.processIdentity))
                    {
                        throw new Error('systemd creation sender readiness differs from its exact live process and plan');
                    }
                    const acknowledgement = await processOwner.beforeCreation(containmentAuthority, ready);
                    const attempted = { ...containmentAuthority, phase: 'create-attempted', creationSender: ready };
                    if (acknowledgement?.authorityDigest !== digestCanonical(attempted))
                    {
                        throw new Error('systemd service creation attempt lacks exact independent durable acknowledgement');
                    }
                    containmentAuthority = freezeDeep(attempted);
                    if (signal?.aborted)
                    {
                        throw new WaitForFileCancellation('service-creation-attempt', signal.reason);
                    }
                    child = gatedSender;
                    await new Promise((resolve, reject) =>
                    {
                        child.send({ type: 'release', authorityId, planDigest: ready.planDigest }, (error) =>
                        {
                            if (error)
                            {
                                reject(error);
                            }
                            else
                            {
                                resolve();
                            }
                        });
                    });
                }
                else
                {
                    child = spawnProcess('systemd-run', systemdArgs, {
                        cwd, env: controlEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
                    });
                }
            }
            catch (error)
            {
                if (gatedSender?.connected)
                {
                    gatedSender.disconnect();
                }
                if (!gatedSender && containmentAuthority?.phase !== 'create-attempted')
                {
                    removeUnestablishedRoot(error);
                }
                throw error;
            }
            let childError = null;
            let systemdRunSpawnError = null;
            child.once('error', (error) =>
            {
                systemdRunSpawnError = error;
                childError = error;
            });
            const executionOutput = outputTracker ??
                createPhysicalExecutionOutputTracker({ policy, stdout, stderr });
            const senderDiagnostics = { stdout: '', stderr: '', truncated: false };
            if (residentOutput)
            {
                for (const name of ['stdout', 'stderr'])
                {
                    child[name].on('error', () => senderDiagnostics.truncated = true);
                    child[name].on('data', (chunk) =>
                    {
                        const remaining = Math.max(0, 64 * 1024 - Buffer.byteLength(senderDiagnostics[name]));
                        senderDiagnostics[name] += chunk.subarray(0, remaining).toString('utf8');
                        senderDiagnostics.truncated ||= chunk.length > remaining;
                    });
                    child[name].resume();
                }
            }
            else
            {
                executionOutput.attach(child.stdout, 'stdout');
                executionOutput.attach(child.stderr, 'stderr');
            }
            const inventory = new Map();
            const lifecycle = ['created'];
            const termination = [];
            const cleanupCommands = [];
            let properties;
            let supervisorPid;
            let controlGroup;
            let commandPid;
            let commandProcessGroup = null;
            let executionAdmission = null;
            let resourceExecutionAdmission = null;
            let authorityEstablished = false;
            let first;
            let outputEvidence = null;
            let residentTransferred = false;
            const childTerminal = new Promise((resolve) =>
            {
                if (child.exitCode !== null || child.signalCode !== null)
                {
                    resolve({ exitCode: child.exitCode, signal: child.signalCode });
                    return;
                }
                child.once('error', (error) => resolve({ exitCode: null, signal: null, error }));
                child.once('exit', (exitCode, childSignal) => resolve({ exitCode, signal: childSignal }));
            });
            const senderClosed = residentOutput ? new Promise((resolve) =>
            {
                if (child.exitCode !== null && child.stdout.destroyed && child.stderr.destroyed)
                {
                    resolve(true);
                }
                else
                {
                    child.once('close', () => resolve(true));
                }
            }) : null;
            const creationError = () => childError ?? (residentOutput && (child.exitCode !== null && child.exitCode !== 0
                || child.signalCode !== null)
                ? new Error(`nonblocking systemd sender failed before service handshake: ${child.exitCode ?? child.signalCode}`)
                : null);
            const verifyResidentSenderTerminal = async () =>
            {
                const sender = containmentAuthority?.creationSender;
                if (!await Promise.race([senderClosed, delay(policy.pipeCloseTimeoutMs).then(() => false)]))
                {
                    throw new Error('nonblocking systemd sender output did not close before the deadline');
                }
                const senderPlan = JSON.parse(fs.readFileSync(path.join(controlRoot, 'sender-plan.json'), 'utf8'));
                const senderReceipt = JSON.parse(fs.readFileSync(path.join(controlRoot, 'sender-terminal.json'), 'utf8'));
                if (!sender || digestCanonical(senderPlan) !== sender.planDigest
                    || !verifySystemdSenderTerminal(senderReceipt, sender)
                    || senderReceipt.submission !== 'sender-returned' || senderReceipt.exitCode !== 0
                    || senderReceipt.signal !== null || senderReceipt.errorCode !== null
                    || processIdentityStatus(sender.processIdentity).status !== 'dead'
                    || senderDiagnostics.stdout !== '' || senderDiagnostics.stderr !== ''
                    || senderDiagnostics.truncated)
                {
                    throw new Error('nonblocking systemd sender terminal or diagnostics are unverifiable');
                }
            };
            const runCleanupCommand = (args) =>
            {
                let result;
                try
                {
                    if (resourceAdmission && ['kill', 'stop'].includes(args[0]))
                    {
                        // Process ownership still owns termination; never touch a replaced or unknown service.
                        resourceAdmission.assertOwnedOrAbsent();
                    }
                    result = runSystemctl(args);
                }
                catch (error)
                {
                    result = { status: null, stdout: '', stderr: '', error };
                }
                cleanupCommands.push(commandResultEvidence(args, result));
                return result;
            };
            const waitForChildTerminal = async (milliseconds) =>
            {
                const timeout = Symbol('child-terminal-timeout');
                const terminal = await Promise.race([
                    childTerminal,
                    delay(Math.max(1, milliseconds)).then(() => timeout)
                ]);
                return terminal === timeout ? null : terminal;
            };
            const terminate = async (reason) =>
            {
                lifecycle.push('mark-cancelling', 'stop-new-spawns', 'forward-graceful-signal');
                for (const pid of readCgroupMemberPids(controlGroup))
                {
                    const identity = readProcessIdentity(pid);
                    if (identity.status !== 'verified')
                    {
                        throw new Error(`physical execution cgroup member ${pid} identity is unverifiable: ${identity.reason}`);
                    }
                    inventory.set(`${pid}:${identity.processStartIdentity}`, identity);
                }
                const graceful = runCleanupCommand([
                    'kill',
                    '--kill-who=all',
                    '--signal=SIGTERM',
                    unitName
                ]);
                termination.push({
                    phase: 'graceful',
                    signal: 'SIGTERM',
                    reason,
                    command: commandResultEvidence(
                        ['kill', '--kill-who=all', '--signal=SIGTERM', unitName],
                        graceful
                    ),
                    observedAt: new Date().toISOString()
                });
                lifecycle.push('wait-grace-period');
                if (!await observeStableEmpty({
                    unitName,
                    controlGroup,
                    supervisorPid,
                    inventory,
                    policy,
                    deadlineAt: Date.now() + policy.gracefulTerminationMs,
                    runSystemctl,
                    readCgroupMemberPids,
                    readProcessIdentity
                }))
                {
                    lifecycle.push('force-kill-remaining-tree');
                    const forcedArgs = ['kill', '--kill-who=all', '--signal=SIGKILL', unitName];
                    const forced = runCleanupCommand(forcedArgs);
                    const stopArgs = ['stop', unitName];
                    const stop = runCleanupCommand(stopArgs);
                    termination.push({
                        phase: 'forced',
                        signal: 'SIGKILL',
                        reason,
                        command: commandResultEvidence(forcedArgs, forced),
                        stopCommand: commandResultEvidence(stopArgs, stop),
                        observedAt: new Date().toISOString()
                    });
                }
                return await observeStableEmpty({
                    unitName,
                    controlGroup,
                    supervisorPid,
                    inventory,
                    policy,
                    deadlineAt: Date.now() + policy.forceTerminationMs,
                    runSystemctl,
                    readCgroupMemberPids,
                    readProcessIdentity
                });
            };
            const finalizeSupervisor = async () =>
            {
                let finalizeCarrierError = null;
                try
                {
                    if (!fs.existsSync(finalizeFile))
                    {
                        fs.writeFileSync(finalizeFile, 'finalize\n', {
                            flag: fs.constants.O_WRONLY |
                fs.constants.O_CREAT |
                fs.constants.O_EXCL |
                (fs.constants.O_NOFOLLOW ?? 0),
                            mode: 0o600
                        });
                    }
                }
                catch (error)
                {
                    finalizeCarrierError = error;
                }

                const stopArgs = ['stop', unitName];
                let terminal = fs.existsSync(resultFile)
                    ? await waitForChildTerminal(policy.forceTerminationMs)
                    : null;
                if (!terminal)
                {
                    runCleanupCommand(stopArgs);
                    terminal = await waitForChildTerminal(policy.forceTerminationMs);
                }
                if (!terminal)
                {
                    try
                    {
                        child.kill?.('SIGKILL');
                    }
                    catch (error)
                    {
                        cleanupCommands.push(commandResultEvidence(
                            ['local-child-kill', 'SIGKILL'],
                            { status: null, error }
                        ));
                    }
                    terminal = await waitForChildTerminal(Math.max(
                        policy.observationIntervalMs * 2,
                        Math.min(policy.forceTerminationMs, 250)
                    ));
                }
                runCleanupCommand(stopArgs);
                const resetArgs = ['reset-failed', unitName];
                runCleanupCommand(resetArgs);
                if (!residentOutput)
                {
                    lifecycle.push('bounded-pipe-close');
                    outputEvidence = await executionOutput.close();
                }

                let zeroObservations = 0;
                let lastProperties = null;
                let lastMembers = null;
                let finalObservationError = null;
                let observedEstablishedAuthority = false;
                const deadlineAt = Date.now() + policy.forceTerminationMs;
                while (Date.now() <= deadlineAt)
                {
                    lastProperties = unitProperties(unitName, runSystemctl);
                    if (lastProperties.command)
                    {
                        cleanupCommands.push(lastProperties.command);
                    }
                    if (
                        lastProperties.status === 'verified' &&
            lastProperties.values.LoadState !== 'not-found' &&
            lastProperties.values.ControlGroup
                    )
                    {
                        observedEstablishedAuthority = true;
                    }
                    if (lastProperties.status === 'verified' && !controlGroup)
                    {
                        controlGroup = lastProperties.values.ControlGroup || null;
                    }
                    const exactNotFound = lastProperties.status === 'verified' &&
            lastProperties.values.LoadState === 'not-found';
                    try
                    {
                        lastMembers = controlGroup ? readCgroupMemberPids(controlGroup) : [];
                    }
                    catch (error)
                    {
                        finalObservationError = error;
                        break;
                    }
                    const completeCgroupEmpty = controlGroup
                        ? lastMembers.length === 0
                        : exactNotFound;
                    if (terminal && !terminal.error && exactNotFound && completeCgroupEmpty)
                    {
                        zeroObservations += 1;
                        if (zeroObservations >= policy.zeroMemberObservations)
                        {
                            return {
                                status: 'verified',
                                childTerminal: terminal,
                                unit: lastProperties.values,
                                cgroupMembers: lastMembers,
                                authorityEstablished: observedEstablishedAuthority,
                                commands: cleanupCommands
                            };
                        }
                    }
                    else
                    {
                        zeroObservations = 0;
                    }
                    await delay(policy.observationIntervalMs);
                }
                return {
                    status: 'unverifiable',
                    reason: finalizeCarrierError
                        ? `finalize carrier failed: ${finalizeCarrierError.message}`
                        : finalObservationError
              ? `final cgroup observation failed: ${finalObservationError.message}`
            : !terminal
              ? 'systemd-run supervisor did not become terminal before the cleanup deadline'
              : terminal.error
                ? `systemd-run supervisor failed: ${terminal.error.message}`
                : lastProperties?.status !== 'verified'
                  ? `exact unit state is unverifiable: ${lastProperties?.reason || 'unknown systemctl failure'}`
                  : lastProperties.values.LoadState !== 'not-found'
                    ? `unit remained loaded with LoadState=${lastProperties.values.LoadState}`
                    : `cgroup retained members: ${JSON.stringify(lastMembers)}`,
                    childTerminal: terminal,
                    unit: lastProperties?.values ?? null,
                    cgroupMembers: lastMembers,
                    authorityEstablished: observedEstablishedAuthority,
                    commands: cleanupCommands
                };
            };
            let primaryError = null;
            let cleanup;
            try
            {
                await waitForFile({
                    file: readyFile,
                    phase: 'ready',
                    child,
                    intervalMs: policy.observationIntervalMs,
                    signal,
                    deadlineAt: Date.now() + handshakeTimeoutMs,
                    getChildError: creationError,
                    allowExitedChild: residentOutput !== null
                });
                properties = unitProperties(unitName, runSystemctl);
                if (properties.status !== 'verified' || !properties.values.ControlGroup)
                {
                    throw new Error(
                        `physical execution systemd authority is unverifiable: ${
                            properties.reason ?? `missing cgroup ${JSON.stringify(properties.values)}`
                        }`
                    );
                }
                if (linuxPrivateNetwork && properties.values.PrivateNetwork !== 'yes')
                {
                    throw new Error('physical execution systemd private network authority is unverifiable');
                }
                if (linuxNetworkPolicy
                    && (!exactPropertyTokens(
                        properties.values.IPAddressDeny,
                        ['0.0.0.0/0', '::/0']
                    )
                        || !exactPropertyTokens(
                            properties.values.IPAddressAllow,
                            ['127.0.0.0/8', '::1/128']
                        )))
                {
                    throw new Error('physical execution systemd IP address policy authority is unverifiable');
                }
                if (linuxReadWritePaths.length > 0
                    && (properties.values.ProtectSystem !== 'strict'
                        || properties.values.ProtectHome !== 'read-only'
                        || properties.values.PrivateTmp !== 'yes'))
                {
                    throw new Error('physical execution systemd filesystem authority is unverifiable');
                }
                authorityEstablished = true;
                supervisorPid = Number(fs.readFileSync(readyFile, 'utf8').trim());
                controlGroup = properties.values.ControlGroup;
                if (privateDotnetScratch)
                {
                    privateTmpMountNamespace = fs.readlinkSync(`/proc/${supervisorPid}/ns/mnt`);
                    verifyPrivateTmpNamespace({
                        hostNamespace: hostMountNamespace,
                        unitNamespace: privateTmpMountNamespace,
                        hostTmpIdentity,
                        unitTmpIdentity: tmpIdentity(`/proc/${supervisorPid}/root/tmp`),
                        privateTmp: properties.values.PrivateTmp
                    });
                }
                const supervisorIdentity = readProcessIdentity(supervisorPid);
                if (supervisorIdentity.status !== 'verified')
                {
                    throw new Error(`physical execution supervisor identity is unverifiable: ${supervisorIdentity.reason}`);
                }
                inventory.set(`${supervisorPid}:${supervisorIdentity.processStartIdentity}`, supervisorIdentity);
                fs.writeFileSync(startFile, 'start\n', { mode: 0o600 });
                await waitForFile({
                    file: childFile,
                    phase: 'child',
                    child,
                    intervalMs: policy.observationIntervalMs,
                    signal,
                    deadlineAt: Date.now() + handshakeTimeoutMs,
                    getChildError: creationError,
                    allowExitedChild: residentOutput !== null
                });
                const registrationBytes = fs.readFileSync(childFile, 'utf8').trim();
                const childRegistration = JSON.parse(registrationBytes);
                if (childRegistration.spawnError)
                {
                    const spawnError = new Error(
                        `command spawn failed: ${childRegistration.spawnError.message}`
                    );
                    spawnError.name = childRegistration.spawnError.name ?? 'Error';
                    spawnError.code = childRegistration.spawnError.code ?? null;
                    throw spawnError;
                }
                commandPid = Number(childRegistration.pid);
                if (childRegistration.authorityId !== authorityId
                    || !/^[a-f0-9]{64}$/u.test(childRegistration.nonce)
                    || JSON.stringify(childRegistration.command) !== JSON.stringify(command)
                    || childRegistration.environmentDigest !== `sha256:${createHash('sha256').update(JSON.stringify(env)).digest('hex')}`
                    || !Array.isArray(childRegistration.executables))
                {
                    throw new Error('physical execution pre-exec command admission is invalid');
                }
                const commandIdentity = readProcessIdentity(commandPid);
                if (commandIdentity.status !== 'verified')
                {
                    throw new Error(`physical execution command identity is unverifiable: ${commandIdentity.reason}`);
                }
                const processGroupIdentity = readProcessGroupIdentity(commandPid);
                if (processGroupIdentity.status !== 'verified'
                    || processGroupIdentity.value?.kind !== 'process-group'
                    || processGroupIdentity.value.groupId !== commandPid)
                {
                    throw new Error(
                        'physical execution command did not become its run-owned process-group leader'
                    );
                }
                commandProcessGroup = processGroupIdentity.value;
                if (commandProcessGroup.leaderProcessStartIdentity !== commandIdentity.processStartIdentity
                    || childRegistration.startIdentity !== commandIdentity.processStartIdentity
                    || childRegistration.processGroup !== commandPid
                    || childRegistration.cgroup !== `0::${controlGroup}\n`
                    || !readCgroupMemberPids(controlGroup).includes(commandPid))
                {
                    throw new Error('physical execution pre-exec containment admission is invalid');
                }
                inventory.set(`${commandPid}:${commandIdentity.processStartIdentity}`, {
                    ...commandIdentity,
                    observationPhase: 'pre-exec'
                });
                if (commandIdentity.executablePath !== fs.realpathSync(python)
                    || commandIdentity.commandDigest !== `sha256:${createHash('sha256').update([
                        python,
                        '-I',
                        '-S',
                        path.join(path.dirname(bootstrap), 'physical-execution-linux-preexec.py')
                    ].join('\0')).digest('hex')}`
                    || JSON.stringify(childRegistration.executables) !== JSON.stringify(readExecutableSnapshot(command, env, cwd)))
                {
                    throw new Error('physical execution pre-exec executable admission is invalid');
                }
                if (signal?.aborted)
                {
                    throw new WaitForFileCancellation('admission', signal.reason);
                }
                if (resourceAdmission)
                {
                    resourceExecutionAdmission = resourceAdmission.admit(commandIdentity, controlGroup);
                    if (processOwner)
                    {
                        containmentAuthority = freezeDeep({ ...containmentAuthority, phase: 'pre-exec',
                            serviceBinding: resourceExecutionAdmission.serviceBinding, supervisorProcessIdentity: commandIdentity });
                        const registered = await processOwner.register(commandIdentity, containmentAuthority);
                        const retained = registered?.owner?.managedContainmentAuthorities?.find((entry) => entry.authorityId === authorityId);
                        if (!retained || digestCanonical(retained) !== digestCanonical(containmentAuthority))
                        {
                            throw new Error('systemd process pre-exec registration lacks its exact independent durable receipt');
                        }
                        resourceExecutionAdmission = resourceAdmission.revalidate();
                    }
                    writePrivateJsonFile(controlRoot, 'resource-admitted.json', resourceExecutionAdmission, { durable: true });
                    if (signal?.aborted)
                    {
                        throw new WaitForFileCancellation('resource-admission', signal.reason);
                    }
                }
                executionAdmission = {
                    phase: 'pre-exec',
                    pid: commandPid,
                    startIdentity: commandIdentity.processStartIdentity,
                    commandDigest: `sha256:${createHash('sha256').update(JSON.stringify(command)).digest('hex')}`,
                    environmentDigest: childRegistration.environmentDigest,
                    executableCandidates: childRegistration.executables,
                    executedImageObservation: 'not-observed'
                };
                writePrivateJsonFile(controlRoot, 'release.json', {
                    registration: registrationBytes,
                    signature: sign(null, Buffer.from(registrationBytes), privateKey).toString('base64')
                });
                lifecycle.push('running');
                const resultPromise = waitForFile({
                    file: resultFile,
                    phase: 'result',
                    child,
                    intervalMs: policy.observationIntervalMs,
                    signal,
                    getChildError: creationError,
                    allowExitedChild: residentOutput !== null
                })
                    .then(() => ({ kind: 'result', value: JSON.parse(fs.readFileSync(resultFile, 'utf8')) }))
                    .catch((error) =>
                    {
                        if (error instanceof WaitForFileCancellation)
                        {
                            return { kind: 'cancel', primaryError: cancellationPrimary(error.reason) };
                        }
                        throw error;
                    });
                first = await resultPromise;
                if (first.kind === 'cancel')
                {
                    primaryError = first.primaryError;
                    let contained = false;
                    try
                    {
                        contained = await terminate('cancel');
                    }
                    catch (error)
                    {
                        primaryError.physicalExecutionContainmentError = {
                            name: error.name,
                            message: error.message
                        };
                    }
                    if (!contained && !primaryError.physicalExecutionContainmentError)
                    {
                        primaryError.physicalExecutionContainmentError = {
                            name: 'Error',
                            message: 'physical execution cgroup remained nonempty after termination escalation'
                        };
                    }
                }
                else
                {
                    if (first.value.spawnError)
                    {
                        primaryError = Object.assign(new Error(`command spawn failed: ${first.value.spawnError.message}`), {
                            name: first.value.spawnError.name,
                            code: first.value.spawnError.code
                        });
                    }
                    else if (first.value.exitCode !== 0 || first.value.signal)
                    {
                        primaryError = Object.assign(
                            new Error(`command failed (${first.value.signal ? `signal ${first.value.signal}` : `exit ${first.value.exitCode}`}): ${command.join(' ')}`),
                            { exitCode: first.value.exitCode, signal: first.value.signal }
                        );
                    }
                    const members = readCgroupMemberPids(controlGroup)
                        .filter((pid) => pid !== supervisorPid && pid !== commandPid);
                    if (members.length > 0)
                    {
                        if (!primaryError && residentOutput && typeof processOwner?.transfer === 'function')
                        {
                            try
                            {
                                await verifyResidentSenderTerminal();
                                outputEvidence = await captureResidentServiceOutput(residentOutput, {
                                    readMembers: () => readCgroupMemberPids(controlGroup),
                                    supervisorPid, outputTracker: executionOutput
                                });
                                const memberPids = readCgroupMemberPids(controlGroup).sort((left, right) => left - right);
                                const memberIdentities = memberPids.map((pid) =>
                                {
                                    const identity = readProcessIdentity(pid);
                                    if (identity.status !== 'verified')
                                    {
                                        throw new Error(`resident service member ${pid} identity is unverifiable`);
                                    }
                                    return identity;
                                });
                                if (!memberPids.includes(supervisorPid)
                                    || JSON.stringify(readCgroupMemberPids(controlGroup).sort((left, right) => left - right))
                                        !== JSON.stringify(memberPids)
                                    || signal?.aborted)
                                {
                                    throw new Error('resident service member roster changed before independent transfer');
                                }
                                const acknowledgement = await processOwner.transfer(containmentAuthority, {
                                    memberIdentities, supervisorIdentity: memberIdentities.find((entry) => entry.pid === supervisorPid),
                                    outputFiles: outputEvidence.outputFiles
                                });
                                const transferred = { ...containmentAuthority, phase: 'resident-transferred',
                                    residentTransfer: acknowledgement?.residentTransfer };
                                if (!resourceServiceContainmentIsComplete(transferred)
                                    || acknowledgement.authorityDigest !== digestCanonical(transferred))
                                {
                                    throw new Error('resident service lacks exact independent durable transfer acknowledgement');
                                }
                                containmentAuthority = freezeDeep(transferred);
                                residentTransferred = true;
                                lifecycle.push('bounded-file-output-capture', 'resident-service-transferred');
                            }
                            catch (error)
                            {
                                primaryError = error;
                            }
                        }
                        if (!residentTransferred && !await terminate('parent-exited-with-live-descendants'))
                        {
                            primaryError ??= new Error('physical execution cgroup is not empty');
                        }
                        else if (!residentTransferred && !primaryError)
                        {
                            primaryError = new Error('physical execution parent exited before its process group became empty (cgroup still live)');
                        }
                    }
                }
            }
            catch (error)
            {
                const normalizedError = error instanceof WaitForFileCancellation
                    ? cancellationPrimary(error.reason)
                    : error;
                primaryError ??= normalizedError;
                if (primaryError !== normalizedError && !primaryError.physicalExecutionContainmentError)
                {
                    primaryError.physicalExecutionContainmentError = {
                        name: normalizedError.name,
                        message: normalizedError.message
                    };
                }
                childError = normalizedError;
            }
            try
            {
                cleanup = residentTransferred
                    ? { status: 'transferred', reason: 'exact live resident service durably retained by its build owner',
                        authorityEstablished: true, knownRuntimeResiduals: [] }
                    : await finalizeSupervisor();
            }
            catch (error)
            {
                cleanup = {
                    status: 'unverifiable',
                    reason: `finalizer failed unexpectedly: ${error.message}`,
                    childTerminal: null,
                    unit: null,
                    cgroupMembers: null,
                    commands: cleanupCommands,
                    error: {
                        name: error.name,
                        code: error.code ?? null,
                        message: error.message
                    }
                };
            }
            let cleanupVerified = cleanup.status === 'verified';
            let confirmedNotEstablished = false;
            let resourceAbsenceVerified = resourceAdmission === null;
            if (resourceAdmission && (cleanupVerified || systemdRunSpawnError?.code === 'ENOENT'))
            {
                try
                {
                    if (resourceAdmission.assertOwnedOrAbsent() !== null)
                    {
                        throw new Error('the bound service is not collected');
                    }
                    resourceAbsenceVerified = true;
                }
                catch (error)
                {
                    cleanup = { ...cleanup, status: 'unverifiable',
                        reason: `resource-bound service absence is unverified: ${error.message}` };
                    cleanupVerified = false;
                }
            }
            if (cleanupVerified)
            {
                if (residentOutput)
                {
                    try
                    {
                        await verifyResidentSenderTerminal();
                        const finalOutput = await captureResidentServiceOutput(residentOutput, {
                            readMembers: () => controlGroup ? readCgroupMemberPids(controlGroup) : [],
                            supervisorPid: null,
                            outputTracker: outputEvidence
                                ? createPhysicalExecutionOutputTracker({ policy, stdout: null, stderr: null })
                                : executionOutput
                        });
                        if (outputEvidence && digestCanonical(outputEvidence.outputFiles)
                            !== digestCanonical(finalOutput.outputFiles))
                        {
                            throw new Error('resident service output changed after refused transfer');
                        }
                        outputEvidence ??= finalOutput;
                        lifecycle.push('bounded-file-output-capture');
                    }
                    catch (error)
                    {
                        cleanup = { ...cleanup, status: 'unverifiable',
                            reason: `resident service output or sender terminal is unverifiable: ${error.message}` };
                        cleanupVerified = false;
                    }
                }
            }
            if (privateDotnetScratch && cleanupVerified && !fs.existsSync(startFile))
            {
                privateDotnetScratchReceipt = {
                    path: privateDotnetScratch.path,
                    binding: privateDotnetScratch,
                    authorityId,
                    unitName,
                    cleanup: 'not-started'
                };
            }
            else if (privateDotnetScratch && cleanupVerified)
            {
                try
                {
                    privateDotnetScratchReceipt = JSON.parse(fs.readFileSync(
                        path.join(controlRoot, 'private-dotnet-scratch-finalized.json'), 'utf8'
                    ));
                    if (!['removed', 'not-prepared'].includes(privateDotnetScratchReceipt.cleanup)
                        || (privateDotnetScratchReceipt.cleanup === 'not-prepared' && !primaryError)
                        || privateDotnetScratchReceipt.path !== privateDotnetScratch.path
                        || privateDotnetScratchReceipt.unitName !== unitName
                        || privateDotnetScratchReceipt.authorityId !== authorityId
                        || (privateDotnetScratchReceipt.cleanup === 'removed'
                            && privateDotnetScratchReceipt.mountNamespace !== privateTmpMountNamespace)
                        || JSON.stringify(privateDotnetScratchReceipt.binding)
                            !== JSON.stringify(privateDotnetScratch))
                    {
                        throw new Error('private .NET scratch cleanup receipt binding drift');
                    }
                }
                catch (error)
                {
                    cleanup = {
                        ...cleanup,
                        status: 'unverifiable',
                        reason: `private .NET scratch cleanup is unverifiable: ${error.message}`
                    };
                    cleanupVerified = false;
                }
            }
            if (cleanupVerified)
            {
                lifecycle.push('post-observe-zero-members');
                try
                {
                    removeControlRoot(controlRoot);
                }
                catch (error)
                {
                    cleanup = {
                        ...cleanup,
                        status: 'unverifiable',
                        reason: `control root removal failed: ${error.message}`,
                        removalError: {
                            name: error.name,
                            code: error.code ?? null,
                            message: error.message
                        }
                    };
                    cleanupVerified = false;
                }
            }
            else if (systemdRunSpawnError?.code === 'ENOENT' && !supervisorPid && !authorityEstablished && resourceAbsenceVerified)
            {
                confirmedNotEstablished = true;
                cleanup = {
                    ...cleanup,
                    status: 'not-established',
                    reason: 'systemd-run executable was not established',
                    authorityEstablished: false,
                    knownRuntimeResiduals: []
                };
                try
                {
                    removeControlRoot(controlRoot);
                }
                catch (error)
                {
                    cleanup = {
                        ...cleanup,
                        status: 'unverifiable',
                        reason: `control root removal failed after systemd-run was not established: ${error.message}`,
                        removalError: {
                            name: error.name,
                            code: error.code ?? null,
                            message: error.message
                        }
                    };
                }
            }
            const establishedState = confirmedNotEstablished
                ? false
                : authorityEstablished || cleanup.authorityEstablished === true
          ? true
          : null;
            const authority = {
                schema: 'fsusblog.physical-execution-authority.v1',
                platform: 'linux',
                kind: 'linux-cgroup-process-group',
                authorityId,
                unitName: establishedState === true ? unitName : null,
                controlGroup: establishedState === true ? controlGroup : null,
                supervisorPid: establishedState === true ? supervisorPid : null,
                processGroup: establishedState === true
                    ? commandProcessGroup
                    : null,
                killPolicy: 'control-group',
                networkIsolation: linuxPrivateNetwork
                    ? 'systemd-private-network'
                    : linuxNetworkPolicy
                        ? {
                            kind: 'systemd-ip-address-policy',
                            deny: linuxNetworkPolicy.deny,
                            allow: linuxNetworkPolicy.allow
                        }
                        : 'host',
                filesystemIsolation: linuxReadWritePaths.length > 0
                    ? {
                        kind: 'systemd-protect-system',
                        protectSystem: 'strict',
                        protectHome: 'read-only',
                        privateTmp: true,
                        readWritePaths: [...linuxReadWritePaths]
                    }
                    : null,
                privateDotnetScratch: privateDotnetScratchReceipt,
                established: establishedState,
                attemptedUnitName: establishedState === true ? null : unitName
            };
            if (!cleanupVerified && cleanup.status !== 'not-established' && !residentTransferred)
            {
                primaryError ??= new Error(`physical execution cleanup is unverifiable: ${cleanup.reason}`);
            }
            if (!outputEvidence && residentOutput)
            {
                executionOutput.attach(null, 'stdout');
                executionOutput.attach(null, 'stderr');
                outputEvidence = { ...await executionOutput.close(), logComplete: false,
                    logTruncationReason: 'resident-output-unverified' };
            }
            outputEvidence ??= await executionOutput.close();
            if (!outputEvidence.logComplete)
            {
                const logError = new Error(
                    `physical execution log is incomplete: ${outputEvidence.logTruncationReason}`
                );
                if (primaryError)
                {
                    primaryError.physicalExecutionLogError ??= {
                        name: logError.name,
                        message: logError.message
                    };
                }
                else
                {
                    primaryError = logError;
                }
            }
            lifecycle.push(primaryError ? 'seal-cancelled-or-failed-receipt' : 'seal-completed-receipt');
            const evidence = {
                schema,
                platform: 'linux',
                policy,
                authority,
                lifecycle,
                termination,
                postObservation: residentTransferred ? 'resident-transferred'
                    : cleanupVerified || cleanup.status === 'not-established' ? 'zero-members' : 'unverifiable',
                cleanup,
                executionAdmission,
                resourceExecutionAdmission,
                containmentAuthority,
                controlRoot: cleanupVerified || cleanup.status === 'not-established' ? null : controlRoot,
                processInventory: [...inventory.values()].map((identity) => ({
                    pid: identity.pid,
                    startIdentity: identity.processStartIdentity,
                    ppid: null,
                    pgid: identity.pid === commandPid
                        ? commandProcessGroup?.groupId ?? null
                        : null,
                    jobId: unitName,
                    executableDigest: identity.executableDigest,
                    commandDigest: identity.commandDigest,
                    observationPhase: identity.observationPhase ?? 'running',
                    role: identity.pid === commandPid
                        ? 'direct-child'
                        : identity.pid === supervisorPid
                ? 'containment-supervisor'
                : 'descendant',
                    observedAt: new Date().toISOString(),
                    exitCode: identity.pid === commandPid && first?.kind === 'result'
                        ? first.value.exitCode
                        : null,
                    signal: termination.some((entry) => entry.phase === 'forced')
                        ? 'SIGKILL'
                        : termination.some((entry) => entry.phase === 'graceful')
                ? 'SIGTERM'
                : null
                })),
                ...outputEvidence
            };
            if (primaryError)
            {
                primaryError.physicalExecution = evidence;
                if (!cleanupVerified && cleanup.status !== 'not-established')
                {
                    primaryError.physicalExecutionFinalizeError = {
                        name: 'Error',
                        message: cleanup.reason,
                        cleanup
                    };
                }
                throw primaryError;
            }
            return evidence;
        }
    };
}
