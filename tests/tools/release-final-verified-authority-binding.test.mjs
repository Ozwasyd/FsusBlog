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
const { evidenceContentDigest, evidenceProducerReceiptDigest, locateCurrentRunEvidence } = await import(new URL('../../tools/test/current-run-evidence-locator.mjs', import.meta.url));
const { beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication, prepareCurrentRunEvidencePublication, readCurrentRunEvidencePublication, recoverCurrentRunEvidencePublication } = await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const { createRequiredEvidenceBinding } = await import(new URL('../../tools/release/required-evidence-binding.mjs', import.meta.url));
const { createReleaseFinalVerifiedAuthorityBinding, verifyReleaseFinalVerifiedAuthorityBinding, assessReleaseFinalTerminalPrerequisites } = await import(new URL('../../tools/release/test-evidence-receipts.mjs', import.meta.url));
const { consumeReleaseFinalVerifiedBindings, assessReleaseFinalTerminalPrerequisites: assessFinalizerPrerequisites } = await import(new URL('../../tools/release/check-release-final.mjs', import.meta.url));
const { publishReleaseFinalVerifiedAuthorityBinding, verifyPublishedReleaseFinalAuthorityBinding,
    releaseFinalBindingOutputRegistration, runReleaseFinalBindingProducer } = await import(new URL('../../tools/release/publish-release-final-bindings.mjs', import.meta.url));

const matrix = parseMatrix(fs.readFileSync(new URL('../../tests/matrix.yml', import.meta.url), 'utf8'));
const rawDigest = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const finalOutputPath = 'artifacts/current-run/final-binding.reference.json';

// Enumerates the real catalog with explicitly controlled owners. These model
// fixtures prove consumer refusal/replay, never actual product qualification.
async function finalFixture(t, { includeFinalizerInput = false, includeFinalOutput = false } = {})
{
    const f = controlledRequiredEvidenceFixture(t, { preserveCanonicalVerifierRefs: true });
    if (includeFinalizerInput)
    {
        const canonical = JSON.parse(fs.readFileSync(new URL('../../config/testing/evidence-locator-registry.json', import.meta.url)));
        f.locatorRegistry.entries.push(canonical.entries.find((entry) =>
            entry.consumerId === 'evidence-consumer.release.check-release-final'));
        f.locatorRegistry.contentDigest = governanceContentDigest(f.locatorRegistry);
    }
    if (includeFinalOutput)
    {
        f.locatorRegistry.entries.push(structuredClone(releaseFinalBindingOutputRegistration));
        f.locatorRegistry.contentDigest = governanceContentDigest(f.locatorRegistry);
    }
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

test('actual final-binding producer publishes immutable v2 bytes through the registered owner and independently reads them back', async (t) =>
{
    const bindings = await finalFixture(t, { includeFinalOutput: true, includeFinalizerInput: true });
    const result = await publishReleaseFinalVerifiedAuthorityBinding({ bindings, outputPath: finalOutputPath });
    assert.equal(result.status, 'published-uncommitted');
    assert.equal(result.qualificationEligible, false);
    const wrapperBytes = fs.readFileSync(path.join(bindings.repositoryRoot, result.reference.path));
    const wrapper = JSON.parse(wrapperBytes);
    assert.equal(rawDigest(wrapperBytes), result.reference.objectDigest);
    assert.equal(wrapper.authorityId, releaseFinalBindingOutputRegistration.authorityId);
    assert.equal(wrapper.producerId, releaseFinalBindingOutputRegistration.producerId);
    assert.equal(wrapper.payload.schema, 'fsusblog.release-final-test-evidence-binding.v2');
    assert.equal(wrapper.payload.digest, result.payloadDigest);
    assert.equal(path.basename(wrapper.payload.path), `release-final-bindings.${result.payloadDigest.slice(7)}.json`);
    const verified = await verifyPublishedReleaseFinalAuthorityBinding({ bindings,
        reference: result.reference, handoffReference: result.handoffReference });
    assert.equal(verified.binding.authorities.length, bindings.catalog.entries.length);
    assert.equal(verified.binding.contentDigest, result.bindingDigest);
    assert.equal(verified.binding.status, 'verified-bindings-unpublished');
    assert.equal(verified.qualificationEligible, false, 'publication is not scheduler or domain qualification');
    for (const [index, entry] of bindings.catalog.entries.entries())
    {
        assert.deepEqual(verified.binding.authorities[index].verifiedBinding.idChecks.requiredTestIds.expected, entry.requiredTestIds);
        assert.deepEqual(verified.binding.authorities[index].verifiedBinding.idChecks.requiredCoverageIds.expected, entry.requiredCoverageIds);
        assert.deepEqual(verified.binding.authorities[index].verifiedBinding.idChecks.requiredArtifactIds.expected, entry.requiredArtifactIds);
    }
    assert.deepEqual(await verifyPublishedReleaseFinalAuthorityBinding({ bindings,
        explicitInputs: [finalOutputPath], handoffReference: result.handoffReference }), verified);
    await assert.rejects(publishReleaseFinalVerifiedAuthorityBinding({ bindings, outputPath: finalOutputPath }), /already has a final reference/u);
    assert.deepEqual(fs.readFileSync(path.join(bindings.repositoryRoot, result.reference.path)), wrapperBytes);
    assert.equal(bindings.locatorRegistry.entries.find((entry) =>
        entry.consumerId === 'evidence-consumer.release.check-release-final').producerExecutable,
    'bash tools/operations/collect-release-evidence.sh --require-ok');
});

test('missing final output registration refuses before creating any publication or output', async (t) =>
{
    const bindings = await finalFixture(t);
    const before = fs.readdirSync(path.join(bindings.repositoryRoot, 'artifacts/current-run'));
    await assert.rejects(publishReleaseFinalVerifiedAuthorityBinding({ bindings, outputPath: finalOutputPath }),
        (error) => error.reasonCode === 'FINAL_OUTPUT_NOT_REGISTERED');
    assert.deepEqual(fs.readdirSync(path.join(bindings.repositoryRoot, 'artifacts/current-run')), before);
    bindings.locatorRegistry.entries.push({ ...releaseFinalBindingOutputRegistration, outputBindingKey: 'COLLECTOR_INPUT' });
    bindings.locatorRegistry.contentDigest = governanceContentDigest(bindings.locatorRegistry);
    await assert.rejects(publishReleaseFinalVerifiedAuthorityBinding({ bindings, outputPath: finalOutputPath }),
        (error) => error.reasonCode === 'FINAL_OUTPUT_NOT_REGISTERED');
    assert.deepEqual(fs.readdirSync(path.join(bindings.repositoryRoot, 'artifacts/current-run')), before);
});

test('final output generation refuses missing bindings and raw fallback without a publication or any producer process', async (t) =>
{
    const bindings = await finalFixture(t, { includeFinalOutput: true });
    const before = fs.readdirSync(path.join(bindings.repositoryRoot, 'artifacts/current-run'));
    let calls = 0;
    const originals = new Map();
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
    {
        originals.set(key, childProcess[key]);
        childProcess[key] = () =>
        {
            calls += 1;
            throw new Error('producer execution forbidden');
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
    await assert.rejects(publishReleaseFinalVerifiedAuthorityBinding({
        bindings: { ...bindings, bindingInputs: bindings.bindingInputs.slice(1) }, outputPath: finalOutputPath }),
    (error) => error.reasonCode === 'MISSING_BINDINGS'
        && assert.deepEqual(error.localProducerCommands, [bindings.catalog.entries[0].localProducerCommand]) === undefined);
    const bindingInputs = structuredClone(bindings.bindingInputs);
    bindingInputs[0].explicitInputs = bindingInputs[0].verification.explicitInputs;
    await assert.rejects(publishReleaseFinalVerifiedAuthorityBinding({
        bindings: { ...bindings, bindingInputs }, outputPath: finalOutputPath }), /binding is not successful/u);
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(path.join(bindings.repositoryRoot, 'artifacts/current-run')), before);
});

test('final output producer rejects escaping paths, prebuilt payloads and injected callbacks', async (t) =>
{
    const bindings = await finalFixture(t, { includeFinalOutput: true });
    for (const outputPath of ['../final.json', '/tmp/final.json', 'artifacts/current-run/./final.json', 'tools/final.json'])
    {
        await assert.rejects(publishReleaseFinalVerifiedAuthorityBinding({ bindings, outputPath }),
            (error) => error.reasonCode === 'OUTPUT_PATH_REJECTED');
    }
    for (const extra of [{ binding: {} }, { payload: {} }, { persist: () =>
    {} }, { qualified: true }])
    {
        await assert.rejects(publishReleaseFinalVerifiedAuthorityBinding({ bindings, outputPath: finalOutputPath, ...extra }),
            (error) => error.reasonCode === 'UNSUPPORTED_INPUT');
    }
    assert.equal(fs.existsSync(path.join(bindings.repositoryRoot, finalOutputPath)), false);
});

test('fresh final output readback rejects payload, wrapper, handoff and original authority changes', async (t) =>
{
    const bindings = await finalFixture(t, { includeFinalOutput: true });
    const result = await publishReleaseFinalVerifiedAuthorityBinding({ bindings, outputPath: finalOutputPath });
    const output = path.join(bindings.repositoryRoot, finalOutputPath);
    const wrapper = JSON.parse(fs.readFileSync(output));
    for (const relative of [wrapper.payload.path, finalOutputPath, result.handoffReference.path])
    {
        const file = path.join(bindings.repositoryRoot, relative);
        const before = fs.readFileSync(file);
        fs.appendFileSync(file, ' ');
        await assert.rejects(verifyPublishedReleaseFinalAuthorityBinding({ bindings,
            reference: result.reference, handoffReference: result.handoffReference }), /digest mismatch/u);
        fs.writeFileSync(file, before);
    }
    await assert.rejects(verifyPublishedReleaseFinalAuthorityBinding({ bindings,
        reference: result.reference, explicitInputs: [finalOutputPath], handoffReference: result.handoffReference }),
    (error) => error.reasonCode === 'UNSUPPORTED_INPUT');
    await assert.rejects(verifyPublishedReleaseFinalAuthorityBinding({ bindings,
        reference: result.reference, handoffReference: { ...result.handoffReference, path: 'artifacts/current-run/other.json' } }),
    (error) => error.reasonCode === 'HANDOFF_REJECTED');
    const inputs = structuredClone(bindings.bindingInputs);
    inputs[0].verification.expectedIdentity.policyIdentity = `sha256:${'0'.repeat(64)}`;
    await assert.rejects(verifyPublishedReleaseFinalAuthorityBinding({ bindings: { ...bindings, bindingInputs: inputs },
        reference: result.reference, handoffReference: result.handoffReference }), /mismatch/u);
});

test('ordinary payload write failure publishes no consumable reference or handoff', async (t) =>
{
    const bindings = await finalFixture(t, { includeFinalOutput: true });
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) =>
    {
        if (/release-final-bindings\.[a-f0-9]{64}\.json$/u.test(String(file)))
        {
            throw new Error('task payload disk failure');
        }
        return write(file, ...args);
    };
    syncBuiltinESMExports();
    try
    {
        await assert.rejects(publishReleaseFinalVerifiedAuthorityBinding({ bindings, outputPath: finalOutputPath }), /task payload disk failure/u);
    }
    finally
    {
        fs.writeFileSync = write;
        syncBuiltinESMExports();
    }
    assert.equal(fs.existsSync(path.join(bindings.repositoryRoot, finalOutputPath)), false);
    assert.equal(fs.existsSync(path.join(bindings.repositoryRoot, `${finalOutputPath}.handoff.json`)), false);
    assert.equal(readCurrentRunEvidencePublication({ outputPath: finalOutputPath, repositoryRoot: bindings.repositoryRoot }).state.state, 'prepared');
    await assert.rejects(verifyPublishedReleaseFinalAuthorityBinding({ bindings, explicitInputs: [finalOutputPath] }), /missing/u);
});

test('canonical CLI producer consumes explicit owned original inputs and refuses flags or digest substitution', async (t) =>
{
    const bindings = await finalFixture(t, { includeFinalOutput: true });
    const registryPath = path.join(bindings.repositoryRoot, 'config/testing/evidence-locator-registry.json');
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify(bindings.locatorRegistry));
    const inputPath = 'artifacts/current-run/final-producer-inputs.json';
    const inputs = Object.fromEntries(['context', 'expectedPlanIdentity', 'testPlan', 'bindingInputs'].map((key) => [key, bindings[key]]));
    const bytes = Buffer.from(JSON.stringify(inputs));
    fs.writeFileSync(path.join(bindings.repositoryRoot, inputPath), bytes);
    const argv = ['--inputs', inputPath, '--inputs-digest', rawDigest(bytes), '--output', finalOutputPath];
    const options = { repositoryRoot: bindings.repositoryRoot };
    await assert.rejects(runReleaseFinalBindingProducer([...argv, '--qualified', 'true'], options), /unique/u);
    await assert.rejects(runReleaseFinalBindingProducer([...argv, '--output', 'other'], options), /unique/u);
    const badDigest = [...argv];
    badDigest[3] = `sha256:${'0'.repeat(64)}`;
    await assert.rejects(runReleaseFinalBindingProducer(badDigest, options), /input digest mismatch/u);
    const result = await runReleaseFinalBindingProducer(argv, options);
    assert.equal(result.status, 'published-uncommitted');
    assert.equal(result.qualificationEligible, false);
    assert.equal((await verifyPublishedReleaseFinalAuthorityBinding({ bindings,
        reference: result.reference, handoffReference: result.handoffReference })).binding.authorities.length,
    bindings.catalog.entries.length);
});

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

test('terminal intake replays every binding but requires canonical final-output and durable commit contracts with zero mutation/spawn', async (t) =>
{
    const bindings = await finalFixture(t);
    const methods = new Map();
    let mutations = 0;
    for (const [owner, keys] of [[childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
        [fs, ['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'mkdirSync']]])
    {
        for (const key of keys)
        {
            methods.set(owner[key], { owner, key });
            owner[key] = () =>
            {
                mutations += 1;
                throw new Error('terminal intake must be read-only');
            };
        }
    }
    syncBuiltinESMExports();
    try
    {
        const local = await assessReleaseFinalTerminalPrerequisites({ bindings });
        const ci = await assessFinalizerPrerequisites({ bindings });
        assert.deepEqual(local, ci);
        assert.equal(local.status, 'blocked');
        assert.equal(local.qualificationEligible, false);
        assert.deepEqual(local.reasonCodes, ['CANONICAL_FINAL_OUTPUT_UNAVAILABLE', 'DURABLE_COMMIT_READBACK_UNAVAILABLE']);
        assert.equal(local.missingContracts[0].owner, 'tools/test/generate-evidence-location-governance.mjs');
        assert.ok(local.missingContracts[0].fields.includes('finalOutput.outputBindingKey'));
        assert.equal(local.missingContracts[1].privateReadApi, 'readCheckpoint');
        assert.equal(Object.isFrozen(local.observations), true);
        for (const entry of bindings.catalog.entries)
        {
            const missing = await assessFinalizerPrerequisites({ bindings: { ...bindings,
                bindingInputs: bindings.bindingInputs.filter((input) => input.authorityId !== entry.authorityId) } });
            assert.deepEqual(missing.localProducerCommands, [entry.localProducerCommand]);
            assert.equal(missing.status, 'blocked');
        }
        assert.equal(mutations, 0);
    }
    finally
    {
        for (const [original, { owner, key }] of methods)
        {
            owner[key] = original;
        }
        syncBuiltinESMExports();
    }
});

test('terminal intake enumerates catalog missing commands and refuses binding fallback before inspecting alleged commit', async (t) =>
{
    const bindings = await finalFixture(t);
    for (const entry of bindings.catalog.entries)
    {
        const result = await assessReleaseFinalTerminalPrerequisites({ bindings: { ...bindings,
            bindingInputs: bindings.bindingInputs.filter((input) => input.authorityId !== entry.authorityId) },
        durableCommit: { reference: { path: 'artifacts/current-run/never-read.json', digest: `sha256:${'0'.repeat(64)}` },
            expectedRevision: 1 } });
        assert.equal(result.status, 'blocked');
        assert.deepEqual(result.reasonCodes, ['MISSING_BINDINGS']);
        assert.deepEqual(result.localProducerCommands, [entry.localProducerCommand]);
        assert.equal(result.observations.durableCommitInput, undefined);
    }
    const inputs = structuredClone(bindings.bindingInputs);
    inputs[0].explicitInputs = inputs[0].verification.explicitInputs;
    const result = await assessReleaseFinalTerminalPrerequisites({ bindings: { ...bindings, bindingInputs: inputs } });
    assert.equal(result.status, 'rejected');
    assert.deepEqual(result.reasonCodes, ['BINDING_NOT_SUCCESS']);
});

test('terminal intake rejects injected verdicts, callbacks, CI status and unsupported revision/reference inputs', async (t) =>
{
    const bindings = await finalFixture(t);
    for (const extra of [{ status: 'success' }, { workflowUrl: 'https://example.invalid/success' },
        { verifyCommit: () => true }, { manifest: { qualificationEligible: true } }])
    {
        await assert.rejects(assessReleaseFinalTerminalPrerequisites({ bindings, ...extra }), /only explicit/u);
    }
    await assert.rejects(assessReleaseFinalTerminalPrerequisites({ bindings,
        finalOutput: { explicitInputs: [], status: 'success' } }), /only canonical locator/u);
    await assert.rejects(assessReleaseFinalTerminalPrerequisites({ bindings,
        finalOutput: { reference: { path: 'x', objectDigest: 'x', verified: true } } }), /only typed explicit/u);
    for (const durableCommit of [{ expectedRevision: 0 }, { expectedRevision: 1, reference: {}, committed: true },
        { expectedRevision: 1, reference: { path: 'x', digest: 'x', verify: () => true } }])
    {
        await assert.rejects(assessReleaseFinalTerminalPrerequisites({ bindings, durableCommit }), /independently expected revision/u);
    }
});

test('raw committed checkpoint bytes cannot acquire durable CAS authority and tampered/escaping references reject', async (t) =>
{
    const bindings = await finalFixture(t);
    const relative = 'artifacts/current-run/checkpoint.json';
    const file = path.join(bindings.repositoryRoot, relative);
    const bytes = Buffer.from(JSON.stringify({ status: 'success', committed: true, revision: 7,
        runId: bindings.context.schedulerRunId, qualificationEligible: true }));
    fs.writeFileSync(file, bytes);
    const reference = { path: relative, digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` };
    const result = await assessReleaseFinalTerminalPrerequisites({ bindings,
        durableCommit: { reference, expectedRevision: 7 } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.observations.durableCommitInput.inputDigest, reference.digest);
    assert.ok(result.reasonCodes.includes('DURABLE_COMMIT_READBACK_UNAVAILABLE'));
    for (const invalid of [{ ...reference, digest: `sha256:${'0'.repeat(64)}` },
        { ...reference, path: '../checkpoint.json' }])
    {
        const rejected = await assessReleaseFinalTerminalPrerequisites({ bindings,
            durableCommit: { reference: invalid, expectedRevision: 7 } });
        assert.equal(rejected.status, 'rejected');
        assert.deepEqual(rejected.reasonCodes, ['PERSISTENCE_INPUT_REJECTED']);
    }
});

// Reuse the actual registered collector INPUT slot and publication API. These
// controlled bytes never manufacture a canonical final-output authority.
async function finalizerInputFixture(t, { prepareOnly = false } = {})
{
    const bindings = await finalFixture(t, { includeFinalizerInput: true });
    const entry = bindings.locatorRegistry.entries.find((item) =>
        item.consumerId === 'evidence-consumer.release.check-release-final');
    const outputPath = 'artifacts/current-run/collector.ref.json';
    const payloadPath = 'artifacts/current-run/collector.json';
    const payload = await createReleaseFinalVerifiedAuthorityBinding(bindings);
    const session = beginCurrentRunEvidencePublication({ authorityId: entry.authorityId,
        producerId: entry.producerId, context: bindings.context, outputPath, payloadPath,
        repositoryRoot: bindings.repositoryRoot });
    fs.writeFileSync(path.join(bindings.repositoryRoot, payloadPath), JSON.stringify(payload));
    const publicationOptions = { authorityId: entry.authorityId, producerId: entry.producerId,
        context: bindings.context, outputPath, payloadPath, payloadSchema: payload.schema,
        repositoryRoot: bindings.repositoryRoot, sessionId: session.sessionId, terminalStatus: 'success' };
    if (prepareOnly)
    {
        const prepared = prepareCurrentRunEvidencePublication(publicationOptions);
        fs.renameSync(prepared.staged, path.join(bindings.repositoryRoot, outputPath));
    }
    else
    {
        finalizeCurrentRunEvidencePublication(publicationOptions);
    }
    return { bindings, finalOutput: { explicitInputs: [outputPath] } };
}

test('finalized collector input with verified v2 payload remains blocked; resigned bytes and ambiguous inputs reject', async (t) =>
{
    const options = await finalizerInputFixture(t);
    const result = await assessFinalizerPrerequisites(options);
    assert.equal(result.status, 'blocked');
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.observations.finalizerInput.producerExecutable, 'bash tools/operations/collect-release-evidence.sh --require-ok');
    assert.equal(result.observations.finalizerInput.payloadSchema, 'fsusblog.release-final-test-evidence-binding.v2');
    const absolute = await assessFinalizerPrerequisites({ ...options,
        finalOutput: { explicitInputs: [path.join(options.bindings.repositoryRoot, options.finalOutput.explicitInputs[0])] } });
    assert.equal(absolute.status, 'blocked', 'the registered locator permits an explicit owned absolute path');
    const ambiguous = await assessFinalizerPrerequisites({ ...options,
        finalOutput: { explicitInputs: [...options.finalOutput.explicitInputs, ...options.finalOutput.explicitInputs] } });
    assert.equal(ambiguous.status, 'rejected');
    const file = path.join(options.bindings.repositoryRoot, options.finalOutput.explicitInputs[0]);
    fs.appendFileSync(file, ' ');
    const changed = await assessFinalizerPrerequisites(options);
    assert.equal(changed.status, 'rejected');
    assert.match(changed.failure, /publication reference mismatch/u);
});

test('interrupted publication exposes no qualified final output; prepared state and pointer tamper reject', async (t) =>
{
    const options = await finalizerInputFixture(t, { prepareOnly: true });
    const result = await assessFinalizerPrerequisites(options);
    assert.equal(result.status, 'rejected');
    assert.match(result.failure, /not finalized/u);
    const publication = readCurrentRunEvidencePublication({
        outputPath: options.finalOutput.explicitInputs[0], repositoryRoot: options.bindings.repositoryRoot });
    fs.appendFileSync(publication.stateFile, ' ');
    const tampered = await assessFinalizerPrerequisites(options);
    assert.equal(tampered.status, 'rejected');
    assert.match(tampered.failure, /pointer target digest mismatch/u);
});

test('owner publication recovery and repeated intake retain canonical contract blockers without promoting publication to CAS authority', async (t) =>
{
    const options = await finalizerInputFixture(t, { prepareOnly: true });
    const recoveryOptions = { context: options.bindings.context,
        outputPath: options.finalOutput.explicitInputs[0], repositoryRoot: options.bindings.repositoryRoot };
    const interrupted = await assessFinalizerPrerequisites(options);
    assert.equal(interrupted.status, 'rejected');
    const recovered = recoverCurrentRunEvidencePublication(recoveryOptions);
    assert.equal(recovered.state.state, 'finalized');
    assert.ok(recovered.handoff, 'actual owner recovery completes its sealed handoff');
    const first = await assessFinalizerPrerequisites(options);
    assert.equal(first.status, 'blocked');
    assert.equal(first.qualificationEligible, false);
    assert.deepEqual(first.reasonCodes, ['CANONICAL_FINAL_OUTPUT_UNAVAILABLE', 'DURABLE_COMMIT_READBACK_UNAVAILABLE']);
    const repeatedRecovery = recoverCurrentRunEvidencePublication(recoveryOptions);
    assert.equal(repeatedRecovery.state.contentDigest, recovered.state.contentDigest);
    const files = [recoveryOptions.outputPath, `${recoveryOptions.outputPath}.publication.json`,
        `${recoveryOptions.outputPath}.handoff.json`].map((file) => path.join(options.bindings.repositoryRoot, file));
    const before = files.map((file) => fs.readFileSync(file));
    assert.deepEqual(await assessReleaseFinalTerminalPrerequisites(options), first);
    assert.deepEqual(await assessFinalizerPrerequisites(options), first);
    assert.deepEqual(files.map((file) => fs.readFileSync(file)), before, 'repeated intake leaves owner publication bytes unchanged');
});

test('missing explicit collector reference refuses a valid same-run alternate with zero search or producer execution', async (t) =>
{
    const options = await finalizerInputFixture(t);
    const root = options.bindings.repositoryRoot;
    const original = path.join(root, options.finalOutput.explicitInputs[0]);
    const alternatePath = 'artifacts/current-run/same-run-alternate.ref.json';
    const alternate = path.join(root, alternatePath);
    fs.copyFileSync(original, alternate);
    const registryEntry = options.bindings.locatorRegistry.entries.find((entry) =>
        entry.consumerId === 'evidence-consumer.release.check-release-final');
    const admittedAlternate = locateCurrentRunEvidence({ context: options.bindings.context,
        registry: options.bindings.locatorRegistry, registryEntry, repositoryRoot: root,
        explicitInputs: [alternatePath] });
    assert.equal(admittedAlternate.bindingReceipt.identityVerified, true,
        'negative control is an actual locator-valid alternate, not a malformed decoy');
    fs.unlinkSync(original);
    const readFileSync = fs.readFileSync;
    const processes = new Map();
    let alternateReads = 0;
    let processCalls = 0;
    fs.readFileSync = (file, ...args) =>
    {
        if (typeof file === 'string' && path.resolve(file) === alternate)
        {
            alternateReads += 1;
        }
        return readFileSync(file, ...args);
    };
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
    {
        processes.set(key, childProcess[key]);
        childProcess[key] = () =>
        {
            processCalls += 1;
            throw new Error('intake cannot repair missing references');
        };
    }
    syncBuiltinESMExports();
    try
    {
        const refusal = await assessFinalizerPrerequisites(options);
        assert.equal(refusal.status, 'rejected');
        assert.equal(refusal.qualificationEligible, false);
        assert.match(refusal.failure, /explicit evidence path is missing/u);
        assert.equal(refusal.observations.finalizerInput, undefined);
        assert.equal(alternateReads, 0);
        assert.equal(processCalls, 0);
    }
    finally
    {
        fs.readFileSync = readFileSync;
        for (const [key, originalMethod] of processes)
        {
            childProcess[key] = originalMethod;
        }
        syncBuiltinESMExports();
    }
});
