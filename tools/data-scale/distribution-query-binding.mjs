import { distributionCatalog, validateDistributionCatalog } from './distribution-catalog.mjs';
import { canonicalDigest, deepFreeze, exactKeys } from './distribution-contract.mjs';

/**
 * Structural checks consume the original query owner's explicit case inventory.
 * This component cannot admit query evidence: no current scenario receipt intake exists.
 * Callers must not infer applicability from case names or treat this report as a receipt.
 */
export function inspectQueryScenarioApplicability({ caseIds, applicability, catalog = distributionCatalog })
{
    const errors = [];
    const blockers = ['query_owner_scenario_receipt_intake_missing'];
    const catalogResult = validateDistributionCatalog(catalog);
    if (!catalogResult.valid)
    {
        errors.push(...catalogResult.errors.map((error) => `catalog:${error}`));
        blockers.push(...catalogResult.blockers.map((blocker) => `catalog:${blocker}`));
    }
    if (catalogResult.status === 'invalid')
    {
        return report(errors, blockers, [], null);
    }
    if (!Array.isArray(caseIds) || caseIds.length === 0
        || caseIds.some((id) => typeof id !== 'string' || !id.trim())
        || new Set(caseIds).size !== caseIds.length)
    {
        errors.push('query_owner_case_inventory_invalid');
        return report(errors, blockers, [], null);
    }
    if (!Array.isArray(applicability))
    {
        blockers.push('query_owner_scenario_applicability_missing');
        return report(errors, blockers, caseIds, null);
    }
    const cases = new Set(caseIds);
    const seen = new Set();
    const scenarios = new Map(catalog.scenarios.map((scenario) => [scenario.id, scenario]));
    for (const row of applicability)
    {
        try
        {
            exactKeys(row, ['caseId', 'requiredScenarioIds', 'minimumNonUniformCoverage', 'requiredMetricIds', 'owner'], 'applicability');
            if (!cases.has(row.caseId) || seen.has(row.caseId))
            {
                throw new Error('case_unknown_or_duplicate');
            }
            seen.add(row.caseId);
            if (typeof row.owner !== 'string' || !row.owner.trim())
            {
                throw new Error('owner_missing');
            }
            for (const field of ['requiredScenarioIds', 'requiredMetricIds'])
            {
                const values = row[field];
                if (!Array.isArray(values) || values.length === 0
                    || values.some((value) => typeof value !== 'string' || !value.trim())
                    || new Set(values).size !== values.length)
                {
                    throw new Error(`${field}_invalid`);
                }
            }
            if (!Number.isSafeInteger(row.minimumNonUniformCoverage) || row.minimumNonUniformCoverage < 1)
            {
                throw new Error('nonuniform_requirement_invalid');
            }
            let eligible = 0;
            for (const scenarioId of row.requiredScenarioIds)
            {
                const scenario = scenarios.get(scenarioId);
                if (!scenario)
                {
                    throw new Error(`scenario_unknown:${scenarioId}`);
                }
                if (scenarioId !== 'uniform-baseline' && scenario.releaseEvidenceEligible === true)
                {
                    eligible += 1;
                }
                const metrics = new Map(scenario.expectedStatistics.map((metric) => [metric.metricId, metric]));
                for (const metricId of row.requiredMetricIds)
                {
                    const metric = metrics.get(metricId);
                    if (!metric)
                    {
                        throw new Error(`metric_unknown:${scenarioId}:${metricId}`);
                    }
                    if (metric.status !== 'specified')
                    {
                        blockers.push(`query:${row.caseId}:scenario:${scenarioId}:metric:${metricId}:contract_blocked`);
                    }
                }
            }
            if (eligible < row.minimumNonUniformCoverage)
            {
                throw new Error('required_nonuniform_coverage_missing');
            }
        }
        catch (error)
        {
            errors.push(`query:${row?.caseId ?? 'unknown'}:${error.message}`);
        }
    }
    for (const caseId of cases)
    {
        if (!seen.has(caseId))
        {
            errors.push(`query:${caseId}:applicability_missing`);
        }
    }
    return report(errors, blockers, caseIds, canonicalDigest(applicability));
}

function report(errors, blockers, caseIds, applicabilityDigest)
{
    return deepFreeze({
        status: errors.length > 0 ? 'invalid' : 'blocked',
        qualification: false,
        releaseEvidenceEligible: false,
        errors,
        blockers: [...new Set(blockers)],
        caseIds: [...caseIds],
        applicabilityDigest
    });
}
