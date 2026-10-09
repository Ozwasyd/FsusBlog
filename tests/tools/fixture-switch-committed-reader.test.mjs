import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { readFixtureSwitchSchedulerObservation } = await import(new URL('../../tools/test-matrix/fixture-switch-scheduler-adapter.mjs', import.meta.url));
const { readCanonicalSchedulerCheckpoint } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const { attachCurrentRunEvidenceHandoff, initializeCurrentRunEvidenceCheckpoint } =
    await import(new URL('../../tools/test/current-run-evidence-checkpoint.mjs', import.meta.url));
const { beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication } =
    await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const { completeEvidenceLocatorRegistryEntry, governanceContentDigest } =
    await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const { writeCanonicalSchedulerFixture } = await import(new URL('./support/canonical-scheduler-fixture.mjs', import.meta.url));

// DATA_ONLY ordinary port mapping. The sole hook removes only this test's mkdtemp root.
function setup(t, withCommittedWrapper)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-switch-committed-port-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runId = 'switch-ordinary-run';
    const digest = (letter) => `sha256:${letter.repeat(64)}`;
    const seal = (body) => ({ ...body, contentDigest: governanceContentDigest(body) });
    const context = seal({ schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: runId,
        attemptId: 'evidence-attempt', sourceCommit: 'a'.repeat(40), worktreeFingerprint: digest('b'),
        candidateIdentity: { id: 'ordinary-candidate', digest: digest('c') },
        buildIdentity: { id: 'ordinary-build', digest: digest('d') }, ownedRoots: ['artifacts/current-run'] });
    const sourceState = { commit: context.sourceCommit,
        worktreeFingerprint: withCommittedWrapper ? context.worktreeFingerprint : 'b'.repeat(64) };
    const checkpoint = { runId, revision: 7, status: 'running', authoritative: false, sourceState,
        releaseCandidateIdentity: { immutableBuildReceiptDigest: context.buildIdentity.digest },
        correctnessAttempt: { targetAttemptId: 'aggregate-attempt' } };
    let committedEvidence = null;
    let wrapper = null;
    if (withCommittedWrapper)
    {
        fs.mkdirSync(path.join(root, 'artifacts/current-run'), { recursive: true });
        const entry = completeEvidenceLocatorRegistryEntry({ consumerId: 'consumer.ordinary-switch',
            authorityId: 'authority.ordinary-switch', producerId: 'producer.ordinary-switch',
            producerCommand: 'node tools/test/current-run-evidence-locator.mjs',
            receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
            requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
                'sourceCommit', 'worktreeFingerprint'], requiredDigestFields: ['contentDigest', 'producerReceiptDigest'],
            expectedCardinality: 'exact-one', allowedRoots: ['artifacts/current-run'] });
        const registry = seal({ schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [entry] });
        const expectedPayloadSchema = 'controlled.ordinary-switch-observation.v1';
        const publication = { authorityId: entry.authorityId, producerId: entry.producerId, context,
            outputPath: 'artifacts/current-run/reference.json', payloadPath: 'artifacts/current-run/payload.json', repositoryRoot: root };
        const session = beginCurrentRunEvidencePublication(publication);
        fs.writeFileSync(path.join(root, publication.payloadPath), JSON.stringify({ schema: expectedPayloadSchema,
            qualificationEligible: false, observation: 'ordinary mapping model' }));
        const finalized = finalizeCurrentRunEvidencePublication({ ...publication, sessionId: session.sessionId,
            payloadSchema: expectedPayloadSchema, terminalStatus: 'success' });
        wrapper = finalized.receipt;
        checkpoint.currentRunEvidenceReferences = initializeCurrentRunEvidenceCheckpoint(context);
        attachCurrentRunEvidenceHandoff({ checkpoint, context, entry, handoff: finalized.handoff, registry, repositoryRoot: root });
        committedEvidence = { expectedCommittedRevision: 7, context, registry, registryEntry: entry,
            repositoryRoot: root, expectedPayloadSchema };
    }
    const checkpointFile = path.join(root, 'runs', runId, 'checkpoint.json');
    const { store } = writeCanonicalSchedulerFixture(checkpointFile, checkpoint);
    const canonical = readCanonicalSchedulerCheckpoint(checkpointFile);
    const expected = { runId, sourceState, buildReceiptDigest: context.buildIdentity.digest,
        targetAttemptId: 'aggregate-attempt', checkpointDigest: canonical.checkpointDigest, lastSequence: canonical.lastSequence };
    return { checkpointFile, expected, committedEvidence, wrapper, store, checkpoint };
}

test('ordinary committed wrapper mapping retains actual digest layers and independent attempt identities without writes', async (t) =>
{
    const current = setup(t, true);
    const projection = fs.readFileSync(current.checkpointFile, 'utf8');
    const sequence = current.store.readJournal().length;
    const result = await readFixtureSwitchSchedulerObservation(current);
    const reference = current.checkpoint.currentRunEvidenceReferences.references[0];
    assert.deepEqual(result.committedReadback, { committedRevision: 7, finalOutputRef: reference, finalOutputDigest: reference.inputDigest });
    assert.notEqual(result.committedReadback.finalOutputDigest, current.wrapper.payload.digest);
    assert.equal(result.binding.targetAttemptId, 'aggregate-attempt');
    assert.equal(result.checkpoint.currentRunEvidenceReferences.attemptId, 'evidence-attempt');
    assert.equal(result.binding.sourceState.worktreeFingerprint, `sha256:${'b'.repeat(64)}`);
    assert.equal(result.switchSource.worktreeFingerprint, result.binding.sourceState.worktreeFingerprint);
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.terminal, null);
    assert.equal(current.store.readJournal().length, sequence);
    assert.equal(fs.readFileSync(current.checkpointFile, 'utf8'), projection);
});

test('ordinary unprefixed scheduler source maps to switch digest while preserving the canonical source identity', async (t) =>
{
    const current = setup(t, false);
    const result = await readFixtureSwitchSchedulerObservation(current);
    assert.equal(result.binding.sourceState.worktreeFingerprint, 'b'.repeat(64));
    assert.equal(result.switchSource.worktreeFingerprint, `sha256:${'b'.repeat(64)}`);
    assert.equal(result.committedReadback, null);
    assert.equal(result.qualificationEligible, false);
});
