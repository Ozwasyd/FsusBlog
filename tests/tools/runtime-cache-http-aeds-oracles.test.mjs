import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { binaryGetResponseError, runtimeCacheResponseError } from '../../tools/test/runtime-cache-scenarios/related-reading-contract.mjs';
import { encodeAedsFrame } from '../frontend/support/aeds-envelope.mjs';

function request({ page = 10, negative = false, frameType = negative ? 251 : 1, code = 1, embeddedStatus = 400 } = {})
{
    const payload = Buffer.alloc(negative ? 584 : 12);
    if (negative)
    {
        payload[0] = code;
        payload.writeInt32LE(embeddedStatus, 4);
    }
    const body = Buffer.from(encodeAedsFrame(frameType, payload));
    return {
        method: 'GET',
        path: `/api/binary/article/list/home/${page}/10.aeds?sort=latest${!negative && page > 1 ? '&cursor=opaque%2Bcursor' : ''}`,
        subcaseId: negative ? 'cursorless-deep' : `page-${page}`,
        parityGroup: `pagination-${negative ? 'cursorless' : 'page'}-${page}`,
        status: negative ? 400 : 200,
        responseContentType: 'application/octet-stream',
        responseBodyBase64: body.toString('base64'),
        payloadDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`
    };
}

function replaceBody(value, body)
{
    value.responseBodyBase64 = body.toString('base64');
    value.payloadDigest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

test('current logical and cursorless page recipes require their exact AEDS responses', () =>
{
    for (const page of [1, 10, 100, 1000])
    {
        assert.equal(runtimeCacheResponseError('pagination', request({ page })), null);
    }
    for (const page of [10, 100, 1000, 1001])
    {
        assert.equal(runtimeCacheResponseError('pagination', request({ page, negative: true })), null);
    }
    const parameterized = request();
    parameterized.responseContentType = 'Application/Octet-Stream; charset=binary';
    assert.equal(binaryGetResponseError(parameterized), null);
});

for (const [name, mutate, expected] of [
    ['HTTP 404', (value) =>
    {
        value.status = 404;
    }, /HTTP 404/u],
    ['HTTP 503', (value) =>
    {
        value.status = 503;
    }, /HTTP 503/u],
    ['HTTP redirect', (value) =>
    {
        value.status = 302;
    }, /HTTP 302/u],
    ['foreign legal binary route and frame', (value) =>
    {
        value.path = '/api/binary/article/17.aeds';
        replaceBody(value, Buffer.from(encodeAedsFrame(2, Buffer.alloc(12))));
    }, /binding failed/u],
    ['absolute path', (value) =>
    {
        value.path = `https://foreign.invalid${value.path}`;
    }, /relative path/u],
    ['protocol-relative path', (value) =>
    {
        value.path = `//foreign.invalid${value.path}`;
    }, /relative path/u],
    ['encoded separator', (value) =>
    {
        value.path = value.path.replace('/home/', '/home%2F');
    }, /non-canonical/u],
    ['normalized dot path', (value) =>
    {
        value.path = value.path.replace('/home/', '/home/../home/');
    }, /non-canonical/u],
    ['duplicate cursor', (value) =>
    {
        value.path += '&cursor=second';
    }, /duplicate/u],
    ['encoded query-key alias', (value) =>
    {
        value.path = value.path.replace('sort=', '%73ort=');
    }, /non-canonical query/u],
    ['foreign query', (value) =>
    {
        value.path += '&foreign=1';
    }, /binding failed/u],
    ['wrong sort', (value) =>
    {
        value.path = value.path.replace('latest', 'hot');
    }, /binding failed/u],
    ['missing deep cursor', (value) =>
    {
        value.path = value.path.split('&cursor=')[0];
    }, /binding failed/u],
    ['wrong method', (value) =>
    {
        value.method = 'POST';
    }, /binding failed/u],
    ['wrong subcase', (value) =>
    {
        value.subcaseId = 'page-100';
    }, /binding failed/u],
    ['wrong parity identity', (value) =>
    {
        value.parityGroup = 'foreign';
    }, /binding failed/u],
    ['wrong Content-Type', (value) =>
    {
        value.responseContentType = 'application/json';
    }, /Content-Type/u],
    ['missing Content-Type', (value) =>
    {
        delete value.responseContentType;
    }, /Content-Type/u],
    ['missing bytes', (value) =>
    {
        delete value.responseBodyBase64;
    }, /missing response bytes/u],
    ['malformed base64', (value) =>
    {
        value.responseBodyBase64 += '!';
    }, /non-canonical/u],
    ['cross-digest bytes', (value) =>
    {
        value.payloadDigest = `sha256:${'a'.repeat(64)}`;
    }, /observed payload digest/u],
    ['foreign frame type', (value) =>
    {
        replaceBody(value, Buffer.from(encodeAedsFrame(2, Buffer.alloc(12))));
    }, /wrong AEDS frame type/u],
    ...[
        ['magic', (body) =>
        {
            body[0] ^= 1;
        }],
        ['version', (body) =>
        {
            body[4] = 1;
        }],
        ['flags', (body) =>
        {
            body.writeUInt16LE(1, 6);
        }],
        ['header length', (body) =>
        {
            body[5] = 15;
        }],
        ['payload length', (body) =>
        {
            body.writeUInt32LE(1000, 10);
        }],
        ['CRC', (body) =>
        {
            body[body.length - 1] ^= 1;
        }]
    ].map(([field, corrupt]) => [`malformed ${field}`, (value) =>
    {
        const body = Buffer.from(value.responseBodyBase64, 'base64');
        corrupt(body);
        replaceBody(value, body);
    }, /aeds_|crc_|flags/u])
])
{
    test(`HTTP/AEDS oracle rejects ${name}`, () =>
    {
        const value = request();
        mutate(value);
        assert.match(runtimeCacheResponseError('pagination', value), expected);
    });
}

for (const [name, options, mutate, expected] of [
    ['generic 404', {}, (value) =>
    {
        value.status = 404;
    }, /expected HTTP 400/u],
    ['success relabel', {}, (value) =>
    {
        value.status = 200;
    }, /expected HTTP 400/u],
    ['positive frame', { frameType: 1 }, () =>
    {}, /wrong AEDS frame type/u],
    ['wrong ErrorCode', { code: 2 }, () =>
    {}, /ApiError\(Validation\)/u],
    ['wrong embedded status', { embeddedStatus: 403 }, () =>
    {}, /embedded HTTP 400/u],
    ['truncated ApiError POD', {}, (value) =>
    {
        replaceBody(value, Buffer.from(encodeAedsFrame(251, Buffer.alloc(12))));
    }, /api_error_payload/u],
    ['negative-to-positive subcase', {}, (value) =>
    {
        value.subcaseId = 'page-10';
    }, /binding failed/u],
    ['negative with cursor', {}, (value) =>
    {
        value.path += '&cursor=opaque';
    }, /binding failed/u],
    ['first-page negative', { page: 1 }, () =>
    {}, /binding failed/u]
])
{
    test(`cursorless oracle rejects ${name}`, () =>
    {
        const value = request({ ...options, negative: true });
        mutate(value);
        assert.match(runtimeCacheResponseError('pagination', value), expected);
    });
}
