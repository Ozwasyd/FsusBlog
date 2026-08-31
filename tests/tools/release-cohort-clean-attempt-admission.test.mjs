import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    appendCleanAttemptCohortSlot,
    createCleanAttemptCohort,
    persistCleanAttemptCohortRevision,
    validateCleanAttemptCohort
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/release/release-clean-attempt-cohort.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { sha256 } from '../../tools/test/attempt-provenance.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { runProducerAttempts } from '../../tools/test/attempt-runner.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const commandFixture = path.join(root, 'tests/tools/fixtures/attempt-runner-command.mjs');
const sourceCommit = '1'.repeat(40);
const worktreeFingerprint = `sha256:${'2'.repeat(64)}`;
const buildIdentity = `sha256:${'9'.repeat(64)}`;

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

function verification(producerId, schedulerRunId)
{
    return (reference) => ({
        verified: true,
        authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId }
    });
}

async function producer(evidenceRoot, schedulerRunId, {
    producerId = 'release-candidate',
    scenario = 'success',
    retryPolicyId = 'correctness-first-attempt'
} = {})
{
    const result = await runProducerAttempts({
        evidenceRoot,
        producerId,
        retryPolicyId,
        sourceCommit,
        worktreeFingerprint,
        schedulerRunId,
        command: [process.execPath, commandFixture, scenario],
        cwd: root,
        env: { PATH: process.env.PATH },
        authorityReferences: authorityReferences(),
        verifyAuthority: verification(producerId, schedulerRunId),
        expectedTestIds: ['fixture:attempt-runner'],
        timeoutMs: 5_000
    });
    return {
        aggregateReceipt: result.aggregate,
        loadAttempt: (reference) => result.attempts[reference.attemptNumber - 1],
        verifyAuthority: verification(producerId, schedulerRunId),
        verifyArtifact: (relative, digest, receipt) => (
            fs.existsSync(path.join(result.producerRoot, `attempt-${receipt.attemptNumber}`, relative))
            && sha256(fs.readFileSync(
                path.join(result.producerRoot, `attempt-${receipt.attemptNumber}`, relative)
            )) === digest
        ),
        aggregateReference: {
            path: `${schedulerRunId}/aggregate-receipt.json`,
            digest: result.aggregate.contentDigest
        }
    };
}

function add(cohort, slot, evidence)
{
    return appendCleanAttemptCohortSlot(cohort, {
        slot,
        ...evidence,
        expectedIdentity: { sourceCommit, worktreeFingerprint }
    });
}

test('three independent first-attempt clean runs qualify an append-only cohort', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-clean-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    let cohort = createCleanAttemptCohort('candidate-1', buildIdentity);
    for (const slot of [1, 2, 3])
    {
        const evidence = await producer(temporary, `cohort-run-${slot}`);
        cohort = add(cohort, slot, evidence);
        assert.equal(cohort.events.at(-1).status, 'admitted');
    }
    assert.equal(cohort.qualificationEligible, true);
    assert.equal(validateCleanAttemptCohort(cohort), cohort);
    const revision = path.join(temporary, 'cohorts/candidate-1/revision-3.json');
    persistCleanAttemptCohortRevision(revision, cohort);
    assert.equal(fs.statSync(revision).mode & 0o222, 0);
    assert.throws(() => persistCleanAttemptCohortRevision(revision, cohort), /EEXIST/u);
});

test('a failed slot is retained and cannot be replaced by a later clean run', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-failed-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const failed = await producer(temporary, 'failed-run', { scenario: 'product-failure' });
    const cohort = add(createCleanAttemptCohort('candidate-2', buildIdentity), 1, failed);
    assert.equal(cohort.events[0].status, 'rejected');
    assert.equal(cohort.events[0].reasons[0].code, 'attempt.not-clean-first');
    const laterClean = await producer(temporary, 'later-clean-run');
    assert.throws(() => add(cohort, 1, laterClean), /cohort\.slot-immutable/u);
});

test('recovered diagnostic or restore attempts cannot occupy a clean cohort slot', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-recovered-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    for (const [producerId, retryPolicyId, scenario] of [
        ['browser-diagnostics', 'diagnostic-browser-process-crash', 'browser-crash-once'],
        ['dependency-restore', 'dependency-transfer-observed-recovery', 'restore-timeout-once']
    ])
    {
        const evidence = await producer(temporary, `${producerId}-run`, {
            producerId,
            retryPolicyId,
            scenario
        });
        const cohort = add(createCleanAttemptCohort(`candidate-${producerId}`, buildIdentity), 1, evidence);
        assert.equal(cohort.events[0].status, 'rejected');
        assert.equal(cohort.events[0].reasons[0].code, 'attempt.not-clean-first');
    }
});

test('missing attempts, status-only evidence, cross identity and artifact tamper fail closed', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-invalid-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const evidence = await producer(temporary, 'valid-run');
    const cases = [
        {
            ...evidence,
            aggregateReceipt: { status: 'ok', exitCode: 0 },
            aggregateReference: { path: 'summary/latest.json', digest: `sha256:${'8'.repeat(64)}` }
        },
        {
            ...evidence,
            aggregateReceipt: { ...evidence.aggregateReceipt, attempts: [] }
        },
        {
            ...evidence,
            expectedIdentity: { sourceCommit: 'a'.repeat(40) }
        },
        {
            ...evidence,
            verifyArtifact: () => false
        }
    ];
    for (const [index, invalid] of cases.entries())
    {
        const cohort = appendCleanAttemptCohortSlot(
            createCleanAttemptCohort(`candidate-invalid-${index}`, buildIdentity),
            { slot: 1, ...invalid, expectedIdentity: invalid.expectedIdentity ?? {} }
        );
        assert.equal(cohort.qualificationEligible, false);
        assert.equal(cohort.events[0].status, 'rejected');
        assert.ok(cohort.events[0].reasons[0].code.startsWith('attempt.'));
    }
});

test('cohort slots reject reused run and aggregate roots with specific reasons', async (context) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-reused-cohort-'));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const evidence = await producer(temporary, 'shared-run');
    let cohort = add(createCleanAttemptCohort('candidate-reused', buildIdentity), 1, evidence);
    cohort = add(cohort, 2, evidence);
    assert.equal(cohort.events[1].status, 'rejected');
    assert.deepEqual(cohort.events[1].reasons.map((item) => item.code), [
        'cohort.run-not-independent',
        'cohort.attempt-root-not-independent'
    ]);
});
