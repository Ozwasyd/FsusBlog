import assert from 'node:assert/strict';
import test from 'node:test';

import { digest, noSideEffects, runtimeIdentity } from './support/runtime-state-fixture.mjs';

const { collectRuntimeBundleOutcomeMaterial, runtimeBundleOutcomeProducerId } = await import(
    new URL('../../tools/test-matrix/outcomes/runtime-bundle-material.mjs', import.meta.url)
);
const { sealDocument } = await import(new URL('../../tools/test-runtime/contract.mjs', import.meta.url));
const { RuntimeResetBarrierManager } = await import(new URL('../../tools/test-runtime/reset-barrier.mjs', import.meta.url));
const { createRuntimeSchedulePlan, runtimeStepCatalogDigest } = await import(
    new URL('../../tools/test-runtime/schedule-plan.mjs', import.meta.url)
);
const { captureRuntimeStateSnapshot } = await import(new URL('../../tools/test-runtime/state-snapshot.mjs', import.meta.url));

async function fixture()
{
    const identity = runtimeIdentity();
    const steps = [{ id: 'prepare', command: 'prepare' }, { id: 'observe', command: 'observe', dependsOn: ['prepare'] }];
    const authority = {
        catalogDigest: identity.catalogDigest,
        accessedDomains: ['fixture.public-content'],
        observerBindings: { 'fixture.public-content': { observerId: 'fixture-observer', observerVersion: 'v1' } },
        steps: {
            prepare: { postconditions: ['prepared'], writes: ['fixture.public-content'], resetBefore: [], resetAfter: [] },
            observe: { postconditions: ['observed'], reads: ['fixture.public-content'], resetBefore: [], resetAfter: [] }
        }
    };
    const plan = createRuntimeSchedulePlan({ steps, kind: 'canonical', concurrencyCap: 1, maxConcurrency: 1,
        runtimeStepCatalogDigest: runtimeStepCatalogDigest(steps), stateCatalogDigest: identity.catalogDigest,
        clockDigest: identity.clockDigest, replayDigest: identity.replayDigest, envelopeDigest: identity.envelopeDigest });
    const capture = async (boundary, stepId = null, semantic = { rows: ['one'] }, metadata = { pid: 1 }) =>
        captureRuntimeStateSnapshot({ authority, identity, boundary, stepId, observers: [{
            observerId: 'fixture-observer', version: 'v1',
            observe: async () => ({ status: 'observed', semantic, metadata, sideEffects: noSideEffects() })
        }] });
    const captures = [await capture('before-runtime'), await capture('before-mutating-step', 'prepare'),
        await capture('after-mutating-step', 'prepare'), await capture('after-runtime')];
    const terminal = (id, terminalState = 'success') => ({ schema: 'fsusblog.scheduler.terminal-receipt.v1',
        stepId: id, terminalState, primaryFailureRefs: [], dependencyOutcomes: [], workerSlot: 2, durationMs: 100 });
    const input = {
        plan, steps, authority,
        bundle: { schema: 'fsusblog.local-production.bundle.v1', physicalBundleId: 'runtime-browser',
            status: 'success', schedulerRunId: identity.runId, schedulerTerminalReceiptIds: ['prepare', 'observe'],
            schedulerTerminalReceipts: { prepare: terminal('prepare'), observe: terminal('observe') } },
        execution: { schema: 'fsusblog.production-runtime-order-execution.v1', identity, status: 'success',
            planId: plan.planId, planDigest: plan.contentDigest, executedStepIds: ['prepare', 'observe'],
            executedAssertionIds: ['assert:prepare', 'assert:observe'], boundarySnapshots: captures,
            finalSnapshot: captures[3].snapshot, finalFragments: captures[3].fragments, resetReceipts: [], failures: [],
            postconditions: { prepare: { declared: ['prepared'], status: 'satisfied' },
                observe: { declared: ['observed'], status: 'satisfied' } } },
        assertions: [{ id: 'assert:prepare', stepId: 'prepare', status: 'passed' },
            { id: 'assert:observe', stepId: 'observe', status: 'passed' }],
        artifacts: [{ id: 'state-export', disposition: 'correctness', digest: digest('artifact') },
            { id: 'trace', disposition: 'diagnostic', digest: digest('trace') }]
    };
    const expected = { identity, plan, assertions: input.assertions.map(({ id, stepId }) => ({ id, stepId })),
        correctnessArtifacts: [{ id: 'state-export', digest: digest('artifact') }],
        finalStateDigest: captures[3].snapshot.semanticDigest };
    return { input: structuredClone(input), expected: structuredClone(expected), capture, terminal };
}

const collect = ({ input, expected }, limit = 1000000) =>
    collectRuntimeBundleOutcomeMaterial(JSON.stringify(input), JSON.stringify(expected), limit);
const kinds = (material) => material.failures.map((failure) => failure.kind);

function resealPlan(input, change)
{
    const body = { ...input.plan };
    delete body.contentDigest;
    change(body);
    input.plan = sealDocument(body);
    input.execution.planId = input.plan.planId;
    input.execution.planDigest = input.plan.contentDigest;
}

test('runtime material consumes sealed owner plans and snapshots without qualifying a candidate', async () =>
{
    const value = await fixture();
    const material = collect(value);
    assert.equal(material.status, 'success');
    assert.equal(material.dataOnly, true);
    assert.equal(material.producerVerificationPending, true);
    assert.equal(material.qualificationEligible, false);
    assert.equal(Object.hasOwn(material, 'verificationStatus'), false);
    assert.equal(Object.hasOwn(material, 'outcomeFingerprint'), false);
    assert.deepEqual(material.stepSets.passed, ['observe', 'prepare']);
    assert.equal(material.stateDigests.length, 4);
    assert.deepEqual(material.artifactDigests, value.expected.correctnessArtifacts);
    assert.ok(Object.isFrozen(material.stepOutcomes[0]));
    value.input.assertions[0].status = 'failed';
    assert.equal(material.assertionOutcomes.every((entry) => entry.status === 'passed'), true);
});

test('runtime material rejects missing duplicate extra and cross-plan execution membership', async () =>
{
    const value = await fixture();
    const original = structuredClone(value.input);
    value.input.execution.executedStepIds.pop();
    assert.throws(() => collect(value), /terminal execution missing/);
    value.input = structuredClone(original);
    value.input.execution.executedStepIds.push('observe');
    assert.throws(() => collect(value), /duplicate/);
    value.input = structuredClone(original);
    value.input.execution.executedStepIds.push('foreign');
    assert.throws(() => collect(value), /extra executed/);
    value.input = structuredClone(original);
    value.input.execution.planDigest = digest('foreign');
    assert.throws(() => collect(value), /cross-plan/);
    value.input = structuredClone(original);
    resealPlan(value.input, (plan) => plan.orderedStepIds.pop());
    assert.throws(() => collect(value), /every production runtime step exactly once/);
});

test('blocked steps and not-reached steps retain distinct member and assertion outcomes', async () =>
{
    const value = await fixture();
    value.input.execution.status = 'partial';
    value.input.execution.executedStepIds = ['prepare'];
    delete value.input.execution.postconditions.observe;
    value.input.execution.executedAssertionIds = ['assert:prepare'];
    value.input.bundle.schedulerTerminalReceipts.observe.terminalState = 'blocked';
    value.input.bundle.schedulerTerminalReceipts.observe.primaryFailureRefs = ['prepare'];
    value.input.assertions[1].status = 'blocked';
    const blocked = collect(value);
    assert.deepEqual(blocked.stepSets.blocked, ['observe']);
    assert.deepEqual(blocked.stepOutcomes.find((step) => step.id === 'observe').blockerIds, ['prepare']);
    delete value.input.bundle.schedulerTerminalReceipts.observe;
    value.input.bundle.schedulerTerminalReceiptIds = ['prepare'];
    value.input.assertions[1].status = 'not-reached';
    const notReached = collect(value);
    assert.deepEqual(notReached.stepSets['not-reached'], ['observe']);
    assert.deepEqual(notReached.stepSets.blocked, []);
});

test('cancelled bundles preserve cancellation and never inherit aggregate success', async () =>
{
    const value = await fixture();
    value.input.execution.status = 'cancelled';
    value.input.bundle.schedulerTerminalReceipts.observe.terminalState = 'cancelled';
    value.input.assertions[1].status = 'cancelled';
    value.input.execution.executedAssertionIds = ['assert:prepare'];
    const result = collect(value);
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.stepSets.cancelled, ['observe']);
    value.input.execution.status = 'success';
    assert.equal(collect(value).status, 'failed');
});

test('skipped members cannot borrow executed assertion observations', async () =>
{
    const value = await fixture();
    value.input.execution.status = 'partial';
    value.input.execution.executedStepIds = ['prepare'];
    delete value.input.execution.postconditions.observe;
    value.input.bundle.schedulerTerminalReceipts.observe.terminalState = 'skipped';
    assert.throws(() => collect(value), /assertion was not executed/);
    value.input.assertions[1].status = 'skipped';
    value.input.execution.executedAssertionIds = ['assert:prepare'];
    assert.deepEqual(collect(value).assertionSets.skipped, ['assert:observe']);
});

test('unchanged passing assertions cannot hide a different final semantic state', async () =>
{
    const value = await fixture();
    const changed = await value.capture('after-runtime', null, { rows: ['two'] });
    value.input.execution.boundarySnapshots[3] = changed;
    value.input.execution.finalSnapshot = changed.snapshot;
    value.input.execution.finalFragments = changed.fragments;
    const result = collect(value);
    assert.equal(result.assertionSets.passed.length, 2);
    assert.equal(result.status, 'failed');
    assert.ok(kinds(result).includes('product.state-mismatch'));
});

test('runtime plan seed clock and replay drift use canonical structured taxonomy', async () =>
{
    const value = await fixture();
    resealPlan(value.input, (plan) =>
    {
        plan.seed = 104729;
        plan.clockDigest = digest('different-clock');
    });
    const result = collect(value);
    assert.deepEqual(kinds(result), ['determinism.seed-drift', 'determinism.clock-drift', 'determinism.execution-plan-drift']);
    assert.equal(result.status, 'failed');
});

test('explicit order-related failures survive a successful bundle and unknown text cannot classify them', async () =>
{
    const value = await fixture();
    value.input.execution.failures = [{ kind: 'determinism.order-dependent',
        identity: { producerId: runtimeBundleOutcomeProducerId, testId: 'assert:observe' } }];
    assert.equal(collect(value).status, 'failed');
    assert.deepEqual(kinds(collect(value)), ['determinism.order-dependent']);
    value.input.execution.failures[0].kind = 'runtime-state-order-dependent';
    assert.throws(() => collect(value), /unknown or incomplete structured failure/);
});

test('runtime state and correctness artifact reference tampering fails closed', async () =>
{
    const value = await fixture();
    const original = structuredClone(value.input);
    value.input.execution.boundarySnapshots[0].fragments[0].semantic.rows = ['tamper'];
    assert.throws(() => collect(value), /Digest mismatch/);
    value.input = original;
    value.input.artifacts[0].digest = digest('tampered');
    assert.throws(() => collect(value), /artifact reference drift/);
});

test('runtime material requires all catalog mutation boundaries and exact snapshot fragment coverage', async () =>
{
    const value = await fixture();
    const original = structuredClone(value.input);
    value.input.execution.boundarySnapshots.splice(1, 1);
    assert.throws(() => collect(value), /missing state boundary/);
    value.input = original;
    value.input.execution.boundarySnapshots[0].fragments.push(value.input.execution.boundarySnapshots[0].fragments[0]);
    assert.throws(() => collect(value), /membership mismatch/);
});

test('scheduler slot timing PID log paths and diagnostic digest remain outside semantic material', async () =>
{
    const value = await fixture();
    const before = collect(value);
    value.input.bundle.durationMs = 999;
    value.input.bundle.schedulerTerminalReceipts.prepare.workerSlot = 99;
    value.input.bundle.schedulerTerminalReceipts.prepare.durationMs = 999;
    value.input.execution.processRefs = [{ pid: 999, logFile: '/run-owned/log' }];
    value.input.artifacts[1].digest = digest('different-trace');
    assert.deepEqual(collect(value), before);
});

test('runtime material refuses cross-run cross-attempt and source identity mismatches', async () =>
{
    const value = await fixture();
    const original = structuredClone(value.input);
    value.input.execution.identity.attemptId = 'attempt-0002';
    assert.throws(() => collect(value), /identity mismatch: attemptId/);
    value.input = structuredClone(original);
    value.input.bundle.schedulerRunId = 'foreign-run';
    assert.throws(() => collect(value), /bundle identity/);
    value.input = original;
    value.input.execution.identity.sourceCommit = 'b'.repeat(40);
    assert.throws(() => collect(value), /identity mismatch: sourceCommit/);
});

test('reset postconditions and snapshot references use the original barrier verifier', async () =>
{
    const value = await fixture();
    const reset = { producer: 'prepare', assertionId: 'fixture-ready', postcondition: 'fixture-ready', receiptSchema: 'fixture.reset.v1' };
    value.input.authority.steps.prepare.resetAfter = [reset];
    const manager = new RuntimeResetBarrierManager({ authority: value.input.authority, identity: value.expected.identity });
    const barrier = manager.begin({ consumerStepId: 'prepare', phase: 'resetAfter', reset });
    const receipt = manager.complete(barrier, { processReceipt: { exitCode: 0, signal: null, contentDigest: digest('process') },
        beforeCapture: value.input.execution.boundarySnapshots[1], afterCapture: value.input.execution.boundarySnapshots[2],
        postconditionResults: [{ domain: 'fixture.public-content', status: 'satisfied', observationDigest: digest('postcondition') }] });
    value.input.execution.resetReceipts = [receipt];
    assert.equal(collect(value).postconditions.find((entry) => entry.id === 'fixture-ready').status, 'satisfied');
    const body = { ...receipt };
    delete body.receiptDigest;
    body.postconditionResults = [{ domain: 'fixture.public-content', status: 'failed', observationDigest: digest('postcondition') }];
    value.input.execution.resetReceipts = [sealDocument(body, 'receiptDigest')];
    assert.ok(kinds(collect(value)).includes('product.state-mismatch'));
    body.beforeSnapshotDigest = digest('missing');
    value.input.execution.resetReceipts = [sealDocument(body, 'receiptDigest')];
    assert.throws(() => collect(value), /reset state references missing/);
});

test('runtime material admission requires explicit encoded input and a finite host byte budget', async () =>
{
    const value = await fixture();
    assert.throws(() => collectRuntimeBundleOutcomeMaterial(JSON.stringify(value.input), JSON.stringify(value.expected)), /explicit host byte limit/);
    assert.throws(() => collect(value, 20), /byte limit/);
    assert.throws(() => collectRuntimeBundleOutcomeMaterial(value.input, JSON.stringify(value.expected), 1000000), /not text/);
    assert.throws(() => collectRuntimeBundleOutcomeMaterial('{}', '{}', Infinity), /explicit host byte limit/);
});


test('step postcondition failures and catalog membership are never replaced by bundle success', async () =>
{
    const value = await fixture();
    value.input.execution.postconditions.observe.status = 'failed';
    assert.equal(collect(value).status, 'failed');
    assert.ok(kinds(collect(value)).includes('product.state-mismatch'));
    value.input.execution.postconditions.observe.declared = [];
    assert.throws(() => collect(value), /declared postconditions membership mismatch/);
});
