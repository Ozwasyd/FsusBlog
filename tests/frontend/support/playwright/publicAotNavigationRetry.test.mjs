import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isRetryablePublicAotTransportError,
    navigateThroughRetryablePublicAot
} from './publicAotNavigationRetry.mjs';

test('public AOT navigation retries bounded empty-response transport failures', async () =>
{
    let attempts = 0;
    const delays = [];
    const response = { status: () => 200, headers: () => ({}) };

    const observed = await navigateThroughRetryablePublicAot({
        navigate: async () =>
        {
            attempts += 1;
            if (attempts < 3)
            {
                throw new Error('page.goto: NS_ERROR_NET_EMPTY_RESPONSE');
            }
            return response;
        },
        sleep: async (delay) => delays.push(delay),
        deadlineAtMs: 10_000,
        now: () => 0
    });

    assert.equal(observed, response);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [250, 500]);
});

test('public AOT navigation retries only same-target Firefox navigation interruptions', async () =>
{
    const target = 'http://127.0.0.1:28210/article/57';
    assert.equal(
        isRetryablePublicAotTransportError(
            new Error(`page.goto: Navigation to "${target}" is interrupted by another navigation to "${target}"`)
        ),
        true
    );
    assert.equal(
        isRetryablePublicAotTransportError(
            new Error(`page.goto: Navigation to "${target}" is interrupted by another navigation to "http://127.0.0.1:28210/login"`)
        ),
        false
    );

    let attempts = 0;
    const response = { status: () => 200, headers: () => ({}) };
    const observed = await navigateThroughRetryablePublicAot({
        navigate: async () =>
        {
            attempts += 1;
            if (attempts === 1)
            {
                throw new Error(
                    `page.goto: Navigation to "${target}" is interrupted by another navigation to "${target}"`
                );
            }
            return response;
        },
        sleep: async () =>
        {},
        deadlineAtMs: 10_000,
        now: () => 0
    });

    assert.equal(observed, response);
    assert.equal(attempts, 2);
});

test('public AOT navigation retries a revocation-fenced 410 until the route is readable', async () =>
{
    let attempts = 0;
    const delays = [];
    const readable = { status: () => 200, headers: () => ({}) };

    const observed = await navigateThroughRetryablePublicAot({
        navigate: async () =>
        {
            attempts += 1;
            return attempts < 3
                ? {
            status: () => 410,
            headers: () => ({
              'cache-control': 'no-store, no-cache, must-revalidate',
              'x-fsus-revoked': 'g67'
            })
          }
                : readable;
        },
        sleep: async (delay) => delays.push(delay),
        deadlineAtMs: 10_000,
        now: () => 0
    });

    assert.equal(observed, readable);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [250, 250]);
});

test('public AOT navigation does not retry unrelated HTTP or browser failures', async () =>
{
    assert.equal(isRetryablePublicAotTransportError(new Error('HTTP 410')), false);
    assert.equal(isRetryablePublicAotTransportError(new Error('page.goto: NS_ERROR_NET_EMPTY_RESPONSE')), true);

    let httpAttempts = 0;
    const unrelatedHttp = await navigateThroughRetryablePublicAot({
        navigate: async () =>
        {
            httpAttempts += 1;
            return {
                status: () => 410,
                headers: () => ({ 'cache-control': 'no-store' })
            };
        },
        sleep: async () => assert.fail('unrelated HTTP failures must not sleep'),
        deadlineAtMs: 10_000,
        now: () => 0
    });
    assert.equal(unrelatedHttp.status(), 410);
    assert.equal(httpAttempts, 1);

    let attempts = 0;
    await assert.rejects(
        navigateThroughRetryablePublicAot({
            navigate: async () =>
            {
                attempts += 1;
                throw new Error('page.goto: connection refused');
            },
            sleep: async () => assert.fail('unrelated errors must not sleep'),
            deadlineAtMs: 10_000,
            now: () => 0
        }),
        /connection refused/u
    );
    assert.equal(attempts, 1);
});

test('public AOT empty-response retries remain bounded by the runtime deadline', async () =>
{
    let attempts = 0;
    let nowMs = 0;
    const delays = [];
    await assert.rejects(
        navigateThroughRetryablePublicAot({
            navigate: async () =>
            {
                attempts += 1;
                throw new Error('page.goto: net::ERR_EMPTY_RESPONSE');
            },
            sleep: async (delayMs) =>
            {
                delays.push(delayMs);
                nowMs += delayMs;
            },
            deadlineAtMs: 3_000,
            now: () => nowMs
        }),
        /ERR_EMPTY_RESPONSE/u
    );
    assert.equal(attempts, 5);
    assert.deepEqual(delays, [250, 500, 750, 1_000]);
});
