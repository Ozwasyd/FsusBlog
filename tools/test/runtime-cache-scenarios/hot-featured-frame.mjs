const { readVerifiedAdminRuntimeProjection } = await import(new URL('../../test-fixtures/receipt/projection.mjs', import.meta.url));

const {
    exactAssertionResult,
    mapConcurrent,
    produceMeasuredScenarioReceipt
} = await import(new URL('../run-runtime-cache-evidence.mjs', import.meta.url));

const families = Object.freeze({
    hot: 'article-hot-frame',
    featured: 'article-featured-frame'
});

function requireAdminHeaders(value)
{
    const entries = Object.entries(value ?? {});
    if (entries.length !== 1 || !['Authorization', 'Cookie'].includes(entries[0][0]))
    {
        throw new Error('hot-featured-frame requires exactly one Authorization or Cookie admin header');
    }
    const [name, raw] = entries[0];
    const header = String(raw ?? '').trim();
    if (!header || /[\0\r\n]/u.test(header) || (name === 'Authorization' && !header.startsWith('Bearer ')))
    {
        throw new Error('hot-featured-frame admin header is invalid');
    }
    return { [name]: header };
}

async function resolveAdminHeaders(options)
{
    // The injected measurement harness is unit evidence only. No CLI path can
    // supply it or turn a naked header into runtime fixture qualification.
    if (options.produceMeasuredScenarioReceipt && options.adminHeaders && !options.fixtureAdmission)
    {
        return requireAdminHeaders(options.adminHeaders);
    }
    const admission = options.fixtureAdmission;
    if (!admission?.input.privateAdmin)
    {
        throw new Error('hot-featured-frame blocked: verified typed admin consumer artifact required; no header/legacy endpoint fallback');
    }
    return readVerifiedAdminRuntimeProjection(admission.input.privateAdmin.path, {
        authReceipt: admission.authReceipt,
        publicReceipt: admission.receipt,
        consumerProfileId: admission.input.declaration.profileId,
        consumerId: admission.input.declaration.consumerId,
        executionIdentity: admission.receipt.executionIdentity,
        expectedContentDigest: admission.input.privateAdmin.contentDigest,
        handles: { baseUrl: options.baseUrl,
            localAuthFixtureSecret: process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET }
    });
}

function requestSpecs(count, kind, headers)
{
    const size = kind === 'hot' ? 49 : 9;
    return Array.from({ length: count }, () => ({
        method: 'GET',
        path: `/api/binary/admin/article/${kind}?size=${size}`,
        subcaseId: kind,
        parityGroup: `admin-${kind}-whole-frame`,
        headers
    }));
}

function summarizeFamily(requests, family)
{
    const allEvents = requests.flatMap((request) => request.cacheEvents
        .map((event) => ({ request, event })));
    const events = allEvents
        .filter(({ event }) => event.family === family);
    const builds = allEvents.filter(({ event }) => event.outcome === 'built');
    const published = events.filter(({ event }) => event.outcome === 'published');
    const identityDigests = [...new Set(builds.map(({ event }) => event.identityDigest))];
    const atomicPublishers = published.filter(({ request }) =>
        request.redisCommands.some((command) => command.category === 'atomic-script'));
    return {
        buildCount: builds.length,
        identityCount: identityDigests.length,
        publicationCount: published.length,
        atomicPublisherCount: atomicPublishers.length,
        databaseCommandCount: requests.reduce((sum, request) => sum + request.dbCommands.length, 0),
        anonymousL0Count: requests.filter((request) => request.layerSource === 'l0-allow').length
    };
}

export async function produceHotFeaturedFrameReceipt(options)
{
    const { scenario } = options;
    if (scenario.requests < 2 || scenario.requests % 2 !== 0)
    {
        throw new Error('hot-featured-frame request count must be a positive even number');
    }
    const adminHeaders = await resolveAdminHeaders(options);
    const perIdentity = scenario.requests / 2;
    const produce = options.produceMeasuredScenarioReceipt ?? produceMeasuredScenarioReceipt;

    return produce(options, {
        warmup: async () => [],
        sample: async ({ collect }) =>
        {
            const hotSpecs = requestSpecs(perIdentity, 'hot', adminHeaders);
            const hot = await mapConcurrent(hotSpecs, scenario.concurrency, (spec, index) => collect(spec, index));
            const featuredSpecs = requestSpecs(perIdentity, 'featured', adminHeaders);
            const featured = await mapConcurrent(featuredSpecs, scenario.concurrency, (spec, index) =>
                collect(spec, hot.length + index));
            const requests = [...hot, ...featured];
            const hotSummary = summarizeFamily(hot, families.hot);
            const featuredSummary = summarizeFamily(featured, families.featured);
            const first = requests[0];
            return {
                requests,
                assertionResults: [
                    exactAssertionResult(
                        'same-identity-build',
                        { hotIdentityCount: 1, featuredIdentityCount: 1, anonymousL0Count: 0 },
                        {
                            hotIdentityCount: hotSummary.identityCount,
                            featuredIdentityCount: featuredSummary.identityCount,
                            anonymousL0Count: hotSummary.anonymousL0Count + featuredSummary.anonymousL0Count
                        },
                        first),
                    exactAssertionResult(
                        'rebuild-count',
                        scenario.requirements.rebuildCountBySubcase,
                        { hot: hotSummary.buildCount, featured: featuredSummary.buildCount },
                        first),
                    exactAssertionResult(
                        'db-command-budget',
                        { hotWithinBudget: true, featuredWithinBudget: true },
                        {
                            hotWithinBudget: hotSummary.databaseCommandCount <= scenario.requirements.dbCommandsMaxPerIdentity,
                            featuredWithinBudget: featuredSummary.databaseCommandCount <= scenario.requirements.dbCommandsMaxPerIdentity
                        },
                        first),
                    exactAssertionResult(
                        'atomic-redis-publication',
                        {
                            hotPublicationCount: 1,
                            featuredPublicationCount: 1,
                            hotAtomicPublisherCount: 1,
                            featuredAtomicPublisherCount: 1
                        },
                        {
                            hotPublicationCount: hotSummary.publicationCount,
                            featuredPublicationCount: featuredSummary.publicationCount,
                            hotAtomicPublisherCount: hotSummary.atomicPublisherCount,
                            featuredAtomicPublisherCount: featuredSummary.atomicPublisherCount
                        },
                        first)
                ],
                parameters: {
                    routes: ['/api/binary/admin/article/hot', '/api/binary/admin/article/featured'],
                    sizes: { hot: 49, featured: 9 },
                    requestsPerIdentity: perIdentity,
                    observedDatabaseCommands: {
                        hot: hotSummary.databaseCommandCount,
                        featured: featuredSummary.databaseCommandCount
                    }
                }
            };
        }
    });
}
