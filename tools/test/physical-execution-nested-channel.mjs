import { createExecutionFailureOwner, observeExecutionFailure, retainExecutionFailure, retainExecutionFailureCompatibility, retainExecutionRecovery, throwExecutionFailure } from './execution-failure-diagnostic.mjs';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { inspectOwnedPrivateTmp } from './execution-envelope-directories.mjs';
import { collectProcessIdentity, currentProcessIdentity, processIdentityStatus } from './process-identity.mjs';
import { authorizeOriginalNativeInputDelivery, beginOriginalNativeInputBrokerAttempt, bindOriginalNativeInputBroker, closeOriginalNativeInputCarrier, closeOriginalNativeInputCarrierBeforeAdmission, closeOriginalNativeInputCarrierBeforeSpawn,
    inspectOriginalNativeInputCarrier, retainOriginalNativeInputBrokerStart } from './physical-execution-native-input-carrier.mjs';

export const nestedExecutionChannelKey = 'FSUSBLOG_PHYSICAL_EXECUTION_CHANNEL';
const schema = 'fsusblog.physical-execution-nested-channel.v1';
const transportFile = fileURLToPath(new URL('./physical-execution-nested-socket.py', import.meta.url));
const channelCapabilities = new WeakSet();

/** Ordinary retained cancellation observations, never a native authority issuer. */
export function assertNestedPreparationCancellation(preparationSignal, upstreamSignal, attempt)
{
    if (preparationSignal?.aborted || upstreamSignal?.aborted)
    {
        const reason = preparationSignal?.aborted ? preparationSignal.reason : upstreamSignal.reason;
        attempt.preparationCancellationReason = reason;
        attempt.recoveryObligation ??= { ownedRoot: attempt.retainedDirectories?.fragment?.ownedRoot,
            reason: 'original preparation owner has not verified all tool terminals' };
        throw reason;
    }
}

export function retainNestedPreparationFailure(tool, preparationFailure)
{
    if (preparationFailure !== null && preparationFailure !== undefined) tool.preparationFailure = preparationFailure;
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
    const owner = createExecutionFailureOwner();
    retainExecutionFailure(owner, error);
    const primary = observeExecutionFailure(owner).diagnostic.primary;
    return { name: primary.name, message: primary.message, code: primary.code, exitCode: primary.exitCode,
        signal: primary.signal, physicalExecution: null };
}

/** One original owner executes nested requests; the broker supplies kernel peer credentials only. */
export async function createNestedExecutionChannel({ boundary, controlEnv, policy, runNested, signal,
    linuxOwnedPrivateTmp = null, originalNativeInputCarrier = null, physicalFailureOwner = null })
{
    const channelFailureOwner = createExecutionFailureOwner();
    const retainNativeCleanupObservation = (error, value) =>
    {
        retainExecutionRecovery(channelFailureOwner, { nativeInputCleanupObservation: value });
        retainExecutionFailureCompatibility(error, 'nativeInputCleanupObservation', value);
    };
    const native = originalNativeInputCarrier === null ? null : inspectOriginalNativeInputCarrier(originalNativeInputCarrier);
    if (native) observeExecutionFailure(physicalFailureOwner);
    if (native && JSON.stringify(native.binding.reference) !== JSON.stringify(boundary.reference))
        throw new Error('native input carrier belongs to a different original resource boundary');
    if (linuxOwnedPrivateTmp !== null)
    {
        inspectOwnedPrivateTmp(linuxOwnedPrivateTmp);
    }
    const maximumBytes = policy.maximumCapturedOutputBytesPerStream * 16;
    let directory, directoryIdentity, socketPath, privateKey, publicKey, nativeManifest, child;
    try
    {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-nested-'));
        directoryIdentity = fs.lstatSync(directory);
        socketPath = path.join(directory, 'owner.sock');
        ({ privateKey, publicKey } = generateKeyPairSync('ed25519'));
        nativeManifest = native ? { directory: native.directory.reference, controllerIdentity: native.controllerIdentity,
            files: native.files.map(({ descriptor, ...file }) => file),
            preexecSha256: createHash('sha256').update(fs.readFileSync(new URL('./physical-execution-linux-preexec.py', import.meta.url))).digest('hex') } : null;
        if (nativeManifest && Buffer.byteLength(JSON.stringify(nativeManifest)) > 65536)
            throw new Error('native input fixed startup data exceeds its bound');
        if (native) beginOriginalNativeInputBrokerAttempt(originalNativeInputCarrier);
        child = spawn(controlEnv.FSUSBLOG_PYTHON ?? 'python3', ['-I', '-S', transportFile, socketPath, String(maximumBytes),
            String(policy.systemdResourceStartupTimeoutMs / 1000), String(policy.pipeCloseTimeoutMs / 1000),
            ...(nativeManifest ? [JSON.stringify(nativeManifest)] : [])], {
            env: controlEnv, stdio: native ? ['pipe', 'pipe', 'pipe', 'ignore',
                native.files[0].descriptor, native.files[1].descriptor, native.directory.descriptor] : ['pipe', 'pipe', 'pipe']
        });
    }
    catch (error)
    {
        retainExecutionFailure(channelFailureOwner, error);
        if (native)
        {
            retainNativeCleanupObservation(error, { lastKnownBinding: native.binding, brokerIdentity: null,
                carrier: null, executionAuthority: false });
            const cleanupErrors = [];
            for (const cleanup of [() => closeOriginalNativeInputCarrierBeforeSpawn(originalNativeInputCarrier), () =>
            {
                if (!directory) return;
                const actual = fs.lstatSync(directory);
                if (!directoryIdentity || !actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== directoryIdentity.dev
                    || actual.ino !== directoryIdentity.ino || actual.uid !== process.getuid()
                    || fs.realpathSync(directory) !== directory || fs.readdirSync(directory).length)
                    throw new Error('unstarted ordinary broker directory changed; cleanup retained');
                fs.rmdirSync(directory);
            }])
            {
                try { cleanup(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
            }
            if (cleanupErrors.length)
            {
                const cleanupError = new AggregateError(cleanupErrors, 'unstarted carrier cleanup retained');
                retainExecutionFailure(channelFailureOwner, cleanupError);
                retainExecutionFailureCompatibility(error, 'nestedExecutionCleanupError', cleanupError);
            }
        }
        throwExecutionFailure(channelFailureOwner);
    }
    const nativeBrokerIdentity = native ? collectProcessIdentity(child.pid) : null;
    const nativeStartupFailureOwner = createExecutionFailureOwner();
    if (native)
    {
        try { retainOriginalNativeInputBrokerStart(originalNativeInputCarrier, nativeBrokerIdentity); }
        catch (error) { retainExecutionFailure(nativeStartupFailureOwner, error); }
    }
    const requests = new Map();
    const records = [];
    let closing = false;
    let descriptor;
    let nativeCarrierDescriptor = null;
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
    // A startup error may select the throw path before awaitReady; still consume every rejection.
    if (native) readyPromise.catch(() => {});
    const abortRequests = (reason) =>
    {
        for (const request of requests.values())
        {
            request.controller.abort(reason);
        }
    };
    const fail = (error) =>
    {
        retainExecutionFailure(channelFailureOwner, error);
        if (originalNativeInputCarrier) child.stdin.end();
        rejectReady(error);
        abortRequests(error);
    };
    child.once('error', fail);
    child.stdin.on('error', fail);
    const reply = (id, message) => send(child.stdin, { id, message });
    const abort = () =>
    {
        abortRequests(signal.reason ?? new Error('nested execution owner cancelled'));
        if (originalNativeInputCarrier) child.stdin.end();
    };
    signal?.addEventListener('abort', abort, { once: true });
    let nativeDelivery = null;
    const dispatch = async (message) =>
    {
        if (['native-input-request', 'native-input-delivered', 'native-input-refused'].includes(message.kind))
        {
            if (!originalNativeInputCarrier || closing || signal?.aborted)
                throw new Error('native input broker admission is closed or foreign');
            inspectOriginalNativeInputCarrier(originalNativeInputCarrier);
            if (message.kind === 'native-input-request')
            {
                if (nativeDelivery || typeof message.id !== 'string' || message.id !== `native-${message.request?.nonce}`)
                    throw new Error('native input broker request is duplicated or malformed');
                nativeDelivery = { id: message.id, delivered: false };
                const authorization = await authorizeOriginalNativeInputDelivery(originalNativeInputCarrier, message);
                inspectOriginalNativeInputCarrier(originalNativeInputCarrier);
                await send(child.stdin, authorization);
                inspectOriginalNativeInputCarrier(originalNativeInputCarrier);
            }
            else
            {
                if (!nativeDelivery || message.id !== nativeDelivery.id || nativeDelivery.delivered
                    || Object.keys(message).sort().join(',') !== 'id,kind')
                    throw new Error('native input broker completion is foreign or replayed');
                if (message.kind === 'native-input-refused')
                    throw new Error('native input broker refused its original live recipient');
                nativeDelivery.delivered = true;
            }
            return;
        }
        if (message.kind === 'ready')
        {
            if (descriptor || message.pid !== child.pid
                || (native && Object.keys(message).sort().join(',') !== 'kind,nativeInputSocket,pid'))
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
            if (originalNativeInputCarrier)
                nativeCarrierDescriptor = bindOriginalNativeInputBroker(originalNativeInputCarrier, descriptor.brokerIdentity, message.nativeInputSocket);
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
        const request = { controller, promise: null, disconnected: false, outputBytes: 0, failureOwner: createExecutionFailureOwner() };
        requests.set(message.id, request);
        request.promise = (async () =>
        {
            const assertRequestOpen = () =>
            {
                assertNestedPreparationCancellation(controller.signal, signal, request);
                if (closing) throw new Error('nested execution owner is closed');
            };
            try
            {
                assertRequestOpen();
                if (!descriptor || message.peer?.uid !== process.getuid())
                {
                    throw new Error('nested execution owner is closed or peer is foreign');
                }
                const identity = collectProcessIdentity(message.peer.pid);
                await authorize(descriptor, identity);
                assertRequestOpen();
                const value = message.request;
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
                assertRequestOpen();
                const hello = { schema, nonce: value.nonce, channelId: descriptor.id, peer: identity };
                await reply(message.id, { kind: 'hello', hello,
                    signature: sign(null, Buffer.from(JSON.stringify(hello)), privateKey).toString('base64') });
                assertRequestOpen();
                const stream = (name) => new Writable({ write(chunk, _encoding, done)
                {
                    request.outputBytes += chunk.length;
                    reply(message.id, { kind: name, data: chunk.toString('base64') }).then(() => done(), done);
                } });
                const stdout = stream('stdout');
                const stderr = stream('stderr');
                assertRequestOpen();
                const result = await runNested({ ...value, failureOwner: request.failureOwner,
                    linuxOwnedPrivateTmp: value.linuxOwnedPrivateTmp ? linuxOwnedPrivateTmp : null,
                    env: { ...value.env, [nestedExecutionChannelKey]: JSON.stringify(descriptor) },
                    signal: controller.signal, stdout, stderr });
                records.push({ caller: identity, authority: result.containmentAuthority, postObservation: result.postObservation,
                    logComplete: result.logComplete && (!request.disconnected || request.outputBytes === 0) });
                await reply(message.id, { kind: 'result', result });
            }
            catch (error)
            {
                retainExecutionFailure(request.failureOwner, error);
                const diagnostic = observeExecutionFailure(request.failureOwner).diagnostic;
                const { observePhysicalExecutionFailure } = await import('./physical-execution-process-tree.mjs');
                const observed = observePhysicalExecutionFailure(request.failureOwner);
                if (observed.physicalStarted)
                {
                    records.push({ authority: observed.physicalExecution?.containmentAuthority ?? null,
                        postObservation: observed.physicalTerminal ?? 'unverifiable',
                        error: diagnostic.primary.message,
                        logComplete: observed.physicalExecution?.logComplete === true && (!request.disconnected || request.outputBytes === 0) });
                }
                try
                {
                    await reply(message.id, { kind: 'error', error: { ...serializedError(error), physicalExecution: observed.physicalExecution } });
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
        throwExecutionFailure(nativeStartupFailureOwner);
        await readyPromise;
    }
    catch (error)
    {
        retainExecutionFailure(channelFailureOwner, error);
        closing = true;
        if (native)
        {
            rejectReady(error);
            retainNativeCleanupObservation(error, { lastKnownBinding: native.binding,
                brokerIdentity: nativeBrokerIdentity, carrier: nativeCarrierDescriptor, executionAuthority: false });
        }
        signal?.removeEventListener('abort', abort);
        child.kill('SIGKILL');
        try
        {
            await awaitExit();
            if (originalNativeInputCarrier)
            {
                await reader;
                const cleanupErrors = [];
                for (const cleanup of [() => closeOriginalNativeInputCarrierBeforeAdmission(originalNativeInputCarrier, nativeBrokerIdentity), removeDirectory])
                {
                    try { cleanup(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
                }
                if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'startup carrier cleanup retained');
            }
            else removeDirectory();
        }
        catch (cleanupError)
        {
            retainExecutionFailure(channelFailureOwner, cleanupError);
        }
        throwExecutionFailure(channelFailureOwner);
    }
    finally
    {
        clearTimeout(startupTimer);
    }
    const channel = {
        descriptor,
        ...(native ? { nativeInputCleanupObservation: { lastKnownBinding: native.binding,
            brokerIdentity: nativeBrokerIdentity, carrier: nativeCarrierDescriptor, executionAuthority: false } } : {}),
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
                    if (!originalNativeInputCarrier || !child.stdin.writableEnded)
                    {
                        await send(child.stdin, { kind: 'shutdown' });
                        child.stdin.end();
                    }
                }
                await awaitExit();
            }
            catch (error)
            {
                retainExecutionFailure(channelFailureOwner, error);
                child.kill('SIGKILL');
                await awaitExit();
            }
            await reader;
            const residual = records.some((record) => record.postObservation !== 'zero-members');
            if (residual) retainExecutionFailure(channelFailureOwner, new Error('nested execution retained an unverified process tree'));
            throwExecutionFailure(channelFailureOwner);
            if (originalNativeInputCarrier)
            {
                // The held carrier owner reads its original matching invocation observation itself.
                await closeOriginalNativeInputCarrier(originalNativeInputCarrier, {
                    failureOwner: physicalFailureOwner, brokerGone: true });
            }
            removeDirectory();
            return { schema, channelId: descriptor.id, records, postObservation: 'zero-members',
                logComplete: records.every((record) => record.logComplete === true) };
        }
    };
    channelCapabilities.add(channel);
    return channel;
}

export async function runNestedPhysicalExecution({ descriptor, command, cwd, env, linuxPrivateNetwork,
    linuxNetworkPolicy, linuxReadWritePaths, linuxOwnedPrivateTmp = null, privateDotnetScratch = null,
    signal, policy, stdout, stderr })
{
    const attempt = {};
    const assertOpen = () => assertNestedPreparationCancellation(signal, undefined, attempt);
    assertOpen();
    const identity = currentProcessIdentity();
    await authorize(descriptor, identity);
    assertOpen();
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
        assertOpen();
        assertSocket(descriptor);
        signal?.addEventListener('abort', cancel, { once: true });
        assertOpen();
        await send(socket, { kind: 'run', nonce, command, cwd, env, linuxPrivateNetwork, linuxNetworkPolicy, linuxReadWritePaths,
            linuxOwnedPrivateTmp: linuxOwnedPrivateTmp !== null, privateDotnetScratch });
        assertOpen();
        for await (const message of messages(socket, policy.maximumCapturedOutputBytesPerStream * 16))
        {
            assertOpen();
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
