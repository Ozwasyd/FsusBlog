import assert from 'node:assert/strict';
import test from 'node:test';

import { createSecurityAtomicFixture } from './support/security-atomic-fixtures.mjs';

const { projectSecurityBarriers } = await import(new URL('../../tools/test/security-atomic/barriers.mjs', import.meta.url));
const { projectSecurityScenarios } = await import(new URL('../../tools/test/security-atomic/scenarios.mjs', import.meta.url));
const { projectSecurityBoundaries, securityBoundaryIds } = await import(new URL('../../tools/test/security-atomic/external-boundaries.mjs', import.meta.url));
const { materializeSecurityWeightedSteps } = await import(new URL('../../tools/test/security-atomic/weighted-projection.mjs', import.meta.url));
const { buildSettledPhaseJoinEvidence, executeWeightedStepDag, StepTerminalError } = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../tools/test-fixtures/receipt/canonical.mjs', import.meta.url));

async function weightedFixture()
{
    const fixture = createSecurityAtomicFixture();
    const barriers = projectSecurityBarriers({ ...fixture, profileId: fixture.context.profileId, mode: 'resident' });
    const scenarios = projectSecurityScenarios({ ...fixture, mode: 'resident' });
    const selection = Object.fromEntries(securityBoundaryIds.map((producerId) => [producerId, {
        applicable: true, reasonCode: 'controlled-required-policy', classification: 'correctness',
        explicitInputs: [fixture.reference('boundaryInput', `${producerId}-input`)],
        envelope: fixture.reference('envelope', `${producerId}-envelope`),
        replay: fixture.reference('replay', `${producerId}-replay`),
        stateAccess: fixture.reference('stateAccess', `${producerId}-state`)
    }]));
    const policyReference = fixture.reference('boundaryPolicy', 'weighted-policy', { selection });
    const boundaries = await projectSecurityBoundaries({ ...fixture, policyReference });
    const declarations = [...barriers.nodes, ...scenarios.producers, ...boundaries.producers, scenarios.aggregate, boundaries.aggregate];
    const ownership = declarations.map((declaration) =>
    {
        const resources = ['coordination', 'settled-projection', 'cleanup-finalizer'].includes(declaration.kind)
            ? { coordinationOnly: true, minCpuUnits: 0, minMemoryGiB: 0 }
            : { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, minMemoryGiB: 0.125 };
        return {
            producerId: declaration.producerId,
            resources,
            reference: fixture.reference('weightedOwnership', declaration.producerId, { declaration, resources })
        };
    });
    fixture.ownerVerifiers.weightedOwnership = (ref, context) =>
    {
        const record = fixture.records.get(ref.path);
        return record && digestCanonical(record.document) === ref.contentDigest
            && digestCanonical(record.document.context) === digestCanonical(context) ? ref.contentDigest : null;
    };
    fixture.ownerVerifiers.weightedDeclaration = (declaration, owner) =>
    {
        const expected = fixture.records.get(owner.reference.path).document;
        return digestCanonical(expected.declaration) === digestCanonical(declaration)
            && digestCanonical(expected.resources) === digestCanonical(owner.resources) ? declaration.producerId : null;
    };
    return { ...fixture, barriers, scenarios, boundaries, ownership };
}

async function exerciseTerminal(terminalState, { failReset = false, failCleanup = false } = {})
{
    const fixture = await weightedFixture();
    const plan = await materializeSecurityWeightedSteps(fixture);
    const started = [];
    const outcomes = new Map();
    const target = fixture.scenarios.producers[0].producerId;
    const failure = new StepTerminalError(terminalState, 'controlled-scenario-terminal', 'controlled original scenario failure');
    const cleanupFailure = new Error('controlled cleanup failure');
    await assert.rejects(executeWeightedStepDag(plan.steps, { maxParallel: 2, cpuUnits: 2, memoryGiB: 1 }, async (step) =>
    {
        started.push(step.id);
        if (step.runAfterSettled)
        {
            const { evidence } = buildSettledPhaseJoinEvidence({
                stepId: step.id,
                dependencyIds: step.settledDependsOn,
                dependencyOutcomes: step.dependencyOutcomes,
                dependencyResults: outcomes
            });
            outcomes.set(step.id, { schema: 'fsusblog.scheduler.terminal-receipt.v1', terminalState: evidence.terminalState });
            return { terminalState: evidence.terminalState, evidence };
        }
        const rejected = step.id === (failReset ? 'security-reset-pre-scenarios' : target);
        const state = rejected ? terminalState : step.alwaysRunFinalizer && failCleanup ? 'failed' : 'success';
        outcomes.set(step.id, { schema: 'fsusblog.scheduler.terminal-receipt.v1', terminalState: state });
        if (rejected)
        {
            throw failure;
        }
        if (step.alwaysRunFinalizer && failCleanup)
        {
            throw cleanupFailure;
        }
        return { terminalState: 'success' };
    }), (error) =>
    {
        assert.equal(error.terminalReceipts['security-reset-post-gate'].terminalState, failCleanup ? 'failed' : 'success');
        if (failReset)
        {
            assert.ok(fixture.scenarios.producers.every((producer) => error.states[producer.producerId] === 'blocked'));
        }
        else
        {
            assert.equal(error.states[fixture.scenarios.producers[1].producerId], 'success');
            assert.equal(error.terminalReceipts['security-runtime-core'].dependencyOutcomes.length, fixture.scenarios.producers.length);
            if (terminalState !== 'cancelled')
            {
                assert.equal(error.primaryFailure, failure);
            }
        }
        return true;
    });
    assert.equal(started.filter((id) => id === 'security-reset-post-gate').length, 1);
    assert.equal(started.filter((id) => id === 'security-reset-pre-scenarios').length, 1);
    if (failReset)
    {
        assert.ok(fixture.scenarios.producers.every((producer) => !started.includes(producer.producerId)));
        assert.ok(started.includes('security-firewall-evidence'));
    }
}

test('native weighted DAG runs isolated siblings and finalizer after scenario failure without hiding cleanup failure', async () =>
{
    await exerciseTerminal('failed', { failCleanup: true });
});

test('native weighted DAG runs finalizer after scenario timeout', async () =>
{
    await exerciseTerminal('timed-out');
});

test('native weighted DAG runs finalizer after per-producer cancellation', async () =>
{
    await exerciseTerminal('cancelled');
});

test('native weighted DAG blocks reset-dependent scenarios while unrelated boundary producers run', async () =>
{
    await exerciseTerminal('failed', { failReset: true });
});

test('weighted adapter refuses missing ownership context drift and resource tamper', async () =>
{
    const fixture = await weightedFixture();
    await assert.rejects(materializeSecurityWeightedSteps({ ...fixture, ownership: [] }), /cover every declaration/u);
    await assert.rejects(materializeSecurityWeightedSteps({ ...fixture, context: { ...fixture.context, runId: 'other-run' } }), /context binding mismatch/u);
    const ownership = structuredClone(fixture.ownership);
    ownership[0].resources.coordinationOnly = false;
    await assert.rejects(materializeSecurityWeightedSteps({ ...fixture, ownership }), /canonical physical ownership/u);
});

test('security weighted projection runs its pending cleanup after global abort and retains the first cause', async () =>
{
    const fixture = await weightedFixture();
    const plan = await materializeSecurityWeightedSteps(fixture);
    const controller = new AbortController();
    const originalFailure = new Error('security owned global interruption');
    let cleanupCount = 0;
    let startedCount = 0;
    await assert.rejects(executeWeightedStepDag(plan.steps, {
        maxParallel: 1, cpuUnits: 1, memoryGiB: 1, signal: controller.signal
    }, async (step) =>
    {
        if (step.alwaysRunFinalizer)
        {
            cleanupCount += 1;
            return { terminalState: 'success' };
        }
        if (step.runAfterSettled)
        {
            const { evidence } = buildSettledPhaseJoinEvidence({ stepId: step.id,
                dependencyIds: step.settledDependsOn, dependencyOutcomes: step.dependencyOutcomes,
                dependencyResults: new Map() });
            return { terminalState: evidence.terminalState, evidence };
        }
        startedCount += 1;
        controller.abort(originalFailure);
        throw originalFailure;
    }), (error) =>
    {
        assert.equal(error.primaryFailure, originalFailure);
        assert.equal(error.terminalReceipts['security-reset-post-gate'].terminalState, 'success');
        assert.equal(Object.keys(error.terminalReceipts).length, plan.steps.length);
        return true;
    });
    assert.ok(startedCount > 0);
    assert.equal(cleanupCount, 1);
});
