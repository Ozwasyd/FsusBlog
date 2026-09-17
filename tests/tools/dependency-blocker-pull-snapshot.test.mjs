import assert from 'node:assert/strict';
import test from 'node:test';

const { collectDependencyPullSnapshot } = await import(new URL('../../tools/governance/dependency-blocker-pull-snapshot.mjs', import.meta.url));
const headSha = 'a'.repeat(40);

function setup()
{
    const pull = { number: 1, state: 'open', head: { sha: headSha }, labels: [] };
    const runs = [1, 2].map((id) => ({ id, workflow_id: 10, run_attempt: 1, head_sha: headSha, name: 'Quality', event: 'pull_request', pull_requests: [{ number: 1 }], status: 'completed', conclusion: id === 1 ? 'success' : 'failure' }));
    const jobCalls = [];
    const client = {
        readPullRequest: async () => structuredClone(pull),
        listWorkflowRuns: async () => structuredClone(runs),
        listWorkflowJobs: async (id, attempt) =>
        {
            jobCalls.push([id, attempt]);
            return [{ id: 100, run_id: id, run_attempt: attempt, head_sha: headSha, name: 'Test', status: 'completed', conclusion: 'failure' }];
        }
    };
    return { client, pull, runs, jobCalls };
}

const collect = (client) => collectDependencyPullSnapshot({ client, number: 1, group: 'runtime', updateType: 'patch', dependencyIds: ['a'] });

test('only latest workflow run and exact attempt supply the prefixed required-check name', async () =>
{
    const fixture = setup();
    const result = await collect(fixture.client);
    assert.deepEqual(fixture.jobCalls, [[2, 1]]);
    assert.equal(result.checkRuns[0].name, 'Quality / Test');
    assert.equal(result.checkRuns[0].conclusion, 'failure');
    assert.equal(result.headSha, headSha);
});

test('no workflow evidence remains an empty check set rather than fabricated success', async () =>
{
    const fixture = setup();
    fixture.runs.length = 0;
    assert.deepEqual((await collect(fixture.client)).checkRuns, []);
});

test('PR head change during observation fails closed', async () =>
{
    const fixture = setup();
    let reads = 0;
    fixture.client.readPullRequest = async () => ({ ...fixture.pull, head: { sha: ++reads === 1 ? headSha : 'b'.repeat(40) } });
    await assert.rejects(collect(fixture.client), /changed_during_snapshot/);
});

test('a rerun starting during observation invalidates the collected attempt', async () =>
{
    const fixture = setup();
    let reads = 0;
    fixture.client.listWorkflowRuns = async () => fixture.runs.map((run) => ({ ...run, run_attempt: ++reads > 2 ? 2 : 1 }));
    await assert.rejects(collect(fixture.client), /changed_during_snapshot/);
});

test('jobs with a stale SHA or wrong attempt are never accepted', async () =>
{
    for (const override of [{ head_sha: 'b'.repeat(40) }, { run_attempt: 2 }])
    {
        const fixture = setup();
        fixture.client.listWorkflowJobs = async () => [{ id: 100, run_id: 2, run_attempt: 1, head_sha: headSha, name: 'Test', ...override }];
        await assert.rejects(collect(fixture.client), /ambiguous_job_snapshot/);
    }
});

test('manual or unrelated PR runs cannot stand in for the dependency PR checks', async () =>
{
    const fixture = setup();
    fixture.runs[0].event = 'workflow_dispatch';
    fixture.runs[1].pull_requests = [{ number: 99 }];
    assert.deepEqual((await collect(fixture.client)).checkRuns, []);
});
