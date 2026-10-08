import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';


const root = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(root, '../../../../..');
const frontendRoot = path.join(repositoryRoot, 'src/frontend');
const frontendRequire = createRequire(path.join(frontendRoot, 'package.json'));
const { createServer } = await import(pathToFileURL(frontendRequire.resolve('vite')).href);
const { resolveLocalFsusUiRepositoryRoot } = await import(pathToFileURL(path.join(frontendRoot, 'scripts/fsusui-root.mjs')).href);
const evidenceRoot = process.env.FSUSBLOG_DRAFT_BROWSER_EVIDENCE || '/tmp/fsus-draft-boundaries-browser';
await fs.mkdir(evidenceRoot, { recursive: true });
const runDirectory = path.join(evidenceRoot, `run-${new Date().toISOString().replaceAll(':', '-')}`);
await fs.mkdir(runDirectory);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const uiRoot = resolveLocalFsusUiRepositoryRoot({ override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT, repositoryRoot });
if (!uiRoot)
{
    throw new Error('draft-boundaries-requires-real-local-fsusui');
}
const sourceRoot = process.env.FSUSBLOG_DRAFT_SOURCE_ROOT || repositoryRoot;
const sourceFiles = ['articleDocumentContext.ts', 'articleRenderCache.ts', 'articleFsusUiRenderProducer.ts', 'articleAnchorContext.ts'];
const sourceDigests = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file,
    createHash('sha256').update(await fs.readFile(path.join(sourceRoot, 'src/frontend/src/services/authoring', file))).digest('hex')])) );
const report = { source: { blogHead: git(sourceRoot, 'rev-parse', 'HEAD'), blogDirty: git(sourceRoot, 'status', '--short'),
    uiHead: git(uiRoot, 'rev-parse', 'HEAD'), uiDirty: git(uiRoot, 'status', '--short'), sourceDigests },
qualification: 'Actual Chromium, isolated owner/public-component consumer. No production preview route, published artifact, permission endpoint, native IME or formal UX acceptance.',
browserPath: 'Browser plugin not available; regular Playwright', results: [] };
report.runtimeResponses = [];
report.harnessDigests = Object.fromEntries(await Promise.all(['run-browser.mjs', 'harness.ts', 'vite.config.ts', 'index.html'].map(async file => [file,
    createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])) );
let server;
let browser;
const firstFailure = async (value) =>
{
    try
    {
        await fs.writeFile(path.join(evidenceRoot, 'first-failure.json'), JSON.stringify(value, null, 2), { flag: 'wx' });
    }
    catch (error)
    {
        if (error.code !== 'EEXIST')
        {
            throw error;
        }
    }
};
try
{
    // Isolated browser assets can be installed here without altering dependencies.
    process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(evidenceRoot, 'browsers');
    const { chromium } = frontendRequire('playwright');
    browser = await chromium.launch();
    report.browser = { version: browser.version(), executable: chromium.executablePath() };
    server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
    await server.listen();
    const url = 'http://127.0.0.1:4179/';
    const cases = [
        ['same-body-document-render-and-anchor-isolation', async page =>
        {
            await page.getByTestId('refresh').click();
            await page.getByTestId('preview').getByRole('heading', { name: 'Private draft boundary' }).waitFor();
            const before = await snapshot(page);
            assert.equal(before.receipt.status, 'committed');
            assert.match(before.retained.render.engine, /^(SIMD-128|SCALAR-BASIC)$/);
            await page.getByTestId('capture-anchor').click();
            await page.getByTestId('switch-document').click();
            const after = await snapshot(page);
            assert.equal(after.document.contentDigest, before.document.contentDigest);
            assert.notEqual(after.document.documentId, before.document.documentId);
            assert.equal(after.state.content, null);
            assert.equal(await page.getByTestId('preview').getByRole('heading').count(), 0);
            assert.equal((await page.evaluate(() => globalThis.draftBoundaryHarness.restoreAnchor())).reason, 'document-mismatch');
            await page.getByTestId('refresh').click();
            await page.getByTestId('preview').getByRole('heading', { name: 'Private draft boundary' }).waitFor();
            const rebuilt = await snapshot(page);
            assert.equal(rebuilt.state.content.context.documentId, after.document.documentId);
            assert.notEqual(rebuilt.state.content.result.resultRef, before.state.content.result.resultRef);
        }],
        ['cancel-late-real-render-retains-last-valid-view', async page =>
        {
            await page.getByTestId('refresh').click();
            await page.getByTestId('preview').getByRole('heading', { name: 'Private draft boundary' }).waitFor();
            const before = await snapshot(page);
            await page.getByTestId('update').click();
            await page.getByTestId('hold').click();
            await page.waitForFunction(() => globalThis.draftBoundaryHarness.snapshot().heldResult !== null);
            await page.getByTestId('cancel').click();
            await page.waitForFunction(() => globalThis.draftBoundaryHarness.snapshot().receipt.status === 'canceled');
            assert.equal((await snapshot(page)).state.content.result.resultRef, before.state.content.result.resultRef);
            await page.getByTestId('release').click();
            await page.waitForFunction(() => globalThis.draftBoundaryHarness.snapshot().heldResolved === false);
            assert.equal((await snapshot(page)).state.content.result.resultRef, before.state.content.result.resultRef);
            assert.equal(await page.getByTestId('preview').getByRole('heading', { name: 'Late private draft boundary' }).count(), 0);
        }],
        ['user-scope-switch-clears-body-receipts-and-late-delivery', async page =>
        {
            await page.getByTestId('refresh').click();
            await page.getByTestId('preview').getByRole('heading', { name: 'Private draft boundary' }).waitFor();
            await page.getByTestId('hold').click();
            await page.waitForFunction(() => globalThis.draftBoundaryHarness.snapshot().heldResult !== null);
            await page.getByTestId('switch-user').click();
            const switched = await snapshot(page);
            assert.equal(switched.state.content, null);
            assert.equal(switched.receipts.length, 0);
            assert.equal(switched.document.userScope, 'user:browser-b');
            await page.getByTestId('release').click();
            await page.waitForFunction(() => globalThis.draftBoundaryHarness.snapshot().heldResolved === false);
            assert.equal((await snapshot(page)).state.content, null);
            assert.equal(await page.getByTestId('preview').getByRole('heading').count(), 0);
        }],
        ['owner-disposal-clears-real-render-and-late-delivery', async page =>
        {
            await page.getByTestId('refresh').click();
            await page.getByTestId('preview').getByRole('heading', { name: 'Private draft boundary' }).waitFor();
            await page.getByTestId('hold').click();
            await page.waitForFunction(() => globalThis.draftBoundaryHarness.snapshot().heldResult !== null);
            await page.getByTestId('dispose-owner').click();
            await page.getByTestId('release').click();
            await page.waitForFunction(() => globalThis.draftBoundaryHarness.snapshot().heldResolved === false);
            assert.equal((await snapshot(page)).state.content, null);
            assert.equal((await snapshot(page)).receipts.length, 0);
            assert.equal(await page.getByTestId('preview').getByRole('heading').count(), 0);
        }]
    ];
    const snapshot = page => page.evaluate(() => globalThis.draftBoundaryHarness.snapshot());
    for (const [name, test] of cases)
    {
        const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, reducedMotion: 'reduce' });
        const diagnostics = [];
        const assetReads = [];
        page.on('response', response =>
        {
            if (/\.(?:wasm|mjs|js)(?:\?|$)/u.test(response.url()) && /(?:wasm|markdown_(?:basic|simd))/u.test(response.url()))
            {
                assetReads.push((async () =>
                {
                    try
                    {
                        const bytes = await response.body();
                        report.runtimeResponses.push({ case: name, url: response.url(), status: response.status(),
                            byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
                    }
                    catch (error)
                    {
                        report.runtimeResponses.push({ case: name, url: response.url(), status: response.status(), readError: error.message });
                    }
                })());
            }
        });
        page.on('pageerror', error => diagnostics.push({ type: 'pageerror', message: error.message }));
        page.on('console', message =>
        {
            if (['error', 'warning'].includes(message.type()))
            {
                diagnostics.push({ type: message.type(), message: message.text() });
            }
        });
        try
        {
            await page.goto(url);
            await page.waitForFunction(() => Boolean(globalThis.draftBoundaryHarness), { timeout: 30_000 });
            assert.equal(await page.title(), 'Draft preview boundary integration');
            assert.equal(page.url(), url);
            assert.match(await page.locator('main').innerText(), /Isolated real owner/);
            assert.equal(await page.locator('vite-error-overlay').count(), 0);
            await test(page);
            assert.deepEqual((await snapshot(page)).errors, []);
            assert.deepEqual(diagnostics, []);
            report.results.push({ name, status: 'pass', diagnostics });
            console.log(`PASS ${name}`);
        }
        catch (error)
        {
            let state = null;
            try
            {
                state = await snapshot(page);
            }
            catch (observationError)
            {
                state = { observationError: observationError.message };
            }
            const failure = { name, status: 'fail', error: error.stack, diagnostics, state };
            report.results.push(failure);
            await firstFailure({ source: report.source, ...failure });
            console.error(`FAIL ${name}: ${error.message}`);
        }
        finally
        {
            await page.screenshot({ path: path.join(runDirectory, `${name}.png`) });
            await fs.writeFile(path.join(runDirectory, `${name}.dom.html`), await page.content());
            await Promise.all(assetReads);
            await page.close();
        }
    }
    report.results.push({ name: 'production-permission-revocation', status: 'unrun',
        reason: 'No rights-revocation binding or permission endpoint in the tested owner slice. Owner disposal is tested separately and is not permission evidence.' });
}
catch (error)
{
    report.results.push({ name: 'browser-environment', status: 'fail', error: error.stack });
    await firstFailure({ source: report.source, name: 'browser-environment', error: error.stack });
    console.error(error.stack);
}
finally
{
    await browser?.close();
    await server?.close();
    await fs.writeFile(path.join(runDirectory, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`Evidence: ${runDirectory}`);
}
if (report.results.some(result => result.status === 'fail'))
{
    process.exitCode = 1;
}
