function latestRuns(runs, headSha, number)
{
    const selected = new Map();
    const ids = new Set();
    for (const run of runs)
    {
        if (run.head_sha !== headSha || ![run.id, run.workflow_id, run.run_attempt].every((value) => Number.isSafeInteger(value) && value > 0)
            || typeof run.name !== 'string' || ids.has(run.id))
        {
            throw new Error('dependency_blocker_invalid_workflow_snapshot');
        }
        ids.add(run.id);
        if (run.event !== 'push' && !(run.event === 'pull_request' && run.pull_requests?.some((pull) => pull.number === number)))
        {
            continue;
        }
        const existing = selected.get(run.workflow_id);
        if (!existing || run.id > existing.id)
        {
            selected.set(run.workflow_id, run);
        }
    }
    return [...selected.values()].sort((left, right) => left.id - right.id);
}

function runIdentity(runs)
{
    return JSON.stringify(runs.map((run) => [run.id, run.workflow_id, run.run_attempt, run.status, run.conclusion]));
}

/** Observe current-head Actions jobs; absent or unsupported checks remain missing, never successful. */
export async function collectDependencyPullSnapshot({ client, number, group, updateType, dependencyIds, requirements, verifyPull })
{
    const pull = await client.readPullRequest(number);
    const headSha = pull?.head?.sha;
    if (pull?.number !== number || pull.state !== 'open' || !/^[0-9a-f]{40}$/.test(headSha) || !Array.isArray(pull.labels))
    {
        throw new Error('dependency_blocker_invalid_open_pull');
    }
    await verifyPull?.(pull);
    const runs = latestRuns(await client.listWorkflowRuns(headSha), headSha, number);
    const checkRuns = [];
    const names = new Set();
    for (const run of runs)
    {
        const jobs = await client.listWorkflowJobs(run.id, run.run_attempt);
        for (const job of jobs)
        {
            const name = `${run.name} / ${job.name}`;
            if (job.head_sha !== headSha || job.run_id !== run.id || job.run_attempt !== run.run_attempt
                || typeof job.name !== 'string' || names.has(name))
            {
                throw new Error('dependency_blocker_ambiguous_job_snapshot');
            }
            names.add(name);
            checkRuns.push({ name, headSha, status: job.status, conclusion: job.conclusion, runId: run.id, runAttempt: run.run_attempt, jobId: job.id });
        }
    }
    const afterRuns = latestRuns(await client.listWorkflowRuns(headSha), headSha, number);
    const after = await client.readPullRequest(number);
    if (after?.number !== number || after.state !== 'open' || after.head?.sha !== headSha || runIdentity(runs) !== runIdentity(afterRuns))
    {
        throw new Error('dependency_blocker_pull_changed_during_snapshot');
    }
    if (!Array.isArray(after.labels) || after.labels.some((label) => typeof label?.name !== 'string'))
    {
        throw new Error('dependency_blocker_invalid_pull_labels');
    }
    await verifyPull?.(after);
    return { number, headSha, group, updateType, dependencyIds, requirements, checkRuns, labels: after.labels.map((label) => label.name) };
}
