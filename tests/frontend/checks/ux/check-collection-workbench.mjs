#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path) => readFileSync(new URL(path, `file://${root}/`), 'utf8');
const workbench = read('src/frontend/src/components/admin/CollectionWorkbench.vue');
const workspaceCss = read('src/frontend/src/assets/admin-workspace.css');
const fixture = JSON.parse(read('tests/frontend/fixtures/collection-workbench-contract.json'));
const regions = ['summary', 'primary-filter', 'selection-actions', 'results', 'pagination'];

let previous = -1;
for (const region of regions)
{
    const index = workbench.indexOf(`data-workbench-region="${region}"`);
    assert.ok(index > previous, `${region} must appear once in the fixed workbench order`);
    previous = index;
}
assert.match(workbench, /v-if="selectedCount > 0"/, 'selection actions must not enter layout or tab order without a selection');
assert.match(workbench, /<slot :name="state === 'ready' \? 'results' : state" \/>/, 'result states must use one mutually exclusive slot');
assert.doesNotMatch(workbench, /<slot\s*\/>/, 'workbench must not expose an arbitrary default slot');
assert.match(workspaceCss, /\.collection-workbench__toolbar\s*\{[^}]*min-height:\s*44px;[^}]*gap:\s*var\(--fsus-space-3\);/s);
assert.match(workspaceCss, /\.collection-workbench__selection\s*\{[^}]*min-height:\s*52px;/s);
assert.match(workspaceCss, /\.collection-workbench__results\s*\{[^}]*margin-top:\s*var\(--fsus-space-6\);/s);
assert.match(workspaceCss, /\.collection-workbench__pagination\s*\{[^}]*margin-top:\s*var\(--fsus-space-4\);/s);
assert.match(workspaceCss, /@media \(width <= 639px\)[\s\S]*\.collection-workbench__toolbar[\s\S]*flex-direction:\s*column;/);
assert.doesNotMatch(workspaceCss, /\.collection-workbench[^}]*border-radius:/, 'workbench must stay a flat data region');

assert.deepEqual(fixture.viewports.map(({ width }) => width), [1366, 375]);
assert.deepEqual(fixture.themes, ['light', 'dark']);
assert.deepEqual(fixture.densities, ['compact', 'comfortable']);
assert.deepEqual(fixture.geometry, {
    pageHeaderGapPx: [20, 24],
    toolbarHeightPx: 44,
    toolbarGapPx: [8, 12],
    resultsGapPx: [20, 24],
    selectionHeightPx: [48, 56],
    paginationGapPx: [16, 20]
});
for (const page of fixture.pages)
{
    const source = read(page.source);
    assert.match(source, /<CollectionWorkbench\b/, `${page.name} must use CollectionWorkbench`);
    assert.doesNotMatch(source, /<AdminCollection(?:Toolbar|Summary)\b/, `${page.name} must not copy the retired collection skeleton`);
    assert.notDeepEqual(page.beforeRegions, page.afterRegions, `${page.name} must preserve before/after geometry evidence`);
    assert.ok(page.operationFlow.length >= 4, `${page.name} must preserve a complete task flow`);
}

console.log('[collection-workbench] fixed composition, fixture matrix and geometry passed');
