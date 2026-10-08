import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const { assertPublicShellLocaleNetwork, derivePublicShellLocaleNetworkBudget } = await import(new URL('../browser-contract/public-shell-locale-network.mjs', import.meta.url));
const { createPublicShellLocaleMatrix } = await import(new URL('../browser-contract/public-shell-locale-matrix.mjs', import.meta.url));

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

// Node model only. Opaque URLs deliberately cannot carry locale/domain/font substring hints.
function fixture()
{
    const identities = [
        { kind: 'domain', locale: 'ja-JP', domain: 'public' },
        { kind: 'font-style', locale: 'ja-JP', script: 'Jpan' },
        { kind: 'font', locale: 'ja-JP', script: 'Jpan', weight: 400 }
    ];
    const resources = identities.map((identity, index) => ({ url: `http://127.0.0.1/assets/${index}`,
        identities: [identity], digest: digest(String(index)), size: 128 + index }));
    const identity = { sourceState: { commit: 'model-only' }, buildDigest: digest('build'), matrixDigest: digest('matrix') };
    return { bindings: { identity, resources },
        scene: { stage: 'initial-network', locale: 'ja-JP', route: 'Home', requiredDomains: ['public'], requiredFont: { script: 'Jpan' } },
        evidence: { identity, requests: resources.map((resource, requestOrdinal) => ({ url: resource.url, method: 'GET', requestOrdinal })),
            responses: resources.map((resource, requestOrdinal) => ({ url: resource.url, requestOrdinal,
                resource: structuredClone(resource), status: 200, fromServiceWorker: false, contentDigest: resource.digest })),
            browser: { performance: resources.map((resource) => ({ url: resource.url, transferSize: resource.size + 200,
                encodedBodySize: resource.size, decodedBodySize: resource.size })) } } };
}

test('manifest resource identities and byte sizes derive a bounded opaque-URL budget', () =>
{
    const input = fixture();
    const budget = derivePublicShellLocaleNetworkBudget(input);
    assert.equal(budget.maximumRequests, 3);
    assert.equal(budget.maximumDecodedBytes, 387);
    const receipt = assertPublicShellLocaleNetwork(input);
    assert.equal(receipt.requestCount, 3);
    assert.equal(receipt.decodedBytes, 387);
    assert.equal(receipt.qualificationEligible, false);
    assert.deepEqual(receipt.allowed.map((item) => item.url), input.bindings.resources.map((item) => item.url));
});

for (const cache of ['cold', 'warm', 'service-worker'])
{
    test(`${cache} observations preserve byte and response identities (Node model only)`, () =>
    {
        const input = fixture();
        if (cache !== 'cold')
        {
            input.evidence.browser.performance.forEach((entry) =>
            {
                entry.transferSize = 0;
            });
        }
        input.evidence.responses.forEach((response) =>
        {
            response.fromServiceWorker = cache === 'service-worker';
        });
        assert.equal(assertPublicShellLocaleNetwork(input).decodedBytes, 387);
        input.evidence.responses[0].contentDigest = digest('tampered cached body');
        assert.throws(() => assertPublicShellLocaleNetwork(input), /digest/u);
    });
}

for (const [name, mutate] of [
    ['other locale', (input) =>
    {
        input.bindings.resources[0].identities[0].locale = 'ru-RU';
    }],
    ['unrelated domain', (input) =>
    {
        input.bindings.resources[0].identities[0].domain = 'admin';
    }],
    ['another script', (input) =>
    {
        input.bindings.resources[2].identities[0].script = 'Hans';
    }],
    ['duplicate domain', (input) =>
    {
        input.evidence.requests.push(structuredClone(input.evidence.requests[0]));
    }],
    ['duplicate font', (input) =>
    {
        input.evidence.requests.push(structuredClone(input.evidence.requests[2]));
    }],
    ['unknown response identity', (input) =>
    {
        input.evidence.responses[0].url += '/extra';
    }],
    ['resealed response manifest', (input) =>
    {
        input.evidence.responses[0].resource.size += 1;
    }],
    ['wrong response digest', (input) =>
    {
        input.evidence.responses[1].contentDigest = digest('extra CSS');
    }],
    ['missing byte authority', (input) =>
    {
        delete input.bindings.resources[0].size;
    }],
    ['missing response', (input) =>
    {
        input.evidence.responses.shift();
    }],
    ['duplicate response', (input) =>
    {
        input.evidence.responses.push(structuredClone(input.evidence.responses[0]));
    }],
    ['missing timing', (input) =>
    {
        input.evidence.browser.performance.shift();
    }],
    ['duplicate timing', (input) =>
    {
        input.evidence.browser.performance.push(structuredClone(input.evidence.browser.performance[0]));
    }],
    ['byte overflow', (input) =>
    {
        input.evidence.browser.performance[0].decodedBodySize += 1;
    }],
    ['encoded overflow', (input) =>
    {
        input.evidence.browser.performance[0].encodedBodySize += 1;
    }],
    ['cache hides bytes', (input) =>
    {
        input.evidence.browser.performance[0].decodedBodySize = 0;
    }],
    ['invalid byte count', (input) =>
    {
        input.evidence.browser.performance[0].encodedBodySize = -1;
    }],
    ['wrong build identity', (input) =>
    {
        input.evidence.identity = { buildDigest: digest('other build') };
    }],
    ['failed CSS', (input) =>
    {
        input.evidence.responses[1].status = 404;
    }]
])
{
    test(`manifest budget rejects ${name} (Node negative control)`, () =>
    {
        const input = fixture();
        mutate(input);
        assert.throws(() => assertPublicShellLocaleNetwork(input), /network/u);
    });
}

test('current Home/deep locale plans satisfy the PublicShell unrelated-domain prohibition', async () =>
{
    const matrix = await createPublicShellLocaleMatrix();
    const violations = [];
    for (const locale of matrix.locales)
    {
        for (const route of ['Home', 'ArticleDetail'])
        {
            const scene = matrix.scenes.find((item) => item.issue === 2085 && item.stage === 'initial-network'
                && item.locale === locale.code && item.route === route);
            if (scene.requiredDomains.some((domain) => ['admin', 'security', 'identity', 'messages'].includes(domain)))
            {
                violations.push(`${locale.code}/${route}: ${scene.requiredDomains.join(',')}`);
            }
        }
    }
    assert.deepEqual(violations, [], 'current route-domain boundary violates #2581');
});
