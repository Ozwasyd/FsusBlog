import { resultSchema } from './dependency-freshness.mjs';

export const blockerIssueTitle = 'Dependency freshness blockers';

const infrastructureErrors = new Set([
    'registry-network-error',
    'registry-latest-missing',
    'registry-released-at-missing',
    'extract-current-version'
]);
const freshnessStates = new Set(['current', 'latest-target-pr', 'exception', 'uncovered']);

function cell(value)
{
    return String(value ?? '—').replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

/** Consume the complete canonical result; callers must serialize snapshot and mutation. */
export function planBlockerIssue({ report, catalog, exceptions, issues, previousObservations = {}, checkPlan = { blockedPullRequests: [] } })
{
    if (report?.schema !== resultSchema || !['pass', 'fail'].includes(report.status)
        || !Array.isArray(report.results) || !Array.isArray(report.errors)
        || !Number.isFinite(Date.parse(report.now)))
    {
        throw new Error('dependency_blocker_invalid_result');
    }
    if (report.errors.some((error) => infrastructureErrors.has(error.code)))
    {
        throw new Error(`dependency_blocker_source_unavailable:${report.errors.map((error) => error.code).join(',')}`);
    }
    if (!Array.isArray(catalog?.items) || !Array.isArray(exceptions?.exceptions) || !Array.isArray(issues))
    {
        throw new Error('dependency_blocker_incomplete_snapshot');
    }
    const items = new Map(catalog.items.map((item) => [item.id, item]));
    const ids = new Set(report.results.map((result) => result.dependencyId));
    if (items.size !== catalog.items.length || ids.size !== report.results.length || ids.size !== items.size
        || report.results.some((result) => !items.has(result.dependencyId) || !freshnessStates.has(result.state)
            || typeof result.currentVersion !== 'string' || typeof result.latestStable !== 'string')
        || (report.status === 'pass' && report.errors.length > 0))
    {
        throw new Error('dependency_blocker_incomplete_result');
    }
    const matching = issues.filter((issue) => issue.title === blockerIssueTitle && !issue.pull_request);
    if (matching.length > 1 || matching.some((issue) => !Number.isSafeInteger(issue.number)
        || issue.number <= 0 || !['open', 'closed'].includes(issue.state)))
    {
        throw new Error('dependency_blocker_issue_not_exact_one');
    }
    const issue = matching[0];
    const failedByDependency = new Map();
    for (const pull of checkPlan.blockedPullRequests)
    {
        for (const id of pull.dependencyIds)
        {
            if (!items.has(id))
            {
                throw new Error('dependency_blocker_unknown_pull_dependency');
            }
            const failures = failedByDependency.get(id) ?? [];
            failures.push(...pull.failedChecks.map((check) => `#${pull.number} ${check.name} (${check.errors.map((error) => error.code).join(', ')}; first failure ${check.firstObservedAt})`));
            failedByDependency.set(id, failures);
        }
    }
    const blockers = report.results.filter((result) => result.state === 'uncovered' || failedByDependency.has(result.dependencyId))
        .sort((left, right) => left.dependencyId < right.dependencyId ? -1 : left.dependencyId > right.dependencyId ? 1 : 0);
    const observations = {};
    const rows = blockers.map((result) => {
        const prior = previousObservations[result.dependencyId];
        if (prior !== undefined && (!Number.isFinite(Date.parse(prior)) || Date.parse(prior) > Date.parse(report.now)))
        {
            throw new Error('dependency_blocker_invalid_first_observed');
        }
        observations[result.dependencyId] = prior ?? report.now;
        const item = items.get(result.dependencyId);
        const exceptionDetails = exceptions.exceptions.filter((exception) => exception.dependencyId === result.dependencyId)
            .map((exception) => `${exception.owner} / ${exception.expiresAt}`).sort().join('; ');
        return `| ${[result.dependencyId, result.currentVersion, result.latestStable,
            `${item.datasource}/${item.packageName}`, result.prNumber ? `#${result.prNumber}` : '—',
            (failedByDependency.get(result.dependencyId) ?? []).sort().join('; ') || '—',
            exceptionDetails || '—', observations[result.dependencyId]].map(cell).join(' | ')} |`;
    });
    const active = blockers.length > 0 || report.status === 'fail';
    if (!active)
    {
        return { action: issue?.state === 'open' ? 'close' : 'none', number: issue?.number, observations };
    }
    const diagnostics = report.errors.map((error) => `${cell(error.code)}: ${cell(error.detail)}`).sort();
    const body = [
        'Canonical dependency freshness blockers; no version policy is computed by this consumer.',
        '',
        '| dependencyId | currentVersion | targetVersion | datasource/package | open PR | failed checks | exception owner/expiry | firstObservedAt |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
        '',
        ...diagnostics.map((diagnostic) => `- ${diagnostic}`)
    ].join('\n');
    return {
        action: !issue ? 'create' : issue.state === 'closed' ? 'reopen' : issue.body === body ? 'none' : 'update',
        number: issue?.number,
        title: blockerIssueTitle,
        body,
        observations
    };
}
