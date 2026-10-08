import assert from 'node:assert/strict';

// This is the PublicShell isolation prohibition, not a URL or font allowlist.
const unrelatedDomains = Object.freeze(['admin', 'security', 'identity', 'messages']);
const localeKinds = Object.freeze(['domain', 'font', 'font-style']);

/** Recompute locale resource bounds from the admitted build inventory, never from the waterfall. */
export function derivePublicShellLocaleNetworkBudget({ bindings, scene })
{
    assert.ok(Array.isArray(scene.requiredDomains) && scene.requiredDomains.length > 0,
        'network route domain authority missing');
    assert.ok(scene.requiredDomains.every((domain) => !unrelatedDomains.includes(domain)),
        'network PublicShell manifest contains a prohibited unrelated domain');
    const resources = bindings.resources.filter((resource) => resource.identities.some((identity) =>
        identity.kind === 'domain' && identity.locale === scene.locale && scene.requiredDomains.includes(identity.domain)
        || ['font', 'font-style'].includes(identity.kind) && identity.locale === scene.locale
            && identity.script === scene.requiredFont.script));
    assert.equal(new Set(resources.map((resource) => resource.url)).size, resources.length,
        'network manifest resource identity is ambiguous');
    for (const resource of resources)
    {
        assert.ok(Number.isSafeInteger(resource.size) && resource.size > 0,
            'network immutable artifact byte size missing');
        assert.ok(resource.identities.filter((identity) => ['font', 'font-style'].includes(identity.kind))
            .every((identity) => identity.script === scene.requiredFont.script),
        'network shared font artifact contains another script');
        for (const identity of resource.identities.filter((item) => item.kind === 'domain'))
        {
            assert.ok(identity.locale === scene.locale && scene.requiredDomains.includes(identity.domain),
                'network shared chunk contains an unrelated locale/domain');
        }
    }
    for (const domain of scene.requiredDomains)
    {
        assert.equal(resources.filter((resource) => resource.identities.some((identity) =>
            identity.kind === 'domain' && identity.locale === scene.locale && identity.domain === domain)).length, 1,
        'network required domain has no unique manifest owner');
    }
    assert.ok(resources.some((resource) => resource.identities.some((identity) => identity.kind === 'font')),
        'network script font artifacts missing');
    return { resources, maximumRequests: resources.length,
        maximumDecodedBytes: resources.reduce((sum, resource) => sum + resource.size, 0) };
}

/** Used by the existing browser waterfall owner. Timing/cache never substitutes for response identity.
 * Font subsets are optional within the current script's CSS plan; all requested subsets count once.
 * This projection remains diagnostic and does not grant browser or whole-matrix qualification.
 */
export function assertPublicShellLocaleNetwork({ bindings, scene, evidence })
{
    assert.equal(scene.stage, 'initial-network', 'network initial scene required');
    assert.deepEqual(evidence.identity, bindings.identity, 'network build/source identity mismatch');
    const budget = derivePublicShellLocaleNetworkBudget({ bindings, scene });
    const allowed = new Map(budget.resources.map((resource) => [resource.url, resource]));
    const inventory = new Map(bindings.resources.map((resource) => [resource.url, resource]));
    const observed = [];
    let decodedBytes = 0;
    let encodedBytes = 0;
    const seen = new Set();
    for (const request of evidence.requests)
    {
        const admitted = inventory.get(request.url);
        if (!admitted?.identities.some((identity) => localeKinds.includes(identity.kind)))
        {
            continue; // The enclosing waterfall owns document/static/API classification.
        }
        const resource = allowed.get(request.url);
        assert.ok(resource, 'network requested an unrelated locale/domain/font identity');
        assert.equal(request.method, 'GET', 'network locale resource write');
        assert.equal(seen.has(request.url), false, 'network locale resource request budget exceeded');
        seen.add(request.url);
        assert.ok(Number.isSafeInteger(request.requestOrdinal), 'network actual request ordinal missing');
        const responses = evidence.responses.filter((response) => response.requestOrdinal === request.requestOrdinal);
        assert.equal(responses.length, 1, 'network response identity missing or duplicated');
        const response = responses[0];
        assert.equal(response.url, request.url, 'network response URL identity mismatch');
        assert.deepEqual(response.resource, resource, 'network response manifest identity was altered');
        assert.equal(response.status, 200, 'network locale response failed');
        assert.equal(response.observationError, undefined, 'network locale response not observed');
        assert.equal(response.contentDigest, resource.digest, 'network response content digest mismatch');
        const timings = evidence.browser.performance.filter((entry) => entry.url === request.url);
        assert.equal(timings.length, 1, 'network resource timing missing or duplicated');
        const timing = timings[0];
        for (const key of ['decodedBodySize', 'encodedBodySize', 'transferSize'])
        {
            assert.ok(Number.isSafeInteger(timing[key]) && timing[key] >= 0, 'network byte observation missing');
        }
        assert.equal(timing.decodedBodySize, resource.size, 'network decoded artifact byte identity mismatch');
        assert.ok(timing.encodedBodySize <= resource.size, 'network encoded artifact byte budget exceeded');
        decodedBytes += timing.decodedBodySize;
        encodedBytes += timing.encodedBodySize;
        observed.push({ url: request.url, requestOrdinal: request.requestOrdinal, status: response.status,
            contentDigest: response.contentDigest, decodedBytes: timing.decodedBodySize,
            encodedBytes: timing.encodedBodySize, transferBytes: timing.transferSize,
            fromServiceWorker: response.fromServiceWorker });
    }
    assert.ok(observed.length <= budget.maximumRequests && decodedBytes <= budget.maximumDecodedBytes,
        'network locale resource budget exceeded');
    return {
        schema: 'fsusblog.public-shell-locale-network.v2', evidenceKind: 'diagnostic-probe', qualificationEligible: false,
        identity: bindings.identity, locale: scene.locale, route: scene.route,
        allowed: budget.resources.map(({ url, digest, size, identities }) => ({ url, digest, size, identities })),
        budget: { maximumRequests: budget.maximumRequests, maximumDecodedBytes: budget.maximumDecodedBytes },
        observed, requestCount: observed.length, decodedBytes, encodedBytes
    };
}
