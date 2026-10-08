import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fixture, seal } from './support/correctness-terminal-fixture.mjs';

const { CorrectnessTerminalSealJournal } = await import(new URL('../../tools/release/correctness-terminal-seal-journal.mjs', import.meta.url));
const { RunEvidenceObjectStore } = await import(new URL('../../tools/test-matrix/content-addressed-evidence-store.mjs', import.meta.url));

function setup(context)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'correctness-seal-journal-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const input = fixture();
    const store = new RunEvidenceObjectStore({ root, runId: input.context.runId, sourceState: input.context.sourceState });
    const journal = new CorrectnessTerminalSealJournal({ store, targetAttemptId: input.context.targetAttemptId });
    return { input, root, store, journal };
}

test('prepared crash recovery uses the explicit packet and is idempotent after verified reverse commit', async (context) =>
{
    const { input, store, journal } = setup(context);
    const prepared = journal.prepare(input);
    assert.equal(prepared.status, 'prepared');
    assert.throws(() => journal.resolve(prepared), /no consumable/u);
    const restart = new CorrectnessTerminalSealJournal({ store, targetAttemptId: input.context.targetAttemptId });
    const readFinalizedCheckpoint = async (binding) =>
    {
        assert.equal(binding.terminalParentRef, input.receipt.terminalCheckpointRef);
        assert.equal(binding.finalReceiptDigest, input.receipt.contentDigest);
        return input.finalizedCheckpoint;
    };
    assert.equal((await restart.recover({ ...prepared, readFinalizedCheckpoint })).status, 'finalized');
    const bytes = fs.readFileSync(path.join(store.journalsDirectory, `${store.runId}.jsonl`));
    assert.equal((await restart.recover({ ...prepared, readFinalizedCheckpoint })).status, 'finalized');
    assert.deepEqual(fs.readFileSync(path.join(store.journalsDirectory, `${store.runId}.jsonl`)), bytes);
    assert.deepEqual(store.readJournal().map((event) => event.status), ['prepared', 'finalized']);
});

test('uncommitted reverse reference and final persistence failure cannot become consumable success', async (context) =>
{
    const { input, journal, store } = setup(context);
    const prepared = journal.prepare(input);
    await assert.rejects(journal.recover({ ...prepared, readFinalizedCheckpoint: async () => null }), /checkpoint schema/u);
    assert.throws(() => journal.resolve(prepared), /no consumable/u);
    const original = store.publishObject.bind(store);
    store.publishObject = () =>
    {
        throw new Error('controlled final write failure');
    };
    assert.throws(() => journal.finalize({ ...prepared, finalizedCheckpoint: input.finalizedCheckpoint }), /final write failure/u);
    store.publishObject = original;
    assert.equal(journal.state().record.status, 'prepared');
    journal.reject({ ...prepared, reasonCode: 'final-persistence-failed' });
    assert.throws(() => journal.resolve(prepared), /no consumable/u);
    assert.deepEqual(store.readJournal().map((event) => event.status), ['prepared', 'rejected']);
});

test('rejected attempt history cannot be upgraded overwritten or selected by another attempt', async (context) =>
{
    const { input, journal, store } = setup(context);
    const prepared = journal.prepare(input);
    journal.reject({ ...prepared, reasonCode: 'command-failed' });
    assert.throws(() => journal.finalize({ ...prepared, finalizedCheckpoint: input.finalizedCheckpoint }), /explicit prepared ref/u);
    assert.equal(journal.prepare(input).status, 'rejected');
    let reads = 0;
    assert.equal((await journal.recover({ ...prepared, readFinalizedCheckpoint: async () =>
    {
        reads += 1;
    } })).status, 'rejected');
    assert.equal(reads, 0);
    const next = new CorrectnessTerminalSealJournal({ store, targetAttemptId: 'aggregate-attempt-b' });
    assert.throws(() => next.resolve(prepared), /no consumable/u);
    await assert.rejects(next.recover({ ...prepared, readFinalizedCheckpoint: async () => input.finalizedCheckpoint }), /current-attempt/u);
    const changed = structuredClone(input);
    changed.finalizedAt = '2026-10-08T00:01:00.000Z';
    assert.throws(() => journal.prepare(changed), /overwrite attempt history/u);
    const nextInput = fixture({ targetAttemptId: 'aggregate-attempt-b' });
    const nextPrepared = next.prepare(nextInput);
    assert.equal(next.finalize({ ...nextPrepared, finalizedCheckpoint: nextInput.finalizedCheckpoint }).status, 'finalized');
    assert.throws(() => next.resolve(prepared), /no consumable/u);
    assert.deepEqual(store.readJournal().map((event) => event.status), ['prepared', 'rejected', 'prepared', 'finalized']);
});

test('failed finalized-journal append retains prepared state and exact-ref recovery completes once', async (context) =>
{
    const { input, journal, store } = setup(context);
    const prepared = journal.prepare(input);
    const original = store.appendJournalEvent.bind(store);
    store.appendJournalEvent = () =>
    {
        throw new Error('controlled journal append failure');
    };
    assert.throws(() => journal.finalize({ ...prepared, finalizedCheckpoint: input.finalizedCheckpoint }), /journal append failure/u);
    store.appendJournalEvent = original;
    assert.throws(() => journal.resolve(prepared), /no consumable/u);
    const result = await journal.recover({ ...prepared, readFinalizedCheckpoint: async () => input.finalizedCheckpoint });
    assert.equal(result.status, 'finalized');
    assert.equal(store.readJournal().length, 2);
    const drift = structuredClone(input.finalizedCheckpoint);
    drift.tiers['production-correctness'].status = 'failure';
    seal(drift);
    await assert.rejects(journal.recover({ ...prepared, readFinalizedCheckpoint: async () => drift }), /checkpoint cannot drift/u);
});

test('packet object and journal chain tamper fail closed without projection fallback', (context) =>
{
    const { input, journal, store } = setup(context);
    const prepared = journal.prepare(input);
    const file = store.objectFile(prepared.packetRef);
    const bytes = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, bytes.replace('aggregate-attempt-a', 'aggregate-attempt-b'));
    assert.throws(() => journal.readPacket(prepared.packetRef), /object digest mismatch/u);
    fs.writeFileSync(file, bytes);
    const journalFile = path.join(store.journalsDirectory, `${store.runId}.jsonl`);
    const event = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    event.status = 'finalized';
    fs.writeFileSync(journalFile, `${JSON.stringify(event)}\n`);
    assert.throws(() => journal.resolve(prepared), /journal content digest mismatch/u);
});
