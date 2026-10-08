#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const {collectProductionToolchain, verifyProductionBuildReceipt} = await import(new URL('../ci/production-build-artifacts.mjs', import.meta.url));
const {snapshotGitWorktree} = await import(new URL('../test-matrix/scheduler.mjs', import.meta.url));
const {validateReleaseReliabilitySchedulerCatalog} = await import(new URL('../test-matrix/release-reliability-scheduler-projection.mjs', import.meta.url));
import { parseRuntimeEnvironment } from './bundles/runtime-environment.mjs';
import { validateMutationReleaseParity, verifyReleaseArtifactBinding } from './mutation-release-parity.mjs';
import {
    expandLifecycleTemplate,
    lifecycleActionIds,
    loadLifecycleActionContracts
} from './release-reliability-lifecycle-actions.mjs';
import {
    projectQualifiedContainerEnvironment,
    releaseReliabilityAuditedContainerOverrides
} from './release-reliability-runtime-environment.mjs';
import { verifyTerminalEvents } from './release-reliability-terminal.mjs';
import {
    verifyLifecycleActionReceipt
} from './verify-release-reliability-lifecycle-action.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const isoTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const productionBuildToolchainKeys = ['dotnet', 'emsdk', 'node', 'npm', 'playwright', 'vite', 'vitest'];
const auditRetentionPolicyPath = 'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs';
const canonicalScenarioIds = [
    'release-soak-min',
    'release-load-peak',
    'release-load-burst',
    'release-data-scale-m',
    'release-mutation-critical-slice',
    'release-memory-leak-budget',
    'release-open-handle-budget'
];
const canonicalChildEnvironmentContract = {
    schema: 'fsusblog.release-reliability-child-environment.v1',
    requiredBaseKeys: ['HOME', 'PATH', 'XDG_RUNTIME_DIR'],
    optionalBaseKeys: ['LANG', 'LC_ALL', 'TMPDIR', 'TZ'],
    internalKeys: [
        'FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST',
        'FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH',
        'FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID',
        'FSUSBLOG_RELEASE_RELIABILITY_RUN_ID',
        'FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID',
        'FSUSBLOG_RELEASE_RESOURCE_CONTAINER_ID',
        'FSUSBLOG_RELEASE_RESOURCE_PID'
    ]
};
const canonicalPolicyBindings = {
    loadProfile: 'tests/performance/perf-policy.yml',
    mutationSubset: 'config/testing/mutation/release-parity-subset.json',
    physicalExecution: 'config/testing/physical-execution-process-policy.json',
    releaseResource: 'config/deployment/zero-downtime-resource-policy.json'
};
const canonicalRuntimeInheritedEnvironment = {
    required: [
        'FSUSBLOG_DEBUG_BACKEND_URL',
        'FSUSBLOG_POSTGRES_CONTAINER_NAME',
        'FSUSBLOG_REDIS_CONTAINER_NAME',
        'FSUSBLOG_TEST_NAMESPACE',
        'FSUSBLOG_TEST_RUN_ID'
    ],
    optional: []
};
const canonicalScenarioInheritedEnvironment = {
    'release-soak-min': canonicalRuntimeInheritedEnvironment,
    'release-load-peak': canonicalRuntimeInheritedEnvironment,
    'release-load-burst': canonicalRuntimeInheritedEnvironment,
    'release-data-scale-m': {
        required: [
            'FSUSBLOG_TEST_NAMESPACE',
            'FSUSBLOG_TEST_RUN_ID'
        ],
        optional: [
            'FSUSBLOG_AOT_CACHE_DIR',
            'FSUSBLOG_BACKEND_WEBROOT',
            'FSUSBLOG_DEBUG_BACKEND_URL',
            'FSUSBLOG_POSTGRES_CONTAINER_NAME',
            'FSUSBLOG_PUBLIC_AOT_CACHE_DIR',
            'FSUSBLOG_REDIS_CONTAINER_NAME',
            'FSUSBLOG_SEARCH_DIR',
            'FSUSBLOG_SEARCH_INDEX_DIR',
            'FSUSBLOG_WEB_ROOT'
        ]
    },
    'release-mutation-critical-slice': {
        required: [
            'FSUSBLOG_TEST_RUN_ID',
            'FSUSBLOG_TEST_SOURCE_COMMIT',
            'FSUSBLOG_TEST_SOURCE_FINGERPRINT'
        ],
        optional: [
            'FSUSBLOG_BACKEND_TEST_BIN_DIR',
            'FSUSBLOG_BACKEND_TEST_DLL',
            'FSUSBLOG_BACKEND_TEST_OBJ_DIR',
            'FSUSBLOG_PRODUCTION_BUILD_ROOT'
        ]
    },
    'release-memory-leak-budget': canonicalRuntimeInheritedEnvironment,
    'release-open-handle-budget': canonicalRuntimeInheritedEnvironment
};
const canonicalScenarioSemantics = {
    'release-soak-min': {
        env: {
            FSUSBLOG_CORRECTNESS_BUDGET_TIER_ID: 'soak-short-runtime',
            FSUSBLOG_MEASUREMENT_WINDOW_MS: '300000',
            FSUSBLOG_PRODUCER_EXECUTION_BUDGET_MS: '375000',
            FSUSBLOG_SOAK_INTERVAL_MS: '5000',
            FSUSBLOG_SOAK_MODE: 'short',
            FSUSBLOG_SOAK_SHORT_SECONDS: '300'
        },
        qualification: {
            kind: 'soak',
            mode: 'short',
            durationSeconds: 300,
            intervalMs: 5000,
            requestsPerProbe: 4,
            concurrency: 2,
            executionMode: 'runtime',
            countsAsReleaseFinal: true
        }
    },
    'release-load-peak': {
        env: {
            FSUSBLOG_LOAD_PROFILE_CONCURRENCY: '50',
            FSUSBLOG_LOAD_PROFILE_DURATION_MS: '60000',
            FSUSBLOG_LOAD_PROFILE_ROUNDS: '12'
        },
        qualification: {
            kind: 'load-profile',
            profile: 'expected-peak',
            policy: canonicalPolicyBindings.loadProfile,
            declared: { concurrency: 50, rounds: 12, durationMs: 60000 },
            thresholds: {
                maxP95Ms: 3000,
                maxP99Ms: 6000,
                maxErrorRate: 0,
                maxTimeoutRate: 0,
                minRps: 1
            }
        }
    },
    'release-load-burst': {
        env: {
            FSUSBLOG_LOAD_PROFILE_CONCURRENCY: '160',
            FSUSBLOG_LOAD_PROFILE_DURATION_MS: '15000',
            FSUSBLOG_LOAD_PROFILE_ROUNDS: '4'
        },
        qualification: {
            kind: 'load-profile',
            profile: 'burst',
            policy: canonicalPolicyBindings.loadProfile,
            declared: { concurrency: 160, rounds: 4, durationMs: 15000 },
            thresholds: {
                maxP95Ms: 5000,
                maxP99Ms: 10000,
                maxErrorRate: 0,
                maxTimeoutRate: 0,
                minRps: 1
            }
        }
    },
    'release-data-scale-m': {
        env: {
            FSUSBLOG_DATA_SCALE_CONCURRENCY: '2',
            FSUSBLOG_DATA_SCALE_PROVISION_MODE: 'full',
            FSUSBLOG_DATA_SCALE_REQUESTS: '12',
            FSUSBLOG_DATA_SCALE_ROOT: '.tmp/scale',
            FSUSBLOG_SCALE_TIER: 'scale-m'
        },
        qualification: {
            kind: 'data-scale',
            tier: 'scale-m',
            expectedSeed: { articles: 10000, comments: 100000 },
            requests: 12,
            concurrency: 2
        }
    },
    'release-mutation-critical-slice': {
        env: {
            FSUSBLOG_MUTATION_RELEASE_SUBSET_POLICY: canonicalPolicyBindings.mutationSubset,
            FSUSBLOG_RELEASE_MUTATION_PARITY: '1'
        },
        qualification: {
            kind: 'mutation-release-parity',
            policy: canonicalPolicyBindings.mutationSubset,
            subsetDigest: 'sha256:6705c0ae19b9468ff0d2acdb10ea8d98914ba3fc9a4faa0e3b60d4d29352b342',
            tierId: 'release-mutation-critical-slice',
            sliceId: 'release-mutation-critical-slice',
            releaseParity: true
        }
    },
    'release-memory-leak-budget': {
        env: {
            FSUSBLOG_RELEASE_RESOURCE_CONCURRENCY: '2',
            FSUSBLOG_RELEASE_RESOURCE_REQUESTS: '12',
            FSUSBLOG_RELEASE_RESOURCE_RSS_DELTA_THRESHOLD_BYTES: '67108864'
        },
        qualification: {
            kind: 'release-resource-budget',
            mode: 'memory-leak',
            requests: 12,
            concurrency: 2,
            metric: 'backend_rss_bytes',
            threshold: 67108864,
            thresholdKind: 'max_delta_bytes',
            thresholdOperator: '<=',
            policy: canonicalPolicyBindings.releaseResource
        }
    },
    'release-open-handle-budget': {
        env: {
            FSUSBLOG_RELEASE_RESOURCE_CONCURRENCY: '2',
            FSUSBLOG_RELEASE_RESOURCE_FD_DELTA_THRESHOLD: '16',
            FSUSBLOG_RELEASE_RESOURCE_REQUESTS: '12'
        },
        qualification: {
            kind: 'release-resource-budget',
            mode: 'open-handle',
            requests: 12,
            concurrency: 2,
            metric: 'backend_open_file_descriptors',
            threshold: 16,
            thresholdKind: 'max_delta_count',
            thresholdOperator: '<=',
            policy: canonicalPolicyBindings.releaseResource
        }
    }
};

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

function semanticDigest(value)
{
    const { contentDigest: _ignored, ...content } = value;
    void _ignored;
    return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`;
}

function sameJson(left, right)
{
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function childEnvironmentIdentity(catalog)
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
        contentDigest: semanticDigest(content)
    };
}

function scenarioEnvironmentContract(catalog, scenario)
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
        contentDigest: bytesDigest(Buffer.from(JSON.stringify(canonicalize(content))))
    };
}

function bytesDigest(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function safeId(value, label)
{
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(String(value ?? '')))
    {
        throw new Error(`${label} is invalid`);
    }
    return value;
}

function isoTime(value, label)
{
    if (!isoTimePattern.test(String(value ?? '')) || !Number.isFinite(Date.parse(value)))
    {
        throw new Error(`${label} must be an ISO UTC time`);
    }
}

function exactKeys(value, expected, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
    {
        throw new Error(`${label} fields are not exact`);
    }
}

function normalizedRelative(value, label)
{
    const raw = String(value ?? '').trim().replaceAll('\\', '/');
    const normalized = raw.replace(/^\.\//u, '');
    const segments = normalized.split('/');
    if (!normalized || path.posix.isAbsolute(normalized)
        || path.posix.normalize(normalized) !== normalized
        || segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    {
        throw new Error(`${label} path is unsafe`);
    }
    return normalized;
}

function safePath(repositoryRoot, value, label, expected = null)
{
    const relative = normalizedRelative(value, label);
    if (expected !== null && relative !== expected)
    {
        throw new Error(`${label} path is not canonical: ${relative}`);
    }
    const absolute = path.resolve(repositoryRoot, relative);
    if (absolute === repositoryRoot || !absolute.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error(`${label} path escapes approved root`);
    }
    let cursor = absolute;
    while (cursor !== repositoryRoot)
    {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
        {
            throw new Error(`${label} path contains a symlink`);
        }
        cursor = path.dirname(cursor);
    }
    return { absolute, relative };
}

function readRegularFile(repositoryRoot, value, label, expected = null)
{
    const resolved = safePath(repositoryRoot, value, label, expected);
    if (!fs.existsSync(resolved.absolute))
    {
        throw new Error(`${label} file is missing`);
    }
    const stat = fs.lstatSync(resolved.absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`${label} must be one regular non-symlink file`);
    }
    return { ...resolved, bytes: fs.readFileSync(resolved.absolute) };
}

function readJsonFile(repositoryRoot, value, label, expected = null)
{
    const file = readRegularFile(repositoryRoot, value, label, expected);
    try
    {
        return { ...file, document: JSON.parse(file.bytes.toString('utf8')) };
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

function verifyFileBinding(repositoryRoot, binding, label)
{
    if (binding?.status !== 'complete' || !digestPattern.test(binding?.fileDigest))
    {
        throw new Error(`${label} binding is incomplete`);
    }
    const file = readRegularFile(repositoryRoot, binding.path, label);
    if (bytesDigest(file.bytes) !== binding.fileDigest)
    {
        throw new Error(`${label} bytes digest mismatch`);
    }
    return file;
}

function resolveToolExecutable(tool)
{
    for (const directory of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
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

function collectTool(tool)
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
    const executable = resolveToolExecutable(tool);
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

function currentCgroup()
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
    const limits = {};
    for (const name of ['cpu.max', 'cpuset.cpus.effective', 'memory.max', 'pids.max'])
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

function uniqueStrings(values, { allowEmpty = false } = {})
{
    return Array.isArray(values) && (allowEmpty || values.length > 0)
        && values.every((value) => typeof value === 'string' && value.trim())
        && new Set(values).size === values.length;
}

function validateCatalog(catalog)
{
    const declaredTools = new Set((catalog?.scenarios ?? []).flatMap((scenario) => scenario.identityTools ?? []));
    if ((Object.hasOwn(catalog ?? {}, 'schedulerTimeoutPolicies')
            && validateReleaseReliabilitySchedulerCatalog(catalog).length > 0)
        || catalog?.schema !== 'fsusblog.release-reliability-scenario-catalog.v4'
        || catalog?.catalogScenarioCount !== 7
        || !Array.isArray(catalog.canonicalScenarioIds)
        || JSON.stringify(catalog.canonicalScenarioIds) !== JSON.stringify(canonicalScenarioIds)
        || new Set(catalog.canonicalScenarioIds).size !== 7
        || JSON.stringify(catalog.scenarios?.map((scenario) => scenario.id)) !== JSON.stringify(catalog.canonicalScenarioIds)
        || !Array.isArray(catalog.identityTools) || catalog.identityTools.length === 0
        || JSON.stringify(catalog.identityTools) !== JSON.stringify([...new Set(catalog.identityTools)].sort())
        || JSON.stringify([...declaredTools].sort()) !== JSON.stringify(catalog.identityTools)
        || !sameJson(catalog.childEnvironmentContract, canonicalChildEnvironmentContract)
        || !sameJson(catalog.policyBindings, canonicalPolicyBindings)
        || catalog.scenarios.some((scenario) => (
            !scenario.id || !scenario.owner || !scenario.resourceClass
            || !scenario.command?.executable || !Array.isArray(scenario.command.args)
            || scenario.command.args.some((argument) => typeof argument !== 'string')
            || !scenario.command.cwd || !scenario.command.env
            || typeof scenario.command.env !== 'object' || Array.isArray(scenario.command.env)
            || Object.values(scenario.command.env).some((value) => typeof value !== 'string')
            || !uniqueStrings(scenario.command.inheritEnv?.required)
            || !uniqueStrings(scenario.command.inheritEnv?.optional, { allowEmpty: true })
            || JSON.stringify(scenario.command.inheritEnv.required)
                !== JSON.stringify([...scenario.command.inheritEnv.required].sort())
            || JSON.stringify(scenario.command.inheritEnv.optional)
                !== JSON.stringify([...scenario.command.inheritEnv.optional].sort())
            || scenario.command.inheritEnv.required.some(
                (key) => scenario.command.inheritEnv.optional.includes(key)
                    || Object.hasOwn(scenario.command.env, key)
                    || catalog.childEnvironmentContract.internalKeys.includes(key)
            )
            || scenario.command.inheritEnv.optional.some(
                (key) => Object.hasOwn(scenario.command.env, key)
                    || catalog.childEnvironmentContract.internalKeys.includes(key)
            )
            || Object.keys(scenario.command.env).some(
                (key) => /(?:SECRET|TOKEN|PASSWORD|PRIVATE|SIGNING_KEY)/iu.test(key)
            )
            || !sameJson(scenario.command.env, canonicalScenarioSemantics[scenario.id]?.env)
            || !sameJson(
                scenario.command.inheritEnv,
                canonicalScenarioInheritedEnvironment[scenario.id]
            )
            || !sameJson(scenario.qualification, canonicalScenarioSemantics[scenario.id]?.qualification)
            || !Array.isArray(scenario.identityTools)
            || JSON.stringify(scenario.identityTools) !== JSON.stringify([...new Set(scenario.identityTools)].sort())
            || !scenario.identityTools.includes(
                path.basename(String(scenario.command?.executable ?? '')).replace(/\.exe$/iu, '')
            )
            || !uniqueStrings(scenario.isolation?.exclusiveResources)
            || !uniqueStrings(scenario.isolation?.countableResources, { allowEmpty: true })
            || scenario.isolation.exclusiveResources?.some(
                (resource) => scenario.isolation.countableResources.includes(resource)
            )
            || JSON.stringify(Object.keys(
                scenario.isolation.lifecycle ?? {}
            ).sort()) !== JSON.stringify([
                'measurement',
                'postconditions',
                'preconditions',
                'resetsAfter',
                'resetsBefore'
            ])
            || JSON.stringify(scenario.isolation.outputs) !== JSON.stringify([{
                id: 'authoritative-evidence',
                path: scenario.authoritativeEvidence?.path
            }])
            || !scenario.authoritativeEvidence?.path
            || !uniqueStrings(scenario.authoritativeEvidence.expectedSchema?.required)
            || !uniqueStrings(scenario.authoritativeEvidence.expectedSchema?.passStatusValues)
        ))
        || catalog.actionRegistry
            !== 'config/testing/release-reliability-lifecycle-action-registry.json'
        || catalog.lifecycleSchema
            !== 'fsusblog.release-reliability-lifecycle-action-receipt.v2')
    {
        throw new Error('canonical scenario catalog is invalid');
    }
}

function verifyBuild(repositoryRoot, identity)
{
    const binding = identity.build;
    if (binding?.status !== 'complete' || !digestPattern.test(binding.imageDigest)
        || !digestPattern.test(binding.contentDigest))
    {
        throw new Error('build identity is incomplete');
    }
    const image = binding.image;
    const localImage = image?.kind === 'local-docker-image-id'
        && image.revision === identity.sourceState.commit
        && ['published-package', 'local-git-alias'].includes(image.fsusuiSource)
        && /^[0-9a-f]{40}$/u.test(image.fsusuiCommit ?? '')
        && !(image.fsusuiSource === 'local-git-alias' && image.fsusuiCommit === '0'.repeat(40))
        && Array.isArray(image.layers) && image.layers.length > 0
        && image.layers.every((layer) => digestPattern.test(layer))
        && image.layersDigest === semanticDigest({ layers: image.layers });
    const registryImage = image?.kind === 'registry-repository-digest'
        && /@sha256:[0-9a-f]{64}$/u.test(image.repositoryDigest ?? '')
        && image.revision === identity.sourceState.commit
        && ['published-package', 'local-git-alias'].includes(image.fsusuiSource)
        && /^[0-9a-f]{40}$/u.test(image.fsusuiCommit ?? '')
        && !(image.fsusuiSource === 'local-git-alias' && image.fsusuiCommit === '0'.repeat(40));
    if (image?.imageDigest !== binding.imageDigest
        || typeof image?.reference !== 'string' || !image.reference
        || (!localImage && !registryImage))
    {
        throw new Error('build image authority is incomplete or not an inspected concrete digest');
    }
    const file = verifyFileBinding(repositoryRoot, binding, 'build receipt');
    const receipt = JSON.parse(file.bytes.toString('utf8'));
    verifyProductionBuildReceipt({
        artifactRoot: path.dirname(file.absolute),
        expectedSourceState: identity.sourceState,
        expectedProducer: { runId: identity.runId, job: 'production-build-artifacts' },
        expectedToolchain: collectProductionToolchain({ root: repositoryRoot }),
        expectedInputRoot: repositoryRoot,
        expectedReceiptDigest: binding.contentDigest
    });
    if (receipt.schema !== 'fsusblog.ci-production-build-receipt.v1' || receipt.status !== 'complete'
        || receipt.contentDigest !== semanticDigest(receipt) || receipt.contentDigest !== binding.contentDigest
        || !sameSourceState(receipt.sourceState, identity.sourceState)
        || String(receipt.producer?.runId ?? '') !== identity.runId
        || JSON.stringify(receipt.toolchain) !== JSON.stringify(binding.toolchain)
        || !receipt.toolchain || typeof receipt.toolchain !== 'object' || Array.isArray(receipt.toolchain)
        || productionBuildToolchainKeys.some((tool) => !String(receipt.toolchain[tool] ?? '').trim()))
    {
        throw new Error('build receipt content/source/run/toolchain mismatch');
    }
    const inspected = spawnSync('docker', ['image', 'inspect', image.reference], { encoding: 'utf8' });
    if (inspected.status !== 0)
    {
        throw new Error('runtime image docker inspect failed');
    }
    const documents = JSON.parse(inspected.stdout);
    if (!Array.isArray(documents) || documents.length !== 1)
    {
        throw new Error('runtime image inspect did not return exactly one image');
    }
    const liveImage = documents[0];
    if (liveImage?.Config?.Labels?.['org.opencontainers.image.revision'] !== identity.sourceState.commit
        || liveImage?.Config?.Labels?.['io.fsusblog.build.fsusui-source'] !== image.fsusuiSource
        || liveImage?.Config?.Labels?.['io.fsusblog.build.fsusui-commit'] !== image.fsusuiCommit)
    {
        throw new Error('runtime image source or FsusUI producer labels changed');
    }
    if (image.kind === 'local-docker-image-id')
    {
        const layers = liveImage?.RootFS?.Layers;
        if (liveImage?.Id !== image.imageDigest
            || !Array.isArray(layers) || JSON.stringify(layers) !== JSON.stringify(image.layers)
            || image.layersDigest !== semanticDigest({ layers }))
        {
            throw new Error('runtime image ID, source revision, or RootFS layers changed');
        }
    }
    else if (!Array.isArray(liveImage?.RepoDigests) || !liveImage.RepoDigests.includes(image.repositoryDigest))
    {
        throw new Error('runtime registry image digest is no longer live');
    }
    return liveImage;
}

function inspectContainerProcess(containerId)
{
    const read = (label, command) =>
    {
        const result = spawnSync('docker', ['exec', containerId, 'sh', '-c', command], { encoding: 'utf8' });
        if (result.status !== 0)
        {
            throw new Error(`fixture backend container procfs ${label} inspect failed`);
        }
        return result.stdout;
    };
    const stat = read('stat', 'cat /proc/1/stat');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const lines = (value) => value.split(/\r?\n/u).filter(Boolean);
    const environment = Object.fromEntries(lines(read('environment', "tr '\\000' '\\n' </proc/1/environ")).map((entry) =>
    {
        const separator = entry.indexOf('=');
        return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    return {
        pid: 1,
        processGroupId: Number(tail[2]),
        sessionId: Number(tail[3]),
        startTimeTicks: tail[19],
        executable: read('executable', 'readlink -f /proc/1/exe').trim(),
        commandLine: lines(read('command line', "tr '\\000' '\\n' </proc/1/cmdline")),
        workingDirectory: read('working directory', 'readlink -f /proc/1/cwd').trim(),
        environment
    };
}

function verifyFixture(repositoryRoot, fixture, identity, runtimeImage)
{
    if (fixture?.status !== 'complete' || !fixture.root || !fixture.namespace)
    {
        throw new Error('fixture identity is incomplete');
    }
    const fixtureRoot = safePath(repositoryRoot, fixture.root, 'fixture root');
    if (!fs.existsSync(fixtureRoot.absolute) || !fs.lstatSync(fixtureRoot.absolute).isDirectory()
        || fs.lstatSync(fixtureRoot.absolute).isSymbolicLink())
    {
        throw new Error('fixture root must be one real directory');
    }
    const fixtureFiles = {};
    for (const field of ['config', 'schema', 'seed', 'auditRetentionPolicy', 'topology'])
    {
        fixtureFiles[field] = verifyFileBinding(repositoryRoot, fixture[field], `fixture ${field}`);
    }
    if (fixture.auditRetentionPolicy.path !== auditRetentionPolicyPath)
    {
        throw new Error('fixture audit retention policy path is not canonical');
    }
    const runtimeEnvironment = parseRuntimeEnvironment(
        fixtureFiles.config.bytes.toString('utf8'),
        fixture.namespace
    );
    if (runtimeEnvironment.FSUSBLOG_TEST_RUN_ID !== identity.runId
        || runtimeEnvironment.ASPNETCORE_URLS !== runtimeEnvironment.FSUSBLOG_DEBUG_BACKEND_URL)
    {
        throw new Error('fixture config does not bind the verified run and backend URL');
    }
    const topologyFile = readJsonFile(repositoryRoot, fixture.topology.path, 'fixture topology');
    const topology = topologyFile.document;
    if (topology.schema !== 'fsusblog.release-reliability-runtime-topology.v1'
        || topology.status !== 'complete' || topology.runId !== identity.runId
        || topology.namespace !== fixture.namespace || !topology.runtime?.profile
        || topology.root !== fixture.root
        || JSON.stringify(topology.config) !== JSON.stringify({ path: fixture.config.path, fileDigest: fixture.config.fileDigest })
        || JSON.stringify(topology.schemaFile) !== JSON.stringify({ path: fixture.schema.path, fileDigest: fixture.schema.fileDigest })
        || JSON.stringify(topology.seed) !== JSON.stringify({ path: fixture.seed.path, fileDigest: fixture.seed.fileDigest })
        || JSON.stringify(topology.auditRetentionPolicy) !== JSON.stringify({
            path: fixture.auditRetentionPolicy.path,
            fileDigest: fixture.auditRetentionPolicy.fileDigest
        })
        || topology.runtime?.imageDigest !== identity.build.imageDigest
        || !sameSourceState(topology.runtime?.sourceState, identity.sourceState)
        || topology.runtime?.image?.id !== identity.build.imageDigest
        || topology.runtime?.image?.reference !== identity.build.image?.reference
        || topology.runtime?.image?.revision !== identity.sourceState.commit
        || JSON.stringify(topology.runtime?.image?.layers) !== JSON.stringify(identity.build.image?.layers)
        || topology.runtime?.image?.layersDigest !== identity.build.image?.layersDigest
        || !topology.runtime?.backendContainer?.id
        || !Number.isInteger(topology.runtime?.backendContainer?.hostPid)
        || topology.runtime.backendContainer.hostPid < 2
        || !Array.isArray(topology.runtime?.backendContainer?.environment)
        || !topology.runtime?.backendContainer?.path
        || !Array.isArray(topology.runtime?.backendContainer?.args)
        || !topology.runtime?.backendContainer?.startedAt
        || topology.runtime?.process?.pid !== 1
        || !topology.postgres?.instance || !topology.postgres?.version
        || !digestPattern.test(topology.postgres?.configDigest)
        || !topology.redis?.instance || !topology.redis?.version
        || !digestPattern.test(topology.redis?.configDigest)
        || topology.contentDigest !== semanticDigest(topology)
        || fixture.topology.content?.contentDigest !== topology.contentDigest
        || JSON.stringify(fixture.topology.content?.postgres) !== JSON.stringify(topology.postgres)
        || JSON.stringify(fixture.topology.content?.redis) !== JSON.stringify(topology.redis)
        || JSON.stringify(fixture.topology.content?.auditRetentionPolicy) !== JSON.stringify(
            topology.auditRetentionPolicy
        )
        || JSON.stringify(fixture.topology.content?.runtime) !== JSON.stringify(topology.runtime))
    {
        throw new Error('fixture topology content identity is incomplete or mismatched');
    }
    const backendContainerInspection = spawnSync('docker', ['inspect', topology.runtime.backendContainer.id], { encoding: 'utf8' });
    if (backendContainerInspection.status !== 0)
    {
        throw new Error('fixture backend app container inspect failed');
    }
    const [backendContainer] = JSON.parse(backendContainerInspection.stdout);
    const topologyHealth = topology.runtime.backendContainer.health;
    const containerHealthcheck = backendContainer?.Config?.Healthcheck;
    const imageHealthcheck = runtimeImage?.Config?.Healthcheck;
    const expectedHealthcheckDigest = bytesDigest(Buffer.from(JSON.stringify(
        canonicalize(containerHealthcheck)
    )));
    const backendHostPort = runtimeEnvironment.FSUSBLOG_DEBUG_BACKEND_PORT;
    const configuredPortBindings = backendContainer?.HostConfig?.PortBindings?.['8080/tcp'];
    const observedPortBindings = backendContainer?.NetworkSettings?.Ports?.['8080/tcp'];
    const validPortBinding = (bindings) => Array.isArray(bindings) && bindings.length === 1
        && bindings[0]?.HostIp === '127.0.0.1' && bindings[0]?.HostPort === backendHostPort;
    if (!backendContainer?.State?.Running
        || backendContainer.Image !== identity.build.imageDigest
        || backendContainer.Config?.Image !== identity.build.image.reference
        || backendContainer.Id !== topology.runtime.backendContainer.id
        || backendContainer.State.Pid !== topology.runtime.backendContainer.hostPid
        || backendContainer.State.StartedAt !== topology.runtime.backendContainer.startedAt
        || backendContainer.Path !== topology.runtime.backendContainer.path
        || JSON.stringify(backendContainer.Args) !== JSON.stringify(topology.runtime.backendContainer.args)
        || JSON.stringify(backendContainer.Config.Env) !== JSON.stringify(topology.runtime.backendContainer.environment)
        || backendContainer.Config?.Labels?.['io.fsusblog.test.run-id'] !== identity.runId
        || backendContainer.Config?.Labels?.['io.fsusblog.test.namespace'] !== fixture.namespace
        || backendContainer.State?.Health?.Status !== 'healthy'
        || topologyHealth?.status !== 'healthy'
        || !sameJson(containerHealthcheck, imageHealthcheck)
        || !sameJson(topologyHealth?.configuration, containerHealthcheck)
        || topologyHealth?.configurationDigest !== expectedHealthcheckDigest
        || !Object.hasOwn(backendContainer.Config?.ExposedPorts ?? {}, '8080/tcp')
        || !validPortBinding(configuredPortBindings)
        || !validPortBinding(observedPortBindings)
        || !sameJson(topology.runtime.backendContainer.portBinding, {
            containerPort: 8080,
            hostIp: '127.0.0.1',
            hostPort: Number(backendHostPort),
            protocol: 'tcp'
        }))
    {
        throw new Error('fixture backend app container no longer binds image, health, port, ownership, and PID');
    }
    const liveProcess = inspectContainerProcess(backendContainer.Id);
    const configuredEnvironment = Object.fromEntries(backendContainer.Config.Env.map((entry) =>
    {
        const separator = entry.indexOf('=');
        return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    const configuredEnvironmentEntries = backendContainer.Config.Env;
    const configuredEnvironmentKeys = configuredEnvironmentEntries.map((entry) =>
    {
        const separator = entry.indexOf('=');
        return separator < 1 ? entry : entry.slice(0, separator);
    });
    const imageEnvironmentEntries = runtimeImage.Config?.Env ?? [];
    const imageEnvironmentKeys = imageEnvironmentEntries.map((entry) =>
    {
        const separator = entry.indexOf('=');
        return separator < 1 ? entry : entry.slice(0, separator);
    });
    const imageEnvironment = Object.fromEntries(imageEnvironmentEntries.map((entry) =>
    {
        const separator = entry.indexOf('=');
        return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    const expectedContainerEnvironment = {
        ...imageEnvironment,
        ...projectQualifiedContainerEnvironment(runtimeEnvironment),
        ...releaseReliabilityAuditedContainerOverrides({
            runId: identity.runId,
            namespace: fixture.namespace,
            sourceCommit: identity.sourceState.commit,
            sourceFingerprint: topology.runtime.sourceState.worktreeFingerprint
        })
    };
    if (JSON.stringify(liveProcess) !== JSON.stringify(topology.runtime.process)
        || liveProcess.pid !== 1 || liveProcess.processGroupId !== 1 || liveProcess.sessionId !== 1
        || new Set(configuredEnvironmentKeys).size !== configuredEnvironmentKeys.length
        || new Set(imageEnvironmentKeys).size !== imageEnvironmentKeys.length
        || !sameJson(configuredEnvironment, expectedContainerEnvironment)
        || !sameJson(liveProcess.environment, expectedContainerEnvironment)
        || topology.runtime.environmentProjection?.source !== 'strict-runtime-env-plus-audited-container-overrides'
        || !sameJson(topology.runtime.environmentProjection?.effective, expectedContainerEnvironment)
        || configuredEnvironment.FSUSBLOG_TEST_RUN_ID !== identity.runId
        || configuredEnvironment.FSUSBLOG_TEST_NAMESPACE !== fixture.namespace
        || configuredEnvironment.FSUSBLOG_RUNTIME_ROLE !== 'backend'
        || configuredEnvironment.FSUSBLOG_TEST_SOURCE_COMMIT !== identity.sourceState.commit
        || normalizeFingerprint(configuredEnvironment.FSUSBLOG_TEST_SOURCE_FINGERPRINT) !== normalizeFingerprint(identity.sourceState.worktreeFingerprint)
        || ['FSUSBLOG_TEST_RUN_ID', 'FSUSBLOG_TEST_NAMESPACE', 'FSUSBLOG_RUNTIME_ROLE', 'FSUSBLOG_TEST_SOURCE_COMMIT', 'FSUSBLOG_TEST_SOURCE_FINGERPRINT']
            .some((key) => liveProcess.environment[key] !== configuredEnvironment[key])
        || JSON.stringify(liveProcess.commandLine) !== JSON.stringify([backendContainer.Path, ...backendContainer.Args])
        || !liveProcess.commandLine.some((argument) => /FsusBlog\.Server(?:\.dll)?$/u.test(argument)))
    {
        throw new Error('fixture backend Docker/procfs identity does not match the live runtime authority');
    }
    const serviceContainers = {};
    for (const [label, entry, configuredName] of [
        ['postgres', topology.postgres, runtimeEnvironment.FSUSBLOG_POSTGRES_CONTAINER_NAME],
        ['redis', topology.redis, runtimeEnvironment.FSUSBLOG_REDIS_CONTAINER_NAME]
    ])
    {
        if (!configuredName)
        {
            throw new Error(`fixture ${label} configured container name is missing`);
        }
        const inspected = spawnSync('docker', ['inspect', configuredName], { encoding: 'utf8' });
        if (inspected.status !== 0)
        {
            throw new Error(`fixture ${label} docker inspect failed`);
        }
        const [container] = JSON.parse(inspected.stdout);
        if (!container?.State?.Running || container.Id !== entry.instance)
        {
            throw new Error(`fixture ${label} container identity changed or stopped`);
        }
        const liveDigest = semanticDigest({
            id: container.Id,
            image: container.Config?.Image,
            imageId: container.Image,
            labels: container.Config?.Labels ?? {}
        });
        if (liveDigest !== entry.configDigest)
        {
            throw new Error(`fixture ${label} inspected topology digest mismatch`);
        }
        serviceContainers[label] = container;
    }
    const networkInspection = spawnSync(
        'docker',
        ['network', 'inspect', topology.runtime.network?.name],
        { encoding: 'utf8' }
    );
    if (networkInspection.status !== 0)
    {
        throw new Error('fixture runtime network inspect failed');
    }
    const [runtimeNetwork] = JSON.parse(networkInspection.stdout);
    if (!runtimeNetwork?.Id
        || runtimeNetwork.Id !== topology.runtime.network?.id
        || runtimeNetwork.Name !== topology.runtime.network?.name
        || runtimeNetwork.Driver !== 'bridge'
        || topology.runtime.network?.driver !== 'bridge'
        || !sameJson(runtimeNetwork.Labels ?? {}, topology.runtime.network?.labels)
        || runtimeNetwork.Labels?.['io.fsusblog.test.run-id'] !== identity.runId
        || runtimeNetwork.Labels?.['io.fsusblog.test.namespace'] !== fixture.namespace)
    {
        throw new Error('fixture runtime network identity or ownership changed');
    }
    const verifyAttachment = (container, label, authority, requiredAlias = null) =>
    {
        const attachment = container?.NetworkSettings?.Networks?.[runtimeNetwork.Name];
        const aliases = Array.isArray(attachment?.Aliases) ? [...attachment.Aliases].sort() : [];
        if (!attachment
            || authority?.containerId !== container.Id
            || authority.networkId !== runtimeNetwork.Id
            || attachment.NetworkID !== runtimeNetwork.Id
            || authority.ipv4Address !== attachment.IPAddress
            || !sameJson(authority.aliases, aliases)
            || requiredAlias !== null && !aliases.includes(requiredAlias))
        {
            throw new Error(`fixture ${label} runtime network attachment changed`);
        }
        return aliases;
    };
    const backendAliases = verifyAttachment(
        backendContainer,
        'backend',
        topology.runtime.network.backend
    );
    const postgresAliases = verifyAttachment(
        serviceContainers.postgres,
        'postgres',
        topology.runtime.network.postgres,
        'postgres'
    );
    const redisAliases = verifyAttachment(
        serviceContainers.redis,
        'redis',
        topology.runtime.network.redis,
        'redis'
    );
    const expectedContainerIds = [
        backendContainer.Id,
        serviceContainers.postgres.Id,
        serviceContainers.redis.Id
    ].sort();
    if (backendAliases.includes('postgres') || backendAliases.includes('redis')
        || postgresAliases.includes('redis') || redisAliases.includes('postgres')
        || !sameJson(Object.keys(runtimeNetwork.Containers ?? {}).sort(), expectedContainerIds))
    {
        throw new Error('fixture runtime network aliases or membership changed');
    }
}

async function verifyIdentity(
    repositoryRoot,
    identityReference,
    catalog,
    lifecycleContracts,
    invocationId,
    runId
)
{
    exactKeys(identityReference, ['path', 'contentDigest'], 'identity reference');
    if (!digestPattern.test(identityReference.contentDigest))
    {
        throw new Error('identity reference digest is invalid');
    }
    const expectedPath = `.tmp/release-reliability/${invocationId}/identity.json`;
    const file = readJsonFile(repositoryRoot, identityReference.path, 'run identity', expectedPath);
    const identity = file.document;
    exactKeys(identity, [
        'schema',
        'status',
        'invocationId',
        'runId',
        'sourceState',
        'build',
        'fixture',
        'machine',
        'tools',
        'policy',
        'collectedAt',
        'collectionErrors',
        'contentDigest'
    ], 'run identity');
    if (identity.schema !== 'fsusblog.release-reliability-run-identity.v1' || identity.status !== 'complete'
        || identity.invocationId !== invocationId || identity.runId !== runId
        || identity.contentDigest !== semanticDigest(identity)
        || identity.contentDigest !== identityReference.contentDigest)
    {
        throw new Error('run identity schema/status/run/contentDigest mismatch');
    }
    isoTime(identity.collectedAt, 'identity.collectedAt');
    if (!Array.isArray(identity.collectionErrors) || identity.collectionErrors.length !== 0)
    {
        throw new Error('run identity contains collection errors');
    }
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
    const snapshot = await snapshotGitWorktree(repositoryRoot);
    if (identity.sourceState?.commit !== commit
        || normalizeFingerprint(identity.sourceState?.worktreeFingerprint) !== normalizeFingerprint(snapshot.fingerprint)
        || identity.sourceState?.dirtyPathCount !== Object.keys(snapshot.entries).length
        || identity.sourceState?.hashedPathCount !== snapshot.hashedPathCount)
    {
        throw new Error('run source identity does not match the current worktree bytes/mode/index state');
    }
    const runtimeImage = verifyBuild(repositoryRoot, identity);
    verifyFixture(repositoryRoot, identity.fixture, identity, runtimeImage);
    const cpus = os.cpus();
    const currentMachine = {
        os: `${os.platform()} ${os.release()}`,
        architecture: os.arch(),
        cpuModels: [...new Set(cpus.map((cpu) => cpu.model))].sort(),
        cpuCount: cpus.length,
        memoryBytes: os.totalmem(),
        cgroup: currentCgroup()
    };
    if (identity.machine?.status !== 'complete'
        || currentMachine.cgroup.status !== 'complete'
        || identity.machine.os !== currentMachine.os
        || identity.machine.architecture !== currentMachine.architecture
        || JSON.stringify(identity.machine.cpuModels) !== JSON.stringify(currentMachine.cpuModels)
        || identity.machine.cpuCount !== currentMachine.cpuCount
        || identity.machine.memoryBytes !== currentMachine.memoryBytes
        || JSON.stringify(identity.machine.cgroup) !== JSON.stringify(currentMachine.cgroup))
    {
        throw new Error('machine cgroup identity is unavailable or changed');
    }
    verifyFileBinding(repositoryRoot, identity.machine.schedulerPolicy, 'scheduler resource policy');
    const actualTools = [...catalog.identityTools].sort().map(collectTool);
    if (actualTools.some((tool) => tool.status !== 'complete')
        || JSON.stringify(identity.tools) !== JSON.stringify(actualTools))
    {
        throw new Error('tool identity is unavailable or changed');
    }
    if (identity.policy?.executorSchema !== 'fsusblog.release-reliability-scenario-result.v3'
        || identity.policy?.lifecycleSchema !== catalog.lifecycleSchema
        || identity.policy?.catalog?.path !== 'config/testing/release-reliability-scenario-catalog.json'
        || identity.policy?.lifecycleActionRegistry?.path
            !== 'config/testing/release-reliability-lifecycle-action-registry.json'
        || identity.policy?.stateDomainRegistry?.path
            !== 'config/testing/runtime-state-domain-registry.json')
    {
        throw new Error('policy identity schema/path mismatch');
    }
    const catalogFile = verifyFileBinding(repositoryRoot, identity.policy.catalog, 'scenario catalog');
    if (catalogFile.relative !== 'config/testing/release-reliability-scenario-catalog.json')
    {
        throw new Error('scenario catalog path is not canonical');
    }
    exactKeys(identity.policy, [
        'catalog',
        'lifecycleActionRegistry',
        'stateDomainRegistry',
        'threshold',
        'mutationSubset',
        'releaseResource',
        'physicalExecution',
        'childEnvironment',
        'executorSchema',
        'lifecycleSchema'
    ], 'run identity policy');
    for (const [field, label] of [
        ['lifecycleActionRegistry', 'lifecycle action registry'],
        ['stateDomainRegistry', 'runtime state-domain registry']
    ])
    {
        verifyFileBinding(
            repositoryRoot,
            identity.policy[field],
            label
        );
        if (JSON.stringify(identity.policy[field])
            !== JSON.stringify(lifecycleContracts.authorityBindings[field]))
        {
            throw new Error(`${label} identity changed`);
        }
    }
    const policyFiles = [
        ['threshold', 'loadProfile', 'threshold policy'],
        ['mutationSubset', 'mutationSubset', 'mutation subset policy'],
        ['releaseResource', 'releaseResource', 'release resource policy'],
        ['physicalExecution', 'physicalExecution', 'physical execution policy']
    ];
    for (const [field, bindingKey, label] of policyFiles)
    {
        if (identity.policy[field]?.path !== catalog.policyBindings[bindingKey])
        {
            throw new Error(`${label} path is not canonical`);
        }
        verifyFileBinding(repositoryRoot, identity.policy[field], label);
    }
    if (JSON.stringify(identity.policy.childEnvironment)
        !== JSON.stringify(childEnvironmentIdentity(catalog)))
    {
        throw new Error('child environment policy identity mismatch');
    }
    return identity;
}

function yamlSection(text, name, indent = 0)
{
    const prefix = ' '.repeat(indent);
    const pattern = new RegExp(
        `(?:^|\\r?\\n)${prefix}${name}:\\r?\\n([\\s\\S]*?)(?=\\r?\\n${prefix}\\S|$)`,
        'u'
    );
    return text.match(pattern)?.[1] ?? '';
}

function yamlScalarMap(text)
{
    const values = {};
    for (const line of text.split(/\r?\n/u))
    {
        const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*):\s*(\d+)\s*$/u);
        if (match)
        {
            values[match[1]] = Number(match[2]);
        }
    }
    return values;
}

function verifiedLoadProfilePolicy(repositoryRoot, identity, profile)
{
    const file = verifyFileBinding(repositoryRoot, identity.policy.threshold, 'threshold policy');
    const text = file.bytes.toString('utf8');
    const values = yamlScalarMap(yamlSection(yamlSection(text, 'loadProfiles'), profile, 2));
    const declared = {
        concurrency: values.concurrency,
        rounds: values.rounds,
        durationMs: values.durationMs
    };
    const thresholds = {
        maxP95Ms: values.maxP95Ms,
        maxP99Ms: values.maxP99Ms,
        maxErrorRate: values.maxErrorRate,
        maxTimeoutRate: values.maxTimeoutRate,
        minRps: values.minRps
    };
    if (Object.values(declared).some((value) => !Number.isInteger(value) || value <= 0)
        || Object.values(thresholds).some((value) => !Number.isFinite(value) || value < 0))
    {
        throw new Error(`load profile ${profile} policy is incomplete`);
    }
    return {
        file: file.relative,
        fileDigest: bytesDigest(file.bytes),
        version: text.match(/^version:\s*(\S+)/mu)?.[1] ?? null,
        declared,
        thresholds
    };
}

function verifyLoadProfileEvidence(repositoryRoot, document, scenario, identity)
{
    const qualification = scenario.qualification;
    const policy = verifiedLoadProfilePolicy(repositoryRoot, identity, qualification.profile);
    const routeCatalogFile = readJsonFile(
        repositoryRoot,
        'config/testing/runtime-http-route-contracts.json',
        'runtime HTTP route catalog'
    );
    const routeIds = routeCatalogFile.document?.producers?.['runtime-load-soak'];
    const routeCatalogDigest = bytesDigest(
        Buffer.from(JSON.stringify(routeCatalogFile.document))
    );
    if (!sameJson(policy.declared, qualification.declared)
        || !sameJson(policy.thresholds, qualification.thresholds)
        || document.profile !== qualification.profile
        || document.profileName !== qualification.profile
        || !sameJson(document.policy, {
            file: policy.file,
            fileDigest: policy.fileDigest,
            version: policy.version
        })
        || !sameJson(document.declared, policy.declared)
        || !sameJson(document.effective, policy.declared)
        || document.overrideSource !== 'env'
        || !sameJson(document.overrideSources, {
            concurrency: 'env:FSUSBLOG_LOAD_PROFILE_CONCURRENCY',
            rounds: 'env:FSUSBLOG_LOAD_PROFILE_ROUNDS',
            durationMs: 'env:FSUSBLOG_LOAD_PROFILE_DURATION_MS'
        })
        || !sameJson(document.thresholds, policy.thresholds)
        || !sameJson(document.sampling, {
            totalRequests: policy.declared.concurrency * policy.declared.rounds,
            concurrency: policy.declared.concurrency,
            rounds: policy.declared.rounds,
            durationMs: policy.declared.durationMs,
            routeIds
        })
        || !Array.isArray(routeIds) || routeIds.length === 0
        || document.runtime?.sampleCount !== document.sampling.totalRequests
        || document.runtime?.concurrency !== document.sampling.concurrency
        || document.runtime?.routeContractDigest !== routeCatalogDigest)
    {
        throw new Error(`scenario ${scenario.id} effective load policy/sampling mismatch`);
    }
    const expectedChecks = [
        ['p95Ms', '<=', policy.thresholds.maxP95Ms],
        ['p99Ms', '<=', policy.thresholds.maxP99Ms],
        ['errorRate', '<=', policy.thresholds.maxErrorRate],
        ['timeoutRate', '<=', policy.thresholds.maxTimeoutRate],
        ['rps', '>=', policy.thresholds.minRps]
    ];
    const checks = document.thresholdEvaluation?.checks;
    if (document.thresholdEvaluation?.status !== 'pass'
        || !Array.isArray(checks) || checks.length !== expectedChecks.length)
    {
        throw new Error(`scenario ${scenario.id} threshold evaluation is incomplete`);
    }
    for (let index = 0; index < expectedChecks.length; index += 1)
    {
        const [metric, operator, threshold] = expectedChecks[index];
        const check = checks[index];
        if (check?.metric !== metric || check?.operator !== operator
            || check?.threshold !== threshold || check?.actual !== document.metrics?.[metric]
            || check?.status !== 'pass'
            || operator === '<=' && check.actual > threshold
            || operator === '>=' && check.actual < threshold)
        {
            throw new Error(`scenario ${scenario.id} forged threshold check: ${metric}`);
        }
    }
}

function verifySoakEvidence(document, scenario)
{
    const qualification = scenario.qualification;
    if (document.mode !== qualification.mode
        || document.durationSeconds !== qualification.durationSeconds
        || document.executionMode !== qualification.executionMode
        || document.countsAsReleaseFinal !== qualification.countsAsReleaseFinal
        || !sameJson(document.sampling, {
            intervalMs: qualification.intervalMs,
            requestsPerProbe: qualification.requestsPerProbe,
            concurrency: qualification.concurrency,
            probeCount: document.sampling?.probeCount
        })
        || !Number.isInteger(document.sampling?.probeCount) || document.sampling.probeCount < 1
        || !Array.isArray(document.probes)
        || document.probes.length !== document.sampling.probeCount
        || document.sampleCount !== document.sampling.probeCount * qualification.requestsPerProbe
        || document.probes.some((probe) => (
            probe?.sampleCount !== qualification.requestsPerProbe
            || probe?.concurrency !== qualification.concurrency
        )))
    {
        throw new Error(`scenario ${scenario.id} effective soak sampling mismatch`);
    }
}

function verifyDataScaleEvidence(document, scenario)
{
    const qualification = scenario.qualification;
    if (document.tier !== qualification.tier
        || !sameJson(document.expectedSeed, qualification.expectedSeed)
        || !sameJson(document.sampling, {
            requests: qualification.requests,
            concurrency: qualification.concurrency,
            routeCount: 3
        })
        || document.cleanup?.status !== 'ok'
        || document.observed?.status !== 'ok'
        || document.observed?.tier !== qualification.tier
        || !sameJson(document.observed?.sampling, document.sampling)
        || document.observed?.runtime?.sampleCount !== qualification.requests
        || document.observed?.runtime?.concurrency !== qualification.concurrency
        || document.observed?.observed?.articles !== qualification.expectedSeed.articles
        || document.observed?.observed?.comments !== qualification.expectedSeed.comments)
    {
        throw new Error(`scenario ${scenario.id} effective scale tier/sampling mismatch`);
    }
}

function verifyReleaseResourceEvidence(repositoryRoot, document, scenario, identity)
{
    const qualification = scenario.qualification;
    const policyFile = verifyFileBinding(
        repositoryRoot,
        identity.policy.releaseResource,
        'release resource policy'
    );
    if (document.mode !== qualification.mode
        || !sameJson(document.policy, {
            file: policyFile.relative,
            fileDigest: bytesDigest(policyFile.bytes)
        })
        || !sameJson(document.sampling, {
            requests: qualification.requests,
            concurrency: qualification.concurrency,
            routeCount: document.sampling?.routeCount
        })
        || !Number.isInteger(document.sampling?.routeCount) || document.sampling.routeCount < 1
        || document.runtime?.sampleCount !== qualification.requests
        || document.runtime?.concurrency !== qualification.concurrency
        || !Array.isArray(document.metrics) || document.metrics.length !== 1)
    {
        throw new Error(`scenario ${scenario.id} effective resource sampling/policy mismatch`);
    }
    const metric = document.metrics[0];
    const check = document.thresholdEvaluation?.checks?.[0];
    if (document.thresholdEvaluation?.status !== 'pass'
        || document.thresholdEvaluation.checks.length !== 1
        || metric.name !== qualification.metric
        || metric.threshold !== qualification.threshold
        || metric.thresholdKind !== qualification.thresholdKind
        || metric.thresholdOperator !== qualification.thresholdOperator
        || metric.thresholdField !== 'delta'
        || metric.status !== 'ok'
        || metric.delta > qualification.threshold
        || check?.metric !== qualification.metric
        || check?.actual !== metric.delta
        || check?.operator !== qualification.thresholdOperator
        || check?.threshold !== qualification.threshold
        || check?.status !== 'pass')
    {
        throw new Error(`scenario ${scenario.id} forged resource threshold evidence`);
    }
}

async function verifyMutationEvidence(repositoryRoot, document, scenario, identity)
{
    const qualification = scenario.qualification;
    const policyFile = verifyFileBinding(
        repositoryRoot,
        identity.policy.mutationSubset,
        'mutation subset policy'
    );
    const policy = JSON.parse(policyFile.bytes.toString('utf8'));
    const releaseQualification = document.releaseQualification;
    const expectedReleaseParityPath = `.tmp/mutation/backend-critical/release-parity/${
        identity.runId
    }/release-parity-receipt.json`;
    if (policy.subsetDigest !== bytesDigest(Buffer.from(JSON.stringify(policy.subset)))
        || policy.subsetDigest !== qualification.subsetDigest
        || document.tierId !== qualification.tierId
        || document.sliceId !== qualification.sliceId
        || !releaseQualification
        || releaseQualification.schema !== 'fsusblog.release-mutation-qualification.v1'
        || releaseQualification.status !== 'complete'
        || releaseQualification.tierId !== document.tierId
        || releaseQualification.sliceId !== document.sliceId
        || releaseQualification.releaseParity !== true
        || !sameJson(releaseQualification.policy, {
            path: policyFile.relative,
            fileDigest: bytesDigest(policyFile.bytes),
            subsetDigest: policy.subsetDigest
        })
        || releaseQualification.releaseParityReceipt?.path !== expectedReleaseParityPath
        || !sameJson(releaseQualification.sourceAuthority, {
            inventoryDigest: document.inventoryDigest,
            configDigest: document.config?.sha256
        })
        || !sameJson(releaseQualification.plannedMutantIds, document.plannedMutantIds)
        || !sameJson(releaseQualification.executedMutantIds, document.executedMutantIds))
    {
        throw new Error(`scenario ${scenario.id} release mutation qualification mismatch`);
    }
    const releaseParityFile = readJsonFile(
        repositoryRoot,
        releaseQualification.releaseParityReceipt.path,
        'release mutation parity receipt',
        expectedReleaseParityPath
    );
    const releaseParity = releaseParityFile.document;
    if (bytesDigest(releaseParityFile.bytes)
            !== releaseQualification.releaseParityReceipt.fileDigest
        || releaseParity.schema !== 'fsusblog.release-mutation-parity-receipt.v1'
        || releaseParity.evidenceClass !== 'release-artifact'
        || releaseParity.runId !== identity.runId
        || releaseParity.sourceAuthority?.inventoryDigest !== document.inventoryDigest
        || releaseParity.sourceAuthority?.configDigest !== document.config?.sha256
        || releaseParity.resolvedSubsetDigest
            !== bytesDigest(Buffer.from(JSON.stringify(releaseParity.resolvedSubset)))
        || releaseParity.resolvedSubsetDigest
            !== releaseQualification.releaseParityReceipt.resolvedSubsetDigest
        || !Array.isArray(releaseParity.resolvedSubset)
        || releaseParity.resolvedSubset.length !== policy.subset.length
        || releaseParity.resolvedSubset.some((entry, index) => (
            entry.operator !== policy.subset[index].operator
            || entry.sourceRegion !== policy.subset[index].sourceRegion
            || !document.executedMutantIds.includes(entry.mutantId)
        )))
    {
        throw new Error(`scenario ${scenario.id} release mutation parity receipt mismatch`);
    }
    if (releaseParity.invocationId !== identity.invocationId
        || releaseParity.attemptId !== `${identity.invocationId}.attempt-1`
        || releaseParity.sourceState?.commit !== identity.sourceState.commit
        || releaseParity.sourceState?.worktreeFingerprint.replace(/^sha256:/u, '')
            !== identity.sourceState.worktreeFingerprint.replace(/^sha256:/u, '')
        || releaseParity.attemptRoot?.immutableBuild?.contentDigest !== identity.build.contentDigest)
    {
        throw new Error(`scenario ${scenario.id} current-attempt root identity mismatch`);
    }
    validateMutationReleaseParity({ sourceMutationResult: document, releaseParityResult: releaseParity, selectionPolicy: policy });
    await verifyReleaseArtifactBinding(releaseParity, repositoryRoot);
}

async function verifyEvidence(repositoryRoot, reference, result, scenario, identity)
{
    const file = readRegularFile(repositoryRoot, reference.evidencePath, `scenario ${scenario.id} evidence`, scenario.authoritativeEvidence.path);
    if (bytesDigest(file.bytes) !== reference.evidenceDigest
        || result.authoritativeEvidence?.path !== reference.evidencePath
        || result.authoritativeEvidence?.digest !== reference.evidenceDigest)
    {
        throw new Error(`scenario ${scenario.id} evidence bytes/reference mismatch`);
    }
    const document = JSON.parse(file.bytes.toString('utf8'));
    const expected = scenario.authoritativeEvidence.expectedSchema;
    if (expected.schema !== undefined && document.schema !== expected.schema)
    {
        throw new Error(`scenario ${scenario.id} evidence schema mismatch`);
    }
    if (!expected.passStatusValues.includes(document.status)
        || expected.required.some((field) => !(field in document)))
    {
        throw new Error(`scenario ${scenario.id} evidence status/fields mismatch`);
    }
    const expectedBinding = {
        invocationId: identity.invocationId,
        runId: identity.runId,
        scenarioId: scenario.id,
        identityContentDigest: identity.contentDigest,
        sourceState: identity.sourceState,
        buildContentDigest: identity.build.contentDigest
    };
    if (JSON.stringify(document.releaseReliability) !== JSON.stringify(expectedBinding))
    {
        throw new Error(`scenario ${scenario.id} evidence invocation identity mismatch`);
    }
    if (scenario.qualification.kind === 'load-profile')
    {
        verifyLoadProfileEvidence(repositoryRoot, document, scenario, identity);
    }
    else if (scenario.qualification.kind === 'soak')
    {
        verifySoakEvidence(document, scenario);
    }
    else if (scenario.qualification.kind === 'data-scale')
    {
        verifyDataScaleEvidence(document, scenario);
    }
    else if (scenario.qualification.kind === 'release-resource-budget')
    {
        verifyReleaseResourceEvidence(repositoryRoot, document, scenario, identity);
    }
    else if (scenario.qualification.kind === 'mutation-release-parity')
    {
        await verifyMutationEvidence(repositoryRoot, document, scenario, identity);
    }
    else
    {
        throw new Error(`scenario ${scenario.id} qualification kind is unsupported`);
    }
}

function timelineAction(record)
{
    return {
        actionId: record.actionId,
        phase: record.phase,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        durationMs: record.durationMs,
        exitCode: record.exitCode,
        signal: record.signal,
        timedOut: record.timedOut,
        status: record.status,
        receipt: record.receipt,
        processTreeReceipt: record.processTreeReceipt,
        terminalFence: record.terminalFence
    };
}

function expectedActionCommand(action, scenario, identity, executionIdentity)
{
    const declaredExecutable = action.executable === '$scenario.command'
        ? scenario.command.executable
        : action.executable;
    const declaredArgs = action.executable === '$scenario.command'
        ? scenario.command.args
        : action.args;
    const declaredEnvironment = action.executable === '$scenario.command'
        ? scenario.command.env
        : action.env;
    const declaredCwd = action.executable === '$scenario.command'
        ? scenario.command.cwd
        : action.cwd;
    const toolId = path.basename(declaredExecutable).replace(/\.exe$/iu, '');
    const executable = identity.tools.find((tool) => tool.id === toolId)?.executable
        ?? (declaredExecutable === 'node' ? process.execPath : declaredExecutable);
    const args = declaredArgs.map((argument) =>
        expandLifecycleTemplate(argument, executionIdentity)
    );
    return {
        executable,
        args,
        cwd: declaredCwd,
        commandDigest: bytesDigest(Buffer.from(JSON.stringify({
            executable,
            args,
            env: declaredEnvironment,
            cwd: declaredCwd
        })))
    };
}

function verifyPhysicalProcessTreeEvidence(receipt, action)
{
    const tree = receipt.processTree;
    const label = `${action.actionId} process-tree`;
    if (tree?.schema !== 'fsusblog.physical-execution-process-tree.v1'
        || !['linux', 'darwin', 'win32'].includes(tree.platform)
        || !Array.isArray(tree.lifecycle)
        || !tree.lifecycle.includes('bounded-pipe-close')
        || !tree.lifecycle.includes('post-observe-zero-members')
        || tree.postObservation !== 'zero-members'
        || tree.logComplete !== true
        || tree.logTruncationReason !== null
        || tree.forcedPipeClose !== false
        || !Array.isArray(tree.processInventory)
        || tree.processInventory.length === 0)
    {
        throw new Error(`${label} evidence is incomplete`);
    }
    for (const member of tree.processInventory)
    {
        if (!Number.isInteger(member?.pid) || member.pid <= 0
            || typeof member.startIdentity !== 'string' || !member.startIdentity
            || !digestPattern.test(member.executableDigest)
            || !digestPattern.test(member.commandDigest)
            || !['containment-supervisor', 'direct-child', 'descendant']
                .includes(member.role)
            || !isoTimePattern.test(member.observedAt))
        {
            throw new Error(`${label} process inventory is incomplete`);
        }
    }
    const directChild = tree.processInventory.find(
        (member) => member.role === 'direct-child'
    );
    const authority = tree.authority;
    if (!directChild)
    {
        throw new Error(`${label} leader identity is missing`);
    }
    if (tree.platform === 'linux')
    {
        const processGroup = authority?.processGroup;
        if (authority?.schema !== 'fsusblog.physical-execution-authority.v1'
            || authority.kind !== 'linux-cgroup-process-group'
            || authority.established !== true
            || typeof authority.unitName !== 'string' || !authority.unitName
            || typeof authority.controlGroup !== 'string'
            || !authority.controlGroup.startsWith('/')
            || !Number.isInteger(authority.supervisorPid)
            || processGroup?.schema
                !== 'fsusblog.process-group-or-job-identity.v1'
            || processGroup.platform !== 'linux'
            || processGroup.kind !== 'process-group'
            || !Number.isInteger(processGroup.groupId)
            || processGroup.groupId !== processGroup.leaderPid
            || typeof processGroup.leaderProcessStartIdentity !== 'string'
            || !processGroup.leaderProcessStartIdentity
            || directChild.pid !== processGroup.leaderPid
            || directChild.pgid !== processGroup.groupId)
        {
            throw new Error(`${label} Linux cgroup/process-group authority is incomplete`);
        }
    }
    else if (tree.platform === 'darwin')
    {
        if (authority?.schema !== 'fsusblog.process-group-or-job-identity.v1'
            || authority.platform !== 'darwin'
            || authority.kind !== 'process-group'
            || !Number.isInteger(authority.groupId)
            || authority.groupId !== authority.leaderPid
            || directChild.pgid !== authority.groupId)
        {
            throw new Error(`${label} macOS process-group authority is incomplete`);
        }
    }
    else if (authority?.schema
            !== 'fsusblog.process-group-or-job-identity.v1'
        || authority.platform !== 'win32'
        || authority.kind !== 'windows-job-object'
        || typeof authority.jobName !== 'string' || !authority.jobName
        || authority.killPolicy !== 'kill-on-close'
        || directChild.jobId !== authority.jobName)
    {
        throw new Error(`${label} Windows Job Object authority is incomplete`);
    }
}

function verifyActionProcessTreeReceipt({
    repositoryRoot,
    reference,
    terminalFence,
    action,
    scenario,
    identity,
    identityReference,
    invocationId,
    runId
})
{
    exactKeys(reference, [
        'path',
        'schema',
        'status',
        'bytesDigest',
        'contentDigest',
        'postObservation',
        'logComplete'
    ], `${action.actionId} process-tree reference`);
    const expectedPath =
        `.tmp/release-reliability/${invocationId}/process-trees/` +
        `${scenario.id}/${action.actionId}.json`;
    const file = readJsonFile(
        repositoryRoot,
        reference.path,
        `${action.actionId} process-tree receipt`,
        expectedPath
    );
    const receipt = file.document;
    exactKeys(receipt, [
        'schema',
        'status',
        'invocationId',
        'runId',
        'scenarioId',
        'actionId',
        'phase',
        'identity',
        'physicalPolicy',
        'command',
        'startedAt',
        'finishedAt',
        'exitCode',
        'signal',
        'timedOut',
        'cancellation',
        'reason',
        'duplicateRequests',
        'processTree',
        'logComplete',
        'logTruncationReason',
        'forcedPipeClose',
        'terminalFence',
        'failure',
        'contentDigest'
    ], `${action.actionId} process-tree receipt`);
    exactKeys(receipt.command, [
        'executable',
        'args',
        'cwd',
        'commandDigest'
    ], `${action.actionId} process-tree command`);
    const expectedCommand = expectedActionCommand(
        action,
        scenario,
        identity,
        {
            actionId: action.actionId,
            invocationId,
            runId,
            scenarioId: scenario.id
        }
    );
    if (reference.schema
            !== 'fsusblog.release-reliability-process-tree-receipt.v1'
        || receipt.schema !== reference.schema
        || receipt.status !== 'passed' || reference.status !== 'passed'
        || bytesDigest(file.bytes) !== reference.bytesDigest
        || receipt.contentDigest !== reference.contentDigest
        || receipt.contentDigest !== semanticDigest(receipt)
        || receipt.invocationId !== invocationId || receipt.runId !== runId
        || receipt.scenarioId !== scenario.id
        || receipt.actionId !== action.actionId || receipt.phase !== action.phase
        || JSON.stringify(receipt.identity) !== JSON.stringify(identityReference)
        || JSON.stringify(receipt.physicalPolicy)
            !== JSON.stringify(identity.policy.physicalExecution)
        || JSON.stringify(receipt.command) !== JSON.stringify(expectedCommand)
        || receipt.processTree?.postObservation !== 'zero-members'
        || reference.postObservation !== 'zero-members'
        || receipt.logComplete !== true || receipt.processTree?.logComplete !== true
        || reference.logComplete !== true || receipt.failure !== null
        || receipt.timedOut !== false
        || receipt.terminalFence?.status !== 'closed'
        || receipt.terminalFence?.lateEvidenceAccepted !== false)
    {
        throw new Error(`${action.actionId} process-tree receipt is not qualified`);
    }
    if (JSON.stringify(receipt.terminalFence) !== JSON.stringify(terminalFence))
    {
        throw new Error(`${action.actionId} terminal fence changed`);
    }
    verifyPhysicalProcessTreeEvidence(receipt, action);
    const policy = readJsonFile(
        repositoryRoot,
        receipt.physicalPolicy.path,
        'physical execution policy',
        catalogPolicyPath(identity, 'physicalExecution')
    );
    if (bytesDigest(policy.bytes) !== receipt.physicalPolicy.fileDigest
        || JSON.stringify(receipt.processTree.policy)
            !== JSON.stringify(policy.document))
    {
        throw new Error(`${action.actionId} physical execution policy changed`);
    }
    isoTime(receipt.startedAt, `${action.actionId}.processTree.startedAt`);
    isoTime(receipt.finishedAt, `${action.actionId}.processTree.finishedAt`);
}

function catalogPolicyPath(identity, field)
{
    return normalizedRelative(
        identity.policy?.[field]?.path,
        `${field} policy`
    );
}

function verifyLifecycle(
    repositoryRoot,
    result,
    aggregateReference,
    scenario,
    contracts,
    identity,
    identityReference,
    invocationId,
    runId
)
{
    exactKeys(result.lifecycle, [
        'actions',
        'verifiedActionReceipts',
        'resetPostObservation',
        'finalPostObservation'
    ], `scenario ${scenario.id} lifecycle`);
    if (!Array.isArray(result.lifecycle.actions)
        || !Array.isArray(result.lifecycle.verifiedActionReceipts))
    {
        throw new Error(`scenario ${scenario.id} lifecycle is missing`);
    }
    const expected = lifecycleActionIds(scenario);
    if (result.lifecycle.actions.length !== expected.length
        || result.lifecycle.verifiedActionReceipts.length !== expected.length
        || JSON.stringify(aggregateReference.lifecycleActions)
            !== JSON.stringify(result.lifecycle.actions.map(timelineAction))
        || JSON.stringify(aggregateReference.resetPostObservation)
            !== JSON.stringify(result.lifecycle.resetPostObservation)
        || JSON.stringify(aggregateReference.finalPostObservation)
            !== JSON.stringify(result.lifecycle.finalPostObservation))
    {
        throw new Error(`scenario ${scenario.id} lifecycle aggregate is incomplete`);
    }
    let previousFinishedAt = null;
    for (let index = 0; index < expected.length; index += 1)
    {
        const declaration = expected[index];
        const action = contracts.actions.get(declaration.actionId);
        const record = result.lifecycle.actions[index];
        const reference = result.lifecycle.verifiedActionReceipts[index];
        exactKeys(record, [
            'actionId',
            'phase',
            'producerSpawned',
            'status',
            'startedAt',
            'finishedAt',
            'durationMs',
            'exitCode',
            'signal',
            'timedOut',
            'stdoutLog',
            'stderrLog',
            'receipt',
            'processTreeReceipt',
            'terminalFence',
            'finalObservation',
            'failure'
        ], `${scenario.id}.${declaration.actionId} action record`);
        if (!action || action.scenarioId !== scenario.id
            || action.phase !== declaration.phase
            || record.actionId !== action.actionId
            || record.phase !== action.phase
            || record.producerSpawned !== true
            || record.status !== 'passed'
            || record.exitCode !== 0
            || record.signal !== null
            || record.timedOut !== false
            || record.failure !== null
            || !Number.isInteger(record.durationMs)
            || record.durationMs < 0)
        {
            throw new Error(`scenario ${scenario.id} ${declaration.actionId} action failed`);
        }
        const verified = verifyLifecycleActionReceipt({
            repositoryRoot,
            action,
            scenario,
            invocationId,
            runId,
            identity,
            identityReference,
            expectedBytesDigest: reference?.bytesDigest
        });
        verifyActionProcessTreeReceipt({
            repositoryRoot,
            reference: record.processTreeReceipt,
            terminalFence: record.terminalFence,
            action,
            scenario,
            identity,
            identityReference,
            invocationId,
            runId
        });
        if (JSON.stringify(reference) !== JSON.stringify(verified)
            || JSON.stringify(record.receipt) !== JSON.stringify(verified)
            || JSON.stringify(record.finalObservation)
                !== JSON.stringify(verified.finalObservation))
        {
            throw new Error(`scenario ${scenario.id} ${declaration.actionId} receipt mismatch`);
        }
        isoTime(record.startedAt, `${scenario.id}.${declaration.actionId}.startedAt`);
        isoTime(record.finishedAt, `${scenario.id}.${declaration.actionId}.finishedAt`);
        if (Date.parse(record.finishedAt) < Date.parse(record.startedAt)
            || previousFinishedAt !== null
                && Date.parse(record.startedAt) < previousFinishedAt)
        {
            throw new Error(`scenario ${scenario.id} lifecycle ordering is invalid`);
        }
        if (Date.parse(record.startedAt) < Date.parse(result.startedAt)
            || Date.parse(record.finishedAt) > Date.parse(result.finishedAt))
        {
            throw new Error(`scenario ${scenario.id} lifecycle escapes the producer window`);
        }
        previousFinishedAt = Date.parse(record.finishedAt);
    }
    const resetBefore = result.lifecycle.actions.filter(
        (record) => record.phase === 'reset-before'
    ).at(-1);
    const resetAfter = result.lifecycle.actions.filter(
        (record) => record.phase === 'reset-after'
    ).at(-1);
    if (result.lifecycle.resetPostObservation?.status !== 'passed'
        || result.lifecycle.finalPostObservation?.status !== 'passed'
        || JSON.stringify(result.lifecycle.resetPostObservation)
            !== JSON.stringify(resetBefore?.finalObservation)
        || JSON.stringify(result.lifecycle.finalPostObservation)
            !== JSON.stringify(resetAfter?.finalObservation))
    {
        throw new Error(`scenario ${scenario.id} final lifecycle observation failed`);
    }
}

async function verifyResult(
    repositoryRoot,
    aggregateReference,
    scenario,
    catalog,
    contracts,
    identity,
    identityReference
)
{
    exactKeys(aggregateReference, [
        'scenarioId',
        'resultPath',
        'resultContentDigest',
        'evidencePath',
        'evidenceDigest',
        'lifecycleActions',
        'resetPostObservation',
        'finalPostObservation',
        'firstFailure',
        'cleanupFailures'
    ], `scenario ${scenario.id} aggregate reference`);
    if (aggregateReference.scenarioId !== scenario.id || !digestPattern.test(aggregateReference.resultContentDigest)
        || !digestPattern.test(aggregateReference.evidenceDigest))
    {
        throw new Error(`scenario ${scenario.id} aggregate reference is invalid`);
    }
    const expectedPath = `.tmp/release-reliability/${identity.invocationId}/scenario-results/${scenario.id}.json`;
    const file = readJsonFile(repositoryRoot, aggregateReference.resultPath, `scenario ${scenario.id} result`, expectedPath);
    const result = file.document;
    exactKeys(result, [
        'schema',
        'invocationId',
        'runId',
        'scenarioId',
        'resultPath',
        'owner',
        'resourceClass',
        'evidenceClass',
        'qualificationEligible',
        'status',
        'identity',
        'startedAt',
        'finishedAt',
        'producer',
        'producerSpawned',
        'lifecycle',
        'authoritativeEvidence',
        'outputs',
        'firstFailure',
        'cleanupFailures',
        'terminalFence',
        'cancellation',
        'failure',
        'recordedAt',
        'contentDigest'
    ], `scenario ${scenario.id} result`);
    if (result.schema !== 'fsusblog.release-reliability-scenario-result.v3' || result.status !== 'passed'
        || result.producerSpawned !== true
        || result.evidenceClass !== 'correctness' || result.qualificationEligible !== true
        || result.scenarioId !== scenario.id || result.runId !== identity.runId
        || result.invocationId !== identity.invocationId || result.resultPath !== expectedPath
        || result.contentDigest !== semanticDigest(result)
        || result.contentDigest !== aggregateReference.resultContentDigest
        || JSON.stringify(result.identity) !== JSON.stringify(identityReference)
        || result.firstFailure !== null
        || !Array.isArray(result.cleanupFailures)
        || result.cleanupFailures.length !== 0
        || aggregateReference.firstFailure !== null
        || !Array.isArray(aggregateReference.cleanupFailures)
        || aggregateReference.cleanupFailures.length !== 0
        || result.failure !== null)
    {
        throw new Error(`scenario ${scenario.id} sealed result schema/status/run mismatch`);
    }
    isoTime(result.startedAt, `${scenario.id}.startedAt`);
    isoTime(result.finishedAt, `${scenario.id}.finishedAt`);
    isoTime(result.recordedAt, `${scenario.id}.recordedAt`);
    if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)
        || Date.parse(result.recordedAt) < Date.parse(result.finishedAt))
    {
        throw new Error(`scenario ${scenario.id} result time ordering is invalid`);
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
    if (Object.hasOwn(catalog, 'schedulerTimeoutPolicies'))
    {
        producerKeys.push('schedulerGrant');
    }
    exactKeys(result.producer, producerKeys, `scenario ${scenario.id} producer`);
    const commandToolId = path.basename(scenario.command.executable).replace(/\.exe$/iu, '');
    const expectedExecutable = identity.tools.find((tool) => tool.id === commandToolId)?.executable;
    const expectedLogRoot =
        `.tmp/release-reliability/${identity.invocationId}/logs/lifecycle/${scenario.id}/${scenario.isolation.lifecycle.measurement}`;
    if (!expectedExecutable || result.producer.executable !== expectedExecutable
        || JSON.stringify(result.producer.args) !== JSON.stringify(scenario.command.args)
        || JSON.stringify(result.producer.env) !== JSON.stringify(scenario.command.env)
        || JSON.stringify(result.producer.environmentContract)
            !== JSON.stringify(scenarioEnvironmentContract(catalog, scenario))
        || result.producer.cwd !== scenario.command.cwd
        || result.producer.commandDigest !== bytesDigest(Buffer.from(JSON.stringify(scenario.command)))
        || result.producer.exitCode !== 0 || result.producer.signal !== null
        || result.producer.timedOut !== false
        || result.producer.stdoutLog !== `${expectedLogRoot}.stdout.log`
        || result.producer.stderrLog !== `${expectedLogRoot}.stderr.log`
        || (Object.hasOwn(catalog, 'schedulerTimeoutPolicies')
            && (result.producer.schedulerGrant?.status !== 'granted'
                || result.producer.schedulerGrant?.scenarioId !== scenario.id
                || result.producer.schedulerGrant?.runId !== identity.runId
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
            )?.terminalFence)
        || result.terminalFence?.status !== 'closed'
        || result.terminalFence?.lateEvidenceAccepted !== false
        || result.cancellation !== null)
    {
        throw new Error(`scenario ${scenario.id} producer invocation mismatch`);
    }
    await verifyEvidence(repositoryRoot, aggregateReference, result, scenario, identity);
    verifyLifecycle(
        repositoryRoot,
        result,
        aggregateReference,
        scenario,
        contracts,
        identity,
        identityReference,
        identity.invocationId,
        identity.runId
    );
    if (JSON.stringify(result.outputs) !== JSON.stringify([{
        id: 'authoritative-evidence',
        path: aggregateReference.evidencePath,
        digest: aggregateReference.evidenceDigest
    }]))
    {
        throw new Error(`scenario ${scenario.id} outputs are not exact`);
    }
    return result;
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function sealDocument(value)
{
    const sealed = { ...value, contentDigest: null };
    sealed.contentDigest = semanticDigest(sealed);
    return sealed;
}

function persistentPaths(repositoryRoot, candidate)
{
    const identityFile = readJsonFile(repositoryRoot, candidate.identity.path, 'run identity manifest input');
    const identity = identityFile.document;
    const paths = new Set([
        candidate.identity.path,
        candidate.timeline.path,
        identity.build.path,
        identity.fixture.config.path,
        identity.fixture.schema.path,
        identity.fixture.seed.path,
        identity.fixture.auditRetentionPolicy.path,
        identity.fixture.topology.path,
        identity.machine.schedulerPolicy.path,
        identity.policy.catalog.path,
        identity.policy.lifecycleActionRegistry.path,
        identity.policy.stateDomainRegistry.path,
        identity.policy.threshold.path,
        identity.policy.mutationSubset.path,
        identity.policy.releaseResource.path,
        identity.policy.physicalExecution.path,
        'config/schemas/release-reliability-lifecycle-action-registry.schema.json',
        'config/testing/release-reliability-lifecycle-action-registry.json',
        'config/testing/runtime-state-domain-registry.json',
        'config/testing/runtime-http-route-contracts.json',
        'tools/test/verify-release-reliability-receipt.mjs'
    ]);
    for (const reference of candidate.scenarios)
    {
        paths.add(reference.resultPath);
        paths.add(reference.evidencePath);
        const result = readJsonFile(repositoryRoot, reference.resultPath, `${reference.scenarioId} result manifest input`).document;
        if (reference.scenarioId === 'release-mutation-critical-slice')
        {
            const evidence = readJsonFile(
                repositoryRoot,
                reference.evidencePath,
                'release mutation authority manifest input'
            ).document;
            const releaseParityPath = evidence.releaseQualification?.releaseParityReceipt?.path;
            if (typeof releaseParityPath !== 'string' || !releaseParityPath)
            {
                throw new Error('release mutation parity receipt path is missing');
            }
            paths.add(releaseParityPath);
        }
        for (const action of result.lifecycle?.actions ?? [])
        {
            paths.add(action.receipt?.path);
            paths.add(action.processTreeReceipt?.path);
        }
    }
    return [...paths].sort();
}

function persistentManifest(repositoryRoot, candidate)
{
    return persistentPaths(repositoryRoot, candidate).map((relative) =>
    {
        const file = readRegularFile(repositoryRoot, relative, `persistent attestation input ${relative}`);
        return { path: file.relative, fileDigest: bytesDigest(file.bytes) };
    });
}

function verifierBinding(repositoryRoot)
{
    const repositoryFile = readRegularFile(
        repositoryRoot,
        'tools/test/verify-release-reliability-receipt.mjs',
        'independent verifier source'
    );
    const executingBytes = fs.readFileSync(fileURLToPath(import.meta.url));
    const fileDigest = bytesDigest(repositoryFile.bytes);
    if (bytesDigest(executingBytes) !== fileDigest)
    {
        throw new Error('executing verifier does not match the approved repository verifier source');
    }
    return { path: repositoryFile.relative, fileDigest };
}

function validateCandidateEnvelope(repositoryRoot, candidatePath)
{
    const initial = readJsonFile(repositoryRoot, candidatePath, 'candidate receipt');
    const candidate = initial.document;
    exactKeys(candidate, [
        'schema',
        'invocationId',
        'runId',
        'status',
        'identity',
        'timeline',
        'scenarios',
        'createdAt',
        'failure',
        'contentDigest'
    ], 'candidate receipt');
    safeId(candidate.invocationId, 'candidate invocationId');
    safeId(candidate.runId, 'candidate runId');
    const canonicalPath = `.tmp/release-reliability/${candidate.invocationId}/candidate-receipt.json`;
    if (initial.relative !== canonicalPath
        || candidate.schema !== 'fsusblog.release-reliability-candidate-receipt.v1'
        || candidate.status !== 'candidate' || candidate.failure !== null
        || candidate.contentDigest !== semanticDigest(candidate))
    {
        throw new Error('candidate receipt schema/status/path/contentDigest is invalid');
    }
    isoTime(candidate.createdAt, 'candidate.createdAt');
    return { initial, candidate };
}

async function validateVerifiedAttestation(repositoryRoot, candidatePath, attestationPath)
{
    const { initial: candidateFile, candidate } = validateCandidateEnvelope(repositoryRoot, candidatePath);
    const attestationFile = readJsonFile(repositoryRoot, attestationPath, 'verified attestation');
    const attestation = attestationFile.document;
    exactKeys(attestation, [
        'schema',
        'status',
        'invocationId',
        'runId',
        'candidate',
        'verifier',
        'files',
        'verifiedAt',
        'contentDigest'
    ], 'verified attestation');
    const canonicalPath = `.tmp/release-reliability/${candidate.invocationId}/verified-attestation.json`;
    if (attestationFile.relative !== canonicalPath
        || attestation.schema !== 'fsusblog.release-reliability-verified-attestation.v1'
        || attestation.status !== 'verified'
        || attestation.invocationId !== candidate.invocationId
        || attestation.runId !== candidate.runId
        || attestation.contentDigest !== semanticDigest(attestation)
        || JSON.stringify(attestation.candidate) !== JSON.stringify({
            path: candidateFile.relative,
            contentDigest: candidate.contentDigest,
            fileDigest: bytesDigest(candidateFile.bytes)
        }))
    {
        throw new Error('verified attestation envelope/candidate binding is invalid');
    }
    isoTime(attestation.verifiedAt, 'attestation.verifiedAt');
    if (Date.parse(attestation.verifiedAt) < Date.parse(candidate.createdAt))
    {
        throw new Error('verified attestation predates its candidate');
    }
    if (JSON.stringify(attestation.verifier) !== JSON.stringify(verifierBinding(repositoryRoot)))
    {
        throw new Error('verified attestation verifier identity changed');
    }
    const expectedPaths = persistentPaths(repositoryRoot, candidate);
    if (!Array.isArray(attestation.files)
        || JSON.stringify(attestation.files.map((entry) => entry?.path)) !== JSON.stringify(expectedPaths)
        || new Set(attestation.files.map((entry) => entry?.path)).size !== expectedPaths.length)
    {
        throw new Error('verified attestation persistent file set is not exact');
    }
    for (const entry of attestation.files)
    {
        exactKeys(entry, ['path', 'fileDigest'], `attested file ${entry?.path ?? '<missing>'}`);
        const file = readRegularFile(repositoryRoot, entry.path, `attested file ${entry.path}`);
        if (!digestPattern.test(entry.fileDigest) || bytesDigest(file.bytes) !== entry.fileDigest)
        {
            throw new Error(`attested persistent file changed: ${entry.path}`);
        }
    }
    const mutation = candidate.scenarios.find(reference => reference.scenarioId === 'release-mutation-critical-slice');
    const evidence = readJsonFile(repositoryRoot, mutation.evidencePath, 'retained mutation authority').document;
    const parity = readJsonFile(repositoryRoot, evidence.releaseQualification.releaseParityReceipt.path, 'retained mutation parity').document;
    await verifyReleaseArtifactBinding(parity, repositoryRoot);
    return { candidateFile, candidate, attestationFile, attestation };
}

function createVerifiedAttestation(repositoryRoot, candidateFile, candidate)
{
    const verifier = verifierBinding(repositoryRoot);
    return sealDocument({
        schema: 'fsusblog.release-reliability-verified-attestation.v1',
        status: 'verified',
        invocationId: candidate.invocationId,
        runId: candidate.runId,
        candidate: {
            path: candidateFile.relative,
            contentDigest: candidate.contentDigest,
            fileDigest: bytesDigest(candidateFile.bytes)
        },
        verifier,
        files: persistentManifest(repositoryRoot, candidate),
        verifiedAt: new Date().toISOString()
    });
}

async function createTerminalReceipt(repositoryRoot, candidatePath, attestationPath)
{
    const verified = await validateVerifiedAttestation(repositoryRoot, candidatePath, attestationPath);
    const identity = readJsonFile(
        repositoryRoot,
        verified.candidate.identity.path,
        'terminal build identity'
    ).document;
    return sealDocument({
        schema: 'fsusblog.release-reliability-qualified-receipt.v3',
        invocationId: verified.candidate.invocationId,
        runId: verified.candidate.runId,
        status: 'qualified',
        candidate: {
            path: verified.candidateFile.relative,
            contentDigest: verified.candidate.contentDigest,
            fileDigest: bytesDigest(verified.candidateFile.bytes)
        },
        attestation: {
            path: verified.attestationFile.relative,
            contentDigest: verified.attestation.contentDigest,
            fileDigest: bytesDigest(verified.attestationFile.bytes)
        },
        buildIdentity: {
            imageDigest: identity.build.imageDigest,
            revision: identity.build.image.revision,
            fsusuiSource: identity.build.image.fsusuiSource,
            fsusuiCommit: identity.build.image.fsusuiCommit
        },
        finalizedAt: new Date().toISOString(),
        failure: null
    });
}

async function verifyTerminalReceipt(repositoryRoot, receiptPath)
{
    const file = readJsonFile(repositoryRoot, receiptPath, 'qualified receipt');
    const receipt = file.document;
    exactKeys(receipt, [
        'schema',
        'invocationId',
        'runId',
        'status',
        'candidate',
        'attestation',
        'buildIdentity',
        'finalizedAt',
        'failure',
        'contentDigest'
    ], 'qualified receipt');
    const canonicalPath = `.tmp/release-reliability/${receipt.invocationId}/qualified-receipt.json`;
    if (file.relative !== canonicalPath
        || receipt.schema !== 'fsusblog.release-reliability-qualified-receipt.v3'
        || receipt.status !== 'qualified' || receipt.failure !== null
        || receipt.contentDigest !== semanticDigest(receipt))
    {
        throw new Error('terminal qualified receipt schema/status/path/contentDigest is invalid');
    }
    safeId(receipt.invocationId, 'receipt invocationId');
    safeId(receipt.runId, 'receipt runId');
    isoTime(receipt.finalizedAt, 'receipt.finalizedAt');
    const verified = await validateVerifiedAttestation(
        repositoryRoot,
        receipt.candidate?.path,
        receipt.attestation?.path
    );
    const identity = readJsonFile(
        repositoryRoot,
        verified.candidate.identity.path,
        'terminal build identity'
    ).document;
    if (JSON.stringify(receipt.candidate) !== JSON.stringify({
        path: verified.candidateFile.relative,
        contentDigest: verified.candidate.contentDigest,
        fileDigest: bytesDigest(verified.candidateFile.bytes)
    }) || JSON.stringify(receipt.attestation) !== JSON.stringify({
        path: verified.attestationFile.relative,
        contentDigest: verified.attestation.contentDigest,
        fileDigest: bytesDigest(verified.attestationFile.bytes)
    }) || JSON.stringify(receipt.buildIdentity) !== JSON.stringify({
        imageDigest: identity.build.imageDigest,
        revision: identity.build.image.revision,
        fsusuiSource: identity.build.image.fsusuiSource,
        fsusuiCommit: identity.build.image.fsusuiCommit
    }) || receipt.invocationId !== verified.candidate.invocationId
        || receipt.runId !== verified.candidate.runId
        || Date.parse(receipt.finalizedAt) < Date.parse(verified.attestation.verifiedAt))
    {
        throw new Error('terminal qualified receipt attestation binding is invalid');
    }
    return { file, receipt };
}

function parseArgs(argumentsList)
{
    let receipt = null;
    let candidate = null;
    let attestationOut = null;
    let attestation = null;
    let finalizeOut = null;
    let repositoryRoot = defaultRoot;
    for (let index = 0; index < argumentsList.length; index += 1)
    {
        if (argumentsList[index] === '--receipt' && index + 1 < argumentsList.length)
        {
            receipt = argumentsList[++index];
        }
        else if (argumentsList[index] === '--candidate' && index + 1 < argumentsList.length)
        {
            candidate = argumentsList[++index];
        }
        else if (argumentsList[index] === '--attestation-out' && index + 1 < argumentsList.length)
        {
            attestationOut = argumentsList[++index];
        }
        else if (argumentsList[index] === '--attestation' && index + 1 < argumentsList.length)
        {
            attestation = argumentsList[++index];
        }
        else if (argumentsList[index] === '--finalize-out' && index + 1 < argumentsList.length)
        {
            finalizeOut = argumentsList[++index];
        }
        else if (argumentsList[index] === '--root' && index + 1 < argumentsList.length)
        {
            repositoryRoot = path.resolve(argumentsList[++index]);
        }
        else
        {
            throw new Error('invalid release reliability verifier arguments');
        }
    }
    const terminalMode = Boolean(receipt) && !candidate && !attestationOut && !attestation && !finalizeOut;
    const attestMode = Boolean(candidate && attestationOut) && !receipt && !attestation && !finalizeOut;
    const finalizeMode = Boolean(candidate && attestation && finalizeOut) && !receipt && !attestationOut;
    if ([terminalMode, attestMode, finalizeMode].filter(Boolean).length !== 1)
    {
        throw new Error('use --receipt, --candidate/--attestation-out, or --candidate/--attestation/--finalize-out');
    }
    if (!fs.existsSync(repositoryRoot))
    {
        throw new Error('approved root must be one real canonical directory');
    }
    repositoryRoot = fs.realpathSync(repositoryRoot);
    const repositoryMetadata = fs.lstatSync(repositoryRoot);
    if (!repositoryMetadata.isDirectory()
        || repositoryMetadata.isSymbolicLink()
        || fs.realpathSync(repositoryRoot) !== repositoryRoot)
    {
        throw new Error('approved root must be one real canonical directory');
    }
    return { receipt, candidate, attestationOut, attestation, finalizeOut, repositoryRoot, terminalMode, attestMode, finalizeMode };
}

async function main()
{
    const options = parseArgs(process.argv.slice(2));
    if (options.terminalMode)
    {
        const verified = await verifyTerminalReceipt(options.repositoryRoot, options.receipt);
        console.log(`[release-reliability-receipt] qualified receipt=${verified.file.relative}`);
        return;
    }
    if (options.finalizeMode)
    {
        const receipt = await createTerminalReceipt(
            options.repositoryRoot,
            options.candidate,
            options.attestation
        );
        const output = safePath(options.repositoryRoot, options.finalizeOut, 'qualified receipt output');
        const expected = `.tmp/release-reliability/${receipt.invocationId}/qualified-receipt.json`;
        if (output.relative !== expected)
        {
            throw new Error('qualified receipt output path is not canonical');
        }
        writeJsonAtomic(output.absolute, receipt);
        const verified = await verifyTerminalReceipt(options.repositoryRoot, output.relative);
        console.log(`[release-reliability-finalize] qualified receipt=${verified.file.relative}`);
        return;
    }

    const initial = readJsonFile(options.repositoryRoot, options.candidate, 'candidate receipt');
    const receipt = initial.document;
    exactKeys(receipt, [
        'schema',
        'invocationId',
        'runId',
        'status',
        'identity',
        'timeline',
        'scenarios',
        'createdAt',
        'failure',
        'contentDigest'
    ], 'candidate receipt');
    safeId(receipt.invocationId, 'receipt invocationId');
    safeId(receipt.runId, 'receipt runId');
    const canonicalReceiptPath = `.tmp/release-reliability/${receipt.invocationId}/candidate-receipt.json`;
    if (initial.relative !== canonicalReceiptPath)
    {
        throw new Error('candidate receipt path is not canonical');
    }
    if (receipt.schema !== 'fsusblog.release-reliability-candidate-receipt.v1'
        || receipt.status !== 'candidate' || receipt.failure !== null
        || receipt.contentDigest !== semanticDigest(receipt))
    {
        throw new Error('candidate schema/status/contentDigest is invalid');
    }
    isoTime(receipt.createdAt, 'receipt.createdAt');

    const catalogFile = readJsonFile(
        options.repositoryRoot,
        'config/testing/release-reliability-scenario-catalog.json',
        'canonical scenario catalog',
        'config/testing/release-reliability-scenario-catalog.json'
    );
    const catalog = catalogFile.document;
    validateCatalog(catalog);
    const lifecycleContracts = loadLifecycleActionContracts({
        repositoryRoot: options.repositoryRoot,
        catalog
    });
    const identity = await verifyIdentity(
        options.repositoryRoot,
        receipt.identity,
        catalog,
        lifecycleContracts,
        receipt.invocationId,
        receipt.runId
    );
    if (receipt.scenarios.length !== catalog.canonicalScenarioIds.length
        || JSON.stringify(receipt.scenarios.map((reference) => reference.scenarioId).sort())
            !== JSON.stringify([...catalog.canonicalScenarioIds].sort()))
    {
        throw new Error('receipt scenario set is not exact');
    }
    const resultDirectory = safePath(
        options.repositoryRoot,
        `.tmp/release-reliability/${receipt.invocationId}/scenario-results`,
        'scenario result directory'
    );
    const resultNames = fs.readdirSync(resultDirectory.absolute).filter((name) => name.endsWith('.json')).sort();
    const expectedNames = catalog.canonicalScenarioIds.map((id) => `${id}.json`).sort();
    if (JSON.stringify(resultNames) !== JSON.stringify(expectedNames))
    {
        throw new Error('scenario result directory does not contain exactly one result per canonical scenario');
    }
    const verifiedResults = [];
    for (const scenario of catalog.scenarios)
    {
        const reference = receipt.scenarios.find((candidate) => candidate.scenarioId === scenario.id);
        verifiedResults.push(
            await verifyResult(
                options.repositoryRoot,
                reference,
                scenario,
                catalog,
                lifecycleContracts,
                identity,
                receipt.identity
            )
        );
    }

    exactKeys(receipt.timeline, ['path', 'contentDigest'], 'timeline reference');
    const timelinePath = `.tmp/release-reliability/${receipt.invocationId}/timeline.json`;
    const timelineFile = readJsonFile(options.repositoryRoot, receipt.timeline.path, 'timeline', timelinePath);
    const timeline = timelineFile.document;
    exactKeys(timeline, [
        'schema',
        'invocationId',
        'runId',
        'status',
        'identity',
        'createdAt',
        'scenarioResults',
        'terminalEvents',
        'contentDigest'
    ], 'timeline');
    if (timeline.schema !== 'fsusblog.release-reliability-timeline.v3' || timeline.status !== 'complete'
        || timeline.invocationId !== receipt.invocationId || timeline.runId !== receipt.runId
        || timeline.contentDigest !== semanticDigest(timeline)
        || timeline.contentDigest !== receipt.timeline.contentDigest
        || JSON.stringify(timeline.identity) !== JSON.stringify(receipt.identity)
        || JSON.stringify(timeline.scenarioResults) !== JSON.stringify(receipt.scenarios)
        || timeline.createdAt !== receipt.createdAt
        || verifiedResults.some(
            (result) => Date.parse(result.startedAt) < Date.parse(identity.collectedAt)
                || Date.parse(result.recordedAt) > Date.parse(timeline.createdAt)
        ))
    {
        throw new Error('timeline sealed references do not match the qualified receipt');
    }
    verifyTerminalEvents(timeline.terminalEvents, verifiedResults);
    isoTime(timeline.createdAt, 'timeline.createdAt');
    const attestation = createVerifiedAttestation(options.repositoryRoot, initial, receipt);
    const attestationOutput = safePath(
        options.repositoryRoot,
        options.attestationOut,
        'verified attestation output'
    );
    const expectedAttestationPath =
        `.tmp/release-reliability/${receipt.invocationId}/verified-attestation.json`;
    if (attestationOutput.relative !== expectedAttestationPath)
    {
        throw new Error('verified attestation output path is not canonical');
    }
    writeJsonAtomic(attestationOutput.absolute, attestation);
    await validateVerifiedAttestation(options.repositoryRoot, initial.relative, attestationOutput.relative);
    console.log(`[release-reliability-attestation] verified attestation=${attestationOutput.relative}`);
}

main().catch((error) =>
{
    console.error(`[release-reliability-receipt] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
