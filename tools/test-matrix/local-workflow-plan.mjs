export function buildLocalWorkflowPlan({ aggregateJobId, aggregatePlan, ciPlan })
{
    const byJob = new Map(ciPlan.jobs.map((job) => [job.id, job]));
    const selectedJobIds = new Set(aggregatePlan.dependencyJobs);
    const pending = [...selectedJobIds];
    while (pending.length > 0)
    {
        const jobId = pending.pop();
        const job = byJob.get(jobId);
        if (!job)
        {
            throw new Error(`aggregate dependency job is absent from ci-plan: ${jobId}`);
        }
        for (const dependencyId of job.needs)
        {
            if (dependencyId === aggregateJobId || selectedJobIds.has(dependencyId))
            {
                continue;
            }
            if (!byJob.has(dependencyId))
            {
                throw new Error(`CI job dependency is absent from ci-plan: ${jobId} -> ${dependencyId}`);
            }
            selectedJobIds.add(dependencyId);
            pending.push(dependencyId);
        }
    }

    const orderedJobIds = [];
    const completed = new Set();
    while (orderedJobIds.length < selectedJobIds.size)
    {
        const ready = [...selectedJobIds]
            .filter((jobId) => !completed.has(jobId))
            .filter((jobId) => byJob.get(jobId).needs
                .filter((dependencyId) => selectedJobIds.has(dependencyId))
                .every((dependencyId) => completed.has(dependencyId)))
            .sort();
        if (ready.length === 0)
        {
            const unresolved = [...selectedJobIds].filter((jobId) => !completed.has(jobId)).sort();
            throw new Error(`local CI workflow contains a job dependency cycle: ${unresolved.join(', ')}`);
        }
        for (const jobId of ready)
        {
            completed.add(jobId);
            orderedJobIds.push(jobId);
        }
    }

    return {
        aggregateJobId,
        orderedJobIds,
        aggregatePlan
    };
}
