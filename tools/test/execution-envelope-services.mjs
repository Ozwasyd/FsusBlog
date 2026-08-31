import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { executionEnvelopeDigest } from '../test-matrix/execution-envelope-policy.mjs';

import { processIdentityStatus } from './process-identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const executionServiceCatalogFile = path.join(
    root,
    'config/testing/test-execution-service-catalog.json'
);
export const executionEnvelopeServicesSchema =
    'fsusblog.test-execution-envelope-services.v1';
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export function loadExecutionServiceCatalog(file = executionServiceCatalogFile)
{
    if (!fs.existsSync(file))
    {
        return { missing: true };
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function executionServiceImageReference(id, catalog = loadExecutionServiceCatalog())
{
    const service = catalog?.services?.[id];
    if (service?.kind !== 'container'
        || !/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/u.test(service.imageReference ?? ''))
    {
        throw new Error(`${id}: pinned execution service image is unavailable`);
    }
    return service.imageReference;
}

export function requiredExecutionServices(producerId, applicabilityCatalog)
{
    const matches = (applicabilityCatalog?.producers ?? [])
        .filter((entry) => entry.producerId === producerId);
    if (matches.length !== 1 || !Array.isArray(matches[0].requiredServices))
    {
        throw new Error(`${producerId}: required execution service projection is unavailable`);
    }
    return [...matches[0].requiredServices];
}

export function validateExecutionServiceCatalog(catalog, matrix)
{
    const errors = [];
    if (catalog?.missing === true)
    {
        return ['execution service catalog source is missing'];
    }
    if (catalog?.schema !== 'fsusblog.test-execution-service-catalog.v1')
    {
        errors.push('execution service catalog schema is invalid');
    }
    if (catalog?.correctnessPhase?.imagePull !== 'denied'
        || catalog?.correctnessPhase?.hostFallback !== 'denied'
        || catalog?.correctnessPhase?.admission !== 'planned-actual-exact')
    {
        errors.push('correctness service phase must deny pulls and host fallback with exact admission');
    }
    const declaredServices = new Set(Object.keys(catalog?.services ?? {}));
    const matrixServices = new Set(
        (matrix?.tiers ?? []).flatMap((tier) => tier.services ?? [])
    );
    for (const service of matrixServices)
    {
        if (!declaredServices.has(service))
        {
            errors.push(`matrix service is absent from execution service catalog: ${service}`);
        }
    }
    for (const [id, service] of Object.entries(catalog?.services ?? {}))
    {
        if (!matrixServices.has(id))
        {
            errors.push(`execution service catalog entry is absent from matrix: ${id}`);
        }
        if (service.kind === 'container')
        {
            if (!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/u.test(service.imageReference ?? ''))
            {
                errors.push(`${id}: imageReference must be a concrete repository digest`);
            }
            if (service.hostNativeAllowed !== false)
            {
                errors.push(`${id}: host-native fallback must be denied`);
            }
            if (!String(service.version ?? '').trim())
            {
                errors.push(`${id}: concrete service version is required`);
            }
        }
        else if (service.kind !== 'run-owned-process')
        {
            errors.push(`${id}: unknown service identity kind`);
        }
    }
    return errors;
}

function dockerJson(args, docker = spawnSync)
{
    const result = docker('docker', args, {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
    });
    if (result?.error || result?.status !== 0)
    {
        throw new Error(
            `execution service observation failed: docker ${args.join(' ')}`
        );
    }
    try
    {
        return JSON.parse(result.stdout);
    }
    catch (error)
    {
        throw new Error(`execution service observation returned invalid JSON: ${error.message}`, { cause: error });
    }
}

export function observeDockerRuntime(docker = spawnSync)
{
    const document = dockerJson([
        'version',
        '--format',
        '{{json .Server}}'
    ], docker);
    const information = dockerJson([
        'info',
        '--format',
        '{{json .}}'
    ], docker);
    const components = new Map((document.Components ?? []).map((entry) => [entry.Name, entry]));
    const engine = components.get('Engine') ?? {};
    const identity = {
        serverVersion: engine.Version ?? document.Version ?? null,
        serverId: information.ID ?? null,
        operatingSystem: information.OperatingSystem ?? document.Os ?? null,
        architecture: information.Architecture ?? document.Arch ?? null,
        cgroupDriver: information.CgroupDriver ?? null
    };
    if (Object.values(identity).some((value) => !String(value ?? '').trim()))
    {
        throw new Error('execution service Docker runtime identity is incomplete');
    }
    return identity;
}

export function observeContainerService({
    id,
    containerName,
    catalogEntry,
    docker = spawnSync
})
{
    if (catalogEntry?.kind !== 'container')
    {
        throw new Error(`${id}: service is not a container catalog entry`);
    }
    const container = dockerJson(['inspect', containerName], docker)?.[0];
    const image = dockerJson(['image', 'inspect', catalogEntry.imageReference], docker)?.[0];
    if (!container?.Id || container?.State?.Running !== true)
    {
        throw new Error(`${id}: container is not running`);
    }
    if (container.Config?.Image !== catalogEntry.imageReference)
    {
        throw new Error(`${id}: container image reference drift`);
    }
    const repositoryDigest = (image.RepoDigests ?? []).find((value) =>
        value === catalogEntry.imageReference) ?? null;
    if (!repositoryDigest || !digestPattern.test(String(image.Id ?? '')))
    {
        throw new Error(`${id}: concrete image digest identity is incomplete`);
    }
    if (container.Image !== image.Id)
    {
        throw new Error(`${id}: running container image ID drift`);
    }
    const versionResult = docker('docker', [
        'exec',
        containerName,
        ...catalogEntry.versionCommand
    ], { encoding: 'utf8', shell: false, windowsHide: true });
    if (versionResult?.error || versionResult?.status !== 0)
    {
        throw new Error(`${id}: service version is unobservable`);
    }
    const serviceVersion = String(versionResult.stdout || versionResult.stderr).trim();
    if (!serviceVersion.includes(catalogEntry.version))
    {
        throw new Error(`${id}: service version drift`);
    }
    const ports = Object.entries(container.NetworkSettings?.Ports ?? {})
        .flatMap(([containerPort, bindings]) => (bindings ?? []).map((binding) => ({
            containerPort,
            hostIp: binding.HostIp,
            hostPort: binding.HostPort
        })))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return {
        id,
        kind: 'container',
        containerId: container.Id,
        createdAt: container.Created,
        imageReference: container.Config.Image,
        imageId: image.Id,
        repositoryDigest,
        serviceVersion,
        networkMode: container.HostConfig?.NetworkMode ?? null,
        networkNamespace: container.NetworkSettings?.SandboxKey ?? null,
        ports,
        resourceLimits: {
            nanoCpus: container.HostConfig?.NanoCpus ?? 0,
            memory: container.HostConfig?.Memory ?? 0,
            memoryReservation: container.HostConfig?.MemoryReservation ?? 0,
            pidsLimit: container.HostConfig?.PidsLimit ?? 0
        }
    };
}

export function observeRunOwnedService({
    id,
    evidence,
    catalogEntry,
    observeProcess = processIdentityStatus
})
{
    if (catalogEntry?.kind !== 'run-owned-process'
        || catalogEntry.identityAuthority !== 'resident-resource-lease')
    {
        throw new Error(`${id}: run-owned service authority is unavailable`);
    }
    const status = observeProcess(evidence?.processIdentity);
    if (status?.status !== 'live'
        || status.actual?.processStartIdentity
            !== evidence?.processIdentity?.processStartIdentity)
    {
        throw new Error(`${id}: run-owned service process identity drift`);
    }
    for (const [field, value] of Object.entries({
        sourceCommit: evidence?.sourceCommit,
        worktreeFingerprint: evidence?.worktreeFingerprint,
        artifactDigest: evidence?.artifactDigest,
        configDigest: evidence?.configDigest
    }))
    {
        if (!String(value ?? '').trim()
            || (field.endsWith('Digest') && !digestPattern.test(String(value))))
        {
            throw new Error(`${id}: run-owned service ${field} is incomplete`);
        }
    }
    if (!Number.isInteger(evidence?.topology?.port)
        || evidence.topology.port < 1
        || evidence.topology.port > 65_535
        || !String(evidence.topology.networkNamespace ?? '').trim()
        || !evidence.topology.resourceLimits)
    {
        throw new Error(`${id}: run-owned service topology identity is incomplete`);
    }
    return {
        id,
        kind: 'run-owned-process',
        sourceCommit: evidence.sourceCommit,
        worktreeFingerprint: evidence.worktreeFingerprint,
        artifactDigest: evidence.artifactDigest,
        configDigest: evidence.configDigest,
        processIdentity: evidence.processIdentity,
        topology: evidence.topology
    };
}

function exactMatch(planned, actual, label)
{
    if (executionEnvelopeDigest(planned) !== executionEnvelopeDigest(actual))
    {
        throw new Error(`${label} planned/actual service envelope drift`);
    }
}

export function createAndAdmitServiceEnvelope({
    producerId,
    runId,
    containers,
    runOwnedProcesses = {},
    requiredServices = [...new Set([
        ...Object.keys(containers ?? {}),
        ...Object.keys(runOwnedProcesses)
    ])].sort(),
    catalog,
    observeRuntime = observeDockerRuntime,
    observeService = observeContainerService,
    observeProcessService = observeRunOwnedService
})
{
    const declared = [...new Set(requiredServices)].sort();
    if (declared.length !== requiredServices.length
        || declared.some((id) => !catalog?.services?.[id]))
    {
        throw new Error(`${producerId}: required service roster is duplicate or unknown`);
    }
    const containerIds = declared.filter((id) => catalog.services[id].kind === 'container');
    const observe = () => ({
        runtime: containerIds.length > 0 ? observeRuntime() : null,
        services: declared.map((id) => catalog.services[id].kind === 'container'
            ? observeService({
                id,
                containerName: containers?.[id],
                catalogEntry: catalog.services[id]
            })
            : observeProcessService({
                id,
                evidence: runOwnedProcesses[id],
                catalogEntry: catalog.services[id]
            }))
    });
    const planned = observe();
    const actual = observe();
    exactMatch(planned, actual, 'correctness');
    return {
        schema: executionEnvelopeServicesSchema,
        qualificationEligible: true,
        producerId,
        runId,
        catalogDigest: executionEnvelopeDigest(catalog),
        requiredServices: declared,
        planned,
        actual,
        admission: 'planned-actual-exact',
        correctnessImagePull: 'denied',
        hostFallback: 'denied'
    };
}

function options(argv)
{
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2)
    {
        values.set(argv[index], argv[index + 1]);
    }
    return values;
}

function writePrivateJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

async function main(argv)
{
    const values = options(argv);
    const catalog = loadExecutionServiceCatalog();
    if (values.has('--image-reference'))
    {
        console.log(executionServiceImageReference(
            values.get('--image-reference'),
            catalog
        ));
        return;
    }
    const output = path.resolve(values.get('--output') ?? '');
    if (!output || output === root)
    {
        throw new Error('--output is required');
    }
    const envelope = createAndAdmitServiceEnvelope({
        producerId: values.get('--producer-id'),
        runId: values.get('--run-id'),
        requiredServices: String(values.get('--required-services') ?? 'postgres,redis')
            .split(',').filter(Boolean).sort(),
        containers: {
            postgres: values.get('--postgres-container'),
            redis: values.get('--redis-container')
        },
        runOwnedProcesses: values.has('--process-evidence')
            ? JSON.parse(fs.readFileSync(path.resolve(values.get('--process-evidence')), 'utf8'))
            : {},
        catalog
    });
    writePrivateJson(output, envelope);
    console.log(`[execution-envelope-services] admitted output=${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    main(process.argv.slice(2)).catch((error) =>
    {
        console.error(`[execution-envelope-services] ${error.message}`);
        process.exitCode = 1;
    });
}
