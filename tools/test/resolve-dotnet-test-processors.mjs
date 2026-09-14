#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function firstGrant(env, names, label)
{
    for (const name of names)
    {
        if (!(name in env))
        {
            continue;
        }
        const value = Number(env[name]);
        if (!Number.isFinite(value) || value <= 0)
        {
            throw new Error(`${name} must be a finite positive ${label} grant`);
        }
        return value;
    }
    return null;
}

function configuredProcessorCount(env)
{
    const name = 'FSUSBLOG_DOTNET_TEST_PROCESSORS' in env
        ? 'FSUSBLOG_DOTNET_TEST_PROCESSORS'
        : ('DOTNET_PROCESSOR_COUNT' in env ? 'DOTNET_PROCESSOR_COUNT' : null);
    if (name === null)
    {
        return null;
    }
    const parsed = Number(env[name]);
    if (!Number.isInteger(parsed) || parsed <= 0)
    {
        throw new Error(`${name} must be a positive integer processor override`);
    }
    return parsed;
}

export function resolveDotnetTestProcessorCount({
    env = process.env,
    cpuCount = os.availableParallelism?.() ?? os.cpus().length,
    freeMemoryBytes = os.freemem(),
    totalMemoryBytes = os.totalmem(),
    load1 = os.loadavg()[0] ?? 0
} = {})
{
    const hostCpus = Math.max(1, Math.floor(Number(cpuCount) || 1));
    const hostMemory = Number(totalMemoryBytes);
    if (!Number.isFinite(hostMemory) || hostMemory <= 0)
    {
        throw new Error('totalMemoryBytes must be finite and positive');
    }
    const grantedCpu = firstGrant(env, [
        'FSUSBLOG_STEP_CPU_BUDGET',
        'FSUSBLOG_STEP_CPU_UNITS',
        'FSUSBLOG_BUNDLE_CPU_UNITS',
        'FSUSBLOG_BUNDLE_CPU_BUDGET',
        'FSUSBLOG_TIER_CPU_UNITS'
    ], 'CPU');
    const grantedMemoryGiB = firstGrant(env, [
        'FSUSBLOG_STEP_MEMORY_GIB',
        'FSUSBLOG_BUNDLE_MEMORY_GIB',
        'FSUSBLOG_TIER_MEMORY_GIB'
    ], 'memory');
    const cpus = grantedCpu === null ? hostCpus : Math.max(1, Math.floor(grantedCpu));
    const availableMemory = grantedMemoryGiB === null
        ? Math.max(0, Number(freeMemoryBytes) || 0)
        : grantedMemoryGiB * 1024 ** 3;
    const currentLoad = grantedCpu === null ? Math.max(0, Number(load1) || 0) : 0;
    const cpuCapacity = Math.max(1, Math.floor(cpus - Math.min(cpus - 1, currentLoad)));
    // A scheduler memory grant has already been admitted against the machine's
    // live capacity. Re-dividing it by os.totalmem()/availableParallelism() is
    // incorrect on cpuset-limited hosts, where totalmem still describes the
    // physical host and can collapse an eight-CPU grant to one processor.
    const memoryPerHostCpu = hostMemory / hostCpus;
    const memoryCapacity = grantedMemoryGiB === null
        ? Math.max(1, Math.floor(availableMemory / memoryPerHostCpu))
        : cpus;
    const grantCapacity = Math.max(1, Math.min(cpuCapacity, memoryCapacity));
    const configured = configuredProcessorCount(env);
    return configured ? Math.min(configured, grantCapacity) : grantCapacity;
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain)
{
    process.stdout.write(`${resolveDotnetTestProcessorCount()}\n`);
}
