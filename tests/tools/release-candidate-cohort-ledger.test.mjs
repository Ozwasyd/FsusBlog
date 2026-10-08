import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { candidateIdentity, testDigest, otherDigest } from './release-candidate-test-support.mjs';

const { createCohortLedger, verifyCohortLedger, appendCohortLedger, sealCohortLedger } = await import(new URL('../../tools/release-candidate/cohort-ledger.mjs', import.meta.url));
const { createCohortStore, readCohortStore, appendCohortStore, sealCohortStore } = await import(new URL('../../tools/release-candidate/cohort-store.mjs', import.meta.url));
const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));

const metadataTime = '2026-01-01T00:00:00.000Z';

function member(id, patch = {})
{
    return { candidateIdentity: candidateIdentity(), runId: `run-${id}`, schedulerRunId: `scheduler-${id}`,
        runtimeNamespace: `namespace-${id}`, freshCleanupReceiptDigest: digestCanonical({ cleanup: id }),
        runReceiptRef: { path: `runs/${id}/outcome.json`, contentDigest: digestCanonical({ run: id }) },
        outcomeFingerprint: testDigest, membershipStatus: 'failed', ...patch };
}

function initial()
{
    return createCohortLedger(candidateIdentity(), { instanceKey: 'qualification-a', createdAt: metadataTime });
}

function append(ledger, ordinal, value)
{
    return appendCohortLedger(ledger, { ordinal, member: value, addedAt: metadataTime, expectedDigest: ledger.contentDigest });
}

function storeFixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-cohort-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ref = createCohortStore({ root, identityPlan: { unitContract: true }, verifyIdentityPlan: () => candidateIdentity(),
        instanceKey: 'qualification-a', createdAt: metadataTime });
    return { root, cohortId: ref.cohortId, expectedDigest: ref.contentDigest };
}

test('cohort creates a content-addressed immutable root without executing any run', () =>
{
    const ledger = initial();
    const inspected = verifyCohortLedger(ledger, { expectedDigest: ledger.contentDigest });
    assert.deepEqual(inspected.members, []);
    assert.equal(inspected.sealed, false);
    assert.notEqual(ledger.root.cohortId, ledger.root.candidateIdentity.sourceCommit);
    const otherInstance = createCohortLedger(candidateIdentity(), { instanceKey: 'qualification-b', createdAt: metadataTime });
    assert.notEqual(otherInstance.root.cohortId, ledger.root.cohortId);
    assert.equal(otherInstance.root.candidateIdentityDigest, ledger.root.candidateIdentityDigest);
});

test('cohort preserves failed cancelled partial and infrastructure outcomes in append order', () =>
{
    let ledger = initial();
    for (const [index, status] of ['failed', 'cancelled', 'partial', 'infra-failure', 'success'].entries())
    {
        ledger = append(ledger, index + 1, member(index, { membershipStatus: status }));
    }
    const inspected = verifyCohortLedger(ledger, { expectedDigest: ledger.contentDigest });
    assert.deepEqual(inspected.members.map((value) => value.membershipStatus), ['failed', 'cancelled', 'partial', 'infra-failure', 'success']);
    assert.equal(ledger.events[0].previousDigest, ledger.root.contentDigest);
    assert.equal(ledger.events[4].previousDigest, ledger.events[3].contentDigest);
});

test('cohort rejects same commit with different worktree alias build fixture or plan inputs', () =>
{
    const ledger = initial();
    for (const patch of [{ worktreeFingerprint: otherDigest }, { repositorySubmoduleOrAliasDigests: { ui: otherDigest } },
        { immutableBuildReceiptDigest: otherDigest }, { imageDigest: otherDigest }, { fixtureSeedDigest: otherDigest },
        { replayPlanDigest: otherDigest }, { businessEpochUtc: '2026-01-02T00:00:00.000Z' }, { serviceTopologyDigest: otherDigest }])
    {
        assert.throws(() => append(ledger, 1, member('one', { candidateIdentity: candidateIdentity(patch) })), /candidate mismatch/u);
    }
    assert.throws(() => append(ledger, 1, member('one', { candidateIdentity: { ...candidateIdentity(), worktreeFingerprint: otherDigest } })), /digest mismatch/u);
});

test('cohort rejects reused ordinals run IDs scheduler IDs namespaces and cleanup receipts', () =>
{
    const first = member('first');
    const ledger = append(initial(), 1, first);
    assert.throws(() => append(ledger, 1, member('second')), /ordinal/u);
    for (const field of ['runId', 'schedulerRunId', 'runtimeNamespace', 'freshCleanupReceiptDigest'])
    {
        assert.throws(() => append(ledger, 2, member('second', { [field]: first[field] })), /boundary reused/u, field);
    }
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.events[0].member.membershipStatus, 'failed');
});

test('cohort seal is a terminal chained event that preserves all members', () =>
{
    const ledger = append(initial(), 1, member('first'));
    const sealed = sealCohortLedger(ledger, { addedAt: metadataTime, expectedDigest: ledger.contentDigest });
    assert.deepEqual(sealed.events[0], ledger.events[0]);
    assert.equal(sealed.events[1].type, 'seal');
    assert.equal(verifyCohortLedger(sealed, { expectedDigest: sealed.contentDigest }).sealed, true);
    assert.throws(() => append(sealed, 2, member('second')), /sealed/u);
    assert.throws(() => sealCohortLedger(sealed, { addedAt: metadataTime, expectedDigest: sealed.contentDigest }), /already sealed/u);
});

test('cohort verifier refuses deleted replaced reordered and truncated failed slots', () =>
{
    const one = append(initial(), 1, member('first'));
    const two = append(one, 2, member('second'));
    for (const events of [two.events.slice(1), [...two.events].reverse(),
        [sealContentDigest({ ...two.events[0], member: member('replacement') }), two.events[1]]])
    {
        const altered = sealContentDigest({ ...two, events });
        assert.throws(() => verifyCohortLedger(altered, { expectedDigest: altered.contentDigest }), /chain/u);
    }
    const truncated = sealContentDigest({ ...two, events: [two.events[0]] });
    assert.throws(() => verifyCohortLedger(truncated, { expectedDigest: two.contentDigest }), /explicit expected digest/u);
    assert.throws(() => verifyCohortLedger(two), /explicit expected ledger digest/u);
});

test('cohort storage refuses absent verified plan and current-run membership capabilities', (t) =>
{
    const options = storeFixture(t);
    assert.throws(() => createCohortStore({ root: options.root, identityPlan: candidateIdentity() }), /six-fragment/u);
    assert.throws(() => appendCohortStore({ ...options, ordinal: 1, runReceiptRef: member('first').runReceiptRef }), /current-run locator/u);
    assert.equal(readCohortStore(options).ledger.events.length, 0);
});

test('cohort storage creates atomically and only reuses an explicit matching unsealed ref', (t) =>
{
    const options = storeFixture(t);
    const input = { root: options.root, identityPlan: { unitContract: true }, verifyIdentityPlan: () => candidateIdentity(),
        instanceKey: 'qualification-a', createdAt: metadataTime };
    assert.throws(() => createCohortStore(input), /exist|not empty/u);
    const reused = createCohortStore({ ...input, reuse: { cohortId: options.cohortId, expectedDigest: options.expectedDigest } });
    assert.equal(reused.reused, true);
    assert.throws(() => createCohortStore({ ...input, verifyIdentityPlan: () => candidateIdentity({ imageDigest: otherDigest }),
        reuse: { cohortId: options.cohortId, expectedDigest: options.expectedDigest } }), /exact identity/u);
    assert.equal(fs.readdirSync(options.root).length, 1);
});

test('cohort storage performs compare-and-swap appends and retains its immutable root', (t) =>
{
    const options = storeFixture(t);
    const rootFile = path.join(options.root, options.cohortId.slice(7), 'identity.json');
    const beforeRoot = fs.readFileSync(rootFile);
    const firstMember = member('first');
    const first = appendCohortStore({ ...options, ordinal: 1, runReceiptRef: firstMember.runReceiptRef,
        readVerifiedRun: () => firstMember, addedAt: metadataTime });
    assert.throws(() => appendCohortStore({ ...options, ordinal: 2, runReceiptRef: member('second').runReceiptRef,
        readVerifiedRun: () => member('second'), addedAt: metadataTime }), /explicit expected digest/u);
    const second = appendCohortStore({ ...options, expectedDigest: first.contentDigest, ordinal: 2,
        runReceiptRef: member('second').runReceiptRef, readVerifiedRun: () => member('second'), addedAt: metadataTime });
    assert.equal(readCohortStore({ ...options, expectedDigest: second.contentDigest }).ledger.events.length, 2);
    assert.deepEqual(fs.readFileSync(rootFile), beforeRoot);
    const sealed = sealCohortStore({ ...options, expectedDigest: second.contentDigest, addedAt: metadataTime });
    assert.equal(readCohortStore({ ...options, expectedDigest: sealed.contentDigest }).inspected.sealed, true);
});

test('cohort storage leaves no partial object after a staged creation failure', (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-cohort-crash-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const originalWrite = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = function (...args)
    {
        if (++writes === 2)
        {
            throw new Error('injected ledger write failure');
        }
        return originalWrite.apply(this, args);
    };
    try
    {
        assert.throws(() => createCohortStore({ root, identityPlan: { unitContract: true }, verifyIdentityPlan: () => candidateIdentity(),
            instanceKey: 'qualification-a', createdAt: metadataTime }), /injected/u);
    }
    finally
    {
        fs.writeFileSync = originalWrite;
    }
    assert.deepEqual(fs.readdirSync(root), []);
});

test('cohort storage preserves a busy writer and refuses wrong locator symlink or root ref', (t) =>
{
    const options = storeFixture(t);
    const directory = path.join(options.root, options.cohortId.slice(7));
    const request = { ...options, ordinal: 1, runReceiptRef: member('one').runReceiptRef,
        readVerifiedRun: () => member('one'), addedAt: metadataTime };
    fs.mkdirSync(path.join(directory, '.writer'));
    assert.throws(() => appendCohortStore(request), /writer busy/u);
    assert.equal(fs.existsSync(path.join(directory, '.writer')), true);
    fs.rmdirSync(path.join(directory, '.writer'));
    assert.throws(() => appendCohortStore({ ...request, readVerifiedRun: () => member('foreign') }), /different explicit receipt ref/u);
    assert.equal(readCohortStore(options).ledger.events.length, 0);
    assert.throws(() => readCohortStore({ ...options, cohortId: testDigest }), /ENOENT/u);
    fs.renameSync(path.join(directory, 'ledger.json'), path.join(directory, 'original.json'));
    fs.symlinkSync('original.json', path.join(directory, 'ledger.json'));
    assert.throws(() => readCohortStore(options), /physical regular/u);
});

test('cohort concurrent physical writers preserve one CAS winner and permit explicit loser retry', async (t) =>
{
    const options = storeFixture(t);
    const storeUrl = new URL('../../tools/release-candidate/cohort-store.mjs', import.meta.url).href;
    const supportUrl = new URL('./release-candidate-test-support.mjs', import.meta.url).href;
    const provenanceUrl = new URL('../../tools/test/attempt-provenance.mjs', import.meta.url).href;
    const run = (id) => new Promise((resolve) =>
    {
        const script = `import { appendCohortStore } from ${JSON.stringify(storeUrl)};
import { candidateIdentity, testDigest } from ${JSON.stringify(supportUrl)};
import { digestCanonical } from ${JSON.stringify(provenanceUrl)};
const id = ${JSON.stringify(id)};
const m = { candidateIdentity: candidateIdentity(), runId: 'run-'+id, schedulerRunId: 'scheduler-'+id,
runtimeNamespace: 'namespace-'+id, freshCleanupReceiptDigest: digestCanonical({cleanup:id}),
runReceiptRef: {path:'runs/'+id+'/outcome.json',contentDigest:digestCanonical({run:id})},outcomeFingerprint:testDigest,membershipStatus:'failed'};
try { console.log(JSON.stringify(appendCohortStore({...${JSON.stringify(options)},ordinal:id === 'first' ? 1:2,
runReceiptRef:m.runReceiptRef,readVerifiedRun:()=>m,addedAt:${JSON.stringify(metadataTime)}}))); }
catch (error) { console.error(error.message); process.exitCode=1; }`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (bytes) =>
        {
            stdout += bytes;
        });
        child.stderr.on('data', (bytes) =>
        {
            stderr += bytes;
        });
        child.on('close', (code) => resolve({ id, code, stdout, stderr }));
    });
    const results = await Promise.all([run('first'), run('second')]);
    assert.deepEqual(results.map((value) => value.code).sort(), [0, 1]);
    const winner = results.find((value) => value.code === 0);
    const loser = results.find((value) => value.code === 1);
    assert.match(loser.stderr, /writer busy|explicit expected digest/u);
    const current = JSON.parse(winner.stdout);
    assert.equal(readCohortStore({ ...options, expectedDigest: current.contentDigest }).ledger.events.length, 1);
    const next = appendCohortStore({ ...options, expectedDigest: current.contentDigest, ordinal: loser.id === 'first' ? 1 : 2,
        runReceiptRef: member(loser.id).runReceiptRef, readVerifiedRun: () => member(loser.id), addedAt: metadataTime });
    assert.equal(readCohortStore({ ...options, expectedDigest: next.contentDigest }).ledger.events.length, 2);
});
