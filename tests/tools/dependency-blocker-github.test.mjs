import assert from 'node:assert/strict';
import test from 'node:test';

const { createDependencyBlockerGitHub, reconcileDependencyBlockers } = await import(new URL('../../tools/governance/dependency-blocker-github.mjs', import.meta.url));
const { resultSchema } = await import(new URL('../../tools/governance/dependency-freshness.mjs', import.meta.url));
function snapshot()
{
    return {
        report: {
            schema: resultSchema, status: 'fail', now: '2026-09-05T00:00:00Z',
            results: [{ dependencyId: 'a', currentVersion: '1', latestStable: '2', state: 'uncovered' }],
            errors: [{ code: 'behind-over-24h', detail: 'a' }]
        },
        catalog: { items: [{ id: 'a', datasource: 'npm', packageName: 'example' }] },
        exceptions: { exceptions: [] }, requiredChecks: {}, pullRequests: []
    };
}

function simulatedGitHub()
{
    const issues = [];
    const calls = [];
    const client = createDependencyBlockerGitHub({
        repository: 'example/test', token: 'simulation-token',
        fetchImpl: async (url, options) =>
        {
            const route = new URL(url).pathname;
            const body = options.body ? JSON.parse(options.body) : undefined;
            calls.push({ method: options.method, route, body });
            if (options.method === 'GET')
            {
                return Response.json(structuredClone(issues));
            }
            if (options.method === 'POST' && route.endsWith('/issues'))
            {
                const created = { ...body, number: issues.length + 1, state: 'open' };
                issues.push(created);
                return Response.json(created, { status: 201 });
            }
            if (options.method === 'PATCH')
            {
                const issue = issues.find((item) => item.number === Number(route.split('/').at(-1)));
                Object.assign(issue, body);
                return Response.json(issue);
            }
            throw new Error('unexpected simulated operation');
        }
    });
    return { client, issues, calls };
}

test('concurrent scheduled simulations read inside the exclusive run and create exact-one issue', async () =>
{
    const simulated = simulatedGitHub();
    let tail = Promise.resolve();
    const withExclusiveRun = (work) =>
    {
        const next = tail.then(work);
        tail = next.catch(() =>
        {});
        return next;
    };
    const run = () => reconcileDependencyBlockers({ client: simulated.client, withExclusiveRun, loadSnapshot: async () => snapshot() });
    await Promise.all([run(), run()]);
    assert.equal(simulated.issues.length, 1);
    assert.equal(simulated.calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(simulated.calls.filter((call) => call.method === 'PATCH').length, 0);
});

test('recovery closes the same issue through the API adapter', async () =>
{
    const simulated = simulatedGitHub();
    const withExclusiveRun = (work) => work();
    await reconcileDependencyBlockers({ client: simulated.client, withExclusiveRun, loadSnapshot: async () => snapshot() });
    const recovered = snapshot();
    recovered.report.status = 'pass';
    recovered.report.errors = [];
    recovered.report.results[0].state = 'current';
    await reconcileDependencyBlockers({ client: simulated.client, withExclusiveRun, loadSnapshot: async () => recovered });
    assert.equal(simulated.issues[0].state, 'closed');
    assert.deepEqual(simulated.calls.at(-1).body, { state: 'closed' });
});

test('registry snapshot failure performs no mutation and leaves the existing blocker open', async () =>
{
    const simulated = simulatedGitHub();
    simulated.issues.push({ number: 1, title: 'Dependency freshness blockers', state: 'open', body: '' });
    await assert.rejects(reconcileDependencyBlockers({
        client: simulated.client, withExclusiveRun: (work) => work(),
        loadSnapshot: async () =>
        {
            throw new Error('registry unavailable');
        }
    }), /registry unavailable/);
    assert.equal(simulated.issues[0].state, 'open');
    assert.deepEqual(simulated.calls.map((call) => call.method), ['GET']);
});

test('permission errors fail without leaking token or response body', async () =>
{
    const client = createDependencyBlockerGitHub({
        repository: 'example/test', token: 'secret-simulation-token',
        fetchImpl: async () => new Response('private response', { status: 403 })
    });
    await assert.rejects(client.listIssues(), (error) =>
    {
        assert.match(error.message, /github_error:GET:.*:403/);
        assert.doesNotMatch(error.message, /secret-simulation-token|private response/);
        return true;
    });
});

test('late pagination failure cannot supply a partial issue snapshot', async () =>
{
    let count = 0;
    const client = createDependencyBlockerGitHub({
        repository: 'example/test', token: 'simulation-token',
        fetchImpl: async () => ++count === 1
            ? Response.json(Array.from({ length: 100 }, (_, number) => ({ number: number + 1 })))
            : new Response('', { status: 503 })
    });
    await assert.rejects(client.listIssues(), /page=2:503/);
    assert.equal(count, 2);
});

test('reconciliation refuses an absent exclusive-run boundary', async () =>
{
    await assert.rejects(reconcileDependencyBlockers({}), /exclusive_run_required/);
});

test('failed label recovery prevents the final blocker issue close', async () =>
{
    const methods = [];
    const client = createDependencyBlockerGitHub({
        repository: 'example/test', token: 'simulation-token',
        fetchImpl: async (url, options) =>
        {
            methods.push(options.method);
            if (options.method === 'GET')
            {
                return Response.json([{ number: 20, title: 'Dependency freshness blockers', state: 'open', body: '' }]);
            }
            assert.equal(options.method, 'DELETE');
            assert.ok(url.endsWith('/issues/10/labels/dependency-blocked'));
            return new Response('', { status: 403 });
        }
    });
    const value = snapshot();
    const headSha = 'a'.repeat(40);
    value.report.status = 'pass';
    value.report.errors = [];
    value.report.results[0].state = 'latest-target-pr';
    value.report.results[0].prNumber = 10;
    value.requiredChecks = { groups: [{ id: 'runtime', checksByUpdateType: { patch: 'standard' } }], checkSets: { standard: ['test'] } };
    value.pullRequests = [{
        number: 10, headSha, group: 'runtime', updateType: 'patch', dependencyIds: ['a'], labels: ['dependency-blocked'],
        checkRuns: [{ headSha, name: 'test', status: 'completed', conclusion: 'success' }]
    }];
    await assert.rejects(reconcileDependencyBlockers({
        client, withExclusiveRun: (work) => work(), loadSnapshot: async () => value
    }), /:403/);
    assert.deepEqual(methods, ['GET', 'DELETE']);
});

test('uncertain create response is not automatically retried into a duplicate issue', async () =>
{
    let creates = 0;
    const client = createDependencyBlockerGitHub({
        repository: 'example/test', token: 'simulation-token',
        fetchImpl: async (url, options) =>
        {
            if (options.method === 'GET')
            {
                return Response.json([]);
            }
            creates++;
            throw new Error('connection lost after server accepted create');
        }
    });
    await assert.rejects(reconcileDependencyBlockers({
        client, withExclusiveRun: (work) => work(), loadSnapshot: async () => snapshot()
    }), /connection lost/);
    assert.equal(creates, 1);
});

test('Actions snapshot routes bind exact head, run and attempt', async () =>
{
    const urls = [];
    const client = createDependencyBlockerGitHub({
        repository: 'example/test', token: 'simulation-token',
        fetchImpl: async (url) =>
        {
            urls.push(url);
            return Response.json(url.includes('/attempts/')
                ? { total_count: 1, jobs: [{ id: 50 }] }
                : { total_count: 1, workflow_runs: [{ id: 20 }] });
        }
    });
    assert.deepEqual(await client.listWorkflowRuns('a'.repeat(40)), [{ id: 20 }]);
    assert.deepEqual(await client.listWorkflowJobs(20, 2), [{ id: 50 }]);
    assert.ok(urls[0].includes(`head_sha=${'a'.repeat(40)}&per_page=100&page=1`));
    assert.ok(urls[1].includes('/actions/runs/20/attempts/2/jobs?per_page=100&page=1'));
});

test('truncated Actions counts and searches beyond the API cap fail closed', async () =>
{
    for (const total of [2, 1001])
    {
        const client = createDependencyBlockerGitHub({
            repository: 'example/test', token: 'simulation-token',
            fetchImpl: async () => Response.json({ total_count: total, workflow_runs: [{ id: 20 }] })
        });
        await assert.rejects(client.listWorkflowRuns('a'.repeat(40)), /incomplete_counted_snapshot/);
    }
});
