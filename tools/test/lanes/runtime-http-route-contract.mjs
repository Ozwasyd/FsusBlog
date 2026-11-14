import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const catalogFile = path.join(root, 'config/testing/runtime-http-route-contracts.json');
const schemaFile = path.join(root, 'config/schemas/runtime-http-route-contracts.schema.json');
const requiredRouteFields = ['routeId', 'method', 'pathTemplate', 'expectedStatus', 'redirectPolicy', 'expectedContentType', 'expectedAedsFrameType', 'minimumBodyBytes', 'maximumBodyBytes', 'semanticValidatorId', 'cacheHeaderPolicy', 'authPolicy'];

export function validateRouteCatalog(candidate)
{
    const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
    if (schema.$id !== 'fsusblog.runtime-http-route-contracts.v1'
    || schema.properties?.schema?.const !== 'fsusblog.runtime-http-route-contracts.v1'
    || !schema.$defs?.route?.required?.every((field) => requiredRouteFields.includes(field)))
    {
        throw new Error('runtime HTTP route contract schema is invalid');
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    {
        throw new Error('runtime HTTP route catalog must be an object');
    }
    if (candidate.schema !== 'fsusblog.runtime-http-route-contracts.v1')
    {
        throw new Error('runtime HTTP route catalog has an unsupported schema');
    }
    if (Object.keys(candidate).length !== 3 || !['schema', 'producers', 'routes'].every((field) => Object.hasOwn(candidate, field)))
    {
        throw new Error('runtime HTTP route catalog has unsupported fields');
    }
    if (!Array.isArray(candidate.routes) || candidate.routes.length === 0)
    {
        throw new Error('runtime HTTP route catalog routes must be a non-empty array');
    }
    if (!candidate.producers || typeof candidate.producers !== 'object' || Array.isArray(candidate.producers))
    {
        throw new Error('runtime HTTP route catalog producers must be an object');
    }

    const routeIds = new Set();
    for (const route of candidate.routes)
    {
        if (!route || typeof route !== 'object' || Array.isArray(route))
        {
            throw new Error('runtime HTTP route catalog contains a non-object route');
        }
        for (const field of requiredRouteFields)
        {
            if (!(field in route))
            {
                throw new Error(`runtime HTTP route catalog route missing ${field}`);
            }
        }
        if (Object.keys(route).length !== requiredRouteFields.length)
        {
            throw new Error(`runtime HTTP route catalog route has unsupported fields:${route.routeId ?? 'unknown'}`);
        }
        if (typeof route.routeId !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(route.routeId))
        {
            throw new Error('runtime HTTP route catalog routeId is invalid');
        }
        if (routeIds.has(route.routeId))
        {
            throw new Error(`runtime HTTP route catalog has duplicate routeId:${route.routeId}`);
        }
        routeIds.add(route.routeId);
        if (typeof route.method !== 'string' || !/^[A-Z]+$/u.test(route.method))
        {
            throw new Error(`runtime HTTP route catalog method is invalid:${route.routeId}`);
        }
        if (typeof route.pathTemplate !== 'string' || !route.pathTemplate.startsWith('/'))
        {
            throw new Error(`runtime HTTP route catalog pathTemplate is invalid:${route.routeId}`);
        }
        if (!Number.isInteger(route.expectedStatus) || route.expectedStatus < 100 || route.expectedStatus > 599)
        {
            throw new Error(`runtime HTTP route catalog expectedStatus is invalid:${route.routeId}`);
        }
        if (route.redirectPolicy !== 'forbid')
        {
            throw new Error(`runtime HTTP route catalog redirectPolicy is invalid:${route.routeId}`);
        }
        if (!Array.isArray(route.expectedContentType) || route.expectedContentType.length === 0 || route.expectedContentType.some((value) => typeof value !== 'string' || value.length === 0))
        {
            throw new Error(`runtime HTTP route catalog expectedContentType is invalid:${route.routeId}`);
        }
        if (route.expectedAedsFrameType !== null && (!Number.isInteger(route.expectedAedsFrameType) || route.expectedAedsFrameType < 0 || route.expectedAedsFrameType > 255))
        {
            throw new Error(`runtime HTTP route catalog expectedAedsFrameType is invalid:${route.routeId}`);
        }
        if (!Number.isInteger(route.minimumBodyBytes) || !Number.isInteger(route.maximumBodyBytes) || route.minimumBodyBytes < 0 || route.maximumBodyBytes < route.minimumBodyBytes)
        {
            throw new Error(`runtime HTTP route catalog body bounds are invalid:${route.routeId}`);
        }
        if (!['non-error-frame', 'search-manifest', 'html-document'].includes(route.semanticValidatorId))
        {
            throw new Error(`runtime HTTP route catalog semanticValidatorId is invalid:${route.routeId}`);
        }
        if (!['any', 'no-store'].includes(route.cacheHeaderPolicy))
        {
            throw new Error(`runtime HTTP route catalog cacheHeaderPolicy is invalid:${route.routeId}`);
        }
        if (!['anonymous'].includes(route.authPolicy))
        {
            throw new Error(`runtime HTTP route catalog authPolicy is invalid:${route.routeId}`);
        }
    }

    const ownedRouteIds = [];
    for (const [producerId, producerRoutes] of Object.entries(candidate.producers))
    {
        if (!/^[a-z][a-z0-9-]*$/u.test(producerId) || !Array.isArray(producerRoutes) || producerRoutes.length === 0)
        {
            throw new Error(`runtime HTTP route catalog producer is invalid:${producerId}`);
        }
        const owned = new Set();
        for (const routeId of producerRoutes)
        {
            if (typeof routeId !== 'string' || !routeIds.has(routeId))
            {
                throw new Error(`runtime HTTP route catalog producer has unknown route:${producerId}:${routeId}`);
            }
            if (owned.has(routeId))
            {
                throw new Error(`duplicate_route_contract_owner:${producerId}`);
            }
            owned.add(routeId);
            ownedRouteIds.push(routeId);
        }
    }
    const uniqueOwnedRouteIds = new Set(ownedRouteIds);
    if (uniqueOwnedRouteIds.size !== routeIds.size || [...routeIds].some((routeId) => !uniqueOwnedRouteIds.has(routeId)))
    {
        throw new Error('route_catalog_exact_match_failed');
    }
    return candidate;
}

const catalog = validateRouteCatalog(JSON.parse(fs.readFileSync(catalogFile, 'utf8')));
const digest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(catalog)).digest('hex')}`;
const byId = new Map(catalog.routes.map((route) => [route.routeId, route]));

export function routeContract(routeId)
{
    const route = byId.get(routeId);
    if (!route)
    {
        throw new Error(`unknown_route_contract:${routeId}`);
    }
    return route;
}
function templateMatches(template, pathname)
{
    const escaped = template.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/:[A-Za-z][A-Za-z0-9_]*/gu, '[^/]+');
    return new RegExp(`^${escaped}$`, 'u').test(pathname);
}
export function routeCatalogDigest()
{
    return digest;
}
export function assertExactRouteSet(routeIds)
{
    if (!Array.isArray(routeIds) || routeIds.some((routeId) => typeof routeId !== 'string'))
    {
        throw new Error('route_catalog_exact_match_failed: routeIds must be a string array');
    }
    if (new Set(routeIds).size !== routeIds.length)
    {
        throw new Error('route_catalog_exact_match_failed: duplicate routeId');
    }
    const actual = [...routeIds].sort();
    const expected = [...byId.keys()].sort();
    if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index]))
    {
        throw new Error(`route_catalog_exact_match_failed: expected=${expected.join(',')} actual=${actual.join(',')}`);
    }
}
export function producerRouteIds(producerId)
{
    const routeIds = catalog.producers?.[producerId];
    if (!Array.isArray(routeIds))
    {
        throw new Error(`unknown_route_contract_producer:${producerId}`);
    }
    return routeIds;
}
export async function fetchRouteSample({ routeId, baseUrl, requestPath = null, headers = {}, timeoutMs, fetchImpl = fetch, signal = null })
{
    const contract = routeContract(routeId);
    const requestTarget = requestPath ?? contract.pathTemplate;
    if (!templateMatches(contract.pathTemplate, requestTarget.split('?', 1)[0]))
    {
        throw new Error(`route_path_contract_mismatch:${routeId}`);
    }
    const controller = new AbortController();
    let abortKind = null;
    const abort = (kind) =>
    {
        if (!controller.signal.aborted)
        {
            abortKind = kind;
            controller.abort();
        }
    };
    const cancel = () => abort('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted)
    {
        cancel();
    }
    const timer = setTimeout(() => abort('timeout'), timeoutMs);
    const started = performance.now();
    let httpStatus = 0;
    let receivedBytes = 0;
    let observedContentType = null;
    try
    {
        const response = await fetchImpl(`${baseUrl}${requestTarget}`, { method: contract.method, headers, redirect: 'manual', signal: controller.signal });
        httpStatus = response.status;
        observedContentType = response.headers.get('content-type');
        const chunks = [];
        const reader = response.body?.getReader();
        if (reader)
        {
            try
            {
                while (true)
                {
                    const { value, done } = await reader.read();
                    if (done)
                    {
                        break;
                    }
                    chunks.push(value);
                    receivedBytes += value.byteLength;
                    if (receivedBytes > contract.maximumBodyBytes)
                    {
                        await reader.cancel();
                        break;
                    }
                }
            }
            finally
            {
                reader.releaseLock();
            }
        }
        else if (response.arrayBuffer)
        {
            const value = new Uint8Array(await response.arrayBuffer());
            chunks.push(value);
            receivedBytes = value.byteLength;
        }
        const body = new Uint8Array(receivedBytes);
        let offset = 0;
        for (const chunk of chunks)
        {
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const contentType = String(response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
        const sample = { routeId, contractDigest: digest, status: response.status, contentType, bodyBytes: body.byteLength, latencyMs: Number((performance.now() - started).toFixed(3)), frameType: null, failureKind: null };
        if (response.status >= 300 && response.status < 400 && contract.redirectPolicy === 'forbid')
        {
            sample.failureKind = 'redirect-forbidden';
        }
        else if (response.status !== contract.expectedStatus)
        {
            sample.failureKind = 'unexpected-status';
        }
        else if (!contract.expectedContentType.includes(contentType))
        {
            sample.failureKind = 'unexpected-content-type';
        }
        else if (body.byteLength < contract.minimumBodyBytes || body.byteLength > contract.maximumBodyBytes)
        {
            sample.failureKind = 'body-size-out-of-bounds';
        }
        else if (contract.cacheHeaderPolicy === 'no-store' && !/(?:^|,)\s*no-store(?:\s|,|$)/u.test(String(response.headers.get('cache-control') ?? '').toLowerCase()))
        {
            sample.failureKind = 'cache-header-policy-failed';
        }
        else if (contract.semanticValidatorId === 'non-error-frame')
        {
            try
            {
                const { decodeAedsFrame } = await import(pathToFileURL(path.join(root, 'tests/frontend/support/aeds-envelope.mjs')).href);
                const frame = decodeAedsFrame(body.buffer);
                sample.frameType = frame.frameType;
                if (frame.frameType === 255)
                {
                    sample.failureKind = 'business-error-envelope';
                }
                else if (contract.expectedAedsFrameType !== null && frame.frameType !== contract.expectedAedsFrameType)
                {
                    sample.failureKind = 'unexpected-frame-type';
                }
            }
            catch (error)
            {
                sample.failureKind = `aeds-integrity:${error instanceof Error ? error.message : String(error)}`;
            }
        }
        else if (contract.semanticValidatorId === 'search-manifest')
        {
            try
            {
                const { decodeSearchManifest } = await import(pathToFileURL(path.join(root, 'tests/frontend/support/aeds-envelope.mjs')).href);
                const manifest = decodeSearchManifest(body);
                if (!manifest || typeof manifest !== 'object')
                {
                    sample.failureKind = 'search-manifest-invalid';
                }
            }
            catch (error)
            {
                sample.failureKind = `search-manifest-invalid:${error instanceof Error ? error.message : String(error)}`;
            }
        }
        if (sample.failureKind === null && contract.semanticValidatorId === 'html-document')
        {
            const document = new TextDecoder().decode(body);
            if (!/^\s*<!doctype\s+html[\s>]/iu.test(document)
        || !/<html(?:\s|>)/iu.test(document)
        || !/<body(?:\s|>)/iu.test(document))
            {
                sample.failureKind = 'html-document-invalid';
            }
        }
        const outcome = response.status >= 400 ? 'http-error' : 'success';
        return { ...sample, ok: sample.failureKind === null, outcome,
            errorKind: outcome === 'http-error' ? 'http-status' : null,
            errorCode: outcome === 'http-error' ? response.status : null,
            errorDigest: outcome === 'http-error' ? `sha256:${crypto.createHash('sha256').update(`http-status:${response.status}`).digest('hex')}` : null };
    }
    catch (error)
    {
        const outcome = abortKind ?? 'network-error';
        const errorCode = error?.cause?.code ?? error?.code ?? null;
        const errorKind = abortKind ?? 'request-failed';
        return { routeId, contractDigest: digest, status: httpStatus, contentType: observedContentType,
            bodyBytes: receivedBytes, frameType: null,
            latencyMs: Number((performance.now() - started).toFixed(3)),
            failureKind: outcome === 'network-error' ? 'request-failed' : outcome,
            outcome, errorKind, errorCode,
            errorDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify({ errorKind, errorCode, name: error?.name ?? null })).digest('hex')}`,
            ok: false };
    }
    finally
    {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
    }
}
