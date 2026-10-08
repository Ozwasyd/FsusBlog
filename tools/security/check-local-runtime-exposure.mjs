#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultOutputFile = path.join(root, '.tmp', 'security', 'local-runtime-exposure.json');
const requiredSecurityHeaders = {
    'content-security-policy': (value) => value.length > 0,
    'permissions-policy': (value) => value.length > 0,
    'referrer-policy': (value) => value.length > 0,
    'x-content-type-options': (value) => value.toLowerCase() === 'nosniff',
    'x-frame-options': (value) => value.toUpperCase() === 'DENY'
};

function positivePort(value, label)
{
    const text = String(value ?? '');
    const port = Number.parseInt(text, 10);
    if (!/^\d+$/u.test(text) || port < 1 || port > 65535)
    {
        throw new Error(`${label}-invalid-port`);
    }
    return port;
}

function positiveDuration(value, label)
{
    const text = String(value ?? '');
    const duration = Number.parseInt(text, 10);
    if (!/^\d+$/u.test(text) || duration < 1)
    {
        throw new Error(`${label}-invalid-duration`);
    }
    return duration;
}

export function assertLoopbackRuntimeOrigin(value, label)
{
    let url;
    try
    {
        url = new URL(value);
    }
    catch
    {
        throw new Error(`${label}-invalid-origin`);
    }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase()))
    {
        throw new Error(`${label}-not-loopback-http`);
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port)
    {
        throw new Error(`${label}-must-be-port-origin`);
    }
    return { origin: url.origin, port: positivePort(url.port, label) };
}

function listenerHost(address, port)
{
    const suffix = `:${port}`;
    if (!address.endsWith(suffix))
    {
        return null;
    }
    const host = address.slice(0, -suffix.length).replace(/^\[|\]$/gu, '');
    return host;
}

export function listenerAddressesForPort(ssOutput, port)
{
    return String(ssOutput).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).flatMap((line) =>
    {
        const fields = line.split(/\s+/u);
        const address = fields[3];
        return listenerHost(address ?? '', port) === null ? [] : [address];
    });
}

function isLoopbackHost(host)
{
    return ['127.0.0.1', '::1', 'localhost'].includes(String(host ?? '').replace(/^\[|\]$/gu, '').toLowerCase());
}

export function validateContainerBindings(bindings, internalPort, expectedHostPort, label)
{
    const rows = bindings?.[`${internalPort}/tcp`];
    if (!Array.isArray(rows) || rows.length === 0)
    {
        return [`${label}-binding-missing`];
    }
    const failures = [];
    for (const row of rows)
    {
        if (!isLoopbackHost(row?.HostIp))
        {
            failures.push(`${label}-binding-not-loopback`);
        }
        if (positivePort(row?.HostPort, label) !== expectedHostPort)
        {
            failures.push(`${label}-binding-port-mismatch`);
        }
    }
    return failures;
}

async function readSystemListeners()
{
    const { stdout } = await execFileAsync('ss', ['-H', '-ltn'], { encoding: 'utf8' });
    return stdout;
}

async function inspectContainerBindings(container)
{
    const { stdout } = await execFileAsync('docker', [
        'inspect', '--format', '{{json .HostConfig.PortBindings}}', container
    ], { encoding: 'utf8' });
    return JSON.parse(stdout);
}

async function writeSummary(outputFile, summary)
{
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return Object.freeze([outputFile]);
}

export async function runLocalRuntimeExposure({
    env = process.env,
    fetchImpl = fetch,
    readListeners = readSystemListeners,
    inspectBindings = inspectContainerBindings,
    outputFile = defaultOutputFile,
    now = () => Date.now(),
    resultOutlet = null
} = {})
{
    const startedAtMs = now();
    const failures = [];
    const targetResults = [];
    const listenerResults = [];
    const containerResults = [];
    let targets = [];
    try
    {
        const requestTimeoutMs = positiveDuration(env.FSUSBLOG_SECURITY_HTTP_TIMEOUT_MS || env.FSUSBLOG_HTTP_TIMEOUT_MS || '15000', 'http-timeout');
        targets = [
            ['backend', env.FSUSBLOG_BASE_URL || env.FSUSBLOG_DEBUG_BACKEND_URL, '/api/binary/auth/pow-challenge'],
            ['frontend', env.PLAYWRIGHT_BASE_URL || env.FSUSBLOG_DEBUG_FRONTEND_URL, '/'],
            ['release-preview', env.FSUSBLOG_RELEASE_PREVIEW_URL, '/']
        ].map(([id, value, probePath]) => ({ id, ...assertLoopbackRuntimeOrigin(value, id), probePath }));

        const [listenerOutput, probeResults, postgresBindings, redisBindings] = await Promise.all([
            readListeners(),
            Promise.all(targets.map(async (target) =>
            {
                try
                {
                    const response = await fetchImpl(`${target.origin}${target.probePath}`, {
                        headers: { Accept: target.id === 'backend' ? 'application/octet-stream' : 'text/html' },
                        signal: AbortSignal.timeout(requestTimeoutMs)
                    });
                    const headerChecks = target.id === 'backend'
                        ? Object.fromEntries(Object.entries(requiredSecurityHeaders).map(([name, validate]) =>
{
                const value = response.headers.get(name) ?? '';
                return [name, validate(value)];
              }))
                        : {};
                    await response.body?.cancel();
                    return { id: target.id, status: response.status, headerChecks };
                }
                catch
                {
                    return { id: target.id, status: null, headerChecks: {}, requestFailed: true };
                }
            })),
            inspectBindings(env.FSUSBLOG_POSTGRES_CONTAINER_NAME || env.FSUSBLOG_PG_CONTAINER),
            inspectBindings(env.FSUSBLOG_REDIS_CONTAINER_NAME || env.FSUSBLOG_REDIS_CONTAINER)
        ]);
        targetResults.push(...probeResults);
        for (const result of targetResults)
        {
            if (!Number.isInteger(result.status) || result.status >= 500)
            {
                failures.push(`${result.id}-probe-failed`);
            }
            for (const [header, passed] of Object.entries(result.headerChecks))
            {
                if (!passed)
                {
                    failures.push(`${result.id}-header-${header}-failed`);
                }
            }
        }
        for (const target of targets)
        {
            const addresses = listenerAddressesForPort(listenerOutput, target.port);
            listenerResults.push({ id: target.id, port: target.port, addresses });
            if (addresses.length === 0)
            {
                failures.push(`${target.id}-listener-missing`);
            }
            if (addresses.some((address) => !isLoopbackHost(listenerHost(address, target.port))))
            {
                failures.push(`${target.id}-listener-not-loopback`);
            }
        }

        const postgresPort = positivePort(env.FSUSBLOG_POSTGRES_PORT, 'postgres');
        const redisPort = positivePort(env.FSUSBLOG_REDIS_PORT, 'redis');
        const bindingChecks = [
            ['postgres', postgresBindings, 5432, postgresPort],
            ['redis', redisBindings, 6379, redisPort]
        ];
        for (const [id, bindings, internalPort, hostPort] of bindingChecks)
        {
            const bindingFailures = validateContainerBindings(bindings, internalPort, hostPort, id);
            containerResults.push({ id, internalPort, hostPort, loopbackOnly: bindingFailures.length === 0 });
            failures.push(...bindingFailures);
        }
    }
    catch (error)
    {
        const category = error instanceof Error && /^[a-z0-9-]+$/u.test(error.message)
            ? error.message
            : 'local-runtime-exposure-failed';
        failures.push(category);
    }

    const finishedAtMs = now();
    const uniqueFailures = [...new Set(failures)];
    const summary = {
        schema: 'fsusblog.security.local-runtime-exposure.v1',
        status: uniqueFailures.length === 0 ? 'ok' : 'failure',
        executionSource: 'fresh-loopback-runtime',
        namespace: env.FSUSBLOG_TEST_NAMESPACE || 'local',
        schedulerRunId: env.FSUSBLOG_TEST_RUN_ID || null,
        scope: {
            loopbackRuntimeOnly: true,
            externalProductionDnsChecked: false,
            externalFirewallEvidenceChecked: false,
            countsAsProductionCloseout: false
        },
        targets: targetResults,
        listeners: listenerResults,
        restrictedServices: containerResults,
        failures: uniqueFailures,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, finishedAtMs - startedAtMs)
    };
    const artifactPaths = await writeSummary(outputFile, summary);
    await resultOutlet?.({ summary, artifactPaths });
    return summary;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain)
{
    runLocalRuntimeExposure().then((summary) =>
    {
        console.log(`[local-runtime-exposure] ${summary.status}; failures=${summary.failures.length}; durationMs=${summary.durationMs}`);
        if (summary.status !== 'ok')
        {
            process.exitCode = 1;
        }
    }).catch(() =>
    {
        process.exitCode = 1;
    });
}
