import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const selftest = path.join(root, 'tools/security/test-production-exposure-tools.sh');
const source = fs.readFileSync(selftest, 'utf8');

function runHarness(body, env = {})
{
    return spawnSync('bash', ['-c', [
        'export FSUSBLOG_PRODUCTION_EXPOSURE_SELFTEST_SOURCE_ONLY=1',
        `source ${selftest}`,
        body
    ].join('\n')], {
        cwd: root,
        env: { ...process.env, ...env },
        encoding: 'utf8'
    });
}

test('production exposure self-test rolls every job within the dynamic STEP grant', () =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-exposure-parallel-'));
    const markers = path.join(temp, 'markers.txt');
    const result = runHarness(`
    worker() {
      local id="$1" delay="$2"
      printf '%s:start:%s:%s\n' "$id" "$FSUSBLOG_STEP_CPU_BUDGET" "$FSUSBLOG_STEP_MEMORY_GIB" >> "${markers}"
      sleep "$delay"
      printf '%s:end:%s:%s\n' "$id" "$FSUSBLOG_STEP_CPU_BUDGET" "$FSUSBLOG_STEP_MEMORY_GIB" >> "${markers}"
    }
    job_a() { worker a 0.10; }
    job_b() { worker b 0.35; }
    job_c() { worker c 0.10; }
    RunParallelFunctions fixture-roll job_a job_b job_c
  `, {
        FSUSBLOG_STEP_CPU_BUDGET: '2',
        FSUSBLOG_STEP_MEMORY_GIB: String(os.totalmem() / 1024 ** 3)
    });

    assert.equal(result.status, 0, result.stderr);
    const events = fs.readFileSync(markers, 'utf8').trim().split('\n').map((line) =>
    {
        const [id, event, cpu, memory] = line.split(':');
        return { id, event, cpu: Number(cpu), memory: Number(memory) };
    });
    let active = 0;
    let maximum = 0;
    for (const event of events)
    {
        active += event.event === 'start' ? 1 : -1;
        maximum = Math.max(maximum, active);
    }
    assert.equal(maximum, 2);
    assert.equal(events.filter(({ event }) => event === 'end').length, 3);
    assert.ok(events.every(({ cpu }) => cpu === 1));
    assert.ok(events.every(({ memory }) => memory > 0));
    assert.ok(events.findIndex(({ id, event }) => id === 'c' && event === 'start') < events.findIndex(({ id, event }) => id === 'b' && event === 'end'));
    fs.rmSync(temp, { recursive: true, force: true });
});

test('production exposure self-test consumes the current run-bound scheduler grant for each wave', () =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-exposure-live-grant-'));
    const markers = path.join(temp, 'markers.txt');
    const grantFile = path.join(temp, 'grants.json');
    fs.writeFileSync(grantFile, JSON.stringify({
        schema: 'fsusblog.test-matrix.resource-grants.v1',
        runId: 'exposure-live',
        resourceBudget: { cpuUnits: 8, memoryGiB: 8 },
        grants: { runtime: { cpuUnits: 2, memoryGiB: 1 } }
    }));
    const result = runHarness(`
    worker() {
      local id="$1"
      printf '%s:start:%s:%s\n' "$id" "$FSUSBLOG_STEP_CPU_BUDGET" "$FSUSBLOG_STEP_MEMORY_GIB" >> "${markers}"
      sleep 0.20
      printf '%s:end:%s:%s\n' "$id" "$FSUSBLOG_STEP_CPU_BUDGET" "$FSUSBLOG_STEP_MEMORY_GIB" >> "${markers}"
    }
    live_a() { worker a; }
    live_b() { worker b; }
    live_c() { worker c; }
    RunParallelFunctions fixture-live-grant live_a live_b live_c
  `, {
        FSUSBLOG_TEST_RUN_ID: 'exposure-live',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: grantFile,
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'runtime',
        FSUSBLOG_STEP_CPU_BUDGET: '1',
        FSUSBLOG_STEP_MEMORY_GIB: '1'
    });

    assert.equal(result.status, 0, result.stderr);
    const events = fs.readFileSync(markers, 'utf8').trim().split('\n').map((line) =>
    {
        const [id, event, cpu, memory] = line.split(':');
        return { id, event, cpu: Number(cpu), memory: Number(memory) };
    });
    let active = 0;
    let maximum = 0;
    for (const event of events)
    {
        active += event.event === 'start' ? 1 : -1;
        maximum = Math.max(maximum, active);
    }
    assert.equal(maximum, 2);
    assert.ok(events.every(({ cpu }) => cpu === 1));
    assert.ok(events.every(({ memory }) => memory === 0.5));
    assert.equal(events.filter(({ event }) => event === 'end').length, 3);
    fs.rmSync(temp, { recursive: true, force: true });
});

test('production exposure self-test rejects a scheduler grant from another run', () =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-exposure-stale-grant-'));
    const grantFile = path.join(temp, 'grants.json');
    fs.writeFileSync(grantFile, JSON.stringify({
        schema: 'fsusblog.test-matrix.resource-grants.v1',
        runId: 'stale-run',
        resourceBudget: { cpuUnits: 8, memoryGiB: 8 },
        grants: { runtime: { cpuUnits: 2, memoryGiB: 1 } }
    }));
    const result = runHarness('ResolveParallelWorkers 3', {
        FSUSBLOG_TEST_RUN_ID: 'current-run',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: grantFile,
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'runtime',
        FSUSBLOG_STEP_CPU_BUDGET: '1',
        FSUSBLOG_STEP_MEMORY_GIB: '1'
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scheduler resource grant runId mismatch/u);
    fs.rmSync(temp, { recursive: true, force: true });
});

test('production exposure self-test reports all parallel failures after running every job', () =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-exposure-failures-'));
    const marker = path.join(temp, 'success.txt');
    const result = runHarness(`
    failed_a() { printf 'failure-a\n' >&2; return 2; }
    succeeded() { printf 'success-ran\n' > "${marker}"; }
    failed_b() { printf 'failure-b\n' >&2; return 3; }
    RunParallelFunctions fixture-failures failed_a succeeded failed_b
  `, {
        FSUSBLOG_STEP_CPU_BUDGET: '3',
        FSUSBLOG_STEP_MEMORY_GIB: String(os.totalmem() / 1024 ** 3)
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /parallel failure: failed_a[\s\S]*failure-a/u);
    assert.match(result.stderr, /parallel failure: failed_b[\s\S]*failure-b/u);
    assert.match(result.stderr, /completed with 2 failed validation group\(s\)/u);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'success-ran');
    fs.rmSync(temp, { recursive: true, force: true });
});

test('production exposure self-test bounds a stuck pool and reports every active group', () =>
{
    const started = Date.now();
    const result = runHarness(`
    stuck_a() { sleep 30; }
    stuck_b() { sleep 30; }
    RunParallelFunctions fixture-timeout stuck_a stuck_b
  `, {
        FSUSBLOG_STEP_CPU_BUDGET: '2',
        FSUSBLOG_STEP_MEMORY_GIB: String(os.totalmem() / 1024 ** 3),
        FSUSBLOG_PRODUCTION_EXPOSURE_SELFTEST_WAIT_TIMEOUT_SECONDS: '1'
    });

    assert.notEqual(result.status, 0);
    assert.ok(Date.now() - started < 5000, `timeout harness took ${Date.now() - started}ms`);
    assert.match(result.stderr, /parallel failure: stuck_a[\s\S]*timed out waiting for stuck_a/u);
    assert.match(result.stderr, /parallel failure: stuck_b[\s\S]*timed out waiting for stuck_b/u);
});

test('production exposure self-test converts the inherited relative STEP deadline to a bounded wait', () =>
{
    const started = Date.now();
    const result = runHarness(`
    stuck_deadline() { sleep 30; }
    RunParallelFunctions fixture-relative-deadline stuck_deadline
  `, {
        FSUSBLOG_STEP_CPU_BUDGET: '1',
        FSUSBLOG_STEP_MEMORY_GIB: String(os.totalmem() / 1024 ** 3),
        FSUSBLOG_STEP_DEADLINE_MS: '100',
        FSUSBLOG_PRODUCTION_EXPOSURE_SELFTEST_WAIT_TIMEOUT_SECONDS: '30'
    });

    assert.notEqual(result.status, 0);
    assert.ok(Date.now() - started < 3000, `relative deadline harness took ${Date.now() - started}ms`);
    assert.match(result.stderr, /timed out waiting for stuck_deadline/u);
});

test('production exposure self-test keeps dependent archive checks in isolated groups', () =>
{
    assert.match(source, /parallel_log_root="\$\(mktemp -d\)"/u);
    assert.match(source, /logDir="\$parallel_log_root\/\$phase"/u);
    assert.match(source, /mkfifo "\$completionFifo"[\s\S]*?read -r -t "\$waitTimeoutSeconds" -u "\$completionFd" finishedPid rc/u);
    assert.match(source, /phaseStartedMs="\$\(date \+%s%3N\)"[\s\S]*?FSUSBLOG_STEP_DEADLINE_MS:-\$\{FSUSBLOG_BUNDLE_DEADLINE_MS/u);
    assert.match(source, /FSUSBLOG_STEP_CPU_BUDGET="\$childCpu"/u);
    assert.match(source, /FSUSBLOG_STEP_MEMORY_GIB="\$childMemory"/u);
    assert.match(source, /fsusblog\.test-matrix\.resource-grants\.v1/u);
    assert.match(source, /FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE/u);
    assert.match(source, /FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID/u);
    const pool = source.slice(source.indexOf('RunParallelFunctions closeout-and-handoff'));
    for (const group of [
        'TestHandoffBundleSecurity',
        'TestReturnedEvidenceRejections',
        'TestReturnedHandoffSuccess',
        'TestReturnedHandoffArchiveSafety',
        'TestReturnedContractDrift',
        'TestReturnedStatusAndComplete',
        'TestHandoffManifestDrift',
        'TestCompleteCloseoutFlows'
    ])
    {
        assert.ok(pool.includes(group), `missing parallel validation group ${group}`);
    }

    const archiveSafety = source.slice(
        source.indexOf('TestReturnedHandoffArchiveSafety()'),
        source.indexOf('TestReturnedContractDrift()')
    );
    assert.match(archiveSafety, /returned-handoff-blocked\.tar\.gz/u);
    assert.match(archiveSafety, /returned-handoff-symlink\.tar\.gz/u);
    assert.match(archiveSafety, /returned-handoff-path-traversal\.tar\.gz/u);
    assert.match(source, /returned_complete_ok_dir="\$tmp_dir\/returned-complete-ok"[\s\S]*?cp -a "\$returned_ok_dir" "\$returned_complete_ok_dir"/u);

    const sharedBaselineRegion = source.slice(
        source.indexOf('TestReturnedEvidenceRejections()'),
        source.indexOf('RunParallelFunctions closeout-and-handoff')
    );
    assert.doesNotMatch(sharedBaselineRegion, />\s*"\$complete_failed_status"/u);
    assert.doesNotMatch(sharedBaselineRegion, />\s*"\$complete_failed_manifest"/u);
    assert.doesNotMatch(sharedBaselineRegion, />\s*"\$returned_ok_dir/u);
    assert.doesNotMatch(sharedBaselineRegion, /"\$RETURNED_COMPLETE_SCRIPT" "\$returned_ok_dir"/u);
});
