
/* eslint-disable import-x/no-relative-parent-imports -- Integrate the existing canonical lifecycle and resource observer owners. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { postgresqlDatabaseStateDigest } from '../test-runtime/production-observer-ports.mjs';

import {
    loadPhysicalExecutionProcessPolicy,
    runPhysicalExecution
} from './physical-execution-process-tree.mjs';
import { sealDocument } from './release-reliability-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const actionRegistryRelativePath =
    'config/testing/release-reliability-lifecycle-action-registry.json';
export const actionRegistrySchemaRelativePath =
    'config/schemas/release-reliability-lifecycle-action-registry.schema.json';
export const scenarioCatalogRelativePath =
    'config/testing/release-reliability-scenario-catalog.json';
export const stateDomainRegistryRelativePath =
    'config/testing/runtime-state-domain-registry.json';
export const lifecyclePhaseOrder = [
    'precondition',
    'reset-before',
    'measurement',
    'postcondition',
    'reset-after'
];

/** Validate native database invariants and the observable result of a scoped cache reset. */
export function ordinaryRuntimeResourceStateErrors({ action, observation, topology, reset })
{
    const errors = [];
    const state = observation?.resourceState;
    const baseline = topology?.resourceState;
    const validDatabase = (value) => value?.status === 'observed'
        && value.database === 'fsusblog'
        && /^sha256:[0-9a-f]{64}$/u.test(String(value.schemaDigest ?? ''))
        && Array.isArray(value.relations)
        && value.relations.every((entry) => typeof entry.name === 'string'
            && ['r', 'm', 'S'].includes(entry.kind)
            && Number.isSafeInteger(entry.rowCount) && entry.rowCount >= 0
            && /^sha256:[0-9a-f]{64}$/u.test(String(entry.rowsDigest ?? '')))
        && value.stateDigest === postgresqlDatabaseStateDigest(value);
    if (!validDatabase(state?.postgres) || !validDatabase(baseline?.postgres)
        || state.postgres.stateDigest !== baseline.postgres.stateDigest)
    {
        errors.push('database schema/rows/sequences differ from admitted fixture baseline or are unobserved');
    }
    const validCache = (value) => value?.status === 'observed'
        && typeof value.namespacePrefix === 'string' && /^[A-Za-z0-9_.-]+_$/u.test(value.namespacePrefix)
        && Number.isSafeInteger(value.publicKeyCount) && value.publicKeyCount >= 0
        && Array.isArray(value.keyDigests) && value.keyDigests.length === value.publicKeyCount
        && sortedUniqueStrings(value.keyDigests, { allowEmpty: true })
        && value.keyDigests.every((digest) => /^sha256:[0-9a-f]{64}$/u.test(digest));
    if (!validCache(state?.redis) || !validCache(baseline?.redis)
        || state.redis.namespacePrefix !== baseline.redis.namespacePrefix)
    {
        errors.push('run-bound public cache keyspace is unobserved or has a different prefix');
    }
    if (action.operation === 'reset-runtime-state')
    {
        if (!validCache(state?.redis) || state.redis.publicKeyCount !== 0)
        {
            errors.push('public cache reset left keys in the current run');
        }
        if (reset?.status !== 'complete'
            || reset.containerId !== topology?.redis?.instance
            || reset.runId !== topology?.runId || reset.namespace !== topology?.namespace
            || reset.namespacePrefix !== baseline?.redis?.namespacePrefix
            || !validCache(reset.before) || !validCache(reset.after)
            || reset.before.namespacePrefix !== reset.namespacePrefix
            || reset.after.namespacePrefix !== reset.namespacePrefix
            || reset.after.publicKeyCount !== 0
            || !Array.isArray(reset.deleted)
            || reset.deleted.some((entry) => !reset.before.keyDigests.includes(entry.keyDigest)
                || ![0, 1].includes(entry.deletedCount))
            || new Set(reset.deleted.map((entry) => entry.keyDigest)).size !== reset.deleted.length)
        {
            errors.push('public cache reset execution/ownership evidence is incomplete');
        }
    }
    return errors;
}

function readJson(repositoryRoot, relativePath)
{
    return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
}

function sameStrings(left, right)
{
    return JSON.stringify(left) === JSON.stringify(right);
}

function sortedUniqueStrings(values, { allowEmpty = false } = {})
{
    return Array.isArray(values) && (allowEmpty || values.length > 0)
        && values.every((value) => typeof value === 'string' && value.trim())
        && sameStrings(values, [...new Set(values)].sort());
}

function validateRegistryShape(registry, schema)
{
    const errors = [];
    if (schema?.$id !== 'fsusblog.release-reliability-lifecycle-action-registry.v1')
    {
        errors.push('action registry schema identity is invalid');
    }
    const allowedRootKeys = new Set([
        'actions',
        'receiptSchema',
        'scenarioCatalog',
        'schema',
        'stateDomainRegistry'
    ]);
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)
        || Object.keys(registry).some((key) => !allowedRootKeys.has(key)))
    {
        errors.push('action registry must be a closed object');
        return errors;
    }
    if (registry.schema !== 'fsusblog.release-reliability-lifecycle-action-registry.v1'
        || registry.receiptSchema !== 'fsusblog.release-reliability-lifecycle-action-receipt.v2'
        || !Array.isArray(registry.actions) || registry.actions.length === 0)
    {
        errors.push('action registry schema/receipt/actions contract is invalid');
        return errors;
    }
    const requiredActionKeys = [
        'actionId',
        'args',
        'cwd',
        'env',
        'executable',
        'expectedReceiptPath',
        'expectedReceiptSchema',
        'operation',
        'passStatusValues',
        'phase',
        'requiredFields',
        'safeAfterFailure',
        'scenarioId',
        'stateDomains',
        'timeoutPolicy'
    ];
    const allowedActionKeys = new Set([
        ...requiredActionKeys,
        'ownerReceipt',
        'targets'
    ]);
    for (const [index, action] of registry.actions.entries())
    {
        const prefix = `actions[${index}]`;
        if (!action || typeof action !== 'object' || Array.isArray(action)
            || requiredActionKeys.some((key) => !Object.hasOwn(action, key))
            || Object.keys(action).some((key) => !allowedActionKeys.has(key)))
        {
            errors.push(`${prefix} must match the closed action schema`);
            continue;
        }
        if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u.test(action.actionId)
            || !/^release-[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(action.scenarioId)
            || !lifecyclePhaseOrder.includes(action.phase)
            || ![
                'cleanup-mutation-output',
                'observe-data-scale-runtime',
                'provision-data-scale-runtime',
                'observe-mutation',
                'observe-runtime',
                'prepare-evidence-files',
                'reset-runtime-state',
                'run-measurement',
                'teardown-data-scale-runtime'
            ].includes(action.operation)
            || typeof action.executable !== 'string' || !action.executable
            || !Array.isArray(action.args)
            || action.args.some((value) => typeof value !== 'string')
            || !action.env || typeof action.env !== 'object' || Array.isArray(action.env)
            || Object.values(action.env).some((value) => typeof value !== 'string')
            || typeof action.cwd !== 'string' || !action.cwd
            || typeof action.expectedReceiptPath !== 'string' || !action.expectedReceiptPath
            || typeof action.expectedReceiptSchema !== 'string'
            || !action.expectedReceiptSchema
            || !sortedUniqueStrings(action.requiredFields)
            || !sortedUniqueStrings(action.passStatusValues)
            || !sortedUniqueStrings(action.stateDomains)
            || typeof action.safeAfterFailure !== 'boolean')
        {
            errors.push(`${prefix} has invalid scalar or collection fields`);
        }
        if (!action.timeoutPolicy || typeof action.timeoutPolicy !== 'object'
            || !Number.isInteger(action.timeoutPolicy.timeoutMs)
            || action.timeoutPolicy.timeoutMs < 1
            || action.timeoutPolicy.timeoutMs > 1_800_000
            || !Number.isInteger(action.timeoutPolicy.terminateGraceMs)
            || action.timeoutPolicy.terminateGraceMs < 0
            || action.timeoutPolicy.terminateGraceMs > 30_000)
        {
            errors.push(`${prefix}.timeoutPolicy is invalid`);
        }
    }
    return errors;
}

export function lifecycleActionIds(scenario)
{
    const lifecycle = scenario?.isolation?.lifecycle;
    return [
        ...(lifecycle?.preconditions ?? []).map((actionId) => ({
            actionId,
            phase: 'precondition'
        })),
        ...(lifecycle?.resetsBefore ?? []).map((actionId) => ({
            actionId,
            phase: 'reset-before'
        })),
        ...(typeof lifecycle?.measurement === 'string'
            ? [{ actionId: lifecycle.measurement, phase: 'measurement' }]
            : []),
        ...(lifecycle?.postconditions ?? []).map((actionId) => ({
            actionId,
            phase: 'postcondition'
        })),
        ...(lifecycle?.resetsAfter ?? []).map((actionId) => ({
            actionId,
            phase: 'reset-after'
        }))
    ];
}

function validateLifecycleShape(scenario, errors)
{
    const prefix = `scenario ${scenario?.id ?? '<missing>'}.isolation.lifecycle`;
    const lifecycle = scenario?.isolation?.lifecycle;
    if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle))
    {
        errors.push(`${prefix} must be a structured object`);
        return;
    }
    const keys = Object.keys(lifecycle).sort();
    const expectedKeys = [
        'measurement',
        'postconditions',
        'preconditions',
        'resetsAfter',
        'resetsBefore'
    ];
    if (!sameStrings(keys, expectedKeys))
    {
        errors.push(`${prefix} must contain only preconditions/resetsBefore/measurement/postconditions/resetsAfter`);
    }
    for (const field of ['preconditions', 'resetsBefore', 'postconditions', 'resetsAfter'])
    {
        if (!sortedUniqueStrings(lifecycle[field]))
        {
            errors.push(`${prefix}.${field} must be a sorted unique non-empty action array`);
        }
    }
    if (typeof lifecycle.measurement !== 'string' || !lifecycle.measurement.trim())
    {
        errors.push(`${prefix}.measurement must be one action ID`);
    }
}

function validateActionOperation(action, scenario, errors)
{
    const prefix = `action ${action.actionId}`;
    if (action.phase === 'measurement')
    {
        if (action.operation !== 'run-measurement'
            || action.executable !== '$scenario.command'
            || action.expectedReceiptPath !== scenario.authoritativeEvidence.path)
        {
            errors.push(`${prefix} must execute and consume the catalog authoritative measurement`);
        }
        const expected = scenario.authoritativeEvidence.expectedSchema;
        if (!expected.passStatusValues.every((status) => action.passStatusValues.includes(status))
            || !expected.required.every((field) => action.requiredFields.includes(field)))
        {
            errors.push(`${prefix} measurement receipt contract is weaker than authoritativeEvidence`);
        }
    }
    else if (action.operation === 'run-measurement'
        || action.executable === '$scenario.command')
    {
        errors.push(`${prefix} only measurement may execute the scenario command`);
    }
    if (action.operation === 'prepare-evidence-files')
    {
        if (!sortedUniqueStrings(action.targets)
            || action.stateDomains.some((domain) => !domain.startsWith('artifact.')))
        {
            errors.push(`${prefix} evidence preparation must own sorted artifact targets only`);
        }
    }
    else if (action.operation === 'reset-runtime-state')
    {
        if (!['reset-before', 'reset-after'].includes(action.phase)
            || !action.stateDomains.includes('postgres.schema')
            || !action.stateDomains.includes('redis.cache.public')
            || Object.hasOwn(action, 'targets') && !sortedUniqueStrings(action.targets))
        {
            errors.push(`${prefix} runtime reset must verify database state and reset public cache`);
        }
    }
    else if (Object.hasOwn(action, 'targets'))
    {
        errors.push(`${prefix} non-preparation action cannot declare deletion targets`);
    }
    if (action.ownerReceipt)
    {
        if (![
            'observe-data-scale-runtime',
            'provision-data-scale-runtime',
            'teardown-data-scale-runtime'
        ]
            .includes(action.operation)
            || action.executable !== 'node'
            || action.expectedReceiptSchema
                !== 'fsusblog.release-reliability-lifecycle-action-receipt.v2'
            || !action.requiredFields.includes('ownerReceipt'))
        {
            errors.push(`${prefix} owner receipt adapter contract is invalid`);
        }
    }
    else if ([
        'observe-data-scale-runtime',
        'provision-data-scale-runtime',
        'teardown-data-scale-runtime'
    ]
        .includes(action.operation))
    {
        errors.push(`${prefix} owner receipt adapter must name its external owner`);
    }
    if (action.phase === 'reset-after')
    {
        if (action.safeAfterFailure !== true)
        {
            errors.push(`${prefix} reset-after must be explicitly safe after failure`);
        }
    }
    else if (action.safeAfterFailure !== false)
    {
        errors.push(`${prefix} only reset-after may be marked safe after failure`);
    }
}

export function validateLifecycleActionRegistry({
    registry,
    schema,
    catalog,
    stateDomainRegistry
})
{
    const errors = validateRegistryShape(registry, schema);
    if (catalog?.schema !== 'fsusblog.release-reliability-scenario-catalog.v4')
    {
        errors.push('scenario catalog must use schema v4');
    }
    if (catalog?.actionRegistry !== actionRegistryRelativePath
        || catalog?.lifecycleSchema !== registry?.receiptSchema)
    {
        errors.push('scenario catalog action registry/receipt schema binding is invalid');
    }
    if (registry?.scenarioCatalog !== scenarioCatalogRelativePath
        || registry?.stateDomainRegistry !== stateDomainRegistryRelativePath)
    {
        errors.push('action registry source bindings are invalid');
    }
    if (stateDomainRegistry?.schema !== 'fsusblog.runtime-state-domain-registry.v1'
        || !sortedUniqueStrings(stateDomainRegistry?.domains))
    {
        errors.push('runtime state-domain registry is invalid');
    }
    const knownDomains = new Set(stateDomainRegistry?.domains ?? []);
    const scenarios = new Map((catalog?.scenarios ?? []).map((scenario) => [
        scenario.id,
        scenario
    ]));
    const actions = new Map();
    for (const action of registry?.actions ?? [])
    {
        if (actions.has(action.actionId))
        {
            errors.push(`duplicate lifecycle action ID: ${action.actionId}`);
            continue;
        }
        actions.set(action.actionId, action);
        const scenario = scenarios.get(action.scenarioId);
        if (!scenario)
        {
            errors.push(`action ${action.actionId} names unknown scenario ${action.scenarioId}`);
            continue;
        }
        if (!sortedUniqueStrings(action.stateDomains)
            || action.stateDomains.some((domain) => !knownDomains.has(domain)))
        {
            errors.push(`action ${action.actionId} stateDomains must be sorted canonical domains`);
        }
        validateActionOperation(action, scenario, errors);
    }
    const referenced = [];
    for (const scenario of scenarios.values())
    {
        validateLifecycleShape(scenario, errors);
        const declaredDomains = scenario?.isolation?.exclusiveResources ?? [];
        if (!sortedUniqueStrings(declaredDomains))
        {
            errors.push(`scenario ${scenario.id} exclusiveResources must be sorted canonical domains`);
        }
        if (declaredDomains.some((domain) => !knownDomains.has(domain)))
        {
            errors.push(`scenario ${scenario.id} declares an unknown state domain`);
        }
        const coveredDomains = new Set();
        const lifecycleOwnedDomains = new Set();
        for (const reference of lifecycleActionIds(scenario))
        {
            referenced.push(reference.actionId);
            const action = actions.get(reference.actionId);
            if (!action)
            {
                errors.push(`scenario ${scenario.id} action is missing from registry: ${reference.actionId}`);
                continue;
            }
            if (action.scenarioId !== scenario.id || action.phase !== reference.phase)
            {
                errors.push(`scenario ${scenario.id} action phase/owner mismatch: ${reference.actionId}`);
            }
            for (const domain of action.stateDomains)
            {
                coveredDomains.add(domain);
                if (reference.phase !== 'measurement')
                {
                    lifecycleOwnedDomains.add(domain);
                }
                if (!declaredDomains.includes(domain))
                {
                    errors.push(`action ${action.actionId} owns undeclared scenario domain ${domain}`);
                }
            }
        }
        if (!sameStrings([...coveredDomains].sort(), declaredDomains))
        {
            errors.push(`scenario ${scenario.id} lifecycle action domain inventory is not exact`);
        }
        if (!sameStrings([...lifecycleOwnedDomains].sort(), declaredDomains))
        {
            errors.push(`scenario ${scenario.id} has an exclusive domain owned only by measurement`);
        }
    }
    const referenceCounts = new Map();
    for (const actionId of referenced)
    {
        referenceCounts.set(actionId, (referenceCounts.get(actionId) ?? 0) + 1);
    }
    for (const actionId of actions.keys())
    {
        if (referenceCounts.get(actionId) !== 1)
        {
            errors.push(`registry action must be referenced exactly once: ${actionId}`);
        }
    }
    return errors;
}

export function loadLifecycleActionContracts({
    repositoryRoot = root,
    catalog = null,
    registry = null,
    stateDomainRegistry = null
} = {})
{
    const schema = readJson(repositoryRoot, actionRegistrySchemaRelativePath);
    const resolvedCatalog = catalog
        ?? readJson(repositoryRoot, scenarioCatalogRelativePath);
    const resolvedRegistry = registry
        ?? readJson(repositoryRoot, actionRegistryRelativePath);
    const resolvedStateDomainRegistry = stateDomainRegistry
        ?? readJson(repositoryRoot, stateDomainRegistryRelativePath);
    const errors = validateLifecycleActionRegistry({
        registry: resolvedRegistry,
        schema,
        catalog: resolvedCatalog,
        stateDomainRegistry: resolvedStateDomainRegistry
    });
    if (errors.length > 0)
    {
        throw new Error(`Invalid release reliability lifecycle action registry:\n- ${errors.join('\n- ')}`);
    }
    return {
        catalog: resolvedCatalog,
        registry: resolvedRegistry,
        stateDomainRegistry: resolvedStateDomainRegistry,
        authorityBindings: {
            lifecycleActionRegistry: {
                status: 'complete',
                path: actionRegistryRelativePath,
                fileDigest: rawDigest(fs.readFileSync(
                    path.join(repositoryRoot, actionRegistryRelativePath)
                ))
            },
            stateDomainRegistry: {
                status: 'complete',
                path: stateDomainRegistryRelativePath,
                fileDigest: rawDigest(fs.readFileSync(
                    path.join(repositoryRoot, stateDomainRegistryRelativePath)
                ))
            }
        },
        actions: new Map(resolvedRegistry.actions.map((action) => [
            action.actionId,
            action
        ]))
    };
}

export function expandLifecycleTemplate(value, identity)
{
    const replacements = {
        actionId: identity.actionId,
        invocationId: identity.invocationId,
        runId: identity.runId,
        scenarioId: identity.scenarioId
    };
    return String(value).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key) =>
    {
        if (!Object.hasOwn(replacements, key)
            || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(String(replacements[key] ?? '')))
        {
            throw new Error(`lifecycle template token is unavailable: ${match}`);
        }
        return replacements[key];
    });
}

function repositoryRelative(repositoryRoot, absolutePath)
{
    return path.relative(repositoryRoot, absolutePath).replaceAll(path.sep, '/');
}

function resolveRepositoryPath(repositoryRoot, value, label, { allowRoot = false } = {})
{
    const relative = String(value ?? '').trim().replaceAll('\\', '/')
        .replace(/^\.\//u, '');
    const normalized = relative === '.' && allowRoot ? relative : path.posix.normalize(relative);
    if (!relative || path.posix.isAbsolute(relative)
        || normalized !== relative
        || relative.split('/').some((segment) => (
            !segment || segment === '..' || segment === '.' && !(allowRoot && relative === '.')
        )))
    {
        throw new Error(`${label} is unsafe`);
    }
    const absolute = path.resolve(repositoryRoot, relative);
    if ((!allowRoot && absolute === repositoryRoot)
        || absolute !== repositoryRoot
        && !absolute.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error(`${label} escapes the repository`);
    }
    return absolute;
}

function resolveExecutable(action, scenario, identity)
{
    const declared = action.executable === '$scenario.command'
        ? scenario.command.executable
        : action.executable;
    const toolId = path.basename(declared).replace(/\.exe$/iu, '');
    return identity?.tools?.find((tool) => tool.id === toolId)?.executable
        ?? (declared === 'node' ? process.execPath : declared);
}

function actionArguments(action, scenario, executionIdentity)
{
    const declared = action.executable === '$scenario.command'
        ? scenario.command.args
        : action.args;
    return declared.map((argument) =>
        expandLifecycleTemplate(argument, executionIdentity)
    );
}

function processFailure(outcome)
{
    if (outcome.cancelled)
    {
        return outcome.error?.message ?? 'action cancelled';
    }
    if (outcome.timedOut)
    {
        return outcome.error?.message ?? 'action timed out';
    }
    if (outcome.spawnError)
    {
        return `action spawn failed: ${outcome.spawnError}`;
    }
    if (outcome.error)
    {
        return outcome.error.message;
    }
    if (outcome.signal)
    {
        return `action terminated by signal: ${outcome.signal}`;
    }
    if (outcome.exitCode !== 0)
    {
        return `action exited with code: ${outcome.exitCode}`;
    }
    return null;
}

function openActionLogSinks(stdoutLog, stderrLog)
{
    fs.mkdirSync(path.dirname(stdoutLog), { recursive: true });
    const stdoutDescriptor = fs.openSync(stdoutLog, 'w', 0o600);
    let stderrDescriptor;
    try
    {
        stderrDescriptor = fs.openSync(stderrLog, 'w', 0o600);
    }
    catch (error)
    {
        fs.closeSync(stdoutDescriptor);
        throw error;
    }
    let closed = false;
    return {
        stdout: { write: (chunk) => fs.writeSync(stdoutDescriptor, chunk) },
        stderr: { write: (chunk) => fs.writeSync(stderrDescriptor, chunk) },
        close()
        {
            if (closed)
            {
                return;
            }
            closed = true;
            fs.closeSync(stdoutDescriptor);
            fs.closeSync(stderrDescriptor);
        }
    };
}

function physicalProcessReceiptPath(repositoryRoot, {
    invocationId,
    scenarioId,
    actionId
})
{
    return resolveRepositoryPath(
        repositoryRoot,
        `.tmp/release-reliability/${invocationId}/process-trees/${scenarioId}/${actionId}.json`,
        'physical process-tree receipt'
    );
}

function physicalPolicyBinding(repositoryRoot, identity)
{
    const binding = identity?.policy?.physicalExecution;
    const configuredPath = String(binding?.path ?? '').trim();
    if (!configuredPath || !/^sha256:[0-9a-f]{64}$/u.test(
        String(binding?.fileDigest ?? '')
    ))
    {
        throw new Error('physical execution policy is absent from run identity');
    }
    const absolute = resolveRepositoryPath(
        repositoryRoot,
        configuredPath,
        'physical execution policy'
    );
    const bytes = fs.readFileSync(absolute);
    if (rawDigest(bytes) !== binding.fileDigest)
    {
        throw new Error('physical execution policy bytes changed after identity collection');
    }
    return {
        binding: {
            status: 'complete',
            path: configuredPath,
            fileDigest: binding.fileDigest
        },
        policy: loadPhysicalExecutionProcessPolicy(absolute)
    };
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.next-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
    });
    fs.renameSync(temporary, file);
}

async function runActionProcess({
    executable,
    args,
    cwd,
    env,
    stdoutLog,
    stderrLog,
    timeoutPolicy,
    signal,
    physicalPolicy,
    residualRoot,
    physicalExecution,
    spawnProcess
})
{
    const startedAtMs = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    let cancellation = null;
    const cancel = (reason, kind) =>
    {
        if (controller.signal.aborted)
        {
            return false;
        }
        timedOut = kind === 'timeout';
        const inherited = reason?.releaseReliabilityCancellation ?? null;
        cancellation = {
            kind: inherited?.kind ?? kind,
            reason: reason instanceof Error ? reason.message : String(reason),
            signal: inherited?.signal ?? reason?.signal ?? null,
            observedAt: inherited?.observedAt ?? new Date().toISOString(),
            duplicateRequests: inherited?.duplicateRequests ?? 0
        };
        const error = reason instanceof Error ? reason : new Error(String(reason));
        error.name = timedOut ? 'TimeoutError' : 'AbortError';
        error.releaseReliabilityCancellation ??= cancellation;
        controller.abort(error);
        return true;
    };
    const onAbort = () => cancel(
        signal.reason ?? new Error('action cancelled'),
        signal.reason?.releaseReliabilityCancellation?.kind ?? 'cancelled'
    );
    if (signal?.aborted)
    {
        onAbort();
    }
    else
    {
        signal?.addEventListener('abort', onAbort, { once: true });
    }
    const timeout = setTimeout(() =>
    {
        const error = new Error(`action timeout after ${timeoutPolicy.timeoutMs}ms`);
        error.signal = null;
        cancel(error, 'timeout');
    }, timeoutPolicy.timeoutMs);
    timeout.unref?.();
    let logSinks = null;
    let evidence;
    let error = null;
    try
    {
        if (controller.signal.aborted)
        {
            throw controller.signal.reason;
        }
        logSinks = openActionLogSinks(stdoutLog, stderrLog);
        evidence = await physicalExecution({
            command: [executable, ...args],
            cwd,
            env,
            signal: controller.signal,
            policy: physicalPolicy,
            residualRoot,
            spawnProcess,
            stdout: logSinks.stdout,
            stderr: logSinks.stderr
        });
    }
    catch (caught)
    {
        error = caught instanceof Error ? caught : new Error(String(caught));
        evidence = error.physicalExecution ?? null;
    }
    finally
    {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        try
        {
            logSinks?.close();
        }
        catch (closeError)
        {
            error ??= closeError instanceof Error
                ? closeError
                : new Error(String(closeError));
        }
    }
    const finishedAtMs = Date.now();
    const finalCancellation = controller.signal.reason
        ?.releaseReliabilityCancellation ?? cancellation;
    return {
        startedAtMs,
        finishedAtMs,
        durationMs: finishedAtMs - startedAtMs,
        exitCode: error === null
            ? 0
            : Number.isInteger(error.exitCode) ? error.exitCode : null,
        signal: finalCancellation?.signal ?? error?.signal ?? null,
        timedOut,
        cancelled: cancellation !== null && !timedOut,
        cancellation: finalCancellation,
        spawnError: evidence === null && error !== null
            ? error.message
            : null,
        error,
        physicalExecution: evidence
    };
}

export async function executeRegisteredLifecycleAction({
    action,
    scenario,
    repositoryRoot = root,
    invocationId,
    runId,
    identity,
    identityReference,
    actionEnvironment,
    measurementEnvironment,
    signal = null,
    spawnProcess = spawn,
    physicalExecution = runPhysicalExecution
})
{
    const executionIdentity = {
        actionId: action.actionId,
        invocationId,
        runId,
        scenarioId: scenario.id
    };
    const expectedReceiptPath = resolveRepositoryPath(
        repositoryRoot,
        expandLifecycleTemplate(action.expectedReceiptPath, executionIdentity),
        'expected action receipt'
    );
    const logRoot = resolveRepositoryPath(
        repositoryRoot,
        `.tmp/release-reliability/${invocationId}/logs/lifecycle/${scenario.id}`,
        'action log root'
    );
    const stdoutLog = path.join(logRoot, `${action.actionId}.stdout.log`);
    const stderrLog = path.join(logRoot, `${action.actionId}.stderr.log`);
    const processReceiptFile = physicalProcessReceiptPath(
        repositoryRoot,
        executionIdentity
    );
    const {
        binding: processPolicyBinding,
        policy: physicalPolicy
    } = physicalPolicyBinding(repositoryRoot, identity);
    fs.rmSync(expectedReceiptPath, { force: true, recursive: true });
    fs.rmSync(processReceiptFile, { force: true, recursive: true });
    let outcome;
    {
        const environment = action.phase === 'measurement'
            ? measurementEnvironment
            : actionEnvironment;
        outcome = await runActionProcess({
            executable: resolveExecutable(action, scenario, identity),
            args: actionArguments(action, scenario, executionIdentity),
            cwd: resolveRepositoryPath(
                repositoryRoot,
                action.executable === '$scenario.command'
                    ? scenario.command.cwd
                    : action.cwd,
                'action cwd',
                { allowRoot: true }
            ),
            env: {
                ...environment,
                ...action.env,
                FSUSBLOG_RELEASE_RELIABILITY_ACTION_ID: action.actionId
            },
            stdoutLog,
            stderrLog,
            timeoutPolicy: action.timeoutPolicy,
            signal,
            physicalPolicy,
            residualRoot: resolveRepositoryPath(
                repositoryRoot,
                `.tmp/release-reliability/${invocationId}/process-residuals/${scenario.id}/${action.actionId}`,
                'action process residual root'
            ),
            physicalExecution,
            spawnProcess
        });
    }
    let failure = processFailure(outcome);
    const terminalStatus = outcome.timedOut
        ? 'timed-out'
        : outcome.cancelled
            ? 'cancelled'
            : failure === null
                ? 'passed'
                : 'failed';
    const terminalFence = {
        status: 'closed',
        sealedAt: new Date(outcome.finishedAtMs).toISOString(),
        lateEvidenceAccepted: false
    };
    const processReceipt = sealDocument({
        schema: 'fsusblog.release-reliability-process-tree-receipt.v1',
        status: terminalStatus,
        invocationId,
        runId,
        scenarioId: scenario.id,
        actionId: action.actionId,
        phase: action.phase,
        identity: identityReference,
        physicalPolicy: processPolicyBinding,
        command: {
            executable: resolveExecutable(action, scenario, identity),
            args: actionArguments(action, scenario, executionIdentity),
            cwd: action.executable === '$scenario.command'
                ? scenario.command.cwd
                : action.cwd,
            commandDigest: rawDigest(Buffer.from(JSON.stringify({
                executable: resolveExecutable(action, scenario, identity),
                args: actionArguments(action, scenario, executionIdentity),
                env: action.executable === '$scenario.command'
                    ? scenario.command.env
                    : action.env,
                cwd: action.executable === '$scenario.command'
                    ? scenario.command.cwd
                    : action.cwd
            })))
        },
        startedAt: new Date(outcome.startedAtMs).toISOString(),
        finishedAt: new Date(outcome.finishedAtMs).toISOString(),
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        cancellation: outcome.cancellation,
        reason: outcome.cancellation?.reason ?? null,
        duplicateRequests: outcome.cancellation?.duplicateRequests ?? 0,
        processTree: outcome.physicalExecution,
        logComplete: outcome.physicalExecution?.logComplete ?? false,
        logTruncationReason: outcome.physicalExecution?.logTruncationReason
            ?? (outcome.error ? 'physical-execution-failed-before-log-closure' : null),
        forcedPipeClose: outcome.physicalExecution?.forcedPipeClose ?? false,
        terminalFence,
        failure
    });
    writeJsonAtomic(processReceiptFile, processReceipt);
    const processTreeReceipt = {
        path: repositoryRelative(repositoryRoot, processReceiptFile),
        schema: processReceipt.schema,
        status: processReceipt.status,
        bytesDigest: rawDigest(fs.readFileSync(processReceiptFile)),
        contentDigest: processReceipt.contentDigest,
        postObservation: processReceipt.processTree?.postObservation ?? 'unverifiable',
        logComplete: processReceipt.logComplete
    };
    let receipt = null;
    if (failure === null)
    {
        try
        {
            const { verifyLifecycleActionReceipt } = await import(
                './verify-release-reliability-lifecycle-action.mjs'
            );
            receipt = verifyLifecycleActionReceipt({
                repositoryRoot,
                action,
                scenario,
                invocationId,
                runId,
                identity,
                identityReference,
                processOutcome: outcome
            });
        }
        catch (error)
        {
            failure = error instanceof Error ? error.message : String(error);
        }
    }
    if (failure !== null)
    {
        fs.rmSync(expectedReceiptPath, { force: true, recursive: true });
    }
    const recordStatus = failure === null
        ? terminalStatus
        : terminalStatus === 'passed' ? 'failed' : terminalStatus;
    return {
        actionId: action.actionId,
        phase: action.phase,
        producerSpawned: true,
        status: recordStatus,
        startedAt: new Date(outcome.startedAtMs).toISOString(),
        finishedAt: new Date(outcome.finishedAtMs).toISOString(),
        durationMs: outcome.durationMs,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        stdoutLog: repositoryRelative(repositoryRoot, stdoutLog),
        stderrLog: repositoryRelative(repositoryRoot, stderrLog),
        receipt,
        processTreeReceipt,
        terminalFence,
        finalObservation: receipt?.finalObservation ?? null,
        failure
    };
}

function failureRecord(record)
{
    const kind = record.timedOut
        ? 'timeout'
        : record.status === 'cancelled' || record.signal
            ? 'cancelled'
            : record.exitCode !== 0 && record.exitCode !== null
                ? 'failed'
                : 'verification';
    return Object.freeze({
        actionId: record.actionId,
        phase: record.phase,
        kind,
        classification: kind,
        message: record.failure
    });
}

function rawDigest(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function dataScaleOwnerEnvironment(repositoryRoot, records)
{
    const precondition = records.find((record) =>
        record.phase === 'precondition'
        && record.status === 'passed'
        && record.receipt?.path
    );
    if (!precondition)
    {
        return {};
    }
    try
    {
        const receiptPath = resolveRepositoryPath(
            repositoryRoot,
            precondition.receipt.path,
            'data-scale owner adapter receipt'
        );
        const bytes = fs.readFileSync(receiptPath);
        if (rawDigest(bytes) !== precondition.receipt.bytesDigest)
        {
            throw new Error('data-scale owner adapter receipt changed');
        }
        const adapter = JSON.parse(bytes.toString('utf8'));
        const runtime = adapter.operation?.ownerProducer?.runtimeReceipt;
        const plan = adapter.operation?.ownerProducer?.runtimePlan;
        return runtime && plan ? {
            FSUSBLOG_DATA_SCALE_RUNTIME_RECEIPT_PATH: runtime,
            FSUSBLOG_DATA_SCALE_RUNTIME_PLAN_PATH: plan
        } : {};
    }
    catch
    {
        return {};
    }
}

async function bindDataScaleMeasurementEnvironment({
    contracts,
    scenario,
    records,
    repositoryRoot,
    runId,
    invocationId,
    attemptId,
    identity,
    measurementEnvironment,
    livenessVerifier = null
})
{
    const preconditionActionId = scenario.isolation.lifecycle.preconditions.find(
        (actionId) => contracts.actions.get(actionId)?.ownerReceipt
            === 'data-scale-runtime'
    );
    if (!preconditionActionId)
    {
        return measurementEnvironment;
    }
    const precondition = records.find(
        (record) => record.actionId === preconditionActionId
    );
    if (precondition?.status !== 'passed' || !precondition.receipt)
    {
        throw new Error('data-scale runtime owner precondition is not verified');
    }
    const adapterPath = resolveRepositoryPath(
        repositoryRoot,
        precondition.receipt.path,
        'data-scale runtime adapter receipt'
    );
    const adapterBytes = fs.readFileSync(adapterPath);
    if (rawDigest(adapterBytes) !== precondition.receipt.bytesDigest)
    {
        throw new Error('data-scale runtime adapter bytes changed before measurement');
    }
    const adapter = JSON.parse(adapterBytes.toString('utf8'));
    const { verifyDataScaleOwnerReceipt } = await import(
        './verify-release-reliability-lifecycle-action.mjs'
    );
    const owner = verifyDataScaleOwnerReceipt({
        repositoryRoot,
        ownerReceipt: 'data-scale-runtime',
        receiptPath: adapter.ownerReceipt?.path,
        identity,
        runId,
        invocationId,
        attemptId,
        expectedBytesDigest: adapter.ownerReceipt?.bytesDigest
    }).document;
    const verifyLiveness = livenessVerifier ?? (await import(
        './data-scale-runtime-owner.mjs'
    )).verifyDataScaleRuntimeLiveness;
    await verifyLiveness({ repositoryRoot, runtimeReceipt: owner });
    const expectedTargets = {
        FSUSBLOG_DEBUG_BACKEND_URL: owner.backend.baseUrl,
        FSUSBLOG_POSTGRES_CONTAINER_NAME: owner.postgres.containerId,
        FSUSBLOG_REDIS_CONTAINER_NAME: owner.redis.containerId,
        FSUSBLOG_TEST_NAMESPACE: owner.namespace,
        FSUSBLOG_TEST_RUN_ID: owner.dataScaleRunId
    };
    const rootBindings = {
        FSUSBLOG_AOT_CACHE_DIR: owner.aotRoot,
        FSUSBLOG_PUBLIC_AOT_CACHE_DIR: owner.aotRoot,
        FSUSBLOG_SEARCH_DIR: owner.searchRoot,
        FSUSBLOG_SEARCH_INDEX_DIR: owner.searchRoot,
        FSUSBLOG_BACKEND_WEBROOT: owner.hotReadRoot,
        FSUSBLOG_WEB_ROOT: owner.hotReadRoot
    };
    for (const [key, expectedRelative] of Object.entries(rootBindings))
    {
        if (measurementEnvironment[key] === undefined)
        {
            continue;
        }
        const actual = path.resolve(repositoryRoot, measurementEnvironment[key]);
        const expected = path.resolve(repositoryRoot, expectedRelative);
        if (actual !== expected)
        {
            throw new Error(
                `data-scale measurement environment ${key} is not bound to the verified runtime root`
            );
        }
    }
    return {
        ...measurementEnvironment,
        ...expectedTargets,
        ...Object.fromEntries(Object.entries(rootBindings).map(([key, value]) => [
            key,
            path.resolve(repositoryRoot, value)
        ])),
        FSUSBLOG_DATA_SCALE_OUT_DIR: path.resolve(repositoryRoot, owner.dataRoot)
    };
}

function bindRuntimeMeasurementEnvironment({
    contracts,
    scenario,
    identity,
    runId,
    measurementEnvironment
})
{
    const ownsRuntime = scenario.isolation.lifecycle.preconditions.some(
        (actionId) => contracts.actions.get(actionId)?.operation === 'observe-runtime'
    );
    if (!ownsRuntime)
    {
        return measurementEnvironment;
    }
    const namespace = identity.fixture?.namespace;
    const backend = identity.fixture?.topology?.content?.runtime?.backendContainer;
    const port = backend?.portBinding;
    const expected = {
        FSUSBLOG_DEBUG_BACKEND_URL: Number.isInteger(port?.hostPort)
            ? `http://${port.hostIp}:${port.hostPort}`
            : null,
        FSUSBLOG_POSTGRES_CONTAINER_NAME:
            typeof namespace === 'string'
                ? `fsusblog-test-postgres-${namespace}`
                : null,
        FSUSBLOG_REDIS_CONTAINER_NAME:
            typeof namespace === 'string'
                ? `fsusblog-test-redis-${namespace}`
                : null,
        FSUSBLOG_TEST_NAMESPACE: namespace,
        FSUSBLOG_TEST_RUN_ID: runId
    };
    for (const [key, value] of Object.entries(expected))
    {
        if (!value || String(measurementEnvironment[key] ?? '') !== String(value))
        {
            throw new Error(
                `runtime measurement environment ${key} is not bound to the verified run identity`
            );
        }
    }
    return measurementEnvironment;
}

export async function executeLifecycleActionPlan({
    contracts,
    scenario,
    repositoryRoot = root,
    invocationId,
    runId,
    identity,
    identityReference,
    actionEnvironment,
    measurementEnvironment,
    signal = null,
    spawnProcess = spawn,
    physicalExecution = runPhysicalExecution,
    executeAction = executeRegisteredLifecycleAction,
    dataScaleLivenessVerifier = null
})
{
    const records = [];
    const cleanupFailures = [];
    let firstFailure = null;
    let measurementRecord = null;
    let allowPrimaryActions = true;
    const references = lifecycleActionIds(scenario);
    for (const reference of references)
    {
        const action = contracts.actions.get(reference.actionId);
        if (!action)
        {
            throw new Error(`lifecycle action is unavailable: ${reference.actionId}`);
        }
        const expectedReceiptPath = resolveRepositoryPath(
            repositoryRoot,
            expandLifecycleTemplate(action.expectedReceiptPath, {
                actionId: action.actionId,
                invocationId,
                runId,
                scenarioId: scenario.id
            }),
            'expected action receipt'
        );
        fs.rmSync(expectedReceiptPath, { force: true, recursive: true });
    }
    for (const reference of references)
    {
        const action = contracts.actions.get(reference.actionId);
        if (!action)
        {
            throw new Error(`lifecycle action is unavailable: ${reference.actionId}`);
        }
        const cleanupPhase = reference.phase === 'reset-after';
        if (!allowPrimaryActions && !cleanupPhase)
        {
            records.push({
                actionId: action.actionId,
                phase: action.phase,
                producerSpawned: false,
                status: 'not-run',
                startedAt: null,
                finishedAt: null,
                durationMs: 0,
                exitCode: null,
                signal: null,
                timedOut: false,
                stdoutLog: null,
                stderrLog: null,
                receipt: null,
                processTreeReceipt: null,
                terminalFence: null,
                finalObservation: null,
                failure: 'not run after an earlier lifecycle failure'
            });
            continue;
        }
        let effectiveMeasurementEnvironment = measurementEnvironment;
        let bindingFailure = null;
        if (reference.phase === 'measurement')
        {
            try
            {
                effectiveMeasurementEnvironment =
                    bindRuntimeMeasurementEnvironment({
                        contracts,
                        scenario,
                        identity,
                        runId,
                        measurementEnvironment:
                            effectiveMeasurementEnvironment
                    });
                effectiveMeasurementEnvironment =
                    await bindDataScaleMeasurementEnvironment({
                        contracts,
                        scenario,
                        records,
                        repositoryRoot,
                        runId,
                        invocationId,
                        attemptId:
                            actionEnvironment.FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID,
                        identity,
                        measurementEnvironment:
                            effectiveMeasurementEnvironment,
                        livenessVerifier: dataScaleLivenessVerifier
                    });
            }
            catch (error)
            {
                bindingFailure = error instanceof Error
                    ? error.message
                    : String(error);
            }
        }
        const bindingTime = new Date().toISOString();
        const effectiveActionEnvironment = {
            ...actionEnvironment,
            ...dataScaleOwnerEnvironment(repositoryRoot, records),
            ...(cleanupPhase && measurementRecord?.processTreeReceipt?.path
                ? {
                FSUSBLOG_RELEASE_RELIABILITY_PROCESS_TREE_RECEIPT_PATH:
                    measurementRecord.processTreeReceipt.path
                }
                : {})
        };
        const record = bindingFailure === null
            ? await executeAction({
                action,
                scenario,
                repositoryRoot,
                invocationId,
                runId,
                identity,
                identityReference,
                actionEnvironment: effectiveActionEnvironment,
                measurementEnvironment: effectiveMeasurementEnvironment,
                signal: cleanupPhase ? null : signal,
                spawnProcess,
                physicalExecution
            })
            : {
                actionId: action.actionId,
                phase: action.phase,
                producerSpawned: false,
                status: 'failed',
                startedAt: bindingTime,
                finishedAt: bindingTime,
                durationMs: 0,
                exitCode: null,
                signal: null,
                timedOut: false,
                stdoutLog: null,
                stderrLog: null,
                receipt: null,
                processTreeReceipt: null,
                terminalFence: null,
                finalObservation: null,
                failure: bindingFailure
            };
        records.push(record);
        if (reference.phase === 'measurement')
        {
            measurementRecord = record;
        }
        if (record.status !== 'passed')
        {
            const failure = failureRecord(record);
            if (cleanupPhase)
            {
                cleanupFailures.push(failure);
                firstFailure ??= failure;
            }
            else
            {
                firstFailure ??= failure;
                allowPrimaryActions = false;
            }
        }
    }
    const resetBeforeRecords = records.filter(
        (record) => record.phase === 'reset-before'
    );
    const resetAfterRecords = records.filter(
        (record) => record.phase === 'reset-after'
    );
    const resetPostObservation = resetBeforeRecords.length > 0
        && resetBeforeRecords.every((record) => record.status === 'passed')
        ? resetBeforeRecords.at(-1).finalObservation
        : { status: 'failed', postStateDigest: null };
    const finalPostObservation = resetAfterRecords.length > 0
        && resetAfterRecords.every((record) => record.status === 'passed')
        ? resetAfterRecords.at(-1).finalObservation
        : { status: 'failed', postStateDigest: null };
    return {
        status: firstFailure === null && cleanupFailures.length === 0
            ? 'passed'
            : firstFailure?.kind === 'timeout'
                ? 'timed-out'
                : firstFailure?.kind === 'cancelled'
                    ? 'cancelled'
                    : 'failed',
        actions: records,
        verifiedActionReceipts: records
            .filter((record) => record.receipt !== null)
            .map((record) => record.receipt),
        resetPostObservation,
        finalPostObservation,
        measurementRecord,
        firstFailure,
        cleanupFailures
    };
}
