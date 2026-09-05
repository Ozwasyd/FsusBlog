import { planScheduledBlockers } from './dependency-blocker-state.mjs';

/** Narrow GitHub adapter: issue reconciliation and one label, never PR merge/close. */
export function createDependencyBlockerGitHub({ repository, token, fetchImpl = fetch })
{
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || typeof token !== 'string' || token.length === 0)
    {
        throw new Error('dependency_blocker_github_configuration');
    }
    const prefix = `https://api.github.com/repos/${repository}`;
    async function request(method, route, body)
    {
        const response = await fetchImpl(`${prefix}${route}`, {
            method,
            redirect: 'error',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'X-GitHub-Api-Version': '2022-11-28'
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(20_000)
        });
        if (!response.ok)
        {
            // Never echo the response body or authorization headers into diagnostics.
            throw new Error(`dependency_blocker_github_error:${method}:${route}:${response.status}`);
        }
        return response.status === 204 ? null : response.json();
    }
    function issueRoute(number)
    {
        if (!Number.isSafeInteger(number) || number <= 0)
        {
            throw new Error('dependency_blocker_invalid_issue_number');
        }
        return `/issues/${number}`;
    }
    return {
        async listIssues()
        {
            const issues = [];
            for (let page = 1; page <= 100; page++)
            {
                const batch = await request('GET', `/issues?state=all&per_page=100&page=${page}`);
                if (!Array.isArray(batch))
                {
                    throw new Error('dependency_blocker_github_invalid_issue_page');
                }
                issues.push(...batch);
                if (batch.length < 100)
                {
                    return issues;
                }
            }
            throw new Error('dependency_blocker_github_issue_page_limit');
        },
        async applyLabel(plan)
        {
            if (plan.label !== 'dependency-blocked' || !['add', 'remove'].includes(plan.action))
            {
                throw new Error('dependency_blocker_invalid_label_plan');
            }
            const route = `${issueRoute(plan.number)}/labels`;
            return plan.action === 'add'
                ? request('POST', route, { labels: ['dependency-blocked'] })
                : request('DELETE', `${route}/dependency-blocked`);
        },
        async applyIssue(plan)
        {
            if (plan.action === 'none')
            {
                return null;
            }
            if (plan.action === 'create')
            {
                return request('POST', '/issues', { title: plan.title, body: plan.body });
            }
            if (!['update', 'reopen', 'close'].includes(plan.action))
            {
                throw new Error('dependency_blocker_invalid_issue_plan');
            }
            return request('PATCH', issueRoute(plan.number), plan.action === 'close'
                ? { state: 'closed' }
                : { state: 'open', body: plan.body });
        }
    };
}

/** The exclusive run must cover both snapshot acquisition and all mutations. */
export async function reconcileDependencyBlockers({ withExclusiveRun, loadSnapshot, client })
{
    if (typeof withExclusiveRun !== 'function')
    {
        throw new Error('dependency_blocker_exclusive_run_required');
    }
    return withExclusiveRun(async () => {
        const issues = await client.listIssues();
        const snapshot = await loadSnapshot();
        const plan = planScheduledBlockers({ ...snapshot, issues });
        // Failures in any label operation must leave the blocker issue open.
        for (const label of plan.labels)
        {
            await client.applyLabel(label);
        }
        const result = await client.applyIssue(plan.issue);
        return { plan, issueNumber: result?.number ?? plan.issue.number };
    });
}
