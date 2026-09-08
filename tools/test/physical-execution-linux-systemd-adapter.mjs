import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveExecutablePath } from './execution-envelope-environment.mjs';
import { createPhysicalExecutionOutputTracker } from './physical-execution-process-tree.mjs';
import {
    collectProcessGroupOrJobIdentity,
    collectProcessIdentity
} from './process-identity.mjs';

const bootstrap = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'physical-execution-linux-systemd-bootstrap.mjs'
);

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
    getChildError = () => null
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
            if (child.exitCode !== null || child.signalCode !== null)
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

function writePrivateJsonFile(controlRoot, name, value)
{
    const file = path.join(controlRoot, name);
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
    try
    {
        descriptor = fs.openSync(file, flags, 0o600);
        fs.writeFileSync(descriptor, `${serialized}\n`, 'utf8');
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
        {
            throw new Error(`physical execution private carrier ${name} is not a regular 0600 file`);
        }
    }
    finally
    {
        if (descriptor !== undefined)
        {
            fs.closeSync(descriptor);
        }
    }
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
            signal,
            policy,
            stdout,
            stderr,
            schema,
            outputTracker = null
        })
        {
            requireSystemdAuthority(runSystemctl);
            const authorityId = randomUUID();
            const { privateKey, publicKey } = generateKeyPairSync('ed25519');
            let python;
            const unitName = `fsusblog-physical-${authorityId.replaceAll('-', '')}`;
            const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-physical-systemd-'));
            const readyFile = path.join(controlRoot, 'ready');
            const startFile = path.join(controlRoot, 'start');
            const childFile = path.join(controlRoot, 'child.json');
            const resultFile = path.join(controlRoot, 'result.json');
            const finalizeFile = path.join(controlRoot, 'finalize');
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
                writePrivateJsonFile(controlRoot, 'command.json', command);
                writePrivateJsonFile(controlRoot, 'environment.json', env);
                python = resolvePython(controlEnv);
                writePrivateJsonFile(controlRoot, 'admission.json', {
                    authorityId,
                    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
                    python
                });
            }
            catch (error)
            {
                removeUnestablishedRoot(error);
                throw error;
            }
            const systemdArgs = [
                '--user',
                '--quiet',
                '--wait',
                '--pipe',
                '--collect',
                '--service-type=exec',
                '--property=KillMode=control-group',
                '--property=ExitType=cgroup',
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
            try
            {
                child = spawnProcess('systemd-run', systemdArgs, {
                    cwd,
                    env: controlEnv,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true
                });
            }
            catch (error)
            {
                removeUnestablishedRoot(error);
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
            executionOutput.attach(child.stdout, 'stdout');
            executionOutput.attach(child.stderr, 'stderr');
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
            let authorityEstablished = false;
            let first;
            let outputEvidence = null;
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
            const runCleanupCommand = (args) =>
            {
                let result;
                try
                {
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
                lifecycle.push('bounded-pipe-close');
                outputEvidence = await executionOutput.close();

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
                    getChildError: () => childError
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
                    getChildError: () => childError
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
                    getChildError: () => childError
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
                        if (!await terminate('parent-exited-with-live-descendants'))
                        {
                            primaryError ??= new Error('physical execution cgroup is not empty');
                        }
                        else if (!primaryError)
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
                cleanup = await finalizeSupervisor();
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
            else if (systemdRunSpawnError?.code === 'ENOENT' && !supervisorPid && !authorityEstablished)
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
                established: establishedState,
                attemptedUnitName: establishedState === true ? null : unitName
            };
            if (!cleanupVerified && cleanup.status !== 'not-established')
            {
                primaryError ??= new Error(`physical execution cleanup is unverifiable: ${cleanup.reason}`);
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
                postObservation: cleanupVerified || cleanup.status === 'not-established'
                    ? 'zero-members'
                    : 'unverifiable',
                cleanup,
                executionAdmission,
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
