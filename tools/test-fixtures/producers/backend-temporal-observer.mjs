const { validateTemporalObservations } = await import(new URL('../../test/temporal-context.mjs', import.meta.url));

export function validateBackendTemporalObservation(temporalContext, observation)
{
    for (const field of ['businessEpochUtc', 'backendCulture', 'postgresTimezone'])
    {
        if (typeof observation?.[field] !== 'string' || !observation[field].trim())
        {
            throw new Error(`backend temporal observation requires actual ${field}`);
        }
    }
    return validateTemporalObservations(temporalContext, observation);
}

// The existing protected endpoint observes both the registered backend clock and
// its database session. This client never manufactures observations from a plan.
export async function observeBackendTemporalContext(context, signal, {
    baseUrl = context.handles?.debugBackendUrl
        ?? context.handles?.baseUrl
        ?? process.env.FSUSBLOG_DEBUG_BACKEND_URL
        ?? process.env.FSUSBLOG_BASE_URL
        ?? ''
} = {})
{
    const secret = context.handles?.localPublicContentFixtureSecret
        ?? context.handles?.localAuthFixtureSecret
        ?? context.handles?.localDemoFixtureSecret
        ?? process.env.FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET
        ?? process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET
        ?? process.env.FSUSBLOG_LOCAL_DEMO_FIXTURE_SECRET
        ?? '';
    if (!baseUrl || !secret)
    {
        throw new Error('backend temporal observation requires the actual backend URL and local fixture secret');
    }
    const response = await fetch(`${String(baseUrl).replace(/\/+$/u, '')}/__local/temporal-observation`, {
        headers: {
            'X-Fsus-Local-Temporal-Fixture-Secret': secret
        },
        signal
    });
    if (!response.ok)
    {
        throw new Error(`backend temporal observation failed HTTP ${response.status}`);
    }
    let observed;
    try
    {
        observed = JSON.parse(await response.text());
    }
    catch
    {
        throw new Error('backend temporal observation returned invalid JSON');
    }
    return validateBackendTemporalObservation(context.temporalContext, observed);
}

export async function observePreparedBackendTemporalContext(context, producerObservation, signal, options)
{
    if (typeof producerObservation?.businessEpochUtc !== 'string'
        || !producerObservation.businessEpochUtc.trim())
    {
        throw new Error('prepared producer requires an actual businessEpochUtc');
    }
    // Validate the producer's own measurement before merging the session read;
    // otherwise the later observation could conceal an earlier drifting epoch.
    validateTemporalObservations(context.temporalContext, producerObservation);
    const backendObservation = await observeBackendTemporalContext(context, signal, options);
    return Object.freeze({ ...producerObservation, ...backendObservation });
}
