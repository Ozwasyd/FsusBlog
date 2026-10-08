/* eslint-disable import-x/no-relative-parent-imports -- Verify composition of the original locator/publication/attempt owners with physical fixture evidence. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sealProducerSemanticOutcomeCandidate } from '../../tools/test-matrix/outcomes/outcome-contract.mjs';
import { verifyOutcomeInputCustody } from '../../tools/test-matrix/outcomes/outcome-input-custody.mjs';

const { runProducerAttempts } = await import(new URL('../../tools/test/attempt-runner.mjs', import.meta.url));
const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication } = await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const { completeEvidenceLocatorRegistryEntry, governanceContentDigest } = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const d = (digit) => `sha256:${digit.repeat(64)}`;
const fileDigest = (file) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
const seal = (value) => ({ ...value, contentDigest: governanceContentDigest(value) });

async function fixture(run, { scenario = 'success', digestMode = 'content-digest' } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-outcome-custody-'));
    const evidenceRoot = path.join(root, 'artifacts/current-run');
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const identity = { producerId: 'backend-unit', schedulerRunId: 'fixture-run', sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: d('b'), buildIdentity: d('c'), toolchainDigest: d('d'),
        executionEnvelopeDigest: d('1'), replayPlanDigest: d('2'), temporalContextDigest: d('3') };
    const authorityReferences = ['execution-envelope', 'replay-plan', 'temporal-context'].map((kind, index) => ({
        kind, artifactPath: `${kind}.json`, artifactDigest: d(String(index + 1)),
        verificationReceiptPath: `${kind}.verification.json`, verificationReceiptDigest: d(String(index + 4)) }));
    // Explicit original execution-owner test double; these controls prove custody,
    // never an actual backend/native/runtime authority or independent acceptance.
    const verifyAuthority = (reference) => ({ verified: true, authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: Object.fromEntries(['producerId', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint']
            .map((field) => [field, identity[field]])) });
    try
    {
        const attempts = await runProducerAttempts({ evidenceRoot, producerId: identity.producerId,
            schedulerRunId: identity.schedulerRunId, sourceCommit: identity.sourceCommit,
            worktreeFingerprint: identity.worktreeFingerprint, retryPolicyId: 'correctness-first-attempt',
            authorityReferences, verifyAuthority, cwd: repositoryRoot, env: { PATH: process.env.PATH },
            command: [process.execPath, path.join(repositoryRoot, 'tests/tools/fixtures/attempt-runner-command.mjs'), scenario],
            expectedTestIds: ['fixture:attempt-runner'], timeoutMs: 5000 });
        const context = seal({ schema: 'fsusblog.current-run-evidence-context.v1',
            schedulerRunId: identity.schedulerRunId, attemptId: 'fixture-attempt-1', sourceCommit: identity.sourceCommit,
            worktreeFingerprint: identity.worktreeFingerprint, candidateIdentity: { id: 'fixture-source', digest: d('e') },
            buildIdentity: { id: 'fixture-build', digest: identity.buildIdentity }, ownedRoots: ['artifacts/current-run'] });
        const entry = completeEvidenceLocatorRegistryEntry({ consumerId: 'evidence-consumer.ci.summarize-quality-gate',
            authorityId: 'fixture.current-run-input', producerId: identity.producerId,
            receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
            requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint'],
            requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
            allowedRoots: ['artifacts/current-run'], publicationMode: 'hooked', payloadBindingKey: 'FSUSBLOG_PAYLOAD_PATH',
            producerCommand: 'node fixture-producer.mjs' });
        const registry = seal({ schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [entry] });
        const payloadPath = 'artifacts/current-run/input.json';
        const outputPath = 'artifacts/current-run/input.reference.json';
        const payloadBody = { schema: 'fixture.held-input.v1', data: 'semantic fixture' };
        const payload = digestMode === 'plan-digest'
            ? { ...payloadBody, planDigest: digestCanonical(payloadBody) } : sealContentDigest(payloadBody);
        const session = beginCurrentRunEvidencePublication({ authorityId: entry.authorityId, context,
            outputPath, payloadPath, producerId: identity.producerId, repositoryRoot: root });
        fs.writeFileSync(path.join(root, payloadPath), JSON.stringify(payload));
        finalizeCurrentRunEvidencePublication({ authorityId: entry.authorityId, context, outputPath, payloadPath,
            payloadSchema: payload.schema, producerId: identity.producerId, repositoryRoot: root,
            sessionId: session.sessionId, terminalStatus: 'success' });
        const inputReference = { kind: 'fixture-input', path: 'held:fixture-input', digest: digestMode === 'file-bytes' ? fileDigest(path.join(root, payloadPath))
            : digestMode === 'canonical-json' ? digestCanonical(payload) : payload.contentDigest ?? payload.planDigest };
        const bindings = [{ inputReference: structuredClone(inputReference), consumerId: entry.consumerId,
            explicitInputs: [outputPath], payloadPath, digestMode }];
        const attempt = attempts.attempts[0];
        const candidate = sealProducerSemanticOutcomeCandidate({ producerId: identity.producerId,
            producerAuthorityId: 'tools/test-matrix/outcomes/backend-test-adapter.mjs', identity,
            inputAuthorityRefs: [inputReference], attemptEligibility: {
                aggregateDigest: attempts.aggregate.contentDigest, attemptDigest: attempt.contentDigest,
                attemptNumber: 1, cleanFirstAttempt: attempts.aggregate.cleanFirstAttempt, firstFailure: attempt.firstFailure,
                qualificationEligible: attempts.aggregate.qualificationEligible },
            outcome: { status: scenario === 'success' ? 'success' : 'failed', requiredMembershipVerified: scenario === 'success',
                reasons: scenario === 'success' ? [] : [{ kind: 'product.assertion', producerId: identity.producerId,
                    identity: { producerId: identity.producerId, assertionId: 'fixture:assertion' } }], membership: {},
                semanticPayloadDigest: digestCanonical({}) } });
        const aggregatePath = path.join(attempts.producerRoot, 'aggregate.json');
        const aggregateReference = { path: path.relative(evidenceRoot, aggregatePath).replaceAll(path.sep, '/'),
            fileDigest: fileDigest(aggregatePath), digest: attempts.aggregate.contentDigest };
        const expected = { identity: structuredClone(identity), producerAuthorityId: candidate.producerAuthorityId,
            candidateDigest: candidate.contentDigest, contextDigest: context.contentDigest, registryDigest: registry.contentDigest,
            bindingsDigest: digestCanonical(bindings), aggregateReference: structuredClone(aggregateReference) };
        const f = { root, candidate, expected, bindings, payload, payloadPath, outputPath, attempts,
            options: { maxBytes: 1000000, repositoryRoot: root, context, registry, bindings,
                attemptEvidence: { evidenceRoot, aggregateReference }, verifyAuthority } };
        await run(f);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
const verify = (f) => verifyOutcomeInputCustody(JSON.stringify(f.candidate), JSON.stringify(f.expected), f.options);
function reseal(f, change)
{
    change(f.candidate);
    f.candidate = sealContentDigest(f.candidate);
    f.expected.candidateDigest = f.candidate.contentDigest;
}
function remap(f, change)
{
    change(f.bindings);
    f.expected.bindingsDigest = digestCanonical(f.bindings);
}

test('custody bridge reopens exact physical inputs and first attempt without issuing producer qualification', async () => fixture((f) =>
{
    const result = verify(f);
    assert.equal(result.custodyVerified, true);
    assert.equal(result.attemptCleanFirst, true);
    assert.equal(result.producerVerificationPending, true);
    assert.equal(result.qualificationEligible, false);
    assert.deepEqual(result.attemptEligibility, f.candidate.attemptEligibility);
    assert.equal(result.heldInputs[0].inputReference.path, 'held:fixture-input');
    assert.equal(result.heldInputs[0].bindingReceipt.identityVerified, true);
}));

test('custody bridge refuses missing and duplicate input mappings instead of searching held labels', async () => fixture((f) =>
{
    remap(f, (bindings) => bindings.length = 0);
    assert.throws(() => verify(f), /exact and unique/);
    f.bindings.push({ inputReference: f.candidate.inputAuthorityRefs[0] });
    f.expected.bindingsDigest = digestCanonical(f.bindings);
    assert.throws(() => verify(f), /not in the original locator registry/);
}));

test('custody bridge rejects ambiguous current-run references and path retargeting', async () => fixture((f) =>
{
    remap(f, (bindings) => bindings[0].explicitInputs.push(f.outputPath));
    assert.throws(() => verify(f), /ambiguous/);
    remap(f, (bindings) =>
    {
        bindings[0].explicitInputs.pop();
        bindings[0].payloadPath = 'artifacts/current-run/other.json';
    });
    assert.throws(() => verify(f), /differs from independent mapping/);
}));

test('custody bridge rejects physical input tamper and a changed independent mapping', async () => fixture((f) =>
{
    f.bindings[0].digestMode = 'canonical-json';
    assert.throws(() => verify(f), /independent locator/);
    f.bindings[0].digestMode = 'content-digest';
    fs.writeFileSync(path.join(f.root, f.payloadPath), JSON.stringify({ ...f.payload, data: 'tampered' }));
    assert.throws(() => verify(f), /payload reference digest mismatch/);
}));

test('custody bridge rejects candidate source build and attempt claims crossing held evidence', async () => fixture((f) =>
{
    reseal(f, (candidate) => candidate.identity.sourceCommit = 'f'.repeat(40));
    assert.throws(() => verify(f), /independent candidate identity/);
    f.expected.identity.sourceCommit = f.candidate.identity.sourceCommit;
    assert.throws(() => verify(f), /locator sourceCommit/);
    reseal(f, (candidate) => candidate.identity.sourceCommit = f.options.context.sourceCommit);
    f.expected.identity.sourceCommit = f.candidate.identity.sourceCommit;
    reseal(f, (candidate) => candidate.attemptEligibility.attemptDigest = d('f'));
    assert.throws(() => verify(f), /eligibility differs from held attempt/);
}));

test('custody bridge requires the original independent execution authority verifier', async () => fixture((f) =>
{
    f.options.verifyAuthority = undefined;
    assert.throws(() => verify(f), /original attempt verification failed: attempt.external-authority-unverified/);
}));

test('custody bridge rejects held attempt artifact tamper and independently pinned aggregate mismatch', async () => fixture((f) =>
{
    f.options.attemptEvidence.aggregateReference.fileDigest = d('f');
    assert.throws(() => verify(f), /independent aggregate reference mismatch/);
    f.options.attemptEvidence.aggregateReference = structuredClone(f.expected.aggregateReference);
    const artifact = path.join(f.attempts.producerRoot, 'attempt-1/payload.json');
    fs.chmodSync(artifact, 0o600);
    fs.writeFileSync(artifact, 'tampered');
    assert.throws(() => verify(f), /original attempt verification failed: attempt.artifact-tamper/);
}));

test('custody bridge honors explicit encoded and held JSON byte bounds', async () => fixture((f) =>
{
    f.options.maxBytes = 10;
    assert.throws(() => verify(f), /encoded input exceeds host budget/);
    f.options.maxBytes = 10000;
    fs.writeFileSync(path.join(f.root, f.outputPath), ' '.repeat(10001));
    assert.throws(() => verify(f), /held JSON exceeds host budget/);
}));


test('custody bridge retains a physically verified failed first attempt as ineligible', async () => fixture((f) =>
{
    const result = verify(f);
    assert.equal(result.custodyVerified, true);
    assert.equal(result.attemptCleanFirst, false);
    assert.equal(result.attemptEligibility.firstFailure, true);
    assert.equal(result.attemptEligibility.qualificationEligible, false);
    assert.equal(result.qualificationEligible, false);
}, { scenario: 'product-failure' }));

test('custody bridge preserves independent byte canonical JSON and plan digest conventions', async () =>
{
    for (const digestMode of ['file-bytes', 'canonical-json', 'plan-digest'])
    {
        await fixture((f) => assert.equal(verify(f).custodyVerified, true), { digestMode });
    }
});

test('custody bridge rejects unknown digest normalization and dual locator selectors', async () => fixture((f) =>
{
    remap(f, (bindings) => bindings[0].digestMode = 'invented');
    assert.throws(() => verify(f), /unknown independently declared digest mode/);
    remap(f, (bindings) =>
    {
        bindings[0].digestMode = 'content-digest';
        bindings[0].reference = { path: f.outputPath, objectDigest: fileDigest(path.join(f.root, f.outputPath)) };
    });
    assert.throws(() => verify(f), /exact-one evidence input is ambiguous/);
}));


test('custody bridge rechecks original input bytes after external authority I/O', async () => fixture((f) =>
{
    const original = f.options.verifyAuthority;
    f.options.verifyAuthority = (reference) =>
    {
        fs.writeFileSync(path.join(f.root, f.payloadPath), JSON.stringify({ ...f.payload, data: 'changed during verification' }));
        return original(reference);
    };
    assert.throws(() => verify(f), /payload reference digest mismatch/);
}));


test('custody bridge refuses newly invented input fields and authority identity drift', async () => fixture((f) =>
{
    reseal(f, (candidate) => candidate.inputAuthorityRefs[0].unregistered = 'field');
    remap(f, (bindings) => bindings[0].inputReference.unregistered = 'field');
    assert.throws(() => verify(f), /input reference fields are not exact/);
    reseal(f, (candidate) => delete candidate.inputAuthorityRefs[0].unregistered);
    remap(f, (bindings) => delete bindings[0].inputReference.unregistered);
    const original = f.options.verifyAuthority;
    f.options.verifyAuthority = (reference) =>
    {
        const verified = original(reference);
        verified.identity.schedulerRunId = 'cross-run';
        return verified;
    };
    assert.throws(() => verify(f), /attempt.external-authority-cross-identity/);
}));
