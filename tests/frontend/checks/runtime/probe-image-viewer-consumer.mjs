import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Diagnostic prerequisite probe for #1892. Failures remain failures; this is
// neither product acceptance nor permission to patch the consumer's viewer.
// FSUSBLOG_PROBE_BROWSER selects chromium (default) or installed WebKit.
// FSUSBLOG_PROBE_FORCED_COLORS selects none (default) or browser-emulated active.
const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const frontendRoot = path.join(repositoryRoot, 'src/frontend');
const { resolveRuntimeBrowserTimeoutPlan } = await import(pathToFileURL(
    path.join(repositoryRoot, 'tests/frontend/support/runtime-browser-timeout.mjs')
).href);
const timeoutPlan = resolveRuntimeBrowserTimeoutPlan();
const actionTimeoutMs = Math.max(30_000, timeoutPlan.pageAuditTimeoutMs);
const navigationTimeoutMs = Math.max(30_000, timeoutPlan.navigationTimeoutMs);
const readinessTimeoutMs = Math.max(45_000, timeoutPlan.requestTimeoutMs * 2);
const require = createRequire(path.join(frontendRoot, 'package.json'));
const { renderToString } = require('@vue/server-renderer');
const { chromium, webkit } = require('playwright');
const { createServer } = require('vite');
const { resolveLocalFsusUiRepositoryRoot } = await import(pathToFileURL(
    path.join(frontendRoot, 'scripts/fsusui-root.mjs')
).href);
const args = process.argv.slice(2);
const mode = args[0];
const browserEngine = process.env.FSUSBLOG_PROBE_BROWSER ?? 'chromium';
const forcedColors = process.env.FSUSBLOG_PROBE_FORCED_COLORS ?? 'none';
if (!['local', 'published'].includes(mode) || args.length !== 2)
{
    throw new Error('usage: node tests/frontend/checks/runtime/probe-image-viewer-consumer.mjs local|published OUTPUT_DIRECTORY');
}
const outputRoot = path.resolve(args[1]);
fs.mkdirSync(outputRoot, { recursive: true });
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (root, ...argv) => execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8', timeout: actionTimeoutMs }).trim();
const fixture = path.join(repositoryRoot, 'tests/frontend/fixtures/imageViewerConsumerProbe.ts');
const report = {
    schema: 'fsusblog.image-viewer-consumer-probe.v1',
    runId: `${new Date().toISOString()}-${process.pid}`,
    mode,
    browserEngine,
    forcedColors,
    forcedColorsEvidence: forcedColors === 'active' ? 'browser emulation; physical OS/device acceptance remains open' : 'default browser mode',
    blogSha: git(repositoryRoot, 'rev-parse', 'HEAD'),
    blogDirty: git(repositoryRoot, 'status', '--porcelain'),
    probeSha256: digest(fileURLToPath(import.meta.url)),
    fixtureSha256: digest(fixture),
    node: process.version,
    timeouts: { ...timeoutPlan, actionTimeoutMs, navigationTimeoutMs, readinessTimeoutMs },
    qualificationEligible: false,
    blogAuthorities: Object.fromEntries([
        '.agents/skills/fsusblog-design-conformance/SKILL.md',
        'docs/design/governance.md', 'docs/design/surface-profiles.md',
        'src/frontend/src/components/article/ArticleImageLightbox.vue',
        'src/frontend/src/composables/article/useArticleImageLightbox.ts'
    ].map((file) => [file, digest(path.join(repositoryRoot, file))])),
    checks: [],
    limitations: [
        'Diagnostic consumer fixture; no full article-route or independent UX acceptance.',
        'One browser engine does not establish other-engine, real-device or screen-reader acceptance.',
        'Published and local outcomes are independent; a missing published artifact is blocked.'
    ]
};
const check = (name, passed, evidence) =>
{
    const status = passed ? 'passed' : 'failed';
    report.checks.push({ name, status, evidence });
    console.log(`[image-viewer-probe] ${status}: ${name}`);
};
let server;
let browser;
let page;
const errors = [];
try
{
    if (!['chromium', 'webkit'].includes(browserEngine))
    {
        throw new Error(`unsupported browser engine: ${browserEngine}`);
    }
    if (!['none', 'active'].includes(forcedColors))
    {
        throw new Error(`unsupported forced-colors mode: ${forcedColors}`);
    }
    process.env.FSUSBLOG_USE_LOCAL_FSUSUI = mode === 'local' ? '1' : '0';
    const localRoot = mode === 'local' ? resolveLocalFsusUiRepositoryRoot({
        repositoryRoot,
        override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT
    }) : null;
    if (mode === 'local' && !localRoot)
    {
        throw new Error('local FsusUI source unavailable');
    }
    if (localRoot)
    {
        report.fsusui = {
            root: localRoot,
            sha: git(localRoot, 'rev-parse', 'HEAD'),
            dirty: git(localRoot, 'status', '--porcelain'),
            version: JSON.parse(fs.readFileSync(path.join(localRoot, 'vue/packages/element-plus/package.json'))).version,
            authorities: Object.fromEntries([
                '.agents/skills/fsusui-design-conformance/SKILL.md',
                'docs/design.md', 'docs/design/governance.md',
                'docs/design/change-classification.md', 'docs/workflows/visual-change.md',
                'docs/consumers/design-integration.md', 'docs/components/image-viewer.md',
                'docs/theme/tokens.md',
                'vue/packages/components/image-viewer/src/image-viewer.vue',
                'vue/packages/components/image-viewer/src/image-viewer.ts',
                'vue/packages/theme-chalk/dist/index.css',
                'vue/packages/theme-chalk/dist/el-fsus-theme.css'
            ].map((file) => [file, digest(path.join(localRoot, file))]))
        };
    }
    else
    {
        const locked = JSON.parse(fs.readFileSync(path.join(frontendRoot, 'package-lock.json')))
            .packages['node_modules/@ozwasyd/element-plus'];
        report.fsusui = { locked };
        const installed = path.join(frontendRoot, 'node_modules/@ozwasyd/element-plus/package.json');
        if (!fs.existsSync(installed))
        {
            throw new Error(`published package ${locked.version} is not installed; install the exact locked artifact with authorized registry access`);
        }
        report.fsusui.installed = JSON.parse(fs.readFileSync(installed)).version;
        report.fsusui.installedManifestSha256 = digest(installed);
        report.fsusui.installedRoot = fs.realpathSync(path.dirname(installed));
        if (report.fsusui.installed !== locked.version)
        {
            throw new Error('installed published version differs from lock');
        }
    }
    server = await createServer({
        root: frontendRoot,
        configFile: path.join(frontendRoot, 'vite.config.ts'),
        server: { host: '127.0.0.1', port: 0, open: false },
        plugins: [{
            name: 'image-viewer-consumer-probe-globalThis.document',
            configureServer(vite)
            {
                vite.middlewares.use(async (request, response, next) =>
                {
                    if (!request.url?.startsWith('/__image_viewer_probe'))
                    {
                        return next();
                    }
                    if (request.url.startsWith('/__image_viewer_probe_entry.js'))
                    {
                        response.setHeader('Content-Type', 'text/javascript');
                        response.end(`import { createImageViewerConsumerProbe } from '/@fs/${fixture}';
const parameters = new URLSearchParams(location.search);
const probe = createImageViewerConsumerProbe(parameters.get('open') === '1', parameters.get('control') === '1');
globalThis.window.__viewerConsumer = probe;
probe.app.mount('#app');`);
                        return;
                    }
                    if (request.url.startsWith('/__image_viewer_probe.css'))
                    {
                        response.setHeader('Content-Type', 'text/css');
                        response.end('[data-probe-article] { height: 2000px; }');
                        return;
                    }
                    try
                    {
                        const open = request.url.includes('open=1');
                        const control = request.url.includes('control=1');
                        const context = {};
                        const module = await vite.ssrLoadModule(fixture);
                        const html = await renderToString(module.createImageViewerConsumerProbe(open, control).app, context);
                        const documentText = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="/__image_viewer_probe.css"></head><body><div id="app">${html}</div><div id="probe-teleports">${context.teleports?.['#probe-teleports'] ?? ''}</div>${context.teleports?.body ?? ''}<script type="module" src="/__image_viewer_probe_entry.js"></script></body></html>`;
                        response.setHeader('Content-Type', 'text/html');
                        response.end(documentText);
                    }
                    catch (error)
                    {
                        vite.ssrFixStacktrace(error);
                        response.statusCode = 500;
                        response.end(String(error));
                    }
                });
            }
        }]
    });
    await server.listen();
    const address = server.httpServer.address();
    const url = `http://127.0.0.1:${address.port}/__image_viewer_probe`;
    const browserType = browserEngine === 'webkit' ? webkit : chromium;
    browser = await browserType.launch({
        ...(browserEngine === 'chromium' ? {
            executablePath: process.env.FSUSBLOG_PROBE_CHROMIUM ?? '/usr/bin/chromium',
            args: ['--no-sandbox']
        } : {}),
        headless: true,
        timeout: Math.max(30_000, timeoutPlan.requestTimeoutMs)
    });
    report.browser = browser.version();
    const context = await browser.newContext({ viewport: { width: 375, height: 844 }, hasTouch: true, forcedColors });
    context.setDefaultTimeout(actionTimeoutMs);
    context.setDefaultNavigationTimeout(navigationTimeoutMs);
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) =>
    {
        if (['warning', 'error'].includes(message.type()))
        {
            errors.push(message.text());
        }
    });
    const settle = () => page.waitForFunction(() => Boolean(globalThis.window.__viewerConsumer), null, { timeout: readinessTimeoutMs });
    const open = async () =>
    {
        if (!page.url().startsWith(url))
        {
            await page.goto(url);
            await settle();
        }
        else
        {
            await page.evaluate(() => globalThis.window.__viewerConsumer.reset());
            await page.waitForTimeout(350);
        }
        await page.evaluate(() => globalThis.window.scrollTo(0, 0));
        await page.getByRole('button', { name: 'Open article image' }).click();
        await page.waitForTimeout(350);
        if (await page.locator('img').count() !== 2)
        {
            throw new Error('consumer fixture did not open its two-image list');
        }
    };
    const snapshot = () => page.evaluate(() => globalThis.window.__viewerConsumer.snapshot());
    const activeImage = () => page.locator('img').evaluateAll((images) => images
        .filter((image) => globalThis.getComputedStyle(image).display !== 'none')
        .map((image) => ({ src: image.getAttribute('src'), alt: image.getAttribute('alt') })));
    await open();
    if (forcedColors === 'active')
    {
        const active = await page.evaluate(() => globalThis.matchMedia('(forced-colors: active)').matches);
        check('browser-emulated forced colors active', active, { mode: forcedColors, emulated: true });
    }
    check('SSR closed hydration', !errors.some((error) => /hydration|mismatch/iu.test(error)), {});
    report.publicApi = await snapshot();
    const dialogCount = await page.getByRole('dialog', { name: '查看大图' }).count();
    check('dialog semantics and localized label', dialogCount === 1, { dialogCount });
    const initial = await activeImage();
    check('image alternative text', initial[0]?.alt === 'First figure', initial);
    check('caption slot', await page.locator('[data-probe-caption]').textContent() === 'First figure', {
        text: await page.locator('[data-probe-caption]').textContent(),
        association: await page.getByRole('dialog').getAttribute('aria-describedby')
    });
    check('caption semantic association', await page.getByRole('dialog').evaluate((element) =>
    {
        const ids = (element.getAttribute('aria-describedby') ?? '').split(' ');
        return ids.some((id) => globalThis.document.getElementById(id)?.textContent?.includes('First figure'));
    }), {});
    const names = ['关闭大图', '上一张', '下一张'];
    const namedControls = await Promise.all(names.map((name) => page.getByRole('button', { name, exact: true }).count()));
    check('custom accessible control labels', namedControls.every((count) => count === 1), { names, counts: namedControls });
    check('focus entry', await page.evaluate(() => globalThis.document.activeElement?.contains(globalThis.document.querySelector('img'))), {});
    await page.keyboard.press('Shift+Tab');
    const escapedFocus = await page.evaluate(() => ({ id: globalThis.document.activeElement?.id, tag: globalThis.document.activeElement?.tagName }));
    check('focus trap', !['probe-trigger', 'probe-background'].includes(escapedFocus.id) && escapedFocus.tag !== 'BODY', escapedFocus);
    await page.evaluate(() => globalThis.document.getElementById('probe-background').focus());
    check('background inert', await page.evaluate(() => globalThis.document.activeElement?.id !== 'probe-background'), {});
    await page.evaluate(() => globalThis.window.scrollTo(0, 100));
    const scrollBefore = await page.evaluate(() => globalThis.window.scrollY);
    await page.mouse.move(180, 700);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(150);
    const scrollAfter = await page.evaluate(() => globalThis.window.scrollY);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(350);
    const scrollAfterKeyboard = await page.evaluate(() => globalThis.window.scrollY);
    const overflow = await page.evaluate(() => ({ body: globalThis.getComputedStyle(globalThis.document.body).overflow, html: globalThis.getComputedStyle(globalThis.document.documentElement).overflow }));
    check('body scroll lock', scrollBefore === scrollAfter && scrollBefore === scrollAfterKeyboard && ['hidden', 'clip'].includes(overflow.body), { scrollBefore, scrollAfter, scrollAfterKeyboard, overflow });
    await open();
    await page.evaluate(() => globalThis.window.__viewerConsumer.setIndex(1));
    const controlled = await activeImage();
    check('controlled active-index update', controlled[0]?.src?.includes('Second'), controlled);
    await page.evaluate(() => globalThis.window.__viewerConsumer.setActiveItem(1));
    check('public setActiveItem synchronization', (await activeImage())[0]?.src?.includes('Second'), await activeImage());
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
    check('last boundary', (await snapshot()).index === 1, await snapshot());
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(100);
    const previous = await snapshot();
    check('keyboard navigation and switch event', previous.index === 0 && previous.events.some((event) => event.name === 'switch'), previous);
    await page.keyboard.press('ArrowLeft');
    check('first boundary', (await snapshot()).index === 0, await snapshot());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    const closed = await snapshot();
    const focusAfterClose = await page.evaluate(() => ({ id: globalThis.document.activeElement?.id, tag: globalThis.document.activeElement?.tagName, overflow: globalThis.getComputedStyle(globalThis.document.body).overflow }));
    check('Escape and close event', !closed.visible && closed.events.some((event) => event.name === 'close'), closed);
    check('focus return', focusAfterClose.id === 'probe-trigger', focusAfterClose);
    check('close cleanup', await page.locator('img').count() === 0 && focusAfterClose.overflow !== 'hidden', focusAfterClose);
    await open();
    // Public roles and measured hit areas; no private selectors or CSS repairs.
    const { SAFE_AREA_PROFILES } = await import(path.join(localRoot ?? resolveLocalFsusUiRepositoryRoot({ repositoryRoot }), 'scripts/safe-area-profiles.mjs'));
    const measureControls = () => page.getByRole('button').evaluateAll((buttons) => buttons
        .filter((button) => !button.id.startsWith('probe-'))
        .map((button) =>
        {
            const box = button.getBoundingClientRect();
            const topmost = globalThis.document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return { x: box.x, y: box.y, width: box.width, height: box.height, reachable: button.contains(topmost) };
        }));
    const reachableWithin = (bounds, profile) =>
    {
        const { width, height } = profile.viewport;
        const { top, right, bottom, left } = profile.insets;
        return bounds.length > 0 && bounds.every((box) => box.width >= 44 && box.height >= 44
            && box.x >= left && box.y >= top && box.x + box.width <= width - right
            && box.y + box.height <= height - bottom && box.reachable);
    };
    for (const theme of ['light', 'dark'])
    {
        await page.evaluate((value) => globalThis.document.documentElement.classList.toggle('dark', value === 'dark'), theme);
        for (const reducedMotion of ['no-preference', 'reduce'])
        {
            await page.emulateMedia({ reducedMotion });
            for (const profile of Object.values(SAFE_AREA_PROFILES))
            {
                await page.setViewportSize(profile.viewport);
                await page.evaluate((insets) =>
                {
                    for (const [side, value] of Object.entries(insets))
                    {
                        globalThis.document.documentElement.style.setProperty(`--fsus-safe-area-inset-${side}`, `${value}px`);
                    }
                }, profile.insets);
                await page.waitForTimeout(350);
                const bounds = await measureControls();
                check(`safe-area ${theme}/${reducedMotion}/${profile.id}`, reachableWithin(bounds, profile), { profile, bounds });
            }
        }
    }
    // Fault injection is confined to this diagnostic page and restored exactly.
    // Measure real DOM failures to prove that zero-area and escaping controls fail.
    const negativeProfile = SAFE_AREA_PROFILES['short-visual'];
    const negativeControl = page.getByRole('button', { name: '关闭大图', exact: true });
    const priorStyle = await negativeControl.getAttribute('style');
    try
    {
        for (const [name, transform] of [['zero-area', 'scale(0)'], ['safe-boundary escape', 'translateX(-1000px)']])
        {
            await negativeControl.evaluate((button, value) => button.style.setProperty('transform', value, 'important'), transform);
            const bounds = await measureControls();
            check(`geometry negative control: ${name}`, !reachableWithin(bounds, negativeProfile), { profile: negativeProfile, bounds });
        }
    }
    finally
    {
        await negativeControl.evaluate((button, value) =>
        {
            if (value === null)
            {
                button.removeAttribute('style');
            }
            else
            {
                button.setAttribute('style', value);
            }
        }, priorStyle);
    }
    const restoredBounds = await measureControls();
    check('geometry negative control restoration', reachableWithin(restoredBounds, negativeProfile), { profile: negativeProfile, bounds: restoredBounds });
    await page.evaluate(() => globalThis.document.documentElement.classList.remove('dark'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 375, height: 844 });
    await page.screenshot({ path: path.join(outputRoot, 'local-open.png') });
    await page.getByRole('button', { name: '下一张', exact: true }).tap();
    check('touch next and switch event', (await snapshot()).index === 1, await snapshot());
    await page.getByRole('button', { name: '上一张', exact: true }).tap();
    check('touch previous and switch event', (await snapshot()).index === 0, await snapshot());
    await page.getByRole('button', { name: '关闭大图', exact: true }).tap();
    await page.waitForTimeout(350);
    check('touch close', !(await snapshot()).visible, await snapshot());
    await open();
    await page.evaluate(() => globalThis.window.__viewerConsumer.setImages([{ src: '/__missing_probe_image.svg', alt: 'Failed figure' }]));
    await page.waitForTimeout(150);
    check('single image and load failure remains closable', await page.locator('img').count() === 1, await activeImage());
    await page.keyboard.press('Escape');
    check('load failure Escape close', !(await snapshot()).visible, await snapshot());
    await open();
    await page.evaluate(() => globalThis.window.__viewerConsumer.setImages([]));
    check('empty list remains dismissible', await page.locator('img').count() === 0 && await page.getByRole('button', { name: '关闭大图', exact: true }).count() === 1, await snapshot());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    check('empty list close cleanup', !(await snapshot()).visible && await page.getByRole('dialog').count() === 0, await snapshot());
    await open();
    const closeEventsBeforeUnmount = (await snapshot()).events.filter((event) => event.name === 'close').length;
    await page.evaluate(() => globalThis.window.__viewerConsumer.unmount());
    await page.waitForTimeout(350);
    check('interrupted unmount cleanup', await page.locator('img').count() === 0 && await page.evaluate(() => globalThis.getComputedStyle(globalThis.document.body).overflow !== 'hidden'), {});
    await page.keyboard.press('Escape');
    const closeEventsAfterUnmount = (await snapshot()).events.filter((event) => event.name === 'close').length;
    check('interrupted unmount listener cleanup', closeEventsAfterUnmount === closeEventsBeforeUnmount, { closeEventsBeforeUnmount, closeEventsAfterUnmount });
    const hydrationErrors = errors.length;
    await page.goto(`${url}?open=1`);
    await settle();
    await page.waitForTimeout(350);
    const hydratedImages = await page.locator('img').count();
    const newErrors = errors.slice(hydrationErrors);
    check('SSR open Teleport hydration', hydratedImages === 2 && !newErrors.some((error) => /hydration|mismatch/iu.test(error)), { hydratedImages, newErrors });
    const beforeControl = errors.length;
    await page.goto(`${url}?control=1`);
    await settle();
    await page.waitForTimeout(350);
    const controlErrors = errors.slice(beforeControl);
    check('SSR dedicated Teleport harness control', await page.locator('[data-probe-teleport-control]').count() === 1 && !controlErrors.some((error) => /hydration|mismatch/iu.test(error)), { controlErrors });
    check('CSP style attributes', !errors.some((error) => /style-src-attr/iu.test(error)), { errors: errors.filter((error) => /style-src-attr/iu.test(error)) });
    report.runtimeErrors = errors;
    report.status = report.checks.some((entry) => entry.status === 'failed') ? 'failed' : 'passed';
    process.exitCode = report.status === 'passed' ? 0 : 1;
}
catch (error)
{
    const timedOut = error.name === 'TimeoutError' || error.code === 'ETIMEDOUT';
    report.status = timedOut ? 'failed' : 'blocked';
    report.blocker = String(error);
    report.failure = { name: error.name, code: error.code, signal: error.signal, stack: error.stack };
    process.exitCode = timedOut ? 1 : 2;
    if (page)
    {
        try
        {
            fs.writeFileSync(path.join(outputRoot, 'blocked-document.html'), await page.content());
            await page.screenshot({ path: path.join(outputRoot, 'blocked.png'), timeout: actionTimeoutMs });
        }
        catch (artifactError)
        {
            report.artifactError = String(artifactError);
        }
    }
}
finally
{
    await browser?.close();
    await server?.close();
    report.runtimeErrors = errors;
    fs.writeFileSync(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ status: report.status, outputRoot, checks: report.checks.map(({ name, status }) => ({ name, status })), blocker: report.blocker }, null, 2));
}
