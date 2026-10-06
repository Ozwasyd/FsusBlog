import { createExecutionFailureOwner, observeExecutionFailure, retainExecutionFailureCompatibility, retainExecutionRecovery, formatExecutionFailure, retainExecutionFailure, throwExecutionFailure, executionFailureDataProperty } from './execution-failure-diagnostic.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { inspectProductionSystemdResourceBoundary, inspectProductionSystemdServiceBinding, productionSystemdServiceBindingIsComplete,
    readProductionSystemdResourceBoundaryBinding } = await import(new URL('../test-matrix/production-systemd-resource-boundary.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../test-fixtures/receipt/canonical.mjs', import.meta.url));
import { createNestedExecutionChannel, inspectNestedExecutionChannelCarrier, nestedExecutionChannelIsComplete, nestedExecutionChannelIsOwned,
    nestedExecutionChannelKey, removeLiveNestedExecutionChannel, removeRecoveredNestedExecutionChannel,
    runNestedPhysicalExecution } from './physical-execution-nested-channel.mjs';
import { systemdSenderReadyIsComplete } from './physical-execution-systemd-sender.mjs';
import { closeOriginalNativeInputCarrierBeforeSpawn, createOriginalNativeInputCarrier, inspectNativeInputCarrierArtifacts, inspectOriginalNativeInputCarrier,
    nativeInputCarrierIsComplete, removeRecoveredNativeInputCarrier } from './physical-execution-native-input-carrier.mjs';
import {
    collectProcessGroupOrJobIdentity,
    collectProcessIdentity,
    processGroupMemberIdentities,
    processIdentityStatus
} from './process-identity.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const policyFile = path.join(repoRoot, 'config/testing/physical-execution-process-policy.json');
const unixBootstrap = path.join(repoRoot, 'tools/test/physical-execution-unix-bootstrap.mjs');
const defaultResidualRoot = path.join(repoRoot, '.tmp', 'physical-execution-residuals');
const physicalInvocationObservations = new WeakMap();

export function observePhysicalExecutionFailure(owner, { originalNativeInputCarrier = null } = {})
{
    const invocations = physicalInvocationObservations.get(owner) ?? [];
    const last = invocations.at(-1);
    return Object.freeze({ physicalStarted: invocations.length > 0,
        physicalExecution: last?.physicalExecution ?? null,
        physicalTerminal: invocations.length > 0 && invocations.every((entry) => entry.settled
            && (originalNativeInputCarrier === null || entry.originalNativeInputCarrier === originalNativeInputCarrier)
            && entry.physicalTerminal === 'zero-members') ? 'zero-members' : null });
}

export const physicalExecutionProcessTreeSchema = 'fsusblog.physical-execution-process-tree.v1';
export const resourceServiceContainmentSchema = 'fsusblog.durable-process-containment.v2';
export const residentServiceOutputSchema = 'fsusblog.physical-systemd-resident-output.v1';
export const residentServiceTransferSchema = 'fsusblog.physical-systemd-resident-transfer.v1';

function residentServiceOutputIsComplete(output, carrier)
{
    return Boolean(output && Object.keys(output).sort().join(',') === 'controlRoot,files,schema'
        && output.schema === residentServiceOutputSchema
        && output.controlRoot && Object.keys(output.controlRoot).sort().join(',') === 'device,inode,path'
        && output.controlRoot.path === carrier?.path && output.controlRoot.device === carrier.device
        && output.controlRoot.inode === carrier.inode
        && output.files && Object.keys(output.files).sort().join(',') === 'stderr,stdout'
        && ['stdout', 'stderr'].every((name) =>
        {
            const file = output.files[name];
            return file && Object.keys(file).sort().join(',') === 'device,inode,path'
                && file.path === path.join(carrier.path, `${name}.log`)
                && Number.isSafeInteger(file.device) && file.device >= 0
                && Number.isSafeInteger(file.inode) && file.inode > 0;
        }));
}

function residentServiceTransferIsComplete(transfer, authority)
{
    if (!transfer || Object.keys(transfer).sort().join(',') !==
        'inventoryDigest,memberIdentities,outputFiles,schema,serviceBindingDigest,supervisorIdentity,transferredAt'
        || transfer.schema !== residentServiceTransferSchema
        || transfer.serviceBindingDigest !== digestCanonical(authority.serviceBinding)
        || !/^sha256:[a-f0-9]{64}$/u.test(transfer.inventoryDigest)
        || !Number.isFinite(Date.parse(transfer.transferredAt))
        || !transfer.outputFiles || Object.keys(transfer.outputFiles).sort().join(',') !== 'stderr,stdout'
        || !['stdout', 'stderr'].every((name) =>
        {
            const file = transfer.outputFiles[name];
            const carrier = authority.residentOutput?.files[name];
            return file && Object.keys(file).sort().join(',') === 'byteCount,device,digest,inode,path'
                && file.path === carrier?.path && file.device === carrier.device && file.inode === carrier.inode
                && Number.isSafeInteger(file.byteCount) && file.byteCount >= 0
                && /^sha256:[a-f0-9]{64}$/u.test(file.digest);
        })
        || !Array.isArray(transfer.memberIdentities) || transfer.memberIdentities.length < 2)
    {
        return false;
    }
    const pids = transfer.memberIdentities.map((identity) => identity?.pid);
    return pids.every((pid, index) => Number.isSafeInteger(pid) && pid > 0
        && (index === 0 || pid > pids[index - 1]))
        && transfer.memberIdentities.every((identity) => identity.schema === 'fsusblog.process-identity.v1'
            && identity.status === 'verified' && typeof identity.processStartIdentity === 'string'
            && identity.processStartIdentity.length > 0)
        && transfer.supervisorIdentity?.schema === 'fsusblog.process-identity.v1'
        && transfer.supervisorIdentity.status === 'verified'
        && transfer.memberIdentities.some((identity) => digestCanonical(identity)
            === digestCanonical(transfer.supervisorIdentity));
}

export function resourceServiceContainmentIsComplete(authority)
{
    const fields = ['schema', 'platform', 'kind', 'authorityId', 'killPolicy', 'phase', 'createdAt',
        'serviceBinding', 'commandBudgetMs', 'controlRoot', 'supervisorProcessIdentity', 'nestedChannel', 'creationSender'];
    const identity = authority?.supervisorProcessIdentity;
    const carrier = authority?.controlRoot;
    const hasOutput = Object.hasOwn(authority ?? {}, 'residentOutput');
    const hasTransfer = Object.hasOwn(authority ?? {}, 'residentTransfer');
    const hasNativeInputs = Object.hasOwn(authority ?? {}, 'nativeInputCarrier');
    return Boolean(authority && Object.keys(authority).sort().join(',') ===
        [...fields, ...(hasOutput ? ['residentOutput'] : []), ...(hasTransfer ? ['residentTransfer'] : []),
            ...(hasNativeInputs ? ['nativeInputCarrier'] : [])].sort().join(',')
        && authority.schema === resourceServiceContainmentSchema && authority.platform === 'linux'
        && authority.kind === 'systemd-resource-service' && authority.killPolicy === 'control-group'
        && Number.isFinite(Date.parse(authority.createdAt))
        && Number.isSafeInteger(authority.commandBudgetMs) && authority.commandBudgetMs > 0
        && productionSystemdServiceBindingIsComplete(authority.serviceBinding)
        && ((authority.phase === 'prepared' && authority.creationSender === null)
            || (authority.phase !== 'prepared' && systemdSenderReadyIsComplete(authority.creationSender)
                && authority.creationSender.authorityId === authority.authorityId))
        && (authority.nestedChannel === null || (nestedExecutionChannelIsComplete(authority.nestedChannel)
            && JSON.stringify(authority.nestedChannel.reference) === JSON.stringify(authority.serviceBinding.reference)))
        && (!hasNativeInputs || (nativeInputCarrierIsComplete(authority.nativeInputCarrier) && !hasOutput && !hasTransfer
            && authority.nestedChannel !== null
            && digestCanonical(authority.nativeInputCarrier.reference) === digestCanonical(authority.serviceBinding.reference)
            && digestCanonical(authority.nativeInputCarrier.brokerIdentity) === digestCanonical(authority.nestedChannel.brokerIdentity)
            && digestCanonical(authority.nativeInputCarrier.controllerIdentity) === digestCanonical(authority.nestedChannel.controllerIdentity)))
        && authority.authorityId === authority.serviceBinding.authorityId
        && carrier && Object.keys(carrier).sort().join(',') === 'device,inode,path'
        && typeof carrier.path === 'string' && path.isAbsolute(carrier.path)
        && Number.isSafeInteger(carrier.device) && carrier.device >= 0
        && Number.isSafeInteger(carrier.inode) && carrier.inode > 0
        && (!hasOutput || residentServiceOutputIsComplete(authority.residentOutput, carrier))
        && (hasTransfer === (authority.phase === 'resident-transferred'))
        && ((['prepared', 'create-attempted'].includes(authority.phase)
                && identity === null && authority.serviceBinding.identity === null)
            || (['pre-exec', 'resident-transferred'].includes(authority.phase) && authority.serviceBinding.identity !== null
                && identity?.schema === 'fsusblog.process-identity.v1' && identity.status === 'verified'
                && Number.isSafeInteger(identity.pid) && identity.pid > 0
                && typeof identity.processStartIdentity === 'string' && identity.processStartIdentity.length > 0
                && /^sha256:[a-f0-9]{64}$/u.test(identity.executableDigest)
                && /^sha256:[a-f0-9]{64}$/u.test(identity.commandDigest)
                && (!hasTransfer || residentServiceTransferIsComplete(authority.residentTransfer, authority)))));
}

const controlCarrierFiles = new Set(['command.json', 'environment.json', 'admission.json', 'resource-boundary.json',
    'ready', 'start', 'child.json', 'resource-admitted.json', 'release.json', 'result.json', 'finalize',
    'sender-plan.json', 'sender-terminal.json',
    'private-dotnet-scratch-prepared.json', 'private-dotnet-scratch-finalized.json']);
const residentCleanupJournalName = 'resident-cleanup-plan.json';
const residentCleanupPendingName = `${residentCleanupJournalName}.pending`;

function knownControlCarrierFile(authority, name)
{
    return controlCarrierFiles.has(name) || (authority.nativeInputCarrier
        && ['input-admission.json', 'child-inputs.json'].includes(name));
}

function bootstrapTemporaryFile(authority, name, supervisor)
{
    return ['ready', 'child.json', 'result.json', ...(authority.nativeInputCarrier ? ['child-inputs.json'] : [])]
        .some((base) => name === `${base}.next-${supervisor}`)
        || (authority.nativeInputCarrier && /^input-admission\.json\.next-[a-f0-9-]{36}$/u.test(name));
}

function controlCarrierRemovalOrder(files)
{
    return Object.keys(files).sort((left, right) =>
        Number(right.includes('.next-')) - Number(left.includes('.next-'))
        || Number(left === 'resource-boundary.json') - Number(right === 'resource-boundary.json')
        || left.localeCompare(right));
}

function controlCarrierFile(file)
{
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o077) !== 0 || fs.realpathSync(file) !== file)
    {
        throw new Error('physical execution control carrier must contain private, singly linked regular files');
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== stat.nlink || opened.uid !== stat.uid
            || opened.mode !== stat.mode || opened.size !== stat.size || opened.ctimeMs !== stat.ctimeMs || opened.mtimeMs !== stat.mtimeMs)
        {
            throw new Error('physical execution control carrier file changed during open');
        }
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor);
        if (after.size !== opened.size || after.ctimeMs !== opened.ctimeMs || after.mtimeMs !== opened.mtimeMs)
        {
            throw new Error('physical execution control carrier file changed during observation');
        }
        return { identity: { device: stat.dev, inode: stat.ino, mode: stat.mode, size: stat.size,
            modified: stat.mtimeMs, changed: stat.ctimeMs, digest: createHash('sha256').update(bytes).digest('hex') }, bytes };
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function residentOutputCarrierIdentity(file, expected, { includeDigest = false } = {})
{
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o777) !== 0o600 || fs.realpathSync(file) !== file
        || stat.dev !== expected.device || stat.ino !== expected.inode || file !== expected.path)
    {
        throw new Error('physical execution resident output carrier identity changed');
    }
    if (!includeDigest)
    {
        return { device: stat.dev, inode: stat.ino, mode: stat.mode };
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== stat.nlink
            || opened.uid !== stat.uid || opened.mode !== stat.mode || opened.size !== stat.size
            || opened.ctimeMs !== stat.ctimeMs || opened.mtimeMs !== stat.mtimeMs)
        {
            throw new Error('physical execution resident output changed during open');
        }
        const digest = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let read;
        while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
        {
            digest.update(buffer.subarray(0, read));
        }
        const after = fs.fstatSync(descriptor);
        if (after.size !== opened.size || after.ctimeMs !== opened.ctimeMs || after.mtimeMs !== opened.mtimeMs)
        {
            throw new Error('physical execution resident output changed during observation');
        }
        return { device: stat.dev, inode: stat.ino, mode: stat.mode, size: stat.size,
            modified: stat.mtimeMs, changed: stat.ctimeMs, digest: digest.digest('hex') };
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function controlCarrierSnapshot(authority, { includeOutputDigest = false, allowCleanupJournal = false } = {})
{
    if (!resourceServiceContainmentIsComplete(authority))
    {
        throw new Error('physical execution control carrier authority is incomplete');
    }
    const carrier = authority.controlRoot;
    if (!/^(?:fsusblog-)?physical-systemd-[A-Za-z0-9]{6}$/u.test(path.basename(carrier.path)))
    {
        throw new Error('physical execution control carrier is outside its private creation namespace');
    }
    const stat = fs.lstatSync(carrier.path, { throwIfNoEntry: false });
    if (!stat)
    {
        return { status: 'absent', files: {} };
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
        || fs.realpathSync(carrier.path) !== carrier.path || stat.dev !== carrier.device || stat.ino !== carrier.inode)
    {
        throw new Error('physical execution control carrier directory identity changed');
    }
    const directoryNames = fs.readdirSync(carrier.path).sort();
    const pending = directoryNames.includes(residentCleanupPendingName);
    if (pending && (!allowCleanupJournal || !authority.residentOutput
        || directoryNames.includes(residentCleanupJournalName)))
    {
        throw new Error('physical execution resident cleanup has an unknown pending carrier');
    }
    if (pending)
    {
        controlCarrierFile(path.join(carrier.path, residentCleanupPendingName));
    }
    const names = directoryNames.filter((name) => name !== residentCleanupPendingName);
    if (allowCleanupJournal && authority.residentOutput && names.includes(residentCleanupJournalName))
    {
        return residentCleanupCarrierSnapshot(authority, names);
    }
    if (names.length === 0)
    {
        if (authority.residentOutput && !allowCleanupJournal)
        {
            throw new Error('physical execution resident output carrier is missing');
        }
        if (pending)
        {
            throw new Error('physical execution resident cleanup pending carrier lacks its original files');
        }
        return { status: 'retained', files: {} };
    }
    if (!names.includes('resource-boundary.json'))
    {
        throw new Error('physical execution control carrier lacks its retained binding');
    }
    const intent = { ...authority, phase: 'prepared', creationSender: null, supervisorProcessIdentity: null,
        serviceBinding: { ...authority.serviceBinding, identity: null } };
    delete intent.residentTransfer;
    const binding = intent.serviceBinding;
    const retained = JSON.parse(controlCarrierFile(path.join(carrier.path, 'resource-boundary.json')).bytes.toString('utf8'));
    if (digestCanonical(retained) !== digestCanonical({ authorityId: intent.authorityId, unitName: binding.unitName,
        sliceUnitName: binding.parent.unitName, description: binding.description, reference: binding.reference,
        containmentAuthority: intent }))
    {
        throw new Error('physical execution control carrier binding differs from retained authority');
    }
    const outputNames = authority.residentOutput ? ['stdout.log', 'stderr.log'] : [];
    if (outputNames.some((name) => !names.includes(name)))
    {
        throw new Error('physical execution resident output carrier is missing');
    }
    const temporaryNames = names.filter((name) => !knownControlCarrierFile(authority, name) && !outputNames.includes(name));
    if (temporaryNames.length)
    {
        const supervisor = controlCarrierFile(path.join(carrier.path, 'ready')).bytes.toString('utf8').trim();
        if (!/^[1-9][0-9]*$/u.test(supervisor)
            || temporaryNames.some((name) => !bootstrapTemporaryFile(authority, name, supervisor)))
        {
            throw new Error('physical execution control carrier contains unknown files');
        }
    }
    return { status: 'retained', ...(pending ? { cleanupPending: true } : {}), files: Object.fromEntries(names.map((name) =>
        [name, outputNames.includes(name)
            ? residentOutputCarrierIdentity(path.join(carrier.path, name),
                authority.residentOutput.files[name.slice(0, -'.log'.length)], { includeDigest: includeOutputDigest })
            : controlCarrierFile(path.join(carrier.path, name)).identity])) };
}

function residentCleanupCarrierSnapshot(authority, names)
{
    const carrier = authority.controlRoot;
    const journalFile = path.join(carrier.path, residentCleanupJournalName);
    const journal = JSON.parse(controlCarrierFile(journalFile).bytes.toString('utf8'));
    if (!journal || Object.keys(journal).sort().join(',') !== 'authorityDigest,controlRoot,files,schema'
        || journal.schema !== 'fsusblog.physical-resident-cleanup-plan.v1'
        || journal.authorityDigest !== digestCanonical(authority)
        || digestCanonical(journal.controlRoot) !== digestCanonical(carrier)
        || !journal.files || typeof journal.files !== 'object' || Array.isArray(journal.files)
        || !Object.hasOwn(journal.files, 'resource-boundary.json')
        || !['stdout.log', 'stderr.log'].every((name) => Object.hasOwn(journal.files, name)))
    {
        throw new Error('physical execution resident cleanup plan differs from retained authority');
    }
    const order = controlCarrierRemovalOrder(journal.files);
    const supervisor = journal.files.ready && fs.existsSync(path.join(carrier.path, 'ready'))
        ? controlCarrierFile(path.join(carrier.path, 'ready')).bytes.toString('utf8').trim() : null;
    if (order.some((name) => !knownControlCarrierFile(authority, name) && !['stdout.log', 'stderr.log'].includes(name)
        && !(supervisor && bootstrapTemporaryFile(authority, name, supervisor)))
        || order.some((name) =>
        {
            const file = journal.files[name];
            const keys = 'changed,device,digest,inode,mode,modified,size';
            return !file || Object.keys(file).sort().join(',') !== keys
                || !Number.isSafeInteger(file.device) || file.device < 0
                || !Number.isSafeInteger(file.inode) || file.inode <= 0
                || !Number.isSafeInteger(file.size) || file.size < 0
                || !Number.isFinite(file.changed) || !Number.isFinite(file.modified)
                || !/^[a-f0-9]{64}$/u.test(file.digest)
                || (['stdout.log', 'stderr.log'].includes(name)
                    && (file.device !== authority.residentOutput.files[name.slice(0, -4)].device
                        || file.inode !== authority.residentOutput.files[name.slice(0, -4)].inode));
        }))
    {
        throw new Error('physical execution resident cleanup plan contains unknown or invalid files');
    }
    const present = names.filter((name) => name !== residentCleanupJournalName);
    if (!Array.from({ length: order.length + 1 }, (_, removed) => order.slice(removed).sort())
        .some((remaining) => JSON.stringify(remaining) === JSON.stringify(present)))
    {
        throw new Error('physical execution resident cleanup does not follow its exact deletion prefix');
    }
    const files = Object.fromEntries(present.map((name) =>
    {
        const file = path.join(carrier.path, name);
        const observed = ['stdout.log', 'stderr.log'].includes(name)
            ? residentOutputCarrierIdentity(file, authority.residentOutput.files[name.slice(0, -4)], { includeDigest: true })
            : controlCarrierFile(file).identity;
        if (digestCanonical(observed) !== digestCanonical(journal.files[name]))
        {
            throw new Error('physical execution resident cleanup carrier differs from its durable plan');
        }
        return [name, observed];
    }));
    return { status: 'retained', files, cleanupPlan: journal };
}

function syncControlCarrierDirectory(carrier)
{
    const directory = fs.openSync(carrier.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        fs.fsyncSync(directory);
    }
    finally
    {
        fs.closeSync(directory);
    }
}

function retainResidentCleanupPlan(authority, files)
{
    const carrier = authority.controlRoot;
    const journalFile = path.join(carrier.path, residentCleanupJournalName);
    const pendingFile = path.join(carrier.path, residentCleanupPendingName);
    const journal = { schema: 'fsusblog.physical-resident-cleanup-plan.v1',
        authorityDigest: digestCanonical(authority), controlRoot: carrier, files };
    fs.writeFileSync(pendingFile, `${JSON.stringify(journal)}\n`, { flag: 'wx', mode: 0o600 });
    const descriptor = fs.openSync(pendingFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    fs.renameSync(pendingFile, journalFile);
    syncControlCarrierDirectory(carrier);
    const retained = residentCleanupCarrierSnapshot(authority, fs.readdirSync(carrier.path).sort());
    if (digestCanonical(retained.cleanupPlan) !== digestCanonical(journal))
    {
        throw new Error('physical execution resident cleanup plan did not survive durable read-back');
    }
    return retained;
}

function syncRetainedResidentCleanupPlan(authority, snapshot)
{
    const carrier = authority.controlRoot;
    const descriptor = fs.openSync(path.join(carrier.path, residentCleanupJournalName),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    syncControlCarrierDirectory(carrier);
    const retained = controlCarrierSnapshot(authority, { includeOutputDigest: true, allowCleanupJournal: true });
    if (digestCanonical(retained.files) !== digestCanonical(snapshot.files)
        || digestCanonical(retained.cleanupPlan) !== digestCanonical(snapshot.cleanupPlan))
    {
        throw new Error('physical execution resident cleanup plan changed before retry');
    }
    return retained;
}

function remainingControlCarrierSnapshot(authority, expected)
{
    const carrier = authority.controlRoot;
    const stat = fs.lstatSync(carrier.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & 0o077) !== 0 || fs.realpathSync(carrier.path) !== carrier.path
        || stat.dev !== carrier.device || stat.ino !== carrier.inode)
    {
        throw new Error('physical execution control carrier directory identity changed during cleanup');
    }
    const names = fs.readdirSync(carrier.path).sort();
    if (JSON.stringify(names) !== JSON.stringify(Object.keys(expected).sort()))
    {
        throw new Error('physical execution control carrier roster changed during cleanup');
    }
    return Object.fromEntries(names.map((name) => [name, authority.residentOutput && ['stdout.log', 'stderr.log'].includes(name)
        ? residentOutputCarrierIdentity(path.join(carrier.path, name),
            authority.residentOutput.files[name.slice(0, -'.log'.length)], { includeDigest: true })
        : controlCarrierFile(path.join(carrier.path, name)).identity]));
}

/** Read back the original private output files without treating a bundle-level PID as service ownership. */
export function inspectPhysicalExecutionResidentOutput(authority)
{
    if (!resourceServiceContainmentIsComplete(authority) || !authority.residentOutput)
    {
        throw new Error('resident service output requires its exact retained authority');
    }
    const snapshot = controlCarrierSnapshot(authority, { includeOutputDigest: true });
    if (snapshot.status !== 'retained')
    {
        throw new Error('resident service output carrier is absent');
    }
    return Object.fromEntries(['stdout', 'stderr'].map((name) =>
    {
        const file = snapshot.files[`${name}.log`];
        return [name, { path: authority.residentOutput.files[name].path, device: file.device,
            inode: file.inode, byteCount: file.size, digest: `sha256:${file.digest}` }];
    }));
}

function resourceArtifactAuthorities(authorities)
{
    const services = authorities.filter((authority) => authority.schema === resourceServiceContainmentSchema);
    const channels = new Map();
    const nativeCarriers = new Map();
    for (const authority of services)
    {
        if (!resourceServiceContainmentIsComplete(authority))
        {
            throw new Error('physical execution resource artifact authority is incomplete');
        }
        const channel = authority.nestedChannel;
        if (channel)
        {
            if (channels.has(channel.id) && digestCanonical(channels.get(channel.id)) !== digestCanonical(channel))
            {
                throw new Error('physical execution retained channel references disagree');
            }
            channels.set(channel.id, channel);
        }
        if (authority.nativeInputCarrier)
        {
            const native = authority.nativeInputCarrier;
            if (nativeCarriers.has(native.id) && digestCanonical(nativeCarriers.get(native.id)) !== digestCanonical(native))
                throw new Error('physical execution retained native input carriers disagree');
            nativeCarriers.set(native.id, native);
        }
    }
    return { services, channels: [...channels.values()], nativeCarriers: [...nativeCarriers.values()] };
}

export function inspectPhysicalExecutionResourceArtifacts(authorities)
{
    const { services, channels, nativeCarriers } = resourceArtifactAuthorities(authorities);
    return [
        ...services.map((authority) => ({ kind: 'service-control', authorityId: authority.authorityId,
            path: authority.controlRoot.path,
            status: controlCarrierSnapshot(authority, { allowCleanupJournal: true }).status })),
        ...channels.map((channel) => ({ kind: 'nested-channel', channelId: channel.id,
            path: channel.directory.path, status: inspectNestedExecutionChannelCarrier(channel).status })),
        ...nativeCarriers.map((carrier) => ({ kind: 'native-input-carrier', carrierId: carrier.id,
            path: carrier.directory.path, status: inspectNativeInputCarrierArtifacts(carrier).status }))
    ];
}

/** Remove only absent services' exact independently retained carriers under a proven owner state. */
function cleanupResourceArtifacts(authorities, { validateAuthority }, controllerState)
{
    const { services, channels, nativeCarriers } = resourceArtifactAuthorities(authorities);
    if (services.length !== authorities.length || typeof validateAuthority !== 'function')
    {
        throw new Error('physical execution artifact recovery requires independent resource service ownership');
    }
    const assertOwner = () =>
    {
        if (validateAuthority()?.status !== 'verified')
        {
            throw new Error('physical execution artifact recovery owner validation failed');
        }
    };
    const assertAbsent = (authority) =>
    {
        assertOwner();
        const reference = authority.serviceBinding.reference;
        const options = { reference, commandBudgetMs: authority.commandBudgetMs };
        const binding = readProductionSystemdResourceBoundaryBinding(reference.context, options);
        const controller = binding.owner.controllerIdentity;
        const boundary = inspectProductionSystemdResourceBoundary(reference.context, options);
        if ((controllerState === 'dead'
            ? processIdentityStatus(controller).status !== 'dead' || boundary.status !== 'released'
            : controllerState !== 'live' || controller.pid !== process.pid
                || processIdentityStatus(controller).status !== 'live' || boundary.status !== 'retained')
            || inspectProductionSystemdServiceBinding(authority.serviceBinding, options).status !== 'absent')
        {
            throw new Error('physical execution artifact cleanup requires its proven owner state and absent service');
        }
    };
    for (const authority of services)
    {
        assertAbsent(authority);
    }
    // Preflight the complete roster before removing anything, including shared channel carriers.
    const snapshots = services.map((authority) => controlCarrierSnapshot(authority,
        { includeOutputDigest: true, allowCleanupJournal: true }));
    for (let index = 0; index < services.length; index += 1)
    {
        const transfer = services[index].residentTransfer;
        if (transfer && ['stdout', 'stderr'].some((name) =>
        {
            const actual = (snapshots[index].cleanupPlan?.files ?? snapshots[index].files)[`${name}.log`];
            const expected = transfer.outputFiles[name];
            return (!actual && Object.keys(snapshots[index].files).length !== 0)
                || (actual && (actual.device !== expected.device || actual.inode !== expected.inode
                    || actual.size !== expected.byteCount || `sha256:${actual.digest}` !== expected.digest));
        }))
        {
            throw new Error('physical execution transferred resident output differs from its captured prefix');
        }
    }
    for (const channel of channels)
    {
        if (!inspectNestedExecutionChannelCarrier(channel).brokerGone)
        {
            throw new Error('physical execution artifact cleanup retains a live channel broker');
        }
    }
    for (const carrier of nativeCarriers)
        if (!inspectNativeInputCarrierArtifacts(carrier).brokerGone)
            throw new Error('physical execution artifact cleanup retains a live native input broker');
    for (let index = 0; index < services.length; index += 1)
    {
        const authority = services[index];
        if (snapshots[index].status === 'absent')
        {
            assertAbsent(authority);
            if (fs.lstatSync(authority.controlRoot.path, { throwIfNoEntry: false }))
            {
                throw new Error('physical execution absent control carrier reappeared during cleanup');
            }
            continue;
        }
        let snapshot = snapshots[index];
        if (snapshot.cleanupPending)
        {
            assertAbsent(authority);
            const current = controlCarrierSnapshot(authority, { includeOutputDigest: true, allowCleanupJournal: true });
            if (!current.cleanupPending || digestCanonical(current.files) !== digestCanonical(snapshot.files))
            {
                throw new Error('physical execution resident cleanup pending carrier changed before retry');
            }
            fs.unlinkSync(path.join(authority.controlRoot.path, residentCleanupPendingName));
            syncControlCarrierDirectory(authority.controlRoot);
            snapshot = controlCarrierSnapshot(authority, { includeOutputDigest: true, allowCleanupJournal: true });
        }
        if (authority.residentOutput && Object.keys(snapshot.files).length > 0 && !snapshot.cleanupPlan)
        {
            assertAbsent(authority);
            snapshot = retainResidentCleanupPlan(authority, snapshot.files);
        }
        else if (snapshot.cleanupPlan)
        {
            assertAbsent(authority);
            snapshot = syncRetainedResidentCleanupPlan(authority, snapshot);
        }
        const expected = structuredClone(snapshot.files);
        const names = controlCarrierRemovalOrder(expected);
        assertAbsent(authority);
        for (const name of names)
        {
            assertOwner();
            const observed = snapshot.cleanupPlan
                ? controlCarrierSnapshot(authority, { includeOutputDigest: true, allowCleanupJournal: true })
                : { files: remainingControlCarrierSnapshot(authority, expected) };
            if (digestCanonical(observed.files) !== digestCanonical(expected)
                || (snapshot.cleanupPlan && digestCanonical(observed.cleanupPlan) !== digestCanonical(snapshot.cleanupPlan)))
            {
                throw new Error('physical execution control carrier changed before file removal');
            }
            fs.unlinkSync(path.join(authority.controlRoot.path, name));
            delete expected[name];
        }
        if (snapshot.cleanupPlan)
        {
            assertAbsent(authority);
            const observed = controlCarrierSnapshot(authority, { includeOutputDigest: true, allowCleanupJournal: true });
            if (Object.keys(observed.files).length !== 0
                || digestCanonical(observed.cleanupPlan) !== digestCanonical(snapshot.cleanupPlan))
            {
                throw new Error('physical execution resident cleanup plan changed before final removal');
            }
            fs.unlinkSync(path.join(authority.controlRoot.path, residentCleanupJournalName));
        }
        assertOwner();
        const remaining = fs.lstatSync(authority.controlRoot.path, { throwIfNoEntry: false });
        if (!remaining || !remaining.isDirectory() || remaining.isSymbolicLink()
            || remaining.uid !== process.getuid() || (remaining.mode & 0o077) !== 0
            || fs.realpathSync(authority.controlRoot.path) !== authority.controlRoot.path
            || remaining.dev !== authority.controlRoot.device || remaining.ino !== authority.controlRoot.inode
            || fs.readdirSync(authority.controlRoot.path).length !== 0)
        {
            throw new Error('physical execution control carrier is not the exact empty owned directory');
        }
        fs.rmdirSync(authority.controlRoot.path);
        const parent = fs.openSync(path.dirname(authority.controlRoot.path), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try
        {
            fs.fsyncSync(parent);
        }
        finally
        {
            fs.closeSync(parent);
        }
    }
    for (const carrier of nativeCarriers)
    {
        removeRecoveredNativeInputCarrier(carrier, { validateAuthority: () =>
        {
            for (const authority of services) assertAbsent(authority);
        } });
    }
    for (const channel of channels)
    {
        (controllerState === 'live' ? removeLiveNestedExecutionChannel : removeRecoveredNestedExecutionChannel)(channel,
            { validateAuthority });
    }
    const result = inspectPhysicalExecutionResourceArtifacts(authorities);
    if (result.some((entry) => entry.status !== 'absent'))
    {
        throw new Error('physical execution artifact recovery did not prove absence');
    }
    return result.map((entry) =>
    {
        const index = services.findIndex((authority) => authority.authorityId === entry.authorityId);
        if (index < 0 || !services[index].residentOutput)
        {
            return entry;
        }
        return { ...entry, outputFiles: Object.fromEntries(['stdout', 'stderr'].map((name) =>
            [name, (snapshots[index].cleanupPlan?.files ?? snapshots[index].files)[`${name}.log`]])) };
    });
}

/** Dead-controller recovery retains its existing released-parent requirement. */
export function cleanupPhysicalExecutionResourceArtifacts(authorities, options)
{
    return cleanupResourceArtifacts(authorities, options, 'dead');
}

/** The original live build owner may settle a transferred resident after exact service termination. */
export function cleanupLivePhysicalExecutionResidentArtifacts(authorities, options)
{
    if (!Array.isArray(authorities) || authorities.length === 0
        || authorities.some((authority) => authority.phase !== 'resident-transferred'))
    {
        throw new Error('live resident artifact cleanup requires transferred service authorities');
    }
    return cleanupResourceArtifacts(authorities, options, 'live');
}

function readPolicy(file = policyFile)
{
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
        policy?.schema !== 'fsusblog.physical-execution-process-policy.v1' ||
        !Number.isInteger(policy.gracefulTerminationMs) ||
        policy.gracefulTerminationMs < 0 ||
        !Number.isInteger(policy.forceTerminationMs) ||
        policy.forceTerminationMs <= 0 ||
        !Number.isInteger(policy.pipeCloseTimeoutMs) ||
        policy.pipeCloseTimeoutMs <= 0 ||
        !Number.isInteger(policy.observationIntervalMs) ||
        policy.observationIntervalMs <= 0 ||
        !Number.isInteger(policy.zeroMemberObservations) ||
        policy.zeroMemberObservations < 2 ||
        !Number.isInteger(policy.maximumCapturedOutputBytesPerStream) ||
        policy.maximumCapturedOutputBytesPerStream <= 0 ||
        policy.unixProcessGroupRequired !== true ||
        policy.linuxCgroupRequired !== true ||
        policy.windowsJobObjectRequired !== true
    )
    {
        throw new Error('physical execution process policy is invalid');
    }
    return policy;
}

function delay(milliseconds)
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedWait(promise, milliseconds)
{
    let timer = null;
    return Promise.race([
        promise.then(() => true),
        new Promise((resolve) =>
        {
            timer = setTimeout(() => resolve(false), milliseconds);
            timer.unref?.();
        })
    ]).finally(() =>
    {
        if (timer !== null)
        {
            clearTimeout(timer);
        }
    });
}

function boundedValue(promise, milliseconds)
{
    let timer = null;
    return Promise.race([
        promise.then((value) => ({ completed: true, value })),
        new Promise((resolve) =>
        {
            timer = setTimeout(() => resolve({ completed: false, value: null }), milliseconds);
            timer.unref?.();
        })
    ]).finally(() =>
    {
        if (timer !== null)
        {
            clearTimeout(timer);
        }
    });
}

function normalizedOutputChunk(chunk)
{
    if (Buffer.isBuffer(chunk))
    {
        return chunk;
    }
    if (ArrayBuffer.isView(chunk))
    {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    return Buffer.from(String(chunk));
}

export function createPhysicalExecutionOutputTracker({
    policy,
    stdout,
    stderr
})
{
    const states = new Map([
        ['stdout', {
            identity: 'stdout',
            sink: stdout,
            readable: null,
            chunks: [],
            bytes: 0,
            capturedBytes: 0,
            closed: false,
            sinkBlocked: false,
            drainListener: null
        }],
        ['stderr', {
            identity: 'stderr',
            sink: stderr,
            readable: null,
            chunks: [],
            bytes: 0,
            capturedBytes: 0,
            closed: false,
            sinkBlocked: false,
            drainListener: null
        }]
    ]);
    let firstSinkError = null;
    let closePromise = null;
    let resolvePipesClosed;
    const pipesClosed = new Promise((resolve) =>
    {
        resolvePipesClosed = resolve;
    });
    const observeClosed = () =>
    {
        if ([...states.values()].every((state) => state.closed))
        {
            resolvePipesClosed();
        }
    };
    const markClosed = (state) =>
    {
        if (state.closed)
        {
            return;
        }
        state.closed = true;
        if (state.drainListener)
        {
            state.sink?.off?.('drain', state.drainListener);
        }
        state.drainListener = null;
        state.sinkBlocked = false;
        observeClosed();
    };
    const recordSinkError = (error) =>
    {
        firstSinkError ??= error instanceof Error ? error : new Error(String(error));
    };
    for (const state of states.values())
    {
        state.sink?.on?.('error', recordSinkError);
    }
    const attach = (readable, identity) =>
    {
        const state = states.get(identity);
        if (!state)
        {
            throw new Error(`physical execution output identity is invalid: ${identity}`);
        }
        if (!readable)
        {
            markClosed(state);
            return;
        }
        state.readable = readable;
        readable.on('data', (chunk) =>
        {
            const buffer = normalizedOutputChunk(chunk);
            state.bytes += buffer.length;
            const available = Math.max(
                0,
                policy.maximumCapturedOutputBytesPerStream - state.capturedBytes
            );
            if (available > 0)
            {
                const captured = available >= buffer.length
                    ? buffer
                    : buffer.subarray(0, available);
                state.chunks.push(Buffer.from(captured));
                state.capturedBytes += captured.length;
            }
            if (!state.sink)
            {
                return;
            }
            try
            {
                if (state.sink.write(buffer) === false && !state.sinkBlocked)
                {
                    state.sinkBlocked = true;
                    readable.pause?.();
                    state.drainListener = () =>
                    {
                        state.sinkBlocked = false;
                        state.drainListener = null;
                        if (!state.closed)
                        {
                            readable.resume?.();
                        }
                    };
                    state.sink.once?.('drain', state.drainListener);
                }
            }
            catch (error)
            {
                recordSinkError(error);
            }
        });
        readable.once('end', () => markClosed(state));
        readable.once('close', () => markClosed(state));
        readable.once('error', (error) =>
        {
            recordSinkError(new Error(`${identity} pipe failed: ${error.message}`, { cause: error }));
            markClosed(state);
        });
        if (readable.readableEnded || readable.destroyed)
        {
            markClosed(state);
        }
    };
    const close = () =>
    {
        if (closePromise)
        {
            return closePromise;
        }
        closePromise = (async () =>
        {
            let forcedPipeClose = false;
            if (!await boundedWait(pipesClosed, policy.pipeCloseTimeoutMs))
            {
                forcedPipeClose = true;
                for (const state of states.values())
                {
                    if (!state.closed)
                    {
                        state.readable?.destroy();
                    }
                }
                await boundedWait(pipesClosed, policy.observationIntervalMs);
            }
            for (const state of states.values())
            {
                if (!state.closed)
                {
                    markClosed(state);
                }
                state.sink?.off?.('error', recordSinkError);
            }
            const logTruncationReason = forcedPipeClose
                ? 'pipe-close-deadline-exceeded'
                : firstSinkError
                    ? 'log-sink-error'
                    : null;
            return {
                logComplete: logTruncationReason === null,
                logTruncationReason,
                forcedPipeClose,
                outputCapture: {
                    maximumBytesPerStream: policy.maximumCapturedOutputBytesPerStream,
                    stdoutBytes: states.get('stdout').bytes,
                    stderrBytes: states.get('stderr').bytes,
                    stdoutCapturedBytes: states.get('stdout').capturedBytes,
                    stderrCapturedBytes: states.get('stderr').capturedBytes,
                    stdoutTruncated: states.get('stdout').capturedBytes
                        < states.get('stdout').bytes,
                    stderrTruncated: states.get('stderr').capturedBytes
                        < states.get('stderr').bytes
                },
                stdout: Buffer.concat(states.get('stdout').chunks).toString('utf8'),
                stderr: Buffer.concat(states.get('stderr').chunks).toString('utf8')
            };
        })();
        return closePromise;
    };
    return { attach, close };
}

function waitForObservationInterval(milliseconds)
{
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function processCoordinates(pid, platform = process.platform, procRoot = '/proc')
{
    if (platform === 'linux')
    {
        const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).trim().split(/\s+/u);
        return { ppid: Number(fields[1]), pgid: Number(fields[2]), jobId: null };
    }
    return { ppid: null, pgid: null, jobId: null };
}

function inventoryRecord(identity, authority, role, observedAt, coordinates)
{
    return {
        pid: identity.pid,
        startIdentity: identity.processStartIdentity,
        ppid: coordinates.ppid,
        pgid: authority.kind === 'process-group' ? authority.groupId : null,
        jobId: authority.kind === 'windows-job-object' ? authority.jobName : null,
        executableDigest: identity.executableDigest,
        commandDigest: identity.commandDigest,
        role,
        observedAt,
        exitCode: null,
        signal: null
    };
}

function recordMembers(inventory, identities, authority, leaderPid, platform, procRoot)
{
    const observedAt = new Date().toISOString();
    for (const identity of identities)
    {
        const key = `${identity.pid}:${identity.processStartIdentity}`;
        if (inventory.has(key))
        {
            continue;
        }
        let coordinates = { ppid: null, pgid: null, jobId: authority.jobName ?? null };
        try
        {
            coordinates = processCoordinates(identity.pid, platform, procRoot);
        }
        catch (error)
        {
            if (!['ENOENT', 'ESRCH'].includes(error?.code))
            {
                throw error;
            }
        }
        inventory.set(
            key,
            inventoryRecord(
                identity,
                authority,
                identity.pid === leaderPid ? 'direct-child' : 'descendant',
                observedAt,
                coordinates
            )
        );
    }
}

async function stableMemberObservation({
    authority,
    inventory,
    leaderPid,
    policy,
    collectMembers,
    platform,
    procRoot,
    deadlineAt = Number.POSITIVE_INFINITY
})
{
    let zeroCount = 0;
    while (Date.now() <= deadlineAt)
    {
        const observation = collectMembers(authority, { platform, procRoot });
        if (observation?.status !== 'verified')
        {
            throw new Error(`physical execution post-observe failed: ${observation?.reason ?? 'unknown collector failure'}`);
        }
        recordMembers(inventory, observation.identities, authority, leaderPid, platform, procRoot);
        if (observation.identities.length === 0)
        {
            zeroCount += 1;
            if (zeroCount >= policy.zeroMemberObservations)
            {
                return { status: 'empty', members: [] };
            }
        }
        else
        {
            zeroCount = 0;
        }
        await delay(policy.observationIntervalMs);
    }
    const finalObservation = collectMembers(authority, { platform, procRoot });
    if (finalObservation?.status !== 'verified')
    {
        throw new Error(`physical execution post-observe failed: ${finalObservation?.reason ?? 'unknown collector failure'}`);
    }
    recordMembers(inventory, finalObservation.identities, authority, leaderPid, platform, procRoot);
    return { status: finalObservation.identities.length === 0 ? 'empty' : 'residual', members: finalObservation.identities };
}

function sameIdentity(expected, actual)
{
    return expected.pid === actual.pid
        && expected.processStartIdentity === actual.processStartIdentity
        && expected.executableDigest === actual.executableDigest
        && expected.commandDigest === actual.commandDigest;
}

export function terminatePhysicalExecutionAuthoritySync({
    authority,
    reason,
    policy = readPolicy(),
    expectedIdentities = [],
    collectMembers = processGroupMemberIdentities,
    validateMembers = () => ({ status: 'verified' }),
    validateAuthority = () => ({ status: 'verified' }),
    signalAuthority = (value, signal) => process.kill(-value.groupId, signal),
    platform = process.platform,
    procRoot = '/proc',
    windowsJobTerminator = null
})
{
    if (authority?.schema === resourceServiceContainmentSchema)
    {
        let forced = false;
        try
        {
            if (platform !== 'linux' || !resourceServiceContainmentIsComplete(authority))
            {
                throw new Error('resource-bound service termination authority is incomplete');
            }
            const observe = () =>
            {
                const validation = validateAuthority(authority);
                if (validation?.status !== 'verified')
                {
                    throw new Error(validation?.reason ?? 'resource-bound service owner validation failed');
                }
                return inspectProductionSystemdServiceBinding(authority.serviceBinding, {
                    commandBudgetMs: authority.commandBudgetMs
                });
            };
            const effect = (args) =>
            {
                if (observe().status === 'absent')
                {
                    return;
                }
                const result = spawnSync('systemctl', ['--user', ...args, '--', authority.serviceBinding.unitName], {
                    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: authority.commandBudgetMs
                });
                if ((result.error || result.status !== 0) && observe().status !== 'absent')
                {
                    throw new Error(`resource-bound service termination command failed: ${result.error?.message ?? result.stderr}`);
                }
            };
            const waitAbsent = (budgetMs) =>
            {
                const deadline = Date.now() + budgetMs;
                let observations = 0;
                do
                {
                    observations = observe().status === 'absent' ? observations + 1 : 0;
                    if (observations >= policy.zeroMemberObservations)
                    {
                        return true;
                    }
                    waitForObservationInterval(policy.observationIntervalMs);
                } while (Date.now() <= deadline);
                return false;
            };
            effect(['kill', '--kill-who=all', '--signal=SIGTERM']);
            let absent = waitAbsent(policy.gracefulTerminationMs);
            if (!absent)
            {
                forced = true;
                effect(['kill', '--kill-who=all', '--signal=SIGKILL']);
                effect(['stop']);
                absent = waitAbsent(policy.forceTerminationMs);
            }
            return absent
                ? { terminated: true, forced, reason, postObservation: 'zero-members' }
                : { terminated: false, forced, reason: 'exact resource-bound service remains present', postObservation: 'members-remain' };
        }
        catch (error)
        {
            return { terminated: false, forced, reason: error.message, postObservation: 'unverifiable' };
        }
    }
    if (authority?.kind === 'systemd-transient-service' && authority.platform === 'linux')
    {
        const show = () =>
        {
            const result = spawnSync('systemctl', [
                '--user',
                'show',
                authority.unitName,
                '--property=LoadState',
                '--property=ActiveState',
                '--property=ControlGroup',
                '--no-pager'
            ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            if (result.status !== 0)
            {
                return { status: 'unverifiable', reason: String(result.stderr ?? result.stdout ?? '').trim() };
            }
            const values = Object.fromEntries(String(result.stdout).trim().split(/\r?\n/u)
                .map((line) => line.split(/=(.*)/su).slice(0, 2)));
            let pids = [];
            if (values.ControlGroup)
            {
                const file = path.join(
                    '/sys/fs/cgroup',
                    values.ControlGroup.replace(/^\/+/u, ''),
                    'cgroup.procs'
                );
                try
                {
                    pids = fs.readFileSync(file, 'utf8').trim().split(/\s+/u)
                        .filter(Boolean)
                        .map(Number);
                }
                catch (error)
                {
                    if (error.code !== 'ENOENT')
                    {
                        return { status: 'unverifiable', reason: error.message };
                    }
                }
            }
            return {
                status: 'verified',
                empty: pids.length === 0 &&
                    (values.LoadState === 'not-found' ||
                      ['inactive', 'failed'].includes(values.ActiveState)),
                pids
            };
        };
        const waitEmpty = (deadlineAt) =>
        {
            let zeroObservations = 0;
            while (Date.now() <= deadlineAt)
            {
                const observed = show();
                if (observed.status !== 'verified')
                {
                    return observed;
                }
                if (observed.empty)
                {
                    zeroObservations += 1;
                    if (zeroObservations >= policy.zeroMemberObservations)
                    {
                        return observed;
                    }
                }
                else
                {
                    zeroObservations = 0;
                }
                waitForObservationInterval(policy.observationIntervalMs);
            }
            return show();
        };
        spawnSync('systemctl', [
            '--user',
            'kill',
            '--kill-who=all',
            '--signal=SIGTERM',
            authority.unitName
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        let observed = waitEmpty(Date.now() + policy.gracefulTerminationMs);
        let forced = false;
        if (observed.status === 'verified' && !observed.empty)
        {
            forced = true;
            spawnSync('systemctl', [
                '--user',
                'kill',
                '--kill-who=all',
                '--signal=SIGKILL',
                authority.unitName
            ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            spawnSync('systemctl', ['--user', 'stop', authority.unitName], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            });
            observed = waitEmpty(Date.now() + policy.forceTerminationMs);
        }
        return observed.status === 'verified' && observed.empty
            ? { terminated: true, forced, reason, postObservation: 'zero-members' }
            : {
                terminated: false,
                reason: observed.reason ?? 'systemd cgroup still has live members',
                postObservation: observed.status === 'verified' ? 'members-remain' : 'unverifiable'
            };
    }
    if (authority?.kind === 'windows-job-object')
    {
        if (typeof windowsJobTerminator !== 'function')
        {
            return {
                terminated: false,
                reason: 'Windows Job Object termination adapter is unavailable',
                postObservation: 'unverifiable'
            };
        }
        return windowsJobTerminator({ authority, reason, policy, expectedIdentities });
    }
    if (
        authority?.schema !== 'fsusblog.process-group-or-job-identity.v1' ||
        authority.kind !== 'process-group' ||
        !['linux', 'darwin'].includes(authority.platform) ||
        authority.platform !== platform
    )
    {
        return {
            terminated: false,
            reason: 'physical execution containment authority is incomplete',
            postObservation: 'unverifiable'
        };
    }
    const expectedByPid = new Map(expectedIdentities.map((identity) => [identity.pid, identity]));
    const observe = () =>
    {
        const observed = collectMembers(authority, { platform, procRoot });
        if (observed?.status !== 'verified' || !Array.isArray(observed.identities))
        {
            return {
                status: 'unverifiable',
                reason: observed?.reason ?? 'process-group member collection failed'
            };
        }
        for (const member of observed.identities)
        {
            const expected = expectedByPid.get(member.pid);
            if (expected && !sameIdentity(expected, member))
            {
                return {
                    status: 'unverifiable',
                    reason: `process identity changed before termination for PID ${member.pid}`
                };
            }
        }
        const validation = validateMembers(observed.identities);
        if (validation?.status !== 'verified')
        {
            return {
                status: 'unverifiable',
                reason: validation?.reason ?? 'process-group ownership validation failed'
            };
        }
        return observed;
    };
    const initial = observe();
    if (initial.status !== 'verified')
    {
        return {
            terminated: false,
            reason: initial.reason,
            postObservation: 'unverifiable'
        };
    }
    if (initial.identities.length === 0)
    {
        return {
            terminated: true,
            alreadyAbsent: true,
            reason,
            postObservation: 'zero-members',
            processInventory: []
        };
    }
    const inventory = new Map(initial.identities.map((identity) => [
        `${identity.pid}:${identity.processStartIdentity}`,
        identity
    ]));
    const observeUntil = (deadlineAt) =>
    {
        let zeroObservations = 0;
        while (Date.now() <= deadlineAt)
        {
            const observation = observe();
            if (observation.status !== 'verified')
            {
                return observation;
            }
            for (const identity of observation.identities)
            {
                inventory.set(`${identity.pid}:${identity.processStartIdentity}`, identity);
            }
            if (observation.identities.length === 0)
            {
                zeroObservations += 1;
                if (zeroObservations >= policy.zeroMemberObservations)
                {
                    return { status: 'empty', identities: [] };
                }
            }
            else
            {
                zeroObservations = 0;
            }
            waitForObservationInterval(policy.observationIntervalMs);
        }
        return observe();
    };
    try
    {
        signalAuthority(authority, 'SIGTERM');
    }
    catch (error)
    {
        if (error?.code !== 'ESRCH')
        {
            return {
                terminated: false,
                reason: `graceful containment signal failed: ${error.message}`,
                postObservation: 'unverifiable'
            };
        }
    }
    let observation = observeUntil(Date.now() + policy.gracefulTerminationMs);
    let forced = false;
    if (observation.status === 'unverifiable')
    {
        return {
            terminated: false,
            reason: observation.reason,
            postObservation: 'unverifiable',
            processInventory: [...inventory.values()]
        };
    }
    if (observation.status !== 'empty' && observation.identities.length > 0)
    {
        forced = true;
        try
        {
            signalAuthority(authority, 'SIGKILL');
        }
        catch (error)
        {
            if (error?.code !== 'ESRCH')
            {
                return {
                    terminated: false,
                    reason: `forced containment signal failed: ${error.message}`,
                    postObservation: 'unverifiable',
                    processInventory: [...inventory.values()]
                };
            }
        }
        observation = observeUntil(Date.now() + policy.forceTerminationMs);
    }
    if (observation.status !== 'empty')
    {
        return {
            terminated: false,
            reason: observation.reason ?? 'containment authority still has live members',
            postObservation: observation.status === 'verified' ? 'members-remain' : 'unverifiable',
            processInventory: [...inventory.values()]
        };
    }
    return {
        terminated: true,
        forced,
        reason,
        postObservation: 'zero-members',
        processInventory: [...inventory.values()]
    };
}

function residualMarkerFiles(root)
{
    if (!fs.existsSync(root))
    {
        return [];
    }
    return fs.readdirSync(root).filter((entry) => entry.endsWith('.json')).sort();
}

function writeResidualMarker(root, evidence, reason)
{
    fs.mkdirSync(root, { recursive: true });
    const marker = path.join(root, `${Date.now()}-${process.pid}-${randomUUID()}.json`);
    fs.writeFileSync(marker, `${JSON.stringify({
        schema: 'fsusblog.physical-execution-residual-block.v1',
        reason,
        authority: evidence.authority,
        processInventory: evidence.processInventory,
        observedAt: new Date().toISOString()
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return marker;
}

function physicalExecutionError(message, evidence, cause = null)
{
    const error = new Error(message, cause ? { cause } : undefined);
    if (cause?.name)
    {
        error.name = cause.name;
    }
    if (cause?.signal)
    {
        error.signal = cause.signal;
    }
    if (Number.isInteger(cause?.exitCode))
    {
        error.exitCode = cause.exitCode;
    }
    if (cause?.releaseReliabilityCancellation)
    {
        error.releaseReliabilityCancellation = cause.releaseReliabilityCancellation;
    }
    for (const field of [
        'physicalExecutionContainmentError',
        'physicalExecutionFinalizeError',
        'physicalExecutionLogError',
        'physicalExecutionTerminalError'
    ])
    {
        if (cause?.[field])
        {
            error[field] = cause[field];
        }
    }
    error.physicalExecution = evidence;
    return error;
}

async function waitForExit(child)
{
    return await new Promise((resolve, reject) =>
    {
        child.once('error', reject);
        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    });
}

async function rejectUnestablishedUnixAuthority({
    child,
    outputTracker,
    policy,
    message
})
{
    const terminalPromise = child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve({ exitCode: child.exitCode, signal: child.signalCode })
        : waitForExit(child).catch((error) => ({ error }));
    let cleanupError = null;
    try
    {
        child.kill('SIGKILL');
    }
    catch (error)
    {
        if (error?.code !== 'ESRCH')
        {
            cleanupError = error;
        }
    }
    const terminal = await boundedValue(terminalPromise, policy.forceTerminationMs);
    const output = await outputTracker.close();
    const failure = new Error(message);
    if (cleanupError || !terminal.completed || terminal.value?.error)
    {
        failure.physicalExecutionPreflightCleanupError = terminal.completed
            ? cleanupError?.message ?? terminal.value.error.message
            : 'unaccepted containment supervisor did not become terminal before the deadline';
        if (!terminal.completed || terminal.value?.error)
        {
            child.unref();
        }
    }
    if (!output.logComplete)
    {
        failure.physicalExecutionPreflightLogError = output.logTruncationReason;
    }
    throw failure;
}

async function startUnixExecution({
    command,
    cwd,
    env,
    signal,
    policy,
    residualRoot,
    collectIdentity,
    collectAuthority,
    collectMembers,
    procRoot,
    spawnProcess,
    signalGroup,
    stdout,
    stderr
})
{
    const lifecycle = ['created'];
    const termination = [];
    const inventory = new Map();
    const outputTracker = createPhysicalExecutionOutputTracker({ policy, stdout, stderr });
    const encodedCommand = Buffer.from(JSON.stringify(command), 'utf8').toString('base64url');
    const child = spawnProcess(process.execPath, [unixBootstrap, encodedCommand], {
        cwd,
        env,
        detached: true,
        stdio: ['inherit', 'pipe', 'pipe', 'ipc']
    });
    outputTracker.attach(child.stdout, 'stdout');
    outputTracker.attach(child.stderr, 'stderr');
    await new Promise((resolve, reject) =>
    {
        child.on('message', (message) =>
        {
            if (message?.type === 'physical-execution-bootstrap-ready')
            {
                resolve();
            }
        });
        child.once('error', reject);
    });

    const leader = collectIdentity(child.pid, { platform: process.platform, procRoot });
    if (leader.status !== 'verified')
    {
        await rejectUnestablishedUnixAuthority({
            child,
            outputTracker,
            policy,
            message: `physical execution leader identity is unverifiable: ${leader.reason}`
        });
    }
    const authorityResult = collectAuthority(child.pid, { platform: process.platform, procRoot });
    if (authorityResult.status !== 'verified' || authorityResult.value.kind !== 'process-group')
    {
        await rejectUnestablishedUnixAuthority({
            child,
            outputTracker,
            policy,
            message: `physical execution process group is unverifiable: ${authorityResult.reason ?? 'incomplete authority'}`
        });
    }
    const authority = authorityResult.value;
    if (authority.groupId !== child.pid)
    {
        await rejectUnestablishedUnixAuthority({
            child,
            outputTracker,
            policy,
            message: 'physical execution child did not become its run-owned process-group leader'
        });
    }
    recordMembers(inventory, [leader], authority, child.pid, process.platform, procRoot);
    child.send({ type: 'physical-execution-start' });
    const commandChildPid = await new Promise((resolve, reject) =>
    {
        const onExit = () => reject(new Error('physical execution bootstrap exited before command registration'));
        child.once('exit', onExit);
        child.on('message', (message) =>
        {
            if (message?.type !== 'physical-execution-child-started')
            {
                return;
            }
            child.off('exit', onExit);
            resolve(Number(message.pid));
        });
    });
    const commandChild = collectIdentity(commandChildPid, { platform: process.platform, procRoot });
    if (commandChild.status !== 'verified')
    {
        signalGroup(-child.pid, 'SIGKILL');
        throw new Error(`physical execution command identity is unverifiable: ${commandChild.reason}`);
    }
    recordMembers(inventory, [commandChild], authority, commandChildPid, process.platform, procRoot);
    const commandChildKey = `${commandChild.pid}:${commandChild.processStartIdentity}`;
    inventory.get(commandChildKey).role = 'direct-child';
    inventory.get(`${leader.pid}:${leader.processStartIdentity}`).role = 'containment-supervisor';
    child.disconnect();
    lifecycle.push('running');

    let abortReason = null;
    let resolveAbort;
    const abortPromise = new Promise((resolve) =>
    {
        resolveAbort = resolve;
    });
    const onAbort = () =>
    {
        abortReason = signal?.reason;
        resolveAbort({ kind: 'cancel' });
    };
    if (signal?.aborted)
    {
        onAbort();
    }
    else
    {
        signal?.addEventListener('abort', onAbort, { once: true });
    }

    const childExitPromise = waitForExit(child).then(
        (value) => ({ kind: 'exit', ...value }),
        (error) => ({ kind: 'error', error })
    );
    let first = await Promise.race([childExitPromise, abortPromise]);
    let postObservedZero = false;
    let output = null;
    const terminateTree = async (reason) =>
    {
        lifecycle.push('mark-cancelling', 'stop-new-spawns');
        const beforeSignal = collectMembers(authority, { platform: process.platform, procRoot });
        if (beforeSignal?.status !== 'verified')
        {
            throw new Error(`physical execution member collection failed before termination: ${beforeSignal?.reason ?? 'unknown'}`);
        }
        recordMembers(inventory, beforeSignal.identities, authority, child.pid, process.platform, procRoot);
        if (beforeSignal.identities.length > 0)
        {
            lifecycle.push('forward-graceful-signal');
            signalGroup(-authority.groupId, 'SIGTERM');
            termination.push({ phase: 'graceful', signal: 'SIGTERM', reason, observedAt: new Date().toISOString() });
        }
        lifecycle.push('wait-grace-period');
        let observed = await stableMemberObservation({
            authority,
            inventory,
            leaderPid: child.pid,
            policy,
            collectMembers,
            platform: process.platform,
            procRoot,
            deadlineAt: Date.now() + policy.gracefulTerminationMs
        });
        if (observed.status !== 'empty')
        {
            lifecycle.push('force-kill-remaining-tree');
            const recheck = collectMembers(authority, { platform: process.platform, procRoot });
            if (recheck?.status !== 'verified')
            {
                throw new Error(`physical execution member collection failed before force kill: ${recheck?.reason ?? 'unknown'}`);
            }
            recordMembers(inventory, recheck.identities, authority, child.pid, process.platform, procRoot);
            if (recheck.identities.length > 0)
            {
                signalGroup(-authority.groupId, 'SIGKILL');
                termination.push({ phase: 'forced', signal: 'SIGKILL', reason, observedAt: new Date().toISOString() });
            }
            observed = await stableMemberObservation({
                authority,
                inventory,
                leaderPid: child.pid,
                policy,
                collectMembers,
                platform: process.platform,
                procRoot,
                deadlineAt: Date.now() + policy.forceTerminationMs
            });
        }
        if (observed.status !== 'empty')
        {
            throw new Error(`physical execution left ${observed.members.length} process-group member(s)`);
        }
        lifecycle.push('bounded-pipe-close');
        output = await outputTracker.close();
        observed = await stableMemberObservation({
            authority,
            inventory,
            leaderPid: child.pid,
            policy,
            collectMembers,
            platform: process.platform,
            procRoot,
            deadlineAt: Date.now() + policy.forceTerminationMs
        });
        if (observed.status !== 'empty')
        {
            throw new Error(`physical execution left ${observed.members.length} process-group member(s) after pipe close`);
        }
        lifecycle.push('post-observe-zero-members');
        postObservedZero = true;
    };

    let exit = first.kind === 'exit' ? first : null;
    let failure = first.kind === 'cancel'
        ? abortReason instanceof Error
            ? abortReason
            : Object.assign(new Error('physical execution cancelled'), { name: 'AbortError' })
        : first.kind === 'error'
            ? first.error
            : exit.exitCode !== 0 || exit.signal
                ? Object.assign(
                    new Error(`command failed (${exit.signal ? `signal ${exit.signal}` : `exit ${exit.exitCode}`}): ${command.join(' ')}`),
                    { exitCode: exit.exitCode, signal: exit.signal }
                )
                : null;
    const attachSecondaryFailure = (field, error) =>
    {
        if (!failure)
        {
            failure = error;
            return;
        }
        if (!failure[field])
        {
            failure[field] = {
                name: error.name,
                message: error.message
            };
        }
    };
    try
    {
        if (first.kind === 'cancel')
        {
            try
            {
                await terminateTree('cancel');
            }
            catch (error)
            {
                attachSecondaryFailure('physicalExecutionContainmentError', error);
            }
            const terminal = await boundedValue(childExitPromise, policy.forceTerminationMs);
            if (terminal.completed)
            {
                exit = terminal.value.kind === 'exit' ? terminal.value : null;
                if (terminal.value.kind === 'error')
                {
                    attachSecondaryFailure('physicalExecutionTerminalError', terminal.value.error);
                }
            }
            else
            {
                attachSecondaryFailure(
                    'physicalExecutionTerminalError',
                    new Error('physical execution child did not become terminal before the deadline')
                );
            }
        }
        else if (first.kind === 'error')
        {
            try
            {
                await terminateTree('child-process-error');
            }
            catch (error)
            {
                attachSecondaryFailure('physicalExecutionContainmentError', error);
            }
        }
        else
        {
            const postExit = collectMembers(authority, { platform: process.platform, procRoot });
            if (postExit?.status !== 'verified')
            {
                throw new Error(`physical execution post-exit member collection failed: ${postExit?.reason ?? 'unknown'}`);
            }
            recordMembers(inventory, postExit.identities, authority, child.pid, process.platform, procRoot);
            if (postExit.identities.length > 0)
            {
                failure ??= new Error('physical execution parent exited before its process group became empty');
                try
                {
                    await terminateTree('parent-exited-with-live-descendants');
                }
                catch (error)
                {
                    attachSecondaryFailure('physicalExecutionContainmentError', error);
                }
            }
            else
            {
                lifecycle.push('bounded-pipe-close');
                output = await outputTracker.close();
                const observed = await stableMemberObservation({
                    authority,
                    inventory,
                    leaderPid: child.pid,
                    policy,
                    collectMembers,
                    platform: process.platform,
                    procRoot,
                    deadlineAt: Date.now() + policy.forceTerminationMs
                });
                if (observed.status !== 'empty')
                {
                    throw new Error(`physical execution left ${observed.members.length} process-group member(s) after pipe close`);
                }
                lifecycle.push('post-observe-zero-members');
                postObservedZero = true;
            }
        }
    }
    catch (error)
    {
        attachSecondaryFailure('physicalExecutionContainmentError', error);
    }
    finally
    {
        signal?.removeEventListener('abort', onAbort);
    }
    if (output === null)
    {
        output = await outputTracker.close();
    }
    if (!output.logComplete)
    {
        attachSecondaryFailure(
            'physicalExecutionLogError',
            new Error(`physical execution log is incomplete: ${output.logTruncationReason}`)
        );
    }
    lifecycle.push(failure ? 'seal-cancelled-or-failed-receipt' : 'seal-completed-receipt');

    for (const record of inventory.values())
    {
        if (record.role === 'direct-child')
        {
            record.exitCode = exit?.exitCode ?? null;
            record.signal = exit?.signal ?? null;
        }
        else if (termination.some((entry) => entry.phase === 'forced'))
        {
            record.signal = 'SIGKILL';
        }
        else if (termination.some((entry) => entry.phase === 'graceful'))
        {
            record.signal = 'SIGTERM';
        }
    }
    const evidence = {
        schema: physicalExecutionProcessTreeSchema,
        platform: process.platform,
        policy,
        authority,
        lifecycle,
        termination,
        postObservation: postObservedZero ? 'zero-members' : 'unverifiable',
        processInventory: [...inventory.values()].sort((left, right) => left.pid - right.pid),
        ...output
    };
    if (failure)
    {
        if (evidence.postObservation !== 'zero-members')
        {
            evidence.residualBlock = writeResidualMarker(residualRoot, evidence, failure.message);
            child.unref();
        }
        throw physicalExecutionError(failure.message, evidence, failure);
    }
    return evidence;
}

async function executePhysicalExecution({
    command,
    cwd = process.cwd(),
    env = process.env,
    controlEnv = process.env,
    linuxPrivateNetwork = false,
    linuxNetworkPolicy = null,
    linuxReadWritePaths = [],
    linuxOwnedPrivateTmp = null,
    originalNativeInputs = null,
    originalNativeInputCarrier = null,
    resourceBoundary = null,
    resourceContext = null,
    processOwner = null,
    residentServiceOutput = false,
    nestedChannel = null,
    privateDotnetScratch = null,
    signal,
    platform = process.platform,
    policy = readPolicy(),
    residualRoot = defaultResidualRoot,
    windowsJobAdapter = null,
    collectIdentity = collectProcessIdentity,
    collectAuthority = collectProcessGroupOrJobIdentity,
    collectMembers = processGroupMemberIdentities,
    procRoot = '/proc',
    spawnProcess = spawn,
    signalGroup = process.kill.bind(process),
    stdout = process.stdout,
    stderr = process.stderr,
    observePhysicalExecution
})
{
    let observedPhysicalExecution = null;
    const observeActual = (evidence) =>
    {
        observedPhysicalExecution = evidence;
        observePhysicalExecution(evidence);
    };
    if (!Array.isArray(command) || command.length === 0)
    {
        throw new Error('physical execution requires a command');
    }
    if ((originalNativeInputs !== null || originalNativeInputCarrier !== null)
        && (resourceBoundary === null || processOwner === null || linuxOwnedPrivateTmp === null
            || platform !== 'linux' || residentServiceOutput || process.env[nestedExecutionChannelKey]))
        throw new Error('original required native inputs need their direct canonical resource/process/privateTmp owners');
    if (originalNativeInputCarrier !== null)
    {
        if (nestedChannel === null) throw new Error('internal native carrier requires its original live channel');
        inspectOriginalNativeInputCarrier(originalNativeInputCarrier, { command });
    }
    if (nestedChannel !== null && (!nestedExecutionChannelIsOwned(nestedChannel) || !resourceBoundary || !processOwner
        || JSON.stringify(nestedChannel.descriptor.reference) !== JSON.stringify(resourceBoundary.reference)))
    {
        throw new Error('nested execution requires its original in-process channel owner');
    }
    if ((resourceBoundary !== null || processOwner !== null) && (platform !== 'linux' || procRoot !== '/proc'
        || spawnProcess !== spawn || collectIdentity !== collectProcessIdentity
        || collectAuthority !== collectProcessGroupOrJobIdentity || collectMembers !== processGroupMemberIdentities))
    {
        throw new Error('resource-bound physical execution requires the canonical Linux process owner');
    }
    if (process.env[nestedExecutionChannelKey] && (platform !== 'linux' || procRoot !== '/proc'
        || spawnProcess !== spawn || collectIdentity !== collectProcessIdentity
        || collectAuthority !== collectProcessGroupOrJobIdentity || collectMembers !== processGroupMemberIdentities))
    {
        throw new Error('nested physical execution requires the canonical Linux process owner');
    }
    if (resourceBoundary === null && resourceContext !== null)
    {
        throw new Error('resource execution context requires its live boundary capability');
    }
    if (processOwner !== null && resourceBoundary === null)
    {
        throw new Error('durable process ownership requires its live resource boundary');
    }
    if (residentServiceOutput && (!resourceBoundary || !processOwner))
    {
        throw new Error('resident service output requires the original durable Linux process owner');
    }
    if (resourceBoundary !== null && (!Number.isSafeInteger(policy.systemdControlCommandTimeoutMs)
        || policy.systemdControlCommandTimeoutMs <= 0
        || !Number.isSafeInteger(policy.systemdResourceStartupTimeoutMs)
        || policy.systemdResourceStartupTimeoutMs <= 0))
    {
        throw new Error('resource-bound physical execution requires the registered systemd control and startup budgets');
    }
    const residuals = residualMarkerFiles(residualRoot);
    if (residuals.length > 0)
    {
        throw new Error(`physical execution preflight blocked by unresolved residual receipt: ${residuals[0]}`);
    }
    if (platform === 'win32')
    {
        if (windowsJobAdapter === false)
        {
            throw new Error('physical execution Windows Job Object adapter is unavailable');
        }
        const adapter = windowsJobAdapter ?? (await import('./physical-execution-windows-job-adapter.mjs'))
            .createPhysicalExecutionWindowsJobAdapter();
        if (typeof adapter?.run !== 'function')
        {
            throw new Error('physical execution Windows Job Object adapter is unavailable');
        }
        let evidence;
        try
        {
            evidence = await adapter.run({ command, cwd, env, signal, policy, residualRoot, stdout, stderr });
        }
        catch (error)
        {
            const failureEvidence = observedPhysicalExecution ?? {
                schema: physicalExecutionProcessTreeSchema,
                platform: 'win32',
                policy,
                authority: null,
                lifecycle: ['created', 'post-observation-unverifiable'],
                termination: [],
                postObservation: 'unverifiable',
                processInventory: [],
                logComplete: false,
                logTruncationReason: 'adapter-failed-before-pipe-closure',
                forcedPipeClose: false,
                outputCapture: {
                    maximumBytesPerStream: policy.maximumCapturedOutputBytesPerStream,
                    stdoutBytes: 0,
                    stderrBytes: 0,
                    stdoutCapturedBytes: 0,
                    stderrCapturedBytes: 0,
                    stdoutTruncated: false,
                    stderrTruncated: false
                },
                stdout: '',
                stderr: ''
            };
            if (failureEvidence.postObservation !== 'zero-members')
            {
                failureEvidence.residualBlock = writeResidualMarker(
                    residualRoot,
                    failureEvidence,
                    formatExecutionFailure(error)
                );
            }
            if (error && typeof error === 'object')
            {
                retainExecutionFailureCompatibility(error, 'physicalExecution', failureEvidence);
            }
            throw error;
        }
        if (
            evidence?.schema !== physicalExecutionProcessTreeSchema ||
            evidence.platform !== 'win32' ||
            evidence.authority?.kind !== 'windows-job-object' ||
            evidence.authority.platform !== 'win32' ||
            !evidence.authority.jobName ||
            evidence.authority.killPolicy !== 'kill-on-close' ||
            evidence.postObservation !== 'zero-members' ||
            evidence.logComplete !== true ||
            evidence.logTruncationReason !== null ||
            evidence.forcedPipeClose !== false ||
            !evidence.lifecycle?.includes('bounded-pipe-close') ||
            !Array.isArray(evidence.processInventory)
        )
        {
            const error = new Error(
                'physical execution Windows Job Object adapter returned unverifiable evidence'
            );
            observeActual(evidence);
            retainExecutionFailureCompatibility(error, 'physicalExecution', evidence);
            if (evidence?.postObservation !== 'zero-members')
            {
                evidence.residualBlock = writeResidualMarker(
                    residualRoot,
                    evidence,
                    error.message
                );
            }
            throw error;
        }
        observeActual(evidence);
        return evidence;
    }
    if (
        platform === 'linux' &&
        procRoot === '/proc' &&
        spawnProcess === spawn &&
        collectIdentity === collectProcessIdentity &&
        collectAuthority === collectProcessGroupOrJobIdentity &&
        collectMembers === processGroupMemberIdentities
    )
    {
        if (resourceBoundary === null)
        {
            const channelValue = process.env[nestedExecutionChannelKey];
            if (channelValue)
            {
                return runNestedPhysicalExecution({ descriptor: JSON.parse(channelValue), command, cwd, env,
                    linuxPrivateNetwork, linuxNetworkPolicy, linuxReadWritePaths, linuxOwnedPrivateTmp,
                    privateDotnetScratch, signal, policy, stdout, stderr });
            }
            if (/\/fsusblogresource[a-f0-9]{32}\.slice\//u.test(fs.readFileSync('/proc/self/cgroup', 'utf8')))
            {
                throw new Error('resource-bound nested execution is missing its original owner channel');
            }
        }
        if (resourceBoundary !== null && processOwner && nestedChannel === null)
        {
            let channel;
            const invocationOwner = createExecutionFailureOwner();
            const nativeCarrier = originalNativeInputs === null ? null : await createOriginalNativeInputCarrier({
                originalNativeInputs, linuxOwnedPrivateTmp, resourceBoundary, resourceContext, command, env, linuxReadWritePaths, signal });
            const runOwned = (options, directNativeCarrier = null) => runPhysicalExecution({ ...options,
                failureOwner: options.failureOwner ?? invocationOwner, resourceBoundary, resourceContext,
                originalNativeInputCarrier: directNativeCarrier,
                processOwner: { ...processOwner, nestedChannel: channel.descriptor,
                    ...(directNativeCarrier ? { nativeInputCarrier: inspectOriginalNativeInputCarrier(directNativeCarrier).descriptor } : {}) }, nestedChannel: channel,
                controlEnv, policy, residualRoot });
            try
            {
                channel = await createNestedExecutionChannel({ boundary: resourceBoundary, controlEnv, policy, signal, linuxOwnedPrivateTmp,
                    originalNativeInputCarrier: nativeCarrier, physicalFailureOwner: invocationOwner,
                    runNested: (options) => runOwned(options) });
                if (nativeCarrier) inspectOriginalNativeInputCarrier(nativeCarrier, { command });
            }
            catch (error)
            {
                retainExecutionFailure(invocationOwner, error);
                if (nativeCarrier)
                {
                    retainExecutionRecovery(invocationOwner, { nativeInputCleanupObservation: channel?.nativeInputCleanupObservation });
                    retainExecutionFailureCompatibility(error, 'nativeInputCleanupObservation', channel?.nativeInputCleanupObservation);
                    try
                    {
                        if (channel) await channel.close();
                        else closeOriginalNativeInputCarrierBeforeSpawn(nativeCarrier);
                    }
                    catch (cleanupError)
                    {
                        retainExecutionFailure(invocationOwner, cleanupError);
                        retainExecutionFailureCompatibility(error, 'nativeInputCleanupError', cleanupError);
                    }
                }
                throwExecutionFailure(invocationOwner);
            }
            let result;
            try
            {
                result = await runOwned({ command, cwd, env: { ...env, [nestedExecutionChannelKey]: JSON.stringify(channel.descriptor) },
                    linuxPrivateNetwork, linuxNetworkPolicy, linuxReadWritePaths, linuxOwnedPrivateTmp,
                    residentServiceOutput, privateDotnetScratch,
                    signal, stdout, stderr }, nativeCarrier);
            }
            catch (error) { retainExecutionFailure(invocationOwner, error); }
            let actual = observePhysicalExecutionFailure(invocationOwner).physicalExecution;
            try
            {
                const nested = await channel.close();
                if (actual) actual = { ...actual, nestedExecution: nested };
                if (!nested.logComplete)
                {
                    retainExecutionFailure(invocationOwner, new Error('nested execution output became unverifiable after caller disconnect'));
                    if (actual) actual = { ...actual, logComplete: false, logTruncationReason: 'nested-caller-disconnected' };
                }
            }
            catch (error)
            {
                retainExecutionFailure(invocationOwner, error);
                if (actual)
                {
                    actual = { ...actual, postObservation: 'unverifiable' };
                    try { actual.residualBlock = writeResidualMarker(residualRoot, actual, formatExecutionFailure(error)); }
                    catch (markerError) { retainExecutionFailure(invocationOwner, markerError); }
                }
            }
            if (actual) observeActual(actual);
            throwExecutionFailure(invocationOwner);
            return { ...result, ...actual };
        }
        const adapter = (await import('./physical-execution-linux-systemd-adapter.mjs'))
            .createPhysicalExecutionLinuxSystemdAdapter();
        try
        {
            const evidence = await adapter.run({
                observePhysicalExecution: observeActual,
                command,
                cwd,
                env,
                controlEnv,
                linuxPrivateNetwork,
                linuxNetworkPolicy,
                linuxReadWritePaths,
                linuxOwnedPrivateTmp,
                originalNativeInputCarrier,
                resourceBoundary,
                resourceContext,
                processOwner,
                residentServiceOutput,
                privateDotnetScratch,
                signal,
                policy,
                residualRoot,
                stdout,
                stderr,
                schema: physicalExecutionProcessTreeSchema
            });
            const resourceAdmission = evidence?.resourceExecutionAdmission;
            const containment = evidence?.containmentAuthority;
            if (resourceBoundary !== null && (!resourceAdmission
                || digestCanonical(resourceAdmission.reference) !== digestCanonical(resourceBoundary.reference)
                || !productionSystemdServiceBindingIsComplete(resourceAdmission.serviceBinding)
                || resourceAdmission.serviceBinding.identity === null
                || digestCanonical(resourceAdmission.serviceBinding.reference) !== digestCanonical(resourceBoundary.reference)
                || resourceAdmission.processIdentity?.schema !== 'fsusblog.process-identity.v1'
                || resourceAdmission.processIdentity.status !== 'verified'
                || resourceAdmission.processIdentity.pid !== evidence?.authority?.processGroup?.groupId)
                || processOwner !== null && (!resourceServiceContainmentIsComplete(containment)
                    || digestCanonical(containment.serviceBinding) !== digestCanonical(resourceAdmission?.serviceBinding)
                    || digestCanonical(containment.supervisorProcessIdentity) !== digestCanonical(resourceAdmission?.processIdentity)
                    || !['pre-exec', ...(residentServiceOutput ? ['resident-transferred'] : [])].includes(containment.phase)))
            {
                const error = new Error('physical execution managed admission differs from its original resource and process owners');
                observeActual(evidence);
                retainExecutionFailureCompatibility(error, 'physicalExecution', evidence);
                throw error;
            }
            if (
                evidence?.schema !== physicalExecutionProcessTreeSchema ||
                evidence.platform !== 'linux' ||
                evidence.authority?.kind !== 'linux-cgroup-process-group' ||
                evidence.authority.established !== true ||
                evidence.authority.processGroup?.kind !== 'process-group' ||
                evidence.authority.processGroup.groupId
                    !== evidence.authority.processGroup.leaderPid ||
                !['zero-members', ...(residentServiceOutput ? ['resident-transferred'] : [])]
                    .includes(evidence.postObservation) ||
                evidence.logComplete !== true ||
                evidence.logTruncationReason !== null ||
                evidence.forcedPipeClose !== false ||
                !(residentServiceOutput
                    ? evidence.containmentAuthority?.residentOutput?.schema === residentServiceOutputSchema
                        && evidence.lifecycle?.includes('bounded-file-output-capture')
                        && ['stdout', 'stderr'].every((name) =>
                            /^sha256:[a-f0-9]{64}$/u.test(evidence.outputFiles?.[name]?.digest ?? ''))
                    : evidence.lifecycle?.includes('bounded-pipe-close')) ||
                (evidence.postObservation === 'resident-transferred'
                    ? evidence.containmentAuthority?.phase !== 'resident-transferred'
                        || !resourceServiceContainmentIsComplete(evidence.containmentAuthority)
                        || evidence.cleanup?.status !== 'transferred'
                        || evidence.lifecycle?.includes('post-observe-zero-members')
                        || !evidence.lifecycle?.includes('resident-service-transferred')
                    : !evidence.lifecycle?.includes('post-observe-zero-members')) ||
                !Array.isArray(evidence.processInventory)
            )
            {
                const error = new Error(
                    'physical execution Linux cgroup adapter returned unverifiable evidence'
                );
                observeActual(evidence);
                retainExecutionFailureCompatibility(error, 'physicalExecution', evidence);
                throw error;
            }
            observeActual(evidence);
            return evidence;
        }
        catch (error)
        {
            const failureEvidence = observedPhysicalExecution ?? {
                schema: physicalExecutionProcessTreeSchema,
                platform: 'linux',
                policy,
                authority: null,
                lifecycle: ['created', 'containment-authority-not-established', 'post-observation-unverifiable'],
                termination: [],
                postObservation: 'unverifiable',
                processInventory: [],
                logComplete: false,
                logTruncationReason: 'adapter-failed-before-pipe-closure',
                forcedPipeClose: false,
                outputCapture: {
                    maximumBytesPerStream: policy.maximumCapturedOutputBytesPerStream,
                    stdoutBytes: 0,
                    stderrBytes: 0,
                    stdoutCapturedBytes: 0,
                    stderrCapturedBytes: 0,
                    stdoutTruncated: false,
                    stderrTruncated: false
                },
                stdout: '',
                stderr: ''
            };
            if (error && typeof error === 'object')
            {
                retainExecutionFailureCompatibility(error, 'physicalExecution', failureEvidence);
            }
            if (failureEvidence.postObservation !== 'zero-members')
            {
                try
                {
                    failureEvidence.residualBlock = writeResidualMarker(
                        residualRoot,
                        failureEvidence,
                        formatExecutionFailure(error)
                    );
                }
                catch (markerError)
                {
                    if (error && typeof error === 'object')
                    {
                        retainExecutionFailureCompatibility(error, 'physicalExecutionFinalizeError', markerError);
                    }
                }
            }
            observeActual(failureEvidence);
            throw error;
        }
    }
    if (!['linux', 'darwin'].includes(platform))
    {
        throw new Error(`physical execution platform is unsupported: ${platform}`);
    }
    return await startUnixExecution({
        command,
        cwd,
        env,
        signal,
        policy,
        residualRoot,
        collectIdentity,
        collectAuthority,
        collectMembers,
        procRoot,
        spawnProcess,
        signalGroup,
        stdout,
        stderr
    });
}

export function loadPhysicalExecutionProcessPolicy(file)
{
    return readPolicy(file);
}

/** The actual invocation owns its observations; a thrown value supplies no terminal authority. */
export async function runPhysicalExecution(options)
{
    const failureOwner = options.failureOwner ?? createExecutionFailureOwner();
    observeExecutionFailure(failureOwner);
    const observation = { physicalExecution: null, physicalTerminal: null, settled: false,
        originalNativeInputCarrier: options.originalNativeInputCarrier ?? null };
    const invocations = physicalInvocationObservations.get(failureOwner) ?? [];
    invocations.push(observation);
    physicalInvocationObservations.set(failureOwner, invocations);
    const observeActual = (physicalExecution) =>
    {
        observation.physicalExecution = physicalExecution;
        observation.physicalTerminal = executionFailureDataProperty(physicalExecution, 'postObservation') ?? null;
    };
    try
    {
        const physicalExecution = await executePhysicalExecution({ ...options,
            observePhysicalExecution: observeActual });
        observeActual(physicalExecution);
        return physicalExecution;
    }
    catch (reason)
    {
        retainExecutionFailure(failureOwner, reason);
        throwExecutionFailure(failureOwner);
    }
    finally
    {
        observation.settled = true;
    }
}
