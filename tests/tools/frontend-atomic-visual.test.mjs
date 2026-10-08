import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const { loadTestMatrix } = await import(new URL('../../tools/test-matrix/command-groups.mjs', import.meta.url));
const { executeWeightedStepDag } = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));
const {
    compareVisualSharedIdentityMaterial,
    projectFrontendVisual
} = await import(new URL('../../tools/test/frontend-atomic/visual-projection.mjs', import.meta.url));

const root = fileURLToPath(new URL('../..', import.meta.url));

test('visual source projection preserves all current specs, artifacts, fixtures and diagnostic classification', () =>
{
    const matrix = loadTestMatrix(root);
    const projection = projectFrontendVisual(matrix);
    assert.equal(projection.qualificationEligible, false);
    for (const entry of projection.entries)
    {
        assert.deepEqual(entry, matrix.tiers.find((tier) => tier.id === entry.id));
        assert.equal(entry.evidenceClass, 'diagnostic');
    }
    assert.deepEqual(projection.entries.map((entry) => entry.fixtureProfile),
        ['public-content-lifecycle', 'acceptance-representative']);
    assert.deepEqual(projection.settledProjection, { id: 'visual-summary', dependsOn: [],
        settledDependsOn: ['visual-public', 'visual-console'] });
    assert.ok(projection.missingContracts.includes('verified-fixture-lifecycle-admission'));
});

test('visual aggregate rejects missing, extra and duplicate ownership instead of accepting screenshot directories', () =>
{
    const matrix = loadTestMatrix(root);
    const aggregate = matrix.tiers.find((tier) => tier.id === 'visual');
    aggregate.executionDependsOn = ['visual-public'];
    assert.throws(() => projectFrontendVisual(matrix), /exactly the two/u);
    aggregate.executionDependsOn = ['visual-public', 'visual-console', 'extra'];
    assert.throws(() => projectFrontendVisual(matrix), /exactly the two/u);
    matrix.tiers.push(structuredClone(matrix.tiers.find((tier) => tier.id === 'visual-public')));
    assert.throws(() => projectFrontendVisual(matrix), /exactly one/u);
});

test('visual identity material comparison rejects each missing or differing shared identity without granting authority', () =>
{
    const identity = { runId: 'run', sourceCommit: 'source', candidateDigest: 'candidate',
        frontendBuildDigest: 'frontend', backendBuildDigest: 'backend', releasePreviewDigest: 'preview',
        fsusUiDigest: 'ui', browserPlanDigest: 'browser', serviceGeneration: 'generation' };
    assert.deepEqual(compareVisualSharedIdentityMaterial(identity, identity), {
        matches: true, qualificationEligible: false, differences: []
    });
    for (const field of Object.keys(identity))
    {
        const changed = { ...identity, [field]: 'different' };
        assert.deepEqual(compareVisualSharedIdentityMaterial(identity, changed).differences, [field]);
        delete changed[field];
        assert.deepEqual(compareVisualSharedIdentityMaterial(identity, changed).differences, [field]);
    }
    assert.equal(compareVisualSharedIdentityMaterial({}, {}).matches, false);
});

test('visual baseline/artifact/fixture metadata drift changes the canonical source digest', () =>
{
    const matrix = loadTestMatrix(root);
    const original = projectFrontendVisual(matrix);
    matrix.tiers.find((tier) => tier.id === 'visual-console').evidence.push('changed-baseline');
    assert.notEqual(projectFrontendVisual(matrix).sourceDigest, original.sourceDigest);
});

for (const unhealthy of [false, true])
{
    test(`existing visual DAG ${unhealthy ? 'blocks both lanes on shared corruption' : 'collects console after public failure'}`, async () =>
    {
        const projection = projectFrontendVisual(loadTestMatrix(root));
        const executions = [];
        const steps = [{ id: 'shared-runtime', resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
            ...projection.entries.map((entry) => ({ id: entry.id, dependsOn: ['shared-runtime'],
                resources: { cpuWeight: entry.cpuWeight, memoryWeight: entry.memoryWeight,
                    minCpuUnits: entry.minCpuUnits, exclusiveResources: entry.exclusiveResources } }))];
        await assert.rejects(executeWeightedStepDag(steps, { maxParallel: 2, cpuUnits: 4, memoryGiB: 4 },
            async (entry) =>
            {
                executions.push(entry.id);
                if ((unhealthy && entry.id === 'shared-runtime') || entry.id === 'visual-public')
                {
                    throw new Error(unhealthy ? 'runtime corruption' : 'public visual failure');
                }
            }), (error) =>
        {
            assert.equal(error.states['visual-console'], unhealthy ? 'blocked' : 'success');
            assert.equal(error.states['visual-public'], unhealthy ? 'blocked' : 'failed');
            return true;
        });
        assert.equal(executions.filter((id) => id === 'shared-runtime').length, 1);
        assert.equal(executions.includes('visual-console'), !unhealthy);
    });
}
