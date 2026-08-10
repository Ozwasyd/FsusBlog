function responseStatus(response)
{
    return typeof response?.status === 'function' ? response.status() : response?.status;
}

function responseHeaders(response)
{
    const headers = typeof response?.headers === 'function' ? response.headers() : response?.headers;
    if (!headers || typeof headers !== 'object')
    {
        return {};
    }
    return Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)])
    );
}

export function retryablePublicAotDelayMs(response)
{
    const status = responseStatus(response);
    const headers = responseHeaders(response);
    if (status === 410)
    {
        const revokedGeneration = headers['x-fsus-revoked'] ?? '';
        const cacheControl = String(headers['cache-control'] ?? '').toLowerCase();
        return /^g[1-9]\d*$/u.test(revokedGeneration)
      && cacheControl.includes('no-store')
      && cacheControl.includes('no-cache')
            ? 250
            : null;
    }
    if (status !== 503)
    {
        return null;
    }

    const retryAfter = headers['retry-after'] ?? '';
    if (!/^\d+$/u.test(retryAfter) || Number(retryAfter) <= 0)
    {
        return null;
    }
    if (headers['x-fsus-public-aot-source'] !== 'server-status')
    {
        return null;
    }
    if (headers['x-fsus-public-aot-state'] !== 'transient-failure')
    {
        return null;
    }
    if (!String(headers['cache-control'] ?? '').toLowerCase().includes('no-store'))
    {
        return null;
    }
    if (!String(headers['x-robots-tag'] ?? '').toLowerCase().includes('noindex'))
    {
        return null;
    }

    return Number(retryAfter) * 1_000;
}

export function isRetryablePublicAotTransportError(error)
{
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (message.includes('NS_ERROR_NET_EMPTY_RESPONSE')
    || message.includes('net::ERR_EMPTY_RESPONSE'))
    {
        return true;
    }

    const interrupted = message.match(
        /Navigation to "([^"]+)" is interrupted by another navigation to "([^"]+)"/u
    );
    return interrupted !== null && interrupted[1] === interrupted[2];
}

export async function navigateThroughRetryablePublicAot({
    navigate,
    sleep,
    deadlineAtMs,
    now = Date.now,
    onRetryableResponse = null,
    onRetryableError = null
})
{
    if (typeof navigate !== 'function' || typeof sleep !== 'function')
    {
        throw new TypeError('public AOT navigation requires navigate and sleep functions');
    }
    if (onRetryableResponse !== null && typeof onRetryableResponse !== 'function')
    {
        throw new TypeError('public AOT navigation retry observer must be a function');
    }
    if (onRetryableError !== null && typeof onRetryableError !== 'function')
    {
        throw new TypeError('public AOT navigation error retry observer must be a function');
    }
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= now())
    {
        throw new TypeError('public AOT navigation requires a future runtime-derived deadline');
    }

    let consecutiveTransportRetries = 0;
    while (true)
    {
        let response;
        try
        {
            response = await navigate();
        }
        catch (error)
        {
            consecutiveTransportRetries += 1;
            const retryDelayMs = Math.min(250 * consecutiveTransportRetries, 1_000);
            const remainingMs = deadlineAtMs - now();
            if (!isRetryablePublicAotTransportError(error)
        || retryDelayMs >= remainingMs)
            {
                throw error;
            }
            await onRetryableError?.({ error, retryDelayMs, attempt: consecutiveTransportRetries });
            await sleep(retryDelayMs);
            continue;
        }
        consecutiveTransportRetries = 0;
        const retryDelayMs = retryablePublicAotDelayMs(response);
        if (retryDelayMs === null)
        {
            return response;
        }

        const remainingMs = deadlineAtMs - now();
        if (retryDelayMs >= remainingMs)
        {
            throw new Error(
                `retryable public AOT response exceeds the runtime navigation deadline: retryAfterMs=${retryDelayMs} remainingMs=${Math.max(0, remainingMs)}`
            );
        }
        await onRetryableResponse?.({ response, retryDelayMs });
        await sleep(retryDelayMs);
    }
}
