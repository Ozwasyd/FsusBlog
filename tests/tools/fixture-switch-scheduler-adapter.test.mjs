import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { fixture: receiptFixture } = await import(new URL('./support/correctness-terminal-fixture.mjs', import.meta.url));
const { controlledSchedulerCandidate, writeCanonicalSchedulerFixture } = await import(new URL('./support/canonical-scheduler-fixture.mjs', import.meta.url));
const { commitSchedulerCheckpointCAS, readCanonicalSchedulerCheckpoint } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const { finalizeSchedulerCorrectness } = await import(new URL('../../tools/test-matrix/scheduler-correctness-finalizer.mjs', import.meta.url));
const { acquireSchedulerRunLock, schedulerCandidateIdentityDigest } = await import(new URL('../../tools/test-matrix/scheduler-run-owner.mjs', import.meta.url));
const { bindFixtureSwitchSchedulerSourceEvidence, readFixtureSwitchSchedulerObservation } = await import(new URL('../../tools/test-matrix/fixture-switch-scheduler-adapter.mjs', import.meta.url));
const { switchMaterials } = await import(new URL('./support/fixture-matrix-evidence-fixture.mjs', import.meta.url));
const { buildFixtureSwitchEvidence } = await import(new URL('../../tools/test-matrix/fixture-switch-evidence.mjs', import.meta.url));

// Real owner/store/CAS APIs with controlled domain inputs. These controls do not qualify a provider runtime.
function setup(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-switch-scheduler-'));
    const material = receiptFixture();
    const runsRoot = path.join(root, '.tmp/test-runs');
    const runDirectory = path.join(runsRoot, material.context.runId);
    const checkpointFile = path.join(runDirectory, 'checkpoint.json');
    const attemptRoot = path.join(runDirectory, 'correctness-attempts', material.context.targetAttemptId);
    fs.mkdirSync(attemptRoot, { recursive: true });
    const packetFile = path.join(attemptRoot, 'provisional-packet.json');
    fs.writeFileSync(packetFile, JSON.stringify({ context: material.context, provisional: material.provisional }));
    const candidate = schedulerCandidateIdentityDigest({ runId: material.context.runId,
        targetTierId: 'production-correctness', namespace: 'test-matrix', sourceState: material.context.sourceState });
    const owner = acquireSchedulerRunLock({ runsRoot, runId: material.context.runId,
        targetTierId: 'production-correctness', candidateIdentityDigest: candidate });
    owner.markRunning();
    owner.markFinalizing();
    t.after(() =>
    {
        if (fs.existsSync(owner.lockPath))
        {
            owner.finalize('failed');
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const checkpoint = { ...material.snapshots.before.checkpoint, status: 'success',
        targetTierId: 'production-correctness', namespace: 'test-matrix', budgetPolicyDigest: null,
        schedulerCandidateIdentityDigest: candidate, schedulerRunOwnerToken: owner.owner.ownerToken,
        releaseCandidateIdentity: controlledSchedulerCandidate(material.context.sourceState, material.context.buildReceiptDigest),
        candidateIdentityValidated: true,
        correctnessAttempt: { targetAttemptId: material.context.targetAttemptId, root: attemptRoot,
            provisionalPacketFile: packetFile, createdFromCheckpointRevision: material.context.createdFromCheckpointRevision,
            status: 'running', previousAttemptId: null },
        currentRunEvidenceReferences: { attemptId: material.context.dependencyAttemptIds.unit,
            references: [{ consumerId: 'unit', contentDigest: material.context.dependencyTerminalReceipts[0].reference.digest }] },
        tiers: { ...material.snapshots.before.checkpoint.tiers, unit: { status: 'success' } } };
    const { store } = writeCanonicalSchedulerFixture(checkpointFile, checkpoint);
    const expected = () =>
    {
        const canonical = readCanonicalSchedulerCheckpoint(checkpointFile);
        return { runId: material.context.runId, sourceState: material.context.sourceState,
            buildReceiptDigest: material.context.buildReceiptDigest, targetAttemptId: material.context.targetAttemptId,
            checkpointDigest: canonical.checkpointDigest, lastSequence: canonical.lastSequence };
    };
    return { checkpointFile, expected, owner, store };
}

test('reads exact canonical sequence and attempt without repairing the derived projection or appending evidence', async (t) =>
{
    const current = setup(t);
    const projection = fs.readFileSync(current.checkpointFile, 'utf8');
    const sequence = current.store.readJournal().length;
    const result = await readFixtureSwitchSchedulerObservation({ checkpointFile: current.checkpointFile, expected: current.expected() });
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.terminal, null);
    assert.deepEqual(result.binding, current.expected());
    assert.equal(current.store.readJournal().length, sequence);
    assert.equal(fs.readFileSync(current.checkpointFile, 'utf8'), projection);
});

test('consumes actual completed owner/current finalizer receipt while retaining source-stage qualification gaps', async (t) =>
{
    const current = setup(t);
    const final = await finalizeSchedulerCorrectness({ checkpointFile: current.checkpointFile,
        owner: current.owner.owner, readCanonical: readCanonicalSchedulerCheckpoint,
        commit: commitSchedulerCheckpointCAS, requiredDependencyTierIds: ['unit'], postflight: async () =>
        {} });
    current.owner.finalize('complete');
    const sequence = current.store.readJournal().length;
    const result = await readFixtureSwitchSchedulerObservation({ checkpointFile: current.checkpointFile,
        expected: current.expected(), requireTerminal: true });
    assert.equal(result.terminal.receipt.contentDigest, final.receipt.contentDigest);
    assert.deepEqual(result.terminal.finalizedCheckpoint, result.checkpoint);
    assert.equal(result.qualificationEligible, false);
    assert.equal(current.store.readJournal().length, sequence);
});

test('an unfinished current attempt remains unavailable for terminal consumption', async (t) =>
{
    const current = setup(t);
    await assert.rejects(readFixtureSwitchSchedulerObservation({ checkpointFile: current.checkpointFile,
        expected: current.expected(), requireTerminal: true }), /current-seal-unqualified/u);
});

test('links recomputed source sequence materials to actual canonical source references without admitting lifecycle phases', async (t) =>
{
    const inputs = switchMaterials();
    const context = inputs.plan.context;
    const sourceState = { commit: context.source.commit,
        worktreeFingerprint: context.source.worktreeFingerprint.slice('sha256:'.length) };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-switch-source-binding-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const checkpointFile = path.join(root, context.runId, 'checkpoint.json');
    const { store } = writeCanonicalSchedulerFixture(checkpointFile, { runId: context.runId, sourceState,
        releaseCandidateIdentity: controlledSchedulerCandidate(sourceState, context.buildDigest),
        correctnessAttempt: { targetAttemptId: 'switch-source-attempt' } });
    const canonical = readCanonicalSchedulerCheckpoint(checkpointFile);
    const expected = { runId: context.runId, sourceState, buildReceiptDigest: context.buildDigest,
        targetAttemptId: 'switch-source-attempt', checkpointDigest: canonical.checkpointDigest,
        lastSequence: canonical.lastSequence };
    const sequence = store.readJournal().length;
    const observation = await readFixtureSwitchSchedulerObservation({ checkpointFile, expected });
    const evidence = buildFixtureSwitchEvidence(inputs);
    const binding = await bindFixtureSwitchSchedulerSourceEvidence({ observation, evidence, inputs });
    assert.equal(binding.schedulerObservationDigest, observation.contentDigest);
    assert.equal(binding.switchEvidenceDigest, evidence.contentDigest);
    assert.equal(binding.qualificationEligible, false);
    assert.equal(store.readJournal().length, sequence);
});
