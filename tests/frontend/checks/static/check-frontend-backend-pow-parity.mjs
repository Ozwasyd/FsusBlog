#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { URL } from 'node:url';

const { publishStaticAtomicAssertionResult } = await import(new URL('../../../../tools/test/static-atomic/assertion-result.mjs', import.meta.url));
const {
    assert,
    extractBackendBinaryRoutes,
    routeKey,
    root,
    walk
} = await import(new URL('../support/crossStackMatrix.mjs', import.meta.url));

const routes = extractBackendBinaryRoutes();
const routesByKey = new Map(routes.map(route => [route.key, route]));
const routesByOperationId = new Map(routes.map(route => [route.operationId, route]));
const frontendApiDir = resolve(root, 'src/frontend/src/api');
const generatedRoutes = readFileSync(resolve(root, 'src/frontend/src/generated/fsusBinaryRoutes.ts'), 'utf8');

assert(generatedRoutes.includes('export const fsusBinaryRouteSecurity'), 'generated binary routes must export security metadata');
assert(generatedRoutes.includes('requiresPow: true'), 'generated binary route security metadata must include pow=true routes');
assert(generatedRoutes.includes('requiresPow: false'), 'generated binary route security metadata must include pow=false routes');

for (const expected of [
    ['GET', '/comment/{articleId:int}', false, 'public comment list'],
    ['GET', '/comment/{articleId:int}/thread/{rootId:long}', false, 'public comment thread replies'],
    ['GET', '/article/{articleId:int}/related.aeds', false, 'public related reading'],
    ['POST', '/comment', true, 'comment create'],
    ['POST', '/upload/init', true, 'upload group init'],
    ['POST', '/admin/article', true, 'admin article create']
])
{
    const [method, path, pow, label] = expected;
    // routeKey normalizes Minimal API type constraints to OpenAPI bare params.
    const route = routesByKey.get(routeKey(method, path));
    assert(route, `${label} backend route missing from OpenAPI`);
    assert(route.pow === pow, `${label} backend x-fsus-pow expected ${pow}, got ${route.pow}`);
}

const failures = [];
for (const file of walk(frontendApiDir, path => path.endsWith('.ts')))
{
    const source = readFileSync(file, 'utf8');
    const relativePath = file.slice(root.length + 1);
    for (const match of source.matchAll(/requiresPow\s*:\s*true/g))
    {
        const index = match.index ?? 0;
        const contextStart = Math.max(0, index - 900);
        const contextEnd = Math.min(source.length, index + 500);
        const beforeContext = source.slice(contextStart, index);
        const afterContext = source.slice(index, contextEnd);
        const operationId = findNearestOperationId(beforeContext);
        const binaryUrl = findNearestBinaryUrl(beforeContext);
        const method = findRequestMethod(beforeContext) ?? findRequestMethod(afterContext) ?? 'GET';
        const route = operationId
            ? routesByOperationId.get(operationId)
            : binaryUrl
        ? findBackendRoute(method, binaryUrl)
        : null;
        const routeLabel = operationId ?? (binaryUrl ? `${method} ${binaryUrl}` : null);
        if (!routeLabel)
        {
            failures.push(`${relativePath}:${lineOf(source, index)}: requiresPow true has no nearby binary route descriptor`);
            continue;
        }

        if (!route)
        {
            failures.push(`${relativePath}:${lineOf(source, index)}: ${routeLabel} does not match generated backend binary route metadata`);
            continue;
        }

        if (route.pow !== true)
        {
            failures.push(`${relativePath}:${lineOf(source, index)}: ${routeLabel} has frontend requiresPow=true but backend x-fsus-pow=${route.pow}`);
        }
    }
}

assertPublicWrapperHasNoPow('src/frontend/src/api/comment.ts', /operationId:\s*['"`]binary_get_comment_articleId_int['"`]/g, 'public comment list');
assertPublicWrapperHasNoPow('src/frontend/src/api/comment.ts', /operationId:\s*['"`]binary_get_comment_articleId_int_thread_rootId_long['"`]/g, 'public comment thread replies');
assertPublicWrapperHasNoPow('src/frontend/src/api/article.ts', /operationId:\s*['"`]binary_get_article_articleId_int_related_aeds['"`]/g, 'public related reading');

if (failures.length > 0)
{
    try
    {
        publishStaticAtomicAssertionResult('pow-parity', import.meta.url, 'failure');
    }
    catch (publicationError)
    {
        console.error('[static-assertion-result] publication failed:', publicationError);
    }
    throw new Error(`frontend/backend PoW parity failed:\n${failures.join('\n')}`);
}

publishStaticAtomicAssertionResult('pow-parity', import.meta.url, 'success');
console.log(`[frontend-backend-pow-parity] ok frontendRequiresPow=${countFrontendRequiresPow()} backendRoutes=${routes.length}`);

function findNearestBinaryUrl(context)
{
    const matches = [...context.matchAll(/binaryUrl\s*:\s*(['"`])([\s\S]*?)\1/g)];
    const last = matches.at(-1);
    return last?.[2]?.split('?')[0] ?? null;
}

function findNearestOperationId(context)
{
    const matches = [...context.matchAll(/operationId\s*:\s*['"`]([^'"`]+)['"`]/g)];
    return matches.at(-1)?.[1] ?? null;
}

function findRequestMethod(context)
{
    const matches = [...context.matchAll(/method\s*:\s*['"`]([A-Z]+)['"`]/g)];
    return matches.at(-1)?.[1] ?? null;
}

function findBackendRoute(method, frontendPath)
{
    const candidates = routes.filter(route => route.method === method);
    return candidates.find(route => pathMatches(frontendPath, `/api/binary${route.path}`)) ?? null;
}

function pathMatches(frontendPath, backendPath)
{
    const frontendSegments = normalizePath(frontendPath).split('/').filter(Boolean);
    const backendSegments = normalizePath(backendPath).split('/').filter(Boolean);
    if (frontendSegments.length !== backendSegments.length)
    {
        return false;
    }

    return frontendSegments.every((segment, index) =>
    {
        const expected = backendSegments[index];
        if (segment.includes('${'))
        {
            return expected.startsWith('{') && expected.endsWith('}');
        }
        return segment === expected;
    });
}

function normalizePath(value)
{
    return value
        .replace(/\?.*$/, '')
        .replace(/`/g, '')
        .replace(/\/+$/, '');
}

function assertPublicWrapperHasNoPow(path, pattern, label)
{
    const source = readFileSync(resolve(root, path), 'utf8');
    const match = pattern.exec(source);
    assert(match, `${label} frontend wrapper missing expected binaryUrl`);
    const start = match.index;
    const nextCall = source.indexOf('requestBinaryOnly', start + 1);
    const block = source.slice(start, nextCall === -1 ? Math.min(source.length, start + 600) : nextCall);
    if (/requiresPow\s*:\s*true/.test(block))
    {
        failures.push(`${path}:${lineOf(source, start)}: ${label} must not set requiresPow=true`);
    }
    pattern.lastIndex = 0;
}

function countFrontendRequiresPow()
{
    let count = 0;
    for (const file of walk(frontendApiDir, path => path.endsWith('.ts')))
    {
        count += (readFileSync(file, 'utf8').match(/requiresPow\s*:\s*true/g) ?? []).length;
    }
    return count;
}

function lineOf(source, index)
{
    return source.slice(0, index).split('\n').length;
}
