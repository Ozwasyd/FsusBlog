import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { digestValue } = await import(new URL('../../tools/release/browser-contract-receipt-contract.mjs', import.meta.url));
const {
    correctnessAggregateAuthorityLevel,
    createCorrectnessTerminalAuthority,
    validateCorrectnessTerminalSnapshot
} = await import(new URL('../../tools/release/correctness-scheduler-authority.mjs', import.meta.url));
const { schedulerAuthority } = await import(new URL('../../tools/release/test-evidence-receipts-cli.mjs', import.meta.url));
const { writeCanonicalSchedulerFixture } = await import(new URL('./support/canonical-scheduler-fixture.mjs', import.meta.url));

function fixture()
{
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const checkpoint = {
        schema: 'fsusblog.test-matrix.checkpoint.v1',
        runId: 'correctness-run',
        sourceState,
        authoritative: true,
        status: 'running',
        revision: 4,
        tiers: {
            unit: { status: 'success' },
            'production-correctness': {
                status: 'success',
                targetAttemptId: 'aggregate-attempt-a',
                buildReceiptDigest: `sha256:${'c'.repeat(64)}`,
                dependencyClosureDigest: `sha256:${'d'.repeat(64)}`,
                commandExitCode: 0,
                outcomeValidated: true,
                checkpointCASCommitted: true,
                postflightStatus: 'success'
            }
        }
    };
    checkpoint.contentDigest = digestValue(checkpoint);
    const expected = {
        runId: checkpoint.runId,
        sourceState,
        targetTierId: 'production-correctness',
        targetAttemptId: 'aggregate-attempt-a',
        checkpointRevision: checkpoint.revision,
        checkpointDigest: checkpoint.contentDigest,
        buildReceiptDigest: checkpoint.tiers['production-correctness'].buildReceiptDigest,
        dependencyClosureDigest: checkpoint.tiers['production-correctness'].dependencyClosureDigest
    };
    const before = { ref: checkpoint.contentDigest, checkpoint };
    return { before, after: structuredClone(before), expected };
}

test('aggregate missing and nonterminal states cannot grant final authority', () =>
{
    for (const status of [undefined, null, 'pending', 'admitted', 'running', 'finalizing'])
    {
        assert.equal(correctnessAggregateAuthorityLevel(status), 'provisional');
        const input = fixture();
        input.before.checkpoint.tiers['production-correctness'].status = status;
        input.before.checkpoint.contentDigest = digestValue(input.before.checkpoint);
        input.expected.checkpointDigest = input.before.checkpoint.contentDigest;
        input.before.ref = input.expected.checkpointDigest;
        input.after = structuredClone(input.before);
        assert.throws(() => createCorrectnessTerminalAuthority(input), /requires aggregate terminal success/u);
    }
});

test('aggregate terminal failures and unknown states fail closed', () =>
{
    for (const status of ['failure', 'blocked', 'cancelled', 'timed-out', 'internal-error', 'unknown', 'succeeded'])
    {
        assert.throws(() => correctnessAggregateAuthorityLevel(status), /cannot seal evidence/u);
    }
});

test('terminal authority contract binds both owner snapshots to exact current terminal commit', () =>
{
    const input = fixture();
    const authority = createCorrectnessTerminalAuthority(input);
    assert.equal(authority.kind, 'scheduler-terminal-finalizer');
    assert.equal(authority.status, 'success');
    assert.equal(authority.targetAttemptId, input.expected.targetAttemptId);
    assert.equal(authority.terminalCheckpointRef, input.before.ref);
    assert.equal(authority.terminalCheckpointDigest, input.expected.checkpointDigest);
    assert.equal(authority.terminalCheckpointRevision, input.expected.checkpointRevision);
    assert.equal(authority.dependencyClosureDigest, input.expected.dependencyClosureDigest);
});

test('exit outcome CAS and postflight failures refuse terminal authority even with rehashed success state', () =>
{
    for (const [field, value] of [
        ['commandExitCode', 1], ['outcomeValidated', false], ['checkpointCASCommitted', false], ['postflightStatus', 'failure']
    ])
    {
        const input = fixture();
        input.before.checkpoint.tiers['production-correctness'][field] = value;
        input.before.checkpoint.contentDigest = digestValue(input.before.checkpoint);
        input.expected.checkpointDigest = input.before.checkpoint.contentDigest;
        input.before.ref = input.expected.checkpointDigest;
        input.after = structuredClone(input.before);
        assert.throws(() => createCorrectnessTerminalAuthority(input), new RegExp(field, 'u'));
    }
});

test('state revision ref digest and attempt drift cannot grant terminal authority', () =>
{
    for (const field of ['runId', 'revision', 'contentDigest', 'sourceState'])
    {
        const input = fixture();
        input.after.checkpoint[field] = field === 'revision' ? 5 : 'changed';
        assert.throws(() => createCorrectnessTerminalAuthority(input), /mismatch/u);
    }
    for (const field of ['targetAttemptId', 'buildReceiptDigest', 'dependencyClosureDigest'])
    {
        const input = fixture();
        input.expected[field] = field.endsWith('Digest') ? `sha256:${'e'.repeat(64)}` : 'aggregate-attempt-b';
        assert.throws(() => createCorrectnessTerminalAuthority(input), new RegExp(field, 'u'));
    }
    const ref = fixture();
    ref.after.ref = `sha256:${'e'.repeat(64)}`;
    assert.throws(() => createCorrectnessTerminalAuthority(ref), /checkpoint ref/u);
    const absent = fixture();
    delete absent.expected.targetAttemptId;
    assert.throws(() => createCorrectnessTerminalAuthority(absent), /explicit canonical/u);
    assert.throws(() => validateCorrectnessTerminalSnapshot(null, absent.expected), /explicit canonical/u);
});

test('actual CLI authority cannot promote mutable success or missing aggregate projection', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'correctness-authority-boundary-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const input = fixture();
    const checkpoint = input.before.checkpoint;
    const file = path.join(root, '.tmp/test-runs', checkpoint.runId, 'checkpoint.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const status of [undefined, 'pending', 'admitted', 'running', 'finalizing'])
    {
        checkpoint.tiers['production-correctness'].status = status;
        writeCanonicalSchedulerFixture(file, checkpoint);
        const authority = schedulerAuthority(checkpoint.runId, ['unit', 'production-correctness'], checkpoint.sourceState, { repositoryRoot: root });
        assert.equal(authority.status, 'provisional');
        assert.equal(authority.qualificationEligible, false);
        assert.equal(authority.authoritative, false);
        assert.equal(authority.aggregateStatus, status ?? null);
    }
    checkpoint.tiers['production-correctness'].status = 'success';
    checkpoint.revision = 999;
    writeCanonicalSchedulerFixture(file, checkpoint);
    assert.throws(() => schedulerAuthority(checkpoint.runId, ['unit', 'production-correctness'], checkpoint.sourceState,
        { repositoryRoot: root }), /contract.missing-terminal-checkpoint-attestation/u);
    for (const status of ['failure', 'blocked', 'cancelled', 'timed-out', 'internal-error', 'unknown'])
    {
        checkpoint.tiers['production-correctness'].status = status;
        writeCanonicalSchedulerFixture(file, checkpoint);
        assert.throws(() => schedulerAuthority(checkpoint.runId, ['unit', 'production-correctness'], checkpoint.sourceState,
            { repositoryRoot: root }), /cannot seal evidence/u);
    }
});
