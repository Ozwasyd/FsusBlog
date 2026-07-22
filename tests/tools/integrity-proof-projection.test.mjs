import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const { projectEvidence } = await import(pathToFileURL(
    path.join(repositoryRoot, 'tools/test-matrix/evidence-projection.mjs')
).href);
const { writeIntegrityProofProducer } = await import(pathToFileURL(
    path.join(repositoryRoot, 'tools/test-matrix/integrity-proof-producer.mjs')
).href);
const canonicalCatalog = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'tests/fixtures/evidence-projection/integrity-proof-verification.json'),
    'utf8'
));
const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };

function xmlEscape(value)
{
    return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function fixture({ omit = null, duplicate = null, failed = null } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-integrity-projection-'));
    const catalog = structuredClone(canonicalCatalog);
    catalog.requiredArtifactDeclarations[0].path = 'evidence/integrity-proof-source.json';
    const trx = path.join(root, 'backend.trx');
    const results = catalog.producerAssertions
        .filter((entry) => entry.id !== omit)
        .flatMap((entry) => entry.id === duplicate ? [entry, entry] : [entry])
        .map((entry) => `    <UnitTestResult testName="${xmlEscape(entry.sourceTestId)}" outcome="${entry.id === failed ? 'Failed' : 'Passed'}" />`);
    fs.writeFileSync(trx, `<?xml version="1.0" encoding="utf-8"?>\n<TestRun><Results>\n${results.join('\n')}\n</Results></TestRun>\n`);
    const producerOutput = path.join(root, 'evidence/backend-unit.json');
    const sourceOutput = path.join(root, catalog.requiredArtifactDeclarations[0].path);
    return { root, catalog, trx, producerOutput, sourceOutput };
}

function produce(value)
{
    return writeIntegrityProofProducer({
        catalog: value.catalog,
        trxFiles: [value.trx],
        repositoryRoot: value.root,
        sourceState,
        runId: 'run-1',
        namespace: 'namespace-1',
        producerOutput: value.producerOutput,
        sourceOutput: value.sourceOutput,
        generatedAt: '2026-07-22T00:00:00.000Z'
    });
}

test('backend exact-union results produce a traceable integrity projection without another test runner', () =>
{
    const value = fixture();
    const produced = produce(value);
    const projected = projectEvidence({
        catalog: value.catalog,
        producerReceipt: produced.receipt,
        producerReceiptPath: path.relative(value.root, value.producerOutput),
        sourceState,
        runId: 'run-1',
        namespace: 'namespace-1',
        repositoryRoot: value.root,
        generatedAt: '2026-07-22T00:01:00.000Z'
    });

    assert.equal(projected.status, 'success');
    assert.deepEqual(projected.testIds, value.catalog.requiredTestIds);
    assert.deepEqual(projected.coverageIds, value.catalog.requiredCoverageIds);
    assert.equal(projected.executionBoundary.dotnetTestLaunchCount, 0);
    assert.match(projected.assertions[0].sourceTestIds[0], /^FsusBlog\.Server\.Tests\.Unit\./u);
});

test('integrity producer fails closed for missing and duplicate canonical source results', () =>
{
    assert.throws(() => produce(fixture({ omit: 'integrity-proof/schema-migrations' })), /source result set mismatch/u);
    assert.throws(() => produce(fixture({ duplicate: 'integrity-proof/golden-verifier' })), /duplicate source test results/u);
});

test('a failed canonical verifier result is preserved and rejected by projection', () =>
{
    const value = fixture({ failed: 'integrity-proof/tamper/log-reorder' });
    const produced = produce(value);
    assert.throws(() => projectEvidence({
        catalog: value.catalog,
        producerReceipt: produced.receipt,
        producerReceiptPath: path.relative(value.root, value.producerOutput),
        sourceState,
        runId: 'run-1',
        namespace: 'namespace-1',
        repositoryRoot: value.root
    }), /did not pass/u);
});
