import { createExecutionFailureOwner, retainExecutionFailure, retainExecutionFailureCompatibility, throwExecutionFailure } from './execution-failure-diagnostic.mjs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertProductionSystemdExecutionBoundary, inspectProductionSystemdServiceBinding } from '../test-matrix/production-systemd-resource-boundary.mjs';
import { digestCanonical, freezeDeep } from '../test-fixtures/receipt/canonical.mjs';
import { inspectOriginalCurrentSchemaCollectorInputs } from './current-schema-native-inputs.mjs';
import { closeClosedNativeInputDirectory, createClosedNativeInputDirectory,
    inspectClosedNativeInputDirectory, inspectOwnedPrivateTmp } from './execution-envelope-directories.mjs';
import { originalFileEpochObservationSha256 } from './original-native-file-epoch.mjs';
import { collectProcessIdentity, currentProcessIdentity, processIdentityStatus } from './process-identity.mjs';

const carriers = new WeakMap();
const schema = 'fsusblog.original-native-input-carrier.v1';
const fail = (reason) => { throw new Error(`original native input carrier: ${reason}`); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identityKeys = 'device,inode,mode,path,uid';

function socketIdentity(file)
{
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid())
        || (stat.mode & 0o7777n) !== 0o600n) fail('socket is not the original private UID/mode');
    return { path: file, device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode), uid: String(stat.uid) };
}

export function nativeInputCarrierIsComplete(value)
{
    try
    {
        requireCommand(value.command, value.files, value.reference.context);
        return Boolean(value && Object.keys(value).sort().join(',') ===
            'attempt,brokerIdentity,command,controllerIdentity,directory,files,id,invocationId,reference,schema,socket'
            && value.schema === schema && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.id)
            && value.reference?.schema === 'fsusblog.production-systemd-resource-boundary.v1'
            && value.directory?.schema === 'fsusblog.closed-native-input-directory.v1'
            && Object.keys(value.directory).sort().join(',') === 'alias,ancestors,device,guestSocketPath,inode,mode,path,schema,uid'
            && Object.keys(value.directory.alias).sort().join(',') === 'attemptId,destination,device,inode,ownedRoot,producerId,runId,source,toolCache,uid'
            && value.directory.alias.destination === '/tmp'
            && value.directory.alias.runId === value.reference.context?.runId
            && ['device', 'inode', 'mode', 'uid'].every((key) => /^(?:0|[1-9][0-9]*)$/u.test(value.directory[key]))
            && (BigInt(value.directory.mode) & 0o7777n) === 0o700n
            && (BigInt(value.directory.mode) & 0o170000n) === 0o40000n
            && value.directory.uid === value.directory.alias.uid
            && path.isAbsolute(value.directory.alias.source)
            && path.isAbsolute(value.directory.alias.ownedRoot)
            && value.directory.alias.source.startsWith(value.directory.alias.ownedRoot + '/')
            && value.directory.alias.ownedRoot.startsWith(value.reference.context.root + '/.tmp/')
            && Array.isArray(value.directory.ancestors)
            && value.directory.path === path.join(value.directory.alias.source, path.basename(value.directory.path))
            && /^fsus-nativeinput-[a-f0-9]{32}$/u.test(path.basename(value.directory.path))
            && value.directory.guestSocketPath === `/tmp/${path.basename(value.directory.path)}/inputs.sock`
            && Buffer.byteLength(value.directory.guestSocketPath, 'utf8') <= 107
            && value.socket && Object.keys(value.socket).sort().join(',') === identityKeys
            && value.socket.path === path.join(value.directory.path, 'inputs.sock')
            && ['device', 'inode', 'mode', 'uid'].every((key) => /^(?:0|[1-9][0-9]*)$/u.test(value.socket[key]))
            && ['brokerIdentity', 'controllerIdentity'].every((key) => value[key]?.status === 'verified'
                && value[key].schema === 'fsusblog.process-identity.v1' && Number.isSafeInteger(value[key].pid)
                && value[key].pid > 0 && typeof value[key].processStartIdentity === 'string'
                && /^sha256:[a-f0-9]{64}$/u.test(value[key].executableDigest)
                && /^sha256:[a-f0-9]{64}$/u.test(value[key].commandDigest))
            && Array.isArray(value.command) && value.command.every((item) => typeof item === 'string')
            && typeof value.invocationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value.invocationId)
            && /^[1-9][0-9]*$/u.test(value.attempt)
            && value.files[0].path === path.join(value.reference.context.root, '.tmp/test-runs', value.reference.context.runId,
                'native-current-schema', value.invocationId, `attempt-${value.attempt}`, 'inputs/primary.env')
            && value.files[1].path === path.join(value.reference.context.root, '.tmp/test-runs', value.reference.context.runId,
                'native-current-schema', value.invocationId, `attempt-${value.attempt}`, 'published/current-schema-receipt.bin')
            && Array.isArray(value.files) && value.files.length === 2
            && value.files.every((file, index) => file.role === ['collector-environment', 'collector-receipt'][index]
                && file.targetDescriptor === index + 4 && path.isAbsolute(file.path)
                && Object.keys(file).sort().join(',') === 'artifactSha256,epochSha256,path,role,targetDescriptor'
                && /^[a-f0-9]{64}$/u.test(file.artifactSha256) && /^[a-f0-9]{64}$/u.test(file.epochSha256)));
    } catch { return false; }
}

function original(carrier)
{
    const held = carriers.get(carrier);
    if (!held || held.closed || held.revoked) fail('actual open in-process input carrier required');
    try
    {
        held.signal?.throwIfAborted();
        assertProductionSystemdExecutionBoundary(held.boundary, { expectedContext: held.context });
        if (processIdentityStatus(held.controllerIdentity).status !== 'live') fail('original parent is not live');
        const directory = inspectClosedNativeInputDirectory(held.directory);
        const files = inspectOriginalCurrentSchemaCollectorInputs(held.inputs);
        if (digestCanonical(files.map(({ descriptor, ...file }) => file)) !== digestCanonical(held.files))
            fail('original retained input binding changed');
        if (held.descriptor && (digestCanonical(socketIdentity(held.descriptor.socket.path)) !== digestCanonical(held.descriptor.socket)
            || processIdentityStatus(held.descriptor.brokerIdentity).status !== 'live')) fail('original broker/socket changed');
        return { held, directory, files };
    }
    catch (error) { held.revoked = true; throw error; }
}

async function sourceCurrent(carrier)
{
    const { held } = original(carrier);
    const { snapshotSourceState } = await import('../test-matrix/scheduler.mjs');
    original(carrier);
    try
    {
        const actual = await snapshotSourceState(held.context.root);
        original(carrier);
        if (digestCanonical(actual) !== digestCanonical(held.context.sourceState)) fail('actual original source snapshot changed');
    }
    catch (error) { held.revoked = true; throw error; }
}

function requireCommand(command, files, context)
{
    if (!Array.isArray(command) || command.length !== 17 || command[2] !== 'current-schema-check-owned-inputs'
        || !path.isAbsolute(command[0]) || !path.isAbsolute(command[1])
        || command.some((value) => typeof value !== 'string' || /[\p{Cc}]/u.test(value)))
        fail('fixed original owned collector argv required');
    const flags = ['--receipt', '--receipt-sha256', '--candidate-source-revision', '--env-file',
        '--env-sha256', '--env-epoch-sha256', '--receipt-epoch-sha256'];
    const values = [files[1].path, files[1].artifactSha256, context.sourceState.commit, files[0].path,
        files[0].artifactSha256, files[0].epochSha256, files[1].epochSha256];
    for (let index = 0; index < flags.length; index += 1)
        if (command[3 + 2 * index] !== flags[index] || command[4 + 2 * index] !== values[index])
            fail('collector argv differs from the actual original held input expectations');
}

/** Ordinary transport custody only; this does not issue a native issuer/qualification grant. */
export async function createOriginalNativeInputCarrier({ originalNativeInputs, linuxOwnedPrivateTmp,
    resourceBoundary, resourceContext, command, env, linuxReadWritePaths, signal })
{
    // Provenance gate precedes inspecting secret bytes or creating a directory.
    assertProductionSystemdExecutionBoundary(resourceBoundary, { expectedContext: resourceContext });
    signal?.throwIfAborted();
    const alias = inspectOwnedPrivateTmp(linuxOwnedPrivateTmp, { environment: env, readWritePaths: linuxReadWritePaths });
    const files = inspectOriginalCurrentSchemaCollectorInputs(originalNativeInputs);
    if (alias.runId !== resourceContext.runId) fail('input alias belongs to a different actual run');
    const prefix = path.join(resourceContext.root, '.tmp/test-runs', resourceContext.runId, 'native-current-schema') + '/';
    if (!files[0].path.startsWith(prefix)) fail('collector input is outside its original current-run root');
    const relative = files[0].path.slice(prefix.length);
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/attempt-([1-9][0-9]*)\/inputs\/primary\.env$/u.exec(relative);
    if (!match || files[1].path !== `${prefix}${match[1]}/attempt-${match[2]}/published/current-schema-receipt.bin`)
        fail('fixed invocation/attempt file roles required');
    requireCommand(command, files, resourceContext);
    const context = freezeDeep(structuredClone(resourceContext));
    const fixedFiles = freezeDeep(files.map(({ descriptor, ...file }) => file));
    const fixedCommand = freezeDeep([...command]);
    const controllerIdentity = freezeDeep(currentProcessIdentity());
    const carrier = Object.freeze({});
    const held = { boundary: resourceBoundary, context, inputs: originalNativeInputs,
        directory: createClosedNativeInputDirectory(linuxOwnedPrivateTmp),
        files: fixedFiles, command: fixedCommand,
        invocationId: match[1], attempt: match[2], controllerIdentity,
        signal, closed: false, revoked: false, descriptor: null, pending: null, consumed: false, brokerAttemptStarted: false };
    carriers.set(carrier, held);
    try { await sourceCurrent(carrier); return carrier; }
    catch (error)
    {
        const failureOwner = createExecutionFailureOwner();
        retainExecutionFailure(failureOwner, error);
        held.revoked = true;
        try { closeClosedNativeInputDirectory(held.directory); held.closed = true; }
        catch (cleanupError)
        {
            retainExecutionFailure(failureOwner, cleanupError);
            retainExecutionFailureCompatibility(error, 'nativeInputCleanupError', cleanupError);
        }
        throwExecutionFailure(failureOwner);
    }
}

export function inspectOriginalNativeInputCarrier(carrier, { command = null } = {})
{
    const { held, directory, files } = original(carrier);
    if (command && digestCanonical(command) !== digestCanonical(held.command)) fail('foreign native input command');
    return { descriptor: held.descriptor, directory, files, controllerIdentity: held.controllerIdentity,
        binding: { reference: held.boundary.reference, invocationId: held.invocationId, attempt: held.attempt,
            command: held.command, directory: directory.reference, files: held.files } };
}

/** An attempted spawn is not proof of no actor, even when identity capture fails. */
export function beginOriginalNativeInputBrokerAttempt(carrier)
{
    const { held } = original(carrier);
    if (held.brokerAttemptStarted || held.brokerStart || held.descriptor || held.retentionStarted || held.pending || held.authority)
        fail('original broker attempt is single-use before any actor/service admission');
    held.brokerAttemptStarted = true;
}

/** Retain the actual original child incarnation before any asynchronous startup wait. */
export function retainOriginalNativeInputBrokerStart(carrier, identity)
{
    const { held, directory } = original(carrier);
    if (!held.brokerAttemptStarted || held.brokerStart || identity.status !== 'verified' || processIdentityStatus(identity).status !== 'live')
        fail('original broker start is single-use and requires its actual live child');
    const fields = fs.readFileSync(`/proc/${identity.pid}/stat`, 'utf8').split(')').at(-1).trim().split(/\s+/u);
    const command = fs.readFileSync(`/proc/${identity.pid}/cmdline`, 'utf8').split('\0').slice(0, -1);
    if (Number(fields[1]) !== held.controllerIdentity.pid || command.length !== 9
        || command[1] !== '-I' || command[2] !== '-S'
        || command[3] !== fileURLToPath(new URL('./physical-execution-nested-socket.py', import.meta.url))
        || digestCanonical(JSON.parse(command[8]).directory) !== digestCanonical(directory.reference))
        fail('broker is not the original direct fixed-source carrier child');
    held.brokerStart = freezeDeep(structuredClone(identity));
}

export function bindOriginalNativeInputBroker(carrier, identity, observedSocket)
{
    const { held, directory } = original(carrier);
    if (!held.brokerStart || digestCanonical(identity) !== digestCanonical(held.brokerStart)
        || held.descriptor || identity.status !== 'verified' || processIdentityStatus(identity).status !== 'live')
        fail('broker binding is one-shot and requires an actual live process');
    const socket = socketIdentity(path.join(directory.reference.path, 'inputs.sock'));
    if (digestCanonical(socket) !== digestCanonical(observedSocket)) fail('broker-created socket differs from actual parent readback');
    const descriptor = { schema, id: randomUUID(), reference: held.boundary.reference,
        invocationId: held.invocationId, attempt: held.attempt, command: held.command,
        controllerIdentity: held.controllerIdentity, brokerIdentity: identity,
        directory: directory.reference, files: held.files,
        socket };
    if (!nativeInputCarrierIsComplete(descriptor)) fail('actual prepared input carrier is incomplete');
    held.descriptor = freezeDeep(descriptor);
    return descriptor;
}

/** Mark an attempted durable retention; uncertainty must retain cleanup artifacts. */
export function beginOriginalNativeInputServiceRetention(carrier, authority)
{
    const { held } = original(carrier);
    if (held.retentionStarted || authority.phase !== 'prepared'
        || digestCanonical(authority.nativeInputCarrier) !== digestCanonical(held.descriptor))
        fail('original prepared native service retention is one-shot');
    held.retentionStarted = true;
}

/** Cleanup DATA only: never reopens a revoked execution capability. */
export async function retainOriginalNativeInputPreparedService(carrier, authority)
{
    const held = carriers.get(carrier);
    if (!held || held.closed || !held.retentionStarted || held.authority || authority.phase !== 'prepared'
        || digestCanonical(authority.nativeInputCarrier) !== digestCanonical(held.descriptor))
        fail('original independently retained prepared service required');
    assertProductionSystemdExecutionBoundary(held.boundary, { expectedContext: held.context });
    const { assertProductionBuildRetainedNativeInputIntent } = await import('../test-matrix/production-build-layout.mjs');
    assertProductionSystemdExecutionBoundary(held.boundary, { expectedContext: held.context });
    if (held.closed) fail('original input custody closed during prepared readback');
    assertProductionBuildRetainedNativeInputIntent(held.descriptor, authority);
    held.authority = freezeDeep(structuredClone(authority));
}

export async function prepareOriginalNativeInputReceive(carrier, { authority, identity, controlGroup, registration, registrationBytes })
{
    await sourceCurrent(carrier);
    const { held } = original(carrier);
    if (!held.authority || authority.authorityId !== held.authority.authorityId
        || held.pending || held.consumed || !held.descriptor || authority.nativeInputCarrier !== held.descriptor
        && digestCanonical(authority.nativeInputCarrier) !== digestCanonical(held.descriptor))
        fail('receive requires one original independently retained invocation');
    const { authorizeProductionBuildNativeInputProcess } = await import('../test-matrix/production-build-layout.mjs');
    original(carrier);
    authorizeProductionBuildNativeInputProcess(held.descriptor, identity, authority.authorityId);
    original(carrier);
    if (registration.pid !== identity.pid || registration.startIdentity !== identity.processStartIdentity
        || registration.authorityId !== authority.authorityId || digestCanonical(registration.command) !== digestCanonical(held.command)
        || registration.cgroup !== `0::${controlGroup}\n`
        || fs.readFileSync(`/proc/${identity.pid}/cgroup`, 'utf8') !== registration.cgroup)
        fail('actual original registration differs from required receiver');
    if (typeof registrationBytes !== 'string' || digestCanonical(JSON.parse(registrationBytes)) !== digestCanonical(registration))
        fail('original registration bytes required');
    held.authority = freezeDeep(structuredClone(authority));
    held.pending = { authorityId: authority.authorityId, identity: freezeDeep(structuredClone(identity)),
        cgroup: registration.cgroup, registrationSha256: sha256(Buffer.from(registrationBytes)) };
    return { ...held.pending, carrier: held.descriptor };
}

export async function authorizeOriginalNativeInputDelivery(carrier, request)
{
    await sourceCurrent(carrier);
    const { held } = original(carrier);
    const pending = held.pending;
    if (!pending || held.consumed || request.request.authorityId !== pending.authorityId
        || request.request.registrationSha256 !== pending.registrationSha256
        || request.peer.pid !== pending.identity.pid || request.peer.uid !== process.getuid()
        || collectProcessIdentity(request.peer.pid).processStartIdentity !== pending.identity.processStartIdentity)
        fail('native FD request is foreign, stale or already consumed');
    const { authorizeProductionBuildNativeInputProcess } = await import('../test-matrix/production-build-layout.mjs');
    original(carrier);
    authorizeProductionBuildNativeInputProcess(held.descriptor, pending.identity, pending.authorityId);
    original(carrier);
    held.consumed = true;
    return { kind: 'authorize-native-inputs', id: request.id, request: request.request,
        cgroup: pending.cgroup,
        peer: { pid: pending.identity.pid, uid: process.getuid(), startIdentity: pending.identity.processStartIdentity } };
}

export async function validateOriginalNativeInputRegistration(carrier, initial, final)
{
    await sourceCurrent(carrier);
    const { held } = original(carrier);
    const { nativeInputs, ...preserved } = final;
    if (!held.consumed || digestCanonical(initial) !== digestCanonical(preserved)
        || !nativeInputs || Object.keys(nativeInputs).sort().join(',') !== 'carrier,descriptorFlags,files,liveObservation'
        || digestCanonical(nativeInputs.carrier) !== digestCanonical(held.descriptor)
        || !Array.isArray(nativeInputs.files) || nativeInputs.files.length !== 2)
        fail('final registration lacks the exact initial state and original carrier');
    const liveObservation = { mountNamespaceId: fs.readlinkSync(`/proc/${held.pending.identity.pid}/ns/mnt`),
        controllerMountNamespaceId: fs.readlinkSync(`/proc/${held.controllerIdentity.pid}/ns/mnt`),
        brokerMountNamespaceId: fs.readlinkSync(`/proc/${held.descriptor.brokerIdentity.pid}/ns/mnt`),
        socket: held.descriptor.socket, guestSocketPath: held.descriptor.directory.guestSocketPath };
    if (digestCanonical(nativeInputs.liveObservation) !== digestCanonical(liveObservation)
        || nativeInputs.liveObservation.mountNamespaceId !== initial.ownedPrivateTmp?.mountNamespace
        || !Array.isArray(nativeInputs.descriptorFlags) || nativeInputs.descriptorFlags.length !== 2
        || fs.readFileSync(`/proc/${held.pending.identity.pid}/cgroup`, 'utf8') !== held.pending.cgroup
        || processIdentityStatus(held.pending.identity).status !== 'live')
        fail('actual final namespace/peer/cgroup binding differs');
    for (let index = 0; index < held.files.length; index += 1)
    {
        const flags = nativeInputs.descriptorFlags[index];
        if (Object.keys(flags).sort().join(',') !== 'cloexec,getfl,targetDescriptor'
            || flags.targetDescriptor !== index + 4 || flags.cloexec !== true
            || !Number.isSafeInteger(flags.getfl) || (flags.getfl & 3) !== 0 || (flags.getfl & 0o10000000) !== 0)
            fail('actual final fixed input descriptor is not readonly/cloexec');
        const observed = nativeInputs.files[index];
        const { epoch, ...data } = observed;
        if (digestCanonical(data) !== digestCanonical(held.files[index])
            || originalFileEpochObservationSha256(epoch) !== held.files[index].epochSha256)
            fail('final actual input role/bytes/full epoch differs from retained original');
    }
    if (nativeInputs.files[0].epoch.leaf.deviceMajor === nativeInputs.files[1].epoch.leaf.deviceMajor
        && nativeInputs.files[0].epoch.leaf.deviceMinor === nativeInputs.files[1].epoch.leaf.deviceMinor
        && nativeInputs.files[0].epoch.leaf.inode === nativeInputs.files[1].epoch.leaf.inode)
        fail('final input roles alias one inode');
}

function originalProcessGone(identity)
{
    const observed = processIdentityStatus(identity);
    if (observed.status === 'dead') return true;
    if (observed.status === 'live') return false;
    if (observed.status === 'mismatch' && observed.actual?.status === 'verified'
        && observed.actual.processStartIdentity !== identity.processStartIdentity) return true;
    fail('original input broker incarnation is unverifiable');
}

function requireRetainedDirectoryAncestors(reference)
{
    const expectedPaths = [];
    for (let name = path.dirname(reference.path); ; name = path.dirname(name))
    {
        expectedPaths.unshift(name);
        if (name === '/') break;
    }
    if (!Array.isArray(reference.ancestors) || reference.ancestors.length !== expectedPaths.length)
        fail('retained input directory ancestor roster differs');
    reference.ancestors.forEach((row, index) =>
    {
        if (Object.keys(row).sort().join(',') !== 'device,gid,inode,mode,path,uid' || row.path !== expectedPaths[index])
            fail('retained input directory ancestor binding differs');
        const stat = fs.lstatSync(row.path, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()
            || ['device', 'inode', 'mode', 'uid', 'gid'].some((key) => row[key] !== String(stat[key === 'device' ? 'dev' : key === 'inode' ? 'ino' : key])))
            fail('retained input directory actual ancestor changed');
    });
    const source = fs.lstatSync(reference.alias.source, { bigint: true });
    if (String(source.dev) !== reference.alias.device || String(source.ino) !== reference.alias.inode
        || source.uid !== BigInt(process.getuid()) || (source.mode & 0o7777n) !== 0o700n
        || fs.realpathSync(reference.alias.source) !== reference.alias.source)
        fail('retained original input alias incarnation changed');
}

export function inspectNativeInputCarrierArtifacts(descriptor)
{
    if (!nativeInputCarrierIsComplete(descriptor)) fail('complete original carrier recovery DATA required');
    requireRetainedDirectoryAncestors(descriptor.directory);
    const brokerGone = originalProcessGone(descriptor.brokerIdentity);
    const stat = fs.lstatSync(descriptor.directory.path, { bigint: true, throwIfNoEntry: false });
    if (!stat) return { status: 'absent', brokerGone: brokerGone };
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(descriptor.directory.path) !== descriptor.directory.path
        || String(stat.dev) !== descriptor.directory.device || String(stat.ino) !== descriptor.directory.inode
        || String(stat.uid) !== descriptor.directory.uid || String(stat.mode) !== descriptor.directory.mode
        || fs.readdirSync(descriptor.directory.path).some((name) => name !== 'inputs.sock'))
        fail('retained input carrier directory changed; cleanup refused');
    const socket = fs.lstatSync(descriptor.socket.path, { throwIfNoEntry: false });
    if (socket && digestCanonical(socketIdentity(descriptor.socket.path)) !== digestCanonical(descriptor.socket))
        fail('retained input socket incarnation changed; cleanup refused');
    return { status: 'retained', brokerGone: brokerGone };
}

export function removeRecoveredNativeInputCarrier(descriptor, { validateAuthority })
{
    if (typeof validateAuthority !== 'function') fail('independent absent-service cleanup authority required');
    validateAuthority();
    const observed = inspectNativeInputCarrierArtifacts(descriptor);
    if (!observed.brokerGone) fail('live input broker retained for recovery');
    if (observed.status === 'absent') return;
    validateAuthority();
    inspectNativeInputCarrierArtifacts(descriptor);
    if (fs.existsSync(descriptor.socket.path)) fs.unlinkSync(descriptor.socket.path);
    validateAuthority();
    inspectNativeInputCarrierArtifacts(descriptor);
    fs.rmdirSync(descriptor.directory.path);
}

export async function closeOriginalNativeInputCarrier(carrier, { failureOwner, brokerGone })
{
    const held = carriers.get(carrier);
    if (!held || held.closed) return;
    held.revoked = true;
    if (brokerGone !== true) fail('unverified broker cleanup retains input carrier');
    if (!held.retentionStarted && !held.pending && !held.authority)
        return closeOriginalNativeInputCarrierBeforeAdmission(carrier, held.brokerStart);
    const { observePhysicalExecutionFailure } = await import('./physical-execution-process-tree.mjs');
    const observed = observePhysicalExecutionFailure(failureOwner, { originalNativeInputCarrier: carrier });
    if (observed.physicalTerminal !== 'zero-members')
    {
        if (!held.authority || held.authority.phase !== 'prepared' || held.pending)
            fail('unverified target cleanup retains input carrier');
        const { assertProductionBuildRetainedNativeInputIntent } = await import('../test-matrix/production-build-layout.mjs');
        assertProductionBuildRetainedNativeInputIntent(held.descriptor, held.authority);
    }
    assertProductionSystemdExecutionBoundary(held.boundary, { expectedContext: held.context });
    const requireAbsent = () =>
    {
        assertProductionSystemdExecutionBoundary(held.boundary, { expectedContext: held.context });
        if (!held.authority || inspectProductionSystemdServiceBinding(held.authority.serviceBinding, {
            commandBudgetMs: held.authority.commandBudgetMs }).status !== 'absent')
            fail('original independent service absence proof is required for cleanup');
    };
    requireAbsent();
    if (held.descriptor)
    {
        const observed = inspectNativeInputCarrierArtifacts(held.descriptor);
        if (!observed.brokerGone) fail('original broker is not proven dead');
        requireAbsent();
        if (fs.existsSync(held.descriptor.socket.path)) fs.unlinkSync(held.descriptor.socket.path);
    }
    requireAbsent();
    closeClosedNativeInputDirectory(held.directory);
    held.closed = true;
}

/** Startup only: no physical service or receive authorization has been issued. */
export function closeOriginalNativeInputCarrierBeforeAdmission(carrier, brokerIdentity)
{
    const held = carriers.get(carrier);
    if (!held || held.closed) return;
    held.revoked = true;
    if (!held.brokerStart || digestCanonical(brokerIdentity) !== digestCanonical(held.brokerStart)
        || held.pending || held.authority || held.retentionStarted || !originalProcessGone(held.brokerStart))
        fail('startup cleanup requires original broker gone and no service admission');
    assertProductionSystemdExecutionBoundary(held.boundary, { expectedContext: held.context });
    const { reference } = inspectClosedNativeInputDirectory(held.directory);
    if (fs.readdirSync(reference.path).some((name) => name !== 'inputs.sock'))
        fail('startup input carrier contents changed');
    const socketPath = path.join(reference.path, 'inputs.sock');
    if (fs.lstatSync(socketPath, { throwIfNoEntry: false }))
    {
        if (!held.descriptor) fail('startup socket incarnation was never admitted; cleanup retains it');
        const actual = socketIdentity(socketPath);
        if (digestCanonical(actual) !== digestCanonical(held.descriptor.socket))
            fail('startup input socket incarnation changed');
        fs.unlinkSync(socketPath);
    }
    closeClosedNativeInputDirectory(held.directory);
    held.closed = true;
}

/** No actor or durable retention ever began; only the original empty directory is removed. */
export function closeOriginalNativeInputCarrierBeforeSpawn(carrier)
{
    const held = carriers.get(carrier);
    if (!held || held.closed) return;
    held.revoked = true;
    if (held.brokerAttemptStarted || held.brokerStart || held.descriptor || held.retentionStarted || held.pending || held.authority)
        fail('before-spawn cleanup cannot remove an attempted actor/service carrier');
    closeClosedNativeInputDirectory(held.directory);
    held.closed = true;
}
