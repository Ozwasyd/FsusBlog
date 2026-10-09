import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../../tools/security/zap-baseline-result-outlet.mjs', import.meta.url);
const { publishBaselineResult } = await import(moduleUrl);

async function createReports(context)
{
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zap-raw-outlet-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const reportPaths = ['report.json', 'report.html', 'report.md'].map((name) => path.join(directory, name));
    return { directory, reportPaths };
}

test('transports actual target and only present report paths without parsing contents', async (context) =>
{
    const { reportPaths } = await createReports(context);
    await writeFile(reportPaths[0], 'deliberately not vendor JSON');
    await writeFile(reportPaths[2], 'raw markdown');
    const target = 'https://example.invalid/a?b=1&c=two';
    const observed = [];
    const outcome = await publishBaselineResult({ target, scannerExitCode: 3, reportPaths }, async (result) =>
    {
        observed.push(result);
    });
    assert.deepEqual(observed, [{ target, scannerExitCode: 3, reportPaths: [reportPaths[0], reportPaths[2]], missingReportPaths: [reportPaths[1]] }]);
    assert.equal(outcome.exitCode, 3);
    assert.equal(outcome.outletError, null);
});

test('missing reports remain explicit for both success and WARN exit codes', async (context) =>
{
    const { reportPaths } = await createReports(context);
    for (const scannerExitCode of [0, 2])
    {
        const outcome = await publishBaselineResult({ target: 'http://example.invalid', scannerExitCode, reportPaths }, async () => {});
        assert.deepEqual(outcome.result.reportPaths, []);
        assert.deepEqual(outcome.result.missingReportPaths, reportPaths);
        assert.equal(outcome.result.scannerExitCode, scannerExitCode);
        assert.equal(outcome.exitCode, scannerExitCode);
    }
});

test('awaits the outlet before completing transport', async (context) =>
{
    const { reportPaths } = await createReports(context);
    let release;
    let started;
    const entered = new Promise((resolve) =>
    {
        started = resolve;
    });
    const pending = new Promise((resolve) =>
    {
        release = resolve;
    });
    let completed = false;
    const transport = publishBaselineResult({ target: 'http://example.invalid', scannerExitCode: 0, reportPaths }, async () =>
    {
        started();
        await pending;
    }).then((outcome) =>
    {
        completed = true;
        return outcome;
    });
    await entered;
    assert.equal(completed, false);
    release();
    assert.equal((await transport).outletError, null);
    assert.equal(completed, true);
});

test('retains callback errors and raw primary failure under the existing exit policy', async (context) =>
{
    const { reportPaths } = await createReports(context);
    const failure = new Error('synthetic outlet failure');
    for (const scannerExitCode of [0, 1, 2, 3, 125])
    {
        const input = { target: 'http://example.invalid', scannerExitCode, reportPaths };
        const clean = await publishBaselineResult(input, async () => {});
        const failed = await publishBaselineResult(input, async () =>
        {
            throw failure;
        });
        assert.equal(clean.exitCode, scannerExitCode);
        assert.equal([0, 2].includes(clean.exitCode) ? 0 : 1, [0, 2].includes(scannerExitCode) ? 0 : 1);
        assert.equal(failed.result.scannerExitCode, scannerExitCode);
        assert.equal(failed.outletError, failure);
        assert.equal(failed.outletExitCode, 1);
        assert.equal(failed.exitCode, [0, 2].includes(scannerExitCode) ? 1 : scannerExitCode);
        assert.equal([0, 2].includes(failed.exitCode) ? 0 : 1, 1);
    }
});

test('a callback throwing null still reports an outlet failure', async (context) =>
{
    const { reportPaths } = await createReports(context);
    const outcome = await publishBaselineResult({ target: 'http://example.invalid', scannerExitCode: 2, reportPaths }, async () =>
    {
        throw null;
    });
    assert.equal(outcome.outletExitCode, 1);
    assert.equal(outcome.outletError, null);
    assert.equal(outcome.result.scannerExitCode, 2);
    assert.equal(outcome.exitCode, 1);
});

test('separate colliding labels retain each actual target and observation', async (context) =>
{
    const { reportPaths } = await createReports(context);
    const observed = [];
    for (const [target, scannerExitCode] of [['http://example.invalid/a/b', 3], ['http://example.invalid/a-b', 2]])
    {
        const outcome = await publishBaselineResult({ target, scannerExitCode, reportPaths }, async (result) =>
        {
            observed.push(result);
        });
        assert.equal(outcome.exitCode, scannerExitCode);
    }
    assert.deepEqual(observed.map((result) => result.target), ['http://example.invalid/a/b', 'http://example.invalid/a-b']);
    assert.deepEqual(observed.map((result) => result.scannerExitCode), [3, 2]);
    assert.deepEqual(observed.map((result) => result.missingReportPaths), [reportPaths, reportPaths]);
});

test('CLI appends ordinary raw records and reports a write error', async (context) =>
{
    const { directory, reportPaths } = await createReports(context);
    await writeFile(reportPaths[0], '{}');
    const output = path.join(directory, 'results.jsonl');
    for (const scannerExitCode of [3, 2])
    {
        const child = spawnSync(process.execPath, [fileURLToPath(moduleUrl), output, 'http://example.invalid', String(scannerExitCode), ...reportPaths], { encoding: 'utf8' });
        assert.equal(child.status, 0, child.stderr);
    }
    const records = (await readFile(output, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.scannerExitCode), [3, 2]);
    assert.deepEqual(records[0].reportPaths, [reportPaths[0]]);
    assert.deepEqual(records[1].missingReportPaths, reportPaths.slice(1));
    const failed = spawnSync(process.execPath, [fileURLToPath(moduleUrl), directory, 'http://example.invalid', '3', ...reportPaths], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /zap-baseline-result-outlet/u);
});

test('rejects malformed transport arguments before invoking the outlet', async () =>
{
    let calls = 0;
    await assert.rejects(publishBaselineResult({ target: 'http://example.invalid', scannerExitCode: '2', reportPaths: [] }, async () =>
    {
        calls += 1;
    }), TypeError);
    assert.equal(calls, 0);
    const child = spawnSync(process.execPath, [fileURLToPath(moduleUrl)], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /usage:/u);
});

test('static shell dispatch retains scanner status, prerequisites and remaining-target loop', async () =>
{
    const source = await readFile(new URL('../../tools/security/run-zap-baseline.sh', import.meta.url), 'utf8');
    const dispatch = source.indexOf('docker run --rm');
    const capture = source.indexOf('status=$?', dispatch);
    const outlet = source.indexOf('if node "$ROOT_DIR/tools/security/zap-baseline-result-outlet.mjs"', capture);
    const policy = source.indexOf('case "$status" in', outlet);
    assert.ok(dispatch < capture && capture < outlet && outlet < policy);
    const transport = source.slice(outlet, policy);
    assert.match(transport, /"\$target" "\$status"/u);
    assert.match(transport, /outletStatus=\$\?[\s\S]*overall_status=1/u);
    assert.doesNotMatch(transport, /\bstatus=|\b(?:exit|break|return)\s+[0-9]/u);
    assert.match(source, /for target in \$TARGETS; do[\s\S]*case "\$status" in[\s\S]*0\)[\s\S]*2\)[\s\S]*\*\)[\s\S]*overall_status=1[\s\S]*done\s+exit "\$overall_status"/u);
    assert.match(source, /if ! command -v docker[\s\S]*exit 1\s+fi/u);
    assert.ok(source.indexOf('"$ROOT_DIR/tools/security/check-zap-warn-policy.mjs"') < dispatch);
    assert.doesNotMatch(source, /not-applicable|FSUSBLOG_SKIP_ZAP/u);
});
