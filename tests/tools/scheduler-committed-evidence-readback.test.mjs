import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { schedulerCommittedEvidenceReadbackVersion, verifyCommittedSchedulerEvidence } =
    await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const { attachCurrentRunEvidenceHandoff, initializeCurrentRunEvidenceCheckpoint } =
    await import(new URL('../../tools/test/current-run-evidence-checkpoint.mjs', import.meta.url));
const { beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication } =
    await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const { completeEvidenceLocatorRegistryEntry, governanceContentDigest } =
    await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const { writeCanonicalSchedulerFixture } = await import(new URL('./support/canonical-scheduler-fixture.mjs', import.meta.url));

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-committed-readback-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'artifacts/current-run'), { recursive: true });
    const runId = 'readback-run';
    const digest = (letter) => `sha256:${letter.repeat(64)}`;
    const seal = (body) => ({ ...body, contentDigest: governanceContentDigest(body) });
    const context = seal({ schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: runId,
        attemptId: 'controlled-attempt', sourceCommit: 'a'.repeat(40), worktreeFingerprint: digest('b'),
        candidateIdentity: { id: 'controlled-candidate', digest: digest('c') },
        buildIdentity: { id: 'controlled-build', digest: digest('d') }, ownedRoots: ['artifacts/current-run'] });
    const entry = completeEvidenceLocatorRegistryEntry({ consumerId: 'consumer.controlled-output',
        authorityId: 'authority.controlled-output', producerId: 'producer.controlled-output',
        producerCommand: 'node tools/test/current-run-evidence-locator.mjs',
        receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
            'sourceCommit', 'worktreeFingerprint'], requiredDigestFields: ['contentDigest', 'producerReceiptDigest'],
        expectedCardinality: 'exact-one', allowedRoots: ['artifacts/current-run'] });
    const registry = seal({ schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [entry] });
    const outputPath = 'artifacts/current-run/reference.json';
    const payloadPath = 'artifacts/current-run/payload.json';
    const expectedPayloadSchema = 'controlled.readback-payload.v1';
    const publication = { authorityId: entry.authorityId, producerId: entry.producerId,
        context, outputPath, payloadPath, repositoryRoot: root };
    // A normal controlled publication through existing APIs, with no release v2
    // producer, cohort, runtime qualification, pointer race or substitution probe.
    const session = beginCurrentRunEvidencePublication(publication);
    fs.writeFileSync(path.join(root, payloadPath), JSON.stringify({ schema: expectedPayloadSchema,
        qualificationEligible: false, observation: 'ordinary source control' }));
    const finalized = finalizeCurrentRunEvidencePublication({ ...publication,
        sessionId: session.sessionId, payloadSchema: expectedPayloadSchema, terminalStatus: 'success' });
    const checkpoint = { runId, revision: 7, status: 'running', authoritative: false,
        sourceState: { commit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint },
        currentRunEvidenceReferences: initializeCurrentRunEvidenceCheckpoint(context) };
    attachCurrentRunEvidenceHandoff({ checkpoint, context, entry, handoff: finalized.handoff,
        registry, repositoryRoot: root });
    const checkpointFile = path.join(root, 'runs', runId, 'checkpoint.json');
    const written = writeCanonicalSchedulerFixture(checkpointFile, checkpoint);
    const options = { checkpointFile, expectedCommittedRevision: written.checkpoint.revision,
        context, registry, registryEntry: entry, repositoryRoot: root, expectedPayloadSchema };
    return { options, committed: written.checkpoint, wrapper: finalized.receipt };
}

test('ordinary readback returns only the actual committed revision and wrapper reference facts without repair', (t) =>
{
    const current = fixture(t);
    const projectionBefore = fs.readFileSync(current.options.checkpointFile, 'utf8');
    const actual = verifyCommittedSchedulerEvidence(current.options);
    assert.equal(schedulerCommittedEvidenceReadbackVersion, 1);
    assert.deepEqual(actual, { committedRevision: 7,
        finalOutputRef: current.committed.currentRunEvidenceReferences.references[0],
        finalOutputDigest: current.committed.currentRunEvidenceReferences.references[0].inputDigest });
    assert.notEqual(actual.finalOutputDigest, current.wrapper.payload.digest);
    assert.equal(fs.readFileSync(current.options.checkpointFile, 'utf8'), projectionBefore);
    assert.equal(current.committed.authoritative, false);
});

test('readback requires every explicit parameter and never defaults the committed revision', (t) =>
{
    const current = fixture(t);
    for (const field of Object.keys(current.options))
    {
        const missing = { ...current.options };
        delete missing[field];
        assert.throws(() => verifyCommittedSchedulerEvidence(missing), Error, field);
    }
    assert.throws(() => verifyCommittedSchedulerEvidence(), /requires explicit/u);
});

test('readback rejects a different independently supplied current attempt identity', (t) =>
{
    const current = fixture(t);
    const { contentDigest, ...body } = current.options.context;
    assert.ok(contentDigest);
    const changed = { ...body, attemptId: 'another-current-attempt' };
    const context = { ...changed, contentDigest: governanceContentDigest(changed) };
    assert.throws(() => verifyCommittedSchedulerEvidence({ ...current.options, context }),
        /current identity mismatch: attemptId/u);
});
