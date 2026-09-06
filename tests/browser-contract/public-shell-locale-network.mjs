import assert from 'node:assert/strict';

const unrelatedDomains = Object.freeze(['admin', 'identity', 'messages']);

function exactKeys(value, allowed, label)
{
    assert.deepEqual(Object.keys(value ?? {}).sort(), [...allowed].sort(), `network ${label} has an unregistered field`);
}

function localeFromUrl(url, locales)
{
    return locales.find((code) => url.includes(`/${code}/`) || url.includes(`${code}.`) || url.includes(`locale=${code}`))
        ?? null;
}

function domainFromUrl(url, domains)
{
    return domains.find((domain) => url.includes(`/${domain}/`) || url.includes(`domain=${domain}`)) ?? null;
}

function fontFromUrl(url, fonts)
{
    return fonts.find((font) => url.includes(font.assetFile) || font.faceIds.some((face) => url.includes(face.split(':')[0])))
        ?? null;
}

/** Compare an interactive-ready request log to the matrix domain/font contract. Cache and preload count. */
export function assertPublicShellLocaleNetwork({ scene, matrix, requests, consoleIssues = [] })
{
    assert.ok(scene.issue === 2085 && scene.stage === 'initial-network', 'network requires its matrix scene');
    assert.equal(scene.networkPolicy.includeCacheAndPreload, true, 'network policy must count cache and preload');
    assert.ok(Array.isArray(requests) && requests.length > 0, 'network request log is missing');
    const locales = matrix.locales.map((item) => item.code);
    const otherLocales = locales.filter((code) => code !== scene.locale);
    const fonts = matrix.fontPlan.entries;
    const requiredFont = scene.requiredFont;
    const requiredDomains = new Set(scene.requiredDomains);
    const observedDomains = new Set();
    const observedFonts = new Set();
    const localeBundleIdentities = new Set();
    const businessIdentities = new Map();
    for (const request of requests)
    {
        exactKeys(request, [
            'url', 'resourceType', 'initiator', 'status', 'fromCache', 'preload', 'contentDigest'
        ], 'request');
        assert.equal(typeof request.url, 'string', 'request url missing');
        assert.match(request.contentDigest, /^(?:sha256:)?[a-f0-9]{64}$/u, 'request content digest missing');
        assert.equal(typeof request.fromCache, 'boolean', 'request cache flag missing');
        assert.equal(typeof request.preload, 'boolean', 'request preload flag missing');
        assert.notEqual(request.initiator, 'networkidle', 'networkidle cannot prove the waterfall');
        assert.notEqual(request.initiator, 'fixed-sleep', 'fixed sleep cannot prove the waterfall');
        assert.ok(request.status < 400, 'network failed required resource');
        const locale = localeFromUrl(request.url, locales);
        if (locale && otherLocales.includes(locale))
        {
            assert.fail('network loaded another locale bundle');
        }
        if (locale === scene.locale)
        {
            const identity = `${locale}:${request.contentDigest}`;
            assert.equal(localeBundleIdentities.has(identity) && request.preload, false,
                'network duplicate eager locale identity');
            localeBundleIdentities.add(identity);
        }
        const domain = domainFromUrl(request.url, [...requiredDomains, ...unrelatedDomains]);
        if (unrelatedDomains.includes(domain) && !requiredDomains.has(domain))
        {
            assert.fail(`network loaded unrelated domain ${domain}`);
        }
        if (domain && requiredDomains.has(domain))
        {
            observedDomains.add(domain);
        }
        const font = fontFromUrl(request.url, fonts);
        if (font)
        {
            assert.equal(font.script, requiredFont.script, 'network font script mismatch');
            assert.equal(font.assetFile, requiredFont.assetFile, 'network font asset mismatch');
            observedFonts.add(font.assetFile);
        }
        const classified = request.resourceType === 'document'
            || locale !== null
            || domain !== null
            || font !== null
            || request.url.includes('/api/');
        assert.equal(classified, true, 'network unknown request');
        if (['xhr', 'fetch'].includes(request.resourceType) && request.url.includes('/api/'))
        {
            const count = (businessIdentities.get(request.url) ?? 0) + 1;
            businessIdentities.set(request.url, count);
            assert.ok(count <= 1 + scene.networkPolicy.businessDataReRequests, 'network route or article data re-request');
        }
    }
    for (const domain of scene.requiredDomains)
    {
        assert.ok(observedDomains.has(domain), `network missing required domain ${domain}`);
    }
    assert.ok(observedFonts.has(requiredFont.assetFile), 'network missing required font');
    assert.ok(Array.isArray(consoleIssues) && consoleIssues.length === 0, 'network console errors cannot be filtered');
    return {
        schema: 'fsusblog.public-shell-locale-network.v1',
        evidenceKind: 'diagnostic-probe',
        qualificationEligible: false,
        observed: {
            locale: scene.locale,
            domains: [...observedDomains].sort(),
            fonts: [...observedFonts].sort(),
            requestCount: requests.length,
            includeCacheAndPreload: true
        }
    };
}
