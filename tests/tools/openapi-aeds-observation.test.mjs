import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { digestCatalog, loadCatalog } = await import(new URL("../../tools/contracts/behavior-contract-catalog.mjs", import.meta.url));
const { digestValue } = await import(new URL("../../tools/fact-extractors/lib/canonicalize.mjs", import.meta.url));
const { buildOpenApiFromMatrix, committedOpenApiPath, operationsFromOpenApi, readJson, loadProtocol } = await import(new URL("../../tools/contracts/lib/openapi-contracts.mjs", import.meta.url));
const { observationBuildSourcePaths, observationContentDigest, openApiProjectionTextFromObservationFile, observationToFactObservations, validateObservationAgainstProtocol, writeGeneratedOpenApiProjection } = await import(new URL("../../tools/contracts/lib/openapi-observation.mjs", import.meta.url));
const { extract: extractOpenApi } = await import(new URL("../../tools/fact-extractors/openapi-aeds/extract.mjs", import.meta.url));
const { loadRegistry, validateOwnershipAgainstBehaviorCatalog, root } = await import(new URL("../../tools/fact-extractors/registry.mjs", import.meta.url));

const observationRelative = '.tmp/contracts/openapi/api-aeds-observation.json';
const observedOpenApiRelative = '.tmp/contracts/openapi/fsusblog.openapi.observed.json';
const buildReceiptRelative = '.tmp/contracts/openapi/build-receipt.json';

function sha256(buffer)
{
    return createHash('sha256').update(buffer).digest('hex');
}

function writeObservation(repositoryRoot, observation)
{
    const protocol = {
        schemaVersion: 1,
        header: { size: 16, magic: '0x53444541', version: 2 },
        frameTypes: [
            { name: 'Unknown', value: 0 },
            { name: 'ArticleDetail', value: 2 },
            { name: 'ArticleWriteRequest', value: 100 },
            { name: 'MutationId', value: 241 },
            { name: 'ApiError', value: 251 },
            { name: 'Reserved177', value: 177 }
        ],
        retiredFrameValues: [{ value: 40, reason: 'legacy-test' }]
    };
    const catalog = { schema: 'fixture-behavior-catalog', contracts: [] };
    const endpointContent = {
        schema: 'fsusblog.aeds-endpoint-contracts.v2',
        protocol: 'AEDS',
        aedsVersion: 2,
        operations: []
    };
    const endpointDigest = sha256(Buffer.from(JSON.stringify(endpointContent), 'utf8'));
    const writeJson = (relative, value) =>
    {
        const absolute = path.join(repositoryRoot, relative);
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
    };
    for (const relative of observationBuildSourcePaths)
    {
        const absolute = path.join(repositoryRoot, relative);
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, `fixture source: ${relative}\n`);
    }
    writeJson('src/shared/Contracts/Validation/aeds-protocol.json', protocol);
    writeJson('config/contracts/behavior-contracts.json', catalog);
    writeJson('src/shared/Contracts/Validation/aeds-endpoint-contracts.json', {
        ...endpointContent,
        contentDigest: endpointDigest
    });
    observation.errorAuthority.catalogDigest = digestCatalog(catalog);
    observation.endpointContractAuthority.contentDigest = endpointDigest;
    observation.observationDigest = observationContentDigest(observation);
    const absolute = path.join(repositoryRoot, observationRelative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    const text = `${JSON.stringify(observation, null, 2)}\n`;
    writeFileSync(absolute, text);
    writeJson(observedOpenApiRelative, { openapi: '3.1.0', paths: {} });
    const sourceDigests = Object.fromEntries(observationBuildSourcePaths.map((relative) => [
        relative,
        sha256(readFileSync(path.join(repositoryRoot, relative)))
    ]));
    const artifactDigest = sha256(Buffer.from(text, 'utf8'));
    const receiptBody = {
        schema: 'fsusblog.openapi-observation-build-receipt.v1',
        artifactId: 'openapi-aeds-observation',
        observationPath: observationRelative,
        openapiPath: observedOpenApiRelative,
        observationDigest: observation.observationDigest,
        artifactDigest,
        openapiDigest: sha256(readFileSync(path.join(repositoryRoot, observedOpenApiRelative))),
        sourceDigests,
        sourceDigest: digestValue(sourceDigests),
        contractDigest: endpointDigest,
        errorCatalogDigest: observation.errorAuthority.catalogDigest,
        generatorDigest: sourceDigests['tools/contracts/lib/openapi-observation.mjs'],
        protocolDigest: sourceDigests['src/shared/Contracts/Validation/aeds-protocol.json'],
        configuration: 'Release'
    };
    const fullIdentity = {
        artifactId: receiptBody.artifactId,
        receiptDigest: digestValue(receiptBody),
        artifactDigest,
        sourceDigest: receiptBody.sourceDigest,
        contractDigest: receiptBody.contractDigest,
        errorCatalogDigest: receiptBody.errorCatalogDigest,
        generatorDigest: receiptBody.generatorDigest,
        protocolDigest: receiptBody.protocolDigest
    };
    writeJson(buildReceiptRelative, { ...receiptBody, buildIdentity: fullIdentity });
    return {
        absolute,
        artifactDigest,
        buildIdentity: {
            artifactId: fullIdentity.artifactId,
            receiptDigest: fullIdentity.receiptDigest,
            artifactDigest: fullIdentity.artifactDigest
        },
        text
    };
}

function identityFor(_observation, artifactDigest, overrides = {})
{
    return {
        artifactId: 'openapi-aeds-observation',
        receiptDigest: 'b'.repeat(64),
        artifactDigest,
        ...overrides
    };
}

function rewriteReceipt(repositoryRoot, mutate)
{
    const absolute = path.join(repositoryRoot, buildReceiptRelative);
    const receipt = JSON.parse(readFileSync(absolute, 'utf8'));
    mutate(receipt);
    const { buildIdentity: _oldIdentity, ...body } = receipt;
    receipt.buildIdentity = {
        artifactId: body.artifactId,
        receiptDigest: digestValue(body),
        artifactDigest: body.artifactDigest,
        sourceDigest: body.sourceDigest,
        contractDigest: body.contractDigest,
        errorCatalogDigest: body.errorCatalogDigest,
        generatorDigest: body.generatorDigest,
        protocolDigest: body.protocolDigest
    };
    writeFileSync(absolute, `${JSON.stringify(receipt, null, 2)}\n`);
    return {
        artifactId: receipt.buildIdentity.artifactId,
        receiptDigest: receipt.buildIdentity.receiptDigest,
        artifactDigest: receipt.buildIdentity.artifactDigest
    };
}

function sampleObservation(overrides = {})
{
    const emptyBounds = () => ({
        minimum: null, maximum: null, minLength: null, maxLength: null,
        minItems: null, maxItems: null, minProperties: null, maxProperties: null
    });
    const typed = (operation) =>
    {
        const body = operation.requestFrame != null;
        const properties = body
            ? {
                metadata: {
                    name: 'metadata', type: 'object', required: false, nullable: true,
                    format: null, schemaRef: 'clr://FsusBlog.Shared.Contracts.ArticleMetadata',
                    itemType: null, itemSchemaRef: null, enumValues: [], bounds: emptyBounds()
                },
                title: {
                    name: 'title', type: 'string', required: true, nullable: false,
                    format: null, schemaRef: null, itemType: null, itemSchemaRef: null,
                    enumValues: [], bounds: { ...emptyBounds(), minLength: 1, maxLength: 200 }
                }
            }
            : {};
        const definitions = body
            ? {
                'FsusBlog.Shared.Contracts.ArticleMetadata': {
                    typeIdentity: 'FsusBlog.Shared.Contracts.ArticleMetadata',
                    requiredFields: ['category'],
                    properties: {
                        category: {
                            name: 'category', type: 'string', required: true, nullable: false,
                            format: null, schemaRef: null, itemType: null, itemSchemaRef: null,
                            enumValues: [], bounds: emptyBounds()
                        }
                    },
                    oneOf: [], discriminator: null, bounds: {}
                }
            }
            : {};
        const statuses = operation.publicErrorStatuses;
        const request = {
            direction: 'request',
            source: body ? 'aeds-frame-body' : 'none',
            schemaRef: body ? `aeds://request-schema/${operation.operationId}` : null,
            encoding: body ? 'binary-layout' : 'none',
            required: body,
            nullable: false,
            requiredFields: body ? ['title'] : [],
            parameters: body ? [
                {
                    name: 'X-Fsus-Pow-Proof', direction: 'request', source: 'header',
                    schemaRef: 'header://string', required: true, nullable: false,
                    bounds: emptyBounds(),
                    evidence: ['compiled-endpoint-filter:RequiresPowFilter']
                },
                {
                    name: 'dryRun', direction: 'request', source: 'query',
                    schemaRef: 'query://boolean', required: false, nullable: false,
                    bounds: emptyBounds(),
                    evidence: ['compiled-handler-parameter:dryRun']
                }
            ] : [
                {
                    name: 'id', direction: 'request', source: 'path',
                    schemaRef: 'path://int', required: true, nullable: false,
                    bounds: emptyBounds(),
                    evidence: ['compiled-route-template:id']
                }
            ],
            properties,
            definitions,
            oneOf: [],
            discriminator: null,
            bounds: body ? { title: properties.title.bounds } : {},
            fieldSetState: body ? 'closed' : 'not-applicable',
            boundsState: body ? 'closed' : 'not-applicable',
            unionState: body ? 'none' : 'not-applicable',
            schemaDigest: null,
            sourceTypes: body ? ['FsusBlog.Shared.Contracts.ArticleWriteRequest'] : [],
            readerIdentities: body ? ['FsusBlog.Server.Infrastructure.Binary.IBinaryEndpointRequestContext.ReadFrameAsync'] : []
        };
        if (body)
        {
            request.schemaDigest = sha256(Buffer.from(JSON.stringify({
                direction: request.direction,
                schemaRef: request.schemaRef,
                requestFrame: operation.requestFrame,
                encoding: request.encoding,
                parameters: request.parameters,
                requiredFields: request.requiredFields,
                properties: request.properties,
                definitions: request.definitions,
                oneOf: request.oneOf,
                discriminator: request.discriminator,
                bounds: request.bounds,
                sourceTypes: request.sourceTypes,
                readerIdentities: request.readerIdentities
            })));
        }
        return {
            ...operation,
            request,
            responses: [
                {
                    status: operation.successStatus, kind: 'success', schemaRef: `aeds://frame/${operation.responseFrame}`,
                    contentType: 'application/octet-stream', resultPlacement: 'aeds.frame.payload', nullable: false,
                    publicErrorRef: null
                },
                ...statuses.map((status) => ({
                    status, kind: 'error', schemaRef: 'aeds://frame/ApiError',
                    contentType: 'application/octet-stream', resultPlacement: 'aeds.frame.payload', nullable: false,
                    publicErrorRef: `configuration-error-security-policy:error-transport-mappings:${status}`
                }))
            ],
            publicErrorRefs: statuses.map((status) => `configuration-error-security-policy:error-transport-mappings:${status}`),
            publicErrorStatusEvidence: Object.fromEntries(statuses.map((status) => [String(status), [`compiled-test:${status}`]])),
            publicErrorRefState: 'operation-status-authority-bound',
            errorAuthorityBehaviorId: 'configuration-error-security-policy',
            resultPlacement: 'aeds.frame.payload',
            protocolState: 'active-aeds-only'
        };
    };
    return {
        schema: 'fsusblog.api-aeds-observation.v4',
        protocol: 'AEDS',
        aedsVersion: 2,
        operationCount: 2,
        operationKeys: [
            'GET /api/binary/article/{id}.aeds',
            'POST /api/binary/admin/article'
        ],
        observationDigest: 'a'.repeat(64),
        protocolStates: {
            supportedVersions: [2], activeFrameIds: ['ApiError', 'ArticleDetail', 'ArticleWriteRequest', 'MutationId'],
            retiredFrameValues: [40], migrationOnlyFrameIds: ['Reserved177'], aedsOnly: true
        },
        errorAuthority: {
            behaviorId: 'configuration-error-security-policy',
            catalogDigest: 'c'.repeat(64),
            documentPath: 'docs/api/schemas-and-errors.md',
            factIds: ['facts.error-codes.domain.active', 'facts.error-codes.transport-mapping'],
            statusMappingKeys: [400, 401, 403, 404, 406, 415, 500]
        },
        endpointContractAuthority: {
            schema: 'fsusblog.aeds-endpoint-contracts.v2',
            documentPath: 'src/shared/Contracts/Validation/aeds-endpoint-contracts.json',
            contentDigest: 'd'.repeat(64)
        },
        operations: [
            typed({
                method: 'GET',
                path: '/api/binary/article/{id}.aeds',
                operationId: 'binary_get_article_id_aeds',
                protocol: 'AEDS',
                aedsVersion: 2,
                requestFrame: null,
                responseFrame: 'ArticleDetail',
                errorFrame: 'ApiError',
                auth: 'anonymous',
                permission: 'none',
                pow: false,
                rateLimit: 'public_read',
                cache: 'public-read',
                successStatus: 200,
                publicErrorStatuses: [404, 406, 500]
            }),
            typed({
                method: 'POST',
                path: '/api/binary/admin/article',
                operationId: 'binary_post_admin_article',
                protocol: 'AEDS',
                aedsVersion: 2,
                requestFrame: 'ArticleWriteRequest',
                responseFrame: 'MutationId',
                errorFrame: 'ApiError',
                auth: 'admin',
                permission: 'article.write',
                pow: true,
                rateLimit: 'fixed_ip',
                cache: 'no-store',
                successStatus: 200,
                publicErrorStatuses: [400, 401, 403, 406, 415, 500]
            })
        ],
        ...overrides
    };
}

test('registry owns binary-api-aeds-contract via openapi-aeds-fact-extractor', () =>
{
    const registry = loadRegistry();
    const result = validateOwnershipAgainstBehaviorCatalog(registry, loadCatalog(), root);
    assert.equal(result.behaviorOwners.get('binary-api-aeds-contract'), 'openapi-aeds-fact-extractor');
    const extractor = registry.extractors.find((entry) => entry.id === 'openapi-aeds-fact-extractor');
    assert.equal(extractor.kind, 'compiled-assembly');
    assert.equal(extractor.hermeticPolicy, 'exact-build-receipt');
    assert.equal(extractor.requiredBuildArtifact, 'openapi-aeds-observation');
});

test('compiled C# observation self-test executes real loader, merger, and request observer negatives', {
    timeout: 120_000
}, () =>
{
    const result = spawnSync('dotnet', [
        'run',
        '--project',
        'tools/contracts/FsusBlog.OpenApiObservation/FsusBlog.OpenApiObservation.csproj',
        '-c',
        'Release',
        '--',
        '--self-test'
    ], {
        cwd: root,
        encoding: 'utf8',
        env: process.env
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /self-test.*ok/iu);
});

test('pre-3177 normal producer fails closed on the exact compiled JSON binary-route census', {
    timeout: 120_000
}, () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-production-census-'));
    try
    {
        const result = spawnSync('dotnet', [
            'run',
            '--project',
            'tools/contracts/FsusBlog.OpenApiObservation/FsusBlog.OpenApiObservation.csproj',
            '-c',
            'Release',
            '--no-build',
            '--',
            '--output',
            path.join(directory, 'observation.json'),
            '--repository-root',
            root
        ], {
            cwd: root,
            encoding: 'utf8',
            env: process.env
        });
        const expectedRoutes = [
            'GET /api/binary/author/ops/fonts/activations',
            'GET /api/binary/author/ops/fonts/registry',
            'GET /api/binary/author/ops/fonts/registry/{fontId}',
            'GET /api/binary/author/ops/themes/activations',
            'GET /api/binary/author/ops/themes/activations/{scope}',
            'GET /api/binary/author/ops/themes/activations/{scope}/history',
            'GET /api/binary/author/ops/themes/registry',
            'GET /api/binary/author/ops/themes/registry/{themeId}'
        ];
        const diagnostic = `${result.stdout}\n${result.stderr}`;
        assert.equal(result.status, 1, diagnostic);
        assert.match(diagnostic, /production \/api\/binary census found 8 non-AEDS route\(s\):/u);
        const observedRoutes = diagnostic
            .split(/\r?\n/u)
            .map((line) => line.match(/^(GET \/api\/binary\/.+?) requestFrame=/u)?.[1])
            .filter(Boolean);
        assert.deepEqual(observedRoutes, expectedRoutes);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('checked-in OpenAPI projection declares compiled observation authority', () =>
{
    const openapi = readJson(committedOpenApiPath);
    assert.equal(openapi['x-fsus-contract-source']?.observation, 'compiled-endpoint-metadata');
    assert.equal(openapi['x-fsus-contract-source']?.matrix, undefined);
    assert.ok(openapi['x-fsus-observation-digest']);
    const operations = operationsFromOpenApi(openapi);
    assert.ok(operations.length >= 200);
    for (const op of operations)
    {
        assert.equal(op.operation['x-fsus-protocol'], 'AEDS');
        assert.ok(op.operationId, `${op.key} missing operationId`);
    }
});

test('buildOpenApiFromMatrix is retired and cannot re-enter as authority', () =>
{
    assert.throws(() => buildOpenApiFromMatrix(), /retired|compiled endpoint observation/iu);
});

test('1) deleting an endpoint while retaining OpenAPI fails observation validation set equality helpers', () =>
{
    const observation = sampleObservation();
    observation.operations = observation.operations.filter((op) => op.method !== 'POST');
    observation.operationCount = 1;
    observation.operationKeys = ['GET /api/binary/article/{id}.aeds'];
    // Projection retains POST — bidirectional set compare must surface drift.
    const openapi = readJson(committedOpenApiPath);
    const projectionKeys = new Set(
        operationsFromOpenApi(openapi).map((op) => `${op.method} ${op.fullPath}`)
    );
    const observedKeys = new Set(observation.operationKeys);
    const missing = [...projectionKeys].filter((key) => !observedKeys.has(key));
    assert.ok(missing.length > 0);
});

test('2) missing operationId fails extractor', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'));
    try
    {
        const observation = sampleObservation();
        observation.operations[0].operationId = '';
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({
            repositoryRoot: directory,
            buildIdentity: sealed.buildIdentity
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /missing operationId|duplicate/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('3) auth drift is visible in observation map fields', () =>
{
    const observation = sampleObservation();
    observation.operations[1].auth = 'user';
    const facts = observationToFactObservations(observation);
    assert.equal(facts.operations.binary_post_admin_article.auth, 'user');
    assert.notEqual(facts.operations.binary_post_admin_article.auth, 'admin');
});

test('4) rate-limit and cache metadata are required observation fields', () =>
{
    const observation = sampleObservation();
    delete observation.operations[0].rateLimit;
    const errors = validateObservationAgainstProtocol(observation, loadProtocol());
    assert.ok(errors.some((error) => /rateLimit/u.test(error)));
});

test('5) response frame must exist in aeds-protocol.json', () =>
{
    const observation = sampleObservation();
    observation.operations[0].responseFrame = 'NotARealFrame';
    const errors = validateObservationAgainstProtocol(observation, loadProtocol());
    assert.ok(errors.some((error) => /NotARealFrame/u.test(error)));
});

test('6) source regex is not used for qualification in binary-contract-matrix source', () =>
{
    const source = readFileSync(
        path.join(root, 'tests/frontend/checks/runtime/binary-contract-matrix.mjs'),
        'utf8'
    );
    assert.doesNotMatch(source, /extractBackendBinaryRoutesFromSource\s*\(/u);
    assert.match(source, /source-regex non-qualifying|MUST NOT participate/u);
});

test('7) ambient bin/Debug identity is refused by extractor', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'));
    try
    {
        const observation = sampleObservation();
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({
            repositoryRoot: directory,
            buildIdentity: identityFor(observation, sealed.artifactDigest, {
                path: 'src/backend/bin/Debug/net10.0/FsusBlog.Server.dll'
            })
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /bin\/Debug|bin\/Release|ambient/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('8) reverse generation markers from checked-in OpenAPI fail closed', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'));
    try
    {
        const observation = sampleObservation({
            source: 'checked-in-openapi',
            generatedFromCheckedInOpenApi: true
        });
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({
            repositoryRoot: directory,
            buildIdentity: sealed.buildIdentity
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /reverse-generated|checked-in OpenAPI/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('9) duplicate method/path fails extractor', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'));
    try
    {
        const observation = sampleObservation();
        observation.operations.push({ ...observation.operations[0], operationId: 'binary_get_article_id_aeds_dup' });
        observation.operationCount = 3;
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({
            repositoryRoot: directory,
            buildIdentity: sealed.buildIdentity
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /duplicate method\/path/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('extractor accepts sealed observation and emits operation map', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'));
    try
    {
        const observation = sampleObservation();
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({
            repositoryRoot: directory,
            buildIdentity: sealed.buildIdentity
        });
        assert.equal(result.status, 'ok');
        assert.equal(result.observations.operationCount, 2);
        assert.equal(result.observations.operations.binary_post_admin_article.auth, 'admin');
        assert.equal(result.observations.operations.binary_post_admin_article.pow, true);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('stale artifact digest (yesterday Debug swap) fails', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-obs-'));
    try
    {
        const observation = sampleObservation();
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({
            repositoryRoot: directory,
            buildIdentity: { ...sealed.buildIdentity, artifactDigest: '0'.repeat(64) }
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /digest mismatch|stale|unbound|canonical OpenAPI build receipt/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('arbitrary lowercase sha256 identity cannot select an unreceipted artifact', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-arbitrary-identity-'));
    try
    {
        const observation = sampleObservation();
        const sealed = writeObservation(directory, observation);
        const result = extractOpenApi({
            repositoryRoot: directory,
            buildIdentity: identityFor(observation, sealed.artifactDigest)
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /canonical OpenAPI build receipt/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('canonical receipt self-digest and recomputed aggregate source digest fail closed independently', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-receipt-self-digest-'));
    try
    {
        const observation = sampleObservation();
        const sealed = writeObservation(directory, observation);
        const receiptPath = path.join(directory, buildReceiptRelative);
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        receipt.buildIdentity.receiptDigest = 'f'.repeat(64);
        writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        const selfDigest = extractOpenApi({
            repositoryRoot: directory,
            buildIdentity: { ...sealed.buildIdentity, receiptDigest: 'f'.repeat(64) }
        });
        assert.equal(selfDigest.status, 'failed');
        assert.match(selfDigest.failureReasons.join('\n'), /receipt self-digest mismatch/iu);

        writeObservation(directory, observation);
        const forgedIdentity = rewriteReceipt(directory, (value) =>
        {
            value.sourceDigest = 'e'.repeat(64);
        });
        const aggregate = extractOpenApi({ repositoryRoot: directory, buildIdentity: forgedIdentity });
        assert.equal(aggregate.status, 'failed');
        assert.match(aggregate.failureReasons.join('\n'), /aggregate source digest mismatch/iu);

        const sourceSealed = writeObservation(directory, observation);
        const compiledObserver = path.join(
            directory,
            'tools/contracts/FsusBlog.OpenApiObservation/CompiledEndpointContractObserver.cs'
        );
        writeFileSync(compiledObserver, `${readFileSync(compiledObserver, 'utf8')}tampered\n`);
        const sourceDrift = extractOpenApi({ repositoryRoot: directory, buildIdentity: sourceSealed.buildIdentity });
        assert.equal(sourceDrift.status, 'failed');
        assert.match(sourceDrift.failureReasons.join('\n'), /CompiledEndpointContractObserver\.cs/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('receipt cannot self-select contract, error, generator, protocol, or artifact digests', () =>
{
    const cases = [
        ['contractDigest', /contract digest mismatch/iu],
        ['errorCatalogDigest', /error authority digest mismatch/iu],
        ['generatorDigest', /generator digest mismatch/iu],
        ['protocolDigest', /protocol digest mismatch/iu],
        ['artifactDigest', /observation artifact digest mismatch/iu],
        ['openapiDigest', /observed OpenAPI artifact digest mismatch/iu]
    ];
    for (const [field, expected] of cases)
    {
        const directory = mkdtempSync(path.join(os.tmpdir(), `openapi-receipt-${field}-`));
        try
        {
            writeObservation(directory, sampleObservation());
            const identity = rewriteReceipt(directory, (receipt) =>
            {
                receipt[field] = '0'.repeat(64);
            });
            const result = extractOpenApi({ repositoryRoot: directory, buildIdentity: identity });
            assert.equal(result.status, 'failed', field);
            assert.match(result.failureReasons.join('\n'), expected, field);
        }
        finally
        {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});

test('observationDigest is recomputed from sealed content, not trusted from artifact or receipt', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-observation-digest-'));
    try
    {
        const observation = sampleObservation();
        writeObservation(directory, observation);
        const artifactPath = path.join(directory, observationRelative);
        const document = JSON.parse(readFileSync(artifactPath, 'utf8'));
        document.observationDigest = '0'.repeat(64);
        const text = `${JSON.stringify(document, null, 2)}\n`;
        writeFileSync(artifactPath, text);
        const identity = rewriteReceipt(directory, (receipt) =>
        {
            receipt.observationDigest = document.observationDigest;
            receipt.artifactDigest = sha256(Buffer.from(text, 'utf8'));
        });
        const result = extractOpenApi({ repositoryRoot: directory, buildIdentity: identity });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /observationDigest does not match current observation content/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('typed request, response, protocol, and error authority counterexamples fail closed', () =>
{
    const cases = [
        ['missing request', (value) => { delete value.operations[0].request; }, /request contract/iu],
        ['request direction drift', (value) => { value.operations[0].request.direction = 'response'; }, /request direction|request contract/iu],
        ['incorrect request required', (value) => { value.operations[0].request.required = true; }, /request direction|request contract/iu],
        ['incorrect request nullable', (value) => { value.operations[1].request.nullable = true; }, /request contract/iu],
        ['property nullable drift', (value) => { value.operations[1].request.properties.title.nullable = true; }, /request contract/iu],
        ['missing nested definition', (value) => { delete value.operations[1].request.definitions['FsusBlog.Shared.Contracts.ArticleMetadata']; }, /request contract/iu],
        ['nested required drift', (value) => { value.operations[1].request.definitions['FsusBlog.Shared.Contracts.ArticleMetadata'].requiredFields = []; }, /request contract/iu],
        ['missing required field', (value) => { value.operations[1].request.requiredFields = []; }, /request contract/iu],
        ['schema digest stale', (value) => { value.operations[1].request.schemaDigest = '0'.repeat(64); }, /request contract/iu],
        ['invented request field bounds', (value) => { value.operations[1].request.boundsState = 'frame-contract'; }, /request contract/iu],
        ['bounds loss', (value) => { value.operations[1].request.properties.title.bounds.maxLength = null; }, /request contract/iu],
        ['bounds projection drift', (value) => { value.operations[1].request.bounds = {}; }, /request contract/iu],
        ['invented request union', (value) => { value.operations[1].request.unionState = 'one-of'; value.operations[1].request.oneOf = ['Missing']; }, /request contract/iu],
        ['discriminator without union', (value) => { value.operations[1].request.discriminator = '$type'; }, /request contract/iu],
        ['invented request required field', (value) => { value.operations[1].request.requiredFields.push('frame'); }, /request contract/iu],
        ['request direction swap', (value) => { value.operations[1].request.source = 'none'; }, /request contract/iu],
        ['parameter direction swap', (value) => { value.operations[1].request.parameters[0].direction = 'response'; }, /request contract/iu],
        ['parameter source conflict', (value) => { value.operations[1].request.parameters[0].source = 'query'; }, /request contract/iu],
        ['missing query parameter', (value) => { value.operations[1].request.parameters.pop(); }, /request contract/iu],
        ['duplicate request parameter', (value) => { value.operations[1].request.parameters.push({ ...value.operations[1].request.parameters[0] }); }, /request contract/iu],
        ['parameter bounds missing', (value) => { delete value.operations[1].request.parameters[0].bounds; }, /request contract/iu],
        ['parameter bounds invalid', (value) => { value.operations[1].request.parameters[0].bounds.minLength = -1; }, /request contract/iu],
        ['parameter evidence missing', (value) => { value.operations[1].request.parameters[0].evidence = []; }, /request contract/iu],
        ['duplicate source type', (value) => { value.operations[1].request.sourceTypes.push(value.operations[1].request.sourceTypes[0]); }, /request contract/iu],
        ['missing error response', (value) => { value.operations[0].responses.pop(); }, /response contracts/iu],
        ['success status drift', (value) => { value.operations[0].responses[0].status = 201; }, /response contracts/iu],
        ['content type drift', (value) => { value.operations[0].responses[0].contentType = 'application/json'; }, /response contracts/iu],
        ['response schema drift', (value) => { value.operations[0].responses[0].schemaRef = 'aeds://frame/ApiError'; }, /response contracts/iu],
        ['result placement drift', (value) => { value.operations[0].responses[0].resultPlacement = 'json.body'; }, /response contracts/iu],
        ['duplicate response', (value) => { value.operations[0].responses.push({ ...value.operations[0].responses[0] }); }, /response contracts/iu],
        ['extra public status', (value) => { value.operations[0].publicErrorStatuses.push(503); }, /response contracts/iu],
        ['missing status evidence', (value) => { delete value.operations[0].publicErrorStatusEvidence['404']; }, /response contracts/iu],
        ['unmapped status ref', (value) => { value.operations[0].publicErrorRefs[0] = 'configuration-error-security-policy:error-transport-mappings:999'; }, /response contracts/iu],
        ['generic error placeholder', (value) => { value.operations[0].publicErrorRefs[0] = 'configuration-error-security-policy:error-transport-mappings:ApiError'; }, /response contracts/iu],
        ['active migration overlap', (value) => { value.protocolStates.migrationOnlyFrameIds.push('ArticleDetail'); }, /protocol states/iu],
        ['reserved frame in active partition', (value) => { value.protocolStates.activeFrameIds.push('Reserved178'); }, /protocol states/iu],
        ['non-reserved migration frame', (value) => { value.protocolStates.migrationOnlyFrameIds.push('MigrationFrame'); }, /protocol states/iu],
        ['duplicate retired protocol value', (value) => { value.protocolStates.retiredFrameValues.push(40); }, /protocol states/iu],
        ['missing migration partition', (value) => { delete value.protocolStates.migrationOnlyFrameIds; }, /protocol states/iu],
        ['error behavior drift', (value) => { value.operations[0].errorAuthorityBehaviorId = 'binary-api-aeds-contract'; }, /public errors/iu],
        ['invented operation error allow-list', (value) => { value.operations[0].publicErrorRefState = 'operation-allow-list'; }, /public errors/iu],
        ['duplicate public error ref', (value) => { value.operations[0].publicErrorRefs.push(value.operations[0].publicErrorRefs[0]); }, /response contracts/iu],
        ['dangling authority status', (value) => { value.errorAuthority.statusMappingKeys = value.errorAuthority.statusMappingKeys.filter((status) => status !== 406); }, /response contracts/iu],
        ['missing authority status keys', (value) => { delete value.errorAuthority.statusMappingKeys; }, /error authority binding/iu],
        ['duplicate authority fact', (value) => { value.errorAuthority.factIds.push(value.errorAuthority.factIds[0]); }, /error authority binding/iu],
        ['endpoint contract authority drift', (value) => { value.endpointContractAuthority.schema = 'fsusblog.aeds-endpoint-contracts.v1'; }, /endpoint contract authority/iu]
    ];

    for (const [name, mutate, expected] of cases)
    {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-typed-negative-'));
        try
        {
            const observation = sampleObservation();
            mutate(observation);
            const sealed = writeObservation(directory, observation);
            const result = extractOpenApi({
                repositoryRoot: directory,
                buildIdentity: sealed.buildIdentity
            });
            assert.equal(result.status, 'failed', name);
            assert.match(result.failureReasons.join('\n'), expected, name);
        }
        finally
        {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});

test('current error authority catalog digest and sealed artifact bytes are independently bound', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-authority-digest-'));
    try
    {
        const observation = sampleObservation();
        const sealed = writeObservation(directory, observation);
        const identity = sealed.buildIdentity;
        assert.equal(extractOpenApi({ repositoryRoot: directory, buildIdentity: identity }).status, 'ok');

        const catalogPath = path.join(directory, 'config/contracts/behavior-contracts.json');
        writeFileSync(catalogPath, '  { "schema": "fixture-behavior-catalog", "contracts": [] }\n');
        const byteDrift = extractOpenApi({ repositoryRoot: directory, buildIdentity: identity });
        assert.equal(byteDrift.status, 'failed');
        assert.match(byteDrift.failureReasons.join('\n'), /source digest mismatch.*behavior-contracts/iu);

        writeFileSync(catalogPath, '{"schema":"tampered"}\n');
        const authorityDrift = extractOpenApi({ repositoryRoot: directory, buildIdentity: identity });
        assert.equal(authorityDrift.status, 'failed');
        assert.match(authorityDrift.failureReasons.join('\n'), /error authority digest|source digest/iu);

        const endpointPath = path.join(directory, 'src/shared/Contracts/Validation/aeds-endpoint-contracts.json');
        writeFileSync(endpointPath, '{"schema":"tampered"}\n');
        const endpointDrift = extractOpenApi({ repositoryRoot: directory, buildIdentity: identity });
        assert.equal(endpointDrift.status, 'failed');
        assert.match(endpointDrift.failureReasons.join('\n'), /contract digest|source digest/iu);

        writeFileSync(sealed.absolute, `${sealed.text} `);
        const artifactTamper = extractOpenApi({ repositoryRoot: directory, buildIdentity: identity });
        assert.equal(artifactTamper.status, 'failed');
        assert.match(artifactTamper.failureReasons.join('\n'), /artifact digest mismatch/iu);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('second OpenAPI authority search for matrix generator is retired', () =>
{
    const openapiContracts = readFileSync(
        path.join(root, 'tools/contracts/lib/openapi-contracts.mjs'),
        'utf8'
    );
    assert.match(openapiContracts, /buildOpenApiFromMatrix is retired/u);
    const exportScript = readFileSync(path.join(root, 'tools/contracts/export-openapi.sh'), 'utf8');
    assert.doesNotMatch(exportScript, /OpenApiGenerateDocumentsOnBuild=true/u);
    assert.match(exportScript, /check-openapi-sync\.mjs/u);
    assert.doesNotMatch(exportScript, /FSUSBLOG_OPENAPI_ALLOW_SNAPSHOT_FALLBACK/u);
});

test('generated OpenAPI materialization uses the canonical projection serializer', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'openapi-projection-'));
    try
    {
        const observed = path.join(directory, 'observed.json');
        const generated = path.join(directory, 'generated.json');
        writeFileSync(
            observed,
            '{"openapi":"3.1.0","paths":{},"x-fsus-source-identity":"HTTP =\\u003E handler"}\n'
        );

        const expected = openApiProjectionTextFromObservationFile(observed);
        writeGeneratedOpenApiProjection(observed, generated);

        assert.equal(readFileSync(generated, 'utf8'), expected);
        assert.match(expected, /HTTP => handler/u);
        assert.doesNotMatch(expected, /\\\\u003E/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});
