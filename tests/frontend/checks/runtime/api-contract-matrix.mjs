#!/usr/bin/env node

import { decodeApiErrorFrame, decodeAedsFrame, decodeKnownFrame } from '../../support/aeds-envelope.mjs';
import { buildPowHeaders } from '../../support/auth-helpers.mjs';
import { isDirectExecution, reportDirectFailure } from '../../support/direct-execution.mjs';
import { fetchWithTimeout, probeReachable, parseTimeoutMs } from '../../support/http.mjs';
import { readPublicFixtureIds } from '../../support/public-fixtures.mjs';
import { extractBackendBinaryRoutes, loadProtocol } from '../support/crossStackMatrix.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const publicFixtureIds = readPublicFixtureIds();
const materializePath = (path) => path
    .replaceAll('{page}', '1')
    .replaceAll('{size}', '1')
    .replaceAll('{id}', String(publicFixtureIds.articleId))
    .replaceAll('{id:int}', String(publicFixtureIds.articleId))
    .replaceAll('{id:long}', String(publicFixtureIds.articleId))
    .replaceAll('{categoryId}', String(publicFixtureIds.categoryId))
    .replaceAll('{articleId:int}', String(publicFixtureIds.articleId))
    .replaceAll('{rootId:long}', '1')
    .replaceAll('{tagId}', String(publicFixtureIds.tagId))
    .replaceAll('{slug}', 'about')
    .replaceAll('{username}', 'admin')
    .replaceAll('{uploadId}', 'test-upload');

const frameValues = new Map(loadProtocol().frameTypes.map(frame => [frame.name, frame.value]));
const openapiRoutes = extractBackendBinaryRoutes();
const expectedUnavailablePublicChecks = new Set([
    'binary_get_anonymous_credential_root',
    'binary_get_anonymous_credential_circuit',
    'binary_get_anonymous_credential_blind_issuer',
    'binary_get_anonymous_credential_revocation_full',
    'binary_get_anonymous_credential_revocation_delta'
]);
const optionalNotFoundPublicChecks = new Set([
    'binary_get_article_id_aeds',
    'binary_get_article_list_category_categoryId_page_size_aeds',
    'binary_get_article_list_tag_tagId_page_size_aeds',
    'binary_get_article_featured_size_aeds',
    'binary_get_anonymous_credential_revocation_full',
    'binary_get_anonymous_credential_revocation_delta'
]);
const publicChecks = openapiRoutes
    .filter(route => route.method === 'GET' && route.auth === 'anonymous' && route.pow !== true && route.responseFrame && frameValues.has(route.responseFrame))
    .map(route => [route.operationId || route.path, `/api/binary${materializePath(route.path)}`, frameValues.get(route.responseFrame)])
    .slice(0, 12);

const deniedChecks = openapiRoutes
    .filter(route => route.method === 'GET' && ['user', 'admin'].includes(route.auth))
    .map(route => [route.operationId || route.path, `/api/binary${materializePath(route.path)}`, 401])
    .slice(0, 12);

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function delay(ms)
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitOutPublicArtifactRevocation(initialResponse, execute, label)
{
    const deadlineAt = Date.now() + requestTimeoutMs;
    const retryDelayMs = Math.min(250, Math.max(25, Math.floor(requestTimeoutMs / 60)));
    let response = initialResponse;
    let retries = 0;

    while (response.status === 410 && Date.now() < deadlineAt)
    {
        await response.arrayBuffer();
        await delay(Math.min(retryDelayMs, Math.max(1, deadlineAt - Date.now())));
        response = await execute(Math.max(1, deadlineAt - Date.now()));
        retries += 1;
    }

    if (retries > 0)
    {
        console.log(`[api-contract-revocation-retry] ${label} retries=${retries} final=${response.status}`);
    }
    return response;
}

function assertOctetStream(name, response)
{
    const contentType = response.headers.get('content-type') || '';
    assert(contentType.includes('application/octet-stream'), `[${name}] expected application/octet-stream, got ${contentType || 'none'}`);
}

async function fetchBinary(name, path, init = {}, { retryPublicRevocation = false } = {})
{
    const execute = (timeoutMs = requestTimeoutMs) => fetchWithTimeout(`${baseUrl}${path}`, {
        ...init,
        headers: {
            Accept: 'application/octet-stream',
            ...(init.headers || {})
        }
    }, timeoutMs);

    let response = await execute();
    if (retryPublicRevocation)
    {
        response = await waitOutPublicArtifactRevocation(response, execute, name);
    }
    if (response.status === 428)
    {
        const powHeaders = await buildPowHeaders(`api-contract-${name}`, requestTimeoutMs);
        response = await fetchWithTimeout(`${baseUrl}${path}`, {
            ...init,
            headers: {
                Accept: 'application/octet-stream',
                ...powHeaders,
                ...(init.headers || {})
            }
        }, requestTimeoutMs);
    }
    assert(response.status < 500 || (response.status === 503 && expectedUnavailablePublicChecks.has(name)), `[${name}] must not return unexpected 5xx, got ${response.status}`);
    if (response.status === 404 && optionalNotFoundPublicChecks.has(name))
    {
        return { response, payload: new ArrayBuffer(0) };
    }
    assertOctetStream(name, response);
    return { response, payload: await response.arrayBuffer() };
}

async function checkPublic([name, path, expectedFrameType])
{
    const { response, payload } = await fetchBinary(name, path, {}, { retryPublicRevocation: true });
    if (response.status === 503 && expectedUnavailablePublicChecks.has(name))
    {
        const error = decodeApiErrorFrame(payload);
        assert(error.statusCode === 503, `[${name}] expected unavailable ApiError status 503, got ${error.statusCode}`);
        assert(error.message.length > 0, `[${name}] unavailable ApiError missing message`);
        console.log(`[api-contract-matrix] ok: ${name} unavailable`);
        return;
    }
    if (response.status === 404 && optionalNotFoundPublicChecks.has(name))
    {
        console.log(`[api-contract-matrix] ok: ${name} optional-not-found`);
        return;
    }

    assert(response.ok, `[${name}] expected 2xx, got ${response.status}`);
    const frame = decodeAedsFrame(payload);
    assert(frame.frameType === expectedFrameType, `[${name}] expected frame ${expectedFrameType}, got ${frame.frameType}`);
    if (expectedFrameType === 1)
    {
        const decoded = decodeKnownFrame(payload);
        for (const item of decoded.items ?? [])
        {
            assert(item.isDeleted === false, `[${name}] public item must expose isDeleted=false`);
            assert(item.status === 2, `[${name}] public item must expose published status`);
            assert(item.scheduledPublishAt === null, `[${name}] public item must not expose pending schedule`);
        }
    }
    console.log(`[api-contract-matrix] ok: ${name}`);
}

async function checkDenied([name, path, expectedStatus])
{
    const { response, payload } = await fetchBinary(name, path);
    assert(response.status === expectedStatus, `[${name}] expected status ${expectedStatus}, got ${response.status}`);
    const error = decodeApiErrorFrame(payload);
    assert(error.statusCode === expectedStatus, `[${name}] ApiError status mismatch: ${error.statusCode}`);
    assert(error.message.length > 0, `[${name}] ApiError missing message`);
    console.log(`[api-contract-matrix] ok: ${name}`);
}

async function checkLegacyPublicQueryRoute()
{
    const url = `${baseUrl}/api/binary/article?page=1&size=1`;
    const execute = (timeoutMs = requestTimeoutMs) => fetchWithTimeout(url, {
        headers: { Accept: 'application/octet-stream' }
    }, timeoutMs);
    const initialResponse = await execute();
    // Publishing fixtures can briefly revoke public artifacts; 410 is not this route's stable contract.
    const response = await waitOutPublicArtifactRevocation(initialResponse, execute, 'legacy public query');

    assert(response.status === 400, `[legacy public query] expected 400, got ${response.status}`);
    assert(response.headers.get('cache-control') === 'no-store', '[legacy public query] must be no-store');
    assert(
        response.headers.get('x-fsus-required-route') === '/api/binary/article/list/home/{page}/{size}.aeds',
        '[legacy public query] must advertise required segment route'
    );
    console.log('[api-contract-matrix] ok: legacy public query route');
}

export async function runApiContractMatrix()
{
    await probeReachable(`${baseUrl}/api/binary/article/list/home/1/1.aeds`, '[api-contract-matrix backend]', requestTimeoutMs);

    for (const item of publicChecks)
    {
        await checkPublic(item);
    }

    for (const item of deniedChecks)
    {
        await checkDenied(item);
    }

    await checkLegacyPublicQueryRoute();

    console.log('[api-contract-matrix] all checks passed');
}

if (isDirectExecution(import.meta.url))
{
    runApiContractMatrix().catch((error) => reportDirectFailure('api-contract-matrix', error));
}
