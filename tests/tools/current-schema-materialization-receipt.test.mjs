import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    canonicalDigest,
    materializationReceiptPath,
    runtimeReadyReceiptPath,
    verifyCurrentSchemaMaterializationReceipt
} from '../../tools/db/verify-current-schema-test-materialization-receipt.mjs';

const runId = 'issue-3105-receipt-fixture';
const sourceCommit = 'a'.repeat(40);
const imageReference = `postgres@sha256:${'b'.repeat(64)}`;

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function writeJson(file, value)
{
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sealMaterializationReceipt(receipt)
{
    receipt.receiptDigest = '';
    receipt.receiptDigest = sha256(JSON.stringify(receipt, null, 2));
    return receipt;
}

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-schema-receipt-'));
    const assembly = path.join(root, 'FsusBlog.Server.dll');
    const serviceCatalog = path.join(root, 'service-catalog.json');
    const serviceEnvelope = path.join(root, 'service-envelope.json');
    fs.writeFileSync(assembly, 'issue-3105-assembly\n');
    const catalog = {
        schema: 'fsusblog.test-execution-service-catalog.v2',
        version: 2,
        correctnessPhase: {
            imagePull: 'denied',
            hostFallback: 'denied',
            admission: 'planned-actual-exact'
        },
        containerRuntime: {
            kind: 'docker',
            identityFields: [
                'serverVersion',
                'serverId',
                'operatingSystem',
                'architecture',
                'cgroupDriver'
            ],
            plannedVersionSource: 'observed-preflight-exact'
        },
        services: {
            postgres: {
                kind: 'container',
                imageReference,
                version: '16.15',
                databaseIdentityAuthority: 'postgres-control-system-exact',
                versionCommand: ['postgres', '--version'],
                hostNativeAllowed: false,
                database: 'fsusblog',
                username: 'fsusblog',
                serverVersionNumber: '160015',
                requiredIdentityFields: [
                    'containerId',
                    'imageReference',
                    'imageId',
                    'repositoryDigest',
                    'serviceVersion',
                    'networkMode',
                    'ports',
                    'resourceLimits',
                    'databaseIdentity'
                ]
            }
        }
    };
    writeJson(serviceCatalog, catalog);
    const databaseObservation = {
        systemIdentifier: '7534286848000123456',
        database: 'fsusblog',
        username: 'fsusblog',
        serverVersion: '16.15',
        serverVersionNumber: '160015'
    };
    const postgres = {
        id: 'postgres',
        kind: 'container',
        containerId: 'c'.repeat(64),
        createdAt: '2026-08-30T00:00:00Z',
        imageReference,
        imageId: `sha256:${'d'.repeat(64)}`,
        repositoryDigest: imageReference,
        serviceVersion: 'postgres (PostgreSQL) 16.15',
        networkMode: 'bridge',
        networkNamespace: '/var/run/docker/netns/fixture',
        ports: [{
            containerPort: '5432/tcp',
            hostIp: '127.0.0.1',
            hostPort: '25432'
        }],
        resourceLimits: {
            nanoCpus: 0,
            memory: 0,
            memoryReservation: 0,
            pidsLimit: 0
        },
        databaseIdentity: databaseObservation
    };
    const observation = {
        runtime: {
            serverVersion: '28.0.1',
            serverId: 'docker-fixture',
            operatingSystem: 'Linux',
            architecture: 'x86_64',
            cgroupDriver: 'systemd'
        },
        services: [postgres]
    };
    const envelope = {
        schema: 'fsusblog.test-execution-envelope-services.v2',
        qualificationEligible: true,
        producerId: 'backend-runtime',
        runId,
        catalogDigest: canonicalDigest(catalog),
        requiredServices: ['postgres'],
        planned: structuredClone(observation),
        actual: structuredClone(observation),
        admission: 'planned-actual-exact',
        correctnessImagePull: 'denied',
        hostFallback: 'denied'
    };
    writeJson(serviceEnvelope, envelope);
    const databaseIdentity = {
        provider: 'postgresql',
        host: '127.0.0.1',
        port: 25432,
        database: 'fsusblog',
        username: 'fsusblog',
        searchPath: 'public'
    };
    const receipt = sealMaterializationReceipt({
        schema: 'fsusblog.current-schema-test-materialization-receipt.v1',
        status: 'verified',
        commandMode: 'materialize-current-schema-test',
        producerId: 'current-schema-test-materializer',
        testOnly: true,
        qualificationEligible: true,
        runId,
        sourceCommit,
        serviceIdentity: {
            catalogDigest: envelope.catalogDigest,
            envelopeSha256: sha256(fs.readFileSync(serviceEnvelope)),
            producerId: envelope.producerId,
            containerId: postgres.containerId,
            createdAt: postgres.createdAt,
            imageReference: postgres.imageReference,
            imageId: postgres.imageId,
            repositoryDigest: postgres.repositoryDigest,
            serviceVersion: postgres.serviceVersion,
            networkMode: postgres.networkMode,
            networkNamespace: postgres.networkNamespace,
            hostPort: databaseIdentity.port,
            resourceLimits: postgres.resourceLimits,
            postgresInstance: databaseObservation
        },
        databaseIdentity,
        canonicalIdentity: {
            modelVersion: 'fsusblog.current-schema.v2',
            extractorVersion: 'fsusblog.current-schema-reflection.v2',
            generatorVersion: 'fsusblog.current-schema-projection.v2',
            sourceDigest: 'e'.repeat(64),
            contentDigest: 'f'.repeat(64)
        },
        observedDatabaseDigest: '1'.repeat(64),
        tableCount: 2,
        tables: ['article', 'user'],
        emptyBefore: true,
        codeFirstApplied: true,
        startupVerifier: 'green',
        assemblySha256: sha256(fs.readFileSync(assembly)),
        receiptDigest: ''
    });
    const receiptFile = materializationReceiptPath(root, runId);
    writeJson(receiptFile, receipt);
    return {
        root,
        assembly,
        serviceCatalog,
        serviceEnvelope,
        catalog,
        envelope,
        receipt,
        receiptFile,
        options: {
            receiptRoot: root,
            runId,
            sourceCommit,
            assembly,
            serviceCatalog,
            serviceEnvelope
        },
        rewriteReceipt()
        {
            sealMaterializationReceipt(receipt);
            writeJson(receiptFile, receipt);
        },
        cleanup()
        {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

test('verified receipt publishes one exact run-bound runtime-ready terminal', (t) =>
{
    const value = fixture();
    t.after(value.cleanup);
    const result = verifyCurrentSchemaMaterializationReceipt(value.options);
    assert.equal(result.outputFile, runtimeReadyReceiptPath(value.root, runId));
    assert.equal(result.terminal.schema, 'fsusblog.current-schema-runtime-ready.v1');
    assert.equal(result.terminal.status, 'verified');
    assert.equal(result.terminal.qualificationEligible, true);
    assert.equal(result.terminal.runId, runId);
    assert.equal(result.terminal.sourceCommit, sourceCommit);
    assert.equal(result.terminal.materializationReceipt.receiptDigest, value.receipt.receiptDigest);
    assert.equal(
        result.terminal.materializationReceipt.fileSha256,
        `sha256:${sha256(fs.readFileSync(value.receiptFile))}`
    );
    assert.equal(result.terminal.assembly.sha256, value.receipt.assemblySha256);
    assert.deepEqual(result.terminal.serviceIdentity, value.receipt.serviceIdentity);
    assert.equal(result.terminal.contentDigest, canonicalDigest({
        ...result.terminal,
        contentDigest: null
    }));
    assert.deepEqual(
        JSON.parse(fs.readFileSync(result.outputFile, 'utf8')),
        result.terminal
    );
    assert.throws(
        () => verifyCurrentSchemaMaterializationReceipt(value.options),
        /terminal receipt already exists/u
    );
});

test('missing, prepared, stale, tampered, and structurally ambiguous receipts fail closed', (t) =>
{
    const cases = [
        {
            label: 'missing',
            mutate(value)
            {
                fs.rmSync(value.receiptFile);
            },
            expected: /materialization receipt is missing/u
        },
        {
            label: 'prepared sibling',
            mutate(value)
            {
                fs.writeFileSync(`${value.receiptFile}.prepared`, '{}\n');
            },
            expected: /prepared sibling exists/u
        },
        {
            label: 'prepared terminal state',
            mutate(value)
            {
                value.receipt.status = 'prepared';
                value.receipt.qualificationEligible = false;
                value.rewriteReceipt();
            },
            expected: /terminal identity mismatch/u
        },
        {
            label: 'stale run',
            mutate(value)
            {
                value.receipt.runId = 'stale-run';
                value.rewriteReceipt();
            },
            expected: /terminal identity mismatch/u
        },
        {
            label: 'stale source',
            mutate(value)
            {
                value.receipt.sourceCommit = '2'.repeat(40);
                value.rewriteReceipt();
            },
            expected: /terminal identity mismatch/u
        },
        {
            label: 'tampered receipt body',
            mutate(value)
            {
                value.receipt.tableCount = 3;
                writeJson(value.receiptFile, value.receipt);
            },
            expected: /table inventory|receiptDigest mismatch/u
        },
        {
            label: 'extra top-level authority',
            mutate(value)
            {
                value.receipt.fallbackAuthority = true;
                value.rewriteReceipt();
            },
            expected: /key set mismatch/u
        },
        {
            label: 'canonical identity field missing',
            mutate(value)
            {
                delete value.receipt.canonicalIdentity.generatorVersion;
                value.rewriteReceipt();
            },
            expected: /canonicalIdentity key set mismatch/u
        },
        {
            label: 'assembly bytes drift',
            mutate(value)
            {
                fs.appendFileSync(value.assembly, 'drift\n');
            },
            expected: /assembly SHA mismatch/u
        }
    ];
    for (const entry of cases)
    {
        const value = fixture();
        entry.mutate(value);
        assert.throws(
            () => verifyCurrentSchemaMaterializationReceipt({
                ...value.options,
                publish: false
            }),
            entry.expected,
            entry.label
        );
        value.cleanup();
    }
    t.after(() => {});
});

test('catalog, envelope, PostgreSQL observation, and database identity drift fail exact binding', () =>
{
    const cases = [
        {
            label: 'catalog content',
            mutate(value)
            {
                value.catalog.services.postgres.version = '16.14';
                writeJson(value.serviceCatalog, value.catalog);
            },
            expected: /service envelope admission|catalog identity|exact envelope binding/u
        },
        {
            label: 'envelope raw bytes',
            mutate(value)
            {
                fs.appendFileSync(value.serviceEnvelope, '\n');
            },
            expected: /exact envelope binding/u
        },
        {
            label: 'envelope planned actual drift',
            mutate(value)
            {
                value.envelope.actual.services[0].networkMode = 'host';
                writeJson(value.serviceEnvelope, value.envelope);
            },
            expected: /planned\/actual mismatch/u
        },
        {
            label: 'receipt PostgreSQL instance swap',
            mutate(value)
            {
                value.receipt.serviceIdentity.postgresInstance.systemIdentifier = '999';
                value.rewriteReceipt();
            },
            expected: /exact envelope binding/u
        },
        {
            label: 'receipt database target swap',
            mutate(value)
            {
                value.receipt.databaseIdentity.database = 'postgres';
                value.receipt.serviceIdentity.postgresInstance.database = 'postgres';
                value.rewriteReceipt();
            },
            expected: /databaseIdentity canonical value mismatch/u
        }
    ];
    for (const entry of cases)
    {
        const value = fixture();
        try
        {
            entry.mutate(value);
            assert.throws(
                () => verifyCurrentSchemaMaterializationReceipt({
                    ...value.options,
                    publish: false
                }),
                entry.expected,
                entry.label
            );
        }
        finally
        {
            value.cleanup();
        }
    }
});
