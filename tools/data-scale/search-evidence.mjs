import { createHash } from 'node:crypto';
import { decodeAedsFrame } from './aeds-decoders.mjs';

export const DATA_SCALE_SEARCH_RECEIPT_SCHEMA = 'fsusblog.data-scale-search-receipt.v1';
export const DATA_SCALE_SEARCH_EXECUTION_SCHEMA = 'fsusblog.data-scale-search-execution.v1';
export const PRODUCT_SEARCH_HTTP_PATH = '/api/binary/article/search/query.aeds';
export const PRODUCT_SEARCH_HTTP_QUERY_PARAM = 'q';
export const PRODUCT_SEARCH_FRAME_TYPE = 4; // AedsFrameType.ArticleSearch
export const PRODUCT_SEARCH_API_KIND = 'product-search-http-api';
export const SEARCH_INDEX_GENERATION_HEADER = 'x-fsus-search-index-generation';

const ARTICLE_SEARCH_V4_MAGIC = 0x34534146; // FAS4
const ARTICLE_SEARCH_V4_VERSION = 4;
const UTF8_FIXED_128 = 128;
const UTF8_FIXED_256 = 256;
const ARTICLE_CATEGORY_VIEW_POD = 4 + UTF8_FIXED_128;
const ARTICLE_LIST_ITEM_POD = 4 + 4 + 8 + ARTICLE_CATEGORY_VIEW_POD + UTF8_FIXED_256 + 8 + 1 + 1 + 2 + 4;
const TAG_POD = 4 + UTF8_FIXED_128;
const VERSION_COORD_BYTES = 8 + 4 + 8 + 4;

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

function readI32LE(view, offset)
{
    return view.getInt32(offset, true);
}

/**
 * Best-effort ArticleSearch FAS4 payload hit extraction for product Search HTTP responses.
 */
export function extractArticleSearchHitIds(payload)
{
    if (!payload || payload.byteLength < 12)
    {
        throw new Error('article_search_payload_too_short');
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let offset = 0;
    const magic = readI32LE(view, offset);
    offset += 4;
    let count;
    if (magic === ARTICLE_SEARCH_V4_MAGIC)
    {
        const version = readI32LE(view, offset);
        offset += 4;
        if (version !== ARTICLE_SEARCH_V4_VERSION)
        {
            throw new Error(`article_search_version_invalid:${version}`);
        }
        count = readI32LE(view, offset);
        offset += 4;
    }
    else
    {
        // Legacy count-prefixed layout without FAS4 magic.
        count = magic;
    }
    if (count < 0 || count > 10_000)
    {
        throw new Error(`article_search_count_invalid:${count}`);
    }

    const ids = [];
    for (let i = 0; i < count; i += 1)
    {
        if (offset + ARTICLE_LIST_ITEM_POD + 4 > payload.byteLength)
        {
            throw new Error('article_search_record_truncated');
        }
        ids.push(readI32LE(view, offset));
        offset += ARTICLE_LIST_ITEM_POD;
        const tagCount = readI32LE(view, offset);
        offset += 4;
        if (tagCount < 0 || tagCount > 1_000)
        {
            throw new Error(`article_search_tag_count_invalid:${tagCount}`);
        }
        offset += tagCount * TAG_POD;
        if (offset + 4 > payload.byteLength)
        {
            throw new Error('article_search_blob_truncated');
        }
        const blobLen = readI32LE(view, offset);
        offset += 4;
        if (blobLen < 0 || offset + blobLen + VERSION_COORD_BYTES > payload.byteLength)
        {
            throw new Error('article_search_blob_length_invalid');
        }
        offset += blobLen + VERSION_COORD_BYTES;
    }
    return ids;
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

export function buildProductSearchApiUrl(baseUrl, query)
{
    const root = String(baseUrl || '').replace(/\/+$/, '');
    const url = new URL(`${root}${PRODUCT_SEARCH_HTTP_PATH}`);
    url.searchParams.set(PRODUCT_SEARCH_HTTP_QUERY_PARAM, String(query ?? ''));
    return url.toString();
}

/**
 * Build a Search API execution evidence record (product HTTP Search, not JS shard query).
 */
export function buildSearchApiExecution({
    tokenKind,
    query,
    statusCode = 200,
    available = true,
    frameType = PRODUCT_SEARCH_FRAME_TYPE,
    articleIds = [],
    indexGeneration = null,
    route = PRODUCT_SEARCH_HTTP_PATH,
    method = 'GET',
    apiKind = PRODUCT_SEARCH_API_KIND,
    source = PRODUCT_SEARCH_API_KIND,
    reason = null,
    responseDigest = null
} = {})
{
    const errors = [];
    if (!available)
    {
        errors.push(reason || 'search_api_unavailable');
    }
    if (source !== PRODUCT_SEARCH_API_KIND && source !== 'product-search-http-api')
    {
        errors.push(`search_api_source_prohibited:${source}`);
    }
    if (source === 'js-querySearchShard' || source === 'on-disk-shard' || source === 'database-like-query')
    {
        errors.push(`search_api_substitute_prohibited:${source}`);
    }
    if (available && statusCode !== 200)
    {
        errors.push(`search_api_http_status:${statusCode}`);
    }
    if (available && Number(frameType) !== PRODUCT_SEARCH_FRAME_TYPE && frameType !== 'ArticleSearch')
    {
        errors.push(`search_api_frame_type_invalid:${frameType}`);
    }
    if (available && (!route || !String(route).includes('/article/search/')))
    {
        errors.push(`search_api_route_invalid:${route}`);
    }

    const execution = {
        schema: DATA_SCALE_SEARCH_EXECUTION_SCHEMA,
        status: errors.length === 0 ? 'ok' : 'failed',
        available,
        apiKind,
        source,
        method,
        route,
        tokenKind: tokenKind || null,
        query: query || null,
        statusCode,
        frameType,
        indexGeneration: indexGeneration || null,
        articleIds: Array.isArray(articleIds) ? articleIds.map((id) => Number(id)) : [],
        responseDigest: responseDigest || null,
        errors,
        reason: reason || (errors.length > 0 ? errors.join('; ') : null)
    };
    execution.contentDigest = sha256Canonical(execution);
    return execution;
}

function headerValue(headers, name)
{
    if (!headers)
    {
        return null;
    }
    if (typeof headers.get === 'function')
    {
        return headers.get(name) || headers.get(name.toLowerCase()) || null;
    }
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : null;
}

/**
 * Execute one product Search HTTP API query. Fail-closed when unavailable.
 */
export async function executeProductSearchHttpApi({
    baseUrl,
    query,
    tokenKind = null,
    expectedGeneration = null,
    fetchImpl = globalThis.fetch,
    signal = undefined
} = {})
{
    if (!baseUrl)
    {
        return buildSearchApiExecution({
            tokenKind,
            query,
            available: false,
            reason: 'search_api_unavailable: missing baseUrl'
        });
    }
    if (typeof fetchImpl !== 'function')
    {
        return buildSearchApiExecution({
            tokenKind,
            query,
            available: false,
            reason: 'search_api_unavailable: fetchImpl missing'
        });
    }

    const url = buildProductSearchApiUrl(baseUrl, query);
    let response;
    try
    {
        response = await fetchImpl(url, {
            method: 'GET',
            signal,
            headers: {
                Accept: 'application/octet-stream, application/vnd.fsus.aeds'
            }
        });
    }
    catch (error)
    {
        return buildSearchApiExecution({
            tokenKind,
            query,
            available: false,
            reason: `search_api_unavailable: ${error instanceof Error ? error.message : String(error)}`
        });
    }

    if (!response || typeof response.status !== 'number')
    {
        return buildSearchApiExecution({
            tokenKind,
            query,
            available: false,
            reason: 'search_api_unavailable: empty response'
        });
    }

    if (response.status === 404 || response.status === 501 || response.status === 503)
    {
        return buildSearchApiExecution({
            tokenKind,
            query,
            available: false,
            statusCode: response.status,
            reason: `search_api_unavailable: http ${response.status}`
        });
    }

    const body = new Uint8Array(await response.arrayBuffer());
    const responseDigest = sha256Canonical(Buffer.from(body).toString('base64'));
    const generation = headerValue(response.headers, SEARCH_INDEX_GENERATION_HEADER)
        || expectedGeneration
        || null;

    let frameType = null;
    let articleIds = [];
    let decodeError = null;
    try
    {
        const frame = decodeAedsFrame(body);
        frameType = frame?.type ?? frame?.frameType ?? null;
        const payload = frame?.payload instanceof Uint8Array
            ? frame.payload
            : (frame?.payload ? new Uint8Array(frame.payload) : body);
        if (Number(frameType) === PRODUCT_SEARCH_FRAME_TYPE || frameType === 'ArticleSearch')
        {
            articleIds = extractArticleSearchHitIds(payload);
        }
        else
        {
            decodeError = `search_api_frame_type_invalid:${frameType}`;
        }
    }
    catch (error)
    {
        decodeError = error instanceof Error ? error.message : String(error);
    }

    return buildSearchApiExecution({
        tokenKind,
        query,
        available: true,
        statusCode: response.status,
        frameType: frameType ?? PRODUCT_SEARCH_FRAME_TYPE,
        articleIds,
        indexGeneration: generation,
        responseDigest,
        reason: decodeError
            || (response.status !== 200 ? `search_api_http_status:${response.status}` : null)
    });
}

function assertSearchApiExecution(execution, {
    tokenKind,
    query,
    canaryArticleId,
    indexGeneration,
    expectHit
})
{
    const errors = [];
    if (!execution || typeof execution !== 'object')
    {
        return ['search_api_execution_missing'];
    }
    if (execution.available === false
        || (Array.isArray(execution.errors) && execution.errors.some((e) => String(e).includes('unavailable')))
        || (execution.reason && String(execution.reason).includes('unavailable')))
    {
        errors.push(...(execution.errors || []));
        if (execution.reason)
        {
            errors.push(execution.reason);
        }
        return errors.length > 0 ? errors : ['search_api_unavailable'];
    }
    if (execution.source && execution.source !== PRODUCT_SEARCH_API_KIND && execution.source !== 'product-search-http-api')
    {
        errors.push(`search_api_substitute_prohibited:${execution.source}`);
    }
    if (execution.source === 'js-querySearchShard' || execution.apiKind === 'js-querySearchShard')
    {
        errors.push('js_shard_query_substitution_prohibited: positive proof requires product Search HTTP API');
    }
    if (execution.isDatabaseLike || execution.source === 'database-like-query' || execution.apiKind === 'database-like-query')
    {
        errors.push('database_like_query_substitution_prohibited: search proof requires canonical search index and API evidence');
    }
    if (execution.route && execution.route.includes('/article/list/') && execution.route.includes('keyword='))
    {
        errors.push('list_keyword_like_substitution_prohibited: article list ?keyword= is not the Search API');
    }
    if (Number(execution.statusCode) !== 200)
    {
        errors.push(`search_api_http_status:${execution.statusCode}`);
    }
    if (Number(execution.frameType) !== PRODUCT_SEARCH_FRAME_TYPE && execution.frameType !== 'ArticleSearch')
    {
        errors.push(`search_api_frame_type_invalid:${execution.frameType}`);
    }
    if (execution.errors?.length)
    {
        errors.push(...execution.errors);
    }
    if (tokenKind && execution.tokenKind && execution.tokenKind !== tokenKind)
    {
        errors.push(`search_api_token_kind_mismatch:${execution.tokenKind}`);
    }
    if (query && execution.query && String(execution.query) !== String(query))
    {
        errors.push(`search_api_query_mismatch:${execution.query}`);
    }
    if (indexGeneration && execution.indexGeneration && String(execution.indexGeneration) !== String(indexGeneration))
    {
        errors.push(`generation_mismatch: search API has ${execution.indexGeneration}, index receipt has ${indexGeneration}`);
    }

    const hits = Array.isArray(execution.articleIds) ? execution.articleIds : [];
    const matchingCanary = hits.find((id) => String(id) === String(canaryArticleId));
    if (expectHit)
    {
        if (!matchingCanary)
        {
            errors.push(`search_token_missing_hit: ${tokenKind || 'token'} '${query}' did not match expected article ${canaryArticleId}`);
        }
        const foreignHits = hits.filter((id) => String(id) !== String(canaryArticleId));
        if (foreignHits.length > 0)
        {
            errors.push(`search_token_unexpected_hit: ${tokenKind || 'token'} '${query}' matched foreign articles: ${foreignHits.join(',')}`);
        }
    }
    else if (matchingCanary)
    {
        errors.push(`canary token '${query}' (${tokenKind || 'token'}) still searchable after cleanup`);
    }

    return errors;
}

/**
 * Verify search execution proof against canonical index + product Search HTTP API executions.
 * On-disk shard + JS querySearchShard is not an accepted positive proof path.
 */
export function verifySearchExecutionProof({
    manifest,
    shard = null,
    indexReceipt,
    expectedModel,
    canaries = {},
    runtimeLease = null,
    searchApiExecutions = null
} = {})
{
    const assertionIds = [];
    const errors = [];

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

    // Shard may still bind inventory, but must not be the query authority.
    if (shard && typeof shard === 'object')
    {
        assertionIds.push('data-scale.search.shard');
        if (shard.isDatabaseLike || shard.isDatabaseFallback || shard.source === 'database-like-query')
        {
            errors.push('database_like_query_substitution_prohibited: search proof requires canonical search index and API evidence');
        }
        if (shard.queriedVia === 'js-querySearchShard' || shard.proofPath === 'js-querySearchShard')
        {
            errors.push('js_shard_query_substitution_prohibited: positive proof requires product Search HTTP API');
        }
        if (shard.magic !== undefined && (shard.magic !== 0x32534846 || shard.version !== 4))
        {
            errors.push(`search_shard_header_invalid: magic=0x${(shard.magic || 0).toString(16)}, version=${shard.version}`);
        }

        assertionIds.push('data-scale.search.canary-doc');
        const docsForCanary = Array.isArray(shard.docs) ? shard.docs : [];
        const canaryArticleIdForShard = canaries.article?.id || expectedModel?.canary?.seed || 1;
        if (!docsForCanary.find((d) => String(d.articleId) === String(canaryArticleIdForShard)))
        {
            errors.push(`search_shard_missing_canary_article: expected articleId=${canaryArticleIdForShard}`);
        }

        assertionIds.push('data-scale.search.count');
        const docs = Array.isArray(shard.docs) ? shard.docs : [];
        if (expectedModel && expectedModel.searchableCount !== undefined)
        {
            if (docs.length !== expectedModel.searchableCount)
            {
                errors.push(`search_doc_count_mismatch: expected ${expectedModel.searchableCount}, observed ${docs.length}`);
            }
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
    }
    else if (indexReceipt && expectedModel && expectedModel.searchableCount !== undefined)
    {
        assertionIds.push('data-scale.search.count');
        if (indexReceipt.indexedDocumentCount !== expectedModel.searchableCount)
        {
            errors.push(`search_doc_count_mismatch: expected ${expectedModel.searchableCount}, observed ${indexReceipt.indexedDocumentCount}`);
        }
    }

    assertionIds.push('data-scale.search.api');
    if (!Array.isArray(searchApiExecutions) || searchApiExecutions.length === 0)
    {
        errors.push('search_api_unavailable: product Search HTTP API executions are required for positive proof');
        return {
            status: 'failed',
            kind: 'search',
            assertionIds,
            errors
        };
    }

    const canaryArticleId = canaries.article?.id || expectedModel?.canary?.seed || 1;
    const tokens = {
        title: canaries.article?.titleSearchToken || expectedModel?.tokens?.titleSearchToken || 'title-canary',
        body: canaries.article?.bodySearchToken || expectedModel?.tokens?.bodySearchToken || 'body-canary',
        cjk: canaries.article?.cjkSearchToken || expectedModel?.tokens?.cjkSearchToken || '分词'
    };
    const expectedGeneration = indexReceipt?.indexGeneration || manifest.currentVersion || null;

    assertionIds.push('data-scale.search.tokens');
    for (const [tokenKind, tokenValue] of Object.entries(tokens))
    {
        assertionIds.push(`data-scale.search.token.${tokenKind}`);
        const execution = searchApiExecutions.find((item) =>
            item?.tokenKind === tokenKind
            || String(item?.query) === String(tokenValue))
            || null;
        if (!execution)
        {
            errors.push(`search_api_execution_missing_for_token:${tokenKind}`);
            continue;
        }
        errors.push(...assertSearchApiExecution(execution, {
            tokenKind,
            query: tokenValue,
            canaryArticleId,
            indexGeneration: expectedGeneration,
            expectHit: true
        }));
    }

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
        canaryArticleId,
        tokens,
        indexReceiptDigest: indexReceipt?.contentDigest || null,
        searchApiExecutionDigests: searchApiExecutions.map((item) => item?.contentDigest || null)
    });

    return {
        status,
        kind: 'search',
        assertionIds,
        semanticDigest,
        indexReceipt,
        searchApiExecutions,
        errors
    };
}

/**
 * Verify search cleanup removes current-run fixture tokens via Search API and advances generation.
 */
export function verifySearchCleanupProof({
    tokens = {},
    beforeGeneration = null,
    afterGeneration = null,
    canaryArticleId = 1,
    searchApiExecutions = null,
    shardAfterCleanup = null
} = {})
{
    const errors = [];
    const assertionIds = ['data-scale.search.cleanup', 'data-scale.search.cleanup.api'];

    if (beforeGeneration && afterGeneration)
    {
        if (afterGeneration === beforeGeneration)
        {
            errors.push(`search index generation was not advanced on cleanup: remained ${beforeGeneration}`);
        }
    }

    if (!Array.isArray(searchApiExecutions) || searchApiExecutions.length === 0)
    {
        errors.push('search_api_unavailable: cleanup proof requires product Search HTTP API executions');
        return {
            status: 'failed',
            assertionIds,
            errors
        };
    }

    for (const [kind, tokenValue] of Object.entries(tokens))
    {
        const execution = searchApiExecutions.find((item) =>
            item?.tokenKind === kind
            || String(item?.query) === String(tokenValue))
            || null;
        if (!execution)
        {
            errors.push(`search_api_execution_missing_for_token:${kind}`);
            continue;
        }
        errors.push(...assertSearchApiExecution(execution, {
            tokenKind: kind,
            query: tokenValue,
            canaryArticleId,
            indexGeneration: afterGeneration,
            expectHit: false
        }));
    }

    // Optional residual shard check (inventory only; not the query authority).
    if (shardAfterCleanup && Array.isArray(shardAfterCleanup.docs))
    {
        const foundCanary = shardAfterCleanup.docs.find((d) => String(d.articleId) === String(canaryArticleId));
        if (foundCanary)
        {
            errors.push(`canary article ${canaryArticleId} still present in search index after cleanup`);
        }
        if (shardAfterCleanup.queriedVia === 'js-querySearchShard')
        {
            errors.push('js_shard_query_substitution_prohibited: cleanup proof requires product Search HTTP API');
        }
    }

    return {
        status: errors.length === 0 ? 'ok' : 'failed',
        assertionIds,
        errors
    };
}
