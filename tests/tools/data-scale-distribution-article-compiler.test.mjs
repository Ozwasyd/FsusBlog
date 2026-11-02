import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { canonicalDigest } = await import(new URL('../../tools/data-scale/distribution-contract.mjs', import.meta.url));
const { distributionCatalog, distributionScenarioIds } = await import(new URL('../../tools/data-scale/distribution-catalog.mjs', import.meta.url));
const { readArticleBulkWriterSourceReference } = await import(new URL('../../tools/data-scale/distribution-writer-adapter.mjs', import.meta.url));
const {
    createDistributionArticleCompiler,
    createDistributionArticleAssignmentShards,
    verifyDistributionArticleAssignmentShards
} = await import(new URL('../../tools/data-scale/distribution-assignment.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceReference = readArticleBulkWriterSourceReference({ repositoryRoot: root,
    sourceCommit: '21a20129b3127fdcfb6f34bff7f80b1ef8b5f239' });
const content = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/content-shape-catalog.json'), 'utf8'));
const unitDigest = canonicalDigest({ validityClass: 'unit-only-not-original-plan-validation' });
const reference = (schema, shapeId) => ({ schema, authorityId: 'unit-only', shapeId, contentDigest: unitDigest });
const input = {
    schema: 'fsusblog.distribution-article-plan-compiler-input.v1', purpose: 'owner-plan-reference-projection-only',
    ownerPlanDigest: unitDigest, scaleTier: 'scale-l-nightly', namespace: 'compiler-unit-only',
    articleCount: 100_000, articleOrdinalBase: 31,
    // Deliberate unit quotas, not the original lifecycle allocation or production inventory.
    variantAllocations: distributionCatalog.scenarios[0].shapes.lifecycle.variantRefs.map((row, index) =>
        ({ variant: row.id, count: index === 0 ? 99_996 : 1 })),
    artifactBindings: {
        temporal: reference('fsusblog.resolved-temporal-roles.v1', 'unit-temporal'),
        distribution: reference('fsusblog.fixture-variant-catalog.v1', 'deterministic-bulk'),
        content: content.shapes.filter((shape) => shape.eligibility === 'positive').map((shape) =>
            ({ schema: content.schema, authorityId: 'unit-only-content', shapeId: shape.id, contentDigest: shape.contentDigest })),
        media: [reference('fsusblog.media-shape-catalog.v1', 'unit-media')],
        taxonomy: [reference('fsusblog.fixture-variant-catalog.v1', 'taxonomy')]
    }
};
const options = (value = input, scenarioId = 'multilingual-content') => ({
    scenarioId, sourceReference, expectedInputDigest: canonicalDigest(value), expectedOwnerPlanDigest: value.ownerPlanDigest
});
const compiler = () => createDistributionArticleCompiler(input, options());
const firstShard = (candidate, shardSize = 1000) => createDistributionArticleAssignmentShards(candidate, { shardSize }).next().value;
const seal = (value) =>
{
    const { contentDigest: ignored, ...body } = value;
    assert.ok(ignored);
    return { ...body, contentDigest: canonicalDigest(body) };
};

test('all eight scenarios compile paired original body/script references with explicit partial identity', () =>
{
    const digests = new Set();
    for (const scenarioId of distributionScenarioIds)
    {
        const candidate = createDistributionArticleCompiler(input, options(input, scenarioId));
        const repeated = createDistributionArticleCompiler(input, options(input, scenarioId));
        assert.deepEqual(firstShard(candidate), firstShard(repeated));
        digests.add(candidate.metadata.contentDigest);
        assert.deepEqual(candidate.metadata.assignedDimensions, ['lifecycle', 'content', 'locale']);
        assert.equal(candidate.metadata.completeAssignmentPlan, false);
        assert.equal(candidate.metadata.executionEligible, false);
        assert.equal(candidate.metadata.releaseEvidenceEligible, false);
        assert.equal(candidate.metadata.commentCount, null);
        assert.ok(candidate.metadata.unresolvedDimensions.includes('taxonomy'));
        for (const assignment of firstShard(candidate).assignments)
        {
            const shape = content.shapes.find((row) => row.id === assignment.contentReference.shapeId);
            assert.deepEqual(shape.scriptClasses, [assignment.scriptReference.id]);
            assert.equal(shape.contentDigest, assignment.contentReference.contentDigest);
            assert.equal(assignment.bodyGenerationRequest.fieldId, 'article.body');
            assert.equal(assignment.bodyGenerationRequest.shapeId, shape.id);
            assert.equal(assignment.bodyGenerationRequest.generationVersion, content.generationVersion);
            assert.equal(assignment.bodyGenerationRequest.boundaryCaseId, null);
        }
    }
    assert.equal(digests.size, 8);
});

test('100k partial assignments replay exact nonuniform quotas with complete bounded ordinal coverage', () =>
{
    const candidate = compiler();
    let largest = 0;
    let serializedLargest = 0;
    let ordinal = input.articleOrdinalBase;
    const quotas = new Map(input.variantAllocations.map((allocation) => [allocation.variant, 0]));
    function* checked()
    {
        for (const shard of createDistributionArticleAssignmentShards(candidate, { shardSize: 1000 }))
        {
            largest = Math.max(largest, shard.assignments.length);
            serializedLargest = Math.max(serializedLargest, Buffer.byteLength(JSON.stringify(shard)));
            for (const assignment of shard.assignments)
            {
                assert.equal(assignment.articleOrdinal, ordinal++);
                quotas.set(assignment.lifecycleVariant, quotas.get(assignment.lifecycleVariant) + 1);
            }
            yield shard;
        }
    }
    const replay = verifyDistributionArticleAssignmentShards(candidate, { shardSize: 1000 }, checked());
    assert.equal(replay.articleCount, 100_000);
    assert.equal(replay.shardCount, 100);
    assert.equal(largest, 1000);
    assert.ok(serializedLargest < 1024 * 1024);
    for (const allocation of input.variantAllocations)
    {
        assert.equal(quotas.get(allocation.variant), allocation.count);
    }
    assert.equal(replay.completeAssignmentPlan, false);
    assert.equal(replay.releaseEvidenceEligible, false);
});

test('assignment identity and rows remain shard-size independent and defensive snapshots resist mutation', () =>
{
    const candidate = compiler();
    assert.deepEqual(firstShard(candidate, 7).assignments, firstShard(candidate, 1000).assignments.slice(0, 7));
    const mutable = structuredClone(input);
    const snapshot = createDistributionArticleCompiler(mutable, options(mutable));
    mutable.variantAllocations[0].count = 0;
    mutable.artifactBindings.content[0].shapeId = 'private-shape';
    assert.deepEqual(firstShard(snapshot), firstShard(candidate));
    assert.ok(Object.isFrozen(firstShard(snapshot).assignments[0].bodyGenerationRequest));
});

test('changed original input identity invalidates assignments without reusing a latest plan or source', () =>
{
    const original = compiler();
    for (const changed of [
        { ...input, namespace: 'changed-unit-namespace' },
        { ...input, ownerPlanDigest: canonicalDigest({ changed: 'unit-owner-plan' }) },
        { ...input, articleOrdinalBase: 50 }
    ])
    {
        const candidate = createDistributionArticleCompiler(changed, options(changed));
        assert.notEqual(candidate.metadata.contentDigest, original.metadata.contentDigest);
        assert.notDeepEqual(firstShard(candidate).assignments, firstShard(original).assignments);
        assert.throws(() => createDistributionArticleCompiler(changed, options()), /identity_mismatch/u);
    }
    const previousSource = readArticleBulkWriterSourceReference({ repositoryRoot: root,
        sourceCommit: '8f171ad68df48d139fb31f02d1f3e80dde5330ba' });
    const previous = createDistributionArticleCompiler(input, { ...options(), sourceReference: previousSource });
    assert.notEqual(previous.metadata.contentDigest, original.metadata.contentDigest);
});

test('unknown counts, incomplete quotas, unsupported variants and private parameters fail before output', () =>
{
    const mutations = [
        (value) =>
        {
            value.articleCount = null;
        },
        (value) =>
        {
            value.articleCount = 1_000_000;
        },
        (value) =>
        {
            value.scaleTier = 'private-million-tier';
        },
        (value) =>
        {
            value.articleOrdinalBase = -1;
        },
        (value) =>
        {
            value.variantAllocations.pop();
        },
        (value) =>
        {
            value.variantAllocations[0].count -= 1;
        },
        (value) =>
        {
            value.variantAllocations[0].variant = 'spam';
        },
        (value) =>
        {
            value.variantAllocations[1].variant = value.variantAllocations[0].variant;
        },
        (value) =>
        {
            value.variantAllocations[0].count = null;
        },
        (value) =>
        {
            value.commentCount = 0;
        },
        (value) =>
        {
            value.weights = [1];
        },
        (value) =>
        {
            value.seed = 'private-seed';
        },
        (value) =>
        {
            value.completeAssignmentPlan = true;
        }
    ];
    for (const mutate of mutations)
    {
        const changed = structuredClone(input);
        mutate(changed);
        assert.throws(() => createDistributionArticleCompiler(changed, options(changed)));
    }
    assert.throws(() => createDistributionArticleCompiler(input, { ...options(), sourceReference: structuredClone(sourceReference) }),
        /source_reference_not_observed/u);
    assert.throws(() => createDistributionArticleCompiler(input, { ...options(), weights: [1] }), /fields_invalid/u);
});

test('missing, duplicate, stale and negative content refs cannot be filtered or renormalized into output', () =>
{
    for (const mutate of [
        (value) => value.artifactBindings.content.pop(),
        (value) => value.artifactBindings.content.push(value.artifactBindings.content[0]),
        (value) => value.artifactBindings.content.push(reference(content.schema, 'private-unknown-content')),
        (value) => value.artifactBindings.content.push(reference(content.schema, 'negative-bidi')),
        (value) =>
        {
            value.artifactBindings.content[0].contentDigest = unitDigest;
        },
        (value) =>
        {
            value.artifactBindings.content[0].shapeId = 'negative-bidi';
        }
    ])
    {
        const changed = structuredClone(input);
        mutate(changed);
        assert.throws(() => createDistributionArticleCompiler(changed, options(changed)), /content_binding_missing/u);
    }
});

test('all original artifact groups refuse unknown schemas and oversized opaque input', () =>
{
    for (const group of ['temporal', 'distribution', 'content', 'media', 'taxonomy'])
    {
        for (const schema of [null, {}, 'private-schema'])
        {
            const changed = structuredClone(input);
            const reference = Array.isArray(changed.artifactBindings[group])
                ? changed.artifactBindings[group][0] : changed.artifactBindings[group];
            reference.schema = schema;
            assert.throws(() => createDistributionArticleCompiler(changed, options(changed)), /artifact_schema/u);
        }
    }
    const changed = structuredClone(input);
    changed.artifactBindings.taxonomy[0].authorityId = 'x'.repeat(256 * 1024);
    assert.throws(() => createDistributionArticleCompiler(changed, options(changed)), /input_bound/u);
});

test('portable gap routing retains precisely the 28 unresolved metric requirements and current supplied capabilities', () =>
{
    const routing = JSON.parse(fs.readFileSync(path.join(root,
        'artifacts/change-contract/data-scale-distribution-remaining-metric-requirements.json'), 'utf8'));
    const expected = distributionCatalog.scenarios[0].expectedStatistics.filter((metric) => metric.interval === null)
        .map((metric) => metric.metricId);
    assert.deepEqual(routing.allUnresolvedMetricIds, expected);
    assert.equal(routing.metricCount, 28);
    assert.equal(routing.catalogDigest, distributionCatalog.contentDigest);
    assert.equal(routing.suppliedWriterSource, sourceReference.sourceCommit);
    for (const group of routing.groups)
    {
        assert.ok(group.implementationStatus.length > 0);
        assert.ok(group.requiredExportFields.length > 0);
        assert.ok(group.contractDecisions.length > 0);
    }
});

test('resealed assignment, shape, status, ordinal and shard tamper fails exact replay', () =>
{
    const candidate = compiler();
    for (const mutate of [
        (shard) =>
        {
            shard.assignments[0].articleOrdinal += 1;
        },
        (shard) =>
        {
            shard.assignments[0].lifecycleVariant = 'spam';
        },
        (shard) =>
        {
            shard.assignments[0].contentReference.shapeId = 'private-shape';
        },
        (shard) =>
        {
            shard.assignments[0].scriptReference.id = 'private-script';
        },
        (shard) =>
        {
            shard.assignments[0].bodyGenerationRequest.fieldId = 'article.title';
        },
        (shard) =>
        {
            shard.assignments[0].bodyGenerationRequest.fixedSeed = 'private-seed';
        },
        (shard) =>
        {
            shard.assignments[0].nativeId = 1;
        },
        (shard) =>
        {
            shard.startOrdinal += 1;
        },
        (shard) =>
        {
            shard.compilerDigest = unitDigest;
        },
        (shard) =>
        {
            shard.assignments.pop();
        }
    ])
    {
        const changed = structuredClone(firstShard(candidate));
        mutate(changed);
        assert.throws(() => verifyDistributionArticleAssignmentShards(candidate, { shardSize: 1000 }, [seal(changed)]));
    }
    assert.throws(() => verifyDistributionArticleAssignmentShards(candidate, { shardSize: 1000 }, []), /assignment_count/u);
    for (const shardSize of [0, 1001, 1.5, null])
    {
        assert.throws(() => createDistributionArticleAssignmentShards(candidate, { shardSize }).next(), /shard_bound/u);
    }
    assert.throws(() => createDistributionArticleAssignmentShards(structuredClone(candidate), { shardSize: 1 }).next(),
        /capability_invalid/u);
});
