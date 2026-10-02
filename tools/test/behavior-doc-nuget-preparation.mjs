import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hostDeclarations } from '../docs/behavior-doc-minimal-contract-build-v3-contract.mjs';
import { resolveDotnetProjectSourceClosure, sealSourceIdentity } from '../fact-extractors/identity.mjs';
import { validateRunBoundProjection } from './run-once.mjs';
import { resolveExecutablePath } from './execution-envelope-environment.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

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
                if (dependency.type === 'Project') continue;
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
    if (packages.size === 0) throw new Error('NuGet preparation requires a nonempty locked graph');
    return { projects, sourceClosureDigests,
        packages: [...packages.values()].sort((left, right) => left.path.localeCompare(right.path)) };
}

export function validatePreparedNugetPackages(seed, closure)
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
        if (createHash('sha512').update(regular(archive)).digest('base64') !== record.contentHash)
        {
            throw new Error('NuGet seed package content differs from its lock');
        }
        const metadata = regular(path.join(seed.root, record.path, '.nupkg.metadata'));
        const sha512 = regular(path.join(seed.root, record.path, id + '.' + version + '.nupkg.sha512'));
        if (!metadata.length || sha512.toString('utf8').trim() !== record.contentHash)
        {
            throw new Error('NuGet seed lacks complete extracted package metadata');
        }
    }
}

/** Read only the resource sizes of lock-approved ZIP entries; NuGet alone performs extraction. */
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
    { throw new Error('Offline feed must contain only the complete finite locked archive roster'); }
    let expandedAllocatedBytes = allocationBlockSize;
    for (const record of expected)
    {
        const bytes = regular(path.join(feed.root, record.file));
        if (createHash('sha512').update(bytes).digest('base64') !== record.contentHash)
        { throw new Error('Offline feed archive differs from the exact package lock'); }
        let footer = -1;
        for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--)
        {
            if (bytes.readUInt32LE(offset) === 0x06054b50
                && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length)
            { footer = offset; break; }
        }
        if (footer < 0 || bytes.readUInt16LE(footer + 4) || bytes.readUInt16LE(footer + 6)
            || bytes.readUInt16LE(footer + 8) !== bytes.readUInt16LE(footer + 10))
        { throw new Error('Offline feed has no bounded single-volume ZIP resource directory'); }
        const count = bytes.readUInt16LE(footer + 10);
        const start = bytes.readUInt32LE(footer + 16);
        if (count === 0xffff || start + bytes.readUInt32LE(footer + 12) !== footer)
        { throw new Error('Offline feed ZIP64 resource sizes are unsupported'); }
        let cursor = start;
        for (let index = 0; index < count; index++)
        {
            if (cursor + 46 > footer || bytes.readUInt32LE(cursor) !== 0x02014b50)
            { throw new Error('Offline feed ZIP resource directory is incomplete'); }
            const size = bytes.readUInt32LE(cursor + 24);
            if (size === 0xffffffff) throw new Error('Offline feed ZIP64 entry resource sizes are unsupported');
            // Each file and each possible ancestor gets a full additional allocation block.
            const nameLength = bytes.readUInt16LE(cursor + 28);
            const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
            expandedAllocatedBytes += (Math.ceil(size / allocationBlockSize)
                + 2 + name.split('/').length) * allocationBlockSize;
            cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
            if (cursor > footer || !Number.isSafeInteger(expandedAllocatedBytes))
            { throw new Error('Offline feed expanded resource bound is invalid'); }
        }
        if (cursor !== footer) throw new Error('Offline feed ZIP resource directory is not fully consumed');
    }
    // NuGet retains each archive, hash and metadata in addition to expanded entries.
    expandedAllocatedBytes += feed.allocatedBytes + expected.length * 4 * allocationBlockSize;
    if (!Number.isSafeInteger(expandedAllocatedBytes)) throw new Error('Offline feed expanded resource bound overflow');
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
    if (!file) throw new Error('BehaviorDoc correctness requires explicit offline NuGet preparation');
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
    { throw new Error('NuGet preparation paths escape the exact task-owned transfer'); }
    const source = sealSourceIdentity(repositoryRoot);
    const closure = behaviorDocNugetClosure(repositoryRoot);
    if (!equal(preparation.source, source) || !equal(preparation.closure, closure))
    {
        throw new Error('NuGet preparation source or locked graph drifted');
    }
    const transfer = preparation.transfer;
    if (transfer?.runId !== runId || transfer.consumerId !== 'behavior-doc-nuget-transfer'
        || !/^behavior-doc-nuget-transfer-[a-f0-9-]{36}$/u.test(transfer.key ?? '')
        || transfer.root !== path.join(path.resolve(repositoryRoot), '.tmp/physical-executions'))
    { throw new Error('NuGet transfer is foreign to this scheduler run or original producer'); }
    const verified = await validateRunBoundProjection({ ...transfer, verifyOutputs: true });
    const receipt = verified.receipt;
    let allocationRoot = path.join(repositoryRoot, '.tmp/test-execution-envelope/run-owned');
    while (!fs.existsSync(allocationRoot))
    {
        const parent = path.dirname(allocationRoot);
        if (parent === allocationRoot) throw new Error('NuGet attempt filesystem is unknown');
        allocationRoot = parent;
    }
    const allocationBlockSize = Number(fs.statfsSync(allocationRoot).bsize);
    const seed = inventoryPreparedNuget(preparation.root, allocationBlockSize);
    const expectedCommand = ['dotnet', 'restore', 'tools/contracts/BehaviorDocRestore.slnx',
        '--locked-mode', '--packages', seed.root, '--artifacts-path', preparation.artifactsRoot,
        '/p:NuGetAudit=false', '/p:Configuration=Release', '--disable-parallel', '--source', preparation.feedRoot,
        '--configfile', preparation.configFile];
    const physical = receipt.physicalExecution;
    const feed = inventoryNugetOfflineFeed(preparation.feedRoot, closure);
    const toolchain = receipt.physicalExecution?.toolchain;
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
    validatePreparedNugetPackages(seed, closure);
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
        try { after = inventoryPreparedNuget(destination); }
        finally { fs.chmodSync(destination, rootMode); }
        if (after.treeDigest !== before.treeDigest
            || inventoryPreparedNuget(prepared.root).treeDigest !== before.treeDigest)
        {
            throw new Error('NuGet preparation changed while copying into the current attempt');
        }
    }
    catch (error)
    {
        firstFailure = error;
        throw error;
    }
    finally
    {
        // A partial copy must also remain removable. No child has started at this preparation boundary.
        let cleanupFailure = null;
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
            catch (error) { cleanupFailure ??= error; }
        }
        if (cleanupFailure)
        {
            if (firstFailure) firstFailure.cleanupError = cleanupFailure;
            else throw cleanupFailure;
        }
    }
}
