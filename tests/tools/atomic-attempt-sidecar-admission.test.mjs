import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

const { runProducerAttempts } = await import(new URL('../../tools/test/attempt-runner.mjs', import.meta.url));

const root = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(root, 'tests/tools/fixtures/attempt-runner-command.mjs');

// Synthetic authority verification for ordinary task-owned processes only.
function options(directory, command, expectedTestIds)
{
    const identity = {
        producerId: 'ordinary-sidecar-contract',
        schedulerRunId: 'ordinary-sidecar-run',
        sourceCommit: '1'.repeat(40),
        worktreeFingerprint: `sha256:${'2'.repeat(64)}`
    };
    const authorityReferences = [
        ['execution-envelope', '3'],
        ['replay-plan', '4'],
        ['temporal-context', '5']
    ].map(([kind, digit]) => ({
        kind,
        artifactPath: `${kind}.json`,
        artifactDigest: `sha256:${digit.repeat(64)}`,
        verificationReceiptPath: `${kind}.verification.json`,
        verificationReceiptDigest: `sha256:${'6'.repeat(64)}`
    }));
    return {
        ...identity,
        evidenceRoot: directory,
        retryPolicyId: 'correctness-first-attempt',
        command,
        cwd: root,
        env: { PATH: process.env.PATH },
        timeoutMs: 5000,
        expectedTestIds,
        authorityReferences,
        verifyAuthority: (reference) => ({
            verified: true,
            authorityDigest: reference.artifactDigest,
            verificationReceiptDigest: reference.verificationReceiptDigest,
            identity
        })
    };
}

async function withEvidence(run)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-sidecar-contract-'));
    try
    {
        await run(directory);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('process-only success without declared test IDs needs no sidecar and observes no native IDs', async () => withEvidence(async (directory) =>
{
    const result = await runProducerAttempts(options(directory,
        [process.execPath, '-e', "console.log('ordinary process completed')"], []));
    const receipt = result.attempts[0];
    assert.equal(result.attempts.length, 1);
    assert.equal(receipt.maxAttempts, 1);
    assert.equal(receipt.status, 'clean-success');
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.failureKind, null);
    assert.deepEqual(receipt.executedTestIds, []);
    assert.deepEqual(receipt.failedTestIds, []);
    assert.deepEqual(receipt.artifactPaths, ['stderr.log', 'stdout.log']);
    assert.equal(fs.existsSync(path.join(result.producerRoot, 'attempt-1', 'result.json')), false);
}));

test('declared test membership still requires a real sidecar and never becomes observed IDs on absence', async () => withEvidence(async (directory) =>
{
    const result = await runProducerAttempts(options(directory,
        [process.execPath, '-e', "console.log('ordinary process completed')"], ['fixture:attempt-runner']));
    const receipt = result.attempts[0];
    assert.equal(result.attempts.length, 1);
    assert.equal(receipt.status, 'failed-no-retry');
    assert.equal(receipt.failureKind, 'invalid-success-result-sidecar');
    assert.deepEqual(receipt.executedTestIds, []);
    assert.equal(result.aggregate.cleanFirstAttempt, false);
    assert.equal(fs.existsSync(path.join(result.producerRoot, 'attempt-2')), false);
}));

test('normal declared membership with a real sidecar preserves actual result IDs and first-attempt success', async () => withEvidence(async (directory) =>
{
    const result = await runProducerAttempts(options(directory,
        [process.execPath, fixture, 'success'], ['fixture:attempt-runner']));
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].status, 'clean-success');
    assert.deepEqual(result.attempts[0].executedTestIds, ['fixture:attempt-runner']);
    assert.ok(result.attempts[0].artifactPaths.includes('result.json'));
    assert.ok(result.attempts[0].artifactPaths.includes('payload.json'));
}));

test('ordinary command failure remains primary without a sidecar or invented executed membership', async () => withEvidence(async (directory) =>
{
    const result = await runProducerAttempts(options(directory,
        [process.execPath, '-e', "console.error('ordinary command failed'); process.exitCode = 23"], ['fixture:attempt-runner']));
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].exitCode, 23);
    assert.equal(result.attempts[0].failureClass, 'product');
    assert.equal(result.attempts[0].failureKind, 'command-exit-nonzero');
    assert.deepEqual(result.attempts[0].executedTestIds, []);
    assert.equal(result.attempts[0].retryDecision, 'policy-denied');
}));
