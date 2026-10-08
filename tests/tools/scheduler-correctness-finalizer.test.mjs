import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const { fixture: receiptFixture, seal } = await import(new URL('./support/correctness-terminal-fixture.mjs', import.meta.url));
const { controlledSchedulerCandidate, writeCanonicalSchedulerFixture } = await import(new URL('./support/canonical-scheduler-fixture.mjs', import.meta.url));
const { commitSchedulerCheckpointCAS, readCanonicalSchedulerCheckpoint, runDag } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const { finalizeSchedulerCorrectness, readCurrentSchedulerCorrectness } = await import(new URL('../../tools/test-matrix/scheduler-correctness-finalizer.mjs', import.meta.url));
const { acquireSchedulerRunLock, schedulerCandidateIdentityDigest } = await import(new URL('../../tools/test-matrix/scheduler-run-owner.mjs', import.meta.url));
const { CorrectnessTerminalSealJournal } = await import(new URL('../../tools/release/correctness-terminal-seal-journal.mjs', import.meta.url));
const { publishCorrectnessProvisional } = await import(new URL('../../tools/release/test-evidence-receipts-cli.mjs', import.meta.url));

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-terminal-finalizer-'));
    let controller;
    t.after(() =>
    {
        if (controller && fs.existsSync(controller.lockPath))
        {
            controller.finalize('failed');
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const material = receiptFixture();
    const runsRoot = path.join(root, '.tmp/test-runs');
    const runDirectory = path.join(runsRoot, material.context.runId);
    const checkpointFile = path.join(runDirectory, 'checkpoint.json');
    const attemptRoot = path.join(runDirectory, 'correctness-attempts', material.context.targetAttemptId);
    fs.mkdirSync(attemptRoot, { recursive: true });
    const packetFile = path.join(attemptRoot, 'provisional-packet.json');
    const packetBytes = JSON.stringify({ context: material.context, provisional: material.provisional }) + '\n';
    fs.writeFileSync(packetFile, packetBytes, { flag: 'wx' });
    const candidate = schedulerCandidateIdentityDigest({ runId: material.context.runId,
        targetTierId: 'production-correctness', namespace: 'test-matrix', sourceState: material.context.sourceState });
    // Real current-process owner/append-only store/CAS; domain inputs remain explicitly controlled source fixtures.
    controller = acquireSchedulerRunLock({ runsRoot, runId: material.context.runId,
        targetTierId: 'production-correctness', candidateIdentityDigest: candidate });
    controller.markRunning();
    controller.markFinalizing();
    const checkpoint = { ...material.snapshots.before.checkpoint, status: 'success',
        targetTierId: 'production-correctness', namespace: 'test-matrix', budgetPolicyDigest: null,
        schedulerCandidateIdentityDigest: candidate, schedulerRunOwnerToken: controller.owner.ownerToken,
        releaseCandidateIdentity: controlledSchedulerCandidate(material.context.sourceState, material.context.buildReceiptDigest),
        candidateIdentityValidated: true,
        correctnessAttempt: { targetAttemptId: material.context.targetAttemptId, root: attemptRoot,
            provisionalPacketFile: packetFile, createdFromCheckpointRevision: material.context.createdFromCheckpointRevision,
            status: 'running', previousAttemptId: null },
        currentRunEvidenceReferences: { attemptId: material.context.dependencyAttemptIds.unit,
            references: [{ consumerId: 'unit', contentDigest: material.context.dependencyTerminalReceipts[0].reference.digest }] },
        tiers: { ...material.snapshots.before.checkpoint.tiers, unit: { status: 'success' } } };
    const { store } = writeCanonicalSchedulerFixture(checkpointFile, checkpoint);
    return { root, runsRoot, checkpointFile, packetFile, packetBytes, material, controller, store,
        options: { checkpointFile, owner: controller.owner, readCanonical: readCanonicalSchedulerCheckpoint,
            commit: commitSchedulerCheckpointCAS, requiredDependencyTierIds: ['unit'], postflight: async () =>
            {} } };
}

function prepareCurrentReverseChild(current)
{
    const parent = readCanonicalSchedulerCheckpoint(current.checkpointFile);
    const before = { ref: parent.checkpointDigest, checkpoint: parent.checkpoint };
    const inputs = { context: current.material.context, provisional: current.material.provisional,
        snapshots: { before, after: structuredClone(before), expected: {
            ...current.material.snapshots.expected, checkpointRevision: parent.checkpoint.revision,
            checkpointDigest: parent.checkpointDigest } },
        aggregateTerminalReceipt: seal({ ...current.material.aggregateTerminalReceipt,
            terminalCheckpointRef: parent.checkpointDigest, commandExitCode: 0, outcomeValidated: true }),
        finalizedAt: current.material.finalizedAt };
    const journal = new CorrectnessTerminalSealJournal({ store: current.store,
        targetAttemptId: current.material.context.targetAttemptId });
    const prepared = journal.prepare(inputs);
    const packet = journal.readPacket(prepared.packetRef);
    const final = current.store.publishObject(packet.receipt);
    const child = commitSchedulerCheckpointCAS({ checkpointFile: current.checkpointFile,
        expectedRevision: parent.checkpoint.revision, expectedDigest: parent.checkpointDigest,
        owner: current.controller.owner, update(checkpoint)
        {
            checkpoint.correctnessSealPacketRef = prepared.packetRef;
            checkpoint.correctnessFinalReceiptObjectRef = final.digest;
            checkpoint.correctnessAttempt.status = 'finalized';
            checkpoint.correctnessTerminalSeal = { status: 'finalized', runId: checkpoint.runId,
                targetTierId: 'production-correctness', targetAttemptId: current.material.context.targetAttemptId,
                terminalParentRef: parent.checkpointDigest, finalReceiptRef: packet.receipt.contentDigest,
                finalReceiptDigest: packet.receipt.contentDigest };
        } });
    return { journal, packet, prepared, child };
}

test('scheduler finalizer commits real immutable final and reverse child exactly once under current owner', async (t) =>
{
    const current = fixture(t);
    const stages = [];
    const result = await finalizeSchedulerCorrectness({ ...current.options, faultInjector: (stage) => stages.push(stage) });
    assert.equal(result.status, 'finalized');
    assert.equal(result.receipt.producerAuthority, 'scheduler-terminal-finalizer');
    assert.equal(result.checkpoint.revision, current.material.snapshots.before.checkpoint.revision + 2);
    assert.deepEqual(stages, ['terminal-committed', 'prepared', 'final-object-written', 'reverse-committed']);
    assert.equal(fs.readFileSync(current.packetFile, 'utf8'), current.packetBytes);
    assert.throws(() => readCurrentSchedulerCorrectness({ checkpointFile: current.checkpointFile,
        readCanonical: readCanonicalSchedulerCheckpoint }), /ENOENT/u);
    assert.equal(current.controller.finalize('complete'), true);
    const read = () => readCurrentSchedulerCorrectness({ checkpointFile: current.checkpointFile,
        readCanonical: readCanonicalSchedulerCheckpoint });
    assert.equal(read().receipt.contentDigest, result.receipt.contentDigest);
    const sequence = current.store.readJournal().length;
    assert.equal(read().receipt.contentDigest, result.receipt.contentDigest);
    assert.equal(current.store.readJournal().length, sequence);
    const canonical = readCanonicalSchedulerCheckpoint(current.checkpointFile);
    assert.equal(canonical.checkpoint.correctnessTerminalSeal.finalReceiptDigest, result.receipt.contentDigest);
});

test('same active owner retries an already finalized current attempt without a new CAS or journal event', async (t) =>
{
    const current = fixture(t);
    const first = await finalizeSchedulerCorrectness(current.options);
    const canonical = readCanonicalSchedulerCheckpoint(current.checkpointFile);
    const sequence = current.store.readJournal().length;
    fs.rmSync(current.packetFile);
    const retried = await finalizeSchedulerCorrectness({ ...current.options,
        loadProvisional: () => assert.fail('retry must use immutable prepared packet'),
        commit: () => assert.fail('retry must not create a new terminal parent') });
    assert.equal(retried.receipt.contentDigest, first.receipt.contentDigest);
    assert.equal(retried.packetRef, first.packetRef);
    assert.equal(readCanonicalSchedulerCheckpoint(current.checkpointFile).checkpointDigest, canonical.checkpointDigest);
    assert.equal(current.store.readJournal().length, sequence);
    assert.equal(current.controller.finalize('complete'), true);
    assert.equal(readCurrentSchedulerCorrectness({ checkpointFile: current.checkpointFile,
        readCanonical: readCanonicalSchedulerCheckpoint }).receipt.contentDigest, first.receipt.contentDigest);
});

test('active owner completes only the explicit prepared current reverse child and recovery is idempotent', async (t) =>
{
    const current = fixture(t);
    // Controlled domain setup, real store/owner/CAS: no killed-owner transfer or physical crash qualification.
    const prepared = prepareCurrentReverseChild(current);
    assert.equal(prepared.journal.state().record.status, 'prepared');
    const sequence = current.store.readJournal().length;
    let postflights = 0;
    const options = { ...current.options, loadProvisional: () => assert.fail('must not rerun provisional producer'),
        commit: () => assert.fail('must not mint another terminal parent'), postflight: async () =>
        {
            postflights += 1;
        } };
    const recovered = await finalizeSchedulerCorrectness(options);
    assert.equal(recovered.receipt.contentDigest, prepared.packet.receipt.contentDigest);
    assert.equal(recovered.packetRef, prepared.prepared.packetRef);
    assert.equal(readCanonicalSchedulerCheckpoint(current.checkpointFile).checkpointDigest, prepared.child.checkpointDigest);
    assert.equal(prepared.journal.state().record.status, 'finalized');
    assert.equal(current.store.readJournal().length, sequence + 1);
    await finalizeSchedulerCorrectness(options);
    assert.equal(postflights, 2);
    assert.equal(current.store.readJournal().length, sequence + 1);
});

test('current seal recovery rejects history, failed postflight, dependency drift and lost owner without finalizing', async (t) =>
{
    for (const kind of ['rejected', 'packet-ref', 'dependency-attempt', 'postflight', 'canonical-drift', 'inactive-owner'])
    {
        const current = fixture(t);
        const prepared = prepareCurrentReverseChild(current);
        const options = { ...current.options, commit: () => assert.fail('recovery must not use CAS') };
        if (kind === 'rejected')
        {
            prepared.journal.reject({ packetRef: prepared.prepared.packetRef, reasonCode: 'prior-refusal' });
        }
        else if (['packet-ref', 'dependency-attempt'].includes(kind))
        {
            const checkpoint = readCanonicalSchedulerCheckpoint(current.checkpointFile).checkpoint;
            if (kind === 'packet-ref')
            {
                checkpoint.correctnessSealPacketRef = `sha256:${'e'.repeat(64)}`;
            }
            else
            {
                checkpoint.currentRunEvidenceReferences.attemptId = 'old-attempt';
            }
            writeCanonicalSchedulerFixture(current.checkpointFile, checkpoint);
        }
        else if (kind === 'postflight')
        {
            options.postflight = async () =>
            {
                throw new Error('recovery postflight refused');
            };
        }
        else if (kind === 'canonical-drift')
        {
            options.postflight = async () =>
            {
                const checkpoint = readCanonicalSchedulerCheckpoint(current.checkpointFile).checkpoint;
                checkpoint.failure = { reason: 'different canonical state' };
                writeCanonicalSchedulerFixture(current.checkpointFile, checkpoint);
            };
        }
        else
        {
            current.controller.finalize('failed');
        }
        const sequence = current.store.readJournal().length;
        await assert.rejects(finalizeSchedulerCorrectness(options),
            /not-current-or-rejected|dependency-not-terminal|postflight refused|canonical-drift|owner-not-active/u, kind);
        const events = current.store.readJournal().filter((event) => event.eventType === 'correctness-terminal-seal');
        assert.equal(events.some((event) => event.status === 'finalized'), false, kind);
        assert.equal(current.store.readJournal().length, sequence + (kind === 'canonical-drift' ? 1 : 0), kind);
    }
});

test('canonical CAS refuses stale revisions/digests/wrong owner and identity drift before mutation publication', (t) =>
{
    const current = fixture(t);
    const canonical = readCanonicalSchedulerCheckpoint(current.checkpointFile);
    const options = { checkpointFile: current.checkpointFile, expectedRevision: canonical.checkpoint.revision,
        expectedDigest: canonical.checkpointDigest, owner: current.controller.owner, update: () => assert.fail('must not update') };
    assert.throws(() => commitSchedulerCheckpointCAS({ ...options, expectedRevision: 999 }), /cas-conflict/u);
    assert.throws(() => commitSchedulerCheckpointCAS({ ...options, expectedDigest: `sha256:${'f'.repeat(64)}` }), /cas-conflict/u);
    assert.throws(() => commitSchedulerCheckpointCAS({ ...options, owner: { ownerToken: 'foreign' } }), /cas-owner-mismatch/u);
    assert.throws(() => commitSchedulerCheckpointCAS({ ...options, update: (checkpoint) =>
    {
        checkpoint.runId = 'foreign';
    } }),
    /cas-identity-drift/u);
    assert.equal(readCanonicalSchedulerCheckpoint(current.checkpointFile).checkpointDigest, canonical.checkpointDigest);
});

for (const failureStage of ['prepared', 'final-object-written', 'reverse-committed'])
{
    test(`scheduler seal failure at ${failureStage} leaves rejected history and no current qualified receipt`, async (t) =>
    {
        const current = fixture(t);
        const failure = new Error('original persistence refusal');
        await assert.rejects(finalizeSchedulerCorrectness({ ...current.options, faultInjector(stage)
        {
            if (stage === failureStage)
            {
                throw failure;
            }
        } }), (error) => error === failure);
        const journal = new CorrectnessTerminalSealJournal({ store: current.store,
            targetAttemptId: current.material.context.targetAttemptId });
        assert.equal(journal.state().record.status, 'rejected');
        assert.throws(() => journal.resolve({ packetRef: journal.state().record.packetRef }), /no consumable/u);
        current.controller.finalize('failed');
        assert.throws(() => readCurrentSchedulerCorrectness({ checkpointFile: current.checkpointFile,
            readCanonical: readCanonicalSchedulerCheckpoint }), /current-seal-unqualified|owner-not-complete/u);
        assert.equal(fs.readFileSync(current.packetFile, 'utf8'), current.packetBytes);
    });
}

test('postflight and current dependency attempt/ref drift cannot seal a terminal-looking aggregate', async (t) =>
{
    const current = fixture(t);
    await assert.rejects(finalizeSchedulerCorrectness({ ...current.options, postflight: async () =>
    {
        throw new Error('postflight refused');
    } }), /postflight refused/u);
    const checkpoint = readCanonicalSchedulerCheckpoint(current.checkpointFile).checkpoint;
    checkpoint.currentRunEvidenceReferences.attemptId = 'old-attempt';
    writeCanonicalSchedulerFixture(current.checkpointFile, checkpoint);
    await assert.rejects(finalizeSchedulerCorrectness(current.options), /dependency-not-terminal/u);
    assert.equal(current.store.readJournal().filter((event) => event.eventType === 'correctness-terminal-seal').length, 0);
});

test('aggregate CLI publishes only explicit current-attempt provisional and cannot overwrite or upgrade it', (t) =>
{
    const current = fixture(t);
    fs.rmSync(current.packetFile);
    const checkpoint = readCanonicalSchedulerCheckpoint(current.checkpointFile).checkpoint;
    checkpoint.status = 'running';
    writeCanonicalSchedulerFixture(current.checkpointFile, checkpoint);
    const contextFile = path.join(current.root, 'provisional-context.json');
    fs.writeFileSync(contextFile, JSON.stringify(current.material.context));
    const env = { FSUSBLOG_TEST_RUN_ID: current.material.context.runId,
        FSUSBLOG_CORRECTNESS_TARGET_ATTEMPT_ID: current.material.context.targetAttemptId,
        FSUSBLOG_CORRECTNESS_PROVISIONAL_PACKET: current.packetFile };
    const result = publishCorrectnessProvisional(contextFile, { repositoryRoot: current.root, env });
    assert.equal(result.provisional.status, 'provisional');
    assert.equal(result.provisional.qualificationEligible, false);
    const bytes = fs.readFileSync(current.packetFile, 'utf8');
    publishCorrectnessProvisional(contextFile, { repositoryRoot: current.root, env });
    assert.equal(fs.readFileSync(current.packetFile, 'utf8'), bytes);
    assert.throws(() => publishCorrectnessProvisional(contextFile, { repositoryRoot: current.root,
        env: { ...env, FSUSBLOG_CORRECTNESS_TARGET_ATTEMPT_ID: 'foreign-attempt' } }), /attempt-mismatch/u);
    fs.writeFileSync(contextFile, JSON.stringify({ ...current.material.context, jobSummaryRefs: ['foreign'] }));
    assert.throws(() => publishCorrectnessProvisional(contextFile, { repositoryRoot: current.root, env }), /correctness provisional/u);
    assert.equal(fs.readFileSync(current.packetFile, 'utf8'), bytes);
});

test('real aggregate subprocess with controlled telemetry reaches the scheduler finalizer and remains unqualified', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-real-terminal-refusal-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const options = { root, runsRoot: path.join(root, '.tmp/test-runs'), runId: 'actual-aggregate',
        targetTierId: 'production-correctness', sourceState, dynamicPriority: false,
        snapshotWorktree: async () => ({ fingerprint: sourceState.worktreeFingerprint, entries: new Map() }),
        systemResources: { cpuCount: 2, availableMemoryGiB: 4, load1: 0 }, currentFreeMemoryGiB: () => 4,
        tiers: [{ id: 'production-correctness', command: `${process.execPath} -e "process.exit(0)"`,
            executionDependsOn: [], services: [], parallelizable: true, exclusiveResources: [],
            resourceClass: 'cpu', maxParallel: 1, cpuUnits: 1, memoryGiB: 0.01,
            cacheInputs: [], executionKey: 'production-correctness', executionVariant: 'ordinary', coverage: [] }] };
    await assert.rejects(runDag(options), /correctness-terminal-ineligible/u);
    const file = path.join(options.runsRoot, options.runId, 'checkpoint.json');
    const canonical = readCanonicalSchedulerCheckpoint(file);
    assert.equal(canonical.checkpoint.authoritative, false);
    assert.equal(canonical.checkpoint.status, 'failure');
    assert.equal(canonical.checkpoint.tiers['production-correctness'].commandExitCode, 0);
    assert.equal(canonical.checkpoint.correctnessAttempt.status, 'rejected');
    assert.match(canonical.checkpoint.correctnessAttempt.targetAttemptId, /^correctness-attempt-/u);
    assert.throws(() => readCurrentSchedulerCorrectness({ checkpointFile: file,
        readCanonical: readCanonicalSchedulerCheckpoint }), /current-seal-unqualified/u);
    await assert.rejects(runDag(options), /correctness-fresh-run-already-exists/u);
    assert.equal(fs.existsSync(canonical.checkpoint.correctnessAttempt.root), true);
});
