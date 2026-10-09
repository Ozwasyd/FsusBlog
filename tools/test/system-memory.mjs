import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { locateInheritedCgroupV2Membership } from './linux-cgroup-membership-locator.mjs';

const bytesPerGiB = 1024 ** 3;
const cacheTtlMs = 1_000;
let darwinCache = null;

function linuxMemoryText(file, readText)
{
    try
    {
        return String(readText(file)).trim();
    }
    catch (error)
    {
        if (error.code === 'ENOENT')
        {
            return null;
        }
        throw new Error(`Linux cgroup memory cannot read ${file}`, { cause: error });
    }
}

function linuxMemoryPath(value)
{
    if (!value.startsWith('/') || value.includes('\0')
        || path.posix.normalize(value) !== value
        || value.split('/').some((part) => part === '.' || part === '..'))
    {
        throw new Error(`Linux cgroup memory invalid path: ${value}`);
    }
    return value;
}

function unifiedMemoryMembership(source)
{
    if (source === null)
    {
        return null;
    }
    const entries = source.split('\n').filter((line) => line.startsWith('0:'));
    if (entries.length === 0)
    {
        return null;
    }
    if (entries.length !== 1 || !entries[0].startsWith('0::'))
    {
        throw new Error('Linux cgroup memory ambiguous unified membership');
    }
    return linuxMemoryPath(entries[0].slice(3));
}

function memoryMountPath(value)
{
    if (/\\(?!040|011|012|134)/u.test(value))
    {
        throw new Error('Linux cgroup memory invalid mount path escape');
    }
    const decoded = value.replace(/\\(040|011|012|134)/gu,
        (_match, code) => String.fromCharCode(Number.parseInt(code, 8)));
    return linuxMemoryPath(decoded);
}

function linuxMemoryMount(source, membership, readText, locatorObservations)
{
    if (source === null)
    {
        throw new Error('Linux cgroup memory missing mountinfo for unified membership');
    }
    const mounts = source.split('\n').filter(Boolean).flatMap((line) =>
    {
        const fields = line.split(' ');
        const separator = fields.indexOf('-');
        if (separator < 0 && fields.includes('cgroup2'))
        {
            throw new Error('Linux cgroup memory invalid cgroup2 mountinfo');
        }
        if (fields[separator + 1] !== 'cgroup2')
        {
            return [];
        }
        if (separator < 6 || fields.length < separator + 4
            || !/^\d+:\d+$/u.test(fields[2]))
        {
            throw new Error('Linux cgroup memory invalid cgroup2 mountinfo');
        }
        const inheritedNamespaceRoot = fields[3] === '/..' && membership === '/';
        return [{ device: fields[2], root: inheritedNamespaceRoot ? fields[3] : memoryMountPath(fields[3]),
            mount: memoryMountPath(fields[4]), inheritedNamespaceRoot }];
    });
    if (mounts.length === 0)
    {
        return null;
    }
    if (new Set(mounts.map((mount) => mount.device)).size !== 1)
    {
        throw new Error('Linux cgroup memory ambiguous cgroup2 hierarchy');
    }
    if (mounts.some((mount) => mount.inheritedNamespaceRoot))
    {
        if (mounts.length !== 1)
        {
            throw new Error('Linux cgroup memory ambiguous inherited mount view');
        }
        const selected = mounts[0];
        return locateInheritedCgroupV2Membership({
            membership, mountRoot: selected.root, mountPath: selected.mount,
            readText, ...locatorObservations
        });
    }
    const candidates = mounts.flatMap((mount) =>
    {
        const rootRelative = path.posix.relative(mount.root, membership);
        const contained = rootRelative !== '..' && !rootRelative.startsWith('../');
        const relatives = new Set([membership.slice(1)]);
        if (contained)
        {
            relatives.add(rootRelative);
        }
        if (mount.root === '/')
        {
            return [{ ...mount, leaf: path.posix.join(mount.mount, rootRelative) }];
        }
        // A non-root view can use global or namespace-relative membership.
        // Directory existence alone cannot prove which view contains this process.
        const verified = [...relatives].filter((relative) =>
        {
            const leaf = path.posix.join(mount.mount, relative);
            const members = linuxMemoryText(path.posix.join(leaf, 'cgroup.procs'), readText);
            if (members === null)
            {
                return false;
            }
            const pids = members === '' ? [] : members.split(/\s+/u);
            if (pids.some((pid) => !/^[1-9]\d*$/u.test(pid)))
            {
                throw new Error('Linux cgroup memory invalid cgroup.procs membership');
            }
            return pids.includes(String(process.pid));
        });
        if (verified.length > 1)
        {
            throw new Error('Linux cgroup memory ambiguous namespace membership mapping');
        }
        return verified.map((relative) => ({
            ...mount, leaf: path.posix.join(mount.mount, relative)
        }));
    });
    const ordered = (candidates.length > 0 ? candidates : mounts).sort((left, right) =>
        left.root.split('/').filter(Boolean).length - right.root.split('/').filter(Boolean).length
        || left.mount.localeCompare(right.mount));
    const selected = ordered[0];
    if (candidates.length > 0 && candidates.some((mount) =>
    {
        const relative = path.posix.relative(selected.root, mount.root);
        return relative === '..' || relative.startsWith('../');
    }))
    {
        throw new Error('Linux cgroup memory ambiguous cgroup2 mount roots');
    }
    return {
        mount: selected.mount,
        leaf: selected.leaf ?? selected.mount,
        unmapped: candidates.length === 0
    };
}

function linuxMemoryInteger(value, file, allowUnlimited = false)
{
    if (allowUnlimited && value === 'max')
    {
        return null;
    }
    if (value === null || !/^\d+$/u.test(value))
    {
        throw new Error(`Linux cgroup memory invalid integer: ${file}`);
    }
    const integer = BigInt(value);
    if (integer > (1n << 64n) - 1n)
    {
        throw new Error(`Linux cgroup memory integer overflow: ${file}`);
    }
    return integer;
}

export function sampleLinuxCgroupV2HeadroomBytes({
    readText = (file) => readFileSync(file, 'utf8'),
    listChildren,
    observeDirectory
} = {})
{
    const membershipFile = '/proc/self/cgroup';
    const membership = unifiedMemoryMembership(linuxMemoryText(membershipFile, readText));
    if (membership === null)
    {
        return null;
    }
    const mapping = linuxMemoryMount(linuxMemoryText('/proc/self/mountinfo', readText), membership, readText,
        { listChildren, observeDirectory });
    if (mapping === null)
    {
        return null;
    }
    let directory = mapping.leaf;
    let headroom = null;
    let missingLeaf = false;
    while (true)
    {
        const maximumFile = path.posix.join(directory, 'memory.max');
        const currentFile = path.posix.join(directory, 'memory.current');
        const before = linuxMemoryText(maximumFile, readText);
        const current = linuxMemoryText(currentFile, readText);
        const after = linuxMemoryText(maximumFile, readText);
        if (mapping.requiredAncestors && (before === null || after === null || current === null))
        {
            throw new Error(`Linux cgroup memory unobservable required ancestor: ${directory}`);
        }
        if (before === null && after === null)
        {
            if (directory === mapping.leaf && current === null
                && linuxMemoryText(path.posix.join(directory, 'cgroup.procs'), readText) === null)
            {
                missingLeaf = true;
            }
        }
        else
        {
            if (before === null || after === null)
            {
                throw new Error(`Linux cgroup memory limit disappeared: ${maximumFile}`);
            }
            const limits = [before, after].map((value) => linuxMemoryInteger(value, maximumFile, true));
            const finite = limits.filter((value) => value !== null);
            if (finite.length > 0)
            {
                const maximum = finite.reduce((left, right) => left < right ? left : right);
                const usage = linuxMemoryInteger(current, currentFile);
                const remaining = maximum > usage ? maximum - usage : 0n;
                headroom = headroom === null || remaining < headroom ? remaining : headroom;
            }
        }
        if (directory === mapping.mount)
        {
            break;
        }
        directory = path.posix.dirname(directory);
    }
    if (unifiedMemoryMembership(linuxMemoryText(membershipFile, readText)) !== membership)
    {
        throw new Error('Linux cgroup memory membership changed during sampling');
    }
    if (missingLeaf || mapping.unmapped)
    {
        throw new Error(`Linux cgroup memory unmapped membership ${membership}; visible headroom=${headroom}`);
    }
    return headroom === null ? null : Number(headroom > BigInt(Number.MAX_SAFE_INTEGER)
        ? BigInt(Number.MAX_SAFE_INTEGER) : headroom);
}

export function parseDarwinMemoryPressureAvailableBytes(output, totalMemoryBytes)
{
    const total = Number(totalMemoryBytes);
    const match = String(output ?? '').match(/System-wide memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/u);
    const percentage = Number(match?.[1]);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(percentage)
        || percentage < 0 || percentage > 100)
    {
        return null;
    }
    return total * percentage / 100;
}

function sampleDarwinAvailableMemoryBytes(totalMemoryBytes)
{
    const result = spawnSync('/usr/bin/memory_pressure', ['-Q'], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 64 * 1024,
        windowsHide: true
    });
    if (result.status !== 0 || result.error)
    {
        return null;
    }
    return parseDarwinMemoryPressureAvailableBytes(result.stdout, totalMemoryBytes);
}

export function availableMemoryBytes({
    platform = process.platform,
    totalMemoryBytes = os.totalmem(),
    fallbackFreeMemoryBytes = os.freemem(),
    nowMs = Date.now(),
    darwinSampler = sampleDarwinAvailableMemoryBytes,
    linuxSampler = sampleLinuxCgroupV2HeadroomBytes
} = {})
{
    const fallback = Math.max(0, Number(fallbackFreeMemoryBytes) || 0);
    if (platform === 'linux')
    {
        const headroom = linuxSampler();
        if (headroom !== null && (!Number.isSafeInteger(headroom) || headroom < 0))
        {
            throw new Error('Linux cgroup memory sampler returned invalid headroom');
        }
        return headroom === null ? fallback : Math.min(fallback, headroom);
    }
    if (platform !== 'darwin')
    {
        return fallback;
    }
    const useCache = darwinSampler === sampleDarwinAvailableMemoryBytes;
    if (useCache && darwinCache && nowMs - darwinCache.observedAtMs < cacheTtlMs)
    {
        return darwinCache.availableBytes;
    }
    let sampled;
    try
    {
        sampled = darwinSampler(totalMemoryBytes);
    }
    catch
    {
        sampled = null;
    }
    const availableBytes = Number.isFinite(sampled) && sampled >= 0
        ? Math.max(fallback, Math.min(Number(totalMemoryBytes), sampled))
        : fallback;
    if (useCache)
    {
        darwinCache = { observedAtMs: nowMs, availableBytes };
    }
    return availableBytes;
}

export function availableMemoryGiB(options = {})
{
    return availableMemoryBytes(options) / bytesPerGiB;
}
