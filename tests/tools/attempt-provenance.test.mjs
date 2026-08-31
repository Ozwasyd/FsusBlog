import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    digestCanonical,
    validateAggregateAttemptReceipt
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test/attempt-provenance.mjs';
import {
    runProducerAttempts,
    validateDockerEquivalentAttemptReceipt
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test/attempt-runner.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const commandFixture = path.join(root, 'tests/tools/fixtures/attempt-runner-command.mjs');
const commit = '1'.repeat(40);
const fingerprint = `sha256:${'2'.repeat(64)}`;

function authorityReferences()
{
    return [
        ['execution-envelope', '3'],
        ['replay-plan', '4'],
        ['temporal-context', '5']
    ].map(([kind, digit]) => ({
        kind,
        artifactPath: `${kind}.json`,
        artifactDigest: `sha256:${digit.repeat(64)}`,
        verificationReceiptPath: `${kind}.verification.json`,
        verificationReceiptDigest: `sha256:${digit.repeat(64)}`
    }));
}

function verifyAuthorityFor(producerId, schedulerRunId)
{
    return (reference) => ({
        verified: true,
        authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: {
            sourceCommit: commit,
            worktreeFingerprint: fingerprint,
            schedulerRunId,
            producerId
        }
    });
}

function options(directory, scenario, overrides = {})
{
    const producerId = overrides.producerId ?? 'unit-correctness';
    const schedulerRunId = overrides.schedulerRunId ?? `run-${scenario}`;
    return {
        evidenceRoot: directory,
        producerId,
        retryPolicyId: overrides.retryPolicyId ?? 'correctness-first-attempt',
        sourceCommit: commit,
        worktreeFingerprint: fingerprint,
        schedulerRunId,
        command: overrides.command ?? [process.execPath, commandFixture, scenario],
        cwd: root,
        env: { PATH: process.env.PATH },
        authorityReferences: authorityReferences(),
        verifyAuthority: overrides.verifyAuthority ?? verifyAuthorityFor(producerId, schedulerRunId),
        expectedTestIds: ['fixture:attempt-runner'],
        timeoutMs: overrides.timeoutMs ?? 5_000,
        signal: overrides.signal ?? null
    };
}

async function withEvidence(run)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-attempt-runner-'));
    try
    {
        await run(directory);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('first-attempt correctness success is content addressed and qualified', async () => withEvidence(async (directory) =>
{
    const result = await runProducerAttempts(options(directory, 'success'));
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].status, 'clean-success');
    assert.equal(result.aggregate.cleanFirstAttempt, true);
    assert.equal(result.aggregate.qualificationEligible, true);
    for (const relative of ['attempt-1/stdout.log', 'attempt-1/stderr.log', 'attempt-1/payload.json'])
    {
        const file = path.join(result.producerRoot, relative);
        assert.ok(fs.existsSync(file));
        assert.equal(fs.statSync(file).mode & 0o222, 0);
    }
}));

test('correctness product failure never spawns a second attempt', async () => withEvidence(async (directory) =>
{
    const result = await runProducerAttempts(options(directory, 'product-failure'));
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].status, 'failed-no-retry');
    assert.equal(result.attempts[0].retryDecision, 'policy-denied');
    assert.equal(result.attempts[0].firstFailure, true);
    assert.equal(result.aggregate.qualificationEligible, false);
    assert.equal(fs.existsSync(path.join(result.producerRoot, 'attempt-2')), false);
}));

test('diagnostic exact browser crash may recover once without becoming clean qualification', async () => withEvidence(async (directory) =>
{
    const result = await runProducerAttempts(options(directory, 'browser-crash-once', {
        producerId: 'browser-diagnostics',
        schedulerRunId: 'run-browser-diagnostics',
        retryPolicyId: 'diagnostic-browser-process-crash'
    }));
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].failureKind, 'browser-process-crash');
    assert.equal(result.attempts[0].retryDecision, 'policy-authorized');
    assert.equal(result.attempts[1].status, 'clean-success');
    assert.equal(result.aggregate.finalClassification, 'diagnostic-recovered-after-allowed-infra-retry');
    assert.equal(result.aggregate.cleanFirstAttempt, false);
    assert.equal(result.aggregate.qualificationEligible, false);
}));

test('restore recovery is recovered-infra and never clean qualification', async () => withEvidence(async (directory) =>
{
    const result = await runProducerAttempts(options(directory, 'restore-timeout-once', {
        producerId: 'dependency-restore',
        schedulerRunId: 'run-dependency-restore',
        retryPolicyId: 'dependency-transfer-observed-recovery'
    }));
    assert.equal(result.attempts.length, 2);
    assert.equal(result.aggregate.finalClassification, 'recovered-infra-success');
    assert.equal(result.aggregate.qualificationEligible, false);
}));

test('product failure is not retryable under diagnostic policy', async () => withEvidence(async (directory) =>
{
    const result = await runProducerAttempts(options(directory, 'product-failure', {
        producerId: 'browser-diagnostics',
        schedulerRunId: 'run-diagnostic-product',
        retryPolicyId: 'diagnostic-browser-process-crash'
    }));
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].retryDecision, 'policy-denied');
}));

test('spawn, signal, timeout, cancellation and artifact failures produce terminal receipts', async () => withEvidence(async (directory) =>
{
    const abort = new AbortController();
    abort.abort(new Error('cancelled'));
    const cases = [
        ['spawn', { command: ['/definitely/missing/fsusblog-command'] }, 'command-spawn-error'],
        ['signal', {}, 'command-signal'],
        ['timeout', { timeoutMs: 20 }, 'runner-timeout'],
        ['cancel', { signal: abort.signal }, 'runner-cancelled'],
        ['missing-artifact', {}, 'artifact-collection-failure']
    ];
    for (const [scenario, overrides, failureKind] of cases)
    {
        const result = await runProducerAttempts(options(directory, scenario, {
            ...overrides,
            schedulerRunId: `run-terminal-${scenario}`
        }));
        assert.equal(result.attempts.length, 1);
        assert.equal(result.attempts[0].failureKind, failureKind, scenario);
        assert.equal(result.aggregate.qualificationEligible, false);
    }
}));

test('authority identity, run-owned overlap and receipt tamper fail closed before qualification', async () => withEvidence(async (directory) =>
{
    const invalid = options(directory, 'success', {
        verifyAuthority: (reference) => ({
            verified: true,
            authorityDigest: reference.artifactDigest,
            verificationReceiptDigest: reference.verificationReceiptDigest,
            identity: {
                sourceCommit: commit,
                worktreeFingerprint: fingerprint,
                schedulerRunId: 'other-run',
                producerId: 'unit-correctness'
            }
        })
    });
    await assert.rejects(() => runProducerAttempts(invalid), /crosses schedulerRunId/u);
    const valid = options(directory, 'success');
    await runProducerAttempts(valid);
    await assert.rejects(() => runProducerAttempts(valid), /EEXIST/u);
}));

test('Docker equivalent evidence rejects log-only self-authored JSON', () =>
{
    const receipt = {
        schema: 'fsusblog.test-attempt-receipt.v1',
        producerId: 'container-build',
        command: ['echo', 'json-only'],
        exitCode: 0,
        artifactPaths: [],
        stdoutPath: 'stdout.log',
        stderrPath: 'stderr.log'
    };
    assert.throws(
        () => validateDockerEquivalentAttemptReceipt(receipt),
        /contract-invalid|unknown fields|Docker equivalent|external authority/u
    );
});

test('aggregate tamper and missing first attempt are rejected', async () => withEvidence(async (directory) =>
{
    const result = await runProducerAttempts(options(directory, 'success'));
    const tampered = JSON.parse(JSON.stringify(result.aggregate));
    tampered.attempts[0].attemptNumber = 2;
    const unsigned = { ...tampered };
    delete unsigned.contentDigest;
    tampered.contentDigest = digestCanonical(unsigned);
    assert.throws(() => validateAggregateAttemptReceipt(tampered, {
        loadAttempt: () => result.attempts[0],
        verifyAuthority: verifyAuthorityFor('unit-correctness', 'run-success')
    }), /ordered from one/u);
}));
