import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { executionEnvelopeDigest } from '../test-matrix/execution-envelope-policy.mjs';

import { processIdentityStatus } from './process-identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const executionServiceCatalogFile = path.join(
    root,
    'config/testing/test-execution-service-catalog.json'
);
export const executionEnvelopeServicesSchema =
    'fsusblog.test-execution-envelope-services.v2';
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const decimalIdentifierPattern = /^[1-9][0-9]*$/u;
const containerIdentityFields = [
    'containerId',
    'imageReference',
    'imageId',
    'repositoryDigest',
    'serviceVersion',
    'networkMode',
    'ports',
    'resourceLimits'
];
const postgresIdentityFields = [...containerIdentityFields, 'databaseIdentity'];
const postgresDatabaseIdentityQuery = [
    'SELECT json_build_object(',
    "'systemIdentifier', (pg_control_system()).system_identifier::text,",
    "'database', current_database(),",
    "'username', current_user,",
    "'serverVersion', current_setting('server_version'),",
    "'serverVersionNumber', current_setting('server_version_num')",
    ')::text;'
].join(' ');

function hasExactProperties(value, expected)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    return JSON.stringify(Object.keys(value).sort())
        === JSON.stringify([...expected].sort());
}

function hasExactArray(value, expected)
{
    return Array.isArray(value)
        && JSON.stringify(value) === JSON.stringify(expected);
}

function validatePostgresDatabaseIdentity(identity, catalogEntry)
{
    if (!hasExactProperties(identity, [
        'systemIdentifier',
        'database',
        'username',
        'serverVersion',
        'serverVersionNumber'
    ]))
    {
        throw new Error('postgres: database identity is malformed');
    }
    const escapedVersion = String(catalogEntry.version ?? '')
        .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const versionPattern = new RegExp(`^${escapedVersion}(?:$|\\s)`, 'u');
    if (typeof identity.systemIdentifier !== 'string'
        || !decimalIdentifierPattern.test(identity.systemIdentifier)
        || typeof identity.database !== 'string'
        || typeof identity.username !== 'string'
        || typeof identity.serverVersion !== 'string'
        || typeof identity.serverVersionNumber !== 'string'
        || identity.database !== catalogEntry.database
        || identity.username !== catalogEntry.username
        || !versionPattern.test(identity.serverVersion)
        || identity.serverVersionNumber !== catalogEntry.serverVersionNumber)
    {
        throw new Error('postgres: database identity drift');
    }
}

function validateObservedContainerService(identity, catalogEntry)
{
    const isPostgres = identity?.id === 'postgres';
    const expectedProperties = [
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
        ...(isPostgres ? ['databaseIdentity'] : [])
    ];
    if (!hasExactProperties(identity, expectedProperties)
        || identity.kind !== 'container'
        || !String(identity.containerId ?? '').trim()
        || !String(identity.createdAt ?? '').trim()
        || identity.imageReference !== catalogEntry.imageReference
        || !digestPattern.test(identity.imageId ?? '')
        || identity.repositoryDigest !== catalogEntry.imageReference
        || !String(identity.serviceVersion ?? '').includes(catalogEntry.version)
        || !String(identity.networkMode ?? '').trim()
        || !String(identity.networkNamespace ?? '').trim()
        || !Array.isArray(identity.ports)
        || !hasExactProperties(identity.resourceLimits, [
            'nanoCpus',
            'memory',
            'memoryReservation',
            'pidsLimit'
        ])
        || Object.values(identity.resourceLimits)
            .some((value) => !Number.isInteger(value) || value < 0))
    {
        throw new Error(`${identity?.id ?? 'unknown'}: container identity is malformed`);
    }
    for (const port of identity.ports)
    {
        if (!hasExactProperties(port, ['containerPort', 'hostIp', 'hostPort'])
            || !String(port.containerPort ?? '').trim()
            || !String(port.hostIp ?? '').trim()
            || !String(port.hostPort ?? '').trim())
        {
            throw new Error(`${identity.id}: container port identity is malformed`);
        }
    }
    if (isPostgres)
    {
        validatePostgresDatabaseIdentity(identity.databaseIdentity, catalogEntry);
    }
}

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
    if (catalog?.schema !== 'fsusblog.test-execution-service-catalog.v2'
        || catalog?.version !== 2
        || !hasExactProperties(catalog, [
            'schema',
            'version',
            'correctnessPhase',
            'containerRuntime',
            'services'
        ]))
    {
        errors.push('execution service catalog schema is invalid');
    }
    if (!hasExactProperties(catalog?.correctnessPhase, [
        'imagePull',
        'hostFallback',
        'admission'
    ])
        || catalog?.correctnessPhase?.imagePull !== 'denied'
        || catalog?.correctnessPhase?.hostFallback !== 'denied'
        || catalog?.correctnessPhase?.admission !== 'planned-actual-exact')
    {
        errors.push('correctness service phase must deny pulls and host fallback with exact admission');
    }
    if (!hasExactProperties(catalog?.containerRuntime, [
        'kind',
        'identityFields',
        'plannedVersionSource'
    ])
        || catalog?.containerRuntime?.kind !== 'docker'
        || !hasExactArray(catalog?.containerRuntime?.identityFields, [
            'serverVersion',
            'serverId',
            'operatingSystem',
            'architecture',
            'cgroupDriver'
        ])
        || catalog?.containerRuntime?.plannedVersionSource !== 'observed-preflight-exact')
    {
        errors.push('execution service Docker runtime authority is invalid');
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
            const isPostgres = id === 'postgres';
            const expectedProperties = [
                'kind',
                'imageReference',
                'version',
                'versionCommand',
                'hostNativeAllowed',
                'requiredIdentityFields',
                ...(isPostgres ? [
                    'databaseIdentityAuthority',
                    'database',
                    'username',
                    'serverVersionNumber'
                ] : [])
            ];
            if (!hasExactProperties(service, expectedProperties))
            {
                errors.push(`${id}: container service catalog shape is invalid`);
            }
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
            if (!Array.isArray(service.versionCommand)
                || service.versionCommand.length < 1
                || service.versionCommand.some((argument) => !String(argument).trim()))
            {
                errors.push(`${id}: service version command is invalid`);
            }
            if (!hasExactArray(
                service.requiredIdentityFields,
                isPostgres ? postgresIdentityFields : containerIdentityFields
            ))
            {
                errors.push(`${id}: required container identity fields are invalid`);
            }
            if (isPostgres
                && (service.databaseIdentityAuthority !== 'postgres-control-system-exact'
                    || service.database !== 'fsusblog'
                    || service.username !== 'fsusblog'
                    || service.version !== '16.15'
                    || service.serverVersionNumber !== '160015'))
            {
                errors.push('postgres: database identity authority is invalid');
            }
        }
        else if (service.kind !== 'run-owned-process')
        {
            errors.push(`${id}: unknown service identity kind`);
        }
        else if (!hasExactProperties(service, [
            'kind',
            'identityAuthority',
            'image',
            'imageNotApplicableReason'
        ])
            || service.identityAuthority !== 'resident-resource-lease'
            || service.image !== null
            || service.imageNotApplicableReason !== 'repository-build-artifact-process')
        {
            errors.push(`${id}: run-owned service authority is invalid`);
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
    let databaseIdentity;
    if (id === 'postgres')
    {
        if (catalogEntry.databaseIdentityAuthority !== 'postgres-control-system-exact'
            || catalogEntry.database !== 'fsusblog'
            || catalogEntry.username !== 'fsusblog'
            || catalogEntry.version !== '16.15'
            || catalogEntry.serverVersionNumber !== '160015')
        {
            throw new Error('postgres: database identity authority is invalid');
        }
        const identityResult = docker('docker', [
            'exec',
            containerName,
            'psql',
            '--no-psqlrc',
            '--set=ON_ERROR_STOP=1',
            '--tuples-only',
            '--no-align',
            '--dbname',
            catalogEntry.database,
            '--username',
            catalogEntry.username,
            '--command',
            postgresDatabaseIdentityQuery
        ], { encoding: 'utf8', shell: false, windowsHide: true });
        if (identityResult?.error || identityResult?.status !== 0)
        {
            throw new Error('postgres: database identity is unobservable');
        }
        try
        {
            databaseIdentity = JSON.parse(String(identityResult.stdout).trim());
        }
        catch
        {
            throw new Error('postgres: database identity is malformed');
        }
        validatePostgresDatabaseIdentity(databaseIdentity, catalogEntry);
    }
    const ports = Object.entries(container.NetworkSettings?.Ports ?? {})
        .flatMap(([containerPort, bindings]) => (bindings ?? []).map((binding) => ({
            containerPort,
            hostIp: binding.HostIp,
            hostPort: binding.HostPort
        })))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const identity = {
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
    if (databaseIdentity)
    {
        identity.databaseIdentity = databaseIdentity;
    }
    validateObservedContainerService(identity, catalogEntry);
    return identity;
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

function validateRuntimeIdentity(runtime)
{
    if (!hasExactProperties(runtime, [
        'serverVersion',
        'serverId',
        'operatingSystem',
        'architecture',
        'cgroupDriver'
    ]) || Object.values(runtime).some((value) => !String(value ?? '').trim()))
    {
        throw new Error('execution service Docker runtime identity is malformed');
    }
}

function validateEnvelopeShape(envelope, catalog)
{
    const catalogErrors = validateExecutionServiceCatalog(catalog, {
        tiers: [{ services: Object.keys(catalog?.services ?? {}) }]
    });
    if (catalogErrors.length > 0)
    {
        throw new Error(`execution service catalog is invalid: ${catalogErrors.join('; ')}`);
    }
    if (!hasExactProperties(envelope, [
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
    ])
        || envelope.schema !== executionEnvelopeServicesSchema
        || envelope.qualificationEligible !== true
        || !String(envelope.producerId ?? '').trim()
        || !String(envelope.runId ?? '').trim()
        || envelope.catalogDigest !== executionEnvelopeDigest(catalog)
        || envelope.admission !== 'planned-actual-exact'
        || envelope.correctnessImagePull !== 'denied'
        || envelope.hostFallback !== 'denied'
        || !hasExactProperties(envelope.planned, ['runtime', 'services'])
        || !hasExactProperties(envelope.actual, ['runtime', 'services']))
    {
        throw new Error('execution service envelope is malformed or catalog-unbound');
    }
    const requiredServices = envelope.requiredServices;
    const declared = [...new Set(requiredServices)].sort();
    if (!hasExactArray(requiredServices, declared)
        || declared.some((id) => !catalog?.services?.[id])
        || !Array.isArray(envelope.planned.services)
        || !Array.isArray(envelope.actual.services)
        || !hasExactArray(
            envelope.planned.services.map((service) => service?.id),
            declared
        )
        || !hasExactArray(
            envelope.actual.services.map((service) => service?.id),
            declared
        ))
    {
        throw new Error('execution service envelope roster is malformed');
    }
    exactMatch(envelope.planned, envelope.actual, 'admitted');
    return declared;
}

export function verifyLiveServiceEnvelope({
    envelope,
    catalog,
    observeRuntime = observeDockerRuntime,
    observeService = observeContainerService,
    observeProcessService = observeRunOwnedService
})
{
    const declared = validateEnvelopeShape(envelope, catalog);
    const admittedServices = new Map(
        envelope.actual.services.map((service) => [service.id, service])
    );
    const containerIds = declared.filter((id) => catalog.services[id].kind === 'container');
    const runtime = containerIds.length > 0 ? observeRuntime() : null;
    if (runtime !== null)
    {
        validateRuntimeIdentity(runtime);
    }
    const services = declared.map((id) =>
    {
        const catalogEntry = catalog.services[id];
        const admitted = admittedServices.get(id);
        if (catalogEntry.kind === 'container')
        {
            validateObservedContainerService(admitted, catalogEntry);
            const identity = observeService({
                id,
                containerName: admitted.containerId,
                catalogEntry
            });
            validateObservedContainerService(identity, catalogEntry);
            return identity;
        }
        return observeProcessService({
            id,
            evidence: admitted,
            catalogEntry
        });
    });
    const live = { runtime, services };
    exactMatch(envelope.planned, live, 'live');
    exactMatch(envelope.actual, live, 'live');
    return envelope;
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
    const observe = () =>
    {
        const runtime = containerIds.length > 0 ? observeRuntime() : null;
        if (runtime !== null)
        {
            validateRuntimeIdentity(runtime);
        }
        const services = declared.map((id) =>
        {
            const catalogEntry = catalog.services[id];
            const identity = catalogEntry.kind === 'container'
                ? observeService({
                    id,
                    containerName: containers?.[id],
                    catalogEntry
                })
                : observeProcessService({
                    id,
                    evidence: runOwnedProcesses[id],
                    catalogEntry
                });
            if (catalogEntry.kind === 'container')
            {
                validateObservedContainerService(identity, catalogEntry);
            }
            return identity;
        });
        return { runtime, services };
    };
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

export function parseExecutionEnvelopeServicesOptions(argv)
{
    const allowed = new Set([
        '--image-reference',
        '--verify-envelope',
        '--service-catalog',
        '--producer-id',
        '--run-id',
        '--required-services',
        '--postgres-container',
        '--redis-container',
        '--process-evidence',
        '--output'
    ]);
    if (argv.length % 2 !== 0)
    {
        throw new Error('execution envelope service options require name/value pairs');
    }
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!allowed.has(name))
        {
            throw new Error(`unknown execution envelope service option: ${name}`);
        }
        if (values.has(name))
        {
            throw new Error(`duplicate execution envelope service option: ${name}`);
        }
        if (!String(value ?? '').trim())
        {
            throw new Error(`execution envelope service option requires a value: ${name}`);
        }
        values.set(name, value);
    }
    return values;
}

function requireExactOptions(values, required, optional = [])
{
    const accepted = new Set([...required, ...optional]);
    for (const name of required)
    {
        if (!values.has(name))
        {
            throw new Error(`missing execution envelope service option: ${name}`);
        }
    }
    for (const name of values.keys())
    {
        if (!accepted.has(name))
        {
            throw new Error(`execution envelope service option is not valid in this mode: ${name}`);
        }
    }
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
    const values = parseExecutionEnvelopeServicesOptions(argv);
    if (values.has('--image-reference'))
    {
        requireExactOptions(values, ['--image-reference'], ['--service-catalog']);
        const catalog = loadExecutionServiceCatalog(
            values.has('--service-catalog')
                ? path.resolve(values.get('--service-catalog'))
                : executionServiceCatalogFile
        );
        console.log(executionServiceImageReference(
            values.get('--image-reference'),
            catalog
        ));
        return;
    }
    if (values.has('--verify-envelope'))
    {
        requireExactOptions(values, ['--verify-envelope', '--service-catalog']);
        const envelopeFile = path.resolve(values.get('--verify-envelope'));
        const catalogFile = path.resolve(values.get('--service-catalog'));
        const envelope = JSON.parse(fs.readFileSync(envelopeFile, 'utf8'));
        const catalog = loadExecutionServiceCatalog(catalogFile);
        verifyLiveServiceEnvelope({ envelope, catalog });
        console.log(`[execution-envelope-services] live verified envelope=${envelopeFile}`);
        return;
    }
    requireExactOptions(values, [
        '--producer-id',
        '--run-id',
        '--output'
    ], [
        '--required-services',
        '--postgres-container',
        '--redis-container',
        '--process-evidence',
        '--service-catalog'
    ]);
    const catalog = loadExecutionServiceCatalog(
        values.has('--service-catalog')
            ? path.resolve(values.get('--service-catalog'))
            : executionServiceCatalogFile
    );
    const output = path.resolve(values.get('--output'));
    const requiredServices = String(values.get('--required-services') ?? 'postgres,redis')
        .split(',').filter(Boolean).sort();
    for (const [serviceId, option] of [
        ['postgres', '--postgres-container'],
        ['redis', '--redis-container']
    ])
    {
        const required = requiredServices.includes(serviceId);
        if (required !== values.has(option))
        {
            throw new Error(`${option} must be present exactly when ${serviceId} is required`);
        }
    }
    const envelope = createAndAdmitServiceEnvelope({
        producerId: values.get('--producer-id'),
        runId: values.get('--run-id'),
        requiredServices,
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
