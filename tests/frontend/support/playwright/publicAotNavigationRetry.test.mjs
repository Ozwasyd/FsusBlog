import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isRetryablePublicAotTransportError,
    navigateThroughRetryablePublicAot
} from './publicAotNavigationRetry.mjs';

test('public AOT navigation preserves an empty-response first failure without retry', async () =>
{
    let attempts = 0;
    const observations = [];

    await assert.rejects(navigateThroughRetryablePublicAot({
        navigate: async () =>
        {
            attempts += 1;
            throw new Error('page.goto: NS_ERROR_NET_EMPTY_RESPONSE');
        },
        sleep: async () => assert.fail('correctness navigation must not sleep for retry'),
        onRetryableError: (value) => observations.push(value),
        deadlineAtMs: 10_000,
        now: () => 0
    }), /NS_ERROR_NET_EMPTY_RESPONSE/u);

    assert.equal(attempts, 1);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].attempt, 1);
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
    await assert.rejects(navigateThroughRetryablePublicAot({
        navigate: async () =>
        {
            attempts += 1;
            throw new Error(
                `page.goto: Navigation to "${target}" is interrupted by another navigation to "${target}"`
            );
        },
        sleep: async () => assert.fail('correctness navigation must not sleep for retry'),
        deadlineAtMs: 10_000,
        now: () => 0
    }), /interrupted by another navigation/u);

    assert.equal(attempts, 1);
});

test('public AOT navigation rejects a revocation-fenced 410 on the first attempt', async () =>
{
    let attempts = 0;
    const observations = [];

    await assert.rejects(navigateThroughRetryablePublicAot({
        navigate: async () =>
        {
            attempts += 1;
            return {
                status: () => 410,
                headers: () => ({
                    'cache-control': 'no-store, no-cache, must-revalidate',
                    'x-fsus-revoked': 'g67'
                })
            };
        },
        sleep: async () => assert.fail('correctness navigation must not sleep for retry'),
        onRetryableResponse: (value) => observations.push(value),
        deadlineAtMs: 10_000,
        now: () => 0
    }), /retryable response on its first attempt/u);

    assert.equal(attempts, 1);
    assert.equal(observations.length, 1);
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

test('public AOT empty-response failure is independent of remaining deadline', async () =>
{
    let attempts = 0;
    await assert.rejects(
        navigateThroughRetryablePublicAot({
            navigate: async () =>
            {
                attempts += 1;
                throw new Error('page.goto: net::ERR_EMPTY_RESPONSE');
            },
            sleep: async () => assert.fail('correctness navigation must not sleep for retry'),
            deadlineAtMs: 3_000,
            now: () => 0
        }),
        /ERR_EMPTY_RESPONSE/u
    );
    assert.equal(attempts, 1);
});
