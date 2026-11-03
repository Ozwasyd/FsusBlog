import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const frontend = path.join(root, 'src/frontend');
const { resolveRuntimeBrowserTimeoutPlan } = await import(path.join(root, 'tests/frontend/support/runtime-browser-timeout.mjs'));
const timeoutPlan = resolveRuntimeBrowserTimeoutPlan();
const actionTimeoutMs = Math.max(30_000, timeoutPlan.pageAuditTimeoutMs);
const navigationTimeoutMs = Math.max(30_000, timeoutPlan.navigationTimeoutMs);
const readinessTimeoutMs = Math.max(45_000, timeoutPlan.requestTimeoutMs * 2);
// Preserve the frontend-build lane's 20-minute budget in tests/matrix.yml.
const buildTimeoutMs = Math.max(20 * 60_000, timeoutPlan.stepDeadlineMs);
const require = createRequire(path.join(frontend, 'package.json'));
const { chromium } = require('playwright');
const { preview } = require('vite');
const [mode, output] = process.argv.slice(2);
if (!['local', 'published'].includes(mode) || !output)
{
    throw new Error('usage: node probe-article-image-lightbox.mjs local|published OUTPUT_DIRECTORY');
}
const destination = path.resolve(output);
fs.mkdirSync(destination, { recursive: true });
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: actionTimeoutMs }).trim();
const sha = git(root, 'rev-parse', 'HEAD');
const hash = (filename) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const report = {
    schema: 'fsusblog.article-image-lightbox-production-probe.v1',
    runId: `${new Date().toISOString()}-${process.pid}`,
    mode, sha, dirty: git(root, 'status', '--porcelain'),
    qualificationEligible: false,
    timeouts: { ...timeoutPlan, actionTimeoutMs, navigationTimeoutMs, readinessTimeoutMs, buildTimeoutMs },
    inputs: Object.fromEntries([
        'src/frontend/src/components/article/ArticleImageLightbox.vue',
        'src/frontend/src/composables/article/useArticleImageLightbox.ts',
        'tests/frontend/fixtures/articleLightboxProductionSurface.ts',
        'tests/frontend/checks/runtime/probe-article-image-lightbox.mjs'
    ].map((file) => [file, hash(path.join(root, file))])),
    checks: [],
    limitations: ['Isolated production article fixture, not the backend article route.', 'Chromium only; no independent UX, real-device or screen-reader acceptance.']
};
const check = (name, passed, evidence = {}) =>
{
    report.checks.push({ name, status: passed ? 'passed' : 'failed', evidence });
    console.log(`[article-viewer-probe] ${passed ? 'passed' : 'failed'}: ${name}`);
};
let server;
let browser;
let page;
const errors = [];
try
{
    process.env.FSUSBLOG_USE_LOCAL_FSUSUI = mode === 'local' ? '1' : '0';
    const { resolveLocalFsusUiRepositoryRoot } = await import(path.join(frontend, 'scripts/fsusui-root.mjs'));
    const upstream = resolveLocalFsusUiRepositoryRoot({
        repositoryRoot: root,
        override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT
    });
    if (mode === 'published' && !fs.existsSync(path.join(frontend, 'node_modules/@ozwasyd/element-plus/package.json')))
    {
        throw new Error('Exact locked published artifact is unavailable; no local-source fallback permitted');
    }
    if (mode === 'published')
    {
        const locked = JSON.parse(fs.readFileSync(path.join(frontend, 'package-lock.json'))).packages['node_modules/@ozwasyd/element-plus'];
        const manifest = path.join(frontend, 'node_modules/@ozwasyd/element-plus/package.json');
        const installed = JSON.parse(fs.readFileSync(manifest));
        const installedRoot = fs.realpathSync(path.dirname(manifest));
        if (installed.version !== locked.version || installedRoot.startsWith(upstream))
        {
            throw new Error('Published artifact identity mismatch; local source is not a published package');
        }
        report.fsusui = { locked, installed: installed.version, manifestDigest: hash(manifest), installedRoot };
    }
    if (mode === 'local')
    {
        report.fsusui = { root: upstream, sha: git(upstream, 'rev-parse', 'HEAD'), dirty: git(upstream, 'status', '--porcelain'), css: hash(path.join(upstream, 'vue/packages/theme-chalk/dist/index.css')) };
    }
    const buildId = `${new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)}-${sha.slice(0, 12)}`;
    report.buildId = buildId;
    execFileSync(process.execPath, [path.join(frontend, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.article-lightbox-production.config.ts', '--logLevel', 'warn'], {
        cwd: frontend, env: { ...process.env, VITE_FSUSBLOG_BUILD_ID: buildId },
        timeout: buildTimeoutMs, killSignal: 'SIGKILL',
        stdio: ['ignore', fs.openSync(path.join(destination, 'build.log'), 'w'), fs.openSync(path.join(destination, 'build-errors.log'), 'w')]
    });
    const documentPath = '/assets/__issue2379_lightbox_manual/test-fixtures/article-lightbox-production-surface.html';
    report.documentDigest = hash(path.join(frontend, 'dist', documentPath));
    server = await preview({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), preview: { host: '127.0.0.1', port: 0 }, plugins: [{
        name: 'article-production-image-assets', configurePreviewServer(vite)
        {
            vite.middlewares.use((request, response, next) =>
            {
                if (!request.url?.startsWith('/fixtures/'))
                {
                    return next();
                }
                const filename = path.join(frontend, 'public/fixtures', path.basename(request.url));
                if (!fs.existsSync(filename))
                {
                    return next();
                }
                response.setHeader('Content-Type', 'image/svg+xml');
                response.end(fs.readFileSync(filename));
            });
        }
    }] });
    browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_PROBE_CHROMIUM ?? '/usr/bin/chromium', headless: true, timeout: Math.max(30_000, timeoutPlan.requestTimeoutMs), args: ['--no-sandbox'] });
    report.browser = browser.version();
    page = await browser.newPage({ viewport: { width: 375, height: 844 }, hasTouch: true });
    page.setDefaultTimeout(actionTimeoutMs);
    page.setDefaultNavigationTimeout(navigationTimeoutMs);
    page.on('console', (message) =>
    {
        if (message.type() === 'error')
        {
            errors.push(message.text());
        }
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    const address = server.httpServer.address();
    await page.goto(`http://127.0.0.1:${address.port}${documentPath}`);
    await page.waitForFunction(() => globalThis.document.documentElement.dataset.articleLightboxProductionSurfaceReady === 'true', null, { timeout: readinessTimeoutMs });
    const trigger = page.locator('[data-article-lightbox-production-content] img').first();
    const dialog = page.getByRole('dialog', { name: '查看大图', exact: true });
    const close = () => dialog.getByRole('button', { name: '关闭大图', exact: true });
    const open = async () =>
    {
        await trigger.click();
        await dialog.waitFor();
        await page.waitForTimeout(350);
    };
    await open();
    check('single public dialog and article caption', await dialog.count() === 1 && await dialog.locator('[data-article-lightbox-caption]').textContent() === 'First geometry image');
    check('navigation-only localized controls', await dialog.getByRole('button').count() === 3);
    await dialog.locator('img:visible').click();
    await dialog.locator('[data-article-lightbox-caption]').click();
    check('image and caption are not dismissal controls', await dialog.count() === 1);
    await page.mouse.click(5, 5);
    await page.waitForTimeout(350);
    check('backdrop click dismisses through public viewer', await dialog.count() === 0);
    if (await dialog.count() === 0)
    {
        await open();
    }

    const initialScroll = await page.evaluate(() => globalThis.window.scrollY);
    check('modal entry and background inert', await page.evaluate(() => globalThis.document.activeElement?.getAttribute('role') === 'dialog' && Boolean(globalThis.document.querySelector('[data-article-lightbox-production-content]')?.closest('[inert]'))));
    await page.keyboard.press('Shift+Tab');
    check('keyboard focus trap', await dialog.evaluate((element) => element.contains(globalThis.document.activeElement)));
    await page.mouse.wheel(0, 250);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(350);
    check('background scroll locked', await page.evaluate(() => globalThis.window.scrollY) === initialScroll);
    await dialog.getByRole('button', { name: '下一张', exact: true }).tap();
    check('touch next preserves article alt/caption', await dialog.locator('img:visible').getAttribute('alt') === 'Second geometry image' && await dialog.locator('[data-article-lightbox-caption]').textContent() === 'Second geometry image');
    await dialog.getByRole('button', { name: '下一张', exact: true }).tap();
    check('two-image circular next intent', await dialog.locator('img:visible').getAttribute('alt') === 'First geometry image');
    await dialog.focus();
    await page.keyboard.press('ArrowLeft');
    check('keyboard circular previous intent', await dialog.locator('img:visible').getAttribute('alt') === 'Second geometry image');
    const { SAFE_AREA_PROFILES } = await import(path.join(upstream, 'scripts/safe-area-profiles.mjs'));
    const profiles = [{ ...SAFE_AREA_PROFILES['no-inset'], id: 'requested-375x844', viewport: { width: 375, height: 844 } }, ...Object.values(SAFE_AREA_PROFILES)];
    for (const theme of ['light', 'dark'])
    {
        await page.evaluate((value) => globalThis.document.documentElement.classList.toggle('dark', value === 'dark'), theme);
        for (const reducedMotion of ['no-preference', 'reduce'])
        {
            await page.emulateMedia({ reducedMotion });
            for (const profile of profiles)
            {
                await page.setViewportSize(profile.viewport);
                await page.evaluate((insets) => Object.entries(insets).forEach(([side, value]) => globalThis.document.documentElement.style.setProperty(`--fsus-safe-area-inset-${side}`, `${value}px`)), profile.insets);
                await page.waitForTimeout(50);
                const metrics = await dialog.evaluate((element) =>
                {
                    const rect = (node) =>
                    {
                        const b = node.getBoundingClientRect();
                        return { x: b.x, y: b.y, width: b.width, height: b.height, reachable: node.contains(globalThis.document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)) };
                    };
                    return { controls: [...element.querySelectorAll('[role="button"]')].map(rect), media: rect([...element.querySelectorAll('img')].find(image => globalThis.getComputedStyle(image).display !== 'none')), caption: rect(element.querySelector('[data-article-lightbox-caption]')) };
                });
                const { width, height } = profile.viewport;
                const { top, right, bottom, left } = profile.insets;
                const inside = (box) => box.width > 0 && box.height > 0 && box.x >= left && box.y >= top && box.x + box.width <= width - right + 0.5 && box.y + box.height <= height - bottom + 0.5;
                check(`${theme}/${reducedMotion}/${profile.id} safe geometry and reachability`, metrics.controls.every(box => inside(box) && box.width >= 44 && box.height >= 44 && box.reachable) && inside(metrics.media) && metrics.media.reachable && inside(metrics.caption) && metrics.caption.reachable, { profile, metrics });
            }
        }
        await page.screenshot({ path: path.join(destination, `${theme}.png`) });
    }
    await page.evaluate(() =>
    {
        globalThis.document.documentElement.style.zoom = '2';
    });
    const zoomed = await dialog.getByRole('button').evaluateAll(buttons => buttons.map(button =>
    {
        const box = button.getBoundingClientRect();
        return { width: box.width, height: box.height, reachable: button.contains(globalThis.document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
    }));
    check('200 percent CSS zoom controls reachable', zoomed.every(box => box.width >= 44 && box.height >= 44 && box.reachable), zoomed);
    await page.evaluate(() =>
    {
        globalThis.document.documentElement.style.zoom = '';
    });
    await page.emulateMedia({ forcedColors: 'active' });
    check('forced-colors dialog and named controls remain visible', await dialog.isVisible() && await close().isVisible());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    check('close restores original image focus and scroll', await dialog.count() === 0 && await trigger.evaluate(element => element === globalThis.document.activeElement) && await page.evaluate(() => globalThis.window.scrollY) === initialScroll);
    await page.emulateMedia({ forcedColors: 'none' });
    for (let index = 0;
        index < 3;
        index++)
    {
        await open();
        await close().tap();
        await page.waitForTimeout(350);
    }
    check('repeated cleanup releases inert and scroll ownership', await page.evaluate(() => !globalThis.document.querySelector('[inert]') && globalThis.getComputedStyle(globalThis.document.body).overflow !== 'hidden'));
    check('production JavaScript and CSP clean', !errors.some(error => /Content Security Policy|style-src-attr|TypeError|ReferenceError|hydration/iu.test(error)), { errors });
    report.status = report.checks.some(entry => entry.status === 'failed') ? 'failed' : 'passed';
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
            await page.screenshot({ path: path.join(destination, 'blocked.png'), timeout: actionTimeoutMs });
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
    await server?.httpServer.close();
    fs.writeFileSync(path.join(destination, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ status: report.status, blocker: report.blocker, passed: report.checks.filter(x => x.status === 'passed').length, failed: report.checks.filter(x => x.status === 'failed').length }));
}
