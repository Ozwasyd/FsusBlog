import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fixture, seal } from './support/correctness-terminal-fixture.mjs';

const {
    createCorrectnessTerminalReceipt,
    verifyCorrectnessTerminalReceipt
} = await import(new URL('../../tools/release/correctness-terminal-receipt.mjs', import.meta.url));
const { RunEvidenceObjectStore } = await import(new URL('../../tools/test-matrix/content-addressed-evidence-store.mjs', import.meta.url));

test('terminal v2 contract binds the immutable parent and finalized child without a circular digest', () =>
{
    const input = fixture();
    const before = structuredClone(input.provisional);
    const final = createCorrectnessTerminalReceipt(input);
    assert.deepEqual(final, input.receipt);
    assert.deepEqual(input.provisional, before);
    assert.notEqual(final.contentDigest, input.provisional.contentDigest);
    assert.equal(final.provisionalReceiptDigest, input.provisional.contentDigest);
    assert.equal(final.terminalCheckpointDigest, input.snapshots.before.checkpoint.contentDigest);
    assert.equal(input.finalizedCheckpoint.correctnessTerminalSeal.finalReceiptDigest, final.contentDigest);
    assert.equal(verifyCorrectnessTerminalReceipt(input).status, 'verified');
});

test('terminal receipt existence alone and prepared or absent reverse commit remain unusable', () =>
{
    const input = fixture();
    for (const status of ['prepared', 'rejected', undefined])
    {
        const checkpoint = structuredClone(input.finalizedCheckpoint);
        checkpoint.correctnessTerminalSeal.status = status;
        seal(checkpoint);
        assert.throws(() => verifyCorrectnessTerminalReceipt({ ...input, finalizedCheckpoint: checkpoint }), /reverse ref/u);
    }
    assert.throws(() => verifyCorrectnessTerminalReceipt({ ...input, finalizedCheckpoint: undefined }), /checkpoint schema/u);
});

test('terminal builder refuses nonzero exit CAS failure postflight failure and aggregate failure', () =>
{
    for (const field of ['commandExitCode', 'checkpointCASCommitted', 'postflightStatus', 'status'])
    {
        const input = fixture();
        input.snapshots.before.checkpoint.tiers['production-correctness'][field] = field === 'commandExitCode' ? 1
            : field === 'checkpointCASCommitted' ? false : 'failure';
        seal(input.snapshots.before.checkpoint);
        input.snapshots.expected.checkpointDigest = input.snapshots.before.checkpoint.contentDigest;
        input.snapshots.before.ref = input.snapshots.expected.checkpointDigest;
        input.snapshots.after = structuredClone(input.snapshots.before);
        assert.throws(() => createCorrectnessTerminalReceipt(input), /authority|cannot seal/u);
    }
});

test('terminal packet rejects rehashed cross-attempt closure aggregate and reverse-reference tamper', () =>
{
    for (const field of ['targetAttemptId', 'dependencyClosureDigest', 'terminalCheckpointRef', 'terminalState'])
    {
        const input = fixture();
        input.aggregateTerminalReceipt[field] = field.endsWith('Digest') || field.endsWith('Ref')
            ? `sha256:${'d'.repeat(64)}` : 'another-attempt';
        seal(input.aggregateTerminalReceipt);
        assert.throws(() => createCorrectnessTerminalReceipt(input), /mismatch/u);
    }
    for (const field of ['finalReceiptRef', 'finalReceiptDigest', 'terminalParentRef', 'targetAttemptId'])
    {
        const input = fixture();
        input.finalizedCheckpoint.correctnessTerminalSeal[field] = field === 'targetAttemptId'
            ? 'aggregate-attempt-b' : `sha256:${'d'.repeat(64)}`;
        seal(input.finalizedCheckpoint);
        assert.throws(() => verifyCorrectnessTerminalReceipt(input), /reverse ref/u);
    }
});

test('terminal consumer contract refuses v1 provisional unknown fields and changed current state', () =>
{
    for (const schema of ['fsusblog.browserless-correctness-receipt.v1', 'fsusblog.browserless-correctness-provisional.v1'])
    {
        const input = fixture();
        input.receipt.schema = schema;
        seal(input.receipt);
        assert.throws(() => verifyCorrectnessTerminalReceipt(input), /sealed document/u);
    }
    const extra = fixture();
    extra.receipt.unexpected = true;
    seal(extra.receipt);
    assert.throws(() => verifyCorrectnessTerminalReceipt(extra), /sealed document/u);
    const drift = fixture();
    drift.finalizedCheckpoint.tiers['production-correctness'].status = 'cancelled';
    seal(drift.finalizedCheckpoint);
    assert.throws(() => verifyCorrectnessTerminalReceipt(drift), /aggregate status/u);
    const revision = fixture();
    revision.finalizedCheckpoint.revision += 1;
    seal(revision.finalizedCheckpoint);
    assert.throws(() => verifyCorrectnessTerminalReceipt(revision), /revision/u);
    const failedRun = fixture();
    failedRun.finalizedCheckpoint.status = 'failure';
    seal(failedRun.finalizedCheckpoint);
    assert.throws(() => verifyCorrectnessTerminalReceipt(failedRun), /run state/u);
});

test('portable packet validates actual immutable objects and retains provisional bytes', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'correctness-terminal-packet-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const input = fixture();
    const store = new RunEvidenceObjectStore({ root, runId: input.context.runId, sourceState: input.context.sourceState });
    const provisional = store.publishObject(input.provisional);
    const original = fs.readFileSync(store.objectFile(provisional.digest));
    const final = store.publishObject(input.receipt);
    const terminal = store.publishObject(input.snapshots.before.checkpoint);
    const reverse = store.publishObject(input.finalizedCheckpoint);
    const aggregate = store.publishObject(input.aggregateTerminalReceipt);
    const read = (published) => store.readObject(published.digest).value;
    assert.equal(verifyCorrectnessTerminalReceipt({ ...input,
        provisional: read(provisional), receipt: read(final), finalizedCheckpoint: read(reverse),
        aggregateTerminalReceipt: read(aggregate), snapshots: { ...input.snapshots,
            before: { ref: read(terminal).contentDigest, checkpoint: read(terminal) },
            after: { ref: read(terminal).contentDigest, checkpoint: read(terminal) } }
    }).status, 'verified');
    assert.deepEqual(fs.readFileSync(store.objectFile(provisional.digest)), original);
    const bytes = fs.readFileSync(store.objectFile(final.digest), 'utf8');
    fs.writeFileSync(store.objectFile(final.digest), bytes.replace('scheduler-terminal-finalizer', 'aggregate-command'));
    assert.throws(() => read(final), /object digest mismatch/u);
});
