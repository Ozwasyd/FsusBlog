import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { inspectOwnedPrivateTmp } from './execution-envelope-directories.mjs';
import { executeManagedPreparation, observeExecutableIdentity, observeExecutableIdentityAsync } from './execution-envelope-environment.mjs';
import { admitsPrivateDotnetScratch, privateDotnetScratchPath } from './physical-execution-private-dotnet-scratch.mjs';
const { executionEnvelopeDigest } = await import(new URL('../test-matrix/execution-envelope-policy.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const landlockSource = path.join(
    root,
    'tools/test/native/execution-envelope-landlock.c'
);
export const executionNetworkPolicyFile = path.join(
    root,
    'config/testing/test-execution-network-policy.json'
);
export const executionEnvelopeNetworkSchema =
    'fsusblog.test-execution-envelope-network.v1';
const standardWritableFiles = Object.freeze(['/dev/null']);

export function loadExecutionNetworkPolicy(file = executionNetworkPolicyFile)
{
    if (!fs.existsSync(file))
    {
        return { missing: true };
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function validateExecutionNetworkPolicy(policy)
{
    const errors = [];
    if (policy?.missing === true)
    {
        return ['execution network policy source is missing'];
    }
    if (policy?.schema !== 'fsusblog.test-execution-network-policy.v1'
        || policy?.correctnessDefault !== 'deny'
        || policy?.sandbox?.unavailable !== 'fail-closed')
    {
        errors.push('execution network policy must be versioned, default-deny, and fail closed');
    }
    if ((policy?.externalEndpoints ?? []).length !== 0)
    {
        errors.push('correctness external endpoints require an explicit reviewed catalog change');
    }
    for (const [id, endpoint] of Object.entries(policy?.serviceEndpoints ?? {}))
    {
        if (endpoint.protocol !== 'tcp'
            || endpoint.host !== '127.0.0.1'
            || endpoint.portSource !== 'service-envelope'
            || endpoint.proxy !== 'denied')
        {
            errors.push(`${id}: service endpoint projection is invalid`);
        }
    }
    return errors;
}

function requiredTool(name, pathValue)
{
    try
    {
        return observeExecutableIdentity(name, {
            pathValue,
            ...(name === 'ip' ? {
                observeVersion: (file) => spawnSync(file, ['-Version'], {
                    encoding: 'utf8',
                    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' },
                    shell: false,
                    windowsHide: true
                })
            } : {})
        });
    }
    catch (error)
    {
        throw new Error(`correctness network sandbox is unavailable: ${name}`, { cause: error });
    }
}

function landlockCompilerArguments(output)
{
    return [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-o',
        output,
        landlockSource
    ];
}

export function buildLandlockHelper({ output, pathValue, environment })
{
    const compiler = requiredTool('cc', pathValue);
    const compilation = spawnSync(compiler.absolutePath, landlockCompilerArguments(output), {
        encoding: 'utf8',
        env: environment,
        shell: false,
        windowsHide: true
    });
    if (compilation.error || compilation.status !== 0)
    {
        throw new Error(
            `correctness filesystem sandbox is unavailable: Landlock helper build failed: ${String(compilation.stderr ?? '').trim()}`
        );
    }
    fs.chmodSync(output, 0o700);
    return {
        compiler,
        helper: observeExecutableIdentity(output, { pathValue })
    };
}

function endpointKey(endpoint)
{
    return `${endpoint.protocol}:${endpoint.host}:${endpoint.port}`;
}

function servicePort(service)
{
    if (service?.kind === 'run-owned-process')
    {
        return service.topology?.port;
    }
    if (service?.kind === 'container')
    {
        const ports = [...(service.ports ?? [])]
            .filter((entry) => Number.isInteger(Number(entry.hostPort)))
            .map((entry) => Number(entry.hostPort));
        return ports.length === 1 ? ports[0] : null;
    }
    return null;
}

export function projectPlannedEndpoints({ services, serviceEnvelope, policy })
{
    const endpoints = [];
    const plannedServices = new Map(
        (serviceEnvelope?.planned?.services ?? []).map((entry) => [entry.id, entry])
    );
    for (const service of [...services].sort())
    {
        const declaration = policy.serviceEndpoints[service];
        if (!declaration)
        {
            throw new Error(`${service}: planned network endpoint declaration is missing`);
        }
        const port = Number(servicePort(plannedServices.get(service)));
        if (!Number.isInteger(port) || port < 1 || port > 65_535)
        {
            throw new Error(`${service}: planned service-envelope network port is missing or invalid`);
        }
        endpoints.push({
            id: service,
            protocol: declaration.protocol,
            host: declaration.host,
            port,
            dns: declaration.dns,
            certificate: declaration.certificate,
            proxy: declaration.proxy
        });
    }
    return endpoints;
}

async function requiredToolAsync(name, options)
{
    try
    {
        return await observeExecutableIdentityAsync(name, {
            ...options,
            ...(name === 'ip' ? { versionArgs: ['-Version'] } : {})
        });
    }
    catch (error)
    {
        throw new Error(`correctness network sandbox is unavailable: ${name}`, { cause: error });
    }
}

async function buildLandlockHelperAsync({ output, ...options })
{
    const compiler = await requiredToolAsync('cc', options);
    await executeManagedPreparation({
        purpose: 'landlock-helper-build',
        command: [compiler.absolutePath, ...landlockCompilerArguments(output)],
        cwd: options.cwd,
        environment: options.environment
    }, options);
    fs.chmodSync(output, 0o700);
    return {
        compiler,
        helper: await observeExecutableIdentityAsync(output, options)
    };
}

export function prepareNetworkSandbox({
    command,
    // eslint-disable-next-line no-unused-vars
    cwd,
    directories,
    ownedDirectoryEnvelope = null,
    writableRoots,
    plannedEndpoints = [],
    environment,
    policy,
    producerId = null,
    attemptId = null,
    platform = process.platform,
    pathValue = environment.PATH
})
{
    if (platform !== 'linux')
    {
        throw new Error(`correctness network sandbox is unavailable on ${platform}`);
    }
    const observer = requiredTool('strace', pathValue);
    const bindings = prepareNetworkBindings({ directories, ownedDirectoryEnvelope, writableRoots, environment, producerId, attemptId });
    const landlock = buildLandlockHelper({
        output: bindings.landlockExecutable,
        pathValue,
        environment: {
            ...environment,
            TMPDIR: directories.temp,
            TMP: directories.temp,
            TEMP: directories.temp
        }
    });
    return projectPreparedNetworkSandbox({ command, plannedEndpoints, environment, policy, observer, landlock, ...bindings });
}

export function prepareNetworkBindings({ directories, ownedDirectoryEnvelope, writableRoots, environment, producerId, attemptId })
{
    const networkLog = path.join(directories.toolCache, 'network.strace');
    const bindings = new Set([
        ...Object.values(directories),
        ...writableRoots
    ]);
    const readWritePaths = [...bindings, ...standardWritableFiles].sort();
    const privateTmpCapability = ownedDirectoryEnvelope?.privateTmpCapability ?? null;
    const ownedPrivateTmp = ownedDirectoryEnvelope
        ? inspectOwnedPrivateTmp(privateTmpCapability, { environment, readWritePaths }) : null;
    if (ownedPrivateTmp && (ownedDirectoryEnvelope.fragment.directories !== directories
        || ownedPrivateTmp.source !== directories.temp))
    {
        throw new Error('private /tmp alias belongs to a different directory owner');
    }
    const privateDotnetScratch = admitsPrivateDotnetScratch({ producerId, attemptId, environment });
    if (privateDotnetScratch && (!ownedPrivateTmp
        || ownedPrivateTmp.producerId !== producerId || ownedPrivateTmp.attemptId !== attemptId))
    {
        throw new Error('private .NET scratch requires the exact current-attempt owned /tmp alias');
    }
    const landlockExecutable = path.join(
        directories.toolCache,
        'execution-envelope-landlock'
    );
    return { networkLog, readWritePaths, privateTmpCapability, ownedPrivateTmp, privateDotnetScratch, landlockExecutable };
}

function projectPreparedNetworkSandbox({ command, plannedEndpoints, environment, policy, observer, landlock,
    networkLog, readWritePaths, privateTmpCapability, ownedPrivateTmp, privateDotnetScratch })
{
    const landlockReadWritePaths = privateDotnetScratch
        ? [...readWritePaths, privateDotnetScratchPath].sort()
        : readWritePaths;
    return {
        command: [
            observer.absolutePath,
            '-f',
            '-qq',
            '-e',
            'trace=network',
            '-o',
            networkLog,
            '--',
            landlock.helper.absolutePath,
            ...(ownedPrivateTmp ? [
                '--owned-tmp-source', ownedPrivateTmp.source,
                '--owned-tmp-device', ownedPrivateTmp.device,
                '--owned-tmp-inode', ownedPrivateTmp.inode,
                '--owned-tmp-uid', ownedPrivateTmp.uid
            ] : []),
            ...landlockReadWritePaths.flatMap((entry) => [
                standardWritableFiles.includes(entry) ? '--writable-file' : '--writable',
                entry
            ]),
            '--',
            ...command
        ],
        linuxPrivateNetwork: false,
        linuxNetworkPolicy: {
            deny: 'any',
            allow: 'localhost'
        },
        linuxReadWritePaths: readWritePaths,
        linuxOwnedPrivateTmp: privateTmpCapability,
        privateDotnetScratch,
        networkLog,
        fragment: {
            schema: executionEnvelopeNetworkSchema,
            qualificationEligible: true,
            policyDigest: executionEnvelopeDigest(policy),
            defaultPolicy: 'deny',
            sandbox: {
                observer,
                networkNamespace: 'systemd-ip-address-deny-any-allow-localhost-per-attempt',
                filesystem: {
                    enforcement: 'landlock-default-deny-write',
                    source: path.relative(root, landlockSource),
                    compiler: landlock.compiler,
                    helper: landlock.helper,
                    privateTmp: true,
                    ...(ownedPrivateTmp ? { ownedPrivateTmp } : {}),
                    privateDotnetScratch: privateDotnetScratch ? privateDotnetScratchPath : null,
                    readWritePaths: landlockReadWritePaths,
                    systemdReadWritePaths: readWritePaths
                }
            },
            planned: {
                endpoints: [...plannedEndpoints].sort((left, right) =>
                    endpointKey(left).localeCompare(endpointKey(right))),
                dns: [],
                proxy: Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']
                    .map((name) => [name, environment[name] ?? null])),
                certificates: Object.fromEntries([
                    'SSL_CERT_DIR',
                    'SSL_CERT_FILE',
                    'NODE_EXTRA_CA_CERTS'
                ].map((name) => [name, environment[name] ?? null]))
            },
            actual: null,
            admission: 'pending'
        }
    };
}

export async function prepareNetworkSandboxAsync({
    command, cwd, directories, ownedDirectoryEnvelope = null, writableRoots, plannedEndpoints = [],
    environment, policy, producerId = null, attemptId = null,
    executePreparation, assertPreparationExecution, platform = process.platform, pathValue = environment.PATH
})
{
    if (platform !== 'linux')
    {
        throw new Error(`correctness network sandbox is unavailable on ${platform}`);
    }
    if (typeof executePreparation !== 'function' || typeof assertPreparationExecution !== 'function')
    {
        throw new Error('asynchronous network preparation requires the original held-managed owner port');
    }
    const toolOptions = { cwd, pathValue, environment, executePreparation, assertPreparationExecution };
    const observer = await requiredToolAsync('strace', toolOptions);
    const bindings = prepareNetworkBindings({ directories, ownedDirectoryEnvelope, writableRoots, environment, producerId, attemptId });
    const landlock = await buildLandlockHelperAsync({
        ...toolOptions,
        output: bindings.landlockExecutable,
        environment: { ...environment, TMPDIR: directories.temp, TMP: directories.temp, TEMP: directories.temp }
    });
    return projectPreparedNetworkSandbox({ command, plannedEndpoints, environment, policy, observer, landlock, ...bindings });
}

function observedConnections(source)
{
    const connections = [];
    for (const line of String(source).split(/\r?\n/u))
    {
        const ipv4 = line.match(/connect\([^,]+, \{sa_family=AF_INET, sin_port=htons\((\d+)\), sin_addr=inet_addr\("([^"]+)"\)/u);
        const ipv6 = line.match(/connect\([^,]+, \{sa_family=AF_INET6, sin6_port=htons\((\d+)\).*inet_pton\(AF_INET6, "([^"]+)"/u);
        const match = ipv4 ?? ipv6;
        if (!match)
        {
            continue;
        }
        const host = match[2];
        connections.push({
            protocol: 'tcp',
            host,
            port: Number(match[1]),
            result: line.includes('= 0') ? 'connected' : 'denied-or-failed'
        });
    }
    return [...new Map(connections.map((entry) => [
        `${endpointKey(entry)}:${entry.result}`,
        entry
    ])).values()].sort((left, right) => endpointKey(left).localeCompare(endpointKey(right)));
}

export function finalizeNetworkSandbox(prepared)
{
    if (!fs.existsSync(prepared.networkLog))
    {
        throw new Error('correctness network observation is unavailable');
    }
    const connections = observedConnections(fs.readFileSync(prepared.networkLog, 'utf8'));
    const planned = new Set(prepared.fragment.planned.endpoints.map(endpointKey));
    const actual = new Set(connections.map(endpointKey));
    const unknown = connections.filter((entry) => !planned.has(endpointKey(entry)));
    const missing = prepared.fragment.planned.endpoints.filter((entry) => !actual.has(endpointKey(entry)));
    for (const connection of connections)
    {
        if (net.isIP(connection.host) === 0)
        {
            throw new Error(`correctness network observation contains an unparsed host: ${connection.host}`);
        }
    }
    prepared.fragment.actual = {
        connections,
        dns: connections.filter((entry) => entry.port === 53),
        proxy: prepared.fragment.planned.proxy,
        certificates: prepared.fragment.planned.certificates,
        deniedAttempts: connections.filter((entry) => entry.result !== 'connected')
    };
    if (unknown.length > 0 || missing.length > 0)
    {
        prepared.fragment.admission = 'rejected';
        throw new Error(
            `correctness network planned/actual drift unknown=${unknown.map(endpointKey).join(',') || 'none'} missing=${missing.map(endpointKey).join(',') || 'none'}`
        );
    }
    prepared.fragment.admission = 'planned-actual-exact';
    return prepared.fragment;
}
