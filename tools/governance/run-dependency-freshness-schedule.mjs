import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDependencyBlockerGitHub, reconcileDependencyBlockers } from './dependency-blocker-github.mjs';
import { buildDependencyBlockerSnapshot } from './dependency-blocker-snapshot.mjs';
import { resultSchema } from './dependency-freshness.mjs';

export function admitScheduledRun(environment, defaultBranch)
{
    const repository = environment.GITHUB_REPOSITORY;
    if (environment.GITHUB_ACTIONS !== 'true' || !['schedule', 'workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME)
        || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')
        || environment.GITHUB_REF !== `refs/heads/${defaultBranch}`
        || environment.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/dependency-freshness.yml@refs/heads/${defaultBranch}`
        || !/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ID ?? '')
        || !/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ATTEMPT ?? ''))
    {
        throw new Error('dependency_freshness_schedule_unadmitted_run');
    }
    return repository;
}

export async function produceScheduledFreshness(root)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-scheduled-freshness-'));
    try
    {
        const output = path.join(directory, 'freshness.json');
        const exitCode = await new Promise((resolve, reject) => {
            const child = spawn('npm', ['--prefix', 'src/frontend', 'run', 'deps:freshness', '--', '--output', output], {
                cwd: root, stdio: ['ignore', 'inherit', 'inherit'],
                env: { ...process.env, FSUSBLOG_DEPS_FRESHNESS_FIXTURES: '' }
            });
            child.once('error', reject);
            child.once('close', (code, signal) => signal ? reject(new Error('dependency_freshness_producer_interrupted')) : resolve(code));
        });
        const report = JSON.parse(fs.readFileSync(output, 'utf8'));
        if (report.schema !== resultSchema || report.evidenceClass !== 'live-registry'
            || !['pass', 'fail'].includes(report.status) || exitCode !== (report.status === 'pass' ? 0 : 1))
        {
            throw new Error('dependency_freshness_producer_result_mismatch');
        }
        return report;
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

export async function runDependencyFreshnessSchedule({ root, client, withExclusiveRun, produceReport = produceScheduledFreshness })
{
    const read = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
    const catalog = read('config/dependencies/update-surface.json');
    const exceptions = read('config/dependencies/exceptions.json');
    const requiredChecks = read('config/dependencies/required-checks.json');
    let report;
    const result = await reconcileDependencyBlockers({
        client, withExclusiveRun,
        loadSnapshot: async () => {
            report = await produceReport(root);
            return buildDependencyBlockerSnapshot({ report, catalog, exceptions, requiredChecks, client });
        }
    });
    const exitCode = report.status === 'pass' && result.plan.issue.body === undefined ? 0 : 1;
    return { ...result, status: exitCode === 0 ? 'pass' : 'fail', exitCode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
{
    try
    {
        if (process.argv.length !== 2)
        {
            throw new Error('dependency_freshness_schedule_unknown_arguments');
        }
        const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
        const requiredChecks = JSON.parse(fs.readFileSync(path.join(root, 'config/dependencies/required-checks.json'), 'utf8'));
        const repository = admitScheduledRun(process.env, requiredChecks.defaultBranch);
        const client = createDependencyBlockerGitHub({ repository, token: process.env.GITHUB_TOKEN });
        // GitHub holds the fixed workflow concurrency group for the entire admitted run.
        const result = await runDependencyFreshnessSchedule({ root, client, withExclusiveRun: (work) => work() });
        process.stdout.write(`${JSON.stringify({ status: result.status, issueNumber: result.issueNumber, action: result.plan.issue.action, exitCode: result.exitCode })}\n`);
        process.exitCode = result.exitCode;
    }
    catch (error)
    {
        process.stderr.write(`[dependency-freshness-schedule] ${error.message}\n`);
        process.exitCode = 1;
    }
}
