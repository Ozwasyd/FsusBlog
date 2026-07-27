#!/usr/bin/env node

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

function safeId(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!safeIdPattern.test(normalized))
    {
        throw new Error(`${label} is invalid`);
    }
    return normalized;
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

function parseArguments(argumentsList)
{
    const operation = argumentsList.shift();
    if (operation !== 'get')
    {
        throw new Error('operation must be get');
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
        if (!['root', 'namespace', 'run-id', 'field'].includes(key))
        {
            throw new Error(`unknown argument --${key}`);
        }
        if (Object.hasOwn(values, key))
        {
            throw new Error(`duplicate argument --${key}`);
        }
        values[key] = value;
    }
    for (const name of ['root', 'namespace', 'run-id', 'field'])
    {
        if (!values[name])
        {
            throw new Error(`--${name} is required`);
        }
    }
    if (!readableFields.has(values.field))
    {
        throw new Error('--field is not an approved non-secret runtime field');
    }
    return values;
}

function main()
{
    const options = parseArguments(process.argv.slice(2));
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
