import { createHash } from 'node:crypto';

export const DATA_SCALE_TAXONOMY_PROOF_SCHEMA = 'fsusblog.data-scale-taxonomy-proof.v1';
export const DATA_SCALE_TAXONOMY_FRAME_VERSION_SCHEMA = 'fsusblog.data-scale-taxonomy-frame-version.v1';

export function canonicalStringify(value)
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

function sha256Canonical(value)
{
    const text = typeof value === 'string' ? value : canonicalStringify(value);
    return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * Pure function to compute expected taxonomy projection, counts, and digests
 * based on canonical ArticlePublication.IsPubliclyVisible logic.
 */
export function computeExpectedTaxonomyModel({
    articleCount = 10,
    tier = 'scale-xs',
    namespace = 'data-scale',
    categories = [],
    tags = [],
    businessEpochUtc = null
} = {})
{
    const articles = [];
    const projections = [];
    const rawRelations = [];

    // Initialize category count map (categoryRn 1..4)
    const categoryCountMap = new Map();
    for (let rn = 1; rn <= 4; rn += 1)
    {
        categoryCountMap.set(rn, 0);
    }

    // Initialize tag count map (tagRn 1..8)
    const tagCountMap = new Map();
    for (let rn = 1; rn <= 8; rn += 1)
    {
        tagCountMap.set(rn, 0);
    }

    for (let seed = 1; seed <= articleCount; seed += 1)
    {
        let status = 2; // Published
        if (seed % 20 === 0)
        {
            status = 4; // Deleted
        }
        else if (seed % 10 === 0)
        {
            status = 3; // Archived
        }
        else if (seed % 7 === 0)
        {
            status = 1; // Scheduled
        }

        const isDeleted = (status === 4);
        // Canonical visibility: !isDeleted && status == 2 && publishedAt <= businessNow && scheduledPublishAt <= businessNow
        const isPublic = (!isDeleted && status === 2);
        const categoryRn = ((seed - 1) % 4) + 1;

        const primaryTagRn = ((seed - 1) % 8) + 1;
        const tagRns = [primaryTagRn];
        if (seed % 3 === 0)
        {
            const secondaryTagRn = (seed % 8) + 1;
            if (!tagRns.includes(secondaryTagRn))
            {
                tagRns.push(secondaryTagRn);
            }
        }
        tagRns.sort((a, b) => a - b);

        articles.push({
            seed,
            status,
            isDeleted,
            isPublic,
            categoryRn,
            tagRns
        });

        rawRelations.push({
            seed,
            categoryRn,
            tagRns: [...tagRns]
        });

        if (isPublic)
        {
            categoryCountMap.set(categoryRn, categoryCountMap.get(categoryRn) + 1);

            // Distinct tag relations per article
            for (const tagRn of tagRns)
            {
                tagCountMap.set(tagRn, tagCountMap.get(tagRn) + 1);
            }

            projections.push({
                seed,
                categoryRn,
                tagRns: [...tagRns],
                tagIdsString: tagRns.join(',')
            });
        }
    }

    // Map RNs to IDs if category/tag arrays provided
    const categoryIdByRn = new Map();
    const categoryRnById = new Map();
    for (const cat of categories)
    {
        const rn = cat.rn ?? (cat.name ? Number.parseInt(cat.name.split(':category:').pop(), 10) : null);
        if (rn && cat.id)
        {
            categoryIdByRn.set(rn, cat.id);
            categoryRnById.set(cat.id, rn);
        }
    }

    const tagIdByRn = new Map();
    const tagRnById = new Map();
    for (const tag of tags)
    {
        const rn = tag.rn ?? (tag.name ? Number.parseInt(tag.name.split(':tag:').pop(), 10) : null);
        if (rn && tag.id)
        {
            tagIdByRn.set(rn, tag.id);
            tagRnById.set(tag.id, rn);
        }
    }

    const expectedCategoryCounts = {};
    for (const [rn, count] of categoryCountMap.entries())
    {
        const catId = categoryIdByRn.get(rn) ?? rn;
        expectedCategoryCounts[catId] = count;
    }

    const expectedTagCounts = {};
    for (const [rn, count] of tagCountMap.entries())
    {
        const tagId = tagIdByRn.get(rn) ?? rn;
        expectedTagCounts[tagId] = count;
    }

    const rawRelationDigest = sha256Canonical(rawRelations);
    const projectionDigest = sha256Canonical(projections);
    const expectedCountsDigest = sha256Canonical({
        categoryCounts: expectedCategoryCounts,
        tagCounts: expectedTagCounts
    });

    return {
        tier,
        namespace,
        articleCount,
        businessEpochUtc,
        articles,
        projections,
        rawRelations,
        categoryCountMap: Object.fromEntries(categoryCountMap),
        tagCountMap: Object.fromEntries(tagCountMap),
        expectedCategoryCounts,
        expectedTagCounts,
        rawRelationDigest,
        projectionDigest,
        expectedCountsDigest
    };
}

/**
 * Verify database projection tables against expected taxonomy model.
 */
export function verifyTaxonomyProjections({
    projections = [],
    categoryCounts = [],
    tagCounts = [],
    expectedModel,
    canaries = {}
} = {})
{
    const assertionIds = [];
    const errors = [];

    assertionIds.push('data-scale.taxonomy.projection.presence');
    if (!projections || projections.length === 0)
    {
        errors.push('article_public_taxonomy_projection is empty or missing');
    }
    else if (projections.length !== expectedModel.projections.length)
    {
        errors.push(`expected ${expectedModel.projections.length} taxonomy projections, observed ${projections.length}`);
    }

    assertionIds.push('data-scale.taxonomy.projection.visibility');
    // Verify non-public articles are not in projections
    const nonPublicSeeds = new Set(expectedModel.articles.filter((a) => !a.isPublic).map((a) => a.seed));
    for (const p of (projections || []))
    {
        if (p.seed !== undefined && nonPublicSeeds.has(p.seed))
        {
            errors.push(`non-public article seed ${p.seed} mistakenly included in article_public_taxonomy_projection`);
        }
    }

    assertionIds.push('data-scale.taxonomy.category.counts');
    const observedCatCounts = new Map();
    for (const row of (categoryCounts || []))
    {
        const id = row.category_id ?? row.categoryId ?? row.id;
        const count = Number.parseInt(row.article_count ?? row.articleCount ?? 0, 10);
        observedCatCounts.set(Number(id), count);
        observedCatCounts.set(String(id), count);
    }

    for (const [catId, expectedCount] of Object.entries(expectedModel.expectedCategoryCounts))
    {
        const numericCatId = Number.parseInt(catId, 10);
        const observed = observedCatCounts.get(numericCatId) ?? observedCatCounts.get(String(catId));
        if (observed === undefined)
        {
            errors.push(`category ID ${catId} missing from category_public_article_count`);
        }
        else if (observed !== expectedCount)
        {
            errors.push(`category ID ${catId} expected article count ${expectedCount}, observed ${observed}`);
        }
    }

    assertionIds.push('data-scale.taxonomy.tag.counts');
    const observedTagCounts = new Map();
    for (const row of (tagCounts || []))
    {
        const id = row.tag_id ?? row.tagId ?? row.id;
        const count = Number.parseInt(row.article_count ?? row.articleCount ?? 0, 10);
        observedTagCounts.set(Number(id), count);
        observedTagCounts.set(String(id), count);
    }

    for (const [tagId, expectedCount] of Object.entries(expectedModel.expectedTagCounts))
    {
        const numericTagId = Number.parseInt(tagId, 10);
        const observed = observedTagCounts.get(numericTagId) ?? observedTagCounts.get(String(tagId));
        if (observed === undefined)
        {
            errors.push(`tag ID ${tagId} missing from tag_public_article_count`);
        }
        else if (observed !== expectedCount)
        {
            errors.push(`tag ID ${tagId} expected article count ${expectedCount}, observed ${observed}`);
        }
    }

    assertionIds.push('data-scale.taxonomy.canary.counts');
    if (canaries.category?.id)
    {
        const canaryCatCount = observedCatCounts.get(Number(canaries.category.id)) ?? observedCatCounts.get(String(canaries.category.id));
        const expectedCanaryCatCount = expectedModel.expectedCategoryCounts[canaries.category.id] ?? expectedModel.expectedCategoryCounts[Number(canaries.category.id)];
        if (expectedCanaryCatCount !== undefined && canaryCatCount !== expectedCanaryCatCount)
        {
            errors.push(`canary category ${canaries.category.id} expected count ${expectedCanaryCatCount}, observed ${canaryCatCount}`);
        }
    }
    if (canaries.tag?.id)
    {
        const canaryTagCount = observedTagCounts.get(Number(canaries.tag.id)) ?? observedTagCounts.get(String(canaries.tag.id));
        const expectedCanaryTagCount = expectedModel.expectedTagCounts[canaries.tag.id] ?? expectedModel.expectedTagCounts[Number(canaries.tag.id)];
        if (expectedCanaryTagCount !== undefined && canaryTagCount !== expectedCanaryTagCount)
        {
            errors.push(`canary tag ${canaries.tag.id} expected count ${expectedCanaryTagCount}, observed ${canaryTagCount}`);
        }
    }

    const digests = {
        rawRelationDigest: expectedModel.rawRelationDigest,
        projectionDigest: expectedModel.projectionDigest,
        observedCountsDigest: sha256Canonical({
            categories: Object.fromEntries(observedCatCounts),
            tags: Object.fromEntries(observedTagCounts)
        })
    };

    return {
        status: errors.length === 0 ? 'ok' : 'failed',
        assertionIds,
        errors,
        digests
    };
}

/**
 * Verify taxonomy AEDS responses against expected model.
 */
export function verifyTaxonomyResponses({
    categories = [],
    tags = [],
    expectedModel,
    canaries = {}
} = {})
{
    const assertionIds = [];
    const errors = [];

    assertionIds.push('data-scale.taxonomy.response.presence');
    if (!categories || categories.length === 0)
    {
        errors.push('category response is empty');
    }
    if (!tags || tags.length === 0)
    {
        errors.push('tag response is empty');
    }

    assertionIds.push('data-scale.taxonomy.response.category_counts');
    const responseCatMap = new Map();
    for (const cat of (categories || []))
    {
        responseCatMap.set(cat.id, cat);
        const expected = expectedModel.expectedCategoryCounts[cat.id];
        if (expected !== undefined)
        {
            if (cat.articleCount !== expected)
            {
                errors.push(`category ${cat.id} (${cat.name}) expected count ${expected}, response has ${cat.articleCount}`);
            }
            if (expected > 0 && cat.articleCount === 0)
            {
                errors.push(`category ${cat.id} has count 0 in response but expected count is ${expected}`);
            }
        }
    }

    assertionIds.push('data-scale.taxonomy.response.tag_counts');
    const responseTagMap = new Map();
    for (const tag of (tags || []))
    {
        responseTagMap.set(tag.id, tag);
        const expected = expectedModel.expectedTagCounts[tag.id];
        if (expected !== undefined)
        {
            if (tag.articleCount !== expected)
            {
                errors.push(`tag ${tag.id} (${tag.name}) expected count ${expected}, response has ${tag.articleCount}`);
            }
            if (expected > 0 && tag.articleCount === 0)
            {
                errors.push(`tag ${tag.id} has count 0 in response but expected count is ${expected}`);
            }
        }
    }

    assertionIds.push('data-scale.taxonomy.response.canary');
    if (canaries.category?.id)
    {
        const cat = responseCatMap.get(canaries.category.id);
        if (!cat)
        {
            errors.push(`canary category ${canaries.category.id} missing from response`);
        }
        else if (canaries.category.name && cat.name !== canaries.category.name)
        {
            errors.push(`canary category name mismatch: expected ${canaries.category.name}, got ${cat.name}`);
        }
    }

    if (canaries.tag?.id)
    {
        const tag = responseTagMap.get(canaries.tag.id);
        if (!tag)
        {
            errors.push(`canary tag ${canaries.tag.id} missing from response`);
        }
        else if (canaries.tag.name && tag.name !== canaries.tag.name)
        {
            errors.push(`canary tag name mismatch: expected ${canaries.tag.name}, got ${tag.name}`);
        }
    }

    const responseDigest = sha256Canonical({
        categories: (categories || []).map((c) => ({ id: c.id, name: c.name, articleCount: c.articleCount })),
        tags: (tags || []).map((t) => ({ id: t.id, name: t.name, articleCount: t.articleCount }))
    });

    return {
        status: errors.length === 0 ? 'ok' : 'failed',
        assertionIds,
        errors,
        responseDigest
    };
}

/**
 * Reconcile and bump taxonomy frame version in Redis.
 */
export function buildTaxonomyFrameVersionReceipt({
    beforeVersion = 0,
    afterVersion = 1,
    reason = 'data-scale-taxonomy-projection',
    invalidatedKeys = []
} = {})
{
    if (afterVersion <= beforeVersion)
    {
        throw new Error(`afterVersion (${afterVersion}) must be greater than beforeVersion (${beforeVersion})`);
    }

    const receipt = {
        schema: DATA_SCALE_TAXONOMY_FRAME_VERSION_SCHEMA,
        beforeVersion,
        afterVersion,
        monotonic: afterVersion > beforeVersion,
        reason,
        invalidatedKeys: [...invalidatedKeys].sort(),
        generatedAt: new Date().toISOString()
    };
    receipt.contentDigest = sha256Canonical(receipt);
    return receipt;
}

/**
 * Verify frame version receipt.
 */
export function verifyTaxonomyFrameVersionReceipt(receipt)
{
    if (!receipt || receipt.schema !== DATA_SCALE_TAXONOMY_FRAME_VERSION_SCHEMA)
    {
        return { status: 'failed', errors: ['invalid taxonomy frame version receipt schema'] };
    }
    if (receipt.afterVersion <= receipt.beforeVersion)
    {
        return { status: 'failed', errors: ['frame version was not monotonically advanced'] };
    }
    const copy = { ...receipt };
    delete copy.contentDigest;
    if (receipt.contentDigest !== sha256Canonical(copy))
    {
        return { status: 'failed', errors: ['taxonomy frame version receipt contentDigest mismatch'] };
    }
    return { status: 'ok', errors: [] };
}

/**
 * Assemble authoritative taxonomy proof receipt.
 */
export function buildTaxonomyProofReceipt({
    tier = 'scale-xs',
    namespace = 'data-scale',
    rawRelationDigest,
    projectionDigest,
    responseDigest,
    frameVersionReceipt,
    projectionsVerification,
    responsesVerification
} = {})
{
    const status = (
        projectionsVerification.status === 'ok'
        && responsesVerification.status === 'ok'
        && (frameVersionReceipt?.afterVersion > frameVersionReceipt?.beforeVersion)
    ) ? 'ok' : 'failed';

    const errors = [
        ...(projectionsVerification.errors || []),
        ...(responsesVerification.errors || [])
    ];

    const receipt = {
        schema: DATA_SCALE_TAXONOMY_PROOF_SCHEMA,
        status,
        tier,
        namespace,
        digests: {
            rawRelationDigest,
            projectionDigest,
            responseDigest
        },
        frameVersionReceipt,
        assertionIds: [
            ...(projectionsVerification.assertionIds || []),
            ...(responsesVerification.assertionIds || [])
        ],
        errors,
        generatedAt: new Date().toISOString()
    };
    receipt.contentDigest = sha256Canonical(receipt);
    return receipt;
}

/**
 * Verify complete taxonomy proof receipt.
 */
export function verifyTaxonomyProofReceipt(receipt)
{
    if (!receipt || receipt.schema !== DATA_SCALE_TAXONOMY_PROOF_SCHEMA)
    {
        return { status: 'failed', errors: ['invalid taxonomy proof receipt schema'] };
    }
    if (receipt.status !== 'ok')
    {
        return { status: 'failed', errors: receipt.errors || ['taxonomy proof status is not ok'] };
    }
    if (!receipt.digests?.rawRelationDigest || !receipt.digests?.projectionDigest || !receipt.digests?.responseDigest)
    {
        return { status: 'failed', errors: ['missing required digests (rawRelationDigest, projectionDigest, responseDigest)'] };
    }
    const fvResult = verifyTaxonomyFrameVersionReceipt(receipt.frameVersionReceipt);
    if (fvResult.status !== 'ok')
    {
        return { status: 'failed', errors: fvResult.errors };
    }
    const copy = { ...receipt };
    delete copy.contentDigest;
    if (receipt.contentDigest !== sha256Canonical(copy))
    {
        return { status: 'failed', errors: ['taxonomy proof receipt contentDigest mismatch'] };
    }
    return { status: 'ok', errors: [] };
}
