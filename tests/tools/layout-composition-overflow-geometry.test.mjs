import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
// Explicit source imports keep this slice independent of owner-held exports.
const { captureCompositionDom } = await import(pathToFileURL(resolve(repositoryRoot, 'tests/frontend/support/layout/compositionDom.mjs')));
const { loadCompositionInputs, requireCompositionRuntimeBindings } = await import(pathToFileURL(resolve(repositoryRoot, 'tests/frontend/support/layout/compositionContracts.mjs')));
const { captureCompositionOverflowGeometry, compareCompositionOverflowGeometry } = await import(pathToFileURL(resolve(repositoryRoot, 'tests/frontend/support/layout/compositionOverflowGeometry.mjs')));

// Numeric fixtures below test comparison logic only; they are not DOM/browser
// observations, fixture bindings or product evidence.
function measurement(width = 100)
{
    return { scrollWidth: width, clientWidth: width, clientLeft: 0, scrollLeft: 0,
        rect: { left: 0, right: width, width },
        style: { overflowX: 'visible', overflowY: 'visible', direction: 'ltr',
            writingMode: 'horizontal-tb', position: 'static', transform: 'none', clipPath: 'none', contain: 'none' } };
}

function observations()
{
    const node = { index: 0, parent: null, tag: 'main', sourceNode: 'numeric-unit-node', sourceCall: null,
        owner: 'unit-owner', region: 'unit-region', inheritedOwner: 'unit-owner', inheritedRegion: 'unit-region',
        hidden: false, visible: true };
    const page = { url: 'https://unit.invalid/overflow', viewport: { width: 100, height: 80 } };
    return { domObservation: { ...structuredClone(page), nodes: [{ ...node }] },
        overflowObservation: { schema: 'fsusblog.composition-overflow-geometry.v1', ...structuredClone(page), scroll: { x: 0, y: 0 }, compatMode: 'CSS1Compat',
            scrollingElement: 'documentElement', roots: { scrollingElement: measurement(), documentElement: measurement(), body: measurement() },
            nodes: [{ ...node, ...measurement() }] } };
}

function reject(input, reason)
{
    const result = compareCompositionOverflowGeometry(input);
    assert.equal(result.observationsPassed, false);
    assert.equal(result.checkedPredicates[0].passed, false);
    assert.equal(result.qualification, 'diagnostic-only');
    assert.equal(result.fullGeometryVerified, false);
    assert.equal(result.fullVisualVerified, false);
    assert.ok([...result.errors, ...result.unsupported].some((item) => item.reason === reason), JSON.stringify(result));
    return result;
}

function setExtent(node, left, width)
{
    node.rect = { left, right: left + width, width };
}

test('overflow numeric no overflow remains a partial diagnostic', () =>
{
    const result = compareCompositionOverflowGeometry(observations());
    assert.equal(result.observationsPassed, true);
    assert.equal(result.fullGeometryVerified, false);
    assert.equal(result.fullVisualVerified, false);
    assert.equal(result.qualification, 'diagnostic-only');
    assert.ok(result.pendingGates.includes('semantic-text-clipping'));
    assert.ok(result.pendingGates.includes('required-current-state-viewport-matrix'));
    assert.deepEqual(result, compareCompositionOverflowGeometry(observations()));
});

test('overflow numeric root width fails independently of inner widths', () =>
{
    for (const root of ['documentElement', 'body'])
    {
        const input = observations();
        input.overflowObservation.roots[root].scrollWidth = 101;
        if (root === 'documentElement')
        {
            input.overflowObservation.roots.scrollingElement.scrollWidth = 101;
        }
        reject(input, 'document-horizontal-overflow');
    }
    const input = observations();
    input.overflowObservation.nodes[0].scrollWidth = 1000;
    assert.equal(compareCompositionOverflowGeometry(input).observationsPassed, true);
});

test('overflow numeric fractional negative left and RTL extents fail without tolerance', () =>
{
    for (const direction of ['ltr', 'rtl'])
    {
        for (const [left, width] of [[-0.125, 10], [99.875, 0.25]])
        {
            const input = observations();
            input.overflowObservation.nodes[0].style.direction = direction;
            setExtent(input.overflowObservation.nodes[0], left, width);
            reject(input, 'uncontained-horizontal-extent');
        }
    }
});

test('overflow numeric bounded inner scroller contains wide descendants', () =>
{
    const input = observations();
    const outer = input.overflowObservation.nodes[0];
    outer.style.overflowX = 'auto';
    outer.scrollWidth = 1000;
    const child = { ...structuredClone(outer), index: 1, parent: 0, scrollWidth: 1000, clientWidth: 1000 };
    child.style.overflowX = 'visible';
    setExtent(child, -500, 1000);
    input.overflowObservation.nodes.push(child);
    input.domObservation.nodes.push({ ...structuredClone(child) });
    const result = compareCompositionOverflowGeometry(input);
    assert.equal(result.observationsPassed, true);
    assert.equal(result.boundedInnerScrollers.length, 1);
    outer.rect.right = 101;
    outer.rect.width = 101;
    reject(input, 'uncontained-horizontal-extent');
    const body = observations();
    body.overflowObservation.roots.documentElement.style.overflowX = 'auto';
    body.overflowObservation.roots.scrollingElement.style.overflowX = 'auto';
    body.overflowObservation.roots.body.style.overflowX = 'auto';
    body.overflowObservation.roots.body.scrollWidth = 500;
    setExtent(body.overflowObservation.nodes[0], 0, 500);
    assert.equal(compareCompositionOverflowGeometry(body).observationsPassed, true);
});

test('overflow numeric fixed descendants cannot borrow inner scroller containment', () =>
{
    const input = observations();
    const outer = input.overflowObservation.nodes[0];
    outer.style.overflowX = 'auto';
    const child = { ...structuredClone(outer), index: 1, parent: 0 };
    child.style.position = 'fixed';
    setExtent(child, -1, 100);
    input.overflowObservation.nodes.push(child);
    input.domObservation.nodes.push({ ...structuredClone(child) });
    reject(input, 'uncontained-horizontal-extent');
    child.style.position = 'absolute';
    reject(input, 'unsupported-positioned-scroll-containment');
});

test('overflow numeric root hidden and clip remain unsupported even with fitting widths', () =>
{
    for (const root of ['documentElement', 'body'])
    {
        for (const overflowX of ['hidden', 'clip'])
        {
            const input = observations();
            input.overflowObservation.roots[root].style.overflowX = overflowX;
            if (root === 'documentElement')
            {
                input.overflowObservation.roots.scrollingElement.style.overflowX = overflowX;
            }
            reject(input, 'root-horizontal-masking');
        }
    }
});

test('overflow numeric inner clipping and unsupported root styles stay explicit', () =>
{
    for (const [field, value] of [['overflowX', 'hidden'], ['overflowX', 'clip'], ['clipPath', 'inset(0px)'], ['contain', 'paint'], ['writingMode', 'vertical-rl']])
    {
        const input = observations();
        input.overflowObservation.nodes[0].style[field] = value;
        reject(input, 'unsupported-inner-clipping-or-containment');
    }
    for (const [field, value] of [['transform', 'matrix(1, 0, 0, 1, 10, 0)'], ['writingMode', 'vertical-rl'], ['contain', 'paint'], ['clipPath', 'inset(0px)']])
    {
        const input = observations();
        input.overflowObservation.roots.body.style[field] = value;
        reject(input, 'unsupported-root-geometry-style');
    }
});

test('overflow numeric document client width accounts for scrollbar rather than viewport width', () =>
{
    const input = observations();
    input.domObservation.viewport.width = 115;
    input.overflowObservation.viewport.width = 115;
    assert.equal(compareCompositionOverflowGeometry(input).observationsPassed, true);
    setExtent(input.overflowObservation.nodes[0], 99, 2);
    reject(input, 'uncontained-horizontal-extent');
    input.overflowObservation.roots.body.scrollWidth = 101;
    reject(input, 'document-horizontal-overflow');
});

test('overflow numeric invalid and nonfinite measurements never pass', () =>
{
    for (const field of ['scrollWidth', 'clientWidth', 'clientLeft', 'scrollLeft'])
    {
        for (const value of [NaN, Infinity, -Infinity, '100', null, undefined])
        {
            const input = observations();
            input.overflowObservation.roots.body[field] = value;
            reject(input, 'missing-or-malformed-overflow-observation');
        }
    }
    for (const field of ['left', 'right', 'width'])
    {
        for (const value of [NaN, Infinity, '0', null, undefined])
        {
            const input = observations();
            input.overflowObservation.nodes[0].rect[field] = value;
            reject(input, 'malformed-node-observation');
        }
    }
    for (const field of ['scrollWidth', 'clientWidth', 'clientLeft'])
    {
        const input = observations();
        input.overflowObservation.roots.body[field] = -1;
        reject(input, 'missing-or-malformed-overflow-observation');
    }
});

test('overflow numeric missing and malformed evidence never passes', () =>
{
    for (const input of [undefined, null, {}, { domObservation: {} }, { overflowObservation: {} }])
    {
        reject(input, 'missing-or-malformed-overflow-observation');
    }
    const version = observations();
    delete version.overflowObservation.schema;
    reject(version, 'missing-or-malformed-overflow-observation');
    for (const key of ['documentElement', 'body', 'scrollingElement'])
    {
        const input = observations();
        delete input.overflowObservation.roots[key];
        reject(input, 'missing-or-malformed-overflow-observation');
    }
    for (const nodes of [[], null, {}, [null]])
    {
        const input = observations();
        input.overflowObservation.nodes = nodes;
        assert.equal(compareCompositionOverflowGeometry(input).observationsPassed, false);
    }
    const input = observations();
    input.overflowObservation.nodes[0].rect.width = -1;
    reject(input, 'malformed-node-observation');
});

test('overflow numeric exact node source page and viewport correspondence is required', () =>
{
    for (const field of ['tag', 'sourceNode', 'sourceCall', 'owner', 'region', 'inheritedOwner', 'inheritedRegion', 'visible'])
    {
        const input = observations();
        input.domObservation.nodes[0][field] = field === 'visible' ? false : 'changed-unit-identity';
        reject(input, 'dom-overflow-node-correspondence-mismatch');
    }
    for (const field of ['index', 'parent', 'hidden'])
    {
        const input = observations();
        input.domObservation.nodes[0][field] = field === 'hidden' ? true : 1;
        reject(input, 'malformed-node-observation');
    }
    for (const field of ['sourceNode', 'sourceCall', 'owner', 'region', 'inheritedOwner', 'inheritedRegion'])
    {
        const input = observations();
        delete input.overflowObservation.nodes[0][field];
        reject(input, 'malformed-node-observation');
    }
    const page = observations();
    page.domObservation.url += '/other';
    reject(page, 'dom-overflow-page-viewport-correspondence-mismatch');
    for (const field of ['width', 'height'])
    {
        const input = observations();
        input.domObservation.viewport[field] += 1;
        reject(input, 'dom-overflow-page-viewport-correspondence-mismatch');
        for (const value of [0, -1, NaN, Infinity, '100', null, undefined])
        {
            input.domObservation.viewport[field] = value;
            reject(input, 'missing-or-malformed-overflow-observation');
        }
    }
});

test('overflow numeric scrolling mode and root identity cannot be guessed', () =>
{
    const mismatch = observations();
    mismatch.overflowObservation.roots.scrollingElement.scrollWidth = 101;
    reject(mismatch, 'scrolling-element-correspondence-mismatch');
    const quirks = observations();
    quirks.overflowObservation.compatMode = 'BackCompat';
    quirks.overflowObservation.scrollingElement = 'body';
    reject(quirks, 'unsupported-document-scrolling-mode');
    const scrolled = observations();
    scrolled.overflowObservation.scroll.x = -1;
    reject(scrolled, 'unsupported-root-horizontal-scroll-position');
    const invalid = observations();
    invalid.overflowObservation.roots.documentElement.clientWidth = 0;
    invalid.overflowObservation.roots.scrollingElement.clientWidth = 0;
    reject(invalid, 'invalid-document-client-width');
});

test('overflow actual matrix bindings remain pending before product browser evaluation', () =>
{
    const inputs = loadCompositionInputs({ repositoryRoot });
    const states = inputs.matrix.archetypes.flatMap((entry) => entry.compositionContract.requiredStateFixtures);
    assert.equal(states.filter(({ bindingStatus }) => bindingStatus === 'pending-current-run').length, 91);
    assert.equal(states.filter(({ fixtureRef }) => fixtureRef === null).length, 79);
    assert.throws(() => requireCompositionRuntimeBindings(inputs), /current runtime state\/capability bindings are pending/u);
});

test('overflow actual browser fixture document bounds scrollers RTL masking and live widths', async (context) =>
{
    // Ordinary Node test + repository-pinned Playwright library. No product
    // routes, mocked DOMRects, semantic receipts or qualified browser audits.
    const packageFile = process.env.FSUSBLOG_PLAYWRIGHT_PACKAGE_JSON
        ?? resolve(repositoryRoot, 'src/frontend/node_modules/@playwright/test/package.json');
    const require = createRequire(packageFile);
    const locked = JSON.parse(readFileSync(resolve(repositoryRoot, 'src/frontend/package-lock.json'), 'utf8'));
    assert.equal(require(packageFile).version, locked.packages['node_modules/@playwright/test'].version);
    const { chromium } = require('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    context.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 240, height: 200 } });
    const capture = async () => ({ domObservation: await page.evaluate(captureCompositionDom),
        overflowObservation: await page.evaluate(captureCompositionOverflowGeometry) });
    const document = (style, content) => `<!doctype html><style>html,body{margin:0}${style}</style>${content}`;
    const main = '<main data-fsus-composition-node="fixture-main" data-fsus-owner="fixture-owner" data-fsus-region="fixture-region"></main>';
    await page.setContent(document('main{height:20px}', main));
    const fitting = await capture();
    assert.equal(compareCompositionOverflowGeometry(fitting).observationsPassed, true);
    await page.addStyleTag({ content: 'main{width:500px}' });
    const wide = await capture();
    assert.ok(wide.overflowObservation.roots.scrollingElement.scrollWidth > wide.overflowObservation.roots.documentElement.clientWidth);
    reject(wide, 'document-horizontal-overflow');
    // Capturing reads without altering product-style dimensions or markers.
    assert.equal(await page.locator('main').evaluate((element) => element.getBoundingClientRect().width), 500);
    assert.equal(await page.locator('main').getAttribute('data-fsus-composition-node'), 'fixture-main');
    await page.addStyleTag({ content: 'main{width:100px}' });
    assert.equal(compareCompositionOverflowGeometry(await capture()).observationsPassed, true);
    await page.addStyleTag({ content: 'main{width:500px}' });
    reject(await capture(), 'document-horizontal-overflow');
    await page.setViewportSize({ width: 600, height: 200 });
    assert.equal(compareCompositionOverflowGeometry(await capture()).observationsPassed, true);
    const drift = await capture();
    drift.domObservation = wide.domObservation;
    reject(drift, 'dom-overflow-page-viewport-correspondence-mismatch');
    await page.setViewportSize({ width: 240, height: 200 });
    await page.setContent(document('main{height:20px;overflow-x:auto}table{width:500px;height:20px}', main.replace('</main>', '<table><tr><td>fixture</td></tr></table></main>')));
    const inner = await capture();
    const innerResult = compareCompositionOverflowGeometry(inner);
    assert.equal(innerResult.observationsPassed, true, JSON.stringify(innerResult));
    assert.equal(innerResult.boundedInnerScrollers.length, 1);
    await page.locator('main').evaluate((element) =>
    {
        element.scrollLeft = 100;
    });
    assert.equal(compareCompositionOverflowGeometry(await capture()).observationsPassed, true);
    await page.setContent(document('html{overflow:auto}body{overflow:auto;height:50px}main{width:500px;height:20px}', main));
    const bodyScroller = await capture();
    assert.ok(bodyScroller.overflowObservation.roots.body.scrollWidth > bodyScroller.overflowObservation.roots.body.clientWidth);
    assert.equal(compareCompositionOverflowGeometry(bodyScroller).observationsPassed, true);
    for (const direction of ['ltr', 'rtl'])
    {
        await page.setContent(document(`html{direction:${direction}}main{position:relative;left:-10px;height:20px}`, main));
        reject(await capture(), 'uncontained-horizontal-extent');
    }
    for (const root of ['html', 'body'])
    {
        for (const overflowX of ['hidden', 'clip'])
        {
            await page.setContent(document(`${root}{overflow-x:${overflowX}}main{width:500px;height:20px}`, main));
            const masked = reject(await capture(), 'root-horizontal-masking');
            assert.ok(masked.pendingGates.includes('semantic-text-clipping'));
        }
    }
    // Reserve an actual CSS scrollbar gutter. Headless Chromium can keep root
    // clientWidth equal to innerWidth while reducing the root DOMRect; neither
    // this fixture nor the comparator guesses a scrollbar thickness.
    await page.setContent(document('html{scrollbar-gutter:stable}main{height:500px}', main));
    const scrollbar = await capture();
    assert.ok(scrollbar.overflowObservation.roots.documentElement.rect.width < scrollbar.overflowObservation.viewport.width);
    assert.equal(compareCompositionOverflowGeometry(scrollbar).observationsPassed, true);
    await page.addStyleTag({ content: 'main{width:100vw}' });
    reject(await capture(), 'uncontained-horizontal-extent');
});
