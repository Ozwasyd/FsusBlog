import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const {
    distributionCatalog,
    distributionCatalogDigest,
    distributionScenarioDigest,
    distributionScenarioIds,
    validateDistributionCatalog
} = await import(new URL('../../tools/data-scale/distribution-catalog.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function cloneCatalog()
{
    return structuredClone(distributionCatalog);
}

function reseal(catalog)
{
    for (const scenario of catalog.scenarios)
    {
        scenario.contentDigest = distributionScenarioDigest(scenario);
    }
    catalog.contentDigest = distributionCatalogDigest(catalog);
    return catalog;
}

function assertInvalid(catalog, code)
{
    const result = validateDistributionCatalog(catalog);
    assert.equal(result.status, 'invalid');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes(code)), JSON.stringify(result));
}

test('closed eight-scenario source catalog remains explicitly blocked by real missing authorities', () =>
{
    assert.deepEqual(distributionCatalog.scenarios.map((row) => row.id), distributionScenarioIds);
    const result = validateDistributionCatalog();
    assert.equal(result.status, 'blocked');
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors, []);
    for (const capability of distributionCatalog.requiredCapabilities)
    {
        assert.ok(result.blockers.includes(`distribution_authority_unavailable:${capability}`));
    }
    assert.equal(distributionCatalog.scenarios[0].releaseEvidenceEligible, false);
    assert.ok(distributionCatalog.scenarios.slice(1).every((row) => row.releaseEvidenceEligible));
    assert.ok(Object.isFrozen(distributionCatalog));
    assert.ok(Object.isFrozen(distributionCatalog.scenarios[0].shapes.content.weights));
});

test('digests bind scenario, seed, PRNG, parameters, statistics and current source references', () =>
{
    assert.equal(distributionCatalogDigest(distributionCatalog), distributionCatalog.contentDigest);
    for (const scenario of distributionCatalog.scenarios)
    {
        assert.equal(distributionScenarioDigest(scenario), scenario.contentDigest);
    }
    for (const mutate of [
        (catalog) =>
        {
            catalog.scenarios[1].fixedSeed += '-changed';
        },
        (catalog) =>
        {
            catalog.scenarios[1].prng.version = '2';
        },
        (catalog) =>
        {
            catalog.scenarios[1].shapes.hotness.exponent = 1.2;
        },
        (catalog) =>
        {
            catalog.scenarios[1].expectedStatistics[0].interval.min = 0.8;
        },
        (catalog) =>
        {
            catalog.authorities.content.sourceDigest = `sha256:${'0'.repeat(64)}`;
        }
    ])
    {
        const changed = cloneCatalog();
        mutate(changed);
        reseal(changed);
        assert.notEqual(changed.contentDigest, distributionCatalog.contentDigest);
        assert.equal(validateDistributionCatalog(changed).status, 'invalid');
    }
});

test('content and locale references use positive current shapes and scripts without a private language registry', () =>
{
    const catalog = JSON.parse(fs.readFileSync(path.join(repositoryRoot, distributionCatalog.authorities.content.path), 'utf8'));
    const positiveShapes = catalog.shapes.filter((row) => row.eligibility === 'positive');
    const positiveScripts = catalog.scriptClasses.filter((row) => row.eligibility === 'positive');
    for (const scenario of distributionCatalog.scenarios)
    {
        assert.deepEqual(scenario.shapes.content.weights.map((row) => row.id), positiveShapes.map((row) => row.id));
        assert.deepEqual(scenario.shapes.locale.weights.map((row) => row.id), positiveScripts.map((row) => row.id));
        for (const row of scenario.shapes.content.weights)
        {
            assert.equal(row.contentDigest, positiveShapes.find((shape) => shape.id === row.id).contentDigest);
        }
    }
    const multilingual = distributionCatalog.scenarios.find((row) => row.id === 'multilingual-content');
    assert.ok(multilingual.shapes.locale.weights.length > 1);
});

test('media preserves real no-cover and cover weights and refuses the missing scale applicability', () =>
{
    const mediaAuthority = JSON.parse(fs.readFileSync(path.join(repositoryRoot, distributionCatalog.authorities.media.path), 'utf8'));
    const noCover = mediaAuthority.shapes.find((row) => row.id === 'no-cover');
    assert.equal(noCover.consumerClasses.includes('scale'), false);
    for (const scenario of distributionCatalog.scenarios)
    {
        assert.equal(scenario.shapes.media.status, 'blocked');
        const weights = scenario.shapes.media.weights;
        assert.ok(weights.find((row) => row.id === 'no-cover').weight > 0);
        assert.ok(weights.some((row) => row.id !== 'no-cover' && row.weight > 0));
        assert.ok(weights.every((row) => mediaAuthority.shapes.some((shape) => shape.id === row.id
            && shape.validityClass === 'canonical-positive' && shape.contentDigest === row.contentDigest)));
    }
    const changed = cloneCatalog();
    changed.scenarios[0].shapes.media.status = 'specified';
    assertInvalid(reseal(changed), 'distribution_media_status');
});

test('temporal refs use relative authoritative recent, tie and scheduled shapes', () =>
{
    const scenario = distributionCatalog.scenarios.find((row) => row.id === 'temporal-burst');
    const time = scenario.shapes.time;
    assert.equal(time.authorityRef, 'temporal');
    const tie = time.weights.find((row) => row.id === 'same-timestamp-tie');
    assert.ok(tie.weight > 0.5);
    assert.ok(time.weights.some((row) => row.id === 'recent-history'));
    assert.ok(time.weights.some((row) => row.id === 'scheduled-at'));
    assert.equal(/\d{4}-\d{2}-\d{2}T/u.test(JSON.stringify(distributionCatalog)), false);
});

test('article lifecycle references current enum while allocation remains blocked on its owner export', () =>
{
    const source = fs.readFileSync(path.join(repositoryRoot, distributionCatalog.authorities.article.path), 'utf8');
    const variants = source.match(/public enum ArticleScaleVariant\s*\{([^}]+)\}/u)[1]
        .split(',').map((value) => value.trim()).filter(Boolean);
    for (const scenario of distributionCatalog.scenarios)
    {
        assert.deepEqual(scenario.shapes.lifecycle.variantRefs.map((row) => row.id), variants);
        assert.equal(scenario.shapes.lifecycle.status, 'blocked');
        assert.equal('weights' in scenario.shapes.lifecycle, false);
        assert.ok(scenario.expectedStatistics.filter((row) => row.dimension === 'lifecycle')
            .every((row) => row.status === 'blocked' && row.interval === null));
        assert.equal(scenario.counts.article.count, 100_000);
        assert.equal(scenario.counts.article.tier, 'scale-l-nightly');
        assert.equal(scenario.counts.comment.count, null);
    }
    assert.deepEqual(distributionCatalog.requestedScales[1], {
        count: 1_000_000, authorityRef: 'article', tier: null, status: 'blocked'
    });
});

test('every dimension has algorithm, sample and interval-or-explicit-blocker contracts', () =>
{
    for (const scenario of distributionCatalog.scenarios)
    {
        const covered = new Set(scenario.expectedStatistics.map((row) => row.dimension));
        assert.deepEqual([...covered].sort(), Object.keys(scenario.shapes).sort());
        for (const metric of scenario.expectedStatistics)
        {
            assert.ok(metric.algorithmVersion.length > 0);
            assert.ok(metric.sampleSet.length > 0);
            assert.equal(metric.minSampleCount, 100_000);
            if (metric.status === 'blocked')
            {
                assert.equal(metric.interval, null);
                assert.equal(typeof metric.authorityRef, 'string');
            }
            else
            {
                assert.ok(metric.interval.min <= metric.interval.max);
            }
        }
        const thread = scenario.shapes.thread.requiredContracts;
        for (const name of ['zero-comment', 'wide-roots', 'depth-5', 'depth-10', 'max-depth-boundary',
            'deleted-root-visible-descendants', 'child-limit-boundary'])
        {
            assert.ok(thread.includes(name));
        }
    }
});

test('non-uniform Zipf contracts constrain Gini and separate top 1% and 10% shares', () =>
{
    const scenario = distributionCatalog.scenarios.find((row) => row.id === 'zipf-hot-content');
    assert.equal(scenario.shapes.hotness.exponent, 1.1);
    const metrics = new Map(scenario.expectedStatistics.map((row) => [row.metricId, row]));
    assert.ok(metrics.get('hotness.gini').interval.min > 0.8);
    assert.ok(metrics.get('hotness.top-1-percent-share').interval.min > 0.5);
    assert.ok(metrics.get('hotness.top-10-percent-share').interval.min > 0.7);
    assert.equal(metrics.get('hotness.p99').status, 'blocked');
});

test('missing, duplicate and unknown scenarios fail closed', () =>
{
    const missing = cloneCatalog();
    missing.scenarios.pop();
    assertInvalid(reseal(missing), 'distribution_scenario_completeness');
    const duplicate = cloneCatalog();
    duplicate.scenarios[1] = structuredClone(duplicate.scenarios[0]);
    assertInvalid(reseal(duplicate), 'distribution_scenario_unknown_or_duplicate');
    const unknown = cloneCatalog();
    unknown.scenarios[1].id = 'zipf';
    assertInvalid(reseal(unknown), 'distribution_scenario_unknown_or_duplicate');
});

test('missing and duplicate metrics and unsupported-zero substitutions fail closed', () =>
{
    const missing = cloneCatalog();
    missing.scenarios[0].expectedStatistics.pop();
    assertInvalid(reseal(missing), 'distribution_metric_coverage');
    const duplicate = cloneCatalog();
    duplicate.scenarios[0].expectedStatistics.push(structuredClone(duplicate.scenarios[0].expectedStatistics[0]));
    assertInvalid(reseal(duplicate), 'distribution_metric_duplicate');
    const unsupported = cloneCatalog();
    unsupported.scenarios[0].expectedStatistics.find((row) => row.status === 'blocked').interval = { min: 0, max: 0 };
    assertInvalid(reseal(unsupported), 'distribution_metric_unsupported_zero');
});

test('uniform release eligibility and uniform-only replacement are rejected', () =>
{
    const eligible = cloneCatalog();
    eligible.scenarios[0].releaseEvidenceEligible = true;
    assertInvalid(reseal(eligible), 'distribution_uniform_release_policy');
    const only = cloneCatalog();
    only.scenarios = [only.scenarios[0]];
    assertInvalid(reseal(only), 'distribution_scenario_completeness');
});

for (const [name, mutate] of [
    ['SQL', (catalog) =>
    {
        catalog.sql = 'SELECT 1';
    }],
    ['query command', (catalog) =>
    {
        catalog.scenarios[0].queryCommand = 'query-runner';
    }],
    ['latency threshold', (catalog) =>
    {
        catalog.scenarios[0].expectedStatistics[0].latencyThresholdMs = 1;
    }],
    ['provider', (catalog) =>
    {
        catalog.scenarios[0].shapes.hotness.provider = 'postgres';
    }],
    ['modulo', (catalog) =>
    {
        catalog.scenarios[0].shapes.thread.modulo = 4;
    }],
    ['private seed', (catalog) =>
    {
        catalog.scenarios[0].privateSeed = 'private';
    }],
    ['fake URL', (catalog) =>
    {
        catalog.scenarios[0].shapes.media.weights[0].url = 'https://example.invalid/fake.webp';
    }],
    ['random fallback', (catalog) =>
    {
        catalog.scenarios[0].prng.fallback = 'Math.random';
    }],
    ['fake status', (catalog) =>
    {
        catalog.scenarios[0].shapes.moderation.states = ['spam'];
    }]
])
{
    test(`closed schema rejects ${name} even after digest resealing`, () =>
    {
        const changed = cloneCatalog();
        mutate(changed);
        assertInvalid(reseal(changed), 'fields_invalid');
    });
}

test('unknown shape, script, lifecycle variant and source digest fail closed', () =>
{
    for (const dimension of ['content', 'locale', 'media', 'time'])
    {
        const changed = cloneCatalog();
        changed.scenarios[0].shapes[dimension].weights[0].id = 'fictional';
        assertInvalid(reseal(changed), `distribution_${dimension}_reference`);
    }
    const lifecycle = cloneCatalog();
    lifecycle.scenarios[0].shapes.lifecycle.variantRefs[0].id = 'fictional';
    assertInvalid(reseal(lifecycle), 'distribution_lifecycle_reference');
    const digest = cloneCatalog();
    digest.scenarios[0].shapes.content.weights[0].contentDigest = `sha256:${'f'.repeat(64)}`;
    assertInvalid(reseal(digest), 'distribution_content_reference_digest');
});

test('changed private parameters cannot create a second accepted catalog', () =>
{
    const changed = cloneCatalog();
    changed.scenarios[0].fixedSeed = 'changed-seed';
    assertInvalid(reseal(changed), 'distribution_unregistered_parameters');
});

test('current content shapes with stale owner digests fail before catalog propagation', async () =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'distribution-stale-content-'));
    const { shapeContentDigest } = await import(new URL('../../tools/testing/content-shape-catalog.mjs', import.meta.url));
    try
    {
        const dependencies = [
            'tools/data-scale/distribution-catalog.mjs',
            'tools/data-scale/distribution-contract.mjs',
            'tools/test-fixtures/receipt/canonical.mjs',
            'tools/test-fixtures/media-shape-catalog.mjs',
            'tools/test/temporal-shape-catalog.mjs',
            'tools/test/temporal-context.mjs',
            'tools/test/temporal-context-contract.mjs',
            'tools/testing/content-shape-catalog.mjs',
            'config/testing/temporal-policy.json',
            ...Object.values(distributionCatalog.authorities).map((authority) => authority.path)
        ];
        for (const relativePath of dependencies)
        {
            const target = path.join(temporary, relativePath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(repositoryRoot, relativePath), target);
        }
        const contentPath = path.join(temporary, distributionCatalog.authorities.content.path);
        const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
        const shape = content.shapes.find((row) => row.id === 'script.combining');
        assert.equal(shape.target.ordinaryUtf16Units, 32);
        shape.target.ordinaryUtf16Units = 33;
        assert.notEqual(shape.contentDigest, shapeContentDigest(shape));
        fs.writeFileSync(contentPath, JSON.stringify(content));
        const inspected = validateDistributionCatalog(distributionCatalog, { root: temporary });
        assert.equal(inspected.status, 'invalid');
        assert.ok(inspected.errors.some((error) => error.includes('distribution_content_authority_invalid:script.combining')),
            JSON.stringify(inspected));
        await assert.rejects(import(pathToFileURL(path.join(temporary, 'tools/data-scale/distribution-catalog.mjs'))),
            /distribution_content_authority_invalid:script\.combining/u);
    }
    finally
    {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

test('old catalog snapshots fail against changed live authority bytes', () =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'distribution-catalog-authority-'));
    try
    {
        for (const authority of Object.values(distributionCatalog.authorities))
        {
            const target = path.join(temporary, authority.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(repositoryRoot, authority.path), target);
        }
        const contentPath = path.join(temporary, distributionCatalog.authorities.content.path);
        fs.appendFileSync(contentPath, '\n');
        const result = validateDistributionCatalog(distributionCatalog, { root: temporary });
        assert.equal(result.status, 'invalid');
        assert.ok(result.errors.includes('distribution_authority_stale:content'), JSON.stringify(result));
    }
    finally
    {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

test('caller capabilities cannot clear missing production authority', () =>
{
    const result = validateDistributionCatalog(distributionCatalog, {
        capabilities: { commentScalePlan: {}, nativeAllocator: {}, mediaScaleOverride: true }
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.valid, false);
    assert.ok(result.blockers.length >= 7);
});

test('catalog and scenario tampering cannot reuse their previous digest', () =>
{
    const changed = cloneCatalog();
    changed.scenarios[1].shapes.hotness.exponent = 1.2;
    assertInvalid(changed, 'distribution_catalog_tampered');
    changed.contentDigest = distributionCatalogDigest(changed);
    assertInvalid(changed, 'distribution_scenario_tampered');
});
