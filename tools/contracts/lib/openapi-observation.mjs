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
export const errorMapperRelative = 'src/backend/Infrastructure/Results/ApiErrorSemanticMapper.cs';
export const observationBuildSourcePaths = Object.freeze([
    contractsRelative,
    protocolRelative,
    errorMapperRelative,
    'config/contracts/behavior-contracts.json',
    'src/backend/Modules/Endpoints/AuthoringEndpoints.ModerationRoutes.cs',
    'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs',
    'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AnonymousCredential.cs',
    'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs',
    observationToolProject,
    'tools/contracts/FsusBlog.OpenApiObservation/CompiledEndpointContractObserver.cs',
    'tools/contracts/FsusBlog.OpenApiObservation/Models.cs',
    'tools/contracts/FsusBlog.OpenApiObservation/OpenApiObservationSelfTest.cs',
    'tools/contracts/FsusBlog.OpenApiObservation/OpenApiProjectionWriter.cs',
    'tools/contracts/FsusBlog.OpenApiObservation/Program.cs',
    'tools/contracts/FsusBlog.OpenApiObservation/RequestContractObserver.cs',
    'tools/contracts/lib/openapi-observation.mjs',
    'tools/fact-extractors/openapi-aeds/extract.mjs',
    'tools/fact-extractors/runner.mjs',
    'tools/fact-extractors/lib/canonicalize.mjs'
]);

const fail = (message) =>
{
    throw new Error(`[openapi-observation] ${message}`);
};

const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, expected) => isObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const isSortedUnique = (values) => Array.isArray(values)
    && JSON.stringify(values) === JSON.stringify([...new Set(values)].sort((left, right) =>
        typeof left === 'number' ? left - right : String(left).localeCompare(String(right))));
const boundKeys = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];
const propertyKeys = ['name', 'type', 'required', 'nullable', 'format', 'schemaRef', 'itemType', 'itemSchemaRef', 'item', 'enumValues', 'bounds'];
const valueKeys = ['type', 'nullable', 'format', 'schemaRef', 'item', 'enumValues', 'bounds'];
const definitionKeys = ['typeIdentity', 'requiredFields', 'properties', 'oneOf', 'discriminator', 'bounds'];
const requestKeys = ['direction', 'source', 'schemaRef', 'encoding', 'required', 'nullable', 'requiredFields', 'parameters', 'properties', 'definitions', 'oneOf', 'discriminator', 'bounds', 'fieldSetState', 'boundsState', 'unionState', 'schemaDigest', 'sourceTypes', 'readerIdentities'];
const parameterKeys = ['name', 'direction', 'source', 'schemaRef', 'required', 'nullable', 'bounds', 'evidence'];

function validateBound(value)
{
    return exactKeys(value, boundKeys)
        && ['minimum', 'maximum'].every((key) => value[key] == null
            || (typeof value[key] === 'string' && value[key].length > 0))
        && boundKeys.slice(2).every((key) => value[key] == null || (Number.isInteger(value[key]) && value[key] >= 0));
}

const hasBound = (value) => boundKeys.some((key) => value[key] != null);
const boundedProperties = (properties) => Object.fromEntries(Object.entries(properties)
    .filter(([, property]) => hasBound(property.bounds))
    .map(([name, property]) => [name, property.bounds]));

function validateValue(value, definitions)
{
    if (!exactKeys(value, valueKeys)
        || !['string', 'boolean', 'binary', 'enum', 'number', 'integer', 'array', 'object'].includes(value.type)
        || typeof value.nullable !== 'boolean'
        || (value.format != null && (typeof value.format !== 'string' || value.format.length === 0))
        || !Array.isArray(value.enumValues) || !isSortedUnique(value.enumValues)
        || (value.type === 'enum') !== (value.enumValues.length > 0)
        || !validateBound(value.bounds))
    {
        return false;
    }
    if (value.schemaRef !== null && (value.type !== 'object' || typeof value.schemaRef !== 'string'
        || !value.schemaRef.startsWith('clr://')
        || !Object.hasOwn(definitions, value.schemaRef.slice('clr://'.length))))
    {
        return false;
    }
    const container = value.type === 'array' || (value.type === 'object' && value.format === 'string-keyed-map');
    return container ? validateValue(value.item, definitions) : value.item === null;
}

function validateProperties(properties, definitions)
{
    if (!isObject(properties))
    {
        return false;
    }
    for (const [name, property] of Object.entries(properties))
    {
        if (!exactKeys(property, propertyKeys) || property.name !== name
            || !['string', 'boolean', 'binary', 'enum', 'number', 'integer', 'array', 'object'].includes(property.type)
            || typeof property.required !== 'boolean' || typeof property.nullable !== 'boolean'
            || (property.format != null && (typeof property.format !== 'string' || property.format.length === 0))
            || (property.schemaRef != null && property.type !== 'object')
            || (property.itemType != null && !['array', 'object'].includes(property.type))
            || (property.itemSchemaRef != null && !['array', 'object'].includes(property.type))
            || (property.type === 'array' && property.itemType == null)
            || (property.itemType === null
                ? property.item !== null || property.itemSchemaRef !== null
                : !validateValue(property.item, definitions)
                    || property.itemType !== property.item.type || property.itemSchemaRef !== property.item.schemaRef)
            || ((property.type === 'array' || property.format === 'string-keyed-map') !== (property.item !== null))
            || !Array.isArray(property.enumValues)
            || (property.type === 'enum') !== (property.enumValues.length > 0)
            || !isSortedUnique(property.enumValues) || !validateBound(property.bounds))
        {
            return false;
        }
        for (const ref of [property.schemaRef, property.itemSchemaRef].filter((value) => value != null))
        {
            if (!String(ref).startsWith('clr://') || !Object.hasOwn(definitions, String(ref).slice('clr://'.length)))
            {
                return false;
            }
        }
    }
    return true;
}

function validateRequestContract(op)
{
    const request = op.request;
    if (!exactKeys(request, requestKeys) || request.direction !== 'request' || !Array.isArray(request.requiredFields)
        || !Array.isArray(request.parameters) || !isObject(request.properties)
        || !isObject(request.definitions) || !Array.isArray(request.oneOf)
        || !isObject(request.bounds) || !Array.isArray(request.sourceTypes)
        || !Array.isArray(request.readerIdentities) || request.nullable !== false)
    {
        return false;
    }
    if (!request.parameters.every((parameter) => exactKeys(parameter, parameterKeys)
        && typeof parameter.name === 'string' && parameter.name.length > 0
        && parameter.direction === 'request' && ['path', 'query', 'header'].includes(parameter.source)
        && typeof parameter.schemaRef === 'string' && parameter.schemaRef.startsWith(`${parameter.source}://`)
        && typeof parameter.required === 'boolean' && typeof parameter.nullable === 'boolean'
        && !(parameter.required && parameter.nullable)
        && validateBound(parameter.bounds)
        && Array.isArray(parameter.evidence) && parameter.evidence.length > 0
        && isSortedUnique(parameter.evidence))
        || new Set(request.parameters.map((parameter) => `${parameter.source}\0${parameter.name}`)).size !== request.parameters.length
        || !isSortedUnique(request.parameters.map((parameter) => `${parameter.source}\0${parameter.name}`)))
    {
        return false;
    }

    if (op.requestFrame == null)
    {
        return request.source === 'none' && request.schemaRef === null && request.encoding === 'none'
            && request.required === false && request.requiredFields.length === 0
            && Object.keys(request.properties).length === 0 && Object.keys(request.definitions).length === 0
            && request.oneOf.length === 0 && request.discriminator === null && Object.keys(request.bounds).length === 0
            && request.fieldSetState === 'not-applicable' && request.boundsState === 'not-applicable'
            && request.unionState === 'not-applicable' && request.schemaDigest === null
            && request.sourceTypes.length === 0 && request.readerIdentities.length === 0;
    }

    if (request.source !== 'aeds-frame-body'
        || request.schemaRef !== `aeds://request-schema/${op.operationId}`
        || !['binary-layout', 'binary-package', 'utf8-json'].includes(request.encoding)
        || request.required !== true || Object.keys(request.properties).length === 0
        || request.fieldSetState !== 'closed' || request.boundsState !== 'closed'
        || !['none', 'one-of'].includes(request.unionState)
        || !/^[a-f0-9]{64}$/u.test(String(request.schemaDigest ?? ''))
        || request.sourceTypes.length === 0 || request.readerIdentities.length === 0
        || !isSortedUnique(request.requiredFields) || !isSortedUnique(request.oneOf)
        || !isSortedUnique(request.sourceTypes) || !isSortedUnique(request.readerIdentities)
        || !request.sourceTypes.every((identity) => typeof identity === 'string' && identity.length > 0)
        || !request.readerIdentities.every((identity) => typeof identity === 'string' && identity.length > 0))
    {
        return false;
    }
    const requiredFromProperties = Object.values(request.properties)
        .filter((property) => property.required === true).map((property) => property.name).sort();
    if (JSON.stringify(requiredFromProperties) !== JSON.stringify(request.requiredFields)
        || !validateProperties(request.properties, request.definitions)
        || JSON.stringify(boundedProperties(request.properties)) !== JSON.stringify(request.bounds))
    {
        return false;
    }
    for (const [identity, definition] of Object.entries(request.definitions))
    {
        if (!exactKeys(definition, definitionKeys) || definition.typeIdentity !== identity
            || !isSortedUnique(definition.requiredFields) || !isSortedUnique(definition.oneOf)
            || !isObject(definition.properties) || !isObject(definition.bounds)
            || !validateProperties(definition.properties, request.definitions)
            || JSON.stringify(boundedProperties(definition.properties)) !== JSON.stringify(definition.bounds)
            || !definition.oneOf.every((derived) => Object.hasOwn(request.definitions, derived))
            || (definition.oneOf.length === 0
                ? definition.discriminator !== null
                : typeof definition.discriminator !== 'string' || definition.discriminator.length === 0)
            || JSON.stringify(Object.values(definition.properties).filter((property) => property.required)
                .map((property) => property.name).sort()) !== JSON.stringify(definition.requiredFields))
        {
            return false;
        }
    }
    const digest = sha256Text(JSON.stringify({
        direction: request.direction,
        schemaRef: request.schemaRef,
        requestFrame: op.requestFrame,
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
    }));
    return digest === request.schemaDigest
        && request.oneOf.every((identity) => Object.hasOwn(request.definitions, identity))
        && (request.oneOf.length === 0
            ? request.discriminator === null && request.unionState === 'none'
            : typeof request.discriminator === 'string' && request.discriminator.length > 0
                && request.unionState === 'one-of');
}

function validateResponseContracts(op)
{
    if (!isSortedUnique(op.publicErrorStatuses) || op.publicErrorStatuses.length === 0
        || !isObject(op.publicErrorStatusEvidence))
    {
        return false;
    }
    const expectedRefs = op.publicErrorStatuses.map((status) =>
        `configuration-error-security-policy:error-transport-mappings:${status}`);
    if (JSON.stringify(op.publicErrorRefs) !== JSON.stringify(expectedRefs)
        || op.publicErrorRefState !== 'operation-status-authority-bound'
        || JSON.stringify(Object.keys(op.publicErrorStatusEvidence).sort((a, b) => Number(a) - Number(b)))
            !== JSON.stringify(op.publicErrorStatuses.map(String)))
    {
        return false;
    }
    if (!op.publicErrorStatuses.every((status) => status >= 400 && status <= 599
        && Array.isArray(op.publicErrorStatusEvidence[String(status)])
        && op.publicErrorStatusEvidence[String(status)].length > 0
        && isSortedUnique(op.publicErrorStatusEvidence[String(status)])
        && op.publicErrorStatusEvidence[String(status)]
            .every((source) => typeof source === 'string' && source.length > 0)))
    {
        return false;
    }
    if (!Array.isArray(op.responses) || op.responses.length !== op.publicErrorStatuses.length + 1)
    {
        return false;
    }
    const success = op.responses.filter((response) => response.kind === 'success');
    const errors = op.responses.filter((response) => response.kind === 'error');
    return success.length === 1 && success[0].status === Number(op.successStatus)
        && success[0].schemaRef === `aeds://frame/${op.responseFrame}` && success[0].publicErrorRef === null
        && JSON.stringify(errors.map((response) => response.status)) === JSON.stringify(op.publicErrorStatuses)
        && op.responses.every((response) => exactKeys(response, ['status', 'kind', 'schemaRef', 'contentType', 'resultPlacement', 'nullable', 'publicErrorRef'])
            && response.status != null && response.contentType === 'application/octet-stream'
            && response.resultPlacement === 'aeds.frame.payload' && response.nullable === false)
        && errors.every((response) => response.schemaRef === `aeds://frame/${op.errorFrame}`
            && response.publicErrorRef === `configuration-error-security-policy:error-transport-mappings:${response.status}`);
}

export function protocolStateCatalog(protocol)
{
    const version = Number(protocol?.header?.version);
    const frameTypes = protocol?.frameTypes;
    const retiredEntries = protocol?.retiredFrameValues;
    if (!Number.isInteger(version) || !Array.isArray(frameTypes) || frameTypes.length === 0
        || !Array.isArray(retiredEntries))
    {
        fail('canonical AEDS protocol is missing version/frame/retired partitions');
    }
    const frameNames = frameTypes.map((frame) => String(frame?.name ?? ''));
    const frameValues = frameTypes.map((frame) => frame?.value);
    const retiredFrameValues = retiredEntries.map((entry) => entry?.value);
    if (frameNames.some((name) => name.length === 0)
        || frameValues.some((value) => !Number.isInteger(value))
        || retiredFrameValues.some((value) => !Number.isInteger(value))
        || new Set(frameNames).size !== frameNames.length
        || new Set(frameValues).size !== frameValues.length
        || new Set(retiredFrameValues).size !== retiredFrameValues.length
        || frameValues.some((value) => retiredFrameValues.includes(value)))
    {
        fail('canonical AEDS protocol frame partitions are duplicated or overlapping');
    }
    const named = frameNames.filter((name) => name !== 'Unknown').sort();
    const activeFrameIds = named.filter((name) => !name.startsWith('Reserved'));
    const migrationOnlyFrameIds = named.filter((name) => name.startsWith('Reserved'));
    if (activeFrameIds.length === 0)
    {
        fail('canonical AEDS protocol active frame partition is empty');
    }
    return {
        supportedVersions: [version],
        activeFrameIds,
        retiredFrameValues: [...retiredFrameValues].sort((left, right) => left - right),
        migrationOnlyFrameIds,
        aedsOnly: true
    };
}

export function observationContentDigest(observation)
{
    const dotNetJson = (value) => JSON.stringify(value)
        .replace(/\\"/gu, '\\u0022')
        .replace(/[+<>&'\u007f-\uffff]/gu, (character) =>
            `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    const pascalRecord = (value) => !isObject(value) ? value : Object.fromEntries(Object.entries(value).map(([key, item]) => [
        `${key[0].toUpperCase()}${key.slice(1)}`,
        item
    ]));
    const bounds = (value) => !isObject(value) ? {} : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pascalRecord(item)]));
    const parameter = (value) => ({
        ...pascalRecord(value),
        Bounds: pascalRecord(value?.bounds)
    });
    const itemContract = (value) => value == null ? value : ({
        ...pascalRecord(value),
        Item: itemContract(value.item),
        Bounds: pascalRecord(value.bounds)
    });
    const properties = (value) => !isObject(value) ? {} : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, {
        ...pascalRecord(item),
        Item: itemContract(item.item),
        Bounds: pascalRecord(item.bounds)
    }]));
    const definitions = (value) => !isObject(value) ? {} : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, {
        ...pascalRecord(item),
        Properties: properties(item.properties),
        Bounds: bounds(item.bounds)
    }]));
    const operations = (observation.operations ?? []).map((operation) => ({
        ...pascalRecord(operation),
        Request: {
            ...pascalRecord(operation.request),
            Parameters: operation.request?.parameters?.map(parameter),
            Properties: properties(operation.request?.properties),
            Definitions: definitions(operation.request?.definitions),
            Bounds: bounds(operation.request?.bounds)
        },
        Responses: operation.responses?.map(pascalRecord),
        PublicErrorStatusEvidence: operation.publicErrorStatusEvidence
    }));
    return sha256Text(dotNetJson({
        Schema: observation.schema,
        Protocol: observation.protocol,
        AedsVersion: observation.aedsVersion,
        OperationCount: observation.operationCount,
        OperationKeys: observation.operationKeys,
        Operations: operations,
        ProtocolStates: pascalRecord(observation.protocolStates),
        ErrorAuthority: pascalRecord(observation.errorAuthority),
        EndpointContractAuthority: pascalRecord(observation.endpointContractAuthority)
    }));
}

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

export function endpointContractContentDigest(document)
{
    const { contentDigest: ignoredDigest, ...content } = document;
    void ignoredDigest;
    return sha256Text(JSON.stringify(content));
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
    const sourceDigests = Object.fromEntries(observationBuildSourcePaths.map((relative) => [
        relative,
        sha256File(path.join(repositoryRoot, relative))
    ]));
    const sourceDigest = digestValue(sourceDigests);
    const contractDigest = observation.endpointContractAuthority?.contentDigest;
    const errorCatalogDigest = observation.errorAuthority?.catalogDigest;
    const generatorDigest = sourceDigests['tools/contracts/lib/openapi-observation.mjs'];
    const protocolDigest = sourceDigests[protocolRelative];
    const receiptBody = {
        schema: 'fsusblog.openapi-observation-build-receipt.v1',
        artifactId: observationArtifactId,
        observationPath: paths.relativeObservationPath,
        openapiPath: paths.relativeObservedOpenApiPath,
        observationDigest: observation.observationDigest,
        artifactDigest,
        openapiDigest,
        sourceDigests,
        sourceDigest,
        contractDigest,
        errorCatalogDigest,
        generatorDigest,
        protocolDigest,
        configuration
    };
    const receiptDigest = digestValue(receiptBody);
    const buildIdentity = {
        artifactId: observationArtifactId,
        receiptDigest,
        artifactDigest,
        sourceDigest,
        contractDigest,
        errorCatalogDigest,
        generatorDigest,
        protocolDigest
    };
    const suppliedBuildIdentity = {
        artifactId: buildIdentity.artifactId,
        receiptDigest: buildIdentity.receiptDigest,
        artifactDigest: buildIdentity.artifactDigest
    };
    const receiptPath = path.join(paths.directory, 'build-receipt.json');
    writeFileSync(receiptPath, `${JSON.stringify({ ...receiptBody, buildIdentity }, null, 2)}\n`);

    return {
        observation,
        observationPath: paths.observationPath,
        observedOpenApiPath: paths.observedOpenApiPath,
        observedOpenApiText: readFileSync(paths.observedOpenApiPath, 'utf8'),
        buildIdentity: suppliedBuildIdentity,
        receiptPath,
        receiptBody
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
    return `${JSON.stringify(canonicalizeOpenApiDocument(document), null, 4)}\n`;
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

    if (!observation || observation.schema !== 'fsusblog.api-aeds-observation.v5')
    {
        errors.push('observation schema must be fsusblog.api-aeds-observation.v5');
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
    let expectedStates;
    try
    {
        expectedStates = protocolStateCatalog(protocol);
    }
    catch (error)
    {
        errors.push(error instanceof Error ? error.message : String(error));
    }
    const states = observation.protocolStates;
    if (expectedStates == null || JSON.stringify(states) !== JSON.stringify(expectedStates))
    {
        errors.push('closed active/retired/migration/AEDS-only protocol states drifted from canonical aeds-protocol.json');
    }
    if (observation.observationDigest !== observationContentDigest(observation))
    {
        errors.push('observationDigest does not match current observation content');
    }
    const errorAuthority = observation.errorAuthority;
    if (!exactKeys(errorAuthority, ['behaviorId', 'catalogDigest', 'documentPath', 'factIds'])
        || !isSortedUnique(errorAuthority.factIds)
        || errorAuthority.factIds.length === 0)
    {
        errors.push('current error authority binding is missing or invalid');
    }
    const endpointAuthority = observation.endpointContractAuthority;
    if (!exactKeys(endpointAuthority, ['schema', 'documentPath', 'contentDigest'])
        || endpointAuthority.schema !== 'fsusblog.aeds-endpoint-contracts.v2'
        || endpointAuthority.documentPath !== contractsRelative
        || !/^[a-f0-9]{64}$/u.test(String(endpointAuthority.contentDigest ?? '')))
    {
        errors.push('canonical endpoint contract authority binding missing');
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
        if (!['include', 'omit'].includes(op.credentialPolicy)
            || (op.auth !== 'anonymous' && op.credentialPolicy !== 'include'))
        {
            errors.push(`${key} invalid credentialPolicy ${op.credentialPolicy}`);
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
        if (!validateRequestContract(op))
        {
            errors.push(`${key} typed request contract missing`);
        }
        if (!validateResponseContracts(op))
        {
            errors.push(`${key} typed response/result placement missing`);
        }
        if (op.errorAuthorityBehaviorId !== 'configuration-error-security-policy'
            || op.publicErrorRefState !== 'operation-status-authority-bound')
        {
            errors.push(`${key} public error authority reference invalid`);
        }
    }
    return errors;
}

export async function runOpenApiFactExtractor({
    repositoryRoot = root,
    buildIdentity,
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
            credentialPolicy: op.credentialPolicy,
            permission: op.permission,
            pow: op.pow,
            rateLimit: op.rateLimit,
            cache: op.cache,
            successStatus: op.successStatus,
            request: op.request,
            responses: Object.fromEntries(op.responses.map((response) => [
                response.kind === 'success' ? `success:${response.status}` : `error:${response.status}`,
                response
            ])),
            publicErrorStatuses: op.publicErrorStatuses,
            publicErrorRefs: op.publicErrorRefs,
            publicErrorStatusEvidence: op.publicErrorStatusEvidence,
            publicErrorRefState: op.publicErrorRefState,
            errorAuthorityBehaviorId: op.errorAuthorityBehaviorId,
            resultPlacement: op.resultPlacement,
            protocolState: op.protocolState
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
