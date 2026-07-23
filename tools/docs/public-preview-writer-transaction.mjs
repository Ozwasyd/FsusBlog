import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function stableJson(value)
{
    return `${JSON.stringify(value, null, 4)}\n`;
}

function assertOwner(owner)
{
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
        || typeof owner.namespace !== 'string' || !owner.namespace.trim()
        || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
    {
        throw new Error('docs writer lock owner must contain namespace and positive integer pid');
    }
}

export function acquireWriterLock(lockDirectory, owner, fileSystem = fs)
{
    assertOwner(owner);
    fileSystem.mkdirSync(path.dirname(lockDirectory), { recursive: true });
    try
    {
        fileSystem.mkdirSync(lockDirectory);
    }
    catch (error)
    {
        if (error?.code === 'EEXIST')
        {
            let current = 'unknown owner';
            try
            {
                const document = JSON.parse(fileSystem.readFileSync(path.join(lockDirectory, 'owner.json'), 'utf8'));
                current = `${document.namespace ?? 'unknown'} pid=${document.pid ?? 'unknown'}`;
            }
            catch
            {
                // A concurrently-created directory is already sufficient to fail closed.
            }
            throw new Error(`another docs writer owns ${lockDirectory}: ${current}`, { cause: error });
        }
        throw error;
    }

    try
    {
        fileSystem.writeFileSync(
            path.join(lockDirectory, 'owner.json'),
            stableJson({ namespace: owner.namespace, pid: owner.pid }),
            { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        );
    }
    catch (error)
    {
        fileSystem.rmSync(lockDirectory, { recursive: true, force: true });
        throw error;
    }
}

export function releaseWriterLock(lockDirectory, owner, fileSystem = fs)
{
    assertOwner(owner);
    const ownerFile = path.join(lockDirectory, 'owner.json');
    const current = JSON.parse(fileSystem.readFileSync(ownerFile, 'utf8'));
    if (current.namespace !== owner.namespace || current.pid !== owner.pid)
    {
        throw new Error(`refusing to release docs writer lock owned by ${current.namespace ?? 'unknown'} pid=${current.pid ?? 'unknown'}`);
    }
    fileSystem.rmSync(ownerFile);
    fileSystem.rmdirSync(lockDirectory);
}

function restoreOriginalDirectory({ backupDirectory, managedDirectory, stagingDirectory, fileSystem })
{
    if (fileSystem.existsSync(managedDirectory))
    {
        if (fileSystem.existsSync(stagingDirectory))
        {
            throw new Error('cannot restore docs gallery because the staging path was recreated during publication');
        }
        fileSystem.renameSync(managedDirectory, stagingDirectory);
    }
    if (fileSystem.existsSync(backupDirectory))
    {
        fileSystem.renameSync(backupDirectory, managedDirectory);
    }
}

export function atomicPublishDirectory({
    stagingDirectory,
    managedDirectory,
    validate,
    fileSystem = fs,
    transactionId = `${process.pid}`
})
{
    const staging = path.resolve(stagingDirectory);
    const managed = path.resolve(managedDirectory);
    if (staging === managed)
    {
        throw new Error('staging and managed screenshot directories must differ');
    }
    if (typeof validate !== 'function')
    {
        throw new Error('atomic docs publication requires a staging validator');
    }

    validate(staging);
    const managedParent = path.dirname(managed);
    const stagingParent = path.dirname(staging);
    if (fileSystem.statSync(managedParent).dev !== fileSystem.statSync(stagingParent).dev)
    {
        throw new Error('staging and managed screenshot directories must share one filesystem');
    }

    const backup = path.join(managedParent, `.screenshots-backup-${transactionId}`);
    if (fileSystem.existsSync(backup))
    {
        throw new Error(`docs screenshot backup already exists: ${backup}`);
    }

    fileSystem.renameSync(managed, backup);
    try
    {
        fileSystem.renameSync(staging, managed);
        validate(managed);
        fileSystem.rmSync(backup, { recursive: true, force: false });
    }
    catch (error)
    {
        try
        {
            restoreOriginalDirectory({
                backupDirectory: backup,
                managedDirectory: managed,
                stagingDirectory: staging,
                fileSystem
            });
        }
        catch (restoreError)
        {
            throw new AggregateError(
                [error, restoreError],
                'docs screenshot publication and rollback both failed',
                { cause: restoreError }
            );
        }
        throw error;
    }
}

function main()
{
    const command = process.argv[2];
    const lockDirectory = path.resolve(process.argv[3] ?? '');
    const owner = {
        namespace: process.argv[4] ?? '',
        pid: Number.parseInt(process.argv[5] ?? '', 10)
    };
    if (!['acquire-lock', 'release-lock'].includes(command) || !process.argv[3])
    {
        throw new Error('usage: public-preview-writer-transaction.mjs <acquire-lock|release-lock> <lock-dir> <namespace> <pid>');
    }
    if (command === 'acquire-lock')
    {
        acquireWriterLock(lockDirectory, owner);
        return;
    }
    releaseWriterLock(lockDirectory, owner);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main();
    }
    catch (error)
    {
        console.error(`[public-preview-writer] ${error.message}`);
        process.exitCode = 1;
    }
}
