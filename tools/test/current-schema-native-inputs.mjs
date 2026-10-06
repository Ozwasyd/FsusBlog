import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { originalFileEpochObservationSha256, originalLinuxDeviceNumbers,
    originalLinuxTimestampParts } from './original-native-file-epoch.mjs';

const inputs = new WeakMap();
const maximumBytes = 1024 * 1024; // Same original env/CurrentSchemaReceiptCodec caps.
const directoryFlags = 0x200000 | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW; // Linux O_PATH.
const roles = Object.freeze([
    Object.freeze({ name: 'collector-environment', relative: 'inputs/primary.env', targetDescriptor: 4, emptyAllowed: true }),
    Object.freeze({ name: 'collector-receipt', relative: 'published/current-schema-receipt.bin', targetDescriptor: 5, emptyAllowed: false })
]);
const fail = (reason) => { throw new Error(`original current-schema inputs: ${reason}`); };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stat = (descriptor) => fs.fstatSync(descriptor, { bigint: true });

function checkSignal(signal)
{
    signal?.throwIfAborted();
}

function canonical(value)
{
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
        || /[\p{Cc}\p{Cs}]/u.test(value) || Buffer.byteLength(value, 'utf8') > 4095)
        fail('canonical original path required');
    return value;
}

function directoryIdentity(value)
{
    return { ...originalLinuxDeviceNumbers(value.dev), inode: value.ino.toString(), mode: value.mode.toString() };
}

function leafIdentity(value)
{
    const modified = originalLinuxTimestampParts(value.mtimeNs);
    const changed = originalLinuxTimestampParts(value.ctimeNs);
    return { ...directoryIdentity(value), links: value.nlink.toString(), uid: value.uid.toString(),
        gid: value.gid.toString(), size: value.size.toString(), modifiedSeconds: modified.seconds,
        modifiedNanoseconds: modified.nanoseconds, changedSeconds: changed.seconds,
        changedNanoseconds: changed.nanoseconds };
}

function requireDirectory(value, original, attemptRoot, uid)
{
    if (!value.isDirectory()) fail('original ancestor must be a directory');
    if ((original === attemptRoot || original.startsWith(`${attemptRoot}/`))
        && (value.uid !== uid || (value.mode & 0o7777n) !== 0o700n))
        fail('task-owned input ancestors require original UID and mode 0700');
}

function requireLeaf(value, descriptor, emptyAllowed, uid)
{
    if (!value.isFile() || value.nlink !== 1n || value.uid !== uid
        || (value.mode & 0o7777n) !== 0o600n || value.size > BigInt(maximumBytes)
        || value.size < (emptyAllowed ? 0n : 1n))
        fail('input requires bounded single-link original UID mode 0600 regular file');
    const flagsLine = fs.readFileSync(`/proc/self/fdinfo/${descriptor}`, 'utf8').match(/^flags:\s*([0-7]+)$/mu);
    if (!flagsLine) fail('held input descriptor flags unavailable');
    const flags = BigInt(`0o${flagsLine[1]}`);
    if ((flags & 3n) !== 0n || (flags & 0x200000n) !== 0n || (flags & 0x80000n) === 0n)
        fail('held input descriptor must be read-only, non-O_PATH and close-on-exec');
}

function openAncestors(file, attemptRoot, uid, signal)
{
    const directories = [];
    let failure;
    try
    {
        const components = file.split('/').filter(Boolean);
        let original = '/';
        for (let index = 0; index < components.length; index += 1)
        {
            checkSignal(signal);
            const access = index === 0 ? '/' : `/proc/self/fd/${directories.at(-1).descriptor}/${components[index - 1]}`;
            const descriptor = fs.openSync(access, directoryFlags);
            directories.push({ descriptor, original, identity: null });
            const observed = stat(descriptor);
            requireDirectory(observed, original, attemptRoot, uid);
            directories.at(-1).identity = directoryIdentity(observed);
            original = path.join(original, components[index]);
        }
        return directories;
    }
    catch (error)
    {
        failure = error;
        throw error;
    }
    finally
    {
        if (failure) closeDescriptors(directories.map((value) => value.descriptor), failure);
    }
}

function closeDescriptors(descriptors, originalFailure = null)
{
    const failures = originalFailure ? [originalFailure] : [];
    for (const descriptor of descriptors.reverse())
    {
        try { fs.closeSync(descriptor); }
        catch (error) { failures.push(error); }
    }
    if (failures.length > (originalFailure ? 1 : 0))
        throw new AggregateError(failures, 'original current-schema input descriptor cleanup failed');
}

function observation(record, actual)
{
    return { path: record.file, leaf: leafIdentity(actual),
        ancestors: record.directories.map((directory) => directory.identity) };
}

function recheck(record, attemptRoot, uid, signal)
{
    checkSignal(signal);
    requireLeaf(stat(record.descriptor), record.descriptor, record.role.emptyAllowed, uid);
    const currentDirectories = openAncestors(record.file, attemptRoot, uid, signal);
    let namedDescriptor;
    let failure;
    try
    {
        for (let index = 0; index < record.directories.length; index += 1)
        {
            const held = record.directories[index];
            const actual = stat(held.descriptor);
            requireDirectory(actual, held.original, attemptRoot, uid);
            if (JSON.stringify(directoryIdentity(actual)) !== JSON.stringify(held.identity)
                || JSON.stringify(currentDirectories[index].identity) !== JSON.stringify(held.identity))
                fail('original ancestor incarnation changed');
        }
        const access = `/proc/self/fd/${currentDirectories.at(-1).descriptor}/${path.basename(record.file)}`;
        namedDescriptor = fs.openSync(access, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const named = stat(namedDescriptor);
        requireLeaf(named, namedDescriptor, record.role.emptyAllowed, uid);
        if (originalFileEpochObservationSha256(observation(record, named)) !== record.epochSha256
            || originalFileEpochObservationSha256(observation(record, stat(record.descriptor))) !== record.epochSha256)
            fail('original input full epoch changed');
        checkSignal(signal);
    }
    catch (error) { failure = error; throw error; }
    finally
    {
        closeDescriptors([...currentDirectories.map((directory) => directory.descriptor),
            ...(namedDescriptor === undefined ? [] : [namedDescriptor])], failure);
    }
}

function readBounded(record, signal)
{
    const length = stat(record.descriptor).size;
    if (length > BigInt(maximumBytes)) fail('original input byte cap exceeded');
    const bytes = Buffer.alloc(Number(length));
    try
    {
        let offset = 0;
        while (offset < bytes.length)
        {
            checkSignal(signal);
            const count = fs.readSync(record.descriptor, bytes, offset, bytes.length - offset, offset);
            if (!count) fail('original input truncated during bounded read');
            offset += count;
        }
        const trailing = Buffer.alloc(1);
        try
        {
            checkSignal(signal);
            if (fs.readSync(record.descriptor, trailing, 0, 1, bytes.length)) fail('original input grew during bounded read');
        }
        finally { trailing.fill(0); }
        checkSignal(signal);
        return bytes;
    }
    catch (error) { bytes.fill(0); throw error; }
}

function validate(record, signal)
{
    if (record.closed) fail('input custody is closed');
    if (record.revoked) fail('input custody is revoked');
    try
    {
        if (fs.readlinkSync('/proc/self/ns/mnt') !== record.mountNamespace)
            fail('original parent mount namespace changed');
        for (const file of record.files)
        {
            recheck(file, record.attemptRoot, record.uid, signal);
            const current = readBounded(file, signal);
            try
            {
                recheck(file, record.attemptRoot, record.uid, signal);
                if (!current.equals(file.bytes)) fail('retained original input bytes changed');
            }
            finally { current.fill(0); }
        }
        const [environment, receipt] = record.files;
        if (environment.identity.dev === receipt.identity.dev && environment.identity.ino === receipt.identity.ino)
            fail('original collector input roles cannot alias one inode');
        if (fs.readlinkSync('/proc/self/ns/mnt') !== record.mountNamespace)
            fail('original parent mount namespace changed');
    }
    catch (error)
    {
        record.revoked = true;
        throw error;
    }
    if (record.revoked) fail('input custody is revoked');
}

function dispose(record)
{
    if (record.closed)
    {
        if (record.cleanupFailure) throw record.cleanupFailure;
        return;
    }
    record.closed = true;
    record.revoked = true;
    record.signal?.removeEventListener('abort', record.abort);
    const descriptors = [];
    for (const file of record.files)
    {
        file.bytes?.fill(0);
        descriptors.push(...file.directories.map((directory) => directory.descriptor));
        if (file.descriptor !== undefined) descriptors.push(file.descriptor);
    }
    try { closeDescriptors(descriptors); }
    catch (error) { record.cleanupFailure = error; throw error; }
}

// This is file-data custody only: no issuer, scheduler, execution or native
// qualification authority is issued. Later physical integration must require
// its own original live admission before inspecting or transmitting these FDs.
export function retainOriginalCurrentSchemaCollectorInputs(attemptRoot, { signal } = {})
{
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)
        || typeof process.getuid !== 'function') fail('original Linux file owner unavailable');
    canonical(attemptRoot);
    checkSignal(signal);
    const record = { attemptRoot, uid: BigInt(process.getuid()), signal,
        mountNamespace: fs.readlinkSync('/proc/self/ns/mnt'), files: [], closed: false,
        revoked: false, abort: null, cleanupFailure: null };
    try
    {
        for (const role of roles)
        {
            const file = canonical(path.join(attemptRoot, role.relative));
            const directories = openAncestors(file, attemptRoot, record.uid, signal);
            const retained = { file, role, directories, descriptor: undefined, bytes: null };
            record.files.push(retained);
            const access = `/proc/self/fd/${directories.at(-1).descriptor}/${path.basename(file)}`;
            retained.descriptor = fs.openSync(access, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            retained.identity = stat(retained.descriptor);
            requireLeaf(retained.identity, retained.descriptor, role.emptyAllowed, record.uid);
            retained.epochSha256 = originalFileEpochObservationSha256(observation(retained, retained.identity));
            recheck(retained, attemptRoot, record.uid, signal);
            retained.bytes = readBounded(retained, signal);
            recheck(retained, attemptRoot, record.uid, signal);
            retained.artifactSha256 = digest(retained.bytes);
        }
        validate(record, signal);
        const owner = Object.freeze({ validateUnchanged: () => validate(record, signal), dispose: () => dispose(record) });
        inputs.set(owner, record);
        record.abort = () =>
        {
            record.revoked = true;
            try { dispose(record); }
            catch (error) { record.cleanupFailure = error; }
        };
        signal?.addEventListener('abort', record.abort, { once: true });
        checkSignal(signal);
        return owner;
    }
    catch (error)
    {
        try { dispose(record); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'original input admission/cleanup failed'); }
        throw error;
    }
}

// No deserialization/import factory. JSON records and copied owners cannot pass.
// Returned descriptor numbers are borrowed locators; callers must never close
// them or use this inspection as an execution/issuer grant.
export function inspectOriginalCurrentSchemaCollectorInputs(owner)
{
    const record = inputs.get(owner);
    if (!record || record.closed || record.revoked) fail('actual open input custody required');
    validate(record, record.signal);
    return Object.freeze(record.files.map((file) => Object.freeze({ role: file.role.name,
        targetDescriptor: file.role.targetDescriptor, descriptor: file.descriptor, path: file.file,
        artifactSha256: file.artifactSha256, epochSha256: file.epochSha256 })));
}
