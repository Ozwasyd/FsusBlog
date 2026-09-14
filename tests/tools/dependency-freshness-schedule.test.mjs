import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { admitScheduledRun, produceScheduledFreshness, runDependencyFreshnessSchedule } = await import(new URL('../../tools/governance/run-dependency-freshness-schedule.mjs', import.meta.url));
const { resultSchema } = await import(new URL('../../tools/governance/dependency-freshness.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const environment = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'example/test', GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/master',
    GITHUB_WORKFLOW_REF: 'example/test/.github/workflows/dependency-freshness.yml@refs/heads/master', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1'
};

test('schedule and manual dispatch are admitted only on the exact default-branch workflow', () =>
{
    assert.equal(admitScheduledRun(environment, 'master'), 'example/test');
    assert.equal(admitScheduledRun({ ...environment, GITHUB_EVENT_NAME: 'workflow_dispatch' }, 'master'), 'example/test');
    for (const override of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_WORKFLOW_REF: 'example/test/.github/workflows/other.yml@refs/heads/master' }])
    {
        assert.throws(() => admitScheduledRun({ ...environment, ...override }, 'master'), /unadmitted_run/);
    }
});

test('workflow fixes six-hour cadence, shared serialization and least-privilege write surfaces', () =>
{
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/dependency-freshness.yml'), 'utf8');
    assert.match(workflow, /cron: '0 \*\/6 \* \* \*'/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /group: dependency-freshness-blockers\n {4}cancel-in-progress: false/);
    assert.match(workflow, /contents: read/);
    assert.match(workflow, /issues: write/);
    assert.match(workflow, /pull-requests: read/);
    assert.doesNotMatch(workflow, /continue-on-error|contents: write|pull_request:|pull_request_target:/);
    assert.match(workflow, /run: node tools\/governance\/run-dependency-freshness-schedule.mjs/);
});

test('scheduled consumer preserves failure across create and idempotent update, then closes on recovery', async () =>
{
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/dependencies/update-surface.json'), 'utf8'));
    const report = {
        schema: resultSchema, status: 'fail', now: '2026-09-05T00:00:00Z', pullRequests: [],
        errors: [{ code: 'behind-over-24h', detail: catalog.items[0].id }],
        results: catalog.items.map((item, index) => ({ dependencyId: item.id, currentVersion: '1', latestStable: index === 0 ? '2' : '1', state: index === 0 ? 'uncovered' : 'current' }))
    };
    const issues = [];
    const actions = [];
    const client = {
        listIssues: async () => structuredClone(issues),
        applyLabel: async () =>
        {
            throw new Error('unexpected PR label');
        },
        applyIssue: async (plan) =>
        {
            actions.push(plan.action);
            if (plan.action === 'create')
            {
                issues.push({ number: 1, title: plan.title, body: plan.body, state: 'open' });
            }
            if (plan.action === 'close')
            {
                issues[0].state = 'closed';
            }
            return issues[0];
        }
    };
    const run = () => runDependencyFreshnessSchedule({ root, client, withExclusiveRun: (work) => work(), produceReport: async () => structuredClone(report) });
    assert.equal((await run()).exitCode, 1);
    assert.equal((await run()).exitCode, 1);
    report.status = 'pass';
    report.errors = [];
    report.results[0].state = 'current';
    report.results[0].latestStable = '1';
    assert.equal((await run()).exitCode, 0);
    assert.deepEqual(actions, ['create', 'none', 'close']);
});

test('scheduled producer failure preserves an existing issue without any mutation', async () =>
{
    const mutations = [];
    const client = {
        listIssues: async () => [{ number: 1, title: 'Dependency freshness blockers', state: 'open', body: 'Existing diagnostics' }],
        applyLabel: async (plan) => mutations.push(plan),
        applyIssue: async (plan) => mutations.push(plan)
    };
    await assert.rejects(runDependencyFreshnessSchedule({
        root, client, withExclusiveRun: (work) => work(),
        produceReport: async () =>
        {
            throw new Error('registry unavailable');
        }
    }), /registry unavailable/);
    assert.deepEqual(mutations, []);
});

test('real npm subprocess boundary accepts matching results and rejects simulation or exit-code drift', async () =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-freshness-producer-test-'));
    const frontend = path.join(fixtureRoot, 'src/frontend');
    fs.mkdirSync(frontend, { recursive: true });
    fs.writeFileSync(path.join(frontend, 'package.json'), JSON.stringify({
        private: true, scripts: { 'deps:freshness': 'node producer.mjs' }
    }));
    try
    {
        // Controlled child output tests transport admission, not real registry correctness.
        for (const [status, evidenceClass, exitCode, accepted] of [
            ['pass', 'live-registry', 0, true],
            ['fail', 'live-registry', 1, true],
            ['pass', 'local-controlled-simulation', 0, false],
            ['fail', 'live-registry', 0, false]
        ])
        {
            const report = { schema: resultSchema, status, evidenceClass };
            fs.writeFileSync(path.join(frontend, 'producer.mjs'), [
                "import fs from 'node:fs';",
                "const output = process.argv[process.argv.indexOf('--output') + 1];",
                "if (process.env.FSUSBLOG_DEPS_FRESHNESS_FIXTURES) throw new Error('fixture override leaked');",
                `fs.writeFileSync(output, ${JSON.stringify(JSON.stringify(report))});`,
                `process.exitCode = ${exitCode};`
            ].join('\n'));
            if (accepted)
            {
                assert.deepEqual(await produceScheduledFreshness(fixtureRoot), report);
            }
            else
            {
                await assert.rejects(produceScheduledFreshness(fixtureRoot), /producer_result_mismatch/);
            }
        }
    }
    finally
    {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});
