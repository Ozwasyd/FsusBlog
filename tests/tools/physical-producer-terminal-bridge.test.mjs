import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { compileProductionSummaryTopology, projectCurrentProductionSummary, validateProductionSummaryDeclaration } = await import(new URL('../../tools/test-matrix/physical-producer-terminal-bridge.mjs', import.meta.url));
const { finalizeSchedulerCorrectness } = await import(new URL('../../tools/test-matrix/scheduler-correctness-finalizer.mjs', import.meta.url));
const { commitSchedulerCheckpointCAS, readCanonicalSchedulerCheckpoint } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const { acquireSchedulerRunLock, schedulerCandidateIdentityDigest } = await import(new URL('../../tools/test-matrix/scheduler-run-owner.mjs', import.meta.url));
const { fixture: receiptFixture } = await import(new URL('./support/correctness-terminal-fixture.mjs', import.meta.url));
const { controlledSchedulerCandidate, writeCanonicalSchedulerFixture } = await import(new URL('./support/canonical-scheduler-fixture.mjs', import.meta.url));

function summary()
{
    return { id: 'production', executionMode: 'summary', commandKind: 'projection', projectFrom: 'production-correctness' };
}

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-terminal-bridge-'));
    const material = receiptFixture();
    const context = material.context;
    const runsRoot = path.join(root, 'runs');
    const runDirectory = path.join(runsRoot, context.runId);
    const checkpointFile = path.join(runDirectory, 'checkpoint.json');
    const attemptRoot = path.join(runDirectory, 'correctness-attempts', context.targetAttemptId);
    fs.mkdirSync(attemptRoot, { recursive: true });
    const packetFile = path.join(attemptRoot, 'provisional-packet.json');
    fs.writeFileSync(packetFile, JSON.stringify({ context, provisional: material.provisional }));
    const candidate = schedulerCandidateIdentityDigest({ runId: context.runId,
        targetTierId: context.targetTierId, namespace: 'test-matrix', sourceState: context.sourceState });
    const controller = acquireSchedulerRunLock({ runsRoot, runId: context.runId,
        targetTierId: context.targetTierId, candidateIdentityDigest: candidate });
    t.after(() =>
    {
        if (fs.existsSync(controller.lockPath))
        {
            controller.finalize('failed');
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    controller.markRunning();
    controller.markFinalizing();
    const checkpoint = { ...material.snapshots.before.checkpoint, status: 'success',
        targetTierId: context.targetTierId, namespace: 'test-matrix', budgetPolicyDigest: null,
        schedulerCandidateIdentityDigest: candidate, schedulerRunOwnerToken: controller.owner.ownerToken,
        releaseCandidateIdentity: controlledSchedulerCandidate(context.sourceState, context.buildReceiptDigest),
        candidateIdentityValidated: true,
        correctnessAttempt: { targetAttemptId: context.targetAttemptId, root: attemptRoot,
            provisionalPacketFile: packetFile, createdFromCheckpointRevision: context.createdFromCheckpointRevision,
            status: 'running', previousAttemptId: null },
        currentRunEvidenceReferences: { attemptId: context.dependencyAttemptIds.unit,
            references: [{ consumerId: 'unit', contentDigest: context.dependencyTerminalReceipts[0].reference.digest }] },
        tiers: { ...material.snapshots.before.checkpoint.tiers, unit: { status: 'success' } } };
    const { store } = writeCanonicalSchedulerFixture(checkpointFile, checkpoint);
    const expected = {
        runId: context.runId, targetAttemptId: context.targetAttemptId, sourceState: context.sourceState,
        buildReceiptDigest: context.buildReceiptDigest, terminalReceiptDigest: material.receipt.contentDigest,
        canonicalCheckpointDigest: readCanonicalSchedulerCheckpoint(checkpointFile).checkpointDigest
    };
    const input = { tier: summary(), checkpointFile, expected };
    return { input, controller, store, checkpoint, async finalize()
    {
        const result = await finalizeSchedulerCorrectness({ checkpointFile, owner: controller.owner,
            readCanonical: readCanonicalSchedulerCheckpoint, commit: commitSchedulerCheckpointCAS,
            requiredDependencyTierIds: ['unit'], postflight: async () =>
            {} });
        controller.finalize('complete');
        expected.terminalReceiptDigest = result.receipt.contentDigest;
        expected.canonicalCheckpointDigest = readCanonicalSchedulerCheckpoint(checkpointFile).checkpointDigest;
        return result;
    } };
}

test('production summary observation has one terminal source and no physical spawn', () =>
{
    const tier = summary();
    const topology = compileProductionSummaryTopology({ tiers: [tier], physicalProducerIds: ['arbitrary-worker'] });
    assert.equal(topology.spawnEligibility, false);
    assert.equal(topology.evidenceSchema, 'fsusblog.browserless-correctness-receipt.v2');
    assert.equal(topology.projectionSource, 'production-correctness');
    assert.equal(topology.qualificationEligible, false);
    assert.deepEqual(tier, summary());
});

test('producer receipt command and noop cannot enter a production summary', () =>
{
    for (const command of ['tools/test/lanes/production-correctness-receipt.sh', 'true'])
    {
        assert.throws(() => validateProductionSummaryDeclaration({ ...summary(), command }), /command-free/u);
    }
    assert.throws(() => validateProductionSummaryDeclaration({ ...summary(), executionMode: 'execute' }), /command-free/u);
});

test('all resource fixture execution and attempt fields are rejected even when empty', () =>
{
    for (const field of ['services', 'serviceDependencies', 'exclusiveResources', 'resources', 'resourceClass',
        'cpuUnits', 'memoryGiB', 'maxParallel', 'parallelizable', 'timeoutMinutes', 'timeoutMs',
        'fixtureProfile', 'fixtureBootstrap', 'executionKey', 'executionVariant',
        'resourceContractRef', 'spawnEligibility', 'producerId', 'attemptPolicyId'])
    {
        assert.throws(() => validateProductionSummaryDeclaration({ ...summary(), [field]: [] }), /command-free/u);
    }
});

test('missing duplicate wrong-source and physical production declarations fail closed', () =>
{
    for (const tiers of [[], [summary(), summary()]])
    {
        assert.throws(() => compileProductionSummaryTopology({ tiers, physicalProducerIds: [] }), /exact-one/u);
    }
    for (const projectFrom of ['other', ['production-correctness']])
    {
        assert.throws(() => validateProductionSummaryDeclaration({ ...summary(), projectFrom }), /command-free/u);
    }
    assert.throws(() => compileProductionSummaryTopology({ tiers: [summary()], physicalProducerIds: ['production'] }), /physical/u);
    assert.throws(() => compileProductionSummaryTopology({ tiers: [summary()], physicalProducerIds: ['worker', 'worker'] }), /exact-one/u);
});

test('native canonical terminal success projects idempotently without a seal write or attempt', async (t) =>
{
    const current = fixture(t);
    const finalized = await current.finalize();
    const sequence = current.store.readJournal().length;
    const before = structuredClone(current.input);
    const projection = projectCurrentProductionSummary(current.input);
    assert.equal(projection.status, 'success');
    assert.equal(projection.spawnEligibility, false);
    assert.equal(projection.qualificationEligible, false);
    assert.equal(projection.terminalReceiptDigest, finalized.receipt.contentDigest);
    assert.deepEqual(projectCurrentProductionSummary(current.input), projection);
    assert.deepEqual(current.input, before);
    assert.equal(current.store.readJournal().length, sequence);
    assert.equal(current.store.readJournal().filter((event) => event.eventType === 'correctness-terminal-seal'
        && event.status === 'finalized').length, 1);
});

test('running provisional and missing terminal seal cannot project success', (t) =>
{
    const current = fixture(t);
    assert.throws(() => projectCurrentProductionSummary(current.input), /current-seal-unqualified/u);
    assert.throws(() => projectCurrentProductionSummary({ ...current.input,
        checkpointFile: path.join(path.dirname(current.input.checkpointFile), 'missing', 'checkpoint.json') }), /checkpoint binding/u);
});

test('failed cancelled and timed-out canonical runs cannot project success', async (t) =>
{
    const current = fixture(t);
    await current.finalize();
    for (const status of ['failed', 'cancelled', 'timed-out', 'running'])
    {
        const checkpoint = structuredClone(readCanonicalSchedulerCheckpoint(current.input.checkpointFile).checkpoint);
        checkpoint.status = status;
        writeCanonicalSchedulerFixture(current.input.checkpointFile, checkpoint);
        current.input.expected.canonicalCheckpointDigest = readCanonicalSchedulerCheckpoint(current.input.checkpointFile).checkpointDigest;
        assert.throws(() => projectCurrentProductionSummary(current.input), /current-seal-unqualified/u);
    }
});

test('other run attempt source build receipt and checkpoint bindings are rejected', async (t) =>
{
    const current = fixture(t);
    await current.finalize();
    const badValues = { runId: 'other-run', targetAttemptId: 'other-attempt',
        sourceState: { ...current.input.expected.sourceState, commit: 'd'.repeat(40) },
        buildReceiptDigest: `sha256:${'d'.repeat(64)}`, terminalReceiptDigest: `sha256:${'d'.repeat(64)}`,
        canonicalCheckpointDigest: `sha256:${'d'.repeat(64)}` };
    for (const [field, value] of Object.entries(badValues))
    {
        assert.throws(() => projectCurrentProductionSummary({ ...current.input,
            expected: { ...current.input.expected, [field]: value } }), /binding mismatch/u);
    }
});

test('open or incomplete consumer identities cannot guess a current terminal digest', (t) =>
{
    const current = fixture(t);
    for (const field of Object.keys(current.input.expected))
    {
        const expected = { ...current.input.expected };
        delete expected[field];
        assert.throws(() => projectCurrentProductionSummary({ ...current.input, expected }), /closed current/u);
    }
    assert.throws(() => projectCurrentProductionSummary({ ...current.input,
        expected: { ...current.input.expected, latest: true } }), /closed current/u);
});

test('an orphan v1 compatibility file is never used as terminal authority', (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-orphan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const checkpointFile = path.join(root, 'orphan', 'checkpoint.json');
    fs.mkdirSync(path.dirname(checkpointFile));
    fs.writeFileSync(checkpointFile, JSON.stringify({ schema: 'fsusblog.browserless-correctness-receipt.v1', status: 'success' }));
    assert.throws(() => projectCurrentProductionSummary({ tier: summary(), checkpointFile,
        expected: { runId: 'orphan', targetAttemptId: 'attempt', sourceState: {},
            buildReceiptDigest: `sha256:${'a'.repeat(64)}`, terminalReceiptDigest: `sha256:${'b'.repeat(64)}`,
            canonicalCheckpointDigest: `sha256:${'c'.repeat(64)}` } }), /compatibility JSON is not authority/u);
});
