import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'src/frontend/package.json'));
const { Window } = require('happy-dom');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const text = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

/** Execute the existing pure codec source; no parallel binary implementation or JSON fallback. */
export async function loadPublicShellFirstResponseCodec()
{
    const frame = await readFile(path.join(root, 'src/frontend/wasm/web/protocol/frame.ts'), 'utf8');
    const payload = await readFile(path.join(root, 'src/frontend/src/bootstrap/publicAotBinaryPayload.ts'), 'utf8');
    const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
    const source = payload.replace("'@wasm/protocol/frame'", `'${moduleUrl(frame)}'`);
    return import(moduleUrl(source));
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
export async function assertPublicShellLocaleFirstResponse({ response, scene, copy, expected })
{
    assert.ok(scene.issue === 2083 && scene.stage === 'first-response', 'first response requires its matrix scene');
    assert.ok(Buffer.isBuffer(response.body) && response.body.length > 0, 'first response requires original HTML bytes');
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'matrixDigest', 'buildDigest', 'runtimeId', 'namespace'])
    {
        assert.ok(typeof expected.identity[field] === 'string' && expected.identity[field].length > 0, `missing expected ${field}`);
        equal(response.identity[field], expected.identity[field], field);
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
        const document = new window.DOMParser().parseFromString(response.body.toString('utf8'), 'text/html');
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
                authActionContext: scene.authActionContext
            }
        };
    }
    finally
    {
        window.close();
    }
}
