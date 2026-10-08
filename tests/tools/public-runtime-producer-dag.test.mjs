import assert from 'node:assert/strict';
import test from 'node:test';

const { buildSettledPhaseJoinEvidence, executeWeightedStepDag, StepDagExecutionError } = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));
const { buildPublicRuntimeDeclarations } = await import(new URL('../../tools/test/public-runtime-producers/declarations.mjs', import.meta.url));

// Unit fixtures consume declaration edges through the existing scheduler only.
// They do not compile correctness attempts or grant fixture/state admission.
async function observeEdges(tier, forcedOutcomes)
{
    const plan = buildPublicRuntimeDeclarations(tier);
    const resources = { minCpuUnits: 1, cpuWeight: 1, memoryWeight: 1 };
    const steps = [
        ...plan.externalDependencies.map((id) => ({ id, dependsOn: [], resources })),
        ...plan.nodes.map((node) => ({ id: node.id, dependsOn: node.dependsOn,
            settledDependsOn: node.settledDependsOn, resources }))
    ];
    const started = [];
    const results = new Map();
    const executor = async (step) =>
    {
        started.push(step.id);
        const node = plan.nodes.find((candidate) => candidate.id === step.id);
        let result;
        if (node?.kind === 'settled-projection')
        {
            const { evidence } = buildSettledPhaseJoinEvidence({
                stepId: step.id, dependencyIds: node.settledDependsOn,
                dependencyOutcomes: Object.fromEntries([...results].map(([id, outcome]) => [id, outcome.terminalState])),
                dependencyResults: results, generatedAt: 'unit-fixture'
            });
            result = { terminalState: evidence.terminalState, reasonCode: evidence.reasonCode,
                primaryFailureRefs: evidence.primaryFailureRefs, evidence };
        }
        else
        {
            result = { terminalState: forcedOutcomes[step.id] ?? 'success', reasonCode: 'unit-fixture' };
        }
        results.set(step.id, result);
        return result;
    };
    let execution;
    try
    {
        execution = await executeWeightedStepDag(steps, { maxParallel: 4, cpuUnits: 4, memoryGiB: 4 }, executor);
    }
    catch (error)
    {
        assert.ok(error instanceof StepDagExecutionError);
        execution = { states: error.states, terminalReceipts: error.terminalReceipts };
    }
    return { ...execution, started, results };
}

test('release barrier failure blocks all nine readers with zero reader starts', async () =>
{
    const result = await observeEdges('release-public', { 'release-public-hydration': 'failed' });
    const readers = buildPublicRuntimeDeclarations('release-public').nodes.filter((node) => node.kind === 'correctness');
    for (const reader of readers)
    {
        assert.equal(result.states[reader.id], 'blocked');
        assert.ok(!result.started.includes(reader.id));
    }
    assert.ok(result.started.includes('release-public-summary'));
    assert.equal(result.states['release-public-summary'], 'failed');
});

test('AOT and two independent matrix failures do not cancel SEO or other readers', async () =>
{
    const result = await observeEdges('release-public', {
        'public-aot-regression': 'failed', 'public-clock-hydration-matrix': 'failed',
        'public-browser-env-hydration-matrix': 'failed'
    });
    assert.equal(result.states['public-seo-smoke'], 'success');
    assert.equal(result.states['public-dom-diff-hydration'], 'success');
    assert.equal(result.states['release-public-summary'], 'failed');
    assert.equal(result.results.get('release-public-summary').primaryFailureRefs.length, 3);
    assert.equal(new Set(result.started).size, result.started.length);
});

test('load first failure, timeout and cancellation settle before reset and second measurement starts', async () =>
{
    for (const terminalState of ['failed', 'timed-out', 'cancelled'])
    {
        const result = await observeEdges('load', { 'load-public-api': terminalState });
        assert.equal(result.states['load-public-api'], terminalState);
        assert.equal(result.states['reset-pre-notification-stream'], 'success');
        assert.equal(result.states['load-notification-stream-pressure'], 'success');
        assert.ok(result.started.indexOf('load-public-api') < result.started.indexOf('reset-pre-notification-stream'));
        assert.ok(result.started.indexOf('reset-pre-notification-stream') < result.started.indexOf('load-notification-stream-pressure'));
        assert.equal(result.states['load-summary'], terminalState === 'cancelled' ? 'cancelled' : 'failed');
        assert.equal(new Set(result.started).size, result.started.length);
    }
});

test('failed verified reset blocks second measurement with zero starts and summary still settles', async () =>
{
    const result = await observeEdges('load', { 'reset-pre-notification-stream': 'failed' });
    assert.equal(result.states['load-notification-stream-pressure'], 'blocked');
    assert.ok(!result.started.includes('load-notification-stream-pressure'));
    assert.ok(result.started.includes('load-summary'));
    assert.equal(result.states['load-summary'], 'failed');
});
