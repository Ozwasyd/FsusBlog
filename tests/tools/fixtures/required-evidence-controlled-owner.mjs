import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { entryContentDigest, ledgerContentDigest, loadCanonicalRequiredEvidenceCatalog, producerContractDigest } = await import(new URL('../../../tools/test-matrix/required-evidence-catalog.mjs', import.meta.url));
const { completeEvidenceLocatorRegistryEntry, governanceContentDigest } = await import(new URL('../../../tools/test/evidence-location-contract.mjs', import.meta.url));
const { beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication } = await import(new URL('../../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const { createDomainVerifierRegistry } = await import(new URL('../../../tools/release/required-evidence-verifier-registry.mjs', import.meta.url));

const digest = (value) => `sha256:${value.repeat(64)}`;

// Controlled owner fixtures exercise the generic boundary for every catalog
// authority. They are not receipts from the product's native/runtime producers.
export function controlledRequiredEvidenceFixture(t, { preserveCanonicalVerifierRefs = false } = {})
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
        if (preserveCanonicalVerifierRefs)
        {
            const [owner] = entry.producerVerifier.split(':');
            const file = path.join(repositoryRoot, owner);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, source);
        }
        else
        {
            entry.producerVerifier = 'tools/fixture-owner.mjs:requiredEvidenceVerifier';
        }
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

export function publishControlledProducer(f, entry, change = () =>
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

