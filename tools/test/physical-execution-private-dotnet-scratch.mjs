import fs from 'node:fs';
import path from 'node:path';

export const privateDotnetScratchPath = '/tmp/.dotnet/shm';
const allowedProducers = new Set(['matrix-governance', 'validate-matrix']);
const bindingFields = [
    'attemptId', 'path', 'producerId', 'schedulerRunId', 'schema',
    'sourceCommit', 'sourceFingerprint', 'workingDirectory', 'worktreeFingerprint'
].sort();

export function admitsPrivateDotnetScratch({ producerId, attemptId, environment })
{
    return allowedProducers.has(producerId)
        && attemptId === 'matrix-governance'
        && path.isAbsolute(String(environment.FSUSBLOG_CONTENT_FIELD_DOTNET ?? ''));
}

export function verifyPrivateDotnetScratchBinding(binding, { environment, cwd, controlRoot })
{
    if (!binding || JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(bindingFields)
        || binding.schema !== 'fsusblog.private-dotnet-scratch.v1'
        || binding.path !== privateDotnetScratchPath
        || !admitsPrivateDotnetScratch({
            producerId: binding.producerId,
            attemptId: binding.attemptId,
            environment
        })
        || binding.schedulerRunId !== environment.FSUSBLOG_TEST_RUN_ID
        || binding.sourceCommit !== environment.FSUSBLOG_TEST_SOURCE_COMMIT
        || binding.sourceFingerprint !== environment.FSUSBLOG_TEST_SOURCE_FINGERPRINT
        || !/^sha256:[a-f0-9]{64}$/u.test(binding.worktreeFingerprint ?? '')
        || binding.workingDirectory !== fs.realpathSync(cwd)
        || fs.realpathSync(path.dirname(controlRoot))
            !== fs.realpathSync(environment.FSUSBLOG_TOOL_CACHE ?? '/nonexistent'))
    {
        throw new Error('private .NET scratch run/source/worktree/producer binding is invalid');
    }
}

export function tmpIdentity(file)
{
    const stat = fs.statSync(file);
    if (!stat.isDirectory())
    {
        throw new Error('PrivateTmp path is not a directory');
    }
    return { dev: stat.dev, ino: stat.ino };
}

export function verifyPrivateTmpNamespace({
    hostNamespace, unitNamespace, hostTmpIdentity, unitTmpIdentity, privateTmp
})
{
    if (privateTmp !== 'yes'
        || !/^mnt:\[\d+\]$/u.test(hostNamespace ?? '')
        || !/^mnt:\[\d+\]$/u.test(unitNamespace ?? '')
        || hostNamespace === unitNamespace
        || !Number.isInteger(hostTmpIdentity?.dev)
        || !Number.isInteger(hostTmpIdentity?.ino)
        || !Number.isInteger(unitTmpIdentity?.dev)
        || !Number.isInteger(unitTmpIdentity?.ino)
        || (hostTmpIdentity.dev === unitTmpIdentity.dev
            && hostTmpIdentity.ino === unitTmpIdentity.ino))
    {
        throw new Error('private .NET scratch requires a proven distinct PrivateTmp mount namespace');
    }
}

function exactDirectory(file, expected = null)
{
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)))
    {
        throw new Error(`private .NET scratch directory identity drift: ${file}`);
    }
    return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 };
}

export function preparePrivateDotnetScratch({
    tmpRoot = '/tmp', hostNamespace, unitNamespace, hostTmpIdentity, privateTmp
})
{
    const root = path.resolve(tmpRoot);
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    {
        throw new Error('private .NET scratch temporary root is not an exact directory');
    }
    verifyPrivateTmpNamespace({
        hostNamespace, unitNamespace, hostTmpIdentity,
        unitTmpIdentity: { dev: rootStat.dev, ino: rootStat.ino }, privateTmp
    });
    const dotnet = path.join(root, '.dotnet');
    const scratch = path.join(dotnet, 'shm');
    fs.mkdirSync(dotnet, { mode: 0o700 });
    try
    {
        fs.mkdirSync(scratch, { mode: 0o700 });
        return {
            tmpRoot: root,
            tmpIdentity: { dev: rootStat.dev, ino: rootStat.ino },
            dotnetIdentity: exactDirectory(dotnet),
            scratchIdentity: exactDirectory(scratch),
            mountNamespace: unitNamespace
        };
    }
    catch (error)
    {
        fs.rmdirSync(dotnet);
        throw error;
    }
}

export function finalizePrivateDotnetScratch(state, { unitNamespace })
{
    if (unitNamespace !== state.mountNamespace)
    {
        throw new Error('private .NET scratch mount namespace changed before cleanup');
    }
    const rootStat = fs.lstatSync(state.tmpRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
        || rootStat.dev !== state.tmpIdentity.dev || rootStat.ino !== state.tmpIdentity.ino)
    {
        throw new Error('private .NET scratch temporary root identity changed before cleanup');
    }
    const dotnet = path.join(state.tmpRoot, '.dotnet');
    const scratch = path.join(dotnet, 'shm');
    exactDirectory(dotnet, state.dotnetIdentity);
    exactDirectory(scratch, state.scratchIdentity);
    const observed = [];
    const visit = (directory, depth) =>
    {
        if (depth > 8)
        {
            throw new Error('private .NET scratch output inventory is out of bounds');
        }
        for (const name of fs.readdirSync(directory).sort())
        {
            if (observed.length >= 1024)
            {
                throw new Error('private .NET scratch output inventory is out of bounds');
            }
            const target = path.join(directory, name);
            const stat = fs.lstatSync(target);
            if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
            {
                throw new Error('private .NET scratch produced an unsupported path type');
            }
            observed.push({
                path: path.relative(scratch, target),
                kind: stat.isDirectory() ? 'directory' : 'file',
                size: stat.size,
                mode: stat.mode & 0o7777
            });
            if (stat.isDirectory())
            {
                visit(target, depth + 1);
            }
        }
    };
    visit(scratch, 0);
    fs.rmSync(dotnet, { recursive: true });
    if (fs.existsSync(dotnet))
    {
        throw new Error('private .NET scratch cleanup is unverifiable');
    }
    return {
        path: privateDotnetScratchPath,
        mountNamespace: unitNamespace,
        tmpIdentity: state.tmpIdentity,
        dotnetIdentity: state.dotnetIdentity,
        scratchIdentity: state.scratchIdentity,
        observed,
        cleanup: 'removed'
    };
}
