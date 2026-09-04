import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    createAndAdmitServiceEnvelope,
    executionServiceImageReference,
    loadExecutionServiceCatalog,
    observeContainerService,
    observeRunOwnedService,
    parseExecutionEnvelopeServicesOptions,
    requiredExecutionServices,
    validateExecutionServiceCatalog,
    verifyLiveServiceEnvelope
} from '../../tools/test/execution-envelope-services.mjs';
import { loadExecutionEnvelopeApplicability } from '../../tools/test-matrix/execution-envelope-policy.mjs';
import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs';

const matrix = parseMatrix(
    fs.readFileSync(new URL('../../tests/matrix.yml', import.meta.url), 'utf8')
);
const catalog = loadExecutionServiceCatalog();
const applicability = loadExecutionEnvelopeApplicability();

test('service catalog exactly covers matrix services with immutable container references', () =>
{
    assert.deepEqual(validateExecutionServiceCatalog(catalog, matrix), []);
    assert.match(catalog.services.postgres.imageReference, /@sha256:[a-f0-9]{64}$/u);
    assert.match(catalog.services.redis.imageReference, /@sha256:[a-f0-9]{64}$/u);
    assert.equal(catalog.correctnessPhase.imagePull, 'denied');
    assert.equal(catalog.correctnessPhase.hostFallback, 'denied');
    assert.equal(catalog.schema, 'fsusblog.test-execution-service-catalog.v2');
    assert.equal(catalog.version, 2);
    assert.equal(
        catalog.services.postgres.databaseIdentityAuthority,
        'postgres-control-system-exact'
    );
    assert.equal(catalog.services.postgres.database, 'fsusblog');
    assert.equal(catalog.services.postgres.username, 'fsusblog');
    assert.equal(catalog.services.postgres.serverVersionNumber, '160015');
    assert.equal(executionServiceImageReference('postgres'), catalog.services.postgres.imageReference);
    assert.throws(() => executionServiceImageReference('unknown'), /pinned execution service image/u);
    assert.deepEqual(requiredExecutionServices('integration', applicability), [
        'backend', 'frontend', 'postgres', 'redis'
    ]);
});

test('run-owned services require live process, source, artifact, config, topology, and limits', () =>
{
    const processIdentity = {
        pid: 42,
        processStartIdentity: 'linux:boot:100',
        executablePath: '/run/backend',
        executableDigest: `sha256:${'a'.repeat(64)}`,
        commandDigest: `sha256:${'b'.repeat(64)}`
    };
    const evidence = {
        sourceCommit: 'c'.repeat(40),
        worktreeFingerprint: `sha256:${'d'.repeat(64)}`,
        artifactDigest: `sha256:${'e'.repeat(64)}`,
        configDigest: `sha256:${'f'.repeat(64)}`,
        processIdentity,
        topology: {
            port: 24001,
            networkNamespace: 'run-owned-loopback',
            resourceLimits: { cpuUnits: 1, memoryGiB: 1 }
        }
    };
    const observed = observeRunOwnedService({
        id: 'backend',
        evidence,
        catalogEntry: catalog.services.backend,
        observeProcess: () => ({ status: 'live', actual: processIdentity })
    });
    assert.equal(observed.artifactDigest, evidence.artifactDigest);
    assert.throws(() => observeRunOwnedService({
        id: 'backend',
        evidence: { ...evidence, configDigest: null },
        catalogEntry: catalog.services.backend,
        observeProcess: () => ({ status: 'live', actual: processIdentity })
    }), /configDigest is incomplete/u);
    assert.throws(() => observeRunOwnedService({
        id: 'backend',
        evidence,
        catalogEntry: catalog.services.backend,
        observeProcess: () => ({ status: 'dead' })
    }), /process identity drift/u);
});

test('floating tags, implicit host services, and missing matrix services fail closed', () =>
{
    for (const mutate of [
        (candidate) =>
        {
            candidate.services.postgres.imageReference = 'postgres:16-alpine';
        },
        (candidate) =>
        {
            candidate.services.redis.hostNativeAllowed = true;
        },
        (candidate) =>
        {
            delete candidate.services.backend;
        },
        (candidate) =>
        {
            candidate.correctnessPhase.imagePull = 'allowed';
        },
        (candidate) =>
        {
            candidate.services.postgres.databaseIdentityAuthority = 'container-env';
        },
        (candidate) =>
        {
            candidate.services.postgres.database = 'postgres';
        },
        (candidate) =>
        {
            candidate.services.postgres.username = 'postgres';
        },
        (candidate) =>
        {
            candidate.services.postgres.serverVersionNumber = '160014';
        },
        (candidate) =>
        {
            candidate.services.postgres.requiredIdentityFields.pop();
        },
        (candidate) =>
        {
            candidate.services.postgres.unownedAuthority = true;
        }
    ])
    {
        const candidate = structuredClone(catalog);
        mutate(candidate);
        assert.notDeepEqual(validateExecutionServiceCatalog(candidate, matrix), []);
    }
});

test('runtime, image, version, topology, ports, and limits are exact-match admission facts', () =>
{
    let generation = 0;
    const runtime = {
        serverVersion: '29.0.0',
        serverId: 'engine',
        operatingSystem: 'linux',
        architecture: 'amd64',
        cgroupDriver: 'systemd'
    };
    const service = ({ id, catalogEntry }) => ({
        id,
        kind: 'container',
        containerId: `${id}-${generation}`,
        createdAt: '2026-01-01T00:00:00Z',
        imageReference: catalogEntry.imageReference,
        imageId: `sha256:${'a'.repeat(64)}`,
        repositoryDigest: catalogEntry.imageReference,
        serviceVersion: catalogEntry.version,
        networkMode: 'bridge',
        networkNamespace: '/run/netns/fixture',
        ports: [{ containerPort: '5432/tcp', hostIp: '127.0.0.1', hostPort: '15432' }],
        resourceLimits: { nanoCpus: 1, memory: 2, memoryReservation: 1, pidsLimit: 64 },
        ...(id === 'postgres' ? {
            databaseIdentity: {
                systemIdentifier: '7612345678901234567',
                database: 'fsusblog',
                username: 'fsusblog',
                serverVersion: '16.15',
                serverVersionNumber: '160015'
            }
        } : {})
    });
    const envelope = createAndAdmitServiceEnvelope({
        producerId: 'integration',
        runId: 'run-1',
        containers: { postgres: 'pg', redis: 'redis' },
        catalog,
        observeRuntime: () => structuredClone(runtime),
        observeService: service
    });
    assert.equal(envelope.schema, 'fsusblog.test-execution-envelope-services.v2');
    assert.equal(envelope.admission, 'planned-actual-exact');
    assert.deepEqual(envelope.planned, envelope.actual);
    assert.equal(
        envelope.actual.services.find((entry) => entry.id === 'postgres')
            .databaseIdentity.systemIdentifier,
        '7612345678901234567'
    );
    generation = 1;
    assert.throws(() => createAndAdmitServiceEnvelope({
        producerId: 'integration',
        runId: 'run-1',
        containers: { postgres: 'pg' },
        catalog,
        observeRuntime: () => structuredClone(runtime),
        observeService: () =>
        {
            generation += 1;
            return service({ id: 'postgres', catalogEntry: catalog.services.postgres });
        }
    }), /planned\/actual service envelope drift/u);
});

function postgresDocker(identityOutput)
{
    const calls = [];
    const imageId = `sha256:${'a'.repeat(64)}`;
    const docker = (command, args) =>
    {
        calls.push([command, args]);
        if (args[0] === 'inspect')
        {
            return {
                status: 0,
                stdout: JSON.stringify([{
                    Id: 'postgres-container',
                    Created: '2026-01-01T00:00:00Z',
                    State: { Running: true },
                    Config: { Image: catalog.services.postgres.imageReference },
                    Image: imageId,
                    HostConfig: {
                        NetworkMode: 'bridge',
                        NanoCpus: 1,
                        Memory: 2,
                        MemoryReservation: 1,
                        PidsLimit: 64
                    },
                    NetworkSettings: {
                        SandboxKey: '/run/netns/postgres',
                        Ports: {
                            '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15432' }]
                        }
                    }
                }])
            };
        }
        if (args[0] === 'image')
        {
            return {
                status: 0,
                stdout: JSON.stringify([{
                    Id: imageId,
                    RepoDigests: [catalog.services.postgres.imageReference]
                }])
            };
        }
        if (args[0] === 'exec' && args.includes('postgres'))
        {
            return { status: 0, stdout: 'postgres (PostgreSQL) 16.15\n' };
        }
        if (args[0] === 'exec' && args.includes('psql'))
        {
            return {
                status: 0,
                stdout: typeof identityOutput === 'string'
                    ? identityOutput
                    : `${JSON.stringify(identityOutput)}\n`
            };
        }
        throw new Error(`unexpected Docker call: ${args.join(' ')}`);
    };
    return { calls, docker };
}

test('PostgreSQL observation exact-binds the live database and cluster identity', () =>
{
    const identity = {
        systemIdentifier: '7612345678901234567',
        database: 'fsusblog',
        username: 'fsusblog',
        serverVersion: '16.15',
        serverVersionNumber: '160015'
    };
    const fixture = postgresDocker(identity);
    const observed = observeContainerService({
        id: 'postgres',
        containerName: 'fsusblog-test-postgres-run',
        catalogEntry: catalog.services.postgres,
        docker: fixture.docker
    });
    assert.deepEqual(observed.databaseIdentity, identity);
    const psql = fixture.calls.find(([, args]) => args.includes('psql'))?.[1];
    assert.deepEqual(psql.slice(0, 4), [
        'exec',
        'fsusblog-test-postgres-run',
        'psql',
        '--no-psqlrc'
    ]);
    assert.equal(psql[psql.indexOf('--dbname') + 1], 'fsusblog');
    assert.equal(psql[psql.indexOf('--username') + 1], 'fsusblog');
    assert.match(psql.at(-1), /pg_control_system\(\)/u);
    assert.match(psql.at(-1), /current_setting\('server_version_num'\)/u);
});

test('PostgreSQL catalog version admits a distro suffix with an exact prefix boundary', () =>
{
    const identity = {
        systemIdentifier: '7612345678901234567',
        database: 'fsusblog',
        username: 'fsusblog',
        serverVersion: '16.15 (Debian 16.15-1.pgdg120+1)',
        serverVersionNumber: '160015'
    };
    assert.equal(observeContainerService({
        id: 'postgres',
        containerName: 'fsusblog-test-postgres-run',
        catalogEntry: catalog.services.postgres,
        docker: postgresDocker(identity).docker
    }).databaseIdentity.serverVersion, identity.serverVersion);
    assert.throws(() => observeContainerService({
        id: 'postgres',
        containerName: 'fsusblog-test-postgres-run',
        catalogEntry: catalog.services.postgres,
        docker: postgresDocker({ ...identity, serverVersion: '16.150 vendor' }).docker
    }), /database identity drift/u);
});

test('malformed or drifting PostgreSQL live identity fails closed', () =>
{
    const valid = {
        systemIdentifier: '7612345678901234567',
        database: 'fsusblog',
        username: 'fsusblog',
        serverVersion: '16.15',
        serverVersionNumber: '160015'
    };
    const candidates = [
        '{not-json',
        { ...valid, systemIdentifier: 761234 },
        { ...valid, database: 'postgres' },
        { ...valid, username: 'postgres' },
        { ...valid, serverVersion: '16.14' },
        { ...valid, serverVersionNumber: '160014' },
        { ...valid, extra: true }
    ];
    for (const candidate of candidates)
    {
        assert.throws(() => observeContainerService({
            id: 'postgres',
            containerName: 'fsusblog-test-postgres-run',
            catalogEntry: catalog.services.postgres,
            docker: postgresDocker(candidate).docker
        }), /database identity (?:is malformed|drift)/u);
    }
});

test('planned and actual PostgreSQL cluster identity drift fails closed', () =>
{
    let observation = 0;
    const service = ({ id, catalogEntry }) => ({
        id,
        kind: 'container',
        containerId: 'postgres-container',
        createdAt: '2026-01-01T00:00:00Z',
        imageReference: catalogEntry.imageReference,
        imageId: `sha256:${'a'.repeat(64)}`,
        repositoryDigest: catalogEntry.imageReference,
        serviceVersion: '16.15',
        networkMode: 'bridge',
        networkNamespace: '/run/netns/postgres',
        ports: [{ containerPort: '5432/tcp', hostIp: '127.0.0.1', hostPort: '15432' }],
        resourceLimits: { nanoCpus: 1, memory: 2, memoryReservation: 1, pidsLimit: 64 },
        databaseIdentity: {
            systemIdentifier: String(7612345678901234567n + BigInt(observation++)),
            database: 'fsusblog',
            username: 'fsusblog',
            serverVersion: '16.15',
            serverVersionNumber: '160015'
        }
    });
    assert.throws(() => createAndAdmitServiceEnvelope({
        producerId: 'integration',
        runId: 'run-database-drift',
        requiredServices: ['postgres'],
        containers: { postgres: 'pg' },
        catalog,
        observeRuntime: () => ({
            serverVersion: '29.0.0',
            serverId: 'engine',
            operatingSystem: 'linux',
            architecture: 'amd64',
            cgroupDriver: 'systemd'
        }),
        observeService: service
    }), /planned\/actual service envelope drift/u);
});

function liveEnvelopeFixture()
{
    const runtime = {
        serverVersion: '29.0.0',
        serverId: 'engine',
        operatingSystem: 'linux',
        architecture: 'amd64',
        cgroupDriver: 'systemd'
    };
    const service = {
        id: 'postgres',
        kind: 'container',
        containerId: 'exact-postgres-container-id',
        createdAt: '2026-01-01T00:00:00Z',
        imageReference: catalog.services.postgres.imageReference,
        imageId: `sha256:${'a'.repeat(64)}`,
        repositoryDigest: catalog.services.postgres.imageReference,
        serviceVersion: 'postgres (PostgreSQL) 16.15',
        networkMode: 'bridge',
        networkNamespace: '/run/netns/postgres',
        ports: [{ containerPort: '5432/tcp', hostIp: '127.0.0.1', hostPort: '15432' }],
        resourceLimits: { nanoCpus: 1, memory: 2, memoryReservation: 1, pidsLimit: 64 },
        databaseIdentity: {
            systemIdentifier: '7612345678901234567',
            database: 'fsusblog',
            username: 'fsusblog',
            serverVersion: '16.15 (Debian 16.15-1.pgdg120+1)',
            serverVersionNumber: '160015'
        }
    };
    const envelope = createAndAdmitServiceEnvelope({
        producerId: 'integration',
        runId: 'run-live-verification',
        requiredServices: ['postgres'],
        containers: { postgres: 'mutable-name-is-not-reused' },
        catalog,
        observeRuntime: () => structuredClone(runtime),
        observeService: () => structuredClone(service)
    });
    return { envelope, runtime, service };
}

test('live verification addresses containers by admitted ID and exact-matches all identity', () =>
{
    const { envelope, runtime, service } = liveEnvelopeFixture();
    let addressedContainer;
    const verified = verifyLiveServiceEnvelope({
        envelope,
        catalog,
        observeRuntime: () => structuredClone(runtime),
        observeService: ({ containerName }) =>
        {
            addressedContainer = containerName;
            return structuredClone(service);
        }
    });
    assert.equal(verified, envelope);
    assert.equal(addressedContainer, service.containerId);
});

test('forged planned-equals-actual envelopes fail against live runtime and service identity', () =>
{
    const cases = [
        ['runtime', (candidate) =>
        {
            candidate.actual.runtime.serverId = 'forged-engine';
        }],
        ['imageId', (candidate) =>
        {
            candidate.actual.services[0].imageId = `sha256:${'b'.repeat(64)}`;
        }],
        ['network mode', (candidate) =>
        {
            candidate.actual.services[0].networkMode = 'host';
        }],
        ['network namespace', (candidate) =>
        {
            candidate.actual.services[0].networkNamespace = '/run/netns/forged';
        }],
        ['resource limit', (candidate) =>
        {
            candidate.actual.services[0].resourceLimits.memory = 3;
        }],
        ['port topology', (candidate) =>
        {
            candidate.actual.services[0].ports[0].hostPort = '15433';
        }],
        ['creation identity', (candidate) =>
        {
            candidate.actual.services[0].createdAt = '2026-01-02T00:00:00Z';
        }],
        ['service version', (candidate) =>
        {
            candidate.actual.services[0].serviceVersion = 'postgres (PostgreSQL) 16.15 forged';
        }],
        ['database instance', (candidate) =>
        {
            candidate.actual.services[0].databaseIdentity.systemIdentifier =
                '7612345678901234568';
        }]
    ];
    for (const [label, mutate] of cases)
    {
        const { envelope, runtime, service } = liveEnvelopeFixture();
        mutate(envelope);
        envelope.planned = structuredClone(envelope.actual);
        assert.throws(() => verifyLiveServiceEnvelope({
            envelope,
            catalog,
            observeRuntime: () => structuredClone(runtime),
            observeService: () => structuredClone(service)
        }), /live planned\/actual service envelope drift/u, label);
    }
});

test('live verification option parsing is closed and single-occurrence', () =>
{
    assert.deepEqual(
        [...parseExecutionEnvelopeServicesOptions([
            '--verify-envelope', 'envelope.json',
            '--service-catalog', 'catalog.json'
        ])],
        [
            ['--verify-envelope', 'envelope.json'],
            ['--service-catalog', 'catalog.json']
        ]
    );
    assert.throws(() => parseExecutionEnvelopeServicesOptions([
        '--verify-envelope', 'one.json',
        '--verify-envelope', 'two.json'
    ]), /duplicate execution envelope service option/u);
    assert.throws(() => parseExecutionEnvelopeServicesOptions([
        '--unowned-option', 'value'
    ]), /unknown execution envelope service option/u);
    assert.throws(() => parseExecutionEnvelopeServicesOptions([
        '--verify-envelope'
    ]), /name\/value pairs/u);
});
