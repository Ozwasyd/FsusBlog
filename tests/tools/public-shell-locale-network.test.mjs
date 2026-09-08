import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { assertPublicShellLocaleNetwork } from '../browser-contract/public-shell-locale-network.mjs';
import { createPublicShellLocaleMatrix } from '../browser-contract/public-shell-locale-matrix.mjs';

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const matrix = await createPublicShellLocaleMatrix();
const scene = matrix.scenes.find((item) => item.issue === 2085
    && item.stage === 'initial-network'
    && item.route === 'Home'
    && item.authActionContext === 'anonymous'
    && item.viewport.width === 1440
    && item.locale === 'ja-JP')
    ?? matrix.scenes.find((item) => item.issue === 2085 && item.stage === 'initial-network' && item.route === 'Home');
assert.ok(scene, 'initial-network Home scene is missing');
const hant = matrix.scenes.find((item) => item.issue === 2085
    && item.requiredFont.script === 'Hant'
    && item.stage === 'initial-network'
    && item.route === 'Home');
assert.ok(hant, 'zh-Hant network scene is missing');

function request(url, extras = {})
{
    return {
        url,
        resourceType: extras.resourceType ?? 'script',
        initiator: extras.initiator ?? 'parser',
        status: extras.status ?? 200,
        fromCache: extras.fromCache ?? false,
        preload: extras.preload ?? false,
        contentDigest: extras.contentDigest ?? digest(url)
    };
}

function required(target)
{
    return [
        request(`https://example.invalid/${target.locale}/public/shell.js`),
        ...target.requiredDomains.map((domain) => request(`https://example.invalid/${target.locale}/${domain}/messages.js`)),
        request(`https://example.invalid/assets/fonts/${target.requiredFont.assetFile}`, { resourceType: 'font' }),
        request('https://example.invalid/', { resourceType: 'document' })
    ];
}

test('initial network accepts the exact locale domain and font set, including cache and preload', () =>
{
    const requests = required(scene).map((item, index) => (index === 0 ? { ...item, fromCache: true, preload: true } : item));
    const evidence = assertPublicShellLocaleNetwork({ scene, matrix, requests });
    assert.equal(evidence.schema, 'fsusblog.public-shell-locale-network.v1');
    assert.equal(evidence.observed.includeCacheAndPreload, true);
    assert.ok(evidence.observed.fonts.includes(scene.requiredFont.assetFile));
});

for (const [label, mutate] of [
    ['other locale bundle', (items) => [...items, request(`https://example.invalid/pt-BR/admin/messages.js`)]],
    ['cross locale domain', (items) => [...items, request(`https://example.invalid/zh-CN/public/messages.js`)]],
    ['unrelated admin domain', (items) => [...items, request(`https://example.invalid/${scene.locale}/admin/messages.js`)]],
    ['missing required font', (items) => items.filter((item) => !item.url.includes(scene.requiredFont.assetFile))],
    ['duplicate eager locale', (items) => [...items, { ...items[0], preload: true }]],
    ['unknown preload', (items) => [...items, request('https://example.invalid/unexpected-preload.js', { preload: true })]],
    ['failed resource', (items) => items.map((item, index) => (index === 0 ? { ...item, status: 404 } : item))],
    ['networkidle initiator', (items) => items.map((item, index) => (index === 0 ? { ...item, initiator: 'networkidle' } : item))],
    ['route data duplicate', (items) => [
        ...items,
        request('https://example.invalid/api/article', { resourceType: 'fetch' }),
        request('https://example.invalid/api/article', { resourceType: 'fetch' })
    ]]
])
{
    test(`initial network rejects ${label}`, () =>
    {
        assert.throws(
            () => assertPublicShellLocaleNetwork({ scene, matrix, requests: mutate(required(scene)) }),
            /network/u
        );
    });
}

test('zh-Hant cannot load the SC font face', () =>
{
    const hans = matrix.fontPlan.entries.find((item) => item.script === 'Hans');
    assert.throws(
        () => assertPublicShellLocaleNetwork({
            scene: hant,
            matrix,
            requests: [
                ...required(hant).filter((item) => !item.url.includes(hant.requiredFont.assetFile)),
                request(`https://example.invalid/assets/fonts/${hans.assetFile}`, { resourceType: 'font' })
            ]
        }),
        /font/u
    );
});

test('same request count with a different resource identity still fails', () =>
{
    const items = required(scene);
    items[1] = request('https://example.invalid/other-identity.js');
    assert.equal(items.length, required(scene).length);
    assert.throws(
        () => assertPublicShellLocaleNetwork({ scene, matrix, requests: items }),
        /network/u
    );
});
