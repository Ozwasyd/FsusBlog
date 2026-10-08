import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadCompositionInputs } from '@fsusblog/layout-governance/composition-contracts';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
// Resolve only this owned module in its actual checkout. No test loader is
// passed to the consumer or used as producer authority.
const { inspectCompositionObservationDiagnostic, projectCompositionSceneState } = await import(
    new URL('../frontend/support/layout/visualCompositionObservation.mjs', import.meta.url).href);
const inputs = loadCompositionInputs({ repositoryRoot });
const settings = inputs.matrix.archetypes.find((entry) => entry.surface === 'admin' && entry.kind === 'settings');
const scene = (state) => ({ archetype: 'admin/settings', routePattern: settings.path, state });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
const options = (state = 'tab-media') => ({ scene: scene(state), runId: `diagnostic-consumer-test-${process.pid}`,
    expectedSourceCommit: commit, fsusUIRoot: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT });
let apiAvailable = true;
try
{
    import.meta.resolve('@fsusblog/layout-governance/composition-analyzer');
}
catch
{
    apiAvailable = false;
}

test('Settings state ID maps to analyzer case ID without replacing the semantic value', () =>
{
    for (const state of settings.compositionContract.requiredStateFixtures)
    {
        const result = projectCompositionSceneState(inputs, scene(state.id));
        assert.deepEqual(result.state, { [state.dimensionId]: state.id });
        assert.equal(result.selection.value, state.value);
        assert.equal(result.selection.fixtureRef, state.fixtureRef);
        assert.equal(result.runtimeStateAdmission, 'not-observed');
        assert.equal(result.qualificationEligible, false);
    }
    const site = projectCompositionSceneState(inputs, scene('tab-site'));
    assert.deepEqual(site.state, { 'settings-task-tab': 'tab-site' });
    assert.equal(site.selection.value, 'site');
    assert.equal(site.exclusiveActionState.primaryActionId, 'save-site-settings');
    assert.equal(projectCompositionSceneState(inputs, scene('tab-media')).exclusiveActionState.primaryCardinality, 0);
});

test('loading, brand and save state never default to a Settings tab', () =>
{
    for (const state of ['loaded', 'brand-uploading', 'save-success'])
    {
        const result = projectCompositionSceneState(inputs, scene(state));
        assert.equal(result.exclusiveActionState, null);
        assert.equal(Object.hasOwn(result.state, 'settings-task-tab'), false);
    }
});

test('semantic value, unknown and cross-archetype state IDs cannot select an action', () =>
{
    for (const state of ['site', 'media', 'synthetic-other-state', 'reader-loading', null])
    {
        assert.throws(() => projectCompositionSceneState(inputs, scene(state)), { code: 'composition-diagnostic-state-unregistered' });
    }
});

test('route, mode and caller state overrides are not scene authority', () =>
{
    assert.throws(() => projectCompositionSceneState(inputs, { ...scene('tab-site'), routePattern: '/manage/settings' }),
        { code: 'composition-diagnostic-scene-unregistered' });
    assert.throws(() => projectCompositionSceneState(inputs, { ...scene('tab-site'), mode: 'published' }),
        { code: 'composition-diagnostic-scene-invalid' });
    assert.throws(() => projectCompositionSceneState(inputs, { ...scene('loaded'), stateOverride: { 'settings-task-tab': 'tab-site' } }),
        { code: 'composition-diagnostic-scene-invalid' });
});

for (const field of ['repositoryRoot', 'module', 'loader', 'graph', 'identity', 'verify', 'registry', 'state'])
{
    test(`caller ${field} cannot substitute a canonical producer or binding`, async () =>
    {
        await assert.rejects(inspectCompositionObservationDiagnostic({ ...options(), [field]: {} }),
            { code: 'composition-diagnostic-options-invalid' });
    });
}

test('explicit run/commit and canonical opaque bytes are required', async () =>
{
    await assert.rejects(inspectCompositionObservationDiagnostic({ ...options(), runId: '' }),
        { code: 'composition-diagnostic-run-binding-required' });
    await assert.rejects(inspectCompositionObservationDiagnostic({ ...options(), expectedSourceCommit: 'latest' }),
        { code: 'composition-diagnostic-run-binding-required' });
    await assert.rejects(inspectCompositionObservationDiagnostic({ ...options(), observationBytes: { observationsPassed: true } }),
        { code: 'composition-diagnostic-bytes-required' });
});

test('wrong actual source commit fails before public producer execution', async () =>
{
    await assert.rejects(inspectCompositionObservationDiagnostic({ ...options(), expectedSourceCommit: 'a'.repeat(40) }),
        { code: 'composition-diagnostic-source-drift' });
});

test('actual canonical source consumption or exact missing public export is executable', async () =>
{
    if (!apiAvailable)
    {
        await assert.rejects(inspectCompositionObservationDiagnostic(options()),
            { code: 'composition-diagnostic-public-api-unavailable' });
        return;
    }
    assert.ok(options().fsusUIRoot, 'actual local FsusUI root required for canonical integration');
    const result = await inspectCompositionObservationDiagnostic(options());
    assert.equal(result.status, 'canonical-diagnostic-consumed');
    assert.equal(result.source.commit, commit);
    assert.equal(result.compositionIdentity.sourceCommit, commit);
    assert.equal(result.scene.routePattern, settings.path);
    assert.deepEqual(result.analyzerState, { 'settings-task-tab': 'tab-media' });
    assert.equal(result.exclusiveActionState.primaryCardinality, 0);
    assert.equal(result.observation, null);
    assert.ok(result.sourceErrors.length > 0, 'actual source failures must remain');
    assert.ok(result.unknownConditionalBindings.length > 0, 'declared state must not waive source conditionals');
    assert.equal(result.pendingStateBindings.length, 91);
    assert.equal(result.runtimeStateAdmission, 'not-observed');
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.fullVisualVerified, false);
    for (const parser of Object.values(result.parserSources))
    {
        assert.ok(parser.entry.startsWith('/'));
        assert.match(parser.entryDigest, /^[a-f0-9]{64}$/u);
    }
});

test('canonical route graph is rebuilt and a fabricated observation cannot replace it', async () =>
{
    if (!apiAvailable)
    {
        await assert.rejects(inspectCompositionObservationDiagnostic(options()),
            { code: 'composition-diagnostic-public-api-unavailable' });
        return;
    }
    await assert.rejects(inspectCompositionObservationDiagnostic({ ...options(),
        observationBytes: Buffer.from(JSON.stringify({ archetype: 'public/reading', observationsPassed: true })) }),
    { code: 'composition-diagnostic-scene-mismatch' });
    await assert.rejects(inspectCompositionObservationDiagnostic({ ...options(),
        observationBytes: Buffer.from(JSON.stringify({ archetype: 'admin/settings', observationsPassed: true })) }));
});
