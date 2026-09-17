#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const outputRoot = process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT
    ? path.resolve(process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT)
    : null;
const testResultsRoot = outputRoot ? path.join(outputRoot, 'reports') : path.join(root, '.tmp/test-results');
const frontendBundleRoot = outputRoot
    ? path.join(outputRoot, 'bundles/frontend-tests')
    : path.join(root, '.tmp/local-production/frontend-tests');
const releaseEvidenceRoot = outputRoot
    ? path.join(outputRoot, 'release-evidence')
    : path.join(root, '.tmp/release-evidence');
const {
    projectRightsV3Evidence,
    readTrxResults
} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/rights-v3-projection.mjs')).href);

const readJson = (file) => JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(root, file), 'utf8'));
const digest = (value) => `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const expectedRunId = process.env.FSUSBLOG_TEST_RUN_ID;
const boundInputs = [
    [path.join(testResultsRoot, 'trx/backend/production/summary.json'), (value) => value.producer?.runId],
    [path.join(testResultsRoot, 'vitest/production-rolling/summary.json'), (value) => value.schedulerRunId],
    [path.join(testResultsRoot, 'backend/rights-v3-integration-producer.json'), (value) => value.runId],
    ...[
        'frontend-static-blocking-prebuild.json',
        'frontend-static-concurrent.json',
        'frontend-static-postbuild.json',
        'frontend-static-isolated.json',
        'frontend-static-final.json'
    ].map((file) => [path.join(frontendBundleRoot, file), (value) => value.schedulerRunId])
];
const deadline = Date.now() + Number(process.env.FSUSBLOG_STEP_DEADLINE_MS ?? 900_000);
while (true)
{
    const ready = boundInputs.every(([file, runId]) =>
    {
        try
        {
            return runId(readJson(file)) === expectedRunId;
        }
        catch
        {
            return false;
        }
    });
    if (ready)
    {
        break;
    }
    if (Date.now() >= deadline)
    {
        throw new Error(`timed out waiting for current-run Rights V3 canonical producer evidence: ${expectedRunId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
}
const backendSummary = readJson(path.join(testResultsRoot, 'trx/backend/production/summary.json'));
const frontendSummary = readJson(path.join(testResultsRoot, 'vitest/production-rolling/summary.json'));
const frontendCatalog = readJson(frontendSummary.artifacts.catalog);
const frontendReport = readJson(frontendSummary.artifacts.mergedJson);
const staticReceiptFiles = [
    'frontend-static-blocking-prebuild.json',
    'frontend-static-concurrent.json',
    'frontend-static-postbuild.json',
    'frontend-static-isolated.json',
    'frontend-static-final.json'
].map((file) => path.join(frontendBundleRoot, file));
const staticReceipts = staticReceiptFiles.map(readJson);
const backendTrxFiles = backendSummary.partitions.map((partition) => path.join(root, partition.trx));
const canonicalVitestId = (file, assertion) =>
{
    const relative = path.relative(root, path.resolve(file)).replaceAll(path.sep, '/');
    const displayName = Array.isArray(assertion.ancestorTitles) && assertion.title
        ? [...assertion.ancestorTitles, assertion.title].join(' ')
        : assertion.fullName ?? assertion.title;
    const name = String(displayName).replace(/\s*>\s*/gu, ' ').replace(/\s+/gu, ' ').trim();
    return `vitest:${relative}#${name}`;
};
const frontendResults = (frontendReport.testResults ?? []).flatMap((testFile) =>
    (testFile.assertionResults ?? []).map((assertion) => ({
        id: canonicalVitestId(testFile.name, assertion),
        outcome: assertion.status
    })));
const receipt = projectRightsV3Evidence({
    catalog: readJson('tests/fixtures/evidence-projection/rights-v3-test-matrix.json'),
    sourceState: {
        commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
        worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
    },
    runId: process.env.FSUSBLOG_TEST_RUN_ID,
    namespace: process.env.FSUSBLOG_TEST_NAMESPACE,
    backend: { summary: backendSummary, digest: digest(backendSummary), results: readTrxResults(backendTrxFiles) },
    frontend: {
        summary: frontendSummary,
        summaryDigest: digest(frontendSummary),
        catalog: frontendCatalog,
        catalogDigest: digest(frontendCatalog),
        results: frontendResults
    },
    staticGovernance: { receipts: staticReceipts, digests: staticReceipts.map(digest) },
    integration: { receipt: readJson(path.join(testResultsRoot, 'backend/rights-v3-integration-producer.json')) }
});
const output = path.join(releaseEvidenceRoot, 'rights-v3-test-matrix.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(`${output}.next-${process.pid}`, `${JSON.stringify(receipt, null, 2)}\n`);
fs.renameSync(`${output}.next-${process.pid}`, output);
console.log(`[rights-v3-projection] backend=${receipt.assertions.backend.length} frontend=${receipt.assertions.frontend.length} static=${receipt.assertions.static.length} integration=${receipt.assertions.integration.length}`);
