import assert from 'node:assert/strict';
import test from 'node:test';

const { planDependencyCheckLabels } = await import(new URL('../../tools/governance/dependency-blocker-checks.mjs', import.meta.url));
const headSha = 'a'.repeat(40);

function snapshot()
{
    return {
        catalog: { groups: [{ id: 'runtime', checksByUpdateType: { patch: 'standard' } }], checkSets: { standard: ['build', 'test'] } },
        now: '2026-09-05T00:00:00Z',
        pullRequests: [{
            number: 1, headSha, group: 'runtime', updateType: 'patch', labels: [], dependencyIds: ['dependency-a'],
            checkRuns: [
                { name: 'build', status: 'completed', conclusion: 'success', headSha },
                { name: 'test', status: 'completed', conclusion: 'failure', headSha }
            ]
        }]
    };
}

test('first failure is recorded but not labelled before the 24-hour boundary', () =>
{
    const request = snapshot();
    const first = planDependencyCheckLabels(request);
    assert.deepEqual(first.labels, []);
    assert.equal(first.blockedPullRequests[0].failedChecks[0].name, 'test');
    request.previousFailures = first.failures;
    request.now = '2026-09-05T23:59:59Z';
    assert.deepEqual(planDependencyCheckLabels(request).labels, []);
    request.now = '2026-09-06T00:00:00Z';
    assert.deepEqual(planDependencyCheckLabels(request).labels, [{ number: 1, action: 'add', label: 'dependency-blocked' }]);
});

test('full required-check recovery removes only dependency-blocked and clears timers', () =>
{
    const request = snapshot();
    request.previousFailures = planDependencyCheckLabels(request).failures;
    request.pullRequests[0].labels = ['dependency-blocked', 'status:blocked'];
    request.pullRequests[0].checkRuns[1].conclusion = 'success';
    const result = planDependencyCheckLabels(request);
    assert.deepEqual(result.labels, [{ number: 1, action: 'remove', label: 'dependency-blocked' }]);
    assert.deepEqual(result.failures, {});
    assert.deepEqual(result.blockedPullRequests, []);
});

test('new PR head does not inherit the previous revision failure age', () =>
{
    const request = snapshot();
    request.previousFailures = planDependencyCheckLabels(request).failures;
    request.now = '2026-09-07T00:00:00Z';
    request.pullRequests[0].headSha = 'b'.repeat(40);
    request.pullRequests[0].checkRuns.forEach((run) =>
    {
        run.headSha = 'b'.repeat(40);
    });
    assert.deepEqual(planDependencyCheckLabels(request).labels, []);
});

test('missing, skipped and neutral checks remain failures under the canonical evaluator', () =>
{
    for (const conclusion of ['skipped', 'neutral', null])
    {
        const request = snapshot();
        request.pullRequests[0].checkRuns[1].conclusion = conclusion;
        const result = planDependencyCheckLabels(request);
        assert.equal(result.blockedPullRequests[0].failedChecks.length, 1);
        assert.deepEqual(result.labels, []);
    }
});

test('stale-head check evidence and unknown required-check groups fail closed', () =>
{
    const request = snapshot();
    request.pullRequests[0].checkRuns[0].headSha = 'b'.repeat(40);
    assert.throws(() => planDependencyCheckLabels(request), /stale_head/);
    request.pullRequests[0].checkRuns[0].headSha = headSha;
    request.pullRequests[0].group = 'unknown';
    assert.throws(() => planDependencyCheckLabels(request), /unregistered_group/);
});

test('existing blocker label is idempotent and cannot be removed while checks still fail', () =>
{
    const request = snapshot();
    request.previousFailures = planDependencyCheckLabels(request).failures;
    request.now = '2026-09-07T00:00:00Z';
    request.pullRequests[0].labels = ['dependency-blocked'];
    assert.deepEqual(planDependencyCheckLabels(request).labels, []);
});
