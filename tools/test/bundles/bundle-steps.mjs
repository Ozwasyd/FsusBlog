import { createHash } from 'node:crypto';

const { canonicalReceiptCommandSources } = await import(new URL("../../test-matrix/receipt-command-sources.mjs", import.meta.url));

const terminalStates = new Set(['success', 'failed', 'timed-out', 'cancelled', 'blocked', 'internal-error']);
const terminalFailureStates = new Set(['failed', 'timed-out', 'internal-error']);
const finalizerPurposes = new Set(['cleanup', 'sealed-failure-summary', 'partial-evidence-inventory']);
const dataScaleEvidenceSummaryCommand =
    canonicalReceiptCommandSources['data-scale-evidence-summary'].command;

export class StepTerminalError extends Error
{
    constructor(terminalState, reasonCode, message, options = {})
    {
        super(message, options);
        this.name = 'StepTerminalError';
        this.terminalState = terminalState;
        this.reasonCode = reasonCode;
        this.primaryFailureRefs = options.primaryFailureRefs ?? [];
    }
}

export class StepDagExecutionError extends AggregateError
{
    constructor({ failures, states, terminalReceipts, interruption = null })
    {
        const primary = failures[0]?.reason ?? new Error('step DAG reached a non-success terminal state');
        super(failures.map((failure) => failure.reason), `step DAG failed in ${failures.length} terminal branches: ${primary.message}`);
        this.name = 'StepDagExecutionError';
        this.cause = primary;
        this.primaryFailure = primary;
        this.interruption = interruption;
        this.states = Object.fromEntries(states);
        this.terminalReceipts = Object.fromEntries(terminalReceipts);
    }
}

function digest(value)
{
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function step(id, command, members, options = {})
{
    return {
        ...options,
        id,
        command,
        members,
        dependsOn: options.dependsOn ?? [],
        resources: options.resources ?? { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
    };
}

function finitePositive(value, fallback, name)
{
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0)
    {
        return parsed;
    }
    if (fallback !== undefined)
    {
        return fallback;
    }
    throw new Error(`${name} must be a finite positive number`);
}

function normalizeCountedResources(value, name)
{
    if (value === undefined)
    {
        return {};
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error(`${name} must be an object`);
    }
    return Object.fromEntries(Object.entries(value).map(([resource, amount]) =>
    {
        if (!resource || !Number.isInteger(Number(amount)) || Number(amount) <= 0)
        {
            throw new Error(`${name}.${resource || '<empty>'} must be a positive integer`);
        }
        return [resource, Number(amount)];
    }).sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Resolve the resources granted to this bundle invocation. Matrix weights are
 * fallback shares for direct/local invocation; a scheduler grant is already an
 * actual allocation and must not be capped by the reference weight.
 */
export function resolveBundleRuntimeCapacity(options)
{
    const availableCpu = finitePositive(options.availableCpu, undefined, 'availableCpu');
    const availableMemoryGiB = finitePositive(options.availableMemoryGiB, undefined, 'availableMemoryGiB');
    const inheritedCpu = Number(options.inheritedCpuBudget);
    const inheritedMemory = Number(options.inheritedMemoryGiB);
    const hasInheritedCpu = Number.isFinite(inheritedCpu) && inheritedCpu > 0;
    const hasInheritedMemory = Number.isFinite(inheritedMemory) && inheritedMemory > 0;
    const cpuUnits = Math.min(availableCpu, hasInheritedCpu ? inheritedCpu : availableCpu);
    const memoryGiB = Math.min(
        availableMemoryGiB,
    hasInheritedMemory ? inheritedMemory : availableMemoryGiB
    );

    return {
        maxParallel: Math.max(1, Math.floor(cpuUnits)),
        cpuUnits,
        memoryGiB
    };
}

function normalizeStepResources(entry)
{
    const resources = entry?.resources ?? {};
    for (const forbidden of ['cpuUnits', 'memoryGiB'])
    {
        if (Object.hasOwn(resources, forbidden))
        {
            throw new Error(`${forbidden} for step "${entry?.id ?? 'unknown'}" is machine-specific; declare weights instead`);
        }
    }
    if (resources.coordinationOnly === true)
    {
        for (const [name, normalizedValue] of [
            ['cpuWeight', 0],
            ['memoryWeight', 0],
            ['minCpuUnits', 0],
            ['minMemoryGiB', 0]
        ])
        {
            if (Object.hasOwn(resources, name) && resources[name] !== normalizedValue)
            {
                throw new Error(`${name} cannot reserve resources for coordination-only step "${entry?.id ?? 'unknown'}"`);
            }
        }
        if (Object.hasOwn(resources, 'exclusiveResources'))
        {
            throw new Error(`exclusiveResources cannot be declared for coordination-only step "${entry?.id ?? 'unknown'}"`);
        }
        if (Object.hasOwn(resources, 'countedResources'))
        {
            throw new Error(`countedResources cannot be declared for coordination-only step "${entry?.id ?? 'unknown'}"`);
        }
        return {
            ...resources,
            coordinationOnly: true,
            cpuWeight: 0,
            memoryWeight: 0,
            minCpuUnits: 0,
            minMemoryGiB: 0
        };
    }
    const cpuWeight = finitePositive(resources.cpuWeight, 1, `cpuWeight for step "${entry?.id ?? 'unknown'}"`);
    const memoryWeight = finitePositive(resources.memoryWeight, 1, `memoryWeight for step "${entry?.id ?? 'unknown'}"`);
    const minCpuUnits = finitePositive(resources.minCpuUnits, 1, `minCpuUnits for step "${entry?.id ?? 'unknown'}"`);
    const minMemoryGiB = resources.minMemoryGiB == null
        ? null
        : finitePositive(resources.minMemoryGiB, undefined, `minMemoryGiB for step "${entry?.id ?? 'unknown'}"`);
    if (!Number.isInteger(minCpuUnits))
    {
        throw new Error(`minCpuUnits for step "${entry?.id ?? 'unknown'}" must be an integer`);
    }
    return {
        ...resources,
        cpuWeight,
        memoryWeight,
        minCpuUnits,
        minMemoryGiB,
        exclusiveCapacity: resources.exclusiveCapacity === true,
        countedResources: normalizeCountedResources(resources.countedResources, `countedResources for step "${entry?.id ?? 'unknown'}"`)
    };
}

function weightedIntegerAllocation(entries, totalUnits)
{
    if (entries.length === 0)
    {
        return [];
    }
    const minima = entries.map((entry) => entry.resources.minCpuUnits);
    const minimumTotal = minima.reduce((total, value) => total + value, 0);
    if (minimumTotal > totalUnits)
    {
        throw new Error(`step wave minimum CPU ${minimumTotal} exceeds bundle grant ${totalUnits}`);
    }
    const remaining = totalUnits - minimumTotal;
    const weightTotal = entries.reduce((total, entry) => total + entry.resources.cpuWeight, 0);
    const exact = entries.map((entry) => remaining * entry.resources.cpuWeight / weightTotal);
    const allocation = exact.map((value, index) => minima[index] + Math.floor(value));
    let leftover = totalUnits - allocation.reduce((total, value) => total + value, 0);
    const order = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
        .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
    for (let index = 0; index < leftover; index += 1)
    {
        allocation[order[index].index] += 1;
    }
    return allocation;
}

export function resolveConcurrentStepCapacities(steps, capacity)
{
    const normalized = steps.map((entry) => ({ ...entry, resources: normalizeStepResources(entry) }));
    const executable = normalized
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => !entry.resources.coordinationOnly);
    if (executable.length === 0)
    {
        return normalized.map(() => ({ maxParallel: 0, cpuUnits: 0, memoryGiB: 0 }));
    }
    const cpuUnits = Math.max(1, Math.floor(finitePositive(capacity?.cpuUnits, undefined, 'capacity.cpuUnits')));
    const memoryGiB = finitePositive(capacity?.memoryGiB, undefined, 'capacity.memoryGiB');
    const cpuAllocations = weightedIntegerAllocation(executable.map(({ entry }) => entry), cpuUnits);
    const fixedMemoryTotal = executable.reduce(
        (total, { entry }) => total + (entry.resources.minMemoryGiB ?? 0),
        0
    );
    if (fixedMemoryTotal > memoryGiB + Number.EPSILON)
    {
        throw new Error(`step wave minimum memory ${fixedMemoryTotal} exceeds bundle grant ${memoryGiB}`);
    }
    const elasticMemoryEntries = executable.filter(({ entry }) => entry.resources.minMemoryGiB === null);
    const memoryWeightTotal = elasticMemoryEntries.reduce((total, { entry }) => total + entry.resources.memoryWeight, 0);
    const remainingMemoryGiB = Math.max(0, memoryGiB - fixedMemoryTotal);
    const allocationByIndex = new Map(executable.map(({ entry, index }, allocationIndex) =>
    {
        const stepMemoryGiB = entry.resources.minMemoryGiB
      ?? remainingMemoryGiB * entry.resources.memoryWeight / memoryWeightTotal;
        return [index, {
            maxParallel: cpuAllocations[allocationIndex],
            cpuUnits: cpuAllocations[allocationIndex],
            memoryGiB: Number(stepMemoryGiB.toFixed(6))
        }];
    }));
    return normalized.map((entry, index) =>
    {
        if (entry.resources.coordinationOnly)
        {
            return { maxParallel: 0, cpuUnits: 0, memoryGiB: 0 };
        }
        return {
            ...allocationByIndex.get(index)
        };
    });
}

export function resolveStepRuntimeCapacity(_bundleId, step, capacity)
{
    if (step?.runtimeCapacity)
    {
        return step.runtimeCapacity;
    }
    return resolveConcurrentStepCapacities([step], capacity)[0];
}

export function buildSettledPhaseJoinEvidence({
    stepId,
    dependencyIds,
    dependencyOutcomes,
    dependencyResults,
    evidenceRef = `phase-join/${stepId}`,
    generatedAt = new Date().toISOString()
})
{
    if (typeof stepId !== 'string' || !stepId)
    {
        throw new Error('phase join stepId must be non-empty');
    }
    if (!Array.isArray(dependencyIds) || dependencyIds.length === 0)
    {
        throw new Error('phase join dependencies must be non-empty');
    }
    const results = dependencyResults instanceof Map
        ? dependencyResults
        : new Map(Object.entries(dependencyResults ?? {}));
    const dependencies = dependencyIds.map((dependencyId) =>
    {
        const result = results.get(dependencyId) ?? null;
        return {
            id: dependencyId,
            outcome: dependencyOutcomes?.[dependencyId] ?? 'unknown',
            receiptPresent: result !== null,
            receiptTerminalState: result?.terminalState ?? result?.status ?? null,
            durationMs: result?.durationMs ?? null,
            logFile: result?.logFile ?? null
        };
    });
    const hasIncompleteDependency = dependencies.some((dependency) =>
        !terminalStates.has(dependency.outcome)
        || dependency.outcome === 'blocked'
        || dependency.receiptPresent !== true
        || dependency.receiptTerminalState !== dependency.outcome);
    const primaryFailureRefs = dependencies
        .filter((dependency) => terminalFailureStates.has(dependency.outcome))
        .map((dependency) => dependency.id);
    const terminalState = hasIncompleteDependency
        ? 'failed'
        : primaryFailureRefs.length > 0
            ? 'failed'
            : dependencies.some((dependency) => dependency.outcome === 'cancelled')
                ? 'cancelled'
                : 'success';
    const reasonCode = hasIncompleteDependency
        ? 'dependency-outcome-incomplete'
        : terminalState === 'failed'
            ? 'dependency-terminal-failure'
            : terminalState === 'cancelled'
                ? 'dependency-cancelled'
                : 'all-dependencies-succeeded';
    const completedResults = dependencyIds.map((dependencyId) => results.get(dependencyId)).filter(Boolean);
    const startedAtMs = completedResults.length > 0
        ? Math.min(...completedResults.map((result) => result.startedAtMs))
        : 0;
    const finishedAtMs = completedResults.length > 0
        ? Math.max(...completedResults.map((result) => result.finishedAtMs))
        : startedAtMs;
    const evidence = {
        schema: 'fsusblog.local-production.phase-join.v1',
        status: terminalState,
        terminalState,
        reasonCode,
        primaryFailureRefs,
        stepId,
        evidenceRef,
        canonicalDependencyOrder: [...dependencyIds],
        dependencies,
        generatedAt
    };
    evidence.dependencyOutcomeDigest = digest(dependencies.map((dependency) => ({
        id: dependency.id,
        outcome: dependency.outcome,
        receiptPresent: dependency.receiptPresent,
        receiptTerminalState: dependency.receiptTerminalState
    })));
    evidence.contentDigest = digest({
        status: evidence.status,
        terminalState: evidence.terminalState,
        reasonCode: evidence.reasonCode,
        primaryFailureRefs: evidence.primaryFailureRefs,
        stepId: evidence.stepId,
        evidenceRef: evidence.evidenceRef,
        canonicalDependencyOrder: evidence.canonicalDependencyOrder,
        dependencies: evidence.dependencies,
        dependencyOutcomeDigest: evidence.dependencyOutcomeDigest
    });
    return {
        evidence,
        startedAtMs,
        finishedAtMs,
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
        dependencyLogs: completedResults.map((result) => result.logFile).filter(Boolean)
    };
}

export function validateSettledPhaseJoinConsistency({
    schedulerState,
    evidence,
    dependencyReceipts = {},
    canonicalDependencyOutcomes,
    stepId
})
{
    if (!terminalStates.has(schedulerState))
    {
        throw new Error(`join scheduler state is not terminal: ${schedulerState}`);
    }
    if (!evidence || typeof evidence !== 'object')
    {
        throw new Error('join evidence is required');
    }
    if (evidence.schema !== 'fsusblog.local-production.phase-join.v1'
        || (stepId && evidence.stepId !== stepId))
    {
        throw new Error('join evidence schema or step identity mismatch');
    }
    if (evidence.status !== schedulerState || evidence.terminalState !== schedulerState)
    {
        throw new Error(`join scheduler/evidence terminal state mismatch: scheduler=${schedulerState} evidence=${evidence.status}`);
    }
    if (typeof evidence.reasonCode !== 'string' || !Array.isArray(evidence.primaryFailureRefs)
        || typeof evidence.evidenceRef !== 'string' || !evidence.evidenceRef
        || !Array.isArray(evidence.dependencies) || !evidence.contentDigest || !evidence.dependencyOutcomeDigest)
    {
        throw new Error('join evidence is missing terminal audit fields');
    }
    const expectedOrder = evidence.dependencies.map((dependency) => dependency.id);
    if (!Array.isArray(evidence.canonicalDependencyOrder)
        || evidence.canonicalDependencyOrder.join('\0') !== expectedOrder.join('\0')
        || new Set(expectedOrder).size !== expectedOrder.length)
    {
        throw new Error('join evidence dependencies must preserve declared canonical order');
    }
    if (canonicalDependencyOutcomes)
    {
        const canonicalOrder = Object.keys(canonicalDependencyOutcomes);
        if (canonicalOrder.join('\0') !== expectedOrder.join('\0'))
        {
            throw new Error('join evidence dependency order does not match scheduler order');
        }
        for (const dependency of evidence.dependencies)
        {
            if (canonicalDependencyOutcomes[dependency.id] !== dependency.outcome)
            {
                throw new Error(`join evidence outcome does not match scheduler state: ${dependency.id}`);
            }
        }
        const receiptIds = dependencyReceipts instanceof Map
            ? [...dependencyReceipts.keys()]
            : Object.keys(dependencyReceipts);
        if (receiptIds.join('\0') !== canonicalOrder.join('\0'))
        {
            throw new Error('join dependency receipt set does not match scheduler dependencies');
        }
    }
    const expectedDependencyDigest = digest(evidence.dependencies.map((dependency) => ({
        id: dependency.id,
        outcome: dependency.outcome,
        receiptPresent: dependency.receiptPresent,
        receiptTerminalState: dependency.receiptTerminalState
    })));
    if (evidence.dependencyOutcomeDigest !== expectedDependencyDigest)
    {
        throw new Error('join evidence dependency outcome digest mismatch');
    }
    const expectedContentDigest = digest({
        status: evidence.status,
        terminalState: evidence.terminalState,
        reasonCode: evidence.reasonCode,
        primaryFailureRefs: evidence.primaryFailureRefs,
        stepId: evidence.stepId,
        evidenceRef: evidence.evidenceRef,
        canonicalDependencyOrder: evidence.canonicalDependencyOrder,
        dependencies: evidence.dependencies,
        dependencyOutcomeDigest: evidence.dependencyOutcomeDigest
    });
    if (evidence.contentDigest !== expectedContentDigest)
    {
        throw new Error('join evidence content digest mismatch');
    }
    for (const dependency of evidence.dependencies)
    {
        const receipt = dependencyReceipts instanceof Map
            ? dependencyReceipts.get(dependency.id)
            : dependencyReceipts[dependency.id];
        if (receipt && receipt.terminalState !== dependency.outcome)
        {
            throw new Error(`join dependency receipt mismatch: ${dependency.id}`);
        }
        if (!receipt || receipt.schema !== 'fsusblog.scheduler.terminal-receipt.v1'
            || receipt.terminalState !== dependency.outcome)
        {
            throw new Error(`join dependency terminal receipt is missing or invalid: ${dependency.id}`);
        }
        if (dependency.receiptPresent !== true || dependency.receiptTerminalState !== dependency.outcome)
        {
            if (evidence.reasonCode !== 'dependency-outcome-incomplete' || schedulerState !== 'failed')
            {
                throw new Error(`join dependency outcome is incomplete: ${dependency.id}`);
            }
        }
    }
    if (schedulerState === 'success' && evidence.dependencies.some((dependency) =>
        dependency.outcome !== 'success' || dependency.receiptPresent !== true || dependency.receiptTerminalState !== 'success'))
    {
        throw new Error('successful join evidence contains a dependency terminal failure or missing receipt');
    }
    const incomplete = evidence.dependencies.some((dependency) => dependency.outcome === 'blocked'
        || !terminalStates.has(dependency.outcome) || dependency.receiptPresent !== true
        || dependency.receiptTerminalState !== dependency.outcome);
    const failures = evidence.dependencies.filter((dependency) => terminalFailureStates.has(dependency.outcome));
    const expectedState = incomplete ? 'failed'
        : failures.length > 0 ? 'failed'
            : evidence.dependencies.some((dependency) => dependency.outcome === 'cancelled') ? 'cancelled'
                : 'success';
    const expectedReason = incomplete ? 'dependency-outcome-incomplete'
        : failures.length > 0 ? 'dependency-terminal-failure'
            : expectedState === 'cancelled' ? 'dependency-cancelled'
                : 'all-dependencies-succeeded';
    const expectedPrimaryRefs = failures.map((dependency) => dependency.id);
    if (schedulerState !== expectedState || evidence.reasonCode !== expectedReason
        || evidence.primaryFailureRefs.join('\0') !== expectedPrimaryRefs.join('\0'))
    {
        throw new Error('join evidence terminal mapping or primary failure refs mismatch');
    }
    return true;
}

function normalizeTerminalOutcome(entry, result, terminalReceipts)
{
    const outcome = result?.terminalState
        ? result
        : { terminalState: 'success', reasonCode: 'execute-resolved' };
    if (!terminalStates.has(outcome.terminalState))
    {
        throw new Error(`step "${entry.id}" returned invalid terminal state: ${outcome.terminalState}`);
    }
    if (entry.runAfterSettled === true)
    {
        if (!outcome.evidence)
        {
            throw new Error(`runAfterSettled step "${entry.id}" must return evidence`);
        }
        validateSettledPhaseJoinConsistency({
            schedulerState: outcome.terminalState,
            evidence: outcome.evidence,
            dependencyReceipts: new Map(Object.keys(entry.dependencyOutcomes ?? {}).map((dependency) =>
                [dependency, terminalReceipts.get(dependency)])),
            canonicalDependencyOutcomes: entry.dependencyOutcomes,
            stepId: entry.id
        });
    }
    return {
        ...outcome,
        evidenceRef: outcome.evidenceRef ?? outcome.evidence?.evidenceRef,
        contentDigest: outcome.contentDigest ?? outcome.evidence?.contentDigest,
        dependencyOutcomeDigest: outcome.dependencyOutcomeDigest ?? outcome.evidence?.dependencyOutcomeDigest,
        reasonCode: outcome.reasonCode ?? outcome.evidence?.reasonCode,
        dependencyOutcomes: outcome.dependencyOutcomes ?? outcome.evidence?.dependencies,
        primaryFailureRefs: outcome.primaryFailureRefs ?? outcome.evidence?.primaryFailureRefs
    };
}

function terminalOutcomeFromReason(entry, reason)
{
    if (reason instanceof StepTerminalError)
    {
        return {
            terminalState: reason.terminalState,
            reasonCode: reason.reasonCode,
            primaryFailureRefs: reason.primaryFailureRefs,
            reason
        };
    }
    if (entry.runAfterSettled === true)
    {
        return {
            terminalState: 'internal-error',
            reason,
            reasonCode: 'join-evidence-processing-failed',
            primaryFailureRefs: [entry.id]
        };
    }
    return { terminalState: 'failed', reason, reasonCode: 'execute-rejected' };
}

/**
 * Scale an execution-related reference deadline by the actual scheduler grant.
 * This is intentionally not used for HTTP/protocol assertion timeouts, whose
 * semantics must remain stable regardless of machine size.
 */
export function resolveMachineExecutionTimeoutMs({
    baseTimeoutMs,
    workload,
    actualCapacity
})
{
    const timeoutMs = finitePositive(baseTimeoutMs, undefined, 'baseTimeoutMs');
    const cpuWeight = finitePositive(workload?.cpuWeight, 1, 'workload.cpuWeight');
    const memoryWeight = finitePositive(workload?.memoryWeight, 1, 'workload.memoryWeight');
    const minCpuUnits = finitePositive(workload?.minCpuUnits, 1, 'workload.minCpuUnits');
    const actualCpu = finitePositive(actualCapacity?.cpuUnits, undefined, 'actualCapacity.cpuUnits');
    const actualMemory = finitePositive(actualCapacity?.memoryGiB, undefined, 'actualCapacity.memoryGiB');
    const resourceScale = Math.max(1, cpuWeight / actualCpu, memoryWeight / actualMemory, minCpuUnits / actualCpu);
    return Math.max(1, Math.ceil(timeoutMs * resourceScale));
}

export function resolveBundleSteps(_bundleId, steps, capacity)
{
    finitePositive(capacity?.cpuUnits, undefined, 'capacity.cpuUnits');
    finitePositive(capacity?.memoryGiB, undefined, 'capacity.memoryGiB');
    return steps.map((entry) => ({ ...entry, resources: normalizeStepResources(entry) }));
}

function validateWeightedSteps(steps, capacity, allowedExclusiveResources, allowedCountedResources, { elastic = false } = {})
{
    const normalized = resolveBundleSteps('dynamic', steps, capacity);
    const ids = new Set();
    const allowed = allowedExclusiveResources === undefined
        ? null
        : new Set(allowedExclusiveResources);
    const countedCapacity = normalizeCountedResources(allowedCountedResources, 'capacity.countedResources');
    for (const entry of normalized)
    {
        if (typeof entry.id !== 'string' || !entry.id)
        {
            throw new Error('step id must be non-empty');
        }
        if (ids.has(entry.id))
        {
            throw new Error(`duplicate step id: ${entry.id}`);
        }
        ids.add(entry.id);
        if (!elastic && entry.resources.minCpuUnits > Math.floor(capacity.cpuUnits))
        {
            throw new Error(`minCpuUnits for step "${entry.id}" exceeds bundle CPU grant`);
        }
        if (!elastic && entry.resources.minMemoryGiB !== null
      && entry.resources.minMemoryGiB > capacity.memoryGiB)
        {
            throw new Error(`minMemoryGiB for step "${entry.id}" exceeds bundle memory grant`);
        }
        for (const resource of entry.resources.exclusiveResources ?? [])
        {
            if (!resource || (allowed && !allowed.has(resource)))
            {
                throw new Error(`step "${entry.id}" requests unknown exclusive resource "${resource}"`);
            }
        }
        for (const [resource, amount] of Object.entries(entry.resources.countedResources ?? {}))
        {
            if (!Object.hasOwn(countedCapacity, resource))
            {
                throw new Error(`step "${entry.id}" requests unknown counted resource "${resource}"`);
            }
            if (!elastic && amount > countedCapacity[resource])
            {
                throw new Error(`step "${entry.id}" requests ${amount} ${resource}, capacity is ${countedCapacity[resource]}`);
            }
        }
    }
    for (const entry of normalized)
    {
        if (entry.runAfterSettled === true && entry.resources.coordinationOnly !== true)
        {
            throw new Error(`runAfterSettled step "${entry.id}" must be coordination-only`);
        }
        if (entry.alwaysRunFinalizer === true && entry.resources.coordinationOnly !== true)
        {
            throw new Error(`alwaysRunFinalizer step "${entry.id}" must be coordination-only`);
        }
        if (entry.alwaysRunFinalizer === true && (!finalizerPurposes.has(entry.finalizerPurpose)
            || entry.runAfterSettled === true || (entry.members?.length ?? 0) > 0
            || (entry.testIds?.length ?? 0) > 0 || (entry.artifacts?.length ?? 0) > 0))
        {
            throw new Error(`alwaysRunFinalizer step "${entry.id}" has an invalid finalizer declaration`);
        }
        for (const dependency of [...(entry.dependsOn ?? []), ...(entry.settledDependsOn ?? [])])
        {
            if (!ids.has(dependency))
            {
                throw new Error(`${entry.id} depends on unknown dependency: ${dependency}`);
            }
        }
    }
    for (const entry of normalized.filter((candidate) => candidate.alwaysRunFinalizer === true))
    {
        if (normalized.some((candidate) => (candidate.dependsOn ?? []).includes(entry.id)
            || (candidate.settledDependsOn ?? []).includes(entry.id)))
        {
            throw new Error(`alwaysRunFinalizer step "${entry.id}" cannot unlock a downstream step`);
        }
    }
    return normalized;
}

function selectWeightedAdmission(ready, capacity, active, freeCpuUnits, freeMemoryGiB)
{
    const activeExecutableCount = [...active.values()]
        .filter((record) => record.coordinationOnly !== true).length;
    const resourceOwners = new Map();
    const countedUsage = new Map();
    for (const [stepId, record] of active)
    {
        for (const resource of record.exclusiveResources ?? [])
        {
            if (!resourceOwners.has(resource))
            {
                resourceOwners.set(resource, { stepId, holderState: 'active' });
            }
        }
        for (const [resource, amount] of Object.entries(record.countedResources ?? {}))
        {
            countedUsage.set(resource, (countedUsage.get(resource) ?? 0) + amount);
        }
    }
    const selected = [];
    const blockedByExclusiveResources = [];
    const blockedByCountedResources = [];
    const blockedByStateConflicts = [];
    let selectedExecutableCount = 0;
    let minimumCpu = 0;
    let minimumMemoryGiB = 0;
    const activeExclusiveCapacity = [...active.values()].some((record) => record.exclusiveCapacity);
    let selectedExclusiveCapacity = false;
    for (const entry of ready)
    {
        if (entry.resources.coordinationOnly === true)
        {
            selected.push(entry);
            continue;
        }
        if (activeExclusiveCapacity || selectedExclusiveCapacity)
        {
            continue;
        }
        if (entry.resources.exclusiveCapacity === true
      && (activeExecutableCount > 0 || selectedExecutableCount > 0))
        {
            continue;
        }
        const entryMinimumMemoryGiB = entry.resources.minMemoryGiB ?? 0;
        if (freeMemoryGiB <= 0 || minimumMemoryGiB + entryMinimumMemoryGiB > freeMemoryGiB)
        {
            continue;
        }
        if (selectedExecutableCount >= capacity.maxParallel - activeExecutableCount)
        {
            continue;
        }
        if (minimumCpu + entry.resources.minCpuUnits > Math.floor(freeCpuUnits))
        {
            continue;
        }
        const resources = [...new Set(entry.resources.exclusiveResources ?? [])];
        const conflictingResource = resources.find((resource) => resourceOwners.has(resource));
        if (conflictingResource)
        {
            const owner = resourceOwners.get(conflictingResource);
            blockedByExclusiveResources.push({
                stepId: entry.id,
                resource: conflictingResource,
                heldBy: owner.stepId,
                holderState: owner.holderState
            });
            continue;
        }
        const countedResources = entry.resources.countedResources ?? {};
        const countedConflict = Object.entries(countedResources).find(([resource, amount]) =>
            (countedUsage.get(resource) ?? 0) + amount > Number(capacity.countedResources?.[resource] ?? 0));
        if (countedConflict)
        {
            const [resource, amount] = countedConflict;
            blockedByCountedResources.push({
                stepId: entry.id,
                resource,
                requested: amount,
                used: countedUsage.get(resource) ?? 0,
                capacity: Number(capacity.countedResources?.[resource] ?? 0)
            });
            continue;
        }
        if (capacity.stateConflictPolicy)
        {
            const candidates = [
                ...[...active.keys()].map((stepId) => ({ stepId, holderState: 'active' })),
                ...selected.map((candidate) => ({ stepId: candidate.id, holderState: 'admission-wave' }))
            ];
            const blocker = candidates.map((candidate) => ({
                ...candidate,
                evaluation: capacity.stateConflictPolicy.evaluate(entry.id, candidate.stepId)
            })).find((candidate) => candidate.evaluation.conflict === true);
            if (blocker)
            {
                blockedByStateConflicts.push({
                    stepId: entry.id,
                    heldBy: blocker.stepId,
                    holderState: blocker.holderState,
                    catalogDigest: capacity.stateConflictPolicy.catalogDigest,
                    conflicts: blocker.evaluation.conflicts
                });
                continue;
            }
        }
        selected.push(entry);
        selectedExecutableCount += 1;
        minimumCpu += entry.resources.minCpuUnits;
        minimumMemoryGiB += entryMinimumMemoryGiB;
        selectedExclusiveCapacity = entry.resources.exclusiveCapacity === true;
        for (const resource of resources)
        {
            resourceOwners.set(resource, { stepId: entry.id, holderState: 'admission-wave' });
        }
        for (const [resource, amount] of Object.entries(countedResources))
        {
            countedUsage.set(resource, (countedUsage.get(resource) ?? 0) + amount);
        }
    }
    return { selected, blockedByExclusiveResources, blockedByCountedResources, blockedByStateConflicts };
}

/**
 * Execute dependency-ready steps with rolling resource admission. A completion
 * immediately releases its exact grant and can admit newly-ready work without
 * waiting for unrelated long-running siblings. Every admitted group divides
 * only the currently-free CPU/memory grant, so nested work never exceeds the
 * live bundle grant. No declaration encodes a reference machine.
 */
export async function executeWeightedStepDag(steps, capacity, execute)
{
    if (typeof execute !== 'function')
    {
        throw new Error('execute must be a function');
    }
    const elastic = typeof capacity === 'function';
    const capacityProvider = elastic ? capacity : () => capacity;
    const normalizeCapacity = () =>
    {
        const current = capacityProvider();
        return {
            maxParallel: Math.max(1, Math.min(
                Math.floor(finitePositive(current?.maxParallel, undefined, 'capacity.maxParallel')),
                Math.floor(finitePositive(current?.cpuUnits, undefined, 'capacity.cpuUnits'))
            )),
            cpuUnits: finitePositive(current?.cpuUnits, undefined, 'capacity.cpuUnits'),
            memoryGiB: finitePositive(current?.memoryGiB, undefined, 'capacity.memoryGiB'),
            exclusiveResources: current?.exclusiveResources,
            countedResources: normalizeCountedResources(current?.countedResources, 'capacity.countedResources'),
            stateConflictPolicy: current?.stateConflictPolicy ?? null,
            onWaitState: current?.onWaitState,
            signal: current?.signal
        };
    };
    let normalizedCapacity = normalizeCapacity();
    const normalized = validateWeightedSteps(
        steps,
        normalizedCapacity,
        normalizedCapacity.exclusiveResources,
        normalizedCapacity.countedResources,
        { elastic }
    );
    const states = new Map(normalized.map((entry) => [entry.id, 'pending']));
    const failures = [];
    const terminalReceipts = new Map();
    const active = new Map();
    const reportedExclusiveWaits = new Set();
    const reportedCountedWaits = new Set();
    const reportedStateWaits = new Set();
    let interruption = null;
    let usedCpuUnits = 0;
    let usedMemoryGiB = 0;

    const start = (entry, runtimeCapacity) =>
    {
        const index = normalized.findIndex((candidate) => candidate.id === entry.id);
        const exclusiveResources = [...new Set(entry.resources.exclusiveResources ?? [])];
        const countedResources = entry.resources.countedResources ?? {};
        usedCpuUnits += runtimeCapacity.cpuUnits;
        usedMemoryGiB += runtimeCapacity.memoryGiB;
        states.set(entry.id, 'running');
        normalizedCapacity.onWaitState?.(entry.id, null);

        const promise = Promise.resolve()
            .then(() => execute({ ...entry, runtimeCapacity }))
            .then(
                (result) =>
                {
                    try
                    {
                        return normalizeTerminalOutcome(entry, result, terminalReceipts);
                    }
                    catch (reason)
                    {
                        return {
                            terminalState: 'internal-error',
                            reasonCode: 'terminal-outcome-validation-failed',
                            primaryFailureRefs: [entry.id],
                            reason
                        };
                    }
                },
                (reason) => terminalOutcomeFromReason(entry, reason)
            )
            .then((outcome) =>
            {
                usedCpuUnits = Math.max(0, usedCpuUnits - runtimeCapacity.cpuUnits);
                usedMemoryGiB = Math.max(0, usedMemoryGiB - runtimeCapacity.memoryGiB);
                active.delete(entry.id);
                states.set(entry.id, outcome.terminalState);
                terminalReceipts.set(entry.id, {
                    schema: 'fsusblog.scheduler.terminal-receipt.v1',
                    stepId: entry.id,
                    stepKind: entry.runAfterSettled === true ? 'settled-join'
                        : entry.alwaysRunFinalizer === true ? 'finalizer' : 'physical',
                    terminalState: outcome.terminalState,
                    reasonCode: outcome.reasonCode ?? null,
                    primaryFailureRefs: outcome.primaryFailureRefs ?? (terminalFailureStates.has(outcome.terminalState) ? [entry.id] : []),
                    evidenceRef: outcome.evidenceRef ?? null,
                    contentDigest: outcome.contentDigest ?? outcome.evidence?.contentDigest ?? null,
                    dependencyOutcomeDigest: outcome.dependencyOutcomeDigest ?? outcome.evidence?.dependencyOutcomeDigest ?? digest(
                        outcome.dependencyOutcomes ?? outcome.evidence?.dependencies ?? []),
                    dependencyOutcomes: outcome.dependencyOutcomes ?? outcome.evidence?.dependencies ?? []
                });
                if (outcome.terminalState !== 'success' && outcome.terminalState !== 'blocked'
                    && (entry.runAfterSettled !== true || outcome.reason))
                {
                    const reason = outcome.reason ?? new StepTerminalError(
                        outcome.terminalState, outcome.reasonCode ?? 'step-not-success',
                        `step DAG failed: ${entry.id}`,
                        { primaryFailureRefs: outcome.primaryFailureRefs ?? [entry.id] }
                    );
                    failures.push({ index, entry, reason });
                }
            });

        active.set(entry.id, {
            promise,
            exclusiveResources,
            countedResources,
            coordinationOnly: entry.resources.coordinationOnly === true,
            exclusiveCapacity: entry.resources.exclusiveCapacity === true,
            runtimeCapacity
        });
    };

    while ([...states.values()].some((state) => ['pending', 'running'].includes(state)))
    {
        normalizedCapacity = normalizeCapacity();
        normalizedCapacity.stateConflictPolicy?.assertCurrent?.();
        if (normalizedCapacity.signal?.aborted && interruption === null)
        {
            interruption = normalizedCapacity.signal.reason ?? new StepTerminalError(
                'cancelled', 'global-interrupt', 'step DAG cancelled');
            // Active owners settle their own processes. Never bypass finalizers.
            await Promise.allSettled([...active.values()].map((record) => record.promise));
            for (const entry of normalized)
            {
                if (states.get(entry.id) !== 'pending'
                    || entry.runAfterSettled === true || entry.alwaysRunFinalizer === true)
                {
                    continue;
                }
                states.set(entry.id, 'cancelled');
                terminalReceipts.set(entry.id, {
                    schema: 'fsusblog.scheduler.terminal-receipt.v1',
                    stepId: entry.id,
                    stepKind: 'physical',
                    terminalState: 'cancelled',
                    reasonCode: 'global-interrupt-before-admission',
                    primaryFailureRefs: [entry.id],
                    evidenceRef: null,
                    contentDigest: null,
                    dependencyOutcomeDigest: digest([]),
                    dependencyOutcomes: []
                });
            }
        }
        let propagatedBlock;
        do
        {
            propagatedBlock = false;
            for (const entry of normalized)
            {
                if (states.get(entry.id) !== 'pending')
                {
                    continue;
                }
                if (entry.runAfterSettled !== true && entry.alwaysRunFinalizer !== true
          && (entry.dependsOn ?? []).some((dependency) =>
              terminalStates.has(states.get(dependency)) && states.get(dependency) !== 'success'))
                {
                    states.set(entry.id, 'blocked');
                    const dependencies = [...(entry.dependsOn ?? []), ...(entry.settledDependsOn ?? [])];
                    const dependencyOutcomes = Object.fromEntries(dependencies.map((dependency) =>
                        [dependency, states.get(dependency)]));
                    terminalReceipts.set(entry.id, {
                        schema: 'fsusblog.scheduler.terminal-receipt.v1',
                        stepId: entry.id,
                        stepKind: 'physical',
                        terminalState: 'blocked',
                        reasonCode: 'dependency-not-success',
                        primaryFailureRefs: dependencies.filter((dependency) => states.get(dependency) !== 'success'),
                        evidenceRef: null,
                        contentDigest: null,
                        dependencyOutcomeDigest: digest(dependencyOutcomes),
                        dependencyOutcomes
                    });
                    propagatedBlock = true;
                }
            }
        } while (propagatedBlock);
        const ready = normalized.filter((entry) => states.get(entry.id) === 'pending'
      && (entry.dependsOn ?? []).every((dependency) => entry.runAfterSettled === true || entry.alwaysRunFinalizer === true
          ? terminalStates.has(states.get(dependency))
          : states.get(dependency) === 'success')
      && (entry.settledDependsOn ?? []).every((dependency) =>
          terminalStates.has(states.get(dependency))));
        const freeCpuUnits = Math.max(0, Math.floor(normalizedCapacity.cpuUnits) - usedCpuUnits);
        const freeMemoryGiB = Math.max(0, normalizedCapacity.memoryGiB - usedMemoryGiB);
        const admissionResult = selectWeightedAdmission(
            ready,
            normalizedCapacity,
            active,
            freeCpuUnits,
            freeMemoryGiB
        );
        const admission = admissionResult.selected;
        const admittedIds = new Set(admission.map((entry) => entry.id));
        const activeExecutableCount = [...active.values()]
            .filter((record) => record.coordinationOnly !== true).length;
        const exclusiveByStep = new Map(admissionResult.blockedByExclusiveResources
            .map((wait) => [wait.stepId, wait]));
        const countedByStep = new Map(admissionResult.blockedByCountedResources
            .map((wait) => [wait.stepId, wait]));
        const stateByStep = new Map(admissionResult.blockedByStateConflicts
            .map((wait) => [wait.stepId, wait]));
        for (const entry of normalized)
        {
            if (states.get(entry.id) !== 'pending')
            {
                continue;
            }
            const dependencies = (entry.dependsOn ?? []).filter((dependency) =>
            {
                const dependencyState = states.get(dependency);
                return entry.runAfterSettled === true || entry.alwaysRunFinalizer === true
                    ? !terminalStates.has(dependencyState)
                    : dependencyState !== 'success';
            });
            dependencies.push(...(entry.settledDependsOn ?? []).filter((dependency) =>
                !terminalStates.has(states.get(dependency))));
            if (dependencies.length > 0)
            {
                normalizedCapacity.onWaitState?.(entry.id, { dependencies });
                continue;
            }
            const exclusive = exclusiveByStep.get(entry.id);
            if (exclusive)
            {
                normalizedCapacity.onWaitState?.(entry.id,
          exclusive.resource === 'benchmark-window'
              ? { benchmarkIsolation: true }
              : { exclusiveResources: [exclusive.resource] });
                continue;
            }
            const counted = countedByStep.get(entry.id);
            if (counted)
            {
                normalizedCapacity.onWaitState?.(entry.id, {
                    countedResources: { [counted.resource]: counted }
                });
                continue;
            }
            const state = stateByStep.get(entry.id);
            if (state)
            {
                normalizedCapacity.onWaitState?.(entry.id, {
                    stateConflicts: state.conflicts.map((conflict) => ({
                        blockerStepId: state.heldBy,
                        domain: conflict.domain,
                        rule: conflict.rule,
                        leftModes: conflict.leftModes,
                        rightModes: conflict.rightModes,
                        proof: conflict.proof
                    })),
                    catalogDigest: state.catalogDigest
                });
                continue;
            }
            if (!admittedIds.has(entry.id))
            {
                normalizedCapacity.onWaitState?.(entry.id, {
                    capacity: {
                        cpu: freeCpuUnits < entry.resources.minCpuUnits
              || activeExecutableCount + admission.length >= normalizedCapacity.maxParallel,
                        memory: freeMemoryGiB < (entry.resources.minMemoryGiB ?? Number.EPSILON)
                    }
                });
            }
        }
        for (const wait of admissionResult.blockedByExclusiveResources)
        {
            const key = `${wait.stepId}\0${wait.resource}\0${wait.heldBy}\0${wait.holderState}`;
            if (reportedExclusiveWaits.has(key))
            {
                continue;
            }
            reportedExclusiveWaits.add(key);
            console.log(
                `[bundle-step-dag] wait ${wait.stepId}`
        + ` exclusiveResource=${wait.resource}`
        + ` heldBy=${wait.heldBy}`
        + ` holderState=${wait.holderState}`
            );
        }
        for (const wait of admissionResult.blockedByCountedResources)
        {
            const key = `${wait.stepId}\0${wait.resource}\0${wait.requested}\0${wait.used}\0${wait.capacity}`;
            if (reportedCountedWaits.has(key))
            {
                continue;
            }
            reportedCountedWaits.add(key);
            console.log(
                `[bundle-step-dag] wait ${wait.stepId}`
        + ` countedResource=${wait.resource}`
        + ` requested=${wait.requested}`
        + ` used=${wait.used}`
        + ` capacity=${wait.capacity}`
            );
        }
        for (const wait of admissionResult.blockedByStateConflicts)
        {
            const first = wait.conflicts[0];
            const key = `${wait.stepId}\0${wait.heldBy}\0${first?.domain}\0${first?.rule}`;
            if (reportedStateWaits.has(key))
            {
                continue;
            }
            reportedStateWaits.add(key);
            console.log(
                `[bundle-step-dag] wait ${wait.stepId}`
        + ` stateDomain=${first?.domain ?? 'unknown'}`
        + ` rule=${first?.rule ?? 'unknown'}`
        + ` heldBy=${wait.heldBy}`
        + ` holderState=${wait.holderState}`
            );
        }

        if (admission.length > 0)
        {
            const allocations = resolveConcurrentStepCapacities(admission, {
                cpuUnits: freeCpuUnits,
                memoryGiB: freeMemoryGiB
            });
            admission.forEach((entry, index) => start({
                ...entry,
                dependencyOutcomes: Object.fromEntries([
                    ...(entry.dependsOn ?? []),
                    ...(entry.settledDependsOn ?? [])
                ].map((dependency) => [dependency, states.get(dependency)]))
            }, allocations[index]));
            continue;
        }

        if (active.size > 0)
        {
            const activeCompletion = Promise.race([...active.values()].map((record) => record.promise));
            if (elastic)
            {
                // A scheduler grant can grow while every admitted step is still
                // running. Poll the live provider as well as completions so newly-free
                // capacity immediately admits an independent ready branch instead of
                // waiting for the longest browser lane to finish.
                const pollMs = Math.max(10, Math.min(250, Math.ceil(1000 / normalizedCapacity.cpuUnits)));
                const poll = new Promise((resolve) =>
                {
                    const timer = setTimeout(resolve, pollMs);
                    normalizedCapacity.signal?.addEventListener('abort', () =>
                    {
                        clearTimeout(timer);
                        resolve();
                    }, { once: true });
                });
                await Promise.race([activeCompletion, poll]);
            }
            else
            {
                await activeCompletion;
            }
            continue;
        }
        if (ready.length > 0)
        {
            if (!elastic)
            {
                throw new Error('no dependency-ready step fits the bundle CPU grant');
            }
            const pollMs = Math.max(10, Math.min(250, Math.ceil(1000 / normalizedCapacity.cpuUnits)));
            await new Promise((resolve) =>
            {
                const timer = setTimeout(resolve, pollMs);
                normalizedCapacity.signal?.addEventListener('abort', () =>
                {
                    clearTimeout(timer);
                    resolve();
                }, { once: true });
            });
            continue;
        }
        if ([...states.values()].some((state) => state === 'pending'))
        {
            throw new Error('step DAG has unresolved dependencies or a cycle');
        }
    }

    if (interruption === null && normalizeCapacity().signal?.aborted)
    {
        interruption = normalizeCapacity().signal.reason ?? new StepTerminalError(
            'cancelled', 'global-interrupt', 'step DAG cancelled');
    }
    failures.sort((left, right) =>
        Number(left.entry.alwaysRunFinalizer === true) - Number(right.entry.alwaysRunFinalizer === true)
        || left.index - right.index);
    if (interruption !== null)
    {
        const duplicate = failures.findIndex((failure) => failure.reason === interruption);
        if (duplicate >= 0)
        {
            failures.splice(duplicate, 1);
        }
        failures.unshift({ entry: { id: 'global-interrupt' }, reason: interruption });
    }
    if (failures.length === 0)
    {
        const nonSuccessReceipt = [...terminalReceipts.entries()].find(([, receipt]) =>
            receipt.terminalState !== 'success');
        if (nonSuccessReceipt)
        {
            failures.push({
                entry: { id: nonSuccessReceipt[0] },
                reason: new Error(`step DAG failed: ${nonSuccessReceipt[0]}`)
            });
        }
    }
    if (failures.length > 0)
    {
        const structuredFailures = failures.map((failure) => ({
            ...failure,
            reason: failure.reason ?? new Error(`step DAG failed: ${failure.entry.id}`)
        }));
        throw new StepDagExecutionError({
            failures: structuredFailures,
            states,
            terminalReceipts,
            interruption
        });
    }
    return {
        states: Object.fromEntries(states),
        terminalReceipts: Object.fromEntries(terminalReceipts)
    };
}

export function runtimeSteps()
{
    const runtimeStateConsumers = [
        'runtime-integration',
        'release-public',
        'endpoint-depth',
        'security-runtime-core',
        'local-runtime-exposure',
        'authenticated-dast',
        'zap-baseline',
        'cross-stack-join',
        'rights-matrix',
        'csrf-matrix',
        'resilience'
    ];
    const needsRuntime = ['bootstrap'];
    const needsStableReleaseHydration = ['release-public-hydration'];
    const runtimeBuildReadiness = [
        'behavior-evidence-ready',
        'backend-build-ready',
        'frontend-build-ready',
        'production-build-artifacts-ready'
    ];
    return [
        step('behavior-evidence-ready', null, [], {
            resources: { coordinationOnly: true }
        }),
        step('backend-build-ready', null, [], {
            resources: { coordinationOnly: true }
        }),
        step('frontend-build-ready', null, [], {
            resources: { coordinationOnly: true }
        }),
        step('production-build-artifacts-ready', null, [], {
            resources: { coordinationOnly: true }
        }),
        // The physical runtime bundle starts at t0 with one CPU. Static security is
        // its only executable task until completion; source contracts then consume
        // the backend/frontend marker gap without delaying bootstrap admission.
        step('security-static', 'tools/test/lanes/security-static.sh', [], {
            resources: { cpuWeight: 2, memoryWeight: 2, minCpuUnits: 1 }
        }),
        step('bootstrap', 'FSUSBLOG_RUNTIME_NO_BUILD=1 tools/bootstrap-acceptance-env.sh', ['bootstrap'], {
            dependsOn: [...runtimeBuildReadiness, 'security-static'],
            artifacts: [
                `${process.env.FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT ?? '.tmp/fixtures'}/${process.env.FSUSBLOG_TEST_NAMESPACE ?? 'local'}/manifest.json`
            ],
            resources: { cpuWeight: 2, memoryWeight: 2, minCpuUnits: 1 }
        }),
        // This is the sole production-runtime writer to the mutable preview overlay.
        // Runtime integration mutates and invalidates public fixtures, so settle the
        // final AOT generation and sidecar copy after that last writer, immediately
        // before release-preview readers enter the tree. Sealed build output stays
        // read-only for the entire run.
        step('release-public-hydration', 'tools/test/lanes/release-public-hydration.sh', [], {
            dependsOn: ['runtime-integration'],
            resources: { cpuWeight: 2, memoryWeight: 2, minCpuUnits: 1 }
        }),
        step('security-runtime-core', 'FSUSBLOG_LOCAL_RUNTIME_EXPOSURE_IN_DAG=1 FSUSBLOG_SKIP_ZAP=1 tools/test/lanes/security-runtime-core.sh', [], {
            dependsOn: needsRuntime,
            artifacts: [
                `${process.env.FSUSBLOG_RUNTIME_SCENARIO_OUTPUT_ROOT ?? '.tmp/runtime-scenario-host'}/security`
            ],
            resources: { cpuWeight: 2, memoryWeight: 2, minCpuUnits: 1 }
        }),
        // This lane creates dedicated identities in a private fixture directory,
        // so it can actively mutate the loopback runtime alongside shared security
        // checks without revoking or overwriting any sibling fixture session.
        step('authenticated-dast', 'tools/test/lanes/security-authenticated-dast.sh', ['security-authenticated-dast'], {
            dependsOn: ['security-runtime-core'],
            artifacts: [`${process.env.FSUSBLOG_SECURITY_OUTPUT_ROOT ?? '.tmp/security'}/authenticated-dast`],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
        }),
        step('runtime-integration', 'tools/test/lanes/runtime-integration.sh', ['integration'], {
            dependsOn: ['security-runtime-core'],
            artifacts: [
                process.env.FSUSBLOG_BACKEND_TRX_DIR ?? '.tmp/test-results/backend',
                `${process.env.FSUSBLOG_RUNTIME_SCENARIO_OUTPUT_ROOT ?? '.tmp/runtime-scenario-host'}/integration`,
                `${process.env.FSUSBLOG_RUNTIME_OUTPUT_ROOT ?? '.tmp/runtime'}/integration.json`
            ],
            resources: { cpuWeight: 1.5, memoryWeight: 1.5, minCpuUnits: 1 }
        }),
        step('release-public', 'FSUSBLOG_RELEASE_HYDRATION_PREPARED_BY_DAG=1 tools/test/lanes/release-public.sh', ['release'], {
            // The post-integration hydration step is the observable write barrier for
            // article/taxonomy invalidations. Public readers must not race that cache
            // transition or validate the previous fixture generation.
            dependsOn: [...needsStableReleaseHydration, 'runtime-integration'],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
        }),
        step('endpoint-depth', 'tools/test/lanes/endpoint-depth.sh', ['endpoint-depth'], {
            dependsOn: needsStableReleaseHydration,
            artifacts: [
                `${process.env.FSUSBLOG_CONTRACT_OUTPUT_ROOT ?? '.tmp/contracts'}/endpoint-depth-matrix.json`,
                `${process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? '.tmp/release-evidence'}/endpoint-depth-summary.json`
            ],
            resources: { cpuWeight: 1.5, memoryWeight: 1.5, minCpuUnits: 1 }
        }),
        // Starting/stopping the ZAP container changes the host network topology.
        // Run it after the remaining correctness runtime readers release their
        // contexts; browser contract and diagnostics execute in separate workflows.
        step('zap-baseline', 'tools/security/run-zap-baseline.sh', [], {
            dependsOn: [
                'security-runtime-core',
                'authenticated-dast',
                'release-public',
                'resilience',
                'cross-stack-runtime'
            ],
            artifacts: [`${process.env.FSUSBLOG_SECURITY_OUTPUT_ROOT ?? '.tmp/security'}/zap`]
        }),
        // Canonical OpenAPI generation and parity/coherence checks are source-based,
        // but delaying their seven-second CPU window lets bootstrap claim the full
        // refreshed grant as soon as both build markers land.
        step('cross-stack', 'FSUSBLOG_OPENAPI_BUILD=0 tools/test/lanes/cross-stack-contract.sh static', [], {
            dependsOn: ['security-static', 'backend-build-ready']
        }),
        step('cross-stack-runtime', 'tools/test/lanes/cross-stack-contract.sh runtime', [], {
            dependsOn: ['runtime-integration']
        }),
        step('rights-matrix', 'tools/test/lanes/rights-v3-test-matrix.sh', ['rights-v3-test-matrix'], { dependsOn: ['runtime-integration'] }),
        // The isolated TestServer matrix consumes the immutable backend test
        // assembly and needs no mutable application services.
        step('csrf-matrix', 'cd src/frontend && npm run check:security:csrf-browser-matrix', ['csrf-browser-matrix'], {
            dependsOn: ['security-static', 'backend-build-ready']
        }),
        step('resilience', 'tools/test/lanes/resilience-runtime.sh', ['resilience'], {
            dependsOn: ['release-public'],
            artifacts: [
                `${process.env.FSUSBLOG_RUNTIME_SCENARIO_OUTPUT_ROOT ?? '.tmp/runtime-scenario-host'}/resilience`,
                `${process.env.FSUSBLOG_RUNTIME_OUTPUT_ROOT ?? '.tmp/runtime'}/resilience.json`,
                `${process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? '.tmp/release-evidence'}/aot-cache-resilience-summary.json`
            ],
            resources: { cpuWeight: 2, memoryWeight: 2, minCpuUnits: 1 }
        }),
        step('local-runtime-exposure', 'node tools/security/check-local-runtime-exposure.mjs', [], {
            dependsOn: needsStableReleaseHydration
        }),
        step('security-join', null, ['security'], {
            dependsOn: ['security-static', 'security-runtime-core', 'local-runtime-exposure', 'zap-baseline'],
            runAfterSettled: true,
            joinDependencies: true,
            testIds: [
                'command:security-static',
                'command:security-runtime-core',
                'command:local-runtime-exposure',
                'command:zap-baseline',
                'command:security-join'
            ],
            resources: { coordinationOnly: true }
        }),
        step('cross-stack-join', 'node tools/test/cross-stack-receipts.mjs join', ['cross-stack-contract'], {
            dependsOn: ['cross-stack', 'cross-stack-runtime'],
            runAfterSettled: true,
            joinDependencies: true,
            artifacts: [process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR
                ? `${process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR}/cross-stack-contract.json`
                : '.tmp/release-evidence/cross-stack-contract.json'],
            testIds: [
                'command:cross-stack',
                'command:cross-stack-runtime',
                'command:cross-stack-join'
            ],
            resources: { coordinationOnly: true }
        }),
        step('runtime-state-stable', null, [], {
            dependsOn: runtimeStateConsumers,
            resources: { coordinationOnly: true }
        })
    // The physical runtime bundle settles at this marker. Runtime-preserving
    // tail work is owned by performance-evidence after the explicit handoff.
    ];
}

export function performanceSteps()
{
    const windowMembers = [
        'load',
        'runtime-cache-public-hot-read',
        'runtime-cache-article-detail-l1',
        'runtime-cache-cache-miss-singleflight',
        'runtime-cache-distributed-invalidation',
        'runtime-cache-l1-residency',
        'runtime-cache-pagination',
        'runtime-cache-related-reading',
        'runtime-cache-redis-fault-classes',
        'runtime-cache-revocation',
        'runtime-cache-hot-featured-frame',
        'runtime-cache-sitemap',
        'runtime-cache-security-projections',
        'runtime-cache-telemetry',
        'runtime-cache-evidence',
        'load-baseline',
        'load-peak'
    ];
    const measurementBarrier = 'performance-measurement-ready';
    const benchmarkResources = { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['benchmark-window'] };
    const timedMeasurements = [
        'backend-perf',
        'privacy-zk-benchmark',
        'mixed-performance-window',
        'aeds-frame-cost',
        'aeds-compression'
    ];
    const measurements = [
        'backend-perf',
        'privacy-zk-benchmark',
        'privacy-zk-finalize',
        'mixed-performance-window',
        'aeds-frame-cost',
        'aeds-compression'
    ];

    const steps = [
        ...[
            'backend-coverage-ready',
            'frontend-coverage-ready',
            'frontend-build-ready',
            'benchmark-build-ready',
            'runtime-state-ready',
            'backend-quiet-ready',
            'frontend-quiet-ready',
            'build-static-quiet-ready',
            'resident-handoff-ready'
        ].map((id) => step(id, null, [], { resources: { coordinationOnly: true } })),
        step('privacy-zk-project-functional', 'tools/test/lanes/privacy-zk-comment-matrix.sh project-functional', [], {
            dependsOn: ['backend-coverage-ready', 'frontend-coverage-ready', 'frontend-build-ready'],
            artifacts: [`${process.env.FSUSBLOG_SECURITY_OUTPUT_ROOT ?? '.tmp/security'}/privacy-zk-comment-matrix-stages/functional.json`],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
        }),
        step('coverage-merge', 'tools/coverage/merge-coverage.sh', ['coverage-merge'], {
            dependsOn: ['backend-coverage-ready', 'frontend-coverage-ready']
        }),
        step('coverage-threshold', 'tools/test/lanes/coverage-threshold.sh', ['coverage-threshold', 'coverage-gate', 'fast'], {
            dependsOn: ['coverage-merge']
        }),
        step('privacy-zk-performance-ready', 'node tools/test/verify-privacy-zk-performance-inputs.mjs', [], {
            dependsOn: ['privacy-zk-project-functional']
        }),
        step('data-scale-xs', 'tools/test/lanes/data-scale.sh scale-xs', ['data-scale-xs'], {
            dependsOn: ['runtime-state-ready', 'resident-handoff-ready'],
            artifacts: [
                `${process.env.FSUSBLOG_DATA_SCALE_ROOT ?? '.tmp/scale'}/scale-xs`,
                `${process.env.FSUSBLOG_DATA_SCALE_ROOT ?? '.tmp/scale'}/release-summaries/scale-xs.json`
            ]
        }),
        step('data-scale-s', 'tools/test/lanes/data-scale.sh scale-s', ['data-scale-s'], {
            dependsOn: ['runtime-state-ready', 'resident-handoff-ready'],
            artifacts: [
                `${process.env.FSUSBLOG_DATA_SCALE_ROOT ?? '.tmp/scale'}/scale-s`,
                `${process.env.FSUSBLOG_DATA_SCALE_ROOT ?? '.tmp/scale'}/release-summaries/scale-s.json`
            ]
        }),
        step('data-scale-summary', dataScaleEvidenceSummaryCommand, ['data-scale-evidence-summary'], {
            dependsOn: ['data-scale-xs', 'data-scale-s'],
            artifacts: [`${process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? '.tmp/release-evidence'}/data-scale-summary.json`]
        }),
        step('fault-injection', 'tools/test/lanes/fault-injection.sh', ['fault-injection'], {
            dependsOn: ['runtime-state-ready', 'resident-handoff-ready', 'data-scale-xs', 'data-scale-s'],
            artifacts: [process.env.FSUSBLOG_FAULT_EVIDENCE_DIR ?? '.tmp/fault-injection']
        }),
        step(measurementBarrier, null, [], {
            dependsOn: [
                'coverage-threshold', 'privacy-zk-performance-ready',
                'data-scale-summary', 'fault-injection', 'benchmark-build-ready',
                'backend-quiet-ready', 'frontend-quiet-ready', 'build-static-quiet-ready',
                'runtime-state-ready', 'resident-handoff-ready'
            ],
            resources: { coordinationOnly: true }
        }),
        step('backend-perf', 'FSUSBLOG_BACKEND_PERF_READINESS_MODE=verify-fresh tools/test/lanes/perf-regression.sh', ['backend-perf'], {
            dependsOn: [measurementBarrier],
            resources: benchmarkResources
        }),
        step('privacy-zk-benchmark', 'tools/test/lanes/privacy-zk-comment-matrix.sh benchmark', ['privacy-zk-comment-matrix'], {
            dependsOn: [measurementBarrier],
            resources: benchmarkResources
        }),
        step('privacy-zk-finalize', 'tools/test/lanes/privacy-zk-comment-matrix.sh finalize', ['privacy-zk-comment-matrix'], {
            // Finalization is not timing-sensitive and must not add CPU/filesystem
            // noise beside any later timed profiler.
            dependsOn: timedMeasurements
        }),
        step('mixed-performance-window', 'node tools/test/run-mixed-performance-window.mjs --reuse-passed', [
            ...windowMembers,
            'backend-benchmark-regression'
        ], {
            dependsOn: [measurementBarrier],
            artifacts: [
                `${process.env.FSUSBLOG_PERFORMANCE_OUTPUT_ROOT ?? '.tmp/perf'}/mixed-window`,
                `${process.env.FSUSBLOG_PERFORMANCE_OUTPUT_ROOT ?? '.tmp/perf'}/release-summaries`,
                `${process.env.FSUSBLOG_BENCHMARK_ARTIFACT_ROOT ?? 'BenchmarkDotNet.Artifacts'}`
            ],
            resources: benchmarkResources
        }),
        step('aeds-frame-cost', 'tools/test/lanes/aeds-frame-cost.sh', ['aeds-frame-cost'], {
            dependsOn: [measurementBarrier],
            artifacts: [
                `${process.env.FSUSBLOG_PERFORMANCE_OUTPUT_ROOT ?? '.tmp/perf'}/aeds-frame-cost`,
                `${process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? '.tmp/release-evidence'}/aeds-frame-cost-summary.json`
            ],
            resources: benchmarkResources
        }),
        // Compression profiling records deterministic product evidence rather
        // than duration statistics, but its qualification still requires the
        // same clean host measurement window as the timed profilers.
        step('aeds-compression', 'tools/test/lanes/aeds-compression-profile.sh', ['aeds-compression-profile'], {
            dependsOn: [measurementBarrier],
            artifacts: [
                `${process.env.FSUSBLOG_PERFORMANCE_OUTPUT_ROOT ?? '.tmp/perf'}/aeds-compression-profile`,
                `${process.env.FSUSBLOG_PERFORMANCE_OUTPUT_ROOT ?? '.tmp/perf'}/public-hot-read-residency-profile`,
                `${process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? '.tmp/release-evidence'}/aeds-compression-profile-summary.json`,
                `${process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? '.tmp/release-evidence'}/public-hot-read-residency-profile.json`
            ],
            resources: benchmarkResources
        }),
        step('performance-summary', 'node tools/test/aggregate-performance-evidence.mjs', ['performance-evidence-summary'], {
            dependsOn: ['coverage-threshold', ...measurements],
            artifacts: [`${process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? '.tmp/release-evidence'}/perf-summary.json`]
        }),
        step('release-evidence', 'tools/test/lanes/release-evidence.sh', ['release-evidence'], {
            dependsOn: ['performance-summary']
        }),
        step('production-summary', 'tools/test/lanes/production-correctness-receipt.sh', ['production'], {
            dependsOn: ['release-evidence']
        })
    ];
    const coordination = new Set([
        'backend-coverage-ready', 'frontend-coverage-ready', 'frontend-build-ready',
        'benchmark-build-ready', 'runtime-state-ready', 'backend-quiet-ready',
        'frontend-quiet-ready', 'build-static-quiet-ready', 'resident-handoff-ready',
        measurementBarrier
    ]);
    const postMeasurement = new Set([
        'privacy-zk-finalize', 'performance-summary', 'release-evidence', 'production-summary'
    ]);
    return steps.map((entry) => ({
        ...entry,
        evidencePhase: coordination.has(entry.id)
            ? 'coordination'
            : timedMeasurements.includes(entry.id)
        ? 'measurement'
        : postMeasurement.has(entry.id)
          ? 'post-measurement'
          : 'preparation'
    }));
}
