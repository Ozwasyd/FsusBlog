import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { checkAtomicWorkflowMaterial, collectCompiledAtomicTerminalMaterial, projectAtomicCiMaterial, projectCompiledAtomicCiMaterial } = await import(new URL('../../tools/test-matrix/atomic-failure/ci-projection.mjs', import.meta.url));
const { compileAtomicProducerDag } = await import(new URL('../../tools/test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { AtomicProducerExecutionError, executeCompiledAtomicProducerDag } = await import(new URL('../../tools/test-matrix/atomic-producers/execution.mjs', import.meta.url));
const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
import { atomicFixture, hostLimits } from './support/atomic-failure-fixture.mjs';
import { atomicExecutionOptions, atomicFixture as compilerFixture } from './support/atomic-producer-fixture.mjs';

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

function compiledInput(fixture = compilerFixture())
{
    const compiled = compileAtomicProducerDag(fixture.matrix, fixture.authorities);
    return { ...fixture, compiled,
        context: { schedulerRunId: 'isolated-atomic-run', attemptId: 'first-attempt', sourceCommit: '1'.repeat(40) },
        ciPlan: { jobs: [{ id: 'fixture-job', tiers: ['fixture-summary'] }] },
        graphRef: { path: '.tmp/test-runs/isolated-atomic-run/graph.json', objectDigest: compiled.contentDigest },
        selectedIds: compiled.steps.map((step) => step.id) };
}

test('original compiler supplies exact-one CI invocation without a second producer catalog', async () =>
{
    const input = compiledInput();
    const projection = await projectCompiledAtomicCiMaterial(input, hostLimits);
    assert.equal(projection.jobs.length, 1);
    assert.equal(projection.jobs[0].invocationCount, 1);
    assert.equal(projection.jobs[0].receiptBindings.length, input.compiled.steps.length);
    for (const mutate of [
        (value) =>
        {
            value.ciPlan.jobs = [];
        },
        (value) =>
        {
            value.ciPlan.jobs.push({ id: 'other-job', tiers: ['fixture-summary'] });
        },
        (value) =>
        {
            value.graphRef.objectDigest = `sha256:${'0'.repeat(64)}`;
        },
        (value) =>
        {
            value.compiled.steps[0].command.push('second-authority');
        }
    ])
    {
        const changed = structuredClone(input);
        mutate(changed);
        await assert.rejects(projectCompiledAtomicCiMaterial(changed, hostLimits));
    }
});

async function withTerminalInput(fixture, run, abort = false)
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-terminal-collection-'));
    try
    {
        const input = compiledInput(fixture);
        const options = atomicExecutionOptions(fixture, path.join(repositoryRoot, '.tmp', 'test-runs'));
        if (abort)
        {
            options.capacity.signal = AbortSignal.abort(new Error('source-control-interrupt'));
        }
        let vector;
        try
        {
            vector = await executeCompiledAtomicProducerDag(input.compiled, options);
        }
        catch (error)
        {
            assert.ok(error instanceof AtomicProducerExecutionError);
            vector = error.terminalVector;
        }
        return await run({ ...input, vector, expectedVector: vector, repositoryRoot,
            worktreeFingerprint: options.context.worktreeFingerprint,
            terminalVectorRef: { path: `.tmp/test-runs/${vector.schedulerRunId}/atomic-dag/${input.compiled.contentDigest.slice(7)}/terminal-vector.json`,
                objectDigest: vector.contentDigest } });
    }
    finally
    {
        fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
}

function resealVector(input)
{
    const { contentDigest, ...body } = input.vector;
    assert.ok(contentDigest);
    input.vector = sealContentDigest(body);
    input.expectedVector = input.vector;
    input.terminalVectorRef.objectDigest = input.vector.contentDigest;
}

test('read-only collection retains two real independent failures, blocked work and original receipt identities', async () =>
    withTerminalInput(compilerFixture({ alphaScenario: 'product-failure', betaScenario: 'product-failure' }), async (input) =>
    {
        const filesBefore = fs.readdirSync(path.join(input.repositoryRoot, path.dirname(input.terminalVectorRef.path)));
        const material = await collectCompiledAtomicTerminalMaterial(input, hostLimits);
        assert.equal(material.sourceStatus, 'failed');
        assert.equal(material.receipts.length, 6);
        const byId = Object.fromEntries(material.receipts.map((receipt) => [receipt.producerId, receipt]));
        assert.equal(byId['alpha-check'].terminalState, 'failed');
        assert.equal(byId['beta-check'].terminalState, 'failed');
        assert.deepEqual(byId['dependent-check'].blockedBy, ['alpha-check']);
        assert.equal(byId['dependent-check'].attemptRef, null);
        assert.equal(byId['cleanup-inventory'].terminalState, 'success');
        for (const receipt of material.receipts)
        {
            const original = input.vector.receipts.find((entry) => entry.producerId === receipt.producerId);
            assert.equal(receipt.sourceReceiptDigest, original.contentDigest);
            assert.deepEqual(receipt.primaryFailureRefs, original.primaryFailureRefs);
            assert.equal(fs.existsSync(path.join(input.repositoryRoot, receipt.transportBinding.path)), false);
        }
        assert.equal(material.materializedTransport, false);
        assert.equal(material.qualificationEligible, false);
        assert.equal(material.verificationStatus, 'unverified');
        assert.equal(material.terminalAcceptancePending, true);
        assert.ok(Object.isFrozen(material.receipts));
        assert.deepEqual(fs.readdirSync(path.join(input.repositoryRoot, path.dirname(input.terminalVectorRef.path))), filesBefore);
    }));

test('terminal collection refuses complete-vector drift even when caller reseals expected material', async (t) =>
    withTerminalInput(compilerFixture(), async (input) =>
    {
        const cases = {
            'missing terminal': (value) =>
            {
                value.vector.receipts.pop();
                resealVector(value);
            },
            'duplicate terminal': (value) =>
            {
                value.vector.receipts.push(value.vector.receipts[0]);
                resealVector(value);
            },
            'unsealed receipt': (value) =>
            {
                value.vector.receipts[0].reasonCode = 'changed';
                resealVector(value);
            },
            'other run': (value) =>
            {
                value.vector.schedulerRunId = 'other-run';
                resealVector(value);
            },
            'other source': (value) =>
            {
                value.vector.sourceCommit = '2'.repeat(40);
                resealVector(value);
            },
            'other worktree': (value) =>
            {
                value.worktreeFingerprint = `sha256:${'3'.repeat(64)}`;
            },
            'other vector reference': (value) =>
            {
                value.terminalVectorRef.objectDigest = `sha256:${'4'.repeat(64)}`;
            },
            'partial selection': (value) =>
            {
                value.selectedIds = [];
            },
            'authority promotion': (value) =>
            {
                value.vector.qualificationEligible = true;
                resealVector(value);
            },
            'cross-run original attempt': (value) =>
            {
                const receipt = value.vector.receipts.find((entry) => entry.attemptRef);
                receipt.attemptRef.path = path.join(value.repositoryRoot, '.tmp/test-runs/other-run/receipt.json');
                const { contentDigest, ...body } = receipt;
                assert.ok(contentDigest);
                value.vector.receipts[value.vector.receipts.indexOf(receipt)] = sealContentDigest(body);
                resealVector(value);
            }
        };
        for (const [name, mutate] of Object.entries(cases))
        {
            await t.test(name, async () =>
            {
                const changed = structuredClone(input);
                mutate(changed);
                await assert.rejects(collectCompiledAtomicTerminalMaterial(changed, hostLimits));
            });
        }
    }));

test('global interruption keeps unspawned cancellation and exact-once finalizer source receipts', async () =>
    withTerminalInput(compilerFixture(), async (input) =>
    {
        const material = await collectCompiledAtomicTerminalMaterial(input, hostLimits);
        assert.equal(material.interrupted, true);
        assert.ok(material.receipts.filter((receipt) => receipt.producerId.endsWith('-check'))
            .every((receipt) => receipt.terminalState === 'cancelled' && receipt.attemptRef === null));
        assert.equal(material.receipts.find((receipt) => receipt.producerId === 'cleanup-inventory').terminalState, 'success');
        assert.equal(Object.hasOwn(material, 'interruption'), false);
    }, true));
