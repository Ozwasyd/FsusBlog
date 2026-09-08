import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { locateReleaseFinalDirectEvidence } from '../../tools/release/check-release-final.mjs';
import { governanceContentDigest } from '../../tools/test/evidence-location-contract.mjs';
import {
    beginCurrentRunEvidencePublication,
    createEvidenceParentReceipt,
    finalizeCurrentRunEvidencePublication,
    releaseFinalDirectConsumerIds
} from '../../tools/test/current-run-evidence-publication.mjs';
import { completeEvidenceLocatorRegistryEntry } from '../../tools/test/evidence-location-contract.mjs';

const d = (value) => `sha256:${value.repeat(64)}`;
const payloadSchemas = {
    'evidence-consumer.test-matrix.behavior-evidence-pre-runtime': 'fsusblog.behavior-evidence-pre-runtime-receipt.v1',
    'evidence-consumer.release-final.direct.behavior-consistency': 'fsusblog.behavior-document-consistency-final-report.v1',
    'evidence-consumer.release-final.direct.behavior-post-runtime': 'fsusblog.behavior-evidence-post-runtime-receipt.v1',
    'evidence-consumer.release-final.direct.browser-contract': 'fsusblog.browser-contract-receipt.v2',
    'evidence-consumer.release-final.direct.browserless-correctness': 'fsusblog.browserless-correctness-receipt.v1',
    'evidence-consumer.release-final.direct.production-build': 'fsusblog.ci-production-build-receipt.v1',
    'evidence-consumer.release-final.direct.public-preview': 'fsusblog.public-preview-screenshot-verification.v1'
};

function shaFile(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-release-locator-'));
    fs.mkdirSync(path.join(root, 'artifacts/current-run'), { recursive: true });
    const contextBody = { schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: 'run-1', attemptId: 'attempt-1',
        sourceCommit: 'a'.repeat(40), worktreeFingerprint: d('b'), candidateIdentity: { id: 'candidate', digest: d('c') },
        buildIdentity: { id: 'build', digest: d('d') }, ownedRoots: ['artifacts/current-run'] };
    const context = { ...contextBody, contentDigest: governanceContentDigest(contextBody) };
    const entries = releaseFinalDirectConsumerIds.map((consumerId, index) => completeEvidenceLocatorRegistryEntry({
        consumerId, authorityId: `${consumerId}.current-run`, producerId: `${consumerId}.producer`,
        receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint'],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
        allowedRoots: ['artifacts/current-run'], producerCommand: `node producer-${consumerId}.mjs`,
        outputBindingKey: `BINDING_${index}` }));
    const parentEntry = completeEvidenceLocatorRegistryEntry({
        consumerId: 'evidence-consumer.release.release-final-domain-evidence',
        authorityId: 'release-final-parent.current-run', producerId: 'release-final-parent-producer',
        receiptSchema: 'fsusblog.current-run-evidence-parent.v1', locatorMode: 'explicit-run-path',
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint'],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
        allowedRoots: ['artifacts/current-run'], producerCommand: 'node publish-parent.mjs',
        outputBindingKey: 'PARENT_BINDING' });
    entries.push(parentEntry);
    const registryBody = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries };
    const registry = { ...registryBody, contentDigest: governanceContentDigest(registryBody) };
    const children = [];
    for (const entry of entries.slice(0, -1))
    {
        const slug = entry.consumerId.split('.').at(-1);
        const payloadPath = `artifacts/current-run/${slug}-payload.json`;
        const referencePath = `artifacts/current-run/${slug}-reference.json`;
        const session = beginCurrentRunEvidencePublication({ authorityId: entry.authorityId, context,
            outputPath: referencePath, payloadPath, producerId: entry.producerId, repositoryRoot: root });
        fs.writeFileSync(path.join(root, payloadPath),
            JSON.stringify({ schema: payloadSchemas[entry.consumerId], ok: true }));
        const receipt = finalizeCurrentRunEvidencePublication({
            authorityId: entry.authorityId, context, outputPath: referencePath, payloadPath,
            payloadSchema: payloadSchemas[entry.consumerId], producerId: entry.producerId,
            repositoryRoot: root, sessionId: session.sessionId, terminalStatus: 'success'
        }).receipt;
        children.push({ ...receipt, path: referencePath, inputDigest: shaFile(path.join(root, referencePath)) });
    }
    const parent = createEvidenceParentReceipt({ context, parentAuthorityId: parentEntry.authorityId,
        producerId: parentEntry.producerId, childReferences: children });
    const parentPath = 'artifacts/current-run/parent.json';
    fs.writeFileSync(path.join(root, parentPath), JSON.stringify(parent));
    return { root, context, registry, parentPath, children };
}

test('release-final locates the exact parent and every canonical direct child', () =>
{
    const f = fixture();
    try
    {
        const result = locateReleaseFinalDirectEvidence({ context: f.context, parentPath: f.parentPath,
            registry: f.registry, repositoryRoot: f.root });
        assert.deepEqual(Object.keys(result.directEvidence).sort(),
            ['behaviorConsistency', 'behaviorPostRuntime', 'behaviorPreRuntime', 'browserContract', 'browserlessCorrectness', 'productionBuild', 'publicPreview']);
    }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('newer same-schema alternate never replaces a mismatched explicit child', () =>
{
    const f = fixture();
    try
    {
        const selected = path.join(f.root, f.children[0].path);
        const alternate = path.join(f.root, 'artifacts/current-run/newer-alternate.json');
        fs.copyFileSync(selected, alternate);
        fs.utimesSync(alternate, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
        const tampered = JSON.parse(fs.readFileSync(selected));
        tampered.attemptId = 'other-attempt';
        fs.writeFileSync(selected, JSON.stringify(tampered));
        assert.throws(() => locateReleaseFinalDirectEvidence({ context: f.context, parentPath: f.parentPath,
            registry: f.registry, repositoryRoot: f.root }), /attemptId mismatch/u);
    }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('parent child digest and authority set tamper fail closed', () =>
{
    for (const mutation of ['digest', 'delete'])
    {
        const f = fixture();
        try
        {
            const file = path.join(f.root, f.parentPath);
            const parent = JSON.parse(fs.readFileSync(file));
            if (mutation === 'digest') parent.children[0].inputDigest = d('f');
            else parent.children.pop();
            fs.writeFileSync(file, JSON.stringify(parent));
            assert.throws(() => locateReleaseFinalDirectEvidence({ context: f.context, parentPath: f.parentPath,
                registry: f.registry, repositoryRoot: f.root }), /contentDigest mismatch|exact direct authority set/u);
        }
        finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    }
});

test('release-final correctness sources contain no discovery or raw direct-path fallback', () =>
{
    const root = path.resolve(import.meta.dirname, '../..');
    const sources = [
        'tools/release/check-release-final.mjs',
        'tools/release/release-final-domain-evidence.mjs',
        'tools/release/public-preview-release-evidence.mjs'
    ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    assert.doesNotMatch(sources, /latestManifest|latestReleaseManifest|findReceiptFile|readExactReceiptFile|\.tmp\/downloaded-artifacts|mtimeMs/u);
    assert.doesNotMatch(sources, /FSUSBLOG_(?:CORRECTNESS_RECEIPT|BROWSER_CONTRACT_RECEIPT|PRODUCTION_BUILD_RECEIPT|PUBLIC_PREVIEW_SCREENSHOT_EVIDENCE)/u);
});
