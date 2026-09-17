import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    createEvidenceProducerReceipt,
    evidenceProjectionCatalogSchema,
    projectionContentDigest,
    sealProjectionDocument
} from './evidence-projection.mjs';

function decodeXml(value)
{
    return String(value ?? '')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}

function trxAttribute(text, name)
{
    const match = text.match(new RegExp(`\\b${name}="([^"]*)"`, 'u'));
    return decodeXml(match?.[1] ?? '');
}

export function parseTrxResults(file)
{
    const xml = fs.readFileSync(file, 'utf8');
    const definitions = new Map();
    for (const match of xml.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gu))
    {
        const id = trxAttribute(match[1], 'id');
        const method = match[2].match(/<TestMethod\b([^>]*)\/>/u)?.[1] ?? '';
        definitions.set(id, `${trxAttribute(method, 'className')}.${trxAttribute(method, 'name')}`);
    }
    return [...xml.matchAll(/<UnitTestResult\b([^>]*)\/?>(?:<\/UnitTestResult>)?/gu)].map((match) => ({
        sourceTestId: trxAttribute(match[1], 'testName') || definitions.get(trxAttribute(match[1], 'testId')) || '',
        methodId: definitions.get(trxAttribute(match[1], 'testId')) || '',
        outcome: trxAttribute(match[1], 'outcome')
    })).filter((entry) => entry.sourceTestId);
}

function sha256File(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function validateCatalog(catalog)
{
    if (catalog?.schema !== evidenceProjectionCatalogSchema || catalog.tierId !== 'integrity-proof-verification')
    {
        throw new Error('integrity proof producer requires the canonical projection catalog');
    }
    if (!Array.isArray(catalog.producerAssertions) || catalog.producerAssertions.length === 0)
    {
        throw new Error('integrity proof catalog requires producerAssertions');
    }
    const ids = catalog.producerAssertions.map((entry) => entry?.id);
    const sourceIds = catalog.producerAssertions.map((entry) => entry?.sourceTestId);
    if (ids.some((id) => typeof id !== 'string' || !id)
    || sourceIds.some((id) => typeof id !== 'string' || !id)
    || new Set(ids).size !== ids.length
    || new Set(sourceIds).size !== sourceIds.length)
    {
        throw new Error('integrity proof producer assertion IDs and source test IDs must be non-empty and unique');
    }
    if (JSON.stringify(ids) !== JSON.stringify([...ids].sort()))
    {
        throw new Error('integrity proof producer assertions must be sorted by ID');
    }
    if (JSON.stringify(ids) !== JSON.stringify(catalog.requiredTestIds))
    {
        throw new Error('integrity proof producer assertions must exactly match requiredTestIds');
    }
    return catalog.producerAssertions;
}

export function writeIntegrityProofProducer({
    catalog,
    trxFiles,
    repositoryRoot,
    sourceState,
    runId,
    namespace,
    producerOutput,
    sourceOutput,
    generatedAt = new Date().toISOString()
})
{
    const declarations = validateCatalog(catalog);
    const results = trxFiles.flatMap(parseTrxResults);
    const integrityPrefix = 'FsusBlog.Server.Tests.Unit.IntegrityProofVerification';
    const integrityResults = results.filter((entry) => entry.sourceTestId.startsWith(integrityPrefix));
    const expectedSourceIds = new Set(declarations.map((entry) => entry.sourceTestId));
    const actualSourceIds = integrityResults.map((entry) => entry.sourceTestId).sort();
    if (new Set(actualSourceIds).size !== actualSourceIds.length)
    {
        throw new Error('integrity proof producer received duplicate source test results');
    }
    if (JSON.stringify(actualSourceIds) !== JSON.stringify([...expectedSourceIds].sort()))
    {
        const missing = [...expectedSourceIds].filter((id) => !actualSourceIds.includes(id));
        const unexpected = actualSourceIds.filter((id) => !expectedSourceIds.has(id));
        throw new Error(`integrity proof source result set mismatch; missing=${missing.join(',') || '<none>'}; unexpected=${unexpected.join(',') || '<none>'}`);
    }

    const bySourceId = new Map(integrityResults.map((entry) => [entry.sourceTestId, entry]));
    const sourceDocument = sealProjectionDocument({
        schema: 'fsusblog.integrity-proof-source-results.v1',
        status: integrityResults.every((entry) => entry.outcome === 'Passed') ? 'success' : 'failure',
        producerId: catalog.projectFrom,
        sourceState,
        runId,
        namespace,
        results: declarations.map((declaration) => ({
            assertionId: declaration.id,
            sourceTestId: declaration.sourceTestId,
            outcome: bySourceId.get(declaration.sourceTestId).outcome
        })),
        generatedAt
    });
    writeJsonAtomic(sourceOutput, sourceDocument);

    const sourcePath = path.relative(repositoryRoot, sourceOutput).replaceAll(path.sep, '/');
    const declaredSource = catalog.requiredArtifactDeclarations?.find((entry) => entry.id === 'integrity-proof-source-results');
    if (!declaredSource || declaredSource.path !== sourcePath)
    {
        throw new Error(`integrity proof source artifact path mismatch: expected ${declaredSource?.path ?? '<missing>'}, received ${sourcePath}`);
    }
    if (sourceDocument.contentDigest !== projectionContentDigest(sourceDocument))
    {
        throw new Error('integrity proof source result content digest mismatch');
    }

    const receipt = createEvidenceProducerReceipt({
        producerId: catalog.projectFrom,
        sourceState,
        runId,
        namespace,
        assertions: declarations.map((declaration) => ({
            id: declaration.id,
            sourceTestIds: [declaration.sourceTestId],
            outcome: bySourceId.get(declaration.sourceTestId).outcome,
            coverageIds: declaration.coverageIds,
            artifactIds: ['integrity-proof-source-results']
        })),
        artifacts: [{
            id: 'integrity-proof-source-results',
            path: sourcePath,
            digest: sha256File(sourceOutput)
        }],
        generatedAt
    });
    writeJsonAtomic(producerOutput, receipt);
    return { receipt, sourceDocument, producerOutput, sourceOutput };
}
