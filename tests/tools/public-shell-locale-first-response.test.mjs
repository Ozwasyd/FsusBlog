import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertPublicShellLocaleFirstResponse,
    loadPublicShellFirstResponseCodec
// eslint-disable-next-line import-x/no-relative-parent-imports -- Exercise the canonical first-navigation response contract.
} from '../browser-contract/public-shell-locale-first-response.mjs';
import {
    createPublicShellLocaleMatrix,
    resolvePublicShellLocaleCopy
// eslint-disable-next-line import-x/no-relative-parent-imports -- Reuse the current catalog and typed-copy authority.
} from '../browser-contract/public-shell-locale-matrix.mjs';

const matrix = await createPublicShellLocaleMatrix();
const scene = matrix.scenes.find((item) => item.issue === 2083
    && item.stage === 'first-response'
    && item.route === 'Home'
    && item.authActionContext === 'anonymous'
    && item.viewport.width === 390);
assert.ok(scene, 'first-response Home scene is missing from the current matrix');
const copy = await resolvePublicShellLocaleCopy(matrix, scene.id);

function escapeHtml(value)
{
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function selectorMarkup()
{
    return scene.selectorItems.map((item) =>
    {
        const label = item.englishName && item.englishName !== item.nativeName
            ? `${item.nativeName} ${item.englishName}` : item.nativeName;
        const selected = String(item.selected);
        return `<button data-locale-selector-item data-locale-code="${escapeHtml(item.code)}" `
            + `data-selected="${selected}" aria-checked="${selected}">${escapeHtml(label)}</button>`;
    }).join('');
}

async function buildResponse({
    identity = defaultExpected.identity,
    language = scene.document.language,
    renderLocale = scene.locale,
    bootstrapOverrides = {},
    bootOverrides = {},
    bodyOverrides = {},
    headers = {}
} = {})
{
    const codec = await loadPublicShellFirstResponseCodec();
    const bootstrap = codec.encodePublicAotPayload({
        renderLocale,
        kind: scene.route,
        localeCatalogDigest: defaultExpected.bootstrap.localeCatalogDigest,
        rendererVersion: defaultExpected.bootstrap.rendererVersion,
        renderTimestamp: defaultExpected.bootstrap.renderTimestamp,
        routeKey: defaultExpected.bootstrap.routeKey,
        ...bootstrapOverrides
    });
    const documentTitle = bodyOverrides.title ?? defaultExpected.metadata.title;
    const description = bodyOverrides.description ?? defaultExpected.metadata.description;
    const shellLocale = bodyOverrides.shellLocale ?? renderLocale;
    const activeLocale = bodyOverrides.activeLocale ?? renderLocale;
    const body = `<!doctype html><html lang="${escapeHtml(language)}" dir="${escapeHtml(scene.document.direction)}">`
        + `<head><title>${escapeHtml(documentTitle)}</title>`
        + `<meta name="description" content="${escapeHtml(description)}">`
        + `<meta property="og:title" content="${escapeHtml(documentTitle)}">`
        + `<meta property="og:description" content="${escapeHtml(description)}">`
        + `<meta property="og:locale" content="${escapeHtml(scene.document.openGraphLocale)}">`
        + `<link rel="canonical" href="${escapeHtml(defaultExpected.metadata.canonicalUrl)}"></head>`
        + `<body><div id="fsus-aot-shell" data-public-render-locale="${escapeHtml(shellLocale)}" `
        + `data-public-auth-message-key="public.shell.login">`
        + `<a data-public-nav="home">brand</a>`
        + `<a data-public-nav="home">${escapeHtml(copy['public.shell.home'])}</a>`
        + `<a data-public-nav="archive">${escapeHtml(copy['public.shell.archive'])}</a>`
        + `<a data-public-nav="about">${escapeHtml(copy['public.shell.about'])}</a>`
        + `<a data-public-nav="auth">${escapeHtml(copy['public.shell.login'])}</a>`
        + `<a href="#main-content">${escapeHtml(copy['public.shell.skipToMain'])}</a>`
        + `<a href="/search" aria-controls="search">${escapeHtml(copy['public.shell.search'])}</a>`
        + `<div data-locale-selector data-active-locale="${escapeHtml(activeLocale)}">${selectorMarkup()}</div>`
        + `</div><script id="fsus-aot-bootstrap" type="application/octet-stream">${bootstrap}</script>`
        + `<script id="fsus-public-boot-config" type="application/json">${JSON.stringify({
            schema: 'fsusblog.public-boot-config.v1',
            frontendBuildIdentity: defaultExpected.frontendBuildIdentity,
            ...bootOverrides
        })}</script></body></html>`;
    return {
        status: 200,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-language': language,
            'cache-control': defaultExpected.cacheControl,
            ...headers
        },
        body: Buffer.from(body),
        identity
    };
}

const defaultExpected = {
    identity: {
        sourceCommit: matrix.identity.sourceCommit,
        worktreeFingerprint: matrix.identity.worktreeFingerprint,
        matrixDigest: matrix.contentDigest,
        buildDigest: 'sha256:build-receipt-digest',
        runtimeId: 'browser-contract-runtime',
        namespace: 'browser-contract-test'
    },
    cacheControl: 'no-store, no-cache',
    metadata: {
        title: copy['layout.siteHeader.fallbackTitle'],
        description: copy['layout.siteHeader.fallbackDescription'],
        canonicalUrl: 'https://example.invalid/'
    },
    frontendBuildIdentity: 'release-test-build',
    bootstrap: {
        localeCatalogDigest: 'catalog-test-digest',
        rendererVersion: 'renderer-test-version',
        renderTimestamp: '2026-09-05T00:00:00.000Z',
        routeKey: 'home'
    }
};

test('first navigation checks immutable HTML, typed copy, security domain selector and AEDS identity', async () =>
{
    const response = await buildResponse();
    const evidence = await assertPublicShellLocaleFirstResponse({ response, scene, copy, expected: defaultExpected });
    assert.equal(evidence.schema, 'fsusblog.public-shell-locale-first-response.v1');
    assert.equal(evidence.evidenceKind, 'diagnostic-probe');
    assert.equal(evidence.qualificationEligible, false);
    assert.equal(evidence.response.contentLanguage, scene.document.language);
    assert.equal(evidence.observed.locale, scene.locale);
    assert.equal(evidence.response.bodyBytes, response.body.length);
    assert.equal(JSON.stringify(evidence).includes(copy['public.shell.archive']), false);
    assert.equal(JSON.stringify(evidence).includes(response.body.toString('utf8')), false);
});

for (const [label, mutate] of [
    ['status', (response) =>
    {
        response.status = 503;
    }],
    ['content type', (response) =>
    {
        response.headers['content-type'] = 'application/json';
    }],
    ['content language', (response) =>
    {
        response.headers['content-language'] = 'en-US';
    }],
    ['HTML lang', (response) =>
    {
        response.body = Buffer.from(response.body.toString().replace('lang="zh-CN"', 'lang="en-US"'));
    }],
    ['render locale', (response) =>
    {
        response.body = Buffer.from(response.body);
    }],
    ['frontend build identity', (response) =>
    {
        response.body = Buffer.from(response.body.toString().replace('release-test-build', 'stale-build'));
    }],
    ['typed copy', (response) =>
    {
        response.body = Buffer.from(response.body.toString().replace(copy['public.shell.archive'], 'wrong-copy'));
    }]
])
{
    test(`first navigation rejects ${label} drift`, async () =>
    {
        const response = await buildResponse();
        if (label === 'render locale')
        {
            const codec = await loadPublicShellFirstResponseCodec();
            const replacement = codec.encodePublicAotPayload({
                renderLocale: 'en-US',
                kind: scene.route,
                localeCatalogDigest: defaultExpected.bootstrap.localeCatalogDigest,
                rendererVersion: defaultExpected.bootstrap.rendererVersion,
                renderTimestamp: defaultExpected.bootstrap.renderTimestamp,
                routeKey: defaultExpected.bootstrap.routeKey
            });
            response.body = Buffer.from(response.body.toString().replace(/(<script id="fsus-aot-bootstrap"[^>]*>)[^<]+/u, `$1${replacement}`));
        }
        mutate(response);
        await assert.rejects(
            assertPublicShellLocaleFirstResponse({ response, scene, copy, expected: defaultExpected }),
            /first response/u
        );
    });
}

test('first navigation rejects identity and cache/build receipt drift before parsing copy', async () =>
{
    const response = await buildResponse({
        identity: { ...defaultExpected.identity, buildDigest: 'sha256:stale-build-receipt' },
        headers: { 'cache-control': 'public, max-age=60' }
    });
    await assert.rejects(
        assertPublicShellLocaleFirstResponse({ response, scene, copy, expected: defaultExpected }),
        /first response (?:buildDigest|cache policy) mismatch/u
    );
});
