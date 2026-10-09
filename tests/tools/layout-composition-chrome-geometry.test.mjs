import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// Source paths preserve this slice's independence from the owner-held exports.
const repositoryRoot = resolve(import.meta.dirname, '../..');
const layout = (file) => pathToFileURL(resolve(repositoryRoot, 'tests/frontend/support/layout', file));
const { compositionDigest, createCompositionIdentity, loadCompositionInputs } = await import(layout('compositionContracts.mjs'));
const { analyzeCompositionDom, captureCompositionDom } = await import(layout('compositionDom.mjs'));
const { captureCompositionGeometry, probeCompositionGeometryPage } = await import(layout('compositionGeometry.mjs'));
const { captureCompositionChromeGeometry, compareCompositionChromeGeometry } = await import(layout('compositionChromeGeometry.mjs'));
const inputs = loadCompositionInputs({ repositoryRoot });

// A synthetic baseline/source/DOM model exercises the original analyzer replay
// and numeric comparator only. It is never a state binding or product receipt.
const baseline = {
    schema: 'fsusblog-design-conformance.fsusui-baseline-identity.v1', sourceKind: 'local-source',
    repository: 'Ozwasyd/FsusUI', absolutePath: '/numeric-only/fsusui', gitHead: 'a'.repeat(40),
    packageVersion: 'numeric-unit-model', dirty: false, dirtyFingerprint: compositionDigest('numeric-clean'),
    skillDigest: compositionDigest('numeric-skill'),
    contractDigests: Object.fromEntries(['stagePolicy', 'classification', 'adjudication', 'uxAcceptance']
        .map((name) => [name, compositionDigest(`numeric-${name}`)]))
};
const identity = createCompositionIdentity(inputs, {
    sourceCommit: 'b'.repeat(40), fsusUIBaselineIdentity: { ...baseline, baselineDigest: compositionDigest(baseline) }
});
const paint = () => ({ transform: 'none', perspective: 'none', filter: 'none', clipPath: 'none', maskImage: 'none',
    contain: 'none', overflowX: 'visible', overflowY: 'visible', zIndex: 'auto', isolation: 'auto' });
const rect = (left, top, width, height) => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height });

function refresh(model)
{
    model.domReceipt = structuredClone(analyzeCompositionDom({ archetype: model.archetype, ...model.currentDom,
        currentIdentity: model.currentDom.identity, observation: model.domObservation }));
    return model;
}

function appendNode(model, values, bounds)
{
    const index = model.domObservation.nodes.length;
    const attributes = {};
    for (const [field, marker] of Object.entries({ owner: 'owner', region: 'region', responsibility: 'chrome',
        action: 'action', priority: 'action-priority', surface: 'surface', material: 'material' }))
    {
        if (values[field])
        {
            attributes[`data-fsus-${marker}`] = values[field];
        }
    }
    const node = {
        index, parent: null, tag: 'section', sourceNode: `numeric-native-${index}`, sourceCall: `numeric-call-${index}`,
        owner: null, region: null, inheritedOwner: null, inheritedRegion: null,
        semanticRole: null, ariaLevel: null, action: null, priority: null, responsibility: null, inheritedChrome: null,
        surface: null, material: null, content: null, interactive: false,
        position: 'static', order: '0', flexDirection: 'row', hidden: false, visible: true, operable: true,
        ...values, attributes
    };
    model.domObservation.nodes.push(node);
    const file = `/numeric-only/upstream/region-${index}.vue`;
    model.currentDom.graph.nodes.push(
        { id: node.sourceNode, tag: node.tag, file, attributes, origin: { kind: 'native' } },
        { id: node.sourceCall, tag: 'NumericOnlySection', file: '/numeric-only/blog/Fixture.vue', attributes: {},
            definition: file, origin: { kind: 'fsusui-public', exportName: 'NumericOnlySection' } }
    );
    model.geometryObservation.nodes.push({ ...node, rect: bounds,
        computedVisibility: { display: 'block', visibility: 'visible', opacity: '1', contentVisibility: 'visible' } });
    model.chromeObservation.nodes.push({ ...node, rect: { ...bounds }, paint: paint() });
    return index;
}

function setRect(model, index, bounds)
{
    model.geometryObservation.nodes[index].rect = bounds;
    model.chromeObservation.nodes[index].rect = { ...bounds };
    const visible = !model.domObservation.nodes[index].hidden && bounds.width > 0 && bounds.height > 0;
    for (const observation of [model.domObservation, model.geometryObservation, model.chromeObservation])
    {
        observation.nodes[index].visible = visible;
    }
    return refresh(model);
}

function model(bandCount = 1)
{
    const archetype = structuredClone(inputs.matrix.archetypes[0]);
    const contract = archetype.compositionContract;
    // Test-only four-owner numeric input, not a scene/route/production contract.
    if (bandCount === 4)
    {
        contract.fixedChromeOwners[0].responsibility = 'command';
    }
    for (let index = 1; index < bandCount; index += 1)
    {
        const id = `numeric-band-${index}`;
        contract.allowedSecondaryRegions.push({ id, ownerId: `${id}-owner`, priority: 'secondary', placement: 'chrome' });
        contract.fixedChromeOwners.push({ id: `${id}-owner`, regionId: id, responsibility: ['mode', 'toolbar', 'status'][index - 1],
            cardinality: 1, authorityRef: contract.fixedChromeOwners[0].authorityRef });
        contract.surfaceRoles.push({ regionId: id, role: 'document', material: 'flat', authorityRef: 'fsusui-design' });
    }
    const envelope = { url: 'https://numeric-only.invalid/fixture', viewport: { width: 100, height: 100 } };
    const value = {
        archetype, currentDom: { graph: { schema: 'fsusblog.composition-source.v1', nodes: [], errors: [], upstreamRoot: '/numeric-only/upstream' },
            identity, runId: 'numeric-unit-only', runBinding: { worktree: '/numeric-only', analyzerDigest: compositionDigest('numeric-only') } },
        domObservation: { ...structuredClone(envelope), nodes: [] },
        geometryObservation: { ...structuredClone(envelope), scroll: { x: 0, y: 0 }, nodes: [] },
        chromeObservation: { ...structuredClone(envelope), scroll: { x: 0, y: 0 }, nodes: [],
            roots: ['html', 'body'].map((tag) => ({ tag, owner: null, region: null, paint: paint() })) }
    };
    const regions = [contract.primaryRegion, ...contract.allowedSecondaryRegions];
    const ordered = [...contract.contentOrder.map((id) => regions.find((region) => region.id === id)),
        ...regions.filter((region) => !contract.contentOrder.includes(region.id))];
    for (const region of ordered)
    {
        const band = contract.fixedChromeOwners.find((owner) => owner.regionId === region.id);
        const role = contract.surfaceRoles.find((surface) => surface.regionId === region.id);
        const bandIndex = contract.fixedChromeOwners.indexOf(band);
        const isPrimary = region.id === contract.primaryRegion.id;
        appendNode(value, { tag: region.id === contract.pageHeadingOwner.regionId ? 'h1' : 'section',
            owner: region.ownerId, region: region.id, inheritedOwner: region.ownerId, inheritedRegion: region.id,
            surface: role.role, material: role.material, responsibility: band?.responsibility ?? null,
            inheritedChrome: band?.responsibility ?? null, position: band ? 'fixed' : 'static' },
        isPrimary ? rect(10, 50, 60, 40) : band ? rect(0, bandIndex * 10, 100, 10) : rect(10, 45, 10, 2));
    }
    const primaryIndex = value.domObservation.nodes.find((node) => node.region === contract.primaryRegion.id).index;
    appendNode(value, { parent: primaryIndex, tag: 'button', inheritedOwner: contract.primaryRegion.ownerId,
        inheritedRegion: contract.primaryRegion.id, action: contract.actionPriority.primaryActionId,
        priority: 'primary', interactive: true }, rect(15, 55, 10, 10));
    return refresh(value);
}

const bandIndex = (value, index = 0) => value.domObservation.nodes.find((node) =>
    node.responsibility === value.archetype.compositionContract.fixedChromeOwners[index].responsibility).index;

function refused(value, reason)
{
    const result = compareCompositionChromeGeometry(value);
    assert.equal(result.rectangularCoveragePassed, false);
    assert.equal(result.fullGeometryVerified, false);
    assert.equal(result.fullVisualVerified, false);
    assert.ok([...result.errors, ...result.unsupported].some((entry) => entry.reason === reason), JSON.stringify(result));
    return result;
}

test('chrome numeric nonoverlap remains a rectangular diagnostic with unsupported anchor and paint', () =>
{
    const value = model();
    assert.deepEqual(value.domReceipt.errors, []);
    const result = compareCompositionChromeGeometry(value);
    assert.equal(result.rectangularCoveragePassed, true);
    assert.equal(result.qualification, 'diagnostic-only');
    assert.equal(result.slice, 'viewport-clipped-rectangular-chrome-band-coverage');
    assert.equal(result.fullGeometryVerified, false);
    assert.equal(result.fullVisualVerified, false);
    assert.equal(result.primaryVisualAnchor.status, 'unsupported');
    assert.ok(result.pendingGates.includes('full-paint-transform-stacking-occlusion'));
});

test('chrome numeric fixed footer covers primary at simulated 200 percent viewport geometry', () =>
{
    const value = model();
    for (const observation of [value.domObservation, value.geometryObservation, value.chromeObservation])
    {
        observation.viewport.height = 50;
    }
    const primary = value.domObservation.nodes.find((node) => node.region === value.archetype.compositionContract.primaryRegion.id);
    setRect(value, primary.index, rect(10, 30, 60, 20));
    setRect(value, bandIndex(value), rect(0, 40, 100, 10));
    const result = refused(value, 'primary-region-positive-area-band-intersection');
    assert.equal(result.errors[0].intersection.area, 600);
});

test('chrome numeric four command mode toolbar status bands use actual fixed or sticky positions', () =>
{
    const value = model(4);
    const index = bandIndex(value, 1);
    for (const observation of [value.domObservation, value.chromeObservation])
    {
        observation.nodes[index].position = 'sticky';
    }
    refresh(value);
    const result = compareCompositionChromeGeometry(value);
    assert.equal(result.rectangularCoveragePassed, true);
    assert.equal(result.bands.length, 4);
    assert.equal(result.bands[1].position, 'sticky');
    assert.deepEqual(result.bands.map((band) => band.responsibility), ['command', 'mode', 'toolbar', 'status']);
});

test('chrome numeric boundary contact is not positive area overlap or primary coverage', () =>
{
    const value = model(2);
    setRect(value, bandIndex(value, 1), rect(0, 10, 100, 40));
    assert.equal(compareCompositionChromeGeometry(value).rectangularCoveragePassed, true);
});

test('chrome numeric fractional different-owner overlap fails without pixel tolerance', () =>
{
    const value = model(2);
    setRect(value, bandIndex(value, 1), rect(0, 9.875, 100, 10));
    const result = refused(value, 'distinct-chrome-band-positive-area-overlap');
    assert.equal(result.errors[0].intersection.area, 12.5);
    assert.notEqual(result.errors[0].bands[0].owner, result.errors[0].bands[1].owner);
});

test('chrome numeric offscreen overlap is clipped to viewport and scroll is never added', () =>
{
    const value = model(2);
    setRect(value, bandIndex(value), rect(-20, -20, 10, 10));
    setRect(value, bandIndex(value, 1), rect(-20, -20, 10, 10));
    value.geometryObservation.scroll = { x: 500, y: 900 };
    value.chromeObservation.scroll = { x: 500, y: 900 };
    const result = compareCompositionChromeGeometry(value);
    assert.equal(result.rectangularCoveragePassed, true);
    assert.equal(result.bands.length, 0);
    assert.equal(result.excludedBands.length, 2);
    assert.ok(result.excludedBands.every((band) => band.reason === 'outside-viewport'));
});

test('chrome numeric hidden and zero-area bands are excluded but retain owner proof', () =>
{
    const value = model(2);
    const index = bandIndex(value);
    for (const observation of [value.domObservation, value.geometryObservation, value.chromeObservation])
    {
        observation.nodes[index].hidden = true;
        observation.nodes[index].visible = false;
    }
    value.geometryObservation.nodes[index].computedVisibility.display = 'none';
    setRect(value, bandIndex(value, 1), rect(0, 50, 100, 0));
    const result = compareCompositionChromeGeometry(refresh(value));
    assert.equal(result.rectangularCoveragePassed, true);
    assert.deepEqual(result.excludedBands.map((band) => band.reason), ['hidden', 'nonpositive-area']);
});

test('chrome numeric inert visible band still covers primary and flow chrome is excluded', () =>
{
    const value = model();
    value.domObservation.nodes[bandIndex(value)].operable = false;
    setRect(value, bandIndex(value), rect(0, 80, 100, 20));
    refused(value, 'primary-region-positive-area-band-intersection');
    for (const observation of [value.domObservation, value.chromeObservation])
    {
        observation.nodes[bandIndex(value)].position = 'static';
    }
    const result = compareCompositionChromeGeometry(refresh(value));
    assert.equal(result.rectangularCoveragePassed, true);
    assert.equal(result.excludedBands[0].reason, 'not-fixed-or-sticky');
});

test('chrome numeric nested band retains nearest owner region and exact child index', () =>
{
    const value = model();
    const parent = bandIndex(value);
    const owner = value.archetype.compositionContract.fixedChromeOwners[0];
    const root = value.domObservation.nodes[parent];
    root.responsibility = null;
    root.position = 'static';
    delete root.attributes['data-fsus-chrome'];
    value.chromeObservation.nodes[parent].position = 'static';
    const child = appendNode(value, { parent, inheritedOwner: owner.id, inheritedRegion: owner.regionId,
        responsibility: owner.responsibility, inheritedChrome: owner.responsibility, position: 'fixed' }, rect(0, 0, 100, 10));
    const result = compareCompositionChromeGeometry(refresh(value));
    assert.equal(result.rectangularCoveragePassed, true);
    assert.equal(result.bands[0].node, child);
    value.geometryObservation.nodes[child].inheritedOwner = 'mismatch';
    refused(value, 'geometry-correspondence-or-primary-visibility-unavailable');
});

test('chrome numeric missing mismatched indexes tags markers and positions remain unsupported', () =>
{
    for (const mutate of [
        (value) => value.geometryObservation.nodes.pop(),
        (value) =>
        {
            value.geometryObservation.nodes[0].index = 9;
        },
        (value) =>
        {
            value.geometryObservation.nodes[0].parent = 0;
        },
        (value) =>
        {
            value.geometryObservation.nodes[0].tag = 'aside';
        },
        (value) =>
        {
            value.geometryObservation.nodes[0].sourceNode = 'drift';
        },
        (value) =>
        {
            value.geometryObservation.nodes[0].sourceCall = 'drift';
        }
    ])
    {
        const value = model();
        mutate(value);
        refused(value, 'geometry-correspondence-or-primary-visibility-unavailable');
    }
    const value = model();
    value.chromeObservation.nodes[bandIndex(value)].position = 'sticky';
    refused(value, 'chrome-node-layout-or-position-correspondence-mismatch');
});

test('chrome numeric nonfinite inconsistent and malformed bounds never pass', () =>
{
    for (const bounds of [rect(0, 0, Infinity, 10), rect(NaN, 0, 10, 10), rect(0, 0, -1, 10),
        { ...rect(0, 0, 10, 10), right: 11 }])
    {
        const value = model();
        value.geometryObservation.nodes[bandIndex(value)].rect = bounds;
        refused(value, 'geometry-correspondence-or-primary-visibility-unavailable');
    }
    const value = model();
    value.chromeObservation.nodes[0].rect.top = NaN;
    refused(value, 'chrome-node-layout-or-position-correspondence-mismatch');
});

test('chrome numeric current source identity analyzer binding and duplicate source drift refuse', () =>
{
    for (const mutate of [
        (value) =>
        {
            value.currentDom.identity = { ...identity, sourceCommit: 'c'.repeat(40) };
        },
        (value) =>
        {
            value.currentDom.graph.errors.push({ reason: 'numeric-source-drift' });
        },
        (value) =>
        {
            value.currentDom.runBinding.analyzerDigest = compositionDigest('changed');
        },
        (value) =>
        {
            value.currentDom.graph.nodes.push({ ...value.currentDom.graph.nodes[0] });
        },
        (value) =>
        {
            value.domReceipt.observation.nodes[0].sourceNode = null;
        }
    ])
    {
        const value = model();
        mutate(value);
        refused(value, 'unproved-current-dom-source-owners');
    }
});

test('chrome numeric viewport url scroll visibility and supplemental capture drift refuse', () =>
{
    for (const mutate of [
        (value) =>
        {
            value.chromeObservation.viewport.width += 1;
        },
        (value) =>
        {
            value.chromeObservation.url = 'https://drift.invalid/';
        },
        (value) =>
        {
            value.chromeObservation.scroll.y = 1;
        },
        (value) =>
        {
            value.chromeObservation.nodes = [];
        },
        (value) =>
        {
            value.chromeObservation.roots = [];
        }
    ])
    {
        const value = model();
        mutate(value);
        refused(value, 'chrome-geometry-capture-correspondence-mismatch');
    }
    const value = model();
    value.chromeObservation.nodes[0].hidden = true;
    refused(value, 'chrome-node-layout-or-position-correspondence-mismatch');
});

test('chrome numeric transform ancestor clipping and unavailable stacking evidence remain unsupported', () =>
{
    for (const mutate of [
        (value) =>
        {
            value.chromeObservation.nodes[bandIndex(value)].paint.transform = 'matrix(1, 0, 0, 1, 0, 0)';
        },
        (value) =>
        {
            value.chromeObservation.roots[1].paint.overflowY = 'hidden';
        },
        (value) =>
        {
            value.chromeObservation.roots[0].paint.contain = 'paint';
        }
    ])
    {
        const value = model();
        mutate(value);
        refused(value, 'unsupported-transformed-or-clipped-rectangular-evidence');
    }
    const value = model();
    delete value.chromeObservation.nodes[0].paint.zIndex;
    refused(value, 'chrome-node-layout-or-position-correspondence-mismatch');
});

test('chrome numeric failed ownership proof missing primary and unavailable contract never pass', () =>
{
    const value = model();
    value.domObservation.nodes[bandIndex(value)].responsibility = 'undeclared';
    refresh(value);
    refused(value, 'dom-analysis-not-passed');
    refused({}, 'missing-or-malformed-chrome-primary-contract');
    const missing = model();
    missing.archetype.compositionContract.primaryVisualAnchor = null;
    refused(missing, 'missing-or-malformed-chrome-primary-contract');
    const offscreen = model();
    const primary = offscreen.domObservation.nodes.find((node) => node.region === offscreen.archetype.compositionContract.primaryRegion.id);
    setRect(offscreen, primary.index, rect(10, 100, 60, 40));
    refused(offscreen, 'geometry-correspondence-or-primary-visibility-unavailable');
});

test('chrome original runtime guard retains all pending states and refuses before product evaluation', async () =>
{
    const states = inputs.matrix.archetypes.flatMap((archetype) => archetype.compositionContract.requiredStateFixtures);
    assert.equal(states.length, 91);
    assert.equal(states.filter((state) => state.fixtureRef === null).length, 79);
    assert.ok(states.every((state) => state.bindingStatus === 'pending-current-run'));
    let evaluations = 0;
    const page = { evaluate()
    {
        evaluations += 1;
        throw new Error('product evaluation remains held');
    } };
    await assert.rejects(probeCompositionGeometryPage(page, { inputs }), /current runtime state\/capability bindings are pending/u);
    assert.equal(evaluations, 0);
});

test('chrome read-only capture measures real browser fixed sticky hidden inert and nested fixture layout', async (context) =>
{
    // Ordinary browser fixture only. No product route, receipt, native zoom,
    // semantic state binding or mocked DOMRect is supplied by this test.
    const require = createRequire(resolve(repositoryRoot, 'src/frontend/package.json'));
    const { chromium } = require('playwright');
    const { systemChromiumLaunchOptions } = await import(pathToFileURL(resolve(repositoryRoot, 'tests/frontend/support/system-chromium.mjs')));
    const browser = await chromium.launch(systemChromiumLaunchOptions({ headless: true }));
    context.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 200, height: 100 } });
    await page.setContent(`<style>
        body { margin: 0; }
        main { position: absolute; left: 10px; top: 60px; width: 100px; height: 40px; }
        footer { position: fixed; bottom: 0; left: 0; width: 200px; height: 20px; }
        nav { position: sticky; top: 0; height: 10px; }
        [hidden] { display: none; }
        </style><div data-fsus-owner="fixture-shell" data-fsus-region="fixture-chrome">
        <nav data-fsus-composition-node="fixture-nav">Fixture sticky band</nav></div>
        <main data-fsus-composition-node="fixture-primary">Fixture primary</main>
        <footer inert data-fsus-composition-node="fixture-footer">Fixture inert band</footer>
        <aside hidden data-fsus-composition-node="fixture-hidden">Fixture hidden</aside>`);
    const before = await page.content();
    const dom = await page.evaluate(captureCompositionDom);
    const geometry = await page.evaluate(captureCompositionGeometry);
    const chrome = await page.evaluate(captureCompositionChromeGeometry);
    assert.equal(await page.content(), before);
    assert.deepEqual(chrome.viewport, { width: 200, height: 100 });
    assert.deepEqual(chrome.scroll, geometry.scroll);
    assert.equal(chrome.nodes.length, dom.nodes.length);
    for (const observed of chrome.nodes)
    {
        const original = dom.nodes[observed.index];
        assert.equal(observed.position, original.position);
        assert.equal(observed.parent, original.parent);
        assert.equal(observed.sourceNode, original.sourceNode);
        assert.equal(observed.inheritedOwner, original.inheritedOwner);
        assert.deepEqual(observed.rect, geometry.nodes[observed.index].rect);
        assert.equal(observed.hidden, geometry.nodes[observed.index].hidden);
    }
    const footer = chrome.nodes.find((node) => node.sourceNode === 'fixture-footer');
    const primary = chrome.nodes.find((node) => node.sourceNode === 'fixture-primary');
    const sticky = chrome.nodes.find((node) => node.sourceNode === 'fixture-nav');
    assert.equal(footer.position, 'fixed');
    assert.deepEqual(footer.rect, rect(0, 80, 200, 20));
    assert.equal(dom.nodes[footer.index].operable, false);
    assert.equal(footer.visible, true);
    assert.ok(footer.rect.top < primary.rect.bottom && footer.rect.bottom > primary.rect.top);
    assert.equal(sticky.position, 'sticky');
    assert.equal(sticky.inheritedOwner, 'fixture-shell');
    assert.equal(chrome.nodes.find((node) => node.sourceNode === 'fixture-hidden').visible, false);
});
