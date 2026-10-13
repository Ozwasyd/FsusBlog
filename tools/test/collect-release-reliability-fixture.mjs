#!/usr/bin/env node

/* eslint-disable import-x/no-relative-parent-imports -- Integrate the existing canonical lifecycle and resource observer owners. */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    readDockerPostgresqlDatabaseState,
    readDockerPublicCacheState
} from '../test-runtime/production-observer-ports.mjs';

import { parseRuntimeEnvironment } from './bundles/runtime-environment.mjs';
import { digestValue } from './release-reliability-receipt.mjs';
import {
    projectQualifiedContainerEnvironment,
    releaseReliabilityAuditedContainerOverrides
} from './release-reliability-runtime-environment.mjs';

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const auditRetentionPolicyPath = 'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs';
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const confined = (root, relative, label) =>
{
    const absolute = path.resolve(root, relative);
    if (!relative || absolute === root || !absolute.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`${label} escapes root`);
    }
    for (let cursor = absolute; cursor !== root; cursor = path.dirname(cursor))
    {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
        {
            throw new Error(`${label} contains a symlink`);
        }
    }
    return absolute;
};
const file = (root, value, label) =>
{
    const relative = String(value ?? '').replace(/^\.\//u, '');
    const absolute = confined(root, relative, label);
    if (!fs.existsSync(absolute)
        || !fs.lstatSync(absolute).isFile() || fs.lstatSync(absolute).isSymbolicLink())
    {
        throw new Error(`${label} is unavailable`);
    }
    return { path: relative, fileDigest: digest(fs.readFileSync(absolute)) };
};
const containerProcess = (name) =>
{
    const read = (label, command) =>
    {
        const result = spawnSync('docker', ['exec', name, 'sh', '-c', command], { encoding: 'utf8' });
        if (result.status !== 0)
        {
            throw new Error(`backend container procfs ${label} collection failed`);
        }
        return result.stdout;
    };
    const stat = read('stat', 'cat /proc/1/stat');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const lines = (value) => value.split(/\r?\n/u).filter(Boolean);
    const environment = Object.fromEntries(lines(read('environment', "tr '\\000' '\\n' </proc/1/environ")).map((entry) =>
    {
        const separator = entry.indexOf('=');
        return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    return {
        pid: 1,
        processGroupId: Number(tail[2]),
        sessionId: Number(tail[3]),
        startTimeTicks: tail[19],
        executable: read('executable', 'readlink -f /proc/1/exe').trim(),
        commandLine: lines(read('command line', "tr '\\000' '\\n' </proc/1/cmdline")),
        workingDirectory: read('working directory', 'readlink -f /proc/1/cwd').trim(),
        environment
    };
};
const inspectContainer = (name, label, runId, namespace) =>
{
    const result = spawnSync('docker', ['inspect', name], { encoding: 'utf8' });
    if (result.status !== 0)
    {
        throw new Error(`${label} docker inspect failed`);
    }
    const [document] = JSON.parse(result.stdout);
    const labels = document?.Config?.Labels ?? {};
    if (!document?.Id || !document?.Config?.Image || !document?.Image || !document?.State?.Running
        || labels['io.fsusblog.test.run-id'] !== runId
        || labels['io.fsusblog.test.namespace'] !== namespace)
    {
        throw new Error(`${label} is not one running container for this run and namespace`);
    }
    return document;
};
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => value.startsWith('--') ? [...pairs, [value.slice(2), values[index + 1]]] : pairs, []));
const root = path.resolve(args.root ?? process.cwd());
const required = ['run-id', 'namespace', 'fixture-root', 'config', 'schema', 'seed', 'audit-retention-policy', 'postgres', 'redis', 'backend-container', 'network', 'source-commit', 'source-fingerprint', 'runtime-image', 'image-digest', 'out'];
for (const key of required)
{
    if (!args[key])
    {
        throw new Error(`--${key} is required`);
    }
}
if (args['audit-retention-policy'] !== auditRetentionPolicyPath)
{
    throw new Error('--audit-retention-policy must use the canonical machine-readable catalog');
}
if (!/^sha256:[0-9a-f]{64}$/u.test(args['image-digest']))
{
    throw new Error('--image-digest must be concrete');
}
const runtimeEnvironment = parseRuntimeEnvironment(
    fs.readFileSync(confined(root, String(args.config).replace(/^\.\//u, ''), 'config'), 'utf8'),
    args.namespace
);
if (runtimeEnvironment.FSUSBLOG_TEST_RUN_ID !== args['run-id']
    || runtimeEnvironment.FSUSBLOG_POSTGRES_CONTAINER_NAME !== args.postgres
    || runtimeEnvironment.FSUSBLOG_REDIS_CONTAINER_NAME !== args.redis
    || runtimeEnvironment.ASPNETCORE_URLS !== runtimeEnvironment.FSUSBLOG_DEBUG_BACKEND_URL)
{
    throw new Error('fixture config does not bind the qualified run, namespace services, and backend URL');
}
const imageInspection = spawnSync('docker', ['image', 'inspect', args['runtime-image']], { encoding: 'utf8' });
if (imageInspection.status !== 0)
{
    throw new Error('runtime image docker inspect failed');
}
const [runtimeImage] = JSON.parse(imageInspection.stdout);
if (runtimeImage?.Id !== args['image-digest'] || runtimeImage?.Config?.Labels?.['org.opencontainers.image.revision'] !== args['source-commit']
    || !Array.isArray(runtimeImage?.RootFS?.Layers) || runtimeImage.RootFS.Layers.length === 0)
{
    throw new Error('runtime image does not bind the inspected ID, source revision, and RootFS layers');
}
const backendContainerInspection = spawnSync('docker', ['inspect', args['backend-container']], { encoding: 'utf8' });
if (backendContainerInspection.status !== 0)
{
    throw new Error('backend app container docker inspect failed');
}
const [backendContainer] = JSON.parse(backendContainerInspection.stdout);
const imageHealthcheck = runtimeImage?.Config?.Healthcheck;
const containerHealthcheck = backendContainer?.Config?.Healthcheck;
if (!backendContainer?.State?.Running || !backendContainer.State?.StartedAt
    || backendContainer.State?.Health?.Status !== 'healthy'
    || !Array.isArray(imageHealthcheck?.Test) || imageHealthcheck.Test.length === 0
    || JSON.stringify(canonical(containerHealthcheck)) !== JSON.stringify(canonical(imageHealthcheck))
    || !Number.isInteger(backendContainer.State?.Pid) || backendContainer.State.Pid < 2
    || !backendContainer?.Id || !backendContainer?.Path || !Array.isArray(backendContainer?.Args)
    || backendContainer.Image !== args['image-digest'] || backendContainer.Config?.Image !== args['runtime-image']
    || backendContainer.Config?.Labels?.['io.fsusblog.test.run-id'] !== args['run-id']
    || backendContainer.Config?.Labels?.['io.fsusblog.test.namespace'] !== args.namespace)
{
    throw new Error('backend app container does not bind immutable healthcheck, healthy state, live PID, ownership, and runtime image');
}
const postgresContainer = inspectContainer(args.postgres, 'postgres', args['run-id'], args.namespace);
const redisContainer = inspectContainer(args.redis, 'redis', args['run-id'], args.namespace);
const networkInspection = spawnSync('docker', ['network', 'inspect', args.network], { encoding: 'utf8' });
if (networkInspection.status !== 0)
{
    throw new Error('qualified runtime network docker inspect failed');
}
const [runtimeNetwork] = JSON.parse(networkInspection.stdout);
const networkLabels = runtimeNetwork?.Labels ?? {};
if (!runtimeNetwork?.Id || runtimeNetwork.Name !== args.network || runtimeNetwork.Driver !== 'bridge'
    || networkLabels['io.fsusblog.test.run-id'] !== args['run-id']
    || networkLabels['io.fsusblog.test.namespace'] !== args.namespace)
{
    throw new Error('qualified runtime network is not one run-owned bridge');
}
const attachment = (container, label, requiredAlias = null) =>
{
    const value = container?.NetworkSettings?.Networks?.[args.network];
    const aliases = Array.isArray(value?.Aliases) ? value.Aliases : [];
    if (!value || value.NetworkID !== runtimeNetwork.Id
        || requiredAlias !== null && !aliases.includes(requiredAlias))
    {
        throw new Error(`${label} is not attached to the qualified runtime network with its required alias`);
    }
    return {
        aliases: [...aliases].sort(),
        ipv4Address: value.IPAddress,
        networkId: value.NetworkID
    };
};
const backendAttachment = attachment(backendContainer, 'backend');
const postgresAttachment = attachment(postgresContainer, 'postgres', 'postgres');
const redisAttachment = attachment(redisContainer, 'redis', 'redis');
if (backendAttachment.aliases.includes('postgres') || backendAttachment.aliases.includes('redis')
    || postgresAttachment.aliases.includes('redis') || redisAttachment.aliases.includes('postgres'))
{
    throw new Error('qualified runtime network service aliases are not unique');
}
const expectedContainerIds = [backendContainer.Id, postgresContainer.Id, redisContainer.Id].sort();
const observedContainerIds = Object.keys(runtimeNetwork.Containers ?? {}).sort();
if (JSON.stringify(observedContainerIds) !== JSON.stringify(expectedContainerIds))
{
    throw new Error('qualified runtime network membership is incomplete or contains foreign containers');
}
const backendHostPort = runtimeEnvironment.FSUSBLOG_DEBUG_BACKEND_PORT;
const configuredPortBindings = backendContainer.HostConfig?.PortBindings?.['8080/tcp'];
const observedPortBindings = backendContainer.NetworkSettings?.Ports?.['8080/tcp'];
const validPortBinding = (bindings) => Array.isArray(bindings) && bindings.length === 1
    && bindings[0]?.HostIp === '127.0.0.1' && bindings[0]?.HostPort === backendHostPort;
if (!Object.hasOwn(backendContainer.Config?.ExposedPorts ?? {}, '8080/tcp')
    || !validPortBinding(configuredPortBindings) || !validPortBinding(observedPortBindings))
{
    throw new Error('backend app container must expose internal 8080 on the configured dynamic loopback port');
}
const observedBackend = containerProcess(args['backend-container']);
const configuredEnvironmentEntries = backendContainer.Config?.Env ?? [];
const configuredEnvironment = Object.fromEntries(configuredEnvironmentEntries.map((entry) =>
{
    const separator = entry.indexOf('=');
    return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
}));
if (Object.keys(configuredEnvironment).length !== configuredEnvironmentEntries.length)
{
    throw new Error('backend container configured environment contains duplicate keys');
}
const imageEnvironment = Object.fromEntries((runtimeImage.Config?.Env ?? []).map((entry) =>
{
    const separator = entry.indexOf('=');
    return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
}));
const auditedContainerOverrides = releaseReliabilityAuditedContainerOverrides({
    runId: args['run-id'],
    namespace: args.namespace,
    sourceCommit: args['source-commit'],
    sourceFingerprint: args['source-fingerprint']
});
const projectedRuntimeEnvironment = projectQualifiedContainerEnvironment(runtimeEnvironment);
const expectedContainerEnvironment = {
    ...imageEnvironment,
    ...projectedRuntimeEnvironment,
    ...auditedContainerOverrides
};
if (observedBackend.pid !== 1 || observedBackend.processGroupId !== 1 || observedBackend.sessionId !== 1
    || JSON.stringify(canonical(configuredEnvironment)) !== JSON.stringify(canonical(expectedContainerEnvironment))
    || Object.entries(expectedContainerEnvironment).some(([key, value]) => (
        configuredEnvironment[key] !== value || observedBackend.environment[key] !== value
    ))
    || configuredEnvironment.FSUSBLOG_TEST_RUN_ID !== args['run-id']
    || configuredEnvironment.FSUSBLOG_TEST_NAMESPACE !== args.namespace
    || configuredEnvironment.FSUSBLOG_RUNTIME_ROLE !== 'backend'
    || configuredEnvironment.FSUSBLOG_TEST_SOURCE_COMMIT !== args['source-commit']
    || configuredEnvironment.FSUSBLOG_TEST_SOURCE_FINGERPRINT !== args['source-fingerprint']
    || ['FSUSBLOG_TEST_RUN_ID', 'FSUSBLOG_TEST_NAMESPACE', 'FSUSBLOG_RUNTIME_ROLE', 'FSUSBLOG_TEST_SOURCE_COMMIT', 'FSUSBLOG_TEST_SOURCE_FINGERPRINT']
        .some((key) => observedBackend.environment[key] !== configuredEnvironment[key])
    || JSON.stringify(observedBackend.commandLine) !== JSON.stringify([backendContainer.Path, ...backendContainer.Args])
    || !observedBackend.commandLine.some((argument) => /FsusBlog\.Server(?:\.dll)?$/u.test(argument)))
{
    throw new Error('backend container process identity does not bind Docker config, procfs, run, namespace, role, and source');
}
const fixtureRoot = confined(root, String(args['fixture-root']).replace(/^\.\//u, ''), 'fixture root');
if (!fs.existsSync(fixtureRoot) || !fs.lstatSync(fixtureRoot).isDirectory() || fs.lstatSync(fixtureRoot).isSymbolicLink())
{
    throw new Error('fixture root is unavailable');
}
const document = {
    schema: 'fsusblog.release-reliability-runtime-topology.v1', status: 'complete', runId: args['run-id'], namespace: args.namespace,
    root: path.relative(root, fixtureRoot).replaceAll(path.sep, '/'), config: file(root, args.config, 'config'), schemaFile: file(root, args.schema, 'schema'), seed: file(root, args.seed, 'seed'),
    auditRetentionPolicy: file(root, args['audit-retention-policy'], 'audit retention policy'),
    resourceState: {
        postgres: readDockerPostgresqlDatabaseState({ container: postgresContainer.Id }),
        redis: await readDockerPublicCacheState({ container: redisContainer.Id,
            namespacePrefix: runtimeEnvironment.RedisOptions__InstanceName })
    },
    runtime: {
        profile: 'docker-final-image',
        imageDigest: args['image-digest'],
        sourceState: { commit: args['source-commit'], worktreeFingerprint: args['source-fingerprint'] },
        image: { reference: args['runtime-image'], id: runtimeImage.Id, revision: runtimeImage.Config.Labels['org.opencontainers.image.revision'], layers: runtimeImage.RootFS.Layers, layersDigest: digestValue({ layers: runtimeImage.RootFS.Layers }) },
        backendContainer: {
            id: backendContainer.Id,
            image: backendContainer.Image,
            configuredImage: backendContainer.Config.Image,
            hostPid: backendContainer.State.Pid,
            environment: backendContainer.Config.Env,
            path: backendContainer.Path,
            args: backendContainer.Args,
            startedAt: backendContainer.State.StartedAt,
            health: {
                status: backendContainer.State.Health.Status,
                configuration: containerHealthcheck,
                configurationDigest: digest(JSON.stringify(canonical(containerHealthcheck)))
            },
            portBinding: {
                containerPort: 8080,
                hostIp: '127.0.0.1',
                hostPort: Number(backendHostPort),
                protocol: 'tcp'
            }
        },
        network: {
            id: runtimeNetwork.Id,
            name: runtimeNetwork.Name,
            driver: runtimeNetwork.Driver,
            labels: networkLabels,
            backend: { containerId: backendContainer.Id, ...backendAttachment },
            postgres: { containerId: postgresContainer.Id, ...postgresAttachment },
            redis: { containerId: redisContainer.Id, ...redisAttachment }
        },
        environmentProjection: {
            source: 'strict-runtime-env-plus-audited-container-overrides',
            effective: expectedContainerEnvironment
        },
        process: observedBackend
    },
    postgres: (() =>
    {
        const value = { id: postgresContainer.Id, image: postgresContainer.Config.Image, imageId: postgresContainer.Image, labels: postgresContainer.Config.Labels ?? {} };
        return { instance: value.id, imageId: value.imageId, version: 'docker-inspected', configDigest: digest(JSON.stringify(canonical(value))) };
    })(),
    redis: (() =>
    {
        const value = { id: redisContainer.Id, image: redisContainer.Config.Image, imageId: redisContainer.Image, labels: redisContainer.Config.Labels ?? {} };
        return { instance: value.id, imageId: value.imageId, version: 'docker-inspected', configDigest: digest(JSON.stringify(canonical(value))) };
    })(), contentDigest: null
};
document.contentDigest = digestValue(document);
const output = confined(root, String(args.out).replace(/^\.\//u, ''), '--out');
fs.mkdirSync(path.dirname(output), { recursive: true });
if (fs.existsSync(output) && (!fs.lstatSync(output).isFile() || fs.lstatSync(output).isSymbolicLink()))
{
    throw new Error('--out is not a regular file');
}
fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
