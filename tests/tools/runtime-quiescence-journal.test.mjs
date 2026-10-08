import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {createQuiescenceJournal, readQuiescenceJournal, validateQuiescenceJournal} = await import(new URL('../../tools/test-matrix/runtime-quiescence-journal.mjs', import.meta.url));

import {identity, reseal} from './runtime-quiescence-model.mjs';

function releaseProof(binding, status = 'released')
{
    return reseal({schema: 'fsusblog.quiescence-release.v1', ...binding, leaseId: 'unit-model-lease',
        generation: 7, outcome: 'complete', status, errors: status === 'released' ? [] : ['unit-model-release-failure']});
}

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-quiescence-journal-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const file = path.join(root, 'explicit-unit-model-journal.jsonl');
    return {file, root, binding: {attemptId: 'unit-model-attempt', identity}};
}

test('actual append/fsync/read enforces ordered lifecycle and explicit terminal owner recovery state', (t) =>
{
    const {file, binding} = fixture(t);
    const journal = createQuiescenceJournal(file);
    t.after(() => journal.close());
    for (const state of ['prepared', 'frozen', 'observed', 'observed', 'sealed'])
    {
        journal.append({state, ...binding});
    }
    assert.equal(readQuiescenceJournal(file, binding).ownerRecoveryRequired, true);
    journal.append({state: 'released', ...binding, releaseReceipt: releaseProof(binding)});
    assert.equal(readQuiescenceJournal(file, binding).ownerRecoveryRequired, false);
    assert.throws(() => journal.append({state: 'prepared', ...binding}), /lifecycle/u);
    journal.close();
    assert.throws(() => journal.append({state: 'released', ...binding}), /closed/u);
});

for (const state of ['prepared', 'sealed', 'release-failed'])
{
    test(`${state} interruption retains source evidence and requires actual owner recovery without resuming file`, (t) =>
    {
        const {file, binding} = fixture(t);
        const journal = createQuiescenceJournal(file);
        for (const next of state === 'prepared' ? ['prepared'] : ['prepared', 'frozen', 'observed', 'sealed'])
        {
            journal.append({state: next, ...binding});
        }
        if (state === 'release-failed')
        {
            journal.append({state: 'released', ...binding, releaseReceipt: releaseProof(binding, 'failed')});
        }
        journal.close();
        const bytes = fs.readFileSync(file);
        assert.equal(readQuiescenceJournal(file, binding).ownerRecoveryRequired, true);
        assert.throws(() => createQuiescenceJournal(file), /EEXIST/u);
        assert.deepEqual(fs.readFileSync(file), bytes);
    });
}

test('foreign identities, reordered history, tampering and partial crash writes are rejected', (t) =>
{
    const {file, binding} = fixture(t);
    const journal = createQuiescenceJournal(file);
    journal.append({state: 'prepared', ...binding});
    journal.append({state: 'frozen', ...binding});
    journal.close();
    const entries = readQuiescenceJournal(file, binding).entries;
    assert.throws(() => validateQuiescenceJournal([...entries].reverse(), binding));
    assert.throws(() => readQuiescenceJournal(file, {...binding, attemptId: 'foreign-attempt'}));
    const altered = structuredClone(entries);
    altered[1] = reseal({...altered[1], previousDigest: 'wrong-ancestor'});
    assert.throws(() => validateQuiescenceJournal(altered, binding));
    fs.appendFileSync(file, '{"partial":');
    assert.throws(() => readQuiescenceJournal(file, binding), /partial append/u);
});

test('two explicit journals coexist without latest scanning, symlink reuse or file overwrites', (t) =>
{
    const {file, root, binding} = fixture(t);
    const current = createQuiescenceJournal(file);
    current.append({state: 'prepared', ...binding});
    current.close();
    const oldFile = path.join(root, 'older-unit-model-journal.jsonl');
    const old = createQuiescenceJournal(oldFile);
    old.append({state: 'prepared', attemptId: 'older-attempt', identity: {...identity, runId: 'older-run'}});
    old.close();
    assert.equal(readQuiescenceJournal(file, binding).entries[0].event.identity.runId, identity.runId);
    const link = path.join(root, 'journal-link.jsonl');
    fs.symlinkSync(file, link);
    assert.throws(() => createQuiescenceJournal(link));
    if (fs.constants.O_NOFOLLOW)
    {
        assert.throws(() => readQuiescenceJournal(link, binding));
    }
});
