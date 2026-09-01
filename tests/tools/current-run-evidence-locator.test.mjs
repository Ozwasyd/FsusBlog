import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    evidenceContentDigest,
    evidenceProducerReceiptDigest,
    locateCurrentRunEvidence,
    verifyCurrentRunEvidenceBinding
} from '../../tools/test/current-run-evidence-locator.mjs';
import {
    completeEvidenceLocatorRegistryEntry,
    governanceContentDigest
} from '../../tools/test/evidence-location-contract.mjs';

const d = (value) => `sha256:${value.repeat(64)}`;

function fixture(mode = 'explicit-run-path')
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-locator-'));
    fs.mkdirSync(path.join(root, 'artifacts/current-run'), { recursive: true });
    const contextBody = { schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: 'run-1',
        attemptId: 'attempt-1', sourceCommit: 'a'.repeat(40), worktreeFingerprint: d('b'),
        candidateIdentity: { id: 'candidate', digest: d('c') }, buildIdentity: { id: 'build', digest: d('d') },
        ownedRoots: ['artifacts/current-run'] };
    const context = { ...contextBody, contentDigest: governanceContentDigest(contextBody) };
    const entry = completeEvidenceLocatorRegistryEntry({ consumerId: 'release-final',
        authorityId: 'release-manifest.current-run', producerId: 'release-manifest-producer',
        receiptSchema: 'fsusblog.release-evidence-manifest.v2', locatorMode: mode,
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint'],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'], expectedCardinality: 'exact-one',
        allowedRoots: ['artifacts/current-run'], producerCommand: 'node tools/operations/collect-release-evidence.mjs',
        outputBindingKey: 'FSUSBLOG_RELEASE_MANIFEST_PATH' });
    const registryBody = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [entry] };
    const registry = { ...registryBody, contentDigest: governanceContentDigest(registryBody) };
    const receiptBody = { schema: entry.receiptSchema, schedulerRunId: context.schedulerRunId, attemptId: context.attemptId,
        sourceCommit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint,
        candidateIdentity: context.candidateIdentity, buildIdentity: context.buildIdentity,
        authorityId: entry.authorityId, producerId: entry.producerId, payload: { status: 'ok' } };
    const withContent = { ...receiptBody, contentDigest: evidenceContentDigest(receiptBody) };
    const receipt = { ...withContent, producerReceiptDigest: evidenceProducerReceiptDigest(withContent) };
    const file = path.join(root, 'artifacts/current-run/manifest.json');
    fs.writeFileSync(file, `${JSON.stringify(receipt)}\n`);
    return { root, context, entry, registry, receipt, file, relative: 'artifacts/current-run/manifest.json' };
}

test('explicit exact-one evidence is identity and digest bound and independently verified', () =>
{
    const f = fixture();
    try {
        const result = locateCurrentRunEvidence({ context: f.context, registry: f.registry, registryEntry: f.entry,
            repositoryRoot: f.root, explicitInputs: [f.relative] });
        assert.equal(result.receipt.producerReceiptDigest, f.receipt.producerReceiptDigest);
        verifyCurrentRunEvidenceBinding(result.bindingReceipt, { context: f.context, registry: f.registry,
            registryEntry: f.entry, repositoryRoot: f.root });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('content reference is exact and never searches for matching objects', () =>
{
    const f = fixture('content-addressed-reference');
    try {
        const objectDigest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex')}`;
        const result = locateCurrentRunEvidence({ context: f.context, registry: f.registry, registryEntry: f.entry,
            repositoryRoot: f.root, reference: { path: f.relative, objectDigest } });
        assert.equal(result.bindingReceipt.input.objectDigest, objectDigest);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('missing ambiguity mismatch touch and alternate files fail without fallback', () =>
{
    const f = fixture();
    try {
        const call = (extra) => locateCurrentRunEvidence({ context: f.context, registry: f.registry,
            registryEntry: f.entry, repositoryRoot: f.root, ...extra });
        assert.throws(() => call({ explicitInputs: [] }), /missing/u);
        assert.throws(() => call({ explicitInputs: [f.relative, f.relative] }), /ambiguous/u);
        fs.copyFileSync(f.file, path.join(f.root, 'artifacts/current-run/alternate.json'));
        const bad = JSON.parse(fs.readFileSync(f.file)); bad.attemptId = 'other';
        fs.writeFileSync(f.file, JSON.stringify(bad));
        assert.throws(() => call({ explicitInputs: [f.relative] }), /attemptId mismatch/u);
        fs.utimesSync(path.join(f.root, 'artifacts/current-run/alternate.json'), new Date(), new Date());
        assert.throws(() => call({ explicitInputs: [f.relative] }), /attemptId mismatch/u);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('cross identity digest tamper symlink escape and search-shaped APIs fail closed', () =>
{
    const fields = ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint', 'candidateIdentity', 'buildIdentity', 'authorityId', 'producerId'];
    for (const field of fields)
    {
        const f = fixture();
        try {
            const receipt = JSON.parse(fs.readFileSync(f.file)); receipt[field] = typeof receipt[field] === 'object'
                ? { id: 'other', digest: d('e') } : 'other';
            const withContent = { ...receipt, contentDigest: evidenceContentDigest(receipt) };
            withContent.producerReceiptDigest = evidenceProducerReceiptDigest(withContent);
            fs.writeFileSync(f.file, JSON.stringify(withContent));
            assert.throws(() => locateCurrentRunEvidence({ context: f.context, registry: f.registry,
                registryEntry: f.entry, repositoryRoot: f.root, explicitInputs: [f.relative] }), /mismatch/u);
        } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    }
    const f = fixture();
    try {
        assert.throws(() => locateCurrentRunEvidence({ context: f.context, registry: f.registry,
            registryEntry: f.entry, repositoryRoot: f.root, explicitInputs: [f.relative], searchRoots: ['artifacts'] }), /does not accept/u);
        const outside = path.join(f.root, 'outside.json'); fs.copyFileSync(f.file, outside);
        const link = path.join(f.root, 'artifacts/current-run/link.json'); fs.symlinkSync(outside, link);
        assert.throws(() => locateCurrentRunEvidence({ context: f.context, registry: f.registry,
            registryEntry: f.entry, repositoryRoot: f.root, explicitInputs: ['artifacts/current-run/link.json'] }), /escapes/u);
        const result = locateCurrentRunEvidence({ context: f.context, registry: f.registry,
            registryEntry: f.entry, repositoryRoot: f.root, explicitInputs: [f.relative] });
        result.bindingReceipt.inputDigest = d('f');
        assert.throws(() => verifyCurrentRunEvidenceBinding(result.bindingReceipt, { context: f.context,
            registry: f.registry, registryEntry: f.entry, repositoryRoot: f.root }), /binding receipt digest mismatch/u);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
