import { canonicalDigest } from './execution-replay-contract.mjs';

export const schedulerReplayPlanSchema = 'fsusblog.scheduler-replay-plan.v1';
export const schedulerReplayActualSchema = 'fsusblog.scheduler-replay-actual.v1';

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function tierCatalog(tiers)
{
    assert(Array.isArray(tiers) && tiers.length > 0, 'scheduler replay tiers must be non-empty');
    const ids = tiers.map((tier) => tier.id);
    assert(new Set(ids).size === ids.length, 'scheduler replay tier IDs must be unique');
    return tiers.map((tier) => ({
        id: tier.id,
        executionDependsOn: [...(tier.executionDependsOn ?? [])].sort(),
        executionClass: tier.executionClass ?? null,
        parallelizable: tier.parallelizable === true,
        exclusiveResources: [...(tier.exclusiveResources ?? [])].sort(),
        services: [...(tier.services ?? [])].sort(),
        resourceClass: tier.resourceClass ?? null
    })).sort((left, right) => left.id.localeCompare(right.id));
}

export function createSchedulerReplayPlan({
    tiers,
    sourceCommit,
    worktreeFingerprint,
    schedulerRunId,
    readyOrderPolicy,
    shuffleSeed,
    concurrencyCap,
    expectedAdmissionSequence
})
{
    assert(['canonical', 'seeded-shuffle'].includes(readyOrderPolicy), 'scheduler ready order policy is unsupported');
    assert(typeof shuffleSeed === 'string' && shuffleSeed.length > 0, 'scheduler shuffle seed is required');
    assert(Number.isInteger(concurrencyCap) && concurrencyCap > 0, 'scheduler concurrency cap must be positive');
    const catalog = tierCatalog(tiers);
    const eligibleStepIds = catalog.map((tier) => tier.id);
    assert(Array.isArray(expectedAdmissionSequence), 'scheduler expected admission sequence is required');
    assert(expectedAdmissionSequence.length === eligibleStepIds.length, 'scheduler expected admission sequence is incomplete');
    assert(new Set(expectedAdmissionSequence).size === expectedAdmissionSequence.length,
        'scheduler expected admission sequence contains duplicates');
    assert(expectedAdmissionSequence.every((id) => eligibleStepIds.includes(id)),
        'scheduler expected admission sequence contains unknown steps');
    const plan = {
        schema: schedulerReplayPlanSchema,
        sealed: true,
        sourceCommit,
        worktreeFingerprint,
        schedulerRunId,
        schedulerReadyOrderPolicy: readyOrderPolicy,
        schedulerShuffleSeed: shuffleSeed,
        dependencyCatalogDigest: canonicalDigest(catalog),
        eligibleStepIds,
        concurrencyCap,
        expectedAdmissionSequence,
        planDigest: null
    };
    plan.planDigest = canonicalDigest({ ...plan, planDigest: null });
    return plan;
}

export function validateSchedulerReplayPlan(plan, { tiers, maxParallel })
{
    assert(plan?.schema === schedulerReplayPlanSchema && plan.sealed === true,
        'scheduler replay plan schema/seal is invalid');
    assert(plan.planDigest === canonicalDigest({ ...plan, planDigest: null }), 'scheduler replay plan digest mismatch');
    const catalog = tierCatalog(tiers);
    assert(plan.dependencyCatalogDigest === canonicalDigest(catalog), 'scheduler replay catalog/dependency drift');
    assert(plan.concurrencyCap === maxParallel, 'scheduler replay concurrency cap drift');
    assert(JSON.stringify(plan.eligibleStepIds) === JSON.stringify(catalog.map((tier) => tier.id)),
        'scheduler replay eligible step set drift');
    return plan;
}

export function createSchedulerReplayActual({ plan, checkpoint })
{
    assert(checkpoint?.runId === plan.schedulerRunId, 'scheduler replay checkpoint is cross-run');
    const waves = checkpoint.priorityScheduling?.waves;
    assert(Array.isArray(waves), 'scheduler replay checkpoint waves are missing');
    const admissionEvents = [];
    for (const wave of waves)
    {
        assert(Array.isArray(wave.readyTierIds) && Array.isArray(wave.admissionOrder),
            `scheduler replay wave ${wave.wave} ready/admission data is missing`);
        const blockers = wave.decisions.filter((decision) => decision.admitted !== true).map((decision) => ({
            tierId: decision.tierId,
            blocker: decision.hardConstraint
        }));
        for (const decision of wave.decisions.filter((entry) => entry.admitted === true))
        {
            admissionEvents.push({
                sequenceIndex: admissionEvents.length,
                wave: wave.wave,
                readySet: [...wave.readyTierIds],
                readySetDigest: canonicalDigest(wave.readyTierIds),
                admissionOrder: [...wave.admissionOrder],
                chosenStep: decision.tierId,
                blockers,
                workerSlot: checkpoint.tiers?.[decision.tierId]?.priorityDecision?.rank ?? decision.rank ?? null,
                outcome: checkpoint.tiers?.[decision.tierId]?.status ?? 'unknown'
            });
        }
    }
    const admittedStepIds = admissionEvents.map((event) => event.chosenStep);
    assert(JSON.stringify(admittedStepIds) === JSON.stringify(plan.expectedAdmissionSequence),
        'scheduler replay admission sequence drift');
    assert(checkpoint.maxParallel === plan.concurrencyCap, 'scheduler replay actual concurrency cap drift');
    const actual = {
        schema: schedulerReplayActualSchema,
        planDigest: plan.planDigest,
        schedulerRunId: plan.schedulerRunId,
        sourceState: checkpoint.sourceState,
        eligibleStepIds: plan.eligibleStepIds,
        admittedStepIds,
        concurrencyCap: checkpoint.maxParallel,
        admissionEvents,
        cancellation: checkpoint.status === 'success' ? null : checkpoint.failure,
        outcome: checkpoint.status,
        contentDigest: null
    };
    actual.contentDigest = canonicalDigest({ ...actual, contentDigest: null });
    return actual;
}

export function validateSchedulerReplayActual(actual, plan)
{
    assert(actual?.schema === schedulerReplayActualSchema, 'scheduler replay actual schema is invalid');
    assert(actual.planDigest === plan.planDigest, 'scheduler replay actual is cross-plan');
    assert(actual.schedulerRunId === plan.schedulerRunId, 'scheduler replay actual is cross-run');
    assert(actual.contentDigest === canonicalDigest({ ...actual, contentDigest: null }),
        'scheduler replay actual digest mismatch');
    assert(JSON.stringify(actual.eligibleStepIds) === JSON.stringify(plan.eligibleStepIds),
        'scheduler replay actual eligible set drift');
    assert(JSON.stringify(actual.admittedStepIds) === JSON.stringify(plan.expectedAdmissionSequence),
        'scheduler replay actual admission sequence drift');
    assert(actual.concurrencyCap === plan.concurrencyCap, 'scheduler replay actual concurrency cap drift');
    return actual;
}
