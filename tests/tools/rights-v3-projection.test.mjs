import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const {
    createRightsV3IntegrationProducer,
    projectRightsV3Evidence
} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/rights-v3-projection.mjs')).href);
const catalog = JSON.parse(fs.readFileSync(
    path.join(root, 'tests/fixtures/evidence-projection/rights-v3-test-matrix.json'),
    'utf8'
));
const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
const digest = (value) => `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

function fixture()
{
    const backendSummary = {
        schema: 'fsusblog.backend-production-shards.v2',
        status: 'success',
        execution: { exactOnce: true, allPassed: true },
        producer: { runId: 'run-1', sourceCommit: sourceState.commit, sourceFingerprint: sourceState.worktreeFingerprint }
    };
    const frontendCatalog = { identity: { source: sourceState }, identityDigest: 'catalog-1' };
    const frontendSummary = {
        schema: 'fsusblog.frontend-vitest-rolling.v2',
        status: 'success',
        exactOnce: true,
        schedulerRunId: 'run-1',
        catalogIdentityDigest: 'catalog-1'
    };
    const staticReceipt = {
        schema: 'fsusblog.local-production.frontend-static-governance-phase.v2',
        status: 'success',
        schedulerRunId: 'run-1',
        execution: { timings: catalog.staticRuleIds.map((id) => ({ id, status: 'success' })) }
    };
    const integrationReceipt = createRightsV3IntegrationProducer({
        sourceState,
        runId: 'run-1',
        namespace: 'namespace-1',
        trxPath: '.tmp/test-results/backend/integration.trx',
        trxDigest: `sha256:${'c'.repeat(64)}`,
        results: catalog.integrationTestIds.map((id) => ({ id, outcome: 'Passed' }))
    });
    const value = {
        catalog,
        sourceState,
        runId: 'run-1',
        namespace: 'namespace-1',
        backend: {
            summary: backendSummary,
            digest: digest(backendSummary),
            results: catalog.backendTestIds.map((id) => ({ id, outcome: 'Passed' }))
        },
        frontend: {
            summary: frontendSummary,
            summaryDigest: digest(frontendSummary),
            catalog: frontendCatalog,
            catalogDigest: digest(frontendCatalog),
            results: catalog.frontendTestIds.map((id) => ({ id, outcome: 'passed' }))
        },
        staticGovernance: { receipts: [staticReceipt], digests: [digest(staticReceipt)] },
        integration: { receipt: integrationReceipt },
        generatedAt: '2026-07-22T00:00:00.000Z'
    };
    return structuredClone(value);
}

test('Rights V3 projects the complete canonical producer assertion catalog without runner launches', () =>
{
    const receipt = projectRightsV3Evidence(fixture());
    assert.equal(receipt.status, 'success');
    assert.deepEqual(receipt.expectedIds, {
        backendTestIds: catalog.backendTestIds,
        frontendTestIds: catalog.frontendTestIds,
        staticRuleIds: catalog.staticRuleIds,
        integrationTestIds: catalog.integrationTestIds,
        coverageIds: catalog.coverageIds
    });
    assert.deepEqual(receipt.executionBoundary, {
        childProcessCount: 0,
        dotnetTestLaunchCount: 0,
        vitestLaunchCount: 0,
        staticCheckerLaunchCount: 0
    });
});

test('Rights V3 fails closed for missing backend and frontend IDs', () =>
{
    const missingBackend = fixture();
    missingBackend.backend.results.pop();
    assert.throws(() => projectRightsV3Evidence(missingBackend), /backend producer is missing required ID/u);
    const missingFrontend = fixture();
    missingFrontend.frontend.results.pop();
    assert.throws(() => projectRightsV3Evidence(missingFrontend), /frontend producer is missing required ID/u);
});

test('Rights V3 fails closed for duplicate and failed canonical results', () =>
{
    const duplicate = fixture();
    duplicate.frontend.results.push(duplicate.frontend.results[0]);
    assert.throws(() => projectRightsV3Evidence(duplicate), /frontend producer contains duplicate IDs/u);
    const failed = fixture();
    failed.backend.results[0].outcome = 'Failed';
    assert.throws(() => projectRightsV3Evidence(failed), /backend producer required ID did not pass/u);
});

test('Rights V3 rejects wrong source, run, and producer digest', () =>
{
    const wrongSource = fixture();
    wrongSource.backend.summary.producer.sourceCommit = 'd'.repeat(40);
    wrongSource.backend.digest = digest(wrongSource.backend.summary);
    assert.throws(() => projectRightsV3Evidence(wrongSource), /backend producer source mismatch/u);
    const wrongRun = fixture();
    wrongRun.frontend.summary.schedulerRunId = 'old-run';
    wrongRun.frontend.summaryDigest = digest(wrongRun.frontend.summary);
    assert.throws(() => projectRightsV3Evidence(wrongRun), /frontend producer run mismatch/u);
    const wrongDigest = fixture();
    wrongDigest.staticGovernance.digests[0] = `sha256:${'f'.repeat(64)}`;
    assert.throws(() => projectRightsV3Evidence(wrongDigest), /static governance 0 producer digest mismatch/u);
});

test('Rights V3 lane is projection-only and integration producer is attached to the canonical integration universe', () =>
{
    const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/rights-v3-test-matrix.sh'), 'utf8');
    assert.doesNotMatch(lane, /dotnet\s+(?:build|test)|vitest|check:public-page-manifest-sync|check-article-editor-workspace-governance/u);
    assert.match(lane, /project-rights-v3-evidence\.mjs/u);
    const suite = fs.readFileSync(path.join(root, 'tools/test/lanes/_suite-support.sh'), 'utf8');
    assert.match(suite, /Category=Integration[\s\S]*write-rights-v3-integration-producer\.mjs/u);
});
