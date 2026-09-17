#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
    committedOpenApiPath,
    frameNames,
    loadProtocol,
    operationsFromOpenApi,
    root
} from './lib/openapi-contracts.mjs';
import {
    assertProjectionExactMatch,
    compareCommittedProjection,
    produceOpenApiObservation,
    runOpenApiFactExtractor,
    validateObservationAgainstProtocol,
    writeCommittedOpenApiProjection,
    writeGeneratedOpenApiProjection
} from './lib/openapi-observation.mjs';

const args = process.argv.slice(2);
const updateSnapshot = args.includes('--update-snapshot');
const skipRebuild = args.includes('--no-rebuild');

const produced = produceOpenApiObservation({
    repositoryRoot: root,
    rebuild: !skipRebuild
});

const protocol = loadProtocol();
const protocolErrors = validateObservationAgainstProtocol(produced.observation, protocol);
if (protocolErrors.length > 0)
{
    for (const error of protocolErrors)
    {
        console.error(`[openapi-sync] ${error}`);
    }
    process.exit(1);
}

const extractorResult = await runOpenApiFactExtractor({
    repositoryRoot: root,
    buildIdentity: produced.buildIdentity,
    useCache: false
});
if (extractorResult.receipt.status !== 'ok')
{
    for (const reason of extractorResult.receipt.failureReasons)
    {
        console.error(`[openapi-sync] extractor failed: ${reason}`);
    }
    process.exit(1);
}

const receiptDir = path.join(root, '.tmp/fact-observation-receipts');
mkdirSync(receiptDir, { recursive: true });
const receiptPath = path.join(receiptDir, 'openapi-aeds-fact-extractor.latest.json');
writeFileSync(receiptPath, `${JSON.stringify(extractorResult.receipt, null, 2)}\n`);

if (updateSnapshot)
{
    writeCommittedOpenApiProjection(produced.observedOpenApiPath, committedOpenApiPath);
    console.log(`[openapi-sync] updated projection ${committedOpenApiPath}`);
}
else
{
    const comparison = compareCommittedProjection(produced.observedOpenApiPath, committedOpenApiPath);
    if (!comparison.equal)
    {
        console.error('[openapi-sync] checked-in OpenAPI projection differs from current observation');
        console.error(`[openapi-sync] observed=${produced.observedOpenApiPath}`);
        console.error(`[openapi-sync] committed=${committedOpenApiPath}`);
        console.error('[openapi-sync] rerun with --update-snapshot after reviewing bidirectional drift');
        process.exit(1);
    }
    assertProjectionExactMatch(comparison.observedText, comparison.committedText);
}
writeGeneratedOpenApiProjection(produced.observedOpenApiPath);

// Projection must not be readable as observation input (one-way).
const committed = JSON.parse(readFileSync(committedOpenApiPath, 'utf8'));
if (committed['x-fsus-contract-source']?.matrix)
{
    console.error('[openapi-sync] projection still claims matrix as contract source');
    process.exit(1);
}
if (committed['x-fsus-contract-source']?.observation !== 'compiled-endpoint-metadata')
{
    console.error('[openapi-sync] projection must declare compiled-endpoint-metadata observation source');
    process.exit(1);
}

const operations = operationsFromOpenApi(committed);
const frames = frameNames(protocol);
const errors = [];
for (const op of operations)
{
    if (op.operation['x-fsus-protocol'] !== 'AEDS')
    {
        errors.push(`${op.key} missing x-fsus-protocol=AEDS`);
    }
    if (Number(op.operation['x-fsus-aeds-version']) !== Number(protocol.header?.version ?? 2))
    {
        errors.push(`${op.key} AEDS version drift`);
    }
    if (!op.responseFrame)
    {
        errors.push(`${op.key} missing x-fsus-response-frame`);
    }
    for (const [name, frame] of [['request', op.requestFrame], ['response', op.responseFrame], ['error', op.errorFrame]])
    {
        if (!frame || frame === 'server-only/no-response-body')
        {
            continue;
        }
        if (!frames.has(frame))
        {
            errors.push(`${op.key} ${name} frame ${frame} is not in aeds-protocol.json`);
        }
        if (/^\d+$/.test(String(frame)))
        {
            errors.push(`${op.key} ${name} frame must use name, not number`);
        }
    }
    if (op.errorFrame !== 'ApiError')
    {
        errors.push(`${op.key} x-fsus-error-frame must be ApiError`);
    }
    if (!['anonymous', 'optional', 'user', 'admin'].includes(op.auth))
    {
        errors.push(`${op.key} invalid auth classification ${op.auth}`);
    }
    if (typeof op.pow !== 'boolean')
    {
        errors.push(`${op.key} x-fsus-pow must be boolean`);
    }
}

// Bidirectional exactness: observation operation set vs projection operation set.
const observedKeys = new Set(produced.observation.operationKeys);
const projectionKeys = new Set(operations.map((op) =>
{
    const normalizedPath = String(op.fullPath).replace(/\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]+)?\}/gu, '{$1}');
    return `${op.method} ${normalizedPath}`;
}));
const missingInProjection = [...observedKeys].filter((key) =>
{
    const normalized = key.replace(/\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]+)?\}/gu, '{$1}');
    return !projectionKeys.has(normalized) && !projectionKeys.has(key);
}).sort();
const extraInProjection = [...projectionKeys].filter((key) =>
{
    const normalized = key.replace(/\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]+)?\}/gu, '{$1}');
    return !observedKeys.has(normalized) && !observedKeys.has(key);
}).sort();
if (missingInProjection.length > 0 || extraInProjection.length > 0)
{
    errors.push(`implementation↔projection set drift missing=${missingInProjection.join(', ')} extra=${extraInProjection.join(', ')}`);
}

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[openapi-sync] ${error}`);
    }
    process.exit(1);
}

if (!existsSync(receiptPath))
{
    console.error('[openapi-sync] missing extractor receipt');
    process.exit(1);
}

console.log(
    `[openapi-sync] ok operations=${operations.length} observationDigest=${produced.observation.observationDigest.slice(0, 12)} receipt=${path.relative(root, receiptPath)}`
);
