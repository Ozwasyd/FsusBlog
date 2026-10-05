import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const support = path.resolve(import.meta.dirname, '../../tools/test/lanes/_suite-support.sh');

function shell(script, args = [], env = {})
{
    return spawnSync('bash', ['-c', script, 'migration-lane-fixture', support, ...args], {
        encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024
    });
}

test('backend-unit calls the locked Release Migration builder and independent runner exactly once', () =>
{
    const result = shell([
        'source "$1"',
        'Run() { printf "CALL %s\\n" "$*"; }',
        'ConfigureDotnetTestProcessors() { printf "PROCESSORS\\n"; }',
        'WriteBackendSplitSummary() { printf "SUMMARY %s\\n" "$*"; }',
        'FSUSBLOG_TEST_SELECTION=affected',
        'RunBackendUnitLane'
    ].join('\n'), [], {
        CURRENT_TIER: 'backend-unit',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'b'.repeat(64),
        FSUSBLOG_TEST_RUN_ID: 'matrix-unit-fixture',
        FSUSBLOG_TEST_NAMESPACE: 'matrix-unit-fixture'
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = result.stdout.split('\n').filter((line) => line.startsWith('CALL '));
    const builds = calls.filter((line) => line.includes('/build-migration-tests.mjs'));
    const executions = calls.filter((line) => line.includes('/run-migration-tests.mjs'));
    assert.equal(builds.length, 1);
    assert.equal(executions.length, 1);
    assert.match(builds[0], /run-with-dotnet-release-build-lock\.sh .*build-with-data-env\.sh .*build-migration-tests\.mjs/u);
    assert.match(executions[0], /run-migration-tests\.mjs --backend-unit$/u);
    assert.doesNotMatch(result.stdout, /dotnet test.*Migration/u);
    assert.ok(result.stdout.indexOf(builds[0]) < result.stdout.indexOf('PROCESSORS'));
    assert.ok(result.stdout.indexOf('PROCESSORS') < result.stdout.indexOf(executions[0]));
    assert.ok(result.stdout.indexOf(executions[0]) < result.stdout.indexOf('SUMMARY backend-unit'));
});

test('backend-unit build failure does not proceed to Migration execution or success summary', () =>
{
    const result = shell([
        'source "$1"',
        'Run() { printf "CALL %s\\n" "$*"; if [[ "$*" == *build-migration-tests.mjs* ]]; then return 23; fi; }',
        'ConfigureDotnetTestProcessors() { printf "PROCESSORS\\n"; }',
        'WriteBackendSplitSummary() { printf "SUMMARY\\n"; }',
        'FSUSBLOG_TEST_SELECTION=affected',
        'RunBackendUnitLane'
    ].join('\n'), [], { CURRENT_TIER: 'backend-unit' });
    assert.equal(result.status, 23, result.stderr);
    assert.doesNotMatch(result.stdout, /run-migration-tests\.mjs|SUMMARY|PROCESSORS/u);
});

function summaryFixture(t, { failing = false } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-migration-summary-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'tools/test'), { recursive: true });
    // Only the shell-to-reader contract is simulated here; raw evidence and
    // negative bindings are exercised by migration-execution-evidence tests.
    fs.writeFileSync(path.join(root, 'tools/test/run-migration-tests.mjs'), [
        'export async function readMigrationExecution(options) {',
        '  if (options.producer !== "backend-unit" || options.runId !== "summary-run"',
        '    || options.namespace !== "summary-namespace"',
        '    || options.sourceState.commit !== "a".repeat(40)',
        '    || options.sourceState.worktreeFingerprint !== "b".repeat(64)) throw new Error("crossed summary identity");',
        ...(failing ? ['  throw new Error("controlled missing Migration receipt");'] : [
            '  return { receipt: { digest: "c".repeat(64) },',
            '    receiptFile: options.root + "/.tmp/test-runs/summary-run/migration-execution/receipt.json",',
            '    summary: { project: "tests/migration/FsusBlog.Migration.Tests.csproj",',
            '      sourceCaseIds: ["source-case"], executedCaseIds: ["runtime-case"] } };'
        ]),
        '}',
        'export const readMigrationExecutionDependency = readMigrationExecution;',
        ''
    ].join('\n'));
    const env = {
        FSUSBLOG_TEST_RUN_ID: 'summary-run', FSUSBLOG_TEST_NAMESPACE: 'summary-namespace',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40), FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'b'.repeat(64)
    };
    return { root, env };
}

test('backend-unit and backend-fast summaries consume the bound receipt without rerunning tests', (t) =>
{
    const { root, env } = summaryFixture(t);
    for (const lane of ['backend-unit', 'backend-fast'])
    {
        const result = shell([
            'source "$1"',
            'ROOT_DIR="$2"',
            'WriteBackendSplitSummary "$3" dependency-summary'
        ].join('\n'), [root, lane], { ...env, CURRENT_TIER: lane });
        assert.equal(result.status, 0, result.stderr);
        const summary = JSON.parse(fs.readFileSync(path.join(root, '.tmp', lane, 'summary.json')));
        assert.equal(summary.status, 'success');
        assert.deepEqual(summary.migrationExecution, {
            receiptFile: '.tmp/test-runs/summary-run/migration-execution/receipt.json',
            receiptDigest: 'c'.repeat(64),
            project: 'tests/migration/FsusBlog.Migration.Tests.csproj',
            sourceCaseIds: ['source-case'],
            executedCaseIds: ['runtime-case']
        });
    }
});

test('fast summary fails closed when its Migration receipt is missing or crosses scheduler identity', (t) =>
{
    for (const failing of [true, false])
    {
        const { root, env } = summaryFixture(t, { failing });
        const result = shell([
            'source "$1"',
            'ROOT_DIR="$2"',
            'WriteBackendSplitSummary backend-fast dependency-summary'
        ].join('\n'), [root], { ...env, ...(!failing ? { FSUSBLOG_TEST_NAMESPACE: 'foreign' } : {}) });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /controlled missing Migration receipt|crossed summary identity/u);
        assert.equal(fs.existsSync(path.join(root, '.tmp/backend-fast/summary.json')), false);
    }
});
