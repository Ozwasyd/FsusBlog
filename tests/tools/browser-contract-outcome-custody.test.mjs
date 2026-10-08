import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { adaptBrowserContractSemanticOutcome } = await import(new URL('../../tools/test-matrix/outcomes/browser-contract-adapter.mjs', import.meta.url));
const { verifyBrowserContractOutcomeInputCustody } = await import(new URL('../../tools/test-matrix/outcomes/browser-contract-runner-binding.mjs', import.meta.url));
const { runProducerAttempts } = await import(new URL('../../tools/test/attempt-runner.mjs', import.meta.url));
const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication } = await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const { completeEvidenceLocatorRegistryEntry, governanceContentDigest } = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const d = (digit) => `sha256:${digit.repeat(64)}`;
const fileDigest = (file) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
const seal = (value) => ({ ...value, contentDigest: governanceContentDigest(value) });

async function fixture(t, scenario = 'success')
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-outcome-custody-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const evidenceRoot = path.join(root, 'artifacts/current-run');
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const identity = { producerId: 'browser-contract-semantic-outcome', schedulerRunId: 'browser-custody-fixture',
        sourceCommit: 'a'.repeat(40), worktreeFingerprint: d('b'), buildIdentity: d('c'), toolchainDigest: d('d'),
        executionEnvelopeDigest: d('1'), replayPlanDigest: d('2'), temporalContextDigest: d('3') };
    const authorityReferences = ['execution-envelope', 'replay-plan', 'temporal-context'].map((kind, index) => ({
        kind, artifactPath: `${kind}.json`, artifactDigest: d(String(index + 1)),
        verificationReceiptPath: `${kind}.verification.json`, verificationReceiptDigest: d(String(index + 4)) }));
    // Original child/attempt/publication APIs exercise physical custody. This is
    // an explicit execution-owner test double, not browser/runtime authority.
    const verifyAuthority = (reference) => ({ verified: true, authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: Object.fromEntries(['producerId', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint']
            .map((field) => [field, identity[field]])) });
    const attempts = await runProducerAttempts({ evidenceRoot, producerId: identity.producerId,
        schedulerRunId: identity.schedulerRunId, sourceCommit: identity.sourceCommit,
        worktreeFingerprint: identity.worktreeFingerprint, retryPolicyId: 'correctness-first-attempt',
        authorityReferences, verifyAuthority, cwd: repositoryRoot, env: { PATH: process.env.PATH },
        command: [process.execPath, path.join(repositoryRoot, 'tests/tools/fixtures/attempt-runner-command.mjs'), scenario],
        expectedTestIds: ['fixture:attempt-runner'], timeoutMs: 5000 });
    const attempt = attempts.attempts[0];
    const common = { identity, attemptEligibility: { aggregateDigest: attempts.aggregate.contentDigest,
        attemptDigest: attempt.contentDigest, attemptNumber: 1, cleanFirstAttempt: attempts.aggregate.cleanFirstAttempt,
        firstFailure: attempt.firstFailure, qualificationEligible: attempts.aggregate.qualificationEligible },
    policyDigest: d('6'), runtimeIdentities: [{ projectId: 'fixture', browserId: 'chromium', runtimeDigest: d('7') }] };
    const member = { id: 'fixture-member', projectId: 'fixture', browserId: 'chromium',
        testId: 'fixture:attempt-runner', assertionId: 'fixture-assertion', required: true, artifacts: [] };
    const catalog = sealContentDigest({ schema: 'fsusblog.browser-contract-outcome-catalog.v1', ...common, members: [member] });
    const plan = sealContentDigest({ schema: 'fsusblog.browser-contract-outcome-plan.v1', ...common,
        members: [member], catalogDigest: catalog.contentDigest });
    const failure = scenario !== 'success';
    const { required, artifacts, ...memberIdentity } = member;
    void required;
    void artifacts;
    const report = sealContentDigest({ schema: 'fsusblog.browser-contract-outcome-report.v1', ...common,
        catalogDigest: catalog.contentDigest, planDigest: plan.contentDigest, groupStatus: failure ? 'failed' : 'success',
        interruption: null, diagnostics: {}, artifacts: [], members: [{ ...memberIdentity,
            status: failure ? 'failed' : 'passed', executed: true, artifactIds: [], failures: failure ? [{
                kind: 'product.assertion', identity: { producerId: identity.producerId,
                    ...Object.fromEntries(['projectId', 'browserId', 'testId', 'assertionId'].map((field) => [field, member[field]])) }
            }] : [] }] });
    const documents = [catalog, plan, report];
    const inputAuthorityRefs = documents.map((document, index) =>
    {
        const kind = ['catalog', 'plan', 'report'][index];
        const relative = `artifacts/current-run/${kind}.json`;
        return { kind: `browser-contract-${kind}`, path: relative,
            digest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(document)).digest('hex')}` };
    });
    const context = seal({ schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: identity.schedulerRunId,
        attemptId: 'fixture-attempt-1', sourceCommit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint,
        candidateIdentity: { id: 'fixture-source', digest: d('e') }, buildIdentity: { id: 'fixture-build', digest: identity.buildIdentity },
        ownedRoots: ['artifacts/current-run'] });
    const entry = completeEvidenceLocatorRegistryEntry({ consumerId: 'evidence-consumer.ci.summarize-quality-gate',
        authorityId: 'fixture.browser-custody-input', producerId: identity.producerId,
        receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint'],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
        allowedRoots: ['artifacts/current-run'], publicationMode: 'hooked', payloadBindingKey: 'FSUSBLOG_PAYLOAD_PATH',
        producerCommand: 'node fixture-producer.mjs' });
    const registry = seal({ schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [entry] });
    const bindings = inputAuthorityRefs.map((inputReference, index) =>
    {
        const outputPath = `${inputReference.path}.reference.json`;
        const payloadSchema = documents[index].schema;
        const session = beginCurrentRunEvidencePublication({ authorityId: entry.authorityId, context, outputPath,
            payloadPath: inputReference.path, producerId: identity.producerId, repositoryRoot: root });
        fs.writeFileSync(path.join(root, inputReference.path), JSON.stringify(documents[index]));
        finalizeCurrentRunEvidencePublication({ authorityId: entry.authorityId, context, outputPath,
            payloadPath: inputReference.path, payloadSchema, producerId: identity.producerId, repositoryRoot: root,
            sessionId: session.sessionId, terminalStatus: 'success' });
        return { inputReference: structuredClone(inputReference), consumerId: entry.consumerId,
            explicitInputs: [outputPath], payloadPath: inputReference.path, digestMode: 'file-bytes' };
    });
    const candidate = adaptBrowserContractSemanticOutcome({ repositoryRoot: root, authority: { ...common, inputAuthorityRefs } });
    const aggregatePath = path.join(attempts.producerRoot, 'aggregate.json');
    const aggregateReference = { path: path.relative(evidenceRoot, aggregatePath).replaceAll(path.sep, '/'),
        fileDigest: fileDigest(aggregatePath), digest: attempts.aggregate.contentDigest };
    // Independently pinned exact published DATA_ONLY source contract. This does
    // not claim the later bridge implementation is registered for execution.
    const expected = { identity: structuredClone(identity), candidateDigest: candidate.contentDigest,
        sourceCommit: '36bcb99ef10c1db7b07ac3717cfd8e178766699a',
        sourceDigest: 'sha256:92503892f10e022bea7ad10d947afd0bcf9a23be0cf21617049c70aa01bdc567',
        producerAuthorityId: candidate.producerAuthorityId, contextDigest: context.contentDigest,
        registryDigest: registry.contentDigest, bindingsDigest: digestCanonical(bindings), aggregateReference };
    const options = { maxBytes: 1000000, repositoryRoot: root, context, registry, bindings,
        attemptEvidence: { evidenceRoot, aggregateReference: structuredClone(aggregateReference) }, verifyAuthority };
    return { root, candidate, expected, options,
        verify: () => verifyBrowserContractOutcomeInputCustody(JSON.stringify(candidate), JSON.stringify(expected), options) };
}

test('browser candidate consumes original DATA_ONLY profile and physical custody without qualification', async (t) =>
{
    const f = await fixture(t);
    const result = await f.verify();
    assert.equal(result.profile.dataOnly, true);
    assert.equal(result.profile.sourceCommit, f.expected.sourceCommit);
    assert.equal(result.custody.custodyVerified, true);
    assert.equal(result.custody.heldInputs.length, 3);
    assert.equal(result.custody.attemptCleanFirst, true);
    assert.equal(result.producerVerificationPending, true);
    assert.equal(result.qualificationEligible, false);
});

test('browser custody preserves a physically held failed first attempt', async (t) =>
{
    const f = await fixture(t, 'product-failure');
    const result = await f.verify();
    assert.equal(f.candidate.outcome.status, 'failed');
    assert.equal(result.custody.attemptCleanFirst, false);
    assert.equal(result.custody.attemptEligibility.firstFailure, true);
    assert.equal(result.custody.attemptEligibility.qualificationEligible, false);
    assert.equal(result.qualificationEligible, false);
});

test('browser custody refuses wrong source pins and incomplete independently held mappings', async (t) =>
{
    const f = await fixture(t);
    f.expected.sourceDigest = d('f');
    await assert.rejects(f.verify, /adapter source identity mismatch/u);
    f.expected.sourceDigest = 'sha256:92503892f10e022bea7ad10d947afd0bcf9a23be0cf21617049c70aa01bdc567';
    f.options.bindings.pop();
    f.expected.bindingsDigest = digestCanonical(f.options.bindings);
    await assert.rejects(f.verify, /input mapping must be exact and unique/u);
});

test('browser custody refuses payload tamper and missing original execution verifier', async (t) =>
{
    const f = await fixture(t);
    const original = f.options.verifyAuthority;
    f.options.verifyAuthority = undefined;
    await assert.rejects(f.verify, /external-authority-unverified/u);
    f.options.verifyAuthority = original;
    fs.appendFileSync(path.join(f.root, f.options.bindings[0].payloadPath), ' ');
    await assert.rejects(f.verify, /payload reference digest mismatch/u);
});

test('browser physical paths cannot be silently rebound as generic logical held labels', async (t) =>
{
    const f = await fixture(t);
    f.candidate.inputAuthorityRefs[0].path = 'held:browser-input';
    f.options.bindings[0].inputReference.path = 'held:browser-input';
    const candidate = sealContentDigest(f.candidate);
    f.expected.candidateDigest = candidate.contentDigest;
    f.expected.bindingsDigest = digestCanonical(f.options.bindings);
    await assert.rejects(() => verifyBrowserContractOutcomeInputCustody(JSON.stringify(candidate), JSON.stringify(f.expected), f.options),
        /browser physical input path differs/u);
});
