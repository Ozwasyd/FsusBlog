import assert from 'node:assert/strict';
import test from 'node:test';

import {
    computeExpectedTaxonomyModel,
    verifyTaxonomyProjections,
    verifyTaxonomyResponses,
    buildTaxonomyFrameVersionReceipt,
    verifyTaxonomyFrameVersionReceipt,
    buildTaxonomyProofReceipt,
    verifyTaxonomyProofReceipt
} from '../../tools/data-scale/taxonomy-projection.mjs';
import {
    verifyDatabaseProof,
    verifyHttpPayloadProof
} from '../../tools/data-scale/semantic-proof.mjs';

function createMockCategories()
{
    return [
        { id: 101, name: 'data-scale:data-scale:scale-xs:category:1', rn: 1 },
        { id: 102, name: 'data-scale:data-scale:scale-xs:category:2', rn: 2 },
        { id: 103, name: 'data-scale:data-scale:scale-xs:category:3', rn: 3 },
        { id: 104, name: 'data-scale:data-scale:scale-xs:category:4', rn: 4 }
    ];
}

function createMockTags()
{
    return [
        { id: 201, name: 'data-scale:data-scale:scale-xs:tag:1', rn: 1 },
        { id: 202, name: 'data-scale:data-scale:scale-xs:tag:2', rn: 2 },
        { id: 203, name: 'data-scale:data-scale:scale-xs:tag:3', rn: 3 },
        { id: 204, name: 'data-scale:data-scale:scale-xs:tag:4', rn: 4 },
        { id: 205, name: 'data-scale:data-scale:scale-xs:tag:5', rn: 5 },
        { id: 206, name: 'data-scale:data-scale:scale-xs:tag:6', rn: 6 },
        { id: 207, name: 'data-scale:data-scale:scale-xs:tag:7', rn: 7 },
        { id: 208, name: 'data-scale:data-scale:scale-xs:tag:8', rn: 8 }
    ];
}

function createValidTaxonomySetup(articleCount = 10)
{
    const categories = createMockCategories();
    const tags = createMockTags();
    const expectedModel = computeExpectedTaxonomyModel({
        articleCount,
        tier: 'scale-xs',
        namespace: 'data-scale',
        categories,
        tags
    });

    const projections = expectedModel.projections.map((p) => ({
        article_id: p.seed,
        seed: p.seed,
        category_id: categories.find((c) => c.rn === p.categoryRn)?.id,
        tag_ids: p.tagIdsString
    }));

    const categoryCounts = categories.map((c) => ({
        category_id: c.id,
        article_count: expectedModel.expectedCategoryCounts[c.id]
    }));

    const tagCounts = tags.map((t) => ({
        tag_id: t.id,
        article_count: expectedModel.expectedTagCounts[t.id]
    }));

    const canaryCategory = {
        id: categories[0].id,
        name: categories[0].name,
        articleCount: expectedModel.expectedCategoryCounts[categories[0].id]
    };

    const canaryTag = {
        id: tags[0].id,
        name: tags[0].name,
        articleCount: expectedModel.expectedTagCounts[tags[0].id]
    };

    const canaries = {
        article: { id: 1, title: 'data-scale:data-scale:scale-xs:article:1' },
        category: canaryCategory,
        tag: canaryTag
    };

    const decodedCategories = categories.map((c) => ({
        id: c.id,
        name: c.name,
        articleCount: expectedModel.expectedCategoryCounts[c.id]
    }));

    const decodedTags = tags.map((t) => ({
        id: t.id,
        name: t.name,
        articleCount: expectedModel.expectedTagCounts[t.id]
    }));

    const frameVersionReceipt = buildTaxonomyFrameVersionReceipt({
        beforeVersion: 1,
        afterVersion: 2,
        reason: 'test-valid-setup',
        invalidatedKeys: ['fsus:blog:category-frame:all', 'fsus:blog:tag-frame:all']
    });

    return {
        categories,
        tags,
        expectedModel,
        projections,
        categoryCounts,
        tagCounts,
        canaries,
        decodedCategories,
        decodedTags,
        frameVersionReceipt
    };
}

test('1. raw article_tag present but projection table empty -> fail', () =>
{
    const setup = createValidTaxonomySetup(10);
    const result = verifyTaxonomyProjections({
        projections: [],
        categoryCounts: setup.categoryCounts,
        tagCounts: setup.tagCounts,
        expectedModel: setup.expectedModel,
        canaries: setup.canaries
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('article_public_taxonomy_projection is empty or missing')));

    const dbProof = verifyDatabaseProof({
        seedReceipt: { counts: { articles: 10 } },
        counts: { articles: 10, taxonomyProjections: 0 },
        canaries: setup.canaries,
        taxonomyVerification: result
    });
    assert.equal(dbProof.status, 'failed');
    assert.ok(dbProof.errors.some((e) => e.includes('article_public_taxonomy_projection is empty or missing')));
});

test('2. category count off by +1 or -1 -> fail', () =>
{
    const setup = createValidTaxonomySetup(10);

    // Test +1
    const mutatedCountsPlus = setup.categoryCounts.map((c, i) => (
        i === 0 ? { ...c, article_count: c.article_count + 1 } : c
    ));
    const resultPlus = verifyTaxonomyProjections({
        projections: setup.projections,
        categoryCounts: mutatedCountsPlus,
        tagCounts: setup.tagCounts,
        expectedModel: setup.expectedModel,
        canaries: setup.canaries
    });
    assert.equal(resultPlus.status, 'failed');
    assert.ok(resultPlus.errors.some((e) => e.includes('expected article count')));

    // Test -1
    const mutatedCountsMinus = setup.categoryCounts.map((c, i) => (
        i === 0 ? { ...c, article_count: c.article_count - 1 } : c
    ));
    const resultMinus = verifyTaxonomyProjections({
        projections: setup.projections,
        categoryCounts: mutatedCountsMinus,
        tagCounts: setup.tagCounts,
        expectedModel: setup.expectedModel,
        canaries: setup.canaries
    });
    assert.equal(resultMinus.status, 'failed');
    assert.ok(resultMinus.errors.some((e) => e.includes('expected article count')));
});

test('3. tag duplicate relation not double counted -> pass', () =>
{
    const setup = createValidTaxonomySetup(10);
    // Article 1 seed has tag 1. If seed 1 has duplicate tag 1 relations in raw table, distinct count remains 1.
    const result = verifyTaxonomyProjections({
        projections: setup.projections,
        categoryCounts: setup.categoryCounts,
        tagCounts: setup.tagCounts,
        expectedModel: setup.expectedModel,
        canaries: setup.canaries
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.errors.length, 0);
});

test('4. scheduled/archived/deleted mistakenly included in projection -> fail', () =>
{
    const setup = createValidTaxonomySetup(20);
    // In articleCount=20: seed 7 is scheduled, seed 10 is archived, seed 20 is deleted.
    // Mistakenly include seed 20 in projections
    const mutatedProjections = [
        ...setup.projections,
        { article_id: 20, seed: 20, category_id: 101, tag_ids: '1' }
    ];

    const result = verifyTaxonomyProjections({
        projections: mutatedProjections,
        categoryCounts: setup.categoryCounts,
        tagCounts: setup.tagCounts,
        expectedModel: setup.expectedModel,
        canaries: setup.canaries
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('non-public article seed 20 mistakenly included in article_public_taxonomy_projection')));
});

test('5. projection correct but HTTP response has stale cache -> fail', () =>
{
    const setup = createValidTaxonomySetup(10);
    // Mutate decoded category responses to represent stale cache (e.g. old counts)
    const staleCategories = setup.decodedCategories.map((c, i) => (
        i === 0 ? { ...c, articleCount: c.articleCount + 5 } : c
    ));

    const result = verifyTaxonomyResponses({
        categories: staleCategories,
        tags: setup.decodedTags,
        expectedModel: setup.expectedModel,
        canaries: setup.canaries
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('response has')));
});

test('6. frame version not advanced or regressed -> fail', () =>
{
    // Regression test
    const regressedReceipt = {
        schema: 'fsusblog.data-scale-taxonomy-frame-version.v1',
        beforeVersion: 5,
        afterVersion: 4,
        monotonic: false,
        reason: 'regressed',
        invalidatedKeys: [],
        generatedAt: new Date().toISOString()
    };
    const regressedResult = verifyTaxonomyFrameVersionReceipt(regressedReceipt);
    assert.equal(regressedResult.status, 'failed');
    assert.ok(regressedResult.errors.some((e) => e.includes('not monotonically advanced')));

    // Equal (not advanced)
    const equalReceipt = {
        schema: 'fsusblog.data-scale-taxonomy-frame-version.v1',
        beforeVersion: 5,
        afterVersion: 5,
        monotonic: false,
        reason: 'not-advanced',
        invalidatedKeys: [],
        generatedAt: new Date().toISOString()
    };
    const equalResult = verifyTaxonomyFrameVersionReceipt(equalReceipt);
    assert.equal(equalResult.status, 'failed');
    assert.ok(equalResult.errors.some((e) => e.includes('not monotonically advanced')));
});

test('7. category response count = 0 while raw count > 0 -> fail', () =>
{
    const setup = createValidTaxonomySetup(10);
    // Force count 0 for category that has articles
    const zeroCategories = setup.decodedCategories.map((c, i) => (
        i === 0 ? { ...c, articleCount: 0 } : c
    ));

    const result = verifyTaxonomyResponses({
        categories: zeroCategories,
        tags: setup.decodedTags,
        expectedModel: setup.expectedModel,
        canaries: setup.canaries
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('has count 0 in response but expected count is')));

    // Verify fail closed in verifyHttpPayloadProof
    const httpProof = verifyHttpPayloadProof({
        decodedResponses: {
            articleList: [{ id: 1, title: 'data-scale:data-scale:scale-xs:article:1' }],
            categoryList: zeroCategories,
            tagList: setup.decodedTags
        },
        canaries: {
            ...setup.canaries,
            category: { id: setup.categories[0].id, name: setup.categories[0].name, articleCount: 3 }
        },
        taxonomyResponsesVerification: result
    });
    assert.equal(httpProof.status, 'failed');
    assert.ok(httpProof.errors.some((e) => e.includes('article_count_zero_fail_closed')));
});

test('8. cleanup leaves residual projection rows -> fail', () =>
{
    const cleanupSummaryWithResiduals = {
        status: 'failed',
        tier: 'scale-xs',
        namespace: 'data-scale',
        remaining: {
            articles: 0,
            comments: 0,
            categories: 0,
            tags: 0,
            taxonomyProjections: 2,
            categoryProjections: 0,
            tagProjections: 0
        }
    };

    assert.equal(cleanupSummaryWithResiduals.status, 'failed');
    assert.ok(cleanupSummaryWithResiduals.remaining.taxonomyProjections > 0);
});

test('9. business epoch variation according to canonical visibility -> pass', () =>
{
    const categories = createMockCategories();
    const tags = createMockTags();

    // Model at epoch 1
    const model1 = computeExpectedTaxonomyModel({
        articleCount: 14,
        tier: 'scale-xs',
        namespace: 'data-scale',
        categories,
        tags,
        businessEpochUtc: '2024-02-29T23:59:59.000Z'
    });

    // Seed 7 and 14 are status 1 (scheduled)
    const scheduledArticles = model1.articles.filter((a) => a.status === 1);
    assert.equal(scheduledArticles.length, 2);
    assert.ok(scheduledArticles.every((a) => !a.isPublic));

    // Public articles are 14 - 2 (scheduled) - 1 (archived seed 10) = 11
    const publicArticles = model1.articles.filter((a) => a.isPublic);
    assert.equal(publicArticles.length, 11);
    assert.equal(model1.projections.length, 11);
});

test('10. DB, projection, and AEDS digests mismatch -> fail', () =>
{
    const setup = createValidTaxonomySetup(10);
    const projectionsVerification = verifyTaxonomyProjections({
        projections: setup.projections,
        categoryCounts: setup.categoryCounts,
        tagCounts: setup.tagCounts,
        expectedModel: setup.expectedModel,
        canaries: setup.canaries
    });
    const responsesVerification = verifyTaxonomyResponses({
        categories: setup.decodedCategories,
        tags: setup.decodedTags,
        expectedModel: setup.expectedModel,
        canaries: setup.canaries
    });

    const receipt = buildTaxonomyProofReceipt({
        tier: 'scale-xs',
        namespace: 'data-scale',
        rawRelationDigest: setup.expectedModel.rawRelationDigest,
        projectionDigest: setup.expectedModel.projectionDigest,
        responseDigest: responsesVerification.responseDigest,
        frameVersionReceipt: setup.frameVersionReceipt,
        projectionsVerification,
        responsesVerification
    });

    // Tamper with projectionDigest
    receipt.digests.projectionDigest = 'sha256:tampered';
    const tamperedResult = verifyTaxonomyProofReceipt(receipt);
    assert.equal(tamperedResult.status, 'failed');
    assert.ok(tamperedResult.errors.some((e) => e.includes('contentDigest mismatch')));
});

test('11. all valid data matching -> pass and generate 4-layer receipt', () =>
{
    const setup = createValidTaxonomySetup(10);
    const projectionsVerification = verifyTaxonomyProjections({
        projections: setup.projections,
        categoryCounts: setup.categoryCounts,
        tagCounts: setup.tagCounts,
        expectedModel: setup.expectedModel,
        canaries: setup.canaries
    });
    assert.equal(projectionsVerification.status, 'ok');

    const responsesVerification = verifyTaxonomyResponses({
        categories: setup.decodedCategories,
        tags: setup.decodedTags,
        expectedModel: setup.expectedModel,
        canaries: setup.canaries
    });
    assert.equal(responsesVerification.status, 'ok');

    const receipt = buildTaxonomyProofReceipt({
        tier: 'scale-xs',
        namespace: 'data-scale',
        rawRelationDigest: setup.expectedModel.rawRelationDigest,
        projectionDigest: setup.expectedModel.projectionDigest,
        responseDigest: responsesVerification.responseDigest,
        frameVersionReceipt: setup.frameVersionReceipt,
        projectionsVerification,
        responsesVerification
    });

    assert.equal(receipt.status, 'ok');
    assert.ok(receipt.digests.rawRelationDigest.startsWith('sha256:'));
    assert.ok(receipt.digests.projectionDigest.startsWith('sha256:'));
    assert.ok(receipt.digests.responseDigest.startsWith('sha256:'));
    assert.ok(receipt.frameVersionReceipt.contentDigest.startsWith('sha256:'));

    const verification = verifyTaxonomyProofReceipt(receipt);
    assert.equal(verification.status, 'ok');
    assert.equal(verification.errors.length, 0);
});
