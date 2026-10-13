import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveExecutablePath } from './execution-envelope-environment.mjs';
import { retainExecutionFailureCompatibility } from './execution-failure-diagnostic.mjs';
import { validateRunBoundProjection } from './run-once.mjs';

const { hostDeclarations } = await import(new URL('../docs/behavior-doc-minimal-contract-build-v3-contract.mjs', import.meta.url));
const { resolveDotnetProjectSourceClosure, sealSourceIdentity } = await import(new URL('../fact-extractors/identity.mjs', import.meta.url));

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const { matrixNativeProjects } = await import(new URL('../testing/content-shape-catalog.mjs', import.meta.url));

function regular(file)
{
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== path.resolve(file))
    {
        throw new Error('NuGet preparation requires canonical regular, non-linked files');
    }
    return fs.readFileSync(file);
}

/** Inventory a finite sealed input; no aliases, special files or ambient cache are admitted. */
export function inventoryPreparedNuget(root, allocationBlockSize = 4096)
{
    const canonical = fs.realpathSync(root);
    if (canonical !== path.resolve(root))
    {
        throw new Error('NuGet seed root must be canonical');
    }
    const entries = [];
    const visit = (current) =>
    {
        for (const name of fs.readdirSync(current).sort())
        {
            const file = path.join(current, name);
            const stat = fs.lstatSync(file);
            if ((stat.mode & 0o222) !== 0 || stat.isSymbolicLink())
            {
                throw new Error('NuGet seed must be sealed read-only without symlinks');
            }
            const relative = path.relative(canonical, file).replaceAll(path.sep, '/');
            if (stat.isDirectory())
            {
                entries.push({ path: relative, kind: 'directory', mode: stat.mode & 0o777 });
                visit(file);
            }
            else
            {
                const bytes = regular(file);
                entries.push({ path: relative, kind: 'file', mode: stat.mode & 0o777,
                    size: stat.size, sha256: digest(bytes) });
            }
        }
    };
    if (!fs.statSync(canonical).isDirectory() || (fs.statSync(canonical).mode & 0o222) !== 0)
    {
        throw new Error('NuGet seed root must be a sealed directory');
    }
    visit(canonical);
    if (!entries.some((entry) => entry.kind === 'file'))
    {
        throw new Error('NuGet preparation cannot admit an empty cache');
    }
    if (!Number.isSafeInteger(allocationBlockSize) || allocationBlockSize <= 0)
    {
        throw new Error('NuGet target filesystem allocation unit is unknown');
    }
    const allocatedBytes = entries.reduce((sum, entry) =>
        sum + (entry.kind === 'file' ? (Math.ceil(entry.size / allocationBlockSize) + 1) * allocationBlockSize
            : allocationBlockSize), allocationBlockSize);
    if (!Number.isSafeInteger(allocatedBytes) || allocatedBytes <= 0)
    {
        throw new Error('NuGet preparation allocation bound is invalid');
    }
    return { root: canonical, entries, treeDigest: digest(JSON.stringify(entries)),
        allocatedBytes, allocationBlockSize };
}

export function behaviorDocNugetClosure(repositoryRoot)
{
    const projects = Object.values(hostDeclarations).map((value) => value.project).sort();
    return lockedNugetClosure(repositoryRoot, projects);
}

/** Bind the actual matrix semantic extractor and backend through their existing owner. */
export function matrixNativeNugetClosure(repositoryRoot)
{
    const projects = Object.values(matrixNativeProjects).sort();
    const solution = 'FsusBlog.MatrixNativeRestore.slnx';
    const text = regular(path.join(repositoryRoot, solution)).toString('utf8');
    const expected = '<Solution>\n' + projects.map((project) =>
        `    <Project Path="${path.posix.relative(path.posix.dirname(solution), project)}" />\n`).join('')
        + '</Solution>\n';
    if (text !== expected)
    {
        throw new Error('Matrix native restore solution differs from the actual project owners');
    }
    const closure = lockedNugetClosure(repositoryRoot, projects);
    for (const project of closure.sourceClosureDigests.filter((entry) => entry.path.endsWith('.csproj')))
    {
        const lock = path.posix.join(path.posix.dirname(project.path), 'packages.lock.json');
        if (!closure.sourceClosureDigests.some((entry) => entry.path === lock))
        {
            throw new Error('Matrix native preparation requires every referenced project lock');
        }
    }
    const bindings = [solution, 'ops/docker/FsusBlog.Server.Dockerfile', 'tools/testing/content-shape-catalog.mjs'];
    return { purpose: 'matrix-native', ...closure,
        sourceClosureDigests: [...closure.sourceClosureDigests,
            ...bindings.map((file) => ({ path: file, sha256: digest(regular(path.join(repositoryRoot, file))) }))]
            .sort((left, right) => left.path.localeCompare(right.path)) };
}

function lockedNugetClosure(repositoryRoot, projects)
{
    const closure = resolveDotnetProjectSourceClosure(repositoryRoot, projects);
    const sourceClosureDigests = closure.map((file) => ({
        path: file, sha256: digest(regular(path.join(repositoryRoot, file)))
    }));
    const packages = new Map();
    for (const file of closure.filter((value) => value.endsWith('/packages.lock.json')))
    {
        const lock = JSON.parse(regular(path.join(repositoryRoot, file)));
        for (const dependencies of Object.values(lock.dependencies ?? {}))
        {
            for (const [id, dependency] of Object.entries(dependencies))
            {
                if (dependency.type === 'Project')
                {
                    continue;
                }
                const version = dependency.resolved;
                if (!/^[A-Za-z0-9_.+-]+$/u.test(id) || !/^[A-Za-z0-9_.+-]+$/u.test(version ?? '')
                    || !/^[A-Za-z0-9+/]{86}==$/u.test(dependency.contentHash ?? ''))
                {
                    throw new Error('NuGet lock graph lacks an exact package identity');
                }
                const key = id.toLowerCase() + '/' + version.toLowerCase();
                const record = { path: key, contentHash: dependency.contentHash };
                if (packages.has(key) && !equal(packages.get(key), record))
                {
                    throw new Error('NuGet lock graph contains ambiguous package content');
                }
                packages.set(key, record);
            }
        }
    }
    if (packages.size === 0)
    {
        throw new Error('NuGet preparation requires a nonempty locked graph');
    }
    return { projects, sourceClosureDigests,
        packages: [...packages.values()].sort((left, right) => left.path.localeCompare(right.path)) };
}

/** Observe immutable SDK/compiler/runtime bytes without launching an SDK process. */
export function observeMatrixNativeNugetToolInputs(repositoryRoot)
{
    const dockerfile = regular(path.join(repositoryRoot, 'ops/docker/FsusBlog.Server.Dockerfile')).toString('utf8');
    const sdkVersion = dockerfile.match(/^ARG DOTNET_SDK_VERSION=([^\r\n]+)$/mu)?.[1];
    const runtimeVersion = dockerfile.match(/^ARG DOTNET_RUNTIME_VERSION=([^\r\n]+)$/mu)?.[1];
    if (![sdkVersion, runtimeVersion].every((value) => /^\d+\.\d+\.\d+$/u.test(value ?? '')))
    {
        throw new Error('Matrix native SDK/runtime pins are missing');
    }
    const executable = resolveExecutablePath('dotnet', { pathValue: process.env.PATH });
    const root = path.dirname(executable);
    if (fs.realpathSync(root) !== root || fs.realpathSync(executable) !== executable
        || process.env.DOTNET_ROOT !== root || process.env.FSUSBLOG_CONTENT_FIELD_DOTNET !== executable
        || !equal(fs.readdirSync(path.join(root, 'sdk')).sort(), [sdkVersion])
        || !equal(fs.readdirSync(path.join(root, 'shared/Microsoft.NETCore.App')).sort(), [runtimeVersion])
        || !equal(fs.readdirSync(path.join(root, 'shared/Microsoft.AspNetCore.App')).sort(), [runtimeVersion]))
    {
        throw new Error('Matrix native tool inputs differ from the single pinned SDK/runtime owner');
    }
    const required = [`sdk/${sdkVersion}/Roslyn/bincore/csc.dll`,
        `sdk/${sdkVersion}/Roslyn/bincore/Microsoft.CodeAnalysis.CSharp.dll`,
        `shared/Microsoft.NETCore.App/${runtimeVersion}/System.Private.CoreLib.dll`,
        `shared/Microsoft.AspNetCore.App/${runtimeVersion}/Microsoft.AspNetCore.dll`];
    for (const file of required)
    {
        regular(path.join(root, file));
    }
    const entries = [];
    const visit = (directory) =>
    {
        for (const name of fs.readdirSync(directory).sort())
        {
            const file = path.join(directory, name);
            const stat = fs.lstatSync(file);
            if (fs.realpathSync(file) !== file || stat.isSymbolicLink())
            {
                throw new Error('Matrix native SDK input has a physical alias');
            }
            const relative = path.relative(root, file).replaceAll(path.sep, '/');
            if (stat.isDirectory())
            {
                visit(file);
            }
            else
            {
                entries.push({ path: relative, sha256: digest(regular(file)) });
            }
        }
    };
    visit(root);
    return { root, executable, sdkVersion, runtimeVersion, entries, treeDigest: digest(JSON.stringify(entries)) };
}

/** One ordered restore command shared by the producer and strict ingress. */
export function nugetPreparationCommand({ purpose = 'behavior-doc', packagesRoot, artifactsRoot, feedRoot, configFile })
{
    if (!['behavior-doc', 'matrix-native'].includes(purpose))
    {
        throw new Error('Unknown NuGet preparation purpose');
    }
    return ['dotnet', 'restore', purpose === 'matrix-native'
        ? 'FsusBlog.MatrixNativeRestore.slnx' : 'tools/contracts/BehaviorDocRestore.slnx',
    '--locked-mode', '--packages', packagesRoot, '--artifacts-path', artifactsRoot,
    '/p:NuGetAudit=false', '/p:Configuration=Release', '--disable-parallel', '--source', feedRoot,
    '--configfile', configFile];
}

export function validatePreparedNugetPackages(seed, closure, feed)
{
    const expected = new Set(closure.packages.map((value) => value.path));
    const ids = new Set(closure.packages.map((value) => value.path.split('/')[0]));
    const actual = new Set(seed.entries.filter((value) =>
        value.kind === 'directory' && value.path.split('/').length === 2).map((value) => value.path));
    if (!equal([...actual].sort(), [...expected].sort())
        || seed.entries.some((value) => value.path.includes('/')
            ? !expected.has(value.path.split('/').slice(0, 2).join('/'))
            : value.kind !== 'directory' || !ids.has(value.path)))
    {
        throw new Error('NuGet seed package roster differs from the complete locked graph');
    }
    for (const record of closure.packages)
    {
        const [id, version] = record.path.split('/');
        const archive = path.join(seed.root, record.path, id + '.' + version + '.nupkg');
        const archiveBytes = regular(archive);
        const archiveHash = createHash('sha512').update(archiveBytes).digest('base64');
        const metadata = JSON.parse(regular(path.join(seed.root, record.path, '.nupkg.metadata')));
        const sha512 = regular(path.join(seed.root, record.path, id + '.' + version + '.nupkg.sha512'));
        // NuGet contentHash excludes package signatures; .sha512 seals the raw archive.
        // This metadata is consumed only after the real empty-cache locked restore.
        if (metadata.contentHash !== record.contentHash || sha512.toString('utf8').trim() !== archiveHash
            || (feed && feed.entries.find((entry) => entry.path === id + '.' + version + '.nupkg')?.sha256
                !== digest(archiveBytes)))
        {
            throw new Error('NuGet seed package content or raw archive binding differs from its completed restore');
        }
    }
}

/** Bind finite archive input and resource sizes; NuGet alone verifies locked content and extracts it. */
export function inventoryNugetOfflineFeed(root, closure, allocationBlockSize = 4096)
{
    const feed = inventoryPreparedNuget(root, allocationBlockSize);
    const expected = closure.packages.map((record) =>
    {
        const [id, version] = record.path.split('/');
        return { ...record, file: id + '.' + version + '.nupkg' };
    });
    if (!equal(feed.entries.map((entry) => entry.path).sort(), expected.map((record) => record.file).sort())
        || feed.entries.some((entry) => entry.kind !== 'file'))
    {
        throw new Error('Offline feed must contain only the complete finite locked archive roster');
    }
    let expandedAllocatedBytes = allocationBlockSize;
    for (const record of expected)
    {
        const bytes = regular(path.join(feed.root, record.file));
        if (!/^[A-Za-z0-9+/]{86}==$/u.test(record.contentHash ?? ''))
        {
            throw new Error('Offline feed requires an exact package lock content hash');
        }
        record.archiveSha512 = createHash('sha512').update(bytes).digest('base64');
        let footer = -1;
        for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--)
        {
            if (bytes.readUInt32LE(offset) === 0x06054b50
                && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length)
            {
                footer = offset;
                break;
            }
        }
        if (footer < 0 || bytes.readUInt16LE(footer + 4) || bytes.readUInt16LE(footer + 6)
            || bytes.readUInt16LE(footer + 8) !== bytes.readUInt16LE(footer + 10))
        {
            throw new Error('Offline feed has no bounded single-volume ZIP resource directory');
        }
        const count = bytes.readUInt16LE(footer + 10);
        const start = bytes.readUInt32LE(footer + 16);
        if (count === 0xffff || start + bytes.readUInt32LE(footer + 12) !== footer)
        {
            throw new Error('Offline feed ZIP64 resource sizes are unsupported');
        }
        let cursor = start;
        for (let index = 0; index < count; index++)
        {
            if (cursor + 46 > footer || bytes.readUInt32LE(cursor) !== 0x02014b50)
            {
                throw new Error('Offline feed ZIP resource directory is incomplete');
            }
            const size = bytes.readUInt32LE(cursor + 24);
            if (size === 0xffffffff)
            {
                throw new Error('Offline feed ZIP64 entry resource sizes are unsupported');
            }
            // Each file and each possible ancestor gets a full additional allocation block.
            const nameLength = bytes.readUInt16LE(cursor + 28);
            const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
            expandedAllocatedBytes += (Math.ceil(size / allocationBlockSize)
                + 2 + name.split('/').length) * allocationBlockSize;
            cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
            if (cursor > footer || !Number.isSafeInteger(expandedAllocatedBytes))
            {
                throw new Error('Offline feed expanded resource bound is invalid');
            }
        }
        if (cursor !== footer)
        {
            throw new Error('Offline feed ZIP resource directory is not fully consumed');
        }
    }
    // NuGet retains each archive, hash and metadata in addition to expanded entries.
    expandedAllocatedBytes += feed.allocatedBytes + expected.length * 4 * allocationBlockSize;
    if (!Number.isSafeInteger(expandedAllocatedBytes))
    {
        throw new Error('Offline feed expanded resource bound overflow');
    }
    return { ...feed, archives: expected, expandedAllocatedBytes };
}

export function behaviorDocNugetFeedConfiguration({ feedRoot, packagesRoot })
{
    const escape = (value) => String(value).replace(/&/gu, '&amp;').replace(/"/gu, '&quot;')
        .replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
    return '<?xml version="1.0" encoding="utf-8"?>\n<configuration>\n'
        + '  <packageSources><clear/><add key="sealed-offline-feed" value="' + escape(feedRoot) + '"/></packageSources>\n'
        + '  <fallbackPackageFolders><clear/></fallbackPackageFolders>\n'
        + '  <config><add key="globalPackagesFolder" value="' + escape(packagesRoot) + '"/></config>\n'
        + '</configuration>\n';
}

/** Validate a completed independent transfer using the existing run-bound authority. */
export async function readPreparedBehaviorDocNuget({ repositoryRoot, runId, file })
{
    return readPreparedNuget({ repositoryRoot, runId, file, purpose: 'behavior-doc' });
}

export async function readPreparedMatrixNativeNuget({ repositoryRoot, runId, file })
{
    return readPreparedNuget({ repositoryRoot, runId, file, purpose: 'matrix-native' });
}

async function readPreparedNuget({ repositoryRoot, runId, file, purpose })
{
    if (!file)
    {
        throw new Error(`${purpose} correctness requires explicit offline NuGet preparation`);
    }
    const input = path.resolve(file);
    const bytes = regular(input);
    const preparation = JSON.parse(bytes);
    const preparationOwner = path.join(path.resolve(repositoryRoot), '.tmp/behavior-doc-nuget-preparation');
    const attempt = path.dirname(path.resolve(preparation.root));
    if (!input.startsWith(preparationOwner + path.sep)
        || path.dirname(attempt) !== preparationOwner || !path.basename(attempt).startsWith('transfer-')
        || fs.realpathSync(attempt) !== attempt
        || preparation.root !== path.join(attempt, 'packages')
        || preparation.artifactsRoot !== path.join(attempt, 'artifacts')
        || preparation.feedRoot !== path.join(attempt, 'feed')
        || preparation.configFile !== path.join(attempt, 'NuGet.Config'))
    {
        throw new Error('NuGet preparation paths escape the exact task-owned transfer');
    }
    const source = sealSourceIdentity(repositoryRoot);
    const closure = purpose === 'matrix-native' ? matrixNativeNugetClosure(repositoryRoot) : behaviorDocNugetClosure(repositoryRoot);
    if (!equal(preparation.source, source) || !equal(preparation.closure, closure))
    {
        throw new Error('NuGet preparation source or locked graph drifted');
    }
    const transfer = preparation.transfer;
    const consumerId = purpose === 'matrix-native' ? 'matrix-native-nuget-transfer' : 'behavior-doc-nuget-transfer';
    if (transfer?.runId !== runId || transfer.consumerId !== consumerId
        || !new RegExp(`^${consumerId}-[a-f0-9-]{36}$`, 'u').test(transfer.key ?? '')
        || transfer.root !== path.join(path.resolve(repositoryRoot), '.tmp/physical-executions'))
    {
        throw new Error('NuGet transfer is foreign to this scheduler run or original producer');
    }
    const verified = await validateRunBoundProjection({ ...transfer, verifyOutputs: true });
    const receipt = verified.receipt;
    let allocationRoot = path.join(repositoryRoot, '.tmp/test-execution-envelope/run-owned');
    while (!fs.existsSync(allocationRoot))
    {
        const parent = path.dirname(allocationRoot);
        if (parent === allocationRoot)
        {
            throw new Error('NuGet attempt filesystem is unknown');
        }
        allocationRoot = parent;
    }
    const allocationBlockSize = Number(fs.statfsSync(allocationRoot).bsize);
    const seed = inventoryPreparedNuget(preparation.root, allocationBlockSize);
    const expectedCommand = nugetPreparationCommand({ purpose, packagesRoot: seed.root,
        artifactsRoot: preparation.artifactsRoot, feedRoot: preparation.feedRoot, configFile: preparation.configFile });
    const physical = receipt.physicalExecution;
    const feed = inventoryNugetOfflineFeed(preparation.feedRoot, closure);
    const toolchain = receipt.physicalExecution?.toolchain;
    const alias = physical?.executionAdmission?.ownedPrivateTmp;
    const filesystem = physical?.authority?.filesystemIsolation;
    const directoryFragment = physical?.executionEnvelopeFragments?.directories;
    const plannedAlias = physical?.executionEnvelopeFragments?.network?.sandbox?.filesystem?.ownedPrivateTmp;
    const executable = resolveExecutablePath('dotnet', { pathValue: process.env.PATH });
    if (receipt.receiptDigest !== transfer.receiptDigest || receipt.commit !== source.sourceCommit
        || receipt.worktreeFingerprint !== source.worktreeFingerprint
        || path.resolve(receipt.cwd) !== path.resolve(repositoryRoot)
        || !equal(receipt.command, expectedCommand)
        || !receipt.requiredOutputs.includes(seed.root)
        || !equal(receipt.outputContract, [...receipt.requiredOutputs].sort())
        || receipt.physicalExecution?.phase !== 'independent-dependency-transfer'
        || receipt.physicalExecution?.qualificationEligible !== false
        || physical?.schema !== 'fsusblog.physical-execution-process-tree.v1' || physical?.platform !== 'linux'
        || physical?.authority?.kind !== 'linux-cgroup-process-group' || physical.authority.established !== true
        || physical.postObservation !== 'zero-members' || physical.logComplete !== true
        || physical.logTruncationReason !== null || physical.forcedPipeClose !== false
        || !physical.lifecycle?.includes('bounded-pipe-close')
        || !physical.lifecycle?.includes('post-observe-zero-members')
        || physical.cleanup?.status !== 'verified' || !Array.isArray(physical.processInventory)
        || physical.executionAdmission?.phase !== 'pre-exec'
        || !alias || !plannedAlias || !equal(filesystem?.ownedPrivateTmp?.actual, alias)
        || alias.plan?.source !== directoryFragment?.directories?.temp
        || alias.plan?.ownedRoot !== directoryFragment?.ownedRoot
        || alias.plan?.runId !== runId || alias.plan?.destination !== '/tmp'
        || !equal(plannedAlias, Object.fromEntries(Object.entries(alias.plan).filter(([name]) =>
            !['hostMountNamespace', 'hostTmpDevice', 'hostTmpInode'].includes(name))))
        || filesystem?.privateTmp !== true || filesystem?.protectSystem !== 'strict'
        || filesystem?.protectHome !== 'read-only'
        || filesystem?.ownedPrivateTmp?.bindPaths !== `${alias.plan?.source}:/tmp`
        || alias.sourceDevice !== alias.plan?.device || alias.sourceInode !== alias.plan?.inode
        || alias.aliasDevice !== alias.sourceDevice || alias.aliasInode !== alias.sourceInode
        || alias.mountNamespace === alias.plan?.hostMountNamespace
        || alias.aliasMode !== 0o700 || alias.aliasUid !== alias.plan?.uid || !alias.mountInfo
        || !equal(physical.executionEnvelopeFragments?.environment?.actualExecutable, toolchain)
        || physical.processInventory.filter((entry) => entry.role === 'direct-child').length !== 1
        || physical.processInventory.some((entry) => entry.role === 'direct-child' && (entry.exitCode !== 0 || entry.signal))
        || physical.executionEnvelopeFragments?.network?.admission !== 'planned-actual-exact'
        || physical.executionEnvelopeFragments?.network?.planned?.endpoints?.length !== 0
        || physical.executionEnvelopeFragments?.environment?.admission !== 'planned-actual-exact'
        || physical.executionEnvelopeFragments?.directories?.cleanup?.removedOwnedRoot !== true
        || physical.offlineFeed?.root !== preparation.feedRoot || physical.offlineFeed?.treeDigest !== feed.treeDigest
        || !receipt.requiredOutputs.includes(preparation.feedRoot)
        || !receipt.requiredOutputs.includes(preparation.configFile)
        || regular(preparation.configFile).toString('utf8') !== behaviorDocNugetFeedConfiguration({
            feedRoot: preparation.feedRoot, packagesRoot: seed.root })
        || !equal(receipt.physicalExecution?.command, expectedCommand)
        || toolchain?.absolutePath !== executable || toolchain?.realPath !== fs.realpathSync(executable)
        || toolchain?.sha256 !== 'sha256:' + digest(fs.readFileSync(toolchain.realPath))
        || seed.treeDigest !== preparation.treeDigest)
    {
        throw new Error('NuGet transfer command, source, output or payload binding drifted');
    }
    if (purpose === 'matrix-native'
        && !equal(physical.matrixNativeToolInputs, observeMatrixNativeNugetToolInputs(repositoryRoot)))
    {
        throw new Error('Matrix native SDK/compiler/runtime input bytes drifted');
    }
    validatePreparedNugetPackages(seed, closure, feed);
    return { ...seed, file: input, preparation, closure,
        inputPaths: [input, verified.receiptFile, verified.projectionFile],
        bindingDigest: digest(Buffer.concat([bytes, verified.receiptBytes, verified.projectionBytes])) };
}

/** Copy only admitted payload into a newly created private cache, before its pre-inventory. */
export function seedPreparedNuget(prepared, destination)
{
    const before = inventoryPreparedNuget(prepared.root);
    if (before.treeDigest !== prepared.treeDigest || fs.readdirSync(destination).length !== 0
        || fs.realpathSync(destination) !== path.resolve(destination))
    {
        throw new Error('NuGet preparation drifted or destination is not a fresh canonical cache');
    }
    let firstFailure = null;
    let failed = false;
    let cleanupFailure = null;
    try
    {
        for (const entry of before.entries)
        {
            const target = path.join(destination, entry.path);
            if (entry.kind === 'directory')
            {
                fs.mkdirSync(target, { recursive: true, mode: 0o700 });
            }
            else
            {
                fs.writeFileSync(target, regular(path.join(before.root, entry.path)), { flag: 'wx', mode: 0o600 });
                fs.chmodSync(target, entry.mode);
            }
        }
        for (const entry of [...before.entries].reverse().filter((value) => value.kind === 'directory'))
        {
            fs.chmodSync(path.join(destination, entry.path), entry.mode);
        }
        // The attempt cache root itself retains the original required 0700 permission.
        const rootMode = fs.statSync(destination).mode & 0o777;
        fs.chmodSync(destination, 0o500);
        let after;
        try
        {
            after = inventoryPreparedNuget(destination);
        }
        finally
        {
            fs.chmodSync(destination, rootMode);
        }
        if (after.treeDigest !== before.treeDigest
            || inventoryPreparedNuget(prepared.root).treeDigest !== before.treeDigest)
        {
            throw new Error('NuGet preparation changed while copying into the current attempt');
        }
    }
    catch (error)
    {
        firstFailure = error;
        failed = true;
        throw error;
    }
    finally
    {
        // A partial copy must also remain removable. No child has started at this preparation boundary.
        for (const entry of [...before.entries].reverse())
        {
            const target = path.join(destination, entry.path);
            try
            {
                if (fs.existsSync(target) && fs.realpathSync(target) === target)
                {
                    fs.chmodSync(target, entry.kind === 'directory' ? 0o700 : 0o600);
                }
            }
            catch (error)
            {
                cleanupFailure ??= error;
            }
        }
        if (cleanupFailure)
        {
            if (failed)
            {
                retainExecutionFailureCompatibility(firstFailure, 'cleanupError', cleanupFailure);
            }
        }
    }
    if (cleanupFailure)
    {
        throw cleanupFailure;
    }
}
