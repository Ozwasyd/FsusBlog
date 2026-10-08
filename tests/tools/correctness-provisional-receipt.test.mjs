import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { digestValue } = await import(new URL('../../tools/release/browser-contract-receipt-contract.mjs', import.meta.url));
const {
    correctnessProvisionalReceiptSchema,
    createCorrectnessProvisionalReceipt,
    validateCorrectnessProvisionalReceipt,
    verifyCorrectnessDependencyClosure
} = await import(new URL('../../tools/release/correctness-provisional-receipt.mjs', import.meta.url));
const { RunEvidenceObjectStore } = await import(new URL('../../tools/test-matrix/content-addressed-evidence-store.mjs', import.meta.url));

function fixture()
{
    const context = {
        runId: 'correctness-run',
        targetTierId: 'production-correctness',
        targetAttemptId: 'aggregate-attempt-a',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
        buildReceiptDigest: `sha256:${'c'.repeat(64)}`,
        createdFromCheckpointRevision: 3,
        aggregateStatus: 'running',
        requiredDependencyTierIds: ['unit'],
        dependencyAttemptIds: { unit: 'unit-attempt-a' },
        dependencyReceiptSchemas: { unit: 'controlled.owner-terminal.v1' },
        dependencyTerminalReceipts: [],
        executedTierIds: ['production-correctness', 'unit'],
        jobSummaryRefs: [],
        physicalExecutionRefs: []
    };
    const receipt = {
        schema: 'controlled.owner-terminal.v1',
        status: 'success',
        runId: context.runId,
        targetTierId: 'unit',
        targetAttemptId: context.dependencyAttemptIds.unit,
        sourceState: context.sourceState,
        buildReceiptDigest: context.buildReceiptDigest
    };
    receipt.contentDigest = digestValue(receipt);
    context.dependencyTerminalReceipts.push({
        reference: {
            ref: receipt.contentDigest,
            digest: receipt.contentDigest,
            runId: receipt.runId,
            targetTierId: receipt.targetTierId,
            targetAttemptId: receipt.targetAttemptId
        },
        receipt
    });
    return context;
}

function reseal(value)
{
    value.contentDigest = digestValue(value);
    return value;
}

test('provisional builder is pure and all nonterminal aggregate states remain unqualified', () =>
{
    for (const aggregateStatus of ['pending', 'admitted', 'running', 'finalizing'])
    {
        const context = { ...fixture(), aggregateStatus };
        const before = structuredClone(context);
        const first = createCorrectnessProvisionalReceipt(context);
        assert.deepEqual(context, before);
        assert.deepEqual(first, createCorrectnessProvisionalReceipt(context));
        assert.equal(first.schema, correctnessProvisionalReceiptSchema);
        assert.equal(first.status, 'provisional');
        assert.equal(first.qualificationEligible, false);
        assert.equal(first.contentDigest, digestValue(first));
        assert.deepEqual(validateCorrectnessProvisionalReceipt(first, context), first);
        first.sourceState.commit = 'd'.repeat(40);
        assert.deepEqual(context, before);
    }
});

test('provisional builder refuses missing and terminal aggregate states', () =>
{
    for (const aggregateStatus of [undefined, 'success', 'failure', 'blocked', 'cancelled', 'timed-out', 'internal-error', 'unknown'])
    {
        assert.throws(() => createCorrectnessProvisionalReceipt({ ...fixture(), aggregateStatus }), /aggregateStatus/u);
    }
});

test('provisional closure refuses absent failed unknown and tampered dependencies', () =>
{
    const absent = fixture();
    absent.dependencyTerminalReceipts = [];
    assert.throws(() => createCorrectnessProvisionalReceipt(absent), /closure roster/u);
    for (const status of ['running', 'failure', 'blocked', 'cancelled', 'timed-out', 'unknown', undefined])
    {
        const context = fixture();
        const receipt = context.dependencyTerminalReceipts[0].receipt;
        receipt.status = status;
        reseal(receipt);
        assert.throws(() => createCorrectnessProvisionalReceipt(context), /terminal success receipt/u);
    }
    const tampered = fixture();
    tampered.dependencyTerminalReceipts[0].receipt.buildReceiptDigest = `sha256:${'d'.repeat(64)}`;
    assert.throws(() => createCorrectnessProvisionalReceipt(tampered), /content-validated/u);
    const mismatch = fixture();
    mismatch.dependencyTerminalReceipts[0].reference.digest = `sha256:${'d'.repeat(64)}`;
    mismatch.dependencyTerminalReceipts[0].reference.ref = mismatch.dependencyTerminalReceipts[0].reference.digest;
    assert.throws(() => createCorrectnessProvisionalReceipt(mismatch), /\.digest/u);
    const unknown = fixture();
    unknown.dependencyTerminalReceipts[0].receipt.schema = 'unknown.v1';
    reseal(unknown.dependencyTerminalReceipts[0].receipt);
    assert.throws(() => createCorrectnessProvisionalReceipt(unknown), /\.schema/u);
});

test('provisional closure binds exact dependency roster and current dependency attempts', () =>
{
    const context = fixture();
    const closure = verifyCorrectnessDependencyClosure(context);
    assert.deepEqual(closure.dependencyTerminalReceiptRefs, context.dependencyTerminalReceipts.map((entry) => entry.reference));
    for (const field of ['runId', 'targetTierId', 'targetAttemptId', 'sourceState', 'buildReceiptDigest'])
    {
        const changed = fixture();
        const entry = changed.dependencyTerminalReceipts[0];
        entry.receipt[field] = field === 'sourceState'
            ? { ...entry.receipt.sourceState, commit: 'd'.repeat(40) }
            : field === 'buildReceiptDigest' ? `sha256:${'d'.repeat(64)}` : 'another-identity';
        reseal(entry.receipt);
        if (Object.hasOwn(entry.reference, field))
        {
            entry.reference[field] = entry.receipt[field];
        }
        entry.reference.ref = entry.receipt.contentDigest;
        entry.reference.digest = entry.receipt.contentDigest;
        assert.throws(() => createCorrectnessProvisionalReceipt(changed), /identity mismatch/u);
    }
    const duplicate = fixture();
    duplicate.dependencyTerminalReceipts.push(structuredClone(duplicate.dependencyTerminalReceipts[0]));
    assert.throws(() => createCorrectnessProvisionalReceipt(duplicate), /sorted unique/u);
});

test('provisional validation refuses rehashed promotion and wrong run attempt or checkpoint', () =>
{
    const context = fixture();
    for (const [field, replacement] of [
        ['schema', 'fsusblog.browserless-correctness-receipt.v2'],
        ['status', 'success'],
        ['qualificationEligible', true],
        ['runId', 'another-run'],
        ['targetAttemptId', 'aggregate-attempt-b'],
        ['createdFromCheckpointRevision', 4],
        ['dependencyClosureDigest', `sha256:${'d'.repeat(64)}`]
    ])
    {
        const receipt = createCorrectnessProvisionalReceipt(context);
        receipt[field] = replacement;
        reseal(receipt);
        assert.throws(() => validateCorrectnessProvisionalReceipt(receipt, context), new RegExp(field, 'u'));
    }
});

test('provisional schema refuses missing unknown and digest-tampered fields', () =>
{
    const context = fixture();
    const receipt = createCorrectnessProvisionalReceipt(context);
    for (const field of Object.keys(receipt))
    {
        const missing = structuredClone(receipt);
        delete missing[field];
        assert.throws(() => validateCorrectnessProvisionalReceipt(missing, context), /requires exactly/u);
    }
    assert.throws(() => validateCorrectnessProvisionalReceipt(reseal({ ...receipt, unexpected: true }), context), /requires exactly/u);
    assert.throws(() => createCorrectnessProvisionalReceipt({ ...context, unexpected: true }), /builder input/u);
    assert.throws(() => validateCorrectnessProvisionalReceipt({ ...receipt, executedTierIds: [] }, context), /executedTierIds/u);
    assert.throws(() => validateCorrectnessProvisionalReceipt({ ...receipt, contentDigest: `sha256:${'d'.repeat(64)}` }, context), /contentDigest/u);
    assert.throws(() => validateCorrectnessProvisionalReceipt(receipt), /identity mismatch/u);
});

test('provisional references reject mutable selectors and cross-run summary or physical evidence', () =>
{
    for (const field of ['jobSummaryRefs', 'physicalExecutionRefs'])
    {
        const context = fixture();
        context[field] = [structuredClone(context.dependencyTerminalReceipts[0].reference)];
        assert.doesNotThrow(() => createCorrectnessProvisionalReceipt(context));
        context[field][0].ref = 'latest.json';
        assert.throws(() => createCorrectnessProvisionalReceipt(context), /\.ref/u);
        context[field][0].ref = context[field][0].digest;
        context[field][0].runId = 'another-run';
        assert.throws(() => createCorrectnessProvisionalReceipt(context), /runId/u);
    }
});

test('existing content-addressed store preserves provisional attempt objects and refuses overwrite', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'correctness-provisional-store-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const input = fixture();
    const store = new RunEvidenceObjectStore({ root, runId: input.runId, sourceState: input.sourceState });
    const candidateA = createCorrectnessProvisionalReceipt(input);
    const first = store.publishLogicalReceipt({ logicalOwner: 'correctness-provisional.aggregate-attempt-a',
        requiredIds: ['production-correctness'], decision: 'provisional', document: candidateA });
    const originalBytes = fs.readFileSync(first.file);
    input.targetAttemptId = 'aggregate-attempt-b';
    const candidateB = createCorrectnessProvisionalReceipt(input);
    assert.throws(() => store.publishLogicalReceipt({ logicalOwner: 'correctness-provisional.aggregate-attempt-a',
        requiredIds: ['production-correctness'], decision: 'provisional', document: candidateB }), /immutable/u);
    const second = store.publishLogicalReceipt({ logicalOwner: 'correctness-provisional.aggregate-attempt-b',
        requiredIds: ['production-correctness'], decision: 'provisional', document: candidateB });
    assert.notEqual(first.documentDigest, second.documentDigest);
    assert.deepEqual(fs.readFileSync(first.file), originalBytes);
    assert.deepEqual(store.readLogicalReceipt('correctness-provisional.aggregate-attempt-a').document, candidateA);
    assert.deepEqual(store.readLogicalReceipt('correctness-provisional.aggregate-attempt-b').document, candidateB);
    assert.throws(() => validateCorrectnessProvisionalReceipt(candidateA, input), /targetAttemptId/u);
});
