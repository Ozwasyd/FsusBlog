#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { digestValue } = await import(new URL("../../fact-extractors/lib/canonicalize.mjs", import.meta.url));
const { runExtractor } = await import(new URL("../../fact-extractors/runner.mjs", import.meta.url));

import {
    committedOpenApiPath,
    generatedOpenApiPath,
    loadProtocol,
    root
} from './openapi-contracts.mjs';

export const observationArtifactId = 'openapi-aeds-observation';
export const observationRelativeDir = '.tmp/contracts/openapi';
export const observationFileName = 'api-aeds-observation.json';
export const observedOpenApiFileName = 'fsusblog.openapi.observed.json';
export const observationToolProject = 'tools/contracts/FsusBlog.OpenApiObservation/FsusBlog.OpenApiObservation.csproj';
export const contractsRelative = 'src/shared/Contracts/Validation/aeds-endpoint-contracts.json';
export const protocolRelative = 'src/shared/Contracts/Validation/aeds-protocol.json';

const fail = (message) =>
{
    throw new Error(`[openapi-observation] ${message}`);
};

export function observationPaths(repositoryRoot = root)
{
    const directory = path.join(repositoryRoot, observationRelativeDir);
    return {
        directory,
        observationPath: path.join(directory, observationFileName),
        observedOpenApiPath: path.join(directory, observedOpenApiFileName),
        relativeObservationPath: `${observationRelativeDir}/${observationFileName}`,
        relativeObservedOpenApiPath: `${observationRelativeDir}/${observedOpenApiFileName}`
    };
}

export function sha256File(filePath)
{
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function sha256Text(text)
{
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Produce observation + observed OpenAPI from the current compiled endpoint registration.
 * Does not start a public listener. Binds digests for exact-build-receipt extractors.
 */
export function produceOpenApiObservation({
    repositoryRoot = root,
    configuration = 'Release',
    rebuild = true
} = {})
{
    const paths = observationPaths(repositoryRoot);
    mkdirSync(paths.directory, { recursive: true });

    const project = path.join(repositoryRoot, observationToolProject);
    if (!existsSync(project))
    {
        fail(`observation tool missing: ${observationToolProject}`);
    }

    if (rebuild)
    {
        const build = spawnSync(
            'dotnet',
            ['build', project, '-c', configuration, '-v', 'minimal'],
            { cwd: repositoryRoot, encoding: 'utf8', env: process.env }
        );
        if (build.status !== 0)
        {
            fail(`dotnet build failed:\n${build.stdout}\n${build.stderr}`);
        }
    }

    const run = spawnSync(
        'dotnet',
        [
            'run',
            '--project',
            project,
            '-c',
            configuration,
            '--no-build',
            '--',
            '--output',
            paths.observationPath,
            '--repository-root',
            repositoryRoot,
            '--contracts',
            path.join(repositoryRoot, contractsRelative)
        ],
        { cwd: repositoryRoot, encoding: 'utf8', env: process.env }
    );
    if (run.status !== 0)
    {
        fail(`observation host failed:\n${run.stdout}\n${run.stderr}`);
    }
    if (!existsSync(paths.observationPath) || !existsSync(paths.observedOpenApiPath))
    {
        fail('observation host did not write observation and openapi artifacts');
    }

    const observation = JSON.parse(readFileSync(paths.observationPath, 'utf8'));
    const artifactDigest = sha256File(paths.observationPath);
    const openapiDigest = sha256File(paths.observedOpenApiPath);
    const receiptBody = {
        schema: 'fsusblog.openapi-observation-build-receipt.v1',
        artifactId: observationArtifactId,
        observationPath: paths.relativeObservationPath,
        openapiPath: paths.relativeObservedOpenApiPath,
        observationDigest: observation.observationDigest,
        artifactDigest,
        openapiDigest,
        configuration
    };
    const receiptDigest = digestValue(receiptBody);
    const buildIdentity = {
        artifactId: observationArtifactId,
        receiptDigest,
        artifactDigest
    };
    const receiptPath = path.join(paths.directory, 'build-receipt.json');
    writeFileSync(receiptPath, `${JSON.stringify({ ...receiptBody, buildIdentity }, null, 2)}\n`);

    return {
        observation,
        observationPath: paths.observationPath,
        observedOpenApiPath: paths.observedOpenApiPath,
        observedOpenApiText: readFileSync(paths.observedOpenApiPath, 'utf8'),
        buildIdentity,
        receiptPath,
        receiptBody,
        buildSourcePaths: []
    };
}

export function loadProducedObservation(repositoryRoot = root)
{
    const paths = observationPaths(repositoryRoot);
    if (!existsSync(paths.observationPath))
    {
        fail(`missing observation artifact at ${paths.relativeObservationPath}; run produceOpenApiObservation first`);
    }
    return JSON.parse(readFileSync(paths.observationPath, 'utf8'));
}

export function canonicalizeOpenApiDocument(document)
{
    // Stable projection: sort path keys and method keys.
    const paths = {};
    for (const pathKey of Object.keys(document.paths ?? {}).sort())
    {
        const item = document.paths[pathKey] ?? {};
        const methods = {};
        for (const method of Object.keys(item).sort())
        {
            methods[method] = item[method];
        }
        paths[pathKey] = methods;
    }
    return {
        ...document,
        paths
    };
}

export function openApiProjectionTextFromObservationFile(observedOpenApiPath)
{
    const document = JSON.parse(readFileSync(observedOpenApiPath, 'utf8'));
    return `${JSON.stringify(canonicalizeOpenApiDocument(document), null, 2)}\n`;
}

export function assertProjectionExactMatch(observedText, committedText)
{
    if (observedText !== committedText)
    {
        fail('checked-in OpenAPI projection drifted from current observation; rerun export with --update-snapshot');
    }
}

export function validateObservationAgainstProtocol(observation, protocol = loadProtocol())
{
    const frames = new Set((protocol.frameTypes ?? []).map((frame) => frame.name));
    const errors = [];
    const operationIds = new Set();
    const methodPaths = new Set();

    if (!observation || observation.schema !== 'fsusblog.api-aeds-observation.v2')
    {
        errors.push('observation schema must be fsusblog.api-aeds-observation.v2');
        return errors;
    }
    if (observation.protocol !== 'AEDS')
    {
        errors.push('protocol must be AEDS');
    }
    if (Number(observation.aedsVersion) !== Number(protocol.header?.version ?? 2))
    {
        errors.push('AEDS version drift from protocol');
    }
    if (!Array.isArray(observation.operations) || observation.operations.length === 0)
    {
        errors.push('observation operations empty');
        return errors;
    }
    const states = observation.protocolStates;
    if (states?.aedsOnly !== true
        || JSON.stringify(states?.supportedVersions) !== JSON.stringify([Number(protocol.header?.version ?? 2)])
        || !Array.isArray(states?.activeFrameIds) || states.activeFrameIds.length === 0
        || !Array.isArray(states?.retiredFrameValues) || !Array.isArray(states?.migrationOnlyFrameIds))
    {
        errors.push('closed active/retired/migration/AEDS-only protocol states missing');
    }

    for (const op of observation.operations)
    {
        const key = `${op.method} ${op.path}`;
        if (methodPaths.has(key))
        {
            errors.push(`duplicate method/path ${key}`);
        }
        methodPaths.add(key);
        if (!op.operationId)
        {
            errors.push(`${key} missing operationId`);
        }
        if (operationIds.has(op.operationId))
        {
            errors.push(`duplicate operationId ${op.operationId}`);
        }
        operationIds.add(op.operationId);
        if (op.protocol !== 'AEDS')
        {
            errors.push(`${key} protocol must be AEDS`);
        }
        if (Number(op.aedsVersion) !== Number(protocol.header?.version ?? 2))
        {
            errors.push(`${key} AEDS version drift`);
        }
        if (!op.responseFrame)
        {
            errors.push(`${key} missing responseFrame`);
        }
        for (const [name, frame] of [
            ['request', op.requestFrame],
            ['response', op.responseFrame],
            ['error', op.errorFrame]
        ])
        {
            if (!frame || frame === 'server-only/no-response-body')
            {
                continue;
            }
            if (!frames.has(frame))
            {
                errors.push(`${key} ${name} frame ${frame} is not in aeds-protocol.json`);
            }
            if (/^\d+$/.test(String(frame)))
            {
                errors.push(`${key} ${name} frame must use name, not number`);
            }
        }
        if (op.errorFrame !== 'ApiError')
        {
            errors.push(`${key} errorFrame must be ApiError`);
        }
        if (!['anonymous', 'optional', 'user', 'admin'].includes(op.auth))
        {
            errors.push(`${key} invalid auth ${op.auth}`);
        }
        if (typeof op.pow !== 'boolean')
        {
            errors.push(`${key} pow must be boolean`);
        }
        if (!op.rateLimit)
        {
            errors.push(`${key} missing rateLimit`);
        }
        if (!op.cache)
        {
            errors.push(`${key} missing cache`);
        }
        if (!op.permission)
        {
            errors.push(`${key} missing permission classification`);
        }
        if (!op.request || !['none', 'aeds-frame-body'].includes(op.request.source)
            || typeof op.request.required !== 'boolean' || typeof op.request.nullable !== 'boolean'
            || !Array.isArray(op.request.requiredFields) || op.request.requiredFields.length !== 0
            || !Array.isArray(op.request.parameters)
            || !['not-applicable', 'opaque-aeds-frame'].includes(op.request.fieldSetState)
            || !['not-applicable', 'opaque-aeds-frame'].includes(op.request.boundsState)
            || !['not-applicable', 'opaque-aeds-frame'].includes(op.request.unionState))
        {
            errors.push(`${key} typed request contract missing`);
        }
        if (!Array.isArray(op.responses) || op.responses.length !== 2
            || op.responses.some((response) => response.resultPlacement !== 'aeds.frame.payload'
                || response.contentType !== 'application/octet-stream'))
        {
            errors.push(`${key} typed response/result placement missing`);
        }
        if (op.errorAuthorityBehaviorId !== 'configuration-error-security-policy'
            || op.publicErrorRefState !== 'transport-frame-authority-only'
            || JSON.stringify(op.publicErrorRefs) !== JSON.stringify(['configuration-error-security-policy:error-transport-mappings:ApiError']))
        {
            errors.push(`${key} public error authority reference invalid`);
        }
    }
    return errors;
}

export async function runOpenApiFactExtractor({
    repositoryRoot = root,
    buildIdentity,
    buildReceiptPath,
    buildReceiptSchema,
    buildSourcePaths,
    useCache = false
} = {})
{
    if (!buildIdentity)
    {
        fail('buildIdentity required for openapi-aeds-fact-extractor');
    }
    return runExtractor({
        extractorId: 'openapi-aeds-fact-extractor',
        repositoryRoot,
        buildIdentity,
        buildReceiptPath,
        buildReceiptSchema,
        buildSourcePaths,
        useCache
    });
}

export function writeCommittedOpenApiProjection(observedOpenApiPath, destination = committedOpenApiPath)
{
    const text = openApiProjectionTextFromObservationFile(observedOpenApiPath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, text);
    writeGeneratedOpenApiProjection(observedOpenApiPath);
    return text;
}

export function writeGeneratedOpenApiProjection(observedOpenApiPath, destination = generatedOpenApiPath)
{
    const text = openApiProjectionTextFromObservationFile(observedOpenApiPath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, text);
    return text;
}

export function compareCommittedProjection(observedOpenApiPath, committedPath = committedOpenApiPath)
{
    const observedText = openApiProjectionTextFromObservationFile(observedOpenApiPath);
    const committedText = existsSync(committedPath) ? readFileSync(committedPath, 'utf8') : '';
    return {
        equal: observedText === committedText,
        observedText,
        committedText
    };
}

export function observationToFactObservations(observation)
{
    const operations = {};
    for (const op of [...observation.operations].sort((a, b) => a.operationId.localeCompare(b.operationId)))
    {
        operations[op.operationId] = {
            method: op.method,
            path: op.path,
            protocol: op.protocol,
            aedsVersion: op.aedsVersion,
            requestFrame: op.requestFrame ?? 'none',
            responseFrame: op.responseFrame,
            errorFrame: op.errorFrame,
            auth: op.auth,
            permission: op.permission,
            pow: op.pow,
            rateLimit: op.rateLimit,
            cache: op.cache,
            successStatus: op.successStatus
        };
    }
    return {
        operationCount: observation.operationCount,
        operationKeys: [...observation.operationKeys].sort(),
        operations,
        observationDigest: observation.observationDigest,
        protocol: observation.protocol,
        aedsVersion: observation.aedsVersion
    };
}

// Keep fileURLToPath import live for potential CLI usage detection.
void fileURLToPath;
