import { createHash } from 'node:crypto';
import { murmurHash3, querySearchShard } from './aeds-decoders.mjs';

export const DATA_SCALE_SEARCH_RECEIPT_SCHEMA = 'fsusblog.data-scale-search-receipt.v1';
export const DATA_SCALE_SEARCH_EXECUTION_SCHEMA = 'fsusblog.data-scale-search-execution.v1';

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
 * Pure function to compute expected public searchable articles and canary tokens.
 */
export function computeExpectedSearchModel({
    articleCount = 10,
    tier = 'scale-xs',
    namespace = 'data-scale',
    prefix = null,
    businessEpochUtc = null
} = {})
{
    const effectivePrefix = prefix || `data-scale:${namespace}:${tier}`;
    const allArticles = [];
    const searchableArticles = [];

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
        const isSearchable = (!isDeleted && status === 2);

        const article = {
            seed,
            status,
            isDeleted,
            isSearchable,
            title: `${effectivePrefix}:article:${seed}`,
            titleSearchToken: `title_canary_${tier}_${seed}`,
            bodySearchToken: `body_canary_${tier}_${seed}`,
            cjkSearchToken: `规模分词检索验证_${tier}_${seed}`
        };

        allArticles.push(article);
        if (isSearchable)
        {
            searchableArticles.push(article);
        }
    }

    const canary = allArticles[0] || null;
    const tokens = {
        titleSearchToken: canary ? canary.titleSearchToken : `title_canary_${tier}_1`,
        bodySearchToken: canary ? canary.bodySearchToken : `body_canary_${tier}_1`,
        cjkSearchToken: canary ? canary.cjkSearchToken : `规模分词检索验证_${tier}_1`
    };

    const searchableArticleIds = searchableArticles.map((a) => a.seed);
    const searchableArticlesDigest = sha256Canonical(searchableArticleIds);

    return {
        tier,
        namespace,
        prefix: effectivePrefix,
        articleCount,
        businessEpochUtc,
        allArticles,
        searchableArticles,
        searchableArticleIds,
        searchableCount: searchableArticles.length,
        canary,
        tokens,
        searchableArticlesDigest
    };
}

/**
 * Build canonical search index receipt binding run identity, doc inventory, digests, and generation.
 */
export function buildSearchIndexReceipt({
    dataScaleRunId = 'run-default',
    tier = 'scale-xs',
    namespace = 'data-scale',
    indexedArticleIds = [],
    indexedDocumentCount = 0,
    indexGeneration = 'gen-1',
    indexStorageDigest = null,
    tokenizerDigest = 'sha256:tokenizer-default',
    dictionaryDigest = 'sha256:dictionary-default',
    policyDigest = 'sha256:policy-default',
    status = 'ok',
    reason = null,
    startedAt = null,
    completedAt = null
} = {})
{
    const errors = [];
    if (!tokenizerDigest || !tokenizerDigest.startsWith('sha256:'))
    {
        errors.push('search index receipt requires valid tokenizerDigest');
    }
    if (!dictionaryDigest || !dictionaryDigest.startsWith('sha256:'))
    {
        errors.push('search index receipt requires valid dictionaryDigest');
    }
    if (!policyDigest || !policyDigest.startsWith('sha256:'))
    {
        errors.push('search index receipt requires valid policyDigest');
    }
    if (!indexStorageDigest || !indexStorageDigest.startsWith('sha256:'))
    {
        errors.push('search index receipt requires valid indexStorageDigest');
    }
    if (!indexGeneration)
    {
        errors.push('search index receipt requires indexGeneration');
    }
    if (indexedDocumentCount !== indexedArticleIds.length)
    {
        errors.push(`indexedDocumentCount (${indexedDocumentCount}) does not match indexedArticleIds.length (${indexedArticleIds.length})`);
    }

    const effectiveStatus = (errors.length === 0 && status === 'ok') ? 'ok' : 'failed';

    const receipt = {
        schema: DATA_SCALE_SEARCH_RECEIPT_SCHEMA,
        status: effectiveStatus,
        dataScaleRunId,
        tier,
        namespace,
        indexGeneration,
        indexedDocumentCount,
        indexedArticleIds: [...indexedArticleIds].sort((a, b) => a - b),
        digests: {
            indexStorageDigest: indexStorageDigest || '',
            tokenizerDigest: tokenizerDigest || '',
            dictionaryDigest: dictionaryDigest || '',
            policyDigest: policyDigest || ''
        },
        errors,
        reason: reason || (errors.length > 0 ? errors.join('; ') : null),
        startedAt: startedAt || new Date().toISOString(),
        completedAt: completedAt || new Date().toISOString()
    };

    receipt.contentDigest = sha256Canonical(receipt);
    return receipt;
}

/**
 * Verify search index receipt.
 */
export function verifySearchIndexReceipt(receipt)
{
    if (!receipt || typeof receipt !== 'object')
    {
        return { status: 'failed', errors: ['search index receipt missing or null'] };
    }
    if (receipt.schema !== DATA_SCALE_SEARCH_RECEIPT_SCHEMA)
    {
        return { status: 'failed', errors: [`invalid schema: ${receipt.schema}`] };
    }
    if (receipt.status !== 'ok')
    {
        return { status: 'failed', errors: receipt.errors || [receipt.reason || 'search index receipt status not ok'] };
    }
    if (!receipt.indexGeneration)
    {
        return { status: 'failed', errors: ['missing indexGeneration'] };
    }
    if (!receipt.digests?.tokenizerDigest || !receipt.digests?.dictionaryDigest || !receipt.digests?.policyDigest || !receipt.digests?.indexStorageDigest)
    {
        return { status: 'failed', errors: ['missing required digests (tokenizer, dictionary, policy, storage)'] };
    }
    if (receipt.indexedDocumentCount !== receipt.indexedArticleIds?.length)
    {
        return { status: 'failed', errors: ['indexedDocumentCount mismatch with indexedArticleIds'] };
    }

    const copy = structuredClone(receipt);
    delete copy.contentDigest;
    if (receipt.contentDigest !== sha256Canonical(copy))
    {
        return { status: 'failed', errors: ['search index receipt contentDigest mismatch'] };
    }

    return { status: 'ok', errors: [] };
}

/**
 * Verify search execution proof against canonical index manifest, shard, and canary tokens.
 */
export function verifySearchExecutionProof({
    manifest,
    shard,
    indexReceipt,
    expectedModel,
    canaries = {},
    runtimeLease = null
} = {})
{
    const assertionIds = [];
    const errors = [];

    // 1. Manifest verification
    assertionIds.push('data-scale.search.manifest');
    if (!manifest || typeof manifest !== 'object')
    {
        return {
            status: 'failed',
            kind: 'search',
            assertionIds,
            errors: ['search_manifest_missing_or_invalid']
        };
    }

    if (manifest.status === 'unsupported' || manifest.status === 'not-configured')
    {
        return {
            status: 'failed',
            kind: 'search',
            assertionIds,
            errors: ['search_unsupported_or_not_configured']
        };
    }

    if (manifest.coverage?.searchPath !== undefined || canaries?.coverage?.searchPath !== undefined)
    {
        errors.push('pseudo_search_coverage_prohibited: coverage.searchPath derived from published/row count is invalid');
    }

    if (!manifest.currentVersion || typeof manifest.currentVersion !== 'string')
    {
        errors.push('search_manifest_version_invalid');
    }

    // 2. Index receipt verification
    assertionIds.push('data-scale.search.index-receipt');
    if (indexReceipt)
    {
        const receiptResult = verifySearchIndexReceipt(indexReceipt);
        if (receiptResult.status !== 'ok')
        {
            errors.push(...receiptResult.errors);
        }
        if (manifest.currentVersion && indexReceipt.indexGeneration && manifest.currentVersion !== indexReceipt.indexGeneration)
        {
            errors.push(`generation_mismatch: manifest has ${manifest.currentVersion}, index receipt has ${indexReceipt.indexGeneration}`);
        }
    }
    else
    {
        errors.push('search_index_receipt_missing');
    }

    // 3. Shard verification
    assertionIds.push('data-scale.search.shard');
    if (!shard || typeof shard !== 'object')
    {
        errors.push('search_shard_missing_or_invalid');
        return {
            status: 'failed',
            kind: 'search',
            assertionIds,
            errors
        };
    }

    if (shard.isDatabaseLike || shard.isDatabaseFallback || shard.source === 'database-like-query')
    {
        errors.push('database_like_query_substitution_prohibited: search proof requires canonical search index and API evidence');
    }

    if (shard.magic !== 0x32534846 || shard.version !== 4)
    {
        errors.push(`search_shard_header_invalid: magic=0x${(shard.magic || 0).toString(16)}, version=${shard.version}`);
    }

    // 4. Expected article count match
    assertionIds.push('data-scale.search.count');
    const docs = Array.isArray(shard.docs) ? shard.docs : [];
    if (expectedModel && expectedModel.searchableCount !== undefined)
    {
        if (docs.length !== expectedModel.searchableCount)
        {
            errors.push(`search_doc_count_mismatch: expected ${expectedModel.searchableCount}, observed ${docs.length}`);
        }

        // Verify scheduled/archived/deleted not in docs
        const nonSearchableSeeds = new Set(
            (expectedModel.allArticles || []).filter((a) => !a.isSearchable).map((a) => a.seed)
        );
        for (const doc of docs)
        {
            if (nonSearchableSeeds.has(doc.articleId))
            {
                errors.push(`non-searchable article ${doc.articleId} mistakenly included in search index`);
            }
        }
    }

    // 5. Canary tokens verification (title-only, body-only, Unicode/CJK)
    assertionIds.push('data-scale.search.tokens');
    const canaryArticleId = canaries.article?.id || expectedModel?.canary?.seed || 1;
    const tokens = {
        title: canaries.article?.titleSearchToken || expectedModel?.tokens?.titleSearchToken || 'title-canary',
        body: canaries.article?.bodySearchToken || expectedModel?.tokens?.bodySearchToken || 'body-canary',
        cjk: canaries.article?.cjkSearchToken || expectedModel?.tokens?.cjkSearchToken || '分词'
    };

    for (const [tokenKind, tokenValue] of Object.entries(tokens))
    {
        assertionIds.push(`data-scale.search.token.${tokenKind}`);
        const hits = querySearchShard(shard, tokenValue);
        const matchingCanary = hits.find((h) => String(h.articleId) === String(canaryArticleId));

        if (!matchingCanary)
        {
            errors.push(`search_token_missing_hit: ${tokenKind} token '${tokenValue}' did not match expected article ${canaryArticleId}`);
        }

        // Verify articles that should not match do not match
        const foreignHits = hits.filter((h) => String(h.articleId) !== String(canaryArticleId));
        if (foreignHits.length > 0)
        {
            errors.push(`search_token_unexpected_hit: ${tokenKind} token '${tokenValue}' matched foreign articles: ${foreignHits.map((h) => h.articleId).join(',')}`);
        }
    }

    // 6. Runtime lease binding
    if (runtimeLease && manifest.runtimeLeaseDigest)
    {
        if (manifest.runtimeLeaseDigest !== runtimeLease.runtimeLeaseDigest)
        {
            errors.push('search_manifest_stale_runtime_lease');
        }
    }

    const status = errors.length === 0 ? 'ok' : 'failed';
    const semanticDigest = sha256Canonical({
        manifestVersion: manifest.currentVersion,
        docCount: docs.length,
        canaryArticleId,
        tokens,
        indexReceiptDigest: indexReceipt?.contentDigest || null
    });

    return {
        status,
        kind: 'search',
        assertionIds,
        semanticDigest,
        indexReceipt,
        errors
    };
}

/**
 * Verify search cleanup removes all current-run fixture tokens and advances generation.
 */
export function verifySearchCleanupProof({
    shardAfterCleanup = null,
    tokens = {},
    beforeGeneration = null,
    afterGeneration = null,
    canaryArticleId = 1
} = {})
{
    const errors = [];
    const assertionIds = ['data-scale.search.cleanup'];

    if (beforeGeneration && afterGeneration)
    {
        if (afterGeneration === beforeGeneration)
        {
            errors.push(`search index generation was not advanced on cleanup: remained ${beforeGeneration}`);
        }
    }

    if (shardAfterCleanup && shardAfterCleanup.docs)
    {
        const docs = Array.isArray(shardAfterCleanup.docs) ? shardAfterCleanup.docs : [];
        const foundCanary = docs.find((d) => String(d.articleId) === String(canaryArticleId));
        if (foundCanary)
        {
            errors.push(`canary article ${canaryArticleId} still present in search index after cleanup`);
        }

        for (const [kind, tokenValue] of Object.entries(tokens))
        {
            const hits = querySearchShard(shardAfterCleanup, tokenValue);
            if (hits.some((h) => String(h.articleId) === String(canaryArticleId)))
            {
                errors.push(`canary token '${tokenValue}' (${kind}) still searchable after cleanup`);
            }
        }
    }

    return {
        status: errors.length === 0 ? 'ok' : 'failed',
        assertionIds,
        errors
    };
}
