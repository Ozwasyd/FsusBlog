#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readRuntimeEnvironment } from './bundles/runtime-environment.mjs';

const safeIdPattern = /^[a-z0-9][a-z0-9_.-]*$/u;
const readableFields = new Map([
    ['backend-port', 'FSUSBLOG_DEBUG_BACKEND_PORT'],
    ['backend-url', 'FSUSBLOG_DEBUG_BACKEND_URL'],
    ['postgres-container', 'FSUSBLOG_POSTGRES_CONTAINER_NAME'],
    ['redis-container', 'FSUSBLOG_REDIS_CONTAINER_NAME']
]);
const staticAuditedContainerOverrides = Object.freeze({
    FSUSBLOG_DATA_ROOT: '/app/data',
    PublicAot__SsrClientRoot: '/app/wwwroot',
    ASPNETCORE_URLS: 'http://0.0.0.0:8080',
    AllowedHosts: '127.0.0.1;localhost',
    ConnectionStrings__DefaultConnection: 'Host=postgres;Port=5432;Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Include Error Detail=true',
    ConnectionStrings__Redis: 'redis:6379,abortConnect=false,connectTimeout=10000',
    RedisOptions__Configuration: 'redis:6379,abortConnect=false,connectTimeout=10000',
    DOTNET_DbgEnableMiniDump: '1',
    DOTNET_DbgMiniDumpType: '4',
    DOTNET_DbgMiniDumpName: '/app/runtime-cache/coredump.%p',
    DOTNET_EnableCrashReport: '1',
    DOTNET_CreateDumpDiagnostics: '1',
    DOTNET_CreateDumpLogToFile: '/app/runtime-cache/createdump.log'
});
const dynamicAuditedContainerOverrideKeys = Object.freeze([
    'FSUSBLOG_TEST_RUN_ID',
    'FSUSBLOG_TEST_NAMESPACE',
    'FSUSBLOG_RUNTIME_ROLE',
    'FSUSBLOG_TEST_SOURCE_COMMIT',
    'FSUSBLOG_TEST_SOURCE_FINGERPRINT'
]);
export const releaseReliabilityAuditedContainerOverrideKeys = Object.freeze([
    ...Object.keys(staticAuditedContainerOverrides),
    ...dynamicAuditedContainerOverrideKeys
]);
const releaseReliabilityAuditedContainerOverrideKeySet = new Set(
    releaseReliabilityAuditedContainerOverrideKeys
);

function safeId(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!safeIdPattern.test(normalized))
    {
        throw new Error(`${label} is invalid`);
    }
    return normalized;
}

export function releaseReliabilityAuditedContainerOverrides({
    runId,
    namespace,
    sourceCommit,
    sourceFingerprint
})
{
    return {
        ...staticAuditedContainerOverrides,
        FSUSBLOG_TEST_RUN_ID: runId,
        FSUSBLOG_TEST_NAMESPACE: namespace,
        FSUSBLOG_RUNTIME_ROLE: 'backend',
        FSUSBLOG_TEST_SOURCE_COMMIT: sourceCommit,
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceFingerprint
    };
}

export function projectQualifiedContainerEnvironment(environment)
{
    return Object.fromEntries(Object.entries(environment)
        .filter(([key]) => !releaseReliabilityAuditedContainerOverrideKeySet.has(key))
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export function readQualifiedRuntimeEnvironment({ repositoryRoot, namespace, runId })
{
    const resolvedRoot = path.resolve(repositoryRoot);
    const expectedNamespace = safeId(namespace, 'namespace');
    const expectedRunId = safeId(runId, 'run ID');
    const environment = readRuntimeEnvironment(resolvedRoot, expectedNamespace);
    if (environment.FSUSBLOG_TEST_RUN_ID !== expectedRunId)
    {
        throw new Error('runtime environment run ID does not match the qualified run');
    }
    if (environment.FSUSBLOG_POSTGRES_CONTAINER_NAME !== `fsusblog-test-postgres-${expectedNamespace}`
        || environment.FSUSBLOG_REDIS_CONTAINER_NAME !== `fsusblog-test-redis-${expectedNamespace}`)
    {
        throw new Error('runtime environment service containers do not match the qualified namespace');
    }
    if (environment.ASPNETCORE_URLS !== environment.FSUSBLOG_DEBUG_BACKEND_URL)
    {
        throw new Error('runtime environment backend URL does not match ASPNETCORE_URLS');
    }
    if (!/^\d+$/u.test(environment.FSUSBLOG_DEBUG_BACKEND_PORT)
        || Number(environment.FSUSBLOG_DEBUG_BACKEND_PORT) < 1
        || Number(environment.FSUSBLOG_DEBUG_BACKEND_PORT) > 65535)
    {
        throw new Error('runtime environment backend port is invalid');
    }
    return environment;
}

function ensureDirectory(parent, name, mode)
{
    const directory = path.join(parent, name);
    if (!fs.existsSync(directory))
    {
        fs.mkdirSync(directory, { mode });
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
    {
        throw new Error('container environment projection path contains a non-directory or symlink');
    }
    return directory;
}

function writeAtomicPrivateFile(output, contents)
{
    if (fs.existsSync(output))
    {
        const existing = fs.lstatSync(output);
        if (!existing.isFile() || existing.isSymbolicLink())
        {
            throw new Error('container environment projection output is not a regular file');
        }
    }
    const temporary = path.join(
        path.dirname(output),
        `.container.env.${process.pid}.${randomUUID()}.tmp`
    );
    let descriptor;
    try
    {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, contents, { encoding: 'utf8' });
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, output);
        fs.chmodSync(output, 0o600);
    }
    finally
    {
        if (descriptor !== undefined)
        {
            fs.closeSync(descriptor);
        }
        fs.rmSync(temporary, { force: true });
    }
}

export function writeQualifiedContainerEnvironmentProjection({
    repositoryRoot,
    namespace,
    runId
})
{
    const resolvedRoot = path.resolve(repositoryRoot);
    const expectedRunId = safeId(runId, 'run ID');
    const expectedNamespace = safeId(namespace, 'namespace');
    const environment = readQualifiedRuntimeEnvironment({
        repositoryRoot: resolvedRoot,
        namespace: expectedNamespace,
        runId: expectedRunId
    });
    const projection = projectQualifiedContainerEnvironment(environment);
    const contents = `${Object.entries(projection)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`;
    const temporaryRoot = ensureDirectory(resolvedRoot, '.tmp', 0o700);
    const environmentRoot = ensureDirectory(temporaryRoot, 'env', 0o700);
    fs.chmodSync(environmentRoot, 0o700);
    const output = path.join(
        environmentRoot,
        `${expectedNamespace}.${expectedRunId}.container.env`
    );
    writeAtomicPrivateFile(output, contents);
    return output;
}

function parseArguments(argumentsList)
{
    const operation = argumentsList.shift();
    const allowedArguments = operation === 'get'
        ? ['root', 'namespace', 'run-id', 'field']
        : operation === 'project-container-environment'
            ? ['root', 'namespace', 'run-id']
            : null;
    if (allowedArguments === null)
    {
        throw new Error('operation must be get or project-container-environment');
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
        if (!allowedArguments.includes(key))
        {
            throw new Error(`unknown argument --${key}`);
        }
        if (Object.hasOwn(values, key))
        {
            throw new Error(`duplicate argument --${key}`);
        }
        values[key] = value;
    }
    for (const name of allowedArguments)
    {
        if (!values[name])
        {
            throw new Error(`--${name} is required`);
        }
    }
    if (operation === 'get' && !readableFields.has(values.field))
    {
        throw new Error('--field is not an approved non-secret runtime field');
    }
    return { operation, ...values };
}

function main()
{
    const options = parseArguments(process.argv.slice(2));
    if (options.operation === 'project-container-environment')
    {
        process.stdout.write(writeQualifiedContainerEnvironmentProjection({
            repositoryRoot: options.root,
            namespace: options.namespace,
            runId: options['run-id']
        }));
        return;
    }
    const environment = readQualifiedRuntimeEnvironment({
        repositoryRoot: options.root,
        namespace: options.namespace,
        runId: options['run-id']
    });
    process.stdout.write(environment[readableFields.get(options.field)]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main();
    }
    catch (error)
    {
        console.error(`[release-reliability-runtime-environment] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
