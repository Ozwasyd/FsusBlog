import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { inspectOwnedPrivateTmp } from './execution-envelope-directories.mjs';
import { managedPreparationPurposes } from './execution-envelope-environment.mjs';
import { prepareNetworkBindings } from './execution-envelope-network.mjs';
import { collectProcessIdentity, currentProcessIdentity, processIdentityStatus } from './process-identity.mjs';
const { executionEnvelopeDigest } = await import(new URL('../test-matrix/execution-envelope-policy.mjs', import.meta.url));
const { assertProductionSystemdExecutionBoundary, inspectProductionSystemdServiceBinding } =
    await import(new URL('../test-matrix/production-systemd-resource-boundary.mjs', import.meta.url));

export const nestedExecutionChannelKey = 'FSUSBLOG_PHYSICAL_EXECUTION_CHANNEL';
const schema = 'fsusblog.physical-execution-nested-channel.v1';
const requestSchema = 'fsusblog.physical-execution-nested-request.v2';
const attemptSchema = 'fsusblog.nested-execution-envelope-reference.v2';
const transportFile = fileURLToPath(new URL('./physical-execution-nested-socket.py', import.meta.url));
const channelCapabilities = new WeakSet();

function nestedDigest(value)
{
    return executionEnvelopeDigest(value).slice('sha256:'.length);
}

function exactKeys(value, keys)
{
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === [...keys].sort().join(','));
}

function attemptReferenceIsComplete(reference)
{
    return exactKeys(reference, ['schema', 'id', 'channelId', 'bindingDigest', 'executionDigest'])
        && reference.schema === attemptSchema
        && /^[a-f0-9-]{36}$/u.test(reference.id)
        && /^[a-f0-9-]{36}$/u.test(reference.channelId)
        && /^[a-f0-9]{64}$/u.test(reference.bindingDigest)
        && /^[a-f0-9]{64}$/u.test(reference.executionDigest);
}

function publicExecution(execution)
{
    return { command: execution.command, cwd: execution.cwd, env: execution.env,
        linuxPrivateNetwork: execution.linuxPrivateNetwork, linuxNetworkPolicy: execution.linuxNetworkPolicy,
        linuxReadWritePaths: execution.linuxReadWritePaths, privateDotnetScratch: execution.privateDotnetScratch };
}

/** Preserve the original admission cancellation reason; retained state is diagnostics, not execution authority. */
export function assertNestedPreparationCancellation(preparationSignal, upstreamSignal, attempt)
{
    if (preparationSignal.aborted || upstreamSignal?.aborted)
    {
        const reason = preparationSignal.reason ?? upstreamSignal?.reason ?? new Error('nested execution owner is closed');
        attempt.preparationCancellationReason = reason;
        attempt.recoveryObligation ??= { ownedRoot: attempt.retainedDirectories?.fragment?.ownedRoot,
            reason: 'original preparation owner has not verified all tool terminals' };
        throw reason;
    }
}

/** Only diagnostics: the private tool's physical/admission observations remain independently verified. */
export function retainNestedPreparationFailure(tool, preparationFailure)
{
    if (preparationFailure !== null && preparationFailure !== undefined)
    {
        tool.preparationFailure = preparationFailure;
    }
}

export function nestedExecutionChannelIsComplete(channel)
{
    return Boolean(channel && Object.keys(channel).sort().join(',') ===
        'brokerIdentity,controllerIdentity,directory,id,publicKey,reference,schema,socket'
        && channel.schema === schema && /^[a-f0-9-]{36}$/u.test(channel.id)
        && typeof channel.publicKey === 'string' && channel.publicKey.startsWith('-----BEGIN PUBLIC KEY-----')
        && channel.reference?.schema === 'fsusblog.production-systemd-resource-boundary.v1'
        && channel.brokerIdentity?.status === 'verified' && channel.controllerIdentity?.status === 'verified'
        && channel.socket && Object.keys(channel.socket).sort().join(',') === 'device,inode,path'
        && typeof channel.socket.path === 'string' && path.isAbsolute(channel.socket.path)
        && Number.isSafeInteger(channel.socket.device) && channel.socket.device >= 0
        && Number.isSafeInteger(channel.socket.inode) && channel.socket.inode > 0
        && channel.directory && Object.keys(channel.directory).sort().join(',') === 'device,inode,path'
        && channel.directory.path === path.dirname(channel.socket.path)
        && path.basename(channel.socket.path) === 'owner.sock'
        && /^fsus-nested-[A-Za-z0-9]{6}$/u.test(path.basename(channel.directory.path))
        && Number.isSafeInteger(channel.directory.device) && channel.directory.device >= 0
        && Number.isSafeInteger(channel.directory.inode) && channel.directory.inode > 0);
}

export function nestedExecutionChannelIsOwned(channel)
{
    return channelCapabilities.has(channel);
}

function assertSocket(descriptor)
{
    if (!nestedExecutionChannelIsComplete(descriptor))
    {
        throw new Error('nested execution channel descriptor is incomplete');
    }
    const directory = path.dirname(descriptor.socket.path);
    const parent = fs.lstatSync(directory);
    const socket = fs.lstatSync(descriptor.socket.path);
    if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(directory) !== directory
        || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0
        || parent.dev !== descriptor.directory.device || parent.ino !== descriptor.directory.inode
        || !socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077) !== 0
        || socket.dev !== descriptor.socket.device || socket.ino !== descriptor.socket.inode
        || processIdentityStatus(descriptor.controllerIdentity).status !== 'live'
        || processIdentityStatus(descriptor.brokerIdentity).status !== 'live')
    {
        throw new Error('nested execution channel socket or controller identity changed');
    }
}

function originalProcessGone(identity)
{
    const observed = processIdentityStatus(identity);
    if (observed.status === 'dead')
    {
        return true;
    }
    if (observed.status === 'live')
    {
        return false;
    }
    if (observed.status === 'mismatch' && observed.actual?.status === 'verified'
        && observed.actual.processStartIdentity !== identity.processStartIdentity)
    {
        return true;
    }
    throw new Error('nested execution retained process incarnation is unverifiable');
}

/** Read-only carrier/transport observation; replacement PIDs never acquire the old identity. */
export function inspectNestedExecutionChannelCarrier(descriptor)
{
    if (!nestedExecutionChannelIsComplete(descriptor))
    {
        throw new Error('nested execution channel carrier reference is incomplete');
    }
    const brokerGone = originalProcessGone(descriptor.brokerIdentity);
    const directory = fs.lstatSync(descriptor.directory.path, { throwIfNoEntry: false });
    if (!directory)
    {
        return { status: brokerGone ? 'absent' : 'retained', directory: false, socket: false, brokerGone };
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()
        || fs.realpathSync(descriptor.directory.path) !== descriptor.directory.path
        || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0
        || directory.dev !== descriptor.directory.device || directory.ino !== descriptor.directory.inode
        || fs.readdirSync(descriptor.directory.path).some((name) => name !== 'owner.sock'))
    {
        throw new Error('nested execution channel carrier identity or contents changed');
    }
    const socket = fs.lstatSync(descriptor.socket.path, { throwIfNoEntry: false });
    if (socket && (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077) !== 0
        || socket.nlink !== 1 || socket.dev !== descriptor.socket.device || socket.ino !== descriptor.socket.inode))
    {
        throw new Error('nested execution channel socket identity changed');
    }
    return { status: 'retained', directory: true, socket: Boolean(socket), brokerGone };
}

function removeNestedExecutionChannel(descriptor, { validateAuthority }, controllerState)
{
    const observe = () =>
    {
        if (typeof validateAuthority !== 'function' || validateAuthority()?.status !== 'verified'
            || (controllerState === 'dead' ? !originalProcessGone(descriptor.controllerIdentity)
                : controllerState !== 'live' || descriptor.controllerIdentity.pid !== process.pid
                    || processIdentityStatus(descriptor.controllerIdentity).status !== 'live'))
        {
            throw new Error('nested execution carrier cleanup requires its exact independent owner state');
        }
        const state = inspectNestedExecutionChannelCarrier(descriptor);
        if (!state.brokerGone)
        {
            throw new Error('nested execution broker remains live; carrier cleanup refused');
        }
        return state;
    };
    const state = observe();
    if (state.socket)
    {
        fs.unlinkSync(descriptor.socket.path);
    }
    if (observe().directory)
    {
        fs.rmdirSync(descriptor.directory.path);
        const parent = fs.openSync(path.dirname(descriptor.directory.path), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try
        {
            fs.fsyncSync(parent);
        }
        finally
        {
            fs.closeSync(parent);
        }
    }
    if (observe().status !== 'absent')
    {
        throw new Error('nested execution carrier cleanup did not prove absence');
    }
    return { kind: 'nested-channel', channelId: descriptor.id, path: descriptor.directory.path, status: 'absent' };
}

/** Existing process owner calls this only after independent whole-tree recovery verification. */
export function removeRecoveredNestedExecutionChannel(descriptor, options)
{
    return removeNestedExecutionChannel(descriptor, options, 'dead');
}

/** The original live controller may remove its stopped, exact broker carrier. */
export function removeLiveNestedExecutionChannel(descriptor, options)
{
    return removeNestedExecutionChannel(descriptor, options, 'live');
}

async function* messages(stream, maximumBytes)
{
    let buffered = Buffer.alloc(0);
    for await (const chunk of stream)
    {
        buffered = Buffer.concat([buffered, chunk]);
        for (;;)
        {
            const end = buffered.indexOf(10);
            if (end < 0)
            {
                break;
            }
            if (end > maximumBytes)
            {
                throw new Error('nested execution message exceeds its bound');
            }
            const message = JSON.parse(buffered.subarray(0, end).toString('utf8'));
            buffered = buffered.subarray(end + 1);
            yield message;
        }
        if (buffered.length > maximumBytes)
        {
            throw new Error('nested execution message exceeds its bound');
        }
    }
    if (buffered.length)
    {
        throw new Error('nested execution transport ended inside a message');
    }
}

function send(stream, value)
{
    return new Promise((resolve, reject) =>
    {
        stream.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve());
    });
}

async function authorize(descriptor, identity)
{
    assertSocket(descriptor);
    const { authorizeProductionBuildNestedProcess } = await import(new URL('../test-matrix/production-build-layout.mjs', import.meta.url));
    return authorizeProductionBuildNestedProcess(descriptor, identity);
}

function serializedError(error)
{
    return { name: error.name, message: error.message, code: error.code ?? null, exitCode: error.exitCode ?? null,
        signal: error.signal ?? null, physicalExecution: error.physicalExecution ?? null };
}

/** One original owner executes nested requests; the broker supplies kernel peer credentials only. */
export async function createNestedExecutionChannel({ boundary, controlEnv, policy, runNested, signal,
    linuxOwnedPrivateTmp = null })
{
    if (linuxOwnedPrivateTmp !== null)
    {
        inspectOwnedPrivateTmp(linuxOwnedPrivateTmp);
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-nested-'));
    const directoryIdentity = fs.lstatSync(directory);
    const socketPath = path.join(directory, 'owner.sock');
    const maximumBytes = policy.maximumCapturedOutputBytesPerStream * 16;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const child = spawn(controlEnv.FSUSBLOG_PYTHON ?? 'python3', ['-I', '-S', transportFile, socketPath, String(maximumBytes),
        String(policy.systemdResourceStartupTimeoutMs / 1000), String(policy.pipeCloseTimeoutMs / 1000)], {
        env: controlEnv, stdio: ['pipe', 'pipe', 'pipe']
    });
    const requests = new Map();
    // References select only state prepared by the original producer in this controller.
    const attempts = new Map();
    const attemptKeys = new Set();
    const records = [];
    let closing = false;
    let descriptor;
    let failure = null;
    let diagnostics = '';
    const removeDirectory = () =>
    {
        const current = fs.lstatSync(directory);
        const socket = fs.lstatSync(socketPath, { throwIfNoEntry: false });
        if (!current.isDirectory() || current.isSymbolicLink() || fs.realpathSync(directory) !== directory
            || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino
            || current.uid !== process.getuid() || (current.mode & 0o077) !== 0
            || fs.readdirSync(directory).some((entry) => entry !== 'owner.sock')
            || (socket && (!socket.isSocket() || !descriptor || socket.dev !== descriptor.socket.device
                || socket.ino !== descriptor.socket.inode)))
        {
            throw new Error('nested execution channel carrier changed; cleanup refused');
        }
        fs.rmSync(directory, { recursive: true });
    };
    child.stderr.on('data', (chunk) =>
    {
        diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(-policy.maximumCapturedOutputBytesPerStream);
    });
    const exited = new Promise((resolve) => child.once('close', (code, childSignal) => resolve({ code, signal: childSignal })));
    const awaitExit = async () =>
    {
        let timer;
        try
        {
            return await Promise.race([exited, new Promise((_resolve, reject) =>
            {
                timer = setTimeout(() => reject(new Error('nested execution broker did not become terminal')),
                    policy.forceTerminationMs);
            })]);
        }
        finally
        {
            clearTimeout(timer);
        }
    };
    let ready;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) =>
    {
        ready = resolve;
        rejectReady = reject;
    });
    const abortRequests = (reason) =>
    {
        for (const request of requests.values())
        {
            request.controller.abort(reason);
        }
    };
    const fail = (error) =>
    {
        failure ??= error;
        rejectReady(error);
        abortRequests(error);
    };
    child.once('error', fail);
    child.stdin.on('error', fail);
    const reply = (id, message) => send(child.stdin, { id, message });
    const abort = () => abortRequests(signal.reason ?? new Error('nested execution owner cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    const lookupAttempt = (reference, identity) =>
    {
        const attempt = attemptReferenceIsComplete(reference) ? attempts.get(reference.id) : null;
        if (!attempt || nestedDigest(reference) !== nestedDigest(attempt.reference)
            || reference.channelId !== descriptor.id || nestedDigest(identity) !== nestedDigest(attempt.identity))
        {
            throw new Error('nested execution reference lacks its original current-peer attempt');
        }
        return attempt;
    };
    const preparationOwner = (attempt, { identity, assertAdmission, signal: preparationSignal }) =>
    {
        const toolRequests = new WeakMap();
        attempt.tools = [];
        let preparationClosed = false;
        let pendingAssertions = 0;
        const recoveryError = (message, physicalExecution = null) => Object.assign(new Error(message), {
            physicalExecution,
            recoveryObligation: { ownedRoot: attempt.retainedDirectories?.fragment?.ownedRoot,
                reason: 'original preparation owner has not verified all tool terminals' }
        });
        const assertPreparationOpen = () =>
        {
            assertNestedPreparationCancellation(preparationSignal, signal, attempt);
            if (preparationClosed || attempt.phase !== 'preparing' || closing
                || processIdentityStatus(attempt.identity).status !== 'live')
            {
                throw recoveryError('nested preparation is closed or its original peer is no longer current');
            }
            assertProductionSystemdExecutionBoundary(boundary, { expectedContext: descriptor.reference.context });
        };
        const deriveExecution = (toolRequest) =>
        {
            const prepared = attempt.retainedDirectories;
            const context = descriptor.reference.context;
            if (prepared === null || !exactKeys(toolRequest, ['purpose', 'command', 'cwd', 'environment'])
                || !Object.isFrozen(toolRequest) || !Object.isFrozen(toolRequest.command)
                || !Object.isFrozen(toolRequest.environment)
                || !managedPreparationPurposes.includes(toolRequest.purpose)
                || !Array.isArray(toolRequest.command) || toolRequest.command.length === 0
                || !toolRequest.command.every((part) => typeof part === 'string' && !part.includes('\0'))
                || typeof toolRequest.cwd !== 'string' || fs.realpathSync(toolRequest.cwd) !== toolRequest.cwd
                || (toolRequest.cwd !== context.root && !toolRequest.cwd.startsWith(`${context.root}${path.sep}`))
                || Object.entries(prepared.environment).some(([key, value]) => toolRequest.environment[key] !== value)
                || toolRequest.environment.FSUSBLOG_TEST_RUN_ID !== context.runId
                || toolRequest.environment.FSUSBLOG_TEST_SOURCE_COMMIT !== context.sourceState.commit
                || String(toolRequest.environment.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').replace(/^sha256:/u, '')
                    !== context.sourceState.worktreeFingerprint)
            {
                throw recoveryError('nested preparation lacks its exact original producer-derived tool tuple');
            }
            const bindings = prepareNetworkBindings({ directories: prepared.fragment.directories,
                ownedDirectoryEnvelope: prepared, writableRoots: prepared.fragment.writableRoots,
                environment: toolRequest.environment, producerId: prepared.fragment.producerId,
                attemptId: prepared.fragment.attemptId });
            return { command: [...toolRequest.command], cwd: toolRequest.cwd, env: { ...toolRequest.environment },
                // Tool observation/build has no service endpoint contract: use the original fully private network gate.
                linuxPrivateNetwork: true, linuxNetworkPolicy: null,
                linuxReadWritePaths: bindings.readWritePaths, linuxOwnedPrivateTmp: prepared.privateTmpCapability,
                privateDotnetScratch: null };
        };
        const assertHeldOwner = async () =>
        {
            await assertAdmission();
            return assertProductionSystemdExecutionBoundary(boundary, { expectedContext: descriptor.reference.context });
        };
        const assertFinalizablePreparation = () =>
        {
            // Closing is irreversible, including when a pending owner read prevents cleanup.
            preparationClosed = true;
            assertProductionSystemdExecutionBoundary(boundary, { expectedContext: descriptor.reference.context });
            if (pendingAssertions > 0 || attempt.tools.some((tool) => !['terminal', 'verified'].includes(tool.phase)))
            {
                throw recoveryError('nested preparation retains an unsettled original tool request');
            }
            for (const tool of attempt.tools)
            {
                if (tool.started && (tool.phase !== 'verified'
                    || tool.physicalExecution?.postObservation !== 'zero-members'))
                {
                    throw recoveryError('nested preparation retains an unverifiable actual tool terminal', tool.physicalExecution);
                }
                if (tool.started && inspectProductionSystemdServiceBinding(
                    tool.physicalExecution.resourceExecutionAdmission.serviceBinding,
                    { commandBudgetMs: policy.systemdControlCommandTimeoutMs }).status !== 'absent')
                {
                    throw recoveryError('nested preparation managed resources reappeared before directory finalization', tool.physicalExecution);
                }
            }
            const started = attempt.tools.filter((tool) => tool.started);
            return { physicalStarted: started.length > 0,
                physicalExecution: started.length ? started.at(-1).physicalExecution : null };
        };
        return Object.freeze({
            assertFinalizablePreparation,
            async assertPreparationExecution({ request: toolRequest, phase, physicalExecution, preparationFailure = null })
            {
                if (phase === 'after')
                {
                    const tool = toolRequests.get(toolRequest);
                    if (tool)
                    {
                        retainNestedPreparationFailure(tool, preparationFailure);
                    }
                }
                if (phase === 'before')
                {
                    assertPreparationOpen();
                }
                pendingAssertions++;
                try
                {
                    await assertHeldOwner();
                    if (phase === 'before')
                    {
                        assertPreparationOpen();
                    }
                }
                finally
                {
                    pendingAssertions--;
                }
                const execution = deriveExecution(toolRequest);
                if (phase === 'before')
                {
                    if (physicalExecution !== null || toolRequests.has(toolRequest))
                    {
                        throw recoveryError('nested preparation tool request was already admitted');
                    }
                    const tool = { request: toolRequest, execution, phase: 'admitted', started: false,
                        physicalExecution: null };
                    toolRequests.set(toolRequest, tool);
                    attempt.tools.push(tool);
                    return;
                }
                const tool = toolRequests.get(toolRequest);
                if (phase !== 'after' || !tool || tool.phase !== 'terminal'
                    || physicalExecution !== tool.physicalExecution
                    || nestedDigest(publicExecution(execution)) !== nestedDigest(publicExecution(tool.execution)))
                {
                    throw recoveryError('nested preparation observation does not belong to its original actual tool request', physicalExecution);
                }
                const admission = physicalExecution?.resourceExecutionAdmission;
                const containment = physicalExecution?.containmentAuthority;
                if (physicalExecution?.postObservation !== 'zero-members'
                    || !admission?.reference || !admission.serviceBinding || !containment?.serviceBinding
                    || !Array.isArray(physicalExecution?.authority?.filesystemIsolation?.readWritePaths)
                    || nestedDigest(admission?.reference) !== nestedDigest(boundary.reference)
                    || nestedDigest(admission?.serviceBinding) !== nestedDigest(containment?.serviceBinding)
                    || !admission.serviceBinding.identity
                    || physicalExecution?.authority?.networkIsolation !== 'systemd-private-network'
                    || nestedDigest(physicalExecution?.authority?.filesystemIsolation?.readWritePaths)
                        !== nestedDigest(tool.execution.linuxReadWritePaths))
                {
                    throw recoveryError('nested preparation actual execution differs from its original resource and directory owners', physicalExecution);
                }
                const observed = inspectProductionSystemdServiceBinding(admission.serviceBinding, {
                    commandBudgetMs: policy.systemdControlCommandTimeoutMs
                });
                if (observed.status !== 'absent')
                {
                    throw recoveryError('nested preparation tool still has actual managed resources', physicalExecution);
                }
                tool.phase = 'verified';
            },
            async executePreparation(toolRequest)
            {
                assertPreparationOpen();
                const tool = toolRequests.get(toolRequest);
                if (!tool || tool.phase !== 'admitted')
                {
                    throw recoveryError('nested preparation execution requires its original admitted request');
                }
                // Consume before an asynchronous admission read so two invocations cannot race.
                tool.phase = 'admitting-execution';
                try
                {
                    await assertHeldOwner();
                    const execution = deriveExecution(toolRequest);
                    if (nestedDigest(publicExecution(execution)) !== nestedDigest(publicExecution(tool.execution)))
                    {
                        throw recoveryError('nested preparation derived tuple changed before execution');
                    }
                    // Re-read the original peer/grant and closed phase after the admission await, before any effect.
                    assertPreparationOpen();
                    tool.phase = 'running';
                    tool.started = true;
                    const sink = () => new Writable({ write(_chunk, _encoding, done)
                    {
                        done();
                    } });
                    tool.physicalExecution = await runNested({ ...tool.execution,
                        signal: preparationSignal, stdout: sink(), stderr: sink() });
                    return tool.physicalExecution;
                }
                catch (error)
                {
                    tool.failure = error;
                    try
                    {
                        tool.physicalExecution = error?.physicalExecution ?? null;
                    }
                    catch (metadataError)
                    {
                        tool.physicalExecution = null;
                        tool.preparationFailureMetadataError = metadataError;
                    }
                    throw error;
                }
                finally
                {
                    tool.phase = 'terminal';
                    if (tool.started)
                    {
                        records.push({ caller: identity, preparationPurpose: toolRequest.purpose,
                            authority: tool.physicalExecution?.containmentAuthority ?? null,
                            postObservation: tool.physicalExecution?.postObservation ?? 'unverifiable',
                            logComplete: tool.physicalExecution?.logComplete === true });
                    }
                }
            }
        });
    };
    const finalizeAttempt = async (attempt) =>
    {
        if (!['prepared', 'terminal'].includes(attempt.phase) || !attempt.prepared)
        {
            throw new Error('nested execution attempt is not uniquely ready for finalization');
        }
        // These facts belong to the controller, never to a child-provided terminal report.
        attempt.phase = 'finalizing';
        try
        {
            attempt.preparationOwner.assertFinalizablePreparation();
            if (attempt.physicalStarted && attempt.physicalExecution?.postObservation !== 'zero-members')
            {
                throw Object.assign(new Error('nested execution retains directories without the original actual zero-member terminal'), {
                    physicalExecution: attempt.physicalExecution,
                    recoveryObligation: { ownedRoot: attempt.retainedDirectories?.fragment?.ownedRoot,
                        reason: 'original physical owner has not verified a zero-member terminal' }
                });
            }
            inspectOwnedPrivateTmp(attempt.execution.linuxOwnedPrivateTmp, {
                environment: attempt.execution.env, readWritePaths: attempt.execution.linuxReadWritePaths
            });
            attempt.finalized = await attempt.prepared.finalize({ physicalStarted: attempt.physicalStarted,
                physicalExecution: attempt.physicalExecution });
            attempt.phase = 'finalized';
            return attempt.finalized;
        }
        catch (error)
        {
            attempt.phase = 'finalize-failed';
            attempt.failure = error;
            throw error;
        }
    };
    const dispatch = async (message) =>
    {
        if (message.kind === 'ready')
        {
            if (descriptor || message.pid !== child.pid)
            {
                throw new Error('nested execution broker startup identity differs');
            }
            const stat = fs.lstatSync(socketPath);
            descriptor = Object.freeze({ schema, id: randomUUID(), reference: boundary.reference,
                controllerIdentity: currentProcessIdentity(), brokerIdentity: collectProcessIdentity(child.pid),
                publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
                directory: { path: directory, device: directoryIdentity.dev, inode: directoryIdentity.ino },
                socket: { path: socketPath, device: stat.dev, inode: stat.ino } });
            assertSocket(descriptor);
            ready();
            return;
        }
        if (['cancel', 'disconnect'].includes(message.kind))
        {
            const request = requests.get(message.id);
            if (request)
            {
                request.disconnected ||= message.kind === 'disconnect';
                request.controller.abort(new Error(`nested caller ${message.kind}`));
            }
            return;
        }
        if (message.kind !== 'request' || !Number.isSafeInteger(message.id) || requests.has(message.id))
        {
            throw new Error('nested execution broker event is invalid');
        }
        const controller = new AbortController();
        const request = { controller, promise: null, disconnected: false, outputBytes: 0 };
        requests.set(message.id, request);
        request.promise = (async () =>
        {
            try
            {
                if (closing || signal?.aborted || !descriptor || message.peer?.uid !== process.getuid())
                {
                    throw new Error('nested execution owner is closed or peer is foreign');
                }
                const identity = collectProcessIdentity(message.peer.pid);
                const assertAdmission = async () =>
                {
                    if (closing || signal?.aborted || controller.signal.aborted)
                    {
                        throw controller.signal.reason ?? signal?.reason ?? new Error('nested execution owner is closed');
                    }
                    return authorize(descriptor, identity);
                };
                await assertAdmission();
                const value = message.request;
                if (!Object.hasOwn(value, 'schema'))
                {
                    if (Object.keys(value).sort().join(',') !== 'command,cwd,env,kind,linuxNetworkPolicy,linuxOwnedPrivateTmp,linuxPrivateNetwork,linuxReadWritePaths,nonce,privateDotnetScratch'
                    || value.kind !== 'run' || !/^[a-f0-9-]{36}$/u.test(value.nonce)
                    || !Array.isArray(value.command) || !value.command.length || !value.command.every((entry) => typeof entry === 'string')
                    || typeof value.cwd !== 'string' || !value.env || typeof value.env !== 'object' || Array.isArray(value.env)
                    || !Object.values(value.env).every((entry) => typeof entry === 'string')
                    || typeof value.linuxPrivateNetwork !== 'boolean' || !Array.isArray(value.linuxReadWritePaths)
                    || !value.linuxReadWritePaths.every((entry) => typeof entry === 'string')
                    || typeof value.linuxOwnedPrivateTmp !== 'boolean'
                    || (value.privateDotnetScratch !== null && (!value.privateDotnetScratch
                        || typeof value.privateDotnetScratch !== 'object' || Array.isArray(value.privateDotnetScratch))))
                    {
                        throw new Error('nested execution request is incomplete');
                    }
                    if (value.linuxOwnedPrivateTmp)
                    {
                    // Wire facts cannot mint the directory owner's opaque capability.
                        inspectOwnedPrivateTmp(linuxOwnedPrivateTmp, {
                            environment: value.env, readWritePaths: value.linuxReadWritePaths
                        });
                    }
                    const hello = { schema, nonce: value.nonce, channelId: descriptor.id, peer: identity };
                    await reply(message.id, { kind: 'hello', hello,
                        signature: sign(null, Buffer.from(JSON.stringify(hello)), privateKey).toString('base64') });
                    const stream = (name) => new Writable({ write(chunk, _encoding, done)
                    {
                        request.outputBytes += chunk.length;
                        reply(message.id, { kind: name, data: chunk.toString('base64') }).then(() => done(), done);
                    } });
                    const stdout = stream('stdout');
                    const stderr = stream('stderr');
                    const result = await runNested({ ...value,
                        linuxOwnedPrivateTmp: value.linuxOwnedPrivateTmp ? linuxOwnedPrivateTmp : null,
                        env: { ...value.env, [nestedExecutionChannelKey]: JSON.stringify(descriptor) },
                        signal: controller.signal, stdout, stderr });
                    records.push({ caller: identity, authority: result.containmentAuthority, postObservation: result.postObservation,
                        logComplete: result.logComplete && (!request.disconnected || request.outputBytes === 0) });
                    await reply(message.id, { kind: 'result', result });
                    return;
                }
                const fields = { prepare: ['kind', 'schema', 'nonce', 'invocation'],
                    run: ['kind', 'schema', 'nonce', 'reference', 'executionDigest'],
                    finalize: ['kind', 'schema', 'nonce', 'reference'] };
                if (!Object.hasOwn(fields, value?.kind) || !exactKeys(value, fields[value.kind])
                    || value.schema !== requestSchema || !/^[a-f0-9-]{36}$/u.test(value.nonce))
                {
                    throw new Error('nested execution requires a closed current v2 phase request');
                }
                const hello = { schema, nonce: value.nonce, channelId: descriptor.id, peer: identity };
                await reply(message.id, { kind: 'hello', hello,
                    signature: sign(null, Buffer.from(JSON.stringify(hello)), privateKey).toString('base64') });
                if (value.kind === 'prepare')
                {
                    if (!exactKeys(value.invocation, ['schema', 'options', 'command', 'parentEnvironment'])
                        || value.invocation.schema !== 'fsusblog.controller-owned-correctness-envelope.v1'
                        || typeof value.invocation.options?.producerId !== 'string'
                        || typeof value.invocation.options?.key !== 'string'
                        || !value.invocation.options.producerId || !value.invocation.options.key)
                    {
                        throw new Error('nested execution producer invocation is incomplete');
                    }
                    const attemptKey = nestedDigest({ context: descriptor.reference.context, identity,
                        producerId: value.invocation.options.producerId, attemptId: value.invocation.options.key });
                    if (attemptKeys.has(attemptKey))
                    {
                        throw new Error('nested execution current-peer producer attempt was already prepared');
                    }
                    attemptKeys.add(attemptKey);
                    const attempt = { identity: structuredClone(identity), invocation: structuredClone(value.invocation),
                        phase: 'preparing', physicalStarted: false, physicalExecution: null,
                        retainedDirectories: null, prepared: null, reference: null };
                    const id = randomUUID();
                    attempts.set(id, attempt);
                    attempt.preparationOwner = preparationOwner(attempt, { identity, assertAdmission,
                        signal: controller.signal });
                    try
                    {
                        const { prepareAuthenticatedNestedEnvelope } = await import('./run-deterministic-command.mjs');
                        attempt.prepared = await prepareAuthenticatedNestedEnvelope({ invocation: value.invocation,
                            descriptor, identity, controlEnvironment: controlEnv, assertAdmission,
                            preparationOwner: attempt.preparationOwner,
                            retainAttempt: (prepared) =>
                            {
                                if (attempt.retainedDirectories !== null)
                                {
                                    throw new Error('nested execution preparation already retained its original directory owner');
                                }
                                attempt.retainedDirectories = prepared;
                                const owned = inspectOwnedPrivateTmp(prepared.privateTmpCapability);
                                if (owned.runId !== descriptor.reference.context.runId
                                    || owned.producerId !== value.invocation.options.producerId
                                    || owned.attemptId !== value.invocation.options.key)
                                {
                                    throw new Error('nested execution preparation directory belongs to a different actual attempt');
                                }
                            } });
                        await assertAdmission();
                        const execution = attempt.prepared.execution;
                        if (attempt.retainedDirectories === null
                            || execution.linuxOwnedPrivateTmp !== attempt.retainedDirectories.privateTmpCapability)
                        {
                            throw new Error('nested execution requires the same original retained directory capability');
                        }
                        const published = publicExecution(execution);
                        const executionDigest = nestedDigest(published);
                        const owned = inspectOwnedPrivateTmp(execution.linuxOwnedPrivateTmp, {
                            environment: execution.env, readWritePaths: execution.linuxReadWritePaths
                        });
                        if (owned.runId !== descriptor.reference.context.runId
                            || owned.producerId !== value.invocation.options.producerId
                            || owned.attemptId !== value.invocation.options.key
                            || execution.env.FSUSBLOG_TEST_SOURCE_COMMIT !== descriptor.reference.context.sourceState.commit
                            || String(execution.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').replace(/^sha256:/u, '')
                                !== descriptor.reference.context.sourceState.worktreeFingerprint
                            || attempt.prepared.publicEnvelope.executionDigest !== executionDigest
                            || nestedDigest(attempt.prepared.publicEnvelope.publicExecution) !== executionDigest)
                        {
                            throw new Error('nested execution producer public tuple differs from its actual prepared execution');
                        }
                        attempt.execution = { ...structuredClone(published), linuxOwnedPrivateTmp: execution.linuxOwnedPrivateTmp };
                        attempt.reference = Object.freeze({ schema: attemptSchema, id, channelId: descriptor.id,
                            bindingDigest: nestedDigest({ context: descriptor.reference.context, identity,
                                invocation: value.invocation, owned, executionDigest }), executionDigest });
                        attempt.phase = 'prepared';
                        await reply(message.id, { kind: 'result', result: {
                            ...attempt.prepared.publicEnvelope, reference: attempt.reference } });
                    }
                    catch (error)
                    {
                        if (attempt.phase === 'preparing')
                        {
                            attempt.phase = 'prepare-failed';
                        }
                        attempt.failure = error;
                        throw error;
                    }
                    return;
                }
                const attempt = lookupAttempt(value.reference, identity);
                await assertAdmission();
                if (value.kind === 'finalize')
                {
                    const finalized = await finalizeAttempt(attempt);
                    await reply(message.id, { kind: 'result', result: finalized });
                    return;
                }
                if (attempt.phase !== 'prepared' || value.executionDigest !== attempt.reference.executionDigest)
                {
                    throw new Error('nested execution attempt is already consumed or its derived tuple differs');
                }
                inspectOwnedPrivateTmp(attempt.execution.linuxOwnedPrivateTmp, {
                    environment: attempt.execution.env, readWritePaths: attempt.execution.linuxReadWritePaths
                });
                // Consume before the first asynchronous execution effect; duplicate runs cannot race.
                attempt.phase = 'running';
                attempt.physicalStarted = true;
                const stream = (name) => new Writable({ write(chunk, _encoding, done)
                {
                    request.outputBytes += chunk.length;
                    reply(message.id, { kind: name, data: chunk.toString('base64') }).then(() => done(), done);
                } });
                const stdout = stream('stdout');
                const stderr = stream('stderr');
                let result;
                try
                {
                    result = await runNested({ ...attempt.execution,
                        env: { ...attempt.execution.env, [nestedExecutionChannelKey]: JSON.stringify(descriptor) },
                        signal: controller.signal, stdout, stderr });
                    attempt.physicalExecution = result;
                }
                catch (error)
                {
                    attempt.physicalExecution = error?.physicalExecution ?? null;
                    attempt.failure = error;
                    throw error;
                }
                finally
                {
                    attempt.phase = 'terminal';
                }
                records.push({ caller: identity, authority: result.containmentAuthority, postObservation: result.postObservation,
                    logComplete: result.logComplete && (!request.disconnected || request.outputBytes === 0) });
                await reply(message.id, { kind: 'result', result });
            }
            catch (error)
            {
                if (error.physicalExecution)
                {
                    records.push({ authority: error.physicalExecution.containmentAuthority,
                        postObservation: error.physicalExecution.postObservation, error: error.message,
                        logComplete: error.physicalExecution.logComplete && (!request.disconnected || request.outputBytes === 0) });
                }
                try
                {
                    await reply(message.id, { kind: 'error', error: serializedError(error) });
                }
                catch (transportError)
                {
                    fail(transportError);
                }
            }
        })();
        request.promise.finally(() => requests.delete(message.id));
    };
    const reader = (async () =>
    {
        try
        {
            for await (const message of messages(child.stdout, maximumBytes))
            {
                await dispatch(message);
            }
            if (!closing)
            {
                throw new Error(`nested execution broker exited: ${diagnostics}`);
            }
        }
        catch (error)
        {
            fail(error);
        }
    })();
    const startupTimer = setTimeout(() => fail(new Error('nested execution broker startup timed out')),
        policy.systemdResourceStartupTimeoutMs);
    try
    {
        await readyPromise;
    }
    catch (error)
    {
        closing = true;
        signal?.removeEventListener('abort', abort);
        child.kill('SIGKILL');
        try
        {
            await awaitExit();
            removeDirectory();
        }
        catch (cleanupError)
        {
            error.nestedExecutionCleanupError = cleanupError;
        }
        throw error;
    }
    finally
    {
        clearTimeout(startupTimer);
    }
    const channel = {
        descriptor,
        async close()
        {
            closing = true;
            signal?.removeEventListener('abort', abort);
            abortRequests(new Error('nested execution root settled'));
            await Promise.all([...requests.values()].map((request) => request.promise));
            try
            {
                if (child.exitCode === null && child.signalCode === null)
                {
                    await send(child.stdin, { kind: 'shutdown' });
                    child.stdin.end();
                }
                await awaitExit();
            }
            catch (error)
            {
                failure ??= error;
                child.kill('SIGKILL');
                await awaitExit();
            }
            await reader;
            for (const attempt of attempts.values())
            {
                try
                {
                    if (['prepared', 'terminal'].includes(attempt.phase))
                    {
                        await finalizeAttempt(attempt);
                    }
                    else if (attempt.phase === 'prepare-failed')
                    {
                        attempt.preparationOwner.assertFinalizablePreparation();
                        const fragment = attempt.retainedDirectories?.fragment;
                        if (fragment && (fragment.cleanup?.status !== 'complete'
                            || fragment.cleanup.removedOwnedRoot !== true
                            || fs.lstatSync(fragment.ownedRoot, { throwIfNoEntry: false })))
                        {
                            throw attempt.failure ?? new Error('nested execution preparation retained its original directory obligation');
                        }
                    }
                    else if (attempt.phase !== 'finalized')
                    {
                        throw attempt.failure ?? new Error('nested execution directory finalization remains unverifiable');
                    }
                }
                catch (error)
                {
                    failure ??= error;
                }
            }
            const residual = records.some((record) => record.postObservation !== 'zero-members');
            if (failure || residual)
            {
                throw failure ?? new Error('nested execution retained an unverified process tree');
            }
            removeDirectory();
            return { schema, channelId: descriptor.id, records, postObservation: 'zero-members',
                logComplete: records.every((record) => record.logComplete === true) };
        }
    };
    channelCapabilities.add(channel);
    return channel;
}

async function requestNestedExecution({ descriptor, phase, signal, policy, stdout, stderr })
{
    const identity = currentProcessIdentity();
    await authorize(descriptor, identity);
    const nonce = randomUUID();
    const socket = net.createConnection(descriptor.socket.path);
    const cancel = () =>
    {
        send(socket, { kind: 'cancel' }).catch(() => socket.destroy());
    };
    const timer = setTimeout(() => socket.destroy(new Error('nested execution authentication timed out')),
        policy.systemdResourceStartupTimeoutMs);
    const sinkError = (error) => socket.destroy(error);
    for (const output of new Set([stdout, stderr]))
    {
        output?.on?.('error', sinkError);
    }
    let authenticated = false;
    try
    {
        await new Promise((resolve, reject) =>
        {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        assertSocket(descriptor);
        await send(socket, { ...phase, nonce });
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted)
        {
            cancel();
        }
        for await (const message of messages(socket, policy.maximumCapturedOutputBytesPerStream * 16))
        {
            if (message.kind === 'hello' && !authenticated)
            {
                if (message.hello?.nonce !== nonce || message.hello?.channelId !== descriptor.id
                    || JSON.stringify(message.hello?.peer) !== JSON.stringify(identity)
                    || !verify(null, Buffer.from(JSON.stringify(message.hello)), descriptor.publicKey,
                        Buffer.from(message.signature, 'base64')))
                {
                    throw new Error('nested execution owner authentication failed');
                }
                authenticated = true;
                clearTimeout(timer);
            }
            else if (!authenticated)
            {
                throw new Error('nested execution owner did not authenticate its response');
            }
            else if (['stdout', 'stderr'].includes(message.kind))
            {
                const output = message.kind === 'stdout' ? stdout : stderr;
                if (output?.write(Buffer.from(message.data, 'base64')) === false)
                {
                    await new Promise((resolve, reject) =>
                    {
                        let drainTimer;
                        const finish = (error) =>
                        {
                            clearTimeout(drainTimer);
                            output.off?.('drain', drained);
                            socket.off('close', disconnected);
                            if (error)
                            {
                                reject(error);
                            }
                            else
                            {
                                resolve();
                            }
                        };
                        const drained = () => finish();
                        const disconnected = () => finish(new Error('nested output disconnected before drain'));
                        output.once?.('drain', drained);
                        socket.once('close', disconnected);
                        drainTimer = setTimeout(() => finish(new Error('nested output drain timed out')), policy.pipeCloseTimeoutMs);
                        if (socket.destroyed)
                        {
                            disconnected();
                        }
                    });
                }
            }
            else if (message.kind === 'error')
            {
                throw Object.assign(new Error(message.error.message), message.error);
            }
            else if (message.kind === 'result')
            {
                return message.result;
            }
            else
            {
                throw new Error('nested execution response is invalid');
            }
        }
        throw new Error('nested execution owner disconnected before terminal evidence');
    }
    finally
    {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        for (const output of new Set([stdout, stderr]))
        {
            output?.off?.('error', sinkError);
        }
        socket.destroy();
    }
}

/** Prepare only through the authenticated original controller and producer. */
export async function prepareNestedExecutionEnvelope({ descriptor, invocation, signal, policy })
{
    const result = await requestNestedExecution({ descriptor, signal, policy, phase: { kind: 'prepare', schema: requestSchema, invocation } });
    if (!attemptReferenceIsComplete(result?.reference) || result.reference.channelId !== descriptor.id
        || result.executionDigest !== result.reference.executionDigest
        || nestedDigest(result.publicExecution) !== result.reference.executionDigest)
    {
        throw new Error('nested execution controller returned an incomplete prepared tuple');
    }
    return result;
}

/** The child supplies a reference, never physical-started/zero-member facts. */
export async function finalizeNestedExecutionEnvelope({ descriptor, reference, signal, policy })
{
    if (!attemptReferenceIsComplete(reference) || reference.channelId !== descriptor.id)
    {
        throw new Error('nested execution finalization reference is incomplete');
    }
    return requestNestedExecution({ descriptor, signal, policy, phase: { kind: 'finalize', schema: requestSchema, reference } });
}

export async function runNestedPhysicalExecution({ descriptor, command, cwd, env, linuxPrivateNetwork,
    linuxNetworkPolicy, linuxReadWritePaths, linuxOwnedPrivateTmp = null, privateDotnetScratch = null,
    nestedEnvelopeReference = null, signal, policy, stdout, stderr })
{
    if (nestedEnvelopeReference === null)
    {
        return requestNestedExecution({ descriptor, signal, policy, stdout, stderr,
            phase: { kind: 'run', command, cwd, env, linuxPrivateNetwork, linuxNetworkPolicy, linuxReadWritePaths,
                linuxOwnedPrivateTmp: linuxOwnedPrivateTmp !== null, privateDotnetScratch } });
    }
    const executionDigest = nestedDigest(publicExecution({ command, cwd, env, linuxPrivateNetwork,
        linuxNetworkPolicy, linuxReadWritePaths, privateDotnetScratch }));
    if (!attemptReferenceIsComplete(nestedEnvelopeReference) || nestedEnvelopeReference.channelId !== descriptor.id
        || nestedEnvelopeReference.executionDigest !== executionDigest || linuxOwnedPrivateTmp !== null)
    {
        throw new Error('nested execution requires its exact v2 controller-prepared tuple; legacy directory requests are refused');
    }
    return requestNestedExecution({ descriptor, signal, policy, stdout, stderr,
        phase: { kind: 'run', schema: requestSchema, reference: nestedEnvelopeReference, executionDigest } });
}
