import assert from 'node:assert/strict';
import test from 'node:test';

const { checkAtomicWorkflowMaterial, projectAtomicCiMaterial } = await import(new URL('../../tools/test-matrix/atomic-failure/ci-projection.mjs', import.meta.url));
import { atomicFixture, hostLimits } from './support/atomic-failure-fixture.mjs';

function project(fixture = atomicFixture())
{
    const { worktreeFingerprint, ...context } = fixture.context;
    assert.ok(worktreeFingerprint);
    return projectAtomicCiMaterial({ context, graph: fixture.graph, selectedIds: fixture.graph.nodes.map((node) => node.id) }, hostLimits);
}

test('shared runner invokes one DAG and all jobs settle with collision-free current-attempt bindings', () =>
{
    const projection = project();
    const shared = projection.jobs.find((job) => job.id === 'shared-runner');
    assert.equal(shared.invocationCount, 1);
    assert.deepEqual(shared.producerIds, ['failure-a', 'independent-success']);
    assert.ok(projection.jobs.every((job) => job.failFast === false && job.condition === 'always()'));
    const bindings = projection.jobs.flatMap((job) => job.receiptBindings);
    assert.equal(new Set(bindings.map((binding) => binding.artifactName)).size, 7);
    assert.ok(bindings.every((binding) => binding.path.includes('/atomic-fixture/atomic/attempt-one/')));
    assert.equal(projection.aggregate.jobStatusIsEvidence, false);
    assert.equal(projection.aggregate.missingReceiptIsSuccess, false);
    assert.equal(projection.verificationStatus, 'unverified');
    assert.ok(Object.isFrozen(projection.jobs));
});

for (const mutation of ['needs', 'sequential', 'fail-fast', 'job-only', 'dag', 'artifact', 'ignore-exit'])
{
    test(`workflow exact comparison rejects ${mutation} drift`, () =>
    {
        const projection = project();
        const workflow = structuredClone({ dagDigest: projection.dagDigest, jobs: projection.jobs, aggregate: projection.aggregate });
        assert.equal(checkAtomicWorkflowMaterial(projection, workflow, hostLimits), true);
        if (mutation === 'needs')
        {
            workflow.jobs[0].needs = [];
        }
        if (mutation === 'sequential')
        {
            workflow.jobs[0].invocationCount = 2;
        }
        if (mutation === 'fail-fast')
        {
            workflow.jobs[0].failFast = true;
        }
        if (mutation === 'job-only')
        {
            workflow.aggregate.receiptRequired = false;
        }
        if (mutation === 'dag')
        {
            workflow.dagDigest = `sha256:${'0'.repeat(64)}`;
        }
        if (mutation === 'artifact')
        {
            workflow.jobs[0].receiptBindings[0].artifactName = 'latest';
        }
        if (mutation === 'ignore-exit')
        {
            workflow.jobs[0].continueOnError = true;
        }
        assert.throws(() => checkAtomicWorkflowMaterial(projection, workflow, hostLimits), /mismatch/u);
    });
}

test('job contraction cycle and selected producer without hard prerequisites fail closed', () =>
{
    const fixture = atomicFixture();
    fixture.graph.nodes.find((node) => node.id === 'dependent-transitive').ciJobId = 'shared-runner';
    assert.throws(() => project(fixture), /contraction/u);
    const { worktreeFingerprint, ...context } = fixture.context;
    assert.ok(worktreeFingerprint);
    assert.throws(() => projectAtomicCiMaterial({ context, graph: atomicFixture().graph, selectedIds: ['dependent'] }, hostLimits), /prerequisite/u);
});

test('not-selected is an explicit receipt disposition and cross-run graph refs are refused', () =>
{
    const fixture = atomicFixture();
    const { worktreeFingerprint, ...context } = fixture.context;
    assert.ok(worktreeFingerprint);
    const projection = projectAtomicCiMaterial({ context, graph: fixture.graph, selectedIds: [] }, hostLimits);
    assert.ok(projection.jobs.flatMap((job) => job.receiptBindings).every((binding) => binding.selected === false));
    fixture.graph.graphRef.path = '.tmp/test-runs/other-run/graph.json';
    assert.throws(() => project(fixture), /current-run/u);
});
