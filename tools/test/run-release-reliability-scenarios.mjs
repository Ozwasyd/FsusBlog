#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    collectRunIdentity,
    createCandidateReceipt,
    createTimeline,
    digestValue,
    sealDocument
} from './release-reliability-receipt.mjs';
import { readQualifiedRuntimeEnvironment } from './release-reliability-runtime-environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(root, 'config/testing/release-reliability-scenario-catalog.json');
const lifecyclePhases = ['precondition', 'reset', 'measurement', 'postcondition'];
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const isoTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
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
        'FSUSBLOG_RELEASE_RELIABILITY_LIFECYCLE_ROOT',
        'FSUSBLOG_RELEASE_RELIABILITY_RUN_ID',
        'FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID',
        'FSUSBLOG_RELEASE_RESOURCE_CONTAINER_ID',
        'FSUSBLOG_RELEASE_RESOURCE_PID'
    ]
};
const canonicalPolicyBindings = {
    loadProfile: 'tests/performance/perf-policy.yml',
    mutationSubset: 'config/testing/mutation/release-parity-subset.json',
    releaseResource: 'config/deployment/zero-downtime-resource-policy.json'
};
const canonicalRuntimeInheritedEnvironment = {
    required: [
        'FSUSBLOG_DEBUG_BACKEND_URL',
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
            'FSUSBLOG_DEBUG_BACKEND_URL',
            'FSUSBLOG_POSTGRES_CONTAINER_NAME',
            'FSUSBLOG_REDIS_CONTAINER_NAME',
            'FSUSBLOG_TEST_NAMESPACE',
            'FSUSBLOG_TEST_RUN_ID'
        ],
        optional: [
            'FSUSBLOG_AOT_CACHE_DIR',
            'FSUSBLOG_BACKEND_WEBROOT',
            'FSUSBLOG_PUBLIC_AOT_CACHE_DIR',
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

function stateDomains(scenario)
{
    return [...new Set([
        ...scenario.isolation.exclusiveResources,
        ...scenario.isolation.countableResources
    ])].sort();
}

export function validateCatalog(catalog)
{
    const errors = [];
    if (catalog?.schema !== 'fsusblog.release-reliability-scenario-catalog.v3')
    {
        errors.push(`catalog schema must be fsusblog.release-reliability-scenario-catalog.v3, found: ${catalog?.schema ?? '<missing>'}`);
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
        for (const phase of lifecyclePhases)
        {
            requireNonEmptyString(
                scenario?.isolation?.lifecycle?.[phase],
                `${prefix}.isolation.lifecycle.${phase}`,
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

function lifecyclePath(repositoryRoot, invocationId, scenarioId, phase)
{
    return path.join(
        runRoot(repositoryRoot, invocationId),
        'lifecycle',
        safeSegment(scenarioId, 'scenarioId'),
        `${phase}.json`
    );
}

function repositoryRelative(repositoryRoot, file)
{
    return path.relative(repositoryRoot, file).replaceAll(path.sep, '/');
}

function validateEvidence(document, expectedSchema, expectedBinding)
{
    if (document === null || typeof document !== 'object' || Array.isArray(document))
    {
        throw new Error('authoritative evidence must be a JSON object');
    }
    for (const field of expectedSchema.required)
    {
        if (!(field in document))
        {
            throw new Error(`authoritative evidence is missing required field: ${field}`);
        }
    }
    if (!expectedSchema.passStatusValues.includes(document.status))
    {
        throw new Error(`authoritative evidence has non-passing status: ${document.status ?? '<missing>'}`);
    }
    if (expectedSchema.schema !== undefined && document.schema !== expectedSchema.schema)
    {
        throw new Error(`authoritative evidence schema mismatch: expected ${expectedSchema.schema}, found ${document.schema ?? '<missing>'}`);
    }
    if (JSON.stringify(document.releaseReliability) !== JSON.stringify(expectedBinding))
    {
        throw new Error('authoritative evidence is not bound to the current release reliability invocation');
    }
}

function validateIsoTime(value, label)
{
    if (!isoTimePattern.test(String(value ?? '')) || !Number.isFinite(Date.parse(value)))
    {
        throw new Error(`${label} must be an ISO UTC time`);
    }
}

function lifecycleReference({
    repositoryRoot,
    file,
    phase,
    scenario,
    catalog,
    invocationId,
    runId,
    identityReference
})
{
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    {
        throw new Error(`${phase} lifecycle receipt is unavailable`);
    }
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (receipt.schema !== catalog.lifecycleSchema || receipt.status !== 'complete'
        || receipt.phase !== phase || receipt.scenarioId !== scenario.id
        || receipt.invocationId !== invocationId || receipt.runId !== runId
        || receipt.identity?.path !== identityReference.path
        || receipt.identity?.contentDigest !== identityReference.contentDigest)
    {
        throw new Error(`${phase} lifecycle receipt identity/schema/status mismatch`);
    }
    if (receipt.declaration !== scenario.isolation.lifecycle[phase]
        || JSON.stringify(receipt.stateDomains) !== JSON.stringify(stateDomains(scenario)))
    {
        throw new Error(`${phase} lifecycle receipt state declaration mismatch`);
    }
    if (!receipt.state || typeof receipt.state.before !== 'string' || !receipt.state.before
        || typeof receipt.state.after !== 'string' || !receipt.state.after
        || !receipt.observations || typeof receipt.observations !== 'object'
        || Array.isArray(receipt.observations) || Object.keys(receipt.observations).length === 0)
    {
        throw new Error(`${phase} lifecycle receipt lacks observed state`);
    }
    validateIsoTime(receipt.startedAt, `${phase}.startedAt`);
    validateIsoTime(receipt.finishedAt, `${phase}.finishedAt`);
    if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)
        || !digestPattern.test(receipt.contentDigest) || receipt.contentDigest !== digestValue(receipt))
    {
        throw new Error(`${phase} lifecycle receipt time/contentDigest is invalid`);
    }
    return {
        path: repositoryRelative(repositoryRoot, file),
        schema: receipt.schema,
        phase,
        scenarioId: scenario.id,
        runId,
        invocationId,
        stateDomains: receipt.stateDomains,
        status: receipt.status,
        contentDigest: receipt.contentDigest,
        startedAt: receipt.startedAt,
        finishedAt: receipt.finishedAt
    };
}

function validateLifecycleOrder(lifecycle)
{
    for (let index = 1; index < lifecyclePhases.length; index += 1)
    {
        const previous = lifecycle[lifecyclePhases[index - 1]];
        const current = lifecycle[lifecyclePhases[index]];
        if (Date.parse(current.startedAt) < Date.parse(previous.finishedAt))
        {
            throw new Error(`lifecycle phase ${current.phase} overlaps or precedes ${previous.phase}`);
        }
    }
}

function runProcess({ executable, args, cwd, env, stdoutLog, stderrLog, spawnProcess })
{
    return new Promise((resolve) =>
    {
        const startedAtMs = Date.now();
        let child;
        try
        {
            child = spawnProcess(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (error)
        {
            resolve({
                startedAtMs,
                finishedAtMs: Date.now(),
                exitCode: null,
                signal: null,
                spawnError: error instanceof Error ? error.message : String(error)
            });
            return;
        }
        if (!child || typeof child.once !== 'function' || !child.stdout || !child.stderr)
        {
            resolve({
                startedAtMs,
                finishedAtMs: Date.now(),
                exitCode: null,
                signal: null,
                spawnError: 'producer spawn did not return a child process with stdout and stderr streams'
            });
            return;
        }
        fs.mkdirSync(path.dirname(stdoutLog), { recursive: true });
        const stdout = fs.createWriteStream(stdoutLog, { flags: 'w' });
        const stderr = fs.createWriteStream(stderrLog, { flags: 'w' });
        let logError = null;
        for (const stream of [stdout, stderr])
        {
            stream.on('error', (error) =>
            {
                logError ??= error instanceof Error ? error.message : String(error);
            });
        }
        child.stdout.pipe(stdout);
        child.stderr.pipe(stderr);
        let completed = false;
        const complete = async (outcome) =>
        {
            if (completed)
            {
                return;
            }
            completed = true;
            await Promise.all([stdout, stderr].map((stream) => new Promise((finish) =>
            {
                if (stream.writableFinished || stream.destroyed)
                {
                    finish();
                    return;
                }
                stream.end(finish);
            })));
            resolve({
                startedAtMs,
                finishedAtMs: Date.now(),
                ...outcome,
                spawnError: outcome.spawnError ?? (logError === null ? null : `producer log capture failed: ${logError}`)
            });
        };
        child.once('error', (error) => complete({
            exitCode: null,
            signal: null,
            spawnError: error instanceof Error ? error.message : String(error)
        }));
        child.once('close', (exitCode, signal) => complete({
            exitCode,
            signal,
            spawnError: null
        }));
    });
}

export async function executeScenario({
    catalog,
    scenarioId,
    repositoryRoot = root,
    invocationId,
    runId,
    identity,
    identityReference,
    spawnProcess = spawn,
    ambientEnvironment = process.env,
    now = () => new Date().toISOString()
})
{
    const scenario = catalog.scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario)
    {
        throw new Error(`Unknown scenario: ${scenarioId}`);
    }
    const commandCwd = relativePath(repositoryRoot, scenario.command.cwd, 'command cwd', { allowRoot: true });
    const commandToolId = path.basename(scenario.command.executable).replace(/\.exe$/iu, '');
    const resolvedExecutable = identity?.tools?.find((tool) => tool.id === commandToolId)?.executable
        ?? scenario.command.executable;
    const evidenceFile = relativePath(repositoryRoot, scenario.authoritativeEvidence.path, 'authoritative evidence');
    const invocationRoot = runRoot(repositoryRoot, invocationId);
    const stdoutLog = path.join(invocationRoot, 'logs', `${scenario.id}.stdout.log`);
    const stderrLog = path.join(invocationRoot, 'logs', `${scenario.id}.stderr.log`);
    const lifecycleFiles = Object.fromEntries(lifecyclePhases.map((phase) => [
        phase,
        lifecyclePath(repositoryRoot, invocationId, scenario.id, phase)
    ]));
    const cleanupTargets = [evidenceFile, ...Object.values(lifecycleFiles)];
    let cleanupFailure = null;
    try
    {
        for (const file of cleanupTargets)
        {
            fs.rmSync(file, { force: true });
        }
    }
    catch (error)
    {
        cleanupFailure = error instanceof Error ? error.message : String(error);
    }
    const verifiedBackendContainerId = identity?.fixture?.topology?.content
        ?.runtime?.backendContainer?.id;
    const verifiedBackendHostPid = identity?.fixture?.topology?.content
        ?.runtime?.backendContainer?.hostPid;
    const verifiedContainerTarget = /^[0-9a-f]{64}$/u.test(
        String(verifiedBackendContainerId ?? '')
    ) && Number.isInteger(verifiedBackendHostPid) && verifiedBackendHostPid > 1;
    let childEnvironment = null;
    let environmentFailure = null;
    if (cleanupFailure === null && identity?.status === 'complete')
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
                        : {}),
                    FSUSBLOG_RELEASE_RELIABILITY_LIFECYCLE_ROOT: repositoryRelative(
                        repositoryRoot,
                        path.dirname(lifecycleFiles.precondition)
                    )
                }
            });
        }
        catch (error)
        {
            environmentFailure = error instanceof Error ? error.message : String(error);
        }
    }
    const canRun = cleanupFailure === null && identity?.status === 'complete'
        && environmentFailure === null;
    const outcome = canRun
        ? await runProcess({
            executable: resolvedExecutable,
            args: scenario.command.args,
            cwd: commandCwd,
            env: childEnvironment,
            stdoutLog,
            stderrLog,
            spawnProcess
        })
        : {
            startedAtMs: Date.now(),
            finishedAtMs: Date.now(),
            exitCode: null,
            signal: null,
            spawnError: null
        };
    let failure = null;
    if (cleanupFailure)
    {
        failure = `freshness cleanup failed: ${cleanupFailure}`;
    }
    else if (identity?.status !== 'complete')
    {
        failure = 'run identity is incomplete; producer was not executed';
    }
    else if (environmentFailure)
    {
        failure = `child environment contract failed: ${environmentFailure}`;
    }
    else if (outcome.spawnError)
    {
        failure = `producer spawn failed: ${outcome.spawnError}`;
    }
    else if (outcome.signal)
    {
        failure = `producer terminated by signal: ${outcome.signal}`;
    }
    else if (outcome.exitCode !== 0)
    {
        failure = `producer exited with code: ${outcome.exitCode}`;
    }

    const expectedEvidenceBinding = {
        invocationId,
        runId,
        scenarioId: scenario.id,
        identityContentDigest: identityReference.contentDigest,
        sourceState: identity.sourceState,
        buildContentDigest: identity.build.contentDigest
    };
    let evidence = null;
    let lifecycle = null;
    if (failure === null)
    {
        try
        {
            if (!fs.existsSync(evidenceFile) || !fs.lstatSync(evidenceFile).isFile()
                || fs.lstatSync(evidenceFile).isSymbolicLink())
            {
                throw new Error(`authoritative evidence was not produced: ${scenario.authoritativeEvidence.path}`);
            }
            const bytes = fs.readFileSync(evidenceFile);
            const document = JSON.parse(bytes.toString('utf8'));
            validateEvidence(document, scenario.authoritativeEvidence.expectedSchema, expectedEvidenceBinding);
            evidence = {
                path: scenario.authoritativeEvidence.path,
                digest: sha256(bytes),
                schema: document.schema ?? null,
                status: document.status
            };
            lifecycle = Object.fromEntries(lifecyclePhases.map((phase) => [
                phase,
                lifecycleReference({
                    repositoryRoot,
                    file: lifecycleFiles[phase],
                    phase,
                    scenario,
                    catalog,
                    invocationId,
                    runId,
                    identityReference
                })
            ]));
            validateLifecycleOrder(lifecycle);
            if (Date.parse(lifecycle.precondition.startedAt) < outcome.startedAtMs
                || Date.parse(lifecycle.postcondition.finishedAt) > outcome.finishedAtMs)
            {
                throw new Error('lifecycle receipts escape the producer process window');
            }
        }
        catch (error)
        {
            failure = error instanceof Error ? error.message : String(error);
        }
    }

    const resultFile = resultPath(repositoryRoot, invocationId, scenario.id);
    const result = sealDocument({
        schema: 'fsusblog.release-reliability-scenario-result.v2',
        invocationId,
        runId,
        scenarioId: scenario.id,
        resultPath: repositoryRelative(repositoryRoot, resultFile),
        owner: scenario.owner,
        resourceClass: scenario.resourceClass,
        status: failure === null ? 'passed' : 'failed',
        identity: identityReference,
        startedAt: new Date(outcome.startedAtMs).toISOString(),
        finishedAt: new Date(outcome.finishedAtMs).toISOString(),
        producer: {
            executable: resolvedExecutable,
            args: scenario.command.args,
            env: scenario.command.env ?? {},
            environmentContract: scenarioEnvironmentContract(catalog, scenario),
            cwd: scenario.command.cwd,
            commandDigest: sha256(JSON.stringify(scenario.command)),
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            stdoutLog: repositoryRelative(repositoryRoot, stdoutLog),
            stderrLog: repositoryRelative(repositoryRoot, stderrLog)
        },
        lifecycle,
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
    repositoryRoot = root,
    invocationId,
    runId,
    identity,
    identityReference,
    spawnProcess = spawn,
    ambientEnvironment = process.env,
    now = () => new Date().toISOString()
})
{
    const scenarios = scenarioId === null
        ? catalog.scenarios
        : catalog.scenarios.filter((scenario) => scenario.id === scenarioId);
    if (scenarios.length === 0)
    {
        throw new Error(`Unknown scenario: ${scenarioId}`);
    }
    const results = [];
    for (const scenario of scenarios)
    {
        results.push(await executeScenario({
            catalog,
            scenarioId: scenario.id,
            repositoryRoot,
            invocationId,
            runId,
            identity,
            identityReference,
            spawnProcess,
            ambientEnvironment,
            now
        }));
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
    const results = await executeScenarios({
        catalog,
        scenarioId: scenario,
        invocationId,
        runId,
        identity,
        identityReference
    });
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
