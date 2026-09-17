import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildPostingsBlobForTerms,
    decodeSearchShard,
    encodeSearchShard,
    murmurHash3
} from '../../tools/data-scale/aeds-decoders.mjs';
import {
    DATA_SCALE_SEARCH_RECEIPT_SCHEMA,
    PRODUCT_SEARCH_API_KIND,
    PRODUCT_SEARCH_FRAME_TYPE,
    PRODUCT_SEARCH_HTTP_PATH,
    buildSearchApiExecution,
    buildSearchIndexReceipt,
    computeExpectedSearchModel,
    executeProductSearchHttpApi,
    verifySearchCleanupProof,
    verifySearchExecutionProof,
    verifySearchIndexReceipt
} from '../../tools/data-scale/search-evidence.mjs';

function buildMockEvidenceShard({
    tier = 'scale-xs',
    articleId = 1,
    title = `data-scale:data-scale:${tier}:article:${articleId} title_canary_${tier}_${articleId}`,
    summary = `Data scale fixture article ${articleId}`,
    titleToken = `title_canary_${tier}_${articleId}`,
    bodyToken = `body_canary_${tier}_${articleId}`,
    cjkToken = `规模分词检索验证_${tier}_${articleId}`,
    extraDocs = [],
    includeTitleToken = true,
    includeBodyToken = true,
    includeCjkToken = true,
    foreignHitToken = null
} = {})
{
    const termsInput = [];

    if (includeTitleToken && titleToken)
    {
        const hits = [{ articleId, titleTf: 1, metaTf: 0, bodyTf: 0, positions: [{ position: 0, length: 1, field: 0 }] }];
        if (foreignHitToken === 'title')
        {
            hits.push({ articleId: 999, titleTf: 1, metaTf: 0, bodyTf: 0, positions: [{ position: 1, length: 1, field: 0 }] });
        }
        termsInput.push({
            hash: murmurHash3(titleToken),
            idf: 1.5,
            hits
        });
    }

    if (includeBodyToken && bodyToken)
    {
        const hits = [{ articleId, titleTf: 0, metaTf: 0, bodyTf: 2, positions: [{ position: 10, length: 1, field: 1 }] }];
        if (foreignHitToken === 'body')
        {
            hits.push({ articleId: 999, titleTf: 0, metaTf: 0, bodyTf: 1, positions: [{ position: 11, length: 1, field: 1 }] });
        }
        termsInput.push({
            hash: murmurHash3(bodyToken),
            idf: 1.8,
            hits
        });
    }

    if (includeCjkToken && cjkToken)
    {
        const hits = [{ articleId, titleTf: 0, metaTf: 0, bodyTf: 1, positions: [{ position: 20, length: 1, field: 1 }] }];
        if (foreignHitToken === 'cjk')
        {
            hits.push({ articleId: 999, titleTf: 0, metaTf: 0, bodyTf: 1, positions: [{ position: 21, length: 1, field: 1 }] });
        }
        termsInput.push({
            hash: murmurHash3(cjkToken),
            idf: 2.0,
            hits
        });
        for (const ch of cjkToken)
        {
            termsInput.push({
                hash: murmurHash3(ch),
                idf: 2.0,
                hits
            });
        }
    }

    const { postingsBlob, terms } = buildPostingsBlobForTerms(termsInput);

    const docs = [
        {
            articleId,
            title,
            summary,
            categoryIndex: 0
        },
        ...extraDocs
    ];

    const shardBuf = encodeSearchShard({
        role: 0,
        flags: 1,
        docs,
        terms,
        postingsBlob
    });
    return {
        decodedShard: decodeSearchShard(shardBuf),
        shardBuf
    };
}

function buildValidMockReceipt(overrides = {})
{
    return buildSearchIndexReceipt({
        dataScaleRunId: 'run-1',
        tier: 'scale-xs',
        indexedArticleIds: overrides.indexedArticleIds || [1],
        indexedDocumentCount: overrides.indexedDocumentCount ?? (overrides.indexedArticleIds || [1]).length,
        indexGeneration: overrides.indexGeneration || 'gen-1',
        indexStorageDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        tokenizerDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        dictionaryDigest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
        policyDigest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
        ...overrides
    });
}

function buildApiExecutions({
    expectedModel,
    canaryArticleId = 1,
    indexGeneration = 'gen-1',
    omitKind = null,
    missKind = null,
    foreignKind = null,
    source = PRODUCT_SEARCH_API_KIND,
    available = true
} = {})
{
    const tokens = {
        title: expectedModel.tokens.titleSearchToken,
        body: expectedModel.tokens.bodySearchToken,
        cjk: expectedModel.tokens.cjkSearchToken
    };
    const executions = [];
    for (const [tokenKind, query] of Object.entries(tokens))
    {
        if (omitKind === tokenKind)
        {
            continue;
        }
        let articleIds = [canaryArticleId];
        if (missKind === tokenKind)
        {
            articleIds = [];
        }
        if (foreignKind === tokenKind)
        {
            articleIds = [canaryArticleId, 999];
        }
        executions.push(buildSearchApiExecution({
            tokenKind,
            query,
            available,
            source,
            articleIds,
            indexGeneration,
            frameType: PRODUCT_SEARCH_FRAME_TYPE,
            route: PRODUCT_SEARCH_HTTP_PATH,
            statusCode: available ? 200 : 503
        }));
    }
    return executions;
}

test('1. fails when published>0 style proof has no index / API', () =>
{
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const resultMissingApi = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: buildMockEvidenceShard().decodedShard,
        indexReceipt: buildValidMockReceipt(),
        expectedModel
    });
    assert.equal(resultMissingApi.status, 'failed');
    assert.ok(resultMissingApi.errors.some((e) => e.includes('search_api_unavailable')));

    const resultMissingManifest = verifySearchExecutionProof({
        manifest: null,
        searchApiExecutions: buildApiExecutions({ expectedModel }),
        expectedModel
    });
    assert.equal(resultMissingManifest.status, 'failed');
    assert.ok(resultMissingManifest.errors.some((e) => e.includes('search_manifest_missing_or_invalid')));
});

test('2. fails when title token is missing from Search API hits', () =>
{
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const result = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: buildMockEvidenceShard().decodedShard,
        indexReceipt: buildValidMockReceipt({ indexGeneration: 'gen-1' }),
        expectedModel,
        searchApiExecutions: buildApiExecutions({ expectedModel, missKind: 'title' })
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('search_token_missing_hit') && e.includes('title')));
});

test('3. fails when body-only token is missing from Search API hits', () =>
{
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const result = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: buildMockEvidenceShard().decodedShard,
        indexReceipt: buildValidMockReceipt({ indexGeneration: 'gen-1' }),
        expectedModel,
        searchApiExecutions: buildApiExecutions({ expectedModel, missKind: 'body' })
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('search_token_missing_hit') && e.includes('body')));
});

test('4. fails when CJK token is missing from Search API hits', () =>
{
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const result = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: buildMockEvidenceShard().decodedShard,
        indexReceipt: buildValidMockReceipt({ indexGeneration: 'gen-1' }),
        expectedModel,
        searchApiExecutions: buildApiExecutions({ expectedModel, missKind: 'cjk' })
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('search_token_missing_hit') && e.includes('cjk')));
});

test('5. fails when Search API response includes a foreign article', () =>
{
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const result = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: buildMockEvidenceShard().decodedShard,
        indexReceipt: buildValidMockReceipt({ indexGeneration: 'gen-1' }),
        expectedModel,
        searchApiExecutions: buildApiExecutions({ expectedModel, foreignKind: 'title' })
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('search_token_unexpected_hit')));
});

test('6. fails when index generation and Search API generation disagree', () =>
{
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const result = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: buildMockEvidenceShard().decodedShard,
        indexReceipt: buildValidMockReceipt({ indexGeneration: 'gen-1' }),
        expectedModel,
        searchApiExecutions: buildApiExecutions({ expectedModel, indexGeneration: 'gen-other' })
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('generation_mismatch')));
});

test('7. fails when rebuild/manifest is unsupported or not-configured', () =>
{
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const unsupportedResult = verifySearchExecutionProof({
        manifest: { status: 'unsupported', currentVersion: 'gen-1' },
        searchApiExecutions: buildApiExecutions({ expectedModel }),
        expectedModel
    });
    assert.equal(unsupportedResult.status, 'failed');
    assert.ok(unsupportedResult.errors.some((e) => e.includes('search_unsupported_or_not_configured')));

    const notConfiguredResult = verifySearchExecutionProof({
        manifest: { status: 'not-configured', currentVersion: 'gen-1' },
        searchApiExecutions: buildApiExecutions({ expectedModel }),
        expectedModel
    });
    assert.equal(notConfiguredResult.status, 'failed');
    assert.ok(notConfiguredResult.errors.some((e) => e.includes('search_unsupported_or_not_configured')));
});

test('8. fails when cleanup Search API still returns canary or generation is stale', () =>
{
    const tokens = {
        title: 'title_canary_scale-xs_1',
        body: 'body_canary_scale-xs_1',
        cjk: '规模分词检索验证_scale-xs_1'
    };
    const stillPresent = Object.entries(tokens).map(([tokenKind, query]) => buildSearchApiExecution({
        tokenKind,
        query,
        articleIds: [1],
        indexGeneration: 'gen-2'
    }));
    const resultStillPresent = verifySearchCleanupProof({
        tokens,
        beforeGeneration: 'gen-1',
        afterGeneration: 'gen-2',
        canaryArticleId: 1,
        searchApiExecutions: stillPresent
    });
    assert.equal(resultStillPresent.status, 'failed');
    assert.ok(resultStillPresent.errors.some((e) => e.includes('still searchable after cleanup')));

    const cleanExecutions = Object.entries(tokens).map(([tokenKind, query]) => buildSearchApiExecution({
        tokenKind,
        query,
        articleIds: [],
        indexGeneration: 'gen-1'
    }));
    const resultStaleGen = verifySearchCleanupProof({
        tokens,
        beforeGeneration: 'gen-1',
        afterGeneration: 'gen-1',
        canaryArticleId: 1,
        searchApiExecutions: cleanExecutions
    });
    assert.equal(resultStaleGen.status, 'failed');
    assert.ok(resultStaleGen.errors.some((e) => e.includes('generation was not advanced')));
});

test('9. fails when index receipt is missing policy or tokenizer digest', () =>
{
    const invalidReceipt = {
        schema: DATA_SCALE_SEARCH_RECEIPT_SCHEMA,
        status: 'ok',
        dataScaleRunId: 'run-1',
        indexGeneration: 'gen-1',
        indexedDocumentCount: 1,
        indexedArticleIds: [1],
        digests: {
            indexStorageDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
        }
    };

    const verificationResult = verifySearchIndexReceipt(invalidReceipt);
    assert.equal(verificationResult.status, 'failed');
    assert.ok(verificationResult.errors.some((e) => e.includes('missing required digests')));

    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const proofResult = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: buildMockEvidenceShard().decodedShard,
        indexReceipt: invalidReceipt,
        expectedModel,
        searchApiExecutions: buildApiExecutions({ expectedModel })
    });
    assert.equal(proofResult.status, 'failed');
});

test('10. fails when database LIKE / JS shard / list-keyword substitutes for Search API', () =>
{
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const { decodedShard } = buildMockEvidenceShard();

    const resultPseudo = verifySearchExecutionProof({
        manifest: {
            currentVersion: 'gen-1',
            coverage: { searchPath: true }
        },
        shard: decodedShard,
        indexReceipt: buildValidMockReceipt({ indexGeneration: 'gen-1', indexedDocumentCount: 1, indexedArticleIds: [1] }),
        expectedModel,
        searchApiExecutions: buildApiExecutions({ expectedModel })
    });
    assert.equal(resultPseudo.status, 'failed');
    assert.ok(resultPseudo.errors.some((e) => e.includes('pseudo_search_coverage_prohibited')));

    const resultDbLike = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: {
            source: 'database-like-query',
            isDatabaseLike: true,
            docs: [{ articleId: 1, title: 'data-scale:article:1 title_canary_scale_xs_1' }]
        },
        indexReceipt: buildValidMockReceipt({ indexGeneration: 'gen-1', indexedDocumentCount: 1, indexedArticleIds: [1] }),
        expectedModel,
        searchApiExecutions: buildApiExecutions({ expectedModel })
    });
    assert.equal(resultDbLike.status, 'failed');
    assert.ok(resultDbLike.errors.some((e) => e.includes('database_like_query_substitution_prohibited')));

    const resultJsShard = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: decodedShard,
        indexReceipt: buildValidMockReceipt({ indexGeneration: 'gen-1' }),
        expectedModel,
        searchApiExecutions: buildApiExecutions({ expectedModel, source: 'js-querySearchShard' })
    });
    assert.equal(resultJsShard.status, 'failed');
    assert.ok(resultJsShard.errors.some((e) => e.includes('js_shard_query_substitution_prohibited') || e.includes('search_api_source_prohibited') || e.includes('search_api_substitute_prohibited')));
});

test('positive: succeeds when Search HTTP API executions match canaries and receipt', () =>
{
    const { decodedShard } = buildMockEvidenceShard();
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const receipt = buildValidMockReceipt({ indexGeneration: 'gen-test-v1', indexedDocumentCount: 1, indexedArticleIds: [1] });

    const result = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-test-v1' },
        shard: decodedShard,
        indexReceipt: receipt,
        expectedModel,
        searchApiExecutions: buildApiExecutions({ expectedModel, indexGeneration: 'gen-test-v1' })
    });

    assert.equal(result.status, 'ok', result.errors.join('; '));
    assert.equal(result.errors.length, 0);
    assert.ok(result.assertionIds.includes('data-scale.search.api'));
    assert.ok(result.assertionIds.includes('data-scale.search.token.title'));
    assert.ok(result.assertionIds.includes('data-scale.search.token.body'));
    assert.ok(result.assertionIds.includes('data-scale.search.token.cjk'));
});

test('positive: succeeds when cleanup Search API returns zero canary hits and advances generation', () =>
{
    const tokens = {
        title: 'title_canary_scale-xs_1',
        body: 'body_canary_scale-xs_1',
        cjk: '规模分词检索验证_scale-xs_1'
    };
    const cleanupResult = verifySearchCleanupProof({
        tokens,
        beforeGeneration: 'gen-1',
        afterGeneration: 'gen-2',
        canaryArticleId: 1,
        searchApiExecutions: Object.entries(tokens).map(([tokenKind, query]) => buildSearchApiExecution({
            tokenKind,
            query,
            articleIds: [],
            indexGeneration: 'gen-2'
        }))
    });

    assert.equal(cleanupResult.status, 'ok', cleanupResult.errors.join('; '));
    assert.equal(cleanupResult.errors.length, 0);
});

test('executeProductSearchHttpApi fail-closes when Search API is unavailable', async () =>
{
    const missing = await executeProductSearchHttpApi({ baseUrl: null, query: 'title_canary' });
    assert.equal(missing.available, false);
    assert.ok(String(missing.reason).includes('search_api_unavailable'));

    const notFound = await executeProductSearchHttpApi({
        baseUrl: 'http://fixture',
        query: 'title_canary',
        fetchImpl: async () => new Response(new Uint8Array(), { status: 404 })
    });
    assert.equal(notFound.available, false);
    assert.equal(notFound.statusCode, 404);
});
