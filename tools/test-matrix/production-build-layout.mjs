import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const {collectProcessGroupOrJobIdentity, currentProcessIdentity, processDescendantIdentities, processGroupMemberIdentities, processGroupOrJobIdentityMatches, processIdentitySchema, processIdentityStatus} = await import(new URL('../test/process-identity.mjs', import.meta.url));
const { inspectProductionSystemdResourceBoundary, inspectProductionSystemdServiceBinding, readProductionSystemdResourceBoundaryBinding, recoverProductionSystemdResourceBoundary, systemdResourceBoundarySchema } = await import(new URL('./production-systemd-resource-boundary.mjs', import.meta.url));
const { cleanupLivePhysicalExecutionResidentArtifacts, cleanupPhysicalExecutionResourceArtifacts,
    inspectPhysicalExecutionResourceArtifacts,
    inspectPhysicalExecutionResidentOutput,
    resourceServiceContainmentIsComplete, resourceServiceContainmentSchema, terminatePhysicalExecutionAuthoritySync } = await import(new URL('../test/physical-execution-process-tree.mjs', import.meta.url));
const { systemdSenderReadyIsComplete, verifySystemdSenderTerminal } = await import(new URL('../test/physical-execution-systemd-sender.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../test-fixtures/receipt/canonical.mjs', import.meta.url));
const { assertSchedulerResourceRecovery, completeSchedulerResourceRecovery, inspectSchedulerResourceRetention } = await import(new URL('./scheduler.mjs', import.meta.url));
import {
    schedulerCandidateIdentityDigest,
    schedulerProcessGroupOrJobIdentityIsComplete,
    schedulerRunLockActivity,
    schedulerRunOwnerIdentityMatches,
    schedulerRunOwnerIsComplete,
    schedulerRunOwnerSchema
} from './scheduler-run-owner.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const productionBuildLayoutSchema = 'fsusblog.production-build-layout.v2';
const resourceRecoveryLockSchema = 'fsusblog.production-build-resource-recovery-lock.v1';
const senderTerminalJournalSchema = 'fsusblog.production-build-sender-terminal-recovery.v1';
const buildOwnerMonitors = new Map();
// frontend-build-cache-bootstrap.mjs is wired as the production cache bootstrap entrypoint for public frontend caching.

export function validateProductionRunId(value)
{
    const runId = String(value ?? '').trim();
    if (!runId || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(runId) || runId === '.' || runId === '..')
    {
        throw new Error(`unsafe production build run id: ${runId || '<empty>'}`);
    }
    return runId;
}

function projectName(projectFile)
{
    const name = path.basename(String(projectFile), path.extname(String(projectFile)));
    if (!name || !/^[A-Za-z0-9_.-]+$/u.test(name))
    {
        throw new Error(`unsafe MSBuild project name: ${projectFile}`);
    }
    return name;
}

export function resolveProductionBuildLayout({
    root = defaultRoot,
    runId = process.env.FSUSBLOG_TEST_RUN_ID
} = {})
{
    const repositoryRoot = path.resolve(root);
    const normalizedRunId = validateProductionRunId(runId);
    const buildBase = path.join(repositoryRoot, '.tmp/build');
    const runRoot = path.join(buildBase, normalizedRunId);
    return {
        schema: productionBuildLayoutSchema,
        runId: normalizedRunId,
        repositoryRoot,
        buildBase,
        runRoot,
        activeFile: path.join(runRoot, '.active.json'),
        manifestFile: path.join(runRoot, 'layout.json'),
        dotnetRoot: path.join(runRoot, 'dotnet'),
        frontendDist: path.join(runRoot, 'frontend/dist'),
        frontendSsrRuntime: path.join(runRoot, 'frontend/ssr-runtime'),
        frontendCache: path.join(runRoot, 'frontend/cache'),
        frontendWasm: path.join(runRoot, 'frontend/wasm'),
        backendWebRoot: path.join(runRoot, 'frontend/wwwroot'),
        runtimeRoot: path.join(runRoot, 'runtime'),
        runtimeFrontendDist: path.join(runRoot, 'runtime/frontend/dist'),
        runtimeBackendWebRoot: path.join(runRoot, 'runtime/backend/wwwroot'),
        wasmArtifacts: path.join(runRoot, 'wasm'),
        generatedRoot: path.join(runRoot, 'generated')
    };
}

export function dotnetProjectLayout(layout, projectFile, configuration = 'Release', targetFramework = 'net10.0')
{
    const name = projectName(projectFile);
    const projectRoot = path.join(layout.dotnetRoot, name);
    return {
        name,
        projectFile: String(projectFile).replaceAll(path.sep, '/'),
        projectRoot,
        baseOutputPath: path.join(projectRoot, 'bin'),
        baseIntermediateOutputPath: path.join(projectRoot, 'obj'),
        projectExtensionsPath: path.join(projectRoot, 'obj'),
        outputDirectory: path.join(projectRoot, 'bin', configuration, targetFramework),
        intermediateDirectory: path.join(projectRoot, 'obj', configuration, targetFramework),
        assetsFile: path.join(projectRoot, 'obj/project.assets.json')
    };
}

export function productionDotnetArtifacts(layout)
{
    const server = dotnetProjectLayout(layout, 'src/backend/FsusBlog.Server.csproj');
    const tests = dotnetProjectLayout(layout, 'tests/backend/FsusBlog.Server.Tests.csproj');
    const migrationTests = dotnetProjectLayout(layout, 'tests/migration/FsusBlog.Migration.Tests.csproj');
    const xunitAdapter = dotnetProjectLayout(layout, 'tools/test-inventory/xunit-roslyn-adapter/FsusBlog.XunitRoslynAdapter.csproj');
    const benchmark = dotnetProjectLayout(layout, 'benchmarks/core/FsusBlog.Core.Benchmarks.csproj');
    return {
        server,
        tests,
        migrationTests,
        xunitAdapter,
        benchmark,
        serverDll: path.join(server.outputDirectory, 'FsusBlog.Server.dll'),
        testDll: path.join(tests.outputDirectory, 'FsusBlog.Server.Tests.dll'),
        migrationTestDll: path.join(migrationTests.outputDirectory, 'FsusBlog.Migration.Tests.dll'),
        xunitAdapterDll: path.join(xunitAdapter.outputDirectory, 'FsusBlog.XunitRoslynAdapter.dll'),
        benchmarkDll: path.join(benchmark.outputDirectory, 'FsusBlog.Core.Benchmarks.dll')
    };
}

function relative(root, target)
{
    return path.relative(root, target).replaceAll(path.sep, '/');
}

function atomicWriteJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${randomUUID()}`;
    const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    const created = fs.fstatSync(descriptor);
    try
    {
        try
        {
            fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
            fs.fsyncSync(descriptor);
        }
        finally
        {
            fs.closeSync(descriptor);
        }
        fs.renameSync(temporary, file);
        if (process.platform === 'win32')
        {
            // Windows has no Node directory-fsync primitive; Linux-only resource retention is rejected below.
            return;
        }
        const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try
        {
            fs.fsyncSync(directory);
        }
        finally
        {
            fs.closeSync(directory);
        }
    }
    catch (error)
    {
        try
        {
            const current = fs.lstatSync(temporary);
            if (!current.isFile() || current.dev !== created.dev || current.ino !== created.ino)
            {
                throw new Error('production build temporary record changed before cleanup', { cause: error });
            }
            fs.unlinkSync(temporary);
        }
        catch (cleanupError)
        {
            if (cleanupError.code !== 'ENOENT')
            {
                error.temporaryCleanupFailure = cleanupError.message;
            }
        }
        throw error;
    }
}

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonicalize(value[key])])
        );
    }
    return value;
}

function readBuildRecord(file)
{
    if (process.platform !== 'linux')
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o077) !== 0 || fs.realpathSync(file) !== file)
    {
        throw new Error('production build owner record must be private, literal and singly linked');
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        const opened = fs.fstatSync(descriptor);
        if (opened.ino !== stat.ino || opened.dev !== stat.dev)
        {
            throw new Error('production build owner record changed during observation');
        }
        return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function processTreeReceipt(owner)
{
    const payload = {
        schema: 'fsusblog.production-build-process-tree-receipt.v2',
        runId: owner.runId,
        ownerPlatform: owner.ownerPlatform,
        schedulerRunId: owner.schedulerRunId,
        namespace: owner.namespace,
        sourceCommit: owner.sourceCommit,
        worktreeFingerprint: owner.worktreeFingerprint,
        ownerIdentity: owner.ownerIdentity,
        processGroupOrJobIdentity: owner.processGroupOrJobIdentity,
        schedulerLockIdentity: owner.schedulerLockIdentity,
        managedResourceBoundaries: [...owner.managedResourceBoundaries].sort((left, right) =>
            left.reference.bindingDigest.localeCompare(right.reference.bindingDigest)
        ),
        managedContainmentAuthorities: [...owner.managedContainmentAuthorities].sort((left, right) =>
            left.authorityId.localeCompare(right.authorityId)
        ),
        managedProcessGroupIdentities: [...owner.managedProcessGroupIdentities].sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right))
        ),
        activeCompilerProcessIdentities: [...owner.activeCompilerProcessIdentities].sort((left, right) =>
            left.processStartIdentity.localeCompare(right.processStartIdentity)
        )
    };
    return {
        ...payload,
        receiptDigest: `sha256:${createHash('sha256')
            .update(JSON.stringify(canonicalize(payload)))
            .digest('hex')}`
    };
}

export function sealProductionBuildProcessTreeReceipt(owner)
{
    return processTreeReceipt(owner);
}

function digestBuildTree(directory)
{
    const hash = createHash('sha256');
    const visit = (current, relativePath = '') =>
    {
        for (const entry of fs
            .readdirSync(current, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name)))
        {
            const child = path.join(current, entry.name);
            const relativeChild = relativePath ? `${relativePath}/${entry.name}` : entry.name;
            if (
                relativeChild === 'layout.json' ||
                relativeChild === '.active.json' ||
                relativeChild === '.reclaim.json' ||
                relativeChild === '.sender-terminal-recovery.json'
            )
            {
                continue;
            }
            const metadata = fs.lstatSync(child);
            let type = 'other';
            if (entry.isDirectory())
            {
                type = 'directory';
            }
            else if (entry.isFile())
            {
                type = 'file';
            }
            else if (entry.isSymbolicLink())
            {
                type = 'symlink';
            }
            hash.update(`${relativeChild}\0${type}\0${metadata.mode & 0o777}\0${metadata.size}\0`);
            if (entry.isDirectory())
            {
                visit(child, relativeChild);
            }
            if (entry.isFile())
            {
                hash.update(fs.readFileSync(child));
            }
            if (entry.isSymbolicLink())
            {
                hash.update(fs.readlinkSync(child));
            }
        }
    };
    visit(directory);
    return `sha256:${hash.digest('hex')}`;
}

function buildOwner(layout, { sourceState, namespace, allowDiagnosticProcessContainmentForTests })
{
    const identity = currentProcessIdentity();
    const group = process.platform === 'win32' ? null : collectProcessGroupOrJobIdentity(identity.pid);
    if (group && group.status !== 'verified')
    {
        throw new Error(`production build process-group identity is unverifiable: ${group.reason}`);
    }
    const sourceCommit = String(sourceState?.commit ?? '').trim();
    const worktreeFingerprint = String(sourceState?.worktreeFingerprint ?? '').trim();
    const normalizedNamespace = String(namespace ?? '').trim();
    if (!sourceCommit || !worktreeFingerprint || !normalizedNamespace)
    {
        throw new Error('production build owner requires exact source and namespace before preparing');
    }
    const owner = {
        runId: layout.runId,
        ownerPlatform: process.platform,
        schedulerRunId: layout.runId,
        namespace: normalizedNamespace,
        sourceCommit,
        worktreeFingerprint,
        ownerPid: identity.pid,
        ownerProcessStartIdentity: identity.processStartIdentity,
        ownerExecutableDigest: identity.executableDigest,
        ownerCommandDigest: identity.commandDigest,
        ownerIdentity: identity,
        processGroupOrJobIdentity: group?.value ?? null,
        schedulerLockIdentity: null,
        allowDiagnosticProcessContainmentForTests: allowDiagnosticProcessContainmentForTests === true,
        managedContainmentAuthorities: [],
        managedResourceBoundaries: [],
        managedProcessGroupIdentities: [],
        activeCompilerProcessIdentities: [],
        createdAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        state: 'preparing'
    };
    owner.processTreeReceipt = processTreeReceipt(owner);
    return owner;
}

function completeProcessIdentity(identity)
{
    return Boolean(
        identity &&
            identity.schema === processIdentitySchema &&
            Number.isInteger(identity.pid) &&
            identity.pid > 0 &&
            identity.processStartIdentity &&
            identity.executablePath &&
            identity.executableDigest &&
            identity.commandDigest
    );
}

function completeProcessGroupOrJobIdentity(group)
{
    return Boolean(
        group &&
            group.schema === 'fsusblog.process-group-or-job-identity.v1' &&
            ['linux', 'darwin'].includes(group.platform) &&
            group.kind === 'process-group' &&
            Number.isInteger(group.groupId) &&
            group.groupId > 0 &&
            Number.isInteger(group.leaderPid) &&
            group.leaderPid > 0 &&
            group.leaderProcessStartIdentity
    );
}

function completeContainmentAuthority(authority)
{
    if (authority?.schema === resourceServiceContainmentSchema)
    {
        return resourceServiceContainmentIsComplete(authority);
    }
    return Boolean(
        authority &&
            authority.schema === 'fsusblog.durable-process-containment.v1' &&
            typeof authority.authorityId === 'string' &&
            authority.authorityId.length > 0 &&
            completeProcessIdentity(authority.supervisorProcessIdentity) &&
            ((authority.platform === 'linux' &&
                authority.kind === 'systemd-transient-service' &&
                authority.killPolicy === 'control-group' &&
                typeof authority.unitName === 'string' &&
                authority.unitName.length > 0) ||
                (authority.platform === 'win32' &&
                    authority.kind === 'windows-job-object' &&
                    authority.killPolicy === 'kill-on-job-close' &&
                    typeof authority.jobName === 'string' &&
                    authority.jobName.length > 0 &&
                    /^sha256:[a-f0-9]{64}$/u.test(authority.supervisorScriptDigest)) ||
                (authority.platform === 'darwin' &&
                    authority.kind === 'darwin-process-group' &&
                    authority.killPolicy === 'process-group-with-descendant-ledger' &&
                    authority.groupId === authority.supervisorProcessIdentity.pid &&
                    authority.leaderPid === authority.supervisorProcessIdentity.pid &&
                    authority.leaderProcessStartIdentity ===
                        authority.supervisorProcessIdentity.processStartIdentity))
    );
}

function completeSchedulerLockIdentity(identity, owner)
{
    return Boolean(
        identity &&
            identity.schema === schedulerRunOwnerSchema &&
            schedulerRunOwnerIsComplete(identity) &&
            identity.ownerToken &&
            identity.runId === owner.schedulerRunId &&
            /^sha256:[a-f0-9]{64}$/u.test(identity.candidateIdentityDigest) &&
            typeof identity.targetTierId === 'string' &&
            identity.targetTierId.length > 0 &&
            identity.pid === owner.ownerPid &&
            identity.processStartIdentity === owner.ownerProcessStartIdentity &&
            identity.executableDigest === owner.ownerExecutableDigest &&
            identity.commandDigest === owner.ownerCommandDigest &&
            schedulerProcessGroupOrJobIdentityIsComplete(identity.processGroupOrJobIdentity)
    );
}

function compilerIdentityHasContainmentAuthority(owner, identity)
{
    if (
        owner.managedContainmentAuthorities.some(
            (authority) =>
                authority.supervisorProcessIdentity?.pid === identity.pid &&
                authority.supervisorProcessIdentity?.processStartIdentity === identity.processStartIdentity
        )
    )
    {
        return true;
    }
    const status = processIdentityStatus(identity);
    if (['dead', 'mismatch'].includes(status.status))
    {
        return true;
    }
    if (status.status !== 'live')
    {
        return false;
    }
    if (owner.ownerPlatform === 'linux')
    {
        const contained = owner.managedContainmentAuthorities
            .filter((authority) => authority.schema === resourceServiceContainmentSchema && authority.phase === 'pre-exec')
            .some((authority) =>
            {
                try
                {
                    const observed = inspectProductionSystemdServiceBinding(authority.serviceBinding, {
                        commandBudgetMs: authority.commandBudgetMs
                    });
                    return observed.status === 'present' && observed.group.processIds.includes(identity.pid)
                        && processIdentityStatus(identity).status === 'live';
                }
                catch
                {
                    return false;
                }
            });
        // Service observation spans OS calls. An identity that exited or was replaced
        // meanwhile is no longer a live writer; this does not admit its replacement.
        return contained || ['dead', 'mismatch'].includes(processIdentityStatus(identity).status);
    }
    if (owner.ownerPlatform !== 'darwin')
    {
        return false;
    }
    return owner.managedContainmentAuthorities
        .filter((authority) => authority.kind === 'darwin-process-group')
        .some((authority) =>
        {
            const members = processGroupMemberIdentities({
                schema: 'fsusblog.process-group-or-job-identity.v1',
                platform: 'darwin',
                kind: 'process-group',
                groupId: authority.groupId,
                leaderPid: authority.leaderPid,
                leaderProcessStartIdentity: authority.leaderProcessStartIdentity
            });
            return members.status === 'verified' && members.identities.some(
                (member) =>
                    member.pid === identity.pid &&
                    member.processStartIdentity === identity.processStartIdentity
            );
        });
}

function resourceBoundaryContext(layout, owner, bundleId)
{
    return { root: layout.repositoryRoot, runId: layout.runId, namespace: owner.namespace, bundleId,
        sourceState: { commit: owner.sourceCommit, worktreeFingerprint: owner.worktreeFingerprint },
        schedulerOwnerToken: owner.schedulerLockIdentity?.ownerToken };
}

function completeResourceBoundary(layout, owner, entry)
{
    const reference = entry?.reference;
    const bundleId = reference?.context?.bundleId;
    if (!entry || Object.keys(entry).sort().join(',') !== 'commandBudgetMs,reference'
        || !Number.isSafeInteger(entry.commandBudgetMs) || entry.commandBudgetMs <= 0
        || !reference || Object.keys(reference).sort().join(',') !== 'bindingDigest,context,ownerFile,schema'
        || reference.schema !== systemdResourceBoundarySchema || !/^sha256:[a-f0-9]{64}$/u.test(reference.bindingDigest)
        || typeof bundleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(bundleId))
    {
        return false;
    }
    const context = resourceBoundaryContext(layout, owner, bundleId);
    const serialized = JSON.stringify(canonicalize(context));
    const contextDigest = createHash('sha256').update(serialized).digest('hex');
    return JSON.stringify(canonicalize(reference.context)) === serialized
        && reference.ownerFile === path.join(layout.repositoryRoot, '.tmp/production-resource-owners', contextDigest, 'owner.json');
}

function completeResourceBoundaries(layout, owner)
{
    return Array.isArray(owner.managedResourceBoundaries)
        && owner.managedResourceBoundaries.every((entry) => completeResourceBoundary(layout, owner, entry))
        && new Set(owner.managedResourceBoundaries.map((entry) => entry.reference.context.bundleId)).size === owner.managedResourceBoundaries.length;
}

function resourceBoundariesRetained(layout, owner, { includeArtifactRetention = true, includeSchedulerRetention = true } = {})
{
    if (JSON.stringify(canonicalize(readBuildRecord(layout.manifestFile).owner)) !== JSON.stringify(canonicalize(owner)))
    {
        throw new Error('production build resource owner changed during observation');
    }
    if (!completeResourceBoundaries(layout, owner))
    {
        throw new Error('production build resource boundary references are incomplete or differ from their owner');
    }
    if (JSON.stringify(canonicalize(owner.processTreeReceipt)) !== JSON.stringify(canonicalize(processTreeReceipt(owner))))
    {
        throw new Error('production build resource boundary receipt differs from its retained owner');
    }
    let retained = false;
    for (const entry of owner.managedResourceBoundaries)
    {
        const observation = inspectProductionSystemdResourceBoundary(
            resourceBoundaryContext(layout, owner, entry.reference.context.bundleId), entry);
        retained ||= observation.status !== 'released';
    }
    return retained || (includeArtifactRetention && inspectPhysicalExecutionResourceArtifacts(owner.managedContainmentAuthorities)
        .some((artifact) => artifact.status !== 'absent'))
        || (includeSchedulerRetention && owner.managedResourceBoundaries.length > 0
            && inspectSchedulerResourceRetention({ root: layout.repositoryRoot, runId: layout.runId,
                namespace: owner.namespace, sourceState: { commit: owner.sourceCommit, worktreeFingerprint: owner.worktreeFingerprint },
                schedulerOwner: owner.schedulerLockIdentity }).status !== 'released');
}

function readBuildOwner(layout, { allowTerminal = false } = {})
{
    const manifest = readBuildRecord(layout.manifestFile);
    const owner = manifest.owner;
    const terminal = allowTerminal && ['complete', 'failed', 'cancelled'].includes(owner?.state);
    const active = terminal ? null : readBuildRecord(layout.activeFile);
    const ownerComplete =
        owner &&
        owner.runId === layout.runId &&
        ['linux', 'darwin', 'win32'].includes(owner.ownerPlatform) &&
        owner.schedulerRunId === layout.runId &&
        typeof owner.namespace === 'string' &&
        owner.namespace.length > 0 &&
        typeof owner.sourceCommit === 'string' &&
        owner.sourceCommit.length > 0 &&
        typeof owner.worktreeFingerprint === 'string' &&
        owner.worktreeFingerprint.length > 0 &&
        Number.isInteger(owner.ownerPid) &&
        owner.ownerPid > 0 &&
        owner.ownerProcessStartIdentity &&
        owner.ownerExecutableDigest &&
        owner.ownerCommandDigest &&
        completeProcessIdentity(owner.ownerIdentity) &&
        owner.ownerIdentity.pid === owner.ownerPid &&
        owner.ownerIdentity.processStartIdentity === owner.ownerProcessStartIdentity &&
        owner.ownerIdentity.executableDigest === owner.ownerExecutableDigest &&
        owner.ownerIdentity.commandDigest === owner.ownerCommandDigest &&
        (owner.ownerPlatform === 'win32'
            ? owner.processGroupOrJobIdentity === null
            : completeProcessGroupOrJobIdentity(owner.processGroupOrJobIdentity)) &&
        typeof owner.allowDiagnosticProcessContainmentForTests === 'boolean' &&
        Array.isArray(owner.managedContainmentAuthorities) &&
        owner.managedContainmentAuthorities.every(completeContainmentAuthority) &&
        owner.managedContainmentAuthorities.every((authority) => authority.schema !== resourceServiceContainmentSchema
            || owner.managedResourceBoundaries.some((entry) =>
                digestCanonical(entry.reference) === digestCanonical(authority.serviceBinding.reference))) &&
        completeResourceBoundaries(layout, owner) &&
        Array.isArray(owner.managedProcessGroupIdentities) &&
        owner.managedProcessGroupIdentities.every(completeProcessGroupOrJobIdentity) &&
        Array.isArray(owner.activeCompilerProcessIdentities) &&
        owner.activeCompilerProcessIdentities.every(completeProcessIdentity) &&
        (owner.allowDiagnosticProcessContainmentForTests ||
            owner.activeCompilerProcessIdentities.every((identity) =>
                compilerIdentityHasContainmentAuthority(owner, identity))) &&
        (terminal || ['preparing', 'building', 'finalizing'].includes(owner.state)) &&
        (owner.state === 'preparing' || (terminal && owner.schedulerLockIdentity === null
            && owner.managedContainmentAuthorities.length === 0
            && owner.managedResourceBoundaries.length === 0
            && owner.managedProcessGroupIdentities.length === 0
            && owner.activeCompilerProcessIdentities.length === 0)
            ? owner.schedulerLockIdentity === null
            : completeSchedulerLockIdentity(owner.schedulerLockIdentity, owner)) &&
        owner.createdAt &&
        owner.heartbeatAt;
    const expectedReceipt = ownerComplete ? processTreeReceipt(owner) : null;
    if (
        manifest.schema !== productionBuildLayoutSchema ||
        (terminal ? fs.existsSync(layout.activeFile)
            || manifest.status !== { complete: 'success', failed: 'failure', cancelled: 'cancelled' }[owner.state]
            : active.schema !== 'fsusblog.production-build-owner.v1') ||
        manifest.runId !== layout.runId ||
        (!terminal && active.runId !== layout.runId) ||
        !ownerComplete ||
        manifest.sourceState?.commit !== owner.sourceCommit ||
        manifest.sourceState?.worktreeFingerprint !== owner.worktreeFingerprint ||
        (!terminal && JSON.stringify(canonicalize(manifest.owner)) !== JSON.stringify(canonicalize(active.owner))) ||
        JSON.stringify(canonicalize(manifest.owner?.processTreeReceipt)) !==
            JSON.stringify(canonicalize(expectedReceipt))
    )
    {
        const failedBindings = [
            !ownerComplete && 'owner-completeness',
            manifest.schema !== productionBuildLayoutSchema && 'layout-schema',
            manifest.runId !== layout.runId && 'layout-run',
            manifest.sourceState?.commit !== owner?.sourceCommit && 'source-commit',
            manifest.sourceState?.worktreeFingerprint !== owner?.worktreeFingerprint && 'source-fingerprint',
            !terminal && JSON.stringify(canonicalize(manifest.owner)) !== JSON.stringify(canonicalize(active.owner)) && 'dual-owner-records',
            JSON.stringify(canonicalize(manifest.owner?.processTreeReceipt)) !== JSON.stringify(canonicalize(expectedReceipt)) && 'process-tree-receipt'
        ].filter(Boolean);
        throw new Error(`production build owner identity mismatch: ${layout.runId}; failed bindings: ${failedBindings.join(', ') || 'lifecycle'}`);
    }
    return { manifest, owner };
}

function capacityOwnerReference(layout, owner)
{
    assertSafeProductionBuildRunRoot(layout.runRoot, { root: layout.repositoryRoot });
    const metadata = fs.lstatSync(layout.runRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || fs.realpathSync.native(layout.runRoot) !== layout.runRoot)
    {
        throw new Error('production capacity build root is not a literal directory');
    }
    return {
        schema: 'fsusblog.production-capacity-build-owner.v1',
        repositoryRoot: layout.repositoryRoot,
        runId: layout.runId,
        directoryIdentity: { device: String(metadata.dev), inode: String(metadata.ino) },
        createdAt: owner.createdAt,
        namespace: owner.namespace,
        sourceCommit: owner.sourceCommit,
        worktreeFingerprint: owner.worktreeFingerprint,
        ownerIdentity: owner.ownerIdentity
    };
}

export function productionBuildCapacityOwnerReferenceIsComplete(reference)
{
    return Boolean(reference
        && Object.keys(reference).sort().join(',') === 'createdAt,directoryIdentity,namespace,ownerIdentity,repositoryRoot,runId,schema,sourceCommit,worktreeFingerprint'
        && reference.schema === 'fsusblog.production-capacity-build-owner.v1'
        && typeof reference.repositoryRoot === 'string' && path.isAbsolute(reference.repositoryRoot)
        && path.resolve(reference.repositoryRoot) === reference.repositoryRoot
        && typeof reference.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(reference.runId)
        && Number.isFinite(Date.parse(reference.createdAt))
        && ['namespace', 'sourceCommit', 'worktreeFingerprint'].every((key) =>
            typeof reference[key] === 'string' && reference[key].length > 0)
        && completeProcessIdentity(reference.ownerIdentity)
        && reference.directoryIdentity
        && Object.keys(reference.directoryIdentity).sort().join(',') === 'device,inode'
        && /^[0-9]+$/u.test(reference.directoryIdentity.device)
        && /^[1-9][0-9]*$/u.test(reference.directoryIdentity.inode));
}

export function retainProductionBuildCapacityOwner(layout)
{
    assertCanonicalResourceOwnerLayout(layout);
    const { owner } = readBuildOwner(layout);
    if (owner.state !== 'preparing' || processIdentityStatus(owner.ownerIdentity).status !== 'live'
        || digestCanonical(owner.ownerIdentity) !== digestCanonical(currentProcessIdentity()))
    {
        throw new Error('production capacity must retain its current build owner before scheduler admission');
    }
    return capacityOwnerReference(layout, owner);
}

export function inspectProductionBuildCapacityOwner(reference)
{
    if (!productionBuildCapacityOwnerReferenceIsComplete(reference))
    {
        throw new Error('production capacity build owner reference is incomplete');
    }
    const layout = resolveProductionBuildLayout({ root: reference.repositoryRoot, runId: reference.runId });
    const { owner } = readBuildOwner(layout, { allowTerminal: true });
    const assertReference = () =>
    {
        const current = readBuildOwner(layout, { allowTerminal: true }).owner;
        if (digestCanonical(capacityOwnerReference(layout, current)) !== digestCanonical(reference)
            || digestCanonical(current) !== digestCanonical(owner))
        {
            throw new Error('production capacity build owner identity changed');
        }
    };
    assertReference();
    let retained;
    if (['complete', 'failed', 'cancelled'].includes(owner.state))
    {
        verifyProductionBuildRootIntegrity(layout);
        retained = resourceBoundariesRetained(layout, owner);
        const statuses = owner.managedContainmentAuthorities.map(containmentAuthorityStatus);
        if (statuses.some((status) => status.status === 'unverifiable'))
        {
            throw new Error('production capacity build containment is unverifiable');
        }
        retained ||= statuses.some((status) => status.status === 'active');
        const identities = [...owner.activeCompilerProcessIdentities];
        for (const group of owner.managedProcessGroupIdentities)
        {
            const members = processGroupMemberIdentities(group);
            if (members.status !== 'verified')
            {
                throw new Error('production capacity build process group is unverifiable');
            }
            identities.push(...members.identities);
        }
        const writers = identities.map((identity) => processIdentityStatus(identity));
        if (writers.some((status) => status.status === 'unverifiable'))
        {
            throw new Error('production capacity build writer is unverifiable');
        }
        retained ||= writers.some((status) => status.status === 'live');
    }
    else
    {
        const status = processIdentityStatus(owner.ownerIdentity).status;
        if (!['live', 'dead', 'exited'].includes(status))
        {
            throw new Error(`production capacity build controller is ${status}`);
        }
        retained = productionBuildRunIsActive(layout.repositoryRoot, layout.runId);
    }
    assertReference();
    return { status: retained ? 'retained' : 'released' };
}

/** Publication observes the original terminal owner and real resource cleanup; a JSON success flag grants nothing. */
export function requireFinalizedProductionBuildResources(layout)
{
    const { manifest, owner } = readBuildOwner(layout, { allowTerminal: true });
    if (manifest.status !== 'success' || owner.state !== 'complete' || fs.existsSync(layout.activeFile))
    {
        throw new Error('production publication requires a successfully finalized original build owner');
    }
    const reference = capacityOwnerReference(layout, owner);
    if (inspectProductionBuildCapacityOwner(reference).status !== 'released')
    {
        throw new Error('production publication refused while original build resources are retained');
    }
    return { manifest, reference };
}

/** Read the original scheduler binding; this observation never authorizes resource effects. */
export function inspectProductionBuildRecoveryBinding(reference)
{
    if (process.platform !== 'linux' || !productionBuildCapacityOwnerReferenceIsComplete(reference))
    {
        throw new Error('production build resource recovery requires a complete Linux owner reference');
    }
    const layout = resolveProductionBuildLayout({ root: reference.repositoryRoot, runId: reference.runId });
    assertCanonicalResourceOwnerLayout(layout);
    const { owner } = readBuildOwner(layout, { allowTerminal: true });
    if (digestCanonical(capacityOwnerReference(layout, owner)) !== digestCanonical(reference))
    {
        throw new Error('production build resource recovery reference differs from its retained owner');
    }
    if (owner.ownerPlatform !== 'linux' || processIdentityStatus(owner.ownerIdentity).status !== 'dead')
    {
        throw new Error('production build resource recovery requires a proven dead controller');
    }
    return { namespace: owner.namespace,
        sourceState: { commit: owner.sourceCommit, worktreeFingerprint: owner.worktreeFingerprint },
        schedulerOwner: owner.schedulerLockIdentity,
        resourceBundleIds: owner.managedResourceBoundaries.map((entry) => entry.reference.context.bundleId) };
}

/** Recover only an independently retained dead build's exact resource-bound process tree. */
export function recoverProductionBuildResourceTree(reference, { schedulerRecovery = null } = {})
{
    if (process.platform !== 'linux' || !productionBuildCapacityOwnerReferenceIsComplete(reference))
    {
        throw new Error('production build resource recovery requires a complete Linux owner reference');
    }
    const layout = resolveProductionBuildLayout({ root: reference.repositoryRoot, runId: reference.runId });
    assertCanonicalResourceOwnerLayout(layout);
    const original = readBuildOwner(layout, { allowTerminal: true });
    const { owner } = original;
    let markerIdentity = null;
    const markerFile = path.join(layout.runRoot, '.reclaim.json');
    const senderJournalFile = path.join(layout.runRoot, '.sender-terminal-recovery.json');
    let senderJournalExpectedDigest = null;
    const marker = { schema: resourceRecoveryLockSchema,
        identity: currentProcessIdentity(), nonce: randomUUID(), reference };
    const syncDirectory = () =>
    {
        const descriptor = fs.openSync(layout.runRoot, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try
        {
            fs.fsyncSync(descriptor);
        }
        finally
        {
            fs.closeSync(descriptor);
        }
    };
    const verifyCurrent = ({ skipSenderJournal = false } = {}) =>
    {
        const current = readBuildOwner(layout, { allowTerminal: true });
        if (digestCanonical(capacityOwnerReference(layout, current.owner)) !== digestCanonical(reference)
            || digestCanonical(current.manifest) !== digestCanonical(original.manifest))
        {
            throw new Error('production build resource recovery reference differs from its retained owner');
        }
        if (owner.ownerPlatform !== 'linux' || processIdentityStatus(owner.ownerIdentity).status !== 'dead')
        {
            throw new Error('production build resource recovery requires a proven dead controller');
        }
        const stored = owner.schedulerLockIdentity;
        if (schedulerRecovery !== null)
        {
            assertSchedulerResourceRecovery(schedulerRecovery, { reference, schedulerOwner: stored });
        }
        else
        {
            const scheduler = schedulerRunLockActivity({ runsRoot: path.join(layout.repositoryRoot, '.tmp/test-runs'),
                runId: layout.runId, candidateIdentityDigest: stored?.candidateIdentityDigest, targetTierId: stored?.targetTierId });
            if (scheduler.status !== 'inactive' || (scheduler.owner && !schedulerRunOwnerIdentityMatches(stored, scheduler.owner)))
            {
                throw new Error('production build resource recovery scheduler owner is active, changed or unverifiable');
            }
        }
        if (markerIdentity)
        {
            const stat = fs.lstatSync(markerFile);
            if (stat.dev !== markerIdentity.dev || stat.ino !== markerIdentity.ino
                || digestCanonical(readBuildRecord(markerFile)) !== digestCanonical(marker))
            {
                throw new Error('production build resource recovery lock changed');
            }
        }
        if (!skipSenderJournal && senderJournalExpectedDigest !== null
            && digestCanonical(readSenderTerminalJournal(senderJournalFile, reference,
                owner.managedContainmentAuthorities)) !== senderJournalExpectedDigest)
        {
            throw new Error('production build sender terminal journal changed during recovery');
        }
        return { status: 'verified' };
    };
    const assertCurrent = () => verifyCurrent();
    assertCurrent();
    if (owner.allowDiagnosticProcessContainmentForTests || owner.managedResourceBoundaries.length === 0
        || owner.managedContainmentAuthorities.some((authority) => authority.schema !== resourceServiceContainmentSchema))
    {
        throw new Error('production build resource recovery requires retained non-diagnostic resource service authority');
    }
    if (owner.managedContainmentAuthorities.length === 0)
    {
        throw new Error('production build resource recovery requires independently retained service authority');
    }
    for (const entry of owner.managedResourceBoundaries)
    {
        const binding = readProductionSystemdResourceBoundaryBinding(entry.reference.context, entry);
        if (digestCanonical(binding.owner.controllerIdentity) !== digestCanonical(owner.ownerIdentity))
        {
            throw new Error('production build resource recovery controller differs from its resource owner');
        }
        inspectProductionSystemdResourceBoundary(entry.reference.context, entry);
    }
    for (const authority of owner.managedContainmentAuthorities)
    {
        inspectProductionSystemdServiceBinding(authority.serviceBinding, { commandBudgetMs: authority.commandBudgetMs });
    }
    const staleMarkerIdentity = fs.lstatSync(markerFile, { throwIfNoEntry: false });
    if (staleMarkerIdentity && schedulerRecovery !== null)
    {
        // The acquired scheduler lease excludes another legitimate recovery owner. A bare
        // build reference is not enough authority to remove an interrupted owner's lock.
        const stale = readBuildRecord(markerFile);
        if (!stale || typeof stale !== 'object' || Array.isArray(stale)
            || JSON.stringify(Object.keys(stale).sort()) !== JSON.stringify(['schema', 'identity', 'nonce', 'reference'].sort())
            || stale.schema !== resourceRecoveryLockSchema
            || !completeProcessIdentity(stale.identity) || stale.identity.status !== 'verified'
            || digestCanonical(stale.identity) === digestCanonical(owner.ownerIdentity)
            || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(stale.nonce)
            || !productionBuildCapacityOwnerReferenceIsComplete(stale.reference)
            || digestCanonical(stale.reference) !== digestCanonical(reference)
            || processIdentityStatus(stale.identity).status !== 'dead')
        {
            throw new Error('production build resource recovery lock is foreign, live or unverifiable');
        }
        assertCurrent();
        const latestIdentity = fs.lstatSync(markerFile);
        if (['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'ctimeMs', 'mtimeMs'].some((key) =>
            latestIdentity[key] !== staleMarkerIdentity[key])
            || digestCanonical(readBuildRecord(markerFile)) !== digestCanonical(stale))
        {
            throw new Error('production build resource recovery lock changed before dead-owner takeover');
        }
        fs.unlinkSync(markerFile);
        syncDirectory();
        assertCurrent();
    }
    fs.writeFileSync(markerFile, `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: 'wx' });
    const descriptor = fs.openSync(markerFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        markerIdentity = fs.fstatSync(descriptor);
        fs.fsyncSync(descriptor);
        syncDirectory();
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    const report = { schema: 'fsusblog.production-build-resource-recovery.v1', reference,
        recoveringIdentity: marker.identity, status: 'retained', services: [], resources: [],
        retainedArtifacts: owner.managedContainmentAuthorities.map((authority) => ({
            authorityId: authority.authorityId, controlRoot: authority.controlRoot, nestedChannel: authority.nestedChannel
        })) };
    let failure;
    let unresolvedCreation = false;
    let senderJournal;
    try
    {
        assertCurrent();
        senderJournal = readSenderTerminalJournal(senderJournalFile, reference, owner.managedContainmentAuthorities);
        senderJournalExpectedDigest = digestCanonical(senderJournal);
        report.artifactPreflight = inspectPhysicalExecutionResourceArtifacts(owner.managedContainmentAuthorities);
        for (const authority of [...owner.managedContainmentAuthorities].reverse())
        {
            assertCurrent();
            const journalEntry = senderJournal.terminals.find((entry) => entry.authorityId === authority.authorityId) ?? null;
            const pendingCreation = authority.phase === 'create-attempted';
            const observed = inspectProductionSystemdServiceBinding(authority.serviceBinding, {
                commandBudgetMs: authority.commandBudgetMs
            });
            const senderTerminal = authority.creationSender !== null || pendingCreation
                ? inspectServiceCreationSenderTerminal(authority, journalEntry) : null;
            if (authority.phase === 'prepared' && observed.status !== 'absent')
            {
                throw new Error('production build unattempted service unexpectedly exists');
            }
            if (pendingCreation && senderTerminal?.status === 'terminal'
                && senderTerminal.submission === 'not-submitted' && observed.status !== 'absent')
            {
                throw new Error('production build unsubmitted service unexpectedly exists');
            }
            if (pendingCreation && observed.status === 'absent' && senderTerminal?.status !== 'terminal')
            {
                report.services.push({ authorityId: authority.authorityId, phase: authority.phase,
                    status: 'pending-creation-unresolved', senderTerminal, termination: null });
                unresolvedCreation = true;
                continue;
            }
            const termination = terminatePhysicalExecutionAuthoritySync({ authority,
                reason: 'dead-production-build-controller', validateAuthority: assertCurrent });
            const serviceReport = { authorityId: authority.authorityId, phase: authority.phase,
                senderTerminal, termination };
            report.services.push(serviceReport);
            if (termination.terminated !== true || termination.postObservation !== 'zero-members')
            {
                throw new Error(`production build resource recovery service remains unverified: ${termination.reason}`);
            }
            if (authority.creationSender !== null)
            {
                serviceReport.senderTerminal = inspectServiceCreationSenderTerminal(authority, journalEntry);
            }
            if ((pendingCreation || authority.creationSender !== null)
                && serviceReport.senderTerminal?.status !== 'terminal')
            {
                unresolvedCreation = true;
            }
            else if (authority.creationSender !== null && !journalEntry)
            {
                assertCurrent();
                const actualJournal = readSenderTerminalJournal(senderJournalFile, reference,
                    owner.managedContainmentAuthorities);
                if (digestCanonical(actualJournal) !== digestCanonical(senderJournal))
                {
                    throw new Error('production build sender terminal journal changed before retention');
                }
                const terminal = serviceReport.senderTerminal;
                const next = { ...senderJournal, terminals: [...senderJournal.terminals, {
                    authorityId: authority.authorityId,
                    creationSenderDigest: digestCanonical(authority.creationSender),
                    plan: terminal.plan, receipt: terminal.receipt
                }].sort((left, right) => left.authorityId.localeCompare(right.authorityId)) };
                atomicWriteJson(senderJournalFile, next);
                senderJournal = readSenderTerminalJournal(senderJournalFile, reference,
                    owner.managedContainmentAuthorities);
                if (digestCanonical(senderJournal) !== digestCanonical(next))
                {
                    throw new Error('production build sender terminal journal lacks durable exact read-back');
                }
                senderJournalExpectedDigest = digestCanonical(senderJournal);
                report.senderTerminalJournal = { path: senderJournalFile, digest: digestCanonical(senderJournal) };
            }
        }
        if (unresolvedCreation)
        {
            // A surviving systemd-run sender or queued manager job may still create an
            // attempted service after an absent observation. Reclaim exact services that
            // are already present, but retain the parent and every grant until the
            // creation attempt has independent terminal reconciliation.
            throw new Error('production build resource recovery requires independent reconciliation of pending service creation');
        }
        for (const entry of owner.managedResourceBoundaries)
        {
            assertCurrent();
            const cleanup = recoverProductionSystemdResourceBoundary(entry.reference.context, {
                ...entry, validateRecoveryAuthority: schedulerRecovery === null ? null : assertCurrent
            });
            report.resources.push({ reference: entry.reference, cleanup });
        }
        assertCurrent();
        if (productionBuildRunActivity(layout.repositoryRoot, layout.runId,
            { includeArtifactRetention: false, includeSchedulerRetention: false, schedulerRecovery }))
        {
            throw new Error('production build resource recovery resource boundaries remain retained');
        }
        report.artifacts = cleanupPhysicalExecutionResourceArtifacts(owner.managedContainmentAuthorities, { validateAuthority: assertCurrent });
        if (productionBuildRunActivity(layout.repositoryRoot, layout.runId, { includeSchedulerRetention: false, schedulerRecovery }))
        {
            throw new Error('production build resource recovery artifacts remain retained');
        }
        report.retainedArtifacts = [];
        report.status = 'resources-released';
        if (schedulerRecovery !== null)
        {
            assertCurrent();
            completeSchedulerResourceRecovery(schedulerRecovery, { reference, schedulerOwner: owner.schedulerLockIdentity });
            assertCurrent();
            report.status = 'resources-and-grants-released';
        }
    }
    catch (error)
    {
        failure = error;
    }
    try
    {
        verifyCurrent({ skipSenderJournal: true });
        fs.unlinkSync(markerFile);
        syncDirectory();
    }
    catch (error)
    {
        if (failure)
        {
            failure.resourceRecoveryLockError = error.message;
        }
        else
        {
            failure = error;
        }
    }
    if (failure)
    {
        failure.resourceRecovery = report;
        throw failure;
    }
    return report;
}

/** Authenticate nested callers against the independently retained owner and actual service membership. */
export function authorizeProductionBuildNestedProcess(channel, identity)
{
    const context = channel.reference.context;
    const layout = resolveProductionBuildLayout({ root: context.root, runId: context.runId });
    assertCanonicalResourceOwnerLayout(layout);
    const { owner } = readBuildOwner(layout);
    if (owner.state !== 'building' || processIdentityStatus(owner.ownerIdentity).status !== 'live'
        || digestCanonical(owner.ownerIdentity) !== digestCanonical(channel.controllerIdentity)
        || !completeProcessIdentity(identity) || processIdentityStatus(identity).status !== 'live')
    {
        throw new Error('nested execution requires its live original build owner and caller');
    }
    for (const authority of owner.managedContainmentAuthorities)
    {
        if (authority.schema !== resourceServiceContainmentSchema || authority.phase !== 'pre-exec'
            || digestCanonical(authority.nestedChannel) !== digestCanonical(channel)
            || digestCanonical(authority.serviceBinding.reference) !== digestCanonical(channel.reference))
        {
            continue;
        }
        const observed = inspectProductionSystemdServiceBinding(authority.serviceBinding, { commandBudgetMs: authority.commandBudgetMs });
        if (observed.status === 'present' && observed.group.processIds.includes(identity.pid)
            && processIdentityStatus(identity).status === 'live')
        {
            const current = readBuildOwner(layout).owner;
            if (current.state !== 'building'
                || digestCanonical(current.ownerIdentity) !== digestCanonical(owner.ownerIdentity)
                || current.sourceCommit !== owner.sourceCommit || current.worktreeFingerprint !== owner.worktreeFingerprint
                || current.namespace !== owner.namespace
                || !current.managedContainmentAuthorities.some((entry) => digestCanonical(entry) === digestCanonical(authority))
                || processIdentityStatus(identity).status !== 'live')
            {
                throw new Error('nested execution build owner changed during authentication');
            }
            return { authorityId: authority.authorityId, identity };
        }
    }
    throw new Error('nested execution caller is not a member of an independently retained service');
}

/** Read the same original prepared intent for custody cleanup; this issues no execution grant. */
export function assertProductionBuildRetainedNativeInputIntent(carrier, authority)
{
    const context = carrier?.reference?.context;
    const layout = resolveProductionBuildLayout({ root: context?.root, runId: context?.runId });
    assertCanonicalResourceOwnerLayout(layout);
    const { owner } = readBuildOwner(layout);
    if (owner.state !== 'building' || owner.ownerPid !== process.pid
        || processIdentityStatus(owner.ownerIdentity).status !== 'live'
        || digestCanonical(owner.ownerIdentity) !== digestCanonical(carrier.controllerIdentity)
        || owner.sourceCommit !== context.sourceState.commit || owner.worktreeFingerprint !== context.sourceState.worktreeFingerprint
        || owner.namespace !== context.namespace || !resourceServiceContainmentIsComplete(authority)
        || authority.phase !== 'prepared' || digestCanonical(authority.nativeInputCarrier) !== digestCanonical(carrier)
        || digestCanonical(authority.serviceBinding.reference) !== digestCanonical(carrier.reference))
        throw new Error('native input cleanup requires its original retained prepared owner');
    const retained = owner.managedContainmentAuthorities.find((entry) => entry.authorityId === authority.authorityId);
    if (digestCanonical(retained) !== digestCanonical(authority)
        || inspectProductionSystemdServiceBinding(authority.serviceBinding, { commandBudgetMs: authority.commandBudgetMs }).status !== 'absent')
        throw new Error('native input prepared cleanup differs from actual retained intent/absent service');
    const current = readBuildOwner(layout).owner;
    if (current.state !== 'building' || digestCanonical(current.ownerIdentity) !== digestCanonical(owner.ownerIdentity)
        || current.sourceCommit !== owner.sourceCommit || current.worktreeFingerprint !== owner.worktreeFingerprint
        || current.namespace !== owner.namespace || processIdentityStatus(current.ownerIdentity).status !== 'live'
        || !current.managedContainmentAuthorities.some((entry) => digestCanonical(entry) === digestCanonical(authority)))
        throw new Error('native input prepared cleanup owner changed during actual readback');
    return { authorityDigest: digestCanonical(authority) };
}

/** Authenticate the one exact durably registered preexec recipient, never an arbitrary nested member. */
export function authorizeProductionBuildNativeInputProcess(carrier, identity, authorityId)
{
    const context = carrier?.reference?.context;
    const layout = resolveProductionBuildLayout({ root: context?.root, runId: context?.runId });
    assertCanonicalResourceOwnerLayout(layout);
    const { owner } = readBuildOwner(layout);
    if (owner.state !== 'building' || processIdentityStatus(owner.ownerIdentity).status !== 'live'
        || digestCanonical(owner.ownerIdentity) !== digestCanonical(carrier.controllerIdentity)
        || owner.sourceCommit !== context.sourceState.commit || owner.worktreeFingerprint !== context.sourceState.worktreeFingerprint
        || owner.namespace !== context.namespace || !completeProcessIdentity(identity)
        || processIdentityStatus(identity).status !== 'live')
        throw new Error('native input receive requires its original live source/build owner');
    const authority = owner.managedContainmentAuthorities.find((entry) => entry.authorityId === authorityId);
    if (!authority || !resourceServiceContainmentIsComplete(authority) || authority.phase !== 'pre-exec'
        || digestCanonical(authority.nativeInputCarrier) !== digestCanonical(carrier)
        || digestCanonical(authority.supervisorProcessIdentity) !== digestCanonical(identity)
        || digestCanonical(authority.serviceBinding.reference) !== digestCanonical(carrier.reference))
        throw new Error('native input receiver is not the exact independently retained preexec process');
    const observed = inspectProductionSystemdServiceBinding(authority.serviceBinding, { commandBudgetMs: authority.commandBudgetMs });
    const current = readBuildOwner(layout).owner;
    if (observed.status !== 'present' || !observed.group.processIds.includes(identity.pid)
        || processIdentityStatus(identity).status !== 'live' || current.state !== 'building'
        || digestCanonical(current.ownerIdentity) !== digestCanonical(owner.ownerIdentity)
        || current.sourceCommit !== owner.sourceCommit || current.worktreeFingerprint !== owner.worktreeFingerprint
        || current.namespace !== owner.namespace
        || !current.managedContainmentAuthorities.some((entry) => digestCanonical(entry) === digestCanonical(authority)))
        throw new Error('native input actual retained receiver/build owner changed during authorization');
    return { authorityId, identity };
}

export function assertSafeProductionBuildRunRoot(candidate, { root = defaultRoot } = {})
{
    const repositoryRoot = path.resolve(root);
    const buildBase = path.resolve(repositoryRoot, '.tmp/build');
    const resolved = path.resolve(candidate);
    if (
        resolved === buildBase ||
        resolved === repositoryRoot ||
        resolved === path.parse(resolved).root ||
        path.dirname(resolved) !== buildBase ||
        !resolved.startsWith(`${buildBase}${path.sep}`)
    )
    {
        throw new Error(`refusing unsafe production build root: ${candidate}`);
    }
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink())
    {
        throw new Error(`refusing symlink production build root: ${candidate}`);
    }
    validateProductionRunId(path.basename(resolved));
    return resolved;
}

function productionBuildRootIdentity(directory)
{
    const metadata = fs.lstatSync(directory);
    const fileDigest = (file) =>
        fs.existsSync(file) ? `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}` : null;
    return {
        schema: 'fsusblog.production-build-gc-owner.v1',
        device: String(metadata.dev),
        inode: String(metadata.ino),
        manifestDigest: fileDigest(path.join(directory, 'layout.json')),
        activeOwnerDigest: fileDigest(path.join(directory, '.active.json'))
    };
}

function productionBuildRootIdentityMatches(expected, actual)
{
    return Boolean(
        expected &&
            actual &&
            expected.schema === actual.schema &&
            expected.device === actual.device &&
            expected.inode === actual.inode &&
            expected.manifestDigest === actual.manifestDigest &&
            expected.activeOwnerDigest === actual.activeOwnerDigest
    );
}

function reclaimExactProductionBuildRoot(
    directory,
    expectedIdentity,
    { beforeDelete = null, remove = (target) => fs.rmSync(target, { recursive: true, force: true }) } = {}
)
{
    const markerFile = path.join(directory, '.reclaim.json');
    const reclaimToken = randomUUID();
    try
    {
        fs.writeFileSync(
            markerFile,
            `${JSON.stringify({
                schema: 'fsusblog.production-build-gc-reclaim.v1',
                reclaimToken,
                expectedIdentity
            })}\n`,
            { mode: 0o600, flag: 'wx' }
        );
    }
    catch (error)
    {
        if (['EEXIST', 'ENOENT'].includes(error?.code))
        {
            return false;
        }
        throw error;
    }
    beforeDelete?.({ directory, markerFile, expectedIdentity });
    let actualIdentity;
    try
    {
        actualIdentity = productionBuildRootIdentity(directory);
    }
    catch (error)
    {
        if (error?.code === 'ENOENT')
        {
            return false;
        }
        throw error;
    }
    if (!productionBuildRootIdentityMatches(expectedIdentity, actualIdentity))
    {
        return false;
    }
    const tombstone = `${directory}.reclaimed-${reclaimToken}`;
    try
    {
        fs.renameSync(directory, tombstone);
    }
    catch (error)
    {
        if (error?.code === 'ENOENT')
        {
            return false;
        }
        throw error;
    }
    remove(tombstone);
    return true;
}

export function prepareProductionBuildLayout(options = {})
{
    const layout = resolveProductionBuildLayout(options);
    const sourceState = options.sourceState ?? {
        commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? 'unversioned',
        worktreeFingerprint:
            process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ??
            `sha256:${createHash('sha256').update(layout.repositoryRoot).digest('hex')}`
    };
    const namespace = options.namespace ?? `production-build:${layout.runId}`;
    assertSafeProductionBuildRunRoot(layout.runRoot, { root: layout.repositoryRoot });
    const fresh = options.fresh !== false;
    if (fresh && fs.existsSync(layout.runRoot))
    {
        const expectedIdentity = productionBuildRootIdentity(layout.runRoot);
        if (productionBuildRunIsActive(layout.repositoryRoot, layout.runId))
        {
            throw new Error(`production build run is already active: ${layout.runId}`);
        }
        if (!reclaimExactProductionBuildRoot(layout.runRoot, expectedIdentity))
        {
            throw new Error(`production build run changed while it was being reclaimed: ${layout.runId}`);
        }
    }
    fs.mkdirSync(layout.runRoot, { recursive: true });
    for (const directory of [layout.frontendCache, layout.wasmArtifacts, layout.generatedRoot])
    {
        fs.mkdirSync(directory, { recursive: true });
    }
    const artifacts = productionDotnetArtifacts(layout);
    const projects = [artifacts.server, artifacts.tests, artifacts.migrationTests, artifacts.xunitAdapter, artifacts.benchmark];
    if (new Set(projects.map((entry) => entry.projectExtensionsPath)).size !== projects.length)
    {
        throw new Error('production MSBuild project extension paths are not isolated');
    }
    const owner = buildOwner(layout, {
        sourceState,
        namespace,
        allowDiagnosticProcessContainmentForTests: options.allowDiagnosticProcessContainmentForTests
    });
    const manifest = {
        schema: productionBuildLayoutSchema,
        status: 'active',
        runId: layout.runId,
        sourceState: {
            commit: owner.sourceCommit,
            worktreeFingerprint: owner.worktreeFingerprint
        },
        paths: {
            runRoot: relative(layout.repositoryRoot, layout.runRoot),
            frontendDist: relative(layout.repositoryRoot, layout.frontendDist),
            frontendWasm: relative(layout.repositoryRoot, layout.frontendWasm),
            backendWebRoot: relative(layout.repositoryRoot, layout.backendWebRoot),
            runtimeFrontendDist: relative(layout.repositoryRoot, layout.runtimeFrontendDist),
            runtimeBackendWebRoot: relative(layout.repositoryRoot, layout.runtimeBackendWebRoot),
            generatedRoot: relative(layout.repositoryRoot, layout.generatedRoot)
        },
        projects: Object.fromEntries(
            projects.map((entry) => [
                entry.name,
                {
                    projectFile: entry.projectFile,
                    baseOutputPath: relative(layout.repositoryRoot, entry.baseOutputPath),
                    baseIntermediateOutputPath: relative(layout.repositoryRoot, entry.baseIntermediateOutputPath),
                    projectExtensionsPath: relative(layout.repositoryRoot, entry.projectExtensionsPath)
                }
            ])
        ),
        owner,
        contentDigest: null,
        createdAt: owner.createdAt
    };
    if (!fresh && fs.existsSync(layout.manifestFile))
    {
        const existing = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
        if (existing.schema !== productionBuildLayoutSchema || existing.runId !== layout.runId)
        {
            throw new Error(`production build layout identity mismatch: ${layout.manifestFile}`);
        }
        atomicWriteJson(layout.manifestFile, {
            ...existing,
            status: 'active',
            owner,
            resumedAt: new Date().toISOString()
        });
    }
    else
    {
        atomicWriteJson(layout.manifestFile, manifest);
    }
    atomicWriteJson(layout.activeFile, {
        schema: 'fsusblog.production-build-owner.v1',
        runId: layout.runId,
        owner
    });
    return { ...layout, manifest: JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8')), artifacts };
}

export const productionBuildEnvironmentKeys = Object.freeze([
    'FSUSBLOG_PRODUCTION_BUILD_ROOT',
    'FSUSBLOG_FRONTEND_DIST_ROOT',
    'FSUSBLOG_FRONTEND_CACHE_ROOT',
    'FSUSBLOG_FRONTEND_WASM_ROOT',
    'FSUSBLOG_WASM_ARTIFACT_ROOT',
    'FSUSBLOG_BACKEND_WEBROOT',
    'FSUSBLOG_PUBLIC_AOT_SSR_CLIENT_ROOT',
    'FSUSBLOG_PUBLIC_AOT_SSR_WORKER_SCRIPT',
    'FSUSBLOG_WEB_ROOT',
    'FSUSBLOG_RETENTION_WEBROOT_DIR',
    'ASPNETCORE_WEBROOT',
    'FSUSBLOG_GENERATED_OUTPUT_ROOT',
    'FSUSBLOG_ARTIFACT_DIGEST_TABLE',
    'FSUSBLOG_ZK_PRODUCTION_ENABLED',
    'FSUSBLOG_BACKEND_SERVER_DLL',
    'FSUSBLOG_BACKEND_TEST_DLL',
    'FSUSBLOG_BACKEND_TEST_BIN_DIR',
    'FSUSBLOG_BACKEND_TEST_OBJ_DIR',
    'FSUSBLOG_BENCHMARK_DLL'
]);

export function productionBuildEnvironment(layout, env = process.env)
{
    const artifacts = productionDotnetArtifacts(layout);
    const nodeOptions = String(env.NODE_OPTIONS ?? '').trim();
    return {
        ...env,
        ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
        FSUSBLOG_PRODUCTION_BUILD_ROOT: layout.runRoot,
        FSUSBLOG_FRONTEND_DIST_ROOT: layout.frontendDist,
        FSUSBLOG_FRONTEND_CACHE_ROOT: layout.frontendCache,
        FSUSBLOG_FRONTEND_WASM_ROOT: layout.frontendWasm,
        FSUSBLOG_WASM_ARTIFACT_ROOT: layout.wasmArtifacts,
        FSUSBLOG_BACKEND_WEBROOT: layout.backendWebRoot,
        FSUSBLOG_PUBLIC_AOT_SSR_CLIENT_ROOT: layout.frontendSsrRuntime,
        FSUSBLOG_PUBLIC_AOT_SSR_WORKER_SCRIPT: './server/server-public-ssr.bundle.mjs',
        FSUSBLOG_WEB_ROOT: layout.backendWebRoot,
        FSUSBLOG_RETENTION_WEBROOT_DIR: layout.backendWebRoot,
        ASPNETCORE_WEBROOT: layout.backendWebRoot,
        FSUSBLOG_GENERATED_OUTPUT_ROOT: layout.generatedRoot,
        FSUSBLOG_ARTIFACT_DIGEST_TABLE: path.join(layout.generatedRoot, 'artifact-digest-table.json'),
        FSUSBLOG_ZK_PRODUCTION_ENABLED: env.FSUSBLOG_ZK_PRODUCTION_ENABLED ?? '0',
        FSUSBLOG_BACKEND_SERVER_DLL: artifacts.serverDll,
        FSUSBLOG_BACKEND_TEST_DLL: artifacts.testDll,
        FSUSBLOG_BACKEND_TEST_BIN_DIR: artifacts.tests.outputDirectory,
        FSUSBLOG_BACKEND_TEST_OBJ_DIR: artifacts.tests.baseIntermediateOutputPath,
        FSUSBLOG_BENCHMARK_DLL: artifacts.benchmarkDll
    };
}

export function productionBuildEnvironmentAssignments({ root = defaultRoot, runId, env = process.env } = {})
{
    const repositoryRoot = fs.realpathSync(path.resolve(root));
    if (!fs.statSync(repositoryRoot).isDirectory())
    {
        throw new Error('production build environment root must be a directory');
    }
    const layout = resolveProductionBuildLayout({ root: repositoryRoot, runId });
    const environment = productionBuildEnvironment(layout, env);
    return productionBuildEnvironmentKeys.map((key) =>
    {
        const value = environment[key];
        if (typeof value !== 'string' || value.includes('\0'))
        {
            throw new Error(`production build environment value is invalid: ${key}`);
        }
        return [key, value];
    });
}

export function productionRuntimeEnvironment(layout, env = process.env)
{
    return {
        ...env,
        FSUSBLOG_FRONTEND_DIST_ROOT: layout.runtimeFrontendDist,
        FSUSBLOG_BACKEND_WEBROOT: layout.runtimeBackendWebRoot,
        FSUSBLOG_WEB_ROOT: layout.runtimeBackendWebRoot,
        FSUSBLOG_RETENTION_WEBROOT_DIR: layout.runtimeBackendWebRoot,
        ASPNETCORE_WEBROOT: layout.runtimeBackendWebRoot
    };
}

function assertRuntimeLayoutPath(layout, candidate, label)
{
    const runRoot = assertSafeProductionBuildRunRoot(layout.runRoot, { root: layout.repositoryRoot });
    const resolved = path.resolve(candidate);
    if (resolved === runRoot || !resolved.startsWith(`${runRoot}${path.sep}`))
    {
        throw new Error(`production runtime ${label} escapes the run root: ${candidate}`);
    }
    return resolved;
}

export function prepareProductionRuntimeLayout(layout)
{
    const runtimeRoot = assertRuntimeLayoutPath(layout, layout.runtimeRoot, 'root');
    const runtimeFrontendDist = assertRuntimeLayoutPath(layout, layout.runtimeFrontendDist, 'frontend dist');
    const runtimeBackendWebRoot = assertRuntimeLayoutPath(layout, layout.runtimeBackendWebRoot, 'backend webroot');
    for (const [label, source] of [
        ['frontend dist', layout.frontendDist],
        ['backend webroot', layout.backendWebRoot]
    ])
    {
        const resolved = assertRuntimeLayoutPath(layout, source, `immutable ${label}`);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
        {
            throw new Error(`production runtime immutable ${label} is missing: ${source}`);
        }
    }
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(runtimeFrontendDist), { recursive: true });
    fs.mkdirSync(path.dirname(runtimeBackendWebRoot), { recursive: true });
    fs.cpSync(layout.frontendDist, runtimeFrontendDist, {
        recursive: true,
        force: true,
        preserveTimestamps: true
    });
    fs.cpSync(layout.backendWebRoot, runtimeBackendWebRoot, {
        recursive: true,
        force: true,
        preserveTimestamps: true
    });
    return {
        runtimeRoot,
        runtimeFrontendDist,
        runtimeBackendWebRoot
    };
}

export function bindProductionBuildLayoutSource(layout, sourceState)
{
    assertSafeProductionBuildRunRoot(layout.runRoot, { root: layout.repositoryRoot });
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
    if (
        manifest.schema !== productionBuildLayoutSchema ||
        manifest.runId !== layout.runId ||
        manifest.status !== 'active'
    )
    {
        throw new Error(`production build layout cannot bind source identity: ${layout.manifestFile}`);
    }
    const commit = String(sourceState?.commit ?? '').trim();
    const worktreeFingerprint = String(sourceState?.worktreeFingerprint ?? '').trim();
    if (!commit || !worktreeFingerprint)
    {
        throw new Error('production build layout requires complete source identity');
    }
    const existingCommit = String(manifest.sourceState?.commit ?? '').trim();
    const existingWorktreeFingerprint = String(manifest.sourceState?.worktreeFingerprint ?? '').trim();
    if (existingCommit !== commit || existingWorktreeFingerprint !== worktreeFingerprint)
    {
        throw new Error('production build layout source identity is immutable after binding');
    }
    const lockOwnerFile = path.join(
        layout.repositoryRoot,
        '.tmp/test-runs/.locks',
        `${layout.runId}.lock`,
        'owner.json'
    );
    const runsRoot = path.join(layout.repositoryRoot, '.tmp/test-runs');
    let schedulerOwner;
    try
    {
        schedulerOwner = JSON.parse(fs.readFileSync(lockOwnerFile, 'utf8'));
    }
    catch
    {
        throw new Error('production build scheduler lock owner is required before building');
    }
    const candidateIdentityDigest = schedulerCandidateIdentityDigest({
        runId: layout.runId,
        targetTierId: schedulerOwner.targetTierId,
        namespace: manifest.owner.namespace,
        sourceState: { commit, worktreeFingerprint },
        budgetPolicyDigest: schedulerOwner.budgetPolicyDigest ?? null
    });
    const schedulerActivity = schedulerRunLockActivity({
        runsRoot,
        runId: layout.runId,
        candidateIdentityDigest,
        targetTierId: schedulerOwner.targetTierId
    });
    if (
        schedulerActivity.status !== 'active' ||
        schedulerActivity.owner?.contentDigest !== schedulerOwner.contentDigest ||
        !schedulerRunOwnerIsComplete(schedulerOwner) ||
        schedulerOwner.runId !== layout.runId ||
        schedulerOwner.candidateIdentityDigest !== candidateIdentityDigest ||
        schedulerOwner.pid !== manifest.owner.ownerPid ||
        schedulerOwner.processStartIdentity !== manifest.owner.ownerProcessStartIdentity ||
        schedulerOwner.executableDigest !== manifest.owner.ownerExecutableDigest ||
        schedulerOwner.commandDigest !== manifest.owner.ownerCommandDigest ||
        !schedulerOwner.ownerToken
    )
    {
        throw new Error('production build manifest and scheduler lock do not exact-match');
    }
    const schedulerLockIdentity = {
        ...schedulerOwner
    };
    const bound = {
        ...manifest,
        sourceState: { commit, worktreeFingerprint },
        owner: {
            ...manifest.owner,
            sourceCommit: commit,
            worktreeFingerprint,
            schedulerLockIdentity,
            state: 'building',
            heartbeatAt: new Date().toISOString()
        }
    };
    bound.owner.processTreeReceipt = processTreeReceipt(bound.owner);
    atomicWriteJson(layout.manifestFile, bound);
    atomicWriteJson(layout.activeFile, {
        schema: 'fsusblog.production-build-owner.v1',
        runId: layout.runId,
        owner: bound.owner
    });
    return bound;
}

export function productionBuildRunIsActive(root, runId)
{
    return productionBuildRunActivity(root, runId);
}

function productionBuildRunActivity(root, runId, {
    includeArtifactRetention = true, includeSchedulerRetention = true, schedulerRecovery = null
} = {})
{
    const safeRunId = validateProductionRunId(runId);
    const layout = resolveProductionBuildLayout({ root, runId: safeRunId });
    const runRootExists = fs.existsSync(layout.runRoot);
    const activeExists = fs.existsSync(layout.activeFile);
    const manifestExists = fs.existsSync(layout.manifestFile);
    if (!activeExists && !manifestExists)
    {
        if (runRootExists)
        {
            throw new Error(`production build owner identity is missing: ${safeRunId}`);
        }
        return false;
    }
    if (!activeExists && manifestExists)
    {
        const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
        if (
            manifest.schema === productionBuildLayoutSchema &&
            manifest.runId === safeRunId &&
            ['complete', 'failed', 'cancelled'].includes(manifest.owner?.state)
        )
        {
            verifyProductionBuildRootIntegrity(layout);
            return resourceBoundariesRetained(layout, manifest.owner, { includeArtifactRetention, includeSchedulerRetention });
        }
    }
    if (!activeExists || !manifestExists)
    {
        throw new Error(`production build owner identity is missing: ${safeRunId}`);
    }
    const { owner } = readBuildOwner(layout);
    const retainedResources = resourceBoundariesRetained(layout, owner, { includeArtifactRetention, includeSchedulerRetention });
    if (owner.processIdentityFailure)
    {
        throw new Error(`production build process identity failure: ${owner.processIdentityFailure}`);
    }
    const ownerStatus = processIdentityStatus(owner.ownerIdentity);
    if (ownerStatus.status === 'unverifiable')
    {
        throw new Error(`production build owner-unverifiable: ${ownerStatus.actual?.reason ?? 'identity unavailable'}`);
    }
    if (ownerStatus.status === 'live' && owner.processGroupOrJobIdentity)
    {
        const group = collectProcessGroupOrJobIdentity(owner.ownerIdentity.pid);
        if (
            group.status !== 'verified' ||
            !processGroupOrJobIdentityMatches(group.value, owner.processGroupOrJobIdentity)
        )
        {
            throw new Error('production build process group or Job Object identity mismatch');
        }
    }
    const compilerStatuses = owner.activeCompilerProcessIdentities.map((identity) => processIdentityStatus(identity));
    if (compilerStatuses.some((status) => status.status === 'unverifiable'))
    {
        throw new Error('production build compiler identity is unverifiable');
    }
    const descendants =
        ownerStatus.status === 'live' && owner.ownerPlatform !== 'win32'
            ? processDescendantIdentities(owner.ownerIdentity)
            : { status: 'verified', identities: [] };
    if (descendants.status === 'unverifiable')
    {
        throw new Error(`production build descendant identity is unverifiable: ${descendants.reason}`);
    }
    const runsRoot = path.join(path.resolve(root), '.tmp/test-runs');
    const schedulerLockPath = path.join(runsRoot, '.locks', `${safeRunId}.lock`);
    if (fs.existsSync(schedulerLockPath))
    {
        const stored = owner.schedulerLockIdentity;
        const schedulerActivity = schedulerRunLockActivity({
            runsRoot,
            runId: safeRunId,
            targetTierId: stored?.targetTierId,
            candidateIdentityDigest: stored?.targetTierId
                ? schedulerCandidateIdentityDigest({
                    runId: safeRunId,
                    targetTierId: stored.targetTierId,
                    namespace: owner.namespace,
                    sourceState: {
                        commit: owner.sourceCommit,
                        worktreeFingerprint: owner.worktreeFingerprint
                    },
                    budgetPolicyDigest: stored.budgetPolicyDigest ?? null
                })
                : null
        });
        if (schedulerActivity.status === 'unverifiable')
        {
            throw new Error(`production build scheduler owner-unverifiable: ${schedulerActivity.reason}`);
        }
        if (schedulerRecovery !== null)
        {
            assertSchedulerResourceRecovery(schedulerRecovery, {
                reference: capacityOwnerReference(layout, owner), schedulerOwner: stored
            });
        }
        else if (
            !stored ||
            !schedulerActivity.owner ||
            !schedulerRunOwnerIdentityMatches(stored, schedulerActivity.owner)
        )
        {
            throw new Error('production build manifest and scheduler owner do not exact-match');
        }
    }
    if (owner.state !== 'preparing' && !owner.schedulerLockIdentity)
    {
        throw new Error('production build process-tree receipt is missing scheduler lock identity');
    }
    const groupMemberStatuses = [];
    for (const managedGroup of owner.managedProcessGroupIdentities)
    {
        const members = processGroupMemberIdentities(managedGroup);
        if (members.status !== 'verified')
        {
            throw new Error(`production build managed group is unverifiable: ${members.reason}`);
        }
        groupMemberStatuses.push(...members.identities.map((identity) => processIdentityStatus(identity)));
    }
    const containmentStatuses = owner.managedContainmentAuthorities.map(containmentAuthorityStatus);
    const unverifiableContainment = containmentStatuses.find((status) => status.status === 'unverifiable');
    if (unverifiableContainment)
    {
        throw new Error(`production build containment authority is unverifiable: ${unverifiableContainment.reason}`);
    }
    const descendantStatuses =
        descendants.status === 'verified'
            ? descendants.identities.map((identity) => processIdentityStatus(identity))
            : [];
    return (
        retainedResources || ownerStatus.status === 'live' ||
        compilerStatuses.some((status) => status.status === 'live') ||
        descendantStatuses.some((status) => status.status === 'live') ||
        groupMemberStatuses.some((status) => status.status === 'live') ||
        containmentStatuses.some((status) => status.status === 'active')
    );
}

function persistBuildOwner(layout, manifest, owner)
{
    owner.processTreeReceipt = processTreeReceipt(owner);
    const next = { ...manifest, owner };
    atomicWriteJson(layout.manifestFile, next);
    atomicWriteJson(layout.activeFile, { schema: 'fsusblog.production-build-owner.v1', runId: layout.runId, owner });
    return next;
}

function addManagedIdentity(owner, identity)
{
    if (
        owner.activeCompilerProcessIdentities.some(
            (entry) => entry.processStartIdentity === identity.processStartIdentity
        )
    )
    {
        return false;
    }
    owner.activeCompilerProcessIdentities.push(identity);
    return true;
}

function addManagedGroup(owner, group)
{
    if (owner.managedProcessGroupIdentities.some((entry) => processGroupOrJobIdentityMatches(entry, group)))
    {
        return false;
    }
    owner.managedProcessGroupIdentities.push(group);
    return true;
}

function containmentAuthorityReceipt(authority, supervisorProcessIdentity)
{
    if (authority?.schema === resourceServiceContainmentSchema)
    {
        if (!resourceServiceContainmentIsComplete(authority) || authority.phase !== 'pre-exec'
            || digestCanonical(authority.supervisorProcessIdentity) !== digestCanonical(supervisorProcessIdentity))
        {
            throw new Error('production build resource service admission differs from its exact pre-exec identity');
        }
        return structuredClone(authority);
    }
    const common = {
        schema: authority?.schema,
        platform: authority?.platform,
        kind: authority?.kind,
        authorityId: authority?.authorityId,
        killPolicy: authority?.killPolicy,
        supervisorProcessIdentity,
        createdAt: authority?.createdAt
    };
    let receipt = common;
    if (authority?.kind === 'systemd-transient-service')
    {
        receipt = { ...common, unitName: authority.unitName };
    }
    else if (authority?.kind === 'windows-job-object')
    {
        receipt = {
            ...common,
            jobName: authority.jobName,
            supervisorScriptDigest: authority.supervisorScriptDigest
        };
    }
    else if (authority?.kind === 'darwin-process-group')
    {
        receipt = {
            ...common,
            groupId: supervisorProcessIdentity.pid,
            leaderPid: supervisorProcessIdentity.pid,
            leaderProcessStartIdentity: supervisorProcessIdentity.processStartIdentity
        };
    }
    if (!completeContainmentAuthority(receipt))
    {
        throw new Error('production build durable containment authority is incomplete');
    }
    return receipt;
}

function addContainmentAuthority(owner, authority)
{
    if (owner.managedContainmentAuthorities.some((entry) => entry.authorityId === authority.authorityId))
    {
        return false;
    }
    owner.managedContainmentAuthorities.push(authority);
    return true;
}

function containmentAuthorityStatus(authority)
{
    if (!completeContainmentAuthority(authority))
    {
        return { status: 'unverifiable', reason: 'containment authority receipt is incomplete' };
    }
    if (authority.schema === resourceServiceContainmentSchema)
    {
        try
        {
            const observed = inspectProductionSystemdServiceBinding(authority.serviceBinding, {
                commandBudgetMs: authority.commandBudgetMs
            });
            return { status: observed.status === 'absent' ? 'inactive' : 'active', observation: observed };
        }
        catch (error)
        {
            return { status: 'unverifiable', reason: error.message };
        }
    }
    if (authority.kind === 'systemd-transient-service')
    {
        const result = spawnSync(
            'systemctl',
            ['--user', 'show', authority.unitName, '--property=LoadState', '--property=ActiveState', '--value'],
            { encoding: 'utf8', windowsHide: true }
        );
        if (result.error || result.status !== 0)
        {
            return {
                status: 'unverifiable',
                reason: result.error?.message ?? String(result.stderr || `systemctl exited ${result.status}`).trim()
            };
        }
        const [loadState, activeState] = String(result.stdout).trim().split(/\r?\n/u);
        if (!loadState || !activeState)
        {
            return { status: 'unverifiable', reason: 'systemd authority state is incomplete' };
        }
        if (['active', 'activating', 'deactivating', 'reloading'].includes(activeState))
        {
            return { status: 'active', loadState, activeState };
        }
        if (['inactive', 'failed'].includes(activeState))
        {
            return { status: 'inactive', loadState, activeState };
        }
        return { status: 'unverifiable', reason: `unknown systemd ActiveState ${activeState}` };
    }
    if (authority.kind === 'windows-job-object')
    {
        const supervisor = processIdentityStatus(authority.supervisorProcessIdentity);
        if (supervisor.status === 'live')
        {
            return { status: 'active' };
        }
        if (['dead', 'mismatch'].includes(supervisor.status))
        {
            return { status: 'inactive' };
        }
        return {
            status: 'unverifiable',
            reason: supervisor.actual?.reason ?? 'Windows Job Object supervisor identity is unavailable'
        };
    }
    if (authority.kind === 'darwin-process-group')
    {
        const members = processGroupMemberIdentities({
            schema: 'fsusblog.process-group-or-job-identity.v1',
            platform: 'darwin',
            kind: 'process-group',
            groupId: authority.groupId,
            leaderPid: authority.leaderPid,
            leaderProcessStartIdentity: authority.leaderProcessStartIdentity
        });
        if (members.status !== 'verified')
        {
            return { status: 'unverifiable', reason: members.reason };
        }
        return members.identities.length > 0 ? { status: 'active' } : { status: 'inactive' };
    }
    return { status: 'unverifiable', reason: `unsupported containment authority ${authority.kind}` };
}

export function scanProductionBuildProcesses(layout)
{
    const { manifest, owner } = readBuildOwner(layout);
    if (owner.state !== 'building')
    {
        return manifest;
    }
    if (owner.ownerPlatform === 'win32')
    {
        return manifest;
    }
    let changed = false;
    const roots = [...owner.activeCompilerProcessIdentities];
    for (const identity of roots)
    {
        const status = processIdentityStatus(identity);
        if (status.status === 'unverifiable')
        {
            throw new Error(`managed compiler identity is unverifiable: ${status.actual?.reason}`);
        }
        if (status.status !== 'live')
        {
            continue;
        }
        const descendants = processDescendantIdentities(identity);
        if (descendants.status !== 'verified')
        {
            throw new Error(`managed compiler descendants are unverifiable: ${descendants.reason}`);
        }
        for (const descendant of descendants.identities)
        {
            changed = addManagedIdentity(owner, descendant) || changed;
            let containedByKnownGroup = false;
            for (const knownGroup of owner.managedProcessGroupIdentities)
            {
                const knownMembers = processGroupMemberIdentities(knownGroup);
                if (knownMembers.status !== 'verified')
                {
                    throw new Error(`managed compiler group is unverifiable: ${knownMembers.reason}`);
                }
                containedByKnownGroup ||= knownMembers.identities.some(
                    (member) =>
                        member.pid === descendant.pid && member.processStartIdentity === descendant.processStartIdentity
                );
            }
            if (containedByKnownGroup)
            {
                continue;
            }
            const group = collectProcessGroupOrJobIdentity(descendant.pid);
            if (group.status === 'dead')
            {
                continue;
            }
            if (group.status !== 'verified')
            {
                throw new Error(`managed compiler group is unverifiable: ${group.reason}`);
            }
            changed = addManagedGroup(owner, group.value) || changed;
        }
    }
    for (const group of owner.managedProcessGroupIdentities)
    {
        const members = processGroupMemberIdentities(group);
        if (members.status !== 'verified')
        {
            throw new Error(`managed process group is unverifiable: ${members.reason}`);
        }
        for (const member of members.identities)
        {
            changed = addManagedIdentity(owner, member) || changed;
        }
    }
    if (!changed)
    {
        return manifest;
    }
    owner.heartbeatAt = new Date().toISOString();
    return persistBuildOwner(layout, manifest, owner);
}

function startBuildOwnerMonitor(layout)
{
    if (buildOwnerMonitors.has(layout.manifestFile))
    {
        return;
    }
    const timer = setInterval(() =>
    {
        try
        {
            scanProductionBuildProcesses(layout);
        }
        catch (error)
        {
            try
            {
                const { manifest, owner } = readBuildOwner(layout);
                owner.processIdentityFailure = error instanceof Error ? error.message : String(error);
                owner.heartbeatAt = new Date().toISOString();
                persistBuildOwner(layout, manifest, owner);
            }
            catch
            {
                // The original process-scan failure remains the monitor authority.
            }
        }
    }, 25);
    timer.unref?.();
    buildOwnerMonitors.set(layout.manifestFile, timer);
}

function stopBuildOwnerMonitor(layout)
{
    const timer = buildOwnerMonitors.get(layout.manifestFile);
    if (timer)
    {
        clearInterval(timer);
    }
    buildOwnerMonitors.delete(layout.manifestFile);
}

function assertCanonicalResourceOwnerLayout(layout)
{
    const expected = resolveProductionBuildLayout({ root: layout.repositoryRoot, runId: layout.runId });
    if (['runRoot', 'manifestFile', 'activeFile'].some((key) => layout[key] !== expected[key]))
    {
        throw new Error('production build resource retention requires the canonical owner record paths');
    }
    assertSafeProductionBuildRunRoot(layout.runRoot, { root: layout.repositoryRoot });
}

function assertServiceControlCarrier(authority)
{
    const carrier = authority.controlRoot;
    const stat = fs.lstatSync(carrier.path);
    const intent = { ...authority, phase: 'prepared', creationSender: null, supervisorProcessIdentity: null,
        serviceBinding: { ...authority.serviceBinding, identity: null } };
    delete intent.residentTransfer;
    const binding = intent.serviceBinding;
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(carrier.path) !== carrier.path
        || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
        || stat.dev !== carrier.device || stat.ino !== carrier.inode
        || digestCanonical(readBuildRecord(path.join(carrier.path, 'resource-boundary.json'))) !== digestCanonical({
            authorityId: intent.authorityId, unitName: binding.unitName, sliceUnitName: binding.parent.unitName,
            description: binding.description, reference: binding.reference, containmentAuthority: intent
        }))
    {
        throw new Error('production build service intent differs from its exact private control carrier');
    }
}

function assertServiceCreationSenderBinding(authority, creationSender, { requireLive = false, retainedPlan = null } = {})
{
    const plan = retainedPlan ?? readBuildRecord(path.join(authority.controlRoot.path, 'sender-plan.json'));
    const unitName = authority.serviceBinding.unitName.slice(0, -'.service'.length);
    const output = authority.residentOutput ?? null;
    const requiredArgs = [
        '--user', ...(output ? ['--no-block'] : ['--wait', '--pipe']), '--collect', '--service-type=exec',
        '--property=KillMode=control-group', '--property=ExitType=cgroup',
        `--property=Slice=${authority.serviceBinding.parent.unitName}`,
        `--property=Description=${authority.serviceBinding.description}`,
        ...(output ? [`--property=StandardOutput=append:${output.files.stdout.path}`,
            `--property=StandardError=append:${output.files.stderr.path}`] : []),
        `--working-directory=${plan.cwd}`,
        `--unit=${unitName}`
    ];
    const exclusivePrefixes = ['--unit=', '--property=Slice=', '--property=Description=',
        '--property=KillMode=', '--property=ExitType=', '--property=StandardOutput=',
        '--property=StandardError=', '--working-directory='];
    const relativeCwd = typeof plan.cwd === 'string'
        ? path.relative(authority.serviceBinding.reference.context.root, plan.cwd) : '..';
    const bootstrapRelative = 'tools/test/physical-execution-linux-systemd-bootstrap.mjs';
    const expectedBootstraps = [defaultRoot, authority.serviceBinding.reference.context.root]
        .map((root) => path.join(root, bootstrapRelative));
    if (!systemdSenderReadyIsComplete(creationSender)
        || creationSender.authorityId !== authority.authorityId
        || digestCanonical(plan) !== creationSender.planDigest
        || plan.authorityId !== authority.authorityId
        || !Array.isArray(plan.args)
        || plan.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
        || requiredArgs.some((arg) => plan.args.filter((value) => value === arg).length !== 1)
        || exclusivePrefixes.some((prefix) => plan.args.filter((arg) => arg.startsWith(prefix)).length !== (output ? 1
            : ['--property=StandardOutput=', '--property=StandardError='].includes(prefix) ? 0 : 1))
        || (output ? plan.args.includes('--wait') || plan.args.includes('--pipe')
            : plan.args.includes('--no-block'))
        || path.isAbsolute(relativeCwd) || relativeCwd === '..' || relativeCwd.startsWith(`..${path.sep}`)
        || plan.args.at(-3) !== process.execPath
        || !expectedBootstraps.includes(plan.args.at(-2))
        || plan.args.at(-1) !== authority.controlRoot.path
        || (requireLive && processIdentityStatus(creationSender.processIdentity).status !== 'live'))
    {
        throw new Error('production build service creation sender is not an exact unit submission');
    }
    return plan;
}

function readSenderTerminalJournal(file, reference, authorities)
{
    const initial = { schema: senderTerminalJournalSchema, referenceDigest: digestCanonical(reference), terminals: [] };
    if (!fs.lstatSync(file, { throwIfNoEntry: false }))
    {
        return initial;
    }
    const journal = readBuildRecord(file);
    const expected = new Map(authorities.map((authority) => [authority.authorityId, authority]));
    const seen = new Set();
    if (!journal || Object.keys(journal).sort().join(',') !== 'referenceDigest,schema,terminals'
        || journal.schema !== senderTerminalJournalSchema
        || journal.referenceDigest !== initial.referenceDigest
        || !Array.isArray(journal.terminals))
    {
        throw new Error('production build sender terminal journal is foreign or incomplete');
    }
    for (const entry of journal.terminals)
    {
        const authority = expected.get(entry?.authorityId);
        if (!entry || Object.keys(entry).sort().join(',') !== 'authorityId,creationSenderDigest,plan,receipt'
            || seen.has(entry.authorityId) || !authority || authority.creationSender === null
            || entry.creationSenderDigest !== digestCanonical(authority.creationSender)
            || digestCanonical(entry.plan) !== authority.creationSender.planDigest
            || !verifySystemdSenderTerminal(entry.receipt, authority.creationSender))
        {
            throw new Error('production build sender terminal journal entry is foreign or invalid');
        }
        assertServiceCreationSenderBinding(authority, authority.creationSender, { retainedPlan: entry.plan });
        seen.add(entry.authorityId);
    }
    return journal;
}

function inspectServiceCreationSenderTerminal(authority, journalEntry = null)
{
    const creationSender = authority.creationSender;
    if (creationSender === null)
    {
        return { status: 'unresolved', reason: 'creation sender was not independently retained' };
    }
    let plan;
    try
    {
        plan = assertServiceCreationSenderBinding(authority, creationSender,
            journalEntry ? { retainedPlan: journalEntry.plan } : {});
    }
    catch (error)
    {
        if (error.code === 'ENOENT')
        {
            return { status: 'unresolved', reason: 'creation sender plan is absent without retained proof' };
        }
        throw error;
    }
    if (journalEntry)
    {
        const planFile = path.join(authority.controlRoot.path, 'sender-plan.json');
        if (fs.existsSync(planFile) && digestCanonical(readBuildRecord(planFile)) !== digestCanonical(plan))
        {
            throw new Error('production build sender plan differs from its retained recovery proof');
        }
    }
    const senderStatus = processIdentityStatus(creationSender.processIdentity).status;
    if (senderStatus !== 'dead')
    {
        return { status: 'unresolved', reason: `creation sender is ${senderStatus}` };
    }
    let receipt;
    try
    {
        const receiptFile = path.join(authority.controlRoot.path, 'sender-terminal.json');
        receipt = journalEntry ? journalEntry.receipt : readBuildRecord(receiptFile);
        if (journalEntry && fs.existsSync(receiptFile)
            && digestCanonical(readBuildRecord(receiptFile)) !== digestCanonical(receipt))
        {
            throw new Error('production build sender receipt differs from its retained recovery proof');
        }
    }
    catch (error)
    {
        if (error.code === 'ENOENT')
        {
            return { status: 'unresolved', reason: 'creation sender lacks a durable terminal receipt' };
        }
        throw error;
    }
    if (!verifySystemdSenderTerminal(receipt, creationSender))
    {
        throw new Error('production build creation sender terminal receipt is invalid or foreign');
    }
    if (receipt.submission === 'sender-returned' || receipt.submission === 'not-submitted')
    {
        if (receipt.submission === 'sender-returned' && receipt.exitCode !== 0)
        {
            return { status: 'unresolved', reason: 'submitted systemd-run did not complete normally', receipt };
        }
        // A current jobs snapshot is not a historical terminal receipt. The
        // signed sender result supplies that proof; this readback rejects a
        // concurrent manager job before resource release.
        const jobs = spawnSync('systemctl', ['--user', 'list-jobs', '--all', '--no-pager', '--no-legend', '--plain',
            authority.serviceBinding.unitName], { encoding: 'utf8', timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'] });
        if (jobs.status !== 0 || String(jobs.stdout).trim() !== '' || String(jobs.stderr).trim() !== '')
        {
            return { status: 'unresolved', reason: 'exact manager job is active or unverifiable', receipt };
        }
        return { status: 'terminal', submission: receipt.submission, plan, receipt };
    }
    return { status: 'unresolved', reason: 'creation sender submission state is unknown' };
}

/** Independently retain the resource creation binding before any systemd creation effects. */
export function retainProductionBuildResourceBoundary(layout, reference, { commandBudgetMs })
{
    assertCanonicalResourceOwnerLayout(layout);
    const { manifest, owner } = readBuildOwner(layout);
    const entry = structuredClone({ reference, commandBudgetMs });
    if (process.platform !== 'linux' || owner.ownerPlatform !== 'linux' || owner.state !== 'building'
        || owner.ownerPid !== process.pid || processIdentityStatus(owner.ownerIdentity).status !== 'live'
        || !completeResourceBoundary(layout, owner, entry))
    {
        throw new Error('production build resource retention requires its live building owner and exact context');
    }
    const binding = readProductionSystemdResourceBoundaryBinding(
        resourceBoundaryContext(layout, owner, reference.context.bundleId), { reference });
    if (JSON.stringify(canonicalize(binding.owner.controllerIdentity)) !== JSON.stringify(canonicalize(owner.ownerIdentity)))
    {
        throw new Error('production build resource controller differs from its retained process owner');
    }
    const previous = owner.managedResourceBoundaries.find((value) => value.reference.context.bundleId === reference.context.bundleId);
    if (previous)
    {
        if (JSON.stringify(canonicalize(previous)) !== JSON.stringify(canonicalize(entry)))
        {
            throw new Error('production build resource binding conflicts with a previously retained bundle');
        }
    }
    else
    {
        if (binding.state.phase !== 'prepared')
        {
            throw new Error('production build resource binding must be retained before creation');
        }
        owner.managedResourceBoundaries.push(entry);
        owner.heartbeatAt = new Date().toISOString();
        persistBuildOwner(layout, manifest, owner);
    }
    const retained = readBuildOwner(layout).owner.managedResourceBoundaries;
    if (!retained.some((value) => JSON.stringify(canonicalize(value)) === JSON.stringify(canonicalize(entry))))
    {
        throw new Error('production build resource binding did not survive durable read-back');
    }
    return { bindingDigest: reference.bindingDigest };
}

/** Retain a planned exact service before the process owner may create its unit. */
export function retainProductionBuildServiceContainment(layout, authority)
{
    assertCanonicalResourceOwnerLayout(layout);
    const { manifest, owner } = readBuildOwner(layout);
    if (owner.state !== 'building' || owner.ownerPid !== process.pid
        || processIdentityStatus(owner.ownerIdentity).status !== 'live'
        || !resourceServiceContainmentIsComplete(authority) || authority.phase !== 'prepared'
        || !owner.managedResourceBoundaries.some((entry) =>
            digestCanonical(entry.reference) === digestCanonical(authority.serviceBinding.reference)))
    {
        throw new Error('production build service intent requires its live owner and retained resource binding');
    }
    assertServiceControlCarrier(authority);
    const observed = inspectProductionSystemdServiceBinding(authority.serviceBinding, {
        commandBudgetMs: authority.commandBudgetMs
    });
    if (observed.status !== 'absent')
    {
        throw new Error('production build service intent must be retained before unit creation');
    }
    const previous = owner.managedContainmentAuthorities.find((entry) => entry.authorityId === authority.authorityId);
    if (previous && digestCanonical(previous) !== digestCanonical(authority))
    {
        throw new Error('production build service intent conflicts with retained authority');
    }
    if (!previous)
    {
        owner.managedContainmentAuthorities.push(structuredClone(authority));
        owner.heartbeatAt = new Date().toISOString();
        persistBuildOwner(layout, manifest, owner);
    }
    const retained = readBuildOwner(layout).owner.managedContainmentAuthorities.find((entry) => entry.authorityId === authority.authorityId);
    if (digestCanonical(retained) !== digestCanonical(authority))
    {
        throw new Error('production build service intent did not survive durable read-back');
    }
    return { authorityDigest: digestCanonical(retained) };
}

/** Durably distinguish a retained intent from a service whose creation may have been submitted. */
export function markProductionBuildServiceCreationAttempt(layout, authority, creationSender)
{
    assertCanonicalResourceOwnerLayout(layout);
    const { manifest, owner } = readBuildOwner(layout);
    if (owner.state !== 'building' || owner.ownerPid !== process.pid
        || processIdentityStatus(owner.ownerIdentity).status !== 'live'
        || !resourceServiceContainmentIsComplete(authority) || authority.phase !== 'prepared')
    {
        throw new Error('production build service creation attempt requires its live retained owner');
    }
    assertServiceControlCarrier(authority);
    const index = owner.managedContainmentAuthorities.findIndex((entry) => entry.authorityId === authority.authorityId);
    if (index < 0 || digestCanonical(owner.managedContainmentAuthorities[index]) !== digestCanonical(authority)
        || inspectProductionSystemdServiceBinding(authority.serviceBinding, {
            commandBudgetMs: authority.commandBudgetMs
        }).status !== 'absent')
    {
        throw new Error('production build service creation attempt differs from its exact unattempted intent');
    }
    assertServiceCreationSenderBinding(authority, creationSender, { requireLive: true });
    const attempted = { ...authority, phase: 'create-attempted', creationSender };
    owner.managedContainmentAuthorities[index] = attempted;
    owner.heartbeatAt = new Date().toISOString();
    persistBuildOwner(layout, manifest, owner);
    const retained = readBuildOwner(layout).owner.managedContainmentAuthorities[index];
    if (digestCanonical(retained) !== digestCanonical(attempted))
    {
        throw new Error('production build service creation attempt did not survive durable read-back');
    }
    return { authorityDigest: digestCanonical(retained) };
}

export function registerProductionBuildCompiler(layout, identity, containmentAuthority = null)
{
    const { manifest, owner } = readBuildOwner(layout);
    if (owner.state !== 'building' || processIdentityStatus(identity).status !== 'live')
    {
        throw new Error('production build compiler identity must be live and registered while building');
    }
    if (!containmentAuthority && !owner.allowDiagnosticProcessContainmentForTests)
    {
        throw new Error('production build compiler requires a durable OS containment authority');
    }
    const group = owner.ownerPlatform === 'win32' ? null : collectProcessGroupOrJobIdentity(identity.pid);
    if (group && group.status !== 'verified')
    {
        throw new Error(`production build compiler group is unverifiable: ${group.reason}`);
    }
    addManagedIdentity(owner, identity);
    if (group)
    {
        addManagedGroup(owner, group.value);
    }
    if (containmentAuthority)
    {
        const receipt = containmentAuthorityReceipt(containmentAuthority, identity);
        if (receipt.schema === resourceServiceContainmentSchema)
        {
            assertCanonicalResourceOwnerLayout(layout);
            assertServiceControlCarrier(receipt);
            const index = owner.managedContainmentAuthorities.findIndex((entry) => entry.authorityId === receipt.authorityId);
            const intent = { ...receipt, phase: 'create-attempted', supervisorProcessIdentity: null,
                serviceBinding: { ...receipt.serviceBinding, identity: null } };
            if (owner.ownerPid !== process.pid || processIdentityStatus(owner.ownerIdentity).status !== 'live'
                || index < 0 || digestCanonical(owner.managedContainmentAuthorities[index]) !== digestCanonical(intent))
            {
                throw new Error('production build service admission requires its exact independently retained intent');
            }
            const observed = inspectProductionSystemdServiceBinding(receipt.serviceBinding, { commandBudgetMs: receipt.commandBudgetMs });
            if (observed.status !== 'present' || observed.unit.ActiveState !== 'active'
                || !observed.group.processIds.includes(identity.pid) || processIdentityStatus(identity).status !== 'live')
            {
                throw new Error('production build service admission requires the exact live pre-exec workload');
            }
            owner.managedContainmentAuthorities[index] = receipt;
        }
        else
        {
            addContainmentAuthority(owner, receipt);
        }
    }
    owner.heartbeatAt = new Date().toISOString();
    const next = persistBuildOwner(layout, manifest, owner);
    if (containmentAuthority?.schema === resourceServiceContainmentSchema)
    {
        const retained = readBuildOwner(layout).owner.managedContainmentAuthorities.find((entry) =>
            entry.authorityId === containmentAuthority.authorityId);
        if (digestCanonical(retained) !== digestCanonical(containmentAuthority))
        {
            throw new Error('production build service admission did not survive durable read-back');
        }
    }
    if (owner.ownerPlatform !== 'win32')
    {
        scanProductionBuildProcesses(layout);
        startBuildOwnerMonitor(layout);
    }
    return next;
}

/** Independently retain the exact live resident service after the producer command has exited. */
export function transferProductionBuildResidentService(layout, authority, residentTransfer)
{
    assertCanonicalResourceOwnerLayout(layout);
    const { manifest, owner } = readBuildOwner(layout);
    const transferred = { ...authority, phase: 'resident-transferred', residentTransfer };
    if (owner.state !== 'building' || owner.ownerPid !== process.pid
        || processIdentityStatus(owner.ownerIdentity).status !== 'live'
        || !resourceServiceContainmentIsComplete(authority) || authority.phase !== 'pre-exec'
        || !resourceServiceContainmentIsComplete(transferred))
    {
        throw new Error('resident service transfer requires its exact live build and pre-exec owners');
    }
    const index = owner.managedContainmentAuthorities.findIndex((entry) => entry.authorityId === authority.authorityId);
    if (index < 0 || digestCanonical(owner.managedContainmentAuthorities[index]) !== digestCanonical(authority)
        || !owner.managedResourceBoundaries.some((entry) =>
            digestCanonical(entry.reference) === digestCanonical(authority.serviceBinding.reference)))
    {
        throw new Error('resident service transfer differs from its independently retained producer');
    }
    assertServiceControlCarrier(transferred);
    const terminal = inspectServiceCreationSenderTerminal(authority);
    if (terminal.status !== 'terminal' || terminal.submission !== 'sender-returned'
        || terminal.receipt.exitCode !== 0 || terminal.receipt.signal !== null)
    {
        throw new Error('resident service transfer lacks a terminal exact creation sender');
    }
    if (fs.readFileSync(path.join(authority.controlRoot.path, 'ready'), 'utf8').trim()
        !== String(residentTransfer.supervisorIdentity.pid))
    {
        throw new Error('resident service transfer supervisor differs from its exact ready carrier');
    }
    const assertLive = () =>
    {
        const observed = inspectProductionSystemdServiceBinding(authority.serviceBinding, {
            commandBudgetMs: authority.commandBudgetMs
        });
        const expected = residentTransfer.memberIdentities.map((identity) => identity.pid);
        if (observed.status !== 'present' || observed.unit.ActiveState !== 'active'
            || expected.length !== observed.group.processIds.length
            || expected.some((pid, position) => pid !== observed.group.processIds[position])
            || residentTransfer.memberIdentities.some((identity) => processIdentityStatus(identity).status !== 'live'))
        {
            throw new Error('resident service transfer member roster is not the exact live service');
        }
        if (digestCanonical(inspectPhysicalExecutionResidentOutput(transferred))
            !== digestCanonical(residentTransfer.outputFiles))
        {
            throw new Error('resident service transfer output differs from its private captured prefix');
        }
    };
    assertLive();
    owner.managedContainmentAuthorities[index] = transferred;
    owner.heartbeatAt = new Date().toISOString();
    persistBuildOwner(layout, manifest, owner);
    const retained = readBuildOwner(layout).owner.managedContainmentAuthorities[index];
    if (digestCanonical(retained) !== digestCanonical(transferred))
    {
        throw new Error('resident service transfer did not survive independent durable read-back');
    }
    assertLive();
    return { authorityDigest: digestCanonical(retained) };
}

/** Settle only the original build owner's transferred service; keep mismatched artifacts for recovery. */
export function settleProductionBuildResidentService(layout, authority, { reason = 'resident-consumer-settled' } = {})
{
    assertCanonicalResourceOwnerLayout(layout);
    const assertCurrent = () =>
    {
        const { owner } = readBuildOwner(layout);
        const retained = owner.managedContainmentAuthorities.find((entry) => entry.authorityId === authority?.authorityId);
        if (owner.state !== 'building' || owner.ownerPid !== process.pid
            || processIdentityStatus(owner.ownerIdentity).status !== 'live'
            || !resourceServiceContainmentIsComplete(authority) || authority.phase !== 'resident-transferred'
            || !retained
            || digestCanonical(retained) !== digestCanonical(authority)
            || !owner.managedResourceBoundaries.some((entry) =>
                digestCanonical(entry.reference) === digestCanonical(authority.serviceBinding.reference)))
        {
            throw new Error('resident service settlement requires its unchanged live build owner');
        }
        return { status: 'verified' };
    };
    assertCurrent();
    const termination = terminatePhysicalExecutionAuthoritySync({ authority, reason,
        validateAuthority: assertCurrent });
    if (termination.terminated !== true || termination.postObservation !== 'zero-members')
    {
        throw new Error(`resident service settlement cannot prove zero members: ${termination.reason}`);
    }
    const artifacts = cleanupLivePhysicalExecutionResidentArtifacts([authority], { validateAuthority: assertCurrent });
    const cleaned = artifacts.find((entry) => entry.authorityId === authority.authorityId);
    const outputFiles = cleaned?.outputFiles?.['stdout.log'] && cleaned.outputFiles['stderr.log']
        ? Object.fromEntries(['stdout', 'stderr'].map((name) =>
        {
            const snapshot = cleaned.outputFiles[`${name}.log`];
            return [name, { path: authority.residentOutput.files[name].path, device: snapshot.device,
                inode: snapshot.inode, byteCount: snapshot.size, digest: `sha256:${snapshot.digest}` }];
        }))
        : authority.residentTransfer.outputFiles;
    if (digestCanonical(outputFiles) !== digestCanonical(authority.residentTransfer.outputFiles))
    {
        throw new Error('resident service final output differs from its transferred captured prefix');
    }
    assertCurrent();
    return { termination, outputFiles, artifacts };
}

export function measureProductionBuildTree(directory)
{
    if (!fs.existsSync(directory))
    {
        return { inodeCount: 0, byteCount: 0 };
    }
    let inodeCount = 0;
    let byteCount = 0;
    const visit = (current) =>
    {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }))
        {
            const child = path.join(current, entry.name);
            inodeCount += 1;
            if (entry.isDirectory())
            {
                visit(child);
            }
            else if (entry.isFile())
            {
                byteCount += fs.statSync(child).size;
            }
        }
    };
    visit(directory);
    return { inodeCount, byteCount };
}

export function verifyProductionBuildRootIntegrity(layout)
{
    if (!fs.existsSync(layout.manifestFile))
    {
        return true;
    }
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
    if (manifest.schema !== productionBuildLayoutSchema || manifest.runId !== layout.runId)
    {
        throw new Error(`production build layout identity mismatch: ${layout.manifestFile}`);
    }
    if (
        ['complete', 'failed', 'cancelled'].includes(manifest.owner?.state) &&
        manifest.contentDigest !== digestBuildTree(layout.runRoot)
    )
    {
        throw new Error(`production build governance failure: ${manifest.owner.state} root received a write`);
    }
    return true;
}

export function collectStaleProductionBuildRoots({
    root = defaultRoot,
    currentRunId = null,
    isRunActive = (runId) => productionBuildRunIsActive(root, runId),
    remove = (directory) => fs.rmSync(directory, { recursive: true, force: true }),
    beforeDelete = null,
    allowDelete = null,
    onRoot = null
} = {})
{
    const startedAtMs = Date.now();
    const repositoryRoot = path.resolve(root);
    const buildBase = path.join(repositoryRoot, '.tmp/build');
    if (!fs.existsSync(buildBase))
    {
        return {
            removed: [],
            retained: [],
            reclaimed: { inodeCount: 0, byteCount: 0 },
            durationMs: Date.now() - startedAtMs
        };
    }
    if (fs.lstatSync(buildBase).isSymbolicLink())
    {
        throw new Error('refusing symlink production build base');
    }
    const normalizedCurrent = currentRunId ? validateProductionRunId(currentRunId) : null;
    const removed = [];
    const retained = [];
    const reclaimed = { inodeCount: 0, byteCount: 0 };
    for (const entry of fs.readdirSync(buildBase, { withFileTypes: true }))
    {
        const candidate = path.join(buildBase, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink())
        {
            if (entry.isSymbolicLink())
            {
                throw new Error(`refusing symlink production build candidate: ${candidate}`);
            }
            continue;
        }
        assertSafeProductionBuildRunRoot(candidate, { root: repositoryRoot });
        verifyProductionBuildRootIntegrity(resolveProductionBuildLayout({ root: repositoryRoot, runId: entry.name }));
        const expectedIdentity = productionBuildRootIdentity(candidate);
        const measured = measureProductionBuildTree(candidate);
        const observation = {
            runId: entry.name,
            root: candidate,
            identity: expectedIdentity,
            size: { byteCount: measured.byteCount, inodeCount: measured.inodeCount },
            decision: null,
            deleteResult: null,
            postObservation: null
        };
        if (entry.name === normalizedCurrent)
        {
            observation.decision = 'retain-current-run';
            observation.postObservation = { exists: true };
            onRoot?.(observation);
            retained.push(entry.name);
            continue;
        }
        let active;
        try
        {
            active = isRunActive(entry.name);
        }
        catch (error)
        {
            observation.decision = 'block-unverifiable-identity';
            observation.deleteResult = { status: 'not-attempted', reason: error.message };
            observation.postObservation = { exists: fs.existsSync(candidate) };
            onRoot?.(observation);
            throw error;
        }
        if (active)
        {
            observation.decision = 'retain-active-owner';
            observation.postObservation = { exists: true };
            onRoot?.(observation);
            retained.push(entry.name);
            continue;
        }
        if (allowDelete && allowDelete(observation) !== true)
        {
            observation.decision = 'block-budget-or-policy';
            observation.deleteResult = { status: 'not-attempted' };
            observation.postObservation = { exists: true };
            onRoot?.(observation);
            retained.push(entry.name);
            continue;
        }
        if (
            !reclaimExactProductionBuildRoot(candidate, expectedIdentity, {
                remove,
                beforeDelete: beforeDelete ? (context) => beforeDelete({ ...context, runId: entry.name }) : null
            })
        )
        {
            observation.decision = 'retain-identity-changed';
            observation.deleteResult = { status: 'not-deleted' };
            observation.postObservation = { exists: fs.existsSync(candidate) };
            onRoot?.(observation);
            retained.push(entry.name);
            continue;
        }
        observation.decision = 'delete-stale-complete';
        observation.deleteResult = { status: 'deleted' };
        observation.postObservation = { exists: fs.existsSync(candidate) };
        onRoot?.(observation);
        reclaimed.inodeCount += measured.inodeCount;
        reclaimed.byteCount += measured.byteCount;
        removed.push(entry.name);
    }
    return {
        removed: removed.sort(),
        retained: retained.sort(),
        reclaimed,
        durationMs: Date.now() - startedAtMs
    };
}

export function finalizeProductionBuildLayout(
    layout,
    { status, cleanup = null, wallClockMs = null, completedAt = new Date().toISOString() } = {}
)
{
    if (!['success', 'failure', 'cancelled'].includes(status))
    {
        throw new Error(`production build layout final status is invalid: ${status}`);
    }
    assertSafeProductionBuildRunRoot(layout.runRoot, { root: layout.repositoryRoot });
    stopBuildOwnerMonitor(layout);
    const before = readBuildOwner(layout);
    if (before.owner.state === 'building')
    {
        scanProductionBuildProcesses(layout);
    }
    const { manifest, owner } = readBuildOwner(layout);
    if (status === 'success' && !['building', 'finalizing'].includes(owner.state))
    {
        throw new Error('production build cannot complete before scheduler/source binding');
    }
    if (owner.processIdentityFailure)
    {
        throw new Error(`production build process identity failure: ${owner.processIdentityFailure}`);
    }
    const ownerStatus = processIdentityStatus(owner.ownerIdentity);
    if (ownerStatus.status !== 'live')
    {
        throw new Error(`production build finalize refused because owner identity is ${ownerStatus.status}`);
    }
    owner.state = 'finalizing';
    persistBuildOwner(layout, manifest, owner);
    if (resourceBoundariesRetained(layout, owner))
    {
        throw new Error('production build finalize refused while resource boundaries are retained');
    }
    const writers = owner.activeCompilerProcessIdentities.map((identity) => processIdentityStatus(identity));
    const descendants =
        owner.ownerPlatform === 'win32'
            ? { status: 'verified', identities: [] }
            : processDescendantIdentities(owner.ownerIdentity);
    if (descendants.status === 'unverifiable')
    {
        throw new Error(
            `production build finalize refused while descendant identity is unverifiable: ${descendants.reason}`
        );
    }
    const descendantWriters = descendants.identities.map((identity) => processIdentityStatus(identity));
    const groupWriters = [];
    for (const group of owner.managedProcessGroupIdentities)
    {
        const members = processGroupMemberIdentities(group);
        if (members.status !== 'verified')
        {
            throw new Error(`production build finalize refused while process group is unverifiable: ${members.reason}`);
        }
        groupWriters.push(...members.identities.map((identity) => processIdentityStatus(identity)));
    }
    const containmentStatuses = owner.managedContainmentAuthorities.map(containmentAuthorityStatus);
    const unverifiableContainment = containmentStatuses.find((entry) => entry.status === 'unverifiable');
    if (unverifiableContainment)
    {
        throw new Error(
            `production build finalize refused while containment authority is unverifiable: ${unverifiableContainment.reason}`
        );
    }
    if (
        writers.some((writer) => writer.status === 'live') ||
        descendantWriters.some((writer) => writer.status === 'live') ||
        groupWriters.some((writer) => writer.status === 'live') ||
        containmentStatuses.some((entry) => entry.status === 'active')
    )
    {
        throw new Error('production build finalize refused while compiler writer is active');
    }
    if (writers.some((writer) => writer.status === 'unverifiable'))
    {
        throw new Error('production build finalize refused while compiler identity is unverifiable');
    }
    if (
        descendantWriters.some((writer) => writer.status === 'unverifiable') ||
        groupWriters.some((writer) => writer.status === 'unverifiable')
    )
    {
        throw new Error('production build finalize refused while process-tree identity is unverifiable');
    }
    const output = measureProductionBuildTree(layout.runRoot);
    const finalized = {
        ...manifest,
        owner: {
            ...owner,
            state: status === 'success' ? 'complete' : status === 'failure' ? 'failed' : 'cancelled',
            heartbeatAt: new Date().toISOString(),
            processTreeReceipt: processTreeReceipt({
                ...owner,
                state: status === 'success' ? 'complete' : status === 'failure' ? 'failed' : 'cancelled'
            })
        },
        status,
        completedAt,
        contentDigest: digestBuildTree(layout.runRoot),
        metrics: {
            cleanup,
            output,
            wallClockMs: Number.isFinite(Number(wallClockMs)) ? Number(wallClockMs) : null
        }
    };
    atomicWriteJson(layout.manifestFile, finalized);
    fs.rmSync(layout.activeFile, { force: true });
    return finalized;
}

function lifecycleFailureReceipt(error)
{
    if (!error)
    {
        return null;
    }
    let message = String(error);
    if (error instanceof Error)
    {
        message = error.message;
    }
    else if (typeof error.reason === 'string')
    {
        message = error.reason;
    }
    return {
        name: typeof error.name === 'string' ? error.name : null,
        message,
        code: typeof error.code === 'string' || Number.isInteger(error.code) ? error.code : null,
        exitCode: Number.isInteger(error.exitCode) ? error.exitCode : null,
        signal: typeof error.signal === 'string' ? error.signal : null,
        tierId: typeof error.tierId === 'string' ? error.tierId : null
    };
}

export function failClosedProductionBuildLayout(
    layout,
    {
        status = 'failure',
        primaryFailure = null,
        sealFailure,
        completedAt = new Date().toISOString()
    } = {}
)
{
    if (!['failure', 'cancelled'].includes(status))
    {
        throw new Error(`production build fail-closed status is invalid: ${status}`);
    }
    if (!sealFailure)
    {
        throw new Error('production build fail-closed terminalization requires the seal failure');
    }
    assertSafeProductionBuildRunRoot(layout.runRoot, { root: layout.repositoryRoot });
    stopBuildOwnerMonitor(layout);
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
    if (manifest.schema !== productionBuildLayoutSchema || manifest.runId !== layout.runId)
    {
        throw new Error(`production build layout identity mismatch: ${layout.manifestFile}`);
    }
    if (manifest.owner?.managedResourceBoundaries?.length !== 0
        || manifest.owner?.processTreeReceipt?.managedResourceBoundaries?.length !== 0)
    {
        // Never reseal missing or tampered resource references while handling another failure.
        readBuildOwner(layout);
    }
    let resourceRetention = null;
    try
    {
        if (resourceBoundariesRetained(layout, manifest.owner))
        {
            resourceRetention = { status: 'retained', reason: 'resource cleanup has not been proven' };
        }
    }
    catch (error)
    {
        resourceRetention = { status: 'unverifiable', reason: error.message };
    }
    if (resourceRetention)
    {
        const owner = { ...manifest.owner, state: 'finalizing', heartbeatAt: new Date().toISOString() };
        const retained = { ...manifest, status, lifecycleFinalization: {
            schema: 'fsusblog.production-build-lifecycle-finalization.v1', mode: 'retained-resources',
            primaryFailure: lifecycleFailureReceipt(primaryFailure), sealFailure: lifecycleFailureReceipt(sealFailure),
            resourceRetention
        } };
        return persistBuildOwner(layout, retained, owner);
    }
    const terminalState = status === 'cancelled' ? 'cancelled' : 'failed';
    const owner = {
        ...manifest.owner,
        state: terminalState,
        heartbeatAt: new Date().toISOString()
    };
    owner.processTreeReceipt = processTreeReceipt(owner);
    const terminal = {
        ...manifest,
        owner,
        status,
        completedAt,
        lifecycleFinalization: {
            schema: 'fsusblog.production-build-lifecycle-finalization.v1',
            mode: 'fail-closed-fallback',
            primaryFailure: lifecycleFailureReceipt(primaryFailure),
            sealFailure: lifecycleFailureReceipt(sealFailure)
        },
        contentDigest: digestBuildTree(layout.runRoot)
    };
    atomicWriteJson(layout.manifestFile, terminal);
    fs.rmSync(layout.activeFile, { force: true });
    return terminal;
}

export function productionBuildLayoutDigest(layout)
{
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
    const identity = {
        schema: manifest.schema,
        runId: manifest.runId,
        sourceState: manifest.sourceState,
        paths: manifest.paths,
        projects: manifest.projects
    };
    return `sha256:${createHash('sha256')
        .update(JSON.stringify(canonicalize(identity)))
        .digest('hex')}`;
}
