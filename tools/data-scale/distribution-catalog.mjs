import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalDigest, deepFreeze, exactKeys } from './distribution-contract.mjs';

const { validateTemporalShapeCatalog } = await import(new URL('../test/temporal-shape-catalog.mjs', import.meta.url));
const { validateMediaShapeCatalog } = await import(new URL('../test-fixtures/media-shape-catalog.mjs', import.meta.url));
const { shapeContentDigest } = await import(new URL('../testing/content-shape-catalog.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const authorityPaths = Object.freeze({
    content: 'config/testing/content-shape-catalog.json',
    media: 'config/testing/media-shape-catalog.json',
    temporal: 'config/testing/temporal-shape-catalog.json',
    article: 'src/backend/Services/Fixtures/DataScale/ArticleScalePlan.cs',
    variants: 'config/testing/fixture-variant-catalog.json'
});

export const distributionScenarioIds = deepFreeze([
    'uniform-baseline', 'zipf-hot-content', 'taxonomy-long-tail', 'comment-thread-skew',
    'temporal-burst', 'multilingual-content', 'lifecycle-mixed', 'media-mixed'
]);

const prng = deepFreeze({ algorithm: 'sha256-counter-u53', version: '1' });
const dimensions = Object.freeze([
    'taxonomy', 'hotness', 'thread', 'content', 'locale', 'moderation',
    'media', 'time', 'lifecycle', 'id', 'deleteGap'
]);

function digestContent(value)
{
    const content = { ...value };
    delete content.contentDigest;
    return canonicalDigest(content);
}

/** Catalog changes, including changed authority snapshots, invalidate every consumer identity. */
export function distributionCatalogDigest(catalog)
{
    return digestContent(catalog);
}

export function distributionScenarioDigest(scenario)
{
    return digestContent(scenario);
}

function seal(value)
{
    return { ...value, contentDigest: digestContent(value) };
}

function loadAuthorities(root)
{
    const documents = {};
    const references = {};
    for (const [id, relativePath] of Object.entries(authorityPaths))
    {
        const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
        const document = id === 'article' ? source : JSON.parse(source);
        if (id === 'content')
        {
            for (const shape of document.shapes)
            {
                requireCondition(shape.contentDigest === shapeContentDigest(shape),
                    `distribution_content_authority_invalid:${shape.id}`);
            }
        }
        documents[id] = document;
        references[id] = {
            path: relativePath,
            schema: id === 'article' ? 'fsusblog.article-scale-plan.v1' : document.schema,
            sourceDigest: canonicalDigest({ source })
        };
    }
    return { documents, references };
}

function weightedShape(authorityRef, rows, weightFor, source = 'shapes')
{
    const raw = rows.map((row) => ({
        id: row.id,
        weight: weightFor(row),
        contentDigest: row.contentDigest ?? canonicalDigest(row)
    }));
    const total = raw.reduce((sum, row) => sum + row.weight, 0);
    return {
        status: 'specified', authorityRef, source,
        weights: raw.map((row) => ({ ...row, weight: row.weight / total }))
    };
}

function blockedShape(authorityRef, requiredContracts)
{
    return { status: 'blocked', authorityRef, requiredContracts };
}

function metric(metricId, dimension, interval, authorityRef = null, algorithmVersion = 'exact-count-ratio-v1')
{
    return {
        metricId, dimension, algorithmVersion,
        sampleSet: dimension === 'thread' || dimension === 'moderation' ? 'current-comment-graph' : 'current-article-graph',
        minSampleCount: 100_000,
        interval,
        status: interval === null ? 'blocked' : 'specified',
        authorityRef
    };
}

function proportionInterval(target)
{
    return { min: Math.max(0, target - 0.01), max: Math.min(1, target + 0.01) };
}

function createScenarios(documents)
{
    const positiveContent = documents.content.shapes.filter((row) => row.eligibility === 'positive');
    const positiveScripts = documents.content.scriptClasses.filter((row) => row.eligibility === 'positive');
    const positiveMedia = documents.media.shapes.filter((row) => row.validityClass === 'canonical-positive');
    const temporalIds = new Set(['recent-history', 'same-timestamp-tie', 'scheduled-before', 'scheduled-at', 'scheduled-after']);
    const temporal = documents.temporal.shapes.filter((row) => temporalIds.has(row.id));
    // Enum names are source references only. Allocation weights require the original owner export.
    const variantMatch = documents.article.match(/public enum ArticleScaleVariant\s*\{([^}]+)\}/u);
    if (!variantMatch)
    {
        throw new Error('distribution_article_variant_authority_missing');
    }
    const variants = variantMatch[1].split(',').map((value) => value.trim()).filter(Boolean);
    const lifecycle = {
        status: 'blocked', authorityRef: 'article', source: 'ArticleScaleVariant',
        variantRefs: variants.map((id) => ({ id, contentDigest: canonicalDigest({ id }) }))
    };

    return distributionScenarioIds.map((id, index) =>
    {
        const uniform = id === 'uniform-baseline';
        const multilingual = id === 'multilingual-content';
        const mediaMixed = id === 'media-mixed';
        const burst = id === 'temporal-burst';
        const content = weightedShape('content', positiveContent,
            (row) => uniform || multilingual ? 1 : row.id === 'script.latin-basic' ? 20 : 1);
        const locale = weightedShape('content', positiveScripts,
            (row) => uniform || multilingual ? 1 : row.id === 'latin-basic' ? 20 : 1, 'scriptClasses');
        const media = weightedShape('media', positiveMedia,
            (row) => uniform || mediaMixed ? 1 : row.id === 'no-cover' ? 20 : 1);
        // Preserve the real no-cover reference without overriding its missing scale applicability.
        if (positiveMedia.some((row) => !row.consumerClasses.includes('scale')))
        {
            media.status = 'blocked';
        }
        const time = weightedShape('temporal', temporal,
            (row) => uniform ? 1 : row.id === (burst ? 'same-timestamp-tie' : 'recent-history') ? 20 : 1);
        const shapes = {
            taxonomy: blockedShape('article-taxonomy-role-export', [
                'stable-category-tag-role-ids', 'large-small-empty-category-buckets', 'tag-long-tail', 'multi-tag-and-zero-tag'
            ]),
            hotness: {
                status: 'specified', authorityRef: 'distribution-catalog',
                family: uniform ? 'uniform-control' : 'zipf', exponent: uniform ? 0 : 1.1,
                rankPopulation: 100_000, observation: 'nonnegative-production-hotness'
            },
            thread: blockedShape('comment-scale-plan', [
                'zero-comment', 'small-threads', 'wide-roots', 'depth-5', 'depth-10',
                'max-depth-boundary', 'deleted-root-visible-descendants', 'child-limit-boundary'
            ]),
            content, locale,
            moderation: blockedShape('comment-scale-plan', ['legal-moderation-variants-and-timelines']),
            media, time, lifecycle,
            id: blockedShape('production-id-plan-export', ['native-allocator-plan', 'generation-order', 'gaps', 'out-of-order']),
            deleteGap: blockedShape('production-id-plan-export', ['deleted-identity-gap-contract'])
        };
        const statistics = [
            metric('hotness.gini', 'hotness', uniform ? { min: 0, max: 0.02 } : { min: 0.85, max: 0.99 }, null, 'weighted-frequency-v1'),
            metric('hotness.top-1-percent-share', 'hotness', uniform ? { min: 0.009, max: 0.011 } : { min: 0.6, max: 0.9 }, null, 'weighted-frequency-v1'),
            metric('hotness.top-10-percent-share', 'hotness', uniform ? { min: 0.099, max: 0.101 } : { min: 0.8, max: 0.99 }, null, 'weighted-frequency-v1'),
            ...['p50', 'p90', 'p99'].map((name) => metric(`hotness.${name}`, 'hotness', null, 'hotness-observation-export', 'nearest-rank-v1')),
            ...['category-cardinality', 'tag-cardinality', 'empty-category-share', 'large-category-share',
                'small-category-share', 'tag-tail-share', 'multi-tag-share', 'zero-tag-share']
                .map((name) => metric(`taxonomy.${name}`, 'taxonomy', null, 'article-taxonomy-role-export')),
            ...['zero-comment-share', 'small-thread-share', 'wide-root-share', 'depth-5-share', 'depth-10-share',
                'max-depth-boundary-share', 'child-limit-boundary-share', 'deleted-root-descendant-share']
                .map((name) => metric(`thread.${name}`, 'thread', null, 'comment-scale-plan')),
            metric('moderation.variant-share', 'moderation', null, 'comment-scale-plan'),
            metric('id.gap-share', 'id', null, 'production-id-plan-export'),
            metric('id.out-of-order-share', 'id', null, 'production-id-plan-export'),
            metric('delete-gap.share', 'deleteGap', null, 'production-id-plan-export')
        ];
        for (const [dimension, prefix] of [['content', 'shape'], ['locale', 'script'], ['media', 'shape'], ['time', 'shape']])
        {
            for (const row of shapes[dimension].weights)
            {
                statistics.push(metric(`${dimension}.${prefix}.${row.id}.share`, dimension,
                    proportionInterval(row.weight), shapes[dimension].authorityRef));
            }
        }
        statistics.push(...lifecycle.variantRefs.map((row) => metric(`lifecycle.variant.${row.id}.share`,
            'lifecycle', null, 'article-lifecycle-distribution-export')));
        return seal({
            id, fixedSeed: `fsusblog-distribution-v1-${index + 1}`, prng,
            counts: {
                article: { authorityRef: 'article', tier: 'scale-l-nightly', count: 100_000 },
                comment: { authorityRef: 'comment-scale-plan', count: null, status: 'blocked' }
            },
            releaseEvidenceEligible: !uniform,
            shapes, expectedStatistics: statistics
        });
    });
}

const loaded = loadAuthorities(repositoryRoot);

/** The single catalog is source-only WIP; unresolved contracts never qualify a scenario. */
export const distributionCatalog = deepFreeze(seal({
    schema: 'fsusblog.distribution-catalog.v1',
    generationVersion: 'distribution-source-contract-v1',
    prng,
    authorities: loaded.references,
    requiredCapabilities: [
        'comment-scale-plan', 'article-taxonomy-role-export', 'production-id-plan-export',
        'hotness-observation-export', 'compiled-shape-producer-identities', 'million-article-tier',
        'media-no-cover-scale-applicability', 'article-lifecycle-distribution-export'
    ],
    requestedScales: [
        { count: 100_000, authorityRef: 'article', tier: 'scale-l-nightly', status: 'source-defined' },
        { count: 1_000_000, authorityRef: 'article', tier: null, status: 'blocked' }
    ],
    scenarios: createScenarios(loaded.documents)
}));

function requireCondition(condition, code)
{
    if (!condition)
    {
        throw new Error(code);
    }
}

function validateWeightedShape(shape, documents, dimension)
{
    exactKeys(shape, ['status', 'authorityRef', 'source', 'weights'], `distribution_${dimension}`);
    const expectedStatus = dimension === 'media'
        && documents.media.shapes.some((row) => row.validityClass === 'canonical-positive'
            && !row.consumerClasses.includes('scale')) ? 'blocked' : 'specified';
    requireCondition(shape.status === expectedStatus, `distribution_${dimension}_status`);
    const document = documents[shape.authorityRef];
    const rows = document?.[shape.source];
    requireCondition(Array.isArray(rows) && Array.isArray(shape.weights) && shape.weights.length > 0,
        `distribution_${dimension}_authority`);
    const seen = new Set();
    let total = 0;
    for (const weight of shape.weights)
    {
        exactKeys(weight, ['id', 'weight', 'contentDigest'], `distribution_${dimension}_weight`);
        const reference = rows.find((row) => row.id === weight.id);
        requireCondition(reference && !seen.has(weight.id), `distribution_${dimension}_reference`);
        requireCondition((reference.contentDigest ?? canonicalDigest(reference)) === weight.contentDigest,
            `distribution_${dimension}_reference_digest`);
        requireCondition(Number.isFinite(weight.weight) && weight.weight > 0 && weight.weight <= 1,
            `distribution_${dimension}_weight_invalid`);
        seen.add(weight.id);
        total += weight.weight;
    }
    requireCondition(Math.abs(total - 1) <= 1e-12, `distribution_${dimension}_weight_total`);
}

function validateScenario(scenario, documents)
{
    exactKeys(scenario, ['id', 'fixedSeed', 'prng', 'counts', 'releaseEvidenceEligible', 'shapes', 'expectedStatistics', 'contentDigest'], 'distribution_scenario');
    requireCondition(scenario.contentDigest === distributionScenarioDigest(scenario), 'distribution_scenario_tampered');
    exactKeys(scenario.prng, ['algorithm', 'version'], 'distribution_prng');
    requireCondition(canonicalDigest(scenario.prng) === canonicalDigest(prng), 'distribution_prng_unsupported');
    requireCondition(typeof scenario.fixedSeed === 'string' && scenario.fixedSeed.length > 0, 'distribution_seed_missing');
    requireCondition(scenario.releaseEvidenceEligible === (scenario.id !== 'uniform-baseline'), 'distribution_uniform_release_policy');
    exactKeys(scenario.counts, ['article', 'comment'], 'distribution_counts');
    exactKeys(scenario.counts.article, ['authorityRef', 'tier', 'count'], 'distribution_article_count');
    exactKeys(scenario.counts.comment, ['authorityRef', 'count', 'status'], 'distribution_comment_count');
    requireCondition(scenario.counts.article.count === 100_000
        && scenario.counts.article.tier === 'scale-l-nightly'
        && scenario.counts.article.authorityRef === 'article'
        && /\["scale-l-nightly"\]\s*=\s*100_000/u.test(documents.article), 'distribution_article_count_authority');
    requireCondition(scenario.counts.comment.count === null && scenario.counts.comment.status === 'blocked', 'distribution_comment_count_unresolved');
    exactKeys(scenario.shapes, dimensions, 'distribution_dimensions');
    for (const dimension of ['content', 'locale', 'media', 'time'])
    {
        validateWeightedShape(scenario.shapes[dimension], documents, dimension);
    }
    const lifecycle = scenario.shapes.lifecycle;
    exactKeys(lifecycle, ['status', 'authorityRef', 'source', 'variantRefs'], 'distribution_lifecycle');
    requireCondition(lifecycle.status === 'blocked' && lifecycle.authorityRef === 'article'
        && lifecycle.source === 'ArticleScaleVariant', 'distribution_lifecycle_unresolved');
    const expectedLifecycle = distributionCatalog.scenarios[0].shapes.lifecycle;
    requireCondition(canonicalDigest(lifecycle.variantRefs) === canonicalDigest(expectedLifecycle.variantRefs),
        'distribution_lifecycle_reference');
    for (const dimension of ['taxonomy', 'thread', 'moderation', 'id', 'deleteGap'])
    {
        const shape = scenario.shapes[dimension];
        exactKeys(shape, ['status', 'authorityRef', 'requiredContracts'], `distribution_${dimension}`);
        requireCondition(shape.status === 'blocked' && Array.isArray(shape.requiredContracts)
            && shape.requiredContracts.length > 0, `distribution_${dimension}_unresolved`);
    }
    const hotness = scenario.shapes.hotness;
    exactKeys(hotness, ['status', 'authorityRef', 'family', 'exponent', 'rankPopulation', 'observation'], 'distribution_hotness');
    requireCondition(hotness.family === (scenario.id === 'uniform-baseline' ? 'uniform-control' : 'zipf')
        && hotness.exponent === (scenario.id === 'uniform-baseline' ? 0 : 1.1), 'distribution_hotness_parameters');
    requireCondition(Array.isArray(scenario.expectedStatistics) && scenario.expectedStatistics.length > 0, 'distribution_metrics_missing');
    const seen = new Set();
    for (const statistic of scenario.expectedStatistics)
    {
        exactKeys(statistic, ['metricId', 'dimension', 'algorithmVersion', 'sampleSet', 'minSampleCount', 'interval', 'status', 'authorityRef'], 'distribution_metric');
        requireCondition(typeof statistic.metricId === 'string' && !seen.has(statistic.metricId), 'distribution_metric_duplicate');
        seen.add(statistic.metricId);
        requireCondition(dimensions.includes(statistic.dimension)
            && ['exact-count-ratio-v1', 'weighted-frequency-v1', 'nearest-rank-v1'].includes(statistic.algorithmVersion)
            && Number.isSafeInteger(statistic.minSampleCount) && statistic.minSampleCount > 0
            && typeof statistic.sampleSet === 'string' && statistic.sampleSet.length > 0, 'distribution_metric_sample_algorithm');
        if (statistic.status === 'blocked')
        {
            requireCondition(statistic.interval === null && typeof statistic.authorityRef === 'string', 'distribution_metric_unsupported_zero');
        }
        else
        {
            exactKeys(statistic.interval, ['min', 'max'], 'distribution_interval');
            requireCondition(statistic.status === 'specified' && Number.isFinite(statistic.interval.min)
                && Number.isFinite(statistic.interval.max) && statistic.interval.min >= 0
                && statistic.interval.min <= statistic.interval.max, 'distribution_interval_invalid');
        }
    }
    const expected = distributionCatalog.scenarios.find((row) => row.id === scenario.id);
    requireCondition(expected && expected.expectedStatistics.length === seen.size
        && expected.expectedStatistics.every((row) => seen.has(row.metricId)), 'distribution_metric_coverage');
}

/** Independent read-only admission checks exact current sources and keeps unavailable owners blocked. */
export function validateDistributionCatalog(catalog = distributionCatalog, { root = repositoryRoot } = {})
{
    const errors = [];
    const blockers = [];
    let catalogDigest = null;
    try
    {
        exactKeys(catalog, ['schema', 'generationVersion', 'prng', 'authorities', 'requiredCapabilities', 'requestedScales', 'scenarios', 'contentDigest'], 'distribution_catalog');
        catalogDigest = distributionCatalogDigest(catalog);
        requireCondition(catalog.contentDigest === catalogDigest, 'distribution_catalog_tampered');
        requireCondition(catalog.schema === distributionCatalog.schema, 'distribution_catalog_schema');
        const current = loadAuthorities(root);
        const mediaErrors = validateMediaShapeCatalog(current.documents.media);
        requireCondition(mediaErrors.length === 0, `distribution_media_authority_invalid:${mediaErrors.join('|')}`);
        validateTemporalShapeCatalog(current.documents.temporal);
        exactKeys(catalog.authorities, Object.keys(authorityPaths), 'distribution_authorities');
        for (const id of Object.keys(authorityPaths))
        {
            exactKeys(catalog.authorities[id], ['path', 'schema', 'sourceDigest'], 'distribution_authority');
            requireCondition(canonicalDigest(catalog.authorities[id]) === canonicalDigest(current.references[id]),
                `distribution_authority_stale:${id}`);
        }
        requireCondition(Array.isArray(catalog.scenarios) && catalog.scenarios.length === distributionScenarioIds.length, 'distribution_scenario_completeness');
        const seen = new Set();
        for (const scenario of catalog.scenarios)
        {
            requireCondition(distributionScenarioIds.includes(scenario.id) && !seen.has(scenario.id), 'distribution_scenario_unknown_or_duplicate');
            seen.add(scenario.id);
            validateScenario(scenario, current.documents);
        }
        // The only current authority is this versioned catalog. Resealing a private table cannot admit it.
        requireCondition(catalogDigest === distributionCatalog.contentDigest, 'distribution_unregistered_parameters');
        blockers.push(...catalog.requiredCapabilities.map((id) => `distribution_authority_unavailable:${id}`));
    }
    catch (error)
    {
        errors.push(error.message);
    }
    return deepFreeze({
        status: errors.length > 0 ? 'invalid' : blockers.length > 0 ? 'blocked' : 'valid',
        valid: errors.length === 0 && blockers.length === 0,
        errors, blockers, catalogDigest
    });
}
