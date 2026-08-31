import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    aggregateAttemptReceiptSchema,
    attemptReceiptSchema,
    canonicalJson,
    digestCanonical,
    readRetryPolicyRegistry,
    sealContentDigest,
    validateAggregateAttemptReceipt,
    validateAttemptReceipt,
    validateRetryPolicyRegistry
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test/attempt-provenance.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const commit = 'a'.repeat(40);
const fingerprint = `sha256:${'b'.repeat(64)}`;

function clone(value)
{
    return JSON.parse(JSON.stringify(value));
}

function authorityReferences()
{
    return [
        ['execution-envelope', 'c'],
        ['replay-plan', 'd'],
        ['temporal-context', 'e']
    ].map(([kind, digit]) => ({
        kind,
        artifactPath: `authorities/${kind}.json`,
        artifactDigest: `sha256:${digit.repeat(64)}`,
        verificationReceiptPath: `authorities/${kind}.verification.json`,
        verificationReceiptDigest: `sha256:${digit.toUpperCase().toLowerCase().repeat(64)}`
    }));
}

function verifyAuthority(reference)
{
    return {
        verified: true,
        authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: {
            sourceCommit: commit,
            worktreeFingerprint: fingerprint,
            schedulerRunId: 'run-a',
            producerId: 'unit-correctness'
        }
    };
}

function attempt(overrides = {})
{
    const refs = authorityReferences();
    return sealContentDigest({
        schema: attemptReceiptSchema,
        producerId: 'unit-correctness',
        attemptNumber: 1,
        maxAttempts: 1,
        sourceCommit: commit,
        worktreeFingerprint: fingerprint,
        schedulerRunId: 'run-a',
        command: ['node', '--test'],
        commandDigest: digestCanonical(['node', '--test']),
        executionEnvelopeDigest: refs[0].artifactDigest,
        replayPlanDigest: refs[1].artifactDigest,
        temporalContextDigest: refs[2].artifactDigest,
        authorityReferences: refs,
        startedAt: '2026-08-26T00:00:00.000Z',
        finishedAt: '2026-08-26T00:00:01.000Z',
        durationMs: 1000,
        exitCode: 0,
        signal: null,
        failureClass: null,
        failureKind: null,
        failedTestIds: [],
        executedTestIds: ['unit:one'],
        stdoutPath: 'attempt-1/stdout.log',
        stderrPath: 'attempt-1/stderr.log',
        artifactPaths: ['attempt-1/stderr.log', 'attempt-1/stdout.log'],
        artifactDigests: {
            'attempt-1/stderr.log': `sha256:${'f'.repeat(64)}`,
            'attempt-1/stdout.log': `sha256:${'0'.repeat(64)}`
        },
        firstFailure: false,
        retryDecision: 'not-applicable',
        retryPolicyId: 'correctness-first-attempt',
        status: 'clean-success',
        ...overrides
    });
}

function aggregate(attemptReceipt, overrides = {})
{
    return sealContentDigest({
        schema: aggregateAttemptReceiptSchema,
        producerId: attemptReceipt.producerId,
        schedulerRunId: attemptReceipt.schedulerRunId,
        sourceCommit: attemptReceipt.sourceCommit,
        worktreeFingerprint: attemptReceipt.worktreeFingerprint,
        retryPolicyId: attemptReceipt.retryPolicyId,
        attempts: [{
            attemptNumber: 1,
            path: 'attempt-1/receipt.json',
            digest: attemptReceipt.contentDigest
        }],
        firstAttemptStatus: attemptReceipt.status,
        finalAttemptStatus: attemptReceipt.status,
        finalClassification: attemptReceipt.status,
        cleanFirstAttempt: true,
        qualificationEligible: true,
        ...overrides
    });
}

test('retry policy registry is the closed exact policy authority', () =>
{
    const registry = readRetryPolicyRegistry();
    assert.deepEqual([...registry.policies], [
        ['correctness-first-attempt', registry.policies.get('correctness-first-attempt')],
        ['diagnostic-browser-process-crash', registry.policies.get('diagnostic-browser-process-crash')],
        ['dependency-transfer-observed-recovery', registry.policies.get('dependency-transfer-observed-recovery')]
    ]);
    for (const file of [
        'config/schemas/retry-policy-registry.schema.json',
        'config/schemas/retry-disposition-registry.schema.json',
        'config/schemas/test-attempt-receipt.schema.json',
        'config/schemas/test-attempt-aggregate-receipt.schema.json'
    ])
    {
        assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')), file);
    }
});

test('policy validator rejects correctness, diagnostic and restore retry semantic drift', () =>
{
    const source = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/retry-policy-registry.json'), 'utf8'));
    for (const mutate of [
        (value) =>
        {
            value.policies[0].allowedRetries = 1;
        },
        (value) =>
        {
            value.policies[1].allowedRetries = 2;
        },
        (value) =>
        {
            value.policies[1].retryOn = ['any-nonzero'];
        },
        (value) =>
        {
            value.policies[2].recoveredClassification = 'clean-success';
        },
        (value) =>
        {
            value.defaultDisposition.qualificationEligible = true;
        }
    ])
    {
        const candidate = clone(source);
        mutate(candidate);
        assert.throws(() => validateRetryPolicyRegistry(candidate));
    }
});

test('attempt validator requires externally verified digest authorities and exact content', () =>
{
    const receipt = attempt();
    assert.equal(validateAttemptReceipt(receipt, { verifyAuthority }).status, 'clean-success');
    assert.throws(
        () => validateAttemptReceipt(receipt),
        /external authority verifier is required/u
    );
    assert.throws(
        () => validateAttemptReceipt(receipt, { verifyAuthority: () => ({ verified: false }) }),
        /was not verified/u
    );
    const tampered = { ...receipt, command: ['node', '--test', 'other'] };
    assert.throws(() => validateAttemptReceipt(tampered, { verifyAuthority }), /command digest mismatch/u);
});

test('aggregate validator preserves the first attempt and clean qualification semantics', () =>
{
    const first = attempt();
    const receipt = aggregate(first);
    const validated = validateAggregateAttemptReceipt(receipt, {
        verifyAuthority,
        loadAttempt: () => first
    });
    assert.equal(validated.cleanFirstAttempt, true);
    assert.equal(validated.qualificationEligible, true);

    for (const mutate of [
        (value) =>
        {
            value.attempts[0].attemptNumber = 2;
        },
        (value) =>
        {
            value.firstAttemptStatus = 'failed-no-retry';
        },
        (value) =>
        {
            value.qualificationEligible = false;
        },
        (value) =>
        {
            value.finalClassification = 'success';
        }
    ])
    {
        const candidate = clone(receipt);
        mutate(candidate);
        candidate.contentDigest = digestCanonical(Object.fromEntries(
            Object.entries(candidate).filter(([key]) => key !== 'contentDigest')
        ));
        assert.throws(() => validateAggregateAttemptReceipt(candidate, {
            verifyAuthority,
            loadAttempt: () => first
        }));
    }
});

test('canonical digest rejects unknown fields and remains stable across key order', () =>
{
    assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
    const receipt = attempt();
    const candidate = { ...receipt, undocumentedSuccess: true };
    assert.throws(() => validateAttemptReceipt(candidate, { verifyAuthority }), /unknown fields/u);
});
