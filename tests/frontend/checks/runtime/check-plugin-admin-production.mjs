import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Real production component and CSS, with task-owned deferred API responses.
// This is a browser regression, not authenticated-route or published qualification.
const root = path.resolve(import.meta.dirname, '../../../..');
const frontend = path.join(root, 'src/frontend');
const require = createRequire(path.join(frontend, 'package.json'));
const { createFsusUiAliases, resolveLocalFsusUiRoot } = await import(pathToFileURL(path.join(frontend, 'scripts/fsusui-local.ts')).href);
const ui = resolveLocalFsusUiRoot(process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT);
assert.ok(ui, 'the actual local public FsusUI source is required');
const git = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (directory) => ({
    commit: git(directory, 'rev-parse', 'HEAD'),
    tree: git(directory, 'rev-parse', 'HEAD^{tree}'),
    status: git(directory, 'status', '--porcelain'),
    diffDigest: digest(git(directory, 'diff', 'HEAD', '--binary'))
});
const output = path.join(root, '.tmp/chain-1894', `plugin-admin-production-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
fs.mkdirSync(output, { recursive: true });
const report = {
    schema: 'fsusblog.plugin-admin-production-regression.v1',
    startedAt: new Date().toISOString(),
    source: identity(root),
    fsusui: identity(ui),
    componentDigest: digest(fs.readFileSync(path.join(frontend, 'src/views/admin/PluginAdmin.vue'))),
    checkerDigest: digest(fs.readFileSync(import.meta.filename)),
    themeAssets: ['index.css', 'el-fsus-theme.css'].map((name) => ({
        path: path.join(ui, 'vue/packages/theme-chalk/dist', name),
        sha256: digest(fs.readFileSync(path.join(ui, 'vue/packages/theme-chalk/dist', name)))
    })),
    controlledApi: true,
    qualificationEligible: false,
    browser: null,
    cases: [],
    status: 'running',
    limits: ['No real backend/authenticated route', 'No published package parity', 'No physical device or human screen reader', 'No independent UX acceptance']
};

const apiModule = `
const state = { overviews: [], details: [], errors: [] };
export function listPlugins() {
    return new Promise((resolve, reject) => state.overviews.push({ resolve, reject }));
}
export function getPlugin(id) {
    return new Promise((resolve, reject) => state.details.push({ id, resolve, reject }));
}
function rejectMutation() { throw new Error('Mutation/auth routes are outside this disposable regression'); }
export const installPlugin = rejectMutation, mutatePlugin = rejectMutation, ensureAdminSensitiveProof = rejectMutation;
export const confirmDanger = rejectMutation, confirmWarning = rejectMutation, toast = { success: rejectMutation };
export function showErrorToast(error, message) { state.errors.push({ error: error.message, message }); }
globalThis.pluginAdminProduction = state;
`;
const apiImports = ['@/api/authoring', '@/utils/errorPresentation', '@/composables/useAdminSensitiveProof', '@/fsusui/feedback'];
const controlledApi = {
    name: 'plugin-admin-production-controlled-api',
    enforce: 'pre',
    resolveId(id)
    {
        return id === 'virtual:plugin-admin-production-api' ? '\0plugin-admin-production-api' : null;
    },
    load(id)
    {
        return id === '\0plugin-admin-production-api' ? apiModule : null;
    },
    transform(code, id)
    {
        if (id === path.join(frontend, 'src/views/admin/PluginAdmin.vue'))
        {
            for (const specifier of apiImports)
            {
                code = code.replaceAll(`'${specifier}'`, "'virtual:plugin-admin-production-api'");
            }
            return code;
        }
        return null;
    }
};
fs.writeFileSync(path.join(output, 'index.html'), '<div id="app"></div><script type="module" src="/main.mjs"></script>');
fs.writeFileSync(path.join(output, 'probe.css'), `@import '@/assets/main.css';\n@source '${frontend}/src';\n`);
fs.writeFileSync(path.join(output, 'main.mjs'), `
import { createApp, nextTick } from 'vue';
import UI from '@ozwasyd/element-plus';
import PluginAdmin from '@/views/admin/PluginAdmin.vue';
import './probe.css';
const app = createApp(PluginAdmin);
app.use(UI);
app.mount('#app');
globalThis.pluginAdminProduction.flush = async () => {
    await nextTick();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};
globalThis.pluginAdminProduction.dispose = () => app.unmount();
`);

function overview(longContent)
{
    return {
        generatedAtUtc: '2026-10-08T00:00:00Z',
        currentNodeId: longContent ? 'disposable-node-'.repeat(24) : 'disposable-node',
        plugins: [0, 1].map((index) => ({
            pluginId: longContent ? `plugin-${index}-${'identifier-'.repeat(24)}` : `plugin-${index}`,
            name: longContent ? 'Duplicate 長いPlugin'.repeat(12) : 'Duplicate name',
            version: longContent ? `1.2.3+${'build'.repeat(32)}` : '1.2.3',
            runtime: longContent ? 'wasm-runtime-'.repeat(24) : 'wasm',
            installState: 'installed', healthState: 'healthy', enabled: false,
            installedAtUtc: '', updatedAtUtc: '', lastErrorCode: null,
            activeHookCount: 0, grantedCapabilityCount: 0, requestedCapabilityCount: 0, clusterConsistent: true
        }))
    };
}

function detail(summary, longContent, entry)
{
    return {
        summary,
        manifest: {
            pluginId: summary.pluginId, name: summary.name, version: summary.version, runtime: summary.runtime,
            runtimeEntry: entry, author: 'Author', hostVersionRange: '*',
            description: longContent ? 'unbroken-description-'.repeat(24) : 'Plugin description',
            requestedCapabilities: [], deniedRawPermissions: [], hooks: []
        },
        config: { value: {}, schema: {}, version: 1, updatedAtUtc: '', reloadState: 'ready' },
        permissions: [], nodes: [], recentErrors: [], recentExecutions: [], recentLogs: [],
        metrics: { averageDurationMilliseconds: 0, errorCount: 0, executionCount: 0, timeoutCount: 0 }
    };
}

async function checkBounds(page, item, state, rows)
{
    await page.evaluate(() => globalThis.pluginAdminProduction.flush());
    const observation = await page.evaluate(() =>
    {
        const layout = globalThis.document.querySelector('.plugin-admin-layout').getBoundingClientRect();
        const areas = [...globalThis.document.querySelectorAll('.plugin-admin-list, .plugin-admin-detail')].map((element) =>
        {
            const box = element.getBoundingClientRect();
            return { className: element.className, left: box.left, right: box.right, width: box.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
        });
        const metadata = [...globalThis.document.querySelectorAll('.plugin-admin-list__identity strong, .plugin-admin-list__identity small, .plugin-admin-list__status small')].map((element) =>
        {
            const range = globalThis.document.createRange();
            range.selectNodeContents(element);
            return { text: element.textContent, rectangles: [...range.getClientRects()].map((box) => ({ left: box.left, right: box.right })) };
        });
        return { viewport: globalThis.innerWidth, layout: { left: layout.left, right: layout.right, width: layout.width }, areas, metadata };
    });
    const result = { state, observation, status: 'running' };
    item.states.push(result);
    try
    {
        assert.ok(observation.layout.left >= 0 && observation.layout.right <= observation.viewport, 'product grid must fit the viewport');
        for (const area of observation.areas)
        {
            assert.ok(area.left >= observation.layout.left && area.right <= observation.layout.right,
                `${area.className} must fit its product grid after ${state}: right=${area.right}, available=${observation.layout.right}`);
            assert.ok(area.scrollWidth <= area.clientWidth + 1, `${area.className} must not mask horizontal content overflow`);
        }
        for (const metadata of observation.metadata)
        {
            for (const rectangle of metadata.rectangles)
            {
                assert.ok(rectangle.left >= observation.areas[0].left && rectangle.right <= observation.areas[0].right,
                    `all metadata text must fit without horizontal clipping after ${state}`);
            }
        }
        const list = page.getByRole('list', { name: '已安装插件', exact: true });
        assert.equal(await list.getByRole('button').count(), rows.length);
        for (const row of rows)
        {
            assert.ok((await list.textContent()).includes(row.name), 'plugin name is retained');
            assert.ok((await list.textContent()).includes(row.pluginId), 'plugin ID is retained');
            assert.ok((await list.textContent()).includes(row.version), 'plugin version is retained');
            assert.ok((await list.textContent()).includes(row.runtime), 'plugin runtime is retained');
            assert.ok((await list.textContent()).includes('Healthy'), 'health is retained');
        }
        result.status = 'passed';
    }
    catch (error)
    {
        result.status = 'failed';
        result.reason = error.message;
    }
}

async function resolveOverview(page, index, value)
{
    await page.waitForFunction((count) => globalThis.pluginAdminProduction.overviews.length > count, index);
    await page.evaluate(({ index, value }) => globalThis.pluginAdminProduction.overviews[index].resolve(value), { index, value });
    await page.evaluate(() => globalThis.pluginAdminProduction.flush());
}

async function resolveDetail(page, index, value)
{
    await page.waitForFunction((count) => globalThis.pluginAdminProduction.details.length > count, index);
    await page.evaluate(({ index, value }) => globalThis.pluginAdminProduction.details[index].resolve(value), { index, value });
    await page.getByText(value.manifest.runtimeEntry, { exact: true }).filter({ visible: true }).first().waitFor();
    await page.evaluate(() => globalThis.pluginAdminProduction.flush());
}

let server;
let browser;
try
{
    const { createServer } = require('vite');
    const vue = require('@vitejs/plugin-vue').default;
    const jsx = require('@vitejs/plugin-vue-jsx').default;
    const { default: tailwind } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
    server = await createServer({
        configFile: false, root: output, plugins: [controlledApi, vue(), jsx(), tailwind()],
        optimizeDeps: { entries: ['main.mjs', path.join(frontend, 'src/views/admin/PluginAdmin.vue')] },
        resolve: {
            dedupe: ['vue'],
            alias: [...createFsusUiAliases(ui), { find: '@', replacement: path.join(frontend, 'src') },
                { find: '@wasm', replacement: path.join(frontend, 'wasm/web') },
                { find: /^vue$/, replacement: path.join(frontend, 'node_modules/vue') },
                { find: /^vue-router$/, replacement: path.join(frontend, 'node_modules/vue-router') }]
        },
        server: { host: '127.0.0.1', port: 0, fs: { allow: [root, ui] } }
    });
    await server.listen();
    await server.transformRequest('/main.mjs');
    await server.waitForRequestsIdle();
    browser = await require('@playwright/test').chromium.launch();
    report.browser = browser.version();
    for (const width of [375, 768, 1440])
    {
        for (const theme of ['light', 'dark'])
        {
            for (const longContent of [false, true])
            {
                const item = { width, theme, longContent, states: [], status: 'running' };
                report.cases.push(item);
                const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
                const pageErrors = [];
                page.on('pageerror', (error) => pageErrors.push(error.message));
                try
                {
                    const snapshot = overview(longContent);
                    const entry = `entry-${width}-${theme}-${longContent}`;
                    await page.goto(server.resolvedUrls.local[0]);
                    await page.getByText('正在读取插件列表…', { exact: true }).waitFor();
                    await page.evaluate((theme) => globalThis.document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
                    await page.evaluate(() => globalThis.document.fonts.ready);
                    await checkBounds(page, item, 'overview-loading', []);
                    await resolveOverview(page, 0, snapshot);
                    const list = page.getByRole('list', { name: '已安装插件', exact: true });
                    const buttons = list.getByRole('button');
                    await page.waitForFunction(() => globalThis.pluginAdminProduction.details.length === 1);
                    assert.equal(await buttons.first().isDisabled(), true);
                    assert.equal(await buttons.last().isDisabled(), false);
                    await checkBounds(page, item, 'default-detail-loading', snapshot.plugins);
                    await resolveDetail(page, 0, detail(snapshot.plugins[0], longContent, entry));
                    assert.equal(await buttons.first().isDisabled(), false);
                    await checkBounds(page, item, 'detail-resolved', snapshot.plugins);
                    await page.screenshot({ path: path.join(output, `${width}-${theme}-${longContent ? 'long' : 'normal'}-detail.png`), fullPage: true, animations: 'disabled' });
                    await buttons.last().focus();
                    await page.keyboard.press('Enter');
                    await page.waitForFunction(() => globalThis.pluginAdminProduction.details.length === 2);
                    assert.equal(await buttons.last().getAttribute('aria-current'), 'true');
                    assert.equal(await buttons.last().isDisabled(), true);
                    assert.equal(await buttons.first().isDisabled(), false);
                    assert.equal(await page.evaluate(() => globalThis.pluginAdminProduction.details[1].id), snapshot.plugins[1].pluginId);
                    await checkBounds(page, item, 'keyboard-selection-loading', snapshot.plugins);
                    await page.evaluate(() => globalThis.pluginAdminProduction.details[1].reject(new Error('Controlled detail failure')));
                    await page.waitForFunction(() => globalThis.pluginAdminProduction.errors.length === 1);
                    await page.evaluate(() => globalThis.pluginAdminProduction.flush());
                    assert.equal(await buttons.last().isDisabled(), false);
                    await checkBounds(page, item, 'detail-error', snapshot.plugins);
                    await buttons.first().focus();
                    await page.keyboard.press('Enter');
                    await resolveDetail(page, 2, detail(snapshot.plugins[0], longContent, `${entry}-recovered`));
                    await checkBounds(page, item, 'selection-recovered', snapshot.plugins);
                    await page.getByRole('button', { name: '刷新', exact: true }).click();
                    await page.waitForFunction(() => globalThis.pluginAdminProduction.overviews.length === 2);
                    assert.equal(await list.getAttribute('aria-busy'), 'true');
                    assert.equal(await buttons.first().isDisabled(), true);
                    assert.equal(await buttons.last().isDisabled(), true);
                    await checkBounds(page, item, 'refresh-loading', snapshot.plugins);
                    await page.evaluate(() => globalThis.pluginAdminProduction.overviews[1].reject(new Error('Controlled overview failure')));
                    await page.getByText('插件列表加载失败', { exact: true }).waitFor();
                    await checkBounds(page, item, 'overview-error', snapshot.plugins);
                    assert.equal(await buttons.first().isDisabled(), false);
                    await page.getByRole('button', { name: '刷新', exact: true }).click();
                    await resolveOverview(page, 2, { ...snapshot, plugins: [] });
                    await page.getByText('尚未安装插件', { exact: true }).waitFor();
                    await checkBounds(page, item, 'empty-recovery', []);
                    await page.getByRole('button', { name: '刷新', exact: true }).click();
                    await page.waitForFunction(() => globalThis.pluginAdminProduction.overviews.length === 4);
                    await page.evaluate(() =>
                    {
                        globalThis.pluginAdminProduction.dispose();
                        globalThis.pluginAdminProduction.overviews[3].reject(new Error('Disposed overview failure'));
                    });
                    await page.evaluate(() => globalThis.pluginAdminProduction.flush());
                    assert.equal(await page.evaluate(() => globalThis.pluginAdminProduction.errors.length), 2);
                    assert.deepEqual(pageErrors, []);
                    item.status = item.states.every((state) => state.status === 'passed') ? 'passed' : 'failed';
                }
                catch (error)
                {
                    item.status = 'failed';
                    item.reason = error.stack;
                }
                finally
                {
                    item.pageErrors = pageErrors;
                    await page.close();
                }
            }
        }
    }
    report.status = report.cases.every((item) => item.status === 'passed') ? 'passed' : 'failed';
}
catch (error)
{
    report.status = 'failed';
    report.reason = error.stack;
}
finally
{
    await browser?.close();
    await server?.close();
    report.completedAt = new Date().toISOString();
    report.sourceAfter = identity(root);
    report.fsusuiAfter = identity(ui);
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`[plugin-admin-production] ${report.status}: ${path.join(output, 'report.json')}`);
for (const item of report.cases)
{
    console.log(`${item.width}/${item.theme}/${item.longContent ? 'long' : 'normal'}: ${item.status}; ${item.states.filter((state) => state.status === 'failed').map((state) => `${state.state}: ${state.reason}`).join('; ')}${item.reason ?? ''}`);
}
if (report.status !== 'passed')
{
    process.exitCode = 1;
}
