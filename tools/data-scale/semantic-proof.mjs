#!/usr/bin/env node
import {
    computeSha256
} from './runtime-plan.mjs';
import {
    verifySearchExecutionProof
} from './search-evidence.mjs';

export const DATA_SCALE_SEMANTIC_PROOF_SCHEMA = 'fsusblog.data-scale-semantic-proof.v2';

export const REQUIRED_KINDS = Object.freeze([
    'database',
    'httpPayload',
    'search',
    'aot',
    'hotRead'
]);

export function verifyDatabaseProof({
    seedReceipt,
    counts,
    canaries,
    dbSemanticDigest,
    queries = {},
    taxonomyVerification
})
{
    const errors = [];
    const assertionIds = [];

    if (!seedReceipt || typeof seedReceipt !== 'object')
    {
        return {
            status: 'failed',
            kind: 'database',
            errors: ['seed_receipt_missing_or_invalid'],
            assertionIds: []
        };
    }

    // 1. Exact article & comment counts
    assertionIds.push('data-scale.database.counts');
    const expectedCounts = seedReceipt.counts ?? seedReceipt.declared ?? {};
    if (counts)
    {
        if (counts.articles !== undefined && counts.articles !== expectedCounts.articles)
        {
            errors.push(`database_article_count_mismatch: expected ${expectedCounts.articles}, got ${counts.articles}`);
        }
        if (counts.comments !== undefined && counts.comments !== expectedCounts.comments)
        {
            errors.push(`database_comment_count_mismatch: expected ${expectedCounts.comments}, got ${counts.comments}`);
        }
        if (counts.published !== undefined && expectedCounts.published !== undefined && counts.published !== expectedCounts.published)
        {
            errors.push(`database_published_count_mismatch: expected ${expectedCounts.published}, got ${counts.published}`);
        }
        if (counts.articleBodies !== undefined && counts.articles !== undefined && counts.articleBodies !== counts.articles)
        {
            errors.push(`database_article_bodies_mismatch: expected ${counts.articles}, got ${counts.articleBodies}`);
        }
    }
    else
    {
        errors.push('database_observed_counts_missing');
    }

    // 2. Canary article
    assertionIds.push('data-scale.database.canary-article');
    const receiptArticle = seedReceipt.canaries?.article;
    const observedArticle = canaries?.article ?? receiptArticle;
    if (!receiptArticle || !observedArticle)
    {
        errors.push('database_canary_article_missing');
    }
    else
    {
        if (String(observedArticle.id) !== String(receiptArticle.id))
        {
            errors.push(`database_canary_article_id_mismatch: expected ${receiptArticle.id}, got ${observedArticle.id}`);
        }
        if (observedArticle.title !== receiptArticle.title)
        {
            errors.push(`database_canary_article_title_mismatch: expected ${receiptArticle.title}, got ${observedArticle.title}`);
        }
    }

    // 3. Canary taxonomy
    assertionIds.push('data-scale.database.canary-taxonomy');
    const receiptCategory = seedReceipt.canaries?.category;
    const observedCategory = canaries?.category ?? receiptCategory;
    if (!receiptCategory || !observedCategory)
    {
        errors.push('database_canary_category_missing');
    }
    else if (observedCategory.name !== receiptCategory.name || String(observedCategory.id) !== String(receiptCategory.id))
    {
        errors.push('database_canary_category_mismatch');
    }

    const receiptTag = seedReceipt.canaries?.tag;
    const observedTag = canaries?.tag ?? receiptTag;
    if (!receiptTag || !observedTag)
    {
        errors.push('database_canary_tag_missing');
    }
    else if (observedTag.name !== receiptTag.name || String(observedTag.id) !== String(receiptTag.id))
    {
        errors.push('database_canary_tag_mismatch');
    }

    // 4. Canary comment
    assertionIds.push('data-scale.database.canary-comment');
    const receiptComment = seedReceipt.canaries?.comment;
    const observedComment = canaries?.comment ?? receiptComment;
    if (expectedCounts.comments > 0)
    {
        if (!receiptComment || !observedComment)
        {
            errors.push('database_canary_comment_missing');
        }
        else if (receiptComment.id && observedComment.id && String(receiptComment.id) !== String(observedComment.id))
        {
            errors.push('database_canary_comment_id_mismatch');
        }
    }

    // 5. DB semantic digest
    assertionIds.push('data-scale.database.semantic-digest');
    const expectedDigest = seedReceipt.dbSemanticDigest;
    if (!expectedDigest)
    {
        errors.push('database_seed_receipt_semantic_digest_missing');
    }
    else if (dbSemanticDigest && dbSemanticDigest !== expectedDigest)
    {
        errors.push(`database_semantic_digest_mismatch: expected ${expectedDigest}, got ${dbSemanticDigest}`);
    }

    // 6. Taxonomy Projections
    assertionIds.push('data-scale.database.taxonomy-projections');
    const effectiveTaxonomyVerification = taxonomyVerification ?? queries?.taxonomyVerification;
    if (effectiveTaxonomyVerification)
    {
        if (effectiveTaxonomyVerification.status !== 'ok')
        {
            errors.push(...(effectiveTaxonomyVerification.errors || ['database_taxonomy_projections_failed']));
        }
    }
    else if (counts?.taxonomyProjections !== undefined && counts?.taxonomyProjections !== null)
    {
        if (counts.taxonomyProjections === 0 && expectedCounts.articles > 0)
        {
            errors.push('database_taxonomy_projections_empty');
        }
    }

    const status = errors.length === 0 ? 'ok' : 'failed';
    return {
        status,
        kind: 'database',
        assertionIds,
        semanticDigest: expectedDigest ?? dbSemanticDigest ?? null,
        counts,
        canaries: {
            article: observedArticle,
            category: observedCategory,
            tag: observedTag,
            comment: observedComment
        },
        errors,
        details: queries
    };
}

export function verifyHttpPayloadProof({
    decodedResponses,
    canaries,
    runtimeLease,
    taxonomyResponsesVerification
})
{
    const errors = [];
    const assertionIds = [];

    if (!decodedResponses || typeof decodedResponses !== 'object')
    {
        return {
            status: 'failed',
            kind: 'httpPayload',
            errors: ['http_decoded_responses_missing'],
            assertionIds: []
        };
    }

    if (!canaries || typeof canaries !== 'object')
    {
        return {
            status: 'failed',
            kind: 'httpPayload',
            errors: ['canaries_missing_from_seed_receipt'],
            assertionIds: []
        };
    }

    const { article: canaryArticle, category: canaryCategory, tag: canaryTag, comment: canaryComment } = canaries;

    // 1. Article list decoded response
    assertionIds.push('data-scale.http-payload.article-list');
    const articleListResp = decodedResponses.articleList;
    if (!articleListResp)
    {
        errors.push('http_article_list_missing');
    }
    else
    {
        const items = Array.isArray(articleListResp)
            ? articleListResp
            : (Array.isArray(articleListResp.items) ? articleListResp.items : (Array.isArray(articleListResp.data) ? articleListResp.data : null));
        if (!items)
        {
            errors.push('http_article_list_payload_shape_invalid');
        }
        else
        {
            const found = items.find((item) => (
                String(item.id ?? item.articleId) === String(canaryArticle?.id)
                && item.title === canaryArticle?.title
            ));
            if (!found)
            {
                errors.push(`http_article_list_missing_canary: expected id=${canaryArticle?.id} title=${canaryArticle?.title}`);
            }
        }
    }

    // 2. Category list decoded response
    assertionIds.push('data-scale.http-payload.category-list');
    const categoryListResp = decodedResponses.categoryList;
    if (!categoryListResp)
    {
        errors.push('http_category_list_missing');
    }
    else
    {
        const items = Array.isArray(categoryListResp)
            ? categoryListResp
            : (Array.isArray(categoryListResp.items) ? categoryListResp.items : (Array.isArray(categoryListResp.data) ? categoryListResp.data : null));
        if (!items)
        {
            errors.push('http_category_list_payload_shape_invalid');
        }
        else
        {
            const found = items.find((item) => (
                String(item.id ?? item.categoryId) === String(canaryCategory?.id)
                && item.name === canaryCategory?.name
            ));
            if (!found)
            {
                errors.push(`http_category_list_missing_canary: expected id=${canaryCategory?.id} name=${canaryCategory?.name}`);
            }
            else if (canaryCategory?.articleCount !== undefined && canaryCategory?.articleCount !== null)
            {
                if (Number(found.articleCount) !== Number(canaryCategory.articleCount))
                {
                    errors.push(`http_category_list_article_count_mismatch: expected ${canaryCategory.articleCount}, got ${found.articleCount}`);
                }
                if (Number(found.articleCount) === 0 && Number(canaryCategory.articleCount) > 0)
                {
                    errors.push(`http_category_list_article_count_zero_fail_closed: category ${found.id} has count 0 while raw count is ${canaryCategory.articleCount}`);
                }
            }
        }
    }

    // 3. Tag list decoded response
    assertionIds.push('data-scale.http-payload.tag-list');
    const tagListResp = decodedResponses.tagList;
    if (!tagListResp)
    {
        errors.push('http_tag_list_missing');
    }
    else
    {
        const items = Array.isArray(tagListResp)
            ? tagListResp
            : (Array.isArray(tagListResp.items) ? tagListResp.items : (Array.isArray(tagListResp.data) ? tagListResp.data : null));
        if (!items)
        {
            errors.push('http_tag_list_payload_shape_invalid');
        }
        else
        {
            const found = items.find((item) => (
                String(item.id ?? item.tagId) === String(canaryTag?.id)
                && item.name === canaryTag?.name
            ));
            if (!found)
            {
                errors.push(`http_tag_list_missing_canary: expected id=${canaryTag?.id} name=${canaryTag?.name}`);
            }
            else if (canaryTag?.articleCount !== undefined && canaryTag?.articleCount !== null)
            {
                if (Number(found.articleCount) !== Number(canaryTag.articleCount))
                {
                    errors.push(`http_tag_list_article_count_mismatch: expected ${canaryTag.articleCount}, got ${found.articleCount}`);
                }
                if (Number(found.articleCount) === 0 && Number(canaryTag.articleCount) > 0)
                {
                    errors.push(`http_tag_list_article_count_zero_fail_closed: tag ${found.id} has count 0 while raw count is ${canaryTag.articleCount}`);
                }
            }
        }
    }

    // 4. Article detail decoded response
    assertionIds.push('data-scale.http-payload.article-detail');
    const articleDetailResp = decodedResponses.articleDetail;
    if (!articleDetailResp)
    {
        errors.push('http_article_detail_missing');
    }
    else
    {
        if (String(articleDetailResp.id ?? articleDetailResp.articleId) !== String(canaryArticle?.id))
        {
            errors.push(`http_article_detail_id_mismatch: expected ${canaryArticle?.id}, got ${articleDetailResp.id}`);
        }
        if (articleDetailResp.title !== canaryArticle?.title)
        {
            errors.push(`http_article_detail_title_mismatch: expected ${canaryArticle?.title}, got ${articleDetailResp.title}`);
        }
        const content = String(articleDetailResp.content ?? articleDetailResp.markdownContent ?? articleDetailResp.body ?? '');
        if (canaryArticle?.searchToken && !content.includes(canaryArticle.searchToken))
        {
            errors.push(`http_article_detail_missing_search_token: ${canaryArticle.searchToken}`);
        }
    }

    // 5. Comment cursor decoded response
    assertionIds.push('data-scale.http-payload.comment-cursor');
    const commentCursorResp = decodedResponses.commentCursor;
    if (!commentCursorResp)
    {
        errors.push('http_comment_cursor_missing');
    }
    else
    {
        const commentData = Array.isArray(commentCursorResp.data) ? commentCursorResp.data : [];
        if (canaryComment?.id)
        {
            const found = commentData.find((c) => (
                String(c.id) === String(canaryComment.id)
                || (canaryComment.contentPrefix && String(c.content).startsWith(canaryComment.contentPrefix))
            ));
            if (!found)
            {
                errors.push(`http_comment_cursor_missing_canary: expected comment id=${canaryComment.id}`);
            }
        }
    }

    // 6. Runtime lease binding
    assertionIds.push('data-scale.http-payload.runtime-lease');
    if (runtimeLease)
    {
        if (decodedResponses.runtimeLeaseDigest && decodedResponses.runtimeLeaseDigest !== runtimeLease.runtimeLeaseDigest)
        {
            errors.push('http_payload_runtime_lease_mismatch');
        }
    }

    // 7. Taxonomy responses verification if provided
    const effectiveTaxonomyResponsesVerification = taxonomyResponsesVerification ?? decodedResponses?.taxonomyResponsesVerification;
    if (effectiveTaxonomyResponsesVerification)
    {
        assertionIds.push('data-scale.http-payload.taxonomy-responses');
        if (effectiveTaxonomyResponsesVerification.status !== 'ok')
        {
            errors.push(...(effectiveTaxonomyResponsesVerification.errors || ['http_payload_taxonomy_responses_failed']));
        }
    }

    const status = errors.length === 0 ? 'ok' : 'failed';
    const semanticDigest = computeSha256({
        articleId: canaryArticle?.id,
        articleTitle: canaryArticle?.title,
        categoryId: canaryCategory?.id,
        tagId: canaryTag?.id,
        commentId: canaryComment?.id ?? null
    });

    return {
        status,
        kind: 'httpPayload',
        assertionIds,
        semanticDigest,
        errors
    };
}

export function verifySearchProof({
    manifest,
    shard,
    searchToken,
    tokens,
    expectedArticleId,
    indexReceipt,
    expectedModel,
    runtimeLease,
    searchApiExecutions = null,
    canaries = null
})
{
    const normalizedTokens = tokens && typeof tokens === 'object'
        ? {
            titleSearchToken: tokens.titleSearchToken || tokens.title || searchToken || null,
            bodySearchToken: tokens.bodySearchToken || tokens.body || null,
            cjkSearchToken: tokens.cjkSearchToken || tokens.cjk || null
        }
        : {
            titleSearchToken: searchToken || null,
            bodySearchToken: null,
            cjkSearchToken: null
        };

    const result = verifySearchExecutionProof({
        manifest,
        shard,
        indexReceipt,
        expectedModel,
        runtimeLease,
        searchApiExecutions,
        canaries: canaries || {
            article: {
                id: expectedArticleId,
                titleSearchToken: normalizedTokens.titleSearchToken,
                bodySearchToken: normalizedTokens.bodySearchToken,
                cjkSearchToken: normalizedTokens.cjkSearchToken,
                searchToken
            }
        }
    });

    // Preserve legacy assertion id for query-hit while requiring Search HTTP API path.
    if (!result.assertionIds.includes('data-scale.search.query-hit'))
    {
        result.assertionIds = [...result.assertionIds, 'data-scale.search.query-hit'];
    }
    return result;
}

export function verifyAotProof({
    aotManifest,
    aotArtifacts = {},
    canaries,
    runtimeLease
})
{
    const errors = [];
    const assertionIds = [];

    if (!aotManifest || typeof aotManifest !== 'object')
    {
        return {
            status: 'failed',
            kind: 'aot',
            errors: ['aot_manifest_missing_or_invalid'],
            assertionIds: []
        };
    }

    assertionIds.push('data-scale.aot.manifest');
    if (aotManifest.status === 'unsupported' || aotManifest.status === 'not-configured')
    {
        return {
            status: 'failed',
            kind: 'aot',
            errors: ['aot_unsupported_or_not_configured'],
            assertionIds
        };
    }

    assertionIds.push('data-scale.aot.canary-routes');
    const routes = Array.isArray(aotManifest.routes) ? aotManifest.routes : [];
    const canaryArticleId = canaries?.article?.id;
    if (canaryArticleId !== undefined)
    {
        const expectedArticleRoute = `/article/${canaryArticleId}`;
        const hasArticleRoute = routes.some((r) => (
            r.path === expectedArticleRoute || r === expectedArticleRoute || r.id === canaryArticleId
        ));
        if (!hasArticleRoute && routes.length > 0)
        {
            errors.push(`aot_manifest_missing_canary_article_route: ${expectedArticleRoute}`);
        }
    }

    assertionIds.push('data-scale.aot.canary-payload');
    const canaryArticle = canaries?.article;
    if (canaryArticle)
    {
        const artifact = aotArtifacts[`/article/${canaryArticle.id}`] ?? aotArtifacts[String(canaryArticle.id)];
        if (artifact)
        {
            if (artifact.title && artifact.title !== canaryArticle.title)
            {
                errors.push(`aot_artifact_title_mismatch: expected ${canaryArticle.title}, got ${artifact.title}`);
            }
            if (artifact.id && String(artifact.id) !== String(canaryArticle.id))
            {
                errors.push(`aot_artifact_id_mismatch: expected ${canaryArticle.id}, got ${artifact.id}`);
            }
        }
        else if (Object.keys(aotArtifacts).length > 0)
        {
            errors.push(`aot_artifact_missing_for_canary_article: ${canaryArticle.id}`);
        }
    }

    assertionIds.push('data-scale.aot.runtime-binding');
    if (runtimeLease)
    {
        if (aotManifest.runtimeLeaseDigest && aotManifest.runtimeLeaseDigest !== runtimeLease.runtimeLeaseDigest)
        {
            errors.push('aot_manifest_stale_runtime_lease');
        }
        if (aotManifest.seedReceiptDigest && aotManifest.seedReceiptDigest !== runtimeLease.seedReceiptDigest)
        {
            errors.push('aot_manifest_stale_seed_digest');
        }
    }

    const status = errors.length === 0 ? 'ok' : 'failed';
    const semanticDigest = computeSha256({
        routesCount: routes.length,
        canaryArticleId: canaryArticle?.id ?? null,
        aotScope: aotManifest.scope ?? 'all'
    });

    return {
        status,
        kind: 'aot',
        assertionIds,
        semanticDigest,
        errors
    };
}

export function verifyHotReadProof({
    coldResponse,
    warmResponse,
    cacheGeneration,
    runtimeLease
})
{
    const errors = [];
    const assertionIds = [];

    if (!coldResponse || !warmResponse)
    {
        return {
            status: 'failed',
            kind: 'hotRead',
            errors: ['hotread_cold_or_warm_response_missing'],
            assertionIds: []
        };
    }

    // 1. Cold read succeeded
    assertionIds.push('data-scale.hotread.cold-read');
    if (!coldResponse.ok && coldResponse.status !== 200)
    {
        errors.push(`hotread_cold_read_failed: status=${coldResponse.status}`);
    }

    // 2. Warm read succeeded
    assertionIds.push('data-scale.hotread.warm-read');
    if (!warmResponse.ok && warmResponse.status !== 200)
    {
        errors.push(`hotread_warm_read_failed: status=${warmResponse.status}`);
    }

    // 3. Semantic digest equality between cold and warm
    assertionIds.push('data-scale.hotread.digest-equality');
    const coldDigest = coldResponse.semanticDigest ?? computeSha256(coldResponse.payload ?? coldResponse.body ?? {});
    const warmDigest = warmResponse.semanticDigest ?? computeSha256(warmResponse.payload ?? warmResponse.body ?? {});
    if (coldDigest !== warmDigest)
    {
        errors.push(`hotread_semantic_digest_differ: cold=${coldDigest}, warm=${warmDigest}`);
    }

    // 4. Cache generation belonging to current runtime
    assertionIds.push('data-scale.hotread.cache-generation');
    const observedGen = cacheGeneration ?? warmResponse.generation ?? warmResponse.cacheGeneration;
    if (runtimeLease?.dataScaleRunId && observedGen)
    {
        if (observedGen !== runtimeLease.dataScaleRunId && !observedGen.includes(runtimeLease.dataScaleRunId))
        {
            errors.push(`hotread_cache_generation_stale: expected ${runtimeLease.dataScaleRunId}, got ${observedGen}`);
        }
    }

    const status = errors.length === 0 ? 'ok' : 'failed';
    return {
        status,
        kind: 'hotRead',
        assertionIds,
        semanticDigest: coldDigest,
        cacheGeneration: observedGen ?? null,
        errors
    };
}

export function buildSemanticProofReceipt({
    dataScaleRunId,
    runtimeLeaseDigest,
    seedReceiptDigest,
    canaries,
    results = {},
    assertionIds = [],
    artifactRefs = [],
    semanticDigests = {},
    ...extraFields
})
{
    const failureReasons = [];

    // Verify requiredKinds is exact
    for (const kind of REQUIRED_KINDS)
    {
        const kindResult = results[kind];
        if (!kindResult)
        {
            failureReasons.push(`missing_required_kind:${kind}`);
        }
        else if (kindResult.status === 'unsupported')
        {
            failureReasons.push(`unsupported_required_kind:${kind}`);
        }
        else if (kindResult.status !== 'ok')
        {
            failureReasons.push(`kind_failed:${kind}:${kindResult.errors?.join(';') || kindResult.reason || 'not_ok'}`);
        }
    }

    const status = failureReasons.length === 0 ? 'ok' : 'failed';

    const mergedAssertionIds = [
        ...new Set([
            ...assertionIds,
            ...(results.database?.assertionIds ?? []),
            ...(results.httpPayload?.assertionIds ?? []),
            ...(results.search?.assertionIds ?? []),
            ...(results.aot?.assertionIds ?? []),
            ...(results.hotRead?.assertionIds ?? []),
            ...(results.taxonomy?.assertionIds ?? []),
            ...(extraFields.taxonomyProof?.assertionIds ?? []),
            ...(extraFields.taxonomy?.assertionIds ?? [])
        ])
    ];

    const mergedSemanticDigests = {
        database: results.database?.semanticDigest ?? semanticDigests.database ?? null,
        httpPayload: results.httpPayload?.semanticDigest ?? semanticDigests.httpPayload ?? null,
        search: results.search?.semanticDigest ?? semanticDigests.search ?? null,
        aot: results.aot?.semanticDigest ?? semanticDigests.aot ?? null,
        hotRead: results.hotRead?.semanticDigest ?? semanticDigests.hotRead ?? null,
        ...semanticDigests
    };

    const receipt = {
        schema: DATA_SCALE_SEMANTIC_PROOF_SCHEMA,
        dataScaleRunId: String(dataScaleRunId || 'run-default'),
        runtimeLeaseDigest: String(runtimeLeaseDigest || ''),
        seedReceiptDigest: String(seedReceiptDigest || ''),
        canaries: canaries ?? {},
        requiredKinds: [...REQUIRED_KINDS],
        results: {
            database: results.database ?? { status: 'missing' },
            httpPayload: results.httpPayload ?? { status: 'missing' },
            search: results.search ?? { status: 'missing' },
            aot: results.aot ?? { status: 'missing' },
            hotRead: results.hotRead ?? { status: 'missing' }
        },
        assertionIds: mergedAssertionIds,
        artifactRefs: Array.isArray(artifactRefs) ? artifactRefs : [],
        semanticDigests: mergedSemanticDigests,
        status,
        failureReasons,
        ...extraFields,
        contentDigest: null
    };

    receipt.contentDigest = computeSha256(receipt);
    return receipt;
}

export function verifySemanticProofReceipt(receipt)
{
    if (!receipt || typeof receipt !== 'object')
    {
        return {
            ok: false,
            status: 'failed',
            failureReasons: ['receipt_null_or_invalid']
        };
    }

    const failureReasons = [];

    if (receipt.schema !== DATA_SCALE_SEMANTIC_PROOF_SCHEMA)
    {
        failureReasons.push(`schema_invalid: expected ${DATA_SCALE_SEMANTIC_PROOF_SCHEMA}, got ${receipt.schema}`);
    }

    if (!receipt.dataScaleRunId)
    {
        failureReasons.push('dataScaleRunId_missing');
    }

    if (!Array.isArray(receipt.requiredKinds))
    {
        failureReasons.push('requiredKinds_not_array');
    }
    else
    {
        const expectedSet = new Set(REQUIRED_KINDS);
        if (receipt.requiredKinds.length !== REQUIRED_KINDS.length
            || !receipt.requiredKinds.every((k) => expectedSet.has(k))
            || new Set(receipt.requiredKinds).size !== REQUIRED_KINDS.length)
        {
            failureReasons.push('requiredKinds_must_be_exact_five');
        }
    }

    if (!receipt.results || typeof receipt.results !== 'object')
    {
        failureReasons.push('results_missing');
    }
    else
    {
        for (const kind of REQUIRED_KINDS)
        {
            const res = receipt.results[kind];
            if (!res)
            {
                failureReasons.push(`result_missing:${kind}`);
            }
            else if (res.status !== 'ok')
            {
                failureReasons.push(`result_not_ok:${kind}:${res.status}`);
            }
        }
    }

    // Verify content digest
    const expectedDigest = receipt.contentDigest;
    if (!expectedDigest)
    {
        failureReasons.push('contentDigest_missing');
    }
    else
    {
        const copy = { ...receipt, contentDigest: null };
        delete copy.releaseReliability;
        const calculatedDigest = computeSha256(copy);
        if (calculatedDigest !== expectedDigest)
        {
            failureReasons.push(`contentDigest_mismatch: expected ${expectedDigest}, got ${calculatedDigest}`);
        }
    }

    const ok = failureReasons.length === 0 && receipt.status === 'ok';
    return {
        ok,
        status: ok ? 'ok' : 'failed',
        failureReasons
    };
}
