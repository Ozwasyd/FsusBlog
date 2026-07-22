import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const sourceRoot = path.resolve(import.meta.dirname, '../..');

function makeFixtureRepository()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-issue-1151-flaky-'));
    for (const directory of ['tools/ci', 'tools/yaml', 'tests/tools/fixtures'])
    {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    for (const relative of [
        'tools/ci/run-flaky-governed.mjs',
        'tools/ci/check-flaky-evidence.mjs',
        'tools/yaml/parse-document.mjs',
        'tests/flaky.yml',
        'tests/tools/fixtures/issue-1151-flaky-command.mjs'
    ])
    {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.copyFileSync(path.join(sourceRoot, relative), path.join(root, relative));
    }
    return root;
}

function runFixture(root, suite, scenario)
{
    return spawnSync(process.execPath, [
        path.join(root, 'tools/ci/run-flaky-governed.mjs'),
        '--suite', suite,
        '--test-id', `${suite}:declared`,
        '--',
        process.execPath,
        path.join(root, 'tests/tools/fixtures/issue-1151-flaky-command.mjs'),
        scenario
    ], { cwd: root, encoding: 'utf8' });
}

function evidence(root, suite)
{
    return JSON.parse(fs.readFileSync(path.join(root, `.tmp/release-evidence/flaky/${suite}.json`), 'utf8'));
}

function check(root, releaseFinal = false)
{
    return spawnSync(process.execPath, [
        path.join(root, 'tools/ci/check-flaky-evidence.mjs'),
        ...(releaseFinal ? ['--release-final'] : [])
    ], { cwd: root, encoding: 'utf8' });
}

function withFixture(run)
{
    const root = makeFixtureRepository();
    try
    {
        run(root);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('Browser Contract never retries and reports a browser crash directly as infra-failure', () => withFixture((root) =>
{
    const result = runFixture(root, 'browser-contract', 'contract-crash');
    assert.equal(result.status, 1, result.stderr);
    const receipt = evidence(root, 'browser-contract');
    assert.equal(receipt.policyVersion, 'fsusblog-flaky-execution-v2');
    assert.equal(receipt.sourceEvidenceClass, 'browser-contract');
    assert.equal(receipt.evidenceClass, 'infra-failure');
    assert.equal(receipt.failureClass, 'infra');
    assert.equal(receipt.failureKind, 'browser-process-crash');
    assert.equal(receipt.retryCount, 0);
    assert.equal(receipt.finalStatus, 'failed-no-retry');
    assert.equal(receipt.attempts.length, 1);
    assert.deepEqual(receipt.retryPolicy, { allowedRetries: 0, retryOn: 'never' });
    assert.doesNotMatch(JSON.stringify(receipt), /passed-after-retry/u);
    const validation = check(root, true);
    assert.equal(validation.status, 1);
    assert.match(validation.stderr, /release-final rejects failing browser-contract evidence/u);
}));

test('diagnostics retry exactly one explicit browser process crash and retain both attempts', () => withFixture((root) =>
{
    const result = runFixture(root, 'visual-playwright', 'diagnostic-crash-then-pass');
    assert.equal(result.status, 0, result.stderr);
    const receipt = evidence(root, 'visual-playwright');
    assert.equal(receipt.evidenceClass, 'diagnostic');
    assert.equal(receipt.sourceEvidenceClass, 'diagnostic');
    assert.equal(receipt.affectsCorrectness, false);
    assert.equal(receipt.retryCount, 1);
    assert.equal(receipt.finalStatus, 'diagnostic-passed-after-infra-retry');
    assert.equal(receipt.attempts.length, 2);
    assert.deepEqual(receipt.attempts.map((attempt) => attempt.status), ['failure', 'success']);
    assert.equal(receipt.attempts[0].failureClass, 'infra');
    assert.equal(receipt.attempts[0].failureKind, 'browser-process-crash');
    for (const attempt of receipt.attempts)
    {
        assert.deepEqual(attempt.testIds, ['visual:home']);
        assert.ok(attempt.artifacts.length >= 3);
    }
    assert.equal(check(root, true).status, 0);
}));

test('structured crash metadata is accepted without heuristic error matching', () => withFixture((root) =>
{
    const result = runFixture(root, 'browser-diagnostics', 'structured-crash-then-pass');
    assert.equal(result.status, 0, result.stderr);
    const receipt = evidence(root, 'browser-diagnostics');
    assert.equal(receipt.finalStatus, 'diagnostic-passed-after-infra-retry');
    assert.equal(receipt.attempts[0].failureClass, 'infra');
    assert.equal(receipt.attempts[0].failureKind, 'browser-process-crash');
}));

test('assertion mismatch and browser disconnect are not crash-retryable', () => withFixture((root) =>
{
    for (const [scenario, expectedClass, expectedKind] of [
        ['diagnostic-assertion', 'diagnostic', 'visual-mismatch'],
        ['diagnostic-disconnect', 'infra-failure', 'browser-disconnect']
    ])
    {
        const result = runFixture(root, 'visual-playwright', scenario);
        assert.equal(result.status, 1, result.stderr);
        const receipt = evidence(root, 'visual-playwright');
        assert.equal(receipt.evidenceClass, expectedClass);
        assert.equal(receipt.failureKind, expectedKind);
        assert.equal(receipt.retryCount, 0);
        assert.equal(receipt.attempts.length, 1);
        assert.equal(receipt.finalStatus, 'failed-no-retry');
    }
}));

test('different failing tests across diagnostic attempts are marked unstable-topology', () => withFixture((root) =>
{
    const result = runFixture(root, 'cross-browser-smoke', 'unstable-topology');
    assert.equal(result.status, 1, result.stderr);
    const receipt = evidence(root, 'cross-browser-smoke');
    assert.equal(receipt.retryCount, 1);
    assert.equal(receipt.finalStatus, 'unstable-topology');
    assert.equal(receipt.failureClass, 'unstable-topology');
    assert.deepEqual(receipt.attempts.map((attempt) => attempt.testIds), [['visual:first'], ['visual:second']]);
    assert.equal(check(root).status, 0);
}));

test('correctness has no generic retry and legacy passed-after-retry evidence is rejected', () => withFixture((root) =>
{
    const result = runFixture(root, 'unit-correctness', 'diagnostic-assertion');
    assert.equal(result.status, 1, result.stderr);
    const receipt = evidence(root, 'unit-correctness');
    assert.equal(receipt.sourceEvidenceClass, 'correctness');
    assert.equal(receipt.retryCount, 0);
    assert.equal(receipt.attempts.length, 1);

    fs.writeFileSync(path.join(root, '.tmp/release-evidence/flaky/legacy.json'), `${JSON.stringify({
        schema: 'fsusblog.ci.flaky.v1',
        suite: 'acceptance-playwright',
        classification: 'unknown-flaky',
        evidenceClass: 'correctness',
        affectsCorrectness: true,
        issue: 134,
        retryCount: 1,
        finalStatus: 'passed-after-retry',
        generatedAt: '2025-01-01T00:00:00.000Z'
    })}\n`);
    const validation = check(root);
    assert.equal(validation.status, 1);
    assert.match(validation.stderr, /legacy generic retry evidence is forbidden/u);
}));
