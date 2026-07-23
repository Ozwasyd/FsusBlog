import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { BrowserContractFailure } from './contract.mjs';
import { createPageAudit } from './scenarios.mjs';
import {
    waitForApplicationReady,
    waitForVisualFrameReady
} from '../frontend/support/playwright/readiness.mjs';

function publicPreviewRoute(entry, fixture)
{
    const routes = {
        Home: '/',
        ArticleDetail: `/article/${fixture.publicArticle.id}`,
        ManageDashboard: '/user/manage',
        ManageWriteArticle: '/user/manage/article/write',
        ManageModerationComments: '/user/manage/moderation/comments',
        ManageSecurityDashboard: '/user/manage/security',
        ManageOpsHealth: '/user/manage/ops'
    };
    const route = routes[entry.route];
    if (!route)
    {
        throw new BrowserContractFailure(`public-preview route is not materialized: ${entry.route}`, 'contract');
    }
    return route;
}

function contextOptions(entry, fixture)
{
    const role = entry.scope === 'admin' ? 'admin' : 'anonymous';
    const storageState = role === 'admin' ? fixture.admin.storageState : undefined;
    const viewport = entry.viewport === 'mobile'
        ? { width: 390, height: 844 }
        : { width: 1365, height: 768 };
    return {
        baseURL: fixture.baseUrl,
        ...(storageState ? { storageState } : {}),
        serviceWorkers: 'block',
        viewport,
        colorScheme: entry.theme,
        reducedMotion: 'reduce',
        locale: 'zh-CN',
        timezoneId: 'UTC',
        userAgent: `FsusBlog-Public-Preview/${entry.id}`,
        extraHTTPHeaders: fixture.testSession
            ? { 'X-Fsus-Test-Session': fixture.testSession }
            : {}
    };
}

async function captureEntry(browser, fixture, entry, stagingDirectory, timeoutMs)
{
    const context = await browser.newContext(contextOptions(entry, fixture));
    try
    {
        await context.addInitScript((theme) =>
        {
            globalThis.localStorage.setItem('fsus:theme-mode', theme);
        }, entry.theme);
        const page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);
        page.setDefaultNavigationTimeout(timeoutMs);
        const audit = createPageAudit(page);
        const route = publicPreviewRoute(entry, fixture);
        const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
        if (!response?.ok())
        {
            throw new BrowserContractFailure(`${entry.id} returned ${response?.status() ?? 'no response'}`, 'product');
        }
        await page.waitForFunction(() =>
        {
            const app = globalThis.document.querySelector('#app');
            return globalThis.document.readyState === 'complete'
                && app instanceof globalThis.HTMLElement
                && app.getBoundingClientRect().width > 0
                && app.getBoundingClientRect().height > 0;
        });
        await page.evaluate(async (theme) =>
        {
            await globalThis.document.fonts.ready;
            const root = globalThis.document.documentElement;
            const dark = theme === 'dark';
            root.classList.toggle('dark', dark);
            root.classList.toggle('light', !dark);
            root.dataset.themeMode = theme;
            root.dataset.themeResolved = dark ? 'dark' : 'light';
            root.style.colorScheme = dark ? 'dark' : 'light';
        }, entry.theme);
        await page.addStyleTag({
            content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'
        });
        await waitForApplicationReady(page);
        await waitForVisualFrameReady(page);
        const layout = await page.evaluate(() => ({
            overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth + 1,
            appRoots: globalThis.document.querySelectorAll('#app').length,
            theme: globalThis.document.documentElement.dataset.themeResolved ?? ''
        }));
        if (layout.overflow || layout.appRoots !== 1 || layout.theme !== entry.theme)
        {
            throw new BrowserContractFailure(`${entry.id} failed layout/theme audit`, 'product', layout);
        }
        audit.assertClean(`public-preview ${entry.id}`);
        const file = path.join(stagingDirectory, entry.file);
        await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' });
        await chmod(file, 0o600);
    }
    finally
    {
        await context.close().catch(() => undefined);
    }
}

export async function capturePublicPreviewGallery({
    browser,
    fixture,
    sourceCommit,
    stagingDirectory,
    evidenceFile,
    timeoutMs,
    operations
})
{
    const registry = operations.readRegistry();
    await rm(stagingDirectory, { recursive: true, force: true });
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    for (const entry of registry.screenshots)
    {
        await captureEntry(browser, fixture, entry, stagingDirectory, timeoutMs);
    }
    operations.writeManifest(stagingDirectory, sourceCommit);
    return operations.verifyCapturedDirectory(stagingDirectory, evidenceFile);
}
