import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createCompositionRun, createLocalCompositionBaseline } from '@fsusblog/layout-governance/composition-analyzer';
import { createCompositionIdentity, verifyCompositionIdentity } from '@fsusblog/layout-governance/composition-contracts';
import { analyzeCompositionDom, probeCompositionPage, verifyCompositionObservation } from '@fsusblog/layout-governance/composition-dom';
import { compositionProbePlugin, createCompositionSource } from '@fsusblog/layout-governance/composition-source';

// Isolated analyzer diagnostics. These generated fixtures are never production-page or UX acceptance.
const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const frontend = join(repositoryRoot, 'src/frontend');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'actual local public FsusUI source required');
const require = createRequire(join(frontend, 'package.json'));
const { chromium } = require('@playwright/test');
const vue = require('@vitejs/plugin-vue').default;
const jsx = require('@vitejs/plugin-vue-jsx').default;
const { createServer } = require('vite');
const { createFsusUiAliases } = await import(pathToFileURL(join(frontend, 'scripts/fsusui-local.ts')));
const runId = `composition-dom-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
const output = join(repositoryRoot, '.tmp/chain-1894', runId);
mkdirSync(output, { recursive: true });
const baseline = createLocalCompositionBaseline(fsusUIRoot);
const run = createCompositionRun({ repositoryRoot, fsusUIRoot, fsusUIBaselineIdentity: baseline, runId });
const archetype = run.inputs.matrix.archetypes.find((entry) => entry.surface === 'public' && entry.kind === 'document');
const runBinding = { worktree: run.worktree, analyzerDigest: run.analyzerDigest, fsusUIBaselineDigest: baseline.baselineDigest };
const report = { runId, diagnosticOnly: true, productAcceptance: false, fullVisualVerified: false,
    source: runBinding, fsusUIBaseline: baseline, cases: [], status: 'running' };
let server;
let browser;

const header = '<Header title="Current document" data-fsus-region="content-heading" data-fsus-owner="content-heading-owner" data-fsus-surface="document" data-fsus-material="flat"/>';
const action = '<button data-fsus-action="read-current-document" data-fsus-action-priority="primary">Read</button>';
const body = `<section data-fsus-region="document-content" data-fsus-owner="document-content-owner" data-fsus-content="document-content" data-fsus-surface="document" data-fsus-material="flat">${action}<p>Current content</p></section>`;
const context = '<aside data-fsus-region="document-context" data-fsus-owner="document-context-owner" data-fsus-surface="document" data-fsus-material="flat">Context</aside>';
const chrome = '<Toolbar data-fsus-region="shell-navigation" data-fsus-owner="shell-navigation-owner" data-fsus-chrome="navigation" data-fsus-surface="control-group" data-fsus-material="boundary"><a href="#content">Navigation</a></Toolbar>';
const baseMarkup = `${header}${body}${context}${chrome}`;
const baseScript = 'import { FsusTaskPageHeader as Header, FsusCollectionToolbar as Toolbar } from "@ozwasyd/element-plus";';
const nativePropMarkup = baseMarkup.replace('<p>Current content</p>', '<Scroller><p>Current content</p></Scroller>');
const nativePropScript = baseScript + 'import {ElScrollbar as Scroller} from "@ozwasyd/element-plus";';
const nativeFunctionMarkup = baseMarkup.replace('<p>Current content</p>',
    '<List :interactive="false" :rows="[{id:1,label:\'Plain\'}]" :columns="[{key:\'label\'}]"/>'
    + '<List interactive :rows="[{id:2,label:\'Button\'}]" :columns="[{key:\'label\'}]"/>'
    + '<List :href="()=>\'#content\'" :rows="[{id:3,label:\'Link\'}]" :columns="[{key:\'label\'}]"/>');
const nativeFunctionScript = baseScript + 'import {FsusDataList as List} from "@ozwasyd/element-plus";';
const macroPropMarkup = baseMarkup.replace('<p>Current content</p>', '<Dock :immediate="false" disabled><span>Dock content</span></Dock>');
const macroPropScript = baseScript + 'import {FsuMobileDock as Dock} from "@ozwasyd/element-plus/motion";';
function fixture(markup, script = baseScript, style = '')
{
    return `<script setup>${script}</script><template><main style="display:flex;flex-direction:column">${markup}</main></template><style>${style}</style>`;
}
const cases = [
    { name: 'baseline', content: fixture(baseMarkup), expected: null },
    { name: 'public-icon-star-export', content: fixture(baseMarkup.replace('<p>Current content</p>', '<Busy/><p>Current content</p>'),
        baseScript + 'import {Loading as Busy} from "@ozwasyd/element-plus/icons-vue";'), expected: null },
    { name: 'dynamic-public-prop-is-unbound', content: fixture(baseMarkup.replace('title="Current document"', ':title="currentTitle"'),
        baseScript + 'import {ref} from "vue";const currentTitle=ref("Current document");'), expected: 'unknown-conditional-state-binding' },
    { name: 'dynamic-public-attribute-is-unbound', content: fixture(baseMarkup.replace('title="Current document"', 'title="Current document" :[propKey]="currentTitle"'),
        baseScript + 'import {ref} from "vue";const propKey="title";const currentTitle=ref("Current document");'), expected: 'unknown-conditional-state-binding' },
    { name: 'conditional-public-slot-is-unbound', content: fixture(baseMarkup.replace('</Toolbar>', '<template #actions v-if="showActions"><span>Action</span></template></Toolbar>'),
        baseScript + 'import {ref} from "vue";const showActions=ref(false);'), expected: 'unknown-conditional-state-binding' },
    { name: 'public-structural-render-count-drift', content: fixture(baseMarkup), mutation: 'duplicate-public-title', expected: 'structural-condition-render-mismatch' },
    { name: 'missing-public-call-provenance', content: fixture(baseMarkup), mutation: 'remove-public-call-marker', expected: 'unknown-conditional-state-binding' },
    { name: 'public-native-prop-default', content: fixture(nativePropMarkup, nativePropScript), nativeProbe: true, expected: null },
    { name: 'public-native-prop-tag-drift', content: fixture(nativePropMarkup, nativePropScript), nativeProbe: true, mutation: 'replace-native-tag', expected: 'unknown-dynamic-native-tag' },
    { name: 'dynamic-native-prop-is-unbound', content: fixture(nativePropMarkup.replace('<Scroller>', '<Scroller :tag="currentTag">'),
        nativePropScript + 'import {ref} from "vue";const currentTag=ref("div");'), expected: 'unbound-native-prop-source' },
    { name: 'public-native-function-rows', content: fixture(nativeFunctionMarkup, nativeFunctionScript), nativeFunctionProbe: true, expected: null },
    { name: 'public-native-function-tag-drift', content: fixture(nativeFunctionMarkup, nativeFunctionScript), nativeFunctionProbe: true,
        mutation: 'replace-native-function-tag', expected: 'unknown-dynamic-native-tag' },
    { name: 'public-macro-native-default', content: fixture(macroPropMarkup, macroPropScript), macroPropProbe: true, expected: null },
    { name: 'public-macro-native-tag-drift', content: fixture(macroPropMarkup, macroPropScript), macroPropProbe: true,
        mutation: 'replace-native-tag', expected: 'unknown-dynamic-native-tag' },
    { name: 'public-closed-literal-call-spread', content: fixture(macroPropMarkup.replace('<Dock ', '<Dock v-bind="{ label:\'Closed call\' }" '), macroPropScript), macroPropProbe: true, expected: null },
    { name: 'unknown-call-spread-is-unbound', content: fixture(macroPropMarkup.replace('<Dock ', '<Dock v-bind="unknownAttrs" '),
        macroPropScript + 'import {ref} from "vue";const unknownAttrs=ref({});'), expected: 'unbound-native-prop-source' },
    { name: 'two-task-page-headers', content: fixture(baseMarkup + header), expected: 'task-header-not-exact-one' },
    { name: 'three-same-priority-primary-buttons', content: fixture(baseMarkup.replace(action, action.repeat(3))), expected: 'primary-action-not-exact' },
    { name: 'section-card-card-nesting', content: fixture(baseMarkup.replace('<p>Current content</p>', '<section data-fsus-surface="data-region" data-fsus-material="boundary"><section data-fsus-surface="data-region" data-fsus-material="boundary">Nested</section></section>')), expected: 'forbidden-surface-nesting' },
    { name: 'page-wrapper-forged-public-surface', content: fixture(baseMarkup.replace(chrome, chrome.replace('<Toolbar', '<div').replace('</Toolbar>', '</div>'))), expected: 'local-wrapper-forged-public-surface' },
    { name: 'desktop-mobile-duplicate-owner', content: fixture(baseMarkup + body.replace('<section ', '<section style="display:none" ')), expected: 'duplicate-owner-including-hidden' },
    { name: 'hidden-duplicate-h1', content: fixture(baseMarkup + '<h1 hidden>Hidden page title</h1>'), expected: 'page-heading-not-exact-one' },
    { name: 'hidden-duplicate-content', content: fixture(baseMarkup + '<div hidden data-fsus-content="document-content">Duplicate</div>'), expected: 'hidden-or-duplicate-content-owner' },
    { name: 'route-name-special-good-layout', content: fixture('<section v-if="good">' + baseMarkup + '</section>', baseScript + 'import {useRoute} from "vue-router";const route=useRoute();const good=route.name==="representative";'), expected: 'route-name-visual-branch' },
    { name: 'excess-fixed-toolbar-status-owner', content: fixture(baseMarkup + '<div style="position:fixed" data-fsus-chrome="status" data-fsus-owner="extra-status-owner">Status</div>'), expected: 'unknown-or-excess-chrome-owner' },
    { name: 'responsive-content-reorder', content: fixture(baseMarkup, baseScript, '@media(max-width:600px){[data-fsus-region="document-content"]{order:-1}}'), expected: 'responsive-content-reorder', viewport: { width: 375, height: 800 } },
    { name: 'unknown-component-with-plausible-labels', content: fixture(baseMarkup + '<UnknownPanel data-fsus-surface="document"/>'), expected: 'unknown-component-source' },
    { name: 'imported-local-wrapper-source-mismatch', content: fixture(baseMarkup.replace(chrome, chrome.replace('Toolbar', 'FakeToolbar').replace('</Toolbar>', '</FakeToolbar>')), baseScript + 'import FakeToolbar from "./FakeToolbar.vue";'), expected: 'local-wrapper-forged-public-surface' },
    { name: 'mutually-exclusive-actions-actually-simultaneous', content: fixture(baseMarkup.replace(action, action.replace('read-current-document', 'save-site-settings') + action.replace('read-current-document', 'save-compliance-settings'))), expected: 'mutually-exclusive-actions-simultaneously-operable',
        contractInput: 'settings', state: { 'settings-task-tab': 'tab-site' } }
];
writeFileSync(join(output, 'FakeToolbar.vue'), '<template><div><slot/></div></template>');
writeFileSync(join(output, 'index.html'), '<html><body><div id="app"></div><script type="module" src="/main.mjs"></script></body></html>');
writeFileSync(join(output, 'main.mjs'), `import {createApp,h} from 'vue';import{createRouter,createMemoryHistory,RouterView}from'vue-router';const path=new URL(location.href).searchParams.get('case');const view=await import(/* @vite-ignore */ './'+path+'.vue');const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',name:'representative',component:view.default}]});const app=createApp({render:()=>h(RouterView)});app.use(router);await router.isReady();app.mount('#app');`);
for (const item of cases)
{
    writeFileSync(join(output, item.name + '.vue'), item.content);
}
try
{
    server = await createServer({ configFile: false, root: output,
        plugins: [compositionProbePlugin(run.source), vue(), jsx()],
        optimizeDeps: { entries: cases.map((item) => item.name + '.vue') },
        resolve: { dedupe: ['vue'], alias: [...createFsusUiAliases(fsusUIRoot),
            { find: /^vue$/, replacement: join(frontend, 'node_modules/vue') },
            { find: /^vue-router$/, replacement: join(frontend, 'node_modules/vue-router') }] },
        server: { host: '127.0.0.1', port: 0, fs: { allow: [repositoryRoot, fsusUIRoot] } } });
    await server.listen();
    await server.transformRequest('/main.mjs');
    await server.transformRequest('/baseline.vue');
    await server.waitForRequestsIdle();
    browser = await chromium.launch({ headless: true });
    report.browser = { version: browser.version(), executablePath: chromium.executablePath() };
    const url = server.resolvedUrls.local[0];
    const warmup = await browser.newPage();
    report.preparation = { status: 'running', runtimeErrors: [], entries: cases.map((item) => item.name + '.vue') };
    warmup.on('pageerror', (error) => report.preparation.runtimeErrors.push(error.message));
    await warmup.goto(`${url}?case=baseline`);
    await warmup.locator('main').waitFor();
    await server.waitForRequestsIdle();
    await warmup.close();
    assert.deepEqual(report.preparation.runtimeErrors, [], 'preparation runtime errors must not qualify diagnostic observations');
    report.preparation.status = 'completed';
    let baselineReasons = [];
    for (const item of cases)
    {
        const page = await browser.newPage({ viewport: item.viewport ?? { width: 1440, height: 1000 } });
        const runtimeErrors = [];
        page.on('pageerror', (error) => runtimeErrors.push(error.message));
        const result = { name: item.name, status: 'running', expected: item.expected };
        report.cases.push(result);
        try
        {
            await page.goto(`${url}?case=${item.name}`);
            await page.locator('main').waitFor();
            assert.deepEqual(runtimeErrors, [], 'negative controls must render without runtime errors');
            const graph = run.source.graph([join(output, item.name + '.vue')]);
            if (item.name === 'public-icon-star-export')
            {
                assert.equal(await page.locator('svg').count(), 1, 'actual public icon must render');
                const call = graph.nodes.find((node) => node.tag === 'Busy');
                assert.equal(call.origin.kind, 'fsusui-public');
                assert.ok(call.definition.endsWith('/icons-vue/src/components/loading.vue'));
                assert.ok(graph.nodes.some((node) => node.file === call.definition && node.tag === 'svg'));
            }
            if (item.mutation === 'duplicate-public-title')
            {
                await page.locator('h1').evaluate((title) => title.parentElement.append(title.cloneNode(true)));
            }
            if (item.mutation === 'remove-public-call-marker')
            {
                await page.locator('header').evaluate((header) => header.removeAttribute('data-fsus-composition-call'));
            }
            if (item.nativeProbe || item.macroPropProbe)
            {
                const expectedTag = item.macroPropProbe ? 'nav' : 'div';
                const binding = graph.nativePropBindings.find((binding) => graph.nodes.find((node) => node.id === binding.callNode)?.tag === (item.macroPropProbe ? 'Dock' : 'Scroller'));
                assert.ok(binding, 'actual public default must have a source-bound native tag');
                assert.equal(binding.tag, expectedTag);
                const view = page.locator(`[data-fsus-composition-node="${binding.sourceNode}"]`);
                assert.equal(await view.count(), 1);
                assert.equal(await view.evaluate((element) => element.tagName.toLowerCase()), expectedTag);
                if (item.mutation === 'replace-native-tag')
                {
                    await view.evaluate((element) =>
                    {
                        const replacement = globalThis.document.createElement('section');
                        for (const attribute of element.attributes)
                        {
                            replacement.setAttribute(attribute.name, attribute.value);
                        }
                        replacement.append(...element.childNodes);
                        element.replaceWith(replacement);
                    });
                }
            }
            if (item.nativeFunctionProbe)
            {
                const row = graph.nodes.find((node) => node.origin.function === 'rowTag');
                assert.ok(row.file.endsWith('/collection-primitives/src/data-list.vue'));
                assert.deepEqual(row.origin.values, ['a', 'button', 'div']);
                const rows = page.locator(`[data-fsus-composition-node="${row.id}"]`);
                assert.equal(await rows.count(), 3, 'actual public DataList must render all three native row modes');
                assert.deepEqual(await rows.evaluateAll((elements) => elements.map((element) => element.tagName.toLowerCase()).sort()), ['a', 'button', 'div']);
                if (item.mutation === 'replace-native-function-tag')
                {
                    await rows.first().evaluate((element) =>
                    {
                        const replacement = globalThis.document.createElement('section');
                        for (const attribute of element.attributes)
                        {
                            replacement.setAttribute(attribute.name, attribute.value);
                        }
                        replacement.append(...element.childNodes);
                        element.replaceWith(replacement);
                    });
                }
            }
            const candidate = structuredClone(archetype);
            if (item.contractInput)
            {
                candidate.compositionContract.actionPriority = run.inputs.matrix.archetypes.find((entry) => entry.kind === item.contractInput).compositionContract.actionPriority;
            }
            const receipt = await probeCompositionPage(page, { archetype: candidate, graph, identity: run.identity,
                currentIdentity: run.identity, runId, runBinding, state: item.state });
            const reasons = [...new Set(receipt.errors.map((error) => error.reason))];
            if (item.expected)
            {
                assert.ok(reasons.includes(item.expected), `${item.expected} was not detected: ${reasons.join(',')}`);
            }
            else if (!item.nativeProbe && !item.nativeFunctionProbe && !item.macroPropProbe)
            {
                baselineReasons = reasons;
                // Current FsusUI has no public composition surface/material provenance contract.
                // This limitation stays a failing observation, never a forged clean baseline.
                assert.deepEqual(reasons, ['unproved-public-surface-capability']);
            }
            else
            {
                assert.ok(!reasons.includes('unknown-dynamic-native-tag') && !reasons.includes('unbound-native-prop-source'),
                    'source-bound native defaults must match their actual DOM; unrelated unresolved state/capability remains diagnostic');
            }
            if (item.expected)
            {
                assert.ok(!baselineReasons.includes(item.expected), 'negative predicate must add a real baseline difference');
            }
            verifyCompositionObservation(receipt, { graph, identity: run.identity, runId, runBinding, archetype: candidate, state: item.state });
            assert.deepEqual(runtimeErrors, [], 'diagnostic mutations must not substitute a runtime error for the targeted gate');
            const tampered = { ...receipt, errors: [], observationsPassed: true };
            assert.throws(() => verifyCompositionObservation(tampered, { graph, identity: run.identity, runId, runBinding, archetype: candidate, state: item.state }), /tampered/);
            const receiptPath = join(output, `${item.name}.json`);
            writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
            result.status = 'passed';
            result.observationPassed = receipt.observationsPassed;
            result.receipt = receiptPath;
            result.reasons = reasons;
            result.runtimeErrors = runtimeErrors;
        }
        catch (error)
        {
            result.status = 'failed';
            result.error = error.stack;
            result.runtimeErrors = runtimeErrors;
        }
        finally
        {
            await page.close();
        }
    }
    const malformed = join(output, 'malformed.vue');
    writeFileSync(malformed, '<template><section><p></section></template>');
    const malformedGraph = createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([malformed]);
    assert.ok(malformedGraph.errors.some((error) => error.reason === 'unknown-ast-parse'));
    report.cases.push({ name: 'unknown-ast-parse', status: 'passed', phase: 'actual-parser', dom: 'not-run' });
    const mutatedInputs = structuredClone(run.inputs);
    mutatedInputs.authorityDocuments['fsusui-design'].content += '\nmutation';
    const mutatedIdentity = createCompositionIdentity(mutatedInputs, { sourceCommit: run.worktree.commit, fsusUIBaselineIdentity: baseline });
    assert.throws(() => verifyCompositionIdentity(run.identity, mutatedIdentity), /stale/);
    report.cases.push({ name: 'contract-design-baseline-digest-drift', status: 'passed', phase: 'identity-verifier', dom: 'not-run' });
    // A grep-only source stub cannot satisfy the joined DOM provenance checks.
    const first = JSON.parse(readFileSync(join(output, 'baseline.json'), 'utf8'));
    const weak = { schema: 'fsusblog.composition-source.v1', nodes: [], errors: [], sourceIdentity: {}, files: [] };
    const weakReceipt = analyzeCompositionDom({ archetype, graph: weak, observation: first.observation, identity: run.identity,
        currentIdentity: run.identity, runId, runBinding });
    assert.ok(weakReceipt.errors.some((error) => error.reason === 'unknown-rendered-source'));
    report.cases.push({ name: 'regex-only-analyzer-mutation', status: 'passed', phase: 'joined-verifier-mutation', dom: 'reused-current-observation' });
    run.verifyCurrent();
    report.status = report.cases.every((item) => item.status === 'passed') ? 'passed' : 'failed';
}
catch (error)
{
    report.status = 'failed';
    report.error = error.stack;
}
finally
{
    await browser?.close();
    await server?.close();
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(`[composition-probe] ${report.status}: ${join(output, 'report.json')}`);
for (const item of report.cases)
{
    console.log(`${item.status}: ${item.name}${item.error ? ': ' + item.error.split('\n')[0] : ''}`);
}
if (report.status !== 'passed')
{
    process.exitCode = 1;
}
