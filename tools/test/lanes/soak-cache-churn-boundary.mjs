export const cacheChurnBoundaryPath = '/_fsus/testing/runtime-cache/cache-churn/generation-boundary';

// This is a read-only adapter preflight, never an alternative churn producer.
// Keep the independent production coordinates as reported by their owners.
export async function readCacheChurnBoundary({ baseUrl, namespace, runId, secret, timeoutMs, signal })
{
    const result = { status: 'blocked', runId, namespace, observation: null };
    if (!secret)
    {
        return { ...result, failureKind: 'cache-churn-observation-secret-unavailable' };
    }
    try
    {
        const url = new URL(cacheChurnBoundaryPath, baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)
            || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
        {
            throw new Error('cache-churn-observation-target-not-loopback');
        }
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
        {
            throw new Error('cache-churn-observation-timeout-invalid');
        }
        url.searchParams.set('runId', runId);
        url.searchParams.set('namespace', namespace);
        const deadline = AbortSignal.timeout(timeoutMs);
        const response = await fetch(url, {
            method: 'GET', redirect: 'manual',
            headers: {
                Accept: 'application/json',
                'X-Fsus-Runtime-Evidence-Secret': secret,
                'X-Fsus-Test-Session': namespace
            },
            signal: signal ? AbortSignal.any([signal, deadline]) : deadline
        });
        if (response.status !== 200)
        {
            await response.body?.cancel();
            throw new Error(`cache-churn-observation-http:${response.status}`);
        }
        const observation = await response.json();
        if (observation.schema !== 'fsusblog.cache-churn-generation-boundary.v1'
            || observation.runId !== runId || observation.namespace !== namespace
            || observation.scopeToken !== namespace)
        {
            throw new Error('cache-churn-observation-identity-mismatch');
        }
        // No current canonical owner supplies a DB-to-delivery-to-artifact
        // coordinate. Even coincidentally equal counters cannot establish it.
        if (observation.commonGenerationBinding !== null
            || observation.mutationReceiptBinding !== null)
        {
            throw new Error('cache-churn-observation-binding-not-supported');
        }
        return {
            ...result, observation,
            failureKind: 'cache-churn-common-generation-binding-unavailable'
        };
    }
    catch (error)
    {
        const interrupted = signal?.aborted || error.name === 'TimeoutError' || error.name === 'AbortError';
        return {
            ...result,
            failureKind: interrupted ? 'cache-churn-observation-interrupted'
                : error.message.startsWith('cache-churn-') ? error.message : 'cache-churn-observation-transport-failed'
        };
    }
}
