import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const {
    privacyPrebuildDigest,
    projectPrivacyZkPrebuild
} = await import(pathToFileURL(path.join(
    repositoryRoot,
    'tools/test/lanes/project-privacy-zk-prebuild.mjs'
)).href);

const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
const runId = 'production-fixture';

function sealed(document)
{
    return { ...document, contentDigest: privacyPrebuildDigest(document) };
}

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-zk-prebuild-'));
    const artifact = path.join(root, 'evidence', 'canonical.json');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, '{"status":"ok"}\n');
    const artifactDigest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')}`;
    const registry = {
        schema: 'fsusblog.privacy-zk-prebuild-ownership.v1',
        tierId: 'privacy-zk-comment-matrix',
        uniqueAssertions: [
            { id: 'privacy-boundaries', owner: 'privacy-zk-prebuild', coverageIds: ['privacy-contract'] }
        ],
        sharedAssertions: [
            {
                id: 'matrix-contract',
                owner: 'matrix-governance',
                producerReceipt: 'receipts/matrix.json',
                requiredAssertionIds: ['matrix-validate'],
                coverageIds: ['test-dag'],
                requiredArtifacts: [{ id: 'canonical', path: 'evidence/canonical.json' }]
            },
            {
                id: 'static-contracts',
                owner: 'frontend-static-governance',
                producerReceipt: 'receipts/static.json',
                requiredAssertionIds: ['frame-schema', 'openapi-sync', 'security-matrices'],
                coverageIds: ['privacy-zk-comment-matrix'],
                requiredArtifacts: []
            }
        ]
    };
    const matrix = sealed({
        schema: 'fsusblog.privacy-zk-canonical-producer.v1',
        status: 'success',
        producerId: 'matrix-governance',
        runId,
        sourceState,
        assertions: [{ id: 'matrix-validate', outcome: 'Passed' }],
        artifacts: [{ id: 'canonical', path: 'evidence/canonical.json', digest: artifactDigest }]
    });
    const staticReceipt = sealed({
        schema: 'fsusblog.privacy-zk-canonical-producer.v1',
        status: 'success',
        producerId: 'frontend-static-governance',
        runId,
        sourceState,
        assertions: ['frame-schema', 'openapi-sync', 'security-matrices'].map(id => ({ id, outcome: 'Passed' })),
        artifacts: []
    });
    return { root, registry, receipts: new Map([['matrix-governance', matrix], ['frontend-static-governance', staticReceipt]]) };
}

test('projects shared current-run receipts while retaining independent Privacy/ZK coverage', t =>
{
    const value = fixture();
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    const receipt = projectPrivacyZkPrebuild({
        ...value,
        repositoryRoot: value.root,
        receiptPaths: new Map([
            ['matrix-governance', 'receipts/matrix.json'],
            ['frontend-static-governance', 'receipts/static.json']
        ]),
        sourceState,
        runId,
        uniqueOutcomes: new Map([['privacy-boundaries', 'Passed']])
    });
    assert.equal(receipt.status, 'success');
    assert.deepEqual(receipt.assertionIds, ['matrix-contract', 'privacy-boundaries', 'static-contracts']);
    assert.deepEqual(receipt.coverageIds, ['privacy-contract', 'privacy-zk-comment-matrix', 'test-dag']);
    assert.equal(receipt.executionBoundary.sharedCheckerLaunchCount, 0);
    assert.equal(receipt.producers.length, 2);
});

test('fails closed for missing producer, wrong source, stale digest, missing assertion and failed outcome', t =>
{
    const value = fixture();
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    const options = {
        ...value,
        repositoryRoot: value.root,
        receiptPaths: new Map([
            ['matrix-governance', 'receipts/matrix.json'],
            ['frontend-static-governance', 'receipts/static.json']
        ]),
        sourceState,
        runId,
        uniqueOutcomes: new Map([['privacy-boundaries', 'Passed']])
    };
    const missing = new Map(value.receipts);
    missing.delete('matrix-governance');
    assert.throws(() => projectPrivacyZkPrebuild({ ...options, receipts: missing }), /missing producer receipt/u);

    const wrongSource = structuredClone(value.receipts.get('matrix-governance'));
    wrongSource.sourceState.worktreeFingerprint = 'c'.repeat(64);
    wrongSource.contentDigest = privacyPrebuildDigest(wrongSource);
    assert.throws(() => projectPrivacyZkPrebuild({
        ...options,
        receipts: new Map(value.receipts).set('matrix-governance', wrongSource)
    }), /source state mismatch/u);

    const stale = structuredClone(value.receipts.get('matrix-governance'));
    stale.assertions[0].outcome = 'Failed';
    assert.throws(() => projectPrivacyZkPrebuild({
        ...options,
        receipts: new Map(value.receipts).set('matrix-governance', stale)
    }), /content digest mismatch/u);

    const absent = structuredClone(value.receipts.get('matrix-governance'));
    absent.assertions = [];
    absent.contentDigest = privacyPrebuildDigest(absent);
    assert.throws(() => projectPrivacyZkPrebuild({
        ...options,
        receipts: new Map(value.receipts).set('matrix-governance', absent)
    }), /missing required assertion/u);

    assert.throws(() => projectPrivacyZkPrebuild({
        ...options,
        uniqueOutcomes: new Map([['privacy-boundaries', 'Failed']])
    }), /unique assertion did not pass/u);
});

test('rejects duplicate physical ownership and artifact tampering', t =>
{
    const value = fixture();
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    const options = {
        ...value,
        repositoryRoot: value.root,
        receiptPaths: new Map([
            ['matrix-governance', 'receipts/matrix.json'],
            ['frontend-static-governance', 'receipts/static.json']
        ]),
        sourceState,
        runId,
        uniqueOutcomes: new Map([['privacy-boundaries', 'Passed']])
    };
    const duplicate = structuredClone(value.registry);
    duplicate.uniqueAssertions.push({ id: 'matrix-contract', owner: 'privacy-zk-prebuild', coverageIds: ['test-dag'] });
    assert.throws(() => projectPrivacyZkPrebuild({ ...options, registry: duplicate }), /duplicate assertion ownership/u);

    fs.writeFileSync(path.join(value.root, 'evidence/canonical.json'), '{"status":"tampered"}\n');
    assert.throws(() => projectPrivacyZkPrebuild(options), /artifact digest mismatch/u);
});
