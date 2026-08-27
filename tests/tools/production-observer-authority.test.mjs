/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { observeAotGeneration } from '../../tools/test-fixtures/observers/aot-generation.mjs';
import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs';
import { sealDocument } from '../../tools/test-runtime/contract.mjs';
import {
    productionObserverAuthoritySchema,
    publishProductionObserverAuthority,
    readProductionObserverAuthority
} from '../../tools/test-runtime/production-observer-authority.mjs';
import {
    createProductionReceiptRuntimeConfigPort,
    createProductionReceiptRuntimeTopologyPort,
    createProductionReceiptAotGenerationPort,
    createProductionReceiptAbsencePort,
    createProductionReceiptUnavailablePort
} from '../../tools/test-runtime/production-receipt-observer-ports.mjs';

import { runtimeIdentity } from './support/runtime-state-fixture.mjs';

function write(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sessionReceipt(identity, root)
{
    const handles = {
        'fixture.runtime-config': {
            domain: 'fixture.runtime-config',
            owner: { ...identity, domain: 'fixture.runtime-config' },
            mutableRoot: path.join(root, 'mutable', 'fixture-runtime-config'),
            namespace: 'fixture-runtime-config',
            opaqueHandle: null,
            serviceIdentity: null,
            topologyIdentity: null,
            contentDigest: null
        }
    };
    return sealDocument({
        schema: 'fsusblog.runtime-execution-session.v1',
        status: 'ready',
        identity,
        immutableInputsDigest: digestCanonical({ immutable: true }),
        domains: ['fixture.runtime-config'],
        ownedRoot: root,
        handles,
        handleDigest: digestCanonical(handles),
        lifecycleEventCount: 1
    });
}

function container(id, image)
{
    return {
        id,
        kind: 'container',
        imageId: `sha256:${image.repeat(64)}`,
        serviceVersion: 'test',
        ports: [{ containerPort: id === 'postgres' ? '5432/tcp' : '6379/tcp', hostIp: '127.0.0.1', hostPort: '5000' }],
        resourceLimits: { nanoCpus: 1_000_000_000, memory: 1024, pidsLimit: 8 }
    };
}

function processOptions(root, identity)
{
    const environmentReadyFile = path.join(root, 'environment-ready.json');
    write(environmentReadyFile, { schema: 'fsusblog.fixture-environment-ready.v1', status: 'ready' });
    const values = { environmentReadyFile };
    for (const [prefix, role] of [['backend', 'backend'], ['frontend', 'debug-frontend'], ['release', 'release-preview']])
    {
        const identityFile = path.join(root, `${prefix}.identity.json`);
        const executableFile = path.join(root, `${prefix}.executable`);
        write(identityFile, {
            schema: 'fsusblog.local-runtime-process-identity.v1', pid: 100, processGroupId: 100,
            startTimeTicks: '1', runId: identity.runId, namespace: identity.runId, role,
            preparationId: identity.sessionId,
            sourceState: { commit: identity.sourceCommit, worktreeFingerprint: identity.sourceFingerprint },
            createdAt: '2026-08-27T00:00:00.000Z'
        });
        write(executableFile, `${role}-executable`);
        values[`${prefix}ProcessIdentityFile`] = identityFile;
        values[`${prefix}ExecutableFile`] = executableFile;
    }
    return values;
}

const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');
const dotnetDigest = (value) => sha256Hex(Buffer.from(JSON.stringify(value, null, 2), 'utf8'));

function publicAotAuthority(root, releaseId)
{
    const cacheRoot = path.join(root, releaseId, 'public-aot');
    const cacheKey = 'public:aot:v2:doc:2:article:42:locale:zh-Hant:iv:0';
    const artifactId = sha256Hex(cacheKey);
    const relativePath = '2/article-42/aot.aeds';
    const bytes = Buffer.from('real-public-aot-artifact');
    const payloadDigest = sha256Hex(bytes);
    const transaction = {
        schema: 'fsusblog.public-aot-artifact-transaction.v1', artifactId, cacheKey, relativePath,
        generation: 0, payloadDigest, registryKeys: ['public:aot:v2:registry'], state: 'complete',
        updatedAtUtc: '2026-08-27T00:00:00+00:00', contentDigest: ''
    };
    transaction.contentDigest = dotnetDigest(transaction);
    const identity = Object.fromEntries([
        'schema', 'artifactId', 'cacheKey', 'relativePath', 'generation', 'payloadDigest', 'registryKeys'
    ].map((key) => [key, transaction[key]]));
    const pointer = {
        schema: 'fsusblog.public-aot-artifact-pointer.v1', artifactId, cacheKey, relativePath,
        generation: 0, payloadDigest, transactionDigest: dotnetDigest(identity),
        updatedAtUtc: '2026-08-27T00:00:00+00:00', contentDigest: ''
    };
    pointer.contentDigest = dotnetDigest(pointer);
    const publicationId = sha256Hex(relativePath);
    const publicationGeneration = `artifact-${payloadDigest}`;
    const immutableFile = path.join(cacheRoot, '.artifacts', publicationId, 'generations', publicationGeneration, relativePath);
    write(path.join(cacheRoot, '.transactions', `${artifactId}.json`), transaction);
    write(path.join(cacheRoot, '.transaction-pointers', `${artifactId}.json`), pointer);
    write(path.join(cacheRoot, '.pointers', `${publicationId}.json`), {
        schema: 'fsusblog.release-derived-artifact-pointer.v1', releaseId, kind: 'public-aot',
        artifactPath: relativePath, generation: publicationGeneration
    });
    write(immutableFile, bytes);
    const generationRoot = path.join(cacheRoot, '.artifacts', publicationId, 'generations', publicationGeneration);
    write(path.join(generationRoot, 'generation-manifest.json'), {
        schema: 'fsusblog.release-derived-generation.v1', releaseId, kind: 'public-aot', generation: publicationGeneration,
        files: [{ path: relativePath, sha256: `sha256:${payloadDigest}`, bytes: bytes.length }]
    });
    return { cacheRoot, immutableFile, transactionFile: path.join(cacheRoot, '.transactions', `${artifactId}.json`) };
}

test('production observer projector seals config/topology and ports reject ambient or tampered authority', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-observer-authority-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = runtimeIdentity({ runId: 'authority-run', sessionId: 'authority-session' });
    const sessionFile = path.join(root, 'session.json');
    const environmentFile = path.join(root, 'authority.env');
    const keyFile = path.join(root, 'fingerprint.key');
    const serviceFile = path.join(root, 'services.json');
    const outputFile = path.join(root, 'observer-authority.json');
    write(sessionFile, sessionReceipt(identity, root));
    write(keyFile, Buffer.alloc(32, 9));
    write(environmentFile, [
        'FSUSBLOG_TEST_NAMESPACE=authority-run',
        'FSUSBLOG_TEST_RUN_ID=authority-run',
        'FSUSBLOG_DEBUG_BACKEND_PORT=5101',
        'FSUSBLOG_DEBUG_FRONTEND_PORT=5102',
        'FSUSBLOG_RELEASE_PREVIEW_PORT=5103',
        'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:5101',
        'FSUSBLOG_DEBUG_FRONTEND_URL=http://127.0.0.1:5102',
        'FSUSBLOG_RELEASE_PREVIEW_URL=http://127.0.0.1:5103',
        'FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-test-authority-postgres',
        'FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-authority-redis',
        'RedisOptions__InstanceName=FsusBlog_authority_',
        'Jwt__SecretKey=never-emit-this-secret'
    ].join('\n') + '\n');
    const services = [container('postgres', 'a'), container('redis', 'b')];
    write(serviceFile, {
        schema: 'fsusblog.test-execution-envelope-services.v1',
        qualificationEligible: true,
        producerId: 'bootstrap',
        runId: identity.runId,
        planned: { services },
        actual: { services },
        admission: 'planned-actual-exact'
    });
    const authority = publishProductionObserverAuthority({
        phase: 'ready', outputFile, sessionReceiptFile: sessionFile,
        environmentFile, fingerprintKeyFile: keyFile, serviceEnvelopeFile: serviceFile,
        ...processOptions(root, identity)
    });
    assert.equal(authority.schema, productionObserverAuthoritySchema);
    assert.equal(JSON.stringify(authority).includes('never-emit-this-secret'), false);
    assert.equal(authority.domains['artifact.public-aot-overlay'].status, 'absent');
    assert.equal(authority.domains['postgres.article'].status, 'observed');
    assert.equal(authority.domains['redis.cache.public'].status, 'observed');
    const configPort = createProductionReceiptRuntimeConfigPort({ authorityFile: outputFile, identity });
    const config = await configPort.readResolvedConfig({ handle: { namespace: 'authority-run' } });
    assert.equal(config.readonly, true);
    assert.equal(config.envelopeDigest, identity.envelopeDigest);
    assert.match(config.secrets[0].protectedValue.fingerprint, /^hmac-sha256:/u);
    const topologyRecord = authority.domains['runtime.backend-process'].topology;
    const topologyPort = createProductionReceiptRuntimeTopologyPort({ authorityFile: outputFile, identity });
    const topology = await topologyPort.readOwnedTopology({ handle: {
        owner: { domain: 'runtime.backend-process' }, namespace: 'authority-run',
        plannedTopologyDigest: topologyRecord.plannedTopologyDigest
    } });
    assert.deepEqual(topology.services.map(({ role }) => role), ['backend', 'debug-frontend', 'postgres', 'redis', 'release-preview']);
    const unavailable = createProductionReceiptUnavailablePort({
        authorityFile: outputFile, identity, domain: 'artifact.public-aot-overlay', kind: 'aot-generation'
    });
    assert.equal((await unavailable.readAuthority()).status, 'absent');
    const absencePort = createProductionReceiptAbsencePort({ authorityFile: outputFile, identity });
    const absentAot = await observeAotGeneration({
        domain: 'artifact.public-aot-overlay', identity,
        context: {
            handles: {
                'artifact.public-aot-overlay': {
                    owner: { ...identity, domain: 'artifact.public-aot-overlay' },
                    catalogDigest: identity.catalogDigest,
                    namespace: 'authority-run',
                    observationStatus: 'absent',
                    absenceAuthorityDigest: authority.contentDigest
                }
            },
            ports: { absence: absencePort }
        }
    });
    assert.equal(absentAot.semantic.observationStatus, 'absent');
    const tampered = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    tampered.phase = 'tampered';
    write(outputFile, tampered);
    assert.throws(() => readProductionObserverAuthority(outputFile, identity), /contentDigest mismatch/);
});

test('production observer authority rejects cross-session and planned/actual service drift', () =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-observer-reject-'));
    try
    {
        const identity = runtimeIdentity({ runId: 'reject-run', sessionId: 'reject-session' });
        const sessionFile = path.join(root, 'session.json');
        const environmentFile = path.join(root, 'authority.env');
        const keyFile = path.join(root, 'fingerprint.key');
        const serviceFile = path.join(root, 'services.json');
        write(sessionFile, sessionReceipt(identity, root));
        write(keyFile, Buffer.alloc(32, 3));
        write(environmentFile, [
            'FSUSBLOG_TEST_NAMESPACE=reject-run', 'FSUSBLOG_TEST_RUN_ID=reject-run',
            'FSUSBLOG_DEBUG_BACKEND_PORT=5201', 'FSUSBLOG_DEBUG_FRONTEND_PORT=5202', 'FSUSBLOG_RELEASE_PREVIEW_PORT=5203',
            'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:5201',
            'FSUSBLOG_DEBUG_FRONTEND_URL=http://127.0.0.1:5202',
            'FSUSBLOG_RELEASE_PREVIEW_URL=http://127.0.0.1:5203'
        ].join('\n') + '\n');
        write(serviceFile, {
            schema: 'fsusblog.test-execution-envelope-services.v1', qualificationEligible: true,
            runId: identity.runId, admission: 'planned-actual-exact',
            planned: { services: [container('postgres', 'a')] }, actual: { services: [container('redis', 'b')] }
        });
        assert.throws(() => publishProductionObserverAuthority({
            phase: 'ready', outputFile: path.join(root, 'out.json'), sessionReceiptFile: sessionFile,
            environmentFile, fingerprintKeyFile: keyFile, serviceEnvelopeFile: serviceFile
        }), /planned\/actual exact/);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('production AOT authority follows explicit release pointers and immutable generation bytes', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-observer-aot-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = runtimeIdentity({ runId: 'aot-authority-run', sessionId: 'aot-authority-session' });
    const releaseId = '20260827000000-a1b2c3d4e5f6';
    const derived = path.join(root, 'mutable', 'release-derived');
    const aot = publicAotAuthority(derived, releaseId);
    const sessionFile = path.join(root, 'session.json');
    const environmentFile = path.join(root, 'authority.env');
    const keyFile = path.join(root, 'fingerprint.key');
    const serviceFile = path.join(root, 'services.json');
    const reportFile = path.join(root, 'warm.json');
    const outputFile = path.join(root, 'authority.json');
    write(sessionFile, sessionReceipt(identity, root));
    write(keyFile, Buffer.alloc(32, 7));
    write(environmentFile, [
        'FSUSBLOG_TEST_NAMESPACE=aot-authority-run', 'FSUSBLOG_TEST_RUN_ID=aot-authority-run',
        'FSUSBLOG_DEBUG_BACKEND_PORT=5301', 'FSUSBLOG_DEBUG_FRONTEND_PORT=5302', 'FSUSBLOG_RELEASE_PREVIEW_PORT=5303',
        'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:5301',
        'FSUSBLOG_DEBUG_FRONTEND_URL=http://127.0.0.1:5302',
        'FSUSBLOG_RELEASE_PREVIEW_URL=http://127.0.0.1:5303',
        'FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-test-aot-postgres',
        'FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-aot-redis',
        'RedisOptions__InstanceName=FsusBlog_aot_',
        `FSUSBLOG_RELEASE_DERIVED_ROOT=${derived}`, `FSUSBLOG_RELEASE_ID=${releaseId}`
    ].join('\n') + '\n');
    const services = [container('postgres', 'a'), container('redis', 'b')];
    write(serviceFile, {
        schema: 'fsusblog.test-execution-envelope-services.v1', qualificationEligible: true,
        producerId: 'bootstrap', runId: identity.runId, planned: { services }, actual: { services }, admission: 'planned-actual-exact'
    });
    write(reportFile, {
        schema: 'fsusblog.public-aot-warm-evidence.v1', status: 'ok', manifestDigest: 'sha256:manifest',
        manifest: [{ pageId: '2', routeKey: 'article:42', path: '/article/42' }],
        routes: [{ path: '/article/42', ok: true }], warmed: 1, failed: 0
    });
    const authority = publishProductionObserverAuthority({
        phase: 'ready', outputFile, sessionReceiptFile: sessionFile, environmentFile,
        fingerprintKeyFile: keyFile, serviceEnvelopeFile: serviceFile, aotWarmReportFile: reportFile,
        ...processOptions(root, identity)
    });
    const record = authority.domains['artifact.public-aot-overlay'];
    assert.equal(record.status, 'observed');
    assert.deepEqual(Object.values(record.artifactRefs), [aot.immutableFile]);
    const port = createProductionReceiptAotGenerationPort({ authorityFile: outputFile, identity });
    const handle = {
        owner: { ...identity, domain: 'artifact.public-aot-overlay' }, catalogDigest: identity.catalogDigest,
        namespace: 'aot-authority-run', overlayId: 'public-aot-overlay', activeGenerationRef: record.active,
        manifestRef: { contentDigest: record.manifest.contentDigest }, expectedArtifacts: record.manifest.artifacts,
        expectedRoutes: record.manifest.routes
    };
    const observed = await observeAotGeneration({
        domain: 'artifact.public-aot-overlay', identity,
        context: { handles: { 'artifact.public-aot-overlay': handle }, ports: { aotGeneration: port } }
    });
    assert.equal(observed.semantic.artifacts[0].contentDigest, `sha256:${sha256Hex(fs.readFileSync(aot.immutableFile))}`);
    const tampered = JSON.parse(fs.readFileSync(aot.transactionFile, 'utf8'));
    tampered.cacheKey = 'public:aot:v2:doc:2:article:99:iv:0';
    write(aot.transactionFile, tampered);
    assert.throws(() => publishProductionObserverAuthority({
        phase: 'ready', outputFile, sessionReceiptFile: sessionFile, environmentFile,
        fingerprintKeyFile: keyFile, serviceEnvelopeFile: serviceFile, aotWarmReportFile: reportFile,
        ...processOptions(root, identity)
    }), /transaction authority is invalid/);
});
