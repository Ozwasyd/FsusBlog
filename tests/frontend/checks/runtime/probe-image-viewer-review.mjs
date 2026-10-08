import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reviewer-supplied observations become real assertions. This remains a
// diagnostic local-source probe, not independent review or product acceptance.
const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const frontendRoot = path.join(repositoryRoot, 'src/frontend');
const require = createRequire(path.join(frontendRoot, 'package.json'));
const { chromium } = require('playwright');
const { createServer } = require('vite');
const { resolveLocalFsusUiRepositoryRoot } = await import(
    new URL('../../../../src/frontend/scripts/fsusui-root.mjs', import.meta.url)
);
const [scenario, outputDirectory] = process.argv.slice(2);
if (!['navigation', 'mode'].includes(scenario) || !outputDirectory || process.argv.length !== 4)
{
    throw new Error('usage: node tests/frontend/checks/runtime/probe-image-viewer-review.mjs navigation|mode OUTPUT_DIRECTORY');
}
const uiRoot = resolveLocalFsusUiRepositoryRoot({ repositoryRoot, override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT });
if (!uiRoot)
{
    throw new Error('local FsusUI source unavailable');
}
process.env.FSUSBLOG_USE_LOCAL_FSUSUI = '1';
process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT = uiRoot;
const fixture = path.join(repositoryRoot, `tests/frontend/fixtures/imageViewerReview${scenario === 'navigation' ? 'Navigation' : 'Mode'}.ts`);
const outputRoot = path.resolve(outputDirectory);
fs.mkdirSync(outputRoot, { recursive: true });
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30_000 }).trim();
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {
    schema: 'fsusblog.image-viewer-review-regression.v1',
    runId: `${new Date().toISOString()}-${process.pid}`, scenario,
    reviewer: '01a11b43-dfce-7607-812a-b610384e502d',
    originalRunnerSemantics: 'observation-only exit0; this runner adds actual assertions',
    blog: { root: repositoryRoot, sha: git(repositoryRoot, 'rev-parse', 'HEAD'), dirty: git(repositoryRoot, 'status', '--porcelain') },
    fsusui: { root: uiRoot, sha: git(uiRoot, 'rev-parse', 'HEAD'), dirty: git(uiRoot, 'status', '--porcelain') },
    fixtureSha256: digest(fixture), runnerSha256: digest(fileURLToPath(import.meta.url)),
    themeSha256: digest(path.join(uiRoot, 'vue/packages/theme-chalk/dist/el-fsus.css')),
    node: process.version, viewport: { width: 1024, height: 768 },
    qualificationEligible: false, checks: [], observations: {}, errors: [],
    limitations: ['Local diagnostic only; same independent reviewer must re-review.', 'Navigation opens the sibling Dialog programmatically; pointer return is not covered.', 'This mode fixture renders CSP-safe mode only; ordinary mode is separately exercised by the UI regression suite.']
};
const predicate = (name, actual, expected) =>
{
    try
    {
        assert.equal(actual, expected, name);
        report.checks.push({ name, status: 'passed' });
    }
    catch (error)
    {
        report.checks.push({ name, status: 'failed', error: error.message });
    }
};
let server;
let browser;
try
{
    server = await createServer({
        root: frontendRoot, configFile: path.join(frontendRoot, 'vite.config.ts'),
        server: { host: '127.0.0.1', port: 0, fs: { allow: [repositoryRoot, uiRoot] } },
        plugins: [{ name: 'image-viewer-review-harness', configureServer(vite)
        {
            vite.middlewares.use((request, response, next) =>
            {
                if (request.url !== '/__review')
                {
                    return next();
                }
                response.setHeader('Content-Type', 'text/html');
                response.end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`);
            });
        } }]
    });
    await server.listen();
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    report.browser = browser.version();
    const page = await browser.newPage({ viewport: report.viewport });
    page.on('pageerror', error => report.errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__review`);
    await page.waitForFunction(() => Boolean(globalThis.review));
    await page.locator('#opener').click();
    await page.waitForTimeout(400);
    const results = report.observations;
    if (scenario === 'navigation')
    {
        await page.evaluate(() => globalThis.review.longCaption());
        const caption = page.locator('[data-long-caption]').locator('..');
        const measure = () => caption.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight }));
        results.captionBefore = await measure();
        const bounds = await caption.boundingBox();
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + Math.min(20, bounds.height / 2));
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(300);
        results.captionAfter = await measure();
        await page.evaluate(() => globalThis.review.showNested());
        await page.waitForTimeout(400);
        results.nested = await page.locator('#nested-action').evaluate(element => ({ inert: Boolean(element.closest('[inert]')), focused: globalThis.document.activeElement?.getAttribute('aria-label') }));
        await page.locator('#nested-action').evaluate(element => element.focus());
        results.nestedFocusSucceeded = await page.locator('#nested-action').evaluate(element => element === globalThis.document.activeElement);
        predicate('overflowing caption control', results.captionBefore.scrollHeight > results.captionBefore.height, true);
        predicate('captionAfter.top > captionBefore.top', results.captionAfter.top > results.captionBefore.top, true);
        predicate('nested.inert === false', results.nested.inert, false);
        predicate('nestedFocusSucceeded === true', results.nestedFocusSucceeded, true);
    }
    else
    {
        const image = page.locator('img:visible');
        await image.evaluate(element => element.decode());
        const measure = () => image.evaluate(element => ({ naturalWidth: element.naturalWidth, width: element.getBoundingClientRect().width, maxWidth: globalThis.getComputedStyle(element).maxWidth, inlineMax: element.style.maxWidth }));
        results.before = await measure();
        await page.getByRole('button', { name: 'Toggle image size', exact: true }).click();
        await page.waitForTimeout(200);
        results.after = await measure();
        predicate('large intrinsic image control', results.before.naturalWidth, 2400);
        predicate('after.width > before.width', results.after.width > results.before.width, true);
    }
    predicate('no page errors', report.errors.length, 0);
    await page.screenshot({ path: path.join(outputRoot, 'rendered.png') });
    const failures = report.checks.filter(check => check.status === 'failed');
    assert.equal(failures.length, 0, `${failures.length} reviewer regression predicates failed`);
    report.status = 'passed';
}
catch (error)
{
    report.status = 'failed';
    report.failure = error.message;
    process.exitCode = 1;
}
finally
{
    await browser?.close();
    await server?.close();
    fs.writeFileSync(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
}
