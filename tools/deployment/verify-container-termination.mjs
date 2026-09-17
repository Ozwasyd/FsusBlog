#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    checkProductionComposeEnvironment
} from './check-production-compose-environment.mjs';

export const productionImageTerminationSchema = 'fsusblog.production-image-termination.v1';

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(modulePath), '../..');
const containerIdPattern = /^[0-9a-f]{64}$/u;
const identifierPattern = /^[a-z0-9][a-z0-9_.-]*$/u;

function inspectContainer(containerId)
{
    const result = spawnSync('docker', ['inspect', containerId], {
        encoding: 'utf8',
        timeout: 15_000
    });
    if (result.status !== 0)
    {
        throw new Error(`Docker inspect failed: ${String(result.stderr ?? '').trim()}`);
    }
    let documents;
    try
    {
        documents = JSON.parse(String(result.stdout));
    }
    catch
    {
        throw new Error('Docker inspect returned invalid JSON');
    }
    if (!Array.isArray(documents) || documents.length !== 1)
    {
        throw new Error('Docker inspect must return exactly one container');
    }
    return documents[0];
}

function assertOwnedContainer(container, { containerId, runId, namespace, running })
{
    const labels = container?.Config?.Labels ?? {};
    if (container?.Id !== containerId
        || labels['io.fsusblog.test.run-id'] !== runId
        || labels['io.fsusblog.test.namespace'] !== namespace
        || container?.State?.Running !== running)
    {
        throw new Error('container identity, ownership, or running state is invalid');
    }
}

export function validateStoppedContainerState(container, {
    containerId,
    runId,
    namespace,
    elapsedMilliseconds,
    stopGracePeriodSeconds
})
{
    assertOwnedContainer(container, {
        containerId,
        runId,
        namespace,
        running: false
    });
    const state = container.State;
    if (state.ExitCode !== 0
        || state.OOMKilled !== false
        || String(state.Error ?? '') !== ''
        || typeof state.FinishedAt !== 'string'
        || !Number.isFinite(Date.parse(state.FinishedAt))
        || !Number.isFinite(elapsedMilliseconds)
        || elapsedMilliseconds < 0
        || elapsedMilliseconds >= stopGracePeriodSeconds * 1000)
    {
        throw new Error('container did not exit cleanly on SIGTERM within stop_grace_period');
    }
    return {
        exitCode: state.ExitCode,
        oomKilled: state.OOMKilled,
        error: state.Error,
        finishedAtUtc: new Date(Date.parse(state.FinishedAt)).toISOString()
    };
}

function resolveOutput(root, configuredPath)
{
    const relative = String(configuredPath ?? '').replaceAll('\\', '/').replace(/^\.\//u, '');
    if (!relative.startsWith('.tmp/release-reliability/')
        || path.posix.isAbsolute(relative)
        || path.posix.normalize(relative) !== relative
        || relative.split('/').includes('..'))
    {
        throw new Error('--out must be a normalized path below .tmp/release-reliability');
    }
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}.tmp${path.sep}release-reliability${path.sep}`))
    {
        throw new Error('--out escapes the runtime evidence root');
    }
    return { absolute, relative };
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.next-${process.pid}`;
    try
    {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600
        });
        fs.renameSync(temporary, file);
        fs.chmodSync(file, 0o400);
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }
}

function main()
{
    const [containerId, runId, namespace, invocationId, ...extra] = process.argv.slice(2);
    if (extra.length > 0)
    {
        throw new Error('usage: verify-container-termination.mjs <container-id> <run-id> <namespace> <invocation-id>');
    }
    const root = defaultRoot;
    if (!containerIdPattern.test(containerId)
        || !identifierPattern.test(runId)
        || !identifierPattern.test(namespace)
        || !identifierPattern.test(invocationId))
    {
        throw new Error('container or invocation identity is invalid');
    }
    const environment = checkProductionComposeEnvironment({ root });
    if (environment.errors.length > 0)
    {
        throw new Error(`production Compose environment contract failed: ${environment.errors.join('; ')}`);
    }
    const stopGracePeriodSeconds = environment.stopGracePeriodSeconds;
    const output = resolveOutput(
        root,
        `.tmp/release-reliability/${invocationId}/production-image-termination.json`
    );
    const before = inspectContainer(containerId);
    assertOwnedContainer(before, {
        containerId,
        runId,
        namespace,
        running: true
    });
    if (before.State?.Health?.Status !== 'healthy')
    {
        throw new Error('container must be healthy before SIGTERM verification');
    }

    const started = performance.now();
    const stopped = spawnSync(
        'docker',
        [
            'stop',
            '--signal',
            'SIGTERM',
            '--timeout',
            String(stopGracePeriodSeconds),
            containerId
        ],
        {
            encoding: 'utf8',
            timeout: (stopGracePeriodSeconds + 10) * 1000
        }
    );
    const elapsedMilliseconds = Math.round(performance.now() - started);
    if (stopped.status !== 0 || String(stopped.stdout ?? '').trim() !== containerId)
    {
        throw new Error(`Docker stop failed: ${String(stopped.stderr ?? '').trim()}`);
    }
    const after = inspectContainer(containerId);
    const state = validateStoppedContainerState(after, {
        containerId,
        runId,
        namespace,
        elapsedMilliseconds,
        stopGracePeriodSeconds
    });
    const observation = {
        schema: productionImageTerminationSchema,
        status: 'passed',
        container: {
            id: containerId,
            runId,
            namespace
        },
        signal: 'SIGTERM',
        stopGracePeriodSeconds,
        elapsedMilliseconds,
        state
    };
    writeJsonAtomic(output.absolute, observation);
    process.stdout.write(
        `[production-image-termination] passed container=${containerId} elapsedMs=${elapsedMilliseconds} graceSeconds=${stopGracePeriodSeconds} evidence=${output.relative}\n`
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath)
{
    try
    {
        main();
    }
    catch (error)
    {
        process.stderr.write(`[production-image-termination] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
