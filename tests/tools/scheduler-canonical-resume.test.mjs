import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const { findDiagnosticRecentRun, findLatestRunId, readCanonicalSchedulerCheckpoint, runDag } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const { RunEvidenceObjectStore } = await import(new URL('../../tools/test-matrix/content-addressed-evidence-store.mjs', import.meta.url));
const { digestValue } = await import(new URL('../../tools/release/browser-contract-receipt-contract.mjs', import.meta.url));
const { controlledSchedulerCandidate } = await import(new URL('./support/canonical-scheduler-fixture.mjs', import.meta.url));

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-canonical-resume-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'source.txt'), 'stable');
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'stable-fingerprint' };
    const snapshotWorktree = async () => ({ fingerprint: sourceState.worktreeFingerprint, entries: new Map() });
    let executions = 0;
    const options = { root, runsRoot: path.join(root, '.tmp/runs'), runId: 'canonical-run',
        targetTierId: 'ordinary', sourceState, snapshotWorktree, dynamicPriority: false,
        systemResources: { cpuCount: 2, availableMemoryGiB: 8, load1: 0 },
        currentFreeMemoryGiB: () => 8,
        tiers: [{ id: 'ordinary', command: `${process.execPath} -e "process.exit(0)"`,
            executionDependsOn: [], services: [], parallelizable: true, exclusiveResources: [],
            resourceClass: 'cpu', maxParallel: 1, cpuUnits: 1, memoryGiB: 0.01,
            cacheInputs: ['source.txt'], executionKey: 'ordinary', executionVariant: 'ordinary', coverage: [] }],
        executeTier: async () =>
        {
            executions += 1;
            return { code: 0, signal: null };
        } };
    return { root, options, executions: () => executions };
}

function resumeOptions(options, result)
{
    return { ...options, mode: 'resume', resume: true,
        resumeCandidateIdentityDigest: result.checkpoint.schedulerCandidateIdentityDigest };
}

test('canonical recovery refuses inflated, cross-run and damaged compatibility projections and repairs from objects', async (t) =>
{
    const current = fixture(t);
    const result = await runDag(current.options);
    assert.equal(result.status, 'success');
    const original = readCanonicalSchedulerCheckpoint(result.checkpointPath);
    assert.equal(original.projectionStatus, 'current');
    for (const bytes of [
        JSON.stringify({ ...result.checkpoint, runId: 'different-run', revision: 99999, status: 'failure' }),
        '{broken JSON'
    ])
    {
        fs.writeFileSync(result.checkpointPath, bytes);
        const recovered = readCanonicalSchedulerCheckpoint(result.checkpointPath, { repairProjection: true });
        assert.deepEqual(recovered.checkpoint, result.checkpoint);
        assert.match(recovered.projectionStatus, /^(drift|invalid)$/u);
        assert.equal(readCanonicalSchedulerCheckpoint(result.checkpointPath).projectionStatus, 'current');
    }
    fs.rmSync(result.checkpointPath);
    const recovered = readCanonicalSchedulerCheckpoint(result.checkpointPath, { repairProjection: true });
    assert.equal(recovered.projectionStatus, 'missing');
    assert.equal(recovered.checkpointDigest, original.checkpointDigest);
    const projection = JSON.parse(fs.readFileSync(result.checkpointPath, 'utf8'));
    assert.equal(projection.storeCheckpointRef, original.compactStateRef);
    assert.equal(projection.storeCheckpointDigest, original.compactDigest);
    assert.equal(projection.lastSequence, original.lastSequence);
    assert.match(projection.projectionDigest, /^sha256:[a-f0-9]{64}$/u);
});

test('canonical compact and journal damage fail closed with no compatibility fallback', async (t) =>
{
    const current = fixture(t);
    const result = await runDag(current.options);
    const storeRoot = path.join(result.runDirectory, 'evidence-store');
    const compactFile = path.join(storeRoot, 'checkpoints', `${result.runId}.json`);
    const compactBytes = fs.readFileSync(compactFile, 'utf8');
    const compact = JSON.parse(compactBytes);
    fs.writeFileSync(compactFile, JSON.stringify({ ...compact, contentDigest: `sha256:${'f'.repeat(64)}` }));
    assert.throws(() => readCanonicalSchedulerCheckpoint(result.checkpointPath), /compact checkpoint content digest mismatch/u);
    fs.writeFileSync(compactFile, compactBytes);
    const journalFile = path.join(storeRoot, 'journals', `${result.runId}.jsonl`);
    const journal = fs.readFileSync(journalFile, 'utf8').trim().split('\n');
    const event = JSON.parse(journal[0]);
    journal[0] = JSON.stringify({ ...event, status: 'forged-success' });
    fs.writeFileSync(journalFile, journal.join('\n') + '\n');
    assert.throws(() => readCanonicalSchedulerCheckpoint(result.checkpointPath), /journal content digest mismatch/u);
    await assert.rejects(runDag(resumeOptions(current.options, result)), /journal content digest mismatch/u);
    assert.equal(current.executions(), 1);
});

test('journal-only crash and journal tail after compact recover without trusting projection revisions', async (t) =>
{
    const current = fixture(t);
    const result = await runDag(current.options);
    const store = new RunEvidenceObjectStore({ root: path.join(result.runDirectory, 'evidence-store'),
        runId: result.runId, sourceState: result.checkpoint.sourceState });
    const next = { ...result.checkpoint, status: 'failure', revision: result.checkpoint.revision + 1 };
    next.contentDigest = digestValue(next);
    store.appendJournalEvent({ eventType: 'scheduler-state-updated', status: 'failure', payload: {
        operations: [{ kind: 'set', path: [], value: next }]
    } });
    assert.equal(readCanonicalSchedulerCheckpoint(result.checkpointPath).checkpoint.status, 'failure');
    fs.rmSync(path.join(store.checkpointsDirectory, `${result.runId}.json`));
    const recovered = readCanonicalSchedulerCheckpoint(result.checkpointPath, { repairProjection: true });
    assert.equal(recovered.checkpoint.status, 'failure');
    assert.equal(recovered.compactStateRef, null);
    assert.equal(recovered.lastSequence, store.readJournal().at(-1).sequence);
});

test('resume requires explicit run and candidate before tier spawn and never selects latest or fallback', async (t) =>
{
    const current = fixture(t);
    const result = await runDag(current.options);
    await assert.rejects(runDag({ ...current.options, mode: 'resume', runId: undefined }), /missing-resume-identity.*runId/u);
    await assert.rejects(runDag({ ...current.options, mode: 'resume' }), /missing-resume-identity.*candidateIdentityDigest/u);
    await assert.rejects(runDag({ ...resumeOptions(current.options, result), runId: '../canonical-run' }), /invalid-resume-identity/u);
    assert.throws(() => findLatestRunId(current.options.runsRoot, 'ordinary'), /automatic latest-run selection is forbidden/u);
    await assert.rejects(runDag({ ...resumeOptions(current.options, result), runId: 'absent-run' }), /missing-resume-run/u);
    await assert.rejects(runDag({ ...resumeOptions(current.options, result), targetTierId: 'other-tier' }), /resume-identity-mismatch: targetTierId/u);
    await assert.rejects(runDag({ ...resumeOptions(current.options, result),
        sourceState: { ...current.options.sourceState, worktreeFingerprint: 'changed' } }), /resume-identity-mismatch: sourceState/u);
    await assert.rejects(runDag({ ...resumeOptions(current.options, result),
        budgetPolicyDigest: `sha256:${'b'.repeat(64)}` }), /resume-identity-mismatch: budgetPolicyDigest/u);
    assert.equal(current.executions(), 1);
});

test('recent-run viewer stays diagnostic-only and cannot serve as a resume selector', async (t) =>
{
    const current = fixture(t);
    const first = await runDag(current.options);
    await runDag({ ...current.options, runId: 'other-run' });
    const diagnostic = findDiagnosticRecentRun(current.options.runsRoot, 'ordinary');
    assert.equal(diagnostic.runId, 'other-run');
    assert.equal(diagnostic.authority, 'diagnostic-only');
    assert.equal(diagnostic.qualificationEligible, false);
    await assert.rejects(runDag({ ...resumeOptions(current.options, first), runId: diagnostic }), /invalid-resume-identity/u);
    assert.equal(current.executions(), 2);
});

test('correctness resume requires full owner validation; missing candidate and true reuse override fail before spawn', async (t) =>
{
    const current = fixture(t);
    await assert.rejects(runDag({ ...current.options, reuseAcrossSourceChanges: true }), /cross-candidate-reuse-forbidden/u);
    const first = await runDag(current.options);
    await assert.rejects(runDag(resumeOptions(current.options, first)), /missing-resume-candidate-authority/u);
    assert.equal(current.executions(), 1);
});

test('owner-verified candidate payload binds reuse and rejects alias drift before execution', async (t) =>
{
    const current = fixture(t);
    // Controlled owner port only: this test does not stand in for the missing complete #1606 producer.
    const candidateIdentity = controlledSchedulerCandidate(current.options.sourceState);
    const options = { ...current.options, candidateIdentity, verifyCandidateIdentity: async (document) => document };
    const first = await runDag(options);
    const resumed = await runDag(resumeOptions(options, first));
    assert.equal(resumed.status, 'success');
    assert.deepEqual(resumed.reusedTiers, ['ordinary']);
    assert.deepEqual(resumed.checkpoint.resumeInvocation.selector, { kind: 'run-id', runId: 'canonical-run' });
    assert.equal(resumed.checkpoint.resumePolicy.reuseAcrossSourceChanges, false);
    const changed = { ...candidateIdentity, repositorySubmoduleOrAliasDigests: { ui: 'changed' } };
    await assert.rejects(runDag({ ...resumeOptions(options, resumed), candidateIdentity: changed }),
        /resume-identity-mismatch: releaseCandidateIdentity.repositorySubmoduleOrAliasDigests/u);
    assert.equal(current.executions(), 1);
});

test('real subprocess with controlled memory retains canonical persistence without qualification', async (t) =>
{
    const current = fixture(t);
    const options = { ...current.options };
    delete options.executeTier;
    const result = await runDag(options);
    assert.equal(result.status, 'success');
    assert.equal(result.checkpoint.authoritative, false);
    assert.equal(result.checkpoint.tiers.ordinary.exitCode, 0);
    assert.equal(readCanonicalSchedulerCheckpoint(result.checkpointPath).projectionStatus, 'current');
});
