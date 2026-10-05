/**
 * Atomic private receipt I/O: 0600, no-follow, content digest integrity (#1710).
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertDigest, canonicalJson, sha256Bytes, sha256Text } from './canonical.mjs';

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function resolveTarget(file)
{
    if (!file || typeof file !== 'string')
    {
        throw new Error('receipt path is required');
    }
    return path.resolve(file);
}

/**
 * Read a private regular non-symlink file. Fails closed on symlink / non-file.
 */
export function readPrivateFile(file, { expectedModeMask = 0o077, label = 'receipt', maximumBytes = null } = {})
{
    if (maximumBytes !== null && (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0))
    {
        throw new Error(`${label} byte ceiling must be a positive safe integer`);
    }
    const target = resolveTarget(file);
    let lstat;
    try
    {
        lstat = fs.lstatSync(target);
    }
    catch (error)
    {
        throw new Error(`${label} is unreadable: ${error.message}`, { cause: error });
    }
    if (lstat.isSymbolicLink())
    {
        throw new Error(`${label} must not be a symlink`);
    }
    if (!lstat.isFile())
    {
        throw new Error(`${label} must be a regular file`);
    }
    // Reject world/group readable when mode bits are present (unix).
    if (process.platform !== 'win32' && (lstat.mode & expectedModeMask) !== 0)
    {
        throw new Error(`${label} must be private (mode 0600); got ${ (lstat.mode & 0o777).toString(8) }`);
    }

    // The opt-in publication reader must reject unbounded or aliased data before allocation.
    const same = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
        && left.nlink === right.nlink && left.mode === right.mode;
    const bounded = (stat) => stat.isFile() && stat.nlink === 1 && stat.size > 0
        && stat.size <= maximumBytes && (process.platform === 'win32' || (stat.mode & 0o777) === 0o600);
    if (maximumBytes !== null && !bounded(lstat))
    {
        throw new Error(`${label} must be bounded private single-link data`);
    }

    const fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW
        | (maximumBytes === null ? 0 : fs.constants.O_NONBLOCK));
    try
    {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile())
        {
            throw new Error(`${label} must be a regular file`);
        }
        if (maximumBytes !== null && (!bounded(stat) || !same(lstat, stat)))
        {
            throw new Error(`${label} inode changed before bounded read`);
        }
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length)
        {
            const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (read <= 0)
            {
                if (maximumBytes !== null)
                {
                    throw new Error(`${label} was truncated during bounded read`);
                }
                break;
            }
            offset += read;
        }
        if (maximumBytes !== null && (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0
            || !same(stat, fs.fstatSync(fd)) || !same(stat, fs.lstatSync(target))))
        {
            throw new Error(`${label} changed during bounded read`);
        }
        return { bytes: bytes.subarray(0, offset), path: target, mode: stat.mode & 0o777 };
    }
    finally
    {
        fs.closeSync(fd);
    }
}

export function readPrivateJson(file, options = {})
{
    const { bytes, path: target, mode } = readPrivateFile(file, options);
    let document;
    try
    {
        document = JSON.parse(bytes.toString('utf8'));
    }
    catch (error)
    {
        throw new Error(`${options.label ?? 'receipt'} is not valid JSON: ${error.message}`, { cause: error });
    }
    return { document, bytes, path: target, mode, contentDigest: sha256Bytes(bytes) };
}

/**
 * Atomic write: temp file 0600 exclusive, rename, re-open no-follow, verify bytes digest.
 * Does not follow existing symlink at destination (rename overwrites path; pre-check fails if target is symlink).
 * overwrite:false publishes the complete temporary inode by exclusive link; an existing target is never replaced.
 */
export function writePrivateJson(file, document, {
    mode = 0o600,
    label = 'receipt',
    expectedContentDigest = null,
    overwrite = true
} = {})
{
    if (typeof overwrite !== 'boolean')
    {
        throw new Error(`${label} overwrite option must be boolean`);
    }
    const target = resolveTarget(file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    try
    {
        fs.chmodSync(path.dirname(target), 0o700);
    }
    catch
    { /* best-effort */ }

    if (fs.existsSync(target))
    {
        const existing = fs.lstatSync(target);
        if (existing.isSymbolicLink())
        {
            throw new Error(`${label} target must not be a symlink`);
        }
    }

    const payload = Buffer.from(`${typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`}`, 'utf8');
    const contentDigest = sha256Bytes(payload);
    if (expectedContentDigest != null)
    {
        assertDigest(expectedContentDigest, 'expectedContentDigest');
        if (expectedContentDigest !== contentDigest)
        {
            throw new Error(`${label} content digest mismatch before write`);
        }
    }

    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try
    {
        fs.writeFileSync(temporary, payload, { flag: 'wx', mode });
        try
        {
            fs.chmodSync(temporary, mode);
        }
        catch
        { /* best-effort */ }
        // Refuse to rename onto a symlink race.
        if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
        {
            throw new Error(`${label} target became a symlink; refusing write`);
        }
        if (overwrite)
        {
            fs.renameSync(temporary, target);
        }
        else
        {
            // Same-directory link is atomic no-replace publication, not a check-then-rename.
            fs.linkSync(temporary, target);
        }
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }

    // Integrity: re-open no-follow and compare bytes.
    const verified = readPrivateFile(target, { label });
    if (sha256Bytes(verified.bytes) !== contentDigest)
    {
        throw new Error(`${label} integrity check failed after atomic write`);
    }
    return { path: target, contentDigest, mode: verified.mode };
}

export function fileContentDigest(file, options = {})
{
    const { bytes } = readPrivateFile(file, options);
    return sha256Bytes(bytes);
}

/** Pretty JSON digest of a value (for tests / non-file artifacts). */
export function jsonContentDigest(value)
{
    return sha256Text(`${JSON.stringify(value, null, 2)}\n`);
}

export function canonicalContentDigest(value)
{
    return sha256Text(canonicalJson(value));
}
