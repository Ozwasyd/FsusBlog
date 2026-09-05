import assert from 'node:assert/strict';
import test from 'node:test';

import { planDependencyCheckLabels } from '../../tools/governance/dependency-blocker-checks.mjs';
import { buildDependencyBlockerSnapshot } from '../../tools/governance/dependency-blocker-snapshot.mjs';
import { parseRenovatePullRequests } from '../../tools/governance/dependency-freshness-pulls.mjs';

function setup()
{
    const headSha = 'a'.repeat(40);
    const catalog = { items: ['a', 'b'].map((id) => ({ id, packageName: `package-${id}`, group: 'runtime' })) };
    const pull = {
        number: 1, state: 'open', head: { sha: headSha }, labels: [], title: 'Update runtime dependencies', user: { login: 'renovate[bot]' },
        body: '| Package | Update | New value |\n| --- | --- | --- |\n| package-a | patch | 1.1.1 |\n| package-b | major | 2.0.0 |'
    };
    const requiredChecks = { groups: [{ id: 'runtime', checksByUpdateType: { patch: 'small', major: 'large' } }], checkSets: { small: ['Quality / Test'], large: ['Quality / Test', 'Quality / Production'] } };
    const report = { now: '2026-09-05T00:00:00Z', pullRequests: parseRenovatePullRequests([pull], catalog) };
    const client = { readPullRequest: async () => structuredClone(pull), listWorkflowRuns: async () => [] };
    return { request: { report, catalog, requiredChecks, exceptions: { exceptions: [] }, client }, pull };
}

test('mixed update types on one PR keep the union of canonical required checks', async () => {
    const { request } = setup();
    const snapshot = await buildDependencyBlockerSnapshot(request);
    assert.equal(snapshot.pullRequests.length, 1);
    assert.deepEqual(snapshot.pullRequests[0].dependencyIds, ['a', 'b']);
    const plan = planDependencyCheckLabels({ catalog: request.requiredChecks, pullRequests: snapshot.pullRequests, now: request.report.now });
    assert.deepEqual(plan.blockedPullRequests[0].failedChecks.map((check) => check.name), ['Quality / Production', 'Quality / Test']);
});

test('producer metadata drift at unchanged SHA is rejected before accepting checks', async () => {
    const { request, pull } = setup();
    pull.body = pull.body.replace('major', 'patch');
    await assert.rejects(buildDependencyBlockerSnapshot(request), /mapping_changed/);
});

test('undeclared update type never falls back to patch requirements', async () => {
    const { request } = setup();
    delete request.report.pullRequests[0].updateType;
    await assert.rejects(buildDependencyBlockerSnapshot(request), /invalid_canonical_pull_mapping/);
});

test('metadata change during check collection rejects the completed snapshot', async () => {
    const { request, pull } = setup();
    let calls = 0;
    request.client.readPullRequest = async () => ({ ...pull, body: ++calls === 1 ? pull.body : pull.body.replace('2.0.0', '3.0.0') });
    await assert.rejects(buildDependencyBlockerSnapshot(request), /mapping_changed/);
});
