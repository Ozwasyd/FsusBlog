import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    markdownForCorpusCase,
    persistenceSafeMarkdownForCorpusCase,
    resolveProductionFeatureGatewayAsset
} from '../../support/security/productionXssCorpus.mjs';
import {
    auditSerializedElementTree,
    evaluateSecurityObservation,
    isSecurityRelevantConsoleMessage,
    productionXssKillControls,
    recordMainFrameNavigation
} from '../../support/security/productionXssObserver.mjs';

for (const control of productionXssKillControls)
{
    test(`production XSS observer rejects ${control.id}`, () =>
    {
        assert.notDeepEqual(evaluateSecurityObservation(control.observation), []);
    });
}

test('production XSS observer rejects unexpected same-origin navigation', () =>
{
    assert.notDeepEqual(evaluateSecurityObservation({
        unexpectedNavigations: ['http://127.0.0.1/admin']
    }), []);
});

test('production XSS navigation observer ignores duplicate events for one allowed URL', () =>
{
    const observation = {
        allowedNavigations: new Map([['http://127.0.0.1/article/4', 1]]),
        unexpectedNavigations: []
    };

    recordMainFrameNavigation(observation, 'http://127.0.0.1/article/4');
    recordMainFrameNavigation(observation, 'http://127.0.0.1/article/4');
    recordMainFrameNavigation(observation, 'http://127.0.0.1/admin');

    assert.deepEqual(observation.unexpectedNavigations, ['http://127.0.0.1/admin']);
});

test('production XSS DOM audit rejects event handlers, dangerous URLs and namespaces', () =>
{
    const failures = auditSerializedElementTree([{
        namespace: 'http://www.w3.org/2000/svg',
        attributes: { onload: 'attack()', href: 'javascript:attack()' }
    }], { allowedNamespaces: ['http://www.w3.org/1999/xhtml'], forbidExternalUrls: true });
    assert.deepEqual(failures.sort(), [
        'dangerous-url:href',
        'event-attribute:onload',
        'namespace:http://www.w3.org/2000/svg'
    ]);
});

test('production XSS observer accepts a clean observation', () =>
{
    assert.deepEqual(evaluateSecurityObservation({ executionSentinel: 0 }), []);
});

test('production XSS console observer keeps execution directives and ignores style-only noise', () =>
{
    assert.equal(isSecurityRelevantConsoleMessage(
        "Refused to execute inline script because it violates the following Content Security Policy directive: \"script-src 'self'\"."
    ), true);
    assert.equal(isSecurityRelevantConsoleMessage(
        "This document requires 'TrustedHTML' assignment because of require-trusted-types-for 'script'."
    ), true);
    assert.equal(isSecurityRelevantConsoleMessage(
        "Applying inline style violates the following Content Security Policy directive 'style-src-attr 'none''."
    ), false);
});

test('production XSS corpus keeps feature output at the feature gateway boundary', () =>
{
    assert.equal(markdownForCorpusCase({ source: '<attack>' }), '<attack>');
    assert.equal(markdownForCorpusCase({
        featureOutput: { kind: 'mermaid', payload: '<svg>retained</svg>' }
    }), '<svg>retained</svg>');
    assert.equal(
        persistenceSafeMarkdownForCorpusCase({ source: 'java\0script:retained' }),
        'java\uFFFDscript:retained'
    );
    assert.equal(resolveProductionFeatureGatewayAsset({
        '../../../FsusUI/vue/packages/wasm/markdown-feature-output-gateway.ts': {
            file: 'assets/markdown-feature-output-gateway-AbC_123.js',
            isDynamicEntry: true
        }
    }), '/assets/markdown-feature-output-gateway-AbC_123.js');
});

test('production XSS browser pages bind to the fixture business clock', async () =>
{
    const source = await readFile(
        new URL('./run-production-xss-matrix.mjs', import.meta.url),
        'utf8'
    );
    assert.match(
        source,
        /providerState\.runtime\?\.temporalObservation\?\.businessEpochUtc/u
    );
    assert.match(
        source,
        /await page\.clock\.setFixedTime\(new Date\(browserBusinessEpochUtc\)\)/u
    );
    assert.match(source, /__FSUSBLOG_XSS_TELEMETRY__/u);
    assert.match(source, /FullApp Router did not reach \$\{target\} before \$\{spaNavigationTimeoutMs\}ms/u);
    assert.match(source, /performance\.getEntriesByType\('resource'\)\.slice\(-32\)/u);
    assert.match(
        source,
        /for \(let retry = 1; cleanup\.status !== 'success'[\s\S]*?setTimeout\(resolve, 1_000 \* retry\)[\s\S]*?production-xss-cleanup-retry-\$\{retry\}/u
    );
    assert.match(source, /const seededPublicRouteReadiness = new Map\(\)/u);
    assert.match(source, /seededPublicRouteReadiness\.get\(route\)/u);
    assert.match(source, /seededPublicRouteReadiness\.set\(route, readiness\)/u);
    assert.match(source, /await waitForSeededPublicRoute\(entry\.id, articleRoute\)/u);
    assert.match(source, /const productionLocale = 'zh-CN'/u);
    assert.match(source, /'Accept-Language': productionLocale/u);
    assert.match(source, /locale: productionLocale/u);
    assert.match(source, /mode === 'release' \? 180_000 : 60_000/u);
    assert.match(source, /request\.setTimeout\(7 \* 60_000/u);
    assert.match(source, /responseBytes > 1024 \* 1024/u);
    assert.match(source, /const previewArticle = previewPage\.locator\('\.author-preview'\)/u);
    assert.match(source, /await previewArticle\.count\(\) > 0/u);
    assert.match(source, /sourceIdentity !== previousIdentity/u);
    assert.match(
        source,
        /article\?\.getAttribute\('data-preview-render-complete'\) === sourceIdentity/u
    );
    assert.doesNotMatch(source, /NS_ERROR_NET_EMPTY_RESPONSE/u);
    assert.doesNotMatch(source, /transportRecoveries/u);
    assert.match(source, /!root\.matches\(selector\) && !root\.querySelector\(selector\)/u);
    assert.match(source, /const observation = \(\) => observationRef\.current \?\? observationRef/u);
    assert.match(source, /noScriptObservationRef\.current = createObservation\(\)/u);
    assert.match(source, /observationRef\.current = createObservation\(\)/u);
    assert.match(source, /representativeCategoryCases\(cases\)/u);
    assert.match(source, /entry\.id === 'mxss-resource-code-fence'/u);
    assert.match(source, /entry\.id === 'mxss-url-safe-relative-control'/u);
    assert.match(source, /const surfaceCaseIds = new Set\(surfaceCases\.map\(\(entry\) => entry\.id\)\)/u);
    assert.match(source, /if \(surfaceCaseIds\.has\(entry\.id\)\) \{/u);
    assert.match(source, /aboutAggregateCase\(aboutCases\)/u);
    assert.match(source, /navigatePublicAot\(aboutPage, `\$\{baseUrl\}\/about`/u);
    assert.match(source, /const aboutReadinessText = aboutCase\.preserve\.text\.at\(-1\)/u);
    assert.doesNotMatch(
        source,
        /for \(const entry of cases\) \{\s*await audit\(aboutPage/u
    );
    assert.match(
        source,
        /#fsus-comments-island\[data-article-id="\$\{articleId\}"\][\s\S]*?state: 'attached'/u
    );
    assert.match(source, /#fsus-aot-shell a\[data-public-nav\]/u);
    assert.match(source, /spaNavProbe\.click\(\)/u);
    assert.match(source, /globalProperties\.\$router/u);
    assert.match(source, /await waitForFullAppRouterReady\(spaPage, '\/login'\)/u);
    assert.match(source, /router\.currentRoute\.value\.matched\.length > 0/u);
    assert.match(source, /void router\.push\(nextTarget\)\.then/u);
    assert.match(source, /typeof globalThis\.__FSUSBLOG_XSS_SPA_NAVIGATION_ERROR__ === 'string'/u);
    assert.match(source, /\{ timeout: spaNavigationTimeoutMs \}/u);
    assert.doesNotMatch(source, /page\.evaluate\(async \(nextTarget\)/u);
    assert.doesNotMatch(source, /Promise\.all\(\[noScriptPhase, hydratedPhase\]\)/u);
    assert.match(
        source,
        /phase: 'aot-before-hydration'[\s\S]*?await navigatePublicAot\(\s*noScriptPage[\s\S]*?phase: 'hydrated'/u
    );
    assert.match(source, /__FSUSBLOG_XSS_SPA_DOCUMENT_SENTINEL__/u);
    assert.match(source, /FullApp login-to-article navigation replaced the browser document/u);
    assert.doesNotMatch(source, /app\.dataset\.publicTakeoverDisposedShell/u);
    assert.doesNotMatch(source, /dispatchEvent\(new PopStateEvent/u);
    assert.equal(source.match(/await context\.newPage\(\)/gu)?.length, 1);
    assert.equal(source.match(/newBusinessClockPage\(/gu)?.length, 6);
});
