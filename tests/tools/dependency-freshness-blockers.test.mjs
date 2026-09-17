import assert from 'node:assert/strict';
import test from 'node:test';

const { resultSchema } = await import(new URL('../../tools/governance/dependency-freshness.mjs', import.meta.url));
const { blockerIssueTitle, planBlockerIssue } = await import(new URL('../../tools/governance/dependency-freshness-blockers.mjs', import.meta.url));
function input()
{
    return {
        report: {
            schema: resultSchema, status: 'fail', now: '2026-09-05T00:00:00Z',
            results: ['b', 'a'].map((dependencyId) => ({ dependencyId, state: 'uncovered', currentVersion: '1', latestStable: '2' })),
            errors: [{ code: 'behind-over-24h', detail: 'a' }]
        },
        catalog: { items: ['a', 'b'].map((id) => ({ id, datasource: 'npm', packageName: `package-${id}` })) },
        exceptions: { exceptions: [] },
        issues: []
    };
}

test('first blocker creates the fixed title and sorts dependencies stably', () =>
{
    const plan = planBlockerIssue(input());
    assert.equal(plan.action, 'create');
    assert.equal(plan.title, blockerIssueTitle);
    assert.ok(plan.body.indexOf('| a |') < plan.body.indexOf('| b |'));
    assert.match(plan.body, /npm\/package-a/);
});

test('later identical result preserves first observation and produces no mutation', () =>
{
    const initial = planBlockerIssue(input());
    const next = input();
    next.report.now = '2026-09-05T06:00:00Z';
    next.report.results.reverse();
    next.previousObservations = initial.observations;
    next.issues = [{ number: 10, title: blockerIssueTitle, state: 'open', body: initial.body }];
    assert.equal(planBlockerIssue(next).action, 'none');
    next.report.results[0].latestStable = '3';
    assert.equal(planBlockerIssue(next).action, 'update');
});

test('complete recovery closes the same issue and clears observation state', () =>
{
    const value = input();
    value.report.status = 'pass';
    value.report.errors = [];
    value.report.results.forEach((result) =>
    {
        result.state = 'current';
    });
    value.issues = [{ number: 10, title: blockerIssueTitle, state: 'open' }];
    assert.deepEqual(planBlockerIssue(value), { action: 'close', number: 10, observations: {} });
});

test('new blocker reopens the existing closed issue without creating another', () =>
{
    const value = input();
    value.issues = [{ number: 10, title: blockerIssueTitle, state: 'closed' }];
    assert.equal(planBlockerIssue(value).action, 'reopen');
    assert.equal(planBlockerIssue(value).number, 10);
});

test('duplicate fixed-title issues fail closed', () =>
{
    const value = input();
    value.issues = [1, 2].map((number) => ({ number, title: blockerIssueTitle, state: 'open' }));
    assert.throws(() => planBlockerIssue(value), /issue_not_exact_one/);
});

test('registry and extraction errors cannot generate an issue-closing plan', () =>
{
    for (const code of ['registry-network-error', 'registry-latest-missing', 'extract-current-version'])
    {
        const value = input();
        value.report.errors = [{ code, detail: 'unavailable' }];
        assert.throws(() => planBlockerIssue(value), /source_unavailable/);
    }
});

test('partial and duplicate dependency rosters are rejected', () =>
{
    const value = input();
    value.report.results.pop();
    assert.throws(() => planBlockerIssue(value), /incomplete_result/);
    value.report.results.push(value.report.results[0]);
    assert.throws(() => planBlockerIssue(value), /incomplete_result/);
});

test('exception diagnostics retain owner and expiry without revalidating exception policy', () =>
{
    const value = input();
    value.exceptions.exceptions.push({ dependencyId: 'a', owner: 'owner-a', expiresAt: '2026-09-04T00:00:00Z' });
    value.report.errors = [{ code: 'exception-expired', detail: 'a' }];
    const plan = planBlockerIssue(value);
    assert.match(plan.body, /owner-a \/ 2026-09-04T00:00:00Z/);
    assert.match(plan.body, /exception-expired: a/);
});

test('validated supersession is rendered in both directions on its dependency row', () =>
{
    const value = input();
    value.report.supersession = [{ dependencyId: 'a', predecessor: 10, successor: 11 }];
    const plan = planBlockerIssue(value);
    assert.match(plan.body, /#10 superseded by #11; #11 supersedes #10/);
});
