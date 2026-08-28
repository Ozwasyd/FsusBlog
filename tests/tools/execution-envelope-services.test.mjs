import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    createAndAdmitServiceEnvelope,
    executionServiceImageReference,
    loadExecutionServiceCatalog,
    observeRunOwnedService,
    requiredExecutionServices,
    validateExecutionServiceCatalog
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
        resourceLimits: { nanoCpus: 1, memory: 2, memoryReservation: 1, pidsLimit: 64 }
    });
    const envelope = createAndAdmitServiceEnvelope({
        producerId: 'integration',
        runId: 'run-1',
        containers: { postgres: 'pg', redis: 'redis' },
        catalog,
        observeRuntime: () => structuredClone(runtime),
        observeService: service
    });
    assert.equal(envelope.admission, 'planned-actual-exact');
    assert.deepEqual(envelope.planned, envelope.actual);
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
