#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const profile = process.argv[2] || 'default';

function readMemAvailableBytes()
{
    try
    {
        const text = fs.readFileSync('/proc/meminfo', 'utf8');
        const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
        if (match)
        {
            return Number(match[1]) * 1024;
        }
    }
    catch
    {
    // Fall back to os.freemem() on non-Linux hosts.
    }
    return os.freemem();
}

function readCpuTimes()
{
    try
    {
        const [line] = fs.readFileSync('/proc/stat', 'utf8').split('\n');
        const parts = line.trim().split(/\s+/);
        if (parts[0] !== 'cpu' || parts.length < 5)
        {
            return null;
        }

        const values = parts.slice(1).map((part) => Number(part));
        if (values.some((value) => !Number.isFinite(value)))
        {
            return null;
        }

        const idle = values[3] + (values[4] || 0);
        const total = values.reduce((sum, value) => sum + value, 0);
        return { idle, total };
    }
    catch
    {
        return null;
    }
}

function sampleCpuBusyCpus(cpus)
{
    const before = readCpuTimes();
    if (!before)
    {
        return null;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);

    const after = readCpuTimes();
    if (!after)
    {
        return null;
    }

    const totalDelta = after.total - before.total;
    const idleDelta = after.idle - before.idle;
    if (totalDelta <= 0 || idleDelta < 0)
    {
        return null;
    }

    const busyRatio = Math.max(0, Math.min(1, 1 - (idleDelta / totalDelta)));
    return busyRatio * cpus;
}

export function resolvePlaywrightWorkerCount({
    profile: requestedProfile = 'default',
    env = process.env,
    cpuCount = os.availableParallelism?.() ?? os.cpus().length,
    availableMemoryBytes = readMemAvailableBytes(),
    totalMemoryBytes = os.totalmem(),
    load1 = os.loadavg()[0] || 0,
    busyCpus
} = {})
{
    const cpus = Math.max(1, Math.floor(Number(cpuCount) || 1));
    const memAvailableGiB = Math.max(0, Number(availableMemoryBytes) || 0) / 1024 ** 3;
    const totalMemoryGiB = Math.max(0, Number(totalMemoryBytes) || 0) / 1024 ** 3;
    const schedulerCpuGrant = resolvePositiveGrant(env, [
        'FSUSBLOG_STEP_CPU_BUDGET',
        'FSUSBLOG_BUNDLE_CPU_UNITS',
        'FSUSBLOG_BUNDLE_CPU_BUDGET'
    ]);
    const schedulerMemoryGrantGiB = resolvePositiveGrant(env, [
        'FSUSBLOG_STEP_MEMORY_GIB',
        'FSUSBLOG_BUNDLE_MEMORY_GIB'
    ]);
    const grantedCpus = Math.max(1, Math.min(cpus, schedulerCpuGrant ?? cpus));
    const grantedMemoryGiB = Math.max(0, Math.min(
        memAvailableGiB,
        schedulerMemoryGrantGiB ?? memAvailableGiB));
    const normalizedTotalMemoryGiB = totalMemoryGiB > 0 ? totalMemoryGiB : memAvailableGiB;
    const machineMemoryPerCpuGiB = Math.max(Number.EPSILON, normalizedTotalMemoryGiB / cpus);
    const cpuCap = Math.max(1, Math.floor(grantedCpus));
    const schedulerManaged = schedulerCpuGrant !== undefined && schedulerMemoryGrantGiB !== undefined;
    // Browser contexts need their proportional share of real host memory even
    // after outer admission. Bound the live STEP memory grant by the host's
    // current memory density instead of assuming one granted CPU equals one safe
    // browser worker.
    const memCap = Math.max(1, Math.ceil(grantedMemoryGiB / machineMemoryPerCpuGiB));
    const measuredBusyCpus = !schedulerManaged
        ? (Number.isFinite(busyCpus) ? busyCpus : sampleCpuBusyCpus(cpus))
        : null;
    const pressureCpus = Number.isFinite(measuredBusyCpus) ? measuredBusyCpus : Number(load1) || 0;
    const pressureCap = !schedulerManaged
        ? Math.max(1, Math.floor(cpus - Math.max(0, pressureCpus)))
        : cpuCap;

    return {
        profile: requestedProfile,
        workers: Math.max(1, Math.min(cpuCap, memCap, pressureCap)),
        cpus,
        grantedCpus,
        grantedMemoryGiB,
        memAvailableGiB,
        load1: Number(load1) || 0,
        measuredBusyCpus,
        schedulerManaged
    };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === pathToAbsolute(process.argv[1]))
{
    const resolved = resolvePlaywrightWorkerCount({ profile });
    console.error(
        `[playwright-workers] profile=${profile} hostCpus=${resolved.cpus} grantedCpus=${resolved.grantedCpus.toFixed(2)} grantedMemoryGiB=${resolved.grantedMemoryGiB.toFixed(2)} memAvailableGiB=${resolved.memAvailableGiB.toFixed(1)} load1=${resolved.load1.toFixed(2)} cpuBusyCpus=${Number.isFinite(resolved.measuredBusyCpus) ? resolved.measuredBusyCpus.toFixed(2) : 'scheduler-managed'} workers=${resolved.workers}`
    );
    process.stdout.write(`${resolved.workers}\n`);
}

function resolvePositiveGrant(env, names)
{
    for (const name of names)
    {
        const value = env[name];
        if (value === undefined || value === null || String(value).trim() === '')
        {
            continue;
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0)
        {
            throw new Error(`${name} must be a positive finite number, got ${value}`);
        }
        return parsed;
    }
    return undefined;
}

function pathToAbsolute(value)
{
    return fs.realpathSync(value);
}
