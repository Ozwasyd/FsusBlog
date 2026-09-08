import assert from 'node:assert/strict';
import test from 'node:test';

import { planScheduledBlockers, readBlockerState } from '../../tools/governance/dependency-blocker-state.mjs';
import { resultSchema } from '../../tools/governance/dependency-freshness.mjs';

function snapshot()
{
    const headSha = 'a'.repeat(40);
    return {
        report: {
            schema: resultSchema, status: 'pass', now: '2026-09-05T00:00:00Z', errors: [],
            results: [{ dependencyId: 'a', currentVersion: '1', latestStable: '2', state: 'latest-target-pr', prNumber: 10 }]
        },
        catalog: { items: [{ id: 'a', datasource: 'npm', packageName: 'example' }] },
        exceptions: { exceptions: [] },
        requiredChecks: { groups: [{ id: 'runtime', checksByUpdateType: { minor: 'standard' } }], checkSets: { standard: ['test'] } },
        issues: [],
        pullRequests: [{
            number: 10, headSha, group: 'runtime', updateType: 'minor', dependencyIds: ['a'], labels: [],
            checkRuns: [{ headSha, name: 'test', status: 'completed', conclusion: 'failure' }]
        }]
    };
}

test('latest-target PR coverage does not hide failed checks and issue state carries the timer across runs', () => {
    const value = snapshot();
    const first = planScheduledBlockers(value);
    assert.equal(first.issue.action, 'create');
    assert.match(first.issue.body, /#10 test \(check-failure/);
    assert.deepEqual(first.labels, []);
    assert.equal(Object.keys(readBlockerState(first.issue.body).failures).length, 1);
    value.issues = [{ number: 20, title: first.issue.title, state: 'open', body: first.issue.body }];
    value.report.now = '2026-09-06T00:00:00Z';
    const later = planScheduledBlockers(value);
    assert.equal(later.issue.action, 'none');
    assert.deepEqual(later.labels, [{ number: 10, action: 'add', label: 'dependency-blocked' }]);
    value.pullRequests[0].labels = ['dependency-blocked'];
    value.pullRequests[0].checkRuns[0].conclusion = 'success';
    const recovered = planScheduledBlockers(value);
    assert.equal(recovered.issue.action, 'close');
    assert.deepEqual(recovered.labels, [{ number: 10, action: 'remove', label: 'dependency-blocked' }]);
});

test('an existing PR result without its complete check snapshot cannot close an issue', () => {
    const value = snapshot();
    value.pullRequests = [];
    assert.throws(() => planScheduledBlockers(value), /missing_pull_snapshot/);
});

test('malformed and duplicated persisted state is rejected before planning', () => {
    const first = planScheduledBlockers(snapshot());
    assert.throws(() => readBlockerState(`${first.issue.body}\n${first.issue.body}`), /state_ambiguous/);
    assert.throws(() => readBlockerState('<!-- fsusblog-dependency-blocker-state:not-base64 -->'), /state_encoding/);
});

test('closed issue reopening starts a new continuous-failure interval', () => {
    const value = snapshot();
    const first = planScheduledBlockers(value);
    value.issues = [{ number: 20, title: first.issue.title, state: 'closed', body: first.issue.body }];
    value.report.now = '2026-09-08T00:00:00Z';
    const reopened = planScheduledBlockers(value);
    assert.equal(reopened.issue.action, 'reopen');
    assert.deepEqual(reopened.labels, []);
    assert.deepEqual(Object.values(readBlockerState(reopened.issue.body).failures), ['2026-09-08T00:00:00Z']);
});
