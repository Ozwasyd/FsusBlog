#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const materializationReceiptSchema =
    'fsusblog.current-schema-test-materialization-receipt.v1';
export const runtimeReadySchema = 'fsusblog.current-schema-runtime-ready.v1';

const hexDigestPattern = /^[a-f0-9]{64}$/u;
const taggedDigestPattern = /^sha256:[a-f0-9]{64}$/u;
const sourceCommitPattern = /^[a-f0-9]{40}$/u;
const materializationReceiptKeys = [
    'schema',
    'status',
    'commandMode',
    'producerId',
    'testOnly',
    'qualificationEligible',
    'runId',
    'sourceCommit',
    'serviceIdentity',
    'databaseIdentity',
    'canonicalIdentity',
    'observedDatabaseDigest',
    'tableCount',
    'tables',
    'emptyBefore',
    'codeFirstApplied',
    'startupVerifier',
    'assemblySha256',
    'receiptDigest'
];
const serviceIdentityKeys = [
    'catalogDigest',
    'envelopeSha256',
    'producerId',
    'containerId',
    'createdAt',
    'imageReference',
    'imageId',
    'repositoryDigest',
    'serviceVersion',
    'networkMode',
    'networkNamespace',
    'hostPort',
    'resourceLimits',
    'postgresInstance'
];
const databaseIdentityKeys = [
    'provider',
    'host',
    'port',
    'database',
    'username',
    'searchPath'
];
const canonicalIdentityKeys = [
    'modelVersion',
    'extractorVersion',
    'generatorVersion',
    'sourceDigest',
    'contentDigest'
];
const postgresInstanceKeys = [
    'systemIdentifier',
    'database',
    'username',
    'serverVersion',
    'serverVersionNumber'
];
const resourceLimitKeys = ['nanoCpus', 'memory', 'memoryReservation', 'pidsLimit'];

function fail(message)
{
    throw new Error(`current schema materialization receipt: ${message}`);
}

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
        );
    }
    return value;
}

export function canonicalDigest(value)
{
    return `sha256:${sha256(JSON.stringify(canonicalize(value)))}`;
}

function exactKeys(value, expected, label)
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        fail(`${label} must be an object`);
    }
    const actual = Object.keys(value).sort();
    const required = [...expected].sort();
    if (actual.length !== required.length
        || actual.some((key, index) => key !== required[index]))
    {
        fail(`${label} key set mismatch`);
    }
}

function exactJson(left, right, label)
{
    if (JSON.stringify(canonicalize(left)) !== JSON.stringify(canonicalize(right)))
    {
        fail(`${label} mismatch`);
    }
}

function requireString(value, label)
{
    if (typeof value !== 'string' || value.length === 0)
    {
        fail(`${label} must be a non-empty string`);
    }
    return value;
}

function requireInteger(value, label, minimum = 0)
{
    if (!Number.isSafeInteger(value) || value < minimum)
    {
        fail(`${label} must be an integer >= ${minimum}`);
    }
    return value;
}

function requireHexDigest(value, label)
{
    if (!hexDigestPattern.test(value ?? ''))
    {
        fail(`${label} must be a lowercase SHA-256 digest`);
    }
    return value;
}

function requireTaggedDigest(value, label)
{
    if (!taggedDigestPattern.test(value ?? ''))
    {
        fail(`${label} must be a tagged lowercase SHA-256 digest`);
    }
    return value;
}

function resolveRoot(receiptRoot)
{
    if (typeof receiptRoot !== 'string' || !path.isAbsolute(receiptRoot))
    {
        fail('receipt root must be absolute');
    }
    const resolved = path.resolve(receiptRoot);
    let stat;
    try
    {
        stat = fs.lstatSync(resolved);
    }
    catch
    {
        fail('receipt root is missing');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved)
    {
        fail('receipt root must be a canonical non-symlink directory');
    }
    return resolved;
}

function regularFile(file, label)
{
    if (typeof file !== 'string' || !path.isAbsolute(file))
    {
        fail(`${label} path must be absolute`);
    }
    const resolved = path.resolve(file);
    let stat;
    try
    {
        stat = fs.lstatSync(resolved);
    }
    catch
    {
        fail(`${label} is missing`);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved)
    {
        fail(`${label} must be a canonical regular file`);
    }
    return resolved;
}

function readJson(file, label)
{
    const bytes = fs.readFileSync(file);
    try
    {
        return { bytes, value: JSON.parse(bytes.toString('utf8')) };
    }
    catch
    {
        fail(`${label} is not valid JSON`);
    }
}

function materializationDigest(receipt)
{
    const unsigned = { ...receipt, receiptDigest: '' };
    return sha256(JSON.stringify(unsigned, null, 2));
}

export function materializationReceiptPath(receiptRoot, runId)
{
    const root = resolveRoot(receiptRoot);
    requireString(runId, 'runId');
    return path.join(root, `current-schema-test-materialization-${sha256(runId)}.json`);
}

export function runtimeReadyReceiptPath(receiptRoot, runId)
{
    const root = resolveRoot(receiptRoot);
    requireString(runId, 'runId');
    return path.join(root, `current-schema-runtime-ready-${sha256(runId)}.json`);
}

function validateCanonicalIdentity(identity)
{
    exactKeys(identity, canonicalIdentityKeys, 'canonicalIdentity');
    if (identity.modelVersion !== 'fsusblog.current-schema.v2'
        || identity.extractorVersion !== 'fsusblog.current-schema-reflection.v2'
        || identity.generatorVersion !== 'fsusblog.current-schema-projection.v2')
    {
        fail('canonicalIdentity version mismatch');
    }
    requireHexDigest(identity.sourceDigest, 'canonicalIdentity.sourceDigest');
    requireHexDigest(identity.contentDigest, 'canonicalIdentity.contentDigest');
}

function validateDatabaseIdentity(identity)
{
    exactKeys(identity, databaseIdentityKeys, 'databaseIdentity');
    if (identity.provider !== 'postgresql'
        || identity.host !== '127.0.0.1'
        || identity.database !== 'fsusblog'
        || identity.username !== 'fsusblog'
        || identity.searchPath !== 'public')
    {
        fail('databaseIdentity canonical value mismatch');
    }
    requireInteger(identity.port, 'databaseIdentity.port', 1);
    if (identity.port > 65_535)
    {
        fail('databaseIdentity.port exceeds 65535');
    }
}

function validateResourceLimits(limits)
{
    exactKeys(limits, resourceLimitKeys, 'serviceIdentity.resourceLimits');
    for (const key of resourceLimitKeys)
    {
        requireInteger(limits[key], `serviceIdentity.resourceLimits.${key}`);
    }
}

function validatePostgresInstance(instance, databaseIdentity)
{
    exactKeys(instance, postgresInstanceKeys, 'serviceIdentity.postgresInstance');
    if (!/^[1-9][0-9]*$/u.test(instance.systemIdentifier ?? '')
        || instance.database !== databaseIdentity.database
        || instance.username !== databaseIdentity.username
        || !requireString(instance.serverVersion, 'serviceIdentity.postgresInstance.serverVersion')
        || !/^[1-9][0-9]*$/u.test(instance.serverVersionNumber ?? ''))
    {
        fail('serviceIdentity.postgresInstance mismatch');
    }
}

function catalogPostgres(catalog)
{
    if (catalog?.schema !== 'fsusblog.test-execution-service-catalog.v2')
    {
        fail('service catalog schema mismatch');
    }
    const postgres = catalog?.services?.postgres;
    if (postgres?.kind !== 'container')
    {
        fail('service catalog PostgreSQL authority is missing');
    }
    return postgres;
}

function envelopePostgres(envelope, runId, catalog, catalogDigestValue)
{
    exactKeys(envelope, [
        'schema',
        'qualificationEligible',
        'producerId',
        'runId',
        'catalogDigest',
        'requiredServices',
        'planned',
        'actual',
        'admission',
        'correctnessImagePull',
        'hostFallback'
    ], 'service envelope');
    if (envelope.schema !== 'fsusblog.test-execution-envelope-services.v2'
        || envelope.qualificationEligible !== true
        || envelope.runId !== runId
        || envelope.catalogDigest !== catalogDigestValue
        || envelope.admission !== 'planned-actual-exact'
        || envelope.correctnessImagePull !== 'denied'
        || envelope.hostFallback !== 'denied')
    {
        fail('service envelope admission mismatch');
    }
    requireString(envelope.producerId, 'service envelope producerId');
    if (!Array.isArray(envelope.requiredServices)
        || envelope.requiredServices.length === 0
        || envelope.requiredServices.filter((value) => value === 'postgres').length !== 1
        || new Set(envelope.requiredServices).size !== envelope.requiredServices.length
        || [...envelope.requiredServices].sort().some((value, index) =>
            value !== envelope.requiredServices[index])
        || envelope.requiredServices.some((value) =>
            typeof value !== 'string' || catalog.services?.[value] === undefined))
    {
        fail('service envelope requiredServices mismatch');
    }
    exactJson(envelope.planned, envelope.actual, 'service envelope planned/actual');
    const runtimeFields = catalog.containerRuntime?.identityFields;
    if (!Array.isArray(runtimeFields) || new Set(runtimeFields).size !== runtimeFields.length)
    {
        fail('service catalog runtime identity fields are invalid');
    }
    exactKeys(envelope.actual?.runtime, runtimeFields, 'service envelope runtime identity');
    for (const field of runtimeFields)
    {
        requireString(envelope.actual.runtime[field], `service envelope runtime.${field}`);
    }
    if (!Array.isArray(envelope.actual?.services))
    {
        fail('service envelope actual services missing');
    }
    const observedServiceIds = envelope.actual.services.map((service) => service?.id);
    if (new Set(observedServiceIds).size !== observedServiceIds.length
        || [...observedServiceIds].sort().some((id, index) =>
            id !== [...envelope.requiredServices].sort()[index]))
    {
        fail('service envelope observed service roster mismatch');
    }
    const matches = envelope.actual.services.filter((service) => service?.id === 'postgres');
    if (matches.length !== 1)
    {
        fail('service envelope PostgreSQL identity is not unique');
    }
    return matches[0];
}

function expectedServiceIdentity({ catalog, envelope, envelopeBytes, databaseIdentity, runId })
{
    const catalogDigestValue = canonicalDigest(catalog);
    const catalogService = catalogPostgres(catalog);
    const service = envelopePostgres(envelope, runId, catalog, catalogDigestValue);
    exactKeys(service, [
        'id',
        'kind',
        'containerId',
        'createdAt',
        'imageReference',
        'imageId',
        'repositoryDigest',
        'serviceVersion',
        'networkMode',
        'networkNamespace',
        'ports',
        'resourceLimits',
        'databaseIdentity'
    ], 'service envelope PostgreSQL identity');
    const ports = service.ports?.filter((entry) => entry?.containerPort === '5432/tcp') ?? [];
    for (const port of service.ports ?? [])
    {
        exactKeys(port, ['containerPort', 'hostIp', 'hostPort'], 'service envelope port');
    }
    if (ports.length !== 1
        || ports[0].hostIp !== databaseIdentity.host
        || Number(ports[0].hostPort) !== databaseIdentity.port)
    {
        fail('service envelope PostgreSQL port mismatch');
    }
    if (service.kind !== 'container'
        || service.imageReference !== catalogService.imageReference
        || service.repositoryDigest !== catalogService.imageReference
        || !service.serviceVersion.includes(catalogService.version)
        || catalogService.databaseIdentityAuthority !== 'postgres-control-system-exact'
        || service.databaseIdentity?.database !== catalogService.database
        || service.databaseIdentity?.username !== catalogService.username
        || !String(service.databaseIdentity?.serverVersion ?? '').startsWith(catalogService.version)
        || service.databaseIdentity?.serverVersionNumber !== catalogService.serverVersionNumber)
    {
        fail('service envelope PostgreSQL catalog identity mismatch');
    }
    return {
        catalogDigest: catalogDigestValue,
        envelopeSha256: sha256(envelopeBytes),
        producerId: envelope.producerId,
        containerId: service.containerId,
        createdAt: service.createdAt,
        imageReference: service.imageReference,
        imageId: service.imageId,
        repositoryDigest: service.repositoryDigest,
        serviceVersion: service.serviceVersion,
        networkMode: service.networkMode,
        networkNamespace: service.networkNamespace,
        hostPort: databaseIdentity.port,
        resourceLimits: service.resourceLimits,
        postgresInstance: service.databaseIdentity
    };
}

function validateServiceIdentity(identity, expected, databaseIdentity)
{
    exactKeys(identity, serviceIdentityKeys, 'serviceIdentity');
    validateResourceLimits(identity.resourceLimits);
    validatePostgresInstance(identity.postgresInstance, databaseIdentity);
    requireTaggedDigest(identity.catalogDigest, 'serviceIdentity.catalogDigest');
    requireHexDigest(identity.envelopeSha256, 'serviceIdentity.envelopeSha256');
    requireHexDigest(identity.containerId, 'serviceIdentity.containerId');
    requireString(identity.createdAt, 'serviceIdentity.createdAt');
    requireString(identity.producerId, 'serviceIdentity.producerId');
    requireString(identity.serviceVersion, 'serviceIdentity.serviceVersion');
    requireString(identity.networkMode, 'serviceIdentity.networkMode');
    requireString(identity.networkNamespace, 'serviceIdentity.networkNamespace');
    if (!taggedDigestPattern.test(identity.imageId ?? ''))
    {
        fail('serviceIdentity.imageId is invalid');
    }
    exactJson(identity, expected, 'serviceIdentity exact envelope binding');
}

function validateReceiptShape(receipt, { runId, sourceCommit, assemblySha256 })
{
    exactKeys(receipt, materializationReceiptKeys, 'materialization receipt');
    if (receipt.schema !== materializationReceiptSchema
        || receipt.status !== 'verified'
        || receipt.commandMode !== 'materialize-current-schema-test'
        || receipt.producerId !== 'current-schema-test-materializer'
        || receipt.testOnly !== true
        || receipt.qualificationEligible !== true
        || receipt.runId !== runId
        || receipt.sourceCommit !== sourceCommit
        || receipt.emptyBefore !== true
        || receipt.codeFirstApplied !== true
        || receipt.startupVerifier !== 'green')
    {
        fail('materialization receipt terminal identity mismatch');
    }
    if (!sourceCommitPattern.test(receipt.sourceCommit))
    {
        fail('sourceCommit is invalid');
    }
    if (receipt.assemblySha256 !== assemblySha256)
    {
        fail('assembly SHA mismatch');
    }
    requireHexDigest(receipt.observedDatabaseDigest, 'observedDatabaseDigest');
    requireHexDigest(receipt.receiptDigest, 'receiptDigest');
    if (!Array.isArray(receipt.tables)
        || receipt.tables.some((table) => typeof table !== 'string' || table.length === 0)
        || receipt.tables.length !== receipt.tableCount
        || new Set(receipt.tables).size !== receipt.tables.length
        || [...receipt.tables].sort().some((table, index) => table !== receipt.tables[index]))
    {
        fail('table inventory is not exact, unique, and sorted');
    }
    requireInteger(receipt.tableCount, 'tableCount', 1);
    validateCanonicalIdentity(receipt.canonicalIdentity);
    validateDatabaseIdentity(receipt.databaseIdentity);
    if (receipt.receiptDigest !== materializationDigest(receipt))
    {
        fail('receiptDigest mismatch');
    }
}

function writeTerminal(file, value)
{
    if (fs.existsSync(file))
    {
        fail('runtime-ready terminal receipt already exists');
    }
    const temporary = `${file}.next-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
    });
    try
    {
        fs.linkSync(temporary, file);
    }
    catch (error)
    {
        if (error?.code === 'EEXIST')
        {
            fail('runtime-ready terminal receipt already exists');
        }
        throw error;
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }
}

export function verifyCurrentSchemaMaterializationReceipt({
    receiptRoot,
    runId,
    sourceCommit,
    assembly,
    serviceCatalog,
    serviceEnvelope,
    publish = true
})
{
    const root = resolveRoot(receiptRoot);
    requireString(runId, 'runId');
    if (!sourceCommitPattern.test(sourceCommit ?? ''))
    {
        fail('expected sourceCommit is invalid');
    }
    const receiptFile = materializationReceiptPath(root, runId);
    const preparedFile = `${receiptFile}.prepared`;
    if (fs.existsSync(preparedFile))
    {
        fail('prepared sibling exists');
    }
    regularFile(receiptFile, 'materialization receipt');
    const assemblyFile = regularFile(assembly, 'assembly');
    const catalogFile = regularFile(serviceCatalog, 'service catalog');
    const envelopeFile = regularFile(serviceEnvelope, 'service envelope');
    const receiptDocument = readJson(receiptFile, 'materialization receipt');
    const catalogDocument = readJson(catalogFile, 'service catalog');
    const envelopeDocument = readJson(envelopeFile, 'service envelope');
    const assemblySha256 = sha256(fs.readFileSync(assemblyFile));
    validateReceiptShape(receiptDocument.value, { runId, sourceCommit, assemblySha256 });
    const expectedService = expectedServiceIdentity({
        catalog: catalogDocument.value,
        envelope: envelopeDocument.value,
        envelopeBytes: envelopeDocument.bytes,
        databaseIdentity: receiptDocument.value.databaseIdentity,
        runId
    });
    validateServiceIdentity(
        receiptDocument.value.serviceIdentity,
        expectedService,
        receiptDocument.value.databaseIdentity
    );

    const outputFile = runtimeReadyReceiptPath(root, runId);
    const terminal = {
        schema: runtimeReadySchema,
        status: 'verified',
        qualificationEligible: true,
        runId,
        sourceCommit,
        materializationReceipt: {
            path: receiptFile,
            fileSha256: `sha256:${sha256(receiptDocument.bytes)}`,
            receiptDigest: receiptDocument.value.receiptDigest
        },
        assembly: {
            path: assemblyFile,
            sha256: assemblySha256
        },
        serviceIdentity: receiptDocument.value.serviceIdentity,
        databaseIdentity: receiptDocument.value.databaseIdentity,
        canonicalIdentity: receiptDocument.value.canonicalIdentity,
        observedDatabaseDigest: receiptDocument.value.observedDatabaseDigest,
        tableCount: receiptDocument.value.tableCount,
        contentDigest: null
    };
    terminal.contentDigest = canonicalDigest(terminal);
    if (publish)
    {
        writeTerminal(outputFile, terminal);
    }
    return { outputFile, terminal };
}

function parseOptions(argv)
{
    const allowed = new Set([
        '--receipt-root',
        '--run-id',
        '--source-commit',
        '--assembly',
        '--service-catalog',
        '--service-envelope'
    ]);
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2)
    {
        const option = argv[index];
        const value = argv[index + 1];
        if (!allowed.has(option) || value === undefined || values.has(option))
        {
            fail(`invalid or duplicate option ${option ?? '<missing>'}`);
        }
        values.set(option, value);
    }
    for (const option of allowed)
    {
        if (!values.has(option))
        {
            fail(`missing option ${option}`);
        }
    }
    return Object.fromEntries([...values].map(([key, value]) => [
        key.slice(2).replace(/-([a-z])/gu, (_match, character) => character.toUpperCase()),
        value
    ]));
}

function main(argv)
{
    const result = verifyCurrentSchemaMaterializationReceipt(parseOptions(argv));
    console.log(`[current-schema-runtime-ready] verified ${result.outputFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main(process.argv.slice(2));
    }
    catch (error)
    {
        console.error(`[current-schema-runtime-ready] ${error.message}`);
        process.exitCode = 1;
    }
}
