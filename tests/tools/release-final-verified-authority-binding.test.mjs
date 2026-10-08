import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { controlledRequiredEvidenceFixture, publishControlledProducer } from './fixtures/required-evidence-controlled-owner.mjs';
const { parseMatrix } = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
const { createRequiredEvidenceDependencies, requiredEvidencePlanDigest } = await import(new URL('../../tools/test-matrix/required-evidence-dependencies.mjs', import.meta.url));
const { governanceContentDigest } = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const { evidenceContentDigest, evidenceProducerReceiptDigest } = await import(new URL('../../tools/test/current-run-evidence-locator.mjs', import.meta.url));
const { beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication } = await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const { createRequiredEvidenceBinding } = await import(new URL('../../tools/release/required-evidence-binding.mjs', import.meta.url));
const { createReleaseFinalVerifiedAuthorityBinding, verifyReleaseFinalVerifiedAuthorityBinding } = await import(new URL('../../tools/release/test-evidence-receipts.mjs', import.meta.url));
const { consumeReleaseFinalVerifiedBindings } = await import(new URL('../../tools/release/check-release-final.mjs', import.meta.url));

const matrix = parseMatrix(fs.readFileSync(new URL('../../tests/matrix.yml', import.meta.url), 'utf8'));

// Enumerates the real catalog with explicitly controlled owners. These model
// fixtures prove consumer refusal/replay, never actual product qualification.
async function finalFixture(t)
{
    const f = controlledRequiredEvidenceFixture(t, { preserveCanonicalVerifierRefs: true });
    const expectedPlanIdentity = { sourceCommit: f.context.sourceCommit,
        worktreeFingerprint: f.context.worktreeFingerprint, runId: f.context.schedulerRunId,
        attempt: f.context.attemptId, namespace: `sha256:${'a'.repeat(64)}`,
        mode: 'current-run', candidateIdentity: f.context.candidateIdentity };
    const plan = { schema: 'fsusblog.release-evidence.test-plan.v1',
        commit: expectedPlanIdentity.sourceCommit, runId: expectedPlanIdentity.runId,
        namespace: expectedPlanIdentity.namespace, tiers: matrix.tiers,
        requiredEvidenceDependencies: createRequiredEvidenceDependencies(matrix, expectedPlanIdentity, f.catalog) };
    const testPlan = { ...plan, contentDigest: requiredEvidencePlanDigest(plan) };
    const bindingInputs = [];
    fs.mkdirSync(path.join(f.repositoryRoot, 'artifacts/current-run/bindings'));
    for (const entry of f.catalog.entries)
    {
        const producer = publishControlledProducer(f, entry);
        const binding = await createRequiredEvidenceBinding(producer);
        const outputPath = `artifacts/current-run/bindings/${entry.authorityId}.ref.json`;
        const payloadPath = `artifacts/current-run/bindings/${entry.authorityId}.json`;
        const session = beginCurrentRunEvidencePublication({ authorityId: entry.locatorBindingKey,
            producerId: entry.canonicalOwner, context: f.context, outputPath, payloadPath,
            repositoryRoot: f.repositoryRoot });
        fs.writeFileSync(path.join(f.repositoryRoot, payloadPath), JSON.stringify(binding));
        finalizeCurrentRunEvidencePublication({ authorityId: entry.locatorBindingKey,
            producerId: entry.canonicalOwner, context: f.context, outputPath, payloadPath,
            payloadSchema: binding.schema, repositoryRoot: f.repositoryRoot,
            sessionId: session.sessionId, terminalStatus: 'success' });
        bindingInputs.push({ authorityId: entry.authorityId, outputBindingKey: entry.outputBindingKey,
            explicitInputs: [outputPath], verification: { expectedIdentity: producer.expectedIdentity,
                explicitInputs: producer.explicitInputs } });
    }
    return { catalog: f.catalog, context: f.context, locatorRegistry: f.locatorRegistry,
        repositoryRoot: f.repositoryRoot, verifierRegistry: f.verifierRegistry,
        expectedPlanIdentity, testPlan, bindingInputs };
}

test('final-binding owner consumes every projected authority binding and independently replays complete records', async (t) =>
{
    const options = await finalFixture(t);
    const result = await createReleaseFinalVerifiedAuthorityBinding(options);
    assert.equal(result.authorities.length, options.catalog.entries.length);
    assert.equal(result.status, 'verified-bindings-unpublished');
    assert.equal(result.qualificationEligible, false, 'memory verification cannot acquire persistence/product authority');
    for (const [index, entry] of options.catalog.entries.entries())
    {
        const record = result.authorities[index];
        assert.equal(record.outputBindingKey, entry.outputBindingKey);
        assert.deepEqual(record.verifiedBinding.idChecks.requiredTestIds.expected, entry.requiredTestIds);
        assert.deepEqual(record.verifiedBinding.idChecks.requiredCoverageIds.expected, entry.requiredCoverageIds);
        assert.deepEqual(record.verifiedBinding.idChecks.requiredArtifactIds.expected, entry.requiredArtifactIds);
        assert.equal(record.verifiedBinding.domainVerifier.result.status, 'success');
        assert.equal(record.verifiedBinding.domainVerifier.resultDigest,
            governanceContentDigest(record.verifiedBinding.domainVerifier.result));
        assert.equal(record.bindingReference.contentDigest, record.verifiedBinding.contentDigest);
    }
    assert.deepEqual(await verifyReleaseFinalVerifiedAuthorityBinding(result, options), result);
    assert.deepEqual(await consumeReleaseFinalVerifiedBindings(options), result);
});

test('missing, duplicate, unknown and mismatched slots fail closed and return exact producer commands with zero processes', async (t) =>
{
    const options = await finalFixture(t);
    let calls = 0;
    const originals = new Map();
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
    {
        originals.set(key, childProcess[key]);
        childProcess[key] = () =>
        {
            calls += 1;
            throw new Error('finalizer must not execute missing producers');
        };
    }
    syncBuiltinESMExports();
    t.after(() =>
    {
        for (const [key, value] of originals)
        {
            childProcess[key] = value;
        }
        syncBuiltinESMExports();
    });
    const [first] = options.catalog.entries;
    await assert.rejects(createReleaseFinalVerifiedAuthorityBinding({ ...options, bindingInputs: options.bindingInputs.slice(1) }),
        (error) => error.reasonCode === 'MISSING_BINDINGS'
            && assert.deepEqual(error.localProducerCommands, [first.localProducerCommand]) === undefined);
    await assert.rejects(createReleaseFinalVerifiedAuthorityBinding({ ...options,
        bindingInputs: [...options.bindingInputs, options.bindingInputs[0]] }), /duplicate authority/u);
    await assert.rejects(createReleaseFinalVerifiedAuthorityBinding({ ...options,
        bindingInputs: [...options.bindingInputs, { authorityId: 'unknown-correctness' }] }), /undeclared correctness/u);
    const inputs = structuredClone(options.bindingInputs);
    inputs[0].outputBindingKey = 'wrong-slot';
    await assert.rejects(createReleaseFinalVerifiedAuthorityBinding({ ...options, bindingInputs: inputs }), /exact projected binding slot/u);
    inputs[0] = { ...options.bindingInputs[0], explicitInputs: [] };
    await assert.rejects(createReleaseFinalVerifiedAuthorityBinding({ ...options, bindingInputs: inputs }), /exact-one evidence input is missing/u);
    assert.equal(calls, 0);
});

test('plan, source/run/candidate and verification-owner inputs cannot be independently resigned or overridden', async (t) =>
{
    const options = await finalFixture(t);
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'runId', 'attempt', 'candidateIdentity'])
    {
        const identity = structuredClone(options.expectedPlanIdentity);
        identity[field] = field === 'candidateIdentity' ? { id: 'other', digest: `sha256:${'a'.repeat(64)}` } : 'other';
        await assert.rejects(createReleaseFinalVerifiedAuthorityBinding({ ...options, expectedPlanIdentity: identity }), /current-run plan identity/u);
    }
    const plan = structuredClone(options.testPlan);
    plan.requiredEvidenceDependencies.dependencies.pop();
    plan.requiredEvidenceDependencies.contentDigest = governanceContentDigest(plan.requiredEvidenceDependencies);
    plan.contentDigest = requiredEvidencePlanDigest(plan);
    await assert.rejects(createReleaseFinalVerifiedAuthorityBinding({ ...options, testPlan: plan }), /exactly project catalog/u);
    const inputs = structuredClone(options.bindingInputs);
    inputs[0].verification.context = options.context;
    await assert.rejects(createReleaseFinalVerifiedAuthorityBinding({ ...options, bindingInputs: inputs }), /explicit original producer inputs/u);
});

test('raw receipt fallback, changed originals, missing binding fields and resigned final tamper are refused', async (t) =>
{
    const options = await finalFixture(t);
    const result = await createReleaseFinalVerifiedAuthorityBinding(options);
    const tampered = structuredClone(result);
    delete tampered.authorities[0].verifiedBinding.idChecks;
    tampered.contentDigest = governanceContentDigest(tampered);
    await assert.rejects(verifyReleaseFinalVerifiedAuthorityBinding(tampered, options), /fresh authority verification/u);
    const inputs = structuredClone(options.bindingInputs);
    inputs[0].explicitInputs = inputs[0].verification.explicitInputs;
    await assert.rejects(createReleaseFinalVerifiedAuthorityBinding({ ...options, bindingInputs: inputs }), /binding is not successful/u);
    const raw = path.join(options.repositoryRoot, result.authorities[0].verifiedBinding.receipt.ref);
    fs.appendFileSync(raw, ' ');
    await assert.rejects(verifyReleaseFinalVerifiedAuthorityBinding(result, options), /digest mismatch/u);
});

test('catalog-enumerated consumer controls refuse every cancelled/diagnostic/failed authority and retain local/CI parity', async (t) =>
{
    const options = await finalFixture(t);
    for (const [index, entry] of options.catalog.entries.entries())
    {
        const inputs = options.bindingInputs.filter((input) => input.authorityId !== entry.authorityId);
        for (const consumer of [createReleaseFinalVerifiedAuthorityBinding, consumeReleaseFinalVerifiedBindings])
        {
            await assert.rejects(consumer({ ...options, bindingInputs: inputs }),
                (error) => error.reasonCode === 'MISSING_BINDINGS'
                    && error.localProducerCommands.length === 1
                    && error.localProducerCommands[0] === entry.localProducerCommand);
        }
        const referenceFile = path.join(options.repositoryRoot, options.bindingInputs[index].explicitInputs[0]);
        const referenceBytes = fs.readFileSync(referenceFile);
        const reference = JSON.parse(referenceBytes);
        const payloadFile = path.join(options.repositoryRoot, reference.payload.path);
        const payloadBytes = fs.readFileSync(payloadFile);
        for (const status of ['failure', 'cancelled', 'diagnostic'])
        {
            const payload = JSON.parse(payloadBytes);
            payload.status = status;
            payload.contentDigest = governanceContentDigest(payload);
            const bytes = Buffer.from(JSON.stringify(payload));
            fs.writeFileSync(payloadFile, bytes);
            const changed = structuredClone(reference);
            changed.payload.digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
            changed.contentDigest = evidenceContentDigest(changed);
            changed.producerReceiptDigest = evidenceProducerReceiptDigest(changed);
            fs.writeFileSync(referenceFile, JSON.stringify(changed));
            await assert.rejects(createReleaseFinalVerifiedAuthorityBinding(options),
                (error) => error.reasonCode === 'BINDING_NOT_SUCCESS'
                    && error.localProducerCommands[0] === entry.localProducerCommand);
        }
        fs.writeFileSync(payloadFile, payloadBytes);
        fs.writeFileSync(referenceFile, referenceBytes);
    }
});
