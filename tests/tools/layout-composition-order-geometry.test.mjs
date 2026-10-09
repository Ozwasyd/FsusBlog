import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

import { loadCompositionInputs } from '@fsusblog/layout-governance/composition-contracts';
import { captureCompositionDom } from '@fsusblog/layout-governance/composition-dom';

import { captureCompositionGeometry, probeCompositionGeometryPage } from '@fsusblog/layout-governance/composition-geometry';
import { captureCompositionOrderGeometry, compareCompositionOrderGeometry } from '@fsusblog/layout-governance/composition-order-geometry';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const inputs = loadCompositionInputs({ repositoryRoot });
const feed = inputs.matrix.archetypes.find((entry) => entry.kind === 'feed');
const requireFrontend = createRequire(resolve(repositoryRoot, 'src/frontend/package.json'));

// These numeric observations and narrowed contracts exercise bounded logic only.
// They do not supply admitted source ownership, state binding or product evidence.
function fixture()
{
    const archetype = structuredClone(feed);
    archetype.compositionContract.contentOrder = feed.compositionContract.contentOrder.slice(0, 2);
    const contract = archetype.compositionContract;
    const regions = [contract.primaryRegion, ...contract.allowedSecondaryRegions];
    const layout = { writingMode: 'horizontal-tb', direction: 'ltr', transform: 'none', translate: 'none', rotate: 'none',
        scale: 'none', perspective: 'none', columnCount: 'auto', columnWidth: 'auto', fragmentCount: 1 };
    const nodes = contract.contentOrder.map((id, index) =>
    {
        const owner = regions.find((region) => region.id === id).ownerId;
        return { index, parent: null, tag: 'section', sourceNode: `numeric-fixture-${index}`, sourceCall: null,
            owner, region: id, inheritedOwner: owner, inheritedRegion: id, hidden: false, visible: true };
    });
    const page = { url: 'https://numeric-fixture.invalid/', viewport: { width: 100, height: 80 } };
    const observation = { archetype, domObservation: { ...page, nodes: structuredClone(nodes) },
        geometryObservation: { ...page, scroll: { x: 0, y: 0 }, nodes: nodes.map((node) => ({ ...node,
            computedVisibility: { display: 'block', visibility: 'visible', opacity: '1', contentVisibility: 'visible' } })) },
        orderObservation: { ...page, scroll: { x: 0, y: 0 }, rootLayouts: [structuredClone(layout), structuredClone(layout)],
            nodes: nodes.map((node) => ({ ...node, layout: structuredClone(layout),
                computedVisibility: { display: 'block', visibility: 'visible', opacity: '1', contentVisibility: 'visible' } })) } };
    setRect(observation, 0, 0, 0, 20, 20);
    setRect(observation, 1, 0, 20, 20, 20);
    return observation;
}

function setRect(observation, index, left, top, width, height)
{
    const rect = { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
    observation.geometryObservation.nodes[index].rect = { ...rect };
    observation.orderObservation.nodes[index].rect = { ...rect };
}

function rejected(observation, reason)
{
    const result = compareCompositionOrderGeometry(observation);
    assert.equal(result.observationsPassed, false);
    assert.equal(result.fullGeometryVerified, false);
    assert.equal(result.fullVisualVerified, false);
    assert.ok([...result.errors, ...result.unresolved].length > 0);
    assert.ok(result.checkedPredicates.every(({ passed }) => passed === false));
    if (reason)
    {
        assert.ok([...result.errors, ...result.unresolved].some((error) => error.reason === reason), JSON.stringify(result));
    }
    return result;
}

test('order geometry numeric block flow is diagnostic only', () =>
{
    const result = compareCompositionOrderGeometry(fixture());
    assert.equal(result.observationsPassed, true);
    assert.equal(result.qualification, 'diagnostic-only');
    assert.equal(result.fullGeometryVerified, false);
    assert.equal(result.fullVisualVerified, false);
    assert.deepEqual(result.checkedPredicates[0].regionIds, fixture().archetype.compositionContract.contentOrder);
    assert.equal(result.relationships.length, 1);
    assert.ok(result.pendingGates.includes('source-dom-admission'));
});

test('order geometry numeric inversion uses bounds despite unchanged DOM order', () =>
{
    const observation = fixture();
    setRect(observation, 0, 0, 40, 20, 20);
    assert.deepEqual(observation.domObservation.nodes.map(({ region }) => region), observation.archetype.compositionContract.contentOrder);
    rejected(observation, 'visible-peer-region-inversion');
});

test('order geometry numeric same row is retained and overlap unresolved', () =>
{
    const observation = fixture();
    setRect(observation, 1, 20, 0, 20, 30);
    const result = compareCompositionOrderGeometry(observation);
    assert.equal(result.observationsPassed, true);
    assert.equal(result.relationships[0].kind, 'same-block-start');
    setRect(observation, 1, 20, 1, 20, 30);
    rejected(observation, 'ambiguous-peer-block-overlap');
    setRect(observation, 1, 0, 0, 20, 20);
    rejected(observation, 'ambiguous-peer-block-overlap');
});

test('order geometry numeric hidden and missing duplicate or unowned regions fail', () =>
{
    const hidden = fixture();
    for (const capture of ['domObservation', 'geometryObservation', 'orderObservation'])
    {
        hidden[capture].nodes[1].hidden = true;
        hidden[capture].nodes[1].visible = false;
    }
    rejected(hidden, 'content-order-region-hidden');
    for (const field of ['region', 'owner', 'sourceNode'])
    {
        const observation = fixture();
        for (const capture of ['domObservation', 'geometryObservation', 'orderObservation'])
        {
            observation[capture].nodes[1][field] = null;
        }
        rejected(observation, 'region-owner-source-not-exact-one');
    }
    const duplicate = fixture();
    for (const capture of ['domObservation', 'geometryObservation', 'orderObservation'])
    {
        duplicate[capture].nodes.push({ ...structuredClone(duplicate[capture].nodes[1]), index: 2 });
    }
    rejected(duplicate, 'region-owner-source-not-exact-one');
});

test('order geometry numeric unsupported arrangements never pass', () =>
{
    for (const [field, value] of [['transform', 'matrix(1, 0, 0, 1, 0, 0)'], ['translate', '0px'], ['rotate', '0deg'],
        ['scale', '1'], ['perspective', '100px'], ['columnCount', '2'], ['columnWidth', '20px'],
        ['fragmentCount', 2], ['direction', 'unknown'], ['writingMode', 'sideways-rl']])
    {
        const observation = fixture();
        observation.orderObservation.rootLayouts[1][field] = value;
        rejected(observation, 'unsupported-flow-arrangement');
    }
    const mixed = fixture();
    mixed.orderObservation.nodes[1].layout.writingMode = 'vertical-rl';
    rejected(mixed, 'unsupported-flow-arrangement');
});

test('order geometry numeric RTL and vertical block directions are observed', () =>
{
    for (const writingMode of ['horizontal-tb', 'vertical-lr', 'vertical-rl'])
    {
        const observation = fixture();
        for (const layout of [...observation.orderObservation.rootLayouts, ...observation.orderObservation.nodes.map((node) => node.layout)])
        {
            layout.writingMode = writingMode;
            layout.direction = 'rtl';
        }
        if (writingMode !== 'horizontal-tb')
        {
            setRect(observation, 0, writingMode === 'vertical-rl' ? 40 : 0, 0, 20, 20);
            setRect(observation, 1, 20, 0, 20, 20);
        }
        assert.equal(compareCompositionOrderGeometry(observation).observationsPassed, true);
        const first = observation.geometryObservation.nodes[0].rect;
        const second = observation.geometryObservation.nodes[1].rect;
        setRect(observation, 0, second.left, second.top, second.width, second.height);
        setRect(observation, 1, first.left, first.top, first.width, first.height);
        rejected(observation, 'visible-peer-region-inversion');
    }
});

test('order geometry numeric viewport bounds never add scroll offsets', () =>
{
    const observation = fixture();
    setRect(observation, 0, 0, -200, 20, 20);
    setRect(observation, 1, 0, -180, 20, 20);
    for (const capture of ['geometryObservation', 'orderObservation'])
    {
        observation[capture].scroll = { x: 300, y: 900 };
    }
    const result = compareCompositionOrderGeometry(observation);
    assert.equal(result.observationsPassed, true);
    assert.equal(result.relationships[0].beforeRect.top, -200);
    // Offscreen alone is not hiding, and first-fold is owned by the other predicate.
    assert.equal(result.checkedPredicates.length, 1);
});

test('order geometry malformed contracts and observations remain explicit', () =>
{
    for (const observation of [undefined, {}, { archetype: feed }])
    {
        rejected(observation);
    }
    for (const mutate of [
        (contract) =>
        {
            contract.contentOrder = [];
        },
        (contract) =>
        {
            contract.contentOrder.push(contract.contentOrder[0]);
        },
        (contract) =>
        {
            contract.contentOrder[0] = 'unknown-region';
        },
        (contract) =>
        {
            contract.firstFoldInvariants = null;
        },
        (contract) =>
        {
            contract.allowedSurfaceNesting.pairs = [null];
        },
        (contract) =>
        {
            contract.allowedSurfaceNesting.pairs = [{ parentRegionId: contract.contentOrder[0], childRegionId: contract.contentOrder[1] },
                { parentRegionId: contract.contentOrder[1], childRegionId: contract.contentOrder[0] }];
        }
    ])
    {
        const observation = fixture();
        mutate(observation.archetype.compositionContract);
        rejected(observation);
    }
    for (const capture of ['domObservation', 'geometryObservation', 'orderObservation'])
    {
        for (const nodes of [null, [], [null]])
        {
            const observation = fixture();
            observation[capture].nodes = nodes;
            rejected(observation);
        }
    }
});

test('order geometry invalid rects and capture correspondence never pass', () =>
{
    for (const field of ['x', 'y', 'left', 'top', 'right', 'bottom', 'width', 'height'])
    {
        for (const value of [null, '20', NaN, Infinity, -Infinity])
        {
            const observation = fixture();
            observation.geometryObservation.nodes[0].rect[field] = value;
            rejected(observation, 'malformed-node-observation');
        }
    }
    const invalid = fixture();
    setRect(invalid, 0, 0, 0, -20, 20);
    rejected(invalid, 'malformed-node-observation');
    for (const field of ['index', 'parent', 'tag', 'sourceNode', 'sourceCall', 'owner', 'region', 'inheritedOwner', 'inheritedRegion'])
    {
        const observation = fixture();
        observation.orderObservation.nodes[1][field] = field === 'index' || field === 'parent' ? 100 : 'different';
        rejected(observation);
    }
    for (const mutate of [
        (observation) =>
        {
            observation.orderObservation.viewport.width += 1;
        },
        (observation) =>
        {
            observation.orderObservation.url += 'changed';
        },
        (observation) =>
        {
            observation.orderObservation.scroll.y += 1;
        },
        (observation) =>
        {
            observation.orderObservation.nodes[0].rect.top += 1;
        },
        (observation) =>
        {
            observation.geometryObservation.nodes[0].computedVisibility.opacity = 'NaN';
        },
        (observation) =>
        {
            observation.orderObservation.rootLayouts = [];
        }
    ])
    {
        const observation = fixture();
        mutate(observation);
        rejected(observation);
    }
});

test('order geometry numeric declared nesting is not flattened into sibling order', () =>
{
    const observation = fixture();
    const [parentRegionId, childRegionId] = observation.archetype.compositionContract.contentOrder;
    observation.archetype.compositionContract.allowedSurfaceNesting.pairs = [{ parentRegionId, childRegionId }];
    for (const capture of ['domObservation', 'geometryObservation', 'orderObservation'])
    {
        observation[capture].nodes[1].parent = 0;
    }
    setRect(observation, 1, 0, -20, 20, 20);
    const result = compareCompositionOrderGeometry(observation);
    assert.equal(result.observationsPassed, true);
    assert.deepEqual(result.relationships, [{ kind: 'declared-ancestry', parentRegionId, childRegionId, passed: true }]);
    for (const capture of ['domObservation', 'geometryObservation', 'orderObservation'])
    {
        observation[capture].nodes[1].parent = null;
    }
    rejected(observation, 'declared-region-ancestry-mismatch');
    observation.archetype.compositionContract.allowedSurfaceNesting.pairs = [];
    for (const capture of ['domObservation', 'geometryObservation', 'orderObservation'])
    {
        observation[capture].nodes[1].parent = 0;
    }
    rejected(observation, 'declared-region-ancestry-mismatch');
});

test('order geometry pending runtime guard still refuses before browser evaluation', async () =>
{
    const states = inputs.matrix.archetypes.flatMap((entry) => entry.compositionContract.requiredStateFixtures);
    assert.equal(states.filter(({ bindingStatus }) => bindingStatus === 'pending-current-run').length, 91);
    assert.equal(states.filter(({ fixtureRef }) => fixtureRef === null).length, 79);
    let evaluations = 0;
    await assert.rejects(probeCompositionGeometryPage({ evaluate()
    {
        evaluations += 1;
        throw new Error('unreachable browser evaluation');
    } }, { inputs }), /current runtime state\/capability bindings are pending/u);
    assert.equal(evaluations, 0);
});

test('order geometry real Chromium fixtures observe responsive flow and explicit limits', async (context) =>
{
    const { chromium } = requireFrontend('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    context.after(async () => browser.close());
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const regions = (archetype) => [archetype.compositionContract.primaryRegion, ...archetype.compositionContract.allowedSecondaryRegions];
    const markup = (archetype, extraCss = '', mode = 'horizontal-tb', direction = 'ltr', flatten = false) =>
    {
        const contract = archetype.compositionContract;
        const render = (id) =>
        {
            const owner = regions(archetype).find((region) => region.id === id).ownerId;
            const children = flatten ? [] : contract.allowedSurfaceNesting.pairs.filter((pair) => pair.parentRegionId === id);
            return `<section data-fsus-composition-node="fixture-${id}" data-fsus-owner="${owner}" data-fsus-region="${id}">${children.map((pair) => render(pair.childRegionId)).join('')}</section>`;
        };
        return `<!doctype html><html style="writing-mode:${mode};direction:${direction}"><head><style>
            body{margin:0}main{display:block;inline-size:300px}section{display:block;block-size:40px;inline-size:80px}
            section:has(section){block-size:100px}${extraCss}</style></head><body><main>${contract.contentOrder
                .filter((id) => flatten || !contract.allowedSurfaceNesting.pairs.some((pair) => pair.childRegionId === id)).map(render).join('')}</main></body></html>`;
    };
    const capture = async (archetype = feed) => ({ archetype,
        domObservation: await page.evaluate(captureCompositionDom),
        geometryObservation: await page.evaluate(captureCompositionGeometry),
        orderObservation: await page.evaluate(captureCompositionOrderGeometry) });
    const observe = async (html, archetype = feed) =>
    {
        await page.setContent(html);
        await page.evaluate(() => globalThis.scrollTo(0, 0));
        return capture(archetype);
    };
    // Markers here belong only to this literal fixture document. There is no
    // product page, verified source graph, runtime binding or accepted receipt.
    const primaryId = feed.compositionContract.primaryRegion.id;
    const headingId = feed.compositionContract.contentOrder[0];
    const responsive = markup(feed, `main{display:flex;flex-direction:column}
        @media(max-width:500px){[data-fsus-region="${primaryId}"]{order:-1}}`);
    assert.equal(compareCompositionOrderGeometry(await observe(responsive)).observationsPassed, true);
    await page.setViewportSize({ width: 375, height: 768 });
    const mobile = await capture();
    assert.deepEqual(mobile.domObservation.nodes.filter((node) => node.region).map((node) => node.region), feed.compositionContract.contentOrder);
    rejected(mobile, 'visible-peer-region-inversion');
    await page.setViewportSize({ width: 1366, height: 768 });
    for (const css of ['display:none', 'visibility:hidden', 'opacity:0'])
    {
        rejected(await observe(markup(feed, `[data-fsus-region="${primaryId}"]{${css}}`)), 'content-order-region-hidden');
    }
    const positioned = await observe(markup(feed, `main{position:relative}[data-fsus-region="${headingId}"]{position:relative;top:80px}`));
    assert.ok(positioned.domObservation.nodes.filter((node) => node.region).every((node) => node.order === '0'));
    rejected(positioned, 'visible-peer-region-inversion');
    assert.equal(compareCompositionOrderGeometry(await observe(markup(feed, 'main{display:flex;flex-direction:row}'))).observationsPassed, true);
    for (const mode of ['horizontal-tb', 'vertical-lr', 'vertical-rl'])
    {
        const observed = await observe(markup(feed, '', mode, 'rtl'));
        assert.equal(compareCompositionOrderGeometry(observed).observationsPassed, true, mode);
        assert.ok(observed.orderObservation.nodes.filter((node) => node.region).every((node) => node.layout.writingMode === mode && node.layout.direction === 'rtl'));
        const inverted = await observe(markup(feed, 'main{display:flex;flex-direction:column-reverse}', mode, 'rtl'));
        rejected(inverted, 'visible-peer-region-inversion');
    }
    const nested = inputs.matrix.archetypes.find((entry) => entry.kind === 'filter-search');
    const nestedResult = compareCompositionOrderGeometry(await observe(markup(nested), nested));
    assert.equal(nestedResult.observationsPassed, true);
    assert.ok(nestedResult.relationships.some((relation) => relation.kind === 'declared-ancestry'));
    assert.ok(!nestedResult.relationships.some((relation) => relation.beforeRegionId === 'search-filter' || relation.afterRegionId === 'search-filter'));
    rejected(await observe(markup(nested, '', 'horizontal-tb', 'ltr', true), nested), 'declared-region-ancestry-mismatch');
    for (const css of ['main{transform:translateX(1px)}', 'main{columns:2}', 'main{column-width:80px}', 'html{rotate:0deg}'])
    {
        rejected(await observe(markup(feed, css)), 'unsupported-flow-arrangement');
    }
    const duplicate = markup(feed).replace('</main>', `<section data-fsus-composition-node="fixture-duplicate" data-fsus-owner="${feed.compositionContract.primaryRegion.ownerId}" data-fsus-region="${primaryId}"></section></main>`);
    rejected(await observe(duplicate), 'region-owner-source-not-exact-one');
    rejected(await observe(markup(feed).replace(`data-fsus-region="${primaryId}"`, '')), 'region-owner-source-not-exact-one');
    const scrolled = await observe(markup(feed, 'body{min-height:2000px}'));
    await page.evaluate(() => globalThis.scrollTo(0, 600));
    const afterScroll = await capture();
    assert.equal(afterScroll.geometryObservation.scroll.y, 600);
    const scrollResult = compareCompositionOrderGeometry(afterScroll);
    assert.equal(scrollResult.observationsPassed, true);
    assert.equal(scrollResult.relationships[0].beforeRect.top, scrolled.geometryObservation.nodes.find((node) => node.region === headingId).rect.top - 600);
    const beforeRead = await page.content();
    await capture();
    assert.equal(await page.content(), beforeRead, 'all three captures preserve the literal fixture DOM');
});
