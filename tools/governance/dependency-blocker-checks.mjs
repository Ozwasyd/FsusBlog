import { evaluateRequiredChecks, resolveGroupChecks } from './dependency-required-checks.mjs';

const failureDelayMs = 24 * 60 * 60 * 1000;

/** Track failed required checks by PR head and name, never by a caller-provided age. */
export function planDependencyCheckLabels({ catalog, pullRequests, now, previousFailures = {} })
{
    const instant = Date.parse(now);
    if (!Number.isFinite(instant) || !Array.isArray(pullRequests))
    {
        throw new Error('dependency_checks_invalid_snapshot');
    }
    const seen = new Set();
    const failures = {};
    const blockedPullRequests = [];
    const labels = [];
    for (const pull of [...pullRequests].sort((left, right) => left.number - right.number))
    {
        if (!Number.isSafeInteger(pull.number) || pull.number <= 0 || seen.has(pull.number)
            || !/^[0-9a-f]{40}$/.test(pull.headSha) || !Array.isArray(pull.checkRuns)
            || !Array.isArray(pull.labels) || !Array.isArray(pull.dependencyIds) || pull.dependencyIds.length === 0)
        {
            throw new Error('dependency_checks_invalid_pull_request');
        }
        seen.add(pull.number);
        const required = resolveGroupChecks(catalog, pull.group, pull.updateType);
        if (required.length === 0)
        {
            throw new Error(`dependency_checks_unregistered_group:${pull.group}:${pull.updateType}`);
        }
        if (pull.checkRuns.some((run) => run.headSha !== pull.headSha))
        {
            throw new Error(`dependency_checks_stale_head:${pull.number}`);
        }
        const failedChecks = [];
        for (const name of required)
        {
            const errors = evaluateRequiredChecks([name], pull.checkRuns);
            if (errors.length === 0)
            {
                continue;
            }
            const key = JSON.stringify([pull.number, pull.headSha, name]);
            const firstObservedAt = previousFailures[key] ?? now;
            const first = Date.parse(firstObservedAt);
            if (!Number.isFinite(first) || first > instant)
            {
                throw new Error('dependency_checks_invalid_first_failure');
            }
            failures[key] = firstObservedAt;
            failedChecks.push({ name, errors, firstObservedAt, overdue: instant - first >= failureDelayMs });
        }
        const overdue = failedChecks.some((check) => check.overdue);
        const hasLabel = pull.labels.includes('dependency-blocked');
        if (overdue && !hasLabel)
        {
            labels.push({ number: pull.number, action: 'add', label: 'dependency-blocked' });
        }
        else if (failedChecks.length === 0 && hasLabel)
        {
            labels.push({ number: pull.number, action: 'remove', label: 'dependency-blocked' });
        }
        if (failedChecks.length > 0)
        {
            blockedPullRequests.push({ number: pull.number, dependencyIds: [...pull.dependencyIds].sort(), failedChecks });
        }
    }
    return { failures, blockedPullRequests, labels };
}
