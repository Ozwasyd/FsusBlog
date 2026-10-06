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

export function nugetPreparationDeclaration(purpose = 'behavior-doc')
{
    if (purpose === 'behavior-doc') return Object.freeze({ purpose,
        consumers: ['behavior-doc-static-admission'], owner: 'behavior-doc-nuget-preparation',
        solution: 'tools/contracts/BehaviorDocRestore.slnx', transfer: 'behavior-doc-nuget-transfer' });
    if (purpose === 'matrix-governance') return Object.freeze({ purpose,
        consumers: ['matrix-governance', 'validate-matrix'], owner: 'matrix-nuget-preparation',
        solution: 'tools/contracts/MatrixNugetRestore.slnx', transfer: 'matrix-nuget-transfer' });
    throw new Error('NuGet preparation purpose is not declared');
}

export function nugetPreparationPurpose(producerId)
{
    if (producerId === 'behavior-doc-static-admission') return 'behavior-doc';
    if (['matrix-governance', 'validate-matrix'].includes(producerId)) return 'matrix-governance';
    throw new Error('Prepared NuGet ingress is not declared for this producer');
}

/** Fixed source declaration; no caller-selected project graph is admitted. */
export function nugetPreparationClosure(repositoryRoot, purpose = 'behavior-doc')
{
    const declaration = nugetPreparationDeclaration(purpose);
    const projects = purpose === 'behavior-doc'
        ? Object.values(hostDeclarations).map((value) => value.project).sort()
        : ['src/backend/FsusBlog.Server.csproj',
            'tools/testing/FsusBlog.ContentFieldContractExtractor/FsusBlog.ContentFieldContractExtractor.csproj'];
    const solutionDirectory = path.dirname(declaration.solution);
    const expectedSolution = '<Solution>\n' + projects.map((project) =>
        '    <Project Path="' + path.relative(solutionDirectory, project).replaceAll(path.sep, '/') + '" />\n').join('')
        + '</Solution>\n';
    if (regular(path.join(repositoryRoot, declaration.solution)).toString('utf8') !== expectedSolution)
        throw new Error('NuGet restore solution differs from its fixed project declaration');
    const closure = [...new Set([...resolveDotnetProjectSourceClosure(repositoryRoot, projects),
        ...(purpose === 'matrix-governance' ? [declaration.solution,
            'tools/docs/prepare-behavior-doc-nuget.mjs', 'tools/test/behavior-doc-nuget-preparation.mjs',
            'ops/docker/FsusBlog.Server.Dockerfile',
            'tools/testing/FsusBlog.ContentFieldContractExtractor/Inject.targets'] : [])])].sort();
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

export function behaviorDocNugetClosure(repositoryRoot)
{
    return nugetPreparationClosure(repositoryRoot, 'behavior-doc');
}

/** Observe actual SDK bytes without executing the SDK; executable version is checked by the original envelope. */
export function observeNugetPreparationToolchain(repositoryRoot, purpose = 'behavior-doc')
{
    if (purpose === 'behavior-doc') return null;
    nugetPreparationDeclaration(purpose);
    return observePinnedNugetToolchain(repositoryRoot, process.env.FSUSBLOG_CONTENT_FIELD_DOTNET);
}

/** SDK byte observation is an input fact, independent of package-transfer producer identity. */
export function observePinnedNugetToolchain(repositoryRoot, executable)
{
    if (!executable || !path.isAbsolute(executable) || fs.realpathSync(executable) !== executable)
        throw new Error('NuGet preparation requires a canonical absolute SDK selector');
    const pin = regular(path.join(repositoryRoot, 'ops/docker/FsusBlog.Server.Dockerfile')).toString('utf8');
    const sdkVersion = pin.match(/^ARG DOTNET_SDK_VERSION=([^\r\n]+)$/mu)?.[1];
    const runtimeVersion = pin.match(/^ARG DOTNET_RUNTIME_VERSION=([^\r\n]+)$/mu)?.[1];
    if (![sdkVersion, runtimeVersion].every((value) => /^\d+\.\d+\.\d+$/u.test(value ?? '')))
        throw new Error('Matrix NuGet preparation has no exact SDK/runtime pin');
    const root = path.dirname(executable);
    const files = [];
    const visit = (relative) =>
    {
        const absolute = path.join(root, relative);
        const stat = fs.lstatSync(absolute);
        if (stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(absolute) === absolute)
        {
            for (const name of fs.readdirSync(absolute).sort()) visit(path.posix.join(relative, name));
        }
        else files.push({ path: relative, sha256: digest(regular(absolute)) });
    };
    visit(path.basename(executable));
    const sdkVersionRoster = fs.readdirSync(path.join(root, 'sdk')).sort().map((name) =>
    {
        const directory = path.join(root, 'sdk', name);
        if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory)
            throw new Error('Installed SDK selection roster contains an alias or non-directory');
        return name;
    });
    // Host/runtime resolution can select a newer installation; bind that complete selection set.
    // Reference packs are real compiler inputs even when the SDK and compiler executable stay unchanged.
    for (const relative of [`sdk/${sdkVersion}`, 'host/fxr', 'shared', 'packs']) visit(relative);
    const workloadInputRoster = ['sdk-manifests', 'metadata', 'workloads'].map((relative) =>
    {
        const present = fs.existsSync(path.join(root, relative));
        if (present) visit(relative);
        return { path: relative, present };
    });
    for (const required of [`sdk/${sdkVersion}/MSBuild.dll`, `sdk/${sdkVersion}/Roslyn/bincore/csc.dll`,
        `host/fxr/${runtimeVersion}/libhostfxr.so`, `shared/Microsoft.NETCore.App/${runtimeVersion}/libcoreclr.so`,
        `shared/Microsoft.NETCore.App/${runtimeVersion}/System.Private.CoreLib.dll`])
        if (!files.some((file) => file.path === required)) throw new Error('Matrix SDK byte closure is incomplete');
    return { executable, sdkVersion, runtimeVersion, sdkVersionRoster, workloadInputRoster, files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

/** Only an actual sealed parent transfer may carry the additional BD SDK input closure. */
export function observePreparedNugetParentSdk(repositoryRoot, preparation)
{
    if (!preparation.parentSdk) return null;
    if (preparation.purpose !== 'behavior-doc') throw new Error('Parent SDK augmentation requires its original BehaviorDoc purpose');
    const sdk = observePinnedNugetToolchain(repositoryRoot, preparation.parentSdk.executable);
    const executable = resolveExecutablePath('dotnet', { pathValue: process.env.PATH });
    if (!equal(sdk, preparation.parentSdk) || executable !== sdk.executable)
        throw new Error('Prepared BehaviorDoc parent SDK bytes, roster or current dotnet selector drifted');
    return sdk;
}

/** Join additional SDK facts to the original physical transfer; this check grants no authority. */
export function assertPreparedNugetParentSdkPhysical(physical, parentSdk)
{
    const toolchain = physical?.toolchain;
    if (!equal(physical?.parentSdk ?? null, parentSdk)
        || (parentSdk && (toolchain?.absolutePath !== parentSdk.executable || toolchain?.version !== parentSdk.sdkVersion)))
        throw new Error('NuGet parent SDK lacks its exact original physical transfer binding');
}

/** Read the original live channel; the broker authenticates and enforces every actual nested execution. */
export async function requireNugetResourceChannel({ root, runId, sourceState, expectedReference = null })
{
    const { inspectNestedExecutionChannelCarrier, nestedExecutionChannelKey } = await import('./physical-execution-nested-channel.mjs');
    const { readProductionSystemdResourceBoundaryBinding } = await import('../test-matrix/production-systemd-resource-boundary.mjs');
    const value = process.env[nestedExecutionChannelKey];
    if (!value) throw new Error('NuGet execution requires the original resource-owner nested channel');
    const channel = JSON.parse(value);
    const observed = inspectNestedExecutionChannelCarrier(channel);
    const context = channel.reference?.context;
    if (observed.status !== 'retained' || !observed.socket || observed.brokerGone
        || context?.root !== root || context.runId !== runId || !equal(context.sourceState, sourceState)
        || (expectedReference && !equal(channel.reference, expectedReference)))
        throw new Error('NuGet resource channel is foreign, stale or unbound to current source/run');
    readProductionSystemdResourceBoundaryBinding(context, { reference: channel.reference });
    return channel.reference;
}

async function validateNugetResourceExecution(physical, { root, runId, sourceState })
{
    const { resourceServiceContainmentIsComplete } = await import('./physical-execution-process-tree.mjs');
    const { productionSystemdServiceBindingIsComplete, readProductionSystemdResourceBoundaryBinding } =
        await import('../test-matrix/production-systemd-resource-boundary.mjs');
    const admission = physical?.resourceExecutionAdmission;
    const containment = physical?.containmentAuthority;
    const context = admission?.reference?.context;
    if (!admission || !productionSystemdServiceBindingIsComplete(admission.serviceBinding)
        || !resourceServiceContainmentIsComplete(containment) || containment.phase !== 'pre-exec'
        || !equal(containment.serviceBinding, admission.serviceBinding)
        || !equal(containment.supervisorProcessIdentity, admission.processIdentity)
        || !equal(physical.resourceReference, admission.reference)
        || !equal(physical.schedulerSource, sourceState)
        || context?.root !== root || context.runId !== runId || !equal(context.sourceState, sourceState))
        throw new Error('NuGet transfer lacks its original pre-exec native resource and containment admission');
    readProductionSystemdResourceBoundaryBinding(context, { reference: admission.reference });
}

export function nugetPreparationCommand({ purpose = 'behavior-doc', packagesRoot, artifactsRoot, feedRoot, configFile,
    toolchain = null })
{
    const declaration = nugetPreparationDeclaration(purpose);
    const executable = purpose === 'behavior-doc' ? 'dotnet' : toolchain?.executable;
    if (!executable || (purpose !== 'behavior-doc' && !path.isAbsolute(executable)))
        throw new Error('Matrix NuGet preparation lacks its absolute SDK command');
    return [executable, 'restore', declaration.solution, '--locked-mode', '--packages', packagesRoot,
        '--artifacts-path', artifactsRoot, '/p:NuGetAudit=false', '/p:Configuration=Release',
        '--disable-parallel', '--source', feedRoot, '--configfile', configFile];
}

/** Repeat canonical file identity and bytes across asynchronous authority reads. */
export function observeNugetInputFile(file)
{
    const stat = fs.lstatSync(file, { bigint: true });
    const bytes = regular(file);
    return { device: String(stat.dev), inode: String(stat.ino), mode: Number(stat.mode & 0o777n),
        size: String(stat.size), sha256: digest(bytes) };
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
    { throw new Error('Offline feed must contain only the complete finite locked archive roster'); }
    let expandedAllocatedBytes = allocationBlockSize;
    for (const record of expected)
    {
        const bytes = regular(path.join(feed.root, record.file));
        if (!/^[A-Za-z0-9+/]{86}==$/u.test(record.contentHash ?? ''))
        { throw new Error('Offline feed requires an exact package lock content hash'); }
        record.archiveSha512 = createHash('sha512').update(bytes).digest('base64');
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
export async function readPreparedNuget({ repositoryRoot, runId, file, producerId })
{
    const purpose = nugetPreparationPurpose(producerId);
    const declaration = nugetPreparationDeclaration(purpose);
    if (!file) throw new Error('Correctness requires explicit offline NuGet preparation');
    const input = path.resolve(file);
    const bytes = regular(input);
    const inputIdentity = observeNugetInputFile(input);
    if (inputIdentity.mode & 0o222) throw new Error('NuGet preparation descriptor must be sealed');
    if (inputIdentity.sha256 !== digest(bytes)) throw new Error('NuGet descriptor bytes drifted during read');
    const preparation = JSON.parse(bytes);
    if ((preparation.purpose ?? 'behavior-doc') !== purpose) throw new Error('NuGet preparation belongs to a foreign declaration');
    const preparationOwner = path.join(path.resolve(repositoryRoot), '.tmp/' + declaration.owner);
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
    const closure = nugetPreparationClosure(repositoryRoot, purpose);
    const sdk = observeNugetPreparationToolchain(repositoryRoot, purpose);
    const parentSdk = observePreparedNugetParentSdk(repositoryRoot, preparation);
    const { snapshotSourceState } = await import('../test-matrix/scheduler.mjs');
    const schedulerSource = await snapshotSourceState(repositoryRoot);
    if (!equal(preparation.schedulerSource, schedulerSource)) throw new Error('NuGet scheduler source drifted');
    if (!equal(preparation.source, source) || !equal(preparation.closure, closure))
    {
        throw new Error('NuGet preparation source or locked graph drifted');
    }
    const transfer = preparation.transfer;
    if (transfer?.runId !== runId || transfer.consumerId !== declaration.transfer
        || !new RegExp('^' + declaration.transfer + '-[a-f0-9-]{36}$', 'u').test(transfer.key ?? '')
        || transfer.root !== path.join(path.resolve(repositoryRoot), '.tmp/physical-executions'))
    { throw new Error('NuGet transfer is foreign to this scheduler run or original producer'); }
    const transferIdentity = [transfer.receiptFile, transfer.projectionFile].map(observeNugetInputFile);
    const verified = await validateRunBoundProjection({ ...transfer, verifyOutputs: true });
    if (!equal(inputIdentity, observeNugetInputFile(input))
        || !equal(transferIdentity, [transfer.receiptFile, transfer.projectionFile].map(observeNugetInputFile))
        || !equal(source, sealSourceIdentity(repositoryRoot))
        || !equal(closure, nugetPreparationClosure(repositoryRoot, purpose))
        || !equal(sdk, observeNugetPreparationToolchain(repositoryRoot, purpose))
        || !equal(parentSdk, observePreparedNugetParentSdk(repositoryRoot, preparation)))
        throw new Error('NuGet preparation identity drifted across transfer verification');
    if (transferIdentity[0].sha256 !== digest(verified.receiptBytes)
        || transferIdentity[1].sha256 !== digest(verified.projectionBytes))
        throw new Error('NuGet transfer verification read foreign bytes');
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
    const expectedCommand = nugetPreparationCommand({ purpose, packagesRoot: seed.root,
        artifactsRoot: preparation.artifactsRoot, feedRoot: preparation.feedRoot,
        configFile: preparation.configFile, toolchain: sdk });
    const physical = receipt.physicalExecution;
    const feed = inventoryNugetOfflineFeed(preparation.feedRoot, closure, allocationBlockSize);
    const toolchain = receipt.physicalExecution?.toolchain;
    const alias = physical?.executionAdmission?.ownedPrivateTmp;
    const filesystem = physical?.authority?.filesystemIsolation;
    const directoryFragment = physical?.executionEnvelopeFragments?.directories;
    const plannedAlias = physical?.executionEnvelopeFragments?.network?.sandbox?.filesystem?.ownedPrivateTmp;
    const executable = resolveExecutablePath(sdk?.executable ?? 'dotnet', { pathValue: process.env.PATH });
    if (receipt.receiptDigest !== transfer.receiptDigest || receipt.commit !== source.sourceCommit
        || receipt.worktreeFingerprint !== source.worktreeFingerprint
        || path.resolve(receipt.cwd) !== path.resolve(repositoryRoot)
        || !equal(receipt.command, expectedCommand)
        || !equal(receipt.requiredOutputs, [preparation.artifactsRoot, preparation.feedRoot, seed.root, preparation.configFile].sort())
        || !equal(physical?.sdk ?? null, sdk)
        || (sdk && toolchain?.version !== sdk.sdkVersion)
        || physical?.capacityPlanDigest == null
        || !/^sha256:[a-f0-9]{64}$/u.test(physical.capacityPlanDigest)
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
        || physical.offlineFeed?.allocatedBytes !== feed.allocatedBytes
        || physical.offlineFeed?.expandedAllocatedBytes !== feed.expandedAllocatedBytes
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
    assertPreparedNugetParentSdkPhysical(physical, parentSdk);
    await validateNugetResourceExecution(physical, { root: fs.realpathSync(repositoryRoot), runId,
        sourceState: schedulerSource });
    if (!equal(schedulerSource, await snapshotSourceState(repositoryRoot)))
        throw new Error('NuGet scheduler source drifted across native admission verification');
    validatePreparedNugetPackages(seed, closure, feed);
    if (!equal(inputIdentity, observeNugetInputFile(input))
        || !equal(transferIdentity, [transfer.receiptFile, transfer.projectionFile].map(observeNugetInputFile))
        || !equal(source, sealSourceIdentity(repositoryRoot))
        || !equal(closure, nugetPreparationClosure(repositoryRoot, purpose))
        || !equal(sdk, observeNugetPreparationToolchain(repositoryRoot, purpose))
        || !equal(parentSdk, observePreparedNugetParentSdk(repositoryRoot, preparation)))
        throw new Error('NuGet preparation identity drifted before ingress');
    return { ...seed, file: input, preparation, closure, purpose, producerId, runId, sdk, parentSdk, feedDigest: feed.treeDigest, feedAllocatedBytes: feed.allocatedBytes,
        inputPaths: [input, verified.receiptFile, verified.projectionFile],
        inputIdentities: [inputIdentity, ...transferIdentity],
        bindingDigest: digest(Buffer.concat([bytes, verified.receiptBytes, verified.projectionBytes])) };
}

export async function readPreparedBehaviorDocNuget(options)
{
    return readPreparedNuget({ ...options, producerId: 'behavior-doc-static-admission' });
}

export function assertPreparedNugetCurrent(prepared, repositoryRoot)
{
    if (!equal(prepared.inputIdentities, prepared.inputPaths.map(observeNugetInputFile))
        || !equal(prepared.preparation.source, sealSourceIdentity(repositoryRoot))
        || !equal(prepared.closure, nugetPreparationClosure(repositoryRoot, prepared.purpose))
        || !equal(prepared.sdk, observeNugetPreparationToolchain(repositoryRoot, prepared.purpose))
        || !equal(prepared.parentSdk ?? null, observePreparedNugetParentSdk(repositoryRoot, prepared.preparation))
        || inventoryPreparedNuget(prepared.root).treeDigest !== prepared.treeDigest
        || inventoryNugetOfflineFeed(prepared.preparation.feedRoot, prepared.closure).treeDigest
            !== prepared.feedDigest)
        throw new Error('Prepared NuGet source, transfer, SDK or payload drifted at execution boundary');
}

export async function revalidatePreparedNuget(prepared, repositoryRoot)
{
    const actual = await readPreparedNuget({ repositoryRoot, producerId: prepared.producerId,
        runId: prepared.runId, file: prepared.file });
    if (!equal(actual, prepared)) throw new Error('Prepared NuGet ingress drifted after admission');
    return actual;
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
