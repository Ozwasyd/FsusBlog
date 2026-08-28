import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    governanceContentDigest,
    validateCurrentRunEvidenceContext,
    validateEvidenceLocationMigrationLedger,
    validateEvidenceLocatorRegistry
} from '../../tools/test/evidence-location-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (name) => JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/testing', name), 'utf8'));
const seal = (value) => ({ ...value, contentDigest: governanceContentDigest(value) });

function registryEntry(overrides = {})
{
    return {
        consumerId: 'quality-gate-summary',
        authorityId: 'quality-gate-summary.current-run',
        producerId: 'quality-gate-summary-producer',
        receiptSchema: 'fsusblog.quality-gate-summary.v1',
        locatorMode: 'explicit-run-path',
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint'],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'],
        expectedCardinality: 'exact-one',
        allowedRoots: ['artifacts/quality-gate'],
        producerCommand: 'node tools/ci/summarize-quality-gate.mjs',
        outputBindingKey: 'FSUSBLOG_QUALITY_GATE_SUMMARY_PATH',
        ...overrides
    };
}

test('repository evidence locator contracts are sealed', () =>
{
    validateEvidenceLocatorRegistry(load('evidence-locator-registry.json'));
    validateEvidenceLocationMigrationLedger(load('evidence-location-migration-ledger.json'));
});

test('current-run context binds scheduler attempt source worktree candidate build roots and digest', () =>
{
    const context = seal({
        schema: 'fsusblog.current-run-evidence-context.v1',
        schedulerRunId: 'run-1',
        attemptId: 'attempt-1',
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: `sha256:${'b'.repeat(64)}`,
        candidateIdentity: { id: 'candidate-1', digest: `sha256:${'c'.repeat(64)}` },
        buildIdentity: { id: 'build-1', digest: `sha256:${'d'.repeat(64)}` },
        ownedRoots: ['artifacts/current-run']
    });
    assert.equal(validateCurrentRunEvidenceContext(context), context);
    assert.throws(() => validateCurrentRunEvidenceContext(seal({ ...context, attemptId: '' })), /attemptId/u);
    assert.throws(() => validateCurrentRunEvidenceContext({ ...context, sourceCommit: 'e'.repeat(40) }), /contentDigest mismatch/u);
});

test('registry rejects duplicate authorities and consumers', () =>
{
    const duplicateConsumer = seal({ schema: 'fsusblog.evidence-locator-registry.v1', version: 1,
        entries: [registryEntry(), registryEntry({ authorityId: 'other' })] });
    assert.throws(() => validateEvidenceLocatorRegistry(duplicateConsumer), /duplicates quality-gate-summary/u);
    const duplicateAuthority = seal({ schema: 'fsusblog.evidence-locator-registry.v1', version: 1,
        entries: [registryEntry(), registryEntry({ consumerId: 'other' })] });
    assert.throws(() => validateEvidenceLocatorRegistry(duplicateAuthority), /duplicates quality-gate-summary.current-run/u);
});

test('registry rejects fallback modes insufficient identity wildcard roots and age policies', () =>
{
    const variants = [
        [registryEntry({ locatorMode: 'latest-fallback' }), /unsupported/u],
        [registryEntry({ requiredIdentityFields: ['sourceCommit'] }), /omit current-run identity/u],
        [registryEntry({ requiredDigestFields: [] }), /contentDigest/u],
        [registryEntry({ requiredDigestFields: ['contentDigest'] }), /producerReceiptDigest/u],
        [registryEntry({ outputBindingKey: '' }), /outputBindingKey/u],
        [registryEntry({ producerCommand: '' }), /producerCommand/u],
        [registryEntry({ allowedRoots: ['artifacts/**'] }), /exact repository-relative/u],
        [registryEntry({ ageTtlSeconds: 60 }), /forbidden selection policy/u]
    ];
    for (const [entry, expected] of variants)
    {
        assert.throws(() => validateEvidenceLocatorRegistry(seal({
            schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [entry]
        })), expected);
    }
});

test('registry digest tampering fails closed', () =>
{
    const registry = seal({ schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [registryEntry()] });
    registry.entries[0].producerId = 'tampered';
    assert.throws(() => validateEvidenceLocatorRegistry(registry), /contentDigest mismatch/u);
});

test('migration ledger digest tampering fails closed', () =>
{
    const ledger = load('evidence-location-migration-ledger.json');
    ledger.entries[0].owner = 'tampered-owner';
    assert.throws(() => validateEvidenceLocationMigrationLedger(ledger), /contentDigest mismatch/u);
});
