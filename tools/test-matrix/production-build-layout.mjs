import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const {collectProcessGroupOrJobIdentity, currentProcessIdentity, processDescendantIdentities, processGroupMemberIdentities, processGroupOrJobIdentityMatches, processIdentitySchema, processIdentityStatus} = await import(new URL('../test/process-identity.mjs', import.meta.url));
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
    const benchmark = dotnetProjectLayout(layout, 'benchmarks/core/FsusBlog.Core.Benchmarks.csproj');
    return {
        server,
        tests,
        benchmark,
        serverDll: path.join(server.outputDirectory, 'FsusBlog.Server.dll'),
        testDll: path.join(tests.outputDirectory, 'FsusBlog.Server.Tests.dll'),
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
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
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

function processTreeReceipt(owner)
{
    const payload = {
        schema: 'fsusblog.production-build-process-tree-receipt.v1',
        runId: owner.runId,
        ownerPlatform: owner.ownerPlatform,
        schedulerRunId: owner.schedulerRunId,
        namespace: owner.namespace,
        sourceCommit: owner.sourceCommit,
        worktreeFingerprint: owner.worktreeFingerprint,
        ownerIdentity: owner.ownerIdentity,
        processGroupOrJobIdentity: owner.processGroupOrJobIdentity,
        schedulerLockIdentity: owner.schedulerLockIdentity,
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
                relativeChild === '.reclaim.json'
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
                authority.supervisorProcessIdentity.processStartIdentity === identity.processStartIdentity
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
    if (status.status !== 'live' || owner.ownerPlatform !== 'darwin')
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

function readBuildOwner(layout)
{
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
    const active = JSON.parse(fs.readFileSync(layout.activeFile, 'utf8'));
    const owner = manifest.owner;
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
        Array.isArray(owner.managedProcessGroupIdentities) &&
        owner.managedProcessGroupIdentities.every(completeProcessGroupOrJobIdentity) &&
        Array.isArray(owner.activeCompilerProcessIdentities) &&
        owner.activeCompilerProcessIdentities.every(completeProcessIdentity) &&
        (owner.allowDiagnosticProcessContainmentForTests ||
            owner.activeCompilerProcessIdentities.every((identity) =>
                compilerIdentityHasContainmentAuthority(owner, identity))) &&
        ['preparing', 'building', 'finalizing'].includes(owner.state) &&
        (owner.state === 'preparing'
            ? owner.schedulerLockIdentity === null
            : completeSchedulerLockIdentity(owner.schedulerLockIdentity, owner)) &&
        owner.createdAt &&
        owner.heartbeatAt;
    const expectedReceipt = ownerComplete ? processTreeReceipt(owner) : null;
    if (
        manifest.schema !== productionBuildLayoutSchema ||
        active.schema !== 'fsusblog.production-build-owner.v1' ||
        manifest.runId !== layout.runId ||
        active.runId !== layout.runId ||
        !ownerComplete ||
        manifest.sourceState?.commit !== owner.sourceCommit ||
        manifest.sourceState?.worktreeFingerprint !== owner.worktreeFingerprint ||
        JSON.stringify(canonicalize(manifest.owner)) !== JSON.stringify(canonicalize(active.owner)) ||
        JSON.stringify(canonicalize(manifest.owner?.processTreeReceipt)) !==
            JSON.stringify(canonicalize(expectedReceipt))
    )
    {
        throw new Error(`production build owner identity mismatch: ${layout.runId}`);
    }
    return { manifest, owner };
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
    const projects = [artifacts.server, artifacts.tests, artifacts.benchmark];
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
            return false;
        }
    }
    if (!activeExists || !manifestExists)
    {
        throw new Error(`production build owner identity is missing: ${safeRunId}`);
    }
    const { owner } = readBuildOwner(layout);
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
                    }
                })
                : null
        });
        if (schedulerActivity.status === 'unverifiable')
        {
            throw new Error(`production build scheduler owner-unverifiable: ${schedulerActivity.reason}`);
        }
        if (
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
        ownerStatus.status === 'live' ||
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
            {}
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
        addContainmentAuthority(owner, containmentAuthorityReceipt(containmentAuthority, identity));
    }
    owner.heartbeatAt = new Date().toISOString();
    const next = persistBuildOwner(layout, manifest, owner);
    if (owner.ownerPlatform !== 'win32')
    {
        scanProductionBuildProcesses(layout);
        startBuildOwnerMonitor(layout);
    }
    return next;
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
