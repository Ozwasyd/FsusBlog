import {
    waitForApplicationReady,
    waitForPublicHydration,
    waitForServiceWorkerCacheReady,
    waitForSpaRoute,
    waitForVisualFrameReady
} from '../frontend/support/playwright/readiness.mjs';

import { BrowserContractFailure, productAssert } from './contract.mjs';

export const browserContractAppReadyTimeoutMs = 45_000;
const APP_READY_TIMEOUT_MS = browserContractAppReadyTimeoutMs;
const RESPONSE_TIMEOUT_MS = 45_000;

function issueRecord(kind, detail)
{
    return {
        kind,
        detail: String(detail).slice(0, 2_000),
        expected: false,
        at: new Date().toISOString()
    };
}

function globallyExpectedIssue(issue)
{
    return issue.detail.includes('favicon.ico')
    || issue.detail.includes('Service Worker registration blocked by Playwright')
    || issue.detail.includes('net::ERR_ABORTED')
    || issue.detail.includes('ERR_NETWORK_CHANGED')
    || /response:(?:423|428|429):.*\/api\/notifications\/stream\/preflight/u.test(issue.detail);
}

export function createPageAudit(page)
{
    const issues = [];
    page.on('console', (message) =>
    {
        if (message.type() === 'warning' || message.type() === 'error')
        {
            issues.push(issueRecord(`console-${message.type()}`, message.text()));
        }
    });
    page.on('pageerror', (error) => issues.push(issueRecord('page-error', error.message)));
    page.on('requestfailed', (request) =>
    {
        issues.push(issueRecord(
            'request-failed',
            `${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'request failed'}`
        ));
    });
    page.on('response', (response) =>
    {
        if (response.status() >= 400)
        {
            issues.push(issueRecord(
                'response',
                `response:${response.status()}:${response.request().method()} ${response.url()}`
            ));
        }
    });

    return {
        issues,
        assertClean(label, allow = () => false)
        {
            const unexpected = [];
            for (const issue of issues)
            {
                issue.expected = globallyExpectedIssue(issue) || allow(issue);
                if (!issue.expected)
                {
                    unexpected.push(issue);
                }
            }
            productAssert(unexpected.length === 0, `${label} emitted unexpected browser issues`, { issues: unexpected });
        }
    };
}

async function waitForAppReady(page, timeout = APP_READY_TIMEOUT_MS)
{
    await page.waitForFunction(() =>
    {
        const app = document.querySelector('#app');
        if (!(app instanceof HTMLElement))
        {
            return false;
        }
        const style = window.getComputedStyle(app);
        const rect = app.getBoundingClientRect();
        const loader = document.getElementById('global-loader');
        return document.readyState === 'complete'
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || '1') > 0
      && rect.width > 0
      && rect.height > 0
      && (!loader || loader.hidden);
    }, undefined, { timeout });
}

async function settlePage(page)
{
    await waitForApplicationReady(page);
    await waitForVisualFrameReady(page);
}

async function waitForPath(page, expectedPath, timeout = APP_READY_TIMEOUT_MS)
{
    await waitForSpaRoute(page, expectedPath, { timeoutMs: timeout });
    productAssert(new URL(page.url()).pathname === expectedPath, `expected route ${expectedPath}, got ${page.url()}`);
}

async function requireVisible(locator, label, timeout = APP_READY_TIMEOUT_MS)
{
    await locator.waitFor({ state: 'visible', timeout });
    productAssert(await locator.isVisible(), `${label} is not visible`);
    return locator;
}

async function installPublicIdentityProbe(context)
{
    await context.addInitScript(() =>
    {
        const state = {
            app: null,
            shell: null,
            firstChild: null,
            childElementCount: null,
            captures: 0,
            violations: []
        };
        Object.defineProperty(window, '__FSUS_BROWSER_CONTRACT_IDENTITY__', {
            configurable: false,
            enumerable: false,
            writable: false,
            value: state
        });

        const inspect = () =>
        {
            const app = document.querySelector('#app');
            const shell = document.querySelector('#fsus-aot-shell');
            if (!state.app && app instanceof HTMLElement && shell instanceof HTMLElement)
            {
                state.app = app;
                state.shell = shell;
                state.firstChild = app.firstElementChild;
                state.childElementCount = app.childElementCount;
                state.captures += 1;
                return;
            }
            if (!state.app)
            {
                return;
            }
            if (!state.app.isConnected || document.querySelector('#app') !== state.app)
            {
                state.violations.push('#app identity changed');
            }
            if (!state.shell.isConnected || document.querySelector('#fsus-aot-shell') !== state.shell)
            {
                state.violations.push('public shell identity changed');
            }
            if (state.app.firstElementChild !== state.firstChild
        || state.app.childElementCount !== state.childElementCount)
            {
                state.violations.push('#app subtree rebuilt');
            }
        };

        new MutationObserver(inspect).observe(document, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', inspect, { once: true });
        queueMicrotask(inspect);
    });
}

async function readPublicIdentity(page)
{
    return await page.evaluate(() =>
    {
        const state = window.__FSUS_BROWSER_CONTRACT_IDENTITY__;
        const app = document.querySelector('#app');
        const shell = document.querySelector('#fsus-aot-shell');
        return {
            appCount: document.querySelectorAll('#app').length,
            shellCount: document.querySelectorAll('#fsus-aot-shell').length,
            captured: Boolean(state?.app && state?.shell),
            appSame: Boolean(state?.app && state.app === app && state.app.isConnected),
            shellSame: Boolean(state?.shell && state.shell === shell && state.shell.isConnected),
            firstChildSame: Boolean(state?.app && state.app.firstElementChild === state.firstChild),
            childElementCountSame: Boolean(state?.app && state.app.childElementCount === state.childElementCount),
            captures: Number(state?.captures ?? 0),
            violations: Array.from(new Set(state?.violations ?? [])),
            hydrated: shell?.getAttribute('data-public-hydrated') === 'true'
        };
    });
}

async function assertPublicIdentity(page, label)
{
    const identity = await readPublicIdentity(page);
    productAssert(identity.appCount === 1, `${label} must expose exactly one #app`, identity);
    productAssert(identity.shellCount === 1, `${label} must expose exactly one public shell`, identity);
    productAssert(identity.captured && identity.captures === 1, `${label} did not capture one stable shell identity`, identity);
    productAssert(identity.appSame && identity.shellSame, `${label} remounted the app or shell`, identity);
    productAssert(identity.firstChildSame && identity.childElementCountSame, `${label} rebuilt the #app subtree`, identity);
    productAssert(identity.violations.length === 0, `${label} identity observer detected a rebuild`, identity);
    productAssert(identity.hydrated, `${label} did not complete real Vue hydration`, identity);
}

async function assertPublicHead(page, expectedPath)
{
    const head = await page.evaluate(() => ({
        title: document.title,
        canonical: document.querySelector('link[rel="canonical"]')?.href ?? '',
        canonicalCount: document.querySelectorAll('link[rel="canonical"]').length,
        markerCount: document.querySelectorAll('script[data-fsus-seo-head-model]').length
    }));
    productAssert(head.title.trim().length > 0, `${expectedPath} document title is empty`, head);
    productAssert(head.canonicalCount === 1, `${expectedPath} canonical link count is not one`, head);
    productAssert(head.markerCount === 1, `${expectedPath} SEO head marker count is not one`, head);
    productAssert(new URL(head.canonical).pathname === expectedPath, `${expectedPath} canonical URL is stale`, head);
}

async function clickVisiblePublicLink(page, name)
{
    const links = page
        .locator('nav[aria-label="主导航"], nav[aria-label="Primary navigation"]')
        .getByRole('link', { name });
    for (let index = 0; index < await links.count(); index += 1)
    {
        if (await links.nth(index).isVisible())
        {
            await links.nth(index).click();
            return;
        }
    }
    throw new BrowserContractFailure(`visible public navigation link not found: ${name}`, 'product');
}

async function publicHydrationHistoryReload({ context, page, fixture, audit })
{
    await installPublicIdentityProbe(context);
    const articlePath = `/article/${fixture.publicArticle.id}`;
    const response = await page.goto(articlePath, { waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
    productAssert(response?.ok(), `public article direct load failed: ${response?.status() ?? 'no response'}`);
    await waitForAppReady(page);
    await page.waitForFunction(() => document.querySelector('#fsus-aot-shell')?.getAttribute('data-public-hydrated') === 'true', undefined, {
        timeout: APP_READY_TIMEOUT_MS
    });
    await requireVisible(page.getByRole('heading', { level: 1, name: fixture.publicArticle.title }).first(), 'public article heading');
    await assertPublicHead(page, articlePath);
    await assertPublicIdentity(page, 'direct hydration');
    const direct = await page.evaluate(() =>
    {
        const shell = document.querySelector('#fsus-aot-shell');
        const bootstrap = document.querySelector('#fsus-aot-bootstrap');
        return {
            route: `${location.pathname}${location.search}`,
            locale: document.documentElement.lang,
            title: document.querySelector('h1')?.textContent?.trim() ?? '',
            hydrationKind: shell?.getAttribute('data-public-hydration-kind') ?? '',
            hydrated: shell?.getAttribute('data-public-hydrated') === 'true',
            appCount: document.querySelectorAll('#app').length,
            shellCount: document.querySelectorAll('#fsus-aot-shell').length,
            canonicalPath: new URL(document.querySelector('link[rel="canonical"]')?.href ?? location.href).pathname,
            seoMarkerCount: document.querySelectorAll('script[data-fsus-seo-head-model]').length,
            bootstrapText: bootstrap?.textContent ?? '',
            resourceUrls: performance.getEntriesByType('resource').map((entry) => entry.name).sort()
        };
    });
    const serverHtml = await response.text();
    const responseHeaders = await response.allHeaders();

    await page.mouse.click(16, 16);
    await waitForPublicHydration(page);
    await clickVisiblePublicLink(page, '归档');
    await waitForPath(page, '/archive');
    await waitForAppReady(page);
    await settlePage(page);
    await requireVisible(page.getByRole('heading', { level: 1, name: '归档' }).first(), 'archive heading');
    await assertPublicHead(page, '/archive');
    await assertPublicIdentity(page, 'SPA takeover');
    const spa = await readPublicIdentity(page);

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await waitForPath(page, articlePath);
    await waitForAppReady(page);
    await requireVisible(page.getByRole('heading', { level: 1, name: fixture.publicArticle.title }).first(), 'history article heading');
    await assertPublicHead(page, articlePath);
    await assertPublicIdentity(page, 'browser back');
    const history = await readPublicIdentity(page);

    const reloadResponse = await page.reload({ waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
    productAssert(reloadResponse?.ok(), `public article reload failed: ${reloadResponse?.status() ?? 'no response'}`);
    await waitForAppReady(page);
    await page.waitForFunction(() => document.querySelector('#fsus-aot-shell')?.getAttribute('data-public-hydrated') === 'true', undefined, {
        timeout: APP_READY_TIMEOUT_MS
    });
    await requireVisible(page.getByRole('heading', { level: 1, name: fixture.publicArticle.title }).first(), 'reloaded article heading');
    await assertPublicHead(page, articlePath);
    await assertPublicIdentity(page, 'reload hydration');
    audit.assertClean('public hydration/history/reload');
    const reload = await readPublicIdentity(page);
    return {
        schema: 'fsusblog.browser-contract-public-aot-observation.v1',
        fixture: {
            articleId: String(fixture.publicArticle.id),
            articleTitle: fixture.publicArticle.title,
            articlePath
        },
        response: {
            url: response.url(),
            status: response.status(),
            headers: responseHeaders,
            serverHtml
        },
        direct,
        spa,
        history,
        reload
    };
}

async function accountDeepLinkBootstrap({ context, page, fixture, audit })
{
    const cookies = await context.cookies(fixture.baseUrl);
    productAssert(cookies.some((cookie) => /AccessToken|SessionId/u.test(cookie.name)), 'account fixture has no real session cookie');
    const path = '/user/identity/passkeys';
    const response = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
    productAssert(response?.ok(), `account deep link failed: ${response?.status() ?? 'no response'}`);
    await waitForPath(page, path);
    await waitForAppReady(page);
    await requireVisible(page.getByRole('heading', { name: '通行密钥' }).first(), 'account passkey heading');
    await requireVisible(page.getByText('通行密钥设备', { exact: true }).first(), 'account bootstrap content');
    audit.assertClean('account deep-link bootstrap');
}

async function adminDeepLinkExpiredSession({ context, page, fixture, audit })
{
    const cookies = await context.cookies(fixture.baseUrl);
    productAssert(cookies.some((cookie) => /AdminAccessToken|AdminSessionId/u.test(cookie.name)), 'admin fixture has no real session cookie');
    const path = '/user/manage/article/list';
    const response = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
    productAssert(response?.ok(), `admin deep link failed: ${response?.status() ?? 'no response'}`);
    await waitForPath(page, path);
    await waitForAppReady(page);
    await requireVisible(page.getByRole('heading', { name: '文章管理' }), 'admin bootstrap heading');
    const activeDeepLink = new URL(page.url());
    const expectedRedirect = `${activeDeepLink.pathname}${activeDeepLink.search}`;

    await context.clearCookies();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
    await page.waitForURL((url) => url.pathname === '/login', { timeout: APP_READY_TIMEOUT_MS });
    await waitForAppReady(page);
    const redirected = new URL(page.url());
    productAssert(redirected.searchParams.get('redirect') === expectedRedirect, 'expired admin session lost its deep-link redirect', {
        url: page.url()
    });
    await requireVisible(page.getByRole('heading', { name: '登录' }), 'expired-session login expression');
    audit.assertClean('admin session invalidation', (issue) =>
        issue.detail.includes('401') || issue.detail.includes('/api/binary/auth/'));
}

async function ensureArticleCategorySelected(page, categoryName)
{
    const input = page.getByPlaceholder('选择分类').first();
    const current = await input.inputValue().catch(() => '');
    if (current.trim())
    {
        return;
    }
    await input.click();
    const named = page.getByRole('option', { name: categoryName, exact: true });
    if (await named.isVisible({ timeout: 5_000 }).catch(() => false))
    {
        await named.click();
        return;
    }
    const fallback = page.locator('.el-select-dropdown__item:visible, [role="option"]:visible').first();
    await requireVisible(fallback, 'article category option', 5_000);
    await fallback.click();
}

async function findPublishedArticle(page, title)
{
    const search = page.getByRole('textbox', { name: '搜索文章标题' }).first();
    await requireVisible(search, 'article list search');
    await search.fill(title);
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    const row = page.getByText(title, { exact: false }).first();
    await requireVisible(row, 'published article row');
}

async function articlePublishPersistence({ page, fixture, audit })
{
    const title = `Browser Contract ${fixture.namespace.slice(-20)}`;
    const path = '/user/manage/article/write';
    const response = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
    productAssert(response?.ok(), `article write route failed: ${response?.status() ?? 'no response'}`);
    await waitForPath(page, path);
    await waitForAppReady(page);

    const discardDraft = page.getByRole('button', { name: '丢弃服务端草稿' });
    if (await discardDraft.isVisible().catch(() => false))
    {
        await discardDraft.click();
        await discardDraft.waitFor({ state: 'hidden', timeout: 10_000 });
    }

    await page.getByPlaceholder(/写下文章标题|在此键入博文标题/u).first().fill(title);
    await page
        .getByRole('textbox', { name: 'Markdown 正文编辑区' })
        .or(page.getByPlaceholder('从这里开始写正文。'))
        .first()
        .fill('## Browser Contract\n\n单 Chromium release contract 的真实发布与持久化探针。');
    await ensureArticleCategorySelected(page, fixture.category.name);

    const prepublishResponse = page.waitForResponse((candidate) =>
    {
        const url = new URL(candidate.url());
        return candidate.request().method() === 'POST' && url.pathname === '/api/binary/author/prepublish-check';
    }, { timeout: RESPONSE_TIMEOUT_MS });
    const createResponse = page.waitForResponse((candidate) =>
    {
        const url = new URL(candidate.url());
        return candidate.request().method() === 'POST' && url.pathname === '/api/binary/admin/article';
    }, { timeout: RESPONSE_TIMEOUT_MS });

    await page.getByRole('button', { name: /发布文章|立即发布/u }).first().click();
    const prepublish = await prepublishResponse;
    productAssert(prepublish.ok(), `article prepublish request failed: ${prepublish.status()}`);
    const confirmation = await requireVisible(page.getByRole('dialog', { name: '发布确认' }), 'article publish confirmation');
    const warningReason = confirmation.locator('textarea[placeholder*="说明本次接受"]');
    if (await warningReason.isVisible().catch(() => false))
    {
        await warningReason.fill('Release Browser Contract 接受本次测试文章缺少人工摘要或头图。');
    }
    await confirmation.getByRole('button', { name: /发布文章|确认发布/u }).click();
    const created = await createResponse;
    productAssert(created.ok(), `article publish request failed: ${created.status()}`);

    await waitForPath(page, '/user/manage/article/list');
    await waitForAppReady(page);
    await findPublishedArticle(page, title);
    const reloadResponse = await page.reload({ waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
    productAssert(reloadResponse?.ok(), `article list reload failed: ${reloadResponse?.status() ?? 'no response'}`);
    await waitForAppReady(page);
    await findPublishedArticle(page, title);
    audit.assertClean('article publish persistence', (issue) =>
        issue.detail.includes('/api/binary/auth/me')
      || issue.detail.includes('status of 401'));
}

async function webauthnVirtualAuthenticator({ context, page, fixture, audit })
{
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true
        }
    });
    try
    {
        const path = '/user/identity/passkeys';
        const response = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
        productAssert(response?.ok(), `passkey route failed: ${response?.status() ?? 'no response'}`);
        await waitForPath(page, path);
        await waitForAppReady(page);
        const name = `Contract key ${fixture.namespace.slice(-16)}`;
        await requireVisible(page.getByRole('button', { name: '添加通行密钥' }).first(), 'add passkey action');
        await page.getByRole('button', { name: '添加通行密钥' }).first().click();
        const dialog = await requireVisible(page.getByRole('dialog', { name: '添加通行密钥' }), 'passkey registration dialog');
        await dialog.locator('#passkey-register-name').fill(name);
        await dialog.getByRole('button', { name: '注册', exact: true }).click();
        await requireVisible(dialog.getByText('通行密钥注册成功', { exact: true }), 'passkey registration success');
        await dialog.getByRole('button', { name: '完成', exact: true }).click();
        await requireVisible(page.getByText(name, { exact: true }), 'registered passkey row');

        const reloadResponse = await page.reload({ waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
        productAssert(reloadResponse?.ok(), `passkey persistence reload failed: ${reloadResponse?.status() ?? 'no response'}`);
        await waitForAppReady(page);
        await requireVisible(page.getByText(name, { exact: true }), 'persisted passkey row');
        audit.assertClean('WebAuthn virtual authenticator');
    }
    finally
    {
        await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() =>
        {});
        await cdp.send('WebAuthn.disable').catch(() =>
        {});
        await cdp.detach().catch(() =>
        {});
    }
}

async function waitForServiceWorkerController(page)
{
    await page.waitForFunction(() => 'serviceWorker' in navigator, undefined, { timeout: 10_000 });
    await page.evaluate(async () =>
    {
        await navigator.serviceWorker.ready;
    });
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
    }
    await waitForServiceWorkerCacheReady(page, { timeoutMs: 15_000 });
}

async function serviceWorkerOfflineReload({ context, page, fixture, audit })
{
    const path = `/article/${fixture.publicArticle.id}`;
    const response = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
    productAssert(response?.ok(), `service worker warm load failed: ${response?.status() ?? 'no response'}`);
    await waitForServiceWorkerController(page);
    await context.setOffline(true);
    try
    {
        const offline = await page.reload({ waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
        productAssert(offline?.status() === 503, `offline private/no-store reload expected 503, got ${offline?.status() ?? 'no response'}`);
        productAssert(!offline.headers()['x-fsus-offline-stale'], 'offline reload must not serve stale private/no-store HTML');
    }
    finally
    {
        await context.setOffline(false);
    }
    const recovery = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT_MS });
    productAssert(recovery?.ok(), `service worker online recovery failed: ${recovery?.status() ?? 'no response'}`);
    await waitForAppReady(page);
    audit.assertClean('service worker offline reload', (issue) =>
        issue.detail.includes('503')
      || issue.detail.includes('ERR_INTERNET_DISCONNECTED')
      || issue.detail.includes('Failed to load resource'));
}

export const browserContractScenarioRunners = Object.freeze({
    'public-hydration-history-reload': publicHydrationHistoryReload,
    'account-deep-link-bootstrap': accountDeepLinkBootstrap,
    'admin-deep-link-expired-session': adminDeepLinkExpiredSession,
    'article-publish-persistence': articlePublishPersistence,
    'webauthn-virtual-authenticator': webauthnVirtualAuthenticator,
    'service-worker-offline-reload': serviceWorkerOfflineReload
});
