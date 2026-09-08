import { planDependencyCheckLabels } from './dependency-blocker-checks.mjs';
import { blockerIssueTitle, planBlockerIssue } from './dependency-freshness-blockers.mjs';

const marker = '<!-- fsusblog-dependency-blocker-state:';
const stateSchema = 'fsusblog.dependency-blocker-state.v1';

export function readBlockerState(body = '')
{
    const parts = body.split(marker);
    if (parts.length === 1)
    {
        return { observations: {}, failures: {} };
    }
    if (parts.length !== 2 || !parts[1].includes(' -->'))
    {
        throw new Error('dependency_blocker_state_ambiguous');
    }
    const encoded = parts[1].split(' -->')[0];
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64') !== encoded)
    {
        throw new Error('dependency_blocker_state_encoding');
    }
    const state = JSON.parse(decoded.toString('utf8'));
    if (state.schema !== stateSchema || Object.keys(state).sort().join(',') !== 'failures,observations,schema')
    {
        throw new Error('dependency_blocker_state_schema');
    }
    for (const values of [state.observations, state.failures])
    {
        if (!values || typeof values !== 'object' || Array.isArray(values)
            || Object.values(values).some((value) => typeof value !== 'string' || !Number.isFinite(Date.parse(value))))
        {
            throw new Error('dependency_blocker_state_invalid_timestamps');
        }
    }
    return state;
}

/** A complete read snapshot is planned before any GitHub mutation is attempted. */
export function planScheduledBlockers(snapshot)
{
    const matching = snapshot.issues.filter((issue) => issue.title === blockerIssueTitle && !issue.pull_request);
    if (matching.length > 1)
    {
        throw new Error('dependency_blocker_issue_not_exact_one');
    }
    const existing = matching[0];
    const prior = existing?.state === 'open' ? readBlockerState(existing.body) : { observations: {}, failures: {} };
    const numbers = new Set(snapshot.pullRequests.map((pull) => pull.number));
    if (snapshot.report.results.some((result) => result.prNumber && !numbers.has(result.prNumber)))
    {
        throw new Error('dependency_blocker_missing_pull_snapshot');
    }
    const checkPlan = planDependencyCheckLabels({
        catalog: snapshot.requiredChecks,
        pullRequests: snapshot.pullRequests,
        now: snapshot.report.now,
        previousFailures: prior.failures
    });
    const plan = planBlockerIssue({ ...snapshot, previousObservations: prior.observations, checkPlan });
    if (plan.body !== undefined)
    {
        const state = { schema: stateSchema, observations: plan.observations, failures: checkPlan.failures };
        const encoded = Buffer.from(JSON.stringify(state)).toString('base64');
        plan.body += `\n\n${marker}${encoded} -->`;
        if (existing?.state === 'open')
        {
            plan.action = existing.body === plan.body ? 'none' : 'update';
        }
    }
    return { issue: plan, labels: checkPlan.labels };
}
