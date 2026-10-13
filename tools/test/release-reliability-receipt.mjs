import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { createTerminalEvents } from './release-reliability-terminal.mjs';

const {collectProductionToolchain, verifyProductionBuildReceipt} = await import(new URL('../ci/production-build-artifacts.mjs', import.meta.url));
const {requireCleanAttemptConsumerAdmission} = await import(new URL('../release/browser-release-clean-attempt-consumers.mjs', import.meta.url));
const {snapshotGitWorktree} = await import(new URL('../test-matrix/scheduler.mjs', import.meta.url));
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const isoTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const productionBuildToolchainKeys = ['dotnet', 'emsdk', 'node', 'npm', 'playwright', 'vite', 'vitest'];
const auditRetentionPolicyPath = 'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs';

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

export function digestValue(value)
{
    const { contentDigest: _ignored, ...content } = value;
    void _ignored;
    return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`;
}

export function digestFile(file)
{
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function rawDigest(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function sealDocument(value)
{
    const sealed = { ...value, contentDigest: null };
    sealed.contentDigest = digestValue(sealed);
    return sealed;
}

function normalizedRelativePath(value, label)
{
    const raw = String(value ?? '').trim().replaceAll('\\', '/');
    const normalized = raw.replace(/^\.\//u, '');
    const segments = normalized.split('/');
    if (!normalized || path.posix.isAbsolute(normalized)
        || path.posix.normalize(normalized) !== normalized
        || segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    {
        throw new Error(`${label} path is unsafe: ${normalized || '<empty>'}`);
    }
    return normalized;
}

function resolveApprovedPath(repositoryRoot, value, label)
{
    const relative = normalizedRelativePath(value, label);
    const absolute = path.resolve(repositoryRoot, relative);
    if (absolute === repositoryRoot || !absolute.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error(`${label} path escapes repository root: ${relative}`);
    }
    let cursor = absolute;
    while (cursor !== repositoryRoot)
    {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
        {
            throw new Error(`${label} path contains a symlink: ${relative}`);
        }
        cursor = path.dirname(cursor);
    }
    return { absolute, relative };
}

function regularFileBinding(repositoryRoot, configuredPath, label)
{
    const resolved = resolveApprovedPath(repositoryRoot, configuredPath, label);
    if (!fs.existsSync(resolved.absolute) || !fs.lstatSync(resolved.absolute).isFile())
    {
        throw new Error(`${label} file is unavailable: ${resolved.relative}`);
    }
    return {
        path: resolved.relative,
        fileDigest: digestFile(resolved.absolute)
    };
}

function requiredEnvironmentPath(repositoryRoot, env, variable, label, errors)
{
    const configured = String(env[variable] ?? '').trim();
    if (!configured)
    {
        errors.push(`${variable} is required`);
        return { status: 'unavailable', path: null, fileDigest: null };
    }
    try
    {
        return { status: 'complete', ...regularFileBinding(repositoryRoot, configured, label) };
    }
    catch (error)
    {
        errors.push(error instanceof Error ? error.message : String(error));
        return { status: 'unavailable', path: configured, fileDigest: null };
    }
}

function readJson(file, label)
{
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`${label} is not valid JSON`, { cause: error });
    }
}

function normalizeFingerprint(value)
{
    const normalized = String(value ?? '').replace(/^sha256:/u, '');
    return /^[0-9a-f]{64}$/u.test(normalized) ? `sha256:${normalized}` : null;
}

function sameSourceState(left, right)
{
    return left?.commit === right?.commit
        && normalizeFingerprint(left?.worktreeFingerprint) === normalizeFingerprint(right?.worktreeFingerprint);
}

function inspectRuntimeImage(imageReference, inspectImage, sourceState)
{
    if (!imageReference)
    {
        throw new Error('FSUSBLOG_RELEASE_RUNTIME_IMAGE is required; a caller-supplied digest is not authority');
    }
    const inspection = inspectImage(imageReference);
    const labels = inspection?.Config?.Labels ?? {};
    const revision = String(labels['org.opencontainers.image.revision'] ?? '');
    const fsusuiSource = String(labels['io.fsusblog.build.fsusui-source'] ?? '');
    const fsusuiCommit = String(labels['io.fsusblog.build.fsusui-commit'] ?? '');
    if (revision !== sourceState.commit
        || !['published-package', 'local-git-alias'].includes(fsusuiSource)
        || !/^[0-9a-f]{40}$/u.test(fsusuiCommit)
        || fsusuiSource === 'local-git-alias' && fsusuiCommit === '0'.repeat(40))
    {
        throw new Error('runtime image lacks source-bound revision and explicit FsusUI producer labels');
    }
    const repositoryDigests = Array.isArray(inspection?.RepoDigests) ? inspection.RepoDigests : [];
    const selected = repositoryDigests.find((value) => /@sha256:[0-9a-f]{64}$/u.test(String(value)));
    if (selected)
    {
        const imageDigest = selected.slice(selected.lastIndexOf('@') + 1);
        return {
            kind: 'registry-repository-digest',
            reference: imageReference,
            repositoryDigest: selected,
            imageDigest,
            revision,
            fsusuiSource,
            fsusuiCommit
        };
    }
    const imageDigest = String(inspection?.Id ?? '');
    const layers = inspection?.RootFS?.Layers;
    if (!digestPattern.test(imageDigest) || revision !== sourceState.commit
        || !Array.isArray(layers) || layers.length === 0 || layers.some((layer) => !digestPattern.test(layer)))
    {
        throw new Error('local runtime image lacks a source-bound config digest, revision label, or inspected layers');
    }
    return {
        kind: 'local-docker-image-id',
        reference: imageReference,
        repositoryDigest: null,
        imageDigest,
        revision,
        fsusuiSource,
        fsusuiCommit,
        layers,
        layersDigest: digestValue({ layers })
    };
}

function defaultImageInspector(imageReference)
{
    const result = spawnSync('docker', ['image', 'inspect', imageReference], { encoding: 'utf8' });
    if (result.status !== 0)
    {
        throw new Error(`docker image inspect failed for ${imageReference}: ${String(result.stderr ?? '').trim() || 'unavailable'}`);
    }
    const documents = JSON.parse(String(result.stdout));
    if (!Array.isArray(documents) || documents.length !== 1)
    {
        throw new Error('docker image inspect did not return exactly one image');
    }
    return documents[0];
}

function collectBuildIdentity(repositoryRoot, env, sourceState, runId, errors, inspectImage)
{
    if (env.FSUSBLOG_RELEASE_BUILD_RECEIPT || env.FSUSBLOG_RELEASE_IMAGE_DIGEST)
    {
        errors.push('FSUSBLOG_RELEASE_BUILD_RECEIPT and FSUSBLOG_RELEASE_IMAGE_DIGEST are forbidden; use the production-build root and inspected runtime image');
    }
    const configuredRoot = String(env.FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT ?? '').trim();
    const imageReference = String(env.FSUSBLOG_RELEASE_RUNTIME_IMAGE ?? '').trim();
    if (!configuredRoot)
    {
        errors.push('FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT is required');
    }
    try
    {
        const root = resolveApprovedPath(repositoryRoot, configuredRoot, 'production build artifact root');
        if (!fs.existsSync(root.absolute) || !fs.lstatSync(root.absolute).isDirectory())
        {
            throw new Error('production build artifact root is unavailable');
        }
        const verification = verifyProductionBuildReceipt({
            artifactRoot: root.absolute,
            expectedSourceState: sourceState,
            expectedProducer: { runId, job: 'production-build-artifacts' },
            expectedToolchain: collectProductionToolchain({ root: repositoryRoot }),
            expectedInputRoot: repositoryRoot,
            expectedReceiptDigest: String(env.FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST ?? '').trim() || null
        });
        const binding = regularFileBinding(repositoryRoot, `${root.relative}/receipt.json`, 'build receipt');
        const image = inspectRuntimeImage(imageReference, inspectImage, sourceState);
        const receipt = verification.receipt;
        return {
            status: 'complete',
            ...binding,
            contentDigest: receipt.contentDigest,
            imageDigest: image.imageDigest,
            image,
            sourceState: receipt.sourceState,
            producerRunId: receipt.producer.runId,
            toolchain: receipt.toolchain
        };
    }
    catch (error)
    {
        errors.push(error instanceof Error ? error.message : String(error));
        return {
            status: 'unavailable',
            path: configuredRoot || null,
            fileDigest: null,
            contentDigest: null,
            imageDigest: null,
            sourceState: null,
            producerRunId: null
        };
    }
}

function collectFixtureIdentity(repositoryRoot, env, runId, imageDigest, errors)
{
    if (!String(env.FSUSBLOG_RELEASE_FIXTURE_AUTHORITY ?? '').trim())
    {
        errors.push('FSUSBLOG_RELEASE_FIXTURE_AUTHORITY is required');
    }
    const configuredRoot = String(env.FSUSBLOG_TEST_FIXTURE_ROOT ?? '').trim();
    const namespace = String(env.FSUSBLOG_TEST_NAMESPACE ?? '').trim();
    let rootBinding = { status: 'unavailable', path: configuredRoot || null };
    if (!configuredRoot)
    {
        errors.push('FSUSBLOG_TEST_FIXTURE_ROOT is required');
    }
    else
    {
        try
        {
            const resolved = resolveApprovedPath(repositoryRoot, configuredRoot, 'fixture root');
            if (!fs.existsSync(resolved.absolute) || !fs.lstatSync(resolved.absolute).isDirectory())
            {
                throw new Error(`fixture root is unavailable: ${resolved.relative}`);
            }
            rootBinding = { status: 'complete', path: resolved.relative };
        }
        catch (error)
        {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    if (!namespace)
    {
        errors.push('FSUSBLOG_TEST_NAMESPACE is required');
    }
    const config = requiredEnvironmentPath(repositoryRoot, env, 'FSUSBLOG_TEST_FIXTURE_CONFIG', 'fixture config', errors);
    const schema = requiredEnvironmentPath(repositoryRoot, env, 'FSUSBLOG_TEST_FIXTURE_SCHEMA', 'fixture schema', errors);
    const seed = requiredEnvironmentPath(repositoryRoot, env, 'FSUSBLOG_TEST_FIXTURE_SEED', 'fixture seed', errors);
    const auditRetentionPolicy = requiredEnvironmentPath(
        repositoryRoot,
        env,
        'FSUSBLOG_TEST_FIXTURE_AUDIT_RETENTION_POLICY',
        'fixture audit retention policy',
        errors
    );
    if (auditRetentionPolicy.path !== auditRetentionPolicyPath)
    {
        auditRetentionPolicy.status = 'unavailable';
        errors.push('fixture audit retention policy must use the canonical machine-readable catalog');
    }
    const topology = requiredEnvironmentPath(repositoryRoot, {
        FSUSBLOG_RELEASE_FIXTURE_AUTHORITY: env.FSUSBLOG_RELEASE_FIXTURE_AUTHORITY
    }, 'FSUSBLOG_RELEASE_FIXTURE_AUTHORITY', 'runtime topology authority', errors);
    if (topology.status === 'complete')
    {
        try
        {
            const document = readJson(
                resolveApprovedPath(repositoryRoot, topology.path, 'runtime topology').absolute,
                'runtime topology'
            );
            if (document.schema !== 'fsusblog.release-reliability-runtime-topology.v1'
                || document.status !== 'complete' || document.runId !== runId
                || document.namespace !== namespace
                || document.root !== rootBinding.path
                || JSON.stringify(document.config) !== JSON.stringify({ path: config.path, fileDigest: config.fileDigest })
                || JSON.stringify(document.schemaFile) !== JSON.stringify({ path: schema.path, fileDigest: schema.fileDigest })
                || JSON.stringify(document.seed) !== JSON.stringify({ path: seed.path, fileDigest: seed.fileDigest })
                || JSON.stringify(document.auditRetentionPolicy) !== JSON.stringify({
                    path: auditRetentionPolicy.path,
                    fileDigest: auditRetentionPolicy.fileDigest
                })
                || !document.runtime?.profile
                || !digestPattern.test(document.runtime?.imageDigest)
                || document.runtime.imageDigest !== imageDigest
                || !/^[0-9a-f]{40}$/u.test(document.runtime?.sourceState?.commit ?? '')
                || !digestPattern.test(normalizeFingerprint(document.runtime?.sourceState?.worktreeFingerprint))
                || !document.runtime?.backendContainer?.id
                || !Number.isInteger(document.runtime?.backendContainer?.hostPid)
                || document.runtime.backendContainer.hostPid < 2
                || !Array.isArray(document.runtime?.backendContainer?.environment)
                || !document.runtime?.backendContainer?.path
                || !Array.isArray(document.runtime?.backendContainer?.args)
                || !document.runtime?.backendContainer?.startedAt
                || document.runtime?.process?.pid !== 1
                || !document.postgres?.instance || !document.postgres?.version
                || !digestPattern.test(document.postgres?.configDigest)
                || !document.redis?.instance || !document.redis?.version
                || !digestPattern.test(document.redis?.configDigest)
                || document.contentDigest !== digestValue(document))
            {
                throw new Error('runtime topology schema/status/run/namespace/runtime identities are incomplete');
            }
            topology.content = {
                schema: document.schema,
                contentDigest: digestValue(document),
                postgres: document.postgres,
                redis: document.redis,
                auditRetentionPolicy: document.auditRetentionPolicy,
                runtime: document.runtime
            };
        }
        catch (error)
        {
            topology.status = 'unavailable';
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    const complete = rootBinding.status === 'complete' && namespace
        && [config, schema, seed, auditRetentionPolicy, topology].every(
            (binding) => binding.status === 'complete'
        );
    return {
        status: complete ? 'complete' : 'unavailable',
        root: rootBinding.path,
        namespace: namespace || null,
        config,
        schema,
        seed,
        auditRetentionPolicy,
        topology
    };
}

function collectCgroupIdentity()
{
    if (process.platform !== 'linux')
    {
        return { status: 'unavailable', version: null, limits: {} };
    }
    const membership = fs.readFileSync('/proc/self/cgroup', 'utf8')
        .split(/\r?\n/u)
        .map((line) => line.match(/^0::(\/.*)$/u)?.[1] ?? null)
        .find(Boolean);
    if (!membership || membership.includes('..'))
    {
        return { status: 'unavailable', version: 'v2', path: null, limits: {} };
    }
    const cgroupRoot = path.join('/sys/fs/cgroup', membership.replace(/^\//u, ''));
    const files = ['cpu.max', 'cpuset.cpus.effective', 'memory.max', 'pids.max'];
    const limits = {};
    for (const name of files)
    {
        let cursor = cgroupRoot;
        let file = null;
        while (cursor.startsWith('/sys/fs/cgroup'))
        {
            const candidate = path.join(cursor, name);
            if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile())
            {
                file = candidate;
                break;
            }
            if (cursor === '/sys/fs/cgroup')
            {
                break;
            }
            cursor = path.dirname(cursor);
        }
        if (file === null)
        {
            return { status: 'unavailable', version: 'v2', path: membership, limits };
        }
        limits[name] = {
            path: path.relative('/sys/fs/cgroup', file).replaceAll(path.sep, '/'),
            value: fs.readFileSync(file, 'utf8').trim()
        };
    }
    return { status: 'complete', version: 'v2', path: membership, limits };
}

function resolveToolExecutable(tool, environment = process.env)
{
    const searchPath = environment.PATH ?? process.env.PATH ?? '';
    for (const directory of String(searchPath).split(path.delimiter).filter(Boolean))
    {
        const candidate = path.resolve(directory, tool);
        try
        {
            fs.accessSync(candidate, fs.constants.X_OK);
            if (fs.lstatSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink())
            {
                return fs.realpathSync(candidate);
            }
        }
        catch
        {
            // Continue to the next explicit PATH entry.
        }
    }
    return null;
}

function collectTool(tool, environment = process.env)
{
    if (tool === 'node')
    {
        return {
            id: tool,
            status: 'complete',
            executable: fs.realpathSync(process.execPath),
            version: process.version
        };
    }
    const executable = resolveToolExecutable(tool, environment);
    if (executable === null)
    {
        return { id: tool, status: 'unavailable', executable: null, version: null };
    }
    if (tool === 'dotnet')
    {
        const sdk = spawnSync(executable, ['--version'], { encoding: 'utf8' });
        const runtimes = spawnSync(executable, ['--list-runtimes'], { encoding: 'utf8' });
        const sdkVersion = String(sdk.stdout ?? '').trim();
        const runtimeVersions = String(runtimes.stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
        return {
            id: tool,
            status: sdk.status === 0 && runtimes.status === 0 && sdkVersion && runtimeVersions.length > 0
                ? 'complete'
                : 'unavailable',
            executable,
            sdkVersion: sdkVersion || null,
            runtimeVersions
        };
    }
    if (tool === 'lsof')
    {
        const result = spawnSync(executable, ['-v'], { encoding: 'utf8' });
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        const version = /^\s*revision:\s*(\S+)\s*$/imu.exec(output)?.[1] ?? null;
        return {
            id: tool,
            status: result.status === 0 && version ? 'complete' : 'unavailable',
            executable,
            version
        };
    }
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
    const version = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
    return {
        id: tool,
        status: result.status === 0 && version ? 'complete' : 'unavailable',
        executable,
        version: version ?? null
    };
}

function collectMachineIdentity(repositoryRoot, env, errors)
{
    const cpus = os.cpus();
    let cgroup;
    try
    {
        cgroup = collectCgroupIdentity();
    }
    catch (error)
    {
        cgroup = { status: 'unavailable', version: null, path: null, limits: {} };
        errors.push(`cgroup identity collection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cgroup.status !== 'complete')
    {
        errors.push('cgroup v2 CPU, cpuset, memory, and pids limits are required');
    }
    const schedulerPolicy = requiredEnvironmentPath(
        repositoryRoot,
        env,
        'FSUSBLOG_RELEASE_RESOURCE_POLICY',
        'scheduler resource policy',
        errors
    );
    const complete = cpus.length > 0 && os.totalmem() > 0
        && cgroup.status === 'complete' && schedulerPolicy.status === 'complete';
    return {
        status: complete ? 'complete' : 'unavailable',
        os: `${os.platform()} ${os.release()}`,
        architecture: os.arch(),
        cpuModels: [...new Set(cpus.map((cpu) => cpu.model))].sort(),
        cpuCount: cpus.length,
        memoryBytes: os.totalmem(),
        cgroup,
        schedulerPolicy
    };
}

function collectCatalogPolicyBinding(repositoryRoot, catalog, key, label, errors)
{
    const configuredPath = String(catalog?.policyBindings?.[key] ?? '').trim();
    if (!configuredPath)
    {
        errors.push(`catalog policy binding is required: ${key}`);
        return { status: 'unavailable', path: null, fileDigest: null };
    }
    try
    {
        return {
            status: 'complete',
            ...regularFileBinding(repositoryRoot, configuredPath, label)
        };
    }
    catch (error)
    {
        errors.push(error instanceof Error ? error.message : String(error));
        return { status: 'unavailable', path: configuredPath, fileDigest: null };
    }
}

function collectChildEnvironmentIdentity(catalog)
{
    const content = {
        contract: catalog.childEnvironmentContract,
        scenarios: catalog.scenarios.map((scenario) => ({
            id: scenario.id,
            inheritEnv: scenario.command.inheritEnv,
            env: scenario.command.env
        }))
    };
    return {
        status: 'complete',
        schema: catalog.childEnvironmentContract.schema,
        contentDigest: digestValue(content)
    };
}

function scenarioChildEnvironmentIdentity(catalog, scenario)
{
    const content = {
        schema: catalog.childEnvironmentContract.schema,
        scenarioId: scenario.id,
        requiredBaseKeys: catalog.childEnvironmentContract.requiredBaseKeys,
        optionalBaseKeys: catalog.childEnvironmentContract.optionalBaseKeys,
        requiredInheritedKeys: scenario.command.inheritEnv.required,
        optionalInheritedKeys: scenario.command.inheritEnv.optional,
        fixedEnvironment: scenario.command.env,
        internalKeys: catalog.childEnvironmentContract.internalKeys
    };
    return {
        schema: content.schema,
        scenarioId: scenario.id,
        contentDigest: digestValue(content)
    };
}

export async function collectRunIdentity({
    repositoryRoot,
    catalog,
    invocationId,
    runId,
    scenarioId = null,
    env = process.env,
    now = () => new Date().toISOString(),
    inspectImage = defaultImageInspector
})
{
    const errors = [];
    let sourceState = {
        commit: null,
        worktreeFingerprint: null,
        dirtyPathCount: null,
        hashedPathCount: null
    };
    try
    {
        const commit = execFileSync(
            'git',
            ['rev-parse', 'HEAD'],
            { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ).trim();
        const snapshot = await snapshotGitWorktree(repositoryRoot);
        const worktreeFingerprint = normalizeFingerprint(snapshot.fingerprint);
        if (!/^[0-9a-f]{40}$/u.test(commit) || worktreeFingerprint === null)
        {
            throw new Error('Git source identity is not canonical');
        }
        sourceState = {
            commit,
            worktreeFingerprint,
            dirtyPathCount: Object.keys(snapshot.entries).length,
            hashedPathCount: snapshot.hashedPathCount
        };
    }
    catch (error)
    {
        errors.push(`source identity collection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const build = collectBuildIdentity(repositoryRoot, env, sourceState, runId, errors, inspectImage);
    const fixture = collectFixtureIdentity(repositoryRoot, env, runId, build.imageDigest, errors);
    const machine = collectMachineIdentity(repositoryRoot, env, errors);
    const selectedScenario = scenarioId === null
        ? null
        : catalog.scenarios.find((scenario) => scenario.id === scenarioId);
    if (scenarioId !== null && selectedScenario === undefined)
    {
        throw new Error(`Unknown scenario: ${scenarioId}`);
    }
    const declaredTools = selectedScenario?.identityTools ?? catalog.identityTools;
    const tools = [...declaredTools].sort().map((tool) =>
    {
        try
        {
            return collectTool(tool, env);
        }
        catch (error)
        {
            errors.push(`tool identity collection failed for ${tool}: ${
                error instanceof Error ? error.message : String(error)
            }`);
            return { id: tool, status: 'unavailable', executable: null, version: null };
        }
    });
    for (const tool of tools)
    {
        if (tool.status !== 'complete')
        {
            errors.push(`tool identity is unavailable: ${tool.id}`);
        }
    }
    let catalogBinding = { path: 'config/testing/release-reliability-scenario-catalog.json', fileDigest: null };
    try
    {
        catalogBinding = regularFileBinding(
            repositoryRoot,
            'config/testing/release-reliability-scenario-catalog.json',
            'scenario catalog'
        );
    }
    catch (error)
    {
        errors.push(error instanceof Error ? error.message : String(error));
    }
    const collectLifecycleAuthority = (configuredPath, label) =>
    {
        try
        {
            return {
                status: 'complete',
                ...regularFileBinding(repositoryRoot, configuredPath, label)
            };
        }
        catch (error)
        {
            errors.push(error instanceof Error ? error.message : String(error));
            return {
                status: 'unavailable',
                path: configuredPath,
                fileDigest: null
            };
        }
    };
    const lifecycleActionRegistry = collectLifecycleAuthority(
        'config/testing/release-reliability-lifecycle-action-registry.json',
        'lifecycle action registry'
    );
    const stateDomainRegistry = collectLifecycleAuthority(
        'config/testing/runtime-state-domain-registry.json',
        'runtime state-domain registry'
    );
    const threshold = collectCatalogPolicyBinding(
        repositoryRoot,
        catalog,
        'loadProfile',
        'threshold policy',
        errors
    );
    const mutationSubset = collectCatalogPolicyBinding(
        repositoryRoot,
        catalog,
        'mutationSubset',
        'mutation subset policy',
        errors
    );
    const releaseResource = collectCatalogPolicyBinding(
        repositoryRoot,
        catalog,
        'releaseResource',
        'release resource policy',
        errors
    );
    const physicalExecution = collectCatalogPolicyBinding(
        repositoryRoot,
        catalog,
        'physicalExecution',
        'physical execution policy',
        errors
    );
    return sealDocument({
        schema: 'fsusblog.release-reliability-run-identity.v1',
        status: errors.length === 0 ? 'complete' : 'unavailable',
        invocationId,
        runId,
        sourceState,
        build,
        fixture,
        machine,
        tools,
        policy: {
            catalog: {
                status: digestPattern.test(catalogBinding.fileDigest) ? 'complete' : 'unavailable',
                ...catalogBinding
            },
            lifecycleActionRegistry,
            stateDomainRegistry,
            threshold,
            mutationSubset,
            releaseResource,
            physicalExecution,
            childEnvironment: collectChildEnvironmentIdentity(catalog),
            executorSchema: 'fsusblog.release-reliability-scenario-result.v3',
            lifecycleSchema: catalog.lifecycleSchema
        },
        collectedAt: now(),
        collectionErrors: errors
    });
}

function exactScenarioIds(items, catalog, label)
{
    const expected = catalog.canonicalScenarioIds;
    const ids = items.map((item) => item?.scenarioId);
    if (ids.length !== expected.length || new Set(ids).size !== expected.length
        || JSON.stringify([...ids].sort()) !== JSON.stringify([...expected].sort()))
    {
        throw new Error(`${label} must contain exactly the canonical scenario IDs`);
    }
}

function validateIdentityReference(reference, invocationId)
{
    const expectedPath = `.tmp/release-reliability/${invocationId}/identity.json`;
    if (reference?.path !== expectedPath || !digestPattern.test(reference?.contentDigest))
    {
        throw new Error('run identity reference is incomplete');
    }
}

function validateCompleteIdentity(identity, catalog, lifecycleContracts)
{
    if (!isoTimePattern.test(identity.collectedAt) || !Number.isFinite(Date.parse(identity.collectedAt))
        || !Array.isArray(identity.collectionErrors) || identity.collectionErrors.length !== 0)
    {
        throw new Error('identity collection status/time is incomplete');
    }
    if (!/^[0-9a-f]{40}$/u.test(identity.sourceState?.commit)
        || !digestPattern.test(normalizeFingerprint(identity.sourceState?.worktreeFingerprint))
        || !Number.isInteger(identity.sourceState?.dirtyPathCount) || identity.sourceState.dirtyPathCount < 0
        || !Number.isInteger(identity.sourceState?.hashedPathCount) || identity.sourceState.hashedPathCount < 0)
    {
        throw new Error('source identity is incomplete');
    }
    if (identity?.build?.status !== 'complete' || !digestPattern.test(identity.build.fileDigest)
        || !digestPattern.test(identity.build.contentDigest) || !digestPattern.test(identity.build.imageDigest)
        || identity.build.image?.imageDigest !== identity.build.imageDigest
        || typeof identity.build.image?.reference !== 'string' || !identity.build.image.reference
        || identity.build.image?.revision !== identity.sourceState.commit
        || !['published-package', 'local-git-alias'].includes(identity.build.image?.fsusuiSource)
        || !/^[0-9a-f]{40}$/u.test(identity.build.image?.fsusuiCommit ?? '')
        || identity.build.image.fsusuiSource === 'local-git-alias'
            && identity.build.image.fsusuiCommit === '0'.repeat(40)
        || (identity.build.image?.kind === 'registry-repository-digest'
            ? !/@sha256:[0-9a-f]{64}$/u.test(identity.build.image?.repositoryDigest ?? '')
            : identity.build.image?.kind !== 'local-docker-image-id'
                || identity.build.image.revision !== identity.sourceState.commit
                || !Array.isArray(identity.build.image.layers) || identity.build.image.layers.length === 0
                || identity.build.image.layers.some((layer) => !digestPattern.test(layer))
                || identity.build.image.layersDigest !== digestValue({ layers: identity.build.image.layers }))
        || !sameSourceState(identity.build.sourceState, identity.sourceState)
        || identity.build.producerRunId !== identity.runId
        || identity.build.path !== normalizedRelativePath(identity.build.path, 'build receipt'))
    {
        throw new Error('build identity is incomplete or mismatched');
    }
    if (identity?.fixture?.status !== 'complete' || !identity.fixture.root || !identity.fixture.namespace
        || ['config', 'schema', 'seed', 'auditRetentionPolicy', 'topology'].some((field) => (
            identity.fixture[field]?.status !== 'complete'
            || !digestPattern.test(identity.fixture[field]?.fileDigest)
        ))
        || identity.fixture.topology.content?.schema !== 'fsusblog.release-reliability-runtime-topology.v1'
        || !digestPattern.test(identity.fixture.topology.content?.contentDigest)
        || !identity.fixture.topology.content?.postgres?.version
        || !identity.fixture.topology.content?.postgres?.instance
        || !digestPattern.test(identity.fixture.topology.content?.postgres?.configDigest)
        || !identity.fixture.topology.content?.redis?.version
        || !identity.fixture.topology.content?.redis?.instance
        || !digestPattern.test(identity.fixture.topology.content?.redis?.configDigest)
        || JSON.stringify(identity.fixture.topology.content?.auditRetentionPolicy) !== JSON.stringify({
            path: identity.fixture.auditRetentionPolicy.path,
            fileDigest: identity.fixture.auditRetentionPolicy.fileDigest
        })
        || !identity.fixture.topology.content?.runtime?.profile
        || identity.fixture.topology.content.runtime.imageDigest !== identity.build.imageDigest
        || !Number.isInteger(
            identity.fixture.topology.content.runtime.backendContainer?.hostPid
        )
        || identity.fixture.topology.content.runtime.backendContainer.hostPid < 2
        || identity.fixture.root !== normalizedRelativePath(identity.fixture.root, 'fixture root')
        || identity.fixture.auditRetentionPolicy.path !== auditRetentionPolicyPath
        || ['config', 'schema', 'seed', 'auditRetentionPolicy', 'topology'].some((field) => (
            identity.fixture[field].path !== normalizedRelativePath(
                identity.fixture[field].path,
                `fixture ${field}`
            )
        )))
    {
        throw new Error('fixture identity is incomplete');
    }
    const cgroupNames = ['cpu.max', 'cpuset.cpus.effective', 'memory.max', 'pids.max'];
    if (identity?.machine?.status !== 'complete' || identity.machine.cgroup?.status !== 'complete'
        || identity.machine.cgroup.version !== 'v2' || !identity.machine.cgroup.path
        || cgroupNames.some((name) => (
            !identity.machine.cgroup.limits?.[name]?.path
            || !String(identity.machine.cgroup.limits[name].value ?? '').trim()
        ))
        || !identity.machine.os || !identity.machine.architecture
        || !Array.isArray(identity.machine.cpuModels) || identity.machine.cpuModels.length === 0
        || !Number.isInteger(identity.machine.cpuCount) || identity.machine.cpuCount < 1
        || !Number.isInteger(identity.machine.memoryBytes) || identity.machine.memoryBytes < 1
        || identity.machine.schedulerPolicy?.status !== 'complete'
        || !digestPattern.test(identity.machine.schedulerPolicy?.fileDigest)
        || identity.machine.schedulerPolicy.path !== normalizedRelativePath(
            identity.machine.schedulerPolicy.path,
            'scheduler resource policy'
        ))
    {
        throw new Error('machine/cgroup/resource-policy identity is incomplete');
    }
    if (!Array.isArray(identity.tools)
        || JSON.stringify(identity.tools.map((tool) => tool.id)) !== JSON.stringify([...catalog.identityTools].sort())
        || identity.tools.some((tool) => (
            tool.status !== 'complete' || !String(tool.executable ?? '').trim()
            || (tool.id === 'dotnet'
                ? !String(tool.sdkVersion ?? '').trim()
                    || !Array.isArray(tool.runtimeVersions) || tool.runtimeVersions.length === 0
                : !String(tool.version ?? '').trim())
        )))
    {
        throw new Error('tool identity is incomplete');
    }
    if (!identity.build.toolchain || typeof identity.build.toolchain !== 'object'
        || productionBuildToolchainKeys.some((tool) => !String(identity.build.toolchain[tool] ?? '').trim()))
    {
        throw new Error('build toolchain identity is incomplete');
    }
    const expectedChildEnvironment = collectChildEnvironmentIdentity(catalog);
    if (identity.policy?.catalog?.status !== 'complete'
        || ['lifecycleActionRegistry', 'stateDomainRegistry'].some((field) => (
            identity.policy?.[field]?.status !== 'complete'
            || !digestPattern.test(identity.policy[field]?.fileDigest)
        ))
        || ['threshold', 'mutationSubset', 'releaseResource', 'physicalExecution']
            .some((field) => (
                identity.policy?.[field]?.status !== 'complete'
            || !digestPattern.test(identity.policy[field]?.fileDigest)
            ))
        || !digestPattern.test(identity.policy.catalog.fileDigest)
        || identity.policy.catalog.path !== 'config/testing/release-reliability-scenario-catalog.json'
        || identity.policy.lifecycleActionRegistry.path
            !== 'config/testing/release-reliability-lifecycle-action-registry.json'
        || identity.policy.stateDomainRegistry.path
            !== 'config/testing/runtime-state-domain-registry.json'
        || JSON.stringify(identity.policy.lifecycleActionRegistry)
            !== JSON.stringify(
                lifecycleContracts?.authorityBindings?.lifecycleActionRegistry
            )
        || JSON.stringify(identity.policy.stateDomainRegistry)
            !== JSON.stringify(
                lifecycleContracts?.authorityBindings?.stateDomainRegistry
            )
        || identity.policy.threshold.path !== catalog.policyBindings.loadProfile
        || identity.policy.mutationSubset.path !== catalog.policyBindings.mutationSubset
        || identity.policy.releaseResource.path !== catalog.policyBindings.releaseResource
        || identity.policy.physicalExecution.path
            !== catalog.policyBindings.physicalExecution
        || JSON.stringify(identity.policy.childEnvironment) !== JSON.stringify(expectedChildEnvironment)
        || identity.policy.executorSchema !== 'fsusblog.release-reliability-scenario-result.v3'
        || identity.policy.lifecycleSchema !== catalog.lifecycleSchema)
    {
        throw new Error('policy identity is incomplete');
    }
}

function validateScenarioForQualification(result, {
    repositoryRoot,
    invocationId,
    runId,
    identity,
    identityReference,
    catalog,
    lifecycleContracts
})
{
    const scenario = catalog.scenarios.find((candidate) => candidate.id === result?.scenarioId);
    if (result?.schema !== 'fsusblog.release-reliability-scenario-result.v3' || result.status !== 'passed')
    {
        throw new Error(`scenario ${result?.scenarioId ?? '<missing>'} is not passed`);
    }
    if (!scenario)
    {
        throw new Error(`scenario ${result.scenarioId} is not canonical`);
    }
    if (result.evidenceClass !== 'correctness' || result.qualificationEligible !== true)
    {
        throw new Error(`scenario ${result.scenarioId} is not qualification eligible correctness evidence`);
    }
    if (result.invocationId !== invocationId || result.runId !== runId)
    {
        throw new Error(`scenario ${result.scenarioId} run identity mismatch`);
    }
    if (result.contentDigest !== digestValue(result))
    {
        throw new Error(`scenario ${result.scenarioId} contentDigest mismatch`);
    }
    if (JSON.stringify(result.identity) !== JSON.stringify(identityReference))
    {
        throw new Error(`scenario ${result.scenarioId} identity reference mismatch`);
    }
    if (![result.startedAt, result.finishedAt, result.recordedAt].every(
        (value) => isoTimePattern.test(value) && Number.isFinite(Date.parse(value))
    )
        || Date.parse(result.startedAt) < Date.parse(identity.collectedAt)
        || Date.parse(result.finishedAt) < Date.parse(result.startedAt)
        || Date.parse(result.recordedAt) < Date.parse(result.finishedAt))
    {
        throw new Error(`scenario ${result.scenarioId} time ordering mismatch`);
    }
    const expectedResultPath = `.tmp/release-reliability/${invocationId}/scenario-results/${scenario.id}.json`;
    if (result.resultPath !== expectedResultPath || result.owner !== scenario.owner
        || result.resourceClass !== scenario.resourceClass || result.failure !== null
        || result.terminalFence?.status !== 'closed'
        || result.terminalFence?.lateEvidenceAccepted !== false
        || result.cancellation !== null)
    {
        throw new Error(`scenario ${result.scenarioId} result metadata mismatch`);
    }
    if (!digestPattern.test(result.authoritativeEvidence?.digest)
        || result.authoritativeEvidence?.path !== scenario.authoritativeEvidence.path
        || !scenario.authoritativeEvidence.expectedSchema.passStatusValues.includes(
            result.authoritativeEvidence.status
        )
        || scenario.authoritativeEvidence.expectedSchema.schema !== undefined
            && result.authoritativeEvidence.schema !== scenario.authoritativeEvidence.expectedSchema.schema)
    {
        throw new Error(`scenario ${result.scenarioId} evidence reference is incomplete`);
    }
    if (JSON.stringify(result.outputs) !== JSON.stringify([{
        id: 'authoritative-evidence',
        path: result.authoritativeEvidence.path,
        digest: result.authoritativeEvidence.digest
    }]))
    {
        throw new Error(`scenario ${result.scenarioId} outputs are incomplete`);
    }
    const producerKeys = [
        'executable',
        'args',
        'env',
        'environmentContract',
        'cwd',
        'commandDigest',
        'exitCode',
        'signal',
        'timedOut',
        'stdoutLog',
        'stderrLog',
        'processTreeReceipt'
    ];
    if (Object.hasOwn(result.producer ?? {}, 'schedulerGrant'))
    {
        producerKeys.push('schedulerGrant');
    }
    const commandToolId = path.basename(scenario.command.executable).replace(/\.exe$/iu, '');
    const expectedExecutable = identity.tools.find((tool) => tool.id === commandToolId)?.executable;
    const measurementActionId = scenario.isolation.lifecycle.measurement;
    const expectedLogRoot =
        `.tmp/release-reliability/${invocationId}/logs/lifecycle/${scenario.id}/${measurementActionId}`;
    const expectedCommandDigest = `sha256:${createHash('sha256')
        .update(JSON.stringify(scenario.command))
        .digest('hex')}`;
    if (!result.producer || JSON.stringify(Object.keys(result.producer).sort())
            !== JSON.stringify(producerKeys.sort())
        || !expectedExecutable || result.producer.executable !== expectedExecutable
        || JSON.stringify(result.producer.args) !== JSON.stringify(scenario.command.args)
        || JSON.stringify(result.producer.env) !== JSON.stringify(scenario.command.env)
        || JSON.stringify(result.producer.environmentContract)
            !== JSON.stringify(scenarioChildEnvironmentIdentity(catalog, scenario))
        || result.producer.cwd !== scenario.command.cwd
        || result.producer.commandDigest !== expectedCommandDigest
        || result.producer.exitCode !== 0 || result.producer.signal !== null
        || result.producer.timedOut !== false
        || result.producer.stdoutLog !== `${expectedLogRoot}.stdout.log`
        || result.producer.stderrLog !== `${expectedLogRoot}.stderr.log`
        || result.producer.processTreeReceipt?.status !== 'passed'
        || result.producer.processTreeReceipt?.postObservation !== 'zero-members'
        || result.producer.processTreeReceipt?.logComplete !== true
        || (Object.hasOwn(catalog, 'schedulerTimeoutPolicies')
            && (result.producer.schedulerGrant?.status !== 'granted'
                || result.producer.schedulerGrant?.scenarioId !== scenario.id
                || result.producer.schedulerGrant?.runId !== runId
                || typeof result.producer.schedulerGrant?.schedulerRunId !== 'string'
                || !result.producer.schedulerGrant.schedulerRunId
                || result.producer.schedulerGrant?.profileDigest
                    !== scenario.schedulerProfileDigest
                || result.producer.schedulerGrant?.granted?.cpuUnits
                    < scenario.scheduler.minCpuUnits))
        || JSON.stringify(result.producer.processTreeReceipt)
            !== JSON.stringify(result.lifecycle.actions.find(
                (record) => record.phase === 'measurement'
            )?.processTreeReceipt)
        || JSON.stringify(result.terminalFence)
            !== JSON.stringify(result.lifecycle.actions.find(
                (record) => record.phase === 'measurement'
            )?.terminalFence))
    {
        throw new Error(`scenario ${result.scenarioId} producer invocation mismatch`);
    }
    const lifecycleReferences = [
        ...scenario.isolation.lifecycle.preconditions.map((actionId) => ({
            actionId,
            phase: 'precondition'
        })),
        ...scenario.isolation.lifecycle.resetsBefore.map((actionId) => ({
            actionId,
            phase: 'reset-before'
        })),
        { actionId: measurementActionId, phase: 'measurement' },
        ...scenario.isolation.lifecycle.postconditions.map((actionId) => ({
            actionId,
            phase: 'postcondition'
        })),
        ...scenario.isolation.lifecycle.resetsAfter.map((actionId) => ({
            actionId,
            phase: 'reset-after'
        }))
    ];
    if (result.firstFailure !== null
        || !Array.isArray(result.cleanupFailures)
        || result.cleanupFailures.length !== 0
        || !Array.isArray(result.lifecycle?.actions)
        || !Array.isArray(result.lifecycle?.verifiedActionReceipts)
        || result.lifecycle.actions.length !== lifecycleReferences.length
        || result.lifecycle.verifiedActionReceipts.length !== lifecycleReferences.length)
    {
        throw new Error(`scenario ${result.scenarioId} lifecycle result is incomplete`);
    }
    const ownedDomains = new Set();
    let previousFinishedAt = null;
    for (let index = 0; index < lifecycleReferences.length; index += 1)
    {
        const expected = lifecycleReferences[index];
        const action = lifecycleContracts?.actions?.get(expected.actionId);
        const record = result.lifecycle.actions[index];
        const reference = result.lifecycle.verifiedActionReceipts[index];
        const measurement = expected.phase === 'measurement';
        const expectedPath = action?.expectedReceiptPath
            ?.replaceAll('{actionId}', expected.actionId)
            .replaceAll('{invocationId}', invocationId)
            .replaceAll('{runId}', runId)
            .replaceAll('{scenarioId}', scenario.id);
        for (const domain of reference?.stateDomains ?? [])
        {
            if (!measurement)
            {
                ownedDomains.add(domain);
            }
        }
        if (record?.actionId !== expected.actionId || record.phase !== expected.phase
            || record.status !== 'passed' || record.exitCode !== 0
            || record.signal !== null || record.timedOut !== false
            || record.failure !== null
            || JSON.stringify(record.receipt) !== JSON.stringify(reference)
            || !action || action.scenarioId !== scenario.id
            || action.phase !== expected.phase
            || reference?.actionId !== action.actionId
            || reference?.phase !== action.phase
            || reference?.path !== expectedPath
            || (action.expectedReceiptSchema === 'catalog-authoritative-evidence'
                ? reference?.schema !== result.authoritativeEvidence.schema
                : reference?.schema !== action.expectedReceiptSchema)
            || !Array.isArray(reference?.stateDomains)
            || JSON.stringify(reference.stateDomains)
                !== JSON.stringify(action.stateDomains)
            || (!measurement && !digestPattern.test(reference?.contentDigest))
            || (measurement && reference.contentDigest !== null
                && !digestPattern.test(reference.contentDigest))
            || !digestPattern.test(reference?.bytesDigest)
            || !action.passStatusValues.includes(reference?.status))
        {
            throw new Error(`scenario ${result.scenarioId} ${expected.actionId} reference is incomplete`);
        }
        const expectedProcessTreePath =
            `.tmp/release-reliability/${invocationId}/process-trees/` +
            `${scenario.id}/${action.actionId}.json`;
        if (record.processTreeReceipt?.path !== expectedProcessTreePath)
        {
            throw new Error(`scenario ${result.scenarioId} ${expected.actionId} process-tree path is invalid`);
        }
        const processTreeFile = resolveApprovedPath(
            repositoryRoot,
            record.processTreeReceipt.path,
            `${expected.actionId} process-tree receipt`
        );
        if (!fs.existsSync(processTreeFile.absolute)
            || !fs.lstatSync(processTreeFile.absolute).isFile())
        {
            throw new Error(`scenario ${result.scenarioId} ${expected.actionId} process-tree receipt is unavailable`);
        }
        const processTreeBytes = fs.readFileSync(processTreeFile.absolute);
        const processTreeDocument = JSON.parse(processTreeBytes.toString('utf8'));
        if (record.processTreeReceipt.bytesDigest !== rawDigest(processTreeBytes)
            || processTreeDocument.contentDigest
                !== record.processTreeReceipt.contentDigest
            || processTreeDocument.contentDigest
                !== digestValue(processTreeDocument)
            || processTreeDocument.invocationId !== invocationId
            || processTreeDocument.runId !== runId
            || processTreeDocument.scenarioId !== scenario.id
            || processTreeDocument.actionId !== action.actionId
            || processTreeDocument.phase !== action.phase
            || processTreeDocument.status !== 'passed'
            || JSON.stringify(processTreeDocument.identity)
                !== JSON.stringify(identityReference)
            || JSON.stringify(processTreeDocument.physicalPolicy)
                !== JSON.stringify(identity.policy.physicalExecution)
            || processTreeDocument.processTree?.postObservation !== 'zero-members'
            || processTreeDocument.logComplete !== true
            || record.processTreeReceipt.postObservation !== 'zero-members'
            || record.processTreeReceipt.logComplete !== true
            || record.terminalFence?.status !== 'closed'
            || record.terminalFence?.lateEvidenceAccepted !== false)
        {
            throw new Error(`scenario ${result.scenarioId} ${expected.actionId} process-tree receipt is incomplete`);
        }
        if (![record.startedAt, record.finishedAt].every(
            (value) => isoTimePattern.test(value) && Number.isFinite(Date.parse(value))
        )
            || Date.parse(record.startedAt) < Date.parse(result.startedAt)
            || Date.parse(record.finishedAt) < Date.parse(record.startedAt)
            || Date.parse(record.finishedAt) > Date.parse(result.finishedAt)
            || previousFinishedAt !== null && Date.parse(record.startedAt) < previousFinishedAt)
        {
            throw new Error(`scenario ${result.scenarioId} ${expected.actionId} time ordering mismatch`);
        }
        previousFinishedAt = Date.parse(record.finishedAt);
    }
    if (JSON.stringify([...ownedDomains].sort())
            !== JSON.stringify(scenario.isolation.exclusiveResources)
        || result.lifecycle.resetPostObservation?.status !== 'passed'
        || result.lifecycle.finalPostObservation?.status !== 'passed')
    {
        throw new Error(`scenario ${result.scenarioId} final lifecycle observations are incomplete`);
    }
}

function scenarioReference(result)
{
    return {
        scenarioId: result.scenarioId,
        resultPath: result.resultPath,
        resultContentDigest: result.contentDigest,
        evidencePath: result.authoritativeEvidence?.path ?? null,
        evidenceDigest: result.authoritativeEvidence?.digest ?? null,
        lifecycleActions: (result.lifecycle?.actions ?? []).map((action) => ({
            actionId: action.actionId,
            phase: action.phase,
            startedAt: action.startedAt,
            finishedAt: action.finishedAt,
            durationMs: action.durationMs,
            exitCode: action.exitCode,
            signal: action.signal,
            timedOut: action.timedOut,
            status: action.status,
            receipt: action.receipt,
            processTreeReceipt: action.processTreeReceipt,
            terminalFence: action.terminalFence
        })),
        resetPostObservation: result.lifecycle?.resetPostObservation ?? null,
        finalPostObservation: result.lifecycle?.finalPostObservation ?? null,
        firstFailure: result.firstFailure ?? null,
        cleanupFailures: result.cleanupFailures ?? []
    };
}

export function createTimeline({ invocationId, runId, scenarioResults, identityReference, createdAt })
{
    if (scenarioResults.some(result => result.invocationId !== invocationId
        || result.runId !== runId
        || JSON.stringify(result.identity) !== JSON.stringify(identityReference)
        || result.contentDigest !== digestValue(result)))
    {
        throw new Error('terminal timeline current-run identity or sealed result digest mismatch');
    }
    const references = scenarioResults.map(scenarioReference);
    references.sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
    return sealDocument({
        schema: 'fsusblog.release-reliability-timeline.v3',
        invocationId,
        runId,
        status: 'complete',
        terminalEvents: createTerminalEvents(scenarioResults),
        identity: identityReference,
        createdAt,
        scenarioResults: references
    });
}

export function createCandidateReceipt({
    repositoryRoot = process.cwd(),
    attemptEvidence = null,
    expectedCandidate = null,
    invocationId,
    runId,
    scenarioResults,
    identity,
    identityReference,
    timeline,
    timelineReference,
    catalog,
    lifecycleContracts,
    createdAt
})
{
    requireCleanAttemptConsumerAdmission({
        consumerId: 'release-reliability',
        attemptEvidence,
        expectedCandidate,
        candidateBinding: { sourceCommit: identity?.sourceState?.commit,
            worktreeFingerprint: normalizeFingerprint(identity?.sourceState?.worktreeFingerprint),
            schedulerRunId: runId, buildIdentity: identity?.build?.contentDigest },
        repositoryRoot
    });
    const receipt = {
        schema: 'fsusblog.release-reliability-candidate-receipt.v1',
        invocationId,
        runId,
        status: 'failed',
        identity: identityReference,
        timeline: timelineReference,
        scenarios: [],
        createdAt,
        failure: null
    };
    try
    {
        exactScenarioIds(scenarioResults, catalog, 'scenario results');
        validateIdentityReference(identityReference, invocationId);
        if (identity?.schema !== 'fsusblog.release-reliability-run-identity.v1'
            || identity.status !== 'complete' || identity.contentDigest !== digestValue(identity)
            || identity.invocationId !== invocationId || identity.runId !== runId
            || identity.contentDigest !== identityReference.contentDigest)
        {
            throw new Error('run identity is incomplete or mismatched');
        }
        validateCompleteIdentity(identity, catalog, lifecycleContracts);
        if (timelineReference?.path !== `.tmp/release-reliability/${invocationId}/timeline.json`
            || !digestPattern.test(timelineReference?.contentDigest))
        {
            throw new Error('timeline reference is incomplete');
        }
        if (timeline?.schema !== 'fsusblog.release-reliability-timeline.v3'
            || timeline.status !== 'complete' || timeline.invocationId !== invocationId
            || timeline.runId !== runId || timeline.contentDigest !== digestValue(timeline)
            || timeline.contentDigest !== timelineReference.contentDigest
            || JSON.stringify(timeline.identity) !== JSON.stringify(identityReference)
            || timeline.createdAt !== createdAt
            || !isoTimePattern.test(createdAt) || !Number.isFinite(Date.parse(createdAt)))
        {
            throw new Error('timeline is incomplete or mismatched');
        }
        for (const result of scenarioResults)
        {
            validateScenarioForQualification(result, {
                repositoryRoot,
                invocationId,
                runId,
                identity,
                identityReference,
                catalog,
                lifecycleContracts
            });
            receipt.scenarios.push(scenarioReference(result));
        }
        receipt.scenarios.sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
        if (JSON.stringify(timeline.scenarioResults) !== JSON.stringify(receipt.scenarios))
        {
            throw new Error('timeline scenario references are mismatched');
        }
        if (scenarioResults.some((result) => Date.parse(result.recordedAt) > Date.parse(createdAt)))
        {
            throw new Error('timeline precedes scenario result recording');
        }
        receipt.status = 'candidate';
    }
    catch (error)
    {
        receipt.failure = error instanceof Error ? error.message : String(error);
    }
    return sealDocument(receipt);
}
