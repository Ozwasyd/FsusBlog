import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicShellFiniteInputOwner } from './public-shell-finite-input-owner.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'src/frontend/package.json'));
const { Window } = require('happy-dom');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const text = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

/** Execute the existing pure codec source; no parallel binary implementation or JSON fallback. */
export async function loadPublicShellFirstResponseCodec()
{
    const owner = await createPublicShellFiniteInputOwner(root);
    return owner.load('publicAotPayload');
}

/** Load the unchanged production SEO validator/digest and its real import closure, not a second serializer. */
export async function loadPublicShellFirstResponseSeoHead()
{
    const owner = await createPublicShellFiniteInputOwner(root);
    return owner.load('seoHead');
}

function publishedString(value, label)
{
    assert.ok(typeof value === 'string' && value.length > 0 && value.trim() === value,
        `published artifact requires ${label}`);
    return value;
}

function publishedRecord(value, label)
{
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value),
        `published artifact requires ${label}`);
    return value;
}

function publishedJson(value)
{
    try
    {
        return publishedRecord(JSON.parse(value), 'typed JSON object');
    }
    catch
    {
        throw new Error('published artifact JSON carrier is invalid');
    }
}

function publicationTime(value)
{
    publishedString(value, 'UTC publication time');
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(?:Z|\+00:00)$/u.exec(value);
    assert.ok(match, 'published artifact requires a UTC publication time');
    const date = new Date(`${match[1]}Z`);
    assert.ok(Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 19) === match[1],
        'published artifact publication time is invalid');
    // Preserve the seven .NET ticks digits; millisecond Date equality alone loses publication drift.
    return `${match[1]}.${(match[2] ?? '').padEnd(7, '0')}`;
}

/**
 * Consume independently read published-artifact observation bytes AFTER the fixture/private consumer
 * admits their sealed file, Root and commit receipt. This getter does not establish those proofs,
 * measure a response, infer current release/cache policy or qualify a rendered first navigation.
 */
export async function readPublicShellLocalePublishedArtifact({ publishedArtifact, scene, expectedOwner, expectedRoute })
{
    assert.ok(scene.issue === 2083 && scene.stage === 'first-response', 'published artifact requires its matrix scene');
    equal(publishedArtifact.schema, 'fsusblog.public-content-published-artifact-observation.v1', 'published observation schema');
    for (const field of ['namespace', 'runtimeRunId', 'sourceCommit', 'worktreeFingerprint', 'buildDigest', 'runtimeScope'])
    {
        if (field === 'runtimeScope')
        {
            assert.ok(Object.hasOwn(expectedOwner, field) && typeof expectedOwner[field] === 'string',
                'published artifact requires expected runtimeScope string');
            assert.ok(Object.hasOwn(publishedArtifact.owner, field) && typeof publishedArtifact.owner[field] === 'string',
                'published artifact requires observed runtimeScope string');
        }
        else
        {
            publishedString(expectedOwner[field], `expected owner ${field}`);
        }
        equal(publishedArtifact.owner[field], expectedOwner[field], `published owner ${field}`);
    }
    const route = publishedRecord(publishedArtifact.route, 'route');
    equal(route.path, publishedString(expectedRoute.path, 'expected route path'), 'published route path');
    equal(route.routeKey, publishedString(expectedRoute.routeKey, 'expected route key'), 'published route key');
    equal(route.kind, scene.route, 'published route kind');
    equal(route.locale, scene.locale, 'published route locale');
    const publication = publishedRecord(publishedArtifact.publication, 'publication');
    // Only the existing verified ServerSsrBackfill writer binds GeneratedAtUtc to renderTimestamp.
    equal(publication.source, 'server-ssr', 'published write source');
    equal(publishedString(publication.contentType, 'published content type').split(';')[0].trim(), 'text/html', 'published content type');
    publishedString(publication.rendererVersion, 'published renderer');
    const generatedAt = publicationTime(publication.generatedAtUtc);
    assert.ok(Array.isArray(publishedArtifact.originals) && publishedArtifact.originals.length === 1,
        'published artifact requires one independent original');
    const original = publishedArtifact.originals[0];
    equal(original.role, 'published-artifact', 'original role');
    equal(original.encoding, 'base64', 'original encoding');
    publishedString(original.content, 'original base64');
    assert.ok(Number.isSafeInteger(original.bytes) && original.bytes > 0, 'published artifact requires original byte length');
    assert.ok(typeof original.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(original.sha256), 'published artifact requires original byte digest');
    const bytes = Buffer.from(original.content, 'base64');
    equal(bytes.toString('base64'), original.content, 'original canonical base64');
    equal(bytes.length, original.bytes, 'original byte length');
    equal(sha256(bytes), original.sha256, 'original byte digest');
    let html;
    try
    {
        html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    catch
    {
        throw new Error('published artifact UTF8 is invalid');
    }
    const codec = await loadPublicShellFirstResponseCodec();
    const seoOwner = await loadPublicShellFirstResponseSeoHead();
    const window = new Window({ settings: {
        enableJavaScriptEvaluation: false, disableJavaScriptFileLoading: true,
        disableCSSFileLoading: true, disableIframePageLoading: true, disableComputedStyleRendering: true
    } });
    try
    {
        const document = new window.DOMParser().parseFromString(html, 'text/html');
        function carrier(selector, type)
        {
            const node = one(document, selector);
            equal(node.tagName, 'SCRIPT', 'published carrier tag');
            equal(node.getAttribute('type'), type, 'published carrier type');
            assert.ok(node.textContent?.length > 0, 'published artifact requires carrier bytes');
            return node.textContent;
        }
        const seoHead = publishedJson(carrier('[data-fsus-seo-head-model]', 'application/json'));
        for (const value of [seoHead.articlePublishedAtUtc, seoHead.articleModifiedAtUtc, seoHead.articleAuthor,
            seoHead.articleImageUrl, seoHead.openGraph?.imageUrl, seoHead.twitter?.imageUrl])
        {
            assert.ok(value === undefined || value === null || typeof value === 'string', 'published artifact SEO optional type is invalid');
        }
        assert.ok(await seoOwner.validateAndPreparePublicSeoHead(seoHead, route.path, route.path),
            'published artifact production SEO validation failed');
        equal(seoHead.locale, scene.document.language, 'published SEO locale');
        equal(seoHead.pageType, scene.route, 'published SEO route kind');
        equal(seoHead.openGraph.locale, scene.document.openGraphLocale, 'published SEO OpenGraph locale');
        const canonical = new URL(seoHead.canonicalUrl);
        assert.ok(['https:', 'http:'].includes(canonical.protocol) && !canonical.username && !canonical.password,
            'published artifact canonical URL is invalid');
        equal(canonical.origin, seoHead.publicOrigin, 'published SEO origin');
        equal(`${canonical.pathname}${canonical.search}`, route.path, 'published SEO canonical route');
        equal(canonical.hash, '', 'published SEO canonical fragment');
        equal(seoHead.pageEntityId, seoHead.canonicalUrl, 'published SEO page entity');
        equal(seoHead.openGraph.url, seoHead.canonicalUrl, 'published SEO OpenGraph URL');
        let bootstrap;
        try
        {
            bootstrap = codec.decodePublicAotPayload(carrier('#fsus-aot-bootstrap', 'application/octet-stream'));
        }
        catch
        {
            throw new Error('published artifact AEDS carrier is invalid');
        }
        publishedRecord(bootstrap, 'official AEDS bootstrap');
        equal(bootstrap.renderLocale, scene.locale, 'published AEDS locale');
        equal(bootstrap.kind, scene.route, 'published AEDS route kind');
        equal(bootstrap.routeKey, route.routeKey, 'published AEDS route key');
        equal(bootstrap.rendererVersion, publication.rendererVersion, 'published AEDS renderer');
        publishedString(bootstrap.localeCatalogDigest, 'published catalog digest');
        equal(publicationTime(bootstrap.renderTimestamp), generatedAt, 'published AEDS publication time');
        const bootConfig = publishedJson(carrier('#fsus-public-boot-config', 'application/json'));
        equal(bootConfig.schema, 'fsusblog.public-boot-config.v1', 'published boot config schema');
        publishedString(bootConfig.frontendBuildIdentity, 'published frontend build identity');
        assert.ok(Array.isArray(bootConfig.coreModulePreloads) && Array.isArray(bootConfig.takeoverStylesheets),
            'published artifact boot asset lists are invalid');
        const urls = [bootConfig.entryUrl, ...bootConfig.coreModulePreloads, ...bootConfig.takeoverStylesheets].map(value =>
        {
            publishedString(value, 'published boot asset');
            const url = new URL(value, canonical);
            assert.ok(['https:', 'http:'].includes(url.protocol) && url.origin === canonical.origin
                && !url.username && !url.password, 'published artifact boot asset origin is invalid');
            return url.href;
        });
        assert.ok(new Set(urls).size === urls.length, 'published artifact boot assets are duplicated');
        return { seoHead, bootstrap, bootConfig };
    }
    finally
    {
        seoOwner.resetPublicSeoHeadForTests();
        await window.happyDOM.close();
    }
}

function equal(actual, expected, label)
{
    // Keep raw HTML, response headers and potentially personal metadata out of assertion diagnostics.
    assert.ok(actual === expected, `first response ${label} mismatch`);
}

function one(document, selector)
{
    const nodes = document.querySelectorAll(selector);
    assert.ok(nodes.length === 1, `first response requires one ${selector}`);
    return nodes[0];
}

/** Inspect immutable response bytes, never a hydrated document. This is not a qualification writer. */
export async function assertPublicShellLocaleFirstResponse({ response, scene, copy, expected, resolverResult = null })
{
    assert.ok(scene.issue === 2083 && scene.stage === 'first-response', 'first response requires its matrix scene');
    assert.ok(Buffer.isBuffer(response.body) && response.body.length > 0, 'first response requires original HTML bytes');
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'matrixDigest', 'buildDigest', 'runtimeId', 'namespace'])
    {
        assert.ok(typeof expected.identity[field] === 'string' && expected.identity[field].length > 0, `missing expected ${field}`);
        equal(response.identity[field], expected.identity[field], field);
    }
    // Optional diagnostic input is the canonical LocaleResolutionResult shape. The
    // current HTTP capture exposes no such result: absence must remain explicit,
    // and neither scene expectations nor Content-Language can supply Source/reason.
    let resolution = null;
    if (resolverResult !== null)
    {
        equal(resolverResult.locale?.code, scene.locale, 'resolver locale');
        equal(resolverResult.source, scene.expectedResolution.source, 'resolver source');
        equal(resolverResult.matchedRange, scene.expectedResolution.matchedRange, 'resolver matched range');
        equal(resolverResult.catalogDigest, expected.bootstrap.localeCatalogDigest, 'resolver catalog digest');
        resolution = { locale: resolverResult.locale.code, source: resolverResult.source,
            matchedRange: resolverResult.matchedRange, catalogDigest: resolverResult.catalogDigest };
    }
    const headers = new Headers(response.headers);
    equal(response.status, 200, 'status');
    equal(headers.get('content-type')?.split(';')[0].trim().toLowerCase(), 'text/html', 'content type');
    equal(headers.get('content-language'), scene.document.language, 'Content-Language');
    // Expected cache policy comes from the host/route fixture, not from a second local policy table.
    assert.ok(typeof expected.cacheControl === 'string' && expected.cacheControl.length > 0, 'missing expected cache policy');
    equal(headers.get('cache-control'), expected.cacheControl, 'cache policy');
    assert.ok(expected.metadata.title && expected.metadata.description && expected.metadata.canonicalUrl, 'missing fixture metadata');
    assert.ok(expected.frontendBuildIdentity, 'missing expected frontend build identity');
    let html;
    try
    {
        html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(response.body);
    }
    catch
    {
        throw new Error('first response UTF8 is invalid');
    }
    const codec = await loadPublicShellFirstResponseCodec();
    const window = new Window({ settings: {
        enableJavaScriptEvaluation: false,
        disableJavaScriptFileLoading: true,
        disableCSSFileLoading: true,
        disableIframePageLoading: true,
        disableComputedStyleRendering: true
    } });
    try
    {
        const document = new window.DOMParser().parseFromString(html, 'text/html');
        equal(document.documentElement.lang, scene.document.language, 'html lang');
        equal(document.documentElement.getAttribute('dir'), scene.document.direction, 'html direction');
        equal(one(document, 'title').textContent, expected.metadata.title, 'document title');
        for (const [selector, value] of [
            ['meta[name="description"]', expected.metadata.description],
            ['meta[property="og:title"]', expected.metadata.title],
            ['meta[property="og:description"]', expected.metadata.description],
            ['meta[property="og:locale"]', scene.document.openGraphLocale]
        ])
        {
            equal(one(document, selector).getAttribute('content'), value, selector);
        }
        equal(one(document, 'link[rel="canonical"]').getAttribute('href'), expected.metadata.canonicalUrl, 'canonical URL');
        const shell = one(document, '#fsus-aot-shell');
        equal(shell.getAttribute('data-public-render-locale'), scene.locale, 'shell locale');
        const authKey = scene.authActionContext === 'anonymous' ? 'login' : scene.authActionContext === 'admin' ? 'dashboard' : 'account';
        equal(shell.getAttribute('data-public-auth-message-key'), `public.shell.${authKey}`, 'auth action key');
        for (const [selector, key] of [
            ['[data-public-nav="archive"]', 'archive'],
            ['[data-public-nav="about"]', 'about'],
            ['[data-public-nav="auth"]', authKey],
            ['a[href="#main-content"]', 'skipToMain'],
            ['a[href="/search"][aria-controls]', 'search']
        ])
        {
            const expectedCopy = copy[`public.shell.${key}`];
            assert.ok(typeof expectedCopy === 'string' && expectedCopy.length > 0, `missing typed copy ${key}`);
            const nodes = shell.querySelectorAll(selector);
            assert.ok(nodes.length > 0, `missing server copy ${key}`);
            for (const node of nodes)
            {
                equal(text(node.textContent), text(expectedCopy), `typed copy ${key}`);
            }
        }
        // FsusUI emits the brand link first; its configured site title is not the translated Home label.
        const homeLinks = [...shell.querySelectorAll('[data-public-nav="home"]')];
        assert.ok(homeLinks.length >= 2 && copy['public.shell.home'], 'missing server Home navigation');
        for (const node of homeLinks.slice(1))
        {
            equal(text(node.textContent), text(copy['public.shell.home']), 'typed copy home');
        }
        const selectors = shell.querySelectorAll('[data-locale-selector]');
        assert.ok(selectors.length > 0, 'missing server locale selector');
        for (const selector of selectors)
        {
            equal(selector.getAttribute('data-active-locale'), scene.locale, 'selector active locale');
            const items = selector.querySelectorAll('[data-locale-selector-item]');
            equal(items.length, scene.selectorItems.length, 'selector count');
            for (const [index, item] of [...items].entries())
            {
                const projected = scene.selectorItems[index];
                equal(item.getAttribute('data-locale-code'), projected.code, 'selector order');
                equal(item.getAttribute('data-selected'), String(projected.selected), 'selector selected');
                equal(item.getAttribute('aria-checked'), String(projected.selected), 'selector aria checked');
                const label = projected.englishName && projected.englishName !== projected.nativeName
                    ? `${projected.nativeName} ${projected.englishName}` : projected.nativeName;
                equal(text(item.textContent), text(label), 'selector label');
            }
        }
        const bootstrapElement = one(document, '#fsus-aot-bootstrap');
        equal(bootstrapElement.getAttribute('type'), 'application/octet-stream', 'bootstrap encoding');
        const bootstrap = codec.decodePublicAotPayload(text(bootstrapElement.textContent));
        assert.ok(bootstrap && typeof bootstrap === 'object', 'invalid first response AEDS bootstrap');
        equal(bootstrap.renderLocale, scene.locale, 'bootstrap locale');
        equal(bootstrap.kind, scene.route, 'bootstrap kind');
        for (const field of ['localeCatalogDigest', 'rendererVersion', 'renderTimestamp', 'routeKey'])
        {
            assert.ok(typeof expected.bootstrap[field] === 'string' && expected.bootstrap[field].length > 0, `missing expected bootstrap ${field}`);
            equal(bootstrap[field], expected.bootstrap[field], `bootstrap ${field}`);
        }
        const bootElement = one(document, '#fsus-public-boot-config');
        equal(bootElement.getAttribute('type'), 'application/json', 'boot configuration encoding');
        // This JSON is the existing boot configuration, never an alternative bootstrap payload.
        const boot = JSON.parse(bootElement.textContent);
        equal(boot.schema, 'fsusblog.public-boot-config.v1', 'boot configuration schema');
        equal(boot.frontendBuildIdentity, expected.frontendBuildIdentity, 'frontend build identity');
        const bodyDigest = sha256(response.body);
        return {
            schema: 'fsusblog.public-shell-locale-first-response.v1',
            evidenceKind: 'diagnostic-probe',
            qualificationEligible: false,
            identity: Object.fromEntries(['sourceCommit', 'worktreeFingerprint', 'matrixDigest', 'buildDigest', 'runtimeId', 'namespace']
                .map((field) => [field, expected.identity[field]])),
            response: {
                status: response.status,
                contentType: 'text/html',
                contentLanguage: scene.document.language,
                cacheControlDigest: sha256(expected.cacheControl),
                bodyDigest,
                bodyBytes: response.body.length
            },
            observed: {
                locale: scene.locale,
                route: scene.route,
                authActionContext: scene.authActionContext,
                resolution,
                resolutionCaptureState: resolution === null ? 'not-captured' : 'caller-supplied-diagnostic'
            }
        };
    }
    finally
    {
        window.close();
    }
}
