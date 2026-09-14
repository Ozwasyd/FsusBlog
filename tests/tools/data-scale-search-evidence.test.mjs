import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildPostingsBlobForTerms,
    decodeSearchShard,
    encodeSearchShard,
    murmurHash3,
    querySearchShard
} from '../../tools/data-scale/aeds-decoders.mjs';
import {
    DATA_SCALE_SEARCH_RECEIPT_SCHEMA,
    buildSearchIndexReceipt,
    computeExpectedSearchModel,
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
        // Add full token hash and unigram hashes
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

    return { shardBuf, decodedShard: decodeSearchShard(shardBuf) };
}

function buildValidMockReceipt({
    indexGeneration = 'gen-test-v1',
    indexedDocumentCount = 1,
    indexedArticleIds = [1],
    tokenizerDigest = 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    dictionaryDigest = 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    policyDigest = 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    indexStorageDigest = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
} = {})
{
    return buildSearchIndexReceipt({
        dataScaleRunId: 'run-test-1',
        tier: 'scale-xs',
        namespace: 'data-scale',
        indexGeneration,
        indexedDocumentCount,
        indexedArticleIds,
        indexStorageDigest,
        tokenizerDigest,
        dictionaryDigest,
        policyDigest
    });
}

// 1. published>0但未构建index：失败
test('1. fails when published > 0 but search index is missing or not built', () =>
{
    const expectedModel = computeExpectedSearchModel({ articleCount: 10, tier: 'scale-xs' });
    assert.ok(expectedModel.searchableCount > 0, 'model has published articles');

    const resultMissingShard = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: null,
        indexReceipt: buildValidMockReceipt(),
        expectedModel
    });
    assert.equal(resultMissingShard.status, 'failed');
    assert.ok(resultMissingShard.errors.some((e) => e.includes('search_shard_missing_or_invalid')));

    const resultMissingManifest = verifySearchExecutionProof({
        manifest: null,
        shard: { magic: 0x32534846, version: 4, docs: [] },
        indexReceipt: buildValidMockReceipt(),
        expectedModel
    });
    assert.equal(resultMissingManifest.status, 'failed');
    assert.ok(resultMissingManifest.errors.some((e) => e.includes('search_manifest_missing_or_invalid')));
});

// 2. index count正确但title token查不到：失败
test('2. fails when index count matches but title token is missing', () =>
{
    const { decodedShard } = buildMockEvidenceShard({ includeTitleToken: false });
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const receipt = buildValidMockReceipt({ indexGeneration: 'gen-1', indexedDocumentCount: 1, indexedArticleIds: [1] });

    const result = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: decodedShard,
        indexReceipt: receipt,
        expectedModel
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('search_token_missing_hit: title')));
});

// 3. body-only token未被索引：失败
test('3. fails when body-only token is missing from search index', () =>
{
    const { decodedShard } = buildMockEvidenceShard({ includeBodyToken: false });
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const receipt = buildValidMockReceipt({ indexGeneration: 'gen-1', indexedDocumentCount: 1, indexedArticleIds: [1] });

    const result = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: decodedShard,
        indexReceipt: receipt,
        expectedModel
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('search_token_missing_hit: body')));
});

// 4. CJK token分词错误：失败
test('4. fails when CJK token is missing or failed tokenization in search index', () =>
{
    const { decodedShard } = buildMockEvidenceShard({ includeCjkToken: false });
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const receipt = buildValidMockReceipt({ indexGeneration: 'gen-1', indexedDocumentCount: 1, indexedArticleIds: [1] });

    const result = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: decodedShard,
        indexReceipt: receipt,
        expectedModel
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('search_token_missing_hit: cjk')));
});

// 5. search response包含错误article：失败
test('5. fails when search token returns unexpected foreign article ID', () =>
{
    const { decodedShard } = buildMockEvidenceShard({ foreignHitToken: 'title' });
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const receipt = buildValidMockReceipt({ indexGeneration: 'gen-1', indexedDocumentCount: 1, indexedArticleIds: [1] });

    const result = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: decodedShard,
        indexReceipt: receipt,
        expectedModel
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('search_token_unexpected_hit: title')));
});

// 6. index generation与response generation不一致：失败
test('6. fails when index generation in receipt does not match manifest generation', () =>
{
    const { decodedShard } = buildMockEvidenceShard();
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const receipt = buildValidMockReceipt({ indexGeneration: 'gen-from-receipt-v1', indexedDocumentCount: 1, indexedArticleIds: [1] });

    const result = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-from-manifest-v2' },
        shard: decodedShard,
        indexReceipt: receipt,
        expectedModel
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('generation_mismatch')));
});

// 7. rebuild hook missing/unsupported：失败
test('7. fails when rebuild hook is missing or manifest status is unsupported/not-configured', () =>
{
    const { decodedShard } = buildMockEvidenceShard();
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const receipt = buildValidMockReceipt({ indexGeneration: 'gen-1', indexedDocumentCount: 1, indexedArticleIds: [1] });

    const unsupportedResult = verifySearchExecutionProof({
        manifest: { status: 'unsupported', currentVersion: 'gen-1' },
        shard: decodedShard,
        indexReceipt: receipt,
        expectedModel
    });
    assert.equal(unsupportedResult.status, 'failed');
    assert.ok(unsupportedResult.errors.some((e) => e.includes('search_unsupported_or_not_configured')));

    const notConfiguredResult = verifySearchExecutionProof({
        manifest: { status: 'not-configured', currentVersion: 'gen-1' },
        shard: decodedShard,
        indexReceipt: receipt,
        expectedModel
    });
    assert.equal(notConfiguredResult.status, 'failed');
    assert.ok(notConfiguredResult.errors.some((e) => e.includes('search_unsupported_or_not_configured')));
});

// 8. cleanup后token仍可搜索：失败
test('8. fails when canary token is still searchable or generation is not advanced after cleanup', () =>
{
    const { decodedShard } = buildMockEvidenceShard();
    const tokens = {
        title: 'title_canary_scale-xs_1',
        body: 'body_canary_scale-xs_1',
        cjk: '规模分词检索验证_scale-xs_1'
    };

    // Case A: token still searchable in shard after cleanup
    const resultTokenStillPresent = verifySearchCleanupProof({
        shardAfterCleanup: decodedShard,
        tokens,
        beforeGeneration: 'gen-1',
        afterGeneration: 'gen-2',
        canaryArticleId: 1
    });
    assert.equal(resultTokenStillPresent.status, 'failed');
    assert.ok(resultTokenStillPresent.errors.some((e) => e.includes('still searchable after cleanup')));

    // Case B: generation did not advance
    const cleanEmptyShardBuf = encodeSearchShard({ role: 0, flags: 1, docs: [], terms: [] });
    const cleanEmptyShard = decodeSearchShard(cleanEmptyShardBuf);
    const resultStaleGen = verifySearchCleanupProof({
        shardAfterCleanup: cleanEmptyShard,
        tokens,
        beforeGeneration: 'gen-1',
        afterGeneration: 'gen-1',
        canaryArticleId: 1
    });
    assert.equal(resultStaleGen.status, 'failed');
    assert.ok(resultStaleGen.errors.some((e) => e.includes('generation was not advanced')));
});

// 9. index receipt缺policy/tokenizer digest：失败
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
            // missing tokenizerDigest, dictionaryDigest, policyDigest
        }
    };

    const verificationResult = verifySearchIndexReceipt(invalidReceipt);
    assert.equal(verificationResult.status, 'failed');
    assert.ok(verificationResult.errors.some((e) => e.includes('missing required digests')));

    const { decodedShard } = buildMockEvidenceShard();
    const proofResult = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: decodedShard,
        indexReceipt: invalidReceipt,
        expectedModel: computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' })
    });
    assert.equal(proofResult.status, 'failed');
});

// 10. 仅数据库LIKE查询替代search API：失败
test('10. fails when database LIKE query or pseudo coverage is used to substitute search API', () =>
{
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });

    // Case A: manifest has coverage.searchPath (pseudo coverage)
    const { decodedShard } = buildMockEvidenceShard();
    const resultPseudo = verifySearchExecutionProof({
        manifest: {
            currentVersion: 'gen-1',
            coverage: { searchPath: true }
        },
        shard: decodedShard,
        indexReceipt: buildValidMockReceipt({ indexGeneration: 'gen-1', indexedDocumentCount: 1, indexedArticleIds: [1] }),
        expectedModel
    });
    assert.equal(resultPseudo.status, 'failed');
    assert.ok(resultPseudo.errors.some((e) => e.includes('pseudo_search_coverage_prohibited')));

    // Case B: database LIKE query substitute passed as shard
    const dbLikeShard = {
        source: 'database-like-query',
        isDatabaseLike: true,
        docs: [{ articleId: 1, title: 'data-scale:article:1 title_canary_scale_xs_1' }]
    };
    const resultDbLike = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-1' },
        shard: dbLikeShard,
        indexReceipt: buildValidMockReceipt({ indexGeneration: 'gen-1', indexedDocumentCount: 1, indexedArticleIds: [1] }),
        expectedModel
    });
    assert.equal(resultDbLike.status, 'failed');
    assert.ok(resultDbLike.errors.some((e) => e.includes('database_like_query_substitution_prohibited')));
});

// Positive end-to-end: valid manifest, shard with all 3 canaries, matching expected model & receipt
test('positive: succeeds when all search evidence matches contract and canaries are exact', () =>
{
    const { decodedShard } = buildMockEvidenceShard();
    const expectedModel = computeExpectedSearchModel({ articleCount: 1, tier: 'scale-xs' });
    const receipt = buildValidMockReceipt({ indexGeneration: 'gen-test-v1', indexedDocumentCount: 1, indexedArticleIds: [1] });

    const result = verifySearchExecutionProof({
        manifest: { currentVersion: 'gen-test-v1' },
        shard: decodedShard,
        indexReceipt: receipt,
        expectedModel
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.errors.length, 0);
    assert.ok(result.assertionIds.includes('data-scale.search.tokens'));
    assert.ok(result.assertionIds.includes('data-scale.search.token.title'));
    assert.ok(result.assertionIds.includes('data-scale.search.token.body'));
    assert.ok(result.assertionIds.includes('data-scale.search.token.cjk'));
});

// Positive cleanup: 0 canary docs, 0 canary token hits, generation advanced
test('positive: succeeds when cleanup removes canary docs and advances generation', () =>
{
    const cleanEmptyShardBuf = encodeSearchShard({ role: 0, flags: 1, docs: [], terms: [] });
    const cleanEmptyShard = decodeSearchShard(cleanEmptyShardBuf);
    const tokens = {
        title: 'title_canary_scale-xs_1',
        body: 'body_canary_scale-xs_1',
        cjk: '规模分词检索验证_scale-xs_1'
    };

    const cleanupResult = verifySearchCleanupProof({
        shardAfterCleanup: cleanEmptyShard,
        tokens,
        beforeGeneration: 'gen-1',
        afterGeneration: 'gen-2',
        canaryArticleId: 1
    });

    assert.equal(cleanupResult.status, 'ok');
    assert.equal(cleanupResult.errors.length, 0);
});
