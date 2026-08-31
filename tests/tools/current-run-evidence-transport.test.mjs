import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    beginCurrentRunEvidencePublication,
    finalizeCurrentRunEvidencePublication
} from '../../tools/test/current-run-evidence-publication.mjs';
import {
    completeEvidenceLocatorRegistryEntry,
    governanceContentDigest
} from '../../tools/test/evidence-location-contract.mjs';
import { locateCurrentRunEvidence } from '../../tools/test/current-run-evidence-locator.mjs';
import {
    browseDiagnosticTransportEntries,
    extractCurrentRunEvidenceTransport,
    locateTransportedCurrentRunEvidence,
    packCurrentRunEvidenceTransport,
    resolveCorrectnessEvidencePath
} from '../../tools/test/current-run-evidence-transport.mjs';

const d = (value) => `sha256:${value.repeat(64)}`;
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-evidence-transport-'));
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
        receiptSchema: 'fsusblog.current-run-evidence-reference.v1',
        locatorMode: 'explicit-run-path',
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
            'sourceCommit', 'worktreeFingerprint'],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'],
        expectedCardinality: 'exact-one', allowedRoots: ['artifacts/current-run'],
        publicationMode: 'hooked', payloadBindingKey: 'FSUSBLOG_PAYLOAD_PATH',
        producerCommand: 'node producer.mjs'
    });
    const registryBody = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [entry] };
    const registry = { ...registryBody, contentDigest: governanceContentDigest(registryBody) };
    const payloadPath = 'artifacts/current-run/payload.json';
    const outputPath = 'artifacts/current-run/reference.json';
    const session = beginCurrentRunEvidencePublication({
        authorityId: entry.authorityId, context, outputPath, payloadPath,
        producerId: entry.producerId, repositoryRoot: root
    });
    fs.writeFileSync(path.join(root, payloadPath), `${JSON.stringify({ schema: 'payload.v1', ok: true })}\n`);
    const published = finalizeCurrentRunEvidencePublication({
        authorityId: entry.authorityId, context, outputPath, payloadPath, payloadSchema: 'payload.v1',
        producerId: entry.producerId, repositoryRoot: root, sessionId: session.sessionId,
        terminalStatus: 'success'
    });
    return { root, context, entry, registry, outputPath, payloadPath, published };
}

function pack(f, extra = {})
{
    return packCurrentRunEvidenceTransport({
        context: f.context,
        repositoryRoot: f.root,
        archivePath: 'artifacts/current-run/transport-archive.json',
        manifestPath: 'artifacts/current-run/transport-manifest.json',
        transportRunId: 'transport-1',
        downloadRunId: 'download-1',
        objects: [{
            authorityId: f.entry.authorityId,
            producerId: f.entry.producerId,
            receiptSchema: f.entry.receiptSchema,
            originalRef: {
                path: f.outputPath,
                contentDigest: f.published.receipt.contentDigest,
                producerReceiptDigest: f.published.receipt.producerReceiptDigest
            },
            files: [{ path: f.outputPath }, { path: f.payloadPath }]
        }],
        ...extra
    });
}

test('legal transport round-trip survives extract mtime changes and records consumer bindings', () =>
{
    const f = fixture();
    try
    {
        const packed = pack(f);
        const archiveFile = path.join(f.root, packed.manifest.archive.path);
        const before = fs.statSync(archiveFile).mtimeMs;
        fs.utimesSync(archiveFile, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
        assert.notEqual(fs.statSync(archiveFile).mtimeMs, before);
        fs.rmSync(path.join(f.root, f.outputPath));
        fs.rmSync(path.join(f.root, f.payloadPath));
        const extracted = extractCurrentRunEvidenceTransport({
            repositoryRoot: f.root, manifestPath: 'artifacts/current-run/transport-manifest.json'
        });
        fs.utimesSync(path.join(f.root, extracted.objects[0].extractedPath),
            new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
        const located = locateTransportedCurrentRunEvidence({
            context: f.context, registry: f.registry, registryEntry: f.entry, repositoryRoot: f.root,
            transportManifestPath: 'artifacts/current-run/transport-manifest.json'
        });
        assert.equal(located.receipt.contentDigest, f.published.receipt.contentDigest);
        assert.equal(located.consumerReceipt.locatorBindingDigest, located.bindingReceipt.bindingDigest);
        assert.match(located.consumerReceipt.transportManifestDigest, /^sha256:[0-9a-f]{64}$/u);
        assert.equal(located.consumerReceipt.transportRef.extractedPath, extracted.objects[0].extractedPath);
    }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('origin identity digest mapping and path-safety failures are fail closed', () =>
{
    const f = fixture();
    try
    {
        pack(f);
        const located = (extra = {}) => locateTransportedCurrentRunEvidence({
            context: f.context, registry: f.registry, registryEntry: f.entry, repositoryRoot: f.root,
            transportManifestPath: 'artifacts/current-run/transport-manifest.json', ...extra
        });
        const otherBody = { ...f.context, schedulerRunId: 'run-other' };
        delete otherBody.contentDigest;
        const other = { ...otherBody, contentDigest: governanceContentDigest(otherBody) };
        assert.throws(() => locateTransportedCurrentRunEvidence({
            context: other, registry: f.registry, registryEntry: f.entry, repositoryRoot: f.root,
            transportManifestPath: 'artifacts/current-run/transport-manifest.json'
        }), /origin schedulerRunId mismatch/u);
        const manifestFile = path.join(f.root, 'artifacts/current-run/transport-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        manifest.objects.push({ ...manifest.objects[0], authorityId: 'other.current-run' });
        const duplicate = {
            ...manifest,
            objects: [manifest.objects[0], { ...manifest.objects[0] }]
        };
        delete duplicate.contentDigest;
        fs.writeFileSync(manifestFile, JSON.stringify({ ...duplicate, contentDigest: governanceContentDigest(duplicate) }));
        assert.throws(() => located(), /duplicate transport mapping/u);
        const missing = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        missing.objects = [manifest.objects[0]];
        missing.objects[0] = { ...missing.objects[0], authorityId: 'missing.current-run' };
        delete missing.contentDigest;
        fs.writeFileSync(manifestFile, JSON.stringify({ ...missing, contentDigest: governanceContentDigest(missing) }));
        assert.throws(() => located(), /transport mapping is missing/u);
        fs.copyFileSync(path.join(f.root, 'artifacts/current-run/transport-archive.json'),
            path.join(f.root, 'artifacts/current-run/transport-archive.tamper.json'));
        fs.appendFileSync(path.join(f.root, 'artifacts/current-run/transport-archive.json'), 'tamper');
        assert.throws(() => extractCurrentRunEvidenceTransport({
            repositoryRoot: f.root, manifestPath: 'artifacts/current-run/transport-manifest.json'
        }), /archive digest mismatch|duplicate transport|contentDigest/u);
    }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('path traversal symlink entries local-downloaded ambiguity and unbound downloads fail', () =>
{
    const f = fixture();
    try
    {
        pack(f);
        const manifestFile = path.join(f.root, 'artifacts/current-run/transport-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        manifest.archive.entries[0].path = '../escape.json';
        delete manifest.contentDigest;
        fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest,
            contentDigest: governanceContentDigest(manifest) }));
        assert.throws(() => extractCurrentRunEvidenceTransport({
            repositoryRoot: f.root, manifestPath: 'artifacts/current-run/transport-manifest.json'
        }), /safe repository-relative/u);
        const f2 = fixture();
        try
        {
            const outside = path.join(f2.root, 'outside.json');
            fs.copyFileSync(path.join(f2.root, f2.outputPath), outside);
            fs.rmSync(path.join(f2.root, f2.outputPath));
            fs.symlinkSync(outside, path.join(f2.root, f2.outputPath));
            assert.throws(() => pack(f2), /must not be a symlink/u);
        }
        finally { fs.rmSync(f2.root, { recursive: true, force: true }); }
        const f3 = fixture();
        try
        {
            pack(f3);
            const downloaded = path.join(f3.root, '.tmp/downloaded-artifacts/quality-gate/reference.json');
            fs.mkdirSync(path.dirname(downloaded), { recursive: true });
            fs.copyFileSync(path.join(f3.root, f3.outputPath), downloaded);
            assert.throws(() => locateCurrentRunEvidence({
                context: f3.context, registry: f3.registry, registryEntry: f3.entry,
                repositoryRoot: f3.root, explicitInputs: ['.tmp/downloaded-artifacts/quality-gate/reference.json']
            }), /downloaded evidence requires an exact transport manifest mapping/u);
            assert.throws(() => resolveCorrectnessEvidencePath({
                repositoryRoot: f3.root, localPath: f3.outputPath, authorityId: f3.entry.authorityId
            }), /without a transport manifest/u);
        }
        finally { fs.rmSync(f3.root, { recursive: true, force: true }); }
    }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('explicit mismatch does not bind a sibling artifact and diagnostic browse cannot create correctness bindings', () =>
{
    const f = fixture();
    try
    {
        const secondPayload = 'artifacts/current-run/other-payload.json';
        const secondOutput = 'artifacts/current-run/other-reference.json';
        const secondEntry = completeEvidenceLocatorRegistryEntry({
            ...f.entry, consumerId: 'evidence-consumer.ci.check-flaky-evidence',
            authorityId: 'evidence-consumer.ci.check-flaky-evidence.current-run',
            producerId: 'evidence-consumer.ci.check-flaky-evidence.producer',
            payloadBindingKey: 'FSUSBLOG_OTHER_PAYLOAD_PATH', outputBindingKey: 'FSUSBLOG_OTHER_PATH'
        });
        const session = beginCurrentRunEvidencePublication({
            authorityId: secondEntry.authorityId, context: f.context, outputPath: secondOutput,
            payloadPath: secondPayload, producerId: secondEntry.producerId, repositoryRoot: f.root
        });
        fs.writeFileSync(path.join(f.root, secondPayload), `${JSON.stringify({ schema: 'payload.v1', ok: true })}\n`);
        const second = finalizeCurrentRunEvidencePublication({
            authorityId: secondEntry.authorityId, context: f.context, outputPath: secondOutput,
            payloadPath: secondPayload, payloadSchema: 'payload.v1', producerId: secondEntry.producerId,
            repositoryRoot: f.root, sessionId: session.sessionId, terminalStatus: 'success'
        });
        const registryBody = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1,
            entries: [f.entry, secondEntry] };
        const registry = { ...registryBody, contentDigest: governanceContentDigest(registryBody) };
        packCurrentRunEvidenceTransport({
            context: f.context, repositoryRoot: f.root,
            archivePath: 'artifacts/current-run/transport-archive.json',
            manifestPath: 'artifacts/current-run/transport-manifest.json',
            transportRunId: 'transport-1', downloadRunId: 'download-1',
            objects: [{
                authorityId: f.entry.authorityId, producerId: f.entry.producerId,
                receiptSchema: f.entry.receiptSchema,
                originalRef: { path: f.outputPath, contentDigest: f.published.receipt.contentDigest,
                    producerReceiptDigest: f.published.receipt.producerReceiptDigest },
                files: [{ path: f.outputPath }]
            }, {
                authorityId: secondEntry.authorityId, producerId: secondEntry.producerId,
                receiptSchema: secondEntry.receiptSchema,
                originalRef: { path: secondOutput, contentDigest: second.receipt.contentDigest,
                    producerReceiptDigest: second.receipt.producerReceiptDigest },
                files: [{ path: secondOutput }]
            }]
        });
        assert.throws(() => locateTransportedCurrentRunEvidence({
            context: f.context, registry, registryEntry: f.entry, repositoryRoot: f.root,
            transportManifestPath: 'artifacts/current-run/transport-manifest.json',
            explicitInputs: [secondOutput]
        }), /does not match transport mapping/u);
        const other = locateTransportedCurrentRunEvidence({
            context: f.context, registry, registryEntry: secondEntry, repositoryRoot: f.root,
            transportManifestPath: 'artifacts/current-run/transport-manifest.json'
        });
        assert.equal(other.receipt.authorityId, secondEntry.authorityId);
        const browse = browseDiagnosticTransportEntries(JSON.parse(fs.readFileSync(
            path.join(f.root, 'artifacts/current-run/transport-manifest.json'), 'utf8')));
        assert.equal(browse.schema, 'fsusblog.current-run-evidence-diagnostic-browse.v1');
        assert.equal(Object.hasOwn(browse, 'locatorBindingDigest'), false);
        assert.equal(Object.hasOwn(browse, 'transportManifestDigest'), false);
    }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('quality-gate consumers reject broad downloaded scans and missing consumer bindings', () =>
{
    const f = fixture();
    try
    {
        pack(f);
        const source = [
            fs.readFileSync(path.join(sourceRoot, 'tools/ci/summarize-quality-gate.mjs'), 'utf8'),
            fs.readFileSync(path.join(sourceRoot, 'tools/ci/check-flaky-evidence.mjs'), 'utf8'),
            fs.readFileSync(path.join(sourceRoot, 'tools/ci/check-job-summaries.mjs'), 'utf8'),
            fs.readFileSync(path.join(sourceRoot, 'tools/run-test-matrix.mjs'), 'utf8'),
            fs.readFileSync(path.join(sourceRoot, 'tools/test/aggregate-performance-evidence.mjs'), 'utf8'),
            fs.readFileSync(path.join(sourceRoot, 'tools/test/aggregate-data-scale-evidence.mjs'), 'utf8')
        ].join('\n');
        assert.match(source, /FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST|locateTransportedCurrentRunEvidence|resolveCorrectnessEvidencePath/u);
        const located = locateTransportedCurrentRunEvidence({
            context: f.context, registry: f.registry, registryEntry: f.entry, repositoryRoot: f.root,
            transportManifestPath: 'artifacts/current-run/transport-manifest.json'
        });
        assert.match(located.consumerReceipt.locatorBindingDigest, /^sha256:[0-9a-f]{64}$/u);
        assert.match(located.consumerReceipt.transportManifestDigest, /^sha256:[0-9a-f]{64}$/u);
        assert.equal(located.consumerReceipt.transportRef.path,
            'artifacts/current-run/transport-manifest.json');
        const incomplete = { ...located.consumerReceipt };
        delete incomplete.locatorBindingDigest;
        delete incomplete.transportManifestDigest;
        assert.equal(incomplete.locatorBindingDigest, undefined);
        assert.equal(incomplete.transportRef.path, located.consumerReceipt.transportRef.path);
        const local = locateCurrentRunEvidence({
            context: f.context, registry: f.registry, registryEntry: f.entry, repositoryRoot: f.root,
            explicitInputs: [f.outputPath]
        });
        assert.equal(local.bindingReceipt.bindingDigest, located.bindingReceipt.bindingDigest);
    }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('transport roles physical paths and extraction publication fail closed', async (context) =>
{
    await context.test('manifest is immutable and extraction never overwrites a destination', () =>
    {
        const f = fixture();
        try
        {
            pack(f);
            const manifestFile = path.join(f.root, 'artifacts/current-run/transport-manifest.json');
            const before = fs.readFileSync(manifestFile);
            fs.rmSync(path.join(f.root, f.payloadPath));
            assert.throws(() => extractCurrentRunEvidenceTransport({
                repositoryRoot: f.root, manifestPath: 'artifacts/current-run/transport-manifest.json'
            }), /destination already exists/u);
            assert.equal(fs.existsSync(path.join(f.root, f.payloadPath)), false,
                'preflight must not publish any entry before every destination is eligible');
            fs.rmSync(path.join(f.root, f.outputPath));
            extractCurrentRunEvidenceTransport({
                repositoryRoot: f.root, manifestPath: 'artifacts/current-run/transport-manifest.json'
            });
            assert.deepEqual(fs.readFileSync(manifestFile), before,
                'extract must not rewrite the sealed transport manifest');
        }
        finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });

    await context.test('hard-linked sources and manifests are rejected', () =>
    {
        const f = fixture();
        try
        {
            const hardlink = path.join(f.root, 'artifacts/current-run/reference-hardlink.json');
            fs.linkSync(path.join(f.root, f.outputPath), hardlink);
            assert.throws(() => pack(f), /must not be hard-linked/u);
            fs.unlinkSync(hardlink);
            pack(f);
            fs.linkSync(path.join(f.root, 'artifacts/current-run/transport-manifest.json'),
                path.join(f.root, 'transport-manifest-hardlink.json'));
            assert.throws(() => extractCurrentRunEvidenceTransport({
                repositoryRoot: f.root, manifestPath: 'artifacts/current-run/transport-manifest.json'
            }), /must not be hard-linked/u);
        }
        finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });

    await context.test('independent digest and exact authority admission reject before any extraction write', async (nested) =>
    {
        const run = async ({ name, prepare, expectedDigest, expectedAuthorities, expected }) =>
            nested.test(name, () =>
            {
                const f = fixture();
                try
                {
                    const packed = prepare?.(f) ?? pack(f);
                    fs.rmSync(path.join(f.root, f.outputPath));
                    fs.rmSync(path.join(f.root, f.payloadPath));
                    for (const relative of packed.additionalExtractionPaths ?? [])
                    {
                        fs.rmSync(path.join(f.root, relative));
                    }
                    assert.throws(() => extractCurrentRunEvidenceTransport({
                        repositoryRoot: f.root,
                        manifestPath: 'artifacts/current-run/transport-manifest.json',
                        expectedManifestDigest: expectedDigest?.(packed) ?? packed.manifest.contentDigest,
                        expectedAuthorityIds: expectedAuthorities?.(f)
                    }), expected);
                    assert.equal(fs.existsSync(path.join(f.root, f.outputPath)), false);
                    assert.equal(fs.existsSync(path.join(f.root, f.payloadPath)), false);
                    for (const relative of packed.additionalExtractionPaths ?? [])
                    {
                        assert.equal(fs.existsSync(path.join(f.root, relative)), false);
                    }
                }
                finally { fs.rmSync(f.root, { recursive: true, force: true }); }
            });

        await run({ name: 'digest mismatch', expectedDigest: () => d('f'),
            expectedAuthorities: (f) => [f.entry.authorityId], expected: /manifest digest mismatch/u });
        await run({ name: 'missing authority',
            expectedAuthorities: (f) => [f.entry.authorityId, 'foreign.current-run'],
            expected: /authority set mismatch/u });
        await run({
            name: 'foreign authority',
            prepare: (f) =>
            {
                const foreign = { authorityId: 'foreign.current-run', producerId: 'foreign.producer',
                    payloadPath: 'artifacts/current-run/foreign-payload.json',
                    outputPath: 'artifacts/current-run/foreign-reference.json' };
                const session = beginCurrentRunEvidencePublication({ ...foreign, context: f.context,
                    repositoryRoot: f.root });
                fs.writeFileSync(path.join(f.root, foreign.payloadPath),
                    `${JSON.stringify({ schema: 'foreign.v1' })}\n`);
                const published = finalizeCurrentRunEvidencePublication({ ...foreign, context: f.context,
                    payloadSchema: 'foreign.v1', repositoryRoot: f.root, sessionId: session.sessionId,
                    terminalStatus: 'success' });
                const packed = pack(f, { objects: [{
                    authorityId: f.entry.authorityId, producerId: f.entry.producerId,
                    receiptSchema: f.entry.receiptSchema,
                    originalRef: { path: f.outputPath, contentDigest: f.published.receipt.contentDigest,
                        producerReceiptDigest: f.published.receipt.producerReceiptDigest },
                    files: [{ path: f.outputPath }, { path: f.payloadPath }]
                }, {
                    authorityId: foreign.authorityId, producerId: foreign.producerId,
                    receiptSchema: f.entry.receiptSchema,
                    originalRef: { path: foreign.outputPath, contentDigest: published.receipt.contentDigest,
                        producerReceiptDigest: published.receipt.producerReceiptDigest },
                    files: [{ path: foreign.outputPath }, { path: foreign.payloadPath }]
                }] });
                return { ...packed, additionalExtractionPaths: [foreign.outputPath, foreign.payloadPath] };
            },
            expectedAuthorities: (f) => [f.entry.authorityId],
            expected: /authority set mismatch/u
        });
        await run({
            name: 'duplicate authority',
            prepare: (f) =>
            {
                const packed = pack(f);
                const file = path.join(f.root, 'artifacts/current-run/transport-manifest.json');
                const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
                manifest.objects.push({ ...manifest.objects[0] });
                delete manifest.contentDigest;
                const resealed = { ...manifest, contentDigest: governanceContentDigest(manifest) };
                fs.writeFileSync(file, JSON.stringify(resealed));
                return { ...packed, manifest: resealed };
            },
            expectedAuthorities: (f) => [f.entry.authorityId],
            expected: /duplicate transport mapping/u
        });
    });

    await context.test('role and archive/object index splits are rejected', () =>
    {
        const f = fixture();
        try
        {
            pack(f);
            const file = path.join(f.root, 'artifacts/current-run/transport-manifest.json');
            const rewrite = (mutate) =>
            {
                const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
                mutate(manifest);
                delete manifest.contentDigest;
                fs.writeFileSync(file, JSON.stringify({ ...manifest,
                    contentDigest: governanceContentDigest(manifest) }));
            };
            rewrite((manifest) => { manifest.objects[0].archiveEntries[1].role = 'reference-receipt'; });
            assert.throws(() => extractCurrentRunEvidenceTransport({ repositoryRoot: f.root,
                manifestPath: 'artifacts/current-run/transport-manifest.json' }), /duplicate transport object role/u);
            rewrite((manifest) =>
            {
                manifest.objects[0].archiveEntries[1].role = 'payload';
                manifest.objects[0].archiveEntries[1].extractedPath = manifest.objects[0].archiveEntries[0].path;
            });
            assert.throws(() => extractCurrentRunEvidenceTransport({ repositoryRoot: f.root,
                manifestPath: 'artifacts/current-run/transport-manifest.json' }), /archive\/extracted path mapping mismatch/u);
        }
        finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
});
