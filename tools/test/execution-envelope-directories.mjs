import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { seedPreparedNuget } from './behavior-doc-nuget-preparation.mjs';

export const executionEnvelopeDirectoriesSchema =
    'fsusblog.test-execution-envelope-directories.v1';

// Only this owner can mint an alias capability; serialized fragments are not capabilities.
const privateTmpCapabilities = new WeakMap();

export function inspectOwnedPrivateTmp(capability, { environment, readWritePaths } = {})
{
    const binding = privateTmpCapabilities.get(capability);
    if (!binding)
    {
        throw new Error('private /tmp alias requires the original current-attempt directory capability');
    }
    const metadata = fs.lstatSync(binding.source, { bigint: true });
    if (!metadata.isDirectory() || fs.realpathSync(binding.source) !== binding.source
        || String(metadata.dev) !== binding.device || String(metadata.ino) !== binding.inode
        || String(metadata.uid) !== binding.uid || Number(metadata.mode & 0o777n) !== 0o700
        || fs.realpathSync(binding.ownedRoot) !== binding.ownedRoot
        || fs.realpathSync(binding.toolCache) !== binding.toolCache
        || !isWithin(binding.ownedRoot, binding.toolCache)
        || !isWithin(binding.ownedRoot, binding.source)
        || (environment && (environment.FSUSBLOG_TOOL_CACHE !== binding.toolCache
            || environment.FSUSBLOG_TEST_RUN_ID !== binding.runId
            || environment.TMPDIR !== binding.source || environment.TMP !== binding.source
            || environment.TEMP !== binding.source))
        || (readWritePaths && !readWritePaths.includes(binding.source)))
    {
        throw new Error('private /tmp alias current-attempt directory identity drifted');
    }
    return { ...binding };
}

function sha256(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function safeSegment(value, fallback)
{
    const normalized = String(value ?? '')
        .trim()
        .replace(/[^A-Za-z0-9_.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
    return normalized && !['.', '..'].includes(normalized) ? normalized : fallback;
}

function isWithin(parent, child)
{
    return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function assertPhysicalContainment(parent, child, label)
{
    const realParent = fs.realpathSync(parent);
    const realChild = fs.realpathSync(child);
    if (!isWithin(realParent, realChild))
    {
        throw new Error(`${label} resolves outside its run-owned authority root`);
    }
    return realChild;
}

function createPrivateDirectory(directory)
{
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const mode = fs.statSync(directory).mode & 0o777;
    if (mode !== 0o700)
    {
        throw new Error(`run-owned directory permissions drifted: ${directory}`);
    }
}

function inventory(directory)
{
    const entries = [];
    const visit = (current) =>
    {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name)))
        {
            const absolute = path.join(current, entry.name);
            const relative = path.relative(directory, absolute).replaceAll(path.sep, '/');
            const stat = fs.lstatSync(absolute);
            if (entry.isSymbolicLink())
            {
                entries.push({
                    path: relative,
                    kind: 'symlink',
                    target: fs.readlinkSync(absolute)
                });
            }
            else if (entry.isDirectory())
            {
                entries.push({ path: relative, kind: 'directory', mode: stat.mode & 0o777 });
                visit(absolute);
            }
            else if (entry.isFile())
            {
                entries.push({
                    path: relative,
                    kind: 'file',
                    mode: stat.mode & 0o777,
                    size: stat.size,
                    sha256: sha256(fs.readFileSync(absolute))
                });
            }
            else
            {
                entries.push({ path: relative, kind: 'other' });
            }
        }
    };
    visit(directory);
    return entries;
}

function writableOutputRoots(cwd, outputs)
{
    const roots = new Set();
    for (const declaration of outputs)
    {
        const normalized = String(declaration).replaceAll('\\', '/');
        const wildcard = normalized.search(/[?*]/u);
        const prefix = normalized.slice(0, wildcard < 0 ? normalized.length : wildcard)
            .replace(/\/+$/u, '');
        const target = path.resolve(cwd, prefix || '.');
        if (!isWithin(cwd, target))
        {
            throw new Error(`correctness output declaration escapes the worktree: ${declaration}`);
        }
        const extension = path.extname(target);
        const writable = wildcard < 0 && extension ? path.dirname(target) : target;
        fs.mkdirSync(writable, { recursive: true });
        const real = fs.realpathSync(writable);
        if (!isWithin(fs.realpathSync(cwd), real))
        {
            throw new Error(`correctness output declaration resolves outside the worktree: ${declaration}`);
        }
        roots.add(real);
    }
    return [...roots].sort();
}

function inventoryRoots(roots)
{
    return roots.map((root) => ({
        root,
        entries: inventory(root)
    }));
}

export function prepareRunOwnedDirectories({
    repositoryRoot,
    cwd,
    runId,
    producerId,
    attemptId,
    outputs = [],
    preparedNuget = null,
    retainPrepared = null,
    authorityRoot = path.join(repositoryRoot, '.tmp/test-execution-envelope/run-owned')
})
{
    if (retainPrepared !== null && typeof retainPrepared !== 'function')
    {
        throw new Error('run-owned directory retention requires an in-process owner callback');
    }
    createPrivateDirectory(authorityRoot);
    const realAuthorityRoot = fs.realpathSync(authorityRoot);
    const realRepositoryRoot = fs.realpathSync(repositoryRoot);
    if (!isWithin(realRepositoryRoot, realAuthorityRoot))
    {
        throw new Error('run-owned authority root resolves outside its repository');
    }
    const ownedRoot = path.join(
        realAuthorityRoot,
        safeSegment(runId, 'run'),
        safeSegment(producerId, 'producer'),
        `${safeSegment(attemptId, 'attempt')}-${process.pid}-${randomUUID()}`
    );
    createPrivateDirectory(ownedRoot);
    let prepared = null;
    try
    {
        const directories = Object.fromEntries([
            ['home', 'home'],
            ['temp', 'tmp'],
            ['npmCache', 'npm-cache'],
            ['nugetPackages', 'nuget-packages'],
            ['dotnetHome', 'dotnet-home'],
            ['toolCache', 'tool-cache']
        ].map(([name, relative]) =>
        {
            const directory = path.join(ownedRoot, relative);
            createPrivateDirectory(directory);
            return [name, assertPhysicalContainment(realAuthorityRoot, directory, name)];
        }));
        const externalRoots = {
            userHome: os.homedir(),
            systemTemp: os.tmpdir(),
            sourceWorktree: fs.realpathSync(repositoryRoot)
        };
        const writableRoots = writableOutputRoots(fs.realpathSync(cwd), outputs);
        if (preparedNuget)
        {
            if (producerId !== 'behavior-doc-static-admission'
                && (!['matrix-governance', 'validate-matrix'].includes(producerId)
                    || preparedNuget.closure?.purpose !== 'matrix-native'))
            {
                throw new Error('Prepared NuGet ingress is limited to the declared BehaviorDoc producer');
            }
            seedPreparedNuget(preparedNuget, directories.nugetPackages);
        }
        const fragment = {
            schema: executionEnvelopeDirectoriesSchema,
            runId,
            producerId,
            attemptId,
            authorityRoot: realAuthorityRoot,
            ownedRoot: fs.realpathSync(ownedRoot),
            directories,
            writableRoots,
            externalRoots,
            ownership: 'current-run-current-attempt',
            permissions: '0700',
            aliasAdmission: 'realpath-contained',
            preInventory: inventory(ownedRoot),
            postInventory: null,
            externalWriteObservation: {
                enforcement: 'landlock-default-deny-write',
                deniedRoots: Object.values(externalRoots).sort(),
                allowedRoots: writableRoots,
                preAllowedRootInventory: inventoryRoots(writableRoots),
                postAllowedRootInventory: null
            },
            cleanup: { status: 'pending', removedOwnedRoot: false }
        };
        const privateTmpCapability = Object.freeze({});
        const tempMetadata = fs.lstatSync(directories.temp, { bigint: true });
        privateTmpCapabilities.set(privateTmpCapability, Object.freeze({
            source: directories.temp,
            destination: '/tmp',
            ownedRoot: fragment.ownedRoot,
            toolCache: directories.toolCache,
            runId,
            producerId,
            attemptId,
            device: String(tempMetadata.dev),
            inode: String(tempMetadata.ino),
            uid: String(tempMetadata.uid)
        }));
        prepared = {
            fragment,
            privateTmpCapability,
            environment: {
                HOME: directories.home,
                USERPROFILE: directories.home,
                TMPDIR: directories.temp,
                TEMP: directories.temp,
                TMP: directories.temp,
                NPM_CONFIG_CACHE: directories.npmCache,
                NUGET_PACKAGES: directories.nugetPackages,
                DOTNET_CLI_HOME: directories.dotnetHome,
                FSUSBLOG_TOOL_CACHE: directories.toolCache
            }
        };
        // Retain the actual object before later tool preparation can fail; never reconstruct a capability from wire facts.
        const retained = retainPrepared?.(prepared);
        if (retained && typeof retained.then === 'function')
        {
            throw new Error('run-owned directory retention must complete synchronously before preparation effects');
        }
        return prepared;
    }
    catch (error)
    {
        // Preparation can fail before a fragment exists; clean this attempt and retain its first cause.
        try
        {
            fs.rmSync(ownedRoot, { recursive: true, force: true });
            if (prepared)
            {
                const removedOwnedRoot = fs.lstatSync(ownedRoot, { throwIfNoEntry: false }) === undefined;
                prepared.fragment.cleanup = { status: removedOwnedRoot ? 'complete' : 'failed', removedOwnedRoot };
                if (!removedOwnedRoot)
                {
                    throw new Error('run-owned preparation cleanup did not prove directory absence', { cause: error });
                }
            }
        }
        catch (cleanupError)
        {
            if (prepared)
            {
                prepared.fragment.cleanup = { status: 'failed', removedOwnedRoot: false };
            }
            error.cleanupError = cleanupError;
        }
        throw error;
    }
}

/** No directory deletion is allowed while the original physical owner cannot verify terminal zero residue. */
export function finalizeRunOwnedDirectoriesAfterPhysical(prepared, { physicalStarted, physicalExecution })
{
    if (physicalStarted && physicalExecution?.postObservation !== 'zero-members')
    {
        const recoveryObligation = { ownedRoot: prepared.fragment.ownedRoot,
            reason: 'original physical owner has not verified a zero-member terminal' };
        prepared.fragment.cleanup = { status: 'retained-for-physical-recovery', removedOwnedRoot: false };
        throw Object.assign(new Error('Run-owned directories retained for unverifiable physical residue'), {
            recoveryObligation, physicalExecution
        });
    }
    return finalizeRunOwnedDirectories(prepared);
}

export function finalizeRunOwnedDirectories(prepared, {
    cleanup = true
} = {})
{
    const fragment = prepared.fragment;
    assertPhysicalContainment(fragment.authorityRoot, fragment.ownedRoot, 'ownedRoot');
    fragment.postInventory = inventory(fragment.ownedRoot);
    fragment.externalWriteObservation.postAllowedRootInventory = inventoryRoots(
        fragment.writableRoots
    );
    if (cleanup)
    {
        fs.rmSync(fragment.ownedRoot, { recursive: true, force: true });
        for (const emptyParent of [
            path.dirname(fragment.ownedRoot),
            path.dirname(path.dirname(fragment.ownedRoot))
        ])
        {
            try
            {
                fs.rmdirSync(emptyParent);
            }
            catch (error)
            {
                if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code))
                {
                    throw error;
                }
            }
        }
        fragment.cleanup = {
            status: fs.existsSync(fragment.ownedRoot) ? 'failed' : 'complete',
            removedOwnedRoot: !fs.existsSync(fragment.ownedRoot)
        };
    }
    if (fragment.cleanup.status !== 'complete')
    {
        throw new Error('run-owned directory cleanup is incomplete');
    }
    return fragment;
}
