#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    productionBuildReceiptSchema
} from '../ci/production-build-artifacts.mjs';

import {
    producerRouteIds,
    routeCatalogDigest,
    routeContract
} from './lanes/runtime-http-route-contract.mjs';
import {
    digestFile,
    digestValue
} from './release-reliability-receipt.mjs';

export const releaseReliabilityRuntimeAdmissionSchema =
    'fsusblog.release-reliability.runtime-admission.v1';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeSmokeSchema = 'fsusblog.release-reliability-runtime-smoke.v1';
const fixtureAuthoritySchema = 'fsusblog.release-reliability-runtime-topology.v1';
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const containerIdPattern = /^[0-9a-f]{64}$/u;
const identifierPattern = /^[a-z0-9][a-z0-9_.-]*$/u;
const isoTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const runtimeRouteIds = Object.freeze(producerRouteIds('runtime-load-soak'));

function canonical(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonical);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, canonical(value[key])])
        );
    }
    return value;
}

function sameValue(left, right)
{
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function assertObject(value, label)
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error(`${label} must be an object`);
    }
    return value;
}

function assertExactKeys(value, expected, label)
{
    assertObject(value, label);
    const actual = Object.keys(value).sort();
    const required = [...expected].sort();
    if (!sameValue(actual, required))
    {
        throw new Error(`${label} fields are not exact`);
    }
}

function normalizeFingerprint(value, label)
{
    const normalized = String(value ?? '').trim().toLowerCase();
    const digest = normalized.startsWith('sha256:')
        ? normalized
        : `sha256:${normalized}`;
    if (!digestPattern.test(digest))
    {
        throw new Error(`${label} is not a SHA-256 fingerprint`);
    }
    return digest;
}

function normalizedRelativePath(value, label)
{
    const normalized = String(value ?? '').trim()
        .replaceAll('\\', '/')
        .replace(/^\.\//u, '');
    if (!normalized || path.posix.isAbsolute(normalized)
        || path.posix.normalize(normalized) !== normalized
        || normalized.split('/').some((segment) => !segment || segment === '..'))
    {
        throw new Error(`${label} path is unsafe`);
    }
    return normalized;
}

function resolveApprovedPath(repositoryRoot, value, label)
{
    const relative = normalizedRelativePath(value, label);
    const absolute = path.resolve(repositoryRoot, relative);
    if (absolute === repositoryRoot
        || !absolute.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error(`${label} path escapes the repository`);
    }
    for (let cursor = absolute; cursor !== repositoryRoot; cursor = path.dirname(cursor))
    {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
        {
            throw new Error(`${label} path contains a symlink`);
        }
    }
    return { absolute, relative };
}

function readJsonBinding(repositoryRoot, configuredPath, label)
{
    const resolved = resolveApprovedPath(repositoryRoot, configuredPath, label);
    if (!fs.existsSync(resolved.absolute))
    {
        throw new Error(`${label} is missing`);
    }
    const stat = fs.lstatSync(resolved.absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`${label} is not a regular file`);
    }
    let document;
    try
    {
        document = JSON.parse(fs.readFileSync(resolved.absolute, 'utf8'));
    }
    catch
    {
        throw new Error(`${label} is not valid JSON`);
    }
    return {
        ...resolved,
        fileDigest: digestFile(resolved.absolute),
        document
    };
}

function writeJsonAtomic(repositoryRoot, configuredPath, value, label)
{
    const resolved = resolveApprovedPath(repositoryRoot, configuredPath, label);
    if (fs.existsSync(resolved.absolute))
    {
        throw new Error(`${label} already exists`);
    }
    fs.mkdirSync(path.dirname(resolved.absolute), {
        recursive: true,
        mode: 0o700
    });
    const temporary = `${resolved.absolute}.next-${process.pid}-${randomUUID()}`;
    try
    {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600
        });
        fs.renameSync(temporary, resolved.absolute);
        fs.chmodSync(resolved.absolute, 0o400);
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }
    return resolved;
}

function seal(value)
{
    const sealed = { ...value, contentDigest: null };
    sealed.contentDigest = digestValue(sealed);
    return sealed;
}

function expectedCandidatePath(invocationId)
{
    return `.tmp/release-reliability/${invocationId}/runtime-admission-candidate.json`;
}

function expectedReceiptPath(invocationId)
{
    return `.tmp/release-reliability/${invocationId}/runtime-admission-receipt.json`;
}

function expectedSmokePath(invocationId)
{
    return `.tmp/release-reliability/${invocationId}/runtime-smoke-observation.json`;
}

function expectedBuildReceiptPath(runId)
{
    return `.tmp/ci-production-build/${runId}/receipt.json`;
}

function expectedFixturePath(runId)
{
    return `.tmp/release-reliability/${runId}/fixture-authority.json`;
}

function validateBuildReceipt(receipt, {
    sourceState,
    runId,
    expectedContentDigest
})
{
    assertObject(receipt, 'production build receipt');
    if (receipt.schema !== productionBuildReceiptSchema
        || receipt.status !== 'complete'
        || receipt.contentDigest !== digestValue(receipt)
        || receipt.contentDigest !== expectedContentDigest)
    {
        throw new Error('production build receipt is incomplete or digest-mismatched');
    }
    if (receipt.sourceState?.commit !== sourceState.commit
        || normalizeFingerprint(
            receipt.sourceState?.worktreeFingerprint,
            'production build source fingerprint'
        ) !== sourceState.worktreeFingerprint)
    {
        throw new Error('production build receipt source identity mismatch');
    }
    assertExactKeys(
        receipt.producer,
        ['workflow', 'runId', 'runAttempt', 'job'],
        'production build producer'
    );
    if (typeof receipt.producer.workflow !== 'string'
        || !receipt.producer.workflow.trim()
        || receipt.producer.runId !== runId
        || receipt.producer.runAttempt !== 1
        || receipt.producer.job !== 'production-build-artifacts')
    {
        throw new Error('production build receipt producer identity mismatch');
    }
}

function inspectRuntimeImage(reference)
{
    const result = spawnSync('docker', ['image', 'inspect', reference], {
        encoding: 'utf8'
    });
    if (result.status !== 0)
    {
        throw new Error(`runtime image inspect failed: ${String(result.stderr ?? '').trim()}`);
    }
    const documents = JSON.parse(String(result.stdout));
    if (!Array.isArray(documents) || documents.length !== 1)
    {
        throw new Error('runtime image inspect did not return exactly one image');
    }
    return documents[0];
}

function validateImageInspection(inspection, {
    reference,
    imageDigest,
    sourceState
})
{
    assertObject(inspection, 'runtime image inspection');
    const layers = inspection.RootFS?.Layers;
    const revision = inspection.Config?.Labels?.['org.opencontainers.image.revision'];
    if (inspection.Id !== imageDigest
        || revision !== sourceState.commit
        || !Array.isArray(layers)
        || layers.length === 0
        || layers.some((layer) => !digestPattern.test(String(layer))))
    {
        throw new Error(
            'runtime image does not bind its inspected digest, source revision, and layers'
        );
    }
    return {
        reference,
        imageDigest,
        revision,
        layers: [...layers],
        layersDigest: digestValue({ layers })
    };
}

function validateLiveEvidence(live)
{
    assertExactKeys(
        live,
        [
            'method',
            'path',
            'status',
            'contentType',
            'bodyBytes',
            'reportStatus',
            'checkedAt'
        ],
        'runtime live evidence'
    );
    if (live.method !== 'GET'
        || live.path !== '/health/live'
        || live.status !== 200
        || live.contentType !== 'application/json'
        || !Number.isInteger(live.bodyBytes)
        || live.bodyBytes < 1
        || live.reportStatus !== 'live'
        || !isoTimePattern.test(live.checkedAt)
        || !Number.isFinite(Date.parse(live.checkedAt)))
    {
        throw new Error('runtime live evidence is invalid');
    }
}

function validateRouteEvidence(routes)
{
    if (!Array.isArray(routes)
        || !sameValue(routes.map((route) => route?.routeId), runtimeRouteIds))
    {
        throw new Error('runtime admission requires the exact canonical six-route sequence');
    }
    for (const route of routes)
    {
        const contract = routeContract(route.routeId);
        assertExactKeys(
            route,
            [
                'routeId',
                'method',
                'path',
                'status',
                'contentType',
                'fsusHeaders',
                'bodyBytes',
                'aeds'
            ],
            `runtime route ${contract.routeId}`
        );
        assertObject(route.fsusHeaders, `runtime route ${contract.routeId} Fsus headers`);
        if (Object.entries(route.fsusHeaders)
            .some(([header, value]) => !header.startsWith('x-fsus-')
                || typeof value !== 'string' || !value))
        {
            throw new Error(`runtime route ${contract.routeId} contains a non-Fsus header`);
        }
        assertExactKeys(
            route.aeds,
            ['version', 'headerLength', 'frameType', 'payloadLength', 'crcValidated'],
            `runtime route ${contract.routeId} AEDS evidence`
        );
        if (route.method !== contract.method
            || route.path !== contract.pathTemplate
            || route.status !== contract.expectedStatus
            || !contract.expectedContentType.includes(route.contentType)
            || route.contentType !== 'application/octet-stream'
            || route.fsusHeaders['x-fsus-frame-version'] !== '2'
            || !Number.isInteger(route.bodyBytes)
            || route.bodyBytes < contract.minimumBodyBytes
            || route.bodyBytes > contract.maximumBodyBytes
            || route.aeds.version !== 2
            || route.aeds.headerLength !== 16
            || route.aeds.frameType !== contract.expectedAedsFrameType
            || route.aeds.payloadLength !== route.bodyBytes - route.aeds.headerLength
            || route.aeds.crcValidated !== true)
        {
            throw new Error(`runtime route ${contract.routeId} evidence is invalid`);
        }
    }
}

function validateSmokeObservation(observation)
{
    assertExactKeys(
        observation,
        ['schema', 'status', 'producer', 'live', 'routes', 'contentDigest'],
        'runtime smoke observation'
    );
    if (observation.schema !== runtimeSmokeSchema
        || observation.status !== 'passed'
        || observation.contentDigest !== digestValue(observation))
    {
        throw new Error('runtime smoke observation is incomplete or digest-mismatched');
    }
    assertExactKeys(
        observation.producer,
        ['id', 'routeCatalog'],
        'runtime smoke producer'
    );
    assertExactKeys(
        observation.producer.routeCatalog,
        ['path', 'contentDigest'],
        'runtime smoke route catalog'
    );
    if (observation.producer.id !== 'runtime-load-soak'
        || observation.producer.routeCatalog.path
            !== 'config/testing/runtime-http-route-contracts.json'
        || observation.producer.routeCatalog.contentDigest !== routeCatalogDigest())
    {
        throw new Error('runtime smoke producer does not bind the canonical route catalog');
    }
    validateLiveEvidence(observation.live);
    validateRouteEvidence(observation.routes);
}

function fixtureIdentity(fixture, expected)
{
    assertObject(fixture, 'fixture authority');
    if (fixture.schema !== fixtureAuthoritySchema
        || fixture.status !== 'complete'
        || fixture.contentDigest !== digestValue(fixture)
        || fixture.runId !== expected.runId
        || fixture.namespace !== expected.namespace
        || fixture.root !== `.tmp/fixtures/${expected.namespace}`)
    {
        throw new Error('fixture authority is incomplete or identity-mismatched');
    }
    const runtime = assertObject(fixture.runtime, 'fixture runtime');
    const network = assertObject(runtime.network, 'fixture runtime network');
    const backend = assertObject(runtime.backendContainer, 'fixture backend container');
    const source = assertObject(runtime.sourceState, 'fixture runtime source');
    const image = assertObject(runtime.image, 'fixture runtime image');
    const postgresId = fixture.postgres?.instance;
    const redisId = fixture.redis?.instance;
    if (runtime.profile !== 'docker-final-image'
        || runtime.imageDigest !== expected.image.imageDigest
        || source.commit !== expected.sourceState.commit
        || normalizeFingerprint(
            source.worktreeFingerprint,
            'fixture source fingerprint'
        ) !== expected.sourceState.worktreeFingerprint
        || image.reference !== expected.image.reference
        || image.id !== expected.image.imageDigest
        || image.revision !== expected.image.revision
        || image.layersDigest !== expected.image.layersDigest
        || !sameValue(image.layers, expected.image.layers)
        || backend.image !== expected.image.imageDigest
        || backend.configuredImage !== expected.image.reference
        || !containerIdPattern.test(String(backend.id ?? ''))
        || !containerIdPattern.test(String(postgresId ?? ''))
        || !containerIdPattern.test(String(redisId ?? ''))
        || !containerIdPattern.test(String(network.id ?? ''))
        || typeof network.name !== 'string'
        || !network.name
        || network.driver !== 'bridge'
        || network.backend?.containerId !== backend.id
        || network.postgres?.containerId !== postgresId
        || network.redis?.containerId !== redisId)
    {
        throw new Error('fixture authority runtime topology binding is invalid');
    }
    return {
        identity: {
            schema: fixture.schema,
            status: fixture.status,
            runId: fixture.runId,
            namespace: fixture.namespace,
            root: normalizedRelativePath(fixture.root, 'fixture authority root')
        },
        topology: {
            profile: runtime.profile,
            backendContainerId: backend.id,
            postgresContainerId: postgresId,
            redisContainerId: redisId,
            network: {
                id: network.id,
                name: network.name,
                driver: network.driver
            }
        }
    };
}

function fileBinding(repositoryRoot, configuredPath, label)
{
    const binding = readJsonOrRegularFileBinding(repositoryRoot, configuredPath, label);
    return {
        kind: 'file',
        path: binding.relative,
        fileDigest: binding.fileDigest
    };
}

function readJsonOrRegularFileBinding(repositoryRoot, configuredPath, label)
{
    const resolved = resolveApprovedPath(repositoryRoot, configuredPath, label);
    if (!fs.existsSync(resolved.absolute))
    {
        throw new Error(`${label} is missing`);
    }
    const stat = fs.lstatSync(resolved.absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`${label} is not a regular file`);
    }
    return {
        ...resolved,
        fileDigest: digestFile(resolved.absolute)
    };
}

function collectManagedProcess(repositoryRoot, namespace, runId, role, fileName)
{
    const pidPath = `.tmp/acceptance/${namespace}/${fileName}`;
    const identityPath = pidPath.replace(/\.pid$/u, '.identity.json');
    const pidBinding = readJsonOrRegularFileBinding(
        repositoryRoot,
        pidPath,
        `${role} PID file`
    );
    const identityBinding = readJsonBinding(
        repositoryRoot,
        identityPath,
        `${role} identity file`
    );
    const pidText = fs.readFileSync(pidBinding.absolute, 'utf8').trim();
    const identity = identityBinding.document;
    if (!/^[1-9][0-9]*$/u.test(pidText)
        || identity.schema !== 'fsusblog.local-runtime-process-identity.v1'
        || identity.pid !== Number(pidText)
        || identity.processGroupId !== identity.pid
        || !/^[0-9]+$/u.test(String(identity.startTimeTicks ?? ''))
        || identity.runId !== runId
        || identity.namespace !== namespace
        || identity.role !== role)
    {
        throw new Error(`${role} managed process identity is invalid`);
    }
    return {
        process: {
            kind: 'process',
            role,
            pid: identity.pid,
            processGroupId: identity.processGroupId,
            startTimeTicks: String(identity.startTimeTicks),
            pidFile: pidBinding.relative,
            identityFile: identityBinding.relative
        },
        files: [
            {
                kind: 'file',
                path: pidBinding.relative,
                fileDigest: pidBinding.fileDigest
            },
            {
                kind: 'file',
                path: identityBinding.relative,
                fileDigest: identityBinding.fileDigest
            }
        ]
    };
}

function collectCleanupOwnership(repositoryRoot, {
    namespace,
    runId,
    topology
})
{
    const managed = [
        collectManagedProcess(repositoryRoot, namespace, runId, 'backend', 'backend.pid'),
        collectManagedProcess(
            repositoryRoot,
            namespace,
            runId,
            'debug-frontend',
            'dev-server.pid'
        ),
        collectManagedProcess(
            repositoryRoot,
            namespace,
            runId,
            'release-preview',
            'preview.pid'
        )
    ];
    return {
        owner: 'CleanupQualifiedRuntimeResources',
        status: 'pending',
        resources: {
            containers: [
                {
                    kind: 'container',
                    role: 'backend',
                    id: topology.backendContainerId
                },
                {
                    kind: 'container',
                    role: 'postgres',
                    id: topology.postgresContainerId
                },
                {
                    kind: 'container',
                    role: 'redis',
                    id: topology.redisContainerId
                }
            ],
            network: {
                kind: 'network',
                id: topology.network.id,
                name: topology.network.name
            },
            processes: managed.map((record) => record.process),
            files: [
                ...managed.flatMap((record) => record.files),
                fileBinding(
                    repositoryRoot,
                    `.tmp/env/${namespace}.${runId}.container.env`,
                    'container environment projection'
                )
            ]
        }
    };
}

function validateCleanup(cleanup, {
    namespace,
    runId,
    topology,
    expectedStatus
})
{
    assertExactKeys(cleanup, ['owner', 'status', 'resources'], 'runtime cleanup');
    if (cleanup.owner !== 'CleanupQualifiedRuntimeResources'
        || cleanup.status !== expectedStatus)
    {
        throw new Error('runtime cleanup owner or status is invalid');
    }
    assertExactKeys(
        cleanup.resources,
        ['containers', 'network', 'processes', 'files'],
        'runtime cleanup resources'
    );
    const expectedContainers = [
        ['backend', topology.backendContainerId],
        ['postgres', topology.postgresContainerId],
        ['redis', topology.redisContainerId]
    ];
    if (!Array.isArray(cleanup.resources.containers)
        || cleanup.resources.containers.length !== expectedContainers.length)
    {
        throw new Error('runtime cleanup container identities are incomplete');
    }
    cleanup.resources.containers.forEach((container, index) =>
    {
        assertExactKeys(container, ['kind', 'role', 'id'], 'cleanup container');
        if (container.kind !== 'container'
            || container.role !== expectedContainers[index][0]
            || container.id !== expectedContainers[index][1])
        {
            throw new Error('runtime cleanup container identity mismatch');
        }
    });
    assertExactKeys(
        cleanup.resources.network,
        ['kind', 'id', 'name'],
        'cleanup network'
    );
    if (cleanup.resources.network.kind !== 'network'
        || cleanup.resources.network.id !== topology.network.id
        || cleanup.resources.network.name !== topology.network.name)
    {
        throw new Error('runtime cleanup network identity mismatch');
    }
    const expectedProcesses = [
        ['backend', 'backend.pid'],
        ['debug-frontend', 'dev-server.pid'],
        ['release-preview', 'preview.pid']
    ];
    if (!Array.isArray(cleanup.resources.processes)
        || cleanup.resources.processes.length !== expectedProcesses.length)
    {
        throw new Error('runtime cleanup process identities are incomplete');
    }
    cleanup.resources.processes.forEach((managed, index) =>
    {
        assertExactKeys(
            managed,
            [
                'kind',
                'role',
                'pid',
                'processGroupId',
                'startTimeTicks',
                'pidFile',
                'identityFile'
            ],
            'cleanup process'
        );
        const [role, pidName] = expectedProcesses[index];
        const pidFile = `.tmp/acceptance/${namespace}/${pidName}`;
        if (managed.kind !== 'process'
            || managed.role !== role
            || !Number.isInteger(managed.pid)
            || managed.pid < 2
            || managed.processGroupId !== managed.pid
            || !/^[0-9]+$/u.test(managed.startTimeTicks)
            || managed.pidFile !== pidFile
            || managed.identityFile !== pidFile.replace(/\.pid$/u, '.identity.json'))
        {
            throw new Error('runtime cleanup process identity mismatch');
        }
    });
    const expectedFiles = [
        ...expectedProcesses.flatMap(([, pidName]) =>
        {
            const pidFile = `.tmp/acceptance/${namespace}/${pidName}`;
            return [pidFile, pidFile.replace(/\.pid$/u, '.identity.json')];
        }),
        `.tmp/env/${namespace}.${runId}.container.env`
    ];
    if (!Array.isArray(cleanup.resources.files)
        || cleanup.resources.files.length !== expectedFiles.length)
    {
        throw new Error('runtime cleanup file identities are incomplete');
    }
    cleanup.resources.files.forEach((file, index) =>
    {
        assertExactKeys(file, ['kind', 'path', 'fileDigest'], 'cleanup file');
        if (file.kind !== 'file'
            || file.path !== expectedFiles[index]
            || !digestPattern.test(file.fileDigest))
        {
            throw new Error('runtime cleanup file identity mismatch');
        }
    });
}

function validateSource(source)
{
    assertExactKeys(source, ['commit', 'worktreeFingerprint'], 'runtime source');
    if (!commitPattern.test(source.commit)
        || !digestPattern.test(source.worktreeFingerprint))
    {
        throw new Error('runtime source identity is invalid');
    }
}

function validateBuild(build, source, runId)
{
    assertExactKeys(build, ['receipt', 'image'], 'runtime build');
    assertExactKeys(
        build.receipt,
        ['path', 'fileDigest', 'contentDigest', 'producer'],
        'runtime build receipt binding'
    );
    assertExactKeys(
        build.receipt.producer,
        ['workflow', 'runId', 'runAttempt', 'job'],
        'runtime build producer binding'
    );
    if (build.receipt.path !== expectedBuildReceiptPath(runId)
        || !digestPattern.test(build.receipt.fileDigest)
        || !digestPattern.test(build.receipt.contentDigest)
        || build.receipt.producer.runId !== runId
        || build.receipt.producer.runAttempt !== 1
        || build.receipt.producer.job !== 'production-build-artifacts'
        || typeof build.receipt.producer.workflow !== 'string'
        || !build.receipt.producer.workflow.trim())
    {
        throw new Error('runtime build receipt binding is invalid');
    }
    assertExactKeys(
        build.image,
        ['reference', 'imageDigest', 'revision', 'layers', 'layersDigest'],
        'runtime image binding'
    );
    if (typeof build.image.reference !== 'string'
        || !build.image.reference.trim()
        || !digestPattern.test(build.image.imageDigest)
        || build.image.revision !== source.commit
        || !Array.isArray(build.image.layers)
        || build.image.layers.length === 0
        || build.image.layers.some((layer) => !digestPattern.test(layer))
        || build.image.layersDigest !== digestValue({ layers: build.image.layers }))
    {
        throw new Error('runtime image binding is invalid');
    }
}

function validateFixture(fixture, runId, namespace)
{
    assertExactKeys(
        fixture,
        ['path', 'fileDigest', 'contentDigest', 'identity'],
        'runtime fixture binding'
    );
    assertExactKeys(
        fixture.identity,
        ['schema', 'status', 'runId', 'namespace', 'root'],
        'runtime fixture identity'
    );
    if (fixture.path !== expectedFixturePath(runId)
        || !digestPattern.test(fixture.fileDigest)
        || !digestPattern.test(fixture.contentDigest)
        || fixture.identity.schema !== fixtureAuthoritySchema
        || fixture.identity.status !== 'complete'
        || fixture.identity.runId !== runId
        || fixture.identity.namespace !== namespace
        || fixture.identity.root !== `.tmp/fixtures/${namespace}`)
    {
        throw new Error('runtime fixture binding is invalid');
    }
}

function validateTopology(topology)
{
    assertExactKeys(
        topology,
        [
            'profile',
            'backendContainerId',
            'postgresContainerId',
            'redisContainerId',
            'network'
        ],
        'runtime topology'
    );
    assertExactKeys(topology.network, ['id', 'name', 'driver'], 'runtime topology network');
    if (topology.profile !== 'docker-final-image'
        || !containerIdPattern.test(topology.backendContainerId)
        || !containerIdPattern.test(topology.postgresContainerId)
        || !containerIdPattern.test(topology.redisContainerId)
        || !containerIdPattern.test(topology.network.id)
        || typeof topology.network.name !== 'string'
        || !topology.network.name
        || topology.network.driver !== 'bridge')
    {
        throw new Error('runtime topology is invalid');
    }
}

function validateAdmission(admission, invocationId)
{
    assertExactKeys(
        admission,
        ['deadline', 'producerId', 'routeCatalog', 'observation', 'live', 'routes'],
        'runtime admission evidence'
    );
    assertExactKeys(
        admission.deadline,
        ['seconds', 'attemptCount', 'elapsedSeconds'],
        'runtime admission deadline'
    );
    if (admission.deadline.seconds !== 60
        || !Number.isInteger(admission.deadline.attemptCount)
        || admission.deadline.attemptCount < 1
        || !Number.isInteger(admission.deadline.elapsedSeconds)
        || admission.deadline.elapsedSeconds < 0
        || admission.deadline.elapsedSeconds > admission.deadline.seconds
        || admission.producerId !== 'runtime-load-soak')
    {
        throw new Error('runtime admission deadline or producer is invalid');
    }
    assertExactKeys(
        admission.routeCatalog,
        ['path', 'contentDigest'],
        'runtime admission route catalog'
    );
    if (admission.routeCatalog.path
        !== 'config/testing/runtime-http-route-contracts.json'
        || admission.routeCatalog.contentDigest !== routeCatalogDigest())
    {
        throw new Error('runtime admission route catalog binding is invalid');
    }
    assertExactKeys(
        admission.observation,
        ['path', 'fileDigest', 'contentDigest'],
        'runtime admission observation binding'
    );
    if (admission.observation.path !== expectedSmokePath(invocationId)
        || !digestPattern.test(admission.observation.fileDigest)
        || !digestPattern.test(admission.observation.contentDigest))
    {
        throw new Error('runtime admission observation binding is invalid');
    }
    validateLiveEvidence(admission.live);
    validateRouteEvidence(admission.routes);
}

function validateCandidateDocument(candidate)
{
    assertExactKeys(
        candidate,
        [
            'schema',
            'artifactKind',
            'status',
            'qualificationEligible',
            'invocationId',
            'runId',
            'namespace',
            'source',
            'build',
            'fixture',
            'topology',
            'admission',
            'cleanup',
            'createdAt',
            'contentDigest'
        ],
        'runtime admission candidate'
    );
    if (candidate.schema !== releaseReliabilityRuntimeAdmissionSchema
        || candidate.artifactKind !== 'candidate'
        || candidate.status !== 'candidate'
        || candidate.qualificationEligible !== false
        || !identifierPattern.test(candidate.invocationId)
        || !identifierPattern.test(candidate.runId)
        || !identifierPattern.test(candidate.namespace)
        || !isoTimePattern.test(candidate.createdAt)
        || !Number.isFinite(Date.parse(candidate.createdAt))
        || candidate.contentDigest !== digestValue(candidate))
    {
        throw new Error('runtime admission candidate envelope is invalid');
    }
    validateSource(candidate.source);
    validateBuild(candidate.build, candidate.source, candidate.runId);
    validateFixture(candidate.fixture, candidate.runId, candidate.namespace);
    validateTopology(candidate.topology);
    validateAdmission(candidate.admission, candidate.invocationId);
    validateCleanup(candidate.cleanup, {
        namespace: candidate.namespace,
        runId: candidate.runId,
        topology: candidate.topology,
        expectedStatus: 'pending'
    });
}

function verifyBoundEvidence(repositoryRoot, candidate)
{
    const build = readJsonBinding(
        repositoryRoot,
        candidate.build.receipt.path,
        'bound production build receipt'
    );
    if (build.fileDigest !== candidate.build.receipt.fileDigest)
    {
        throw new Error('bound production build receipt file digest mismatch');
    }
    validateBuildReceipt(build.document, {
        sourceState: candidate.source,
        runId: candidate.runId,
        expectedContentDigest: candidate.build.receipt.contentDigest
    });
    if (!sameValue(build.document.producer, candidate.build.receipt.producer))
    {
        throw new Error('bound production build producer mismatch');
    }
    const fixture = readJsonBinding(
        repositoryRoot,
        candidate.fixture.path,
        'bound fixture authority'
    );
    if (fixture.fileDigest !== candidate.fixture.fileDigest
        || fixture.document.contentDigest !== candidate.fixture.contentDigest)
    {
        throw new Error('bound fixture authority digest mismatch');
    }
    const fixtureAuthority = fixtureIdentity(fixture.document, {
        runId: candidate.runId,
        namespace: candidate.namespace,
        sourceState: candidate.source,
        image: candidate.build.image
    });
    if (!sameValue(fixtureAuthority.identity, candidate.fixture.identity)
        || !sameValue(fixtureAuthority.topology, candidate.topology))
    {
        throw new Error('bound fixture topology mismatch');
    }
    const smoke = readJsonBinding(
        repositoryRoot,
        candidate.admission.observation.path,
        'bound runtime smoke observation'
    );
    if (smoke.fileDigest !== candidate.admission.observation.fileDigest
        || smoke.document.contentDigest !== candidate.admission.observation.contentDigest)
    {
        throw new Error('bound runtime smoke observation digest mismatch');
    }
    validateSmokeObservation(smoke.document);
    if (smoke.document.producer.id !== candidate.admission.producerId
        || !sameValue(
            smoke.document.producer.routeCatalog,
            candidate.admission.routeCatalog
        )
        || !sameValue(smoke.document.live, candidate.admission.live)
        || !sameValue(smoke.document.routes, candidate.admission.routes))
    {
        throw new Error('bound runtime smoke evidence mismatch');
    }
}

export function verifyRuntimeAdmissionCandidate({
    repositoryRoot = defaultRoot,
    candidatePath
})
{
    const root = path.resolve(repositoryRoot);
    const candidate = readJsonBinding(root, candidatePath, 'runtime admission candidate');
    validateCandidateDocument(candidate.document);
    if (candidate.relative !== expectedCandidatePath(candidate.document.invocationId))
    {
        throw new Error('runtime admission candidate path is not canonical');
    }
    verifyBoundEvidence(root, candidate.document);
    return candidate.document;
}

export function createRuntimeAdmissionCandidate({
    repositoryRoot = defaultRoot,
    candidatePath,
    sourceCommit,
    sourceFingerprint,
    buildReceiptPath,
    buildReceiptContentDigest,
    imageReference,
    imageDigest,
    runId,
    namespace,
    invocationId,
    fixtureAuthorityPath,
    smokeObservationPath,
    deadlineSeconds,
    attemptCount,
    elapsedSeconds,
    cleanupOwnership = null,
    createdAt = new Date().toISOString()
}, {
    inspectImage = inspectRuntimeImage,
    collectCleanup = collectCleanupOwnership
} = {})
{
    const root = path.resolve(repositoryRoot);
    const sourceState = {
        commit: String(sourceCommit ?? '').trim(),
        worktreeFingerprint: normalizeFingerprint(
            sourceFingerprint,
            'runtime source fingerprint'
        )
    };
    validateSource(sourceState);
    if (!identifierPattern.test(String(runId ?? ''))
        || !identifierPattern.test(String(namespace ?? ''))
        || !identifierPattern.test(String(invocationId ?? '')))
    {
        throw new Error('runtime admission identifiers are invalid');
    }
    if (normalizedRelativePath(candidatePath, 'runtime admission candidate')
        !== expectedCandidatePath(invocationId)
        || normalizedRelativePath(buildReceiptPath, 'production build receipt')
            !== expectedBuildReceiptPath(runId)
        || normalizedRelativePath(fixtureAuthorityPath, 'fixture authority')
            !== expectedFixturePath(runId)
        || normalizedRelativePath(smokeObservationPath, 'runtime smoke observation')
            !== expectedSmokePath(invocationId))
    {
        throw new Error('runtime admission input path is not canonical');
    }
    if (!digestPattern.test(String(buildReceiptContentDigest ?? ''))
        || !digestPattern.test(String(imageDigest ?? '')))
    {
        throw new Error('runtime admission build or image digest is invalid');
    }
    const build = readJsonBinding(root, buildReceiptPath, 'production build receipt');
    validateBuildReceipt(build.document, {
        sourceState,
        runId,
        expectedContentDigest: buildReceiptContentDigest
    });
    const image = validateImageInspection(inspectImage(imageReference), {
        reference: imageReference,
        imageDigest,
        sourceState
    });
    const fixture = readJsonBinding(root, fixtureAuthorityPath, 'fixture authority');
    const fixtureAuthority = fixtureIdentity(fixture.document, {
        runId,
        namespace,
        sourceState,
        image
    });
    const topology = fixtureAuthority.topology;
    const smoke = readJsonBinding(root, smokeObservationPath, 'runtime smoke observation');
    validateSmokeObservation(smoke.document);
    const deadline = {
        seconds: Number(deadlineSeconds),
        attemptCount: Number(attemptCount),
        elapsedSeconds: Number(elapsedSeconds)
    };
    const cleanup = cleanupOwnership ?? collectCleanup(root, {
        namespace,
        runId,
        topology
    });
    const candidate = seal({
        schema: releaseReliabilityRuntimeAdmissionSchema,
        artifactKind: 'candidate',
        status: 'candidate',
        qualificationEligible: false,
        invocationId,
        runId,
        namespace,
        source: sourceState,
        build: {
            receipt: {
                path: build.relative,
                fileDigest: build.fileDigest,
                contentDigest: build.document.contentDigest,
                producer: build.document.producer
            },
            image
        },
        fixture: {
            path: fixture.relative,
            fileDigest: fixture.fileDigest,
            contentDigest: fixture.document.contentDigest,
            identity: fixtureAuthority.identity
        },
        topology,
        admission: {
            deadline,
            producerId: smoke.document.producer.id,
            routeCatalog: smoke.document.producer.routeCatalog,
            observation: {
                path: smoke.relative,
                fileDigest: smoke.fileDigest,
                contentDigest: smoke.document.contentDigest
            },
            live: smoke.document.live,
            routes: smoke.document.routes
        },
        cleanup,
        createdAt,
        contentDigest: null
    });
    validateCandidateDocument(candidate);
    writeJsonAtomic(root, candidatePath, candidate, 'runtime admission candidate');
    return verifyRuntimeAdmissionCandidate({
        repositoryRoot: root,
        candidatePath
    });
}

function readProcessStartTimeTicks(pid)
{
    try
    {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        return close < 0
            ? null
            : stat.slice(close + 2).trim().split(/\s+/u)[19] ?? null;
    }
    catch (error)
    {
        if (error?.code === 'ENOENT')
        {
            return null;
        }
        throw error;
    }
}

function runtimeResourceExists(repositoryRoot, resource)
{
    if (resource.kind === 'container')
    {
        return dockerResourceExists(['inspect', resource.id]);
    }
    if (resource.kind === 'network')
    {
        return dockerResourceExists(['network', 'inspect', resource.id]);
    }
    if (resource.kind === 'process')
    {
        if (readProcessStartTimeTicks(resource.pid) === resource.startTimeTicks)
        {
            return true;
        }
        try
        {
            process.kill(-resource.processGroupId, 0);
            return true;
        }
        catch (error)
        {
            if (error?.code === 'ESRCH')
            {
                return false;
            }
            if (error?.code === 'EPERM')
            {
                return true;
            }
            throw error;
        }
    }
    if (resource.kind === 'file')
    {
        const file = resolveApprovedPath(
            repositoryRoot,
            resource.path,
            'cleanup file'
        ).absolute;
        try
        {
            fs.lstatSync(file);
            return true;
        }
        catch (error)
        {
            if (error?.code === 'ENOENT')
            {
                return false;
            }
            throw error;
        }
    }
    throw new Error(`unknown runtime cleanup resource kind: ${resource.kind}`);
}

function dockerResourceExists(inspectArguments)
{
    const inspected = spawnSync('docker', inspectArguments, {
        encoding: 'utf8'
    });
    if (inspected.error)
    {
        throw inspected.error;
    }
    if (inspected.status === 0)
    {
        return true;
    }
    const daemon = spawnSync('docker', ['info', '--format', '{{.ID}}'], {
        encoding: 'utf8'
    });
    if (daemon.error || daemon.status !== 0 || !String(daemon.stdout ?? '').trim())
    {
        throw new Error('Docker authority is unavailable while verifying runtime cleanup');
    }
    return false;
}

function assertCleanupComplete(repositoryRoot, cleanup, resourceExists)
{
    const resources = [
        ...cleanup.resources.containers,
        cleanup.resources.network,
        ...cleanup.resources.processes,
        ...cleanup.resources.files
    ];
    const remaining = resources.filter(
        (resource) => resourceExists(repositoryRoot, resource)
    );
    if (remaining.length > 0)
    {
        throw new Error(
            `runtime cleanup left owned resources: ${remaining
                .map((resource) => resource.role ?? resource.name ?? resource.path)
                .join(', ')}`
        );
    }
}

function validateReceiptDocument(receipt)
{
    assertExactKeys(
        receipt,
        [
            'schema',
            'artifactKind',
            'status',
            'qualificationEligible',
            'invocationId',
            'runId',
            'namespace',
            'source',
            'build',
            'fixture',
            'topology',
            'admission',
            'cleanup',
            'candidate',
            'createdAt',
            'finalizedAt',
            'contentDigest'
        ],
        'runtime admission receipt'
    );
    if (receipt.schema !== releaseReliabilityRuntimeAdmissionSchema
        || receipt.artifactKind !== 'receipt'
        || receipt.status !== 'passed'
        || receipt.qualificationEligible !== false
        || !identifierPattern.test(receipt.invocationId)
        || !identifierPattern.test(receipt.runId)
        || !identifierPattern.test(receipt.namespace)
        || !isoTimePattern.test(receipt.createdAt)
        || !isoTimePattern.test(receipt.finalizedAt)
        || !Number.isFinite(Date.parse(receipt.createdAt))
        || !Number.isFinite(Date.parse(receipt.finalizedAt))
        || Date.parse(receipt.finalizedAt) < Date.parse(receipt.createdAt)
        || receipt.contentDigest !== digestValue(receipt))
    {
        throw new Error('runtime admission receipt envelope is invalid');
    }
    validateSource(receipt.source);
    validateBuild(receipt.build, receipt.source, receipt.runId);
    validateFixture(receipt.fixture, receipt.runId, receipt.namespace);
    validateTopology(receipt.topology);
    validateAdmission(receipt.admission, receipt.invocationId);
    validateCleanup(receipt.cleanup, {
        namespace: receipt.namespace,
        runId: receipt.runId,
        topology: receipt.topology,
        expectedStatus: 'complete'
    });
    assertExactKeys(
        receipt.candidate,
        ['path', 'fileDigest', 'contentDigest'],
        'runtime admission candidate binding'
    );
    if (receipt.candidate.path !== expectedCandidatePath(receipt.invocationId)
        || !digestPattern.test(receipt.candidate.fileDigest)
        || !digestPattern.test(receipt.candidate.contentDigest))
    {
        throw new Error('runtime admission candidate binding is invalid');
    }
}

export function verifyRuntimeAdmissionReceipt({
    repositoryRoot = defaultRoot,
    receiptPath
}, {
    resourceExists = runtimeResourceExists
} = {})
{
    const root = path.resolve(repositoryRoot);
    const receipt = readJsonBinding(root, receiptPath, 'runtime admission receipt');
    validateReceiptDocument(receipt.document);
    if (receipt.relative !== expectedReceiptPath(receipt.document.invocationId))
    {
        throw new Error('runtime admission receipt path is not canonical');
    }
    const candidateBinding = readJsonBinding(
        root,
        receipt.document.candidate.path,
        'bound runtime admission candidate'
    );
    validateCandidateDocument(candidateBinding.document);
    verifyBoundEvidence(root, candidateBinding.document);
    if (candidateBinding.fileDigest !== receipt.document.candidate.fileDigest
        || candidateBinding.document.contentDigest
            !== receipt.document.candidate.contentDigest)
    {
        throw new Error('runtime admission candidate-final binding mismatch');
    }
    const candidate = candidateBinding.document;
    for (const field of [
        'invocationId',
        'runId',
        'namespace',
        'source',
        'build',
        'fixture',
        'topology',
        'admission',
        'createdAt'
    ])
    {
        if (!sameValue(receipt.document[field], candidate[field]))
        {
            throw new Error(`runtime admission candidate-final ${field} mismatch`);
        }
    }
    if (!sameValue(
        receipt.document.cleanup.resources,
        candidate.cleanup.resources
    )
        || receipt.document.cleanup.owner !== candidate.cleanup.owner)
    {
        throw new Error('runtime admission candidate-final cleanup mismatch');
    }
    assertCleanupComplete(root, receipt.document.cleanup, resourceExists);
    return receipt.document;
}

export function finalizeRuntimeAdmissionReceipt({
    repositoryRoot = defaultRoot,
    candidatePath,
    receiptPath,
    finalizedAt = new Date().toISOString()
}, {
    resourceExists = runtimeResourceExists
} = {})
{
    const root = path.resolve(repositoryRoot);
    const candidate = verifyRuntimeAdmissionCandidate({
        repositoryRoot: root,
        candidatePath
    });
    if (normalizedRelativePath(receiptPath, 'runtime admission receipt')
        !== expectedReceiptPath(candidate.invocationId))
    {
        throw new Error('runtime admission receipt path is not canonical');
    }
    assertCleanupComplete(root, candidate.cleanup, resourceExists);
    const candidateBinding = readJsonBinding(
        root,
        candidatePath,
        'runtime admission candidate'
    );
    const receipt = seal({
        schema: releaseReliabilityRuntimeAdmissionSchema,
        artifactKind: 'receipt',
        status: 'passed',
        qualificationEligible: false,
        invocationId: candidate.invocationId,
        runId: candidate.runId,
        namespace: candidate.namespace,
        source: candidate.source,
        build: candidate.build,
        fixture: candidate.fixture,
        topology: candidate.topology,
        admission: candidate.admission,
        cleanup: {
            ...candidate.cleanup,
            status: 'complete'
        },
        candidate: {
            path: candidateBinding.relative,
            fileDigest: candidateBinding.fileDigest,
            contentDigest: candidate.contentDigest
        },
        createdAt: candidate.createdAt,
        finalizedAt,
        contentDigest: null
    });
    validateReceiptDocument(receipt);
    const written = writeJsonAtomic(
        root,
        receiptPath,
        receipt,
        'runtime admission receipt'
    );
    try
    {
        return verifyRuntimeAdmissionReceipt({
            repositoryRoot: root,
            receiptPath
        }, {
            resourceExists
        });
    }
    catch (error)
    {
        fs.rmSync(written.absolute, { force: true });
        if (fs.existsSync(written.absolute))
        {
            throw new Error(
                `runtime admission receipt verification failed and the pass receipt could not be removed: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
        throw error;
    }
}

function parseArguments(argumentsList)
{
    const operation = argumentsList.shift();
    const allowed = {
        create: [
            'root',
            'candidate',
            'source-commit',
            'source-fingerprint',
            'build-receipt',
            'build-receipt-digest',
            'image-reference',
            'image-digest',
            'run-id',
            'namespace',
            'invocation-id',
            'fixture-authority',
            'smoke-observation',
            'deadline-seconds',
            'attempt-count',
            'elapsed-seconds'
        ],
        finalize: ['root', 'candidate', 'receipt'],
        'verify-candidate': ['root', 'candidate'],
        verify: ['root', 'receipt']
    }[operation];
    if (!allowed)
    {
        throw new Error('operation must be create, finalize, verify-candidate, or verify');
    }
    const values = {};
    while (argumentsList.length > 0)
    {
        const name = argumentsList.shift();
        const value = argumentsList.shift();
        if (!name?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        const key = name.slice(2);
        if (!allowed.includes(key))
        {
            throw new Error(`unknown argument --${key}`);
        }
        if (Object.hasOwn(values, key))
        {
            throw new Error(`duplicate argument --${key}`);
        }
        values[key] = value;
    }
    for (const key of allowed)
    {
        if (!values[key])
        {
            throw new Error(`--${key} is required`);
        }
    }
    return { operation, values };
}

function main()
{
    const { operation, values } = parseArguments(process.argv.slice(2));
    if (operation === 'create')
    {
        const candidate = createRuntimeAdmissionCandidate({
            repositoryRoot: values.root,
            candidatePath: values.candidate,
            sourceCommit: values['source-commit'],
            sourceFingerprint: values['source-fingerprint'],
            buildReceiptPath: values['build-receipt'],
            buildReceiptContentDigest: values['build-receipt-digest'],
            imageReference: values['image-reference'],
            imageDigest: values['image-digest'],
            runId: values['run-id'],
            namespace: values.namespace,
            invocationId: values['invocation-id'],
            fixtureAuthorityPath: values['fixture-authority'],
            smokeObservationPath: values['smoke-observation'],
            deadlineSeconds: values['deadline-seconds'],
            attemptCount: values['attempt-count'],
            elapsedSeconds: values['elapsed-seconds']
        });
        process.stdout.write(`${candidate.contentDigest}\n`);
        return;
    }
    if (operation === 'finalize')
    {
        const receipt = finalizeRuntimeAdmissionReceipt({
            repositoryRoot: values.root,
            candidatePath: values.candidate,
            receiptPath: values.receipt
        });
        process.stdout.write(`${receipt.contentDigest}\n`);
        return;
    }
    if (operation === 'verify-candidate')
    {
        const candidate = verifyRuntimeAdmissionCandidate({
            repositoryRoot: values.root,
            candidatePath: values.candidate
        });
        process.stdout.write(`${candidate.contentDigest}\n`);
        return;
    }
    const receipt = verifyRuntimeAdmissionReceipt({
        repositoryRoot: values.root,
        receiptPath: values.receipt
    });
    process.stdout.write(`${receipt.contentDigest}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main();
    }
    catch (error)
    {
        console.error(
            `[release-reliability-runtime-admission] ${
                error instanceof Error ? error.message : String(error)
            }`
        );
        process.exitCode = 1;
    }
}
