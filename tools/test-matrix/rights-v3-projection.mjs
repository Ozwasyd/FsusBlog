import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { projectionContentDigest, sealProjectionDocument } from './evidence-projection.mjs';
import { parseTrxResults } from './integrity-proof-producer.mjs';

export const rightsV3CatalogSchema = 'fsusblog.rights-v3-projection-catalog.v1';
export const rightsV3ReceiptSchema = 'fsusblog.rights-v3-test-matrix.v2';
export const rightsV3IntegrationProducerSchema = 'fsusblog.rights-v3-integration-producer.v1';

function requiredText(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!normalized)
    {
        throw new Error(`${label} must be non-empty`);
    }
    return normalized;
}

function sortedUnique(values, label)
{
    if (!Array.isArray(values) || values.length === 0)
    {
        throw new Error(`${label} must be a non-empty array`);
    }
    const normalized = values.map((entry) => requiredText(entry, `${label} entry`));
    if (new Set(normalized).size !== normalized.length)
    {
        throw new Error(`${label} contains duplicate IDs`);
    }
    if (JSON.stringify(normalized) !== JSON.stringify([...normalized].sort()))
    {
        throw new Error(`${label} must be sorted and unique`);
    }
    return normalized;
}

function validateSource(source, label)
{
    if (!/^[a-f0-9]{40}$/u.test(String(source?.commit ?? ''))
        || !/^[a-f0-9]{64}$/u.test(String(source?.worktreeFingerprint ?? '')))
    {
        throw new Error(`${label} has an invalid source identity`);
    }
    return source;
}

function assertSource(actual, expected, label)
{
    validateSource(actual, label);
    if (actual.commit !== expected.commit || actual.worktreeFingerprint !== expected.worktreeFingerprint)
    {
        throw new Error(`${label} source mismatch`);
    }
}

function validateCatalog(catalog)
{
    if (catalog?.schema !== rightsV3CatalogSchema || catalog?.tierId !== 'rights-v3-test-matrix')
    {
        throw new Error('Rights V3 projection catalog schema or tier is invalid');
    }
    return {
        backendTestIds: sortedUnique(catalog.backendTestIds, 'backendTestIds'),
        frontendTestIds: sortedUnique(catalog.frontendTestIds, 'frontendTestIds'),
        staticRuleIds: sortedUnique(catalog.staticRuleIds, 'staticRuleIds'),
        integrationTestIds: sortedUnique(catalog.integrationTestIds, 'integrationTestIds'),
        coverageIds: sortedUnique(catalog.coverageIds, 'coverageIds')
    };
}

function exactPassing(actual, expected, label)
{
    const ids = actual.map((entry) => requiredText(entry?.id, `${label} ID`));
    if (new Set(ids).size !== ids.length)
    {
        throw new Error(`${label} contains duplicate IDs`);
    }
    const byId = new Map(actual.map((entry) => [entry.id, entry]));
    for (const id of expected)
    {
        const entry = byId.get(id);
        if (!entry)
        {
            throw new Error(`${label} is missing required ID: ${id}`);
        }
        if (!['Passed', 'passed', 'success'].includes(entry.outcome ?? entry.status))
        {
            throw new Error(`${label} required ID did not pass: ${id}`);
        }
    }
    return expected.map((id) => ({ id, outcome: 'Passed' }));
}

function artifactDigest(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertProducerDigest(document, digest, label)
{
    const expected = artifactDigest(JSON.stringify(document));
    if (digest !== expected)
    {
        throw new Error(`${label} producer digest mismatch`);
    }
    return expected;
}

export function createRightsV3IntegrationProducer({ sourceState, runId, namespace, trxPath, results, trxDigest })
{
    validateSource(sourceState, 'integration producer');
    return sealProjectionDocument({
        schema: rightsV3IntegrationProducerSchema,
        status: 'success',
        sourceState,
        runId: requiredText(runId, 'integration runId'),
        namespace: requiredText(namespace, 'integration namespace'),
        trx: { path: requiredText(trxPath, 'integration TRX path'), digest: requiredText(trxDigest, 'integration TRX digest') },
        results: results.map((entry) => ({ id: entry.id, outcome: entry.outcome })).sort((left, right) => left.id.localeCompare(right.id))
    });
}

export function projectRightsV3Evidence({
    catalog,
    sourceState,
    runId,
    namespace,
    backend,
    frontend,
    staticGovernance,
    integration,
    generatedAt = new Date().toISOString()
})
{
    const expected = validateCatalog(catalog);
    validateSource(sourceState, 'projection');
    const normalizedRunId = requiredText(runId, 'runId');
    const normalizedNamespace = requiredText(namespace, 'namespace');

    if (backend.summary?.schema !== 'fsusblog.backend-production-shards.v2'
        || backend.summary.status !== 'success'
        || backend.summary.execution?.exactOnce !== true
        || backend.summary.execution?.allPassed !== true)
    {
        throw new Error('backend producer is not a successful exact-once union');
    }
    assertSource({
        commit: backend.summary.producer?.sourceCommit,
        worktreeFingerprint: backend.summary.producer?.sourceFingerprint
    }, sourceState, 'backend producer');
    if (backend.summary.producer?.runId !== normalizedRunId)
    {
        throw new Error('backend producer run mismatch');
    }

    if (frontend.summary?.schema !== 'fsusblog.frontend-vitest-rolling.v2'
        || frontend.summary.status !== 'success'
        || frontend.summary.exactOnce !== true)
    {
        throw new Error('frontend producer is not a successful exact-once rolling result');
    }
    if (frontend.summary.schedulerRunId !== normalizedRunId)
    {
        throw new Error('frontend producer run mismatch');
    }
    assertSource(frontend.catalog?.identity?.source, sourceState, 'frontend producer');
    if (frontend.summary.catalogIdentityDigest !== frontend.catalog.identityDigest)
    {
        throw new Error('frontend producer catalog identity mismatch');
    }

    for (const receipt of staticGovernance.receipts)
    {
        if (receipt?.schema !== 'fsusblog.local-production.frontend-static-governance-phase.v2'
            || receipt.status !== 'success'
            || receipt.schedulerRunId !== normalizedRunId)
        {
            throw new Error('frontend static governance receipt is not successful and run-bound');
        }
    }
    const staticResults = staticGovernance.receipts.flatMap((receipt) =>
        (receipt.execution?.timings ?? []).map((entry) => ({ id: entry.id, outcome: entry.status })));

    if (integration.receipt?.schema !== rightsV3IntegrationProducerSchema
        || integration.receipt.status !== 'success'
        || integration.receipt.contentDigest !== projectionContentDigest(integration.receipt))
    {
        throw new Error('integration producer receipt is invalid');
    }
    assertSource(integration.receipt.sourceState, sourceState, 'integration producer');
    if (integration.receipt.runId !== normalizedRunId || integration.receipt.namespace !== normalizedNamespace)
    {
        throw new Error('integration producer run or namespace mismatch');
    }

    const producerDigests = {
        backend: assertProducerDigest(backend.summary, backend.digest, 'backend'),
        frontendCatalog: assertProducerDigest(frontend.catalog, frontend.catalogDigest, 'frontend catalog'),
        frontendSummary: assertProducerDigest(frontend.summary, frontend.summaryDigest, 'frontend summary'),
        staticGovernance: staticGovernance.receipts.map((receipt, index) =>
            assertProducerDigest(receipt, staticGovernance.digests[index], `static governance ${index}`)),
        integration: integration.receipt.contentDigest
    };

    const backendAssertions = exactPassing(backend.results, expected.backendTestIds, 'backend producer');
    const frontendAssertions = exactPassing(frontend.results, expected.frontendTestIds, 'frontend producer');
    const staticAssertions = exactPassing(staticResults, expected.staticRuleIds, 'static governance producer');
    const integrationAssertions = exactPassing(integration.receipt.results, expected.integrationTestIds, 'integration producer');

    return sealProjectionDocument({
        schema: rightsV3ReceiptSchema,
        status: 'success',
        executionMode: 'projection',
        tierId: 'rights-v3-test-matrix',
        sourceState,
        runId: normalizedRunId,
        namespace: normalizedNamespace,
        producerDigests,
        expectedIds: expected,
        assertions: { backend: backendAssertions, frontend: frontendAssertions, static: staticAssertions, integration: integrationAssertions },
        executionBoundary: { childProcessCount: 0, dotnetTestLaunchCount: 0, vitestLaunchCount: 0, staticCheckerLaunchCount: 0 },
        generatedAt
    });
}

export function readTrxResults(files)
{
    return files.flatMap((file) => parseTrxResults(file)).map((entry) => ({ id: entry.sourceTestId, outcome: entry.outcome }));
}

export function sha256File(file)
{
    return artifactDigest(fs.readFileSync(file));
}

export function repositoryPath(root, file)
{
    return path.relative(root, file).replaceAll(path.sep, '/');
}
