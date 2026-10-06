import { createHash } from 'node:crypto';
import fs from 'node:fs';

const { decodeAedsFrame, decodeApiErrorFrame } = await import(new URL('../../../tests/frontend/support/aeds-envelope.mjs', import.meta.url));

const protocol = JSON.parse(fs.readFileSync(new URL('../../../src/shared/Contracts/Validation/aeds-protocol.json', import.meta.url), 'utf8'));
const expectedFrameType = protocol.frameTypes.find((frame) => frame.name === 'ArticleRelatedReading').value;
const api = JSON.parse(fs.readFileSync(new URL('../../../src/shared/Contracts/Validation/fsusblog.openapi.json', import.meta.url), 'utf8'));
const binaryGets = Object.entries(api.paths).filter(([, operations]) => operations.get?.['x-fsus-response-frame'])
    .map(([route, operations]) => ({
        route,
        pattern: new RegExp(`^${route.split(/(\{[^}]+\})/u).map((part) => part.startsWith('{')
            ? (part.includes(':int') ? '[1-9][0-9]*' : '[^/]+')
            : part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('')}$`, 'u'),
        operation: operations.get
    }));

function requestTarget(target)
{
    if (typeof target !== 'string' || !target.startsWith('/api/binary/') || /[\\#\u0000-\u0020]/u.test(target))
    {
        throw new Error('binary request target must be a canonical relative path');
    }
    const url = new URL(target, 'http://runtime.invalid');
    if (url.pathname !== target.split('?')[0] || /%|\/\//u.test(url.pathname))
    {
        throw new Error('binary request target contains a non-canonical separator or path');
    }
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length)
    {
        throw new Error('binary request target contains duplicate query parameters');
    }
    if (url.search.slice(1) !== url.searchParams.toString())
    {
        throw new Error('binary request target contains a non-canonical query');
    }
    return url;
}

export function isBinaryGet(request)
{
    return request.method === 'GET' && typeof request.path === 'string' && request.path.startsWith('/api/binary/');
}

// The same retained-byte oracle serves the producer and independent receipt reader.
// Expected success metadata belongs to the existing shared OpenAPI/protocol owners.
export function binaryGetResponseError(request, { cursorless = false } = {})
{
    try
    {
        if (request.method !== 'GET') return 'binary response requires GET';
        const url = requestTarget(request.path);
        const matches = binaryGets.filter(({ pattern }) => pattern.test(url.pathname));
        if (matches.length !== 1) return 'binary request must match exactly one current GET contract';
        const operation = matches[0].operation;
        const expectedStatus = cursorless ? 400 : operation['x-fsus-success-status'];
        if (request.status !== expectedStatus) return `HTTP ${request.status}; expected HTTP ${expectedStatus}`;
        if (typeof request.responseContentType !== 'string' ||
            request.responseContentType.split(';')[0].trim().toLowerCase() !== operation['x-fsus-content-type'])
        {
            return 'missing or wrong response Content-Type';
        }
        if (typeof request.responseBodyBase64 !== 'string' || request.responseBodyBase64.length === 0) return 'missing response bytes';
        const body = Buffer.from(request.responseBodyBase64, 'base64');
        if (body.toString('base64') !== request.responseBodyBase64) return 'non-canonical response base64';
        if (`sha256:${createHash('sha256').update(body).digest('hex')}` !== request.payloadDigest)
        {
            return 'response bytes do not match observed payload digest';
        }
        const frame = decodeAedsFrame(body);
        if (body.readUInt16LE(6) !== 0) return 'unsupported AEDS flags';
        const frameName = cursorless ? 'ApiError' : operation['x-fsus-response-frame'];
        const frameType = protocol.frameTypes.find((item) => item.name === frameName)?.value;
        if (frameType === undefined || frame.frameType !== frameType)
        {
            return `wrong AEDS frame type ${frame.frameType}; expected ${frameType}`;
        }
        if (cursorless)
        {
            const error = decodeApiErrorFrame(body);
            // Current API consumer expectation: ApiError(Validation), HTTP/embedded 400.
            // This literal is not a compiled enum observation or a new enum authority.
            if (error.code !== 1 || error.statusCode !== 400) return 'cursorless response must be ApiError(Validation) with embedded HTTP 400';
        }
        return null;
    }
    catch (error)
    {
        return error.message;
    }
}

// Bind to the current sole scenario recipes before looking up the shared wire contract.
// A foreign valid binary route/frame cannot stand in for the measured scenario.
export function runtimeCacheResponseError(scenarioId, request, parameters = {})
{
    const boundScenarios = new Set(['public-hot-read', 'article-detail-l1', 'distributed-invalidation', 'pagination', 'related-reading', 'revocation', 'hot-featured-frame']);
    if (!boundScenarios.has(scenarioId)) return isBinaryGet(request) ? `${scenarioId} does not declare a binary GET sample` : null;
    // The distributed invalidation producer also records its non-read trigger.
    if (scenarioId === 'distributed-invalidation' && request.subcaseId === 'comment-mutation')
    {
        return request.method === 'POST' && request.path === '/_fsus/testing/runtime-cache/scenarios/distributed/trigger' &&
            request.parityGroup === 'distributed-comment-mutation' ? null : 'distributed invalidation trigger binding failed';
    }
    try
    {
        const url = requestTarget(request.path);
        let expectedPath;
        let expectedParity;
        let cursorless = false;
        let query = [];
        if (scenarioId === 'pagination')
        {
            const match = /^\/api\/binary\/article\/list\/home\/([1-9][0-9]*)\/10\.aeds$/u.exec(url.pathname);
            const page = Number(match?.[1]);
            cursorless = request.subcaseId === 'cursorless-deep';
            if (!match || !(cursorless ? [10, 100, 1000, 1001] : [1, 10, 100, 1000]).includes(page) ||
                (!cursorless && request.subcaseId !== `page-${page}`)) return 'pagination route/subcase binding failed';
            query = !cursorless && page > 1 ? ['sort', 'cursor'] : ['sort'];
            if (url.searchParams.get('sort') !== 'latest' || (query.includes('cursor') && !url.searchParams.get('cursor')))
            {
                return 'pagination query/cursor binding failed';
            }
            expectedPath = `/api/binary/article/list/home/${page}/10.aeds`;
            expectedParity = `pagination-${cursorless ? 'cursorless' : 'page'}-${page}`;
        }
        else if (scenarioId === 'public-hot-read')
        {
            if (!['fixed-ip', 'unique-ip'].includes(request.subcaseId)) return 'public-hot-read subcase binding failed';
            expectedPath = '/api/binary/article/hot/10.aeds';
            expectedParity = `public-hot-read-${request.subcaseId}`;
        }
        else if (scenarioId === 'hot-featured-frame')
        {
            if (!['hot', 'featured'].includes(request.subcaseId)) return 'hot-featured-frame subcase binding failed';
            expectedPath = `/api/binary/admin/article/${request.subcaseId}`;
            expectedParity = `admin-${request.subcaseId}-whole-frame`;
            query = ['size'];
            if (url.searchParams.get('size') !== String(request.subcaseId === 'hot' ? 49 : 9)) return 'hot-featured-frame size binding failed';
        }
        else if (scenarioId === 'related-reading')
        {
            if (!['cold', 'same-key-100', 'hot'].includes(request.subcaseId)) return 'related-reading subcase binding failed';
            const articleId = request.subcaseId === 'cold' ? parameters.coldArticleId : parameters.burstArticleId;
            if (!Number.isInteger(articleId) || articleId <= 0) return 'related-reading article binding failed';
            expectedPath = `/api/binary/article/${articleId}/related.aeds`;
            expectedParity = `related-reading-${articleId}`;
        }
        else
        {
            const articleId = parameters.articleId;
            expectedPath = scenarioId === 'article-detail-l1' ? parameters.route : `/api/binary/article/${articleId}.aeds`;
            if (!/^\/api\/binary\/article\/[1-9][0-9]*\.aeds$/u.test(expectedPath ?? '')) return 'article route binding failed';
            if (scenarioId === 'article-detail-l1')
            {
                if (!['l1-hit', 'redis-fault'].includes(request.subcaseId)) return 'article-detail-l1 subcase binding failed';
                expectedParity = 'article-detail-l1-payload';
            }
            else if (scenarioId === 'distributed-invalidation')
            {
                if (!['unrelated-policy-residency', 'public-hot-read-ready', 'two-node-convergence'].includes(request.subcaseId)) return 'distributed-invalidation subcase binding failed';
                expectedParity = 'distributed-route-convergence';
            }
            else
            {
                if (!(parameters.sizes ?? []).some((size) => request.subcaseId === `size-${size}`)) return 'revocation size/subcase binding failed';
                expectedParity = `revocation-unrelated-article-${articleId}`;
            }
        }
        if (request.method !== 'GET' || url.pathname !== expectedPath || request.parityGroup !== expectedParity ||
            JSON.stringify([...url.searchParams.keys()].sort()) !== JSON.stringify(query.sort())) return `${scenarioId} route/identity/query binding failed`;
        return binaryGetResponseError(request, { cursorless });
    }
    catch (error)
    {
        return error.message;
    }
}

// Recompute from retained transport bytes, not a producer-supplied valid/CRC flag.
export function relatedReadingResponseError(request)
{
    if (request.status !== 200)
    {
        return `HTTP ${request.status}; expected HTTP 200`;
    }
    if (typeof request.responseBodyBase64 !== 'string' || request.responseBodyBase64.length === 0)
    {
        return 'missing response bytes';
    }
    const body = Buffer.from(request.responseBodyBase64, 'base64');
    if (body.toString('base64') !== request.responseBodyBase64)
    {
        return 'non-canonical response base64';
    }
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    if (digest !== request.payloadDigest)
    {
        return 'response bytes do not match observed payload digest';
    }
    try
    {
        const frame = decodeAedsFrame(body);
        if (body.readUInt16LE(6) !== 0)
        {
            return 'unsupported AEDS flags';
        }
        if (frame.frameType !== expectedFrameType)
        {
            return `wrong AEDS frame type ${frame.frameType}; expected ${expectedFrameType}`;
        }
    }
    catch (error)
    {
        return error.message;
    }
    return null;
}
