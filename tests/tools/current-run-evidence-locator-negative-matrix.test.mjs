import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { locateReleaseFinalDirectEvidence } from '../../tools/release/check-release-final.mjs';
import {
    beginCurrentRunEvidencePublication,
    createEvidenceParentReceipt,
    finalizeCurrentRunEvidencePublication,
    releaseFinalDirectConsumerIds
} from '../../tools/test/current-run-evidence-publication.mjs';
import {
    completeEvidenceLocatorRegistryEntry,
    governanceContentDigest,
    verifyEvidenceLocationGovernance
} from '../../tools/test/evidence-location-contract.mjs';
import { generateEvidenceLocationGovernance } from '../../tools/test/generate-evidence-location-governance.mjs';
import { locateCurrentRunEvidence } from '../../tools/test/current-run-evidence-locator.mjs';
import {
    locateTransportedCurrentRunEvidence,
    packCurrentRunEvidenceTransport,
    resolveCorrectnessEvidencePath
} from '../../tools/test/current-run-evidence-transport.mjs';
import { generateCurrentRunEvidenceLocationAcceptance } from '../../tools/test/generate-current-run-evidence-location-acceptance.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const d = (value) => `sha256:${value.repeat(64)}`;
const payloadSchemas = {
    'evidence-consumer.release-final.direct.behavior-consistency': 'fsusblog.behavior-document-consistency-final-report.v1',
    'evidence-consumer.release-final.direct.behavior-post-runtime': 'fsusblog.behavior-evidence-post-runtime-receipt.v1',
    'evidence-consumer.release-final.direct.browser-contract': 'fsusblog.browser-contract-receipt.v2',
    'evidence-consumer.release-final.direct.browserless-correctness': 'fsusblog.browserless-correctness-receipt.v1',
    'evidence-consumer.release-final.direct.production-build': 'fsusblog.ci-production-build-receipt.v1',
    'evidence-consumer.release-final.direct.public-preview': 'fsusblog.public-preview-screenshot-verification.v1'
};

function fixture(mode = 'explicit-run-path')
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-locator-negative-'));
    fs.mkdirSync(path.join(root, 'artifacts/current-run'), { recursive: true });
    const contextBody = {
        schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: 'run-1',
        attemptId: 'attempt-1', sourceCommit: 'a'.repeat(40), worktreeFingerprint: d('b'),
        candidateIdentity: { id: 'candidate', digest: d('c') },
        buildIdentity: { id: 'build', digest: d('d') }, ownedRoots: ['artifacts/current-run']
    };
    const context = { ...contextBody, contentDigest: governanceContentDigest(contextBody) };
    const entry = completeEvidenceLocatorRegistryEntry({
        consumerId: 'evidence-consumer.ci.summarize-quality-gate',
        authorityId: 'evidence-consumer.ci.summarize-quality-gate.current-run',
        producerId: 'evidence-consumer.ci.summarize-quality-gate.producer',
        receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: mode,
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
            'sourceCommit', 'worktreeFingerprint'],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'],
        expectedCardinality: 'exact-one', allowedRoots: ['artifacts/current-run'],
        publicationMode: 'hooked', payloadBindingKey: 'FSUSBLOG_PAYLOAD_PATH',
        producerCommand: 'node producer.mjs'
    });
    const registryBody = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [entry] };
    const registry = { ...registryBody, contentDigest: governanceContentDigest(registryBody) };
    return { root, context, entry, registry };
}

function publish(f, name = 'reference')
{
    const payloadPath = `artifacts/current-run/${name}-payload.json`;
    const outputPath = `artifacts/current-run/${name}.json`;
    const session = beginCurrentRunEvidencePublication({
        authorityId: f.entry.authorityId, context: f.context, outputPath, payloadPath,
        producerId: f.entry.producerId, repositoryRoot: f.root
    });
    fs.writeFileSync(path.join(f.root, payloadPath), `${JSON.stringify({ schema: 'payload.v1', ok: name })}\n`);
    const published = finalizeCurrentRunEvidencePublication({
        authorityId: f.entry.authorityId, context: f.context, outputPath, payloadPath,
        payloadSchema: 'payload.v1', producerId: f.entry.producerId, repositoryRoot: f.root,
        sessionId: session.sessionId, terminalStatus: 'success'
    });
    return { payloadPath, outputPath, published };
}

function forbiddenNewest(files)
{
    return files.slice().sort((left, right) => right.generatedAt - left.generatedAt)[0];
}

function forbiddenFallback(explicit, alternates)
{
    try
    {
        if (explicit.attemptId !== 'attempt-1') throw new Error('explicit mismatch');
        return explicit;
    }
    catch
    {
        return alternates[0];
    }
}

test('negative matrix fails closed for ambiguity mtime downloaded mismatch and missing identity', () =>
{
    const f = fixture();
    try
    {
        const first = publish(f, 'first');
        const locate = (extra) => locateCurrentRunEvidence({
            context: f.context, registry: f.registry, registryEntry: f.entry,
            repositoryRoot: f.root, ...extra
        });
        assert.throws(() => locate({ explicitInputs: [first.outputPath, first.outputPath] }), /ambiguous/u);
        const twin = path.join(f.root, 'artifacts/current-run/same-schema.json');
        fs.copyFileSync(path.join(f.root, first.outputPath), twin);
        fs.utimesSync(twin, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
        assert.throws(() => locate({ explicitInputs: [first.outputPath, 'artifacts/current-run/same-schema.json'] }),
            /ambiguous/u);
        const tampered = JSON.parse(fs.readFileSync(path.join(f.root, first.outputPath), 'utf8'));
        tampered.attemptId = 'attempt-0';
        fs.writeFileSync(path.join(f.root, first.outputPath), JSON.stringify(tampered));
        assert.throws(() => locate({ explicitInputs: [first.outputPath] }), /attemptId mismatch/u);
        assert.throws(() => locate({ explicitInputs: ['artifacts/current-run/missing.json'] }), /missing/u);
        assert.throws(() => locate({ explicitInputs: [first.outputPath], searchRoots: ['artifacts'] }),
            /does not accept/u);
        const newest = forbiddenNewest([
            { path: first.outputPath, generatedAt: 1 },
            { path: 'artifacts/current-run/same-schema.json', generatedAt: 2 }
        ]);
        assert.equal(newest.path, 'artifacts/current-run/same-schema.json');
        const fallback = forbiddenFallback(tampered, [{ path: twin }]);
        assert.equal(fallback.path, twin);
    }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('mutations that sort fallback prefer local or trust filename pointers cannot pass the locator', () =>
{
    const f = fixture();
    try
    {
        const published = publish(f);
        const pointer = path.join(f.root, 'artifacts/current-run/current.json');
        fs.writeFileSync(pointer, JSON.stringify({ schema: 'pointer.v1', target: published.outputPath }));
        assert.throws(() => locateCurrentRunEvidence({
            context: f.context, registry: f.registry, registryEntry: f.entry, repositoryRoot: f.root,
            explicitInputs: ['artifacts/current-run/current.json']
        }), /schema mismatch|contentDigest mismatch/u);
        const onlyCommit = JSON.parse(fs.readFileSync(path.join(f.root, published.outputPath), 'utf8'));
        onlyCommit.attemptId = 'other';
        fs.writeFileSync(path.join(f.root, published.outputPath), JSON.stringify(onlyCommit));
        assert.throws(() => locateCurrentRunEvidence({
            context: f.context, registry: f.registry, registryEntry: f.entry, repositoryRoot: f.root,
            explicitInputs: [published.outputPath]
        }), /contentDigest mismatch|attemptId mismatch/u);
        fs.mkdirSync(path.join(f.root, '.tmp/downloaded-artifacts'), { recursive: true });
        assert.throws(() => resolveCorrectnessEvidencePath({
            repositoryRoot: f.root, localPath: published.outputPath, authorityId: f.entry.authorityId
        }), /without a transport manifest/u);
    }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('release-final and quality-gate transported consumers fail the same identity mismatch', () =>
{
    const f = fixture();
    try
    {
        const children = [];
        const entries = releaseFinalDirectConsumerIds.map((consumerId, index) => completeEvidenceLocatorRegistryEntry({
            consumerId, authorityId: `${consumerId}.current-run`, producerId: `${consumerId}.producer`,
            receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
            requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
                'sourceCommit', 'worktreeFingerprint'],
            requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
            allowedRoots: ['artifacts/current-run'], producerCommand: `node producer-${index}.mjs`,
            outputBindingKey: `BINDING_${index}`
        }));
        const parentEntry = completeEvidenceLocatorRegistryEntry({
            consumerId: 'evidence-consumer.release.release-final-domain-evidence',
            authorityId: 'release-final-parent.current-run', producerId: 'release-final-parent-producer',
            receiptSchema: 'fsusblog.current-run-evidence-parent.v1', locatorMode: 'explicit-run-path',
            requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
                'sourceCommit', 'worktreeFingerprint'],
            requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
            allowedRoots: ['artifacts/current-run'], producerCommand: 'node publish-parent.mjs',
            outputBindingKey: 'PARENT_BINDING'
        });
        for (const entry of entries)
        {
            const slug = entry.consumerId.split('.').at(-1);
            const payloadPath = `artifacts/current-run/${slug}-payload.json`;
            const referencePath = `artifacts/current-run/${slug}-reference.json`;
            const session = beginCurrentRunEvidencePublication({
                authorityId: entry.authorityId, context: f.context, outputPath: referencePath,
                payloadPath, producerId: entry.producerId, repositoryRoot: f.root
            });
            fs.writeFileSync(path.join(f.root, payloadPath),
                JSON.stringify({ schema: payloadSchemas[entry.consumerId], ok: true }));
            const receipt = finalizeCurrentRunEvidencePublication({
                authorityId: entry.authorityId, context: f.context, outputPath: referencePath, payloadPath,
                payloadSchema: payloadSchemas[entry.consumerId], producerId: entry.producerId,
                repositoryRoot: f.root, sessionId: session.sessionId, terminalStatus: 'success'
            }).receipt;
            children.push({ ...receipt, path: referencePath,
                inputDigest: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(f.root, referencePath))).digest('hex')}` });
        }
        const parent = createEvidenceParentReceipt({
            context: f.context, parentAuthorityId: parentEntry.authorityId,
            producerId: parentEntry.producerId, childReferences: children
        });
        const parentPath = 'artifacts/current-run/parent.json';
        fs.writeFileSync(path.join(f.root, parentPath), JSON.stringify(parent));
        const registryBody = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1,
            entries: [...entries, parentEntry] };
        const registry = { ...registryBody, contentDigest: governanceContentDigest(registryBody) };
        const quality = publish(f);
        packCurrentRunEvidenceTransport({
            context: f.context, repositoryRoot: f.root,
            archivePath: 'artifacts/current-run/transport-archive.json',
            manifestPath: 'artifacts/current-run/transport-manifest.json',
            transportRunId: 'transport-1', downloadRunId: 'download-1',
            objects: [{
                authorityId: f.entry.authorityId, producerId: f.entry.producerId,
                receiptSchema: f.entry.receiptSchema,
                originalRef: {
                    path: quality.outputPath, contentDigest: quality.published.receipt.contentDigest,
                    producerReceiptDigest: quality.published.receipt.producerReceiptDigest
                },
                files: [{ path: quality.outputPath }]
            }]
        });
        const otherBody = { ...f.context, attemptId: 'attempt-9' };
        delete otherBody.contentDigest;
        const other = { ...otherBody, contentDigest: governanceContentDigest(otherBody) };
        assert.throws(() => locateReleaseFinalDirectEvidence({
            context: other, parentPath, registry, repositoryRoot: f.root
        }), /attemptId mismatch/u);
        const qualityRegistryBody = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1,
            entries: [f.entry] };
        const qualityRegistry = { ...qualityRegistryBody, contentDigest: governanceContentDigest(qualityRegistryBody) };
        assert.throws(() => locateTransportedCurrentRunEvidence({
            context: other, registry: qualityRegistry, registryEntry: f.entry, repositoryRoot: f.root,
            transportManifestPath: 'artifacts/current-run/transport-manifest.json'
        }), /origin attemptId mismatch/u);
    }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('registry ledger scanner and consumer call sites stay bidirectionally exact with warnings=0', () =>
{
    const generated = generateEvidenceLocationGovernance();
    verifyEvidenceLocationGovernance({
        registry: generated.registry, ledger: generated.ledger, scan: generated.scan
    });
    const registryConsumers = new Set(generated.registry.entries.map((entry) => entry.consumerId));
    const ledgerConsumers = new Set(generated.ledger.entries
        .filter((entry) => entry.classification !== 'not-evidence')
        .map((entry) => entry.consumerId));
    for (const consumerId of ledgerConsumers)
        assert(registryConsumers.has(consumerId), `ledger consumer missing from registry: ${consumerId}`);
    const sources = [
        'tools/release/check-release-final.mjs',
        'tools/ci/summarize-quality-gate.mjs',
        'tools/ci/check-flaky-evidence.mjs',
        'tools/ci/check-job-summaries.mjs',
        'tools/test/current-run-evidence-locator.mjs',
        'tools/test/current-run-evidence-transport.mjs'
    ].map((file) => fs.readFileSync(path.join(repositoryRoot, file), 'utf8')).join('\n');
    assert.match(sources, /locateCurrentRunEvidence|locateTransportedCurrentRunEvidence|listTransportedArchiveFiles/u);
    assert.doesNotMatch(sources, /searchRoots|ageTtlSeconds/u);
    const acceptance = generateCurrentRunEvidenceLocationAcceptance();
    assert.equal(acceptance.warnings.length, 0);
    assert.equal(acceptance.consumerCount, generated.registry.entries.length);
    assert.equal(acceptance.registryDigest, generated.registry.contentDigest);
    const checkedIn = JSON.parse(fs.readFileSync(path.join(repositoryRoot,
        'config/testing/current-run-evidence-location-acceptance.json'), 'utf8'));
    assert.deepEqual(checkedIn, acceptance);
});
