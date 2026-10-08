import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Exercise published fixture bytes through the existing consumer owner.
import * as firstResponseOwner from '../browser-contract/public-shell-locale-first-response.mjs';
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

function selectorMarkup(selectedScene = scene)
{
    return selectedScene.selectorItems.map((item) =>
    {
        const label = item.englishName && item.englishName !== item.nativeName
            ? `${item.nativeName} ${item.englishName}` : item.nativeName;
        const selected = String(item.selected);
        return `<button data-locale-selector-item data-locale-code="${escapeHtml(item.code)}" `
            + `data-selected="${selected}" aria-checked="${selected}">${escapeHtml(label)}</button>`;
    }).join('');
}

async function buildResponse({
    caseScene = scene,
    caseCopy = copy,
    expected = defaultExpected,
    identity = expected.identity,
    language = caseScene.document.language,
    renderLocale = caseScene.locale,
    bootstrapOverrides = {},
    bootOverrides = {},
    bodyOverrides = {},
    headers = {}
} = {})
{
    const scene = caseScene;
    const copy = caseCopy;
    const authKey = scene.authActionContext === 'anonymous' ? 'login' : scene.authActionContext === 'admin' ? 'dashboard' : 'account';
    const codec = await loadPublicShellFirstResponseCodec();
    const bootstrap = codec.encodePublicAotPayload({
        renderLocale,
        kind: scene.route,
        localeCatalogDigest: expected.bootstrap.localeCatalogDigest,
        rendererVersion: expected.bootstrap.rendererVersion,
        renderTimestamp: expected.bootstrap.renderTimestamp,
        routeKey: expected.bootstrap.routeKey,
        ...bootstrapOverrides
    });
    const documentTitle = bodyOverrides.title ?? expected.metadata.title;
    const description = bodyOverrides.description ?? expected.metadata.description;
    const shellLocale = bodyOverrides.shellLocale ?? renderLocale;
    const activeLocale = bodyOverrides.activeLocale ?? renderLocale;
    const body = `<!doctype html><html lang="${escapeHtml(language)}" dir="${escapeHtml(scene.document.direction)}">`
        + `<head><title>${escapeHtml(documentTitle)}</title>`
        + `<meta name="description" content="${escapeHtml(description)}">`
        + `<meta property="og:title" content="${escapeHtml(documentTitle)}">`
        + `<meta property="og:description" content="${escapeHtml(description)}">`
        + `<meta property="og:locale" content="${escapeHtml(scene.document.openGraphLocale)}">`
        + `<link rel="canonical" href="${escapeHtml(expected.metadata.canonicalUrl)}"></head>`
        + `<body><div id="fsus-aot-shell" data-public-render-locale="${escapeHtml(shellLocale)}" `
        + `data-public-auth-message-key="public.shell.${authKey}">`
        + `<a data-public-nav="home">brand</a>`
        + `<a data-public-nav="home">${escapeHtml(copy['public.shell.home'])}</a>`
        + `<a data-public-nav="archive">${escapeHtml(copy['public.shell.archive'])}</a>`
        + `<a data-public-nav="about">${escapeHtml(copy['public.shell.about'])}</a>`
        + `<a data-public-nav="auth">${escapeHtml(copy[`public.shell.${authKey}`])}</a>`
        + `<a href="#main-content">${escapeHtml(copy['public.shell.skipToMain'])}</a>`
        + `<a href="/search" aria-controls="search">${escapeHtml(copy['public.shell.search'])}</a>`
        + `<div data-locale-selector data-active-locale="${escapeHtml(activeLocale)}">${selectorMarkup(scene)}</div>`
        + `</div><script id="fsus-aot-bootstrap" type="application/octet-stream">${bootstrap}</script>`
        + `<script id="fsus-public-boot-config" type="application/json">${JSON.stringify({
            schema: 'fsusblog.public-boot-config.v1',
            frontendBuildIdentity: expected.frontendBuildIdentity,
            ...bootOverrides
        })}</script></body></html>`;
    return {
        status: 200,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-language': language,
            'cache-control': expected.cacheControl,
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

// These are checker models, never admitted server/AOT or browser observations.
// Reuse canonical scenes and typed copy; keep auth/route coverage bounded.
for (const [index, descriptor] of matrix.locales.entries())
{
    const route = index % 2 === 0 ? 'Home' : 'ArticleDetail';
    const authActionContext = ['anonymous', 'authenticated', 'admin'][index % 3];
    const caseScene = matrix.scenes.find(item => item.issue === 2083 && item.stage === 'first-response'
        && item.locale === descriptor.code && item.route === route && item.authActionContext === authActionContext
        && item.negotiationId === `${descriptor.code}/exact` && item.viewport.width === 390);
    assert.ok(caseScene, 'catalog locale requires a canonical first-response model scene');
    test(`first navigation checker accepts typed ${descriptor.code}/${route}/${authActionContext} facts`, async () =>
    {
        const caseCopy = await resolvePublicShellLocaleCopy(matrix, caseScene.id);
        const expected = {
            ...defaultExpected,
            metadata: { ...defaultExpected.metadata,
                title: caseCopy['layout.siteHeader.fallbackTitle'],
                description: caseCopy['layout.siteHeader.fallbackDescription'] },
            bootstrap: { ...defaultExpected.bootstrap, routeKey: `model/${route}` }
        };
        const response = await buildResponse({ caseScene, caseCopy, expected });
        const evidence = await assertPublicShellLocaleFirstResponse({ response, scene: caseScene, copy: caseCopy, expected });
        assert.equal(evidence.observed.locale, descriptor.code);
        assert.equal(evidence.qualificationEligible, false);
    });
}

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
    ['OpenGraph locale', response =>
    {
        response.body = Buffer.from(response.body.toString().replace(
            `content="${scene.document.openGraphLocale}"`, 'content="wrong-locale"'));
    }],
    ['selector active', response =>
    {
        response.body = Buffer.from(response.body.toString().replace(
            `data-active-locale="${scene.locale}"`, 'data-active-locale="unsupported-locale"'));
    }],
    ['selector selected', response =>
    {
        response.body = Buffer.from(response.body.toString().replace('data-selected="true"', 'data-selected="false"'));
    }],
    ['selector order', response =>
    {
        response.body = Buffer.from(response.body.toString().replace(
            `data-locale-code="${scene.selectorItems[0].code}"`, 'data-locale-code="unsupported-locale"'));
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

test('first navigation rejects invalid UTF8 in original response bytes', async () =>
{
    const response = await buildResponse();
    // An invalid byte in non-copy markup must fail before DOMParser can replace it.
    response.body = Buffer.concat([response.body, Buffer.from([0xff])]);
    await assert.rejects(
        assertPublicShellLocaleFirstResponse({ response, scene, copy, expected: defaultExpected }),
        /first response UTF8 is invalid/u
    );
});

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

// Published-artifact Node models: independent fixture bytes, not a browser/Root qualification.
const publishedSceneModel = {
    issue: 2083, stage: 'first-response', route: 'Home', locale: 'zh-CN',
    document: { language: 'zh-CN', direction: 'ltr', openGraphLocale: 'zh_CN' }
};
const publishedOwnerModel = {
    namespace: 'published-node-model', runtimeRunId: 'published-model-run',
    sourceCommit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64),
    buildDigest: 'c'.repeat(64), runtimeScope: 'node-model-runtime'
};
const publishedRouteModel = { path: '/', routeKey: 'home' };
const originalDigest = bytes => createHash('sha256').update(bytes).digest('hex');

async function publishedModel()
{
    const seoOwner = await firstResponseOwner.loadPublicShellFirstResponseSeoHead();
    const codec = await firstResponseOwner.loadPublicShellFirstResponseCodec();
    const seoHead = {
        schema: 'fsusblog.public-seo-head', version: 1, digest: '',
        documentTitle: 'Published model title', description: 'Published model description',
        canonicalUrl: 'https://published.example.invalid/', publicOrigin: 'https://published.example.invalid',
        robots: 'index,follow', locale: 'zh-CN', pageType: 'Home',
        pageEntityId: 'https://published.example.invalid/',
        openGraph: { title: 'Published model title', description: 'Published model description',
            type: 'website', url: 'https://published.example.invalid/', locale: 'zh_CN', imageUrl: null },
        twitter: { card: 'summary_large_image', title: 'Published model title',
            description: 'Published model description', imageUrl: null },
        jsonLdGraph: JSON.stringify({ '@graph': [{ '@id': 'https://published.example.invalid/' }] }),
        articlePublishedAtUtc: null, articleModifiedAtUtc: null, articleAuthor: null, articleImageUrl: null
    };
    seoHead.digest = await seoOwner.computePublicSeoHeadDigest(seoHead);
    const bootstrap = {
        renderLocale: 'zh-CN', kind: 'Home', rendererVersion: 'published-model-renderer',
        localeCatalogDigest: 'published-model-catalog', routeKey: 'home',
        renderTimestamp: '2026-10-05T01:02:03.1234567Z'
    };
    const bootConfig = {
        schema: 'fsusblog.public-boot-config.v1', frontendBuildIdentity: 'published-model-release',
        entryUrl: '/assets/fsus-spa-entry.js', coreModulePreloads: ['/assets/core-model.js'], takeoverStylesheets: []
    };
    const publishedArtifact = {
        schema: 'fsusblog.public-content-published-artifact-observation.v1', owner: { ...publishedOwnerModel },
        route: { ...publishedRouteModel, locale: 'zh-CN', kind: 'Home', pageId: '1' },
        publication: { source: 'server-ssr', rendererVersion: bootstrap.rendererVersion,
            generatedAtUtc: '2026-10-05T01:02:03.1234567+00:00', contentType: 'text/html; charset=utf-8' },
        runtimeAssets: { frontendBuildIdentity: 'different-current-model-release' }, originals: []
    };
    function seal(html)
    {
        const bytes = Buffer.isBuffer(html) ? html : Buffer.from(html);
        publishedArtifact.originals = [{ role: 'published-artifact', encoding: 'base64',
            sha256: originalDigest(bytes), bytes: bytes.length, content: bytes.toString('base64') }];
    }
    function markup()
    {
        return '<!doctype html><html><head>'
            + `<script type="application/json" data-fsus-seo-head-model>${JSON.stringify(seoHead)}</script>`
            + '</head><body>'
            + `<script id="fsus-aot-bootstrap" type="application/octet-stream">${codec.encodePublicAotPayload(bootstrap)}</script>`
            + `<script id="fsus-public-boot-config" type="application/json">${JSON.stringify(bootConfig)}</script>`
            + '</body></html>';
    }
    seal(markup());
    return { publishedArtifact, seoHead, bootstrap, bootConfig, seoOwner, markup, seal,
        args: { publishedArtifact, scene: publishedSceneModel, expectedOwner: publishedOwnerModel, expectedRoute: publishedRouteModel } };
}

test('published-artifact Node getter exists independently of measured first response', () =>
{
    assert.equal(typeof firstResponseOwner.readPublicShellLocalePublishedArtifact, 'function');
});

test('published-artifact Node getter returns only production-validated published typed carriers', async () =>
{
    const model = await publishedModel();
    const result = await firstResponseOwner.readPublicShellLocalePublishedArtifact(model.args);
    assert.deepEqual(result, { seoHead: model.seoHead, bootstrap: model.bootstrap, bootConfig: model.bootConfig });
    assert.deepEqual(Object.keys(result).sort(), ['bootConfig', 'bootstrap', 'seoHead']);
    assert.notEqual(result.bootConfig.frontendBuildIdentity, model.publishedArtifact.runtimeAssets.frontendBuildIdentity);
    assert.equal(Object.hasOwn(result, 'currentRuntimeRelease'), false);
    assert.equal(Object.hasOwn(result, 'cacheControl'), false);
    assert.equal(Object.hasOwn(result, 'qualificationEligible'), false);
});

for (const [label, mutate] of [
    ['missing SEO', model => model.seal(model.markup().replace(/<script type="application\/json" data-fsus-seo-head-model>[^<]*<\/script>/u, ''))],
    ['duplicate SEO', model => model.seal(model.markup().replace('</head>', '<script type="application/json" data-fsus-seo-head-model>{}</script></head>'))],
    ['wrong SEO tag', model => model.seal(model.markup().replace('script type="application/json" data-fsus-seo-head-model', 'div type="application/json" data-fsus-seo-head-model'))],
    ['wrong SEO type', model => model.seal(model.markup().replace('type="application/json" data-fsus-seo-head-model', 'type="text/javascript" data-fsus-seo-head-model'))],
    ['missing bootstrap', model => model.seal(model.markup().replace(/<script id="fsus-aot-bootstrap"[^>]*>[^<]*<\/script>/u, ''))],
    ['duplicate bootstrap', model => model.seal(model.markup().replace('</body>', '<script id="fsus-aot-bootstrap" type="application/octet-stream">x</script></body>'))],
    ['wrong bootstrap type', model => model.seal(model.markup().replace('type="application/octet-stream"', 'type="application/json"'))],
    ['corrupt AEDS', model => model.seal(model.markup().replace(/(id="fsus-aot-bootstrap"[^>]*>)[^<]*/u, '$1bad-frame'))],
    ['missing config', model => model.seal(model.markup().replace(/<script id="fsus-public-boot-config"[^>]*>[^<]*<\/script>/u, ''))],
    ['duplicate config', model => model.seal(model.markup().replace('</body>', '<script id="fsus-public-boot-config" type="application/json">{}</script></body>'))],
    ['wrong config type', model => model.seal(model.markup().replace('id="fsus-public-boot-config" type="application/json"', 'id="fsus-public-boot-config" type="text/javascript"'))],
    ['malformed JSON', model => model.seal(model.markup().replace('data-fsus-seo-head-model>', 'data-fsus-seo-head-model>{'))],
    ['damaged UTF8', model => model.seal(Buffer.concat([Buffer.from(model.markup()), Buffer.from([0xc3, 0x28])]))],
    ['SEO digest drift', model =>
    {
        model.seoHead.documentTitle = 'not published';
        model.seal(model.markup());
    }],
    ['SEO schema', model =>
    {
        model.seoHead.version = 2;
        model.seal(model.markup());
    }],
    ['SEO locale', async model =>
    {
        model.seoHead.locale = 'en-US';
        model.seoHead.digest = await model.seoOwner.computePublicSeoHeadDigest(model.seoHead);
        model.seal(model.markup());
    }],
    ['SEO canonical route', async model =>
    {
        model.seoHead.canonicalUrl += 'other';
        model.seoHead.digest = await model.seoOwner.computePublicSeoHeadDigest(model.seoHead);
        model.seal(model.markup());
    }],
    ['SEO wrong optional type', model =>
    {
        model.seoHead.articleAuthor = {};
        model.seal(model.markup());
    }],
    ['bootstrap locale', model =>
    {
        model.bootstrap.renderLocale = 'en-US';
        model.seal(model.markup());
    }],
    ['bootstrap route', model =>
    {
        model.bootstrap.kind = 'About';
        model.seal(model.markup());
    }],
    ['bootstrap route key', model =>
    {
        model.bootstrap.routeKey = 'other';
        model.seal(model.markup());
    }],
    ['bootstrap renderer', model =>
    {
        model.bootstrap.rendererVersion = 'other';
        model.seal(model.markup());
    }],
    ['bootstrap publication time', model =>
    {
        model.bootstrap.renderTimestamp = '2026-10-05T01:02:03.1234568Z';
        model.seal(model.markup());
    }],
    ['config schema', model =>
    {
        model.bootConfig.schema = 'legacy';
        model.seal(model.markup());
    }],
    ['config release type', model =>
    {
        model.bootConfig.frontendBuildIdentity = {};
        model.seal(model.markup());
    }],
    ['config asset type', model =>
    {
        model.bootConfig.coreModulePreloads = {};
        model.seal(model.markup());
    }],
    ['config cross origin', model =>
    {
        model.bootConfig.entryUrl = 'https://foreign.example.invalid/entry.js';
        model.seal(model.markup());
    }],
    ['original role', model =>
    {
        model.publishedArtifact.originals[0].role = 'measured-response';
    }],
    ['original hash', model =>
    {
        model.publishedArtifact.originals[0].sha256 = '0'.repeat(64);
    }],
    ['original length', model =>
    {
        model.publishedArtifact.originals[0].bytes++;
    }],
    ['original base64', model =>
    {
        model.publishedArtifact.originals[0].content += '\n';
    }],
    ['duplicate originals', model =>
    {
        model.publishedArtifact.originals.push(model.publishedArtifact.originals[0]);
    }],
    ['publication source', model =>
    {
        model.publishedArtifact.publication.source = 'other';
    }],
    ['fixture route', model =>
    {
        model.publishedArtifact.route.path = '/other';
    }]
])
{
    test(`published-artifact Node getter rejects ${label}`, async () =>
    {
        const model = await publishedModel();
        await mutate(model);
        await assert.rejects(firstResponseOwner.readPublicShellLocalePublishedArtifact(model.args));
    });
}

for (const field of Object.keys(publishedOwnerModel))
{
    test(`published-artifact Node getter rejects expected owner drift: ${field}`, async () =>
    {
        const model = await publishedModel();
        model.publishedArtifact.owner[field] = 'wrong-owner';
        await assert.rejects(firstResponseOwner.readPublicShellLocalePublishedArtifact(model.args));
        model.args.expectedOwner = { ...publishedOwnerModel, [field]: '' };
        await assert.rejects(firstResponseOwner.readPublicShellLocalePublishedArtifact(model.args));
    });
}

test('published-artifact Node getter accepts the empty runtimeScope supported by the fixture owner', async () =>
{
    const model = await publishedModel();
    model.args.expectedOwner = { ...publishedOwnerModel, runtimeScope: '' };
    model.publishedArtifact.owner.runtimeScope = '';
    assert.deepEqual(await firstResponseOwner.readPublicShellLocalePublishedArtifact(model.args),
        { seoHead: model.seoHead, bootstrap: model.bootstrap, bootConfig: model.bootConfig });
});

for (const side of ['expected', 'observed', 'both'])
{
    test(`published-artifact Node getter rejects omitted runtimeScope: ${side}`, async () =>
    {
        const model = await publishedModel();
        model.args.expectedOwner = { ...publishedOwnerModel, runtimeScope: '' };
        model.publishedArtifact.owner.runtimeScope = '';
        if (side !== 'observed')
        {
            delete model.args.expectedOwner.runtimeScope;
        }
        if (side !== 'expected')
        {
            delete model.publishedArtifact.owner.runtimeScope;
        }
        await assert.rejects(firstResponseOwner.readPublicShellLocalePublishedArtifact(model.args));
    });
}

for (const [label, value] of [['undefined', undefined], ['null', null], ['number', 0], ['boolean', false], ['object', {}], ['array', []]])
{
    test(`published-artifact Node getter rejects equal nonstring runtimeScope: ${label}`, async () =>
    {
        const model = await publishedModel();
        model.args.expectedOwner = { ...publishedOwnerModel, runtimeScope: value };
        model.publishedArtifact.owner.runtimeScope = value;
        await assert.rejects(firstResponseOwner.readPublicShellLocalePublishedArtifact(model.args));
    });
}

for (const [expected, observed] of [['', 'nonempty-scope'], ['nonempty-scope', '']])
{
    test(`published-artifact Node getter rejects runtimeScope empty/nonempty drift: ${expected === '' ? 'expected' : 'observed'} empty`, async () =>
    {
        const model = await publishedModel();
        model.args.expectedOwner = { ...publishedOwnerModel, runtimeScope: expected };
        model.publishedArtifact.owner.runtimeScope = observed;
        await assert.rejects(firstResponseOwner.readPublicShellLocalePublishedArtifact(model.args));
    });
}


test('diagnostic receipt keeps resolver Source and MatchedRange separate from HTML observations', async () =>
{
    const response = await buildResponse();
    const missing = await assertPublicShellLocaleFirstResponse({ response, scene, copy, expected: defaultExpected });
    assert.equal(missing.observed.resolution, null);
    assert.equal(missing.observed.resolutionCaptureState, 'not-captured');
    const resolverResult = { locale: { code: scene.locale }, source: scene.expectedResolution.source,
        matchedRange: scene.expectedResolution.matchedRange, catalogDigest: defaultExpected.bootstrap.localeCatalogDigest };
    const supplied = await assertPublicShellLocaleFirstResponse({ response, scene, copy, expected: defaultExpected, resolverResult });
    assert.deepEqual(supplied.observed.resolution, { locale: scene.locale, source: resolverResult.source,
        matchedRange: resolverResult.matchedRange, catalogDigest: resolverResult.catalogDigest });
    assert.equal(supplied.observed.resolutionCaptureState, 'caller-supplied-diagnostic');
    assert.equal(supplied.qualificationEligible, false);
    for (const [key, value] of [['source', 'Default'], ['matchedRange', 'forged'], ['catalogDigest', 'stale']])
    {
        await assert.rejects(assertPublicShellLocaleFirstResponse({ response, scene, copy, expected: defaultExpected,
            resolverResult: { ...resolverResult, [key]: value } }), /resolver .*mismatch/u);
    }
});
