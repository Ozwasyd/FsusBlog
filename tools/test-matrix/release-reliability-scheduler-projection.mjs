import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMatrix } from './parse-matrix.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const releaseReliabilityCatalogPath =
    'config/testing/release-reliability-scenario-catalog.json';
export const releaseReliabilitySchedulerAuthority =
    'release-reliability-scenario-catalog';

const fixedProfiles = {
    'release-soak-min': {
        resourceClass: 'database', cpuWeight: 2, memoryWeight: 2, minCpuUnits: 2,
        exclusiveResources: ['database', 'resource-counters', 'runtime-http'],
        countedResources: {}, maxParallel: 1, parallelizable: false, cost: 'high',
        timeoutPolicyId: 'release-soak-outer'
    },
    'release-load-peak': {
        resourceClass: 'benchmark', cpuWeight: 2, memoryWeight: 1, minCpuUnits: 2,
        exclusiveResources: ['network', 'performance-counters', 'runtime-http'],
        countedResources: {}, maxParallel: 1, parallelizable: false, cost: 'high',
        timeoutPolicyId: 'release-load-peak-outer'
    },
    'release-load-burst': {
        resourceClass: 'benchmark', cpuWeight: 4, memoryWeight: 2, minCpuUnits: 4,
        exclusiveResources: ['network', 'performance-counters', 'runtime-http'],
        countedResources: {}, maxParallel: 1, parallelizable: false, cost: 'high',
        timeoutPolicyId: 'release-load-burst-outer'
    },
    'release-data-scale-m': {
        resourceClass: 'database', cpuWeight: 2, memoryWeight: 4, minCpuUnits: 2,
        exclusiveResources: [
            'data-scale-artifacts', 'data-scale-postgres', 'data-scale-redis',
            'data-scale-runtime'
        ],
        countedResources: {}, maxParallel: 1, parallelizable: false, cost: 'high',
        timeoutPolicyId: 'release-data-scale-outer'
    },
    'release-mutation-critical-slice': {
        resourceClass: 'cpu', cpuWeight: 4, memoryWeight: 4, minCpuUnits: 4,
        exclusiveResources: ['build-artifacts', 'cpu', 'mutation-output'],
        countedResources: {}, maxParallel: 1, parallelizable: false, cost: 'high',
        timeoutPolicyId: 'release-mutation-outer'
    },
    'release-memory-leak-budget': {
        resourceClass: 'database', cpuWeight: 2, memoryWeight: 2, minCpuUnits: 2,
        exclusiveResources: ['database', 'resource-counters', 'runtime-http'],
        countedResources: {}, maxParallel: 1, parallelizable: false, cost: 'high',
        timeoutPolicyId: 'release-memory-retention-outer'
    },
    'release-open-handle-budget': {
        resourceClass: 'database', cpuWeight: 2, memoryWeight: 2, minCpuUnits: 2,
        exclusiveResources: ['database', 'resource-counters', 'runtime-http'],
        countedResources: {}, maxParallel: 1, parallelizable: false, cost: 'high',
        timeoutPolicyId: 'release-handle-retention-outer'
    }
};

const projectionFields = [
    'resourceClass',
    'cpuWeight',
    'memoryWeight',
    'minCpuUnits',
    'exclusiveResources',
    'countedResources',
    'maxParallel',
    'parallelizable',
    'cost',
    'timeoutPolicyId',
    'timeoutMinutes'
];

function stableValue(value)
{
    if (Array.isArray(value))
    {
        return value.map(stableValue);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
        );
    }
    return value;
}

function digest(value)
{
    return `sha256:${createHash('sha256')
        .update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function sameValue(left, right)
{
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function timeoutPolicyMap(catalog)
{
    return new Map((catalog?.schedulerTimeoutPolicies ?? []).map((policy) => [policy?.id, policy]));
}

export function loadReleaseReliabilityCatalog({ root = repositoryRoot } = {})
{
    return JSON.parse(fs.readFileSync(path.join(root, releaseReliabilityCatalogPath), 'utf8'));
}

export function validateReleaseReliabilitySchedulerCatalog(catalog, {
    lifecycleRegistry = null
} = {})
{
    const errors = [];
    const policies = timeoutPolicyMap(catalog);
    const scenarios = new Map((catalog?.scenarios ?? []).map((scenario) => [scenario?.id, scenario]));
    if (!Array.isArray(catalog?.schedulerTimeoutPolicies)
        || policies.size !== catalog.schedulerTimeoutPolicies.length)
    {
        errors.push('schedulerTimeoutPolicies must contain unique policy IDs');
    }
    for (const policy of catalog?.schedulerTimeoutPolicies ?? [])
    {
        const fields = [
            'measurementBudgetMs', 'startupMarginMs', 'finalizationMarginMs',
            'terminationMarginMs', 'outerTimeoutMs'
        ];
        if (typeof policy?.id !== 'string' || !policy.id
            || fields.some((field) => !Number.isInteger(policy?.[field]) || policy[field] < 0)
            || policy.outerTimeoutMs !== policy.measurementBudgetMs
                + policy.startupMarginMs + policy.finalizationMarginMs
                + policy.terminationMarginMs
            || policy.outerTimeoutMs % 60000 !== 0)
        {
            errors.push(`scheduler timeout policy ${policy?.id ?? '<missing>'} is invalid`);
        }
    }
    for (const [scenarioId, fixedProfile] of Object.entries(fixedProfiles))
    {
        const scenario = scenarios.get(scenarioId);
        if (!scenario)
        {
            errors.push(`missing canonical scheduler scenario ${scenarioId}`);
            continue;
        }
        if (!sameValue(scenario.scheduler, fixedProfile))
        {
            errors.push(`scenario ${scenarioId}.scheduler does not match the fixed profile`);
        }
        if (scenario.resourceClass !== scenario.scheduler?.resourceClass)
        {
            errors.push(`scenario ${scenarioId}.resourceClass must equal scheduler.resourceClass`);
        }
        const policy = policies.get(scenario.scheduler?.timeoutPolicyId);
        if (!policy)
        {
            errors.push(`scenario ${scenarioId} references a missing timeout policy`);
        }
        else
        {
            const projected = {
                ...scenario.scheduler,
                timeoutMinutes: policy.outerTimeoutMs / 60000
            };
            const expectedDigest = digest({ scenarioId, scheduler: projected });
            if (scenario.schedulerProfileDigest !== expectedDigest)
            {
                errors.push(
                    `scenario ${scenarioId}.schedulerProfileDigest does not match its profile`
                );
            }
        }
        if (lifecycleRegistry && policy)
        {
            const measurementId = scenario.isolation?.lifecycle?.measurement;
            const action = lifecycleRegistry.actions?.find(
                (candidate) => candidate.actionId === measurementId
            );
            if (!action || action.scenarioId !== scenarioId
                || action.timeoutPolicy?.timeoutMs < policy.measurementBudgetMs)
            {
                errors.push(
                    `scenario ${scenarioId} measurement deadline is below scheduler policy minimum`
                );
            }
        }
    }
    const declaredScenarioIds = [...scenarios.keys()];
    if (!sameValue(declaredScenarioIds, Object.keys(fixedProfiles)))
    {
        errors.push('catalog scenarios and fixed scheduler profiles must exactly match in order');
    }
    if (policies.size !== Object.keys(fixedProfiles).length)
    {
        errors.push('scheduler timeout policies must exactly cover the seven scenarios');
    }
    return errors;
}

export function releaseReliabilitySchedulerProjection(catalog, scenarioId)
{
    const scenario = catalog?.scenarios?.find((candidate) => candidate.id === scenarioId);
    if (!scenario)
    {
        throw new Error(`unknown release reliability scenario: ${scenarioId}`);
    }
    const policy = timeoutPolicyMap(catalog).get(scenario.scheduler?.timeoutPolicyId);
    if (!policy)
    {
        throw new Error(`scenario ${scenarioId} has no scheduler timeout policy`);
    }
    const projected = {
        ...scenario.scheduler,
        timeoutMinutes: policy.outerTimeoutMs / 60000
    };
    return {
        schedulerAuthority: releaseReliabilitySchedulerAuthority,
        schedulerProfileDigest: scenario.schedulerProfileDigest,
        ...projected
    };
}

function scenarioIdFromCommand(command)
{
    const match = String(command ?? '').match(
        /run-release-reliability-scenarios\.mjs\s+--scenario(?:=|\s+)([^\s"']+)/u
    );
    return match?.[1] ?? null;
}

export function validateReleaseReliabilitySchedulerMatrix(matrix, catalog)
{
    if (!Object.hasOwn(catalog ?? {}, 'schedulerTimeoutPolicies'))
    {
        return [];
    }
    const errors = [];
    const catalogErrors = validateReleaseReliabilitySchedulerCatalog(catalog);
    errors.push(...catalogErrors);
    const tiersById = new Map((matrix?.tiers ?? []).map((tier) => [tier.id, tier]));
    for (const scenario of catalog?.scenarios ?? [])
    {
        const tier = tiersById.get(scenario.id);
        const expected = releaseReliabilitySchedulerProjection(catalog, scenario.id);
        if (!tier || scenarioIdFromCommand(tier.command) !== scenario.id)
        {
            errors.push(`scenario ${scenario.id} must have one matching diagnostic matrix tier`);
            continue;
        }
        for (const field of [
            'schedulerAuthority', 'schedulerProfileDigest', ...projectionFields
        ])
        {
            if (!sameValue(tier[field], expected[field]))
            {
                errors.push(
                    `tier ${tier.id}.${field} must exactly match the generated catalog projection`
                );
            }
        }
    }
    for (const tier of matrix?.tiers ?? [])
    {
        const scenarioId = scenarioIdFromCommand(tier.command);
        if (scenarioId && !fixedProfiles[scenarioId])
        {
            errors.push(
                `matrix contains handwritten release reliability scenario tier ${tier.id}`
            );
        }
    }
    const fullTier = tiersById.get('release-reliability-fresh');
    if (!fullTier || fullTier.parallelizable !== false || fullTier.maxParallel !== 1
        || !sameValue(fullTier.exclusiveResources, ['release-reliability'])
        || fullTier.cost !== 'high' || fullTier.cpuWeight !== 4
        || fullTier.memoryWeight !== 4 || fullTier.minCpuUnits !== 4)
    {
        errors.push(
            'release-reliability-fresh must be globally exclusive, nonparallel, and reserve the maximum scenario profile'
        );
    }
    return errors;
}

export function releaseReliabilityResourceConflict(candidate, holders)
{
    for (const holder of holders)
    {
        const held = new Set(holder.exclusiveResources ?? []);
        const resource = (candidate.exclusiveResources ?? []).find((value) => held.has(value));
        if (resource)
        {
            return {
                resource,
                holder: holder.id,
                candidate: candidate.id,
                reason: `exclusive resource ${resource} is held by ${holder.id}`
            };
        }
    }
    return null;
}

function yamlScalar(value)
{
    if (Array.isArray(value))
    {
        return `[${value.join(', ')}]`;
    }
    if (value && typeof value === 'object')
    {
        return '{}';
    }
    return String(value);
}

function replaceTierProjection(matrixText, scenarioId, projection)
{
    const startToken = `    - id: ${scenarioId}\n`;
    const start = matrixText.indexOf(startToken);
    if (start < 0)
    {
        throw new Error(`matrix tier ${scenarioId} is missing`);
    }
    const next = matrixText.indexOf('\n    - id: ', start + startToken.length);
    const end = next < 0 ? matrixText.length : next + 1;
    let block = matrixText.slice(start, end);
    const values = {
        schedulerAuthority: projection.schedulerAuthority,
        schedulerProfileDigest: projection.schedulerProfileDigest,
        ...Object.fromEntries(projectionFields.map((field) => [field, projection[field]]))
    };
    for (const [field, value] of Object.entries(values))
    {
        const line = `      ${field}: ${yamlScalar(value)}`;
        const pattern = new RegExp(`^      ${field}:.*$`, 'mu');
        if (pattern.test(block))
        {
            block = block.replace(pattern, line);
        }
        else
        {
            block = block.replace(
                /^( {6}services:.*)$/mu,
                `$1\n${line}`
            );
        }
    }
    return matrixText.slice(0, start) + block + matrixText.slice(end);
}

export function generateReleaseReliabilitySchedulerMatrix(matrixText, catalog)
{
    let generated = matrixText;
    for (const scenario of catalog.scenarios)
    {
        generated = replaceTierProjection(
            generated,
            scenario.id,
            releaseReliabilitySchedulerProjection(catalog, scenario.id)
        );
    }
    parseMatrix(generated);
    return generated;
}
