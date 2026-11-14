import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { writeCanonicalSchedulerFixture } from './support/canonical-scheduler-fixture.mjs';
import { staticAtomicCanonicalFixture } from './support/static-atomic-canonical-fixture.mjs';

const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { initializeCurrentRunEvidenceCheckpoint } = await import(new URL('../../tools/test/current-run-evidence-checkpoint.mjs', import.meta.url));
const { beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication } = await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const { governanceContentDigest } = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const { projectCompiledStaticAtomicSummary, readCurrentStaticAtomicSummary } = await import(new URL('../../tools/test/static-atomic/terminal-bridge.mjs', import.meta.url));

const projectionOptions = (fixture, vector, lane = 'security-static') => ({ compilation: fixture.compilation,
    compilationOptions: fixture.options, vector, expectedVector: vector, context: fixture.options.context,
    producerContexts: fixture.options.producerContexts, lane });

function alterVector(vector, id, mutate)
{
    const body = structuredClone(vector);
    delete body.contentDigest;
    body.receipts = body.receipts.map(entry =>
    {
        if (entry.producerId !== id)
        {
            return entry;
        }
        const child = { ...entry };
        delete child.contentDigest;
        mutate(child);
        return sealContentDigest(child);
    });
    return sealContentDigest(body);
}

test('canonical summaries preserve simultaneous failures and zero-spawn blocked terminals with original membership', async t =>
{
    const fixture = staticAtomicCanonicalFixture(t, { failures: ['cross-stack-auth-state-coherence', 'cross-stack-service-worker-cache', 'security-network-baseline'], blockedSupplyChain: true });
    const vector = await fixture.execute();
    for (const [lane, count] of [['cross-stack-static', 6], ['security-static', 7]])
    {
        const summary = projectCompiledStaticAtomicSummary(projectionOptions(fixture, vector, lane));
        assert.equal(summary.status, 'failure');
        assert.equal(summary.children.length, count);
        assert.equal(summary.qualificationEligible, false);
        assert.equal(summary.compiledDagDigest, fixture.compilation.compiled.contentDigest);
        for (const child of summary.children)
        {
            const original = fixture.declarations.producers.find(entry => entry.id === child.producerId);
            assert.deepEqual(child.originalAssertionBindings, original.assertionBindings);
            assert.deepEqual(child.legacyPhysicalTestIds, original.legacyPhysicalTestIds);
            assert.ok(child.replayTestIds.length > 0);
        }
        if (lane === 'security-static')
        {
            const blocked = summary.children.find(entry => entry.producerId === 'security-supply-chain-audit');
            assert.equal(blocked.terminalState, 'blocked');
            assert.equal(blocked.attemptRef, null);
            assert.deepEqual(blocked.blockedBy, ['synthetic-restore']);
        }
    }
});

test('resealed blocked claims, missing children and fabricated success are refused', async t =>
{
    const fixture = staticAtomicCanonicalFixture(t, { blockedSupplyChain: true });
    const vector = await fixture.execute();
    const project = changed => projectCompiledStaticAtomicSummary(projectionOptions(fixture, changed));
    assert.throws(() => project(alterVector(vector, 'security-supply-chain-audit', child => child.blockedBy = [])), /hard blocked predecessors/u);
    assert.throws(() => project(alterVector(vector, 'security-supply-chain-audit', child => child.attemptRef = { path: 'fake', contentDigest: digestCanonical('fake') })), /spawned attempt/u);
    assert.throws(() => project(alterVector(vector, 'security-supply-chain-audit', child => child.terminalState = 'success')), /nonblocked predecessor roster/u);
    const body = { ...vector };
    delete body.contentDigest;
    assert.throws(() => project(sealContentDigest({ ...body, receipts: body.receipts.slice(1) })), /complete terminal roster/u);
    assert.throws(() => project(alterVector(vector, 'security-static-summary', child => child.terminalState = 'success')), /projection evidence terminal|promote non-success/u);
});

test('attempt outcomes, artifacts and source identity remain bound after vector resealing', async t =>
{
    const fixture = staticAtomicCanonicalFixture(t, { failures: ['security-network-baseline'] });
    const vector = await fixture.execute();
    const changed = alterVector(vector, 'security-network-baseline', child => child.terminalState = 'success');
    assert.throws(() => projectCompiledStaticAtomicSummary(projectionOptions(fixture, changed)), /attempt outcome/u);
    const foreign = { ...projectionOptions(fixture, vector), context: { ...fixture.options.context, schedulerRunId: 'foreign-run' } };
    assert.throws(() => projectCompiledStaticAtomicSummary(foreign), /vector schedulerRunId/u);
    const child = vector.receipts.find(entry => entry.producerId === 'security-sbom');
    fs.chmodSync(path.join(path.dirname(child.attemptRef.path), 'stdout.log'), 0o644);
    fs.appendFileSync(path.join(path.dirname(child.attemptRef.path), 'stdout.log'), 'tampered');
    assert.throws(() => projectCompiledStaticAtomicSummary(projectionOptions(fixture, vector)), /artifact|digest/u);
});

test('modified canonical settled projection evidence cannot survive a pinned vector', async t =>
{
    const fixture = staticAtomicCanonicalFixture(t);
    const vector = await fixture.execute();
    const aggregate = vector.receipts.find(entry => entry.producerId === 'security-static-summary');
    const file = aggregate.evidenceRefs[0].path;
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    document.dependencies[0].outcome = 'failed';
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, JSON.stringify(document));
    assert.throws(() => projectCompiledStaticAtomicSummary(projectionOptions(fixture, vector)), /projection evidence outcomes/u);
});

async function checkpointControl(t)
{
    const fixture = staticAtomicCanonicalFixture(t);
    const vector = await fixture.execute();
    const runRoot = path.join(fixture.evidenceRoot, fixture.identity.schedulerRunId);
    // Native publication fixture is positive observer evidence only; no live registry or scheduler acceptance.
    const payloadPath = path.relative(fixture.root, path.join(runRoot, 'controlled-vector.json'));
    const body = { schema: 'fsusblog.current-run-evidence-context.v1', ...fixture.identity,
        attemptId: 'synthetic-attempt-1', candidateIdentity: { id: 'synthetic-candidate', digest: digestCanonical('candidate') },
        buildIdentity: { id: 'synthetic-build', digest: digestCanonical('build') }, ownedRoots: ['evidence'] };
    const evidenceContext = { ...body, contentDigest: governanceContentDigest(body) };
    const authorityId = 'synthetic-static-summary-authority';
    const consumerId = 'synthetic-security-static-consumer';
    const outputPath = path.relative(fixture.root, path.join(runRoot, 'controlled-reference.json'));
    const publicationOptions = { authorityId, context: evidenceContext, outputPath, payloadPath,
        payloadSchema: vector.schema, producerId: 'security-static-summary', repositoryRoot: fixture.root, terminalStatus: 'success' };
    const session = beginCurrentRunEvidencePublication(publicationOptions);
    fs.writeFileSync(path.join(fixture.root, payloadPath), JSON.stringify(vector));
    const { receipt, handoff: publication } = finalizeCurrentRunEvidencePublication({ ...publicationOptions, sessionId: session.sessionId });
    const reference = { consumerId, authorityId, producerId: 'security-static-summary', path: outputPath,
        inputDigest: publication.inputDigest, contentDigest: receipt.contentDigest, producerReceiptDigest: receipt.producerReceiptDigest };
    const current = initializeCurrentRunEvidenceCheckpoint(evidenceContext);
    current.references.push(reference);
    current.contentDigest = governanceContentDigest(current);
    const checkpointFile = path.join(runRoot, 'checkpoint.json');
    const { checkpoint } = writeCanonicalSchedulerFixture(checkpointFile, { runId: fixture.identity.schedulerRunId,
        sourceState: { commit: fixture.identity.sourceCommit, worktreeFingerprint: fixture.identity.worktreeFingerprint },
        authoritative: true, candidateIdentityValidated: true, currentRunEvidenceReferences: current });
    return { fixture, vector, options: { ...projectionOptions(fixture, vector), checkpointFile,
        expectedCheckpointDigest: checkpoint.contentDigest, evidenceContext, expectedVectorDigest: vector.contentDigest,
        consumerId, authorityId } };
}

test('current-attempt reading consumes the native immutable checkpoint and real publication wrapper, ignoring compatibility JSON', async t =>
{
    const { options } = await checkpointControl(t);
    fs.writeFileSync(options.checkpointFile, JSON.stringify({ status: 'fake-success' }));
    const result = readCurrentStaticAtomicSummary(options);
    assert.equal(result.status, 'success');
    assert.equal(result.checkpointRef, options.expectedCheckpointDigest);
    assert.equal(result.qualificationEligible, false);
    const { contentDigest, ...body } = result;
    assert.equal(contentDigest, digestCanonical(body));
});

test('current-attempt reading refuses foreign attempts, wrong payload pins and modified publication bytes', async t =>
{
    const { options, fixture } = await checkpointControl(t);
    const foreignBody = { ...options.evidenceContext, attemptId: 'synthetic-attempt-2' };
    foreignBody.contentDigest = governanceContentDigest(foreignBody);
    assert.throws(() => readCurrentStaticAtomicSummary({ ...options, evidenceContext: foreignBody }), /current-attempt evidence block/u);
    assert.throws(() => readCurrentStaticAtomicSummary({ ...options, expectedVectorDigest: digestCanonical('foreign-vector') }), /current vector digest/u);
    assert.throws(() => readCurrentStaticAtomicSummary({ ...options, authorityId: 'foreign-authority' }), /publication reference/u);
    const referencePath = path.join(fixture.evidenceRoot, fixture.identity.schedulerRunId, 'controlled-reference.json');
    fs.appendFileSync(referencePath, '\n');
    assert.throws(() => readCurrentStaticAtomicSummary(options), /publication file digest/u);
});
