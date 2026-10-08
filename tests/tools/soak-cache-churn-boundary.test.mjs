import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

const { cacheChurnBoundaryPath, readCacheChurnBoundary }
    = await import(new URL('../../tools/test/lanes/soak-cache-churn-boundary.mjs', import.meta.url));
const identity = { runId: 'soak-live-boundary', namespace: 'dedicated-run', secret: 'fixture-secret', timeoutMs: 1000 };

async function withServer(handler, action)
{
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try
    {
        return await action(`http://127.0.0.1:${server.address().port}`);
    }
    finally
    {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

function observation(overrides = {})
{
    return {
        schema: 'fsusblog.cache-churn-generation-boundary.v1',
        runId: identity.runId, namespace: identity.namespace, scopeToken: identity.namespace,
        taxonomyFrameCounter: 17, hotReadSnapshotVersion: 1730000000000,
        deliveryObligation: { targetGeneration: 4, publishedGeneration: 4 },
        aotInvalidation: { currentVersion: 3 }, databaseGeneration: null,
        commonGenerationBinding: null, mutationReceiptBinding: null, ...overrides
    };
}

test('HTTP preflight preserves actual owner domains and cannot claim a churn cycle', async () =>
{
    let requests = 0;
    await withServer((request, response) =>
    {
        requests += 1;
        assert.equal(request.method, 'GET');
        assert.equal(new URL(request.url, 'http://localhost').pathname, cacheChurnBoundaryPath);
        assert.equal(request.headers['x-fsus-test-session'], identity.namespace);
        assert.equal(request.headers['x-fsus-runtime-evidence-secret'], identity.secret);
        response.end(JSON.stringify(observation()));
    }, async (baseUrl) =>
    {
        const result = await readCacheChurnBoundary({ baseUrl, ...identity });
        assert.equal(result.status, 'blocked');
        assert.equal(result.failureKind, 'cache-churn-common-generation-binding-unavailable');
        assert.deepEqual(result.observation, observation());
        assert.equal(Object.hasOwn(result, 'cycles'), false);
    });
    assert.equal(requests, 1);
});

test('coincidentally equal counters are not a common generation binding', async () =>
{
    await withServer((request, response) => response.end(JSON.stringify(observation({
        taxonomyFrameCounter: 4, hotReadSnapshotVersion: 4, aotInvalidation: { currentVersion: 4 }
    }))), async (baseUrl) =>
    {
        assert.equal((await readCacheChurnBoundary({ baseUrl, ...identity })).status, 'blocked');
    });
});

test('wrong namespace, run or schema never imports another observation', async () =>
{
    for (const invalid of [{ scopeToken: 'shared' }, { namespace: 'other-run' }, { runId: 'old-run' }, { schema: 'invented' }])
    {
        await withServer((request, response) => response.end(JSON.stringify(observation(invalid))), async (baseUrl) =>
        {
            const result = await readCacheChurnBoundary({ baseUrl, ...identity });
            assert.equal(result.failureKind, 'cache-churn-observation-identity-mismatch');
            assert.equal(result.observation, null);
        });
    }
});

test('unsupported binding cannot silently qualify an injected adapter', async () =>
{
    await withServer((request, response) => response.end(JSON.stringify(observation({ commonGenerationBinding: 'invented' }))),
        async (baseUrl) => assert.equal((await readCacheChurnBoundary({ baseUrl, ...identity })).failureKind,
            'cache-churn-observation-binding-not-supported'));
});

test('auth refusal, missing route and redirect fail without exposing response bodies', async () =>
{
    for (const status of [403, 404, 302, 500])
    {
        await withServer((request, response) =>
        {
            response.writeHead(status, { Location: 'https://example.invalid/' });
            response.end(identity.secret);
        }, async (baseUrl) =>
        {
            const result = await readCacheChurnBoundary({ baseUrl, ...identity });
            assert.equal(result.failureKind, `cache-churn-observation-http:${status}`);
            assert.equal(JSON.stringify(result).includes(identity.secret), false);
        });
    }
});

test('unresponsive observer is interrupted by an explicit deadline', async () =>
{
    await withServer(() =>
    {}, async (baseUrl) =>
    {
        const result = await readCacheChurnBoundary({ baseUrl, ...identity, timeoutMs: 20 });
        assert.equal(result.failureKind, 'cache-churn-observation-interrupted');
    });
});

test('missing secret and nonlocal target do not send credentials or mutations', async () =>
{
    assert.equal((await readCacheChurnBoundary({ ...identity, secret: '' })).failureKind,
        'cache-churn-observation-secret-unavailable');
    assert.equal((await readCacheChurnBoundary({ ...identity, baseUrl: 'https://example.invalid' })).failureKind,
        'cache-churn-observation-target-not-loopback');
});
