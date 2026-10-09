import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// Explicit source paths keep this two-file slice independent of owner-held exports.
const repositoryRoot = resolve(import.meta.dirname, '../..');
const { loadCompositionInputs } = await import(pathToFileURL(resolve(repositoryRoot, 'tests/frontend/support/layout/compositionContracts.mjs')));
const { compareCompositionGeometry, probeCompositionGeometryPage } = await import(pathToFileURL(resolve(repositoryRoot, 'tests/frontend/support/layout/compositionGeometry.mjs')));
const inputs = loadCompositionInputs({ repositoryRoot });
const archetype = inputs.matrix.archetypes[0];

// Controlled numeric observations prove comparison logic only. No browser, DOM,
// fixture, runtime binding, product evidence or acceptance is supplied here.
function observations()
{
    const primary = archetype.compositionContract.primaryRegion;
    const node = { index: 0, parent: null, tag: 'section', sourceNode: 'unit-comparison-node', sourceCall: null,
        owner: primary.ownerId, region: primary.id, inheritedOwner: primary.ownerId, inheritedRegion: primary.id,
        hidden: false, visible: true };
    return {
        archetype,
        domObservation: { url: 'https://unit.invalid/comparison', viewport: { width: 100, height: 80 }, nodes: [{ ...node }] },
        geometryObservation: { url: 'https://unit.invalid/comparison', viewport: { width: 100, height: 80 }, scroll: { x: 0, y: 0 },
            nodes: [{ ...node, rect: { x: 10, y: 10, top: 10, left: 10, right: 30, bottom: 30, width: 20, height: 20 },
                computedVisibility: { display: 'block', visibility: 'visible', opacity: '1', contentVisibility: 'visible' } }] }
    };
}

function setRect(observation, left, top, width, height)
{
    observation.geometryObservation.nodes[0].rect = { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height };
    observation.geometryObservation.nodes[0].visible = width > 0 && height > 0;
}

function rejected(observation)
{
    const result = compareCompositionGeometry(observation);
    assert.equal(result.observationsPassed, false);
    assert.equal(result.fullGeometryVerified, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.checkedPredicates.every(({ passed }) => passed === false));
    return result;
}

test('geometry finite visible primary is a partial diagnostic', () =>
{
    const result = compareCompositionGeometry(observations());
    const invariant = archetype.compositionContract.firstFoldInvariants.find(({ predicate }) => predicate === 'primary-content-visible');
    assert.equal(result.observationsPassed, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.checkedPredicates, [{ id: invariant.id, predicate: invariant.predicate, regionId: invariant.regionId, passed: true }]);
    assert.equal(result.qualification, 'diagnostic-only');
    assert.equal(result.fullGeometryVerified, false);
    assert.equal(result.fullVisualVerified, false);
    assert.deepEqual(result.pendingPredicates, archetype.compositionContract.firstFoldInvariants.filter(({ predicate }) => predicate !== 'primary-content-visible'));
    assert.deepEqual(result.pendingGates, ['full-occlusion', 'focus', 'surface', 'a11y', 'native-zoom', 'required-current-state-matrix']);
});

test('geometry positive viewport intersection uses fractional bounds without scroll offsets', () =>
{
    for (const [left, top, width, height] of [[-1, 1, 1.25, 0.25], [99.75, 1, 1, 1], [1, -1, 1, 1.25], [1, 79.75, 1, 1]])
    {
        const observation = observations();
        setRect(observation, left, top, width, height);
        observation.geometryObservation.scroll = { x: 500, y: -200 };
        assert.equal(compareCompositionGeometry(observation).observationsPassed, true);
    }
});

test('geometry edge contact and offscreen bounds fail intersection', () =>
{
    for (const [left, top] of [[-20, 10], [100, 10], [10, -20], [10, 80], [-21, 10], [101, 10], [10, -21], [10, 81]])
    {
        const observation = observations();
        setRect(observation, left, top, 20, 20);
        assert.ok(rejected(observation).errors.some(({ reason }) => reason === 'primary-content-outside-viewport'));
    }
});

test('geometry nonfinite or nonnumeric rectangle values fail', () =>
{
    for (const field of ['x', 'y', 'top', 'right', 'bottom', 'left', 'width', 'height'])
    {
        for (const value of [NaN, Infinity, -Infinity, '10', null, undefined])
        {
            const observation = observations();
            observation.geometryObservation.nodes[0].rect[field] = value;
            rejected(observation);
        }
    }
});

test('geometry invalid viewport or scroll values fail', () =>
{
    for (const field of ['width', 'height'])
    {
        for (const value of [0, -1, NaN, Infinity, '100', null, undefined])
        {
            const observation = observations();
            observation.geometryObservation.viewport[field] = value;
            rejected(observation);
        }
    }
    for (const field of ['x', 'y'])
    {
        for (const value of [NaN, Infinity, '0', null, undefined])
        {
            const observation = observations();
            observation.geometryObservation.scroll[field] = value;
            rejected(observation);
        }
    }
});

test('geometry nonpositive or inverted primary area fails', () =>
{
    for (const [width, height] of [[0, 20], [20, 0], [-1, 20], [20, -1]])
    {
        const observation = observations();
        setRect(observation, 10, 10, width, height);
        rejected(observation);
    }
    for (const field of ['right', 'bottom'])
    {
        const observation = observations();
        observation.geometryObservation.nodes[0].rect[field] = 9;
        rejected(observation);
    }
});

test('geometry hidden primary and inconsistent computed visibility fail', () =>
{
    for (const capture of ['domObservation', 'geometryObservation'])
    {
        const observation = observations();
        observation[capture].nodes[0].hidden = true;
        observation[capture].nodes[0].visible = false;
        rejected(observation);
    }
    for (const [field, value] of [['display', 'none'], ['visibility', 'hidden'], ['opacity', '0'], ['opacity', 'NaN'], ['opacity', '2'], ['contentVisibility', 'hidden']])
    {
        const observation = observations();
        observation.geometryObservation.nodes[0].computedVisibility[field] = value;
        rejected(observation);
    }
});

test('geometry exact node and page correspondence mismatches fail', () =>
{
    for (const field of ['index', 'parent', 'tag', 'sourceNode', 'sourceCall', 'owner', 'region', 'inheritedOwner', 'inheritedRegion'])
    {
        const observation = observations();
        observation.geometryObservation.nodes[0][field] = field === 'index' || field === 'parent' ? 1 : 'changed-unit-value';
        rejected(observation);
    }
    const count = observations();
    count.geometryObservation.nodes.push(structuredClone(count.geometryObservation.nodes[0]));
    rejected(count);
    const url = observations();
    url.geometryObservation.url += '/changed';
    rejected(url);
    const viewport = observations();
    viewport.geometryObservation.viewport.width += 1;
    rejected(viewport);
});

test('geometry missing or malformed observations never pass', () =>
{
    for (const observation of [undefined, {}, { archetype }, { archetype, domObservation: {}, geometryObservation: {} }])
    {
        rejected(observation);
    }
    for (const capture of ['domObservation', 'geometryObservation'])
    {
        for (const nodes of [[], {}, null, [null]])
        {
            const observation = observations();
            observation[capture].nodes = nodes;
            rejected(observation);
        }
        for (const field of ['index', 'parent', 'tag', 'sourceNode', 'sourceCall', 'owner', 'region', 'inheritedOwner', 'inheritedRegion', 'hidden', 'visible'])
        {
            const observation = observations();
            delete observation[capture].nodes[0][field];
            rejected(observation);
        }
    }
    const rect = observations();
    delete rect.geometryObservation.nodes[0].rect;
    rejected(rect);
    const style = observations();
    delete style.geometryObservation.nodes[0].computedVisibility;
    rejected(style);
});

test('geometry predicate must target the canonical primary region', () =>
{
    for (const change of ['missing', 'duplicate', 'different-region'])
    {
        const observation = observations();
        observation.archetype = structuredClone(archetype);
        const contract = observation.archetype.compositionContract;
        const invariant = contract.firstFoldInvariants.find(({ predicate }) => predicate === 'primary-content-visible');
        if (change === 'missing')
        {
            contract.firstFoldInvariants = contract.firstFoldInvariants.filter((item) => item !== invariant);
        }
        else if (change === 'duplicate')
        {
            contract.firstFoldInvariants.push({ ...invariant });
        }
        else
        {
            invariant.regionId = contract.allowedSecondaryRegions[0].id;
        }
        rejected(observation);
    }
});

test('geometry missing duplicate or wrongly owned primary fails', () =>
{
    const missing = observations();
    missing.domObservation.nodes[0].region = null;
    missing.geometryObservation.nodes[0].region = null;
    rejected(missing);
    const duplicate = observations();
    for (const capture of ['domObservation', 'geometryObservation'])
    {
        duplicate[capture].nodes.push({ ...structuredClone(duplicate[capture].nodes[0]), index: 1, parent: 0 });
    }
    rejected(duplicate);
    const owner = observations();
    owner.domObservation.nodes[0].owner = null;
    owner.geometryObservation.nodes[0].owner = null;
    rejected(owner);
});

test('geometry actual pending inputs refuse before browser evaluation', async () =>
{
    const states = inputs.matrix.archetypes.flatMap((entry) => entry.compositionContract.requiredStateFixtures);
    assert.equal(states.filter(({ bindingStatus }) => bindingStatus === 'pending-current-run').length, 91);
    assert.equal(states.filter(({ fixtureRef }) => fixtureRef === null).length, 79);
    let evaluations = 0;
    const page = { evaluate()
    {
        evaluations += 1;
        throw new Error('browser evaluation must remain unreachable');
    } };
    await assert.rejects(probeCompositionGeometryPage(page, { inputs, archetypeId: `${archetype.surface}/${archetype.kind}`,
        stateId: archetype.compositionContract.requiredStateFixtures[0].id,
        identity: null, currentIdentity: null, runId: null, runBinding: null }), /current runtime state\/capability bindings are pending/u);
    assert.equal(evaluations, 0);
});

test('geometry malformed inputs refuse before browser evaluation', async () =>
{
    let evaluations = 0;
    const page = { evaluate()
    {
        evaluations += 1;
        throw new Error('browser evaluation must remain unreachable');
    } };
    await assert.rejects(probeCompositionGeometryPage(page, { inputs: { ...inputs, matrix: {} } }), /layout-composition-contract/u);
    assert.equal(evaluations, 0);
});
