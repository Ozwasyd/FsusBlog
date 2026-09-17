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
    verifySearchProof
} from '../../tools/data-scale/semantic-proof.mjs';
import {
    PRODUCT_SEARCH_API_KIND,
    PRODUCT_SEARCH_FRAME_TYPE,
    PRODUCT_SEARCH_HTTP_PATH,
    buildSearchApiExecution,
    buildSearchIndexReceipt
} from '../../tools/data-scale/search-evidence.mjs';

function buildApiExecutions({
    searchToken = 'data-scale-search-1',
    articleId = 1,
    indexGeneration = 'search-v1-hash',
    titleToken = searchToken,
    bodyToken = null,
    cjkToken = null
} = {})
{
    const tokens = {
        title: titleToken,
        body: bodyToken,
        cjk: cjkToken
    };
    const executions = [];
    for (const [tokenKind, query] of Object.entries(tokens))
    {
        if (!query)
        {
            continue;
        }
        executions.push(buildSearchApiExecution({
            tokenKind,
            query,
            articleIds: [articleId],
            indexGeneration,
            source: PRODUCT_SEARCH_API_KIND,
            frameType: PRODUCT_SEARCH_FRAME_TYPE,
            route: PRODUCT_SEARCH_HTTP_PATH
        }));
    }
    // verifySearchExecutionProof always requires title/body/cjk; supply body/cjk defaults when omitted
    if (!bodyToken)
    {
        executions.push(buildSearchApiExecution({
            tokenKind: 'body',
            query: `${searchToken}-body`,
            articleIds: [articleId],
            indexGeneration,
            route: PRODUCT_SEARCH_HTTP_PATH
        }));
    }
    if (!cjkToken)
    {
        executions.push(buildSearchApiExecution({
            tokenKind: 'cjk',
            query: `${searchToken}-cjk`,
            articleIds: [articleId],
            indexGeneration,
            route: PRODUCT_SEARCH_HTTP_PATH
        }));
    }
    return executions;
}

function buildReceipt(indexGeneration = 'search-v1-hash')
{
    return buildSearchIndexReceipt({
        dataScaleRunId: 'run-search-proof',
        tier: 'scale-m',
        indexedArticleIds: [1],
        indexedDocumentCount: 1,
        indexGeneration,
        indexStorageDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        tokenizerDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        dictionaryDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        policyDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    });
}

function buildMockShard({ articleId = 1, title = 'data-scale:local:scale-m:article:1', searchToken = 'data-scale-search-1' } = {})
{
    const tokenHash = murmurHash3(searchToken);
    const { postingsBlob, terms } = buildPostingsBlobForTerms([
        {
            hash: tokenHash,
            idf: 1.5,
            hits: [{
                articleId,
                titleTf: 2,
                metaTf: 1,
                bodyTf: 3,
                positions: [{ position: 0, length: 1, field: 0 }]
            }]
        }
    ]);

    const shardBuf = encodeSearchShard({
        role: 0,
        flags: 1,
        docs: [
            {
                articleId,
                title,
                summary: `Summary containing ${searchToken}`,
                categoryIndex: 0
            }
        ],
        terms,
        postingsBlob
    });

    return { shardBuf, decodedShard: decodeSearchShard(shardBuf) };
}

test('decodes valid search manifest and shard, verifying canary article is returned for search token', () =>
{
    const { decodedShard } = buildMockShard();
    const manifest = {
        schemaVersion: 4,
        currentVersion: 'search-v1-hash',
        shards: [{ role: 0, fullUrl: '/search/index.core.bin' }]
    };

    const searchProof = verifySearchProof({
        manifest,
        shard: decodedShard,
        searchToken: 'data-scale-search-1',
        expectedArticleId: 1,
        indexReceipt: buildReceipt(manifest.currentVersion),
        searchApiExecutions: buildApiExecutions({ indexGeneration: manifest.currentVersion }),
        canaries: {
            article: {
                id: 1,
                titleSearchToken: 'data-scale-search-1',
                bodySearchToken: 'data-scale-search-1-body',
                cjkSearchToken: 'data-scale-search-1-cjk'
            }
        }
    });

    assert.equal(searchProof.status, 'ok', searchProof.errors.join('; '));
    assert.equal(searchProof.errors.length, 0);
    assert.ok(searchProof.assertionIds.includes('data-scale.search.query-hit'));

    // Also test querySearchShard helper directly
    const hits = querySearchShard(decodedShard, 'data-scale-search-1');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].articleId, 1);
});

test('fails when search status is unsupported', () =>
{
    const { decodedShard } = buildMockShard();
    const manifest = {
        status: 'unsupported',
        currentVersion: 'v1'
    };

    const searchProof = verifySearchProof({
        manifest,
        shard: decodedShard,
        searchToken: 'data-scale-search-1',
        expectedArticleId: 1
    });

    assert.equal(searchProof.status, 'failed');
    assert.ok(searchProof.errors.some((e) => e.includes('unsupported')));
});

test('fails when search status is not-configured', () =>
{
    const { decodedShard } = buildMockShard();
    const manifest = {
        status: 'not-configured',
        currentVersion: 'v1'
    };

    const searchProof = verifySearchProof({
        manifest,
        shard: decodedShard,
        searchToken: 'data-scale-search-1',
        expectedArticleId: 1
    });

    assert.equal(searchProof.status, 'failed');
    assert.ok(searchProof.errors.some((e) => e.includes('unsupported_or_not_configured')));
});

test('fails when search manifest is missing or version is invalid', () =>
{
    const { decodedShard } = buildMockShard();
    const proofMissing = verifySearchProof({
        manifest: null,
        shard: decodedShard,
        searchToken: 'data-scale-search-1',
        expectedArticleId: 1
    });
    assert.equal(proofMissing.status, 'failed');

    const proofBadVersion = verifySearchProof({
        manifest: { schemaVersion: 4, currentVersion: '' },
        shard: decodedShard,
        searchToken: 'data-scale-search-1',
        expectedArticleId: 1
    });
    assert.equal(proofBadVersion.status, 'failed');
    assert.ok(proofBadVersion.errors.some((e) => e.includes('search_manifest_version_invalid')));
});

test('fails when shard header magic or version is invalid', () =>
{
    const { shardBuf } = buildMockShard();
    // Tamper with magic
    const tampered = new Uint8Array(shardBuf);
    new DataView(tampered.buffer, tampered.byteOffset, tampered.byteLength).setUint32(0, 0x11223344, true);

    assert.throws(() => decodeSearchShard(tampered), (err) => (
        err instanceof Error && err.message.includes('search_shard_magic_or_version_invalid')
    ));

    const badShardObj = {
        magic: 0x11223344,
        version: 4,
        docs: []
    };
    const proof = verifySearchProof({
        manifest: { currentVersion: 'v1' },
        shard: badShardObj,
        searchToken: 'data-scale-search-1',
        expectedArticleId: 1,
        indexReceipt: buildReceipt('v1'),
        searchApiExecutions: buildApiExecutions({ indexGeneration: 'v1' }),
        canaries: {
            article: {
                id: 1,
                titleSearchToken: 'data-scale-search-1',
                bodySearchToken: 'data-scale-search-1-body',
                cjkSearchToken: 'data-scale-search-1-cjk'
            }
        }
    });
    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('search_shard_header_invalid') || e.includes('search_api_unavailable') || e.includes('search_token_missing_hit')));
});

test('fails when search query returns wrong article ID', () =>
{
    const { decodedShard } = buildMockShard({ articleId: 999 });
    const manifest = { currentVersion: 'v1' };

    const searchProof = verifySearchProof({
        manifest,
        shard: decodedShard,
        searchToken: 'data-scale-search-1',
        expectedArticleId: 1, // expecting 1, but shard has 999
        indexReceipt: buildReceipt('v1'),
        searchApiExecutions: buildApiExecutions({ indexGeneration: 'v1', articleId: 999 }),
        canaries: {
            article: {
                id: 1,
                titleSearchToken: 'data-scale-search-1',
                bodySearchToken: 'data-scale-search-1-body',
                cjkSearchToken: 'data-scale-search-1-cjk'
            }
        }
    });

    assert.equal(searchProof.status, 'failed');
    assert.ok(searchProof.errors.some((e) =>
        e.includes('search_shard_missing_canary_article')
        || e.includes('search_token_missing_hit')
        || e.includes('search_token_unexpected_hit')));
});

test('fails when search query returns empty results / canary missing from shard', () =>
{
    const shardBuf = encodeSearchShard({
        role: 0,
        flags: 1,
        docs: [{ articleId: 50, title: 'other article', summary: 'other summary' }],
        terms: []
    });
    const decodedShard = decodeSearchShard(shardBuf);

    const searchProof = verifySearchProof({
        manifest: { currentVersion: 'v1' },
        shard: decodedShard,
        searchToken: 'data-scale-search-1',
        expectedArticleId: 1,
        indexReceipt: buildReceipt('v1'),
        searchApiExecutions: buildApiExecutions({ indexGeneration: 'v1', articleId: 50 }),
        canaries: {
            article: {
                id: 1,
                titleSearchToken: 'data-scale-search-1',
                bodySearchToken: 'data-scale-search-1-body',
                cjkSearchToken: 'data-scale-search-1-cjk'
            }
        }
    });

    assert.equal(searchProof.status, 'failed');
    assert.ok(searchProof.errors.some((e) =>
        e.includes('missing_canary_article')
        || e.includes('search_token_missing_hit')
        || e.includes('search_token_unexpected_hit')));
});

test('fails when search manifest is from a stale runtime lease', () =>
{
    const { decodedShard } = buildMockShard();
    const manifest = {
        currentVersion: 'v1',
        runtimeLeaseDigest: 'sha256:old-run-digest'
    };

    const searchProof = verifySearchProof({
        manifest,
        shard: decodedShard,
        searchToken: 'data-scale-search-1',
        expectedArticleId: 1,
        indexReceipt: buildReceipt('v1'),
        searchApiExecutions: buildApiExecutions({ indexGeneration: 'v1' }),
        canaries: {
            article: {
                id: 1,
                titleSearchToken: 'data-scale-search-1',
                bodySearchToken: 'data-scale-search-1-body',
                cjkSearchToken: 'data-scale-search-1-cjk'
            }
        },
        runtimeLease: {
            runtimeLeaseDigest: 'sha256:current-run-digest'
        }
    });

    assert.equal(searchProof.status, 'failed');
    assert.ok(searchProof.errors.some((e) => e.includes('search_manifest_stale_runtime_lease')));
});
