import path from 'node:path';
import { buildAggregatePlan, parseAggregateCommand } from './aggregate-plan.mjs';

export const evidenceExecutionModes = ['execute', 'projection', 'summary'];

function isSafeRepositoryPath(value)
{
    const normalized = String(value ?? '').replaceAll('\\', '/');
    return Boolean(normalized)
    && !path.posix.isAbsolute(normalized)
    && normalized !== '.'
    && !normalized.split('/').includes('..');
}

function validateSortedStrings(tier, field, errors)
{
    const values = tier[field];
    if (!Array.isArray(values) || values.length === 0)
    {
        errors.push(`${tier.id}.${field} must be a non-empty array for projection tiers`);
        return;
    }
    if (values.some((value) => typeof value !== 'string' || !value.trim()))
    {
        errors.push(`${tier.id}.${field} entries must be non-empty strings`);
    }
    if (new Set(values).size !== values.length)
    {
        errors.push(`${tier.id}.${field} must not contain duplicates`);
    }
    if (JSON.stringify(values) !== JSON.stringify([...values].sort()))
    {
        errors.push(`${tier.id}.${field} must be sorted`);
    }
}

function validateSummaryDeclaration(tier, matrix)
{
    const errors = [];
    if (!['aggregate', 'receipt'].includes(tier.commandKind))
    {
        errors.push(`${tier.id}.commandKind must be aggregate or receipt for summary tiers`);
    }
    if (typeof tier.outputReceiptSchema !== 'string' || !tier.outputReceiptSchema.trim())
    {
        errors.push(`${tier.id}.outputReceiptSchema must be declared for summary tiers`);
    }
    if (!Array.isArray(tier.summaryInputs) || tier.summaryInputs.length === 0
        || tier.summaryInputs.some((input) => typeof input !== 'string' || !input.trim()))
    {
        errors.push(`${tier.id}.summaryInputs must declare non-empty structured receipt inputs`);
    }
    const aggregate = parseAggregateCommand(tier.command);
    if (aggregate)
    {
        if (tier.commandKind !== 'aggregate')
        {
            errors.push(`${tier.id}.aggregate command requires commandKind=aggregate`);
        }
        if (tier.summaryAuthority !== aggregate.target)
        {
            errors.push(`${tier.id}.summaryAuthority must equal aggregate command target ${aggregate.target}`);
        }
        const plan = buildAggregatePlan(matrix, aggregate.target);
        errors.push(...plan.errors.map((error) => `${tier.id} aggregate: ${error}`));
        if (plan.outputReceiptSchema && tier.outputReceiptSchema !== plan.outputReceiptSchema)
        {
            errors.push(`${tier.id}.outputReceiptSchema must match aggregate authority ${aggregate.target}`);
        }
    }
    else if (tier.commandKind === 'aggregate')
    {
        errors.push(`${tier.id}.commandKind=aggregate must use node tools/run-test-matrix.mjs aggregate <authority>`);
    }
    return errors;
}

export function validateEvidenceExecutionDeclaration(tier, matrix = { tiers: [] })
{
    const errors = [];
    const executionMode = tier.executionMode ?? 'execute';
    if (!evidenceExecutionModes.includes(executionMode))
    {
        return [`${tier.id}.executionMode is invalid: ${tier.executionMode}`];
    }
    if (executionMode === 'execute')
    {
        for (const field of ['projectionCatalog', 'requiredTestIds', 'requiredCoverageIds', 'requiredArtifactDeclarations'])
        {
            if (field in tier)
            {
                errors.push(`${tier.id}.${field} is reserved for projection tiers`);
            }
        }
        return errors;
    }
    if (executionMode === 'summary')
    {
        return validateSummaryDeclaration(tier, matrix);
    }

    for (const field of ['executionOwner', 'projectionCatalog'])
    {
        if (typeof tier[field] !== 'string' || !tier[field].trim())
        {
            errors.push(`${tier.id}.${field} is required for projection tiers`);
        }
    }
    if (tier.commandKind !== 'projection')
    {
        errors.push(`${tier.id}.commandKind must be projection for projection tiers`);
    }
    if (typeof tier.outputReceiptSchema !== 'string' || !tier.outputReceiptSchema.trim())
    {
        errors.push(`${tier.id}.outputReceiptSchema must be declared for projection tiers`);
    }
    const producers = Array.isArray(tier.projectFrom) ? tier.projectFrom : [tier.projectFrom];
    if (producers.some((producer) => typeof producer !== 'string' || !producer.trim())
        || new Set(producers).size !== producers.length
        || JSON.stringify(producers) !== JSON.stringify([...producers].sort()))
    {
        errors.push(`${tier.id}.projectFrom must contain sorted unique canonical producer IDs`);
    }
    if (producers.length === 1 && tier.executionOwner !== producers[0])
    {
        errors.push(`${tier.id}.executionOwner must equal projectFrom for a single canonical producer`);
    }
    if (!isSafeRepositoryPath(tier.projectionCatalog))
    {
        errors.push(`${tier.id}.projectionCatalog must be a repository-relative path without traversal`);
    }
    for (const field of ['requiredTestIds', 'requiredCoverageIds', 'requiresEvidenceFrom'])
    {
        validateSortedStrings(tier, field, errors);
    }

    const declarations = tier.requiredArtifactDeclarations;
    if (!Array.isArray(declarations) || declarations.length === 0)
    {
        errors.push(`${tier.id}.requiredArtifactDeclarations must be a non-empty array for projection tiers`);
    }
    else
    {
        const ids = declarations.map((entry) => entry?.id);
        const paths = declarations.map((entry) => entry?.path);
        if (declarations.some((entry) => !entry || typeof entry.id !== 'string' || !entry.id.trim()
      || !isSafeRepositoryPath(entry.path)))
        {
            errors.push(`${tier.id}.requiredArtifactDeclarations entries require an ID and safe repository-relative path`);
        }
        if (new Set(ids).size !== ids.length)
        {
            errors.push(`${tier.id}.requiredArtifactDeclarations must not contain duplicate IDs`);
        }
        if (new Set(paths).size !== paths.length)
        {
            errors.push(`${tier.id}.requiredArtifactDeclarations must not contain duplicate paths`);
        }
        if (JSON.stringify(ids) !== JSON.stringify([...ids].sort()))
        {
            errors.push(`${tier.id}.requiredArtifactDeclarations must be sorted by ID`);
        }
    }

    const command = String(tier.command ?? '');
    if (!/^node tools\/test\/project-(?:evidence|rights-v3-evidence)\.mjs(?: |$)/u.test(command)
    || /(?:&&|\|\||;|\n|`|\$\()/u.test(command))
    {
        errors.push(`${tier.id} projection command must exclusively use node tools/test/project-evidence.mjs`);
    }
    if ((tier.services?.length ?? 0) > 0 || (tier.exclusiveResources?.length ?? 0) > 0)
    {
        errors.push(`${tier.id} projection tier must not declare services or exclusive resources`);
    }
    if (tier.requiresBootstrap !== 'none' || tier.requiresDotnet !== false || tier.requiresNode !== true
    || tier.requiresPlaywright !== 'none' || tier.cacheProfile !== 'none')
    {
        errors.push(`${tier.id} projection tier must be Node-only without bootstrap, .NET, Playwright, or execution cache`);
    }
    if (tier.resourceClass !== 'io' || tier.cost !== 'low')
    {
        errors.push(`${tier.id} projection tier must use resourceClass=io and cost=low`);
    }
    const missingDependencies = producers.filter((producer) => !tier.dependsOn?.includes(producer));
    const missingEvidence = producers.filter((producer) => !tier.requiresEvidenceFrom?.includes(producer));
    if (missingDependencies.length > 0 || missingEvidence.length > 0)
    {
        errors.push(`${tier.id} projection tier must depend on and require evidence from every projectFrom producer`);
    }
    return errors;
}
