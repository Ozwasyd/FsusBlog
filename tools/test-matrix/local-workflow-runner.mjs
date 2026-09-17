import { buildLocalWorkflowPlan } from './local-workflow-plan.mjs';

function printLocalWorkflowPlan({
    matrix,
    workflowPlan,
    behaviorDocAdmissionTierId,
    effectiveCiJobTiers,
    tierMap,
    tierReproductionCommand,
    ciJobReproductionCommand
})
{
    console.log(`Local CI workflow "${workflowPlan.aggregateJobId}" (matrix-derived):`);
    let index = 1;
    for (const jobId of workflowPlan.orderedJobIds)
    {
        if (jobId === 'validate-matrix')
        {
            for (const tier of effectiveCiJobTiers(matrix, jobId))
            {
                console.log(`${index}. ${tier.id} [setup]: ${tierReproductionCommand(tier, { noDeps: true })}`);
                index += 1;
            }
            continue;
        }
        if (jobId === behaviorDocAdmissionTierId)
        {
            const tier = tierMap(matrix).get(behaviorDocAdmissionTierId);
            console.log(`${index}. ${jobId} [setup]: ${tierReproductionCommand(tier, { noDeps: true })}`);
            index += 1;
            continue;
        }
        console.log(`${index}. ${jobId} [producer]: ${ciJobReproductionCommand(jobId, matrix)}`);
        index += 1;
    }
    console.log(
        `${index}. ${workflowPlan.aggregateJobId} [aggregate]:`
        + ` node tools/run-test-matrix.mjs aggregate ${workflowPlan.aggregateJobId}`
    );
}

export async function runLocalWorkflow({
    matrix,
    aggregateJobId,
    args,
    behaviorDocAdmissionTierId,
    dependencies
})
{
    const options = dependencies.parseCiJobOptions(args);
    if (options.shard)
    {
        throw new Error(`${aggregateJobId} local workflow does not accept --shard; shard its producer ci-job instead`);
    }
    const workflowPlan = buildLocalWorkflowPlan({
        aggregateJobId,
        aggregatePlan: dependencies.buildAggregatePlan(matrix, aggregateJobId),
        ciPlan: dependencies.buildCiPlan(matrix, 'local-workflow')
    });
    if (options.planOnly)
    {
        printLocalWorkflowPlan({
            matrix,
            workflowPlan,
            behaviorDocAdmissionTierId,
            ...dependencies
        });
        return;
    }

    const validateJobId = 'validate-matrix';
    const validateTier = dependencies.tierMap(matrix).get(validateJobId);
    if (!workflowPlan.orderedJobIds.includes(validateJobId) || !validateTier)
    {
        throw new Error(`${aggregateJobId} local workflow is missing validate-matrix setup`);
    }
    const setupRunId = dependencies.createRunId(`ci-workflow/${aggregateJobId}`);
    const { sourceState } = await dependencies.collectSchedulerSourceState();
    dependencies.executeStaticMatrixPrerequisite(validateTier, { runId: setupRunId, sourceState });
    const behaviorDocAdmission = await dependencies.establishBehaviorDocAdmission({
        runId: setupRunId
    });
    console.error(
        `[matrix:ci-workflow:${aggregateJobId}]`
        + ` admission=${dependencies.relativeToRoot(behaviorDocAdmission.receiptFile)}`
        + ` digest=${behaviorDocAdmission.contentDigest}`
    );

    for (const jobId of workflowPlan.orderedJobIds)
    {
        if (jobId === behaviorDocAdmissionTierId)
        {
            continue;
        }
        const status = await dependencies.runCiJob(matrix, jobId, args, {
            behaviorDocAdmission,
            preflightComplete: jobId === validateJobId
        });
        if (status !== 0)
        {
            console.error(`[matrix:ci-workflow:${aggregateJobId}] stopped after ${jobId}`);
            return;
        }
    }
    dependencies.aggregateCiJob(matrix, aggregateJobId, []);
}
