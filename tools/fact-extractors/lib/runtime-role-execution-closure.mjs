import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Physical artifact reader only. It never builds, executes, or grants qualification.
function identity(stat)
{
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs]
        .map(String).join(':');
}

function contained(repositoryRoot, relative)
{
    if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\\')
        || relative.split('/').some((part) => !part || part === '.' || part === '..')
        || path.isAbsolute(relative) || /[\u0000-\u001f\u007f]/u.test(relative))
    {
        throw new Error('runtime-role execution closure requires canonical relative paths');
    }
    const root = path.resolve(repositoryRoot);
    if (fs.realpathSync(root) !== root)
    {
        throw new Error('runtime-role execution closure root is not canonical');
    }
    const ancestors = [[root, identity(fs.lstatSync(root, { bigint: true }))]];
    let current = root;
    for (const part of relative.split('/'))
    {
        current = path.join(current, part);
        const stat = fs.lstatSync(current, { bigint: true });
        if (stat.isSymbolicLink() || fs.realpathSync(current) !== current)
        {
            throw new Error('runtime-role execution closure contains a symbolic link');
        }
        ancestors.push([current, identity(stat)]);
    }
    return { absolute: current, ancestors };
}

function validateAncestors(ancestors)
{
    for (const [absolute, expected] of ancestors)
    {
        const stat = fs.lstatSync(absolute, { bigint: true });
        if (stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute
            || identity(stat) !== expected)
        {
            throw new Error('runtime-role execution closure changed during its physical read');
        }
    }
}

function capture(repositoryRoot, assemblyPath, readPhysicalFile)
{
    const directory = path.posix.dirname(assemblyPath);
    const closure = [];
    const identities = new Map();
    function visit(relativeDirectory)
    {
        const openedDirectory = contained(repositoryRoot, relativeDirectory);
        for (const [name, epoch] of openedDirectory.ancestors) identities.set(name, epoch);
        if (!fs.lstatSync(openedDirectory.absolute).isDirectory())
        {
            throw new Error('runtime-role execution closure directory is not regular');
        }
        for (const name of fs.readdirSync(openedDirectory.absolute).sort())
        {
            const relative = path.posix.join(relativeDirectory, name);
            const opened = contained(repositoryRoot, relative);
            for (const [name, epoch] of opened.ancestors) identities.set(name, epoch);
            const metadata = fs.lstatSync(opened.absolute, { bigint: true });
            if (metadata.isDirectory())
            {
                visit(relative);
                continue;
            }
            if (!metadata.isFile() || metadata.nlink !== 1n)
            {
                throw new Error('runtime-role execution closure member is not a regular single-link file');
            }
            const { bytes, stat } = readPhysicalFile(repositoryRoot, relative,
                'runtime-role execution closure member');
            if (!Buffer.isBuffer(bytes) || !stat?.isFile() || stat.nlink !== 1n
                || identity(stat) !== identity(metadata))
            {
                throw new Error('runtime-role execution closure reader returned a different file');
            }
            validateAncestors(opened.ancestors);
            closure.push({
                path: path.posix.relative(directory, relative),
                mode: Number(stat.mode & 0o777n),
                digest: createHash('sha256').update(bytes).digest('hex')
            });
        }
        validateAncestors(openedDirectory.ancestors);
    }
    visit(directory);
    return {
        closure: closure.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
        identities: [...identities.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    };
}

export function readRuntimeRoleExecutionClosure(repositoryRoot, assemblyPath, readPhysicalFile)
{
    if (typeof readPhysicalFile !== 'function')
    {
        throw new Error('runtime-role execution closure requires its independent physical file reader');
    }
    // Two complete reads also bind additions/removals between member reads.
    const first = capture(repositoryRoot, assemblyPath, readPhysicalFile);
    const second = capture(repositoryRoot, assemblyPath, readPhysicalFile);
    if (JSON.stringify(first) !== JSON.stringify(second))
    {
        throw new Error('runtime-role execution closure changed between physical reads');
    }
    return second.closure;
}
