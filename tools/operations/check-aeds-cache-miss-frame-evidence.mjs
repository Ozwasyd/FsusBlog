import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requiredScenarios = new Set([
    'ArticleList10',
    'ArticleList50',
    'ArticleList100',
    'ArticleHot',
    'ArticleDetailBackfill',
    'CommentCursor',
    'UserComment',
    'TaxonomyCategory',
    'SystemSeo',
    'MessageConversation',
    'AdminStats'
]);
const requiredVariants = new Set(['current', 'exact', 'owned', 'tiered']);

function invariant(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function finiteNonNegative(value, label)
{
    invariant(Number.isFinite(value) && value >= 0, `${label} must be finite and non-negative`);
}

export function validateAedsCacheMissFrameEvidence(summary)
{
    invariant(summary?.schema === 'fsusblog.aeds-cache-miss-frame-cost.v1', 'unsupported cache-miss frame evidence schema');
    invariant(summary.status === 'ok', 'cache-miss frame evidence status must be ok');
    invariant(summary.measurementSource === 'local-real-pod-writer-profiler', 'cache-miss frame evidence must come from the local real POD writer profiler');
    invariant(summary.structuralModel?.downstreamZeroCopyClaimed === false, 'cache-miss frame evidence must not claim downstream zero-copy');
    invariant(Number.isInteger(summary.method?.runtimeLohThresholdBytes) && summary.method.runtimeLohThresholdBytes > 0, 'runtime LOH threshold evidence is missing');
    invariant(Array.isArray(summary.results), 'cache-miss frame results must be an array');

    const scenarios = new Map();
    for (const result of summary.results)
    {
        invariant(typeof result?.scenario === 'string' && result.scenario.length > 0, 'cache-miss frame scenario name is missing');
        invariant(!scenarios.has(result.scenario), `duplicate cache-miss frame scenario: ${result.scenario}`);
        scenarios.set(result.scenario, result);
        invariant(result.wireParity === true, `${result.scenario} wire parity failed`);
        invariant(['sensitive', 'public-immutable'].includes(result.frameClass), `${result.scenario} frame class is invalid`);
        invariant(result.missFrequency?.source === 'synthetic-one-rebuild-per-sample', `${result.scenario} must label synthetic rebuild frequency`);
        invariant(result.missFrequency?.productionFrequencyMetric === 'fsus.cache.owned_frame.build.count', `${result.scenario} runtime rebuild frequency metric is missing`);
        invariant(Array.isArray(result.variants), `${result.scenario} variants must be an array`);

        const variants = new Map();
        for (const variant of result.variants)
        {
            invariant(requiredVariants.has(variant?.name), `${result.scenario} has unsupported variant ${variant?.name}`);
            invariant(!variants.has(variant.name), `${result.scenario} duplicates variant ${variant.name}`);
            variants.set(variant.name, variant);
            invariant(Number.isInteger(variant.logicalBytes) && variant.logicalBytes > 0, `${result.scenario}:${variant.name} logical bytes are invalid`);
            invariant(Number.isInteger(variant.capacityBytes) && variant.capacityBytes >= variant.logicalBytes, `${result.scenario}:${variant.name} capacity must cover logical bytes`);
            invariant(variant.backingOverheadBytes === variant.capacityBytes - variant.logicalBytes, `${result.scenario}:${variant.name} backing overhead is inconsistent`);
            finiteNonNegative(variant.applicationCopyBytes, `${result.scenario}:${variant.name} application copy bytes`);
            finiteNonNegative(variant.measured?.p50Ms, `${result.scenario}:${variant.name} p50`);
            finiteNonNegative(variant.measured?.p95Ms, `${result.scenario}:${variant.name} p95`);
            finiteNonNegative(variant.measured?.allocationBytesPerRequest, `${result.scenario}:${variant.name} allocation`);
        }

        for (const variant of requiredVariants)
        {
            invariant(variants.has(variant), `${result.scenario} is missing ${variant}`);
        }
        invariant(variants.get('current').applicationCopyBytes > 0, `${result.scenario} current path must expose application copy bytes`);
        invariant(variants.get('exact').applicationCopyBytes === 0, `${result.scenario} exact path must remove application array copies`);
        invariant(variants.get('owned').applicationCopyBytes === 0, `${result.scenario} owned path must remove application array copies`);
    }

    for (const scenario of requiredScenarios)
    {
        invariant(scenarios.has(scenario), `cache-miss frame evidence is missing ${scenario}`);
    }
    invariant(scenarios.size === requiredScenarios.size, 'cache-miss frame evidence contains an unexpected scenario set');
    invariant(['owned', 'exact'].includes(summary.recommendation?.cacheOwnedFrame), 'cache-owned recommendation must be owned or exact');
    invariant(summary.recommendation?.publicSnapshotAndFileArtifact === 'exact', 'public snapshot/file artifact recommendation must remain exact');
    invariant(summary.recommendation?.scenarioCount === requiredScenarios.size, 'recommendation scenario count is inconsistent');
    return summary;
}

function main(argv)
{
    const file = path.resolve(argv[2] ?? '.tmp/perf/aeds-cache-miss-frame-cost/summary.json');
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateAedsCacheMissFrameEvidence(summary);
    console.log(`[aeds-cache-miss-frame-evidence] validated ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
{
    main(process.argv);
}
