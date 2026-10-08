import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Diagnostic public-capability probe only. Failures must block the cutover;
// this runner never substitutes for production-fixture or independent UX acceptance.
const root = path.resolve(import.meta.dirname, '../../../..');
const frontend = path.join(root, 'src/frontend');
const { createFsusUiAliases, resolveLocalFsusUiRoot } = await import(pathToFileURL(path.join(frontend, 'scripts/fsusui-local.ts')).href);
const fixture = path.join(root, 'tests/frontend/fixtures/pluginCollectionProbe');
const require = createRequire(path.join(frontend, 'package.json'));
const mode = process.argv[2] ?? 'both';
assert.ok(['local', 'published', 'both'].includes(mode), 'usage: node check-plugin-collection-probe.mjs [local|published|both]');
const candidateScope = process.argv[3] ?? 'all';
assert.ok(['all', 'data-list', 'responsive-collection', 'menu'].includes(candidateScope), 'candidate must be all, data-list, responsive-collection or menu');
const candidates = candidateScope === 'all' ? ['data-list', 'responsive-collection', 'menu'] : [candidateScope];
const runId = `plugin-collection-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
const output = path.join(root, '.tmp/chain-1894', runId);
fs.mkdirSync(output, { recursive: true });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const runtimeFixture = path.join(output, 'fixture');
fs.mkdirSync(runtimeFixture);
const fixtureBootstrap = `<!doctype html>
<html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Plugin collection public API probe</title>
    </head>
    <body>
        <div id="app"></div>
        <script type="module" src="./main.ts"></script>
    </body>
</html>
`;
fs.writeFileSync(path.join(runtimeFixture, 'index.html'), fixtureBootstrap);
const runtimeFixtureFiles = fs.readdirSync(fixture).map((file) =>
{
    const bytes = fs.readFileSync(path.join(fixture, file));
    fs.writeFileSync(path.join(runtimeFixture, file), bytes);
    return { source: path.relative(root, path.join(fixture, file)), output: path.relative(root, path.join(runtimeFixture, file)), sha256: digest(bytes) };
});
const git = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
const identity = (directory) => ({
    root: directory,
    commit: git(directory, 'rev-parse', 'HEAD'),
    tree: git(directory, 'rev-parse', 'HEAD^{tree}'),
    status: git(directory, 'status', '--porcelain'),
    diffDigest: digest(git(directory, 'diff', 'HEAD', '--binary'))
});
const probeFiles = [
    path.relative(root, import.meta.filename),
    ...fs.readdirSync(fixture).map((file) => path.relative(root, path.join(fixture, file))),
    'src/frontend/src/fsusui/dataList.ts',
    'src/frontend/scripts/fsusui-local.ts',
    'src/frontend/scripts/fsusui-root.mjs'
];
const report = {
    schema: 'fsusblog.plugin-collection-capability-probe.v1',
    runId,
    startedAt: new Date().toISOString(),
    qualificationEligible: false,
    candidateScope,
    source: identity(root),
    fixtureBootstrap: { output: path.relative(root, path.join(runtimeFixture, 'index.html')), sha256: digest(fixtureBootstrap) },
    runtimeFixtureFiles,
    sourceFiles: probeFiles.map((file) => ({ path: file, sha256: digest(fs.readFileSync(path.join(root, file))) })),
    expectedTestBaseline: JSON.parse(fs.readFileSync(path.join(root, 'config/testing/fsusui-baseline.json'), 'utf8')),
    browser: null,
    modes: [],
    limits: [
        'Component consumer fixture; no backend or authenticated PluginAdmin route.',
        'Chromium accessibility tree observations; no human screen reader session.',
        'CSS zoom emulation; no browser chrome zoom or physical touch device.',
        'No formal independent UX acceptance or full matrix qualification.'
    ]
};
const playwright = require('playwright');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: vue } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href);
const { default: jsx } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue-jsx')).href);
let browser;

async function observe(results, id, action)
{
    try
    {
        const actual = await action();
        results.push({ id, status: 'passed', actual });
    }
    catch (error)
    {
        results.push({ id, status: 'failed', reason: error.message });
    }
}

async function configure(page, candidate, count, options = {})
{
    await page.evaluate((settings) => globalThis.pluginCollectionProbe.configure(settings), { candidate, count, ...options });
}

async function snapshot(page)
{
    return page.evaluate(() => globalThis.pluginCollectionProbe.snapshot());
}

async function capture(page, filename)
{
    await page.evaluate(async () =>
    {
        await globalThis.document.fonts.ready;
        await new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)));
    });
    await page.screenshot({ path: path.join(output, filename), fullPage: true, animations: 'disabled' });
}

async function probeCandidate(context, baseUrl, candidate, modeReport)
{
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() =>
    {
        const active = [];
        const add = EventTarget.prototype.addEventListener;
        const remove = EventTarget.prototype.removeEventListener;
        const capture = (options) => typeof options === 'boolean' ? options : Boolean(options?.capture);
        EventTarget.prototype.addEventListener = function(type, callback, options)
        {
            if ((this === globalThis || this === globalThis.document) && !active.some((entry) =>
                entry.target === this && entry.type === type && entry.callback === callback && entry.capture === capture(options)))
            {
                active.push({ target: this, type, callback, capture: capture(options) });
            }
            return add.call(this, type, callback, options);
        };
        EventTarget.prototype.removeEventListener = function(type, callback, options)
        {
            const index = active.findIndex((entry) => entry.target === this && entry.type === type
                && entry.callback === callback && entry.capture === capture(options));
            if (index >= 0)
            {
                active.splice(index, 1);
            }
            return remove.call(this, type, callback, options);
        };
        globalThis.probeGlobalListeners = () => active.map((entry) => ({
            target: entry.target === globalThis ? 'window' : 'document', type: entry.type
        }));
    });
    await page.goto(baseUrl);
    await page.waitForFunction(() => Boolean(globalThis.pluginCollectionProbe));
    const checks = [];
    const result = { candidate, checks, matrix: [] };
    modeReport.candidates.push(result);
    const collection = page.getByTestId('collection');
    const rowRole = candidate === 'menu' ? 'menuitem' : candidate === 'data-list' ? 'button' : 'listitem';
    const rows = () => collection.getByRole(rowRole);

    for (const count of [0, 1, 1000])
    {
        await observe(checks, `rows-${count}`, async () =>
        {
            await configure(page, candidate, count);
            assert.equal(await rows().count(), count);
            const state = await snapshot(page);
            assert.equal(new Set(state.ids).size, count);
            return { count, selectedId: state.selectedId, globalListeners: await page.evaluate(() => globalThis.probeGlobalListeners()) };
        });
    }

    await observe(checks, 'stable-key-and-duplicate-names', async () =>
    {
        await configure(page, candidate, 2);
        await rows().nth(1).click();
        assert.equal((await snapshot(page)).selectedId, 'plugin-1');
        await page.evaluate(() => globalThis.pluginCollectionProbe.reverse());
        assert.equal((await snapshot(page)).selectedId, 'plugin-1');
        assert.equal(await rows().first().getByText('plugin-1 · 1.2.3', { exact: true }).count(), candidate === 'responsive-collection' ? 0 : 1);
        return await snapshot(page);
    });
    await observe(checks, 'controlled-selection', async () =>
    {
        await configure(page, candidate, 2, { acceptSelection: false });
        await rows().nth(1).click();
        const state = await snapshot(page);
        assert.equal(state.activations.length, 1, 'primitive must emit activation through its public API');
        assert.equal(state.selectedId, 'plugin-0');
        const current = await rows().first().getAttribute('aria-current');
        const selected = await rows().first().getAttribute('aria-selected');
        const checked = await rows().first().getAttribute('aria-checked');
        assert.ok([current, selected, checked].includes('true'), 'controlled current/selected identity must remain accessible');
        return { state, current, selected, checked };
    });
    await observe(checks, 'keyboard-tab-enter-space', async () =>
    {
        await configure(page, candidate, 2);
        await page.evaluate(() =>
        {
            if (globalThis.document.activeElement instanceof globalThis.HTMLElement)
            {
                globalThis.document.activeElement.blur();
            }
        });
        await page.keyboard.press('Tab');
        assert.equal(await rows().first().evaluate((node) => node === globalThis.document.activeElement), true, 'first row must be reachable by keyboard');
        await page.keyboard.press('Tab');
        assert.equal(await rows().nth(1).evaluate((node) => node === globalThis.document.activeElement), true, 'second row must be reachable by keyboard');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        const state = await snapshot(page);
        assert.deepEqual(state.activations, ['plugin-1', 'plugin-1']);
        return state;
    });
    await observe(checks, 'accessible-interactive-selection', async () =>
    {
        await configure(page, candidate, 1);
        const ax = await context.newCDPSession(page);
        const tree = await ax.send('Accessibility.getFullAXTree');
        await ax.detach();
        fs.writeFileSync(path.join(output, `${modeReport.mode}-${candidate}-accessibility.json`), JSON.stringify(tree, null, 2));
        const row = tree.nodes.find((node) => node.name?.value?.includes('Duplicate plugin name')
            && ['button', 'option', 'radio', 'menuitem', 'menuitemradio'].includes(node.role?.value));
        assert.ok(row, 'row must expose an interactive role, not listitem');
        assert.ok(await rows().first().evaluate((node) =>
            ['aria-current', 'aria-selected', 'aria-checked', 'aria-pressed'].some((attribute) => node.getAttribute(attribute) === 'true')),
        'current/selected state must be accessible');
        return row;
    });
    await observe(checks, 'loading-suppresses-keyboard-activation', async () =>
    {
        await configure(page, candidate, 1, { state: 'loading' });
        await rows().first().focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        assert.equal((await snapshot(page)).activations.length, 0, 'loading row must reject activation from keyboard');
        assert.ok(await rows().first().evaluate((node) => node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true'), 'disabled/loading state must be accessible');
        return await snapshot(page);
    });
    await observe(checks, 'state-composition', async () =>
    {
        const observations = [];
        for (const state of ['ready', 'loading', 'error'])
        {
            await configure(page, candidate, 0, { state });
            const title = state === 'ready' ? '尚未安装插件' : state === 'loading' ? '正在读取插件列表…' : '插件列表加载失败';
            assert.ok(await collection.getByText(title, { exact: true }).count() > 0, `${state} must render public feedback content`);
            observations.push({ state, title });
        }
        return observations;
    });
    if (candidate === 'data-list')
    {
        await observe(checks, 'responsive-opt-in-and-single-owner', async () =>
        {
            await page.setViewportSize({ width: 375, height: 900 });
            const observations = [];
            for (const responsive of [false, true])
            {
                await configure(page, candidate, 1, { responsive });
                assert.equal(await collection.getByRole('list').count(), 1);
                assert.equal(await collection.getByRole('listitem').count(), 1);
                assert.equal(await rows().count(), 1);
                const cells = await rows().first().evaluate((node) => Array.from(node.children).map((cell) =>
                {
                    const box = cell.getBoundingClientRect();
                    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
                }));
                assert.equal(cells.length, 2);
                assert.ok(responsive ? cells[1].top >= cells[0].bottom - 1 : cells[1].left >= cells[0].right - 1,
                    'responsive layout must be opt-in, preserving a single row owner and cell source order');
                observations.push({ responsive, cells });
            }
            await page.setViewportSize({ width: 1440, height: 900 });
            return observations;
        });
        await observe(checks, 'public-disabled-and-loading-negative-controls', async () =>
        {
            const observations = [];
            for (const options of [{ disabled: true }, { disabledKeys: ['plugin-1'] }, { collectionLoading: true }])
            {
                await configure(page, candidate, 2, options);
                const row = rows().nth(1);
                assert.equal(await row.isDisabled(), true);
                assert.equal(await row.getAttribute('aria-disabled'), 'true');
                const box = await row.boundingBox();
                assert.ok(box);
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                await row.focus();
                await page.keyboard.press('Enter');
                await page.keyboard.press('Space');
                const prevented = await row.evaluate((node) => !node.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true })));
                assert.equal(prevented, true, 'synthetic events must also reach the public activation guard');
                assert.equal((await snapshot(page)).activations.length, 0);
                observations.push({ options, prevented, state: await snapshot(page) });
            }
            await configure(page, candidate, 2);
            await rows().nth(1).click();
            assert.equal((await snapshot(page)).selectedId, 'plugin-1');
            return { observations, recovery: await snapshot(page) };
        });
    }
    await observe(checks, 'repeated-mount-global-listener-cleanup', async () =>
    {
        await page.evaluate(() => globalThis.pluginCollectionProbe.unmount());
        const baseline = await page.evaluate(() => globalThis.probeGlobalListeners());
        const rounds = [];
        for (let round = 0; round < 3; round++)
        {
            await configure(page, candidate, 1000);
            const mountedListeners = await page.evaluate(() => globalThis.probeGlobalListeners());
            assert.ok(mountedListeners.length - baseline.length < 10, 'no global listener for every row');
            await page.evaluate(() => globalThis.pluginCollectionProbe.unmount());
            const terminal = await page.evaluate(() => globalThis.probeGlobalListeners());
            assert.deepEqual(terminal, baseline, 'unmount must release collection-owned global listeners');
            rounds.push({ mounted: mountedListeners.length, terminal: terminal.length });
        }
        return { baseline, rounds };
    });

    for (const width of [375, 768, 1440])
    {
        for (const theme of ['light', 'dark'])
        {
            await page.setViewportSize({ width, height: 900 });
            await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce', forcedColors: 'none' });
            await page.evaluate((value) => globalThis.document.documentElement.classList.toggle('dark', value === 'dark'), theme);
            for (const count of [0, 1, 1000])
            {
                await configure(page, candidate, count, { longId: true });
                const cell = { width, theme, count, checks: [] };
                result.matrix.push(cell);
                await observe(cell.checks, 'no-horizontal-overflow-and-fields', async () =>
                {
                    const dimensions = await collection.evaluate((node) => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
                    assert.ok(dimensions.scrollWidth <= dimensions.width + 1, 'collection must not overflow horizontally');
                    assert.equal(await rows().count(), count);
                    if (count)
                    {
                        const text = await rows().first().innerText();
                        for (const field of ['Duplicate plugin name', '-long-identity', '1.2.3', 'Healthy', 'wasm'])
                        {
                            assert.ok(text.includes(field), `missing ${field}`);
                        }
                        if (candidate === 'data-list')
                        {
                            const cells = await rows().first().evaluate((node) => Array.from(node.children).map((cell) =>
                            {
                                const box = cell.getBoundingClientRect();
                                return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
                            }));
                            assert.equal(cells.length, 2, 'identity and status must each remain in a public cell');
                            if ([375, 768].includes(width))
                            {
                                assert.ok(cells[1].top >= cells[0].bottom - 1, 'public responsive rows must stack cells on the narrow viewport');
                            }
                            else
                            {
                                assert.ok(cells[1].left >= cells[0].right - 1, 'wide rows must preserve column order');
                            }
                        }
                        await rows().last().scrollIntoViewIfNeeded();
                    }
                    return dimensions;
                });
            }
        }
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await page.emulateMedia({ forcedColors: 'active' });
    await configure(page, candidate, 2, { longId: true });
    await page.evaluate(() => globalThis.document.documentElement.style.zoom = '2');
    result.zoomAndForcedColors = await collection.evaluate((node) => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
    await capture(page, `${modeReport.mode}-${candidate}-375-zoom-forced-colors.png`);
    await page.evaluate(() => globalThis.document.documentElement.style.zoom = '1');
    await configure(page, candidate, 2);
    await page.keyboard.press('Tab');
    result.focus = await rows().first().evaluate((node) => ({
        focused: node === globalThis.document.activeElement,
        focusVisible: node.matches(':focus-visible'),
        outlineStyle: globalThis.getComputedStyle(node).outlineStyle,
        outlineWidth: globalThis.getComputedStyle(node).outlineWidth,
        box: { width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }
    }));
    await capture(page, `${modeReport.mode}-${candidate}-375-focus.png`);
    await observe(checks, 'forced-colors-focus-visible', async () =>
    {
        assert.equal(result.focus.focused, true, 'row must accept focus');
        assert.equal(result.focus.focusVisible, true, 'keyboard focus must be visible');
        assert.ok(result.focus.outlineStyle !== 'none' && Number.parseFloat(result.focus.outlineWidth) > 0,
            'forced colors removes box-shadow; keyboard focus needs a visible outline');
        return result.focus;
    });
    result.pageErrors = errors;
    assert.deepEqual(errors, [], 'component fixture must not have runtime errors');
    await page.close();
}

try
{
    browser = await playwright.chromium.launch({ headless: true });
    report.browser = { version: browser.version(), executablePath: playwright.chromium.executablePath() };
    for (const sourceMode of mode === 'both' ? ['local', 'published'] : [mode])
    {
        const modeReport = { mode: sourceMode, status: 'running', candidates: [] };
        report.modes.push(modeReport);
        let server;
        let context;
        try
        {
            const localRoot = sourceMode === 'local' ? resolveLocalFsusUiRoot(process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT) : null;
            if (sourceMode === 'local')
            {
                assert.ok(localRoot, 'local FsusUI checkout is required');
                modeReport.baseline = identity(localRoot);
                const manifest = path.join(localRoot, 'vue/packages/element-plus/package.json');
                modeReport.baseline.package = JSON.parse(fs.readFileSync(manifest, 'utf8'));
                modeReport.baseline.packageManifestDigest = digest(fs.readFileSync(manifest));
                modeReport.baseline.themeAssets = ['index.css', 'el-fsus-theme.css'].map((file) => ({
                    path: `vue/packages/theme-chalk/dist/${file}`,
                    sha256: digest(fs.readFileSync(path.join(localRoot, 'vue/packages/theme-chalk/dist', file)))
                }));
            }
            else
            {
                const manifest = path.join(frontend, 'node_modules/@ozwasyd/element-plus/package.json');
                assert.ok(fs.existsSync(manifest), 'published @ozwasyd/element-plus is not installed; no local fallback is permitted');
                const packageRoot = path.dirname(manifest);
                assert.equal(fs.realpathSync(packageRoot), packageRoot, 'published package must not be a local source link');
                const packageManifest = JSON.parse(fs.readFileSync(manifest, 'utf8'));
                const lockedPackage = JSON.parse(fs.readFileSync(path.join(frontend, 'package-lock.json'), 'utf8')).packages['node_modules/@ozwasyd/element-plus'];
                assert.equal(packageManifest.name, '@ozwasyd/element-plus', 'published package identity must be canonical FsusUI');
                assert.equal(packageManifest.version, lockedPackage.version, 'published package must match the lockfile');
                modeReport.baseline = { package: packageManifest, manifestDigest: digest(fs.readFileSync(manifest)) };
            }
            server = await createServer({
                configFile: false,
                root: runtimeFixture,
                plugins: [vue(), jsx()],
                resolve: {
                    dedupe: ['vue'],
                    alias: [
                        ...createFsusUiAliases(localRoot),
                        { find: '@', replacement: path.join(frontend, 'src') },
                        { find: /^vue$/, replacement: path.join(frontend, 'node_modules/vue') },
                        ...(sourceMode === 'published' ? [{ find: /^@ozwasyd\/element-plus(?=\/|$)/, replacement: path.join(frontend, 'node_modules/@ozwasyd/element-plus') }] : [])
                    ]
                },
                server: { host: '127.0.0.1', port: 0, fs: { allow: [root, ...(localRoot ? [localRoot] : [])] } }
            });
            await server.listen();
            const address = server.httpServer.address();
            assert.ok(address && typeof address === 'object');
            context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
            const identityPage = await context.newPage();
            await identityPage.goto(`http://127.0.0.1:${address.port}`);
            await identityPage.waitForFunction(() => Boolean(globalThis.pluginCollectionProbe));
            modeReport.publicComponents = await identityPage.evaluate(() => globalThis.pluginCollectionProbe.publicComponents);
            await identityPage.close();
            for (const candidate of candidates)
            {
                await probeCandidate(context, `http://127.0.0.1:${address.port}`, candidate, modeReport);
            }
            const touch = await browser.newContext({ viewport: { width: 375, height: 900 }, hasTouch: true });
            try
            {
                for (const candidate of candidates)
                {
                    await observe(modeReport.candidates.find((entry) => entry.candidate === candidate).checks, 'touch-activation', async () =>
                    {
                        const page = await touch.newPage();
                        try
                        {
                            await page.goto(`http://127.0.0.1:${address.port}`);
                            await page.waitForFunction(() => Boolean(globalThis.pluginCollectionProbe));
                            await configure(page, candidate, 2);
                            const role = candidate === 'menu' ? 'menuitem' : candidate === 'data-list' ? 'button' : 'listitem';
                            await page.getByTestId('collection').getByRole(role).nth(1).tap();
                            assert.equal((await snapshot(page)).selectedId, 'plugin-1');
                            const ready = await snapshot(page);
                            const disabled = [];
                            if (candidate === 'data-list')
                            {
                                for (const options of [{ state: 'loading' }, { disabled: true }, { disabledKeys: ['plugin-0'] }, { collectionLoading: true }])
                                {
                                    await configure(page, candidate, 2, options);
                                    const row = page.getByTestId('collection').getByRole(role).first();
                                    assert.equal(await row.isDisabled(), true);
                                    const box = await row.boundingBox();
                                    assert.ok(box);
                                    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
                                    assert.equal((await snapshot(page)).activations.length, 0);
                                    disabled.push({ options, state: await snapshot(page) });
                                }
                            }
                            return { ready, disabled };
                        }
                        finally
                        {
                            await page.close();
                        }
                    });
                }
            }
            finally
            {
                await touch.close();
            }
            const failed = modeReport.candidates.flatMap((candidate) => [
                ...candidate.checks,
                ...candidate.matrix.flatMap((cell) => cell.checks)
            ]).filter((check) => check.status === 'failed');
            modeReport.status = failed.length ? 'failed' : 'passed';
            modeReport.failureCount = failed.length;
        }
        catch (error)
        {
            modeReport.status = modeReport.candidates.length ? 'failed' : 'blocked';
            modeReport.reason = error.stack;
        }
        finally
        {
            await context?.close();
            await server?.close();
            if (sourceMode === 'local' && modeReport.baseline)
            {
                modeReport.baselineAfter = identity(modeReport.baseline.root);
                modeReport.baselineUnchanged = ['commit', 'tree', 'status', 'diffDigest'].every((key) =>
                    modeReport.baseline[key] === modeReport.baselineAfter[key])
                    && (modeReport.baseline.themeAssets ?? []).every((asset) =>
                        asset.sha256 === digest(fs.readFileSync(path.join(modeReport.baseline.root, asset.path))));
                if (!modeReport.baselineUnchanged)
                {
                    modeReport.status = 'failed';
                }
            }
        }
    }
}
catch (error)
{
    report.runtimeError = error.stack;
}
finally
{
    await browser?.close();
    report.finishedAt = new Date().toISOString();
    report.sourceAfter = identity(root);
    report.sourceUnchanged = JSON.stringify(report.source) === JSON.stringify(report.sourceAfter);
    report.artifacts = fs.readdirSync(output).filter((file) => file !== 'report.json' && fs.lstatSync(path.join(output, file)).isFile()).map((file) => ({
        path: file,
        sha256: digest(fs.readFileSync(path.join(output, file)))
    }));
    report.status = report.runtimeError || !report.sourceUnchanged || report.modes.some((entry) => entry.status === 'failed')
        ? 'failed' : report.modes.some((entry) => entry.status === 'blocked') ? 'blocked' : 'passed';
    if (report.runtimeError && !browser)
    {
        report.status = 'blocked';
    }
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[plugin-collection-probe] ${report.status}: ${path.join(output, 'report.json')}`);
    for (const entry of report.modes)
    {
        console.log(`${entry.mode}: ${entry.status} (${entry.failureCount ?? 0} failed assertions)`);
    }
    process.exitCode = report.status === 'failed' ? 1 : report.status === 'blocked' ? 2 : 0;
}
