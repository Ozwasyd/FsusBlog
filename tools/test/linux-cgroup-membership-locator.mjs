import { lstatSync, opendirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const maximumEntries = 256;
const maximumChildren = 64;

function listCgroupChildren(directory)
{
    const handle = opendirSync(directory);
    const children = [];
    try
    {
        for (let index = 0; index <= maximumEntries; index += 1)
        {
            const entry = handle.readSync();
            if (entry === null)
            {
                return children;
            }
            if (index === maximumEntries || entry.isSymbolicLink())
            {
                throw new Error('Linux cgroup locator incomplete or linked directory view');
            }
            if (entry.isDirectory())
            {
                children.push(entry.name);
                if (children.length > maximumChildren)
                {
                    throw new Error('Linux cgroup locator direct-child bound exceeded');
                }
            }
        }
    }
    finally
    {
        handle.closeSync();
    }
}

function observeCgroupDirectory(directory)
{
    const stat = lstatSync(directory);
    return {
        directory: stat.isDirectory() && !stat.isSymbolicLink(),
        canonicalPath: realpathSync(directory),
        device: stat.dev
    };
}

function requiredText(file, readText)
{
    try
    {
        return String(readText(file)).trim();
    }
    catch (error)
    {
        throw new Error(`Linux cgroup locator cannot read ${file}`, { cause: error });
    }
}

/**
 * Locate only self membership '/' under an inherited mount marked '/..'.
 * Observations are read-only and bounded; the result is location information,
 * not a memory measurement, ancestor attestation or runtime qualification.
 * I/O adapters support controlled unit fixtures and confer no authority.
 */
export function locateInheritedCgroupV2Membership({
    membership,
    mountRoot,
    mountPath,
    readText = (file) => readFileSync(file, 'utf8'),
    listChildren = listCgroupChildren,
    observeDirectory = observeCgroupDirectory
})
{
    if (membership !== '/' || mountRoot !== '/..')
    {
        throw new Error('Linux cgroup locator unsupported namespace shape');
    }
    if (typeof mountPath !== 'string' || !mountPath.startsWith('/')
        || mountPath.includes('\0') || path.posix.normalize(mountPath) !== mountPath
        || mountPath.split('/').some((part) => part === '.' || part === '..'))
    {
        throw new Error('Linux cgroup locator invalid mount path');
    }
    const root = observeDirectory(mountPath);
    if (!root.directory || root.canonicalPath !== mountPath || !Number.isSafeInteger(root.device)
        || requiredText(path.posix.join(mountPath, 'cgroup.type'), readText) !== 'domain')
    {
        throw new Error('Linux cgroup locator unobservable required ancestor');
    }
    const children = listChildren(mountPath);
    if (!Array.isArray(children) || children.length > maximumChildren
        || new Set(children).size !== children.length)
    {
        throw new Error('Linux cgroup locator incomplete or ambiguous child view');
    }
    const matches = [];
    for (const name of children)
    {
        if (typeof name !== 'string' || name === '' || name === '.' || name === '..'
            || name.includes('/') || name.includes('\0'))
        {
            throw new Error('Linux cgroup locator invalid child component');
        }
        const child = path.posix.join(mountPath, name);
        const observed = observeDirectory(child);
        if (path.posix.dirname(child) !== mountPath || !observed.directory
            || observed.canonicalPath !== child || observed.device !== root.device)
        {
            throw new Error('Linux cgroup locator child is not contained in the visible hierarchy');
        }
        if (requiredText(path.posix.join(child, 'cgroup.type'), readText) !== 'domain')
        {
            throw new Error('Linux cgroup locator unsupported child cgroup type');
        }
        const members = requiredText(path.posix.join(child, 'cgroup.procs'), readText);
        const pids = members === '' ? [] : members.split(/\s+/u);
        if (pids.some((pid) => !/^[1-9]\d*$/u.test(pid)))
        {
            throw new Error('Linux cgroup locator invalid process membership');
        }
        if (pids.includes(String(process.pid)))
        {
            matches.push(child);
        }
    }
    if (matches.length !== 1)
    {
        throw new Error('Linux cgroup locator missing or ambiguous self membership');
    }
    return { mount: mountPath, leaf: matches[0], unmapped: false, requiredAncestors: true };
}
