
const { digestCanonical, freezeDeep, plainObject } = await import(new URL('../test-fixtures/receipt/canonical.mjs', import.meta.url));

import { normalizeRuntimeIdentity, requireDigest, sealDocument } from './contract.mjs';
import { validateRuntimeResetBarrierReceipt } from './reset-barrier.mjs';
import { createRequiredRuntimeSchedulePlans } from './schedule-plan.mjs';
import { firstSemanticMismatch, validateRuntimeStateSnapshot } from './state-snapshot.mjs';

export const runtimeOrderEquivalenceReceiptSchema = 'fsusblog.runtime-order-equivalence.v1';

const mutatingFields = ['writes', 'creates', 'deletes', 'invalidates'];

function boundaryKey(boundary, stepId = null)
{
    return `${boundary}:${stepId ?? ''}`;
}

function expectedBoundaries(plan, authority)
{
    const expected = [{ boundary: 'before-runtime', stepId: null }];
    for (const stepId of plan.orderedStepIds)
    {
        const entry = authority?.steps?.[stepId];
        if (!entry)
        {
            throw new Error(`${plan.planId} runtime step is absent from snapshot authority: ${stepId}`);
        }
        if (mutatingFields.some((field) => (entry[field] ?? []).length > 0))
        {
            expected.push({ boundary: 'before-mutating-step', stepId });
            expected.push({ boundary: 'after-mutating-step', stepId });
        }
    }
    expected.push({ boundary: 'after-runtime', stepId: null });
    return expected;
}

function expectedResets(plan, authority)
{
    return plan.orderedStepIds.flatMap((stepId) => ['resetBefore', 'resetAfter'].flatMap((phase) =>
        (authority.steps[stepId]?.[phase] ?? []).map((reset) => ({ stepId, phase, reset }))));
}

function validateExecution(result, plan, authority)
{
    if (!plainObject(result) || result.status !== 'success')
    {
        throw new Error(`runtime schedule ${plan.planId} did not complete successfully`);
    }
    const exactArrays = ['executedStepIds', 'executedAssertionIds'];
    for (const field of exactArrays)
    {
        if (!Array.isArray(result[field]) || new Set(result[field]).size !== result[field].length)
        {
            throw new Error(`${plan.planId} ${field} is missing or duplicate`);
        }
    }
    if (JSON.stringify(result.executedStepIds) !== JSON.stringify(plan.orderedStepIds))
    {
        throw new Error(`${plan.planId} planned/actual step order mismatch`);
    }
    if (!plainObject(result.outcomes) || !plainObject(result.postconditions))
    {
        throw new Error(`${plan.planId} lacks structured outcomes/postconditions`);
    }
    for (const field of ['processRefs', 'lifecycleRefs'])
    {
        if (!Array.isArray(result[field]) || result[field].length === 0)
        {
            throw new Error(`${plan.planId} lacks ${field}`);
        }
    }
    const expectedSnapshotBoundaries = expectedBoundaries(plan, authority);
    if (!Array.isArray(result.boundarySnapshots) || result.boundarySnapshots.length !== expectedSnapshotBoundaries.length)
    {
        throw new Error(`${plan.planId} has incomplete runtime snapshot boundaries`);
    }
    const captureByBoundary = new Map();
    for (const capture of result.boundarySnapshots)
    {
        const key = boundaryKey(capture?.snapshot?.boundary, capture?.snapshot?.stepId);
        if (captureByBoundary.has(key))
        {
            throw new Error(`${plan.planId} has duplicate runtime snapshot boundary ${key}`);
        }
        validateRuntimeStateSnapshot(capture?.snapshot, { authority, identity: result.identity, fragments: capture?.fragments });
        captureByBoundary.set(key, capture);
    }
    for (const boundary of expectedSnapshotBoundaries)
    {
        const key = boundaryKey(boundary.boundary, boundary.stepId);
        if (!captureByBoundary.has(key))
        {
            throw new Error(`${plan.planId} lacks runtime snapshot boundary ${key}`);
        }
    }
    const afterRuntime = captureByBoundary.get(boundaryKey('after-runtime'));
    if (afterRuntime.snapshot.snapshotDigest !== result.finalSnapshot?.snapshotDigest
    || JSON.stringify(afterRuntime.fragments.map((fragment) => fragment.fragmentDigest))
      !== JSON.stringify((result.finalFragments ?? []).map((fragment) => fragment.fragmentDigest)))
    {
        throw new Error(`${plan.planId} final snapshot is not the after-runtime boundary`);
    }
    const resets = expectedResets(plan, authority);
    if (!Array.isArray(result.resetReceipts) || result.resetReceipts.length !== resets.length)
    {
        throw new Error(`${plan.planId} has incomplete reset receipts`);
    }
    const resetKeys = new Set();
    for (const receipt of result.resetReceipts)
    {
        validateRuntimeResetBarrierReceipt(receipt, { authority, identity: result.identity });
        const key = `${receipt.barrier.consumerStepId}:${receipt.barrier.phase}:${receipt.barrier.assertionId}`;
        if (resetKeys.has(key))
        {
            throw new Error(`${plan.planId} has duplicate reset receipt ${key}`);
        }
        resetKeys.add(key);
    }
    for (const { stepId, phase, reset } of resets)
    {
        const key = `${stepId}:${phase}:${reset.assertionId}`;
        if (!resetKeys.has(key))
        {
            throw new Error(`${plan.planId} lacks reset receipt ${key}`);
        }
    }
    if (!Array.isArray(result.overlaps))
    {
        throw new Error(`${plan.planId} lacks overlap evidence`);
    }
    return freezeDeep({
        planId: plan.planId,
        planDigest: plan.contentDigest,
        sessionId: result.identity.sessionId,
        executedStepIds: result.executedStepIds,
        executedAssertionIds: result.executedAssertionIds,
        outcomes: result.outcomes,
        postconditions: result.postconditions,
        terminalClass: result.terminalClass,
        finalSnapshotDigest: result.finalSnapshot.snapshotDigest,
        finalSemanticDigest: result.finalSnapshot.semanticDigest,
        boundarySnapshotRefs: result.boundarySnapshots.map(({ snapshot }) => ({
            boundary: snapshot.boundary,
            stepId: snapshot.stepId,
            snapshotDigest: snapshot.snapshotDigest
        })),
        resetReceiptDigests: result.resetReceipts.map((receipt) => receipt.receiptDigest),
        processRefs: result.processRefs,
        lifecycleRefs: result.lifecycleRefs,
        overlaps: result.overlaps,
        attemptFailures: result.attemptFailures ?? []
    });
}

function compareExecution(baseline, candidate)
{
    for (const field of ['executedAssertionIds', 'outcomes', 'postconditions', 'terminalClass', 'finalSemanticDigest'])
    {
        if (digestCanonical(baseline[field]) !== digestCanonical(candidate[field]))
        {
            return { field, ...firstSemanticMismatch(baseline[field], candidate[field]) };
        }
    }
    return null;
}

export async function runRuntimeOrderEquivalence({
    steps,
    maxConcurrency,
    immutableIdentity,
    runtimeStepCatalogDigest,
    authority,
    createSession,
    executePlan,
    signal
})
{
    if (typeof createSession !== 'function' || typeof executePlan !== 'function')
    {
        throw new Error('order equivalence requires real session and production runtime executors');
    }
    const base = normalizeRuntimeIdentity({ ...immutableIdentity, sessionId: 'schedule-template' });
    if (base.catalogDigest !== authority?.catalogDigest)
    {
        throw new Error('order equivalence catalog identity drifted');
    }
    const plans = createRequiredRuntimeSchedulePlans({
        steps,
        maxConcurrency,
        runtimeStepCatalogDigest: requireDigest(runtimeStepCatalogDigest, 'runtimeStepCatalogDigest'),
        stateCatalogDigest: authority.catalogDigest,
        clockDigest: base.clockDigest,
        replayDigest: base.replayDigest,
        envelopeDigest: base.envelopeDigest
    });
    const executions = [];
    const deduplicatedPlans = [];
    let baseline = null;
    for (const plan of plans)
    {
        if (signal?.aborted)
        {
            throw signal.reason ?? new Error('runtime order equivalence cancelled');
        }
        if (plan.deduplicatedBy)
        {
            deduplicatedPlans.push(plan);
            continue;
        }
        const session = await createSession({ plan, immutableIdentity: base, signal });
        if (!session?.identity || session.identity.sessionId === base.sessionId)
        {
            throw new Error(`${plan.planId} did not create an independent execution session`);
        }
        const result = await executePlan({ plan, session, signal });
        const execution = validateExecution(result, plan, authority);
        if ((execution.attemptFailures ?? []).length > 0)
        {
            throw new Error(`${plan.planId} attempted retry after a failure`);
        }
        if (!baseline)
        {
            baseline = execution;
        }
        else
        {
            const mismatch = compareExecution(baseline, execution);
            if (mismatch)
            {
                const error = new Error(`runtime-state-order-dependent: ${plan.planId} diverged at ${mismatch.path ?? mismatch.field}`);
                error.code = 'runtime-state-order-dependent';
                error.divergence = freezeDeep({ baselinePlanId: baseline.planId, candidatePlanId: plan.planId, ...mismatch });
                throw error;
            }
        }
        executions.push(execution);
    }
    const parallel = executions.some((execution) => execution.overlaps.some((overlap) => overlap.provenNonConflicting === true));
    if (!parallel)
    {
        throw new Error('runtime order equivalence found no proven non-conflicting production overlap; global serialization is not accepted');
    }
    const body = {
        schema: runtimeOrderEquivalenceReceiptSchema,
        status: 'equivalent',
        source: {
            commit: base.sourceCommit,
            fingerprint: base.sourceFingerprint
        },
        immutableIdentity: {
            buildReceiptDigest: base.buildReceiptDigest,
            fixtureDigest: base.fixtureDigest,
            envelopeDigest: base.envelopeDigest,
            clockDigest: base.clockDigest,
            replayDigest: base.replayDigest,
            catalogDigest: base.catalogDigest,
            runtimeStepCatalogDigest
        },
        requiredPlanCount: plans.length,
        executedPlanCount: executions.length,
        deduplicatedPlanCount: deduplicatedPlans.length,
        executions,
        deduplicatedPlans,
        parallelismProof: true
    };
    return sealDocument(body, 'receiptDigest');
}

export function validateRuntimeOrderEquivalenceReceipt(receipt, expected = {})
{
    if (receipt?.schema !== runtimeOrderEquivalenceReceiptSchema || receipt.status !== 'equivalent')
    {
        throw new Error('runtime order-equivalence receipt is not successful');
    }
    const { receiptDigest, ...body } = receipt;
    if (digestCanonical(body) !== receiptDigest)
    {
        throw new Error('runtime order-equivalence receipt digest mismatch');
    }
    if (expected.sourceCommit && receipt.source.commit !== expected.sourceCommit)
    {
        throw new Error('runtime order-equivalence receipt is stale for source');
    }
    if (expected.sourceFingerprint && receipt.source.fingerprint !== expected.sourceFingerprint)
    {
        throw new Error('runtime order-equivalence receipt worktree drifted');
    }
    if (!Array.isArray(receipt.executions) || !Array.isArray(receipt.deduplicatedPlans)
    || receipt.executedPlanCount !== receipt.executions.length
    || receipt.deduplicatedPlanCount !== receipt.deduplicatedPlans.length
    || receipt.requiredPlanCount !== receipt.executedPlanCount + receipt.deduplicatedPlanCount
    || receipt.requiredPlanCount < 8)
    {
        throw new Error('runtime order-equivalence receipt has incomplete schedule accounting');
    }
    const planIds = [
        ...receipt.executions.map((execution) => execution?.planId),
        ...receipt.deduplicatedPlans.map((plan) => plan?.planId)
    ];
    if (planIds.some((planId) => typeof planId !== 'string' || !planId)
    || new Set(planIds).size !== planIds.length)
    {
        throw new Error('runtime order-equivalence receipt has missing or duplicate plan identities');
    }
    const sessionIds = receipt.executions.map((execution) => execution?.sessionId);
    if (sessionIds.some((sessionId) => typeof sessionId !== 'string' || !sessionId)
    || new Set(sessionIds).size !== sessionIds.length)
    {
        throw new Error('runtime order-equivalence executions do not own independent sessions');
    }
    if (receipt.parallelismProof !== true
    || !receipt.executions.some((execution) => Array.isArray(execution?.overlaps)
      && execution.overlaps.some((overlap) => overlap?.provenNonConflicting === true)))
    {
        throw new Error('runtime order-equivalence receipt proves only global serialization');
    }
    return true;
}


export const requiredEvidenceVerifier = Object.freeze({
    version: 1, successStatuses: Object.freeze(['equivalent']),
    describe: async (receipt) => (await import(new URL('../release/required-evidence-owner-contract.mjs', import.meta.url))).describeOwnerReceipt(receipt, {
        identity: { namespace: 'namespace', runId: 'runId', sourceCommit: 'source.commit', worktreeFingerprint: 'source.fingerprint' },
        status: 'status', contentDigest: 'receiptDigest'
    }),
    async verify({ receipt, context })
    {
        const { verifiedOwnerResult } = await import(new URL('../release/required-evidence-owner-contract.mjs', import.meta.url));
        validateRuntimeOrderEquivalenceReceipt(receipt, { sourceCommit: context.sourceCommit,
            sourceFingerprint: context.worktreeFingerprint.replace(/^sha256:/u, '') });
        return verifiedOwnerResult({ schema: receipt.schema, receiptDigest: receipt.receiptDigest });
    }
});
