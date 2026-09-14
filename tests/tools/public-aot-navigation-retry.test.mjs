import assert from 'node:assert/strict';
import test from 'node:test';

const {navigateThroughRetryablePublicAot, retryablePublicAotDelayMs} = await import(new URL('../frontend/support/playwright/publicAotNavigationRetry.mjs', import.meta.url));
function response(status, headers = {})
{
    return {
        status: () => status,
        headers: () => headers
    };
}

const retryableHeaders = {
    'retry-after': '5',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, follow',
    'x-fsus-public-aot-source': 'server-status',
    'x-fsus-public-aot-state': 'transient-failure'
};

test('public AOT retry delay comes from the complete server retry contract', () =>
{
    assert.equal(retryablePublicAotDelayMs(response(503, retryableHeaders)), 5_000);
    assert.equal(retryablePublicAotDelayMs(response(503, {
        ...retryableHeaders,
        'x-fsus-public-aot-state': 'gone'
    })), null);
    assert.equal(retryablePublicAotDelayMs(response(500, retryableHeaders)), null);
});

test('public AOT navigation records but rejects a retryable cold response', async () =>
{
    let clockMs = 1_000;
    const waits = [];
    const retryObservations = [];
    let navigationCount = 0;

    await assert.rejects(navigateThroughRetryablePublicAot({
        navigate: async () =>
        {
            navigationCount += 1;
            return response(503, retryableHeaders);
        },
        sleep: async (delayMs) =>
        {
            waits.push(delayMs);
            clockMs += delayMs;
        },
        onRetryableResponse: ({ response: retryResponse, retryDelayMs }) =>
        {
            retryObservations.push([retryResponse.status(), retryDelayMs, waits.length]);
        },
        deadlineAtMs: 20_000,
        now: () => clockMs
    }), /retryable response on its first attempt/u);

    assert.deepEqual(waits, []);
    assert.deepEqual(retryObservations, [[503, 5_000, 0]]);
    assert.equal(navigationCount, 1);
});

test('public AOT navigation does not retry unrelated service failures', async () =>
{
    let navigationCount = 0;
    const result = await navigateThroughRetryablePublicAot({
        navigate: async () =>
        {
            navigationCount += 1;
            return response(503, { 'retry-after': '5' });
        },
        sleep: async () => assert.fail('unrelated 503 must not sleep'),
        deadlineAtMs: 20_000,
        now: () => 1_000
    });

    assert.equal(result.status(), 503);
    assert.equal(navigationCount, 1);
});

test('public AOT navigation fails immediately rather than waiting within its deadline', async () =>
{
    await assert.rejects(
        navigateThroughRetryablePublicAot({
            navigate: async () => response(503, retryableHeaders),
            sleep: async () => assert.fail('deadline exhaustion must not sleep'),
            deadlineAtMs: 5_000,
            now: () => 1_000
        }),
        /retryable response on its first attempt/u
    );
});
