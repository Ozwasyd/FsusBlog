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

/** Validate a completed independent transfer using the existing run-bound authority. */
export async function readPreparedBehaviorDocNuget({ repositoryRoot, runId, file })
{
    if (!file) throw new Error('BehaviorDoc correctness requires explicit offline NuGet preparation');
    const input = path.resolve(file);
    const bytes = regular(input);
    const preparation = JSON.parse(bytes);
    const source = sealSourceIdentity(repositoryRoot);
    const closure = behaviorDocNugetClosure(repositoryRoot);
    if (!equal(preparation.source, source) || !equal(preparation.closure, closure))
    {
        throw new Error('NuGet preparation source or locked graph drifted');
    }
    const transfer = preparation.transfer;
    if (transfer?.runId !== runId) throw new Error('NuGet transfer is foreign to this scheduler run');
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
        '/p:NuGetAudit=false', '/p:Configuration=Release', '--disable-parallel'];
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
        || receipt.physicalExecution?.exitCode !== 0 || receipt.physicalExecution?.signal
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
