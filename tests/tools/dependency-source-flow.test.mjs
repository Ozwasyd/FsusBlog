import assert from 'node:assert/strict';
import test from 'node:test';
const { evaluateFreshness } = await import(new URL('../../tools/governance/dependency-freshness.mjs', import.meta.url));
const { parseRenovatePullRequests } = await import(new URL('../../tools/governance/dependency-freshness-pulls.mjs', import.meta.url));
const { resolveDependencyPullTarget } = await import(new URL('../../tools/governance/dependency-pull-target.mjs', import.meta.url));
const { buildDependencyBlockerSnapshot } = await import(new URL('../../tools/governance/dependency-blocker-snapshot.mjs', import.meta.url));
const { planScheduledBlockers } = await import(new URL('../../tools/governance/dependency-blocker-state.mjs', import.meta.url));
test('source-qualified major PR flows through freshness, required checks, 24h label and recovery', async () =>
{
    const headSha = 'a'.repeat(40);
    const item = { id: 'npm-example', packageName: 'example', manager: 'npm', datasource: 'npm', group: 'runtime',
        files: ['package.json', 'package-lock.json'], fieldPaths: ['/dependencies/example'] };
    const catalog = { items: [item] };
    const config = { enabledManagers: ['npm'], packageRules: [{ matchUpdateTypes: ['major', 'minor', 'patch', 'digest', 'lockFileMaintenance'], enabled: true }] };
    const exceptions = { schema: 'fsusblog.dependency-exceptions.v1', exceptions: [] };
    const pull = { number: 1, state: 'open', head: { sha: headSha }, labels: [], title: 'Update example to v2', user: { login: 'renovate[bot]' },
        body: '| Package | Update | New value |\n| --- | --- | --- |\n| example | major | ^2.0.0 |' };
    const readFileAtHead = async (file, sha) =>
    {
        assert.equal(sha, headSha);
        const root = { dependencies: { example: '^2.0.0' } };
        return JSON.stringify(file === 'package.json' ? root : {
            lockfileVersion: 3, packages: { '': root, 'node_modules/example': { version: '2.1.0' } }
        });
    };
    const mappings = await Promise.all(parseRenovatePullRequests([pull], catalog).map(mapping =>
        resolveDependencyPullTarget({ mapping, item, config, readFileAtHead })));
    const report = evaluateFreshness({ catalog, config, exceptions, root: process.cwd(), now: '2026-09-05T00:00:00Z',
        currentVersions: { [item.id]: { currentVersion: '1.0.0' } },
        registries: { byId: { [item.id]: { latestStable: '2.1.0', releasedAt: '2026-08-01T00:00:00Z' } } }, pullRequests: mappings });
    report.pullRequests = mappings;
    assert.equal(report.status, 'pass');
    assert.equal(report.results[0].state, 'latest-target-pr');
    assert.equal(mappings[0].declaredTargetVersion, '^2.0.0');
    const requiredChecks = { groups: [{ id: 'runtime', checksByUpdateType: { major: 'full' } }], checkSets: { full: ['Quality / Test', 'Quality / Production'] } };
    let conclusion = 'failure';
    const client = { readFileAtHead, readPullRequest: async () => structuredClone(pull),
        listWorkflowRuns: async () => [{ id: 1, workflow_id: 10, run_attempt: 1, head_sha: headSha, name: 'Quality', event: 'pull_request', pull_requests: [{ number: 1 }], status: 'completed', conclusion }],
        listWorkflowJobs: async () => ['Test', 'Production'].map((name, index) => ({ id: index + 1, run_id: 1, run_attempt: 1, head_sha: headSha, name, status: 'completed', conclusion })) };
    const build = () => buildDependencyBlockerSnapshot({ report, catalog, exceptions, config, requiredChecks, client });
    const first = planScheduledBlockers({ ...await build(), issues: [] });
    assert.equal(first.issue.action, 'create');
    assert.match(first.issue.body, /Quality \/ Production/);
    assert.deepEqual(first.labels, []);
    const issue = { number: 10, title: first.issue.title, state: 'open', body: first.issue.body };
    report.now = '2026-09-06T00:00:00Z';
    const later = planScheduledBlockers({ ...await build(), issues: [issue] });
    assert.deepEqual(later.labels, [{ number: 1, action: 'add', label: 'dependency-blocked' }]);
    issue.body = later.issue.body;
    pull.labels = [{ name: 'dependency-blocked' }];
    conclusion = 'success';
    const recovered = planScheduledBlockers({ ...await build(), issues: [issue] });
    assert.equal(recovered.issue.action, 'close');
    assert.equal(recovered.issue.number, 10);
    assert.deepEqual(recovered.labels, [{ number: 1, action: 'remove', label: 'dependency-blocked' }]);
});
