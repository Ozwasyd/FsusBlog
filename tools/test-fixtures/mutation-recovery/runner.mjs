const { validateFixtureReceipt } = await import(new URL('../receipt/fixture-receipt.mjs', import.meta.url));
const { loadCanonicalMutationEnvelopeCatalog } = await import(new URL('../mutation-envelope-catalog.mjs', import.meta.url));
import { canonicalJson, requireDigest, requireStableId, seal, verifySeal } from './canonical.mjs';
import {
    applyFixtureMutation,
    buildMutationRequest,
    restoreFixtureMutation,
    verifyMutationJournal
} from './mutation-adapters.mjs';
import {
    buildSnapshotRequest,
    compareSemanticSnapshots,
    createSemanticSnapshot,
    verifySemanticDiff,
    // eslint-disable-next-line no-unused-vars
    verifySemanticSnapshot
} from './semantic-snapshot.mjs';

export const recoveryPlanSchema = 'fsusblog.fixture-mutation-recovery-plan.v1';
export const recoveryReceiptSchema = 'fsusblog.fixture-mutation-recovery-receipt.v1';

export function buildMutationRecoveryPlan({
    runId,
    attemptId,
    profileId,
    provider,
    envelopeIds,
    producerPlanDigest,
    source,
    temporalContextDigest,
    runtimeIdentity,
    serviceIdentity,
    catalog = loadCanonicalMutationEnvelopeCatalog()
})
{
    const uniqueEnvelopeIds = [...new Set(envelopeIds ?? [])];
    if (uniqueEnvelopeIds.length !== (envelopeIds ?? []).length || uniqueEnvelopeIds.length === 0)
    {
        throw new Error('recovery plan requires ordered unique envelopes');
    }
    for (const envelopeId of uniqueEnvelopeIds)
    {
        const envelope = catalog.envelopes.find((item) => item.envelopeId === envelopeId);
        if (!envelope || !envelope.targetProfileIds.includes(profileId)
          || envelope.providerSupport[provider] !== true)
        {
            throw new Error(`recovery plan envelope ${envelopeId} is not supported by profile/provider`);
        }
    }
    return seal({
        schema: recoveryPlanSchema,
        runId: requireStableId(runId, 'runId'),
        attemptId: requireStableId(attemptId, 'attemptId'),
        profileId: requireStableId(profileId, 'profileId'),
        provider,
        envelopeIds: uniqueEnvelopeIds,
        producerPlanDigest: requireDigest(producerPlanDigest, 'producerPlanDigest'),
        source,
        temporalContextDigest: requireDigest(temporalContextDigest, 'temporalContextDigest'),
        runtimeIdentity,
        serviceIdentity,
        retryPolicy: 'none',
        recoveryMethod: 'same-sealed-profile-canonical-prepare',
        forbiddenOperations: [
            'backend-restart',
            'cache-flush',
            'container-recreate',
            'database-reset',
            'global-fixture-cleanup',
            'manual-repair',
            'prepare-cleanup',
            'retry'
        ]
    });
}

function assertReceiptForPlan(receipt, plan)
{
    validateFixtureReceipt(receipt, { requireVerified: true, expectedProfileId: plan.profileId });
    if (receipt.executionIdentity.runId !== plan.runId
      || canonicalJson(receipt.executionIdentity.source) !== canonicalJson(plan.source)
      || canonicalJson(receipt.serviceIdentity) !== canonicalJson(plan.serviceIdentity))
    {
        throw new Error('canonical prepare receipt does not match recovery plan identity');
    }
}

function assertContinuity(before, after)
{
    if (canonicalJson(before) !== canonicalJson(after))
    {
        throw new Error('backend/runtime/service identity changed during mutation recovery');
    }
}

export async function runMutationRecovery({
    plan,
    prepareAndVerify,
    observe,
    adapterPort,
    probeRuntime,
    catalog = loadCanonicalMutationEnvelopeCatalog(),
    signal
})
{
    const startedAt = process.hrtime.bigint();
    const resourcesBefore = process.resourceUsage();
    verifySeal(plan, 'contentDigest', 'mutation recovery plan');
    if (plan.retryPolicy !== 'none')
    {
        throw new Error('mutation recovery runner does not permit automatic retry');
    }
    const runtimeBefore = await probeRuntime();
    assertContinuity(plan.runtimeIdentity, runtimeBefore);
    const initialReceipt = await prepareAndVerify({ plan, previousReceipt: null, signal });
    assertReceiptForPlan(initialReceipt, plan);
    const cases = [];
    let active = null;
    try
    {
        for (const [index, envelopeId] of plan.envelopeIds.entries())
        {
            const caseStartedAt = process.hrtime.bigint();
            if (signal?.aborted)
            {
                throw signal.reason ?? new Error('mutation recovery cancelled');
            }
            const envelope = catalog.envelopes.find((item) => item.envelopeId === envelopeId);
            const caseAttemptId = `${plan.attemptId}-case-${String(index + 1).padStart(4, '0')}`;
            const baselineRequest = buildSnapshotRequest({
                receipt: initialReceipt,
                producerPlanDigest: plan.producerPlanDigest,
                mutationCatalog: catalog,
                provider: plan.provider,
                runtimeIdentity: plan.runtimeIdentity,
                temporalContextDigest: plan.temporalContextDigest,
                purpose: 'baseline'
            });
            const baseline = await createSemanticSnapshot({ request: baselineRequest, receipt: initialReceipt, observe });
            const request = buildMutationRequest({
                receipt: initialReceipt,
                baseline,
                baselineRequest,
                envelopeId,
                provider: plan.provider,
                attemptId: caseAttemptId,
                catalog
            });
            let mutatedPair;
            const journal = await applyFixtureMutation({
                request,
                baseline,
                baselineRequest,
                envelope,
                port: adapterPort,
                observeMutated: async () =>
                {
                    const mutatedRequest = buildSnapshotRequest({
                        receipt: initialReceipt,
                        producerPlanDigest: plan.producerPlanDigest,
                        mutationCatalog: catalog,
                        provider: plan.provider,
                        runtimeIdentity: plan.runtimeIdentity,
                        temporalContextDigest: plan.temporalContextDigest,
                        purpose: 'mutated'
                    });
                    const snapshot = await createSemanticSnapshot({
                        request: mutatedRequest,
                        receipt: initialReceipt,
                        observe
                    });
                    mutatedPair = { request: mutatedRequest, snapshot };
                    return mutatedPair;
                }
            });
            active = { journal, request };
            await verifyMutationJournal({
                journal,
                request,
                port: adapterPort,
                mutated: mutatedPair.snapshot,
                mutatedRequest: mutatedPair.request,
                baseline,
                baselineRequest,
                envelope
            });
            assertContinuity(runtimeBefore, await probeRuntime());
            const repairedReceipt = await prepareAndVerify({
                plan,
                previousReceipt: initialReceipt,
                signal,
                sameSealedPlan: true
            });
            assertReceiptForPlan(repairedReceipt, plan);
            const finalRequest = buildSnapshotRequest({
                receipt: repairedReceipt,
                producerPlanDigest: plan.producerPlanDigest,
                mutationCatalog: catalog,
                provider: plan.provider,
                runtimeIdentity: plan.runtimeIdentity,
                temporalContextDigest: plan.temporalContextDigest,
                purpose: 'reprepared'
            });
            const finalSnapshot = await createSemanticSnapshot({
                request: finalRequest,
                receipt: repairedReceipt,
                observe
            });
            const recoveryDiff = compareSemanticSnapshots({
                baseline,
                candidate: finalSnapshot,
                baselineRequest,
                candidateRequest: finalRequest
            });
            verifySemanticDiff(recoveryDiff, { requireExactRecovery: true });
            assertContinuity(runtimeBefore, await probeRuntime());
            active = null;
            cases.push({
                envelopeId,
                baselineSnapshotDigest: baseline.manifest.contentDigest,
                mutationJournalDigest: journal.contentDigest,
                mutatedSnapshotDigest: mutatedPair.snapshot.manifest.contentDigest,
                repairedReceiptDigest: repairedReceipt.receiptDigest,
                finalSnapshotDigest: finalSnapshot.manifest.contentDigest,
                recoveryDiffDigest: recoveryDiff.contentDigest,
                elapsedMilliseconds: Number(process.hrtime.bigint() - caseStartedAt) / 1_000_000,
                status: 'recovered'
            });
        }
    }
    catch (error)
    {
        if (active)
        {
            try
            {
                await restoreFixtureMutation({ ...active, port: adapterPort });
            }
            catch (restoreError)
            {
                error.recoveryObligation = {
                    requestDigest: active.request.contentDigest,
                    journalDigest: active.journal.contentDigest,
                    reason: restoreError.message
                };
            }
        }
        throw error;
    }
    const runtimeAfter = await probeRuntime();
    assertContinuity(runtimeBefore, runtimeAfter);
    const resourcesAfter = process.resourceUsage();
    return seal({
        schema: recoveryReceiptSchema,
        planDigest: plan.contentDigest,
        initialReceiptDigest: initialReceipt.receiptDigest,
        runtimeIdentityBefore: runtimeBefore,
        runtimeIdentityAfter: runtimeAfter,
        cases,
        timing: {
            elapsedMilliseconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000
        },
        resources: {
            userCpuMicros: resourcesAfter.userCPUTime - resourcesBefore.userCPUTime,
            systemCpuMicros: resourcesAfter.systemCPUTime - resourcesBefore.systemCPUTime,
            maximumResidentSetSizeKiB: resourcesAfter.maxRSS
        },
        retryCount: 0,
        forbiddenOperationCount: 0,
        terminalStatus: 'verified'
    });
}

export function verifyMutationRecoveryReceipt(receipt, plan)
{
    verifySeal(plan, 'contentDigest', 'mutation recovery plan');
    verifySeal(receipt, 'contentDigest', 'mutation recovery receipt');
    if (receipt.planDigest !== plan.contentDigest
      || receipt.terminalStatus !== 'verified'
      || receipt.retryCount !== 0
      || receipt.forbiddenOperationCount !== 0
      || canonicalJson(receipt.runtimeIdentityBefore) !== canonicalJson(receipt.runtimeIdentityAfter)
      || receipt.cases.length !== plan.envelopeIds.length
      || receipt.cases.some((item, index) => item.envelopeId !== plan.envelopeIds[index]
        || item.status !== 'recovered'))
    {
        throw new Error('mutation recovery receipt does not independently prove exact no-restart recovery');
    }
    return receipt;
}
