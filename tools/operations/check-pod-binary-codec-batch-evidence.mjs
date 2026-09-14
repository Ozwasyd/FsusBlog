import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const itemCounts = [0, 1, 10, 50, 100];
const tagCounts = [0, 2, 8];
const textLengths = ['short', 'medium', 'long'];
const textEncodings = ['ascii', 'cjk', 'mixed'];
const pageVariants = new Set([
    'legacy-list',
    'exact-capacity-list',
    'two-pass-direct',
    'array-pool-records',
    'adaptive-stack-pool'
]);
const detailVariants = new Set(['legacy-list', 'adaptive-detail']);
const auditedCodecs = new Set([
    'CommentCursor',
    'UserCommentCursor',
    'CommentReplyCursor',
    'CommentThreadCursor',
    'ConversationDetail',
    'ConversationList',
    'SiteStats',
    'CategoryList',
    'TagWithCountList'
]);

function invariant(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function nonNegativeNumber(value, label, { integer = false } = {})
{
    invariant(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${label} must be finite and non-negative`);
    if (integer)
    {
        invariant(Number.isInteger(value), `${label} must be an integer`);
    }
}

function positiveInteger(value, label)
{
    invariant(Number.isInteger(value) && value > 0, `${label} must be a positive integer`);
}

function indexVariants(variants, required, label, method)
{
    invariant(Array.isArray(variants), `${label} variants must be an array`);
    const index = new Map();
    for (const variant of variants)
    {
        invariant(required.has(variant?.name), `${label} has unsupported variant ${variant?.name}`);
        invariant(!index.has(variant.name), `${label} duplicates variant ${variant.name}`);
        index.set(variant.name, variant);
        for (const field of [
            'managedTemporaryCollectionCount',
            'pooledBufferCount',
            'capacityWasteBytes',
            'copyBytes',
            'allocatedBytesPerFrame',
            'allocatedBytesPerItem'
        ])
        {
            nonNegativeNumber(variant[field], `${label}:${variant.name}.${field}`, { integer: true });
        }
        const measured = variant.measured;
        invariant(measured && typeof measured === 'object', `${label}:${variant.name} measured evidence is missing`);
        for (const field of ['meanMs', 'p50Ms', 'p95Ms', 'allocationBytesPerRequest'])
        {
            nonNegativeNumber(measured[field], `${label}:${variant.name}.measured.${field}`);
        }
        invariant(measured.p50Ms <= measured.p95Ms, `${label}:${variant.name} p50 must not exceed p95`);
        invariant(measured.allocationBytesPerRequest === variant.allocatedBytesPerFrame, `${label}:${variant.name} allocation aliases disagree`);
        invariant(measured.sampleCount === method.roundCount * method.iterationsPerRound, `${label}:${variant.name} sample count is inconsistent`);
        invariant(Array.isArray(measured.rounds) && measured.rounds.length === method.roundCount, `${label}:${variant.name} rounds are incomplete`);
        for (const [roundIndex, round] of measured.rounds.entries())
        {
            invariant(round.round === roundIndex + 1, `${label}:${variant.name} rounds must be contiguous`);
            invariant(Array.isArray(round.samplesMs) && round.samplesMs.length === method.iterationsPerRound, `${label}:${variant.name} round samples are incomplete`);
            invariant(round.sampleCount === method.iterationsPerRound, `${label}:${variant.name} round sample count is inconsistent`);
            nonNegativeNumber(round.allocatedBytesTotal, `${label}:${variant.name} round allocation`, { integer: true });
            nonNegativeNumber(round.allocationBytesPerRequest, `${label}:${variant.name} round allocation per request`, { integer: true });
        }
    }
    for (const name of required)
    {
        invariant(index.has(name), `${label} is missing ${name}`);
    }
    invariant(index.size === required.size, `${label} has an unexpected variant count`);
    return index;
}

function validateFrequency(value, label)
{
    invariant(value?.source === 'synthetic-one-rebuild-per-sample', `${label} must label synthetic rebuild frequency`);
    invariant(value.productionFrequencyMetric === 'fsus.cache.owned_frame.build.count', `${label} runtime rebuild metric is missing`);
    invariant(value.cacheHitPathMeasured === false, `${label} must not present rebuild samples as cache-hit measurements`);
}

function withinSmallLatencyPolicy(candidateP95Ms, baselineP95Ms)
{
    return candidateP95Ms <= baselineP95Ms * 1.10 || candidateP95Ms - baselineP95Ms <= 0.002;
}

export function validatePodBinaryCodecBatchEvidence(summary)
{
    invariant(summary?.schema === 'fsusblog.pod-binary-codec-batch.v1', 'unsupported PodBinaryCodec batch evidence schema');
    invariant(summary.status === 'ok', 'PodBinaryCodec batch evidence status must be ok');
    invariant(summary.measurementSource === 'local-real-codec-profiler', 'PodBinaryCodec evidence must come from the local real codec profiler');
    const method = summary.method;
    positiveInteger(method?.warmupIterations, 'method.warmupIterations');
    invariant(Number.isInteger(method?.iterationsPerRound) && method.iterationsPerRound >= 2, 'method.iterationsPerRound must be at least 2');
    invariant(Number.isInteger(method?.roundCount) && method.roundCount >= 3, 'method.roundCount must be at least 3');
    invariant(method.ordering === 'rotating-candidate-order', 'candidate order must rotate');
    invariant(method.allocationCounter === 'GC.GetAllocatedBytesForCurrentThread', 'allocation counter is unsupported');
    invariant(method.scenarioCount === 135, 'ArticleList matrix must contain 135 scenarios');

    invariant(Array.isArray(summary.articlePageResults), 'ArticlePage results must be an array');
    const expectedScenarios = new Set();
    for (const itemCount of itemCounts)
    {
        for (const tagsPerItem of tagCounts)
        {
            for (const textLength of textLengths)
            {
                for (const textEncoding of textEncodings)
                {
                    expectedScenarios.add(`article-list-${itemCount}-tags-${tagsPerItem}-${textEncoding}-${textLength}`);
                }
            }
        }
    }
    const pageResults = new Map();
    let representativeCount = 0;
    let representativeAllocationWins = 0;
    let smallCount = 0;
    let smallP95WithinPolicy = 0;
    for (const result of summary.articlePageResults)
    {
        invariant(expectedScenarios.has(result?.scenario), `unexpected ArticlePage scenario ${result?.scenario}`);
        invariant(!pageResults.has(result.scenario), `duplicate ArticlePage scenario ${result.scenario}`);
        pageResults.set(result.scenario, result);
        invariant(itemCounts.includes(result.itemCount), `${result.scenario} item count is invalid`);
        invariant(tagCounts.includes(result.tagsPerItem), `${result.scenario} tag count is invalid`);
        invariant(textLengths.includes(result.textLength), `${result.scenario} text length is invalid`);
        invariant(textEncodings.includes(result.textEncoding), `${result.scenario} text encoding is invalid`);
        invariant(result.tagRecordCount === result.itemCount * result.tagsPerItem, `${result.scenario} tag record count is inconsistent`);
        positiveInteger(result.outputBytes, `${result.scenario}.outputBytes`);
        nonNegativeNumber(result.blobBytes, `${result.scenario}.blobBytes`, { integer: true });
        invariant(result.wireParity === true, `${result.scenario} wire parity failed`);
        validateFrequency(result.encodeFrequency, result.scenario);
        const variants = indexVariants(result.variants, pageVariants, result.scenario, method);
        invariant(variants.get('legacy-list').managedTemporaryCollectionCount === 3, `${result.scenario} legacy collection fact is missing`);
        invariant(variants.get('exact-capacity-list').managedTemporaryCollectionCount === 3, `${result.scenario} exact-list collection fact is missing`);
        invariant(variants.get('exact-capacity-list').capacityWasteBytes === 0, `${result.scenario} exact-list capacity waste must be zero`);
        invariant(variants.get('two-pass-direct').managedTemporaryCollectionCount === 0, `${result.scenario} direct candidate must not allocate managed temporary collections`);
        invariant(variants.get('adaptive-stack-pool').managedTemporaryCollectionCount === 0, `${result.scenario} adaptive candidate must not allocate managed temporary collections`);
        invariant(variants.get('legacy-list').copyBytes === result.blobBytes, `${result.scenario} legacy blob copy accounting is inconsistent`);
        invariant(variants.get('exact-capacity-list').copyBytes === result.blobBytes, `${result.scenario} exact-list blob copy accounting is inconsistent`);
        for (const name of ['two-pass-direct', 'array-pool-records', 'adaptive-stack-pool'])
        {
            invariant(variants.get(name).copyBytes === 0, `${result.scenario}:${name} must remove the intermediate blob copy`);
        }
        const legacy = variants.get('legacy-list');
        const adaptive = variants.get('adaptive-stack-pool');
        if (result.itemCount >= 50)
        {
            representativeCount += 1;
            if (adaptive.allocatedBytesPerFrame <= legacy.allocatedBytesPerFrame * 0.75)
            {
                representativeAllocationWins += 1;
            }
        }
        if (result.itemCount <= 1)
        {
            smallCount += 1;
            if (withinSmallLatencyPolicy(adaptive.measured.p95Ms, legacy.measured.p95Ms))
            {
                smallP95WithinPolicy += 1;
            }
        }
    }
    invariant(pageResults.size === expectedScenarios.size, 'ArticlePage scenario matrix is incomplete');
    const pageRecommendation = summary.recommendation?.articlePage;
    invariant(pageRecommendation?.representativeCount === representativeCount, 'ArticlePage representative count is not evidence-derived');
    invariant(pageRecommendation.representativeAllocationWins === representativeAllocationWins, 'ArticlePage allocation win count is not evidence-derived');
    invariant(pageRecommendation.smallCount === smallCount, 'ArticlePage small count is not evidence-derived');
    invariant(pageRecommendation.smallP95WithinPolicy === smallP95WithinPolicy, 'ArticlePage small p95 count is not evidence-derived');
    invariant(pageRecommendation.pageAllocationPolicyMet === (representativeAllocationWins >= Math.ceil(representativeCount * 0.80)), 'ArticlePage allocation policy conclusion is inconsistent');
    invariant(pageRecommendation.pageSmallLatencyPolicyMet === (smallP95WithinPolicy >= Math.ceil(smallCount * 0.70)), 'ArticlePage latency policy conclusion is inconsistent');
    invariant(pageRecommendation.selected === 'adaptive-stack-pool', 'ArticlePage evidence did not select the implemented adaptive candidate');

    invariant(Array.isArray(summary.articleDetailResults) && summary.articleDetailResults.length === 3, 'ArticleDetail evidence must cover short, medium, and large scenarios');
    const detailNames = new Set();
    let detailRepresentativeCount = 0;
    let detailAllocationWins = 0;
    let detailP95WithinPolicy = 0;
    for (const result of summary.articleDetailResults)
    {
        invariant(typeof result?.scenario === 'string' && !detailNames.has(result.scenario), 'ArticleDetail scenarios must be named and unique');
        detailNames.add(result.scenario);
        positiveInteger(result.outputBytes, `${result.scenario}.outputBytes`);
        positiveInteger(result.contentBytes, `${result.scenario}.contentBytes`);
        nonNegativeNumber(result.tagCount, `${result.scenario}.tagCount`, { integer: true });
        invariant(result.wireParity === true, `${result.scenario} wire parity failed`);
        validateFrequency(result.encodeFrequency, result.scenario);
        const variants = indexVariants(result.variants, detailVariants, result.scenario, method);
        invariant(variants.get('legacy-list').managedTemporaryCollectionCount >= 2, `${result.scenario} legacy collection fact is missing`);
        const legacy = variants.get('legacy-list');
        const direct = variants.get('adaptive-detail');
        if (result.contentBytes >= 8 * 1024)
        {
            invariant(direct.managedTemporaryCollectionCount === 0, `${result.scenario} representative detail candidate must not allocate managed temporary collections`);
            invariant(direct.copyBytes === 0, `${result.scenario} representative detail candidate must remove the intermediate blob copy`);
            detailRepresentativeCount += 1;
            if (direct.allocatedBytesPerFrame <= legacy.allocatedBytesPerFrame * 0.80)
            {
                detailAllocationWins += 1;
            }
        }
        else
        {
            invariant(direct.managedTemporaryCollectionCount >= 2, `${result.scenario} small detail must retain the measured legacy path`);
        }
        if (withinSmallLatencyPolicy(direct.measured.p95Ms, legacy.measured.p95Ms))
        {
            detailP95WithinPolicy += 1;
        }
    }
    const detailRecommendation = summary.recommendation?.articleDetail;
    invariant(detailRecommendation?.detailRepresentativeCount === detailRepresentativeCount, 'ArticleDetail representative count is not evidence-derived');
    invariant(detailRecommendation.detailAllocationWins === detailAllocationWins, 'ArticleDetail allocation wins are not evidence-derived');
    invariant(detailRecommendation.detailP95WithinPolicy === detailP95WithinPolicy, 'ArticleDetail p95 wins are not evidence-derived');
    invariant(detailRecommendation.detailAllocationPolicyMet === (detailRepresentativeCount > 0 && detailAllocationWins === detailRepresentativeCount), 'ArticleDetail allocation conclusion is inconsistent');
    invariant(detailRecommendation.detailLatencyPolicyMet === (detailP95WithinPolicy === summary.articleDetailResults.length), 'ArticleDetail latency conclusion is inconsistent');
    invariant(detailRecommendation.selected === 'adaptive-detail', 'ArticleDetail evidence did not select the implemented adaptive candidate');

    invariant(Array.isArray(summary.auditResults), 'codec audit results must be an array');
    const seenAudits = new Set();
    for (const result of summary.auditResults)
    {
        invariant(auditedCodecs.has(result?.codec), `unexpected audited codec ${result?.codec}`);
        seenAudits.add(result.codec);
        positiveInteger(result.outputBytes, `${result.codec}.outputBytes`);
        nonNegativeNumber(result.allocatedBytesPerFrame, `${result.codec}.allocatedBytesPerFrame`, { integer: true });
        nonNegativeNumber(result.allocatedBytesPerItem, `${result.codec}.allocatedBytesPerItem`, { integer: true });
        invariant(result.decision === 'keep-current-baseline-only', `${result.codec} must retain a baseline-only decision`);
        invariant(typeof result.decisionReason === 'string' && result.decisionReason.length > 0, `${result.codec} decision reason is missing`);
        validateFrequency(result.encodeFrequency, result.codec);
    }
    for (const codec of auditedCodecs)
    {
        invariant(seenAudits.has(codec), `codec audit is missing ${codec}`);
    }
    invariant(summary.runtimeClaim?.affectedPath === 'cache miss and background rebuild encoding', 'runtime impact path is misstated');
    invariant(summary.runtimeClaim.cacheHitQpsClaimed === false, 'evidence must not claim cache-hit QPS improvement');
    invariant(summary.runtimeClaim.productionFrequencyMetric === 'fsus.cache.owned_frame.build.count', 'runtime frequency metric is missing');
    return summary;
}

function main(argv)
{
    const file = path.resolve(argv[2] ?? '.tmp/perf/pod-binary-codec-batch/summary.json');
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
    validatePodBinaryCodecBatchEvidence(summary);
    console.log(`[pod-binary-codec-batch-evidence] validated ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
{
    main(process.argv);
}
