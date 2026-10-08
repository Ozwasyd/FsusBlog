import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
    entryContentDigest, ledgerContentDigest, loadCanonicalRequiredEvidenceCatalog,
    producerContractDigest
} = await import(new URL('../../tools/test-matrix/required-evidence-catalog.mjs', import.meta.url));
const {
    completeEvidenceLocatorRegistryEntry, governanceContentDigest
} = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const {
    beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication
} = await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const {
    evidenceContentDigest, evidenceProducerReceiptDigest
} = await import(new URL('../../tools/test/current-run-evidence-locator.mjs', import.meta.url));
const {
    createDomainVerifierRegistry, verifyDomainVerifierRegistry
} = await import(new URL('../../tools/release/required-evidence-verifier-registry.mjs', import.meta.url));
const {
    createRequiredEvidenceBinding, verifyRequiredEvidenceBinding
} = await import(new URL('../../tools/release/required-evidence-binding.mjs', import.meta.url));

const digest = (value) => `sha256:${value.repeat(64)}`;

// Controlled owner fixtures exercise the generic boundary for every catalog
// authority. They are not receipts from the product's native/runtime producers.
function fixture(t)
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'required-evidence-binding-'));
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(repositoryRoot, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(repositoryRoot, 'artifacts/current-run'), { recursive: true });
    const source = `export const requiredEvidenceVerifier = {
        version: 1, successStatuses: Object.freeze(['success']),
        describe(receipt) { return receipt.bindingFields; },
        verify({receipt}) {
            if (receipt.business?.verified !== true) return {status:'failed',reasonCodes:['BUSINESS_FAILURE']};
            return {status:'success',reasonCodes:[],businessProof:receipt.business};
        }
    };\n`;
    fs.writeFileSync(path.join(repositoryRoot, 'tools/fixture-owner.mjs'), source);
    const catalog = loadCanonicalRequiredEvidenceCatalog();
    for (const entry of catalog.entries)
    {
        entry.producerVerifier = 'tools/fixture-owner.mjs:requiredEvidenceVerifier';
        entry.producerDigest = producerContractDigest(entry);
        entry.contentDigest = entryContentDigest(entry);
    }
    catalog.contentDigest = ledgerContentDigest(catalog);
    const registryBody = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1,
        entries: catalog.entries.map((entry) => completeEvidenceLocatorRegistryEntry({
            consumerId: `required-evidence.${entry.authorityId}`,
            authorityId: entry.locatorBindingKey, producerId: entry.canonicalOwner,
            receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
            requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint'],
            requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
            allowedRoots: ['artifacts/current-run'], producerCommand: entry.localProducerCommand,
            outputBindingKey: entry.outputBindingKey
        })) };
    const locatorRegistry = { ...registryBody, contentDigest: governanceContentDigest(registryBody) };
    const contextBody = { schema: 'fsusblog.current-run-evidence-context.v1',
        schedulerRunId: 'controlled-binding-run', attemptId: 'controlled-attempt',
        sourceCommit: 'a'.repeat(40), worktreeFingerprint: digest('b'),
        candidateIdentity: { id: 'candidate', digest: digest('c'), imageIdentity: digest('e'), policyIdentity: digest('f') },
        buildIdentity: { id: 'build', digest: digest('d') }, ownedRoots: ['artifacts/current-run'] };
    const context = { ...contextBody, contentDigest: governanceContentDigest(contextBody) };
    const verifierRegistry = createDomainVerifierRegistry({ catalog, repositoryRoot });
    return { repositoryRoot, catalog, locatorRegistry, context, verifierRegistry };
}

function publish(f, entry, change = () =>
{})
{
    const identity = Object.fromEntries(entry.requiredIdentityFields.map((key) => [key, digest('a')]));
    for (const [key, value] of Object.entries({ sourceCommit: f.context.sourceCommit,
        worktreeFingerprint: f.context.worktreeFingerprint, runId: f.context.schedulerRunId,
        policyIdentity: digest('f') }))
    {
        if (Object.hasOwn(identity, key) || ['sourceCommit', 'worktreeFingerprint', 'runId'].includes(key))
        {
            identity[key] = value;
        }
    }
    const payload = {
        schema: entry.receiptSchema,
        bindingFields: { identity, testIds: [...entry.requiredTestIds], coverageIds: [...entry.requiredCoverageIds],
            artifactIds: [...entry.requiredArtifactIds], contentDigest: digest('a'), status: 'success', evidenceClass: 'correctness' },
        business: { verified: true, assertion: entry.authorityId }
    };
    const expectedIdentity = { ...identity, imageIdentity: digest('e'), policyIdentity: digest('f') };
    change(payload);
    const outputPath = `artifacts/current-run/${entry.authorityId}.reference.json`;
    const payloadPath = `artifacts/current-run/${entry.authorityId}.payload.json`;
    const session = beginCurrentRunEvidencePublication({ authorityId: entry.locatorBindingKey,
        producerId: entry.canonicalOwner, context: f.context, outputPath, payloadPath,
        repositoryRoot: f.repositoryRoot });
    fs.writeFileSync(path.join(f.repositoryRoot, payloadPath), `${JSON.stringify(payload)}\n`);
    if (Object.hasOwn(expectedIdentity, 'fileDigest'))
    {
        expectedIdentity.fileDigest = `sha256:${crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(f.repositoryRoot, payloadPath))).digest('hex')}`;
    }
    finalizeCurrentRunEvidencePublication({ authorityId: entry.locatorBindingKey, producerId: entry.canonicalOwner,
        context: f.context, outputPath, payloadPath, payloadSchema: entry.receiptSchema,
        repositoryRoot: f.repositoryRoot, sessionId: session.sessionId, terminalStatus: 'success' });
    return { ...f, authorityId: entry.authorityId, expectedIdentity, explicitInputs: [outputPath] };
}

test('every catalog authority gets exact-one generic and owner verification, independently replayed', async (t) =>
{
    const f = fixture(t);
    for (const entry of f.catalog.entries)
    {
        const options = publish(f, entry);
        const binding = await createRequiredEvidenceBinding(options);
        assert.equal(binding.status, 'success');
        assert.equal(binding.authorityId, entry.authorityId);
        assert.equal(binding.domainVerifier.result.businessProof.assertion, entry.authorityId);
        assert.deepEqual(await verifyRequiredEvidenceBinding(binding, options), binding);
    }
});

test('missing or multiple explicit receipts reject without executing the owner or a producer', async (t) =>
{
    const f = fixture(t);
    const calls = [];
    const originals = new Map();
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
    {
        originals.set(method, childProcess[method]);
        childProcess[method] = (...args) =>
        {
            calls.push({ method, args });
            throw new Error('producer execution is forbidden in a binding verifier');
        };
    }
    syncBuiltinESMExports();
    t.after(() =>
    {
        for (const [method, original] of originals)
        {
            childProcess[method] = original;
        }
        syncBuiltinESMExports();
    });
    const entry = f.catalog.entries[0];
    const options = { ...f, authorityId: entry.authorityId, expectedIdentity: {} };
    await assert.rejects(createRequiredEvidenceBinding({ ...options, explicitInputs: [] }),
        (error) => error.reasonCode === 'MISSING_EVIDENCE' && error.localProducerCommand === entry.localProducerCommand);
    await assert.rejects(createRequiredEvidenceBinding({ ...options, explicitInputs: ['a', 'b'] }),
        (error) => error.reasonCode === 'AMBIGUOUS_EVIDENCE');
    assert.equal(fs.readdirSync(path.join(f.repositoryRoot, 'artifacts/current-run')).length, 0);
    assert.equal(calls.length, 0, 'missing/ambiguous evidence must perform zero process executions');
});

test('all source/worktree/run/build/image/policy bindings are exact and never commit-only', async (t) =>
{
    const f = fixture(t);
    const options = publish(f, f.catalog.entries[0]);
    for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint', 'candidateIdentity', 'buildIdentity'])
    {
        const context = structuredClone(f.context);
        context[field] = typeof context[field] === 'object' ? { ...context[field], id: 'wrong' } : 'wrong';
        context.contentDigest = governanceContentDigest(context);
        await assert.rejects(createRequiredEvidenceBinding({ ...options, context }),
            (error) => error.reasonCode === 'LOCATOR_REJECTED');
    }
    for (const field of Object.keys(options.expectedIdentity))
    {
        await assert.rejects(createRequiredEvidenceBinding({ ...options,
            expectedIdentity: { ...options.expectedIdentity, [field]: digest('9') } }),
        (error) => error.reasonCode === 'IDENTITY_MISMATCH');
    }
});

test('required IDs reject missing/duplicate/unknown and status/classification cannot substitute success', async (t) =>
{
    for (const mutate of [
        (r) =>
        {
            r.bindingFields.testIds = [];
        },
        (r) =>
        {
            r.bindingFields.testIds.push(r.bindingFields.testIds[0]);
        },
        (r) =>
        {
            r.bindingFields.testIds.push('unknown-correctness');
        },
        (r) =>
        {
            r.bindingFields.artifactIds = [];
        },
        (r) =>
        {
            r.bindingFields.status = 'cancelled';
        },
        (r) =>
        {
            r.bindingFields.evidenceClass = 'diagnostic';
        },
        (r) =>
        {
            r.business.verified = false;
        },
        (r) =>
        {
            delete r.business.verified;
        },
        (r) =>
        {
            delete r.bindingFields;
        }
    ])
    {
        const f = fixture(t);
        const entry = f.catalog.entries.find((candidate) => candidate.requiredTestIds.length > 0);
        const options = publish(f, entry, mutate);
        await assert.rejects(createRequiredEvidenceBinding(options));
    }
});

test('explicit tamper fails even when a valid same-schema alternative exists', async (t) =>
{
    const f = fixture(t);
    const options = publish(f, f.catalog.entries[0]);
    const original = path.join(f.repositoryRoot, options.explicitInputs[0]);
    fs.copyFileSync(original, path.join(f.repositoryRoot, 'artifacts/current-run/alternative.json'));
    const reference = JSON.parse(fs.readFileSync(original));
    reference.attemptId = 'other-run';
    reference.contentDigest = evidenceContentDigest(reference);
    reference.producerReceiptDigest = evidenceProducerReceiptDigest(reference);
    fs.writeFileSync(original, JSON.stringify(reference));
    await assert.rejects(createRequiredEvidenceBinding(options), /attemptId mismatch/u);
    await assert.rejects(createRequiredEvidenceBinding({ ...options, searchRoots: ['artifacts/current-run'] }), /does not accept/u);
});

test('registry missing/duplicate/unknown owner, owner/version drift and binding tamper fail closed', async (t) =>
{
    const f = fixture(t);
    const options = publish(f, f.catalog.entries[0]);
    const binding = await createRequiredEvidenceBinding(options);
    for (const mutate of [
        (r) =>
        {
            r.entries.pop();
        },
        (r) =>
        {
            r.entries.push(r.entries[0]);
        },
        (r) =>
        {
            r.entries[0].owner = 'unknown';
        },
        (r) =>
        {
            r.entries[0].version += 1;
        },
        (r) =>
        {
            r.catalogVersion += 1;
        },
        (r) =>
        {
            r.catalogDigest = digest('0');
        }
    ])
    {
        const registry = structuredClone(f.verifierRegistry);
        mutate(registry);
        registry.contentDigest = governanceContentDigest(registry);
        assert.throws(() => verifyDomainVerifierRegistry(registry, f), /drift/u);
    }
    const changed = structuredClone(binding);
    changed.domainVerifier.result.status = 'failed';
    changed.contentDigest = governanceContentDigest(changed);
    await assert.rejects(verifyRequiredEvidenceBinding(changed, options), /independent/u);
    fs.appendFileSync(path.join(f.repositoryRoot, 'tools/fixture-owner.mjs'), '// drift\n');
    await assert.rejects(verifyRequiredEvidenceBinding(binding, options), /drift/u);
});

test('a resigned diagnostic catalog cannot replace a required correctness authority', (t) =>
{
    const f = fixture(t);
    const entry = f.catalog.entries[0];
    entry.allowDiagnostic = true;
    entry.exactness = 'diagnostic-only';
    entry.producerDigest = producerContractDigest(entry);
    entry.contentDigest = entryContentDigest(entry);
    f.catalog.contentDigest = ledgerContentDigest(f.catalog);
    assert.throws(() => createDomainVerifierRegistry(f), /reduces the required evidence set|cannot satisfy a correctness/u);
});

test('changed producer bytes, missing owner API and original identity omissions reject', async (t) =>
{
    const f = fixture(t);
    const entry = f.catalog.entries[0];
    const options = publish(f, entry);
    const payload = path.join(f.repositoryRoot, `artifacts/current-run/${entry.authorityId}.payload.json`);
    fs.appendFileSync(payload, ' ');
    await assert.rejects(createRequiredEvidenceBinding(options), /digest/u);

    const fresh = fixture(t);
    const missing = publish(fresh, fresh.catalog.entries[0], (receipt) =>
    {
        delete receipt.bindingFields.identity.worktreeFingerprint;
    });
    await assert.rejects(createRequiredEvidenceBinding(missing), (error) => error.reasonCode === 'IDENTITY_MISMATCH');

    const absent = fixture(t);
    fs.writeFileSync(path.join(absent.repositoryRoot, 'tools/fixture-owner.mjs'), 'export const otherApi = {};\n');
    absent.verifierRegistry = createDomainVerifierRegistry(absent);
    const absentOptions = publish(absent, absent.catalog.entries[0]);
    await assert.rejects(createRequiredEvidenceBinding(absentOptions), /owner verifier API is missing/u);
});
