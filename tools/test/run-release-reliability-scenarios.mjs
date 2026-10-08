#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    executeLifecycleActionPlan,
    loadLifecycleActionContracts,
    readQualifiedRuntimeEnvironment,
    resolveScenarioSchedulerGrant,
    validateReleaseReliabilitySchedulerCatalog
} from './release-reliability-execution-context.mjs';
import {
    collectRunIdentity,
    createCandidateReceipt,
    createTimeline,
    sealDocument
} from './release-reliability-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(root, 'config/testing/release-reliability-scenario-catalog.json');
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

function sha256(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalJson(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value !== null && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map(
            (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        ).join(',')}}`;
    }
    return JSON.stringify(value);
}

function sameJson(left, right)
{
    return canonicalJson(left) === canonicalJson(right);
}

function safeSegment(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(normalized))
    {
        throw new Error(`${label} must be a safe non-empty identifier`);
    }
    return normalized;
}

function relativePath(repositoryRoot, value, label = 'path', { allowRoot = false } = {})
{
    const raw = String(value ?? '').trim().replaceAll('\\', '/');
    const normalized = raw.replace(/^\.\//u, '');
    const segments = normalized.split('/');
    if (!normalized || path.posix.isAbsolute(normalized)
        || path.posix.normalize(normalized) !== normalized
        || segments.some((segment) => segment === '' || segment === '..'
            || segment === '.' && !(allowRoot && normalized === '.')))
    {
        throw new Error(`${label} is unsafe: ${normalized || '<empty>'}`);
    }
    const resolved = path.resolve(repositoryRoot, normalized);
    if ((!allowRoot && resolved === repositoryRoot)
        || resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error(`${label} resolves outside the repository: ${normalized}`);
    }
    let cursor = resolved;
    while (cursor !== repositoryRoot)
    {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
        {
            throw new Error(`${label} contains a symlink: ${normalized}`);
        }
        cursor = path.dirname(cursor);
    }
    return resolved;
}

function requireNonEmptyString(value, description, errors)
{
    if (typeof value !== 'string' || value.trim() === '')
    {
        errors.push(`${description} must be a non-empty string`);
    }
}

function sortedUniqueStrings(values)
{
    return Array.isArray(values)
        && values.length > 0
        && values.every((value) => typeof value === 'string' && value.trim())
        && JSON.stringify(values) === JSON.stringify([...new Set(values)].sort());
}

function uniqueStrings(values)
{
    return Array.isArray(values)
        && values.length > 0
        && values.every((value) => typeof value === 'string' && value.trim())
        && new Set(values).size === values.length;
}

function uniqueStringArray(values)
{
    return Array.isArray(values)
        && values.every((value) => typeof value === 'string' && value.trim())
        && new Set(values).size === values.length;
}

function sortedUniqueStringArray(values, { allowEmpty = false } = {})
{
    return Array.isArray(values) && (allowEmpty || values.length > 0)
        && values.every((value) => typeof value === 'string' && value.trim())
        && JSON.stringify(values) === JSON.stringify([...new Set(values)].sort());
}

function environmentContractContent(catalog, scenario)
{
    return {
        schema: catalog.childEnvironmentContract.schema,
        scenarioId: scenario.id,
        requiredBaseKeys: catalog.childEnvironmentContract.requiredBaseKeys,
        optionalBaseKeys: catalog.childEnvironmentContract.optionalBaseKeys,
        requiredInheritedKeys: scenario.command.inheritEnv.required,
        optionalInheritedKeys: scenario.command.inheritEnv.optional,
        fixedEnvironment: scenario.command.env,
        internalKeys: catalog.childEnvironmentContract.internalKeys
    };
}

export function scenarioEnvironmentContract(catalog, scenario)
{
    const content = environmentContractContent(catalog, scenario);
    return {
        schema: content.schema,
        scenarioId: scenario.id,
        contentDigest: sha256(canonicalJson(content))
    };
}

export function buildScenarioChildEnvironment({
    catalog,
    scenario,
    ambientEnvironment = {},
    internalEnvironment = {}
})
{
    const childEnvironment = {};
    const requiredKeys = [
        ...catalog.childEnvironmentContract.requiredBaseKeys,
        ...scenario.command.inheritEnv.required
    ];
    const optionalKeys = [
        ...catalog.childEnvironmentContract.optionalBaseKeys,
        ...scenario.command.inheritEnv.optional
    ];
    for (const key of requiredKeys)
    {
        if (!Object.hasOwn(ambientEnvironment, key) || String(ambientEnvironment[key] ?? '') === '')
        {
            throw new Error(`required inherited child environment key is missing: ${key}`);
        }
        childEnvironment[key] = String(ambientEnvironment[key]);
    }
    for (const key of optionalKeys)
    {
        if (Object.hasOwn(ambientEnvironment, key) && ambientEnvironment[key] !== undefined)
        {
            childEnvironment[key] = String(ambientEnvironment[key]);
        }
    }
    const invalidInternalKey = Object.keys(internalEnvironment).find(
        (key) => !catalog.childEnvironmentContract.internalKeys.includes(key)
    );
    if (invalidInternalKey)
    {
        throw new Error(`undeclared internal child environment key: ${invalidInternalKey}`);
    }
    if (Object.values(internalEnvironment).some((value) => typeof value !== 'string'))
    {
        throw new Error('internal child environment values must be strings');
    }
    Object.assign(childEnvironment, scenario.command.env, internalEnvironment);
    return childEnvironment;
}

export function validateCatalog(catalog)
{
    const errors = [];
    if (catalog?.schema !== 'fsusblog.release-reliability-scenario-catalog.v4')
    {
        errors.push(`catalog schema must be fsusblog.release-reliability-scenario-catalog.v4, found: ${catalog?.schema ?? '<missing>'}`);
    }
    if (!uniqueStrings(catalog?.canonicalScenarioIds))
    {
        errors.push('canonicalScenarioIds must be a sorted, unique, non-empty string array');
    }
    if (catalog?.catalogScenarioCount !== canonicalScenarioIds.length
        || JSON.stringify(catalog?.canonicalScenarioIds) !== JSON.stringify(canonicalScenarioIds))
    {
        errors.push('canonicalScenarioIds must exactly equal the fixed seven-scenario release contract');
    }
    if (!sortedUniqueStrings(catalog?.identityTools))
    {
        errors.push('identityTools must be a sorted, unique, non-empty string array');
    }
    if (!sameJson(catalog?.childEnvironmentContract, canonicalChildEnvironmentContract))
    {
        errors.push('childEnvironmentContract must exactly equal the canonical positive allowlist');
    }
    if (!sameJson(catalog?.policyBindings, canonicalPolicyBindings))
    {
        errors.push('policyBindings must exactly equal the canonical qualification policy files');
    }
    if (catalog?.actionRegistry
        !== 'config/testing/release-reliability-lifecycle-action-registry.json')
    {
        errors.push('actionRegistry must bind the canonical lifecycle action registry');
    }
    requireNonEmptyString(catalog?.lifecycleSchema, 'lifecycleSchema', errors);
    if (!Array.isArray(catalog?.scenarios) || catalog.scenarios.length !== catalog?.catalogScenarioCount)
    {
        errors.push('catalogScenarioCount must exactly equal scenarios.length');
        return errors;
    }
    const ids = catalog.scenarios.map((scenario) => scenario?.id);
    if (JSON.stringify(ids) !== JSON.stringify(catalog.canonicalScenarioIds))
    {
        errors.push('scenario IDs must exactly equal canonicalScenarioIds in canonical order');
    }
    const declaredToolUnion = new Set();
    for (const scenario of catalog.scenarios)
    {
        const prefix = `scenario ${scenario?.id ?? '<missing>'}`;
        requireNonEmptyString(scenario?.id, `${prefix}.id`, errors);
        requireNonEmptyString(scenario?.owner, `${prefix}.owner`, errors);
        requireNonEmptyString(scenario?.command?.executable, `${prefix}.command.executable`, errors);
        if (typeof scenario?.command === 'string')
        {
            errors.push(`${prefix}.command is forbidden; use command.executable and command.args`);
        }
        if (!Array.isArray(scenario?.command?.args)
            || scenario.command.args.some((argument) => typeof argument !== 'string'))
        {
            errors.push(`${prefix}.command.args must be an array of strings`);
        }
        if (scenario?.command?.env === null || Array.isArray(scenario?.command?.env)
            || Object.values(scenario?.command?.env ?? {}).some((value) => typeof value !== 'string'))
        {
            errors.push(`${prefix}.command.env must contain only string values`);
        }
        if (!sortedUniqueStringArray(scenario?.command?.inheritEnv?.required)
            || !sortedUniqueStringArray(scenario?.command?.inheritEnv?.optional, { allowEmpty: true }))
        {
            errors.push(`${prefix}.command.inheritEnv must contain sorted required/optional arrays`);
        }
        else
        {
            const inheritedKeys = [
                ...scenario.command.inheritEnv.required,
                ...scenario.command.inheritEnv.optional
            ];
            if (new Set(inheritedKeys).size !== inheritedKeys.length
                || inheritedKeys.some((key) => Object.hasOwn(scenario.command.env, key))
                || inheritedKeys.some((key) => catalog.childEnvironmentContract.internalKeys.includes(key)))
            {
                errors.push(`${prefix}.command child environment key ownership overlaps`);
            }
        }
        if (Object.keys(scenario?.command?.env ?? {}).some(
            (key) => /(?:SECRET|TOKEN|PASSWORD|PRIVATE|SIGNING_KEY)/iu.test(key)
        ))
        {
            errors.push(`${prefix}.command.env cannot contain secret-bearing values`);
        }
        const canonicalSemantics = canonicalScenarioSemantics[scenario.id];
        if (!canonicalSemantics
            || !sameJson(scenario.command.env, canonicalSemantics.env)
            || !sameJson(
                scenario.command.inheritEnv,
                canonicalScenarioInheritedEnvironment[scenario.id]
            )
            || !sameJson(scenario.qualification, canonicalSemantics.qualification))
        {
            errors.push(`${prefix} canonical command environment/qualification contract mismatch`);
        }
        requireNonEmptyString(scenario?.command?.cwd, `${prefix}.command.cwd`, errors);
        requireNonEmptyString(scenario?.resourceClass, `${prefix}.resourceClass`, errors);
        if (!sortedUniqueStrings(scenario?.identityTools)
            || scenario.identityTools.some((tool) => !catalog.identityTools.includes(tool)))
        {
            errors.push(`${prefix}.identityTools must be a sorted subset of catalog.identityTools`);
        }
        else
        {
            for (const tool of scenario.identityTools)
            {
                declaredToolUnion.add(tool);
            }
        }
        const executableIdentity = path.basename(String(scenario?.command?.executable ?? ''))
            .replace(/\.exe$/iu, '');
        if (!scenario?.identityTools?.includes(executableIdentity))
        {
            errors.push(`${prefix}.identityTools must include command.executable`);
        }
        if (!uniqueStrings(scenario?.isolation?.exclusiveResources))
        {
            errors.push(`${prefix}.isolation.exclusiveResources must be sorted and unique`);
        }
        if (!uniqueStringArray(scenario?.isolation?.countableResources))
        {
            errors.push(`${prefix}.isolation.countableResources must be an explicit unique string array`);
        }
        if (scenario?.isolation?.exclusiveResources?.some(
            (resource) => scenario.isolation.countableResources?.includes(resource)
        ))
        {
            errors.push(`${prefix} resource cannot be both exclusive and countable`);
        }
        const lifecycle = scenario?.isolation?.lifecycle;
        const expectedLifecycleKeys = [
            'measurement',
            'postconditions',
            'preconditions',
            'resetsAfter',
            'resetsBefore'
        ];
        if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)
            || JSON.stringify(Object.keys(lifecycle).sort())
                !== JSON.stringify(expectedLifecycleKeys))
        {
            errors.push(`${prefix}.isolation.lifecycle must use the structured v4 action plan`);
        }
        else
        {
            for (const field of [
                'preconditions',
                'resetsBefore',
                'postconditions',
                'resetsAfter'
            ])
            {
                if (!sortedUniqueStringArray(lifecycle[field]))
                {
                    errors.push(`${prefix}.isolation.lifecycle.${field} must be a sorted unique action array`);
                }
            }
            requireNonEmptyString(
                lifecycle.measurement,
                `${prefix}.isolation.lifecycle.measurement`,
                errors
            );
        }
        if (!Array.isArray(scenario?.isolation?.outputs) || scenario.isolation.outputs.length !== 1)
        {
            errors.push(`${prefix}.isolation.outputs must contain exactly one authoritative output`);
        }
        else
        {
            for (const output of scenario.isolation.outputs)
            {
                requireNonEmptyString(output?.id, `${prefix}.isolation.outputs.id`, errors);
                requireNonEmptyString(output?.path, `${prefix}.isolation.outputs.path`, errors);
            }
        }
        requireNonEmptyString(scenario?.authoritativeEvidence?.path, `${prefix}.authoritativeEvidence.path`, errors);
        if (scenario?.isolation?.outputs?.[0]?.id !== 'authoritative-evidence'
            || scenario?.isolation?.outputs?.[0]?.path !== scenario?.authoritativeEvidence?.path)
        {
            errors.push(`${prefix} authoritative evidence must be the declared output`);
        }
        const expectedSchema = scenario?.authoritativeEvidence?.expectedSchema;
        if (!expectedSchema || typeof expectedSchema !== 'object' || Array.isArray(expectedSchema))
        {
            errors.push(`${prefix}.authoritativeEvidence.expectedSchema must be an object`);
        }
        else if (!uniqueStrings(expectedSchema.required)
            || !uniqueStrings(expectedSchema.passStatusValues))
        {
            errors.push(`${prefix}.authoritativeEvidence expected fields/status values must be non-empty strings`);
        }
        else if (!expectedSchema.required.includes('releaseReliability'))
        {
            errors.push(`${prefix}.authoritativeEvidence must require releaseReliability`);
        }
    }
    if (JSON.stringify([...declaredToolUnion].sort()) !== JSON.stringify(catalog.identityTools))
    {
        errors.push('catalog.identityTools must exactly equal the union of scenario identityTools');
    }
    if (Object.hasOwn(catalog ?? {}, 'schedulerTimeoutPolicies'))
    {
        errors.push(...validateReleaseReliabilitySchedulerCatalog(catalog));
    }
    return errors;
}

export function loadCatalog({ catalogFile = catalogPath } = {})
{
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    const errors = validateCatalog(catalog);
    if (errors.length > 0)
    {
        throw new Error(`Invalid release reliability catalog:\n- ${errors.join('\n- ')}`);
    }
    if (path.resolve(catalogFile) === path.resolve(catalogPath))
    {
        loadLifecycleActionContracts({ repositoryRoot: root, catalog });
    }
    return catalog;
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
}

function runRoot(repositoryRoot, invocationId)
{
    return relativePath(
        repositoryRoot,
        `.tmp/release-reliability/${safeSegment(invocationId, 'invocationId')}`,
        'invocation root'
    );
}

function resultPath(repositoryRoot, invocationId, scenarioId)
{
    return path.join(runRoot(repositoryRoot, invocationId), 'scenario-results', `${safeSegment(scenarioId, 'scenarioId')}.json`);
}

export function prepareInvocationOutputs({
    repositoryRoot = root,
    invocationId,
    scenarioId
})
{
    const invocationRoot = runRoot(repositoryRoot, invocationId);
    for (const name of [
        'candidate-receipt.json',
        'verified-attestation.json',
        'qualified-receipt.json',
        'timeline.json'
    ])
    {
        fs.rmSync(path.join(invocationRoot, name), { force: true });
    }
    if (scenarioId === null)
    {
        fs.rmSync(path.join(invocationRoot, 'scenario-results'), {
            recursive: true,
            force: true
        });
        return;
    }
    fs.rmSync(resultPath(repositoryRoot, invocationId, scenarioId), { force: true });
}

function repositoryRelative(repositoryRoot, file)
{
    return path.relative(repositoryRoot, file).replaceAll(path.sep, '/');
}

export function createReleaseReliabilityCancellation({
    parentSignal = null,
    now = () => new Date().toISOString()
} = {})
{
    const controller = new AbortController();
    const state = {
        kind: null,
        signal: null,
        reason: null,
        observedAt: null,
        duplicateRequests: 0
    };
    const request = ({
        kind = 'abort',
        signal = null,
        reason = null
    } = {}) =>
    {
        if (state.kind !== null)
        {
            state.duplicateRequests += 1;
            return false;
        }
        state.kind = kind;
        state.signal = signal;
        state.reason = reason instanceof Error
            ? reason.message
            : reason == null
                ? 'release reliability execution cancelled'
                : String(reason);
        state.observedAt = now();
        const error = reason instanceof Error
            ? reason
            : new Error(state.reason);
        error.name = kind === 'timeout' ? 'TimeoutError' : 'AbortError';
        error.signal = signal;
        error.releaseReliabilityCancellation = state;
        controller.abort(error);
        return true;
    };
    const onParentAbort = () =>
    {
        const parent = parentSignal.reason?.releaseReliabilityCancellation;
        request({
            kind: parent?.kind ?? 'abort',
            signal: parent?.signal ?? parentSignal.reason?.signal ?? null,
            reason: parentSignal.reason
        });
    };
    if (parentSignal?.aborted)
    {
        onParentAbort();
    }
    else
    {
        parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    }
    const dispose = () =>
    {
        parentSignal?.removeEventListener('abort', onParentAbort);
    };
    return {
        signal: controller.signal,
        request,
        snapshot: () => ({ ...state }),
        dispose
    };
}

export async function executeScenario({
    catalog,
    scenarioId,
    evidenceClass = 'diagnostic',
    qualificationEligible = false,
    repositoryRoot = root,
    invocationId,
    runId,
    identity,
    identityReference,
    spawnProcess = spawn,
    physicalExecution,
    signal = null,
    ambientEnvironment = process.env,
    requireSchedulerGrant = false,
    lifecycleContracts = null,
    now = () => new Date().toISOString()
})
{
    if (!(
        evidenceClass === 'correctness' && qualificationEligible === true
        || evidenceClass === 'diagnostic' && qualificationEligible === false
    ))
    {
        throw new Error('scenario execution requires an explicit correctness/true or diagnostic/false classification');
    }
    const scenario = catalog.scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario)
    {
        throw new Error(`Unknown scenario: ${scenarioId}`);
    }
    const commandToolId = path.basename(scenario.command.executable).replace(/\.exe$/iu, '');
    const resolvedExecutable = identity?.tools?.find((tool) => tool.id === commandToolId)?.executable
        ?? scenario.command.executable;
    const verifiedBackendContainerId = identity?.fixture?.topology?.content
        ?.runtime?.backendContainer?.id;
    const verifiedBackendHostPid = identity?.fixture?.topology?.content
        ?.runtime?.backendContainer?.hostPid;
    const verifiedContainerTarget = /^[0-9a-f]{64}$/u.test(
        String(verifiedBackendContainerId ?? '')
    ) && Number.isInteger(verifiedBackendHostPid) && verifiedBackendHostPid > 1;
    let childEnvironment = null;
    let environmentFailure = null;
    let schedulerGrant = null;
    let schedulerGrantFailure = null;
    try
    {
        schedulerGrant = resolveScenarioSchedulerGrant({
            catalog,
            scenario,
            runId,
            ambientEnvironment,
            requireSchedulerGrant
        });
    }
    catch (error)
    {
        schedulerGrantFailure = error instanceof Error ? error.message : String(error);
    }
    if (identity?.status === 'complete')
    {
        try
        {
            childEnvironment = buildScenarioChildEnvironment({
                catalog,
                scenario,
                ambientEnvironment,
                internalEnvironment: {
                    FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: invocationId,
                    FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: runId,
                    FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID: scenario.id,
                    FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH: identityReference.path,
                    FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST: identityReference.contentDigest,
                    ...(verifiedContainerTarget
                        ? {
                            FSUSBLOG_RELEASE_RESOURCE_CONTAINER_ID: verifiedBackendContainerId,
                            FSUSBLOG_RELEASE_RESOURCE_PID: String(verifiedBackendHostPid)
                        }
                        : {})
                }
            });
        }
        catch (error)
        {
            environmentFailure = error instanceof Error ? error.message : String(error);
        }
    }
    const contracts = lifecycleContracts ?? loadLifecycleActionContracts({
        repositoryRoot,
        catalog
    });
    const cannotRun = identity?.status !== 'complete'
        ? 'run identity is incomplete; lifecycle actions were not executed'
        : schedulerGrantFailure !== null
            ? `scheduler grant admission failed: ${schedulerGrantFailure}`
            : environmentFailure === null
                ? null
                : `child environment contract failed: ${environmentFailure}`;
    const lifecycle = cannotRun === null
        ? await executeLifecycleActionPlan({
            contracts,
            scenario,
            repositoryRoot,
            invocationId,
            runId,
            identity,
            identityReference,
            actionEnvironment: {
                ...childEnvironment,
                FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID:
                    `${invocationId}.attempt-1`,
                ...Object.fromEntries([
                    'FSUSBLOG_RELEASE_RUNTIME_IMAGE',
                    'FSUSBLOG_TEST_FIXTURE_CONFIG',
                    'FSUSBLOG_DATA_SCALE_CALLER_JOURNAL'
                ].filter((key) => ambientEnvironment[key]).map((key) => [
                    key,
                    String(ambientEnvironment[key])
                ])),
                ...Object.fromEntries([
                    'FSUSBLOG_DATA_SCALE_RUNTIME_RECEIPT_PATH',
                    'FSUSBLOG_DATA_SCALE_TEARDOWN_RECEIPT_PATH'
                ].filter((key) => ambientEnvironment[key]).map((key) => [
                    key,
                    String(ambientEnvironment[key])
                ]))
            },
            measurementEnvironment: childEnvironment,
            signal,
            spawnProcess,
            ...(physicalExecution === undefined ? {} : { physicalExecution })
        })
        : {
            status: 'failed',
            actions: [],
            verifiedActionReceipts: [],
            resetPostObservation: { status: 'failed', postStateDigest: null },
            finalPostObservation: { status: 'failed', postStateDigest: null },
            measurementRecord: null,
            firstFailure: {
                actionId: null,
                phase: 'admission',
                kind: 'verification',
                message: cannotRun
            },
            cleanupFailures: []
        };
    const measurement = lifecycle.measurementRecord;
    const evidenceReference = measurement?.receipt ?? measurement?.failureEvidence ?? null;
    const evidence = evidenceReference === null
        ? null
        : {
            path: evidenceReference.path,
            digest: evidenceReference.bytesDigest,
            schema: evidenceReference.schema,
            status: evidenceReference.status
        };
    const failure = lifecycle.firstFailure?.message ?? null;
    const actionTimes = lifecycle.actions.filter(
        (action) => action.startedAt !== null && action.finishedAt !== null
    );
    const startedAt = actionTimes[0]?.startedAt ?? now();
    const finishedAt = actionTimes.at(-1)?.finishedAt ?? startedAt;

    const resultFile = resultPath(repositoryRoot, invocationId, scenario.id);
    const result = sealDocument({
        schema: 'fsusblog.release-reliability-scenario-result.v3',
        invocationId,
        runId,
        scenarioId: scenario.id,
        resultPath: repositoryRelative(repositoryRoot, resultFile),
        owner: scenario.owner,
        resourceClass: scenario.resourceClass,
        evidenceClass,
        qualificationEligible: qualificationEligible && lifecycle.status === 'passed',
        status: lifecycle.status,
        identity: identityReference,
        startedAt,
        finishedAt,
        producer: {
            executable: resolvedExecutable,
            args: scenario.command.args,
            env: scenario.command.env ?? {},
            environmentContract: scenarioEnvironmentContract(catalog, scenario),
            cwd: scenario.command.cwd,
            commandDigest: sha256(JSON.stringify(scenario.command)),
            schedulerGrant,
            exitCode: measurement?.exitCode ?? null,
            signal: measurement?.signal ?? null,
            timedOut: measurement?.timedOut ?? false,
            stdoutLog: measurement?.stdoutLog ?? null,
            stderrLog: measurement?.stderrLog ?? null,
            processTreeReceipt: measurement?.processTreeReceipt ?? null
        },
        lifecycle: {
            actions: lifecycle.actions,
            verifiedActionReceipts: lifecycle.verifiedActionReceipts,
            resetPostObservation: lifecycle.resetPostObservation,
            finalPostObservation: lifecycle.finalPostObservation
        },
        firstFailure: lifecycle.firstFailure,
        cleanupFailures: lifecycle.cleanupFailures,
        terminalFence: measurement?.terminalFence ?? {
            status: 'closed',
            sealedAt: finishedAt,
            lateEvidenceAccepted: false
        },
        cancellation: ['cancelled', 'timed-out'].includes(lifecycle.status)
            ? measurement?.processTreeReceipt ?? null
            : null,
        producerSpawned: measurement?.producerSpawned === true,
        authoritativeEvidence: evidence,
        outputs: evidence === null
            ? []
            : [{ id: 'authoritative-evidence', path: evidence.path, digest: evidence.digest }],
        failure,
        recordedAt: now()
    });
    writeJsonAtomic(resultFile, result);
    return result;
}

export async function executeScenarios({
    catalog,
    scenarioId = null,
    evidenceClass,
    qualificationEligible,
    repositoryRoot = root,
    invocationId,
    runId,
    identity,
    identityReference,
    spawnProcess = spawn,
    physicalExecution,
    signal = null,
    ambientEnvironment = process.env,
    requireSchedulerGrant = false,
    lifecycleContracts = null,
    now = () => new Date().toISOString()
})
{
    const expectedClassification = scenarioId === null
        ? { evidenceClass: 'correctness', qualificationEligible: true }
        : { evidenceClass: 'diagnostic', qualificationEligible: false };
    if (evidenceClass !== expectedClassification.evidenceClass
        || qualificationEligible !== expectedClassification.qualificationEligible)
    {
        throw new Error(
            scenarioId === null
                ? 'complete scenario execution must be classified as correctness and qualification eligible'
                : 'single-scenario execution must be classified as diagnostic and qualification ineligible'
        );
    }
    const scenarios = scenarioId === null
        ? catalog.scenarios
        : catalog.scenarios.filter((scenario) => scenario.id === scenarioId);
    if (scenarios.length === 0)
    {
        throw new Error(`Unknown scenario: ${scenarioId}`);
    }
    const resolvedLifecycleContracts = lifecycleContracts
        ?? loadLifecycleActionContracts({ repositoryRoot, catalog });
    const results = [];
    let blockingResult = null;
    for (const scenario of scenarios)
    {
        if (blockingResult !== null)
        {
            const resultFile = resultPath(repositoryRoot, invocationId, scenario.id);
            const finishedAt = now();
            const result = sealDocument({
                schema: 'fsusblog.release-reliability-scenario-result.v3',
                invocationId, runId, scenarioId: scenario.id,
                resultPath: repositoryRelative(repositoryRoot, resultFile),
                owner: scenario.owner, resourceClass: scenario.resourceClass,
                evidenceClass, qualificationEligible: false, status: 'not-reached',
                identity: identityReference, startedAt: null, finishedAt,
                producer: { exitCode: null, signal: null, timedOut: false },
                lifecycle: { actions: [], verifiedActionReceipts: [] },
                producerSpawned: false, authoritativeEvidence: null, outputs: [],
                firstFailure: {
                    phase: 'not-reached', kind: 'prior-scenario-fail-closed',
                    scenarioId: blockingResult.scenarioId,
                    message: `not reached after ${blockingResult.scenarioId} failed closed`
                },
                cleanupFailures: [], cancellation: null,
                failure: `not reached after ${blockingResult.scenarioId} failed closed`,
                recordedAt: finishedAt
            });
            writeJsonAtomic(resultFile, result);
            results.push(result);
            continue;
        }
        const result = await executeScenario({
            catalog,
            scenarioId: scenario.id,
            evidenceClass,
            qualificationEligible,
            repositoryRoot,
            invocationId,
            runId,
            identity,
            identityReference,
            spawnProcess,
            physicalExecution,
            signal,
            ambientEnvironment,
            requireSchedulerGrant,
            lifecycleContracts: resolvedLifecycleContracts,
            now
        });
        results.push(result);
        if (result.status !== 'passed')
        {
            blockingResult = result;
        }
    }
    return results;
}

function parseArgs(argumentsList)
{
    let scenario = null;
    let validateCatalogOnly = false;
    for (let index = 0; index < argumentsList.length; index += 1)
    {
        const argument = argumentsList[index];
        if (argument === '--scenario' && index + 1 < argumentsList.length)
        {
            scenario = argumentsList[++index];
        }
        else if (argument === '--validate-catalog')
        {
            validateCatalogOnly = true;
        }
        else
        {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    return { scenario, validateCatalogOnly };
}

async function main()
{
    const { scenario, validateCatalogOnly } = parseArgs(process.argv.slice(2));
    const catalog = loadCatalog();
    if (validateCatalogOnly)
    {
        console.log(`[release-reliability-catalog] valid catalog schema=${catalog.schema} count=${catalog.scenarios.length}`);
        return;
    }
    const invocationId = process.env.FSUSBLOG_RELEASE_INVOCATION_ID
        ? safeSegment(process.env.FSUSBLOG_RELEASE_INVOCATION_ID, 'FSUSBLOG_RELEASE_INVOCATION_ID')
        : randomUUID();
    const evidenceClass = scenario === null ? 'correctness' : 'diagnostic';
    const qualificationEligible = scenario === null;
    prepareInvocationOutputs({
        repositoryRoot: root,
        invocationId,
        scenarioId: scenario
    });
    const runId = safeSegment(process.env.FSUSBLOG_RELEASE_RUN_ID, 'FSUSBLOG_RELEASE_RUN_ID');
    if (process.env.FSUSBLOG_RELEASE_LOAD_RUNTIME_ENVIRONMENT === '1')
    {
        Object.assign(process.env, readQualifiedRuntimeEnvironment({
            repositoryRoot: root,
            namespace: process.env.FSUSBLOG_TEST_NAMESPACE,
            runId
        }));
    }
    const invocationRoot = runRoot(root, invocationId);
    const identityFile = path.join(invocationRoot, 'identity.json');
    const identity = await collectRunIdentity({
        repositoryRoot: root,
        catalog,
        invocationId,
        runId,
        scenarioId: scenario
    });
    writeJsonAtomic(identityFile, identity);
    const identityReference = {
        path: repositoryRelative(root, identityFile),
        contentDigest: identity.contentDigest
    };
    const lifecycleContracts = loadLifecycleActionContracts({
        repositoryRoot: root,
        catalog
    });
    const driverCancellation = createReleaseReliabilityCancellation();
    const signalHandlers = new Map(
        ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signalName) => [
            signalName,
            () => driverCancellation.request({
                kind: 'signal',
                signal: signalName,
                reason: new Error(
                    `release reliability execution cancelled by ${signalName}`
                )
            })
        ])
    );
    for (const [signalName, handler] of signalHandlers)
    {
        process.on(signalName, handler);
    }
    let results;
    try
    {
        results = await executeScenarios({
            catalog,
            scenarioId: scenario,
            evidenceClass,
            qualificationEligible,
            invocationId,
            runId,
            identity,
            identityReference,
            lifecycleContracts,
            requireSchedulerGrant: true,
            signal: driverCancellation.signal
        });
    }
    finally
    {
        for (const [signalName, handler] of signalHandlers)
        {
            process.off(signalName, handler);
        }
        driverCancellation.dispose();
    }
    for (const result of results)
    {
        console.log(`[release-reliability:${result.scenarioId}] status=${result.status} result=${result.resultPath}`);
    }
    if (scenario === null)
    {
        const createdAt = new Date().toISOString();
        const timeline = createTimeline({
            invocationId,
            runId,
            scenarioResults: results,
            identityReference,
            createdAt
        });
        const timelineFile = path.join(invocationRoot, 'timeline.json');
        writeJsonAtomic(timelineFile, timeline);
        const receipt = createCandidateReceipt({
            repositoryRoot: root,
            invocationId,
            runId,
            scenarioResults: results,
            identity,
            identityReference,
            timeline,
            timelineReference: {
                path: repositoryRelative(root, timelineFile),
                contentDigest: timeline.contentDigest
            },
            catalog,
            lifecycleContracts,
            createdAt
        });
        const receiptFile = path.join(invocationRoot, 'candidate-receipt.json');
        writeJsonAtomic(receiptFile, receipt);
        console.log(`[release-reliability:candidate] status=${receipt.status} receipt=${repositoryRelative(root, receiptFile)}`);
        if (receipt.status !== 'candidate')
        {
            process.exitCode = 1;
        }
    }
    if (results.some((result) => result.status !== 'passed'))
    {
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        console.error(`[release-reliability] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
