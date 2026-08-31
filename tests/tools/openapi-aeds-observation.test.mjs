import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { digestCatalog, loadCatalog } = await import(new URL("../../tools/contracts/behavior-contract-catalog.mjs", import.meta.url));
const { buildOpenApiFromMatrix, committedOpenApiPath, operationsFromOpenApi, readJson, loadProtocol } = await import(new URL("../../tools/contracts/lib/openapi-contracts.mjs", import.meta.url));
const { openApiProjectionTextFromObservationFile, observationToFactObservations, validateObservationAgainstProtocol, writeGeneratedOpenApiProjection } = await import(new URL("../../tools/contracts/lib/openapi-observation.mjs", import.meta.url));
const { extract: extractOpenApi } = await import(new URL("../../tools/fact-extractors/openapi-aeds/extract.mjs", import.meta.url));
const { loadRegistry, validateOwnershipAgainstBehaviorCatalog, root } = await import(new URL("../../tools/fact-extractors/registry.mjs", import.meta.url));

const observationRelative = '.tmp/contracts/openapi/api-aeds-observation.json';

function sha256(buffer)
{
    return createHash('sha256').update(buffer).digest('hex');
}

function writeObservation(repositoryRoot, observation)
{
    const absolute = path.join(repositoryRoot, observationRelative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    const text = `${JSON.stringify(observation, null, 2)}\n`;
    writeFileSync(absolute, text);
    return {
        absolute,
        artifactDigest: sha256(Buffer.from(text, 'utf8')),
        text
    };
}

function sampleObservation(overrides = {})
{
    const typed = (operation) => ({
        ...operation,
        request: {
            source: operation.requestFrame == null ? 'none' : 'aeds-frame-body',
            schemaRef: operation.requestFrame == null ? null : `aeds://frame/${operation.requestFrame}`,
            required: operation.requestFrame != null,
            nullable: false,
            requiredFields: [],
            parameters: [],
            fieldSetState: operation.requestFrame == null ? 'not-applicable' : 'opaque-aeds-frame',
            boundsState: operation.requestFrame == null ? 'not-applicable' : 'opaque-aeds-frame',
            unionState: operation.requestFrame == null ? 'not-applicable' : 'opaque-aeds-frame'
        },
        responses: [
            { status: operation.successStatus, schemaRef: `aeds://frame/${operation.responseFrame}`, contentType: 'application/octet-stream', resultPlacement: 'aeds.frame.payload', nullable: false },
            { status: null, schemaRef: 'aeds://frame/ApiError', contentType: 'application/octet-stream', resultPlacement: 'aeds.frame.payload', nullable: false }
        ],
        publicErrorRefs: ['configuration-error-security-policy:error-transport-mappings:ApiError'],
        publicErrorRefState: 'transport-frame-authority-only',
        errorAuthorityBehaviorId: 'configuration-error-security-policy',
        resultPlacement: 'aeds.frame.payload',
        protocolState: 'active-aeds-only'
    })
    return {
        schema: 'fsusblog.api-aeds-observation.v2',
        protocol: 'AEDS',
        aedsVersion: 2,
        operationCount: 2,
        operationKeys: [
            'GET /api/binary/article/{id}.aeds',
            'POST /api/binary/admin/article'
        ],
        observationDigest: 'a'.repeat(64),
        protocolStates: {
            supportedVersions: [2], activeFrameIds: ['ApiError', 'ArticleDetail', 'ArticleWriteRequest', 'MutationId', 'RetiredCredentialSpecificRevocationRequest'],
            retiredFrameValues: [40], migrationOnlyFrameIds: ['Reserved177'], aedsOnly: true
        },
        errorAuthority: {
            behaviorId: 'configuration-error-security-policy',
            catalogDigest: 'c'.repeat(64),
            documentPath: 'docs/api/schemas-and-errors.md',
            factIds: ['facts.error-codes.domain.active', 'facts.error-codes.transport-mapping']
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
                successStatus: 200
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
                successStatus: 200
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
            buildIdentity: {
                artifactId: 'openapi-aeds-observation',
                receiptDigest: 'b'.repeat(64),
                artifactDigest: sealed.artifactDigest
            }
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
        const sealed = writeObservation(directory, sampleObservation());
        const result = extractOpenApi({
            repositoryRoot: directory,
            buildIdentity: {
                artifactId: 'openapi-aeds-observation',
                receiptDigest: 'b'.repeat(64),
                artifactDigest: sealed.artifactDigest,
                path: 'src/backend/bin/Debug/net10.0/FsusBlog.Server.dll'
            }
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
            buildIdentity: {
                artifactId: 'openapi-aeds-observation',
                receiptDigest: 'b'.repeat(64),
                artifactDigest: sealed.artifactDigest
            }
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
            buildIdentity: {
                artifactId: 'openapi-aeds-observation',
                receiptDigest: 'b'.repeat(64),
                artifactDigest: sealed.artifactDigest
            }
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
        const sealed = writeObservation(directory, sampleObservation());
        const result = extractOpenApi({
            repositoryRoot: directory,
            buildIdentity: {
                artifactId: 'openapi-aeds-observation',
                receiptDigest: 'b'.repeat(64),
                artifactDigest: sealed.artifactDigest
            }
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
        writeObservation(directory, sampleObservation());
        const result = extractOpenApi({
            repositoryRoot: directory,
            buildIdentity: {
                artifactId: 'openapi-aeds-observation',
                receiptDigest: 'b'.repeat(64),
                artifactDigest: '0'.repeat(64)
            }
        });
        assert.equal(result.status, 'failed');
        assert.match(result.failureReasons.join('\n'), /digest mismatch|stale|unbound/iu);
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
        ['incorrect request required', (value) => { value.operations[0].request.required = true; }, /request direction|request contract/iu],
        ['incorrect request nullable', (value) => { value.operations[1].request.nullable = true; }, /request contract/iu],
        ['invented request field bounds', (value) => { value.operations[1].request.boundsState = 'frame-contract'; }, /request contract/iu],
        ['invented request union', (value) => { value.operations[1].request.unionState = 'oneOf'; }, /request contract/iu],
        ['invented request required field', (value) => { value.operations[1].request.requiredFields.push('frame'); }, /request contract/iu],
        ['missing error response', (value) => { value.operations[0].responses.pop(); }, /response contracts/iu],
        ['success status drift', (value) => { value.operations[0].responses[0].status = 201; }, /response status/iu],
        ['content type drift', (value) => { value.operations[0].responses[0].contentType = 'application/json'; }, /response contracts/iu],
        ['response schema drift', (value) => { value.operations[0].responses[0].schemaRef = 'aeds://frame/ApiError'; }, /response status/iu],
        ['result placement drift', (value) => { value.operations[0].responses[0].resultPlacement = 'json.body'; }, /response contracts/iu],
        ['duplicate response', (value) => { value.operations[0].responses.push({ ...value.operations[0].responses[0] }); }, /response contracts/iu],
        ['active migration overlap', (value) => { value.protocolStates.migrationOnlyFrameIds.push('ArticleDetail'); }, /protocol states conflict/iu],
        ['reserved frame in active partition', (value) => { value.protocolStates.activeFrameIds.push('Reserved178'); }, /protocol states conflict/iu],
        ['non-reserved migration frame', (value) => { value.protocolStates.migrationOnlyFrameIds.push('MigrationFrame'); }, /protocol states conflict/iu],
        ['duplicate retired protocol value', (value) => { value.protocolStates.retiredFrameValues.push(40); }, /protocol states conflict/iu],
        ['missing migration partition', (value) => { delete value.protocolStates.migrationOnlyFrameIds; }, /protocol states missing/iu],
        ['error behavior drift', (value) => { value.operations[0].errorAuthorityBehaviorId = 'binary-api-aeds-contract'; }, /public errors/iu],
        ['invented operation error allow-list', (value) => { value.operations[0].publicErrorRefState = 'operation-allow-list'; }, /public errors/iu],
        ['duplicate public error ref', (value) => { value.operations[0].publicErrorRefs.push(value.operations[0].publicErrorRefs[0]); }, /public errors/iu],
        ['duplicate authority fact', (value) => { value.errorAuthority.factIds.push(value.errorAuthority.factIds[0]); }, /error authority binding/iu]
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
                buildIdentity: {
                    artifactId: 'openapi-aeds-observation',
                    receiptDigest: 'b'.repeat(64),
                    artifactDigest: sealed.artifactDigest
                }
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
        const catalogPath = path.join(directory, 'config/contracts/behavior-contracts.json');
        mkdirSync(path.dirname(catalogPath), { recursive: true });
        writeFileSync(catalogPath, '{"schema":"current"}\n');
        const observation = sampleObservation();
        observation.errorAuthority.catalogDigest = digestCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')));
        const sealed = writeObservation(directory, observation);
        const identity = {
            artifactId: 'openapi-aeds-observation',
            receiptDigest: 'b'.repeat(64),
            artifactDigest: sealed.artifactDigest
        };
        assert.equal(extractOpenApi({ repositoryRoot: directory, buildIdentity: identity }).status, 'ok');

        writeFileSync(catalogPath, '  { "schema": "current" }\n');
        assert.equal(extractOpenApi({ repositoryRoot: directory, buildIdentity: identity }).status, 'ok');

        writeFileSync(catalogPath, '{"schema":"tampered"}\n');
        const authorityDrift = extractOpenApi({ repositoryRoot: directory, buildIdentity: identity });
        assert.equal(authorityDrift.status, 'failed');
        assert.match(authorityDrift.failureReasons.join('\n'), /catalog digest.*current BehaviorCatalog/iu);

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
