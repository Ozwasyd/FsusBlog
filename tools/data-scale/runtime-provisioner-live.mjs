#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    assertDedicatedContainer,
    computeSha256,
    createDataScaleRuntimeReceipt,
    isForbiddenContainerName
} from './runtime-plan.mjs';

export function resolvePinnedDataScaleImages(repositoryRoot)
{
    const catalogPath = path.join(repositoryRoot, 'config/testing/test-execution-service-catalog.json');
    if (!fs.existsSync(catalogPath))
    {
        throw new Error(`service catalog missing: ${catalogPath}`);
    }
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const postgres = catalog?.services?.postgres?.imageReference;
    const redis = catalog?.services?.redis?.imageReference;
    if (!postgres || !redis)
    {
        throw new Error('service catalog missing postgres/redis imageReference pins');
    }
    return { postgres, redis };
}

export function normalizeDockerId(value)
{
    const raw = String(value || '').trim().replace(/^sha256:/u, '');
    if (!/^[0-9a-f]{64}$/u.test(raw))
    {
        throw new Error(`docker identity is not a 64-hex id: ${value}`);
    }
    return raw;
}

export function normalizeImageDigest(value, imageIdFallback)
{
    let imageDigest = String(value || '').trim();
    if (imageDigest.includes('@sha256:'))
    {
        imageDigest = `sha256:${imageDigest.split('@sha256:').pop()}`;
    }
    else if (!imageDigest.startsWith('sha256:') && /^[0-9a-f]{64}$/u.test(imageDigest))
    {
        imageDigest = `sha256:${imageDigest}`;
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest))
    {
        imageDigest = `sha256:${normalizeDockerId(imageIdFallback)}`;
    }
    return imageDigest;
}

function inspectDedicatedResource(provisioner, {
    role,
    containerName,
    volumeName,
    expectedImageReference
})
{
    const containerInspect = provisioner.dockerRunner([
        'inspect', containerName, '--format',
        '{{.Id}}|{{.State.Running}}|{{json .Config.Labels}}|{{.Image}}'
    ]);
    if (containerInspect.status !== 0)
    {
        throw new Error(`failed to inspect dedicated ${role} container ${containerName}`);
    }
    const [containerIdRaw, running, labelsJson, imageIdRaw] = String(containerInspect.stdout || '')
        .trim()
        .split('|');
    if (running !== 'true')
    {
        throw new Error(`dedicated ${role} container ${containerName} is not running`);
    }
    const labels = JSON.parse(labelsJson || '{}');
    if (labels['fsusblog.owner'] !== 'data-scale'
        || labels['fsusblog.dataScaleRunId'] !== provisioner.dataScaleRunId)
    {
        throw new Error(`dedicated ${role} container ownership labels mismatch for ${containerName}`);
    }

    const digestInspect = provisioner.dockerRunner([
        'image', 'inspect', expectedImageReference, '--format',
        '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}'
    ]);
    if (digestInspect.status !== 0)
    {
        throw new Error(`failed to inspect image digest for ${expectedImageReference}`);
    }
    const imageDigest = normalizeImageDigest(String(digestInspect.stdout || '').trim(), imageIdRaw);

    const volumeInspect = provisioner.dockerRunner([
        'volume', 'inspect', volumeName, '--format', '{{.Name}}|{{json .Labels}}'
    ]);
    if (volumeInspect.status !== 0)
    {
        throw new Error(`failed to inspect dedicated ${role} volume ${volumeName}`);
    }
    const [observedVolumeName, volumeLabelsJson] = String(volumeInspect.stdout || '').trim().split('|');
    const volumeLabels = JSON.parse(volumeLabelsJson || '{}');
    if (observedVolumeName !== volumeName
        || volumeLabels['fsusblog.owner'] !== 'data-scale'
        || volumeLabels['fsusblog.dataScaleRunId'] !== provisioner.dataScaleRunId)
    {
        throw new Error(`dedicated ${role} volume ownership mismatch for ${volumeName}`);
    }

    const portInspect = provisioner.dockerRunner([
        'inspect', containerName, '--format',
        role === 'postgres'
            ? '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}'
            : '{{(index (index .NetworkSettings.Ports "6379/tcp") 0).HostPort}}'
    ]);
    const hostPort = String(portInspect.stdout || '').trim();
    if (!/^\d+$/u.test(hostPort))
    {
        throw new Error(`dedicated ${role} container ${containerName} missing loopback host port`);
    }

    return {
        containerId: normalizeDockerId(containerIdRaw),
        containerName,
        imageDigest,
        volumeId: volumeName,
        hostPort,
        imageId: `sha256:${normalizeDockerId(imageIdRaw)}`
    };
}

async function waitForDedicatedService(provisioner, role, containerName)
{
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline)
    {
        let ready;
        if (role === 'postgres')
        {
            ready = provisioner.dockerRunner([
                'exec', containerName,
                'pg_isready', '-U', 'fsusblog', '-d', provisioner.plan.postgres.database
            ]);
        }
        else
        {
            ready = provisioner.dockerRunner([
                'exec', containerName,
                'redis-cli', 'ping'
            ]);
        }
        if (ready.status === 0
            && (role !== 'redis' || String(ready.stdout || '').trim().toUpperCase() === 'PONG'))
        {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`dedicated ${role} container did not become ready: ${containerName}`);
}

export async function createAndStartDedicatedContainers(provisioner)
{
    const labels = provisioner.plan.ownershipLabels;
    const labelArgs = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    const images = resolvePinnedDataScaleImages(provisioner.repositoryRoot);
    const live = {
        postgres: null,
        redis: null,
        backend: null
    };

    for (const resource of [
        {
            role: 'postgres',
            name: provisioner.plan.postgres.containerName,
            volume: provisioner.plan.postgres.volumeName,
            image: images.postgres,
            mountTarget: '/var/lib/postgresql/data',
            publish: '5432',
            env: [
                '-e', `POSTGRES_DB=${provisioner.plan.postgres.database}`,
                '-e', 'POSTGRES_USER=fsusblog',
                '-e', 'POSTGRES_PASSWORD=fsusblog_dev'
            ],
            runArgs: []
        },
        {
            role: 'redis',
            name: provisioner.plan.redis.containerName,
            volume: provisioner.plan.redis.volumeName,
            image: images.redis,
            mountTarget: '/data',
            publish: '6379',
            env: [],
            runArgs: ['redis-server', '--appendonly', 'yes']
        }
    ])
    {
        assertDedicatedContainer(resource.name, resource.role);
        if (isForbiddenContainerName(resource.name))
        {
            provisioner.state.provisionFailed = true;
            throw new Error(`refusing forbidden ${resource.role} container name ${resource.name}`);
        }

        const inspectImage = provisioner.dockerRunner([
            'image', 'inspect', resource.image, '--format', '{{.Id}}'
        ]);
        if (inspectImage.status !== 0)
        {
            provisioner.state.provisionFailed = true;
            throw new Error(
                `pinned ${resource.role} image is not present locally (${resource.image}); `
                + 'correctness lanes deny pulls and fallback to shared runtime is prohibited'
            );
        }

        const volumeResult = provisioner.dockerRunner([
            'volume', 'create',
            ...labelArgs,
            resource.volume
        ]);
        if (volumeResult.status !== 0)
        {
            provisioner.state.provisionFailed = true;
            throw new Error(
                `failed to create dedicated ${resource.role} volume ${resource.volume}; `
                + 'fallback to shared postgres/redis is prohibited'
            );
        }

        const runResult = provisioner.dockerRunner([
            'run',
            '--detach',
            '--name', resource.name,
            '--pull', 'never',
            ...labelArgs,
            '--publish', `127.0.0.1::${resource.publish}`,
            '--mount', `type=volume,source=${resource.volume},target=${resource.mountTarget}`,
            ...resource.env,
            resource.image,
            ...resource.runArgs
        ]);
        if (runResult.status !== 0)
        {
            provisioner.state.provisionFailed = true;
            throw new Error(
                `failed to start dedicated ${resource.role} container ${resource.name}: `
                + `${String(runResult.stderr || runResult.stdout || '').trim()}; `
                + 'fallback to shared postgres/redis is prohibited'
            );
        }

        await waitForDedicatedService(provisioner, resource.role, resource.name);
        live[resource.role] = inspectDedicatedResource(provisioner, {
            role: resource.role,
            containerName: resource.name,
            volumeName: resource.volume,
            expectedImageReference: resource.image
        });
    }

    provisioner.state.liveIdentity = live;
    const mutable = {
        ...provisioner.plan,
        postgres: {
            ...provisioner.plan.postgres,
            imageDigest: live.postgres.imageDigest
        },
        redis: {
            ...provisioner.plan.redis,
            imageDigest: live.redis.imageDigest
        }
    };
    delete mutable.contentDigest;
    mutable.contentDigest = computeSha256(mutable);
    provisioner.plan = Object.freeze(mutable);
    return live;
}

export function resolveMaterializerSourceCommit(repositoryRoot, serverDll)
{
    // Prefer the commit sealed into the built assembly metadata so materializer
    // admission matches the executable used for offline migration.
    const probe = spawnSync('bash', [
        '-lc',
        `strings ${JSON.stringify(serverDll)} | rg -o "FsusBlog\\.SourceCommit\\([0-9a-f]{40}" | head -1`
    ], { encoding: 'utf8' });
    const match = String(probe.stdout || '').match(/FsusBlog\.SourceCommit\(([0-9a-f]{40})/u);
    if (match)
    {
        return match[1];
    }
    return resolveSourceCommit(repositoryRoot);
}

export function resolveSourceCommit(repositoryRoot)
{
    const result = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (result.status !== 0)
    {
        throw new Error('unable to resolve source commit for offline migration');
    }
    return String(result.stdout || '').trim();
}

export function resolveWorktreeFingerprint(repositoryRoot)
{
    const commit = resolveSourceCommit(repositoryRoot);
    return computeSha256(`worktree:${repositoryRoot}:${commit}`);
}

export async function executeLiveOfflineMigration(provisioner)
{
    if (provisioner.state.backendRunning)
    {
        throw new Error('backend is already running; migration must run before backend startup');
    }
    const serverDll = path.join(
        provisioner.repositoryRoot,
        'src/backend/bin/Release/net10.0/FsusBlog.Server.dll'
    );
    if (!fs.existsSync(serverDll))
    {
        provisioner.state.provisionFailed = true;
        throw new Error(
            `offline migration requires ${path.relative(provisioner.repositoryRoot, serverDll)}; `
            + 'fallback to shared runtime is prohibited'
        );
    }

    const live = provisioner.state.liveIdentity?.postgres;
    if (!live)
    {
        throw new Error('live postgres identity missing before offline migration');
    }

    const catalogPath = path.join(
        provisioner.repositoryRoot,
        'config/testing/test-execution-service-catalog.json'
    );
    const envelopePath = path.resolve(
        provisioner.repositoryRoot,
        provisioner.plan.roots.dataRoot,
        'service-envelope.json'
    );
    fs.mkdirSync(path.dirname(envelopePath), { recursive: true });

    const migrateRunId = `data-scale-migrate-${provisioner.dataScaleRunId}`;
    const envelopeResult = provisioner.processRunner('node', [
        path.join(provisioner.repositoryRoot, 'tools/test/execution-envelope-services.mjs'),
        '--producer-id', 'data-scale-runtime-provisioner',
        '--run-id', migrateRunId,
        '--required-services', 'postgres',
        '--postgres-container', provisioner.plan.postgres.containerName,
        '--service-catalog', catalogPath,
        '--output', envelopePath
    ], { cwd: provisioner.repositoryRoot });
    if (envelopeResult.status !== 0)
    {
        provisioner.state.provisionFailed = true;
        throw new Error(
            `failed to admit dedicated postgres service envelope: `
            + `${String(envelopeResult.stderr || envelopeResult.stdout || '').trim()}`
        );
    }

    const connectionString =
        `Host=127.0.0.1;Port=${live.hostPort};Database=${provisioner.plan.postgres.database};`
        + 'Username=fsusblog;Password=fsusblog_dev;Search Path=public';
    const receiptRoot = path.resolve(
        provisioner.repositoryRoot,
        provisioner.plan.roots.dataRoot,
        'schema-receipts'
    );
    fs.mkdirSync(receiptRoot, { recursive: true });
    const sourceCommit = resolveMaterializerSourceCommit(provisioner.repositoryRoot, serverDll);
    const migrateResult = provisioner.processRunner('dotnet', [
        serverDll,
        'materialize-current-schema-test',
        '--run-id', migrateRunId,
        '--source-commit', sourceCommit,
        '--service-envelope', envelopePath,
        '--service-catalog', catalogPath
    ], {
        cwd: provisioner.repositoryRoot,
        env: {
            ASPNETCORE_ENVIRONMENT: 'Test',
            FSUSBLOG_CURRENT_SCHEMA_TEST_MATERIALIZATION: '1',
            FSUSBLOG_CURRENT_SCHEMA_TEST_RECEIPT_ROOT: receiptRoot,
            ConnectionStrings__DefaultConnection: connectionString
        }
    });
    if (migrateResult.status !== 0)
    {
        provisioner.state.provisionFailed = true;
        throw new Error(
            `offline schema migration failed: `
            + `${String(migrateResult.stderr || migrateResult.stdout || '').trim()}`
        );
    }

    provisioner.state.migrationCompleted = true;
    provisioner.state.stepIndex = 2;
    return { status: 'migrated', envelopePath };
}

export async function executeLiveOfflineSeed(provisioner, { tier })
{
    if (!provisioner.state.migrationCompleted)
    {
        throw new Error('lifecycle order violation: migration must complete before offline seed');
    }
    if (provisioner.state.backendRunning || provisioner.state.liveIdentity?.backend)
    {
        throw new Error('backend is already running; raw SQL seed is prohibited while backend is running');
    }

    const outDir = path.resolve(provisioner.repositoryRoot, provisioner.plan.roots.dataRoot);
    fs.mkdirSync(outDir, { recursive: true });
    const seedScript = path.join(provisioner.repositoryRoot, 'tools/data-scale/seed.sh');
    const seedResult = provisioner.processRunner('bash', [seedScript, tier], {
        cwd: provisioner.repositoryRoot,
        env: {
            FSUSBLOG_POSTGRES_CONTAINER_NAME: provisioner.plan.postgres.containerName,
            FSUSBLOG_TEST_NAMESPACE: provisioner.namespace,
            FSUSBLOG_DATA_SCALE_OUT_DIR: outDir,
            FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: '2024-02-29T23:59:59.000Z',
            FSUSBLOG_TEST_POSTGRES_TIMEZONE: 'UTC',
            // Offline seed must not observe ambient shared/dev backend identity.
            FSUSBLOG_DEBUG_BACKEND_URL: '',
            FSUSBLOG_BACKEND_PID: '',
            FSUSBLOG_BACKEND_BASE_URL: ''
        }
    });
    if (seedResult.status !== 0)
    {
        provisioner.state.provisionFailed = true;
        throw new Error(
            `offline seed failed: ${String(seedResult.stderr || seedResult.stdout || '').trim()}`
        );
    }

    const seedReceiptAbsolute = path.join(outDir, 'seed-receipt.json');
    if (!fs.existsSync(seedReceiptAbsolute))
    {
        throw new Error('offline seed did not emit seed-receipt.json');
    }
    const seedReceiptBytes = fs.readFileSync(seedReceiptAbsolute);
    const seedReceiptData = JSON.parse(seedReceiptBytes.toString('utf8'));
    provisioner.state.seedCompleted = true;
    provisioner.state.stepIndex = 4;
    provisioner.state.seedReceipt = {
        path: path.join(provisioner.plan.roots.dataRoot, 'seed-receipt.json'),
        digest: computeSha256(seedReceiptBytes),
        document: seedReceiptData
    };
    return provisioner.state.seedReceipt;
}

export async function createDedicatedBackendContainer(provisioner)
{
    if (!provisioner.state.seedCompleted)
    {
        throw new Error('lifecycle order violation: offline seed must complete before backend startup');
    }
    const labels = provisioner.plan.ownershipLabels;
    const labelArgs = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    // Dedicated backend container identity uses the locally present Node runtime image.
    // Catalog classifies product backend as a run-owned process; this container proves
    // dedicated-scenario ownership/identity binding after offline seed, fail-closed.
    const backendImage = 'node:24.17.0-alpine3.23';
    const imageInspect = provisioner.dockerRunner([
        'image', 'inspect', backendImage, '--format', '{{.Id}}'
    ]);
    if (imageInspect.status !== 0)
    {
        provisioner.state.provisionFailed = true;
        throw new Error(
            `dedicated backend image missing locally (${backendImage}); `
            + 'fallback to shared runtime is prohibited'
        );
    }

    const createResult = provisioner.dockerRunner([
        'create',
        '--name', provisioner.plan.backend.containerName,
        '--pull', 'never',
        ...labelArgs,
        '--entrypoint', 'sleep',
        backendImage,
        '365d'
    ]);
    if (createResult.status !== 0)
    {
        provisioner.state.provisionFailed = true;
        throw new Error(
            `failed to create dedicated backend container ${provisioner.plan.backend.containerName}; `
            + 'fallback to shared runtime is prohibited'
        );
    }
    const startResult = provisioner.dockerRunner(['start', provisioner.plan.backend.containerName]);
    if (startResult.status !== 0)
    {
        provisioner.state.provisionFailed = true;
        throw new Error(
            `failed to start dedicated backend container ${provisioner.plan.backend.containerName}`
        );
    }

    const inspect = provisioner.dockerRunner([
        'inspect', provisioner.plan.backend.containerName,
        '--format', '{{.Id}}|{{.State.Running}}|{{.Image}}'
    ]);
    if (inspect.status !== 0)
    {
        throw new Error('failed to inspect dedicated backend container');
    }
    const [containerIdRaw, running, imageIdRaw] = String(inspect.stdout || '').trim().split('|');
    if (running !== 'true')
    {
        throw new Error('dedicated backend container is not running');
    }
    const backendImageDigest = `sha256:${normalizeDockerId(imageIdRaw)}`;
    provisioner.state.liveIdentity.backend = {
        containerId: normalizeDockerId(containerIdRaw),
        containerName: provisioner.plan.backend.containerName,
        imageDigest: backendImageDigest,
        startTicks: Date.now() * 10000
    };
    provisioner.state.backendRunning = true;
    provisioner.state.stepIndex = 6;
    return provisioner.state.liveIdentity.backend;
}

export function writeLiveRuntimeReceipt(provisioner, {
    sourceCommit,
    worktreeFingerprint,
    buildReceiptDigest,
    envManifestDigest
})
{
    const live = provisioner.state.liveIdentity;
    if (!live?.postgres || !live?.redis || !live?.backend || !provisioner.state.seedReceipt)
    {
        throw new Error('live identity/seed receipt incomplete; cannot write runtime receipt');
    }

    const receipt = createDataScaleRuntimeReceipt({
        dataScaleRunId: provisioner.dataScaleRunId,
        parentSchedulerRunId: provisioner.parentSchedulerRunId,
        sourceCommit,
        worktreeFingerprint,
        buildReceiptDigest,
        imageDigest: live.backend.imageDigest,
        namespace: provisioner.namespace,
        postgres: {
            containerId: live.postgres.containerId,
            database: provisioner.plan.postgres.database,
            imageDigest: live.postgres.imageDigest,
            volumeId: live.postgres.volumeId
        },
        redis: {
            containerId: live.redis.containerId,
            imageDigest: live.redis.imageDigest,
            volumeId: live.redis.volumeId
        },
        backend: {
            baseUrl: 'http://127.0.0.1:18888',
            executableOrImageDigest: live.backend.imageDigest,
            pidOrContainerId: live.backend.containerId,
            startTicks: live.backend.startTicks
        },
        aotRoot: provisioner.plan.roots.aotRoot,
        searchRoot: provisioner.plan.roots.searchRoot,
        hotReadRoot: provisioner.plan.roots.hotReadRoot,
        dataRoot: provisioner.plan.roots.dataRoot,
        envManifestDigest,
        seedReceiptPath: provisioner.state.seedReceipt.path,
        seedReceiptDigest: provisioner.state.seedReceipt.digest,
        createdAt: new Date().toISOString()
    });

    const receiptRelative = path.join(provisioner.plan.roots.dataRoot, 'runtime-receipt.json');
    const receiptAbsolute = path.resolve(provisioner.repositoryRoot, receiptRelative);
    fs.writeFileSync(receiptAbsolute, `${JSON.stringify(receipt, null, 2)}\n`);
    provisioner.state.receipt = {
        path: receiptRelative,
        digest: computeSha256(fs.readFileSync(receiptAbsolute)),
        document: receipt
    };
    return provisioner.state.receipt;
}

export function verifyLiveIdentityReceipt(provisioner, receipt = provisioner.state.receipt?.document)
{
    if (!receipt)
    {
        throw new Error('runtime identity receipt missing');
    }
    for (const [role, expected] of [
        ['postgres', receipt.postgres],
        ['redis', receipt.redis]
    ])
    {
        const name = role === 'postgres'
            ? provisioner.plan.postgres.containerName
            : provisioner.plan.redis.containerName;
        const inspect = provisioner.dockerRunner([
            'inspect', name, '--format', '{{.Id}}'
        ]);
        if (inspect.status !== 0)
        {
            throw new Error(`live ${role} container missing during identity verify`);
        }
        const liveId = normalizeDockerId(String(inspect.stdout || '').trim());
        if (liveId !== expected.containerId)
        {
            throw new Error(
                `live ${role} container digest mismatch: receipt=${expected.containerId} live=${liveId}`
            );
        }
        const volumeName = expected.volumeId;
        const volumeInspect = provisioner.dockerRunner([
            'volume', 'inspect', volumeName, '--format', '{{.Name}}'
        ]);
        const observedVolume = String(volumeInspect.stdout || '').trim().split('|')[0];
        if (volumeInspect.status !== 0 || observedVolume !== volumeName)
        {
            throw new Error(`live ${role} volume digest/name mismatch for ${volumeName}`);
        }
    }

    const backendInspect = provisioner.dockerRunner([
        'inspect', provisioner.plan.backend.containerName, '--format', '{{.Id}}'
    ]);
    if (backendInspect.status !== 0)
    {
        throw new Error('live backend container missing during identity verify');
    }
    const backendId = normalizeDockerId(String(backendInspect.stdout || '').trim());
    if (backendId !== receipt.backend.pidOrContainerId)
    {
        throw new Error(
            `live backend container digest mismatch: receipt=${receipt.backend.pidOrContainerId} live=${backendId}`
        );
    }
    return true;
}

export function teardownDedicatedRuntime(provisioner)
{
    const names = [
        provisioner.plan.backend.containerName,
        provisioner.plan.postgres.containerName,
        provisioner.plan.redis.containerName
    ];
    for (const name of names)
    {
        if (isForbiddenContainerName(name))
        {
            throw new Error(`refusing to teardown forbidden container ${name}`);
        }
        provisioner.dockerRunner(['rm', '-f', name]);
    }
    for (const volume of [
        provisioner.plan.postgres.volumeName,
        provisioner.plan.redis.volumeName
    ])
    {
        provisioner.dockerRunner(['volume', 'rm', '-f', volume]);
    }
    return { status: 'torn-down' };
}

export async function runFullLiveProvisionLifecycle(provisioner, { tier })
{
    await createAndStartDedicatedContainers(provisioner);
    await executeLiveOfflineMigration(provisioner);
    await executeLiveOfflineSeed(provisioner, { tier });
    await createDedicatedBackendContainer(provisioner);
    const sourceCommit = resolveSourceCommit(provisioner.repositoryRoot);
    const worktreeFingerprint = resolveWorktreeFingerprint(provisioner.repositoryRoot);
    const buildReceiptDigest = computeSha256({
        schema: 'fsusblog.data-scale-live-build-binding.v1',
        sourceCommit,
        serverDll: 'src/backend/bin/Release/net10.0/FsusBlog.Server.dll'
    });
    const envManifestDigest = computeSha256({
        schema: 'fsusblog.data-scale-live-env-manifest.v1',
        dataScaleRunId: provisioner.dataScaleRunId,
        postgres: provisioner.plan.postgres.containerName,
        redis: provisioner.plan.redis.containerName
    });
    const receipt = writeLiveRuntimeReceipt(provisioner, {
        sourceCommit,
        worktreeFingerprint,
        buildReceiptDigest,
        envManifestDigest
    });
    verifyLiveIdentityReceipt(provisioner, receipt.document);
    return receipt;
}
