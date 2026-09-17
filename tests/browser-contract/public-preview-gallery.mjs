import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserContractFailure } from './contract.mjs';
import {
    applyPublicPreviewZoom,
    auditPublicPreviewPage,
    createPublicPreviewQualityMatrix,
    measurePublicPreviewHeader,
    writePublicPreviewQualityMatrix,
    writePublicPreviewQualitySidecar
} from '../../tools/docs/public-preview-quality.mjs';
import { createPageAudit } from './scenarios.mjs';
import { loadPublicPreviewRegistry } from '../../tools/docs/public-preview-registry.mjs';
import {
    comparePublicPreviewQualityManifests,
    writePublicPreviewQualityManifest
} from '../../tools/docs/public-preview-quality-publication.mjs';
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
    const viewport = entry.qualityViewport ?? (typeof entry.viewport === 'object'
        ? entry.viewport
        : entry.viewport === 'mobile'
            ? { width: 390, height: 844 }
            : { width: 1440, height: 960 });
    return {
        baseURL: fixture.baseUrl,
        ...(storageState ? { storageState } : {}),
        serviceWorkers: 'block',
        viewport,
        colorScheme: entry.theme,
        reducedMotion: 'reduce',
        locale: entry.locale ?? 'zh-CN',
        timezoneId: 'UTC',
        userAgent: `FsusBlog-Public-Preview/${entry.id}`,
        extraHTTPHeaders: fixture.testSession
            ? { 'X-Fsus-Test-Session': fixture.testSession }
            : {}
    };
}

async function captureEntry(browser, fixture, entry, stagingDirectory, timeoutMs, qualityPolicy)
{
    const context = await browser.newContext(contextOptions(entry, fixture));
    try
    {
        await context.addCookies([{
            name: qualityPolicy.localePreferenceCookieName,
            value: entry.locale ?? 'zh-CN',
            url: fixture.baseUrl,
            httpOnly: true,
            sameSite: 'Lax'
        }]);
        await context.addInitScript(({ theme }) =>
        {
            globalThis.localStorage.setItem('fsus:theme-mode', theme);
        }, { theme: entry.theme });
        const page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);
        page.setDefaultNavigationTimeout(timeoutMs);
        const audit = createPageAudit(page);
        const route = publicPreviewRoute(entry, fixture);
        const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
        const headerSamples = [await measurePublicPreviewHeader(page, 'domcontentloaded')];
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
        headerSamples.push(await measurePublicPreviewHeader(page, 'application-ready'));
        await waitForVisualFrameReady(page);
        await applyPublicPreviewZoom(page, entry.zoom ?? 1);
        headerSamples.push(await measurePublicPreviewHeader(page, 'stable-frame'));
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
        const quality = await auditPublicPreviewPage(page, {
            ...entry,
            viewport: contextOptions(entry, fixture).viewport,
            surfaceRole: entry.surfaceRole ?? (entry.scope === 'admin' ? 'task' : 'public')
        }, qualityPolicy, { headerSamples });
        const file = path.join(stagingDirectory, entry.file);
        await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' });
        await chmod(file, 0o600);
        await writePublicPreviewQualitySidecar(stagingDirectory, entry.file, quality);
        if (quality.status !== 'pass')
        {
            throw new BrowserContractFailure(`${entry.id} failed public-preview quality audit`, 'product', quality);
        }
        return quality;
    }
    finally
    {
        await context.close().catch(() => undefined);
    }
}

async function auditQualityScenario(browser, fixture, scenario, timeoutMs, qualityPolicy)
{
    const context = await browser.newContext(contextOptions(scenario, fixture));
    try
    {
        await context.addCookies([{
            name: qualityPolicy.localePreferenceCookieName,
            value: scenario.locale,
            url: fixture.baseUrl,
            httpOnly: true,
            sameSite: 'Lax'
        }]);
        await context.addInitScript(({ theme }) =>
        {
            globalThis.localStorage.setItem('fsus:theme-mode', theme);
        }, { theme: scenario.theme });
        const page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);
        page.setDefaultNavigationTimeout(timeoutMs);
        const audit = createPageAudit(page);
        const response = await page.goto(publicPreviewRoute(scenario, fixture), { waitUntil: 'domcontentloaded' });
        await applyPublicPreviewZoom(page, scenario.zoom ?? 1);
        const headerSamples = [await measurePublicPreviewHeader(page, 'domcontentloaded')];
        if (!response?.ok())
        {
            throw new BrowserContractFailure(`${scenario.id} returned ${response?.status() ?? 'no response'}`, 'product');
        }
        await waitForApplicationReady(page);
        headerSamples.push(await measurePublicPreviewHeader(page, 'application-ready'));
        await waitForVisualFrameReady(page);
        headerSamples.push(await measurePublicPreviewHeader(page, 'stable-frame'));
        audit.assertClean(`public-preview quality ${scenario.id}`);
        return await auditPublicPreviewPage(page, scenario, qualityPolicy, { headerSamples });
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
    operations.readRegistry();
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const registry = loadPublicPreviewRegistry(repositoryRoot);
    await rm(stagingDirectory, { recursive: true, force: true });
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    for (const entry of registry.screenshots)
    {
        await captureEntry(browser, fixture, entry, stagingDirectory, timeoutMs, registry.qualityPolicy);
    }
    const qualityReports = [];
    for (const scenario of registry.qualityScenarios)
    {
        qualityReports.push(await auditQualityScenario(browser, fixture, scenario, timeoutMs, registry.qualityPolicy));
    }
    const qualityMatrix = createPublicPreviewQualityMatrix(qualityReports);
    await writePublicPreviewQualityMatrix(stagingDirectory, qualityMatrix);
    if (qualityMatrix.status !== 'pass')
    {
        throw new BrowserContractFailure('public-preview quality matrix failed', 'product', qualityMatrix);
    }
    const stagedQualityFile = path.join(path.dirname(stagingDirectory), 'public-preview-quality.json');
    writePublicPreviewQualityManifest(stagingDirectory, sourceCommit, repositoryRoot, stagedQualityFile);
    operations.writeManifest(stagingDirectory, sourceCommit);
    operations.verifyCapturedDirectory(stagingDirectory, evidenceFile);
    const quality = comparePublicPreviewQualityManifests(
        stagedQualityFile,
        path.join(repositoryRoot, 'docs/assets/visual-evidence/public-preview-quality.json'),
        evidenceFile,
        repositoryRoot
    );
    if (quality.errors.length > 0)
    {
        throw new BrowserContractFailure('public-preview quality evidence differs from the committed gallery', 'product', quality.errors);
    }
    return {
        ...quality.evidence,
        captureContextCount: registry.screenshots.length
    };
}
